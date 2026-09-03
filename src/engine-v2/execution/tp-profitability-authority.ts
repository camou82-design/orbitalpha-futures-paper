import { normalizePxToTickSz } from "./entry-order-type";

/**
 * TP Profitability Authority
 * Evaluates whether the canonical structural TP1 offers sufficient net edge
 * after accounting for round-trip fees, slippage buffer, and minimum net profit floor.
 * 
 * Invariants:
 * - Read-only consumer: NEVER modifies TP1, TP2, SL, or sizing.
 * - Full Entry: Evaluates executable TP1 distance against dynamic fee/slippage floor (>= 0.30%).
 * - Explicit 0.25x Micro Probe (LONG only, HTF aligned, boxPos <= 0.65):
 *   Evaluates against strict dual floor: TP1 >= 0.20% (0.0020) AND TP2/continuation >= 0.35% (0.0035).
 * - Blocks entry with V2_TP1_NET_EDGE_INSUFFICIENT if distances < required floors.
 * - Blocks entry with V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID if fee/slippage cost authority is missing/invalid.
 */

export const MINIMUM_TP1_NET_PROFIT_PCT = 0.0012; // 0.12% minimum net edge after all friction
export const DEFAULT_PAPER_SLIPPAGE_ESTIMATE_BPS = 8; // 8 bps = 0.08%

export const MICRO_PROBE_MINIMUM_TP1_GROSS_PCT = 0.0020; // 0.20% minimum gross TP1 distance for explicit 0.25x micro probe
export const MICRO_PROBE_MINIMUM_TP2_GROSS_PCT = 0.0035; // 0.35% minimum gross TP2 continuation distance for explicit 0.25x micro probe

export type EvaluateTpProfitabilityAuthorityInput = Readonly<{
    symbol: string;
    side: "long" | "short";
    regime: string;
    entryPrice: number;
    canonicalTp1Price: number | null | undefined;
    canonicalTp1Source?: string | null;
    canonicalTp2Price?: number | null | undefined;
    /** Authoritative paper taker fee rate (e.g. 0.0005, 0.0006). */
    feeRate?: number | null;
    /** Authoritative paper slippage estimate in bps (e.g. 8 bps = 0.0008). */
    paperSlippageEstimateBps?: number | null;
    /** Minimum net profit floor override (default MINIMUM_TP1_NET_PROFIT_PCT = 0.0012). */
    minimumNetProfitPct?: number | null;
    /** Instrument tick size for price normalization (e.g. 0.01 for ETH, 0.1 for BTC). */
    tickSz?: number | null;
    /** Explicit micro-probe override properties */
    isExplicitMicroProbe?: boolean | null;
    probeMultiplier?: number | null;
    boxPos?: number | null;
    htfBiases?: {
        htf_1h_bias?: string | null;
        htf_4h_bias?: string | null;
        htf_1d_bias?: string | null;
        [key: string]: any;
    } | null;
    hasHardBlock?: boolean | null;
    htfVetoPassed?: boolean | null;
    rangeTrendConflictPassed?: boolean | null;
    chaseGatePassed?: boolean | null;
}>;

export type TpProfitabilityAuthorityResult = Readonly<{
    event: "V2_TP_PROFITABILITY_AUTHORITY_PROOF";
    symbol: string;
    side: "long" | "short";
    regime: string;
    entryPrice: number;
    rawCanonicalTp1Price: number | null;
    executableTp1Price: number | null;
    rawCanonicalTp2Price: number | null;
    executableTp2Price: number | null;
    tpTickSize: number | null;
    tpNormalizationApplied: boolean;
    structuralTp1DistancePctRaw: number;
    executableTp1DistancePct: number;
    structuralTp2DistancePctRaw: number;
    executableTp2DistancePct: number;
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
    entry_semantic: "FULL" | "MICRO_PROBE";
    tp_profitability_semantic: "FULL_ENTRY_STANDARD" | "MICRO_PROBE_STRICT_DUAL_FLOOR";
    tp1_gross_distance_pct: number;
    tp2_gross_distance_pct: number;
    required_tp1_edge_pct: number;
    required_tp2_edge_pct: number;
    micro_probe_edge_override_applied: boolean;
    micro_probe_edge_override_reason: string | null;
    full_entry_edge_unchanged: boolean;
    chase_gate_passed: boolean;
    htf_alignment_passed: boolean;
}>;

