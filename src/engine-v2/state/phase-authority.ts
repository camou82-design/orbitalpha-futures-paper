import type { MarketJudgmentOutput } from "../types";
import type { TrendRangeScoreAuthority } from "../market-judgment/trend-range-score-authority";

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
    | "EXHAUSTION"
    | "NONE";

export type ShockOverlayAuthority = "NONE" | "DOWN_SHOCK" | "UP_SHOCK" | "CRASH_RECOVERY" | "PUMP_RECOVERY";

export type PhaseAuthorityResult = Readonly<{
    phase: MarketPhaseAuthority;
    phaseReason: string;
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

    const structural_box_state = structuralBoxState({
        upperHold: upper_breakout_hold,
        lowerHold: lower_breakdown_hold,
        boxMidReclaimed: false,
        boxMidLost: false
    });

    if (args.whipsawActive || args.whipsawSoftWatch || args.subtype === "WHIPSAW_SHOCK_RECHECK" || args.subtype === "WHIPSAW_SOFT_WATCH") {
        return {
            phase: "WHIPSAW",
            phaseReason: args.whipsawActive ? "WHIPSAW_HARD_RECHECK" : "WHIPSAW_SOFT_WATCH",
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

    const tp = String(args.trendPhase ?? "NONE").toUpperCase();
    const rp = String(args.rangePhase ?? "NONE").toUpperCase();
    const tr = String(args.transitionPhase ?? "NONE").toUpperCase();

    if (args.shockPhase === "DOWN_SHOCK" || args.shockPhase === "UP_SHOCK") {
        const deepPullback = tp === "PULLBACK" || lower_breakdown_hold;
        return {
            phase: deepPullback ? "DEEP_PULLBACK" : "SHOCK",
            phaseReason: deepPullback ? "SHOCK_WITH_PULLBACK_DEPTH" : "DIRECTIONAL_SHOCK_PHASE",
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

    if (tr === "RETEST_CONFIRMED" || rp.includes("RETEST")) {
        return {
            phase: "RETEST",
            phaseReason: "TRANSITION_OR_RANGE_RETEST",
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

    if (rp.includes("FAKE_BREAKOUT") || rp.includes("BREAKDOWN_RETEST_FAILED")) {
        return {
            phase: "FAILED_BREAKOUT",
            phaseReason: rp,
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

    if (rp.includes("BREAKOUT") || fts || args.subtype === "FAST_TREND_SHIFT") {
        return {
            phase: "BREAKOUT",
            phaseReason: fts ? "FAST_TREND_SHIFT" : rp,
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

    if (tp === "EXHAUSTION") {
        return {
            phase: "EXHAUSTION",
            phaseReason: "TREND_PHASE_EXHAUSTION",
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

    if (tp === "PULLBACK") {
        const deep = lower_breakdown_hold || rp.includes("BREAKDOWN");
        return {
            phase: deep ? "DEEP_PULLBACK" : "PULLBACK",
            phaseReason: deep ? "PULLBACK_WITH_BREAKDOWN_HOLD" : "TREND_PULLBACK",
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

    if (rp === "MID" || rp === "COMPRESSION" || rp === "FLAT" || tr === "CONFLICT") {
        return {
            phase: "CONSOLIDATION",
            phaseReason: rp !== "NONE" ? rp : tr,
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

    if (tp === "UP" || tp === "DOWN") {
        return {
            phase: "CONTINUATION",
            phaseReason: `TREND_${tp}`,
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

    return {
        phase: "NONE",
        phaseReason: "UNMAPPED_JUDGMENT_PHASE",
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
