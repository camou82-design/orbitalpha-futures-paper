export type RangeBoundarySide = "long" | "short" | "none";

export type RangeBoundaryContinuationEval = Readonly<{
    confirmed: boolean;
    holdReason: string | null;
    wickOnlyBreak: boolean;
    closedBreakConfirmed: boolean;
    retestConfirmed: boolean;
    continuationLineage?: boolean;
    continuationConfirmationPassed?: boolean;
    breakoutBreakdownSubstituted?: boolean;
    continuationScore?: number;
    evidence: Record<string, unknown>;
}>;

export type RangeBoundaryContinuationContext = Readonly<{
    trendSideCandidate: RangeBoundarySide;
    zone: "lower" | "mid" | "upper";
    boxBreakSide: string;
    boxLow: number;
    boxHigh: number;
    boxPos?: number | null;
    atr?: number | null;
    qualityScore?: number;
    candles?: ReadonlyArray<{ open: number; high: number; low: number; close: number; volume?: number }>;
    fastTrendShift?: Readonly<{
        active?: boolean;
        direction?: string;
        lower_high_detected?: boolean;
        lower_low_detected?: boolean;
        higher_high_detected?: boolean;
        higher_low_detected?: boolean;
        box_mid_lost?: boolean;
        box_mid_reclaimed?: boolean;
        box_lower_breakdown_hold?: boolean;
        box_upper_breakout_hold?: boolean;
        reason?: string;
        stop_price?: number | null;
    }> | null;
    opposingStrongHighway?: boolean;
    directionalShock?: string;
    closedClose: number | null;
    lastPrice: number;
    previousConfirmedBoxLow: number | null;
    previousConfirmedBoxHigh: number | null;
    emaGap: number;
    htfEntryPolicy: string;
    htfRequiresStrongerConfirmation: boolean;
    counterTrendRisk: boolean;
    riskLongAllow: boolean;
    riskShortAllow: boolean;
    allowNewLong: boolean;
    allowNewShort: boolean;
    whipsawShockRecheckActive: boolean;
    hardBlockPresent: boolean;
    paperExecutionReady: boolean;
    signedExecutionReady: boolean;
    hasSameSidePosition: boolean;
    hasOppositeSidePosition: boolean;
    judgmentSubtype: string;
    rangePhase: string | null;
    transitionPhase: string | null;
    continuationDirection: string | null;
    continuationPhase: string | null;
    retestConfirmed: boolean;
    retestTouched: boolean;
    retestRejected: boolean;
    reversalConfirmed: boolean;
    execReason: string | null;
    lateChaseBlocked: boolean;
    retestRequired: boolean;
    /** When true, skip execution/position hard gates (transition zone preflight). */
    skipExecutionGate?: boolean;
}>;

function normalizeBreakSide(value: string | null | undefined): string {
    return String(value ?? "none").trim().toLowerCase();
}

function breakdownBoundary(ctx: RangeBoundaryContinuationContext): number {
    const prev = ctx.previousConfirmedBoxLow;
    if (prev != null && Number.isFinite(prev) && prev > 0) return prev;
    return ctx.boxLow > 0 ? ctx.boxLow : 0;
}

function breakoutBoundary(ctx: RangeBoundaryContinuationContext): number {
    const prev = ctx.previousConfirmedBoxHigh;
    if (prev != null && Number.isFinite(prev) && prev > 0) return prev;
    return ctx.boxHigh > 0 ? ctx.boxHigh : 0;
}

export function evaluateAuthoritativeClosedBreakdown(input: Readonly<{
    closedClose: number | null;
    boundary: number;
    lastPrice: number;
}>): Readonly<{ confirmed: boolean; wickOnly: boolean }> {
    const { closedClose, boundary, lastPrice } = input;
    if (boundary <= 0 || closedClose == null || !Number.isFinite(closedClose)) {
        return { confirmed: false, wickOnly: false };
    }
    if (closedClose < boundary) {
        return { confirmed: true, wickOnly: false };
    }
    if (lastPrice < boundary) {
        return { confirmed: false, wickOnly: true };
    }
    return { confirmed: false, wickOnly: false };
}

