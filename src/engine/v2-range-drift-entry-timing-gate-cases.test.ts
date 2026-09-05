import test from "node:test";
import assert from "node:assert/strict";
import {
    evaluateRangeDriftEntryTimingGate,
    resetRangeDriftHysteresis
} from "../engine-v2/market-judgment/range-drift-entry-timing-gate";

test("V2 RANGE Drift Entry Timing Gate Test Suite", async (t) => {

    t.beforeEach(() => {
        resetRangeDriftHysteresis();
    });

    await t.test("CASE 1: DOWN drift + mid-zone LONG -> WAIT with RANGE_DOWN_DRIFT_LONG_WAIT_LOWER_EDGE", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50, // mid zone
            entryPrice: 65000,
            boxHigh: 65500,
            boxLow: 64500,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, true);
        assert.strictEqual(res.decisionAfter, "WAIT");
        assert.strictEqual(res.reason, "RANGE_DOWN_DRIFT_LONG_WAIT_LOWER_EDGE");
        assert.strictEqual(res.driftDirection, "DOWN");
        assert.strictEqual(res.favorableEdgeReached, false);
    });

    await t.test("CASE 2: DOWN drift + lower edge but no reaction -> WAIT with RANGE_DOWN_DRIFT_LONG_WAIT_REACTION", () => {
        const fallingCandles = [
            { open: 64800, high: 64850, low: 64600, close: 64620, volume: 10 },
            { open: 64620, high: 64650, low: 64500, close: 64510, volume: 10 }
        ];

        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.15, // favorable lower edge
            entryPrice: 64550,
            boxHigh: 65500,
            boxLow: 64500,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: fallingCandles,
            reclaimConfirmed: false,
            rejectionConfirmed: false,
            reversalConfirmed: false
        });

        assert.strictEqual(res.blockedOrWaited, true);
        assert.strictEqual(res.decisionAfter, "WAIT");
        assert.strictEqual(res.reason, "RANGE_DOWN_DRIFT_LONG_WAIT_REACTION");
        assert.strictEqual(res.driftDirection, "DOWN");
        assert.strictEqual(res.favorableEdgeReached, true);
        assert.strictEqual(res.reactionConfirmed, false);
    });

    await t.test("CASE 3: DOWN drift + lower edge + reclaim/rejection -> ALLOW", () => {
        const reactingCandles = [
            { open: 64600, high: 64650, low: 64450, close: 64520, volume: 10 },
            { open: 64520, high: 64700, low: 64480, close: 64680, volume: 15 },
            { open: 64680, high: 64690, low: 64670, close: 64685, volume: 5 } // current in-flight candle
        ];

        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.18, // favorable lower edge
            entryPrice: 64680,
            boxHigh: 65500,
            boxLow: 64500,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: reactingCandles
        });

        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
        assert.strictEqual(res.reason, null);
        assert.strictEqual(res.driftDirection, "DOWN");
        assert.strictEqual(res.favorableEdgeReached, true);
        assert.strictEqual(res.reactionConfirmed, true);
    });

    await t.test("CASE 4A: UP drift + mid-zone SHORT -> WAIT with RANGE_UP_DRIFT_SHORT_WAIT_UPPER_EDGE", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.000015,
            ema20Slope: 0.000012,
            boxPos: 0.55, // mid zone
            entryPrice: 2500,
            boxHigh: 2550,
            boxLow: 2450,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, true);
        assert.strictEqual(res.decisionAfter, "WAIT");
        assert.strictEqual(res.reason, "RANGE_UP_DRIFT_SHORT_WAIT_UPPER_EDGE");
        assert.strictEqual(res.driftDirection, "UP");
        assert.strictEqual(res.favorableEdgeReached, false);
    });

    await t.test("CASE 4B: UP drift + upper edge but no reaction -> WAIT with RANGE_UP_DRIFT_SHORT_WAIT_REACTION", () => {
        const risingCandles = [
            { open: 2520, high: 2540, low: 2515, close: 2538, volume: 5 },
            { open: 2538, high: 2552, low: 2535, close: 2550, volume: 8 }
        ];

        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.000015,
            ema20Slope: 0.000012,
            boxPos: 0.85, // favorable upper edge
            entryPrice: 2550,
            boxHigh: 2550,
            boxLow: 2450,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: risingCandles,
            reclaimConfirmed: false,
            rejectionConfirmed: false,
            reversalConfirmed: false
        });

        assert.strictEqual(res.blockedOrWaited, true);
        assert.strictEqual(res.decisionAfter, "WAIT");
        assert.strictEqual(res.reason, "RANGE_UP_DRIFT_SHORT_WAIT_REACTION");
        assert.strictEqual(res.driftDirection, "UP");
        assert.strictEqual(res.favorableEdgeReached, true);
        assert.strictEqual(res.reactionConfirmed, false);
    });

    await t.test("CASE 4C: UP drift + upper edge + rejection/lower-high -> ALLOW", () => {
        const rejectingCandles = [
            { open: 2530, high: 2555, low: 2525, close: 2545, volume: 8 },
            { open: 2545, high: 2552, low: 2520, close: 2525, volume: 12 },
            { open: 2525, high: 2528, low: 2522, close: 2524, volume: 4 } // current in-flight candle
        ];

        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.000015,
            ema20Slope: 0.000012,
            boxPos: 0.75, // favorable upper edge
            entryPrice: 2525,
            boxHigh: 2550,
            boxLow: 2450,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: rejectingCandles
        });

        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
        assert.strictEqual(res.reason, null);
        assert.strictEqual(res.driftDirection, "UP");
        assert.strictEqual(res.favorableEdgeReached, true);
        assert.strictEqual(res.reactionConfirmed, true);
    });

    await t.test("CASE 5: DOWN drift + SHORT candidate is preserved (drift-aligned)", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.45,
            entryPrice: 65000,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
        assert.strictEqual(res.driftDirection, "DOWN");
    });

    await t.test("CASE 6: UP drift + LONG candidate is preserved (drift-aligned)", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.00001,
            ema20Slope: 0.00001,
            boxPos: 0.60,
            entryPrice: 2500,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
        assert.strictEqual(res.driftDirection, "UP");
    });

    await t.test("CASE 7: Neutral FLAT (no drift) is preserved", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: 0.00001, // diverging slopes -> no drift
            boxPos: 0.45,
            entryPrice: 2500,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
        assert.strictEqual(res.driftDirection, "NONE");
    });

    await t.test("CASE 8: TREND regime strictly bypasses gate", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "TREND",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
    });

    await t.test("CASE 9: Breakout continuation / shock subtypes strictly bypass gate", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            marketSubtype: "BREAKOUT_RETEST_CONFIRMED_VOLUME",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
    });

    await t.test("CASE 10: Add-on candidate strictly bypasses gate", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            isAddon: true,
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
    });

    await t.test("CASE 11: OPERATOR_MANAGED and manual takeover strictly bypass gate", () => {
        const resOp = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            lifecycleState: "OPERATOR_MANAGED",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            candles: null
        });
        assert.strictEqual(resOp.blockedOrWaited, false);

        const resManual = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            manualTakeoverActive: true,
            rangeCenterSlope: 0.00001,
            ema20Slope: 0.00001,
            boxPos: 0.50,
            entryPrice: 2500,
            candles: null
        });
        assert.strictEqual(resManual.blockedOrWaited, false);
    });

    await t.test("CASE 12: Positive Control - DOWN drift LONG waits for lower edge / reaction (Live BTC reproduction)", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.000008,
            ema20Slope: -0.000008,
            boxPos: -4.85,
            entryPrice: 77265.7,
            boxHigh: 77500,
            boxLow: 77270,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: [
                { open: 77290, high: 77300, low: 77260, close: 77265, volume: 20 },
                { open: 77265, high: 77270, low: 77250, close: 77255, volume: 25 }
            ]
        });

        assert.strictEqual(res.blockedOrWaited, true);
        assert.strictEqual(res.decisionAfter, "WAIT");
        assert.strictEqual(res.driftDirection, "DOWN");
        assert.ok(res.reason?.startsWith("RANGE_DOWN_DRIFT_LONG_WAIT_"));
    });

    await t.test("CASE 13: Positive Control - UP drift SHORT waits for upper edge / reaction (Symmetric reproduction)", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.000012,
            ema20Slope: 0.000012,
            boxPos: 0.50, // mid-zone
            entryPrice: 2350,
            boxHigh: 2360,
            boxLow: 2340,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: [
                { open: 2345, high: 2352, low: 2344, close: 2350, volume: 15 },
                { open: 2350, high: 2355, low: 2349, close: 2353, volume: 20 }
            ]
        });

        assert.strictEqual(res.blockedOrWaited, true);
        assert.strictEqual(res.decisionAfter, "WAIT");
        assert.strictEqual(res.driftDirection, "UP");
        assert.strictEqual(res.reason, "RANGE_UP_DRIFT_SHORT_WAIT_UPPER_EDGE");
    });

    await t.test("CASE 14: Near-zero slope within deadband (1e-6) does NOT trigger drift or hypersensitive WAIT", () => {
        // Slopes around 5e-7 (0.0000005) - micro floating-point noise around zero
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.0000005, // within deadband
            ema20Slope: -0.0000005,       // within deadband
            boxPos: 0.50,
            entryPrice: 65000,
            boxHigh: 65500,
            boxLow: 64500,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
        assert.strictEqual(res.driftDirection, "NONE");
        assert.strictEqual(res.reason, null);
    });

    await t.test("CASE 15A: Same-candle repeated evaluations (candleAdvanceCount = 0) do NOT falsely confirm drift", () => {
        // Consecutive evaluations = 5, but all on the SAME candle (candleAdvanceCount = 0)
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            consecutiveEvaluations: 5,
            candleAdvanceCount: 0, // Same candle!
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
        assert.strictEqual(res.driftConfirmed, false);
        assert.strictEqual(res.reason, null);
    });

    await t.test("CASE 15B: Second evaluation with candle advance >= 1 confirms drift and activates gate", () => {
        // Consecutive evaluations >= 2 AND candleAdvanceCount >= 1
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1, // Candle advanced!
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, true);
        assert.strictEqual(res.decisionAfter, "WAIT");
        assert.strictEqual(res.driftConfirmed, true);
        assert.strictEqual(res.reason, "RANGE_DOWN_DRIFT_LONG_WAIT_LOWER_EDGE");
    });

    await t.test("CASE 1B: DOWN drift + upper-zone LONG -> WAIT with RANGE_DOWN_DRIFT_LONG_WAIT_LOWER_EDGE", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.80, // upper zone
            entryPrice: 65300,
            boxHigh: 65500,
            boxLow: 64500,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, true);
        assert.strictEqual(res.decisionAfter, "WAIT");
        assert.strictEqual(res.reason, "RANGE_DOWN_DRIFT_LONG_WAIT_LOWER_EDGE");
        assert.strictEqual(res.driftDirection, "DOWN");
        assert.strictEqual(res.favorableEdgeReached, false);
    });

    await t.test("CASE 4D: UP drift + lower-zone SHORT -> WAIT with RANGE_UP_DRIFT_SHORT_WAIT_UPPER_EDGE", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.000015,
            ema20Slope: 0.000012,
            boxPos: 0.20, // lower zone
            entryPrice: 2470,
            boxHigh: 2550,
            boxLow: 2450,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, true);
        assert.strictEqual(res.decisionAfter, "WAIT");
        assert.strictEqual(res.reason, "RANGE_UP_DRIFT_SHORT_WAIT_UPPER_EDGE");
        assert.strictEqual(res.driftDirection, "UP");
        assert.strictEqual(res.favorableEdgeReached, false);
    });

    await t.test("CASE 14B: Positive slope within deadband (+5e-7) does NOT trigger UP drift or WAIT", () => {
        // Positive micro-slope +5e-7 within deadband 1e-6
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.0000005, // within deadband
            ema20Slope: 0.0000005,       // within deadband
            boxPos: 0.50,
            entryPrice: 2500,
            boxHigh: 2550,
            boxLow: 2450,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
        assert.strictEqual(res.driftDirection, "NONE");
        assert.strictEqual(res.reason, null);
    });

    await t.test("CASE 15C: Same-candle 5 repeated evaluations for UP drift + SHORT do NOT confirm drift", () => {
        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.00001,
            ema20Slope: 0.00001,
            boxPos: 0.50,
            entryPrice: 2500,
            consecutiveEvaluations: 5,
            candleAdvanceCount: 0, // Same candle repeated 5 times
            candles: null
        });

        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
        assert.strictEqual(res.driftConfirmed, false);
        assert.strictEqual(res.reason, null);
    });

    await t.test("CASE 16: In-memory live hysteresis 5 repeated evaluations in same candle -> false, then next candle advance -> confirm", () => {
        resetRangeDriftHysteresis("BTCUSDT");

        // Tick 1 to 5 on same candle timestamp (1000)
        for (let i = 1; i <= 5; i++) {
            const res = evaluateRangeDriftEntryTimingGate({
                symbol: "BTCUSDT",
                candidateSide: "long",
                canonicalRegime: "RANGE",
                rangePhase: "FLAT",
                rangeCenterSlope: -0.00001,
                ema20Slope: -0.00001,
                boxPos: 0.50,
                entryPrice: 65000,
                candles: [{ timestamp: 1000, open: 65000, high: 65050, low: 64950, close: 65000, volume: 10 }] as any
            });
            assert.strictEqual(res.driftConfirmed, false, `Tick ${i} in same candle must not confirm drift`);
            assert.strictEqual(res.blockedOrWaited, false);
        }

        // Tick 6 arrives on next candle timestamp (2000)
        const resNext = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            candles: [
                { timestamp: 1000, open: 65000, high: 65050, low: 64950, close: 65000, volume: 10 },
                { timestamp: 2000, open: 65000, high: 65020, low: 64900, close: 64920, volume: 15 }
            ] as any
        });
        assert.strictEqual(resNext.driftConfirmed, true, "Next candle advance must confirm drift");
        assert.strictEqual(resNext.blockedOrWaited, true);
        assert.strictEqual(resNext.reason, "RANGE_DOWN_DRIFT_LONG_WAIT_LOWER_EDGE");
    });

    await t.test("CASE 17: In-memory live hysteresis symmetric test for UP drift + ETHUSDT SHORT", () => {
        resetRangeDriftHysteresis("ETHUSDT");

        // Tick 1 to 5 on same candle timestamp (1000)
        for (let i = 1; i <= 5; i++) {
            const res = evaluateRangeDriftEntryTimingGate({
                symbol: "ETHUSDT",
                candidateSide: "short",
                canonicalRegime: "RANGE",
                rangePhase: "FLAT",
                rangeCenterSlope: 0.000015,
                ema20Slope: 0.000012,
                boxPos: 0.50,
                entryPrice: 2500,
                candles: [{ timestamp: 1000, open: 2500, high: 2510, low: 2495, close: 2500, volume: 10 }] as any
            });
            assert.strictEqual(res.driftConfirmed, false, `ETH Tick ${i} in same candle must not confirm drift`);
            assert.strictEqual(res.blockedOrWaited, false);
        }

        // Tick 6 arrives on next candle timestamp (2000)
        const resNext = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.000015,
            ema20Slope: 0.000012,
            boxPos: 0.50,
            entryPrice: 2500,
            candles: [
                { timestamp: 1000, open: 2500, high: 2510, low: 2495, close: 2500, volume: 10 },
                { timestamp: 2000, open: 2500, high: 2520, low: 2498, close: 2515, volume: 15 }
            ] as any
        });
        assert.strictEqual(resNext.driftConfirmed, true, "Next candle advance must confirm drift for ETH");
        assert.strictEqual(resNext.blockedOrWaited, true);
        assert.strictEqual(resNext.reason, "RANGE_UP_DRIFT_SHORT_WAIT_UPPER_EDGE");
    });

    await t.test("CASE 18: DOWN pending -> NONE -> same DOWN returns: confirmed blocked on first evaluation of new drift", () => {
        resetRangeDriftHysteresis("BTCUSDT");

        // 1. Tick on candle 1000 with DOWN drift -> pending count starts
        const res1 = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            candles: [{ timestamp: 1000, open: 65000, high: 65050, low: 64950, close: 65000, volume: 10 }] as any
        });
        assert.strictEqual(res1.driftConfirmed, false);

        // 2. Slope returns to deadband (NONE) -> state MUST be deleted/reset
        const resNone = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.0000005, // inside deadband
            ema20Slope: -0.0000005,       // inside deadband
            boxPos: 0.50,
            entryPrice: 65000,
            candles: [{ timestamp: 2000, open: 65000, high: 65050, low: 64950, close: 65000, volume: 10 }] as any
        });
        assert.strictEqual(resNone.driftDirection, "NONE");
        assert.strictEqual(resNone.blockedOrWaited, false);

        // 3. Same DOWN drift returns on candle 2000 -> must start fresh (consecutive = 1, advance = 0)
        const resNewDown = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            candles: [{ timestamp: 2000, open: 65000, high: 65050, low: 64950, close: 65000, volume: 10 }] as any
        });
        assert.strictEqual(resNewDown.driftConfirmed, false, "Must NOT reuse old count after returning from deadband");
        assert.strictEqual(resNewDown.blockedOrWaited, false);
    });

    await t.test("CASE 19: UP pending -> NONE -> same UP returns: symmetric test, confirmed blocked on first evaluation", () => {
        resetRangeDriftHysteresis("ETHUSDT");

        // 1. Tick on candle 1000 with UP drift
        const res1 = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.000015,
            ema20Slope: 0.000012,
            boxPos: 0.50,
            entryPrice: 2500,
            candles: [{ timestamp: 1000, open: 2500, high: 2510, low: 2495, close: 2500, volume: 10 }] as any
        });
        assert.strictEqual(res1.driftConfirmed, false);

        // 2. Returns to deadband
        const resNone = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.0000005,
            ema20Slope: 0.0000005,
            boxPos: 0.50,
            entryPrice: 2500,
            candles: [{ timestamp: 2000, open: 2500, high: 2510, low: 2495, close: 2500, volume: 10 }] as any
        });
        assert.strictEqual(resNone.driftDirection, "NONE");

        // 3. Same UP drift returns -> must start fresh
        const resNewUp = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.000015,
            ema20Slope: 0.000012,
            boxPos: 0.50,
            entryPrice: 2500,
            candles: [{ timestamp: 2000, open: 2500, high: 2510, low: 2495, close: 2500, volume: 10 }] as any
        });
        assert.strictEqual(resNewUp.driftConfirmed, false, "Must NOT reuse old count after returning from deadband (ETH UP)");
        assert.strictEqual(resNewUp.blockedOrWaited, false);
    });

    await t.test("CASE 20: RANGE DOWN pending -> TREND -> RANGE DOWN: old count reuse blocked", () => {
        resetRangeDriftHysteresis("BTCUSDT");

        // 1. In RANGE with DOWN drift
        evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            candles: [{ timestamp: 1000, open: 65000, high: 65050, low: 64950, close: 65000, volume: 10 }] as any
        });

        // 2. Regime changes to TREND -> state invalidated
        const resTrend = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "TREND",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            candles: [{ timestamp: 2000, open: 65000, high: 65050, low: 64950, close: 65000, volume: 10 }] as any
        });
        assert.strictEqual(resTrend.blockedOrWaited, false);

        // 3. Regime returns to RANGE with DOWN drift -> must start fresh
        const resBack = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            candles: [{ timestamp: 2000, open: 65000, high: 65050, low: 64950, close: 65000, volume: 10 }] as any
        });
        assert.strictEqual(resBack.driftConfirmed, false, "Must NOT reuse old count after TREND regime exit");
        assert.strictEqual(resBack.blockedOrWaited, false);
    });

    await t.test("CASE 21: RANGE UP pending -> SHOCK -> RANGE UP: old count reuse blocked", () => {
        resetRangeDriftHysteresis("ETHUSDT");

        // 1. In RANGE with UP drift
        evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.000015,
            ema20Slope: 0.000012,
            boxPos: 0.50,
            entryPrice: 2500,
            candles: [{ timestamp: 1000, open: 2500, high: 2510, low: 2495, close: 2500, volume: 10 }] as any
        });

        // 2. Subtype switches to SHOCK -> state invalidated
        const resShock = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            marketSubtype: "DOWN_SHOCK_PANIC_LIQUIDATION",
            rangeCenterSlope: 0.000015,
            ema20Slope: 0.000012,
            boxPos: 0.50,
            entryPrice: 2500,
            candles: [{ timestamp: 2000, open: 2500, high: 2510, low: 2495, close: 2500, volume: 10 }] as any
        });
        assert.strictEqual(resShock.blockedOrWaited, false);

        // 3. Subtype returns to normal RANGE FLAT -> must start fresh
        const resBack = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            marketSubtype: "NORMAL_RANGE",
            rangeCenterSlope: 0.000015,
            ema20Slope: 0.000012,
            boxPos: 0.50,
            entryPrice: 2500,
            candles: [{ timestamp: 2000, open: 2500, high: 2510, low: 2495, close: 2500, volume: 10 }] as any
        });
        assert.strictEqual(resBack.driftConfirmed, false, "Must NOT reuse old count after SHOCK bypass");
        assert.strictEqual(resBack.blockedOrWaited, false);
    });

    await t.test("CASE 22: Lower wick / rejection present ONLY in forming candle: confirmation blocked (WAIT_REACTION)", () => {
        // closedCandle 1: flat
        // closedCandle 2: flat, closed low near 64510
        // formingCandle: huge bounce/lower-wick (high 64700, low 64450, close 64680)
        const candles = [
            { open: 64800, high: 64850, low: 64600, close: 64620, volume: 10 },
            { open: 64620, high: 64650, low: 64500, close: 64510, volume: 10 },
            { open: 64510, high: 64700, low: 64450, close: 64680, volume: 20 } // forming candle only!
        ];

        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.15, // favorable lower edge
            entryPrice: 64680,
            boxHigh: 65500,
            boxLow: 64500,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles
        });

        assert.strictEqual(res.reactionConfirmed, false, "Forming candle reaction MUST NOT be confirmed");
        assert.strictEqual(res.blockedOrWaited, true);
        assert.strictEqual(res.decisionAfter, "WAIT");
        assert.strictEqual(res.reason, "RANGE_DOWN_DRIFT_LONG_WAIT_REACTION");
    });

    await t.test("CASE 23: Next candle arrives and structure is confirmed on closed candle: confirmation allowed (ENTER)", () => {
        // Now the previous forming candle has CLOSED as the 2nd closed candle!
        // A new in-flight candle is now at the end.
        const candles = [
            { open: 64800, high: 64850, low: 64600, close: 64620, volume: 10 },
            { open: 64510, high: 64700, low: 64450, close: 64680, volume: 20 }, // NOW CLOSED!
            { open: 64680, high: 64690, low: 64670, close: 64685, volume: 5 }   // new in-flight forming
        ];

        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.18,
            entryPrice: 64685,
            boxHigh: 65500,
            boxLow: 64500,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles
        });

        assert.strictEqual(res.reactionConfirmed, true, "Closed candle reaction MUST be confirmed");
        assert.strictEqual(res.blockedOrWaited, false);
        assert.strictEqual(res.decisionAfter, "ENTER");
        assert.strictEqual(res.reason, null);
    });

    await t.test("CASE 24: Insufficient closed candles (< 2 closed, < 3 total): safe WAIT (reaction unconfirmed)", () => {
        // Only 2 candles provided -> closedCandles.length is 1 (< 2 required closed candles)
        const candles = [
            { open: 64600, high: 64650, low: 64450, close: 64520, volume: 10 },
            { open: 64520, high: 64700, low: 64480, close: 64680, volume: 15 }
        ];

        const res = evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.18,
            entryPrice: 64680,
            boxHigh: 65500,
            boxLow: 64500,
            consecutiveEvaluations: 2,
            candleAdvanceCount: 1,
            candles
        });

        assert.strictEqual(res.reactionConfirmed, false, "Insufficient closed candles must yield reactionConfirmed=false");
        assert.strictEqual(res.blockedOrWaited, true);
        assert.strictEqual(res.decisionAfter, "WAIT");
        assert.strictEqual(res.reason, "RANGE_DOWN_DRIFT_LONG_WAIT_REACTION");
    });

    await t.test("CASE 25: BTC/ETH symbol state isolation verified across drift state changes", () => {
        resetRangeDriftHysteresis();

        // 1. BTC accumulates DOWN drift state
        evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            candles: [{ timestamp: 1000, open: 65000, high: 65050, low: 64950, close: 65000, volume: 10 }] as any
        });

        // 2. ETH is evaluated in neutral RANGE -> must NOT be affected by BTC state
        const resEth = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.0000005, // inside deadband
            ema20Slope: 0.0000005,
            boxPos: 0.50,
            entryPrice: 2500,
            candles: [{ timestamp: 1000, open: 2500, high: 2510, low: 2495, close: 2500, volume: 10 }] as any
        });
        assert.strictEqual(resEth.driftDirection, "NONE");
        assert.strictEqual(resEth.blockedOrWaited, false);

        // 3. Invalidate BTC via TREND
        evaluateRangeDriftEntryTimingGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            canonicalRegime: "TREND",
            rangePhase: "FLAT",
            rangeCenterSlope: -0.00001,
            ema20Slope: -0.00001,
            boxPos: 0.50,
            entryPrice: 65000,
            candles: [{ timestamp: 2000, open: 65000, high: 65050, low: 64950, close: 65000, volume: 10 }] as any
        });

        // 4. ETH now experiences UP drift -> must start cleanly at evaluation 1
        const resEthUp = evaluateRangeDriftEntryTimingGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            canonicalRegime: "RANGE",
            rangePhase: "FLAT",
            rangeCenterSlope: 0.000015,
            ema20Slope: 0.000012,
            boxPos: 0.50,
            entryPrice: 2500,
            candles: [{ timestamp: 2000, open: 2500, high: 2510, low: 2495, close: 2500, volume: 10 }] as any
        });
        assert.strictEqual(resEthUp.driftConfirmed, false, "ETH must start fresh with driftConfirmed=false");
        assert.strictEqual(resEthUp.blockedOrWaited, false);
    });
});
