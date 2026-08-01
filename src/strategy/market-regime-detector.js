"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INITIAL_ENGINE_REGIME = exports.MIN_BTC_5M_BARS_REGIME = void 0;
exports.regimeWhenBtcFeedFailed = regimeWhenBtcFeedFailed;
exports.detectMarketRegime = detectMarketRegime;
const entry_gate_1 = require("./entry-gate");
/** 최소 5m 봉 개수: 미만이면 NO_TRADE(필수 데이터 부족). 30~49는 RANGE/TREND+ambiguous로 탐색 허용. */
exports.MIN_BTC_5M_BARS_REGIME = 30;
function makeLog(p) {
    return {
        regime_raw: p.regimeRaw,
        regime_final: p.regimeFinal,
        no_trade_reason: p.noTradeReason,
        unknown_reason: p.unknownReason,
        data_ready: p.dataReady,
        dump_protection_hit: p.dumpHit,
        volatility_guard_hit: p.volHit
    };
}
/** 엔진 기동 전 스냅샷용 (첫 runOnce 전). */
exports.INITIAL_ENGINE_REGIME = {
    regime: "NO_TRADE",
    isAmbiguous: false,
    rangeConfidence: 0,
    detail: { reason: "engine_init" },
    log: {
        regime_raw: "NO_TRADE",
        regime_final: "NO_TRADE",
        no_trade_reason: null,
        unknown_reason: null,
        data_ready: false,
        dump_protection_hit: false,
        volatility_guard_hit: false
    },
    boxCohesion01: 0,
    breakoutFailureRate: 0,
    rangeOscillationScore: 0,
    trendWeaknessScore: 0,
    rangeReasonLabel: "engine_init",
    regimeExitRisk: 0,
    boxBreakSide: "none",
    regimeState: "NO_TRADE"
};
/** BTC 캔들 피드 실패 시 전용 NO_TRADE (거래소/피드 이상). */
function regimeWhenBtcFeedFailed(errorMessage) {
    return {
        regime: "NO_TRADE",
        isAmbiguous: false,
        rangeConfidence: 0,
        detail: { reason: "btc_candles_fetch_failed", error: errorMessage },
        log: makeLog({
            regimeRaw: "NO_TRADE",
            regimeFinal: "NO_TRADE",
            noTradeReason: "btc_candles_fetch_failed",
            unknownReason: null,
            dataReady: false,
            dumpHit: false,
            volHit: false
        }),
        boxCohesion01: 0,
        breakoutFailureRate: 0,
        rangeOscillationScore: 0,
        trendWeaknessScore: 0,
        rangeReasonLabel: "btc_feed_failed",
        regimeExitRisk: 0,
        boxBreakSide: "none",
        regimeState: "NO_TRADE"
    };
}
function emaLast(closes, period) {
    if (closes.length < period)
        return null;
    const k = 2 / (period + 1);
    let e = closes[0];
    for (let i = 1; i < closes.length; i++)
        e = closes[i] * k + e * (1 - k);
    return e;
}
function clamp01(x) {
    if (!Number.isFinite(x))
        return 0;
    return x < 0 ? 0 : x > 1 ? 1 : x;
}
/**
 * Market regime detector (paper futures).
 *
 * - NO_TRADE: 필수 데이터 부족, 지표 계산 실패, 덤프/비정상 변동 보호만 (진짜 위험·오류).
 * - 그 외 불명확·스코어 경계는 TREND 또는 RANGE + isAmbiguous 로 내려 Stage 1 탐색에 포함.
 */
