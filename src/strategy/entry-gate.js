"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.atrWilderLast = atrWilderLast;
exports.minRequiredMoveFraction = minRequiredMoveFraction;
exports.higherTfLongTrendOk = higherTfLongTrendOk;
exports.higherTfShortTrendOk = higherTfShortTrendOk;
exports.evaluateEntryCostAndHigherTfGate = evaluateEntryCostAndHigherTfGate;
exports.entryGateHigherTimeframe = entryGateHigherTimeframe;
exports.entryGateHigherTfKlineLimit = entryGateHigherTfKlineLimit;
const math_1 = require("../utils/math");
const entry_gate_config_1 = require("./entry-gate-config");
function trueRange(high, low, prevClose) {
    return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}
/**
 * Last Wilder ATR value; `candles` oldest → newest, need length > period + 1.
 */
function atrWilderLast(candles, period) {
    if (candles.length < period + 1)
        return null;
    const tr = [];
    for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1].close;
        const c = candles[i];
        tr.push(trueRange(c.high, c.low, prev));
    }
    if (tr.length < period)
        return null;
    let atr = 0;
    for (let i = 0; i < period; i++)
        atr += tr[i];
    atr /= period;
    for (let i = period; i < tr.length; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
    }
    return atr;
}
/**
 * Minimum absolute price return (fraction) to cover taker round-trip + a small funding pad.
 * Matches paper PnL scaling: breakeven on fees ≈ `2 * takerFeeRate` in price-return space.
 */
function minRequiredMoveFraction(input) {
    const feeRoundTrip = 2 * input.takerFeeRate;
    const fundPad = Math.abs(input.fundingRate) * Math.max(0, input.fundingPeriodsEstimate);
    return feeRoundTrip + fundPad;
}
function higherTfLongTrendOk(closes) {
    const ema20 = (0, math_1.emaLastFromCloses)([...closes], 20);
    const ema60 = (0, math_1.emaLastFromCloses)([...closes], 60);
    if (ema20 === null || ema60 === null)
        return false;
    return ema20 > ema60;
}
function higherTfShortTrendOk(closes) {
    const ema20 = (0, math_1.emaLastFromCloses)([...closes], 20);
    const ema60 = (0, math_1.emaLastFromCloses)([...closes], 60);
    if (ema20 === null || ema60 === null)
        return false;
    return ema20 < ema60;
}
function evaluateEntryCostAndHigherTfGate(input) {
    const period = entry_gate_config_1.ENTRY_GATE_CONFIG.volatilityAtrPeriod;
    const mult = input.gateOptions?.minMoveMultiplier ?? entry_gate_config_1.ENTRY_GATE_CONFIG.minMoveVsCostMultiplier;
    const requireHigherTfAlign = input.gateOptions?.requireHigherTfAlign ?? true;
    const paperBypass = input.paperBypassExpectedMoveGate === true;
    const requiredMove = minRequiredMoveFraction({
        takerFeeRate: input.takerFeeRate,
        fundingRate: input.fundingRate,
        fundingPeriodsEstimate: entry_gate_config_1.ENTRY_GATE_CONFIG.fundingPeriodsForMinMoveEstimate
    });
    const requiredMoveThreshold = requiredMove * mult;
    const refOk = Number.isFinite(input.refPrice) && input.refPrice > 0;
    const atr = atrWilderLast(input.entryTimeframeCandles, period);
    const expectedMove = refOk && atr !== null ? atr / input.refPrice : 0;
    const dir = input.entryDirection ?? "long";
    let higherTfAligned = false;
    if (input.higherTfCandles !== null && input.higherTfCandles.length > 0) {
        const hCloses = input.higherTfCandles.map((c) => c.close);
        higherTfAligned =
            dir === "long" ? higherTfLongTrendOk(hCloses) : higherTfShortTrendOk(hCloses);
    }
    const volOk = refOk && atr !== null && expectedMove >= requiredMoveThreshold;
    const originalExpectedMovePass = volOk;
    if (!paperBypass) {
        if (!refOk) {
            return {
                allowed: false,
                blockReason: "low_expected_move",
                expectedMove: 0,
                requiredMove,
                requiredMoveThreshold,
                higherTfAligned: false,
                originalExpectedMovePass: false,
                feeExpectedMoveGateBypassed: false
            };
        }
        if (atr === null) {
            return {
                allowed: false,
                blockReason: "low_expected_move",
                expectedMove: 0,
                requiredMove,
                requiredMoveThreshold,
                higherTfAligned,
                originalExpectedMovePass: false,
                feeExpectedMoveGateBypassed: false
            };
        }
        if (!volOk) {
            return {
                allowed: false,
                blockReason: "low_expected_move",
                expectedMove,
                requiredMove,
                requiredMoveThreshold,
                higherTfAligned,
                originalExpectedMovePass: false,
                feeExpectedMoveGateBypassed: false
            };
        }
    }
    if (requireHigherTfAlign && !higherTfAligned) {
        return {
            allowed: false,
            blockReason: "higher_tf_mismatch",
            expectedMove,
            requiredMove,
            requiredMoveThreshold,
            higherTfAligned: false,
            originalExpectedMovePass,
            feeExpectedMoveGateBypassed: paperBypass
        };
    }
    return {
        allowed: true,
        expectedMove,
        requiredMove,
        requiredMoveThreshold,
        higherTfAligned,
        originalExpectedMovePass,
        feeExpectedMoveGateBypassed: paperBypass
    };
}
function entryGateHigherTimeframe() {
    return entry_gate_config_1.ENTRY_GATE_CONFIG.higherTimeframe;
}
function entryGateHigherTfKlineLimit() {
    return entry_gate_config_1.ENTRY_GATE_CONFIG.higherTfKlineLimit;
}
