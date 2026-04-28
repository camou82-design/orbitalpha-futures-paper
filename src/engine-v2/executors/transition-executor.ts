import { EngineV2Input, ExecutorOutput, MarketJudgmentOutput, TransitionExecutorMetadata, TransitionSetupType } from "../types";

/**
 * Tier 4: Transition Executor (Refined)
 * Passive scouting and exploration only.
 */
export function executeTransitionRegime(input: EngineV2Input, judgment?: MarketJudgmentOutput): ExecutorOutput {
    const sn = input.snapshot;
    const st = input.state;
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
    const isMidZone = boxPos > 0.26 && boxPos < 0.74;
    const breakoutConfirm = qualityScore >= 65 || reviewingTicks >= 1;
    const transitionPhase = judgment?.transitionPhase ?? "NONE";
    const subtype = judgment?.subtype ?? "TRANSITION_CONFLICT";

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
            signal = "WAIT_RECHECK";
            reason = "TRANSITION_SHOCK_DOWN_MID_CHASE_FORBIDDEN";
            transitionRejectReason = "MID_CHASE_FORBIDDEN";
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
            signal = "WAIT_RECHECK";
            reason = "TRANSITION_SHOCK_UP_MID_CHASE_FORBIDDEN";
            transitionRejectReason = "MID_CHASE_FORBIDDEN";
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

    const transitionConfidence = Math.max(0, Math.min(1, (qualityScore / 100) * (breakoutConfirm ? 1 : 0.7)));
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
        pumpState
    };
    return {
        signal,
        side,
        reason,
        baseSizeIntent: Math.max(0, Math.min(0.4, baseSizeIntent)),
        recheckSuggested,
        isAddOnEligible: false,
        metadata
    };
}
