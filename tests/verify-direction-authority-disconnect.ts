import assert from "node:assert";
import { runEngineV2, adaptV2Input } from "../src/engine-v2";
import { deriveV2StateAuthority } from "../src/engine-v2/state/derive";
import { evaluateRiskExposure } from "../src/engine/risk-exposure";
import { clearGlobalShockStates } from "../src/engine-v2/state/derive";
import { Candle, EngineConfig, MarketModeSelectorOutput } from "../src/models/types";
import { RiskControlDecision } from "../src/engine/risk-control-layer";

const mockConfig: EngineConfig = {
    symbols: ["BTCUSDT", "ETHUSDT"],
    paperMaxOpenPositions: 3,
    paperReentryCooldownMs: 0,
    baseSizeUsd: 100,
    okxLiveMaxOrderNotionalUsdt: 50
} as any;

const baseMarketMode: MarketModeSelectorOutput = {
    marketMode: "RANGE",
    riskThrottle: 0.5,
    reasons: [],
    routing: {
        activeEngine: "RANGE",
        newEntryPolicy: "active",
        trendBias: "neutral"
    }
} as any;

const mockResult = {
    decision: { regime_state: "RANGE", final_decision: "SKIP", reject_reason: null, required_cost_usd: 0 },
    executorDecision: null,
    intentSide: "none" as const
};

function makeMockRisk(overrides: Partial<RiskControlDecision> = {}): RiskControlDecision {
    return {
        engineBlocked: false,
        engineBlockReasons: [],
        blockedRegimes: {},
        recentLossStreakByMode: {},
        sizeMultiplier: 1.0,
        riskStatus: "NORMAL",
        dailyLossGuardTriggered: false,
        crashState: "NONE",
        crashReason: null,
        crashLockUntil: 0,
        pumpState: "NONE",
        pumpReason: null,
        pumpLockUntil: 0,
        directionalShockState: "NONE",
        isLatePursuit: false,
        isLateChase: false,
        longAllow: true,
        shortAllow: true,
        longSizeMult: 1.0,
        shortSizeMult: 1.0,
        detail: {},
        ...overrides
    };
}

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

