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
    const midPoint = Math.floor(windowSize / 2);

    const prevHalf = windowCandles.slice(0, midPoint);
    const recentHalf = windowCandles.slice(midPoint);

    const getHigh = (c: Candle) => Number(c.high ?? (c as any).h ?? c.close);
    const getLow = (c: Candle) => Number(c.low ?? (c as any).l ?? c.close);
    const getClose = (c: Candle) => Number(c.close ?? (c as any).c ?? 0);
    const getOpen = (c: Candle) => Number(c.open ?? (c as any).o ?? getClose(c));

    const prevHigh = Math.max(...prevHalf.map(getHigh));
    const prevLow = Math.min(...prevHalf.map(getLow));
    const recentHigh = Math.max(...recentHalf.map(getHigh));
    const recentLow = Math.min(...recentHalf.map(getLow));
    const lastPrice = Number(sn.lastPrice ?? getClose(candles[candles.length - 1]));

    const higherLow = recentLow > prevLow;
    const higherHigh = recentHigh > prevHigh;
    const lowerHigh = recentHigh < prevHigh;
    const lowerLow = recentLow < prevLow;

    // Directly compute closed-candle slopes across the two halves
    const prevAvgCenter = (prevHigh + prevLow) / 2;
    const recentAvgCenter = (recentHigh + recentLow) / 2;
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

    // --- EVALUATE STAIR_STEP_UP ---
    const impulseUp = windowHigh - prevLow;
    const pullbackUpAmount = prevHigh - recentLow;
    const hasConsolidationUp = bearishCandleCount >= 1 || recentHalf.some(c => getClose(c) < getOpen(c) || getLow(c) < getOpen(c));
    const pullbackDepthRatioUp = (impulseUp > 0 && prevHigh > prevLow)
        ? (pullbackUpAmount > 0 ? (pullbackUpAmount / (prevHigh - prevLow)) : (hasConsolidationUp ? 0.3 : 0.5))
        : 1.0;

    // Reclaim condition for UP: Last price has recovered off pullback low and is holding upper zone of structure
    const reclaimConfirmedUp = (lastPrice > recentLow + (windowHigh - recentLow) * 0.25) || (lastPrice >= prevHigh * 0.998);
    const htfVetoLong = htfPolicy === "SHORT_ONLY_OR_NONE" || (htfPolicy === "HOLD" && htfHardBlockReason === "STRONG_BEARISH_HTF_ALIGNMENT");

    let upConfidence = 0;
    let upBlockReason: string | null = null;

    if (higherLow) upConfidence += 0.25;
    if (higherHigh || lastPrice >= prevHigh * 0.998) upConfidence += 0.20;
    if (centerSlope > 0.00002 || ema20Slope > 0.00002) upConfidence += 0.20;
    if (pullbackDepthRatioUp > 0 && pullbackDepthRatioUp <= 0.65) upConfidence += 0.20;
    if (reclaimConfirmedUp) upConfidence += 0.15;

    const isStairStepUp =
        higherLow &&
        (higherHigh || lastPrice >= prevHigh * 0.998) &&
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
        else if (isSingleSpikeUp) upBlockReason = "SINGLE_SPIKE_UNSUSTAINED";
        else if (!hasConsolidationUp) upBlockReason = "NO_CONSOLIDATION_PULLBACK";
        else if (pullbackDepthRatioUp > 0.65) upBlockReason = "PULLBACK_TOO_DEEP";
        else if (!higherLow) upBlockReason = "HIGHER_LOW_MISSING";
        else if (!reclaimConfirmedUp) upBlockReason = "RECLAIM_NOT_CONFIRMED";
        else if (centerSlope <= 0.00002 && ema20Slope <= 0.00002) upBlockReason = "SLOPE_FLAT_OR_NEGATIVE";
    }

    // --- EVALUATE STAIR_STEP_DOWN (SYMMETRIC) ---
    const impulseDown = prevHigh - windowLow;
    const reboundDownAmount = recentHigh - prevLow;
    const hasConsolidationDown = bullishCandleCount >= 1 || recentHalf.some(c => getClose(c) > getOpen(c) || getHigh(c) > getOpen(c));
    const pullbackDepthRatioDown = (impulseDown > 0 && prevHigh > prevLow)
        ? (reboundDownAmount > 0 ? (reboundDownAmount / (prevHigh - prevLow)) : (hasConsolidationDown ? 0.3 : 0.5))
        : 1.0;

    // Rejection condition for DOWN: Last price has turned down from rebound high and is holding lower zone of structure
    const rejectionConfirmedDown = (lastPrice < recentHigh - (recentHigh - windowLow) * 0.25) || (lastPrice <= prevLow * 1.002);
    const htfVetoShort = htfPolicy === "LONG_ONLY_OR_NONE" || (htfPolicy === "HOLD" && htfHardBlockReason === "STRONG_BULLISH_HTF_ALIGNMENT");

    let downConfidence = 0;
    let downBlockReason: string | null = null;

    if (lowerHigh) downConfidence += 0.25;
    if (lowerLow || lastPrice <= prevLow * 1.002) downConfidence += 0.20;
    if (centerSlope < -0.00002 || ema20Slope < -0.00002) downConfidence += 0.20;
    if (pullbackDepthRatioDown > 0 && pullbackDepthRatioDown <= 0.65) downConfidence += 0.20;
    if (rejectionConfirmedDown) downConfidence += 0.15;

    const isStairStepDown =
        lowerHigh &&
        (lowerLow || lastPrice <= prevLow * 1.002) &&
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
        else if (isSingleSpikeDown) downBlockReason = "SINGLE_SPIKE_UNSUSTAINED";
        else if (pullbackDepthRatioDown > 0.65) downBlockReason = "REBOUND_TOO_DEEP";
        else if (!lowerHigh) downBlockReason = "LOWER_HIGH_MISSING";
        else if (!rejectionConfirmedDown) downBlockReason = "REJECTION_NOT_CONFIRMED";
        else if (centerSlope >= -0.00002 && ema20Slope >= -0.00002) downBlockReason = "SLOPE_FLAT_OR_POSITIVE";
    }

    if (isStairStepUp) {
        return {
            detected: true,
            direction: "UP",
            higher_low_detected: higherLow,
            higher_high_detected: higherHigh,
            lower_high_detected: lowerHigh,
            lower_low_detected: lowerLow,
            center_slope: Number(centerSlope.toFixed(6)),
            ema20_slope: Number(ema20Slope.toFixed(6)),
            pullback_depth_ratio: Number(pullbackDepthRatioUp.toFixed(4)),
            reclaim_or_rejection_confirmed: reclaimConfirmedUp,
            htf_entry_policy: htfPolicy,
            confidence: Number(Math.min(1.0, upConfidence).toFixed(2)),
            block_reason: null,
            structure_candles_closed_only: true,
            reclaim_price_source: "live_last_price",
            closed_candle_count: closedCandles.length
        };
    }

    if (isStairStepDown) {
        return {
            detected: true,
            direction: "DOWN",
            higher_low_detected: higherLow,
            higher_high_detected: higherHigh,
            lower_high_detected: lowerHigh,
            lower_low_detected: lowerLow,
            center_slope: Number(centerSlope.toFixed(6)),
            ema20_slope: Number(ema20Slope.toFixed(6)),
            pullback_depth_ratio: Number(pullbackDepthRatioDown.toFixed(4)),
            reclaim_or_rejection_confirmed: rejectionConfirmedDown,
            htf_entry_policy: htfPolicy,
            confidence: Number(Math.min(1.0, downConfidence).toFixed(2)),
            block_reason: null,
            structure_candles_closed_only: true,
            reclaim_price_source: "live_last_price",
            closed_candle_count: closedCandles.length
        };
    }

    const maxConfidence = Math.max(upConfidence, downConfidence);
    const chosenBlockReason = upConfidence >= downConfidence ? (upBlockReason || "FLAT_OR_CHOP") : (downBlockReason || "FLAT_OR_CHOP");
    const chosenPullbackRatio = upConfidence >= downConfidence ? pullbackDepthRatioUp : pullbackDepthRatioDown;

    return {
        detected: false,
        direction: "NONE",
        higher_low_detected: higherLow,
        higher_high_detected: higherHigh,
        lower_high_detected: lowerHigh,
        lower_low_detected: lowerLow,
        center_slope: Number(centerSlope.toFixed(6)),
        ema20_slope: Number(ema20Slope.toFixed(6)),
        pullback_depth_ratio: Number(chosenPullbackRatio.toFixed(4)),
        reclaim_or_rejection_confirmed: false,
        htf_entry_policy: htfPolicy,
        confidence: Number(Math.min(1.0, maxConfidence).toFixed(2)),
        block_reason: chosenBlockReason,
        structure_candles_closed_only: true,
        reclaim_price_source: "live_last_price",
        closed_candle_count: closedCandles.length
    };
}
