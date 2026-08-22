import type { PaperOpenPositionRecord } from "../../models/types";

/**
 * Explicit canonical position lifecycle states.
 * Only TERMINAL indicates that prior cycle is fully terminal and flat.
 * CLOSE_SUBMITTED / CLOSE_FILL_PENDING / FLAT_CONFIRM_PENDING / FINALIZE_PENDING / UNAVAILABLE indicate active terminal transition in-flight.
 * OPEN indicates an active open position without terminal transition.
 */
export type PositionLifecycleState =
    | "OPEN"
    | "CLOSE_SUBMITTED"
    | "CLOSE_FILL_PENDING"
    | "FLAT_CONFIRM_PENDING"
    | "FINALIZE_PENDING"
    | "TERMINAL"
    | "UNAVAILABLE";

export type PositionLifecycleTruthInput = Readonly<{
    symbol: string;
    requestedSide?: "long" | "short";
    openPositions?: readonly PaperOpenPositionRecord[] | null;
    openPositionsSourceAvailable?: boolean;
    actualOkxPositionExists?: boolean;
    terminalExitFlowIds?: ReadonlySet<string>;
}>;

export type PositionLifecycleTruthResult = Readonly<{
    lifecycleState: PositionLifecycleState;
    isTerminal: boolean;
    hasTerminalTransition: boolean;
    reason: string;
    closePending: boolean;
    finalizePending: boolean;
    actualPositionExists: boolean;
    terminalFillConfirmed: boolean;
    lossStateCommitted: boolean;
    positionCycleId: string | null;
    source: "okx_actual" | "terminal_exit_flow" | "ledger_durable" | "none" | "unavailable";
    sourceReady: boolean;
}>;

/**
 * Pure predicate: whether a ledger row has any close-order pending state.
 */
export function rowHasClosePending(row: PaperOpenPositionRecord): boolean {
    if (row.closePendingOrdId && String(row.closePendingOrdId).trim().length > 0) return true;
    if (row.closePendingClOrdId && String(row.closePendingClOrdId).trim().length > 0) return true;
    if (row.lifecycleState === "CLOSE_PENDING") return true;
    if (row.lifecycleState === "CLOSE_ONLY_MANAGED" && row.closePendingAt != null) return true;
    return false;
}

/**
 * Pure predicate: whether a ledger row is currently undergoing a terminal transition.
 */
export function rowHasTerminalTransition(row: PaperOpenPositionRecord): boolean {
    if (row.finalizePending === true) return true;
    if (rowHasClosePending(row)) return true;
    if (row.lifecycleState === "PARTIAL_PENDING" && rowHasClosePending(row)) return true;
    if (row.pendingFinalizeFlowId && String(row.pendingFinalizeFlowId).trim().length > 0) return true;
    return false;
}

/**
 * Authoritative source precedence for position lifecycle truth resolution:
 * 1. Source Availability: If openPositions source is unavailable -> UNAVAILABLE (FAIL_CLOSED)
 * 2. Runtime Flow In-Flight: If terminalExitFlowIds contains position flowId -> FINALIZE_PENDING
 * 3. Durable Ledger State:
 *    - finalizePending && closePending -> FINALIZE_PENDING ("FINALIZE_PENDING_WITH_CLOSE_PENDING")
 *    - finalizePending -> FINALIZE_PENDING ("FINALIZE_PENDING_AWAITING_OKX_FLAT")
 *    - closePending -> CLOSE_FILL_PENDING ("CLOSE_PENDING_AWAITING_FILL")
 *    - pendingFinalizeFlowId -> FINALIZE_PENDING ("TERMINAL_CYCLE_IN_PROGRESS")
 *    - active open -> OPEN ("POSITION_OPEN_ACTIVE")
 * 4. Actual OKX Position presence (when ledger rows empty):
 *    - actualOkxPositionExists -> OPEN ("OKX_ACTUAL_POSITION_EXISTS")
 * 5. Clean / flat state -> TERMINAL ("NO_ACTIVE_POSITION")
 */
