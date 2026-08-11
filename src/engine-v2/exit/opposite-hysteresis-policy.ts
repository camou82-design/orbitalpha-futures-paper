import type { MarketJudgmentOutput } from "../types";
import type { V2ExitAction, V2ExitReason } from "./types";

export type OppositeHysteresisState =
    | "NONE"
    | "WEAK_OPPOSITE_HOLD"
    | "PROFIT_PROTECT_HOLD"
    | "CONFIRMED_OPPOSITE_REDUCE"
    | "THESIS_INVALIDATED_EXIT";

export type EvaluateOppositeHysteresisArgs = Readonly<{
    symbol: string;
    positionSide: "long" | "short" | "none";
    trendSideCandidate: "long" | "short" | "none";
    rangeSideCandidate: "long" | "short" | "none";
    judgment: MarketJudgmentOutput;
    pnlPct: number;
    peakPnl: number;
    emaGap: number;
    trendWeaknessScore: number;
    boxBreakSide: "upper" | "lower" | "none";
    boxPos: number;
    proposedAction: V2ExitAction;
    proposedReason: V2ExitReason;
    proposedReduceRatio: number;
    reversalConfirmed?: boolean;
    sameCycleExitConsumed?: boolean;
    /** Fresh confirmed invalidation — required for THESIS_INVALIDATED_EXIT. */
    invalidationBreachConfirmed?: boolean;
    structuralBreakConfirmed?: boolean;
    boxBreakConfirmed?: boolean;
}>;

export type OppositeHysteresisResult = Readonly<{
    action: V2ExitAction;
    reason: V2ExitReason;
    reduceRatio: number;
    hysteresisState: OppositeHysteresisState;
    blockReason: string | null;
    thesisValid: boolean;
    profitProtectionActive: boolean;
    invalidationBreached: boolean;
    oppositeConfirmationFresh: boolean;
    oppositeCandidateWeak: boolean;
    finalPositionAction: V2ExitAction;
}>;

function isOppositeCandidate(
    positionSide: "long" | "short",
    candidate: "long" | "short" | "none"
): boolean {
    return candidate !== "none" && candidate !== positionSide;
}

function isSameSideTrend(
    positionSide: "long" | "short",
    trendSideCandidate: "long" | "short" | "none",
    emaGap: number
): boolean {
    if (trendSideCandidate === positionSide) return true;
    if (positionSide === "long" && emaGap > 0) return true;
    if (positionSide === "short" && emaGap < 0) return true;
    return false;
}

function detectSoftInvalidationSignal(input: EvaluateOppositeHysteresisArgs): boolean {
    const { positionSide, emaGap, trendWeaknessScore, boxBreakSide, judgment } = input;
    if (positionSide === "long") {
        if (emaGap < 0 || trendWeaknessScore >= 0.75) return true;
        if (boxBreakSide === "lower") return true;
    } else if (positionSide === "short") {
        if (emaGap > 0 || trendWeaknessScore >= 0.75) return true;
        if (boxBreakSide === "upper") return true;
    }
    if (judgment.trendPhase === "EXHAUSTION" && trendWeaknessScore >= 0.65) return true;
    return false;
}

function detectConfirmedInvalidationBreach(input: EvaluateOppositeHysteresisArgs): boolean {
    if (!detectSoftInvalidationSignal(input)) return false;
    if (input.invalidationBreachConfirmed === true) return true;
    if (input.structuralBreakConfirmed === true) return true;
    const { positionSide, boxBreakSide } = input;
    if (input.boxBreakConfirmed === true) {
        if (positionSide === "long" && boxBreakSide === "lower") return true;
        if (positionSide === "short" && boxBreakSide === "upper") return true;
    }
    if (input.reversalConfirmed === true && detectSoftInvalidationSignal(input)) return true;
    return false;
}

function detectOppositeConfirmationFresh(input: EvaluateOppositeHysteresisArgs): boolean {
    if (input.positionSide === "none") return false;
    if (input.reversalConfirmed === true) return true;
    const { positionSide, rangeSideCandidate, judgment, boxBreakSide } = input;
    if (!isOppositeCandidate(positionSide, rangeSideCandidate)) return false;
    if (judgment.transitionPhase === "CONFLICT" && judgment.subtype === "TRANSITION_CONFLICT") {
        return true;
    }
    if (positionSide === "long" && boxBreakSide === "lower") {
        return input.boxBreakConfirmed === true;
    }
    if (positionSide === "short" && boxBreakSide === "upper") {
        return input.boxBreakConfirmed === true;
    }
    return false;
}

function isThesisValid(input: EvaluateOppositeHysteresisArgs): boolean {
    if (input.positionSide === "none") return false;
    if (detectConfirmedInvalidationBreach(input)) return false;
    const shockAgainst =
        (input.positionSide === "long" && input.judgment.shockPhase === "DOWN_SHOCK") ||
        (input.positionSide === "short" && input.judgment.shockPhase === "UP_SHOCK");
    if (shockAgainst) return false;
    return isSameSideTrend(input.positionSide, input.trendSideCandidate, input.emaGap);
}

