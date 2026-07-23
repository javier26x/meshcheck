/* ============================================================================
 * meshcore-bridge — cosecha del broker MeshCore de MeshChile (MQTT sobre WSS)
 * hacia Firebase RTDB, bajo la raíz /mc/* (aislado del bridge Meshtastic).
 * Persistente (VPS + PM2). Requiere Node 18+.
 *
 * A diferencia de Meshtastic, MeshCore no publica JSON: cada observador (un nodo
 * con firmware MeshCore + puente MQTT) reenvía al broker los paquetes de RF que
 * escucha, en el topic  meshcore/{IATA}/{PUBKEY_OBSERVADOR}/packets. Nosotros:
 *   1. nos autenticamos con un JWT Ed25519 auto-soberano (identidad de software),
 *   2. nos suscribimos a  meshcore/#,
 *   3. decodificamos los ADVERT (posición + nombre + modo del nodo emisor),
 *   4. modelamos "quién escuchó a quién": el OBSERVADOR del topic oyó ese advert,
 *      así que creamos el enlace  observador ↔ nodo  (análogo al "gw" Meshtastic).
 *
 * Env:
 *   RTDB_URL, FB_SECRET   obligatorios (database secret; salta las reglas)
 *   MC_BROKER             opcional (default wss://mqtt-msc.meshchile.cl:443)
 *   MC_AUD                opcional (aud del JWT; default = host del broker)
 *   MC_SEED              opcional (semilla Ed25519 en hex, 32 bytes). Si falta,
 *                        se genera una y se imprime → guárdala para reusar user.
 *   MC_USER, MC_PASS     opcional (si el broker usa user/pass fijos en vez de JWT)
 *   PURGE_HOURS/PURGE_MIN  igual que el bridge Meshtastic (default 24h / 30min)
 *
 * Escribe:  /mc/nodes/<id>  /mc/links/<id>/nb/<vec>  /mc/meta/stats
 * (reusa planFlush/planPurge/newState/safeKey de bridge.js; el PATCH apunta a
 * ${RTDB}/mc/.json, así que las claves relativas caen bajo /mc)
 * ========================================================================== */
const meshcore = require("./meshcore");
const { planFlush, planPurge, newState, safeKey } = require("./bridge");

const num = (x) => (typeof x === "number" && isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && isFinite(+x) ? +x : null);

// id de nodo = pubkey en minúsculas (hex). Único y estable entre observador
// (viene del topic) y emisor (viene del advert): ambos son la misma pubkey.
const nid = (pubHex) => safeKey(String(pubHex).toLowerCase());

// El observador es el segmento del topic que parece pubkey (hex largo).
function observerFromTopic(topic) {
  const parts = String(topic).split("/");
  for (const p of parts) if (/^[0-9a-fA-F]{12,}$/.test(p)) return p.toLowerCase();
  return null;
}

// El mensaje del observador puede venir como JSON {raw_hex, snr, rssi, ...},
// como string hex pelado, o como bytes crudos. Toleramos las tres formas.
function extractPacket(raw) {
  const s = raw.toString("utf8").trim();
  if (s[0] === "{") {
    try {
      const j = JSON.parse(s);
      // el observador MeshChile publica {..., "raw":"<HEX>", "SNR":"..", "origin_id":"<PUBKEY>"}
      const hex = j.raw || j.raw_hex || j.rawHex || j.hex || j.packet || j.payload || j.data;
      if (typeof hex === "string" && /^[0-9a-fA-Fx]+$/.test(hex)) {
        return { hex: hex.replace(/^0x/, ""), snr: num(j.snr ?? j.SNR ?? j.rx_snr), rssi: num(j.rssi ?? j.RSSI ?? j.rx_rssi), originId: j.origin_id ? String(j.origin_id).toLowerCase() : null };
      }
    } catch { /* no era JSON válido */ }
  }
  if (/^[0-9a-fA-F]+$/.test(s) && s.length >= 4) return { hex: s, snr: null, rssi: null, originId: null };
  return { hex: raw.toString("hex"), snr: null, rssi: null, originId: null };
}

