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
function mkAdvertPacket({ pubkey, advTime = 1700000000, sig, app, routeType = ROUTE.FLOOD, path = Buffer.alloc(0), pathLenByte }) {
  const payload = Buffer.concat([pubkey, u32le(advTime), sig, app]);
  const header = Buffer.from([mkHeader(routeType, MC.PT_ADVERT)]);
  const transport = (routeType === ROUTE.TRANSPORT_FLOOD || routeType === ROUTE.TRANSPORT_DIRECT) ? Buffer.alloc(4) : Buffer.alloc(0);
  // path_len byte: bits 7:6 = (bytes por hash - 1), bits 5:0 = nº de saltos.
  // Por defecto bph=1, así que el nº de saltos es el largo del buffer.
  const pathLen = Buffer.from([pathLenByte != null ? pathLenByte : path.length & 0x3f]);
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
  // history_edges NO conserva dirección (el backend ordena a/b por coordenada)
  // → se escribe simétrico, nunca una dirección inventada
  assert.equal(Object.keys(links).length, 2);
  const l = links["links/" + pubA + "/nb/" + pubB];
  const back = links["links/" + pubB + "/nb/" + pubA];
  assert.equal(l.src, "ruta");
  assert.equal(l.t, now - 30000);
  assert.ok(back, "debe existir el enlace inverso");
  assert.equal(back.t, now - 30000);
  assert.notEqual(l, back, "deben ser objetos distintos (no aliasar)");
  // `seen` guarda la frescura REAL (planFlush pisa `t` con la hora de escritura)
  assert.equal(a.seen, now - 60000);
});

test("mapSnapshot: extremos ambiguos (nodos colocalizados) ⇒ ningún enlace", () => {
  const now = 1700000000000;
  const p1 = "aa".repeat(32), p2 = "bb".repeat(32), p3 = "cc".repeat(32);
  const j = {
    devices: {
      [p1]: { device_id: p1, name: "A", lat: -33.400000, lon: -70.600000, last_seen_ts: now / 1000 },
      [p2]: { device_id: p2, name: "B", lat: -33.400020, lon: -70.600000, last_seen_ts: now / 1000 },  // ~2 m de A
      [p3]: { device_id: p3, name: "C", lat: -33.500000, lon: -70.700000, last_seen_ts: now / 1000 },
    },
    history_edges: [{ a: [-33.4, -70.6], b: [-33.5, -70.7], count: 3, last_ts: now / 1000 }],
  };
  const { links } = BR.mapSnapshot(j, now, 0);
  assert.equal(Object.keys(links).length, 0, "A y B caen dentro de la tolerancia → extremo ambiguo → sin enlace");
});

