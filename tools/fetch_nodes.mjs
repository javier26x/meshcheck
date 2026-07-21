#!/usr/bin/env node
/* ============================================================================
 * fetch_nodes.mjs — extrae el listado de nodos del mapa de MeshChile y genera
 *   frontend/nodes.json  (fallback embebido de MeshCheck Live).
 *
 * POR QUÉ ES UN SCRIPT Y NO SE HIZO EN CI:
 *   El entorno donde se generó este repo tiene bloqueado meshchile.cl por
 *   política de egress, así que la extracción no se pudo correr ahí. Corre este
 *   script desde tu máquina/VPS (donde meshchile.cl sí es alcanzable).
 *
 * USO:
 *   node tools/fetch_nodes.mjs                 # autodetecta el endpoint
 *   node tools/fetch_nodes.mjs <URL_API>       # fuerza un endpoint JSON
 *   node tools/fetch_nodes.mjs --out ruta.json # cambia el archivo de salida
 *
 * Requiere Node 18+ (fetch nativo). Sin dependencias.
 * ========================================================================== */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const ORIGIN = "https://meshchile.cl";
const MAP_PAGE = `${ORIGIN}/nodes/map`;

// Endpoints candidatos (además del que se pase por CLI o se detecte en el HTML)
const CANDIDATES = [
  `${ORIGIN}/api/nodes`,
  `${ORIGIN}/api/v1/nodes`,
  `${ORIGIN}/nodes/api`,
  `${ORIGIN}/api/nodes.json`,
  `${ORIGIN}/nodes.json`,
  `${ORIGIN}/data/nodes.json`,
  `${ORIGIN}/api/nodes/positions`,
];

const args = process.argv.slice(2);
let OUT = resolve(ROOT, "frontend/nodes.json");
let forcedUrl = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") OUT = resolve(process.cwd(), args[++i]);
  else if (args[i].startsWith("http")) forcedUrl = args[i];
}

async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,text/html,*/*" } });
  return { ok: r.ok, status: r.status, ctype: r.headers.get("content-type") || "", text: await r.text() };
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/* --- Normalización: acepta muchas formas de JSON de mapas Meshtastic -------- */
function coord(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!isFinite(n) || n === 0) return null;
  // latitude_i / longitude_i vienen escalados *1e7
  return Math.abs(n) > 1000 ? n / 1e7 : n;
}
function pick(o, keys) {
  for (const k of keys) {
    if (o == null) return undefined;
    const v = k.split(".").reduce((a, kk) => (a == null ? a : a[kk]), o);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}
function normNode(o) {
  if (!o || typeof o !== "object") return null;

  // GeoJSON Feature
  if (o.type === "Feature" && o.geometry && Array.isArray(o.geometry.coordinates)) {
    const [lon, lat] = o.geometry.coordinates;
    return finish({
      id: pick(o.properties || {}, ["id", "node_id", "num", "nodeId"]),
      name: pick(o.properties || {}, ["name", "long_name", "longName", "shortName", "short_name"]),
      role: pick(o.properties || {}, ["role", "hw_model", "hardware"]),
      lat, lon,
    });
  }

  return finish({
    id: pick(o, ["node_id", "nodeId", "num", "id", "!id", "hex_id"]),
    name: pick(o, ["long_name", "longName", "user.longName", "longname", "name", "short_name", "shortName", "user.shortName"]),
    role: pick(o, ["role", "user.role", "hw_model", "hardware_model", "hardwareModel"]),
    lat: pick(o, ["latitude", "lat", "position.latitude", "position.latitude_i", "latitude_i"]),
    lon: pick(o, ["longitude", "lon", "lng", "position.longitude", "position.longitude_i", "longitude_i"]),
  });
}
function finish(x) {
  const lat = coord(x.lat), lon = coord(x.lon);
  if (lat == null || lon == null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  let id = x.id != null ? String(x.id) : `${lat.toFixed(5)},${lon.toFixed(5)}`;
  // IDs hex tipo "!a1b2c3d4" → decimal, para calzar con el `from` del MQTT
  const hex = /^!([0-9a-fA-F]{1,8})$/.exec(id);
  if (hex) id = String(parseInt(hex[1], 16));
  const role = x.role != null ? String(x.role) : undefined;
  return { id, name: x.name != null ? String(x.name) : id, lat, lon, role, placeholder: false };
}

// Busca el array de nodos dentro de cualquier estructura JSON
function extractNodes(data) {
  const candidates = [];
  const visit = (v, depth) => {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) {
      const mapped = v.map(normNode).filter(Boolean);
      if (mapped.length >= Math.max(2, v.length * 0.3)) candidates.push(mapped);
      v.forEach((x) => visit(x, depth + 1));
    } else if (typeof v === "object") {
      // objeto keyed por id: { "123": {lat,lon}, ... }
      const vals = Object.values(v);
      if (vals.length >= 2 && vals.every((x) => x && typeof x === "object")) {
        const mapped = vals.map(normNode).filter(Boolean);
        if (mapped.length >= Math.max(2, vals.length * 0.3)) candidates.push(mapped);
      }
      for (const k of Object.keys(v)) visit(v[k], depth + 1);
    }
  };
  if (data && data.type === "FeatureCollection" && Array.isArray(data.features)) {
    const m = data.features.map(normNode).filter(Boolean);
    if (m.length) candidates.push(m);
  }
  visit(data, 0);
  // elige el conjunto más grande
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || [];
}

// Escanea el HTML del mapa por endpoints y/o JSON embebido
function scanHtml(html) {
  const urls = new Set();
  const rx = /["'`](\/[^"'`\s]*(?:nodes|positions|api)[^"'`\s]*)["'`]/gi;
  let m;
  while ((m = rx.exec(html))) {
    const p = m[1];
    if (/\.(png|jpg|svg|css|js|woff2?|ico)(\?|$)/i.test(p)) continue;
    urls.add(p.startsWith("http") ? p : ORIGIN + p);
  }
  const abs = /["'`](https?:\/\/[^"'`\s]*(?:nodes|api)[^"'`\s]*)["'`]/gi;
  while ((m = abs.exec(html))) urls.add(m[1]);

  // JSON embebido en <script type="application/json"> o __NEXT_DATA__
  const blobs = [];
  const sc = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = sc.exec(html))) blobs.push(m[1]);
  const nx = /__NEXT_DATA__\s*=\s*({[\s\S]*?})\s*<\/script>/i.exec(html);
  if (nx) blobs.push(nx[1]);
  return { urls: [...urls], blobs };
}

