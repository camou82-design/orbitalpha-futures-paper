import type { PaperOpenPositionRecord } from "../../models/types";

/** V2 ledger `sizeUsd` is NOTIONAL; legacy paper `sizeUsd` is margin. */
export type PaperPositionSizeUnit = "LEGACY_MARGIN" | "V2_NOTIONAL";

export function isV2NotionalSizeAuthority(open: PaperOpenPositionRecord): boolean {
    if (open.isV2Authority === true) return true;
    const authSrc = String(open.authoritySourceAtEntry ?? open.authority ?? "").trim().toLowerCase();
    if (authSrc === "v2") return true;
    return String(open.exchangeClOrdId ?? "").startsWith("p");
}

export function resolveOpenPositionSizeUnit(open: PaperOpenPositionRecord): PaperPositionSizeUnit {
    return isV2NotionalSizeAuthority(open) ? "V2_NOTIONAL" : "LEGACY_MARGIN";
}

export function resolveOpenNotionalUsd(open: PaperOpenPositionRecord): number {
    if (typeof open.notionalUsd === "number" && Number.isFinite(open.notionalUsd) && open.notionalUsd > 0) {
        return open.notionalUsd;
    }
    const size = Math.max(0, open.sizeUsd ?? 0);
    if (isV2NotionalSizeAuthority(open)) return size;
    const lev = Math.max(1, open.leverage ?? 1);
    return size * lev;
}

export function resolveOpenMarginUsd(open: PaperOpenPositionRecord): number {
    const lev = Math.max(1, open.leverage ?? 1);
    return resolveOpenNotionalUsd(open) / lev;
}

export function resolveCloseLegSizing(
    open: PaperOpenPositionRecord,
    legSizeUsd: number,
    sizeUnit?: PaperPositionSizeUnit
): Readonly<{
    sizeUnit: PaperPositionSizeUnit;
    legSizeUsd: number;
    legNotionalUsd: number;
    legMarginUsd: number;
}> {
    const unit = sizeUnit ?? resolveOpenPositionSizeUnit(open);
    const legSize = typeof legSizeUsd === "number" && Number.isFinite(legSizeUsd) && legSizeUsd > 0 ? legSizeUsd : 0;
    const lev = Math.max(1, open.leverage ?? 1);
    const legNotionalUsd = unit === "V2_NOTIONAL" ? legSize : legSize * lev;
    const legMarginUsd = legNotionalUsd / lev;
    return {
        sizeUnit: unit,
        legSizeUsd: legSize,
        legNotionalUsd,
        legMarginUsd
    };
}