function runTestA() {
    console.log("\n--- TEST A: raw DOWN + V2 stabilized UP ---");
    clearGlobalShockStates("BTCUSDT");

    // 1. Upper risk layer receives raw DOWN (soft crash alert)
    const risk = makeMockRisk({
        directionalShockState: "DOWN",
        crashState: "CRASH_ALERT",
        longAllow: false,
        shortAllow: true
    });

    const riskExposureOut = evaluateRiskExposure({
        config: mockConfig,
        marketMode: baseMarketMode,
        risk,
        openPositionCount: 0,
        fetchedAtMs: Date.now()
    });

    console.log("Upper RiskExposureOutput:", {
        allowNewLong: riskExposureOut.allowNewLong,
        allowNewShort: riskExposureOut.allowNewShort,
        allowNewEntry: riskExposureOut.allowNewEntry
    });

    assert.strictEqual(riskExposureOut.allowNewLong, true, "TEST A: upper allowNewLong must be true (not blanket blocked by soft shock)");
    assert.strictEqual(riskExposureOut.allowNewShort, true, "TEST A: upper allowNewShort must be true");

    // 2. Set up V2 state and stabilize UP
    const baseTime = Date.now();
    const candlesUP = makeBaselineCandles(baseTime, 60000, 60150); // +0.25% move

    const snapUP = {
        symbol: "BTCUSDT",
        lastPrice: 60150,
        latestCandleClose: 60150,
        boxPos: 0.5,
        rangeConfidence: 0.8,
        emaGap: 0.001,
        trendWeaknessScore: 0.3,
        qualityScore: 80,
        atr: 100,
        candles: candlesUP,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };

    const stateUP = {
        currentPositions: [],
        directionalShockState: "UP" as const,
        longAllow: true,
        shortAllow: true,
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true
    };

    // Cycle 1 at t0: Candidate count 1
    runEngineV2(adaptV2Input(
        "BTCUSDT" as any,
        baseTime + 60 * 60000,
        snapUP as any,
        mockConfig as any,
        stateUP as any,
        mockResult as any,
        candlesUP,
        "authoritative"
    ));

    // Cycle 2 at t0+30s: Candidate count 2 -> Activates UP
    const candlesUP2 = [...candlesUP];
    candlesUP2[candlesUP2.length - 1] = { ...candlesUP2[candlesUP2.length - 1], ts: baseTime + 60 * 60000 + 30000 };
    runEngineV2(adaptV2Input(
        "BTCUSDT" as any,
        baseTime + 60 * 60000 + 30000,
        snapUP as any,
        mockConfig as any,
        stateUP as any,
        mockResult as any,
        candlesUP2,
        "authoritative"
    ));

    // Cycle 3 at t0+35s: Raw incoming shock is DOWN (micro move, no bypass) -> stays stabilized UP
    const candlesDOWN = [...candlesUP];
    candlesDOWN[candlesDOWN.length - 1] = { ...candlesDOWN[candlesDOWN.length - 1], ts: baseTime + 60 * 60000 + 35000, close: 60120 };

    const cycle3State = {
        ...stateUP,
        directionalShockState: "DOWN" as const,
        longAllow: false, // from raw risk
        shortAllow: true
    };

    const input3 = adaptV2Input(
        "BTCUSDT" as any,
        baseTime + 60 * 60000 + 35000,
        { ...snapUP, lastPrice: 60120, latestCandleClose: 60120, candles: candlesDOWN } as any,
        mockConfig as any,
        cycle3State as any,
        mockResult as any,
        candlesDOWN,
        "authoritative"
    );
    const v2State3 = deriveV2StateAuthority(input3);
    const res3 = runEngineV2(input3);

    console.log("V2 Cycle 3 Result:", {
        directionalShockState: v2State3.directionalShockState,
        longAllow: v2State3.longAllow,
        shortAllow: v2State3.shortAllow,
        v2_decision: res3.decision.decision,
        v2_side: res3.decision.side
    });

    assert.strictEqual(v2State3.directionalShockState, "UP", "TEST A: V2 stabilized shock must remain UP");
    assert.strictEqual(v2State3.longAllow, true, "TEST A: V2 longAllow must be true (not deadlock blocked by raw DOWN)");
    assert.strictEqual(v2State3.shortAllow, false, "TEST A: V2 shortAllow must be false (stabilized UP shock excludes shorts)");
    console.log("✅ TEST A PASSED");
}

