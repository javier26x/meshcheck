/* Extrae funciones puras del <script> de meshcheck.html y las prueba, sin
 * tocar el DOM. Extractor consciente de strings/templates para balancear llaves.
 * Si renombras una función, el test falla acá → recordatorio de actualizar. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HTML = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../frontend/meshcheck.html"), "utf8");
const SCRIPT = (() => { const re = /<script>([\s\S]*?)<\/script>/g; let m, last = ""; while ((m = re.exec(HTML))) last = m[1]; return last; })();

// --- matcher consciente de comillas/templates ---
function skipString(s, i, q) { i++; while (i < s.length) { if (s[i] === "\\") { i += 2; continue; } if (s[i] === q) return i + 1; i++; } return i; }
function skipTemplate(s, i) {
  i++;
  while (i < s.length) {
    if (s[i] === "\\") { i += 2; continue; }
    if (s[i] === "`") return i + 1;
    if (s[i] === "$" && s[i + 1] === "{") { i += 2; let d = 1; while (i < s.length && d > 0) { const c = s[i]; if (c === '"' || c === "'") { i = skipString(s, i, c); continue; } if (c === "`") { i = skipTemplate(s, i); continue; } if (c === "{") d++; else if (c === "}") d--; i++; } continue; }
    i++;
  }
  return i;
}
function matchBrace(s, open) { let d = 0, i = open; while (i < s.length) { const c = s[i]; if (c === '"' || c === "'") { i = skipString(s, i, c); continue; } if (c === "`") { i = skipTemplate(s, i); continue; } if (c === "{") d++; else if (c === "}") { if (--d === 0) return i; } i++; } return -1; }
function stmtEnd(s, i) { let d = 0; while (i < s.length) { const c = s[i]; if (c === '"' || c === "'") { i = skipString(s, i, c); continue; } if (c === "`") { i = skipTemplate(s, i); continue; } if ("{[(".includes(c)) d++; else if ("}])".includes(c)) d--; else if (c === ";" && d === 0) return i; i++; } return i; }
function grab(name) {
  let i = SCRIPT.indexOf(`function ${name}(`);
  if (i >= 0) { const j = SCRIPT.indexOf("{", i); return SCRIPT.slice(i, matchBrace(SCRIPT, j) + 1); }
  const rx = new RegExp(`(?:const|let|var) ${name}\\s*=`); const m = rx.exec(SCRIPT);
  if (m) return SCRIPT.slice(m.index, stmtEnd(SCRIPT, m.index) + 1);
  throw new Error("no se encontró en el script: " + name);
}

const NAMES = ["R", "haversine", "snrColor", "isRouter", "ekey", "isNominalNode", "P_NOMINAL", "BRIDGE_KM", "compact", "normName", "seenAt", "linkNeighbors", "buildGraph", "computeRoute", "visiblePredicate", "activeNodes", "ROLE_ENUM", "ROLE_STR", "roleLabel", "hexId"];
const GRABBED = NAMES.map(grab).join("\n");

// crea un scope fresco con el estado dado y devuelve las funciones
function scope(state) {
  const st = Object.assign({ proto: "mt", useLive: true, ttlHours: 2, rangeKm: 15, hopLimit: 7, pointA: null, pointB: null, filters: { live: false, routers: false, measured: false, hideDir: false }, liveLinks: {}, liveNodes: {}, embeddedNodes: {}, hypRepeaters: [] }, state);
  const decls = Object.keys(st).map((k) => `let ${k} = __s.${k};`).join("\n");
  const body = decls + "\n" + GRABBED + "\n; return { haversine, snrColor, roleLabel, hexId, isNominalNode, seenAt, linkNeighbors, buildGraph, computeRoute, visiblePredicate, activeNodes };";
  return new Function("__s", body)(st);
}
const ekey = (x, y) => (x < y ? x + "|" + y : y + "|" + x);
function build(nodes, edges) { const adj = new Map(); const et = new Map(); const add = (x, y) => { if (!adj.has(x)) adj.set(x, new Set()); adj.get(x).add(y); }; for (const [a, b, t] of edges) { add(a, b); add(b, a); et.set(ekey(a, b), t); } return { adj, et }; }

test("el script expone todas las funciones esperadas", () => {
  assert.equal(typeof scope({}).computeRoute, "function");
});

test("snrColor: azul (bajo) → ámbar (alto), colorblind-safe (sin verde)", () => {
  const { snrColor } = scope({});
  assert.match(snrColor(-20), /^rgb\(59,110,214\)/);
  assert.match(snrColor(10), /^rgb\(240,158,32\)/);
});

test("roleLabel / hexId", () => {
  const { roleLabel, hexId } = scope({});
  assert.equal(roleLabel(2), "Router");
  assert.equal(roleLabel("CLIENT_MUTE"), "Cliente (mute)");
  assert.equal(roleLabel("repeater"), "Repetidor hipotético");
  assert.equal(hexId("2698845256"), "!a0dd1c48");
  assert.equal(hexId("007lDAGFnDatIS9wjesw"), null);
});

test("visiblePredicate: solo-vivos, routers, measured, hideDir", () => {
  const N = { vivo: { id: "1", t: 1, lat: -33, lon: -70 }, nom: { id: "2", placeholder: true, lat: -33, lon: -70 }, rtr: { id: "3", role: "ROUTER", t: 1 }, est: { id: "4", estimated: true }, meas: { id: "10", t: 1 } };
  const measured = new Set(["10"]);
  assert.ok(scope({ filters: { live: false, routers: false, measured: false, hideDir: false } }).visiblePredicate(measured)(N.nom));
  assert.equal(scope({ filters: { live: true, routers: false, measured: false, hideDir: false } }).visiblePredicate(measured)(N.nom), false);
  assert.ok(scope({ filters: { live: true } }).visiblePredicate(measured)(N.est));
  assert.equal(scope({ filters: { routers: true } }).visiblePredicate(measured)(N.vivo), false);
  assert.ok(scope({ filters: { routers: true } }).visiblePredicate(measured)(N.rtr));
  assert.equal(scope({ filters: { measured: true } }).visiblePredicate(measured)(N.vivo), false);
  assert.ok(scope({ filters: { measured: true } }).visiblePredicate(measured)(N.meas));
  assert.equal(scope({ filters: { hideDir: true } }).visiblePredicate(measured)(N.nom), false);
});

test("computeRoute: prioridad ESTRICTA medido > vivo > nominal", () => {
  const now = Date.now();
  const FAR = { lat: 9, lon: 9 };
  const s = { useLive: true, rangeKm: 5, hopLimit: 10, pointA: { lat: 0, lon: 0 }, pointB: { lat: 1, lon: 1 } };
  // ruta corta por 1 nominal vs ruta viva más larga → elige la viva
  let nodes = { L0: { id: "L0", lat: 0.02, lon: 0, t: now }, E: { id: "E", lat: 1.001, lon: 1, t: now }, Nom: { id: "Nom", ...FAR }, L1: { id: "L1", ...FAR, t: now }, L2: { id: "L2", ...FAR, t: now } };
  let g = build(nodes, [["L0", "Nom", { live: false }], ["Nom", "E", { live: false }], ["L0", "L1", { live: false }], ["L1", "L2", { live: false }], ["L2", "E", { live: false }]]);
  let r = scope({ ...s, liveLinks: {} }).computeRoute(nodes, g.adj, g.et);
  assert.ok(!r.path.includes("Nom"), "no debe usar el nominal si hay vía viva");
  assert.equal(r.nominal, 0);
  // medido vs modelado (ambos vivos) → elige medido
  nodes = { L0: { id: "L0", lat: 0.02, lon: 0, t: now }, E: { id: "E", lat: 1.001, lon: 1, t: now }, P: { id: "P", ...FAR, t: now } };
  g = build(nodes, [["L0", "E", { live: false }], ["L0", "P", { live: true, snr: 5 }], ["P", "E", { live: true, snr: 4 }]]);
  r = scope({ ...s, liveLinks: {} }).computeRoute(nodes, g.adj, g.et);
  assert.equal(r.path.join(), "L0,P,E");
  assert.equal(r.tier, "medida");
  // solo hay ruta por nominal → la usa (último recurso)
  nodes = { N1: { id: "N1", lat: 0.02, lon: 0 }, N2: { id: "N2", lat: 1.001, lon: 1 } };
  g = build(nodes, [["N1", "N2", { live: false }]]);
  r = scope({ ...s, liveLinks: {} }).computeRoute(nodes, g.adj, g.et);
  assert.equal(r.tier, "hibrida");
  assert.equal(r.nominal, 2);
});

test("activeNodes: fusiona por nombre único; NO fusiona nombres duplicados", () => {
  const now = Date.now();
  const embeddedNodes = {
    dupA: { id: "dupA", name: "Meshtastic", lat: -33.1, lon: -70.1, placeholder: true },
    dupB: { id: "dupB", name: "Meshtastic", lat: -33.2, lon: -70.2, placeholder: true },
    uniq: { id: "uniq", name: "Cerro Renca", alias: "CRNC", lat: -33.4, lon: -70.7, role: "ROUTER", placeholder: true },
  };
  const liveNodes = {
    "111": { id: "111", name: "Meshtastic", t: now },   // duplicado → NO fusiona
    "222": { id: "222", name: "Cerro Renca", t: now },   // único → fusiona bajo 222
  };
  const { nodes } = scope({ embeddedNodes, liveNodes }).activeNodes();
  assert.ok(nodes["222"]);
  assert.equal(Math.round(nodes["222"].lat * 10), -334);       // heredó coords del directorio
  assert.equal(nodes["222"].role, "ROUTER");
  assert.equal(nodes["uniq"], undefined);                       // gemelo único reemplazado
  assert.ok(nodes["dupA"] && nodes["dupB"]);                    // duplicados intactos
  assert.equal(nodes["111"], undefined);                        // vivo ambiguo sin pos → no dibujable
});

test("buildGraph: enlace > 100 km = puente internet (fuera del ruteo)", () => {
  const now = Date.now();
  const nodes = { stgo: { id: "stgo", lat: -33.45, lon: -70.66, t: now }, local: { id: "local", lat: -33.5, lon: -70.7, t: now }, conce: { id: "conce", lat: -36.82, lon: -73.05, t: now } };
  const liveLinks = { stgo: { from: "stgo", t: now, nb: { local: { snr: 6, t: now, src: "gw" }, conce: { snr: -2, t: now, src: "gw" } } } };
  const { edges, adj, realCount, bridgeCount } = scope({ useLive: true, liveLinks }).buildGraph(nodes);
  const bridges = edges.filter((e) => e.bridge);
  assert.equal(bridgeCount, 1);
  assert.equal(bridges[0].b, "conce");
  assert.equal(realCount, 1);                                   // solo el enlace RF corto
  assert.equal((adj.get("stgo") || new Set()).has("conce"), false); // puente NO rutea
});

test("seenAt: prefiere `seen` (escucha real) sobre `t` (hora de escritura)", () => {
  const { seenAt } = scope({});
  assert.equal(seenAt({ seen: 111, t: 999 }), 111);
  assert.equal(seenAt({ t: 999 }), 999);          // sin seen, cae a t
  assert.equal(seenAt({}), null);
  assert.equal(seenAt(null), null);
});

test("activeNodes: en MeshCore el nodo vencido se DEGRADA (stale), no desaparece", () => {
  const now = Date.now();
  const viejo = now - 5 * 3600 * 1000;            // 5 h > TTL de 2 h
  const liveNodes = { n1: { id: "n1", name: "Viejo", lat: -33, lon: -70, t: now, seen: viejo } };
  // MeshCore: se conserva marcado como stale (no hay directorio que lo reponga)
  const mc = scope({ proto: "mc", ttlHours: 2, liveNodes }).activeNodes();
  assert.ok(mc.nodes["n1"], "en MeshCore sigue dibujándose");
  assert.equal(mc.nodes["n1"].stale, true);
  assert.equal(mc.hasLive, false, "pero NO cuenta como vivo");
  // Meshtastic: se descarta como antes
  const mt = scope({ proto: "mt", ttlHours: 2, liveNodes }).activeNodes();
  assert.equal(mt.nodes["n1"], undefined);
});

test("activeNodes: la edad se mide con `seen`, no con la hora de escritura", () => {
  const now = Date.now();
  // t recién escrito pero seen viejo: NO debe considerarse vivo
  const liveNodes = { n1: { id: "n1", name: "X", lat: -33, lon: -70, t: now, seen: now - 10 * 3600 * 1000 } };
  const r = scope({ proto: "mc", ttlHours: 2, liveNodes }).activeNodes();
  assert.equal(r.nodes["n1"].stale, true, "t=ahora no puede disfrazar de vivo a un nodo callado hace 10 h");
});

test("computeRoute: 'medida' exige SNR en TODOS los saltos, no solo enlaces vivos", () => {
  const now = Date.now();
  const FAR = { lat: 9, lon: 9 };
  const s = { useLive: true, rangeKm: 5, hopLimit: 10, pointA: { lat: 0, lon: 0 }, pointB: { lat: 1, lon: 1 } };
  const nodes = { L0: { id: "L0", lat: 0.02, lon: 0, t: now }, E: { id: "E", lat: 1.001, lon: 1, t: now }, P: { id: "P", ...FAR, t: now } };
  // todos los saltos vivos pero SIN SNR (caso MeshCore: adyacencia del historial)
  let g = build(nodes, [["L0", "P", { live: true, snr: null }], ["P", "E", { live: true, snr: null }]]);
  let r = scope({ ...s }).computeRoute(nodes, g.adj, g.et);
  assert.equal(r.tier, "adyacencia", "sin SNR NO puede llamarse 'medida'");
  assert.equal(r.snrHops, 0);
  assert.equal(r.realHops, 2);
  // mixto: un salto con SNR y otro sin → sigue sin ser 'medida'
  g = build(nodes, [["L0", "P", { live: true, snr: 5 }], ["P", "E", { live: true, snr: null }]]);
  r = scope({ ...s }).computeRoute(nodes, g.adj, g.et);
  assert.equal(r.tier, "adyacencia");
  assert.equal(r.snrHops, 1);
  // todos con SNR → sí es medida
  g = build(nodes, [["L0", "P", { live: true, snr: 5 }], ["P", "E", { live: true, snr: 4 }]]);
  r = scope({ ...s }).computeRoute(nodes, g.adj, g.et);
  assert.equal(r.tier, "medida");
  assert.equal(r.snrHops, 2);
});

test("buildGraph: la arista inversa sin SNR no borra la medición de la directa", () => {
  const now = Date.now();
  const nodes = { a: { id: "a", lat: -33.4, lon: -70.6, t: now }, b: { id: "b", lat: -33.45, lon: -70.65, t: now } };
  // a→b medido con SNR 7; b→a sin SNR (lo escribe otra fuente)
  const liveLinks = {
    a: { from: "a", t: now, nb: { b: { snr: 7, t: now, src: "tr" } } },
    b: { from: "b", t: now, nb: { a: { snr: null, t: now, src: "ruta" } } },
  };
  const { etype } = scope({ useLive: true, liveLinks }).buildGraph(nodes);
  const k = "a|b";
  assert.equal(etype.get(k).snr, 7, "el SNR medido debe sobrevivir a la arista inversa sin dato");
});