export function evaluateAuthoritativeClosedBreakout(input: Readonly<{
    closedClose: number | null;
    boundary: number;
    lastPrice: number;
}>): Readonly<{ confirmed: boolean; wickOnly: boolean }> {
    const { closedClose, boundary, lastPrice } = input;
    if (boundary <= 0 || closedClose == null || !Number.isFinite(closedClose)) {
        return { confirmed: false, wickOnly: false };
    }
    if (closedClose > boundary) {
        return { confirmed: true, wickOnly: false };
    }
    if (lastPrice > boundary) {
        return { confirmed: false, wickOnly: true };
    }
    return { confirmed: false, wickOnly: false };
}

function shortBreakdownStructureConfirmed(ctx: RangeBoundaryContinuationContext): boolean {
    if (normalizeBreakSide(ctx.boxBreakSide) === "lower") return true;
    if (ctx.judgmentSubtype === "BREAKDOWN_RETEST_FAILED") return true;
    if (ctx.rangePhase === "BREAKDOWN" || ctx.rangePhase === "BREAKDOWN_OBSERVATION") return true;
    if (ctx.continuationDirection === "down") return true;
    const boundary = breakdownBoundary(ctx);
    return evaluateAuthoritativeClosedBreakdown({
        closedClose: ctx.closedClose,
        boundary,
        lastPrice: ctx.lastPrice
    }).confirmed;
}

function longBreakoutStructureConfirmed(ctx: RangeBoundaryContinuationContext): boolean {
    if (normalizeBreakSide(ctx.boxBreakSide) === "upper") return true;
    if (
        ctx.judgmentSubtype === "BREAKOUT_RETEST_CONFIRMED" ||
        ctx.judgmentSubtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME"
    ) {
        return true;
    }
    if (
        ctx.rangePhase === "BREAKOUT" ||
        ctx.rangePhase === "BREAKOUT_OBSERVATION" ||
        ctx.rangePhase === "BREAKOUT_RETEST_CONFIRMED_VOLUME" ||
        ctx.rangePhase === "VOLUME_BREAKOUT_OBSERVATION" ||
        ctx.rangePhase === "VOLUME_SHOCK_UP"
    ) {
        return true;
    }
    if (ctx.continuationDirection === "up") return true;
    const boundary = breakoutBoundary(ctx);
    return evaluateAuthoritativeClosedBreakout({
        closedClose: ctx.closedClose,
        boundary,
        lastPrice: ctx.lastPrice
    }).confirmed;
}

function shortBreakdownRetestConfirmed(ctx: RangeBoundaryContinuationContext): boolean {
    if (ctx.judgmentSubtype === "BREAKDOWN_RETEST_FAILED") return true;
    if (ctx.retestConfirmed === true) return true;
    if (ctx.continuationPhase === "RETEST_CONFIRMED") return true;
    if (ctx.transitionPhase === "RETEST_CONFIRMED" && normalizeBreakSide(ctx.boxBreakSide) === "lower") {
        return true;
    }
    if (ctx.execReason === "BREAKDOWN_RETEST_SHORT_CONFIRMED") return true;
    if (ctx.retestTouched && ctx.retestRejected) return true;
    return false;
}

function longBreakoutRetestConfirmed(ctx: RangeBoundaryContinuationContext): boolean {
    if (
        ctx.judgmentSubtype === "BREAKOUT_RETEST_CONFIRMED" ||
        ctx.judgmentSubtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME"
    ) {
        return true;
    }
    if (ctx.retestConfirmed === true) return true;
    if (ctx.continuationPhase === "RETEST_CONFIRMED") return true;
    if (ctx.transitionPhase === "RETEST_CONFIRMED" && normalizeBreakSide(ctx.boxBreakSide) === "upper") {
        return true;
    }
    if (ctx.execReason === "BREAKOUT_RETEST_LONG_CONFIRMED") return true;
    if (ctx.retestTouched && ctx.retestRejected) return true;
    return false;
}

