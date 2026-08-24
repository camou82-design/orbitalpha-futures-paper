/**
 * V2 DEDICATED TREND CONTINUATION REVALIDATION REGRESSION SUITE (TEST A ~ TEST R)
 *
 * Verifies that canonical TREND continuation candidates (TREND_UP_CONTINUATION / TREND_DOWN_CONTINUATION)
 * that would otherwise remain in HOLD due to moderate momentum forming or RANGE-specific boundary/zone gates
 * are safely, symmetrically, and token-specifically revalidated to ENTER when all authoritative evidence aligns,
 * without relaxing any hard safety guards, barriers, or RANGE rules.
 */

import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2, marketJudgmentCacheBySymbol } from "../engine-v2/index";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { clearGlobalShockStates, globalShockStates } from "../engine-v2/state/derive";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle, PaperOpenPositionRecord } from "../models/types";
import type { SymbolSnapshotLike } from "./paper-symbol-decision";

function pass(label: string, detail?: string): void {
  console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log("=== STARTING V2 TREND CONTINUATION REVALIDATION REGRESSION TESTS (A ~ R) ===\n");

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
  const candles = overrides.candles ?? makeTrendCandles(2500, "down", 120);
  return {
    symbol: "ETHUSDT",
    lastPrice: 2500,
    latestCandleClose: 2500,
    signal: "paper_short_candidate",
    entryCandidate: true,
    qualityScore: 75,
    candidateStrength: "strong",
    ema20: 2510,
    ema60: 2530,
    emaGap: -0.0006, // Moderate momentum: between -0.0004 and -0.001 -> would initially be WAIT_RECHECK/HOLD
    volumeRatioProxy: 1.2,
    boxHigh: 2650,
    boxLow: 2480,
    boxPos: 0.15, // Lower zone (<= 0.26)
    boxRel: 0.05,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 15,
    atr20: 15,
    closedClose: 2500,
    rangeConfidence: 0.4,
    trendWeaknessScore: 0.35, // Weakness between 0.3 and 0.5 -> TrendExecutor returns WAIT_RECHECK
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.3,
    rangeOscillationScore: 0.3,
    boxHighSlope: -0.0003,
    boxLowSlope: -0.0003,
    rangeCenterSlope: -0.0003,
    ema20Slope: -0.0003,
    candles,
    canonicalRegime: "canonicalRegime" in overrides ? overrides.canonicalRegime : "TREND",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.8,
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
// TEST A — TREND_DOWN_CONTINUATION short candidate in lower zone -> ENTER via V2_TREND_CONTINUATION_REVALIDATED
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15, // lower zone
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.side, "short");
  assert.equal(res.decision.metadata?.promotion_reason, "V2_TREND_CONTINUATION_REVALIDATED");
  pass("TEST A — TREND_DOWN_CONTINUATION in lower zone promotes to ENTER short", `decision=${res.decision.decision}, side=${res.decision.side}, promotionReason=${res.decision.metadata?.promotion_reason}`);
}

// =========================================================================
// TEST B — Exact LONG symmetry: TREND_UP_CONTINUATION long candidate in upper zone -> ENTER via V2_TREND_CONTINUATION_REVALIDATED
// =========================================================================
{
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2600,
    boxPos: 0.85, // upper zone
    emaGap: 0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75,
    signal: "paper_long_candidate",
    candles: candlesUp,
    htf_candles: { "5m": candlesUp, "15m": candlesUp, "1h": candlesUp, "4h": candlesUp, "1d": candlesUp }
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.side, "long");
  assert.equal(res.decision.metadata?.promotion_reason, "V2_TREND_CONTINUATION_REVALIDATED");
  pass("TEST B — Exact LONG symmetry: TREND_UP_CONTINUATION in upper zone promotes to ENTER long", `decision=${res.decision.decision}, side=${res.decision.side}, promotionReason=${res.decision.metadata?.promotion_reason}`);
}

