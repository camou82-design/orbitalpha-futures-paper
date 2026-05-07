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
            evidence: "side_none_forbidden"
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
            evidence: "transition_regime_or_phase"
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
            evidence: qualityScore < 70 ? "quality_under_70" : "pnl_not_favorable"
        };
    }

    if (judgment.regime_final === "RANGE") {
        const sideAtEdge =
            (side === "long" && judgment.rangePhase === "LOWER") ||
            (side === "short" && judgment.rangePhase === "UPPER");
        if (sideAtEdge && rangeConfidence >= 0.65 && (qualityScore >= 75 || reviewingTicks >= 2) && currentStage <= 2 && pnlPct > -0.0015) {
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
                evidence: "trend_exhaustion_forbidden"
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
                evidence: "trend_side_mismatch"
            };
        }

        // --- TREND Profit-Funded Pyramid Implementation ---
        const MIN_PROTECTED_PROFIT_USD = 15.0;
        const ADDON_LOSS_PCT_TO_STOP = 0.022; // 2.2% ATR-based equivalent
        const ADDON_RISK_CAP_PCT = 0.15; // 15% of equity

        const sizeUsd = sameSidePosition?.sizeUsd ?? 0;
        const lockedProfitUsdt = pnlPct * sizeUsd;
        const availableRiskBudgetUsdt = lockedProfitUsdt - MIN_PROTECTED_PROFIT_USD;

        const equityUsdEstimate = (v2State.accountEquityKrw || 1400000) / 1400; 
        const equityRiskCapUsdt = equityUsdEstimate * ADDON_RISK_CAP_PCT;

        const addonMaxNotionalUsdt = availableRiskBudgetUsdt > 0 
            ? Math.min(availableRiskBudgetUsdt / ADDON_LOSS_PCT_TO_STOP, equityRiskCapUsdt)
            : 0;

        // Implementation of worst-case PNL check after add-on
        const currentPrice = Number(snapshot.lastPrice);
        const atr = Number(snapshot.atr || (snapshot.volatilityProxyDiag ?? 0));
        const stopDistance = atr * 2.2;
        const newStopPrice = side === "long" ? currentPrice - stopDistance : currentPrice + stopDistance;
        
        // Simplified worst case check: if we add 'addonMaxNotionalUsdt' at 'currentPrice'
        // and stop hits 'newStopPrice', what is the total PNL?
        const entryPrice = sameSidePosition?.entryPrice ?? currentPrice;
        const existingPosPnlAtStop = side === "long" 
            ? sizeUsd * (newStopPrice - entryPrice) / entryPrice 
            : sizeUsd * (entryPrice - newStopPrice) / entryPrice;
        const newPosPnlAtStop = side === "long"
            ? addonMaxNotionalUsdt * (newStopPrice - currentPrice) / currentPrice
            : addonMaxNotionalUsdt * (currentPrice - newStopPrice) / currentPrice;
        
        const worstCasePnlAfterNewStop = existingPosPnlAtStop + newPosPnlAtStop;

        const pyramidAllowed = 
            availableRiskBudgetUsdt > 0 && 
            qualityScore >= 80 && 
            trendWeaknessScore < 0.55 && 
            pnlPct >= 0.002 && // Require at least 0.2% pnl for cushion
            worstCasePnlAfterNewStop >= 0;

        if (pyramidAllowed) {
            console.info(JSON.stringify({
                event: "V2_TREND_PROFIT_FUNDED_PYRAMID_PROOF",
                symbol: String(args.symbol),
                side,
                current_size_usd: sizeUsd,
                pnl_pct: pnlPct,
                locked_profit_usdt: lockedProfitUsdt,
                available_risk_budget_usdt: availableRiskBudgetUsdt,
                addon_max_notional_usdt: addonMaxNotionalUsdt,
                worst_case_pnl_after_stop: worstCasePnlAfterNewStop,
                atr,
                stop_distance: stopDistance,
                new_stop_price: newStopPrice
            }));

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
                evidence: "trend_pyramid_allowed"
            };
        } else {
             return {
                action: "ADDON_WATCH",
                allowed: false,
                reason: availableRiskBudgetUsdt <= 0 ? "PROFIT_BUFFER_INSUFFICIENT" : "PNL_NOT_FAVORABLE",
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
                evidence: "profit_funded_pyramid_insufficient_buffer_or_low_quality"
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
        evidence: "same_side_position_watch_recheck"
    };
}
