/* Prueba meshcore.js: construye un paquete ADVERT real y verifica que
 * decodePacketHex saca pubkey/nombre/lat/lon; además comprueba que el JWT
 * firmado se valida con la pubkey (Ed25519) — o sea, el broker lo aceptaría. */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const MC = require("../bridge/meshcore.js");

// --- construye un paquete MeshCore desde sus partes ---
const ROUTE = MC.ROUTE;
function mkHeader(routeType, payloadType, version = 0) { return routeType | (payloadType << 2) | (version << 6); }
// appdata del ADVERT: flags(1) [latlon 8] [feat1 2] [feat2 2] [name]
function mkAppData({ type = 2, lat, lon, name }) {
  let flags = type & 0x0f;
  const parts = [];
  if (lat != null) { flags |= 0x10; const b = Buffer.alloc(8); b.writeInt32LE(Math.round(lat * 1e6), 0); b.writeInt32LE(Math.round(lon * 1e6), 4); parts.push(b); }
  if (name != null) { flags |= 0x80; }
  const head = Buffer.from([flags]);
  const nameBuf = name != null ? Buffer.from(name, "utf8") : Buffer.alloc(0);
  return Buffer.concat([head, ...parts, nameBuf]);
}
function mkAdvertPacket({ pubkey, advTime = 1700000000, sig, app, routeType = ROUTE.FLOOD, path = Buffer.alloc(0) }) {
  const payload = Buffer.concat([pubkey, u32le(advTime), sig, app]);
  const header = Buffer.from([mkHeader(routeType, MC.PT_ADVERT)]);
  const transport = (routeType === ROUTE.TRANSPORT_FLOOD || routeType === ROUTE.TRANSPORT_DIRECT) ? Buffer.alloc(4) : Buffer.alloc(0);
  // path_len byte: bph=1 (2 bits altos = 0), hop = path.length
  const pathLen = Buffer.from([path.length & 0x3f]);
  return Buffer.concat([header, transport, pathLen, path, payload]).toString("hex");
}
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

test("makeIdentity: semilla ⇒ pubkey Ed25519 determinística", () => {
  const seed = "11".repeat(32);
  const id1 = MC.makeIdentity(seed), id2 = MC.makeIdentity(seed);
  assert.equal(id1.pubHex, id2.pubHex);
  assert.equal(id1.pubHex.length, 64);          // 32 bytes en hex
  assert.notEqual(MC.makeIdentity().pubHex, id1.pubHex); // aleatoria ≠ fija
});

test("buildAuthToken: la firma la valida la pubkey (broker lo aceptaría)", () => {
  const id = MC.makeIdentity("22".repeat(32));
  const { username, password, exp } = MC.buildAuthToken(id, "mqtt-msc.meshchile.cl", 3600, 1700000000);
  assert.equal(username, "v1_" + id.pubHex.toUpperCase());
  assert.equal(exp, 1700000000 + 3600);
  const [h, p, sigHex] = password.split(".");
  const signingInput = h + "." + p;
  // reconstruye la clave pública SPKI cruda y verifica la firma Ed25519
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(id.pubHex, "hex")]);
  const pub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const ok = crypto.verify(null, Buffer.from(signingInput, "utf8"), pub, Buffer.from(sigHex, "hex"));
  assert.ok(ok, "la firma debe verificar contra la pubkey");
  // el payload declara la misma pubkey en HEX mayúscula
  const claims = JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  assert.equal(claims.publicKey, id.pubHex.toUpperCase());
  assert.equal(claims.aud, "mqtt-msc.meshchile.cl");
});

test("decodePacketHex: ADVERT con lat/lon/nombre de un Repeater", () => {
  const pubkey = Buffer.from("ab".repeat(32), "hex");
  const sig = Buffer.from("cd".repeat(64), "hex");
  const app = mkAppData({ type: 2, lat: -33.4489, lon: -70.6693, name: "Cerro San Cristóbal" });
  const hex = mkAdvertPacket({ pubkey, sig, app });
  const d = MC.decodePacketHex(hex);
  assert.ok(d, "debe decodificar");
  assert.equal(d.payloadType, MC.PT_ADVERT);
  assert.equal(d.advert.pubkey, "ab".repeat(32));
  assert.equal(d.advert.mode, "Repeater");
  assert.equal(Math.round(d.advert.lat * 1e4), -334489);
  assert.equal(Math.round(d.advert.lon * 1e4), -706693);
  assert.equal(d.advert.name, "Cerro San Cristóbal");
});

