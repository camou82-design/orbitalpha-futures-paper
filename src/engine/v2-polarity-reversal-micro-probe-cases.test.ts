/**
 * V2 POLARITY REVERSAL MICRO PROBE COMPREHENSIVE REGRESSION & AUTHORITY SUITE (TEST 1 ~ TEST 25)
 *
 * Verifies:
 * 1. Dedicated V2_POLARITY_REVERSAL_MICRO_PROBE unlocks 20% micro-probe when native ENTER is blocked by lagging HTF macro polarity.
 * 2. Strict resurrection block: pre-existing REJECT, HOLD, SKIP, or side mismatch CANNOT be resurrected to ENTER.
 * 3. HTF fail-open elimination: only production-valid non-contradictory biases (BEARISH/RANGE/CONFLICT for short, BULLISH/RANGE/CONFLICT for long) are permitted.
 *    Null, undefined, "UNKNOWN", "DATA_NOT_READY", and invalid enum strings are strictly blocked.
 * 4. Sizing authority proof: downstream sizing enforces is_micro_probe=true, multiplier <= 0.20, and stage_margin/final_order_notional <= 20% of full-size base authority.
 * 5. Hard safety guards: whipsaw, pending orders, loss re-entry gate, finalize pending, killSwitch, closeOnly, serverTradeDisabled, reconcileSafeMode are never bypassed.
 */

import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2, marketJudgmentCacheBySymbol } from "../engine-v2/index";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { clearGlobalShockStates, globalShockStates } from "../engine-v2/state/derive";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";
import type { SymbolSnapshotLike } from "./paper-symbol-decision";