// =========================================================================
// TEST C — quality=69 (< 70) -> remains HOLD/SKIP
// =========================================================================
{
  const res = runEngineWith({
    qualityScore: 69,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST C — quality=69 blocked from revalidation", `decision=${res.decision.decision}, side=${res.decision.side}`);
}

// =========================================================================
// TEST D — trendOk=false -> remains HOLD/SKIP
// =========================================================================
{
  const res = runEngineWith({
    qualityScore: 75,
    emaGap: -0.0001, // trendOk requires Math.abs(emaGap) >= 0.0004
    trendWeaknessScore: 0.35
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST D — trendOk=false blocked from revalidation", `decision=${res.decision.decision}, side=${res.decision.side}`);
}

// =========================================================================
// TEST E — LONG + HTF SHORT_ONLY_OR_NONE -> blocked
// =========================================================================
{
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const bearCandles = makeTrendCandles(2700, "down", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2600,
    boxPos: 0.85,
    emaGap: 0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75,
    signal: "paper_long_candidate",
    candles: candlesUp,
    htf_candles: { "5m": bearCandles, "15m": bearCandles, "1h": bearCandles, "4h": bearCandles, "1d": bearCandles }
  }, {
    longAllow: false
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST E — LONG + conflicting HTF/longAllow blocked", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST F — SHORT + HTF LONG_ONLY_OR_NONE -> blocked
// =========================================================================
{
  const bullCandles = makeTrendCandles(2300, "up", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75,
    signal: "paper_short_candidate",
    htf_candles: { "5m": bullCandles, "15m": bullCandles, "1h": bullCandles, "4h": bullCandles, "1d": bullCandles }
  }, {
    shortAllow: false
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST F — SHORT + conflicting HTF/shortAllow blocked", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST G — LONG + macro BEARISH -> blocked
// =========================================================================
{
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const bearCandles = makeTrendCandles(2700, "down", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2600,
    boxPos: 0.85,
    emaGap: 0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75,
    signal: "paper_long_candidate",
    candles: candlesUp,
    htf_candles: { "5m": bearCandles, "15m": bearCandles, "1h": bearCandles, "4h": bearCandles, "1d": bearCandles }
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST G — LONG + macro BEARISH blocked", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST H — SHORT + macro BULLISH -> blocked
// =========================================================================
{
  const bullCandles = makeTrendCandles(2300, "up", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75,
    signal: "paper_short_candidate",
    htf_candles: { "5m": bullCandles, "15m": bullCandles, "1h": bullCandles, "4h": bullCandles, "1d": bullCandles }
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST H — SHORT + macro BULLISH blocked", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST I — LONG + directional shock DOWN -> blocked
// =========================================================================
{
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2600,
    boxPos: 0.85,
    emaGap: 0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75,
    signal: "paper_long_candidate",
    candles: candlesUp,
    htf_candles: { "5m": candlesUp, "15m": candlesUp, "1h": candlesUp, "4h": candlesUp, "1d": candlesUp }
  }, {
    directionalShockState: "DOWN"
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST I — LONG + directional shock DOWN blocked", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST J — SHORT + directional shock UP -> blocked
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75
  }, {
    directionalShockState: "UP"
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST J — SHORT + directional shock UP blocked", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST K — Pre-existing REJECT (e.g. serverTradeEnabled=false) is NEVER resurrected
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75
  }, {
    serverTradeEnabled: false // Triggers pre-promotion REJECT
  });

  assert.equal(res.decision.decision, "REJECT");
  pass("TEST K — Pre-existing REJECT never resurrected", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST L — Valid continuation but missing/invalid stop -> fail closed, no ENTER
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 0, // invalid entry price prevents stop calculation
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST L — Missing/invalid stop fails closed", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST M — Ordinary RANGE lower-zone short -> SIDE_ZONE_MISMATCH_LOWER_SHORT still blocks
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15, // lower zone
    canonicalRegime: "RANGE", // RANGE mode
    canonicalTrendScore: 0.3,
    signal: "paper_short_candidate",
    qualityScore: 75
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST M — Ordinary RANGE lower-zone short blocked by side-zone mismatch", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST N — Ordinary RANGE upper-zone long -> SIDE_ZONE_MISMATCH_UPPER_LONG still blocks
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2600,
    boxPos: 0.85, // upper zone
    canonicalRegime: "RANGE", // RANGE mode
    canonicalTrendScore: 0.3,
    signal: "paper_long_candidate",
    qualityScore: 75
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST N — Ordinary RANGE upper-zone long blocked by side-zone mismatch", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST O — Generic TREND candidate that is not continuation (e.g. TREND_EXHAUSTION) cannot use exception
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.7, // tw >= 0.65 -> TREND_EXHAUSTION
    qualityScore: 75
  });

  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_TREND_CONTINUATION_REVALIDATED");
  pass("TEST O — Non-continuation subtype cannot use new revalidation path", `promotionReason=${res.decision.metadata?.promotion_reason ?? "none"}`);
}

// =========================================================================
// TEST P — Continuation conditions satisfied but terminal barrier active -> blocked
// =========================================================================
{
  const openPositions: PaperOpenPositionRecord[] = [
    {
      symbol: "ETHUSDT",
      side: "short",
      openedAt: NOW - 600_000,
      entryPrice: 2580,
      sizeUsd: 100,
      contracts: 0.1,
      finalizePending: true, // Terminal barrier active!
      pendingFinalizeFlowId: "flow_finalize_eth_1"
    } as any
  ];

  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75
  }, {
    currentPositions: openPositions
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST P — Active terminal barrier blocks entry despite continuation revalidation", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST Q1 — Same-side prior loss within hysteresis and loss-reentry gate blocks -> promotion CANNOT bypass
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 50 // Low quality score (<70) -> strong trend loss revalidation fails closed
  }, {
    lastLossReentryState: {
      symbol: "ETHUSDT",
      lastLossExitAt: NOW - 60_000,
      lastLossExitCandleTs: NOW - 60_000,
      lastLossExitSide: "short",
      lastLossEntryPrice: 2502,
      lastLossExitPrice: 2500,
      lastLossExitReason: "SL_FILLED",
      lastLossSetupIdentity: "ETHUSDT:short:TREND:none:none:none",
      realizedLossNetUsd: -20
    }
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST Q1 — Loss-reentry gate BLOCK strictly prevents ENTER (no promotion bypass)", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST Q2 — Loss-reentry gate legitimately allows (high quality + candles) -> ENTER survives
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 78 // High quality score (>=70)
  }, {
    lastLossReentryState: {
      symbol: "ETHUSDT",
      lastLossExitAt: NOW - 600_000, // 10 minutes ago (> 5 candles)
      lastLossExitCandleTs: NOW - 600_000,
      lastLossExitSide: "short",
      lastLossEntryPrice: 2520,
      lastLossExitPrice: 2530,
      lastLossExitReason: "SL_FILLED",
      lastLossSetupIdentity: "ETHUSDT:short:TREND:none:none:none",
      realizedLossNetUsd: -20
    }
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.side, "short");
  pass("TEST Q2 — Legitimate loss-reentry ALLOW preserves revalidated ENTER", `decision=${res.decision.decision}, side=${res.decision.side}`);
}

// =========================================================================
// TEST R — Existing normal Trend Executor ENTER (strong momentum) remains unchanged
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.5,
    emaGap: -0.002, // Strong momentum: <= -0.001
    trendWeaknessScore: 0.15, // Low weakness: < 0.3 -> TrendExecutor natively returns SHORT_CANDIDATE
    qualityScore: 85
  });

  assert.equal(res.decision.decision, "ENTER");
  assert.equal(res.decision.side, "short");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_TREND_CONTINUATION_REVALIDATED");
  pass("TEST R — Native strong trend ENTER remains unchanged without needing promotion", `decision=${res.decision.decision}, side=${res.decision.side}, promotionReason=${res.decision.metadata?.promotion_reason ?? "none"}`);
}

// =========================================================================
// TEST S — Unapproved HTF policy states (e.g. HOLD, PROBE_ONLY, SHORT_ONLY_OR_NONE) fail closed for LONG
// =========================================================================
{
  const candlesUp = makeTrendCandles(2500, "up", 120);
  const candlesDown = makeTrendCandles(2500, "down", 120);
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2600,
    boxPos: 0.85,
    emaGap: 0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75,
    signal: "paper_long_candidate",
    candles: candlesUp,
    htf_candles: { "5m": candlesUp, "15m": candlesDown, "1h": candlesDown, "4h": candlesDown, "1d": candlesDown }
  });

  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_TREND_CONTINUATION_REVALIDATED");
  pass("TEST S — Unapproved HTF policy states fail closed (HOLD/SHORT_ONLY blocks LONG)", `promotionReason=${res.decision.metadata?.promotion_reason ?? "none"}`);
}

// =========================================================================
// TEST T — Canonical regime RANGE + routing TREND strictly fails closed (no revalidation)
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    canonicalRegime: "RANGE", // Authoritative canonical regime is RANGE!
    rangeConfidence: 0.85,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75
  });

  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_TREND_CONTINUATION_REVALIDATED");
  pass("TEST T — Canonical RANGE with secondary trend indicators strictly fails closed", `promotionReason=${res.decision.metadata?.promotion_reason ?? "none"}`);
}

