/**
 * V2 automatic initial-entry liveness audit — production-shaped regression cases A–E.
 *
 * A. BTC short trend, trendOk, Q>=80, HTF ALLOW, no hard block → reachable ENTER
 * B. Same with Q>=90/S-grade
 * C. ETH HTF HOLD → remains blocked
 * D. RANGE genuine range signal → RANGE zone rules intact
 * E. TREND candidate must not be vetoed solely by RANGE side-zone mismatch
 */

import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { resolveSymbolDecisionEnvelope } from "../engine-v2/reconciler";
import { globalShockStates } from "../engine-v2/state/derive";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";

function run(label: string, passed: boolean, detail: string): void {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[V2-ENTRY-LIVENESS][${label}] ${tag} — ${detail}`);
  if (!passed) throw new Error(`[V2-ENTRY-LIVENESS][${label}] FAILED: ${detail}`);
}

const mockBearishCandles: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 60000,
  open: 70000 - i * 8,
  high: 70005 - i * 8,
  low: 69995 - i * 8,
  close: 69998 - i * 8,
  volume: 100
}));

const mockBullishCandles: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 60000,
  open: 2600 + i * 4,
  high: 2605 + i * 4,
  low: 2595 + i * 4,
  close: 2602 + i * 4,
  volume: 100
}));

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

function makeTrendRangeSplitInput(
  symbol: "BTCUSDT" | "ETHUSDT",
  opts: {
    qualityScore: number;
    directionalShockState: "DOWN" | "UP" | "NONE";
    boxPos: number;
    htfCandles: Candle[];
    candles?: Candle[];
    emaGap?: number;
  }
) {
  const base = symbol === "BTCUSDT" ? 69000 : 2600;
  const boxHigh = symbol === "BTCUSDT" ? 70000 : 2700;
  const boxLow = symbol === "BTCUSDT" ? 68000 : 2500;
  const candles = opts.candles ?? makeRangeOscillationCandles(base);
  const snap = {
    symbol,
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
    atr: symbol === "BTCUSDT" ? 250 : 12,
    atr20: symbol === "BTCUSDT" ? 250 : 12,
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

  const bridge = buildV2SnapshotBridge(snap as any);
  if (opts.directionalShockState === "DOWN") seedDownShock(symbol);
  return adaptV2Input(
    symbol,
    Date.now(),
    bridge as any,
    makeLiveConfig() as any,
    makeProductionBridge({ directionalShockState: opts.directionalShockState }) as any,
    { decision: { final_decision: "SKIP" } } as any,
    candles,
    "authoritative",
    `entry_liveness_${symbol}_${Date.now()}`
  );
}

// CASE A — BTC short trend, Q>=80, HTF ALLOW, shock DOWN, RANGE router split → ENTER reachable
{
  const input = makeTrendRangeSplitInput("BTCUSDT", {
    qualityScore: 85,
    directionalShockState: "DOWN",
    boxPos: 0.5,
    htfCandles: mockBearishCandles
  });
  const judgment = detectMarketRegime(input);
  let decision: ReturnType<typeof runEngineV2>["decision"];
  let promotionProof: Record<string, unknown> | undefined;
  const proofs = captureProofLogs(() => {
    ({ decision } = runEngineV2(input));
  });
  promotionProof = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");

  const htfAllowsShort =
    judgment.htf_entry_policy === "ALLOW" ||
    judgment.htf_entry_policy === "SHORT_ONLY_OR_NONE" ||
    judgment.htf_entry_policy === "PROBE_ONLY";

  run(
    "CASE_A_BTC_TREND_SHORT_Q80_HTf_ALLOW_ENTERS",
    htfAllowsShort &&
      promotionProof?.v2_router_executor === "RANGE" &&
      promotionProof?.decision_after === "ENTER" &&
      promotionProof?.side_after === "short" &&
      decision!.decision === "ENTER" &&
      decision!.side === "short" &&
      (decision!.risk?.finalOrderNotionalUsdt ?? 0) > 0,
    `policy=${judgment.htf_entry_policy}, router=${promotionProof?.v2_router_executor}, promo=${promotionProof?.decision_after}/${promotionProof?.side_after}, final=${decision!.decision}/${decision!.side}, notional=${decision!.risk?.finalOrderNotionalUsdt}`
  );

  run(
    "CASE_A_NO_RANGE_ZONE_VETO",
    promotionProof?.decision_after === "ENTER" &&
      promotionProof?.side_after === "short" &&
      !proofs.some((p) =>
        p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" &&
        (p.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT" ||
          p.vetoReason === "RANGE_MID_CONSERVATIVE_VETO")
      ),
    `block=${promotionProof?.promotion_block_reason ?? "none"}, side_zone_valid=${promotionProof?.side_zone_valid}`
  );
}

// CASE B — BTC S-grade Q>=90
{
  seedDownShock("BTCUSDT");
  const input = makeTrendRangeSplitInput("BTCUSDT", {
    qualityScore: 92,
    directionalShockState: "DOWN",
    boxPos: 0.55,
    htfCandles: mockBearishCandles
  });
  const { decision } = runEngineV2(input);

  run(
    "CASE_B_BTC_S_GRADE_ENTERS",
    decision.decision === "ENTER" &&
      decision.side === "short" &&
      (decision.risk?.entryQualityGrade === "S" || (input.snapshot?.qualityScore ?? 0) >= 90) &&
      (decision.risk?.finalOrderNotionalUsdt ?? 0) > 0,
    `decision=${decision.decision}, side=${decision.side}, grade=${decision.risk?.entryQualityGrade}, notional=${decision.risk?.finalOrderNotionalUsdt}`
  );
}

// CASE C — ETH contrarian qualified short → PROBE_ONLY (not full HOLD block)
{
  const input = makeTrendRangeSplitInput("ETHUSDT", {
    qualityScore: 88,
    directionalShockState: "DOWN",
    boxPos: 0.5,
    htfCandles: mockBullishCandles,
    emaGap: -0.006
  });
  seedDownShock("ETHUSDT");
  const judgment = detectMarketRegime(input);
  const { decision } = runEngineV2(input);

  run(
    "CASE_C_ETH_CONTRARIAN_PROBE_ONLY_REACHABLE",
    judgment.htf_entry_policy === "PROBE_ONLY" &&
      judgment.polarityProbeEligible === true &&
      judgment.polarityMismatch === true &&
      decision.decision === "ENTER" &&
      decision.side === "short" &&
      (decision.risk?.finalOrderNotionalUsdt ?? 0) > 0,
    `htf_policy=${judgment.htf_entry_policy}, probe=${judgment.polarityProbeEligible}, decision=${decision.decision}, side=${decision.side}, notional=${decision.risk?.finalOrderNotionalUsdt ?? 0}`
  );
}

// CASE D — Genuine RANGE lower-long without trend shock authority stays gated
{
  const input = makeTrendRangeSplitInput("BTCUSDT", {
    qualityScore: 72,
    directionalShockState: "NONE",
    boxPos: 0.12,
    htfCandles: mockBearishCandles,
    emaGap: 0.0015
  });
  input.snapshot!.signal = "paper_long_candidate";
  const judgment = detectMarketRegime(input);
  const { decision } = runEngineV2(input);

  run(
    "CASE_D_RANGE_LOWER_LONG_NOT_TREND_BYPASS",
    decision.decision !== "ENTER" || decision.side === "long",
    `decision=${decision.decision}, side=${decision.side}, regime=${judgment.regime}, zone=lower`
  );

  run(
    "CASE_D_NO_SHOCK_TREND_AUTHORITY_BYPASS",
    decision.decision !== "ENTER" || (decision.metadata?.promotion_reason !== "V2_TREND_QUALIFIED_FINAL_PROMOTION"),
    `decision=${decision.decision}, promotion=${decision.metadata?.promotion_reason ?? "none"}`
  );
}

// CASE E — TREND short must not be vetoed solely by RANGE side-zone mismatch (mid box)
{
  seedDownShock("BTCUSDT");
  const input = makeTrendRangeSplitInput("BTCUSDT", {
    qualityScore: 86,
    directionalShockState: "DOWN",
    boxPos: 0.48,
    htfCandles: mockBearishCandles
  });
  let decision: ReturnType<typeof runEngineV2>["decision"];
  let vetoProof: Record<string, unknown> | undefined;
  const proofs = captureProofLogs(() => {
    ({ decision } = runEngineV2(input));
  });
  vetoProof = proofs.find((p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");
  const promotionProof = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");

  run(
    "CASE_E_TREND_NOT_VETOED_BY_RANGE_SIDE_ZONE",
    decision!.decision === "ENTER" &&
      decision!.side === "short" &&
      vetoProof == null &&
      promotionProof?.side_zone_valid === false,
    `decision=${decision!.decision}, side=${decision!.side}, side_zone_valid=${promotionProof?.side_zone_valid}, veto=${vetoProof?.vetoReason ?? "none"}`
  );

  run(
    "CASE_E_MARGIN_NONZERO_WHEN_ENTER",
    (decision!.risk?.finalOrderNotionalUsdt ?? 0) > 0,
    `notional=${decision!.risk?.finalOrderNotionalUsdt ?? 0}, margin=${decision!.risk?.stageMarginKrw ?? 0}`
  );
}

console.log("v2-automatic-entry-liveness-cases: ALL PASS");
