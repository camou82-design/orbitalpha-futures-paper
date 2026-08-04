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
    shortAllow: true
};

const origDetect = detector.detectMarketRegime;
const origRoute = selector.routeToExecutor;

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
                qualityScore: mockOverrides.detect.qualityScore || realJudgment.qualityScore,
                rangeConfidence: mockOverrides.detect.rangeConfidence || realJudgment.rangeConfidence,
                boxPos: mockOverrides.detect.boxPos || realJudgment.boxPos,
                rangeOscillationScore: mockOverrides.detect.rangeOscillationScore || realJudgment.rangeOscillationScore,
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
            const result = { ...origRoute(...args as any), ...mockOverrides.route };
            console.log("Mocked Route Result:", result);
            return result;
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
        const decision = await runEngineV2(input);
        
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
    }
}

async function runTests() {
    // 1. V2_PROBE_ENTRY_CONFIRMED
    await runScenario("V2_PROBE_ENTRY_CONFIRMED (Deadlock)", {
        symbol: "BTCUSDT", price: 63500, trend: "UP", regime: "RANGE"
    }, {
        detect: { rangePhase: "RANGE_MID_CHOP", subtype: "RANGE_MID_CHOP", boxPos: 0.5, rangeOscillationScore: 0.8 },
        route: {
            signal: "WAIT_RECHECK",
            side: "none",
            metadata: {
                min_quality_check_passed: false,
                qualityScore: 60,
                range_side_candidate: "none",
                trend_side_candidate: "long"
            }
        }
    });

    // 2. V2_RANGE_MID_MICRO_PROBE_CONFIRMED
    await runScenario("V2_RANGE_MID_MICRO_PROBE_CONFIRMED", {
        symbol: "BTCUSDT", price: 63500, trend: "UP", regime: "RANGE"
    }, {
        detect: { rangePhase: "RANGE_MID_CHOP", subtype: "RANGE_MID_CHOP", boxPos: 0.5, rangeOscillationScore: 0.8 },
        route: {
            signal: "WAIT_RECHECK",
            side: "none",
            metadata: {
                min_quality_check_passed: false,
                qualityScore: 90,
                range_side_candidate: "none",
                trend_side_candidate: "long"
            }
        }
    });

    // 3. V2_WAIT_RECHECK_QUALIFIED_PROMOTION
    await runScenario("V2_WAIT_RECHECK_QUALIFIED_PROMOTION", {
        symbol: "BTCUSDT", price: 63500, trend: "UP", regime: "TREND"
    }, {
        detect: { trendPhase: "UP", subtype: "UP_MOMENTUM", qualityScore: 90 },
        route: {
            executor: "TREND",
            action: "HOLD", // Just so it doesn't fail parsing
            signal: "WAIT_RECHECK",
            side: "none",
            metadata: {
                qualityScore: 90,
                trend_side_candidate: "long",
                range_side_candidate: "none",
                whipsaw_blocking: false,
                reversal_confirmed: false,
                min_order_check_passed: true
            }
        }
    });

    // 4. Exceeding max stop distance blocks entry
    await runScenario("Max Stop Distance Block", {
        symbol: "BTCUSDT", price: 63500, trend: "UP", regime: "RANGE", atr: 63500 * 0.05 // 5% ATR
    }, {
        detect: { rangePhase: "RANGE_MID_CHOP", subtype: "RANGE_MID_CHOP", boxPos: 0.5, rangeOscillationScore: 0.8 },
        route: {
            signal: "WAIT_RECHECK",
            side: "none",
            metadata: {
                qualityScore: 90,
                range_side_candidate: "none",
                trend_side_candidate: "long"
            }
        }
    });

    // 5. Preserve normal Executor stop
    await runScenario("Preserve normal Executor stop", {
        symbol: "BTCUSDT", price: 63500, trend: "UP", regime: "RANGE"
    }, {
        detect: { 
            rangePhase: "RANGE_LOWER_REACTION", 
            subtype: "RANGE_LOWER_REACTION", 
            boxPos: 0.1, 
            rangeOscillationScore: 0.8,
            metadata: { reversal_confirmed: true, qualityScore: 90, range_side_candidate: "long" }
        },
        route: {
            executor: "RANGE",
            action: "ENTER",
            side: "long",
            reason: "V2_PROBE_ENTRY_CONFIRMED",
            blockReason: null,
            stopPrice: 63000,
            invalidationPx: 63000,
            metadata: {
                qualityScore: 90,
                range_side_candidate: "long",
                trend_side_candidate: "none"
            }
        },
        snapshot: {
            boxPos: 0.1
        }
    });
}

runTests().catch(console.error);
