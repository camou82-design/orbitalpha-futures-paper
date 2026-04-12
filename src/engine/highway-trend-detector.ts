// src/engine/highway-trend-detector.ts

import { MarketSymbol, Candle } from "../models/types";
import { HighwayTrendState } from "../models/types";
import { emaLastFromCloses } from "../utils/math";

export function detectHighwayTrend(candles: Candle[], symbol: MarketSymbol): {
    state: HighwayTrendState;
    alignmentScore: number;
    spacingScore: number;
    pullbackDetected: boolean;
    volumeSupportScore: number;
} {
    if (candles.length < 60) {
        return {
            state: HighwayTrendState.INVALID,
            alignmentScore: 0,
            spacingScore: 0,
            pullbackDetected: false,
            volumeSupportScore: 0
        };
    }

    const closes = candles.map(c => c.close);
    const ema10 = emaLastFromCloses(closes, 10);
    const ema20 = emaLastFromCloses(closes, 20);
    const ema60 = emaLastFromCloses(closes, 60);
    const ema120 = emaLastFromCloses(closes, 120) ?? ema60;
    const ema240 = emaLastFromCloses(closes, 240) ?? ema120;

    if (ema10 === null || ema20 === null || ema60 === null || ema120 === null || ema240 === null) {
        return {
            state: HighwayTrendState.INVALID,
            alignmentScore: 0,
            spacingScore: 0,
            pullbackDetected: false,
            volumeSupportScore: 0
        };
    }

    // Determine direction based on 10 and 60
    const isLong = ema10 > ema60;

    // Check alignment
    let alignmentScore = 0;
    if (isLong) {
        if (ema10 >= ema20) alignmentScore += 0.4;
        if (ema20 >= ema60) alignmentScore += 0.3;
        if (ema60 >= ema120) alignmentScore += 0.2;
        if (ema120 >= ema240) alignmentScore += 0.1;
    } else {
        if (ema10 <= ema20) alignmentScore += 0.4;
        if (ema20 <= ema60) alignmentScore += 0.3;
        if (ema60 <= ema120) alignmentScore += 0.2;
        if (ema120 <= ema240) alignmentScore += 0.1;
    }

    let state = HighwayTrendState.INVALID;
    if (alignmentScore >= 0.9) {
        state = HighwayTrendState.VALID;
    } else if (alignmentScore >= 0.6) {
        state = HighwayTrendState.WEAK;
    }

    // Pullback Detection (approximate: price touches/crosses 10 EMA but above 60 EMA for long)
    const lastPrice = closes[closes.length - 1];
    let pullbackDetected = false;
    if (isLong) {
        pullbackDetected = (lastPrice <= ema10 * 1.0005 && lastPrice >= ema60);
    } else {
        pullbackDetected = (lastPrice >= ema10 * 0.9995 && lastPrice <= ema60);
    }

    // Spacing (approx gap between 20 and 60)
    let spacingScore = 0.5;
    const gap = Math.abs(ema20 - ema60) / ema60;
    if (gap > 0.0005 && gap < 0.005) {
        spacingScore = 1.0;
    } else if (gap >= 0.005) {
        spacingScore = 0.3; // over-extended
    }

    // Volume Support Score
    const recentVolume = candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5;
    const olderVolume = candles.slice(-15, -5).reduce((s, c) => s + c.volume, 0) / 10;
    const volumeSupportScore = olderVolume > 0 ? Math.min(1, recentVolume / olderVolume) : 0.5;

    return {
        state,
        alignmentScore,
        spacingScore,
        pullbackDetected,
        volumeSupportScore
    };
}
