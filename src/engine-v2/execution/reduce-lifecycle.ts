export type V2ReduceLifecycleState =
    | "IDLE"
    | "REQUESTED"
    | "SUBMITTED"
    | "PARTIALLY_FILLED"
    | "FILLED"
    | "TERMINAL";

export const V2_REDUCE_TERMINAL_OKX_STATES = new Set([
    "filled",
    "canceled",
    "cancelled",
    "rejected",
    "expired"
]);

export function buildReduceFlowKey(input: Readonly<{
    symbol: string;
    side: string;
    reason: string;
    targetContracts: number;
    decisionCandleTs: number;
}>): string {
    return [
        input.symbol,
        input.side,
        input.reason,
        input.targetContracts.toFixed(8),
        String(input.decisionCandleTs)
    ].join("|");
}

export function evaluateReduceResubmitAllowed(input: Readonly<{
    previousState: V2ReduceLifecycleState;
    okxOrderTerminal: boolean;
    okxOrderRejected: boolean;
    okxOrderCanceled: boolean;
    previousZeroFill: boolean;
    newDecisionCandle: boolean;
    actualContractsChanged: boolean;
    sameFlowKey: boolean;
}>): { resubmitAllowed: boolean; resubmitReason: string | null } {
    if (input.previousState === "IDLE" || input.previousState === "TERMINAL") {
        return { resubmitAllowed: true, resubmitReason: "idle_or_terminal" };
    }
    if (input.okxOrderCanceled || input.okxOrderRejected) {
        return { resubmitAllowed: true, resubmitReason: "previous_order_canceled_or_rejected" };
    }
    if (input.previousZeroFill && input.okxOrderTerminal) {
        return { resubmitAllowed: true, resubmitReason: "terminal_zero_fill" };
    }
    if (input.newDecisionCandle && !input.sameFlowKey) {
        return { resubmitAllowed: true, resubmitReason: "new_candle_decision" };
    }
    if (input.actualContractsChanged && !input.sameFlowKey) {
        return { resubmitAllowed: true, resubmitReason: "position_size_changed_new_target" };
    }
    if (
        input.previousState === "SUBMITTED" ||
        input.previousState === "REQUESTED" ||
        input.previousState === "PARTIALLY_FILLED"
    ) {
        return { resubmitAllowed: false, resubmitReason: "pending_submitted_state" };
    }
    return { resubmitAllowed: false, resubmitReason: "duplicate_flow_blocked" };
}

export function buildReduceExecutionLifecycleProof(input: Record<string, unknown>): Record<string, unknown> {
    return {
        event: "V2_REDUCE_EXECUTION_LIFECYCLE_PROOF",
        ...input
    };
}
