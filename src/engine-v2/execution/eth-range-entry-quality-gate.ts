/**
 * ETHUSDT Dedicated RANGE Entry Quality Gate
 *
 * Strict invariants:
 * 1. Applicable ONLY to ETHUSDT initial RANGE entries (BTCUSDT is 100% bypassed with zero behavior change).
 * 2. Bypass on ADOPTED_EXTERNAL, OPERATOR_MANAGED, manual takeover, ADDON, existing position management.
 * 3. TREND and FAST_TREND_SHIFT authorities (including confirmed FTS 010055d) remain completely untouched.
 * 4. Categorizes ETH RANGE entries into 3 levels:
 *    - FULL (ETH_RANGE_FULL): boxPos <= 0.20 (L) / >= 0.80 (S), reversalConfirmed=true, trendSide none or aligned. Sizing: 1.0x.
 *    - PROBE:
 *      a) ETH_RANGE_LOCATION_PROBE: 0.20 < boxPos <= 0.35 (L) / 0.65 <= boxPos < 0.80 (S), reversalConfirmed=true, trendSide none or aligned. Sizing: 0.50x.
 *      b) ETH_RANGE_UNCONFIRMED_PROBE: boxPos <= 0.20 (L) / >= 0.80 (S), reversalConfirmed=false, trendSide none or aligned. Sizing: 0.50x.
 *      c) ETH_RANGE_COUNTERTREND_EXTREME_PROBE: opposing trend direction + extreme boxPos (<= 0.08 L / >= 0.92 S) + reversalConfirmed=true. Sizing: 0.50x.
 *    - BLOCK (ETH_RANGE_BLOCK): all other unfulfilled conditions (e.g. opposing trend without extreme+reversal, unconfirmed ambiguous location, etc.).
 * 5. Emits ETH_RANGE_ENTRY_QUALITY_PROOF.
 */

export type EthRangeQualityClassification =
    | "ETH_RANGE_FULL"
    | "ETH_RANGE_LOCATION_PROBE"
    | "ETH_RANGE_UNCONFIRMED_PROBE"
    | "ETH_RANGE_COUNTERTREND_EXTREME_PROBE"
    | "ETH_RANGE_BLOCK";

export interface EthRangeEntryQualityInput {
    symbol: string;
    side: "long" | "short";
    regime: string;
    subtype?: string | null;
    routingEngine?: string | null;
    isInitialEntry: boolean;
    isAddon?: boolean;
    boxPos: number | null;
    zone?: "lower" | "mid" | "upper" | string | null;
    rangeSideCandidate?: "long" | "short" | "none" | string | null;
    trendSideCandidate?: "long" | "short" | "none" | string | null;
    selectedSideAfterVeto?: "long" | "short" | "none" | string | null;
    reversalConfirmed: boolean;
    sideZoneValid?: boolean;
    rangeEdgeExtreme?: boolean;
    qualityScore?: number;
    entryQualityGrade?: string | null;
    htfEntryPolicy?: string | null;
    directionalShockState?: string | null;
    isOperatorManaged?: boolean;
    isManualTakeover?: boolean;
    isAdoptedExternal?: boolean;
    promotionReason?: string | null;
    emitProof?: boolean;
    /** Pre-probe notional (= cappedFullEntryNotionalUsdt from equity-adaptive-sizing). */
    baseOrderNotionalBeforeEthProbe?: number | null;
    /** Effective baseline notional (= what FULL would submit; after all equity/cap constraints, before probe multiplier). */
    liveBaselineOrderNotional?: number | null;
    /** Final notional actually submitted after probe multiplier + lot normalization. */
    submittedOrderNotional?: number | null;
    /** live_max_order_notional_usdt config value for audit clarity. */
    liveMaxOrderNotionalUsdt?: number | null;
    /** @deprecated Use baseOrderNotionalBeforeEthProbe / submittedOrderNotional instead. */
    baseOrderNotional?: number | null;
    /** @deprecated Use submittedOrderNotional instead. */
    finalOrderNotional?: number | null;
    now?: number | null;
}

export interface EthRangeEntryQualityResult {
    evaluated: boolean;
    allowed: boolean;
    classification: EthRangeQualityClassification;
    probeMultiplier: number; // 1.0 for FULL, 0.50 for PROBE, 0.0 for BLOCK
    blockReason: string | null;
    isProbe: boolean;
    isDirectionConflict: boolean;
    ethLocationPass: boolean;
    ethReversalPass: boolean;
}

export function normalizeEthSymbol(symbol: string): string {
    return String(symbol ?? "").toUpperCase().replace("-SWAP", "").replace("-", "");
}

