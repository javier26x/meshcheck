import { test } from "node:test";
import assert from "node:assert/strict";
import { normNode, finish, scanNodeId, fsVal, extractNodes } from "../tools/fetch_nodes.mjs";

test("normNode: floats lat/lon + nombre + rol", () => {
  const n = normNode({ node_id: 111, long_name: "Cerro", latitude: -33.4, longitude: -70.6, role: "ROUTER" });
  assert.equal(n.id, "111"); assert.equal(n.name, "Cerro"); assert.equal(n.role, "ROUTER");
  assert.ok(Math.abs(n.lat + 33.4) < 1e-9);
});

test("normNode: coordenadas *1e7 se escalan", () => {
  const n = normNode({ node_id: 1, latitude_i: -330472000, longitude_i: -716127000 });
  assert.ok(Math.abs(n.lat + 33.0472) < 1e-5);
  assert.ok(Math.abs(n.lon + 71.6127) < 1e-5);
});

test("finish: id hex '!xxxxxxxx' → decimal", () => {
  const n = finish({ id: "!a0dd1c48", lat: -33, lon: -70 });
  assert.equal(n.id, "2698845256");
});

test("finish: descarta lat/lon fuera de rango o (0,0)", () => {
  assert.equal(finish({ lat: 200, lon: 0 }), null);
  assert.equal(finish({ lat: 0, lon: 0 }), null);
});

test("scanNodeId: encuentra '!hex' en campo plano y anidado", () => {
  assert.equal(scanNodeId({ nodeId: "!9ffb3d21" }), "2684042529");
  assert.equal(scanNodeId({ user: { id: "!a0dd1c48" } }), "2698845256");
  assert.equal(scanNodeId({ foo: "bar" }), undefined);
});

test("fsVal: decodifica valores tipados de Firestore", () => {
  assert.equal(fsVal({ stringValue: "x" }), "x");
  assert.equal(fsVal({ integerValue: "42" }), 42);
  assert.equal(fsVal({ doubleValue: -33.4 }), -33.4);
  assert.deepEqual(fsVal({ geoPointValue: { latitude: -33, longitude: -70 } }), { latitude: -33, longitude: -70 });
});

test("extractNodes: elige el conjunto más grande y filtra sin-posición", () => {
  const data = { nodes: [
    { node_id: 1, latitude: -33.4, longitude: -70.6 },
    { node_id: 2, latitude: -33.5, longitude: -70.7 },
    { node_id: 3, long_name: "sin pos" },
  ] };
  const nodes = extractNodes(data);
  assert.equal(nodes.length, 2);
});
