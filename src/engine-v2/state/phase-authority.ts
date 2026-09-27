import type { MarketJudgmentOutput } from "../types";
import type { TrendRangeScoreAuthority } from "../market-judgment/trend-range-score-authority";
import type { RecoveryAuthorityResult } from "./recovery-authority";

export type MarketPhaseAuthority =
    | "CONTINUATION"
    | "PULLBACK"
    | "DEEP_PULLBACK"
    | "CONSOLIDATION"
    | "BREAKOUT"
    | "FAILED_BREAKOUT"
    | "WHIPSAW"
    | "SHOCK"
    | "RETEST"
    | "RECOVERY"
    | "RECLAIM"
    | "EXHAUSTION"
    | "NONE";

export type ShockOverlayAuthority = "NONE" | "DOWN_SHOCK" | "UP_SHOCK" | "CRASH_RECOVERY" | "PUMP_RECOVERY";

export type PhaseAuthorityResult = Readonly<{
    phase: MarketPhaseAuthority;
    phaseReason: string;
    phase_before: MarketPhaseAuthority;
    phase_after: MarketPhaseAuthority;
    shockOverlay: ShockOverlayAuthority;
    higher_low: boolean;
    higher_high: boolean;
    lower_high: boolean;
    lower_low: boolean;
    upper_breakout_hold: boolean;
    lower_breakdown_hold: boolean;
    structural_box_state: string;
}>;

export function resolveShockOverlay(args: Readonly<{
    shockPhase: MarketJudgmentOutput["shockPhase"];
    directionalShockState: string;
}>): ShockOverlayAuthority {
    if (args.shockPhase === "DOWN_SHOCK") return "DOWN_SHOCK";
    if (args.shockPhase === "UP_SHOCK") return "UP_SHOCK";
    if (args.shockPhase === "CRASH_RECOVERY") return "CRASH_RECOVERY";
    if (args.shockPhase === "PUMP_RECOVERY") return "PUMP_RECOVERY";
    const dir = String(args.directionalShockState ?? "NONE").toUpperCase();
    if (dir === "DOWN") return "DOWN_SHOCK";
    if (dir === "UP") return "UP_SHOCK";
    return "NONE";
}

function structuralBoxState(args: Readonly<{
    upperHold: boolean;
    lowerHold: boolean;
    boxMidReclaimed: boolean;
    boxMidLost: boolean;
}>): string {
    if (args.upperHold && !args.lowerHold) return "UPPER_BREAKOUT_HOLD";
    if (args.lowerHold && !args.upperHold) return "LOWER_BREAKDOWN_HOLD";
    if (args.boxMidReclaimed) return "BOX_MID_RECLAIMED";
    if (args.boxMidLost) return "BOX_MID_LOST";
    if (args.upperHold && args.lowerHold) return "BOUNDARY_CONFLICT";
    return "INSIDE_BOX";
}

