import type { EvaluateV2AddOnPolicyArgs, V2AddOnPolicyResult } from "./types";

export function evaluateV2AddOnPolicy(args: EvaluateV2AddOnPolicyArgs): V2AddOnPolicyResult {
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
    if (judgment.regime_final === "TRANSITION" || judgment.transitionPhase !== "NONE") {
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
    // Non-TREND stage limits will be handled within their respective sections if needed
    if (qualityScore < 70 || pnlPct <= 0) {
        return {
            action: "ADDON_WATCH",
            allowed: false,
            reason: qualityScore < 70 ? "QUALITY_TOO_LOW_FOR_ADDON" : "PNL_NOT_FAVORABLE",
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
            evidence: "quality_score_too_low_or_pnl_not_favorable"
        };
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
            return {
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
                evidence: "range_edge_reattack_allowed"
            };
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
            evidence: "range_addon_watch_recheck"
        };
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

        // --- TREND Profit-Funded Pyramid Implementation (Refined) ---
    // --- TREND Profit-Funded Pyramid Implementation (Refined with Locked Profit Verification) ---
    const accountEquityUsd = args.accountEquityUsd || (v2State.accountEquityKrw || 1400000) / 1400;
    const minimumProtectedProfitUsd = Math.max(0.5, accountEquityUsd * 0.0015);
    const symbolMaxNotional = accountEquityUsd * 0.8;
    const globalMaxNotional = accountEquityUsd * 1.5;

    const currentSymbolNotionalUsd = args.currentSymbolNotionalUsd || (sameSidePosition?.sizeUsd ?? 0);
    const currentGlobalNotionalUsd = args.currentGlobalNotionalUsd || currentSymbolNotionalUsd;

    const sizeUsd = sameSidePosition?.sizeUsd ?? 0;
    const entryPrice = sameSidePosition?.entryPrice ?? 0;
    
    // 1. Breakeven Stop Check (Already initialized at top)
    const currentBreakevenStopPrice = breakevenStopPrice ?? 0;
    const isBreakevenStopConfirmed = breakevenStopConfirmed;
    const isBreakevenStopRequired = breakevenStopRequired;
    const confirmedStopPrice = Number(sameSidePosition?.breakevenStopPrice ?? 0);

    // 2. lockedProfitUsd: Profit guaranteed only if breakeven stop is confirmed and valid
    let lockedProfitUsdt = 0;
    let addonBlockedReason = "";

    if (breakevenStopConfirmed && confirmedStopPrice > 0) {
        const currentBreakevenStopPrice = breakevenStopPrice ?? 0;
        const isStopValid = side === "long" 
            ? confirmedStopPrice >= currentBreakevenStopPrice
            : confirmedStopPrice <= currentBreakevenStopPrice;

        if (isStopValid) {
            if (side === "long") {
                lockedProfitUsdt = sizeUsd * (confirmedStopPrice - entryPrice) / entryPrice;
            } else {
                lockedProfitUsdt = sizeUsd * (entryPrice - confirmedStopPrice) / entryPrice;
            }
        } else {
            addonBlockedReason = "CONFIRMED_STOP_NOT_AT_BREAKEVEN";
        }
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

    const existingPosPnlAtStop = (side === "long" && entryPrice > 0)
        ? sizeUsd * (newStopPrice - entryPrice) / entryPrice 
        : (side === "short" && entryPrice > 0)
            ? sizeUsd * (entryPrice - newStopPrice) / entryPrice
            : -sizeUsd;

    const newPosPnlAtStop = side === "long"
        ? addonMaxNotionalUsdt * (newStopPrice - currentPrice) / currentPrice
        : addonMaxNotionalUsdt * (currentPrice - newStopPrice) / currentPrice;
    
    const worstCasePnlAfterNewStop = existingPosPnlAtStop + newPosPnlAtStop;

    // 4. Final Decision Gate
    const pyramidAllowed = 
        breakevenStopConfirmed &&
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
        return {
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
            breakevenStopRequired,
            breakevenStopConfirmed,
            breakevenStopPrice,
            evidence: "trend_pyramid_allowed_with_locked_profit"
        };
    } else {
        const failReason = !breakevenStopConfirmed ? "BREAKEVEN_STOP_NOT_CONFIRMED" : 
                          availableRiskBudgetUsdt <= 0 ? "PROFIT_BUFFER_INSUFFICIENT" : "PNL_NOT_FAVORABLE";
        return {
            action: "ADDON_WATCH",
            allowed: false,
            reason: failReason as any,
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
            addonBlockedReason: addonBlockedReason || failReason,
            evidence: "profit_funded_pyramid_insufficient_buffer_or_stop_not_confirmed"
        };
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
