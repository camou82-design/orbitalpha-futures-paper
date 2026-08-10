import { normalizePxToTickSz } from "./entry-order-type";

export function normalizeStopPxForMatch(px: number, tickSz: number): number {
    if (!(Number.isFinite(px) && px > 0)) return px;
    if (!(Number.isFinite(tickSz) && tickSz > 0)) return px;
    return normalizePxToTickSz(px, tickSz);
}

export function protectiveStopPricesMatch(
    requiredStop: number,
    exchangeStop: number,
    tickSz: number
): boolean {
    if (!(Number.isFinite(requiredStop) && requiredStop > 0)) return false;
    if (!(Number.isFinite(exchangeStop) && exchangeStop > 0)) return false;
    const req = normalizeStopPxForMatch(requiredStop, tickSz);
    const ex = normalizeStopPxForMatch(exchangeStop, tickSz);
    return Math.abs(req - ex) <= Math.max(tickSz, 1e-8);
}

export function protectiveContractSizesMatch(
    contractsRequired: number,
    contractsProtected: number
): boolean {
    return Math.abs(contractsRequired - contractsProtected) <= 1e-8;
}

export function buildProtectiveOrderMatchProof(input: Readonly<{
    symbol: string;
    side: string;
    requiredStopRaw: number | null;
    exchangeStopRaw: number | null;
    tickSz: number;
    contractsRequired: number;
    contractsProtected: number;
    algoId?: string | null;
    purpose?: string | null;
}>): Record<string, unknown> {
    const requiredNorm =
        input.requiredStopRaw != null && input.tickSz > 0
            ? normalizeStopPxForMatch(input.requiredStopRaw, input.tickSz)
            : null;
    const exchangeNorm =
        input.exchangeStopRaw != null && input.tickSz > 0
            ? normalizeStopPxForMatch(input.exchangeStopRaw, input.tickSz)
            : null;
    const priceMatch =
        input.requiredStopRaw != null &&
        input.exchangeStopRaw != null &&
        input.tickSz > 0
            ? protectiveStopPricesMatch(input.requiredStopRaw, input.exchangeStopRaw, input.tickSz)
            : false;
    const sizeMatch = protectiveContractSizesMatch(input.contractsRequired, input.contractsProtected);
    return {
        event: "V2_PROTECTIVE_ORDER_MATCH_PROOF",
        symbol: input.symbol,
        side: input.side,
        required_stop_raw: input.requiredStopRaw,
        required_stop_normalized: requiredNorm,
        exchange_stop_raw: input.exchangeStopRaw,
        exchange_stop_normalized: exchangeNorm,
        tickSz: input.tickSz,
        price_match: priceMatch,
        contracts_required: input.contractsRequired,
        contracts_protected: input.contractsProtected,
        size_match: sizeMatch,
        algo_id: input.algoId ?? null,
        purpose: input.purpose ?? null
    };
}
