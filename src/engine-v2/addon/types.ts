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
    | "TREND_PYRAMID_PROFIT_FUNDED_ALLOWED"
    | "HIGHWAY_PULLBACK_PYRAMID_ALLOWED"
    | "HIGHWAY_MOMENTUM_CONTINUATION_PYRAMID_ALLOWED"
    | "MOMENTUM_AUTHORITY_NOT_CONFIRMED"
    | "CONFIRMED_ADVERSE_ADDON_ALLOWED"
    | "QUALITY_TOO_LOW_FOR_ADDON"
    | "CURRENT_STAGE_LIMIT"
    | "PNL_NOT_FAVORABLE"
    | "PROFIT_BUFFER_INSUFFICIENT"
    | "SIDE_MISMATCH_FORBIDDEN"
    | "SIDE_NONE_FORBIDDEN"
    | "WHIPSAW_SHOCK_RECHECK_ADDON_FORBIDDEN"
    | "POST_SHOCK_PROBE_ONLY_STANDARD_GATE_PENDING"
    | "POST_SHOCK_PROBE_STANDARD_PROMOTION_ALREADY_CONSUMED"
    | "BREAKEVEN_STOP_UPDATE_REQUIRED"
    | "BREAKEVEN_STOP_NOT_CONFIRMED";

export type V2AddonMode = "PYRAMIDING" | "CONFIRMED_ADVERSE_ADDON" | "NONE";

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
    postShockProbePromotionState?: "PROBE_ONLY" | "STANDARD_PROMOTED";
    lockedProfitUsdt?: number;
    availableRiskBudgetUsdt?: number;
    addonMaxNotionalUsdt?: number;
    equityRiskCapUsdt?: number;
    breakevenStopRequired: boolean;
    breakevenStopConfirmed: boolean;
    breakevenStopPrice?: number;
    addonBlockedReason?: string;
    breakevenGateProof?: Record<string, any>;
    addonMode?: V2AddonMode;
    requestedAddonNotionalUsdt?: number;
    thesisValid?: boolean;
    sameSideConfirmation?: boolean;
    priceDistancePassed?: boolean;
    riskProjection?: (
        // Adverse Add-On 전용: stop 체결 시 예상 손실량 (loss-at-stop)
        {
            projectedTotalNotionalUsdt: number;
            projectedWeightedAvgEntry: number;
            projectedStopPrice: number;
            projectedLossAtStopUsdt: number;
            riskBeforeAddonUsdt: number;
            riskBudgetUsdt: number;
            riskBudgetAllowedNotional: number;
        }
        |
        // Highway Pyramid 전용: stop 체결 시 보호되는 이익 (protected profit at stop)
        {
            projectedTotalNotionalUsdt: number;
            projectedWeightedAvgEntry: number;
            projectedStopPrice: number;
            /** stop 체결 시 보호되는 gross 이익 (수수료 차감 전). adverse-addon의 projectedLossAtStopUsdt와 semantic이 다름. */
            projectedGrossProtectedProfitAtStopUsdt: number;
            /** stop 체결 시 보호되는 net 이익 (friction 차감 후, +40 USDT gate 기준). */
            projectedNetProtectedProfitAtStopUsdt: number;
            riskBeforeAddonUsdt: number;
            /** Highway pyramid: net protected profit at stop (legacy 필드명 유지, loss-at-stop 아님). */
            riskBudgetUsdt: number;
            riskBudgetAllowedNotional: number;
        }
    );
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
        lastPrice?: number;
        atr?: number;
        volatilityProxyDiag?: number | null;
        latestCandleTs?: number;
    };
    accountEquityUsd?: number;
    currentSymbolNotionalUsd?: number;
    currentGlobalNotionalUsd?: number;
    currentStopPrice?: number;
    peakUnrealizedPnlPct?: number;
    maxAddonNotionalUsdt?: number;
}>;
