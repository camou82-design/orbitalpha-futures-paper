"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectMarketRegime = detectMarketRegime;
exports.emitRangeDriftStateProof = emitRangeDriftStateProof;
const types_1 = require("../../models/types");
const math_1 = require("../../utils/math");
function classifyShockPhase(input) {
    const shock = input.state.directionalShockState ?? "NONE";
    const crashState = String(input.state.crashState ?? "").toUpperCase();
    const pumpState = String(input.state.pumpState ?? input.state.pump_state ?? "").toUpperCase();
    if (shock === "DOWN")
        return "DOWN_SHOCK";
    if (shock === "UP")
        return "UP_SHOCK";
    if (crashState.includes("RECOVERY") || crashState.includes("REDUCE"))
        return "CRASH_RECOVERY";
    if (pumpState.includes("RECOVERY") || pumpState.includes("REDUCE"))
        return "PUMP_RECOVERY";
    return "NONE";
}
function computeSlopesFromCandles(candles) {
    if (!candles || candles.length < 40)
        return null;
    // Use two windows: recent 20 vs previous 20 (total 40)
    // Or scale up to 60 vs 60 if available.
    const fullSize = Math.min(120, candles.length);
    const halfSize = Math.floor(fullSize / 2);
    const recent = candles.slice(-halfSize);
    const older = candles.slice(-2 * halfSize, -halfSize);
    if (recent.length < 20 || older.length < 20)
        return null;
    const recentAvgHigh = recent.reduce((sum, c) => sum + c.high, 0) / recent.length;
    const recentAvgLow = recent.reduce((sum, c) => sum + c.low, 0) / recent.length;
    const recentAvgClose = recent.reduce((sum, c) => sum + c.close, 0) / recent.length;
    const recentAvgCenter = (recentAvgHigh + recentAvgLow) / 2;
    const olderAvgHigh = older.reduce((sum, c) => sum + c.high, 0) / older.length;
    const olderAvgLow = older.reduce((sum, c) => sum + c.low, 0) / older.length;
    const olderAvgClose = older.reduce((sum, c) => sum + c.close, 0) / older.length;
    const olderAvgCenter = (olderAvgHigh + olderAvgLow) / 2;
    // Scale to "per candle" roughly to match engine expectations
    const bhSlope = ((recentAvgHigh - olderAvgHigh) / olderAvgHigh) / halfSize;
    const blSlope = ((recentAvgLow - olderAvgLow) / olderAvgLow) / halfSize;
    const rcSlope = ((recentAvgCenter - olderAvgCenter) / olderAvgCenter) / halfSize;
    const e20Slope = ((recentAvgClose - olderAvgClose) / olderAvgClose) / halfSize;
    return { bhSlope, blSlope, rcSlope, e20Slope, windowSize: halfSize };
}
function computeMedian(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function classifyRangePhase(input, symbol) {
    const sn = input.snapshot;
    const boxPos = Number(sn.boxPos ?? 0.5);
    const boxBreakSide = sn.boxBreakSide ?? "none";
    const emaGap = Number(sn.emaGap ?? 0);
    const breakoutFailureRate = Number(sn.breakoutFailureRate ?? 0);
    const rangeOscillationScore = Number(sn.rangeOscillationScore ?? 0);
    const boxCohesion = Number(sn.boxCohesion01 ?? 0);
    const trendWeakness = Number(sn.trendWeaknessScore ?? 1);
    const reviewingTicks = sn.reviewing_ticks ?? 0;
    // --- Volume Analysis ---
    let volumeMedian60 = 0;
    let volumeExpansion = 1;
    if (sn.candles && sn.candles.length > 0) {
        const volWindow = sn.candles.slice(-60).map((c) => c.volume);
        volumeMedian60 = computeMedian(volWindow);
        if (volumeMedian60 > 0) {
            volumeExpansion = (sn.candles[sn.candles.length - 1].volume) / volumeMedian60;
        }
    }
    const atrExp = typeof sn.atrExpansion === "number" ? sn.atrExpansion : 0;
    // Phase 6: Drift & Channel Detection (PRIORITY 1: STRUCTURE)
    let bhSlope = typeof sn.boxHighSlope === "number" ? sn.boxHighSlope : 0;
    let blSlope = typeof sn.boxLowSlope === "number" ? sn.boxLowSlope : 0;
    let rcSlope = typeof sn.rangeCenterSlope === "number" ? sn.rangeCenterSlope : 0;
    let e20Slope = typeof sn.ema20Slope === "number" ? sn.ema20Slope : 0;
    let source = "snapshot";
    // Fallback if snapshot slopes are zero or null
    if (bhSlope === 0 && blSlope === 0 && sn.candles && sn.candles.length >= 40) {
        const computed = computeSlopesFromCandles(sn.candles);
        if (computed) {
            bhSlope = computed.bhSlope;
            blSlope = computed.blSlope;
            rcSlope = computed.rcSlope;
            e20Slope = computed.e20Slope;
            source = `computed_from_candles_${computed.windowSize}`;
        }
    }
    const slopeMetadata = { bhSlope, blSlope, rcSlope, e20Slope, source };
    // --- VOLUME-BASED BREAKOUT / BREAKDOWN (Priority 1) ---
    const isVolumeExpansionValid = volumeExpansion >= 2.0;
    const isAtrExpansionValid = atrExp >= 1.2;
    const isStructuralCohesionValid = boxCohesion >= 0.7 || rangeOscillationScore >= 0.6;
    if (boxBreakSide === "lower" && isVolumeExpansionValid && isAtrExpansionValid && isStructuralCohesionValid) {
        if (reviewingTicks >= 6) {
            const retestLevel = (sn.boxLow ?? 0);
            const candles = sn.candles ?? [];
            const recentWindow = candles.slice(-12);
            // 1. Retest Touched: Price approached the retestLevel (boxLow) from below
            const retestTouched = recentWindow.some((c) => c.high >= retestLevel * 0.998);
            // 2. Retest Rejected: Price failed to close back above retestLevel * 1.001
            const retestRejected = sn.lastPrice <= retestLevel * 1.001;
            // 3. Retest Confirmed: Price is showing weakness (slopes down or emaGap negative)
            const retestConfirmed = (rcSlope < 0 || emaGap < 0);
            // 4. Chase Distance: Don't enter if price is too far below retestLevel
            const distanceFromRetestPct = (retestLevel - sn.lastPrice) / retestLevel;
            const chaseDistanceBlocked = distanceFromRetestPct > 0.005; // 0.5% ?? ???? ??
            const retestMetadata = {
                ...slopeMetadata,
                retestLevel,
                retestTouched,
                retestRejected,
                retestConfirmed,
                distanceFromRetestPct,
                chaseDistanceBlocked,
                limitPct: 0.005
            };
            if (sn.lastPrice > retestLevel * 1.005) {
                return { phase: "FAKE_VOLUME_BREAKDOWN", metadata: retestMetadata };
            }
            if (retestTouched && retestRejected && retestConfirmed && !chaseDistanceBlocked) {
                return { phase: "BREAKDOWN_RETEST_FAILED", metadata: retestMetadata };
            }
            // If not fully confirmed, return observation phase with metadata
            return { phase: "VOLUME_BREAKDOWN_OBSERVATION", metadata: retestMetadata };
        }
        return { phase: volumeExpansion >= 3.0 ? "VOLUME_SHOCK_DOWN" : "VOLUME_BREAKDOWN_OBSERVATION", metadata: slopeMetadata };
    }
    if (boxBreakSide === "upper" && isVolumeExpansionValid && isAtrExpansionValid && isStructuralCohesionValid) {
        if (reviewingTicks >= 6) {
            const retestLevel = (sn.boxHigh ?? 0);
            const candles = sn.candles ?? [];
            const recentWindow = candles.slice(-12);
            // 1. Retest Touched: Price approached the retestLevel (boxHigh) from above
            const retestTouched = recentWindow.some((c) => c.low <= retestLevel * 1.002);
            // 2. Retest Rejected: Price failed to break back down into the box
            const retestRejected = sn.lastPrice >= retestLevel * 0.999;
            // 3. Retest Confirmed: Price is showing strength (slopes up or emaGap positive)
            const retestConfirmed = (rcSlope > 0 || emaGap > 0);
            // 4. Chase Distance: Don't enter if price is too far above retestLevel
            const distanceFromRetestPct = (sn.lastPrice - retestLevel) / retestLevel;
            const chaseDistanceBlocked = distanceFromRetestPct > 0.005;
            const retestMetadata = {
                ...slopeMetadata,
                retestLevel,
                retestTouched,
                retestRejected,
                retestConfirmed,
                distanceFromRetestPct,
                chaseDistanceBlocked,
                limitPct: 0.005
            };
            if (sn.lastPrice < retestLevel * 0.995) {
                return { phase: "FAKE_VOLUME_BREAKOUT", metadata: retestMetadata };
            }
            if (retestTouched && retestRejected && retestConfirmed && !chaseDistanceBlocked) {
                return { phase: "BREAKOUT_RETEST_CONFIRMED_VOLUME", metadata: retestMetadata };
            }
            return { phase: "VOLUME_BREAKOUT_OBSERVATION", metadata: retestMetadata };
        }
        return { phase: volumeExpansion >= 3.0 ? "VOLUME_SHOCK_UP" : "VOLUME_BREAKOUT_OBSERVATION", metadata: slopeMetadata };
    }
    // --- BOX QUALITY & DISTORTION VALIDATION (Hardening) ---
    const boxHigh = Number(sn.boxHigh ?? 0);
    const boxLow = Number(sn.boxLow ?? 0);
    const boxMid = (boxHigh + boxLow) / 2;
    const boxHeight = boxHigh - boxLow;
    const atr = Number(sn.atr ?? 0);
    // 1. Height Distortion: Box height should not be excessively larger than recent volatility
    const distortionFactor = atr > 0 ? boxHeight / atr : 0;
    const isDistorted = distortionFactor > 15.0; // ATR ???15?????? ? ?????? (?? ??)
    if (isDistorted) {
        console.warn(JSON.stringify({
            event: "V2_RANGE_BOX_HEIGHT_DISTORTION_PROOF",
            symbol,
            boxHeight,
            atr,
            distortionFactor,
            detail: "Box height is excessively large compared to ATR. Mean reversion reliability is LOW."
        }));
    }
    // 2. Slope Distortion: Drifting boxes
    const slopeMagnitude = Math.max(Math.abs(bhSlope), Math.abs(blSlope));
    const isDrifting = slopeMagnitude > 0.00015; // ?? ??? ?? ??????????
    // 3. Quality Proof
    console.info(JSON.stringify({
        event: "V2_RANGE_BOX_QUALITY_PROOF",
        symbol,
        boxHigh,
        boxLow,
        boxMid,
        boxHeight,
        distortionFactor,
        bhSlope,
        blSlope,
        isDistorted,
        isDrifting
    }));
    if (isDistorted || isDrifting) {
        console.warn(JSON.stringify({
            event: "V2_RANGE_MEAN_REVERSION_DISABLED_BY_BOX_DISTORTION_PROOF",
            symbol,
            reason: isDistorted ? "HEIGHT_DISTORTION" : "SLOPE_DISTORTION",
            distortionFactor,
            slopeMagnitude
        }));
    }
    // --- PHASE CLASSIFICATION ---
    const driftDown = bhSlope < -0.00005 && blSlope < -0.00005 && e20Slope < -0.00005;
    const driftUp = bhSlope > 0.00005 && blSlope > 0.00005 && e20Slope > 0.00005;
    const channelDown = driftDown && rcSlope < -0.0001;
    const channelUp = driftUp && rcSlope > 0.0001;
    let phase = "MID";
    if ((driftDown || channelDown) && (sn.lastPrice > (sn.boxHigh ?? 0) || (sn.swingHighSlope ?? 0) > 0.0005 || atrExp > 1.5)) {
        phase = "REVERSAL_UP_WATCH";
    }
    else if ((driftUp || channelUp) && (sn.lastPrice < (sn.boxLow ?? 0) || (sn.swingLowSlope ?? 0) < -0.0005 || atrExp > 1.5)) {
        phase = "REVERSAL_DOWN_WATCH";
    }
    else if (channelDown) {
        phase = "DESCENDING_CHANNEL";
    }
    else if (channelUp) {
        phase = "ASCENDING_CHANNEL";
    }
    else if (driftDown) {
        phase = "DRIFT_DOWN";
    }
    else if (driftUp) {
        phase = "DRIFT_UP";
    }
    else if (rangeOscillationScore >= 0.75 && breakoutFailureRate >= 0.6) {
        phase = "COMPRESSION";
    }
    else if (boxCohesion >= 0.85 && trendWeakness >= 0.7 && rangeOscillationScore >= 0.5) {
        phase = "TRIANGLE_SQUEEZE";
    }
    else if (boxBreakSide !== "none" && breakoutFailureRate < 0.4 && reviewingTicks < 12) {
        phase = "BREAKOUT_OBSERVATION";
    }
    else if (breakoutFailureRate >= 0.6) {
        phase = "FAKE_BREAKOUT";
    }
    else if (boxBreakSide === "lower" && emaGap < 0) {
        phase = "BREAKDOWN";
    }
    else if (boxBreakSide === "upper" && emaGap > 0) {
        phase = "BREAKOUT";
    }
    else if (Math.abs(bhSlope) < 0.00003 && Math.abs(blSlope) < 0.00003) {
        phase = "FLAT";
    }
    else {
        phase = (0, types_1.classifyRangeZone)(boxPos).toUpperCase();
    }
    return {
        phase,
        metadata: {
            ...slopeMetadata,
            isDistorted,
            isDrifting,
            distortionFactor,
            boxHigh,
            boxLow,
            boxMid
        }
    };
}
function classifyTrendPhase(sn) {
    const emaGap = Number(sn.emaGap ?? 0);
    const tw = Number(sn.trendWeaknessScore ?? 1);
    if (tw >= 0.65)
        return "EXHAUSTION";
    if (tw >= 0.4)
        return "PULLBACK";
    if (emaGap > 0)
        return "UP";
    if (emaGap < 0)
        return "DOWN";
    return "NONE";
}
function classifyTransitionPhase(rangeScore, trendScore, boxCohesionCollapse, mixedBreakoutState, trendWeaknessScore, input) {
    const sn = input.snapshot;
    const rangeToTrend = rangeScore > 0.4 &&
        rangeScore < 0.7 &&
        trendScore >= 0.6 &&
        boxCohesionCollapse;
    const trendToRange = trendWeaknessScore > 0.6 && rangeScore >= 0.6;
    // Phase 5: Breakout Retest Confirmation (Standard 12-tick rule)
    if (sn.boxBreakSide !== "none" && (sn.reviewing_ticks ?? 0) >= 12) {
        return "RETEST_CONFIRMED";
    }
    if (rangeToTrend)
        return "RANGE_TO_TREND";
    if (trendToRange)
        return "TREND_TO_RANGE";
    if (mixedBreakoutState || boxCohesionCollapse)
        return "CONFLICT";
    return "NONE";
}
const WHIPSAW_RECHECK_MIN_SIGNALS = 2;
function volumeExpansionResolved(sn) {
    const direct = Number(sn.volumeExpansion);
    if (Number.isFinite(direct) && direct > 0)
        return direct;
    if (!sn.candles || sn.candles.length === 0)
        return 1;
    const volWindow = sn.candles.slice(-60).map((c) => c.volume);
    const median = computeMedian(volWindow.filter((v) => v > 0));
    const last = sn.candles[sn.candles.length - 1]?.volume ?? 0;
    return median > 0 ? last / median : 1;
}
function microReversalFromWindow(candles, bars) {
    if (candles.length < bars) {
        return {
            downThenRebound: false,
            upThenDrop: false,
            recentSwingDirection: "flat",
            reverseSwingDetected: false
        };
    }
    const w = candles.slice(-bars);
    const lows = w.map((c) => c.low);
    const highs = w.map((c) => c.high);
    const minL = Math.min(...lows);
    const maxH = Math.max(...highs);
    const range = maxH - minL;
    const thr = range > 0 ? 0.22 * range : 0;
    const minI = lows.indexOf(minL);
    const maxI = highs.indexOf(maxH);
    const last = w[w.length - 1].close;
    const first = w[0].open;
    const downThenRebound = minI < Math.floor(w.length / 2) && last > minL + thr;
    const upThenDrop = maxI < Math.floor(w.length / 2) && last < maxH - thr;
    const recentSwingDirection = last > first * 1.0003 ? "up" : last < first * 0.9997 ? "down" : "flat";
    return {
        downThenRebound,
        upThenDrop,
        recentSwingDirection,
        reverseSwingDetected: downThenRebound || upThenDrop
    };
}
function microReversalAggregate(htf, snapCandles) {
    const pack = htf ?? {};
    const candidates = [
        microReversalFromWindow(pack["5m"] ?? [], 6),
        microReversalFromWindow(pack["1m"] ?? [], 8),
        microReversalFromWindow(snapCandles ?? [], 8)
    ];
    const hit = candidates.find((c) => c.reverseSwingDetected);
    return hit ?? candidates[0] ?? { downThenRebound: false, upThenDrop: false, recentSwingDirection: "flat", reverseSwingDetected: false };
}
function evaluateFastTrendShift(args) {
    const { input, htfEntryPolicy, htfBias } = args;
    const { snapshot: sn, candles } = input;
    const lastPrice = sn.lastPrice;
    const res = {
        active: false,
        direction: "none",
        candidate: false,
        allowed: false,
        side: "none",
        reason: "",
        block_reason: "",
        higher_low_detected: false,
        higher_high_detected: false,
        lower_high_detected: false,
        lower_low_detected: false,
        box_mid_reclaimed: false,
        box_mid_lost: false,
        box_upper_breakout_hold: false,
        box_lower_breakdown_hold: false,
        ema_slope_shift: false,
        volume_expansion: false,
        baseSizeIntent: 0,
        stop_price: null,
        stop_basis: "none"
    };
    if (!candles || candles.length < 10)
        return res;
    const recent = candles.slice(-5);
    const prev = candles.slice(-10, -5);
    const lastCandle = recent[recent.length - 1];
    const recentHigh = Math.max(...recent.map(c => c.high));
    const prevHigh = Math.max(...prev.map(c => c.high));
    const recentLow = Math.min(...recent.map(c => c.low));
    const prevLow = Math.min(...prev.map(c => c.low));
    const boxMid = (sn.boxHigh && sn.boxLow) ? (sn.boxHigh + sn.boxLow) / 2 : null;
    const e20Slope = Number(sn.ema20Slope ?? 0);
    const volExp = Number(sn.volumeExpansion ?? 1);
    res.higher_low_detected = recentLow > prevLow;
    res.higher_high_detected = recentHigh > prevHigh;
    res.lower_high_detected = recentHigh < prevHigh;
    res.lower_low_detected = recentLow < prevLow;
    if (boxMid) {
        res.box_mid_reclaimed = lastPrice > boxMid && candles[candles.length - 2].close <= boxMid;
        res.box_mid_lost = lastPrice < boxMid && candles[candles.length - 2].close >= boxMid;
    }
    if (sn.boxHigh && lastPrice >= sn.boxHigh * 0.998) {
        const recentMin = Math.min(...recent.map(c => c.low));
        if (recentMin >= sn.boxHigh * 0.998)
            res.box_upper_breakout_hold = true;
    }
    if (sn.boxLow && lastPrice <= sn.boxLow * 1.002) {
        const recentMax = Math.max(...recent.map(c => c.high));
        if (recentMax <= sn.boxLow * 1.002)
            res.box_lower_breakdown_hold = true;
    }
    res.ema_slope_shift = Math.abs(e20Slope) > 0.0001;
    res.volume_expansion = volExp >= 1.5;
    const longHits = [];
    if (res.higher_low_detected)
        longHits.push("higher_low");
    if (res.higher_high_detected)
        longHits.push("higher_high");
    if (res.box_mid_reclaimed || (boxMid && lastPrice > boxMid))
        longHits.push("box_mid_ok");
    if (e20Slope > 0.0001)
        longHits.push("ema_up");
    if (res.box_upper_breakout_hold)
        longHits.push("upper_hold");
    if (res.volume_expansion && lastCandle.close > lastCandle.open)
        longHits.push("vol_up");
    const shortHits = [];
    if (res.lower_high_detected)
        shortHits.push("lower_high");
    if (res.lower_low_detected)
        shortHits.push("lower_low");
    if (res.box_mid_lost || (boxMid && lastPrice < boxMid))
        shortHits.push("box_mid_lost");
    if (e20Slope < -0.0001)
        shortHits.push("ema_down");
    if (res.box_lower_breakdown_hold)
        shortHits.push("lower_hold");
    if (res.volume_expansion && lastCandle.close < lastCandle.open)
        shortHits.push("vol_down");
    if (longHits.length >= 3) {
        res.candidate = true;
        res.active = true;
        res.direction = "long";
        res.side = "long";
        res.reason = longHits.join("|");
    }
    else if (shortHits.length >= 3) {
        res.candidate = true;
        res.active = true;
        res.direction = "short";
        res.side = "short";
        res.reason = shortHits.join("|");
    }
    // Stop calculation for probe
    if (res.active) {
        const atr = Number(sn.atr ?? 0);
        if (res.direction === "long") {
            res.stop_price = lastPrice - (atr * 1.5);
            res.stop_basis = "atr_1.5_probe_stop";
        }
        else {
            res.stop_price = lastPrice + (atr * 1.5);
            res.stop_basis = "atr_1.5_probe_stop";
        }
        res.baseSizeIntent = 0.32; // Default probe size
    }
    return res;
}
function evaluateEarlyLongProbe(args) {
    const { input, htfEntryPolicy, htfBias, shockPhase, crashState, fastShift } = args;
    const { state } = input;
    if (!state.longAllow)
        return { allowed: false, reason: "", block_reason: "LONG_NOT_ALLOWED", hits: [], metrics: {} };
    if (state.directionalShockState === "DOWN" || shockPhase === "DOWN_SHOCK") {
        return { allowed: false, reason: "", block_reason: "DOWN_SHOCK_ACTIVE", hits: [], metrics: {} };
    }
    const crashS = String(crashState ?? "").toUpperCase();
    if (crashS.includes("BLOCK") || crashS.includes("EXTREME") || crashS.includes("SUSPEND")) {
        return { allowed: false, reason: "", block_reason: "CRASH_BLOCK_ACTIVE", hits: [], metrics: {} };
    }
    const htfPolicyOk = ["ALLOW", "PROBE_ONLY", "LONG_ONLY_OR_NONE"].includes(htfEntryPolicy);
    if (!htfPolicyOk)
        return { allowed: false, reason: "", block_reason: `HTF_POLICY_REJECT: ${htfEntryPolicy}`, hits: [], metrics: {} };
    const allBearishLower = htfBias.m5 === "BEARISH" && htfBias.m15 === "BEARISH" && htfBias.h1 === "BEARISH" && htfBias.h4 === "BEARISH";
    if (allBearishLower && (htfBias.d1 === "BEARISH" || htfBias.d1 === "CONFLICT")) {
        return { allowed: false, reason: "", block_reason: "TOTAL_BEARISH_HTF", hits: [], metrics: {} };
    }
    if (!fastShift.active || fastShift.direction !== "long") {
        return { allowed: false, reason: "", block_reason: "FAST_SHIFT_LONG_INACTIVE", hits: [], metrics: {} };
    }
    return {
        allowed: true,
        reason: fastShift.reason,
        block_reason: "",
        hits: fastShift.reason.split("|"),
        metrics: {}
    };
}
function evaluateEarlyShortProbe(args) {
    const { input, htfEntryPolicy, htfBias, shockPhase, pumpState, fastShift } = args;
    const { snapshot: sn, state, candles } = input;
    if (!state.shortAllow)
        return { allowed: false, reason: "", block_reason: "SHORT_NOT_ALLOWED", hits: [], metrics: {} };
    if (state.directionalShockState === "UP" || shockPhase === "UP_SHOCK") {
        return { allowed: false, reason: "", block_reason: "UP_SHOCK_ACTIVE", hits: [], metrics: {} };
    }
    const pumpS = String(pumpState ?? "").toUpperCase();
    if (pumpS.includes("BLOCK") || pumpS.includes("EXTREME") || pumpS.includes("SUSPEND")) {
        return { allowed: false, reason: "", block_reason: "PUMP_BLOCK_ACTIVE", hits: [], metrics: {} };
    }
    const htfPolicyOk = ["ALLOW", "PROBE_ONLY", "SHORT_ONLY_OR_NONE"].includes(htfEntryPolicy);
    if (!htfPolicyOk)
        return { allowed: false, reason: "", block_reason: `HTF_POLICY_REJECT: ${htfEntryPolicy}`, hits: [], metrics: {} };
    const allBullishLower = htfBias.m5 === "BULLISH" && htfBias.m15 === "BULLISH" && htfBias.h1 === "BULLISH" && htfBias.h4 === "BULLISH";
    if (allBullishLower && (htfBias.d1 === "BULLISH" || htfBias.d1 === "CONFLICT")) {
        return { allowed: false, reason: "", block_reason: "TOTAL_BULLISH_HTF", hits: [], metrics: {} };
    }
    if (candles && candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        const isExhaustion = lastCandle.low < lastCandle.close && (lastCandle.close - lastCandle.low) > (lastCandle.high - lastCandle.close) * 2;
        if ((sn.boxPos ?? 0.5) < 0.1 && isExhaustion) {
            return { allowed: false, reason: "", block_reason: "LOWER_ZONE_EXHAUSTION", hits: [], metrics: {} };
        }
    }
    if (!fastShift.active || fastShift.direction !== "short") {
        return { allowed: false, reason: "", block_reason: "FAST_SHIFT_SHORT_INACTIVE", hits: [], metrics: {} };
    }
    return {
        allowed: true,
        reason: fastShift.reason,
        block_reason: "",
        hits: fastShift.reason.split("|"),
        metrics: {}
    };
}
function evaluateWhipsawShockRecheck(args) {
    const { input, shockPhase, rangePhase, transitionPhase, mixedBreakoutState, rangeMetadata, regimeFinal, noTradeReason } = args;
    if (regimeFinal === "NO_TRADE" && (noTradeReason === "DATA_NOT_READY" || noTradeReason === "DUMP_PROTECTION")) {
        return {
            active: false,
            isSoftWatch: false,
            hitCount: 0,
            hits: [],
            contextHits: [],
            retestConfirmed: true,
            reclaimConfirmed: true,
            internalTransitionPhase: transitionPhase,
            reverseSwingDetected: false,
            recentSwingDirection: "flat",
            boxOrbitChop: false,
            structuralHitCount: 0,
            contextHitCount: 0,
            confirmationWaitReasons: [],
            recheckTicks: 0
        };
    }
    const sn = input.snapshot;
    const htf = input.htf_candles ?? input.snapshot.htf_candles ?? {};
    const micro = microReversalAggregate(htf, sn.candles);
    const directional = input.state.directionalShockState ?? "NONE";
    const boxPos = Number(sn.boxPos ?? 0.5);
    const volExp = volumeExpansionResolved(sn);
    const breakoutFailureRate = Number(sn.breakoutFailureRate ?? 0);
    const reviewingTicks = Number(sn.reviewing_ticks ?? 0);
    const retestMeta = typeof rangeMetadata?.retestConfirmed === "boolean" ? rangeMetadata.retestConfirmed : undefined;
    const retestConfirmed = transitionPhase === "RETEST_CONFIRMED" || retestMeta === true;
    const crashS = String(input.state.crashState ?? "").toUpperCase();
    const pumpS = String(input.state.pumpState ?? input.state.pump_state ?? "").toUpperCase();
    const reclaimConfirmed = shockPhase === "NONE" &&
        (directional === "NONE" || directional === "UNKNOWN") &&
        !crashS.includes("RECOVERY") &&
        !pumpS.includes("RECOVERY");
    const zone = (0, types_1.classifyRangeZone)(boxPos);
    const boxOrbitChop = Number(sn.rangeOscillationScore ?? 0) >= 0.72 &&
        zone === "mid" &&
        sn.boxBreakSide !== "none" &&
        breakoutFailureRate >= 0.35;
    // --- Activation Logic Refinement ---
    const microHits = [];
    if (micro.downThenRebound)
        microHits.push("micro_down_then_rebound");
    if (micro.upThenDrop)
        microHits.push("micro_up_then_drop");
    const contextHits = [];
    if (directional === "UP" || directional === "DOWN")
        contextHits.push("directional_shock_state");
    // Add other context info if needed (e.g., pump_alert)
    if (pumpS.includes("ALERT") || crashS.includes("ALERT"))
        contextHits.push("pump_crash_alert");
    const otherStructuralHits = [];
    if (boxOrbitChop)
        otherStructuralHits.push("box_orbit_chop");
    if (sn.boxBreakSide !== "none" && (!retestConfirmed || !reclaimConfirmed))
        otherStructuralHits.push("box_break_unconfirmed");
    if (volExp >= 2.0)
        otherStructuralHits.push("volume_expansion_ge_2");
    if (breakoutFailureRate >= 0.4)
        otherStructuralHits.push("breakout_failure_rate_ge_0_4");
    if (mixedBreakoutState)
        otherStructuralHits.push("mixed_breakout_state");
    if (Number(sn.atrExpansion ?? 0) >= 1.5)
        otherStructuralHits.push("atr_expansion_ge_1_5");
    if (reviewingTicks >= 2)
        otherStructuralHits.push("recheck_repetition");
    const microHitCount = microHits.length;
    const otherStructuralHitCount = otherStructuralHits.length;
    const contextHitCount = contextHits.length;
    const structuralHits = [...microHits, ...otherStructuralHits];
    const hitCount = structuralHits.length;
    // RULE: Hard Block requires at least 1 micro reversal AND at least 1 other structural evidence
    let active = microHitCount >= 1 && otherStructuralHitCount >= 1;
    // Soft Watch: Micro reversal + context (directional shock) without heavy structural evidence
    const isSoftWatch = !active && microHitCount >= 1 && contextHitCount >= 1;
    // --- Deactivation (Release) Conditions ---
    if (active) {
        if (reviewingTicks >= 6) {
            const structuralVanished = structuralHits.length === 0;
            const releasedBySwing = !micro.reverseSwingDetected;
            const releasedByVol = volExp < 1.7; // Easing from 2.0 threshold
            const releasedByFailRate = breakoutFailureRate < 0.32; // Easing from 0.4 threshold
            const releasedByConfirmation = retestConfirmed || reclaimConfirmed;
            if (structuralVanished || releasedBySwing || releasedByVol || releasedByFailRate || releasedByConfirmation) {
                active = false;
            }
        }
        // Force release if structural evidence disappears entirely regardless of ticks
        if (structuralHits.length === 0) {
            active = false;
        }
    }
    const confirmationWaitReasons = [];
    if (!retestConfirmed)
        confirmationWaitReasons.push("retest_not_confirmed");
    if (!reclaimConfirmed)
        confirmationWaitReasons.push("reclaim_not_confirmed");
    if (reviewingTicks < 6)
        confirmationWaitReasons.push("reviewing_ticks_insufficient");
    const hits = structuralHits;
    let internalTransitionPhase = "WHIPSAW_RECHECK";
    if (!retestConfirmed)
        internalTransitionPhase = "SHOCK_RETEST_UNCONFIRMED";
    else if (!reclaimConfirmed)
        internalTransitionPhase = "SHOCK_RECLAIM_RECHECK";
    return {
        active,
        isSoftWatch,
        hitCount,
        hits,
        contextHits,
        confirmationWaitReasons,
        retestConfirmed,
        reclaimConfirmed,
        internalTransitionPhase,
        reverseSwingDetected: micro.reverseSwingDetected,
        recentSwingDirection: micro.recentSwingDirection,
        boxOrbitChop,
        structuralHitCount: otherStructuralHitCount,
        contextHitCount,
        recheckTicks: reviewingTicks
    };
}
function selectSubtype(args) {
    const { regimeFinal, noTradeReason, shockPhase, rangePhase, trendPhase, transitionPhase } = args;
    if (regimeFinal === "NO_TRADE") {
        if (noTradeReason === "DATA_NOT_READY")
            return { subtype: "NO_TRADE_DATA_NOT_READY", subtypeReason: "no_trade_data_not_ready" };
        if (noTradeReason === "DUMP_PROTECTION")
            return { subtype: "NO_TRADE_DUMP_PROTECTION", subtypeReason: "no_trade_dump_protection" };
        return { subtype: "NO_TRADE_METRICS_INSUFFICIENT", subtypeReason: "no_trade_metrics_insufficient" };
    }
    if (shockPhase === "DOWN_SHOCK")
        return { subtype: "SHOCK_REACTION_DOWN", subtypeReason: "directional_shock_down" };
    if (shockPhase === "UP_SHOCK")
        return { subtype: "SHOCK_REACTION_UP", subtypeReason: "directional_shock_up" };
    if (regimeFinal === "RANGE") {
        if (rangePhase === "COMPRESSION")
            return { subtype: "RANGE_COMPRESSION", subtypeReason: "range_oscillation_high_compression" };
        if (rangePhase === "TRIANGLE_SQUEEZE")
            return { subtype: "TRIANGLE_SQUEEZE_CANDIDATE", subtypeReason: "triangle_squeeze_cohesion_high" };
        if (rangePhase === "BREAKOUT_OBSERVATION")
            return { subtype: "BREAKOUT_OBSERVATION", subtypeReason: "breakout_observation_ticks_low" };
        if (rangePhase === "FAKE_BREAKOUT")
            return { subtype: "RANGE_FAKE_BREAKOUT", subtypeReason: "range_fake_breakout_failure_rate_high" };
        if (rangePhase === "BREAKDOWN")
            return { subtype: "RANGE_BREAKDOWN_CANDIDATE", subtypeReason: "range_breakdown_candidate" };
        if (rangePhase === "BREAKOUT")
            return { subtype: "RANGE_BREAKOUT_CANDIDATE", subtypeReason: "range_breakout_candidate" };
        if (rangePhase === "LOWER")
            return { subtype: "RANGE_LOWER_REACTION", subtypeReason: "range_lower_reaction" };
        if (rangePhase === "UPPER")
            return { subtype: "RANGE_UPPER_REACTION", subtypeReason: "range_upper_reaction" };
        if (rangePhase === "FLAT")
            return { subtype: "RANGE_FLAT", subtypeReason: "range_flat_structure" };
        if (rangePhase === "DRIFT_DOWN")
            return { subtype: "RANGE_DRIFT_DOWN", subtypeReason: "range_drift_down_structure" };
        if (rangePhase === "DRIFT_UP")
            return { subtype: "RANGE_DRIFT_UP", subtypeReason: "range_drift_up_structure" };
        if (rangePhase === "DESCENDING_CHANNEL")
            return { subtype: "DESCENDING_CHANNEL", subtypeReason: "descending_channel_structure" };
        if (rangePhase === "ASCENDING_CHANNEL")
            return { subtype: "ASCENDING_CHANNEL", subtypeReason: "ascending_channel_structure" };
        if (rangePhase === "REVERSAL_UP_WATCH")
            return { subtype: "DRIFT_REVERSAL_UP_WATCH", subtypeReason: "drift_reversal_up_detected" };
        if (rangePhase === "REVERSAL_DOWN_WATCH")
            return { subtype: "DRIFT_REVERSAL_DOWN_WATCH", subtypeReason: "drift_reversal_down_detected" };
        if (rangePhase === "VOLUME_BREAKDOWN_OBSERVATION")
            return { subtype: "VOLUME_BREAKDOWN_OBSERVATION", subtypeReason: "volume_breakdown_observation" };
        if (rangePhase === "VOLUME_SHOCK_DOWN")
            return { subtype: "VOLUME_SHOCK_DOWN", subtypeReason: "volume_shock_down" };
        if (rangePhase === "BREAKDOWN_RETEST_FAILED")
            return { subtype: "BREAKDOWN_RETEST_FAILED", subtypeReason: "breakdown_retest_failed_volume" };
        if (rangePhase === "FAKE_VOLUME_BREAKDOWN")
            return { subtype: "FAKE_VOLUME_BREAKDOWN", subtypeReason: "fake_volume_breakdown_detected" };
        if (rangePhase === "VOLUME_BREAKOUT_OBSERVATION")
            return { subtype: "VOLUME_BREAKOUT_OBSERVATION", subtypeReason: "volume_breakout_observation" };
        if (rangePhase === "VOLUME_SHOCK_UP")
            return { subtype: "VOLUME_SHOCK_UP", subtypeReason: "volume_shock_up" };
        if (rangePhase === "BREAKOUT_RETEST_CONFIRMED_VOLUME")
            return { subtype: "BREAKOUT_RETEST_CONFIRMED_VOLUME", subtypeReason: "breakout_retest_confirmed_volume" };
        if (rangePhase === "FAKE_VOLUME_BREAKOUT")
            return { subtype: "FAKE_VOLUME_BREAKOUT", subtypeReason: "fake_volume_breakout_detected" };
        return { subtype: "RANGE_MID_CHOP", subtypeReason: "range_mid_chop" };
    }
    if (regimeFinal === "TREND") {
        if (transitionPhase === "RETEST_CONFIRMED")
            return { subtype: "BREAKOUT_RETEST_CONFIRMED", subtypeReason: "breakout_retest_confirmed_ticks_met" };
        if (trendPhase === "EXHAUSTION")
            return { subtype: "TREND_EXHAUSTION", subtypeReason: "trend_exhaustion" };
        if (trendPhase === "PULLBACK")
            return { subtype: "TREND_PULLBACK", subtypeReason: "trend_pullback" };
        if (trendPhase === "DOWN")
            return { subtype: "TREND_DOWN_CONTINUATION", subtypeReason: "trend_down_continuation" };
        return { subtype: "TREND_UP_CONTINUATION", subtypeReason: "trend_up_continuation" };
    }
    if (transitionPhase === "RANGE_TO_TREND")
        return { subtype: "TRANSITION_RANGE_TO_TREND", subtypeReason: "transition_range_to_trend" };
    if (transitionPhase === "TREND_TO_RANGE")
        return { subtype: "TRANSITION_TREND_TO_RANGE", subtypeReason: "transition_trend_to_range" };
    return { subtype: "TRANSITION_CONFLICT", subtypeReason: "transition_conflict" };
}
function calculateSingleTimeframeBias(candles, symbol, tfLabel) {
    if (!candles || candles.length < 60)
        return "DATA_NOT_READY";
    const closes = candles.map((c) => c.close);
    const ema20 = (0, math_1.emaLastFromCloses)(closes, 20);
    const ema60 = (0, math_1.emaLastFromCloses)(closes, 60);
    if (ema20 === null || ema60 === null) {
        if (candles.length >= 60) {
            console.warn(JSON.stringify({
                event: "HTF_BIAS_UNEXPECTED_DATA_NOT_READY_PROOF",
                symbol,
                tf: tfLabel,
                candle_count: candles.length,
                ema20_null: ema20 === null,
                ema60_null: ema60 === null
            }));
        }
        return "DATA_NOT_READY";
    }
    // Recent structure (High/Low)
    const recent30 = candles.slice(-30);
    const high30 = Math.max(...recent30.map(c => c.high));
    const low30 = Math.min(...recent30.map(c => c.low));
    // Slopes
    const prevEma20 = (0, math_1.emaLastFromCloses)(closes.slice(0, -1), 20);
    const ema20Slope = prevEma20 ? (ema20 - prevEma20) / prevEma20 : 0;
    const lastPrice = closes[closes.length - 1];
    // Simple bias logic
    const isBullish = lastPrice > ema20 && ema20 > ema60 && ema20Slope > 0.00005;
    const isBearish = lastPrice < ema20 && ema20 < ema60 && ema20Slope < -0.00005;
    if (isBullish)
        return "BULLISH";
    if (isBearish)
        return "BEARISH";
    // Range if between EMAs or flat
    if (Math.abs(ema20Slope) < 0.0001 || (lastPrice > Math.min(ema20, ema60) && lastPrice < Math.max(ema20, ema60))) {
        return "RANGE";
    }
    return "CONFLICT";
}
function deriveMacroPolarity(biases) {
    let bullishScore = 0;
    let bearishScore = 0;
    // Weighting: 1H(2), 4H(3), 1D(3) are more authoritative for macro polarity
    const weights = {
        m5: 1,
        m15: 1,
        h1: 2,
        h4: 3,
        d1: 3
    };
    for (const [tf, bias] of Object.entries(biases)) {
        const w = weights[tf] || 1;
        if (bias === "BULLISH")
            bullishScore += w;
        else if (bias === "BEARISH")
            bearishScore += w;
    }
    // Total possible score = 1+1+2+3+3 = 10
    // Threshold 5 ensures it's not just a minor noise
    if (bullishScore >= 5 && bullishScore > bearishScore)
        return "BULLISH";
    if (bearishScore >= 5 && bearishScore > bullishScore)
        return "BEARISH";
    return "NEUTRAL";
}
function calculateMacroBias(htfCandles, symbol) {
    const biases = {
        m5: calculateSingleTimeframeBias(htfCandles["5m"] || [], symbol, "5m"),
        m15: calculateSingleTimeframeBias(htfCandles["15m"] || [], symbol, "15m"),
        h1: calculateSingleTimeframeBias(htfCandles["1h"] || [], symbol, "1h"),
        h4: calculateSingleTimeframeBias(htfCandles["4h"] || [], symbol, "4h"),
        d1: calculateSingleTimeframeBias(htfCandles["1d"] || [], symbol, "1d")
    };
    let readyCount = 0;
    if (biases.m5 !== "DATA_NOT_READY")
        readyCount++;
    if (biases.m15 !== "DATA_NOT_READY")
        readyCount++;
    if (biases.h1 !== "DATA_NOT_READY")
        readyCount++;
    if (biases.h4 !== "DATA_NOT_READY")
        readyCount++;
    if (biases.d1 !== "DATA_NOT_READY")
        readyCount++;
    let source = "data_not_ready";
    if (readyCount === 5)
        source = "actual_candles";
    else if (readyCount > 0)
        source = "partial_actual_candles";
    else
        source = "data_not_ready";
    const conflict = (biases.m5 === "BULLISH" && biases.m15 === "BEARISH") || (biases.m5 === "BEARISH" && biases.m15 === "BULLISH");
    const macroPolarity = deriveMacroPolarity(biases);
    return { biases, source, conflict, macroPolarity };
}
function detectMarketRegime(input) {
    const { snapshot: sn } = input;
    const rangeScore = sn.rangeConfidence || 0;
    const trendScore = Math.abs(sn.emaGap || 0) * 1000; // Normalized
    const boxCohesionCollapse = (sn.boxCohesion01 || 0) < 0.3;
    const mixedBreakoutState = (sn.breakoutFailureRate || 0) > 0.4 && (sn.breakoutFailureRate || 0) < 0.7;
    const emaExpansionWeak = Math.abs(sn.emaGap || 0) > 0.0003 && (sn.trendWeaknessScore || 0) > 0.6;
    // Standard 3: Strict TRANSITION rule (Conflict-based Scouting)
    // Transition ONLY if scores reflect simultaneous indecision and structural conflict.
    const midRange = rangeScore > 0.4 && rangeScore < 0.7;
    const midTrend = trendScore > 0.4 && trendScore < 0.7;
    const structuralConflict = mixedBreakoutState || boxCohesionCollapse;
    let regime = "NO_TRADE";
    if (midRange && midTrend && structuralConflict) {
        regime = "TRANSITION";
    }
    else if (rangeScore > 0.6) {
        regime = "RANGE";
    }
    else if (trendScore > 0.7 && (sn.trendWeaknessScore || 0) < 0.5) {
        regime = "TREND";
    }
    let regime_final = regime;
    let no_trade_reason = null;
    const data_ready = sn.data_ready;
    const dump_protection_hit = sn.dump_protection_hit;
    const shockPhase = classifyShockPhase(input);
    const rangeResult = classifyRangePhase(input, input.symbol);
    const rangePhase = rangeResult.phase;
    const m = rangeResult.metadata;
    const trendPhase = classifyTrendPhase(sn);
    const transitionPhase = classifyTransitionPhase(rangeScore, trendScore, boxCohesionCollapse, mixedBreakoutState, Number(sn.trendWeaknessScore ?? 1), input);
    if (data_ready === false) {
        regime_final = "NO_TRADE";
        no_trade_reason = "DATA_NOT_READY";
    }
    else if (dump_protection_hit === true) {
        regime_final = "NO_TRADE";
        no_trade_reason = "DUMP_PROTECTION";
    }
    const htfPack = input.htf_candles ?? input.snapshot.htf_candles ?? {};
    const inputHtf = input.htf_candles;
    const snapHtf = input.snapshot?.htf_candles;
    console.info(JSON.stringify({
        event: "HTF_CANDLE_FETCH_PROOF",
        stage: "detector_input",
        symbol: input.symbol,
        htf_diagnostics: {
            "5m": { candle_count: (htfPack["5m"] ?? []).length },
            "15m": { candle_count: (htfPack["15m"] ?? []).length },
            "1h": { candle_count: (htfPack["1h"] ?? []).length },
            "4h": { candle_count: (htfPack["4h"] ?? []).length },
            "1d": { candle_count: (htfPack["1d"] ?? []).length }
        },
        input_htf_candles_keys: inputHtf ? Object.keys(inputHtf) : [],
        snapshot_htf_candles_keys: snapHtf ? Object.keys(snapHtf) : [],
        input_htf_per_tf_counts: inputHtf
            ? {
                "5m": (inputHtf["5m"] ?? []).length,
                "15m": (inputHtf["15m"] ?? []).length,
                "1h": (inputHtf["1h"] ?? []).length,
                "4h": (inputHtf["4h"] ?? []).length,
                "1d": (inputHtf["1d"] ?? []).length
            }
            : null,
        snapshot_htf_per_tf_counts: snapHtf
            ? {
                "5m": (snapHtf["5m"] ?? []).length,
                "15m": (snapHtf["15m"] ?? []).length,
                "1h": (snapHtf["1h"] ?? []).length,
                "4h": (snapHtf["4h"] ?? []).length,
                "1d": (snapHtf["1d"] ?? []).length
            }
            : null,
        effective_htf_pack_same_reference: inputHtf != null && snapHtf != null ? inputHtf === snapHtf : null
    }));
    const htfResult = calculateMacroBias(htfPack, input.symbol);
    const htfBias = htfResult.biases;
    const htfConflict = htfResult.conflict;
    const subtypeDecision = selectSubtype({
        regimeFinal: regime_final,
        noTradeReason: no_trade_reason,
        shockPhase,
        rangePhase,
        trendPhase,
        transitionPhase
    });
    // Mandatory Structure Classification Proof (Enhanced)
    console.info(JSON.stringify({
        event: "V2_RANGE_STRUCTURE_CLASSIFICATION_PROOF",
        symbol: input.symbol,
        slopeSource: m.source,
        finalBoxHighSlope: m.bhSlope,
        finalBoxLowSlope: m.blSlope,
        finalRangeCenterSlope: m.rcSlope,
        finalEma20Slope: m.e20Slope,
        rangePhase,
        subtype: subtypeDecision.subtype,
        classificationReason: subtypeDecision.subtypeReason
    }));
    // Re-emit slopes source for historical consistency if needed
    console.info(JSON.stringify({
        event: "V2_RANGE_SLOPE_SOURCE_PROOF",
        symbol: input.symbol,
        bhSlope: m.bhSlope,
        blSlope: m.blSlope,
        rcSlope: m.rcSlope,
        e20Slope: m.e20Slope,
        source: m.source,
        ts: Date.now()
    }));
    // Re-emit Volume Proofs based on detected phase
    if (rangePhase.includes("VOLUME") || rangePhase.includes("BREAKDOWN") || rangePhase.includes("BREAKOUT")) {
        const isShock = rangePhase.includes("SHOCK");
        const isRetest = rangePhase.includes("RETEST");
        const direction = (rangePhase.includes("BREAKOUT") || rangePhase.includes("UP")) ? "up" : "down";
        if (isRetest) {
            console.info(JSON.stringify({
                event: "V2_VOLUME_RETEST_STATE_PROOF",
                symbol: input.symbol,
                direction,
                lastPrice: sn.lastPrice,
                boxBoundary: direction === "up" ? sn.boxHigh : sn.boxLow,
                reviewingTicks: sn.reviewing_ticks,
                subtype: subtypeDecision.subtype
            }));
        }
        else {
            console.info(JSON.stringify({
                event: "V2_VOLUME_BREAKOUT_STATE_PROOF",
                symbol: input.symbol,
                direction,
                volumeExpansion: sn.volumeExpansion, // Assuming sn has it or calculate again
                atrExpansion: sn.atrExpansion,
                boxBreakSide: sn.boxBreakSide,
                subtype: subtypeDecision.subtype,
                action: "WATCH_RETEST"
            }));
        }
    }
    let counterTrendRisk = false;
    let htfSizeMultiplier = 1.0;
    let htfRequiresStrongerConfirmation = false;
    let htfPolicyReason = "HTF_ALIGNED";
    let htfHardBlockReason = "";
    // HTF Entry Policy Logic
    let htfEntryPolicy = "ALLOW";
    let expectedNextAction = "PROCEED_TO_EXECUTION";
    const isBearish = (tf) => htfBias[tf] === "BEARISH";
    const isBullish = (tf) => htfBias[tf] === "BULLISH";
    if (htfResult.source === "data_not_ready") {
        htfEntryPolicy = "NEUTRAL_HTF_DATA_WAIT";
        expectedNextAction = "WAIT_FOR_HTF_CANDLE_ACCUMULATION";
        htfPolicyReason = "HTF_DATA_NOT_READY";
        htfSizeMultiplier = 0.75;
        htfRequiresStrongerConfirmation = true;
    }
    else if (htfBias.m5 === "BULLISH") {
        let oppositeCount = 0;
        if (isBearish("m15"))
            oppositeCount++;
        if (isBearish("h1"))
            oppositeCount++;
        const is1hStrongOpposite = isBearish("h1");
        const isLowerWeakOrOpposite = (isBearish("m15") || htfBias.m15 === "RANGE" || htfBias.m15 === "CONFLICT");
        const h4d1Opposite = isBearish("h4") && isBearish("d1");
        if (oppositeCount >= 2 || (is1hStrongOpposite && isLowerWeakOrOpposite) || (h4d1Opposite && is1hStrongOpposite)) {
            htfEntryPolicy = "HOLD";
            expectedNextAction = "WAIT_FOR_HTF_ALIGNMENT";
            htfHardBlockReason = "STRONG_BEARISH_HTF_ALIGNMENT";
        }
        else if (htfBias.h1 === "CONFLICT" || htfBias.h1 === "RANGE") {
            htfEntryPolicy = "PROBE_ONLY";
            expectedNextAction = "SMALL_SIZE_PROBE_ALLOWED";
            htfSizeMultiplier = 0.5;
            htfPolicyReason = "H1_CONSOLIDATION";
        }
        if (isBearish("h4") || isBearish("d1")) {
            counterTrendRisk = true;
            if (htfEntryPolicy !== "HOLD") {
                htfEntryPolicy = "PROBE_ONLY";
                expectedNextAction = "REQUIRE_STRONG_RETEST_CONFIRMATION_AGAINST_MACRO";
                htfSizeMultiplier = 0.5;
                htfRequiresStrongerConfirmation = true;
                htfPolicyReason = "MACRO_BEARISH_RISK";
            }
        }
    }
    else if (htfBias.m5 === "BEARISH") {
        let oppositeCount = 0;
        if (isBullish("m15"))
            oppositeCount++;
        if (isBullish("h1"))
            oppositeCount++;
        const is1hStrongOpposite = isBullish("h1");
        const isLowerWeakOrOpposite = (isBullish("m15") || htfBias.m15 === "RANGE" || htfBias.m15 === "CONFLICT");
        const h4d1Opposite = isBullish("h4") && isBullish("d1");
        if (oppositeCount >= 2 || (is1hStrongOpposite && isLowerWeakOrOpposite) || (h4d1Opposite && is1hStrongOpposite)) {
            htfEntryPolicy = "HOLD";
            expectedNextAction = "WAIT_FOR_HTF_ALIGNMENT";
            htfHardBlockReason = "STRONG_BULLISH_HTF_ALIGNMENT";
        }
        else if (htfBias.h1 === "CONFLICT" || htfBias.h1 === "RANGE") {
            htfEntryPolicy = "PROBE_ONLY";
            expectedNextAction = "SMALL_SIZE_PROBE_ALLOWED";
            htfSizeMultiplier = 0.5;
            htfPolicyReason = "H1_CONSOLIDATION";
        }
        if (isBullish("h4") || isBullish("d1")) {
            counterTrendRisk = true;
            if (htfEntryPolicy !== "HOLD") {
                htfEntryPolicy = "PROBE_ONLY";
                expectedNextAction = "REQUIRE_STRONG_RETEST_CONFIRMATION_AGAINST_MACRO";
                htfSizeMultiplier = 0.5;
                htfRequiresStrongerConfirmation = true;
                htfPolicyReason = "MACRO_BULLISH_RISK";
            }
        }
    }
    // RANGE override: box/retest/reversal priority
    if (regime_final === "RANGE") {
        if (htfEntryPolicy === "HOLD" && !htfConflict) {
            htfEntryPolicy = "ALLOW"; // Range prioritization
            expectedNextAction = "RANGE_STRUCTURE_PRIORITY";
        }
    }
    // Shock Reaction policy
    if (shockPhase === "UP_SHOCK") {
        htfEntryPolicy = "LONG_ONLY_OR_NONE";
    }
    else if (shockPhase === "DOWN_SHOCK") {
        htfEntryPolicy = "SHORT_ONLY_OR_NONE";
    }
    // Polarity Invariant Check: Ensure policy doesn't hard-contradict macro trend
    const macroPolarity = htfResult.macroPolarity;
    let polarity_mismatch = false;
    if (macroPolarity === "BULLISH" && htfEntryPolicy === "SHORT_ONLY_OR_NONE") {
        polarity_mismatch = true;
        htfEntryPolicy = "HOLD"; // Downgrade absolute short-only to HOLD if macro is BULLISH
        htfPolicyReason = "POLARITY_MISMATCH_BULLISH_MACRO_LIMITS_SHORT_SHOCK";
        expectedNextAction = "WAIT_FOR_MACRO_ALIGNMENT_OR_STABILIZATION";
    }
    else if (macroPolarity === "BEARISH" && htfEntryPolicy === "LONG_ONLY_OR_NONE") {
        polarity_mismatch = true;
        htfEntryPolicy = "HOLD"; // Downgrade absolute long-only to HOLD if macro is BEARISH
        htfPolicyReason = "POLARITY_MISMATCH_BEARISH_MACRO_LIMITS_LONG_SHOCK";
        expectedNextAction = "WAIT_FOR_MACRO_ALIGNMENT_OR_STABILIZATION";
    }
    console.info(JSON.stringify({
        event: "V2_HTF_POLICY_POLARITY_INVARIANT_PROOF",
        symbol: String(input.symbol),
        macro_polarity: macroPolarity,
        raw_policy_before_invariant: shockPhase === "UP_SHOCK" ? "LONG_ONLY_OR_NONE" : (shockPhase === "DOWN_SHOCK" ? "SHORT_ONLY_OR_NONE" : "ALLOW"),
        final_policy: htfEntryPolicy,
        polarity_mismatch,
        shock_phase: shockPhase,
        h1_bias: htfBias.h1,
        h4_bias: htfBias.h4,
        d1_bias: htfBias.d1,
        counter_trend_risk: counterTrendRisk
    }));
    const whipsaw = evaluateWhipsawShockRecheck({
        input,
        shockPhase,
        rangePhase,
        transitionPhase,
        mixedBreakoutState,
        rangeMetadata: m,
        regimeFinal: regime_final,
        noTradeReason: no_trade_reason
    });
    const fastShift = evaluateFastTrendShift({
        input,
        htfEntryPolicy,
        htfBias
    });
    const earlyLongProbe = evaluateEarlyLongProbe({
        input,
        htfEntryPolicy,
        htfBias,
        shockPhase,
        crashState: String(input.state.crashState || ""),
        fastShift
    });
    const earlyShortProbe = evaluateEarlyShortProbe({
        input,
        htfEntryPolicy,
        htfBias,
        shockPhase,
        pumpState: String(input.state.pumpState || input.state.pump_state || ""),
        fastShift
    });
    let finalSubtype = subtypeDecision.subtype;
    let finalSubtypeReason = subtypeDecision.subtypeReason;
    // Fast Trend Shift override (Priority over probe)
    if (fastShift.active && finalSubtype !== "WHIPSAW_SHOCK_RECHECK") {
        if (regime_final === "RANGE" || regime_final === "TRANSITION") {
            finalSubtype = "FAST_TREND_SHIFT";
            finalSubtypeReason = `FAST_SHIFT_${fastShift.direction.toUpperCase()}: ${fastShift.reason}`;
            expectedNextAction = "SMALL_SIZE_PROBE_ALLOWED";
        }
    }
    // Early Probe override logic
    if (earlyLongProbe.allowed && finalSubtype !== "WHIPSAW_SHOCK_RECHECK" && finalSubtype !== "FAST_TREND_SHIFT") {
        const isStandardBlocked = finalSubtypeReason.includes("QUALITY_BELOW_THRESHOLD") ||
            finalSubtypeReason.includes("UPPER_REACTION") ||
            finalSubtypeReason.includes("SIDE_ZONE_MISMATCH") ||
            finalSubtypeReason.includes("WAIT_RETEST") ||
            finalSubtype === "RANGE_UPPER_REACTION" ||
            finalSubtype === "RANGE_MID_CHOP";
        if (isStandardBlocked || regime_final === "RANGE" || regime_final === "TRANSITION") {
            finalSubtype = "EARLY_LONG_PROBE";
            finalSubtypeReason = `EARLY_PROBE: ${earlyLongProbe.reason}`;
            expectedNextAction = "SMALL_SIZE_PROBE_ALLOWED";
        }
    }
    else if (earlyShortProbe.allowed && finalSubtype !== "WHIPSAW_SHOCK_RECHECK" && finalSubtype !== "FAST_TREND_SHIFT") {
        const isStandardBlocked = finalSubtypeReason.includes("QUALITY_BELOW_THRESHOLD") ||
            finalSubtypeReason.includes("LOWER_REACTION") ||
            finalSubtypeReason.includes("SIDE_ZONE_MISMATCH") ||
            finalSubtypeReason.includes("WAIT_RETEST") ||
            finalSubtype === "RANGE_LOWER_REACTION" ||
            finalSubtype === "RANGE_MID_CHOP" ||
            finalSubtypeReason.includes("LOWER_SHORT");
        if (isStandardBlocked || regime_final === "RANGE" || regime_final === "TRANSITION") {
            finalSubtype = "EARLY_SHORT_PROBE";
            finalSubtypeReason = `EARLY_PROBE: ${earlyShortProbe.reason}`;
            expectedNextAction = "SMALL_SIZE_PROBE_ALLOWED";
        }
    }
    let transitionPhaseOut = transitionPhase;
    let expectedNextActionOut = expectedNextAction;
    if (whipsaw.active) {
        finalSubtype = "WHIPSAW_SHOCK_RECHECK";
        finalSubtypeReason = `HARD_BLOCK: ${whipsaw.hits.join("|")}`;
        transitionPhaseOut = whipsaw.internalTransitionPhase;
        expectedNextActionOut = "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION";
    }
    else if (whipsaw.isSoftWatch) {
        finalSubtype = "WHIPSAW_SOFT_WATCH";
        finalSubtypeReason = `SOFT_WATCH: ${whipsaw.hits.join("|")} (context: ${whipsaw.contextHits.join("|")})`;
        transitionPhaseOut = whipsaw.internalTransitionPhase;
        expectedNextActionOut = "WAIT_RECHECK_SOFT_WATCH";
    }
    const volExpResolved = volumeExpansionResolved(sn);
    const atrExpResolved = typeof sn.atrExpansion === "number" && Number.isFinite(sn.atrExpansion) ? sn.atrExpansion : null;
    if (whipsaw.active || whipsaw.isSoftWatch) {
        console.info(JSON.stringify({
            event: "V2_WHIPSAW_SHOCK_RECHECK_PROOF",
            symbol: input.symbol,
            active: whipsaw.active,
            isSoftWatch: whipsaw.isSoftWatch,
            hits: whipsaw.hits,
            contextHits: whipsaw.contextHits,
            retestConfirmed: whipsaw.retestConfirmed,
            reclaimConfirmed: whipsaw.reclaimConfirmed,
            recheckTicks: whipsaw.recheckTicks,
            structuralHitCount: whipsaw.structuralHitCount,
            contextHitCount: whipsaw.contextHitCount,
            confirmationWaitReasons: whipsaw.confirmationWaitReasons
        }));
    }
    // Detailed Fast Trend Shift Probe Proof
    console.info(JSON.stringify({
        event: "V2_FAST_TREND_SHIFT_PROBE_PROOF",
        symbol: input.symbol,
        regime: regime_final,
        market_subtype: finalSubtype,
        boxPos: sn.boxPos,
        zone: (0, types_1.classifyRangeZone)(Number(sn.boxPos ?? 0.5)),
        fast_trend_shift_active: fastShift.active,
        fast_trend_direction: fastShift.direction,
        early_probe_candidate: fastShift.candidate,
        early_probe_allowed: earlyLongProbe.allowed || earlyShortProbe.allowed,
        early_probe_side: earlyLongProbe.allowed ? "long" : (earlyShortProbe.allowed ? "short" : "none"),
        early_probe_reason: earlyLongProbe.allowed ? earlyLongProbe.reason : earlyShortProbe.reason,
        early_probe_block_reason: earlyLongProbe.allowed ? "" : (earlyShortProbe.allowed ? "" : (earlyLongProbe.block_reason || earlyShortProbe.block_reason)),
        higher_low_detected: fastShift.higher_low_detected,
        higher_high_detected: fastShift.higher_high_detected,
        lower_high_detected: fastShift.lower_high_detected,
        lower_low_detected: fastShift.lower_low_detected,
        box_mid_reclaimed: fastShift.box_mid_reclaimed,
        box_mid_lost: fastShift.box_mid_lost,
        box_upper_breakout_hold: fastShift.box_upper_breakout_hold,
        box_lower_breakdown_hold: fastShift.box_lower_breakdown_hold,
        ema_slope_shift: fastShift.ema_slope_shift,
        volume_expansion: fastShift.volume_expansion,
        htf_entry_policy: htfEntryPolicy,
        counter_trend_risk: counterTrendRisk,
        baseSizeIntent: fastShift.active ? fastShift.baseSizeIntent : 0,
        stop_price: fastShift.stop_price,
        stop_basis: fastShift.stop_basis,
        final_decision: finalSubtype,
        final_side: (finalSubtype === "EARLY_LONG_PROBE" || (finalSubtype === "FAST_TREND_SHIFT" && fastShift.direction === "long")) ? "long" :
            ((finalSubtype === "EARLY_SHORT_PROBE" || (finalSubtype === "FAST_TREND_SHIFT" && fastShift.direction === "short")) ? "short" : "none")
    }));
    const output = {
        regime,
        regime_final,
        subtype: finalSubtype,
        subtypeReason: finalSubtypeReason,
        shockPhase,
        rangePhase,
        trendPhase,
        diagnostics: {
            structural_hit_count: whipsaw.structuralHitCount,
            context_hit_count: whipsaw.contextHitCount,
            structural_hits: whipsaw.hits,
            context_hits: whipsaw.contextHits,
            confirmation_wait_reasons: whipsaw.confirmationWaitReasons,
            early_probe: {
                allowed: earlyLongProbe.allowed || earlyShortProbe.allowed,
                reason: earlyLongProbe.allowed ? earlyLongProbe.reason : earlyShortProbe.reason,
                block_reason: earlyLongProbe.allowed ? "" : (earlyShortProbe.allowed ? "" : earlyLongProbe.block_reason),
                hits: earlyLongProbe.allowed ? earlyLongProbe.hits : earlyShortProbe.hits,
                counter_trend_risk: counterTrendRisk
            },
            fastTrendShift: {
                active: fastShift.active,
                direction: fastShift.direction,
                candidate: fastShift.candidate,
                allowed: earlyLongProbe.allowed || earlyShortProbe.allowed,
                side: earlyLongProbe.allowed ? "long" : (earlyShortProbe.allowed ? "short" : "none"),
                reason: fastShift.reason,
                block_reason: earlyLongProbe.allowed ? "" : (earlyShortProbe.allowed ? "" : (earlyLongProbe.block_reason || earlyShortProbe.block_reason)),
                higher_low_detected: fastShift.higher_low_detected,
                higher_high_detected: fastShift.higher_high_detected,
                lower_high_detected: fastShift.lower_high_detected,
                lower_low_detected: fastShift.lower_low_detected,
                box_mid_reclaimed: fastShift.box_mid_reclaimed,
                box_mid_lost: fastShift.box_mid_lost,
                box_upper_breakout_hold: fastShift.box_upper_breakout_hold,
                box_lower_breakdown_hold: fastShift.box_lower_breakdown_hold,
                ema_slope_shift: fastShift.ema_slope_shift,
                volume_expansion: fastShift.volume_expansion,
                baseSizeIntent: fastShift.baseSizeIntent,
                stop_price: fastShift.stop_price,
                stop_basis: fastShift.stop_basis
            }
        },
        transitionPhase: transitionPhaseOut,
        judgmentVersion: "v2_market_judgment_subtype_v1",
        no_trade_reason,
        data_ready,
        dump_protection_hit,
        volatility_guard_hit: sn.volatility_guard_hit,
        reason: regime_final === "NO_TRADE"
            ? `NO_TRADE: ${no_trade_reason ?? "METRICS_INSUFFICIENT"}`
            : (finalSubtype === "EARLY_LONG_PROBE" ? `EARLY_PROBE: ${earlyLongProbe.reason}` :
                finalSubtype === "EARLY_SHORT_PROBE" ? `EARLY_PROBE: ${earlyShortProbe.reason}` :
                    `Market detected as ${regime_final} based on score analysis`),
        metrics: {
            rangeScore,
            trendScore,
            boxCohesionCollapse,
            mixedBreakoutState,
            emaExpansionWeak
        },
        htf_bias: htfBias,
        macro_source: htfResult.source,
        macroPolarity,
        polarityMismatch: polarity_mismatch,
        daily_bias_actual: htfBias.d1,
        h4_bias_actual: htfBias.h4,
        h1_bias_actual: htfBias.h1,
        m15_bias_actual: htfBias.m15,
        m5_bias_actual: htfBias.m5,
        htf_conflict: htfConflict,
        counter_trend_risk: counterTrendRisk,
        htf_entry_policy: htfEntryPolicy,
        expected_next_action: expectedNextActionOut,
        htf_size_multiplier: htfSizeMultiplier,
        htf_requires_stronger_confirmation: htfRequiresStrongerConfirmation,
        htf_policy_reason: htfPolicyReason,
        htf_hard_block_reason: htfHardBlockReason,
        metadata: {
            whipsaw_shock_recheck_active: whipsaw.active,
            whipsaw_hit_count: whipsaw.hitCount,
            whipsaw_hits: whipsaw.hits,
            whipsaw_box_orbit_chop: whipsaw.boxOrbitChop,
            early_probe_allowed: earlyLongProbe.allowed || earlyShortProbe.allowed,
            early_probe_hits: earlyLongProbe.allowed ? earlyLongProbe.hits : earlyShortProbe.hits
        }
    };
    if (earlyLongProbe.allowed) {
        console.info(JSON.stringify({
            event: "V2_EARLY_LONG_PROBE_PROOF",
            symbol: input.symbol,
            regime,
            market_subtype: finalSubtype,
            boxPos: sn.boxPos,
            zone: (0, types_1.classifyRangeZone)(Number(sn.boxPos ?? 0.5)),
            htf_entry_policy: htfEntryPolicy,
            htf_5m_bias: htfBias.m5,
            htf_15m_bias: htfBias.m15,
            htf_1h_bias: htfBias.h1,
            htf_4h_bias: htfBias.h4,
            htf_1d_bias: htfBias.d1,
            directional_shock_state: input.state.directionalShockState ?? "NONE",
            longAllow: input.state.longAllow,
            shortAllow: input.state.shortAllow,
            early_probe_candidate: true,
            early_probe_allowed: earlyLongProbe.allowed,
            early_probe_reason: earlyLongProbe.reason,
            early_probe_block_reason: earlyLongProbe.block_reason,
            micro_recovery_hits: earlyLongProbe.hits,
            higher_low_detected: earlyLongProbe.hits.includes("higher_low"),
            higher_high_detected: earlyLongProbe.hits.includes("higher_high"),
            box_mid_reclaimed: earlyLongProbe.hits.includes("box_mid_reclaimed"),
            upper_follow_through: earlyLongProbe.hits.includes("upper_follow_through"),
            counter_trend_risk: counterTrendRisk,
            size_multiplier: htfSizeMultiplier,
            baseSizeIntent: finalSubtype === "EARLY_LONG_PROBE" ? 0.32 : 0,
            stop_basis: "conservative_probe_basis"
        }));
    }
    if (earlyShortProbe.allowed) {
        console.info(JSON.stringify({
            event: "V2_EARLY_SHORT_PROBE_PROOF",
            symbol: input.symbol,
            regime,
            market_subtype: finalSubtype,
            boxPos: sn.boxPos,
            zone: (0, types_1.classifyRangeZone)(Number(sn.boxPos ?? 0.5)),
            htf_entry_policy: htfEntryPolicy,
            htf_5m_bias: htfBias.m5,
            htf_15m_bias: htfBias.m15,
            htf_1h_bias: htfBias.h1,
            htf_4h_bias: htfBias.h4,
            htf_1d_bias: htfBias.d1,
            directional_shock_state: input.state.directionalShockState ?? "NONE",
            longAllow: input.state.longAllow,
            shortAllow: input.state.shortAllow,
            early_probe_candidate: true,
            early_probe_allowed: earlyShortProbe.allowed,
            early_probe_reason: earlyShortProbe.reason,
            early_probe_block_reason: earlyShortProbe.block_reason,
            micro_rejection_hits: earlyShortProbe.hits,
            lower_high_detected: earlyShortProbe.hits.includes("lower_high"),
            lower_low_detected: earlyShortProbe.hits.includes("lower_low"),
            box_mid_lost: earlyShortProbe.hits.includes("box_mid_lost"),
            lower_follow_through: earlyShortProbe.hits.includes("lower_follow_through"),
            counter_trend_risk: counterTrendRisk,
            size_multiplier: htfSizeMultiplier,
            baseSizeIntent: finalSubtype === "EARLY_SHORT_PROBE" ? 0.32 : 0,
            stop_basis: "conservative_probe_basis",
            final_decision: finalSubtype,
            final_side: finalSubtype === "EARLY_SHORT_PROBE" ? "short" : "none"
        }));
    }
    // Logging new events
    console.info(JSON.stringify({
        event: "V2_HTF_CANDLE_BIAS_PROOF",
        symbol: input.symbol,
        htf_5m_bias: htfBias.m5,
        htf_15m_bias: htfBias.m15,
        htf_1h_bias: htfBias.h1,
        htf_4h_bias: htfBias.h4,
        htf_1d_bias: htfBias.d1,
        macro_source: htfResult.source,
        daily_bias_actual: htfBias.d1,
        h4_bias_actual: htfBias.h4,
        h1_bias_actual: htfBias.h1,
        m15_bias_actual: htfBias.m15,
        m5_bias_actual: htfBias.m5,
        htf_conflict: htfConflict,
        counter_trend_risk: counterTrendRisk,
        htf_entry_policy: htfEntryPolicy,
        expected_next_action: expectedNextActionOut,
        htf_size_multiplier: htfSizeMultiplier,
        htf_requires_stronger_confirmation: htfRequiresStrongerConfirmation,
        htf_policy_reason: htfPolicyReason,
        htf_hard_block_reason: htfHardBlockReason
    }));
    if (htfResult.source === "actual_candles") {
        console.info(JSON.stringify({
            event: "V2_MACRO_BIAS_ACTUAL_CANDLES_PROOF",
            symbol: input.symbol,
            daily_bias_actual: htfBias.d1,
            h4_bias_actual: htfBias.h4,
            macro_source: htfResult.source,
            htf_entry_policy: htfEntryPolicy,
            counter_trend_risk: counterTrendRisk,
            htf_size_multiplier: htfSizeMultiplier,
            htf_requires_stronger_confirmation: htfRequiresStrongerConfirmation,
            htf_hard_block_reason: htfHardBlockReason
        }));
    }
    return output;
}
function emitRangeDriftStateProof(symbol, judgment, sn) {
    console.info(JSON.stringify({
        event: "V2_RANGE_DRIFT_STATE_PROOF",
        symbol,
        regime: judgment.regime_final,
        subtype: judgment.subtype,
        rangePhase: judgment.rangePhase,
        boxHighSlope: sn.boxHighSlope,
        boxLowSlope: sn.boxLowSlope,
        ema20Slope: sn.ema20Slope,
        atrExpansion: sn.atrExpansion,
        volumeExpansion: sn.volumeExpansion
    }));
}
