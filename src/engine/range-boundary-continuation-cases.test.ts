import {
    evaluateLowerBreakdownShortConfirmed,
    evaluateUpperBreakoutLongConfirmed,
    isLowerReversalLongCandidate,
    isUpperReversalShortCandidate,
    type RangeBoundaryContinuationContext
} from "../engine-v2/range-boundary-continuation";

function assertTrue(v: boolean, label: string): void {
    if (!v) throw new Error(`${label}: expected true`);
}

function assertFalse(v: boolean, label: string): void {
    if (v) throw new Error(`${label}: expected false`);
}

function assertEq<T>(a: T, b: T, label: string): void {
    if (a !== b) throw new Error(`${label}: expected ${String(b)}, got ${String(a)}`);
}

function baseCtx(
    overrides: Partial<RangeBoundaryContinuationContext> = {}
): RangeBoundaryContinuationContext {
    return {
        trendSideCandidate: "none",
        zone: "lower",
        boxBreakSide: "none",
        boxLow: 100,
        boxHigh: 110,
        closedClose: 101,
        lastPrice: 101,
        previousConfirmedBoxLow: 100,
        previousConfirmedBoxHigh: 110,
        emaGap: -0.01,
        htfEntryPolicy: "SHORT_ONLY_OR_NONE",
        htfRequiresStrongerConfirmation: false,
        counterTrendRisk: false,
        riskLongAllow: true,
        riskShortAllow: true,
        allowNewLong: true,
        allowNewShort: true,
        whipsawShockRecheckActive: false,
        hardBlockPresent: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: false,
        judgmentSubtype: "",
        rangePhase: null,
        transitionPhase: null,
        continuationDirection: null,
        continuationPhase: null,
        retestConfirmed: false,
        retestTouched: false,
        retestRejected: false,
        reversalConfirmed: false,
        execReason: null,
        lateChaseBlocked: false,
        retestRequired: false,
        ...overrides
    };
}

// 1. lower short, no breakdown → HOLD
{
    const evalResult = evaluateLowerBreakdownShortConfirmed(
        baseCtx({
            trendSideCandidate: "short",
            zone: "lower",
            boxBreakSide: "none",
            closedClose: 101,
            lastPrice: 101,
            emaGap: -0.01
        })
    );
    assertFalse(evalResult.confirmed, "lower no breakdown confirmed");
    assertEq(evalResult.holdReason, "NO_BREAKDOWN_CONFIRMED", "lower no breakdown hold");
}

// 2. lower short, wick-only breakdown → HOLD
{
    const evalResult = evaluateLowerBreakdownShortConfirmed(
        baseCtx({
            trendSideCandidate: "short",
            zone: "lower",
            boxBreakSide: "lower",
            closedClose: 100.5,
            lastPrice: 99.5,
            retestConfirmed: true,
            judgmentSubtype: "BREAKDOWN_RETEST_FAILED"
        })
    );
    assertFalse(evalResult.confirmed, "wick-only not confirmed");
    assertTrue(evalResult.wickOnlyBreak, "wick-only flagged");
    assertEq(evalResult.holdReason, "WICK_ONLY_BREAKDOWN", "wick-only hold");
}

// 3. lower short, confirmed breakdown + retest → promotion eligible
{
    const evalResult = evaluateLowerBreakdownShortConfirmed(
        baseCtx({
            trendSideCandidate: "short",
            zone: "lower",
            boxBreakSide: "lower",
            closedClose: 99.5,
            lastPrice: 99.4,
            judgmentSubtype: "BREAKDOWN_RETEST_FAILED",
            retestConfirmed: true,
            retestTouched: true,
            retestRejected: true,
            emaGap: -0.02
        })
    );
    assertTrue(evalResult.confirmed, "lower confirmed breakdown + retest");
    assertTrue(evalResult.closedBreakConfirmed, "closed breakdown confirmed");
    assertTrue(evalResult.retestConfirmed, "retest confirmed");
}

// 4. upper long, no breakout → HOLD
{
    const evalResult = evaluateUpperBreakoutLongConfirmed(
        baseCtx({
            trendSideCandidate: "long",
            zone: "upper",
            boxBreakSide: "none",
            closedClose: 109,
            lastPrice: 109,
            emaGap: 0.01
        })
    );
    assertFalse(evalResult.confirmed, "upper no breakout confirmed");
    assertEq(evalResult.holdReason, "NO_BREAKOUT_CONFIRMED", "upper no breakout hold");
}

// 5. upper long, wick-only breakout → HOLD
{
    const evalResult = evaluateUpperBreakoutLongConfirmed(
        baseCtx({
            trendSideCandidate: "long",
            zone: "upper",
            boxBreakSide: "upper",
            closedClose: 109.5,
            lastPrice: 110.5,
            retestConfirmed: true,
            judgmentSubtype: "BREAKOUT_RETEST_CONFIRMED"
        })
    );
    assertFalse(evalResult.confirmed, "wick-only breakout not confirmed");
    assertTrue(evalResult.wickOnlyBreak, "wick-only breakout flagged");
    assertEq(evalResult.holdReason, "WICK_ONLY_BREAKOUT", "wick-only breakout hold");
}

