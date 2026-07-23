/* ============================================================================
 * meshcore.js — decodifica paquetes MeshCore (adverts) y arma el JWT de auth
 * del broker MeshChile MSC. Sin dependencias (Ed25519 vía crypto nativo).
 *
 * Formato del paquete (de meshcore-packet-capture / firmware MeshCore):
 *   byte0 = header: route(2b bajos) · payload_type(bits 2-5) · version(bits 6-7)
 *   [+4 si route es TRANSPORT_*]  path_len(1) · path(path_len)  · payload
 *   ADVERT payload: pubkey[32] · time[4 LE] · sig[64] · appdata
 *     appdata: flags(1) · [latlon 8 si 0x10] · [feat1 2 si 0x20] · [feat2 2 si
 *     0x40] · [name utf8 si 0x80]. lat/lon = int32 LE / 1e6.
 *
 * Auth JWT (auto-soberano): header {alg:"Ed25519",typ:"JWT"}, payload
 * {publicKey:HEXUPPER, iat, exp, aud}, firma Ed25519 en HEX. La firma estándar
 * Ed25519 desde una semilla coincide con la firma "expanded key" del firmware.
 * ========================================================================== */
const crypto = require("crypto");

const PT_ADVERT = 0x04;
const ROUTE = { TRANSPORT_FLOOD: 0, FLOOD: 1, DIRECT: 2, TRANSPORT_DIRECT: 3 };

/* --- Identidad Ed25519 de software ----------------------------------------- */
// Node crea la clave privada Ed25519 desde una semilla de 32 bytes envolviéndola
// en el prefijo PKCS8 fijo de Ed25519.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function keyFromSeed(seed) {
  if (seed.length !== 32) throw new Error("la semilla Ed25519 debe ser de 32 bytes");
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}
function rawPublicKey(privKey) {
  const der = crypto.createPublicKey(privKey).export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32); // los últimos 32 bytes del SPKI = pubkey cruda
}
// makeIdentity(seedHex?) → { seedHex, pubHex, privKey }. Si no hay semilla, genera una.
function makeIdentity(seedHex) {
  const seed = seedHex ? Buffer.from(seedHex, "hex") : crypto.randomBytes(32);
  const privKey = keyFromSeed(seed);
  return { seedHex: seed.toString("hex"), pubHex: rawPublicKey(privKey).toString("hex"), privKey };
}

/* --- JWT del broker -------------------------------------------------------- */
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function buildAuthToken(identity, aud, ttlSec = 6 * 3600, now = Math.floor(Date.now() / 1000)) {
  const header = { alg: "Ed25519", typ: "JWT" };
  const payload = { publicKey: identity.pubHex.toUpperCase(), iat: now, exp: now + ttlSec, aud };
  const signingInput = b64url(Buffer.from(JSON.stringify(header))) + "." + b64url(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.sign(null, Buffer.from(signingInput, "utf8"), identity.privKey); // Ed25519
  const token = signingInput + "." + sig.toString("hex");
  return { username: "v1_" + identity.pubHex.toUpperCase(), password: token, exp: payload.exp };
}

/* --- Decodificación de paquetes -------------------------------------------- */
function parseAdvert(payload) {
  if (payload.length < 100) return null;
  const adv = { pubkey: payload.subarray(0, 32).toString("hex"), advTime: payload.readUInt32LE(32) };
  const app = payload.subarray(100);
  if (app.length === 0) return adv;
  const flags = app[0], type = flags & 0x0f;
  adv.mode = type === 1 ? "Companion" : type === 2 ? "Repeater" : type === 3 ? "RoomServer" : type === 4 ? "Sensor" : "Type" + type;
  let i = 1;
  if (flags & 0x10) { if (app.length < i + 8) return adv; adv.lat = app.readInt32LE(i) / 1e6; adv.lon = app.readInt32LE(i + 4) / 1e6; i += 8; }
  if (flags & 0x20) i += 2;
  if (flags & 0x40) i += 2;
  if (flags & 0x80 && app.length > i) adv.name = app.subarray(i).toString("utf8").replace(/\0+$/, "");
  return adv;
}
// decodePacketHex(hex) → { routeType, payloadType, path, advert? } | null
// path = array de hashes hex por salto (1-3 bytes c/u, según selector de bits 7:6),
// igual que decodePathLenByte del decoder oficial: hashSize=(byte>>6)+1, hops=byte&63.
function decodePacketHex(hex) {
  let b; try { b = Buffer.from(hex, "hex"); } catch { return null; }
  if (b.length < 2) return null;
  const header = b[0];
  const routeType = header & 0x03;
  const payloadVersion = (header >> 6) & 0x03;
  const payloadType = (header >> 2) & 0x0f;
  if (payloadVersion !== 0) return null;                 // solo VER_1
  let off = 1;
  if (routeType === ROUTE.TRANSPORT_FLOOD || routeType === ROUTE.TRANSPORT_DIRECT) off += 4;
  if (b.length <= off) return null;
  const pathLenByte = b[off]; off += 1;
  const hop = pathLenByte & 0x3f, bph = (pathLenByte >> 6) + 1;
  const pathByteLen = hop * bph;
  if (b.length < off + pathByteLen) return null;
  const path = [];
  for (let i = 0; i < hop; i++) path.push(b.subarray(off + i * bph, off + (i + 1) * bph).toString("hex"));
  off += pathByteLen;
  const payload = b.subarray(off);
  const out = { routeType, payloadType, path };
  if (payloadType === PT_ADVERT) { const a = parseAdvert(payload); if (!a || !a.pubkey) return null; out.advert = a; }
  return out;
}

module.exports = { makeIdentity, buildAuthToken, decodePacketHex, parseAdvert, keyFromSeed, rawPublicKey, PT_ADVERT, ROUTE };
