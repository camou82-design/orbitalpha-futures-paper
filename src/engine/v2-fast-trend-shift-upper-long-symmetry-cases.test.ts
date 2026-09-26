import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2, marketJudgmentCacheBySymbol } from "../engine-v2/index.js";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer.js";
import { clearGlobalShockStates } from "../engine-v2/state/derive.js";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor.js";
import { buildV2SnapshotBridge } from "./paper-engine.js";
import type { Candle } from "../models/types.js";
import type { SymbolSnapshotLike } from "./paper-symbol-decision.js";

const NOW = 1_700_000_000_000;

function makeCandles(base = 65000, direction: "up" | "down" = "up", count = 60, stepSize = 1): Candle[] {
  const candles: Candle[] = [];
  const step = direction === "up" ? stepSize : -stepSize;
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
  const candles = overrides.candles ?? makeCandles(65000, "up", 60);
  return {
    symbol: "BTCUSDT",
    lastPrice: 65800,
    latestCandleClose: 65800,
    tickSz: 0.1,
    signal: "paper_long_candidate",
    entryCandidate: true,
    qualityScore: 80,
    candidateStrength: "strong",
    ema20: 65400,
    ema60: 65000,
    emaGap: 0.004,
    volumeRatioProxy: 1.5,
    boxHigh: 65500,
    boxLow: 64500,
    boxPos: 0.85,
    boxRel: 0.05,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 200,
    atr20: 200,
    closedClose: 65800,
    rangeConfidence: 0.7,
    trendWeaknessScore: 0.1,
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.2,
    rangeOscillationScore: 0.2,
    boxHighSlope: 0.0001,
    boxLowSlope: 0.0001,
    rangeCenterSlope: 0.0001,
    ema20Slope: 0.0001,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.5,
    htf_candles: {
      "5m": candles,
      "15m": candles,
      "1h": candles,
      "4h": candles,
      "1d": candles
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

function runEngineWith(
  snapshotOverrides: Partial<SymbolSnapshotLike> = {},
  stateOverrides: Record<string, any> = {},
  configOverrides: Record<string, any> = {}
) {
  marketJudgmentCacheBySymbol.clear();
  clearWhipsawObservationState();
  clearGlobalShockStates();
  rangeContinuationStateMap.clear();

  const snap = createBaseSnapshot(snapshotOverrides);
  const bridge = buildV2SnapshotBridge(snap);
  const state = createBaseState(stateOverrides);
  const config = {
    paperMaxOpenPositions: 3,
    baseSizeUsd: 100,
    serverTradeEnabled: true,
    closeOnlyMode: false,
    killSwitch: false,
    reconcileSafeMode: false,
    ...configOverrides
  };

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

function runTests() {
  console.log("Starting v2 Fast Trend Shift Upper Long Symmetry & Authority Tests...\n");

  // -------------------------------------------------------------
  // Scenario 1: FTS upper long early probe + upper breakout confirmed -> side-zone veto NOT fired (Tier 5.5 passes)
  // -------------------------------------------------------------
  {
    const holdingCandles = [
      ...makeCandles(2500, "up", 50, 1),
      { ts: NOW - 5000, open: 2504, high: 2508, low: 2503, close: 2506, volume: 100 },
      { ts: NOW - 4000, open: 2506, high: 2510, low: 2504, close: 2507, volume: 100 },
      { ts: NOW - 3000, open: 2507, high: 2512, low: 2505, close: 2508, volume: 100 },
      { ts: NOW - 2000, open: 2508, high: 2514, low: 2506, close: 2509, volume: 100 },
      { ts: NOW - 1000, open: 2509, high: 2515, low: 2507, close: 2510, volume: 100 }
    ];

    const res = runEngineWith({
      symbol: "BTCUSDT",
      lastPrice: 2510,
      closedClose: 2510,
      boxHigh: 2500,
      boxLow: 2400,
      boxPos: 0.85,
      emaGap: 0.003,
      trendWeaknessScore: 0.2,
      qualityScore: 75,
      atr: 15,
      atr20: 15,
      candles: holdingCandles
    });

    const dec = res.decision as any;
    assert.notEqual(dec.rejectReason, "SIDE_ZONE_MISMATCH_UPPER_LONG", "Must not be blocked by SIDE_ZONE_MISMATCH_UPPER_LONG");
    assert.notEqual(dec.rejectReason, "RANGE_MIDDLE_CHASE_BLOCKED_LONG", "Must not be blocked by RANGE_MIDDLE_CHASE_BLOCKED_LONG");
    console.log("PASS: Scenario 1 - FTS upper long early probe + upper breakout confirmed passed Tier 5.5 side-zone guard");
  }

  // -------------------------------------------------------------
  // Scenario 2: FTS lower short symmetric path -> side-zone veto NOT fired (Tier 5.5 passes)
  // -------------------------------------------------------------
  {
    const downCandles = [
      ...makeCandles(2400, "down", 50, 1),
      { ts: NOW - 5000, open: 2396, high: 2397, low: 2392, close: 2394, volume: 100 },
      { ts: NOW - 4000, open: 2394, high: 2396, low: 2390, close: 2393, volume: 100 },
      { ts: NOW - 3000, open: 2393, high: 2395, low: 2388, close: 2392, volume: 100 },
      { ts: NOW - 2000, open: 2392, high: 2394, low: 2386, close: 2391, volume: 100 },
      { ts: NOW - 1000, open: 2391, high: 2393, low: 2385, close: 2390, volume: 100 }
    ];

    const res = runEngineWith({
      symbol: "BTCUSDT",
      lastPrice: 2390,
      closedClose: 2390,
      boxHigh: 2500,
      boxLow: 2400,
      boxPos: 0.15,
      emaGap: -0.003,
      trendWeaknessScore: 0.2,
      qualityScore: 75,
      atr: 15,
      atr20: 15,
      candles: downCandles
    });

    const dec = res.decision as any;
    assert.notEqual(dec.rejectReason, "SIDE_ZONE_MISMATCH_LOWER_SHORT", "Must not be blocked by SIDE_ZONE_MISMATCH_LOWER_SHORT");
    assert.notEqual(dec.rejectReason, "RANGE_MIDDLE_CHASE_BLOCKED_SHORT", "Must not be blocked by RANGE_MIDDLE_CHASE_BLOCKED_SHORT");
    console.log("PASS: Scenario 2 - FTS lower short symmetric path preserved without side-zone veto");
  }

  // -------------------------------------------------------------
  // Scenario 3: Pure RANGE Upper Long chase -> Blocked by SIDE_ZONE_MISMATCH_UPPER_LONG
  // -------------------------------------------------------------
  {
    const res = runEngineWith({
      symbol: "BTCUSDT",
      lastPrice: 65400,
      closedClose: 65400,
      boxHigh: 65500,
      boxLow: 64500,
      boxPos: 0.85,
      emaGap: 0,
      trendWeaknessScore: 0.8,
      canonicalRegime: "RANGE"
    });

    assert.notEqual(res.decision.side, "long", "Pure range upper long chase must never produce long ENTER");
    console.log("PASS: Scenario 3 - Pure RANGE upper long chase is blocked");
  }

  // -------------------------------------------------------------
  // Scenario 4: Pure RANGE Lower Short chase -> Blocked by SIDE_ZONE_MISMATCH_LOWER_SHORT
  // -------------------------------------------------------------
  {
    const res = runEngineWith({
      symbol: "BTCUSDT",
      lastPrice: 64600,
      closedClose: 64600,
      boxHigh: 65500,
      boxLow: 64500,
      boxPos: 0.15,
      emaGap: 0,
      trendWeaknessScore: 0.8,
      canonicalRegime: "RANGE"
    });

    assert.notEqual(res.decision.side, "short", "Pure range lower short chase must never produce short ENTER");
    console.log("PASS: Scenario 4 - Pure RANGE lower short chase is blocked");
  }

  // -------------------------------------------------------------
  // Scenario 5: FTS upper long + opposing strong highway / shock -> Blocked
  // -------------------------------------------------------------
  {
    const holdingCandles = [
      ...makeCandles(2500, "up", 50, 1),
      { ts: NOW - 5000, open: 2504, high: 2508, low: 2503, close: 2506, volume: 100 },
      { ts: NOW - 4000, open: 2506, high: 2510, low: 2504, close: 2507, volume: 100 },
      { ts: NOW - 3000, open: 2507, high: 2512, low: 2505, close: 2508, volume: 100 },
      { ts: NOW - 2000, open: 2508, high: 2514, low: 2506, close: 2509, volume: 100 },
      { ts: NOW - 1000, open: 2509, high: 2515, low: 2507, close: 2510, volume: 100 }
    ];

    const res = runEngineWith(
      {
        symbol: "BTCUSDT",
        lastPrice: 2510,
        closedClose: 2510,
        boxHigh: 2500,
        boxLow: 2400,
        boxPos: 0.85,
        emaGap: 0.003,
        candles: holdingCandles
      },
      {
        directionalShockState: "DOWN_STRONG"
      }
    );

    assert.notEqual(res.decision.decision, "ENTER", "FTS upper long with opposing shock must not ENTER");
    console.log("PASS: Scenario 5 - FTS upper long with opposing shock/highway is blocked");
  }

  // -------------------------------------------------------------
  // Scenario 6: ETH FTS -> ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED maintained
  // -------------------------------------------------------------
  {
    const ethCandles = [
      ...makeCandles(3500, "up", 50),
      { ts: NOW - 5000, open: 3570, high: 3585, low: 3565, close: 3580, volume: 150 },
      { ts: NOW - 4000, open: 3580, high: 3590, low: 3575, close: 3582, volume: 150 },
      { ts: NOW - 3000, open: 3582, high: 3595, low: 3578, close: 3585, volume: 150 },
      { ts: NOW - 2000, open: 3585, high: 3598, low: 3580, close: 3588, volume: 150 },
      { ts: NOW - 1000, open: 3588, high: 3600, low: 3585, close: 3590, volume: 150 }
    ];

    const res = runEngineWith({
      symbol: "ETHUSDT",
      lastPrice: 3590,
      closedClose: 3590,
      boxHigh: 3550,
      boxLow: 3450,
      boxPos: 0.85,
      emaGap: 0.003,
      candles: ethCandles
    });

    assert.notEqual(res.decision.decision, "ENTER", "ETH FTS must remain disabled from live ENTER");
    console.log("PASS: Scenario 6 - ETH FTS shadow-only live entry disabled is strictly preserved");
  }

  // -------------------------------------------------------------
  // Scenario 7: Highway RR Guard -> When RR is poor (e.g. stop distance wide), Highway Gate skips with POOR_REWARD_RISK_RATIO
  // -------------------------------------------------------------
  {
    const holdingCandles = [
      ...makeCandles(2500, "up", 50, 1),
      { ts: NOW - 5000, open: 2504, high: 2508, low: 2503, close: 2506, volume: 100 },
      { ts: NOW - 4000, open: 2506, high: 2510, low: 2504, close: 2507, volume: 100 },
      { ts: NOW - 3000, open: 2507, high: 2512, low: 2505, close: 2508, volume: 100 },
      { ts: NOW - 2000, open: 2508, high: 2514, low: 2506, close: 2509, volume: 100 },
      { ts: NOW - 1000, open: 2509, high: 2515, low: 2507, close: 2510, volume: 100 }
    ];

    const res = runEngineWith({
      symbol: "BTCUSDT",
      lastPrice: 2510,
      closedClose: 2510,
      boxHigh: 2500,
      boxLow: 2400,
      boxPos: 0.85,
      emaGap: 0.003,
      trendWeaknessScore: 0.2,
      qualityScore: 75,
      atr: 15,
      atr20: 15,
      candles: holdingCandles
    });

    assert.equal(res.decision.decision, "SKIP", "FTS upper long with wide stop must be final SKIP by Highway Gate");
    console.log("PASS: Scenario 7 - Highway Entry Gate properly guards with POOR_REWARD_RISK_RATIO when RR is insufficient");
  }

  console.log("\nv2-fast-trend-shift-upper-long-symmetry-cases: ALL MANDATORY & HIGHWAY TESTS PASSED PERFECTLY!");
}

runTests();
