import { evaluateRiskControls, RiskControlDecision } from "../src/engine/risk-control-layer";
import type { Candle, EngineConfig } from "../src/models/types";

const mockConfig = {
  paperMaxOpenPositions: 3,
  paperReentryCooldownMs: 0,
  paperDailyLossLimitUsd: 1000,
  paperLast10NetDegradeThresholdUsd: 500,
  paperDegradeSizeMultiplier: 0.5,
  paperModeSuspendMs: 15 * 60 * 1000,
  paperModeHardSuspendMs: 30 * 60 * 1000,
  paperModeLossStreakSoftCount: 3,
  paperModeLossStreakSuspendCount: 5,
  okxLiveMaxOrderNotionalUsdt: 50
} as unknown as EngineConfig;

function createCandles(prices: number[]): Candle[] {
  const baseTs = 1700000000000;
  return prices.map((price, i) => ({
    ts: baseTs + i * 60000,
    open: i > 0 ? prices[i - 1] : price,
    high: Math.max(price, i > 0 ? prices[i - 1] : price) + 5,
    low: Math.min(price, i > 0 ? prices[i - 1] : price) - 5,
    close: price,
    volume: 100
  }));
}

function generateFlatCandles(count = 30, price = 60000): Candle[] {
  return createCandles(Array(count).fill(price));
}

function generateCrashReduceCandles(count = 30, basePrice = 60000): Candle[] {
  // 15m ago price is basePrice (60000), 5m ago price is 58800, current price is 58500
  // drop15m = -2.5% (triggers CRASH_REDUCE), drop5m = -0.5%
  // pump detector: maxRise = -0.5% => riseAbs = 0.005 (< 0.012 => globalPump is NONE)
  const prices: number[] = [];
  for (let i = 0; i < count - 15; i++) {
    prices.push(basePrice);
  }
  // From 15m to 5m: drop to 58800
  for (let i = 0; i < 10; i++) {
    prices.push(basePrice - ((basePrice - 58800) * (i + 1)) / 10);
  }
  // From 5m to 0m: drop to 58500
  for (let i = 0; i < 5; i++) {
    prices.push(58800 - ((58800 - 58500) * (i + 1)) / 5);
  }
  return createCandles(prices);
}

function generateCrashAlertCandles(count = 30, basePrice = 60000): Candle[] {
  // 15m ago price is basePrice (60000), 5m ago price is 59300, current price is 59100
  // drop15m = -1.5% (triggers CRASH_ALERT), drop5m = -0.3%
  // pump detector: maxRise = -0.3% => riseAbs = 0.003 (< 0.012 => globalPump is NONE)
  const prices: number[] = [];
  for (let i = 0; i < count - 15; i++) {
    prices.push(basePrice);
  }
  for (let i = 0; i < 10; i++) {
    prices.push(basePrice - ((basePrice - 59300) * (i + 1)) / 10);
  }
  for (let i = 0; i < 5; i++) {
    prices.push(59300 - ((59300 - 59100) * (i + 1)) / 5);
  }
  return createCandles(prices);
}

function generatePumpReduceCandles(count = 30, basePrice = 60000): Candle[] {
  // Rise of ~2.5% to trigger PUMP_REDUCE (riseAbs > 0.022)
  const prices: number[] = [];
  for (let i = 0; i < count - 5; i++) {
    prices.push(basePrice);
  }
  const risenPrice = basePrice * (1 + 0.025);
  for (let i = 0; i < 5; i++) {
    prices.push(basePrice + ((risenPrice - basePrice) * (i + 1)) / 5);
  }
  return createCandles(prices);
}

function generatePumpExitCandles(count = 30, basePrice = 60000): Candle[] {
  // Rise of ~4.0% to trigger PUMP_EXIT (riseAbs > 0.035)
  const prices: number[] = [];
  for (let i = 0; i < count - 5; i++) {
    prices.push(basePrice);
  }
  const risenPrice = basePrice * (1 + 0.040);
  for (let i = 0; i < 5; i++) {
    prices.push(basePrice + ((risenPrice - basePrice) * (i + 1)) / 5);
  }
  return createCandles(prices);
}

function generateMinorPullbackCandles(count = 30, basePrice = 60000): Candle[] {
  // Minor drop of ~0.3% (below CRASH_ALERT threshold 1.2%)
  const prices: number[] = [];
  for (let i = 0; i < count - 5; i++) {
    prices.push(basePrice);
  }
  const droppedPrice = basePrice * (1 - 0.003);
  for (let i = 0; i < 5; i++) {
    prices.push(basePrice - ((basePrice - droppedPrice) * (i + 1)) / 5);
  }
  return createCandles(prices);
}

