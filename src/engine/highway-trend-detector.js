"use strict";
// src/engine/highway-trend-detector.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.HIGHWAY_TREND_MIN_CANDLES = void 0;
exports.isInsufficientCandlesLt60Only = isInsufficientCandlesLt60Only;
exports.detectHighwayTrend = detectHighwayTrend;
const types_1 = require("../models/types");
const math_1 = require("../utils/math");
/** EMA60 스택 + 볼륨 비교에 필요한 최소 1m 봉 수 (`detectHighwayTrend` 하드 게이트). */
exports.HIGHWAY_TREND_MIN_CANDLES = 60;
function isInsufficientCandlesLt60Only(invalidReasons) {
    return invalidReasons.length === 1 && invalidReasons[0] === "insufficient_candles_lt_60";
}
function detectHighwayTrend(candles, symbol) {
    if (candles.length < exports.HIGHWAY_TREND_MIN_CANDLES) {
        return {
            state: types_1.HighwayTrendState.INVALID,
            alignmentScore: 0,
            spacingScore: 0,
            pullbackDetected: false,
            volumeSupportScore: 0,
            invalidTier: "hard_invalid",
            invalidReasons: ["insufficient_candles_lt_60"]
        };
    }
    const closes = candles.map(c => c.close);
    const ema10 = (0, math_1.emaLastFromCloses)(closes, 10);
    const ema20 = (0, math_1.emaLastFromCloses)(closes, 20);
    const ema60 = (0, math_1.emaLastFromCloses)(closes, 60);
    const ema120 = (0, math_1.emaLastFromCloses)(closes, 120) ?? ema60;
    const ema240 = (0, math_1.emaLastFromCloses)(closes, 240) ?? ema120;
    if (ema10 === null || ema20 === null || ema60 === null || ema120 === null || ema240 === null) {
        return {
            state: types_1.HighwayTrendState.INVALID,
            alignmentScore: 0,
            spacingScore: 0,
            pullbackDetected: false,
            volumeSupportScore: 0,
            invalidTier: "hard_invalid",
            invalidReasons: ["ema_stack_unavailable"]
        };
    }
    // Determine direction based on 10 and 60
    const isLong = ema10 > ema60;
    // Check alignment
    let alignmentScore = 0;
    if (isLong) {
        if (ema10 >= ema20)
            alignmentScore += 0.4;
        if (ema20 >= ema60)
            alignmentScore += 0.3;
        if (ema60 >= ema120)
            alignmentScore += 0.2;
        if (ema120 >= ema240)
            alignmentScore += 0.1;
    }
    else {
        if (ema10 <= ema20)
            alignmentScore += 0.4;
        if (ema20 <= ema60)
            alignmentScore += 0.3;
        if (ema60 <= ema120)
            alignmentScore += 0.2;
        if (ema120 <= ema240)
            alignmentScore += 0.1;
    }
    let state = types_1.HighwayTrendState.INVALID;
    if (alignmentScore >= 0.9) {
        state = types_1.HighwayTrendState.VALID;
    }
    else if (alignmentScore >= 0.6) {
        state = types_1.HighwayTrendState.WEAK;
    }
    // Pullback Detection (approximate: price touches/crosses 10 EMA but above 60 EMA for long)
    const lastPrice = closes[closes.length - 1];
    let pullbackDetected = false;
    if (isLong) {
        pullbackDetected = (lastPrice <= ema10 * 1.0005 && lastPrice >= ema60);
    }
    else {
        pullbackDetected = (lastPrice >= ema10 * 0.9995 && lastPrice <= ema60);
    }
    // Spacing (approx gap between 20 and 60)
    let spacingScore = 0.5;
    const gap = Math.abs(ema20 - ema60) / ema60;
    if (gap > 0.0005 && gap < 0.005) {
        spacingScore = 1.0;
    }
    else if (gap >= 0.005) {
        spacingScore = 0.3; // over-extended
    }
    // Volume Support Score
    const recentVolume = candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5;
    const olderVolume = candles.slice(-15, -5).reduce((s, c) => s + c.volume, 0) / 10;
    const volumeSupportScore = olderVolume > 0 ? Math.min(1, recentVolume / olderVolume) : 0.5;
    const invalidReasons = [];
    if (alignmentScore < 0.6)
        invalidReasons.push("alignment_below_weak_threshold");
    if (!pullbackDetected)
        invalidReasons.push("pullback_not_detected");
    if (spacingScore < 0.5)
        invalidReasons.push("ema_spacing_overextended");
    if (volumeSupportScore < 0.45)
        invalidReasons.push("volume_support_thin");
    const invalidTier = state !== types_1.HighwayTrendState.INVALID
        ? "warning"
        : alignmentScore >= 0.45 && spacingScore >= 0.45 && volumeSupportScore >= 0.35
            ? "soft_invalid"
            : "hard_invalid";
    return {
        state,
        alignmentScore,
        spacingScore,
        pullbackDetected,
        volumeSupportScore,
        invalidTier,
        invalidReasons
    };
}
