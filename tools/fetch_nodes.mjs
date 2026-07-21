#!/usr/bin/env node
/* ============================================================================
 * fetch_nodes.mjs — genera frontend/nodes.json (snapshot base de MeshCheck).
 *
 * El mapa de meshchile.cl es una SPA alimentada por **Firestore** (visto en
 * DevTools: firestore.googleapis.com/...projects%2Fmesht...). Este script:
 *   1) Lee la página del mapa y sus bundles JS.
 *   2) Extrae la config de Firebase (projectId, apiKey) y nombres de colección.
 *   3) Lee la colección por la API REST de Firestore (reglas públicas) con
 *      paginación, y normaliza a nodes.json.
 * Fallbacks: endpoints REST clásicos, JSON embebido, o --from-rtdb (snapshot
 * de NUESTRA RTDB, lo que el bridge ya acumuló — siempre funciona).
 *
 * USO:
 *   node tools/fetch_nodes.mjs                          # autodetección profunda
 *   node tools/fetch_nodes.mjs <URL_API>                # endpoint forzado
 *   node tools/fetch_nodes.mjs --from-rtdb <RTDB_URL>   # snapshot de la RTDB
 *   node tools/fetch_nodes.mjs --html pagina.html       # parsear HTML guardado
 *   node tools/fetch_nodes.mjs --out ruta.json          # cambiar salida
 *
 * Requiere Node 18+ (fetch nativo). Sin dependencias.
 * ========================================================================== */

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const ORIGIN = "https://meshchile.cl";
const MAP_PAGE = `${ORIGIN}/nodes/map`;
const FIRESTORE_BASE = process.env.FIRESTORE_BASE || "https://firestore.googleapis.com";

const CANDIDATES = [
  `${ORIGIN}/api/nodes`, `${ORIGIN}/api/v1/nodes`, `${ORIGIN}/nodes/api`,
  `${ORIGIN}/api/nodes.json`, `${ORIGIN}/nodes.json`, `${ORIGIN}/data/nodes.json`,
  `${ORIGIN}/api/nodes/positions`,
];
const COLLECTION_GUESSES = [
  "nodes", "node", "nodos", "devices", "markers", "positions", "posiciones",
  "mesh_nodes", "meshNodes", "stations", "reports", "nodeReports",
];

const args = process.argv.slice(2);
let OUT = resolve(ROOT, "frontend/nodes.json");
let forcedUrl = null, fromRtdb = null, htmlFile = null, sampleMode = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") OUT = resolve(process.cwd(), args[++i]);
  else if (args[i] === "--from-rtdb") fromRtdb = args[++i];
  else if (args[i] === "--html") htmlFile = args[++i];
  else if (args[i] === "--sample") sampleMode = true;
  else if (args[i].startsWith("http")) forcedUrl = args[i];
}

async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,text/html,*/*" } });
  return { ok: r.ok, status: r.status, ctype: r.headers.get("content-type") || "", text: await r.text() };
}
function tryParse(text) { try { return JSON.parse(text); } catch { return null; } }

/* --- Normalización (formatos Meshtastic / GeoJSON / Firestore / keyed) ------ */
function coord(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!isFinite(n) || n === 0) return null;
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
const LAT_KEYS = ["latitude", "lat", "position.latitude", "position.lat", "position.latitude_i",
  "latitude_i", "location.latitude", "location.lat", "gps.latitude", "geo.latitude", "coords.latitude", "coords.lat"];
const LON_KEYS = ["longitude", "lon", "lng", "position.longitude", "position.lon", "position.lng",
  "position.longitude_i", "longitude_i", "location.longitude", "location.lng", "location.lon",
  "gps.longitude", "geo.longitude", "coords.longitude", "coords.lng", "coords.lon"];
