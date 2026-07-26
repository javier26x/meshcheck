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
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// El mapa dice "room"; el decoder oficial y los adverts dicen "RoomServer".
// Es el mismo aparato: infraestructura fija, igual que un repetidor.
const ROLE_ALIAS = { room: "RoomServer", roomserver: "RoomServer", "room server": "RoomServer", repeater: "Repeater", companion: "Companion", sensor: "Sensor" };

/* --- Fusión de enlaces por prioridad de fuente ------------------------------
 * Tres fuentes escriben la misma hoja links/<a>/nb/<b>. Una medición por RF
 * (con SNR) no debe ser pisada por una adyacencia histórica sin SNR: se conserva
 * la medición vigente y se le suma lo que la otra fuente sí aporta (volumen y
 * frescura). `held` es el último valor ya publicado (memoria entre lotes). */
const LINK_PRIO = { obs: 4, tr: 3, peers: 2, ruta: 1 };
const MEAS_HOLD_MS = 60 * 60 * 1000;           // una medición manda por 1 h
function putLink(buf, k, v, held) {
  const cur = buf[k] || (held && held[k]) || null;
  const tCur = cur ? num(cur.t) || 0 : 0, tNew = num(v.t) || 0;
  const t = Math.max(tCur, tNew);                                  // el reloj nunca retrocede
  const n = v.n != null ? v.n : cur && cur.n;
  const vigente = cur && cur.snr != null && tNew - tCur <= MEAS_HOLD_MS;
  if (vigente && (LINK_PRIO[v.src] || 0) < (LINK_PRIO[cur.src] || 0)) {
    buf[k] = compactObj({ snr: cur.snr, t, src: cur.src, n, w: v.w != null ? v.w : cur.w });
    return;
  }
  buf[k] = compactObj({ snr: v.snr != null ? v.snr : null, t, src: v.src, n, w: v.w != null ? v.w : cur && cur.w });
}
const putLinks = (buf, links, held) => { for (const k in links) putLink(buf, k, links[k], held); };
const putNodes = (buf, nodes) => { for (const k in nodes) buf[k] = Object.assign({}, buf[k], nodes[k]); };

/* --- Registro hash→pubkey ---------------------------------------------------
 * El hash de nodo en MeshCore es un PREFIJO de la pubkey, de 1, 2 o 3 bytes
 * según el selector del path (bits 7:6 del byte de longitud). Indexamos los
 * tres anchos por separado, como el decoder oficial (NODE_HASH_LENGTHS). Si dos
 * pubkeys comparten prefijo, ese hash queda ambiguo y NO se resuelve: mejor
 * ningún enlace que uno inventado. */
const HASH_WIDTHS = [2, 4, 6];                 // en caracteres hex (1, 2 y 3 bytes)
function newRegistry() { return { h2p: { 2: {}, 4: {}, 6: {} }, amb: { 2: {}, 4: {}, 6: {} } }; }
function regAdd(reg, pub) {
  if (!reg || !/^[0-9a-f]{64}$/.test(pub)) return;
  for (const w of HASH_WIDTHS) {
    const h = pub.slice(0, w);
    if (reg.amb[w][h]) continue;
    const prev = reg.h2p[w][h];
    if (prev && prev !== pub) { delete reg.h2p[w][h]; reg.amb[w][h] = true; continue; }
    reg.h2p[w][h] = pub;
  }
}
const regResolve = (reg, hash) => (reg && reg.h2p[hash.length] && reg.h2p[hash.length][hash]) || null;

// onlineFromStatus(j) → true | false | undefined (undefined = no afirmamos nada).
// Los observadores publican el estado en claves y mayúsculas variadas; solo
// "offline"/"disconnected" cuentan como caído.
const OFFLINE_WORDS = ["offline", "disconnected", "down"];
function onlineFromStatus(j) {
  for (const k of ["status", "state", "connection", "online", "value", "msg"]) {
    const v = j && j[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string" && v.trim()) {
      const s = v.trim().toLowerCase();
      return !OFFLINE_WORDS.includes(s);
    }
  }
  return undefined;
}