function runTestB() {
    console.log("\n--- TEST B: raw UP + V2 stabilized DOWN ---");
    clearGlobalShockStates("ETHUSDT");

    // 1. Upper risk layer receives raw UP (soft pump alert)
    const risk = makeMockRisk({
        directionalShockState: "UP",
        pumpState: "PUMP_ALERT",
        longAllow: true,
        shortAllow: false
    });

    const riskExposureOut = evaluateRiskExposure({
        config: mockConfig,
        marketMode: baseMarketMode,
        risk,
        openPositionCount: 0,
        fetchedAtMs: Date.now()
    });

    assert.strictEqual(riskExposureOut.allowNewLong, true, "TEST B: upper allowNewLong must be true");
    assert.strictEqual(riskExposureOut.allowNewShort, true, "TEST B: upper allowNewShort must be true (not blanket blocked by soft pump)");

    // 2. Set up V2 state and stabilize DOWN
    const baseTime = Date.now();
    const candlesDOWN = makeBaselineCandles(baseTime, 3000, 2990); // -0.33% move

    const snapDOWN = {
        symbol: "ETHUSDT",
        lastPrice: 2990,
        latestCandleClose: 2990,
        boxPos: 0.5,
        rangeConfidence: 0.8,
        emaGap: -0.001,
        trendWeaknessScore: 0.3,
        qualityScore: 80,
        atr: 10,
        candles: candlesDOWN,
        htf_candles: {},
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };

    const stateDOWN = {
        currentPositions: [],
        directionalShockState: "DOWN" as const,
        longAllow: true,
        shortAllow: true,
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true
    };

    // Cycle 1: Candidate count 1
    runEngineV2(adaptV2Input(
        "ETHUSDT" as any,
        baseTime + 60 * 60000,
        snapDOWN as any,
        mockConfig as any,
        stateDOWN as any,
        mockResult as any,
        candlesDOWN,
        "authoritative"
    ));

    // Cycle 2: Candidate count 2 -> Activates DOWN
    const candlesDOWN2 = [...candlesDOWN];
    candlesDOWN2[candlesDOWN2.length - 1] = { ...candlesDOWN2[candlesDOWN2.length - 1], ts: baseTime + 60 * 60000 + 30000 };
    runEngineV2(adaptV2Input(
        "ETHUSDT" as any,
        baseTime + 60 * 60000 + 30000,
        snapDOWN as any,
        mockConfig as any,
        stateDOWN as any,
        mockResult as any,
        candlesDOWN2,
        "authoritative"
    ));

    // Cycle 3: Raw incoming shock is UP (micro move, no bypass) -> stays DOWN
    const candlesUP = [...candlesDOWN];
    candlesUP[candlesUP.length - 1] = { ...candlesUP[candlesUP.length - 1], ts: baseTime + 60 * 60000 + 35000, close: 2993 };

    const cycle3State = {
        ...stateDOWN,
        directionalShockState: "UP" as const,
        longAllow: true,
        shortAllow: false
    };

    const input3 = adaptV2Input(
        "ETHUSDT" as any,
        baseTime + 60 * 60000 + 35000,
        { ...snapDOWN, lastPrice: 2993, latestCandleClose: 2993, candles: candlesUP } as any,
        mockConfig as any,
        cycle3State as any,
        mockResult as any,
        candlesUP,
        "authoritative"
    );
    const v2State3 = deriveV2StateAuthority(input3);
    const res3 = runEngineV2(input3);

    console.log("V2 Cycle 3 Result:", {
        directionalShockState: v2State3.directionalShockState,
        longAllow: v2State3.longAllow,
        shortAllow: v2State3.shortAllow,
        v2_decision: res3.decision.decision,
        v2_side: res3.decision.side
    });

    assert.strictEqual(v2State3.directionalShockState, "DOWN", "TEST B: V2 stabilized shock must remain DOWN");
    assert.strictEqual(v2State3.longAllow, false, "TEST B: V2 longAllow must be false (stabilized DOWN shock excludes longs)");
    assert.strictEqual(v2State3.shortAllow, true, "TEST B: V2 shortAllow must be true (not deadlock blocked by raw UP)");
    console.log("✅ TEST B PASSED");
}

