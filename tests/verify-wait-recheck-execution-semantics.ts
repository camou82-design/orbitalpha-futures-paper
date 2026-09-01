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
console.log("     PHASE 4.6 WAIT_RECHECK EXECUTION SEMANTICS VERIFICATION");
console.log("================================================================================");

const liveConfig = makeLiveConfig();

// CASE A: WAIT_RECHECK + side=long (Lower unconfirmed reversal, Q50) -> Expected HOLD
{
    const sym = "BTCUSDT_WR_LONG_Q50";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candles = makeBaselineCandles(now, 69000, 68100);
    const snap = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 68100,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.05,
        qualityScore: 50,
        candles,
        emaGap: 0.002
    });
    const bridge = makeFlatProductionBridge(now);
    const snapshotBridge = buildV2SnapshotBridge(snap as any);
    const input = adaptV2Input(sym as any, now, snapshotBridge as any, liveConfig as any, bridge as any, { decision: { final_decision: "SKIP" } } as any, candles, "authoritative");
    const res = runWithJudgment(input, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "NEUTRAL",
        shockPhase: "NONE",
        qualityScore: 50,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false
    });
    const decision = res.decision.decision;
    const side = res.decision.side;
    console.log(`[CASE A: WR_LONG_Q50] decision=${decision}, side=${side}`);
    check(decision === "HOLD", "CASE A: WAIT_RECHECK + side=long (unpromoted) must be HOLD", `actual=${decision}`);
}

// CASE B: WAIT_RECHECK + side=short (Upper unconfirmed reversal, Q50) -> Expected HOLD
{
    const sym = "BTCUSDT_WR_SHORT_Q50";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candles = makeBaselineCandles(now, 69000, 69900);
    const snap = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 69900,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.95,
        qualityScore: 50,
        candles,
        emaGap: -0.002
    });
    const bridge = makeFlatProductionBridge(now);
    const snapshotBridge = buildV2SnapshotBridge(snap as any);
    const input = adaptV2Input(sym as any, now, snapshotBridge as any, liveConfig as any, bridge as any, { decision: { final_decision: "SKIP" } } as any, candles, "authoritative");
    const res = runWithJudgment(input, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_OSCILLATION",
        trendPhase: "NEUTRAL",
        shockPhase: "NONE",
        qualityScore: 50,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false
    });
    const decision = res.decision.decision;
    const side = res.decision.side;
    console.log(`[CASE B: WR_SHORT_Q50] decision=${decision}, side=${side}`);
    check(decision === "HOLD", "CASE B: WAIT_RECHECK + side=short (unpromoted) must be HOLD", `actual=${decision}`);
}

// CASE C: WAIT_RECHECK + side=none (Mid-zone unconfirmed / neutral) -> Expected HOLD / SKIP
{
    const sym = "BTCUSDT_WR_NONE";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candles = makeBaselineCandles(now, 69000, 69000);
    const snap = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 69000,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.50,
        qualityScore: 65,
        candles,
        emaGap: 0
    });
    const bridge = makeFlatProductionBridge(now);
    const snapshotBridge = buildV2SnapshotBridge(snap as any);
    const input = adaptV2Input(sym as any, now, snapshotBridge as any, liveConfig as any, bridge as any, { decision: { final_decision: "SKIP" } } as any, candles, "authoritative");
    const res = runWithJudgment(input, {
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
    const decision = res.decision.decision;
    const side = res.decision.side;
    console.log(`[CASE C: WR_NONE] decision=${decision}, side=${side}`);
    check(decision === "HOLD" || decision === "SKIP", "CASE C: Mid-zone WAIT_RECHECK/neutral must be HOLD/SKIP", `actual=${decision}`);
}

// CASE D: Normal ENTER signal + valid long side (RANGE_LOWER_REACTION confirmed) -> Expected ENTER long
{
    const sym = "BTCUSDT_NORM_LONG";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candles = makeBaselineCandles(now, 69000, 68100);
    const snap = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 68100,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.05,
        qualityScore: 65,
        candles,
        emaGap: 0.002
    });
    const bridge = makeFlatProductionBridge(now);
    const snapshotBridge = buildV2SnapshotBridge(snap as any);
    const input = adaptV2Input(sym as any, now, snapshotBridge as any, liveConfig as any, bridge as any, { decision: { final_decision: "SKIP" } } as any, candles, "authoritative");
    const res = runWithJudgment(input, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_LOWER_REACTION",
        trendPhase: "NEUTRAL",
        shockPhase: "NONE",
        qualityScore: 65,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false,
        metadata: { reversalConfirmed: true }
    });
    const decision = res.decision.decision;
    const side = res.decision.side;
    console.log(`[CASE D: NORM_LONG] decision=${decision}, side=${side}`);
    check(decision === "ENTER" && side === "long", "CASE D: Normal ENTER signal long must ENTER long", `decision=${decision}, side=${side}`);
}

// CASE E: Normal ENTER signal + valid short side (RANGE_UPPER_REACTION confirmed) -> Expected ENTER short
{
    const sym = "BTCUSDT_NORM_SHORT";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candles = makeBaselineCandles(now, 69000, 69900);
    const snap = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 69900,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.95,
        qualityScore: 65,
        candles,
        emaGap: -0.002
    });
    const bridge = makeFlatProductionBridge(now);
    const snapshotBridge = buildV2SnapshotBridge(snap as any);
    const input = adaptV2Input(sym as any, now, snapshotBridge as any, liveConfig as any, bridge as any, { decision: { final_decision: "SKIP" } } as any, candles, "authoritative");
    const res = runWithJudgment(input, {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_UPPER_REACTION",
        trendPhase: "NEUTRAL",
        shockPhase: "NONE",
        qualityScore: 65,
        htf_entry_policy: "ALLOW",
        macro_source: "actual_candles",
        trendOk: false,
        metadata: { reversalConfirmed: true }
    });
    const decision = res.decision.decision;
    const side = res.decision.side;
    console.log(`[CASE E: NORM_SHORT] decision=${decision}, side=${side}`);
    check(decision === "ENTER" && side === "short", "CASE E: Normal ENTER signal short must ENTER short", `decision=${decision}, side=${side}`);
}

// CASE F: Hard/Risk Block + WAIT_RECHECK -> Hard safety precedence preserved (REJECT / DISABLED)
{
    const sym = "BTCUSDT_HARD_BLOCK";
    clearGlobalShockStates(sym);
    const now = Date.now();
    const candles = makeBaselineCandles(now, 69000, 69900);
    const snap = makeBaseSnapshot({
        symbol: sym,
        lastPrice: 69900,
        boxHigh: 70000,
        boxLow: 68000,
        boxPos: 0.95,
        qualityScore: 65,
        candles,
        emaGap: -0.002
    });
    const bridge = makeFlatProductionBridge(now, { serverTradeEnabled: false, killSwitch: true });
    const snapshotBridge = buildV2SnapshotBridge(snap as any);
    const input = adaptV2Input(sym as any, now, snapshotBridge as any, liveConfig as any, bridge as any, { decision: { final_decision: "SKIP" } } as any, candles, "authoritative");
    const res = runWithJudgment(input, {
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
    const decision = res.decision.decision;
    const side = res.decision.side;
    console.log(`[CASE F: HARD_BLOCK] decision=${decision}, side=${side}`);
    check(decision !== "ENTER" && decision !== "HOLD", "CASE F: Hard block precedence must override WAIT_RECHECK to REJECT/DISABLED", `actual=${decision}`);
}

console.log("================================================================================");
console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log("================================================================================");

if (failed > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
