import assert from "node:assert";
import { executeRangeRegime } from "./engine-v2/executors/range-executor";
import { executeTrendRegime } from "./engine-v2/executors/trend-executor";
import { evaluateRangePostShockGuard } from "./engine-v2/market-judgment/range-post-shock-guard";
import { EngineV2Input, MarketJudgmentOutput } from "./engine-v2/types";

console.log("=== RUNNING POST-SHOCK RANGE CHASE GUARD REGRESSION TESTS ===");

function createCandle(ts: number, open: number, high: number, low: number, close: number, vol = 100) {
    return { ts, open, high, low, close, volume: vol };
}

// 1. Fixture: 2026-09-24 BTC 11:31 KST (02:31 UTC) Short Entry Case
// History: Drop from 84,500 to 83,800 (drop of ~700 USD, 0.83%), then bounce to 84,134 (boxPos ~0.75, isUpper)
function createBtc0231Fixture(): { input: EngineV2Input; judgment: MarketJudgmentOutput } {
    const candles: any[] = [];
    const baseTs = 1790215000000;
    
    // Candles 0 to 5: High prices around 84,500
    for (let i = 0; i <= 5; i++) {
        candles.push(createCandle(baseTs + i * 60000, 84500, 84550, 84450, 84500));
    }
    // Candles 6 to 10: Sharp drop down to 83,800 (DOWN SHOCK)
    candles.push(createCandle(baseTs + 6 * 60000, 84500, 84500, 84200, 84250));
    candles.push(createCandle(baseTs + 7 * 60000, 84250, 84300, 83950, 84000));
    candles.push(createCandle(baseTs + 8 * 60000, 84000, 84050, 83800, 83820)); // Shock bottom at idx 8
    
    // Candles 9 to 11: Immediate dead-cat bounce to 84,134 (only 1~2 candles since shock bottom, no stabilization)
    candles.push(createCandle(baseTs + 9 * 60000, 83820, 84020, 83810, 84000));
    candles.push(createCandle(baseTs + 10 * 60000, 84000, 84150, 83980, 84134));
    candles.push(createCandle(baseTs + 11 * 60000, 84134, 84160, 84120, 84135)); // in-flight

    const input: EngineV2Input = {
        symbol: "BTCUSDT",
        evaluationMode: "authoritative",
        run_cycle_id: "test-btc-0231",
        snapshot: {
            symbol: "BTCUSDT",
            lastPrice: 84134.6,
            boxHigh: 84200,
            boxLow: 83800,
            boxPos: 0.75, // Upper edge perception
            boxCohesion01: 0.30, // Unstable box
            rangeConfidence: 0.70,
            atr: 150,
            candles,
            reversal_confirmed: true
        } as any,
        state: {
            directionalShockState: "DOWN",
            rawDirectionalShockState: "DOWN",
            longAllow: true,
            shortAllow: true,
            currentPositions: []
        } as any
    };

    const judgment: MarketJudgmentOutput = {
        regime: "RANGE",
        trendPhase: "FLAT",
        shockPhase: "DOWN_SHOCK",
        subtype: "NONE",
        subtypeReason: "Range High Rejection Short",
        activeEngine: "RANGE_EXECUTOR",
        reversalConfirmed: true,
        metadata: {
            reversal_confirmed: true
        }
    };

    return { input, judgment };
}

