import type { EvaluateV2ExitPolicyArgs, V2ExitPolicyResult, V2ExitUrgency, V2ExitAction, V2ExitReason } from "./types";
import { computePnlStopProtectJudgmentPct } from "./stop-price-authority";
import {
    evaluateOppositePositionHysteresis,
    type OppositeHysteresisState
} from "./opposite-hysteresis-policy";
import {
    evaluatePnlStopMeaningfulMoveGate,
    type PnlStopMeaningfulMoveGateResult
} from "./pnl-stop-gate";

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
    const pnlStopProtectJudgment =
        hasPosition && (side === "long" || side === "short")
            ? computePnlStopProtectJudgmentPct({
                  side,
                  entryPrice: Number(pos?.entryPrice ?? 0),
                  markPrice: Number(args.markPrice ?? 0),
                  leverage: Number(pos?.leverage ?? 0),
                  pnlPctNetFallback: pnlPct
              })
            : { pnlStopProtectPct: pnlPct, source: "pnl_pct_net_fallback" as const };
    const pnlStopProtectPct = pnlStopProtectJudgment.pnlStopProtectPct;
    const shockAgainst =
        (side === "long" && args.judgment.shockPhase === "DOWN_SHOCK") ||
        (side === "short" && args.judgment.shockPhase === "UP_SHOCK");

    // BLOCKER 4-5: Directional shock authority resolver.
    // CRASH_LOCK / PUMP_LOCK alone (stale time-latch) must NOT trigger SHOCK_PROTECTIVE_REDUCE.
    // Only current adverse directional shock authority qualifies for protective reduce:
    //   LONG  position: requires directionalShockState === "DOWN" (adverse down-shock confirmed)
    //   SHORT position: requires directionalShockState === "UP"   (adverse up-shock confirmed)
    // BOTH-LOCK + directionalShockState=NONE → no adverse authority → HOLD (no reduce).
    const dss = args.v2State.directionalShockState;
    const hasAdverseDirectionalAuthority =
        (side === "long" && dss === "DOWN") ||
        (side === "short" && dss === "UP");

    let thresholdActionCandidate: "FULL_EXIT" | "REDUCE" | "NONE" = "NONE";
    const PNL_EPS = 1e-6;
    if (pnlStopProtectPct <= -0.02 + PNL_EPS) {
        thresholdActionCandidate = "FULL_EXIT";
    } else if (pnlStopProtectPct <= -0.012 + PNL_EPS) {
        thresholdActionCandidate = "REDUCE";
    }

    const ledgerStopPx =
        typeof pos?.ledger_stop_px === "number" && Number.isFinite(pos.ledger_stop_px) && pos.ledger_stop_px > 0
            ? pos.ledger_stop_px
            : null;
    const atr20 =
        typeof s.atr20 === "number" && Number.isFinite(s.atr20) && s.atr20 > 0
            ? s.atr20
            : null;

    const pnlGateResult = evaluatePnlStopMeaningfulMoveGate({
        symbol: args.symbol,
        side,
        entryPrice: Number(pos?.entryPrice ?? 0),
        markPrice: Number(args.markPrice ?? 0),
        leverage: Number(pos?.leverage ?? 0),
        pnlStopProtectPct,
        ledgerStopPx,
        atr20,
        slProtectionSatisfied: pos?.slProtectionSatisfied === true || pos?.isProtectiveStopRegistered === true,
        slProtectionProvisional: pos?.slProtectionProvisional === true,
        protectiveVisibilityGraceDeadlineMs: pos?.protectiveVisibilityGraceDeadlineMs ?? null,
        now: (args.v2State as any)?.now ?? Date.now(),
        protectiveSlAlgoId: pos?.protectiveSlAlgoId ?? null,
        structureBreached: pos?.structureBreached === true,
        invalidationBreachConfirmed: args.invalidationBreachConfirmed === true,
        shockAgainst,
        hasAdverseDirectionalAuthority,
        thresholdActionCandidate
    });

    let action: V2ExitPolicyResult["action"] = "HOLD";
    let reason: V2ExitPolicyResult["reason"] = "NO_EXIT_SIGNAL";
    let reduceRatio = 0;
    let evidence = dual ? "dual_position_detected" : "single_position";

    if (!hasPosition) {
        action = "HOLD";
        reason = "NO_POSITION_HOLD";
    } else if (pos?.structureBreached === true || args.invalidationBreachConfirmed === true) {
        action = "FULL_EXIT";
        reason = "V2_EXIT_INVALIDATION";
        reduceRatio = 1;
        evidence += "|structure_invalidation_breached";
    } else if (pnlGateResult.finalAction === "FULL_EXIT") {
        action = "FULL_EXIT";
        reason = "PNL_STOP_PROTECT";
        reduceRatio = 1;
        evidence += `|pnl_stop_critical|${pnlGateResult.evidence}`;
    } else if (pnlGateResult.finalAction === "REDUCE") {
        action = "REDUCE";
        reason = "PNL_STOP_PROTECT";
        reduceRatio = 0.4;
        evidence += `|pnl_stop_reduce|${pnlGateResult.evidence}`;
    } else if (shockAgainst) {
        // FULL_EXIT when current shockPhase is directly adverse to position side.
        action = "FULL_EXIT";
        reason = "SHOCK_FULL_EXIT_AGAINST_POSITION";
        reduceRatio = 1;
        evidence += "|shock_full_exit_against";
    } else if (hasAdverseDirectionalAuthority) {
        // BLOCKER 4-5: SHOCK_PROTECTIVE_REDUCE only when directionalShockState is currently
        // adverse to the position (DOWN for LONG, UP for SHORT).
        // CRASH_LOCK / PUMP_LOCK strings alone (stale time-latch) do NOT qualify here.
        // BOTH-LOCK + directionalShockState=NONE → hasAdverseDirectionalAuthority=false → no reduce.
        action = "REDUCE";
        reason = "SHOCK_PROTECTIVE_REDUCE";
        reduceRatio = 0.35;
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
            invalidationBreachConfirmed: pos?.structureBreached === true || args.invalidationBreachConfirmed === true,
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

    const critical = reason === "PNL_STOP_PROTECT" && pnlStopProtectPct <= -0.02;
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
        thesisValid,
        pnlStopGateResult: pnlGateResult
    };
}