export function evaluateEthRangeEntryQualityGate(
    input: EthRangeEntryQualityInput
): EthRangeEntryQualityResult {
    const symbolNorm = normalizeEthSymbol(input.symbol);
    const isEth = symbolNorm === "ETHUSDT";

    // 1. Symbol and Scope Bypass: Only ETHUSDT initial RANGE entries are evaluated.
    if (!isEth) {
        return {
            evaluated: false,
            allowed: true,
            classification: "ETH_RANGE_FULL",
            probeMultiplier: 1.0,
            blockReason: null,
            isProbe: false,
            isDirectionConflict: false,
            ethLocationPass: true,
            ethReversalPass: true
        };
    }

    if (
        !input.isInitialEntry ||
        input.isAddon === true ||
        input.isOperatorManaged === true ||
        input.isManualTakeover === true ||
        input.isAdoptedExternal === true
    ) {
        return {
            evaluated: false,
            allowed: true,
            classification: "ETH_RANGE_FULL",
            probeMultiplier: 1.0,
            blockReason: null,
            isProbe: false,
            isDirectionConflict: false,
            ethLocationPass: true,
            ethReversalPass: true
        };
    }

    const regimeStr = String(input.regime ?? "").toUpperCase();
    const routingStr = String(input.routingEngine ?? "").toUpperCase();
    const subtypeStr = String(input.subtype ?? "").toUpperCase();
    const isRangeRegime = regimeStr === "RANGE" || routingStr === "RANGE" || subtypeStr === "CANONICAL_RANGE";

    // FAST_TREND_SHIFT or non-RANGE TREND entries are bypassed with zero modification
    const isFts = subtypeStr === "FAST_TREND_SHIFT" || String(input.promotionReason ?? "").includes("FAST_TREND_SHIFT");
    if (!isRangeRegime || isFts) {
        return {
            evaluated: false,
            allowed: true,
            classification: "ETH_RANGE_FULL",
            probeMultiplier: 1.0,
            blockReason: null,
            isProbe: false,
            isDirectionConflict: false,
            ethLocationPass: true,
            ethReversalPass: true
        };
    }

    const side = input.side;
    const boxPos = input.boxPos;
    const reversalConfirmed = input.reversalConfirmed === true;
    const trendCand = String(input.trendSideCandidate ?? "none").toLowerCase();
    const rangeCand = String(input.rangeSideCandidate ?? side).toLowerCase();

    // Direction conflict: trendSideCandidate exists and opposes current side
    const isDirectionConflict = trendCand !== "none" && trendCand !== side;

    if (boxPos === null || !Number.isFinite(boxPos)) {
        const res: EthRangeEntryQualityResult = {
            evaluated: true,
            allowed: false,
            classification: "ETH_RANGE_BLOCK",
            probeMultiplier: 0.0,
            blockReason: "ETH_RANGE_LOCATION_TOO_AMBIGUOUS",
            isProbe: false,
            isDirectionConflict,
            ethLocationPass: false,
            ethReversalPass: reversalConfirmed
        };
        emitQualityProof(input, res);
        return res;
    }

    const isLong = side === "long";
    const isShort = side === "short";

    // Case 1: Direction Conflict (Countertrend: RANGE side opposes TREND candidate)
    if (isDirectionConflict) {
        const isExtremeCountertrend =
            (isLong && boxPos <= 0.08 && reversalConfirmed) ||
            (isShort && boxPos >= 0.92 && reversalConfirmed);

        if (isExtremeCountertrend) {
            const res: EthRangeEntryQualityResult = {
                evaluated: true,
                allowed: true,
                classification: "ETH_RANGE_COUNTERTREND_EXTREME_PROBE",
                probeMultiplier: 0.50,
                blockReason: null,
                isProbe: true,
                isDirectionConflict: true,
                ethLocationPass: true,
                ethReversalPass: true
            };
            emitQualityProof(input, res);
            return res;
        } else {
            const res: EthRangeEntryQualityResult = {
                evaluated: true,
                allowed: false,
                classification: "ETH_RANGE_BLOCK",
                probeMultiplier: 0.0,
                blockReason: "ETH_RANGE_COUNTERTREND_NOT_EXTREME_CONFIRMED",
                isProbe: false,
                isDirectionConflict: true,
                ethLocationPass: (isLong && boxPos <= 0.08) || (isShort && boxPos >= 0.92),
                ethReversalPass: reversalConfirmed
            };
            emitQualityProof(input, res);
            return res;
        }
    }

    // Case 2: No Direction Conflict (trend candidate is none or aligned with side)
    const isFullLocation = (isLong && boxPos <= 0.20) || (isShort && boxPos >= 0.80);
    const isAmbiguousProbeLocation =
        (isLong && boxPos > 0.20 && boxPos <= 0.35) ||
        (isShort && boxPos < 0.80 && boxPos >= 0.65);

    // 2.A: FULL Entry (boxPos <= 0.20 / >= 0.80 + reversalConfirmed)
    if (isFullLocation && reversalConfirmed) {
        const res: EthRangeEntryQualityResult = {
            evaluated: true,
            allowed: true,
            classification: "ETH_RANGE_FULL",
            probeMultiplier: 1.0,
            blockReason: null,
            isProbe: false,
            isDirectionConflict: false,
            ethLocationPass: true,
            ethReversalPass: true
        };
        emitQualityProof(input, res);
        return res;
    }

    // 2.B: LOCATION PROBE (0.20 < boxPos <= 0.35 / 0.65 <= boxPos < 0.80 + reversalConfirmed)
    if (isAmbiguousProbeLocation && reversalConfirmed) {
        const res: EthRangeEntryQualityResult = {
            evaluated: true,
            allowed: true,
            classification: "ETH_RANGE_LOCATION_PROBE",
            probeMultiplier: 0.50,
            blockReason: null,
            isProbe: true,
            isDirectionConflict: false,
            ethLocationPass: true,
            ethReversalPass: true
        };
        emitQualityProof(input, res);
        return res;
    }

    // 2.C: UNCONFIRMED PROBE (boxPos <= 0.20 / >= 0.80 + reversalConfirmed=false)
    if (isFullLocation && !reversalConfirmed) {
        const res: EthRangeEntryQualityResult = {
            evaluated: true,
            allowed: true,
            classification: "ETH_RANGE_UNCONFIRMED_PROBE",
            probeMultiplier: 0.50,
            blockReason: null,
            isProbe: true,
            isDirectionConflict: false,
            ethLocationPass: true,
            ethReversalPass: false
        };
        emitQualityProof(input, res);
        return res;
    }

    // 2.D: BLOCK (Ambiguous location without reversal confirmation or boxPos beyond Highway limits)
    let blockReason = "ETH_RANGE_LOCATION_TOO_AMBIGUOUS";
    if (!reversalConfirmed && isAmbiguousProbeLocation) {
        blockReason = "ETH_RANGE_REVERSAL_NOT_CONFIRMED";
    }

    const res: EthRangeEntryQualityResult = {
        evaluated: true,
        allowed: false,
        classification: "ETH_RANGE_BLOCK",
        probeMultiplier: 0.0,
        blockReason,
        isProbe: false,
        isDirectionConflict: false,
        ethLocationPass: isFullLocation || isAmbiguousProbeLocation,
        ethReversalPass: reversalConfirmed
    };
    emitQualityProof(input, res);
    return res;
}