function makePriorState(pumpLockUntil: number): RiskControlDecision {
  return {
    engineBlocked: false,
    engineBlockReasons: [],
    blockedRegimes: {},
    recentLossStreakByMode: {},
    sizeMultiplier: 1.0,
    riskStatus: "NORMAL",
    dailyLossGuardTriggered: false,
    crashState: "NONE",
    crashReason: null,
    crashLockUntil: 0,
    pumpState: "PUMP_LOCK",
    pumpReason: "급등 후 숏 진입 제한 대기 중",
    pumpLockUntil,
    directionalShockState: "UP",
    isLatePursuit: false,
    isLateChase: false,
    longAllow: true,
    shortAllow: false,
    longSizeMult: 1.0,
    shortSizeMult: 0.1,
    detail: {}
  };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`[PASS] ${msg}`);
    passed++;
  } else {
    console.error(`[FAIL] ${msg}`);
    failed++;
  }
}

console.log("=== RUNNING PUMP_LOCK REVERSAL RELEASE REGRESSION TESTS ===");

const now = 1700000000000 + 30 * 60000;
const activeLockUntil = now + 10 * 60 * 1000; // 10 minutes in future

// ------------------------------------------------------------------------------------------------
// Test A: active PUMP_LOCK + globalPump NONE/ALERT + CRASH_REDUCE
// => pump lock 조기 해제 => directional shock DOWN => longAllow false => shortAllow true
// ------------------------------------------------------------------------------------------------
{
  console.log("\n--- Scenario A: active PUMP_LOCK + globalPump NONE + CRASH_REDUCE ---");
  const candles = generateCrashReduceCandles(30);
  const prior = makePriorState(activeLockUntil);

  const decision = evaluateRiskControls({
    config: mockConfig,
    now,
    history: [],
    priorState: prior,
    globalCandles: candles
  });

  assert(decision.crashState === "CRASH_REDUCE", `crashState should be CRASH_REDUCE (got ${decision.crashState})`);
  assert(decision.pumpState === "NONE", `pumpState should be released to NONE (got ${decision.pumpState})`);
  assert(decision.pumpLockUntil === 0, `pumpLockUntil should be cleared to 0 (got ${decision.pumpLockUntil})`);
  assert(decision.directionalShockState === "DOWN", `directionalShockState should be DOWN (got ${decision.directionalShockState})`);
  assert(decision.longAllow === false, `longAllow should be false (got ${decision.longAllow})`);
  assert(decision.shortAllow === true, `shortAllow should be true (got ${decision.shortAllow})`);
  assert(decision.detail.pump_lock_released === true, `detail.pump_lock_released should be true (got ${decision.detail.pump_lock_released})`);
  assert(decision.detail.reversal_release_eligible === true, `detail.reversal_release_eligible should be true (got ${decision.detail.reversal_release_eligible})`);
}

// ------------------------------------------------------------------------------------------------
// Test A2: active PUMP_LOCK + globalPump NONE + CRASH_ALERT
// => pump lock 조기 해제 => directional shock DOWN => longAllow false => shortAllow true
// ------------------------------------------------------------------------------------------------
{
  console.log("\n--- Scenario A2: active PUMP_LOCK + globalPump NONE + CRASH_ALERT ---");
  const candles = generateCrashAlertCandles(30);
  const prior = makePriorState(activeLockUntil);

  const decision = evaluateRiskControls({
    config: mockConfig,
    now,
    history: [],
    priorState: prior,
    globalCandles: candles
  });

  assert(decision.crashState === "CRASH_ALERT", `crashState should be CRASH_ALERT (got ${decision.crashState})`);
  assert(decision.pumpState === "NONE", `pumpState should be released to NONE (got ${decision.pumpState})`);
  assert(decision.pumpLockUntil === 0, `pumpLockUntil should be cleared to 0 (got ${decision.pumpLockUntil})`);
  assert(decision.directionalShockState === "DOWN", `directionalShockState should be DOWN (got ${decision.directionalShockState})`);
  assert(decision.longAllow === false, `longAllow should be false (got ${decision.longAllow})`);
  assert(decision.shortAllow === true, `shortAllow should be true (got ${decision.shortAllow})`);
  assert(decision.detail.pump_lock_released === true, `detail.pump_lock_released should be true (got ${decision.detail.pump_lock_released})`);
}

