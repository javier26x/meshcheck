# MeshCheck Live — Bridge MQTT (VPS) + Firebase RTDB + Frontend

Proyecto para convertir **MeshCheck** (visor de cobertura de la malla MeshChile) de un
modelo estático de línea recta a un **visor de malla en vivo**: posiciones reales de los
nodos y adyacencia real (quién escucha a quién, con SNR) leídas del MQTT de MeshChile.

Autor/contexto: fRoDy (Frody Labs). Stack existente: VPS `45.236.130.115`, nginx, PM2,
Docker, PocketBase, WAHA, Cloudflare DNS. Frontend siempre single-file HTML/JS sin build,
ECharts/Leaflet/SheetJS por CDN. Marca visual del tool ya definida (tema oscuro táctico,
DM Sans + JetBrains Mono, acento signal-orange `#ff7a1a`).

---

## Objetivo

```
MeshChile MQTT ──persistente──► [VPS: bridge PM2] ──REST PATCH──► Firebase RTDB ──live──► MeshCheck (Firebase Hosting)
```

- **VPS**: único componente persistente. Mantiene el socket MQTT abierto 24/7, cosecha
  `position` y `neighborinfo`, y empuja a RTDB por REST. No expone puertos, solo escribe.
- **Firebase**: RTDB como fuente de verdad en vivo + Hosting del frontend. Todo stateless.
- **Frontend**: MeshCheck lee RTDB con el SDK. **Fallback**: si RTDB viene vacío, usa los
  271 nodos embebidos que ya trae (no romper el modo offline/predicción).

Razón de la partición: las Cloud Functions no pueden mantener un socket MQTT abierto
(request/response, escalan a cero). El VPS ya está corriendo y es el patrón WAHA/PocketBase.

---

## PASO 0 — Validación previa (bloqueante, hacer primero)

Confirmar que MeshChile publica el topic **decodificado en JSON**:

```bash
mosquitto_sub -h mqtt.meshchile.cl -u mshcl2025 -P meshtastic.cl -t 'msh/CL/2/json/#' -v
```

- Si salen objetos JSON legibles con `"type":"position"` / `"type":"neighborinfo"` → seguir tal cual.
- Si sale **vacío** pero el catch-all `-t 'msh/CL/#'` sí trae tráfico → los gateways publican
  **cifrado**. En ese caso el bridge debe descifrar con la llave del canal MeshChile antes de
  parsear (config MeshChile: Región AU/NZ 915–928, LongFast, Slot 20, 919.875 MHz). Anotar esto
  como tarea condicional; NO asumir. Preguntar/ajustar si aplica.

Credenciales MQTT (del sitio MeshChile): host `mqtt.meshchile.cl`, user `mshcl2025`,
pass `meshtastic.cl`, root topic `msh/CL`.

---

## PASO 1 — Bridge en el VPS

Crear `~/mesh-bridge/` con estos archivos.

### `bridge.js`
```js
const mqtt = require("mqtt");

const RTDB = process.env.RTDB_URL;      // https://TU-PROYECTO-default-rtdb.firebaseio.com
const SECRET = process.env.FB_SECRET;   // Firebase database secret (auth admin, salta reglas)

const push = async (path, data) => {
  try {
    const r = await fetch(`${RTDB}/${path}.json?auth=${SECRET}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) console.error("push", path, r.status);
  } catch (e) { console.error("push fail", e.message); }
};

const client = mqtt.connect("mqtt://mqtt.meshchile.cl:1883", {
  username: "mshcl2025", password: "meshtastic.cl", reconnectPeriod: 5000,
});

client.on("connect", () => { console.log("MQTT ok"); client.subscribe("msh/CL/2/json/#"); });
client.on("reconnect", () => console.log("reconnecting…"));
client.on("error", (e) => console.error("mqtt err", e.message));

let buf = {};
client.on("message", (_topic, raw) => {
  try {
    const p = JSON.parse(raw.toString());
    if (p.type === "position" && p.payload?.latitude_i) {
      buf[`nodes/${p.from}`] = {
        id: p.from,
        name: p.payload.name || String(p.from),
        lat: p.payload.latitude_i / 1e7,
        lon: p.payload.longitude_i / 1e7,
        t: Date.now(),
      };
    }
    if (p.type === "neighborinfo" && p.payload?.neighbors) {
      buf[`links/${p.from}`] = {
        from: p.from,
        neighbors: p.payload.neighbors.map((n) => ({ id: n.node_id, snr: n.snr })),
        t: Date.now(),
      };
    }
  } catch (e) { /* no-JSON o cifrado: ignorar (ver PASO 0) */ }
});

// flush por lotes cada 5s para no martillar RTDB
setInterval(async () => {
  const keys = Object.keys(buf);
  if (!keys.length) return;
  const batch = buf; buf = {};
  for (const k of keys) await push(k, batch[k]);
  console.log(`flushed ${keys.length}`);
}, 5000);

