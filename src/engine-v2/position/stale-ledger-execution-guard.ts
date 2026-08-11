export const STALE_LEDGER_SUPPRESSED_ACTIONS = [
    "take_profit_close",
    "stop_loss_close",
    "partial_reduce",
    "full_reduce",
    "protective_ensure_submit",
    "addon",
    "reverse",
    "signed_order_submit"
] as const;

export function evaluateStaleLedgerExecutionSuppression(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    authoritativePositionsReady: boolean;
    actualKeyExists: boolean;
    ledgerKeyExists: boolean;
}>): Readonly<{
    suppressed: boolean;
    reconcileState: "ENGINE_LEDGER_STALE" | "LEDGER_STALE_PENDING" | null;
    suppressedActions: readonly string[];
}> {
    const stale =
        input.authoritativePositionsReady &&
        input.ledgerKeyExists &&
        !input.actualKeyExists;

    if (!stale) {
        return {
            suppressed: false,
            reconcileState: null,
            suppressedActions: []
        };
    }

    return {
        suppressed: true,
        reconcileState: "ENGINE_LEDGER_STALE",
        suppressedActions: STALE_LEDGER_SUPPRESSED_ACTIONS
    };
}

export function buildStaleLedgerExecutionSuppressedProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "STALE_LEDGER_EXECUTION_SUPPRESSED_PROOF", ...input };
}
