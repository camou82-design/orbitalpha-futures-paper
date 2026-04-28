import type { EvaluateV2ExitPolicyArgs, V2ExitPolicyResult, V2ExitUrgency } from "./types";

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
        if (args.judgment.trendPhase === "EXHAUSTION") {
            action = "REDUCE";
            reason = "TREND_EXHAUSTION_REDUCE";
            reduceRatio = 0.35;
            evidence += "|trend_exhaustion";
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
        hasPosition
    };
}
