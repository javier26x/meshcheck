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
  ],
};
