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
            { open: 64520, high: 64700, low: 64480, close: 64680, volume: 15 }
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
            { open: 2545, high: 2552, low: 2520, close: 2525, volume: 12 }
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
});
