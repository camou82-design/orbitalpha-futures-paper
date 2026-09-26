import type { EvaluateV2AddOnPolicyArgs, V2AddOnPolicyResult } from "./types";
import { evaluateConfirmedAdverseAddOn } from "./adverse-addon";
import { resolveV2AddonStopAuthority } from "./stop-authority";
import {
    evaluatePostShockProbeStandardPromotionRelease
} from "../market-judgment/post-shock-probe-promotion-gate";
import { V2_POST_SHOCK_COUNTER_PROBE_SEMANTIC } from "../market-judgment/post-shock-probe-episode-authority";
import {
    MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
    MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE
} from "../risk-sizing/equity-adaptive-sizing";

function withAddonMode<T extends V2AddOnPolicyResult>(result: T, addonMode: V2AddOnPolicyResult["addonMode"]): T {
    return { ...result, addonMode: addonMode ?? "NONE" };
}

function evaluateV2AddOnPolicyCore(args: EvaluateV2AddOnPolicyArgs): V2AddOnPolicyResult {
    const { side, v2State, judgment, execution, snapshot } = args;
    const qualityScore = Math.max(0, Number(snapshot.qualityScore ?? 0));
    const reviewingTicks = Math.max(0, Number(snapshot.reviewing_ticks ?? 0));
    const boxPos = Number(snapshot.boxPos ?? 0.5);
    const emaGap = Number(snapshot.emaGap ?? 0);
    const trendWeaknessScore = Math.max(0, Number(snapshot.trendWeaknessScore ?? 1));
    const rangeConfidence = Math.max(0, Number(snapshot.rangeConfidence ?? 0));
    const sameSidePosition =
        side === "long"
            ? v2State.longPosition
            : side === "short"
                ? v2State.shortPosition
                : null;
    const oppositeSidePosition =
        side === "long"
            ? v2State.shortPosition
            : side === "short"
                ? v2State.longPosition
                : null;
    const hasSameSidePosition = sameSidePosition != null;
    const hasOppositeSidePosition = oppositeSidePosition != null;
    const isAddOn = hasSameSidePosition;
    const isInitial = !isAddOn;
    const currentStage = sameSidePosition ? Math.max(1, Number(sameSidePosition.entryStage ?? 1)) : 0;
    const pnlPct = Number(sameSidePosition?.pnlPct ?? 0);
    const breakevenStopRequired = sameSidePosition?.breakevenStopRequired ?? false;
    const breakevenStopConfirmed = sameSidePosition?.breakevenStopConfirmed ?? false;
    const breakevenStopPrice = sameSidePosition?.breakevenStopPrice;
    const shockLockish =
        judgment.shockPhase === "DOWN_SHOCK" ||
        judgment.shockPhase === "UP_SHOCK" ||
        (typeof v2State.crashState === "string" && v2State.crashState.includes("CRASH_LOCK")) ||
        (typeof v2State.pumpState === "string" && v2State.pumpState.includes("PUMP_LOCK"));

    if (side !== "long" && side !== "short") {
        return {
            action: "ADDON_FORBIDDEN",
            allowed: false,
            reason: "SIDE_NONE_FORBIDDEN",
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
            evidence: "side_none_forbidden"
        };
    }
    if (sameSidePosition?.entrySemantic === V2_POST_SHOCK_COUNTER_PROBE_SEMANTIC) {
        if (sameSidePosition?.postShockProbePromotionState === "STANDARD_PROMOTED") {
            return {
                action: "ADDON_FORBIDDEN",
                allowed: false,
                reason: "POST_SHOCK_PROBE_STANDARD_PROMOTION_ALREADY_CONSUMED",
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
                postShockProbePromotionState: "STANDARD_PROMOTED",
                breakevenStopRequired,
                breakevenStopConfirmed,
                breakevenStopPrice,
                evidence: "post_shock_probe_standard_promotion_already_consumed"
            };
        }
        if (sameSidePosition?.postShockProbePromotionState === "PROBE_ONLY") {
            const stopPx =
                typeof sameSidePosition.ledger_stop_px === "number" && sameSidePosition.ledger_stop_px > 0
                    ? sameSidePosition.ledger_stop_px
                    : typeof snapshot.lastPrice === "number" && snapshot.lastPrice > 0
                        ? snapshot.lastPrice * (side === "long" ? 0.99 : 1.01)
                        : 0;
            const lastPx = Number(snapshot.lastPrice ?? 0);
            const tp1 =
                typeof sameSidePosition.takeProfitPlan?.tp1 === "number" && sameSidePosition.takeProfitPlan.tp1 > 0
                    ? sameSidePosition.takeProfitPlan.tp1
                    : stopPx > 0 && lastPx > 0
                        ? side === "long"
                            ? lastPx * 1.01
                            : lastPx * 0.99
                        : 0;
            const promotionRelease = evaluatePostShockProbeStandardPromotionRelease({
                symbol: String(args.symbol),
                side,
                regime: judgment.regime_final ?? judgment.regime,
                snapshot,
                directionalShockState: v2State.directionalShockState ?? judgment.shockPhase,
                stopPrice: stopPx,
                takeProfit1Px: tp1
            });
            if (!promotionRelease.eligible) {
                return {
                    action: "ADDON_FORBIDDEN",
                    allowed: false,
                    reason: "POST_SHOCK_PROBE_ONLY_STANDARD_GATE_PENDING",
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
                    postShockProbePromotionState: "PROBE_ONLY",
                    breakevenStopRequired,
                    breakevenStopConfirmed,
                    breakevenStopPrice,
                    evidence: promotionRelease.reason
                };
            }
        }
    }
    if (judgment.subtype === "WHIPSAW_SHOCK_RECHECK") {
        return {
            action: "ADDON_FORBIDDEN",
            allowed: false,
            reason: "WHIPSAW_SHOCK_RECHECK_ADDON_FORBIDDEN",
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
            evidence: "whipsaw_shock_recheck_blocks_addon"
        };
    }
    if (hasOppositeSidePosition) {
        return {
            action: "ADDON_FORBIDDEN",
            allowed: false,
            reason: "OPPOSITE_POSITION_EXISTS_FORBIDDEN",
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
            evidence: "opposite_position_exists"
        };
    }
    if (!hasSameSidePosition) {
        return {
            action: "INITIAL_ONLY",
            allowed: false,
            reason: "NO_EXISTING_POSITION_INITIAL_ONLY",
            addOnEligible: false,
            isInitial: true,
            isAddOn: false,
            side,
            currentStage: 0,
            hasSameSidePosition: false,
            hasOppositeSidePosition,
            marketRegime: judgment.regime_final,
            marketSubtype: judgment.subtype,
            shockPhase: judgment.shockPhase,
            rangePhase: judgment.rangePhase,
            trendPhase: judgment.trendPhase,
            transitionPhase: judgment.transitionPhase,
            qualityScore,
            reviewingTicks,
            pnlPct: 0,
            boxPos,
            emaGap,
            trendWeaknessScore,
            rangeConfidence,
            breakevenStopRequired,
            breakevenStopConfirmed,
            breakevenStopPrice,
            evidence: "no_existing_position_initial_only"
        };
    }

    if (shockLockish) {
        return withAddonMode({
            action: "ADDON_FORBIDDEN",
            allowed: false,
            reason: "SHOCK_ADDON_FORBIDDEN",
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
            evidence: "shock_or_lockish_state"
        }, pnlPct <= 0 ? "CONFIRMED_ADVERSE_ADDON" : "PYRAMIDING");
    }

    const isRangeToTrendException =
        (judgment.regime_final === "RANGE" || judgment.regime_final === "TREND") &&
        judgment.transitionPhase === "RANGE_TO_TREND" &&
        hasSameSidePosition &&
        !hasOppositeSidePosition &&
        pnlPct > 0 &&
        !shockLockish;

    const transitionPhase = judgment.transitionPhase || "NONE";
    const isTransitionBlocked =
        judgment.regime_final === "TRANSITION" ||
        (transitionPhase !== "NONE" && !isRangeToTrendException);

    if (isTransitionBlocked) {
        return {
            action: "ADDON_FORBIDDEN",
            allowed: false,
            reason: "TRANSITION_ADDON_FORBIDDEN",
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
            evidence: "transition_addon_forbidden"
        };
    }
    if (judgment.rangePhase === "MID") {
        return {
            action: "ADDON_FORBIDDEN",
            allowed: false,
            reason: "RANGE_MID_ADDON_FORBIDDEN",
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
            evidence: "range_mid_forbidden"
        };
    }
    // Stage limit removed to allow Profit-Funded Pyramid in TREND
    if (qualityScore < 70 && pnlPct > 0) {
        return withAddonMode({
            action: "ADDON_WATCH",
            allowed: false,
            reason: "QUALITY_TOO_LOW_FOR_ADDON",
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
            addonBlockedReason: "QUALITY_NOT_MET",
            evidence: "pyramiding_quality_score_too_low"
        }, "PYRAMIDING");
    }

    if (pnlPct <= 0) {
        const adverseBase: V2AddOnPolicyResult = {
            action: "ADDON_WATCH",
            allowed: false,
            reason: "SAME_SIDE_POSITION_WATCH_RECHECK",
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
            evidence: "adverse_addon_evaluation"
        };
        return evaluateConfirmedAdverseAddOn(args, adverseBase);
    }

    if (judgment.regime_final === "RANGE") {
        const sideAtEdge =
            (side === "long" && judgment.rangePhase === "LOWER") ||
            (side === "short" && judgment.rangePhase === "UPPER");
        const canReattack = sideAtEdge && rangeConfidence >= 0.65 && (qualityScore >= 75 || reviewingTicks >= 2) && currentStage <= 2 && pnlPct > -0.0015;
        if (canReattack && !breakevenStopConfirmed) {
             return {
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
                addonBlockedReason: "BREAKEVEN_STOP_NOT_CONFIRMED",
                evidence: "range_reattack_breakeven_gate_block"
            };
        }
        if (canReattack) {
            const accountEquityUsd = args.accountEquityUsd || (v2State.accountEquityKrw || 1400000) / 1400;
            const symbolMaxNotional = accountEquityUsd * MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE;
            const globalMaxNotional = accountEquityUsd * MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE;

            const currentSymbolNotionalUsd = args.currentSymbolNotionalUsd || (sameSidePosition?.sizeUsd ?? 0);
            const currentGlobalNotionalUsd = args.currentGlobalNotionalUsd || currentSymbolNotionalUsd;

            const remainingSymbolCap = Math.max(0, symbolMaxNotional - currentSymbolNotionalUsd);
            const remainingAccountCap = Math.max(0, globalMaxNotional - currentGlobalNotionalUsd);

            const currentPrice = Number(snapshot.lastPrice ?? 0);
            const atr = Number(snapshot.atr || snapshot.volatilityProxyDiag || (currentPrice > 0 ? currentPrice * 0.005 : 0));
            const stopDistance = atr > 0 ? atr * 2.2 : (currentPrice > 0 ? currentPrice * 0.022 : 0);
            const stopDistancePct = currentPrice > 0 && stopDistance > 0 ? Math.max(0.005, stopDistance / currentPrice) : 0.022;

            // Target risk budget for RANGE reattack: 1.0% of equity
            const targetRiskBudgetUsdt = accountEquityUsd * 0.010;
            const riskBasedNotional = targetRiskBudgetUsdt / stopDistancePct;

            const addonMaxNotionalUsdt = Math.max(0, Math.min(
                riskBasedNotional,
                remainingSymbolCap,
                remainingAccountCap
            ));

            if (addonMaxNotionalUsdt <= 0 || remainingSymbolCap <= 0 || remainingAccountCap <= 0) {
                return withAddonMode({
                    action: "ADDON_WATCH",
                    allowed: false,
                    reason: "SAME_SIDE_POSITION_WATCH_RECHECK",
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
                    addonMaxNotionalUsdt: 0,
                    requestedAddonNotionalUsdt: 0,
                    addonBlockedReason: remainingSymbolCap <= 0 ? "MAX_SYMBOL_CAP" : remainingAccountCap <= 0 ? "MAX_ACCOUNT_CAP" : "RISK_BUDGET_EXCEEDED",
                    evidence: "range_edge_reattack_cap_exceeded"
                }, "PYRAMIDING");
            }

            return withAddonMode({
                action: "ADDON_ALLOWED",
                allowed: true,
                reason: "RANGE_EDGE_REATTACK_ALLOWED",
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
                breakevenStopRequired,
                breakevenStopConfirmed,
                breakevenStopPrice,
                addonMaxNotionalUsdt,
                requestedAddonNotionalUsdt: addonMaxNotionalUsdt,
                thesisValid: true,
                sameSideConfirmation: breakevenStopConfirmed,
                priceDistancePassed: true,
                evidence: "range_edge_reattack_allowed"
            }, "PYRAMIDING");
        }
        return withAddonMode({
            action: "ADDON_WATCH",
            allowed: false,
            reason: "SAME_SIDE_POSITION_WATCH_RECHECK",
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
            evidence: "range_addon_watch_recheck"
        }, "PYRAMIDING");
    }

    if (judgment.regime_final === "TREND") {
        if (judgment.trendPhase === "EXHAUSTION") {
            return {
                action: "ADDON_FORBIDDEN",
                allowed: false,
                reason: "QUALITY_TOO_LOW_FOR_ADDON",
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
                evidence: "trend_exhaustion_blocks_addon"
            };
        }

        const trendSideAligned =
            (side === "long" && (judgment.trendPhase === "UP" || judgment.trendPhase === "PULLBACK")) ||
            (side === "short" && (judgment.trendPhase === "DOWN" || judgment.trendPhase === "PULLBACK"));

        if (!trendSideAligned) {
            return withAddonMode({
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
                evidence: "trend_side_mismatch"
            }, "PYRAMIDING");
        }

        const adverseAddonCount = Math.max(0, Number(sameSidePosition?.adverseAddonCount ?? 0));
        if (adverseAddonCount > 0) {
            return withAddonMode({
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
                addonBlockedReason: "PYRAMID_FORBIDDEN_AFTER_ADVERSE_ADD",
                evidence: "pyramid_forbidden_after_adverse_add"
            }, "PYRAMIDING");
        }

        // --- Highway / TREND Profit-Funded Pyramid Implementation ---
        const accountEquityUsd = args.accountEquityUsd || (v2State.accountEquityKrw || 1400000) / 1400;
        const targetPyramidNotionalUsdt = accountEquityUsd * 0.25;
        const minimumProtectedProfitUsd = Math.max(0.5, accountEquityUsd * 0.0015);
        const symbolMaxNotional = accountEquityUsd * MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE;
        const globalMaxNotional = accountEquityUsd * MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE;

        const currentSymbolNotionalUsd = args.currentSymbolNotionalUsd || (sameSidePosition?.sizeUsd ?? 0);
        const currentGlobalNotionalUsd = args.currentGlobalNotionalUsd || currentSymbolNotionalUsd;

        const sizeUsd = sameSidePosition?.sizeUsd ?? 0;
        const entryPrice = sameSidePosition?.entryPrice ?? 0;
        const currentPrice = Number(snapshot.lastPrice ?? entryPrice);

        // Check Highway Lineage
        const isHighway =
            sameSidePosition?.isHighwayLineage === true ||
            sameSidePosition?.entrySemantic === "HIGHWAY" ||
            sameSidePosition?.entrySemantic === "HIGHWAY_CORE" ||
            sameSidePosition?.v2EntryReason === "HIGHWAY_CORE_ENTRY" ||
            sameSidePosition?.v2EntryReason === "HIGHWAY_CORE_TREND_PROBE" ||
            (execution?.metadata as Record<string, unknown> | undefined)?.isHighwayLineage === true ||
            (execution as any)?.entrySemantic === "HIGHWAY" ||
            (execution as any)?.entrySemantic === "HIGHWAY_CORE";

        // Opposing Threat Guards (HTF polarity mismatch / reversal / stabilized opposing shock)
        const htfOpposing =
            (side === "long" && (judgment.trendPhase === "DOWN" || (judgment.subtype as string) === "HTF_BEARISH")) ||
            (side === "short" && (judgment.trendPhase === "UP" || (judgment.subtype as string) === "HTF_BULLISH"));
        const metaReversal = (execution?.metadata as Record<string, unknown> | undefined)?.reversal_confirmed_against_position === true;
        const stabilizedOpposingShock =
            (side === "long" && (
                (v2State.directionalShockState === "DOWN" && judgment.shockPhase === "DOWN_SHOCK") ||
                (typeof v2State.crashState === "string" && v2State.crashState.includes("CRASH_LOCK"))
            )) ||
            (side === "short" && (
                (v2State.directionalShockState === "UP" && judgment.shockPhase === "UP_SHOCK") ||
                (typeof v2State.pumpState === "string" && v2State.pumpState.includes("PUMP_LOCK"))
            ));

        if (htfOpposing || metaReversal || stabilizedOpposingShock) {
            return withAddonMode({
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
                evidence: "opposing_threat_active_blocks_pyramid"
            }, "PYRAMIDING");
        }

        // 1. Breakeven / Actual Protective Stop Check via Authority
        const isBreakevenStopConfirmed = breakevenStopConfirmed;
        const isBreakevenStopRequired = breakevenStopRequired;
        const stopAuthority = resolveV2AddonStopAuthority({
            symbol: String(args.symbol),
            side,
            position: sameSidePosition,
            algoOrders: (v2State as any).okxAlgoOrdersList ?? undefined,
            explicitStopPrice: args.currentStopPrice
        });

        console.info(JSON.stringify({
            event: "V2_ADDON_STOP_AUTHORITY_PROOF",
            symbol: String(args.symbol),
            side,
            activeStopPrice: stopAuthority.activeStopPrice,
            activeStopSource: stopAuthority.activeStopSource,
            referenceStopPrice: stopAuthority.referenceStopPrice,
            referenceStopSource: stopAuthority.referenceStopSource,
            resolvedStopPrice: stopAuthority.resolvedStopPrice,
            stopAuthoritySource: stopAuthority.stopAuthoritySource,
            entryPrice: stopAuthority.entryPrice,
            isStopLockingProfit: stopAuthority.isStopLockingProfit,
            isProtectiveStopRegistered: stopAuthority.isProtectiveStopRegistered,
            ts: Date.now()
        }));

        // 2. Highway Specific 2-Track Continuation Evaluation
        if (isHighway) {
            // (a) Current position unrealized profit >= +50 USDT
            const currentPosProfitUsdt =
                (side === "long" && entryPrice > 0)
                    ? sizeUsd * (currentPrice - entryPrice) / entryPrice
                    : (side === "short" && entryPrice > 0)
                        ? sizeUsd * (entryPrice - currentPrice) / entryPrice
                        : 0;

            if (currentPosProfitUsdt < 50) {
                return withAddonMode({
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
                    addonBlockedReason: "PYRAMID_PROFIT_BELOW_50_USDT",
                    evidence: "pyramid_profit_below_50_usdt"
                }, "PYRAMIDING");
            }

            // (b) Continuation Mode Classification
            const execMeta = (execution?.metadata as Record<string, unknown> | undefined) ?? {};
            // retestTouched 단독은 허용 금지. retestRejected와 함께여야만 pullback 인정.
            const metaSources = [
                execMeta,
                judgment as unknown as Record<string, unknown>,
                snapshot as Record<string, unknown>
            ];
            const metaFlagTrue = (key: string): boolean =>
                metaSources.some((src) => src != null && src[key] === true);
            const retestConfirmed =
                metaFlagTrue("retestTouched") && metaFlagTrue("retestRejected");
            const isPullbackMode =
                metaFlagTrue("pullbackConfirmed") ||
                metaFlagTrue("supportHoldConfirmed") ||
                metaFlagTrue("supportBounceConfirmed") ||
                retestConfirmed;

            const isMomentumMode =
                execMeta.highwayContinuationConfirmed === true ||
                execMeta.breakoutContinuationConfirmed === true ||
                execMeta.strongMomentumConfirmed === true ||
                (judgment.subtype as string) === "HIGHWAY_CONTINUATION" ||
                (judgment.subtype as string) === "BREAKOUT_CONTINUATION" ||
                (judgment.subtype as string) === "TREND_MOMENTUM" ||
                (execution as any)?.entrySemantic === "HIGHWAY_CONTINUATION" ||
                execMeta.momentumContinuationAllowed === true;

            if (!isPullbackMode && !isMomentumMode) {
                return withAddonMode({
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
                    addonBlockedReason: "PLAIN_TREND_PHASE_INSUFFICIENT",
                    evidence: "plain_trend_phase_insufficient_for_pyramid"
                }, "PYRAMIDING");
            }

            // (c) Sizing, Weighted Avg Entry, and Net Protected Profit Calculation
            const atr = Number(snapshot.atr || (snapshot.volatilityProxyDiag ?? 0));
            const stopDistance = atr * 2.2;
            const addonNotionalUsdt = Math.min(
                targetPyramidNotionalUsdt,
                Math.max(0, symbolMaxNotional - currentSymbolNotionalUsd),
                Math.max(0, globalMaxNotional - currentGlobalNotionalUsd)
            );
            const totalProjectedNotionalUsdt = sizeUsd + addonNotionalUsdt;
            // Weighted average entry (qty-weighted): (N1+N2) / (N1/P1 + N2/P2)
            const N1 = sizeUsd;
            const N2 = addonNotionalUsdt;
            const P1 = entryPrice;
            const P2 = currentPrice;
            const qtyDenominator = (P1 > 0 ? N1 / P1 : 0) + (P2 > 0 ? N2 / P2 : 0);
            const projectedWeightedAvgEntry =
                qtyDenominator > 0 ? (N1 + N2) / qtyDenominator : entryPrice;

            // Projected Stop Price: uses active exchange stop or trailing stop
            const projectedStopPrice = side === "long"
                ? (stopAuthority.activeStopPrice ?? (currentPrice - stopDistance))
                : (stopAuthority.activeStopPrice ?? (currentPrice + stopDistance));

            const grossProtectedProfitUsdt = side === "long"
                ? (projectedWeightedAvgEntry > 0 ? totalProjectedNotionalUsdt * (projectedStopPrice - projectedWeightedAvgEntry) / projectedWeightedAvgEntry : 0)
                : (projectedWeightedAvgEntry > 0 ? totalProjectedNotionalUsdt * (projectedWeightedAvgEntry - projectedStopPrice) / projectedWeightedAvgEntry : 0);

            // Friction: 0.05% entry fee + 0.05% exit fee + 0.02% slippage = 0.12%
            const totalFrictionUsdt = totalProjectedNotionalUsdt * 0.0012;
            const netProtectedProfitUsdt = grossProtectedProfitUsdt - totalFrictionUsdt;

            // Must have verified active OKX stop locking profit
            const hasActiveStopLock = stopAuthority.isStopLockingProfit && stopAuthority.activeStopPrice !== null;
            if (!hasActiveStopLock) {
                return withAddonMode({
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
                    addonBlockedReason: !stopAuthority.isProtectiveStopRegistered ? "PROTECTIVE_STOP_NOT_REGISTERED" : "ACTUAL_STOP_NOT_LOCKING_PROFIT",
                    evidence: "active_exchange_stop_not_locking_profit"
                }, "PYRAMIDING");
            }

            // Net Protected Profit must be >= +40 USDT
            if (netProtectedProfitUsdt < 40) {
                return withAddonMode({
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
                    addonBlockedReason: "NET_PROTECTED_PROFIT_BELOW_40_USDT",
                    evidence: "net_protected_profit_below_40_usdt"
                }, "PYRAMIDING");
            }

            const pyramidReason = isPullbackMode
                ? "HIGHWAY_PULLBACK_PYRAMID_ALLOWED"
                : "HIGHWAY_MOMENTUM_CONTINUATION_PYRAMID_ALLOWED";
            const pyramidEvidence = isPullbackMode
                ? "highway_pullback_pyramid_allowed"
                : "highway_momentum_continuation_pyramid_allowed";

            return withAddonMode({
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
                availableRiskBudgetUsdt: Math.round((netProtectedProfitUsdt - 40) * 100) / 100,
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
            }, "PYRAMIDING");
        }

        // --- Generic (Non-Highway) TREND Profit-Funded Pyramid Fallback ---
        let lockedProfitUsdt = 0;
        let addonBlockedReason = "";

        if (stopAuthority.isStopLockingProfit && stopAuthority.activeStopPrice !== null) {
            if (side === "long") {
                lockedProfitUsdt = sizeUsd * (stopAuthority.activeStopPrice - entryPrice) / entryPrice;
            } else {
                lockedProfitUsdt = sizeUsd * (entryPrice - stopAuthority.activeStopPrice) / entryPrice;
            }
        } else if (breakevenStopConfirmed) {
            lockedProfitUsdt = 0;
            addonBlockedReason = !stopAuthority.isProtectiveStopRegistered
                ? "PROTECTIVE_STOP_NOT_REGISTERED"
                : "ACTUAL_STOP_NOT_LOCKING_PROFIT";
        } else if (breakevenStopRequired) {
            addonBlockedReason = "BREAKEVEN_STOP_NOT_CONFIRMED";
        }

        const availableRiskBudgetUsdt = lockedProfitUsdt - minimumProtectedProfitUsd;
        const atr = Number(snapshot.atr || (snapshot.volatilityProxyDiag ?? 0));
        const stopDistance = atr * 2.2;
        const newStopPrice = side === "long" ? currentPrice - stopDistance : currentPrice + stopDistance;
        const addonLossPctToStop = currentPrice > 0 ? Math.abs(currentPrice - newStopPrice) / currentPrice : 0.022;
        
        let addonMaxNotionalUsdt = availableRiskBudgetUsdt > 0 && addonLossPctToStop > 0
            ? availableRiskBudgetUsdt / addonLossPctToStop
            : 0;

        if (currentSymbolNotionalUsd + addonMaxNotionalUsdt > symbolMaxNotional) {
            addonMaxNotionalUsdt = Math.max(0, symbolMaxNotional - currentSymbolNotionalUsd);
        }
        if (currentGlobalNotionalUsd + addonMaxNotionalUsdt > globalMaxNotional) {
            addonMaxNotionalUsdt = Math.max(0, globalMaxNotional - currentGlobalNotionalUsd);
        }

        const effectiveExistingStopPrice = side === "long"
            ? (stopAuthority.activeStopPrice !== null && stopAuthority.activeStopPrice > 0
                ? Math.max(stopAuthority.activeStopPrice, newStopPrice)
                : newStopPrice)
            : (stopAuthority.activeStopPrice !== null && stopAuthority.activeStopPrice > 0
                ? Math.min(stopAuthority.activeStopPrice, newStopPrice)
                : newStopPrice);

        const existingPosPnlAtStop = (side === "long" && entryPrice > 0)
            ? sizeUsd * (effectiveExistingStopPrice - entryPrice) / entryPrice 
            : (side === "short" && entryPrice > 0)
                ? sizeUsd * (entryPrice - effectiveExistingStopPrice) / entryPrice
                : -sizeUsd;

        const newPosPnlAtStop = side === "long"
            ? addonMaxNotionalUsdt * (newStopPrice - currentPrice) / currentPrice
            : addonMaxNotionalUsdt * (currentPrice - newStopPrice) / currentPrice;
        
        const worstCasePnlAfterNewStop = existingPosPnlAtStop + newPosPnlAtStop;

        const pyramidAllowed = 
            breakevenStopConfirmed &&
            stopAuthority.isStopLockingProfit &&
            availableRiskBudgetUsdt > 0 && 
            qualityScore >= 80 && 
            trendWeaknessScore < 0.55 && 
            pnlPct >= 0.002 && 
            worstCasePnlAfterNewStop >= minimumProtectedProfitUsd &&
            addonMaxNotionalUsdt > 0;

        if (!breakevenStopConfirmed) {
            return {
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
                lockedProfitUsdt: 0,
                addonBlockedReason: "BREAKEVEN_STOP_NOT_CONFIRMED",
                evidence: "breakeven_stop_not_confirmed_before_addon"
            };
        }

        if (pyramidAllowed) {
            return withAddonMode({
                action: "ADDON_ALLOWED",
                allowed: true,
                reason: "TREND_PYRAMID_PROFIT_FUNDED_ALLOWED",
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
                lockedProfitUsdt,
                availableRiskBudgetUsdt,
                addonMaxNotionalUsdt,
                requestedAddonNotionalUsdt: addonMaxNotionalUsdt,
                breakevenStopRequired,
                breakevenStopConfirmed,
                breakevenStopPrice,
                thesisValid: true,
                sameSideConfirmation: breakevenStopConfirmed,
                priceDistancePassed: true,
                evidence: "trend_pyramid_allowed_with_locked_profit"
            }, "PYRAMIDING");
        } else {
            const failReason: V2AddOnPolicyResult["reason"] = !breakevenStopConfirmed
                ? "BREAKEVEN_STOP_NOT_CONFIRMED"
                : availableRiskBudgetUsdt <= 0
                  ? "PROFIT_BUFFER_INSUFFICIENT"
                  : qualityScore < 80
                    ? "QUALITY_TOO_LOW_FOR_ADDON"
                    : pnlPct < 0.002
                      ? "PROFIT_BUFFER_INSUFFICIENT"
                      : "PROFIT_BUFFER_INSUFFICIENT";
            return withAddonMode({
                action: "ADDON_WATCH",
                allowed: false,
                reason: failReason,
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
                lockedProfitUsdt,
                availableRiskBudgetUsdt,
                addonMaxNotionalUsdt,
                breakevenStopRequired,
                breakevenStopConfirmed,
                breakevenStopPrice,
                addonBlockedReason: addonBlockedReason || String(failReason),
                evidence: addonBlockedReason || String(failReason)
            }, "PYRAMIDING");
        }
    }

    return {
        action: "ADDON_WATCH",
        allowed: false,
        reason: "SAME_SIDE_POSITION_WATCH_RECHECK",
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
        evidence: "same_side_position_watch_recheck"
    };
}

