import assert from "node:assert";
import { executeRangeRegime } from "./engine-v2/executors/range-executor";
import { executeTrendRegime } from "./engine-v2/executors/trend-executor";
import { EngineV2Input, MarketJudgmentOutput, EngineV2ConfigAdapter, EngineV2SnapshotAdapter, EngineV2Regime, EngineV2MarketSubtype } from "./engine-v2/types";
import { Candle } from "./models/types";

console.log("=== RUNNING POST-SHOCK RANGE CHASE GUARD REGRESSION TESTS ===");

function createCandle(ts: number, open: number, high: number, low: number, close: number, vol = 100): Candle {
    return { ts, open, high, low, close, volume: vol };
}

const defaultConfig: EngineV2ConfigAdapter = {
    paperMaxOpenPositions: 3,
    paperReentryCooldownMs: 0,
    baseSizeUsd: 40,
    okxLiveMaxOrderNotionalUsdt: 40
};

function createMockSnapshot(overrides: Partial<EngineV2SnapshotAdapter> & { lastPrice: number }): EngineV2SnapshotAdapter {
    const { lastPrice, ...rest } = overrides;
    return {
        lastPrice,
        latestCandleClose: rest.latestCandleClose ?? lastPrice,
        boxHigh: rest.boxHigh !== undefined ? rest.boxHigh : lastPrice * 1.003,
        boxLow: rest.boxLow !== undefined ? rest.boxLow : lastPrice * 0.997,
        boxPos: rest.boxPos !== undefined ? rest.boxPos : 0.5,
        rangeConfidence: rest.rangeConfidence !== undefined ? rest.rangeConfidence : 0.8,
        ema20: rest.ema20 !== undefined ? rest.ema20 : lastPrice,
        emaGap: rest.emaGap !== undefined ? rest.emaGap : 0,
        volatilityProxy: rest.volatilityProxy !== undefined ? rest.volatilityProxy : 0.005,
        boxCohesion01: rest.boxCohesion01 !== undefined ? rest.boxCohesion01 : 0.5,
        breakoutFailureRate: rest.breakoutFailureRate !== undefined ? rest.breakoutFailureRate : 0,
        trendWeaknessScore: rest.trendWeaknessScore !== undefined ? rest.trendWeaknessScore : 0,
        rangeOscillationScore: rest.rangeOscillationScore !== undefined ? rest.rangeOscillationScore : 0,
        reviewing_ticks: rest.reviewing_ticks !== undefined ? rest.reviewing_ticks : 0,
        regimeExitRisk: rest.regimeExitRisk !== undefined ? rest.regimeExitRisk : 0,
        boxBreakSide: rest.boxBreakSide ?? "none",
        signal: rest.signal ?? "NONE",
        qualityScore: rest.qualityScore !== undefined ? rest.qualityScore : 75,
        data_ready: rest.data_ready ?? true,
        dump_protection_hit: rest.dump_protection_hit ?? false,
        volatility_guard_hit: rest.volatility_guard_hit ?? false,
        entryCandidate: rest.entryCandidate ?? false,
        atr: rest.atr !== undefined ? rest.atr : lastPrice * 0.01,
        candles: rest.candles,
        retestConfirmed: rest.retestConfirmed,
        retestTouched: rest.retestTouched,
        retestRejected: rest.retestRejected,
        ...rest
    };
}

function createMockJudgment(overrides: Partial<MarketJudgmentOutput> & {
    regime: EngineV2Regime;
    subtype: EngineV2MarketSubtype;
}): MarketJudgmentOutput {
    const { regime, subtype, ...rest } = overrides;
    return {
        regime,
        regime_final: rest.regime_final ?? regime,
        subtype,
        subtypeReason: rest.subtypeReason ?? "test",
        shockPhase: rest.shockPhase ?? "NONE",
        rangePhase: rest.rangePhase ?? "NONE",
        trendPhase: rest.trendPhase ?? "NONE",
        transitionPhase: rest.transitionPhase ?? "NONE",
        judgmentVersion: "v2_market_judgment_subtype_v1",
        no_trade_reason: rest.no_trade_reason ?? null,
        data_ready: rest.data_ready ?? true,
        dump_protection_hit: rest.dump_protection_hit ?? false,
        volatility_guard_hit: rest.volatility_guard_hit ?? false,
        reason: rest.reason ?? "test",
        metrics: rest.metrics ?? {
            rangeScore: 80,
            trendScore: 20,
            boxCohesionCollapse: false,
            mixedBreakoutState: false,
            emaExpansionWeak: false
        },
        metadata: rest.metadata ?? {},
        ...rest
    };
}

// 1. Fixture: 2026-09-24 BTC 11:31 KST (02:31 UTC) Short Entry Case
// History: Drop from 84,500 to 83,800 (drop of ~700 USD, 0.83%), then bounce to 84,134 (boxPos ~0.75, isUpper)
function createBtc0231Fixture(): { input: EngineV2Input; judgment: MarketJudgmentOutput } {
    const candles: Candle[] = [];
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
        now: baseTs + 11 * 60000,
        config: defaultConfig,
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        },
        snapshot: createMockSnapshot({
            lastPrice: 84134.6,
            boxHigh: 84200,
            boxLow: 83800,
            boxPos: 0.75, // Upper edge perception
            boxCohesion01: 0.30, // Unstable box
            rangeConfidence: 0.70,
            atr: 150,
            candles
        }),
        state: {
            directionalShockState: "DOWN",
            longAllow: true,
            shortAllow: true,
            currentPositions: [],
            lossStreaks: {},
            globalRiskScore: 0,
            executionReadiness: true,
            freshTickBarrierActive: false,
            freshTickCompletedCycles: 3,
            freshTickRequiredCycles: 3
        }
    };

    const judgment = createMockJudgment({
        regime: "RANGE",
        regime_final: "RANGE",
        trendPhase: "NONE",
        rangePhase: "UPPER",
        shockPhase: "DOWN_SHOCK",
        transitionPhase: "NONE",
        subtype: "RANGE_UPPER_REACTION",
        subtypeReason: "Range High Rejection Short",
        data_ready: true,
        dump_protection_hit: false,
        metadata: {
            reversal_confirmed: true
        }
    });

    return { input, judgment };
}

