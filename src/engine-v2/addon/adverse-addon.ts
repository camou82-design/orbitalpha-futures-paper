import type { EvaluateV2AddOnPolicyArgs, V2AddOnPolicyResult } from "./types";
import type { EngineV2Side } from "../types";

export type V2AddonRiskProjection = Readonly<{
    projectedTotalNotionalUsdt: number;
    projectedWeightedAvgEntry: number;
    projectedStopPrice: number;
    projectedLossAtStopUsdt: number;
    riskBeforeAddonUsdt: number;
    riskBudgetUsdt: number;
    riskBudgetAllowedNotional: number;
}>;

export function hasHtfHardPolarityMismatch(side: "long" | "short", judgment: EvaluateV2AddOnPolicyArgs["judgment"]): boolean {
    if (judgment.counter_trend_risk === true) return true;
    const htf = String(judgment.htf_entry_policy ?? "").toUpperCase();
    if (side === "short" && (htf.includes("LONG_ONLY") || htf === "TOTAL_BULLISH_HTF")) return true;
    if (side === "long" && (htf.includes("SHORT_ONLY") || htf === "TOTAL_BEARISH_HTF")) return true;
    return false;
}

export function isThesisValidForAdverseAddon(
    side: "long" | "short",
    judgment: EvaluateV2AddOnPolicyArgs["judgment"],
    execution: EvaluateV2AddOnPolicyArgs["execution"]
): boolean {
    if (judgment.subtype === "WHIPSAW_SHOCK_RECHECK") return false;
    if (judgment.trendPhase === "EXHAUSTION") return false;
    const reversalAgainst =
        (side === "long" && judgment.trendPhase === "DOWN") ||
        (side === "short" && judgment.trendPhase === "UP");
    if (reversalAgainst) return false;
    const meta = (execution.metadata ?? {}) as Record<string, unknown>;
    if (meta.reversal_confirmed_against_position === true) return false;
    return true;
}

export function isAuthoritySameSideConfirmed(
    side: EngineV2Side,
    execution: EvaluateV2AddOnPolicyArgs["execution"]
): boolean {
    if (side !== "long" && side !== "short") return false;
    if (execution.side !== side) return false;
    const signal = String(execution.signal ?? "");
    if (side === "long" && signal !== "LONG_CANDIDATE") return false;
    if (side === "short" && signal !== "SHORT_CANDIDATE") return false;
    return true;
}

export function isPriceDistancePassedForAdverseAddon(
    side: "long" | "short",
    judgment: EvaluateV2AddOnPolicyArgs["judgment"],
    snapshot: EvaluateV2AddOnPolicyArgs["snapshot"],
    reviewingTicks: number,
    qualityScore: number
): boolean {
    if (judgment.regime_final === "RANGE") {
        const sideAtEdge =
            (side === "long" && judgment.rangePhase === "LOWER") ||
            (side === "short" && judgment.rangePhase === "UPPER");
        const rangeConfidence = Math.max(0, Number(snapshot.rangeConfidence ?? 0));
        return sideAtEdge && rangeConfidence >= 0.65 && (qualityScore >= 75 || reviewingTicks >= 2);
    }
    if (judgment.regime_final === "TREND") {
        const trendSideAligned =
            (side === "long" && (judgment.trendPhase === "UP" || judgment.trendPhase === "PULLBACK")) ||
            (side === "short" && (judgment.trendPhase === "DOWN" || judgment.trendPhase === "PULLBACK"));
        return trendSideAligned && (judgment.trendPhase === "PULLBACK" || reviewingTicks >= 2);
    }
    return false;
}

export function isInvalidationReached(
    side: "long" | "short",
    currentPrice: number,
    invalidationPx: number | null | undefined,
    stopPrice: number | null | undefined
): boolean {
    const px = invalidationPx ?? stopPrice;
    if (!(px != null && Number.isFinite(px) && px > 0) || !(currentPrice > 0)) return false;
    if (side === "long" && currentPrice <= px) return true;
    if (side === "short" && currentPrice >= px) return true;
    return false;
}

