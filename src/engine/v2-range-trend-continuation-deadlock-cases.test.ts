import {
    evaluateLowerBreakdownShortConfirmed,
    evaluateUpperBreakoutLongConfirmed,
    type RangeBoundaryContinuationContext
} from "../engine-v2/range-boundary-continuation";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import type { Candle } from "../models/types";

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
        boxPos: 0.3,
        atr: 1.0,
        qualityScore: 75,
        candles: [
            { open: 105, high: 106, low: 102, close: 103 },
            { open: 103, high: 104, low: 101, close: 102 }
        ],
        fastTrendShift: null,
        opposingStrongHighway: false,
        directionalShock: "NONE",
        closedClose: 102,
        lastPrice: 102,
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

// =========================================================================
// TEST 1: Pure RANGE lower + short -> 기존대로 차단 (NO_BREAKDOWN_CONFIRMED)
// =========================================================================
{
    const pureRangeCtx = baseCtx({
        trendSideCandidate: "short",
        zone: "lower",
        boxBreakSide: "none",
        closedClose: 102,
        lastPrice: 102,
        judgmentSubtype: "RANGE_STABLE",
        fastTrendShift: null,
        emaGap: -0.01
    });
    const evalResult = evaluateLowerBreakdownShortConfirmed(pureRangeCtx);
    assertFalse(evalResult.confirmed, "Test 1: Pure RANGE lower short not confirmed");
    assertEq(evalResult.holdReason, "NO_BREAKDOWN_CONFIRMED", "Test 1: holdReason is NO_BREAKDOWN_CONFIRMED");
    assertFalse(evalResult.breakoutBreakdownSubstituted ?? false, "Test 1: not substituted");
    console.log("PASS: Test 1 - Pure RANGE lower short blocked as NO_BREAKDOWN_CONFIRMED");
}

// =========================================================================
// TEST 2: Pure RANGE upper + long -> 기존대로 차단 (NO_BREAKOUT_CONFIRMED)
// =========================================================================
{
    const pureRangeCtx = baseCtx({
        trendSideCandidate: "long",
        zone: "upper",
        boxBreakSide: "none",
        closedClose: 108,
        lastPrice: 108,
        judgmentSubtype: "RANGE_STABLE",
        fastTrendShift: null,
        emaGap: 0.01,
        htfEntryPolicy: "LONG_ONLY_OR_NONE",
        candles: [
            { open: 105, high: 107, low: 104, close: 106 },
            { open: 106, high: 109, low: 105, close: 108 }
        ]
    });
    const evalResult = evaluateUpperBreakoutLongConfirmed(pureRangeCtx);
    assertFalse(evalResult.confirmed, "Test 2: Pure RANGE upper long not confirmed");
    assertEq(evalResult.holdReason, "NO_BREAKOUT_CONFIRMED", "Test 2: holdReason is NO_BREAKOUT_CONFIRMED");
    assertFalse(evalResult.breakoutBreakdownSubstituted ?? false, "Test 2: not substituted");
    console.log("PASS: Test 2 - Pure RANGE upper long blocked as NO_BREAKOUT_CONFIRMED");
}

// =========================================================================
// TEST 3: FAST_TREND_SHIFT bearish + lower + strong continuation evidence -> short 허용
// =========================================================================
{
    const ftsBearishCtx = baseCtx({
        trendSideCandidate: "short",
        zone: "lower",
        boxBreakSide: "none",
        closedClose: 102,
        lastPrice: 102,
        judgmentSubtype: "FAST_TREND_SHIFT",
        fastTrendShift: {
            active: true,
            direction: "short",
            lower_high_detected: true,
            lower_low_detected: true,
            box_mid_lost: true
        },
        qualityScore: 78,
        emaGap: -0.015,
        htfEntryPolicy: "SHORT_ONLY_OR_NONE",
        candles: [
            { open: 106, high: 106.5, low: 103, close: 103.5 },
            { open: 103.5, high: 104, low: 101.8, close: 102 }
        ]
    });
    const evalResult = evaluateLowerBreakdownShortConfirmed(ftsBearishCtx);
    assertTrue(evalResult.confirmed, "Test 3: FTS bearish lower short confirmed");
    assertTrue(evalResult.breakoutBreakdownSubstituted ?? false, "Test 3: substituted by continuation");
    assertEq(evalResult.holdReason, null, "Test 3: holdReason is null");
    console.log("PASS: Test 3 - FAST_TREND_SHIFT bearish lower short confirmed via continuation substitution");
}

