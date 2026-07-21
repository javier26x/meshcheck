/* ============================================================================
 * mesh-bridge — cosecha position/neighborinfo del MQTT de MeshChile y lo empuja
 * a Firebase RTDB por REST (PATCH). Componente persistente (VPS + PM2).
 *
 * Requiere Node 18+ (usa fetch nativo). Variables de entorno:
 *   RTDB_URL   https://TU-PROYECTO-default-rtdb.firebaseio.com
 *   FB_SECRET  Firebase database secret (auth admin, salta las reglas)
 *
 * Ver MESHCHECK_LIVE.md (PASO 0/1). Si msh/CL/2/json/# viene vacío pero el
 * catch-all msh/CL/# trae tráfico, los gateways publican cifrado: hay que
 * descifrar con la llave del canal antes de parsear (tarea condicional).
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
    if (!r.ok) console.error("push", path, r.status);
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
client.on("message", (_topic, raw) => {
  try {
    const p = JSON.parse(raw.toString());

    // Posición → /nodes/<from>
    if (p.type === "position" && p.payload && p.payload.latitude_i) {
      buf[`nodes/${p.from}`] = {
        id: p.from,
        name: p.payload.name || nodeName(p) || String(p.from),
        lat: p.payload.latitude_i / 1e7,
        lon: p.payload.longitude_i / 1e7,
        t: Date.now(),
      };
    }

    // NeighborInfo → /links/<from>  (adyacencia real medida con SNR)
    if (p.type === "neighborinfo" && p.payload && p.payload.neighbors) {
      buf[`links/${p.from}`] = {
        from: p.from,
        neighbors: p.payload.neighbors.map((n) => ({ id: n.node_id, snr: n.snr })),
        t: Date.now(),
      };
    }

    // nodeinfo → completa el nombre del nodo (opcional, útil para etiquetas)
    if (p.type === "nodeinfo" && p.payload && (p.payload.longname || p.payload.shortname)) {
      buf[`nodes/${p.from}/name`] = p.payload.longname || p.payload.shortname;
    }
  } catch (e) { /* no-JSON o cifrado: ignorar (ver PASO 0) */ }
});

function nodeName(p) {
  return (p.sender && String(p.sender)) || null;
}

// flush por lotes cada 5s para no martillar RTDB
setInterval(async () => {
  const keys = Object.keys(buf);
  if (!keys.length) return;
  const batch = buf; buf = {};
  for (const k of keys) await push(k, batch[k]);
  console.log(`flushed ${keys.length}`);
}, 5000);

console.log("mesh-bridge iniciado");
