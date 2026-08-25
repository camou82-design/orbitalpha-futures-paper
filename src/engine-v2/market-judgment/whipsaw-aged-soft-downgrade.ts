import type { EngineV2Input } from "../types";
import { deriveTrendSideCandidate } from "../trend-side-candidate";

export const WHIPSAW_AGED_SOFT_DOWNGRADE_REASON = "WHIPSAW_AGED_NO_FRESH_STRUCTURAL_ALIGNED_TREND";
export const WHIPSAW_AGED_SOFT_DOWNGRADE_MIN_QUALITY = 80;

export type NormalizedDirectionalShock = "UP" | "DOWN" | "NONE" | "INVALID";

export function normalizeDirectionalShock(
    directionalShockState: string | null | undefined
): NormalizedDirectionalShock {
    const shock = String(directionalShockState ?? "").toUpperCase();
    if (shock === "UP" || shock === "DOWN" || shock === "NONE") return shock;
    return "INVALID";
}

export function isEmaGapAlignedWithTrendSideCandidate(
    candidateSide: "long" | "short" | "none",
    emaGap: number
): boolean {
    if (candidateSide === "long") return emaGap > 0;
    if (candidateSide === "short") return emaGap < 0;
    return false;
}

/** HTF producer whitelist for aged hard→soft release (PROBE_ONLY excluded — micro-probe lane only). */
export function isHtfPolicyCompatibleWithCandidateSide(
    htfEntryPolicy: string | null | undefined,
    candidateSide: "long" | "short" | "none"
): boolean {
    if (candidateSide === "none") return false;
    const policy = String(htfEntryPolicy ?? "").trim().toUpperCase();
    if (!policy || policy === "UNKNOWN" || policy === "NULL" || policy === "UNDEFINED") return false;
    if (policy === "HOLD" || policy === "PROBE_ONLY" || policy === "NEUTRAL_HTF_DATA_WAIT") return false;
    if (candidateSide === "long") {
        return policy === "ALLOW" || policy === "LONG_ONLY_OR_NONE" || policy === "BOTH";
    }
    return policy === "ALLOW" || policy === "SHORT_ONLY_OR_NONE" || policy === "BOTH";
}

/** Explicit shock whitelist: LONG→UP|NONE, SHORT→DOWN|NONE; UNKNOWN/null/invalid blocked. */
export function isDirectionalShockCompatibleWithCandidateSide(
    directionalShockState: string | null | undefined,
    candidateSide: "long" | "short" | "none"
): boolean {
    if (candidateSide === "none") return false;
    const shock = normalizeDirectionalShock(directionalShockState);
    if (shock === "INVALID") return false;
    if (candidateSide === "long") return shock === "UP" || shock === "NONE";
    return shock === "DOWN" || shock === "NONE";
}

export function deriveTrendOk(snapshot: EngineV2Input["snapshot"]): boolean {
    const emaGap = Number(snapshot.emaGap ?? 0);
    const trendWeaknessScore = Number(snapshot.canonicalTrendWeaknessScore ?? snapshot.trendWeaknessScore ?? 1);
    return (
        Number.isFinite(emaGap) &&
        Number.isFinite(trendWeaknessScore) &&
        Math.abs(emaGap) >= 0.0004 &&
        trendWeaknessScore < 0.5
    );
}

export function isHardControlClear(state: EngineV2Input["state"]): boolean {
    return (
        state.paperExecutionReady === true &&
        state.serverTradeEnabled === true &&
        state.closeOnlyMode !== true &&
        state.killSwitch !== true &&
        state.killSwitchActive !== true &&
        state.reconcileSafeMode !== true &&
        state.reconcileSafeModeActive !== true &&
        String(state.riskMode ?? "").toUpperCase() !== "HALT" &&
        state.dailyLossGuardTriggered !== true
    );
}

export function hasSymbolPositionBarrier(state: EngineV2Input["state"], symbol: string): boolean {
    const sym = String(symbol).toUpperCase();
    return (state.currentPositions ?? []).some((p) => {
        if (String(p.symbol ?? "").toUpperCase() !== sym) return false;
        const size = Number((p as { sizeUsd?: number }).sizeUsd ?? 0);
        return size > 0;
    });
}

export function evaluateWhipsawAgedSoftDowngradeEligible(args: Readonly<{
    input: EngineV2Input;
    observationAgePassed: boolean;
    hasWhipsawEpisode: boolean;
    freshStructuralHitCount: number;
    htfEntryPolicy?: string | null;
    polarityMismatch?: boolean;
    directionalShockState: string | null | undefined;
}>): { eligible: boolean; candidateSide: "long" | "short" | "none"; trendOk: boolean } {
    const {
        input,
        observationAgePassed,
        hasWhipsawEpisode,
        freshStructuralHitCount,
        htfEntryPolicy,
        polarityMismatch,
        directionalShockState
    } = args;
    const sn = input.snapshot;
    const st = input.state;
    const trendOk = deriveTrendOk(sn);
    const emaGap = Number(sn.emaGap ?? 0);
    const qualityScore = Number(sn.qualityScore ?? 0);
    const candidateSide = deriveTrendSideCandidate(directionalShockState, emaGap);
    const emaAligned = isEmaGapAlignedWithTrendSideCandidate(candidateSide, emaGap);

    const isLiveExecution = st.okxLiveEnabled === true;
    const readinessOk =
        st.paperExecutionReady === true &&
        st.executionReadiness !== false &&
        (!isLiveExecution || st.signedExecutionReady === true);

    const eligible =
        hasWhipsawEpisode &&
        observationAgePassed === true &&
        freshStructuralHitCount === 0 &&
        Number.isFinite(qualityScore) &&
        qualityScore >= WHIPSAW_AGED_SOFT_DOWNGRADE_MIN_QUALITY &&
        trendOk === true &&
        (candidateSide === "long" || candidateSide === "short") &&
        emaAligned === true &&
        isHtfPolicyCompatibleWithCandidateSide(htfEntryPolicy, candidateSide) &&
        polarityMismatch !== true &&
        isDirectionalShockCompatibleWithCandidateSide(directionalShockState, candidateSide) &&
        isHardControlClear(st) &&
        readinessOk &&
        st.hasSymbolPendingEntry !== true &&
        !hasSymbolPositionBarrier(st, input.symbol);

    return { eligible, candidateSide, trendOk };
}
