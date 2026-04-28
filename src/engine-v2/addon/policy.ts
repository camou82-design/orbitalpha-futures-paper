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
    if (currentStage >= 3) {
        return {
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
            evidence: "stage_limit_reached"
        };
    }
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
        if (trendSideAligned && trendWeaknessScore < 0.55 && (qualityScore >= 80) && currentStage <= 2 && pnlPct >= 0) {
            return {
                action: "ADDON_ALLOWED",
                allowed: true,
                reason: judgment.trendPhase === "PULLBACK" ? "TREND_PULLBACK_ADDON_ALLOWED" : "TREND_CONTINUATION_ADDON_ALLOWED",
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
                evidence: "trend_addon_allowed"
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
