// src/engine/ai-highway-filter.ts

import { AiHighwayQualityScores, HighwayTrendState } from "../models/types";
import {
  detectHighwayTrend,
  HIGHWAY_TREND_MIN_CANDLES,
  isInsufficientCandlesLt60Only
} from "./highway-trend-detector";
import { Candle, MarketSymbol } from "../models/types";

function buildHighwayStiffnessProof(
  core: ReturnType<typeof detectHighwayTrend>,
  finalAlign: number,
  finalSpacing: number,
  finalVol: number,
  highwayValidity: number,
  rangeStage0: boolean
): Record<string, unknown> {
  const zt = 0.02;
  const approxZero = {
    alignment_quality: finalAlign < zt,
    ema_spacing_health: finalSpacing < zt,
    volume_support: finalVol < zt
  };
  const collapseDrivers: string[] = [];
  for (const r of core.invalidReasons) collapseDrivers.push(`core_reason:${r}`);
  if (approxZero.alignment_quality) collapseDrivers.push("final_alignment_quality_near_zero");
  if (approxZero.ema_spacing_health) collapseDrivers.push("final_ema_spacing_health_near_zero");
  if (approxZero.volume_support) collapseDrivers.push("final_volume_support_near_zero");
  if (core.alignmentScore < zt && !core.invalidReasons.includes("insufficient_candles_lt_60")) {
    collapseDrivers.push("core_alignment_stack_no_credits");
  }
  if (core.spacingScore < 0.36) collapseDrivers.push("core_spacing_low_or_overextended");
  if (core.volumeSupportScore < zt) collapseDrivers.push("core_volume_support_near_zero");
  collapseDrivers.push(rangeStage0 ? "scoring_path:range_stage0_context" : "scoring_path:trend_core_default");
  return {
    proof_version: 1,
    scoring_path: rangeStage0 ? "range_stage0_context" : "trend_core_default",
    core: {
      alignment: core.alignmentScore,
      spacing: core.spacingScore,
      volume_support: core.volumeSupportScore,
      pullback_detected: core.pullbackDetected,
      invalid_tier: core.invalidTier,
      invalid_reasons: core.invalidReasons
    },
    final: {
      alignment_quality: finalAlign,
      ema_spacing_health: finalSpacing,
      volume_support: finalVol,
      highway_validity: highwayValidity
    },
    approx_zero: approxZero,
    collapse_drivers: [...new Set(collapseDrivers)]
  };
}

function buildHighwayCandleGateProof(
  candles: Candle[],
  symbol: MarketSymbol,
  meta?: Readonly<{
    snapshotRecentCandlesCount?: number | null;
    klineLimitRequested?: number | null;
    entryTimeframe?: string | null;
  }>
): Record<string, unknown> {
  const arrayLen = candles.length;
  const snapCount = meta?.snapshotRecentCandlesCount;
  const reqLimit = meta?.klineLimitRequested;
  const tf = meta?.entryTimeframe ?? "1m";
  let countDiscrepancy: string | null = null;
  if (typeof snapCount === "number" && Number.isFinite(snapCount) && snapCount !== arrayLen) {
    countDiscrepancy = `candles_array_length_${arrayLen}_vs_snapshot_recentCandlesCount_${snapCount}`;
  }
  let likelyCause: string;
  if (arrayLen === 0) {
    likelyCause = "empty_candles_array_evaluator_input";
  } else if (arrayLen < HIGHWAY_TREND_MIN_CANDLES) {
    if (typeof reqLimit === "number" && reqLimit >= HIGHWAY_TREND_MIN_CANDLES && arrayLen < reqLimit * 0.5) {
      likelyCause = "api_or_transport_shortfall_vs_requested_limit";
    } else if (typeof reqLimit === "number" && arrayLen < reqLimit) {
      likelyCause = "partial_kline_response_or_warmup";
    } else {
      likelyCause = "below_highway_min_without_request_meta";
    }
  } else {
    likelyCause = "satisfies_highway_min";
  }
  return {
    proof_version: 1,
    symbol: String(symbol),
    entry_timeframe: tf,
    candles_array_length: arrayLen,
    highway_min_candles: HIGHWAY_TREND_MIN_CANDLES,
    ema240_ideal_min_candles: 240,
    snapshot_recent_candles_count: snapCount ?? null,
    kline_limit_requested: reqLimit ?? null,
    count_discrepancy: countDiscrepancy,
    likely_cause: likelyCause,
    note:
      "Engine poll uses Bybit 1m klines into snapshot.candles; empty or short array = warmup, fetch shortfall, or missing passthrough."
  };
}

type HighwayScoreContext = Readonly<{
    regime?: "TREND" | "RANGE" | "NO_TRADE";
    currentStage?: number;
    boxPos?: number | null;
    emaGap?: number | null;
    volumeRatioProxy?: number | null;
    rangeConfidence?: number | null;
    boxCohesion01?: number | null;
    breakoutFailureRate?: number | null;
    rangeOscillationScore?: number | null;
    trendWeaknessScore?: number | null;
    /** 스냅샷의 recentCandlesCount (pollSymbol rC.value.length) */
    snapshotRecentCandlesCount?: number | null;
    /** pollSymbol에 넘긴 kline limit (기본 120) */
    klineLimitRequested?: number | null;
    entryTimeframe?: string | null;
}>;

/**
 * AI Quality Filter – consumes core detector output and produces detailed scores.
 * It does NOT override the core state; it only adds scoring and optional defer flags.
 */
