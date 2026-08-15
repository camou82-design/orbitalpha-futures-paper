import type { PaperOpenPositionRecord } from "../../models/types";

/** V2 ledger `sizeUsd` is NOTIONAL; legacy paper `sizeUsd` is margin. */
export type PaperPositionSizeUnit = "LEGACY_MARGIN" | "V2_NOTIONAL" | "V2_UNIT_UNVERIFIED" | "UNKNOWN";

export function resolveOpenPositionSizeUnit(open: PaperOpenPositionRecord): PaperPositionSizeUnit {
    if (typeof open.notionalUsd === "number" && Number.isFinite(open.notionalUsd) && open.notionalUsd > 0) {
        return "V2_NOTIONAL";
    }
    if (open.isV2Authority === true) return "V2_UNIT_UNVERIFIED";
    const authSrc = String(open.authoritySourceAtEntry ?? open.authority ?? "").trim().toLowerCase();
    if (authSrc === "v2") return "V2_UNIT_UNVERIFIED";

    const strategy = String(open.strategyVersion ?? "").toLowerCase();
    if (strategy.includes("v2")) return "UNKNOWN";

    return "LEGACY_MARGIN";
}

export function isV2NotionalSizeAuthority(open: PaperOpenPositionRecord): boolean {
    return resolveOpenPositionSizeUnit(open) === "V2_NOTIONAL";
}

/**
 * Returns true if the record is definitively a V2/BOT_V2_MANAGED row.
 * Used by writers to decide whether to store sizeUsd as NOTIONAL.
 */
export function isV2AuthorityRow(open: Pick<PaperOpenPositionRecord,
    "isV2Authority" | "lifecycleState" | "authoritySourceAtEntry" | "authority">
): boolean {
    if (open.isV2Authority === true) return true;
    if (open.lifecycleState === "BOT_V2_MANAGED") return true;
    const authSrc = String(open.authoritySourceAtEntry ?? open.authority ?? "").trim().toLowerCase();
    return authSrc === "v2";
}

/**
 * Canonical V2 sizeUsd resolver used at WRITE time.
 *
 * Priority:
 *   a) OKX actual notionalUsd (finite > 0) → authoritative
 *   b) contracts × ctVal × price (if ctVal > 0 and price > 0) → derived
 *   c) marginUsd × leverage (only if both are finite and leverage > 0) → allowed
 *   d) neither authoritative → null (fail-closed, caller must not write)
 *
 * Returns the canonical NOTIONAL value to store as sizeUsd and notionalUsd,
 * or null when not determinable.
 */
export function resolveCanonicalV2SizeUsd(input: Readonly<{
    notionalUsd: number;         // OKX-reported notional (authoritative if > 0)
    marginUsd?: number;          // OKX-reported margin (fallback derivation)
    leverage?: number;           // OKX-reported leverage (used only with marginUsd)
    contracts?: number;          // OKX contracts
    ctVal?: number;              // Instrument ctVal
    price?: number;              // avgPx or markPx
}>): number | null {
    // (a) OKX actual notional — most authoritative
    if (Number.isFinite(input.notionalUsd) && input.notionalUsd > 0) {
        return input.notionalUsd;
    }
    // (b) contracts × ctVal × price — derived notional
    const contracts = input.contracts ?? 0;
    const ctVal = input.ctVal ?? 0;
    const price = input.price ?? 0;
    if (contracts > 0 && ctVal > 0 && price > 0) {
        return contracts * ctVal * price;
    }
    // (c) margin × leverage — only when both authoritative
    const leverage = input.leverage ?? 0;
    const marginUsd = input.marginUsd ?? 0;
    if (marginUsd > 0 && leverage > 0 && Number.isFinite(leverage)) {
        return marginUsd * leverage;
    }
    // (d) fail-closed
    return null;
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
            unit: unit, // Keeps structural unit (e.g. V2_UNIT_UNVERIFIED or UNKNOWN)
            source: "OKX_ACTUAL",
            authoritative: true
        };
    }

    return {
        valueUsd: null,
        unit: unit,
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
    if (unit === "V2_UNIT_UNVERIFIED") return NaN; // Explicit fail-closed for corrupted V2 rows without notionalUsd
    if (unit === "V2_NOTIONAL" || unit === "UNKNOWN") return size;
    
    if (typeof open.leverage !== "number" || !Number.isFinite(open.leverage) || open.leverage <= 0) {
        return size; // Fallback for invalid leverage: do not guess.
    }
    return size * open.leverage;
}

export function resolveOpenMarginUsd(open: PaperOpenPositionRecord): number {
    const size = Math.max(0, open.sizeUsd ?? 0);
    const unit = resolveOpenPositionSizeUnit(open);
    if (unit === "V2_UNIT_UNVERIFIED") return NaN; // Explicit fail-closed
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
    
    let legNotionalUsd = 0;
    let legMarginUsd = 0;
    
    if (unit === "V2_UNIT_UNVERIFIED") {
        legNotionalUsd = NaN;
        legMarginUsd = NaN;
    } else {
        legNotionalUsd = unit === "V2_NOTIONAL" ? legSize : legSize * lev;
        legMarginUsd = legNotionalUsd / lev;
    }

    return {
        sizeUnit: unit,
        legSizeUsd: legSize,
        legNotionalUsd,
        legMarginUsd
    };
}
