import { evaluatePositionProtectionState } from "./protective-order-state";
import type { PaperOpenPositionRecord } from "../../models/types";

export function evaluateReduceProtectiveReensure(input: Readonly<{
    open: PaperOpenPositionRecord;
    actualContracts: number;
    instId: string;
    pending: readonly Record<string, unknown>[];
    algos: readonly Record<string, unknown>[];
    tickSz?: number;
}>): Readonly<{
    reensureNeeded: boolean;
    validProtectivePresent: boolean;
    actualContracts: number;
    ledgerContracts: number | null;
    usesActualContractAuthority: true;
}> {
    const actualContracts = input.actualContracts;
    const ledgerContracts =
        input.open.okxContracts != null && Number.isFinite(input.open.okxContracts)
            ? input.open.okxContracts
            : null;
    const tpRequired =
        input.open.targetPrice1 != null &&
        Number.isFinite(input.open.targetPrice1) &&
        input.open.targetPrice1 > 0;

    const protectionState = evaluatePositionProtectionState({
        instId: input.instId,
        positionSide: input.open.side,
        pending: input.pending,
        algos: input.algos,
        tpRequired,
        ledger: input.open,
        tickSz: input.tickSz,
        requiredStopPx: input.open.stopPrice ?? null,
        requiredContracts: actualContracts
    });

    return {
        reensureNeeded: !protectionState.reduceOnlyProtectiveFound,
        validProtectivePresent: protectionState.reduceOnlyProtectiveFound,
        actualContracts,
        ledgerContracts,
        usesActualContractAuthority: true
    };
}

export function buildV2ReduceProtectiveReensureProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "V2_REDUCE_PROTECTIVE_REENSURE_PROOF", ...input };
}