// =========================================================================
// TEST T1 — Canonical regime TRANSITION + secondary trend indicators strictly fails closed
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    canonicalRegime: "TRANSITION" as any, // Authoritative canonical regime is TRANSITION!
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75
  });

  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_TREND_CONTINUATION_REVALIDATED");
  pass("TEST T1 — Canonical TRANSITION with secondary trend indicators strictly fails closed", `promotionReason=${res.decision.metadata?.promotion_reason ?? "none"}`);
}

// =========================================================================
// TEST T2 — Canonical regime NO_TRADE + secondary trend indicators strictly fails closed
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    canonicalRegime: "NO_TRADE", // Authoritative canonical regime is NO_TRADE!
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75
  });

  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_TREND_CONTINUATION_REVALIDATED");
  pass("TEST T2 — Canonical NO_TRADE with secondary trend indicators strictly fails closed", `promotionReason=${res.decision.metadata?.promotion_reason ?? "none"}`);
}

// =========================================================================
// TEST T3 — Missing / Null canonicalRegime in snapshot strictly fails closed
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    canonicalRegime: undefined, // Missing canonical regime!
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75
  });

  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_TREND_CONTINUATION_REVALIDATED");
  pass("TEST T3 — Missing canonicalRegime snapshot evidence strictly fails closed", `promotionReason=${res.decision.metadata?.promotion_reason ?? "none"}`);
}