// =========================================================================
// TEST 4: FAST_TREND_SHIFT bullish + upper + strong continuation evidence -> long 허용
// =========================================================================
{
    const ftsBullishCtx = baseCtx({
        trendSideCandidate: "long",
        zone: "upper",
        boxBreakSide: "none",
        closedClose: 108,
        lastPrice: 108,
        judgmentSubtype: "FAST_TREND_SHIFT",
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_high_detected: true,
            higher_low_detected: true,
            box_mid_reclaimed: true
        },
        qualityScore: 80,
        emaGap: 0.015,
        htfEntryPolicy: "LONG_ONLY_OR_NONE",
        candles: [
            { open: 104, high: 107, low: 103.5, close: 106.5 },
            { open: 106.5, high: 108.5, low: 106, close: 108 }
        ]
    });
    const evalResult = evaluateUpperBreakoutLongConfirmed(ftsBullishCtx);
    assertTrue(evalResult.confirmed, "Test 4: FTS bullish upper long confirmed");
    assertTrue(evalResult.breakoutBreakdownSubstituted ?? false, "Test 4: substituted by continuation");
    assertEq(evalResult.holdReason, null, "Test 4: holdReason is null");
    console.log("PASS: Test 4 - FAST_TREND_SHIFT bullish upper long confirmed via continuation substitution");
}

// =========================================================================
// TEST 5: FAST_TREND_SHIFT bearish지만 quality 부족 (<65) -> 차단 유지
// =========================================================================
{
    const ftsLowQualityCtx = baseCtx({
        trendSideCandidate: "short",
        zone: "lower",
        boxBreakSide: "none",
        closedClose: 102,
        lastPrice: 102,
        judgmentSubtype: "FAST_TREND_SHIFT",
        fastTrendShift: {
            active: true,
            direction: "short",
            lower_high_detected: true,
            lower_low_detected: true
        },
        qualityScore: 55, // below 65 threshold
        emaGap: -0.015,
        htfEntryPolicy: "SHORT_ONLY_OR_NONE"
    });
    const evalResult = evaluateLowerBreakdownShortConfirmed(ftsLowQualityCtx);
    assertFalse(evalResult.confirmed, "Test 5: low quality FTS not confirmed");
    assertEq(evalResult.holdReason, "NO_BREAKDOWN_CONFIRMED", "Test 5: holdReason is NO_BREAKDOWN_CONFIRMED");
    console.log("PASS: Test 5 - FAST_TREND_SHIFT low quality blocked as NO_BREAKDOWN_CONFIRMED");
}

// =========================================================================
// TEST 6: FAST_TREND_SHIFT bullish지만 opposing strong highway down -> 차단 유지
// =========================================================================
{
    const ftsOpposingHighwayCtx = baseCtx({
        trendSideCandidate: "long",
        zone: "upper",
        boxBreakSide: "none",
        closedClose: 108,
        lastPrice: 108,
        judgmentSubtype: "FAST_TREND_SHIFT",
        fastTrendShift: {
            active: true,
            direction: "long"
        },
        qualityScore: 80,
        emaGap: 0.015,
        htfEntryPolicy: "LONG_ONLY_OR_NONE",
        opposingStrongHighway: true // Opposing strong highway DOWN
    });
    const evalResult = evaluateUpperBreakoutLongConfirmed(ftsOpposingHighwayCtx);
    assertFalse(evalResult.confirmed, "Test 6: opposing highway blocks long");
    assertEq(evalResult.holdReason, "NO_BREAKOUT_CONFIRMED", "Test 6: holdReason is NO_BREAKOUT_CONFIRMED");
    console.log("PASS: Test 6 - FAST_TREND_SHIFT with opposing strong highway blocked as NO_BREAKOUT_CONFIRMED");
}

