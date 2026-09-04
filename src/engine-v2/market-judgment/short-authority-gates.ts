import { Candle } from "../../models/types";

export interface BtcShortMacroBullGateInput {
    symbol: string;
    candidateSide: "long" | "short" | string;
    htf1hBias?: string | null;
    htf4hBias?: string | null;
    directionalShockState?: string | null;
}

export interface BtcShortMacroBullGateResult {
    blocked: boolean;
    reason: string | null;
    symbol: string;
    candidateSide: string;
    htf1hBias: string;
    htf4hBias: string;
    directionalShockState: string;
}

/**
 * BTCUSDT SHORT Macro Bull Countertrend Gate.
 * Blocks SHORT entries when macro HTF 1H and 4H are both BULLISH and no DOWN shock is present.
 */
export function evaluateBtcShortMacroBullGate(
    input: BtcShortMacroBullGateInput
): BtcShortMacroBullGateResult {
    const symbol = String(input.symbol ?? "").toUpperCase();
    const candidateSide = String(input.candidateSide ?? "").toLowerCase();
    const h1 = String(input.htf1hBias ?? "").toUpperCase();
    const h4 = String(input.htf4hBias ?? "").toUpperCase();
    const dss = String(input.directionalShockState ?? "NONE").toUpperCase();

    const htf1hBias = h1.includes("BULL") ? "BULLISH" : "BEARISH";
    const htf4hBias = h4.includes("BULL") ? "BULLISH" : "BEARISH";

    const btcShortMacroBullBlocked =
        symbol === "BTCUSDT" &&
        candidateSide === "short" &&
        htf1hBias === "BULLISH" &&
        htf4hBias === "BULLISH" &&
        dss !== "DOWN";

    const reason = btcShortMacroBullBlocked
        ? "BTC_SHORT_MACRO_BULL_COUNTERTREND_BLOCKED"
        : null;

    if (symbol === "BTCUSDT" && candidateSide === "short") {
        console.info(
            JSON.stringify({
                event: "V2_BTC_SHORT_MACRO_BULL_GATE_PROOF",
                symbol: "BTCUSDT",
                candidate_side: candidateSide,
                htf_1h_bias: htf1hBias,
                htf_4h_bias: htf4hBias,
                directional_shock_state: dss,
                blocked: btcShortMacroBullBlocked,
                reason
            })
        );
    }

    return {
        blocked: btcShortMacroBullBlocked,
        reason,
        symbol,
        candidateSide,
        htf1hBias,
        htf4hBias,
        directionalShockState: dss
    };
}

export interface EthShortLocationRrGateInput {
    symbol: string;
    candidateSide: "long" | "short" | string;
    entryPrice: number;
    boxPos?: number | null;
    structuralStopPrice?: number | null;
    structuralStopSource?: string | null;
    continuationTargetPrice?: number | null;
    continuationTargetSource?: string | null;
    candles?: Candle[] | null;
    ema20?: number | null;
    atr?: number | null;
    retestConfirmed?: boolean | null;
}

export interface EthShortLocationRrGateResult {
    blocked: boolean;
    reason: string | null;
    symbol: string;
    candidateSide: string;
    boxPos: number | null;
    retestSeen: boolean;
    entryPrice: number;
    structuralStopPrice: number | null;
    structuralStopSource: string | null;
    continuationTargetPrice: number | null;
    continuationTargetSource: string | null;
    rrEvaluable: boolean;
    rrNotEvaluableReason: string | null;
    structuralSlDist: number | null;
    remainingTpContinuationDist: number | null;
    rrRatio: number | null;
    locationExhausted: boolean;
    rrCollapsed: boolean;
}

/**
 * Checks recent candles (last 5) for retest or rejection evidence:
 * - Upper rejection wick >= 40% of candle range
 * - Price returned to within 0.3 ATR of EMA20
 */
export function checkRetestOrRejectionSeen(
    candles?: Candle[] | null,
    ema20?: number | null,
    atr?: number | null
): boolean {
    if (!candles || candles.length === 0) return false;
    const recent = candles.slice(-5);
    const effAtr = typeof atr === "number" && atr > 0 ? atr : 1.0;

    for (const c of recent) {
        const h = Number(c.high ?? 0);
        const l = Number(c.low ?? 0);
        const o = Number(c.open ?? 0);
        const cl = Number(c.close ?? 0);
        const rng = h - l;
        if (rng > 0) {
            const upperWick = h - Math.max(o, cl);
            if (upperWick / rng >= 0.40) {
                return true;
            }
        }
        if (typeof ema20 === "number" && ema20 > 0) {
            if (Math.abs(h - ema20) <= effAtr * 0.30) {
                return true;
            }
        }
    }
    return false;
}

/**
 * ETHUSDT SHORT Location / RR Gate.
 * Evaluates two independent authorities:
 * 1. Location Exhaustion: boxPos <= 0.38 && retestSeen === false
 * 2. RR Collapse: Evaluated ONLY when canonical structural stop and continuation target exist,
 *    with stop > entry and target < entry for SHORT.
 *    If provenance is missing, rrEvaluable = false, rrCollapsed = false (falls through to downstream risk authority).
 */
