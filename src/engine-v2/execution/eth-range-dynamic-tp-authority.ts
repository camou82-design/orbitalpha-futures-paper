import { evaluateTpProfitabilityAuthority } from "./tp-profitability-authority";
import type { MarketRegime } from "../../strategy/market-regime-detector";

export interface EthRangeDynamicTpInput {
    symbol: string;
    side: "long" | "short";
    entryPrice: number;
    currentPrice?: number | null;
    regime: string;
    marketSubtype?: string | null;
    boxHigh?: number | null;
    boxLow?: number | null;
    boxMid?: number | null;
    atr?: number | null;
    previousCanonicalTp?: number | null;
    feeRate?: number;
    paperSlippageEstimateBps?: number;
    tickSz?: number;
    // Ownership & lifecycle flags
    lifecycleState?: string | null;
    manualTakeoverActive?: boolean;
    manualOwnershipLatch?: boolean;
    userManuallyModifiedTp?: boolean;
    // In-flight Regime Transition
    previousRegime?: string | null;
    regimeConsecutiveEvaluations?: number;
    regimeCandleAdvanceCount?: number;
    emitProof?: boolean;
}

export interface EthRangeDynamicTpResult {
    dynamicTpApplied: boolean;
    finalTp: number;
    dynamicTpCandidate: number | null;
    previousCanonicalTp: number | null;
    profitabilityFloor: number | null;
    profitabilityPassed: boolean;
    regimeTransition: string | null;
    rejectionReason: string | null;
    ownershipOrLifecycleAuthority: string;
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

/** Minimum net edge percentage after all fees and slippage floor (0.015% = 1.5 bps). */
export const ETH_RANGE_MIN_NET_EDGE_PCT = 0.00015;

/** Minimum profit distance multiple of ATR for range mean reversion floor. */
export const ETH_RANGE_MIN_PROFIT_ATR_MULT = 0.35;

/** Maximum TP distance multiple of ATR (cap at 2.0x ATR). */
export const ETH_RANGE_MAX_TP_ATR_MULT = 2.0;

/**
 * Evaluates whether ETHUSDT in RANGE / FLAT / LOW-VOL should dynamically adjust its TP1
 * to an achievable mean-reversion target (boxMid) instead of an unreachable far static TP.
 *
 * Strict invariants:
 * 1. ETHUSDT only (BTCUSDT is strictly bypassed).
 * 2. Strict OPERATOR_MANAGED / manual takeover bypass.
 * 3. Wrong-side boxMid: LONG requires boxMid > entryPrice, SHORT requires boxMid < entryPrice.
 *    If wrong-side, do NOT fabricate synthetic target; keep canonical TP.
 * 4. Profitability floor must be passed (cannot be closer than round-trip fees + slippage + min net edge).
 *    minProfitDist is purely a validation floor, never a synthetic target creator.
 * 5. In-flight regime transition requires >= 2 consecutive evaluations AND >= 1 candle advance.
 */
export function evaluateEthRangeDynamicTpAuthority(
    input: EthRangeDynamicTpInput
): EthRangeDynamicTpResult {
    const symbol = String(input.symbol ?? "").toUpperCase();
    const side = input.side;
    const entryPx = Number(input.entryPrice ?? 0);
    const currPx = typeof input.currentPrice === "number" && Number.isFinite(input.currentPrice) && input.currentPrice > 0
        ? input.currentPrice
        : entryPx;
    const prevTp = typeof input.previousCanonicalTp === "number" && Number.isFinite(input.previousCanonicalTp) && input.previousCanonicalTp > 0
        ? input.previousCanonicalTp
        : 0;
    const tickSz = typeof input.tickSz === "number" && input.tickSz > 0 ? input.tickSz : 0.01;
    const feeRate = typeof input.feeRate === "number" && input.feeRate > 0 ? input.feeRate : 0.0005;
    const slippageBps = typeof input.paperSlippageEstimateBps === "number" ? input.paperSlippageEstimateBps : 8;

    const ls = String(input.lifecycleState ?? "");
    const isOperatorManaged =
        ls === "OPERATOR_MANAGED" ||
        ls === "EXTERNAL_MANUAL_POSITION" ||
        input.manualTakeoverActive === true ||
        input.manualOwnershipLatch === true ||
        input.userManuallyModifiedTp === true;

    const ownershipOrLifecycleAuthority = isOperatorManaged
        ? "OPERATOR_MANAGED"
        : (ls.length > 0 ? ls : "BOT_V2_MANAGED");

    // Helper to format and emit result
    const makeResult = (
        applied: boolean,
        finalTp: number,
        candidate: number | null,
        rejectionReason: string | null,
        profFloor: number | null = null,
        profPassed: boolean = false,
        regimeTransition: string | null = null
    ): EthRangeDynamicTpResult => {
        const res: EthRangeDynamicTpResult = {
            dynamicTpApplied: applied,
            finalTp,
            dynamicTpCandidate: candidate,
            previousCanonicalTp: prevTp > 0 ? prevTp : null,
            profitabilityFloor: profFloor,
            profitabilityPassed: profPassed,
            regimeTransition,
            rejectionReason,
            ownershipOrLifecycleAuthority
        };

        if (input.emitProof !== false && symbol === "ETHUSDT") {
            console.info(
                JSON.stringify({
                    event: "V2_ETH_RANGE_DYNAMIC_TP_AUTHORITY_PROOF",
                    symbol,
                    side,
                    regime: input.regime,
                    market_subtype: input.marketSubtype ?? null,
                    entry_price: entryPx,
                    current_price: currPx,
                    box_high: input.boxHigh ?? null,
                    box_low: input.boxLow ?? null,
                    box_mid: input.boxMid ?? null,
                    atr: input.atr ?? null,
                    previous_canonical_tp: res.previousCanonicalTp,
                    dynamic_tp_candidate: res.dynamicTpCandidate,
                    final_tp: res.finalTp,
                    profitability_floor: res.profitabilityFloor,
                    profitability_passed: res.profitabilityPassed,
                    regime_transition: res.regimeTransition,
                    dynamic_tp_applied: res.dynamicTpApplied,
                    rejection_reason: res.rejectionReason,
                    ownership_or_lifecycle_authority: res.ownershipOrLifecycleAuthority
                })
            );
        }

        return res;
    };

    // 1. Symbol Scope: ETHUSDT only
    if (symbol !== "ETHUSDT") {
        return makeResult(false, prevTp, null, "SYMBOL_NOT_ETHUSDT");
    }

    // 2. Strict Operational Bypass
    if (isOperatorManaged) {
        return makeResult(false, prevTp, null, "OPERATOR_OR_MANUAL_MANAGED_BYPASS");
    }

    // 3. Regime / Subtype Validation
    const regimeStr = String(input.regime ?? "").toUpperCase();
    const subtypeStr = String(input.marketSubtype ?? "").trim().toUpperCase();

    if (regimeStr === "TREND") {
        return makeResult(false, prevTp, null, "TREND_REGIME_UNCHANGED");
    }

    if (CONFIRMED_BREAKOUT_SUBTYPES.has(subtypeStr) || /BREAKOUT.*CONFIRMED/i.test(subtypeStr) || /BREAKDOWN.*CONFIRMED/i.test(subtypeStr)) {
        return makeResult(false, prevTp, null, "CONFIRMED_BREAKOUT_UNCHANGED");
    }

    if (SHOCK_OR_EMERGENCY_SUBTYPES.has(subtypeStr) || subtypeStr.startsWith("SHOCK_REACTION") || subtypeStr.includes("FAST_TREND_SHIFT")) {
        return makeResult(false, prevTp, null, "SHOCK_OR_EMERGENCY_UNCHANGED");
    }

    if (regimeStr !== "RANGE" && regimeStr !== "NO_TRADE") {
        return makeResult(false, prevTp, null, "NON_RANGE_REGIME_BYPASS");
    }

    // 4. Authoritative Box & Volatility Validation
    const boxHigh = typeof input.boxHigh === "number" && Number.isFinite(input.boxHigh) ? input.boxHigh : null;
    const boxLow = typeof input.boxLow === "number" && Number.isFinite(input.boxLow) ? input.boxLow : null;
    const atr = typeof input.atr === "number" && Number.isFinite(input.atr) && input.atr > 0 ? input.atr : null;

    if (boxHigh === null || boxLow === null || !(boxHigh > boxLow) || atr === null || !(entryPx > 0)) {
        return makeResult(false, prevTp, null, "BOX_OR_ATR_DATA_UNAVAILABLE");
    }

    const boxMid = typeof input.boxMid === "number" && Number.isFinite(input.boxMid) && input.boxMid > 0
        ? input.boxMid
        : (boxHigh + boxLow) / 2;

    // 5. Wrong-side boxMid check:
    // LONG: boxMid <= entryPx -> reject (cannot mean-revert upwards to a level below or at entry)
    // SHORT: boxMid >= entryPx -> reject (cannot mean-revert downwards to a level above or at entry)
    // In this case, DO NOT synthesize an artificial target (entry ± minProfitDist); keep canonical TP!
    if (side === "long" && boxMid <= entryPx) {
        return makeResult(false, prevTp, null, "WRONG_SIDE_BOX_MID_REJECTED");
    }
    if (side === "short" && boxMid >= entryPx) {
        return makeResult(false, prevTp, null, "WRONG_SIDE_BOX_MID_REJECTED");
    }

    // 6. Compute Dynamic Candidate Target strictly based on boxMid (bounded by max ATR cap and canonical TP)
    const maxTpDistance = atr * ETH_RANGE_MAX_TP_ATR_MULT;
    let dynamicCandidate: number;

    if (side === "long") {
        // Upper bound: cap at entryPx + maxTpDistance
        const cappedTarget = Math.min(boxMid, entryPx + maxTpDistance);
        dynamicCandidate = Math.round(cappedTarget / tickSz) * tickSz;
        // Never farther than existing canonical TP
        if (prevTp > entryPx && dynamicCandidate > prevTp) {
            dynamicCandidate = prevTp;
        }
    } else {
        // Lower bound: cap at entryPx - maxTpDistance
        const cappedTarget = Math.max(boxMid, entryPx - maxTpDistance);
        dynamicCandidate = Math.round(cappedTarget / tickSz) * tickSz;
        // Never farther than existing canonical TP
        if (prevTp > 0 && prevTp < entryPx && dynamicCandidate < prevTp) {
            dynamicCandidate = prevTp;
        }
    }

    // Direction validation
    if (side === "long" && !(dynamicCandidate > entryPx)) {
        return makeResult(false, prevTp, dynamicCandidate, "DYNAMIC_TP_DIRECTION_INVALID");
    }
    if (side === "short" && !(dynamicCandidate < entryPx)) {
        return makeResult(false, prevTp, dynamicCandidate, "DYNAMIC_TP_DIRECTION_INVALID");
    }

    // 7. Profitability Floor Evaluation
    // Round-trip taker fee + slippage + minimal net edge
    const roundTripFeePct = feeRate * 2;
    const slippageCostPct = slippageBps / 10000;
    const minRequiredDistPct = roundTripFeePct + slippageCostPct + ETH_RANGE_MIN_NET_EDGE_PCT;
    const feeFloorDist = entryPx * minRequiredDistPct;
    const minProfitDist = Math.max(atr * ETH_RANGE_MIN_PROFIT_ATR_MULT, feeFloorDist);
    const candidateDist = Math.abs(dynamicCandidate - entryPx);

    const profFloorPrice = side === "long"
        ? Math.round((entryPx + minProfitDist) / tickSz) * tickSz
        : Math.round((entryPx - minProfitDist) / tickSz) * tickSz;

    // Reject if below profitability floor — DO NOT force/fabricate target to meet the floor!
    if (candidateDist < minProfitDist - 1e-8) {
        return makeResult(
            false,
            prevTp,
            dynamicCandidate,
            "BELOW_PROFITABILITY_FLOOR",
            profFloorPrice,
            false
        );
    }

    // Pass through evaluateTpProfitabilityAuthority as extra invariant
    const authorityEval = evaluateTpProfitabilityAuthority({
        symbol: "ETHUSDT",
        side,
        regime: "RANGE",
        entryPrice: entryPx,
        canonicalTp1Price: dynamicCandidate,
        canonicalTp1Source: "eth_range_dynamic_tp",
        feeRate,
        paperSlippageEstimateBps: slippageBps,
        minimumNetProfitPct: ETH_RANGE_MIN_NET_EDGE_PCT,
        tickSz
    });

    if (!authorityEval.entryAllowed) {
        return makeResult(
            false,
            prevTp,
            dynamicCandidate,
            authorityEval.blockReason ?? "TP_PROFITABILITY_REJECTED",
            profFloorPrice,
            false
        );
    }

    // 8. In-Flight Regime Transition Hysteresis Check
    let regimeTransitionLabel: string | null = null;
    const prevReg = String(input.previousRegime ?? "").toUpperCase();
    if (prevReg === "TREND" && regimeStr === "RANGE") {
        const consecutiveEvals = Number(input.regimeConsecutiveEvaluations ?? 0);
        const candleAdvances = Number(input.regimeCandleAdvanceCount ?? 0);
        if (consecutiveEvals < 2 || candleAdvances < 1) {
            return makeResult(
                false,
                prevTp,
                dynamicCandidate,
                "REGIME_HYSTERESIS_UNCONFIRMED",
                profFloorPrice,
                true,
                "TREND_TO_RANGE_UNCONFIRMED"
            );
        }
        regimeTransitionLabel = "TREND_TO_RANGE_CONFIRMED";
    }

    return makeResult(
        true,
        dynamicCandidate,
        dynamicCandidate,
        null,
        profFloorPrice,
        true,
        regimeTransitionLabel
    );
}

/**
 * Resolves in-flight TP for open ETH positions experiencing regime transitions.
 * - TREND -> RANGE (confirmed with >= 2 consecutive evaluations AND >= 1 candle advance): reduces far TP to achievable Dynamic TP.
 * - RANGE -> TREND (confirmed with >= 2 consecutive evaluations AND >= 1 candle advance): restores full trend TP authority.
 * - Same-candle repeated evaluations (< 1 candle advance) or single evaluation (< 2 evaluations): keeps previous TP unchanged.
 */
export function resolveEthInFlightRegimeTransitionTp(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    entryPrice: number;
    currentPrice: number;
    currentRegime: string;
    previousRegime: string;
    regimeConsecutiveEvaluations: number;
    regimeCandleAdvanceCount: number;
    currentTp: number;
    trendTp: number;
    boxHigh?: number | null;
    boxLow?: number | null;
    boxMid?: number | null;
    atr?: number | null;
    lifecycleState?: string | null;
    manualTakeoverActive?: boolean;
    manualOwnershipLatch?: boolean;
    userManuallyModifiedTp?: boolean;
}>): {
    updated: boolean;
    newTp: number;
    reason: string;
} {
    const symbol = String(input.symbol ?? "").toUpperCase();
    if (symbol !== "ETHUSDT") {
        return { updated: false, newTp: input.currentTp, reason: "SYMBOL_NOT_ETHUSDT" };
    }

    const ls = String(input.lifecycleState ?? "");
    if (
        ls === "OPERATOR_MANAGED" ||
        ls === "EXTERNAL_MANUAL_POSITION" ||
        input.manualTakeoverActive === true ||
        input.manualOwnershipLatch === true ||
        input.userManuallyModifiedTp === true
    ) {
        return { updated: false, newTp: input.currentTp, reason: "OPERATOR_OR_MANUAL_MANAGED_BYPASS" };
    }

    const curReg = String(input.currentRegime ?? "").toUpperCase();
    const prevReg = String(input.previousRegime ?? "").toUpperCase();

    // Hysteresis: Require at least 2 consecutive authoritative evaluations AND at least 1 candle advance
    if (input.regimeConsecutiveEvaluations < 2 || input.regimeCandleAdvanceCount < 1) {
        return { updated: false, newTp: input.currentTp, reason: "REGIME_HYSTERESIS_UNCONFIRMED" };
    }

    // 1. TREND -> RANGE Confirmed: Reduce to dynamic range TP
    if (prevReg === "TREND" && curReg === "RANGE") {
        const dynRes = evaluateEthRangeDynamicTpAuthority({
            symbol: "ETHUSDT",
            side: input.side,
            entryPrice: input.entryPrice,
            currentPrice: input.currentPrice,
            regime: "RANGE",
            boxHigh: input.boxHigh,
            boxLow: input.boxLow,
            boxMid: input.boxMid,
            atr: input.atr,
            previousCanonicalTp: input.currentTp,
            previousRegime: prevReg,
            regimeConsecutiveEvaluations: input.regimeConsecutiveEvaluations,
            regimeCandleAdvanceCount: input.regimeCandleAdvanceCount,
            lifecycleState: input.lifecycleState,
            manualTakeoverActive: input.manualTakeoverActive,
            manualOwnershipLatch: input.manualOwnershipLatch,
            userManuallyModifiedTp: input.userManuallyModifiedTp
        });

        if (dynRes.dynamicTpApplied && dynRes.finalTp > 0) {
            return {
                updated: true,
                newTp: dynRes.finalTp,
                reason: "TREND_TO_RANGE_TP_REDUCED"
            };
        }
        return {
            updated: false,
            newTp: input.currentTp,
            reason: dynRes.rejectionReason ?? "DYNAMIC_TP_REJECTED"
        };
    }

    // 2. RANGE -> TREND Confirmed: Restore trend TP authority
    if (prevReg === "RANGE" && curReg === "TREND") {
        if (input.trendTp > 0 && input.trendTp !== input.currentTp) {
            return {
                updated: true,
                newTp: input.trendTp,
                reason: "RANGE_TO_TREND_TP_RESTORED"
            };
        }
    }

    return { updated: false, newTp: input.currentTp, reason: "NO_TRANSITION_ACTION_NEEDED" };
}
