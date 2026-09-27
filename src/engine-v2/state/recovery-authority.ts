import type { EngineV2Side } from "../types";
import { isHtfPolicyCompatibleWithCandidateSide } from "../market-judgment/whipsaw-aged-soft-downgrade";

export type RecoveryAuthorityResult = Readonly<{
    recovery_candidate: boolean;
    recovery_confirmed: boolean;
    recovery_direction: EngineV2Side;
    recovery_evidence: readonly string[];
}>;

function biasBullish(b: string | undefined): boolean {
    return String(b ?? "").toUpperCase() === "BULLISH";
}

function biasBearish(b: string | undefined): boolean {
    return String(b ?? "").toUpperCase() === "BEARISH";
}

function htfStackBullish(htf?: Readonly<{ m15?: string; h1?: string; h4?: string; d1?: string }>): boolean {
    if (!htf) return false;
    return biasBullish(htf.m15) && biasBullish(htf.h1) && biasBullish(htf.h4) && biasBullish(htf.d1);
}

function htfStackBearish(htf?: Readonly<{ m15?: string; h1?: string; h4?: string; d1?: string }>): boolean {
    if (!htf) return false;
    return biasBearish(htf.m15) && biasBearish(htf.h1) && biasBearish(htf.h4) && biasBearish(htf.d1);
}

export function evaluateStructuralRecoveryAuthority(args: Readonly<{
    whipsawActive: boolean;
    whipsawSoftWatch: boolean;
    whipsawReleaseEligible: boolean;
    higher_low: boolean;
    higher_high: boolean;
    lower_low: boolean;
    lower_high: boolean;
    upper_breakout_hold: boolean;
    lower_breakdown_hold: boolean;
    box_mid_reclaimed?: boolean;
    htfEntryPolicy: string;
    htfBias?: Readonly<{ m15?: string; h1?: string; h4?: string; d1?: string }>;
    reclaimConfirmed?: boolean;
    retestConfirmed?: boolean;
}>): RecoveryAuthorityResult {
    const evidence: string[] = [];

    if (args.whipsawActive) {
        return {
            recovery_candidate: false,
            recovery_confirmed: false,
            recovery_direction: "none",
            recovery_evidence: ["WHIPSAW_HARD_ACTIVE"]
        };
    }

    const htfLongOk =
        isHtfPolicyCompatibleWithCandidateSide(args.htfEntryPolicy, "long") || htfStackBullish(args.htfBias);
    const htfShortOk =
        isHtfPolicyCompatibleWithCandidateSide(args.htfEntryPolicy, "short") || htfStackBearish(args.htfBias);

    const bullishStructure = args.higher_low && args.higher_high && !args.lower_breakdown_hold;
    const bearishStructure = args.lower_low && args.lower_high && !args.upper_breakout_hold;

    let recovery_direction: EngineV2Side = "none";
    if (bullishStructure && htfLongOk) {
        recovery_direction = "long";
        if (args.higher_low) evidence.push("HIGHER_LOW");
        if (args.higher_high) evidence.push("HIGHER_HIGH");
        if (htfLongOk) evidence.push("HTF_LONG_ALIGNED");
    } else if (bearishStructure && htfShortOk) {
        recovery_direction = "short";
        if (args.lower_low) evidence.push("LOWER_LOW");
        if (args.lower_high) evidence.push("LOWER_HIGH");
        if (htfShortOk) evidence.push("HTF_SHORT_ALIGNED");
    }

    const recovery_candidate = recovery_direction === "long" || recovery_direction === "short";

    if (args.reclaimConfirmed) evidence.push("RECLAIM_CONFIRMED");
    if (args.retestConfirmed) evidence.push("RETEST_CONFIRMED");
    if (args.box_mid_reclaimed) evidence.push("BOX_MID_RECLAIMED");
    if (args.whipsawReleaseEligible) evidence.push("WHIPSAW_RELEASE_ELIGIBLE");

    const recovery_confirmed = recovery_candidate;

    return {
        recovery_candidate,
        recovery_confirmed,
        recovery_direction,
        recovery_evidence: evidence
    };
}
