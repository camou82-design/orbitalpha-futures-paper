/**
 * Upper-zone native FAST_TREND_SHIFT vs RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG regressions.
 *
 * I. Unconfirmed upper chase => RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG => SKIP/none
 * J. Confirmed authoritative upper breakout => exemption => ENTER/long
 * K. WHIPSAW hard in upper context => still blocked
 * L. Production combined: downgrade + same-side shock overlay + confirmed upper breakout => ENTER/long
 */

import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor";
import { globalShockStates } from "../engine-v2/state/derive";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";

function run(label: string, passed: boolean, detail: string): void {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[UPPER-ZONE-AUDIT][${label}] ${tag} — ${detail}`);
  if (!passed) throw new Error(`[UPPER-ZONE-AUDIT][${label}] FAILED: ${detail}`);
}

function captureProofLogs(fn: () => void): Record<string, unknown>[] {
  const logs: Record<string, unknown>[] = [];
  const origInfo = console.info;
  console.info = (msg: unknown) => {
    try {
      const p = JSON.parse(String(msg));
      if (p && typeof p.event === "string") logs.push(p);
    } catch { /* ignore */ }
    origInfo(msg);
  };
  try { fn(); } finally { console.info = origInfo; }
  return logs;
}

function makeProductionBridge(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    paperExecutionReady: true,
    signedExecutionReady: true,
    serverTradeEnabled: true,
    closeOnlyMode: false,
    killSwitch: false,
    reconcileSafeMode: false,
    longAllow: true,
    shortAllow: false,
    currentPositions: [],
    executionReadiness: true,
    accountEquityKrw: 10_000_000,
    exposureNotionalCapKrw: 100_000_000,
    symbolExposureNotionalCapKrw: 50_000_000,
    accountEquityUsdt: 10_000,
    availableBalanceUsdt: 10_000,
    liveBalanceReady: true,
    okxActualPositionsReady: true,
    actualAccountNotionalUsdtReady: true,
    okxActualPositions: [],
    okxPendingOrdersReady: true,
    okxPendingOrdersNotionalUsdt: 0,
    okxPendingSymbolNotionalUsdt: 0,
    hasSymbolPendingEntry: false,
    hasUnknownPendingNotional: false,
    okxLiveEnabled: true,
    okxAuthMode: "live",
    okxAuthReady: true,
    okxExchangeAuthOptIn: true,
    okxApiKeyPresent: true,
    okxApiSecretPresent: true,
    okxPassphrasePresent: true,
    balanceFetchedAt: now,
    positionsFetchedAt: now,
    pendingOrdersFetchedAt: now,
    entryQualityProfiles: {
      profit: { qualityScoreAvg: 90, emaGapAvg: 0.005, atrPctAvg: 0.01, volumeRatioAvg: 1.2, count: 8 },
      loss: { qualityScoreAvg: 55, emaGapAvg: 0.001, atrPctAvg: 0.01, volumeRatioAvg: 0.9, count: 2 },
      contaminated: { qualityScoreAvg: 60, emaGapAvg: 0.002, atrPctAvg: 0.01, volumeRatioAvg: 1.0, count: 1 }
    },
    ...overrides
  };
}

function makeLiveConfig() {
  return {
    paperMaxOpenPositions: 3,
    baseSizeUsd: 100,
    maxSymbolNotionalUsd: 5000,
    maxAccountNotionalUsd: 20000,
    okxLiveEnabled: true,
    okxAuthMode: "live",
    okxExchangeAuthOptIn: true,
    okxLiveMaxOrderNotionalUsdt: 200,
    serverTradeEnabled: true
  };
}

function seedUpShock(symbol: string): void {
  globalShockStates.set(symbol, {
    activeDirection: "UP",
    rawDirection: "UP",
    candidateDirection: "UP",
    candidateCount: 3,
    neutralCount: 0,
    candidateStartedAt: Date.now() - 60_000,
    activatedAt: Date.now() - 30_000,
    lastChangedAt: Date.now(),
    rawMovePct: 0.01,
    requiredMovePct: 0.0012,
    emergencyBypass: true,
    lastProcessedCycle: 0
  });
}

function makeFastTrendShiftLongCandles(base = 69000): Candle[] {
  const flat: Candle[] = Array.from({ length: 110 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: base - 200,
    high: base - 150,
    low: base - 250,
    close: base - 180,
    volume: 80
  }));
  const rising = Array.from({ length: 10 }, (_, i) => {
    const px = base - 100 + i * 120;
    return {
      ts: Date.now() - (10 - i) * 60000,
      open: px,
      high: px + 80,
      low: px - 20,
      close: px + 60,
      volume: 150
    };
  });
  return [...flat, ...rising];
}

function makeBullishHtf(base = 69000): Candle[] {
  return Array.from({ length: 120 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: base + i * 6,
    high: base + i * 6 + 5,
    low: base + i * 6 - 5,
    close: base + i * 6 + 2,
    volume: 100
  }));
}

function makeConfirmedUpperBreakoutCandles(boxHigh = 70000, boxLow = 68000): Candle[] {
  const flat: Candle[] = Array.from({ length: 108 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: boxLow + 200,
    high: boxLow + 350,
    low: boxLow + 100,
    close: boxLow + 250,
    volume: 80
  }));
  const ramp: Candle[] = Array.from({ length: 8 }, (_, i) => {
    const px = boxHigh - 350 + i * 45;
    return {
      ts: Date.now() - (10 - i) * 60000,
      open: px,
      high: px + 60,
      low: px - 15,
      close: px + 40,
      volume: 160
    };
  });
  const holdAbove: Candle[] = [
    {
      ts: Date.now() - 120000,
      open: boxHigh - 10,
      high: boxHigh + 70,
      low: boxHigh - 25,
      close: boxHigh + 55,
      volume: 180
    },
    {
      ts: Date.now() - 60000,
      open: boxHigh + 40,
      high: boxHigh + 95,
      low: boxHigh + 20,
      close: boxHigh + 80,
      volume: 200
    },
    {
      ts: Date.now(),
      open: boxHigh + 70,
      high: boxHigh + 110,
      low: boxHigh + 55,
      close: boxHigh + 100,
      volume: 210
    }
  ];
  return [...flat, ...ramp, ...holdAbove];
}

type CaseLCombinedRun = {
  judgment: ReturnType<typeof detectMarketRegime>;
  decision: ReturnType<typeof runEngineV2>["decision"];
  proofs: Record<string, unknown>[];
  nativeAuth: Record<string, unknown> | undefined;
  sideConsistency: Record<string, unknown> | undefined;
  finalizer: Record<string, unknown> | undefined;
  rangeVeto: Record<string, unknown> | undefined;
};

function runCaseLShockOverlayFixture(): CaseLCombinedRun {
  clearWhipsawObservationState("BTCUSDT");
  seedUpShock("BTCUSDT");
  rangeContinuationStateMap.delete("BTCUSDT");
  const boxHigh = 70000;
  const boxLow = 68000;
  const boxPos = 0.52;
  const candles = makeFastTrendShiftLongCandles(69000);
  const cycleNow = Date.now();
  const snap = {
    symbol: "BTCUSDT",
    lastPrice: 69200,
    latestCandleClose: 69200,
    signal: "paper_long_candidate",
    entryCandidate: false,
    qualityScore: 70,
    emaGap: 0.006,
    volumeRatioProxy: 1.3,
    boxHigh,
    boxLow,
    boxPos,
    atr: 250,
    atr20: 250,
    closedClose: 69200,
    rangeConfidence: 0.78,
    trendWeaknessScore: 0.55,
    boxCohesion01: 0.92,
    breakoutFailureRate: 0.15,
    rangeOscillationScore: 0.65,
    volumeExpansion: 1.6,
    ema20Slope: 0.0002,
    rangeSignalDowngraded: true,
    rangeSignalKeptByRelax: false,
    signalGateBlockedReason: "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG",
    candles,
    htf_candles: { "5m": candles, "15m": candles, "1h": makeBullishHtf(), "4h": makeBullishHtf() },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35,
    reviewing_ticks: 0
  };
  const input = adaptV2Input(
    "BTCUSDT",
    cycleNow,
    buildV2SnapshotBridge(snap as any) as any,
    makeLiveConfig() as any,
    makeProductionBridge({
      directionalShockState: "UP",
      pumpState: "PUMP_ALERT",
      shortAllow: false,
      balanceFetchedAt: cycleNow,
      positionsFetchedAt: cycleNow,
      pendingOrdersFetchedAt: cycleNow
    }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    candles,
    "authoritative",
    `upper_audit_combined_l_shock_${cycleNow}`
  );
  const judgment = detectMarketRegime(input);
  let decision: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => { ({ decision } = runEngineV2(input)); });
  return {
    judgment,
    decision: decision!,
    proofs,
    nativeAuth: proofs.find((p) => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF"),
    sideConsistency: proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF"),
    finalizer: proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF"),
    rangeVeto: proofs.find((p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF")
  };
}

function runCaseLCombinedFixture(confirmedUpperBreakout: boolean, cycleTag: string): CaseLCombinedRun {
  clearWhipsawObservationState("BTCUSDT");
  seedUpShock("BTCUSDT");
  const boxHigh = confirmedUpperBreakout ? 70100 : 70000;
  const boxLow = confirmedUpperBreakout ? 69900 : 68000;
  const boxPos = 0.9;
  const closedClose = confirmedUpperBreakout ? boxHigh + 5 : boxHigh - 150;
  const lastPrice = confirmedUpperBreakout ? boxHigh - 20 : boxHigh - 150;
  const candles = confirmedUpperBreakout
    ? makeConfirmedUpperBreakoutCandles(boxHigh, boxLow)
    : makeFastTrendShiftLongCandles(69000);
  if (confirmedUpperBreakout) {
    seedConfirmedUpperContinuation("BTCUSDT", boxHigh, boxLow);
  } else {
    rangeContinuationStateMap.delete("BTCUSDT");
  }
  const cycleNow = Date.now();
  const snap = {
    symbol: "BTCUSDT",
    lastPrice,
    latestCandleClose: closedClose,
    signal: "paper_long_candidate",
    entryCandidate: false,
    qualityScore: 70,
    emaGap: confirmedUpperBreakout ? 0.008 : 0.006,
    volumeRatioProxy: 1.3,
    boxHigh,
    boxLow,
    boxPos,
    boxBreakSide: confirmedUpperBreakout ? "upper" : undefined,
    atr: confirmedUpperBreakout ? 100 : 250,
    atr20: confirmedUpperBreakout ? 100 : 250,
    closedClose,
    rangeConfidence: 0.78,
    trendWeaknessScore: 0.55,
    boxCohesion01: 0.92,
    breakoutFailureRate: 0.12,
    rangeOscillationScore: 0.65,
    volumeExpansion: 1.8,
    ema20Slope: 0.0003,
    rangeSignalDowngraded: true,
    rangeSignalKeptByRelax: false,
    signalGateBlockedReason: "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG",
    candles,
    htf_candles: { "5m": candles, "15m": candles, "1h": makeBullishHtf(), "4h": makeBullishHtf() },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35,
    reviewing_ticks: 0
  };
  const input = adaptV2Input(
    "BTCUSDT",
    cycleNow,
    buildV2SnapshotBridge(snap as any) as any,
    makeLiveConfig() as any,
    makeProductionBridge({
      directionalShockState: "UP",
      pumpState: "PUMP_ALERT",
      shortAllow: false,
      balanceFetchedAt: cycleNow,
      positionsFetchedAt: cycleNow,
      pendingOrdersFetchedAt: cycleNow
    }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    candles,
    "authoritative",
    `${cycleTag}_${cycleNow}`
  );
  const judgment = detectMarketRegime(input);
  let decision: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => { ({ decision } = runEngineV2(input)); });
  return {
    judgment,
    decision: decision!,
    proofs,
    nativeAuth: proofs.find((p) => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF"),
    sideConsistency: proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF"),
    finalizer: proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF"),
    rangeVeto: proofs.find((p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF")
  };
}

function seedConfirmedUpperContinuation(symbol: string, boxHigh: number, boxLow: number): void {
  rangeContinuationStateMap.set(symbol, {
    symbol,
    direction: "up",
    phase: "RETEST_CONFIRMED",
    consecutiveCycles: 3,
    lastRunCycleId: null,
    lastCandleTimestamp: Date.now(),
    watchBoundaryPrice: boxHigh,
    watchStartedAtTimestamp: Date.now() - 120_000,
    totalCyclesSinceWatch: 4,
    countStartedCandleTs: null,
    hasCandleAdvancedDuringCount: true,
    watchStartedCandleTs: Date.now() - 300_000,
    lastLoggedRunCycleId: null,
    lastLoggedDeadlockBreakdownRunCycleId: null,
    previousConfirmedBoxHigh: boxHigh,
    previousConfirmedBoxLow: boxLow,
    countBoundaryPrice: boxHigh,
    countBoundarySource: "previous_confirmed",
    lastObservedBoxHigh: boxHigh,
    lastObservedBoxLow: boxLow,
    lastObservedCandleTs: Date.now()
  });
}

// CASE I — production upper unconfirmed chase: native auth true, geometric veto fires
{
  clearWhipsawObservationState("BTCUSDT");
  seedUpShock("BTCUSDT");
  const base = 69000;
  const boxHigh = 70000;
  const boxLow = 68000;
  const boxPos = 0.88;
  const last = base + (boxPos - 0.5) * (boxHigh - boxLow);
  const candles = makeFastTrendShiftLongCandles(base);
  const cycleNow = Date.now();
  const snap = {
    symbol: "BTCUSDT",
    lastPrice: last,
    latestCandleClose: last,
    signal: "paper_long_candidate",
    entryCandidate: false,
    qualityScore: 72,
    emaGap: 0.006,
    volumeRatioProxy: 1.2,
    boxHigh,
    boxLow,
    boxPos,
    atr: 250,
    atr20: 250,
    closedClose: last,
    rangeConfidence: 0.78,
    trendWeaknessScore: 0.22,
    boxCohesion01: 0.92,
    breakoutFailureRate: 0.15,
    rangeOscillationScore: 0.65,
    volumeExpansion: 1.6,
    ema20Slope: 0.0002,
    rangeSignalDowngraded: true,
    rangeSignalKeptByRelax: false,
    signalGateBlockedReason: "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG",
    candles,
    htf_candles: { "5m": candles, "15m": candles, "1h": makeBullishHtf(), "4h": makeBullishHtf() },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35,
    reviewing_ticks: 0
  };
  const input = adaptV2Input(
    "BTCUSDT",
    cycleNow,
    buildV2SnapshotBridge(snap as any) as any,
    makeLiveConfig() as any,
    makeProductionBridge({ directionalShockState: "UP", shortAllow: false, balanceFetchedAt: cycleNow, positionsFetchedAt: cycleNow, pendingOrdersFetchedAt: cycleNow }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    candles,
    "authoritative",
    `upper_audit_unconfirmed_${cycleNow}`
  );
  const judgment = detectMarketRegime(input);
  let decision: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => { ({ decision } = runEngineV2(input)); });
  const nativeAuth = proofs.find((p) => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
  const sideConsistency = proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF");
  const finalizer = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");

  run(
    "CASE_I_PRODUCTION_UPPER_UNCONFIRMED_BLOCKED",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      finalizer?.decision_before === "ENTER" &&
      finalizer?.side_before === "long" &&
      nativeAuth?.native_executor_enter_authority === true &&
      nativeAuth?.range_downgraded_hard_block === false &&
      nativeAuth?.native_executor_upper_breakout_confirmed === false &&
      nativeAuth?.range_upper_long_mismatch_before_exemption === true &&
      nativeAuth?.range_upper_long_mismatch_after_exemption === true &&
      sideConsistency?.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG" &&
      decision!.decision === "SKIP" &&
      decision!.side === "none" &&
      judgment.diagnostics?.fastTrendShift?.box_upper_breakout_hold !== true,
    `subtype=${judgment.subtype}, native_auth=${nativeAuth?.native_executor_enter_authority}, upper_confirmed=${nativeAuth?.native_executor_upper_breakout_confirmed}, veto=${sideConsistency?.vetoReason}, final=${decision!.decision}/${decision!.side}`
  );
}

// CASE J — confirmed authoritative upper breakout: exemption active, ENTER survives
{
  clearWhipsawObservationState("BTCUSDT");
  seedUpShock("BTCUSDT");
  const boxHigh = 70100;
  const boxLow = 69900;
  const boxPos = 0.9;
  const closedClose = boxHigh + 5;
  const lastPrice = boxHigh - 20;
  const candles = makeConfirmedUpperBreakoutCandles(boxHigh, boxLow);
  seedConfirmedUpperContinuation("BTCUSDT", boxHigh, boxLow);
  const cycleNow = Date.now();
  const snap = {
    symbol: "BTCUSDT",
    lastPrice,
    latestCandleClose: closedClose,
    signal: "paper_long_candidate",
    entryCandidate: false,
    qualityScore: 74,
    emaGap: 0.008,
    volumeRatioProxy: 1.3,
    boxHigh,
    boxLow,
    boxPos,
    boxBreakSide: "upper",
    atr: 100,
    atr20: 100,
    closedClose,
    rangeConfidence: 0.78,
    trendWeaknessScore: 0.2,
    boxCohesion01: 0.92,
    breakoutFailureRate: 0.12,
    rangeOscillationScore: 0.65,
    volumeExpansion: 1.8,
    ema20Slope: 0.0003,
    rangeSignalDowngraded: true,
    rangeSignalKeptByRelax: false,
    signalGateBlockedReason: "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG",
    candles,
    htf_candles: { "5m": candles, "15m": candles, "1h": makeBullishHtf(), "4h": makeBullishHtf() },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35,
    reviewing_ticks: 0
  };
  const input = adaptV2Input(
    "BTCUSDT",
    cycleNow,
    buildV2SnapshotBridge(snap as any) as any,
    makeLiveConfig() as any,
    makeProductionBridge({ directionalShockState: "UP", shortAllow: false, balanceFetchedAt: cycleNow, positionsFetchedAt: cycleNow, pendingOrdersFetchedAt: cycleNow }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    candles,
    "authoritative",
    `upper_audit_confirmed_${cycleNow}`
  );
  const judgment = detectMarketRegime(input);
  let decision: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => { ({ decision } = runEngineV2(input)); });
  const nativeAuth = proofs.find((p) => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
  const sideConsistency = proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF");
  const rangeVeto = proofs.find(
    (p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" && p.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG"
  );

  run(
    "CASE_J_CONFIRMED_UPPER_BREAKOUT_SURVIVES",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      nativeAuth?.native_executor_enter_authority === true &&
      nativeAuth?.native_executor_upper_breakout_confirmed === true &&
      nativeAuth?.native_executor_upper_breakout_confirmation_source === "evaluateUpperBreakoutLongConfirmed" &&
      nativeAuth?.range_upper_long_mismatch_before_exemption === true &&
      nativeAuth?.range_upper_long_mismatch_after_exemption === false &&
      rangeVeto == null &&
      sideConsistency?.vetoReason == null &&
      decision!.decision === "ENTER" &&
      decision!.side === "long" &&
      (decision!.risk?.finalOrderNotionalUsdt ?? 0) > 0,
    `subtype=${judgment.subtype}, upper_confirmed=${nativeAuth?.native_executor_upper_breakout_confirmed}, source=${nativeAuth?.native_executor_upper_breakout_confirmation_source}, mismatch_before=${nativeAuth?.range_upper_long_mismatch_before_exemption}, mismatch_after=${nativeAuth?.range_upper_long_mismatch_after_exemption}, notional=${decision!.risk?.finalOrderNotionalUsdt ?? 0}, final=${decision!.decision}/${decision!.side}`
  );
}

// CASE K — WHIPSAW hard still blocks (upper-zone context irrelevant)
{
  clearWhipsawObservationState("BTCUSDT");
  seedUpShock("BTCUSDT");
  const base = 69000;
  const micro = Array.from({ length: 112 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: base,
    high: base + 50,
    low: base - 50,
    close: base,
    volume: 100
  }));
  const tail = [
    { o: base, h: base + 100, l: base - 100, c: base + 50 },
    { o: base + 50, h: base + 800, l: base, c: base + 750 },
    { o: base + 750, h: base + 760, l: base + 600, c: base + 650 },
    { o: base + 650, h: base + 660, l: base + 500, c: base + 550 },
    { o: base + 550, h: base + 560, l: base + 400, c: base + 450 },
    { o: base + 450, h: base + 460, l: base + 300, c: base + 350 },
    { o: base + 350, h: base + 360, l: base + 200, c: base + 250 },
    { o: base + 250, h: base + 260, l: base - 100, c: base + 80 }
  ].map((b, i) => ({
    ts: Date.now() - (8 - i) * 60000,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: 120
  }));
  const candles = [...micro, ...tail];
  const cycleNow = Date.now();
  const snap = {
    symbol: "BTCUSDT",
    lastPrice: base + 80,
    latestCandleClose: base + 80,
    signal: "paper_long_candidate",
    entryCandidate: true,
    qualityScore: 85,
    emaGap: 0.006,
    volumeRatioProxy: 1.2,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.88,
    atr: 250,
    atr20: 250,
    closedClose: base + 80,
    rangeConfidence: 0.78,
    trendWeaknessScore: 0.22,
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.45,
    rangeOscillationScore: 0.2,
    volumeExpansion: 2.5,
    reviewing_ticks: 2,
    boxBreakSide: "upper",
    candles,
    htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35
  };
  const bridge = buildV2SnapshotBridge(snap as any);
  (bridge as any).boxBreakSide = "upper";
  const input = adaptV2Input(
    "BTCUSDT",
    cycleNow,
    bridge as any,
    makeLiveConfig() as any,
    makeProductionBridge({
      directionalShockState: "UP",
      crashState: "ALERT",
      shortAllow: false,
      balanceFetchedAt: cycleNow,
      positionsFetchedAt: cycleNow,
      pendingOrdersFetchedAt: cycleNow
    }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    candles,
    "authoritative",
    `upper_audit_whipsaw_${cycleNow}`
  );
  const judgment = detectMarketRegime(input);
  const { decision } = runEngineV2(input);

  run(
    "CASE_K_WHIPSAW_HARD_STILL_BLOCKS_UPPER_CONTEXT",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK" && decision.decision !== "ENTER",
    `subtype=${judgment.subtype}, final=${decision.decision}/${decision.side}`
  );
}

// CASE L — production combined path: downgrade + same-side shock overlay + confirmed upper breakout
{
  const shockOverlay = runCaseLShockOverlayFixture();
  const {
    judgment,
    decision,
    nativeAuth,
    sideConsistency,
    finalizer,
    rangeVeto,
    proofs
  } = runCaseLCombinedFixture(true, "upper_audit_combined_l");

  const downgradeVeto = proofs.find(
    (p) =>
      p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" &&
      p.vetoReason === "RANGE_SIGNAL_DOWNGRADED_NOT_RELAXED"
  );
  const upperMismatchVeto = proofs.find(
    (p) =>
      p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" &&
      p.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG"
  );
  const shockAuth = shockOverlay.nativeAuth;

  run(
    "CASE_L_PRODUCTION_COMBINED_CONFIRMED_UPPER_SURVIVES",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      finalizer?.decision_before === "ENTER" &&
      finalizer?.side_before === "long" &&
      nativeAuth?.native_executor_enter_authority === true &&
      shockAuth?.native_executor_enter_authority === true &&
      shockAuth?.promotion_applied_at_native_authority_eval === true &&
      shockAuth?.promotion_reason_at_native_authority_eval === "SHOCK_REACTION_UP_MID_MOMENTUM_CONFIRMED" &&
      shockAuth?.side_after_promotion_at_native_authority_eval === "long" &&
      shockAuth?.range_downgraded_hard_block === false &&
      shockAuth?.entry_candidate_hard_block === false &&
      nativeAuth?.native_executor_upper_breakout_confirmed === true &&
      nativeAuth?.native_executor_upper_breakout_confirmation_source === "evaluateUpperBreakoutLongConfirmed" &&
      nativeAuth?.range_upper_long_mismatch_before_exemption === true &&
      nativeAuth?.range_upper_long_mismatch_after_exemption === false &&
      nativeAuth?.range_downgraded_hard_block === false &&
      nativeAuth?.entry_candidate_hard_block === false &&
      decision.decision === "ENTER" &&
      decision.side === "long" &&
      (decision.risk?.finalOrderNotionalUsdt ?? 0) > 0 &&
      upperMismatchVeto == null &&
      downgradeVeto == null &&
      sideConsistency?.vetoReason == null &&
      rangeVeto?.vetoReason !== "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG" &&
      rangeVeto?.vetoReason !== "RANGE_SIGNAL_DOWNGRADED_NOT_RELAXED",
    [
      `subtype=${judgment.subtype}`,
      `native_auth=${nativeAuth?.native_executor_enter_authority}`,
      `shock_promo_at_eval=${shockAuth?.promotion_applied_at_native_authority_eval}`,
      `shock_promo_reason=${shockAuth?.promotion_reason_at_native_authority_eval}`,
      `upper_promo_at_eval=${nativeAuth?.promotion_applied_at_native_authority_eval}`,
      `side_after_promo=${nativeAuth?.side_after_promotion_at_native_authority_eval}`,
      `upper_confirmed=${nativeAuth?.native_executor_upper_breakout_confirmed}`,
      `upper_confirmed_source=${nativeAuth?.native_executor_upper_breakout_confirmation_source}`,
      `mismatch_before=${nativeAuth?.range_upper_long_mismatch_before_exemption}`,
      `mismatch_after=${nativeAuth?.range_upper_long_mismatch_after_exemption}`,
      `downgrade_block=${nativeAuth?.range_downgraded_hard_block}`,
      `entry_candidate_block=${nativeAuth?.entry_candidate_hard_block}`,
      `notional=${decision.risk?.finalOrderNotionalUsdt ?? 0}`,
      `final=${decision.decision}/${decision.side}`,
      `side_veto=${sideConsistency?.vetoReason ?? "none"}`,
      `range_veto=${rangeVeto?.vetoReason ?? "none"}`
    ].join(", ")
  );
}

// CASE L negative — same combined fixture without authoritative upper breakout confirmation
{
  const {
    judgment,
    decision,
    nativeAuth,
    sideConsistency,
    finalizer
  } = runCaseLCombinedFixture(false, "upper_audit_combined_l_negative");

  run(
    "CASE_L_NEGATIVE_UNCONFIRMED_COMBINED_STILL_UPPER_MISMATCH",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      finalizer?.decision_before === "ENTER" &&
      finalizer?.side_before === "long" &&
      nativeAuth?.native_executor_enter_authority === true &&
      nativeAuth?.native_executor_upper_breakout_confirmed === false &&
      nativeAuth?.range_upper_long_mismatch_before_exemption === true &&
      nativeAuth?.range_upper_long_mismatch_after_exemption === true &&
      sideConsistency?.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG" &&
      decision.decision === "SKIP" &&
      decision.side === "none",
    [
      `subtype=${judgment.subtype}`,
      `native_auth=${nativeAuth?.native_executor_enter_authority}`,
      `promo_at_eval=${nativeAuth?.promotion_applied_at_native_authority_eval}`,
      `upper_confirmed=${nativeAuth?.native_executor_upper_breakout_confirmed}`,
      `mismatch_before=${nativeAuth?.range_upper_long_mismatch_before_exemption}`,
      `mismatch_after=${nativeAuth?.range_upper_long_mismatch_after_exemption}`,
      `veto=${sideConsistency?.vetoReason}`,
      `final=${decision.decision}/${decision.side}`
    ].join(", ")
  );
}

console.log("v2-upper-zone-native-authority-audit-cases: ALL PASS");