function normNode(o) {
  if (!o || typeof o !== "object") return null;
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
    id: pick(o, ["node_id", "nodeId", "num", "id", "!id", "hex_id", "nodeNum"]),
    name: pick(o, ["long_name", "longName", "user.longName", "longname", "name"]),
    alias: pick(o, ["short_name", "shortName", "user.shortName"]),
    role: pick(o, ["role", "user.role", "type", "hw_model", "hardware_model", "hardwareModel"]),
    lat: pick(o, LAT_KEYS),
    lon: pick(o, LON_KEYS),
  });
}
function finish(x) {
  const lat = coord(x.lat), lon = coord(x.lon);
  if (lat == null || lon == null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  let id = x.id != null ? String(x.id) : `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const hex = /^!([0-9a-fA-F]{1,8})$/.exec(id);
  if (hex) id = String(parseInt(hex[1], 16));
  const name = x.name != null ? String(x.name) : (x.alias != null ? String(x.alias) : id);
  const out = { id, name, lat, lon, placeholder: false };
  if (x.alias != null && String(x.alias) !== name) out.alias = String(x.alias);
  if (x.role != null) out.role = String(x.role);
  return out;
}
function extractNodes(data) {
  const candidates = [];
  const visit = (v, depth) => {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) {
      const mapped = v.map(normNode).filter(Boolean);
      if (mapped.length >= Math.max(2, v.length * 0.3)) candidates.push(mapped);
      v.forEach((x) => visit(x, depth + 1));
    } else if (typeof v === "object") {
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
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || [];
}

/* --- Firestore --------------------------------------------------------------- */
// Decodifica el formato de valores tipados de la API REST de Firestore
function fsVal(v) {
  if (v == null || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("geoPointValue" in v) return v.geoPointValue;            // {latitude, longitude}
  if ("mapValue" in v) return fsFlat((v.mapValue || {}).fields || {});
  if ("arrayValue" in v) return ((v.arrayValue || {}).values || []).map(fsVal);
  if ("nullValue" in v) return null;
  return v;
}
function fsFlat(fields) { const o = {}; for (const k in fields) o[k] = fsVal(fields[k]); return o; }

// El nº de nodo Meshtastic suele venir como "!hexid" o 8 hex en algún campo.
// Lo buscamos para que el snapshot use el MISMO id que el MQTT (decimal).
function scanNodeId(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 2) return undefined;
  for (const k in o) {
    const v = o[k];
    if (typeof v === "string") {
      const m = /^!?([0-9a-fA-F]{8})$/.exec(v.trim());
      if (m) return String(parseInt(m[1], 16));
    } else if (v && typeof v === "object") {
      const r = scanNodeId(v, depth + 1); if (r) return r;
    }
  }
  return undefined;
}

async function fetchFirestoreCollection(cfg, col) {
  let out = [], pageToken = "", pages = 0;
  process.stdout.write(`  → firestore ${cfg.projectId}/${col} `);
  while (pages++ < 30) {
    const url = `${FIRESTORE_BASE}/v1/projects/${cfg.projectId}/databases/(default)/documents/${col}` +
      `?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}` +
      (cfg.apiKey ? `&key=${cfg.apiKey}` : "");
    let r;
    try { r = await getText(url); } catch (e) { console.log(`[err ${e.message}]`); return null; }
    if (!r.ok) { console.log(`[${r.status}]`); return null; }
    const data = tryParse(r.text);
    if (!data) { console.log("[no-json]"); return null; }
    for (const d of (data.documents || [])) {
      const o = fsFlat(d.fields || {});
      // preferir el nº de nodo Meshtastic (calza con el MQTT); si no, el auto-id
      const nid = pick(o, ["node_id", "nodeId", "num", "nodeNum"]) != null ? null : scanNodeId(o);
      if (nid && o.num == null) o.num = nid;
      if (o.id == null && d.name) o.id = d.name.split("/").pop();
      out.push(o);
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  if (!out.length) { console.log("[vacía]"); return null; }
  const nodes = out.map(normNode).filter(Boolean);
  // inventario de campos (para diagnosticar de dónde sale/no sale el nº de nodo)
  const keys = [...new Set(out.flatMap((o) => Object.keys(o)))];
  console.log(`\n    campos vistos: ${keys.join(", ")}`);
  const numeric = nodes.filter((n) => /^\d+$/.test(n.id)).length;
  console.log(`    con nº de nodo Meshtastic: ${numeric}/${nodes.length}` +
    (numeric === 0 ? "  ← NINGUNO calza con el MQTT (corre --sample y pásalo a Claude)" : ""));
  if (!nodes.length) {
    console.log(`[${out.length} docs sin lat/lon reconocible]`);
    console.log(`    muestra: ${JSON.stringify(out[0]).slice(0, 300)}`);
    return null;
  }
  console.log(`[OK ${nodes.length}/${out.length} docs]`);
  return nodes;
}
async function tryFirestore(cfg, colHints) {
  const cols = [...new Set([...(colHints || []), ...COLLECTION_GUESSES])];
  for (const col of cols) {
    const nodes = await fetchFirestoreCollection(cfg, col);
    if (nodes && nodes.length) return { url: `firestore:${cfg.projectId}/${col}`, nodes };
  }
  return null;
}

/* --- Escaneo del sitio: HTML → iframes → bundles JS -------------------------- */
function absUrl(u, base) { try { return new URL(u, base).href; } catch { return null; } }

function scanFirebase(text) {
  const cfg = {};
  const grab = (k, re) => { const m = re.exec(text); if (m) cfg[k] = m[1]; };
  grab("apiKey", /["']?apiKey["']?\s*[:=]\s*["'](AIza[\w-]{30,45})["']/);
  grab("projectId", /["']?projectId["']?\s*[:=]\s*["']([\w-]{4,40})["']/);
  grab("databaseURL", /["']?databaseURL["']?\s*[:=]\s*["'](https:\/\/[\w.-]+)["']/);
  const cols = new Set(); let m;
  // collection(db,"nodes") / collection("nodes") en bundles (minificados o no)
  const rc = /collection\([^)]{0,60}?["']([\w-]{2,32})["']\s*[),]/g;
  while ((m = rc.exec(text))) cols.add(m[1]);
  return { cfg, cols: [...cols] };
}
function scanForEndpoints(text, base) {
  const urls = new Set(), wss = new Set();
  let m;
  const abs = /https?:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_\-./?=&%]*/g;
  while ((m = abs.exec(text))) {
    const u = m[0];
    if (/(api|node|position|geojson|marker|device)/i.test(u) && !/\.(png|jpg|svg|css|woff2?|ico)/i.test(u)
      && !/googleapis\.com|gstatic\.com|openstreetmap|cartocdn/i.test(u)) urls.add(u);
  }
  const rel = /["'`](\/[a-zA-Z0-9_\-./]{1,120}?(?:api|node|position|geojson|marker)[a-zA-Z0-9_\-./]{0,80})["'`]/gi;
  while ((m = rel.exec(text))) {
    const u = absUrl(m[1], base);
    if (u && !/\.(png|jpg|svg|css|js|woff2?|ico)(\?|$)/i.test(u)) urls.add(u);
  }
  const ws = /wss?:\/\/[a-zA-Z0-9.\-:/_?=&%]+/g;
  while ((m = ws.exec(text))) wss.add(m[0]);
  return { urls: [...urls], wss: [...wss] };
}
function scanHtmlAssets(html, base) {
  const scripts = new Set(), iframes = new Set(), blobs = [];
  let m;
  const sc = /<script[^>]*src=["']([^"']+)["']/gi;
  while ((m = sc.exec(html))) { const u = absUrl(m[1], base); if (u && /\.m?js(\?|$)/i.test(u)) scripts.add(u); }
  const ifr = /<iframe[^>]*src=["']([^"']+)["']/gi;
  while ((m = ifr.exec(html))) { const u = absUrl(m[1], base); if (u) iframes.add(u); }
  const js = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = js.exec(html))) blobs.push(m[1]);
  const nx = /__NEXT_DATA__\s*=\s*({[\s\S]*?})\s*<\/script>/i.exec(html);
  if (nx) blobs.push(nx[1]);
  return { scripts: [...scripts], iframes: [...iframes], blobs };
}

