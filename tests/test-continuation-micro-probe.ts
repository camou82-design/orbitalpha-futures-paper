import { runEngineV2, marketJudgmentCacheBySymbol } from "../src/engine-v2/index";
import { EngineV2Input } from "../src/engine-v2/types";
import * as detector from "../src/engine-v2/market-judgment/detector";
import * as rangeExecutor from "../src/engine-v2/executors/range-executor";

let passedCount = 0;
let failedCount = 0;

function assertTest(name: string, ok: boolean, message?: string) {
    if (ok) {
        console.log(`[PASS] ${name}`);
        passedCount++;
    } else {
        console.error(`[FAIL] ${name}` + (message ? `: ${message}` : ""));
        failedCount++;
    }
}

const origDetect = detector.detectMarketRegime;
const origRange = rangeExecutor.executeRangeRegime;

function buildBaseInput(overrides: any = {}): EngineV2Input {
    return {
        run_cycle_id: "cycle-test",
        symbol: "BTCUSDT",
        evaluationMode: "authoritative",
        now: Date.now(),
        snapshot: {
            lastPrice: 89900,
            latestCandleClose: 89900,
            closedClose: 89800,
            boxHigh: 92000,
            boxLow: 91000,
            boxPos: -0.1,
            rangeConfidence: 0.8,
            ema20: 92000,
            emaGap: -2100,
            volatilityProxy: 500,
            boxCohesion01: 0.8,
            breakoutFailureRate: 0.2,
            trendWeaknessScore: 0.2,
            rangeOscillationScore: 0.2,
            reviewing_ticks: 2,
            regimeExitRisk: 0.1,
            boxBreakSide: "lower",
            signal: "WAIT_RECHECK",
            qualityScore: 10,
            data_ready: true,
            atr: 500,
            atr20: 500,
            boxLowSlope: -0.1,
            rcSlope: -0.1,
            boxHighSlope: 0,
            candles: [],
            ...overrides.snapshot
        } as any,
        config: {
            paperMaxOpenPositions: 1,
            paperReentryCooldownMs: 1000,
            baseSizeUsd: 100,
            okxLiveMaxOrderNotionalUsdt: 50000,
            okxLiveMaxAddonNotionalUsdt: 50000,
            okxLiveMaxSymbolNotionalUsdt: 100000,
            okxLiveMaxAccountNotionalUsdt: 200000,
            ...overrides.config
        },
        state: {
            currentPositions: [],
            directionalShockState: "NONE",
            longAllow: true,
            shortAllow: true,
            executionReadiness: true,
            paperExecutionReady: true,
            signedExecutionReady: true,
            accountEquityKrw: 10000000,
            maxUsableMarginKrw: 1000000,
            exposureNotionalCapKrw: 50000000,
            accountEquityUsdt: 10000,
            availableBalanceUsdt: 10000,
            ...overrides.state
        } as any
    };
}

function runTestCase(name: string, setupObj: any) {
    console.log(`--- ${name} ---`);
    const input = buildBaseInput(setupObj.inputOverrides);
    
    marketJudgmentCacheBySymbol.set(input.symbol, {
        runCycleId: input.run_cycle_id,
        judgment: {
            regime: "RANGE",
            subtype: "WHIPSAW_SHOCK_RECHECK",
            trendPhase: setupObj.trendPhase ?? "DOWN",
            shockPhase: setupObj.shockPhase ?? "NONE",
            confidenceLevel: "HIGH",
            htf_entry_policy: setupObj.htfPolicy ?? "SHORT_ONLY_OR_NONE",
            counter_trend_risk: setupObj.counterTrendRisk ?? false,
            metadata: {}
        } as any,
        candleCount: 999999
    });
    
    (rangeExecutor as any).executeRangeRegime = (inp: any, j: any) => {
        return {
            signal: "WAIT_RECHECK",
            side: "none",
            reason: "WHIPSAW_SHOCK_RECHECK_RANGE_HOLD",
            baseSizeIntent: 0,
            stopPrice: null,
            invalidationPx: null,
            metadata: {
                watchBoundary: setupObj.watchBoundary,
                watchStartedCandleTs: 1000000
            }
        };
    };

    const result = runEngineV2(input);
    
    try {
        setupObj.assert(result);
        assertTest(name, true);
    } catch (e: any) {
        assertTest(name, false, e.message);
    }
}

// 1. short micro probe 최종 ENTER
runTestCase("Short Micro Probe Final Enter", {
    watchBoundary: 91000,
    inputOverrides: {
        snapshot: { lastPrice: 89900, closedClose: 89800, emaGap: -100 }
    },
    assert: (res: any) => {
        if (res.decision.decision !== "ENTER" || res.decision.side !== "short") throw new Error("Expected ENTER short");
        if (!res.metrics.micro_probe_active) throw new Error("Missing micro_probe_active metadata");
        if (res.metrics.primary_missing_condition !== null) throw new Error("primary_missing_condition should be null");
        if (res.metrics.expectedNextAction !== "WAIT_FOR_RETEST_BEFORE_ADDON") throw new Error("expectedNextAction mismatch");
    }
});