// 2. Fixture: 2026-09-24 ETH 11:32 KST (02:32 UTC) Short Entry Case
// History: Drop from 2,720 to 2,672 (drop of ~48 USD, 1.76%), then bounce to 2,678.73 (boxPos ~0.793, isUpper)
function createEth0232Fixture(): { input: EngineV2Input; judgment: MarketJudgmentOutput } {
    const candles: any[] = [];
    const baseTs = 1790215000000;

    // Candles 0 to 5: High prices around 2,720
    for (let i = 0; i <= 5; i++) {
        candles.push(createCandle(baseTs + i * 60000, 2720, 2725, 2715, 2720));
    }
    // Candles 6 to 9: Sharp drop down to 2,672 (DOWN SHOCK)
    candles.push(createCandle(baseTs + 6 * 60000, 2720, 2720, 2695, 2700));
    candles.push(createCandle(baseTs + 7 * 60000, 2700, 2705, 2680, 2685));
    candles.push(createCandle(baseTs + 8 * 60000, 2685, 2690, 2672, 2674)); // Shock bottom at idx 8

    // Candles 9 to 11: Dead-cat bounce to 2,678.73 (boxPos 0.793, only 2 candles post-shock)
    candles.push(createCandle(baseTs + 9 * 60000, 2674, 2680, 2673, 2677));
    candles.push(createCandle(baseTs + 10 * 60000, 2677, 2682, 2676, 2678.73));
    candles.push(createCandle(baseTs + 11 * 60000, 2678.73, 2680, 2677, 2678.5)); // in-flight

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        evaluationMode: "authoritative",
        run_cycle_id: "test-eth-0232",
        snapshot: {
            symbol: "ETHUSDT",
            lastPrice: 2678.73,
            boxHigh: 2682,
            boxLow: 2670,
            boxPos: 0.793, // Upper zone perception
            boxCohesion01: 0.28,
            rangeConfidence: 0.72,
            atr: 8.5,
            candles,
            reversal_confirmed: true
        } as any,
        state: {
            directionalShockState: "DOWN",
            rawDirectionalShockState: "DOWN",
            longAllow: true,
            shortAllow: true,
            currentPositions: []
        } as any
    };

    const judgment: MarketJudgmentOutput = {
        regime: "RANGE",
        trendPhase: "FLAT",
        shockPhase: "DOWN_SHOCK",
        subtype: "NONE",
        subtypeReason: "Range Upper Edge Reversal",
        activeEngine: "RANGE_EXECUTOR",
        reversalConfirmed: true,
        metadata: {
            reversal_confirmed: true
        }
    };

    return { input, judgment };
}

// 3. Fixture: Stabilized RANGE Short Entry (Allowed after shock has decayed, box formed & retested)
function createStabilizedRangeFixture(): { input: EngineV2Input; judgment: MarketJudgmentOutput } {
    const candles: any[] = [];
    const baseTs = 1790215000000;

    // Past shock was 20 candles ago
    candles.push(createCandle(baseTs, 2720, 2720, 2672, 2674));
    // Since then, 12 candles formed a clear stable box between 2670 and 2685
    for (let i = 1; i <= 10; i++) {
        const p = 2670 + (i % 3) * 5;
        candles.push(createCandle(baseTs + i * 60000, p, p + 4, p - 3, p + 2));
    }
    // Recent candle tests upper boundary 2685 and gets rejected (wick down)
    candles.push(createCandle(baseTs + 11 * 60000, 2682, 2685.5, 2680, 2681));
    candles.push(createCandle(baseTs + 12 * 60000, 2681, 2682, 2679, 2680));
    candles.push(createCandle(baseTs + 13 * 60000, 2680, 2681, 2679, 2680)); // in-flight

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        evaluationMode: "authoritative",
        run_cycle_id: "test-eth-stabilized",
        snapshot: {
            symbol: "ETHUSDT",
            lastPrice: 2680,
            boxHigh: 2685,
            boxLow: 2670,
            boxPos: 0.80,
            boxCohesion01: 0.65, // Well stabilized
            rangeConfidence: 0.80,
            atr: 6.0,
            candles,
            reversal_confirmed: true
        } as any,
        state: {
            directionalShockState: "NONE", // Shock decayed
            rawDirectionalShockState: "NONE",
            longAllow: true,
            shortAllow: true,
            currentPositions: []
        } as any
    };

    const judgment: MarketJudgmentOutput = {
        regime: "RANGE",
        trendPhase: "FLAT",
        shockPhase: "NONE",
        subtype: "NONE",
        subtypeReason: "Upper edge reversal identified by price reaction",
        activeEngine: "RANGE_EXECUTOR",
        reversalConfirmed: true,
        metadata: {
            reversal_confirmed: true
        }
    };

    return { input, judgment };
}

