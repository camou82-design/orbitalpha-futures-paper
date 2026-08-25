/**
 * HTF polarity entry authority — A+C fix regressions.
 *
 * A. DOWN/short Q85 bullish HTF → ENTER short survives, notional = baseline × 0.5
 * B. Q95/S → still 0.5 probe, full-size forbidden
 * C. Q79 → no ENTER
 * D. trendOk=false → no ENTER
 * E. shock/candidate direction mismatch → no ENTER
 * F. strong opposite HTF without structural confirmation → HOLD
 * G. WHIPSAW hard active → probe blocked
 * H. HTF aligned short → full sizing, no 0.5 multiplier
 * I. polarityMismatch=true + PROBE_ONLY + 0.5 sizing coexist in production proof
 */

import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { resolveSymbolDecisionEnvelope } from "../engine-v2/reconciler";
import { globalShockStates } from "../engine-v2/state/derive";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";

function run(label: string, passed: boolean, detail: string): void {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[HTF-POLARITY][${label}] ${tag} — ${detail}`);
  if (!passed) throw new Error(`[HTF-POLARITY][${label}] FAILED: ${detail}`);
}

function captureProofLogs(fn: () => void): Record<string, unknown>[] {
  const proofLogs: Record<string, unknown>[] = [];
  const origInfo = console.info;
  console.info = (msg: unknown) => {
    try {
      const parsed = JSON.parse(String(msg));
      if (parsed && typeof parsed.event === "string") proofLogs.push(parsed);
    } catch {
      /* ignore */
    }
    origInfo(msg);
  };
  try {
    fn();
  } finally {
    console.info = origInfo;
  }
  return proofLogs;
}

const mockBearish5m: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 60000,
  open: 69000 - i * 8,
  high: 69005 - i * 8,
  low: 68995 - i * 8,
  close: 68998 - i * 8,
  volume: 100
}));

const mockBullishHtf: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 3600000,
  open: 68000 + i * 40,
  high: 68100 + i * 40,
  low: 67900 + i * 40,
  close: 68050 + i * 40,
  volume: 80
}));

const mockBearishHtf: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 3600000,
  open: 72000 - i * 40,
  high: 72100 - i * 40,
  low: 71900 - i * 40,
  close: 71950 - i * 40,
  volume: 80
}));

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
      profit: { qualityScoreAvg: 90, emaGapAvg: -0.005, atrPctAvg: 0.01, volumeRatioAvg: 1.2, count: 8 },
      loss: { qualityScoreAvg: 55, emaGapAvg: 0.001, atrPctAvg: 0.01, volumeRatioAvg: 0.9, count: 2 },
      contaminated: { qualityScoreAvg: 60, emaGapAvg: 0.002, atrPctAvg: 0.01, volumeRatioAvg: 1.0, count: 1 }
    },
    ...overrides
  };
}

function makeMicroDownReboundCandles(basePrice = 69000): Candle[] {
  const flat: Candle[] = Array.from({ length: 112 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: basePrice,
    high: basePrice + 50,
    low: basePrice - 50,
    close: basePrice,
    volume: 100
  }));
  const tail: Array<{ o: number; h: number; l: number; c: number }> = [
    { o: basePrice, h: basePrice + 100, l: basePrice - 100, c: basePrice - 50 },
    { o: basePrice - 50, h: basePrice, l: basePrice - 800, c: basePrice - 750 },
    { o: basePrice - 750, h: basePrice - 600, l: basePrice - 760, c: basePrice - 650 },
    { o: basePrice - 650, h: basePrice - 500, l: basePrice - 660, c: basePrice - 550 },
    { o: basePrice - 550, h: basePrice - 400, l: basePrice - 560, c: basePrice - 450 },
    { o: basePrice - 450, h: basePrice - 300, l: basePrice - 460, c: basePrice - 350 },
    { o: basePrice - 350, h: basePrice - 200, l: basePrice - 360, c: basePrice - 250 },
    { o: basePrice - 250, h: basePrice + 100, l: basePrice - 260, c: basePrice - 80 }
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

function makeMicroUpThenDropCandles(basePrice = 69000): Candle[] {
  const flat: Candle[] = Array.from({ length: 112 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: basePrice,
    high: basePrice + 50,
    low: basePrice - 50,
    close: basePrice,
    volume: 100
  }));
  const tail: Array<{ o: number; h: number; l: number; c: number }> = [
    { o: basePrice, h: basePrice + 100, l: basePrice - 100, c: basePrice + 50 },
    { o: basePrice + 50, h: basePrice + 800, l: basePrice, c: basePrice + 750 },
    { o: basePrice + 750, h: basePrice + 760, l: basePrice + 600, c: basePrice + 650 },
    { o: basePrice + 650, h: basePrice + 660, l: basePrice + 500, c: basePrice + 550 },
    { o: basePrice + 550, h: basePrice + 560, l: basePrice + 400, c: basePrice + 450 },
    { o: basePrice + 450, h: basePrice + 460, l: basePrice + 300, c: basePrice + 350 },
    { o: basePrice + 350, h: basePrice + 360, l: basePrice + 200, c: basePrice + 250 },
    { o: basePrice + 250, h: basePrice + 260, l: basePrice - 100, c: basePrice + 80 }
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

type ProbeInputOpts = {
  qualityScore: number;
  boxPos: number;
  directionalShockState: "DOWN" | "UP" | "NONE";
  htfMode: "bullish_conflict" | "bearish_aligned";
  emaGap?: number;
  trendWeaknessScore?: number;
  candidateStrength?: string;
  breakoutFailureRate?: number;
  volumeExpansion?: number;
};

function makeProbeInput(opts: ProbeInputOpts) {
  const base = 69000;
  const boxHigh = 70000;
  const boxLow = 68000;
  const candles = makeRangeOscillationCandles(base);
  const htfPack = opts.htfMode === "bullish_conflict" ? mockBullishHtf : mockBearishHtf;
  const snap = {
    symbol: "BTCUSDT",
    lastPrice: base,
    latestCandleClose: base,
    signal: "paper_short_candidate",
    entryCandidate: true,
    qualityScore: opts.qualityScore,
    candidateStrength: opts.candidateStrength ?? (opts.qualityScore >= 90 ? "strong" : "normal"),
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
    trendWeaknessScore: opts.trendWeaknessScore ?? 0.25,
    boxCohesion01: 0.92,
    breakoutFailureRate: opts.breakoutFailureRate ?? 0.15,
    rangeOscillationScore: 0.65,
    volumeExpansion: opts.volumeExpansion,
    candles,
    htf_candles: {
      "5m": mockBearish5m,
      "15m": candles,
      "1h": htfPack,
      "4h": htfPack,
      "1d": htfPack
    },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35,
    reviewing_ticks: 0
  };

  if (opts.directionalShockState === "DOWN") seedDownShock("BTCUSDT");
  else if (opts.directionalShockState === "UP") seedUpShock("BTCUSDT");
  else globalShockStates.delete("BTCUSDT");

  const bridge = buildV2SnapshotBridge(snap as any);
  return adaptV2Input(
    "BTCUSDT",
    Date.now(),
    bridge as any,
    makeLiveConfig() as any,
    makeProductionBridge({ directionalShockState: opts.directionalShockState }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    candles,
    "authoritative",
    `htf_polarity_${Date.now()}_${Math.random()}`
  );
}

function runProbeScenario(opts: ProbeInputOpts) {
  clearWhipsawObservationState("BTCUSDT");
  const input = makeProbeInput(opts);
  const judgment = detectMarketRegime(input);
  let decision: ReturnType<typeof runEngineV2>["decision"];
  let internal: ReturnType<typeof runEngineV2>["internal"];
  const proofs = captureProofLogs(() => {
    ({ decision, internal } = runEngineV2(input));
  });
  return { input, judgment, decision: decision!, internal: internal!, proofs };
}

// CASE H baseline — HTF aligned bearish short (full sizing reference)
let alignedBaselineNotional = 0;
{
  const { judgment, decision } = runProbeScenario({
    qualityScore: 85,
    boxPos: 0.5,
    directionalShockState: "DOWN",
    htfMode: "bearish_aligned"
  });

  alignedBaselineNotional = decision.risk?.finalOrderNotionalUsdt ?? 0;

  run(
    "CASE_H_ALIGNED_SHORT_FULL_SIZING",
    decision.decision === "ENTER" &&
      decision.side === "short" &&
      alignedBaselineNotional > 0 &&
      (judgment.htf_size_multiplier ?? 1) >= 1 &&
      judgment.polarityProbeEligible !== true,
    `decision=${decision.decision}, notional=${alignedBaselineNotional}, htf_mult=${judgment.htf_size_multiplier}, probe=${judgment.polarityProbeEligible}`
  );
}

// CASE A — production-shaped DOWN/short Q85 bullish HTF → probe ENTER at 0.5× baseline
{
  const { judgment, decision, proofs } = runProbeScenario({
    qualityScore: 85,
    boxPos: 0.5,
    directionalShockState: "DOWN",
    htfMode: "bullish_conflict"
  });

  const finalizer = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");
  const polarityProof = proofs.find((p) => p.event === "V2_HTF_POLICY_POLARITY_INVARIANT_PROOF");
  const probeNotional = decision.risk?.finalOrderNotionalUsdt ?? 0;
  const ratio = alignedBaselineNotional > 0 ? probeNotional / alignedBaselineNotional : 0;

  run(
    "CASE_A_DETECTOR_PROBE_ONLY_WITH_MISMATCH_PRESERVED",
    judgment.polarityMismatch === true &&
      judgment.polarityProbeEligible === true &&
      judgment.htf_entry_policy === "PROBE_ONLY" &&
      judgment.htf_size_multiplier === 0.5 &&
      judgment.htf_requires_stronger_confirmation === true &&
      String(judgment.htf_policy_reason ?? "").includes("POLARITY_PROBE_ONLY_SHORT_SHOCK"),
    `mismatch=${judgment.polarityMismatch}, probe=${judgment.polarityProbeEligible}, policy=${judgment.htf_entry_policy}, mult=${judgment.htf_size_multiplier}`
  );

  run(
    "CASE_A_ENTER_SURVIVES_POLARITY_GATE",
    finalizer?.decision_after === "ENTER" &&
      finalizer?.side_after === "short" &&
      decision.decision === "ENTER" &&
      decision.side === "short" &&
      finalizer?.reject_reason_after !== "HTF_POLICY_POLARITY_MISMATCH" &&
      decision.metadata?.promotion_block_reason !== "HTF_POLICY_POLARITY_MISMATCH",
    `before=${finalizer?.decision_before}/${finalizer?.side_before}, after=${finalizer?.decision_after}/${finalizer?.side_after}, block=${finalizer?.promotion_block_reason ?? "none"}`
  );

  run(
    "CASE_A_FINAL_NOTIONAL_HALF_BASELINE",
    probeNotional > 0 &&
      alignedBaselineNotional > 0 &&
      Math.abs(ratio - 0.5) < 0.06,
    `probe=${probeNotional}, baseline=${alignedBaselineNotional}, ratio=${ratio.toFixed(4)}`
  );

  run(
    "CASE_A_HTF_MULTIPLIER_APPLIED_ONCE",
    probeNotional > 0 &&
      alignedBaselineNotional > 0 &&
      Math.abs(ratio - 0.5) < 0.06 &&
      probeNotional < alignedBaselineNotional * 0.75,
    `probe=${probeNotional}, baseline=${alignedBaselineNotional}, ratio=${ratio.toFixed(4)}`
  );

  run(
    "CASE_A_RECONCILER_PASSES_PROBE_ONLY",
    polarityProof?.polarity_probe_eligible === true &&
      polarityProof?.final_policy === "PROBE_ONLY",
    `invariant_policy=${polarityProof?.final_policy}, probe_eligible=${polarityProof?.polarity_probe_eligible}`
  );
}

// CASE B — Q95/S still capped at 0.5 probe (not full)
{
  const { judgment, decision } = runProbeScenario({
    qualityScore: 95,
    boxPos: 0.55,
    directionalShockState: "DOWN",
    htfMode: "bullish_conflict",
    candidateStrength: "strong"
  });

  const probeNotional = decision.risk?.finalOrderNotionalUsdt ?? 0;
  const ratio = alignedBaselineNotional > 0 ? probeNotional / alignedBaselineNotional : 0;

  run(
    "CASE_B_Q95_STILL_PROBE_ONLY_HALF",
    decision.decision === "ENTER" &&
      judgment.htf_entry_policy === "PROBE_ONLY" &&
      judgment.htf_size_multiplier === 0.5 &&
      probeNotional > 0 &&
      Math.abs(ratio - 0.5) < 0.06 &&
      probeNotional < alignedBaselineNotional * 0.75,
    `Q=95, notional=${probeNotional}, baseline=${alignedBaselineNotional}, ratio=${ratio.toFixed(4)}`
  );
}

// CASE C — Q79 → no ENTER
{
  const { judgment, decision } = runProbeScenario({
    qualityScore: 79,
    boxPos: 0.5,
    directionalShockState: "DOWN",
    htfMode: "bullish_conflict"
  });

  run(
    "CASE_C_Q79_NO_ENTER",
    decision.decision !== "ENTER" &&
      judgment.polarityProbeEligible !== true &&
      (judgment.htf_entry_policy === "HOLD" || decision.side === "none"),
    `Q=79, decision=${decision.decision}, probe=${judgment.polarityProbeEligible}, policy=${judgment.htf_entry_policy}`
  );
}

// CASE D — trendOk=false → no ENTER
{
  const { judgment, decision } = runProbeScenario({
    qualityScore: 85,
    boxPos: 0.5,
    directionalShockState: "DOWN",
    htfMode: "bullish_conflict",
    emaGap: 0.003,
    trendWeaknessScore: 0.65
  });

  run(
    "CASE_D_TREND_NOT_OK_NO_ENTER",
    decision.decision !== "ENTER" &&
      judgment.polarityProbeEligible !== true,
    `decision=${decision.decision}, probe=${judgment.polarityProbeEligible}, policy=${judgment.htf_entry_policy}`
  );
}

// CASE E — UP shock vs short candidate mismatch → no polarity probe / no short ENTER authority
{
  const { judgment, decision, input } = runProbeScenario({
    qualityScore: 85,
    boxPos: 0.5,
    directionalShockState: "UP",
    htfMode: "bullish_conflict"
  });

  const envelope = resolveSymbolDecisionEnvelope({
    symbol: "BTCUSDT" as any,
    fetchedAt: Date.now(),
    snapshot: buildV2SnapshotBridge(input.snapshot as any),
    config: makeLiveConfig() as any,
    state: makeProductionBridge({ directionalShockState: "UP" }) as any,
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
    runCycleId: `htf_polarity_case_e_${Date.now()}`
  });

  run(
    "CASE_E_SHOCK_CANDIDATE_MISMATCH_NO_PROBE",
    judgment.polarityProbeEligible !== true &&
      judgment.shockPhase === "UP_SHOCK" &&
      judgment.htf_entry_policy === "LONG_ONLY_OR_NONE" &&
      !(envelope.authority.decision === "ENTER" && envelope.authority.side === "short"),
    `shock=${judgment.shockPhase}, policy=${judgment.htf_entry_policy}, probe=${judgment.polarityProbeEligible}, authority=${envelope.authority.decision}/${envelope.authority.side}, engine=${decision.decision}/${decision.side}`
  );
}

// CASE F — strong bullish HTF without shock structural path → HOLD (no contrarian short)
{
  const { judgment, decision, input } = runProbeScenario({
    qualityScore: 82,
    boxPos: 0.5,
    directionalShockState: "NONE",
    htfMode: "bullish_conflict"
  });

  const envelope = resolveSymbolDecisionEnvelope({
    symbol: "BTCUSDT" as any,
    fetchedAt: Date.now(),
    snapshot: buildV2SnapshotBridge(input.snapshot as any),
    config: makeLiveConfig() as any,
    state: makeProductionBridge({ directionalShockState: "NONE" }) as any,
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
    runCycleId: `htf_polarity_case_f_${Date.now()}`
  });

  run(
    "CASE_F_STRONG_OPPOSITE_HTF_NO_STRUCTURAL_HOLD",
    judgment.polarityProbeEligible !== true &&
      judgment.htf_entry_policy === "HOLD" &&
      String(judgment.htf_hard_block_reason ?? "").includes("STRONG_BULLISH") &&
      !(envelope.authority.decision === "ENTER" && envelope.authority.side === "short"),
    `policy=${judgment.htf_entry_policy}, hard=${judgment.htf_hard_block_reason}, authority=${envelope.authority.decision}/${envelope.authority.side}, engine=${decision.decision}/${decision.side}`
  );
}

// CASE G — WHIPSAW hard active → polarity probe path unavailable (semantics-C hard fixture)
{
  clearWhipsawObservationState("BTCUSDT");
  seedDownShock("BTCUSDT");
  const base = 69000;
  const microCandles = makeMicroDownReboundCandles(base);
  const snap = {
    symbol: "BTCUSDT",
    lastPrice: base,
    latestCandleClose: base,
    signal: "paper_short_candidate",
    entryCandidate: true,
    qualityScore: 85,
    emaGap: -0.0045,
    volumeRatioProxy: 1.2,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.5,
    boxBreakSide: "lower",
    atr: 250,
    atr20: 250,
    closedClose: base,
    rangeConfidence: 0.78,
    trendWeaknessScore: 0.22,
    reviewing_ticks: 2,
    breakoutFailureRate: 0.45,
    volumeExpansion: 1.2,
    candles: microCandles,
    htf_candles: {
      "5m": microCandles,
      "15m": microCandles,
      "1h": microCandles,
      "4h": microCandles
    },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.35
  };
  const bridge = buildV2SnapshotBridge(snap as any);
  (bridge as any).boxBreakSide = "lower";
  const input = adaptV2Input(
    "BTCUSDT",
    Date.now(),
    bridge as any,
    makeLiveConfig() as any,
    makeProductionBridge({ directionalShockState: "DOWN", crashState: "ALERT" }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    microCandles,
    "authoritative",
    `htf_polarity_case_g_${Date.now()}`
  );
  const judgment = detectMarketRegime(input);
  const { decision } = runEngineV2(input);

  run(
    "CASE_G_WHIPSAW_HARD_BLOCKS_PROBE",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK" &&
      judgment.polarityProbeEligible !== true &&
      judgment.htf_entry_policy !== "PROBE_ONLY" &&
      decision.decision !== "ENTER",
    `subtype=${judgment.subtype}, probe=${judgment.polarityProbeEligible}, policy=${judgment.htf_entry_policy}, reason=${judgment.htf_policy_reason}, decision=${decision.decision}`
  );
}

// CASE I — production proof: mismatch + PROBE_ONLY + 0.5 sizing together
{
  const { judgment, decision } = runProbeScenario({
    qualityScore: 85,
    boxPos: 0.5,
    directionalShockState: "DOWN",
    htfMode: "bullish_conflict"
  });

  const probeNotional = decision.risk?.finalOrderNotionalUsdt ?? 0;

  run(
    "CASE_I_PRODUCTION_PROOF_TRIPLE_COEXISTENCE",
    judgment.polarityMismatch === true &&
      judgment.htf_entry_policy === "PROBE_ONLY" &&
      decision.decision === "ENTER" &&
      decision.side === "short" &&
      judgment.htf_size_multiplier === 0.5 &&
      probeNotional > 0 &&
      alignedBaselineNotional > 0 &&
      probeNotional < alignedBaselineNotional * 0.75 &&
      decision.metadata?.polarity_mismatch === true &&
      decision.metadata?.polarity_probe_eligible === true &&
      decision.metadata?.htf_entry_policy === "PROBE_ONLY" &&
      decision.metadata?.htf_size_multiplier === 0.5,
    `mismatch=${judgment.polarityMismatch}, policy=${judgment.htf_entry_policy}, mult=${judgment.htf_size_multiplier}, notional=${probeNotional}, baseline=${alignedBaselineNotional}`
  );

  const nowMs = Date.now();
  const input = makeProbeInput({
    qualityScore: 85,
    boxPos: 0.5,
    directionalShockState: "DOWN",
    htfMode: "bullish_conflict"
  });
  const envelope = resolveSymbolDecisionEnvelope({
    symbol: "BTCUSDT" as any,
    fetchedAt: nowMs,
    snapshot: buildV2SnapshotBridge(input.snapshot as any),
    config: makeLiveConfig() as any,
    state: makeProductionBridge({ directionalShockState: "DOWN" }) as any,
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
    runCycleId: `htf_polarity_reconciler_probe_${nowMs}`
  });

  run(
    "CASE_I_RECONCILER_PROBE_ONLY_NOT_BLOCKED",
    envelope.authority.decision === "ENTER" &&
      envelope.authority.side === "short" &&
      !String(envelope.authority.hardBlockReason ?? "").includes("HTF_POLICY_BLOCK"),
    `authority=${envelope.authority.decision}/${envelope.authority.side}, hard=${envelope.authority.hardBlockReason ?? "none"}`
  );
}

console.log("v2-htf-polarity-entry-authority-cases: ALL PASS");
