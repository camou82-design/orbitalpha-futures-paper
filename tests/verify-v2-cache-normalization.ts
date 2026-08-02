import { runEngineV2, adaptV2Input, marketJudgmentCacheBySymbol, normalizeNonEnterDecision } from "../src/engine-v2";
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
        const move = trend === "UP" ? 5 : -5;
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
        reviewing_ticks: 0,
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
    console.log("=== STARTING CACHE BOUNDING & NORMALIZATION TESTS ===\n");
    marketJudgmentCacheBySymbol.clear(); // Reset before tests

    const symbolA = "BTCUSDT";
    const symbolB = "ETHUSDT";
    const cycle1 = "cycle_001";
    const cycle2 = "cycle_002";
    const now = Date.now();

    const candles120Up = makeMockCandles(120, "UP");
    const snapDiagUp = makeSnapshot(candles120Up, { regime: "RANGE", boxCohesion01: 0.1 });

    // A. BTC Diagnostic 120캔들 -> 정상 DRIFT_UP 판단
    const inputDiagUp = adaptV2Input(
        symbolA, now, snapDiagUp as any, mockConfig as any, mockState as any, 
        { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any, 
        candles120Up, "diagnostic", cycle1
    );
    // Force specific HTF properties to test HTF validation
    inputDiagUp.htf_candles = {
        "5m": makeMockCandles(50, "UP"),
        "15m": makeMockCandles(20, "UP"),
        "1h": makeMockCandles(5, "UP"),
        "4h": makeMockCandles(1, "UP"),
        "1d": []
    } as any;

    const resDiagUp = runEngineV2(inputDiagUp);
    
    // Slopes should be correctly computed natively by detecting candles length
    assertStrict(resDiagUp.internal.judgment.subtype === "RANGE_DRIFT_UP", "Diagnostic (120 candles UP) detects RANGE_DRIFT_UP");
    assertStrict(resDiagUp.internal.judgment.rangePhase === "DRIFT_UP", "Diagnostic (120 candles UP) rangePhase is DRIFT_UP");
    
    const jUp = resDiagUp.internal.judgment as any;
    assertStrict(jUp.slopeSource === "candles_fallback", "Diagnostic slopeSource is candles_fallback");
    assertStrict(jUp.bhSlope > 0.00005, `boxHighSlope > 0.00005 (${jUp.bhSlope})`);
    assertStrict(jUp.blSlope > 0.00005, `boxLowSlope > 0.00005 (${jUp.blSlope})`);
    assertStrict(jUp.rcSlope > 0.00005, `rangeCenterSlope > 0.00005 (${jUp.rcSlope})`);
    assertStrict(jUp.e20Slope > 0.00005, `ema20Slope > 0.00005 (${jUp.e20Slope})`);

    // B. 같은 BTC·같은 cycle Authoritative 0캔들 -> 완전한 캐시 적중
    const snapAuth = makeSnapshot([]);
    const inputAuth = adaptV2Input(
        symbolA, now, snapAuth as any, mockConfig as any, mockState as any, 
        { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any, 
        [], "authoritative", cycle1
    );
    // Add smaller HTF counts to simulate lower quality input that should use cache
    inputAuth.htf_candles = { "5m": makeMockCandles(10, "UP") } as any;

    const resAuth = runEngineV2(inputAuth);

    // C. A와 B의 결과 완전 동일
    assertStrict(resAuth.internal.judgment.subtype === "RANGE_DRIFT_UP", "Authoritative (0 candles) cache hit preserves RANGE_DRIFT_UP");
    assertStrict(resAuth.internal.judgment.rangePhase === "DRIFT_UP", "Authoritative (0 candles) cache hit preserves DRIFT_UP");
    const jAuth = resAuth.internal.judgment as any;
    assertStrict(jAuth.bhSlope === jUp.bhSlope, "Slopes are exactly identical (cache hit)");

    // D. 다음 cycle -> 반드시 새로 평가
    const inputCycle2 = adaptV2Input(
        symbolA, now, snapAuth as any, mockConfig as any, mockState as any, 
        { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any, 
        [], "diagnostic", cycle2
    );
    const resCycle2 = runEngineV2(inputCycle2);
    assertStrict(resCycle2.internal.judgment.subtype !== "RANGE_DRIFT_UP", "Next cycle correctly clears cache and re-evaluates");

    // E. BTC와 ETH 캐시 오염 없음
    const inputSymB = adaptV2Input(
        symbolB, now, snapAuth as any, mockConfig as any, mockState as any, 
        { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any, 
        [], "authoritative", cycle1
    );
    const resSymB = runEngineV2(inputSymB);
    assertStrict(resSymB.internal.judgment.subtype !== "RANGE_DRIFT_UP", "Symbol B is independent of Symbol A's cache");

    // F. Map clear
    marketJudgmentCacheBySymbol.clear();

    // BTCUSDT만 1,000 cycle 실행
    for (let i = 0; i < 1000; i++) {
        const iterInput = adaptV2Input(
            symbolA, now, snapAuth as any, mockConfig as any, mockState as any, 
            { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any, 
            [], "diagnostic", `cycle_loop_${i}`
        );
        runEngineV2(iterInput);
    }
    
    // size === 1 확인
    assertStrict(marketJudgmentCacheBySymbol.size === 1, `Cache size should be exactly 1 after 1,000 BTC runs (Actual: ${marketJudgmentCacheBySymbol.size})`);

    // ETHUSDT 실행
    const inputSymBEth = adaptV2Input(
        symbolB, now, snapAuth as any, mockConfig as any, mockState as any, 
        { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any, 
        [], "authoritative", "cycle_eth_test"
    );
    runEngineV2(inputSymBEth);

    // size === 2 확인
    assertStrict(marketJudgmentCacheBySymbol.size === 2, `Cache size should be exactly 2 after BTC + ETH runs (Actual: ${marketJudgmentCacheBySymbol.size})`);

    // H. 0캔들 먼저 후 120캔들 -> 캐시 승격
    const hCycle = "cycle_promote_test";
    const hInput0 = adaptV2Input(
        symbolA, now, snapAuth as any, mockConfig as any, mockState as any, 
        { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any, 
        [], "diagnostic", hCycle
    );
    runEngineV2(hInput0);
    
    const candles120Down = makeMockCandles(120, "DOWN");
    const snapDiagDown = makeSnapshot(candles120Down, { regime: "RANGE", boxCohesion01: 0.1 });
    const hInput120 = adaptV2Input(
        symbolA, now, snapDiagDown as any, mockConfig as any, mockState as any, 
        { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any, 
        candles120Down, "authoritative", hCycle
    );
    hInput120.htf_candles = {
        "5m": makeMockCandles(50, "DOWN"),
        "15m": makeMockCandles(20, "DOWN"),
        "1h": makeMockCandles(5, "DOWN"),
        "4h": makeMockCandles(1, "DOWN"),
        "1d": []
    } as any;
    
    const hRes120 = runEngineV2(hInput120);
    assertStrict(hRes120.internal.judgment.subtype === "RANGE_DRIFT_DOWN" || hRes120.internal.judgment.subtype === "DESCENDING_CHANNEL", `Low-quality 0-candle cache is successfully promoted to 120-candle evaluation (got ${hRes120.internal.judgment.subtype})`);
    assertStrict(hRes120.internal.judgment.rangePhase === "DRIFT_DOWN" || hRes120.internal.judgment.rangePhase === "DESCENDING_CHANNEL", "Drift Down Phase detected correctly");
    
    const jDown = hRes120.internal.judgment as any;
    assertStrict(jDown.bhSlope < -0.00005, `boxHighSlope < -0.00005 (${jDown.bhSlope})`);
    assertStrict(jDown.blSlope < -0.00005, `boxLowSlope < -0.00005 (${jDown.blSlope})`);
    assertStrict(jDown.rcSlope < -0.00005, `rangeCenterSlope < -0.00005 (${jDown.rcSlope})`);
    assertStrict(jDown.e20Slope < -0.00005, `ema20Slope < -0.00005 (${jDown.e20Slope})`);

    // I. runCycleId 누락 시 캐시 재사용 금지
    const hInputMissing = adaptV2Input(
        symbolA, now, snapAuth as any, mockConfig as any, mockState as any, 
        { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: true } as any, 
        [], "authoritative", "" // Missing runCycleId
    );
    const hResMissing = runEngineV2(hInputMissing);
    assertStrict(hResMissing.internal.judgment.subtype !== "RANGE_DRIFT_DOWN", "Missing runCycleId avoids cache successfully");

    // J. 같은 cycle에서 동일 120캔들 반복 호출 -> 재평가 없음 (Cache Hit)
    const hRes120Repeat = runEngineV2(hInput120);
    assertStrict(hRes120Repeat.internal.judgment === hRes120.internal.judgment, "Identical 120-candle inputs hit cache perfectly");


    // 7. Non-ENTER 정규화 검증
    console.log("\n--- Testing Non-ENTER Normalization ---");
    const nonEnterStates = ["SKIP", "HOLD", "REJECT", "DISABLED", "EXIT"] as const;

    for (const state of nonEnterStates) {
        // Create a dirty decision with risk sizing left behind
        const dirtyDecision = {
            decision: state,
            side: "long",
            executionAction: "ENTER",
            risk: {
                stageMarginKrw: 10000,
                exposureNotionalKrw: 50000,
                finalOrderNotionalUsdt: 100,
                requestedOrderNotionalUsdt: 150,
                sizeMultiplier: 1,
            },
            lifecycleAuthority: {
                newStopPrice: 50000,
                suggestedStopPrice: 49000,
                takeProfitPlan: "T1_T2", // this should be preserved!
                invalidationPx: 48000
            },
            committedRiskPlan: { somePlan: true }
        } as any;
        
        normalizeNonEnterDecision(dirtyDecision);
        
        assertStrict(dirtyDecision.side === "none", `[${state}] side is none`);
        assertStrict(dirtyDecision.executionAction === "NONE", `[${state}] executionAction is NONE`);
        assertStrict(dirtyDecision.risk.stageMarginKrw === 0, `[${state}] stageMarginKrw is 0`);
        assertStrict(dirtyDecision.risk.exposureNotionalKrw === 0, `[${state}] exposureNotionalKrw is 0`);
        assertStrict(dirtyDecision.risk.finalOrderNotionalUsdt === 0, `[${state}] finalOrderNotionalUsdt is 0`);
        assertStrict(dirtyDecision.risk.requestedOrderNotionalUsdt === 0, `[${state}] requestedOrderNotionalUsdt is 0`);
        assertStrict(dirtyDecision.committedRiskPlan === undefined, `[${state}] committedRiskPlan is undefined`);
        
        // Preserve checks
        assertStrict(dirtyDecision.lifecycleAuthority.takeProfitPlan === "T1_T2", `[${state}] takeProfitPlan is preserved`);
        assertStrict(dirtyDecision.lifecycleAuthority.newStopPrice === undefined, `[${state}] newStopPrice is removed`);
    }

    console.log("\n--- Testing ENTER Preservation ---");
    const enterDecision = {
        decision: "ENTER",
        side: "long",
        executionAction: "ENTER",
        risk: {
            stageMarginKrw: 10000,
            exposureNotionalKrw: 50000,
            finalOrderNotionalUsdt: 100,
            requestedOrderNotionalUsdt: 150,
            sizeMultiplier: 1,
        },
        lifecycleAuthority: {
            newStopPrice: 50000,
            suggestedStopPrice: 49000,
            takeProfitPlan: "T1_T2",
            invalidationPx: 48000
        },
        committedRiskPlan: { somePlan: true }
    } as any;
    
    normalizeNonEnterDecision(enterDecision);
    
    assertStrict(enterDecision.side === "long", `[ENTER] side is preserved`);
    assertStrict(enterDecision.executionAction === "ENTER", `[ENTER] executionAction is preserved`);
    assertStrict(enterDecision.risk.stageMarginKrw === 10000, `[ENTER] stageMarginKrw is preserved`);
    assertStrict(enterDecision.risk.exposureNotionalKrw === 50000, `[ENTER] exposureNotionalKrw is preserved`);
    assertStrict(enterDecision.risk.finalOrderNotionalUsdt === 100, `[ENTER] finalOrderNotionalUsdt is preserved`);
    assertStrict(enterDecision.lifecycleAuthority.newStopPrice === 50000, `[ENTER] newStopPrice is preserved`);
    assertStrict(enterDecision.committedRiskPlan !== undefined, `[ENTER] committedRiskPlan is preserved`);

    console.log("\n--- Testing EXIT Preservation ---");
    const exitDecision = {
        decision: "EXIT",
        side: "long",
        executionAction: "EXIT",
        risk: {
            stageMarginKrw: 10000,
            exposureNotionalKrw: 50000,
            finalOrderNotionalUsdt: 100,
            requestedOrderNotionalUsdt: 150,
            sizeMultiplier: 1,
        },
        lifecycleAuthority: {
            newStopPrice: 50000,
            takeProfitPlan: "T1_T2",
        },
        committedRiskPlan: { somePlan: true },
        // EXIT-specific properties we want to ensure are not dropped manually (they're not strictly inside risk or lifecycleAuthority, but exist on internal or envelope in practice, or metadata). 
        // We will just test that whatever is inside isn't cleared if it shouldn't be.
        v2ExitAuthority: {
            exitRequired: true,
            exitReason: "TREND_REVERSAL"
        },
        v2PartialAuthority: {
            shouldPartial: true,
            partialAction: "REDUCE_50"
        }
    } as any;
    
    normalizeNonEnterDecision(exitDecision);
    
    assertStrict(exitDecision.side === "none", `[EXIT] side is normalized`);
    assertStrict(exitDecision.executionAction === "NONE", `[EXIT] executionAction is normalized`);
    assertStrict(exitDecision.risk.stageMarginKrw === 0, `[EXIT] stageMarginKrw is zeroed`);
    assertStrict(exitDecision.risk.exposureNotionalKrw === 0, `[EXIT] exposureNotionalKrw is zeroed`);
    assertStrict(exitDecision.committedRiskPlan === undefined, `[EXIT] committedRiskPlan is undefined`);
    assertStrict(exitDecision.lifecycleAuthority.takeProfitPlan === "T1_T2", `[EXIT] takeProfitPlan is preserved`);
    
    // Assert EXIT properties preserved
    assertStrict(exitDecision.v2ExitAuthority.exitRequired === true, `[EXIT] v2ExitAuthority.exitRequired is preserved`);
    assertStrict(exitDecision.v2ExitAuthority.exitReason === "TREND_REVERSAL", `[EXIT] v2ExitAuthority.exitReason is preserved`);
    assertStrict(exitDecision.v2PartialAuthority.shouldPartial === true, `[EXIT] v2PartialAuthority.shouldPartial is preserved`);
    assertStrict(exitDecision.v2PartialAuthority.partialAction === "REDUCE_50", `[EXIT] v2PartialAuthority.partialAction is preserved`);

    console.log(`\n=== RESULTS: ${passCount} PASSED, ${failCount} FAILED ===`);
    if (failCount > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
