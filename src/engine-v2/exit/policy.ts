import type { EvaluateV2ExitPolicyArgs, V2ExitPolicyResult, V2ExitUrgency, V2ExitAction, V2ExitReason } from "./types";
import {
    evaluateOppositePositionHysteresis,
    type OppositeHysteresisState
} from "./opposite-hysteresis-policy";

function resolvePosition(args: EvaluateV2ExitPolicyArgs) {
    const positions = args.v2State.symbolPositions ?? [];
    const longPos = positions.find((p) => String(p.side).toLowerCase() === "long") ?? null;
    const shortPos = positions.find((p) => String(p.side).toLowerCase() === "short") ?? null;
    if (longPos && shortPos) {
        // proof-only stage: keep first side but preserve dual signal in evidence
        return { pos: longPos, side: "long" as const, dual: true };
    }
    if (longPos) return { pos: longPos, side: "long" as const, dual: false };
    if (shortPos) return { pos: shortPos, side: "short" as const, dual: false };
    return { pos: null, side: "none" as const, dual: false };
}

function urgencyFromAction(action: V2ExitPolicyResult["action"], critical: boolean): V2ExitUrgency {
    if (critical) return "CRITICAL";
    if (action === "FULL_EXIT") return "HIGH";
    if (action === "REDUCE" || action === "PARTIAL_TAKE_PROFIT") return "MID";
    return "LOW";
}

