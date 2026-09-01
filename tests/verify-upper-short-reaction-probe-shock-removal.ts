import { runEngineV2, adaptV2Input, marketJudgmentCacheBySymbol } from "../src/engine-v2";
import { clearGlobalShockStates } from "../src/engine-v2/state/derive";
import { buildV2SnapshotBridge } from "../src/engine/paper-engine";
import { Candle, EngineConfig } from "../src/models/types";

function makeFlatProductionBridge(now: number, overrides: Record<string, unknown> = {}) {
    return {
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        closeOnlyMode: false,
        killSwitch: false,
        reconcileSafeMode: false,
        longAllow: true,
        shortAllow: true,
        currentPositions: [],
        openPositions: [],
        executionReadiness: true,
        accountEquityKrw: 10_000_000,
        exposureNotionalCapKrw: 100_000_000,
        symbolExposureNotionalCapKrw: 50_000_000,
        accountEquityUsdt: 10_000,
        availableBalanceUsdt: 10_000,
        liveBalanceReady: true,
        okxActualPositionsReady: true,
        actualAccountNotionalUsdtReady: true,
        okxActualPositions: [],
        okxPendingOrdersReady: true,
        okxPendingOrdersNotionalUsdt: 0,
        okxPendingSymbolNotionalUsdt: 0,
        hasSymbolPendingEntry: false,
        hasUnknownPendingNotional: false,
        okxLiveEnabled: true,
        okxAuthMode: "live",
        okxAuthReady: true,
        okxExchangeAuthOptIn: true,
        okxApiKeyPresent: true,
        okxApiSecretPresent: true,
        okxPassphrasePresent: true,
        balanceFetchedAt: now,
        positionsFetchedAt: now,
        pendingOrdersFetchedAt: now,
        ...overrides
    };
}

function makeLiveConfig(): EngineConfig {
    return {
        paperMaxOpenPositions: 3,
        baseSizeUsd: 100,
        maxSymbolNotionalUsd: 5000,
        maxAccountNotionalUsd: 20000,
        okxLiveEnabled: true,
        okxAuthMode: "live",
        okxExchangeAuthOptIn: true,
        okxLiveMaxOrderNotionalUsdt: 200,
        serverTradeEnabled: true
    } as any;
}

function makeBaselineCandles(baseTime: number, basePrice: number, closePrice: number): Candle[] {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
        candles.push({
            ts: baseTime - (60 - i) * 60000,
            open: basePrice,
            high: basePrice + 100,
            low: basePrice - 100,
            close: basePrice,
            volume: 100
        } as any);
    }
    candles[candles.length - 1] = {
        ...candles[candles.length - 1],
        close: closePrice
    };
    return candles;
}

function makeBaseSnapshot(opts: {
    symbol: string;
    lastPrice: number;
    boxHigh: number;
    boxLow: number;
    boxPos: number;
    qualityScore: number;
    candles: Candle[];
    atr?: number;
    tickSz?: number;
    signal?: string;
    entryCandidate?: boolean;
    emaGap?: number;
}) {
    return {
        symbol: opts.symbol,
        lastPrice: opts.lastPrice,
        latestCandleClose: opts.lastPrice,
        boxHigh: opts.boxHigh,
        boxLow: opts.boxLow,
        boxPos: opts.boxPos,
        closedClose: opts.lastPrice,
        trendWeaknessScore: 0.3,
        qualityScore: opts.qualityScore,
        signal: opts.signal ?? "NONE",
        entryCandidate: opts.entryCandidate ?? false,
        atr: opts.atr ?? 250,
        atr20: opts.atr ?? 250,
        rangeConfidence: 0.78,
        tickSz: opts.tickSz ?? 0.01,
        lotSz: 0.001,
        minSz: 0.001,
        emaGap: opts.emaGap ?? 0,
        candles: opts.candles,
        htf_candles: {
            "5m": opts.candles,
            "15m": opts.candles,
            "1h": opts.candles,
            "4h": opts.candles
        },
        data_ready: true,
        canonicalRegime: "RANGE" as const,
        canonicalRegimeSource: "strategy_market_regime_detector",
        canonicalTrendScore: 0.35,
        reviewing_ticks: 0
    };
}

