import { runEngineV2, adaptV2Input, marketJudgmentCacheBySymbol } from "../src/engine-v2";
import { Candle } from "../src/models/types";
import * as detector from "../src/engine-v2/market-judgment/detector";
import * as selector from "../src/engine-v2/engine-router/selector";

function makeMockCandles(count: number, trend: "UP" | "DOWN", basePrice: number = 50000): Candle[] {
    const candles: Candle[] = [];
    let price = basePrice;
    for (let i = 0; i < count; i++) {
        const move = trend === "UP" ? 5 : -5;
        price += move;
        // Inject a touch at index 118 (within last 5 candles)
        const lowPx = i === 118 ? 63000 : price - 50;
        candles.push({
            ts: 1600000000000 + i * 60000,
            open: price - move,
            high: price + 50,
            low: lowPx,
            close: price,
            volume: 100
        } as any);
    }
    return candles;
}

const mockConfig = {
    paperMaxOpenPositions: 3,
    paperReentryCooldownMs: 0,
    baseSizeUsd: 100,
    okxLiveMaxOrderNotionalUsdt: 50
};

const mockState = {
    currentPositions: [],
    okxActualSide: null,
    longAllow: true,
    shortAllow: true,
    symbolExposureNotionalCapKrw: 2000000
};

const origDetect = detector.detectMarketRegime;
const origRoute = selector.routeToExecutor;

import * as rangeExecutor from "../src/engine-v2/executors/range-executor";
const origRangeExec = rangeExecutor.executeRangeRegime;

