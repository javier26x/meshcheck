/* ============================================================================
 * rfcapture — graba una "foto" de la malla durante una ventana de tiempo.
 *
 * Pensado para los apagones programados de MQTT: cuando el puente por internet
 * se cae, lo único que queda propagando es la RADIO. Todo lo que se observe en
 * esa ventana es alcance RF real, sin ayuda de internet.
 *
 * NO toca el bridge en marcha: solo LEE la RTDB cada MC_EVERY segundos y
 * acumula la unión de lo visto en /rf/<sesión>. Correrlo es inofensivo.
 *
 * Uso (en el VPS, dentro de /root/mesh-bridge):
 *   node rfcapture.js                      # graba 2 h con etiqueta automática
 *   node rfcapture.js --min 90 --label "apagón MQTT 22-jul"
 *   node rfcapture.js --root mc            # capturar MeshCore en vez de Meshtastic
 *
 * Lee RTDB_URL y FB_SECRET del ecosystem.config.js que ya tienes configurado.
 * ========================================================================== */
const path = require("path");

/* --- argumentos ------------------------------------------------------------ */
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const MINUTES = +arg("min", 120);
const EVERY_MS = Math.max(5, +arg("every", 20)) * 1000;
const ROOT = arg("root", "");                       // "" = Meshtastic, "mc" = MeshCore
const LABEL = arg("label", "captura RF");
// se considera "visto ahora" lo que tenga t dentro de esta ventana (el bridge
// refresca los enlaces sin cambios cada 10 min, así que 15 da margen)
const FRESH_MS = Math.max(1, +arg("fresh", 15)) * 60 * 1000;

/* --- credenciales del ecosystem ------------------------------------------- */
let RTDB = process.env.RTDB_URL, SECRET = process.env.FB_SECRET;
if (!RTDB || !SECRET) {
  try {
    const cfg = require(path.resolve(__dirname, "ecosystem.config.js"));
    const app = cfg.apps.find((a) => a.env && a.env.RTDB_URL) || cfg.apps[0];
    RTDB = RTDB || app.env.RTDB_URL; SECRET = SECRET || app.env.FB_SECRET;
  } catch (e) { /* sin ecosystem: hay que pasar las env */ }
}
if (!RTDB || !SECRET) { console.error("Falta RTDB_URL / FB_SECRET (ni en env ni en ecosystem.config.js)."); process.exit(1); }