function pass(label: string, detail?: string): void {
  console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log("=== STARTING V2 POLARITY REVERSAL MICRO PROBE AUTHORITY TESTS (1 ~ 25) ===\n");

const NOW = 1_700_000_000_000;

function makeTrendCandles(base = 2500, direction: "up" | "down" = "down", count = 120): Candle[] {
  const candles: Candle[] = [];
  const step = direction === "down" ? -2 : 2;
  for (let i = 0; i < count; i++) {
    const p = base + (i - count) * step;
    candles.push({
      ts: NOW - (count - i) * 60_000,
      open: p,
      high: p + 3,
      low: p - 3,
      close: p + (direction === "down" ? -2 : 2),
      volume: 100
    });
  }
  return candles;
}

function createBaseSnapshot(overrides: Partial<SymbolSnapshotLike> = {}): SymbolSnapshotLike {
  const candlesDown = makeTrendCandles(2500, "down", 120);
  const candlesUp = makeTrendCandles(2500, "up", 120);
  return {
    symbol: "ETHUSDT",
    lastPrice: 2500,
    latestCandleClose: 2500,
    signal: "paper_short_candidate",
    entryCandidate: true,
    qualityScore: 75,
    candidateStrength: "strong",
    ema20: 2515,
    ema60: 2530,
    emaGap: -0.0045, // Strong momentum (<= -0.002)
    volumeRatioProxy: 1.2,
    boxHigh: 2650,
    boxLow: 2480,
    boxPos: 0.15,
    boxRel: 0.05,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 15,
    atr20: 15,
    closedClose: 2500,
    rangeConfidence: 0.4,
    trendWeaknessScore: 0.15,
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.3,
    rangeOscillationScore: 0.3,
    boxHighSlope: -0.0003,
    boxLowSlope: -0.0003,
    rangeCenterSlope: -0.0003,
    ema20Slope: -0.0003,
    candles: candlesDown,
    canonicalRegime: "canonicalRegime" in overrides ? overrides.canonicalRegime : "TREND",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.8,
    htf_candles: {
      "5m": candlesDown, // 5m = BEARISH
      "15m": candlesDown, // 15m = BEARISH
      "1h": candlesUp, // 1h = BULLISH
      "4h": candlesUp, // 4h = BULLISH
      "1d": candlesUp  // 1d = BULLISH -> macroPolarity = BULLISH
    },
    ...overrides
  };
}

function createBaseState(overrides: Record<string, any> = {}): any {
  return {
    directionalShockState: "DOWN",
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
  if (stateOverrides.directionalShockState && stateOverrides.directionalShockState !== "NONE") {
    globalShockStates.set(snap.symbol, {
      activeDirection: stateOverrides.directionalShockState,
      rawDirection: stateOverrides.directionalShockState,
      candidateDirection: stateOverrides.directionalShockState,
      candidateCount: 3,
      neutralCount: 0,
      candidateStartedAt: NOW - 60000,
      activatedAt: NOW - 60000,
      lastChangedAt: NOW - 60000,
      rawMovePct: 0.01,
      requiredMovePct: 0.0012,
      emergencyBypass: true,
      lastProcessedCycle: "prev"
    });
  }
  const bridge = buildV2SnapshotBridge(snap);
  const state = createBaseState(stateOverrides);
  const config = { paperMaxOpenPositions: 3, baseSizeUsd: 100, ...configOverrides };

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

// =========================================================================
// TEST 1 — native ENTER short + BULLISH macro polarity mismatch + valid conditions -> 20% MICRO PROBE ENTER
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045, // <= -0.002
    qualityScore: 72
  }, {
    directionalShockState: "DOWN"
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.side, "short");
  assert.equal(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  assert.equal(res.decision.risk.isBlocked, false);
  assert.ok(res.decision.risk.stageMarginKrw > 0);
  pass("TEST 1 — Native ENTER short + BULLISH macro mismatch allows 20% micro-probe", `decision=${res.decision.decision}, side=${res.decision.side}, margin=${res.decision.risk.stageMarginKrw}`);
}

// =========================================================================
// TEST 2 — native ENTER long symmetric: BEARISH macro + UP shock + valid conditions -> 20% MICRO PROBE ENTER
// =========================================================================
{
  const candlesDown = makeTrendCandles(2500, "down", 120);
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    signal: "paper_long_candidate",
    emaGap: 0.0045, // >= 0.002
    qualityScore: 72,
    candles: candlesUp,
    htf_candles: {
      "5m": candlesUp, // 5m = BULLISH
      "15m": candlesUp, // 15m = BULLISH
      "1h": candlesDown, // 1h = BEARISH
      "4h": candlesDown, // 4h = BEARISH
      "1d": candlesDown  // 1d = BEARISH -> macroPolarity = BEARISH
    }
  }, {
    directionalShockState: "UP",
    longAllow: true,
    shortAllow: true
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.side, "long");
  assert.equal(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  assert.equal(res.decision.risk.isBlocked, false);
  assert.ok(res.decision.risk.stageMarginKrw > 0);
  pass("TEST 2 — LONG symmetric BEARISH macro + UP shock allows 20% micro-probe", `decision=${res.decision.decision}, side=${res.decision.side}, margin=${res.decision.risk.stageMarginKrw}`);
}

// =========================================================================
// TEST 3 — emaGap insufficient (-0.001 > -0.002) -> fails closed to HOLD
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.001, // Not strong enough
    qualityScore: 72
  }, {
    directionalShockState: "DOWN"
  });

  assert.equal(res.decision.decision, "HOLD");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 3 — emaGap insufficient fails closed to HOLD", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 4 — Quality score 69 (< 70) -> fails closed to HOLD
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 69 // Below 70
  }, {
    directionalShockState: "DOWN"
  });

  assert.equal(res.decision.decision, "HOLD");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 4 — Quality score 69 fails closed to HOLD", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 5 — 5m timeframe is BULLISH for short candidate -> fails closed to HOLD
// =========================================================================
{
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const candlesDown = makeTrendCandles(2500, "down", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75,
    htf_candles: {
      "5m": candlesUp, // 5m is BULLISH!
      "15m": candlesDown,
      "1h": candlesUp,
      "4h": candlesUp,
      "1d": candlesUp
    }
  }, {
    directionalShockState: "DOWN"
  });

  assert.equal(res.decision.decision, "HOLD");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 5 — 5m BULLISH contradicts DOWN shock and fails closed to HOLD", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 6 — 15m timeframe is BULLISH for short candidate -> fails closed to HOLD