export function emitQualityProof(
    input: EthRangeEntryQualityInput,
    result: EthRangeEntryQualityResult
): void {
    if (input.emitProof === false) return;
    // Resolve sizing fields with canonical priority order:
    // base_order_notional_before_eth_probe = pre-probe notional (what FULL would use)
    // live_baseline_order_notional = effective full-entry baseline (after all caps)
    // probe_multiplier = ETH RANGE probe multiplier (1.0 for FULL, 0.50 for PROBE, 0.0 for BLOCK)
    // submitted_order_notional = actual submitted value after probe × lot normalization
    const baseBeforeProbe = input.baseOrderNotionalBeforeEthProbe ?? input.baseOrderNotional ?? null;
    const liveBaseline = input.liveBaselineOrderNotional ?? baseBeforeProbe;
    const submitted = input.submittedOrderNotional ?? input.finalOrderNotional ?? null;
    const proof = {
        event: "ETH_RANGE_ENTRY_QUALITY_PROOF",
        symbol: normalizeEthSymbol(input.symbol),
        side: input.side,
        regime: input.regime,
        subtype: input.subtype ?? null,
        boxPos: input.boxPos,
        zone: input.zone ?? null,
        range_side_candidate: input.rangeSideCandidate ?? null,
        trend_side_candidate: input.trendSideCandidate ?? null,
        selected_side_after_veto: input.selectedSideAfterVeto ?? input.side,
        reversal_confirmed: input.reversalConfirmed,
        side_zone_valid: input.sideZoneValid ?? null,
        range_edge_extreme: input.rangeEdgeExtreme ?? null,
        quality_score: input.qualityScore ?? null,
        entry_quality_grade: input.entryQualityGrade ?? null,
        htf_entry_policy: input.htfEntryPolicy ?? null,
        directional_shock_state: input.directionalShockState ?? "NONE",
        classification: result.classification,
        // Sizing fields (canonical)
        base_order_notional_before_eth_probe: baseBeforeProbe,
        live_baseline_order_notional: liveBaseline,
        probe_multiplier: result.probeMultiplier,
        submitted_order_notional: submitted,
        live_max_order_notional_usdt: input.liveMaxOrderNotionalUsdt ?? null,
        final_allowed: result.allowed,
        block_reason: result.blockReason,
        timestamp: input.now ?? Date.now()
    };
    console.info(JSON.stringify(proof));
}