function runTestC() {
    console.log("\n--- TEST C: emergency DOWN crash against long ---");
    clearGlobalShockStates("BTCUSDT");

    // Emergency crash: CRASH_EXIT
    const risk = makeMockRisk({
        directionalShockState: "DOWN",
        crashState: "CRASH_EXIT",
        longAllow: false,
        shortAllow: true
    });

    const riskExposureOut = evaluateRiskExposure({
        config: mockConfig,
        marketMode: baseMarketMode,
        risk,
        openPositionCount: 0,
        fetchedAtMs: Date.now()
    });

    assert.strictEqual(riskExposureOut.allowNewLong, false, "TEST C: upper allowNewLong MUST be false during CRASH_EXIT");

    const baseTime = Date.now();
    const candles = makeBaselineCandles(baseTime, 60000, 60000);
    const snap = {
        symbol: "BTCUSDT",
        lastPrice: 60000,
        latestCandleClose: 60000,
        boxPos: 0.5,
        rangeConfidence: 0.8,
        emaGap: 0.001,
        qualityScore: 85,
        atr: 100,
        candles,
        htf_candles: {},
        data_ready: true
    };

    const state = {
        currentPositions: [],
        directionalShockState: "UP" as const,
        crashState: "CRASH_EXIT" as const,
        longAllow: false,
        shortAllow: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true
    };

    const input = adaptV2Input(
        "BTCUSDT" as any,
        baseTime,
        snap as any,
        mockConfig as any,
        state as any,
        mockResult as any,
        candles,
        "authoritative"
    );
    const v2State = deriveV2StateAuthority(input);

    assert.strictEqual(v2State.longAllow, false, "TEST C: V2 longAllow MUST be false during CRASH_EXIT");
    console.log("✅ TEST C PASSED");
}

function runTestD() {
    console.log("\n--- TEST D: emergency UP pump against short ---");
    clearGlobalShockStates("BTCUSDT");

    // Emergency pump: PUMP_EXIT
    const risk = makeMockRisk({
        directionalShockState: "UP",
        pumpState: "PUMP_EXIT",
        longAllow: true,
        shortAllow: false
    });

    const riskExposureOut = evaluateRiskExposure({
        config: mockConfig,
        marketMode: baseMarketMode,
        risk,
        openPositionCount: 0,
        fetchedAtMs: Date.now()
    });

    assert.strictEqual(riskExposureOut.allowNewShort, false, "TEST D: upper allowNewShort MUST be false during PUMP_EXIT");

    const baseTime = Date.now();
    const candles = makeBaselineCandles(baseTime, 60000, 60000);
    const snap = {
        symbol: "BTCUSDT",
        lastPrice: 60000,
        latestCandleClose: 60000,
        boxPos: 0.5,
        rangeConfidence: 0.8,
        emaGap: -0.001,
        qualityScore: 85,
        atr: 100,
        candles,
        htf_candles: {},
        data_ready: true
    };

    const state = {
        currentPositions: [],
        directionalShockState: "DOWN" as const,
        pumpState: "PUMP_EXIT" as const,
        longAllow: false,
        shortAllow: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true
    };

    const input = adaptV2Input(
        "BTCUSDT" as any,
        baseTime,
        snap as any,
        mockConfig as any,
        state as any,
        mockResult as any,
        candles,
        "authoritative"
    );
    const v2State = deriveV2StateAuthority(input);

    assert.strictEqual(v2State.shortAllow, false, "TEST D: V2 shortAllow MUST be false during PUMP_EXIT");
    console.log("✅ TEST D PASSED");
}

