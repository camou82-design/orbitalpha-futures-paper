/**
 * PM2 (Lightsail/Standardized). 
 * Start: pm2 start ecosystem.config.cjs --env production
 */
const path = require("path");

module.exports = {
  apps: [
    {
      name: "lightsail-futures-paper-api",
      cwd: __dirname,
      script: "npm",
      args: "start",
      instances: 1,
      autorestart: true,
      max_memory_restart: "250M",
      // Standard Env
      env: {
        NODE_ENV: "production",
        PORT: 3991,
        ORBITALPHA_FUTURES_PAPER_ROOT: path.resolve(__dirname, ".."),
        ORBITALPHA_FUTURES_PAPER_API_SECRET: "PLACEHOLDER_CHANGE_ME"
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 3991,
        // Production values should be injected via CLI or local .env
      }
    }
  ]
};
