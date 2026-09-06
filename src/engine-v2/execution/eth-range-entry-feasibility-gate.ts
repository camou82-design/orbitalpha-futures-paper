/**
 * ETH RANGE Pre-entry Feasibility Gate — Dynamic Cost Edition
 *
 * Strict invariants:
 * 1. ETHUSDT only (BTCUSDT and all others 100% bypassed with ZERO behavior change).
 * 2. Strict OPERATOR / Manual bypass (OPERATOR_MANAGED, EXTERNAL_MANUAL_POSITION, manual takeover/latch).
 * 3. Add-on bypass (isAddon === true is untouched).
 * 4. TREND, SHOCK, FAST_TREND_SHIFT, confirmed breakout continuation are bypassed.
 * 5. Canonical structural target:
 *    - LONG: boxMid > entryPrice required (wrong-side → BLOCK).
 *    - SHORT: boxMid < entryPrice required (wrong-side → BLOCK).
 *    - ETH_RANGE_ENTRY_NO_DIRECTIONAL_PROFIT_SPACE on wrong-side (preserved).
 * 6. Dynamic cost formula — NO hardcoded 14/17.5/18.8 bps floors:
 *    entryFeeBps        = feeRate * 10000
 *    expectedExitFeeBps = feeRate * 10000
 *    preEntrySlippageBps= paperSlippageEstimateBps (from config/input)
 *    estimatedRoundTripCostBps = entryFee + exitFee + slippage
 *    requiredProfitSpaceBps    = estimatedRoundTripCostBps + MINIMUM_NET_EDGE_BPS (5.0)
 * 7. Box width check: boxWidthBps >= BOX_WIDTH_MIN_BPS (35.0)
 *    → ETH_RANGE_BOX_TOO_NARROW_TO_TRADE on failure.
 * 8. Directional profit space check:
 *    directionalProfitSpaceBps >= requiredProfitSpaceBps
 *    → ETH_RANGE_ENTRY_INSUFFICIENT_DIRECTIONAL_PROFIT_SPACE on failure.
 * 9. No-lookahead guarantee: ONLY canonical pre-entry inputs used.
 *    Actual fill slippage, MFE, MAE, realized PnL MUST NOT be read.
 * 10. Cost not evaluable: ETH_RANGE_ENTRY_COST_NOT_EVALUABLE on irrecoverable absence.
 *     Conservative fallback (feeRate=0.0005 if absent) → always evaluable in practice.
 * 11. Feasibility provenance fields (feasibility_evaluated, feasibility_passed) are
 *     included in every result for AI gate bypass in paper-engine.
 * 12. Emits V2_ETH_RANGE_ENTRY_FEASIBILITY_PROOF log.
 */

// Box width minimum in bps (35 bps = 0.35%)
const BOX_WIDTH_MIN_BPS = 35.0;
// Required minimum net edge above round-trip cost (bps)
const MINIMUM_NET_EDGE_BPS = 5.0;

export type EthRangeEntryFeasibilityBlockReason =
    | "ETH_RANGE_BOX_TOO_NARROW_TO_TRADE"
    | "ETH_RANGE_ENTRY_NO_DIRECTIONAL_PROFIT_SPACE"
    | "ETH_RANGE_ENTRY_INSUFFICIENT_DIRECTIONAL_PROFIT_SPACE"
    | "ETH_RANGE_ENTRY_COST_NOT_EVALUABLE";

export interface EthRangeEntryFeasibilityInput {
    symbol: string;
    side: "long" | "short";
    regime: string;
    marketSubtype?: string | null;
    promotionReason?: string | null;
    entryPrice: number;
    boxHigh?: number | null;
    boxLow?: number | null;
    boxMid?: number | null;
    atr?: number | null;
    feeRate?: number;
    paperSlippageEstimateBps?: number;
    tickSz?: number;
    isAddon?: boolean;
    lifecycleState?: string | null;
    manualTakeoverActive?: boolean;
    manualOwnershipLatch?: boolean;
    emitProof?: boolean;
}

