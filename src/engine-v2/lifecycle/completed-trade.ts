import type { PaperClosedPositionRecord, PaperOpenPositionRecord } from "../../models/types";
import { isProtectivePartialReason } from "../execution/reduce-economics";
import {
    hasIndependentManualLifecycleEvidence,
    isIndependentExternalManualLifecycle,
    isStrongManualLatchSource
} from "../position/manual-ownership-latch";

export type CompletedTradeSource = "BOT_V2" | "MANUAL_EXTERNAL" | "ADOPTED_EXTERNAL";

export type FinalCloseReason =
    | "STOP_LOSS"
    | "TAKE_PROFIT"
    | "TRAILING_STOP"
    | "SHOCK_PROTECTIVE_REDUCE_FINAL"
    | "V2_EXIT"
    | "REVERSAL_EXIT"
    | "MANUAL_CLOSE"
    | "EXTERNAL_MANUAL_CLOSE"
    | "EXCHANGE_STOP_TRIGGER"
    | "EXCHANGE_TP_TRIGGER"
    | "LIQUIDATION"
    | "UNKNOWN_EXECUTION_CLOSE";

export type PositionCycleExitFill = Readonly<{
    px: number;
    contracts: number;
    pnlUsdNet: number;
    feeUsd: number;
    at: number;
    reason?: string;
}>;

const PARTIAL_EVENT_CLOSE_REASONS = new Set([
    "partial_exit_1",
    "partial_exit_2",
    "take_profit_1",
    "EXIT_LONG_CRASH_REDUCE",
    "EXIT_CRASH_REDUCE",
    "v2_partial_authority"
]);

const PARTIAL_EVENT_EXIT_TYPES = new Set([
    "EXIT_PARTIAL_SPLIT_1",
    "EXIT_PARTIAL_SPLIT_2",
    "EXIT_LONG_CRASH_REDUCE",
    "EXIT_CRASH_REDUCE",
    "EXIT_TP_1"
]);

export function buildPositionCycleId(symbol: string, side: string, openedAt: number): string {
    return `${symbol}:${side}:${openedAt}`;
}

export function buildPositionFlowId(symbol: string, side: string, openedAt: number): string {
    return buildPositionCycleId(symbol, side, openedAt);
}

export function hasExplicitIndependentManualEvidence(
    open: PaperOpenPositionRecord | null | undefined
): boolean {
    if (open == null) return false;
    if (isIndependentExternalManualLifecycle(open)) return true;
    if (open.manualLifecycleEvidenceIndependent === true) return true;
    if (open.manualLifecycleEvidenceIndependent === false) return false;
    if (open.manualOwnershipLatch !== true) return false;
    return (
        isStrongManualLatchSource(
            open.manualOwnershipLatchSource ?? open.manualOwnershipLatchReason
        ) && hasIndependentManualLifecycleEvidence(open)
    );
}

function hasBotTradeAttribution(open: PaperOpenPositionRecord): boolean {
    if (open.isV2Authority === true) return true;
    const authSrc = String(open.authoritySourceAtEntry ?? open.authority ?? "").trim().toLowerCase();
    if (authSrc === "v2") return true;
    return String(open.exchangeClOrdId ?? "").startsWith("p");
}

export function classifyTradeSource(open: PaperOpenPositionRecord): CompletedTradeSource {
    if (hasExplicitIndependentManualEvidence(open)) {
        return "MANUAL_EXTERNAL";
    }
    if (
        open.reconcileState === "ADOPTED" ||
        open.sourceSignal === "okx_reconcile_adopted" ||
        open.sourceSignal === "OPERATOR_ADOPTED" ||
        open.lifecycleState === "OKX_UNTRACKED_FILL"
    ) {
        return "ADOPTED_EXTERNAL";
    }
    if (hasBotTradeAttribution(open)) return "BOT_V2";
    return "MANUAL_EXTERNAL";
}

export function isChildExecutionClose(
    closeReason: string | undefined,
    exitType: string | undefined,
    closeSource?: string
): boolean {
    if (typeof closeReason === "string" && PARTIAL_EVENT_CLOSE_REASONS.has(closeReason)) return true;
    if (typeof exitType === "string" && PARTIAL_EVENT_EXIT_TYPES.has(exitType)) return true;
    if (closeSource === "PARTIAL_SPLIT") return true;
    return false;
}