async function runScenario(
    name: string,
    setup: {
        symbol: string;
        price: number;
        trend: "UP" | "DOWN";
        regime: "RANGE" | "TREND";
        atr?: number;
    },
    mockOverrides: {
        detect?: any;
        route?: any;
        executeRangeRegime?: any;
        snapshot?: any;
    }
) {
    console.log(`\n--- Running Scenario: ${name} ---`);
    marketJudgmentCacheBySymbol.delete(setup.symbol);
    const candles = makeMockCandles(120, setup.trend, setup.price);
    
    const snap = {
        symbol: setup.symbol,
        lastPrice: setup.price,
        atr: setup.atr ?? (setup.price * 0.01),
        candles,
        ema20: setup.price - 100,
        ema50: setup.price - 200,
        volume: 1000,
        boxLow: setup.price - 500,
        boxHigh: setup.price + 500,
        latestCandleClose: setup.price,
        rangeConfidence: 0.8,
        qualityScore: 90,
        ...(mockOverrides.snapshot || {})
    };

    const input = adaptV2Input(
        setup.symbol, Date.now(), snap as any, mockConfig as any, mockState as any,
        { regime: setup.regime, decision: "SKIP", side: "none", isBlocked: true } as any,
        candles, "authoritative", "cycle_1"
    );
    if (mockOverrides.detect) {
        const realJudgment = detector.detectMarketRegime(input as any);
        marketJudgmentCacheBySymbol.set(setup.symbol, {
            runCycleId: "cycle_1",
            candleCount: 9999,
            judgment: {
                ...realJudgment,
                regime: setup.regime,
                subtype: mockOverrides.detect.subtype || realJudgment.subtype,
                trendPhase: mockOverrides.detect.trendPhase || realJudgment.trendPhase,
                rangePhase: mockOverrides.detect.rangePhase || realJudgment.rangePhase,
                transitionPhase: "NONE",
                activeEngineRouting: setup.regime,
                qualityScore: mockOverrides.detect.qualityScore || (realJudgment as any).qualityScore,
                rangeConfidence: mockOverrides.detect.rangeConfidence || (realJudgment as any).rangeConfidence,
                boxPos: mockOverrides.detect.boxPos || (realJudgment as any).boxPos,
                rangeOscillationScore: mockOverrides.detect.rangeOscillationScore || (realJudgment as any).rangeOscillationScore,
                metadata: {
                    ...realJudgment.metadata,
                    ...(mockOverrides.detect.metadata || {})
                },
                marketJudgmentStateSource: "authoritative_input"
            } as any
        });
        console.log("Mocked Cache Judgment:", marketJudgmentCacheBySymbol.get(setup.symbol)?.judgment);
    }
    if (mockOverrides.route) {
        (selector as any).routeToExecutor = (...args: any[]) => {
            const result = { ...(origRoute as any)(...args), ...mockOverrides.route };
            console.log("Mocked Route Result:", result);
            return result;
        };
    }
    if (mockOverrides.executeRangeRegime) {
        (rangeExecutor as any).executeRangeRegime = (...args: any[]) => {
            return mockOverrides.executeRangeRegime;
        };
    }

    const logs: any[] = [];
    const origInfo = console.info;
    const origError = console.error;
    console.info = (...args: any[]) => {
        try { logs.push(JSON.parse(args[0])); } catch (e) {}
    };
    console.error = (...args: any[]) => {
        try { logs.push(JSON.parse(args[0])); } catch (e) {}
    };

    try {
        const { decision } = await runEngineV2(input);
        
        // Find risk proof
        const riskProof = logs.find(l => l.event === "V2_PROMOTED_ENTRY_RISK_PLAN_PROOF");
        const entryProof = logs.find(l => l.event === "V2_ENTRY_PLAN_RISK_PROOF");
        const execBridge = logs.find(l => l.event === "V2_ENTRY_EXECUTION_BRIDGE_PROOF");
        
        console.log(`Final Decision: ${decision.decision}, Side: ${decision.side}`);
        if (riskProof) {
            console.log(`Risk Plan - Injected: ${riskProof.stopPriceAfter !== riskProof.stopPriceBefore}, Source: ${riskProof.source}, BlockReason: ${riskProof.blockReason}`);
        }
        if (entryProof) {
            console.log(`Audit - Passed: ${entryProof.audit_passed}, Action: ${entryProof.action}`);
        }
        if (execBridge) {
            console.log(`Bridge - final_decision: ${execBridge.final_decision}, final_side: ${execBridge.final_side}, stop_price: ${execBridge.stop_price}, reject_reason: ${execBridge.risk_block_reason}`);
        }
        if (execBridge?.final_decision !== "ENTER" && decision.decision !== "ENTER") {
            const auditProof = logs.find(l => l.event === "V2_NO_ENTER_PATH_AUDIT_PROOF");
            console.log(`NO ENTER PATH AUDIT PROOF: ${JSON.stringify(auditProof)}`);
            const readiness = logs.find(l => l.event === "V2_EXECUTION_READINESS_PROOF");
            console.log(`READINESS PROOF: ${JSON.stringify(readiness)}`);
            const p = logs.find(l => l.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");
            console.log(`PROMOTION FINALIZER PROOF: ${JSON.stringify(p)}`);
        }

        return { decision, riskProof, entryProof, execBridge };
    } catch (e) {
        origError("Test failed with exception:", e);
    } finally {
        console.info = origInfo;
        console.error = origError;
        (detector as any).detectMarketRegime = origDetect;
        (selector as any).routeToExecutor = origRoute;
        (rangeExecutor as any).executeRangeRegime = origRangeExec;
    }
}

async function runTests() {
    let failedCount = 0;

    const assert = (condition: boolean, msg: string) => {
        if (!condition) {
            console.error(`[FAIL] ${msg}`);
            failedCount++;
        }
    };

    // 1. V2_PROBE_ENTRY_CONFIRMED
    const r1 = await runScenario("V2_PROBE_ENTRY_CONFIRMED (Deadlock)", {
        symbol: "BTCUSDT", price: 63500, trend: "UP", regime: "RANGE"
    }, {
        detect: { 
            rangePhase: "RANGE_MID_CHOP", 
            subtype: "RANGE_MID_CHOP", 
            boxPos: 0.5, 
            rangeOscillationScore: 0.8,
            metadata: {
                min_quality_check_passed: true,
                qualityScore: 90,
                range_side_candidate: "long",
                trend_side_candidate: "long",
                trendOk: true
            }
        },
        route: {
            signal: "NONE",
            side: "none"
        },
        snapshot: {
            emaGap: 0.005,
            qualityScore: 90
        }
    });
    if (r1) {
        assert(r1.decision.decision === "ENTER", "Scenario 1: Expected ENTER");
        assert(r1.decision.side === "long", `Scenario 1: Expected side long, got ${r1.decision.side}`);
        assert((r1.decision.risk as any)?.stopPrice != null, "Scenario 1: stopPrice must not be null");
        assert((r1.decision.risk as any)?.invalidationPx != null, "Scenario 1: invalidationPx must not be null");
        assert((r1.decision.risk as any)!.stopPrice! < 63500, "Scenario 1: long stopPrice must be < entryPrice");
        assert(r1.entryProof?.audit_passed === true, "Scenario 1: audit_passed must be true");
        assert(r1.entryProof?.action === "ALLOW_ENTRY", "Scenario 1: action must be ALLOW_ENTRY");
    }

    // 2. V2_RANGE_MID_MICRO_PROBE_CONFIRMED
    const r2 = await runScenario("V2_RANGE_MID_MICRO_PROBE_CONFIRMED", {
        symbol: "BTCUSDT", price: 63500, trend: "UP", regime: "RANGE"
    }, {
        detect: { 
            rangePhase: "RANGE_MID_CHOP", 
            subtype: "RANGE_MID_CHOP", 
            boxPos: 0.5, 
            rangeOscillationScore: 0.8,
            metadata: {
                min_quality_check_passed: true,
                qualityScore: 90,
                range_side_candidate: "long",
                trend_side_candidate: "long",
                trendOk: true
            }
        },
        route: {
            signal: "NONE",
            side: "none"
        },
        snapshot: {
            emaGap: 0.005,
            qualityScore: 90
        }
    });
    if (r2) {
        assert(r2.decision.decision === "ENTER", "Scenario 2: Expected ENTER");
        assert(r2.decision.side === "long", `Scenario 2: Expected side long, got ${r2.decision.side}`);
        assert((r2.decision.risk as any)?.stopPrice != null, "Scenario 2: stopPrice must not be null");
        assert((r2.decision.risk as any)?.invalidationPx != null, "Scenario 2: invalidationPx must not be null");
        assert((r2.decision.risk as any)!.stopPrice! < 63500, "Scenario 2: long stopPrice must be < entryPrice");
        assert(r2.entryProof?.audit_passed === true, "Scenario 2: audit_passed must be true");
        assert(r2.entryProof?.action === "ALLOW_ENTRY", "Scenario 2: action must be ALLOW_ENTRY");
    }

    // 3. V2_WAIT_RECHECK_QUALIFIED_PROMOTION
    const r3 = await runScenario("V2_WAIT_RECHECK_QUALIFIED_PROMOTION", {
        symbol: "BTCUSDT", price: 63500, trend: "UP", regime: "TREND"
    }, {
        detect: { 
            trendPhase: "UP", 
            subtype: "UP_MOMENTUM", 
            qualityScore: 90,
            metadata: {
                qualityScore: 90,
                trend_side_candidate: "long",
                range_side_candidate: "none",
                whipsaw_blocking: false,
                reversal_confirmed: false,
                min_order_check_passed: true,
                trendOk: true
            }
        },
        route: {
            executor: "TREND",
            action: "HOLD",
            signal: "WAIT_RECHECK",
            side: "none"
        },
        snapshot: {
            emaGap: 0.005,
            qualityScore: 90
        }
    });
    if (r3) {
        assert(r3.decision.decision === "ENTER", "Scenario 3: Expected ENTER");
        assert(r3.decision.side === "long", `Scenario 3: Expected side long, got ${r3.decision.side}`);
        assert((r3.decision.risk as any)?.stopPrice != null, "Scenario 3: stopPrice must not be null");
        assert((r3.decision.risk as any)?.invalidationPx != null, "Scenario 3: invalidationPx must not be null");
        assert((r3.decision.risk as any)!.stopPrice! < 63500, "Scenario 3: long stopPrice must be < entryPrice");
        assert(r3.entryProof?.audit_passed === true, "Scenario 3: audit_passed must be true");
        assert(r3.entryProof?.action === "ALLOW_ENTRY", "Scenario 3: action must be ALLOW_ENTRY");
    }

    // 4. Exceeding max stop distance blocks entry
    const r4 = await runScenario("Max Stop Distance Block", {
        symbol: "BTCUSDT", price: 63500, trend: "UP", regime: "RANGE", atr: 63500 * 0.005 // 0.5% ATR
    }, {
        detect: { 
            rangePhase: "RANGE_MID_CHOP", 
            subtype: "RANGE_MID_CHOP", 
            boxPos: 0.5, 
            rangeOscillationScore: 0.8,
            metadata: {
                qualityScore: 90,
                range_side_candidate: "none",
                trend_side_candidate: "long",
                trendOk: true
            }
        },
        route: {
            signal: "NONE",
            side: "none"
        },
        snapshot: {
            emaGap: 0.005,
            qualityScore: 90
        }
    });
    if (r4) {
        assert(r4.decision.decision === "REJECT", "Scenario 4: Expected REJECT");
        assert(r4.decision.risk?.blockReason === "STOP_DISTANCE_TOO_WIDE", "Scenario 4: Expected fail_reason STOP_DISTANCE_TOO_WIDE");
    }

    // 5. Preserve normal Executor stop
    const r5 = await runScenario("Preserve normal Executor stop", {
        symbol: "BTCUSDT", price: 63500, trend: "UP", regime: "RANGE"
    }, {
        detect: { 
            rangePhase: "RANGE_LOWER_REACTION", 
            subtype: "RANGE_LOWER_REACTION", 
            boxPos: 0.1, 
            rangeOscillationScore: 0.8,
            metadata: { 
                reversal_confirmed: true, 
                qualityScore: 90, 
                range_side_candidate: "long",
                trend_side_candidate: "none"
            }
        },
        route: {
            executor: "RANGE",
            signal: "ENTER",
            side: "long",
            reason: "V2_PROBE_ENTRY_CONFIRMED"
        },
        executeRangeRegime: {
            signal: "ENTER",
            side: "long",
            reason: "Mocked Range Executor",
            blockReason: null,
            stopPrice: 63000,
            invalidationPx: 63000,
            metadata: {
                reversal_confirmed: true,
                range_side_candidate: "long",
                trend_side_candidate: "none",
                qualityScore: 90
            }
        },
        snapshot: {
            boxPos: 0.1
        }
    });
    if (r5) {
        assert(r5.decision.decision === "ENTER", "Scenario 5: Expected ENTER");
        assert(r5.decision.side === "long", `Scenario 5: Expected side long, got ${r5.decision.side}`);
        assert(r5.riskProof?.stopPriceAfter === r5.riskProof?.stopPriceBefore, "Scenario 5: stopPrice must be preserved");
        assert(r5.riskProof?.source === "existing_valid", "Scenario 5: source must be existing_valid");
    }

    if (failedCount > 0) {
        throw new Error(`${failedCount} promoted risk plan tests failed`);
    } else {
        console.log("\n=== ALL SCENARIOS PASSED ===");
    }
}

runTests().catch((e) => {
    console.error(e);
    process.exit(1);
});
