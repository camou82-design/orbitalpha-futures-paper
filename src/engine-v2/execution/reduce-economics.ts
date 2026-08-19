import type { PaperOpenPositionRecord } from "../../models/types";
import { resolveOpenNotionalUsd } from "../live-account/position-size-authority";

// Preserve the existing two-step allowance for genuinely worsening SHOCK defense,
// but routine PNL/TRANSITION defense is capped separately at one trim below.
export const MAX_PROTECTIVE_PARTIAL_REDUCE_COUNT = 2;
export const MAX_ROUTINE_DEFENSIVE_REDUCE_COUNT = 1;
export const REDUCE_FEE_SAFETY_MULTIPLIER = 1.5;
export const V2_REDUCE_ECONOMIC_LOT_DISTORTION_THRESHOLD = 1.75;

const URGENCY_RANK: Record<string, number> = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4
};

const FEE_BYPASS_REASONS = new Set([
    "STOP_LOSS",
    "INVALIDATION_REACHED",
    "INVALIDATION_BREACH",
    "SHOCK_FULL_EXIT_AGAINST_POSITION",
    "STRUCTURAL_EXIT",
    "FULL_EXIT",
    "FORCE_CLOSE",
    "LIQUIDATION"
]);

export function isProtectivePartialReason(reason: string | null | undefined): boolean {
    const r = String(reason ?? "").toUpperCase();
    if (!r) return false;
    if (r.startsWith("V2_RANGE_TAKE_PROFIT")) return false;
    if (r.includes("RANGE_PARTIAL_AT_OPPOSITE_EDGE")) return false;
    if (r.includes("TAKE_PROFIT") && !r.includes("SHOCK")) return false;
    if (r.includes("FULL_EXIT") || r.includes("FINAL_EXIT")) return false;
    if (r.includes("STOP_LOSS")) return false;

    // PNL_STOP_PROTECT is a partial defensive mutation when policy downgrades it to REDUCE.
    // It must be counted rather than silently reporting partialReduceCount=0.
    if (r.includes("PNL_STOP")) return true;
    if (r.includes("TRANSITION_REDUCE_ON_CONFLICT")) return true;

    return (
        r.includes("SHOCK") ||
        r.includes("V2_PARTIAL") ||
        r.includes("DEFENSIVE") ||
        r.includes("PROTECTIVE")
    );
}

export function isRoutineDefensivePartialReason(reason: string | null | undefined): boolean {
    const r = String(reason ?? "").toUpperCase();
    return r.includes("PNL_STOP") || r.includes("TRANSITION_REDUCE_ON_CONFLICT");
}

export function isFeeEconomicsBypassReason(reason: string | null | undefined): boolean {
    const upper = String(reason ?? "").toUpperCase();
    for (const token of FEE_BYPASS_REASONS) {
        if (upper.includes(token)) return true;
    }
    if (upper.includes("INVALIDATION")) return true;
    if (upper.includes("CRITICAL")) return true;
    return false;
}

export function isLotDistortionBypassReason(reason: string | null | undefined): boolean {
    return isFeeEconomicsBypassReason(reason);
}

export function buildReduceEpisodeId(input: Readonly<{
    symbol: string;
    side: string;
    reason: string;
    shockPhase?: string | null;
    marketSubtype?: string | null;
}>): string {
    return [
        input.symbol,
        input.side,
        String(input.reason),
        String(input.shockPhase ?? "NONE"),
        String(input.marketSubtype ?? "NONE")
    ].join("|");
}