// =========================================================================
// TEST 7: NO_BREAKDOWN_CONFIRMED라도 충분한 bearish continuation evidence 있으면 substitute 가능
// =========================================================================
{
    const continuationCtx = baseCtx({
        trendSideCandidate: "short",
        zone: "lower",
        boxBreakSide: "none",
        closedClose: 102.5, // Inside box, not yet broken 100
        lastPrice: 102,
        judgmentSubtype: "TREND_CONTINUATION_SHORT",
        execReason: "trend_continuation_short",
        continuationDirection: "down",
        qualityScore: 75,
        emaGap: -0.012,
        htfEntryPolicy: "ALLOW"
    });
    const evalResult = evaluateLowerBreakdownShortConfirmed(continuationCtx);
    assertTrue(evalResult.confirmed, "Test 7: continuation evidence substitutes breakdown");
    assertTrue(evalResult.breakoutBreakdownSubstituted ?? false, "Test 7: breakoutBreakdownSubstituted is true");
    assertEq(evalResult.holdReason, null, "Test 7: holdReason is null");
    console.log("PASS: Test 7 - NO_BREAKDOWN substituted by sufficient bearish continuation evidence");
}

// =========================================================================
// TEST 8: NO_BREAKOUT_CONFIRMED라도 충분한 bullish continuation evidence 있으면 substitute 가능
// =========================================================================
{
    const continuationCtx = baseCtx({
        trendSideCandidate: "long",
        zone: "upper",
        boxBreakSide: "none",
        closedClose: 107.5, // Inside box, not yet broken 110
        lastPrice: 108,
        judgmentSubtype: "TREND_CONTINUATION_LONG",
        execReason: "trend_continuation_long",
        continuationDirection: "up",
        qualityScore: 76,
        emaGap: 0.014,
        htfEntryPolicy: "ALLOW"
    });
    const evalResult = evaluateUpperBreakoutLongConfirmed(continuationCtx);
    assertTrue(evalResult.confirmed, "Test 8: continuation evidence substitutes breakout");
    assertTrue(evalResult.breakoutBreakdownSubstituted ?? false, "Test 8: breakoutBreakdownSubstituted is true");
    assertEq(evalResult.holdReason, null, "Test 8: holdReason is null");
    console.log("PASS: Test 8 - NO_BREAKOUT substituted by sufficient bullish continuation evidence");
}

// =========================================================================
// RUNTIME INTEGRATION TEST: Full runEngineV2 conflict resolution test
// =========================================================================
import { buildV2SnapshotBridge } from "./paper-engine";
import type { SymbolSnapshotLike } from "./paper-symbol-decision";
import { marketJudgmentCacheBySymbol } from "../engine-v2/index";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { clearGlobalShockStates } from "../engine-v2/state/derive";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor";

