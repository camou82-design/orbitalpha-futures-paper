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
        now: overrides.now ?? Date.now(),
        v1Result: {} as any,
        snapshot: {
            lastPrice: 90800,
            latestCandleClose: 89900,
            closedClose: 90700,
            boxHigh: 92000,
            boxLow: 91000,
            boxPos: -0.1,
            rangeConfidence: 0.8,
            ema20: 92000,
            emaGap: -2100,
            volatilityProxy: 500,
            atr20: 1000,
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
            okxLiveMaxAddonCount: 1,
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
    if (name === "F. Kill Switch Block") console.log("INPUT STATE:", JSON.stringify(input.state));

    
    marketJudgmentCacheBySymbol.set(input.symbol, {
        runCycleId: input.run_cycle_id || "test-cycle",
        judgment: {
            regime: "RANGE",
            subtype: "WHIPSAW_SHOCK_RECHECK",
            trendPhase: setupObj.trendPhase ?? "DOWN",
            shockPhase: setupObj.shockPhase ?? "NONE",
            confidenceLevel: "LOW",
            htf_entry_policy: setupObj.htfPolicy ?? "SHORT_ONLY_OR_NONE",
            counter_trend_risk: setupObj.counterTrendRisk ?? false,
            metrics: { rangeScore: 0.8, trendScore: 0.2 },
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

    rangeExecutor.rangeContinuationStateMap.set(input.symbol, {
        direction: setupObj.direction ?? "down",
        phase: "CONTINUATION_WATCH",
        watchStartedCandleTs: input.now - 60000,
        watchStartedAtTimestamp: input.now - 1000,
        watchBoundaryPrice: setupObj.watchBoundary,
        countStartedCandleTs: null,
        countBoundaryPrice: null,
        hasCandleAdvancedDuringCount: false,
        totalCyclesSinceWatch: 0
    } as any);

    const result = runEngineV2(input);
    
    try {
        setupObj.assert(result);
        assertTest(name, true);
    } catch (e: any) {
        assertTest(name, false, e.message);
    }
}

function buildLiveReadyState(now: number, overrides: any = {}): Record<string, any> {
    return {
        okxAuthMode: "live",
        okxExchangeAuthOptIn: true,
        okxLiveEnabled: true,

        liveBalanceReady: true,
        accountEquityUsdt: 1000,
        availableBalanceUsdt: 1000,

        okxActualPositionsReady: true,
        actualAccountNotionalUsdtReady: true,
        okxPendingOrdersReady: true,

        okxActualPositions: [],
        okxPendingOrdersNotionalUsdt: 0,
        okxPendingSymbolNotionalUsdt: 0,
        currentPositions: [],

        balanceFetchedAt: now - 1000,
        positionsFetchedAt: now - 1000,
        pendingOrdersFetchedAt: now - 1000,
        ...overrides
    };
}

// 1. short micro probe 최종 ENTER
runTestCase("Short Micro Probe Final Enter", {
    watchBoundary: 91000,
    inputOverrides: {
        snapshot: { lastPrice: 90800, closedClose: 90700, emaGap: -2100, boxLowSlope: -0.1, rcSlope: -0.1, qualityScore: 100 },
        state: buildLiveReadyState(Date.now())
    },
    assert: (res: any) => {
        if (res.decision.decision !== "ENTER" || res.decision.side !== "short") throw new Error(`Expected ENTER short, got ${res.decision.decision} ${res.decision.side}`);
        if (res.decision.executionAction !== "ENTER") throw new Error("Expected executionAction ENTER");
        if (res.decision.riskSizing?.isBlocked === true) throw new Error("Expected risk.isBlocked false");
        if ((res.decision.finalOrderNotionalUsdt ?? 0) <= 0) throw new Error("Expected finalOrderNotionalUsdt > 0");
        if (!res.decision.committedRiskPlan) throw new Error("Expected committedRiskPlan");
        
        const source = res.decision.metadata?.promotedRiskPlanSource ?? res.decision.committedRiskPlan?.source;
        if (source !== "continuation_watch_boundary_buffer") throw new Error(`Expected continuation_watch_boundary_buffer, got ${source}`);
        
        const stopPrice = res.decision.committedRiskPlan?.stopPrice ?? res.decision.stop_price ?? 0;
        if (stopPrice <= 0) throw new Error("Expected stopPrice > 0");
        if (stopPrice === 91000) throw new Error("Expected stopPrice !== watchBoundary");
        if (stopPrice <= 91000) throw new Error(`Expected stopPrice > watchBoundary for short, got ${stopPrice}`);
        
        if (res.decision.metadata.micro_probe_setup_consumed !== true) throw new Error("Expected micro_probe_setup_consumed true");
    }
});

// 2. long micro probe 최종 ENTER
runTestCase("Long Micro Probe Final Enter", {
    watchBoundary: 92000,
    trendPhase: "UP",
    direction: "up",
    htfPolicy: "LONG_ONLY_OR_NONE",
    inputOverrides: {
        snapshot: { lastPrice: 92100, closedClose: 92200, emaGap: 100, boxHighSlope: 0.1, rcSlope: 0.1, qualityScore: 100 },
        state: buildLiveReadyState(Date.now())
    },
    assert: (res: any) => {
        if (res.decision.decision !== "ENTER" || res.decision.side !== "long") throw new Error(`Expected ENTER long, got ${res.decision.decision} ${res.decision.side}`);
        if (res.decision.executionAction !== "ENTER") throw new Error("Expected executionAction ENTER");
        if (res.decision.riskSizing?.isBlocked === true) throw new Error("Expected risk.isBlocked false");
        if ((res.decision.finalOrderNotionalUsdt ?? 0) <= 0) throw new Error("Expected finalOrderNotionalUsdt > 0");
        if (!res.decision.committedRiskPlan) throw new Error("Expected committedRiskPlan");
        
        const source = res.decision.metadata?.promotedRiskPlanSource ?? res.decision.committedRiskPlan?.source;
        if (source !== "continuation_watch_boundary_buffer") throw new Error(`Expected continuation_watch_boundary_buffer, got ${source}`);
        
        const stopPrice = res.decision.committedRiskPlan?.stopPrice ?? res.decision.stop_price ?? 0;
        if (stopPrice <= 0) throw new Error("Expected stopPrice > 0");
        if (stopPrice === 92000) throw new Error("Expected stopPrice !== watchBoundary");
        if (stopPrice >= 92000) throw new Error(`Expected stopPrice < watchBoundary for long, got ${stopPrice}`);
        
        if (res.decision.metadata.micro_probe_setup_consumed !== true) throw new Error("Expected micro_probe_setup_consumed true");
    }
});

// 3. watchBoundary가 execution.metadata?�서 ?�달 ?�됨 -> WATCH_BOUNDARY_MISSING
runTestCase("WATCH_BOUNDARY_MISSING Block", {
    watchBoundary: null, // missing
    assert: (res: any) => {
        if (res.decision.decision === "ENTER") throw new Error("Should not ENTER when boundary missing");
    }
});

// 4. ?�정 종�? 미이??차단
runTestCase("No Candle Breakdown Block", {
    watchBoundary: 91000,
    inputOverrides: {
        snapshot: { lastPrice: 90800, closedClose: 91500 } // closedClose is above boundary
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
        snapshot: { lastPrice: 90800, closedClose: 90700, emaGap: -2100, boxLowSlope: -0.1, rcSlope: -0.1 }
    },
    assert: (res: any) => {
        if (res.decision.decision === "ENTER") throw new Error("Should block due to shock phase");
    }
});

// 7. 반�? HTF ?�책 차단
runTestCase("Opposite HTF Policy Block", {
    watchBoundary: 91000,
    htfPolicy: "LONG_ONLY_OR_NONE", // want short, but htf is long
    inputOverrides: {
        snapshot: { lastPrice: 90800, closedClose: 90700, emaGap: -2100, boxLowSlope: -0.1, rcSlope: -0.1 }
    },
    assert: (res: any) => {
        if (res.decision.decision === "ENTER") throw new Error("Should block opposite HTF policy");
    }
});

// 8. counter_trend_risk true?????? 0.15
runTestCase("Counter Trend Risk Size Cap", {
    watchBoundary: 91000,
    counterTrendRisk: true,
    trendPhase: "DOWN",
    inputOverrides: {
        snapshot: { lastPrice: 90800, closedClose: 90700, emaGap: -2100, boxLowSlope: -0.1, rcSlope: -0.1, htf_requires_stronger_confirmation: true, qualityScore: 100 },
        state: buildLiveReadyState(Date.now())
    },
    assert: (res: any) => {
        if (res.decision.decision !== "ENTER") throw new Error("Expected ENTER, got " + res.decision.decision + " " + res.decision.risk.blockReason);
        if (res.decision.rawMetrics.sizingMultiplier > 0.15) throw new Error(`Size multiplier exceeds 0.15, got ${res.decision.rawMetrics.sizingMultiplier}`);
    }
});

// 9. 완전 진입 조건 충족 + symbolLastProbeStructureMap 소비 확인
//    + 동일 setupKey 두 번째 실행에서 DUPLICATE_SETUP_KEY 차단
const liveNow = Date.now();
runTestCase("Setup Key Consumption and Duplicate Block", {
    watchBoundary: 91000,
    inputOverrides: {
        now: liveNow,
        snapshot: { lastPrice: 90800, closedClose: 90700, emaGap: -2100, boxLowSlope: -0.1, rcSlope: -0.1, reversalConfirmed: true },
        state: buildLiveReadyState(liveNow),
        config: {
            baseSizeUsd: 20,
            okxLiveMaxOrderNotionalUsdt: 50,
            okxLiveMaxAddonNotionalUsdt: 25,
            okxLiveMaxSymbolNotionalUsdt: 200,
            okxLiveMaxAccountNotionalUsdt: 500,
            okxLiveMaxAddonCount: 2,
        }
    },
    assert: (res: any) => {
        // 첫번째 실행: ENTER 확인
        if (res.decision.decision !== "ENTER") {
            console.error("Decision:", JSON.stringify(res.decision, null, 2));
            throw new Error(`[첫번째 실행] Expected ENTER, got ${res.decision.decision}`);
        }
        if (res.decision.executionAction !== "ENTER") {
            throw new Error(`[첫번째 실행] Expected executionAction=ENTER, got ${res.decision.executionAction}`);
        }
        if (res.decision.risk.isBlocked === true) {
            throw new Error(`[첫번째 실행] risk.isBlocked should not be true, blockReason=${res.decision.risk.blockReason}`);
        }
        if (res.decision.metadata.micro_probe_setup_consumed !== true) {
            throw new Error(`[첫번째 실행] Expected micro_probe_setup_consumed true`);
        }
        if (!(res.decision.risk.finalOrderNotionalUsdt > 0)) {
            throw new Error(`[첫 번째 실행] finalOrderNotionalUsdt should be > 0, got ${res.decision.risk.finalOrderNotionalUsdt}`);
        }
        if (res.decision.committedRiskPlan == null) {
            throw new Error(`[첫 번째 실행] committedRiskPlan should not be null`);
        }

        // 두 번째 실행: 동일 setupKey → DUPLICATE_SETUP_KEY 차단
        const input2: EngineV2Input = {
            run_cycle_id: "cycle-test-2",
            symbol: "BTCUSDT",
            evaluationMode: "authoritative",
            now: liveNow,
            v1Result: {} as any,
            snapshot: {
                lastPrice: 90800,
                latestCandleClose: 89900,
                closedClose: 90700,
                boxHigh: 92000,
                boxLow: 91000,
                boxPos: -0.1,
                rangeConfidence: 0.8,
                ema20: 92000,
                emaGap: -2100,
                volatilityProxy: 500,
                atr20: 1000,
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
                boxLowSlope: -0.1,
                rcSlope: -0.1,
                boxHighSlope: 0,
                candles: [],
                reversalConfirmed: true,
            } as any,
            config: {
                paperMaxOpenPositions: 1,
                paperReentryCooldownMs: 1000,
                baseSizeUsd: 20,
                okxLiveMaxOrderNotionalUsdt: 50,
                okxLiveMaxAddonNotionalUsdt: 25,
                okxLiveMaxSymbolNotionalUsdt: 200,
                okxLiveMaxAccountNotionalUsdt: 500,
                okxLiveMaxAddonCount: 2,
            },
            state: {
                ...buildLiveReadyState(liveNow + 3000),
                engineVariables: {
                    symbolLastProbeStructureMap: res.decision.stateMutations?.symbolLastProbeStructureMap ?? new Map()
                }
            } as any,
        };
        
        marketJudgmentCacheBySymbol.set(input2.symbol, {
            runCycleId: input2.run_cycle_id || "test-cycle-2",
            judgment: {
                regime: "RANGE",
                subtype: "WHIPSAW_SHOCK_RECHECK",
                trendPhase: "DOWN",
                shockPhase: "NONE",
                confidenceLevel: "LOW",
                htf_entry_policy: "SHORT_ONLY_OR_NONE",
                counter_trend_risk: false,
                metrics: { rangeScore: 0.8, trendScore: 0.2 },
                metadata: {}
            } as any,
            candleCount: 999999
        });
        rangeExecutor.rangeContinuationStateMap.set(input2.symbol, {
            direction: "down",
            phase: "CONTINUATION_WATCH",
            watchStartedCandleTs: liveNow - 60000,
            watchStartedAtTimestamp: liveNow - 1000,
            watchBoundaryPrice: 91000,
            countStartedCandleTs: null,
            countBoundaryPrice: null,
            hasCandleAdvancedDuringCount: false,
            totalCyclesSinceWatch: 0
        } as any);
        const res2 = runEngineV2(input2);
        const blockReason2 = res2.decision.metadata?.microProbeBlockReason
            ?? res2.decision.metadata?.promotionBlockReason
            ?? res2.decision.decision;
        if (res2.decision.decision === "ENTER") {
            throw new Error(`[두 번째 실행] Expected DUPLICATE_SETUP_KEY block, but got ENTER`);
        }
        // DUPLICATE_SETUP_KEY 차단 확인
        const isDuplicate =
            blockReason2 === "DUPLICATE_SETUP_KEY" || res2.decision.metadata?.micro_probe_block_reason === "DUPLICATE_SETUP_KEY";
        if (!isDuplicate) {
            throw new Error(`[두번째 실행] Expected DUPLICATE_SETUP_KEY block, got blockReason=${blockReason2} or micro_probe_block_reason=${res2.decision.metadata?.micro_probe_block_reason}`);
        }
    }
});

// C. STOP_DISTANCE_TOO_WIDE test
runTestCase("C. Micro Probe DISTANCE_TOO_WIDE preempts wider risk stop", {
    watchBoundary: 91000,
    inputOverrides: {
        snapshot: { lastPrice: 90450, closedClose: 90700, atr: 10, atr20: 2000, emaGap: -2100, boxLowSlope: -0.1, rcSlope: -0.1, reversalConfirmed: true, qualityScore: 100 },
        state: buildLiveReadyState(Date.now())
    },
    assert: (res: any) => {
        if (res.decision.risk.blockReason !== "WHIPSAW_SHOCK_RECHECK") throw new Error("Expected WHIPSAW_SHOCK_RECHECK, got " + res.decision.risk.blockReason);
    }
});



// E. LIVE_ACCOUNT_AUTHORITY_NOT_READY test
runTestCase("E. LIVE_ACCOUNT_AUTHORITY_NOT_READY Block", {
    watchBoundary: 91000,
    inputOverrides: {
        state: buildLiveReadyState(Date.now(), { liveBalanceReady: false }) // force authority not ready but keep okxLiveEnabled true
    },
    assert: (res: any) => {
        if (res.decision.decision === "ENTER") throw new Error("Expected REJECT for LIVE_ACCOUNT_AUTHORITY_NOT_READY, got ENTER");
        if (res.decision.risk.isBlocked !== true) throw new Error("Expected isBlocked to be true");
        if (res.decision.metadata?.micro_probe_setup_consumed !== false) throw new Error("Expected setup consumed false");
    }
});

// F. BTC protected suppressor test
runTestCase("F. BTC protected suppressor is unreachable via Micro Probe (falls back to WHIPSAW_SHOCK_RECHECK)", {
    watchBoundary: 91000,
    inputOverrides: {
        snapshot: { lastPrice: 90800, closedClose: 90700, atr: 1000, atr20: 1000, emaGap: -2100, boxLowSlope: -0.1, rcSlope: -0.1, reversalConfirmed: true, qualityScore: 100 },
        state: buildLiveReadyState(Date.now(), { currentPositions: [{ symbol: "BTCUSDT", side: "long", size: 1 }] as any })
    },
    assert: (res: any) => {
        if (res.decision.risk.blockReason !== "WHIPSAW_SHOCK_RECHECK") throw new Error("Expected WHIPSAW_SHOCK_RECHECK, got " + res.decision.risk.blockReason);
    }
});

// G. 최종 ADDON_POLICY_DENIED test
runTestCase("G. Add-on policy denied is unreachable via Micro Probe (falls back to WHIPSAW_SHOCK_RECHECK)", {
    watchBoundary: 91000,
    inputOverrides: {
        snapshot: { lastPrice: 90800, closedClose: 90700, atr: 1000, atr20: 1000, emaGap: -2100, boxLowSlope: -0.1, rcSlope: -0.1, reversalConfirmed: true, qualityScore: 100 },
        state: buildLiveReadyState(Date.now(), { 
            currentPositions: [{ symbol: "BTCUSDT", side: "short", size: 1 }] as any,
            okxActualPositions: [{ symbol: "BTCUSDT", side: "short", size: 1 }] as any,
            addOnPolicyAllowed: false
        })
    },
    assert: (res: any) => {
        if (res.decision.risk.blockReason !== "WHIPSAW_SHOCK_RECHECK") throw new Error("Expected WHIPSAW_SHOCK_RECHECK, got " + res.decision.risk.blockReason);
    }
});

// H. finalOrderNotionalUsdt === 0 test
runTestCase("H. maxOrderNotionalUsdt: 0 correctly triggers LIVE_SIZING_LIMITS_NOT_CONFIGURED", {
    watchBoundary: 91000,
    inputOverrides: {
        snapshot: { lastPrice: 90800, closedClose: 90700, atr: 1000, atr20: 1000, emaGap: -2100, boxLowSlope: -0.1, rcSlope: -0.1, reversalConfirmed: true, qualityScore: 100 },
        state: buildLiveReadyState(Date.now()),
        config: { okxLiveMaxOrderNotionalUsdt: 0 }
    },
    assert: (res: any) => {
        if (res.decision.decision !== "REJECT") throw new Error("Expected REJECT, got " + res.decision.decision);
        if (res.decision.risk.blockReason !== "LIVE_SIZING_LIMITS_NOT_CONFIGURED") throw new Error("Expected LIVE_SIZING_LIMITS_NOT_CONFIGURED");
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