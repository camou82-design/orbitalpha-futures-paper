/**
 * Native V2 RANGE executor ENTER vs paper-lane downgrade authority regressions.
 *
 * A. FAST_TREND_SHIFT native ENTER + rangeSignalDowngraded + Q65-69 => ENTER survives
 * B. Same context without executor ENTER => SKIP
 * C. CHASE_LONG_DISALLOWED_UPPER => still blocked
 * D. WHIPSAW_SHOCK_RECHECK hard => still blocked
 * E. HTF hard HOLD / opposite alignment => still blocked
 * F. Q>=80 qualified trend promotion => unchanged ENTER
 */

import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { globalShockStates } from "../engine-v2/state/derive";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";

function run(label: string, passed: boolean, detail: string): void {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[V2-NATIVE-EXECUTOR-AUTH][${label}] ${tag} — ${detail}`);
  if (!passed) throw new Error(`[V2-NATIVE-EXECUTOR-AUTH][${label}] FAILED: ${detail}`);
}

function captureProofLogs(fn: () => void): Record<string, unknown>[] {
  const logs: Record<string, unknown>[] = [];
  const origInfo = console.info;
  const capture = (msg: unknown) => {
    try {
      const p = JSON.parse(String(msg));
      if (p && typeof p.event === "string") logs.push(p);
    } catch { /* ignore */ }
  };
  console.info = (msg: unknown) => { capture(msg); origInfo(msg); };
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
    shortAllow: true,
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

function seedDownShock(symbol: string): void {
  globalShockStates.set(symbol, {
    activeDirection: "DOWN",
    rawDirection: "DOWN",
    candidateDirection: "DOWN",
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

/** Oscillating range candles — keeps judgment in RANGE while emaGap can stay bearish. */
function makeRangeOscillationCandles(base = 69000, amplitude = 400): Candle[] {
  return Array.from({ length: 120 }, (_, i) => {
    const wave = Math.sin(i / 3) * amplitude;
    const px = base + wave;
    return {
      ts: Date.now() - (120 - i) * 60000,
      open: px,
      high: px + 50,
      low: px - 50,
      close: px - 10,
      volume: 80
    };
  });
}

function makeTrendRangeSplitInput(opts: {
  qualityScore: number;
  directionalShockState: "DOWN" | "UP" | "NONE";
  boxPos: number;
  htfCandles: Candle[];
  candles?: Candle[];
  emaGap?: number;
}) {
  const base = 69000;
  const boxHigh = 70000;
  const boxLow = 68000;
  const candles = opts.candles ?? makeRangeOscillationCandles(base);
  const snap = {
    symbol: "BTCUSDT",
    lastPrice: base,
    latestCandleClose: base,
    signal: opts.directionalShockState === "DOWN" ? "paper_short_candidate" : "paper_long_candidate",
    entryCandidate: true,
    qualityScore: opts.qualityScore,
    candidateStrength: opts.qualityScore >= 90 ? "strong" : "normal",
    ema20: base * (1 + (opts.emaGap ?? -0.005) / 2),
    ema60: base * (1 - (opts.emaGap ?? -0.005) / 2),
    emaGap: opts.emaGap ?? -0.005,
    volumeRatioProxy: 1.1,
    boxHigh,
    boxLow,
    boxPos: opts.boxPos,
    boxRel: 0.02,
    atr: 250,
    atr20: 250,
    closedClose: base,
    rangeConfidence: 0.78,
    trendWeaknessScore: 0.25,
    boxCohesion01: 0.92,
    breakoutFailureRate: 0.15,
    rangeOscillationScore: 0.65,
    candles,
    htf_candles: {
      "5m": candles,
      "15m": candles,
      "1h": opts.htfCandles,
      "4h": opts.htfCandles
    },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35,
    reviewing_ticks: 0
  };

  const cycleNow = Date.now();
  const bridge = buildV2SnapshotBridge(snap as any);
  if (opts.directionalShockState === "DOWN") seedDownShock("BTCUSDT");
  else if (opts.directionalShockState === "UP") seedUpShock("BTCUSDT");
  else globalShockStates.delete("BTCUSDT");

  return adaptV2Input(
    "BTCUSDT",
    cycleNow,
    bridge as any,
    makeLiveConfig() as any,
    makeProductionBridge({
      directionalShockState: opts.directionalShockState,
      balanceFetchedAt: cycleNow,
      positionsFetchedAt: cycleNow,
      pendingOrdersFetchedAt: cycleNow
    }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    candles,
    "authoritative",
    `native_exec_auth_promo_${cycleNow}`
  );
}

const mockBearishCandles: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 60000,
  open: 70000 - i * 8,
  high: 70005 - i * 8,
  low: 69995 - i * 8,
  close: 69998 - i * 8,
  volume: 100
}));

function makeBearishHtf(base = 69000): Candle[] {
  return Array.from({ length: 120 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: base - i * 6,
    high: base - i * 6 + 5,
    low: base - i * 6 - 5,
    close: base - i * 6 - 2,
    volume: 100
  }));
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

/** Upward micro-structure for FAST_TREND_SHIFT long (>=3 long hits). */
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

function makeFlatRangeCandles(base = 69000): Candle[] {
  return Array.from({ length: 120 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: base,
    high: base + 20,
    low: base - 20,
    close: base + (i % 2 === 0 ? 5 : -5),
    volume: 80
  }));
}

function makeWhipsawMicroCandles(base = 69000): Candle[] {
  const flat: Candle[] = Array.from({ length: 112 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: base,
    high: base + 50,
    low: base - 50,
    close: base,
    volume: 100
  }));
  const tail: Array<{ o: number; h: number; l: number; c: number }> = [
    { o: base, h: base + 100, l: base - 100, c: base + 50 },
    { o: base + 50, h: base + 800, l: base, c: base + 750 },
    { o: base + 750, h: base + 760, l: base + 600, c: base + 650 },
    { o: base + 650, h: base + 660, l: base + 500, c: base + 550 },
    { o: base + 550, h: base + 560, l: base + 400, c: base + 450 },
    { o: base + 450, h: base + 460, l: base + 300, c: base + 350 },
    { o: base + 350, h: base + 360, l: base + 200, c: base + 250 },
    { o: base + 250, h: base + 260, l: base - 100, c: base + 80 }
  ];
  return [
    ...flat,
    ...tail.map((b, i) => ({
      ts: Date.now() - (8 - i) * 60000,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: 120
    }))
  ];
}

type ScenarioOpts = {
  candles: Candle[];
  htfCandles: Candle[];
  qualityScore: number;
  boxPos: number;
  shock: "UP" | "DOWN" | "NONE";
  rangeSignalDowngraded?: boolean;
  entryCandidate?: boolean;
  signal?: string;
  emaGap?: number;
  trendWeaknessScore?: number;
  volumeExpansion?: number;
  ema20Slope?: number;
  breakoutFailureRate?: number;
  pumpState?: string;
};

function buildInput(opts: ScenarioOpts) {
  const base = 69000;
  const boxHigh = 70000;
  const boxLow = 68000;
  const snap = {
    symbol: "BTCUSDT",
    lastPrice: base + (opts.boxPos - 0.5) * (boxHigh - boxLow),
    latestCandleClose: base + (opts.boxPos - 0.5) * (boxHigh - boxLow),
    signal: opts.signal ?? "paper_long_candidate",
    entryCandidate: opts.entryCandidate ?? true,
    qualityScore: opts.qualityScore,
    candidateStrength: "normal",
    ema20: base * 1.001,
    ema60: base * 0.999,
    emaGap: opts.emaGap ?? 0.005,
    volumeRatioProxy: 1.2,
    boxHigh,
    boxLow,
    boxPos: opts.boxPos,
    boxRel: 0.02,
    atr: 250,
    atr20: 250,
    closedClose: base + (opts.boxPos - 0.5) * (boxHigh - boxLow),
    rangeConfidence: 0.78,
    trendWeaknessScore: opts.trendWeaknessScore ?? 0.22,
    boxCohesion01: 0.92,
    breakoutFailureRate: opts.breakoutFailureRate ?? 0.15,
    rangeOscillationScore: 0.65,
    volumeExpansion: opts.volumeExpansion ?? 1.6,
    ema20Slope: opts.ema20Slope ?? 0.0002,
    rangeSignalDowngraded: opts.rangeSignalDowngraded ?? false,
    rangeSignalKeptByRelax: false,
    candles: opts.candles,
    htf_candles: {
      "5m": opts.candles,
      "15m": opts.candles,
      "1h": opts.htfCandles,
      "4h": opts.htfCandles,
      "1d": opts.htfCandles
    },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35,
    reviewing_ticks: 0
  };

  if (opts.shock === "UP") seedUpShock("BTCUSDT");
  else if (opts.shock === "DOWN") seedDownShock("BTCUSDT");
  else globalShockStates.delete("BTCUSDT");

  const bridge = buildV2SnapshotBridge(snap as any);
  const cycleNow = Date.now();
  return adaptV2Input(
    "BTCUSDT",
    cycleNow,
    bridge as any,
    makeLiveConfig() as any,
    makeProductionBridge({
      directionalShockState: opts.shock === "NONE" ? "NONE" : opts.shock,
      pumpState: opts.pumpState,
      balanceFetchedAt: cycleNow,
      positionsFetchedAt: cycleNow,
      pendingOrdersFetchedAt: cycleNow
    }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    opts.candles,
    "authoritative",
    `native_exec_auth_${cycleNow}_${Math.random()}`
  );
}

function runScenario(opts: ScenarioOpts) {
  clearWhipsawObservationState("BTCUSDT");
  const input = buildInput(opts);
  const judgment = detectMarketRegime(input);
  let decision: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => {
    ({ decision } = runEngineV2(input));
  });
  return { input, judgment, decision: decision!, proofs };
}

// CASE A — native FAST_TREND_SHIFT ENTER survives paper downgrade
{
  const { judgment, decision, proofs } = runScenario({
    candles: makeFastTrendShiftLongCandles(),
    htfCandles: makeBullishHtf(),
    qualityScore: 67,
    boxPos: 0.52,
    shock: "UP",
    rangeSignalDowngraded: true,
    entryCandidate: false,
    signal: "paper_long_candidate"
  });

  const finalizer = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");
  const sideConsistency = proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF");
  const rangeVeto = proofs.find(
    (p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" && p.vetoReason === "RANGE_SIGNAL_DOWNGRADED_NOT_RELAXED"
  );

  run(
    "CASE_A_FAST_TREND_SHIFT_NATIVE_ENTER_SURVIVES_DOWNGRADE",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      finalizer?.decision_before === "ENTER" &&
      finalizer?.promotion_applied === false &&
      sideConsistency?.finalDecisionBeforeVeto === "ENTER" &&
      rangeVeto == null &&
      decision.decision === "ENTER" &&
      decision.side === "long",
    `subtype=${judgment.subtype}, before=${finalizer?.decision_before}, after=${decision.decision}/${decision.side}, veto=${rangeVeto?.vetoReason ?? "none"}, promotion_block=${finalizer?.promotion_block_reason ?? "none"}`
  );
  run(
    "CASE_A_NOTIONAL_NONZERO_WHEN_ENTER",
    (decision.risk?.finalOrderNotionalUsdt ?? 0) > 0,
    `notional=${decision.risk?.finalOrderNotionalUsdt ?? 0}`
  );
  run(
    "CASE_A_NO_MISLEADING_QUALITY_BLOCK_ON_NATIVE_ENTER",
    finalizer?.promotion_block_reason !== "TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD",
    `promotion_block=${finalizer?.promotion_block_reason ?? "none"}`
  );
}

// CASE B — no native executor ENTER => paper downgrade still SKIPs
{
  const { judgment, decision, proofs } = runScenario({
    candles: makeFlatRangeCandles(),
    htfCandles: makeBullishHtf(),
    qualityScore: 67,
    boxPos: 0.52,
    shock: "UP",
    rangeSignalDowngraded: true,
    entryCandidate: false,
    signal: "none"
  });

  const finalizer = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");
  const rangeVeto = proofs.find((p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");

  run(
    "CASE_B_NO_NATIVE_ENTER_STILL_SKIPS_ON_DOWNGRADE",
    judgment.subtype !== "FAST_TREND_SHIFT" &&
      finalizer?.decision_before !== "ENTER" &&
      decision.decision !== "ENTER",
    `subtype=${judgment.subtype}, before=${finalizer?.decision_before}, final=${decision.decision}/${decision.side}, veto=${rangeVeto?.vetoReason ?? "none"}`
  );
}

// CASE C — CHASE_LONG_DISALLOWED_UPPER still blocks at upper-zone conflict
{
  clearWhipsawObservationState("BTCUSDT");
  seedUpShock("BTCUSDT");
  const base = 69000;
  const candles = makeFastTrendShiftLongCandles(base);
  const snap = {
    symbol: "BTCUSDT",
    lastPrice: 69850,
    latestCandleClose: 69850,
    signal: "paper_long_candidate",
    entryCandidate: false,
    qualityScore: 72,
    emaGap: 0.005,
    volumeRatioProxy: 1.2,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.88,
    atr: 250,
    atr20: 250,
    closedClose: 69850,
    rangeConfidence: 0.78,
    trendWeaknessScore: 0.22,
    boxCohesion01: 0.92,
    breakoutFailureRate: 0.15,
    rangeOscillationScore: 0.65,
    volumeExpansion: 1.6,
    ema20Slope: 0.0002,
    rangeSignalDowngraded: false,
    candles,
    htf_candles: { "5m": candles, "15m": candles, "1h": makeBullishHtf(), "4h": makeBullishHtf() },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35,
    reviewing_ticks: 0
  };
  const cycleNow = Date.now();
  const input = adaptV2Input(
    "BTCUSDT",
    cycleNow,
    buildV2SnapshotBridge(snap as any) as any,
    makeLiveConfig() as any,
    makeProductionBridge({
      directionalShockState: "UP",
      balanceFetchedAt: cycleNow,
      positionsFetchedAt: cycleNow,
      pendingOrdersFetchedAt: cycleNow
    }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    candles,
    "authoritative",
    `native_exec_auth_chase_${cycleNow}`
  );
  const judgment = detectMarketRegime(input);
  let decision: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => { ({ decision } = runEngineV2(input)); });
  const finalizer = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");

  run(
    "CASE_C_CHASE_LONG_DISALLOWED_UPPER_STILL_BLOCKS",
    decision!.decision !== "ENTER" &&
      (finalizer?.reject_reason_after === "CHASE_LONG_DISALLOWED_UPPER" ||
        proofs.some((p) => p.event === "V2_RANGE_TREND_CONFLICT_RESOLUTION_PROOF" && p.conflict_resolution_reason === "chase_long_disallowed_in_upper_zone")),
    `final=${decision!.decision}/${decision!.side}, reject=${finalizer?.reject_reason_after}, subtype=${judgment.subtype}, zone=upper`
  );
}

// CASE D — WHIPSAW hard still blocks (HTF Case G pattern)
{
  clearWhipsawObservationState("BTCUSDT");
  seedDownShock("BTCUSDT");
  const base = 69000;
  const micro = makeWhipsawMicroCandles(base);
  const cycleNow = Date.now();
  const snap = {
    symbol: "BTCUSDT",
    lastPrice: base - 80,
    latestCandleClose: base - 80,
    signal: "paper_short_candidate",
    entryCandidate: true,
    qualityScore: 85,
    emaGap: -0.006,
    volumeRatioProxy: 1.2,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.35,
    atr: 250,
    atr20: 250,
    closedClose: base - 80,
    rangeConfidence: 0.78,
    trendWeaknessScore: 0.22,
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.45,
    rangeOscillationScore: 0.2,
    volumeExpansion: 2.5,
    reviewing_ticks: 2,
    boxBreakSide: "lower",
    candles: micro,
    htf_candles: { "5m": micro, "15m": micro, "1h": micro, "4h": micro },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35
  };
  const bridge = buildV2SnapshotBridge(snap as any);
  (bridge as any).boxBreakSide = "lower";
  const input = adaptV2Input(
    "BTCUSDT",
    cycleNow,
    bridge as any,
    makeLiveConfig() as any,
    makeProductionBridge({
      directionalShockState: "DOWN",
      crashState: "ALERT",
      balanceFetchedAt: cycleNow,
      positionsFetchedAt: cycleNow,
      pendingOrdersFetchedAt: cycleNow
    }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    micro,
    "authoritative",
    `native_exec_auth_whipsaw_${cycleNow}`
  );
  const judgment = detectMarketRegime(input);
  const { decision } = runEngineV2(input);

  run(
    "CASE_D_WHIPSAW_HARD_STILL_BLOCKS",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK" && decision.decision !== "ENTER",
    `subtype=${judgment.subtype}, final=${decision.decision}/${decision.side}, block=${decision.risk?.blockReason ?? decision.explanation?.reason ?? "none"}`
  );
}

// CASE E — HTF hard HOLD blocks contrarian short
{
  const { judgment, decision } = runScenario({
    candles: makeFastTrendShiftLongCandles(),
    htfCandles: makeBullishHtf(),
    qualityScore: 85,
    boxPos: 0.5,
    shock: "DOWN",
    rangeSignalDowngraded: false,
    entryCandidate: true,
    signal: "paper_short_candidate",
    emaGap: -0.006
  });

  run(
    "CASE_E_HTF_HARD_HOLD_STILL_BLOCKS",
    (judgment.htf_entry_policy === "HOLD" || decision.decision !== "ENTER" || decision.side !== "short"),
    `policy=${judgment.htf_entry_policy}, polarity=${judgment.polarityProbeEligible}, final=${decision.decision}/${decision.side}`
  );
}

// CASE F — Q>=80 qualified trend promotion unchanged (liveness Case A fixture)
{
  clearWhipsawObservationState("BTCUSDT");
  const input = makeTrendRangeSplitInput({
    qualityScore: 85,
    directionalShockState: "DOWN",
    boxPos: 0.5,
    htfCandles: mockBearishCandles
  });
  let decision: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => { ({ decision } = runEngineV2(input)); });
  const finalizer = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");

  run(
    "CASE_F_Q80_TREND_PROMOTION_ENTER_UNCHANGED",
    finalizer?.promotion_applied === true &&
      finalizer?.promotion_reason === "V2_TREND_QUALIFIED_FINAL_PROMOTION" &&
      decision!.decision === "ENTER" &&
      decision!.side === "short",
    `promotion=${finalizer?.promotion_reason}, final=${decision!.decision}/${decision!.side}, notional=${decision!.risk?.finalOrderNotionalUsdt ?? 0}`
  );
}

// CASE G — production Q70: trendOk=false, sideZoneValid=false, same-side shock overlay + downgrade
{
  const { judgment, decision, proofs } = runScenario({
    candles: makeFastTrendShiftLongCandles(),
    htfCandles: makeBullishHtf(),
    qualityScore: 70,
    boxPos: 0.52,
    shock: "UP",
    rangeSignalDowngraded: true,
    entryCandidate: false,
    signal: "paper_long_candidate",
    emaGap: 0.005,
    trendWeaknessScore: 0.55,
    pumpState: "PUMP_ALERT"
  });

  const finalizer = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");
  const nativeAuth = proofs.find((p) => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
  const rangeVeto = proofs.find(
    (p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" && p.vetoReason === "RANGE_SIGNAL_DOWNGRADED_NOT_RELAXED"
  );

  run(
    "CASE_G_PRODUCTION_Q70_SHOCK_OVERLAY_SURVIVES_DOWNGRADE",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      finalizer?.decision_before === "ENTER" &&
      finalizer?.side_before === "long" &&
      nativeAuth?.native_executor_enter_authority === true &&
      nativeAuth?.range_downgraded_hard_block === false &&
      rangeVeto == null &&
      decision.decision === "ENTER" &&
      decision.side === "long",
    `subtype=${judgment.subtype}, native_auth=${nativeAuth?.native_executor_enter_authority}, promo_at_eval=${nativeAuth?.promotion_applied_at_native_authority_eval}, downgrade_block=${nativeAuth?.range_downgraded_hard_block}, final=${decision.decision}/${decision.side}`
  );
}

// CASE H — upper-zone SHOCK_REACTION_UP long mismatch remains a genuine hard veto
{
  clearWhipsawObservationState("BTCUSDT");
  seedUpShock("BTCUSDT");
  const base = 69000;
  const candles = makeFastTrendShiftLongCandles(base);
  const cycleNow = Date.now();
  const snap = {
    symbol: "BTCUSDT",
    lastPrice: 69850,
    latestCandleClose: 69850,
    signal: "paper_long_candidate",
    entryCandidate: false,
    qualityScore: 72,
    emaGap: 0.006,
    volumeRatioProxy: 1.2,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.88,
    atr: 250,
    atr20: 250,
    closedClose: 69850,
    rangeConfidence: 0.78,
    trendWeaknessScore: 0.22,
    boxCohesion01: 0.92,
    breakoutFailureRate: 0.15,
    rangeOscillationScore: 0.65,
    volumeExpansion: 1.6,
    ema20Slope: 0.0002,
    rangeSignalDowngraded: false,
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
      balanceFetchedAt: cycleNow,
      positionsFetchedAt: cycleNow,
      pendingOrdersFetchedAt: cycleNow
    }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    candles,
    "authoritative",
    `native_exec_auth_upper_${cycleNow}`
  );
  const judgment = detectMarketRegime(input);
  const { decision, proofs } = (() => {
    let d: ReturnType<typeof runEngineV2>["decision"];
    const p = captureProofLogs(() => { ({ decision: d } = runEngineV2(input)); });
    return { decision: d!, proofs: p };
  })();
  const sideConsistency = proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF");

  run(
    "CASE_H_UPPER_ZONE_LONG_MISMATCH_STILL_HARD_VETO",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      (sideConsistency?.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG" ||
        sideConsistency?.vetoReason === "CHASE_LONG_DISALLOWED_UPPER" ||
        decision.decision !== "ENTER"),
    `subtype=${judgment.subtype}, zone=upper, veto=${sideConsistency?.vetoReason ?? "none"}, final=${decision.decision}/${decision.side}`
  );
}

console.log("v2-native-executor-enter-authority-cases: ALL PASS");