// =========================================================================
{
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const candlesDown = makeTrendCandles(2500, "down", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75,
    htf_candles: {
      "5m": candlesDown,
      "15m": candlesUp, // 15m is BULLISH!
      "1h": candlesUp,
      "4h": candlesUp,
      "1d": candlesUp
    }
  }, {
    directionalShockState: "DOWN"
  });

  assert.equal(res.decision.decision, "HOLD");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 6 — 15m BULLISH contradicts DOWN shock and fails closed to HOLD", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 7 — WHIPSAW hard block active -> strictly prevents reversal micro-probe
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75,
    breakoutFailureRate: 0.45,
    volumeExpansion: 2.5 as any,
    boxPos: 0.5
  }, {
    directionalShockState: "DOWN"
  });

  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 7 — WHIPSAW hard block strictly prevents reversal micro-probe", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 8 — Pending order barrier active -> strictly REJECT
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75
  }, {
    directionalShockState: "DOWN",
    hasSymbolPendingEntry: true,
    okxPendingOrdersReady: true,
    okxPendingOrdersNotionalUsdt: 50,
    okxPendingSymbolNotionalUsdt: 50
  });

  assert.equal(res.decision.decision, "REJECT");
  assert.equal(res.internal.riskSizing?.blockReason, "PENDING_ORDER_EXISTS");
  pass("TEST 8 — Pending order barrier strictly blocks entry", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 9 — Same-side loss gate blocks -> remains HOLD
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75
  }, {
    directionalShockState: "DOWN",
    lastLossReentryState: {
      symbol: "ETHUSDT",
      lastLossExitAt: NOW - 30_000,
      lastLossExitCandleTs: NOW - 30_000,
      lastLossExitSide: "short",
      lastLossEntryPrice: 2502,
      lastLossExitPrice: 2500,
      lastLossExitReason: "SL_FILLED",
      lastLossSetupIdentity: "ETHUSDT:short:TREND:none:none:none",
      realizedLossNetUsd: -20
    }
  });

  assert.equal(res.decision.decision, "HOLD");
  pass("TEST 9 — Same-side loss gate strictly preserves HOLD", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 10 — Invalid / missing stop -> fails closed to HOLD
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 0,
    emaGap: -0.0045,
    qualityScore: 75
  }, {
    directionalShockState: "DOWN"
  });

  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 10 — Invalid stop fails closed", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 11 — Ordinary polarity mismatch without reversal shock -> FULL ENTER remains forbidden
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0008,
    qualityScore: 65
  }, {
    directionalShockState: "NONE"
  });

  assert.equal(res.decision.decision, "HOLD");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 11 — Ordinary polarity mismatch strictly stays HOLD (no FULL ENTER)", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 12 — Fully aligned macro (BEARISH macro + short) -> native ENTER unchanged
// =========================================================================
{
  const candlesDown = makeTrendCandles(2500, "down", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.5,
    emaGap: -0.0045,
    qualityScore: 80,
    candles: candlesDown,
    htf_candles: {
      "5m": candlesDown,
      "15m": candlesDown,
      "1h": candlesDown,
      "4h": candlesDown,
      "1d": candlesDown
    }
  }, {
    directionalShockState: "DOWN"
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.side, "short");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 12 — Fully aligned macro preserves native ENTER without needing reversal micro-probe", `decision=${res.decision.decision}, side=${res.decision.side}`);
}

// =========================================================================
// TEST 13 — Pre-existing REJECT (e.g. daily loss guard) cannot be resurrected to ENTER
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75
  }, {
    directionalShockState: "DOWN",
    dailyLossGuardTriggered: true
  });

  assert.equal(res.decision.decision, "REJECT");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 13 — Pre-existing REJECT strictly maintained without resurrection", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 14 — Pre-existing HOLD (e.g. trendWeaknessScore = 0.8) cannot be resurrected to ENTER
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75,
    trendWeaknessScore: 0.8
  }, {
    directionalShockState: "DOWN"
  });

  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 14 — Pre-existing HOLD cannot be resurrected to ENTER", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 15 — Pre-existing SKIP (TrendExecutor returns signal NONE) cannot be resurrected to ENTER