function htfAllowsShort(ctx: RangeBoundaryContinuationContext, strongConfirmationOk: boolean): boolean {
    const policy = String(ctx.htfEntryPolicy ?? "").trim().toUpperCase();
    if (policy === "LONG_ONLY_OR_NONE" || policy === "LONG_ONLY" || policy === "HOLD" || policy === "NEUTRAL_HTF_DATA_WAIT") return false;
    if (ctx.counterTrendRisk && ctx.htfRequiresStrongerConfirmation && !strongConfirmationOk) return false;
    if (ctx.htfRequiresStrongerConfirmation && !strongConfirmationOk) return false;
    return (
        policy === "SHORT_ONLY_OR_NONE" ||
        policy === "SHORT_ONLY" ||
        policy === "BOTH" ||
        policy === "ALLOW" ||
        policy === "PROBE_ONLY"
    );
}

function htfAllowsLong(ctx: RangeBoundaryContinuationContext, strongConfirmationOk: boolean): boolean {
    const policy = String(ctx.htfEntryPolicy ?? "").trim().toUpperCase();
    if (policy === "SHORT_ONLY_OR_NONE" || policy === "SHORT_ONLY" || policy === "HOLD" || policy === "NEUTRAL_HTF_DATA_WAIT") return false;
    if (ctx.counterTrendRisk && ctx.htfRequiresStrongerConfirmation && !strongConfirmationOk) return false;
    if (ctx.htfRequiresStrongerConfirmation && !strongConfirmationOk) return false;
    return (
        policy === "LONG_ONLY_OR_NONE" ||
        policy === "LONG_ONLY" ||
        policy === "BOTH" ||
        policy === "ALLOW" ||
        policy === "PROBE_ONLY"
    );
}

function applyExecutionGates(
    ctx: RangeBoundaryContinuationContext,
    side: "long" | "short"
): string | null {
    if (ctx.skipExecutionGate) return null;
    if (ctx.whipsawShockRecheckActive) return "WHIPSAW_SHOCK_RECHECK";
    if (!(side === "long" ? ctx.riskLongAllow && ctx.allowNewLong : ctx.riskShortAllow && ctx.allowNewShort)) {
        return side === "long" ? "LONG_NOT_ALLOWED" : "SHORT_NOT_ALLOWED";
    }
    if (ctx.hardBlockPresent) return "HARD_BLOCK_PRESENT";
    if (!ctx.paperExecutionReady || !ctx.signedExecutionReady) return "EXECUTION_NOT_READY";
    if (ctx.hasSameSidePosition || ctx.hasOppositeSidePosition) return "OPEN_POSITION_CONFLICT";
    return null;
}

