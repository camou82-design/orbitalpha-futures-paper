export type RangeBoundarySide = "long" | "short" | "none";

export type RangeBoundaryContinuationEval = Readonly<{
    confirmed: boolean;
    holdReason: string | null;
    wickOnlyBreak: boolean;
    closedBreakConfirmed: boolean;
    retestConfirmed: boolean;
    evidence: Record<string, unknown>;
}>;

export type RangeBoundaryContinuationContext = Readonly<{
    trendSideCandidate: RangeBoundarySide;
    zone: "lower" | "mid" | "upper";
    boxBreakSide: string;
    boxLow: number;
    boxHigh: number;
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
    if (policy === "LONG_ONLY_OR_NONE" || policy === "LONG_ONLY" || policy === "HOLD") return false;
    if (ctx.counterTrendRisk && ctx.htfRequiresStrongerConfirmation && !strongConfirmationOk) return false;
    if (ctx.htfRequiresStrongerConfirmation && !strongConfirmationOk) return false;
    return (
        policy === "SHORT_ONLY_OR_NONE" ||
        policy === "SHORT_ONLY" ||
        policy === "BOTH" ||
        policy === "ALLOW" ||
        policy === "PROBE_ONLY" ||
        policy === "NEUTRAL_HTF_DATA_WAIT"
    );
}

function htfAllowsLong(ctx: RangeBoundaryContinuationContext, strongConfirmationOk: boolean): boolean {
    const policy = String(ctx.htfEntryPolicy ?? "").trim().toUpperCase();
    if (policy === "SHORT_ONLY_OR_NONE" || policy === "SHORT_ONLY" || policy === "HOLD") return false;
    if (ctx.counterTrendRisk && ctx.htfRequiresStrongerConfirmation && !strongConfirmationOk) return false;
    if (ctx.htfRequiresStrongerConfirmation && !strongConfirmationOk) return false;
    return (
        policy === "LONG_ONLY_OR_NONE" ||
        policy === "LONG_ONLY" ||
        policy === "BOTH" ||
        policy === "ALLOW" ||
        policy === "PROBE_ONLY" ||
        policy === "NEUTRAL_HTF_DATA_WAIT"
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

export function evaluateLowerBreakdownShortConfirmed(
    ctx: RangeBoundaryContinuationContext
): RangeBoundaryContinuationEval {
    const boundary = breakdownBoundary(ctx);
    const closedEval = evaluateAuthoritativeClosedBreakdown({
        closedClose: ctx.closedClose,
        boundary,
        lastPrice: ctx.lastPrice
    });
    const structureOk = shortBreakdownStructureConfirmed(ctx);
    const retestOk = shortBreakdownRetestConfirmed(ctx);
    const evidence: Record<string, unknown> = {
        breakdownBoundary: boundary,
        boxBreakSide: normalizeBreakSide(ctx.boxBreakSide),
        closedBreakConfirmed: closedEval.confirmed,
        wickOnlyBreak: closedEval.wickOnly,
        retestConfirmed: retestOk,
        continuationDirection: ctx.continuationDirection,
        continuationPhase: ctx.continuationPhase
    };

    if (ctx.trendSideCandidate !== "short") {
        return {
            confirmed: false,
            holdReason: "TREND_SIDE_NOT_SHORT",
            wickOnlyBreak: closedEval.wickOnly,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
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
            evidence
        };
    }

    if (closedEval.wickOnly) {
        return {
            confirmed: false,
            holdReason: "WICK_ONLY_BREAKDOWN",
            wickOnlyBreak: true,
            closedBreakConfirmed: false,
            retestConfirmed: retestOk,
            evidence
        };
    }

    if (!closedEval.confirmed && ctx.judgmentSubtype !== "BREAKDOWN_RETEST_FAILED") {
        return {
            confirmed: false,
            holdReason: "CLOSED_CANDLE_BREAKDOWN_NOT_CONFIRMED",
            wickOnlyBreak: false,
            closedBreakConfirmed: false,
            retestConfirmed: retestOk,
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
            evidence
        };
    }

    const strongConfirmationOk =
        normalizeBreakSide(ctx.boxBreakSide) === "lower" ||
        closedEval.confirmed ||
        ctx.judgmentSubtype === "BREAKDOWN_RETEST_FAILED" ||
        retestOk;

    if (!htfAllowsShort(ctx, strongConfirmationOk)) {
        return {
            confirmed: false,
            holdReason: "HTF_POLICY_BLOCKS_SHORT",
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            evidence
        };
    }

    if (ctx.lateChaseBlocked && ctx.judgmentSubtype !== "BREAKDOWN_RETEST_FAILED") {
        return {
            confirmed: false,
            holdReason: "LATE_CHASE_BLOCKED",
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
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
            evidence
        };
    }

    return {
        confirmed: true,
        holdReason: null,
        wickOnlyBreak: false,
        closedBreakConfirmed: closedEval.confirmed,
        retestConfirmed: retestOk,
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
    const structureOk = longBreakoutStructureConfirmed(ctx);
    const retestOk = longBreakoutRetestConfirmed(ctx);
    const evidence: Record<string, unknown> = {
        breakoutBoundary: boundary,
        boxBreakSide: normalizeBreakSide(ctx.boxBreakSide),
        closedBreakConfirmed: closedEval.confirmed,
        wickOnlyBreak: closedEval.wickOnly,
        retestConfirmed: retestOk,
        continuationDirection: ctx.continuationDirection,
        continuationPhase: ctx.continuationPhase
    };

    if (ctx.trendSideCandidate !== "long") {
        return {
            confirmed: false,
            holdReason: "TREND_SIDE_NOT_LONG",
            wickOnlyBreak: closedEval.wickOnly,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
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
            evidence
        };
    }

    if (closedEval.wickOnly) {
        return {
            confirmed: false,
            holdReason: "WICK_ONLY_BREAKOUT",
            wickOnlyBreak: true,
            closedBreakConfirmed: false,
            retestConfirmed: retestOk,
            evidence
        };
    }

    if (
        !closedEval.confirmed &&
        ctx.judgmentSubtype !== "BREAKOUT_RETEST_CONFIRMED" &&
        ctx.judgmentSubtype !== "BREAKOUT_RETEST_CONFIRMED_VOLUME"
    ) {
        return {
            confirmed: false,
            holdReason: "CLOSED_CANDLE_BREAKOUT_NOT_CONFIRMED",
            wickOnlyBreak: false,
            closedBreakConfirmed: false,
            retestConfirmed: retestOk,
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
            evidence
        };
    }

    const strongConfirmationOk =
        normalizeBreakSide(ctx.boxBreakSide) === "upper" ||
        closedEval.confirmed ||
        ctx.judgmentSubtype === "BREAKOUT_RETEST_CONFIRMED" ||
        ctx.judgmentSubtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME" ||
        retestOk;

    if (!htfAllowsLong(ctx, strongConfirmationOk)) {
        return {
            confirmed: false,
            holdReason: "HTF_POLICY_BLOCKS_LONG",
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
            evidence
        };
    }

    if (ctx.lateChaseBlocked && !retestOk) {
        return {
            confirmed: false,
            holdReason: "LATE_CHASE_BLOCKED",
            wickOnlyBreak: false,
            closedBreakConfirmed: closedEval.confirmed,
            retestConfirmed: retestOk,
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
            evidence
        };
    }

    return {
        confirmed: true,
        holdReason: null,
        wickOnlyBreak: false,
        closedBreakConfirmed: closedEval.confirmed,
        retestConfirmed: retestOk,
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
