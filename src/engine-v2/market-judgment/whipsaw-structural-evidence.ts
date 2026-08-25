import type { Candle } from "../../models/types";
import { deriveTrendSideCandidate } from "../trend-side-candidate";
import { isEmaGapAlignedWithTrendSideCandidate, normalizeDirectionalShock } from "./whipsaw-aged-soft-downgrade";

export type WhipsawMicroPattern = "micro_up_then_drop" | "micro_down_then_rebound";

const MICRO_IDENTITY_BARS = 8;
const STRONG_EMA_GAP = 0.0004;

export function isTrendContinuationAligned(args: {
    trendCandidateSide: "long" | "short" | "none";
    emaGap: number;
    directionalShockState: string | null | undefined;
}): boolean {
    const { trendCandidateSide, emaGap, directionalShockState } = args;
    if (trendCandidateSide === "none") return false;
    if (!Number.isFinite(emaGap) || Math.abs(emaGap) < STRONG_EMA_GAP) return false;
    if (!isEmaGapAlignedWithTrendSideCandidate(trendCandidateSide, emaGap)) return false;

    const shock = normalizeDirectionalShock(directionalShockState);
    if (trendCandidateSide === "short") {
        return shock === "DOWN" || shock === "NONE";
    }
    return shock === "UP" || shock === "NONE";
}

/** Short/Long structure invalidated or reclaimed against the aligned trend candidate. */
export function isTrendStructureInvalidated(args: {
    trendCandidateSide: "long" | "short" | "none";
    boxBreakSide: string;
    retestConfirmed: boolean;
    reclaimConfirmed: boolean;
    directionalShockState: string | null | undefined;
}): boolean {
    const { trendCandidateSide, boxBreakSide, retestConfirmed, reclaimConfirmed, directionalShockState } = args;
    const breakSide = String(boxBreakSide ?? "none").toLowerCase();
    const shock = normalizeDirectionalShock(directionalShockState);

    if (trendCandidateSide === "short") {
        if (shock === "UP") return true;
        if (breakSide === "upper") return true;
        if (breakSide === "lower" && !reclaimConfirmed) return true;
        if (breakSide === "lower" && retestConfirmed && !reclaimConfirmed) return true;
        return false;
    }
    if (trendCandidateSide === "long") {
        if (shock === "DOWN") return true;
        if (breakSide === "lower") return true;
        if (breakSide === "upper" && !reclaimConfirmed) return true;
        if (breakSide === "upper" && retestConfirmed && !reclaimConfirmed) return true;
        return false;
    }
    return false;
}

export function deriveMicroPatternIdentity(
    candles: Candle[] | undefined,
    pattern: WhipsawMicroPattern,
    bars: number = MICRO_IDENTITY_BARS
): string | null {
    if (!candles || candles.length < bars) return null;
    const w = candles.slice(-bars);
    const lows = w.map((c) => c.low);
    const highs = w.map((c) => c.high);
    const minL = Math.min(...lows);
    const maxH = Math.max(...highs);
    const minI = lows.indexOf(minL);
    const maxI = highs.indexOf(maxH);
    const anchorTs = w[w.length - 1]?.ts ?? 0;
    return `${pattern}:${anchorTs}:${minI}:${maxI}:${minL.toFixed(4)}:${maxH.toFixed(4)}`;
}

export function classifyWhipsawMicroEvidence(args: {
    downThenRebound: boolean;
    upThenDrop: boolean;
    candles: Candle[] | undefined;
    trendCandidateSide: "long" | "short" | "none";
    directionalShockState: string | null | undefined;
    emaGap: number;
    structureInvalidated: boolean;
}): {
    whipsawMicroHits: WhipsawMicroPattern[];
    continuationMicroHits: WhipsawMicroPattern[];
    microPatternIdentity: string | null;
} {
    const {
        downThenRebound,
        upThenDrop,
        candles,
        trendCandidateSide,
        directionalShockState,
        emaGap,
        structureInvalidated
    } = args;

    const continuationAligned = isTrendContinuationAligned({
        trendCandidateSide,
        emaGap,
        directionalShockState
    });

    const whipsawMicroHits: WhipsawMicroPattern[] = [];
    const continuationMicroHits: WhipsawMicroPattern[] = [];

    if (upThenDrop) {
        const continuation =
            !structureInvalidated && continuationAligned && trendCandidateSide === "short";
        if (continuation) continuationMicroHits.push("micro_up_then_drop");
        else whipsawMicroHits.push("micro_up_then_drop");
    }
    if (downThenRebound) {
        const continuation =
            !structureInvalidated && continuationAligned && trendCandidateSide === "long";
        if (continuation) continuationMicroHits.push("micro_down_then_rebound");
        else whipsawMicroHits.push("micro_down_then_rebound");
    }

    const identityPattern: WhipsawMicroPattern | null =
        whipsawMicroHits[0] ?? continuationMicroHits[0] ?? null;
    const microPatternIdentity = identityPattern
        ? deriveMicroPatternIdentity(candles, identityPattern)
        : null;

    return { whipsawMicroHits, continuationMicroHits, microPatternIdentity };
}

