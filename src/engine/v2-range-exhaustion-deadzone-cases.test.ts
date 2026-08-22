import assert from "node:assert/strict";
import { executeRangeRegime, rangeContinuationStateMap } from "../engine-v2/executors/range-executor";
import type { EngineV2Input, MarketJudgmentOutput } from "../engine-v2/types";
import type { Candle } from "../models/types";

function getMockInput(overrides: any = {}): EngineV2Input {
    const defaultCandles: Candle[] = [
        { ts: 1000, open: 90000, high: 91000, low: 89000, close: 90000, volume: 100 },
        { ts: 2000, open: 90000, high: 91000, low: 89000, close: 90000, volume: 100 },
        { ts: 3000, open: 90000, high: 91000, low: 89000, close: 90000, volume: 100 },
        { ts: 4000, open: 90000, high: 91000, low: 89000, close: 90000, volume: 100 },
        { ts: 5000, open: 90000, high: 91000, low: 89000, close: 90000, volume: 100 }
    ];

    return {
        symbol: "BTCUSDT",
        run_cycle_id: "test_cycle_1",
        evaluationMode: "authoritative",
        snapshot: {
            symbol: "BTCUSDT",
            lastPrice: 90000,
            markPrice: 90000,
            latestCandleClose: 90000,
            boxPos: 0.5,
            boxHigh: 95000,
            boxLow: 85000,
            boxMid: 90000,
            atr: 1000,
            qualityScore: 80,
            candles: defaultCandles,
            ...overrides.snapshot
        } as any,
        state: {
            activePositionsCount: 0,
            currentPositions: [],
            longAllow: true,
            shortAllow: true,
            paperExecutionReady: true,
            signedExecutionReady: true,
            okxLiveEnabled: true,
            cooldownRemainingMs: 0,
            ...overrides.state
        } as any,
        config: {
            baseSizeUsd: 100,
            okxLiveStaticNotionalCapEnabled: true,
            okxLiveUsableBalanceRatio: 0.95,
            ...overrides.config
        } as any,
        ...overrides
    } as any;
}

function getMockJudgment(overrides: any = {}): MarketJudgmentOutput {
    return {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_FLAT",
        subtypeReason: "none",
        shockPhase: "NONE",
        trendPhase: "NONE",
        rangePhase: "NONE",
        transitionPhase: "NONE",
        noTradeReason: "none",
        trendScore: 0.2,
        rangeScore: 0.8,
        trendWeaknessScore: 0.85,
        rangeConfidence: 0.8,
        boxCohesionCollapse: false,
        mixedBreakoutState: false,
        boxQuality: 80,
        timestamp: 5000,
        metadata: {},
        ...overrides
    } as any;
}

function pass(name: string, details?: any) {
    console.log(`[RANGE-EXHAUSTION-TEST][${name}] PASS`, details ? `— ${JSON.stringify(details)}` : "");
}

