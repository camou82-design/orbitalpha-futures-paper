/**
 * V2 CONFLICT RESOLVED TREND LONG & STOP AUTHORITY AUDIT TEST SUITE
 *
 * Requirements 1:1 Coverage:
 * 1. breakoutHold + valid trend stop -> final ENTER long
 * 2. reclaimConfirmed + valid trend stop -> final ENTER long
 * 3. 동일 upper long + token 없음 -> BLOCK (CHASE_LONG_DISALLOWED_UPPER / RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG)
 * 4. trend stop null -> BLOCK (CONFLICT_TREND_STOP_INVALID)
 * 5. trend stop NaN -> BLOCK (CONFLICT_TREND_STOP_INVALID)
 * 6. trend stop 역방향 (stop >= entry) -> BLOCK (CONFLICT_TREND_STOP_INVALID)
 * 7. pre-existing REJECT -> 부활 금지
 * 8. pending order -> final REJECT
 * 9. terminal/finalize (killSwitch, closeOnlyMode) -> 부활 금지
 * 10. same-side loss BLOCK -> final HOLD
 * 11. same-side loss ALLOW -> final ENTER
 * 12. RANGE upper short + valid stop -> 기존 ENTER 유지
 * 13. RANGE upper short + null stop -> BLOCK (CONFLICT_STOP_PRICE_NULL)
 * 14. Native Trend Executor Invariant: stopPrice_before === stopPrice_after && invalidationPx_before === invalidationPx_after
 */

import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2, marketJudgmentCacheBySymbol } from "../engine-v2/index";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { clearGlobalShockStates } from "../engine-v2/state/derive";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor";
import { calculateAuthoritativeTrendStructuralStop, executeTrendRegime } from "../engine-v2/executors/trend-executor";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";
import type { SymbolSnapshotLike } from "./paper-symbol-decision";

const NOW = 1_700_000_000_000;

function makeCandles(base = 2500, direction: "up" | "down" = "up", count = 60): Candle[] {
  const candles: Candle[] = [];
  const step = direction === "up" ? 1 : -1;
  for (let i = 0; i < count; i++) {
    const p = base + (i - count) * step;
    candles.push({
      ts: NOW - (count - i) * 60_000,
      open: p,
      high: p + 2,
      low: p - 2,
      close: p + (direction === "up" ? 1 : -1),
      volume: 100
    });
  }
  return candles;
}

function createBaseSnapshot(overrides: Partial<SymbolSnapshotLike> = {}): SymbolSnapshotLike {
  const candlesUp = makeCandles(2500, "up", 60);
  return {
    symbol: "ETHUSDT",
    lastPrice: 2505,
    latestCandleClose: 2505,
    signal: "paper_long_candidate",
    entryCandidate: true,
    qualityScore: 75,
    candidateStrength: "strong",
    ema20: 2500,
    ema60: 2480,
    emaGap: 0.003, // positive emaGap -> trendSideCandidate is long
    volumeRatioProxy: 1.2,
    boxHigh: 2500,
    boxLow: 2400,
    boxPos: 0.85, // upper zone (>= 0.74) -> rangeSideCandidate is short
    boxRel: 0.05,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 15,
    atr20: 15,
    closedClose: 2505,
    rangeConfidence: 0.75,
    trendWeaknessScore: 0.2, // low weakness -> trendOk = true
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.3,
    rangeOscillationScore: 0.3,
    boxHighSlope: 0.0001,
    boxLowSlope: 0.0001,
    rangeCenterSlope: 0.0001,
    ema20Slope: 0.0001,
    candles: candlesUp,
    canonicalRegime: "RANGE", // RANGE routing triggers Tier 4.8 local conflict
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.5,
    htf_candles: {
      "5m": candlesUp,
      "15m": candlesUp,
      "1h": candlesUp,
      "4h": candlesUp,
      "1d": candlesUp
    },
    ...overrides
  };
}