test("decodePacketHex: ADVERT sin GPS (solo nombre)", () => {
  const app = mkAppData({ type: 1, name: "Companion X" });
  const hex = mkAdvertPacket({ pubkey: Buffer.from("01".repeat(32), "hex"), sig: Buffer.alloc(64), app });
  const d = MC.decodePacketHex(hex);
  assert.equal(d.advert.mode, "Companion");
  assert.equal(d.advert.name, "Companion X");
  assert.equal(d.advert.lat, undefined);
});

test("decodePacketHex: ruta TRANSPORT_FLOOD salta los 4 bytes de transporte", () => {
  const app = mkAppData({ type: 2, lat: -20, lon: -70, name: "R" });
  const hex = mkAdvertPacket({ pubkey: Buffer.from("02".repeat(32), "hex"), sig: Buffer.alloc(64), app, routeType: ROUTE.TRANSPORT_FLOOD });
  const d = MC.decodePacketHex(hex);
  assert.equal(d.routeType, ROUTE.TRANSPORT_FLOOD);
  assert.equal(d.advert.name, "R");
  assert.equal(Math.round(d.advert.lat), -20);
});

test("decodePacketHex: path presente se salta correctamente y se devuelve", () => {
  const app = mkAppData({ type: 2, name: "H" });
  const path = Buffer.from([0xaa, 0xbb, 0xcc]);   // 3 hops, 1 byte c/u
  const hex = mkAdvertPacket({ pubkey: Buffer.from("03".repeat(32), "hex"), sig: Buffer.alloc(64), app, path });
  const d = MC.decodePacketHex(hex);
  assert.equal(d.advert.name, "H");
  assert.equal(d.advert.pubkey, "03".repeat(32));
  assert.deepEqual(d.path, ["aa", "bb", "cc"]);
});

test("decodePacketHex: basura ⇒ null (no explota)", () => {
  assert.equal(MC.decodePacketHex("zz"), null);
  assert.equal(MC.decodePacketHex(""), null);
  assert.equal(MC.decodePacketHex("11"), null);       // header sin más bytes
});

// --- procesamiento del bridge (advert → nodo + enlace observador) ---
const BR = require("../bridge/meshcore-bridge.js");

test("extractPacket: JSON {raw_hex,snr}, hex pelado y bytes crudos", () => {
  const a = BR.extractPacket(Buffer.from(JSON.stringify({ raw_hex: "0xAABB", snr: 5.5, rssi: -80 })));
  assert.equal(a.hex, "AABB"); assert.equal(a.snr, 5.5); assert.equal(a.rssi, -80);
  const b = BR.extractPacket(Buffer.from("deadbeef"));
  assert.equal(b.hex, "deadbeef"); assert.equal(b.snr, null);
  const c = BR.extractPacket(Buffer.from([0x11, 0x22]));
  assert.equal(c.hex, "1122");
});

test("extractPacket: formato real MeshChile {raw,SNR,origin_id} (strings)", () => {
  const msg = JSON.stringify({ type: "PACKET", direction: "rx", raw: "AABBCC", packet_type: "4", route: "F", SNR: "6.25", RSSI: "-91", origin_id: "AB12CD34EF" });
  const r = BR.extractPacket(Buffer.from(msg));
  assert.equal(r.hex, "AABBCC");
  assert.equal(r.snr, 6.25);           // "6.25" (string) → número
  assert.equal(r.rssi, -91);
  assert.equal(r.originId, "ab12cd34ef"); // origin_id en minúsculas
  // SNR "Unknown" → null (no rompe)
  const u = BR.extractPacket(Buffer.from(JSON.stringify({ raw: "00", SNR: "Unknown" })));
  assert.equal(u.snr, null);
});

