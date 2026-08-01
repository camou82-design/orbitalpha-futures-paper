"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computePaperEntryQualityScore = computePaperEntryQualityScore;
exports.paperSignalStrengthLabel = paperSignalStrengthLabel;
/**
 * Paper-only heuristic quality score (0–100). Not used by live trading.
 * Weak/sideways candidates use a softer path so scores stay in a passable range under relaxed mode.
 */
function computePaperEntryQualityScore(input) {
    if (input.ema20 === null || !Number.isFinite(input.ema20) || input.ema20 <= 0)
        return 0;
    if (input.ema60 === null || !Number.isFinite(input.ema60) || input.ema60 === 0)
        return 0;
    const sidewaysTh = Math.max(1e-9, input.sidewaysEmaGapThreshold);
    if (input.side === "long") {
        if (input.latestCandleClose < input.ema20)
            return 0;
        if (input.candidateStrength === "strong") {
            let score = 35;
            score += 25;
            const priceVsEma = (input.lastPrice - input.ema20) / input.ema20;
            score += Math.min(25, Math.max(0, priceVsEma * 4000));
            if (input.lastPrice > input.latestCandleClose)
                score += 15;
            else if (input.lastPrice >= input.latestCandleClose)
                score += 8;
            return Math.round(Math.min(100, Math.max(0, score)));
        }
        let score = 40;
        const cluster = Math.min(1, Math.abs(input.emaGap) / sidewaysTh);
        score += Math.round(20 * (1 - cluster));
        const priceVsEma = (input.lastPrice - input.ema20) / input.ema20;
        score += Math.min(20, Math.max(0, priceVsEma * 3500));
        if (input.lastPrice > input.latestCandleClose)
            score += 12;
        else if (input.lastPrice >= input.latestCandleClose)
            score += 6;
        return Math.round(Math.min(100, Math.max(0, score)));
    }
    if (input.latestCandleClose > input.ema20)
        return 0;
    if (input.candidateStrength === "strong") {
        let score = 35;
        score += 25;
        const priceVsEma = (input.ema20 - input.lastPrice) / input.ema20;
        score += Math.min(25, Math.max(0, priceVsEma * 4000));
        if (input.lastPrice < input.latestCandleClose)
            score += 15;
        else if (input.lastPrice <= input.latestCandleClose)
            score += 8;
        return Math.round(Math.min(100, Math.max(0, score)));
    }
    let score = 40;
    const cluster = Math.min(1, Math.abs(input.emaGap) / sidewaysTh);
    score += Math.round(20 * (1 - cluster));
    const priceVsEma = (input.ema20 - input.lastPrice) / input.ema20;
    score += Math.min(20, Math.max(0, priceVsEma * 3500));
    if (input.lastPrice < input.latestCandleClose)
        score += 12;
    else if (input.lastPrice <= input.latestCandleClose)
        score += 6;
    return Math.round(Math.min(100, Math.max(0, score)));
}
function paperSignalStrengthLabel(score, relaxed) {
    const strongMin = relaxed ? 65 : 75;
    const okMin = relaxed ? 55 : 65;
    if (score >= strongMin)
        return "strong";
    if (score >= okMin)
        return "ok";
    return "weak";
}
