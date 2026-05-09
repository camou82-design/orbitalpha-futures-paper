import { getEngineConfig, getPaperLoopIntervalMs, loadEnv } from "./config/env";
import { createLogger } from "./logs/logger";
import { PaperEngine } from "./engine/paper-engine";

async function main(): Promise<void> {
  loadEnv();
  const config = getEngineConfig();
  const logger = createLogger(config.logLevel);
  const { intervalMs, delayReason } = getPaperLoopIntervalMs(process.env);

  logger.info("paper_loop_started", { intervalMs, loop_delay_reason: delayReason });

  const engine = new PaperEngine(config, logger);
  let running = false;

  const runOnceSafe = async (phase: "initial" | "interval"): Promise<void> => {
    if (running) {
      logger.info("paper_loop_skipped", {
        reason: "previous_run_in_progress",
        next_loop_delay_ms: intervalMs,
        loop_delay_reason: delayReason
      });
      return;
    }
    running = true;
    try {
      logger.info("paper_loop_tick", { phase });
      await engine.runOnce();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : undefined;
      logger.error("paper_loop_error", {
        phase,
        error_message: msg,
        error_name: e instanceof Error ? e.name : typeof e,
        error_stack: stack ?? null
      });
    } finally {
      running = false;
    }
  };

  const scheduleNext = () => {
    const { intervalMs: currentInterval } = getPaperLoopIntervalMs(process.env);
    setTimeout(async () => {
      await runOnceSafe("interval");
      scheduleNext();
    }, currentInterval);
  };

  await runOnceSafe("initial");
  scheduleNext();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