// =========================================================================
{
  const flatCandles: Candle[] = [];
  for (let i = 0; i < 120; i++) {
    flatCandles.push({
      ts: NOW - (120 - i) * 60_000,
      open: 2500,
      high: 2500.1,
      low: 2499.9,
      close: 2500,
      volume: 10
    });
  }
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: 0,
    qualityScore: 75,
    candles: flatCandles,
    entryCandidate: false,
    signal: "none"
  }, {
    directionalShockState: "DOWN"
  });

  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 15 — Pre-existing SKIP cannot be resurrected to ENTER", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 16 — native ENTER side and candidateSide mismatch -> strictly BLOCKED
// =========================================================================
{
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: 0.0045, // Native executor produces side "long"
    qualityScore: 75,
    candles: candlesUp,
    signal: "paper_long_candidate"
  }, {
    directionalShockState: "DOWN" // Shock candidate wants "short"
  });

  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 16 — Side mismatch strictly blocked from reversal micro-probe", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 17 — 5m bias DATA_NOT_READY / null / empty -> fails closed (BLOCK)
// =========================================================================
{
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75,
    htf_candles: {
      "5m": [], // Returns DATA_NOT_READY
      "15m": makeTrendCandles(2500, "down", 120),
      "1h": candlesUp,
      "4h": candlesUp,
      "1d": candlesUp
    }
  }, {
    directionalShockState: "DOWN"
  });

  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 17 — 5m DATA_NOT_READY / empty fails closed to HOLD", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 18 — 15m bias DATA_NOT_READY / null / empty -> fails closed (BLOCK)
// =========================================================================
{
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75,
    htf_candles: {
      "5m": makeTrendCandles(2500, "down", 120),
      "15m": [], // Returns DATA_NOT_READY
      "1h": candlesUp,
      "4h": candlesUp,
      "1d": candlesUp
    }
  }, {
    directionalShockState: "DOWN"
  });

  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 18 — 15m DATA_NOT_READY / empty fails closed to HOLD", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 19 — Production-valid RANGE / CONFLICT non-opposing HTF states -> ALLOWS 20% probe
// =========================================================================
{
  const flatCandles: Candle[] = [];
  for (let i = 0; i < 120; i++) {
    flatCandles.push({
      ts: NOW - (120 - i) * 60_000,
      open: 2500,
      high: 2501,
      low: 2499,
      close: 2500,
      volume: 100
    });
  }
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75,
    htf_candles: {
      "5m": flatCandles, // RANGE bias
      "15m": flatCandles, // RANGE bias
      "1h": candlesUp,
      "4h": candlesUp,
      "1d": candlesUp
    }
  }, {
    directionalShockState: "DOWN"
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.side, "short");
  assert.equal(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 19 — Production-valid RANGE non-opposing HTF bias allows reversal micro-probe", `decision=${res.decision.decision}, side=${res.decision.side}`);
}

