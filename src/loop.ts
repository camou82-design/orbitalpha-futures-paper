import { getEngineConfig, loadEnv } from "./config/env";
import { createLogger } from "./logs/logger";
import { PaperEngine } from "./engine/paper-engine";

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 1_000;

function parseLoopIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.ORBITALPHA_PAPER_LOOP_INTERVAL_MS;
  const n = raw === undefined || raw === "" ? DEFAULT_INTERVAL_MS : Number(raw);
  if (!Number.isFinite(n) || n < MIN_INTERVAL_MS) return DEFAULT_INTERVAL_MS;
  return Math.floor(n);
}

async function main(): Promise<void> {
  loadEnv();
  const config = getEngineConfig();
  const logger = createLogger(config.logLevel);
  const intervalMs = parseLoopIntervalMs(process.env);

  logger.info("paper_loop_started", { intervalMs });

  const engine = new PaperEngine(config, logger);
  let running = false;

  const runOnceSafe = async (phase: "initial" | "interval"): Promise<void> => {
    if (running) {
      logger.info("paper_loop_skipped", { reason: "previous_run_in_progress" });
      return;
    }
    running = true;
    try {
      logger.info("paper_loop_tick", { phase });
      await engine.runOnce();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("paper_loop_error", { error: msg });
    } finally {
      running = false;
    }
  };

  await runOnceSafe("initial");

  setInterval(() => {
    void runOnceSafe("interval");
  }, intervalMs);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