export function evaluateShortContinuationEvidence(ctx: RangeBoundaryContinuationContext): {
    passed: boolean;
    reason: string | null;
    score: number;
    evidence: Record<string, unknown>;
} {
    const subtypeStr = String(ctx.judgmentSubtype ?? "").toUpperCase();
    const execReasonStr = String(ctx.execReason ?? "").toLowerCase();

    const isFtsShort =
        subtypeStr === "FAST_TREND_SHIFT" &&
        (ctx.fastTrendShift?.direction === "short" || ctx.trendSideCandidate === "short");
    const isContinuationLineage =
        isFtsShort ||
        subtypeStr === "EARLY_SHORT_PROBE" ||
        subtypeStr.includes("BREAKDOWN") ||
        subtypeStr.includes("CONTINUATION") ||
        subtypeStr.includes("TREND") ||
        execReasonStr.includes("trend") ||
        execReasonStr.includes("continuation") ||
        execReasonStr.includes("breakdown") ||
        execReasonStr.includes("fast_shift") ||
        ctx.continuationDirection === "down";

    if (!isContinuationLineage) {
        return { passed: false, reason: "NOT_CONTINUATION_LINEAGE", score: 0, evidence: { isContinuationLineage: false } };
    }

    if (ctx.trendSideCandidate !== "short") {
        return { passed: false, reason: "TREND_SIDE_NOT_SHORT", score: 0, evidence: { trendSideCandidate: ctx.trendSideCandidate } };
    }

    if (ctx.emaGap >= 0) {
        return { passed: false, reason: "EMA_GAP_NOT_NEGATIVE", score: 20, evidence: { emaGap: ctx.emaGap } };
    }

    if (ctx.opposingStrongHighway === true) {
        return { passed: false, reason: "OPPOSING_STRONG_HIGHWAY", score: 30, evidence: { opposingStrongHighway: true } };
    }

    if (ctx.directionalShock === "UP") {
        return { passed: false, reason: "OPPOSING_SHOCK_UP", score: 30, evidence: { directionalShock: ctx.directionalShock } };
    }

    const quality = ctx.qualityScore ?? 70;
    if (quality < 65) {
        return { passed: false, reason: "QUALITY_BELOW_THRESHOLD", score: quality, evidence: { qualityScore: quality } };
    }

    if (!htfAllowsShort(ctx, true)) {
        return { passed: false, reason: "HTF_POLICY_BLOCKS_SHORT", score: 50, evidence: { htfEntryPolicy: ctx.htfEntryPolicy } };
    }

    if (ctx.lateChaseBlocked) {
        return { passed: false, reason: "LATE_CHASE_BLOCKED", score: 50, evidence: { lateChaseBlocked: true } };
    }
    if (typeof ctx.boxPos === "number" && ctx.boxPos < -0.25) {
        return { passed: false, reason: "EXTREME_BOX_OVEREXTENSION_SHORT", score: 50, evidence: { boxPos: ctx.boxPos } };
    }

    if (ctx.candles && ctx.candles.length >= 2) {
        const lastCandle = ctx.candles[ctx.candles.length - 1];
        const prevCandle = ctx.candles[ctx.candles.length - 2];
        const lastIsMassiveBull = lastCandle.close > lastCandle.open && (lastCandle.close - lastCandle.open) > (lastCandle.high - lastCandle.low) * 0.85;
        if (lastIsMassiveBull && lastCandle.close > prevCandle.high) {
            return { passed: false, reason: "ADVERSE_CANDLE_MOMENTUM_UP", score: 50, evidence: { lastCandle, prevCandle } };
        }
    }

    return {
        passed: true,
        reason: null,
        score: Math.min(100, quality + 10),
        evidence: {
            isContinuationLineage,
            emaGap: ctx.emaGap,
            qualityScore: quality,
            htfEntryPolicy: ctx.htfEntryPolicy
        }
    };
}

