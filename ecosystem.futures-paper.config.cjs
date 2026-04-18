/**
 * pm2: paper loop only (Bybit public, no orders).
 * Start from repo root: pm2 start ecosystem.futures-paper.config.cjs
 * Do not merge with orbitalpha-trading; use a separate app name and cwd.
 */
const path = require("path");

module.exports = {
  apps: [
    {
      name: "orbitalpha-futures-paper-loop",
      cwd: path.resolve(__dirname),
      script: "node",
      args: "dist/loop.js",
      instances: 1,
      autorestart: true,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production"
      },
      env_production: {
        NODE_ENV: "production"
      }
    }
  ]
};