test("mapSnapshot: /snapshot real (devices dict, edges por coordenadas)", () => {
  const now = 1700000000000;
  const pubA = "aa".repeat(32), pubB = "bb".repeat(32);
  const j = {
    devices: {
      [pubA]: { device_id: pubA.toUpperCase(), name: "Repe LC", role: "repeater", lat: -33.4123, lon: -70.5511, ts: now / 1000 - 300, last_seen_ts: now / 1000 - 60 },
      [pubB]: { device_id: pubB, name: "Room X", device_role: 3, lat: -33.5001, lon: -70.6002, ts: now / 1000 - 120 },
      ["cc".repeat(32)]: { device_id: "cc".repeat(32), name: "SinPos", lat: 0, lon: 0 },      // 0,0 → fuera
      ["dd".repeat(32)]: { device_id: "dd".repeat(32), name: "Viejo", lat: -30, lon: -70, last_seen_ts: now / 1000 - 90000 }, // > maxAge → fuera
    },
    history_edges: [
      { id: "e1", a: [-33.4123, -70.5511], b: [-33.5001, -70.6002], count: 7, last_ts: now / 1000 - 30 },
      { id: "e2", a: [-33.4123, -70.5511], b: [-30, -70], count: 1, last_ts: now / 1000 },    // b (Viejo) fuera del censo → fuera
      { id: "e3", a: [-11, -11], b: [-33.5001, -70.6002], count: 2, last_ts: now / 1000 },    // a no calza con nadie → fuera
    ],
  };
  const { nodes, links } = BR.mapSnapshot(j, now, 24 * 3600 * 1000);
  assert.equal(Object.keys(nodes).length, 2);
  const a = nodes["nodes/" + pubA];
  assert.equal(a.name, "Repe LC");
  assert.equal(a.mode, "Repeater");
  assert.equal(a.role, "ROUTER");
  assert.equal(a.t, now - 60000);
  assert.equal(nodes["nodes/" + pubB].mode, "RoomServer");
  assert.equal(nodes["nodes/" + pubB].role, "ROUTER");
  assert.equal(Object.keys(links).length, 1);
  const l = links["links/" + pubA + "/nb/" + pubB];
  assert.equal(l.src, "ruta");
  assert.equal(l.t, now - 30000);
});

test("validLL: rechaza fuera de rango y la trampa del (0,0)", () => {
  assert.ok(BR.validLL(-33.45, -70.66));
  assert.ok(BR.validLL(-53.16, -70.91));           // Punta Arenas
  assert.equal(BR.validLL(95, -70), false);         // lat fuera de rango
  assert.equal(BR.validLL(-33, 200), false);        // lon fuera de rango
  assert.equal(BR.validLL(0.001, -0.02), false);    // golfo de Guinea (basura GPS)
  assert.equal(BR.validLL(NaN, -70), false);
});

test("processMeshCorePacket: advert con coordenadas basura ⇒ nodo SIN posición", () => {
  const pubkey = Buffer.from("ab".repeat(32), "hex");
  // lat=500.0 (int32 500e6): dentro del int32, fuera del planeta
  const app = mkAppData({ type: 2, lat: 500, lon: -70, name: "Basura" });
  const hex = mkAdvertPacket({ pubkey, sig: Buffer.alloc(64), app });
  const buf = {}, counters = BR.newCounters();
  BR.processMeshCorePacket("meshcore/SCL/" + "cd".repeat(32) + "/packets", Buffer.from(hex), buf, counters);
  const node = buf["nodes/" + "ab".repeat(32)];
  assert.ok(node, "el nodo existe (nombre/rol sirven)");
  assert.equal(node.lat, undefined, "la posición basura NO se escribe");
  assert.equal(counters.badPos, 1);
});

test("mapSnapshot: descarta censo con coords fuera de rango o ~(0,0)", () => {
  const now = 1700000000000;
  const j = { data: [
    { public_key: "aa".repeat(32), name: "OK", lat: -33.4, lon: -70.6, last_seen_ts: now / 1000 },
    { public_key: "bb".repeat(32), name: "Guinea", lat: 0.0001, lon: -0.003, last_seen_ts: now / 1000 },
    { public_key: "cc".repeat(32), name: "Marte", lat: 120, lon: -70, last_seen_ts: now / 1000 },
  ] };
  const { nodes } = BR.mapSnapshot(j, now, 0);
  assert.equal(Object.keys(nodes).length, 1);
  assert.ok(nodes["nodes/" + "aa".repeat(32)]);
});

test("registro hash→pubkey: resuelve y marca ambiguos", () => {
  const reg = BR.newRegistry();
  const p1 = "aa" + "11".repeat(31), p2 = "bb" + "22".repeat(31), p3 = "aa" + "33".repeat(31);
  BR.regAdd(reg, p1); BR.regAdd(reg, p2);
  assert.equal(reg.h2p["aa"], p1);
  assert.equal(reg.h2p["bb"], p2);
  BR.regAdd(reg, p3);                       // mismo primer byte que p1 → ambiguo
  assert.equal(reg.h2p["aa"], undefined);
  assert.ok(reg.amb["aa"]);
});