export function resolvePhaseAuthority(args: Readonly<{
    subtype: MarketJudgmentOutput["subtype"];
    trendPhase: MarketJudgmentOutput["trendPhase"];
    rangePhase: MarketJudgmentOutput["rangePhase"];
    transitionPhase: MarketJudgmentOutput["transitionPhase"];
    shockPhase: MarketJudgmentOutput["shockPhase"];
    directionalShockState?: string;
    whipsawActive: boolean;
    whipsawSoftWatch: boolean;
    scoreAuthority: TrendRangeScoreAuthority | null | undefined;
    fastTrendShiftActive?: boolean;
    lower_high_detected?: boolean;
    lower_low_detected?: boolean;
    box_mid_reclaimed?: boolean;
    reclaimConfirmed?: boolean;
    retestConfirmed?: boolean;
    recoveryAuthority?: RecoveryAuthorityResult | null;
}>): PhaseAuthorityResult {
    const sa = args.scoreAuthority;
    const fts = args.fastTrendShiftActive === true;
    const higher_low = sa?.higher_low ?? false;
    const higher_high = sa?.higher_high ?? false;
    const lower_high = args.lower_high_detected === true;
    const lower_low = args.lower_low_detected === true;
    const upper_breakout_hold = sa?.upper_breakout_hold ?? false;
    const lower_breakdown_hold = sa?.lower_breakdown_hold ?? false;
    const shockOverlay = resolveShockOverlay({
        shockPhase: args.shockPhase,
        directionalShockState: args.directionalShockState ?? "NONE"
    });

    const box_mid_reclaimed = args.box_mid_reclaimed === true;
    const structural_box_state = structuralBoxState({
        upperHold: upper_breakout_hold,
        lowerHold: lower_breakdown_hold,
        boxMidReclaimed: box_mid_reclaimed,
        boxMidLost: false
    });

    const recovery = args.recoveryAuthority;
    const whipsawLabelled =
        args.whipsawActive ||
        args.whipsawSoftWatch ||
        args.subtype === "WHIPSAW_SHOCK_RECHECK" ||
        args.subtype === "WHIPSAW_SOFT_WATCH";

    const phase_before: MarketPhaseAuthority = whipsawLabelled ? "WHIPSAW" : "NONE";

    if (whipsawLabelled && recovery?.recovery_confirmed === true && !args.whipsawActive) {
        const reclaimPhase =
            args.retestConfirmed === true ||
            args.reclaimConfirmed === true ||
            box_mid_reclaimed ||
            String(args.transitionPhase ?? "").includes("RETEST");
        const releasedPhase: MarketPhaseAuthority = reclaimPhase ? "RECLAIM" : "RECOVERY";
        return {
            phase: releasedPhase,
            phaseReason: reclaimPhase ? "STRUCTURAL_RECOVERY_RECLAIM" : "STRUCTURAL_RECOVERY_FOLLOW_THROUGH",
            phase_before,
            phase_after: releasedPhase,
            shockOverlay,
            higher_low,
            higher_high,
            lower_high,
            lower_low,
            upper_breakout_hold,
            lower_breakdown_hold,
            structural_box_state
        };
    }

    if (whipsawLabelled) {
        const locked: MarketPhaseAuthority = "WHIPSAW";
        return {
            phase: locked,
            phaseReason: args.whipsawActive ? "WHIPSAW_HARD_RECHECK" : "WHIPSAW_SOFT_WATCH",
            phase_before: locked,
            phase_after: locked,
            shockOverlay,
            higher_low,
            higher_high,
            lower_high,
            lower_low,
            upper_breakout_hold,
            lower_breakdown_hold,
            structural_box_state
        };
    }

    const finish = (
        phase: MarketPhaseAuthority,
        reason: string,
        before: MarketPhaseAuthority = phase,
        after: MarketPhaseAuthority = phase
    ): PhaseAuthorityResult => ({
        phase,
        phaseReason: reason,
        phase_before: before,
        phase_after: after,
        shockOverlay,
        higher_low,
        higher_high,
        lower_high,
        lower_low,
        upper_breakout_hold,
        lower_breakdown_hold,
        structural_box_state
    });

    const tp = String(args.trendPhase ?? "NONE").toUpperCase();
    const rp = String(args.rangePhase ?? "NONE").toUpperCase();
    const tr = String(args.transitionPhase ?? "NONE").toUpperCase();

    if (args.shockPhase === "DOWN_SHOCK" || args.shockPhase === "UP_SHOCK") {
        const deepPullback = tp === "PULLBACK" || lower_breakdown_hold;
        return finish(deepPullback ? "DEEP_PULLBACK" : "SHOCK", deepPullback ? "SHOCK_WITH_PULLBACK_DEPTH" : "DIRECTIONAL_SHOCK_PHASE");
    }

    if (tr === "RETEST_CONFIRMED" || rp.includes("RETEST")) {
        return finish("RETEST", "TRANSITION_OR_RANGE_RETEST");
    }

    if (rp.includes("FAKE_BREAKOUT") || rp.includes("BREAKDOWN_RETEST_FAILED")) {
        return finish("FAILED_BREAKOUT", rp);
    }

    if (rp.includes("BREAKOUT") || fts || args.subtype === "FAST_TREND_SHIFT") {
        return finish("BREAKOUT", fts ? "FAST_TREND_SHIFT" : rp);
    }

    if (tp === "EXHAUSTION") {
        return finish("EXHAUSTION", "TREND_PHASE_EXHAUSTION");
    }

    if (tp === "PULLBACK") {
        const deep = lower_breakdown_hold || rp.includes("BREAKDOWN");
        return finish(deep ? "DEEP_PULLBACK" : "PULLBACK", deep ? "PULLBACK_WITH_BREAKDOWN_HOLD" : "TREND_PULLBACK");
    }

    if (rp === "MID" || rp === "COMPRESSION" || rp === "FLAT" || tr === "CONFLICT") {
        return finish("CONSOLIDATION", rp !== "NONE" ? rp : tr);
    }

    if (tp === "UP" || tp === "DOWN") {
        return finish("CONTINUATION", `TREND_${tp}`);
    }

    return finish("NONE", "UNMAPPED_JUDGMENT_PHASE");
}
