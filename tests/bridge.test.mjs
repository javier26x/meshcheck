import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const B = require("../bridge/bridge.js");

const mkCounters = () => ({ seenTypes: {}, fieldCounts: { sender: 0, hops_away: 0, hop_start: 0, direct: 0, enc: 0, encOk: 0, encFail: 0 }, gwLinks: 0 });

test("processPacket: position → nodo con lat/lon/alt/name", () => {
  const buf = {}, c = mkCounters();
  B.processPacket({ type: "position", from: 111, payload: { latitude_i: -334489000, longitude_i: -706693000, altitude: 570, name: "X" } }, buf, c);
  const n = buf["nodes/111"];
  assert.ok(n);
  assert.equal(Math.round(n.lat * 1e4), -334489);
  assert.equal(n.alt, 570);
  assert.equal(n.name, "X");
});

test("processPacket: neighborinfo → leaf link con src ni", () => {
  const buf = {}, c = mkCounters();
  B.processPacket({ type: "neighborinfo", from: 1, payload: { neighbors: [{ node_id: 2, snr: 5 }] } }, buf, c);
  const l = buf["links/1/nb/2"];
  assert.ok(l); assert.equal(l.snr, 5); assert.equal(l.src, "ni");
});

test("processPacket: recepción directa de gateway → link gw", () => {
  const buf = {}, c = mkCounters();
  B.processPacket({ type: "position", from: 2222, hops_away: 0, sender: "!0000000a", snr: -3, payload: { latitude_i: -330000000, longitude_i: -700000000 } }, buf, c);
  const l = buf["links/10/nb/2222"];        // !0000000a = 10
  assert.ok(l); assert.equal(l.src, "gw"); assert.equal(l.snr, -3);
  assert.equal(c.gwLinks, 1);
});

test("planFlush: dedupe — sin cambios no reescribe; refresca t tras el intervalo", () => {
  const st = B.newState();
  let r = B.planFlush({ "nodes/1": { id: "1", name: "A", lat: -33, lon: -70, t: 1000 } }, st, 1000);
  assert.equal(r.changed, 1);
  assert.ok(r.body["nodes/1"]);
  // mismo contenido poco después → nada
  r = B.planFlush({ "nodes/1": { id: "1", name: "A", lat: -33, lon: -70, t: 1500 } }, st, 1500);
  assert.equal(r.changed, 0);
  assert.equal(Object.keys(r.body).length, 0);
  // pasado REFRESH_NODE_MS → refresca solo el leaf t (preserva el resto)
  r = B.planFlush({ "nodes/1": { id: "1", name: "A", lat: -33, lon: -70, t: 9e9 } }, st, 1000 + B.REFRESH_NODE_MS + 1);
  assert.equal(r.body["nodes/1/t"], 1000 + B.REFRESH_NODE_MS + 1);
  assert.equal(r.body["nodes/1"], undefined);
});

test("planFlush: al cambiar un campo escribe el OBJETO COMPLETO acumulado", () => {
  const st = B.newState();
  B.planFlush({ "nodes/1": { id: "1", name: "A", lat: -33, lon: -70, t: 1 } }, st, 1);
  // llega solo telemetría (delta) → debe escribir name+lat+lon+batt, no solo batt
  const r = B.planFlush({ "nodes/1": { id: "1", batt: 80, t: 2 } }, st, 2);
  const w = r.body["nodes/1"];
  assert.ok(w); assert.equal(w.name, "A"); assert.equal(w.lat, -33); assert.equal(w.batt, 80);
});

test("planFlush: link snr redondeado — no reescribe por ruido < 1 dB", () => {
  const st = B.newState();
  let r = B.planFlush({ "links/1/nb/2": { snr: 5.0, t: 1, src: "gw" } }, st, 1);
  assert.equal(r.changed, 1);
  r = B.planFlush({ "links/1/nb/2": { snr: 5.4, t: 2, src: "gw" } }, st, 2);   // 5.4→5, igual
  assert.equal(r.changed, 0);
  r = B.planFlush({ "links/1/nb/2": { snr: 6.0, t: 3, src: "gw" } }, st, 3);   // cambia
  assert.equal(r.changed, 1);
});

test("planFlush: el body no tiene rutas ancestro/descendiente (multi-PATCH válido)", () => {
  const st = B.newState();
  const batch = { "nodes/1": { id: "1", lat: -33, lon: -70, t: 1 }, "links/1/nb/2": { snr: 5, t: 1, src: "ni" }, "links/1/nb/3": { snr: 1, t: 1, src: "gw" } };
  const { body } = B.planFlush(batch, st, 1);
  const keys = Object.keys(body);
  for (const a of keys) for (const b of keys) if (a !== b) assert.ok(!b.startsWith(a + "/"), `${a} es ancestro de ${b}`);
});

test("planPurge: borra lo viejo, conserva lo fresco", () => {
  const st = B.newState();
  const now = 1e6, cutoff = now - 100;
  const nodes = { old: { t: now - 200 }, fresh: { t: now - 10 } };
  const links = { a: { nb: { x: { t: now - 200 }, y: { t: now - 5 } } }, b: { nb: { z: { t: now - 999 } } } };
  const { del, dn, dl } = B.planPurge(nodes, links, cutoff, st);
  assert.equal(del["nodes/old"], null);
  assert.equal(del["nodes/fresh"], undefined);
  assert.equal(del["links/a/nb/x"], null);
  assert.equal(del["links/a/nb/y"], undefined);
  assert.equal(del["links/b"], null);        // todos viejos → borra el nodo entero
  assert.ok(dn >= 1 && dl >= 1);
  // sin solapamiento en el borrado
  const keys = Object.keys(del);
  for (const a of keys) for (const b of keys) if (a !== b) assert.ok(!b.startsWith(a + "/"), `${a} ancestro de ${b}`);
});