test("processMeshCorePacket: path resuelto ⇒ enlaces multi-salto reales", () => {
  const origin = "ee".repeat(32), rep1 = "a1" + "00".repeat(31), rep2 = "b2" + "00".repeat(31), obs = "cd".repeat(32);
  const reg = BR.newRegistry();
  for (const p of [origin, rep1, rep2, obs]) BR.regAdd(reg, p);
  const app = mkAppData({ type: 2, lat: -33.4, lon: -70.6, name: "Origen" });
  const hex = mkAdvertPacket({ pubkey: Buffer.from(origin, "hex"), sig: Buffer.alloc(64), app, path: Buffer.from([0xa1, 0xb2]) });
  const msg = Buffer.from(JSON.stringify({ raw: hex, SNR: "4.5", origin_id: obs }));
  const buf = {}, counters = BR.newCounters();
  BR.processMeshCorePacket("meshcore/SCL/x/packets", msg, buf, counters, reg);
  // cadena: origen → rep1 → rep2 → observador
  assert.ok(buf["links/" + rep1 + "/nb/" + origin], "rep1 oyó al origen");
  assert.ok(buf["links/" + rep2 + "/nb/" + rep1], "rep2 oyó a rep1");
  const last = buf["links/" + obs + "/nb/" + rep2];
  assert.ok(last, "el observador oyó al ÚLTIMO repetidor, no al origen");
  assert.equal(last.snr, 4.5);
  assert.equal(last.src, "tr");
  assert.equal(buf["links/" + obs + "/nb/" + origin], undefined, "NO enlace directo obs→origen (había path)");
  assert.equal(counters.pathLinks, 2);
});

test("processMeshCorePacket: topic /status ⇒ observador online/offline", () => {
  const obs = "ab".repeat(32);
  const buf = {}, counters = BR.newCounters();
  BR.processMeshCorePacket("meshcore/SCL/" + obs.toUpperCase() + "/status",
    Buffer.from(JSON.stringify({ status: "online", origin_id: obs.toUpperCase() })), buf, counters);
  assert.equal(buf["nodes/" + obs].online, true);
  BR.processMeshCorePacket("meshcore/SCL/" + obs.toUpperCase() + "/status",
    Buffer.from(JSON.stringify({ status: "offline", origin_id: obs.toUpperCase() })), buf, counters);
  assert.equal(buf["nodes/" + obs].online, false);
  assert.equal(counters.statusMsgs, 2);
});

test("mapSnapshot: presencia MQTT, telemetría RF, volumen y capas extra", () => {
  const now = 1700000000000;
  const pubA = "aa".repeat(32), pubB = "bb".repeat(32);
  const j = {
    devices: {
      [pubA]: { device_id: pubA, name: "A", lat: -33.41, lon: -70.55, last_seen_ts: now / 1000 - 60, mqtt_seen_ts: now / 1000 - 120, mqtt_online_source: "packets", rssi: -95, snr: 6.5, heading: 270, speed: 42 },
      [pubB]: { device_id: pubB, name: "B", lat: -33.5, lon: -70.6, ts: now / 1000 - 100, mqtt_status_value: "offline", mqtt_status_ts: now / 1000 },
    },
    history_edges: [{ a: [-33.41, -70.55], b: [-33.5, -70.6], count: 12, last_ts: now / 1000 - 30 }],
    routes: [
      { id: "r1", points: [[-33.41, -70.55], [-33.5, -70.6]], ts: now / 1000 - 60, route_mode: "path", sender_name: "A" },
      { id: "viejo", points: [[-33.41, -70.55], [-33.5, -70.6]], ts: now / 1000 - 999999 },
    ],
    trails: { [pubA]: [[-33.41, -70.55, now / 1000 - 300], [-33.42, -70.56, now / 1000]] },
    heat: [[-33.41, -70.55, now / 1000, 0.9], [0.001, 0.002, now / 1000, 1]],
  };
  const { nodes, links, extra } = BR.mapSnapshot(j, now, 24 * 3600 * 1000);
  const a = nodes["nodes/" + pubA];
  assert.equal(a.mqtt, now - 120000);               // presencia MQTT en ms
  assert.equal(a.mqttSrc, "packets");
  assert.equal(a.rssi, -95); assert.equal(a.snr, 6.5);
  assert.equal(a.heading, 270); assert.equal(a.speed, 42);
  assert.equal(nodes["nodes/" + pubB].mqtt, undefined, "status offline NO cuenta como presencia");
  assert.equal(links["links/" + pubA + "/nb/" + pubB].n, 12);
  assert.equal(extra["routes/all"].length, 1, "solo la ruta reciente (la vieja queda fuera)");
  assert.deepEqual(extra["routes/all"][0].p[0], [-33.41, -70.55]);
  assert.equal(extra["trails/all"][pubA].length, 2);
  assert.equal(extra["heat/all"].length, 1, "el punto (0,0) del calor se descarta");
  assert.equal(extra["heat/all"][0][2], 0.9);
});

