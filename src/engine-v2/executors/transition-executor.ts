import { EngineV2Input, ExecutorOutput, MarketJudgmentOutput, TransitionExecutorMetadata, TransitionSetupType } from "../types";
import { classifyRangeZone } from "../../models/types";
import {
    getClosedCandlesForStructuralStop,
    resolveFastTrendShiftStructuralStop
} from "../risk-sizing/fast-trend-shift-structural-stop";

// Transition Failure Layer Constants
const FAILURE_LOOKBACK_BARS = 12;
const MIN_OVEREXTENSION_ATR = 1.20;
const LATE_CHASE_ATR = 0.80;
const LATE_CHASE_PCT = 0.0035;
const STOP_BUFFER_ATR = 0.25;
const MIN_FAILURE_CONFIRMATIONS = 2;

function calculateRSI(closes: number[], period: number = 14): number {
    if (closes.length <= period) return 50;
    const slice = closes.slice(-(period + 1));
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < slice.length; i++) {
        const diff = slice[i] - slice[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - (100 / (1 + rs));
}

function calculateBB(closes: number[], period: number = 20, stdDev: number = 2) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const sd = Math.sqrt(variance);
    return {
        upper: mean + stdDev * sd,
        lower: mean - stdDev * sd,
        mean
    };
}

/**
 * Tier 4: Transition Executor (Refined)
 * Passive scouting and exploration only.
 */
