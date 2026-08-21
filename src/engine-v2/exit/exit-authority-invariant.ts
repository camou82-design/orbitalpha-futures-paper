import type { V2ExitAuthorityResult } from "../types";

/** Exit policy reasons that must never authorize terminal close execution. */
export const NON_TERMINAL_EXIT_REASONS = new Set<string>([
    "TREND_HOLD_VALID",
    "RANGE_HOLD_VALID",
    "TREND_CONTINUATION_HOLD",
    "RANGE_CONTINUATION_HOLD",
    "OPPOSITE_HYSTERESIS_HOLD",
    "PROFIT_PROTECT_HOLD",
    "WATCH",
    "HOLD"
]);

export function isNonTerminalExitReason(reason: string | null | undefined): boolean {
    if (!reason) return false;
    const r = String(reason).trim();
    if (!r) return false;
    if (NON_TERMINAL_EXIT_REASONS.has(r)) return true;
    return r.endsWith("_HOLD") || r.endsWith("_HOLD_VALID") || r.includes("_WATCH");
}

export function isExplicitTerminalExitReason(reason: string | null | undefined): boolean {
    if (!reason || !String(reason).trim()) return false;
    if (isNonTerminalExitReason(reason)) return false;
    return true;
}

/**
 * Enforces: HOLD/WATCH reasons cannot produce shouldExit=true or exitAction=exit.
 * Terminal exit requires an explicit non-HOLD reason.
 */
export function applyV2ExitAuthorityInvariants(
    authority: V2ExitAuthorityResult | null | undefined,
    context?: Readonly<{ lifecycleExitReason?: string | null; lifecycleExitAction?: string | null }>
): V2ExitAuthorityResult | null {
    if (!authority) return null;

    const mergedReason =
        context?.lifecycleExitReason && isExplicitTerminalExitReason(context.lifecycleExitReason)
            ? context.lifecycleExitReason
            : authority.exitReason;

    if (isNonTerminalExitReason(mergedReason)) {
        return {
            ...authority,
            exitAction: "none",
            shouldExit: false,
            exitReason: mergedReason,
            trueInconsistencyReasons: [
                ...(authority.trueInconsistencyReasons ?? []),
                "NON_TERMINAL_EXIT_REASON_COLLISION_SUPPRESSED"
            ],
            proofReasons: [
                ...(authority.proofReasons ?? []),
                `exit_invariant:non_terminal_reason:${mergedReason}`
            ]
        };
    }

    if (authority.exitAction === "exit" || authority.shouldExit === true) {
        if (!isExplicitTerminalExitReason(mergedReason)) {
            return {
                ...authority,
                exitAction: "none",
                shouldExit: false,
                exitReason: mergedReason,
                trueInconsistencyReasons: [
                    ...(authority.trueInconsistencyReasons ?? []),
                    "TERMINAL_EXIT_WITHOUT_EXPLICIT_REASON_FAIL_CLOSED"
                ],
                proofReasons: [
                    ...(authority.proofReasons ?? []),
                    "exit_invariant:missing_explicit_terminal_reason"
                ]
            };
        }
        return {
            ...authority,
            exitReason: mergedReason,
            shouldExit: true,
            exitAction: "exit"
        };
    }

    return { ...authority, exitReason: mergedReason };
}

export function buildExitAuthorityInvariantProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_EXIT_AUTHORITY_INVARIANT_PROOF", ...input };
}