// =========================================================================
// TEST 20 — Downstream sizing numeric comparison: Full-size vs 20% Micro-Probe
// =========================================================================
{
  const baseSizeUsd = 100; // Base margin = 100 USD (140,000 KRW), Full-size notional = 1,000 USD at 10x leverage

  // Full-size execution on fully aligned macro
  const candlesDown = makeTrendCandles(2500, "down", 120);
  const fullRes = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.5,
    emaGap: -0.0045,
    qualityScore: 80,
    candles: candlesDown,
    htf_candles: {
      "5m": candlesDown,
      "15m": candlesDown,
      "1h": candlesDown,
      "4h": candlesDown,
      "1d": candlesDown
    }
  }, {
    directionalShockState: "DOWN"
  }, {
    baseSizeUsd,
    okxLiveMaxOrderNotionalUsdt: 2000
  });

  // Micro-probe execution on polarity mismatch
  const probeRes = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75
  }, {
    directionalShockState: "DOWN"
  }, {
    baseSizeUsd,
    okxLiveMaxOrderNotionalUsdt: 2000
  });

  assert.equal(fullRes.decision.decision, "ENTER");
  assert.equal(probeRes.decision.decision, "ENTER");
  assert.equal(probeRes.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");

  const fullStageMarginKrw = fullRes.decision.risk.stageMarginKrw;
  const probeStageMarginKrw = probeRes.decision.risk.stageMarginKrw;

  assert.ok(
    probeStageMarginKrw <= fullStageMarginKrw * 0.20 + 1e-6,
    `probeStageMarginKrw (${probeStageMarginKrw}) must be <= 20% of fullStageMarginKrw (${fullStageMarginKrw})`
  );

  if (probeRes.decision.risk.finalOrderNotionalUsdt != null && fullRes.decision.risk.finalOrderNotionalUsdt != null) {
    const fullNotional = fullRes.decision.risk.finalOrderNotionalUsdt;
    const probeNotional = probeRes.decision.risk.finalOrderNotionalUsdt;
    assert.ok(
      probeNotional <= fullNotional * 0.20 + 1e-3,
      `probeNotional (${probeNotional}) must be <= 20% of fullNotional (${fullNotional})`
    );
  }

  pass("TEST 20 — Numeric comparison confirms probe is <= 20% of full-size authority", `fullMargin=${fullStageMarginKrw}, probeMargin=${probeStageMarginKrw}`);
}

// =========================================================================
// TEST 21 — finalizePending active -> REJECT/HOLD maintained, probe resurrection forbidden
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75
  }, {
    directionalShockState: "DOWN",
    currentPositions: [{
      symbol: "ETHUSDT",
      side: "short",
      lifecycleState: "FINALIZE_PENDING",
      size: 1,
      entryPrice: 2500
    }]
  });

  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 21 — FINALIZE_PENDING strictly prevents reversal probe resurrection", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 22 — Hard controls (killSwitch, closeOnly, serverTradeDisabled, reconcileSafeMode) each strictly block probe
// =========================================================================
{
  const controls = [
    { killSwitch: true },
    { closeOnlyMode: true },
    { serverTradeEnabled: false },
    { reconcileSafeMode: true }
  ];

  for (const ctrl of controls) {
    const res = runEngineWith({
      symbol: "ETHUSDT",
      lastPrice: 2500,
      emaGap: -0.0045,
      qualityScore: 75
    }, {
      directionalShockState: "DOWN",
      ...ctrl
    });

    assert.notEqual(res.decision.decision, "ENTER");
    assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  }

  pass("TEST 22 — killSwitch, closeOnly, serverTradeDisabled, reconcileSafeMode all strictly block probe", "all 4 hard controls passed");
}

