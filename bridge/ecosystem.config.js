module.exports = {
  apps: [
    {
      name: "mesh-bridge",
      script: "bridge.js",
      env: {
        // Rellenar con los valores de tu proyecto Firebase:
        RTDB_URL: "https://TU-PROYECTO-default-rtdb.firebaseio.com",
        FB_SECRET: "PEGAR_DATABASE_SECRET",
      },
      max_restarts: 20,
      restart_delay: 5000,
    },
  ],
};