// 4. Fixture: Normal TREND Executor (Must remain completely untouched)
function createTrendFixture(): { input: EngineV2Input; judgment: MarketJudgmentOutput } {
    const input: EngineV2Input = {
        symbol: "BTCUSDT",
        evaluationMode: "authoritative",
        run_cycle_id: "test-trend-01",
        snapshot: {
            symbol: "BTCUSDT",
            lastPrice: 84000,
            boxHigh: 84500,
            boxLow: 83500,
            boxPos: 0.50,
            emaGap: -0.005,
            atr: 120,
            candles: []
        } as any,
        state: {
            directionalShockState: "DOWN",
            longAllow: false,
            shortAllow: true,
            currentPositions: []
        } as any
    };

    const judgment: MarketJudgmentOutput = {
        regime: "TREND",
        trendPhase: "DOWN",
        shockPhase: "DOWN_SHOCK",
        subtype: "NONE",
        subtypeReason: "Down trend continuation",
        activeEngine: "TREND_EXECUTOR",
        reversalConfirmed: false,
        metadata: {}
    };

    return { input, judgment };
}

// --- TEST EXECUTION ---

// Test 1: BTC 11:31 KST short must be BLOCKED
{
    const { input, judgment } = createBtc0231Fixture();
    const result = executeRangeRegime(input, judgment);
    console.log("[TEST 1 - BTC 11:31 KST]", result.signal, "| Reason:", result.reason);
    assert.notStrictEqual(result.signal, "SHORT_CANDIDATE", "BTC 11:31 Short MUST be blocked!");
    assert.strictEqual(result.signal, "WAIT_RECHECK", "BTC 11:31 Short should be WAIT_RECHECK");
    assert(result.reason.includes("POST_DOWN_SHOCK_SHORT") || result.reason.includes("WAIT"), "Expected post-shock wait reason");
    console.log("-> PASS: BTC 11:31 KST Short correctly blocked by Post-Shock Chase Guard.");
}

// Test 2: ETH 11:32 KST short must be BLOCKED
{
    const { input, judgment } = createEth0232Fixture();
    const result = executeRangeRegime(input, judgment);
    console.log("[TEST 2 - ETH 11:32 KST]", result.signal, "| Reason:", result.reason);
    assert.notStrictEqual(result.signal, "SHORT_CANDIDATE", "ETH 11:32 Short MUST be blocked!");
    assert.strictEqual(result.signal, "WAIT_RECHECK", "ETH 11:32 Short should be WAIT_RECHECK");
    assert(result.reason.includes("POST_DOWN_SHOCK_SHORT") || result.reason.includes("WAIT"), "Expected post-shock wait reason");
    console.log("-> PASS: ETH 11:32 KST Short correctly blocked by Post-Shock Chase Guard.");
}

// Test 3: Stabilized RANGE entry with confirmed structure must be ALLOWED
{
    const { input, judgment } = createStabilizedRangeFixture();
    const result = executeRangeRegime(input, judgment);
    console.log("[TEST 3 - Stabilized RANGE]", result.signal, "| Reason:", result.reason);
    assert.strictEqual(result.signal, "SHORT_CANDIDATE", "Stabilized RANGE Short MUST be allowed!");
    console.log("-> PASS: Stabilized RANGE entry with structural reaction is cleanly allowed.");
}

// Test 4: Normal TREND executor remains completely untouched
{
    const { input, judgment } = createTrendFixture();
    const result = executeTrendRegime(input, judgment);
    console.log("[TEST 4 - Normal TREND]", result.signal, "| Reason:", result.reason);
    assert.strictEqual(result.signal, "SHORT_CANDIDATE", "TREND Short MUST remain operational!");
    console.log("-> PASS: TREND executor operation is 100% preserved.");
}

console.log("\n=== ALL REGRESSION TESTS PASSED SUCCESSFULLY! ===");