export function resolvePositionLifecycleTruth(
    input: PositionLifecycleTruthInput
): PositionLifecycleTruthResult {
    // 1. Source Availability check (Fail-Closed)
    if (input.openPositionsSourceAvailable === false) {
        return {
            lifecycleState: "UNAVAILABLE",
            isTerminal: false,
            hasTerminalTransition: true,
            reason: "TERMINAL_STATE_UNAVAILABLE_FAIL_CLOSED",
            closePending: false,
            finalizePending: false,
            actualPositionExists: input.actualOkxPositionExists === true,
            terminalFillConfirmed: false,
            lossStateCommitted: false,
            positionCycleId: null,
            source: "unavailable",
            sourceReady: false
        };
    }

    const sym = String(input.symbol).toUpperCase();
    const rows = (input.openPositions ?? []).filter(
        (r) => String(r.symbol).toUpperCase() === sym && (r.status ?? "open") === "open"
    );

    const actualPosExists = input.actualOkxPositionExists === true;

    // 2. Empty open rows handling
    if (rows.length === 0) {
        if (actualPosExists) {
            return {
                lifecycleState: "OPEN",
                isTerminal: false,
                hasTerminalTransition: false,
                reason: "OKX_ACTUAL_POSITION_EXISTS",
                closePending: false,
                finalizePending: false,
                actualPositionExists: true,
                terminalFillConfirmed: false,
                lossStateCommitted: false,
                positionCycleId: null,
                source: "okx_actual",
                sourceReady: true
            };
        }
        return {
            lifecycleState: "TERMINAL",
            isTerminal: true,
            hasTerminalTransition: false,
            reason: "NO_ACTIVE_POSITION",
            closePending: false,
            finalizePending: false,
            actualPositionExists: false,
            terminalFillConfirmed: false,
            lossStateCommitted: false,
            positionCycleId: null,
            source: "none",
            sourceReady: true
        };
    }

    // 3. Runtime Flow State check
    for (const row of rows) {
        const flowId = `${row.symbol}:${row.side}:${row.openedAt}`;
        if (input.terminalExitFlowIds?.has(flowId)) {
            const closePending = rowHasClosePending(row);
            const finalizePending = row.finalizePending === true;
            return {
                lifecycleState: "FINALIZE_PENDING",
                isTerminal: false,
                hasTerminalTransition: true,
                reason: "TERMINAL_EXIT_CONSUMED_AWAITING_FINALIZE",
                closePending,
                finalizePending,
                actualPositionExists: actualPosExists,
                terminalFillConfirmed: finalizePending,
                lossStateCommitted: finalizePending,
                positionCycleId: row.positionCycleId ?? row.pendingFinalizePositionCycleId ?? null,
                source: "terminal_exit_flow",
                sourceReady: true
            };
        }
    }

    // 4. Durable Ledger State check
    for (const row of rows) {
        if (!rowHasTerminalTransition(row)) continue;

        const closePending = rowHasClosePending(row);
        const finalizePending = row.finalizePending === true;
        let reason = "TERMINAL_CYCLE_IN_PROGRESS";
        let state: PositionLifecycleState = "FINALIZE_PENDING";

        if (finalizePending && closePending) {
            reason = "FINALIZE_PENDING_WITH_CLOSE_PENDING";
            state = "FINALIZE_PENDING";
        } else if (finalizePending) {
            reason = "FINALIZE_PENDING_AWAITING_OKX_FLAT";
            state = "FINALIZE_PENDING";
        } else if (closePending) {
            reason = "CLOSE_PENDING_AWAITING_FILL";
            state = "CLOSE_FILL_PENDING";
        }

        return {
            lifecycleState: state,
            isTerminal: false,
            hasTerminalTransition: true,
            reason,
            closePending,
            finalizePending,
            actualPositionExists: actualPosExists,
            terminalFillConfirmed: finalizePending || closePending,
            lossStateCommitted: finalizePending,
            positionCycleId: row.positionCycleId ?? row.pendingFinalizePositionCycleId ?? null,
            source: "ledger_durable",
            sourceReady: true
        };
    }

    // 5. Active open position without terminal transition
    const primaryRow = rows[0];
    return {
        lifecycleState: "OPEN",
        isTerminal: false,
        hasTerminalTransition: false,
        reason: "POSITION_OPEN_ACTIVE",
        closePending: false,
        finalizePending: false,
        actualPositionExists: actualPosExists,
        terminalFillConfirmed: false,
        lossStateCommitted: false,
        positionCycleId: primaryRow.positionCycleId ?? null,
        source: "ledger_durable",
        sourceReady: true
    };
}