export function evaluateV2ExitPolicy(args: EvaluateV2ExitPolicyArgs): V2ExitPolicyResult {
    const { pos, side, dual } = resolvePosition(args);
    const s = args.snapshot;
    const boxPos = Number(s.boxPos ?? 0.5);
    const boxBreakSide = s.boxBreakSide ?? "none";
    const emaGap = Number(s.emaGap ?? 0);
    const tw = Number(s.trendWeaknessScore ?? 1);
    const rc = Number(s.rangeConfidence ?? 0);
    const qs = Number(s.qualityScore ?? 0);
    const pnlPct = Number(pos?.pnlPct ?? 0);
    const sizeUsd = Number(pos?.sizeUsd ?? 0);
    const stage = pos ? Math.max(1, Number(pos.entryStage ?? 1)) : 0;
    const hasPosition = pos != null;
    const shockAgainst =
        (side === "long" && args.judgment.shockPhase === "DOWN_SHOCK") ||
        (side === "short" && args.judgment.shockPhase === "UP_SHOCK");
    let action: V2ExitPolicyResult["action"] = "HOLD";
    let reason: V2ExitPolicyResult["reason"] = "NO_EXIT_SIGNAL";
    let reduceRatio = 0;
    let evidence = dual ? "dual_position_detected" : "single_position";

    if (!hasPosition) {
        action = "HOLD";
        reason = "NO_POSITION_HOLD";
    } else if (pnlPct <= -0.02) {
        action = "FULL_EXIT";
        reason = "PNL_STOP_PROTECT";
        reduceRatio = 1;
        evidence += "|pnl_stop_critical";
    } else if (pnlPct <= -0.012) {
        action = "REDUCE";
        reason = "PNL_STOP_PROTECT";
        reduceRatio = 0.4;
        evidence += "|pnl_stop_reduce";
    } else if (shockAgainst || args.v2State.crashState.includes("CRASH_LOCK") || args.v2State.pumpState.includes("PUMP_LOCK")) {
        action = shockAgainst ? "FULL_EXIT" : "REDUCE";
        reason = shockAgainst ? "SHOCK_FULL_EXIT_AGAINST_POSITION" : "SHOCK_PROTECTIVE_REDUCE";
        reduceRatio = shockAgainst ? 1 : 0.35;
        evidence += "|shock_protective";
    } else if (args.judgment.regime_final === "TRANSITION") {
        if (args.judgment.transitionPhase === "CONFLICT") {
            action = "REDUCE";
            reason = "TRANSITION_REDUCE_ON_CONFLICT";
            reduceRatio = pnlPct > 0 ? 0.3 : 0.45;
            evidence += "|transition_conflict";
        } else {
            action = "WATCH";
            reason = "TRANSITION_PROTECTIVE_WATCH";
            reduceRatio = 0;
            evidence += "|transition_watch";
        }
    } else if (args.judgment.regime_final === "RANGE") {
        if (side === "long") {
            if ((args.judgment.rangePhase === "UPPER" || boxPos >= 0.74) && pnlPct > 0) {
                action = "PARTIAL_TAKE_PROFIT";
                reason = "RANGE_PARTIAL_AT_OPPOSITE_EDGE";
                reduceRatio = 0.4;
                evidence += "|range_long_opposite_edge";
            } else if (boxBreakSide === "lower" || boxPos < 0.15) {
                action = "FULL_EXIT";
                reason = "RANGE_FULL_EXIT_BOX_BREAK";
                reduceRatio = 1;
                evidence += "|range_long_box_break";
            } else if (args.judgment.rangePhase === "MID") {
                action = "WATCH";
                reason = "RANGE_HOLD_INSIDE_BOX";
                evidence += "|range_mid_watch";
            } else {
                action = "HOLD";
                reason = "RANGE_PROFIT_PROTECT";
                evidence += "|range_hold";
            }
        } else if (side === "short") {
            if ((args.judgment.rangePhase === "LOWER" || boxPos <= 0.26) && pnlPct > 0) {
                action = "PARTIAL_TAKE_PROFIT";
                reason = "RANGE_PARTIAL_AT_OPPOSITE_EDGE";
                reduceRatio = 0.4;
                evidence += "|range_short_opposite_edge";
            } else if (boxBreakSide === "upper" || boxPos > 0.85) {
                action = "FULL_EXIT";
                reason = "RANGE_FULL_EXIT_BOX_BREAK";
                reduceRatio = 1;
                evidence += "|range_short_box_break";
            } else if (args.judgment.rangePhase === "MID") {
                action = "WATCH";
                reason = "RANGE_HOLD_INSIDE_BOX";
                evidence += "|range_mid_watch";
            } else {
                action = "HOLD";
                reason = "RANGE_PROFIT_PROTECT";
                evidence += "|range_hold";
            }
        }
    } else if (args.judgment.regime_final === "TREND") {
        if (args.judgment.trendPhase === "EXHAUSTION" || tw >= 0.65) {
            action = "PARTIAL_TAKE_PROFIT";
            reason = "TREND_EXHAUSTION_REDUCE_50PCT";
            reduceRatio = 0.5; // 50% on exhaustion
            evidence += "|trend_exhaustion_50";
        } else if (tw >= 0.55) {
            action = "PARTIAL_TAKE_PROFIT";
            reason = "TREND_WEAKNESS_REDUCE_30PCT";
            reduceRatio = 0.3; // 30% on weakness
            evidence += "|trend_weakness_30";
        } else if ((side === "long" && emaGap < 0) || (side === "short" && emaGap > 0) || tw >= 0.75) {
            action = "FULL_EXIT";
            reason = "TREND_FULL_EXIT_EMA60_INVALID";
            reduceRatio = 1;
            evidence += "|trend_invalidation";
        } else if (args.judgment.trendPhase === "PULLBACK" && pnlPct > 0) {
            action = "PARTIAL_TAKE_PROFIT";
            reason = "TREND_PARTIAL_EMA20_WEAKNESS";
            reduceRatio = 0.3;
            evidence += "|trend_pullback_partial";
        } else {
            action = "HOLD";
            reason = "TREND_HOLD_VALID";
            evidence += "|trend_hold_valid";
        }
    }

    // --- OPPOSITE POSITION HYSTERESIS (before profit protection) ---
    let oppositeHysteresisState: OppositeHysteresisState = "NONE";
    let oppositeHysteresisBlockReason: string | null = null;
    let thesisValid = false;
    if (hasPosition) {
        const hysteresisBase = evaluateOppositePositionHysteresis({
            symbol: args.symbol,
            positionSide: side,
            trendSideCandidate: args.trendSideCandidate ?? "none",
            rangeSideCandidate: args.rangeSideCandidate ?? "none",
            judgment: args.judgment,
            pnlPct,
            peakPnl: Number(pos?.peakUnrealizedPnlPct ?? pnlPct),
            emaGap,
            trendWeaknessScore: tw,
            boxBreakSide,
            boxPos,
            proposedAction: action,
            proposedReason: reason,
            proposedReduceRatio: reduceRatio,
            reversalConfirmed: args.reversalConfirmed,
            sameCycleExitConsumed: args.sameCycleExitConsumed,
            invalidationBreachConfirmed: args.invalidationBreachConfirmed,
            structuralBreakConfirmed: args.structuralBreakConfirmed,
            boxBreakConfirmed: args.boxBreakConfirmed
        });
        action = hysteresisBase.action;
        reason = hysteresisBase.reason;
        reduceRatio = hysteresisBase.reduceRatio;
        oppositeHysteresisState = hysteresisBase.hysteresisState;
        oppositeHysteresisBlockReason = hysteresisBase.blockReason;
        thesisValid = hysteresisBase.thesisValid;
        if (hysteresisBase.hysteresisState !== "NONE") {
            evidence += `|opposite_hysteresis:${hysteresisBase.hysteresisState}`;
        }
    }

    // --- V2 PROFIT PROTECTION PIPELINE (State-Aware Hardening) ---
    // This section implements active PnL management to lock in gains and mitigate reversal risks.
    const peakPnl = Number(pos?.peakUnrealizedPnlPct ?? pnlPct);
    
    if (hasPosition && (action === "HOLD" || action === "WATCH")) {
        let profitAction: V2ExitAction = action;
        let profitReason: V2ExitReason = reason;
        let profitReduce = reduceRatio;

        // 1. Breakeven Stop: If profit once reached 1.5% and now dropped to 0.2%
        if (peakPnl >= 0.015 && pnlPct < 0.002) {
            profitAction = "FULL_EXIT";
            profitReason = "PROFIT_PROTECTION_BREAKEVEN_EXIT";
            profitReduce = 1;
            evidence += "|v2_breakeven_trigger";
        } else if (peakPnl >= 0.025 && !pos?.tp1Triggered) {
            profitAction = "PARTIAL_TAKE_PROFIT";
            profitReason = "PROFIT_PROTECTION_PARTIAL_TP";
            profitReduce = 0.4;
            evidence += "|v2_partial_tp_trigger";
        } else if (peakPnl >= 0.03 && (peakPnl - pnlPct) >= 0.015) {
            profitAction = "FULL_EXIT";
            profitReason = "PROFIT_PROTECTION_TRAILING_STOP";
            profitReduce = 1;
            evidence += "|v2_trailing_stop_trigger";
        }

        if (profitAction !== action || profitReason !== reason) {
            const profitHysteresis = evaluateOppositePositionHysteresis({
                symbol: args.symbol,
                positionSide: side,
                trendSideCandidate: args.trendSideCandidate ?? "none",
                rangeSideCandidate: args.rangeSideCandidate ?? "none",
                judgment: args.judgment,
                pnlPct,
                peakPnl,
                emaGap,
                trendWeaknessScore: tw,
                boxBreakSide,
                boxPos,
                proposedAction: profitAction,
                proposedReason: profitReason,
                proposedReduceRatio: profitReduce,
                reversalConfirmed: args.reversalConfirmed,
                sameCycleExitConsumed: args.sameCycleExitConsumed,
                invalidationBreachConfirmed: args.invalidationBreachConfirmed,
                structuralBreakConfirmed: args.structuralBreakConfirmed,
                boxBreakConfirmed: args.boxBreakConfirmed
            });
            action = profitHysteresis.action;
            reason = profitHysteresis.reason;
            reduceRatio = profitHysteresis.reduceRatio;
            oppositeHysteresisState = profitHysteresis.hysteresisState;
            oppositeHysteresisBlockReason = profitHysteresis.blockReason;
            thesisValid = profitHysteresis.thesisValid;
            if (profitHysteresis.hysteresisState !== "NONE") {
                evidence += `|profit_hysteresis:${profitHysteresis.hysteresisState}`;
            }
        }
    }

    const critical = reason === "PNL_STOP_PROTECT" && pnlPct <= -0.02;
    const exitUrgency = urgencyFromAction(action, critical);
    const exitConfidence = Math.max(0, Math.min(1, (qs / 100) * (action === "HOLD" ? 0.6 : 1)));

    return {
        action,
        shouldExit: action === "FULL_EXIT",
        shouldReduce: action === "REDUCE",
        shouldPartial: action === "PARTIAL_TAKE_PROFIT",
        reason,
        positionSide: side,
        positionSizeUsd: sizeUsd,
        currentStage: stage,
        pnlPct,
        marketRegime: args.judgment.regime_final,
        marketSubtype: args.judgment.subtype,
        shockPhase: args.judgment.shockPhase,
        rangePhase: args.judgment.rangePhase,
        trendPhase: args.judgment.trendPhase,
        transitionPhase: args.judgment.transitionPhase,
        boxPos,
        boxBreakSide,
        emaGap,
        trendWeaknessScore: tw,
        rangeConfidence: rc,
        qualityScore: qs,
        reduceRatio,
        exitUrgency,
        exitConfidence,
        evidence,
        hasPosition,
        peakUnrealizedPnlPct: peakPnl,
        profitProtectionActive: reason.startsWith("PROFIT_PROTECTION_") || oppositeHysteresisState === "PROFIT_PROTECT_HOLD",
        oppositeHysteresisState,
        oppositeHysteresisBlockReason,
        thesisValid
    };
}