export function isPositionCycleFinalRow(r: unknown): boolean {
    if (!r || typeof r !== "object") return false;
    const o = r as Record<string, unknown>;
    if (o.isChildExecution === true) return false;
    if (o.isPositionCycleFinal === true) return true;
    if (o.isPositionCycleFinal === false) return false;
    if (typeof o.closeReason === "string" && PARTIAL_EVENT_CLOSE_REASONS.has(o.closeReason)) return false;
    if (typeof o.exitType === "string" && PARTIAL_EVENT_EXIT_TYPES.has(o.exitType)) return false;
    if (o.closeSource === "PARTIAL_SPLIT") return false;
    return true;
}

export function isAccountStatsRow(r: unknown): boolean {
    return isPositionCycleFinalRow(r);
}

export function isStrategyStatsRow(r: unknown): boolean {
    if (!isPositionCycleFinalRow(r)) return false;
    const o = r as Record<string, unknown>;
    const src = o.tradeSource;
    if (src === "BOT_V2") return true;
    if (src === "MANUAL_EXTERNAL" || src === "ADOPTED_EXTERNAL") return false;
    return o.isV2Authority === true || String(o.authority ?? "").toLowerCase() === "v2";
}

export function normalizeFinalCloseReason(input: Readonly<{
    closeReason?: string;
    exitType?: string;
    tradeSource?: CompletedTradeSource;
    isExchangeAlgo?: boolean;
    isStop?: boolean;
    isTakeProfit?: boolean;
}>): FinalCloseReason {
    const cr = String(input.closeReason ?? "").toLowerCase();
    const et = String(input.exitType ?? "").toUpperCase();
    if (input.isStop || cr.includes("stop_loss") || et === "EXIT_SL") {
        return input.isExchangeAlgo ? "EXCHANGE_STOP_TRIGGER" : "STOP_LOSS";
    }
    if (input.isTakeProfit || cr.includes("take_profit") || et === "EXIT_TP" || et === "EXIT_TP_2") {
        return input.isExchangeAlgo ? "EXCHANGE_TP_TRIGGER" : "TAKE_PROFIT";
    }
    if (cr.includes("trailing") || et === "EXIT_TRAILING") return "TRAILING_STOP";
    if (cr.includes("v2_exit") || cr.includes("v2_exit_authority") || et === "EXIT_V2_AUTHORITY") return "V2_EXIT";
    if (input.tradeSource === "MANUAL_EXTERNAL") {
        return "EXTERNAL_MANUAL_CLOSE";
    }
    if (cr === "manual_full_close_reconciled") {
        return "UNKNOWN_EXECUTION_CLOSE";
    }
    if (cr.includes("liquidation")) return "LIQUIDATION";
    if (cr.includes("regime") || cr.includes("reversal")) return "REVERSAL_EXIT";
    if (cr.includes("shock") && cr.includes("final")) return "SHOCK_PROTECTIVE_REDUCE_FINAL";
    if (cr.trim().length > 0 && cr !== "unknown" && cr !== "none") return "V2_EXIT";
    return "UNKNOWN_EXECUTION_CLOSE";
}

export function resolveWeightedExitAvgPx(
    fills: ReadonlyArray<PositionCycleExitFill>,
    finalFill?: PositionCycleExitFill | null
): number | null {
    const all = finalFill != null ? [...fills, finalFill] : [...fills];
    let sumPxQty = 0;
    let sumQty = 0;
    for (const f of all) {
        if (!(f.contracts > 0) || !(f.px > 0)) continue;
        sumPxQty += f.px * f.contracts;
        sumQty += f.contracts;
    }
    return sumQty > 0 ? sumPxQty / sumQty : null;
}

export function recordPositionCycleExitFill(
    open: PaperOpenPositionRecord,
    fill: PositionCycleExitFill
): void {
    const fills = Array.isArray(open.positionCycleExitFills)
        ? [...open.positionCycleExitFills]
        : [];
    fills.push(fill);
    open.positionCycleExitFills = fills;
    open.positionCycleCumulativePnlUsdNet =
        (open.positionCycleCumulativePnlUsdNet ?? 0) + fill.pnlUsdNet;
    open.positionCycleCumulativeFeeUsd =
        (open.positionCycleCumulativeFeeUsd ?? 0) + fill.feeUsd;
    if (isProtectivePartialReason(fill.reason)) {
        open.positionCyclePartialReduceCount =
            (open.positionCyclePartialReduceCount ?? 0) + 1;
    }
}