function detectMarketRegime(input) {
    const c = input.btcCandles5m;
    const prevRegime = input.prevRegime ?? "UNKNOWN";
    const len = c.length;
    if (len < exports.MIN_BTC_5M_BARS_REGIME) {
        return {
            regime: "NO_TRADE",
            isAmbiguous: false,
            rangeConfidence: 0,
            detail: { reason: "insufficient_btc_5m", len, min_required: exports.MIN_BTC_5M_BARS_REGIME },
            log: makeLog({
                regimeRaw: "NO_TRADE",
                regimeFinal: "NO_TRADE",
                noTradeReason: "insufficient_btc_5m",
                unknownReason: "insufficient_btc_5m",
                dataReady: false,
                dumpHit: false,
                volHit: false
            }),
            boxCohesion01: 0,
            breakoutFailureRate: 0,
            rangeOscillationScore: 0,
            trendWeaknessScore: 0,
            rangeReasonLabel: "insufficient_data",
            regimeExitRisk: 0,
            boxBreakSide: "none",
            regimeState: "NO_TRADE"
        };
    }
    const marginalHistory = len < 50;
    // Use only completed candles for stability.
    const completed = c.slice(0, -1);
    const closes = completed.map((x) => x.close);
    const last = closes[closes.length - 1];
    const e20 = emaLast(closes.slice(-80), 20);
    const e60 = emaLast(closes.slice(-140), Math.min(60, closes.length));
    if (e20 === null || e60 === null || !Number.isFinite(last) || last <= 0) {
        return {
            regime: "NO_TRADE",
            isAmbiguous: false,
            rangeConfidence: 0,
            detail: { reason: "ema_not_ready_or_bad_price", len },
            log: makeLog({
                regimeRaw: "NO_TRADE",
                regimeFinal: "NO_TRADE",
                noTradeReason: "ema_not_ready_or_bad_price",
                unknownReason: null,
                dataReady: false,
                dumpHit: false,
                volHit: false
            }),
            boxCohesion01: 0,
            breakoutFailureRate: 0,
            rangeOscillationScore: 0,
            trendWeaknessScore: 0,
            rangeReasonLabel: "indicator_fail",
            regimeExitRisk: 0,
            boxBreakSide: "none",
            regimeState: "NO_TRADE"
        };
    }
    const bias = e20 > e60 * 1.0012 ? "up" : e20 < e60 * 0.9988 ? "down" : "flat";
    const atr = (0, entry_gate_1.atrWilderLast)(completed.slice(-80), 14);
    const atrRel = atr !== null && atr > 0 ? atr / last : 0;
    const lookbackPeriod = 24;
    const lookback = completed.slice(-lookbackPeriod);
    const hi = Math.max(...lookback.map((x) => x.high));
    const lo = Math.min(...lookback.map((x) => x.low));
    const boxRel = (hi - lo) / (last + 1e-9);
    const emaSepRel = Math.abs(e20 - e60) / (last + 1e-9);
    const e20Prev = emaLast(closes.slice(-100, -20), 20);
    const slopeRel = e20Prev !== null ? (e20 - e20Prev) / (last + 1e-9) : 0;
    // 1. Box Cohesion (박스 응집도)
    let inside = 0;
    for (const x of lookback) {
        if (x.close <= hi * 1.0005 && x.close >= lo * 0.9995)
            inside += 1;
    }
    const boxCohesion01 = lookback.length > 0 ? inside / lookback.length : 0;
    // 2. Trend Weakness (추세 약함)
    const sepWeakness = clamp01((0.0035 - emaSepRel) / 0.0025);
    const slopeWeakness = clamp01((0.0010 - Math.abs(slopeRel)) / 0.0008);
    const boxTightness = clamp01((0.025 - boxRel) / 0.015);
    const trendWeaknessScore = 0.4 * sepWeakness + 0.3 * slopeWeakness + 0.3 * boxTightness;
    // 3. Breakout Failure Rate (돌파 지속 실패)
    const recents = completed.slice(-30);
    let attempts = 0;
    let failures = 0;
    for (let i = 1; i < recents.length; i++) {
        const prev = recents[i - 1];
        const curr = recents[i];
        if ((prev.high <= hi && curr.high > hi) || (prev.low >= lo && curr.low < lo)) {
            attempts++;
            const slice = recents.slice(i, i + 4);
            const returned = slice.some(x => x.close <= hi * 1.0005 && x.close >= lo * 0.9995);
            if (returned)
                failures++;
        }
    }
    const breakoutFailureRate = attempts > 0 ? failures / attempts : 0.5;
    // 4. Range Oscillation Score (왕복 빈도)
    const midPrice = (hi + lo) / 2;
    const zones = lookback.map(x => (x.close > midPrice ? "upper" : "lower"));
    let switches = 0;
    for (let i = 1; i < zones.length; i++) {
        if (zones[i] !== zones[i - 1])
            switches++;
    }
    const rangeOscillationScore = clamp01((switches - 2) / 6);
    const drop5 = closes.length >= 6 ? (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6] : 0;
    const drop12 = closes.length >= 13
        ? (closes[closes.length - 1] - closes[closes.length - 13]) / closes[closes.length - 13]
        : 0;
    const volTooHigh = atrRel > 0.0105 || boxRel > 0.035;
    const dumpRisk = drop5 < -0.013 || drop12 < -0.022;
    const shockDownRisk = drop5 < -0.008 || drop12 < -0.015;
    // Highway Exclusion Conditions: Block RANGE if volume + EMA gap expansion occurs
    const emaGapGrowing = emaSepRel > 0.0055 && Math.abs(slopeRel) > 0.0012;
    const forceTrendBias = emaGapGrowing && !dumpRisk;
    if (dumpRisk || volTooHigh) {
        const reason = dumpRisk ? "dump_risk" : volTooHigh ? "vol_too_high" : "ema_expansion_trend";
        return {
            regime: "NO_TRADE",
            isAmbiguous: false,
            rangeConfidence: 0,
            detail: {
                reason,
                atr_rel: atrRel,
                box_rel: boxRel,
                bias,
                len
            },
            log: makeLog({
                regimeRaw: "NO_TRADE",
                regimeFinal: "NO_TRADE",
                noTradeReason: reason,
                unknownReason: null,
                dataReady: true,
                dumpHit: dumpRisk,
                volHit: !dumpRisk && volTooHigh
            }),
            boxCohesion01: boxCohesion01 || 0,
            breakoutFailureRate: breakoutFailureRate || 0,
            rangeOscillationScore: rangeOscillationScore || 0,
            trendWeaknessScore: trendWeaknessScore || 0,
            rangeReasonLabel: `exclusion_${reason}`,
            regimeExitRisk: 1,
            boxBreakSide: "none",
            regimeState: "NO_TRADE"
        };
    }
    // Highway Range Confidence Scoring
    const rangeConfidence = 0.3 * boxCohesion01 + 0.3 * trendWeaknessScore + 0.2 * breakoutFailureRate + 0.2 * rangeOscillationScore;
    // Existing Trend Core Scoring
    const sepScore = clamp01((emaSepRel - 0.0025) / 0.0045);
    const slopeScore = clamp01((Math.abs(slopeRel) - 0.0006) / 0.0014);
    const boxScore = clamp01((boxRel - 0.015) / 0.02);
    const trendScore = 0.45 * sepScore + 0.35 * slopeScore + 0.2 * boxScore;
    const ambiguousFlag = len < 60 || marginalHistory;
    const reasons = [];
    if (boxCohesion01 >= 0.8)
        reasons.push("박스 응집 높음");
    if (trendWeaknessScore >= 0.7)
        reasons.push("추세 약성 뚜렷");
    if (breakoutFailureRate >= 0.6)
        reasons.push("돌파 지속 실패 관측");
    if (rangeOscillationScore >= 0.6)
        reasons.push("상하단 왕복 빈번");
    const rangeReasonLabel = reasons.length > 0 ? reasons.join(" / ") : "일반 횡보세";
    const baseDetail = (extra) => ({
        range_confidence: rangeConfidence,
        box_cohesion: boxCohesion01,
        trend_weakness: trendWeaknessScore,
        breakout_failure_rate: breakoutFailureRate,
        oscillation_score: rangeOscillationScore,
        range_reason_label: rangeReasonLabel,
        trend_score: trendScore,
        atr_rel: atrRel,
        box_rel: boxRel,
        ema_sep_rel: emaSepRel,
        slope_rel: slopeRel,
        bias,
        len,
        ...extra
    });
    // Thresholds: Enter RANGE >= 0.72, Exit RANGE < 0.55 (Hysteresis)
    const rangeEntryThreshold = 0.72;
    const rangeExitThreshold = 0.55;
    let regimeOut = "NO_TRADE";
    if (prevRegime === "RANGE") {
        // Already in RANGE: stay until it drops below exit threshold
        if (rangeConfidence >= rangeExitThreshold && trendScore < 0.75) {
            regimeOut = "RANGE";
        }
        else {
            regimeOut = trendScore >= 0.65 ? "TREND" : "NO_TRADE";
        }
    }
    else {
        // Try to enter RANGE
        if (rangeConfidence >= rangeEntryThreshold && trendScore < 0.65) {
            regimeOut = "RANGE";
        }
        else if (trendScore >= 0.70) {
            regimeOut = "TREND";
        }
        else {
            regimeOut = trendScore >= rangeConfidence ? "TREND" : "RANGE";
        }
    }
    // Final Ambiguity Handling
    const finalIsAmbiguous = ambiguousFlag || (rangeConfidence > 0.58 && rangeConfidence < 0.72);
    // Regime Exit Risk: 1.0 (Low confidence), 0.0 (High confidence)
    const regimeExitRisk = clamp01((0.8 - rangeConfidence) / 0.4);
    return {
        regime: regimeOut,
        isAmbiguous: finalIsAmbiguous,
        rangeConfidence,
        boxCohesion01,
        breakoutFailureRate,
        rangeOscillationScore,
        trendWeaknessScore,
        rangeReasonLabel,
        regimeExitRisk,
        detail: baseDetail({ prevRegime }),
        log: makeLog({
            regimeRaw: regimeOut,
            regimeFinal: regimeOut,
            noTradeReason: null,
            unknownReason: null,
            dataReady: true,
            dumpHit: false,
            volHit: false
        }),
        boxBreakSide: "none",
        regimeState: (() => {
            if (regimeOut === "NO_TRADE")
                return "NO_TRADE";
            // [V2 HARDENING] Directional Shock / Trend State Overrides
            if (shockDownRisk) {
                if (regimeOut === "RANGE")
                    return "DOWN_SHOCK_CONSOLIDATION";
                if (regimeOut === "TREND")
                    return "TREND_DOWN";
                return "SHOCK_DOWN";
            }
            if (bias === "down" && regimeOut === "TREND")
                return "TREND_DOWN";
            if (bias === "up" && regimeOut === "TREND")
                return "TREND_UP";
            return regimeOut;
        })()
    };
}
