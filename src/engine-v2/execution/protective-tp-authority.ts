import type { MarketRegime } from "../../strategy/market-regime-detector";

/**
 * Canonical full-position TP requirement for BOT_V2_MANAGED opens.
 * V2 TREND positions require server-side TP when a valid TP price exists.
 */
export function shouldAttachFullPositionProtectiveTp(input: Readonly<{
    isV2Authority: boolean;
    regime: MarketRegime;
    isV2RangePartialPlan: boolean;
    rawWantsTp: boolean;
    takeProfitRequired?: boolean;
}>): { fullPositionTpRequired: boolean; reason: string } {
    if (input.isV2RangePartialPlan) {
        return { fullPositionTpRequired: false, reason: "V2_RANGE_PARTIAL_SOVEREIGNTY" };
    }

    if (input.isV2Authority && input.regime === "TREND") {
        if (input.rawWantsTp || input.takeProfitRequired) {
            return { fullPositionTpRequired: true, reason: "V2_TREND_MANDATORY_SERVER_TP" };
        }
        return { fullPositionTpRequired: false, reason: "V2_TREND_TP_PRICE_UNAVAILABLE" };
    }

    if (input.isV2Authority && input.regime === "RANGE") {
        const req = Boolean(input.takeProfitRequired) || input.rawWantsTp;
        return { fullPositionTpRequired: req, reason: req ? "V2_RANGE_FULL_TP_REQUIRED" : "V2_RANGE_TP_NOT_REQUESTED" };
    }

    if (!input.isV2Authority) {
        const req = input.regime === "RANGE" || Boolean(input.takeProfitRequired) || input.rawWantsTp;
        return { fullPositionTpRequired: req, reason: "LEGACY_TP_AUTHORITY" };
    }

    return { fullPositionTpRequired: false, reason: "DEFAULT_NO_FULL_TP" };
}

export function resolveOpsWatchTpRequired(input: Readonly<{
    isV2RangePartialPlan: boolean;
    isV2ManagedTrend: boolean;
    rawTpRequired: boolean;
}>): boolean {
    if (input.isV2RangePartialPlan) return false;
    if (input.isV2ManagedTrend) return input.rawTpRequired;
    return input.rawTpRequired;
}