async function runTests() {
    console.log("=== STARTING RANGE EXECUTOR EXHAUSTION DEAD-ZONE REGRESSION SUITE ===");

    // Test 1: EXHAUSTION upper reversal confirmed -> SHORT_CANDIDATE
    {
        rangeContinuationStateMap.clear();
        const candles: Candle[] = [
            { ts: 1000, open: 93000, high: 94000, low: 92000, close: 93500, volume: 100 },
            { ts: 2000, open: 93500, high: 94500, low: 93000, close: 94200, volume: 100 },
            { ts: 3000, open: 94200, high: 95050, low: 94000, close: 94800, volume: 100 }, // touched 95000, not overshot (< 95150)
            { ts: 4000, open: 94800, high: 94950, low: 94600, close: 94700, volume: 100 },
            { ts: 5000, open: 94700, high: 94750, low: 94650, close: 94680, volume: 100 }
        ];
        const lastPrice = 94700; // < 95000 * 0.9997 (= 94971.5) -> reaction detected

        const input = getMockInput({
            snapshot: {
                boxPos: 0.95, // upper
                lastPrice,
                boxHigh: 95000,
                boxLow: 85000,
                boxMid: 90000,
                atr: 1000,
                emaGap: 0.0012, // positive emaGap in realistic scale
                candles
            } as any
        });

        const judgment = getMockJudgment({
            trendPhase: "EXHAUSTION",
            shockPhase: "NONE"
        });

        const out = executeRangeRegime(input, judgment);
        assert.equal(out.signal, "SHORT_CANDIDATE");
        assert.equal(out.side, "short");
        assert.equal(out.reason, "Upper edge reversal identified by price reaction");
        pass("TEST_1_EXHAUSTION_UPPER_SHORT_REVERSAL_CONFIRMED", { signal: out.signal, side: out.side, reason: out.reason });
    }

    // Test 2: EXHAUSTION lower reversal confirmed -> LONG_CANDIDATE
    {
        rangeContinuationStateMap.clear();
        const candles: Candle[] = [
            { ts: 1000, open: 87000, high: 88000, low: 86000, close: 86500, volume: 100 },
            { ts: 2000, open: 86500, high: 87000, low: 85500, close: 85800, volume: 100 },
            { ts: 3000, open: 85800, high: 86000, low: 84950, close: 85200, volume: 100 }, // touched 85000, not overshot (> 84850)
            { ts: 4000, open: 85200, high: 85400, low: 85100, close: 85300, volume: 100 },
            { ts: 5000, open: 85300, high: 85400, low: 85250, close: 85350, volume: 100 }
        ];
        const lastPrice = 85300; // > 85000 * 1.0003 (= 85025.5) -> reaction detected

        const input = getMockInput({
            snapshot: {
                boxPos: 0.05, // lower
                lastPrice,
                boxHigh: 95000,
                boxLow: 85000,
                boxMid: 90000,
                atr: 1000,
                emaGap: -0.0012, // negative emaGap in realistic scale
                candles
            } as any
        });

        const judgment = getMockJudgment({
            trendPhase: "EXHAUSTION",
            shockPhase: "NONE"
        });

        const out = executeRangeRegime(input, judgment);
        assert.equal(out.signal, "LONG_CANDIDATE");
        assert.equal(out.side, "long");
        assert.equal(out.reason, "Lower edge reversal identified by price reaction");
        pass("TEST_2_EXHAUSTION_LOWER_LONG_REVERSAL_CONFIRMED", { signal: out.signal, side: out.side, reason: out.reason });
    }

    // Test 3: EXHAUSTION upper breakout continuation deadlock advance with authoritative candle ts advance
    {
        rangeContinuationStateMap.clear();
        const symbol = "BTCUSDT";
        const boxHigh = 95000;
        const boxLow = 85000;
        const lastPrice = 95200; // > boxHigh (breakout)

        // Cycle 1 at ts=60000
        const candles1: Candle[] = [
            { ts: 60000, open: 95100, high: 95300, low: 95050, close: 95200, volume: 100 }
        ];
        const input1 = getMockInput({
            run_cycle_id: "cycle_1",
            snapshot: {
                boxPos: 1.05,
                lastPrice,
                boxHigh,
                boxLow,
                boxHighSlope: 0.001,
                rangeCenterSlope: 0.001,
                emaGap: 0.0015,
                candles: candles1
            } as any
        });
        const judgment1 = getMockJudgment({ trendPhase: "EXHAUSTION", shockPhase: "NONE" });
        executeRangeRegime(input1, judgment1);

        let state = rangeContinuationStateMap.get(symbol);
        assert.ok(state);
        assert.equal(state.phase, "DEADLOCK_COUNTING");
        assert.equal(state.direction, "up");
        assert.equal(state.consecutiveCycles, 1);

        // Cycle 2 at ts=120000 (candle advanced)
        const candles2: Candle[] = [
            { ts: 60000, open: 95100, high: 95300, low: 95050, close: 95200, volume: 100 },
            { ts: 120000, open: 95200, high: 95400, low: 95150, close: 95300, volume: 100 }
        ];
        const input2 = getMockInput({
            run_cycle_id: "cycle_2",
            snapshot: {
                boxPos: 1.05,
                lastPrice: 95300,
                boxHigh,
                boxLow,
                boxHighSlope: 0.001,
                rangeCenterSlope: 0.001,
                emaGap: 0.0015,
                candles: candles2
            } as any
        });
        executeRangeRegime(input2, judgment1);

        state = rangeContinuationStateMap.get(symbol);
        assert.ok(state);
        assert.equal(state.phase, "DEADLOCK_COUNTING");
        assert.equal(state.consecutiveCycles, 2);
        assert.equal(state.hasCandleAdvancedDuringCount, true);

        // Cycle 3 at ts=180000 (reaches consecutiveCycles >= 3 && candleAdvanced -> CONTINUATION_WATCH)
        const candles3: Candle[] = [
            { ts: 60000, open: 95100, high: 95300, low: 95050, close: 95200, volume: 100 },
            { ts: 120000, open: 95200, high: 95400, low: 95150, close: 95300, volume: 100 },
            { ts: 180000, open: 95300, high: 95500, low: 95250, close: 95400, volume: 100 }
        ];
        const input3 = getMockInput({
            run_cycle_id: "cycle_3",
            snapshot: {
                boxPos: 1.05,
                lastPrice: 95400,
                boxHigh,
                boxLow,
                boxHighSlope: 0.001,
                rangeCenterSlope: 0.001,
                emaGap: 0.0015,
                candles: candles3
            } as any
        });
        executeRangeRegime(input3, judgment1);

        state = rangeContinuationStateMap.get(symbol);
        assert.ok(state);
        assert.equal(state.phase, "CONTINUATION_WATCH");
        assert.equal(state.direction, "up");
        pass("TEST_3_EXHAUSTION_UPPER_BREAKOUT_CONTINUATION_DEADLOCK_ADVANCE", {
            phase: state.phase,
            direction: state.direction,
            consecutiveCycles: state.consecutiveCycles,
            hasCandleAdvancedDuringCount: state.hasCandleAdvancedDuringCount
        });
    }

    // Test 4: EXHAUSTION lower breakdown continuation deadlock advance with authoritative candle ts advance
    {
        rangeContinuationStateMap.clear();
        const symbol = "BTCUSDT";
        const boxHigh = 95000;
        const boxLow = 85000;
        const lastPrice = 84800; // < boxLow (breakdown)

        // Cycle 1 at ts=60000
        const candles1: Candle[] = [
            { ts: 60000, open: 84900, high: 85000, low: 84700, close: 84800, volume: 100 }
        ];
        const input1 = getMockInput({
            run_cycle_id: "cycle_1",
            snapshot: {
                boxPos: -0.05,
                lastPrice,
                boxHigh,
                boxLow,
                boxLowSlope: -0.001,
                rangeCenterSlope: -0.001,
                emaGap: -0.0015,
                candles: candles1
            } as any
        });
        const judgment1 = getMockJudgment({ trendPhase: "EXHAUSTION", shockPhase: "NONE" });
        executeRangeRegime(input1, judgment1);

        let state = rangeContinuationStateMap.get(symbol);
        assert.ok(state);
        assert.equal(state.phase, "DEADLOCK_COUNTING");
        assert.equal(state.direction, "down");
        assert.equal(state.consecutiveCycles, 1);

        // Cycle 2 at ts=120000
        const candles2: Candle[] = [
            { ts: 60000, open: 84900, high: 85000, low: 84700, close: 84800, volume: 100 },
            { ts: 120000, open: 84800, high: 84900, low: 84600, close: 84700, volume: 100 }
        ];
        const input2 = getMockInput({
            run_cycle_id: "cycle_2",
            snapshot: {
                boxPos: -0.05,
                lastPrice: 84700,
                boxHigh,
                boxLow,
                boxLowSlope: -0.001,
                rangeCenterSlope: -0.001,
                emaGap: -0.0015,
                candles: candles2
            } as any
        });
        executeRangeRegime(input2, judgment1);

        state = rangeContinuationStateMap.get(symbol);
        assert.ok(state);
        assert.equal(state.phase, "DEADLOCK_COUNTING");
        assert.equal(state.consecutiveCycles, 2);
        assert.equal(state.hasCandleAdvancedDuringCount, true);

        // Cycle 3 at ts=180000 -> CONTINUATION_WATCH
        const candles3: Candle[] = [
            { ts: 60000, open: 84900, high: 85000, low: 84700, close: 84800, volume: 100 },
            { ts: 120000, open: 84800, high: 84900, low: 84600, close: 84700, volume: 100 },
            { ts: 180000, open: 84700, high: 84800, low: 84500, close: 84600, volume: 100 }
        ];
        const input3 = getMockInput({
            run_cycle_id: "cycle_3",
            snapshot: {
                boxPos: -0.05,
                lastPrice: 84600,
                boxHigh,
                boxLow,
                boxLowSlope: -0.001,
                rangeCenterSlope: -0.001,
                emaGap: -0.0015,
                candles: candles3
            } as any
        });
        executeRangeRegime(input3, judgment1);

        state = rangeContinuationStateMap.get(symbol);
        assert.ok(state);
        assert.equal(state.phase, "CONTINUATION_WATCH");
        assert.equal(state.direction, "down");
        pass("TEST_4_EXHAUSTION_LOWER_BREAKDOWN_CONTINUATION_DEADLOCK_ADVANCE", {
            phase: state.phase,
            direction: state.direction,
            consecutiveCycles: state.consecutiveCycles,
            hasCandleAdvancedDuringCount: state.hasCandleAdvancedDuringCount
        });
    }

    // Test 5: Contradictory DOWN + emaGap > 0 does NOT start up continuation
    {
        rangeContinuationStateMap.clear();
        const symbol = "BTCUSDT";
        const input = getMockInput({
            snapshot: {
                boxPos: 1.05,
                lastPrice: 95200,
                boxHigh: 95000,
                boxLow: 85000,
                emaGap: 0.0015 // positive emaGap while trendPhase is DOWN
            } as any
        });
        const judgment = getMockJudgment({ trendPhase: "DOWN", shockPhase: "NONE" });
        executeRangeRegime(input, judgment);

        const state = rangeContinuationStateMap.get(symbol);
        assert.ok(!state || state.direction !== "up" || state.phase === "IDLE");
        pass("TEST_5_CONTRADICTORY_DOWN_TREND_WITH_POSITIVE_EMAGAP_NO_UP_CONTINUATION", {
            statePhase: state?.phase ?? "IDLE",
            stateDirection: state?.direction ?? null
        });
    }

    // Test 6: Contradictory UP + emaGap < 0 does NOT start down continuation
    {
        rangeContinuationStateMap.clear();
        const symbol = "BTCUSDT";
        const input = getMockInput({
            snapshot: {
                boxPos: -0.05,
                lastPrice: 84800,
                boxHigh: 95000,
                boxLow: 85000,
                emaGap: -0.0015 // negative emaGap while trendPhase is UP
            } as any
        });
        const judgment = getMockJudgment({ trendPhase: "UP", shockPhase: "NONE" });
        executeRangeRegime(input, judgment);

        const state = rangeContinuationStateMap.get(symbol);
        assert.ok(!state || state.direction !== "down" || state.phase === "IDLE");
        pass("TEST_6_CONTRADICTORY_UP_TREND_WITH_NEGATIVE_EMAGAP_NO_DOWN_CONTINUATION", {
            statePhase: state?.phase ?? "IDLE",
            stateDirection: state?.direction ?? null
        });
    }

    // Test 7: Shock-over-reversal authority preservation
    {
        rangeContinuationStateMap.clear();
        const candles: Candle[] = [
            { ts: 1000, open: 93000, high: 94000, low: 92000, close: 93500, volume: 100 },
            { ts: 2000, open: 93500, high: 94500, low: 93000, close: 94200, volume: 100 },
            { ts: 3000, open: 94200, high: 95050, low: 94000, close: 94800, volume: 100 },
            { ts: 4000, open: 94800, high: 94950, low: 94600, close: 94700, volume: 100 },
            { ts: 5000, open: 94700, high: 94750, low: 94650, close: 94680, volume: 100 }
        ];

        // 7a: UP_SHOCK blocks upper short even with reversal confirmed
        const inputUpper = getMockInput({
            snapshot: {
                boxPos: 0.95,
                lastPrice: 94700,
                boxHigh: 95000,
                boxLow: 85000,
                atr: 1000,
                emaGap: 0.0012,
                candles
            } as any
        });
        const judgmentUpper = getMockJudgment({
            trendPhase: "EXHAUSTION",
            shockPhase: "UP_SHOCK"
        });
        const outUpper = executeRangeRegime(inputUpper, judgmentUpper);
        assert.equal(outUpper.signal, "NONE");
        assert.equal(outUpper.reason, "V2_RANGE_UPPER_SHORT_BLOCKED_BY_UP_SHOCK");

        // 7b: DOWN_SHOCK blocks lower long even with reversal confirmed
        const candlesLower: Candle[] = [
            { ts: 1000, open: 87000, high: 88000, low: 86000, close: 86500, volume: 100 },
            { ts: 2000, open: 86500, high: 87000, low: 85500, close: 85800, volume: 100 },
            { ts: 3000, open: 85800, high: 86000, low: 84950, close: 85200, volume: 100 },
            { ts: 4000, open: 85200, high: 85400, low: 85100, close: 85300, volume: 100 },
            { ts: 5000, open: 85300, high: 85400, low: 85250, close: 85350, volume: 100 }
        ];
        const inputLower = getMockInput({
            snapshot: {
                boxPos: 0.05,
                lastPrice: 85300,
                boxHigh: 95000,
                boxLow: 85000,
                atr: 1000,
                emaGap: -0.0012,
                candles: candlesLower
            } as any
        });
        const judgmentLower = getMockJudgment({
            trendPhase: "EXHAUSTION",
            shockPhase: "DOWN_SHOCK"
        });
        const outLower = executeRangeRegime(inputLower, judgmentLower);
        assert.equal(outLower.signal, "NONE");
        assert.equal(outLower.reason, "V2_RANGE_LOWER_LONG_BLOCKED_BY_DOWN_SHOCK");

        pass("TEST_7_SHOCK_OVER_REVERSAL_PRESERVATION", {
            upperBlockedReason: outUpper.reason,
            lowerBlockedReason: outLower.reason
        });
    }

    console.log("=== ALL 7 RANGE EXHAUSTION REGRESSION TESTS PASSED ===");
}

runTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