// ------------------------------------------------------------------------------------------------
// Test B: active PUMP_LOCK + globalPump NONE + crash NONE
// => PUMP_LOCK 유지 => directional shock UP
// ------------------------------------------------------------------------------------------------
{
  console.log("\n--- Scenario B: active PUMP_LOCK + globalPump NONE + crash NONE ---");
  const candles = generateFlatCandles(30);
  const prior = makePriorState(activeLockUntil);

  const decision = evaluateRiskControls({
    config: mockConfig,
    now,
    history: [],
    priorState: prior,
    globalCandles: candles
  });

  assert(decision.crashState === "NONE", `crashState should be NONE (got ${decision.crashState})`);
  assert(decision.pumpState === "PUMP_LOCK", `pumpState should remain PUMP_LOCK (got ${decision.pumpState})`);
  assert(decision.pumpLockUntil === activeLockUntil, `pumpLockUntil should remain unchanged (got ${decision.pumpLockUntil})`);
  assert(decision.directionalShockState === "UP", `directionalShockState should be UP (got ${decision.directionalShockState})`);
  assert(decision.longAllow === true, `longAllow should be true (got ${decision.longAllow})`);
  assert(decision.shortAllow === false, `shortAllow should be false (got ${decision.shortAllow})`);
  assert(decision.detail.pump_lock_released === false, `detail.pump_lock_released should be false (got ${decision.detail.pump_lock_released})`);
  assert(decision.detail.reversal_release_eligible === false, `detail.reversal_release_eligible should be false (got ${decision.detail.reversal_release_eligible})`);
}

// ------------------------------------------------------------------------------------------------
// Test C1: active PUMP_LOCK + globalPump PUMP_REDUCE + crash signal (CRASH_ALERT / CRASH_REDUCE)
// => PUMP_LOCK 유지
// ------------------------------------------------------------------------------------------------
{
  console.log("\n--- Scenario C1: active PUMP_LOCK + globalPump PUMP_REDUCE ---");
  const candles = generatePumpReduceCandles(30);
  const prior = makePriorState(activeLockUntil);

  const decision = evaluateRiskControls({
    config: mockConfig,
    now,
    history: [],
    priorState: prior,
    globalCandles: candles
  });

  assert(decision.pumpState === "PUMP_LOCK", `pumpState should remain PUMP_LOCK (got ${decision.pumpState})`);
  assert(decision.pumpLockUntil === activeLockUntil, `pumpLockUntil should remain active (got ${decision.pumpLockUntil})`);
  assert(decision.directionalShockState === "UP", `directionalShockState should be UP (got ${decision.directionalShockState})`);
  assert(decision.shortAllow === false, `shortAllow should be false (got ${decision.shortAllow})`);
  assert(decision.detail.pump_lock_released === false, `detail.pump_lock_released should be false (got ${decision.detail.pump_lock_released})`);
}

// ------------------------------------------------------------------------------------------------
// Test C2: active PUMP_LOCK + globalPump PUMP_EXIT + crash signal
// => PUMP_LOCK 유지
// ------------------------------------------------------------------------------------------------
{
  console.log("\n--- Scenario C2: active PUMP_LOCK + globalPump PUMP_EXIT ---");
  const candles = generatePumpExitCandles(30);
  const prior = makePriorState(activeLockUntil);

  const decision = evaluateRiskControls({
    config: mockConfig,
    now,
    history: [],
    priorState: prior,
    globalCandles: candles
  });

  assert(decision.pumpState === "PUMP_LOCK", `pumpState should remain PUMP_LOCK (got ${decision.pumpState})`);
  assert(decision.directionalShockState === "UP", `directionalShockState should be UP (got ${decision.directionalShockState})`);
  assert(decision.shortAllow === false, `shortAllow should be false (got ${decision.shortAllow})`);
  assert(decision.detail.pump_lock_released === false, `detail.pump_lock_released should be false (got ${decision.detail.pump_lock_released})`);
}

// ------------------------------------------------------------------------------------------------
// Test D: active PUMP_LOCK + minor pullback (crash NONE)
// => PUMP_LOCK 유지 => directional shock UP
// ------------------------------------------------------------------------------------------------
{
  console.log("\n--- Scenario D: active PUMP_LOCK + minor pullback ---");
  const candles = generateMinorPullbackCandles(30);
  const prior = makePriorState(activeLockUntil);

  const decision = evaluateRiskControls({
    config: mockConfig,
    now,
    history: [],
    priorState: prior,
    globalCandles: candles
  });

  assert(decision.crashState === "NONE", `crashState should be NONE for minor pullback (got ${decision.crashState})`);
  assert(decision.pumpState === "PUMP_LOCK", `pumpState should remain PUMP_LOCK (got ${decision.pumpState})`);
  assert(decision.pumpLockUntil === activeLockUntil, `pumpLockUntil should remain unchanged (got ${decision.pumpLockUntil})`);
  assert(decision.directionalShockState === "UP", `directionalShockState should be UP (got ${decision.directionalShockState})`);
  assert(decision.shortAllow === false, `shortAllow should be false (got ${decision.shortAllow})`);
  assert(decision.detail.pump_lock_released === false, `detail.pump_lock_released should be false (got ${decision.detail.pump_lock_released})`);
}

console.log(`\n=== FINAL TEST RESULTS: ${passed} PASSED, ${failed} FAILED ===`);
if (failed > 0) {
  process.exit(1);
}
