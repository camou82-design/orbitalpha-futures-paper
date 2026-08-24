/**
 * V2 STAIR-STEP CONTINUOUS TREND STRUCTURE & SYMMETRY TEST SUITE
 *
 * Verifies:
 * TEST 1: Uptrend -> shallow pullback -> re-advance -> STAIR_STEP_UP detected
 * TEST 2: Downtrend -> shallow rebound -> re-decline -> STAIR_STEP_DOWN detected (exact inverse symmetry)
 * TEST 3: Flat range chop -> NONE detected
 * TEST 4: Single upward spike without follow-through -> NONE detected (spike filter)
 * TEST 5: Single downward spike without follow-through -> NONE detected (spike filter)
 * TEST 6: Deep retracement / trend breach (> 75% pullback) -> NONE detected
 * TEST 7: Current production scenario: RANGE_FAKE_BREAKOUT + HTF BULLISH + higher-low progression -> shadow STAIR_STEP_UP=true, but authoritative decision=SKIP, side=none, size=0 strictly preserved (Execution Invariance)
 * TEST 8: Downward inverse scenario: RANGE_FAKE_BREAKOUT + HTF BEARISH + lower-high progression -> shadow STAIR_STEP_DOWN=true, but authoritative decision=SKIP, side=none, size=0 strictly preserved (Execution Invariance)
 * TEST 9: In-flight forming candle instantaneous spike with insufficient closed candles -> returns NONE (forming candle isolation)
 * TEST 10: Subsequent candle closure confirming healthy structure -> returns STAIR_STEP_UP
 * TEST 11: In-flight forming candle instantaneous breakdown spike with insufficient closed candles -> returns NONE (DOWN forming candle isolation)
 * TEST 12: Subsequent candle closure confirming healthy structure -> returns STAIR_STEP_DOWN
 * TEST 13: HTF SHORT_ONLY_OR_NONE / STRONG_BEARISH_HTF_ALIGNMENT correctly vetoes STAIR_STEP_UP (block_reason=HTF_HARD_VETO)
 * TEST 14: HTF LONG_ONLY_OR_NONE / STRONG_BULLISH_HTF_ALIGNMENT correctly vetoes STAIR_STEP_DOWN (block_reason=HTF_HARD_VETO)
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

function run(label: string, passed: boolean, detail: string): boolean {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[STAIR-STEP-TEST][${label}] ${tag} — ${detail}`);
  if (!passed) {
    throw new Error(`[STAIR-STEP-TEST][${label}] FAILED: ${detail}`);
  }
  return passed;
}

console.log("=== STARTING V2 STAIR-STEP STRUCTURE & SYMMETRY TESTS ===");

// -------------------------------------------------------------------------
// Helper: Candle Generators
// -------------------------------------------------------------------------

/** Generates 17 candles (16 closed + 1 in-flight forming) for healthy stair-step up */
function makeStairStepUpCandles(base = 65000): Candle[] {
  const now = Date.now();
  const pattern = [
    { o: 65000, h: 65050, l: 64980, c: 65020 },
    { o: 65020, h: 65080, l: 65000, c: 65050 },
    { o: 65050, h: 65100, l: 65030, c: 65080 },
    { o: 65080, h: 65120, l: 65060, c: 65100 },
    { o: 65100, h: 65150, l: 65090, c: 65130 },
    // Impulse 1
    { o: 65130, h: 65300, l: 65120, c: 65280 },
    { o: 65280, h: 65450, l: 65260, c: 65420 },
    { o: 65420, h: 65600, l: 65400, c: 65580 },
    { o: 65580, h: 65650, l: 65550, c: 65620 },
    // Shallow pullback
    { o: 65620, h: 65630, l: 65480, c: 65500 },
    { o: 65500, h: 65520, l: 65420, c: 65440 },
    { o: 65440, h: 65460, l: 65400, c: 65430 },
    // Re-advance & Reclaim
    { o: 65430, h: 65580, l: 65420, c: 65560 },
    { o: 65560, h: 65700, l: 65540, c: 65680 },
    { o: 65680, h: 65820, l: 65660, c: 65800 },
    { o: 65800, h: 65850, l: 65780, c: 65840 },
    // In-flight forming candle (last element)
    { o: 65840, h: 65860, l: 65830, c: 65850 }
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
    { o: 65000, h: 65020, l: 64950, c: 64980 },
    { o: 64980, h: 65000, l: 64920, c: 64950 },
    { o: 64950, h: 64970, l: 64900, c: 64920 },
    { o: 64920, h: 64940, l: 64880, c: 64900 },
    { o: 64900, h: 64910, l: 64850, c: 64870 },
    // Impulse down
    { o: 64870, h: 64880, l: 64700, c: 64720 },
    { o: 64720, h: 64740, l: 64550, c: 64580 },
    { o: 64580, h: 64600, l: 64400, c: 64420 },
    { o: 64420, h: 64450, l: 64350, c: 64380 },
    // Shallow rebound
    { o: 64380, h: 64520, l: 64370, c: 64500 },
    { o: 64500, h: 64580, l: 64480, c: 64560 },
    { o: 64560, h: 64600, l: 64540, c: 64570 },
    // Re-decline & Rejection
    { o: 64570, h: 64580, l: 64420, c: 64440 },
    { o: 64440, h: 64460, l: 64300, c: 64320 },
    { o: 64320, h: 64340, l: 64180, c: 64200 },
    { o: 64200, h: 64220, l: 64150, c: 64160 },
    // In-flight forming candle (last element)
    { o: 64160, h: 64170, l: 64140, c: 64150 }
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
// TEST 7 — PRODUCTION SCENARIO: RANGE_FAKE_BREAKOUT + BULLISH HTF
//          Shadow STAIR_STEP_UP=true while authoritative execution invariance
//          (decision=SKIP, side=none, size=0) is 100% PRESERVED.
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
    `cycle_BTCUSDT_${now}_stair_up`
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
      paperExecutionReady: true
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
    runCycleId: `cycle_BTCUSDT_${now}_stair_up_env`
  });

  const v2Env = env.v2_execution_envelope;

  run(
    "TEST_7_STAIR_STEP_UP_SHADOW_WITH_AUTHORITATIVE_INVARIANCE",
    meta.stair_step_detected === true &&
      meta.stair_step_direction === "UP" &&
      v2Env?.stair_step_detected === true &&
      v2Env?.stair_step_direction === "UP" &&
      (decision.decision === "SKIP" || decision.decision === "HOLD") &&
      decision.side === "none" &&
      (decision.risk?.finalOrderNotionalUsdt ?? 0) === 0 &&
      v2Env?.decision !== "ENTER",
    `Stair step up shadow detection passed while execution invariance preserved: shadowUp=${meta.stair_step_detected}, direction=${meta.stair_step_direction}, authoritativeDecision=${decision.decision}, side=${decision.side}, size=${decision.risk?.finalOrderNotionalUsdt}`
  );
}

