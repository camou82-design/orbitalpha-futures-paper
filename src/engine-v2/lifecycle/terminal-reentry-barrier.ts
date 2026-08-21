import type { PaperOpenPositionRecord } from "../../models/types";

export type TerminalReentryBarrierResult = Readonly<{
    blocked: boolean;
    reason: string;
    closePending: boolean;
    finalizePending: boolean;
    actualPositionExists: boolean;
    terminalFillConfirmed: boolean;
    lossStateCommitted: boolean;
    positionCycleId: string | null;
}>;

function rowHasClosePending(row: PaperOpenPositionRecord): boolean {
    if (row.closePendingOrdId && String(row.closePendingOrdId).trim().length > 0) return true;
    if (row.closePendingClOrdId && String(row.closePendingClOrdId).trim().length > 0) return true;
    if (row.lifecycleState === "CLOSE_PENDING") return true;
    if (row.lifecycleState === "CLOSE_ONLY_MANAGED" && row.closePendingAt != null) return true;
    return false;
}

function rowHasTerminalTransition(row: PaperOpenPositionRecord): boolean {
    if (row.finalizePending === true) return true;
    if (rowHasClosePending(row)) return true;
    if (row.lifecycleState === "PARTIAL_PENDING" && rowHasClosePending(row)) return true;
    if (row.pendingFinalizeFlowId && String(row.pendingFinalizeFlowId).trim().length > 0) return true;
    return false;
}

/**
 * Blocks new entry on a symbol while any prior position cycle is still in terminal close / finalize.
 */
export function evaluateTerminalReentryBarrier(input: Readonly<{
    symbol: string;
    requestedSide?: "long" | "short";
    openPositions: readonly PaperOpenPositionRecord[];
    openPositionsSourceAvailable?: boolean;
    actualOkxPositionExists?: boolean;
    terminalExitFlowIds?: ReadonlySet<string>;
}>): TerminalReentryBarrierResult {
    if (input.openPositionsSourceAvailable === false) {
        return {
            blocked: true,
            reason: "TERMINAL_STATE_UNAVAILABLE_FAIL_CLOSED",
            closePending: false,
            finalizePending: false,
            actualPositionExists: input.actualOkxPositionExists === true,
            terminalFillConfirmed: false,
            lossStateCommitted: false,
            positionCycleId: null
        };
    }

    const sym = String(input.symbol).toUpperCase();
    const rows = input.openPositions.filter(
        (r) => String(r.symbol).toUpperCase() === sym && (r.status ?? "open") === "open"
    );

    const none: TerminalReentryBarrierResult = {
        blocked: false,
        reason: "NO_TERMINAL_TRANSITION",
        closePending: false,
        finalizePending: false,
        actualPositionExists: input.actualOkxPositionExists === true,
        terminalFillConfirmed: false,
        lossStateCommitted: false,
        positionCycleId: null
    };

    if (rows.length === 0) return none;

    for (const row of rows) {
        const flowId = `${row.symbol}:${row.side}:${row.openedAt}`;
        if (input.terminalExitFlowIds?.has(flowId)) {
            return {
                blocked: true,
                reason: "TERMINAL_EXIT_CONSUMED_AWAITING_FINALIZE",
                closePending: rowHasClosePending(row),
                finalizePending: row.finalizePending === true,
                actualPositionExists: input.actualOkxPositionExists === true,
                terminalFillConfirmed: row.finalizePending === true,
                lossStateCommitted: row.finalizePending === true,
                positionCycleId: row.positionCycleId ?? row.pendingFinalizePositionCycleId ?? null
            };
        }
    }

    for (const row of rows) {
        if (!rowHasTerminalTransition(row)) continue;

        const closePending = rowHasClosePending(row);
        const finalizePending = row.finalizePending === true;
        let reason = "TERMINAL_CYCLE_IN_PROGRESS";
        if (finalizePending && closePending) reason = "FINALIZE_PENDING_WITH_CLOSE_PENDING";
        else if (finalizePending) reason = "FINALIZE_PENDING_AWAITING_OKX_FLAT";
        else if (closePending) reason = "CLOSE_PENDING_AWAITING_FILL";

        return {
            blocked: true,
            reason,
            closePending,
            finalizePending,
            actualPositionExists: input.actualOkxPositionExists === true,
            terminalFillConfirmed: finalizePending || closePending,
            lossStateCommitted: finalizePending,
            positionCycleId: row.positionCycleId ?? row.pendingFinalizePositionCycleId ?? null
        };
    }

    return none;
}

export function buildTerminalReentryBarrierProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_TERMINAL_REENTRY_BARRIER_PROOF", ...input };
}

/**
 * Resolves authoritative open-position lifecycle input for terminal barrier evaluation.
 * Fail closed when neither bridge openPositions nor ready empty v2 position state is available.
 */
export function resolveTerminalBarrierContext(input: Readonly<{
    bridgeOpenPositions?: unknown;
    positionStateReady?: boolean;
    symbolPositionsCount?: number;
}>): Readonly<{ openPositions: PaperOpenPositionRecord[]; openPositionsSourceAvailable: boolean }> {
    if (Array.isArray(input.bridgeOpenPositions)) {
        return {
            openPositions: input.bridgeOpenPositions as PaperOpenPositionRecord[],
            openPositionsSourceAvailable: true
        };
    }
    if (
        input.positionStateReady === true &&
        (input.symbolPositionsCount ?? 0) === 0
    ) {
        return { openPositions: [], openPositionsSourceAvailable: true };
    }
    return { openPositions: [], openPositionsSourceAvailable: false };
}
