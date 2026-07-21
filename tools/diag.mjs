#!/usr/bin/env node
/* ============================================================================
 * diag.mjs — diagnóstico de MeshCheck Live: ¿por qué no veo enlaces medidos?
 *
 * Lee la RTDB pública + frontend/nodes.json y dicta un veredicto:
 *   - ¿corre el bridge NUEVO? (meta/stats existe y es fresco)
 *   - ¿qué tráfico MQTT llega? (types) ¿trae hops_away/sender? (fields)
 *   - ¿cuántos enlaces hay y cuántos son DIBUJABLES (ambos extremos con
 *     posición conocida)?
 *   - ¿calzan los IDs del snapshot con los IDs vivos del MQTT?
 *
 * USO:  node tools/diag.mjs [RTDB_URL]
 * ========================================================================== */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RTDB = (process.argv[2] || "https://meshcheckci-default-rtdb.firebaseio.com").replace(/\/+$/, "");

const get = async (p) => {
  const r = await fetch(`${RTDB}/${p}.json`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return r.json();
};
const age = (t) => !t ? "?" : Math.round((Date.now() - t) / 60000) + " min";
const problems = [], oks = [];

console.log(`MeshCheck · diagnóstico\nRTDB: ${RTDB}\n`);

/* 1. bridge nuevo + tráfico -------------------------------------------------- */
let stats = null;
try { stats = await get("meta/stats"); } catch (e) { console.log("meta/stats error:", e.message); }
if (!stats) {
  problems.push("meta/stats NO existe → el VPS corre el bridge VIEJO (o está caído). " +
    "Solución: scp bridge/bridge.js al VPS y `pm2 restart mesh-bridge`.");
} else {
  const fresh = stats.t && Date.now() - stats.t < 2 * 60 * 1000;
  console.log(`bridge: última señal hace ${age(stats.t)} ${fresh ? "(VIVO ✓)" : "(¿DETENIDO?)"}`);
  if (!fresh) problems.push("El bridge no reporta hace más de 2 min → revisar `pm2 logs mesh-bridge` en el VPS.");
  else oks.push("Bridge nuevo corriendo y reportando.");
  const types = stats.types || {};
  console.log(`tráfico MQTT: ${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ") || "(nada)"}`);
  if (!Object.keys(types).length) problems.push("El bridge no ha visto NINGÚN mensaje → topic msh/CL/2/json/# vacío (¿cifrado? ver PASO 0 del brief).");
  if (!types.neighborinfo) console.log("  (neighborinfo: 0 — esperable, va apagado por default en la malla)");
  const f = stats.fields || {};
  console.log(`sobres: sender:${f.sender ?? "?"}  hops_away:${f.hops_away ?? "?"}  hop_start:${f.hop_start ?? "?"}  directos:${f.direct ?? "?"}  → gw-links acumulados: ${stats.gwLinks ?? "?"}`);
  if (f.sender > 0 && !f.hops_away && !f.hop_start) {
    problems.push("Los sobres MQTT NO traen hops_away ni hop_start → no se puede certificar recepción " +
      "directa y no se derivan enlaces gw. Pega a Claude las líneas 'muestra N:' de `pm2 logs mesh-bridge`.");
  } else if (f.direct === 0 && f.sender > 0) {
    problems.push("Hay sobres con sender pero NINGUNO directo (hops_away=0) → los gateways solo suben tráfico retransmitido. Raro; pega las 'muestra N:' del log.");
  } else if (stats.gwLinks > 0) oks.push(`Se han derivado ${stats.gwLinks} enlaces vía gateway.`);
}

/* 2. nodos y links en RTDB --------------------------------------------------- */
const nodes = (await get("nodes").catch(() => null)) || {};
const links = (await get("links").catch(() => null)) || {};
const nodeIds = new Set(Object.keys(nodes));
const withPos = new Set(Object.keys(nodes).filter((k) => typeof nodes[k]?.lat === "number"));
console.log(`\nRTDB /nodes: ${nodeIds.size} (con posición: ${withPos.size})`);

let snapIds = new Set(), snapCount = 0;
try {
  const snap = JSON.parse(readFileSync(resolve(ROOT, "frontend/nodes.json"), "utf8"));
  snapIds = new Set(Object.keys(snap.nodes || {}));
  snapCount = snapIds.size;
} catch { /* sin snapshot local */ }
console.log(`snapshot nodes.json: ${snapCount}`);

const allPos = new Set([...withPos]);
for (const id of snapIds) allPos.add(id);

let linkOwners = 0, edges = 0, drawable = 0, legacy = 0;
const owners = [];
for (const lid in links) {
  const l = links[lid]; if (!l) continue;
  linkOwners++;
  const from = String(l.from ?? lid);
  let nbs = [];
  if (l.nb) nbs = Object.keys(l.nb);
  if (Array.isArray(l.neighbors)) { legacy++; nbs.push(...l.neighbors.map((n) => String(n.id))); }
  edges += nbs.length;
  const draw = nbs.filter((id) => allPos.has(String(id)) && allPos.has(from)).length;
  drawable += draw;
  owners.push({ from, name: nodes[from]?.name || from, total: nbs.length, draw });
}
console.log(`RTDB /links: ${linkOwners} nodos reportan · ${edges} enlaces · dibujables (ambos extremos con posición): ${drawable}${legacy ? ` · ${legacy} en esquema viejo` : ""}`);
owners.sort((a, b) => b.total - a.total).slice(0, 6)
  .forEach((o) => console.log(`   ${o.name}: ve ${o.total} (${o.draw} dibujables)`));

if (linkOwners === 0) problems.push("/links está VACÍO → nada que dibujar. Causa más probable: bridge viejo o sin enlaces derivables (ver arriba).");
else if (drawable === 0) problems.push("Hay enlaces pero NINGUNO dibujable: los extremos no tienen posición conocida. Se arregla solo con tiempo (cuando los gateways publiquen posición) o resincronizando snapshot.");
else oks.push(`${drawable} enlaces dibujables → deberían verse líneas de color en modo "Malla en vivo".`);

/* 3. calce de IDs snapshot ↔ vivo -------------------------------------------- */
if (snapCount && nodeIds.size) {
  const overlap = [...nodeIds].filter((id) => snapIds.has(id)).length;
  console.log(`\ncalce de IDs snapshot∩vivo: ${overlap}/${nodeIds.size}`);
  const sample = [...snapIds].slice(0, 3);
  if (overlap === 0) {
    problems.push(`Los IDs del snapshot NO calzan con los del MQTT (muestra snapshot: ${sample.join(", ")}). ` +
      "Los nodos saldrán duplicados y los enlaces de gateways solo se dibujarán con posiciones vivas. " +
      "Pega esta salida a Claude para ajustar el mapeo de IDs del extractor.");
  } else oks.push(`IDs calzan (${overlap} coincidencias) → snapshot y vivo se fusionan bien.`);
}

/* 4. veredicto ---------------------------------------------------------------- */
console.log("\n================ VEREDICTO ================");
if (!problems.length) console.log("✓ Todo en orden. Si no ves líneas: activa 'Malla en vivo' y sube el TTL.");
oks.forEach((s) => console.log(`  ✓ ${s}`));
problems.forEach((s) => console.log(`  ✗ ${s}`));
