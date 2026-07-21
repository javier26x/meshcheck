/* ============================================================================
 * mesh-bridge — cosecha posiciones/adyacencia del MQTT de MeshChile y lo empuja
 * a Firebase RTDB por REST (PATCH). Componente persistente (VPS + PM2).
 *
 * Requiere Node 18+ (usa fetch nativo). Variables de entorno:
 *   RTDB_URL   https://TU-PROYECTO-default-rtdb.firebaseio.com
 *   FB_SECRET  Firebase database secret (auth admin, salta las reglas)
 *
 * Qué escribe en RTDB:
 *   /nodes/<id>            {id, name, lat, lon, role?, t}
 *   /links/<id>            {from, t, nb: { <vecinoId>: {snr, t, src} }}
 *       src = "ni"  → NeighborInfo real reportado por el nodo
 *       src = "gw"  → el nodo (gateway MQTT) ESCUCHÓ DIRECTO al vecino
 *                     (hops_away=0), con SNR medido en su radio
 *   /meta/stats            {types: {position: n, ...}, gwLinks, t}
 *                          diagnóstico visible desde el frontend
 *
 * La adyacencia via gateway es clave: NeighborInfo va apagado por default en
 * casi toda la malla, pero cada paquete uplink revela qué gateway escucha a
 * quién, con SNR. Eso ES "qué vecinos ve cada router" para los gateways.
 *
 * No se puede "forzar" la ubicación de un nodo: solo se registra lo que el
 * nodo transmite. Si msh/CL/2/json/# viene vacío pero msh/CL/# trae tráfico,
 * los gateways publican cifrado (ver MESHCHECK_LIVE.md PASO 0).
 * ========================================================================== */
const mqtt = require("mqtt");

const RTDB = process.env.RTDB_URL;
const SECRET = process.env.FB_SECRET;

if (!RTDB || !SECRET) {
  console.error("Falta RTDB_URL o FB_SECRET en el entorno. Revisa ecosystem.config.js.");
  process.exit(1);
}

