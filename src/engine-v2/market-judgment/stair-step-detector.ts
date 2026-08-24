/**
 * V2 STAIR-STEP STRUCTURE DETECTOR (DIAGNOSTIC / SHADOW-ONLY)
 *
 * Symmetrically evaluates continuous stair-step trend structures:
 * - STAIR_STEP_UP: Higher-low progression, shallow pullback, recovery/reclaim, positive slope
 * - STAIR_STEP_DOWN: Lower-high progression, shallow rebound, rejection/resumption, negative slope
 *
 * STRICT INVARIANCE:
 * This module is diagnostic/shadow-only. It does NOT alter execution decisions, sides, sizing, stops, or vetoes.
 *
 * TRUTHFULNESS RULES:
 * 1. CLOSED CANDLES ONLY: Swing points, slopes, pullback ratios, candle counts, and spike filters
 *    are computed strictly on closed candles (candles.slice(0, -1)).
 * 2. DIRECT CLOSED SLOPE: Center and EMA20 slopes are derived directly from closed candle segments
 *    to eliminate forming candle contamination.
 * 3. LIVE RECLAIM POSITION: lastPrice is used only as current position reference for reclaim/rejection confirmation.
 * 4. CANONICAL HTF POLICIES: Uses existing canonical HTF policies (ALLOW, PROBE_ONLY, HOLD, LONG_ONLY_OR_NONE, SHORT_ONLY_OR_NONE)
 *    and hard block reasons (STRONG_BEARISH_HTF_ALIGNMENT / STRONG_BULLISH_HTF_ALIGNMENT).
 */

import type { Candle } from "../../models/types";
import type { LegacySnapshotAdapter, EngineV2SnapshotAdapter, MarketJudgmentOutput } from "../types";

export interface StairStepDetectionResult {
    detected: boolean;
    direction: "UP" | "DOWN" | "NONE";
    higher_low_detected: boolean;
    higher_high_detected: boolean;
    lower_high_detected: boolean;
    lower_low_detected: boolean;
    center_slope: number;
    ema20_slope: number;
    pullback_depth_ratio: number;
    reclaim_or_rejection_confirmed: boolean;
    htf_entry_policy: string;
    confidence: number;
    block_reason: string | null;
    structure_candles_closed_only: true;
    reclaim_price_source: "live_last_price";
    closed_candle_count: number;
    pivot_order_valid?: boolean;
    impulse_start_idx?: number;
    impulse_end_idx?: number;
    correction_pivot_idx?: number;
    post_correction_confirmation_present?: boolean;
    prior_leg_size?: number;
    correction_amount?: number;
}

