import type { EngineV2Side } from "./types";
import type { CanonicalRegimeDirection } from "./state/regime-authority";
import { isHtfPolicyCompatibleWithCandidateSide } from "./market-judgment/whipsaw-aged-soft-downgrade";
import type { RecoveryAuthorityResult } from "./state/recovery-authority";

/**
 * Single source of truth for authoritative trendSideCandidate.
 * Used by engine-v2/index.ts and market judgment predicates.
 *
 * Principles:
 * 1. Directional shock is NOT an independent side creator overriding EMA / structural trend.
 * 2. Directional shock serves as confirmation / risk context, not direction creator.
 * 3. Shock aligning with base direction reinforces it; shock opposing base direction
 *    cannot create an opposite-side candidate without canonical structural FTS confirmation.
 */
export function deriveTrendSideCandidate(
    directionalShockState: string | null | undefined,
    emaGap: number
): "long" | "short" | "none" {
    if (emaGap < 0) return "short";
    if (emaGap > 0) return "long";
    return "none";
}

export type TrendCandidateDirectionSource =
    | "REGIME_DIRECTION_TREND_UP"
    | "REGIME_DIRECTION_TREND_DOWN"
    | "RECOVERY_DIRECTION_LONG"
    | "RECOVERY_DIRECTION_SHORT"
    | "EMA_GAP_FALLBACK";

const recoveryDirectionLatchBySymbol = new Map<string, "long" | "short">();

export function resetRecoveryDirectionLatchForTests(): void {
    recoveryDirectionLatchBySymbol.clear();
}

export function resolveTrendExecutionCandidateDirection(args: Readonly<{
    symbol?: string;
    directionalShockState: string | null | undefined;
    emaGap: number;
    canonicalRegime: CanonicalRegimeDirection | null | undefined;
    recoveryAuthority?: RecoveryAuthorityResult | null;
    htfEntryPolicy?: string | null;
}>): Readonly<{
    candidateSide: "long" | "short" | "none";
    candidateSideBeforeRegimeAuthority: "long" | "short" | "none";
    candidateSideAfterRegimeAuthority: "long" | "short" | "none";
    trendCandidateDirectionSource: TrendCandidateDirectionSource;
    candidateDirectionSourceBefore: TrendCandidateDirectionSource;
    candidateDirectionSourceAfter: TrendCandidateDirectionSource;
}> {
    const emaFallback = deriveTrendSideCandidate(args.directionalShockState, args.emaGap);
    const sourceBefore: TrendCandidateDirectionSource = "EMA_GAP_FALLBACK";

    const recovery = args.recoveryAuthority;
    if (
        recovery?.recovery_confirmed === true &&
        (recovery.recovery_direction === "long" || recovery.recovery_direction === "short") &&
        isHtfPolicyCompatibleWithCandidateSide(args.htfEntryPolicy, recovery.recovery_direction)
    ) {
        if (args.symbol) {
            recoveryDirectionLatchBySymbol.set(args.symbol, recovery.recovery_direction);
        }
    } else if (args.symbol && recovery?.recovery_confirmed !== true) {
        recoveryDirectionLatchBySymbol.delete(args.symbol);
    }

    const latched =
        args.symbol != null ? recoveryDirectionLatchBySymbol.get(args.symbol) ?? null : null;
    const recoverySide =
        recovery?.recovery_confirmed === true && recovery.recovery_direction !== "none"
            ? recovery.recovery_direction
            : latched;

    if (recoverySide === "long" || recoverySide === "short") {
        const htfOk = isHtfPolicyCompatibleWithCandidateSide(args.htfEntryPolicy, recoverySide);
        if (htfOk) {
            const src =
                recoverySide === "long" ? "RECOVERY_DIRECTION_LONG" : "RECOVERY_DIRECTION_SHORT";
            return {
                candidateSideBeforeRegimeAuthority: emaFallback,
                candidateSideAfterRegimeAuthority: recoverySide,
                candidateSide: recoverySide,
                trendCandidateDirectionSource: src,
                candidateDirectionSourceBefore: sourceBefore,
                candidateDirectionSourceAfter: src
            };
        }
    }

    if (args.canonicalRegime === "TREND_UP") {
        return {
            candidateSideBeforeRegimeAuthority: emaFallback,
            candidateSideAfterRegimeAuthority: "long",
            candidateSide: "long",
            trendCandidateDirectionSource: "REGIME_DIRECTION_TREND_UP",
            candidateDirectionSourceBefore: sourceBefore,
            candidateDirectionSourceAfter: "REGIME_DIRECTION_TREND_UP"
        };
    }
    if (args.canonicalRegime === "TREND_DOWN") {
        return {
            candidateSideBeforeRegimeAuthority: emaFallback,
            candidateSideAfterRegimeAuthority: "short",
            candidateSide: "short",
            trendCandidateDirectionSource: "REGIME_DIRECTION_TREND_DOWN",
            candidateDirectionSourceBefore: sourceBefore,
            candidateDirectionSourceAfter: "REGIME_DIRECTION_TREND_DOWN"
        };
    }
    return {
        candidateSideBeforeRegimeAuthority: emaFallback,
        candidateSideAfterRegimeAuthority: emaFallback,
        candidateSide: emaFallback,
        trendCandidateDirectionSource: "EMA_GAP_FALLBACK",
        candidateDirectionSourceBefore: sourceBefore,
        candidateDirectionSourceAfter: "EMA_GAP_FALLBACK"
    };
}