export function evaluateOppositePositionHysteresis(
    input: EvaluateOppositeHysteresisArgs
): OppositeHysteresisResult {
    const {
        positionSide,
        trendSideCandidate,
        rangeSideCandidate,
        proposedAction,
        proposedReason,
        proposedReduceRatio,
        pnlPct,
        peakPnl
    } = input;

    if (positionSide === "none") {
        return {
            action: proposedAction,
            reason: proposedReason,
            reduceRatio: proposedReduceRatio,
            hysteresisState: "NONE",
            blockReason: null,
            thesisValid: false,
            profitProtectionActive: false,
            invalidationBreached: false,
            oppositeConfirmationFresh: false,
            oppositeCandidateWeak: false,
            finalPositionAction: proposedAction
        };
    }

    const softInvalidationSignal = detectSoftInvalidationSignal(input);
    const invalidationBreached = detectConfirmedInvalidationBreach(input);
    const oppositeConfirmationFresh = detectOppositeConfirmationFresh(input);
    const rangeOpposite = isOppositeCandidate(positionSide, rangeSideCandidate);
    const trendOpposite = isOppositeCandidate(positionSide, trendSideCandidate);
    const thesisValid = isThesisValid(input);
    const oppositeCandidateWeak =
        rangeOpposite &&
        !trendOpposite &&
        thesisValid &&
        !invalidationBreached &&
        !oppositeConfirmationFresh;
    const profitProtectionActive = peakPnl >= 0.015 && pnlPct < 0.002;

    let action = proposedAction;
    let reason = proposedReason;
    let reduceRatio = proposedReduceRatio;
    let hysteresisState: OppositeHysteresisState = "NONE";
    let blockReason: string | null = null;

    if (input.sameCycleExitConsumed === true && proposedAction !== "FULL_EXIT") {
        blockReason = "same_cycle_reverse_blocked";
    }

    if (invalidationBreached && proposedAction === "FULL_EXIT") {
        hysteresisState = "THESIS_INVALIDATED_EXIT";
    } else if (
        softInvalidationSignal &&
        !invalidationBreached &&
        (proposedAction === "FULL_EXIT" ||
            proposedReason === "TREND_FULL_EXIT_EMA60_INVALID" ||
            proposedReason === "RANGE_FULL_EXIT_BOX_BREAK")
    ) {
        action = "HOLD";
        reason = "TREND_HOLD_VALID";
        reduceRatio = 0;
        hysteresisState =
            profitProtectionActive && thesisValid ? "PROFIT_PROTECT_HOLD" : "WEAK_OPPOSITE_HOLD";
        blockReason = "unconfirmed_invalidation_hold";
    } else if (
        oppositeConfirmationFresh &&
        !invalidationBreached &&
        (proposedAction === "FULL_EXIT" || proposedReason.startsWith("PROFIT_PROTECTION_"))
    ) {
        action = "REDUCE";
        reason = "TRANSITION_REDUCE_ON_CONFLICT";
        reduceRatio = Math.min(0.45, Math.max(0.3, proposedReduceRatio || 0.35));
        hysteresisState = "CONFIRMED_OPPOSITE_REDUCE";
        blockReason = "confirmed_opposite_defensive_reduce";
    } else if (
        profitProtectionActive &&
        thesisValid &&
        (proposedAction === "FULL_EXIT" || proposedReason.startsWith("PROFIT_PROTECTION_"))
    ) {
        action = "HOLD";
        reason = "TREND_HOLD_VALID";
        reduceRatio = 0;
        hysteresisState = "PROFIT_PROTECT_HOLD";
        blockReason = "profit_protection_hold_thesis_valid";
    } else if (
        oppositeCandidateWeak &&
        (proposedAction === "FULL_EXIT" ||
            proposedReason.startsWith("PROFIT_PROTECTION_") ||
            (proposedAction === "REDUCE" && proposedReason === "TRANSITION_REDUCE_ON_CONFLICT"))
    ) {
        action = "HOLD";
        reason = "TREND_HOLD_VALID";
        reduceRatio = 0;
        hysteresisState = "WEAK_OPPOSITE_HOLD";
        blockReason = "weak_opposite_conflict_hold";
    }

    return {
        action,
        reason,
        reduceRatio,
        hysteresisState,
        blockReason,
        thesisValid,
        profitProtectionActive,
        invalidationBreached,
        oppositeConfirmationFresh,
        oppositeCandidateWeak,
        finalPositionAction: action
    };
}

export function buildOppositePositionHysteresisProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_OPPOSITE_POSITION_HYSTERESIS_PROOF", ...input };
}
