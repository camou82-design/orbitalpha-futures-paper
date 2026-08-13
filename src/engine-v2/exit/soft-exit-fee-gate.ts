import type { V2ExitAction, V2ExitReason, V2ExitUrgency } from "./types";

export const DEFAULT_SOFT_EXIT_SLIPPAGE_BUFFER_PCT = 0.0008;

export type SoftExitFeeComponentPcts = Readonly<{
    entryFeePct: number;
    exitFeePct: number;
    slippageBufferPct: number;
    feeBreakEvenPct: number;
}>;

export function computeGrossReturnPct(input: Readonly<{
    positionSide: "long" | "short" | "none";
    entryPrice: number;
    markPrice: number;
    reportedPnlPct?: number | null;
}>): number {
    if (input.reportedPnlPct != null && Number.isFinite(input.reportedPnlPct) && input.reportedPnlPct !== 0) {
        return input.reportedPnlPct;
    }
    const entry = input.entryPrice;
    const mark = input.markPrice;
    if (!(entry > 0 && mark > 0) || input.positionSide === "none") return 0;
    return input.positionSide === "long" ? (mark - entry) / entry : (entry - mark) / entry;
}

export function computeSoftExitFeeComponentPcts(input: Readonly<{
    positionNotionalUsd: number;
    feeRate: number;
    entryFeeUsd?: number | null;
    slippageBufferPct?: number;
}>): SoftExitFeeComponentPcts {
    const notional = Math.max(0, input.positionNotionalUsd);
    const slippageBufferPct = input.slippageBufferPct ?? DEFAULT_SOFT_EXIT_SLIPPAGE_BUFFER_PCT;
    if (notional <= 0) {
        return {
            entryFeePct: Number.POSITIVE_INFINITY,
            exitFeePct: Number.POSITIVE_INFINITY,
            slippageBufferPct,
            feeBreakEvenPct: Number.POSITIVE_INFINITY
        };
    }
    const entryFee =
        input.entryFeeUsd != null && Number.isFinite(input.entryFeeUsd) && input.entryFeeUsd > 0
            ? input.entryFeeUsd
            : notional * input.feeRate;
    const exitFee = notional * input.feeRate;
    const slippage = notional * slippageBufferPct;
    return {
        entryFeePct: entryFee / notional,
        exitFeePct: exitFee / notional,
        slippageBufferPct,
        feeBreakEvenPct: (entryFee + exitFee + slippage) / notional
    };
}

export function computeSoftExitFeeBreakEvenPct(input: Readonly<{
    positionNotionalUsd: number;
    feeRate: number;
    entryFeeUsd?: number | null;
    slippageBufferPct?: number;
}>): number {
    return computeSoftExitFeeComponentPcts(input).feeBreakEvenPct;
}

export function isProfitProtectionFeeGateBypass(reason: V2ExitReason): boolean {
    return reason === "PROFIT_PROTECTION_BREAKEVEN_EXIT" || reason === "PROFIT_PROTECTION_TRAILING_STOP";
}

export function isSoftExitFeeGateEligible(reason: V2ExitReason): boolean {
    return (
        reason === "CANDIDATE_LOST_SOFT_EXIT" ||
        reason === "WEAK_QUALITY_REGIME_SOFT_EXIT" ||
        reason === "GENERAL_SOFT_FULL_EXIT"
    );
}

export function isHardV2FullExitBypass(input: Readonly<{
    reason: V2ExitReason;
    exitUrgency: V2ExitUrgency;
    oppositeHysteresisState?: string;
    invalidationBreachConfirmed?: boolean;
    reversalConfirmed?: boolean;
    grossReturnPct: number;
}>): boolean {
    if (input.grossReturnPct <= 0) return true;

    const reason = String(input.reason);
    if (reason === "PNL_STOP_PROTECT") return true;
    if (reason === "SHOCK_FULL_EXIT_AGAINST_POSITION") return true;
    if (input.exitUrgency === "CRITICAL") return true;
    if (input.oppositeHysteresisState === "THESIS_INVALIDATED_EXIT") return true;
    if (input.invalidationBreachConfirmed === true) return true;
    if (reason === "RANGE_FULL_EXIT_BOX_BREAK") return true;
    if (reason === "TREND_FULL_EXIT_EMA60_INVALID" && input.invalidationBreachConfirmed) return true;
    if (input.reversalConfirmed && input.invalidationBreachConfirmed) return true;
    return false;
}

