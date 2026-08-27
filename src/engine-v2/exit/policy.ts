import type { EvaluateV2ExitPolicyArgs, V2ExitPolicyResult, V2ExitUrgency, V2ExitAction, V2ExitReason } from "./types";
import { computePnlStopProtectJudgmentPct, isV2StopPriceBreached } from "./stop-price-authority";
import {
    evaluateOppositePositionHysteresis,
    type OppositeHysteresisState
} from "./opposite-hysteresis-policy";
import {
    evaluatePnlStopMeaningfulMoveGate
} from "./pnl-stop-gate";

/**
 * BLOCKER 4-20: ordinary BTC/ETH micro-noise must not mutate a live position.
 * This is an underlying-price move, not leveraged/accounting PnL.
 */
const MIN_DEFENSIVE_REDUCE_ADVERSE_MOVE_PCT = 0.0015; // 0.15%
const PNL_STOP_REDUCE_RATIO = 0.25;

function resolvePosition(args: EvaluateV2ExitPolicyArgs) {
    const positions = args.v2State.symbolPositions ?? [];
    const longPos = positions.find((p) => String(p.side).toLowerCase() === "long") ?? args.v2State.longPosition ?? null;
    const shortPos = positions.find((p) => String(p.side).toLowerCase() === "short") ?? args.v2State.shortPosition ?? null;
    if (longPos && shortPos) {
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

function isPriorDefensiveReduce(reason: unknown): boolean {
    const r = String(reason ?? "").toUpperCase();
    return (
        r.includes("PNL_STOP_PROTECT") ||
        r.includes("SHOCK_PROTECTIVE_REDUCE") ||
        r.includes("TRANSITION_REDUCE_ON_CONFLICT") ||
        r.includes("DEFENSIVE") ||
        r.includes("PROTECTIVE_REDUCE")
    );
}

export function evaluateV2ExitPolicy(args: EvaluateV2ExitPolicyArgs): V2ExitPolicyResult {
    const { pos, side, dual } = resolvePosition(args);
    const pnlPct = Number(pos?.pnlPct ?? 0);
    const sizeUsd = Number(pos?.sizeUsd ?? 0);
    const stage = pos ? Math.max(1, Number(pos.entryStage ?? 1)) : 0;

    const posAny = pos as any;
    if (posAny && (posAny.manualTakeoverActive === true || posAny.lifecycleState === "OPERATOR_MANAGED" || posAny.manualOwnershipLatch === true)) {
        return {
            action: "HOLD",
            shouldExit: false,
            shouldReduce: false,
            shouldPartial: false,
            reason: "NO_POSITION_HOLD",
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
            boxPos: 0.5,
            boxBreakSide: "none",
            emaGap: 0,
            trendWeaknessScore: 0,
            rangeConfidence: 0,
            qualityScore: 0,
            reduceRatio: 0,
            exitUrgency: "LOW",
            exitConfidence: 0,
            evidence: "manual_takeover_observe_only",
            hasPosition: true,
            peakUnrealizedPnlPct: pnlPct,
            profitProtectionActive: false
        };
    }

    const s = args.snapshot;
    const boxPos = Number(s.boxPos ?? 0.5);
    const boxBreakSide = s.boxBreakSide ?? "none";
    const emaGap = Number(s.emaGap ?? 0);
    const tw = Number(s.trendWeaknessScore ?? 1);
    const rc = Number(s.rangeConfidence ?? 0);
    const qs = Number(s.qualityScore ?? 0);
    const hasPosition = pos != null;
    const entryPrice = Number(pos?.entryPrice ?? 0);
    const markPrice = Number(args.markPrice ?? 0);

    const pnlStopProtectJudgment =
        hasPosition && (side === "long" || side === "short")
            ? computePnlStopProtectJudgmentPct({
                  side,
                  entryPrice,
                  markPrice,
                  leverage: Number(pos?.leverage ?? 0),
                  pnlPctNetFallback: pnlPct
              })
            : { pnlStopProtectPct: pnlPct, source: "pnl_pct_net_fallback" as const };
    const pnlStopProtectPct = pnlStopProtectJudgment.pnlStopProtectPct;

    const shockAgainst =
        (side === "long" && args.judgment.shockPhase === "DOWN_SHOCK") ||
        (side === "short" && args.judgment.shockPhase === "UP_SHOCK");

    // Current directional state is reduce authority only. It is not independent terminal-exit proof.
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

    const actualStopBreached =
        ledgerStopPx != null &&
        (side === "long" || side === "short") &&
        markPrice > 0 &&
        isV2StopPriceBreached(side, markPrice, ledgerStopPx);

    // Keep the PNL gate pure. Shock/invalidation are judged explicitly below instead of bypassing
    // the noise floor inside pnl-stop-gate.
    const pnlGateResult = evaluatePnlStopMeaningfulMoveGate({
        symbol: args.symbol,
        side,
        entryPrice,
        markPrice,
        leverage: Number(pos?.leverage ?? 0),
        pnlStopProtectPct,
        ledgerStopPx,
        atr20,
        slProtectionSatisfied: pos?.slProtectionSatisfied === true || pos?.isProtectiveStopRegistered === true,
        slProtectionProvisional: pos?.slProtectionProvisional === true,
        protectiveVisibilityGraceDeadlineMs: pos?.protectiveVisibilityGraceDeadlineMs ?? null,
        now: (args.v2State as any)?.now ?? Date.now(),
        protectiveSlAlgoId: pos?.protectiveSlAlgoId ?? null,
        structureBreached: false,
        invalidationBreachConfirmed: false,
        shockAgainst: false,
        hasAdverseDirectionalAuthority: false,
        thresholdActionCandidate
    });

    const adverseMoveMeasured = entryPrice > 0 && markPrice > 0;
    const adverseMoveLargeEnoughForDefensiveAction =
        !adverseMoveMeasured ||
        pnlGateResult.underlyingAdverseMovePct >= MIN_DEFENSIVE_REDUCE_ADVERSE_MOVE_PCT;

    const rawInvalidation = pos?.structureBreached === true || args.invalidationBreachConfirmed === true;
    const secondaryInvalidationConfirmation =
        args.structuralBreakConfirmed === true ||
        args.boxBreakConfirmed === true ||
        args.reversalConfirmed === true;

    // DirectionalShockState alone is intentionally excluded here. It may authorize a reduction below,
    // but cannot turn a ~0.06% move into V2_EXIT_INVALIDATION.
    const hardInvalidationConfirmed =
        rawInvalidation &&
        adverseMoveLargeEnoughForDefensiveAction &&
        (shockAgainst || secondaryInvalidationConfirmation);

    const priorDefensiveReduce =
        isPriorDefensiveReduce(pos?.lastReduceReason) ||
        (typeof pos?.protectivePartialReduceCount === "number" && pos.protectivePartialReduceCount > 0);

    let action: V2ExitPolicyResult["action"] = "HOLD";
    let reason: V2ExitPolicyResult["reason"] = "NO_EXIT_SIGNAL";
    let reduceRatio = 0;
    let evidence = dual ? "dual_position_detected" : "single_position";

    if (!hasPosition) {
        action = "HOLD";
        reason = "NO_POSITION_HOLD";
    } else if (actualStopBreached) {
        // Actual committed stop remains sovereign regardless of the churn guards.
        action = "FULL_EXIT";
        reason = "PNL_STOP_PROTECT";
        reduceRatio = 1;
        evidence += "|committed_stop_breached";
    } else if (hardInvalidationConfirmed) {
        action = "FULL_EXIT";
        reason = "V2_EXIT_INVALIDATION";
        reduceRatio = 1;
        evidence += "|hard_invalidation_confirmed_with_absolute_move";
    } else if (rawInvalidation) {
        action = "HOLD";
        reason = "NO_EXIT_SIGNAL";
        reduceRatio = 0;
        evidence += adverseMoveLargeEnoughForDefensiveAction
            ? "|invalidation_waiting_independent_confirmation"
            : "|invalidation_noise_suppressed_wait_confirmation";
    } else if (pnlGateResult.finalAction === "FULL_EXIT") {
        if (!adverseMoveLargeEnoughForDefensiveAction) {
            action = "HOLD";
            reason = "NO_EXIT_SIGNAL";
            reduceRatio = 0;
            evidence += `|pnl_stop_full_exit_absolute_noise_floor_hold:${pnlGateResult.underlyingAdverseMovePct}`;
        } else {
            action = "FULL_EXIT";
            reason = "PNL_STOP_PROTECT";
            reduceRatio = 1;
            evidence += `|pnl_stop_critical|${pnlGateResult.evidence}`;
        }
    } else if (pnlGateResult.finalAction === "REDUCE") {
        if (!adverseMoveLargeEnoughForDefensiveAction) {
            action = "HOLD";
            reason = "NO_EXIT_SIGNAL";
            reduceRatio = 0;
            evidence += `|pnl_stop_absolute_noise_floor_hold:${pnlGateResult.underlyingAdverseMovePct}`;
        } else if (priorDefensiveReduce) {
            action = "HOLD";
            reason = "NO_EXIT_SIGNAL";
            reduceRatio = 0;
            evidence += "|repeat_defensive_reduce_suppressed";
        } else {
            action = "REDUCE";
            reason = "PNL_STOP_PROTECT";
            reduceRatio = PNL_STOP_REDUCE_RATIO;
            evidence += `|pnl_stop_reduce_once|${pnlGateResult.evidence}`;
        }
    } else if (shockAgainst) {
        // A current adverse shock remains strong protection, but not inside measured micro-noise.
        if (!adverseMoveLargeEnoughForDefensiveAction) {
            action = "WATCH";
            reason = "TRANSITION_PROTECTIVE_WATCH";
            reduceRatio = 0;
            evidence += "|adverse_shock_micro_noise_watch";
        } else {
            action = "FULL_EXIT";
            reason = "SHOCK_FULL_EXIT_AGAINST_POSITION";
            reduceRatio = 1;
            evidence += "|shock_full_exit_against_meaningful_move";
        }
    } else if (hasAdverseDirectionalAuthority) {
        if (!adverseMoveLargeEnoughForDefensiveAction) {
            action = "WATCH";
            reason = "TRANSITION_PROTECTIVE_WATCH";
            reduceRatio = 0;
            evidence += "|directional_shock_micro_noise_watch";
        } else if (priorDefensiveReduce) {
            action = "WATCH";
            reason = "TRANSITION_PROTECTIVE_WATCH";
            reduceRatio = 0;
            evidence += "|repeat_directional_defensive_reduce_suppressed";
        } else {
            action = "REDUCE";
            reason = "SHOCK_PROTECTIVE_REDUCE";
            reduceRatio = 0.3;
            evidence += "|shock_protective_once_meaningful_move";
        }
    } else if (args.judgment.regime_final === "TRANSITION") {
        if (args.judgment.transitionPhase === "CONFLICT") {
            if (pnlPct <= 0 && !adverseMoveLargeEnoughForDefensiveAction) {
                action = "WATCH";
                reason = "TRANSITION_PROTECTIVE_WATCH";
                reduceRatio = 0;
                evidence += "|transition_conflict_micro_noise_watch";
            } else if (priorDefensiveReduce) {
                action = "WATCH";
                reason = "TRANSITION_PROTECTIVE_WATCH";
                reduceRatio = 0;
                evidence += "|repeat_transition_reduce_suppressed";
            } else {
                action = "REDUCE";
                reason = "TRANSITION_REDUCE_ON_CONFLICT";
                reduceRatio = pnlPct > 0 ? 0.25 : 0.3;
                evidence += "|transition_conflict_reduce_once";
            }
        } else {
            action = "WATCH";
            reason = "TRANSITION_PROTECTIVE_WATCH";
            reduceRatio = 0;
            evidence += "|transition_watch";
        }
    } else if (args.judgment.regime_final === "RANGE") {
        const priorRangeOppositePartial =
            pos?.rangeOppositePartialTaken === true;

        if (side === "long") {
            if ((args.judgment.rangePhase === "UPPER" || boxPos >= 0.74) && pnlPct > 0) {
                if (priorRangeOppositePartial) {
                    action = "HOLD";
                    reason = "RANGE_PROFIT_PROTECT";
                    reduceRatio = 0;
                    evidence += "|repeat_range_opposite_edge_partial_suppressed";
                } else {
                    action = "PARTIAL_TAKE_PROFIT";
                    reason = "RANGE_PARTIAL_AT_OPPOSITE_EDGE";
                    reduceRatio = 0.4;
                    evidence += "|range_long_opposite_edge";
                }
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
                if (priorRangeOppositePartial) {
                    action = "HOLD";
                    reason = "RANGE_PROFIT_PROTECT";
                    reduceRatio = 0;
                    evidence += "|repeat_range_opposite_edge_partial_suppressed";
                } else {
                    action = "PARTIAL_TAKE_PROFIT";
                    reason = "RANGE_PARTIAL_AT_OPPOSITE_EDGE";
                    reduceRatio = 0.4;
                    evidence += "|range_short_opposite_edge";
                }
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
        const trendWeakOrExhausted = args.judgment.trendPhase === "EXHAUSTION" || tw >= 0.55;
        const trendHardInvalid = (side === "long" && emaGap < 0) || (side === "short" && emaGap > 0) || tw >= 0.75;

        if (trendHardInvalid && pnlPct <= 0 && adverseMoveLargeEnoughForDefensiveAction) {
            action = "FULL_EXIT";
            reason = "TREND_FULL_EXIT_EMA60_INVALID";
            reduceRatio = 1;
            evidence += "|trend_invalidation_meaningful_move";
        } else if (trendWeakOrExhausted && pnlPct > 0) {
            action = "PARTIAL_TAKE_PROFIT";
            if (args.judgment.trendPhase === "EXHAUSTION" || tw >= 0.65) {
                reason = "TREND_EXHAUSTION_REDUCE_50PCT";
                reduceRatio = 0.5;
                evidence += "|trend_exhaustion_profit_reduce_50";
            } else {
                reason = "TREND_WEAKNESS_REDUCE_30PCT";
                reduceRatio = 0.3;
                evidence += "|trend_weakness_profit_reduce_30";
            }
        } else if (trendWeakOrExhausted && pnlPct <= 0) {
            // Do not stack a so-called take-profit reduction on an underwater position.
            action = "WATCH";
            reason = "TREND_HOLD_VALID";
            reduceRatio = 0;
            evidence += priorDefensiveReduce
                ? "|trend_reduce_after_defensive_trim_suppressed"
                : "|trend_loss_weakness_watch_no_partial";
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
            invalidationBreachConfirmed: hardInvalidationConfirmed,
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

    // --- V2 PROFIT PROTECTION PIPELINE ---
    const peakPnl = Number(pos?.peakUnrealizedPnlPct ?? pnlPct);

    if (hasPosition && (action === "HOLD" || action === "WATCH")) {
        let profitAction: V2ExitAction = action;
        let profitReason: V2ExitReason = reason;
        let profitReduce = reduceRatio;

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
                invalidationBreachConfirmed: hardInvalidationConfirmed,
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
