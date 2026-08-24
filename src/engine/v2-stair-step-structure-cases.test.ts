/**
 * V2 STAIR-STEP CONTINUATION PROMOTION & SYMMETRY REGRESSION SUITE
 *
 * Verifies:
 * TEST 1: Uptrend -> shallow pullback -> re-advance -> STAIR_STEP_UP detected
 * TEST 2: Downtrend -> shallow rebound -> re-decline -> STAIR_STEP_DOWN detected (exact inverse symmetry)
 * TEST 3: Flat range chop -> NONE detected
 * TEST 4: Single upward spike without follow-through -> NONE detected (spike filter)
 * TEST 5: Single downward spike without follow-through -> NONE detected (spike filter)
 * TEST 6: Deep retracement / trend breach (> 75% pullback) -> NONE detected
 * TEST 7: Production BTC STAIR_STEP_UP scenario: RANGE_FAKE_BREAKOUT + HTF BULLISH + higher-low progression -> successfully promoted to ENTER long with valid stop and sizing
 * TEST 8: Production ETH STAIR_STEP_DOWN inverse scenario: RANGE_FAKE_BREAKOUT + HTF BEARISH + lower-high progression -> successfully promoted to ENTER short with valid stop and sizing
 * TEST 9: In-flight forming candle instantaneous spike with insufficient closed candles -> returns NONE (forming candle isolation)
 * TEST 10: Subsequent candle closure confirming healthy structure -> returns STAIR_STEP_UP
 * TEST 11: In-flight forming candle instantaneous breakdown spike with insufficient closed candles -> returns NONE (DOWN forming candle isolation)
 * TEST 12: Subsequent candle closure confirming healthy structure -> returns STAIR_STEP_DOWN
 * TEST 13: HTF SHORT_ONLY_OR_NONE / STRONG_BEARISH_HTF_ALIGNMENT correctly vetoes STAIR_STEP_UP (block_reason=HTF_HARD_VETO)
 * TEST 14: HTF LONG_ONLY_OR_NONE / STRONG_BULLISH_HTF_ALIGNMENT correctly vetoes STAIR_STEP_DOWN (block_reason=HTF_HARD_VETO)
 * TEST 15: Macro polarity mismatch (UP structure with BEARISH macro) blocks promotion -> decision=SKIP/HOLD, side=none
 * TEST 16: Macro polarity mismatch (DOWN structure with BULLISH macro) blocks promotion -> decision=SKIP/HOLD, side=none
 * TEST 17: Whipsaw shock hard-block blocks promotion -> decision=REJECT, side=none
 */

import { detectStairStepStructure } from "../engine-v2/market-judgment/stair-step-detector";
import { adaptV2Input, runEngineV2, marketJudgmentCacheBySymbol } from "../engine-v2/index";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { clearGlobalShockStates } from "../engine-v2/state/derive";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor";
import { resolveSymbolDecisionEnvelope } from "../engine-v2/reconciler";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";
import type { SymbolSnapshotLike } from "./paper-symbol-decision";
import type { MarketJudgmentOutput } from "../engine-v2/types";

