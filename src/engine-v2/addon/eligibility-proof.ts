import type { V2AddOnPolicyResult, V2AddonMode } from "./types";

export type V2AddonEligibilityProofPayload = Readonly<{
    event: "V2_ADDON_ELIGIBILITY_PROOF";
    addon_mode: V2AddonMode;
    symbol: string;
    position_side: "long" | "short" | null;
    authority_side: "long" | "short" | "none";
    entry_price: number;
    current_price: number;
    unrealized_pnl_pct: number;
    adverse_move_pct: number;
    thesis_valid: boolean;
    same_side_confirmation: boolean;
    quality_score: number;
    price_distance_passed: boolean;
    current_notional_usdt: number;
    requested_addon_notional_usdt: number;
    projected_symbol_notional_usdt: number;
    projected_weighted_avg_entry: number;
    stop_price: number;
    risk_before_addon_usdt: number;
    risk_after_addon_usdt: number;
    risk_budget_usdt: number;
    add_on_allowed: boolean;
    block_reason: string | null;
}>;

export function computeAdverseMovePct(
    positionSide: "long" | "short" | null,
    entryPrice: number,
    currentPrice: number
): number {
    if (positionSide == null || !(entryPrice > 0) || !(currentPrice > 0)) return 0;
    const raw =
        positionSide === "long"
            ? (entryPrice - currentPrice) / entryPrice
            : (currentPrice - entryPrice) / entryPrice;
    return raw > 0 ? Math.round(raw * 1_000_000) / 1_000_000 : 0;
}

export function computeUnrealizedPnlPct(
    positionSide: "long" | "short" | null,
    entryPrice: number,
    currentPrice: number
): number {
    if (positionSide == null || !(entryPrice > 0) || !(currentPrice > 0)) return 0;
    const raw =
        positionSide === "long"
            ? (currentPrice - entryPrice) / entryPrice
            : (entryPrice - currentPrice) / entryPrice;
    return Math.round(raw * 1_000_000) / 1_000_000;
}

function mapPolicyBlockReason(addOnPolicy: Pick<V2AddOnPolicyResult, "allowed" | "reason" | "addonBlockedReason" | "addonMode">): string {
    if (addOnPolicy.addonBlockedReason && addOnPolicy.addonBlockedReason.length > 0) {
        return addOnPolicy.addonBlockedReason;
    }
    switch (addOnPolicy.reason) {
        case "QUALITY_TOO_LOW_FOR_ADDON":
            return "QUALITY_NOT_MET";
        case "BREAKEVEN_STOP_NOT_CONFIRMED":
            return addOnPolicy.addonMode === "PYRAMIDING"
                ? "PYRAMIDING_CONFIRMATION_NOT_MET"
                : "SAME_SIDE_CONFIRMATION_NOT_MET";
        case "SIDE_MISMATCH_FORBIDDEN":
            return "AUTHORITY_SIDE_MISMATCH";
        case "RANGE_MID_ADDON_FORBIDDEN":
            return "PRICE_DISTANCE_NOT_MET";
        case "SIDE_NONE_FORBIDDEN":
            return "AUTHORITY_SIDE_NONE";
        case "PROFIT_BUFFER_INSUFFICIENT":
            return addOnPolicy.addonMode === "CONFIRMED_ADVERSE_ADDON"
                ? "RISK_BUDGET_EXCEEDED"
                : "PROFIT_BUFFER_INSUFFICIENT";
        default:
            return String(addOnPolicy.reason);
    }
}