console.log("mesh-bridge iniciado");
```

### `ecosystem.config.js`
```js
module.exports = {
  apps: [{
    name: "mesh-bridge",
    script: "bridge.js",
    env: {
      RTDB_URL: "https://TU-PROYECTO-default-rtdb.firebaseio.com",
      FB_SECRET: "PEGAR_DATABASE_SECRET",
    },
    max_restarts: 20,
    restart_delay: 5000,
  }],
};
```

### Deploy en el VPS
```bash
mkdir -p ~/mesh-bridge && cd ~/mesh-bridge
npm init -y && npm install mqtt
# crear bridge.js y ecosystem.config.js (rellenar RTDB_URL y FB_SECRET)
pm2 start ecosystem.config.js
pm2 save
pm2 logs mesh-bridge --lines 30   # verificar "MQTT ok" y "flushed N"
```

Node 18+ requerido (usa `fetch` nativo). Verificar `node -v`; si es <18, usar `node-fetch` o
actualizar node.

---

## PASO 2 — Firebase

### Reglas RTDB (`database.rules.json`)
Lectura pública, escritura solo por el secret (el bridge lo usa y salta las reglas):
```json
{
  "rules": {
    "nodes": { ".read": true, ".write": false },
    "links": { ".read": true, ".write": false }
  }
}
```
```bash
firebase deploy --only database
```

### Database secret
Firebase Console → Project Settings → Service accounts → Database secrets (legacy).
Si están deshabilitados, generar un token de service account y adaptar el `auth=` del bridge,
o usar el SDK admin con service-account JSON en vez de REST+secret.

---

## PASO 3 — Frontend (MeshCheck)

Base: el archivo `meshcheck.html` ya existente (single-file, Leaflet + tema oscuro, 271 nodos
embebidos en `const NODES`). Modificar para:

1. Cargar Firebase SDK (compat o modular por CDN) e inicializar con la config del proyecto.
2. Suscribirse a `nodes` y `links` de RTDB:
   ```js
   onValue(ref(db, "nodes"), s => { liveNodes = s.val() || {}; redraw(); });
   onValue(ref(db, "links"), s => { liveLinks = s.val() || {}; redraw(); });
   ```
3. **Merge + fallback**: si `liveNodes` está vacío → usar los `NODES` embebidos (modo predicción).
   Si hay datos vivos → dibujar nodos vivos y, además, las **líneas de adyacencia real**
   (`links[].neighbors`) coloreadas por SNR (verde SNR alto → rojo SNR bajo). Esto es
   literalmente "la cobertura de cada nodo": los enlaces observados, medidos, no modelados.
4. **TTL**: filtrar nodos/links con `Date.now() - t > 2h` para no mostrar nodos muertos.
5. Mantener el análisis BFS existente (saltos, hop limit, repetidor hipotético) operando sobre
   el set vivo cuando exista; conservar los controles de alcance como capa de predicción sobre
   los nodos que no reportan NeighborInfo (cobertura real es parcial: el módulo va apagado por
   default en muchos nodos).
6. Toggle "Malla en vivo / Modelo" para alternar entre adyacencia real y el modelo de distancia.

Preservar estilo: DM Sans + JetBrains Mono, acento `#ff7a1a`, nodos cyan `#3fb6c9`,
elevados/router amarillo `#ffd23f`, endpoints A `#5b8cff` / B `#ff5b8c`.

### Deploy frontend
```bash
firebase deploy --only hosting
```

---

## Notas de diseño / gotchas

- **Cobertura ≠ polígono**: Meshtastic no expone áreas de cobertura; es emergente de los enlaces
  observados (NeighborInfo + nodeDB). El mapa de "cobertura" = grafo de adyacencia real con SNR.
- **NeighborInfo parcial**: módulo apagado por default y chismoso → no todos lo emiten. Esperar
  cobertura de enlaces incompleta; complementar con el modelo de distancia para huecos.
- **Cifrado** (ver PASO 0): plan B si `/json/` no publica claro.
- **TTL / cleanup**: nodos móviles y apagados dejan basura; filtrar por `t`.
- **Costo**: bridge reusa el VPS (0 extra). Firebase RTDB + Hosting en free tier para este volumen.
- **DNS**: subdominio en Cloudflare si se quiere `meshcheck.frody.cl` apuntando a Firebase Hosting
  (o mantener en el hosting de Firebase con su dominio).

## Criterio de "listo"
1. `pm2 logs mesh-bridge` muestra `MQTT ok` y `flushed N` recurrente.
2. RTDB (`/nodes`, `/links`) se puebla en la consola de Firebase.
3. MeshCheck en vivo dibuja nodos reales + líneas de adyacencia por SNR, con fallback a los 271
   embebidos cuando RTDB está vacío.
4. Toggle vivo/modelo funciona; TTL descarta nodos viejos.
