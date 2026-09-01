import assert from "node:assert";
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

function test1_FTS_Mirrored_UpperLong_vs_LowerShort() {
    console.log("\n--- TEST 1: FTS Mirrored Upper Long vs Lower Short ---");
    clearGlobalShockStates("BTCUSDT");
    const baseTime = Date.now();
    const state = {
        currentPositions: [],
        directionalShockState: "NONE" as const,
        longAllow: true,
        shortAllow: true,
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        accountEquityKrw: 1000000,
        maxUsableMarginKrw: 800000,
        symbolExposureNotionalCapKrw: 1000000,
        accountEquityUsdt: 1000,
        availableBalanceUsdt: 1000
    };

    // UPPER FTS Long: price 87400 inside box [86500, 87500] (boxPos = 0.9)
    const candlesUpper = makeBaselineCandles(baseTime, 87000, 87400);
    const snapUpper = {
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
        candles: candlesUpper,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inputUpper = adaptV2Input("BTCUSDT" as any, baseTime, snapUpper as any, mockConfig as any, state as any, mockResult as any, candlesUpper, "authoritative");
    const resUpper = runWithJudgment(inputUpper, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "FAST_TREND_SHIFT",
        trendPhase: "UP",
        qualityScore: 68,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: true,
        polarityProbeEligible: false,
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
    check(resUpper.decision.metadata?.v2DecisionFinal === "ENTER" && resUpper.decision.metadata?.v2SideFinal === "long", `UPPER FTS Long -> ENTER long (got ${resUpper.decision.metadata?.v2DecisionFinal}/${resUpper.decision.metadata?.v2SideFinal})`);

    // LOWER FTS Short (Exact Mirror): price 86600 inside box [86500, 87500] (boxPos = 0.1)
    const candlesLower = makeBaselineCandles(baseTime, 87000, 86600);
    const snapLower = {
        symbol: "BTCUSDT",
        lastPrice: 86600,
        latestCandleClose: 86600,
        boxHigh: 87500,
        boxLow: 86500,
        boxPos: 0.1,
        closedClose: 86600,
        emaGap: -0.005,
        trendWeaknessScore: 0.3,
        qualityScore: 68,
        atr: 500,
        candles: candlesLower,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inputLower = adaptV2Input("BTCUSDT" as any, baseTime, snapLower as any, mockConfig as any, state as any, mockResult as any, candlesLower, "authoritative");
    const resLower = runWithJudgment(inputLower, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "FAST_TREND_SHIFT",
        trendPhase: "DOWN",
        qualityScore: 68,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: true,
        polarityProbeEligible: false,
        diagnostics: {
            fastTrendShift: {
                active: true,
                direction: "short",
                lower_high_detected: true,
                lower_low_detected: true,
                box_mid_lost: true,
                box_lower_breakdown_hold: true,
                reason: "lower_high|lower_low|box_mid_lost|lower_hold",
                stop_price: 87100
            }
        }
    });
    check(resLower.decision.metadata?.v2DecisionFinal === "ENTER" && resLower.decision.metadata?.v2SideFinal === "short", `LOWER FTS Short -> ENTER short (got ${resLower.decision.metadata?.v2DecisionFinal}/${resLower.decision.metadata?.v2SideFinal})`);
}

function test2_Range_Probe_Promotion_Symmetry() {
    console.log("\n--- TEST 2: Range Probe Promotion Symmetry ---");
    clearGlobalShockStates("BTCUSDT");
    const baseTime = Date.now();
    const state = {
        currentPositions: [],
        directionalShockState: "NONE" as const,
        longAllow: true,
        shortAllow: true,
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        accountEquityKrw: 1000000,
        maxUsableMarginKrw: 800000,
        symbolExposureNotionalCapKrw: 1000000,
        accountEquityUsdt: 1000,
        availableBalanceUsdt: 1000
    };

    // LOWER Range Long (qualityScore = 62, no shock)
    const candlesLower = makeBaselineCandles(baseTime, 87000, 86550);
    const snapLower = {
        symbol: "BTCUSDT",
        lastPrice: 86550,
        latestCandleClose: 86550,
        boxHigh: 87500,
        boxLow: 86500,
        boxPos: 0.05,
        closedClose: 86550,
        trendWeaknessScore: 0.3,
        qualityScore: 62,
        atr: 500,
        candles: candlesLower,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inputLower = adaptV2Input("BTCUSDT" as any, baseTime, snapLower as any, mockConfig as any, state as any, mockResult as any, candlesLower, "authoritative");
    const resLower = runWithJudgment(inputLower, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "NEUTRAL",
        qualityScore: 62,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false
    });
    check(resLower.decision.metadata?.v2DecisionFinal === "ENTER" && resLower.decision.metadata?.v2SideFinal === "long", `LOWER Range Long -> ENTER long (got ${resLower.decision.metadata?.v2DecisionFinal}/${resLower.decision.metadata?.v2SideFinal})`);

    // UPPER Range Short (qualityScore = 62, no shock)
    const candlesUpper = makeBaselineCandles(baseTime, 87000, 87450);
    const snapUpper = {
        symbol: "BTCUSDT",
        lastPrice: 87450,
        latestCandleClose: 87450,
        boxHigh: 87500,
        boxLow: 86500,
        boxPos: 0.95,
        closedClose: 87450,
        trendWeaknessScore: 0.3,
        qualityScore: 62,
        atr: 500,
        candles: candlesUpper,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inputUpper = adaptV2Input("BTCUSDT" as any, baseTime, snapUpper as any, mockConfig as any, state as any, mockResult as any, candlesUpper, "authoritative");
    const resUpper = runWithJudgment(inputUpper, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "NEUTRAL",
        qualityScore: 62,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false
    });
    check(resUpper.decision.metadata?.v2DecisionFinal === "ENTER" && resUpper.decision.metadata?.v2SideFinal === "short", `UPPER Range Short -> ENTER short (got ${resUpper.decision.metadata?.v2DecisionFinal}/${resUpper.decision.metadata?.v2SideFinal})`);
}

function test3_Local_Conflict_Resolution_Symmetry() {
    console.log("\n--- TEST 3: Tier 4.8 Local Conflict Resolution Symmetry ---");
    clearGlobalShockStates("BTCUSDT");
    const baseTime = Date.now();
    const state = {
        currentPositions: [],
        directionalShockState: "NONE" as const,
        longAllow: true,
        shortAllow: true,
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        accountEquityKrw: 1000000,
        maxUsableMarginKrw: 800000,
        symbolExposureNotionalCapKrw: 1000000,
        accountEquityUsdt: 1000,
        availableBalanceUsdt: 1000
    };

    // UPPER Conflict: Range Short vs Trend Long -> Trend Long wins with breakout hold
    const candlesUpper = makeBaselineCandles(baseTime, 87000, 87450);
    const snapUpper = {
        symbol: "BTCUSDT",
        lastPrice: 87450,
        latestCandleClose: 87450,
        boxHigh: 87500,
        boxLow: 86500,
        boxPos: 0.95,
        closedClose: 87450,
        ema20Slope: 0.005,
        emaGap: 0.005,
        trendWeaknessScore: 0.3,
        qualityScore: 68,
        atr: 500,
        candles: candlesUpper,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inputUpper = adaptV2Input("BTCUSDT" as any, baseTime, snapUpper as any, mockConfig as any, state as any, mockResult as any, candlesUpper, "authoritative");
    const resUpper = runWithJudgment(inputUpper, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        qualityScore: 68,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: true,
        reversalConfirmed: false,
        metadata: {
            box_upper_breakout_hold: true
        }
    });
    check(resUpper.decision.metadata?.v2DecisionFinal === "ENTER" && resUpper.decision.metadata?.v2SideFinal === "long", `UPPER Conflict (Breakout Hold) -> ENTER long (got ${resUpper.decision.metadata?.v2DecisionFinal}/${resUpper.decision.metadata?.v2SideFinal})`);

    // LOWER Conflict: Range Long vs Trend Short -> Trend Short wins with breakdown hold
    const candlesLower = makeBaselineCandles(baseTime, 87000, 86550);
    const snapLower = {
        symbol: "BTCUSDT",
        lastPrice: 86550,
        latestCandleClose: 86550,
        boxHigh: 87500,
        boxLow: 86500,
        boxPos: 0.05,
        closedClose: 86550,
        ema20Slope: -0.005,
        emaGap: -0.005,
        trendWeaknessScore: 0.3,
        qualityScore: 68,
        atr: 500,
        candles: candlesLower,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inputLower = adaptV2Input("BTCUSDT" as any, baseTime, snapLower as any, mockConfig as any, state as any, mockResult as any, candlesLower, "authoritative");
    const resLower = runWithJudgment(inputLower, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        qualityScore: 68,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: true,
        reversalConfirmed: false,
        metadata: {
            box_lower_breakdown_hold: true
        }
    });
    check(resLower.decision.metadata?.v2DecisionFinal === "ENTER" && resLower.decision.metadata?.v2SideFinal === "short", `LOWER Conflict (Breakdown Hold) -> ENTER short (got ${resLower.decision.metadata?.v2DecisionFinal}/${resLower.decision.metadata?.v2SideFinal})`);
}

function test4_Confirmed_Breakout_vs_Breakdown() {
    console.log("\n--- TEST 4: Confirmed Breakout Long vs Breakdown Short ---");
    clearGlobalShockStates("BTCUSDT");
    const baseTime = Date.now();
    const state = {
        currentPositions: [],
        directionalShockState: "NONE" as const,
        longAllow: true,
        shortAllow: true,
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        accountEquityKrw: 1000000,
        maxUsableMarginKrw: 800000,
        symbolExposureNotionalCapKrw: 1000000,
        accountEquityUsdt: 1000,
        availableBalanceUsdt: 1000
    };

    // Confirmed Breakout Long (closedClose > boxHigh)
    const candlesUpper = makeBaselineCandles(baseTime, 87000, 87600);
    const snapUpper = {
        symbol: "BTCUSDT",
        lastPrice: 87600,
        latestCandleClose: 87600,
        closedClose: 87550,
        boxHigh: 87500,
        boxLow: 86500,
        boxPos: 1.1,
        boxBreakSide: "upper",
        emaGap: 0.005,
        trendWeaknessScore: 0.2,
        qualityScore: 72,
        atr: 500,
        candles: candlesUpper,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inputUpper = adaptV2Input("BTCUSDT" as any, baseTime, snapUpper as any, mockConfig as any, state as any, mockResult as any, candlesUpper, "authoritative");
    const resUpper = runWithJudgment(inputUpper, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "BREAKOUT_RETEST_CONFIRMED",
        qualityScore: 72,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: true,
        metadata: {
            retestConfirmed: true
        }
    });
    check(resUpper.decision.metadata?.v2DecisionFinal === "ENTER" && resUpper.decision.metadata?.v2SideFinal === "long", `Confirmed Breakout Long -> ENTER long (got ${resUpper.decision.metadata?.v2DecisionFinal}/${resUpper.decision.metadata?.v2SideFinal})`);

    // Confirmed Breakdown Short (closedClose < boxLow)
    const candlesLower = makeBaselineCandles(baseTime, 87000, 86400);
    const snapLower = {
        symbol: "BTCUSDT",
        lastPrice: 86400,
        latestCandleClose: 86400,
        closedClose: 86450,
        boxHigh: 87500,
        boxLow: 86500,
        boxPos: -0.1,
        boxBreakSide: "lower",
        emaGap: -0.005,
        trendWeaknessScore: 0.2,
        qualityScore: 72,
        atr: 500,
        candles: candlesLower,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inputLower = adaptV2Input("BTCUSDT" as any, baseTime, snapLower as any, mockConfig as any, state as any, mockResult as any, candlesLower, "authoritative");
    const resLower = runWithJudgment(inputLower, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "BREAKDOWN_RETEST_FAILED",
        qualityScore: 72,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: true,
        metadata: {
            retestConfirmed: true,
            retestRejected: true
        }
    });
    check(resLower.decision.metadata?.v2DecisionFinal === "ENTER" && resLower.decision.metadata?.v2SideFinal === "short", `Confirmed Breakdown Short -> ENTER short (got ${resLower.decision.metadata?.v2DecisionFinal}/${resLower.decision.metadata?.v2SideFinal})`);
}

function test5_Negative_Mirror_Cases() {
    console.log("\n--- TEST 5: Negative Mirror Cases (Both directions must HOLD) ---");
    clearGlobalShockStates("BTCUSDT");
    const baseTime = Date.now();
    const state = {
        currentPositions: [],
        directionalShockState: "NONE" as const,
        longAllow: true,
        shortAllow: true,
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        accountEquityKrw: 1000000,
        maxUsableMarginKrw: 800000,
        symbolExposureNotionalCapKrw: 1000000,
        accountEquityUsdt: 1000,
        availableBalanceUsdt: 1000
    };

    // 1. Quality < 65 (e.g. 64) -> FTS HOLD
    const candlesUpper = makeBaselineCandles(baseTime, 87000, 87400);
    const snapUpper = { symbol: "BTCUSDT", lastPrice: 87400, latestCandleClose: 87400, boxHigh: 87500, boxLow: 86500, boxPos: 0.9, closedClose: 87400, qualityScore: 64, atr: 500, candles: candlesUpper, htf_candles: {}, data_ready: true, canonicalRegime: "RANGE" as const };
    const inQ64Upper = adaptV2Input("BTCUSDT" as any, baseTime, snapUpper as any, mockConfig as any, state as any, mockResult as any, candlesUpper, "authoritative");
    const resQ64Upper = runWithJudgment(inQ64Upper, {
        regime: "RANGE", subtype: "FAST_TREND_SHIFT", qualityScore: 64, htf_entry_policy: "ALLOW", trendOk: true,
        diagnostics: { fastTrendShift: { active: true, direction: "long", higher_low_detected: true, higher_high_detected: true, box_mid_reclaimed: true, box_upper_breakout_hold: true, stop_price: 86900 } }
    });

    const candlesLower = makeBaselineCandles(baseTime, 87000, 86600);
    const snapLower = { symbol: "BTCUSDT", lastPrice: 86600, latestCandleClose: 86600, boxHigh: 87500, boxLow: 86500, boxPos: 0.1, closedClose: 86600, qualityScore: 64, atr: 500, candles: candlesLower, htf_candles: {}, data_ready: true, canonicalRegime: "RANGE" as const };
    const inQ64Lower = adaptV2Input("BTCUSDT" as any, baseTime, snapLower as any, mockConfig as any, state as any, mockResult as any, candlesLower, "authoritative");
    const resQ64Lower = runWithJudgment(inQ64Lower, {
        regime: "RANGE", subtype: "FAST_TREND_SHIFT", qualityScore: 64, htf_entry_policy: "ALLOW", trendOk: true,
        diagnostics: { fastTrendShift: { active: true, direction: "short", lower_high_detected: true, lower_low_detected: true, box_mid_lost: true, box_lower_breakdown_hold: true, stop_price: 87100 } }
    });
    check(resQ64Upper.decision.metadata?.v2DecisionFinal !== "ENTER", `Quality 64 Upper FTS -> NOT ENTER (got ${resQ64Upper.decision.metadata?.v2DecisionFinal})`);
    check(resQ64Lower.decision.metadata?.v2DecisionFinal !== "ENTER", `Quality 64 Lower FTS -> NOT ENTER (got ${resQ64Lower.decision.metadata?.v2DecisionFinal})`);

    // 2. trendOk = false -> Both HOLD
    const inTrendNotOkUpper = adaptV2Input("BTCUSDT" as any, baseTime, { ...snapUpper, qualityScore: 68 } as any, mockConfig as any, state as any, mockResult as any, candlesUpper, "authoritative");
    const resTrendNotOkUpper = runWithJudgment(inTrendNotOkUpper, {
        regime: "RANGE", subtype: "FAST_TREND_SHIFT", qualityScore: 68, htf_entry_policy: "ALLOW", trendOk: false,
        diagnostics: { fastTrendShift: { active: true, direction: "long", higher_low_detected: true, higher_high_detected: true, box_mid_reclaimed: true, box_upper_breakout_hold: true, stop_price: 86900 } }
    });

    const inTrendNotOkLower = adaptV2Input("BTCUSDT" as any, baseTime, { ...snapLower, qualityScore: 68 } as any, mockConfig as any, state as any, mockResult as any, candlesLower, "authoritative");
    const resTrendNotOkLower = runWithJudgment(inTrendNotOkLower, {
        regime: "RANGE", subtype: "FAST_TREND_SHIFT", qualityScore: 68, htf_entry_policy: "ALLOW", trendOk: false,
        diagnostics: { fastTrendShift: { active: true, direction: "short", lower_high_detected: true, lower_low_detected: true, box_mid_lost: true, box_lower_breakdown_hold: true, stop_price: 87100 } }
    });
    check(resTrendNotOkUpper.decision.metadata?.v2DecisionFinal !== "ENTER", `trendOk=false Upper FTS -> NOT ENTER (got ${resTrendNotOkUpper.decision.metadata?.v2DecisionFinal})`);
    check(resTrendNotOkLower.decision.metadata?.v2DecisionFinal !== "ENTER", `trendOk=false Lower FTS -> NOT ENTER (got ${resTrendNotOkLower.decision.metadata?.v2DecisionFinal})`);

    // 3. Invalid structural stop -> Both HOLD
    const inInvStopUpper = adaptV2Input("BTCUSDT" as any, baseTime, { ...snapUpper, qualityScore: 68 } as any, mockConfig as any, state as any, mockResult as any, candlesUpper, "authoritative");
    const resInvStopUpper = runWithJudgment(inInvStopUpper, {
        regime: "RANGE", subtype: "FAST_TREND_SHIFT", qualityScore: 68, htf_entry_policy: "ALLOW", trendOk: true,
        diagnostics: { fastTrendShift: { active: true, direction: "long", higher_low_detected: true, higher_high_detected: true, box_mid_reclaimed: true, box_upper_breakout_hold: true, stop_price: 88500 } }
    });

    const inInvStopLower = adaptV2Input("BTCUSDT" as any, baseTime, { ...snapLower, qualityScore: 68 } as any, mockConfig as any, state as any, mockResult as any, candlesLower, "authoritative");
    const resInvStopLower = runWithJudgment(inInvStopLower, {
        regime: "RANGE", subtype: "FAST_TREND_SHIFT", qualityScore: 68, htf_entry_policy: "ALLOW", trendOk: true,
        diagnostics: { fastTrendShift: { active: true, direction: "short", lower_high_detected: true, lower_low_detected: true, box_mid_lost: true, box_lower_breakdown_hold: true, stop_price: 85500 } }
    });
    check(resInvStopUpper.decision.metadata?.v2DecisionFinal !== "ENTER", `Invalid Stop Upper FTS -> NOT ENTER (got ${resInvStopUpper.decision.metadata?.v2DecisionFinal})`);
    check(resInvStopLower.decision.metadata?.v2DecisionFinal !== "ENTER", `Invalid Stop Lower FTS -> NOT ENTER (got ${resInvStopLower.decision.metadata?.v2SideFinal})`);

    // 4. HTF opposite-only -> Both HOLD
    const inHtfOppUpper = adaptV2Input("BTCUSDT" as any, baseTime, { ...snapUpper, qualityScore: 68 } as any, mockConfig as any, state as any, mockResult as any, candlesUpper, "authoritative");
    const resHtfOppUpper = runWithJudgment(inHtfOppUpper, {
        regime: "RANGE", subtype: "FAST_TREND_SHIFT", qualityScore: 68, htf_entry_policy: "SHORT_ONLY_OR_NONE", trendOk: true,
        diagnostics: { fastTrendShift: { active: true, direction: "long", higher_low_detected: true, higher_high_detected: true, box_mid_reclaimed: true, box_upper_breakout_hold: true, stop_price: 86900 } }
    });

    const inHtfOppLower = adaptV2Input("BTCUSDT" as any, baseTime, { ...snapLower, qualityScore: 68 } as any, mockConfig as any, state as any, mockResult as any, candlesLower, "authoritative");
    const resHtfOppLower = runWithJudgment(inHtfOppLower, {
        regime: "RANGE", subtype: "FAST_TREND_SHIFT", qualityScore: 68, htf_entry_policy: "LONG_ONLY_OR_NONE", trendOk: true,
        diagnostics: { fastTrendShift: { active: true, direction: "short", lower_high_detected: true, lower_low_detected: true, box_mid_lost: true, box_lower_breakdown_hold: true, stop_price: 87100 } }
    });
    check(resHtfOppUpper.decision.metadata?.v2DecisionFinal !== "ENTER", `HTF Opposite Upper FTS -> NOT ENTER (got ${resHtfOppUpper.decision.metadata?.v2DecisionFinal})`);
    check(resHtfOppLower.decision.metadata?.v2DecisionFinal !== "ENTER", `HTF Opposite Lower FTS -> NOT ENTER (got ${resHtfOppLower.decision.metadata?.v2DecisionFinal})`);

    // 5. Existing position conflict -> Both HOLD
    const inPosUpper = adaptV2Input("BTCUSDT" as any, baseTime, { ...snapUpper, qualityScore: 68 } as any, mockConfig as any, { ...state, currentPositions: [{ symbol: "BTCUSDT", side: "long", size: 1, entryPrice: 87000 }] } as any, mockResult as any, candlesUpper, "authoritative");
    const resPosUpper = runWithJudgment(inPosUpper, {
        regime: "RANGE", subtype: "FAST_TREND_SHIFT", qualityScore: 68, htf_entry_policy: "ALLOW", trendOk: true,
        diagnostics: { fastTrendShift: { active: true, direction: "long", higher_low_detected: true, higher_high_detected: true, box_mid_reclaimed: true, box_upper_breakout_hold: true, stop_price: 86900 } }
    });

    const inPosLower = adaptV2Input("BTCUSDT" as any, baseTime, { ...snapLower, qualityScore: 68 } as any, mockConfig as any, { ...state, currentPositions: [{ symbol: "BTCUSDT", side: "short", size: 1, entryPrice: 87000 }] } as any, mockResult as any, candlesLower, "authoritative");
    const resPosLower = runWithJudgment(inPosLower, {
        regime: "RANGE", subtype: "FAST_TREND_SHIFT", qualityScore: 68, htf_entry_policy: "ALLOW", trendOk: true,
        diagnostics: { fastTrendShift: { active: true, direction: "short", lower_high_detected: true, lower_low_detected: true, box_mid_lost: true, box_lower_breakdown_hold: true, stop_price: 87100 } }
    });
    check(resPosUpper.decision.metadata?.v2DecisionFinal !== "ENTER", `Position Conflict Upper FTS -> NOT ENTER (got ${resPosUpper.decision.metadata?.v2DecisionFinal})`);
    check(resPosLower.decision.metadata?.v2DecisionFinal !== "ENTER", `Position Conflict Lower FTS -> NOT ENTER (got ${resPosLower.decision.metadata?.v2SideFinal})`);
}

function test6_Production_BTC_071623_Exact_Reproduction() {
    console.log("\n--- TEST 6: Production BTC 2026-09-01 07:16:23 Exact Reproduction ---");
    clearGlobalShockStates("BTCUSDT");
    const baseTime = Date.now();
    const state = {
        currentPositions: [],
        directionalShockState: "NONE" as const,
        longAllow: true,
        shortAllow: true,
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        accountEquityKrw: 1000000,
        maxUsableMarginKrw: 800000,
        symbolExposureNotionalCapKrw: 1000000,
        accountEquityUsdt: 1000,
        availableBalanceUsdt: 1000
    };

    // 1. Exact unconfirmed case (trendOk=false, quality=65, no confirmed LL/LH/lowerHold) -> MUST NOT BE ENTER
    const candlesBtc = makeBaselineCandles(baseTime, 87000, 87000);
    const snapExact = {
        symbol: "BTCUSDT",
        lastPrice: 87000,
        latestCandleClose: 87000,
        boxHigh: 90000,
        boxLow: 86000,
        boxPos: 0.2678899082568985, // lower zone
        closedClose: 87000,
        atr: 500,
        trendWeaknessScore: 0.851,
        qualityScore: 65,
        candles: candlesBtc,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inExact = adaptV2Input("BTCUSDT" as any, baseTime, snapExact as any, mockConfig as any, state as any, mockResult as any, candlesBtc, "authoritative");
    const resExact = runWithJudgment(inExact, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "FAST_TREND_SHIFT",
        trendPhase: "DOWN",
        trendOk: false, // NOT OK
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
    check(resExact.decision.metadata?.v2DecisionFinal !== "ENTER", `BTC 07:16:23 exact unconfirmed case -> MUST NOT BE ENTER (got ${resExact.decision.metadata?.v2DecisionFinal})`);

    // 2. Confirmed FTS Lower Short case (trendOk=true, quality=67, confirmed LL/LH/lowerHold/structural stop) -> FTS short probe authority opens
    const snapConfirmed = {
        ...snapExact,
        trendWeaknessScore: 0.3,
        emaGap: -0.005
    };
    const inConfirmed = adaptV2Input("BTCUSDT" as any, baseTime, snapConfirmed as any, mockConfig as any, state as any, mockResult as any, candlesBtc, "authoritative");
    const resConfirmed = runWithJudgment(inConfirmed, {
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
                stop_price: 88500 // valid structural stop > lastPrice
            }
        }
    });
    check(resConfirmed.decision.metadata?.v2DecisionFinal === "ENTER" && resConfirmed.decision.metadata?.v2SideFinal === "short", `BTC with confirmed FTS Lower Short -> ENTER short before breakdown (got ${resConfirmed.decision.metadata?.v2DecisionFinal}/${resConfirmed.decision.metadata?.v2SideFinal})`);
}

function runAll() {
    console.log("================================================================================");
    console.log("     V2 ENTRY DIRECTIONAL SYMMETRY VERIFICATION SUITE");
    console.log("================================================================================");
    
    test1_FTS_Mirrored_UpperLong_vs_LowerShort();
    test2_Range_Probe_Promotion_Symmetry();
    test3_Local_Conflict_Resolution_Symmetry();
    test4_Confirmed_Breakout_vs_Breakdown();
    test5_Negative_Mirror_Cases();
    test6_Production_BTC_071623_Exact_Reproduction();

    console.log("\n================================================================================");
    console.log(`TOTAL: ${passedCount + failedCount} | PASSED: ${passedCount} | FAILED: ${failedCount}`);
    console.log("================================================================================");

    if (failedCount > 0) {
        process.exit(1);
    }
}

runAll();
