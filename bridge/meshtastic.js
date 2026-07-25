/* ============================================================================
 * meshtastic.js — decodifica los paquetes CIFRADOS del MQTT de Meshtastic
 * (topic .../e/<canal>/<gateway>). Sin dependencias: mini-parser protobuf +
 * AES-CTR con el módulo `crypto` nativo.
 *
 * Flujo: ServiceEnvelope(protobuf) → MeshPacket → AES-CTR decrypt(encrypted)
 *        → Data(protobuf) → payload por PortNum (position, nodeinfo, telemetry,
 *        neighborinfo, traceroute, mapreport, text).
 *
 * Llave del canal: por defecto la PSK pública de Meshtastic (canal LongFast).
 * Configurable con la env CHANNEL_KEY (base64). Convención de 1 byte igual que
 * el firmware: psk=[N] → default key con el último byte = N.
 * ========================================================================== */
const crypto = require("crypto");

// PSK pública por defecto (canal LongFast) → AES-128
const DEFAULT_KEY = Buffer.from([
  0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59,
  0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01,
]);

function decodeKey(b64) {
  if (!b64) return DEFAULT_KEY;
  const k = Buffer.from(b64, "base64");
  if (k.length === 1) {
    if (k[0] === 0x00) return null;                 // sin cifrado
    const d = Buffer.from(DEFAULT_KEY);
    d[15] = (DEFAULT_KEY[15] + k[0] - 1) & 0xff;     // convención del firmware
    return d;
  }
  return k;                                          // 16 o 32 bytes
}