// 2. Fixture: 2026-09-24 ETH 11:32 KST (02:32 UTC) Short Entry Case
// History: Drop from 2,720 to 2,672 (drop of ~48 USD, 1.76%), then bounce to 2,678.73 (boxPos ~0.793, isUpper)
function createEth0232Fixture(): { input: EngineV2Input; judgment: MarketJudgmentOutput } {
    const candles: Candle[] = [];
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
        now: baseTs + 11 * 60000,
        config: defaultConfig,
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        },
        snapshot: createMockSnapshot({
            lastPrice: 2678.73,
            boxHigh: 2682,
            boxLow: 2670,
            boxPos: 0.793, // Upper zone perception
            boxCohesion01: 0.28,
            rangeConfidence: 0.72,
            atr: 8.5,
            candles
        }),
        state: {
            directionalShockState: "DOWN",
            longAllow: true,
            shortAllow: true,
            currentPositions: [],
            lossStreaks: {},
            globalRiskScore: 0,
            executionReadiness: true,
            freshTickBarrierActive: false,
            freshTickCompletedCycles: 3,
            freshTickRequiredCycles: 3
        }
    };

    const judgment = createMockJudgment({
        regime: "RANGE",
        regime_final: "RANGE",
        trendPhase: "NONE",
        rangePhase: "UPPER",
        shockPhase: "DOWN_SHOCK",
        transitionPhase: "NONE",
        subtype: "RANGE_UPPER_REACTION",
        subtypeReason: "Range Upper Edge Reversal",
        data_ready: true,
        dump_protection_hit: false,
        metadata: {
            reversal_confirmed: true
        }
    });

    return { input, judgment };
}

// 3. Fixture: Stabilized RANGE Short Entry (Allowed after shock has decayed, box formed & retested)
function createStabilizedRangeFixture(): { input: EngineV2Input; judgment: MarketJudgmentOutput } {
    const candles: Candle[] = [];
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
        now: baseTs + 13 * 60000,
        config: defaultConfig,
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        },
        snapshot: createMockSnapshot({
            lastPrice: 2680,
            boxHigh: 2685,
            boxLow: 2670,
            boxPos: 0.80,
            boxCohesion01: 0.65, // Well stabilized
            rangeConfidence: 0.80,
            atr: 6.0,
            candles
        }),
        state: {
            directionalShockState: "NONE", // Shock decayed
            longAllow: true,
            shortAllow: true,
            currentPositions: [],
            lossStreaks: {},
            globalRiskScore: 0,
            executionReadiness: true,
            freshTickBarrierActive: false,
            freshTickCompletedCycles: 3,
            freshTickRequiredCycles: 3
        }
    };

    const judgment = createMockJudgment({
        regime: "RANGE",
        regime_final: "RANGE",
        trendPhase: "NONE",
        rangePhase: "UPPER",
        shockPhase: "NONE",
        transitionPhase: "NONE",
        subtype: "RANGE_UPPER_REACTION",
        subtypeReason: "Upper edge reversal identified by price reaction",
        data_ready: true,
        dump_protection_hit: false,
        metadata: {
            reversal_confirmed: true
        }
    });

    return { input, judgment };
}

// 4. Fixture: Normal TREND Executor (Must remain completely untouched)
function createTrendFixture(): { input: EngineV2Input; judgment: MarketJudgmentOutput } {
    const input: EngineV2Input = {
        symbol: "BTCUSDT",
        evaluationMode: "authoritative",
        run_cycle_id: "test-trend-01",
        now: 1790215000000,
        config: defaultConfig,
        v1Result: {
            regime: "TREND",
            decision: "ENTER",
            side: "short",
            isBlocked: false
        },
        snapshot: createMockSnapshot({
            lastPrice: 84000,
            boxHigh: 84500,
            boxLow: 83500,
            boxPos: 0.50,
            emaGap: -0.005,
            atr: 120,
            candles: []
        }),
        state: {
            directionalShockState: "DOWN",
            longAllow: false,
            shortAllow: true,
            currentPositions: [],
            lossStreaks: {},
            globalRiskScore: 0,
            executionReadiness: true,
            freshTickBarrierActive: false,
            freshTickCompletedCycles: 3,
            freshTickRequiredCycles: 3
        }
    };

    const judgment = createMockJudgment({
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "DOWN",
        rangePhase: "NONE",
        shockPhase: "DOWN_SHOCK",
        transitionPhase: "NONE",
        subtype: "TREND_DOWN_CONTINUATION",
        subtypeReason: "Down trend continuation",
        data_ready: true,
        dump_protection_hit: false,
        metadata: {}
    });

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