async function tryEndpoint(url) {
  try {
    process.stdout.write(`  → ${url} `);
    const { ok, status, text } = await getText(url);
    if (!ok) { console.log(`[${status}]`); return null; }
    const data = tryParse(text);
    if (!data) { console.log("[no-json]"); return null; }
    const nodes = extractNodes(data);
    console.log(nodes.length ? `[OK ${nodes.length} nodos]` : "[json sin nodos]");
    return nodes.length ? { url, nodes } : null;
  } catch (e) { console.log(`[err ${e.message}]`); return null; }
}

async function main() {
  console.log("MeshCheck · extracción de nodos desde MeshChile\n");

  const order = [];
  if (forcedUrl) order.push(forcedUrl);

  // 1) intentar leer la página del mapa para autodetectar la API
  if (!forcedUrl) {
    try {
      console.log(`Leyendo ${MAP_PAGE} para autodetectar la API…`);
      const { ok, status, text } = await getText(MAP_PAGE);
      if (ok) {
        const { urls, blobs } = scanHtml(text);
        // JSON embebido directamente en la página
        for (const b of blobs) {
          const data = tryParse(b.trim());
          const nodes = data ? extractNodes(data) : [];
          if (nodes.length) { console.log(`  JSON embebido en la página: ${nodes.length} nodos`); return save(nodes, MAP_PAGE); }
        }
        if (urls.length) console.log(`  Endpoints detectados: ${urls.join(", ")}`);
        order.push(...urls);
      } else {
        console.log(`  no se pudo leer la página [${status}]`);
      }
    } catch (e) { console.log(`  error leyendo la página: ${e.message}`); }
  }

  order.push(...CANDIDATES);

  console.log("\nProbando endpoints:");
  const seen = new Set();
  for (const url of order) {
    if (seen.has(url)) continue; seen.add(url);
    const hit = await tryEndpoint(url);
    if (hit) return save(hit.nodes, hit.url);
  }

  console.error("\n✗ No se encontró un endpoint de nodos utilizable.");
  console.error("  Abre https://meshchile.cl/nodes/map en el navegador, mira la pestaña");
  console.error("  Network por la petición que trae los nodos (JSON) y pásala como argumento:");
  console.error("    node tools/fetch_nodes.mjs 'https://meshchile.cl/....'");
  process.exit(1);
}

function save(nodes, source) {
  // dedup por id
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  const out = {
    _note: "Generado por tools/fetch_nodes.mjs desde el mapa de MeshChile. Fallback embebido de MeshCheck Live.",
    generated: new Date().toISOString(),
    source,
    count: Object.keys(byId).length,
    nodes: byId,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n✓ ${out.count} nodos → ${OUT}`);
  console.log("  Vuelve a desplegar el frontend:  firebase deploy --only hosting");
}

main().catch((e) => { console.error(e); process.exit(1); });
