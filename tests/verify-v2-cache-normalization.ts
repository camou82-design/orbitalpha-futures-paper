import { buildV2ExecutionAuthorityEnvelope } from "../src/engine-v2/execution/envelope";
import { runEngineV2, adaptV2Input } from "../src/engine-v2";
import { resolveSymbolDecisionEnvelope } from "../src/engine-v2/reconciler";
import { Candle } from "../src/models/types";

let passCount = 0;
let failCount = 0;

function assertStrict(condition: boolean, msg: string) {
    if (condition) {
        console.log(`[PASS] ${msg}`);
        passCount++;
    } else {
        console.error(`[FAIL] ${msg}`);
        failCount++;
    }
}

function makeMockCandles(count: number, trend: "UP" | "DOWN"): Candle[] {
    const candles: Candle[] = [];
    let price = 50000;
    for (let i = 0; i < count; i++) {
        const move = trend === "UP" ? 100 : -100;
        price += move;
        candles.push({
            ts: 1600000000000 + i * 60000,
            open: price - move,
            high: price + 50,
            low: price - 50,
            close: price,
            volume: 100
        } as any);
    }
    return candles;
}

function makeSnapshot(candles: Candle[], overrides: any = {}) {
    return {
        lastPrice: candles.length > 0 ? candles[candles.length - 1].close : 50000,
        latestCandleClose: candles.length > 0 ? candles[candles.length - 1].close : 50000,
        boxHigh: 60000,
        boxLow: 40000,
        boxPos: 0.5,
        boxPosDiag: 0.5,
        rangeConfidence: 0.85,
        rangeConfidenceDiag: 0.85,
        ema20: 50000,
        emaGap: 0,
        emaGapDiag: 0,
        volatilityProxy: 100,
        volatilityProxyDiag: 100,
        boxCohesion01: 0.9,
        breakoutFailureRate: 0.1,
        trendWeaknessScore: 0.8,
        rangeOscillationScore: 0.8,
        reviewing_ticks: 3,
        regimeExitRisk: 0.1,
        boxBreakSide: "none" as const,
        signal: "NONE",
        qualityScore: 75,
        data_ready: true,
        dump_protection_hit: false,
        volatility_guard_hit: false,
        atr: 120,
        candles,
        htf_candles: {},
        ...overrides
    };
}

const mockConfig = {
    paperMaxOpenPositions: 3,
    paperReentryCooldownMs: 0,
    baseSizeUsd: 100,
    okxLiveMaxOrderNotionalUsdt: 50
};

const mockState = {
    currentPositions: [],
    globalRiskScore: 0,
    lossStreaks: {},
    cyclePnl: 0,
    activeEngine: "RANGE" as const,
    activeMarketMode: "RANGE" as const,
    paperExecutionReady: true,
    signedExecutionReady: true,
    okxAuthMode: "demo" as const,
    okxAuthReady: false,
    okxExchangeAuthOptIn: true,
    okxLiveEnabled: false,
    okxDemoEnabled: false,
    okxApiKeyPresent: false,
    okxApiSecretPresent: false,
    okxPassphrasePresent: false,
    okxSimulatedTradingHeaderEnabled: false,
    serverTradeEnabled: true,
    closeOnlyMode: false,
    killSwitch: false,
    reconcileSafeMode: false,
    riskMode: "NORMAL" as const,
    dailyLossGuardTriggered: false,
    directionalShockState: "NONE" as const,
    pumpState: "NONE" as const,
    pumpLock: false,
    btc_bias: "flat" as const,
    long_allow: true,
    short_allow: true,
    pendingOrdersFetchedAt: 0
};