/**
 * Directional-failure structural invalidation hits.
 * Generic volume expansion alone does NOT qualify.
 */
export function classifyDirectionalFailureStructuralHits(args: {
    boxOrbitChop: boolean;
    boxBreakSide: string;
    retestConfirmed: boolean;
    reclaimConfirmed: boolean;
    breakoutFailureRate: number;
    mixedBreakoutState: boolean;
    whipsawMicroHits: WhipsawMicroPattern[];
    trendCandidateSide: "long" | "short" | "none";
    directionalShockState: string | null | undefined;
}): string[] {
    const {
        boxOrbitChop,
        boxBreakSide,
        retestConfirmed,
        reclaimConfirmed,
        breakoutFailureRate,
        mixedBreakoutState,
        whipsawMicroHits,
        trendCandidateSide,
        directionalShockState
    } = args;

    const breakSide = String(boxBreakSide ?? "none").toLowerCase();
    const hasActiveBreak = breakSide !== "none" && breakSide !== "unknown";
    const hits: string[] = [];

    if (boxOrbitChop) hits.push("box_orbit_chop");
    if (hasActiveBreak && (!retestConfirmed || !reclaimConfirmed)) {
        hits.push("box_break_unconfirmed");
    }
    if (hasActiveBreak && breakoutFailureRate >= 0.4) {
        hits.push("breakout_failure_rate_ge_0_4");
    }
    if (hasActiveBreak && mixedBreakoutState) hits.push("mixed_breakout_state");

    const failedBreakdownReclaimOpposite =
        hasActiveBreak &&
        !reclaimConfirmed &&
        whipsawMicroHits.length >= 1 &&
        ((trendCandidateSide === "short" && breakSide === "lower") ||
            (trendCandidateSide === "long" && breakSide === "upper") ||
            (normalizeDirectionalShock(directionalShockState) === "DOWN" &&
                whipsawMicroHits.includes("micro_down_then_rebound")) ||
            (normalizeDirectionalShock(directionalShockState) === "UP" &&
                whipsawMicroHits.includes("micro_up_then_drop")));

    if (failedBreakdownReclaimOpposite) {
        hits.push("failed_breakdown_reclaim_opposite_displacement");
    }

    return hits;
}

export function evaluateWhipsawEvidenceBundle(args: {
    downThenRebound: boolean;
    upThenDrop: boolean;
    candles: Candle[] | undefined;
    emaGap: number;
    directionalShockState: string | null | undefined;
    boxOrbitChop: boolean;
    boxBreakSide: string;
    retestConfirmed: boolean;
    reclaimConfirmed: boolean;
    breakoutFailureRate: number;
    mixedBreakoutState: boolean;
}): {
    whipsawMicroHits: WhipsawMicroPattern[];
    continuationMicroHits: WhipsawMicroPattern[];
    microPatternIdentity: string | null;
    directionalFailureStructuralHits: string[];
    trendCandidateSide: "long" | "short" | "none";
    structureInvalidated: boolean;
} {
    const trendCandidateSide = deriveTrendSideCandidate(args.directionalShockState, args.emaGap);
    const structureInvalidated = isTrendStructureInvalidated({
        trendCandidateSide,
        boxBreakSide: args.boxBreakSide,
        retestConfirmed: args.retestConfirmed,
        reclaimConfirmed: args.reclaimConfirmed,
        directionalShockState: args.directionalShockState
    });

    const micro = classifyWhipsawMicroEvidence({
        downThenRebound: args.downThenRebound,
        upThenDrop: args.upThenDrop,
        candles: args.candles,
        trendCandidateSide,
        directionalShockState: args.directionalShockState,
        emaGap: args.emaGap,
        structureInvalidated
    });

    const directionalFailureStructuralHits = classifyDirectionalFailureStructuralHits({
        boxOrbitChop: args.boxOrbitChop,
        boxBreakSide: args.boxBreakSide,
        retestConfirmed: args.retestConfirmed,
        reclaimConfirmed: args.reclaimConfirmed,
        breakoutFailureRate: args.breakoutFailureRate,
        mixedBreakoutState: args.mixedBreakoutState,
        whipsawMicroHits: micro.whipsawMicroHits,
        trendCandidateSide,
        directionalShockState: args.directionalShockState
    });

    return {
        ...micro,
        directionalFailureStructuralHits,
        trendCandidateSide,
        structureInvalidated
    };
}
