// src/engine/ai-highway-filter.ts

import { AiHighwayQualityScores, HighwayTrendState } from "../models/types";
import { detectHighwayTrend } from "./highway-trend-detector";
import { Candle, MarketSymbol } from "../models/types";

/**
 * AI Quality Filter – consumes core detector output and produces detailed scores.
 * It does NOT override the core state; it only adds scoring and optional defer flags.
 */
export function evaluateAiHighwayQuality(candles: Candle[], symbol: MarketSymbol): AiHighwayQualityScores & {
    state: HighwayTrendState;
    deferEntry: boolean;
    invalidTier: "hard_invalid" | "soft_invalid" | "warning";
    invalidReasons: string[];
} {
    const core = detectHighwayTrend(candles, symbol);
    // Placeholder scoring logic – replace with real ML model or heuristic.
    const alignmentQualityScore = core.alignmentScore;
    const emaSpacingHealthScore = core.spacingScore;
    const pullbackQualityScore = core.pullbackDetected ? 0.8 : 0.3;
    const reboundStrengthScore = core.pullbackDetected ? 0.7 : 0.2;
    const volumeSupportScore = core.volumeSupportScore;
    const trendExhaustionScore = core.state === HighwayTrendState.WEAK ? 0.4 : 0.1;
    const highwayValidityScore = (alignmentQualityScore + emaSpacingHealthScore + pullbackQualityScore + volumeSupportScore) / 4;
    const entryRiskScore = 1 - highwayValidityScore;
    const deferEntry = highwayValidityScore < 0.3;

    return {
        alignmentQualityScore,
        emaSpacingHealthScore,
        pullbackQualityScore,
        reboundStrengthScore,
        volumeSupportScore,
        trendExhaustionScore,
        highwayValidityScore,
        entryRiskScore,
        state: core.state,
        deferEntry,
        invalidTier: core.invalidTier,
        invalidReasons: core.invalidReasons
    };
}