export function evaluateReduceEpisodeGate(input: Readonly<{
    open: PaperOpenPositionRecord;
    reason: string;
    decisionCandleTs: number;
    shockPhase?: string | null;
    marketSubtype?: string | null;
    urgency?: string | null;
    reduceRatio?: number | null;
    invalidationDistancePct?: number | null;
}>): Readonly<{
    submitAllowed: boolean;
    blockReason: string | null;
    newMarketEvidence: boolean;
    episodeId: string;
}> {
    const episodeIdFromOpen = buildReduceEpisodeId({
        symbol: String(input.open.symbol),
        side: input.open.side,
        reason: input.reason,
        shockPhase: input.shockPhase,
        marketSubtype: input.marketSubtype
    });
    if (!isProtectivePartialReason(input.reason)) {
        return {
            submitAllowed: true,
            blockReason: null,
            newMarketEvidence: true,
            episodeId: episodeIdFromOpen
        };
    }

    const episodeId = episodeIdFromOpen;
    const lastCandle = openNum(input.open.lastReduceFilledCandleTs);
    const freshCandle = input.decisionCandleTs > 0 && input.decisionCandleTs > lastCandle;
    const sameEpisode =
        input.open.lastReduceEpisodeId != null && input.open.lastReduceEpisodeId === episodeId;
    const shockWorsened =
        shockRank(input.shockPhase) > shockRank(input.open.lastReduceShockPhase);
    const urgencyIncreased =
        urgencyRank(input.urgency) > urgencyRank(input.open.lastReduceUrgency);
    const invalidationCloser =
        input.invalidationDistancePct != null &&
        input.open.lastReduceInvalidationDistancePct != null &&
        input.invalidationDistancePct <
            input.open.lastReduceInvalidationDistancePct * 0.85;
    const ratioChanged =
        input.reduceRatio != null &&
        input.open.lastReduceRatio != null &&
        Math.abs(input.reduceRatio - input.open.lastReduceRatio) >= 0.1;

    const newMarketEvidence =
        !sameEpisode ||
        (freshCandle &&
            (shockWorsened || urgencyIncreased || invalidationCloser || ratioChanged));

    if (lastCandle > 0 && input.decisionCandleTs <= lastCandle && sameEpisode && !newMarketEvidence) {
        return {
            submitAllowed: false,
            blockReason: "REDUCE_EPISODE_ALREADY_EXECUTED",
            newMarketEvidence: false,
            episodeId
        };
    }

    if (sameEpisode && !newMarketEvidence) {
        return {
            submitAllowed: false,
            blockReason: "REDUCE_EPISODE_ALREADY_EXECUTED",
            newMarketEvidence: false,
            episodeId
        };
    }

    return {
        submitAllowed: true,
        blockReason: null,
        newMarketEvidence,
        episodeId
    };
}

export function evaluatePartialReduceLimit(input: Readonly<{
    open: PaperOpenPositionRecord;
    reason: string;
    protectivePartialCount: number;
    urgency?: string | null;
    invalidationImminent?: boolean;
}>): Readonly<{
    submitAllowed: boolean;
    blockReason: string | null;
    fallbackAction: "NONE" | "HOLD" | "FULL_EXIT";
}> {
    if (!isProtectivePartialReason(input.reason)) {
        return { submitAllowed: true, blockReason: null, fallbackAction: "NONE" };
    }

    const maxAllowed = isRoutineDefensivePartialReason(input.reason)
        ? MAX_ROUTINE_DEFENSIVE_REDUCE_COUNT
        : MAX_PROTECTIVE_PARTIAL_REDUCE_COUNT;

    if (input.protectivePartialCount < maxAllowed) {
        return { submitAllowed: true, blockReason: null, fallbackAction: "NONE" };
    }

    // BLOCKER 4-20: a partial-execution limiter is not terminal-exit authority.
    // Even when the old caller labels invalidation as "imminent" based only on distance,
    // this layer must HOLD. A FULL_EXIT must be emitted independently by V2 exit policy
    // (actual stop breach, confirmed structure/box/reversal with meaningful move, etc.).
    return {
        submitAllowed: false,
        blockReason: "MAX_PROTECTIVE_PARTIAL_REDUCE_REACHED",
        fallbackAction: "HOLD"
    };
}