export function executeTransitionRegime(input: EngineV2Input, judgment?: MarketJudgmentOutput): ExecutorOutput {
    const sn = input.snapshot;
    const st = input.state;
    // [V2 short setup diagnostic 용 변수 선언]
    let retestConfirmedShort = false;
    let reclaimConfirmedShort = false;

    const emaGap = Number(sn.emaGap ?? 0);
    const trendWeaknessScore = Number(sn.trendWeaknessScore ?? 1);
    const rangeConfidence = Number(sn.rangeConfidence ?? 0);
    const boxCohesion01 = Number(sn.boxCohesion01 ?? 0);
    const breakoutFailureRate = Number(sn.breakoutFailureRate ?? 0);
    const boxPos = Number(sn.boxPos ?? 0.5);
    const boxBreakSide = sn.boxBreakSide ?? "none";
    const qualityScore = Number(sn.qualityScore ?? 0);
    const reviewingTicks = Number(sn.reviewing_ticks ?? 0);
    const directionalShockState = st.directionalShockState ?? "NONE";
    const longAllow = st.longAllow !== false;
    const shortAllow = st.shortAllow !== false;
    const crashState = String(st.crashState ?? "NONE").toUpperCase();
    const pumpState = String(st.pumpState ?? st.pump_state ?? "NONE").toUpperCase();
    const isMidZone = classifyRangeZone(boxPos) === "mid";
    const breakoutConfirm = qualityScore >= 65 || reviewingTicks >= 1;
    const transitionPhase = judgment?.transitionPhase ?? "NONE";
    const subtype = judgment?.subtype ?? "TRANSITION_CONFLICT";

    // --- V2 TRANSITION FAILURE PROBE LAYER (NO_POSITION ONLY) ---
    const hasPosition = st.currentPositions && st.currentPositions.length > 0;
    const isTransitionRegime = judgment?.regime_final === "TRANSITION" || judgment?.regime_final === "NO_TRADE" || subtype === "TRANSITION_CONFLICT";

    if (!hasPosition && isTransitionRegime) {
        const candles = input.candles || sn.candles || [];
        if (candles.length >= 20) {
            const closes = candles.map(c => c.close);
            const rsi = calculateRSI(closes);
            const bb = calculateBB(closes);
            const atr = sn.atr || (sn.lastPrice * 0.01);
            const lastPrice = sn.lastPrice;
            const lastCandle = candles[candles.length - 1];
            const prevCandle = candles[candles.length - 2];
            
            const window12 = candles.slice(-FAILURE_LOOKBACK_BARS);
            const swingHigh = Math.max(...window12.map(c => c.high));
            const swingLow = Math.min(...window12.map(c => c.low));

            // 1. TOP FAILURE WATCH (SHORT)
            const topOverextended = (bb && (lastPrice >= bb.upper * 0.999 || prevCandle.high >= bb.upper)) || rsi >= 65 || (lastPrice >= swingLow + (atr * MIN_OVEREXTENSION_ATR));
            
            if (topOverextended && shortAllow && directionalShockState !== "UP") {
                const shortConfirms = [];
                if (lastPrice < swingHigh) shortConfirms.push("failed_high");
                if (lastCandle.high - Math.max(lastCandle.open, lastCandle.close) > (Math.max(lastCandle.open, lastCandle.close) - Math.min(lastCandle.open, lastCandle.close))) shortConfirms.push("upper_wick");
                if (lastCandle.close < prevCandle.low) shortConfirms.push("break_prev_low");
                if (sn.ema20 && lastPrice < sn.ema20) shortConfirms.push("below_ema20");
                if (rsi < calculateRSI(closes.slice(0, -1))) shortConfirms.push("rsi_turn");
                if (bb && prevCandle.high > bb.upper && lastPrice < bb.upper) shortConfirms.push("bb_reentry");

                const dropFromHigh = swingHigh - lastPrice;
                const lateChaseBlocked = dropFromHigh > (atr * LATE_CHASE_ATR) || dropFromHigh > (swingHigh * LATE_CHASE_PCT);
                
                // Pullback Retest Logic
                const retraceToEma = lastPrice >= (sn.ema20 || 0) * 0.999 && lastPrice <= (sn.ema20 || 0) * 1.002;
                const retestConfirmed = retraceToEma && lastCandle.close < lastCandle.open && shortConfirms.length >= 1;
                retestConfirmedShort = retestConfirmed;

                if (shortConfirms.length >= MIN_FAILURE_CONFIRMATIONS && !lateChaseBlocked) {
                    const stopPrice = swingHigh + (atr * STOP_BUFFER_ATR);
                    
                    // Final pre-flight: ensure we aren't filling against a renewed breakout
                    if (lastPrice < swingHigh * 1.0005) {
                        console.info(JSON.stringify({
                            event: "V2_TRANSITION_FAILURE_LAYER_PROOF",
                            symbol: input.symbol,
                            side: "short",
                            type: "EARLY_REVERSAL_SHORT_PROBE",
                            confirms: shortConfirms.join("|"),
                            price: lastPrice,
                            stopPrice
                        }));

                        return {
                            signal: "SHORT_CANDIDATE",
                            side: "short",
                            reason: "V2_TRANSITION_TOP_FAILURE_PROBE",
                            baseSizeIntent: 0.25,
                            recheckSuggested: false,
                            isAddOnEligible: false,
                            stopPrice,
                            invalidationPx: stopPrice,
                            metadata: { failure_layer: "top_failure", confirms: shortConfirms.length, rsi } as any
                        };
                    }
                } else if (lateChaseBlocked && retestConfirmed) {
                    const stopPrice = Math.max(swingHigh, lastCandle.high) + (atr * STOP_BUFFER_ATR);
                    console.info(JSON.stringify({
                        event: "V2_TRANSITION_FAILURE_LAYER_PROOF",
                        symbol: input.symbol,
                        side: "short",
                        type: "PULLBACK_RETEST_SHORT_CONFIRM",
                        price: lastPrice,
                        stopPrice
                    }));
                    return {
                        signal: "SHORT_CANDIDATE",
                        side: "short",
                        reason: "V2_TRANSITION_RETEST_FAILURE_PROBE",
                        baseSizeIntent: 0.25,
                        recheckSuggested: false,
                        isAddOnEligible: false,
                        stopPrice,
                        invalidationPx: stopPrice,
                        metadata: { failure_layer: "retest_failure", type: "short" } as any
                    };
                } else if (lateChaseBlocked) {
                    console.info(JSON.stringify({
                        event: "V2_TRANSITION_FAILURE_LAYER_PROOF",
                        symbol: input.symbol,
                        side: "short",
                        type: "LATE_SHORT_CHASE_BLOCK",
                        reason: "too_far_from_high"
                    }));
                }
            }

            // 2. BOTTOM FAILURE WATCH (LONG)
            const bottomOverextended = (bb && (lastPrice <= bb.lower * 1.001 || prevCandle.low <= bb.lower)) || rsi <= 35 || (lastPrice <= swingHigh - (atr * MIN_OVEREXTENSION_ATR));

            if (bottomOverextended && longAllow && directionalShockState !== "DOWN") {
                const longConfirms = [];
                if (lastPrice > swingLow) longConfirms.push("failed_low");
                if (Math.min(lastCandle.open, lastCandle.close) - lastCandle.low > (Math.max(lastCandle.open, lastCandle.close) - Math.min(lastCandle.open, lastCandle.close))) longConfirms.push("lower_wick");
                if (lastCandle.close > prevCandle.high) longConfirms.push("break_prev_high");
                if (sn.ema20 && lastPrice > sn.ema20) longConfirms.push("above_ema20");
                if (rsi > calculateRSI(closes.slice(0, -1))) longConfirms.push("rsi_turn");
                if (bb && prevCandle.low < bb.lower && lastPrice > bb.lower) longConfirms.push("bb_reentry");

                const riseFromLow = lastPrice - swingLow;
                const lateChaseBlocked = riseFromLow > (atr * LATE_CHASE_ATR) || riseFromLow > (swingLow * LATE_CHASE_PCT);

                const retraceToEma = lastPrice <= (sn.ema20 || 0) * 1.001 && lastPrice >= (sn.ema20 || 0) * 0.998;
                const retestConfirmed = retraceToEma && lastCandle.close > lastCandle.open && longConfirms.length >= 1;

                if (longConfirms.length >= MIN_FAILURE_CONFIRMATIONS && !lateChaseBlocked) {
                    const stopPrice = swingLow - (atr * STOP_BUFFER_ATR);
                    
                    if (lastPrice > swingLow * 0.9995) {
                        console.info(JSON.stringify({
                            event: "V2_TRANSITION_FAILURE_LAYER_PROOF",
                            symbol: input.symbol,
                            side: "long",
                            type: "EARLY_REVERSAL_LONG_PROBE",
                            confirms: longConfirms.join("|"),
                            price: lastPrice,
                            stopPrice
                        }));

                        return {
                            signal: "LONG_CANDIDATE",
                            side: "long",
                            reason: "V2_TRANSITION_BOTTOM_FAILURE_PROBE",
                            baseSizeIntent: 0.25,
                            recheckSuggested: false,
                            isAddOnEligible: false,
                            stopPrice,
                            invalidationPx: stopPrice,
                            metadata: { failure_layer: "bottom_failure", confirms: longConfirms.length, rsi } as any
                        };
                    }
                } else if (lateChaseBlocked && retestConfirmed) {
                    const stopPrice = Math.min(swingLow, lastCandle.low) - (atr * STOP_BUFFER_ATR);
                    console.info(JSON.stringify({
                        event: "V2_TRANSITION_FAILURE_LAYER_PROOF",
                        symbol: input.symbol,
                        side: "long",
                        type: "PULLBACK_RETEST_LONG_CONFIRM",
                        price: lastPrice,
                        stopPrice
                    }));
                    return {
                        signal: "LONG_CANDIDATE",
                        side: "long",
                        reason: "V2_TRANSITION_RETEST_FAILURE_PROBE",
                        baseSizeIntent: 0.25,
                        recheckSuggested: false,
                        isAddOnEligible: false,
                        stopPrice,
                        invalidationPx: stopPrice,
                        metadata: { failure_layer: "retest_failure", type: "long" } as any
                    };
                } else if (lateChaseBlocked) {
                    console.info(JSON.stringify({
                        event: "V2_TRANSITION_FAILURE_LAYER_PROOF",
                        symbol: input.symbol,
                        side: "long",
                        type: "LATE_LONG_CHASE_BLOCK",
                        reason: "too_far_from_low"
                    }));
                }
            }
        }
    }

    // [Whipsaw Exempt 로직 추가 - V2 transition short setup 연동]
    const isWhipsawExempt = (() => {
        if (subtype === "WHIPSAW_SOFT_WATCH") {
            const isShockDownTarget =
                directionalShockState === "DOWN" &&
                shortAllow &&
                emaGap < 0 &&
                classifyRangeZone(boxPos) === "lower";

            if (isShockDownTarget) {
                // 강력한 숏 셋업 충족 여부: boxBreakSide === "lower" && qualityScore >= 65
                const boxBreakConfirm = boxBreakSide === "lower" && qualityScore >= 65;
                if (boxBreakConfirm) {
                    return true;
                }
            }

            // WHIPSAW_SOFT_WATCH_DOWN_MID_SHORT_RETEST 분기
            const isMidShockDownTarget =
                directionalShockState === "DOWN" &&
                shortAllow &&
                classifyRangeZone(boxPos) === "mid";

            if (isMidShockDownTarget) {
                const breakdownRetestFailure =
                    judgment?.subtype === "BREAKDOWN_RETEST_FAILED" ||
                    judgment?.metadata?.retestConfirmed === true ||
                    judgment?.metadata?.breakdownRetestFailure === true ||
                    judgment?.diagnostics?.early_probe?.hits?.includes("retest_failure") ||
                    judgment?.diagnostics?.fastTrendShift?.reason?.includes("retest_failure");

                const boxMidLost =
                    judgment?.diagnostics?.fastTrendShift?.box_mid_lost === true ||
                    judgment?.diagnostics?.early_probe?.hits?.includes("box_mid_lost") ||
                    (sn.boxHigh != null && sn.boxLow != null && sn.lastPrice < (sn.boxHigh + sn.boxLow) / 2 && (sn.candles && sn.candles.length >= 2 && sn.candles[sn.candles.length - 2].close >= (sn.boxHigh + sn.boxLow) / 2));

                const lowerBreakdownHold =
                    judgment?.diagnostics?.fastTrendShift?.box_lower_breakdown_hold === true ||
                    judgment?.diagnostics?.early_probe?.hits?.includes("lower_hold") ||
                    judgment?.diagnostics?.early_probe?.hits?.includes("lower_breakdown_hold");

                const fastStopPrice = judgment?.diagnostics?.fastTrendShift?.stop_price;
                const earlyStopPrice = judgment?.diagnostics?.early_probe?.allowed ? (judgment.diagnostics.early_probe as any).stopPrice : null;
                const stopPriceVal = fastStopPrice != null && Number.isFinite(fastStopPrice) ? fastStopPrice :
                                     (earlyStopPrice != null && Number.isFinite(earlyStopPrice) ? earlyStopPrice : null);

                const hasCondition = breakdownRetestFailure || boxMidLost || lowerBreakdownHold;

                if (hasCondition && stopPriceVal != null && Number.isFinite(stopPriceVal) && stopPriceVal > sn.lastPrice) {
                    return true;
                }
            }
        }
        return false;
    })();

    if ((subtype === "WHIPSAW_SHOCK_RECHECK" || subtype === "WHIPSAW_SOFT_WATCH") && !isWhipsawExempt) {
        const meta: TransitionExecutorMetadata = {
            transitionPhase: judgment?.transitionPhase ?? "WHIPSAW_RECHECK",
            transitionSetupType: "NONE",
            transitionAction: "REJECT",
            transitionReason: subtype,
            transitionConfidence: 0,
            transitionPrimarySide: "none",
            transitionCounterSide: "none",
            transitionWatchOnly: true,
            transitionConfirmRequired: true,
            transitionRejectReason: subtype,
            transitionConfirmBasis: "insufficient",
            transitionPreflightSafetyPassed: false,
            transitionPreflightBlockReason: subtype,
            transitionEvidence: "whipsaw_recheck_no_transition_scout",
            emaGap,
            trendWeaknessScore,
            rangeConfidence,
            boxCohesion01,
            breakoutFailureRate,
            boxPos,
            boxBreakSide,
            qualityScore,
            reviewingTicks,
            directionalShockState,
            longAllow,
            shortAllow,
            crashState,
            pumpState,
            stopPrice: null,
            invalidationPx: null,
            retestConfirmed: retestConfirmedShort,
            reclaimConfirmed: reclaimConfirmedShort
        };
        return {
            signal: "WAIT_RECHECK",
            side: "none",
            reason: `${subtype}_TRANSITION_HOLD`,
            baseSizeIntent: 0,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice: null,
            invalidationPx: null,
            metadata: meta
        };
    }

    if (subtype === "FAST_TREND_SHIFT" && judgment?.diagnostics?.fastTrendShift?.direction === "long") {
        const lastPrice = sn.lastPrice;
        const boxHigh = sn.boxHigh ?? lastPrice;
        const boxLow = sn.boxLow ?? lastPrice;
        const boxMid = (boxHigh + boxLow) / 2;
        const atr = sn.atr ?? (lastPrice * 0.01);
        const recentCandles = input.candles ?? [];
        const closedCandles = getClosedCandlesForStructuralStop(recentCandles);
        const resolved = resolveFastTrendShiftStructuralStop({
            side: "long",
            entryPrice: lastPrice,
            lastPrice,
            atr,
            closedCandles,
            boxMid,
            previousConfirmedBoxHigh: boxHigh,
            previousConfirmedBoxLow: boxLow
        });
        if (!resolved.valid || resolved.stopPrice == null) {
            return {
                signal: "WAIT_RECHECK",
                side: "none",
                reason: resolved.invalidReason ?? "FAST_TREND_SHIFT_STRUCTURAL_STOP_INVALID",
                baseSizeIntent: 0,
                recheckSuggested: true,
                isAddOnEligible: false,
                stopPrice: null,
                invalidationPx: null,
                metadata: {
                    fast_trend_shift: true,
                    stop_basis: resolved.stopBasis,
                    structural_stop_invalid: true,
                    invalid_reason: resolved.invalidReason
                } as any
            };
        }
        const baseSizeIntent = judgment?.diagnostics?.fastTrendShift?.baseSizeIntent ?? 0.32;
        return {
            signal: "LONG_CANDIDATE",
            side: "long",
            reason: judgment?.subtypeReason ?? "FAST_TREND_SHIFT",
            baseSizeIntent,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice: resolved.stopPrice,
            invalidationPx: resolved.stopPrice,
            metadata: {
                early_probe: true,
                fast_trend_shift: true,
                stop_basis: resolved.stopBasis,
                structural_invalidation_price: resolved.structuralInvalidationPrice,
                structural_source: resolved.structuralSource,
                atr_buffer_multiple: resolved.atrBufferMultiple,
                atr_buffer_price: resolved.atrBufferPrice,
                stop_distance_pct: resolved.stopDistancePct,
                structural_candidate_stop: resolved.structuralCandidateStop ?? null,
                old_closed_only_safety_stop: resolved.oldClosedOnlySafetyStop ?? null,
                non_tightening_floor_applied: resolved.nonTighteningFloorApplied === true,
                box_mid: boxMid
            } as any
        };
    }

    if (subtype === "FAST_TREND_SHIFT" && judgment?.diagnostics?.fastTrendShift?.direction === "short") {
        const lastPrice = sn.lastPrice;
        const boxHigh = sn.boxHigh ?? lastPrice;
        const boxLow = sn.boxLow ?? lastPrice;
        const boxMid = (boxHigh + boxLow) / 2;
        const atr = sn.atr ?? (lastPrice * 0.01);
        const recentCandles = input.candles ?? [];
        const closedCandles = getClosedCandlesForStructuralStop(recentCandles);
        const resolved = resolveFastTrendShiftStructuralStop({
            side: "short",
            entryPrice: lastPrice,
            lastPrice,
            atr,
            closedCandles,
            boxMid,
            previousConfirmedBoxHigh: boxHigh,
            previousConfirmedBoxLow: boxLow
        });
        if (!resolved.valid || resolved.stopPrice == null) {
            return {
                signal: "WAIT_RECHECK",
                side: "none",
                reason: resolved.invalidReason ?? "FAST_TREND_SHIFT_STRUCTURAL_STOP_INVALID",
                baseSizeIntent: 0,
                recheckSuggested: true,
                isAddOnEligible: false,
                stopPrice: null,
                invalidationPx: null,
                metadata: {
                    fast_trend_shift: true,
                    stop_basis: resolved.stopBasis,
                    structural_stop_invalid: true,
                    invalid_reason: resolved.invalidReason
                } as any
            };
        }
        const baseSizeIntent = judgment?.diagnostics?.fastTrendShift?.baseSizeIntent ?? 0.32;
        return {
            signal: "SHORT_CANDIDATE",
            side: "short",
            reason: judgment?.subtypeReason ?? "FAST_TREND_SHIFT",
            baseSizeIntent,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice: resolved.stopPrice,
            invalidationPx: resolved.stopPrice,
            metadata: {
                early_probe: true,
                fast_trend_shift: true,
                stop_basis: resolved.stopBasis,
                structural_invalidation_price: resolved.structuralInvalidationPrice,
                structural_source: resolved.structuralSource,
                atr_buffer_multiple: resolved.atrBufferMultiple,
                atr_buffer_price: resolved.atrBufferPrice,
                stop_distance_pct: resolved.stopDistancePct,
                structural_candidate_stop: resolved.structuralCandidateStop ?? null,
                old_closed_only_safety_stop: resolved.oldClosedOnlySafetyStop ?? null,
                non_tightening_floor_applied: resolved.nonTighteningFloorApplied === true,
                box_mid: boxMid
            } as any
        };
    }

    if (subtype === "EARLY_LONG_PROBE") {
        const lastPrice = sn.lastPrice;
        const boxHigh = sn.boxHigh ?? lastPrice;
        const boxLow = sn.boxLow ?? lastPrice;
        const boxMid = (boxHigh + boxLow) / 2;
        const atr = sn.atr ?? (lastPrice * 0.01);
        
        const recentCandles = input.candles ?? [];
        const swingLow = recentCandles.length >= 10 
            ? Math.min(...recentCandles.slice(-10).map(c => c.low)) 
            : lastPrice * 0.99;
        
        const stopBasisMid = boxMid * 0.998; 
        const stopBasisAtr = lastPrice - (atr * 2.0);
        const stopPrice = Math.min(swingLow, stopBasisMid, stopBasisAtr);

        const baseSizeIntent = judgment?.diagnostics?.fastTrendShift?.baseSizeIntent ?? 0.32;

        return {
            signal: "LONG_CANDIDATE",
            side: "long",
            reason: judgment?.subtypeReason ?? "EARLY_LONG_PROBE",
            baseSizeIntent,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice,
            invalidationPx: stopPrice,
            metadata: { 
                early_probe: true,
                fast_trend_shift: false,
                stop_basis: "conservative_probe_basis",
                swing_low: swingLow,
                box_mid: boxMid,
                atr_stop: stopBasisAtr
            } as any
        };
    }

    if (subtype === "EARLY_SHORT_PROBE") {
        const lastPrice = sn.lastPrice;
        const boxHigh = sn.boxHigh ?? lastPrice;
        const boxLow = sn.boxLow ?? lastPrice;
        const boxMid = (boxHigh + boxLow) / 2;
        const atr = sn.atr ?? (lastPrice * 0.01);
        
        const recentCandles = input.candles ?? [];
        const swingHigh = recentCandles.length >= 10 
            ? Math.max(...recentCandles.slice(-10).map(c => c.high)) 
            : lastPrice * 1.01;
        
        const stopBasisMid = boxMid * 1.002; 
        const stopBasisAtr = lastPrice + (atr * 2.0);
        const stopPrice = Math.max(swingHigh, stopBasisMid, stopBasisAtr);

        const baseSizeIntent = judgment?.diagnostics?.fastTrendShift?.baseSizeIntent ?? 0.32;

        return {
            signal: "SHORT_CANDIDATE",
            side: "short",
            reason: judgment?.subtypeReason ?? "EARLY_SHORT_PROBE",
            baseSizeIntent,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice,
            invalidationPx: stopPrice,
            metadata: { 
                early_probe: true,
                fast_trend_shift: false,
                stop_basis: "conservative_probe_basis",
                swing_high: swingHigh,
                box_mid: boxMid,
                atr_stop: stopBasisAtr
            } as any
        };
    }

    let signal: ExecutorOutput["signal"] = "NONE";
    let side: ExecutorOutput["side"] = "none";
    let reason = "TRANSITION_CONFLICT_NO_TRADE";
    let baseSizeIntent = 0;
    let recheckSuggested = true;
    let transitionSetupType: TransitionSetupType = "NONE";
    let transitionAction: "WATCH" | "CONFIRM" | "REJECT" = "REJECT";
    let transitionPrimarySide: ExecutorOutput["side"] = "none";
    let transitionCounterSide: ExecutorOutput["side"] = "none";
    let transitionWatchOnly = true;
    let transitionConfirmRequired = true;
    let transitionRejectReason: string | null = "TRANSITION_CONFLICT_NO_TRADE";
    let transitionConfirmBasis: "box_break" | "ema_gap_only" | "insufficient" = "insufficient";
    let transitionPreflightSafetyPassed = false;
    let transitionPreflightBlockReason: string | null = null;
    let transitionEvidence = "transition_default_reject";
    let transitionConfidence = 0.5;

    if (subtype === "SHOCK_REACTION_DOWN" || directionalShockState === "DOWN") {
        transitionSetupType = "SHOCK_DOWN_REACTION";
        transitionAction = "WATCH";
        transitionPrimarySide = "short";
        transitionCounterSide = "long";
        transitionEvidence = "down_shock_transition_reaction";
        if (!shortAllow) {
            signal = "WAIT_RECHECK";
            reason = "TRANSITION_SHOCK_DOWN_SHORT_NOT_ALLOWED";
            transitionRejectReason = "SHORT_NOT_ALLOWED";
        } else if (isMidZone) {
            const isMidWhipsawRetest =
                subtype === "WHIPSAW_SOFT_WATCH" &&
                directionalShockState === "DOWN" &&
                shortAllow;

            const breakdownRetestFailure =
                judgment?.subtype === "BREAKDOWN_RETEST_FAILED" ||
                judgment?.metadata?.retestConfirmed === true ||
                judgment?.metadata?.breakdownRetestFailure === true ||
                judgment?.diagnostics?.early_probe?.hits?.includes("retest_failure") ||
                judgment?.diagnostics?.fastTrendShift?.reason?.includes("retest_failure");

            const boxMidLost =
                judgment?.diagnostics?.fastTrendShift?.box_mid_lost === true ||
                judgment?.diagnostics?.early_probe?.hits?.includes("box_mid_lost") ||
                (sn.boxHigh != null && sn.boxLow != null && sn.lastPrice < (sn.boxHigh + sn.boxLow) / 2 && (sn.candles && sn.candles.length >= 2 && sn.candles[sn.candles.length - 2].close >= (sn.boxHigh + sn.boxLow) / 2));

            const lowerBreakdownHold =
                judgment?.diagnostics?.fastTrendShift?.box_lower_breakdown_hold === true ||
                judgment?.diagnostics?.early_probe?.hits?.includes("lower_hold") ||
                judgment?.diagnostics?.early_probe?.hits?.includes("lower_breakdown_hold");

            const fastStopPrice = judgment?.diagnostics?.fastTrendShift?.stop_price;
            const earlyStopPrice = judgment?.diagnostics?.early_probe?.allowed ? (judgment.diagnostics.early_probe as any).stopPrice : null;
            const stopPriceVal = fastStopPrice != null && Number.isFinite(fastStopPrice) ? fastStopPrice :
                                 (earlyStopPrice != null && Number.isFinite(earlyStopPrice) ? earlyStopPrice : null);

            const hasCondition = breakdownRetestFailure || boxMidLost || lowerBreakdownHold;

            const downMomentumConfirmed =
                shortAllow &&
                emaGap < 0 &&
                qualityScore >= 70 &&
                trendWeaknessScore < 0.65 &&
                !crashState.includes("ULTRA") && !crashState.includes("CRITICAL");

            if (isMidWhipsawRetest && hasCondition && stopPriceVal != null && Number.isFinite(stopPriceVal) && stopPriceVal > sn.lastPrice) {
                signal = "SHORT_CANDIDATE";
                side = "short";
                reason = "WHIPSAW_SOFT_WATCH_DOWN_MID_SHORT_RETEST";
                baseSizeIntent = 0.25;
                recheckSuggested = false;
                transitionAction = "CONFIRM";
                transitionWatchOnly = false;
                transitionConfirmRequired = false;
                transitionRejectReason = null;
                transitionConfirmBasis = "box_break";
                transitionPreflightSafetyPassed = true;
            } else if (downMomentumConfirmed) {
                signal = "SHORT_CANDIDATE";
                side = "short";
                reason = "TRANSITION_SHOCK_DOWN_MID_MOMENTUM_CONFIRMED";
                baseSizeIntent = 0.25;
                recheckSuggested = false;
                transitionAction = "CONFIRM";
                transitionWatchOnly = false;
                transitionConfirmRequired = false;
                transitionRejectReason = null;
                transitionConfirmBasis = "ema_gap_only";
                transitionPreflightSafetyPassed = true;
            } else {
                signal = "WAIT_RECHECK";
                reason = "TRANSITION_SHOCK_DOWN_MID_CHASE_FORBIDDEN";
                transitionRejectReason = "MID_CHASE_FORBIDDEN";
            }
        } else {
            const boxBreakConfirm = boxBreakSide === "lower" && qualityScore >= 65;
            const emaGapOnlyCandidate = boxBreakSide !== "lower" && emaGap < 0 && qualityScore >= 65;
            const emaGapOnlySafety =
                qualityScore >= 72 &&
                reviewingTicks >= 2 &&
                trendWeaknessScore < 0.45 &&
                !isMidZone;
            transitionPreflightSafetyPassed = boxBreakConfirm || (emaGapOnlyCandidate && emaGapOnlySafety);
            if (boxBreakConfirm || (emaGapOnlyCandidate && emaGapOnlySafety)) {
                signal = "SHORT_CANDIDATE";
                side = "short";
                reason = "TRANSITION_SHOCK_DOWN_REACTION_CONFIRMED";
                baseSizeIntent = 0.3;
                recheckSuggested = false;
                transitionAction = "CONFIRM";
                transitionWatchOnly = false;
                transitionConfirmRequired = false;
                transitionRejectReason = null;
                transitionConfirmBasis = boxBreakConfirm ? "box_break" : "ema_gap_only";
                transitionPreflightBlockReason = null;
            } else {
                signal = "WAIT_RECHECK";
                reason = "TRANSITION_SHOCK_DOWN_REACTION_WATCH";
                transitionRejectReason = "INSUFFICIENT_CONFIRMATION";
                transitionConfirmBasis = "insufficient";
                transitionPreflightBlockReason = emaGapOnlyCandidate && !emaGapOnlySafety
                    ? "EMA_GAP_ONLY_PREFLIGHT_BLOCKED"
                    : "INSUFFICIENT_CONFIRMATION";
            }
        }
    } else if (subtype === "SHOCK_REACTION_UP" || directionalShockState === "UP") {
        transitionSetupType = "SHOCK_UP_REACTION";
        transitionAction = "WATCH";
        transitionPrimarySide = "long";
        transitionCounterSide = "short";
        transitionEvidence = "up_shock_transition_reaction";
        if (!longAllow) {
            signal = "WAIT_RECHECK";
            reason = "TRANSITION_SHOCK_UP_LONG_NOT_ALLOWED";
            transitionRejectReason = "LONG_NOT_ALLOWED";
        } else if (isMidZone) {
            const upMomentumConfirmed =
                longAllow &&
                emaGap > 0 &&
                qualityScore >= 70 &&
                trendWeaknessScore < 0.65 &&
                !pumpState.includes("ULTRA") && !pumpState.includes("CRITICAL");

            if (upMomentumConfirmed) {
                signal = "LONG_CANDIDATE";
                side = "long";
                reason = "TRANSITION_SHOCK_UP_MID_MOMENTUM_CONFIRMED";
                baseSizeIntent = 0.25;
                recheckSuggested = false;
                transitionAction = "CONFIRM";
                transitionWatchOnly = false;
                transitionConfirmRequired = false;
                transitionRejectReason = null;
                transitionConfirmBasis = "ema_gap_only";
                transitionPreflightSafetyPassed = true;
            } else {
                signal = "WAIT_RECHECK";
                reason = "TRANSITION_SHOCK_UP_MID_CHASE_FORBIDDEN";
                transitionRejectReason = "MID_CHASE_FORBIDDEN";
            }
        } else {
            const boxBreakConfirm = boxBreakSide === "upper" && qualityScore >= 65;
            const emaGapOnlyCandidate = boxBreakSide !== "upper" && emaGap > 0 && qualityScore >= 65;
            const emaGapOnlySafety =
                qualityScore >= 72 &&
                reviewingTicks >= 2 &&
                trendWeaknessScore < 0.45 &&
                !isMidZone;
            transitionPreflightSafetyPassed = boxBreakConfirm || (emaGapOnlyCandidate && emaGapOnlySafety);
            if (boxBreakConfirm || (emaGapOnlyCandidate && emaGapOnlySafety)) {
                signal = "LONG_CANDIDATE";
                side = "long";
                reason = "TRANSITION_SHOCK_UP_REACTION_CONFIRMED";
                baseSizeIntent = 0.3;
                recheckSuggested = false;
                transitionAction = "CONFIRM";
                transitionWatchOnly = false;
                transitionConfirmRequired = false;
                transitionRejectReason = null;
                transitionConfirmBasis = boxBreakConfirm ? "box_break" : "ema_gap_only";
                transitionPreflightBlockReason = null;
            } else {
                signal = "WAIT_RECHECK";
                reason = "TRANSITION_SHOCK_UP_REACTION_WATCH";
                transitionRejectReason = "INSUFFICIENT_CONFIRMATION";
                transitionConfirmBasis = "insufficient";
                transitionPreflightBlockReason = emaGapOnlyCandidate && !emaGapOnlySafety
                    ? "EMA_GAP_ONLY_PREFLIGHT_BLOCKED"
                    : "INSUFFICIENT_CONFIRMATION";
            }
        }
    } else if (transitionPhase === "RANGE_TO_TREND") {
        const upBreak = boxBreakSide === "upper" && emaGap > 0;
        const downBreak = boxBreakSide === "lower" && emaGap < 0;
        const trendWeaknessOk = trendWeaknessScore < 0.55;
        transitionEvidence = "range_to_trend_transition_watch";
        if (upBreak) {
            transitionSetupType = "RANGE_TO_TREND_UP";
            transitionPrimarySide = "long";
            transitionCounterSide = "short";
            if (!longAllow) {
                signal = "WAIT_RECHECK";
                reason = "TRANSITION_RANGE_TO_TREND_UP_LONG_NOT_ALLOWED";
                transitionAction = "WATCH";
                transitionRejectReason = "LONG_NOT_ALLOWED";
            } else if (isMidZone) {
                signal = "WAIT_RECHECK";
                reason = "TRANSITION_RANGE_TO_TREND_UP_MID_CHASE_FORBIDDEN";
                transitionAction = "WATCH";
                transitionRejectReason = "MID_CHASE_FORBIDDEN";
            } else if (trendWeaknessOk && breakoutConfirm) {
                signal = "LONG_CANDIDATE";
                side = "long";
                reason = "TRANSITION_RANGE_TO_TREND_UP_CONFIRMED";
                baseSizeIntent = 0.35;
                recheckSuggested = false;
                transitionAction = "CONFIRM";
                transitionWatchOnly = false;
                transitionConfirmRequired = false;
                transitionRejectReason = null;
            } else {
                signal = "WAIT_RECHECK";
                reason = "TRANSITION_RANGE_TO_TREND_UP_WATCH";
                transitionAction = "WATCH";
                transitionRejectReason = "INSUFFICIENT_CONFIRMATION";
            }
        } else if (downBreak) {
            transitionSetupType = "RANGE_TO_TREND_DOWN";
            transitionPrimarySide = "short";
            transitionCounterSide = "long";
            if (!shortAllow) {
                signal = "WAIT_RECHECK";
                reason = "TRANSITION_RANGE_TO_TREND_DOWN_SHORT_NOT_ALLOWED";
                transitionAction = "WATCH";
                transitionRejectReason = "SHORT_NOT_ALLOWED";
            } else if (isMidZone) {
                signal = "WAIT_RECHECK";
                reason = "TRANSITION_RANGE_TO_TREND_DOWN_MID_CHASE_FORBIDDEN";
                transitionAction = "WATCH";
                transitionRejectReason = "MID_CHASE_FORBIDDEN";
            } else if (trendWeaknessOk && breakoutConfirm) {
                signal = "SHORT_CANDIDATE";
                side = "short";
                reason = "TRANSITION_RANGE_TO_TREND_DOWN_CONFIRMED";
                baseSizeIntent = 0.35;
                recheckSuggested = false;
                transitionAction = "CONFIRM";
                transitionWatchOnly = false;
                transitionConfirmRequired = false;
                transitionRejectReason = null;
            } else {
                signal = "WAIT_RECHECK";
                reason = "TRANSITION_RANGE_TO_TREND_DOWN_WATCH";
                transitionAction = "WATCH";
                transitionRejectReason = "INSUFFICIENT_CONFIRMATION";
            }
        } else {
            signal = "WAIT_RECHECK";
            reason = "TRANSITION_RANGE_TO_TREND_STRUCTURE_NOT_READY";
            transitionAction = "WATCH";
            transitionRejectReason = "STRUCTURE_NOT_READY";
        }
    } else if (transitionPhase === "TREND_TO_RANGE") {
        transitionSetupType = "TREND_TO_RANGE_WEAKENING";
        transitionAction = "WATCH";
        transitionPrimarySide = "none";
        transitionCounterSide = "none";
        transitionEvidence = "trend_to_range_weakening";
        signal = "WAIT_RECHECK";
        side = "none";
        reason = "TRANSITION_TREND_TO_RANGE_WEAKENING";
        baseSizeIntent = 0;
        recheckSuggested = true;
        transitionWatchOnly = true;
        transitionConfirmRequired = true;
        transitionRejectReason = "WEAKENING_PROTECTIVE_HOLD";
        if (!(trendWeaknessScore >= 0.6 && rangeConfidence >= 0.55 && (boxCohesion01 >= 0.5 || breakoutFailureRate >= 0.5))) {
            transitionRejectReason = "WEAKENING_NOT_MATURE";
        }
    } else {
        transitionSetupType = "CONFLICT_NO_TRADE";
        transitionAction = "REJECT";
        transitionPrimarySide = "none";
        transitionCounterSide = "none";
        transitionEvidence = "transition_conflict_no_trade";
        signal = "NONE";
        side = "none";
        reason = "TRANSITION_CONFLICT_NO_TRADE";
        baseSizeIntent = 0;
        recheckSuggested = true;
        transitionWatchOnly = true;
        transitionConfirmRequired = true;
        transitionRejectReason = "TRANSITION_CONFLICT_NO_TRADE";
    }

    const entryPx = Number(sn.lastPrice ?? 0);
    const atr = Number(sn.atr ?? (entryPx * 0.01));
    const boxHigh = Number(sn.boxHigh ?? 0);
    const boxLow = Number(sn.boxLow ?? 0);

    let stopPrice: number | null = null;
    let invalidationPx: number | null = null;

    if (reason === "WHIPSAW_SOFT_WATCH_DOWN_MID_SHORT_RETEST") {
        const fastStopPrice = judgment?.diagnostics?.fastTrendShift?.stop_price;
        const earlyStopPrice = judgment?.diagnostics?.early_probe?.allowed ? (judgment.diagnostics.early_probe as any).stopPrice : null;
        const stopPriceVal = fastStopPrice != null && Number.isFinite(fastStopPrice) ? fastStopPrice :
                             (earlyStopPrice != null && Number.isFinite(earlyStopPrice) ? earlyStopPrice : null);
        stopPrice = stopPriceVal;
        invalidationPx = stopPriceVal;
    } else if (side === "long") {
        const baseInv = boxLow > 0 ? boxLow : entryPx - atr * 1.5;
        stopPrice = Math.min(baseInv - atr * 0.2, entryPx - atr * 1.0);
        invalidationPx = Math.min(baseInv - atr * 0.5, entryPx - atr * 1.5);
    } else if (side === "short") {
        const baseInv = boxHigh > 0 ? boxHigh : entryPx + atr * 1.5;
        stopPrice = Math.max(baseInv + atr * 0.2, entryPx + atr * 1.0);
        invalidationPx = Math.max(baseInv + atr * 0.5, entryPx + atr * 1.5);
    }

    if (reason === "WHIPSAW_SOFT_WATCH_DOWN_MID_SHORT_RETEST" && (stopPrice == null || isNaN(stopPrice))) {
        signal = "NONE";
        side = "none";
        reason = "WHIPSAW_SOFT_WATCH_DOWN_MID_SHORT_RETEST_STOP_PRICE_NULL_HOLD";
        baseSizeIntent = 0;
        recheckSuggested = true;
        stopPrice = null;
        invalidationPx = null;
    }

    const metadata: TransitionExecutorMetadata = {
        transitionPhase,
        transitionSetupType,
        transitionAction,
        transitionReason: reason,
        transitionConfidence,
        transitionPrimarySide,
        transitionCounterSide,
        transitionWatchOnly,
        transitionConfirmRequired,
        transitionRejectReason,
        transitionConfirmBasis,
        transitionPreflightSafetyPassed,
        transitionPreflightBlockReason,
        transitionEvidence,
        emaGap,
        trendWeaknessScore,
        rangeConfidence,
        boxCohesion01,
        breakoutFailureRate,
        boxPos,
        boxBreakSide,
        qualityScore,
        reviewingTicks,
        directionalShockState,
        longAllow,
        shortAllow,
        crashState,
        pumpState,
        stopPrice,
        invalidationPx,
        retestConfirmed: retestConfirmedShort,
        reclaimConfirmed: reclaimConfirmedShort
    };

    if (reason === "WHIPSAW_SOFT_WATCH_DOWN_MID_SHORT_RETEST") {
        const fastStopBasis = judgment?.diagnostics?.fastTrendShift?.stop_basis ?? "whipsaw_mid_stop";
        metadata.stop_basis = fastStopBasis;
    }

    return {
        signal,
        side,
        reason,
        baseSizeIntent: Math.max(0, Math.min(0.4, baseSizeIntent)),
        recheckSuggested,
        isAddOnEligible: false,
        stopPrice,
        invalidationPx,
        metadata
    };
}
