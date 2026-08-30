import { normalizePxToTickSz } from "./entry-order-type";

/**
 * TP Profitability Authority
 * Evaluates whether the canonical structural TP1 offers sufficient net edge
 * after accounting for round-trip fees, slippage buffer, and minimum net profit floor.
 * 
 * Invariants:
 * - Read-only consumer: NEVER modifies TP1, TP2, SL, or sizing.
 * - Evaluates executable (tick-normalized) TP1 distance against dynamic fee/slippage floor.
 * - Blocks entry with V2_TP1_NET_EDGE_INSUFFICIENT if executableTp1DistancePct < minimumProfitableTpPct.
 * - Blocks entry with V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID if fee/slippage cost authority is missing/invalid.
 */

export const MINIMUM_TP1_NET_PROFIT_PCT = 0.0012; // 0.12% minimum net edge after all friction
export const DEFAULT_PAPER_SLIPPAGE_ESTIMATE_BPS = 8; // 8 bps = 0.08%

export type EvaluateTpProfitabilityAuthorityInput = Readonly<{
    symbol: string;
    side: "long" | "short";
    regime: string;
    entryPrice: number;
    canonicalTp1Price: number | null | undefined;
    canonicalTp1Source?: string | null;
    /** Authoritative paper taker fee rate (e.g. 0.0005, 0.0006). */
    feeRate?: number | null;
    /** Authoritative paper slippage estimate in bps (e.g. 8 bps = 0.0008). */
    paperSlippageEstimateBps?: number | null;
    /** Minimum net profit floor override (default MINIMUM_TP1_NET_PROFIT_PCT = 0.0012). */
    minimumNetProfitPct?: number | null;
    /** Instrument tick size for price normalization (e.g. 0.01 for ETH, 0.1 for BTC). */
    tickSz?: number | null;
}>;

export type TpProfitabilityAuthorityResult = Readonly<{
    event: "V2_TP_PROFITABILITY_AUTHORITY_PROOF";
    symbol: string;
    side: "long" | "short";
    regime: string;
    entryPrice: number;
    rawCanonicalTp1Price: number | null;
    executableTp1Price: number | null;
    tpTickSize: number | null;
    tpNormalizationApplied: boolean;
    structuralTp1DistancePctRaw: number;
    executableTp1DistancePct: number;
    canonicalTp1Source: string;
    estimatedEntryFeePct: number;
    estimatedExitFeePct: number;
    estimatedRoundTripCostPct: number;
    paperSlippageEstimateBps: number;
    slippageCostPct: number;
    slippageAuthoritySource: "config.paperSlippageEstimateBps" | "resolved_default.paperSlippageEstimateBps";
    minimumNetProfitPct: number;
    minimumNetProfitSource: string;
    minimumProfitableTpPct: number;
    expectedNetTp1Pct: number;
    entryAllowed: boolean;
    blockReason: "V2_TP1_NET_EDGE_INSUFFICIENT" | "V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID" | null;
}>;

