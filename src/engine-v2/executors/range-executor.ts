import { EngineV2Input, EngineV2Side, ExecutorOutput, MarketJudgmentOutput } from "../types";
import { classifyRangeZone } from "../../models/types";

export type RangeContinuationPhase = "IDLE" | "DEADLOCK_COUNTING" | "CONTINUATION_WATCH" | "RETEST_TOUCHED" | "RETEST_CONFIRMED" | "EXPIRED";

export interface RangeContinuationState {
    symbol: string;
    direction: "down" | "up" | null;
    phase: RangeContinuationPhase;
    consecutiveCycles: number;
    lastRunCycleId: string | null;
    lastCandleTimestamp: number | null;
    watchBoundaryPrice: number | null;
    watchStartedAtTimestamp: number | null;
    totalCyclesSinceWatch: number;
    countStartedCandleTs: number | null;
    hasCandleAdvancedDuringCount: boolean;
    watchStartedCandleTs: number | null;
    lastLoggedRunCycleId: string | null;
}

export const rangeContinuationStateMap = new Map<string, RangeContinuationState>();

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Tier 4: Range Executor (Refined)
 * Hardened with Late Chase Guard, Zone-based Side Filtering, and Deadlock Continuation Watch.
 */
export function executeRangeRegime(input: EngineV2Input, judgment: MarketJudgmentOutput): ExecutorOutput {
    const { snapshot: sn } = input;
    if (judgment.subtype === "WHIPSAW_SHOCK_RECHECK") {
        return {
            signal: "WAIT_RECHECK",
            side: "none",
            reason: "WHIPSAW_SHOCK_RECHECK_RANGE_HOLD",
            baseSizeIntent: 0,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice: null,
            invalidationPx: null,
            metadata: { whipsaw_shock_recheck: true }
        };
    }

    const lastPrice = sn.lastPrice ?? 0;
    const boxHigh = sn.boxHigh ?? lastPrice;
    const boxLow = sn.boxLow ?? lastPrice;
    const boxMid = (boxHigh + boxLow) / 2;
    const atr = sn.atr ?? (lastPrice * 0.01);
    
    const recentCandles: import("../../models/types").Candle[] = sn.candles ?? [];
    const lastCandleTimestamp = recentCandles.length > 0 ? recentCandles[recentCandles.length - 1].ts : 0;
    const currentRunCycleId = input.run_cycle_id ?? "unknown";
    const isAuthoritative = input.evaluationMode !== "diagnostic";
    const currentStage = input.state.currentPositions.find(p => p.symbol === input.symbol)?.entryStage ?? 0;

    if (judgment.subtype === "EARLY_LONG_PROBE" || (judgment.subtype === "FAST_TREND_SHIFT" && judgment.diagnostics?.fastTrendShift?.direction === "long")) {
        const swingLow = recentCandles.length >= 10 
            ? Math.min(...recentCandles.slice(-10).map(c => c.low)) 
            : lastPrice * 0.99;
        
        const stopBasisMid = boxMid * 0.998; 
        const stopBasisAtr = lastPrice - (atr * 2.0);
        const stopPrice = Math.min(swingLow, stopBasisMid, stopBasisAtr);

        const baseSizeIntent = judgment.diagnostics?.fastTrendShift?.baseSizeIntent ?? 0.32;

        return {
            signal: "LONG_CANDIDATE",
            side: "long",
            reason: judgment.subtypeReason,
            baseSizeIntent,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice,
            invalidationPx: stopPrice,
            metadata: { 
                early_probe: true,
                fast_trend_shift: judgment.subtype === "FAST_TREND_SHIFT",
                stop_basis: "conservative_probe_basis",
                swing_low: swingLow,
                box_mid: boxMid,
                atr_stop: stopBasisAtr
            }
        };
    }

    if (judgment.subtype === "EARLY_SHORT_PROBE" || (judgment.subtype === "FAST_TREND_SHIFT" && judgment.diagnostics?.fastTrendShift?.direction === "short")) {
        const swingHigh = recentCandles.length >= 10 
            ? Math.max(...recentCandles.slice(-10).map(c => c.high)) 
            : lastPrice * 1.01;
        
        const stopBasisMid = boxMid * 1.002; 
        const stopBasisAtr = lastPrice + (atr * 2.0);
        const stopPrice = Math.max(swingHigh, stopBasisMid, stopBasisAtr);

        const baseSizeIntent = judgment.diagnostics?.fastTrendShift?.baseSizeIntent ?? 0.32;

        return {
            signal: "SHORT_CANDIDATE",
            side: "short",
            reason: judgment.subtypeReason,
            baseSizeIntent,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice,
            invalidationPx: stopPrice,
            metadata: { 
                early_probe: true,
                fast_trend_shift: judgment.subtype === "FAST_TREND_SHIFT",
                stop_basis: "conservative_probe_basis",
                swing_high: swingHigh,
                box_mid: boxMid,
                atr_stop: stopBasisAtr
            }
        };
    }

    const boxPos = typeof sn.boxPos === "number" && Number.isFinite(sn.boxPos) ? sn.boxPos : null;
    const rangeConfidence = typeof sn.rangeConfidence === "number" && Number.isFinite(sn.rangeConfidence) ? sn.rangeConfidence : 0;
    const breakoutFailureRate = typeof sn.breakoutFailureRate === "number" && Number.isFinite(sn.breakoutFailureRate) ? sn.breakoutFailureRate : 0;
    const rangeOscillationScore = typeof sn.rangeOscillationScore === "number" && Number.isFinite(sn.rangeOscillationScore) ? sn.rangeOscillationScore : 0;
    const isDistorted = (judgment.metadata as any)?.isDistorted === true;
    const isDrifting = (judgment.metadata as any)?.isDrifting === true;
    const distortionFactor = (judgment.metadata as any)?.distortionFactor ?? 0;
    const bhSlope = (judgment.metadata as any)?.bhSlope ?? 0;
    const blSlope = (judgment.metadata as any)?.blSlope ?? 0;
    const rcSlope = (judgment.metadata as any)?.rcSlope ?? (sn as any).rangeCenterSlope ?? 0;

    const execMeta = (judgment.metadata ?? {}) as Record<string, unknown>;
    const readBool = (v: unknown): boolean => v === true || v === "true";
    let signal: any = "NONE";
    let side: EngineV2Side = "none";
    let reason = "Initial state";
    let recheckSuggested = false;
    let reversalConfirmed = readBool(execMeta.reversal_confirmed) || (judgment as any).reversalConfirmed === true;
    let sideOverrideApplied = false;
    let lateChaseBlocked = false;
    let retestRequired = false;
    let retestPassed = false;
    let firstBreakoutChaseBlocked = false;
    const qualityScore = sn.qualityScore ?? 0;

    const isMeanReversionBlockedByDistortion = isDistorted && currentStage === 0;
    const isDriftDown = judgment.subtype === "RANGE_DRIFT_DOWN" || judgment.subtype === "DESCENDING_CHANNEL";
    const isDriftUp = judgment.subtype === "RANGE_DRIFT_UP" || judgment.subtype === "ASCENDING_CHANNEL";
    
    const currentBoxPos = boxPos ?? 0.5;
    const boxZone = classifyRangeZone(currentBoxPos);
    const isUpper = boxZone === "upper";
    const isLower = boxZone === "lower";
    const isMid = boxZone === "mid";
    const emaGap = sn.emaGap ?? 0;

    // --- CONTINUATION STATE MACHINE (Deadlock Resolver) ---
    let cState = rangeContinuationStateMap.get(input.symbol) ?? {
        symbol: input.symbol,
        direction: null,
        phase: "IDLE",
        consecutiveCycles: 0,
        lastRunCycleId: null,
        lastCandleTimestamp: null,
        watchBoundaryPrice: null,
        watchStartedAtTimestamp: null,
        totalCyclesSinceWatch: 0,
        countStartedCandleTs: null,
        hasCandleAdvancedDuringCount: false,
        watchStartedCandleTs: null,
        lastLoggedRunCycleId: null
    };

    const now = Date.now();
    let shouldResetWatch = false;

    if (cState.phase === "CONTINUATION_WATCH" || cState.phase === "RETEST_TOUCHED") {
        if (reversalConfirmed) shouldResetWatch = true;
        if (cState.direction === "down" && lastPrice > boxLow + (boxHigh - boxLow) * 0.2) shouldResetWatch = true;
        if (cState.direction === "up" && lastPrice < boxHigh - (boxHigh - boxLow) * 0.2) shouldResetWatch = true;
        if (cState.direction === "down" && judgment.trendPhase === "UP") shouldResetWatch = true;
        if (cState.direction === "up" && judgment.trendPhase === "DOWN") shouldResetWatch = true;
        if (cState.direction === "down" && lastPrice > boxHigh) shouldResetWatch = true;
        if (cState.direction === "up" && lastPrice < boxLow) shouldResetWatch = true;
        if (cState.watchStartedAtTimestamp && (now - cState.watchStartedAtTimestamp > 10 * 60 * 1000)) shouldResetWatch = true;
        if (cState.totalCyclesSinceWatch >= 10) shouldResetWatch = true;
    }

    if (shouldResetWatch) {
        cState = {
            symbol: input.symbol,
            direction: null,
            phase: "IDLE",
            consecutiveCycles: 0,
            lastRunCycleId: null,
            lastCandleTimestamp: null,
            watchBoundaryPrice: null,
            watchStartedAtTimestamp: null,
            totalCyclesSinceWatch: 0,
            countStartedCandleTs: null,
            hasCandleAdvancedDuringCount: false,
            watchStartedCandleTs: null,
            lastLoggedRunCycleId: null
        };
    }

    const logProof = (event: string, payload: any) => {
        const eventKey = `${currentRunCycleId}:${event}`;
        if (cState.lastLoggedRunCycleId !== eventKey) {
            console.warn(JSON.stringify({ event, symbol: input.symbol, ...payload }));
            cState.lastLoggedRunCycleId = eventKey;
            rangeContinuationStateMap.set(input.symbol, cState);
        }
    };

    const atrPct = lastPrice > 0 ? (atr / lastPrice) : 0;
    const retestTolerancePct = clamp(atrPct * 0.5, 0.0010, 0.0030); // 0.10% ~ 0.30%
    const noRetestSkipPct = clamp(atrPct * 1.5, 0.0050, 0.0100);    // 0.5% ~ 1.0%

    const isDownDeadlockCondition = 
        judgment.trendPhase === "DOWN" && 
        emaGap < 0 && 
        !reversalConfirmed && 
        blSlope < 0 && 
        rcSlope < 0 && 
        (lastPrice < boxLow || recentCandles.slice(-3).some(c => c.low < boxLow));

    const isUpDeadlockCondition = 
        judgment.trendPhase === "UP" && 
        emaGap > 0 && 
        !reversalConfirmed && 
        bhSlope > 0 && 
        rcSlope > 0 && 
        (lastPrice > boxHigh || recentCandles.slice(-3).some(c => c.high > boxHigh));

    let updatedCycle = false;
    
    // Position open -> immediate IDLE
    if (currentStage > 0 && cState.phase !== "IDLE") {
        cState.phase = "IDLE";
        cState.consecutiveCycles = 0;
        cState.direction = null;
        cState.countStartedCandleTs = null;
        cState.hasCandleAdvancedDuringCount = false;
        cState.watchBoundaryPrice = null;
        updatedCycle = true;
    }
    
    if (isAuthoritative && currentRunCycleId !== cState.lastRunCycleId) {
        if (cState.phase === "CONTINUATION_WATCH" || cState.phase === "RETEST_TOUCHED") {
            cState.totalCyclesSinceWatch++;
        }
        
        const timestampChanged = lastCandleTimestamp !== cState.lastCandleTimestamp;
        
        if (cState.phase === "RETEST_CONFIRMED") {
            cState.phase = "EXPIRED";
        }
        if (cState.phase === "EXPIRED" && timestampChanged) {
            cState.phase = "IDLE";
            cState.direction = null;
        }
        
        if (cState.phase === "IDLE" || cState.phase === "DEADLOCK_COUNTING") {
            if (isDownDeadlockCondition) {
                if (cState.direction !== "down") {
                    cState.direction = "down";
                    cState.consecutiveCycles = 1;
                    cState.countStartedCandleTs = lastCandleTimestamp;
                    cState.hasCandleAdvancedDuringCount = false;
                } else {
                    cState.consecutiveCycles++;
                }
                if (lastCandleTimestamp > (cState.countStartedCandleTs ?? 0)) {
                    cState.hasCandleAdvancedDuringCount = true;
                }
                cState.phase = "DEADLOCK_COUNTING";
            } else if (isUpDeadlockCondition) {
                if (cState.direction !== "up") {
                    cState.direction = "up";
                    cState.consecutiveCycles = 1;
                    cState.countStartedCandleTs = lastCandleTimestamp;
                    cState.hasCandleAdvancedDuringCount = false;
                } else {
                    cState.consecutiveCycles++;
                }
                if (lastCandleTimestamp > (cState.countStartedCandleTs ?? 0)) {
                    cState.hasCandleAdvancedDuringCount = true;
                }
                cState.phase = "DEADLOCK_COUNTING";
            } else {
                cState.phase = "IDLE";
                cState.consecutiveCycles = 0;
                cState.direction = null;
                cState.countStartedCandleTs = null;
                cState.hasCandleAdvancedDuringCount = false;
            }
        }
        
        if (cState.phase === "DEADLOCK_COUNTING" && cState.consecutiveCycles >= 3 && cState.hasCandleAdvancedDuringCount) {
            cState.phase = "CONTINUATION_WATCH";
            logProof(cState.direction === "down" ? "RANGE_BREAKDOWN_CONTINUATION_WATCH" : "RANGE_BREAKOUT_CONTINUATION_WATCH", { boxLow, boxHigh });
            cState.watchStartedAtTimestamp = now;
            cState.watchStartedCandleTs = lastCandleTimestamp;
            cState.totalCyclesSinceWatch = 0;
            cState.watchBoundaryPrice = cState.direction === "down" ? boxLow : boxHigh;
        }

        cState.lastRunCycleId = currentRunCycleId;
        cState.lastCandleTimestamp = lastCandleTimestamp;
        updatedCycle = true;
    }
    
    if (updatedCycle) {
        rangeContinuationStateMap.set(input.symbol, cState);
    }
    


    if ((cState.phase === "CONTINUATION_WATCH" || cState.phase === "RETEST_TOUCHED" || cState.phase === "RETEST_CONFIRMED" || cState.phase === "EXPIRED") && currentStage === 0) {
        if (cState.phase === "RETEST_CONFIRMED" || cState.phase === "EXPIRED") {
            return {
                signal: "WAIT_RECHECK",
                side: "none",
                reason: "RANGE_CONTINUATION_" + cState.phase,
                baseSizeIntent: 0,
                recheckSuggested: true,
                isAddOnEligible: false,
                stopPrice: null,
                invalidationPx: null,
                metadata: { phase: cState.phase }
            };
        }
        
        const watchBoundary = cState.watchBoundaryPrice ?? (cState.direction === "down" ? boxLow : boxHigh);
        
        if (cState.direction === "down") {
            let touchDetected = false;
            for (const c of recentCandles.slice(-5)) {
                if (c.ts > (cState.watchStartedCandleTs ?? 0)) {
                    if (c.high >= watchBoundary * (1 - retestTolerancePct) && c.high <= watchBoundary * (1 + retestTolerancePct)) {
                        touchDetected = true;
                    }
                }
            }
            if (touchDetected && cState.phase === "CONTINUATION_WATCH") {
                cState.phase = "RETEST_TOUCHED";
                rangeContinuationStateMap.set(input.symbol, cState);
            }
            
            if (cState.phase === "RETEST_TOUCHED" && lastPrice < watchBoundary * (1 - retestTolerancePct * 1.5)) {
                cState.phase = "RETEST_CONFIRMED";
                logProof("BREAKDOWN_RETEST_SHORT_CONFIRMED", { watchBoundary, lastPrice });
                rangeContinuationStateMap.set(input.symbol, cState);
                
                const stopPrice = watchBoundary * 1.002;
                return {
                    signal: "SHORT_CANDIDATE",
                    side: "short",
                    reason: "BREAKDOWN_RETEST_SHORT_CONFIRMED",
                    baseSizeIntent: 1,
                    recheckSuggested: false,
                    isAddOnEligible: true,
                    stopPrice,
                    invalidationPx: stopPrice,
                    metadata: { retest_confirmed: true, watchBoundary }
                };
            } else if (lastPrice < watchBoundary * (1 - noRetestSkipPct) && cState.phase === "CONTINUATION_WATCH") {
                logProof("BREAKDOWN_SHORT_SKIPPED_NO_RETEST", { symbol: input.symbol, lastPrice, watchBoundary, skipThreshold: watchBoundary * (1 - noRetestSkipPct) });
                return {
                    signal: "WAIT_RECHECK",
                    side: "none",
                    reason: "BREAKDOWN_SHORT_SKIPPED_NO_RETEST",
                    baseSizeIntent: 0,
                    recheckSuggested: true,
                    isAddOnEligible: false,
                    stopPrice: null,
                    invalidationPx: null,
                    metadata: { skipped_no_retest: true }
                };
            } else {
                return {
                    signal: "WAIT_RECHECK",
                    side: "none",
                    reason: "RANGE_BREAKDOWN_CONTINUATION_WATCH",
                    baseSizeIntent: 0,
                    recheckSuggested: true,
                    isAddOnEligible: false,
                    stopPrice: null,
                    invalidationPx: null,
                    metadata: { watchBoundary }
                };
            }
        } else if (cState.direction === "up") {
            let touchDetected = false;
            for (const c of recentCandles.slice(-5)) {
                if (c.ts > (cState.watchStartedCandleTs ?? 0)) {
                    if (c.low <= watchBoundary * (1 + retestTolerancePct) && c.low >= watchBoundary * (1 - retestTolerancePct)) {
                        touchDetected = true;
                    }
                }
            }
            if (touchDetected && cState.phase === "CONTINUATION_WATCH") {
                cState.phase = "RETEST_TOUCHED";
                rangeContinuationStateMap.set(input.symbol, cState);
            }
            
            if (cState.phase === "RETEST_TOUCHED" && lastPrice > watchBoundary * (1 + retestTolerancePct * 1.5)) {
                cState.phase = "RETEST_CONFIRMED";
                logProof("BREAKOUT_RETEST_LONG_CONFIRMED", { watchBoundary, lastPrice });
                rangeContinuationStateMap.set(input.symbol, cState);
                
                const stopPrice = watchBoundary * 0.998;
                return {
                    signal: "LONG_CANDIDATE",
                    side: "long",
                    reason: "BREAKOUT_RETEST_LONG_CONFIRMED",
                    baseSizeIntent: 1,
                    recheckSuggested: false,
                    isAddOnEligible: true,
                    stopPrice,
                    invalidationPx: stopPrice,
                    metadata: { retest_confirmed: true, watchBoundary }
                };
            } else if (lastPrice > watchBoundary * (1 + noRetestSkipPct) && cState.phase === "CONTINUATION_WATCH") {
                logProof("BREAKOUT_LONG_SKIPPED_NO_RETEST", { symbol: input.symbol, lastPrice, watchBoundary, skipThreshold: watchBoundary * (1 + noRetestSkipPct) });
                return {
                    signal: "WAIT_RECHECK",
                    side: "none",
                    reason: "BREAKOUT_LONG_SKIPPED_NO_RETEST",
                    baseSizeIntent: 0,
                    recheckSuggested: true,
                    isAddOnEligible: false,
                    stopPrice: null,
                    invalidationPx: null,
                    metadata: { skipped_no_retest: true }
                };
            } else {
                return {
                    signal: "WAIT_RECHECK",
                    side: "none",
                    reason: "RANGE_BREAKOUT_CONTINUATION_WATCH",
                    baseSizeIntent: 0,
                    recheckSuggested: true,
                    isAddOnEligible: false,
                    stopPrice: null,
                    invalidationPx: null,
                    metadata: { watchBoundary }
                };
            }
        }
    }


    // --- SHOCK & TREND GUARD (Original) ---
    if (isLower && currentStage === 0) {
        if (judgment.shockPhase === "DOWN_SHOCK") {
            console.warn(JSON.stringify({
                event: "V2_RANGE_LOWER_LONG_BLOCKED_BY_DOWN_SHOCK_PROOF",
                symbol: input.symbol,
                shockPhase: judgment.shockPhase,
                trendPhase: judgment.trendPhase,
                emaGap
            }));
            return {
                signal: "NONE",
                side: "none",
                reason: "V2_RANGE_LOWER_LONG_BLOCKED_BY_DOWN_SHOCK",
                baseSizeIntent: 0,
                recheckSuggested: true,
                isAddOnEligible: false,
                stopPrice: null,
                invalidationPx: null,
                metadata: { shockPhase: judgment.shockPhase, trendPhase: judgment.trendPhase }
            };
        } else if (judgment.trendPhase === "DOWN" || emaGap < 0) {
            if (!reversalConfirmed) {
                console.warn(JSON.stringify({
                    event: "V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND_PROOF",
                    symbol: input.symbol,
                    shockPhase: judgment.shockPhase,
                    trendPhase: judgment.trendPhase,
                    emaGap,
                    reversalConfirmed
                }));
                return {
                    signal: "NONE",
                    side: "none",
                    reason: "V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND",
                    baseSizeIntent: 0,
                    recheckSuggested: true,
                    isAddOnEligible: false,
                    stopPrice: null,
                    invalidationPx: null,
                    metadata: { shockPhase: judgment.shockPhase, trendPhase: judgment.trendPhase, reversalConfirmed }
                };
            }
        }
    }

    if (isUpper && currentStage === 0) {
        if (judgment.shockPhase === "UP_SHOCK") {
            console.warn(JSON.stringify({
                event: "V2_RANGE_UPPER_SHORT_BLOCKED_BY_UP_SHOCK_PROOF",
                symbol: input.symbol,
                shockPhase: judgment.shockPhase,
                trendPhase: judgment.trendPhase,
                emaGap
            }));
            return {
                signal: "NONE",
                side: "none",
                reason: "V2_RANGE_UPPER_SHORT_BLOCKED_BY_UP_SHOCK",
                baseSizeIntent: 0,
                recheckSuggested: true,
                isAddOnEligible: false,
                stopPrice: null,
                invalidationPx: null,
                metadata: { shockPhase: judgment.shockPhase, trendPhase: judgment.trendPhase }
            };
        } else if (judgment.trendPhase === "UP" || emaGap > 0) {
            if (!reversalConfirmed) {
                console.warn(JSON.stringify({
                    event: "V2_RANGE_UPPER_SHORT_WAITING_DUE_TO_UP_TREND_PROOF",
                    symbol: input.symbol,
                    shockPhase: judgment.shockPhase,
                    trendPhase: judgment.trendPhase,
                    emaGap,
                    reversalConfirmed
                }));
                return {
                    signal: "NONE",
                    side: "none",
                    reason: "V2_RANGE_UPPER_SHORT_WAITING_DUE_TO_UP_TREND",
                    baseSizeIntent: 0,
                    recheckSuggested: true,
                    isAddOnEligible: false,
                    stopPrice: null,
                    invalidationPx: null,
                    metadata: { shockPhase: judgment.shockPhase, trendPhase: judgment.trendPhase, reversalConfirmed }
                };
            }
        }
    }

    // 1. Zone Authority Proof (Phase 4.5)
    console.info(JSON.stringify({
        event: "V2_RANGE_ZONE_AUTHORITY_PROOF",
        symbol: input.symbol,
        boxPos: currentBoxPos,
        isUpper,
        isLower,
        isMid,
        rangeConfidence,
        breakoutFailureRate,
        rangeOscillationScore
    }));

    // Side Filtering Logic
    if (isUpper) {
        side = "short";
        if (!input.state.shortAllow) {
            signal = "NONE";
            reason = "Upper edge reached but short blocked by bias";
        } else {
            const entryPx = sn.boxHigh ?? 0;
            let touchDetected = false;
            let overshot = false;

            for (const c of recentCandles.slice(-5)) {
                if (c.high >= entryPx) touchDetected = true;
                if (c.high > entryPx + (atr * 0.15)) overshot = true;
            }

            const reactionDetected = touchDetected && lastPrice < entryPx * 0.9997;
            reversalConfirmed = touchDetected && !overshot && reactionDetected;

            if (reversalConfirmed) {
                signal = "SHORT_CANDIDATE";
                reason = "Upper edge reversal identified by price reaction";
            } else {
                signal = "WAIT_RECHECK";
                reason = touchDetected 
                    ? (overshot ? "Upper edge overshot; reversal invalidated" : "Upper edge touched; awaiting reaction")
                    : "Upper edge reached; awaiting touch and reaction";
                recheckSuggested = true;
            }
        }
    } else if (isLower) {
        side = "long";
        if (!input.state.longAllow) {
            signal = "NONE";
            reason = "Lower edge reached but long blocked by bias";
        } else {
            const entryPx = sn.boxLow ?? 0;
            let touchDetected = false;
            let overshot = false;

            for (const c of recentCandles.slice(-5)) {
                if (c.low <= entryPx) touchDetected = true;
                if (c.low < entryPx - (atr * 0.15)) overshot = true;
            }

            const reactionDetected = touchDetected && lastPrice > entryPx * 1.0003;
            reversalConfirmed = touchDetected && !overshot && reactionDetected;

            if (reversalConfirmed) {
                signal = "LONG_CANDIDATE";
                reason = "Lower edge reversal identified by price reaction";
            } else {
                signal = "WAIT_RECHECK";
                reason = touchDetected 
                    ? (overshot ? "Lower edge overshot; reversal invalidated" : "Lower edge touched; awaiting reaction")
                    : "Lower edge reached; awaiting touch and reaction";
                recheckSuggested = true;
            }
        }
    } else {
        reason = "Mid-zone neutrality enforced (no-reversal candidates)";
    }

    // Phase 6: Drift & Channel Entry Filtering
    const isDownStructure = judgment.subtype === "RANGE_DRIFT_DOWN" || judgment.subtype === "DESCENDING_CHANNEL";
    const isUpStructure = judgment.subtype === "RANGE_DRIFT_UP" || judgment.subtype === "ASCENDING_CHANNEL";

    if (isDownStructure || isUpStructure) {
        const direction = isDownStructure ? "down" : "up";
        const primarySide: EngineV2Side = isDownStructure ? "short" : "long";
        const blockedSide: EngineV2Side = isDownStructure ? "long" : "short";
        const badChaseZone = isDownStructure ? "lower" : "upper";
        const validEntryZone = isDownStructure ? "upper" : "lower";
        const symmetryCase = isDownStructure ? "DRIFT_DOWN_SYMMETRY" : "DRIFT_UP_SYMMETRY";

        if (side === blockedSide) {
            signal = "NONE";
            reason = `SUPPRESSED: ${side} blocked in ${judgment.subtype} (${direction} bias)`;
        } else if (side === primarySide) {
            if (isMid) {
                signal = "NONE";
                reason = `SUPPRESSED: Mid entry blocked in ${judgment.subtype} (central neutrality enforced)`;
            } else if ((isDownStructure && isLower) || (isUpStructure && isUpper)) {
                signal = "NONE";
                reason = `SUPPRESSED: ${badChaseZone} chase blocked in ${judgment.subtype} (only ${validEntryZone} entries allowed)`;
            }
        }
    }

    // Phase 6.5: Volume-Based Breakout / Shock Entry Filtering
    const isVolDown = judgment.subtype === "VOLUME_BREAKDOWN_OBSERVATION" || judgment.subtype === "VOLUME_SHOCK_DOWN" || judgment.subtype === "BREAKDOWN_RETEST_FAILED" || judgment.subtype === "FAKE_VOLUME_BREAKDOWN";
    const isVolUp = judgment.subtype === "VOLUME_BREAKOUT_OBSERVATION" || judgment.subtype === "VOLUME_SHOCK_UP" || judgment.subtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME" || judgment.subtype === "FAKE_VOLUME_BREAKOUT";

    if (isVolDown || isVolUp) {
        const direction = isVolDown ? "down" : "up";
        const primarySide: EngineV2Side = isVolDown ? "short" : "long";
        const blockedSide: EngineV2Side = isVolDown ? "long" : "short";

        const isObservation = judgment.subtype === "VOLUME_BREAKDOWN_OBSERVATION" || judgment.subtype === "VOLUME_BREAKOUT_OBSERVATION";
        const isShock = judgment.subtype === "VOLUME_SHOCK_DOWN" || judgment.subtype === "VOLUME_SHOCK_UP";
        const isRetestSuccess = judgment.subtype === "BREAKDOWN_RETEST_FAILED" || judgment.subtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME";
        const isFake = judgment.subtype === "FAKE_VOLUME_BREAKDOWN" || judgment.subtype === "FAKE_VOLUME_BREAKOUT";

        const preVolumeSide = side;
        firstBreakoutChaseBlocked = false;
        retestRequired = isObservation || isShock;
        retestPassed = isRetestSuccess;

        if (side === blockedSide && !isRetestSuccess) {
            signal = "NONE";
            reason = `SUPPRESSED: ${side} blocked in ${judgment.subtype} (${direction} bias)`;
        } else if (side === primarySide || isRetestSuccess) {
            if (isObservation || isShock) {
                signal = "NONE";
                reason = `SUPPRESSED: First ${direction} breakout candle chase blocked; awaiting retest`;
                firstBreakoutChaseBlocked = true;
            } else if (isRetestSuccess) {
                side = primarySide;
                signal = primarySide === "short" ? "SHORT_CANDIDATE" : "LONG_CANDIDATE";
                reason = `VOLUME_RETEST_SUCCESS: Forcing ${side} entry after retest validation`;
                sideOverrideApplied = true;
            } else if (isFake) {
                signal = "NONE";
                reason = `SUPPRESSED: Market returned inside box (${judgment.subtype})`;
            }
        } else if (isFake) {
            signal = "NONE";
            reason = `SUPPRESSED: Market indecision after fake breakout`;
        }
    }

    // Phase 7: Volume Shock Entry Filtering
    if (judgment.shockPhase === "DOWN_SHOCK" || judgment.shockPhase === "UP_SHOCK") {
        const primarySide: EngineV2Side = judgment.shockPhase === "DOWN_SHOCK" ? "short" : "long";
        const blockedSide: EngineV2Side = judgment.shockPhase === "DOWN_SHOCK" ? "long" : "short";

        if (side === blockedSide) {
            signal = "NONE";
            reason = `SUPPRESSED: ${side} blocked in ${judgment.shockPhase} (directional shock bias)`;
        } else if (side === primarySide) {
             if ((judgment.shockPhase === "DOWN_SHOCK" && isLower) || (judgment.shockPhase === "UP_SHOCK" && isUpper)) {
                signal = "NONE";
                reason = `SUPPRESSED: ${side} chase blocked during ${judgment.shockPhase}`;
             }
        }
    }

    // --- EXIT PLAN GENERATION (Mandatory for RANGE) ---
    const entryPx = Number(sn.lastPrice ?? 0);
    const minProfitDistance = Math.max(atr * 0.35, entryPx * 0.001);
    const minStopDistance = Math.max(atr * 0.5, entryPx * 0.0015);

    let tp1 = 0;
    let tp2 = 0;
    let inv = 0;

    if (side === "long") {
        inv = Math.min(boxLow - minStopDistance, entryPx - minStopDistance);
        tp1 = Math.max(boxMid, entryPx + minProfitDistance);
        if (tp1 <= entryPx) tp1 = entryPx + minProfitDistance;
        tp2 = Math.max(boxHigh, tp1 + minProfitDistance);
        if (tp2 <= tp1) tp2 = tp1 + minProfitDistance;
    } else if (side === "short") {
        inv = Math.max(boxHigh + minStopDistance, entryPx + minStopDistance);
        tp1 = Math.min(boxMid, entryPx - minProfitDistance);
        if (tp1 >= entryPx) tp1 = entryPx - minProfitDistance;
        tp2 = Math.min(boxLow, tp1 - minProfitDistance);
        if (tp2 >= tp1) tp2 = tp1 - minProfitDistance;
    }

    const boxHeight = boxHigh - boxLow;
    const boxHeightPct = boxLow > 0 ? boxHeight / boxLow : 0;
    const longOrderOk = inv < entryPx && entryPx < tp1 && tp1 < tp2;
    const shortOrderOk = tp2 < tp1 && tp1 < entryPx && entryPx < inv;
    const validationOk = side === "long" ? longOrderOk : side === "short" ? shortOrderOk : false;
    let invalidTpReason: string;
    if (!Number.isFinite(entryPx) || entryPx <= 0 || !Number.isFinite(tp1) || !Number.isFinite(tp2) || !Number.isFinite(inv)) {
        invalidTpReason = "non_finite_or_non_positive_entry";
    } else if (tp1 <= 0 || tp2 <= 0 || inv <= 0) {
        invalidTpReason = "zero_or_negative_levels";
    } else if (boxHeightPct < 0.0008) {
        invalidTpReason = "narrow_box";
    } else if (!validationOk) {
        invalidTpReason = side === "long" ? "long_validation_failed" : "short_validation_failed";
    } else {
        invalidTpReason = "";
    }
    const isPlanInvalid = invalidTpReason !== "";

    if (isPlanInvalid && signal !== "NONE" && currentStage === 0) {
        signal = "NONE";
        reason = `V2_RANGE_ENTRY_BLOCKED: Invalid TP plan (${invalidTpReason})`;
    }

    if (isMeanReversionBlockedByDistortion && signal !== "NONE" && currentStage === 0) {
        const isContinuation = (isDriftDown && side === "short") || (isDriftUp && side === "long");
        if (!isContinuation) {
            signal = "NONE";
            reason = "V2_RANGE_MEAN_REVERSION_BLOCKED: Box distortion active";
        }
    }

    const takeProfitPlan = (tp1 > 0 && tp2 > 0 && inv > 0) ? {
        tp1,
        tp2,
        invalidationPx: inv,
        partialRatio: 0.5,
        version: "v2_range_fixed_plan_v1"
    } : null;

    lateChaseBlocked = false;
    if (side === "long" && currentBoxPos > 0.88) {
        lateChaseBlocked = true;
        signal = "NONE";
        reason = "LATE_CHASE_GUARD: Long entry blocked at extreme upper boundary";
    } else if (side === "short" && currentBoxPos < 0.12) {
        lateChaseBlocked = true;
        signal = "NONE";
        reason = "LATE_CHASE_GUARD: Short entry blocked at extreme lower boundary";
    }

    const metadata: Record<string, string | number | boolean | null | any> = {
        boxPos: currentBoxPos,
        rangeConfidence,
        breakoutFailureRate,
        rangeOscillationScore,
        isUpper,
        isLower,
        isMid,
        reversal_confirmed: reversalConfirmed,
        late_chase_blocked: lateChaseBlocked,
        sideOverrideApplied,
        qualityScore,
        isDistorted,
        isDrifting,
        distortionFactor,
        takeProfitPlan,
        takeProfit1Px: tp1,
        takeProfit2Px: tp2,
        partialExitRatio: 0.5,
        invalidationPx: inv,
        rangeBoxHighAtEntry: boxHigh,
        rangeBoxLowAtEntry: boxLow,
        rangeBoxMidAtEntry: boxMid,
        rangeBoxQuality: qualityScore,
        rangeBoxSlope: bhSlope, // Approximate
        rangeBoxDistorted: isDistorted
    };

    const finalSide = signal === "NONE" ? "none" as const : side;
    const finalStopPrice = signal === "NONE" ? null : (inv || null);
    const finalInvalidationPx = signal === "NONE" ? null : (inv || null);
    if (signal === "NONE") {
        metadata.takeProfitPlan = null;
        metadata.takeProfit1Px = 0;
        metadata.takeProfit2Px = 0;
        metadata.invalidationPx = null;
    }

    return {
        signal,
        side: finalSide,
        reason,
        baseSizeIntent: signal === "NONE" ? 0 : 1,
        recheckSuggested,
        isAddOnEligible: true,
        stopPrice: finalStopPrice,
        invalidationPx: finalInvalidationPx,
        metadata
    };
}
