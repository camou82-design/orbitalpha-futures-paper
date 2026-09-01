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

function runTier48ConflictMirrorTests() {
    console.log("================================================================================");
    console.log("     TIER 4.8 LOWER-ZONE CONFLICT RESOLVER MECHANICAL MIRROR TEST SUITE");
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

    const mockResultUpper = {
        decision: { regime_state: "RANGE", final_decision: "SKIP", reject_reason: null, required_cost_usd: 0 },
        executorDecision: { decision: "HOLD", side: "none", stopPrice: 88000 } as any,
        intentSide: "none" as const
    };

    const mockResultLower = {
        decision: { regime_state: "RANGE", final_decision: "SKIP", reject_reason: null, required_cost_usd: 0 },
        executorDecision: { decision: "HOLD", side: "none", stopPrice: 85500 } as any,
        intentSide: "none" as const
    };

    // -------------------------------------------------------------------------
    // TEST A: UPPER Range Short positive baseline
    // Range Short (reversalConfirmed=true, quality=68) vs Trend Long (trendPhase=UP)
    // EXPECTED: ENTER short (V2_CONFLICT_RESOLVED_UPPER_SHORT)
    // -------------------------------------------------------------------------
    const candlesA = makeBaselineCandles(baseTime, 87000, 87450);
    const snapA = {
        symbol: "BTCUSDT",
        lastPrice: 87450,
        latestCandleClose: 87450,
        boxHigh: 87500,
        boxLow: 86500,
        boxPos: 0.95,
        rangeConfidence: 0.75,
        boxCohesion01: 0.5,
        closedClose: 87450,
        emaGap: 0.005,
        trendWeaknessScore: 0.3,
        qualityScore: 68,
        atr: 500,
        candles: candlesA,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inA = adaptV2Input("BTCUSDT" as any, baseTime, snapA as any, mockConfig as any, baseState as any, mockResultUpper as any, candlesA, "authoritative");
    const resA = runWithJudgment(inA, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "UP",
        qualityScore: 68,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false,
        reversalConfirmed: true
    });
    check(resA.decision.metadata?.v2DecisionFinal === "ENTER" && resA.decision.metadata?.v2SideFinal === "short" && resA.decision.metadata?.promotion_reason === "V2_CONFLICT_RESOLVED_UPPER_SHORT", `TEST A: UPPER Range Short -> ENTER short (V2_CONFLICT_RESOLVED_UPPER_SHORT) (got ${resA.decision.metadata?.v2DecisionFinal}/${resA.decision.metadata?.v2SideFinal}/${resA.decision.metadata?.promotion_reason})`);

    // -------------------------------------------------------------------------
    // TEST A-MIRROR: LOWER Range Long exact mirror
    // Range Long (reversalConfirmed=true, quality=68) vs Trend Short (trendPhase=DOWN)
    // EXPECTED: ENTER long (V2_CONFLICT_RESOLVED_LOWER_LONG)
    // -------------------------------------------------------------------------
    const candlesAMirror = makeBaselineCandles(baseTime, 87000, 86550);
    const snapAMirror = {
        symbol: "BTCUSDT",
        lastPrice: 86550,
        latestCandleClose: 86550,
        boxHigh: 87500,
        boxLow: 86500,
        boxPos: 0.05,
        rangeConfidence: 0.75,
        boxCohesion01: 0.5,
        closedClose: 86550,
        emaGap: -0.005,
        trendWeaknessScore: 0.3,
        qualityScore: 68,
        atr: 500,
        candles: candlesAMirror,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inAMirror = adaptV2Input("BTCUSDT" as any, baseTime, snapAMirror as any, mockConfig as any, baseState as any, mockResultLower as any, candlesAMirror, "authoritative");
    const resAMirror = runWithJudgment(inAMirror, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "DOWN",
        qualityScore: 68,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false,
        reversalConfirmed: true
    });
    check(resAMirror.decision.metadata?.v2DecisionFinal === "ENTER" && resAMirror.decision.metadata?.v2SideFinal === "long" && resAMirror.decision.metadata?.promotion_reason === "V2_CONFLICT_RESOLVED_LOWER_LONG", `TEST A-MIRROR: LOWER Range Long -> ENTER long (V2_CONFLICT_RESOLVED_LOWER_LONG) (got ${resAMirror.decision.metadata?.v2DecisionFinal}/${resAMirror.decision.metadata?.v2SideFinal}/${resAMirror.decision.metadata?.promotion_reason})`);

    // -------------------------------------------------------------------------
    // TEST B: UPPER Trend Long positive baseline
    // Range Short (reversalConfirmed=false) vs Trend Long (upperBreakoutHold=true, quality=68, trendOk=true)
    // EXPECTED: ENTER long (V2_CONFLICT_RESOLVED_TREND_LONG)
    // -------------------------------------------------------------------------
    const resB = runWithJudgment(inA, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "UP",
        qualityScore: 68,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: true,
        reversalConfirmed: false,
        metadata: {
            box_upper_breakout_hold: true
        }
    });
    check(resB.decision.metadata?.v2DecisionFinal === "ENTER" && resB.decision.metadata?.v2SideFinal === "long" && resB.decision.metadata?.promotion_reason === "V2_CONFLICT_RESOLVED_TREND_LONG", `TEST B: UPPER Trend Long -> ENTER long (V2_CONFLICT_RESOLVED_TREND_LONG) (got ${resB.decision.metadata?.v2DecisionFinal}/${resB.decision.metadata?.v2SideFinal}/${resB.decision.metadata?.promotion_reason})`);

    // -------------------------------------------------------------------------
    // TEST B-MIRROR: LOWER Trend Short exact mirror
    // Range Long (reversalConfirmed=false) vs Trend Short (lowerBreakdownHold=true, quality=68, trendOk=true)
    // EXPECTED: ENTER short (V2_CONFLICT_RESOLVED_TREND_SHORT)
    // -------------------------------------------------------------------------
    const resBMirror = runWithJudgment(inAMirror, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "DOWN",
        qualityScore: 68,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: true,
        reversalConfirmed: false,
        metadata: {
            box_lower_breakdown_hold: true
        }
    });
    check(resBMirror.decision.metadata?.v2DecisionFinal === "ENTER" && resBMirror.decision.metadata?.v2SideFinal === "short" && resBMirror.decision.metadata?.promotion_reason === "V2_CONFLICT_RESOLVED_TREND_SHORT", `TEST B-MIRROR: LOWER Trend Short -> ENTER short (V2_CONFLICT_RESOLVED_TREND_SHORT) (got ${resBMirror.decision.metadata?.v2DecisionFinal}/${resBMirror.decision.metadata?.v2SideFinal}/${resBMirror.decision.metadata?.promotion_reason})`);

    // -------------------------------------------------------------------------
    // TEST C: UPPER both weak -> no entry (HOLD/SKIP)
    // -------------------------------------------------------------------------
    const resC = runWithJudgment(inA, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "UP",
        qualityScore: 64, // below 65/67
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false,
        reversalConfirmed: false
    });
    check(resC.decision.metadata?.v2DecisionFinal !== "ENTER", `TEST C: UPPER both weak -> NOT ENTER (got ${resC.decision.metadata?.v2DecisionFinal})`);

    // -------------------------------------------------------------------------
    // TEST C-MIRROR: LOWER both weak -> no entry (HOLD/SKIP)
    // -------------------------------------------------------------------------
    const resCMirror = runWithJudgment(inAMirror, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "DOWN",
        qualityScore: 64, // below 65/67
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false,
        reversalConfirmed: false
    });
    check(resCMirror.decision.metadata?.v2DecisionFinal !== "ENTER", `TEST C-MIRROR: LOWER both weak -> NOT ENTER (got ${resCMirror.decision.metadata?.v2DecisionFinal})`);

    // -------------------------------------------------------------------------
    // TEST D: BTC 07:16:23 exact production reproduction
    // zone=lower, boxPos=0.2678, quality=65, trendOk=false, closedClose > boxLow
    // EXPECTED: NO ENTER
    // -------------------------------------------------------------------------
    const candlesD = makeBaselineCandles(baseTime, 87000, 87000);
    const snapD = {
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
        candles: candlesD,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inD = adaptV2Input("BTCUSDT" as any, baseTime, snapD as any, mockConfig as any, baseState as any, mockResultLower as any, candlesD, "authoritative");
    const resD = runWithJudgment(inD, {
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
    check(resD.decision.metadata?.v2DecisionFinal !== "ENTER", `TEST D: BTC 07:16 exact (trendOk=false) -> NOT ENTER (got ${resD.decision.metadata?.v2DecisionFinal})`);

    // -------------------------------------------------------------------------
    // TEST E: Lower FTS Short structural positive (closedClose > boxLow)
    // EXPECTED: ENTER short
    // -------------------------------------------------------------------------
    const snapE = {
        ...snapD,
        trendWeaknessScore: 0.3,
        emaGap: -0.005,
        qualityScore: 67
    };
    const inE = adaptV2Input("BTCUSDT" as any, baseTime, snapE as any, mockConfig as any, baseState as any, mockResultLower as any, candlesD, "authoritative");
    const resE = runWithJudgment(inE, {
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
    check(resE.decision.metadata?.v2DecisionFinal === "ENTER" && resE.decision.metadata?.v2SideFinal === "short", `TEST E: Lower FTS Short structural positive -> ENTER short (got ${resE.decision.metadata?.v2DecisionFinal}/${resE.decision.metadata?.v2SideFinal})`);

    // -------------------------------------------------------------------------
    // TEST F: Lower physical breakdown positive (closedClose < boxLow)
    // EXPECTED: ENTER short
    // -------------------------------------------------------------------------
    const candlesF = makeBaselineCandles(baseTime, 87000, 85900);
    const snapF = {
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
        candles: candlesF,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };
    const inF = adaptV2Input("BTCUSDT" as any, baseTime, snapF as any, mockConfig as any, baseState as any, mockResultLower as any, candlesF, "authoritative");
    const resF = runWithJudgment(inF, {
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
    check(resF.decision.metadata?.v2DecisionFinal === "ENTER" && resF.decision.metadata?.v2SideFinal === "short", `TEST F: Lower physical breakdown positive -> ENTER short (got ${resF.decision.metadata?.v2DecisionFinal}/${resF.decision.metadata?.v2SideFinal})`);

    // -------------------------------------------------------------------------
    // TEST G: Both Range Long + Trend Short confirmed -> mirrors Upper precedence (Range is checked first if confirmed)
    // In UPPER: Range Short is evaluated first; if reversalConfirmed=true && quality>=65, Range Short wins.
    // In LOWER: Range Long is evaluated first; if reversalConfirmed=true && quality>=65, Range Long wins.
    // EXPECTED: Single ENTER long decision (V2_CONFLICT_RESOLVED_LOWER_LONG)
    // -------------------------------------------------------------------------
    const resG = runWithJudgment(inAMirror, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "DOWN",
        qualityScore: 68,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: true,
        reversalConfirmed: true,
        metadata: {
            box_lower_breakdown_hold: true
        }
    });
    check(resG.decision.metadata?.v2DecisionFinal === "ENTER" && resG.decision.metadata?.v2SideFinal === "long" && resG.decision.metadata?.promotion_reason === "V2_CONFLICT_RESOLVED_LOWER_LONG", `TEST G: Both confirmed -> Range wins by precedence (V2_CONFLICT_RESOLVED_LOWER_LONG) (got ${resG.decision.metadata?.v2DecisionFinal}/${resG.decision.metadata?.v2SideFinal}/${resG.decision.metadata?.promotion_reason})`);

    // -------------------------------------------------------------------------
    // TEST H: hardBlock / readiness false -> no entry
    // -------------------------------------------------------------------------
    const inH = adaptV2Input("BTCUSDT" as any, baseTime, snapAMirror as any, { ...mockConfig, killSwitchActive: true, serverTradeEnabled: false } as any, { ...baseState, serverTradeEnabled: false, killSwitch: true, paperExecutionReady: false } as any, mockResultLower as any, candlesAMirror, "authoritative");
    const resH = runWithJudgment(inH, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "DOWN",
        qualityScore: 68,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: true,
        reversalConfirmed: true
    });
    check(resH.decision.metadata?.v2DecisionFinal !== "ENTER", `TEST H: hardBlock/readiness=false -> NOT ENTER (got ${resH.decision.metadata?.v2DecisionFinal})`);

    console.log("\n================================================================================");
    console.log(`TOTAL: ${passedCount + failedCount} | PASSED: ${passedCount} | FAILED: ${failedCount}`);
    console.log("================================================================================");

    if (failedCount > 0) {
        process.exit(1);
    }
}

runTier48ConflictMirrorTests();
