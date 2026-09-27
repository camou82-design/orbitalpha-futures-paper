import type { EvaluateV2AddOnPolicyArgs, V2AddOnPolicyResult } from "./types";
import type { HighwayLifecycleManagementAuthority } from "../highway-core/highway-lifecycle-authority";
import { resolveHighwayMinimumProtectedProfitUsd } from "../highway-core/highway-lifecycle-authority";
import { resolveV2AddonStopAuthority } from "./stop-authority";
import {
    MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
    MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
    highwayMarginTargetToNotionalUsdt
} from "../risk-sizing/equity-adaptive-sizing";

export type HighwayPyramidPolicyContext = Readonly<{
    side: "long" | "short";
    isInitial: boolean;
    isAddOn: boolean;
    currentStage: number;
    hasSameSidePosition: boolean;
    hasOppositeSidePosition: boolean;
    qualityScore: number;
    reviewingTicks: number;
    pnlPct: number;
    boxPos: number;
    emaGap: number;
    trendWeaknessScore: number;
    rangeConfidence: number;
    breakevenStopRequired: boolean;
    breakevenStopConfirmed: boolean;
    breakevenStopPrice?: number;
    sameSidePosition: NonNullable<
        EvaluateV2AddOnPolicyArgs["v2State"]["longPosition"] | EvaluateV2AddOnPolicyArgs["v2State"]["shortPosition"]
    >;
}>;

function withAddonMode<T extends V2AddOnPolicyResult>(
    result: T,
    addonMode: V2AddOnPolicyResult["addonMode"]
): T {
    return { ...result, addonMode: addonMode ?? "NONE" };
}

function logHighwayPyramidProof(payload: Record<string, unknown>): void {
    console.info(JSON.stringify({ event: "V2_HIGHWAY_LIFECYCLE_PYRAMID_AUTHORITY_PROOF", ...payload, ts: Date.now() }));
}

/** Single continuation authority: profit zone pyramid requires trend still structurally continuing. */
export function highwayPyramidTrendContinuationConfirmed(
    judgment: EvaluateV2AddOnPolicyArgs["judgment"],
    execution: EvaluateV2AddOnPolicyArgs["execution"],
    snapshot: EvaluateV2AddOnPolicyArgs["snapshot"]
): boolean {
    const execMeta = (execution?.metadata as Record<string, unknown> | undefined) ?? {};
    const metaSources = [execMeta, judgment as unknown as Record<string, unknown>, snapshot as Record<string, unknown>];
    const metaFlagTrue = (key: string): boolean => metaSources.some((src) => src != null && src[key] === true);
    const pullback =
        metaFlagTrue("pullbackConfirmed") ||
        (metaFlagTrue("retestTouched") && metaFlagTrue("retestRejected"));
    const subtype = String(judgment.subtype ?? "");
    const momentum =
        execMeta.highwayContinuationConfirmed === true ||
        execMeta.breakoutContinuationConfirmed === true ||
        execMeta.strongMomentumConfirmed === true ||
        subtype === "HIGHWAY_CONTINUATION" ||
        subtype === "BREAKOUT_CONTINUATION" ||
        subtype === "TREND_MOMENTUM";
    return pullback || momentum;
}