test("mapSnapshot: la estela permite resolver el extremo de un nodo que se movió", () => {
  const now = 1700000000000;
  const movil = "aa".repeat(32), fijo = "bb".repeat(32);
  const j = {
    devices: {
      [movil]: { device_id: movil, name: "Móvil", lat: -33.402, lon: -70.6, last_seen_ts: now / 1000 },  // ya se movió ~220 m
      [fijo]: { device_id: fijo, name: "Fijo", lat: -33.5, lon: -70.7, last_seen_ts: now / 1000 },
    },
    // el enlace se congeló en la posición ANTERIOR del móvil
    history_edges: [{ a: [-33.4, -70.6], b: [-33.5, -70.7], count: 4, last_ts: now / 1000 }],
    trails: { [movil]: [[-33.4, -70.6, now / 1000 - 600], [-33.402, -70.6, now / 1000]] },
  };
  const { links } = BR.mapSnapshot(j, now, 0);
  assert.ok(links["links/" + movil + "/nb/" + fijo], "la posición histórica de la estela resuelve el extremo");
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

test("registro hash→pubkey: indexa 1, 2 y 3 bytes y marca ambiguos por ancho", () => {
  const reg = BR.newRegistry();
  const p1 = "aa" + "11".repeat(31), p2 = "bb" + "22".repeat(31), p3 = "aa" + "33".repeat(31);
  BR.regAdd(reg, p1); BR.regAdd(reg, p2);
  assert.equal(reg.h2p[2]["aa"], p1);
  assert.equal(reg.h2p[4][p1.slice(0, 4)], p1);        // hash de 2 bytes
  assert.equal(reg.h2p[6][p1.slice(0, 6)], p1);        // hash de 3 bytes
  assert.equal(reg.h2p[2]["bb"], p2);
  BR.regAdd(reg, p3);                                   // mismo PRIMER byte que p1
  assert.equal(reg.h2p[2]["aa"], undefined, "1 byte queda ambiguo");
  assert.ok(reg.amb[2]["aa"]);
  // …pero con 2 y 3 bytes siguen siendo distinguibles
  assert.equal(reg.h2p[4][p1.slice(0, 4)], p1);
  assert.equal(reg.h2p[4][p3.slice(0, 4)], p3);
});

test("path con hash de 2 bytes: se resuelve (antes se truncaba siempre)", () => {
  const origin = "ee".repeat(32), rep = "a1b2" + "00".repeat(30), obs = "cd".repeat(32);
  const reg = BR.newRegistry();
  for (const p of [origin, rep, obs]) BR.regAdd(reg, p);
  const app = mkAppData({ type: 2, lat: -33.4, lon: -70.6, name: "O" });
  // bph=2 → el byte de longitud lleva el selector (1<<6) y 1 hop
  const path = Buffer.from([0xa1, 0xb2]);
  const hex = mkAdvertPacket({ pubkey: Buffer.from(origin, "hex"), sig: Buffer.alloc(64), app, path, pathLenByte: (1 << 6) | 1 });
  const buf = {}, counters = BR.newCounters();
  BR.processMeshCorePacket("meshcore/SCL/x/packets", Buffer.from(JSON.stringify({ raw: hex, SNR: "2", origin_id: obs })), buf, counters, reg);
  assert.ok(buf["links/" + rep + "/nb/" + origin], "el repetidor de hash 2 bytes oyó al origen");
  assert.ok(buf["links/" + obs + "/nb/" + rep], "el observador oyó al repetidor");
  assert.equal(counters.truncPath, 0);
});

test("path truncado (hash desconocido) ⇒ NO se inventa el enlace del observador", () => {
  const origin = "ee".repeat(32), obs = "cd".repeat(32);
  const reg = BR.newRegistry();
  BR.regAdd(reg, origin); BR.regAdd(reg, obs);
  const app = mkAppData({ type: 2, lat: -33.4, lon: -70.6, name: "O" });
  const hex = mkAdvertPacket({ pubkey: Buffer.from(origin, "hex"), sig: Buffer.alloc(64), app, path: Buffer.from([0x77]) }); // 0x77 desconocido
  const buf = {}, counters = BR.newCounters();
  BR.processMeshCorePacket("meshcore/SCL/x/packets", Buffer.from(JSON.stringify({ raw: hex, SNR: "9", origin_id: obs })), buf, counters, reg);
  assert.equal(buf["links/" + obs + "/nb/" + origin], undefined, "el observador NO oyó al origen: hubo un salto intermedio");
  assert.equal(counters.truncPath, 1);
  assert.ok(buf["nodes/" + origin], "el nodo sí se posiciona igual");
});

test("putLink: una medición con SNR no la pisa una adyacencia sin SNR", () => {
  const buf = {}, k = "links/a/nb/b";
  const t0 = 1700000000000;
  BR.putLink(buf, k, { snr: 7, t: t0, src: "obs" });          // medición RF
  BR.putLink(buf, k, { snr: null, t: t0 + 1000, src: "ruta", n: 12 });  // histórico sin SNR
  assert.equal(buf[k].snr, 7, "conserva el SNR medido");
  assert.equal(buf[k].src, "obs");
  assert.equal(buf[k].n, 12, "pero incorpora el volumen que aporta la otra fuente");
  assert.equal(buf[k].t, t0 + 1000, "y la frescura");
  // al revés: una medición nueva SÍ manda sobre el histórico
  const buf2 = {};
  BR.putLink(buf2, k, { snr: null, t: t0, src: "ruta" });
  BR.putLink(buf2, k, { snr: 3, t: t0 + 1000, src: "obs" });
  assert.equal(buf2[k].snr, 3);
  assert.equal(buf2[k].src, "obs");
});

test("onlineFromStatus: tolera claves y mayúsculas; sin dato no afirma nada", () => {
  assert.equal(BR.onlineFromStatus({ status: "online" }), true);
  assert.equal(BR.onlineFromStatus({ status: "ONLINE" }), true);
  assert.equal(BR.onlineFromStatus({ state: "Offline" }), false);
  assert.equal(BR.onlineFromStatus({ connection: "disconnected" }), false);
  assert.equal(BR.onlineFromStatus({ online: true }), true);
  assert.equal(BR.onlineFromStatus({ otra: "cosa" }), undefined, "sin clave conocida no se afirma");
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
  // null explícito (no undefined): omitir la clave NO limpia, porque planFlush
  // fusiona campos acumulados y el valor viejo quedaría pegado
  assert.equal(nodes["nodes/" + pubB].mqtt, null, "sin mqtt_seen_ts no hay presencia");
  assert.equal(links["links/" + pubA + "/nb/" + pubB].n, 12);
  assert.equal(extra["routes/all"].length, 1, "solo la ruta reciente (la vieja queda fuera)");
  assert.deepEqual(extra["routes/all"][0].p[0], [-33.41, -70.55]);
  assert.equal(extra["trails/" + pubA].length, 2);
  assert.equal(extra["heat/all"].length, 1, "el punto (0,0) del calor se descarta");
  assert.equal(extra["heat/all"][0][2], 0.9);
});

test("mapSnapshot: evento 'update' del WS (un device + su trail)", () => {
  const now = 1700000000000;
  const pub = "dd".repeat(32);
  // forma exacta del broadcast: {type:"update", device:{...}, trail:[[lat,lon,ts]...]}
  const mini = {
    devices: [{ device_id: pub, name: "Móvil", lat: -33.44, lon: -70.65, ts: now / 1000, last_seen_ts: now / 1000, speed: 30, heading: 90 }],
    trails: { [pub]: [[-33.43, -70.64, now / 1000 - 60], [-33.44, -70.65, now / 1000]] },
  };
  const { nodes, extra } = BR.mapSnapshot(mini, now, 24 * 3600 * 1000);
  assert.ok(nodes["nodes/" + pub]);
  assert.equal(nodes["nodes/" + pub].speed, 30);
  assert.equal(extra["trails/" + pub].length, 2);
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

test("mapSnapshot: el latido MQTT del observador NO cuenta como recepción por RF", () => {
  const now = 1700000000000;
  const obs = "aa".repeat(32), rf = "bb".repeat(32);
  const j = { devices: {
    // observador: su last_seen se reestampa con el heartbeat MQTT (mismo instante)
    [obs]: { device_id: obs, name: "Observador", lat: -33.4, lon: -70.6,
             last_seen_ts: now / 1000, ts: now / 1000, mqtt_seen_ts: now / 1000 },
    // nodo oído por radio 10 min DESPUÉS de su última señal MQTT
    [rf]: { device_id: rf, name: "Por radio", lat: -33.5, lon: -70.7,
            last_seen_ts: now / 1000, ts: now / 1000, mqtt_seen_ts: now / 1000 - 600 },
  } };
  const { nodes } = BR.mapSnapshot(j, now, 0);
  assert.equal(nodes["nodes/" + obs].seen, null, "un ts pegado al latido MQTT no prueba RF");
  assert.equal(nodes["nodes/" + obs].mqtt, now, "…pero sí queda su presencia MQTT");
  assert.equal(nodes["nodes/" + rf].seen, now, "con la señal MQTT vieja, el ts SÍ es recepción por radio");
});

test("mapSnapshot: presencia MQTT solo desde mqtt_seen_ts (el mapa ya la purga a los 5 min)", () => {
  const now = 1700000000000;
  const p = "cc".repeat(32);
  // internal/packets viejos que el mapa NUNCA borra: no deben resucitar al nodo
  const j = { devices: { [p]: { device_id: p, lat: -33, lon: -70, last_seen_ts: now / 1000,
    mqtt_internal_ts: now / 1000 - 10, mqtt_packets_ts: now / 1000 - 20 } } };
  const { nodes } = BR.mapSnapshot(j, now, 0);
  assert.equal(nodes["nodes/" + p].mqtt, null, "sin mqtt_seen_ts el mapa lo dio por caído");
});

test("mapSnapshot: RoomServer conserva el rol de infraestructura", () => {
  const now = 1700000000000;
  const p = "dd".repeat(32);
  const { nodes } = BR.mapSnapshot({ devices: { [p]: { device_id: p, role: "room", lat: -33, lon: -70, last_seen_ts: now / 1000 } } }, now, 0);
  assert.equal(nodes["nodes/" + p].mode, "RoomServer");
  assert.equal(nodes["nodes/" + p].role, "ROUTER", "un RoomServer es infraestructura, como el repetidor");
});

test("mapSnapshot: telemetría que desaparece se RETRACTA con null", () => {
  const now = 1700000000000;
  const p = "ee".repeat(32);
  const base = { device_id: p, lat: -33, lon: -70, last_seen_ts: now / 1000 };
  // el móvil se detuvo: speed llega en 0 → baja explícita
  let r = BR.mapSnapshot({ devices: { [p]: { ...base, speed: 0, heading: 90 } } }, now, 0);
  assert.equal(r.nodes["nodes/" + p].speed, null, "0 km/h = detenido = se borra el campo");
  assert.equal(r.nodes["nodes/" + p].heading, 90);
  // si la fuente ya ni menciona la clave, no se inventa una retractación
  r = BR.mapSnapshot({ devices: { [p]: { ...base } } }, now, 0);
  assert.equal(r.nodes["nodes/" + p].speed, undefined, "clave ausente ⇒ no se toca");
});

test("mapRouteLinks: SNR REAL por salto desde un paquete TRACE", () => {
  const now = 1700000000000;
  const A = "aa".repeat(32), B = "bb".repeat(32), C = "cc".repeat(32);
  const r = {
    payload_type: 9, route_mode: "path", ts: now / 1000,
    origin_id: A, receiver_id: "ff".repeat(32),
    point_ids: [A, B, C],
    hashes: ["bbbb", "cccc"],          // 2 bytes c/u
    snr_values: [6.25, -3.5],
  };
  const links = BR.mapRouteLinks(r, now);
  // snr_values[i] = SNR con que point_ids[i+1] recibió de point_ids[i]
  assert.equal(links["links/" + B + "/nb/" + A].snr, 6.25);
  assert.equal(links["links/" + B + "/nb/" + A].src, "tr", "con SNR es medición RF, no adyacencia");
  assert.equal(links["links/" + C + "/nb/" + B].snr, -3.5);
  assert.equal(links["links/" + A + "/nb/" + B], undefined, "con SNR el enlace es dirigido (quién midió a quién)");
});

test("mapRouteLinks: sin SNR usable ⇒ adyacencia simétrica sin inventar señal", () => {
  const now = 1700000000000;
  const A = "aa".repeat(32), B = "bb".repeat(32);
  const base = { route_mode: "path", ts: now / 1000, origin_id: A, receiver_id: "ff".repeat(32), point_ids: [A, B], hashes: ["bb"] };
  // payload_type != 9 (no es TRACE): los bytes del path son hashes, no SNR
  let links = BR.mapRouteLinks({ ...base, payload_type: 4, snr_values: [9] }, now);
  assert.equal(links["links/" + B + "/nb/" + A].snr, null);
  assert.equal(links["links/" + B + "/nb/" + A].src, "ruta");
  assert.ok(links["links/" + A + "/nb/" + B], "sin SNR se escribe simétrico");
  assert.equal(links["links/" + B + "/nb/" + A].w, 1, "hash de 1 byte ⇒ resolución ambigua");
  // SNR fuera de rango físico ⇒ no se usa
  links = BR.mapRouteLinks({ ...base, payload_type: 9, snr_values: [999] }, now);
  assert.equal(links["links/" + B + "/nb/" + A].snr, null);
  // arrays desalineados ⇒ no se usa
  links = BR.mapRouteLinks({ ...base, payload_type: 9, snr_values: [1, 2, 3] }, now);
  assert.equal(links["links/" + B + "/nb/" + A].snr, null);
});

test("mapRouteLinks: route_mode 'direct' (path sin resolver) ⇒ ningún enlace", () => {
  const now = 1700000000000;
  const A = "aa".repeat(32), Z = "ff".repeat(32);
  // el backend rellenó [origen, receptor] porque no pudo resolver los saltos:
  // afirmar adyacencia sería inventar que se oyen directo
  const links = BR.mapRouteLinks({ payload_type: 9, route_mode: "direct", ts: now / 1000, origin_id: A, receiver_id: Z, point_ids: [A, Z], hashes: [] }, now);
  assert.equal(Object.keys(links).length, 0);
});
