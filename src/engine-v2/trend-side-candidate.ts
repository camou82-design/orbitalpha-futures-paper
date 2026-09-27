import type { EngineV2Side } from "./types";
import type { CanonicalRegimeDirection } from "./state/regime-authority";

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

export type TrendCandidateDirectionSource = "REGIME_DIRECTION_TREND_UP" | "REGIME_DIRECTION_TREND_DOWN" | "EMA_GAP_FALLBACK";

export function resolveTrendExecutionCandidateDirection(args: Readonly<{
    directionalShockState: string | null | undefined;
    emaGap: number;
    canonicalRegime: CanonicalRegimeDirection | null | undefined;
}>): Readonly<{
    candidateSide: "long" | "short" | "none";
    candidateSideBeforeRegimeAuthority: "long" | "short" | "none";
    candidateSideAfterRegimeAuthority: "long" | "short" | "none";
    trendCandidateDirectionSource: TrendCandidateDirectionSource;
}> {
    const emaFallback = deriveTrendSideCandidate(args.directionalShockState, args.emaGap);
    if (args.canonicalRegime === "TREND_UP") {
        return {
            candidateSideBeforeRegimeAuthority: emaFallback,
            candidateSideAfterRegimeAuthority: "long",
            candidateSide: "long",
            trendCandidateDirectionSource: "REGIME_DIRECTION_TREND_UP"
        };
    }
    if (args.canonicalRegime === "TREND_DOWN") {
        return {
            candidateSideBeforeRegimeAuthority: emaFallback,
            candidateSideAfterRegimeAuthority: "short",
            candidateSide: "short",
            trendCandidateDirectionSource: "REGIME_DIRECTION_TREND_DOWN"
        };
    }
    return {
        candidateSideBeforeRegimeAuthority: emaFallback,
        candidateSideAfterRegimeAuthority: emaFallback,
        candidateSide: emaFallback,
        trendCandidateDirectionSource: "EMA_GAP_FALLBACK"
    };
}