const base = ROOT ? `${RTDB}/${ROOT}` : RTDB;
const get = (p) => fetch(`${base}/${p}.json?auth=${SECRET}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const patch = (p, body) => fetch(`${RTDB}/${p}.json?auth=${SECRET}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  .then((r) => (r.ok ? true : (console.error("patch", r.status), false))).catch((e) => (console.error("patch fail", e.message), false));

const safe = (s) => String(s).replace(/[.#$\[\]]/g, "_").replace(/\//g, "|").slice(0, 100) || "_";
const pad = (n) => String(n).padStart(2, "0");
const start = Date.now();
const d = new Date(start);
const sid = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${ROOT ? "-" + ROOT : ""}`;
const endAt = start + MINUTES * 60 * 1000;

// unión acumulada de todo lo visto en la ventana
const links = new Map();     // "a|b" → { a, b, snr, src, n, first, last, seen }
const nodes = new Map();     // id     → { id, name, lat, lon, first, last, seen }
const timeline = [];
let polls = 0;

const R = 6371;
const hav = (a, b) => {
  if (!a || !b || typeof a.lat !== "number" || typeof b.lat !== "number") return null;
  const t = Math.PI / 180, dLat = (b.lat - a.lat) * t, dLon = (b.lon - a.lon) * t;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};

// linkNeighbors: misma forma que lee el visor (neighbors[] de NeighborInfo y nb{})
function neighborsOf(l) {
  const out = [];
  if (!l) return out;
  if (Array.isArray(l.neighbors)) for (const nb of l.neighbors) out.push({ id: String(nb.id), snr: nb.snr ?? null, t: l.t, src: "ni" });
  if (l.nb) for (const k in l.nb) { const v = l.nb[k] || {}; out.push({ id: String(k), snr: v.snr ?? null, t: v.t || l.t, src: v.src || "gw", n: v.n }); }
  return out;
}

async function poll() {
  const now = Date.now();
  const [rawNodes, rawLinks] = await Promise.all([get("nodes"), get("links")]);
  if (!rawNodes && !rawLinks) { console.error(`[${new Date().toLocaleTimeString()}] sin respuesta de la RTDB`); return; }
  polls++;

  let freshNodes = 0;
  for (const id in rawNodes || {}) {
    const n = rawNodes[id]; if (!n) continue;
    const seen = typeof n.seen === "number" ? n.seen : n.t;
    if (!seen || now - seen > FRESH_MS) continue;
    freshNodes++;
    const prev = nodes.get(id);
    nodes.set(id, {
      id, name: n.name || id,
      lat: typeof n.lat === "number" ? n.lat : (prev && prev.lat),
      lon: typeof n.lon === "number" ? n.lon : (prev && prev.lon),
      role: n.role != null ? n.role : (prev && prev.role),
      first: prev ? prev.first : now, last: now, seen,
    });
  }

  let freshLinks = 0, withSnr = 0;
  for (const from in rawLinks || {}) {
    for (const nb of neighborsOf(rawLinks[from])) {
      if (!nb.t || now - nb.t > FRESH_MS) continue;
      freshLinks++;
      if (nb.snr != null) withSnr++;
      const a = safe(from), b = safe(nb.id);
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const prev = links.get(key);
      const snrMax = nb.snr != null ? (prev && prev.snr != null ? Math.max(prev.snr, nb.snr) : nb.snr) : (prev ? prev.snr : null);
      links.set(key, { a: from, b: nb.id, snr: snrMax, src: nb.src, n: nb.n != null ? nb.n : (prev && prev.n), first: prev ? prev.first : now, last: now });
    }
  }
  timeline.push({ t: now, nodes: freshNodes, links: freshLinks, snr: withSnr });
  const mins = Math.round((now - start) / 60000);
  console.log(`[${new Date().toLocaleTimeString()}] +${mins}min · vivos ${freshNodes} nodos / ${freshLinks} enlaces (${withSnr} con SNR) · acumulado ${nodes.size} nodos, ${links.size} enlaces`);
  await flush(now, false);
}

async function flush(now, done) {
  // distancias: el dato que responde "hasta dónde llega el RF"
  let maxKm = 0, maxPair = null;
  const kms = [];
  for (const [, l] of links) {
    const km = hav(nodes.get(String(l.a)), nodes.get(String(l.b)));
    if (km == null) continue;
    l.km = Math.round(km * 100) / 100;
    kms.push(km);
    if (km > maxKm) { maxKm = km; maxPair = l; }
  }
  kms.sort((x, y) => x - y);
  const body = {};
  body[`rf/${sid}/meta`] = {
    label: LABEL, root: ROOT || "mt", start, end: done ? now : null, updated: now,
    minutes: MINUTES, freshMin: FRESH_MS / 60000, polls,
    nodes: nodes.size, links: links.size,
    snrLinks: [...links.values()].filter((l) => l.snr != null).length,
    maxKm: Math.round(maxKm * 100) / 100,
    maxPair: maxPair ? { a: maxPair.a, b: maxPair.b, an: (nodes.get(String(maxPair.a)) || {}).name, bn: (nodes.get(String(maxPair.b)) || {}).name, snr: maxPair.snr } : null,
    medKm: kms.length ? Math.round(kms[Math.floor(kms.length / 2)] * 100) / 100 : null,
  };
  for (const [k, l] of links) body[`rf/${sid}/links/${k}`] = l;
  for (const [id, n] of nodes) body[`rf/${sid}/nodes/${safe(id)}`] = n;
  body[`rf/${sid}/tl`] = timeline.slice(-400);
  await patch("", body);
}

(async function main() {
  console.log(`rfcapture · sesión ${sid} · "${LABEL}"`);
  console.log(`  fuente: ${base}  ·  ventana: ${MINUTES} min  ·  muestreo cada ${EVERY_MS / 1000}s  ·  frescura ${FRESH_MS / 60000} min`);
  console.log(`  destino: ${RTDB}/rf/${sid}`);
  console.log(`  (Ctrl+C corta y cierra la sesión con lo acumulado)\n`);
  await poll();
  const iv = setInterval(async () => {
    if (Date.now() >= endAt) { clearInterval(iv); await finish("ventana cumplida"); return; }
    try { await poll(); } catch (e) { console.error("poll fail", e.message); }
  }, EVERY_MS);
  const finish = async (why) => {
    console.log(`\ncerrando (${why})…`);
    await flush(Date.now(), true);
    console.log(`LISTO · ${nodes.size} nodos y ${links.size} enlaces en /rf/${sid}`);
    process.exit(0);
  };
  process.on("SIGINT", () => { finish("Ctrl+C").catch(() => process.exit(1)); });
})();
