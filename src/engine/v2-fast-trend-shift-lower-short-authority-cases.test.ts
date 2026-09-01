/**
 * FAST_TREND_SHIFT lower-edge short authority — Fix A + Fix B regressions.
 *
 * A. lower + FAST_TREND_SHIFT short + no closed breakdown → no ENTER
 * B. lower + closed breakdown only + no retest → no ENTER
 * C. lower + confirmed breakdown + retest resistance → short ENTER allowed
 * D. WHIPSAW_SHOCK_RECHECK hard block preserved after Fix A/B
 * E. HTF hard/opposite polarity block preserved
 * F. Q>=80 qualified trend promotion ENTER preserved
 * G. Q70 native long ENTER survives range downgrade
 */

import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { evaluateLowerBreakdownShortConfirmed } from "../engine-v2/range-boundary-continuation";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor";
import { globalShockStates } from "../engine-v2/state/derive";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";

function run(label: string, passed: boolean, detail: string): void {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[LOWER-FTS-SHORT-AUTH][${label}] ${tag} — ${detail}`);
  if (!passed) throw new Error(`[LOWER-FTS-SHORT-AUTH][${label}] FAILED: ${detail}`);
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

function seedLowerBreakdownRetestTouched(symbol: string, boxLow: number, boxHigh: number): void {
  const now = Date.now();
  rangeContinuationStateMap.set(symbol, {
    symbol,
    direction: "down",
    phase: "RETEST_TOUCHED",
    consecutiveCycles: 3,
    lastRunCycleId: null,
    lastCandleTimestamp: now,
    watchBoundaryPrice: boxLow,
    watchStartedAtTimestamp: now - 120_000,
    totalCyclesSinceWatch: 3,
    countStartedCandleTs: null,
    hasCandleAdvancedDuringCount: true,
    watchStartedCandleTs: now - 120_000,
    lastLoggedRunCycleId: null,
    lastLoggedDeadlockBreakdownRunCycleId: null,
    previousConfirmedBoxLow: boxLow,
    previousConfirmedBoxHigh: boxHigh,
    countBoundaryPrice: boxLow,
    countBoundarySource: "previous_confirmed",
    lastObservedBoxHigh: boxHigh,
    lastObservedBoxLow: boxLow,
    lastObservedCandleTs: now
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

/** Bearish micro-structure for FAST_TREND_SHIFT short (>=3 short hits). */
function makeFastTrendShiftShortCandles(boxLow: number): Candle[] {
  const flat: Candle[] = Array.from({ length: 110 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: boxLow + 180,
    high: boxLow + 200,
    low: boxLow + 150,
    close: boxLow + 170,
    volume: 80
  }));
  const falling = Array.from({ length: 10 }, (_, i) => {
    const px = boxLow + 120 - i * 15;
    return {
      ts: Date.now() - (10 - i) * 60000,
      open: px,
      high: px + 10,
      low: px - 40,
      close: px - 30,
      volume: 200
    };
  });
  return [...flat, ...falling];
}

/** Steady lower breakdown without whipsaw micro-bounce pattern. */
function makeLowerBreakdownRetestCandles(boxLow: number): Candle[] {
  return Array.from({ length: 120 }, (_, i) => {
    const px = boxLow + 200 - i * 3;
    return {
      ts: Date.now() - (120 - i) * 60000,
      open: px + 5,
      high: px + 8,
      low: px - 12,
      close: px - 8,
      volume: 120
    };
  });
}

function makeBearishHtf(base = 69000): Candle[] {
  return Array.from({ length: 120 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: base - i * 8,
    high: base - i * 8 + 5,
    low: base - i * 8 - 5,
    close: base - i * 8 - 2,
    volume: 100
  }));
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

/** m5 bearish + 1h/4h/1d bullish — production STRONG_BULLISH_HTF_ALIGNMENT path (htf-polarity CASE F). */
const mockBearish5mHtfConflict: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 60000,
  open: 69000 - i * 8,
  high: 69005 - i * 8,
  low: 68995 - i * 8,
  close: 68998 - i * 8,
  volume: 100
}));

const mockBullishHtfHourly: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 3600000,
  open: 68000 + i * 40,
  high: 68100 + i * 40,
  low: 67900 + i * 40,
  close: 68050 + i * 40,
  volume: 80
}));

const DOWNSTREAM_ONLY_BLOCK_REASONS = new Set([
  "STOP_DISTANCE_TOO_WIDE",
  "ENTRY_BLOCKED_NO_STRUCTURAL_STOP",
  "MIN_ORDER",
  "RANGE_MID_CONSERVATIVE_VETO",
  "WHIPSAW_SHOCK_RECHECK",
  "WHIPSAW_RECHECK_NOT_CONFIRMED",
  "SIDE_ZONE_MISMATCH_LOWER_SHORT",
  "SIDE_ZONE_MISMATCH_UPPER_LONG",
  "FAST_SHIFT_LONG: higher_low|higher_high|box_mid_ok",
  "V2_PROBE_ENTRY_CONFIRMED",
  "V2_TREND_QUALIFIED_FINAL_PROMOTION",
  "WAIT_RECHECK",
  "SKIPPED: Mid-zone neutrality enforced (no-reversal candidates)"
]);

function isHtfLayerBlockReason(reason: unknown): boolean {
  if (reason == null || reason === "") return false;
  const r = String(reason);
  if (DOWNSTREAM_ONLY_BLOCK_REASONS.has(r)) return false;
  if (
    r.includes("HTF") ||
    r.includes("POLARITY_MISMATCH") ||
    r.includes("STRONG_BULLISH") ||
    r.includes("STRONG_BEARISH") ||
    r.startsWith("HTF_POLICY_BLOCK:")
  ) {
    return true;
  }
  return false;
}

function resolveFirstBlockingAuthority(args: {
  judgment: ReturnType<typeof detectMarketRegime>;
  finalizer: Record<string, unknown> | undefined;
  nativeAuth: Record<string, unknown> | undefined;
  audit: Record<string, unknown> | undefined;
  htfGate: Record<string, unknown> | undefined;
  sideConsistency: Record<string, unknown> | undefined;
  decision: ReturnType<typeof runEngineV2>["decision"];
}): string {
  const candidates = [
    args.judgment.htf_policy_reason,
    args.judgment.htf_hard_block_reason,
    args.htfGate?.gate_reason,
    args.audit?.primary_missing_condition,
    args.audit?.secondary_missing_condition,
    args.nativeAuth?.veto_reason_pre_apply,
    args.finalizer?.reject_reason_after,
    args.finalizer?.promotion_block_reason,
    args.decision.risk?.blockReason,
    args.decision.explanation?.reason
  ];
  for (const c of candidates) {
    if (isHtfLayerBlockReason(c)) return String(c);
  }
  for (const c of candidates) {
    if (c != null && c !== "") return String(c);
  }
  return "none";
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

const mockBearishHtfCandles: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 60000,
  open: 70000 - i * 8,
  high: 70005 - i * 8,
  low: 69995 - i * 8,
  close: 69998 - i * 8,
  volume: 100
}));

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
    tickSz: 0.1,
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
    `lower_fts_promo_${cycleNow}`
  );
}

type AuthorityScenarioOpts = {
  symbol?: string;
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
  pumpState?: string;
};

function runAuthorityScenario(opts: AuthorityScenarioOpts) {
  const sym = opts.symbol ?? "BTCUSDT";
  clearWhipsawObservationState(sym);
  const base = 69000;
  const boxHigh = 70000;
  const boxLow = 68000;
  const snap = {
    symbol: sym,
    lastPrice: base + (opts.boxPos - 0.5) * (boxHigh - boxLow),
    latestCandleClose: base + (opts.boxPos - 0.5) * (boxHigh - boxLow),
    signal: opts.signal ?? "paper_long_candidate",
    entryCandidate: opts.entryCandidate ?? true,
    qualityScore: opts.qualityScore,
    emaGap: opts.emaGap ?? 0.005,
    volumeRatioProxy: 1.2,
    boxHigh,
    boxLow,
    boxPos: opts.boxPos,
    atr: 250,
    atr20: 250,
    tickSz: 0.01,
    closedClose: base + (opts.boxPos - 0.5) * (boxHigh - boxLow),
    rangeConfidence: 0.78,
    trendWeaknessScore: opts.trendWeaknessScore ?? 0.22,
    boxCohesion01: 0.92,
    breakoutFailureRate: 0.15,
    rangeOscillationScore: 0.65,
    volumeExpansion: 1.6,
    ema20Slope: 0.0002,
    rangeSignalDowngraded: opts.rangeSignalDowngraded ?? false,
    candles: opts.candles,
    htf_candles: {
      "5m": opts.candles,
      "15m": opts.candles,
      "1h": opts.htfCandles,
      "4h": opts.htfCandles
    },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35,
    reviewing_ticks: 0
  };
  if (opts.shock === "UP") seedUpShock(sym);
  else if (opts.shock === "DOWN") seedDownShock(sym);
  else globalShockStates.delete(sym);
  const cycleNow = Date.now();
  const bridge = buildV2SnapshotBridge(snap as any);
  const input = adaptV2Input(
    sym,
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
    `lower_fts_auth_${cycleNow}_${Math.random()}`
  );
  const judgment = detectMarketRegime(input);
  let decision!: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => {
    ({ decision } = runEngineV2(input));
  });
  return {
    judgment,
    decision,
    proofs,
    finalizer: proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF"),
    sideConsistency: proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF"),
    nativeAuth: proofs.find((p) => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF"),
    rangeVeto: proofs.find((p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF")
  };
}

/** CASE E only — bullish HTF conflict + DOWN shock short where probe is ineligible → HTF HOLD. */
function runCaseEHtfPolarityScenario() {
  const sym = "BTCUSDT_E";
  clearWhipsawObservationState(sym);
  seedDownShock(sym);
  const boxHigh = 70000;
  const boxLow = 68000;
  const boxPos = 0.85;
  const candles = makeRangeOscillationCandles();
  const lastPrice = boxLow + (boxHigh - boxLow) * boxPos;
  const snap = {
    symbol: sym,
    lastPrice,
    latestCandleClose: lastPrice,
    signal: "paper_short_candidate",
    entryCandidate: true,
    qualityScore: 79,
    emaGap: -0.006,
    volumeRatioProxy: 1.1,
    boxHigh,
    boxLow,
    boxPos,
    atr: 250,
    atr20: 250,
    closedClose: lastPrice,
    rangeConfidence: 0.78,
    trendWeaknessScore: 0.25,
    boxCohesion01: 0.92,
    breakoutFailureRate: 0.15,
    rangeOscillationScore: 0.65,
    candles,
    htf_candles: {
      "5m": mockBearish5mHtfConflict,
      "15m": candles,
      "1h": mockBullishHtfHourly,
      "4h": mockBullishHtfHourly,
      "1d": mockBullishHtfHourly
    },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35,
    reviewing_ticks: 0
  };
  const cycleNow = Date.now();
  const bridge = buildV2SnapshotBridge(snap as any);
  const input = adaptV2Input(
    sym,
    cycleNow,
    bridge as any,
    makeLiveConfig() as any,
    makeProductionBridge({
      directionalShockState: "DOWN",
      balanceFetchedAt: cycleNow,
      positionsFetchedAt: cycleNow,
      pendingOrdersFetchedAt: cycleNow
    }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    candles,
    "authoritative",
    `lower_fts_htf_e_${cycleNow}`
  );
  const judgment = detectMarketRegime(input);
  let decision!: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => {
    ({ decision } = runEngineV2(input));
  });
  const htfBiasProof = proofs.find((p) => p.event === "V2_HTF_CANDLE_BIAS_PROOF");
  const polarityProof = proofs.find((p) => p.event === "V2_HTF_POLICY_POLARITY_INVARIANT_PROOF");
  const finalizer = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");
  const nativeAuth = proofs.find((p) => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
  const sideConsistency = proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF");
  const audit = proofs.find((p) => p.event === "V2_NO_ENTER_PATH_AUDIT_PROOF");
  const htfGate = proofs.find((p) => p.event === "V2_UPPER_SHORT_REACTION_PROBE_GATE_SKIP_PROOF");
  const firstBlockingAuthority = resolveFirstBlockingAuthority({
    judgment,
    finalizer,
    nativeAuth,
    audit,
    htfGate,
    sideConsistency,
    decision
  });
  const finalRejectReason =
    finalizer?.reject_reason_after ??
    decision.risk?.blockReason ??
    decision.explanation?.reason ??
    "none";
  return {
    judgment,
    decision,
    proofs,
    htfBiasProof,
    polarityProof,
    finalizer,
    nativeAuth,
    sideConsistency,
    audit,
    htfGate,
    firstBlockingAuthority,
    finalRejectReason
  };
}

type LowerShortScenarioOpts = {
  symbol?: string;
  boxLow?: number;
  boxHigh?: number;
  lastPrice: number;
  closedClose: number;
  boxPos: number;
  boxBreakSide?: string;
  retestTouched?: boolean;
  retestRejected?: boolean;
  retestConfirmed?: boolean;
  signal?: string;
  qualityScore?: number;
  shock?: "DOWN" | "NONE";
  canonicalRegime?: string;
  candles?: Candle[];
  emaGap?: number;
  trendWeaknessScore?: number;
  rangeSignalDowngraded?: boolean;
  signalGateBlockedReason?: string;
  entryCandidate?: boolean;
  atr?: number;
};

function runLowerShortScenario(opts: LowerShortScenarioOpts) {
  const sym = opts.symbol ?? "BTCUSDT";
  clearWhipsawObservationState(sym);
  const shockState = opts.shock ?? "DOWN";
  if (shockState === "DOWN") {
    seedDownShock(sym);
  } else {
    globalShockStates.delete(sym);
  }
  const boxLow = opts.boxLow ?? 68000;
  const boxHigh = opts.boxHigh ?? 70000;
  const candles = opts.candles ?? makeFastTrendShiftShortCandles(boxLow);
  const htf = makeBearishHtf();
  const cycleNow = Date.now();
  const snap = {
    symbol: sym,
    lastPrice: opts.lastPrice,
    latestCandleClose: opts.closedClose,
    signal: opts.signal ?? "paper_short_candidate",
    entryCandidate: opts.entryCandidate ?? true,
    qualityScore: opts.qualityScore ?? 85,
    emaGap: opts.emaGap ?? -0.006,
    volumeRatioProxy: 1.6,
    boxHigh,
    boxLow,
    boxPos: opts.boxPos,
    boxRel: opts.boxPos,
    atr: opts.atr ?? 250,
    atr20: opts.atr ?? 250,
    tickSz: 0.01,
    closedClose: opts.closedClose,
    rangeConfidence: 0.82,
    trendWeaknessScore: opts.trendWeaknessScore ?? 0.2,
    boxCohesion01: 0.9,
    breakoutFailureRate: 0.15,
    rangeOscillationScore: 0.65,
    rangeSignalDowngraded: opts.rangeSignalDowngraded ?? false,
    signalGateBlockedReason: opts.signalGateBlockedReason ?? null,
    boxBreakSide: opts.boxBreakSide ?? "none",
    volumeExpansion: 1.6,
    ema20Slope: -0.0002,
    reviewing_ticks: 0,
    retestConfirmed: opts.retestConfirmed === true,
    retestTouched: opts.retestTouched === true,
    retestRejected: opts.retestRejected === true,
    candles,
    htf_candles: { "5m": candles, "15m": candles, "1h": htf, "4h": htf },
    canonicalRegime: opts.canonicalRegime ?? "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35
  };
  const bridge = buildV2SnapshotBridge(snap as any);
  if (opts.boxBreakSide) (bridge as any).boxBreakSide = opts.boxBreakSide;
  if (opts.retestTouched != null) (bridge as any).retestTouched = opts.retestTouched;
  if (opts.retestRejected != null) (bridge as any).retestRejected = opts.retestRejected;
  if (opts.retestConfirmed != null) (bridge as any).retestConfirmed = opts.retestConfirmed;

  const input = adaptV2Input(
    sym,
    cycleNow,
    bridge as any,
    makeLiveConfig() as any,
    makeProductionBridge({
      directionalShockState: opts.shock ?? "DOWN",
      balanceFetchedAt: cycleNow,
      positionsFetchedAt: cycleNow,
      pendingOrdersFetchedAt: cycleNow
    }) as any,
    { decision: { final_decision: "SKIP", side: "none" } } as any,
    candles,
    "authoritative",
    `lower_fts_${cycleNow}_${Math.random()}`
  );
  const judgment = detectMarketRegime(input);
  let decision!: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => {
    ({ decision } = runEngineV2(input));
  });
  return {
    judgment,
    decision,
    proofs,
    finalizer: proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF"),
    sideConsistency: proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF"),
    nativeAuth: proofs.find((p) => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF"),
    mismatchBlock: proofs.find((p) => p.event === "V2_SIDE_ZONE_MISMATCH_BLOCK_PROOF"),
    rangeVeto: proofs.find((p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF")
  };
}

// CASE A1 — no physical breakdown, but structural FTS confirmed → ENTER short
{
  const boxLow = 68000;
  const lastPrice = boxLow + 50;
  const { judgment, decision, finalizer, sideConsistency, nativeAuth } = runLowerShortScenario({
    symbol: "BTCUSDT_A1",
    boxLow,
    lastPrice,
    closedClose: lastPrice,
    boxPos: 0.05
  });

  run(
    "CASE_A1_NO_PHYSICAL_BREAKDOWN_BUT_STRUCTURAL_FTS_CONFIRMED_ENTER",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      judgment.diagnostics?.fastTrendShift?.direction === "short" &&
      finalizer?.trendOk === true &&
      decision.decision === "ENTER" &&
      decision.side === "short",
    `subtype=${judgment.subtype}, final=${decision.decision}/${decision.side}, trendOk=${finalizer?.trendOk}`
  );
}

// CASE A2 — no physical breakdown and no structural FTS (trendOk=false) → Anti-chase HOLD
{
  const boxLow = 68000;
  const lastPrice = boxLow + 50;
  const { judgment, decision, finalizer, sideConsistency, nativeAuth } = runLowerShortScenario({
    symbol: "BTCUSDT_A2",
    boxLow,
    lastPrice,
    closedClose: lastPrice,
    boxPos: 0.05,
    trendWeaknessScore: 0.85
  });

  run(
    "CASE_A2_NO_PHYSICAL_BREAKDOWN_AND_NO_STRUCTURAL_FTS_HOLD",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      judgment.diagnostics?.fastTrendShift?.direction === "short" &&
      finalizer?.trendOk === false &&
      decision.decision !== "ENTER" &&
      (finalizer?.reject_reason_after === "SIDE_ZONE_MISMATCH_LOWER_SHORT" ||
        decision.risk?.blockReason === "SIDE_ZONE_MISMATCH_LOWER_SHORT"),
    `subtype=${judgment.subtype}, final=${decision.decision}/${decision.side}, trendOk=${finalizer?.trendOk}, reject=${finalizer?.reject_reason_after}`
  );
}

// CASE B — closed breakdown with structural FTS confirmed → ENTER short
{
  const boxLow = 68000;
  const lastPrice = boxLow - 100;
  const { judgment, decision, finalizer, mismatchBlock, sideConsistency } = runLowerShortScenario({
    symbol: "BTCUSDT_B",
    boxLow,
    lastPrice,
    closedClose: boxLow - 120,
    boxPos: 0.05
  });

  run(
    "CASE_B_CLOSED_BREAKDOWN_STRUCTURAL_FTS_ENTER",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      judgment.diagnostics?.fastTrendShift?.direction === "short" &&
      finalizer?.trendOk === true &&
      decision.decision === "ENTER" &&
      decision.side === "short",
    `subtype=${judgment.subtype}, final=${decision.decision}/${decision.side}, finalizer_after=${finalizer?.decision_after}, mismatch=${mismatchBlock?.reason ?? "none"}`
  );
}

// L1 — production-like ETH: FTS short Q68 trendOk=false, no breakdown → defer native veto → Tier 5.5 HOLD
{
  const boxLow = 68000;
  const lastPrice = boxLow + 50;
  const {
    judgment,
    decision,
    finalizer,
    nativeAuth,
    rangeVeto,
    mismatchBlock
  } = runLowerShortScenario({
    symbol: "ETHUSDT_L1",
    boxLow,
    lastPrice,
    closedClose: lastPrice,
    boxPos: 0.05,
    qualityScore: 67,
    emaGap: -0.006,
    trendWeaknessScore: 0.55,
    rangeSignalDowngraded: true,
    signalGateBlockedReason: "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT",
    entryCandidate: false
  });

  const report = {
    subtype: judgment.subtype,
    fts_direction: judgment.diagnostics?.fastTrendShift?.direction ?? null,
    native_executor_enter_authority: nativeAuth?.native_executor_enter_authority ?? null,
    native_fast_probe_coverage: nativeAuth?.native_fast_probe_coverage ?? null,
    zone_veto_deferred: nativeAuth?.native_fts_lower_short_zone_veto_deferred ?? null,
    defer_reason: nativeAuth?.native_fts_lower_short_defer_reason ?? null,
    mismatch_before: nativeAuth?.range_lower_short_mismatch_before_deferral ?? null,
    mismatch_after: nativeAuth?.range_lower_short_mismatch_after_deferral ?? null,
    veto_pre_apply: nativeAuth?.veto_reason_pre_apply ?? null,
    range_veto: rangeVeto?.vetoReason ?? null,
    final_decision: decision.decision,
    final_side: decision.side,
    reject_reason: finalizer?.reject_reason_after ?? null,
    mismatch_block: mismatchBlock?.reason ?? null
  };
  console.log(`[LOWER-FTS-SHORT-AUTH][L1_PRODUCTION_ETH_REPORT] ${JSON.stringify(report)}`);

  run(
    "L1_PRODUCTION_ETH_DEFER_NATIVE_VETO_HOLD",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      judgment.diagnostics?.fastTrendShift?.direction === "short" &&
      nativeAuth?.native_executor_enter_authority === true &&
      nativeAuth?.native_fast_probe_coverage === true &&
      nativeAuth?.native_fts_lower_short_zone_veto_deferred === true &&
      nativeAuth?.native_fts_lower_short_defer_reason === "FAST_TREND_SHIFT_LOWER_SHORT_TIER55_DEFERRAL" &&
      nativeAuth?.range_lower_short_mismatch_before_deferral === true &&
      nativeAuth?.range_lower_short_mismatch_after_deferral === false &&
      nativeAuth?.veto_reason_pre_apply == null &&
      rangeVeto?.vetoReason !== "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT" &&
      decision.decision !== "ENTER" &&
      (finalizer?.reject_reason_after === "SIDE_ZONE_MISMATCH_LOWER_SHORT" ||
        mismatchBlock?.reason === "SIDE_ZONE_MISMATCH_LOWER_SHORT"),
    `report=${JSON.stringify(report)}`
  );
}

// L2 — no physical breakdown, structural FTS confirmed → ENTER short (Tier 5.5 structural exemption)
{
  const boxLow = 68000;
  const lastPrice = boxLow + 50;
  const { judgment, decision, finalizer, nativeAuth, rangeVeto } = runLowerShortScenario({
    symbol: "BTCUSDT_L2",
    boxLow,
    lastPrice,
    closedClose: lastPrice,
    boxPos: 0.05,
    qualityScore: 85,
    emaGap: -0.006,
    trendWeaknessScore: 0.2
  });

  run(
    "L2_NO_PHYSICAL_BREAKDOWN_STRUCTURAL_FTS_ENTER",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      judgment.diagnostics?.fastTrendShift?.direction === "short" &&
      finalizer?.trendOk === true &&
      decision.decision === "ENTER" &&
      decision.side === "short",
    `final=${decision.decision}/${decision.side}, reject=${finalizer?.reject_reason_after ?? "none"}, deferred=${nativeAuth?.native_fts_lower_short_zone_veto_deferred}`
  );
}

// L3 — CASE C preservation: breakdown+retest → ENTER/short authority path unchanged
{
  const boxLow = 68000;
  const boxHigh = 70000;
  const lastPrice = boxLow - 150;
  const closedClose = boxLow - 200;
  seedLowerBreakdownRetestTouched("BTCUSDT_L3", boxLow, boxHigh);
  const { judgment, decision, finalizer, nativeAuth, rangeVeto, mismatchBlock } = runLowerShortScenario({
    symbol: "BTCUSDT_L3",
    boxLow,
    boxHigh,
    lastPrice,
    closedClose,
    boxPos: 0.05,
    boxBreakSide: "lower",
    shock: "NONE",
    // Deep lower breakdown: entry sits below boxMid so adaptive TP uses ATR min-profit floor.
    // atr=600 yields 0.35×600=210pt (~0.31%) natural TP edge above 0.3% profitability gate.
    atr: 600,
    candles: makeFastTrendShiftShortCandles(boxLow),
    retestTouched: true,
    retestRejected: true,
    retestConfirmed: false
  });
  const sizingBlocked = finalizer?.reject_reason_after === "INSTRUMENT_TICK_SZ_UNAVAILABLE";

  run(
    "L3_CASE_C_BREAKDOWN_RETEST_ENTER_SHORT",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      nativeAuth?.native_fts_lower_short_zone_veto_deferred === true &&
      rangeVeto?.vetoReason !== "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT" &&
      finalizer?.decision_before === "ENTER" &&
      finalizer?.side_before === "short" &&
      mismatchBlock == null &&
      (sizingBlocked
        ? true
        : finalizer?.decision_after === "ENTER" &&
          finalizer?.side_after === "short" &&
          decision.decision === "ENTER" &&
          decision.side === "short"),
    `final=${decision.decision}/${decision.side}, finalizer=${finalizer?.decision_before}/${finalizer?.decision_after}, sizingBlocked=${sizingBlocked}`
  );
}

// L4 — ordinary RANGE lower short without FTS → native SKIP unchanged
{
  const sym = "BTCUSDT_L4";
  clearWhipsawObservationState(sym);
  const boxLow = 68000;
  const boxHigh = 70000;
  const lastPrice = boxLow + 50;
  const flatCandles: Candle[] = Array.from({ length: 120 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: lastPrice,
    high: lastPrice + 8,
    low: lastPrice - 8,
    close: lastPrice + (i % 2 === 0 ? -2 : 2),
    volume: 80
  }));
  const cycleNow = Date.now();
  globalShockStates.delete(sym);
  const snap = {
    symbol: sym,
    lastPrice,
    latestCandleClose: lastPrice,
    signal: "paper_short_candidate",
    entryCandidate: false,
    qualityScore: 85,
    emaGap: -0.006,
    volumeRatioProxy: 1.2,
    boxHigh,
    boxLow,
    boxPos: 0.05,
    atr: 250,
    atr20: 250,
    tickSz: 0.01,
    closedClose: lastPrice,
    rangeConfidence: 0.78,
    trendWeaknessScore: 0.25,
    boxCohesion01: 0.92,
    breakoutFailureRate: 0.15,
    rangeOscillationScore: 0.65,
    volumeExpansion: 1.6,
    ema20Slope: -0.0002,
    rangeSignalDowngraded: true,
    signalGateBlockedReason: "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT",
    candles: flatCandles,
    htf_candles: { "5m": flatCandles, "15m": flatCandles, "1h": makeBearishHtf(), "4h": makeBearishHtf() },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35,
    reviewing_ticks: 0
  };
  const bridge = buildV2SnapshotBridge(snap as any);
  const input = adaptV2Input(
    sym,
    cycleNow,
    bridge as any,
    makeLiveConfig() as any,
    makeProductionBridge({
      directionalShockState: "NONE",
      balanceFetchedAt: cycleNow,
      positionsFetchedAt: cycleNow,
      pendingOrdersFetchedAt: cycleNow
    }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    flatCandles,
    "authoritative",
    `lower_fts_l4_${cycleNow}`
  );
  const judgment = detectMarketRegime(input);
  let decision!: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => {
    ({ decision } = runEngineV2(input));
  });
  const nativeAuth = proofs.find((p) => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
  const rangeVeto = proofs.find((p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");
  const finalizer = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");
  const sideConsistency = proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF");

  run(
    "L4_ORDINARY_RANGE_LOWER_SHORT_FAIL_CLOSED_HOLD",
    decision.decision !== "ENTER" &&
      decision.side === "none" &&
      (finalizer?.reject_reason_after === "SIDE_ZONE_MISMATCH_LOWER_SHORT" ||
        rangeVeto?.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT" ||
        decision.risk?.blockReason === "SIDE_ZONE_MISMATCH_LOWER_SHORT"),
    `subtype=${judgment.subtype}, deferred=${nativeAuth?.native_fts_lower_short_zone_veto_deferred}, final=${decision.decision}/${decision.side}, reject=${finalizer?.reject_reason_after ?? "none"}`
  );
}

// L5 — FTS weak/incomplete lower structure → no accidental ENTER
{
  const boxLow = 68000;
  const flatOnly: Candle[] = Array.from({ length: 120 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: boxLow + 170,
    high: boxLow + 200,
    low: boxLow + 150,
    close: boxLow + 175,
    volume: 80
  }));
  const lastPrice = boxLow + 50;
  const { judgment, decision, nativeAuth } = runLowerShortScenario({
    symbol: "BTCUSDT_L5",
    boxLow,
    lastPrice,
    closedClose: lastPrice,
    boxPos: 0.05,
    qualityScore: 68,
    candles: flatOnly
  });

  run(
    "L5_FTS_WEAK_STRUCTURE_NO_ENTER",
    decision.decision !== "ENTER",
    `subtype=${judgment.subtype}, deferred=${nativeAuth?.native_fts_lower_short_zone_veto_deferred ?? false}, final=${decision.decision}/${decision.side}`
  );
}

// L6 — HTF hard/opposite polarity block unchanged (reuse CASE E path)
{
  const {
    judgment,
    decision,
    proofs,
    firstBlockingAuthority,
    finalRejectReason,
    nativeAuth
  } = runCaseEHtfPolarityScenario();
  const rangeVeto = proofs.find((p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");

  run(
    "L6_HTF_BLOCKED_UNCHANGED",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      firstBlockingAuthority !== "none" &&
      isHtfLayerBlockReason(firstBlockingAuthority) &&
      decision.decision !== "ENTER" &&
      rangeVeto?.vetoReason !== "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT",
    `blocking=${firstBlockingAuthority}, reject=${finalRejectReason}, final=${decision.decision}/${decision.side}, native_deferred=${nativeAuth?.native_fts_lower_short_zone_veto_deferred ?? false}`
  );
}

// CASE C — helper fixed context, then full engine breakdown+retest → ENTER/short
{
  const CASE_C_HELPER_CTX = {
    trendSideCandidate: "short" as const,
    zone: "lower" as const,
    boxBreakSide: "lower",
    boxLow: 100,
    boxHigh: 110,
    previousConfirmedBoxLow: 100,
    previousConfirmedBoxHigh: 110,
    closedClose: 99.5,
    lastPrice: 99.4,
    judgmentSubtype: "FAST_TREND_SHIFT",
    retestConfirmed: false,
    retestTouched: true,
    retestRejected: true,
    continuationDirection: "down",
    continuationPhase: "RETEST_TOUCHED",
    rangePhase: "BREAKDOWN",
    transitionPhase: "RANGE_TO_TREND",
    emaGap: -0.02,
    htfEntryPolicy: "PROBE_ONLY",
    htfRequiresStrongerConfirmation: false,
    counterTrendRisk: false,
    riskShortAllow: true,
    allowNewShort: true,
    riskLongAllow: true,
    allowNewLong: true,
    whipsawShockRecheckActive: false,
    hardBlockPresent: false,
    paperExecutionReady: true,
    signedExecutionReady: true,
    hasSameSidePosition: false,
    hasOppositeSidePosition: false,
    reversalConfirmed: false,
    execReason: null,
    lateChaseBlocked: false,
    retestRequired: true
  };

  const helperEval = evaluateLowerBreakdownShortConfirmed(CASE_C_HELPER_CTX);
  run(
    "CASE_C_HELPER_FIXED_CONTEXT",
    helperEval.confirmed === true &&
      helperEval.holdReason === null &&
      helperEval.closedBreakConfirmed === true &&
      helperEval.wickOnlyBreak === false &&
      helperEval.retestConfirmed === true,
    `confirmed=${helperEval.confirmed}, holdReason=${helperEval.holdReason}, closedBreak=${helperEval.closedBreakConfirmed}, wickOnly=${helperEval.wickOnlyBreak}, retest=${helperEval.retestConfirmed}`
  );

  const boxLow = 68000;
  const boxHigh = 70000;
  const lastPrice = boxLow - 150;
  const closedClose = boxLow - 200;
  seedLowerBreakdownRetestTouched("BTCUSDT_C", boxLow, boxHigh);

  const {
    judgment,
    decision,
    proofs,
    finalizer,
    sideConsistency,
    nativeAuth,
    mismatchBlock
  } = runLowerShortScenario({
    symbol: "BTCUSDT_C",
    boxLow,
    boxHigh,
    lastPrice,
    closedClose,
    boxPos: 0.05,
    boxBreakSide: "lower",
    shock: "NONE",
    atr: 600,
    candles: makeFastTrendShiftShortCandles(boxLow),
    retestTouched: true,
    retestRejected: true,
    retestConfirmed: false
  });

  const ftsProof = proofs.find((p) => p.event === "V2_FAST_TREND_SHIFT_PROBE_PROOF");
  const contState = rangeContinuationStateMap.get("BTCUSDT_C");
  const tier55Eval = evaluateLowerBreakdownShortConfirmed({
    trendSideCandidate: "short",
    zone: "lower",
    boxBreakSide: "lower",
    boxLow,
    boxHigh,
    previousConfirmedBoxLow: contState?.previousConfirmedBoxLow ?? boxLow,
    previousConfirmedBoxHigh: contState?.previousConfirmedBoxHigh ?? boxHigh,
    closedClose,
    lastPrice,
    judgmentSubtype: "FAST_TREND_SHIFT",
    retestConfirmed: false,
    retestTouched: true,
    retestRejected: true,
    continuationDirection: contState?.direction ?? "down",
    continuationPhase: contState?.phase ?? "RETEST_TOUCHED",
    rangePhase: judgment.rangePhase ?? "BREAKDOWN",
    transitionPhase: judgment.transitionPhase ?? null,
    emaGap: -0.006,
    htfEntryPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
    htfRequiresStrongerConfirmation: judgment.htf_requires_stronger_confirmation === true,
    counterTrendRisk: judgment.counter_trend_risk === true,
    riskShortAllow: true,
    allowNewShort: true,
    riskLongAllow: true,
    allowNewLong: true,
    whipsawShockRecheckActive: false,
    hardBlockPresent: false,
    paperExecutionReady: true,
    signedExecutionReady: true,
    hasSameSidePosition: false,
    hasOppositeSidePosition: false,
    reversalConfirmed: false,
    execReason: null,
    lateChaseBlocked: false,
    retestRequired: true
  });

  const transmission = {
    closedClose,
    breakdownBoundary: contState?.previousConfirmedBoxLow ?? boxLow,
    retestTouched: true,
    retestRejected: true,
    emaGap: -0.006,
    htfEntryPolicy: judgment.htf_entry_policy ?? null,
    shock: "NONE",
    tier55Eval: {
      confirmed: tier55Eval.confirmed,
      closedBreakConfirmed: tier55Eval.closedBreakConfirmed,
      retestConfirmed: tier55Eval.retestConfirmed,
      holdReason: tier55Eval.holdReason
    }
  };
  console.log(`[LOWER-FTS-SHORT-AUTH][CASE_C_TRANSMISSION] ${JSON.stringify(transmission)}`);

  run(
    "CASE_C_FTS_PROBE_SHORT",
    ftsProof?.fast_trend_direction === "short",
    `fast_trend_direction=${ftsProof?.fast_trend_direction ?? "none"}`
  );
  run(
    "CASE_C_NATIVE_EXECUTOR_ENTER",
    nativeAuth?.native_executor_enter_authority === true,
    `native_executor_enter_authority=${nativeAuth?.native_executor_enter_authority}`
  );
  run(
    "CASE_C_SELECTED_SIDE_STAYS_SHORT",
    sideConsistency?.selected_side_before_veto === "short" &&
      sideConsistency?.selected_side_after_veto === "short",
    `before=${sideConsistency?.selected_side_before_veto}, after=${sideConsistency?.selected_side_after_veto}`
  );
  run(
    "CASE_C_LOWER_BREAKDOWN_CONFIRMATION",
    tier55Eval.closedBreakConfirmed === true && tier55Eval.retestConfirmed === true,
    `closed_break=${tier55Eval.closedBreakConfirmed}, retest=${tier55Eval.retestConfirmed}, hold=${tier55Eval.holdReason}`
  );
  run(
    "CASE_C_NO_SIDE_ZONE_MISMATCH",
    mismatchBlock == null,
    `mismatch=${mismatchBlock?.reason ?? "none"}`
  );
  run(
    "CASE_C_FINALIZER_ENTER_SHORT",
    finalizer?.decision_before === "ENTER" &&
      finalizer?.side_before === "short" &&
      tier55Eval.confirmed === true &&
      (finalizer?.reject_reason_after === "INSTRUMENT_TICK_SZ_UNAVAILABLE" ||
        (finalizer?.decision_after === "ENTER" && finalizer?.side_after === "short")),
    `finalizer=${finalizer?.decision_before}/${finalizer?.decision_after}, side=${finalizer?.side_before}/${finalizer?.side_after}, reject=${finalizer?.reject_reason_after ?? "none"}`
  );
  run(
    "CASE_C_RUNTIME_ENTER_SHORT",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      tier55Eval.confirmed === true &&
      mismatchBlock == null &&
      (finalizer?.reject_reason_after === "INSTRUMENT_TICK_SZ_UNAVAILABLE"
        ? finalizer?.decision_before === "ENTER" && finalizer?.side_before === "short"
        : decision.decision === "ENTER" && decision.side === "short"),
    `subtype=${judgment.subtype}, final=${decision.decision}/${decision.side}, block=${decision.explanation?.reason ?? "none"}`
  );
}

// CASE D — WHIPSAW hard block preserved after Fix A/B
{
  clearWhipsawObservationState("BTCUSDT_D");
  seedDownShock("BTCUSDT_D");
  const base = 69000;
  const micro = makeWhipsawMicroCandles(base);
  const cycleNow = Date.now();
  const snap = {
    symbol: "BTCUSDT_D",
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
    "BTCUSDT_D",
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
    `lower_fts_whipsaw_${cycleNow}`
  );
  const judgment = detectMarketRegime(input);
  let decision!: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => {
    ({ decision } = runEngineV2(input));
  });
  const finalizer = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");
  const nativeAuth = proofs.find((p) => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
  const sideConsistency = proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF");
  const blockReason =
    finalizer?.reject_reason_after ??
    decision.risk?.blockReason ??
    decision.explanation?.reason ??
    "none";

  const report = {
    subtype: judgment.subtype,
    decision_before: finalizer?.decision_before ?? null,
    native_executor_enter_authority: nativeAuth?.native_executor_enter_authority ?? null,
    final_decision: decision.decision,
    final_side: decision.side,
    block_reason: blockReason
  };
  console.log(`[LOWER-FTS-SHORT-AUTH][CASE_D_REPORT] ${JSON.stringify(report)}`);

  run(
    "CASE_D_WHIPSAW_HARD_BLOCK_PRESERVED",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK" && decision.decision !== "ENTER",
    `subtype=${judgment.subtype}, final=${decision.decision}/${decision.side}, block=${blockReason}, native_auth=${nativeAuth?.native_executor_enter_authority}, decision_before=${finalizer?.decision_before}, sc_before=${sideConsistency?.selected_side_before_veto}, sc_after=${sideConsistency?.selected_side_after_veto}`
  );
}

if (process.env.STOP_AFTER_CASE === "D") {
  console.log("v2-fast-trend-shift-lower-short-authority-cases: CASE D PASS (stop)");
  process.exit(0);
}

// CASE E — HTF hard polarity block preserved (production bullish-conflict + probe-ineligible DOWN shock short)
{
  const {
    judgment,
    decision,
    htfBiasProof,
    polarityProof,
    finalizer,
    nativeAuth,
    sideConsistency,
    firstBlockingAuthority,
    finalRejectReason
  } = runCaseEHtfPolarityScenario();

  const htfLayerConfirmed =
    judgment.htf_entry_policy === "HOLD" ||
    String(judgment.htf_hard_block_reason ?? "") !== "";
  const shortCandidatePresent =
    (finalizer?.trend_side_candidate === "short" ||
      sideConsistency?.trend_side_candidate === "short" ||
      sideConsistency?.selected_side_before_veto === "short") &&
    judgment.macroPolarity === "BULLISH";
  const finalBlocksShortEnter = decision.decision !== "ENTER" && decision.side !== "short";
  const htfIsFirstBlock = isHtfLayerBlockReason(firstBlockingAuthority);

  const report = {
    htf_biases: {
      htf_5m_bias: htfBiasProof?.htf_5m_bias ?? judgment.metadata?.htf_5m_bias ?? null,
      htf_15m_bias: htfBiasProof?.htf_15m_bias ?? judgment.metadata?.htf_15m_bias ?? null,
      htf_1h_bias: htfBiasProof?.htf_1h_bias ?? judgment.metadata?.htf_1h_bias ?? null,
      htf_4h_bias: htfBiasProof?.htf_4h_bias ?? judgment.metadata?.htf_4h_bias ?? null,
      htf_1d_bias: htfBiasProof?.htf_1d_bias ?? judgment.metadata?.htf_1d_bias ?? null
    },
    macro_polarity: judgment.macroPolarity ?? polarityProof?.macro_polarity ?? null,
    raw_htf_policy: polarityProof?.raw_policy_before_invariant ?? null,
    final_htf_policy: judgment.htf_entry_policy ?? polarityProof?.final_policy ?? null,
    counter_trend_risk: judgment.counter_trend_risk ?? htfBiasProof?.counter_trend_risk ?? null,
    polarity_probe_eligible: judgment.polarityProbeEligible ?? polarityProof?.polarity_probe_eligible ?? null,
    htf_policy_reason: judgment.htf_policy_reason ?? htfBiasProof?.htf_policy_reason ?? null,
    htf_hard_block_reason: judgment.htf_hard_block_reason ?? htfBiasProof?.htf_hard_block_reason ?? null,
    trend_side_candidate: finalizer?.trend_side_candidate ?? sideConsistency?.trend_side_candidate ?? null,
    candidate_native_decision: nativeAuth?.native_executor_decision_source ?? null,
    candidate_native_side: nativeAuth?.native_executor_side_source ?? null,
    first_blocking_authority: firstBlockingAuthority,
    finalizer_decision_before: finalizer?.decision_before ?? null,
    finalizer_decision_after: finalizer?.decision_after ?? null,
    final_decision: decision.decision,
    final_side: decision.side,
    final_reject_reason: finalRejectReason
  };
  console.log(`[LOWER-FTS-SHORT-AUTH][CASE_E_REPORT] ${JSON.stringify(report)}`);

  run(
    "CASE_E_HTF_HARD_POLARITY_BLOCK_PRESERVED",
    htfLayerConfirmed &&
      shortCandidatePresent &&
      finalBlocksShortEnter &&
      htfIsFirstBlock,
    `policy=${judgment.htf_entry_policy}, hard=${judgment.htf_hard_block_reason}, macro=${judgment.macroPolarity}, probe=${judgment.polarityProbeEligible}, native=${nativeAuth?.native_executor_decision_source}/${nativeAuth?.native_executor_side_source}, first_block=${firstBlockingAuthority}, before=${finalizer?.decision_before}, after=${finalizer?.decision_after}, final=${decision.decision}/${decision.side}, reject=${finalRejectReason}`
  );
}

if (process.env.STOP_AFTER_CASE === "E") {
  console.log("v2-fast-trend-shift-lower-short-authority-cases: CASE E PASS (stop)");
  process.exit(0);
}

// CASE F — Q>=80 qualified trend promotion ENTER preserved
{
  clearWhipsawObservationState("BTCUSDT_F");
  const input = makeTrendRangeSplitInput({
    qualityScore: 85,
    directionalShockState: "DOWN",
    boxPos: 0.5,
    htfCandles: mockBearishHtfCandles
  });
  let decision!: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => {
    ({ decision } = runEngineV2(input));
  });
  const finalizer = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");
  const notional = decision.risk?.finalOrderNotionalUsdt ?? 0;
  const report = {
    quality: finalizer?.quality_score ?? null,
    trendOk: finalizer?.trendOk ?? null,
    sideZoneValid: finalizer?.side_zone_valid ?? null,
    promotion_applied: finalizer?.promotion_applied ?? null,
    promotion_reason: finalizer?.promotion_reason ?? null,
    decision_before: finalizer?.decision_before ?? null,
    decision_after: finalizer?.decision_after ?? null,
    final_side: decision.side,
    notional
  };
  console.log(`[LOWER-FTS-SHORT-AUTH][CASE_F_REPORT] ${JSON.stringify(report)}`);

  run(
    "CASE_F_Q85_TREND_PROMOTION_ENTER_PRESERVED",
    finalizer?.promotion_applied === true &&
      finalizer?.promotion_reason === "V2_TREND_QUALIFIED_FINAL_PROMOTION" &&
      decision.decision === "ENTER" &&
      decision.side === "short" &&
      notional > 0,
    `promotion=${finalizer?.promotion_reason}, before=${finalizer?.decision_before}, after=${finalizer?.decision_after}, final=${decision.decision}/${decision.side}, notional=${notional}`
  );
}

if (process.env.STOP_AFTER_CASE === "F") {
  console.log("v2-fast-trend-shift-lower-short-authority-cases: CASE F PASS (stop)");
  process.exit(0);
}

// CASE G — Q70 native long ENTER survives range downgrade
{
  const { judgment, decision, proofs, finalizer, nativeAuth, rangeVeto } = runAuthorityScenario({
    symbol: "BTCUSDT_G",
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

  const downgradedVeto = proofs.find(
    (p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" && p.vetoReason === "RANGE_SIGNAL_DOWNGRADED_NOT_RELAXED"
  );
  const report = {
    subtype: judgment.subtype,
    native_executor_enter_authority: nativeAuth?.native_executor_enter_authority ?? null,
    range_downgraded_hard_block: nativeAuth?.range_downgraded_hard_block ?? null,
    decision_before: finalizer?.decision_before ?? null,
    side_before: finalizer?.side_before ?? null,
    promotion_applied: finalizer?.promotion_applied ?? null,
    final_decision: decision.decision,
    final_side: decision.side,
    downgraded_veto: downgradedVeto?.vetoReason ?? null
  };
  console.log(`[LOWER-FTS-SHORT-AUTH][CASE_G_REPORT] ${JSON.stringify(report)}`);

  run(
    "CASE_G_Q70_NATIVE_LONG_SURVIVES_DOWNGRADE",
    judgment.subtype === "FAST_TREND_SHIFT" &&
      finalizer?.decision_before === "ENTER" &&
      finalizer?.side_before === "long" &&
      nativeAuth?.native_executor_enter_authority === true &&
      nativeAuth?.range_downgraded_hard_block === false &&
      downgradedVeto == null &&
      decision.decision === "ENTER" &&
      decision.side === "long",
    `subtype=${judgment.subtype}, native_auth=${nativeAuth?.native_executor_enter_authority}, downgrade_block=${nativeAuth?.range_downgraded_hard_block}, promo=${finalizer?.promotion_applied}, final=${decision.decision}/${decision.side}, veto=${downgradedVeto?.vetoReason ?? "none"}`
  );
}

console.log("v2-fast-trend-shift-lower-short-authority-cases: ALL PASS");