export function computeAdverseAddonRiskProjection(input: Readonly<{
    side: "long" | "short";
    entryPrice: number;
    currentPrice: number;
    currentNotionalUsdt: number;
    requestedAddonNotionalUsdt: number;
    atr: number;
    accountEquityUsd: number;
    leverage?: number;
}>): V2AddonRiskProjection {
    const lev = Math.max(1, input.leverage ?? 10);
    const currentMarginUsd = input.currentNotionalUsdt / lev;
    const addonNotional = Math.max(0, input.requestedAddonNotionalUsdt);
    const addonMarginUsd = addonNotional / lev;

    const projectedTotalNotionalUsdt = input.currentNotionalUsdt + addonNotional;
    const projectedWeightedAvgEntry =
        projectedTotalNotionalUsdt > 0
            ? (input.currentNotionalUsdt * input.entryPrice + addonNotional * input.currentPrice) / projectedTotalNotionalUsdt
            : input.entryPrice;

    const stopDistance = Math.max(input.currentPrice * 0.005, input.atr * 2.2);
    const projectedStopPrice =
        input.side === "long" ? input.currentPrice - stopDistance : input.currentPrice + stopDistance;

    const lossAtStop = (notional: number, entry: number): number => {
        if (!(notional > 0) || !(entry > 0)) return 0;
        const pnl =
            input.side === "long"
                ? notional * (projectedStopPrice - entry) / entry
                : notional * (entry - projectedStopPrice) / entry;
        return pnl < 0 ? Math.abs(pnl) : 0;
    };

    const riskBeforeAddonUsdt = lossAtStop(input.currentNotionalUsdt, input.entryPrice);
    const riskAfterAddonUsdt = lossAtStop(input.currentNotionalUsdt, input.entryPrice) + lossAtStop(addonNotional, input.currentPrice);
    const riskBudgetUsdt = Math.max(0.5, input.accountEquityUsd * 0.0015);
    const addonLossPctToStop =
        input.currentPrice > 0 ? Math.abs(input.currentPrice - projectedStopPrice) / input.currentPrice : 0.022;
    const riskBudgetAllowedNotional =
        addonLossPctToStop > 0 ? Math.max(0, (riskBudgetUsdt - riskBeforeAddonUsdt) / addonLossPctToStop) : 0;

    return {
        projectedTotalNotionalUsdt: Math.round(projectedTotalNotionalUsdt * 100) / 100,
        projectedWeightedAvgEntry: Math.round(projectedWeightedAvgEntry * 100) / 100,
        projectedStopPrice: Math.round(projectedStopPrice * 100) / 100,
        projectedLossAtStopUsdt: Math.round(riskAfterAddonUsdt * 100) / 100,
        riskBeforeAddonUsdt: Math.round(riskBeforeAddonUsdt * 100) / 100,
        riskBudgetUsdt: Math.round(riskBudgetUsdt * 100) / 100,
        riskBudgetAllowedNotional: Math.round(riskBudgetAllowedNotional * 100) / 100
    };
}

type AdverseBase = Omit<V2AddOnPolicyResult, "addonMode">;

function adverseWatch(
    base: AdverseBase,
    reason: V2AddOnPolicyResult["reason"],
    addonBlockedReason: string,
    extra: Partial<V2AddOnPolicyResult> = {}
): V2AddOnPolicyResult {
    return {
        ...base,
        action: "ADDON_WATCH",
        allowed: false,
        reason,
        addOnEligible: false,
        addonMode: "CONFIRMED_ADVERSE_ADDON",
        addonBlockedReason,
        evidence: addonBlockedReason.toLowerCase(),
        ...extra
    };
}