let passed = 0;
let failed = 0;

function check(cond: boolean, label: string, detail?: string) {
    if (!cond) {
        console.error(`[FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
        failed++;
    } else {
        console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ""}`);
        passed++;
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
            rangeConfidence: 0.78,
            ...judgment,
            metadata: judgment.metadata ?? {},
            diagnostics: judgment.diagnostics ?? {}
        },
        candleCount: 999999
    });
    return runEngineV2(input);
}

console.log("================================================================================");
console.log("     UPPER SHORT REACTION PROBE SHOCK REMOVAL VERIFICATION SUITE (A~H)");
console.log("================================================================================");

const liveConfig = makeLiveConfig();

// Case A: Lower Long Reaction Probe Positive Reference (ENTER long)
{
    const sym = "BTCUSDT_CASE_A";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candlesA = makeBaselineCandles(now, 69000, 68100);
    const snapA = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 68100,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.05,
        qualityScore: 65,
        candles: candlesA,
        emaGap: 0.002
    });
    const bridgeA = makeFlatProductionBridge(now);
    const snapshotBridgeA = buildV2SnapshotBridge(snapA as any);
    const inputA = adaptV2Input(sym as any, now, snapshotBridgeA as any, liveConfig as any, bridgeA as any, { decision: { final_decision: "SKIP" } } as any, candlesA, "authoritative");
    const resA = runWithJudgment(inputA, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "NEUTRAL",
        qualityScore: 65,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false
    });
    const decision = resA.decision.decision;
    const side = resA.decision.side;
    const promo = resA.decision.metadata?.promotionReason;
    check(
        decision === "ENTER" && side === "long" && promo === "V2_LOWER_LONG_REACTION_PROBE_PROMOTION",
        "CASE A: Lower Long Reaction Probe Positive Reference",
        `decision=${decision}, side=${side}, promo=${promo}`
    );
}

// Case B: Upper Short Symmetric Mirror — NO DOWN_SHOCK (ENTER short)
{
    const sym = "BTCUSDT_CASE_B";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candlesB = makeBaselineCandles(now, 69000, 69900);
    const snapB = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 69900,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.95,
        qualityScore: 65,
        candles: candlesB,
        emaGap: -0.002
    });
    const bridgeB = makeFlatProductionBridge(now);
    const snapshotBridgeB = buildV2SnapshotBridge(snapB as any);
    const inputB = adaptV2Input(sym as any, now, snapshotBridgeB as any, liveConfig as any, bridgeB as any, { decision: { final_decision: "SKIP" } } as any, candlesB, "authoritative");
    const resB = runWithJudgment(inputB, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        shockPhase: "NONE",
        trendPhase: "NEUTRAL",
        qualityScore: 65,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false
    });
    const decision = resB.decision.decision;
    const side = resB.decision.side;
    const promo = resB.decision.metadata?.promotionReason;
    check(
        decision === "ENTER" && side === "short" && promo === "V2_UPPER_SHORT_REACTION_PROBE_PROMOTION",
        "CASE B: Upper Short Symmetric Mirror — NO DOWN_SHOCK",
        `decision=${decision}, side=${side}, promo=${promo}`
    );
}

