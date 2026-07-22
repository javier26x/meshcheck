import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const M = require("../bridge/meshtastic.js");

// --- helpers para CONSTRUIR protobuf ---
const vEnc = (n) => { const o = []; let x = BigInt(n); if (x < 0n) x &= (1n << 64n) - 1n; do { let b = Number(x & 0x7fn); x >>= 7n; if (x) b |= 0x80; o.push(b); } while (x); return Buffer.from(o); };
const tag = (f, w) => vEnc((f << 3) | w);
const fLen = (f, buf) => Buffer.concat([tag(f, 2), vEnc(buf.length), buf]);
const fVar = (f, n) => Buffer.concat([tag(f, 0), vEnc(n)]);
const f32 = (f, fn) => { const b = Buffer.alloc(4); fn(b); return Buffer.concat([tag(f, 5), b]); };
const fI32 = (f, n) => f32(f, (b) => b.writeInt32LE(n));
const fU32 = (f, n) => f32(f, (b) => b.writeUInt32LE(n));
const fF32 = (f, n) => f32(f, (b) => b.writeFloatLE(n));
const fStr = (f, s) => fLen(f, Buffer.from(s, "utf8"));
const encrypt = (key, from, id, plain) => { const n = Buffer.alloc(16); n.writeUInt32LE(id >>> 0, 0); n.writeUInt32LE(from >>> 0, 8); const c = crypto.createCipheriv("aes-128-ctr", key, n); return Buffer.concat([c.update(plain), c.final()]); };

test("parse protobuf: varint / string / u32 / f32", () => {
  const msg = Buffer.concat([fVar(1, 3), fLen(2, Buffer.from("hola")), fU32(6, 123456789), fF32(8, -7.5)]);
  const p = M.parse(msg);
  assert.equal(M._helpers.vNum(p[1]), 3);
  assert.equal(M._helpers.vStr(p[2]), "hola");
  assert.equal(M._helpers.vU32(p[6]), 123456789);
  assert.ok(Math.abs(M._helpers.vF32(p[8]) + 7.5) < 1e-6);
});

test("AES-CTR roundtrip con nonce Meshtastic", () => {
  const key = M.DEFAULT_KEY, from = 0x11223344, id = 0xaabbccdd;
  const plain = Buffer.from("mensaje secreto");
  const dec = M.decrypt(key, from, id, encrypt(key, from, id, plain));
  assert.ok(dec.equals(plain));
});

test("decodeEnvelope: Position cifrada → lat/lon/alt/gw/hops", () => {
  const key = M.DEFAULT_KEY, from = 0x11223344, id = 0xaabbccdd, lat = -33.4489, lon = -70.6693;
  const position = Buffer.concat([fI32(1, Math.round(lat * 1e7)), fI32(2, Math.round(lon * 1e7)), fVar(3, 570)]);
  const data = Buffer.concat([fVar(1, 3 /* POSITION */), fLen(2, position)]);
  const enc = encrypt(key, from, id, data);
  const pkt = Buffer.concat([fU32(1, from), fU32(2, 0xffffffff), fLen(5, enc), fU32(6, id), fF32(8, 6.25), fVar(9, 3), fVar(15, 3)]);
  const env = Buffer.concat([fLen(1, pkt), fStr(2, "LongFast"), fStr(3, "!11223344")]);
  const out = M.decodeEnvelope(env, key);
  assert.equal(out.type, "position");
  assert.ok(Math.abs(out.payload.latitude_i / 1e7 - lat) < 1e-5);
  assert.ok(Math.abs(out.payload.longitude_i / 1e7 - lon) < 1e-5);
  assert.equal(out.payload.altitude, 570);
  assert.equal(out.gatewayId, "!11223344");
  assert.equal(out.hopStart, 3); assert.equal(out.hopLimit, 3);
});

test("decodeEnvelope: NeighborInfo cifrada → vecinos con SNR", () => {
  const key = M.DEFAULT_KEY, from = 0x11223344, id = 0xaabbccdd;
  const nb = (nid, snr) => fLen(4, Buffer.concat([fVar(1, nid), fF32(2, snr)]));
  const niData = Buffer.concat([fVar(1, from), nb(0x55667788, 5.0), nb(0x99aabbcc, -3.5)]);
  const full = Buffer.concat([fVar(1, 71 /* NEIGHBORINFO */), fLen(2, niData)]);
  const enc = encrypt(key, from, id, full);
  const pkt = Buffer.concat([fU32(1, from), fLen(5, enc), fU32(6, id)]);
  const env = Buffer.concat([fLen(1, pkt), fStr(3, "!gw")]);
  const out = M.decodeEnvelope(env, key);
  assert.equal(out.type, "neighborinfo");
  assert.equal(out.payload.neighbors.length, 2);
  assert.equal(out.payload.neighbors[0].node_id, 0x55667788);
  assert.ok(Math.abs(out.payload.neighbors[0].snr - 5.0) < 1e-6);
});

test("decodeEnvelope: llave equivocada → descarta (no basura)", () => {
  const key = M.DEFAULT_KEY, from = 0x11223344, id = 0xaabbccdd, lat = -33.4489, lon = -70.6693;
  const position = Buffer.concat([fI32(1, Math.round(lat * 1e7)), fI32(2, Math.round(lon * 1e7))]);
  const data = Buffer.concat([fVar(1, 3), fLen(2, position)]);
  const pkt = Buffer.concat([fU32(1, from), fLen(5, encrypt(key, from, id, data)), fU32(6, id)]);
  const env = Buffer.concat([fLen(1, pkt), fStr(3, "!gw")]);
  const wrong = Buffer.from(key); wrong[0] ^= 0xff;
  assert.equal(M.decodeEnvelope(env, wrong), null);
});

test("decodeKey: PSK de 1 byte → default; base64 de 16 bytes → tal cual", () => {
  assert.ok(M.decodeKey("AQ==").equals(M.DEFAULT_KEY));   // 0x01 = default
  assert.equal(M.decodeKey("AA=="), null);                 // 0x00 = sin cifrado
  const k16 = Buffer.alloc(16, 7);
  assert.ok(M.decodeKey(k16.toString("base64")).equals(k16));
});