// =========================================================================
// TEST 8 — DOWNWARD INVERSE SCENARIO: RANGE_FAKE_BREAKDOWN + BEARISH HTF
//          Shadow STAIR_STEP_DOWN=true while authoritative execution invariance
//          (decision=SKIP, side=none, size=0) is 100% PRESERVED.
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
    `cycle_ETHUSDT_${now}_stair_down`
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
      paperExecutionReady: true
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
    runCycleId: `cycle_ETHUSDT_${now}_stair_down_env`
  });

  const v2Env = env.v2_execution_envelope;

  run(
    "TEST_8_STAIR_STEP_DOWN_SHADOW_WITH_AUTHORITATIVE_INVARIANCE",
    meta.stair_step_detected === true &&
      meta.stair_step_direction === "DOWN" &&
      v2Env?.stair_step_detected === true &&
      v2Env?.stair_step_direction === "DOWN" &&
      (decision.decision === "SKIP" || decision.decision === "HOLD") &&
      decision.side === "none" &&
      (decision.risk?.finalOrderNotionalUsdt ?? 0) === 0 &&
      v2Env?.decision !== "ENTER",
    `Stair step down shadow detection passed while execution invariance preserved: shadowDown=${meta.stair_step_detected}, direction=${meta.stair_step_direction}, authoritativeDecision=${decision.decision}, side=${decision.side}, size=${decision.risk?.finalOrderNotionalUsdt}`
  );
}

// =========================================================================
// TEST 9 — FORMING CANDLE ISOLATION: Instantaneous forming spike with flat closed candles -> returns NONE
// =========================================================================
{
  const now = Date.now();
  // 16 flat closed candles + 1 massive forming candle spike
  const candles: Candle[] = Array.from({ length: 16 }, (_, i) => ({
    ts: now - (17 - i) * 60000,
    open: 65000,
    high: 65020,
    low: 64980,
    close: 65000,
    volume: 50
  }));
  // Forming candle (17th) spikes up to 66000
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
  // Forming candle (17th) crashes to 64000
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

console.log("\nALL 14 V2 STAIR-STEP STRUCTURE & SYMMETRY TESTS PASSED (TEST 1 - TEST 14)!");