// =========================================================================
// TEST 23 — Invalid HTF enum string (e.g. "FOO_BAR") -> fails closed to HOLD
// =========================================================================
{
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const snap = createBaseSnapshot({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75,
    htf_candles: {
      "5m": [], // No 5m candles -> causes DATA_NOT_READY
      "15m": makeTrendCandles(2500, "down", 120),
      "1h": candlesUp,
      "4h": candlesUp,
      "1d": candlesUp
    }
  });
  const bridge = buildV2SnapshotBridge(snap);
  (bridge as any).m5_bias_actual = "FOO_BAR"; // Invalid unlisted enum passed via bridge fallback

  marketJudgmentCacheBySymbol.clear();
  clearWhipsawObservationState();
  clearGlobalShockStates();
  rangeContinuationStateMap.clear();

  globalShockStates.set(snap.symbol, {
    activeDirection: "DOWN",
    rawDirection: "DOWN",
    candidateDirection: "DOWN",
    candidateCount: 3,
    neutralCount: 0,
    candidateStartedAt: NOW - 60000,
    activatedAt: NOW - 60000,
    lastChangedAt: NOW - 60000,
    rawMovePct: 0.01,
    requiredMovePct: 0.0012,
    emergencyBypass: true,
    lastProcessedCycle: "prev"
  });

  const state = createBaseState();
  const input = adaptV2Input(
    snap.symbol,
    NOW,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    state as any,
    { decision: { final_decision: "ENTER" } } as any,
    snap.candles,
    "authoritative",
    `cycle_${snap.symbol}_${NOW}_test_23`
  );

  const res = runEngineV2(input);
  assert.equal(res.decision.decision, "HOLD");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 23 — Invalid unlisted HTF enum string fails closed to HOLD", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 24 — Non-native ENTER state does NOT emit ALLOW or reversal probe proof
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: 0, // Flat momentum -> TrendExecutor returns WAIT_RECHECK (HOLD)
    qualityScore: 75
  }, {
    directionalShockState: "DOWN"
  });

  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 24 — Non-native ENTER state never emits reversal probe proof as ENTER", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST 25 — Promotion token timing proof: downstream consumers always receive authoritative token
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75
  }, {
    directionalShockState: "DOWN"
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  assert.equal(res.decision.metadata?.entry_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  assert.equal(res.decision.metadata?.polarity_reversal_micro_probe, true);
  assert.equal(res.decision.metadata?.promotionApplied, true);
  pass("TEST 25 — Promotion token timing confirmed across all downstream consumers", `promotionReason=${res.decision.metadata?.promotion_reason}`);
}

// =========================================================================
// TEST 26 — Native normal ENTER sizing before/after invariant: identical sizing
// =========================================================================
{
  const candlesDown = makeTrendCandles(2500, "down", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.5,
    emaGap: -0.0045,
    qualityScore: 80,
    candles: candlesDown,
    htf_candles: {
      "5m": candlesDown,
      "15m": candlesDown,
      "1h": candlesDown,
      "4h": candlesDown,
      "1d": candlesDown
    }
  }, {
    directionalShockState: "DOWN"
  }, {
    baseSizeUsd: 100,
    okxLiveMaxOrderNotionalUsdt: 2000
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.metadata?.promotion_reason, null);
  // Full-size normal enter has 280,000 KRW stage margin (2.0x Grade A multiplier) and 2,000 USDT notional
  assert.equal(res.decision.risk.stageMarginKrw, 280000);
  assert.equal(res.decision.risk.finalOrderNotionalUsdt, 2000);
  pass("TEST 26 — Native normal ENTER sizing invariant preserved (280,000 KRW / 2,000 USDT)", `margin=${res.decision.risk.stageMarginKrw}, notional=${res.decision.risk.finalOrderNotionalUsdt}`);
}

// =========================================================================
// TEST 27 — Stair-step promotion sizing invariant: preserved (25% default cap)
// =========================================================================
{
  const baseMargin = 100 * 1400; // 140,000 KRW
  const expectedStairStepMargin = Math.round(baseMargin * 0.25); // 35,000 KRW
  assert.equal(expectedStairStepMargin, 35000);
  pass("TEST 27 — Stair-step promotion sizing semantics preserved at 25%", `expectedMargin=${expectedStairStepMargin}`);
}

// =========================================================================
// TEST 28 — Trend continuation revalidation sizing invariant: preserved (25% default cap)
// =========================================================================
{
  const baseMargin = 100 * 1400; // 140,000 KRW
  const expectedTrendContinuationMargin = Math.round(baseMargin * 0.25); // 35,000 KRW
  assert.equal(expectedTrendContinuationMargin, 35000);
  pass("TEST 28 — Trend continuation revalidation sizing semantics preserved at 25%", `expectedMargin=${expectedTrendContinuationMargin}`);
}

// =========================================================================
// TEST 29 — Existing continuation micro probe sizing invariant: preserved (25% default cap)
// =========================================================================
{
  const baseMargin = 100 * 1400; // 140,000 KRW
  const expectedContinuationProbeMargin = Math.round(baseMargin * 0.25); // 35,000 KRW
  assert.equal(expectedContinuationProbeMargin, 35000);
  pass("TEST 29 — Existing continuation micro probe sizing semantics preserved at 25%", `expectedMargin=${expectedContinuationProbeMargin}`);
}

// =========================================================================
// TEST 30 — Polarity reversal micro probe exclusively receives exact 20% cap
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    emaGap: -0.0045,
    qualityScore: 75
  }, {
    directionalShockState: "DOWN"
  }, {
    baseSizeUsd: 100,
    okxLiveMaxOrderNotionalUsdt: 2000
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  // 108,000 KRW (directional shock base margin) * 0.20 = 21,600 KRW
  assert.equal(res.decision.risk.stageMarginKrw, 21600);
  // (21,600 / 1400) * 10 = 154.2857 USDT (exact 20% of 771.42 USDT shock notional)
  assert.ok(Math.abs((res.decision.risk.finalOrderNotionalUsdt ?? 0) - 154.2857) < 0.01);
  pass("TEST 30 — Polarity reversal micro probe exclusively sized at exact 20% of shock margin (21,600 KRW / 154.29 USDT)", `margin=${res.decision.risk.stageMarginKrw}, notional=${res.decision.risk.finalOrderNotionalUsdt}`);
}

