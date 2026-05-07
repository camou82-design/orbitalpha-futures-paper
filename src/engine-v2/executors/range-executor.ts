import { EngineV2Input, EngineV2Side, ExecutorOutput, MarketJudgmentOutput } from "../types";

/**
 * Tier 4: Range Executor (Refined)
 * Hardened with Late Chase Guard and Zone-based Side Filtering.
 * Decoupled from paper-engine legacy logic.
 */
export function executeRangeRegime(input: EngineV2Input, judgment: MarketJudgmentOutput): ExecutorOutput {
    const { snapshot: sn } = input;
    const boxPos = typeof sn.boxPos === "number" && Number.isFinite(sn.boxPos) ? sn.boxPos : null;
    const rangeConfidence = typeof sn.rangeConfidence === "number" && Number.isFinite(sn.rangeConfidence) ? sn.rangeConfidence : 0;
    const boxCohesion01 = typeof sn.boxCohesion01 === "number" && Number.isFinite(sn.boxCohesion01) ? sn.boxCohesion01 : 0;
    const breakoutFailureRate = typeof sn.breakoutFailureRate === "number" && Number.isFinite(sn.breakoutFailureRate) ? sn.breakoutFailureRate : 0;
    const rangeOscillationScore = typeof sn.rangeOscillationScore === "number" && Number.isFinite(sn.rangeOscillationScore) ? sn.rangeOscillationScore : 0;
    const trendWeaknessScore = typeof sn.trendWeaknessScore === "number" && Number.isFinite(sn.trendWeaknessScore) ? sn.trendWeaknessScore : 0;
    const qualityScore = typeof sn.qualityScore === "number" && Number.isFinite(sn.qualityScore) ? sn.qualityScore : 0;

    let signal: ExecutorOutput["signal"] = "NONE";
    let side: ExecutorOutput["side"] = "none";
    let reason = "Watching mid-zone";
    let recheckSuggested = false;
    let reversalConfirmed = false;
    let lateChaseBlocked = false;
    let sideZoneVetoed = false;

    // Standard Zone Classification (Hardened)
    // Upper (>= 0.82), Lower (<= 0.18), Mid (0.18 < x < 0.82)
    const currentBoxPos = boxPos ?? 0.5;
    const isUpper = currentBoxPos >= 0.82;
    const isLower = currentBoxPos <= 0.18;
    const isMid = !isUpper && !isLower;

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
            // Late Chase Guard for SHORT (Extreme Breakdown)
            if (currentBoxPos < 0.12) { // Should not happen in Upper zone, but for safety in generic logic
                 // If we are evaluating for SHORT but price is already at the very bottom, it's a chase.
            }
            
            // Reversal check
            const reversalQualified = (rangeConfidence > 0.78 || (boxCohesion01 > 0.85 && breakoutFailureRate > 0.6));
            if (reversalQualified) {
                signal = "SHORT_CANDIDATE";
                reason = "Upper edge reversal identified";
                reversalConfirmed = true;
            } else {
                signal = "WAIT_RECHECK";
                reason = "Upper edge reached; awaiting reversal signal";
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
            // Reversal check
            const reversalQualified = (rangeConfidence > 0.78 || (boxCohesion01 > 0.85 && breakoutFailureRate > 0.6));
            if (reversalQualified) {
                signal = "LONG_CANDIDATE";
                reason = "Lower edge reversal identified";
                reversalConfirmed = true;
            } else {
                signal = "WAIT_RECHECK";
                reason = "Lower edge reached; awaiting reversal signal";
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
        let sideOverrideApplied = false;
        let firstBreakoutChaseBlocked = false;
        let retestRequired = isObservation || isShock;
        let retestPassed = isRetestSuccess;

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

        if (isFake) {
            console.info(JSON.stringify({
                event: "V2_FAKE_VOLUME_BREAKOUT_GUARD_PROOF",
                symbol: input.symbol,
                direction,
                boxBreakSide: sn.boxBreakSide,
                breakoutFailureRate,
                returnedInsideBox: true,
                action: "BLOCK_ENTRY"
            }));
        }
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

    if (judgment.subtype === "RANGE_FAKE_BREAKOUT") {
        signal = "NONE";
        reason = "FAKE_BREAKOUT_GUARD: Suppressing entry due to high failure rate observation";
        console.info(JSON.stringify({
            event: "V2_FAKE_BREAKOUT_GUARD_PROOF",
            symbol: input.symbol,
            boxBreakSide: sn.boxBreakSide,
            breakoutFailureRate,
            action: "BLOCK_ENTRY",
            symmetryCase: sn.boxBreakSide === "upper" ? "FAKE_BREAKOUT_UP" : "FAKE_BREAKOUT_DOWN"
        }));
    }

    // Phase 5: Range Compression & Squeeze Suppression
    if (judgment.subtype === "RANGE_COMPRESSION" || judgment.subtype === "TRIANGLE_SQUEEZE_CANDIDATE") {
        signal = "NONE";
        reason = `SUPPRESSED: Market in ${judgment.subtype} (low quality consolidation)`;
        console.info(JSON.stringify({
            event: "V2_RANGE_COMPRESSION_SUPPRESSION_PROOF",
            symbol: input.symbol,
            subtype: judgment.subtype,
            action: "SUPPRESS_ENTRY"
        }));
    } else if (judgment.subtype === "BREAKOUT_OBSERVATION") {
        signal = "NONE";
        reason = "SUPPRESSED: Initial breakout observation period; awaiting retest confirmation";
        console.info(JSON.stringify({
            event: "V2_BREAKOUT_OBSERVATION_SUPPRESSION_PROOF",
            symbol: input.symbol,
            subtype: judgment.subtype,
            action: "SUPPRESS_ENTRY"
        }));
    }

    // 2. Late Chase Guard Proof (Phase 4.5)
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

    const metadata: Record<string, string | number | boolean | null> = {
        boxPos: currentBoxPos,
        rangeConfidence,
        breakoutFailureRate,
        rangeOscillationScore,
        isUpper,
        isLower,
        isMid,
        reversal_confirmed: reversalConfirmed,
        late_chase_blocked: lateChaseBlocked,
        qualityScore
    };

    return {
        signal,
        side,
        reason,
        baseSizeIntent: signal === "NONE" ? 0 : 1,
        recheckSuggested,
        isAddOnEligible: true,
        metadata
    };
}
