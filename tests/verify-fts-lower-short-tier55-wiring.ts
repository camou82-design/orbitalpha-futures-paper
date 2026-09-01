import { runEngineV2, adaptV2Input, marketJudgmentCacheBySymbol } from "../src/engine-v2";
import { clearGlobalShockStates } from "../src/engine-v2/state/derive";
import { Candle, EngineConfig } from "../src/models/types";

const mockConfig: EngineConfig = {
    symbols: ["BTCUSDT", "ETHUSDT"],
    paperMaxOpenPositions: 3,
    paperReentryCooldownMs: 0,
    baseSizeUsd: 100,
    okxLiveMaxOrderNotionalUsdt: 50,
    killSwitchActive: false,
    emergencyCrashDefendActive: false,
    emergencyPumpDefendActive: false,
    serverTradeEnabled: true
} as any;

const mockResult = {
    decision: { regime_state: "RANGE", final_decision: "SKIP", reject_reason: null, required_cost_usd: 0 },
    executorDecision: null,
    intentSide: "none" as const
};

function makeBaselineCandles(baseTime: number, basePrice: number, closePrice: number): Candle[] {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
        candles.push({
            ts: baseTime + i * 60000,
            open: basePrice,
            high: basePrice + 100,
            low: basePrice - 100,
            close: basePrice,
            vol: 100
        } as any);
    }
    candles[candles.length - 1] = {
        ...candles[candles.length - 1],
        close: closePrice
    };
    return candles;
}

let passedCount = 0;
let failedCount = 0;

function check(condition: boolean, msg: string) {
    if (!condition) {
        console.error(`[FAIL] ${msg}`);
        failedCount++;
    } else {
        console.log(`[PASS] ${msg}`);
        passedCount++;
    }
}

function runWithJudgment(input: any, judgment: any) {
    const cycleId = "cycle_" + Math.random().toString(36).substring(7);
    input.run_cycle_id = cycleId;
    (input.state as any).run_cycle_id = cycleId;
    marketJudgmentCacheBySymbol.set(input.symbol, {
        runCycleId: cycleId,
        judgment: {
            metrics: { rangeScore: 0.8, trendScore: 0.2 },
            ...judgment,
            metadata: judgment.metadata ?? {},
            diagnostics: judgment.diagnostics ?? {}
        },
        candleCount: 999999
    });
    return runEngineV2(input);
}