export function aggregatePositionCycleClose(input: Readonly<{
    open: PaperOpenPositionRecord;
    finalFillPx: number;
    finalFillContracts: number;
    finalLegPnlUsdNet: number;
    finalLegFeeUsd: number;
    finalCloseReason: FinalCloseReason;
    closedAt: number;
}>): Partial<PaperClosedPositionRecord> {
    const { open, finalFillPx, finalFillContracts, finalLegPnlUsdNet, finalLegFeeUsd, finalCloseReason, closedAt } =
        input;
    const priorFills = open.positionCycleExitFills ?? [];
    const finalFill: PositionCycleExitFill = {
        px: finalFillPx,
        contracts: finalFillContracts,
        pnlUsdNet: finalLegPnlUsdNet,
        feeUsd: finalLegFeeUsd,
        at: closedAt,
        reason: finalCloseReason
    };
    const exitAvgPx = resolveWeightedExitAvgPx(priorFills, finalFill);
    const aggregateNet =
        (open.positionCycleCumulativePnlUsdNet ?? 0) + finalLegPnlUsdNet;
    const aggregateFee =
        (open.positionCycleCumulativeFeeUsd ?? 0) + finalLegFeeUsd;
    const aggregateGross = aggregateNet + aggregateFee;
    const entryAvgPx = open.avgPx ?? open.entryPrice;
    const holdingMs = closedAt - open.openedAt;
    return {
        entryAvgPx,
        exitAvgPx: exitAvgPx ?? (finalFillPx > 0 ? finalFillPx : undefined),
        closePrice: exitAvgPx ?? finalFillPx,
        pnlUsdNet: aggregateNet,
        pnlUsdGross: aggregateGross,
        feeUsd: aggregateFee,
        realizedPnlUsd: aggregateNet,
        partialReduceCount:
            open.protectivePartialReduceCount ??
            open.positionCyclePartialReduceCount ??
            0,
        addonCount: open.positionCycleAddonCount ?? open.addonCount,
        adverseAddonCount: open.positionCycleAdverseAddonCount ?? open.adverseAddonCount,
        pyramidingCount: open.positionCyclePyramidingCount,
        maxPositionContracts: open.positionCycleMaxContracts ?? open.okxContracts,
        finalCloseReason,
        holdingMs: holdingMs > 0 ? holdingMs : undefined,
        isPositionCycleFinal: true,
        isChildExecution: false
    };
}

export function enrichCompletedTradeRecord(input: Readonly<{
    open: PaperOpenPositionRecord;
    closedRow: PaperClosedPositionRecord;
    isFinalClose: boolean;
    actualFillPx?: number | null;
    actualFillContracts?: number | null;
    isExchangeAlgo?: boolean;
    isStop?: boolean;
    isTakeProfit?: boolean;
}>): PaperClosedPositionRecord {
    const tradeSource = classifyTradeSource(input.open);
    const positionCycleId = buildPositionCycleId(
        input.open.symbol,
        input.open.side,
        input.open.openedAt
    );
    const flowId = buildPositionFlowId(input.open.symbol, input.open.side, input.open.openedAt);
    const isChild = isChildExecutionClose(
        String(input.closedRow.closeReason),
        input.closedRow.exitType,
        input.closedRow.closeSource
    );
    const isFinal = input.isFinalClose && !isChild;
    const finalCloseReason = normalizeFinalCloseReason({
        closeReason: String(input.closedRow.closeReason),
        exitType: input.closedRow.exitType,
        tradeSource,
        isExchangeAlgo: input.isExchangeAlgo,
        isStop: input.isStop,
        isTakeProfit: input.isTakeProfit
    });

    if (isChild) {
        return {
            ...input.closedRow,
            flowId,
            positionCycleId,
            tradeSource,
            isChildExecution: true,
            isPositionCycleFinal: false,
            entryAvgPx: input.open.avgPx ?? input.open.entryPrice,
            exitAvgPx: input.closedRow.closePrice > 0 ? input.closedRow.closePrice : undefined
        };
    }

    const finalPx =
        input.actualFillPx != null && input.actualFillPx > 0
            ? input.actualFillPx
            : input.closedRow.closePrice;
    const finalContracts =
        input.actualFillContracts != null && input.actualFillContracts > 0
            ? input.actualFillContracts
            : input.open.okxContracts ?? 0;
    const aggregated = isFinal
        ? aggregatePositionCycleClose({
              open: input.open,
              finalFillPx: finalPx,
              finalFillContracts: finalContracts,
              finalLegPnlUsdNet: input.closedRow.pnlUsdNet,
              finalLegFeeUsd: input.closedRow.feeUsd,
              finalCloseReason,
              closedAt: input.closedRow.closedAt
          })
        : {};

    const closeReasonLabel =
        finalCloseReason === "UNKNOWN_EXECUTION_CLOSE"
            ? input.closedRow.closeReasonLabel
            : input.closedRow.closeReasonLabel;

    return {
        ...input.closedRow,
        ...aggregated,
        flowId,
        positionCycleId,
        tradeSource,
        isChildExecution: false,
        isPositionCycleFinal: isFinal,
        finalCloseReason,
        closeReasonLabel: closeReasonLabel || input.closedRow.closeReasonLabel,
        exitReason: closeReasonLabel || input.closedRow.exitReason
    };
}

