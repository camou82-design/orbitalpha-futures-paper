import type { PaperOpenPositionRecord } from "../../models/types";
import {
    resolvePositionLifecycleTruth,
    rowHasClosePending,
    rowHasTerminalTransition,
    type PositionLifecycleState,
    type PositionLifecycleTruthInput,
    type PositionLifecycleTruthResult
} from "./position-lifecycle-truth";

export {
    resolvePositionLifecycleTruth,
    rowHasClosePending,
    rowHasTerminalTransition,
    type PositionLifecycleState,
    type PositionLifecycleTruthInput,
    type PositionLifecycleTruthResult
};

export type TerminalReentryBarrierResult = Readonly<{
    blocked: boolean;
    reason: string;
    closePending: boolean;
    finalizePending: boolean;
    actualPositionExists: boolean;
    terminalFillConfirmed: boolean;
    lossStateCommitted: boolean;
    positionCycleId: string | null;
    lifecycleState?: PositionLifecycleState;
    lifecycleSource?: string;
}>;

/**
 * Entry policy barrier consuming canonical lifecycle truth.
 * Blocks new entry on a symbol while any prior position cycle is still in terminal close / finalize transition.
 */
export function evaluateTerminalReentryBarrier(input: Readonly<{
    symbol: string;
    requestedSide?: "long" | "short";
    openPositions: readonly PaperOpenPositionRecord[];
    openPositionsSourceAvailable?: boolean;
    actualOkxPositionExists?: boolean;
    terminalExitFlowIds?: ReadonlySet<string>;
}>): TerminalReentryBarrierResult {
    const truth = resolvePositionLifecycleTruth({
        symbol: input.symbol,
        requestedSide: input.requestedSide,
        openPositions: input.openPositions,
        openPositionsSourceAvailable: input.openPositionsSourceAvailable,
        actualOkxPositionExists: input.actualOkxPositionExists,
        terminalExitFlowIds: input.terminalExitFlowIds
    });

    const blocked = truth.hasTerminalTransition;
    const reason = truth.hasTerminalTransition ? truth.reason : "NO_TERMINAL_TRANSITION";

    return {
        blocked,
        reason,
        closePending: truth.closePending,
        finalizePending: truth.finalizePending,
        actualPositionExists: truth.actualPositionExists,
        terminalFillConfirmed: truth.terminalFillConfirmed,
        lossStateCommitted: truth.lossStateCommitted,
        positionCycleId: truth.positionCycleId,
        lifecycleState: truth.lifecycleState,
        lifecycleSource: truth.source
    };
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
