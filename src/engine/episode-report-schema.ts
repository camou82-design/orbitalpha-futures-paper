import { MarketSymbol, PaperRegimeState, RangeBoxZone } from "../models/types";

/**
 * EpisodeResultLabel: Structural assessment of a trade event.
 */
export type EpisodeResultLabel =
    | "GOOD_PROBE"           // Probe leading to successful confirmation/standard entry
    | "FAILED_PROBE"         // Probe failed (rejected or stopped) but low damage
    | "GOOD_STANDARD_ENTRY"  // Standard entry with clean rotation/trend follow
    | "LATE_SCALE"           // Scaling occurred after the move was mostly over
    | "FALSE_RANGE_ENTRY"    // Entered RANGE engine but market was actually TRENDing
    | "VALID_RANGE_ROTATION" // Successful oscillation capture in RANGE
    | "BOX_BREAK_EXIT_GOOD"  // Timely exit upon structural break
    | "BOX_BREAK_EXIT_LATE"  // Delayed exit after structure collapse
    | "FATIGUE_REENTRY_BAD"  // Re-entry in high cycle count lead to loss
    | "MID_ZONE_OVERTRADE"   // Excessive small trades in the box center
    | "TREND_BREAKOUT_GOOD"  // Successful trend capture
    | "REJECTED_BY_GATE"     // Blocked by entry filters
    | "REJECTED_BEFORE_GATE" // Blocked before gate (e.g. low quality)
    | "PENDING_EXIT"         // Position still open
    | "STOP_LOSS_HIT"
    | "EARLY_EXIT"
    | "STRUCTURAL_WIN"
    | "STRUCTURAL_LOSS"
    | "OTHER_EXIT"
    | "UNKNOWN";

/**
 * TradeEpisode: A reconstructed event representing a single or multi-leg trade decision.
 */
export interface TradeEpisode {
    episodeId: string;
    symbol: MarketSymbol;
    positionId?: string;
    entryTime: number;
    exitTime?: number;

    // Regime Context at Entry
    regime: PaperRegimeState;

    initialContext: {
        qualityScore: number;
        signalStrength: string;
        rangeConfidence: number;
        boxCohesion: number;
        rangeLadderLevel: number;

        // Highway AI Quality Scores
        alignmentQualityScore?: number;
        emaSpacingHealthScore?: number;
        pullbackQualityScore?: number;
        reboundStrengthScore?: number;
        volumeSupportScore?: number;
        trendExhaustionScore?: number;
        highwayValidityScore?: number;
        entryRiskScore?: number;
        entryIntentType: "probe" | "standard" | "scale" | "trend";
        probeOnlyMode: boolean;
    };

    // Execution State
    entryPrice?: number;
    exitPrice?: number;
    sizeUsd?: number;
    pnlUsd?: number;
    pnlPct?: number;

    resultLabel: EpisodeResultLabel;
    boxBreakSide?: "upper" | "lower" | "none"; // Observed side during life
    regimeStateDiag?: string;
}

/**
 * TuningSuggestion: A recommendation for parameter adjustment.
 */
export interface TuningSuggestion {
    parameter: string;
    currentValue: string;
    suggestedValue: string;
    reason: string;
    confidence: number;
}

/**
 * PolicyTuningReport: The summary output for human review.
 */
export interface PolicyTuningReport {
    generatedAt: number;
    periodStart: number;
    periodEnd: number;
    totalEpisodes: number;
    winRate: number;
    metrics: {
        probeConversionRate: number;
        avgPnlByRegime: Record<string, number>;
        rejectionRateByGate: Record<string, number>;
    };
    suggestions: TuningSuggestion[];
}

export type SymbolSnapshot = any; // Placeholder or import if needed
export type EpisodeRecord = TradeEpisode; // Alias
