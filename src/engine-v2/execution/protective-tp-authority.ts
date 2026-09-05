import type { MarketRegime } from "../../strategy/market-regime-detector";

export type ProtectiveTpMode = "TREND_FULL_TP" | "RANGE_TP1_PARTIAL" | "RANGE_TP2_POST_FILL" | "RANGE_TP2_BACKSTOP" | "NONE";
export type CanonicalTpPhase = "TP1_PENDING" | "TP2_PENDING" | "FULL_TP_PENDING" | "NONE";

export interface ProtectiveTpPlanResolution {
    mode: ProtectiveTpMode;
    phase?: CanonicalTpPhase;
    exchangeTpRequired: boolean;
    exchangeTpPrice: number | null;
    exchangeTpSource: "trend_full_tp" | "range_tp1_partial" | "range_tp2" | "range_tp2_backstop" | "none";
    fullPositionTpRequired: boolean;
    reason: string;
}

/**
 * Resolves the explicit protective TP mode and exchange target price.
 * - TREND: TP1 is full position TP (TREND_FULL_TP).
 * - RANGE (with partial plan):
 *     - Initial (phase TP1_PENDING): TP1 is canonical partial TP.
 *     - Post-fill (phase TP2_PENDING): TP2 is canonical remaining TP.
 * - NONE: when no valid TP price is available.
 */
export function resolveProtectiveTpPlan(input: Readonly<{
    isV2Authority: boolean;
    regime: MarketRegime;
    isV2RangePartialPlan: boolean;
    rawWantsTp?: boolean;
    takeProfitRequired?: boolean;
    targetPrice1?: number | null;
    takeProfit1Px?: number | null;
    takeProfit2Px?: number | null;
    takeProfitPlan?: { tp1?: number | null; tp2?: number | null } | null;
    tp1Filled?: boolean;
    partialExitStage?: number | null;
}>): ProtectiveTpPlanResolution {
    const tp1Candidate =
        input.takeProfit1Px ??
        input.targetPrice1 ??
        input.takeProfitPlan?.tp1 ??
        null;
    const tp2Candidate =
        input.takeProfit2Px ??
        input.takeProfitPlan?.tp2 ??
        null;

    const validTp1 = typeof tp1Candidate === "number" && Number.isFinite(tp1Candidate) && tp1Candidate > 0 ? tp1Candidate : null;
    const validTp2 = typeof tp2Candidate === "number" && Number.isFinite(tp2Candidate) && tp2Candidate > 0 ? tp2Candidate : null;

    if (input.isV2RangePartialPlan) {
        const isTp1Filled = input.tp1Filled === true || (input.partialExitStage != null && input.partialExitStage >= 1);
        if (isTp1Filled) {
            if (validTp2 != null) {
                return {
                    mode: "RANGE_TP2_POST_FILL",
                    phase: "TP2_PENDING",
                    exchangeTpRequired: true,
                    exchangeTpPrice: validTp2,
                    exchangeTpSource: "range_tp2",
                    fullPositionTpRequired: true,
                    reason: "V2_RANGE_TP2_POST_FILL_ENABLED"
                };
            }
            return {
                mode: "NONE",
                phase: "NONE",
                exchangeTpRequired: false,
                exchangeTpPrice: null,
                exchangeTpSource: "none",
                fullPositionTpRequired: false,
                reason: "V2_RANGE_TP2_PRICE_UNAVAILABLE"
            };
        }

        // Initial phase: TP1 is canonical partial TP
        if (validTp1 != null) {
            return {
                mode: "RANGE_TP1_PARTIAL",
                phase: "TP1_PENDING",
                exchangeTpRequired: true,
                exchangeTpPrice: validTp1,
                exchangeTpSource: "range_tp1_partial",
                fullPositionTpRequired: false,
                reason: "V2_RANGE_TP1_PARTIAL_ENABLED"
            };
        }

        return {
            mode: "NONE",
            phase: "NONE",
            exchangeTpRequired: false,
            exchangeTpPrice: null,
            exchangeTpSource: "none",
            fullPositionTpRequired: false,
            reason: "V2_RANGE_TP1_PRICE_UNAVAILABLE"
        };
    }

    if (input.isV2Authority && input.regime === "TREND") {
        if (validTp1 != null) {
            return {
                mode: "TREND_FULL_TP",
                exchangeTpRequired: true,
                exchangeTpPrice: validTp1,
                exchangeTpSource: "trend_full_tp",
                fullPositionTpRequired: true,
                reason: "V2_TREND_MANDATORY_SERVER_TP"
            };
        }
        return {
            mode: "NONE",
            exchangeTpRequired: false,
            exchangeTpPrice: null,
            exchangeTpSource: "none",
            fullPositionTpRequired: false,
            reason: "V2_TREND_TP_PRICE_UNAVAILABLE"
        };
    }

    if (input.isV2Authority && input.regime === "RANGE") {
        const req = Boolean(input.takeProfitRequired) || Boolean(input.rawWantsTp);
        if (req && validTp1 != null) {
            return {
                mode: "TREND_FULL_TP",
                exchangeTpRequired: true,
                exchangeTpPrice: validTp1,
                exchangeTpSource: "trend_full_tp",
                fullPositionTpRequired: true,
                reason: "V2_RANGE_FULL_TP_REQUIRED"
            };
        }
        return {
            mode: "NONE",
            exchangeTpRequired: false,
            exchangeTpPrice: null,
            exchangeTpSource: "none",
            fullPositionTpRequired: false,
            reason: "V2_RANGE_TP_NOT_REQUESTED"
        };
    }

    if (!input.isV2Authority) {
        const req = input.regime === "RANGE" || Boolean(input.takeProfitRequired) || Boolean(input.rawWantsTp);
        if (req && validTp1 != null) {
            return {
                mode: "TREND_FULL_TP",
                exchangeTpRequired: true,
                exchangeTpPrice: validTp1,
                exchangeTpSource: "trend_full_tp",
                fullPositionTpRequired: true,
                reason: "LEGACY_TP_AUTHORITY"
            };
        }
        return {
            mode: "NONE",
            exchangeTpRequired: false,
            exchangeTpPrice: null,
            exchangeTpSource: "none",
            fullPositionTpRequired: false,
            reason: "LEGACY_TP_PRICE_UNAVAILABLE"
        };
    }

    return {
        mode: "NONE",
        exchangeTpRequired: false,
        exchangeTpPrice: null,
        exchangeTpSource: "none",
        fullPositionTpRequired: false,
        reason: "DEFAULT_NO_FULL_TP"
    };
}

