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
      },
      max_restarts: 20,
      restart_delay: 5000,
    },
  ],
};