export function evaluateAiHighwayQuality(candles: Candle[], symbol: MarketSymbol, context?: HighwayScoreContext): AiHighwayQualityScores & {
    state: HighwayTrendState;
    deferEntry: boolean;
    invalidTier: "hard_invalid" | "soft_invalid" | "warning";
    invalidReasons: string[];
    scoreSource: "range_stage0_context" | "trend_core_default";
    rangeStage0ScoringApplied: boolean;
    aiScoreRaw: Record<string, unknown>;
} {
    const core = detectHighwayTrend(candles, symbol);
    const rangeStage0 = context?.regime === "RANGE" && (context?.currentStage ?? 0) === 0;
    const coreInsufficientOnly = isInsufficientCandlesLt60Only(core.invalidReasons);
    const highwayCandleGateProof = buildHighwayCandleGateProof(candles, symbol, {
      snapshotRecentCandlesCount: context?.snapshotRecentCandlesCount,
      klineLimitRequested: context?.klineLimitRequested,
      entryTimeframe: context?.entryTimeframe
    });
    const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

    let alignmentQualityScore = core.alignmentScore;
    let emaSpacingHealthScore = core.spacingScore;
    let pullbackQualityScore = core.pullbackDetected ? 0.8 : 0.3;
    let reboundStrengthScore = core.pullbackDetected ? 0.7 : 0.2;
    let volumeSupportScore = core.volumeSupportScore;
    let trendExhaustionScore = core.state === HighwayTrendState.WEAK ? 0.4 : 0.1;
    let highwayValidityScore = (alignmentQualityScore + emaSpacingHealthScore + pullbackQualityScore + volumeSupportScore) / 4;
    let entryRiskScore = 1 - highwayValidityScore;
    let deferEntry = highwayValidityScore < 0.3;
    let state = core.state;
    let invalidTier = core.invalidTier;
    let invalidReasons = core.invalidReasons;

    if (rangeStage0) {
        const rangeConfidence = clamp01(context?.rangeConfidence ?? 0);
        const boxCohesion = clamp01(context?.boxCohesion01 ?? 0);
        const breakoutFailure = clamp01(context?.breakoutFailureRate ?? 0);
        const oscillation = clamp01(context?.rangeOscillationScore ?? 0);
        const emaGapAbs = Math.abs(context?.emaGap ?? 0);
        const emaGapIdeal = clamp01(1 - Math.min(1, emaGapAbs / 0.0012));
        const boxPos = context?.boxPos;
        const edgeProximity =
            typeof boxPos === "number"
                ? clamp01(1 - Math.min(1, Math.abs(boxPos - 0.5) / 0.35))
                : 0.35;
        const volProxy = context?.volumeRatioProxy ?? 0;
        const volumeNorm = volProxy > 0 ? clamp01(1 - Math.min(1, Math.abs(volProxy - 1.0) / 1.2)) : 0.3;
        const trendWeakness = clamp01(context?.trendWeaknessScore ?? 0.5);

        alignmentQualityScore = clamp01(
            0.34 * rangeConfidence +
            0.22 * boxCohesion +
            0.22 * breakoutFailure +
            0.22 * oscillation
        );
        emaSpacingHealthScore = clamp01(0.75 * emaGapIdeal + 0.25 * trendWeakness);
        pullbackQualityScore = clamp01(0.6 * edgeProximity + 0.4 * breakoutFailure);
        reboundStrengthScore = clamp01(0.5 * oscillation + 0.5 * edgeProximity);
        volumeSupportScore = volumeNorm;
        trendExhaustionScore = clamp01(0.65 + 0.35 * trendWeakness);
        highwayValidityScore = clamp01(
            0.32 * alignmentQualityScore +
            0.22 * emaSpacingHealthScore +
            0.28 * pullbackQualityScore +
            0.18 * volumeSupportScore
        );
        entryRiskScore = 1 - highwayValidityScore;
        deferEntry = highwayValidityScore < 0.22;

        state =
            highwayValidityScore >= 0.62
                ? HighwayTrendState.VALID
                : highwayValidityScore >= 0.42
                    ? HighwayTrendState.WEAK
                    : HighwayTrendState.INVALID;

        invalidTier =
            state !== HighwayTrendState.INVALID
                ? "warning"
                : highwayValidityScore >= 0.34
                    ? "soft_invalid"
                    : "hard_invalid";
        invalidReasons = state === HighwayTrendState.INVALID
            ? ["range_stage0_quality_below_threshold", ...core.invalidReasons].slice(0, 4)
            : core.invalidReasons;
    }

    const highwayStiffnessProof = buildHighwayStiffnessProof(
        core,
        alignmentQualityScore,
        emaSpacingHealthScore,
        volumeSupportScore,
        highwayValidityScore,
        rangeStage0
    );

    if (coreInsufficientOnly && state === HighwayTrendState.INVALID && invalidTier === "hard_invalid") {
      invalidTier = "soft_invalid";
    }

    return {
        alignmentQualityScore,
        emaSpacingHealthScore,
        pullbackQualityScore,
        reboundStrengthScore,
        volumeSupportScore,
        trendExhaustionScore,
        highwayValidityScore,
        entryRiskScore,
        state,
        deferEntry,
        invalidTier,
        invalidReasons,
        scoreSource: rangeStage0 ? "range_stage0_context" : "trend_core_default",
        rangeStage0ScoringApplied: rangeStage0,
        aiScoreRaw: {
            symbol,
            rangeStage0,
            context: context ?? null,
            coreState: core.state,
            coreAlignment: core.alignmentScore,
            coreSpacing: core.spacingScore,
            coreVolumeSupport: core.volumeSupportScore,
            highwayCandleShortfallCoreOnly: coreInsufficientOnly,
            highwayCandleGateProof,
            finalState: state,
            highwayStiffnessProof,
            finalScores: {
                highwayValidityScore,
                alignmentQualityScore,
                emaSpacingHealthScore,
                pullbackQualityScore,
                volumeSupportScore,
                entryRiskScore
            }
        }
    };
}