export interface EthRangeEntryFeasibilityResult {
    entryAllowed: boolean;
    blocked: boolean;
    blockReason: EthRangeEntryFeasibilityBlockReason | null;
    symbol: string;
    side: "long" | "short";
    regime: string;
    subtype: string | null;
    entry_price: number;
    box_high: number | null;
    box_low: number | null;
    box_mid: number | null;
    /** Box width expressed as a fraction of entry price (backward compat) */
    box_width_pct: number | null;
    /** Box width in basis points (primary check value) */
    box_width_bps: number | null;
    structural_target: number | null;
    structural_target_source: string;
    /** Directional profit space to structural target, as fraction (backward compat) */
    gross_structural_edge_pct: number | null;
    /** Directional profit space to structural target in basis points */
    directional_profit_space_bps: number | null;
    // ---- Dynamic cost fields (bps) ----
    entry_fee_bps: number;
    expected_exit_fee_bps: number;
    expected_slippage_bps: number;
    estimated_round_trip_cost_bps: number;
    minimum_net_edge_bps: number;
    required_profit_space_bps: number;
    cost_source: string;
    cost_evaluable: boolean;
    // ---- Legacy pct fields (kept for backward compat) ----
    profitability_floor_pct: number;
    fee_component_pct: number;
    slippage_component_pct: number;
    required_net_edge_pct: number;
    // ---- Gate result flags ----
    directional_space_valid: boolean;
    box_width_sufficient: boolean;
    profitability_passed: boolean;
    /** True when the gate was actually evaluated (not bypassed for BTC/TREND/operator/etc.) */
    feasibility_evaluated: boolean;
    /** True when the gate passed (either genuinely evaluated+passed, or bypassed=allow) */
    feasibility_passed: boolean;
}

const CONFIRMED_BREAKOUT_SUBTYPES = new Set([
    "BREAKOUT_RETEST_CONFIRMED",
    "BREAKOUT_RETEST_CONFIRMED_VOLUME",
    "BREAKDOWN_RETEST_FAILED",
    "BREAKDOWN_RETEST_CONFIRMED",
    "BREAKDOWN_CONTINUATION"
]);

const SHOCK_OR_EMERGENCY_SUBTYPES = new Set([
    "SHOCK_REACTION_UP",
    "SHOCK_REACTION_DOWN",
    "WHIPSAW_SHOCK_RECHECK",
    "WHIPSAW_SOFT_WATCH",
    "FAST_TREND_SHIFT"
]);

