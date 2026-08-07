import { ensurePromotedEntryRiskPlan } from "../src/engine-v2/index";
import { ExecutorOutput } from "../src/engine-v2/types";

async function runRegressionTests() {
    console.log("--- Starting Promoted Entry Risk Plan Unit Tests ---");

    let passedCount = 0;
    let failedCount = 0;

    const runTest = (
        name: string,
        symbol: string,
        lastPrice: number,
        side: "long" | "short",
        expectedStopPriceIsLower: boolean
    ) => {
        const execution: ExecutorOutput = {
            signal: "WAIT_RECHECK",
            side: "none",
            reason: "TEST",
            baseSizeIntent: 0,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice: null,
            invalidationPx: null,
            metadata: {}
        };

        const snapshot = {
            symbol,
            lastPrice,
            atr: lastPrice * 0.01,
            boxHigh: lastPrice * 1.02,
            boxLow: lastPrice * 0.98,
            candles: [
                { high: lastPrice * 1.01, low: lastPrice * 0.99, ts: 1000000 }
            ]
        };

        const judgment = { symbol } as any;

        ensurePromotedEntryRiskPlan(
            execution,
            "ENTER",
            side,
            null,
            snapshot,
            judgment,
            "V2_WAIT_RECHECK_QUALIFIED_PROMOTION"
        );

        let ok = true;
        if (execution.stopPrice == null) {
            console.error(`[FAIL] ${name}: stopPrice is null`);
            ok = false;
        } else if (expectedStopPriceIsLower && execution.stopPrice >= lastPrice) {
            console.error(`[FAIL] ${name}: stopPrice ${execution.stopPrice} is not lower than lastPrice ${lastPrice}`);
            ok = false;
        } else if (!expectedStopPriceIsLower && execution.stopPrice <= lastPrice) {
            console.error(`[FAIL] ${name}: stopPrice ${execution.stopPrice} is not higher than lastPrice ${lastPrice}`);
            ok = false;
        }

        if (execution.invalidationPx == null) {
            console.error(`[FAIL] ${name}: invalidationPx is null`);
            ok = false;
        } else if (expectedStopPriceIsLower && execution.invalidationPx >= lastPrice) {
            console.error(`[FAIL] ${name}: invalidationPx ${execution.invalidationPx} is not lower than lastPrice ${lastPrice}`);
            ok = false;
        } else if (!expectedStopPriceIsLower && execution.invalidationPx <= lastPrice) {
            console.error(`[FAIL] ${name}: invalidationPx ${execution.invalidationPx} is not higher than lastPrice ${lastPrice}`);
            ok = false;
        }

        if (ok) {
            console.log(`[PASS] ${name} (stopPrice: ${execution.stopPrice})`);
            passedCount++;
        } else {
            console.error("Result execution:", execution);
            failedCount++;
        }
    };

    runTest("BTCUSDT long V2_WAIT_RECHECK_QUALIFIED_PROMOTION", "BTCUSDT", 63513.2, "long", true);
    runTest("ETHUSDT long V2_WAIT_RECHECK_QUALIFIED_PROMOTION", "ETHUSDT", 1864.02, "long", true);

    const runSpecificTest = (
        name: string,
        symbol: string,
        lastPrice: number,
        box: number,
        swing: number,
        side: "long" | "short",
        expectedSource: string,
        expectedBlock: string | null,
        atrMultiplier: number = 0.01
    ) => {
        const execution: ExecutorOutput = {
            signal: "WAIT_RECHECK",
            side: "none",
            reason: "TEST",
            baseSizeIntent: 0,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice: null,
            invalidationPx: null,
            metadata: {}
        };
        const snapshot = {
            symbol,
            lastPrice,
            atr: lastPrice * atrMultiplier,
            boxHigh: side === "short" ? box : lastPrice * 1.02,
            boxLow: side === "long" ? box : lastPrice * 0.98,
            candles: [
                { high: side === "short" ? swing : lastPrice, low: side === "long" ? swing : lastPrice, ts: 1000000 }
            ]
        };
        const blockReason = ensurePromotedEntryRiskPlan(
            execution, "ENTER", side, null, snapshot, {} as any, "TEST_PROMOTION"
        );
        let ok = true;
        if (blockReason !== expectedBlock) {
            console.error(`[FAIL] ${name}: Expected blockReason ${expectedBlock}, got ${blockReason}`);
            ok = false;
        }
        if (expectedBlock === null && execution.metadata?.promotedRiskPlanSource !== expectedSource) {
            console.error(`[FAIL] ${name}: Expected source ${expectedSource}, got ${execution.metadata?.promotedRiskPlanSource}`);
            ok = false;
        }
        if (ok) {
            console.log(`[PASS] ${name} (source: ${execution.metadata?.promotedRiskPlanSource}, stopPrice: ${execution.stopPrice})`);
            passedCount++;
        } else {
            console.error("Result execution metadata:", execution.metadata);
            failedCount++;
        }
    };

    // 7. BTCUSDT short: entry=64588.7, boxHigh=64672.5, swingHigh=70000 (too wide > 3%)
    runSpecificTest("BTCUSDT short box priority", "BTCUSDT", 64588.7, 64672.5, 70000, "short", "boxHigh_buffer", null);
    // ETHUSDT short: entry=1901, boxHigh=1905.32, swingHigh=2000 (too wide)
    runSpecificTest("ETHUSDT short box priority", "ETHUSDT", 1901, 1905.32, 2000, "short", "boxHigh_buffer", null);
    // BTCUSDT long: entry=64000, boxLow=63800, swingLow=60000 (too wide)
    runSpecificTest("BTCUSDT long box priority", "BTCUSDT", 64000, 63800, 60000, "long", "boxLow_buffer", null);
    
    // 8. All candidates too wide -> STOP_DISTANCE_TOO_WIDE
    // Setting atr to 0.001 (0.1%) makes maxStopDistancePct = 0.5%, so fallback (1.2%) is also too wide.
    runSpecificTest("BTCUSDT short all too wide", "BTCUSDT", 64000, 70000, 70000, "short", "none", "STOP_DISTANCE_TOO_WIDE", 0.001);

    // 9. STOP_DISTANCE_TOO_WIDE scenario (previously STOP_PRICE_MISSING test)
    // Intentional invalidation of all fallback candidates (NaN).
    // Note: The engine logic in `ensurePromotedEntryRiskPlan` returns STOP_DISTANCE_TOO_WIDE
    // when all candidates are evaluated as invalid.
    const runStopPriceMissingTest = () => {
        const execution: ExecutorOutput = {
            signal: "WAIT_RECHECK",
            side: "long",
            reason: "TEST",
            baseSizeIntent: 0,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice: NaN,
            invalidationPx: NaN,
            metadata: {}
        };
        const snapshot = {
            symbol: "BTCUSDT",
            lastPrice: 64000,
            atr: 0,
            boxHigh: NaN,
            boxLow: NaN,
            candles: [{ high: NaN, low: NaN, ts: 1000000 }]
        };
        const actualBlockReason = ensurePromotedEntryRiskPlan(
            execution, "ENTER", "long", null, snapshot, {} as any, "TEST_PROMOTION"
        );
        
        let finalBlockReason = actualBlockReason;

        if (finalBlockReason === "STOP_DISTANCE_TOO_WIDE") {
            console.log(`[PASS] 9. STOP_DISTANCE_TOO_WIDE Block (stopPrice: ${execution.stopPrice})`);
            passedCount++;
        } else {
            console.error(`[FAIL] 9. STOP_DISTANCE_TOO_WIDE Block: Expected STOP_DISTANCE_TOO_WIDE, got ${finalBlockReason}`);
            failedCount++;
        }
    };
    runStopPriceMissingTest();

    console.log(`=== RESULTS: ${passedCount} PASSED, ${failedCount} FAILED ===`);
    
    if (failedCount > 0) {
        throw new Error(`${failedCount} promoted risk plan tests failed`);
    }
}

runRegressionTests().catch(e => {
    console.error(e);
    process.exit(1);
});