export function computeMinimumProfitableTpPct(opts?: {
    feeRate?: number | null;
    paperSlippageEstimateBps?: number | null;
    minimumNetProfitPct?: number | null;
}): number {
    const feeRate = (typeof opts?.feeRate === "number" && Number.isFinite(opts.feeRate) && opts.feeRate > 0)
        ? opts.feeRate
        : 0.0005;
    const slippageBps = (typeof opts?.paperSlippageEstimateBps === "number" && Number.isFinite(opts.paperSlippageEstimateBps) && opts.paperSlippageEstimateBps >= 0)
        ? opts.paperSlippageEstimateBps
        : DEFAULT_PAPER_SLIPPAGE_ESTIMATE_BPS;
    const minNetProfit = (typeof opts?.minimumNetProfitPct === "number" && Number.isFinite(opts.minimumNetProfitPct) && opts.minimumNetProfitPct >= 0)
        ? opts.minimumNetProfitPct
        : MINIMUM_TP1_NET_PROFIT_PCT;

    const roundTripFeePct = feeRate * 2;
    const slippageCostPct = slippageBps / 10000;
    return roundTripFeePct + slippageCostPct + minNetProfit;
}

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

    // TP2 Price resolution
    const rawCanonicalTp2Price =
        typeof input.canonicalTp2Price === "number" && Number.isFinite(input.canonicalTp2Price) && input.canonicalTp2Price > 0
            ? input.canonicalTp2Price
            : (rawCanonicalTp1Price != null && entryPrice > 0
                ? (side === "long" ? entryPrice + (rawCanonicalTp1Price - entryPrice) * 1.8 : entryPrice - (entryPrice - rawCanonicalTp1Price) * 1.8)
                : null);
    const executableTp2Price = rawCanonicalTp2Price != null && tickSz != null
        ? normalizePxToTickSz(rawCanonicalTp2Price, tickSz)
        : rawCanonicalTp2Price;

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

    const isExplicitMicroProbe = input.isExplicitMicroProbe === true;

    // Cost Authority Fail-Closed Check (tickSz required for executable TP normalization parity)
    if (
        !isFeeValid ||
        !isSlippageValid ||
        !(entryPrice > 0) ||
        rawCanonicalTp1Price == null ||
        executableTp1Price == null ||
        tickSz == null
    ) {
        return {
            event: "V2_TP_PROFITABILITY_AUTHORITY_PROOF",
            symbol,
            side,
            regime,
            entryPrice,
            rawCanonicalTp1Price,
            executableTp1Price,
            rawCanonicalTp2Price: null,
            executableTp2Price: null,
            tpTickSize: tickSz,
            tpNormalizationApplied: false,
            structuralTp1DistancePctRaw: 0,
            executableTp1DistancePct: 0,
            structuralTp2DistancePctRaw: 0,
            executableTp2DistancePct: 0,
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
            blockReason: "V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID",
            entry_semantic: isExplicitMicroProbe ? "MICRO_PROBE" : "FULL",
            tp_profitability_semantic: "FULL_ENTRY_STANDARD",
            tp1_gross_distance_pct: 0,
            tp2_gross_distance_pct: 0,
            required_tp1_edge_pct: 0,
            required_tp2_edge_pct: 0,
            micro_probe_edge_override_applied: false,
            micro_probe_edge_override_reason: null,
            full_entry_edge_unchanged: true,
            chase_gate_passed: false,
            htf_alignment_passed: false
        };
    }

    const estimatedEntryFeePct = Number(feeRate);
    const estimatedExitFeePct = Number(feeRate);
    const estimatedRoundTripCostPct = estimatedEntryFeePct + estimatedExitFeePct;
    const slippageCostPct = paperSlippageEstimateBps / 10000;

    const minimumProfitableTpPct = computeMinimumProfitableTpPct({
        feeRate,
        paperSlippageEstimateBps,
        minimumNetProfitPct
    });

    // Distances
    const structuralTp1DistancePctRaw = Math.abs(rawCanonicalTp1Price - entryPrice) / entryPrice;
    const executableTp1DistancePct = Math.abs(executableTp1Price - entryPrice) / entryPrice;
    const expectedNetTp1Pct = executableTp1DistancePct - (estimatedRoundTripCostPct + slippageCostPct);

    const structuralTp2DistancePctRaw = rawCanonicalTp2Price != null ? Math.abs(rawCanonicalTp2Price - entryPrice) / entryPrice : 0;
    const executableTp2DistancePct = executableTp2Price != null ? Math.abs(executableTp2Price - entryPrice) / entryPrice : 0;

    // --- Micro-Probe Specific Qualification ---
    const isProbeMultiplier025 = typeof input.probeMultiplier === "number" && Math.abs(input.probeMultiplier - 0.25) < 1e-4;
    const isLongSide = side === "long";
    const isBoxPosValid = typeof input.boxPos === "number" && Number.isFinite(input.boxPos) && input.boxPos <= 0.65;
    const isHtfAligned =
        input.htfBiases?.htf_1h_bias === "BULLISH" &&
        input.htfBiases?.htf_4h_bias === "BULLISH" &&
        input.htfBiases?.htf_1d_bias === "BULLISH";
    const noHardBlock = input.hasHardBlock !== true;
    const htfVetoOk = input.htfVetoPassed !== false;
    const conflictOk = input.rangeTrendConflictPassed !== false;
    const chaseGateOk = input.chaseGatePassed !== false && (input.boxPos == null || isBoxPosValid);

    const hasValidTp1 = rawCanonicalTp1Price != null && executableTp1Price != null && (isLongSide ? executableTp1Price > entryPrice : executableTp1Price < entryPrice);
    const hasValidTp2 = rawCanonicalTp2Price != null && executableTp2Price != null && (isLongSide ? executableTp2Price > entryPrice : executableTp2Price < entryPrice);

    const isMicroProbeEligible =
        isExplicitMicroProbe &&
        isProbeMultiplier025 &&
        isLongSide &&
        isBoxPosValid &&
        isHtfAligned &&
        noHardBlock &&
        htfVetoOk &&
        conflictOk &&
        chaseGateOk &&
        hasValidTp1 &&
        hasValidTp2;

    let entryAllowed = false;
    let blockReason: "V2_TP1_NET_EDGE_INSUFFICIENT" | "V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID" | null = null;
    let entry_semantic: "FULL" | "MICRO_PROBE" = "FULL";
    let tp_profitability_semantic: "FULL_ENTRY_STANDARD" | "MICRO_PROBE_STRICT_DUAL_FLOOR" = "FULL_ENTRY_STANDARD";
    let required_tp1_edge_pct = minimumProfitableTpPct;
    let required_tp2_edge_pct = 0;
    let micro_probe_edge_override_applied = false;
    let micro_probe_edge_override_reason: string | null = null;

    if (isMicroProbeEligible) {
        entry_semantic = "MICRO_PROBE";
        tp_profitability_semantic = "MICRO_PROBE_STRICT_DUAL_FLOOR";
        required_tp1_edge_pct = MICRO_PROBE_MINIMUM_TP1_GROSS_PCT;
        required_tp2_edge_pct = MICRO_PROBE_MINIMUM_TP2_GROSS_PCT;

        const tp1Pass = executableTp1DistancePct >= MICRO_PROBE_MINIMUM_TP1_GROSS_PCT - 1e-9;
        const tp2Pass = executableTp2DistancePct >= MICRO_PROBE_MINIMUM_TP2_GROSS_PCT - 1e-9;

        if (!tp1Pass) {
            entryAllowed = false;
            blockReason = "V2_TP1_NET_EDGE_INSUFFICIENT";
            micro_probe_edge_override_applied = false;
            micro_probe_edge_override_reason = "MICRO_PROBE_TP1_EDGE_INSUFFICIENT";
        } else if (!tp2Pass) {
            entryAllowed = false;
            blockReason = "V2_TP1_NET_EDGE_INSUFFICIENT";
            micro_probe_edge_override_applied = false;
            micro_probe_edge_override_reason = "MICRO_PROBE_TP2_EDGE_INSUFFICIENT";
        } else {
            entryAllowed = true;
            blockReason = null;
            micro_probe_edge_override_applied = true;
            micro_probe_edge_override_reason = "MICRO_PROBE_STRICT_DUAL_EDGE_PASS";
        }
    } else {
        // Standard Full Entry evaluation (or non-qualifying probe fallback)
        entry_semantic = isExplicitMicroProbe ? "MICRO_PROBE" : "FULL";
        tp_profitability_semantic = "FULL_ENTRY_STANDARD";
        required_tp1_edge_pct = minimumProfitableTpPct;
        required_tp2_edge_pct = 0;
        micro_probe_edge_override_applied = false;
        micro_probe_edge_override_reason = null;

        entryAllowed = executableTp1DistancePct >= minimumProfitableTpPct - 1e-9;
        blockReason = entryAllowed ? null : "V2_TP1_NET_EDGE_INSUFFICIENT";
    }

    return {
        event: "V2_TP_PROFITABILITY_AUTHORITY_PROOF",
        symbol,
        side,
        regime,
        entryPrice,
        rawCanonicalTp1Price,
        executableTp1Price,
        rawCanonicalTp2Price,
        executableTp2Price,
        tpTickSize: tickSz,
        tpNormalizationApplied,
        structuralTp1DistancePctRaw,
        executableTp1DistancePct,
        structuralTp2DistancePctRaw,
        executableTp2DistancePct,
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
        blockReason,
        entry_semantic,
        tp_profitability_semantic,
        tp1_gross_distance_pct: executableTp1DistancePct,
        tp2_gross_distance_pct: executableTp2DistancePct,
        required_tp1_edge_pct,
        required_tp2_edge_pct,
        micro_probe_edge_override_applied,
        micro_probe_edge_override_reason,
        full_entry_edge_unchanged: true,
        chase_gate_passed: chaseGateOk,
        htf_alignment_passed: isHtfAligned
    };
}