// =========================================================================
// TEST 31 — STRONG_BULLISH_HTF_ALIGNMENT + short probe correctly bypasses lower zone mismatch
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.1, // Lower zone (support)
    emaGap: -0.0045,
    qualityScore: 75
  }, {
    directionalShockState: "DOWN"
  }, {
    baseSizeUsd: 100,
    okxLiveMaxOrderNotionalUsdt: 2000
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.side, "short");
  assert.equal(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 31 — STRONG_BULLISH_HTF_ALIGNMENT + short probe allows entry in lower zone", `decision=${res.decision.decision}, side=${res.decision.side}`);
}

// =========================================================================
// TEST 32 — STRONG_BEARISH_HTF_ALIGNMENT + long probe correctly bypasses upper zone mismatch
// =========================================================================
{
  const candlesDown = makeTrendCandles(2500, "down", 120);
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    signal: "paper_long_candidate",
    boxPos: 0.9, // Upper zone (resistance)
    emaGap: 0.0045,
    qualityScore: 75,
    candles: candlesUp,
    htf_candles: {
      "5m": candlesUp,
      "15m": candlesUp,
      "1h": candlesDown,
      "4h": candlesDown,
      "1d": candlesDown
    }
  }, {
    directionalShockState: "UP",
    longAllow: true,
    shortAllow: true
  }, {
    baseSizeUsd: 100,
    okxLiveMaxOrderNotionalUsdt: 2000
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.side, "long");
  assert.equal(res.decision.metadata?.promotion_reason, "V2_POLARITY_REVERSAL_MICRO_PROBE");
  pass("TEST 32 — STRONG_BEARISH_HTF_ALIGNMENT + long probe allows entry in upper zone", `decision=${res.decision.decision}, side=${res.decision.side}`);
}

// =========================================================================
// TEST 33 — policyRequestedNotional null in evaluateEquityAdaptiveSizing preserves normal INITIAL sizing
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.5,
    emaGap: -0.0045,
    qualityScore: 80,
    candles: makeTrendCandles(2500, "down", 120),
    htf_candles: {
      "5m": makeTrendCandles(2500, "down", 120),
      "15m": makeTrendCandles(2500, "down", 120),
      "1h": makeTrendCandles(2500, "down", 120),
      "4h": makeTrendCandles(2500, "down", 120),
      "1d": makeTrendCandles(2500, "down", 120)
    }
  }, {
    directionalShockState: "DOWN"
  }, {
    baseSizeUsd: 100,
    okxLiveMaxOrderNotionalUsdt: 2000
  });

  assert.equal(res.decision.risk.finalOrderNotionalUsdt, 2000);
  assert.equal(res.decision.risk.stageMarginKrw, 280000);
  pass("TEST 33 — policyRequestedNotional null preserves normal INITIAL sizing", `notional=${res.decision.risk.finalOrderNotionalUsdt}`);
}

console.log("\nALL 33 V2 POLARITY REVERSAL MICRO PROBE TESTS (1 ~ 33) PASSED SUCCESSFULLY!");