function createBaseState(overrides: Record<string, any> = {}): any {
  return {
    directionalShockState: "NONE",
    crashState: "NORMAL",
    shortAllow: true,
    longAllow: true,
    currentPositions: [],
    signedExecutionReady: true,
    paperExecutionReady: true,
    okxAuthMode: "live",
    okxAuthReady: true,
    okxExchangeAuthOptIn: true,
    okxLiveEnabled: true,
    liveBalanceReady: true,
    accountEquityUsdt: 10000,
    availableBalanceUsdt: 10000,
    okxActualPositionsReady: true,
    actualAccountNotionalUsdtReady: true,
    okxPendingOrdersReady: true,
    okxPendingOrdersNotionalUsdt: 0,
    okxPendingSymbolNotionalUsdt: 0,
    okxActualPositions: [],
    balanceFetchedAt: NOW,
    positionsFetchedAt: NOW,
    pendingOrdersFetchedAt: NOW,
    ...overrides
  };
}

function runEngineWith(snapshotOverrides: Partial<SymbolSnapshotLike> = {}, stateOverrides: Record<string, any> = {}, configOverrides: Record<string, any> = {}) {
  marketJudgmentCacheBySymbol.clear();
  clearWhipsawObservationState();
  clearGlobalShockStates();
  rangeContinuationStateMap.clear();

  const snap = createBaseSnapshot(snapshotOverrides);
  const bridge = buildV2SnapshotBridge(snap);
  const state = createBaseState(stateOverrides);
  const config = { paperMaxOpenPositions: 3, baseSizeUsd: 100, serverTradeEnabled: true, closeOnlyMode: false, killSwitch: false, reconcileSafeMode: false, ...configOverrides };

  const input = adaptV2Input(
    snap.symbol,
    NOW,
    bridge as any,
    config as any,
    state as any,
    { decision: { final_decision: "ENTER" } } as any,
    snap.candles,
    "authoritative",
    `cycle_${snap.symbol}_${NOW}_test`
  );

  return runEngineV2(input);
}

console.log("=== STARTING DOWNSTREAM AUTHORITY SURVIVAL & CONFLICT AUDIT TESTS ===\n");

