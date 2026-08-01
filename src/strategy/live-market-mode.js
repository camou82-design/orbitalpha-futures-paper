"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectFuturesMarketMode = detectFuturesMarketMode;
exports.btcBiasFromModeDetail = btcBiasFromModeDetail;
function emaLast(closes, period) {
    if (closes.length < period)
        return null;
    const k = 2 / (period + 1);
    let e = closes[0];
    for (let i = 1; i < closes.length; i++)
        e = closes[i] * k + e * (1 - k);
    return e;
}
/**
 * BTC 5m 기준: 급락·과변동 약세 → risk_off, 좁은 레인지+EMA 밀집 → sideways, 그 외 trend.
 */
function detectFuturesMarketMode(input) {
    const c = input.btcCandles5m;
    if (c.length < 28) {
        return {
            mode: "sideways",
            detail: { reason: "insufficient_btc_5m", len: c.length, default_cautious: true }
        };
    }
    const completed = c.slice(0, -1);
    const closes = completed.map((x) => x.close);
    const last = closes[closes.length - 1];
    const e12 = emaLast(closes, 12);
    const e26 = emaLast(closes, 26);
    if (e12 === null || e26 === null) {
        return { mode: "sideways", detail: { reason: "ema_not_ready" } };
    }
    const recent = completed.slice(-15);
    const hi = Math.max(...recent.map((x) => x.high));
    const lo = Math.min(...recent.map((x) => x.low));
    const rangeRel = (hi - lo) / (last + 1e-9);
    const drop5 = closes.length >= 6 ? (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6] : 0;
    const emaSep = Math.abs(e12 - e26) / (last + 1e-9);
    const bias = e12 > e26 * 1.0012 ? "up" : e12 < e26 * 0.9988 ? "down" : "flat";
    if (drop5 < -0.012 || (e12 < e26 * 0.996 && rangeRel > 0.022)) {
        return {
            mode: "risk_off",
            detail: {
                drop5,
                range_rel: rangeRel,
                e12,
                e26,
                bias,
                ema_separation: emaSep
            }
        };
    }
    if (rangeRel < 0.017 && emaSep < 0.0035) {
        return {
            mode: "sideways",
            detail: {
                range_rel: rangeRel,
                ema_separation: emaSep,
                e12,
                e26,
                bias
            }
        };
    }
    return {
        mode: "trend",
        detail: {
            e12,
            e26,
            range_rel: rangeRel,
            bias,
            ema_separation: emaSep
        }
    };
}
function btcBiasFromModeDetail(detail) {
    const b = detail.bias;
    if (b === "up" || b === "down" || b === "flat")
        return b;
    return "flat";
}