export function evaluateEthRangeEntryFeasibilityGate(
    input: EthRangeEntryFeasibilityInput
): EthRangeEntryFeasibilityResult {
    const symbol = String(input.symbol ?? "").toUpperCase();
    const side = input.side;
    const entryPx = Number(input.entryPrice ?? 0);
    const regimeStr = String(input.regime ?? "").toUpperCase();
    const subtypeStr = String(input.marketSubtype ?? "").trim().toUpperCase();

    // ---- Dynamic cost resolution (pre-entry canonical inputs only, no lookahead) ----
    const feeProvided = input.feeRate !== undefined;
    const feeValid = feeProvided ? (typeof input.feeRate === "number" && Number.isFinite(input.feeRate) && input.feeRate > 0) : true;
    const slippageProvided = input.paperSlippageEstimateBps !== undefined;
    const slippageValid = slippageProvided ? (typeof input.paperSlippageEstimateBps === "number" && Number.isFinite(input.paperSlippageEstimateBps) && input.paperSlippageEstimateBps >= 0) : true;
    const costEvaluable = feeValid && slippageValid;

    const feeRate = feeProvided && feeValid ? input.feeRate! : (costEvaluable ? 0.0005 : 0);
    const costSource = feeProvided && feeValid ? "config" : (costEvaluable ? "config_default" : "invalid");
    const preEntrySlippageEstimateBps = slippageProvided && slippageValid ? input.paperSlippageEstimateBps! : (costEvaluable ? 8 : 0);

    const entryFeeBps = feeRate * 10000;
    const expectedExitFeeBps = feeRate * 10000;
    const estimatedRoundTripCostBps = entryFeeBps + expectedExitFeeBps + preEntrySlippageEstimateBps;
    const minimumNetEdgeBps = MINIMUM_NET_EDGE_BPS;
    const requiredProfitSpaceBps = estimatedRoundTripCostBps + minimumNetEdgeBps;

    // Legacy pct fields (kept for backward compat)
    const feeComponentPct = feeRate * 2;
    const slippageComponentPct = preEntrySlippageEstimateBps / 10000;
    const requiredNetEdgePct = minimumNetEdgeBps / 10000;
    const profitabilityFloorPct = requiredProfitSpaceBps / 10000;

    const boxHigh = typeof input.boxHigh === "number" && Number.isFinite(input.boxHigh) ? input.boxHigh : null;
    const boxLow = typeof input.boxLow === "number" && Number.isFinite(input.boxLow) ? input.boxLow : null;
    const boxMidRaw = typeof input.boxMid === "number" && Number.isFinite(input.boxMid) && input.boxMid > 0
        ? input.boxMid
        : (boxHigh !== null && boxLow !== null ? (boxHigh + boxLow) / 2 : null);

    const boxWidthPct = (boxHigh !== null && boxLow !== null && entryPx > 0)
        ? (boxHigh - boxLow) / entryPx
        : null;
    const boxWidthBps = boxWidthPct !== null ? boxWidthPct * 10000 : null;

    const ls = String(input.lifecycleState ?? "");
    const isOperatorManaged =
        ls === "OPERATOR_MANAGED" ||
        ls === "EXTERNAL_MANUAL_POSITION" ||
        input.manualTakeoverActive === true ||
        input.manualOwnershipLatch === true;

    const emitLog = (res: EthRangeEntryFeasibilityResult) => {
        if (input.emitProof !== false && symbol === "ETHUSDT") {
            console.info(JSON.stringify({
                event: "V2_ETH_RANGE_ENTRY_FEASIBILITY_PROOF",
                symbol: res.symbol,
                side: res.side,
                regime: res.regime,
                subtype: res.subtype,
                entry_price: res.entry_price,
                box_high: res.box_high,
                box_low: res.box_low,
                box_mid: res.box_mid,
                box_width_pct: res.box_width_pct,
                box_width_bps: res.box_width_bps,
                box_width_min_bps: BOX_WIDTH_MIN_BPS,
                structural_target: res.structural_target,
                structural_target_source: res.structural_target_source,
                gross_structural_edge_pct: res.gross_structural_edge_pct,
                directional_profit_space_bps: res.directional_profit_space_bps,
                entry_fee_bps: res.entry_fee_bps,
                expected_exit_fee_bps: res.expected_exit_fee_bps,
                expected_slippage_bps: res.expected_slippage_bps,
                estimated_round_trip_cost_bps: res.estimated_round_trip_cost_bps,
                minimum_net_edge_bps: res.minimum_net_edge_bps,
                required_profit_space_bps: res.required_profit_space_bps,
                cost_source: res.cost_source,
                cost_evaluable: res.cost_evaluable,
                profitability_floor_pct: res.profitability_floor_pct,
                fee_component_pct: res.fee_component_pct,
                slippage_component_pct: res.slippage_component_pct,
                required_net_edge_pct: res.required_net_edge_pct,
                directional_space_valid: res.directional_space_valid,
                box_width_sufficient: res.box_width_sufficient,
                profitability_passed: res.profitability_passed,
                feasibility_evaluated: res.feasibility_evaluated,
                feasibility_passed: res.feasibility_passed,
                blocked: res.blocked,
                block_reason: res.blockReason ?? null
            }));
        }
    };

    // Shared bypass result template (gate not applicable → allow through)
    const makeBypassResult = (): EthRangeEntryFeasibilityResult => ({
        entryAllowed: true,
        blocked: false,
        blockReason: null,
        symbol,
        side,
        regime: regimeStr,
        subtype: subtypeStr || null,
        entry_price: entryPx,
        box_high: boxHigh,
        box_low: boxLow,
        box_mid: boxMidRaw,
        box_width_pct: boxWidthPct,
        box_width_bps: boxWidthBps,
        structural_target: null,
        structural_target_source: "none",
        gross_structural_edge_pct: null,
        directional_profit_space_bps: null,
        entry_fee_bps: entryFeeBps,
        expected_exit_fee_bps: expectedExitFeeBps,
        expected_slippage_bps: preEntrySlippageEstimateBps,
        estimated_round_trip_cost_bps: estimatedRoundTripCostBps,
        minimum_net_edge_bps: minimumNetEdgeBps,
        required_profit_space_bps: requiredProfitSpaceBps,
        cost_source: costSource,
        cost_evaluable: costEvaluable,
        profitability_floor_pct: profitabilityFloorPct,
        fee_component_pct: feeComponentPct,
        slippage_component_pct: slippageComponentPct,
        required_net_edge_pct: requiredNetEdgePct,
        directional_space_valid: true,
        box_width_sufficient: true,
        profitability_passed: true,
        // Gate was bypassed — NOT formally evaluated for feasibility
        feasibility_evaluated: false,
        feasibility_passed: true
    });

    // ================================================================
    // Bypass gates (invariants preserved — no behavior change)
    // ================================================================

    // 1. Symbol Scope: ETHUSDT only (BTC and others 100% untouched)
    if (symbol !== "ETHUSDT") {
        return makeBypassResult();
    }

    // 2. Strict Operational Immunity: Manual or operator positions bypass
    if (isOperatorManaged) {
        return makeBypassResult();
    }

    // 3. Add-on Bypass: Add-ons unchanged
    if (input.isAddon === true) {
        return makeBypassResult();
    }

    // 4. TREND Regime Bypass
    if (regimeStr === "TREND") {
        return makeBypassResult();
    }

    // 5. Confirmed Breakout / SHOCK / FAST_TREND_SHIFT subtypes bypass
    if (
        CONFIRMED_BREAKOUT_SUBTYPES.has(subtypeStr) ||
        /BREAKOUT.*CONFIRMED/i.test(subtypeStr) ||
        /BREAKDOWN.*CONFIRMED/i.test(subtypeStr)
    ) {
        return makeBypassResult();
    }

    if (
        SHOCK_OR_EMERGENCY_SUBTYPES.has(subtypeStr) ||
        subtypeStr.startsWith("SHOCK_REACTION") ||
        subtypeStr.includes("FAST_TREND_SHIFT") ||
        String(input.promotionReason ?? "").includes("breakout_continuation") ||
        String(input.promotionReason ?? "").includes("breakdown_continuation")
    ) {
        return makeBypassResult();
    }

    // 6. Non-RANGE regimes bypass
    if (regimeStr !== "RANGE" && regimeStr !== "NO_TRADE") {
        return makeBypassResult();
    }

    // 7. Box Data Presence: cannot evaluate without box geometry
    if (boxHigh === null || boxLow === null || !(boxHigh > boxLow) || !(entryPx > 0)) {
        return makeBypassResult();
    }

    // ================================================================
    // Feasibility evaluation begins here (feasibility_evaluated = true)
    // ================================================================

    // ---- CHECK 0: Cost Evaluable ----
    if (!costEvaluable) {
        const res: EthRangeEntryFeasibilityResult = {
            entryAllowed: false,
            blocked: true,
            blockReason: "ETH_RANGE_ENTRY_COST_NOT_EVALUABLE",
            symbol,
            side,
            regime: regimeStr,
            subtype: subtypeStr || null,
            entry_price: entryPx,
            box_high: boxHigh,
            box_low: boxLow,
            box_mid: boxMidRaw,
            box_width_pct: boxWidthPct,
            box_width_bps: boxWidthBps,
            structural_target: boxMidRaw,
            structural_target_source: "box_mid",
            gross_structural_edge_pct: boxMidRaw !== null ? Math.abs(boxMidRaw - entryPx) / entryPx : null,
            directional_profit_space_bps: null,
            entry_fee_bps: entryFeeBps,
            expected_exit_fee_bps: expectedExitFeeBps,
            expected_slippage_bps: preEntrySlippageEstimateBps,
            estimated_round_trip_cost_bps: estimatedRoundTripCostBps,
            minimum_net_edge_bps: minimumNetEdgeBps,
            required_profit_space_bps: requiredProfitSpaceBps,
            cost_source: costSource,
            cost_evaluable: false,
            profitability_floor_pct: profitabilityFloorPct,
            fee_component_pct: feeComponentPct,
            slippage_component_pct: slippageComponentPct,
            required_net_edge_pct: requiredNetEdgePct,
            directional_space_valid: false,
            box_width_sufficient: false,
            profitability_passed: false,
            feasibility_evaluated: true,
            feasibility_passed: false
        };
        emitLog(res);
        return res;
    }

    // ---- CHECK A: Box Width >= 35 bps ----
    const isBoxWidthSufficient = boxWidthBps !== null && boxWidthBps >= BOX_WIDTH_MIN_BPS;
    if (!isBoxWidthSufficient) {
        const res: EthRangeEntryFeasibilityResult = {
            entryAllowed: false,
            blocked: true,
            blockReason: "ETH_RANGE_BOX_TOO_NARROW_TO_TRADE",
            symbol,
            side,
            regime: regimeStr,
            subtype: subtypeStr || null,
            entry_price: entryPx,
            box_high: boxHigh,
            box_low: boxLow,
            box_mid: boxMidRaw,
            box_width_pct: boxWidthPct,
            box_width_bps: boxWidthBps,
            structural_target: boxMidRaw,
            structural_target_source: "box_mid",
            gross_structural_edge_pct: boxMidRaw !== null ? Math.abs(boxMidRaw - entryPx) / entryPx : null,
            directional_profit_space_bps: null,
            entry_fee_bps: entryFeeBps,
            expected_exit_fee_bps: expectedExitFeeBps,
            expected_slippage_bps: preEntrySlippageEstimateBps,
            estimated_round_trip_cost_bps: estimatedRoundTripCostBps,
            minimum_net_edge_bps: minimumNetEdgeBps,
            required_profit_space_bps: requiredProfitSpaceBps,
            cost_source: costSource,
            cost_evaluable: costEvaluable,
            profitability_floor_pct: profitabilityFloorPct,
            fee_component_pct: feeComponentPct,
            slippage_component_pct: slippageComponentPct,
            required_net_edge_pct: requiredNetEdgePct,
            directional_space_valid: false,
            box_width_sufficient: false,
            profitability_passed: false,
            feasibility_evaluated: true,
            feasibility_passed: false
        };
        emitLog(res);
        return res;
    }

    // ---- CHECK B: Canonical Target Direction (WRONG_SIDE block — preserved) ----
    const boxMid = boxMidRaw!;

    // LONG needs boxMid > entryPrice; SHORT needs boxMid < entryPrice
    const directionalSpaceValid = side === "long" ? (boxMid > entryPx) : (boxMid < entryPx);

    if (!directionalSpaceValid) {
        const res: EthRangeEntryFeasibilityResult = {
            entryAllowed: false,
            blocked: true,
            blockReason: "ETH_RANGE_ENTRY_NO_DIRECTIONAL_PROFIT_SPACE",
            symbol,
            side,
            regime: regimeStr,
            subtype: subtypeStr || null,
            entry_price: entryPx,
            box_high: boxHigh,
            box_low: boxLow,
            box_mid: boxMid,
            box_width_pct: boxWidthPct,
            box_width_bps: boxWidthBps,
            structural_target: boxMid,
            structural_target_source: "box_mid",
            gross_structural_edge_pct: Math.abs(boxMid - entryPx) / entryPx,
            // Directional space is negative (wrong side) — expose raw value
            directional_profit_space_bps: side === "long"
                ? (boxMid - entryPx) / entryPx * 10000
                : (entryPx - boxMid) / entryPx * 10000,
            entry_fee_bps: entryFeeBps,
            expected_exit_fee_bps: expectedExitFeeBps,
            expected_slippage_bps: preEntrySlippageEstimateBps,
            estimated_round_trip_cost_bps: estimatedRoundTripCostBps,
            minimum_net_edge_bps: minimumNetEdgeBps,
            required_profit_space_bps: requiredProfitSpaceBps,
            cost_source: costSource,
            cost_evaluable: costEvaluable,
            profitability_floor_pct: profitabilityFloorPct,
            fee_component_pct: feeComponentPct,
            slippage_component_pct: slippageComponentPct,
            required_net_edge_pct: requiredNetEdgePct,
            directional_space_valid: false,
            box_width_sufficient: true,
            profitability_passed: false,
            feasibility_evaluated: true,
            feasibility_passed: false
        };
        emitLog(res);
        return res;
    }

    // ---- Canonical structural target (boxMid, directional) ----
    const structuralTarget = boxMid;
    const grossStructuralEdgePct = Math.abs(structuralTarget - entryPx) / entryPx;

    // Directional profit space in bps (always positive here — wrong-side already blocked)
    const directionalProfitSpaceBps = side === "long"
        ? (structuralTarget - entryPx) / entryPx * 10000
        : (entryPx - structuralTarget) / entryPx * 10000;

    // ---- CHECK C: Directional Profit Space >= Required ----
    const directionalSpaceOk = directionalProfitSpaceBps >= requiredProfitSpaceBps - 1e-8;

    if (!directionalSpaceOk) {
        const res: EthRangeEntryFeasibilityResult = {
            entryAllowed: false,
            blocked: true,
            blockReason: "ETH_RANGE_ENTRY_INSUFFICIENT_DIRECTIONAL_PROFIT_SPACE",
            symbol,
            side,
            regime: regimeStr,
            subtype: subtypeStr || null,
            entry_price: entryPx,
            box_high: boxHigh,
            box_low: boxLow,
            box_mid: boxMid,
            box_width_pct: boxWidthPct,
            box_width_bps: boxWidthBps,
            structural_target: structuralTarget,
            structural_target_source: "box_mid",
            gross_structural_edge_pct: grossStructuralEdgePct,
            directional_profit_space_bps: directionalProfitSpaceBps,
            entry_fee_bps: entryFeeBps,
            expected_exit_fee_bps: expectedExitFeeBps,
            expected_slippage_bps: preEntrySlippageEstimateBps,
            estimated_round_trip_cost_bps: estimatedRoundTripCostBps,
            minimum_net_edge_bps: minimumNetEdgeBps,
            required_profit_space_bps: requiredProfitSpaceBps,
            cost_source: costSource,
            cost_evaluable: costEvaluable,
            profitability_floor_pct: profitabilityFloorPct,
            fee_component_pct: feeComponentPct,
            slippage_component_pct: slippageComponentPct,
            required_net_edge_pct: requiredNetEdgePct,
            directional_space_valid: true,
            box_width_sufficient: true,
            profitability_passed: false,
            feasibility_evaluated: true,
            feasibility_passed: false
        };
        emitLog(res);
        return res;
    }

    // ================================================================
    // All Feasibility Checks Passed
    // ================================================================
    const successRes: EthRangeEntryFeasibilityResult = {
        entryAllowed: true,
        blocked: false,
        blockReason: null,
        symbol,
        side,
        regime: regimeStr,
        subtype: subtypeStr || null,
        entry_price: entryPx,
        box_high: boxHigh,
        box_low: boxLow,
        box_mid: boxMid,
        box_width_pct: boxWidthPct,
        box_width_bps: boxWidthBps,
        structural_target: structuralTarget,
        structural_target_source: "box_mid",
        gross_structural_edge_pct: grossStructuralEdgePct,
        directional_profit_space_bps: directionalProfitSpaceBps,
        entry_fee_bps: entryFeeBps,
        expected_exit_fee_bps: expectedExitFeeBps,
        expected_slippage_bps: preEntrySlippageEstimateBps,
        estimated_round_trip_cost_bps: estimatedRoundTripCostBps,
        minimum_net_edge_bps: minimumNetEdgeBps,
        required_profit_space_bps: requiredProfitSpaceBps,
        cost_source: costSource,
        cost_evaluable: costEvaluable,
        profitability_floor_pct: profitabilityFloorPct,
        fee_component_pct: feeComponentPct,
        slippage_component_pct: slippageComponentPct,
        required_net_edge_pct: requiredNetEdgePct,
        directional_space_valid: true,
        box_width_sufficient: true,
        profitability_passed: true,
        feasibility_evaluated: true,
        feasibility_passed: true
    };
    emitLog(successRes);
    return successRes;
}