export function evaluateReduceEconomicSize(input: Readonly<{
    reason: string;
    requestedReduceNotionalUsdt: number;
    normalizedReduceNotionalUsdt: number;
}>): Readonly<{
    lotDistortionRatio: number;
    economicSizePassed: boolean;
    fallbackAction: "NONE" | "HOLD" | "FULL_EXIT";
}> {
    const requested = Math.max(0, input.requestedReduceNotionalUsdt);
    const normalized = Math.max(0, input.normalizedReduceNotionalUsdt);
    const ratio = requested > 0 ? normalized / requested : normalized > 0 ? Infinity : 1;
    if (isLotDistortionBypassReason(input.reason)) {
        return { lotDistortionRatio: ratio, economicSizePassed: true, fallbackAction: "NONE" };
    }
    if (ratio > V2_REDUCE_ECONOMIC_LOT_DISTORTION_THRESHOLD) {
        return { lotDistortionRatio: ratio, economicSizePassed: false, fallbackAction: "HOLD" };
    }
    return { lotDistortionRatio: ratio, economicSizePassed: true, fallbackAction: "NONE" };
}

export function evaluateReduceExecutionEconomics(input: Readonly<{
    reason: string;
    positionNotionalUsdt: number;
    requestedReduceNotionalUsdt: number;
    normalizedReduceNotionalUsdt: number;
    feeRate: number;
    riskBeforeUsdt: number;
    riskAfterUsdt: number;
    includeReentryFee?: boolean;
}>): Readonly<{
    estimatedExitFeeUsdt: number;
    estimatedReentryFeeUsdt: number;
    riskReductionUsdt: number;
    economicsPassed: boolean;
    bypassReason: string | null;
    finalAction: "PARTIAL" | "HOLD" | "FULL_EXIT";
}> {
    const exitFee = input.normalizedReduceNotionalUsdt * input.feeRate;
    const reentryFee = input.includeReentryFee === true ? input.normalizedReduceNotionalUsdt * input.feeRate : 0;
    const expectedFee = exitFee + reentryFee;
    const riskReduction = Math.max(0, input.riskBeforeUsdt - input.riskAfterUsdt);

    if (isFeeEconomicsBypassReason(input.reason)) {
        return {
            estimatedExitFeeUsdt: exitFee,
            estimatedReentryFeeUsdt: reentryFee,
            riskReductionUsdt: riskReduction,
            economicsPassed: true,
            bypassReason: input.reason,
            finalAction: "PARTIAL"
        };
    }

    const passed = riskReduction > expectedFee * REDUCE_FEE_SAFETY_MULTIPLIER;
    return {
        estimatedExitFeeUsdt: exitFee,
        estimatedReentryFeeUsdt: reentryFee,
        riskReductionUsdt: riskReduction,
        economicsPassed: passed,
        bypassReason: passed ? null : "ECONOMICALLY_INEFFICIENT_REDUCE",
        finalAction: passed ? "PARTIAL" : "HOLD"
    };
}

export function evaluateShockReduceEscalation(input: Readonly<{
    episodeCount: number;
    shockPhase?: string | null;
    previousShockPhase?: string | null;
    freshCandle: boolean;
    riskDeteriorated: boolean;
    urgency?: string | null;
    invalidationImminent?: boolean;
}>): Readonly<{
    partialAllowed: boolean;
    fullExitRequired: boolean;
    decisionReason: string;
}> {
    if (input.episodeCount >= MAX_PROTECTIVE_PARTIAL_REDUCE_COUNT) {
        // Same sovereignty rule as evaluatePartialReduceLimit: this helper may block a
        // repeated partial, but it may never synthesize a terminal close from proximity.
        return {
            partialAllowed: false,
            fullExitRequired: false,
            decisionReason: "max_partials_reached_hold_for_exit_policy"
        };
    }
    if (input.episodeCount === 0) {
        return { partialAllowed: true, fullExitRequired: false, decisionReason: "first_protective_partial" };
    }
    if (input.freshCandle && input.riskDeteriorated) {
        return { partialAllowed: true, fullExitRequired: false, decisionReason: "fresh_deterioration_second_partial" };
    }
    return {
        partialAllowed: false,
        fullExitRequired: false,
        decisionReason: "same_shock_episode_hold"
    };
}

