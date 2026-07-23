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

test("decodePacketHex: path presente se salta correctamente", () => {
  const app = mkAppData({ type: 2, name: "H" });
  const path = Buffer.from([0xaa, 0xbb, 0xcc]);   // 3 hops, 1 byte c/u
  const hex = mkAdvertPacket({ pubkey: Buffer.from("03".repeat(32), "hex"), sig: Buffer.alloc(64), app, path });
  const d = MC.decodePacketHex(hex);
  assert.equal(d.advert.name, "H");
  assert.equal(d.advert.pubkey, "03".repeat(32));
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