export function resolveV2AddonBlockReason(input: Readonly<{
    authoritySide: "long" | "short" | "none";
    positionSide: "long" | "short" | null;
    addOnPolicy: Pick<
        V2AddOnPolicyResult,
        "allowed" | "reason" | "addonBlockedReason" | "addonMode"
    >;
    executionAction: string;
    finalDecision: string;
    liveReadinessPassed: boolean;
    okxPendingOrdersReady: boolean;
    minOrderBlockReason: string | null;
    riskBlockReason: string | null;
    cooldownBlocked: boolean;
    cooldownReason: string | null;
}>): string | null {
    const addOnReachable =
        input.finalDecision === "ENTER" &&
        input.executionAction === "ADDON" &&
        input.addOnPolicy.allowed === true &&
        input.liveReadinessPassed &&
        input.minOrderBlockReason == null &&
        input.riskBlockReason == null &&
        !input.cooldownBlocked;

    if (addOnReachable) return null;

    if (input.authoritySide === "none") return "AUTHORITY_SIDE_NONE";
    if (
        input.positionSide != null &&
        input.authoritySide !== input.positionSide
    ) {
        return "AUTHORITY_SIDE_MISMATCH";
    }
    if (!input.okxPendingOrdersReady || input.minOrderBlockReason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY") {
        return "LIVE_ACCOUNT_AUTHORITY_NOT_READY";
    }
    if (!input.liveReadinessPassed && input.minOrderBlockReason != null) {
        return input.minOrderBlockReason;
    }
    if (!input.liveReadinessPassed) return "LIVE_ACCOUNT_AUTHORITY_NOT_READY";
    if (input.cooldownBlocked) return input.cooldownReason ?? "COOLDOWN";
    if (input.minOrderBlockReason === "MAX_ADDON_COUNT_EXCEEDED") return "MAX_ADDON_CAP";
    if (input.minOrderBlockReason === "MAX_SYMBOL_NOTIONAL_EXCEEDED") return "MAX_SYMBOL_CAP";
    if (input.minOrderBlockReason === "MAX_ACCOUNT_NOTIONAL_EXCEEDED") return "MAX_ACCOUNT_CAP";
    if (input.minOrderBlockReason != null) return input.minOrderBlockReason;
    if (!input.addOnPolicy.allowed) return mapPolicyBlockReason(input.addOnPolicy);
    if (input.riskBlockReason != null) return input.riskBlockReason;
    if (input.finalDecision !== "ENTER") return "AUTHORITY_NOT_ENTER";
    if (input.executionAction !== "ADDON") return "ADDON_PATH_NOT_REACHABLE";
    return "OTHER_BLOCKER";
}

export function buildV2AddonEligibilityProof(input: Readonly<{
    symbol: string;
    positionSide: "long" | "short" | null;
    authoritySide: "long" | "short" | "none";
    currentNotionalUsdt: number;
    addonRequestedNotionalUsdt: number;
    addOnPolicy: V2AddOnPolicyResult;
    executionAction: string;
    finalDecision: string;
    liveReadinessPassed: boolean;
    okxPendingOrdersReady: boolean;
    minOrderBlockReason: string | null;
    riskBlockReason: string | null;
    cooldownBlocked: boolean;
    cooldownReason: string | null;
    currentPrice: number;
    entryPrice: number;
}>): V2AddonEligibilityProofPayload {
    const blockReason = resolveV2AddonBlockReason(input);
    const addOnAllowed = blockReason == null;
    const risk = input.addOnPolicy.riskProjection;
    const unrealizedPnlPct =
        input.addOnPolicy.pnlPct !== 0
            ? input.addOnPolicy.pnlPct
            : computeUnrealizedPnlPct(input.positionSide, input.entryPrice, input.currentPrice);

    return {
        event: "V2_ADDON_ELIGIBILITY_PROOF",
        addon_mode: input.addOnPolicy.addonMode ?? "NONE",
        symbol: input.symbol,
        position_side: input.positionSide,
        authority_side: input.authoritySide,
        entry_price: input.entryPrice,
        current_price: input.currentPrice,
        unrealized_pnl_pct: unrealizedPnlPct,
        adverse_move_pct: computeAdverseMovePct(input.positionSide, input.entryPrice, input.currentPrice),
        thesis_valid: input.addOnPolicy.thesisValid === true,
        same_side_confirmation: input.addOnPolicy.sameSideConfirmation === true,
        quality_score: input.addOnPolicy.qualityScore,
        price_distance_passed: input.addOnPolicy.priceDistancePassed === true,
        current_notional_usdt: Math.round(input.currentNotionalUsdt * 100) / 100,
        requested_addon_notional_usdt: Math.round(
            (input.addOnPolicy.requestedAddonNotionalUsdt ?? input.addonRequestedNotionalUsdt) * 100
        ) / 100,
        projected_symbol_notional_usdt: risk?.projectedTotalNotionalUsdt ?? input.currentNotionalUsdt,
        projected_weighted_avg_entry: risk?.projectedWeightedAvgEntry ?? input.entryPrice,
        stop_price: risk?.projectedStopPrice ?? 0,
        risk_before_addon_usdt: risk?.riskBeforeAddonUsdt ?? 0,
        risk_after_addon_usdt: risk?.projectedLossAtStopUsdt ?? 0,
        risk_budget_usdt: risk?.riskBudgetUsdt ?? input.addOnPolicy.availableRiskBudgetUsdt ?? 0,
        add_on_allowed: addOnAllowed,
        block_reason: blockReason
    };
}
