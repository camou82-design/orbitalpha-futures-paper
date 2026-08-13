import type { V2ExitAction, V2ExitReason, V2ExitUrgency } from "./types";
import {
    applySoftExitFeeGate,
    buildSoftExitFeeGateProof,
    computeGrossReturnPct,
    type SoftExitFeeGateResult
} from "./soft-exit-fee-gate";
import { mapPaperCloseToSoftExitFeeGateReason, mapV2ExitPolicyToSoftExitFeeGateReason } from "./soft-exit-fee-reason-map";

export type PaperSoftExitFeeGateEvaluation = Readonly<{
    wired: boolean;
    proceed: boolean;
    softExitFeeGateApproved: boolean;
    mappedFeeGateReason: V2ExitReason | null;
    authoritativeCloseReason: string;
    authoritativeCloseSource: string;
    gate: SoftExitFeeGateResult | null;
    proof: Record<string, unknown> | null;
}>;

export function evaluatePaperCloseSoftExitFeeGate(input: Readonly<{
    closeReason: string;
    closeSource: string;
    positionSide: "long" | "short";
    entryPrice: number;
    markPrice: number;
    positionNotionalUsd: number;
    feeRate: number;
    exitUrgency?: V2ExitUrgency;
}>): PaperSoftExitFeeGateEvaluation {
    const mappedFeeGateReason = mapPaperCloseToSoftExitFeeGateReason({
        closeReason: input.closeReason,
        closeSource: input.closeSource
    });
    if (mappedFeeGateReason == null) {
        return {
            wired: false,
            proceed: true,
            softExitFeeGateApproved: false,
            mappedFeeGateReason: null,
            authoritativeCloseReason: input.closeReason,
            authoritativeCloseSource: input.closeSource,
            gate: null,
            proof: null
        };
    }

    const grossReturnPct = computeGrossReturnPct({
        positionSide: input.positionSide,
        entryPrice: input.entryPrice,
        markPrice: input.markPrice
    });
    const gate = applySoftExitFeeGate({
        action: "FULL_EXIT",
        reason: mappedFeeGateReason,
        shouldExit: true,
        shouldReduce: false,
        shouldPartial: false,
        reduceRatio: 1,
        grossReturnPct,
        positionNotionalUsd: input.positionNotionalUsd,
        feeRate: input.feeRate,
        entryFeeUsd: input.positionNotionalUsd * input.feeRate,
        exitUrgency: input.exitUrgency ?? "MID"
    });
    const proof = buildSoftExitFeeGateProof({
        authoritative_close_reason: input.closeReason,
        authoritative_close_source: input.closeSource,
        mapped_fee_gate_reason: mappedFeeGateReason,
        prior_reason: input.closeReason,
        prior_action: "FULL_EXIT",
        final_action: gate.applied ? gate.action : "FULL_EXIT",
        final_reason: gate.applied ? gate.reason : input.closeReason,
        gross_return_pct: gate.grossReturnPct,
        entry_fee_pct: gate.entryFeePct,
        exit_fee_pct: gate.exitFeePct,
        slippage_buffer_pct: gate.slippageBufferPct,
        fee_break_even_pct: gate.feeBreakEvenPct,
        gate_action: gate.gateAction,
        bypass_reason: gate.bypassReason,
        block_reason: gate.blockReason
    });

    return {
        wired: true,
        proceed: !gate.applied,
        softExitFeeGateApproved: gate.evaluated && !gate.applied && gate.gateAction === "FULL_EXIT",
        mappedFeeGateReason,
        authoritativeCloseReason: input.closeReason,
        authoritativeCloseSource: input.closeSource,
        gate,
        proof
    };
}

export function evaluateV2ExitPolicySoftExitFeeGate(input: Readonly<{
    policyReason: V2ExitReason;
    policyAction: V2ExitAction;
    shouldExit: boolean;
    shouldReduce: boolean;
    shouldPartial: boolean;
    reduceRatio: number;
    grossReturnPct: number;
    positionNotionalUsd: number;
    feeRate: number;
    exitUrgency: V2ExitUrgency;
    oppositeHysteresisState?: string;
    invalidationBreachConfirmed?: boolean;
    reversalConfirmed?: boolean;
}>): SoftExitFeeGateResult & Readonly<{ mappedFeeGateReason: V2ExitReason }> {
    const mappedFeeGateReason = mapV2ExitPolicyToSoftExitFeeGateReason(input.policyReason);
    const gate = applySoftExitFeeGate({
        action: input.policyAction,
        reason: mappedFeeGateReason,
        shouldExit: input.shouldExit,
        shouldReduce: input.shouldReduce,
        shouldPartial: input.shouldPartial,
        reduceRatio: input.reduceRatio,
        grossReturnPct: input.grossReturnPct,
        positionNotionalUsd: input.positionNotionalUsd,
        feeRate: input.feeRate,
        entryFeeUsd: input.positionNotionalUsd * input.feeRate,
        exitUrgency: input.exitUrgency,
        oppositeHysteresisState: input.oppositeHysteresisState,
        invalidationBreachConfirmed: input.invalidationBreachConfirmed,
        reversalConfirmed: input.reversalConfirmed
    });
    return { ...gate, mappedFeeGateReason };
}