export function resolveSoftExitFeeGateBypassReason(input: Readonly<{
    reason: V2ExitReason;
    exitUrgency: V2ExitUrgency;
    oppositeHysteresisState?: string;
    invalidationBreachConfirmed?: boolean;
    reversalConfirmed?: boolean;
    grossReturnPct: number;
}>): string | null {
    if (input.grossReturnPct <= 0) return "loss_position";
    if (isProfitProtectionFeeGateBypass(input.reason)) {
        return String(input.reason).toLowerCase();
    }
    if (!isSoftExitFeeGateEligible(input.reason)) return "not_fee_gate_eligible_reason";

    const reason = String(input.reason);
    if (reason === "PNL_STOP_PROTECT") return "hard_exit_pnl_stop";
    if (reason === "SHOCK_FULL_EXIT_AGAINST_POSITION") return "hard_exit_shock";
    if (input.exitUrgency === "CRITICAL") return "hard_exit_critical_urgency";
    if (input.oppositeHysteresisState === "THESIS_INVALIDATED_EXIT") return "hard_exit_thesis_invalidated";
    if (input.invalidationBreachConfirmed === true) return "hard_exit_invalidation_confirmed";
    if (reason === "RANGE_FULL_EXIT_BOX_BREAK") return "hard_exit_box_break";
    if (reason === "TREND_FULL_EXIT_EMA60_INVALID" && input.invalidationBreachConfirmed) {
        return "hard_exit_trend_invalidation_confirmed";
    }
    if (input.reversalConfirmed && input.invalidationBreachConfirmed) return "hard_exit_reversal_confirmed";
    return null;
}

export function isSoftV2FullExitCandidate(input: Readonly<{
    action: V2ExitAction;
    shouldExit: boolean;
}>): boolean {
    return input.action === "FULL_EXIT" && input.shouldExit === true;
}

export type SoftExitFeeGateResult = Readonly<{
    applied: boolean;
    action: V2ExitAction;
    reason: V2ExitReason;
    shouldExit: boolean;
    shouldReduce: boolean;
    shouldPartial: boolean;
    reduceRatio: number;
    grossReturnPct: number;
    entryFeePct: number;
    exitFeePct: number;
    slippageBufferPct: number;
    feeBreakEvenPct: number;
    gateAction: "FULL_EXIT" | "HOLD_RECHECK";
    bypassReason: string | null;
    blockReason: string | null;
    evidenceSuffix: string;
    evaluated: boolean;
}>;

export function applySoftExitFeeGate(input: Readonly<{
    action: V2ExitAction;
    reason: V2ExitReason;
    shouldExit: boolean;
    shouldReduce: boolean;
    shouldPartial: boolean;
    reduceRatio: number;
    grossReturnPct: number;
    positionNotionalUsd: number;
    feeRate: number;
    entryFeeUsd?: number | null;
    slippageBufferPct?: number;
    exitUrgency: V2ExitUrgency;
    oppositeHysteresisState?: string;
    invalidationBreachConfirmed?: boolean;
    reversalConfirmed?: boolean;
}>): SoftExitFeeGateResult {
    const feeComponents = computeSoftExitFeeComponentPcts({
        positionNotionalUsd: input.positionNotionalUsd,
        feeRate: input.feeRate,
        entryFeeUsd: input.entryFeeUsd,
        slippageBufferPct: input.slippageBufferPct
    });

    const base = {
        applied: false,
        action: input.action,
        reason: input.reason,
        shouldExit: input.shouldExit,
        shouldReduce: input.shouldReduce,
        shouldPartial: input.shouldPartial,
        reduceRatio: input.reduceRatio,
        grossReturnPct: input.grossReturnPct,
        entryFeePct: feeComponents.entryFeePct,
        exitFeePct: feeComponents.exitFeePct,
        slippageBufferPct: feeComponents.slippageBufferPct,
        feeBreakEvenPct: feeComponents.feeBreakEvenPct,
        gateAction: "FULL_EXIT" as const,
        bypassReason: null as string | null,
        blockReason: null as string | null,
        evidenceSuffix: "",
        evaluated: false
    };

    if (!isSoftV2FullExitCandidate({ action: input.action, shouldExit: input.shouldExit })) {
        return base;
    }

    const bypassReason = resolveSoftExitFeeGateBypassReason({
        reason: input.reason,
        exitUrgency: input.exitUrgency,
        oppositeHysteresisState: input.oppositeHysteresisState,
        invalidationBreachConfirmed: input.invalidationBreachConfirmed,
        reversalConfirmed: input.reversalConfirmed,
        grossReturnPct: input.grossReturnPct
    });

    if (bypassReason != null) {
        return {
            ...base,
            evaluated: true,
            gateAction: "FULL_EXIT",
            bypassReason
        };
    }

    if (input.grossReturnPct > 0 && input.grossReturnPct <= feeComponents.feeBreakEvenPct) {
        return {
            applied: true,
            action: "HOLD",
            reason: "SOFT_EXIT_FEE_HOLD_RECHECK",
            shouldExit: false,
            shouldReduce: false,
            shouldPartial: false,
            reduceRatio: 0,
            grossReturnPct: input.grossReturnPct,
            entryFeePct: feeComponents.entryFeePct,
            exitFeePct: feeComponents.exitFeePct,
            slippageBufferPct: feeComponents.slippageBufferPct,
            feeBreakEvenPct: feeComponents.feeBreakEvenPct,
            gateAction: "HOLD_RECHECK",
            bypassReason: null,
            blockReason: "soft_exit_fee_below_round_trip_break_even",
            evidenceSuffix: "|soft_exit_fee_gate_hold_recheck",
            evaluated: true
        };
    }

    return {
        ...base,
        evaluated: true,
        gateAction: "FULL_EXIT",
        bypassReason: null
    };
}

export function buildSoftExitFeeGateProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_SOFT_EXIT_FEE_GATE_PROOF", ...input };
}
