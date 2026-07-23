module.exports = {
  apps: [
    {
      name: "mesh-bridge",
      script: "bridge.js",
      env: {
        // Debe coincidir con la databaseURL del frontend (proyecto meshcheckci).
        // Confirma la URL exacta en la consola tras crear la Realtime Database.
        RTDB_URL: "https://meshcheckci-default-rtdb.firebaseio.com",
        FB_SECRET: "PEGAR_DATABASE_SECRET",
        // Llave del canal para descifrar el tráfico (base64). Vacío = PSK pública
        // por defecto (LongFast). Si MeshChile usa un canal con llave propia y el
        // diagnóstico muestra "descifrados 0/N", pon aquí su PSK en base64.
        // CHANNEL_KEY: "",
        // Purga TTL: borra nodos/enlaces más viejos que estas horas (default 24)
        // cada PURGE_MIN minutos (default 30). Mantiene la RTDB acotada.
        // PURGE_HOURS: "24",
        // PURGE_MIN: "30",
      },
      max_restarts: 20,
      restart_delay: 5000,
    },
    {
      // Bridge MeshCore → RTDB bajo /mc/* (malla independiente de Meshtastic).
      // Se autentica con un JWT Ed25519 auto-soberano (identidad de software).
      name: "meshcore-bridge",
      script: "meshcore-bridge.js",
      env: {
        RTDB_URL: "https://meshcheckci-default-rtdb.firebaseio.com",
        FB_SECRET: "PEGAR_DATABASE_SECRET",
        // Broker MeshCore de MeshChile. TCP 1883: es el único transporte donde
        // el broker concede la suscripción a lectores (por WSS silencia la sesión).
        MC_BROKER: "mqtt://mqtt-msc.meshchile.cl:1883",
        // Semilla Ed25519 (32 bytes en hex) para una identidad ESTABLE. Si la
        // dejas vacía, el bridge genera una al arrancar y la imprime en el log:
        // cópiala aquí para reusar el mismo usuario/pubkey entre reinicios.
        // MC_SEED: "",
        // Si el broker rechaza el JWT y usa user/pass fijos, ponlos aquí:
        // MC_USER: "",
        // MC_PASS: "",
        // Purga TTL: igual que el bridge Meshtastic.
        // PURGE_HOURS: "24",
        // PURGE_MIN: "30",
      },
      max_restarts: 20,
      restart_delay: 5000,
    },
  ],
};
