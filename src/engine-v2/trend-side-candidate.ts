import type { EngineV2Side } from "./types";

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

/** Typed alias for index.ts locals expecting EngineV2Side. */
export function deriveTrendSideCandidateAsEngineSide(
    directionalShockState: string | null | undefined,
    emaGap: number
): EngineV2Side {
    return deriveTrendSideCandidate(directionalShockState, emaGap);
}