const MODE_ROLE = { Repeater: "ROUTER", RoomServer: "ROUTER", Companion: "CLIENT", Sensor: "SENSOR" };

// processMeshCorePacket(topic, raw, buf, counters) — puro respecto de buf/counters.
// Llena buf con nodes/<id> (posición/nombre) y links/<obs>/nb/<nodo> (SNR).
function processMeshCorePacket(topic, raw, buf, counters) {
  counters.seen = (counters.seen || 0) + 1;
  const { hex, snr, originId } = extractPacket(raw);
  const d = meshcore.decodePacketHex(hex);
  if (!d) { counters.undecoded = (counters.undecoded || 0) + 1; return; }
  const tkey = "t" + d.payloadType;
  counters.byType[tkey] = (counters.byType[tkey] || 0) + 1;
  if (!d.advert || !d.advert.pubkey) return;               // solo los ADVERT posicionan
  counters.adverts = (counters.adverts || 0) + 1;

  const a = d.advert;
  const id = nid(a.pubkey);
  const now = Date.now();
  const f = { id, pub: a.pubkey };
  if (typeof a.lat === "number" && typeof a.lon === "number" && a.lat !== 0) { f.lat = a.lat; f.lon = a.lon; }
  if (a.name) f.name = a.name;
  if (a.mode) { f.mode = a.mode; if (MODE_ROLE[a.mode]) f.role = MODE_ROLE[a.mode]; }
  const k = `nodes/${id}`;
  buf[k] = Object.assign({ id }, buf[k] || {}, f, { t: now });

  // enlace observador → nodo emisor (el observador oyó este advert por RF).
  // origin_id del payload es más fiable que parsear el topic.
  const obs = originId || observerFromTopic(topic);
  if (obs) {
    const oid = nid(obs);
    if (oid !== id) {
      buf[`links/${oid}/nb/${id}`] = { snr: snr, t: now, src: "obs" };
      counters.obsLinks = (counters.obsLinks || 0) + 1;
      // el observador existe como nodo aunque aún no tengamos su posición
      const ok = `nodes/${oid}`;
      if (!buf[ok]) buf[ok] = Object.assign({ id: oid, pub: obs, observer: true }, buf[ok] || {}, { t: now });
    }
  }
}

function newCounters() { return { seen: 0, undecoded: 0, adverts: 0, obsLinks: 0, byType: {} }; }

module.exports = { processMeshCorePacket, extractPacket, observerFromTopic, nid, newCounters };

