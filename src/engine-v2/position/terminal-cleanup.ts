import type { PaperOpenPositionRecord } from "../../models/types";

export type TerminalCleanupResult = Readonly<{
    cleared: boolean;
    fieldsCleared: string[];
}>;

export function applyPositionTerminalCleanup(
    open: PaperOpenPositionRecord
): TerminalCleanupResult {
    const fieldsCleared: string[] = [];
    const mark = (field: string, apply: () => void): void => {
        fieldsCleared.push(field);
        apply();
    };

    if (open.lifecycleState != null && open.lifecycleState !== "FAILED") {
        mark("lifecycleState", () => {
            (open as { lifecycleState?: string }).lifecycleState = undefined;
        });
    }
    if (open.reconcileState != null) {
        mark("reconcileState", () => {
            open.reconcileState = undefined;
        });
    }
    if (open.partialPendingOrdId != null) mark("partialPendingOrdId", () => { open.partialPendingOrdId = undefined; });
    if (open.partialPendingClOrdId != null) mark("partialPendingClOrdId", () => { open.partialPendingClOrdId = undefined; });
    if (open.partialPendingContracts != null) mark("partialPendingContracts", () => { open.partialPendingContracts = undefined; });
    if (open.closePendingOrdId != null) mark("closePendingOrdId", () => { open.closePendingOrdId = undefined; });
    if (open.closePendingClOrdId != null) mark("closePendingClOrdId", () => { open.closePendingClOrdId = undefined; });
    if (open.protectiveSlAlgoId != null) mark("protectiveSlAlgoId", () => { open.protectiveSlAlgoId = undefined; });
    if (open.protectiveTpAlgoId != null) mark("protectiveTpAlgoId", () => { open.protectiveTpAlgoId = undefined; });
    if (open.addonRebuildRequired != null) mark("addonRebuildRequired", () => { open.addonRebuildRequired = false; });
    if (open.breakevenStopRequired != null) mark("breakevenStopRequired", () => { open.breakevenStopRequired = false; });
    if (open.breakevenStopConfirmed != null) mark("breakevenStopConfirmed", () => { open.breakevenStopConfirmed = false; });
    if ((open as { shockReduceState?: string }).shockReduceState != null) {
        mark("shockReduceState", () => {
            (open as { shockReduceState?: string }).shockReduceState = "TERMINAL";
        });
    }

    return { cleared: fieldsCleared.length > 0, fieldsCleared };
}

export function buildPositionTerminalCleanupProof(input: Readonly<{
    symbol: string;
    side: string;
    okxActualContracts: number;
    cleanup: TerminalCleanupResult;
}>): Record<string, unknown> {
    return {
        event: "V2_POSITION_TERMINAL_CLEANUP_PROOF",
        symbol: input.symbol,
        side: input.side,
        okx_actual_contracts: input.okxActualContracts,
        stale_state_cleared: input.cleanup.cleared,
        fields_cleared: input.cleanup.fieldsCleared
    };
}

export function buildPositionRealityReconcileProof(input: Readonly<{
    symbol: string;
    side: string;
    okxActualSide: string | null;
    okxActualContracts: number;
    ledgerSide: string | null;
    ledgerContracts: number | null;
    finalPositionExists: boolean;
    finalManagementSide: string | null;
    staleStateCleared: boolean;
}>): Record<string, unknown> {
    return {
        event: "V2_POSITION_REALITY_RECONCILE_PROOF",
        symbol: input.symbol,
        side: input.side,
        okx_actual_side: input.okxActualSide,
        okx_actual_contracts: input.okxActualContracts,
        ledger_side: input.ledgerSide,
        ledger_contracts: input.ledgerContracts,
        final_position_exists: input.finalPositionExists,
        final_management_side: input.finalManagementSide,
        stale_state_cleared: input.staleStateCleared
    };
}