{
    marketJudgmentCacheBySymbol.clear();
    clearWhipsawObservationState();
    clearGlobalShockStates();
    rangeContinuationStateMap.clear();

    const now = 1_700_000_000_000;
    const mockCandles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
        const p = 65000 - i * 10;
        mockCandles.push({
            ts: now - (60 - i) * 60_000,
            open: p + 5,
            high: p + 10,
            low: p - 10,
            close: p,
            volume: 100
        });
    }

    const snap: SymbolSnapshotLike = ({
        symbol: "BTCUSDT",
        tickSz: 0.1,
        lastPrice: 65000,
        latestCandleClose: 65000,
        signal: "paper_short_candidate",
        entryCandidate: true,
        qualityScore: 78,
        candidateStrength: "strong",
        ema20: 65200,
        ema60: 65500,
        emaGap: -0.015,
        volumeRatioProxy: 1.2,
        boxHigh: 66000,
        boxLow: 64500,
        boxPos: 0.35, // lower zone -> rangeSideCandidate is long, trendSideCandidate is short
        boxRel: 0.05,
        gateExpectedMove: null,
        gateRequiredMove: null,
        atr: 300,
        atr20: 300,
        closedClose: 65000,
        rangeConfidence: 0.75,
        trendWeaknessScore: 0.2,
        boxCohesion01: 0.7,
        breakoutFailureRate: 0.3,
        rangeOscillationScore: 0.3,
        boxHighSlope: -0.0001,
        boxLowSlope: -0.0001,
        rangeCenterSlope: -0.0001,
        ema20Slope: -0.0001,
        candles: mockCandles,
        canonicalRegime: "RANGE",
        canonicalRegimeSource: "strategy_market_regime_detector",
        canonicalTrendScore: 0.5,
        fastTrendShift: {
            active: true,
            direction: "short",
            lower_high_detected: true,
            lower_low_detected: true,
            box_mid_lost: true
        } as any,
        htf_candles: {
            "5m": mockCandles,
            "15m": mockCandles,
            "1h": mockCandles,
            "4h": mockCandles,
            "1d": mockCandles
        }
    } as any);

    const bridge = buildV2SnapshotBridge(snap);
    const state = {
        instrumentTickSz: 0.1,
        directionalShockState: "NONE",
        crashState: "NORMAL",
        shortAllow: true,
        longAllow: true,
        currentPositions: [],
        signedExecutionReady: true,
        paperExecutionReady: true,
        okxAuthMode: "live",
        okxAuthReady: true,
        okxExchangeAuthOptIn: true,
        okxLiveEnabled: true,
        liveBalanceReady: true,
        accountEquityUsdt: 10000,
        availableBalanceUsdt: 10000,
        okxActualPositionsReady: true,
        actualAccountNotionalUsdtReady: true,
        okxPendingOrdersReady: true,
        okxPendingOrdersNotionalUsdt: 0,
        okxPendingSymbolNotionalUsdt: 0,
        okxActualPositions: [],
        balanceFetchedAt: now,
        positionsFetchedAt: now,
        pendingOrdersFetchedAt: now
    };
    const config = {
        paperMaxOpenPositions: 3,
        baseSizeUsd: 100,
        serverTradeEnabled: true,
        closeOnlyMode: false,
        killSwitch: false,
        reconcileSafeMode: false
    };

    const inputData = adaptV2Input(
        snap.symbol,
        now,
        bridge as any,
        config as any,
        state as any,
        {
            decision: {
                final_decision: "ENTER",
                reason: "FAST_TREND_SHIFT"
            }
        } as any,
        snap.candles,
        "authoritative",
        `cycle_BTCUSDT_${now}`
    );

    const res = runEngineV2(inputData);
    console.log("Integration test result decision:", res.decision.decision, "side:", res.decision.side, "promotionReason:", res.decision.metadata?.promotionReason);
    assertFalse(res.decision.decision === "REJECT", "Integration: not hard rejected");
    assertEq(res.decision.metadata?.promotionReason, "V2_CONFLICT_RESOLVED_TREND_SHORT", "Integration: promotion reason is V2_CONFLICT_RESOLVED_TREND_SHORT");
}

// =========================================================================
// ADDITIONAL TEST A: FAST_TREND_SHIFT bearish + lower + continuation evidence 부족 (EMA gap positive) -> 차단 유지
// =========================================================================
{
    const ftsAdverseEmaCtx = baseCtx({
        trendSideCandidate: "short",
        zone: "lower",
        boxBreakSide: "none",
        closedClose: 102,
        lastPrice: 102,
        judgmentSubtype: "FAST_TREND_SHIFT",
        fastTrendShift: {
            active: true,
            direction: "short",
            lower_high_detected: true
        },
        qualityScore: 78,
        emaGap: 0.01, // Adverse EMA gap for short
        htfEntryPolicy: "SHORT_ONLY_OR_NONE"
    });
    const evalResult = evaluateLowerBreakdownShortConfirmed(ftsAdverseEmaCtx);
    assertFalse(evalResult.confirmed, "Test A: adverse EMA gap blocks short continuation");
    assertEq(evalResult.holdReason, "NO_BREAKDOWN_CONFIRMED", "Test A: holdReason is NO_BREAKDOWN_CONFIRMED");
    assertFalse(evalResult.breakoutBreakdownSubstituted ?? false, "Test A: not substituted");
    console.log("PASS: Test A - FAST_TREND_SHIFT bearish with insufficient continuation evidence blocked as NO_BREAKDOWN_CONFIRMED");
}

