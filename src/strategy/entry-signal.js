"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluatePaperEntryV1 = evaluatePaperEntryV1;
/**
 * Paper bidirectional with sideways-friendly weak candidates:
 * - Strong long: emaGap > strongTh && close >= ema20
 * - Weak long: |emaGap| <= sidewaysTh && close >= ema20
 * - Strong short: emaGap < -strongTh && close <= ema20
 * - Weak short: |emaGap| <= sidewaysTh && close <= ema20
 * At close === ema20, if both weak apply, tie-break by emaGap sign (>=0 → long).
 */
function evaluatePaperEntryV1(input) {
    const { symbol, ema20, ema60, latestCandleClose, strongEmaGapThreshold, sidewaysEmaGapThreshold } = input;
    if (ema20 === null || !Number.isFinite(ema20)) {
        return {
            symbol,
            entryCandidate: false,
            signal: "none",
            emaGap: null,
            candidateStrength: null,
            sidewaysMode: false
        };
    }
    if (ema60 === null || !Number.isFinite(ema60) || ema60 === 0) {
        return {
            symbol,
            entryCandidate: false,
            signal: "none",
            emaGap: null,
            candidateStrength: null,
            sidewaysMode: false
        };
    }
    const emaGap = (ema20 - ema60) / ema60;
    const strongTh = Math.max(0, strongEmaGapThreshold);
    const sidewaysTh = Math.max(strongTh, sidewaysEmaGapThreshold);
    const atOrAbove = latestCandleClose >= ema20;
    const atOrBelow = latestCandleClose <= ema20;
    let longStrength = null;
    let shortStrength = null;
    if (atOrAbove) {
        if (emaGap > strongTh)
            longStrength = "strong";
        else if (Math.abs(emaGap) <= sidewaysTh)
            longStrength = "weak";
    }
    if (atOrBelow) {
        if (emaGap < -strongTh)
            shortStrength = "strong";
        else if (Math.abs(emaGap) <= sidewaysTh)
            shortStrength = "weak";
    }
    if (longStrength && shortStrength) {
        if (emaGap >= 0)
            shortStrength = null;
        else
            longStrength = null;
    }
    if (longStrength) {
        return {
            symbol,
            entryCandidate: true,
            signal: "paper_long_candidate",
            emaGap,
            candidateStrength: longStrength,
            sidewaysMode: longStrength === "weak"
        };
    }
    if (shortStrength) {
        return {
            symbol,
            entryCandidate: true,
            signal: "paper_short_candidate",
            emaGap,
            candidateStrength: shortStrength,
            sidewaysMode: shortStrength === "weak"
        };
    }
    return {
        symbol,
        entryCandidate: false,
        signal: "none",
        emaGap,
        candidateStrength: null,
        sidewaysMode: false
    };
}
