import type { PaperClosedPositionRecord } from "../../models/types";
import { createEthRangeEntryQualityStore } from "./eth-range-entry-quality-store";

export type EthRangeEntryQualityOutcomeClass =
    | "TP1"
    | "SL"
    | "TIMEOUT"
    | "BREAKEVEN"
    | "CLOSED_OTHER";

export type EthRangeEntryQualityOutcomeRecord = Readonly<{
    event: "ETH_RANGE_ENTRY_QUALITY_OUTCOME";
    flowId: string;
    opportunityId: string | null;
    symbol: string;
    side: "long" | "short";
    openedAt: number;
    closedAt: number;
    outcomeClass: EthRangeEntryQualityOutcomeClass;
    closeReason: string;
    netPnlBps: number | null;
    mfeBps: number | null;
    maeBps: number | null;
    minutesHeld: number | null;
    reachedBoxMid: boolean | null;
    reachedBoxMidAfter8m: boolean | null;
    reachedBoxMidWithin20m: boolean | null;
    recordedAt: number;
}>;

function classifyOutcome(closeReason: string, exitType?: string | null): EthRangeEntryQualityOutcomeClass {
    const cr = closeReason.toLowerCase();
    const et = String(exitType ?? "").toUpperCase();
    if (cr.includes("take_profit") || et.includes("TP")) return "TP1";
    if (cr.includes("stop_loss") || cr.includes("stop")) return "SL";
    if (cr.includes("time") || cr.includes("timeout")) return "TIMEOUT";
    if (cr.includes("breakeven") || cr.includes("break_even")) return "BREAKEVEN";
    return "CLOSED_OTHER";
}

function netPnlBpsFromRecord(r: PaperClosedPositionRecord): number | null {
    const ep = r.entryAvgPx ?? r.entryPrice;
    const cp = r.exitAvgPx ?? r.closePrice;
    if (!ep || !cp || ep <= 0) return null;
    const gross =
        r.side === "long" ? ((cp - ep) / ep) * 10000 : ((ep - cp) / ep) * 10000;
    const fee = (r.feePctNotional ?? r.feeRate * 2) * 10000;
    return gross - fee;
}

function mfeBps(r: PaperClosedPositionRecord): number | null {
    const v = (r as { mfePct?: number; exitMfePct?: number }).mfePct ?? r.exitMfePct;
    return typeof v === "number" && Number.isFinite(v) ? v * 10000 : null;
}

function maeBps(r: PaperClosedPositionRecord): number | null {
    const v = (r as { maePct?: number; exitMaePct?: number }).maePct ?? r.exitMaePct;
    return typeof v === "number" && Number.isFinite(v) ? v * 10000 : null;
}

export function buildEthRangeEntryQualityOutcomeRecord(
    record: PaperClosedPositionRecord,
    opportunityId?: string | null
): EthRangeEntryQualityOutcomeRecord | null {
    if (String(record.symbol).toUpperCase() !== "ETHUSDT") return null;
    const regime = String(record.regimeAtEntry ?? record.regime ?? "").toUpperCase();
    if (regime !== "RANGE") return null;

    const flowId =
        record.flowId ??
        record.positionCycleId ??
        `${record.symbol}:${record.side}:${record.openedAt}`;

    const minutesHeld =
        typeof record.holdingMs === "number" && Number.isFinite(record.holdingMs)
            ? record.holdingMs / 60_000
            : (record.closedAt - record.openedAt) / 60_000;

    const mfe = mfeBps(record);
    const reachedBoxMid = mfe != null ? mfe > 0 : null;
    const reachedBoxMidAfter8m =
        reachedBoxMid === true && minutesHeld != null ? minutesHeld >= 8 : null;
    const reachedBoxMidWithin20m =
        reachedBoxMid === true && minutesHeld != null ? minutesHeld <= 20 : null;

    return {
        event: "ETH_RANGE_ENTRY_QUALITY_OUTCOME",
        flowId,
        opportunityId: opportunityId ?? null,
        symbol: String(record.symbol),
        side: record.side,
        openedAt: record.openedAt,
        closedAt: record.closedAt,
        outcomeClass: classifyOutcome(String(record.closeReason ?? ""), record.exitType),
        closeReason: String(record.closeReason ?? ""),
        netPnlBps: netPnlBpsFromRecord(record),
        mfeBps: mfe,
        maeBps: maeBps(record),
        minutesHeld,
        reachedBoxMid,
        reachedBoxMidAfter8m,
        reachedBoxMidWithin20m,
        recordedAt: Date.now()
    };
}

export function recordEthRangeEntryQualityOutcome(
    record: PaperClosedPositionRecord,
    dataDir?: string | null
): void {
    try {
        const out = buildEthRangeEntryQualityOutcomeRecord(record);
        if (!out) return;
        createEthRangeEntryQualityStore(dataDir).appendOutcomeLine(JSON.stringify(out));
    } catch {
        /* fail-open */
    }
}
