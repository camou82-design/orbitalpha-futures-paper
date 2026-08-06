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

    console.log(`=== RESULTS: ${passedCount} PASSED, ${failedCount} FAILED ===`);
    
    if (failedCount > 0) {
        throw new Error(`${failedCount} promoted risk plan tests failed`);
    }
}

runRegressionTests().catch(e => {
    console.error(e);
    process.exit(1);
});
