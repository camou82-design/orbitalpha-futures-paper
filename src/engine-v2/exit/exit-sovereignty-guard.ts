export type PaperExitCandidateAction = "hold" | "close" | "partial_close";

export function evaluateV2ExitSovereigntyGuard(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    isV2AuthorityPosition: boolean;
    v2ExitAuthorityAvailable: boolean;
    v2ShouldExit: boolean;
    v2ExitAction: string | null;
    paperCandidateAction: PaperExitCandidateAction;
    paperCandidateReason: string | null;
    actualStopBreached: boolean;
    isLiquidationEmergency?: boolean;
    v2AuthorityUnavailable?: boolean;
}>): Readonly<{
    overrideAllowed: boolean;
    overrideBlockReason: string | null;
    effectiveAction: PaperExitCandidateAction;
}> {
    const candidate = input.paperCandidateAction;
    const wantsClose =
        candidate === "close" || candidate === "partial_close";

    if (!input.isV2AuthorityPosition || !input.v2ExitAuthorityAvailable) {
        return {
            overrideAllowed: wantsClose,
            overrideBlockReason: null,
            effectiveAction: candidate
        };
    }

    if (!wantsClose || input.v2ShouldExit) {
        return {
            overrideAllowed: wantsClose,
            overrideBlockReason: null,
            effectiveAction: candidate
        };
    }

    if (input.isLiquidationEmergency === true) {
        return {
            overrideAllowed: true,
            overrideBlockReason: null,
            effectiveAction: candidate
        };
    }

    if (input.actualStopBreached && candidate === "close") {
        const stopReason = input.paperCandidateReason ?? "stop_loss";
        const isStopCandidate =
            stopReason === "stop_loss" || String(stopReason).includes("stop_loss");
        if (isStopCandidate) {
            return {
                overrideAllowed: true,
                overrideBlockReason: null,
                effectiveAction: candidate
            };
        }
    }

    if (input.v2AuthorityUnavailable === true) {
        return {
            overrideAllowed: true,
            overrideBlockReason: null,
            effectiveAction: candidate
        };
    }

    return {
        overrideAllowed: false,
        overrideBlockReason: "v2_exit_sovereignty_hold",
        effectiveAction: "hold"
    };
}

export function buildV2ExitSovereigntyGuardProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "V2_EXIT_SOVEREIGNTY_GUARD_PROOF", ...input };
}
