import type { MarketRegime } from "../../strategy/market-regime-detector";

/** ETHUSDT RANGE minimum entry→stop distance (0.50%). Wider structural stops are preserved. */
export const ETH_RANGE_MIN_STOP_DISTANCE_PCT = 0.005;

export type EthRangeMinimumStopResult = Readonly<{
    canonicalStopPrice: number;
    floorApplied: boolean;
    minimumDistancePct: number;
}>;

export function normalizeEthSymbol(symbol: string): string {
    return String(symbol ?? "")
        .trim()
        .toUpperCase()
        .replace(/-SWAP$/, "")
        .replace(/-/g, "");
}

export function isEthUsdtRangeStopContext(symbol: string, regime: string | MarketRegime): boolean {
    return normalizeEthSymbol(symbol) === "ETHUSDT" && regime === "RANGE";
}

/**
 * Apply ETHUSDT RANGE minimum stop-distance floor.
 * LONG:  canonicalStop = min(candidate, entry × 0.995) — never tighter than 0.50%
 * SHORT: canonicalStop = max(candidate, entry × 1.005)
 * Non-ETH or non-RANGE: pass-through unchanged.
 */
export function applyEthRangeMinimumStopDistance(input: Readonly<{
    symbol: string;
    regime: string | MarketRegime;
    side: "long" | "short";
    entryReferencePrice: number;
    candidateStopPrice: number;
}>): EthRangeMinimumStopResult {
    const entry = input.entryReferencePrice;
    const candidate = input.candidateStopPrice;

    if (!isEthUsdtRangeStopContext(input.symbol, input.regime)) {
        return { canonicalStopPrice: candidate, floorApplied: false, minimumDistancePct: 0 };
    }

    if (!(entry > 0) || !Number.isFinite(entry) || !(candidate > 0) || !Number.isFinite(candidate)) {
        return {
            canonicalStopPrice: candidate,
            floorApplied: false,
            minimumDistancePct: ETH_RANGE_MIN_STOP_DISTANCE_PCT
        };
    }

    if (input.side === "long") {
        const floorPx = entry * (1 - ETH_RANGE_MIN_STOP_DISTANCE_PCT);
        const canonicalStopPrice = Math.min(candidate, floorPx);
        return {
            canonicalStopPrice,
            floorApplied: canonicalStopPrice < candidate - 1e-9,
            minimumDistancePct: ETH_RANGE_MIN_STOP_DISTANCE_PCT
        };
    }

    const floorPx = entry * (1 + ETH_RANGE_MIN_STOP_DISTANCE_PCT);
    const canonicalStopPrice = Math.max(candidate, floorPx);
    return {
        canonicalStopPrice,
        floorApplied: canonicalStopPrice > candidate + 1e-9,
        minimumDistancePct: ETH_RANGE_MIN_STOP_DISTANCE_PCT
    };
}

/**
 * Resolve protective repair/rebase stop for post-fill paths.
 * EXISTING STOP TRUTH > INITIAL FLOOR FALLBACK.
 * Valid ledger/canonical stop (incl. tightened, breakeven, profit-lock) is returned unchanged.
 * Floor applies only when no stop truth exists (mirror/policy fallback).
 */
export function resolveEthRangeAwareProtectiveStopPrice(input: Readonly<{
    symbol: string;
    regime: string | MarketRegime;
    side: "long" | "short";
    entryReferencePrice: number;
    ledgerStopPrice?: number | null;
    mirrorStopPrice?: number | null;
}>): number | null {
    const ledger =
        typeof input.ledgerStopPrice === "number" && Number.isFinite(input.ledgerStopPrice) && input.ledgerStopPrice > 0
            ? input.ledgerStopPrice
            : null;

    if (ledger != null) {
        return ledger;
    }

    const mirror =
        typeof input.mirrorStopPrice === "number" && Number.isFinite(input.mirrorStopPrice) && input.mirrorStopPrice > 0
            ? input.mirrorStopPrice
            : null;
    if (mirror == null) return null;

    return applyEthRangeMinimumStopDistance({
        symbol: input.symbol,
        regime: input.regime,
        side: input.side,
        entryReferencePrice: input.entryReferencePrice,
        candidateStopPrice: mirror
    }).canonicalStopPrice;
}
