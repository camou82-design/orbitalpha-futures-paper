/** Paper soft-exit submit decision: fee economics + V2 exit sovereignty (no new execution authority). */
export function resolvePaperSoftExitSubmitDecision(input: Readonly<{
    feeGateProceed: boolean;
    isV2AuthorityPosition: boolean;
    v2ShouldExit: boolean;
}>): Readonly<{
    allowSubmit: boolean;
    blockReason: string | null;
}> {
    if (!input.feeGateProceed) {
        return { allowSubmit: false, blockReason: "soft_exit_fee_hold_recheck" };
    }
    if (input.isV2AuthorityPosition && !input.v2ShouldExit) {
        return { allowSubmit: false, blockReason: "v2_exit_sovereignty_hold" };
    }
    return { allowSubmit: true, blockReason: null };
}

/** Mirrors paper-engine per-cycle ordering: V2 early takeover prevents legacy paper submit. */
export function simulateExitCycleSubmitCount(input: Readonly<{
    v2ShouldExit: boolean;
    isV2AuthorityPosition: boolean;
    candidateLostEligible: boolean;
    feeGateProceed: boolean;
}>): number {
    if (input.v2ShouldExit) {
        return 1;
    }
    if (!input.candidateLostEligible) {
        return 0;
    }
    const decision = resolvePaperSoftExitSubmitDecision({
        feeGateProceed: input.feeGateProceed,
        isV2AuthorityPosition: input.isV2AuthorityPosition,
        v2ShouldExit: false
    });
    return decision.allowSubmit ? 1 : 0;
}