export function evaluateTpProfitabilityAuthority(
    input: EvaluateTpProfitabilityAuthorityInput
): TpProfitabilityAuthorityResult {
    const symbol = String(input.symbol);
    const side = input.side;
    const regime = String(input.regime);
    const entryPrice = Number(input.entryPrice);
    const rawCanonicalTp1Price =
        typeof input.canonicalTp1Price === "number" && Number.isFinite(input.canonicalTp1Price) && input.canonicalTp1Price > 0
            ? input.canonicalTp1Price
            : null;
    const canonicalTp1Source = input.canonicalTp1Source ?? (rawCanonicalTp1Price != null ? "takeProfitPlan.tp1" : "none");

    const tickSz = typeof input.tickSz === "number" && Number.isFinite(input.tickSz) && input.tickSz > 0 ? input.tickSz : null;
    const executableTp1Price = rawCanonicalTp1Price != null && tickSz != null
        ? normalizePxToTickSz(rawCanonicalTp1Price, tickSz)
        : rawCanonicalTp1Price;
    const tpNormalizationApplied = rawCanonicalTp1Price != null && executableTp1Price != null && rawCanonicalTp1Price !== executableTp1Price;

    // 1. Fee Authority Validation (Fail-closed on invalid)
    const feeRate = input.feeRate;
    const isFeeValid = typeof feeRate === "number" && Number.isFinite(feeRate) && feeRate > 0;

    // 2. Slippage Authority Validation & Resolution
    let paperSlippageEstimateBps = DEFAULT_PAPER_SLIPPAGE_ESTIMATE_BPS;
    let slippageAuthoritySource: "config.paperSlippageEstimateBps" | "resolved_default.paperSlippageEstimateBps" = "resolved_default.paperSlippageEstimateBps";
    let isSlippageValid = true;

    if (input.paperSlippageEstimateBps !== undefined && input.paperSlippageEstimateBps !== null) {
        if (Number.isFinite(input.paperSlippageEstimateBps) && input.paperSlippageEstimateBps >= 0) {
            paperSlippageEstimateBps = input.paperSlippageEstimateBps;
            slippageAuthoritySource = "config.paperSlippageEstimateBps";
        } else {
            isSlippageValid = false;
        }
    }

    // 3. Minimum Net Profit Floor
    const minimumNetProfitPct =
        typeof input.minimumNetProfitPct === "number" && Number.isFinite(input.minimumNetProfitPct) && input.minimumNetProfitPct >= 0
            ? input.minimumNetProfitPct
            : MINIMUM_TP1_NET_PROFIT_PCT;
    const minimumNetProfitSource =
        input.minimumNetProfitPct != null && Number.isFinite(input.minimumNetProfitPct)
            ? "custom_override"
            : "MINIMUM_TP1_NET_PROFIT_PCT";

    // Cost Authority Fail-Closed Check
    if (!isFeeValid || !isSlippageValid || !(entryPrice > 0) || rawCanonicalTp1Price == null || executableTp1Price == null) {
        return {
            event: "V2_TP_PROFITABILITY_AUTHORITY_PROOF",
            symbol,
            side,
            regime,
            entryPrice,
            rawCanonicalTp1Price,
            executableTp1Price,
            tpTickSize: tickSz,
            tpNormalizationApplied: false,
            structuralTp1DistancePctRaw: 0,
            executableTp1DistancePct: 0,
            canonicalTp1Source,
            estimatedEntryFeePct: isFeeValid ? Number(feeRate) : 0,
            estimatedExitFeePct: isFeeValid ? Number(feeRate) : 0,
            estimatedRoundTripCostPct: isFeeValid ? Number(feeRate) * 2 : 0,
            paperSlippageEstimateBps,
            slippageCostPct: paperSlippageEstimateBps / 10000,
            slippageAuthoritySource,
            minimumNetProfitPct,
            minimumNetProfitSource,
            minimumProfitableTpPct: 0,
            expectedNetTp1Pct: 0,
            entryAllowed: false,
            blockReason: "V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID"
        };
    }

    const estimatedEntryFeePct = Number(feeRate);
    const estimatedExitFeePct = Number(feeRate);
    const estimatedRoundTripCostPct = estimatedEntryFeePct + estimatedExitFeePct;
    const slippageCostPct = paperSlippageEstimateBps / 10000;

    const minimumProfitableTpPct = estimatedRoundTripCostPct + slippageCostPct + minimumNetProfitPct;

    // Distances
    const structuralTp1DistancePctRaw = Math.abs(rawCanonicalTp1Price - entryPrice) / entryPrice;
    const executableTp1DistancePct = Math.abs(executableTp1Price - entryPrice) / entryPrice;
    const expectedNetTp1Pct = executableTp1DistancePct - (estimatedRoundTripCostPct + slippageCostPct);

    // Tolerance 1e-9 for floating point boundary equality
    const entryAllowed = executableTp1DistancePct >= minimumProfitableTpPct - 1e-9;
    const blockReason = entryAllowed ? null : "V2_TP1_NET_EDGE_INSUFFICIENT";

    return {
        event: "V2_TP_PROFITABILITY_AUTHORITY_PROOF",
        symbol,
        side,
        regime,
        entryPrice,
        rawCanonicalTp1Price,
        executableTp1Price,
        tpTickSize: tickSz,
        tpNormalizationApplied,
        structuralTp1DistancePctRaw,
        executableTp1DistancePct,
        canonicalTp1Source,
        estimatedEntryFeePct,
        estimatedExitFeePct,
        estimatedRoundTripCostPct,
        paperSlippageEstimateBps,
        slippageCostPct,
        slippageAuthoritySource,
        minimumNetProfitPct,
        minimumNetProfitSource,
        minimumProfitableTpPct,
        expectedNetTp1Pct,
        entryAllowed,
        blockReason
    };
}