/** Highway lifecycle stage 3: protected profit pyramid (25% equity margin budget). */
export function evaluateHighwayLifecycleProtectedPyramidAddon(
    args: EvaluateV2AddOnPolicyArgs,
    highwayLifecycle: HighwayLifecycleManagementAuthority,
    ctx: HighwayPyramidPolicyContext
): V2AddOnPolicyResult {
    const { side, judgment, execution, snapshot, v2State } = args;
    const {
        isInitial,
        isAddOn,
        currentStage,
        hasSameSidePosition,
        hasOppositeSidePosition,
        qualityScore,
        reviewingTicks,
        pnlPct,
        boxPos,
        emaGap,
        trendWeaknessScore,
        rangeConfidence,
        breakevenStopRequired,
        breakevenStopConfirmed,
        breakevenStopPrice,
        sameSidePosition
    } = ctx;

    const accountEquityUsd = args.accountEquityUsd || (v2State.accountEquityKrw || 1400000) / 1400;
    const minimumProtectedProfitUsd = resolveHighwayMinimumProtectedProfitUsd(accountEquityUsd);
    const symbolMaxNotional = accountEquityUsd * MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE;
    const globalMaxNotional = accountEquityUsd * MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE;
    const currentSymbolNotionalUsd = args.currentSymbolNotionalUsd || (sameSidePosition?.sizeUsd ?? 0);
    const currentGlobalNotionalUsd = args.currentGlobalNotionalUsd || currentSymbolNotionalUsd;
    const sizeUsd = sameSidePosition?.sizeUsd ?? 0;
    const entryPrice = sameSidePosition?.entryPrice ?? 0;
    const currentPrice = Number(snapshot.lastPrice ?? entryPrice);

    const pyramidAppliedLeverage = Math.max(
        1,
        Number(sameSidePosition?.leverage ?? (execution as { appliedLeverage?: number })?.appliedLeverage ?? 10)
    );
    const targetPyramidNotionalUsdt = highwayMarginTargetToNotionalUsdt(
        accountEquityUsd * highwayLifecycle.pyramidMarginEquityFraction,
        pyramidAppliedLeverage
    );

    const currentPosProfitUsdt =
        side === "long" && entryPrice > 0
            ? (sizeUsd * (currentPrice - entryPrice)) / entryPrice
            : side === "short" && entryPrice > 0
              ? (sizeUsd * (entryPrice - currentPrice)) / entryPrice
              : 0;

    const baseProof = {
        symbol: String(args.symbol),
        side,
        lifecycle_stage: highwayLifecycle.stage,
        current_position_profit_usdt: Math.round(currentPosProfitUsdt * 100) / 100,
        target_pyramid_notional_usdt: Math.round(targetPyramidNotionalUsdt * 100) / 100,
        minimum_protected_profit_usdt: minimumProtectedProfitUsd
    };

    const htfOpposing =
        (side === "long" && (judgment.trendPhase === "DOWN" || (judgment.subtype as string) === "HTF_BEARISH")) ||
        (side === "short" && (judgment.trendPhase === "UP" || (judgment.subtype as string) === "HTF_BULLISH"));
    const metaReversal =
        (execution?.metadata as Record<string, unknown> | undefined)?.reversal_confirmed_against_position === true;
    const stabilizedOpposingShock =
        (side === "long" &&
            ((v2State.directionalShockState === "DOWN" && judgment.shockPhase === "DOWN_SHOCK") ||
                (typeof v2State.crashState === "string" && v2State.crashState.includes("CRASH_LOCK")))) ||
        (side === "short" &&
            ((v2State.directionalShockState === "UP" && judgment.shockPhase === "UP_SHOCK") ||
                (typeof v2State.pumpState === "string" && v2State.pumpState.includes("PUMP_LOCK"))));

    if (htfOpposing || metaReversal || stabilizedOpposingShock) {
        logHighwayPyramidProof({
            ...baseProof,
            blocking_authority: "OPPOSING_THREAT_ACTIVE",
            final_addon_notional_usdt: 0
        });
        return withAddonMode(
            {
                action: "ADDON_FORBIDDEN",
                allowed: false,
                reason: "SIDE_MISMATCH_FORBIDDEN",
                addOnEligible: false,
                isInitial,
                isAddOn,
                side,
                currentStage,
                hasSameSidePosition,
                hasOppositeSidePosition,
                marketRegime: judgment.regime_final,
                marketSubtype: judgment.subtype,
                shockPhase: judgment.shockPhase,
                rangePhase: judgment.rangePhase,
                trendPhase: judgment.trendPhase,
                transitionPhase: judgment.transitionPhase,
                qualityScore,
                reviewingTicks,
                pnlPct,
                boxPos,
                emaGap,
                trendWeaknessScore,
                rangeConfidence,
                breakevenStopRequired,
                breakevenStopConfirmed,
                breakevenStopPrice,
                addonBlockedReason: "OPPOSING_THREAT_ACTIVE",
                evidence: "highway_lifecycle_opposing_threat_blocks_pyramid"
            },
            "PYRAMIDING"
        );
    }

    if (currentPosProfitUsdt <= 0) {
        logHighwayPyramidProof({
            ...baseProof,
            blocking_authority: "POSITION_NOT_IN_PROFIT",
            final_addon_notional_usdt: 0
        });
        return withAddonMode(
            {
                action: "ADDON_WATCH",
                allowed: false,
                reason: "PROFIT_BUFFER_INSUFFICIENT",
                addOnEligible: false,
                isInitial,
                isAddOn,
                side,
                currentStage,
                hasSameSidePosition,
                hasOppositeSidePosition,
                marketRegime: judgment.regime_final,
                marketSubtype: judgment.subtype,
                shockPhase: judgment.shockPhase,
                rangePhase: judgment.rangePhase,
                trendPhase: judgment.trendPhase,
                transitionPhase: judgment.transitionPhase,
                qualityScore,
                reviewingTicks,
                pnlPct,
                boxPos,
                emaGap,
                trendWeaknessScore,
                rangeConfidence,
                breakevenStopRequired,
                breakevenStopConfirmed,
                breakevenStopPrice,
                lockedProfitUsdt: Math.round(currentPosProfitUsdt * 100) / 100,
                addonBlockedReason: "POSITION_NOT_IN_PROFIT",
                evidence: "highway_lifecycle_pyramid_requires_profit_zone"
            },
            "PYRAMIDING"
        );
    }

    if (!highwayPyramidTrendContinuationConfirmed(judgment, execution, snapshot)) {
        logHighwayPyramidProof({
            ...baseProof,
            blocking_authority: "TREND_CONTINUATION_NOT_CONFIRMED",
            final_addon_notional_usdt: 0
        });
        return withAddonMode(
            {
                action: "ADDON_WATCH",
                allowed: false,
                reason: "MOMENTUM_AUTHORITY_NOT_CONFIRMED",
                addOnEligible: false,
                isInitial,
                isAddOn,
                side,
                currentStage,
                hasSameSidePosition,
                hasOppositeSidePosition,
                marketRegime: judgment.regime_final,
                marketSubtype: judgment.subtype,
                shockPhase: judgment.shockPhase,
                rangePhase: judgment.rangePhase,
                trendPhase: judgment.trendPhase,
                transitionPhase: judgment.transitionPhase,
                qualityScore,
                reviewingTicks,
                pnlPct,
                boxPos,
                emaGap,
                trendWeaknessScore,
                rangeConfidence,
                breakevenStopRequired,
                breakevenStopConfirmed,
                breakevenStopPrice,
                addonBlockedReason: "TREND_CONTINUATION_NOT_CONFIRMED",
                evidence: "highway_lifecycle_pyramid_continuation_not_confirmed"
            },
            "PYRAMIDING"
        );
    }

    const stopAuthority = resolveV2AddonStopAuthority({
        symbol: String(args.symbol),
        side,
        position: sameSidePosition,
        algoOrders: (v2State as any).okxAlgoOrdersList ?? undefined,
        explicitStopPrice: args.currentStopPrice
    });

    const atr = Number(snapshot.atr || (snapshot.volatilityProxyDiag ?? 0));
    const stopDistance = atr * 2.2;
    const addonNotionalUsdt = Math.min(
        targetPyramidNotionalUsdt,
        Math.max(0, symbolMaxNotional - currentSymbolNotionalUsd),
        Math.max(0, globalMaxNotional - currentGlobalNotionalUsd)
    );
    const totalProjectedNotionalUsdt = sizeUsd + addonNotionalUsdt;
    const N1 = sizeUsd;
    const N2 = addonNotionalUsdt;
    const P1 = entryPrice;
    const P2 = currentPrice;
    const qtyDenominator = (P1 > 0 ? N1 / P1 : 0) + (P2 > 0 ? N2 / P2 : 0);
    const projectedWeightedAvgEntry = qtyDenominator > 0 ? (N1 + N2) / qtyDenominator : entryPrice;
    const projectedStopPrice =
        side === "long"
            ? (stopAuthority.activeStopPrice ?? currentPrice - stopDistance)
            : (stopAuthority.activeStopPrice ?? currentPrice + stopDistance);
    const grossProtectedProfitUsdt =
        side === "long"
            ? projectedWeightedAvgEntry > 0
                ? (totalProjectedNotionalUsdt * (projectedStopPrice - projectedWeightedAvgEntry)) /
                  projectedWeightedAvgEntry
                : 0
            : projectedWeightedAvgEntry > 0
              ? (totalProjectedNotionalUsdt * (projectedWeightedAvgEntry - projectedStopPrice)) /
                projectedWeightedAvgEntry
              : 0;
    const totalFrictionUsdt = totalProjectedNotionalUsdt * 0.0012;
    const netProtectedProfitUsdt = grossProtectedProfitUsdt - totalFrictionUsdt;
    const hasActiveStopLock = stopAuthority.isStopLockingProfit && stopAuthority.activeStopPrice !== null;

    const pyramidProofBase = {
        ...baseProof,
        active_stop_price: stopAuthority.activeStopPrice,
        stop_locks_profit: hasActiveStopLock,
        projected_net_protected_profit_usdt: Math.round(netProtectedProfitUsdt * 100) / 100,
        final_addon_notional_usdt: Math.round(addonNotionalUsdt * 100) / 100
    };

    if (!stopAuthority.isProtectiveStopRegistered || stopAuthority.activeStopPrice == null) {
        logHighwayPyramidProof({
            ...pyramidProofBase,
            blocking_authority: "PROTECTIVE_STOP_NOT_REGISTERED"
        });
        return withAddonMode(
            {
                action: "ADDON_WATCH",
                allowed: false,
                reason: "BREAKEVEN_STOP_NOT_CONFIRMED",
                addOnEligible: false,
                isInitial,
                isAddOn,
                side,
                currentStage,
                hasSameSidePosition,
                hasOppositeSidePosition,
                marketRegime: judgment.regime_final,
                marketSubtype: judgment.subtype,
                shockPhase: judgment.shockPhase,
                rangePhase: judgment.rangePhase,
                trendPhase: judgment.trendPhase,
                transitionPhase: judgment.transitionPhase,
                qualityScore,
                reviewingTicks,
                pnlPct,
                boxPos,
                emaGap,
                trendWeaknessScore,
                rangeConfidence,
                breakevenStopRequired,
                breakevenStopConfirmed,
                breakevenStopPrice,
                addonBlockedReason: "PROTECTIVE_STOP_NOT_REGISTERED",
                evidence: "highway_lifecycle_pyramid_requires_protective_stop"
            },
            "PYRAMIDING"
        );
    }

    if (!hasActiveStopLock) {
        logHighwayPyramidProof({
            ...pyramidProofBase,
            blocking_authority: "ACTUAL_STOP_NOT_LOCKING_PROFIT"
        });
        return withAddonMode(
            {
                action: "ADDON_WATCH",
                allowed: false,
                reason: "BREAKEVEN_STOP_NOT_CONFIRMED",
                addOnEligible: false,
                isInitial,
                isAddOn,
                side,
                currentStage,
                hasSameSidePosition,
                hasOppositeSidePosition,
                marketRegime: judgment.regime_final,
                marketSubtype: judgment.subtype,
                shockPhase: judgment.shockPhase,
                rangePhase: judgment.rangePhase,
                trendPhase: judgment.trendPhase,
                transitionPhase: judgment.transitionPhase,
                qualityScore,
                reviewingTicks,
                pnlPct,
                boxPos,
                emaGap,
                trendWeaknessScore,
                rangeConfidence,
                breakevenStopRequired,
                breakevenStopConfirmed,
                breakevenStopPrice,
                addonBlockedReason: "ACTUAL_STOP_NOT_LOCKING_PROFIT",
                evidence: "highway_lifecycle_stop_not_locking_profit"
            },
            "PYRAMIDING"
        );
    }

    if (netProtectedProfitUsdt < minimumProtectedProfitUsd) {
        logHighwayPyramidProof({
            ...pyramidProofBase,
            blocking_authority: "NET_PROTECTED_PROFIT_BELOW_MINIMUM"
        });
        return withAddonMode(
            {
                action: "ADDON_WATCH",
                allowed: false,
                reason: "PROFIT_BUFFER_INSUFFICIENT",
                addOnEligible: false,
                isInitial,
                isAddOn,
                side,
                currentStage,
                hasSameSidePosition,
                hasOppositeSidePosition,
                marketRegime: judgment.regime_final,
                marketSubtype: judgment.subtype,
                shockPhase: judgment.shockPhase,
                rangePhase: judgment.rangePhase,
                trendPhase: judgment.trendPhase,
                transitionPhase: judgment.transitionPhase,
                qualityScore,
                reviewingTicks,
                pnlPct,
                boxPos,
                emaGap,
                trendWeaknessScore,
                rangeConfidence,
                breakevenStopRequired,
                breakevenStopConfirmed,
                breakevenStopPrice: projectedStopPrice,
                lockedProfitUsdt: Math.round(netProtectedProfitUsdt * 100) / 100,
                addonBlockedReason: "NET_PROTECTED_PROFIT_BELOW_MINIMUM",
                evidence: "highway_lifecycle_net_protected_profit_below_minimum"
            },
            "PYRAMIDING"
        );
    }

    if (addonNotionalUsdt <= 0) {
        logHighwayPyramidProof({
            ...pyramidProofBase,
            blocking_authority: "SYMBOL_OR_ACCOUNT_NOTIONAL_CAP"
        });
        return withAddonMode(
            {
                action: "ADDON_FORBIDDEN",
                allowed: false,
                reason: "CURRENT_STAGE_LIMIT",
                addOnEligible: false,
                isInitial,
                isAddOn,
                side,
                currentStage,
                hasSameSidePosition,
                hasOppositeSidePosition,
                marketRegime: judgment.regime_final,
                marketSubtype: judgment.subtype,
                shockPhase: judgment.shockPhase,
                rangePhase: judgment.rangePhase,
                trendPhase: judgment.trendPhase,
                transitionPhase: judgment.transitionPhase,
                qualityScore,
                reviewingTicks,
                pnlPct,
                boxPos,
                emaGap,
                trendWeaknessScore,
                rangeConfidence,
                breakevenStopRequired,
                breakevenStopConfirmed,
                breakevenStopPrice,
                addonBlockedReason: "NOTIONAL_CAP_EXCEEDED",
                evidence: "highway_lifecycle_pyramid_cap_binding"
            },
            "PYRAMIDING"
        );
    }

    const pullbackMode =
        (execution?.metadata as Record<string, unknown> | undefined)?.pullbackConfirmed === true ||
        ((execution?.metadata as Record<string, unknown> | undefined)?.retestTouched === true &&
            (execution?.metadata as Record<string, unknown> | undefined)?.retestRejected === true);
    const pyramidReason = pullbackMode
        ? "HIGHWAY_PULLBACK_PYRAMID_ALLOWED"
        : "HIGHWAY_MOMENTUM_CONTINUATION_PYRAMID_ALLOWED";
    const pyramidEvidence = pullbackMode
        ? "highway_lifecycle_pullback_pyramid_allowed"
        : "highway_lifecycle_momentum_pyramid_allowed";

    logHighwayPyramidProof({
        ...pyramidProofBase,
        blocking_authority: "NONE"
    });

    return withAddonMode(
        {
            action: "ADDON_ALLOWED",
            allowed: true,
            reason: pyramidReason,
            addOnEligible: true,
            isInitial,
            isAddOn,
            side,
            currentStage,
            hasSameSidePosition,
            hasOppositeSidePosition,
            marketRegime: judgment.regime_final,
            marketSubtype: judgment.subtype,
            shockPhase: judgment.shockPhase,
            rangePhase: judgment.rangePhase,
            trendPhase: judgment.trendPhase,
            transitionPhase: judgment.transitionPhase,
            qualityScore,
            reviewingTicks,
            pnlPct,
            boxPos,
            emaGap,
            trendWeaknessScore,
            rangeConfidence,
            lockedProfitUsdt: Math.round(netProtectedProfitUsdt * 100) / 100,
            availableRiskBudgetUsdt: Math.round((netProtectedProfitUsdt - minimumProtectedProfitUsd) * 100) / 100,
            addonMaxNotionalUsdt: addonNotionalUsdt,
            requestedAddonNotionalUsdt: addonNotionalUsdt,
            breakevenStopRequired,
            breakevenStopConfirmed,
            breakevenStopPrice: projectedStopPrice,
            thesisValid: true,
            sameSideConfirmation: true,
            priceDistancePassed: true,
            riskProjection: {
                projectedTotalNotionalUsdt: Math.round(totalProjectedNotionalUsdt * 100) / 100,
                projectedWeightedAvgEntry: Math.round(projectedWeightedAvgEntry * 100) / 100,
                projectedStopPrice: Math.round(projectedStopPrice * 100) / 100,
                projectedGrossProtectedProfitAtStopUsdt: Math.round(grossProtectedProfitUsdt * 100) / 100,
                projectedNetProtectedProfitAtStopUsdt: Math.round(netProtectedProfitUsdt * 100) / 100,
                riskBeforeAddonUsdt: Math.round(currentPosProfitUsdt * 100) / 100,
                riskBudgetUsdt: Math.round(netProtectedProfitUsdt * 100) / 100,
                riskBudgetAllowedNotional: Math.round(addonNotionalUsdt * 100) / 100
            },
            evidence: pyramidEvidence
        },
        "PYRAMIDING"
    );
}
