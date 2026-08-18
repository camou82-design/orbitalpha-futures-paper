import { evaluateRegimeExitPolicy } from "./strategy/regime-exit";
import * as assert from "assert";

function runTests() {
  let passed = 0;
  let failed = 0;
  function report(name: string, ok: boolean, diag?: any) {
    if (ok) {
      console.log(`[PASS] ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name}`, diag || "");
      failed++;
    }
  }

  // T1 RANGE long false early TP
  // In RANGE, TP is 0.0038
  // Old behavior: 10x leverage, +0.10% move -> pnlPctNet = 0.01 -> false early TP
  // New behavior: +0.10% move -> priceMoveFrac = 0.0010 < 0.0038 -> hold
  {
    const entryPrice = 100;
    const mark = 100.10;
    const priceMoveFrac = (mark - entryPrice) / entryPrice; // 0.001
    const pnlPctNet = 0.01; // 1% ROI because of 10x leverage
    const res = evaluateRegimeExitPolicy({
      regime: "RANGE",
      side: "long",
      pnlPctNet,
      holdingMs: 1000,
      mark,
      entryPrice,
      trailingExtreme: undefined
    });
    report("T1 RANGE long false early TP", res.action === "hold", res);
  }

  // T2 RANGE short false early TP
  {
    const entryPrice = 100;
    const mark = 99.90; // -0.10% move
    const pnlPctNet = 0.01; // 1% ROI
    const res = evaluateRegimeExitPolicy({
      regime: "RANGE",
      side: "short",
      pnlPctNet,
      holdingMs: 1000,
      mark,
      entryPrice,
      trailingExtreme: undefined
    });
    report("T2 RANGE short false early TP", res.action === "hold", res);
  }

  // T3 exact RANGE TP reaches close
  {
    const entryPrice = 100;
    const mark = 100.38; // +0.38% move
    const pnlPctNet = 0.038;
    const res = evaluateRegimeExitPolicy({
      regime: "RANGE",
      side: "long",
      pnlPctNet,
      holdingMs: 1000,
      mark,
      entryPrice,
      trailingExtreme: undefined
    });
    report("T3 exact RANGE TP reaches close", res.action === "close" && res.reason === "take_profit", res);
  }

  // T4 just-before TP holds
  {
    const entryPrice = 100;
    const mark = 100.24; // +0.24% move (just before 0.25% TP)
    const pnlPctNet = 0.024;
    const res = evaluateRegimeExitPolicy({
      regime: "RANGE",
      side: "long",
      pnlPctNet,
      holdingMs: 1000,
      mark,
      entryPrice,
      trailingExtreme: undefined
    });
    report("T4 just-before TP holds", res.action === "hold", res);
  }

  // T5 leverage 1x / 5x / 10x / 20x 동일 TP breach 판정
  {
    const entryPrice = 100;
    const mark = 100.38; // TP
    const leverages = [1, 5, 10, 20];
    let ok = true;
    for (const lev of leverages) {
      const pnlPctNet = 0.0038 * lev;
      const res = evaluateRegimeExitPolicy({
        regime: "RANGE",
        side: "long",
        pnlPctNet,
        holdingMs: 1000,
        mark,
        entryPrice,
        trailingExtreme: undefined
      });
      if (res.action !== "close") ok = false;
    }
    report("T5 leverage variation does not change TP breach", ok);
  }

  // T6 fee variation does not change TP breach
  {
    const entryPrice = 100;
    const mark = 100.38;
    const pnlPctNet1 = 0.038 - 0.001; // fee 0.1%
    const pnlPctNet2 = 0.038 - 0.002; // fee 0.2%
    const res1 = evaluateRegimeExitPolicy({
      regime: "RANGE",
      side: "long",
      pnlPctNet: pnlPctNet1,
      holdingMs: 1000,
      mark,
      entryPrice,
      trailingExtreme: undefined
    });
    const res2 = evaluateRegimeExitPolicy({
      regime: "RANGE",
      side: "long",
      pnlPctNet: pnlPctNet2,
      holdingMs: 1000,
      mark,
      entryPrice,
      trailingExtreme: undefined
    });
    report("T6 fee variation does not change TP breach", res1.action === "close" && res2.action === "close");
  }

  // T7 runner long (TREND runnerTp = 0.0075, RANGE runnerTp = 0.0028)
  {
    const entryPrice = 100;
    const mark = 100.28; // +0.28%
    const res = evaluateRegimeExitPolicy({
      regime: "RANGE",
      side: "long",
      pnlPctNet: 0.028, // irrelevant now
      holdingMs: 1000,
      mark,
      entryPrice,
      trailingExtreme: undefined,
      exitProfile: "runner"
    });
    report("T7 runner long RANGE", res.action === "close" && res.reason === "take_profit", res);
  }

  // T8 runner short TREND
  {
    const entryPrice = 100;
    const mark = 99.25; // -0.75%
    const res = evaluateRegimeExitPolicy({
      regime: "TREND",
      side: "short",
      pnlPctNet: 0.075, // irrelevant
      holdingMs: 1000,
      mark,
      entryPrice,
      trailingExtreme: undefined,
      exitProfile: "runner"
    });
    report("T8 runner short TREND", res.action === "close" && res.reason === "take_profit", res);
  }

  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

runTests();