// 2. long micro probe 최종 ENTER
runTestCase("Long Micro Probe Final Enter", {
    watchBoundary: 92000,
    trendPhase: "UP",
    htfPolicy: "LONG_ONLY_OR_NONE",
    inputOverrides: {
        snapshot: { 
            lastPrice: 92100, closedClose: 92200, emaGap: 100, boxHighSlope: 0.1, rcSlope: 0.1 
        }
    },
    assert: (res: any) => {
        if (res.decision.decision !== "ENTER" || res.decision.side !== "long") throw new Error(`Expected ENTER long, got ${res.decision.decision} ${res.decision.side}`);
    }
});

// 3. watchBoundary가 execution.metadata에서 전달 안됨 -> WATCH_BOUNDARY_MISSING
runTestCase("WATCH_BOUNDARY_MISSING Block", {
    watchBoundary: null, // missing
    assert: (res: any) => {
        if (res.decision.decision === "ENTER") throw new Error("Should not ENTER when boundary missing");
    }
});

// 4. 확정 종가 미이탈 차단
runTestCase("No Candle Breakdown Block", {
    watchBoundary: 91000,
    inputOverrides: {
        snapshot: { lastPrice: 89900, closedClose: 91500 } // closedClose is above boundary
    },
    assert: (res: any) => {
        if (res.decision.decision === "ENTER") throw new Error("Should not ENTER when candle not closed outside");
    }
});

// 5. 거리 초과 차단
runTestCase("Distance Too Wide Block", {
    watchBoundary: 91000,
    inputOverrides: {
        snapshot: { lastPrice: 80000, closedClose: 79000 } // super far
    },
    assert: (res: any) => {
        if (res.decision.decision === "ENTER") throw new Error("Should block wide distance");
    }
});

// 6. shockPhase 차단
runTestCase("Shock Phase Block", {
    watchBoundary: 91000,
    shockPhase: "DOWN_SHOCK",
    inputOverrides: {
        snapshot: { lastPrice: 89900, closedClose: 89800 }
    },
    assert: (res: any) => {
        if (res.decision.decision === "ENTER") throw new Error("Should block due to shock phase");
    }
});

// 7. 반대 HTF 정책 차단
runTestCase("Opposite HTF Policy Block", {
    watchBoundary: 91000,
    htfPolicy: "LONG_ONLY_OR_NONE", // want short, but htf is long
    inputOverrides: {
        snapshot: { lastPrice: 89900, closedClose: 89800 }
    },
    assert: (res: any) => {
        if (res.decision.decision === "ENTER") throw new Error("Should block opposite HTF policy");
    }
});

// 8. counter_trend_risk true이면 사이즈 최대 0.15
runTestCase("Counter Trend Risk Size Cap", {
    watchBoundary: 91000,
    counterTrendRisk: true,
    inputOverrides: {
        snapshot: { lastPrice: 89900, closedClose: 89800 }
    },
    assert: (res: any) => {
        if (res.decision.decision !== "ENTER") throw new Error("Expected ENTER");
        if (res.metrics.rawMetrics.sizingMultiplier > 0.15) throw new Error(`Size multiplier exceeds 0.15, got ${res.metrics.rawMetrics.sizingMultiplier}`);
    }
});

// 9. 정상 조건이면 손절 감사 통과 + 10. 동일 setupKey 두 번째 진입 차단
runTestCase("Setup Key Consumption and Duplicate Block", {
    watchBoundary: 91000,
    inputOverrides: {
        snapshot: { lastPrice: 89900, closedClose: 89800 }
    },
    assert: (res: any) => {
        if (res.decision.decision !== "ENTER") throw new Error("Expected first ENTER");
        
        // Second run with same input should block because setup consumed
        const input2 = buildBaseInput({
            snapshot: { lastPrice: 89900, closedClose: 89800, emaGap: -100 }
        });
        input2.run_cycle_id = "cycle-test-2";
        marketJudgmentCacheBySymbol.set(input2.symbol, {
            runCycleId: input2.run_cycle_id,
            judgment: {
                regime: "RANGE",
                subtype: "WHIPSAW_SHOCK_RECHECK",
                trendPhase: "DOWN",
                shockPhase: "NONE",
                confidenceLevel: "HIGH",
                htf_entry_policy: "SHORT_ONLY_OR_NONE",
                counter_trend_risk: false,
                metadata: {}
            } as any,
            candleCount: 999999
        });
        const res2 = runEngineV2(input2);
        if (res2.decision.decision === "ENTER") throw new Error("Expected second probe to be blocked by duplicate setup key");
    }
});

(detector as any).detectMarketRegime = origDetect;
(rangeExecutor as any).executeRangeRegime = origRange;

if (failedCount > 0) {
    console.error(`Tests failed: ${failedCount}`);
    process.exit(1);
} else {
    console.log(`All ${passedCount} tests passed!`);
    process.exit(0);
}