export function isPositionCycleFinalizeDuplicate(
    record: Pick<
        PaperClosedPositionRecord,
        "symbol" | "side" | "openedAt" | "positionCycleId" | "isPositionCycleFinal" | "isChildExecution"
    >,
    history: unknown[]
): boolean {
    if (record.isChildExecution === true || record.isPositionCycleFinal !== true) return false;
    const cycleId =
        record.positionCycleId ??
        buildPositionCycleId(record.symbol, record.side, record.openedAt);
    return history.some((h) => {
        if (!h || typeof h !== "object") return false;
        const o = h as Record<string, unknown>;
        if (o.isChildExecution === true) return false;
        const existingCycle =
            typeof o.positionCycleId === "string"
                ? o.positionCycleId
                : buildPositionCycleId(String(o.symbol), String(o.side), Number(o.openedAt));
        if (existingCycle !== cycleId) return false;
        if (o.isPositionCycleFinal === true) return true;
        return isPositionCycleFinalRow(h);
    });
}

export function buildCompletedTradeAggregationProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_COMPLETED_TRADE_AGGREGATION_PROOF", ...input };
}

export function buildCompletedTradeFinalizeProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_COMPLETED_TRADE_FINALIZE_PROOF", ...input };
}

export function buildTradeSourceClassificationProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "TRADE_SOURCE_CLASSIFICATION_PROOF", ...input };
}

const TRUSTED_TERMINAL_ATTRIBUTION_SOURCES = new Set([
    "explicit_manual_evidence",
    "last_bot_execution",
    "position_cycle_exit_fill",
    "bot_close_pending",
    "bot_v2_reconcile_flat_fallback"
]);

type TerminalAttributionLike = Readonly<{
    finalCloseReason: FinalCloseReason;
    attributionSource: string;
    manualEvidencePresent: boolean;
}>;

export function shouldPreferTerminalAttributionFinalCloseReason(input: Readonly<{
    enriched: Pick<PaperClosedPositionRecord, "tradeSource" | "finalCloseReason">;
    attribution: TerminalAttributionLike;
}>): boolean {
    const { enriched, attribution } = input;
    if (enriched.finalCloseReason === attribution.finalCloseReason) return false;
    if (
        attribution.finalCloseReason === "EXTERNAL_MANUAL_CLOSE" &&
        enriched.tradeSource === "BOT_V2"
    ) {
        return false;
    }
    if (
        attribution.manualEvidencePresent &&
        enriched.tradeSource !== "MANUAL_EXTERNAL"
    ) {
        return false;
    }
    return TRUSTED_TERMINAL_ATTRIBUTION_SOURCES.has(attribution.attributionSource);
}

export function mergeTerminalCloseAttributionWithEnrichedRecord(input: Readonly<{
    enrichedBase: PaperClosedPositionRecord;
    attribution: TerminalAttributionLike;
}>): PaperClosedPositionRecord {
    if (
        !shouldPreferTerminalAttributionFinalCloseReason({
            enriched: input.enrichedBase,
            attribution: input.attribution
        })
    ) {
        return input.enrichedBase;
    }
    return {
        ...input.enrichedBase,
        finalCloseReason: input.attribution.finalCloseReason
    };
}
