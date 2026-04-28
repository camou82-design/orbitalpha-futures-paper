import type { EngineV2Side, ExecutorOutput, MarketJudgmentOutput } from "../types";
import type { V2StateAuthority } from "../state/types";

export type V2AddOnAction =
    | "INITIAL_ONLY"
    | "ADDON_ALLOWED"
    | "ADDON_WATCH"
    | "ADDON_FORBIDDEN";

export type V2AddOnReason =
    | "NO_EXISTING_POSITION_INITIAL_ONLY"
    | "SAME_SIDE_POSITION_REATTACK_ALLOWED"
    | "SAME_SIDE_POSITION_WATCH_RECHECK"
    | "OPPOSITE_POSITION_EXISTS_FORBIDDEN"
    | "SHOCK_ADDON_FORBIDDEN"
    | "TRANSITION_ADDON_FORBIDDEN"
    | "RANGE_MID_ADDON_FORBIDDEN"
    | "RANGE_EDGE_REATTACK_ALLOWED"
    | "TREND_PULLBACK_ADDON_ALLOWED"
    | "TREND_CONTINUATION_ADDON_ALLOWED"
    | "QUALITY_TOO_LOW_FOR_ADDON"
    | "CURRENT_STAGE_LIMIT"
    | "PNL_NOT_FAVORABLE"
    | "SIDE_NONE_FORBIDDEN";

export type V2AddOnPolicyResult = Readonly<{
    action: V2AddOnAction;
    allowed: boolean;
    reason: V2AddOnReason;
    addOnEligible: boolean;
    isInitial: boolean;
    isAddOn: boolean;
    side: EngineV2Side;
    currentStage: number;
    hasSameSidePosition: boolean;
    hasOppositeSidePosition: boolean;
    marketRegime: MarketJudgmentOutput["regime_final"];
    marketSubtype: MarketJudgmentOutput["subtype"];
    shockPhase: MarketJudgmentOutput["shockPhase"];
    rangePhase: MarketJudgmentOutput["rangePhase"];
    trendPhase: MarketJudgmentOutput["trendPhase"];
    transitionPhase: MarketJudgmentOutput["transitionPhase"];
    qualityScore: number;
    reviewingTicks: number;
    pnlPct: number;
    boxPos: number;
    emaGap: number;
    trendWeaknessScore: number;
    rangeConfidence: number;
    evidence: string;
}>;

export type EvaluateV2AddOnPolicyArgs = Readonly<{
    symbol: string;
    side: EngineV2Side;
    v2State: V2StateAuthority;
    judgment: MarketJudgmentOutput;
    execution: ExecutorOutput;
    snapshot: {
        qualityScore: number;
        reviewing_ticks: number;
        boxPos: number | null;
        emaGap: number | null;
        trendWeaknessScore: number;
        rangeConfidence: number | null;
    };
}>;
