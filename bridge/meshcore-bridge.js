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
 *   MC_BROKER             opcional (default mqtt://mqtt-msc.meshchile.cl:1883)
 *   MC_AUD                opcional (aud del JWT; default = host del broker)
 *   MC_SEED              opcional (semilla Ed25519 en hex, 32 bytes). Si falta,
 *                        se genera una y se imprime → guárdala para reusar user.
 *   MC_USER, MC_PASS     opcional (si el broker usa user/pass fijos en vez de JWT)
 *   MC_API               opcional (base del API del mapa MSC para sembrar el
 *                        censo; default https://mapa-msc.meshchile.cl; "off"=no)
 *   MC_API_MIN           opcional (minutos entre censos; default 5)
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

/* --- Censo desde el API del mapa (meshcore-mqtt-live-map) -------------------
 * GET /snapshot → { devices:[...], history_edges:[{a,b,count,last_ts}] }.
 * También tolera la forma de GET /api/nodes ({data:[{public_key,lat,lon,...}]}).
 * Siembra nodos posicionados y enlaces de ruta sin esperar adverts por RF. */
const CODE_MODE = { 1: "Companion", 2: "Repeater", 3: "RoomServer" };
function mapSnapshot(j, now, maxAgeMs) {
  const nodes = {}, links = {};
  const devs = Array.isArray(j.devices) ? j.devices : Array.isArray(j.data) ? j.data : Array.isArray(j.nodes) ? j.nodes : [];
  const known = new Set();
  for (const d of devs) {
    if (!d || typeof d !== "object") continue;
    const pub = String(d.public_key || d.device_id || d.id || "").toLowerCase();
    if (!/^[0-9a-f]{12,}$/.test(pub)) continue;
    const lat = num(d.lat != null ? d.lat : d.location && d.location.latitude);
    const lon = num(d.lon != null ? d.lon : d.location && d.location.longitude);
    if (lat == null || lon == null || (lat === 0 && lon === 0)) continue;
    const seen = num(d.last_seen_ts != null ? d.last_seen_ts : d.ts != null ? d.ts : d.timestamp);
    const t = seen ? Math.round(seen * 1000) : now;
    if (maxAgeMs && now - t > maxAgeMs) continue;              // más viejo que la purga: ni lo escribas
    const id = nid(pub);
    const n = { id, pub, lat, lon, t, src: "map" };
    if (d.name) n.name = String(d.name);
    const mode = typeof d.role === "string" && d.role.trim() ? d.role.trim().replace(/^./, (c) => c.toUpperCase()) : CODE_MODE[num(d.device_role)];
    if (mode) { n.mode = mode; if (MODE_ROLE[mode]) n.role = MODE_ROLE[mode]; }
    nodes[`nodes/${id}`] = n;
    known.add(id);
  }
  for (const e of Array.isArray(j.history_edges) ? j.history_edges : []) {
    if (!e || typeof e !== "object") continue;
    const a = nid(e.a || ""), b = nid(e.b || "");
    if (a === b || !known.has(a) || !known.has(b)) continue;   // solo entre nodos del censo
    const t = num(e.last_ts);
    const tMs = t ? Math.round(t * 1000) : now;
    if (maxAgeMs && now - tMs > maxAgeMs) continue;
    links[`links/${a}/nb/${b}`] = { snr: null, t: tMs, src: "ruta" };
  }
  return { nodes, links };
}

module.exports = { processMeshCorePacket, extractPacket, observerFromTopic, nid, newCounters, mapSnapshot };

/* ============================ RUNTIME (solo si se ejecuta directo) =========== */
if (require.main === module) {
  const mqtt = require("mqtt");
  const RTDB = process.env.RTDB_URL, SECRET = process.env.FB_SECRET;
  // TCP 1883: el broker CONCEDE la suscripción por TCP; por WSS acepta el
  // CONNECT pero silencia la sesión al suscribirse (WSS es para publicadores).
  const BROKER = process.env.MC_BROKER || "mqtt://mqtt-msc.meshchile.cl:1883";
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
    // client_id = la pubkey (como el tool de referencia); overridable con MC_CLIENT_ID.
    const clientId = process.env.MC_CLIENT_ID || identity.pubHex.toUpperCase();
    const client = mqtt.connect(BROKER, { clientId, username: tok.username, password: tok.password, reconnectPeriod: 0, protocolVersion: +(process.env.MC_MQTT_VER || 4), clean: true, connectTimeout: 20000, keepalive: 30 });
    if (process.env.MC_DEBUG) {
      client.on("packetsend", (p) => console.log("  → " + p.cmd + (p.messageId ? " id=" + p.messageId : "") + (p.returnCode != null ? " rc=" + p.returnCode : "")));
      client.on("packetreceive", (p) => console.log("  ← " + p.cmd + (p.messageId ? " id=" + p.messageId : "") + (p.returnCode != null ? " rc=" + p.returnCode : "") + (p.reasonCode != null ? " reason=" + p.reasonCode : "")));
    }
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
    body["meta/stats"] = { seen: counters.seen, adverts: counters.adverts, undecoded: counters.undecoded, obsLinks: counters.obsLinks, apiNodes: counters.apiNodes || 0, apiLinks: counters.apiLinks || 0, byType: counters.byType, topics: topicCounts, proto: "meshcore", t: now };
    await pushMulti(body);
    console.log(`flush: ${changed} cambios de ${Object.keys(batch).length} | vistos ${counters.seen} | adverts ${counters.adverts} | obs-links ${counters.obsLinks} | api ${counters.apiNodes || 0}n/${counters.apiLinks || 0}e | sin decodificar ${counters.undecoded}`);
  }, 5000);

  // Censo desde el API del mapa MSC: siembra nodos+enlaces cada MC_API_MIN min.
  // MC_API="" u "off" lo desactiva; default el mapa de MeshChile.
  const API = (process.env.MC_API !== undefined ? process.env.MC_API : "https://mapa-msc.meshchile.cl").trim();
  if (API && API !== "off" && API !== "0") {
    const pollApi = async () => {
      const now = Date.now();
      let j = null;
      try { const r = await fetch(API + "/snapshot", { signal: AbortSignal.timeout(30000) }); if (r.ok) j = await r.json(); } catch (e) {}
      if (!j) { try { const r = await fetch(API + "/api/nodes", { signal: AbortSignal.timeout(30000) }); if (r.ok) j = await r.json(); } catch (e) { console.error("api censo fail", e.message); } }
      if (!j) return;
      const { nodes, links } = mapSnapshot(j, now, PURGE_MS);
      Object.assign(buf, nodes, links);
      counters.apiNodes = Object.keys(nodes).length;
      counters.apiLinks = Object.keys(links).length;
      console.log(`censo API: ${counters.apiNodes} nodos, ${counters.apiLinks} enlaces de ruta`);
    };
    setInterval(pollApi, Math.max(1, +(process.env.MC_API_MIN || 5)) * 60 * 1000);
    pollApi();
  }

  setInterval(async () => {
    try {
      const [nodes, links] = await Promise.all([getJson("nodes"), getJson("links")]);
      const { del, dn, dl } = planPurge(nodes, links, Date.now() - PURGE_MS, st);
      if (Object.keys(del).length) { await pushMulti(del); console.log(`purge: -${dn} nodos, -${dl} enlaces (TTL ${PURGE_HOURS}h)`); }
    } catch (e) { console.error("purge fail", e.message); }
  }, PURGE_INTERVAL_MS);

  console.log(`meshcore-bridge iniciado · broker ${BROKER} · TTL ${PURGE_HOURS}h`);
}
