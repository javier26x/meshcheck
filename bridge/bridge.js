/* ============================================================================
 * mesh-bridge — cosecha del MQTT de MeshChile hacia Firebase RTDB. Persistente
 * (VPS + PM2). Requiere Node 18+.
 *
 * Env:
 *   RTDB_URL, FB_SECRET     obligatorios (database secret; salta las reglas)
 *   CHANNEL_KEY             opcional (PSK base64; default = LongFast pública)
 *   PURGE_HOURS             opcional (default 24) — borra nodos/links más viejos
 *   PURGE_MIN              opcional (default 30) — cada cuántos min purga
 *
 * Eficiencia:
 *   - Escritura MULTI-PATH: un solo PATCH por flush (no uno por clave).
 *   - DEDUPE: solo escribe lo que cambió; refresca `t` cada REFRESH_* min para
 *     mantener "vivo" sin martillar la RTDB ni disparar re-descargas.
 *   - PURGA TTL: borra periódicamente lo viejo → la base no crece sin límite.
 *
 * Escribe:  /nodes/<id>  /links/<id>/nb/<vec>  /meta/stats
 * (planFlush / planPurge son puras y testeables; el runtime va bajo require.main)
 * ========================================================================== */
const meshtastic = require("./meshtastic");

const REFRESH_NODE_MS = 5 * 60 * 1000;   // refresca t de un nodo sin cambios cada 5 min
const REFRESH_LINK_MS = 10 * 60 * 1000;  // idem enlace cada 10 min
const BCAST = 4294967295;
// RTDB prohíbe . $ # [ ] / en claves → se sanean con "|"
const safeKey = (s) => String(s).replace(/[.#$\[\]]/g, "_").replace(/\//g, "|").slice(0, 80) || "_";

function newState() { return { nodeFields: {}, nodeSig: {}, linkSig: {}, sent: {} }; }

/* --- Procesamiento de un paquete (JSON o descifrado) hacia buf --------------- */
// Coordenada plausible: en rango y lejos del (0,0) (GPS basura reporta ~0,0).
const validLL = (lat, lon) => isFinite(lat) && isFinite(lon) &&
  Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(Math.abs(lat) < 0.5 && Math.abs(lon) < 0.5);
function extractLatLon(p) {
  if (!p) return null;
  const latI = p.latitude_i ?? p.lat_i, lonI = p.longitude_i ?? p.long_i;
  if (typeof latI === "number" && typeof lonI === "number" && validLL(latI / 1e7, lonI / 1e7)) return { lat: latI / 1e7, lon: lonI / 1e7 };
  if (typeof p.latitude === "number" && typeof p.longitude === "number" && validLL(p.latitude, p.longitude)) return { lat: p.latitude, lon: p.longitude };
  return null;
}
function nameOf(p) { const pl = p.payload || {}; return pl.longname || pl.long_name || pl.name || pl.shortname || pl.short_name || null; }

// Escribe en `buf` (y actualiza counters); pura respecto de esos args.
function processPacket(p, buf, counters) {
  if (p.from == null) return;
  const upsert = (from, fields) => { const k = `nodes/${from}`; buf[k] = Object.assign({ id: from }, buf[k] || {}, fields, { t: Date.now() }); };
  try {
    const type = safeKey(p.type || "?");
    counters.seenTypes[type] = (counters.seenTypes[type] || 0) + 1;
    if (p.sender != null) counters.fieldCounts.sender++;
    if (p.hops_away != null) counters.fieldCounts.hops_away++;
    if (p.hop_start != null) counters.fieldCounts.hop_start++;
    const pl = p.payload || {};

    const ll = extractLatLon(pl);
    if (ll) {
      const f = { lat: ll.lat, lon: ll.lon };
      if (typeof pl.altitude === "number") f.alt = Math.round(pl.altitude);
      const nm = nameOf(p); if (nm) f.name = nm;
      if (pl.role !== undefined) f.role = pl.role;
      if (!f.name && !(buf[`nodes/${p.from}`] || {}).name) f.name = String(p.from);
      upsert(p.from, f);
    }
    if (type === "nodeinfo") {
      const f = {};
      const nm = nameOf(p); if (nm) f.name = nm;
      const sn = pl.shortname || pl.short_name; if (sn) f.sn = sn;
      if (pl.role !== undefined) f.role = pl.role;
      if (pl.hardware !== undefined) f.hw = pl.hardware;
      if (Object.keys(f).length) upsert(p.from, f);
    }
    if (type === "telemetry") {
      const f = {};
      if (pl.battery_level != null) f.batt = Math.round(pl.battery_level);
      if (pl.voltage != null) f.volt = Math.round(pl.voltage * 100) / 100;
      if (pl.temperature != null) f.temp = Math.round(pl.temperature * 10) / 10;
      if (pl.channel_utilization != null) f.chUtil = Math.round(pl.channel_utilization * 10) / 10;
      upsert(p.from, f);
    }
    if (type === "text" || type === "waypoint") upsert(p.from, {});

    if (type === "neighborinfo" && Array.isArray(pl.neighbors)) {
      for (const n of pl.neighbors) { const nid = n.node_id ?? n.nodeId ?? n.id; if (nid == null) continue; buf[`links/${p.from}/nb/${nid}`] = { snr: n.snr ?? null, t: Date.now(), src: "ni" }; }
    }
    if (type === "traceroute" && Array.isArray(pl.route)) {
      const chain = [p.from, ...pl.route.map(Number), p.to].filter((x) => Number.isFinite(x) && x !== BCAST && x > 0);
      for (let i = 0; i < chain.length - 1; i++) { const a = chain[i], b = chain[i + 1]; if (a === b) continue; buf[`links/${a}/nb/${b}`] = { snr: null, t: Date.now(), src: "tr" }; }
    }
    const direct = p.hops_away === 0 || (p.hops_away == null && p.hop_start != null && p.hop_limit != null && p.hop_start === p.hop_limit);
    if (direct) counters.fieldCounts.direct++;
    if (direct && typeof p.sender === "string" && p.sender.startsWith("!")) {
      const gw = parseInt(p.sender.slice(1), 16);
      if (Number.isFinite(gw) && gw !== p.from) { buf[`links/${gw}/nb/${p.from}`] = { snr: p.snr ?? null, t: Date.now(), src: "gw" }; counters.gwLinks++; }
    }
  } catch (e) { /* payload raro: ignorar */ }
}

/* --- DEDUPE: arma el cuerpo del multi-PATCH a partir del buffer -------------- */
// Devuelve { body, changed }. Muta st (nodeFields/nodeSig/linkSig/sent).
function planFlush(batch, st, now) {
  const body = {};
  let changed = 0;
  for (const k of Object.keys(batch)) {
    const val = batch[k];
    if (k.startsWith("nodes/")) {
      const id = k.slice(6);
      const { t, ...f } = val;
      const merged = Object.assign({}, st.nodeFields[id], f);
      const sig = JSON.stringify(merged);
      if (sig !== st.nodeSig[id]) {
        // cambió → escribe el OBJETO COMPLETO (el multi-PATCH reemplaza esa ruta,
        // no puede ser un delta o perdería campos como el nombre)
        st.nodeFields[id] = merged; st.nodeSig[id] = sig;
        body[k] = Object.assign({}, merged, { t: now }); st.sent[k] = now; changed++;
      } else if (now - (st.sent[k] || 0) > REFRESH_NODE_MS) {
        body[`nodes/${id}/t`] = now; st.sent[k] = now;   // refresca solo el leaf t
      }
    } else { // links/<from>/nb/<vec> — el leaf ES el valor completo
      // `n` (volumen) entra en la firma: si no, pasar de 5 a 500 paquetes no se
      // detecta y el grosor de la línea queda congelado hasta el refresco.
      const sig = (val.snr == null ? "x" : Math.round(val.snr)) + "|" + (val.src || "") + "|" + (val.n || 0);
      if (sig !== st.linkSig[k]) { st.linkSig[k] = sig; body[k] = val; st.sent[k] = now; changed++; }
      else if (now - (st.sent[k] || 0) > REFRESH_LINK_MS) { body[k] = val; st.sent[k] = now; }
    }
  }
  return { body, changed };
}

/* --- PURGA: arma el cuerpo de borrado (nulls) de lo más viejo que cutoff ----- */
// Devuelve { del, dn, dl }. Muta st para olvidar lo purgado.
// planPurge(nodes, links, cutoff, st, trailKeys?) — trailKeys es el listado
// shallow de /mc/trails (solo claves): las estelas viven mientras viva su nodo.
function planPurge(nodes, links, cutoff, st, trailKeys) {
  const del = {};
  let dn = 0, dl = 0, dt = 0;
  const forget = (path) => { delete st.linkSig[path]; delete st.sent[path]; };
  if (nodes) for (const id in nodes) {
    const t = nodes[id] && nodes[id].t;
    if (!t || t < cutoff) { del[`nodes/${id}`] = null; delete st.nodeFields[id]; delete st.nodeSig[id]; delete st.sent[`nodes/${id}`]; dn++; }
  }
  if (links) for (const from in links) {
    const nb = links[from] && links[from].nb;
    if (!nb) { del[`links/${from}`] = null; dl++; continue; }
    const fresh = Object.keys(nb).some((k) => nb[k] && nb[k].t && nb[k].t >= cutoff);
    if (!fresh) { del[`links/${from}`] = null; for (const k in nb) forget(`links/${from}/nb/${k}`); dl++; continue; }
    for (const k in nb) if (!nb[k].t || nb[k].t < cutoff) { del[`links/${from}/nb/${k}`] = null; forget(`links/${from}/nb/${k}`); dl++; }
  }
  // Estelas huérfanas. Solo se tocan si TENEMOS el censo de nodos: si el GET de
  // /nodes falló (null) no borramos nada, o un 5xx pasajero se llevaría todas.
  if (trailKeys && nodes && typeof nodes === "object") {
    for (const id in trailKeys) {
      if (nodes[id] && !(`nodes/${id}` in del)) continue;    // su nodo sigue vivo
      del[`trails/${id}`] = null; forget(`trails/${id}`); dt++;
    }
  }
  return { del, dn, dl, dt };
}

module.exports = { planFlush, planPurge, processPacket, extractLatLon, nameOf, safeKey, newState, validLL, REFRESH_NODE_MS, REFRESH_LINK_MS };

/* ============================ RUNTIME (solo si se ejecuta directo) =========== */
if (require.main === module) {
  const mqtt = require("mqtt");
  const RTDB = process.env.RTDB_URL, SECRET = process.env.FB_SECRET;
  const KEY = meshtastic.decodeKey(process.env.CHANNEL_KEY);
  const PURGE_HOURS = +(process.env.PURGE_HOURS || 24);
  const PURGE_MS = PURGE_HOURS * 3600 * 1000;
  const PURGE_INTERVAL_MS = +(process.env.PURGE_MIN || 30) * 60 * 1000;
  if (!RTDB || !SECRET) { console.error("Falta RTDB_URL o FB_SECRET. Revisa ecosystem.config.js."); process.exit(1); }

  const pushMulti = async (body) => {
    try {
      const r = await fetch(`${RTDB}/.json?auth=${SECRET}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) console.error("push", r.status, await r.text().catch(() => ""));
    } catch (e) { console.error("push fail", e.message); }
  };
  const getJson = (path) => fetch(`${RTDB}/${path}.json?auth=${SECRET}`).then((r) => r.ok ? r.json() : null).catch(() => null);

  const st = newState();
  let buf = {};
  const counters = { seenTypes: {}, fieldCounts: { sender: 0, hops_away: 0, hop_start: 0, direct: 0, enc: 0, encOk: 0, encFail: 0 }, gwLinks: 0 };
  const topicCounts = {}, chanStats = {};
  let sampled = 0;

  const client = mqtt.connect("mqtt://mqtt.meshchile.cl:1883", { username: "mshcl2025", password: "meshtastic.cl", reconnectPeriod: 5000 });
  client.on("connect", () => { console.log("MQTT ok"); client.subscribe("msh/CL/#", (e) => e && console.error("subscribe err", e.message)); });
  client.on("reconnect", () => console.log("reconnecting…"));
  client.on("error", (e) => console.error("mqtt err", e.message));
  client.on("message", (topic, raw) => {
    const tkey = safeKey(topic.split("/").slice(0, 5).join("/"));
    if (topicCounts[tkey] != null || Object.keys(topicCounts).length < 40) topicCounts[tkey] = (topicCounts[tkey] || 0) + 1;
    if (topic.includes("/json/")) {
      try { const p = JSON.parse(raw.toString()); if (sampled < 3) { sampled++; console.log(`muestra json ${sampled} [${topic}]:`, raw.toString().slice(0, 300)); } processPacket(p, buf, counters); } catch (e) {}
    } else if (topic.includes("/e/")) {
      const chan = safeKey(topic.split("/")[4] || "?");
      const cs = chanStats[chan] || (chanStats[chan] = { n: 0, ok: 0 });
      cs.n++; counters.fieldCounts.enc++;
      try {
        const dec = meshtastic.decodeEnvelope(raw, KEY);
        if (!dec || !dec.type) { counters.fieldCounts.encFail++; return; }
        counters.fieldCounts.encOk++; cs.ok++;
        const hopsAway = (dec.hopStart != null && dec.hopLimit != null) ? dec.hopStart - dec.hopLimit : null;
        processPacket({ type: dec.type, from: dec.from, to: dec.to, payload: dec.payload, snr: dec.rxSnr, hop_start: dec.hopStart, hop_limit: dec.hopLimit, hops_away: hopsAway, sender: dec.gatewayId }, buf, counters);
      } catch (e) { counters.fieldCounts.encFail++; }
    }
  });

  setInterval(async () => {
    const now = Date.now();
    const batch = buf; buf = {};
    const { body, changed } = planFlush(batch, st, now);
    body["meta/stats"] = { types: counters.seenTypes, topics: topicCounts, fields: counters.fieldCounts, chan: chanStats, gwLinks: counters.gwLinks, t: now };
    await pushMulti(body);
    const mix = Object.entries(counters.seenTypes).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join(" ");
    console.log(`flush: ${changed} cambios de ${Object.keys(batch).length} | descifrados ${counters.fieldCounts.encOk}/${counters.fieldCounts.enc} | gw-links ${counters.gwLinks} | ${mix || "sin tráfico"}`);
  }, 5000);

  setInterval(async () => {
    try {
      const [nodes, links] = await Promise.all([getJson("nodes"), getJson("links")]);
      const { del, dn, dl } = planPurge(nodes, links, Date.now() - PURGE_MS, st);
      if (Object.keys(del).length) { await pushMulti(del); console.log(`purge: -${dn} nodos, -${dl} enlaces (TTL ${PURGE_HOURS}h)`); }
    } catch (e) { console.error("purge fail", e.message); }
  }, PURGE_INTERVAL_MS);

  console.log(`mesh-bridge iniciado (msh/CL/#) · descifrado ${KEY ? "ON " + KEY.length * 8 + "bits" : "OFF"} · TTL ${PURGE_HOURS}h`);
}