// =========================================================================
// ADDITIONAL TEST B: FAST_TREND_SHIFT bullish + upper + continuation evidence 부족 (EMA gap negative) -> 차단 유지
// =========================================================================
{
    const ftsAdverseEmaCtx = baseCtx({
        trendSideCandidate: "long",
        zone: "upper",
        boxBreakSide: "none",
        closedClose: 108,
        lastPrice: 108,
        judgmentSubtype: "FAST_TREND_SHIFT",
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_high_detected: true
        },
        qualityScore: 78,
        emaGap: -0.01, // Adverse EMA gap for long
        htfEntryPolicy: "LONG_ONLY_OR_NONE"
    });
    const evalResult = evaluateUpperBreakoutLongConfirmed(ftsAdverseEmaCtx);
    assertFalse(evalResult.confirmed, "Test B: adverse EMA gap blocks long continuation");
    assertEq(evalResult.holdReason, "NO_BREAKOUT_CONFIRMED", "Test B: holdReason is NO_BREAKOUT_CONFIRMED");
    assertFalse(evalResult.breakoutBreakdownSubstituted ?? false, "Test B: not substituted");
    console.log("PASS: Test B - FAST_TREND_SHIFT bullish with insufficient continuation evidence blocked as NO_BREAKOUT_CONFIRMED");
}

// =========================================================================
// ADDITIONAL TEST C: Non-continuation lineage with pure RANGE (no evidence) -> bypass 열리지 않음
// =========================================================================
{
    const fakePromotionCtx = baseCtx({
        trendSideCandidate: "short",
        zone: "lower",
        boxBreakSide: "none",
        closedClose: 102,
        lastPrice: 102,
        judgmentSubtype: "RANGE_STABLE",
        execReason: "range_reversion",
        continuationDirection: null,
        fastTrendShift: null,
        qualityScore: 75,
        emaGap: -0.01
    });
    const evalResult = evaluateLowerBreakdownShortConfirmed(fakePromotionCtx);
    assertFalse(evalResult.confirmed, "Test C: pure range does not pass continuation");
    assertFalse(evalResult.breakoutBreakdownSubstituted ?? false, "Test C: substitution is false");
    assertEq(evalResult.holdReason, "NO_BREAKDOWN_CONFIRMED", "Test C: holdReason is NO_BREAKDOWN_CONFIRMED");
    console.log("PASS: Test C - Non-continuation lineage does not open breakdown substitution");
}