// Case C: Upper Short + DOWN_SHOCK (ENTER short)
{
    const sym = "BTCUSDT_CASE_C";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candlesC = makeBaselineCandles(now, 69000, 69900);
    const snapC = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 69900,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.95,
        qualityScore: 65,
        candles: candlesC,
        emaGap: -0.002
    });
    const bridgeC = makeFlatProductionBridge(now);
    const snapshotBridgeC = buildV2SnapshotBridge(snapC as any);
    const inputC = adaptV2Input(sym as any, now, snapshotBridgeC as any, liveConfig as any, bridgeC as any, { decision: { final_decision: "SKIP" } } as any, candlesC, "authoritative");
    const resC = runWithJudgment(inputC, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        shockPhase: "DOWN_SHOCK",
        trendPhase: "NEUTRAL",
        qualityScore: 65,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false
    });
    const decision = resC.decision.decision;
    const side = resC.decision.side;
    const promo = resC.decision.metadata?.promotionReason;
    check(
        decision === "ENTER" && side === "short" && promo === "V2_UPPER_SHORT_REACTION_PROBE_PROMOTION",
        "CASE C: Upper Short + DOWN_SHOCK",
        `decision=${decision}, side=${side}, promo=${promo}`
    );
}

// Case D: Upper Short Q59 Floor Gate (Non-ENTER)
{
    const sym = "BTCUSDT_CASE_D";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candlesD = makeBaselineCandles(now, 69000, 69900);
    const snapD = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 69900,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.95,
        qualityScore: 59,
        candles: candlesD,
        emaGap: -0.002
    });
    const bridgeD = makeFlatProductionBridge(now);
    const snapshotBridgeD = buildV2SnapshotBridge(snapD as any);
    const inputD = adaptV2Input(sym as any, now, snapshotBridgeD as any, liveConfig as any, bridgeD as any, { decision: { final_decision: "SKIP" } } as any, candlesD, "authoritative");
    const resD = runWithJudgment(inputD, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "NEUTRAL",
        shockPhase: "NONE",
        qualityScore: 59,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false
    });
    const decision = resD.decision.decision;
    const promo = resD.decision.metadata?.promotionReason;
    const blockReason = resD.decision.metadata?.promotionBlockReason ?? (resD.decision as any).reject_reason;
    check(
        decision !== "ENTER" && blockReason === "UPPER_SHORT_REACTION_PROBE_BLOCKED_QUALITY_BELOW_60",
        "CASE D: Upper Short Q59 Floor Gate",
        `decision=${decision}, blockReason=${blockReason}`
    );
}

// Case E: Upper Short HTF LONG_ONLY Veto (HOLD/REJECT)
{
    const sym = "BTCUSDT_CASE_E";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candlesE = makeBaselineCandles(now, 69000, 69900);
    const snapE = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 69900,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.95,
        qualityScore: 65,
        candles: candlesE,
        emaGap: -0.002
    });
    const bridgeE = makeFlatProductionBridge(now);
    const snapshotBridgeE = buildV2SnapshotBridge(snapE as any);
    const inputE = adaptV2Input(sym as any, now, snapshotBridgeE as any, liveConfig as any, bridgeE as any, { decision: { final_decision: "SKIP" } } as any, candlesE, "authoritative");
    const resE = runWithJudgment(inputE, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "NEUTRAL",
        shockPhase: "NONE",
        qualityScore: 65,
        htf_entry_policy: "LONG_ONLY_OR_NONE",
        macro_source: "actual_candles",
        trendOk: false
    });
    const decision = resE.decision.decision;
    const blockReason = resE.decision.metadata?.promotionBlockReason ?? (resE.decision as any).reject_reason;
    check(
        decision !== "ENTER" && blockReason === "UPPER_SHORT_REACTION_PROBE_BLOCKED_HTF_LONG_ONLY",
        "CASE E: Upper Short HTF LONG_ONLY Veto",
        `decision=${decision}, blockReason=${blockReason}`
    );
}