export function evaluateConfirmedAdverseAddOn(
    args: EvaluateV2AddOnPolicyArgs,
    base: AdverseBase
): V2AddOnPolicyResult {
    const { side, judgment, execution, snapshot, v2State } = args;
    if (side !== "long" && side !== "short") {
        return adverseWatch(base, "SIDE_NONE_FORBIDDEN", "AUTHORITY_SIDE_NONE");
    }

    const positionSide = String(base.hasSameSidePosition ? side : "").toLowerCase();
    if (positionSide !== side) {
        return adverseWatch(base, "SIDE_MISMATCH_FORBIDDEN", "AUTHORITY_SIDE_MISMATCH");
    }

    if (!isAuthoritySameSideConfirmed(side, execution)) {
        return adverseWatch(base, "SAME_SIDE_POSITION_WATCH_RECHECK", "SAME_SIDE_CONFIRMATION_NOT_MET");
    }

    if (!isThesisValidForAdverseAddon(side, judgment, execution)) {
        return adverseWatch(base, "SIDE_MISMATCH_FORBIDDEN", "THESIS_INVALIDATED");
    }

    if (hasHtfHardPolarityMismatch(side, judgment)) {
        return adverseWatch(base, "SIDE_MISMATCH_FORBIDDEN", "HTF_POLARITY_MISMATCH");
    }

    const currentPrice = Number(snapshot.lastPrice ?? 0);
    const invalidationPx = execution.invalidationPx ?? args.currentStopPrice ?? null;
    if (isInvalidationReached(side, currentPrice, invalidationPx, execution.stopPrice ?? args.currentStopPrice)) {
        return adverseWatch(base, "SIDE_MISMATCH_FORBIDDEN", "INVALIDATION_REACHED");
    }

    if (base.qualityScore < 70) {
        return adverseWatch(base, "QUALITY_TOO_LOW_FOR_ADDON", "QUALITY_NOT_MET");
    }

    const priceDistancePassed = isPriceDistancePassedForAdverseAddon(
        side,
        judgment,
        snapshot,
        base.reviewingTicks,
        base.qualityScore
    );
    if (!priceDistancePassed) {
        return adverseWatch(base, "RANGE_MID_ADDON_FORBIDDEN", "PRICE_DISTANCE_NOT_MET");
    }

    const accountEquityUsd = args.accountEquityUsd || (v2State.accountEquityKrw || 1_400_000) / 1400;
    const symbolMaxNotional = accountEquityUsd * 0.8;
    const globalMaxNotional = accountEquityUsd * 1.5;
    const currentSymbolNotionalUsd = args.currentSymbolNotionalUsd || 0;
    const currentGlobalNotionalUsd = args.currentGlobalNotionalUsd || currentSymbolNotionalUsd;
    const maxAddonNotionalUsdt = args.maxAddonNotionalUsdt ?? 20;

    const remainingSymbolCap = Math.max(0, symbolMaxNotional - currentSymbolNotionalUsd);
    const remainingAccountCap = Math.max(0, globalMaxNotional - currentGlobalNotionalUsd);

    if (remainingSymbolCap <= 0) {
        return adverseWatch(base, "SAME_SIDE_POSITION_WATCH_RECHECK", "MAX_SYMBOL_CAP", {
            addonMaxNotionalUsdt: 0
        });
    }
    if (remainingAccountCap <= 0) {
        return adverseWatch(base, "SAME_SIDE_POSITION_WATCH_RECHECK", "MAX_ACCOUNT_CAP", {
            addonMaxNotionalUsdt: 0
        });
    }

    const policySize = maxAddonNotionalUsdt;
    const sameSidePosition = side === "long" ? v2State.longPosition : v2State.shortPosition;
    const entryPrice = Number(sameSidePosition?.entryPrice ?? 0);
    const atrVal = Number(snapshot.atr || snapshot.volatilityProxyDiag || currentPrice * 0.005);
    const riskProjection = computeAdverseAddonRiskProjection({
        side,
        entryPrice,
        currentPrice,
        currentNotionalUsdt: currentSymbolNotionalUsd,
        requestedAddonNotionalUsdt: policySize,
        atr: atrVal,
        accountEquityUsd
    });

    const requestedAddonNotionalUsdt = Math.min(
        policySize,
        maxAddonNotionalUsdt,
        remainingSymbolCap,
        remainingAccountCap,
        riskProjection.riskBudgetAllowedNotional
    );

    const finalRisk = computeAdverseAddonRiskProjection({
        side,
        entryPrice,
        currentPrice,
        currentNotionalUsdt: currentSymbolNotionalUsd,
        requestedAddonNotionalUsdt,
        atr: atrVal,
        accountEquityUsd
    });

    if (finalRisk.projectedLossAtStopUsdt > finalRisk.riskBudgetUsdt) {
        return adverseWatch(base, "PROFIT_BUFFER_INSUFFICIENT", "RISK_BUDGET_EXCEEDED", {
            addonMaxNotionalUsdt: requestedAddonNotionalUsdt,
            requestedAddonNotionalUsdt: 0,
            availableRiskBudgetUsdt: finalRisk.riskBudgetUsdt,
            equityRiskCapUsdt: finalRisk.riskBudgetUsdt,
            riskProjection: finalRisk
        });
    }

    if (requestedAddonNotionalUsdt <= 0) {
        return adverseWatch(base, "PROFIT_BUFFER_INSUFFICIENT", "RISK_BUDGET_EXCEEDED", {
            addonMaxNotionalUsdt: 0,
            requestedAddonNotionalUsdt: 0,
            availableRiskBudgetUsdt: finalRisk.riskBudgetUsdt,
            riskProjection: finalRisk
        });
    }

    return {
        ...base,
        action: "ADDON_ALLOWED",
        allowed: true,
        reason: "CONFIRMED_ADVERSE_ADDON_ALLOWED",
        addOnEligible: true,
        addonMode: "CONFIRMED_ADVERSE_ADDON",
        addonMaxNotionalUsdt: requestedAddonNotionalUsdt,
        requestedAddonNotionalUsdt,
        availableRiskBudgetUsdt: finalRisk.riskBudgetUsdt,
        equityRiskCapUsdt: finalRisk.riskBudgetUsdt,
        thesisValid: true,
        sameSideConfirmation: true,
        priceDistancePassed: true,
        riskProjection: finalRisk,
        evidence: "confirmed_adverse_addon_allowed"
    };
}
