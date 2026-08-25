import type { EngineV2Side } from "./types";

/**
 * Single source of truth for authoritative trendSideCandidate.
 * Used by engine-v2/index.ts and WHIPSAW aged-release predicate.
 *
 * Semantics (production index.ts):
 * - shock DOWN -> short
 * - shock UP -> long
 * - otherwise emaGap sign (including UNKNOWN/null/non-UP/DOWN shock)
 */
export function deriveTrendSideCandidate(
    directionalShockState: string | null | undefined,
    emaGap: number
): "long" | "short" | "none" {
    const shock = directionalShockState ?? "NONE";
    if (shock === "DOWN") return "short";
    if (shock === "UP") return "long";
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
