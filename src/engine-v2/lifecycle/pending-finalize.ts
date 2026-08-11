import type { PaperClosedPositionRecord, PaperOpenPositionRecord } from "../../models/types";
import { classifyTradeSource } from "./completed-trade";

export function persistPendingCompletedTradeFinalize(
    open: PaperOpenPositionRecord,
    input: Readonly<{
        flowId: string;
        positionCycleId?: string | null;
        entryAvgPx?: number | null;
        exitAvgPx?: number | null;
        finalCloseReason?: string | null;
        finalFillAt: number;
        tradeSource?: string | null;
        cumulativePnlUsdNet?: number | null;
        cumulativeFeeUsd?: number | null;
        partialReduceCount?: number | null;
        closeReason?: string | null;
        closeSource?: string | null;
        exitReason?: string | null;
    }>
): void {
    open.finalizePending = true;
    open.pendingFinalizeFlowId = input.flowId;
    open.pendingFinalizePositionCycleId = input.positionCycleId ?? undefined;
    open.pendingFinalizeEntryAvgPx = input.entryAvgPx ?? open.avgPx ?? open.entryPrice;
    open.pendingFinalizeExitAvgPx = input.exitAvgPx ?? undefined;
    open.pendingFinalizeFinalCloseReason = input.finalCloseReason ?? undefined;
    open.pendingFinalizeFinalFillAt = input.finalFillAt;
    open.pendingFinalizeTradeSource =
        input.tradeSource ?? classifyTradeSource(open);
    open.pendingFinalizeCumulativePnlUsdNet = input.cumulativePnlUsdNet ?? undefined;
    open.pendingFinalizeCumulativeFeeUsd = input.cumulativeFeeUsd ?? undefined;
    open.pendingFinalizePartialReduceCount = input.partialReduceCount ?? undefined;
    open.pendingFinalizeCloseReason = input.closeReason ?? undefined;
    open.pendingFinalizeCloseSource = input.closeSource ?? undefined;
    open.pendingFinalizeExitReason = input.exitReason ?? undefined;
}

export function clearPendingCompletedTradeFinalize(open: PaperOpenPositionRecord): void {
    open.finalizePending = undefined;
    open.pendingFinalizeFlowId = undefined;
    open.pendingFinalizePositionCycleId = undefined;
    open.pendingFinalizeEntryAvgPx = undefined;
    open.pendingFinalizeExitAvgPx = undefined;
    open.pendingFinalizeFinalCloseReason = undefined;
    open.pendingFinalizeFinalFillAt = undefined;
    open.pendingFinalizeTradeSource = undefined;
    open.pendingFinalizeCumulativePnlUsdNet = undefined;
    open.pendingFinalizeCumulativeFeeUsd = undefined;
    open.pendingFinalizePartialReduceCount = undefined;
    open.pendingFinalizeCloseReason = undefined;
    open.pendingFinalizeCloseSource = undefined;
    open.pendingFinalizeExitReason = undefined;
}

/** Central invariant: pending completed cycle must not be pruned until history is persisted. */
export function isOpenLedgerTerminalCleanupBlocked(open: PaperOpenPositionRecord): boolean {
    return open.finalizePending === true;
}

export function buildTerminalFinalizeHandoffProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_TERMINAL_FINALIZE_HANDOFF_PROOF", ...input };
}

export function buildClosedRowFromPendingFinalize(
    open: PaperOpenPositionRecord,
    nowTs: number
): PaperClosedPositionRecord | null {
    if (open.finalizePending !== true) return null;
    const exitPx = open.pendingFinalizeExitAvgPx;
    if (exitPx == null || !Number.isFinite(exitPx) || exitPx <= 0) return null;

    const entryPx =
        open.pendingFinalizeEntryAvgPx ?? open.avgPx ?? open.entryPrice ?? 0;
    const closedAt = open.pendingFinalizeFinalFillAt ?? nowTs;
    const pnlUsdNet = open.pendingFinalizeCumulativePnlUsdNet ?? 0;
    const feeUsd = open.pendingFinalizeCumulativeFeeUsd ?? 0;

    return {
        symbol: open.symbol,
        side: open.side,
        openedAt: open.openedAt,
        closedAt,
        entryPrice: entryPx,
        closePrice: exitPx,
        leverage: open.leverage ?? 1,
        sizeUsd: open.sizeUsd,
        pnlUsd: pnlUsdNet,
        pnlUsdNet,
        pnlUsdGross: pnlUsdNet + feeUsd,
        feeUsd,
        fundingUsd: 0,
        closeReason: (open.pendingFinalizeCloseReason ??
            "v2_exit_authority") as PaperClosedPositionRecord["closeReason"],
        exitType: "EXIT_UNKNOWN",
        closeSource: (open.pendingFinalizeCloseSource ??
            "BOT_EXECUTION_ATTRIBUTION") as PaperClosedPositionRecord["closeSource"],
        exitReason: open.pendingFinalizeExitReason ?? open.pendingFinalizeFinalCloseReason ?? "V2_EXIT",
        strategyVersion: open.strategyVersion ?? "paper-v2",
        flowId: open.pendingFinalizeFlowId,
        positionCycleId: open.pendingFinalizePositionCycleId,
        tradeSource: open.pendingFinalizeTradeSource as PaperClosedPositionRecord["tradeSource"],
        entryAvgPx: entryPx,
        exitAvgPx: exitPx,
        finalCloseReason: open.pendingFinalizeFinalCloseReason,
        partialReduceCount: open.pendingFinalizePartialReduceCount ?? 0,
        isPositionCycleFinal: true,
        isChildExecution: false
    } as PaperClosedPositionRecord;
}