function runTier55WiringTests() {
    console.log("================================================================================");
    console.log("     TIER 5.5 LOWER FTS SHORT STRUCTURAL EXEMPTION WIRING TEST SUITE");
    console.log("================================================================================");

    clearGlobalShockStates("BTCUSDT");
    const baseTime = Date.now();
    const baseState = {
        currentPositions: [],
        directionalShockState: "NONE" as const,
        longAllow: true,
        shortAllow: true,
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        accountEquityKrw: 10000000,
        maxUsableMarginKrw: 5000000,
        symbolExposureNotionalCapKrw: 10000000,
        accountEquityUsdt: 10000,
        availableBalanceUsdt: 10000
    };

    // -------------------------------------------------------------------------
    // CASE A: Production BTC 07:16:23 exact (trendOk=false, quality=65, closedClose > boxLow)
    // EXPECTED: HOLD / SIDE_ZONE_MISMATCH_LOWER_SHORT
    // -------------------------------------------------------------------------
    const candlesA = makeBaselineCandles(baseTime, 87000, 87000);
    const snapA = {
        symbol: "BTCUSDT",
        lastPrice: 87000,
        latestCandleClose: 87000,
        boxHigh: 90000,
        boxLow: 86000,
        boxPos: 0.2678899082568985,
        closedClose: 87000,
        atr: 500,
        trendWeaknessScore: 0.851,
        qualityScore: 65,
        candles: candlesA,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inA = adaptV2Input("BTCUSDT" as any, baseTime, snapA as any, mockConfig as any, baseState as any, mockResult as any, candlesA, "authoritative");
    const resA = runWithJudgment(inA, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "FAST_TREND_SHIFT",
        trendPhase: "DOWN",
        trendOk: false,
        qualityScore: 65,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        diagnostics: {
            fastTrendShift: {
                active: false,
                direction: "none",
                lower_high_detected: false,
                lower_low_detected: false,
                box_mid_lost: false,
                box_lower_breakdown_hold: false
            }
        }
    });
    check(resA.decision.metadata?.v2DecisionFinal !== "ENTER", `CASE A: BTC 07:16 exact (trendOk=false) -> NOT ENTER (got ${resA.decision.metadata?.v2DecisionFinal})`);
    check(resA.decision.decision === "REJECT" || resA.decision.decision === "HOLD", `CASE A: Non-enter decision (got ${resA.decision.decision})`);

    // -------------------------------------------------------------------------
    // CASE B: Lower FTS structural confirmed (trendOk=true, quality=67, LL/LH/box_mid_lost/lower_hold=true, stop=88500), closedClose=87000 > boxLow=86000
    // EXPECTED: structural exemption bypasses SIDE_ZONE_MISMATCH_LOWER_SHORT -> ENTER short
    // -------------------------------------------------------------------------
    const candlesB = makeBaselineCandles(baseTime, 87000, 87000);
    const snapB = {
        symbol: "BTCUSDT",
        lastPrice: 87000,
        latestCandleClose: 87000,
        boxHigh: 90000,
        boxLow: 86000,
        boxPos: 0.2678899082568985,
        closedClose: 87000,
        atr: 500,
        trendWeaknessScore: 0.3,
        emaGap: -0.005,
        qualityScore: 67,
        candles: candlesB,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inB = adaptV2Input("BTCUSDT" as any, baseTime, snapB as any, mockConfig as any, baseState as any, mockResult as any, candlesB, "authoritative");
    const resB = runWithJudgment(inB, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "FAST_TREND_SHIFT",
        trendPhase: "DOWN",
        trendOk: true,
        qualityScore: 67,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        diagnostics: {
            fastTrendShift: {
                active: true,
                direction: "short",
                lower_high_detected: true,
                lower_low_detected: true,
                box_mid_lost: true,
                box_lower_breakdown_hold: true,
                reason: "lower_high|lower_low|box_mid_lost|lower_hold",
                stop_price: 88500
            }
        }
    });
    check(resB.decision.metadata?.v2DecisionFinal === "ENTER" && resB.decision.metadata?.v2SideFinal === "short", `CASE B: Lower FTS structural confirmed -> ENTER short (got ${resB.decision.metadata?.v2DecisionFinal}/${resB.decision.metadata?.v2SideFinal})`);

    // -------------------------------------------------------------------------
    // CASE C: Lower FTS structural incomplete (lower_low_detected=false), closedClose > boxLow
    // EXPECTED: HOLD
    // -------------------------------------------------------------------------
    const candlesC = makeBaselineCandles(baseTime, 87000, 87000);
    const inC = adaptV2Input("BTCUSDT" as any, baseTime, snapB as any, mockConfig as any, baseState as any, mockResult as any, candlesC, "authoritative");
    const resC = runWithJudgment(inC, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "FAST_TREND_SHIFT",
        trendPhase: "DOWN",
        trendOk: true,
        qualityScore: 67,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        diagnostics: {
            fastTrendShift: {
                active: true,
                direction: "short",
                lower_high_detected: true,
                lower_low_detected: false, // INCOMPLETE
                box_mid_lost: true,
                box_lower_breakdown_hold: true,
                reason: "lower_high|box_mid_lost|lower_hold",
                stop_price: 88500
            }
        }
    });
    check(resC.decision.metadata?.v2DecisionFinal !== "ENTER", `CASE C: Lower FTS incomplete structure -> NOT ENTER (got ${resC.decision.metadata?.v2DecisionFinal})`);

    // -------------------------------------------------------------------------
    // CASE D: Physical breakdown confirmed (closedClose < boxLow), structural helper false/inactive
    // EXPECTED: existing breakdown exemption works -> ENTER short
    // -------------------------------------------------------------------------
    const candlesD = makeBaselineCandles(baseTime, 87000, 85900);
    const snapD = {
        symbol: "BTCUSDT",
        lastPrice: 85900,
        latestCandleClose: 85900,
        boxHigh: 90000,
        boxLow: 86000,
        boxPos: -0.05,
        boxBreakSide: "lower",
        closedClose: 85900,
        atr: 500,
        trendWeaknessScore: 0.2,
        emaGap: -0.005,
        qualityScore: 72,
        candles: candlesD,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inD = adaptV2Input("BTCUSDT" as any, baseTime, snapD as any, mockConfig as any, baseState as any, mockResult as any, candlesD, "authoritative");
    const resD = runWithJudgment(inD, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "BREAKDOWN_RETEST_FAILED",
        trendPhase: "DOWN",
        trendOk: true,
        qualityScore: 72,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        metadata: {
            retestConfirmed: true,
            retestRejected: true
        }
    });
    check(resD.decision.metadata?.v2DecisionFinal === "ENTER" && resD.decision.metadata?.v2SideFinal === "short", `CASE D: Physical breakdown confirmed -> ENTER short (got ${resD.decision.metadata?.v2DecisionFinal}/${resD.decision.metadata?.v2SideFinal})`);

    // -------------------------------------------------------------------------
    // CASE E: Upper FTS Long representative (unchanged baseline behavior)
    // EXPECTED: ENTER long
    // -------------------------------------------------------------------------
    const candlesE = makeBaselineCandles(baseTime, 87000, 87400);
    const snapE = {
        symbol: "BTCUSDT",
        lastPrice: 87400,
        latestCandleClose: 87400,
        boxHigh: 87500,
        boxLow: 86500,
        boxPos: 0.9,
        closedClose: 87400,
        emaGap: 0.005,
        trendWeaknessScore: 0.3,
        qualityScore: 68,
        atr: 500,
        candles: candlesE,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inE = adaptV2Input("BTCUSDT" as any, baseTime, snapE as any, mockConfig as any, baseState as any, mockResult as any, candlesE, "authoritative");
    const resE = runWithJudgment(inE, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "FAST_TREND_SHIFT",
        trendPhase: "UP",
        qualityScore: 68,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: true,
        diagnostics: {
            fastTrendShift: {
                active: true,
                direction: "long",
                higher_low_detected: true,
                higher_high_detected: true,
                box_mid_reclaimed: true,
                box_upper_breakout_hold: true,
                reason: "higher_low|higher_high|box_mid_ok|upper_hold",
                stop_price: 86900
            }
        }
    });
    check(resE.decision.metadata?.v2DecisionFinal === "ENTER" && resE.decision.metadata?.v2SideFinal === "long", `CASE E: Upper FTS Long -> ENTER long (got ${resE.decision.metadata?.v2DecisionFinal}/${resE.decision.metadata?.v2SideFinal})`);

    // -------------------------------------------------------------------------
    // CASE F: Lower FTS structural helper confirmed=true BUT killSwitchActive=true or serverTradeEnabled=false
    // EXPECTED: NOT ENTER
    // -------------------------------------------------------------------------
    const inF = adaptV2Input("BTCUSDT" as any, baseTime, snapB as any, { ...mockConfig, killSwitchActive: true, serverTradeEnabled: false } as any, { ...baseState, serverTradeEnabled: false, killSwitch: true, paperExecutionReady: false } as any, mockResult as any, candlesB, "authoritative");
    const resF = runWithJudgment(inF, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "FAST_TREND_SHIFT",
        trendPhase: "DOWN",
        trendOk: true,
        qualityScore: 67,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        diagnostics: {
            fastTrendShift: {
                active: true,
                direction: "short",
                lower_high_detected: true,
                lower_low_detected: true,
                box_mid_lost: true,
                box_lower_breakdown_hold: true,
                reason: "lower_high|lower_low|box_mid_lost|lower_hold",
                stop_price: 88500
            }
        }
    });
    check(resF.decision.metadata?.v2DecisionFinal !== "ENTER", `CASE F: Readiness=false -> NOT ENTER (got ${resF.decision.metadata?.v2DecisionFinal})`);

    console.log("\n================================================================================");
    console.log(`TOTAL: ${passedCount + failedCount} | PASSED: ${passedCount} | FAILED: ${failedCount}`);
    console.log("================================================================================");

    if (failedCount > 0) {
        process.exit(1);
    }
}

runTier55WiringTests();