// 6. upper long, confirmed breakout + retest → promotion eligible
{
    const evalResult = evaluateUpperBreakoutLongConfirmed(
        baseCtx({
            trendSideCandidate: "long",
            zone: "upper",
            boxBreakSide: "upper",
            closedClose: 110.5,
            lastPrice: 110.6,
            htfEntryPolicy: "LONG_ONLY_OR_NONE",
            judgmentSubtype: "BREAKOUT_RETEST_CONFIRMED",
            retestConfirmed: true,
            retestTouched: true,
            retestRejected: true,
            emaGap: 0.02
        })
    );
    assertTrue(evalResult.confirmed, "upper confirmed breakout + retest");
    assertTrue(evalResult.closedBreakConfirmed, "closed breakout confirmed");
    assertTrue(evalResult.retestConfirmed, "breakout retest confirmed");
}

// 7. confirmed continuation but WHIPSAW hard recheck → HOLD
{
    const lowerBlocked = evaluateLowerBreakdownShortConfirmed(
        baseCtx({
            trendSideCandidate: "short",
            boxBreakSide: "lower",
            closedClose: 99.5,
            lastPrice: 99.4,
            judgmentSubtype: "BREAKDOWN_RETEST_FAILED",
            retestConfirmed: true,
            whipsawShockRecheckActive: true,
            emaGap: -0.02
        })
    );
    assertFalse(lowerBlocked.confirmed, "lower whipsaw blocked");
    assertEq(lowerBlocked.holdReason, "WHIPSAW_SHOCK_RECHECK", "lower whipsaw reason");

    const upperBlocked = evaluateUpperBreakoutLongConfirmed(
        baseCtx({
            trendSideCandidate: "long",
            zone: "upper",
            boxBreakSide: "upper",
            closedClose: 110.5,
            lastPrice: 110.6,
            htfEntryPolicy: "LONG_ONLY_OR_NONE",
            judgmentSubtype: "BREAKOUT_RETEST_CONFIRMED",
            retestConfirmed: true,
            whipsawShockRecheckActive: true,
            emaGap: 0.02
        })
    );
    assertFalse(upperBlocked.confirmed, "upper whipsaw blocked");
    assertEq(upperBlocked.holdReason, "WHIPSAW_SHOCK_RECHECK", "upper whipsaw reason");
}

// 8. HTF opposite direction → HOLD
{
    const shortBlocked = evaluateLowerBreakdownShortConfirmed(
        baseCtx({
            trendSideCandidate: "short",
            boxBreakSide: "lower",
            closedClose: 99.5,
            lastPrice: 99.4,
            htfEntryPolicy: "LONG_ONLY_OR_NONE",
            judgmentSubtype: "BREAKDOWN_RETEST_FAILED",
            retestConfirmed: true,
            emaGap: -0.02
        })
    );
    assertFalse(shortBlocked.confirmed, "HTF long-only blocks short");
    assertEq(shortBlocked.holdReason, "HTF_POLICY_BLOCKS_SHORT", "HTF short block reason");

    const longBlocked = evaluateUpperBreakoutLongConfirmed(
        baseCtx({
            trendSideCandidate: "long",
            zone: "upper",
            boxBreakSide: "upper",
            closedClose: 110.5,
            lastPrice: 110.6,
            htfEntryPolicy: "SHORT_ONLY_OR_NONE",
            judgmentSubtype: "BREAKOUT_RETEST_CONFIRMED",
            retestConfirmed: true,
            emaGap: 0.02
        })
    );
    assertFalse(longBlocked.confirmed, "HTF short-only blocks long");
    assertEq(longBlocked.holdReason, "HTF_POLICY_BLOCKS_LONG", "HTF long block reason");
}

// 9. lower reversal long path remains separate (continuation short not confirmed for long reversal)
{
    const reversalCtx = baseCtx({
        trendSideCandidate: "long",
        zone: "lower",
        reversalConfirmed: true,
        boxBreakSide: "lower",
        closedClose: 99.5,
        retestConfirmed: true,
        emaGap: 0.01,
        htfEntryPolicy: "LONG_ONLY_OR_NONE"
    });
    assertTrue(isLowerReversalLongCandidate(reversalCtx), "lower reversal long candidate intact");
    const shortContinuation = evaluateLowerBreakdownShortConfirmed({
        ...reversalCtx,
        trendSideCandidate: "long"
    });
    assertFalse(shortContinuation.confirmed, "reversal long does not use breakdown short continuation");
    assertEq(shortContinuation.holdReason, "TREND_SIDE_NOT_SHORT", "reversal long side guard");
}

// 10. upper reversal short path remains separate
{
    const reversalCtx = baseCtx({
        trendSideCandidate: "short",
        zone: "upper",
        reversalConfirmed: true,
        boxBreakSide: "upper",
        closedClose: 110.5,
        retestConfirmed: true,
        emaGap: -0.01,
        htfEntryPolicy: "SHORT_ONLY_OR_NONE"
    });
    assertTrue(isUpperReversalShortCandidate(reversalCtx), "upper reversal short candidate intact");
    const longContinuation = evaluateUpperBreakoutLongConfirmed({
        ...reversalCtx,
        trendSideCandidate: "short"
    });
    assertFalse(longContinuation.confirmed, "reversal short does not use breakout long continuation");
    assertEq(longContinuation.holdReason, "TREND_SIDE_NOT_LONG", "reversal short side guard");
}

console.log("range-boundary-continuation-cases: ALL PASS");
