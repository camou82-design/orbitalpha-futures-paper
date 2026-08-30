import { EngineV2Input, EngineV2Side, ExecutorOutput, MarketJudgmentOutput } from "../types";
import { classifyRangeZone } from "../../models/types";
import { computeSoftExitFeeBreakEvenPct, DEFAULT_SOFT_EXIT_SLIPPAGE_BUFFER_PCT } from "../exit/soft-exit-fee-gate";
import {
    getClosedCandlesForStructuralStop,
    resolveFastTrendShiftStructuralStop
} from "../risk-sizing/fast-trend-shift-structural-stop";

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
    lastLoggedDeadlockBreakdownRunCycleId: string | null;
    previousConfirmedBoxHigh: number | null;
    previousConfirmedBoxLow: number | null;
    countBoundaryPrice: number | null;
    countBoundarySource: "previous_confirmed" | "current_fallback" | null;
    lastObservedBoxHigh: number | null;
    lastObservedBoxLow: number | null;
    lastObservedCandleTs: number | null;
}

export const rangeContinuationStateMap = new Map<string, RangeContinuationState>();

type CycleCandleAdvanceObservation = {
    runCycleId: string;
    symbol: string;
    currentCandleTs: number;
    previousCommittedCandleTs: number | null;
    rawCandleAdvanced: boolean;
    authoritativeCandleAdvanced: boolean;
};

/** Cycle-local immutable candle advance observation (authoritative pass only). */
const cycleCandleAdvanceObservationMap = new Map<string, CycleCandleAdvanceObservation>();

function pruneCycleCandleAdvanceObservations(activeRunCycleId: string): void {
    for (const key of cycleCandleAdvanceObservationMap.keys()) {
        if (!key.endsWith(`:${activeRunCycleId}`)) {
            cycleCandleAdvanceObservationMap.delete(key);
        }
    }
}

function resolveAuthoritativeCandleAdvance(
    input: EngineV2Input,
    lastCandleTimestamp: number
): {
    previousCommittedLastCandleTs: number | null;
    rawCandleAdvanced: boolean;
    authoritativeCandleAdvancedThisCycle: boolean;
    stateMutationAllowed: boolean;
    diagnosticMutationBlocked: boolean;
} {
    const isAuthoritative = input.evaluationMode !== "diagnostic";
    const currentRunCycleId = input.run_cycle_id ?? "unknown";
    const stored = rangeContinuationStateMap.get(input.symbol);
    const previousCommittedLastCandleTs = stored?.lastCandleTimestamp ?? null;
    const currentCandleTs = lastCandleTimestamp;
    const rawCandleAdvanced =
        previousCommittedLastCandleTs != null &&
        currentCandleTs !== 0 &&
        currentCandleTs !== previousCommittedLastCandleTs;
    const authoritativeFromComparison =
        previousCommittedLastCandleTs != null &&
        currentCandleTs !== 0 &&
        currentCandleTs > previousCommittedLastCandleTs;

    if (!isAuthoritative) {
        const authKey = `${input.symbol}:${currentRunCycleId}`;
        const authObs = cycleCandleAdvanceObservationMap.get(authKey);
        return {
            previousCommittedLastCandleTs,
            rawCandleAdvanced,
            authoritativeCandleAdvancedThisCycle: authObs?.authoritativeCandleAdvanced ?? authoritativeFromComparison,
            stateMutationAllowed: false,
            diagnosticMutationBlocked: true
        };
    }

    pruneCycleCandleAdvanceObservations(currentRunCycleId);
    const authKey = `${input.symbol}:${currentRunCycleId}`;
    let obs = cycleCandleAdvanceObservationMap.get(authKey);
    if (!obs) {
        obs = {
            runCycleId: currentRunCycleId,
            symbol: input.symbol,
            currentCandleTs,
            previousCommittedCandleTs: previousCommittedLastCandleTs,
            rawCandleAdvanced,
            authoritativeCandleAdvanced: authoritativeFromComparison
        };
        cycleCandleAdvanceObservationMap.set(authKey, obs);
    }

    return {
        previousCommittedLastCandleTs,
        rawCandleAdvanced,
        authoritativeCandleAdvancedThisCycle: obs.authoritativeCandleAdvanced,
        stateMutationAllowed: true,
        diagnosticMutationBlocked: false
    };
}