export function evaluateV2AddOnPolicy(args: EvaluateV2AddOnPolicyArgs): V2AddOnPolicyResult {
    let result = evaluateV2AddOnPolicyCore(args);
    const { side, judgment, snapshot, v2State } = args;
    const sameSidePosition =
        side === "long"
            ? v2State.longPosition
            : side === "short"
                ? v2State.shortPosition
                : null;
    if (
        sameSidePosition?.entrySemantic === V2_POST_SHOCK_COUNTER_PROBE_SEMANTIC &&
        sameSidePosition?.postShockProbePromotionState === "PROBE_ONLY" &&
        result.allowed
    ) {
        result = {
            ...result,
            postShockProbePromotionState: "STANDARD_PROMOTED"
        };
    }
    if (judgment.transitionPhase === "RANGE_TO_TREND") {
        const sameSidePosition =
            side === "long"
                ? v2State.longPosition
                : side === "short"
                    ? v2State.shortPosition
                    : null;
        const oppositeSidePosition =
            side === "long"
                ? v2State.shortPosition
                : side === "short"
                    ? v2State.longPosition
                    : null;
        const hasSameSidePosition = sameSidePosition != null;
        const hasOppositeSidePosition = oppositeSidePosition != null;
        const pnlPct = Number(sameSidePosition?.pnlPct ?? 0);
        const shockLockish =
            judgment.shockPhase === "DOWN_SHOCK" ||
            judgment.shockPhase === "UP_SHOCK" ||
            (typeof v2State.crashState === "string" && v2State.crashState.includes("CRASH_LOCK")) ||
            (typeof v2State.pumpState === "string" && v2State.pumpState.includes("PUMP_LOCK"));
        const currentStage = sameSidePosition ? Math.max(1, Number(sameSidePosition.entryStage ?? 1)) : 0;
        const qualityScore = Math.max(0, Number(snapshot.qualityScore ?? 0));

        const continuationAllowedToEvaluate =
            (judgment.regime_final === "RANGE" || judgment.regime_final === "TREND") &&
            judgment.transitionPhase === "RANGE_TO_TREND" &&
            hasSameSidePosition &&
            !hasOppositeSidePosition &&
            pnlPct > 0 &&
            !shockLockish;

        console.info(JSON.stringify({
            event: "RANGE_TO_TREND_CONTINUATION_ADDON_EVALUATED",
            symbol: String(args.symbol),
            side,
            pnlPct,
            qualityScore,
            transitionPhase: judgment.transitionPhase,
            shockPhase: judgment.shockPhase,
            currentStage,
            continuationAllowedToEvaluate,
            addonAction: result.action,
            addonReason: result.reason,
            action: result.action,
            reason: result.reason
        }));
    }
    return result;
}