/* --- mini-parser protobuf (wire format) ------------------------------------ */
function readVarint(buf, i) {
  let result = 0n, shift = 0n, byte;
  do {
    if (i >= buf.length) throw new Error("varint EOF");
    byte = buf[i++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  return [result, i];
}
function parse(buf) {
  const fields = {};
  let i = 0;
  while (i < buf.length) {
    let tag; [tag, i] = readVarint(buf, i);
    tag = Number(tag);
    const fn = tag >>> 3, wt = tag & 7;
    let v;
    if (wt === 0) { let x; [x, i] = readVarint(buf, i); v = { varint: x }; }
    else if (wt === 5) { v = { b32: buf.subarray(i, i + 4) }; i += 4; }
    else if (wt === 1) { v = { b64: buf.subarray(i, i + 8) }; i += 8; }
    else if (wt === 2) { let len; [len, i] = readVarint(buf, i); len = Number(len); v = { bytes: buf.subarray(i, i + len) }; i += len; }
    else throw new Error("wire " + wt);
    (fields[fn] = fields[fn] || []).push(v);
  }
  return fields;
}
const vNum = (f) => f && f[0] && f[0].varint !== undefined ? Number(f[0].varint) : undefined;
const vS32 = (f) => f && f[0] && f[0].varint !== undefined ? Number(BigInt.asIntN(32, f[0].varint)) : undefined;
const vI32 = (f) => f && f[0] && f[0].b32 ? f[0].b32.readInt32LE(0) : undefined;
const vU32 = (f) => f && f[0] && f[0].b32 ? f[0].b32.readUInt32LE(0) : undefined;
const vF32 = (f) => f && f[0] && f[0].b32 ? f[0].b32.readFloatLE(0) : undefined;
const vStr = (f) => f && f[0] && f[0].bytes ? f[0].bytes.toString("utf8") : undefined;
const vBytes = (f) => f && f[0] && f[0].bytes ? f[0].bytes : undefined;

/* --- AES-CTR (nonce Meshtastic = packetId[8] LE + fromNode[4] LE + 0000) --- */
function decrypt(key, fromNode, packetId, ciphertext) {
  const nonce = Buffer.alloc(16);
  nonce.writeUInt32LE(packetId >>> 0, 0);
  nonce.writeUInt32LE(fromNode >>> 0, 8);
  const algo = key.length === 32 ? "aes-256-ctr" : "aes-128-ctr";
  const d = crypto.createDecipheriv(algo, key, nonce);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

/* --- PortNum → payload normalizado (misma forma que el JSON del broker) ----- */
const PORT = { 1: "text", 3: "position", 4: "nodeinfo", 67: "telemetry", 70: "traceroute", 71: "neighborinfo", 73: "mapreport" };

// RouteDiscovery: route=1 (fixed32), snr_towards=2 (int32), route_back=3,
// snr_back=4. Los repeated llegan empaquetados (wire 2) o sueltos.
function readFixed32List(f) {
  const out = [];
  for (const item of f || []) {
    if (item.b32) out.push(item.b32.readUInt32LE(0));
    else if (item.bytes) for (let o = 0; o + 4 <= item.bytes.length; o += 4) out.push(item.bytes.readUInt32LE(o));
  }
  return out;
}
const readRoute = (rd) => readFixed32List(rd[1]);
// SNR por salto: viene en dB×4 como int32; INT8_MIN (-128) = desconocido → null.
// Un int32 negativo se codifica como varint de 10 bytes (complemento a 2), por
// eso hay que reinterpretarlo con asIntN antes de dividir.
function readSnrList(f) {
  const out = [];
  const push = (n) => { const v = Number(BigInt.asIntN(32, BigInt(n))); out.push(v === -128 ? null : v / 4); };
  for (const item of f || []) {
    if (item.varint !== undefined) push(item.varint);
    else if (item.bytes) { let i = 0; while (i < item.bytes.length) { let v; [v, i] = readVarint(item.bytes, i); push(v); } }
  }
  return out;
}

function decodePayload(portnum, buf) {
  const type = PORT[portnum];
  if (!type) return null;
  try {
    if (type === "text") return { type, payload: {} };
    const p = parse(buf);
    if (type === "position") {
      const lat = vI32(p[1]) / 1e7, lon = vI32(p[2]) / 1e7;
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
      return { type, payload: { latitude_i: vI32(p[1]), longitude_i: vI32(p[2]), altitude: vS32(p[3]) } };
    }
    if (type === "nodeinfo") {
      return { type, payload: { long_name: vStr(p[2]), short_name: vStr(p[3]), hardware: vNum(p[5]), role: vNum(p[7]) } };
    }
    if (type === "telemetry") {
      const dev = p[2] && p[2][0].bytes ? parse(p[2][0].bytes) : {};
      const env = p[3] && p[3][0].bytes ? parse(p[3][0].bytes) : {};
      return { type, payload: {
        battery_level: vNum(dev[1]), voltage: vF32(dev[2]), channel_utilization: vF32(dev[3]),
        temperature: vF32(env[1]),
      } };
    }
    if (type === "neighborinfo") {
      const neighbors = (p[4] || []).map((x) => { const n = parse(x.bytes); return { node_id: vNum(n[1]), snr: vF32(n[2]) }; })
        .filter((n) => n.node_id != null);
      return { type, payload: { neighbors } };
    }
    if (type === "traceroute") {
      return { type, payload: {
        route: readRoute(p), snr_towards: readSnrList(p[2]),
        route_back: readFixed32List(p[3]), snr_back: readSnrList(p[4]),
      } };
    }
    if (type === "mapreport") {
      const lat = vI32(p[9]) / 1e7, lon = vI32(p[10]) / 1e7;
      const pl = { long_name: vStr(p[1]), short_name: vStr(p[2]), role: vNum(p[3]), hardware: vNum(p[4]) };
      if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
        pl.latitude_i = vI32(p[9]); pl.longitude_i = vI32(p[10]); pl.altitude = vS32(p[11]);
      }
      return { type, payload: pl };
    }
  } catch { return null; }
  return null;
}

/* --- ServiceEnvelope → paquete normalizado --------------------------------- */
function decodeEnvelope(buf, key) {
  const env = parse(buf);
  const pktBytes = vBytes(env[1]);
  const gatewayId = vStr(env[3]);
  if (!pktBytes) return null;
  const pkt = parse(pktBytes);
  const from = vU32(pkt[1]);
  const to = vU32(pkt[2]);
  const id = vU32(pkt[6]);
  const rxSnr = vF32(pkt[8]);
  const hopLimit = vNum(pkt[9]);
  const hopStart = vNum(pkt[15]);

  let dataBytes = vBytes(pkt[4]);              // decoded (raro en MQTT)
  const enc = vBytes(pkt[5]);                  // encrypted
  if (!dataBytes && enc) {
    if (!key || from == null || id == null) return null;
    try { dataBytes = decrypt(key, from, id, enc); } catch { return null; }
  }
  if (!dataBytes) return null;

  let d; try { d = parse(dataBytes); } catch { return null; }
  const portnum = vNum(d[1]);
  const payloadBuf = vBytes(d[2]);
  if (portnum == null || !payloadBuf) return null;
  const dec = decodePayload(portnum, payloadBuf);
  if (!dec) return null;

  return { from, to, id, rxSnr, hopLimit, hopStart, gatewayId, type: dec.type, payload: dec.payload };
}

module.exports = { decodeKey, decodeEnvelope, decodePayload, parse, decrypt, DEFAULT_KEY,
  _helpers: { vNum, vS32, vI32, vU32, vF32, vStr, vBytes, readSnrList, readFixed32List } };