function emitCandleAdvanceAuthorityProof(
    input: EngineV2Input,
    candleAdvance: ReturnType<typeof resolveAuthoritativeCandleAdvance>,
    opts: {
        commitPerformed: boolean;
        deadlockCandleAdvanced: boolean;
    }
): void {
    const consistencyPassed =
        !candleAdvance.rawCandleAdvanced ||
        candleAdvance.authoritativeCandleAdvancedThisCycle === opts.deadlockCandleAdvanced;
    const payload = {
        event: "V2_CANDLE_ADVANCE_AUTHORITY_PROOF",
        symbol: input.symbol,
        runCycleId: input.run_cycle_id ?? "unknown",
        evaluationMode: input.evaluationMode ?? "authoritative",
        currentCandleTs: input.snapshot?.candles?.length
            ? input.snapshot.candles[input.snapshot.candles.length - 1]?.ts ?? 0
            : 0,
        previousCommittedCandleTs: candleAdvance.previousCommittedLastCandleTs,
        rawCandleAdvanced: candleAdvance.rawCandleAdvanced,
        authoritativeCandleAdvanced: candleAdvance.authoritativeCandleAdvancedThisCycle,
        stateMutationAllowed: candleAdvance.stateMutationAllowed,
        commitPerformed: opts.commitPerformed,
        diagnosticMutationBlocked: candleAdvance.diagnosticMutationBlocked,
        deadlockCandleAdvanced: opts.deadlockCandleAdvanced,
        consistencyPassed
    };
    if (!consistencyPassed && candleAdvance.stateMutationAllowed) {
        console.error(JSON.stringify(payload));
    } else {
        console.info(JSON.stringify(payload));
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Tier 4: Range Executor (Refined)
 * Hardened with Late Chase Guard, Zone-based Side Filtering, and Deadlock Continuation Watch.
 */
export function executeRangeRegime(input: EngineV2Input, judgment: MarketJudgmentOutput): ExecutorOutput {
    const { snapshot: sn } = input;
    const boxCohesion01 = typeof sn.boxCohesion01 === "number" && Number.isFinite(sn.boxCohesion01) ? sn.boxCohesion01 : 0;
    const trendWeaknessScore = typeof sn.trendWeaknessScore === "number" && Number.isFinite(sn.trendWeaknessScore) ? sn.trendWeaknessScore : 0;
    const rangeConfidence = typeof sn.rangeConfidence === "number" && Number.isFinite(sn.rangeConfidence) ? sn.rangeConfidence : 0;
    const boxPos = typeof sn.boxPos === "number" && Number.isFinite(sn.boxPos) ? sn.boxPos : null;
    const breakoutFailureRate = typeof sn.breakoutFailureRate === "number" && Number.isFinite(sn.breakoutFailureRate) ? sn.breakoutFailureRate : 0;
    const rangeOscillationScore = typeof sn.rangeOscillationScore === "number" && Number.isFinite(sn.rangeOscillationScore) ? sn.rangeOscillationScore : 0;

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
            metadata: {
                whipsaw_shock_recheck: true,
                boxPos,
                rangeConfidence,
                boxCohesion01,
                trendWeaknessScore,
                breakoutFailureRate,
                rangeOscillationScore
            }
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

    if (judgment.subtype === "FAST_TREND_SHIFT" && judgment.diagnostics?.fastTrendShift?.direction === "long") {
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
                }
            };
        }
        const baseSizeIntent = judgment.diagnostics?.fastTrendShift?.baseSizeIntent ?? 0.32;
        return {
            signal: "LONG_CANDIDATE",
            side: "long",
            reason: judgment.subtypeReason,
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
                box_mid: boxMid,
                boxPos,
                rangeConfidence,
                boxCohesion01,
                trendWeaknessScore,
                breakoutFailureRate,
                rangeOscillationScore
            }
        };
    }

    if (judgment.subtype === "FAST_TREND_SHIFT" && judgment.diagnostics?.fastTrendShift?.direction === "short") {
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
                }
            };
        }
        const baseSizeIntent = judgment.diagnostics?.fastTrendShift?.baseSizeIntent ?? 0.32;
        return {
            signal: "SHORT_CANDIDATE",
            side: "short",
            reason: judgment.subtypeReason,
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
                box_mid: boxMid,
                boxPos,
                rangeConfidence,
                boxCohesion01,
                trendWeaknessScore,
                breakoutFailureRate,
                rangeOscillationScore
            }
        };
    }

    if (judgment.subtype === "EARLY_LONG_PROBE") {
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
                fast_trend_shift: false,
                stop_basis: "conservative_probe_basis",
                swing_low: swingLow,
                box_mid: boxMid,
                atr_stop: stopBasisAtr,
                boxPos,
                rangeConfidence,
                boxCohesion01,
                trendWeaknessScore,
                breakoutFailureRate,
                rangeOscillationScore
            }
        };
    }

    if (judgment.subtype === "EARLY_SHORT_PROBE") {
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
                fast_trend_shift: false,
                stop_basis: "conservative_probe_basis",
                swing_high: swingHigh,
                box_mid: boxMid,
                atr_stop: stopBasisAtr,
                boxPos,
                rangeConfidence,
                boxCohesion01,
                trendWeaknessScore,
                breakoutFailureRate,
                rangeOscillationScore
            }
        };
    }

    const isDistorted = (judgment.metadata as any)?.isDistorted === true;
    const isDrifting = (judgment.metadata as any)?.isDrifting === true;
    const distortionFactor = (judgment.metadata as any)?.distortionFactor ?? 0;
    const bhSlope = (judgment.metadata as any)?.bhSlope ?? sn.boxHighSlope ?? 0;
    const blSlope = (judgment.metadata as any)?.blSlope ?? sn.boxLowSlope ?? 0;
    const rcSlope = (judgment.metadata as any)?.rcSlope ?? sn.rangeCenterSlope ?? 0;

    const bhSlopeSource = (judgment.metadata as any)?.bhSlope !== undefined ? "judgment_metadata" : (sn.boxHighSlope !== undefined ? "snapshot" : "missing");
    const blSlopeSource = (judgment.metadata as any)?.blSlope !== undefined ? "judgment_metadata" : (sn.boxLowSlope !== undefined ? "snapshot" : "missing");
    const rcSlopeSource = (judgment.metadata as any)?.rcSlope !== undefined ? "judgment_metadata" : (sn.rangeCenterSlope !== undefined ? "snapshot" : "missing");

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

    let localTouchDetected = false;
    let localOvershot = false;
    let localReactionDetected = false;

    if (isUpper) {
        const entryPx = sn.boxHigh ?? 0;
        for (const c of recentCandles.slice(-5)) {
            if (c.high >= entryPx) localTouchDetected = true;
            if (c.high > entryPx + (atr * 0.15)) localOvershot = true;
        }
        localReactionDetected = localTouchDetected && lastPrice < entryPx * 0.9997;
        if (localTouchDetected && !localOvershot && localReactionDetected) {
            reversalConfirmed = true;
        }
    } else if (isLower) {
        const entryPx = sn.boxLow ?? 0;
        for (const c of recentCandles.slice(-5)) {
            if (c.low <= entryPx) localTouchDetected = true;
            if (c.low < entryPx - (atr * 0.15)) localOvershot = true;
        }
        localReactionDetected = localTouchDetected && lastPrice > entryPx * 1.0003;
        if (localTouchDetected && !localOvershot && localReactionDetected) {
            reversalConfirmed = true;
        }
    }

    // --- CONTINUATION STATE MACHINE (Deadlock Resolver) ---
    const storedContinuationState = rangeContinuationStateMap.get(input.symbol);
    let cState = storedContinuationState ? { ...storedContinuationState } : {
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
        lastLoggedRunCycleId: null,
        lastLoggedDeadlockBreakdownRunCycleId: null,
        previousConfirmedBoxHigh: null,
        previousConfirmedBoxLow: null,
        countBoundaryPrice: null,
        countBoundarySource: null,
        lastObservedBoxHigh: null,
        lastObservedBoxLow: null,
        lastObservedCandleTs: null
    } as RangeContinuationState;

    const candleAdvance = resolveAuthoritativeCandleAdvance(input, lastCandleTimestamp);
    const currentLastCandleTimestamp = lastCandleTimestamp;
    const previousLastCandleTimestamp = candleAdvance.previousCommittedLastCandleTs;
    const authoritativeCandleAdvancedThisCycle = candleAdvance.authoritativeCandleAdvancedThisCycle;
    const candleAdvancedThisCycle = authoritativeCandleAdvancedThisCycle;

    const now = Date.now();
    let shouldResetWatch = false;

    const logProof = (event: string, payload: any) => {
        const eventKey = `${currentRunCycleId}:${event}`;
        if (cState.lastLoggedRunCycleId !== eventKey) {
            console.warn(JSON.stringify({ event, symbol: input.symbol, ...payload }));
            cState.lastLoggedRunCycleId = eventKey;
            if (isAuthoritative) {
                rangeContinuationStateMap.set(input.symbol, cState);
            }
        }
    };

    const atrPct = lastPrice > 0 ? (atr / lastPrice) : 0;
    const retestTolerancePct = clamp(atrPct * 0.5, 0.0010, 0.0030); // 0.10% ~ 0.30%
    const noRetestSkipPct = clamp(atrPct * 1.5, 0.0050, 0.0100);    // 0.5% ~ 1.0%

    // Promotion logic for previousConfirmedBoxHigh/Low (authoritative commit only)
    if (isAuthoritative && lastCandleTimestamp !== 0 && lastCandleTimestamp !== cState.lastObservedCandleTs) {
        if (cState.lastObservedCandleTs !== null) {
            cState.previousConfirmedBoxHigh = cState.lastObservedBoxHigh;
            cState.previousConfirmedBoxLow = cState.lastObservedBoxLow;
        }
        cState.lastObservedCandleTs = lastCandleTimestamp;
    }

    if (isAuthoritative) {
        cState.lastObservedBoxHigh = boxHigh;
        cState.lastObservedBoxLow = boxLow;
    } else {
        // Diagnostic observation uses stored values without mutating committed box cache.
        cState.lastObservedBoxHigh = cState.lastObservedBoxHigh ?? boxHigh;
        cState.lastObservedBoxLow = cState.lastObservedBoxLow ?? boxLow;
    }

    const recentClosedClose = recentCandles.length >= 2 
        ? recentCandles[recentCandles.length - 2].close 
        : null;
    
    const isDownSlopeAligned = blSlope < 0 || rcSlope < 0;
    const isDownSlopeOpposite = blSlope > 0 && rcSlope > 0;
    const isDownSlopeValid = isDownSlopeAligned && !isDownSlopeOpposite;

    const isUpSlopeAligned = bhSlope > 0 || rcSlope > 0;
    const isUpSlopeOpposite = bhSlope < 0 && rcSlope < 0;
    const isUpSlopeValid = isUpSlopeAligned && !isUpSlopeOpposite;
    
    // For DEADLOCK_COUNTING locking
    const effectiveUpBoundary = (cState.direction === "up" && cState.countBoundaryPrice !== null) 
        ? cState.countBoundaryPrice 
        : (cState.previousConfirmedBoxHigh ?? boxHigh);
        
    const effectiveDownBoundary = (cState.direction === "down" && cState.countBoundaryPrice !== null) 
        ? cState.countBoundaryPrice 
        : (cState.previousConfirmedBoxLow ?? boxLow);

    const isDownTrendEvidence = judgment.trendPhase === "DOWN" || (judgment.trendPhase === "EXHAUSTION" && emaGap < 0);
    const isUpTrendEvidence = judgment.trendPhase === "UP" || (judgment.trendPhase === "EXHAUSTION" && emaGap > 0);

    const isDownDeadlockCountingCondition = 
        isDownTrendEvidence && 
        emaGap < 0 && 
        !reversalConfirmed && 
        (lastPrice < effectiveDownBoundary || (recentClosedClose !== null && recentClosedClose < effectiveDownBoundary));

    const isUpDeadlockCountingCondition = 
        isUpTrendEvidence && 
        emaGap > 0 && 
        !reversalConfirmed && 
        (lastPrice > effectiveUpBoundary || (recentClosedClose !== null && recentClosedClose > effectiveUpBoundary));

    const MAX_CONTINUATION_CYCLES = 10;
    let expiredThisCycle = false;

    if (cState.phase === "CONTINUATION_WATCH" || cState.phase === "RETEST_TOUCHED") {
        if (reversalConfirmed) shouldResetWatch = true;
        if (cState.direction === "down" && judgment.trendPhase === "UP") shouldResetWatch = true;
        if (cState.direction === "up" && judgment.trendPhase === "DOWN") shouldResetWatch = true;
        if (cState.watchStartedAtTimestamp && (now - cState.watchStartedAtTimestamp > 10 * 60 * 1000)) shouldResetWatch = true;
        if (cState.totalCyclesSinceWatch >= MAX_CONTINUATION_CYCLES) {
            shouldResetWatch = true;
            expiredThisCycle = true;
        }
        if (cState.direction === "down" && lastPrice > boxHigh) shouldResetWatch = true;
        if (cState.direction === "up" && lastPrice < boxLow) shouldResetWatch = true;
        if (currentStage > 0) shouldResetWatch = true;
    } else if (cState.phase === "DEADLOCK_COUNTING") {
        if (reversalConfirmed) shouldResetWatch = true;
        if (cState.direction === "down" && judgment.trendPhase === "UP") shouldResetWatch = true;
        if (cState.direction === "up" && judgment.trendPhase === "DOWN") shouldResetWatch = true;
        if (currentStage > 0) shouldResetWatch = true;
        if (cState.direction === "down" && !isDownDeadlockCountingCondition) shouldResetWatch = true;
        if (cState.direction === "up" && !isUpDeadlockCountingCondition) shouldResetWatch = true;
        if (cState.consecutiveCycles >= MAX_CONTINUATION_CYCLES) {
            shouldResetWatch = true;
            expiredThisCycle = true;
        }
    }

    if (shouldResetWatch && isAuthoritative) {
        cState = {
            symbol: input.symbol,
            direction: null,
            phase: "IDLE",
            consecutiveCycles: 0,
            lastRunCycleId: expiredThisCycle ? currentRunCycleId : null,
            lastCandleTimestamp: null,
            watchBoundaryPrice: null,
            watchStartedAtTimestamp: null,
            totalCyclesSinceWatch: 0,
            countStartedCandleTs: null,
            hasCandleAdvancedDuringCount: false,
            watchStartedCandleTs: null,
            lastLoggedRunCycleId: null,
            lastLoggedDeadlockBreakdownRunCycleId: null,
            previousConfirmedBoxHigh: cState.previousConfirmedBoxHigh,
            previousConfirmedBoxLow: cState.previousConfirmedBoxLow,
            countBoundaryPrice: null,
            countBoundarySource: null,
            lastObservedBoxHigh: cState.lastObservedBoxHigh,
            lastObservedBoxLow: cState.lastObservedBoxLow,
            lastObservedCandleTs: cState.lastObservedCandleTs
        } as RangeContinuationState;
    }

    let updatedCycle = false;
    let commitPerformed = false;
    // Position open -> immediate IDLE (authoritative commit only)
    if (isAuthoritative && currentStage > 0 && cState.phase !== "IDLE") {
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
        
        const timestampChanged = authoritativeCandleAdvancedThisCycle;
        
        if (cState.phase === "RETEST_CONFIRMED") {
            cState.phase = "EXPIRED";
        }
        if (cState.phase === "EXPIRED" && timestampChanged) {
            cState.phase = "IDLE";
            cState.direction = null;
        }
        
        if (cState.phase === "IDLE" || cState.phase === "DEADLOCK_COUNTING") {
            if (isDownDeadlockCountingCondition) {
                if (cState.direction !== "down") {
                    if (currentStage === 0) {
                        cState.direction = "down";
                        cState.consecutiveCycles = 1;
                        cState.countStartedCandleTs = lastCandleTimestamp;
                        cState.hasCandleAdvancedDuringCount = false;
                        cState.countBoundaryPrice = cState.previousConfirmedBoxLow ?? boxLow;
                        cState.countBoundarySource = cState.previousConfirmedBoxLow !== null ? "previous_confirmed" : "current_fallback";
                    }
                } else {
                    cState.consecutiveCycles++;
                }
                if (cState.direction === "down" && lastCandleTimestamp > (cState.countStartedCandleTs ?? 0)) {
                    cState.hasCandleAdvancedDuringCount = true;
                }
                if (cState.direction === "down") cState.phase = "DEADLOCK_COUNTING";
            } else if (isUpDeadlockCountingCondition) {
                if (cState.direction !== "up") {
                    if (currentStage === 0) {
                        cState.direction = "up";
                        cState.consecutiveCycles = 1;
                        cState.countStartedCandleTs = lastCandleTimestamp;
                        cState.hasCandleAdvancedDuringCount = false;
                        cState.countBoundaryPrice = cState.previousConfirmedBoxHigh ?? boxHigh;
                        cState.countBoundarySource = cState.previousConfirmedBoxHigh !== null ? "previous_confirmed" : "current_fallback";
                    }
                } else {
                    cState.consecutiveCycles++;
                }
                if (cState.direction === "up" && lastCandleTimestamp > (cState.countStartedCandleTs ?? 0)) {
                    cState.hasCandleAdvancedDuringCount = true;
                }
                if (cState.direction === "up") cState.phase = "DEADLOCK_COUNTING";
            }
        }
        
        if (cState.phase === "DEADLOCK_COUNTING" && cState.consecutiveCycles >= 3 && cState.hasCandleAdvancedDuringCount) {
            if ((cState.direction === "down" && isDownSlopeAligned) || (cState.direction === "up" && isUpSlopeAligned)) {
                cState.phase = "CONTINUATION_WATCH";
                logProof(cState.direction === "down" ? "RANGE_BREAKDOWN_CONTINUATION_WATCH" : "RANGE_BREAKOUT_CONTINUATION_WATCH", { boxLow, boxHigh });
                cState.watchStartedAtTimestamp = now;
                cState.watchStartedCandleTs = lastCandleTimestamp;
                cState.totalCyclesSinceWatch = 0;
                cState.watchBoundaryPrice = cState.countBoundaryPrice;
            }
        }

        cState.lastRunCycleId = currentRunCycleId;
        cState.lastCandleTimestamp = lastCandleTimestamp;
        updatedCycle = true;
        commitPerformed = true;
    }
    
    if (updatedCycle) {
        if (isAuthoritative) {
            rangeContinuationStateMap.set(input.symbol, cState);
        }
    }

    const deadlockCandleAdvanced = authoritativeCandleAdvancedThisCycle;

    if (isAuthoritative) {
        emitCandleAdvanceAuthorityProof(input, candleAdvance, {
            commitPerformed,
            deadlockCandleAdvanced
        });

        if (isDownTrendEvidence || isUpTrendEvidence) {
            const direction = isDownTrendEvidence ? "down" : "up";
            const dedupeKey = `${input.symbol}:${currentRunCycleId}:${direction}`;
            if (cState.lastLoggedDeadlockBreakdownRunCycleId !== dedupeKey) {
                cState.lastLoggedDeadlockBreakdownRunCycleId = dedupeKey;
                rangeContinuationStateMap.set(input.symbol, cState);

                console.warn(JSON.stringify({
                    event: "V2_RANGE_DEADLOCK_CONDITION_BREAKDOWN_PROOF",
                    symbol: input.symbol,
                    direction,
                    runCycleId: currentRunCycleId,
                    evaluationMode: input.evaluationMode,
                    authoritativeCandleAdvancedThisCycle,
                    checks: direction === "down" ? {
                        trendDown: isDownTrendEvidence,
                        emaNegative: emaGap < 0,
                        noReversal: !reversalConfirmed,
                        boundaryBrokenByLastPrice: lastPrice < effectiveDownBoundary,
                        boundaryBrokenByClose: recentClosedClose !== null && recentClosedClose < effectiveDownBoundary,
                        countingEligible: isDownDeadlockCountingCondition,
                        slopeAligned: isDownSlopeAligned,
                        boundarySlopeNegative: blSlope < 0,
                        centerSlopeNegative: rcSlope < 0,
                        authoritative: true,
                        candleAdvanced: deadlockCandleAdvanced,
                        hasCandleAdvancedDuringCount: cState.hasCandleAdvancedDuringCount,
                        currentBoxHigh: boxHigh,
                        currentBoxLow: boxLow,
                        previousConfirmedBoxHigh: cState.previousConfirmedBoxHigh,
                        previousConfirmedBoxLow: cState.previousConfirmedBoxLow,
                        boundaryReferenceSource: cState.previousConfirmedBoxLow !== null ? "previous_confirmed" : "current",
                        boundaryDistancePct: effectiveDownBoundary !== 0 ? (lastPrice - effectiveDownBoundary) / effectiveDownBoundary : 0,
                        slopeAlignmentMode: "bl_or_rc_negative",
                        alignedSlopeCount: (blSlope < 0 ? 1 : 0) + (rcSlope < 0 ? 1 : 0)
                    } : {
                        trendUp: isUpTrendEvidence,
                        emaPositive: emaGap > 0,
                        noReversal: !reversalConfirmed,
                        boundaryBrokenByLastPrice: lastPrice > effectiveUpBoundary,
                        boundaryBrokenByClose: recentClosedClose !== null && recentClosedClose > effectiveUpBoundary,
                        countingEligible: isUpDeadlockCountingCondition,
                        slopeAligned: isUpSlopeAligned,
                        boundarySlopePositive: bhSlope > 0,
                        centerSlopePositive: rcSlope > 0,
                        authoritative: true,
                        candleAdvanced: deadlockCandleAdvanced,
                        hasCandleAdvancedDuringCount: cState.hasCandleAdvancedDuringCount,
                        currentBoxHigh: boxHigh,
                        currentBoxLow: boxLow,
                        previousConfirmedBoxHigh: cState.previousConfirmedBoxHigh,
                        previousConfirmedBoxLow: cState.previousConfirmedBoxLow,
                        boundaryReferenceSource: cState.previousConfirmedBoxHigh !== null ? "previous_confirmed" : "current",
                        boundaryDistancePct: effectiveUpBoundary !== 0 ? (lastPrice - effectiveUpBoundary) / effectiveUpBoundary : 0,
                        slopeAlignmentMode: "bh_or_rc_positive",
                        alignedSlopeCount: (bhSlope > 0 ? 1 : 0) + (rcSlope > 0 ? 1 : 0)
                    },
                    deadlockCountingStarted: direction === "down" ? isDownDeadlockCountingCondition : isUpDeadlockCountingCondition,
                    continuationWatchEligible: cState.consecutiveCycles >= 3 && cState.hasCandleAdvancedDuringCount && (direction === "down" ? isDownSlopeAligned : isUpSlopeAligned)
                }));
            }
        }
    } else {
        emitCandleAdvanceAuthorityProof(input, candleAdvance, {
            commitPerformed: false,
            deadlockCandleAdvanced
        });
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
                if (isAuthoritative) {
                    rangeContinuationStateMap.set(input.symbol, cState);
                }
            }
            
            if (cState.phase === "RETEST_TOUCHED" && lastPrice < watchBoundary * (1 - retestTolerancePct * 1.5)) {
                const phaseBefore = cState.phase;
                cState.phase = "RETEST_CONFIRMED";
                logProof("BREAKDOWN_RETEST_SHORT_CONFIRMED", { 
                    runCycleId: currentRunCycleId,
                    evaluationMode: input.evaluationMode,
                    isAuthoritative,
                    phaseBefore,
                    phaseAfter: cState.phase,
                    watchBoundary, 
                    lastPrice 
                });
                if (isAuthoritative) {
                    rangeContinuationStateMap.set(input.symbol, cState);
                }
                
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
                    metadata: { 
                        skipped_no_retest: true, 
                        watchBoundary, 
                        continuationDirection: cState.direction, 
                        continuationPhase: cState.phase, 
                        watchStartedCandleTs: cState.watchStartedCandleTs 
                    }
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
                if (isAuthoritative) {
                    rangeContinuationStateMap.set(input.symbol, cState);
                }
            }
            
            if (cState.phase === "RETEST_TOUCHED" && lastPrice > watchBoundary * (1 + retestTolerancePct * 1.5)) {
                const phaseBefore = cState.phase;
                cState.phase = "RETEST_CONFIRMED";
                logProof("BREAKOUT_RETEST_LONG_CONFIRMED", { 
                    runCycleId: currentRunCycleId,
                    evaluationMode: input.evaluationMode,
                    isAuthoritative,
                    phaseBefore,
                    phaseAfter: cState.phase,
                    watchBoundary, 
                    lastPrice 
                });
                if (isAuthoritative) {
                    rangeContinuationStateMap.set(input.symbol, cState);
                }
                
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
                    metadata: { 
                        skipped_no_retest: true, 
                        watchBoundary, 
                        continuationDirection: cState.direction, 
                        continuationPhase: cState.phase, 
                        watchStartedCandleTs: cState.watchStartedCandleTs 
                    }
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
                    runCycleId: currentRunCycleId,
                    evaluationMode: input.evaluationMode,
                    lastPrice,
                    boxHigh: sn.boxHigh ?? 0,
                    boxLow: sn.boxLow ?? 0,
                    boxPos: currentBoxPos,
                    trendPhase: judgment.trendPhase,
                    emaGap,
                    blSlope,
                    rcSlope,
                    bhSlopeSource,
                    blSlopeSource,
                    rcSlopeSource,
                    reversalConfirmed,
                    recentLowBreakdown: (lastPrice < (sn.boxLow ?? 0) || recentCandles.slice(-3).some(c => c.low < (sn.boxLow ?? 0))),
                    countingEligible: isDownDeadlockCountingCondition,
                    slopeAligned: isDownSlopeAligned,
                    consecutiveCycles: cState.consecutiveCycles,
                    continuationPhase: cState.phase,
                    hasCandleAdvancedDuringCount: cState.hasCandleAdvancedDuringCount,
                    lastCandleTimestamp: currentLastCandleTimestamp,
                    previousLastCandleTimestamp,
                    candleAdvancedThisCycle,
                    authoritativeCandleAdvancedThisCycle,
                    countStartedCandleTs: cState.countStartedCandleTs
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
                    runCycleId: currentRunCycleId,
                    evaluationMode: input.evaluationMode,
                    lastPrice,
                    boxHigh: sn.boxHigh ?? 0,
                    boxLow: sn.boxLow ?? 0,
                    boxPos: currentBoxPos,
                    trendPhase: judgment.trendPhase,
                    emaGap,
                    bhSlope,
                    rcSlope,
                    bhSlopeSource,
                    blSlopeSource,
                    rcSlopeSource,
                    reversalConfirmed,
                    recentHighBreakout: (lastPrice > (sn.boxHigh ?? 0) || recentCandles.slice(-3).some(c => c.high > (sn.boxHigh ?? 0))),
                    countingEligible: isUpDeadlockCountingCondition,
                    slopeAligned: isUpSlopeAligned,
                    consecutiveCycles: cState.consecutiveCycles,
                    continuationPhase: cState.phase,
                    hasCandleAdvancedDuringCount: cState.hasCandleAdvancedDuringCount,
                    lastCandleTimestamp: currentLastCandleTimestamp,
                    previousLastCandleTimestamp,
                    candleAdvancedThisCycle,
                    authoritativeCandleAdvancedThisCycle,
                    countStartedCandleTs: cState.countStartedCandleTs
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
            if (reversalConfirmed) {
                signal = "SHORT_CANDIDATE";
                reason = "Upper edge reversal identified by price reaction";
            } else {
                signal = "WAIT_RECHECK";
                reason = localTouchDetected 
                    ? (localOvershot ? "Upper edge overshot; reversal invalidated" : "Upper edge touched; awaiting reaction")
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
            if (reversalConfirmed) {
                signal = "LONG_CANDIDATE";
                reason = "Lower edge reversal identified by price reaction";
            } else {
                signal = "WAIT_RECHECK";
                reason = localTouchDetected 
                    ? (localOvershot ? "Lower edge overshot; reversal invalidated" : "Lower edge touched; awaiting reaction")
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

    const feeRate = Number(input.config?.paperTakerFeeRate ?? 0.0005);
    const feeBreakEvenPct = computeSoftExitFeeBreakEvenPct({
        positionNotionalUsd: 1000,
        feeRate,
        slippageBufferPct: DEFAULT_SOFT_EXIT_SLIPPAGE_BUFFER_PCT
    });
    let tp1 = 0;
    let tp2 = 0;
    let inv = 0;

    if (side === "long") {
        inv = Math.min(boxLow - minStopDistance, entryPx - minStopDistance);
        const rawTp1Dist = Math.max(boxMid - entryPx, minProfitDistance);
        tp1 = entryPx + rawTp1Dist;
        tp2 = Math.max(boxHigh, tp1 + minProfitDistance);
        if (tp2 <= tp1) tp2 = tp1 + minProfitDistance;
    } else if (side === "short") {
        inv = Math.max(boxHigh + minStopDistance, entryPx + minStopDistance);
        const rawTp1Dist = Math.max(entryPx - boxMid, minProfitDistance);
        tp1 = entryPx - rawTp1Dist;
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
        boxCohesion01,
        trendWeaknessScore,
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
