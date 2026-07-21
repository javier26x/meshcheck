/* ============================================================================
 * mesh-bridge — cosecha posiciones/adyacencia del MQTT de MeshChile y lo empuja
 * a Firebase RTDB por REST (PATCH). Componente persistente (VPS + PM2).
 *
 * Requiere Node 18+ (usa fetch nativo). Variables de entorno:
 *   RTDB_URL   https://TU-PROYECTO-default-rtdb.firebaseio.com
 *   FB_SECRET  Firebase database secret (auth admin, salta las reglas)
 *
 * Fuentes de posición capturadas del topic JSON (msh/CL/2/json/#):
 *   - position            (paquete de posición estándar)
 *   - mapreport           (Map Report: posición + nombre + rol, si el gateway lo emite)
 *   - cualquier payload con latitude_i/lat_i/latitude (tolerante a variantes)
 *   - nodeinfo            (enriquece nombre + rol)
 *   - neighborinfo        (adyacencia real medida con SNR)  → /links
 *
 * OJO: no se puede "forzar" la ubicación de un nodo; solo se registra lo que el
 * nodo transmite. Los móviles con position-sharing apagado no aparecen.
 * Si msh/CL/2/json/# viene vacío pero msh/CL/# trae tráfico, los gateways
 * publican cifrado (ver MESHCHECK_LIVE.md PASO 0).
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
  username: "mshcl2025",
  password: "meshtastic.cl",
  reconnectPeriod: 5000,
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
const seenTypes = {};          // diagnóstico: qué tipos de mensaje llegan

// merge sobre el nodo en el buffer (position/mapreport/nodeinfo se enriquecen)
function upsertNode(from, fields) {
  const key = `nodes/${from}`;
  buf[key] = Object.assign({ id: from }, buf[key] || {}, fields, { t: Date.now() });
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
    const type = p.type || "?";
    seenTypes[type] = (seenTypes[type] || 0) + 1;
    const pl = p.payload || {};
    if (p.from == null) return;

    // 1) Posición (position, mapreport, o cualquier payload con lat/lon)
    const ll = extractLatLon(pl);
    if (ll && (type === "position" || type === "mapreport" || pl.latitude_i || pl.lat_i)) {
      const fields = { lat: ll.lat, lon: ll.lon };
      const nm = nameOf(p); if (nm) fields.name = nm;
      if (pl.role !== undefined) fields.role = pl.role;   // rol si viene (mapreport/nodeinfo)
      if (!fields.name) fields.name = String(p.from);
      upsertNode(p.from, fields);
    }

    // 2) nodeinfo → enriquece nombre + rol (sin posición; el frontend ignora sin lat)
    if (type === "nodeinfo") {
      const fields = {};
      const nm = nameOf(p); if (nm) fields.name = nm;
      if (pl.role !== undefined) fields.role = pl.role;
      if (Object.keys(fields).length) upsertNode(p.from, fields);
    }

    // 3) NeighborInfo → /links (adyacencia real medida con SNR)
    if (type === "neighborinfo" && Array.isArray(pl.neighbors)) {
      buf[`links/${p.from}`] = {
        from: p.from,
        neighbors: pl.neighbors.map((n) => ({ id: n.node_id ?? n.nodeId ?? n.id, snr: n.snr })),
        t: Date.now(),
      };
    }
  } catch (e) { /* no-JSON o cifrado: ignorar (ver PASO 0) */ }
});

// flush por lotes cada 5s para no martillar RTDB
setInterval(async () => {
  const keys = Object.keys(buf);
  if (!keys.length) return;
  const batch = buf; buf = {};
  for (const k of keys) await push(k, batch[k]);
  const mix = Object.entries(seenTypes).map(([t, n]) => `${t}:${n}`).join(" ");
  console.log(`flushed ${keys.length} | tipos vistos → ${mix || "ninguno"}`);
}, 5000);

console.log("mesh-bridge iniciado");