export function evaluateLongContinuationEvidence(ctx: RangeBoundaryContinuationContext): {
    passed: boolean;
    reason: string | null;
    score: number;
    evidence: Record<string, unknown>;
} {
    const subtypeStr = String(ctx.judgmentSubtype ?? "").toUpperCase();
    const execReasonStr = String(ctx.execReason ?? "").toLowerCase();

    const isFtsLong =
        subtypeStr === "FAST_TREND_SHIFT" &&
        (ctx.fastTrendShift?.direction === "long" || ctx.trendSideCandidate === "long");
    const isContinuationLineage =
        isFtsLong ||
        subtypeStr === "EARLY_LONG_PROBE" ||
        subtypeStr.includes("BREAKOUT") ||
        subtypeStr.includes("CONTINUATION") ||
        subtypeStr.includes("TREND") ||
        execReasonStr.includes("trend") ||
        execReasonStr.includes("continuation") ||
        execReasonStr.includes("breakout") ||
        execReasonStr.includes("fast_shift") ||
        ctx.continuationDirection === "up";

    if (!isContinuationLineage) {
        return { passed: false, reason: "NOT_CONTINUATION_LINEAGE", score: 0, evidence: { isContinuationLineage: false } };
    }

    if (ctx.trendSideCandidate !== "long") {
        return { passed: false, reason: "TREND_SIDE_NOT_LONG", score: 0, evidence: { trendSideCandidate: ctx.trendSideCandidate } };
    }

    if (ctx.emaGap <= 0) {
        return { passed: false, reason: "EMA_GAP_NOT_POSITIVE", score: 20, evidence: { emaGap: ctx.emaGap } };
    }

    if (ctx.opposingStrongHighway === true) {
        return { passed: false, reason: "OPPOSING_STRONG_HIGHWAY", score: 30, evidence: { opposingStrongHighway: true } };
    }

    if (ctx.directionalShock === "DOWN") {
        return { passed: false, reason: "OPPOSING_SHOCK_DOWN", score: 30, evidence: { directionalShock: ctx.directionalShock } };
    }

    const quality = ctx.qualityScore ?? 70;
    if (quality < 65) {
        return { passed: false, reason: "QUALITY_BELOW_THRESHOLD", score: quality, evidence: { qualityScore: quality } };
    }

    if (!htfAllowsLong(ctx, true)) {
        return { passed: false, reason: "HTF_POLICY_BLOCKS_LONG", score: 50, evidence: { htfEntryPolicy: ctx.htfEntryPolicy } };
    }

    if (ctx.lateChaseBlocked) {
        return { passed: false, reason: "LATE_CHASE_BLOCKED", score: 50, evidence: { lateChaseBlocked: true } };
    }
    if (typeof ctx.boxPos === "number" && ctx.boxPos > 1.25) {
        return { passed: false, reason: "EXTREME_BOX_OVEREXTENSION_LONG", score: 50, evidence: { boxPos: ctx.boxPos } };
    }

    if (ctx.candles && ctx.candles.length >= 2) {
        const lastCandle = ctx.candles[ctx.candles.length - 1];
        const prevCandle = ctx.candles[ctx.candles.length - 2];
        const lastIsMassiveBear = lastCandle.close < lastCandle.open && (lastCandle.open - lastCandle.close) > (lastCandle.high - lastCandle.low) * 0.85;
        if (lastIsMassiveBear && lastCandle.close < prevCandle.low) {
            return { passed: false, reason: "ADVERSE_CANDLE_MOMENTUM_DOWN", score: 50, evidence: { lastCandle, prevCandle } };
        }
    }

    return {
        passed: true,
        reason: null,
        score: Math.min(100, quality + 10),
        evidence: {
            isContinuationLineage,
            emaGap: ctx.emaGap,
            qualityScore: quality,
            htfEntryPolicy: ctx.htfEntryPolicy
        }
    };
}