export function markProtectiveReduceEpisodeFilled(
    open: PaperOpenPositionRecord,
    input: Readonly<{
        episodeId: string;
        reason: string;
        decisionCandleTs: number;
        filledAt: number;
        shockPhase?: string | null;
        marketSubtype?: string | null;
        urgency?: string | null;
        reduceRatio?: number | null;
        invalidationDistancePct?: number | null;
    }>
): void {
    open.lastReduceEpisodeId = input.episodeId;
    open.lastReduceReason = input.reason;
    open.lastReduceFilledCandleTs = input.decisionCandleTs;
    open.lastReduceFilledAt = input.filledAt;
    open.lastReduceMarketSubtype = input.marketSubtype ?? undefined;
    open.lastReduceShockPhase = input.shockPhase ?? undefined;
    open.lastReduceRatio = input.reduceRatio ?? undefined;
    open.lastReduceUrgency = input.urgency ?? undefined;
    open.lastReduceInvalidationDistancePct = input.invalidationDistancePct ?? undefined;
    open.consecutiveReduceEpisodeCount = (open.consecutiveReduceEpisodeCount ?? 0) + 1;
    open.protectivePartialReduceCount = (open.protectivePartialReduceCount ?? 0) + 1;
    open.shockReduceState = "FILLED";
    if (String(input.reason).toUpperCase().includes("RANGE_PARTIAL_AT_OPPOSITE_EDGE")) {
        open.rangeOppositePartialTaken = true;
    }
}

export function estimatePositionRiskAtStop(open: PaperOpenPositionRecord, lastPrice: number): number {
    const notional = resolveOpenNotionalUsd(open);
    const stop = open.stopPrice ?? open.invalidationPx;
    const entry = open.avgPx ?? open.entryPrice;
    if (!(notional > 0) || !(entry > 0) || stop == null || !Number.isFinite(stop)) {
        return notional * 0.02;
    }
    const dist = open.side === "long"
        ? Math.max(0, (entry - stop) / entry)
        : Math.max(0, (stop - entry) / entry);
    return notional * dist;
}

export function updatePositionExcursionTelemetry(
    open: PaperOpenPositionRecord,
    lastPrice: number
): void {
    const entry = open.avgPx ?? open.entryPrice;
    if (!(entry > 0) || !(lastPrice > 0)) return;
    const movePct = open.side === "long"
        ? (lastPrice - entry) / entry
        : (entry - lastPrice) / entry;
    if (movePct > (open.maxFavorableExcursionPct ?? -Infinity)) {
        open.maxFavorableExcursionPct = movePct;
        open.maxFavorablePrice = lastPrice;
    }
    const adverse = -movePct;
    if (adverse > (open.maxAdverseExcursionPct ?? -Infinity)) {
        open.maxAdverseExcursionPct = adverse;
        open.maxAdversePrice = lastPrice;
    }
}

function openNum(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function urgencyRank(v: unknown): number {
    return URGENCY_RANK[String(v ?? "none").toLowerCase()] ?? 0;
}

function shockRank(v: unknown): number {
    const s = String(v ?? "NONE").toUpperCase();
    if (s.includes("CRITICAL")) return 4;
    if (s.includes("DOWN_SHOCK") || s.includes("UP_SHOCK")) return 3;
    if (s.includes("SHOCK")) return 2;
    return s === "NONE" ? 0 : 1;
}

export function buildPartialReduceLimitProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_PARTIAL_REDUCE_LIMIT_PROOF", ...input };
}

export function buildReduceEconomicSizeProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_REDUCE_ECONOMIC_SIZE_PROOF", ...input };
}

export function buildReduceFeeEconomicsProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_REDUCE_FEE_ECONOMICS_PROOF", ...input };
}

export function buildShockReduceEscalationProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_SHOCK_REDUCE_ESCALATION_PROOF", ...input };
}

export function buildCompletedTradeEconomicsProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_COMPLETED_TRADE_ECONOMICS_PROOF", ...input };
}