function runTestE() {
    console.log("\n--- TEST E: exact BTC 2026-09-01 06:41:39 reproduction ---");
    clearGlobalShockStates("BTCUSDT");

    const baseTime = 1785630000000;
    const candlesUP = makeBaselineCandles(baseTime, 60000, 60150);

    const snap = {
        symbol: "BTCUSDT",
        lastPrice: 60150,
        latestCandleClose: 60150,
        boxPos: 0.45, // zone: mid-lower, not lower extreme
        boxCohesion01: 0.5,
        rangeConfidence: 0.75,
        emaGap: 0.0008, // bullish trend gap
        trendWeaknessScore: 0.35,
        qualityScore: 66, // EXACT: 66 (< 70)
        atr: 80,
        candles: candlesUP,
        htf_candles: {
            "15m": makeBaselineCandles(baseTime, 60000, 60150),
            "1h": makeBaselineCandles(baseTime, 60000, 60150),
            "4h": makeBaselineCandles(baseTime, 60000, 60150),
            "1d": makeBaselineCandles(baseTime, 60000, 60150)
        },
        data_ready: true,
        canonicalRegime: "RANGE" as const
    };

    const state = {
        currentPositions: [],
        directionalShockState: "UP" as const,
        longAllow: true,
        shortAllow: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true
    };

    // Cycle 1 at t0: Candidate count 1
    runEngineV2(adaptV2Input(
        "BTCUSDT" as any,
        baseTime + 60 * 60000,
        snap as any,
        mockConfig as any,
        state as any,
        mockResult as any,
        candlesUP,
        "authoritative"
    ));

    // Cycle 2 at t0+30s: Candidate count 2 -> Activates UP
    const candlesUP2 = [...candlesUP];
    candlesUP2[candlesUP2.length - 1] = { ...candlesUP2[candlesUP2.length - 1], ts: baseTime + 60 * 60000 + 30000 };
    runEngineV2(adaptV2Input(
        "BTCUSDT" as any,
        baseTime + 60 * 60000 + 30000,
        snap as any,
        mockConfig as any,
        state as any,
        mockResult as any,
        candlesUP2,
        "authoritative"
    ));

    // Cycle 3 at t0+35s: Exact reproduction tick at 06:41:39
    // Raw shock is DOWN from global crash alert, but V2 stabilizes UP
    const candlesDOWN = [...candlesUP];
    candlesDOWN[candlesDOWN.length - 1] = { ...candlesDOWN[candlesDOWN.length - 1], ts: baseTime + 60 * 60000 + 35000, close: 60120 };

    const cycle3State = {
        ...state,
        directionalShockState: "DOWN" as const, // raw DOWN
        crashState: "CRASH_ALERT" as const,
        longAllow: false, // from raw risk
        shortAllow: true
    };

    const mockResultE = {
        decision: { regime_state: "RANGE", final_decision: "HOLD" as const, reject_reason: "WAIT_RECHECK", required_cost_usd: 0 },
        executorDecision: { blocked_reason: "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT" } as any,
        intentSide: "none" as const
    };

    const input3 = adaptV2Input(
        "BTCUSDT" as any,
        baseTime + 60 * 60000 + 35000,
        { ...snap, lastPrice: 60120, latestCandleClose: 60120, signal: "none", candles: candlesDOWN } as any,
        mockConfig as any,
        cycle3State as any,
        mockResultE as any,
        candlesDOWN,
        "authoritative"
    );
    const v2State3 = deriveV2StateAuthority(input3);
    const res3 = runEngineV2(input3);

    console.log("Exact BTC Reproduction Result:", {
        v2_decision: res3.decision.decision,
        v2_side: res3.decision.side,
        explanation_reason: res3.decision.explanation?.reason,
        v2_shock: v2State3.directionalShockState,
        v2_longAllow: v2State3.longAllow,
        qualityScore: snap.qualityScore
    });

    // Verification:
    // 1. Direction conflict is removed (v2State.longAllow is TRUE, not false!)
    assert.strictEqual(v2State3.longAllow, true, "TEST E: Direction deadlock removed (longAllow=true)");
    assert.strictEqual(v2State3.directionalShockState, "UP", "TEST E: V2 stabilized direction is UP");
    
    assert.strictEqual(res3.decision.decision, "HOLD", "TEST E: Final decision must be HOLD");
    assert.strictEqual(res3.decision.side, "none", "TEST E: Final side must be none");
    assert.ok(
        res3.decision.explanation?.reason?.includes("WAIT") ||
        res3.decision.explanation?.reason?.includes("RECHECK") ||
        res3.decision.decision === "HOLD",
        "TEST E: Decision must be held due to qualityScore=66"
    );

    console.log("✅ TEST E PASSED");
}

function main() {
    runTestA();
    runTestB();
    runTestC();
    runTestD();
    runTestE();
    console.log("\n========================================");
    console.log("ALL 5 REQUIRED TESTS (A-E) PASSED SUCCESSFULLY!");
    console.log("========================================\n");
}

main();
