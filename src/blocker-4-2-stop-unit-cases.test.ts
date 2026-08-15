import { evaluateRegimeExitPolicy } from "./strategy/regime-exit";

function runTests() {
  let passed = 0;
  let failed = 0;

  function assertEq(label: string, actual: any, expected: any) {
    if (actual === expected) {
      console.log(`[PASS] ${label}`);
      passed++;
    } else {
      console.error(`[FAIL] ${label} - expected ${expected}, got ${actual}`);
      failed++;
    }
  }

  const baseArgs = {
    regime: "RANGE" as const, // SL = -0.0026
    holdingMs: 1000,
    trailingExtreme: undefined
  };

  // S1: LONG, before stop
  const s1 = evaluateRegimeExitPolicy({
    ...baseArgs, side: "long", entryPrice: 100, stopPrice: 99.74, mark: 99.99, pnlPctNet: -0.001
  });
  assertEq("S1 LONG before stop", s1.action, "hold");

  // S2: LONG, exactly at stop
  const s2 = evaluateRegimeExitPolicy({
    ...baseArgs, side: "long", entryPrice: 100, stopPrice: 99.74, mark: 99.74, pnlPctNet: -0.0026
  });
  assertEq("S2 LONG exactly at stop", s2.action, "close");

  // S3: LONG, below stop
  const s3 = evaluateRegimeExitPolicy({
    ...baseArgs, side: "long", entryPrice: 100, stopPrice: 99.74, mark: 99.70, pnlPctNet: -0.003
  });
  assertEq("S3 LONG below stop", s3.action, "close");

  // S4: SHORT, before stop
  const s4 = evaluateRegimeExitPolicy({
    ...baseArgs, side: "short", entryPrice: 100, stopPrice: 100.26, mark: 100.01, pnlPctNet: -0.001
  });
  assertEq("S4 SHORT before stop", s4.action, "hold");

  // S5: SHORT, exactly at stop
  const s5 = evaluateRegimeExitPolicy({
    ...baseArgs, side: "short", entryPrice: 100, stopPrice: 100.26, mark: 100.26, pnlPctNet: -0.0026
  });
  assertEq("S5 SHORT exactly at stop", s5.action, "close");

  // S6: SHORT, above stop
  const s6 = evaluateRegimeExitPolicy({
    ...baseArgs, side: "short", entryPrice: 100, stopPrice: 100.26, mark: 100.30, pnlPctNet: -0.003
  });
  assertEq("S6 SHORT above stop", s6.action, "close");

  // S7: leverage 10, pnl_pct_net < -0.26%, but mark not at stop
  const s7 = evaluateRegimeExitPolicy({
    ...baseArgs, side: "long", entryPrice: 100, stopPrice: 99.74, mark: 99.99, pnlPctNet: -0.01 // pnl is -1% due to lev+fee
  });
  assertEq("S7 leverage 10 fee drag", s7.action, "hold");

  // S8: leverage 20, pnl_pct_net < -0.26%, but mark not at stop
  const s8 = evaluateRegimeExitPolicy({
    ...baseArgs, side: "long", entryPrice: 100, stopPrice: 99.74, mark: 99.99, pnlPctNet: -0.02
  });
  assertEq("S8 leverage 20 fee drag", s8.action, "hold");

  // 8. 실제 라이브 incident regression (BTCUSDT Long)
  const btcCase = evaluateRegimeExitPolicy({
    ...baseArgs, side: "long", entryPrice: 63000.9, stopPrice: 62837.09766, mark: 62995.9, pnlPctNet: -0.012805476439565725
  });
  assertEq("LIVE_BTC_FALSE_STOP_AFTER_FIX", btcCase.action, "hold");

  // 9. 실제 stop 도달 테스트 (BTCUSDT Long)
  const btcCaseBreach = evaluateRegimeExitPolicy({
    ...baseArgs, side: "long", entryPrice: 63000.9, stopPrice: 62837.09766, mark: 62837.0, pnlPctNet: -0.015
  });
  assertEq("LIVE_BTC_ACTUAL_STOP_BREACHED", btcCaseBreach.action, "close");

  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

runTests();