export function evaluateEthShortLocationRrGate(
    input: EthShortLocationRrGateInput
): EthShortLocationRrGateResult {
    const symbol = String(input.symbol ?? "").toUpperCase();
    const candidateSide = String(input.candidateSide ?? "").toLowerCase();
    const isEthShort = symbol === "ETHUSDT" && candidateSide === "short";

    const entryPrice = typeof input.entryPrice === "number" && Number.isFinite(input.entryPrice) && input.entryPrice > 0
        ? input.entryPrice
        : 0;

    const boxPos = typeof input.boxPos === "number" && Number.isFinite(input.boxPos)
        ? input.boxPos
        : null;

    const retestSeen = typeof input.retestConfirmed === "boolean"
        ? input.retestConfirmed
        : checkRetestOrRejectionSeen(input.candles, input.ema20, input.atr);

    // 1. Location Exhausted Authority (independent of RR provenance)
    const ethShortLocationExhausted =
        isEthShort &&
        boxPos !== null &&
        boxPos <= 0.38 &&
        retestSeen === false;

    // 2. RR Collapsed Authority (strictly requires canonical provenance)
    const stopPx = typeof input.structuralStopPrice === "number" && Number.isFinite(input.structuralStopPrice) && input.structuralStopPrice > 0
        ? input.structuralStopPrice
        : null;
    const stopSource = input.structuralStopSource ?? (stopPx !== null ? "canonical" : null);

    const targetPx = typeof input.continuationTargetPrice === "number" && Number.isFinite(input.continuationTargetPrice) && input.continuationTargetPrice > 0
        ? input.continuationTargetPrice
        : null;
    const targetSource = input.continuationTargetSource ?? (targetPx !== null ? "canonical" : null);

    let rrEvaluable = false;
    let rrNotEvaluableReason: string | null = null;
    let structuralSlDist: number | null = null;
    let remainingTpContinuationDist: number | null = null;
    let rrRatio: number | null = null;
    let ethShortRrCollapsed = false;

    if (!isEthShort) {
        rrNotEvaluableReason = "NOT_ETH_SHORT";
    } else if (stopPx === null) {
        rrNotEvaluableReason = "MISSING_CANONICAL_STOP";
    } else if (targetPx === null) {
        rrNotEvaluableReason = "MISSING_CANONICAL_TARGET";
    } else if (!(entryPrice > 0)) {
        rrNotEvaluableReason = "INVALID_ENTRY_PRICE";
    } else if (!(stopPx > entryPrice)) {
        rrNotEvaluableReason = "STOP_NOT_ABOVE_ENTRY";
    } else if (!(targetPx < entryPrice)) {
        rrNotEvaluableReason = "TARGET_NOT_BELOW_ENTRY";
    } else {
        rrEvaluable = true;
        structuralSlDist = stopPx - entryPrice;
        remainingTpContinuationDist = entryPrice - targetPx;
        rrRatio = structuralSlDist / remainingTpContinuationDist;
        ethShortRrCollapsed = structuralSlDist > 1.5 * remainingTpContinuationDist;
    }

    const ethShortLocationBlocked = isEthShort && (ethShortLocationExhausted || ethShortRrCollapsed);

    let reason: string | null = null;
    if (ethShortLocationExhausted && ethShortRrCollapsed) {
        reason = "ETH_SHORT_LOCATION_AND_RR_BLOCKED";
    } else if (ethShortLocationExhausted) {
        reason = "ETH_SHORT_LOCATION_EXHAUSTED_BLOCKED";
    } else if (ethShortRrCollapsed) {
        reason = "ETH_SHORT_RR_COLLAPSED_BLOCKED";
    }

    if (isEthShort) {
        console.info(
            JSON.stringify({
                event: "V2_ETH_SHORT_LOCATION_RR_GATE_PROOF",
                symbol: "ETHUSDT",
                candidate_side: candidateSide,
                box_pos: boxPos,
                retest_seen: retestSeen,
                entry_price: entryPrice,
                structural_stop_price: stopPx,
                structural_stop_source: stopSource,
                continuation_target_price: targetPx,
                continuation_target_source: targetSource,
                rr_evaluable: rrEvaluable,
                rr_not_evaluable_reason: rrNotEvaluableReason,
                structural_sl_dist: structuralSlDist,
                remaining_tp_continuation_dist: remainingTpContinuationDist,
                rr_ratio: rrRatio,
                location_exhausted: ethShortLocationExhausted,
                rr_collapsed: ethShortRrCollapsed,
                blocked: ethShortLocationBlocked,
                reason
            })
        );
    }

    return {
        blocked: ethShortLocationBlocked,
        reason,
        symbol,
        candidateSide,
        boxPos,
        retestSeen,
        entryPrice,
        structuralStopPrice: stopPx,
        structuralStopSource: stopSource,
        continuationTargetPrice: targetPx,
        continuationTargetSource: targetSource,
        rrEvaluable,
        rrNotEvaluableReason,
        structuralSlDist,
        remainingTpContinuationDist,
        rrRatio,
        locationExhausted: ethShortLocationExhausted,
        rrCollapsed: ethShortRrCollapsed
    };
}