// processMeshCorePacket(topic, raw, buf, counters, reg?, held?) — puro respecto de sus args.
// Escribe nodes/<id>, links (obs/tr) y estado online de observadores.
function processMeshCorePacket(topic, raw, buf, counters, reg, held) {
  const now = Date.now();

  // topic /status: LWT retained del observador → online/offline en vivo
  if (/\/status$/.test(topic)) {
    try {
      const j = JSON.parse(raw.toString("utf8"));
      const obs = (j.origin_id ? String(j.origin_id).toLowerCase() : null) || observerFromTopic(topic);
      if (obs && /^[0-9a-f]{12,}$/.test(obs)) {
        const oid = nid(obs);
        const k = `nodes/${oid}`;
        const online = onlineFromStatus(j);
        buf[k] = Object.assign({ id: oid, pub: obs, observer: true }, buf[k] || {}, compactObj({ online, t: now, seen: now }));
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
    buf[`nodes/${id}`] = Object.assign({ id }, buf[`nodes/${id}`] || {}, f, { t: now, seen: now });
  }

  // Cadena real del paquete: origen → path[0] → … → path[n-1] → observador.
  // Los hops del path son prefijos de pubkey (1-3 bytes) que se resuelven contra
  // el registro. Solo si el path se resuelve ENTERO sabemos a quién oyó el
  // observador; si queda truncado no escribimos ese último enlace (un enlace de
  // menos es mejor que uno inventado con el SNR de otro tramo).
  const chain = [];
  let full = true;
  if (originPub) chain.push(originPub);
  for (const h of d.path || []) {
    const p = regResolve(reg, h);
    if (p) { chain.push(p); continue; }
    full = false;
    if (chain.length) break;
  }
  for (let i = 0; i + 1 < chain.length; i++) {
    const x = nid(chain[i]), y = nid(chain[i + 1]);
    if (x === y) continue;
    putLink(buf, `links/${y}/nb/${x}`, { snr: null, t: now, src: "tr" }, held);   // y oyó a x
    counters.pathLinks = (counters.pathLinks || 0) + 1;
  }
  if (oid) {
    const hadPath = (d.path || []).length > 0;
    const last = hadPath ? (full && chain.length ? chain[chain.length - 1] : null) : originPub;
    if (hadPath && !full) counters.truncPath = (counters.truncPath || 0) + 1;
    if (last && nid(last) !== oid) {
      // con path, el observador oyó al ÚLTIMO repetidor (no al origen); el SNR es de ese tramo
      putLink(buf, `links/${oid}/nb/${nid(last)}`, { snr: snr, t: now, src: hadPath ? "tr" : "obs" }, held);
      counters.obsLinks = (counters.obsLinks || 0) + 1;
    }
    const ok = `nodes/${oid}`;
    if (!buf[ok]) buf[ok] = Object.assign({ id: oid, pub: obs, observer: true }, buf[ok] || {}, { t: now, seen: now });
  }
}

function newCounters() { return { seen: 0, undecoded: 0, adverts: 0, obsLinks: 0, pathLinks: 0, truncPath: 0, statusMsgs: 0, badPos: 0, act: {}, byType: {} }; }

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
  // Índice espacial para resolver los extremos de history_edges (que vienen como
  // coordenadas, no ids): celda de 3 decimales + vecinas, con tolerancia de 8 m.
  // Solo absorbe redondeo/jitter; si dos nodos caen dentro de la tolerancia el
  // extremo es AMBIGUO y no se escribe enlace.
  const CELL = 1e3, TOL_M = 8;
  const grid = new Map();
  const cellKey = (lat, lon) => Math.round(lat * CELL) + ":" + Math.round(lon * CELL);
  const gridAdd = (lat, lon, id) => {
    const k = cellKey(lat, lon), arr = grid.get(k);
    if (arr) { if (!arr.some((p) => p.id === id && p.lat === lat && p.lon === lon)) arr.push({ id, lat, lon }); }
    else grid.set(k, [{ id, lat, lon }]);
  };
  const distM = (a1, o1, a2, o2) => {
    const dy = (a2 - a1) * 111320, dx = (o2 - o1) * 111320 * Math.cos(((a1 + a2) * Math.PI) / 360);
    return Math.hypot(dy, dx);
  };
  for (const d of devs) {
    if (!d || typeof d !== "object") continue;
    const pub = String(d.public_key || d.device_id || d.id || "").toLowerCase();
    if (!/^[0-9a-f]{12,}$/.test(pub)) continue;
    const lat = num(d.lat != null ? d.lat : d.location && d.location.latitude);
    const lon = num(d.lon != null ? d.lon : d.location && d.location.longitude);
    if (lat == null || lon == null || !validLL(lat, lon)) continue;
    const lastSeen = num(d.last_seen_ts != null ? d.last_seen_ts : d.ts != null ? d.ts : d.timestamp);
    const t = lastSeen ? Math.round(lastSeen * 1000) : now;
    if (maxAgeMs && now - t > maxAgeMs) continue;              // más viejo que la purga: ni lo escribas
    const id = nid(pub);
    const n = { id, pub, lat, lon, t, src: "map" };
    if (d.name) n.name = String(d.name);
    // El mapa normaliza el rol a {repeater, companion, room}; nuestra tabla habla
    // el dialecto de los adverts por RF ("RoomServer"). Sin este alias, un
    // RoomServer se quedaba sin `role` y dejaba de contar como infraestructura.
    const rawRole = typeof d.role === "string" ? d.role.trim() : "";
    const rk = rawRole.toLowerCase();
    const mode = (has(ROLE_ALIAS, rk) ? ROLE_ALIAS[rk] : null) ||
      (rawRole ? rawRole.replace(/^./, (c) => c.toUpperCase()) : CODE_MODE[num(d.device_role)]);
    if (mode) { n.mode = mode; if (has(MODE_ROLE, mode)) n.role = MODE_ROLE[mode]; }
    // Presencia MQTT: el veredicto lo da el mapa en mqtt_seen_ts, que él purga a
    // los 300 s. mqtt_internal_ts/mqtt_packets_ts NO son veredicto (el mapa nunca
    // los borra), así que tomarlos por el máximo resucitaba nodos ya caídos.
    // Se escribe 0/null explícito al caer: omitir la clave no limpia (planFlush
    // fusiona campos acumulados).
    const mq = num(d.mqtt_seen_ts) || 0;
    n.mqtt = mq > 0 ? Math.round(mq * 1000) : null;
    n.mqttSrc = mq > 0 && d.mqtt_online_source ? String(d.mqtt_online_source) : null;
    // `seen` = cuándo lo oyó la malla POR RADIO. Ojo: para los observadores,
    // last_seen_ts se reestampa con su latido MQTT aunque su antena esté muda,
    // así que un timestamp pegado a una señal MQTT NO prueba recepción por RF.
    const mqMs = mq > 0 ? Math.round(mq * 1000) : 0;
    const rfMs = num(d.ts) ? Math.round(num(d.ts) * 1000) : 0;
    const okRf = (x) => x > 0 && (!mqMs || x > mqMs + 60000);
    n.seen = Math.max(okRf(rfMs) ? rfMs : 0, okRf(t) ? t : 0) || null;
    // última calidad RF vista y movilidad. `null` = retractación explícita: sin
    // esto la velocidad de un móvil detenido quedaba congelada para siempre.
    const hasK = (k) => Object.prototype.hasOwnProperty.call(d, k);
    const retract = (k, v) => { if (v != null) n[k] = v; else if (hasK(k)) n[k] = null; };
    retract("rssi", num(d.rssi));
    retract("snr", num(d.snr));
    retract("heading", num(d.heading));
    retract("speed", num(d.speed) > 0 ? num(d.speed) : null);
    nodes[`nodes/${id}`] = n;
    known.add(id);
    gridAdd(lat, lon, id);
  }
  // las estelas dan posiciones HISTÓRICAS: sin ellas, un nodo móvil nunca calza
  // con el extremo del enlace (que se congeló en la posición de aquel momento)
  if (j.trails && typeof j.trails === "object") {
    for (const k in j.trails) {
      const tid = nid(String(k).toLowerCase());
      if (!known.has(tid) || !Array.isArray(j.trails[k])) continue;
      for (const p of j.trails[k]) {
        const la = num(p && p[0]), lo = num(p && p[1]);
        if (la != null && lo != null && validLL(la, lo)) gridAdd(la, lo, tid);
      }
    }
  }
  // history_edges: a/b son SOLO los dos extremos [lat,lon] del tramo y el backend
  // los entrega YA ORDENADOS POR COORDENADA (history.py: `if a <= b`), así que NO
  // conservan quién oyó a quién → el enlace se escribe SIMÉTRICO; afirmar una
  // dirección sería inventarla. La dirección real la aporta mapPeers.
  const endp = (v) => {
    if (!Array.isArray(v)) { const id = nid(String(v || "")); return known.has(id) ? id : null; }
    const la = num(v[0]), lo = num(v[1]);
    if (la == null || lo == null) return null;
    const hits = new Set();
    const r = Math.round(la * CELL), c = Math.round(lo * CELL);
    for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++)
      for (const p of grid.get(r + i + ":" + (c + k)) || []) if (distM(la, lo, p.lat, p.lon) <= TOL_M) hits.add(p.id);
    return hits.size === 1 ? hits.values().next().value : null;    // 2+ ⇒ ambiguo ⇒ sin enlace
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
    // byte_counts: si TODO el tramo se resolvió con hash de 1 byte, la adyacencia
    // es de resolución ambigua → w=1 y el visor lo advierte
    const bc = e.byte_counts;
    if (bc && typeof bc === "object" && +bc["1"] > 0 && !+bc["2"] && !+bc["3"]) l.w = 1;
    links[`links/${a}/nb/${b}`] = l;
    links[`links/${b}/nb/${a}`] = Object.assign({}, l);            // objeto propio (no aliasar)
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
  // ventana real del acumulado `n` de los enlaces (para no rotular "24 h" a ojo)
  const win = num(j.history_window_seconds);
  return { nodes, links, extra, winSec: win && win > 0 ? Math.round(win) : null };
}
const compactObj = (o) => { const r = {}; for (const k in o) if (o[k] !== undefined) r[k] = o[k]; return r; };

/* --- Rutas del mapa → adyacencia por IDENTIDAD (y SNR real si viene) --------
 * El evento 'route' del WS trae `point_ids` (pubkeys de cada salto, ya resueltas
 * por el backend con desambiguación) y, en los paquetes TRACE (payload_type 9),
 * `snr_values`: el SNR EN dB que midió cada repetidor al recibir el salto
 * anterior. Es la ÚNICA medición de señal que MeshCore nos entrega hoy, porque
 * el broker MQTT nos filtra la entrega.
 *
 * Alineación (verificada contra decoder.py y el decoder oficial):
 *   point_ids = [origen, salto1, …, saltoN]   ·   hashes = [salto1 … saltoN]
 *   snr_values[i] = SNR con que point_ids[i+1] recibió de point_ids[i]
 * Solo se atribuye SNR si TODO calza; ante cualquier duda se escribe la
 * adyacencia sin SNR (mejor sin dato que con un dato mal asignado). */
const SNR_MIN = -32, SNR_MAX = 31.75;                 // rango de un int8/4
const isPrefixOf = (h, id) => !!h && !!id && String(id).toLowerCase().startsWith(String(h).toLowerCase());
function mapRouteLinks(r, now) {
  const links = {};
  if (!r || typeof r !== "object") return links;
  const ids = Array.isArray(r.point_ids) ? r.point_ids : null;
  const hashes = Array.isArray(r.hashes) ? r.hashes : [];
  if (!ids || ids.length < 2 || !hashes.length) return links;      // sin hashes ⇒ el backend no resolvió el path
  if (r.route_mode && r.route_mode !== "path") return links;       // 'direct'/'fanout' = relleno [origen,receptor]
  const t = num(r.ts) ? Math.round(num(r.ts) * 1000) : now;
  // ancho de hash: si TODOS eran de 1 byte, la resolución es ambigua
  const widths = new Set(hashes.map((h) => { const s = String(h == null ? "" : h).trim().replace(/^0x/i, ""); return s.length === 2 || s.length === 4 || s.length === 6 ? s.length / 2 : 0; }));
  const amb = widths.size === 1 && widths.has(1);
  // ¿podemos confiar en el SNR? (TRACE + arrays alineados + sin inversión)
  const snr = Array.isArray(r.snr_values) ? r.snr_values : null;
  const snrOk = !!snr && r.payload_type === 9 &&
    snr.length === hashes.length && ids.length === hashes.length + 1 &&
    !ids.some((x) => !x) && String(ids[0] || "").toLowerCase() === String(r.origin_id || "").toLowerCase() &&
    snr.every((v) => typeof v === "number" && isFinite(v) && v >= SNR_MIN && v <= SNR_MAX) &&
    !isPrefixOf(hashes[hashes.length - 1], r.receiver_id) && !isPrefixOf(hashes[0], r.origin_id);
  for (let i = 0; i < ids.length - 1; i++) {
    const a = ids[i] ? nid(String(ids[i]).toLowerCase()) : null;
    const b = ids[i + 1] ? nid(String(ids[i + 1]).toLowerCase()) : null;
    if (!a || !b || a === b) continue;
    if (!/^[0-9a-f]{12,}$/.test(a) || !/^[0-9a-f]{12,}$/.test(b)) continue;
    const s = snrOk ? snr[i] : null;
    // b midió el SNR al recibir de a → "b oye a a". Sin SNR se escribe simétrico
    // (la adyacencia es real pero el sentido no aporta nada extra).
    const l = compactObj({ snr: s, t, src: s != null ? "tr" : "ruta", w: amb ? 1 : undefined });
    links[`links/${b}/nb/${a}`] = l;
    if (s == null) links[`links/${a}/nb/${b}`] = Object.assign({}, l);
  }
  return links;
}

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

module.exports = { processMeshCorePacket, extractPacket, observerFromTopic, nid, newCounters, mapSnapshot, mapPeers, mapRouteLinks, validLL, newRegistry, regAdd, putLink, putLinks, putNodes, onlineFromStatus, LINK_PRIO };

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
  // Capas de REEMPLAZO ÍNTEGRO (routes/all, heat/all, trails/<id>): no pasan por
  // planFlush — su firma de dedupe (snr|src) es constante para un array y las
  // dejaría congeladas 10 min, matando el tiempo real del WS. Van aparte con
  // firma por contenido.
  let layers = {};
  const layerSig = {};
  const lastLink = {};                // último enlace publicado por clave (memoria entre lotes)
  const counters = newCounters();
  const reg = newRegistry();          // prefijo de pubkey (1-3 bytes) → pubkey, para los paths
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
      try { processMeshCorePacket(topic, raw, buf, counters, reg, lastLink); } catch (e) {}
    });
  }
  connect();

  setInterval(async () => {
    const now = Date.now();
    const batch = buf; buf = {};
    const lay = layers; layers = {};
    const { body, changed } = planFlush(batch, st, now);
    // capas: dedupe por CONTENIDO (claves disjuntas de las de planFlush)
    let layChanged = 0;
    for (const k in lay) {
      const sig = JSON.stringify(lay[k]);
      if (sig !== layerSig[k]) { layerSig[k] = sig; body[k] = lay[k]; st.sent[k] = now; layChanged++; }
    }
    // memoria de enlaces para que una medición con SNR no la pise una fuente menor
    for (const k in batch) if (k.startsWith("links/")) lastLink[k] = batch[k];
    body["meta/stats"] = { seen: counters.seen, adverts: counters.adverts, undecoded: counters.undecoded, obsLinks: counters.obsLinks, pathLinks: counters.pathLinks, truncPath: counters.truncPath, statusMsgs: counters.statusMsgs, badPos: counters.badPos, apiNodes: counters.apiNodes || 0, apiLinks: counters.apiLinks || 0, peerLinks: counters.peerLinks || 0, wsEvents: counters.wsEvents || 0, wsUp: counters.wsUp ? 1 : 0, wsLast: counters.wsLast || 0, apiErr: counters.apiErr || null, apiT: counters.apiT || 0, winSec: counters.winSec || 0, act: counters.act, byType: counters.byType, topics: topicCounts, proto: "meshcore", t: now };
    await pushMulti(body);
    if (changed || layChanged) console.log(`flush: ${changed} cambios + ${layChanged} capas | vistos ${counters.seen} | adverts ${counters.adverts} | obs ${counters.obsLinks} | path ${counters.pathLinks} | api ${counters.apiNodes || 0}n/${counters.apiLinks || 0}e | peers ${counters.peerLinks || 0} | ws ${counters.wsEvents || 0}`);
  }, 5000);

  // Censo desde el API del mapa MSC: siembra nodos+enlaces cada MC_API_MIN min.
  // MC_API="" u "off" lo desactiva; default el mapa de MeshChile.
  const API = (process.env.MC_API !== undefined ? process.env.MC_API : "https://mapa-msc.meshchile.cl").trim();
  if (API && API !== "off" && API !== "0") {
    // fetch con diagnóstico: un 4xx/5xx del mapa ya no se traga en silencio
    const MC_TOKEN = (process.env.MC_TOKEN || "").trim();
    const authHdr = MC_TOKEN ? { Authorization: `Bearer ${MC_TOKEN}` } : {};
    const apiGet = async (url, tag, ms = 30000) => {
      try {
        const r = await fetch(url, { headers: authHdr, signal: AbortSignal.timeout(ms) });
        if (!r.ok) { counters.apiErr = `${tag} HTTP ${r.status}`; console.error(`api ${tag} HTTP ${r.status}${r.status === 401 ? " — el mapa exige token: setea MC_TOKEN" : ""}`); return null; }
        return await r.json();
      } catch (e) {
        counters.apiErr = `${tag} ${e.name === "TimeoutError" ? "timeout" : e.message || "neterr"}`;
        console.error(`api ${tag} fail`, e.message);
        return null;
      }
    };
    // ingesta común: nodos/enlaces al buffer normal, capas al buffer de capas
    const ingest = (j, tag) => {
      const now = Date.now();
      const { nodes, links, extra, winSec } = mapSnapshot(j, now, PURGE_MS);
      putNodes(buf, nodes);
      putLinks(buf, links, lastLink);
      Object.assign(layers, extra);
      if (winSec) counters.winSec = winSec;
      for (const k in nodes) if (nodes[k].pub) regAdd(reg, nodes[k].pub);
      if (tag === "censo") {
        counters.apiNodes = Object.keys(nodes).length;
        counters.apiLinks = Object.keys(links).length;
        counters.apiT = now; counters.apiErr = null;
        censusIds = Object.values(nodes).map((n) => n.pub).filter(Boolean);
      }
      return { nodes, links, extra };
    };
    const pollApi = async () => {
      let j = await apiGet(API + "/snapshot", "snapshot");
      if (!j) j = await apiGet(API + "/api/nodes", "censo");
      if (!j) return;
      const { extra } = ingest(j, "censo");
      const xs = Object.keys(extra).map((k) => k.split("/")[0]).filter((v, i, a) => a.indexOf(v) === i).join(",");
      console.log(`censo API: ${counters.apiNodes} nodos, ${counters.apiLinks} enlaces de ruta${xs ? " · capas: " + xs : ""}`);
    };
    setInterval(pollApi, Math.max(1, +(process.env.MC_API_MIN || 5)) * 60 * 1000);
    pollApi();

    // /peers/{id}: adyacencia dirigida con volumen. Ventana deslizante (rota por
    // todo el censo, no siempre los mismos 60), guarda de reentrada y deadline
    // para que una pasada lenta jamás se solape con la siguiente.
    const PEERS_MIN = Math.max(0, +(process.env.MC_PEERS_MIN || 10));
    if (PEERS_MIN > 0) {
      const PEERS_MS = PEERS_MIN * 60 * 1000;
      const PEERS_N = Math.max(1, +(process.env.MC_PEERS_N || 60));
      let peersRunning = false, peersCursor = 0;
      const pollPeers = async () => {
        if (peersRunning) { console.log("peers: pasada anterior en curso, salto este tick"); return; }
        const ids = censusIds.slice();
        if (!ids.length) return;
        peersRunning = true;
        const deadline = Date.now() + PEERS_MS * 0.8;
        let added = 0, done = 0, errs = 0;
        try {
          if (peersCursor >= ids.length) peersCursor = 0;
          const n = Math.min(PEERS_N, ids.length);
          for (let k = 0; k < n; k++) {
            if (Date.now() > deadline) break;
            const pub = ids[(peersCursor + k) % ids.length];
            done = k + 1;
            try {
              const r = await fetch(`${API}/peers/${pub.toUpperCase()}?limit=10`, { headers: authHdr, signal: AbortSignal.timeout(15000) });
              if (r.ok) {
                const links = mapPeers(nid(pub), await r.json(), Date.now());
                putLinks(buf, links, lastLink);
                added += Object.keys(links).length;
              } else errs++;
            } catch (e) { errs++; }
            await new Promise((res) => setTimeout(res, 400));
          }
          peersCursor = (peersCursor + done) % ids.length;
        } finally { peersRunning = false; }
        counters.peerLinks = added;
        if (added || errs) console.log(`peers API: ${added} enlaces dirigidos (${done}/${ids.length} nodos${errs ? `, ${errs} fallos` : ""})`);
      };
      setInterval(pollPeers, PEERS_MS);
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
        // caché de la última entrada del censo: los eventos incrementales
        // (history_edges) necesitan las posiciones para resolver los extremos
        let lastDevs = {}, lastTrails = {};
        const WS_IDLE = Math.max(0, +(process.env.MC_WS_IDLE || 600)) * 1000;   // 0 = watchdog off
        const WS_MIN = 15000, WS_MAX = 5 * 60 * 1000;
        let wsBackoff = WS_MIN, wsFails = 0;
        const pushRoutes = () => {
          const { extra } = mapSnapshot({ routes: recentRoutes }, Date.now(), PURGE_MS);
          if (extra["routes/all"]) layers["routes/all"] = extra["routes/all"];
        };
        const connectWs = () => {
          const sock = new WSImpl(WS_URL, { handshakeTimeout: 20000 });
          let hb = null, last = Date.now(), got = 0, closed = false;
          const stop = () => { if (hb) { clearInterval(hb); hb = null; } };
          sock.on("open", () => {
            console.log("WS del mapa conectado — datos en tiempo real");
            counters.wsUp = 1; last = Date.now();
            // el heartbeat se arma DENTRO de open: ws lanza si se pinga en CONNECTING
            if (WS_IDLE) hb = setInterval(() => {
              if (Date.now() - last > WS_IDLE) { console.error(`ws mapa mudo ${Math.round(WS_IDLE / 1000)}s — forzando reconexión`); try { sock.terminate(); } catch (e) {} return; }
              try { sock.ping(); } catch (e) {}
            }, Math.max(30000, WS_IDLE / 4));
          });
          sock.on("ping", () => { last = Date.now(); });
          sock.on("pong", () => { last = Date.now(); });
          sock.on("message", (data) => {
            last = Date.now(); got++;
            counters.wsEvents = (counters.wsEvents || 0) + 1;
            counters.wsLast = last;
            let j; try { j = JSON.parse(data.toString()); } catch (e) { return; }
            if (j.type === "snapshot") {
              // ordena por fecha ANTES de recortar: si no, un mapa con >40 rutas
              // vivas nos dejaría con las más viejas
              if (Array.isArray(j.routes)) recentRoutes = j.routes.slice().sort((x, y) => (num(y.ts) || 0) - (num(x.ts) || 0)).slice(0, 40);
              lastDevs = {};
              const dv = j.devices && !Array.isArray(j.devices) ? Object.values(j.devices) : Array.isArray(j.devices) ? j.devices : [];
              for (const d of dv) { const k = String((d && (d.device_id || d.public_key)) || "").toLowerCase(); if (k) lastDevs[k] = d; }
              lastTrails = j.trails && typeof j.trails === "object" ? j.trails : {};
              ingest(j, "snapshot");
              // el snapshot también trae rutas con point_ids/snr_values
              for (const r of recentRoutes) { const rl = mapRouteLinks(r, Date.now()); if (Object.keys(rl).length) putLinks(buf, rl, lastLink); }
            } else if (j.type === "update" && j.device) {
              const mini = { devices: [j.device] };
              const devId = String(j.device.device_id || j.device.public_key || "").toLowerCase();
              if (devId) lastDevs[devId] = j.device;
              if (devId && Array.isArray(j.trail) && j.trail.length >= 2) { mini.trails = { [devId]: j.trail }; lastTrails[devId] = j.trail; }
              ingest(mini, "update");
            } else if (j.type === "route" && j.route) {
              recentRoutes.unshift(j.route);
              recentRoutes = recentRoutes.slice(0, 40);
              pushRoutes();
              // adyacencia por identidad + SNR real de los TRACE
              const rl = mapRouteLinks(j.route, Date.now());
              const withSnr = Object.values(rl).filter((x) => x.snr != null).length;
              if (Object.keys(rl).length) {
                putLinks(buf, rl, lastLink);
                counters.pathLinks = (counters.pathLinks || 0) + Object.keys(rl).length;
                if (withSnr) counters.snrLinks = (counters.snrLinks || 0) + withSnr;
              }
            } else if (j.type === "history_edges" && Array.isArray(j.edges)) {
              // el mapa empuja cada arista al registrarla: no esperamos los 5 min
              const { links } = mapSnapshot({ devices: Object.values(lastDevs), trails: lastTrails, history_edges: j.edges }, Date.now(), PURGE_MS);
              putLinks(buf, links, lastLink);
            } else if (j.type === "history_edges_remove" && Array.isArray(j.edge_ids)) {
              counters.edgeRemove = (counters.edgeRemove || 0) + j.edge_ids.length;
            } else if (j.type === "stale" && Array.isArray(j.device_ids)) {
              // el mapa retiró esos nodos: bórralos también acá (si no, quedan
              // fantasmas hasta que los alcance la purga de 24 h)
              for (const raw of j.device_ids) {
                const id = nid(String(raw).toLowerCase());
                if (!id) continue;
                buf[`nodes/${id}`] = null;
                delete st.nodeFields[id]; delete st.nodeSig[id];
                if (layerSig[`trails/${id}`] != null) { layers[`trails/${id}`] = null; delete layerSig[`trails/${id}`]; }
              }
              counters.wsStale = (counters.wsStale || 0) + (j.device_ids.length || 0);
            }
          });
          sock.on("error", (e) => console.error("ws mapa err", e.message));
          sock.on("close", (code, reason) => {
            if (closed) return; closed = true;
            stop(); counters.wsUp = 0;
            // el backoff solo se reinicia si la sesión SIRVIÓ (llegó ≥1 mensaje):
            // un cierre 1008 dispara 'open' igual y si no, nunca frenaríamos
            if (got > 0) { wsBackoff = WS_MIN; wsFails = 0; } else { wsFails++; wsBackoff = Math.min(WS_MAX, wsBackoff * 2); }
            const why = `code=${code}${reason && reason.length ? " " + reason.toString().slice(0, 80) : ""}`;
            if (code === 1008) console.error(`ws mapa RECHAZADO (${why}) — el mapa exige token: pon MC_WS con ?token=… o MC_TOKEN`);
            else if (wsFails >= 3) console.error(`ws mapa cerrado (${why}) · ${wsFails} intentos fallidos seguidos`);
            else console.log(`ws mapa cerrado (${why}); reintento en ${Math.round(wsBackoff / 1000)}s`);
            setTimeout(connectWs, wsBackoff);
          });
        };
        connectWs();
      }
    }
  }

  // shallow=true trae SOLO las claves: sin eso la purga se bajaría todas las
  // estelas enteras cada PURGE_MIN, que es justo el coste que queremos evitar.
  const getKeys = (path) => fetch(`${RTDB}/mc/${path}.json?shallow=true&auth=${SECRET}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  setInterval(async () => {
    try {
      const [nodes, links, trailKeys] = await Promise.all([getJson("nodes"), getJson("links"), getKeys("trails")]);
      const { del, dn, dl, dt } = planPurge(nodes, links, Date.now() - PURGE_MS, st, trailKeys);
      for (const k in del) if (k.startsWith("trails/")) delete layerSig[k];
      if (Object.keys(del).length) { await pushMulti(del); console.log(`purge: -${dn} nodos, -${dl} enlaces, -${dt || 0} estelas (TTL ${PURGE_HOURS}h)`); }
    } catch (e) { console.error("purge fail", e.message); }
  }, PURGE_INTERVAL_MS);

  console.log(`meshcore-bridge iniciado · broker ${BROKER} · TTL ${PURGE_HOURS}h`);
}