/**
 * Canonical full-position TP requirement for BOT_V2_MANAGED opens.
 * Backward-compatible helper.
 */
export function shouldAttachFullPositionProtectiveTp(input: Readonly<{
    isV2Authority: boolean;
    regime: MarketRegime;
    isV2RangePartialPlan: boolean;
    rawWantsTp: boolean;
    takeProfitRequired?: boolean;
    takeProfit2Px?: number | null;
    takeProfitPlan?: { tp1?: number | null; tp2?: number | null } | null;
}>): { fullPositionTpRequired: boolean; reason: string; protectiveTpMode?: ProtectiveTpMode; exchangeTpPrice?: number | null } {
    const plan = resolveProtectiveTpPlan({
        isV2Authority: input.isV2Authority,
        regime: input.regime,
        isV2RangePartialPlan: input.isV2RangePartialPlan,
        rawWantsTp: input.rawWantsTp,
        takeProfitRequired: input.takeProfitRequired,
        takeProfit2Px: input.takeProfit2Px,
        takeProfitPlan: input.takeProfitPlan
    });

    if (input.isV2RangePartialPlan) {
        if (plan.mode === "RANGE_TP2_BACKSTOP") {
            return {
                fullPositionTpRequired: true,
                reason: "V2_RANGE_TP2_BACKSTOP_ENABLED",
                protectiveTpMode: "RANGE_TP2_BACKSTOP",
                exchangeTpPrice: plan.exchangeTpPrice
            };
        }
        return {
            fullPositionTpRequired: false,
            reason: "V2_RANGE_PARTIAL_SOVEREIGNTY",
            protectiveTpMode: "NONE",
            exchangeTpPrice: null
        };
    }

    return {
        fullPositionTpRequired: plan.exchangeTpRequired,
        reason: plan.reason,
        protectiveTpMode: plan.mode,
        exchangeTpPrice: plan.exchangeTpPrice
    };
}

export function resolveOpsWatchTpRequired(input: Readonly<{
    isV2RangePartialPlan: boolean;
    isV2ManagedTrend: boolean;
    rawTpRequired: boolean;
    hasRangeTp2Backstop?: boolean;
}>): boolean {
    if (input.isV2RangePartialPlan) {
        return input.hasRangeTp2Backstop === true;
    }
    if (input.isV2ManagedTrend) return input.rawTpRequired;
    return input.rawTpRequired;
}