const push = async (path, data) => {
  try {
    const r = await fetch(`${RTDB}/${path}.json?auth=${SECRET}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) console.error("push", path, r.status, await r.text().catch(() => ""));
  } catch (e) { console.error("push fail", e.message); }
};

const client = mqtt.connect("mqtt://mqtt.meshchile.cl:1883", {
  username: "mshcl2025", password: "meshtastic.cl", reconnectPeriod: 5000,
});

client.on("connect", () => {
  console.log("MQTT ok");
  client.subscribe("msh/CL/2/json/#", (err) => {
    if (err) console.error("subscribe err", err.message);
  });
});
client.on("reconnect", () => console.log("reconnecting…"));
client.on("error", (e) => console.error("mqtt err", e.message));

let buf = {};
const seenTypes = {};   // diagnóstico: tipos de mensaje vistos desde el arranque
let gwLinks = 0;        // enlaces derivados de recepción directa de gateways
// contadores de campos del sobre MQTT, para diagnosticar por qué (no) se
// derivan enlaces gw: sin hops_away/hop_start no hay certeza de recepción directa
const fieldCounts = { sender: 0, hops_away: 0, hop_start: 0, direct: 0 };
let sampled = 0;        // loguea los primeros mensajes crudos (ver campos reales)

function upsertNode(from, fields) {
  const key = `nodes/${from}`;
  buf[key] = Object.assign({ id: from }, buf[key] || {}, fields, { t: Date.now() });
}
function touchLink(from) {
  const key = `links/${from}`;
  buf[key] = Object.assign(buf[key] || {}, { from, t: Date.now() });
}

// tolerante a variantes: latitude_i/lat_i (*1e7) o latitude (float)
function extractLatLon(p) {
  if (!p) return null;
  const latI = p.latitude_i ?? p.lat_i;
  const lonI = p.longitude_i ?? p.long_i;
  if (typeof latI === "number" && typeof lonI === "number" && latI !== 0)
    return { lat: latI / 1e7, lon: lonI / 1e7 };
  if (typeof p.latitude === "number" && typeof p.longitude === "number" && p.latitude !== 0)
    return { lat: p.latitude, lon: p.longitude };
  return null;
}
function nameOf(p) {
  const pl = p.payload || {};
  return pl.longname || pl.long_name || pl.name || pl.shortname || pl.short_name || null;
}

client.on("message", (_topic, raw) => {
  try {
    const p = JSON.parse(raw.toString());
    if (sampled < 3) { sampled++; console.log(`muestra ${sampled}:`, raw.toString().slice(0, 350)); }
    const type = p.type || "?";
    seenTypes[type] = (seenTypes[type] || 0) + 1;
    if (p.sender != null) fieldCounts.sender++;
    if (p.hops_away != null) fieldCounts.hops_away++;
    if (p.hop_start != null) fieldCounts.hop_start++;
    const pl = p.payload || {};
    if (p.from == null) return;

    // 1) Posición (position, mapreport, o cualquier payload con lat/lon)
    const ll = extractLatLon(pl);
    if (ll) {
      const fields = { lat: ll.lat, lon: ll.lon };
      const nm = nameOf(p); if (nm) fields.name = nm;
      if (pl.role !== undefined) fields.role = pl.role;
      if (!fields.name && !(buf[`nodes/${p.from}`] || {}).name) fields.name = String(p.from);
      upsertNode(p.from, fields);
    }

    // 2) nodeinfo → enriquece nombre + rol
    if (type === "nodeinfo") {
      const fields = {};
      const nm = nameOf(p); if (nm) fields.name = nm;
      if (pl.role !== undefined) fields.role = pl.role;
      if (Object.keys(fields).length) upsertNode(p.from, fields);
    }

    // 3) NeighborInfo real → /links/<from>/nb/<vecino> (src "ni")
    if (type === "neighborinfo" && Array.isArray(pl.neighbors)) {
      touchLink(p.from);
      for (const n of pl.neighbors) {
        const nid = n.node_id ?? n.nodeId ?? n.id;
        if (nid == null) continue;
        buf[`links/${p.from}/nb/${nid}`] = { snr: n.snr ?? null, t: Date.now(), src: "ni" };
      }
    }

    // 4) Adyacencia observada vía gateway: sender = "!hex" del gateway que
    //    subió el paquete a MQTT. Si lo recibió DIRECTO (hops_away=0, o
    //    hop_start==hop_limit en firmwares sin hops_away), es un enlace RF
    //    real gateway↔emisor con SNR medido por el gateway.
    const direct =
      p.hops_away === 0 ||
      (p.hops_away == null && p.hop_start != null && p.hop_limit != null && p.hop_start === p.hop_limit);
    if (direct) fieldCounts.direct++;
    if (direct && typeof p.sender === "string" && p.sender.startsWith("!")) {
      const gw = parseInt(p.sender.slice(1), 16);
      if (Number.isFinite(gw) && gw !== p.from) {
        touchLink(gw);
        buf[`links/${gw}/nb/${p.from}`] = { snr: p.snr ?? null, t: Date.now(), src: "gw" };
        gwLinks++;
      }
    }
  } catch (e) { /* no-JSON o cifrado: ignorar (ver PASO 0) */ }
});

// flush por lotes cada 5s para no martillar RTDB
setInterval(async () => {
  const keys = Object.keys(buf);
  const batch = buf; buf = {};
  for (const k of keys) await push(k, batch[k]);
  // diagnóstico siempre (aunque no haya batch), visible desde el frontend
  await push("meta/stats", { types: seenTypes, gwLinks, fields: fieldCounts, t: Date.now() });
  const mix = Object.entries(seenTypes).map(([t, n]) => `${t}:${n}`).join(" ");
  console.log(`flushed ${keys.length} | gw-links ${gwLinks} | tipos → ${mix || "ninguno"}`);
}, 5000);

console.log("mesh-bridge iniciado");