async function deepScan(pageUrl, depth = 0) {
  const found = { urls: new Set(), wss: new Set(), blobs: [], fb: {}, cols: new Set() };
  const mergeFb = (r) => {
    for (const k in r.cfg) if (!found.fb[k]) found.fb[k] = r.cfg[k];
    for (const c of r.cols) found.cols.add(c);
  };
  let page;
  try { page = await getText(pageUrl); } catch (e) { console.log(`  (no se pudo leer ${pageUrl}: ${e.message})`); return found; }
  if (!page.ok) { console.log(`  (${pageUrl} → HTTP ${page.status})`); return found; }

  const { scripts, iframes, blobs } = scanHtmlAssets(page.text, pageUrl);
  found.blobs.push(...blobs);
  const direct = scanForEndpoints(page.text, pageUrl);
  direct.urls.forEach((u) => found.urls.add(u));
  direct.wss.forEach((w) => found.wss.add(w));
  mergeFb(scanFirebase(page.text));

  console.log(`  ${pageUrl}\n    scripts: ${scripts.length} · iframes: ${iframes.length} · json embebido: ${blobs.length}`);

  for (const s of scripts.slice(0, 15)) {
    try {
      const js = await getText(s);
      if (!js.ok) continue;
      const fb = scanFirebase(js.text);
      mergeFb(fb);
      const r = scanForEndpoints(js.text, s);
      r.urls.forEach((u) => found.urls.add(u));
      r.wss.forEach((w) => found.wss.add(w));
      const bits = [];
      if (fb.cfg.projectId) bits.push(`projectId=${fb.cfg.projectId}`);
      if (fb.cfg.apiKey) bits.push("apiKey✓");
      if (fb.cols.length) bits.push(`colecciones: ${fb.cols.join(",")}`);
      if (r.urls.length) bits.push(`${r.urls.length} urls`);
      if (bits.length) console.log(`    bundle ${s.split("/").pop().split("?")[0]}: ${bits.join(" · ")}`);
    } catch { /* seguir */ }
  }
  if (depth === 0) {
    for (const f of iframes.slice(0, 3)) {
      console.log(`  ↳ iframe: ${f}`);
      const sub = await deepScan(f, 1);
      sub.urls.forEach((u) => found.urls.add(u));
      sub.wss.forEach((w) => found.wss.add(w));
      found.blobs.push(...sub.blobs);
      mergeFb({ cfg: sub.fb, cols: [...sub.cols] });
    }
  }
  return found;
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

/* --- Snapshot desde nuestra RTDB --------------------------------------------- */
async function fromRtdbSnapshot(rtdbUrl) {
  const url = rtdbUrl.replace(/\/+$/, "") + "/nodes.json";
  console.log(`Snapshot desde la RTDB: ${url}`);
  const { ok, status, text } = await getText(url);
  if (!ok) { console.error(`✗ RTDB respondió ${status}`); process.exit(1); }
  const data = tryParse(text);
  if (!data) { console.error("✗ RTDB no devolvió JSON"); process.exit(1); }
  const nodes = [];
  for (const id in data) {
    const n = data[id];
    if (!n || typeof n.lat !== "number") continue;
    nodes.push({
      id: String(id), name: n.name || String(id), lat: n.lat, lon: n.lon,
      role: n.role != null ? String(n.role) : undefined,
      lastSeen: n.t || undefined, placeholder: false,
    });
  }
  if (!nodes.length) { console.error("✗ La RTDB no tiene nodos aún (deja el bridge corriendo un rato)"); process.exit(1); }
  save(nodes, url);
}

/* --- main --------------------------------------------------------------------- */
async function main() {
  console.log("MeshCheck · extracción de nodos\n");

  if (fromRtdb) return fromRtdbSnapshot(fromRtdb);

  const order = [];
  let wssHints = [], fb = {}, fbCols = [];

  if (forcedUrl) order.push(forcedUrl);
  else if (htmlFile) {
    console.log(`Parseando HTML local: ${htmlFile}`);
    const html = readFileSync(htmlFile, "utf8");
    const { blobs } = scanHtmlAssets(html, ORIGIN);
    for (const b of blobs) {
      const data = tryParse(b.trim());
      const nodes = data ? extractNodes(data) : [];
      if (nodes.length) { console.log(`  JSON embebido: ${nodes.length} nodos`); return save(nodes, htmlFile); }
    }
    const r = scanForEndpoints(html, ORIGIN);
    order.push(...r.urls); wssHints = r.wss;
    const f = scanFirebase(html); fb = f.cfg; fbCols = f.cols;
  } else {
    console.log("Escaneo profundo (HTML → iframes → bundles JS):");
    const found = await deepScan(MAP_PAGE);
    for (const b of found.blobs) {
      const data = tryParse(b.trim());
      const nodes = data ? extractNodes(data) : [];
      if (nodes.length) { console.log(`  JSON embebido en la página: ${nodes.length} nodos`); return save(nodes, MAP_PAGE); }
    }
    order.push(...found.urls);
    wssHints = [...found.wss];
    fb = found.fb; fbCols = [...found.cols];
  }

  // Firestore primero: es como se alimenta el mapa real (visto en DevTools)
  if (fb.projectId) {
    console.log(`\nConfig Firebase del sitio: projectId=${fb.projectId} · apiKey ${fb.apiKey ? "encontrada" : "NO encontrada"}` +
      (fbCols.length ? ` · colecciones vistas: ${fbCols.join(", ")}` : ""));
    if (sampleMode) {
      // imprime docs CRUDOS para descubrir el campo con el id real del nodo
      for (const col of [...new Set([...fbCols, ...COLLECTION_GUESSES])]) {
        const url = `${FIRESTORE_BASE}/v1/projects/${fb.projectId}/databases/(default)/documents/${col}?pageSize=3` +
          (fb.apiKey ? `&key=${fb.apiKey}` : "");
        const r = await getText(url).catch(() => null);
        const data = r && r.ok ? tryParse(r.text) : null;
        if (!data || !Array.isArray(data.documents) || !data.documents.length) continue;
        console.log(`\n=== MUESTRA CRUDA de "${col}" (pega esto a Claude) ===`);
        for (const d of data.documents) {
          console.log(`doc ${d.name.split("/").pop()}:`);
          console.log(JSON.stringify(fsFlat(d.fields || {}), null, 1).slice(0, 1200));
        }
        return;
      }
      console.error("✗ --sample: ninguna colección legible");
      process.exit(1);
    }
    console.log("Probando Firestore:");
    const hit = await tryFirestore(fb, fbCols);
    if (hit) return save(hit.nodes, hit.url);
    if (fb.databaseURL) {
      console.log("Probando RTDB del sitio:");
      for (const p of ["nodes", "nodos", "devices"]) {
        const hit2 = await tryEndpoint(`${fb.databaseURL}/${p}.json`);
        if (hit2) return save(hit2.nodes, hit2.url);
      }
    }
  }

  order.push(...CANDIDATES);
  console.log("\nProbando endpoints:");
  const seen = new Set();
  for (const url of order) {
    if (seen.has(url)) continue; seen.add(url);
    if (seen.size > 40) break;
    const hit = await tryEndpoint(url);
    if (hit) return save(hit.nodes, hit.url);
  }

  console.error("\n✗ No se pudo extraer el listado.");
  if (fb.projectId) console.error(`  (Firestore ${fb.projectId} detectado pero ninguna colección legible — pega la salida a Claude)`);
  if (wssHints.length) {
    console.error("  Pistas de tiempo real (WS/MQTT):");
    for (const w of wssHints) console.error(`   ${w}`);
  }
  console.error("\nPlan B: snapshot de lo que el bridge ya acumuló en la RTDB:");
  console.error("  node tools/fetch_nodes.mjs --from-rtdb https://meshcheckci-default-rtdb.firebaseio.com");
  process.exit(1);
}

function save(nodes, source) {
  const byId = {};
  for (const n of nodes) byId[n.id] = JSON.parse(JSON.stringify(n)); // limpia undefined
  const out = {
    _note: "Generado por tools/fetch_nodes.mjs. Snapshot base de MeshCheck Live.",
    generated: new Date().toISOString(),
    source,
    count: Object.keys(byId).length,
    nodes: byId,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n✓ ${out.count} nodos → ${OUT}`);
  console.log("  Redespliega el frontend:  firebase deploy --only hosting --project meshcheckci");
}

main().catch((e) => { console.error(e); process.exit(1); });