async function runTests() {
    console.log("=== STARTING CACHE & NORMALIZATION TESTS ===");

    const symbolA = "BTCUSDT";
    const symbolB = "ETHUSDT";
    const cycle1 = "cycle_001";
    const cycle2 = "cycle_002";
    const now = Date.now();

    // 1. Diagnostic candles 120 RANGE_DRIFT_UP
    const candles120 = makeMockCandles(120, "UP");
    const snapDiag = makeSnapshot(candles120);
    const inputDiag = adaptV2Input(
        symbolA,
        now,
        snapDiag as any,
        mockConfig as any,
        mockState as any,
        { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any,
        candles120,
        "diagnostic",
        cycle1
    );

    const resDiag = runEngineV2(inputDiag);
    assertStrict(resDiag.internal.judgment.subtype === "WHIPSAW_SHOCK_RECHECK", "Diagnostic (120 candles) detects WHIPSAW_SHOCK_RECHECK");

    // 2. Authoritative candles 0 same cycle (cache hit)
    const snapAuth = makeSnapshot([]);
    const inputAuth = adaptV2Input(
        symbolA,
        now,
        snapAuth as any,
        mockConfig as any,
        mockState as any,
        { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any,
        [],
        "authoritative",
        cycle1
    );

    const resAuth = runEngineV2(inputAuth);
    assertStrict(resAuth.internal.judgment.subtype === "WHIPSAW_SHOCK_RECHECK", "Authoritative (0 candles, same cycle) cache hit preserves WHIPSAW_SHOCK_RECHECK");

    // 3. Next cycle re-evaluates
    const inputCycle2 = adaptV2Input(
        symbolA,
        now,
        snapAuth as any, // 0 candles
        mockConfig as any,
        mockState as any,
        { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any,
        [],
        "diagnostic",
        cycle2
    );
    const resCycle2 = runEngineV2(inputCycle2);
    // With 0 candles and no cache, it defaults to NO_TRADE or NO_DATA
    assertStrict(resCycle2.internal.judgment.subtype !== "WHIPSAW_SHOCK_RECHECK", "Next cycle correctly re-evaluates and clears cache");

    // 4. Cache independence per symbol
    const inputSymB = adaptV2Input(
        symbolB,
        now,
        snapAuth as any,
        mockConfig as any,
        mockState as any,
        { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any,
        [],
        "authoritative",
        cycle1
    );
    const resSymB = runEngineV2(inputSymB);
    assertStrict(resSymB.internal.judgment.subtype !== "WHIPSAW_SHOCK_RECHECK", "Symbol B is independent of Symbol A's cache");

    // 5. Envelope Normalization Tests (SKIP)
    const envelopeSkip = resolveSymbolDecisionEnvelope({
        symbol: symbolA,
        fetchedAt: now,
        runCycleId: cycle1,
        evaluationMode: "authoritative",
        snapshot: snapAuth as any,
        legacy: {
            regime: "RANGE",
            finalDecision: "SKIP",
            rejectReason: "test",
            requiredCostUsd: 100,
            entryAllowed: false,
            executorLabel: "test",
            intentSide: "long",
            adaptiveOk: true,
            adaptiveDetail: null
        } as any as any,
        config: mockConfig as any,
        state: mockState as any,
        v2Mode: "engine_v2"
    } as any);

    const v2EnvSkip = envelopeSkip.v2_execution_envelope!;
    assertStrict(v2EnvSkip.decision === "SKIP" || v2EnvSkip.decision === "REJECT", "Skip envelope retains non-ENTER decision");
    assertStrict(v2EnvSkip.side === "none", "Skip envelope side normalized to 'none'");
    assertStrict(v2EnvSkip.stageMarginKrw === 0, "Skip envelope stageMarginKrw normalized to 0");
    assertStrict(v2EnvSkip.exposureNotionalKrw === 0, "Skip envelope exposureNotionalKrw normalized to 0");
    assertStrict(v2EnvSkip.newStopPrice === undefined, "Skip envelope newStopPrice normalized to undefined");
    assertStrict(v2EnvSkip.invalidationPx === undefined, "Skip envelope invalidationPx normalized to undefined");
    assertStrict(v2EnvSkip.takeProfitPlan === undefined, "Skip envelope takeProfitPlan normalized to undefined");


    const v2EnvEnter = buildV2ExecutionAuthorityEnvelope({
        symbol: symbolA,
        mode: "engine_v2",
        newStopPrice: 49000, invalidationPx: 48000, takeProfitPlan: "T1_T2", v2Decision: {
            decision: "ENTER",
            side: "long",
            signal: "LONG_CANDIDATE",
            regime: "RANGE",
            subtype: "WHIPSAW_SHOCK_RECHECK",
            risk: {
                stageMarginKrw: 14000,
                finalOrderNotionalUsdt: 10,
                exposureNotionalKrw: 28000,
                appliedLeverage: 10,
                equityMultiple: 2,
                isBlocked: false
            } as any,
            lifecycleAuthority: {
                newStopPrice: 49000,
                invalidationPx: 48000,
                takeProfitPlan: "T1_T2",
                takeProfit1Px: 51000,
                takeProfit2Px: 52000
            } as any
        } as any as any,
        selector: { 
            adopted_result: { adoption_reason: "test",
                engine: "V2",
                adopted_decision: "ENTER",
                adopted_side: "long",
                adopted_regime: "RANGE",
                adopted_size_usd: 10
            } as any,
            legacy_result: { decision: "SKIP", regime: "RANGE" } as any,
            v2_result: { decision: "ENTER", regime: "RANGE" } as any,
            hard_blocks: []
        } as any
    } as any);

    assertStrict(v2EnvEnter.decision === "ENTER", "Enter envelope preserves ENTER decision");
    assertStrict(v2EnvEnter.side === "long", "Enter envelope preserves side");
    assertStrict(v2EnvEnter.stageMarginKrw === 14000, "Enter envelope preserves stageMarginKrw");
    assertStrict(v2EnvEnter.exposureNotionalKrw === 28000, "Enter envelope preserves exposureNotionalKrw");
    assertStrict(v2EnvEnter.newStopPrice === 49000, "Enter envelope preserves newStopPrice");
    assertStrict(v2EnvEnter.invalidationPx === 48000, "Enter envelope preserves invalidationPx");
    assertStrict(v2EnvEnter.takeProfitPlan === "T1_T2", "Enter envelope preserves takeProfitPlan");

    console.log(`\n=== RESULTS: ${passCount} PASSED, ${failCount} FAILED ===`);
    if (failCount > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