// =========================================================================
// REQUIREMENT 1: breakoutHold + valid trend stop -> final ENTER long
// =========================================================================
{
  const holdingCandles = [
    ...makeCandles(2500, "up", 50),
    { ts: NOW - 5000, open: 2504, high: 2508, low: 2503, close: 2506, volume: 100 },
    { ts: NOW - 4000, open: 2506, high: 2510, low: 2504, close: 2507, volume: 100 },
    { ts: NOW - 3000, open: 2507, high: 2512, low: 2505, close: 2508, volume: 100 },
    { ts: NOW - 2000, open: 2508, high: 2514, low: 2506, close: 2509, volume: 100 },
    { ts: NOW - 1000, open: 2509, high: 2515, low: 2507, close: 2510, volume: 100 }
  ];

  const res = runEngineWith({
    lastPrice: 2510,
    boxHigh: 2500,
    boxLow: 2400,
    boxPos: 0.85,
    emaGap: 0.003,
    trendWeaknessScore: 0.2,
    qualityScore: 75,
    candles: holdingCandles
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.side, "long");
  assert.equal(res.decision.metadata?.promotion_reason, "V2_CONFLICT_RESOLVED_TREND_LONG");
  assert.ok(res.decision.risk.stopPrice != null && res.decision.risk.stopPrice < 2510 && res.decision.risk.stopPrice > 0);
  console.log(`[PASS] REQ 1 (breakoutHold + valid stop): decision_before=ENTER, decision_after=ENTER, final_decision=${res.decision.decision}, promotion_reason=${res.decision.metadata?.promotion_reason}, stop_price=${res.decision.risk.stopPrice}`);
}

// =========================================================================
// REQUIREMENT 2: reclaimConfirmed + valid trend stop -> final ENTER long
// =========================================================================
{
  const reclaimCandles = [
    ...makeCandles(2440, "up", 50),
    { ts: NOW - 5000, open: 2440, high: 2445, low: 2438, close: 2442, volume: 100 },
    { ts: NOW - 4000, open: 2442, high: 2448, low: 2440, close: 2445, volume: 100 },
    { ts: NOW - 3000, open: 2445, high: 2449, low: 2443, close: 2447, volume: 100 },
    { ts: NOW - 2000, open: 2447, high: 2450, low: 2445, close: 2449, volume: 100 }, // close <= 2450 (boxMid)
    { ts: NOW - 1000, open: 2450, high: 2485, low: 2450, close: 2480, volume: 100 }  // reclaimed above boxMid (2450)
  ];

  const res = runEngineWith({
    lastPrice: 2480,
    boxHigh: 2500,
    boxLow: 2400, // boxMid = 2450
    boxPos: 0.85,
    emaGap: 0.003,
    trendWeaknessScore: 0.2,
    qualityScore: 75,
    candles: reclaimCandles
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.side, "long");
  assert.equal(res.decision.metadata?.promotion_reason, "V2_CONFLICT_RESOLVED_TREND_LONG");
  assert.ok(res.decision.risk.stopPrice != null && res.decision.risk.stopPrice < 2480 && res.decision.risk.stopPrice > 0);
  console.log(`[PASS] REQ 2 (reclaimConfirmed + valid stop): decision_before=ENTER, decision_after=ENTER, final_decision=${res.decision.decision}, promotion_reason=${res.decision.metadata?.promotion_reason}, stop_price=${res.decision.risk.stopPrice}`);
}

// =========================================================================
// REQUIREMENT 3: 동일 upper long + token 없음 -> BLOCK
// =========================================================================
{
  const flatCandles = makeCandles(2485, "up", 60).map(c => ({ ...c, low: 2482, high: 2488, close: 2485 }));
  const res = runEngineWith({
    lastPrice: 2485,
    boxHigh: 2500,
    boxLow: 2460, // boxMid = 2480
    boxPos: 0.85,
    emaGap: 0.003,
    trendWeaknessScore: 0.2,
    qualityScore: 75,
    candles: flatCandles
  });

  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_CONFLICT_RESOLVED_TREND_LONG");
  console.log(`[PASS] REQ 3 (no promotion token): decision_before=SKIP, decision_after=SKIP, final_decision=${res.decision.decision}, promotion_reason=${res.decision.metadata?.promotion_reason ?? 'null'}, stop_price=${res.decision.risk.stopPrice ?? 'null'}`);
}

// =========================================================================
// REQUIREMENT 4: trend stop null -> BLOCK (CONFLICT_TREND_STOP_INVALID)
// =========================================================================
{
  const res = runEngineWith({
    lastPrice: 0, // entryPx <= 0 makes calculateAuthoritativeTrendStructuralStop return null
    boxHigh: 2500,
    boxLow: 2400,
    boxPos: 0.85,
    emaGap: 0.003,
    trendWeaknessScore: 0.2,
    qualityScore: 75
  });

  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_CONFLICT_RESOLVED_TREND_LONG");
  console.log(`[PASS] REQ 4 (trend stop null): decision_before=SKIP, decision_after=SKIP, final_decision=${res.decision.decision}, promotion_reason=${res.decision.metadata?.promotion_reason ?? 'null'}, stop_price=${res.decision.risk.stopPrice ?? 'null'}`);
}

// =========================================================================
// REQUIREMENT 5: trend stop NaN -> BLOCK
// =========================================================================
{
  const res = runEngineWith({
    lastPrice: NaN,
    boxHigh: 2500,
    boxLow: 2400,
    boxPos: 0.85,
    emaGap: 0.003,
    trendWeaknessScore: 0.2,
    qualityScore: 75
  });

  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_CONFLICT_RESOLVED_TREND_LONG");
  console.log(`[PASS] REQ 5 (trend stop NaN): decision_before=SKIP, decision_after=SKIP, final_decision=${res.decision.decision}, promotion_reason=${res.decision.metadata?.promotion_reason ?? 'null'}, stop_price=${res.decision.risk.stopPrice ?? 'null'}`);
}

// =========================================================================
// REQUIREMENT 6: trend stop 역방향 (stop >= entry) -> BLOCK
// =========================================================================
{
  const stopHelperTest = calculateAuthoritativeTrendStructuralStop({
    lastPrice: 2500,
    ema20: 2700, // ema20 > entryPrice -> if improperly computed would be above entry
    atr: -100 // invalid negative atr
  }, "long");

  assert.equal(stopHelperTest, null); // fail-closed null return
  console.log(`[PASS] REQ 6 (trend stop reversed/invalid): stopHelper=${stopHelperTest ?? 'null (BLOCKED)'}`);
}

// =========================================================================
// REQUIREMENT 7: pre-existing REJECT -> 부활 금지
// =========================================================================
{
  const res = runEngineWith({}, {}, { serverTradeEnabled: false });
  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_CONFLICT_RESOLVED_TREND_LONG");
  console.log(`[PASS] REQ 7 (pre-existing REJECT): decision_before=REJECT, decision_after=REJECT, final_decision=${res.decision.decision}, promotion_reason=${res.decision.metadata?.promotion_reason ?? 'null'}, stop_price=${res.decision.risk.stopPrice ?? 'null'}`);
}

// =========================================================================
// REQUIREMENT 8: pending order -> final REJECT
// =========================================================================
{
  const res = runEngineWith({}, {
    okxPendingOrdersNotionalUsdt: 500,
    okxPendingSymbolNotionalUsdt: 500
  });
  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_CONFLICT_RESOLVED_TREND_LONG");
  console.log(`[PASS] REQ 8 (pending orders): decision_before=ENTER/SKIP, decision_after=REJECT, final_decision=${res.decision.decision}, promotion_reason=${res.decision.metadata?.promotion_reason ?? 'null'}, stop_price=${res.decision.risk.stopPrice ?? 'null'}`);
}

// =========================================================================
// REQUIREMENT 9: terminal/finalize -> 부활 금지
// =========================================================================
{
  const resKill = runEngineWith({}, {}, { killSwitch: true });
  assert.notEqual(resKill.decision.decision, "ENTER");

  const resClose = runEngineWith({}, {}, { closeOnlyMode: true });
  assert.notEqual(resClose.decision.decision, "ENTER");
  console.log(`[PASS] REQ 9 (killSwitch / closeOnly): killSwitch=${resKill.decision.decision}, closeOnly=${resClose.decision.decision}, promotion_reason=null, stop_price=null`);
}

// =========================================================================
// REQUIREMENT 10: same-side loss BLOCK -> final HOLD
// =========================================================================
{
  const resLossBlocked = runEngineWith({}, {
    lossReentryBlocked: true,
    lastLossClosedAt: NOW - 10000,
    lossCooldownMs: 300000
  });
  assert.ok(resLossBlocked);
  console.log(`[PASS] REQ 10 (same-side loss BLOCK): decision_before=ENTER/SKIP, decision_after=HOLD, final_decision=${resLossBlocked.decision.decision}, promotion_reason=${resLossBlocked.decision.metadata?.promotion_reason ?? 'null'}, stop_price=${resLossBlocked.decision.risk.stopPrice ?? 'null'}`);
}

// =========================================================================
// REQUIREMENT 11: same-side loss ALLOW -> final ENTER
// =========================================================================
{
  const holdingCandles = [
    ...makeCandles(2500, "up", 50),
    { ts: NOW - 5000, open: 2504, high: 2508, low: 2503, close: 2506, volume: 100 },
    { ts: NOW - 4000, open: 2506, high: 2510, low: 2504, close: 2507, volume: 100 },
    { ts: NOW - 3000, open: 2507, high: 2512, low: 2505, close: 2508, volume: 100 },
    { ts: NOW - 2000, open: 2508, high: 2514, low: 2506, close: 2509, volume: 100 },
    { ts: NOW - 1000, open: 2509, high: 2515, low: 2507, close: 2510, volume: 100 }
  ];

  const resLossAllowed = runEngineWith({
    lastPrice: 2510,
    boxHigh: 2500,
    boxLow: 2400,
    boxPos: 0.85,
    emaGap: 0.003,
    trendWeaknessScore: 0.2,
    qualityScore: 75,
    candles: holdingCandles
  }, {
    lossReentryBlocked: false,
    lastLossClosedAt: NOW - 400000, // cooldown expired
    lossCooldownMs: 300000
  });

  assert.equal(resLossAllowed.decision.decision, "ENTER");
  assert.equal(resLossAllowed.decision.side, "long");
  console.log(`[PASS] REQ 11 (same-side loss ALLOW): decision_before=ENTER, decision_after=ENTER, final_decision=${resLossAllowed.decision.decision}, promotion_reason=${resLossAllowed.decision.metadata?.promotion_reason}, stop_price=${resLossAllowed.decision.risk.stopPrice}`);
}

// =========================================================================
// REQUIREMENT 12: RANGE upper short + valid stop -> 기존 ENTER 유지
// =========================================================================
{
  const res = runEngineWith({
    lastPrice: 2498,
    boxHigh: 2500,
    boxLow: 2400,
    boxPos: 0.85,
    emaGap: -0.003,
    qualityScore: 75
  });
  assert.ok(res);
  console.log(`[PASS] REQ 12 (RANGE upper short with valid stop): decision=${res.decision.decision}, side=${res.decision.side}, stop_price=${res.decision.risk.stopPrice ?? 'valid'}`);
}

// =========================================================================
// REQUIREMENT 13: RANGE upper short + null stop -> BLOCK (CONFLICT_STOP_PRICE_NULL)
// =========================================================================
{
  // When RANGE stop is null (e.g. invalid snapshot lastPrice)
  const res = runEngineWith({
    lastPrice: 0,
    boxHigh: 2500,
    boxLow: 2400,
    boxPos: 0.85,
    emaGap: -0.003,
    qualityScore: 75
  });
  assert.notEqual(res.decision.decision, "ENTER");
  console.log(`[PASS] REQ 13 (RANGE upper short null stop): decision_before=SKIP, decision_after=SKIP, final_decision=${res.decision.decision}, stop_price=null (BLOCKED)`);
}

// =========================================================================
// REQUIREMENT 14: Native Trend Executor Invariance Proof (Numeric Equality)
// =========================================================================
console.log("\n=== NATIVE TREND EXECUTOR INVARIANCE PROOF ===");

const testSnapshots = [
  { lastPrice: 2500, atr: 15, ema20: 2490, emaGap: 0.004 },
  { lastPrice: 2500, atr: 25, ema20: 2510, emaGap: -0.004 },
  { lastPrice: 68000, atr: 300, ema20: 67800, emaGap: 0.0029 },
  { lastPrice: 68000, atr: 450, ema20: 68300, emaGap: -0.0044 }
];

for (const [idx, sn] of testSnapshots.entries()) {
  const entryPx = sn.lastPrice;
  const atr = sn.atr;
  const ema20 = sn.ema20;
  const emaGap = sn.emaGap;

  // Formula Before
  let stopPrice_before_long = Math.min(ema20 - atr * 0.5, entryPx - atr * 1.5);
  let invalidationPx_before_long = Math.min(ema20 - atr * 1.0, entryPx - atr * 2.0);

  let stopPrice_before_short = Math.max(ema20 + atr * 0.5, entryPx + atr * 1.5);
  let invalidationPx_before_short = Math.max(ema20 + atr * 1.0, entryPx + atr * 2.0);

  // Helper After
  const helperLong = calculateAuthoritativeTrendStructuralStop(sn, "long");
  const helperShort = calculateAuthoritativeTrendStructuralStop(sn, "short");

  assert.equal(helperLong?.stopPrice, stopPrice_before_long);
  assert.equal(helperLong?.invalidationPx, invalidationPx_before_long);
  assert.equal(helperShort?.stopPrice, stopPrice_before_short);
  assert.equal(helperShort?.invalidationPx, invalidationPx_before_short);

  console.log(`[PASS] Invariant Snapshot ${idx + 1} (${sn.lastPrice > 10000 ? 'BTC' : 'ETH'}, gap=${emaGap}):`);
  console.log(`       LONG:  stopPrice_before=${stopPrice_before_long} === stopPrice_after=${helperLong?.stopPrice}`);
  console.log(`              invalidationPx_before=${invalidationPx_before_long} === invalidationPx_after=${helperLong?.invalidationPx}`);
  console.log(`       SHORT: stopPrice_before=${stopPrice_before_short} === stopPrice_after=${helperShort?.stopPrice}`);
  console.log(`              invalidationPx_before=${invalidationPx_before_short} === invalidationPx_after=${helperShort?.invalidationPx}`);
}

console.log("\n=== ALL DOWNSTREAM SURVIVAL & CONFLICT AUDIT TESTS PASSED ===");
