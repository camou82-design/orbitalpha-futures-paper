import { executeRangeRegime, rangeContinuationStateMap } from "../src/engine-v2/executors/range-executor";
import { EngineV2Input } from "../src/engine-v2/types";

function buildInput(symbol: string, overrides: Partial<EngineV2Input> = {}): EngineV2Input {
    const input: EngineV2Input = {
        symbol,
        run_cycle_id: "cycle_1",
        evaluationMode: "diagnostic",
        snapshot: {
            exchange: "binance",
            timestamp: Date.now(),
            lastPrice: 100,
            boxHigh: 110,
            boxLow: 90,
            boxPos: 0.5,
            rangeConfidence: 0.8,
            breakoutFailureRate: 0.5,
            rangeOscillationScore: 0.6,
            qualityScore: 0.8,
            emaGap: 0,
            atr: 1,
            candles: [
                { ts: 1000, open: 100, high: 105, low: 95, close: 100, volume: 100 },
                { ts: 2000, open: 100, high: 105, low: 95, close: 100, volume: 100 }
            ]
        } as any,
        state: {
            longAllow: true,
            shortAllow: true,
            currentPositions: [],
            marginUsagePct: 0
        } as any,
        ...overrides
    };
    return input;
}

async function runTests() {
    console.log("=== Test A: Short Diagnostic Mutation ===");
    
    // Setup for Test A & B
    rangeContinuationStateMap.set("BTCUSDT", {
        symbol: "BTCUSDT",
        direction: "down",
        phase: "RETEST_TOUCHED",
        consecutiveCycles: 4,
        lastRunCycleId: "cycle_0",
        lastCandleTimestamp: 1000,
        watchBoundaryPrice: 90,
        watchStartedAtTimestamp: Date.now() - 1000,
        totalCyclesSinceWatch: 1,
        countStartedCandleTs: 500,
        hasCandleAdvancedDuringCount: true,
        watchStartedCandleTs: 900,
        lastLoggedRunCycleId: "cycle_0",
        lastLoggedDeadlockBreakdownRunCycleId: null,
        previousConfirmedBoxHigh: 110,
        previousConfirmedBoxLow: 90,
        countBoundaryPrice: 90,
        countBoundarySource: "previous_confirmed",
        lastObservedBoxHigh: 110,
        lastObservedBoxLow: 90,
        lastObservedCandleTs: 1000
    });

    const inputA = buildInput("BTCUSDT", {
        run_cycle_id: "cycle_1",
        evaluationMode: "diagnostic",
        snapshot: {
            ...buildInput("BTCUSDT").snapshot,
            lastPrice: 88, // Below watchBoundary(90) * (1 - 0.003 * 1.5) -> confirmed
            candles: [
                { ts: 1000, open: 95, high: 96, low: 90, close: 95, volume: 100 },
                { ts: 2000, open: 95, high: 96, low: 88, close: 88, volume: 100 }
            ]
        }
    });

    const judgmentA: any = {
        trendPhase: "DOWN",
        shockPhase: "NONE",
        subtype: "NORMAL",
        metadata: {}
    };

    const outA = executeRangeRegime(inputA, judgmentA);
    const stateA = rangeContinuationStateMap.get("BTCUSDT");

    if (outA.signal !== "SHORT_CANDIDATE") {
        throw new Error("Test A failed: Expected SHORT_CANDIDATE for diagnostic, got " + outA.signal);
    }
    if (stateA?.phase !== "RETEST_TOUCHED") {
        throw new Error("Test A failed: Expected shared map phase to remain RETEST_TOUCHED, got " + stateA?.phase);
    }
    console.log("Test A passed.");


    console.log("=== Test B: Short Authoritative ===");
    
    const inputB = { ...inputA, evaluationMode: "authoritative" as any, run_cycle_id: "cycle_2" };
    const outB = executeRangeRegime(inputB, judgmentA);
    const stateB = rangeContinuationStateMap.get("BTCUSDT");

    if (outB.signal !== "SHORT_CANDIDATE") {
        throw new Error("Test B failed: Expected SHORT_CANDIDATE, got " + outB.signal);
    }
    if (outB.side !== "short" || outB.reason !== "BREAKDOWN_RETEST_SHORT_CONFIRMED") {
        throw new Error("Test B failed: Expected short / BREAKDOWN_RETEST_SHORT_CONFIRMED");
    }
    if ((outB.stopPrice ?? 0) <= 90) {
        throw new Error("Test B failed: Expected stopPrice > 90, got " + outB.stopPrice);
    }
    if (stateB?.phase !== "RETEST_CONFIRMED") {
        throw new Error("Test B failed: Expected shared map phase to be RETEST_CONFIRMED, got " + stateB?.phase);
    }
    console.log("Test B passed.");


    console.log("=== Test C: Long Direction Symmetry ===");
    
    rangeContinuationStateMap.set("ETHUSDT", {
        symbol: "ETHUSDT",
        direction: "up",
        phase: "RETEST_TOUCHED",
        consecutiveCycles: 4,
        lastRunCycleId: "cycle_0",
        lastCandleTimestamp: 1000,
        watchBoundaryPrice: 110,
        watchStartedAtTimestamp: Date.now() - 1000,
        totalCyclesSinceWatch: 1,
        countStartedCandleTs: 500,
        hasCandleAdvancedDuringCount: true,
        watchStartedCandleTs: 900,
        lastLoggedRunCycleId: "cycle_0",
        lastLoggedDeadlockBreakdownRunCycleId: null,
        previousConfirmedBoxHigh: 110,
        previousConfirmedBoxLow: 90,
        countBoundaryPrice: 110,
        countBoundarySource: "previous_confirmed",
        lastObservedBoxHigh: 110,
        lastObservedBoxLow: 90,
        lastObservedCandleTs: 1000
    });

    const inputC = buildInput("ETHUSDT", {
        run_cycle_id: "cycle_1",
        evaluationMode: "diagnostic",
        snapshot: {
            ...buildInput("ETHUSDT").snapshot,
            lastPrice: 112,
            candles: [
                { ts: 1000, open: 105, high: 110, low: 105, close: 110, volume: 100 },
                { ts: 2000, open: 110, high: 112, low: 110, close: 112, volume: 100 }
            ]
        }
    });
    
    const judgmentC: any = {
        trendPhase: "UP",
        shockPhase: "NONE",
        subtype: "NORMAL",
        metadata: {}
    };

    const outC = executeRangeRegime(inputC, judgmentC);
    const stateC = rangeContinuationStateMap.get("ETHUSDT");

    if (outC.signal !== "LONG_CANDIDATE") {
        throw new Error("Test C (diagnostic) failed: Expected LONG_CANDIDATE, got " + outC.signal);
    }
    if (stateC?.phase !== "RETEST_TOUCHED") {
        throw new Error("Test C (diagnostic) failed: Expected shared map phase to remain RETEST_TOUCHED");
    }
    
    const inputC_auth = { ...inputC, evaluationMode: "authoritative" as any, run_cycle_id: "cycle_2" };
    const outC_auth = executeRangeRegime(inputC_auth, judgmentC);
    const stateC_auth = rangeContinuationStateMap.get("ETHUSDT");

    if (outC_auth.signal !== "LONG_CANDIDATE" || outC_auth.side !== "long" || outC_auth.reason !== "BREAKOUT_RETEST_LONG_CONFIRMED") {
        throw new Error("Test C (auth) failed: Expected long / BREAKOUT_RETEST_LONG_CONFIRMED, got " + outC_auth.signal);
    }
    if (stateC_auth?.phase !== "RETEST_CONFIRMED") {
        throw new Error("Test C (auth) failed: Expected shared map phase to be RETEST_CONFIRMED");
    }
    console.log("Test C passed.");


    console.log("=== Test D: Diagnostic does not consume authoritative candidate ===");
    
    // Set to CONTINUATION_WATCH and let it touch and confirm
    rangeContinuationStateMap.set("SOLUSDT", {
        symbol: "SOLUSDT",
        direction: "down",
        phase: "CONTINUATION_WATCH",
        consecutiveCycles: 4,
        lastRunCycleId: "cycle_0",
        lastCandleTimestamp: 1000,
        watchBoundaryPrice: 90,
        watchStartedAtTimestamp: Date.now() - 1000,
        totalCyclesSinceWatch: 1,
        countStartedCandleTs: 500,
        hasCandleAdvancedDuringCount: true,
        watchStartedCandleTs: 900,
        lastLoggedRunCycleId: "cycle_0",
        lastLoggedDeadlockBreakdownRunCycleId: null,
        previousConfirmedBoxHigh: 110,
        previousConfirmedBoxLow: 90,
        countBoundaryPrice: 90,
        countBoundarySource: "previous_confirmed",
        lastObservedBoxHigh: 110,
        lastObservedBoxLow: 90,
        lastObservedCandleTs: 1000
    });

    const inputD_diag = buildInput("SOLUSDT", {
        run_cycle_id: "cycle_1",
        evaluationMode: "diagnostic",
        snapshot: {
            ...buildInput("SOLUSDT").snapshot,
            lastPrice: 88,
            candles: [
                { ts: 1000, open: 95, high: 90.1, low: 90, close: 95, volume: 100 }, // Touch
                { ts: 2000, open: 95, high: 96, low: 88, close: 88, volume: 100 }    // Confirm
            ]
        }
    });
    
    const outD_diag = executeRangeRegime(inputD_diag, judgmentA);
    // diagnostic will calculate touch and confirm, but not save it.
    // wait, diagnostic touch sets the local phase to RETEST_TOUCHED, but doesn't persist it.
    // then it evaluates lastPrice against watchBoundary, and locally transitions to RETEST_CONFIRMED.
    // it will return SHORT_CANDIDATE.
    if (outD_diag.signal !== "SHORT_CANDIDATE") {
        throw new Error("Test D (diag) failed: Expected SHORT_CANDIDATE");
    }

    const stateD = rangeContinuationStateMap.get("SOLUSDT");
    if (stateD?.phase !== "CONTINUATION_WATCH") {
        throw new Error("Test D (diag) failed: Expected map to stay CONTINUATION_WATCH, got " + stateD?.phase);
    }
    
    const inputD_auth = { ...inputD_diag, evaluationMode: "authoritative" as any, run_cycle_id: "cycle_2" };
    const outD_auth = executeRangeRegime(inputD_auth, judgmentA);
    const stateD_auth = rangeContinuationStateMap.get("SOLUSDT");

    if (outD_auth.signal !== "SHORT_CANDIDATE") {
        throw new Error("Test D (auth) failed: Expected SHORT_CANDIDATE after diag, got " + outD_auth.signal);
    }
    if (stateD_auth?.phase !== "RETEST_CONFIRMED") {
        throw new Error("Test D (auth) failed: Expected state to become RETEST_CONFIRMED");
    }
    console.log("Test D passed.");

    console.log("ALL REGRESSION TESTS PASSED!");
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
