"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trendFilterOneMinuteCloses = trendFilterOneMinuteCloses;
const math_1 = require("../utils/math");
/**
 * 1m close series (oldest → newest). trend_ok = EMA20 > EMA60 when both EMAs are defined.
 */
function trendFilterOneMinuteCloses(closes) {
    const ema20 = (0, math_1.emaLastFromCloses)(closes, 20);
    const ema60 = (0, math_1.emaLastFromCloses)(closes, 60);
    if (ema20 === null || ema60 === null) {
        return {
            ema20,
            ema60,
            trendOk: false,
            reason: "insufficient_closes_for_ema"
        };
    }
    const trendOk = ema20 > ema60;
    return {
        ema20,
        ema60,
        trendOk,
        reason: trendOk ? "ema20_gt_ema60" : "ema20_lte_ema60"
    };
}
