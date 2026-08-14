import type { PaperOpenPositionRecord } from "../../models/types";

/** V2 ledger `sizeUsd` is NOTIONAL; legacy paper `sizeUsd` is margin. */
export type PaperPositionSizeUnit = "LEGACY_MARGIN" | "V2_NOTIONAL" | "UNKNOWN";

export function resolveOpenPositionSizeUnit(open: PaperOpenPositionRecord): PaperPositionSizeUnit {
    if (typeof open.notionalUsd === "number" && Number.isFinite(open.notionalUsd) && open.notionalUsd > 0) {
        return "V2_NOTIONAL";
    }
    if (open.isV2Authority === true) return "V2_NOTIONAL";
    const authSrc = String(open.authoritySourceAtEntry ?? open.authority ?? "").trim().toLowerCase();
    if (authSrc === "v2") return "V2_NOTIONAL";

    const strategy = String(open.strategyVersion ?? "").toLowerCase();
    if (strategy.includes("v2")) return "UNKNOWN";

    return "LEGACY_MARGIN";
}

export function isV2NotionalSizeAuthority(open: PaperOpenPositionRecord): boolean {
    return resolveOpenPositionSizeUnit(open) === "V2_NOTIONAL";
}

export type PaperNotionalAuthority = {
    valueUsd: number | null;
    unit: PaperPositionSizeUnit;
    source: "PERSISTED_NOTIONAL" | "V2_SIZE_USD" | "LEGACY_MARGIN_CONVERTED" | "OKX_ACTUAL" | "UNKNOWN_FALLBACK";
    authoritative: boolean;
};

export function resolveOpenNotionalAuthority(open: PaperOpenPositionRecord, okxActualNotionalUsd?: number | null): PaperNotionalAuthority {
    if (typeof open.notionalUsd === "number" && Number.isFinite(open.notionalUsd) && open.notionalUsd > 0) {
        return {
            valueUsd: open.notionalUsd,
            unit: "V2_NOTIONAL",
            source: "PERSISTED_NOTIONAL",
            authoritative: true
        };
    }

    const size = Math.max(0, open.sizeUsd ?? 0);
    const unit = resolveOpenPositionSizeUnit(open);

    if (unit === "V2_NOTIONAL") {
        return {
            valueUsd: size,
            unit: "V2_NOTIONAL",
            source: "V2_SIZE_USD",
            authoritative: true
        };
    }

    if (unit === "LEGACY_MARGIN" && typeof open.leverage === "number" && Number.isFinite(open.leverage) && open.leverage > 0) {
        return {
            valueUsd: size * open.leverage,
            unit: "LEGACY_MARGIN",
            source: "LEGACY_MARGIN_CONVERTED",
            authoritative: true
        };
    }

    if (typeof okxActualNotionalUsd === "number" && Number.isFinite(okxActualNotionalUsd) && okxActualNotionalUsd > 0) {
        return {
            valueUsd: okxActualNotionalUsd,
            unit: "UNKNOWN", // Ledger is still structurally UNKNOWN
            source: "OKX_ACTUAL",
            authoritative: true
        };
    }

    return {
        valueUsd: null,
        unit: "UNKNOWN",
        source: "UNKNOWN_FALLBACK",
        authoritative: false
    };
}

export function resolveOpenNotionalUsd(open: PaperOpenPositionRecord): number {
    if (typeof open.notionalUsd === "number" && Number.isFinite(open.notionalUsd) && open.notionalUsd > 0) {
        return open.notionalUsd;
    }
    const size = Math.max(0, open.sizeUsd ?? 0);
    const unit = resolveOpenPositionSizeUnit(open);
    if (unit === "V2_NOTIONAL" || unit === "UNKNOWN") return size;
    
    if (typeof open.leverage !== "number" || !Number.isFinite(open.leverage) || open.leverage <= 0) {
        return size; // Fallback for invalid leverage: do not guess.
    }
    return size * open.leverage;
}

export function resolveOpenMarginUsd(open: PaperOpenPositionRecord): number {
    const size = Math.max(0, open.sizeUsd ?? 0);
    const unit = resolveOpenPositionSizeUnit(open);
    if (unit === "UNKNOWN") return size;
    
    if (unit === "V2_NOTIONAL") {
        if (typeof open.leverage !== "number" || !Number.isFinite(open.leverage) || open.leverage <= 0) {
            return size; // Fallback
        }
        return size / open.leverage;
    }
    
    // For LEGACY_MARGIN, size is already margin
    return size;
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