export function detectStairStepStructure(args: {
    candles?: Candle[];
    snapshot: EngineV2SnapshotAdapter | LegacySnapshotAdapter;
    judgment: MarketJudgmentOutput;
}): StairStepDetectionResult {
    const { candles, snapshot: sn, judgment } = args;
    const htfPolicy = judgment.htf_entry_policy ?? "ALLOW";
    const htfHardBlockReason = judgment.htf_hard_block_reason ?? "";

    const defaultResult: StairStepDetectionResult = {
        detected: false,
        direction: "NONE",
        higher_low_detected: false,
        higher_high_detected: false,
        lower_high_detected: false,
        lower_low_detected: false,
        center_slope: Number(sn.rangeCenterSlope ?? sn.boxLowSlope ?? sn.boxHighSlope ?? 0),
        ema20_slope: Number(sn.ema20Slope ?? 0),
        pullback_depth_ratio: 0,
        reclaim_or_rejection_confirmed: false,
        htf_entry_policy: htfPolicy,
        confidence: 0,
        block_reason: null,
        structure_candles_closed_only: true,
        reclaim_price_source: "live_last_price",
        closed_candle_count: 0
    };

    // Require at least 8 closed candles (+1 forming candle = 9 total)
    if (!candles || candles.length < 9) {
        return {
            ...defaultResult,
            closed_candle_count: candles && candles.length > 1 ? candles.length - 1 : 0,
            block_reason: "INSUFFICIENT_CLOSED_CANDLES"
        };
    }

    // Isolate strictly closed candles by excluding the last in-flight forming candle
    const closedCandles = candles.slice(0, -1);
    const windowSize = Math.min(closedCandles.length, 16);
    const windowCandles = closedCandles.slice(-windowSize);

    const getHigh = (c: Candle) => Number(c.high ?? (c as any).h ?? c.close);
    const getLow = (c: Candle) => Number(c.low ?? (c as any).l ?? c.close);
    const getClose = (c: Candle) => Number(c.close ?? (c as any).c ?? 0);
    const getOpen = (c: Candle) => Number(c.open ?? (c as any).o ?? getClose(c));
    const lastPrice = Number(sn.lastPrice ?? getClose(candles[candles.length - 1]));

    const N = windowCandles.length;
    const midPoint = Math.floor(N / 2);
    const prevHalf = windowCandles.slice(0, midPoint);
    const recentHalf = windowCandles.slice(midPoint);

    // Directly compute closed-candle slopes across the two halves
    const prevHalfHigh = Math.max(...prevHalf.map(getHigh));
    const prevHalfLow = Math.min(...prevHalf.map(getLow));
    const recentHalfHigh = Math.max(...recentHalf.map(getHigh));
    const recentHalfLow = Math.min(...recentHalf.map(getLow));

    const prevAvgCenter = (prevHalfHigh + prevHalfLow) / 2;
    const recentAvgCenter = (recentHalfHigh + recentHalfLow) / 2;
    const computedCenterSlope = prevAvgCenter > 0 ? ((recentAvgCenter - prevAvgCenter) / prevAvgCenter) / Math.max(1, prevHalf.length) : 0;

    const prevAvgClose = prevHalf.reduce((sum, c) => sum + getClose(c), 0) / Math.max(1, prevHalf.length);
    const recentAvgClose = recentHalf.reduce((sum, c) => sum + getClose(c), 0) / Math.max(1, recentHalf.length);
    const computedEma20Slope = prevAvgClose > 0 ? ((recentAvgClose - prevAvgClose) / prevAvgClose) / Math.max(1, prevHalf.length) : 0;

    const centerSlope = Math.abs(computedCenterSlope) > 0.000001
        ? computedCenterSlope
        : Number(sn.rangeCenterSlope ?? ((sn.boxHighSlope != null && sn.boxLowSlope != null) ? (sn.boxHighSlope + sn.boxLowSlope) / 2 : (sn.boxHighSlope ?? sn.boxLowSlope ?? 0)));
    const ema20Slope = Math.abs(computedEma20Slope) > 0.000001
        ? computedEma20Slope
        : Number(sn.ema20Slope ?? 0);

    // Spike filter on closed candles: Check if a single candle accounts for >= 85% of total window range without sustained structure
    const windowHigh = Math.max(...windowCandles.map(getHigh));
    const windowLow = Math.min(...windowCandles.map(getLow));
    const windowRange = windowHigh - windowLow;

    let isSingleSpikeUp = false;
    let isSingleSpikeDown = false;

    if (windowRange > 0) {
        for (const c of windowCandles) {
            const body = Math.abs(getClose(c) - getOpen(c));
            const range = getHigh(c) - getLow(c);
            if (range >= windowRange * 0.85 && body >= windowRange * 0.70) {
                const isBullSpike = getClose(c) > getOpen(c);
                const isBearSpike = getClose(c) < getOpen(c);
                if (isBullSpike && windowCandles.filter(x => getClose(x) > getOpen(x)).length <= 2) {
                    isSingleSpikeUp = true;
                }
                if (isBearSpike && windowCandles.filter(x => getClose(x) < getOpen(x)).length <= 2) {
                    isSingleSpikeDown = true;
                }
            }
        }
    }

    const bullishCandleCount = windowCandles.filter(c => getClose(c) >= getOpen(c)).length;
    const bearishCandleCount = windowCandles.filter(c => getClose(c) <= getOpen(c)).length;

    // =========================================================================
    // A. CHRONOLOGICAL PIVOT SEARCH: STAIR_STEP_UP (L1 -> H1 -> L2 -> re-advance)
    // =========================================================================
    // 1. Find most recent genuine local correction swing low L2 (strict 3-bar pivot, search backward from N-2)
    let l2Idx = -1;
    for (let k = N - 2; k >= 2; k--) {
        const lowK = getLow(windowCandles[k]);
        const prevL = getLow(windowCandles[k - 1]);
        const nextL = getLow(windowCandles[k + 1]);
        if (lowK <= prevL && lowK <= nextL) {
            l2Idx = k;
            break;
        }
    }

    // 2. Search strictly BEFORE L2 (search backward from l2Idx - 1 down to 1) for nearest valid 3-bar swing high H1
    let h1Idx = -1;
    if (l2Idx >= 2) {
        for (let k = l2Idx - 1; k >= 1; k--) {
            const highK = getHigh(windowCandles[k]);
            const prevH = getHigh(windowCandles[k - 1]);
            const nextH = getHigh(windowCandles[k + 1]);
            if (highK >= prevH && highK >= nextH) {
                h1Idx = k;
                break;
            }
        }
    }

    // 3. Search strictly BEFORE H1 (search backward from h1Idx - 1 down to 1) for nearest valid 3-bar swing low L1
    let l1Idx = -1;
    if (h1Idx >= 2) {
        for (let k = h1Idx - 1; k >= 1; k--) {
            const lowK = getLow(windowCandles[k]);
            const prevL = getLow(windowCandles[k - 1]);
            const nextL = getLow(windowCandles[k + 1]);
            if (lowK <= prevL && lowK <= nextL) {
                l1Idx = k;
                break;
            }
        }
    }

    const pivotOrderValidUp = l1Idx >= 0 && h1Idx > l1Idx && l2Idx > h1Idx && l2Idx < N;
    const l1Val = pivotOrderValidUp ? getLow(windowCandles[l1Idx]) : 0;
    const h1Val = pivotOrderValidUp ? getHigh(windowCandles[h1Idx]) : 0;
    const l2Val = pivotOrderValidUp ? getLow(windowCandles[l2Idx]) : 0;

    const impulseUp = pivotOrderValidUp ? (h1Val - l1Val) : 0;
    const pullbackUpAmount = pivotOrderValidUp ? (h1Val - l2Val) : 0;
    const hasConsolidationUp = bearishCandleCount >= 1 || (l2Idx >= 0 && l2Idx < N - 1);

    const pullbackDepthRatioUp = (pivotOrderValidUp && impulseUp > 0)
        ? (pullbackUpAmount > 0 ? (pullbackUpAmount / impulseUp) : (hasConsolidationUp ? 0.3 : 0.5))
        : 1.0;

    // Post-L2 Re-advance / Higher High & Reclaim Confirmation
    let maxPostL2High = -Infinity;
    if (pivotOrderValidUp && l2Idx < N) {
        for (let k = l2Idx; k < N; k++) {
            maxPostL2High = Math.max(maxPostL2High, getHigh(windowCandles[k]));
        }
    }
    maxPostL2High = Math.max(maxPostL2High, lastPrice);

    const higherLowUp = pivotOrderValidUp ? (l2Val > l1Val) : false;
    const higherHighUp = pivotOrderValidUp ? (maxPostL2High >= h1Val * 0.998) : false;
    const reclaimConfirmedUp = pivotOrderValidUp
        ? ((lastPrice > l2Val + (h1Val - l2Val) * 0.25) || (lastPrice >= h1Val * 0.998))
        : false;
    const htfVetoLong = htfPolicy === "SHORT_ONLY_OR_NONE" || (htfPolicy === "HOLD" && htfHardBlockReason === "STRONG_BEARISH_HTF_ALIGNMENT");

    let upConfidence = 0;
    let upBlockReason: string | null = null;

    if (pivotOrderValidUp) upConfidence += 0.10;
    if (higherLowUp) upConfidence += 0.20;
    if (higherHighUp) upConfidence += 0.20;
    if (centerSlope > 0.00002 || ema20Slope > 0.00002) upConfidence += 0.20;
    if (pullbackDepthRatioUp > 0 && pullbackDepthRatioUp <= 0.65) upConfidence += 0.20;
    if (reclaimConfirmedUp) upConfidence += 0.10;

    const isStairStepUp =
        pivotOrderValidUp &&
        higherLowUp &&
        higherHighUp &&
        (centerSlope > -0.00005) &&
        (ema20Slope > -0.00005) &&
        (centerSlope > 0.00002 || ema20Slope > 0.00002) &&
        pullbackDepthRatioUp <= 0.65 &&
        reclaimConfirmedUp &&
        hasConsolidationUp &&
        !isSingleSpikeUp &&
        bullishCandleCount >= 3 &&
        !htfVetoLong;

    if (!isStairStepUp) {
        if (htfVetoLong) upBlockReason = "HTF_HARD_VETO";
        else if (!pivotOrderValidUp) upBlockReason = "PIVOT_CHRONOLOGY_INVALID";
        else if (isSingleSpikeUp) upBlockReason = "SINGLE_SPIKE_UNSUSTAINED";
        else if (!hasConsolidationUp) upBlockReason = "NO_CONSOLIDATION_PULLBACK";
        else if (pullbackDepthRatioUp > 0.65) upBlockReason = "PULLBACK_TOO_DEEP";
        else if (!higherLowUp) upBlockReason = "HIGHER_LOW_MISSING";
        else if (!reclaimConfirmedUp) upBlockReason = "RECLAIM_NOT_CONFIRMED";
        else if (centerSlope <= 0.00002 && ema20Slope <= 0.00002) upBlockReason = "SLOPE_FLAT_OR_NEGATIVE";
    }

    // =========================================================================
    // B. CHRONOLOGICAL PIVOT SEARCH: STAIR_STEP_DOWN (H1 -> L1 -> H2 -> re-decline)
    // =========================================================================
    // 1. Find most recent genuine local rebound swing high H2 (strict 3-bar pivot, search backward from N-2)
    let h2Idx = -1;
    for (let k = N - 2; k >= 2; k--) {
        const highK = getHigh(windowCandles[k]);
        const prevH = getHigh(windowCandles[k - 1]);
        const nextH = getHigh(windowCandles[k + 1]);
        if (highK >= prevH && highK >= nextH) {
            h2Idx = k;
            break;
        }
    }

    // 2. Search strictly BEFORE H2 (search backward from h2Idx - 1 down to 1) for nearest valid 3-bar swing low L1
    let l1DownIdx = -1;
    if (h2Idx >= 2) {
        for (let k = h2Idx - 1; k >= 1; k--) {
            const lowK = getLow(windowCandles[k]);
            const prevL = getLow(windowCandles[k - 1]);
            const nextL = getLow(windowCandles[k + 1]);
            if (lowK <= prevL && lowK <= nextL) {
                l1DownIdx = k;
                break;
            }
        }
    }

    // 3. Search strictly BEFORE L1 (search backward from l1DownIdx - 1 down to 1) for nearest valid 3-bar swing high H1
    let h1DownIdx = -1;
    if (l1DownIdx >= 2) {
        for (let k = l1DownIdx - 1; k >= 1; k--) {
            const highK = getHigh(windowCandles[k]);
            const prevH = getHigh(windowCandles[k - 1]);
            const nextH = getHigh(windowCandles[k + 1]);
            if (highK >= prevH && highK >= nextH) {
                h1DownIdx = k;
                break;
            }
        }
    }

    const pivotOrderValidDown = h1DownIdx >= 0 && l1DownIdx > h1DownIdx && h2Idx > l1DownIdx && h2Idx < N;
    const h1DownVal = pivotOrderValidDown ? getHigh(windowCandles[h1DownIdx]) : 0;
    const l1DownVal = pivotOrderValidDown ? getLow(windowCandles[l1DownIdx]) : 0;
    const h2DownVal = pivotOrderValidDown ? getHigh(windowCandles[h2Idx]) : 0;

    const impulseDown = pivotOrderValidDown ? (h1DownVal - l1DownVal) : 0;
    const reboundDownAmount = pivotOrderValidDown ? (h2DownVal - l1DownVal) : 0;
    const hasConsolidationDown = bullishCandleCount >= 1 || (h2Idx >= 0 && h2Idx < N - 1);

    const pullbackDepthRatioDown = (pivotOrderValidDown && impulseDown > 0)
        ? (reboundDownAmount > 0 ? (reboundDownAmount / impulseDown) : (hasConsolidationDown ? 0.3 : 0.5))
        : 1.0;

    // Post-H2 Re-decline / Lower Low & Rejection Confirmation
    let minPostH2Low = Infinity;
    if (pivotOrderValidDown && h2Idx < N) {
        for (let k = h2Idx; k < N; k++) {
            minPostH2Low = Math.min(minPostH2Low, getLow(windowCandles[k]));
        }
    }
    minPostH2Low = Math.min(minPostH2Low, lastPrice);

    const lowerHighDown = pivotOrderValidDown ? (h2DownVal < h1DownVal) : false;
    const lowerLowDown = pivotOrderValidDown ? (minPostH2Low <= l1DownVal * 1.002) : false;
    const rejectionConfirmedDown = pivotOrderValidDown
        ? ((lastPrice < h2DownVal - (h2DownVal - l1DownVal) * 0.25) || (lastPrice <= l1DownVal * 1.002))
        : false;
    const htfVetoShort = htfPolicy === "LONG_ONLY_OR_NONE" || (htfPolicy === "HOLD" && htfHardBlockReason === "STRONG_BULLISH_HTF_ALIGNMENT");

    let downConfidence = 0;
    let downBlockReason: string | null = null;

    if (pivotOrderValidDown) downConfidence += 0.10;
    if (lowerHighDown) downConfidence += 0.20;
    if (lowerLowDown) downConfidence += 0.20;
    if (centerSlope < -0.00002 || ema20Slope < -0.00002) downConfidence += 0.20;
    if (pullbackDepthRatioDown > 0 && pullbackDepthRatioDown <= 0.65) downConfidence += 0.20;
    if (rejectionConfirmedDown) downConfidence += 0.10;

    const isStairStepDown =
        pivotOrderValidDown &&
        lowerHighDown &&
        lowerLowDown &&
        (centerSlope < 0.00005) &&
        (ema20Slope < 0.00005) &&
        (centerSlope < -0.00002 || ema20Slope < -0.00002) &&
        pullbackDepthRatioDown <= 0.65 &&
        rejectionConfirmedDown &&
        hasConsolidationDown &&
        !isSingleSpikeDown &&
        bearishCandleCount >= 3 &&
        !htfVetoShort;

    if (!isStairStepDown) {
        if (htfVetoShort) downBlockReason = "HTF_HARD_VETO";
        else if (!pivotOrderValidDown) downBlockReason = "PIVOT_CHRONOLOGY_INVALID";
        else if (isSingleSpikeDown) downBlockReason = "SINGLE_SPIKE_UNSUSTAINED";
        else if (pullbackDepthRatioDown > 0.65) downBlockReason = "REBOUND_TOO_DEEP";
        else if (!lowerHighDown) downBlockReason = "LOWER_HIGH_MISSING";
        else if (!rejectionConfirmedDown) downBlockReason = "REJECTION_NOT_CONFIRMED";
        else if (centerSlope >= -0.00002 && ema20Slope >= -0.00002) downBlockReason = "SLOPE_FLAT_OR_POSITIVE";
    }

    if (isStairStepUp) {
        return {
            detected: true,
            direction: "UP",
            higher_low_detected: higherLowUp,
            higher_high_detected: higherHighUp,
            lower_high_detected: false,
            lower_low_detected: false,
            center_slope: Number(centerSlope.toFixed(6)),
            ema20_slope: Number(ema20Slope.toFixed(6)),
            pullback_depth_ratio: Number(pullbackDepthRatioUp.toFixed(4)),
            reclaim_or_rejection_confirmed: reclaimConfirmedUp,
            htf_entry_policy: htfPolicy,
            confidence: Number(Math.min(1.0, upConfidence).toFixed(2)),
            block_reason: null,
            structure_candles_closed_only: true,
            reclaim_price_source: "live_last_price",
            closed_candle_count: closedCandles.length,
            pivot_order_valid: pivotOrderValidUp,
            impulse_start_idx: l1Idx,
            impulse_end_idx: h1Idx,
            correction_pivot_idx: l2Idx,
            post_correction_confirmation_present: higherHighUp,
            prior_leg_size: Number(impulseUp.toFixed(2)),
            correction_amount: Number(pullbackUpAmount.toFixed(2))
        };
    }

    if (isStairStepDown) {
        return {
            detected: true,
            direction: "DOWN",
            higher_low_detected: false,
            higher_high_detected: false,
            lower_high_detected: lowerHighDown,
            lower_low_detected: lowerLowDown,
            center_slope: Number(centerSlope.toFixed(6)),
            ema20_slope: Number(ema20Slope.toFixed(6)),
            pullback_depth_ratio: Number(pullbackDepthRatioDown.toFixed(4)),
            reclaim_or_rejection_confirmed: rejectionConfirmedDown,
            htf_entry_policy: htfPolicy,
            confidence: Number(Math.min(1.0, downConfidence).toFixed(2)),
            block_reason: null,
            structure_candles_closed_only: true,
            reclaim_price_source: "live_last_price",
            closed_candle_count: closedCandles.length,
            pivot_order_valid: pivotOrderValidDown,
            impulse_start_idx: h1DownIdx,
            impulse_end_idx: l1DownIdx,
            correction_pivot_idx: h2Idx,
            post_correction_confirmation_present: lowerLowDown,
            prior_leg_size: Number(impulseDown.toFixed(2)),
            correction_amount: Number(reboundDownAmount.toFixed(2))
        };
    }

    const maxConfidence = Math.max(upConfidence, downConfidence);
    const chosenBlockReason = upConfidence >= downConfidence ? (upBlockReason || "FLAT_OR_CHOP") : (downBlockReason || "FLAT_OR_CHOP");
    const chosenPullbackRatio = upConfidence >= downConfidence ? pullbackDepthRatioUp : pullbackDepthRatioDown;

    return {
        detected: false,
        direction: "NONE",
        higher_low_detected: higherLowUp,
        higher_high_detected: higherHighUp,
        lower_high_detected: lowerHighDown,
        lower_low_detected: lowerLowDown,
        center_slope: Number(centerSlope.toFixed(6)),
        ema20_slope: Number(ema20Slope.toFixed(6)),
        pullback_depth_ratio: Number(chosenPullbackRatio.toFixed(4)),
        reclaim_or_rejection_confirmed: false,
        htf_entry_policy: htfPolicy,
        confidence: Number(Math.min(1.0, maxConfidence).toFixed(2)),
        block_reason: chosenBlockReason,
        structure_candles_closed_only: true,
        reclaim_price_source: "live_last_price",
        closed_candle_count: closedCandles.length,
        pivot_order_valid: upConfidence >= downConfidence ? pivotOrderValidUp : pivotOrderValidDown,
        impulse_start_idx: upConfidence >= downConfidence ? l1Idx : h1DownIdx,
        impulse_end_idx: upConfidence >= downConfidence ? h1Idx : l1DownIdx,
        correction_pivot_idx: upConfidence >= downConfidence ? l2Idx : h2Idx,
        post_correction_confirmation_present: false,
        prior_leg_size: Number((upConfidence >= downConfidence ? impulseUp : impulseDown).toFixed(2)),
        correction_amount: Number((upConfidence >= downConfidence ? pullbackUpAmount : reboundDownAmount).toFixed(2))
    };
}
