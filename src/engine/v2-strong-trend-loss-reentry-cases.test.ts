/**
 * V2 Strong Trend Loss Re-entry Cases (TEST A ~ TEST N)
 * 
 * Verifies that strongly revalidated authoritative TREND regimes are allowed
 * same-side entry after 5 closed candles without bypassing hysteresis,
 * terminal barriers, or safety invariants.
 */

import assert from "node:assert/strict";
import {
  evaluateSameSideLossReentryGate,
  type SameSideLossReentryGateInput,
  type LastLossReentryState
} from "../engine-v2/state/loss-reentry-gate";
import {
  evaluateTerminalReentryBarrier
} from "../engine-v2/lifecycle/terminal-reentry-barrier";
import type { PaperOpenPositionRecord } from "../models/types";

function pass(label: string, detail?: string): void {
  console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ""}`);
}

const NOW = 1_700_000_000_000;

function makeCandles(count: number, startTs: number = NOW - count * 60_000): Array<{ ts: number }> {
  return Array.from({ length: count }, (_, i) => ({
    ts: startTs + i * 60_000
  }));
}

const baseLongLoss: LastLossReentryState = {
  symbol: "ETHUSDT",
  lastLossExitAt: NOW - 600_000,
  lastLossExitCandleTs: NOW - 600_000,
  lastLossExitSide: "long",
  lastLossEntryPrice: 2600,
  lastLossExitPrice: 2580,
  lastLossExitReason: "SL_FILLED",
  lastLossSetupIdentity: "ETHUSDT:long:TREND:none:none:none",
  realizedLossNetUsd: -20
};

const baseShortLoss: LastLossReentryState = {
  symbol: "ETHUSDT",
  lastLossExitAt: NOW - 600_000,
  lastLossExitCandleTs: NOW - 600_000,
  lastLossExitSide: "short",
  lastLossEntryPrice: 2580,
  lastLossExitPrice: 2600,
  lastLossExitReason: "SL_FILLED",
  lastLossSetupIdentity: "ETHUSDT:short:TREND:none:none:none",
  realizedLossNetUsd: -20
};

console.log("=== V2 STRONG TREND LOSS RE-ENTRY REGRESSION TESTS (A ~ N) ===\n");

// TEST A — ETH형 LONG: prior long loss + displacement 미달 + structuralEvent none + TREND + trendOk + quality>=70 + LONG_ONLY_OR_NONE + 5 closed candles => ALLOW
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582, // displacement (2582-2580)/2580 = 0.077% < 0.35%
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000), // 9 completed candles since lossTs
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "LONG_ONLY_OR_NONE",
    macroPolarity: "NEUTRAL",
    directionalShockState: "NONE"
  });

  assert.equal(res.allowed, true);
  assert.equal(res.reason, "STRONG_TREND_REVALIDATED_AFTER_LOSS");
  pass("TEST A — ETH-style LONG strong trend revalidated", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST B — 정확한 DOWN 대칭: prior short loss + TREND + trendOk + quality>=70 + SHORT_ONLY_OR_NONE + 5 candles => ALLOW
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "short",
    currentPrice: 2598, // displacement (2600-2598)/2600 = 0.077% < 0.35%
    now: NOW,
    lastLossState: baseShortLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "SHORT_ONLY_OR_NONE",
    macroPolarity: "NEUTRAL",
    directionalShockState: "NONE"
  });

  assert.equal(res.allowed, true);
  assert.equal(res.reason, "STRONG_TREND_REVALIDATED_AFTER_LOSS");
  pass("TEST B — Exact DOWN symmetric strong trend revalidated", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST C — 5 candles 미만 => 기존 BLOCK 유지
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582,
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(4, NOW - 240_000), // 3 completed candles (< 5)
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "LONG_ONLY_OR_NONE",
    macroPolarity: "NEUTRAL",
    directionalShockState: "NONE"
  });

  assert.equal(res.allowed, false);
  assert.equal(res.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
  pass("TEST C — Under 5 completed candles remains BLOCKED", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST D — qualityScore 69 => BLOCK 유지
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582,
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 69, // < 70
    htfEntryPolicy: "LONG_ONLY_OR_NONE",
    macroPolarity: "NEUTRAL",
    directionalShockState: "NONE"
  });

  assert.equal(res.allowed, false);
  assert.equal(res.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
  pass("TEST D — Quality score 69 (< 70) remains BLOCKED", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST E — long + HTF SHORT_ONLY_OR_NONE => BLOCK 유지
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582,
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "SHORT_ONLY_OR_NONE", // conflict
    macroPolarity: "NEUTRAL",
    directionalShockState: "NONE"
  });

  assert.equal(res.allowed, false);
  assert.equal(res.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
  pass("TEST E — LONG with HTF SHORT_ONLY_OR_NONE remains BLOCKED", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST F — short + HTF LONG_ONLY_OR_NONE => BLOCK 유지
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "short",
    currentPrice: 2598,
    now: NOW,
    lastLossState: baseShortLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "LONG_ONLY_OR_NONE", // conflict
    macroPolarity: "NEUTRAL",
    directionalShockState: "NONE"
  });

  assert.equal(res.allowed, false);
  assert.equal(res.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
  pass("TEST F — SHORT with HTF LONG_ONLY_OR_NONE remains BLOCKED", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST G — long + macro BEARISH => BLOCK
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582,
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "ALLOW",
    macroPolarity: "BEARISH", // conflict
    directionalShockState: "NONE"
  });

  assert.equal(res.allowed, false);
  assert.equal(res.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
  pass("TEST G — LONG with macro BEARISH remains BLOCKED", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST H — short + macro BULLISH => BLOCK
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "short",
    currentPrice: 2598,
    now: NOW,
    lastLossState: baseShortLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "ALLOW",
    macroPolarity: "BULLISH", // conflict
    directionalShockState: "NONE"
  });

  assert.equal(res.allowed, false);
  assert.equal(res.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
  pass("TEST H — SHORT with macro BULLISH remains BLOCKED", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST I — long + directionalShock DOWN => BLOCK
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582,
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "ALLOW",
    macroPolarity: "NEUTRAL",
    directionalShockState: "DOWN" // conflict
  });

  assert.equal(res.allowed, false);
  assert.equal(res.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
  pass("TEST I — LONG with directionalShock DOWN remains BLOCKED", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST J — short + directionalShock UP => BLOCK
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "short",
    currentPrice: 2598,
    now: NOW,
    lastLossState: baseShortLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "ALLOW",
    macroPolarity: "NEUTRAL",
    directionalShockState: "UP" // conflict
  });

  assert.equal(res.allowed, false);
  assert.equal(res.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
  pass("TEST J — SHORT with directionalShock UP remains BLOCKED", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST K — 기존 meaningful displacement ALLOW 불변
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2610, // displacement (2610-2580)/2580 = 1.16% >= 0.35%
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    structuralEvent: "none"
  });

  assert.equal(res.allowed, true);
  assert.equal(res.reason, "MEANINGFUL_DIRECTIONAL_DISPLACEMENT_ALLOWED");
  pass("TEST K — Meaningful directional displacement ALLOW preserved", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST L — 기존 fresh structural setup ALLOW 불변
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582,
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "BREAKOUT_CONFIRMED",
    structuralEvent: "confirmed_breakout",
    reversalConfirmed: true
  });

  assert.equal(res.allowed, true);
  assert.equal(res.reason, "FRESH_STRUCTURAL_SETUP_CONFIRMED");
  pass("TEST L — Fresh structural setup confirmed ALLOW preserved", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST M — ordinary same-zone churn BLOCK 불변
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582,
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "RANGE",
    subtype: "RANGE_FLAT",
    structuralEvent: "none",
    trendOk: false,
    qualityScore: 50,
    htfEntryPolicy: "ALLOW"
  });

  assert.equal(res.allowed, false);
  assert.equal(res.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
  pass("TEST M — Ordinary same-zone churn BLOCK preserved", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST N — terminal/finalize barrier가 active면 이 변경으로 절대 우회되지 않음
{
  const openPositions: PaperOpenPositionRecord[] = [
    {
      symbol: "ETHUSDT",
      side: "long",
      openedAt: NOW - 600_000,
      entryPrice: 2600,
      sizeUsd: 100,
      contracts: 0.1,
      finalizePending: true, // finalize pending active
      pendingFinalizeFlowId: "flow_eth_finalize_1"
    } as any
  ];

  const terminalBarrier = evaluateTerminalReentryBarrier({
    symbol: "ETHUSDT",
    requestedSide: "long",
    openPositions,
    openPositionsSourceAvailable: true
  });

  assert.equal(terminalBarrier.blocked, true);
  assert.equal(terminalBarrier.reason, "FINALIZE_PENDING_AWAITING_OKX_FLAT");
  pass("TEST N — Terminal barrier cannot be bypassed by loss reentry gate", `blocked=${terminalBarrier.blocked}, reason=${terminalBarrier.reason}`);
}

// TEST O — TREND + trendOk + quality>=70 + 5 candles지만 htfEntryPolicy missing/null => BLOCK
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582,
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: null, // missing/null
    macroPolarity: "NEUTRAL",
    directionalShockState: "NONE"
  });

  assert.equal(res.allowed, false);
  assert.equal(res.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
  pass("TEST O — Missing HTF entry policy fails closed", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST P — directionalShockState=UNKNOWN => BLOCK for both LONG and SHORT
{
  const resLong = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582,
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "LONG_ONLY_OR_NONE",
    macroPolarity: "NEUTRAL",
    directionalShockState: "UNKNOWN" // UNKNOWN shock
  });

  assert.equal(resLong.allowed, false);
  assert.equal(resLong.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");

  const resShort = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "short",
    currentPrice: 2598,
    now: NOW,
    lastLossState: baseShortLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "SHORT_ONLY_OR_NONE",
    macroPolarity: "NEUTRAL",
    directionalShockState: "UNKNOWN" // UNKNOWN shock
  });

  assert.equal(resShort.allowed, false);
  assert.equal(resShort.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
  pass("TEST P — UNKNOWN directional shock state fails closed for LONG and SHORT", `longAllowed=${resLong.allowed}, shortAllowed=${resShort.allowed}`);
}

// TEST Q — macroPolarity missing/null 또는 canonical UNKNOWN => BLOCK
{
  const resNull = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582,
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "LONG_ONLY_OR_NONE",
    macroPolarity: null, // null
    directionalShockState: "NONE"
  });

  assert.equal(resNull.allowed, false);
  assert.equal(resNull.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");

  const resUnknown = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582,
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 75,
    htfEntryPolicy: "LONG_ONLY_OR_NONE",
    macroPolarity: "UNKNOWN", // unknown string
    directionalShockState: "NONE"
  });

  assert.equal(resUnknown.allowed, false);
  assert.equal(resUnknown.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
  pass("TEST Q — Null and UNKNOWN macro polarity fail closed", `nullAllowed=${resNull.allowed}, unknownAllowed=${resUnknown.allowed}`);
}

// TEST R — 기존 ETH형 정상 케이스: TREND + trendOk + quality>=70 + LONG_ONLY_OR_NONE + valid macro + shock NONE + >=5 candles => ALLOW
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2582,
    now: NOW,
    lastLossState: baseLongLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 78,
    htfEntryPolicy: "LONG_ONLY_OR_NONE",
    macroPolarity: "BULLISH",
    directionalShockState: "NONE"
  });

  assert.equal(res.allowed, true);
  assert.equal(res.reason, "STRONG_TREND_REVALIDATED_AFTER_LOSS");
  pass("TEST R — Valid ETH-style LONG strong trend revalidation ALLOW preserved", `allowed=${res.allowed}, reason=${res.reason}`);
}

// TEST S — 정확한 SHORT 대칭 정상 케이스: TREND + trendOk + quality>=70 + SHORT_ONLY_OR_NONE + valid macro + shock NONE + >=5 candles => ALLOW
{
  const res = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "short",
    currentPrice: 2598,
    now: NOW,
    lastLossState: baseShortLoss,
    candles: makeCandles(10, NOW - 600_000),
    regime: "TREND",
    subtype: "WHIPSAW_SOFT_WATCH",
    structuralEvent: "none",
    trendOk: true,
    qualityScore: 78,
    htfEntryPolicy: "SHORT_ONLY_OR_NONE",
    macroPolarity: "BEARISH",
    directionalShockState: "NONE"
  });

  assert.equal(res.allowed, true);
  assert.equal(res.reason, "STRONG_TREND_REVALIDATED_AFTER_LOSS");
  pass("TEST S — Valid SHORT symmetric strong trend revalidation ALLOW preserved", `allowed=${res.allowed}, reason=${res.reason}`);
}

console.log("\nALL 19 V2 STRONG TREND LOSS RE-ENTRY TESTS (A ~ S) PASSED SUCCESSFULLY!");
