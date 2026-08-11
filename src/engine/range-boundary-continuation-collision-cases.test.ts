import { readFileSync } from "node:fs";
import { join } from "node:path";
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

function assertIncludes(source: string, needle: string, label: string): void {
    if (!source.includes(needle)) {
        throw new Error(`${label}: expected source to include ${needle}`);
    }
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

type PromoDecision = "ENTER" | "HOLD" | "SKIP" | "REJECT";
type PromoSide = "long" | "short" | "none";

type PromotionCycleState = Readonly<{
    promotionApplied: boolean;
    v2Decision: PromoDecision;
    v2Side: PromoSide;
    promotionReason: string | null;
}>;

/** Mirrors index.ts promotion ordering for RANGE boundary continuation collision audit. */
function simulatePromotionCycle(input: Readonly<{
    lowerShortContinuationEligible: boolean;
    upperLongProbeEligible: boolean;
    upperLongContinuationConfirmed: boolean;
    transitionWatchShortConditionsMet: boolean;
    whipsawShockRecheckActive: boolean;
    hardBlockPresent: boolean;
    localConflictUpperZone: boolean;
    rangeSideCandidate: PromoSide;
    trendSideCandidate: PromoSide;
    upperBreakoutHold: boolean;
    zoneWouldHitFallback?: boolean;
}>): PromotionCycleState {
    let promotionApplied = false;
    let v2Decision: PromoDecision = "HOLD";
    let v2Side: PromoSide = "none";
    let promotionReason: string | null = null;

    const trendPromotionBlockApplies =
        !input.whipsawShockRecheckActive &&
        input.trendSideCandidate !== "none" &&
        !promotionApplied;

    if (trendPromotionBlockApplies) {
        if (
            input.upperLongProbeEligible &&
            input.upperLongContinuationConfirmed
        ) {
            v2Decision = "ENTER";
            v2Side = "long";
            promotionApplied = true;
            promotionReason = "V2_UPPER_LONG_PROBE_PROMOTION";
        } else if (
            !promotionApplied &&
            input.lowerShortContinuationEligible &&
            input.trendSideCandidate === "short"
        ) {
            v2Decision = "ENTER";
            v2Side = "short";
            promotionApplied = true;
            promotionReason = "V2_LOWER_SHORT_BREAKDOWN_CONTINUATION_PROMOTION";
        } else if (
            input.trendSideCandidate === "short" &&
            input.zoneWouldHitFallback === true
        ) {
            // fallback branch only when dedicated branches did not match
            v2Decision = "HOLD";
            promotionReason = null;
        }
    }

    const transitionAllowedDecision = (
        ["HOLD", "SKIP", "REJECT"] as const
    ).includes(v2Decision as "HOLD" | "SKIP" | "REJECT");
    if (
        input.transitionWatchShortConditionsMet &&
        transitionAllowedDecision &&
        !input.whipsawShockRecheckActive &&
        !input.hardBlockPresent
    ) {
        v2Decision = "ENTER";
        v2Side = "short";
        promotionApplied = true;
        promotionReason = "V2_TRANSITION_WATCH_SHORT_PROBE";
    }

    if (
        input.localConflictUpperZone &&
        input.rangeSideCandidate !== "none" &&
        input.trendSideCandidate !== "none" &&
        input.rangeSideCandidate !== input.trendSideCandidate
    ) {
        const continuationProtected =
            promotionApplied === true &&
            promotionReason === "V2_UPPER_LONG_PROBE_PROMOTION";
        if (
            !continuationProtected &&
            input.trendSideCandidate === "long" &&
            !input.upperBreakoutHold
        ) {
            v2Decision = "SKIP";
            v2Side = "none";
            promotionApplied = false;
            promotionReason = null;
        }
    }

    if (input.hardBlockPresent && promotionApplied) {
        v2Decision = "HOLD";
        v2Side = "none";
        promotionApplied = false;
        promotionReason = null;
    }

    if (input.whipsawShockRecheckActive) {
        v2Decision = "HOLD";
        promotionApplied = false;
        promotionReason = null;
    }

    return { promotionApplied, v2Decision, v2Side, promotionReason };
}

// --- Collision 1: lower breakdown short + transition watch short → single authority ---
{
    const lowerShortCtx = baseCtx({
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
    });
    const lowerConfirmed = evaluateLowerBreakdownShortConfirmed(lowerShortCtx).confirmed;
    assertTrue(lowerConfirmed, "collision1 lower breakdown confirmed");

    const transitionMet =
        lowerConfirmed &&
        !lowerShortCtx.whipsawShockRecheckActive &&
        lowerShortCtx.riskShortAllow &&
        lowerShortCtx.allowNewShort &&
        lowerShortCtx.emaGap < 0 &&
        !lowerShortCtx.hardBlockPresent;

    const result = simulatePromotionCycle({
        lowerShortContinuationEligible: lowerConfirmed,
        upperLongProbeEligible: false,
        upperLongContinuationConfirmed: false,
        transitionWatchShortConditionsMet: transitionMet,
        whipsawShockRecheckActive: false,
        hardBlockPresent: false,
        localConflictUpperZone: false,
        rangeSideCandidate: "short",
        trendSideCandidate: "short",
        upperBreakoutHold: false,
        zoneWouldHitFallback: false
    });

    assertTrue(result.promotionApplied, "collision1 promotion applied");
    assertEq(result.v2Decision, "ENTER", "collision1 decision ENTER");
    assertEq(result.v2Side, "short", "collision1 side short");
    assertEq(
        result.promotionReason,
        "V2_LOWER_SHORT_BREAKDOWN_CONTINUATION_PROMOTION",
        "collision1 continuation wins over transition watch"
    );
}

// --- Collision 2: upper breakout long + upper probe gate → single promotion path ---
{
    const upperLongCtx = baseCtx({
        trendSideCandidate: "long",
        zone: "upper",
        boxBreakSide: "upper",
        closedClose: 110.5,
        lastPrice: 110.6,
        judgmentSubtype: "BREAKOUT_RETEST_CONFIRMED",
        retestConfirmed: true,
        retestTouched: true,
        retestRejected: true,
        emaGap: 0.02,
        htfEntryPolicy: "LONG_ONLY_OR_NONE"
    });
    const upperConfirmed = evaluateUpperBreakoutLongConfirmed(upperLongCtx).confirmed;
    assertTrue(upperConfirmed, "collision2 upper breakout confirmed");

    const result = simulatePromotionCycle({
        lowerShortContinuationEligible: false,
        upperLongProbeEligible: true,
        upperLongContinuationConfirmed: upperConfirmed,
        transitionWatchShortConditionsMet: false,
        whipsawShockRecheckActive: false,
        hardBlockPresent: false,
        localConflictUpperZone: true,
        rangeSideCandidate: "short",
        trendSideCandidate: "long",
        upperBreakoutHold: false,
        zoneWouldHitFallback: false
    });

    assertTrue(result.promotionApplied, "collision2 promotion preserved under local conflict");
    assertEq(result.v2Decision, "ENTER", "collision2 decision ENTER");
    assertEq(result.v2Side, "long", "collision2 side long");
    assertEq(result.promotionReason, "V2_UPPER_LONG_PROBE_PROMOTION", "collision2 single upper-long path");
}

// --- Collision 3: continuation vs reversal evidence → mutually exclusive by side ---
{
    const sharedEvidence = baseCtx({
        zone: "lower",
        boxBreakSide: "lower",
        closedClose: 99.5,
        lastPrice: 99.4,
        judgmentSubtype: "BREAKDOWN_RETEST_FAILED",
        retestConfirmed: true,
        retestTouched: true,
        retestRejected: true,
        emaGap: -0.02,
        reversalConfirmed: true
    });

    const shortContinuation = evaluateLowerBreakdownShortConfirmed({
        ...sharedEvidence,
        trendSideCandidate: "short"
    });
    const longReversal = isLowerReversalLongCandidate({
        ...sharedEvidence,
        trendSideCandidate: "long"
    });

    assertTrue(shortContinuation.confirmed, "collision3 lower short continuation");
    assertTrue(longReversal, "collision3 lower long reversal candidate");
    assertFalse(
        shortContinuation.confirmed &&
            isLowerReversalLongCandidate({ ...sharedEvidence, trendSideCandidate: "short" }),
        "collision3 short continuation excludes lower reversal long on same side candidate"
    );
    assertFalse(
        evaluateLowerBreakdownShortConfirmed({ ...sharedEvidence, trendSideCandidate: "long" }).confirmed &&
            longReversal,
        "collision3 long reversal excludes lower breakdown short on same side candidate"
    );
}

{
    const sharedEvidence = baseCtx({
        zone: "upper",
        boxBreakSide: "upper",
        closedClose: 110.5,
        lastPrice: 110.6,
        judgmentSubtype: "BREAKOUT_RETEST_CONFIRMED",
        retestConfirmed: true,
        retestTouched: true,
        retestRejected: true,
        emaGap: 0.02,
        htfEntryPolicy: "LONG_ONLY_OR_NONE",
        reversalConfirmed: true
    });

    const longContinuation = evaluateUpperBreakoutLongConfirmed({
        ...sharedEvidence,
        trendSideCandidate: "long"
    });
    const shortReversal = isUpperReversalShortCandidate({
        ...sharedEvidence,
        trendSideCandidate: "short"
    });

    assertTrue(longContinuation.confirmed, "collision3 upper long continuation");
    assertTrue(shortReversal, "collision3 upper short reversal candidate");
    assertFalse(
        longContinuation.confirmed &&
            isUpperReversalShortCandidate({ ...sharedEvidence, trendSideCandidate: "long" }),
        "collision3 long continuation excludes upper reversal short on same side candidate"
    );
    assertFalse(
        evaluateUpperBreakoutLongConfirmed({ ...sharedEvidence, trendSideCandidate: "short" }).confirmed &&
            shortReversal,
        "collision3 short reversal excludes upper breakout long on same side candidate"
    );
}

// --- Collision 4: promotion success → fallback must not overwrite (structural) ---
{
    const indexTs = readFileSync(join(__dirname, "../../src/engine-v2/index.ts"), "utf8");
    assertIncludes(
        indexTs,
        "V2_LOWER_SHORT_BREAKDOWN_CONTINUATION_PROMOTION",
        "collision4 lower short promotion reason present"
    );
    assertTrue(
        /!promotionApplied &&[\s\S]{0,80}trendSideCandidate === "short"/.test(indexTs),
        "collision4 lower short branch guarded by !promotionApplied"
    );
    assertIncludes(
        indexTs,
        "(v2DecisionAfterPromotion === \"HOLD\" || v2DecisionAfterPromotion === \"SKIP\" || v2DecisionAfterPromotion === \"REJECT\")",
        "collision4 transition watch excludes prior ENTER"
    );
    const lowerPromoIdx = indexTs.indexOf("V2_LOWER_SHORT_BREAKDOWN_CONTINUATION_PROMOTION");
    const fallbackHoldIdx = indexTs.indexOf("lowerShortFallbackEval = evaluateLowerBreakdownShortConfirmed");
    assertTrue(lowerPromoIdx > 0 && fallbackHoldIdx > 0, "collision4 indices found");
    assertTrue(
        lowerPromoIdx < fallbackHoldIdx,
        "collision4 dedicated promotion precedes fallback HOLD eval"
    );
}

// --- Collision 5: promotion success cycle → single execution authority key ---
{
    const indexTs = readFileSync(join(__dirname, "../../src/engine-v2/index.ts"), "utf8");
    assertIncludes(indexTs, "trendPromotionBlockApplies =", "collision5 trend promotion gate");
    assertIncludes(indexTs, "!promotionApplied &&", "collision5 promotionApplied guard");
    assertIncludes(
        indexTs,
        "const isLiveSignedOrderAttempt =",
        "collision5 single signed submit gate"
    );
    assertIncludes(
        indexTs,
        'executionAction === "ENTER" || executionAction === "ADDON"',
        "collision5 one execution action branch"
    );
}

// --- Collision 6: WHIPSAW / HTF / hard block outrank continuation ---
{
    const confirmedCtx = baseCtx({
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
    });
    assertTrue(
        evaluateLowerBreakdownShortConfirmed(confirmedCtx).confirmed,
        "collision6 baseline lower short confirmed"
    );

    const whipsawBlocked = evaluateLowerBreakdownShortConfirmed({
        ...confirmedCtx,
        whipsawShockRecheckActive: true
    });
    assertFalse(whipsawBlocked.confirmed, "collision6 whipsaw blocks continuation");
    assertEq(whipsawBlocked.holdReason, "WHIPSAW_SHOCK_RECHECK", "collision6 whipsaw reason");

    const htfBlocked = evaluateLowerBreakdownShortConfirmed({
        ...confirmedCtx,
        htfEntryPolicy: "LONG_ONLY_OR_NONE"
    });
    assertFalse(htfBlocked.confirmed, "collision6 HTF long-only blocks short continuation");
    assertEq(htfBlocked.holdReason, "HTF_POLICY_BLOCKS_SHORT", "collision6 HTF reason");

    const hardBlocked = evaluateLowerBreakdownShortConfirmed({
        ...confirmedCtx,
        hardBlockPresent: true
    });
    assertFalse(hardBlocked.confirmed, "collision6 hard block stops continuation");
    assertEq(hardBlocked.holdReason, "HARD_BLOCK_PRESENT", "collision6 hard block reason");

    const upperCtx = baseCtx({
        trendSideCandidate: "long",
        zone: "upper",
        boxBreakSide: "upper",
        closedClose: 110.5,
        lastPrice: 110.6,
        judgmentSubtype: "BREAKOUT_RETEST_CONFIRMED",
        retestConfirmed: true,
        retestTouched: true,
        retestRejected: true,
        emaGap: 0.02,
        htfEntryPolicy: "LONG_ONLY_OR_NONE"
    });
    assertTrue(
        evaluateUpperBreakoutLongConfirmed(upperCtx).confirmed,
        "collision6 baseline upper long confirmed"
    );
    const upperHtfBlocked = evaluateUpperBreakoutLongConfirmed({
        ...upperCtx,
        htfEntryPolicy: "SHORT_ONLY_OR_NONE"
    });
    assertFalse(upperHtfBlocked.confirmed, "collision6 HTF short-only blocks long continuation");
    assertEq(upperHtfBlocked.holdReason, "HTF_POLICY_BLOCKS_LONG", "collision6 upper HTF reason");
}

// --- Collision 7: symmetric lower/upper — transition watch cannot double-promote when continuation already ENTER ---
{
    for (const side of ["short", "long"] as const) {
        const isShort = side === "short";
        const result = simulatePromotionCycle({
            lowerShortContinuationEligible: isShort,
            upperLongProbeEligible: !isShort,
            upperLongContinuationConfirmed: !isShort,
            transitionWatchShortConditionsMet: isShort,
            whipsawShockRecheckActive: false,
            hardBlockPresent: false,
            localConflictUpperZone: !isShort,
            rangeSideCandidate: isShort ? "short" : "short",
            trendSideCandidate: side,
            upperBreakoutHold: false,
            zoneWouldHitFallback: false
        });
        assertEq(result.v2Decision, "ENTER", `collision7 symmetric ${side} ENTER`);
        assertTrue(result.promotionApplied, `collision7 symmetric ${side} single promotion`);
        assertEq(result.v2Side, side, `collision7 symmetric ${side} side`);
    }
}

// --- Collision 8: conflict resolution must not undo confirmed upper-long continuation ---
{
    const indexTs = readFileSync(join(__dirname, "../../src/engine-v2/index.ts"), "utf8");
    assertIncludes(
        indexTs,
        "V2_UPPER_LONG_PROBE_PROMOTION",
        "collision8 upper long promotion reason"
    );
    assertIncludes(
        indexTs,
        "continuationPromotionProtected",
        "collision8 conflict resolution protects confirmed upper-long continuation"
    );
}

console.log("range-boundary-continuation-collision-cases: ALL PASS");