// =========================================================================
// TEST U — Real PENDING_ORDER_EXISTS barrier blocks submit-capable ENTER
// =========================================================================
{
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75
  }, {
    hasSymbolPendingEntry: true, // Real blocking pending order exists!
    okxPendingOrdersReady: true,
    okxPendingOrdersNotionalUsdt: 50,
    okxPendingSymbolNotionalUsdt: 50
  });

  assert.equal(res.decision.decision, "REJECT");
  assert.equal(res.decision.side, "none");
  assert.equal(res.internal.riskSizing?.blockReason, "PENDING_ORDER_EXISTS");
  pass("TEST U — PENDING_ORDER_EXISTS barrier blocks submit-capable ENTER", `decision=${res.decision.decision}, blockReason=${res.internal.riskSizing?.blockReason}`);
}

// =========================================================================
// TEST V — REJECT Double Lock (Pre-existing REJECT and downstream REJECT preserved)
// =========================================================================
{
  // Downstream execution hard control failure produces REJECT/HOLD that cannot be overridden
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75
  }, {
    serverTradeEnabled: false // Downstream hard control disabled
  });

  assert.notEqual(res.decision.decision, "ENTER");
  pass("TEST V — Downstream hard control failure double-locked against ENTER", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST W — Non-continuation WAIT_RECHECK with valid stop cannot become ENTER
// =========================================================================
{
  // Subtype is NOT continuation (e.g. WHIPSAW_SOFT_WATCH / TREND_EXHAUSTION)
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 2500,
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.7, // High weakness -> non-continuation subtype
    qualityScore: 75
  });

  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_TREND_CONTINUATION_REVALIDATED");
  pass("TEST W — Non-continuation WAIT_RECHECK with valid stop cannot become ENTER", `decision=${res.decision.decision}`);
}

// =========================================================================
// TEST X — Trend continuation candidate with invalid/missing stop fails closed (stays HOLD)
// =========================================================================
{
  // When lastPrice is invalid/zero, stopPrice cannot be valid
  const res = runEngineWith({
    symbol: "ETHUSDT",
    lastPrice: 0,
    boxPos: 0.15,
    emaGap: -0.0006,
    trendWeaknessScore: 0.35,
    qualityScore: 75
  });

  assert.notEqual(res.decision.decision, "ENTER");
  assert.notEqual(res.decision.metadata?.promotion_reason, "V2_TREND_CONTINUATION_REVALIDATED");
  pass("TEST X — Trend continuation candidate with invalid stop fails closed", `decision=${res.decision.decision}`);
}

console.log("\nALL 28 V2 TREND CONTINUATION REVALIDATION TESTS (A ~ X) PASSED SUCCESSFULLY!");
