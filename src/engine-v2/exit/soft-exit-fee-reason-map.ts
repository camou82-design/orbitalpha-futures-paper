import type { V2ExitReason } from "./types";

/** Paper close reasons that may enter the soft-exit fee gate via explicit live mapping. */
export type PaperSoftExitFeeGateCloseReason = "candidate_lost" | "regime_exit";

/** Authoritative paper close sources wired to soft-exit fee gate reasons. */
export type PaperSoftExitFeeGateCloseSource =
    | "candidate_lost_watchdog"
    | "range_reversal_logic"
    | "range_misaligned_safety_net";

export function mapPaperCloseToSoftExitFeeGateReason(input: Readonly<{
    closeReason: string;
    closeSource: string;
}>): V2ExitReason | null {
    if (input.closeReason === "candidate_lost" && input.closeSource === "candidate_lost_watchdog") {
        return "CANDIDATE_LOST_SOFT_EXIT";
    }
    if (
        input.closeReason === "regime_exit" &&
        (input.closeSource === "range_reversal_logic" || input.closeSource === "range_misaligned_safety_net")
    ) {
        return "WEAK_QUALITY_REGIME_SOFT_EXIT";
    }
    return null;
}

/** Preserve authoritative V2 exit-policy reasons; never reclassify hard/profit-protection exits. */
export function mapV2ExitPolicyToSoftExitFeeGateReason(policyReason: V2ExitReason): V2ExitReason {
    return policyReason;
}

export function isPaperSoftExitFeeGateWiredClose(input: Readonly<{
    closeReason: string;
    closeSource: string;
}>): boolean {
    return mapPaperCloseToSoftExitFeeGateReason(input) != null;
}