function run(label: string, passed: boolean, detail: string): boolean {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[STAIR-STEP-TEST][${label}] ${tag} — ${detail}`);
  if (!passed) {
    throw new Error(`[STAIR-STEP-TEST][${label}] FAILED: ${detail}`);
  }
  return passed;
}

console.log("=== STARTING V2 STAIR-STEP STRUCTURE & PROMOTION REGRESSION TESTS ===");

// -------------------------------------------------------------------------
// Helper: Candle Generators
// -------------------------------------------------------------------------

/** Generates 17 candles (16 closed + 1 in-flight forming) for healthy stair-step up */
function makeStairStepUpCandles(base = 65000): Candle[] {
  const now = Date.now();
  const pattern = [
    { o: 65020, h: 65050, l: 65010, c: 65030 }, // 0
    { o: 65030, h: 65040, l: 64980, c: 65000 }, // 1 (L1)
    { o: 65000, h: 65080, l: 65030, c: 65050 }, // 2
    { o: 65080, h: 65120, l: 65060, c: 65100 }, // 3
    { o: 65100, h: 65150, l: 65090, c: 65130 }, // 4
    // Impulse 1
    { o: 65130, h: 65300, l: 65120, c: 65280 }, // 5
    { o: 65280, h: 65450, l: 65260, c: 65420 }, // 6
    { o: 65420, h: 65600, l: 65400, c: 65580 }, // 7
    { o: 65580, h: 65650, l: 65550, c: 65620 }, // 8 (H1)
    // Shallow pullback
    { o: 65620, h: 65630, l: 65480, c: 65500 }, // 9
    { o: 65500, h: 65520, l: 65420, c: 65440 }, // 10
    { o: 65440, h: 65460, l: 65400, c: 65430 }, // 11 (L2)
    // Re-advance & Reclaim
    { o: 65430, h: 65580, l: 65420, c: 65560 }, // 12
    { o: 65560, h: 65700, l: 65540, c: 65680 }, // 13
    { o: 65680, h: 65820, l: 65660, c: 65800 }, // 14
    { o: 65800, h: 65850, l: 65780, c: 65840 }, // 15
    // In-flight forming candle (last element)
    { o: 65840, h: 65860, l: 65830, c: 65850 }  // 16
  ];

  return pattern.map((p, i) => ({
    ts: now - (pattern.length - i) * 60000,
    open: p.o,
    high: p.h,
    low: p.l,
    close: p.c,
    volume: 100
  }));
}

/** Generates 17 candles (16 closed + 1 in-flight forming) for healthy stair-step down */
function makeStairStepDownCandles(base = 65000): Candle[] {
  const now = Date.now();
  const pattern = [
    { o: 64980, h: 64990, l: 64950, c: 64970 }, // 0
    { o: 64970, h: 65020, l: 64960, c: 65000 }, // 1 (H1)
    { o: 65000, h: 64970, l: 64920, c: 64950 }, // 2
    { o: 64920, h: 64940, l: 64880, c: 64900 }, // 3
    { o: 64900, h: 64910, l: 64850, c: 64870 }, // 4
    // Impulse down
    { o: 64870, h: 64880, l: 64700, c: 64720 }, // 5
    { o: 64720, h: 64740, l: 64550, c: 64580 }, // 6
    { o: 64580, h: 64600, l: 64400, c: 64420 }, // 7
    { o: 64420, h: 64450, l: 64350, c: 64380 }, // 8 (L1)
    // Shallow rebound
    { o: 64380, h: 64520, l: 64370, c: 64500 }, // 9
    { o: 64500, h: 64580, l: 64480, c: 64560 }, // 10
    { o: 64560, h: 64600, l: 64540, c: 64570 }, // 11 (H2)
    // Re-decline & Rejection
    { o: 64570, h: 64580, l: 64420, c: 64440 }, // 12
    { o: 64440, h: 64460, l: 64300, c: 64320 }, // 13
    { o: 64320, h: 64340, l: 64180, c: 64200 }, // 14
    { o: 64200, h: 64220, l: 64150, c: 64160 }, // 15
    // In-flight forming candle (last element)
    { o: 64160, h: 64170, l: 64140, c: 64150 }  // 16
  ];

  return pattern.map((p, i) => ({
    ts: now - (pattern.length - i) * 60000,
    open: p.o,
    high: p.h,
    low: p.l,
    close: p.c,
    volume: 100
  }));
}

/** Flat range chop */
function makeFlatChopCandles(): Candle[] {
  const now = Date.now();
  return Array.from({ length: 17 }, (_, i) => ({
    ts: now - (17 - i) * 60000,
    open: 65000 + (i % 2 === 0 ? 50 : -50),
    high: 65100,
    low: 64900,
    close: 65000 + (i % 2 === 0 ? -40 : 40),
    volume: 50
  }));
}

/** Single spike up followed by flat */
function makeSingleSpikeUpCandles(): Candle[] {
  const now = Date.now();
  return Array.from({ length: 17 }, (_, i) => {
    if (i === 8) {
      return {
        ts: now - (17 - i) * 60000,
        open: 65000,
        high: 66000,
        low: 65000,
        close: 65900,
        volume: 1000
      };
    }
    return {
      ts: now - (17 - i) * 60000,
      open: 65000,
      high: 65050,
      low: 64950,
      close: 65000,
      volume: 50
    };
  });
}

/** Single spike down followed by flat */
function makeSingleSpikeDownCandles(): Candle[] {
  const now = Date.now();
  return Array.from({ length: 17 }, (_, i) => {
    if (i === 8) {
      return {
        ts: now - (17 - i) * 60000,
        open: 65000,
        high: 65000,
        low: 64000,
        close: 64100,
        volume: 1000
      };
    }
    return {
      ts: now - (17 - i) * 60000,
      open: 65000,
      high: 65050,
      low: 64950,
      close: 65000,
      volume: 50
    };
  });
}

/** Deep retracement (> 75%) */
function makeDeepRetracementCandles(): Candle[] {
  const now = Date.now();
  const pattern = [
    { o: 65000, h: 65100, l: 64950, c: 65050 },
    { o: 65050, h: 65300, l: 65020, c: 65280 },
    { o: 65280, h: 65600, l: 65250, c: 65550 },
    { o: 65550, h: 66000, l: 65500, c: 65950 },
    // Deep crash dumping below starting point
    { o: 65950, h: 65960, l: 65200, c: 65250 },
    { o: 65250, h: 65300, l: 64800, c: 64850 },
    { o: 64850, h: 64900, l: 64700, c: 64750 },
    { o: 64750, h: 64800, l: 64650, c: 64700 },
    { o: 64700, h: 64750, l: 64600, c: 64620 },
    { o: 64620, h: 64650, l: 64550, c: 64580 }
  ];
  return pattern.map((p, i) => ({
    ts: now - (pattern.length - i) * 60000,
    open: p.o,
    high: p.h,
    low: p.l,
    close: p.c,
    volume: 100
  }));
}

// =========================================================================
// TEST 1 — STAIR_STEP_UP: Healthy stair-step up detected on closed candles
// =========================================================================
{
  const candles = makeStairStepUpCandles(65000);
  const snap: any = {
    lastPrice: 65850,
    boxHigh: 66000,
    boxLow: 65000,
    rangeCenterSlope: 0.0004,
    ema20Slope: 0.0005,
    boxPos: 0.84
  };
  const judgment: any = {
    htf_entry_policy: "ALLOW",
    regime: "RANGE",
    subtype: "ASCENDING_CHANNEL"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });

  run(
    "TEST_1_STAIR_STEP_UP_DETECTED",
    res.detected === true &&
      res.direction === "UP" &&
      res.higher_low_detected === true &&
      res.pullback_depth_ratio <= 0.65 &&
      res.reclaim_or_rejection_confirmed === true &&
      res.confidence >= 0.7 &&
      res.structure_candles_closed_only === true,
    `STAIR_STEP_UP detected on closed candles: detected=${res.detected}, dir=${res.direction}, conf=${res.confidence}, pullbackRatio=${res.pullback_depth_ratio}`
  );
}

// =========================================================================
// TEST 2 — STAIR_STEP_DOWN: Healthy stair-step down detected (Exact Inverse)
// =========================================================================
{
  const candles = makeStairStepDownCandles(65000);
  const snap: any = {
    lastPrice: 64150,
    boxHigh: 65000,
    boxLow: 64000,
    rangeCenterSlope: -0.0004,
    ema20Slope: -0.0005,
    boxPos: 0.16
  };
  const judgment: any = {
    htf_entry_policy: "ALLOW",
    regime: "RANGE",
    subtype: "DESCENDING_CHANNEL"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });

  run(
    "TEST_2_STAIR_STEP_DOWN_DETECTED",
    res.detected === true &&
      res.direction === "DOWN" &&
      res.lower_high_detected === true &&
      res.pullback_depth_ratio <= 0.65 &&
      res.reclaim_or_rejection_confirmed === true &&
      res.confidence >= 0.7 &&
      res.structure_candles_closed_only === true,
    `STAIR_STEP_DOWN detected on closed candles: detected=${res.detected}, dir=${res.direction}, conf=${res.confidence}, pullbackRatio=${res.pullback_depth_ratio}`
  );
}

// =========================================================================
// TEST 3 — FLAT RANGE CHOP: NONE detected
// =========================================================================
{
  const candles = makeFlatChopCandles();
  const snap: any = {
    lastPrice: 65000,
    boxHigh: 65100,
    boxLow: 64900,
    rangeCenterSlope: 0,
    ema20Slope: 0,
    boxPos: 0.5
  };
  const judgment: any = {
    htf_entry_policy: "ALLOW",
    regime: "RANGE",
    subtype: "STABLE_BOX"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });

  run(
    "TEST_3_FLAT_CHOP_RETURNS_NONE",
    res.detected === false && res.direction === "NONE",
    `Flat chop correctly returns NONE: detected=${res.detected}, dir=${res.direction}, block=${res.block_reason}`
  );
}

// =========================================================================
// TEST 4 — SINGLE UP SPIKE: Spike filter prevents false positive
// =========================================================================
{
  const candles = makeSingleSpikeUpCandles();
  const snap: any = {
    lastPrice: 65000,
    boxHigh: 66000,
    boxLow: 64900,
    rangeCenterSlope: 0.0001,
    ema20Slope: 0.0001,
    boxPos: 0.1
  };
  const judgment: any = {
    htf_entry_policy: "ALLOW",
    regime: "RANGE",
    subtype: "VOLATILITY_EXPANSION"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });

  run(
    "TEST_4_SINGLE_UP_SPIKE_RETURNS_NONE",
    res.detected === false && res.direction === "NONE",
    `Single upward spike correctly rejected by spike filter: detected=${res.detected}, dir=${res.direction}, block=${res.block_reason}`
  );
}

// =========================================================================
// TEST 5 — SINGLE DOWN SPIKE: Spike filter prevents false positive
// =========================================================================
{
  const candles = makeSingleSpikeDownCandles();
  const snap: any = {
    lastPrice: 65000,
    boxHigh: 65100,
    boxLow: 64000,
    rangeCenterSlope: -0.0001,
    ema20Slope: -0.0001,
    boxPos: 0.9
  };
  const judgment: any = {
    htf_entry_policy: "ALLOW",
    regime: "RANGE",
    subtype: "VOLATILITY_EXPANSION"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });

  run(
    "TEST_5_SINGLE_DOWN_SPIKE_RETURNS_NONE",
    res.detected === false && res.direction === "NONE",
    `Single downward spike correctly rejected by spike filter: detected=${res.detected}, dir=${res.direction}, block=${res.block_reason}`
  );
}

// =========================================================================
// TEST 6 — DEEP RETRACEMENT: Pullback > 75% returns NONE
// =========================================================================
{
  const candles = makeDeepRetracementCandles();
  const snap: any = {
    lastPrice: 64580,
    boxHigh: 66000,
    boxLow: 64550,
    rangeCenterSlope: -0.0002,
    ema20Slope: -0.0003,
    boxPos: 0.1
  };
  const judgment: any = {
    htf_entry_policy: "ALLOW",
    regime: "RANGE",
    subtype: "BREAKDOWN_ACCELERATION"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });

  run(
    "TEST_6_DEEP_RETRACEMENT_RETURNS_NONE",
    res.detected === false && res.direction === "NONE",
    `Deep retracement correctly rejected: detected=${res.detected}, dir=${res.direction}, block=${res.block_reason}`
  );
}

// =========================================================================
// TEST 7 — PRODUCTION BTC STAIR_STEP_UP PROMOTION TO ENTER LONG
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const now = Date.now();
  const candles = makeStairStepUpCandles(68000);
  const snapFakeBreakout: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 68850,
    latestCandleClose: 68850,
    signal: "paper_long_candidate",
    qualityScore: 70,
    candidateStrength: "strong",
    ema20: 68600,
    ema60: 68400,
    emaGap: 0.002,
    volumeRatioProxy: 1.2,
    boxHigh: 69000,
    boxLow: 68000,
    boxPos: 0.84,
    boxRel: 0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 68840,
    rangeConfidence: 0.75,
    trendWeaknessScore: 0.2,
    boxCohesion01: 0.8,
    breakoutFailureRate: 0.6,
    rangeOscillationScore: 0.2,
    boxHighSlope: 0.0003,
    boxLowSlope: 0.0003,
    rangeCenterSlope: 0.0003,
    ema20Slope: 0.0004,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": candles,
      "15m": candles,
      "1h": candles,
      "4h": candles
    }
  };

  const bridge = buildV2SnapshotBridge(snapFakeBreakout);
  const input = adaptV2Input(
    "BTCUSDT",
    now,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
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
      balanceFetchedAt: now,
      positionsFetchedAt: now,
      pendingOrdersFetchedAt: now
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    candles,
    "authoritative",
    `cycle_BTCUSDT_${now}_stair_up_promoted`
  );

  const res = runEngineV2(input);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  const env = resolveSymbolDecisionEnvelope({
    symbol: "BTCUSDT" as any,
    fetchedAt: now,
    snapshot: bridge,
    config: { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    state: {
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
      balanceFetchedAt: now,
      positionsFetchedAt: now,
      pendingOrdersFetchedAt: now
    } as any,
    legacy: {
      regime: "RANGE",
      finalDecision: "SKIP",
      rejectReason: "none",
      requiredCostUsd: 0,
      entryAllowed: false,
      executorLabel: "range",
      intentSide: "none",
      adaptiveOk: true,
      adaptiveDetail: {}
    } as any,
    v2Mode: "engine_v2",
    evaluationMode: "authoritative",
    runCycleId: `cycle_BTCUSDT_${now}_stair_up_promoted_env`
  });

  const v2Env = env.v2_execution_envelope;

  run(
    "TEST_7_STAIR_STEP_UP_PROMOTED_TO_ENTER_LONG",
    meta.stair_step_detected === true &&
      meta.stair_step_direction === "UP" &&
      meta.stair_step_promoted === true &&
      decision.decision === "ENTER" &&
      decision.side === "long" &&
      (decision.risk?.finalOrderNotionalUsdt ?? 0) > 0 &&
      (decision.risk?.stopPrice ?? 0) > 0 &&
      (decision.risk?.stopPrice ?? 0) < snapFakeBreakout.lastPrice &&
      v2Env?.decision === "ENTER" &&
      v2Env?.side === "long",
    `BTC Stair step up promoted to ENTER long: decision=${decision.decision}, side=${decision.side}, size=${decision.risk?.finalOrderNotionalUsdt}, stopPrice=${decision.risk?.stopPrice}`
  );
}

// =========================================================================
// TEST 8 — PRODUCTION ETH STAIR_STEP_DOWN PROMOTION TO ENTER SHORT (EXACT INVERSE)
// =========================================================================
{
  clearWhipsawObservationState("ETHUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const now = Date.now();
  const candles = makeStairStepDownCandles(2600);
  const snapFakeBreakdown: SymbolSnapshotLike = {
    symbol: "ETHUSDT",
    lastPrice: 2565,
    latestCandleClose: 2565,
    signal: "paper_short_candidate",
    qualityScore: 70,
    candidateStrength: "strong",
    ema20: 2580,
    ema60: 2600,
    emaGap: -0.002,
    volumeRatioProxy: 1.2,
    boxHigh: 2600,
    boxLow: 2550,
    boxPos: 0.16,
    boxRel: -0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 12,
    atr20: 12,
    closedClose: 2566,
    rangeConfidence: 0.75,
    trendWeaknessScore: 0.2,
    boxCohesion01: 0.8,
    breakoutFailureRate: 0.6,
    rangeOscillationScore: 0.2,
    boxHighSlope: -0.0003,
    boxLowSlope: -0.0003,
    rangeCenterSlope: -0.0003,
    ema20Slope: -0.0004,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": candles,
      "15m": candles,
      "1h": candles,
      "4h": candles
    }
  };

  const bridge = buildV2SnapshotBridge(snapFakeBreakdown);
  const input = adaptV2Input(
    "ETHUSDT",
    now,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
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
      balanceFetchedAt: now,
      positionsFetchedAt: now,
      pendingOrdersFetchedAt: now
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    candles,
    "authoritative",
    `cycle_ETHUSDT_${now}_stair_down_promoted`
  );

  const res = runEngineV2(input);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  const env = resolveSymbolDecisionEnvelope({
    symbol: "ETHUSDT" as any,
    fetchedAt: now,
    snapshot: bridge,
    config: { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    state: {
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
      balanceFetchedAt: now,
      positionsFetchedAt: now,
      pendingOrdersFetchedAt: now
    } as any,
    legacy: {
      regime: "RANGE",
      finalDecision: "SKIP",
      rejectReason: "none",
      requiredCostUsd: 0,
      entryAllowed: false,
      executorLabel: "range",
      intentSide: "none",
      adaptiveOk: true,
      adaptiveDetail: {}
    } as any,
    v2Mode: "engine_v2",
    evaluationMode: "authoritative",
    runCycleId: `cycle_ETHUSDT_${now}_stair_down_promoted_env`
  });

  const v2Env = env.v2_execution_envelope;

  run(
    "TEST_8_STAIR_STEP_DOWN_PROMOTED_TO_ENTER_SHORT",
    meta.stair_step_detected === true &&
      meta.stair_step_direction === "DOWN" &&
      meta.stair_step_promoted === true &&
      decision.decision === "ENTER" &&
      decision.side === "short" &&
      (decision.risk?.finalOrderNotionalUsdt ?? 0) > 0 &&
      (decision.risk?.stopPrice ?? 0) > snapFakeBreakdown.lastPrice &&
      v2Env?.decision === "ENTER" &&
      v2Env?.side === "short",
    `ETH Stair step down promoted to ENTER short: decision=${decision.decision}, side=${decision.side}, size=${decision.risk?.finalOrderNotionalUsdt}, stopPrice=${decision.risk?.stopPrice}`
  );
}

// =========================================================================
// TEST 9 — FORMING CANDLE ISOLATION: Instantaneous forming spike with flat closed candles -> returns NONE
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = Array.from({ length: 16 }, (_, i) => ({
    ts: now - (17 - i) * 60000,
    open: 65000,
    high: 65020,
    low: 64980,
    close: 65000,
    volume: 50
  }));
  candles.push({
    ts: now,
    open: 65000,
    high: 66000,
    low: 65000,
    close: 65950,
    volume: 1000
  });

  const snap: any = {
    lastPrice: 65950,
    boxHigh: 66000,
    boxLow: 64900,
    rangeCenterSlope: 0,
    ema20Slope: 0,
    boxPos: 0.9
  };
  const judgment: any = {
    htf_entry_policy: "ALLOW",
    regime: "RANGE",
    subtype: "FLAT"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });

  run(
    "TEST_9_FORMING_CANDLE_SPIKE_ISOLATION_RETURNS_NONE",
    res.detected === false &&
      res.direction === "NONE" &&
      res.structure_candles_closed_only === true,
    `Forming candle spike correctly isolated, returns NONE: detected=${res.detected}, dir=${res.direction}, block=${res.block_reason}`
  );
}

// =========================================================================
// TEST 10 — SUBSEQUENT CANDLE CLOSURE: Once closed, healthy structure is recognized
// =========================================================================
{
  const closedCandles = makeStairStepUpCandles(65000);
  const snap: any = {
    lastPrice: 65850,
    boxHigh: 66000,
    boxLow: 65000,
    rangeCenterSlope: 0.0004,
    ema20Slope: 0.0005,
    boxPos: 0.84
  };
  const judgment: any = {
    htf_entry_policy: "ALLOW",
    regime: "RANGE",
    subtype: "ASCENDING_CHANNEL"
  };

  const res = detectStairStepStructure({ candles: closedCandles, snapshot: snap, judgment });

  run(
    "TEST_10_CANDLE_CLOSURE_CONFIRMATION_STAIR_STEP_UP",
    res.detected === true &&
      res.direction === "UP" &&
      res.structure_candles_closed_only === true,
    `Closed candle structure correctly confirms STAIR_STEP_UP: detected=${res.detected}, dir=${res.direction}, conf=${res.confidence}`
  );
}

// =========================================================================
// TEST 11 — DOWN FORMING CANDLE ISOLATION: Instantaneous forming crash spike with flat closed candles -> returns NONE
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = Array.from({ length: 16 }, (_, i) => ({
    ts: now - (17 - i) * 60000,
    open: 65000,
    high: 65020,
    low: 64980,
    close: 65000,
    volume: 50
  }));
  candles.push({
    ts: now,
    open: 65000,
    high: 65000,
    low: 64000,
    close: 64050,
    volume: 1000
  });

  const snap: any = {
    lastPrice: 64050,
    boxHigh: 65100,
    boxLow: 64000,
    rangeCenterSlope: 0,
    ema20Slope: 0,
    boxPos: 0.1
  };
  const judgment: any = {
    htf_entry_policy: "ALLOW",
    regime: "RANGE",
    subtype: "FLAT"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });

  run(
    "TEST_11_DOWN_FORMING_CANDLE_SPIKE_ISOLATION_RETURNS_NONE",
    res.detected === false &&
      res.direction === "NONE" &&
      res.structure_candles_closed_only === true,
    `DOWN forming candle crash spike correctly isolated, returns NONE: detected=${res.detected}, dir=${res.direction}, block=${res.block_reason}`
  );
}

// =========================================================================
// TEST 12 — DOWN CANDLE CLOSURE CONFIRMATION: Once closed, healthy DOWN structure is recognized
// =========================================================================
{
  const closedCandles = makeStairStepDownCandles(65000);
  const snap: any = {
    lastPrice: 64150,
    boxHigh: 65000,
    boxLow: 64000,
    rangeCenterSlope: -0.0004,
    ema20Slope: -0.0005,
    boxPos: 0.16
  };
  const judgment: any = {
    htf_entry_policy: "ALLOW",
    regime: "RANGE",
    subtype: "DESCENDING_CHANNEL"
  };

  const res = detectStairStepStructure({ candles: closedCandles, snapshot: snap, judgment });

  run(
    "TEST_12_DOWN_CANDLE_CLOSURE_CONFIRMATION_STAIR_STEP_DOWN",
    res.detected === true &&
      res.direction === "DOWN" &&
      res.structure_candles_closed_only === true,
    `Closed candle structure correctly confirms STAIR_STEP_DOWN: detected=${res.detected}, dir=${res.direction}, conf=${res.confidence}`
  );
}

// =========================================================================
// TEST 13 — HTF HARD VETO ON UP: SHORT_ONLY_OR_NONE / STRONG_BEARISH_HTF_ALIGNMENT blocks UP
// =========================================================================
{
  const candles = makeStairStepUpCandles(65000);
  const snap: any = {
    lastPrice: 65850,
    boxHigh: 66000,
    boxLow: 65000,
    rangeCenterSlope: 0.0004,
    ema20Slope: 0.0005,
    boxPos: 0.84
  };
  const judgmentShortShock: any = {
    htf_entry_policy: "SHORT_ONLY_OR_NONE",
    regime: "RANGE",
    subtype: "ASCENDING_CHANNEL"
  };
  const judgmentStrongBearishHold: any = {
    htf_entry_policy: "HOLD",
    htf_hard_block_reason: "STRONG_BEARISH_HTF_ALIGNMENT",
    regime: "RANGE",
    subtype: "ASCENDING_CHANNEL"
  };

  const res1 = detectStairStepStructure({ candles, snapshot: snap, judgment: judgmentShortShock });
  const res2 = detectStairStepStructure({ candles, snapshot: snap, judgment: judgmentStrongBearishHold });

  run(
    "TEST_13_HTF_HARD_VETO_BLOCKS_STAIR_STEP_UP",
    res1.detected === false &&
      res1.block_reason === "HTF_HARD_VETO" &&
      res2.detected === false &&
      res2.block_reason === "HTF_HARD_VETO",
    `HTF hard vetoes correctly block STAIR_STEP_UP: res1Block=${res1.block_reason}, res2Block=${res2.block_reason}`
  );
}

// =========================================================================
// TEST 14 — HTF HARD VETO ON DOWN: LONG_ONLY_OR_NONE / STRONG_BULLISH_HTF_ALIGNMENT blocks DOWN
// =========================================================================
{
  const candles = makeStairStepDownCandles(65000);
  const snap: any = {
    lastPrice: 64150,
    boxHigh: 65000,
    boxLow: 64000,
    rangeCenterSlope: -0.0004,
    ema20Slope: -0.0005,
    boxPos: 0.16
  };
  const judgmentLongShock: any = {
    htf_entry_policy: "LONG_ONLY_OR_NONE",
    regime: "RANGE",
    subtype: "DESCENDING_CHANNEL"
  };
  const judgmentStrongBullishHold: any = {
    htf_entry_policy: "HOLD",
    htf_hard_block_reason: "STRONG_BULLISH_HTF_ALIGNMENT",
    regime: "RANGE",
    subtype: "DESCENDING_CHANNEL"
  };

  const res1 = detectStairStepStructure({ candles, snapshot: snap, judgment: judgmentLongShock });
  const res2 = detectStairStepStructure({ candles, snapshot: snap, judgment: judgmentStrongBullishHold });

  run(
    "TEST_14_HTF_HARD_VETO_BLOCKS_STAIR_STEP_DOWN",
    res1.detected === false &&
      res1.block_reason === "HTF_HARD_VETO" &&
      res2.detected === false &&
      res2.block_reason === "HTF_HARD_VETO",
    `HTF hard vetoes correctly block STAIR_STEP_DOWN: res1Block=${res1.block_reason}, res2Block=${res2.block_reason}`
  );
}

// =========================================================================
// TEST 15 — POLARITY MISMATCH BLOCKS UP PROMOTION (Macro BEARISH)
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const now = Date.now();
  const candles = makeStairStepUpCandles(68000);
  // Macro bearish candles for 1h/4h
  const bearishHtfCandles = makeStairStepDownCandles(70000);
  const snapPolarityMismatch: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 68850,
    latestCandleClose: 68850,
    signal: "paper_long_candidate",
    qualityScore: 70,
    candidateStrength: "strong",
    ema20: 68600,
    ema60: 68400,
    emaGap: 0.002,
    volumeRatioProxy: 1.2,
    boxHigh: 69000,
    boxLow: 68000,
    boxPos: 0.84,
    boxRel: 0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 68840,
    rangeConfidence: 0.75,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": candles,
      "15m": bearishHtfCandles,
      "1h": bearishHtfCandles,
      "4h": bearishHtfCandles
    }
  };

  const bridge = buildV2SnapshotBridge(snapPolarityMismatch);
  const input = adaptV2Input(
    "BTCUSDT",
    now,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "NONE",
      crashState: "NORMAL",
      shortAllow: true,
      longAllow: true,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    candles,
    "authoritative",
    `cycle_BTCUSDT_${now}_polarity_mismatch_up`
  );

  const res = runEngineV2(input);
  run(
    "TEST_15_POLARITY_MISMATCH_BLOCKS_UP_PROMOTION",
    res.decision.decision !== "ENTER" && res.decision.side === "none",
    `Polarity mismatch successfully blocked UP promotion: decision=${res.decision.decision}, side=${res.decision.side}`
  );
}

// =========================================================================
// TEST 16 — POLARITY MISMATCH BLOCKS DOWN PROMOTION (Macro BULLISH)
// =========================================================================
{
  clearWhipsawObservationState("ETHUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const now = Date.now();
  const candles = makeStairStepDownCandles(2600);
  // Macro bullish candles for 1h/4h
  const bullishHtfCandles = makeStairStepUpCandles(2500);
  const snapPolarityMismatchDown: SymbolSnapshotLike = {
    symbol: "ETHUSDT",
    lastPrice: 2565,
    latestCandleClose: 2565,
    signal: "paper_short_candidate",
    qualityScore: 70,
    candidateStrength: "strong",
    ema20: 2580,
    ema60: 2600,
    emaGap: -0.002,
    volumeRatioProxy: 1.2,
    boxHigh: 2600,
    boxLow: 2550,
    boxPos: 0.16,
    boxRel: -0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 12,
    atr20: 12,
    closedClose: 2566,
    rangeConfidence: 0.75,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": candles,
      "15m": bullishHtfCandles,
      "1h": bullishHtfCandles,
      "4h": bullishHtfCandles
    }
  };

  const bridge = buildV2SnapshotBridge(snapPolarityMismatchDown);
  const input = adaptV2Input(
    "ETHUSDT",
    now,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "NONE",
      crashState: "NORMAL",
      shortAllow: true,
      longAllow: true,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    candles,
    "authoritative",
    `cycle_ETHUSDT_${now}_polarity_mismatch_down`
  );

  const res = runEngineV2(input);
  run(
    "TEST_16_POLARITY_MISMATCH_BLOCKS_DOWN_PROMOTION",
    res.decision.decision !== "ENTER" && res.decision.side === "none",
    `Polarity mismatch successfully blocked DOWN promotion: decision=${res.decision.decision}, side=${res.decision.side}`
  );
}

// =========================================================================
// TEST 17 — WHIPSAW SHOCK HARD BLOCK PREVENTS STAIR STEP PROMOTION
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const now = Date.now();
  const candles = makeStairStepUpCandles(68000);
  const snapShockBlocked: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 68850,
    latestCandleClose: 68850,
    signal: "paper_long_candidate",
    qualityScore: 70,
    candidateStrength: "strong",
    ema20: 68600,
    ema60: 68400,
    emaGap: 0.002,
    volumeRatioProxy: 1.2,
    boxHigh: 69000,
    boxLow: 68000,
    boxPos: 0.84,
    boxRel: 0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 68840,
    rangeConfidence: 0.75,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": candles,
      "15m": candles,
      "1h": candles,
      "4h": candles
    }
  };

  const bridge = buildV2SnapshotBridge(snapShockBlocked);
  const input = adaptV2Input(
    "BTCUSDT",
    now,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "DOWN", // Hard shock active against long
      crashState: "NORMAL",
      shortAllow: true,
      longAllow: true,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    candles,
    "authoritative",
    `cycle_BTCUSDT_${now}_shock_blocked`
  );

  const res = runEngineV2(input);
  run(
    "TEST_17_SHOCK_HARD_BLOCK_PREVENTS_PROMOTION",
    res.decision.decision !== "ENTER" && res.decision.side === "none",
    `Active directional shock DOWN correctly prevented stair-step UP promotion: decision=${res.decision.decision}, side=${res.decision.side}`
  );
}

// =========================================================================
// TEST 18 — ORDINARY REJECT IS NOT RESURRECTED BY STAIR STEP STRUCTURE
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const now = Date.now();
  const candles = makeStairStepUpCandles(68000);
  const snapReject: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 68850,
    latestCandleClose: 68850,
    signal: "paper_long_candidate",
    qualityScore: 70,
    candidateStrength: "strong",
    ema20: 68600,
    ema60: 68400,
    emaGap: 0.002,
    volumeRatioProxy: 1.2,
    boxHigh: 69000,
    boxLow: 68000,
    boxPos: 0.84,
    boxRel: 0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 68840,
    rangeConfidence: 0.75,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": candles,
      "15m": candles,
      "1h": candles,
      "4h": candles
    }
  };

  const bridge = buildV2SnapshotBridge(snapReject);
  const input = adaptV2Input(
    "BTCUSDT",
    now,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "NONE",
      crashState: "NORMAL",
      shortAllow: true,
      longAllow: true,
      maxUsableMarginKrw: 0, // Exceeded usable margin: triggers pre-promotion REJECT
      exposureNotionalCapKrw: 0,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    candles,
    "authoritative",
    `cycle_BTCUSDT_${now}_reject_not_resurrected`
  );

  const res = runEngineV2(input);
  run(
    "TEST_18_ORDINARY_REJECT_CANNOT_BE_RESURRECTED",
    res.decision.decision === "REJECT" &&
    res.decision.side === "none" &&
    (res.decision.metadata as any)?.promotion_applied !== true &&
    (res.decision.metadata as any)?.promotion_reason !== "V2_STAIR_STEP_CONTINUATION_PROMOTION",
    `Ordinary REJECT correctly maintained without resurrection: decision=${res.decision.decision}, side=${res.decision.side}`
  );
}

// =========================================================================
// TEST 19 — INVERTED PIVOT CHRONOLOGY (HIGH BEFORE LOW) CANNOT MASQUERADE AS UP IMPULSE
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  candles.push({ ts: now - 16 * 60000, open: 68300, high: 68450, low: 68250, close: 68400, volume: 10 });
  candles.push({ ts: now - 15 * 60000, open: 68400, high: 68600, low: 68380, close: 68580, volume: 12 });
  candles.push({ ts: now - 14 * 60000, open: 68580, high: 68590, low: 68300, close: 68320, volume: 10 });
  candles.push({ ts: now - 13 * 60000, open: 68320, high: 68350, low: 68100, close: 68150, volume: 11 });
  candles.push({ ts: now - 12 * 60000, open: 68150, high: 68200, low: 67950, close: 67980, volume: 14 });
  candles.push({ ts: now - 11 * 60000, open: 67980, high: 68050, low: 67900, close: 68020, volume: 13 });
  for (let i = 6; i <= 15; i++) {
    candles.push({ ts: now - (16 - i) * 60000, open: 68020 + (i - 6) * 20, high: 68080 + (i - 6) * 20, low: 68000 + (i - 6) * 20, close: 68060 + (i - 6) * 20, volume: 8 });
  }
  candles.push({ ts: now, open: 68260, high: 68280, low: 68240, close: 68270, volume: 1 });

  const snap: any = {
    symbol: "BTCUSDT",
    lastPrice: 68270,
    latestCandleClose: 68260,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_19_INVERTED_PIVOT_CHRONOLOGY_BLOCKED_FOR_UP",
    res.direction !== "UP" || res.detected === false,
    `High before low inverted chronology correctly rejected: detected=${res.detected}, direction=${res.direction}, block=${res.block_reason}`
  );
}

// =========================================================================
// TEST 20 — INVERTED PIVOT CHRONOLOGY (LOW BEFORE HIGH) CANNOT MASQUERADE AS DOWN IMPULSE
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  candles.push({ ts: now - 16 * 60000, open: 2500, high: 2510, low: 2490, close: 2495, volume: 10 });
  candles.push({ ts: now - 15 * 60000, open: 2495, high: 2500, low: 2460, close: 2470, volume: 12 });
  candles.push({ ts: now - 14 * 60000, open: 2470, high: 2500, low: 2465, close: 2495, volume: 10 });
  candles.push({ ts: now - 13 * 60000, open: 2495, high: 2525, low: 2490, close: 2520, volume: 11 });
  candles.push({ ts: now - 12 * 60000, open: 2520, high: 2545, low: 2510, close: 2540, volume: 14 });
  candles.push({ ts: now - 11 * 60000, open: 2540, high: 2555, low: 2530, close: 2550, volume: 13 });
  for (let i = 6; i <= 15; i++) {
    candles.push({ ts: now - (16 - i) * 60000, open: 2550 - (i - 6) * 5, high: 2555 - (i - 6) * 5, low: 2540 - (i - 6) * 5, close: 2545 - (i - 6) * 5, volume: 8 });
  }
  candles.push({ ts: now, open: 2500, high: 2505, low: 2495, close: 2500, volume: 1 });

  const snap: any = {
    symbol: "ETHUSDT",
    lastPrice: 2500,
    latestCandleClose: 2500,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_20_INVERTED_PIVOT_CHRONOLOGY_BLOCKED_FOR_DOWN",
    res.direction !== "DOWN" || res.detected === false,
    `Low before high inverted chronology correctly rejected: detected=${res.detected}, direction=${res.direction}, block=${res.block_reason}`
  );
}

// =========================================================================
// TEST 21 — MIDPOINT CROSSING UP PIVOTS (H1 AT IDX 9, L2 AT IDX 12) CORRECTLY DETECTED
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  candles.push({ ts: now - 16 * 60000, open: 68050, high: 68100, low: 68020, close: 68040, volume: 10 });
  candles.push({ ts: now - 15 * 60000, open: 68040, high: 68060, low: 68000, close: 68050, volume: 12 });
  candles.push({ ts: now - 14 * 60000, open: 68050, high: 68150, low: 68030, close: 68120, volume: 10 });
  for (let i = 3; i <= 9; i++) {
    const px = 68120 + (i - 2) * 70;
    candles.push({ ts: now - (16 - i) * 60000, open: px - 60, high: px, low: px - 70, close: px - 10, volume: 15 });
  }
  candles.push({ ts: now - 4 * 60000, open: 68590, high: 68600, low: 68480, close: 68500, volume: 8 });
  candles.push({ ts: now - 3 * 60000, open: 68500, high: 68520, low: 68420, close: 68440, volume: 9 });
  candles.push({ ts: now - 2 * 60000, open: 68440, high: 68450, low: 68380, close: 68410, volume: 10 }); // L2
  candles.push({ ts: now - 1 * 60000, open: 68410, high: 68550, low: 68400, close: 68530, volume: 14 });
  candles.push({ ts: now - 0 * 60000, open: 68530, high: 68630, low: 68510, close: 68620, volume: 16 });
  candles.push({ ts: now + 1 * 60000, open: 68620, high: 68680, low: 68600, close: 68670, volume: 18 });
  candles.push({ ts: now + 2 * 60000, open: 68670, high: 68700, low: 68660, close: 68690, volume: 5 });

  const snap: any = {
    symbol: "BTCUSDT",
    lastPrice: 68690,
    latestCandleClose: 68670,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_21_MIDPOINT_CROSSING_UP_PIVOT_DETECTED",
    res.detected === true &&
    res.direction === "UP" &&
    res.pullback_depth_ratio <= 0.65 &&
    res.higher_low_detected === true &&
    res.higher_high_detected === true,
    `Midpoint crossing UP pivot successfully detected: detected=${res.detected}, ratio=${res.pullback_depth_ratio}, H1_idx=${res.impulse_end_idx}, L2_idx=${res.correction_pivot_idx}`
  );
}

// =========================================================================
// TEST 22 — MIDPOINT CROSSING DOWN PIVOTS (L1 AT IDX 9, H2 AT IDX 12) CORRECTLY DETECTED
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  candles.push({ ts: now - 16 * 60000, open: 2590, high: 2595, low: 2585, close: 2590, volume: 10 });
  candles.push({ ts: now - 15 * 60000, open: 2590, high: 2600, low: 2588, close: 2595, volume: 12 });
  candles.push({ ts: now - 14 * 60000, open: 2595, high: 2598, low: 2580, close: 2582, volume: 10 });
  for (let i = 3; i <= 9; i++) {
    const px = 2582 - (i - 2) * 6;
    candles.push({ ts: now - (16 - i) * 60000, open: px + 5, high: px + 6, low: px, close: px + 1, volume: 15 });
  }
  candles.push({ ts: now - 4 * 60000, open: 2541, high: 2550, low: 2540, close: 2548, volume: 8 });
  candles.push({ ts: now - 3 * 60000, open: 2548, high: 2556, low: 2546, close: 2554, volume: 9 });
  candles.push({ ts: now - 2 * 60000, open: 2554, high: 2560, low: 2552, close: 2558, volume: 10 }); // H2
  candles.push({ ts: now - 1 * 60000, open: 2558, high: 2559, low: 2542, close: 2544, volume: 14 });
  candles.push({ ts: now - 0 * 60000, open: 2544, high: 2545, low: 2535, close: 2536, volume: 16 });
  candles.push({ ts: now + 1 * 60000, open: 2536, high: 2537, low: 2528, close: 2530, volume: 18 });
  candles.push({ ts: now + 2 * 60000, open: 2530, high: 2532, low: 2525, close: 2528, volume: 5 });

  const snap: any = {
    symbol: "ETHUSDT",
    lastPrice: 2528,
    latestCandleClose: 2530,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_22_MIDPOINT_CROSSING_DOWN_PIVOT_DETECTED",
    res.detected === true &&
    res.direction === "DOWN" &&
    res.pullback_depth_ratio <= 0.65 &&
    res.lower_high_detected === true &&
    res.lower_low_detected === true,
    `Midpoint crossing DOWN pivot successfully detected: detected=${res.detected}, ratio=${res.pullback_depth_ratio}, L1_idx=${res.impulse_end_idx}, H2_idx=${res.correction_pivot_idx}`
  );
}

// =========================================================================
// TEST 23 — LATEST DEEP PULLBACK (80%) CANNOT BE BYPASSED BY OLDER SHALLOW PULLBACK
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  candles.push({ ts: now - 16 * 60000, open: 68020, high: 68050, low: 68020, close: 68040, volume: 10 });
  candles.push({ ts: now - 15 * 60000, open: 68040, high: 68045, low: 68000, close: 68010, volume: 10 }); // L1 (3-bar low)
  candles.push({ ts: now - 14 * 60000, open: 68010, high: 68100, low: 68010, close: 68090, volume: 12 });
  for (let i = 3; i <= 6; i++) {
    const px = 68090 + (i - 2) * 90;
    candles.push({ ts: now - (16 - i) * 60000, open: px - 50, high: px + 10, low: px - 60, close: px, volume: 12 });
  }
  // idx 7: H1 = 68500 (3-bar high: high[6]=68460, high[7]=68500, high[8]=68450)
  candles.push({ ts: now - 9 * 60000, open: 68450, high: 68500, low: 68440, close: 68480, volume: 14 }); // H1
  // idx 8..12: monotonic drop to L2 deep at idx 12 = 68080 (pullback = 420 on 500 = 84%)
  for (let i = 8; i <= 11; i++) {
    const px = 68480 - (i - 7) * 90;
    candles.push({ ts: now - (16 - i) * 60000, open: px + 20, high: px + 25, low: px - 10, close: px, volume: 10 });
  }
  candles.push({ ts: now - 4 * 60000, open: 68120, high: 68125, low: 68080, close: 68090, volume: 12 }); // L2 (3-bar low: low[11]=68110, low[12]=68080, low[13]=68095)
  candles.push({ ts: now - 3 * 60000, open: 68090, high: 68120, low: 68095, close: 68115, volume: 10 });
  candles.push({ ts: now - 2 * 60000, open: 68115, high: 68150, low: 68110, close: 68145, volume: 10 });
  candles.push({ ts: now - 1 * 60000, open: 68145, high: 68180, low: 68140, close: 68175, volume: 10 });
  candles.push({ ts: now, open: 68175, high: 68190, low: 68170, close: 68185, volume: 2 });

  const snap: any = {
    symbol: "BTCUSDT",
    lastPrice: 68185,
    latestCandleClose: 68175,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_23_LATEST_DEEP_PULLBACK_BLOCKED_AS_TOO_DEEP",
    res.detected === false &&
    res.pullback_depth_ratio > 0.65 &&
    (res.block_reason === "PULLBACK_TOO_DEEP" || res.block_reason === "SLOPE_FLAT_OR_NEGATIVE"),
    `Latest deep pullback correctly blocked: detected=${res.detected}, ratio=${res.pullback_depth_ratio}, block=${res.block_reason}`
  );
}

// =========================================================================
// TEST 24 — LATEST DEEP REBOUND (80%) BLOCKED AS REBOUND_TOO_DEEP (DOWN INVERSE)
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  candles.push({ ts: now - 16 * 60000, open: 2595, high: 2595, low: 2590, close: 2592, volume: 10 });
  candles.push({ ts: now - 15 * 60000, open: 2592, high: 2600, low: 2592, close: 2595, volume: 10 }); // H1 (3-bar high)
  candles.push({ ts: now - 14 * 60000, open: 2595, high: 2596, low: 2575, close: 2577, volume: 12 });
  for (let i = 3; i <= 6; i++) {
    const px = 2577 - (i - 2) * 18;
    candles.push({ ts: now - (16 - i) * 60000, open: px + 10, high: px + 12, low: px - 2, close: px, volume: 12 });
  }
  // idx 7: L1 = 2500 (3-bar low: low[6]=2505, low[7]=2500, low[8]=2510)
  candles.push({ ts: now - 9 * 60000, open: 2505, high: 2515, low: 2500, close: 2508, volume: 14 }); // L1
  // idx 8..12: monotonic rise to H2 deep at idx 12 = 2585 (rebound = 85 on 100 = 85%)
  for (let i = 8; i <= 11; i++) {
    const px = 2508 + (i - 7) * 18;
    candles.push({ ts: now - (16 - i) * 60000, open: px - 4, high: px + 2, low: px - 5, close: px, volume: 10 });
  }
  candles.push({ ts: now - 4 * 60000, open: 2580, high: 2585, low: 2575, close: 2582, volume: 12 }); // H2 (3-bar high: high[11]=2580, high[12]=2585, high[13]=2578)
  candles.push({ ts: now - 3 * 60000, open: 2582, high: 2578, low: 2568, close: 2572, volume: 10 });
  candles.push({ ts: now - 2 * 60000, open: 2572, high: 2570, low: 2560, close: 2564, volume: 10 });
  candles.push({ ts: now - 1 * 60000, open: 2564, high: 2565, low: 2555, close: 2558, volume: 10 });
  candles.push({ ts: now, open: 2558, high: 2560, low: 2552, close: 2555, volume: 2 });

  const snap: any = {
    symbol: "ETHUSDT",
    lastPrice: 2555,
    latestCandleClose: 2558,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_24_LATEST_DEEP_REBOUND_BLOCKED_AS_TOO_DEEP",
    res.detected === false &&
    res.pullback_depth_ratio > 0.65 &&
    (res.block_reason === "REBOUND_TOO_DEEP" || res.block_reason === "SLOPE_FLAT_OR_POSITIVE"),
    `Latest deep rebound correctly blocked: detected=${res.detected}, ratio=${res.pullback_depth_ratio}, block=${res.block_reason}`
  );
}

// =========================================================================
// TEST 25 — NO TRUE UP CORRECTION PIVOT (MONOTONIC NON-PIVOT FLOW FAILS CLOSED)
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // 16 monotonically climbing closed candles without any 3-bar swing low pullback
  for (let i = 0; i <= 15; i++) {
    const px = 68000 + i * 50;
    candles.push({ ts: now - (16 - i) * 60000, open: px, high: px + 40, low: px + 5, close: px + 35, volume: 10 });
  }
  candles.push({ ts: now, open: 68800, high: 68850, low: 68790, close: 68830, volume: 2 });

  const snap: any = {
    symbol: "BTCUSDT",
    lastPrice: 68830,
    latestCandleClose: 68785,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_25_NO_TRUE_UP_CORRECTION_PIVOT_FAILS_CLOSED",
    res.detected === false &&
    res.direction === "NONE" &&
    res.pivot_order_valid === false,
    `Monotonic climb without local correction low correctly fails closed: detected=${res.detected}, direction=${res.direction}, pivot_valid=${res.pivot_order_valid}`
  );
}

// =========================================================================
// TEST 26 — NO TRUE DOWN CORRECTION PIVOT (MONOTONIC DECLINE FAILS CLOSED)
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // 16 monotonically descending closed candles without any 3-bar swing high rebound
  for (let i = 0; i <= 15; i++) {
    const px = 2600 - i * 5;
    candles.push({ ts: now - (16 - i) * 60000, open: px, high: px - 1, low: px - 40, close: px - 35, volume: 10 });
  }
  candles.push({ ts: now, open: 2520, high: 2522, low: 2515, close: 2518, volume: 2 });

  const snap: any = {
    symbol: "ETHUSDT",
    lastPrice: 2518,
    latestCandleClose: 2525,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_26_NO_TRUE_DOWN_CORRECTION_PIVOT_FAILS_CLOSED",
    res.detected === false &&
    res.direction === "NONE" &&
    res.pivot_order_valid === false,
    `Monotonic decline without local rebound high correctly fails closed: detected=${res.detected}, direction=${res.direction}, pivot_valid=${res.pivot_order_valid}`
  );
}

// =========================================================================
// TEST 27 — UP HISTORICAL DILUTION REGRESSION (OLD 100 LOW CANNOT DILUTE RECENT 130->150 LEG)
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // idx 0: old unrelated deep low 68100
  candles.push({ ts: now - 16 * 60000, open: 68150, high: 68180, low: 68100, close: 68140, volume: 10 });
  // idx 1..5: climb to 68145
  for (let i = 1; i <= 5; i++) {
    const px = 68100 + i * 9;
    candles.push({ ts: now - (16 - i) * 60000, open: px, high: px + 4, low: px - 1, close: px + 3, volume: 10 });
  }
  // idx 6: intermediate dip candle
  candles.push({ ts: now - 10 * 60000, open: 68145, high: 68146, low: 68136, close: 68138, volume: 10 });
  // idx 7: local impulse low L1 = 68130 (strict 3-bar low: low[6]=68136, low[7]=68130, low[8]=68135)
  candles.push({ ts: now - 9 * 60000, open: 68138, high: 68140, low: 68130, close: 68138, volume: 12 });
  // idx 8: surge candle
  candles.push({ ts: now - 8 * 60000, open: 68138, high: 68148, low: 68135, close: 68145, volume: 15 });
  // idx 9: impulse peak H1 = 68150 (impulse leg = 68150 - 68130 = 20)
  candles.push({ ts: now - 7 * 60000, open: 68145, high: 68150, low: 68142, close: 68148, volume: 16 });
  // idx 10..11: decline into L2
  candles.push({ ts: now - 6 * 60000, open: 68148, high: 68149, low: 68140, close: 68142, volume: 10 });
  // idx 12: deep local pullback L2 = 68135 (pullback = 68150 - 68135 = 15 => ratio = 15/20 = 0.75)
  candles.push({ ts: now - 5 * 60000, open: 68142, high: 68144, low: 68135, close: 68136, volume: 12 });
  // idx 13..15: bounce
  candles.push({ ts: now - 4 * 60000, open: 68136, high: 68146, low: 68136, close: 68145, volume: 14 });
  candles.push({ ts: now - 3 * 60000, open: 68145, high: 68148, low: 68144, close: 68147, volume: 10 });
  candles.push({ ts: now - 2 * 60000, open: 68147, high: 68151, low: 68146, close: 68150, volume: 12 });
  // Forming candle
  candles.push({ ts: now, open: 68150, high: 68152, low: 68148, close: 68151, volume: 2 });

  const snap: any = {
    symbol: "BTCUSDT",
    lastPrice: 68151,
    latestCandleClose: 68150,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_27_UP_HISTORICAL_DILUTION_BLOCKED_AS_TOO_DEEP",
    res.detected === false &&
    res.impulse_start_idx !== 0 &&
    res.prior_leg_size === 20 &&
    res.correction_amount === 15 &&
    res.pullback_depth_ratio === 0.75 &&
    res.block_reason === "PULLBACK_TOO_DEEP",
    `Historical low avoided: prior_leg=${res.prior_leg_size}, corr=${res.correction_amount}, ratio=${res.pullback_depth_ratio}, L1_idx=${res.impulse_start_idx}, block=${res.block_reason}`
  );
}

// =========================================================================
// TEST 28 — DOWN HISTORICAL DILUTION REGRESSION (OLD 300 HIGH CANNOT DILUTE RECENT 270->250 LEG)
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // idx 0: old unrelated deep high 2600
  candles.push({ ts: now - 16 * 60000, open: 2595, high: 2600, low: 2590, close: 2592, volume: 10 });
  // idx 1..5: decline to 2555
  for (let i = 1; i <= 5; i++) {
    const px = 2590 - i * 7;
    candles.push({ ts: now - (16 - i) * 60000, open: px, high: px + 1, low: px - 4, close: px - 3, volume: 10 });
  }
  // idx 6: intermediate bounce candle
  candles.push({ ts: now - 10 * 60000, open: 2555, high: 2564, low: 2554, close: 2562, volume: 10 });
  // idx 7: local impulse high H1 = 2570 (strict 3-bar high: high[6]=2564, high[7]=2570, high[8]=2567)
  candles.push({ ts: now - 9 * 60000, open: 2568, high: 2570, low: 2566, close: 2567, volume: 12 });
  // idx 8: drop candle
  candles.push({ ts: now - 8 * 60000, open: 2567, high: 2567, low: 2555, close: 2556, volume: 15 });
  // idx 9: impulse trough L1 = 2550 (impulse leg = 2570 - 2550 = 20)
  candles.push({ ts: now - 7 * 60000, open: 2556, high: 2558, low: 2550, close: 2552, volume: 16 });
  // idx 10..11: rebound into H2
  candles.push({ ts: now - 6 * 60000, open: 2552, high: 2560, low: 2551, close: 2559, volume: 10 });
  // idx 12: deep local rebound H2 = 2565 (rebound = 2565 - 2550 = 15 => ratio = 15/20 = 0.75)
  candles.push({ ts: now - 5 * 60000, open: 2559, high: 2565, low: 2558, close: 2564, volume: 12 });
  // idx 13..15: redecline
  candles.push({ ts: now - 4 * 60000, open: 2564, high: 2564, low: 2554, close: 2555, volume: 14 });
  candles.push({ ts: now - 3 * 60000, open: 2555, high: 2556, low: 2551, close: 2552, volume: 10 });
  candles.push({ ts: now - 2 * 60000, open: 2552, high: 2553, low: 2548, close: 2549, volume: 12 });
  // Forming candle
  candles.push({ ts: now, open: 2549, high: 2550, low: 2547, close: 2548, volume: 2 });

  const snap: any = {
    symbol: "ETHUSDT",
    lastPrice: 2548,
    latestCandleClose: 2549,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_28_DOWN_HISTORICAL_DILUTION_BLOCKED_AS_TOO_DEEP",
    res.detected === false &&
    res.impulse_start_idx !== 0 &&
    res.prior_leg_size === 20 &&
    res.correction_amount === 15 &&
    res.pullback_depth_ratio === 0.75 &&
    res.block_reason === "REBOUND_TOO_DEEP",
    `Historical high avoided: prior_leg=${res.prior_leg_size}, corr=${res.correction_amount}, ratio=${res.pullback_depth_ratio}, H1_idx=${res.impulse_start_idx}, block=${res.block_reason}`
  );
}

// =========================================================================
// TEST 29 — VALID LOCAL UP STAIR STEP STILL DETECTS (RATIO ~0.40)
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  for (let i = 0; i <= 2; i++) {
    candles.push({ ts: now - (16 - i) * 60000, open: 68000 + i * 10, high: 68020 + i * 10, low: 67990 + i * 10, close: 68010 + i * 10, volume: 10 });
  }
  // idx 3: intermediate (low=68045)
  candles.push({ ts: now - 13 * 60000, open: 68050, high: 68060, low: 68045, close: 68050, volume: 10 });
  // idx 4: L1 = 68030 (strict 3-bar low: low[3]=68045, low[4]=68030, low[5]=68035)
  candles.push({ ts: now - 12 * 60000, open: 68050, high: 68055, low: 68030, close: 68038, volume: 12 });
  // idx 5..7: surge to H1 = 68130 (impulse = 100)
  candles.push({ ts: now - 11 * 60000, open: 68038, high: 68075, low: 68035, close: 68070, volume: 14 });
  candles.push({ ts: now - 10 * 60000, open: 68070, high: 68110, low: 68065, close: 68105, volume: 15 });
  candles.push({ ts: now - 9 * 60000, open: 68105, high: 68130, low: 68100, close: 68125, volume: 16 }); // H1 (3-bar high: high[6]=68110, high[7]=68130, high[8]=68126)
  // idx 8..10: shallow pullback to L2 = 68090 (pullback = 40 on 100 = 40%)
  candles.push({ ts: now - 8 * 60000, open: 68125, high: 68126, low: 68105, close: 68110, volume: 8 });
  candles.push({ ts: now - 7 * 60000, open: 68110, high: 68112, low: 68090, close: 68095, volume: 10 }); // L2
  candles.push({ ts: now - 6 * 60000, open: 68095, high: 68115, low: 68094, close: 68112, volume: 12 });
  // idx 11..15: breakout climb above H1
  for (let i = 11; i <= 15; i++) {
    const px = 68112 + (i - 10) * 15;
    candles.push({ ts: now - (16 - i) * 60000, open: px - 10, high: px + 5, low: px - 12, close: px + 2, volume: 14 });
  }
  // Forming candle
  candles.push({ ts: now, open: 68190, high: 68200, low: 68185, close: 68195, volume: 2 });

  const snap: any = {
    symbol: "BTCUSDT",
    lastPrice: 68195,
    latestCandleClose: 68187,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_29_VALID_LOCAL_UP_STAIR_STEP_DETECTS",
    res.detected === true &&
    res.direction === "UP" &&
    res.pivot_order_valid === true &&
    res.pullback_depth_ratio <= 0.65,
    `Valid local UP stair-step detected: detected=${res.detected}, direction=${res.direction}, ratio=${res.pullback_depth_ratio}`
  );
}

// =========================================================================
// TEST 30 — VALID LOCAL DOWN STAIR STEP STILL DETECTS (RATIO ~0.40)
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  for (let i = 0; i <= 2; i++) {
    candles.push({ ts: now - (16 - i) * 60000, open: 2600 - i * 2, high: 2602 - i * 2, low: 2598 - i * 2, close: 2599 - i * 2, volume: 10 });
  }
  // idx 3: intermediate (high=2591)
  candles.push({ ts: now - 13 * 60000, open: 2590, high: 2591, low: 2588, close: 2590, volume: 10 });
  // idx 4: H1 = 2598 (strict 3-bar high: high[3]=2591, high[4]=2598, high[5]=2592)
  candles.push({ ts: now - 12 * 60000, open: 2590, high: 2598, low: 2590, close: 2595, volume: 12 });
  // idx 5..7: drop to L1 = 2544 (impulse = 54)
  candles.push({ ts: now - 11 * 60000, open: 2595, high: 2592, low: 2575, close: 2576, volume: 14 });
  candles.push({ ts: now - 10 * 60000, open: 2576, high: 2577, low: 2555, close: 2556, volume: 15 });
  candles.push({ ts: now - 9 * 60000, open: 2556, high: 2558, low: 2544, close: 2546, volume: 16 }); // L1 (3-bar low: low[6]=2555, low[7]=2544, low[8]=2545)
  // idx 8..10: shallow rebound to H2 = 2564 (rebound = 20 on 54 = 37%)
  candles.push({ ts: now - 8 * 60000, open: 2546, high: 2558, low: 2545, close: 2557, volume: 8 });
  candles.push({ ts: now - 7 * 60000, open: 2557, high: 2564, low: 2556, close: 2563, volume: 10 }); // H2
  candles.push({ ts: now - 6 * 60000, open: 2563, high: 2563, low: 2550, close: 2552, volume: 12 });
  // idx 11..15: breakdown drop below L1
  for (let i = 11; i <= 15; i++) {
    const px = 2552 - (i - 10) * 5;
    candles.push({ ts: now - (16 - i) * 60000, open: px + 4, high: px + 5, low: px - 2, close: px - 1, volume: 14 });
  }
  // Forming candle
  candles.push({ ts: now, open: 2525, high: 2526, low: 2520, close: 2522, volume: 2 });

  const snap: any = {
    symbol: "ETHUSDT",
    lastPrice: 2522,
    latestCandleClose: 2527,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_30_VALID_LOCAL_DOWN_STAIR_STEP_DETECTS",
    res.detected === true &&
    res.direction === "DOWN" &&
    res.pivot_order_valid === true &&
    res.pullback_depth_ratio <= 0.65,
    `Valid local DOWN stair-step detected: detected=${res.detected}, direction=${res.direction}, ratio=${res.pullback_depth_ratio}`
  );
}

// =========================================================================
// TEST 31 — OLD EXTREME CANNOT DILUTE VALID RECENT UP LEG (L1->H1 USED AS DENOMINATOR)
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // idx 0: much deeper old low 67000
  candles.push({ ts: now - 16 * 60000, open: 67100, high: 67120, low: 67000, close: 67080, volume: 20 });
  // idx 1..4: climb to 68020
  for (let i = 1; i <= 4; i++) {
    const px = 67080 + i * 230;
    candles.push({ ts: now - (16 - i) * 60000, open: px - 50, high: px + 10, low: px - 60, close: px, volume: 10 });
  }
  // idx 5: intermediate high candle (low=68010)
  candles.push({ ts: now - 11 * 60000, open: 68020, high: 68030, low: 68010, close: 68015, volume: 10 });
  // idx 6: local L1 = 68000 (strict 3-bar low: low[5]=68010, low[6]=68000, low[7]=68005)
  candles.push({ ts: now - 10 * 60000, open: 68010, high: 68015, low: 68000, close: 68008, volume: 12 });
  // idx 7..8: surge to H1 = 68200 (leg = 200)
  candles.push({ ts: now - 9 * 60000, open: 68008, high: 68110, low: 68005, close: 68100, volume: 14 });
  candles.push({ ts: now - 8 * 60000, open: 68100, high: 68200, low: 68095, close: 68190, volume: 15 }); // H1
  // idx 9..10: pullback to L2 = 68120 (pullback = 80 on 200 = 40%)
  candles.push({ ts: now - 7 * 60000, open: 68190, high: 68195, low: 68130, close: 68135, volume: 10 });
  candles.push({ ts: now - 6 * 60000, open: 68135, high: 68140, low: 68120, close: 68128, volume: 11 }); // L2
  // idx 11..15: breakout above H1
  for (let i = 11; i <= 15; i++) {
    const px = 68128 + (i - 10) * 20;
    candles.push({ ts: now - (16 - i) * 60000, open: px - 10, high: px + 5, low: px - 12, close: px + 2, volume: 14 });
  }
  candles.push({ ts: now, open: 68230, high: 68240, low: 68225, close: 68235, volume: 2 });

  const snap: any = {
    symbol: "BTCUSDT",
    lastPrice: 68235,
    latestCandleClose: 68228,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_31_OLD_EXTREME_CANNOT_DILUTE_VALID_RECENT_UP_LEG",
    res.detected === true &&
    res.impulse_start_idx === 6 &&
    res.prior_leg_size === 200 &&
    res.correction_amount === 80 &&
    res.pullback_depth_ratio === 0.4,
    `Local prior leg precisely measured: prior_leg=${res.prior_leg_size} (not 1200), corr=${res.correction_amount}, ratio=${res.pullback_depth_ratio}, L1_idx=${res.impulse_start_idx}`
  );
}

// =========================================================================
// TEST 32 — OLD EXTREME CANNOT DILUTE VALID RECENT DOWN LEG (H1->L1 USED AS DENOMINATOR)
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // idx 0: much higher old high 3000
  candles.push({ ts: now - 16 * 60000, open: 2980, high: 3000, low: 2970, close: 2975, volume: 20 });
  // idx 1..4: decline to 2580
  for (let i = 1; i <= 4; i++) {
    const px = 2975 - i * 95;
    candles.push({ ts: now - (16 - i) * 60000, open: px + 20, high: px + 25, low: px - 10, close: px, volume: 10 });
  }
  // idx 5: intermediate low candle (high=2590)
  candles.push({ ts: now - 11 * 60000, open: 2580, high: 2590, low: 2575, close: 2585, volume: 10 });
  // idx 6: local H1 = 2600 (strict 3-bar high: high[5]=2590, high[6]=2600, high[7]=2595)
  candles.push({ ts: now - 10 * 60000, open: 2595, high: 2600, low: 2590, close: 2595, volume: 12 });
  // idx 7..8: drop to L1 = 2500 (leg = 100)
  candles.push({ ts: now - 9 * 60000, open: 2595, high: 2595, low: 2550, close: 2555, volume: 14 });
  candles.push({ ts: now - 8 * 60000, open: 2555, high: 2556, low: 2500, close: 2505, volume: 15 }); // L1
  // idx 9..10: rebound to H2 = 2540 (rebound = 40 on 100 = 40%)
  candles.push({ ts: now - 7 * 60000, open: 2505, high: 2535, low: 2504, close: 2530, volume: 10 });
  candles.push({ ts: now - 6 * 60000, open: 2530, high: 2540, low: 2528, close: 2536, volume: 11 }); // H2
  // idx 11..15: breakdown below L1
  for (let i = 11; i <= 15; i++) {
    const px = 2536 - (i - 10) * 10;
    candles.push({ ts: now - (16 - i) * 60000, open: px + 5, high: px + 6, low: px - 3, close: px - 2, volume: 14 });
  }
  candles.push({ ts: now, open: 2480, high: 2482, low: 2475, close: 2478, volume: 2 });

  const snap: any = {
    symbol: "ETHUSDT",
    lastPrice: 2478,
    latestCandleClose: 2486,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_32_OLD_EXTREME_CANNOT_DILUTE_VALID_RECENT_DOWN_LEG",
    res.detected === true &&
    res.impulse_start_idx === 6 &&
    res.prior_leg_size === 100 &&
    res.correction_amount === 40 &&
    res.pullback_depth_ratio === 0.4,
    `Local prior leg precisely measured: prior_leg=${res.prior_leg_size} (not 500), corr=${res.correction_amount}, ratio=${res.pullback_depth_ratio}, H1_idx=${res.impulse_start_idx}`
  );
}

// =========================================================================
// TEST 33 — WINDOW ENDPOINT CANNOT BECOME FAKE UP CORRECTION PIVOT
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // 15 climbing candles, only the 16th closed candle (idx 15) is slightly lower without a right-side candle
  for (let i = 0; i <= 14; i++) {
    const px = 68000 + i * 20;
    candles.push({ ts: now - (16 - i) * 60000, open: px - 10, high: px + 10, low: px - 12, close: px + 5, volume: 10 });
  }
  // idx 15: last closed candle lower than idx 14, but no idx 16 right-side confirmation
  candles.push({ ts: now - 1 * 60000, open: 68280, high: 68282, low: 68240, close: 68245, volume: 12 });
  // Forming candle
  candles.push({ ts: now, open: 68245, high: 68260, low: 68240, close: 68255, volume: 2 });

  const snap: any = {
    symbol: "BTCUSDT",
    lastPrice: 68255,
    latestCandleClose: 68245,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_33_WINDOW_ENDPOINT_CANNOT_BE_FAKE_UP_PIVOT",
    res.correction_pivot_idx !== 15,
    `Endpoint at idx 15 rejected as fake L2 pivot: correction_pivot_idx=${res.correction_pivot_idx}, detected=${res.detected}`
  );
}

// =========================================================================
// TEST 34 — WINDOW ENDPOINT CANNOT BECOME FAKE DOWN REBOUND PIVOT
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // 15 falling candles, only the 16th closed candle (idx 15) is slightly higher without a right-side candle
  for (let i = 0; i <= 14; i++) {
    const px = 2600 - i * 5;
    candles.push({ ts: now - (16 - i) * 60000, open: px + 2, high: px + 3, low: px - 3, close: px - 2, volume: 10 });
  }
  // idx 15: last closed candle higher than idx 14, but no idx 16 right-side confirmation
  candles.push({ ts: now - 1 * 60000, open: 2528, high: 2535, low: 2527, close: 2534, volume: 12 });
  // Forming candle
  candles.push({ ts: now, open: 2534, high: 2535, low: 2530, close: 2531, volume: 2 });

  const snap: any = {
    symbol: "ETHUSDT",
    lastPrice: 2531,
    latestCandleClose: 2534,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_34_WINDOW_ENDPOINT_CANNOT_BE_FAKE_DOWN_PIVOT",
    res.correction_pivot_idx !== 15,
    `Endpoint at idx 15 rejected as fake H2 pivot: correction_pivot_idx=${res.correction_pivot_idx}, detected=${res.detected}`
  );
}

// =========================================================================
// TEST 35 — UP HAS VALID L2 BUT NO VALID 3-BAR H1 BEFORE IT FAILS CLOSED
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // idx 0..9: monotonic climb without any 3-bar swing high (high continuously increasing)
  for (let i = 0; i <= 9; i++) {
    const px = 68000 + i * 20;
    candles.push({ ts: now - (16 - i) * 60000, open: px - 5, high: px + 15, low: px - 6, close: px + 10, volume: 10 });
  }
  // idx 10..12: pullback to L2 at idx 11
  candles.push({ ts: now - 6 * 60000, open: 68190, high: 68195, low: 68160, close: 68165, volume: 10 });
  candles.push({ ts: now - 5 * 60000, open: 68165, high: 68170, low: 68140, close: 68145, volume: 12 }); // L2 (3-bar low)
  candles.push({ ts: now - 4 * 60000, open: 68145, high: 68180, low: 68145, close: 68175, volume: 14 });
  // idx 13..15: climb
  for (let i = 13; i <= 15; i++) {
    const px = 68175 + (i - 12) * 20;
    candles.push({ ts: now - (16 - i) * 60000, open: px - 5, high: px + 10, low: px - 8, close: px + 5, volume: 10 });
  }
  candles.push({ ts: now, open: 68235, high: 68245, low: 68230, close: 68240, volume: 2 });

  const snap: any = {
    symbol: "BTCUSDT",
    lastPrice: 68240,
    latestCandleClose: 68235,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_35_UP_NO_VALID_3BAR_H1_FAILS_CLOSED",
    res.detected === false &&
    res.pivot_order_valid === false,
    `Missing 3-bar H1 correctly rejected: detected=${res.detected}, pivot_valid=${res.pivot_order_valid}, H1_idx=${res.impulse_end_idx}`
  );
}

// =========================================================================
// TEST 36 — UP HAS VALID H1/L2 BUT NO VALID 3-BAR L1 BEFORE H1 FAILS CLOSED
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // idx 0..5: monotonic climb without any 3-bar low (low continuously increasing)
  for (let i = 0; i <= 5; i++) {
    const px = 68000 + i * 25;
    candles.push({ ts: now - (16 - i) * 60000, open: px, high: px + 20, low: px + 2, close: px + 18, volume: 10 });
  }
  // idx 6..8: H1 at idx 7 (3-bar high: high[6]=68155, high[7]=68180, high[8]=68150), lows strictly increasing (low[5]=68127, low[6]=68130, low[7]=68135)
  candles.push({ ts: now - 10 * 60000, open: 68130, high: 68155, low: 68130, close: 68150, volume: 10 });
  candles.push({ ts: now - 9 * 60000, open: 68150, high: 68180, low: 68135, close: 68170, volume: 15 }); // H1
  candles.push({ ts: now - 8 * 60000, open: 68170, high: 68172, low: 68130, close: 68135, volume: 10 });
  // idx 9..11: L2 at idx 10 (3-bar low: low[9]=68130, low[10]=68110, low[11]=68125)
  candles.push({ ts: now - 7 * 60000, open: 68135, high: 68140, low: 68125, close: 68130, volume: 10 });
  candles.push({ ts: now - 6 * 60000, open: 68130, high: 68135, low: 68110, close: 68115, volume: 12 }); // L2
  candles.push({ ts: now - 5 * 60000, open: 68115, high: 68145, low: 68112, close: 68140, volume: 14 });
  // idx 12..15: breakout
  for (let i = 12; i <= 15; i++) {
    const px = 68140 + (i - 11) * 20;
    candles.push({ ts: now - (16 - i) * 60000, open: px - 5, high: px + 10, low: px - 8, close: px + 5, volume: 10 });
  }
  candles.push({ ts: now, open: 68220, high: 68230, low: 68215, close: 68225, volume: 2 });

  const snap: any = {
    symbol: "BTCUSDT",
    lastPrice: 68225,
    latestCandleClose: 68220,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_36_UP_NO_VALID_3BAR_L1_FAILS_CLOSED",
    res.detected === false &&
    res.pivot_order_valid === false,
    `Missing 3-bar L1 correctly rejected: detected=${res.detected}, pivot_valid=${res.pivot_order_valid}, L1_idx=${res.impulse_start_idx}`
  );
}

// =========================================================================
// TEST 37 — DOWN HAS VALID H2 BUT NO VALID 3-BAR L1 BEFORE IT FAILS CLOSED
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // idx 0..9: monotonic decline without any 3-bar swing low
  for (let i = 0; i <= 9; i++) {
    const px = 2600 - i * 5;
    candles.push({ ts: now - (16 - i) * 60000, open: px + 2, high: px + 3, low: px - 4, close: px - 3, volume: 10 });
  }
  // idx 10..12: rebound to H2 at idx 11
  candles.push({ ts: now - 6 * 60000, open: 2552, high: 2555, low: 2550, close: 2554, volume: 10 });
  candles.push({ ts: now - 5 * 60000, open: 2554, high: 2565, low: 2553, close: 2564, volume: 12 }); // H2 (3-bar high)
  candles.push({ ts: now - 4 * 60000, open: 2564, high: 2564, low: 2550, close: 2552, volume: 14 });
  // idx 13..15: decline
  for (let i = 13; i <= 15; i++) {
    const px = 2552 - (i - 12) * 5;
    candles.push({ ts: now - (16 - i) * 60000, open: px + 2, high: px + 3, low: px - 4, close: px - 3, volume: 10 });
  }
  candles.push({ ts: now, open: 2535, high: 2536, low: 2530, close: 2532, volume: 2 });

  const snap: any = {
    symbol: "ETHUSDT",
    lastPrice: 2532,
    latestCandleClose: 2537,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_37_DOWN_NO_VALID_3BAR_L1_FAILS_CLOSED",
    res.detected === false &&
    res.pivot_order_valid === false,
    `Missing 3-bar L1 for DOWN correctly rejected: detected=${res.detected}, pivot_valid=${res.pivot_order_valid}, L1_idx=${res.impulse_end_idx}`
  );
}

// =========================================================================
// TEST 38 — DOWN HAS VALID L1/H2 BUT NO VALID 3-BAR H1 BEFORE L1 FAILS CLOSED
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // idx 0..5: monotonic decline without any 3-bar swing high
  for (let i = 0; i <= 5; i++) {
    const px = 2600 - i * 6;
    candles.push({ ts: now - (16 - i) * 60000, open: px, high: px - 1, low: px - 5, close: px - 4, volume: 10 });
  }
  // idx 6..8: L1 at idx 7 (3-bar low: low[6]=2568, low[7]=2550, low[8]=2560), highs strictly decreasing (high[5]=2569, high[6]=2568, high[7]=2565)
  candles.push({ ts: now - 10 * 60000, open: 2568, high: 2568, low: 2564, close: 2566, volume: 10 });
  candles.push({ ts: now - 9 * 60000, open: 2566, high: 2565, low: 2550, close: 2552, volume: 15 }); // L1
  candles.push({ ts: now - 8 * 60000, open: 2552, high: 2565, low: 2551, close: 2562, volume: 10 });
  // idx 9..11: H2 at idx 10 (3-bar high: high[9]=2564, high[10]=2575, high[11]=2562)
  candles.push({ ts: now - 7 * 60000, open: 2562, high: 2564, low: 2558, close: 2560, volume: 10 });
  candles.push({ ts: now - 6 * 60000, open: 2560, high: 2575, low: 2559, close: 2572, volume: 12 }); // H2
  candles.push({ ts: now - 5 * 60000, open: 2572, high: 2572, low: 2555, close: 2556, volume: 14 });
  // idx 12..15: breakdown
  for (let i = 12; i <= 15; i++) {
    const px = 2556 - (i - 11) * 6;
    candles.push({ ts: now - (16 - i) * 60000, open: px + 2, high: px + 3, low: px - 4, close: px - 3, volume: 10 });
  }
  candles.push({ ts: now, open: 2530, high: 2532, low: 2525, close: 2528, volume: 2 });

  const snap: any = {
    symbol: "ETHUSDT",
    lastPrice: 2528,
    latestCandleClose: 2532,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_38_DOWN_NO_VALID_3BAR_H1_FAILS_CLOSED",
    res.detected === false &&
    res.pivot_order_valid === false,
    `Missing 3-bar H1 for DOWN correctly rejected: detected=${res.detected}, pivot_valid=${res.pivot_order_valid}, H1_idx=${res.impulse_start_idx}`
  );
}

// =========================================================================
// TEST 39 — RAW WICK MAXIMUM BEFORE L2 NOT A LOCAL SWING HIGH IS REJECTED
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // idx 0..3: climb
  for (let i = 0; i <= 3; i++) {
    candles.push({ ts: now - (16 - i) * 60000, open: 68000 + i * 10, high: 68020 + i * 10, low: 67990 + i * 10, close: 68010 + i * 10, volume: 10 });
  }
  // idx 4: L1 = 68030 (3-bar low)
  candles.push({ ts: now - 12 * 60000, open: 68040, high: 68045, low: 68030, close: 68038, volume: 12 });
  // idx 5: intermediate climb
  candles.push({ ts: now - 11 * 60000, open: 68038, high: 68075, low: 68035, close: 68070, volume: 14 });
  // idx 6: H1 = 68130 (valid 3-bar swing high: high[5]=68075, high[6]=68130, high[7]=68120)
  candles.push({ ts: now - 10 * 60000, open: 68070, high: 68130, low: 68065, close: 68125, volume: 15 }); // H1
  // idx 7: candle with RAW WICK high 68150, but right candle idx 8 has higher high 68160 (so idx 7 is NOT a 3-bar high)
  candles.push({ ts: now - 9 * 60000, open: 68125, high: 68150, low: 68115, close: 68135, volume: 10 });
  // idx 8: higher high 68160, but idx 9 is 68170 (not a 3-bar high)
  candles.push({ ts: now - 8 * 60000, open: 68135, high: 68160, low: 68130, close: 68155, volume: 12 });
  // idx 9: peak high 68170 (valid 3-bar swing high: high[8]=68160, high[9]=68170, high[10]=68120)
  candles.push({ ts: now - 7 * 60000, open: 68155, high: 68170, low: 68140, close: 68160, volume: 14 }); // Real H1
  // idx 10..12: L2 at idx 11 = 68100 (3-bar low: low[10]=68120, low[11]=68100, low[12]=68115)
  candles.push({ ts: now - 6 * 60000, open: 68160, high: 68162, low: 68120, close: 68125, volume: 10 });
  candles.push({ ts: now - 5 * 60000, open: 68125, high: 68130, low: 68100, close: 68105, volume: 12 }); // L2
  candles.push({ ts: now - 4 * 60000, open: 68105, high: 68125, low: 68115, close: 68120, volume: 12 });
  // idx 13..15: breakout
  for (let i = 13; i <= 15; i++) {
    const px = 68120 + (i - 12) * 25;
    candles.push({ ts: now - (16 - i) * 60000, open: px - 10, high: px + 5, low: px - 12, close: px + 2, volume: 14 });
  }
  candles.push({ ts: now, open: 68200, high: 68210, low: 68195, close: 68205, volume: 2 });

  const snap: any = {
    symbol: "BTCUSDT",
    lastPrice: 68205,
    latestCandleClose: 68195,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_39_RAW_WICK_MAX_REJECTED_AS_H1",
    res.impulse_end_idx === 9,
    `Nearest genuine 3-bar swing high selected (idx 9, not raw non-pivot wick idx 7/8): H1_idx=${res.impulse_end_idx}`
  );
}

// =========================================================================
// TEST 40 — RAW WICK MINIMUM BEFORE H2 NOT A LOCAL SWING LOW IS REJECTED
// =========================================================================
{
  const now = Date.now();
  const candles: Candle[] = [];
  // idx 0..3: decline
  for (let i = 0; i <= 3; i++) {
    candles.push({ ts: now - (16 - i) * 60000, open: 2600 - i * 2, high: 2602 - i * 2, low: 2598 - i * 2, close: 2599 - i * 2, volume: 10 });
  }
  // idx 4: H1 = 2594 (3-bar high)
  candles.push({ ts: now - 12 * 60000, open: 2592, high: 2594, low: 2590, close: 2592, volume: 12 });
  // idx 5: intermediate drop
  candles.push({ ts: now - 11 * 60000, open: 2592, high: 2592, low: 2575, close: 2576, volume: 14 });
  // idx 6..8: dropping to real 3-bar swing low L1 at idx 9 = 2540 (low[8]=2548, low[9]=2540, low[10]=2555)
  candles.push({ ts: now - 10 * 60000, open: 2576, high: 2577, low: 2560, close: 2562, volume: 10 });
  candles.push({ ts: now - 9 * 60000, open: 2562, high: 2563, low: 2552, close: 2554, volume: 12 });
  candles.push({ ts: now - 8 * 60000, open: 2554, high: 2555, low: 2548, close: 2549, volume: 14 });
  candles.push({ ts: now - 7 * 60000, open: 2549, high: 2550, low: 2540, close: 2542, volume: 16 }); // Real L1
  // idx 10..12: H2 at idx 11 = 2565 (3-bar high: high[10]=2558, high[11]=2565, high[12]=2556)
  candles.push({ ts: now - 6 * 60000, open: 2542, high: 2558, low: 2541, close: 2556, volume: 10 });
  candles.push({ ts: now - 5 * 60000, open: 2556, high: 2565, low: 2555, close: 2564, volume: 12 }); // H2
  candles.push({ ts: now - 4 * 60000, open: 2564, high: 2556, low: 2545, close: 2548, volume: 12 });
  // idx 13..15: breakdown
  for (let i = 13; i <= 15; i++) {
    const px = 2548 - (i - 12) * 6;
    candles.push({ ts: now - (16 - i) * 60000, open: px + 2, high: px + 3, low: px - 4, close: px - 3, volume: 14 });
  }
  candles.push({ ts: now, open: 2525, high: 2526, low: 2520, close: 2522, volume: 2 });

  const snap: any = {
    symbol: "ETHUSDT",
    lastPrice: 2522,
    latestCandleClose: 2527,
    candles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };
  const judgment: any = {
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    data_ready: true,
    htf_entry_policy: "ALLOW"
  };

  const res = detectStairStepStructure({ candles, snapshot: snap, judgment });
  run(
    "TEST_40_RAW_WICK_MIN_REJECTED_AS_L1",
    res.impulse_end_idx === 9,
    `Nearest genuine 3-bar swing low selected (idx 9, not raw non-pivot wick): L1_idx=${res.impulse_end_idx}`
  );
}

console.log("\nALL 40 V2 STAIR-STEP STRUCTURE & PROMOTION TESTS PASSED (TEST 1 - TEST 40)!");
