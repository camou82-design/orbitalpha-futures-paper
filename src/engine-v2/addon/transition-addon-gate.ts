import { isThesisValidForAdverseAddon } from "./adverse-addon";
import type { EvaluateV2AddOnPolicyArgs } from "./types";

export function shouldBlockTransitionAddon(args: Readonly<{
    regimeFinal: string;
    transitionPhase: string;
    trendPhase: string;
    side: "long" | "short";
    judgment: EvaluateV2AddOnPolicyArgs["judgment"];
    execution: EvaluateV2AddOnPolicyArgs["execution"];
}>): Readonly<{ blocked: boolean; evidence: string }> {
    if (args.regimeFinal === "TRANSITION") {
        return { blocked: true, evidence: "regime_transition" };
    }
    if (args.transitionPhase === "NONE") {
        return { blocked: false, evidence: "no_transition" };
    }
    if (args.transitionPhase === "TREND_TO_RANGE") {
        if (args.trendPhase === "EXHAUSTION") {
            return { blocked: true, evidence: "trend_to_range_exhaustion" };
        }
        if (!isThesisValidForAdverseAddon(args.side, args.judgment, args.execution)) {
            return { blocked: true, evidence: "trend_to_range_thesis_invalid" };
        }
        const pullbackOrAligned =
            args.trendPhase === "PULLBACK" ||
            (args.side === "long" && args.trendPhase === "UP") ||
            (args.side === "short" && args.trendPhase === "DOWN");
        if (pullbackOrAligned) {
            return { blocked: false, evidence: "trend_to_range_pullback_pass" };
        }
        return { blocked: true, evidence: "trend_to_range_not_pullback" };
    }
    return { blocked: true, evidence: `transition_phase_${args.transitionPhase}` };
}