/* ============================ RUNTIME (solo si se ejecuta directo) =========== */
if (require.main === module) {
  const mqtt = require("mqtt");
  const RTDB = process.env.RTDB_URL, SECRET = process.env.FB_SECRET;
  const BROKER = process.env.MC_BROKER || "wss://mqtt-msc.meshchile.cl:443";
  const AUD = process.env.MC_AUD || (() => { try { return new URL(BROKER).hostname; } catch { return "mqtt-msc.meshchile.cl"; } })();
  const PURGE_HOURS = +(process.env.PURGE_HOURS || 24);
  const PURGE_MS = PURGE_HOURS * 3600 * 1000;
  const PURGE_INTERVAL_MS = +(process.env.PURGE_MIN || 30) * 60 * 1000;
  if (!RTDB || !SECRET) { console.error("Falta RTDB_URL o FB_SECRET. Revisa ecosystem.config.js."); process.exit(1); }

  // Identidad de software: reusa MC_SEED si existe; si no, genera y avisa.
  const identity = meshcore.makeIdentity(process.env.MC_SEED);
  if (!process.env.MC_SEED) console.log(`⚠  MC_SEED no seteada. Semilla generada (guárdala en ecosystem.config.js para reusar la misma identidad):\n   MC_SEED: "${identity.seedHex}"`);
  console.log(`identidad MeshCore  pub=${identity.pubHex.slice(0, 16)}…  aud=${AUD}`);

  // el PATCH/GET van a la subruta /mc → las claves relativas caen bajo /mc/*
  const pushMulti = async (body) => {
    try {
      const r = await fetch(`${RTDB}/mc/.json?auth=${SECRET}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) console.error("push", r.status, await r.text().catch(() => ""));
    } catch (e) { console.error("push fail", e.message); }
  };
  const getJson = (path) => fetch(`${RTDB}/mc/${path}.json?auth=${SECRET}`).then((r) => r.ok ? r.json() : null).catch(() => null);

  const st = newState();
  let buf = {};
  const counters = newCounters();
  const topicCounts = {};
  let sampled = 0;

  function connect() {
    const tok = process.env.MC_USER ? { username: process.env.MC_USER, password: process.env.MC_PASS }
                                    : meshcore.buildAuthToken(identity, AUD);
    // MQTT 3.1.1 por defecto (el broker MSC rechaza v5); override con MC_MQTT_VER.
    const client = mqtt.connect(BROKER, { username: tok.username, password: tok.password, reconnectPeriod: 0, protocolVersion: +(process.env.MC_MQTT_VER || 4), clean: true, connectTimeout: 20000, keepalive: 30 });
    const SUB = process.env.MC_SUB || "meshcore/#";
    client.on("connect", () => {
      console.log("MeshCore MQTT ok · suscribiendo a", SUB);
      client.subscribe(SUB, { qos: 0 }, (e, granted) => {
        if (e) return console.error("subscribe err", e.message);
        console.log("suback:", JSON.stringify(granted || []));
        if (granted && granted.some((g) => g.qos >= 128)) console.error("⚠ el broker NEGÓ la suscripción (ACL, QoS 0x80). No llegarán mensajes con esta identidad/topic.");
      });
    });
    client.on("error", (e) => console.error("mqtt err", e.message));
    client.on("close", () => {
      // el JWT caduca: reconecta con un token fresco (reconnectPeriod=0 → manual)
      console.log("conexión cerrada; reconectando con token nuevo en 5s…");
      setTimeout(() => { try { client.end(true); } catch {} connect(); }, 5000);
    });
    client.on("message", (topic, raw) => {
      const tkey = safeKey(topic.split("/").slice(0, 3).join("/"));
      if (topicCounts[tkey] != null || Object.keys(topicCounts).length < 40) topicCounts[tkey] = (topicCounts[tkey] || 0) + 1;
      if (sampled < 3) { sampled++; console.log(`muestra ${sampled} [${topic}]:`, raw.toString("utf8").slice(0, 200)); }
      try { processMeshCorePacket(topic, raw, buf, counters); } catch (e) {}
    });
  }
  connect();

  setInterval(async () => {
    const now = Date.now();
    const batch = buf; buf = {};
    const { body, changed } = planFlush(batch, st, now);
    body["meta/stats"] = { seen: counters.seen, adverts: counters.adverts, undecoded: counters.undecoded, obsLinks: counters.obsLinks, byType: counters.byType, topics: topicCounts, proto: "meshcore", t: now };
    await pushMulti(body);
    console.log(`flush: ${changed} cambios de ${Object.keys(batch).length} | vistos ${counters.seen} | adverts ${counters.adverts} | obs-links ${counters.obsLinks} | sin decodificar ${counters.undecoded}`);
  }, 5000);

  setInterval(async () => {
    try {
      const [nodes, links] = await Promise.all([getJson("nodes"), getJson("links")]);
      const { del, dn, dl } = planPurge(nodes, links, Date.now() - PURGE_MS, st);
      if (Object.keys(del).length) { await pushMulti(del); console.log(`purge: -${dn} nodos, -${dl} enlaces (TTL ${PURGE_HOURS}h)`); }
    } catch (e) { console.error("purge fail", e.message); }
  }, PURGE_INTERVAL_MS);

  console.log(`meshcore-bridge iniciado · broker ${BROKER} · TTL ${PURGE_HOURS}h`);
}
