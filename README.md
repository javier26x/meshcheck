# MeshCheck Live

Visor de la malla **MeshChile** en vivo: posiciones reales de nodos y adyacencia
observada (quién escucha a quién, con SNR) leídas del MQTT de MeshChile, con
fallback a un modelo de alcance por distancia.

```
MeshChile MQTT ──persistente──► [VPS: bridge PM2] ──REST PATCH──► Firebase RTDB ──live──► MeshCheck (Hosting)
```

Basado en el brief `MESHCHECK_LIVE.md`.

---

## Estructura

```
meshcheck/
├── frontend/
│   ├── meshcheck.html      # app single-file (Leaflet + Firebase, sin build)
│   └── nodes.json          # fallback embebido (placeholder → reemplazar, ver abajo)
├── bridge/
│   ├── bridge.js           # MQTT MeshChile → RTDB (VPS, persistente)
│   ├── ecosystem.config.js # PM2
│   └── package.json
├── tools/
│   └── fetch_nodes.mjs     # extrae los nodos del mapa de MeshChile → nodes.json
├── firebase.json           # Hosting (frontend) + rules de la RTDB
├── database.rules.json     # lectura pública, escritura solo por el bridge (secret)
└── .firebaserc
```

---

## Sobre los nodos de `meshchile.cl/nodes/map`

> **Nota de transparencia.** Este repo se generó en un entorno cuyo egress tiene
> **bloqueado `meshchile.cl`** (y sus subdominios) por política de red, así que
> **no fue posible scrapear el listado en vivo desde aquí**. El `nodes.json`
> incluido es un **placeholder** con anclas geográficas reales de ciudades
> chilenas (no son nodos de la malla) solo para que el modo Modelo renderice.

Para poblar los nodos reales, corre el extractor **desde una red con acceso a
`meshchile.cl`** (tu máquina o el VPS):

```bash
node tools/fetch_nodes.mjs
# o forzando el endpoint que veas en la pestaña Network del navegador:
node tools/fetch_nodes.mjs 'https://meshchile.cl/....'
```

El script autodetecta la API del mapa (lee `/nodes/map`, busca su endpoint JSON
y prueba varios candidatos), normaliza cualquier forma de JSON de mapas
Meshtastic (`node_id/num/id`, `long_name/user.longName`, `latitude/latitude_i`,
GeoJSON, objetos keyed…) y escribe `frontend/nodes.json`. Luego:

```bash
firebase deploy --only hosting
```

El frontend usa este archivo **solo como fallback**: si la RTDB trae datos vivos,
esos mandan.

---

## Puesta en marcha

### 1. Validación previa del MQTT (bloqueante — hacer primero)

Confirmar que MeshChile publica el topic decodificado en JSON:

```bash
mosquitto_sub -h mqtt.meshchile.cl -u mshcl2025 -P meshtastic.cl -t 'msh/CL/2/json/#' -v
```

- JSON legible con `"type":"position"` / `"type":"neighborinfo"` → seguir tal cual.
- Vacío pero `-t 'msh/CL/#'` sí trae tráfico → los gateways publican **cifrado**;
  el bridge deberá descifrar con la llave del canal antes de parsear (tarea
  condicional; ver `MESHCHECK_LIVE.md` PASO 0).

### 2. Firebase

```bash
firebase login
# edita .firebaserc y pon tu projectId; crea una Realtime Database en la consola
firebase deploy --only database          # aplica database.rules.json
```

Consigue un **database secret** (Console → Project settings → Service accounts →
Database secrets) para que el bridge escriba saltándose las reglas.

### 3. Bridge en el VPS (persistente)

```bash
cd bridge
npm install                              # requiere Node 18+
# edita ecosystem.config.js: RTDB_URL y FB_SECRET
pm2 start ecosystem.config.js
pm2 save
pm2 logs mesh-bridge --lines 30          # verifica "MQTT ok" y "flushed N"
```

El bridge escribe `/nodes/<id>` (posición), `/links/<id>` (adyacencia real con
SNR: NeighborInfo del nodo **y** recepciones directas de cada gateway MQTT,
`hops_away=0`) y `/meta/stats` (diagnóstico de tipos de mensaje, visible en el
pie del panel del visor).

**Descifrado**: el grueso del tráfico de MeshChile viaja cifrado en el topic
`msh/CL/2/e/...`. `bridge/meshtastic.js` lo descifra (AES-CTR con la PSK pública
del canal LongFast + parser protobuf, sin dependencias) para cosechar posición,
nombre, rol, telemetría, NeighborInfo y traceroute. Si algún canal usa una llave
propia y el diagnóstico muestra `descifrados 0/N`, pon su PSK (base64) en la env
`CHANNEL_KEY` de `ecosystem.config.js`.

**Diagnóstico**: `node tools/diag.mjs` lee la RTDB pública y dicta un veredicto
(versión del bridge, tráfico por topic, descifrado, enlaces dibujables, calce de
IDs snapshot↔vivo).

### 4. Frontend

Edita `FIREBASE_CONFIG` al inicio del `<script>` en `frontend/meshcheck.html`
(Console → Project settings → SDK setup). Mientras diga `TU-PROYECTO`, el visor
arranca en modo Modelo con `nodes.json`.

```bash
firebase deploy --only hosting
```

---

## Qué hace el visor

- **Malla en vivo**: dibuja los nodos reales de la RTDB y las líneas de
  adyacencia observada, coloreadas por **SNR** (verde alto → rojo bajo). Eso es,
  literalmente, la cobertura medida: enlaces observados, no modelados.
- **Modelo**: cuando no hay datos vivos (o si lo eliges), estima enlaces por
  **distancia** (slider de alcance por salto) para cubrir los huecos — el módulo
  NeighborInfo va apagado por default en muchos nodos, así que la cobertura real
  es parcial.
- **Análisis BFS**: elige origen A y destino B (clic en el mapa o selectores) y
  calcula los saltos mínimos respetando un **hop limit**; marca si no hay ruta.
- **Repetidor hipotético**: coloca un nodo en el mapa y recalcula la ruta.
- **TTL**: descarta nodos/links más viejos que el umbral (2 h por default) para
  no mostrar nodos muertos.

Estilo: tema oscuro táctico, DM Sans + JetBrains Mono, acento `#ff7a1a`, nodos
cyan `#3fb6c9`, router/elevado amarillo `#ffd23f`, endpoints A `#5b8cff` /
B `#ff5b8c`.

---

## Criterio de "listo"

1. `pm2 logs mesh-bridge` muestra `MQTT ok` y `flushed N` recurrente.
2. La RTDB (`/nodes`, `/links`) se puebla en la consola de Firebase.
3. MeshCheck dibuja nodos reales + líneas de adyacencia por SNR, con fallback a
   `nodes.json` cuando la RTDB está vacía.
4. El toggle vivo/modelo funciona; el TTL descarta nodos viejos.

## Seguridad

- El **database secret** solo vive en el VPS (`ecosystem.config.js` / entorno).
  Nunca lo commitees (`.gitignore` cubre `.env`).
- Las reglas de la RTDB son lectura pública / escritura cerrada: el frontend solo
  lee.
