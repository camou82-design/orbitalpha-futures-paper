import { getEngineConfig, loadEnv } from "./config/env";
import { createLogger } from "./logs/logger";
import { PaperEngine } from "./engine/paper-engine";

async function main(): Promise<void> {
  loadEnv();
  const config = getEngineConfig();
  const logger = createLogger(config.logLevel);

  logger.info("paper engine skeleton ready", {
    symbols: config.symbols,
    leverage: config.leverage,
    longOnly: config.longOnly
  });

  const engine = new PaperEngine(config, logger);
  await engine.runOnce();
}

main().catch((err) => {
  // keep startup failure visible in console
  console.error(err);
  process.exitCode = 1;
});