test("mapPeers: incoming/outgoing → enlaces dirigidos con volumen", () => {
  const now = 1700000000000;
  const me = "aa".repeat(32), p1 = "bb".repeat(32), p2 = "cc".repeat(32);
  const j = {
    incoming: [{ peer_id: p1.toUpperCase(), count: 9, last_seen_ts: now / 1000 - 60 }],
    outgoing: [{ peer_id: p2, count: 3, last_seen_ts: now / 1000 - 30 }],
  };
  const links = BR.mapPeers(me, j, now);
  const inL = links["links/" + me + "/nb/" + p1];
  assert.ok(inL, "incoming: yo oí al peer");
  assert.equal(inL.n, 9);
  assert.equal(inL.src, "peers");
  const outL = links["links/" + p2 + "/nb/" + me];
  assert.ok(outL, "outgoing: el peer me oyó");
  assert.equal(outL.n, 3);
});

test("mapSnapshot: forma /api/nodes ({data:[...]})", () => {
  const now = 1700000000000;
  const j = { data: [{ public_key: "ee".repeat(32), name: "N1", device_role: 1, location: { latitude: -36.8, longitude: -73.0 }, last_seen_ts: now / 1000 }] };
  const { nodes, links } = BR.mapSnapshot(j, now, 0);
  const n = nodes["nodes/" + "ee".repeat(32)];
  assert.equal(n.mode, "Companion");
  assert.equal(Math.round(n.lat * 10), -368);
  assert.equal(Object.keys(links).length, 0);
});

test("processMeshCorePacket: usa origin_id del payload como observador", () => {
  const pubkey = Buffer.from("ab".repeat(32), "hex");
  const app = mkAppData({ type: 2, lat: -30, lon: -71, name: "R2" });
  const hex = mkAdvertPacket({ pubkey, sig: Buffer.alloc(64), app });
  const originId = "ff".repeat(32);
  // topic sin pubkey; el observador debe salir del origin_id del payload
  const msg = Buffer.from(JSON.stringify({ raw: hex, SNR: "3.5", origin_id: originId.toUpperCase() }));
  const buf = {}, counters = BR.newCounters();
  BR.processMeshCorePacket("meshcore/SCL/x/packets", msg, buf, counters);
  assert.ok(buf["links/" + originId + "/nb/" + "ab".repeat(32)]);
  assert.equal(buf["links/" + originId + "/nb/" + "ab".repeat(32)].snr, 3.5);
});

test("observerFromTopic: saca la pubkey del observador", () => {
  assert.equal(BR.observerFromTopic("meshcore/SCL/" + "ab".repeat(32) + "/packets"), "ab".repeat(32));
  assert.equal(BR.observerFromTopic("meshcore/SCL/x/packets"), null);
});

test("processMeshCorePacket: advert ⇒ nodo posicionado + enlace observador→nodo", () => {
  const pubkey = Buffer.from("ab".repeat(32), "hex");
  const app = mkAppData({ type: 2, lat: -33.45, lon: -70.66, name: "Repe SC" });
  const hex = mkAdvertPacket({ pubkey, sig: Buffer.alloc(64), app });
  const obs = "cd".repeat(32);
  const topic = "meshcore/SCL/" + obs + "/packets";
  const msg = Buffer.from(JSON.stringify({ raw_hex: hex, snr: 7 }));
  const buf = {}, counters = BR.newCounters();
  BR.processMeshCorePacket(topic, msg, buf, counters);

  const node = buf["nodes/" + "ab".repeat(32)];
  assert.ok(node, "el nodo emisor debe existir");
  assert.equal(node.name, "Repe SC");
  assert.equal(node.role, "ROUTER");
  assert.equal(Math.round(node.lat * 100), -3345);
  const link = buf["links/" + obs + "/nb/" + "ab".repeat(32)];
  assert.ok(link, "debe existir el enlace observador→nodo");
  assert.equal(link.snr, 7);
  assert.equal(link.src, "obs");
  assert.ok(buf["nodes/" + obs], "el observador se registra como nodo (sin pos aún)");
  assert.equal(counters.adverts, 1);
  assert.equal(counters.obsLinks, 1);
});
