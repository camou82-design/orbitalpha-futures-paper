import type { EvaluateV2AddOnPolicyArgs, V2AddOnPolicyResult } from "./types";
import { evaluateConfirmedAdverseAddOn } from "./adverse-addon";
import { resolveV2AddonStopAuthority } from "./stop-authority";
import {
    MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
    MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE
} from "../risk-sizing/equity-adaptive-sizing";

function withAddonMode<T extends V2AddOnPolicyResult>(result: T, addonMode: V2AddOnPolicyResult["addonMode"]): T {
    return { ...result, addonMode: addonMode ?? "NONE" };
}

function evaluateV2AddOnPolicyCore(args: EvaluateV2AddOnPolicyArgs): V2AddOnPolicyResult {
    const { side, v2State, judgment, snapshot } = args;
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
        v2State.crashState.includes("CRASH_LOCK") ||
        v2State.pumpState.includes("PUMP_LOCK");

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
        return {
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
            evidence: "shock_or_lockish_state"
        };
    }

    const isRangeToTrendException =
        (judgment.regime_final === "RANGE" || judgment.regime_final === "TREND") &&
        judgment.transitionPhase === "RANGE_TO_TREND" &&
        hasSameSidePosition &&
        !hasOppositeSidePosition &&
        pnlPct > 0 &&
        !shockLockish;

    const isTransitionBlocked =
        judgment.regime_final === "TRANSITION" ||
        (judgment.transitionPhase !== "NONE" && !isRangeToTrendException);

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
             return {
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
                evidence: "trend_side_mismatch"
            };
        }

        // --- TREND Profit-Funded Pyramid Implementation (Refined with Locked Profit Verification) ---
    const accountEquityUsd = args.accountEquityUsd || (v2State.accountEquityKrw || 1400000) / 1400;
    const minimumProtectedProfitUsd = Math.max(0.5, accountEquityUsd * 0.0015);
    const symbolMaxNotional = accountEquityUsd * MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE;
    const globalMaxNotional = accountEquityUsd * MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE;

    const currentSymbolNotionalUsd = args.currentSymbolNotionalUsd || (sameSidePosition?.sizeUsd ?? 0);
    const currentGlobalNotionalUsd = args.currentGlobalNotionalUsd || currentSymbolNotionalUsd;

    const sizeUsd = sameSidePosition?.sizeUsd ?? 0;
    const entryPrice = sameSidePosition?.entryPrice ?? 0;
    
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
        // Active Stop (OKX 실제 보호 주문)
        activeStopPrice: stopAuthority.activeStopPrice,
        activeStopSource: stopAuthority.activeStopSource,
        // Reference Stop (ledger/runtime 기록값 — locked profit authority 아님)
        referenceStopPrice: stopAuthority.referenceStopPrice,
        referenceStopSource: stopAuthority.referenceStopSource,
        // Backward-compat
        resolvedStopPrice: stopAuthority.resolvedStopPrice,
        stopAuthoritySource: stopAuthority.stopAuthoritySource,
        entryPrice: stopAuthority.entryPrice,
        isStopLockingProfit: stopAuthority.isStopLockingProfit,
        isProtectiveStopRegistered: stopAuthority.isProtectiveStopRegistered,
        ts: Date.now()
    }));

    // 2. lockedProfitUsd: Profit guaranteed only if actual protective stop is strictly locking profit beyond entry and registered
    let lockedProfitUsdt = 0;
    let addonBlockedReason = "";

    if (stopAuthority.isStopLockingProfit && stopAuthority.resolvedStopPrice !== null) {
        if (side === "long") {
            lockedProfitUsdt = sizeUsd * (stopAuthority.resolvedStopPrice - entryPrice) / entryPrice;
        } else {
            lockedProfitUsdt = sizeUsd * (entryPrice - stopAuthority.resolvedStopPrice) / entryPrice;
        }
    } else if (breakevenStopConfirmed) {
        // Historical breakevenStopConfirmed was true, but current actual stop is not registered or not locking profit!
        lockedProfitUsdt = 0;
        addonBlockedReason = !stopAuthority.isProtectiveStopRegistered
            ? "PROTECTIVE_STOP_NOT_REGISTERED"
            : "ACTUAL_STOP_NOT_LOCKING_PROFIT";
    } else if (breakevenStopRequired) {
        addonBlockedReason = "BREAKEVEN_STOP_NOT_CONFIRMED";
    }

    const availableRiskBudgetUsdt = lockedProfitUsdt - minimumProtectedProfitUsd;

    // 3. Risk Projection for Add-on
    const currentPrice = Number(snapshot.lastPrice);
    const atr = Number(snapshot.atr || (snapshot.volatilityProxyDiag ?? 0));
    const stopDistance = atr * 2.2;
    const newStopPrice = side === "long" ? currentPrice - stopDistance : currentPrice + stopDistance;
    const addonLossPctToStop = currentPrice > 0 ? Math.abs(currentPrice - newStopPrice) / currentPrice : 0.022;
    
    let addonMaxNotionalUsdt = availableRiskBudgetUsdt > 0 && addonLossPctToStop > 0
        ? availableRiskBudgetUsdt / addonLossPctToStop
        : 0;

    // Enforce notional caps
    if (currentSymbolNotionalUsd + addonMaxNotionalUsdt > symbolMaxNotional) {
        addonMaxNotionalUsdt = Math.max(0, symbolMaxNotional - currentSymbolNotionalUsd);
    }
    if (currentGlobalNotionalUsd + addonMaxNotionalUsdt > globalMaxNotional) {
        addonMaxNotionalUsdt = Math.max(0, globalMaxNotional - currentGlobalNotionalUsd);
    }

    const effectiveExistingStopPrice = side === "long"
        ? (stopAuthority.resolvedStopPrice !== null && stopAuthority.resolvedStopPrice > 0 ? Math.max(stopAuthority.resolvedStopPrice, newStopPrice) : newStopPrice)
        : (stopAuthority.resolvedStopPrice !== null && stopAuthority.resolvedStopPrice > 0 ? Math.min(stopAuthority.resolvedStopPrice, newStopPrice) : newStopPrice);

    const existingPosPnlAtStop = (side === "long" && entryPrice > 0)
        ? sizeUsd * (effectiveExistingStopPrice - entryPrice) / entryPrice 
        : (side === "short" && entryPrice > 0)
            ? sizeUsd * (entryPrice - effectiveExistingStopPrice) / entryPrice
            : -sizeUsd;

    const newPosPnlAtStop = side === "long"
        ? addonMaxNotionalUsdt * (newStopPrice - currentPrice) / currentPrice
        : addonMaxNotionalUsdt * (currentPrice - newStopPrice) / currentPrice;
    
    const worstCasePnlAfterNewStop = existingPosPnlAtStop + newPosPnlAtStop;

    // 4. Final Decision Gate
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
        const pyramidBlockedReason =
            !breakevenStopConfirmed
                ? "PYRAMIDING_CONFIRMATION_NOT_MET"
                : qualityScore < 80
                  ? "QUALITY_NOT_MET"
                  : pnlPct < 0.002
                    ? "PYRAMIDING_CONFIRMATION_NOT_MET"
                    : availableRiskBudgetUsdt <= 0
                      ? "PROFIT_BUFFER_INSUFFICIENT"
                      : addonBlockedReason || String(failReason);
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
            addonBlockedReason: pyramidBlockedReason,
            evidence: "profit_funded_pyramid_insufficient_buffer_or_stop_not_confirmed"
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
    const result = evaluateV2AddOnPolicyCore(args);
    const { side, judgment, snapshot, v2State } = args;
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
            v2State.crashState.includes("CRASH_LOCK") ||
            v2State.pumpState.includes("PUMP_LOCK");
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
