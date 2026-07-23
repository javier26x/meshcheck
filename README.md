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
│   ├── bridge.js           # MQTT MeshChile (Meshtastic) → RTDB (VPS, persistente)
│   ├── meshtastic.js       # descifrado AES-CTR + parser protobuf (Meshtastic)
│   ├── meshcore.js         # decoder de ADVERT MeshCore + JWT Ed25519 del broker
│   ├── meshcore-bridge.js  # MQTT/WSS MeshCore → RTDB bajo /mc/* (VPS, persistente)
│   ├── ecosystem.config.js # PM2 (dos apps: mesh-bridge y meshcore-bridge)
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

### 3b. Bridge MeshCore (opcional — malla independiente)

MeshChile corre **también** una malla [MeshCore](https://meshcore.co.uk/), con
otro protocolo y otro broker. MeshCheck la muestra en el **mismo mapa** con el
toggle **Meshtastic / MeshCore** (arriba a la izquierda); son dos fuentes de datos
separadas (dos raíces en la RTDB: Meshtastic en `/nodes,/links,/meta`, MeshCore
bajo `/mc/*`), así que ninguna pisa a la otra.

A diferencia de Meshtastic, MeshCore **no publica JSON**: cada *observador* (un
nodo con firmware MeshCore + puente MQTT) reenvía al broker los paquetes de RF
que escucha, en `meshcore/{IATA}/{PUBKEY}/packets`. El bridge:

1. se autentica con un **JWT Ed25519 auto-soberano** (identidad de software, sin
   hardware — `bridge/meshcore.js` genera la clave y firma el token que el broker
   acepta),
2. se suscribe a `meshcore/#`,
3. decodifica los **ADVERT** (posición + nombre + modo del nodo emisor),
4. modela *quién escuchó a quién*: el observador del topic oyó ese advert, así
   que crea el enlace **observador ↔ nodo** (análogo al "gw" de Meshtastic).

```bash
cd bridge
# edita ecosystem.config.js (app "meshcore-bridge"): RTDB_URL, FB_SECRET, MC_BROKER
# la primera vez, arráncalo y copia el MC_SEED que imprime (identidad estable):
node meshcore-bridge.js            # imprime "MC_SEED: ..." → pégalo en el config
pm2 start ecosystem.config.js      # levanta mesh-bridge Y meshcore-bridge
pm2 save
pm2 logs meshcore-bridge --lines 30  # verifica "MeshCore MQTT ok" y "adverts N"
```

El log imprime las primeras 3 muestras crudas por topic: si el broker envía otro
formato de mensaje (no `{raw_hex,snr}`), `extractPacket` ya tolera hex pelado o
bytes crudos, pero esas muestras confirman el esquema real. Escribe
`/mc/nodes/<pubkey>`, `/mc/links/<obs>/nb/<nodo>` y `/mc/meta/stats`.

> Si el broker rechazara el JWT (cambió el esquema de auth), pon `MC_USER`/`MC_PASS`
> en el config y el bridge usará esas credenciales fijas en vez del token.

**Diagnóstico**: `node tools/diag.mjs` lee la RTDB pública y dicta un veredicto
(versión del bridge, tráfico por topic, descifrado por canal, enlaces
dibujables, correlación por nombre directorio↔vivo).

**Eficiencia del bridge**: escribe con un solo PATCH multi-ubicación por lote,
deduplica (solo escribe lo que cambió; refresca `t` cada 5–10 min) y **purga**
periódicamente lo más viejo que `PURGE_HOURS` (default 24h) para que la RTDB no
crezca sin límite. El frontend escucha `child_*` (no `value`) para bajar solo lo
que cambió.

**Tests / CI**: `npm test` (node:test) cubre bridge (dedupe/purga), descifrado
Meshtastic (protobuf/AES), MeshCore (decoder de ADVERT + JWT que se valida contra
la pubkey + procesamiento del bridge), extractor y la lógica del frontend (ruteo
con prioridad estricta, filtros, clasificación de puentes). GitHub Actions corre los
tests en cada push (`.github/workflows/ci.yml`) y refresca el snapshot a diario
(`refresh-nodes.yml`).

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
