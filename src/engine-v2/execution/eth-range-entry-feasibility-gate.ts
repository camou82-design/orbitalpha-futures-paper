import { evaluateTpProfitabilityAuthority } from "./tp-profitability-authority";
import { ETH_RANGE_MIN_NET_EDGE_PCT } from "./eth-range-dynamic-tp-authority";

export type EthRangeEntryFeasibilityBlockReason =
    | "ETH_RANGE_BOX_TOO_NARROW_TO_TRADE"
    | "ETH_RANGE_ENTRY_NO_DIRECTIONAL_PROFIT_SPACE"
    | "ETH_RANGE_ENTRY_INSUFFICIENT_PROFIT_SPACE";

export interface EthRangeEntryFeasibilityInput {
    symbol: string;
    side: "long" | "short";
    regime: string;
    marketSubtype?: string | null;
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
    box_width_pct: number | null;
    structural_target: number | null;
    structural_target_source: string;
    gross_structural_edge_pct: number | null;
    profitability_floor_pct: number;
    fee_component_pct: number;
    slippage_component_pct: number;
    required_net_edge_pct: number;
    directional_space_valid: boolean;
    box_width_sufficient: boolean;
    profitability_passed: boolean;
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

/**
 * Pre-entry Feasibility Gate for ETHUSDT in RANGE / FLAT / LOW-VOL environments.
 *
 * Strict invariants:
 * 1. ETHUSDT only (BTCUSDT is strictly bypassed with ZERO behavior change).
 * 2. Strict OPERATOR / Manual bypass (OPERATOR_MANAGED, EXTERNAL_MANUAL_POSITION, manual takeover/latch).
 * 3. Add-on bypass (isAddon === true is untouched).
 * 4. TREND, SHOCK, FAST_TREND_SHIFT, confirmed breakout continuation are bypassed.
 * 5. Canonical structural target:
 *    - LONG: boxMid > entryPrice required.
 *    - SHORT: boxMid < entryPrice required.
 *    - Wrong-side boxMid -> blocked with ETH_RANGE_ENTRY_NO_DIRECTIONAL_PROFIT_SPACE.
 *    - No synthetic target fabrication!
 * 6. Profitability floor:
 *    - Uses existing authority floor (roundTripFeePct + slippagePct + minNetEdgePct).
 *    - Floor is 0.195% (19.5 bps) — NOT lowered in this phase.
 *    - grossStructuralEdgePct < floor -> blocked with ETH_RANGE_ENTRY_INSUFFICIENT_PROFIT_SPACE.
 * 7. Tiny box check:
 *    - Entire box width pct < profitabilityFloorPct -> blocked with ETH_RANGE_BOX_TOO_NARROW_TO_TRADE.
 * 8. Emits V2_ETH_RANGE_ENTRY_FEASIBILITY_PROOF log.
 */
export function evaluateEthRangeEntryFeasibilityGate(
    input: EthRangeEntryFeasibilityInput
): EthRangeEntryFeasibilityResult {
    const symbol = String(input.symbol ?? "").toUpperCase();
    const side = input.side;
    const entryPx = Number(input.entryPrice ?? 0);
    const regimeStr = String(input.regime ?? "").toUpperCase();
    const subtypeStr = String(input.marketSubtype ?? "").trim().toUpperCase();

    const feeRate = typeof input.feeRate === "number" && input.feeRate > 0 ? input.feeRate : 0.0005;
    const slippageBps = typeof input.paperSlippageEstimateBps === "number" ? input.paperSlippageEstimateBps : 8;
    const tickSz = typeof input.tickSz === "number" && input.tickSz > 0 ? input.tickSz : 0.01;

    const feeComponentPct = feeRate * 2; // 0.0010 = 10 bps
    const slippageComponentPct = slippageBps / 10000; // 0.0008 = 8 bps
    const requiredNetEdgePct = ETH_RANGE_MIN_NET_EDGE_PCT; // 0.00015 = 1.5 bps
    const profitabilityFloorPct = feeComponentPct + slippageComponentPct + requiredNetEdgePct; // 0.00195 = 19.5 bps

    const boxHigh = typeof input.boxHigh === "number" && Number.isFinite(input.boxHigh) ? input.boxHigh : null;
    const boxLow = typeof input.boxLow === "number" && Number.isFinite(input.boxLow) ? input.boxLow : null;
    const boxMidRaw = typeof input.boxMid === "number" && Number.isFinite(input.boxMid) && input.boxMid > 0
        ? input.boxMid
        : (boxHigh !== null && boxLow !== null ? (boxHigh + boxLow) / 2 : null);

    const boxWidthPct = (boxHigh !== null && boxLow !== null && entryPx > 0)
        ? (boxHigh - boxLow) / entryPx
        : null;

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
                structural_target: res.structural_target,
                structural_target_source: res.structural_target_source,
                gross_structural_edge_pct: res.gross_structural_edge_pct,
                profitability_floor_pct: res.profitability_floor_pct,
                fee_component_pct: res.fee_component_pct,
                slippage_component_pct: res.slippage_component_pct,
                required_net_edge_pct: res.required_net_edge_pct,
                directional_space_valid: res.directional_space_valid,
                box_width_sufficient: res.box_width_sufficient,
                profitability_passed: res.profitability_passed,
                blocked: res.blocked,
                block_reason: res.blockReason ?? null
            }));
        }
    };

    const makeBypassResult = (): EthRangeEntryFeasibilityResult => {
        const res: EthRangeEntryFeasibilityResult = {
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
            structural_target: null,
            structural_target_source: "none",
            gross_structural_edge_pct: null,
            profitability_floor_pct: profitabilityFloorPct,
            fee_component_pct: feeComponentPct,
            slippage_component_pct: slippageComponentPct,
            required_net_edge_pct: requiredNetEdgePct,
            directional_space_valid: true,
            box_width_sufficient: true,
            profitability_passed: true
        };
        return res;
    };

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

    // 4. Regime & Subtype Scope: Only RANGE / flat / low-vol range
    if (regimeStr === "TREND") {
        return makeBypassResult();
    }

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
        subtypeStr.includes("FAST_TREND_SHIFT")
    ) {
        return makeBypassResult();
    }

    if (regimeStr !== "RANGE" && regimeStr !== "NO_TRADE") {
        return makeBypassResult();
    }

    // 5. Box Data Presence
    if (boxHigh === null || boxLow === null || !(boxHigh > boxLow) || !(entryPx > 0)) {
        // If box data is unavailable, we cannot prove range feasibility; bypass to prevent false blocks on unboxed states
        return makeBypassResult();
    }

    // 6. Tiny Box Check: Total box width must cover round-trip execution cost + required net edge
    const isBoxWidthSufficient = boxWidthPct !== null && boxWidthPct >= profitabilityFloorPct;
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
            structural_target: boxMidRaw,
            structural_target_source: "box_mid",
            gross_structural_edge_pct: boxMidRaw !== null ? Math.abs(boxMidRaw - entryPx) / entryPx : null,
            profitability_floor_pct: profitabilityFloorPct,
            fee_component_pct: feeComponentPct,
            slippage_component_pct: slippageComponentPct,
            required_net_edge_pct: requiredNetEdgePct,
            directional_space_valid: false,
            box_width_sufficient: false,
            profitability_passed: false
        };
        emitLog(res);
        return res;
    }

    // 7. Canonical Structural Target & Directional Space Validation
    // LONG: boxMid > entryPrice
    // SHORT: boxMid < entryPrice
    const boxMid = boxMidRaw!;
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
            structural_target: boxMid,
            structural_target_source: "box_mid",
            gross_structural_edge_pct: Math.abs(boxMid - entryPx) / entryPx,
            profitability_floor_pct: profitabilityFloorPct,
            fee_component_pct: feeComponentPct,
            slippage_component_pct: slippageComponentPct,
            required_net_edge_pct: requiredNetEdgePct,
            directional_space_valid: false,
            box_width_sufficient: true,
            profitability_passed: false
        };
        emitLog(res);
        return res;
    }

    // 8. Gross Structural Edge & Profitability Floor Evaluation
    const structuralTarget = boxMid;
    const grossStructuralEdgePct = Math.abs(structuralTarget - entryPx) / entryPx;

    if (grossStructuralEdgePct < profitabilityFloorPct - 1e-8) {
        const res: EthRangeEntryFeasibilityResult = {
            entryAllowed: false,
            blocked: true,
            blockReason: "ETH_RANGE_ENTRY_INSUFFICIENT_PROFIT_SPACE",
            symbol,
            side,
            regime: regimeStr,
            subtype: subtypeStr || null,
            entry_price: entryPx,
            box_high: boxHigh,
            box_low: boxLow,
            box_mid: boxMid,
            box_width_pct: boxWidthPct,
            structural_target: structuralTarget,
            structural_target_source: "box_mid",
            gross_structural_edge_pct: grossStructuralEdgePct,
            profitability_floor_pct: profitabilityFloorPct,
            fee_component_pct: feeComponentPct,
            slippage_component_pct: slippageComponentPct,
            required_net_edge_pct: requiredNetEdgePct,
            directional_space_valid: true,
            box_width_sufficient: true,
            profitability_passed: false
        };
        emitLog(res);
        return res;
    }

    // Pass through evaluateTpProfitabilityAuthority as extra verification
    const authorityEval = evaluateTpProfitabilityAuthority({
        symbol: "ETHUSDT",
        side,
        regime: "RANGE",
        entryPrice: entryPx,
        canonicalTp1Price: structuralTarget,
        canonicalTp1Source: "box_mid",
        feeRate,
        paperSlippageEstimateBps: slippageBps,
        minimumNetProfitPct: requiredNetEdgePct,
        tickSz
    });

    if (!authorityEval.entryAllowed) {
        const res: EthRangeEntryFeasibilityResult = {
            entryAllowed: false,
            blocked: true,
            blockReason: "ETH_RANGE_ENTRY_INSUFFICIENT_PROFIT_SPACE",
            symbol,
            side,
            regime: regimeStr,
            subtype: subtypeStr || null,
            entry_price: entryPx,
            box_high: boxHigh,
            box_low: boxLow,
            box_mid: boxMid,
            box_width_pct: boxWidthPct,
            structural_target: structuralTarget,
            structural_target_source: "box_mid",
            gross_structural_edge_pct: grossStructuralEdgePct,
            profitability_floor_pct: profitabilityFloorPct,
            fee_component_pct: feeComponentPct,
            slippage_component_pct: slippageComponentPct,
            required_net_edge_pct: requiredNetEdgePct,
            directional_space_valid: true,
            box_width_sufficient: true,
            profitability_passed: false
        };
        emitLog(res);
        return res;
    }

    // All Feasibility Checks Passed!
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
        structural_target: structuralTarget,
        structural_target_source: "box_mid",
        gross_structural_edge_pct: grossStructuralEdgePct,
        profitability_floor_pct: profitabilityFloorPct,
        fee_component_pct: feeComponentPct,
        slippage_component_pct: slippageComponentPct,
        required_net_edge_pct: requiredNetEdgePct,
        directional_space_valid: true,
        box_width_sufficient: true,
        profitability_passed: true
    };
    emitLog(successRes);
    return successRes;
}
