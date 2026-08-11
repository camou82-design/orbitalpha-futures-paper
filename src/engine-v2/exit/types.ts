import type { MarketJudgmentOutput } from "../types";
import type { V2StateAuthority } from "../state/types";

export type V2ExitAction = "HOLD" | "WATCH" | "REDUCE" | "PARTIAL_TAKE_PROFIT" | "FULL_EXIT";

export type V2ExitReason =
    | "NO_POSITION_HOLD"
    | "RANGE_HOLD_INSIDE_BOX"
    | "RANGE_PARTIAL_AT_OPPOSITE_EDGE"
    | "RANGE_FULL_EXIT_BOX_BREAK"
    | "RANGE_PROFIT_PROTECT"
    | "TREND_HOLD_VALID"
    | "TREND_PARTIAL_EMA20_WEAKNESS"
    | "TREND_FULL_EXIT_EMA60_INVALID"
    | "TREND_EXHAUSTION_REDUCE"
    | "TREND_EXHAUSTION_REDUCE_50PCT"
    | "TREND_WEAKNESS_REDUCE_30PCT"
    | "TRANSITION_PROTECTIVE_WATCH"
    | "TRANSITION_REDUCE_ON_CONFLICT"
    | "SHOCK_PROTECTIVE_REDUCE"
    | "SHOCK_FULL_EXIT_AGAINST_POSITION"
    | "PNL_STOP_PROTECT"
    | "PROFIT_PROTECTION_BREAKEVEN_EXIT"
    | "PROFIT_PROTECTION_PARTIAL_TP"
    | "PROFIT_PROTECTION_TRAILING_STOP"
    | "NO_EXIT_SIGNAL";

export type V2ExitUrgency = "LOW" | "MID" | "HIGH" | "CRITICAL";

export type V2ExitPolicyResult = Readonly<{
    action: V2ExitAction;
    shouldExit: boolean;
    shouldReduce: boolean;
    shouldPartial: boolean;
    reason: V2ExitReason;
    positionSide: "long" | "short" | "none";
    positionSizeUsd: number;
    currentStage: number;
    pnlPct: number;
    marketRegime: MarketJudgmentOutput["regime_final"];
    marketSubtype: MarketJudgmentOutput["subtype"];
    shockPhase: MarketJudgmentOutput["shockPhase"];
    rangePhase: MarketJudgmentOutput["rangePhase"];
    trendPhase: MarketJudgmentOutput["trendPhase"];
    transitionPhase: MarketJudgmentOutput["transitionPhase"];
    boxPos: number;
    boxBreakSide: "upper" | "lower" | "none";
    emaGap: number;
    trendWeaknessScore: number;
    rangeConfidence: number;
    qualityScore: number;
    reduceRatio: number;
    exitUrgency: V2ExitUrgency;
    exitConfidence: number;
    evidence: string;
    hasPosition: boolean;
    peakUnrealizedPnlPct: number;
    profitProtectionActive: boolean;
    oppositeHysteresisState?: string;
    oppositeHysteresisBlockReason?: string | null;
    thesisValid?: boolean;
}>;

export type EvaluateV2ExitPolicyArgs = Readonly<{
    symbol: string;
    v2State: V2StateAuthority;
    judgment: MarketJudgmentOutput;
    snapshot: {
        boxPos: number | null;
        boxBreakSide: "upper" | "lower" | "none";
        emaGap: number | null;
        trendWeaknessScore: number;
        rangeConfidence: number | null;
        qualityScore: number;
    };
    trendSideCandidate?: "long" | "short" | "none";
    rangeSideCandidate?: "long" | "short" | "none";
    reversalConfirmed?: boolean;
    sameCycleExitConsumed?: boolean;
    invalidationBreachConfirmed?: boolean;
    structuralBreakConfirmed?: boolean;
    boxBreakConfirmed?: boolean;
}>;