// Case F: Upper Short Risk Short Disallowed (REJECT/SKIP)
{
    const sym = "BTCUSDT_CASE_F";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candlesF = makeBaselineCandles(now, 69000, 69900);
    const snapF = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 69900,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.95,
        qualityScore: 65,
        candles: candlesF,
        emaGap: -0.002
    });
    const bridgeF = makeFlatProductionBridge(now, { shortAllow: false });
    const snapshotBridgeF = buildV2SnapshotBridge(snapF as any);
    const inputF = adaptV2Input(sym as any, now, snapshotBridgeF as any, liveConfig as any, bridgeF as any, { decision: { final_decision: "SKIP" } } as any, candlesF, "authoritative");
    const resF = runWithJudgment(inputF, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "NEUTRAL",
        shockPhase: "NONE",
        qualityScore: 65,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false
    });
    const decision = resF.decision.decision;
    const blockReason = resF.decision.metadata?.promotionBlockReason ?? (resF.decision as any).reject_reason;
    check(
        decision !== "ENTER" && (blockReason === "UPPER_SHORT_REACTION_PROBE_BLOCKED_SHORT_NOT_ALLOWED" || blockReason === "SHORT_NOT_ALLOWED"),
        "CASE F: Upper Short Risk Short Disallowed",
        `decision=${decision}, blockReason=${blockReason}`
    );
}

// Case G: Upper Short Invalid Stop (REJECT)
{
    const sym = "BTCUSDT_CASE_G";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candlesG = makeBaselineCandles(now, 69000, 69900);
    const snapG = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 69900,
        boxHigh: 70000,
        boxLow: 69990, // boxHeightPct < 0.0008 (invalid plan)
        boxPos: 0.95,
        qualityScore: 65,
        candles: candlesG,
        emaGap: -0.002
    });
    const bridgeG = makeFlatProductionBridge(now);
    const snapshotBridgeG = buildV2SnapshotBridge(snapG as any);
    const inputG = adaptV2Input(sym as any, now, snapshotBridgeG as any, liveConfig as any, bridgeG as any, { decision: { final_decision: "SKIP" } } as any, candlesG, "authoritative");
    const resG = runWithJudgment(inputG, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "NEUTRAL",
        shockPhase: "NONE",
        qualityScore: 65,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false
    });
    const decision = resG.decision.decision;
    const blockReason = resG.decision.metadata?.promotionBlockReason ?? (resG.decision as any).reject_reason;
    check(
        decision !== "ENTER" && (blockReason === "UPPER_SHORT_REACTION_PROBE_BLOCKED_TP_SL_PLAN_INVALID" || blockReason === "TP_SL_PLAN_INVALID"),
        "CASE G: Upper Short Invalid Stop",
        `decision=${decision}, blockReason=${blockReason}`
    );
}

// Case H: Upper Short Existing Position Conflict (HOLD/REJECT)
{
    const sym = "BTCUSDT_CASE_H";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candlesH = makeBaselineCandles(now, 69000, 69900);
    const snapH = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 69900,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.95,
        qualityScore: 65,
        candles: candlesH,
        emaGap: -0.002
    });
    const bridgeH = makeFlatProductionBridge(now, {
        currentPositions: [{ symbol: sym, side: "short", size: 0.1, entryPrice: 69900 }],
        openPositions: [{ symbol: sym, side: "short", size: 0.1, entryPrice: 69900 }]
    });
    const snapshotBridgeH = buildV2SnapshotBridge(snapH as any);
    const inputH = adaptV2Input(sym as any, now, snapshotBridgeH as any, liveConfig as any, bridgeH as any, { decision: { final_decision: "SKIP" } } as any, candlesH, "authoritative");
    const resH = runWithJudgment(inputH, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "NEUTRAL",
        shockPhase: "NONE",
        qualityScore: 65,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false
    });
    const decision = resH.decision.decision;
    const blockReason = resH.decision.metadata?.promotionBlockReason ?? (resH.decision as any).reject_reason;
    check(
        decision !== "ENTER",
        "CASE H: Upper Short Existing Position Conflict",
        `decision=${decision}, blockReason=${blockReason}`
    );
}

console.log("================================================================================");
console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log("================================================================================");

if (failed > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
