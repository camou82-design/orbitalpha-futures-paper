// src/engine/ai-highway-filter.ts

import { AiHighwayQualityScores, HighwayTrendState } from "../models/types";
import { detectHighwayTrend } from "./highway-trend-detector";
import { Candle, MarketSymbol } from "../models/types";

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
            finalState: state,
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
