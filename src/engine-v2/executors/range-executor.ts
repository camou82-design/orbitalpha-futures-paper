import { EngineV2Input, EngineV2Side, ExecutorOutput, MarketJudgmentOutput } from "../types";
import { classifyRangeZone } from "../../models/types";

/**
 * Tier 4: Range Executor (Refined)
 * Hardened with Late Chase Guard and Zone-based Side Filtering.
 * Decoupled from paper-engine legacy logic.
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

    if (judgment.subtype === "EARLY_LONG_PROBE" || (judgment.subtype === "FAST_TREND_SHIFT" && judgment.diagnostics?.fastTrendShift?.direction === "long")) {
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
    const boxCohesion01 = typeof sn.boxCohesion01 === "number" && Number.isFinite(sn.boxCohesion01) ? sn.boxCohesion01 : 0;
    const breakoutFailureRate = typeof sn.breakoutFailureRate === "number" && Number.isFinite(sn.breakoutFailureRate) ? sn.breakoutFailureRate : 0;
    const rangeOscillationScore = typeof sn.rangeOscillationScore === "number" && Number.isFinite(sn.rangeOscillationScore) ? sn.rangeOscillationScore : 0;
    const trendWeaknessScore = typeof sn.trendWeaknessScore === "number" && Number.isFinite(sn.trendWeaknessScore) ? sn.trendWeaknessScore : 0;
    const currentStage = input.state.currentPositions.find(p => p.symbol === input.symbol)?.entryStage ?? 0;
    const isDistorted = (judgment.metadata as any)?.isDistorted === true;
    const isDrifting = (judgment.metadata as any)?.isDrifting === true;
    const distortionFactor = (judgment.metadata as any)?.distortionFactor ?? 0;
    const bhSlope = (judgment.metadata as any)?.bhSlope ?? 0;
    const blSlope = (judgment.metadata as any)?.blSlope ?? 0;

    let signal: any = "NONE";
    let side: EngineV2Side = "none";
    let reason = "Initial state";
    let recheckSuggested = false;
    let reversalConfirmed = false;
    let sideOverrideApplied = false;
    let lateChaseBlocked = false;
    let retestRequired = false;
    let retestPassed = false;
    let firstBreakoutChaseBlocked = false;
    const qualityScore = sn.qualityScore ?? 0;

    // --- BOX QUALITY GUARD (Refined) ---
    // Distorted box blocks only mean-reversion entries.
    // Drifting box allows continuation but blocks counter-drift entries.
    const isMeanReversionBlockedByDistortion = isDistorted && currentStage === 0;

    // [HARDENED] Drifting box side bias for continuation
    const isDriftDown = judgment.subtype === "RANGE_DRIFT_DOWN" || judgment.subtype === "DESCENDING_CHANNEL";
    const isDriftUp = judgment.subtype === "RANGE_DRIFT_UP" || judgment.subtype === "ASCENDING_CHANNEL";
    
    // Note: Early return for distorted box is removed to allow side-filtering and continuation.

    // Standard Zone Classification: global classifyRangeZone (upper>=0.62, lower<=0.38, else mid)
    const currentBoxPos = boxPos ?? 0.5;
    const boxZone = classifyRangeZone(currentBoxPos);
    const isUpper = boxZone === "upper";
    const isLower = boxZone === "lower";
    const isMid = boxZone === "mid";

    // --- SHOCK & TREND GUARD ---
    const emaGap = sn.emaGap ?? 0;
    if (isLower && currentStage === 0) {
        const isBearishRegime = judgment.shockPhase === "DOWN_SHOCK" || judgment.trendPhase === "DOWN" || emaGap < 0;
        // reversalConfirmed check is simplified here as we don't have candle history in this scope easily, 
        // but let's assume it from judgment or metadata if available.
        if (isBearishRegime) {
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
                reason: "V2_RANGE_LOWER_LONG_BLOCKED_BY_BEARISH_SHOCK",
                baseSizeIntent: 0,
                recheckSuggested: true,
                isAddOnEligible: false,
                stopPrice: null,
                invalidationPx: null,
                metadata: { shockPhase: judgment.shockPhase, trendPhase: judgment.trendPhase }
            };
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
        // Upper Zone: Only SHORT allowed
        side = "short";
        if (!input.state.shortAllow) {
            signal = "NONE";
            reason = "Upper edge reached but short blocked by bias";
        } else {
            // Reversal check (Hardened Price Action Confirmation)
            const candles = sn.candles ?? [];
            const lastCandles = candles.slice(-5);
            const entryPx = sn.boxHigh ?? 0;
            const lastPx = sn.lastPrice ?? 0;
            const atr = sn.atr ?? 0;

            let touchDetected = false;
            let overshot = false;

            for (const c of lastCandles) {
                if (c.high >= entryPx) touchDetected = true;
                if (c.high > entryPx + (atr * 0.15)) overshot = true;
            }

            // Reaction check: current price must be below the touch high
            const reactionDetected = touchDetected && lastPx < entryPx * 0.9997;
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
        // Lower Zone: Only LONG allowed
        side = "long";
        if (!input.state.longAllow) {
            signal = "NONE";
            reason = "Lower edge reached but long blocked by bias";
        } else {
            // Reversal check (Hardened Price Action Confirmation)
            const candles = sn.candles ?? [];
            const lastCandles = candles.slice(-5);
            const entryPx = sn.boxLow ?? 0;
            const lastPx = sn.lastPrice ?? 0;
            const atr = sn.atr ?? 0;

            let touchDetected = false;
            let overshot = false;

            for (const c of lastCandles) {
                if (c.low <= entryPx) touchDetected = true;
                if (c.low < entryPx - (atr * 0.15)) overshot = true;
            }

            const reactionDetected = touchDetected && lastPx > entryPx * 1.0003;
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

    // Phase 6: Drift & Channel Entry Filtering (Symmetrical & Hardened)
    const isDownStructure = judgment.subtype === "RANGE_DRIFT_DOWN" || judgment.subtype === "DESCENDING_CHANNEL";
    const isUpStructure = judgment.subtype === "RANGE_DRIFT_UP" || judgment.subtype === "ASCENDING_CHANNEL";

    if (isDownStructure || isUpStructure) {
        const direction = isDownStructure ? "down" : "up";
        const primarySide: EngineV2Side = isDownStructure ? "short" : "long";
        const blockedSide: EngineV2Side = isDownStructure ? "long" : "short";
        const badChaseZone = isDownStructure ? "lower" : "upper";
        const validEntryZone = isDownStructure ? "upper" : "lower";
        const symmetryCase = isDownStructure ? "DRIFT_DOWN_SYMMETRY" : "DRIFT_UP_SYMMETRY";

        console.info(JSON.stringify({
            event: "V2_RANGE_DRIFT_SIDE_BIAS_PROOF",
            symbol: input.symbol,
            direction,
            primarySide,
            blockedSide,
            zone: isUpper ? "upper" : (isLower ? "lower" : "mid"),
            biasReason: `Dominant ${direction} structure (${judgment.subtype})`,
            symmetryCase
        }));

        if (side === blockedSide) {
            signal = "NONE";
            reason = `SUPPRESSED: ${side} blocked in ${judgment.subtype} (${direction} bias)`;
        } else if (side === primarySide) {
            if (isMid) {
                signal = "NONE";
                reason = `SUPPRESSED: Mid entry blocked in ${judgment.subtype} (central neutrality enforced)`;
            } else if ((isDownStructure && isLower) || (isUpStructure && isUpper)) {
                // Bad Chase Zone
                signal = "NONE";
                reason = `SUPPRESSED: ${badChaseZone} chase blocked in ${judgment.subtype} (only ${validEntryZone} entries allowed)`;
            }
        }

        console.info(JSON.stringify({
            event: "V2_RANGE_DRIFT_ENTRY_FILTER_PROOF",
            symbol: input.symbol,
            direction,
            intendedSide: side,
            allowed: signal !== "NONE",
            blockReason: signal === "NONE" ? reason : null,
            validEntryZone,
            badChaseZone,
            symmetryCase
        }));
    }

    // Phase 6.5: Volume-Based Breakout / Shock Entry Filtering (Symmetrical)
    const isVolDown = judgment.subtype === "VOLUME_BREAKDOWN_OBSERVATION" || judgment.subtype === "VOLUME_SHOCK_DOWN" || judgment.subtype === "BREAKDOWN_RETEST_FAILED" || judgment.subtype === "FAKE_VOLUME_BREAKDOWN";
    const isVolUp = judgment.subtype === "VOLUME_BREAKOUT_OBSERVATION" || judgment.subtype === "VOLUME_SHOCK_UP" || judgment.subtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME" || judgment.subtype === "FAKE_VOLUME_BREAKOUT";

    if (isVolDown || isVolUp) {
        const direction = isVolDown ? "down" : "up";
        const primarySide: EngineV2Side = isVolDown ? "short" : "long";
        const blockedSide: EngineV2Side = isVolDown ? "long" : "short";
        const symmetryCase = isVolDown ? "VOLUME_BREAKDOWN_SYMMETRY" : "VOLUME_BREAKOUT_SYMMETRY";

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
                // First breakout candle chase blocked
                signal = "NONE";
                reason = `SUPPRESSED: First ${direction} breakout candle chase blocked; awaiting retest`;
                firstBreakoutChaseBlocked = true;
            } else if (isRetestSuccess) {
                // FORCE SIDE OVERRIDE: Retest success must use the breakout direction side
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

        console.info(JSON.stringify({
            event: "V2_VOLUME_SHOCK_ENTRY_FILTER_PROOF",
            symbol: input.symbol,
            direction,
            intendedSide: preVolumeSide,
            preVolumeSide,
            finalVolumeSide: side,
            finalSignal: signal,
            allowed: signal !== "NONE",
            blockReason: signal === "NONE" ? reason : null,
            firstBreakoutChaseBlocked,
            retestRequired,
            retestPassed,
            sideOverrideApplied,
            symmetryCase
        }));
    }

    // Phase 7: Volume Shock Entry Filtering (Symmetrical)
    if (judgment.shockPhase === "DOWN_SHOCK" || judgment.shockPhase === "UP_SHOCK") {
        const shockDirection = judgment.shockPhase === "DOWN_SHOCK" ? "down" : "up";
        const primarySide: EngineV2Side = judgment.shockPhase === "DOWN_SHOCK" ? "short" : "long";
        const blockedSide: EngineV2Side = judgment.shockPhase === "DOWN_SHOCK" ? "long" : "short";
        const symmetryCase = judgment.shockPhase === "DOWN_SHOCK" ? "SHOCK_DOWN_SYMMETRY" : "SHOCK_UP_SYMMETRY";

        console.info(JSON.stringify({
            event: "V2_RANGE_SHOCK_BIAS_PROOF",
            symbol: input.symbol,
            shockDirection,
            primarySide,
            blockedSide,
            symmetryCase
        }));

        if (side === blockedSide) {
            signal = "NONE";
            reason = `SUPPRESSED: ${side} blocked in ${judgment.shockPhase} (directional shock bias)`;
        } else if (side === primarySide) {
             // Block chase in shock as well
             if ((judgment.shockPhase === "DOWN_SHOCK" && isLower) || (judgment.shockPhase === "UP_SHOCK" && isUpper)) {
                signal = "NONE";
                reason = `SUPPRESSED: ${side} chase blocked during ${judgment.shockPhase}`;
             }
        }

        console.info(JSON.stringify({
            event: "V2_RANGE_SHOCK_ENTRY_FILTER_PROOF",
            symbol: input.symbol,
            shockDirection,
            intendedSide: side,
            allowed: signal !== "NONE",
            blockReason: signal === "NONE" ? reason : null,
            symmetryCase
        }));
    }

    // --- EXIT PLAN GENERATION (Mandatory for RANGE) ---
    const boxHigh = Number(sn.boxHigh ?? 0);
    const boxLow = Number(sn.boxLow ?? 0);
    const boxMid = (boxHigh + boxLow) / 2;
    const atr = Number(sn.atr ?? 0);
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

    // --- INVALID TP PLAN GUARD (Hardened) ---
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
        console.warn(JSON.stringify({
            event: "V2_RANGE_ENTRY_BLOCKED_INVALID_TP_PLAN_PROOF",
            symbol: input.symbol,
            side,
            entryPx,
            tp1,
            tp2,
            stopPx: inv,
            invalidationPx: inv,
            boxHigh,
            boxLow,
            boxMid,
            boxPos: currentBoxPos,
            atr,
            minProfitDistance,
            minStopDistance,
            boxHeightPct,
            reason: invalidTpReason
        }));
        signal = "NONE";
        reason = `V2_RANGE_ENTRY_BLOCKED: Invalid TP plan (${invalidTpReason})`;
    }

    // Block mean-reversion if distortion is active, but allow if it's a continuation
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

    if (takeProfitPlan && (signal === "LONG_CANDIDATE" || signal === "SHORT_CANDIDATE")) {
        console.info(JSON.stringify({
            event: "V2_RANGE_TAKE_PROFIT_PLAN_PROOF",
            symbol: input.symbol,
            side,
            tp1,
            tp2,
            invalidationPx: inv,
            boxMid,
            boxHigh,
            boxLow
        }));
    }

    // 2. Late Chase Guard Proof (Phase 4.5)
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

    if (lateChaseBlocked) {
        console.info(JSON.stringify({
            event: "V2_RANGE_LATE_CHASE_GUARD_PROOF",
            symbol: input.symbol,
            side,
            boxPos: currentBoxPos,
            threshold: side === "long" ? 0.88 : 0.12,
            action: "BLOCK",
            symmetryCase: side === "long" ? "UPPER_LONG_CHASE" : "LOWER_SHORT_CHASE"
        }));
    }

    // 3. Entry Side Filter Proof
    console.info(JSON.stringify({
        event: "V2_RANGE_ENTRY_SIDE_FILTER_PROOF",
        symbol: input.symbol,
        intendedSide: side,
        boxPos: currentBoxPos,
        isUpper,
        isLower,
        isMid,
        signal,
        reason
    }));

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

    return {
        signal,
        side,
        reason,
        baseSizeIntent: signal === "NONE" ? 0 : 1,
        recheckSuggested,
        isAddOnEligible: true,
        stopPrice: inv || null,
        invalidationPx: inv || null,
        metadata
    };
}