// =========================================================================
// ADDITIONAL TEST D: V2_CONFLICT_RESOLVED_TREND_* promoted but Highway gate rejects on RR -> final SKIP
// =========================================================================
{
    marketJudgmentCacheBySymbol.clear();
    clearWhipsawObservationState();
    clearGlobalShockStates();
    rangeContinuationStateMap.clear();

    const now = 1_700_000_000_000;
    const mockCandles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
        const p = 65000 - i * 10;
        mockCandles.push({
            ts: now - (60 - i) * 60_000,
            open: p + 5,
            high: p + 10,
            low: p - 10,
            close: p,
            volume: 100
        });
    }

    const snap: SymbolSnapshotLike = ({
        symbol: "BTCUSDT",
        tickSz: 0.1,
        lastPrice: 65000,
        latestCandleClose: 65000,
        signal: "paper_short_candidate",
        entryCandidate: true,
        qualityScore: 78,
        candidateStrength: "strong",
        ema20: 65200,
        ema60: 65500,
        emaGap: -0.015,
        volumeRatioProxy: 1.2,
        boxHigh: 66000,
        boxLow: 64500,
        boxPos: 0.35,
        boxRel: 0.05,
        gateExpectedMove: null,
        gateRequiredMove: null,
        atr: 300,
        atr20: 300,
        closedClose: 65000,
        rangeConfidence: 0.75,
        trendWeaknessScore: 0.2,
        boxCohesion01: 0.7,
        breakoutFailureRate: 0.3,
        rangeOscillationScore: 0.3,
        boxHighSlope: -0.0001,
        boxLowSlope: -0.0001,
        rangeCenterSlope: -0.0001,
        ema20Slope: -0.0001,
        candles: mockCandles,
        canonicalRegime: "RANGE",
        canonicalRegimeSource: "strategy_market_regime_detector",
        canonicalTrendScore: 0.5,
        fastTrendShift: {
            active: true,
            direction: "short",
            lower_high_detected: true,
            lower_low_detected: true,
            box_mid_lost: true
        } as any,
        htf_candles: {
            "5m": mockCandles,
            "15m": mockCandles,
            "1h": mockCandles,
            "4h": mockCandles,
            "1d": mockCandles
        }
    } as any);

    const bridge = buildV2SnapshotBridge(snap);
    const state = {
        instrumentTickSz: 0.1,
        directionalShockState: "NONE",
        crashState: "NORMAL",
        shortAllow: true,
        longAllow: true,
        currentPositions: [],
        signedExecutionReady: true,
        paperExecutionReady: true,
        okxAuthMode: "live",
        okxAuthReady: true,
        okxExchangeAuthOptIn: true,
        okxLiveEnabled: true,
        liveBalanceReady: true,
        accountEquityUsdt: 10000,
        availableBalanceUsdt: 10000,
        okxActualPositionsReady: true,
        actualAccountNotionalUsdtReady: true,
        okxPendingOrdersReady: true,
        okxPendingOrdersNotionalUsdt: 0,
        okxPendingSymbolNotionalUsdt: 0,
        okxActualPositions: [],
        balanceFetchedAt: now,
        positionsFetchedAt: now,
        pendingOrdersFetchedAt: now
    };
    const config = {
        paperMaxOpenPositions: 3,
        baseSizeUsd: 100,
        serverTradeEnabled: true,
        closeOnlyMode: false,
        killSwitch: false,
        reconcileSafeMode: false
    };

    const inputData = adaptV2Input(
        snap.symbol,
        now,
        bridge as any,
        config as any,
        state as any,
        {
            decision: {
                final_decision: "ENTER",
                reason: "FAST_TREND_SHIFT"
            }
        } as any,
        snap.candles,
        "authoritative",
        `cycle_BTCUSDT_${now}`
    );

    const res = runEngineV2(inputData);
    // V2 promoted to V2_CONFLICT_RESOLVED_TREND_SHORT
    assertEq(res.decision.metadata?.promotionReason, "V2_CONFLICT_RESOLVED_TREND_SHORT", "Test D: promotion applied");
    assertEq(res.decision.metadata?.v2DecisionFinal, "ENTER", "Test D: v2DecisionFinal was ENTER");
    // But Highway gate rejected on POOR_REWARD_RISK_RATIO -> final decision is SKIP
    assertEq(res.decision.decision, "SKIP", "Test D: final decision guarded to SKIP by Highway");
    assertEq(res.decision.risk.blockReason, "POOR_REWARD_RISK_RATIO", "Test D: Highway rejectReason is POOR_REWARD_RISK_RATIO");
    console.log("PASS: Test D - Highway RR gate successfully guards promoted setup to final SKIP");
}

console.log("v2-range-trend-continuation-deadlock-cases: ALL TESTS PASS (8 MANDATORY + 4 SAFETY AUDIT TESTS)");

