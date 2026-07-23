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
 *   MC_PEERS_MIN         opcional (minutos entre pasadas de /peers; 0=off; default 10)
 *   MC_WS                opcional (WebSocket del mapa para tiempo real; "off"=no;
 *                        default = MC_API con ws:// + /ws)
 *   PURGE_HOURS/PURGE_MIN  igual que el bridge Meshtastic (default 24h / 30min)
 *
 * Escribe:  /mc/nodes/<id>  /mc/links/<id>/nb/<vec>  /mc/meta/stats
 * (reusa planFlush/planPurge/newState/safeKey de bridge.js; el PATCH apunta a
 * ${RTDB}/mc/.json, así que las claves relativas caen bajo /mc)
 * ========================================================================== */
const meshcore = require("./meshcore");
const { planFlush, planPurge, newState, safeKey } = require("./bridge");

const num = (x) => (typeof x === "number" && isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && isFinite(+x) ? +x : null);

// Coordenada plausible: dentro de rango Y lejos del (0,0) (los GPS basura y las
// heurísticas de escala del mapa MSC aterrizan cerca del golfo de Guinea).
const validLL = (lat, lon) =>
  typeof lat === "number" && typeof lon === "number" && isFinite(lat) && isFinite(lon) &&
  Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(Math.abs(lat) < 0.5 && Math.abs(lon) < 0.5);

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

/* --- Registro hash→pubkey ---------------------------------------------------
 * El hash de nodo en MeshCore es el PRIMER BYTE de la pubkey. Con el censo +
 * adverts armamos el mapa; si dos pubkeys comparten primer byte, ese hash es
 * ambiguo y NO se resuelve (mejor ningún enlace que uno inventado). */
function newRegistry() { return { h2p: {}, amb: {} }; }
function regAdd(reg, pub) {
  if (!reg || !/^[0-9a-f]{64}$/.test(pub)) return;
  const h = pub.slice(0, 2);
  if (reg.amb[h]) return;
  const prev = reg.h2p[h];
  if (prev && prev !== pub) { delete reg.h2p[h]; reg.amb[h] = true; return; }
  reg.h2p[h] = pub;
}
const regResolve = (reg, hash) => (reg && hash.length === 2 && reg.h2p[hash]) || null;

// processMeshCorePacket(topic, raw, buf, counters, reg?) — puro respecto de sus args.
// Escribe nodes/<id>, links (obs/tr) y estado online de observadores.
function processMeshCorePacket(topic, raw, buf, counters, reg) {
  const now = Date.now();

  // topic /status: LWT retained del observador → online/offline en vivo
  if (/\/status$/.test(topic)) {
    try {
      const j = JSON.parse(raw.toString("utf8"));
      const obs = (j.origin_id ? String(j.origin_id).toLowerCase() : null) || observerFromTopic(topic);
      if (obs && /^[0-9a-f]{12,}$/.test(obs)) {
        const oid = nid(obs);
        const k = `nodes/${oid}`;
        buf[k] = Object.assign({ id: oid, pub: obs, observer: true }, buf[k] || {}, { online: j.status === "online", t: now });
        counters.statusMsgs = (counters.statusMsgs || 0) + 1;
        if (reg) regAdd(reg, obs);
      }
    } catch { /* status no-JSON: ignorar */ }
    return;
  }

  counters.seen = (counters.seen || 0) + 1;
  const { hex, snr, originId } = extractPacket(raw);
  const d = meshcore.decodePacketHex(hex);
  if (!d) { counters.undecoded = (counters.undecoded || 0) + 1; return; }
  const tkey = "t" + d.payloadType;
  counters.byType[tkey] = (counters.byType[tkey] || 0) + 1;

  const obs = originId || observerFromTopic(topic);
  const oid = obs ? nid(obs) : null;
  if (obs && reg) regAdd(reg, obs);
  // actividad por observador (para diagnóstico y tamaño de marker)
  if (oid && (counters.act[oid] != null || Object.keys(counters.act).length < 40)) counters.act[oid] = (counters.act[oid] || 0) + 1;

  // ADVERT: posiciona/nombra al emisor
  let originPub = null;
  if (d.advert && d.advert.pubkey) {
    counters.adverts = (counters.adverts || 0) + 1;
    const a = d.advert;
    originPub = a.pubkey;
    if (reg) regAdd(reg, a.pubkey);
    const id = nid(a.pubkey);
    const f = { id, pub: a.pubkey };
    if (validLL(a.lat, a.lon)) { f.lat = a.lat; f.lon = a.lon; }
    else if (a.lat != null) counters.badPos = (counters.badPos || 0) + 1;
    if (a.name) f.name = a.name;
    if (a.mode) { f.mode = a.mode; if (MODE_ROLE[a.mode]) f.role = MODE_ROLE[a.mode]; }
    buf[`nodes/${id}`] = Object.assign({ id }, buf[`nodes/${id}`] || {}, f, { t: now });
  }

  // Cadena real del paquete: origen → path[0] → … → path[n-1] → observador.
  // Los hops del path (hash de 1 byte) se resuelven contra el registro; el
  // último eslabón conocido es lo que el observador oyó DIRECTO por RF.
  const chain = [];
  if (originPub) chain.push(originPub);
  for (const h of d.path || []) { const p = regResolve(reg, h); if (p) chain.push(p); else if (chain.length) break; }
  for (let i = 0; i + 1 < chain.length; i++) {
    const x = nid(chain[i]), y = nid(chain[i + 1]);
    if (x === y) continue;
    buf[`links/${y}/nb/${x}`] = { snr: null, t: now, src: "tr" };   // y oyó a x (el path crece hacia adelante)
    counters.pathLinks = (counters.pathLinks || 0) + 1;
  }
  if (oid) {
    const last = chain.length ? chain[chain.length - 1] : originPub;
    const hadPath = (d.path || []).length > 0;
    if (last && nid(last) !== oid) {
      // con path, el observador oyó al ÚLTIMO repetidor (no al origen); el SNR es de ese tramo
      buf[`links/${oid}/nb/${nid(last)}`] = { snr: snr, t: now, src: hadPath ? "tr" : "obs" };
      counters.obsLinks = (counters.obsLinks || 0) + 1;
    }
    const ok = `nodes/${oid}`;
    if (!buf[ok]) buf[ok] = Object.assign({ id: oid, pub: obs, observer: true }, buf[ok] || {}, { t: now });
  }
}

function newCounters() { return { seen: 0, undecoded: 0, adverts: 0, obsLinks: 0, pathLinks: 0, statusMsgs: 0, badPos: 0, act: {}, byType: {} }; }

/* --- Censo desde el API del mapa (meshcore-mqtt-live-map) -------------------
 * GET /snapshot → { devices:[...], history_edges:[{a,b,count,last_ts}] }.
 * También tolera la forma de GET /api/nodes ({data:[{public_key,lat,lon,...}]}).
 * Siembra nodos posicionados y enlaces de ruta sin esperar adverts por RF. */
const CODE_MODE = { 1: "Companion", 2: "Repeater", 3: "RoomServer" };
function mapSnapshot(j, now, maxAgeMs) {
  const nodes = {}, links = {}, extra = {};
  // /snapshot trae devices como DICT {id:{...}}; /api/nodes como lista en data[]
  const devs = j.devices && typeof j.devices === "object" && !Array.isArray(j.devices) ? Object.values(j.devices)
             : Array.isArray(j.devices) ? j.devices
             : Array.isArray(j.data) ? j.data : Array.isArray(j.nodes) ? j.nodes : [];
  const known = new Set();
  const byCoord = new Map();                                    // "lat,lon" (4 dec) → id
  const ckey = (lat, lon) => lat.toFixed(4) + "," + lon.toFixed(4);
  for (const d of devs) {
    if (!d || typeof d !== "object") continue;
    const pub = String(d.public_key || d.device_id || d.id || "").toLowerCase();
    if (!/^[0-9a-f]{12,}$/.test(pub)) continue;
    const lat = num(d.lat != null ? d.lat : d.location && d.location.latitude);
    const lon = num(d.lon != null ? d.lon : d.location && d.location.longitude);
    if (lat == null || lon == null || !validLL(lat, lon)) continue;
    const seen = num(d.last_seen_ts != null ? d.last_seen_ts : d.ts != null ? d.ts : d.timestamp);
    const t = seen ? Math.round(seen * 1000) : now;
    if (maxAgeMs && now - t > maxAgeMs) continue;              // más viejo que la purga: ni lo escribas
    const id = nid(pub);
    const n = { id, pub, lat, lon, t, src: "map" };
    if (d.name) n.name = String(d.name);
    const mode = typeof d.role === "string" && d.role.trim() ? d.role.trim().replace(/^./, (c) => c.toUpperCase()) : CODE_MODE[num(d.device_role)];
    if (mode) { n.mode = mode; if (MODE_ROLE[mode]) n.role = MODE_ROLE[mode]; }
    // presencia MQTT (nodo conectado por internet): el timestamp más reciente
    // de cualquier señal MQTT; el status "offline" explícito no cuenta.
    const mq = Math.max(
      num(d.mqtt_seen_ts) || 0, num(d.mqtt_internal_ts) || 0, num(d.mqtt_packets_ts) || 0,
      d.mqtt_status_value === "online" ? num(d.mqtt_status_ts) || 0 : 0,
    );
    if (mq > 0) { n.mqtt = Math.round(mq * 1000); if (d.mqtt_online_source) n.mqttSrc = String(d.mqtt_online_source); }
    // última calidad RF vista y movilidad (nodos móviles reportan rumbo/velocidad)
    if (num(d.rssi) != null) n.rssi = num(d.rssi);
    if (num(d.snr) != null) n.snr = num(d.snr);
    if (num(d.heading) != null) n.heading = num(d.heading);
    if (num(d.speed) != null && num(d.speed) > 0) n.speed = num(d.speed);
    nodes[`nodes/${id}`] = n;
    known.add(id);
    byCoord.set(ckey(lat, lon), id);
  }
  // history_edges: a/b vienen como pares [lat,lon] (extremos = posiciones de
  // nodos) → se resuelven por coordenadas; se tolera también a/b como id.
  const endp = (v) => {
    if (Array.isArray(v)) { const la = num(v[0]), lo = num(v[1]); return la != null && lo != null ? byCoord.get(ckey(la, lo)) : null; }
    const id = nid(String(v || "")); return known.has(id) ? id : null;
  };
  for (const e of Array.isArray(j.history_edges) ? j.history_edges : []) {
    if (!e || typeof e !== "object") continue;
    const a = endp(e.a), b = endp(e.b);
    if (!a || !b || a === b) continue;
    const t = num(e.last_ts);
    const tMs = t ? Math.round(t * 1000) : now;
    if (maxAgeMs && now - tMs > maxAgeMs) continue;
    const l = { snr: null, t: tMs, src: "ruta" };
    if (num(e.count) != null && num(e.count) > 1) l.n = Math.round(num(e.count));   // volumen → grosor de línea
    links[`links/${a}/nb/${b}`] = l;
  }
  // rutas multi-salto reales recientes (el "traceroute" de MeshCore): top 40 por fecha
  const routes = (Array.isArray(j.routes) ? j.routes : [])
    .filter((r) => r && Array.isArray(r.points) && r.points.length >= 2)
    .filter((r) => !maxAgeMs || now - (num(r.ts) ? num(r.ts) * 1000 : now) <= maxAgeMs)
    .sort((x, y) => (num(y.ts) || 0) - (num(x.ts) || 0)).slice(0, 40);
  const rlist = [];
  for (const r of routes) {
    const pts = r.points.filter((p) => Array.isArray(p) && validLL(num(p[0]), num(p[1]))).map((p) => [num(p[0]), num(p[1])]).slice(0, 20);
    if (pts.length < 2) continue;
    rlist.push(compactObj({ p: pts, t: num(r.ts) ? Math.round(num(r.ts) * 1000) : now, mode: r.route_mode, name: r.sender_name || undefined }));
  }
  if (rlist.length) extra["routes/all"] = rlist;
  // estelas de movimiento: una clave por nodo (los updates incrementales del WS
  // no deben pisar las estelas de los demás), últimos 20 puntos
  if (j.trails && typeof j.trails === "object") {
    for (const k in j.trails) {
      const id = nid(String(k).toLowerCase());
      if (!known.has(id) || !Array.isArray(j.trails[k])) continue;
      const pts = j.trails[k].filter((p) => Array.isArray(p) && validLL(num(p[0]), num(p[1]))).slice(-20).map((p) => [num(p[0]), num(p[1])]);
      if (pts.length >= 2) extra[`trails/${id}`] = pts;
    }
  }
  // eventos de actividad para el mapa de calor: [[lat,lon,ts,peso], ...]
  const heat = (Array.isArray(j.heat) ? j.heat : [])
    .filter((h) => Array.isArray(h) && validLL(num(h[0]), num(h[1])))
    .slice(-500).map((h) => [num(h[0]), num(h[1]), num(h[3]) != null ? num(h[3]) : 0.7]);
  if (heat.length) extra["heat/all"] = heat;
  return { nodes, links, extra };
}
const compactObj = (o) => { const r = {}; for (const k in o) if (o[k] !== undefined) r[k] = o[k]; return r; };

/* --- /peers/{id}: adyacencia dirigida con volumen (bajo demanda del API) ----
 * outgoing = a quiénes les llegó tráfico DESDE id; incoming = de quiénes recibió.
 * Modelo "quién oye a quién": incoming[x] ⇒ id oyó a x; outgoing[y] ⇒ y oyó a id. */
function mapPeers(id, j, now) {
  const links = {};
  if (!j || typeof j !== "object") return links;
  const put = (listener, speaker, p) => {
    if (!listener || !speaker || listener === speaker) return;
    const t = num(p.last_seen_ts);
    const l = { snr: null, t: t ? Math.round(t * 1000) : now, src: "peers" };
    if (num(p.count) != null && num(p.count) > 1) l.n = Math.round(num(p.count));
    links[`links/${listener}/nb/${speaker}`] = l;
  };
  // incoming: id recibió DE p.peer_id → id oyó a peer
  for (const p of Array.isArray(j.incoming) ? j.incoming : []) { if (p && p.peer_id) put(id, nid(String(p.peer_id).toLowerCase()), p); }
  // outgoing: tráfico de id llegó A p.peer_id → peer oyó a id
  for (const p of Array.isArray(j.outgoing) ? j.outgoing : []) { if (p && p.peer_id) put(nid(String(p.peer_id).toLowerCase()), id, p); }
  return links;
}

module.exports = { processMeshCorePacket, extractPacket, observerFromTopic, nid, newCounters, mapSnapshot, mapPeers, validLL, newRegistry, regAdd };

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
  const reg = newRegistry();          // hash(1 byte) → pubkey, para resolver paths
  const topicCounts = {};
  let censusIds = [];                 // pubkeys del censo (para el polling de /peers)
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
      try { processMeshCorePacket(topic, raw, buf, counters, reg); } catch (e) {}
    });
  }
  connect();

  setInterval(async () => {
    const now = Date.now();
    const batch = buf; buf = {};
    const { body, changed } = planFlush(batch, st, now);
    body["meta/stats"] = { seen: counters.seen, adverts: counters.adverts, undecoded: counters.undecoded, obsLinks: counters.obsLinks, pathLinks: counters.pathLinks, statusMsgs: counters.statusMsgs, badPos: counters.badPos, apiNodes: counters.apiNodes || 0, apiLinks: counters.apiLinks || 0, peerLinks: counters.peerLinks || 0, wsEvents: counters.wsEvents || 0, act: counters.act, byType: counters.byType, topics: topicCounts, proto: "meshcore", t: now };
    await pushMulti(body);
    console.log(`flush: ${changed} cambios de ${Object.keys(batch).length} | vistos ${counters.seen} | adverts ${counters.adverts} | obs ${counters.obsLinks} | path ${counters.pathLinks} | api ${counters.apiNodes || 0}n/${counters.apiLinks || 0}e | peers ${counters.peerLinks || 0} | badPos ${counters.badPos}`);
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
      const { nodes, links, extra } = mapSnapshot(j, now, PURGE_MS);
      Object.assign(buf, nodes, links, extra);
      counters.apiNodes = Object.keys(nodes).length;
      counters.apiLinks = Object.keys(links).length;
      censusIds = Object.values(nodes).map((n) => n.pub).filter(Boolean);
      for (const p of censusIds) regAdd(reg, p);              // alimenta hash→pubkey para el path
      const xs = Object.keys(extra).map((k) => k.split("/")[0]).join(",");
      console.log(`censo API: ${counters.apiNodes} nodos, ${counters.apiLinks} enlaces de ruta${xs ? " · capas: " + xs : ""}`);
    };
    setInterval(pollApi, Math.max(1, +(process.env.MC_API_MIN || 5)) * 60 * 1000);
    pollApi();

    // /peers/{id}: adyacencia dirigida con volumen — secuencial y suave con el API
    const PEERS_MIN = Math.max(0, +(process.env.MC_PEERS_MIN || 10));
    if (PEERS_MIN > 0) {
      const pollPeers = async () => {
        let added = 0;
        for (const pub of censusIds.slice(0, 60)) {
          try {
            const r = await fetch(`${API}/peers/${pub.toUpperCase()}?limit=10`, { signal: AbortSignal.timeout(15000) });
            if (!r.ok) continue;
            const links = mapPeers(nid(pub), await r.json(), Date.now());
            Object.assign(buf, links);
            added += Object.keys(links).length;
          } catch (e) { /* nodo sin peers o timeout: seguir */ }
          await new Promise((res) => setTimeout(res, 400));
        }
        counters.peerLinks = added;
        if (added) console.log(`peers API: ${added} enlaces dirigidos con volumen`);
      };
      setInterval(pollPeers, PEERS_MIN * 60 * 1000);
      setTimeout(pollPeers, 20000);   // primera pasada tras el primer censo
    }

    // WebSocket del mapa: el backend transmite a sus clientes web un snapshot al
    // conectar y luego eventos en vivo (update de nodo+estela, rutas). Es la vía
    // en TIEMPO REAL (el broker MQTT filtra la entrega por ACL y no nos llega el
    // tráfico crudo); el polling HTTP queda como respaldo. MC_WS="off" desactiva.
    const WS_URL = (process.env.MC_WS !== undefined ? process.env.MC_WS : API.replace(/^http/, "ws") + "/ws").trim();
    if (WS_URL && WS_URL !== "off" && WS_URL !== "0") {
      let WSImpl = null;
      try { WSImpl = require("ws"); } catch (e) { console.log("módulo 'ws' no disponible — sigo solo con polling"); }
      if (WSImpl) {
        let recentRoutes = [];
        const ingest = (j, tag) => {
          const now = Date.now();
          const { nodes, links, extra } = mapSnapshot(j, now, PURGE_MS);
          Object.assign(buf, nodes, links, extra);
          for (const k in nodes) if (nodes[k].pub) regAdd(reg, nodes[k].pub);
          if (tag === "snapshot") censusIds = Object.values(nodes).map((n) => n.pub).filter(Boolean);
        };
        const connectWs = () => {
          const sock = new WSImpl(WS_URL, { handshakeTimeout: 20000 });
          sock.on("open", () => console.log("WS del mapa conectado — datos en tiempo real"));
          sock.on("message", (data) => {
            let j; try { j = JSON.parse(data.toString()); } catch (e) { return; }
            counters.wsEvents = (counters.wsEvents || 0) + 1;
            if (j.type === "snapshot") {
              if (Array.isArray(j.routes)) { recentRoutes = j.routes.slice(0, 40); }
              ingest(j, "snapshot");
            } else if (j.type === "update" && j.device) {
              const mini = { devices: [j.device] };
              const devId = String(j.device.device_id || j.device.public_key || "").toLowerCase();
              if (devId && Array.isArray(j.trail) && j.trail.length >= 2) mini.trails = { [devId]: j.trail };
              ingest(mini, "update");
            } else if (j.type === "route" && j.route) {
              recentRoutes.unshift(j.route);
              recentRoutes = recentRoutes.slice(0, 40);
              const { extra } = mapSnapshot({ routes: recentRoutes }, Date.now(), PURGE_MS);
              if (extra["routes/all"]) buf["routes/all"] = extra["routes/all"];
            }
          });
          sock.on("error", (e) => console.error("ws mapa err", e.message));
          sock.on("close", () => { console.log("ws mapa cerrado; reintento en 15s"); setTimeout(connectWs, 15000); });
        };
        connectWs();
      }
    }
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
