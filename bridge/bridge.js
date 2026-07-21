/* ============================================================================
 * mesh-bridge — cosecha del MQTT de MeshChile hacia Firebase RTDB (REST PATCH).
 * Componente persistente (VPS + PM2). Requiere Node 18+.
 *
 * Env: RTDB_URL, FB_SECRET (database secret; auth admin, salta las reglas).
 *
 * Suscripción: msh/CL/#  (todo el árbol; se parsea solo lo que va por .../json/...,
 * el resto —protobuf/cifrado/map— se CUENTA por topic para diagnóstico).
 *
 * Qué escribe:
 *   /nodes/<id>   {id,name,lat,lon,alt?,role?,hw?,batt?,volt?,temp?,chUtil?,t}
 *                 t = última vez escuchado (cualquier paquete JSON del nodo)
 *   /links/<id>/nb/<vecino> = {snr,t,src}
 *                 src: "ni" NeighborInfo · "gw" recepción directa de gateway
 *                      (hops_away=0, SNR medido) · "tr" salto de traceroute
 *   /meta/stats   {types, topics, fields, gwLinks, t}  → diagnóstico en el visor
 *
 * Fuentes de datos consumidas del JSON:
 *   position     lat/lon/alt          nodeinfo   nombre/rol/hardware
 *   telemetry    batería/volt/temp/chUtil        mapreport  pos+rol si llega
 *   neighborinfo adyacencia real      traceroute cadena de saltos reales
 *   text/otros   marcan actividad (t)
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
  client.subscribe("msh/CL/#", (err) => {
    if (err) console.error("subscribe err", err.message);
  });
});
client.on("reconnect", () => console.log("reconnecting…"));
client.on("error", (e) => console.error("mqtt err", e.message));

let buf = {};
const seenTypes = {};    // tipos de mensaje JSON vistos
const topicCounts = {};  // tráfico por topic (json vs cifrado vs map…)
const fieldCounts = { sender: 0, hops_away: 0, hop_start: 0, direct: 0 };
let gwLinks = 0;
let sampled = 0;
const BCAST = 4294967295;

function upsertNode(from, fields) {
  const key = `nodes/${from}`;
  buf[key] = Object.assign({ id: from }, buf[key] || {}, fields, { t: Date.now() });
}
function touchLink(from) {
  const key = `links/${from}`;
  buf[key] = Object.assign(buf[key] || {}, { from, t: Date.now() });
}
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

client.on("message", (topic, raw) => {
  // clasificar el topic (diagnóstico: cuánto llega en json vs cifrado vs map)
  const tkey = topic.split("/").slice(0, 5).join("/");
  if (topicCounts[tkey] != null || Object.keys(topicCounts).length < 40)
    topicCounts[tkey] = (topicCounts[tkey] || 0) + 1;
  if (!topic.includes("/json/")) return;   // protobuf/cifrado: solo contar

  try {
    const p = JSON.parse(raw.toString());
    if (sampled < 3) { sampled++; console.log(`muestra ${sampled} [${topic}]:`, raw.toString().slice(0, 350)); }
    const type = p.type || "?";
    seenTypes[type] = (seenTypes[type] || 0) + 1;
    if (p.sender != null) fieldCounts.sender++;
    if (p.hops_away != null) fieldCounts.hops_away++;
    if (p.hop_start != null) fieldCounts.hop_start++;
    const pl = p.payload || {};
    if (p.from == null) return;

    // 1) Posición + altitud (position, mapreport, o payload con lat/lon)
    const ll = extractLatLon(pl);
    if (ll) {
      const f = { lat: ll.lat, lon: ll.lon };
      if (typeof pl.altitude === "number") f.alt = Math.round(pl.altitude);
      const nm = nameOf(p); if (nm) f.name = nm;
      if (pl.role !== undefined) f.role = pl.role;
      if (!f.name && !(buf[`nodes/${p.from}`] || {}).name) f.name = String(p.from);
      upsertNode(p.from, f);
    }

    // 2) nodeinfo → nombre / rol / hardware
    if (type === "nodeinfo") {
      const f = {};
      const nm = nameOf(p); if (nm) f.name = nm;
      if (pl.role !== undefined) f.role = pl.role;
      if (pl.hardware !== undefined) f.hw = pl.hardware;
      upsertNode(p.from, f);
    }

    // 3) telemetry → batería / voltaje / temperatura / uso de canal
    if (type === "telemetry") {
      const f = {};
      if (pl.battery_level != null) f.batt = Math.round(pl.battery_level);
      if (pl.voltage != null) f.volt = Math.round(pl.voltage * 100) / 100;
      if (pl.temperature != null) f.temp = Math.round(pl.temperature * 10) / 10;
      if (pl.channel_utilization != null) f.chUtil = Math.round(pl.channel_utilization * 10) / 10;
      upsertNode(p.from, f);          // aunque venga vacío, refresca t (actividad)
    }

    // 4) cualquier otro tráfico del nodo (text, etc.) → marca actividad
    if (type === "text" || type === "waypoint") upsertNode(p.from, {});

    // 5) NeighborInfo real → src "ni"
    if (type === "neighborinfo" && Array.isArray(pl.neighbors)) {
      touchLink(p.from);
      for (const n of pl.neighbors) {
        const nid = n.node_id ?? n.nodeId ?? n.id;
        if (nid == null) continue;
        buf[`links/${p.from}/nb/${nid}`] = { snr: n.snr ?? null, t: Date.now(), src: "ni" };
      }
    }

    // 6) traceroute → cada salto consecutivo de la cadena es un enlace RF real
    if (type === "traceroute" && Array.isArray(pl.route)) {
      const chain = [p.from, ...pl.route.map(Number), p.to]
        .filter((x) => Number.isFinite(x) && x !== BCAST && x > 0);
      for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i], b = chain[i + 1];
        if (a === b) continue;
        touchLink(a);
        buf[`links/${a}/nb/${b}`] = { snr: null, t: Date.now(), src: "tr" };
      }
    }

    // 7) recepción directa por gateway (sender "!hex", hops_away=0) → src "gw"
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
  } catch (e) { /* JSON malformado: ignorar */ }
});

// flush por lotes cada 5s
setInterval(async () => {
  const keys = Object.keys(buf);
  const batch = buf; buf = {};
  for (const k of keys) await push(k, batch[k]);
  await push("meta/stats", { types: seenTypes, topics: topicCounts, fields: fieldCounts, gwLinks, t: Date.now() });
  const mix = Object.entries(seenTypes).map(([t, n]) => `${t}:${n}`).join(" ");
  console.log(`flushed ${keys.length} | gw-links ${gwLinks} | tipos → ${mix || "ninguno"}`);
}, 5000);

console.log("mesh-bridge iniciado (suscrito a msh/CL/#)");