export function evaluateLowerBreakdownShortConfirmed(
    ctx: RangeBoundaryContinuationContext
): RangeBoundaryContinuationEval {
    const boundary = breakdownBoundary(ctx);
    const closedEval = evaluateAuthoritativeClosedBreakdown({
        closedClose: ctx.closedClose,
        boundary,
        lastPrice: ctx.lastPrice
    });
    const continuationEval = evaluateShortContinuationEvidence(ctx);
    const breakoutBreakdownSubstituted = continuationEval.passed;
    const structureOk = shortBreakdownStructureConfirmed(ctx) || breakoutBreakdownSubstituted;
    const retestOk = shortBreakdownRetestConfirmed(ctx) || breakoutBreakdownSubstituted;
    const evidence: Record<string, unknown> = {
        breakdownBoundary: boundary,
        boxBreakSide: normalizeBreakSide(ctx.boxBreakSide),
        closedBreakConfirmed: closedEval.confirmed || breakoutBreakdownSubstituted,
        wickOnlyBreak: closedEval.wickOnly && !breakoutBreakdownSubstituted,
        retestConfirmed: retestOk,
        continuationDirection: ctx.continuationDirection,
        continuationPhase: ctx.continuationPhase,
        continuationEvidence: continuationEval.evidence,
        breakoutBreakdownSubstituted
    };

    if (ctx.trendSideCandidate !== "short") {
        return {
            confirmed: false,
            holdReason: "TREND_SIDE_NOT_SHORT",
            wickOnlyBreak: closedEval.wickOnly,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    if (!structureOk) {
        return {
            confirmed: false,
            holdReason: "NO_BREAKDOWN_CONFIRMED",
            wickOnlyBreak: closedEval.wickOnly,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    if (closedEval.wickOnly && !breakoutBreakdownSubstituted) {
        return {
            confirmed: false,
            holdReason: "WICK_ONLY_BREAKDOWN",
            wickOnlyBreak: true,
            closedBreakConfirmed: false,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    if (!closedEval.confirmed && ctx.judgmentSubtype !== "BREAKDOWN_RETEST_FAILED" && !breakoutBreakdownSubstituted) {
        return {
            confirmed: false,
            holdReason: "CLOSED_CANDLE_BREAKDOWN_NOT_CONFIRMED",
            wickOnlyBreak: false,
            closedBreakConfirmed: false,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    if (!retestOk) {
        return {
            confirmed: false,
            holdReason: "BREAKDOWN_RETEST_NOT_CONFIRMED",
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: false,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    const strongConfirmationOk =
        normalizeBreakSide(ctx.boxBreakSide) === "lower" ||
        closedEval.confirmed ||
        ctx.judgmentSubtype === "BREAKDOWN_RETEST_FAILED" ||
        retestOk ||
        breakoutBreakdownSubstituted;

    if (!htfAllowsShort(ctx, strongConfirmationOk)) {
        return {
            confirmed: false,
            holdReason: "HTF_POLICY_BLOCKS_SHORT",
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    if (ctx.lateChaseBlocked && ctx.judgmentSubtype !== "BREAKDOWN_RETEST_FAILED" && !breakoutBreakdownSubstituted) {
        return {
            confirmed: false,
            holdReason: "LATE_CHASE_BLOCKED",
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    const executionGate = applyExecutionGates(ctx, "short");
    if (executionGate != null) {
        return {
            confirmed: false,
            holdReason: executionGate,
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    if (ctx.emaGap >= 0) {
        return {
            confirmed: false,
            holdReason: "EMA_GAP_NOT_NEGATIVE",
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    return {
        confirmed: true,
        holdReason: null,
        wickOnlyBreak: false,
        closedBreakConfirmed: closedEval.confirmed || breakoutBreakdownSubstituted,
        retestConfirmed: retestOk,
        continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
        continuationConfirmationPassed: continuationEval.passed,
        breakoutBreakdownSubstituted,
        continuationScore: continuationEval.score,
        evidence
    };
}

export function evaluateUpperBreakoutLongConfirmed(
    ctx: RangeBoundaryContinuationContext
): RangeBoundaryContinuationEval {
    const boundary = breakoutBoundary(ctx);
    const closedEval = evaluateAuthoritativeClosedBreakout({
        closedClose: ctx.closedClose,
        boundary,
        lastPrice: ctx.lastPrice
    });
    const continuationEval = evaluateLongContinuationEvidence(ctx);
    const breakoutBreakdownSubstituted = continuationEval.passed;
    const structureOk = longBreakoutStructureConfirmed(ctx) || breakoutBreakdownSubstituted;
    const retestOk = longBreakoutRetestConfirmed(ctx) || breakoutBreakdownSubstituted;
    const evidence: Record<string, unknown> = {
        breakoutBoundary: boundary,
        boxBreakSide: normalizeBreakSide(ctx.boxBreakSide),
        closedBreakConfirmed: closedEval.confirmed || breakoutBreakdownSubstituted,
        wickOnlyBreak: closedEval.wickOnly && !breakoutBreakdownSubstituted,
        retestConfirmed: retestOk,
        continuationDirection: ctx.continuationDirection,
        continuationPhase: ctx.continuationPhase,
        continuationEvidence: continuationEval.evidence,
        breakoutBreakdownSubstituted
    };

    if (ctx.trendSideCandidate !== "long") {
        return {
            confirmed: false,
            holdReason: "TREND_SIDE_NOT_LONG",
            wickOnlyBreak: closedEval.wickOnly,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    if (!structureOk) {
        return {
            confirmed: false,
            holdReason: "NO_BREAKOUT_CONFIRMED",
            wickOnlyBreak: closedEval.wickOnly,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    if (closedEval.wickOnly && !breakoutBreakdownSubstituted) {
        return {
            confirmed: false,
            holdReason: "WICK_ONLY_BREAKOUT",
            wickOnlyBreak: true,
            closedBreakConfirmed: false,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    if (
        !closedEval.confirmed &&
        ctx.judgmentSubtype !== "BREAKOUT_RETEST_CONFIRMED" &&
        ctx.judgmentSubtype !== "BREAKOUT_RETEST_CONFIRMED_VOLUME" &&
        !breakoutBreakdownSubstituted
    ) {
        return {
            confirmed: false,
            holdReason: "CLOSED_CANDLE_BREAKOUT_NOT_CONFIRMED",
            wickOnlyBreak: false,
            closedBreakConfirmed: false,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    if (!retestOk) {
        return {
            confirmed: false,
            holdReason: "BREAKOUT_RETEST_NOT_CONFIRMED",
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: false,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    const strongConfirmationOk =
        normalizeBreakSide(ctx.boxBreakSide) === "upper" ||
        closedEval.confirmed ||
        ctx.judgmentSubtype === "BREAKOUT_RETEST_CONFIRMED" ||
        ctx.judgmentSubtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME" ||
        retestOk ||
        breakoutBreakdownSubstituted;

    if (!htfAllowsLong(ctx, strongConfirmationOk)) {
        return {
            confirmed: false,
            holdReason: "HTF_POLICY_BLOCKS_LONG",
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    if (ctx.lateChaseBlocked && !retestOk && !breakoutBreakdownSubstituted) {
        return {
            confirmed: false,
            holdReason: "LATE_CHASE_BLOCKED",
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    const executionGate = applyExecutionGates(ctx, "long");
    if (executionGate != null) {
        return {
            confirmed: false,
            holdReason: executionGate,
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    if (ctx.emaGap <= 0) {
        return {
            confirmed: false,
            holdReason: "EMA_GAP_NOT_POSITIVE",
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
            continuationConfirmationPassed: continuationEval.passed,
            breakoutBreakdownSubstituted,
            continuationScore: continuationEval.score,
            evidence
        };
    }

    return {
        confirmed: true,
        holdReason: null,
        wickOnlyBreak: false,
        closedBreakConfirmed: closedEval.confirmed || breakoutBreakdownSubstituted,
        retestConfirmed: retestOk,
        continuationLineage: continuationEval.evidence.isContinuationLineage as boolean,
        continuationConfirmationPassed: continuationEval.passed,
        breakoutBreakdownSubstituted,
        continuationScore: continuationEval.score,
        evidence
    };
}

/** Lower reversal long eligibility stays separate from breakdown continuation short. */
export function isLowerReversalLongCandidate(ctx: RangeBoundaryContinuationContext): boolean {
    return (
        ctx.trendSideCandidate === "long" &&
        ctx.zone === "lower" &&
        ctx.reversalConfirmed === true
    );
}

/** Upper failure / reversal short stays separate from breakout continuation long. */
export function isUpperReversalShortCandidate(ctx: RangeBoundaryContinuationContext): boolean {
    return (
        ctx.trendSideCandidate === "short" &&
        ctx.zone === "upper" &&
        ctx.reversalConfirmed === true
    );
}
