import { runEngineV2, adaptV2Input } from "../src/engine-v2";
import { Candle } from "../src/models/types";

// Helper to create mock snapshot/state for testing
function makeBaseSnapshot(lastPrice: number, candles: Candle[] = []) {
    return {
        lastPrice,
        latestCandleClose: lastPrice,
        boxHigh: lastPrice + 1000,
        boxLow: lastPrice - 1000,
        boxPos: 0.5,
        boxPosDiag: 0.5,
        rangeConfidence: 0.85,
        rangeConfidenceDiag: 0.85,
        ema20: lastPrice,
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
        htf_candles: {}
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
    directionalShockState: "NONE" as const,
    longAllow: true,
    shortAllow: true,
    executionReadiness: true,
    paperExecutionReady: true,
    signedExecutionReady: true,
    freshTickBarrierActive: false,
    freshTickExecutionBlocked: false,
    freshTickCompletedCycles: 0,
    freshTickRequiredCycles: 0,
    serverTradeEnabled: true,
    closeOnlyMode: false,
    killSwitch: false,
    reconcileSafeMode: false,
    accountEquityKrw: 14000000,
    maxUsableMarginKrw: 14000000,
    exposureNotionalCapKrw: 140000000,
    symbolExposureNotionalCapKrw: 70000000,
    dailyLossGuardTriggered: false,
    riskMode: "NORMAL",
    crashState: "NONE",
    pumpState: "NONE",
    okxAuthMode: "demo" as const,
    okxAuthReady: true,
    okxExchangeAuthOptIn: true,
    okxLiveEnabled: false,
    liveBalanceReady: true,
    accountEquityUsd: 10000,
    availableBalanceUsdt: 10000,
    okxActualPositionsReady: true,
    actualAccountNotionalUsdtReady: true
};

const mockResult = {
    decision: { regime_state: "RANGE", final_decision: "SKIP", reject_reason: null, required_cost_usd: 0 },
    executorDecision: null,
    intentSide: "none" as const
};

// Capture PROOF log from a single runEngineV2 call via console interception.
// Captures V2_STATE_AUTHORITY_PROOF (directionalShockState = stabilized result)
// and also looks for V2_DIRECTIONAL_SHOCK_STABILIZATION_PROOF for detail fields.
function runWithProofCapture(symbol: string, nowMs: number, snapshot: ReturnType<typeof makeBaseSnapshot>, state: typeof mockState, candles: Candle[]): {
    stableShockDirection: string | null;
    rawShockDirection: string | null;
    emergencyBypass: boolean;
    candidateCount: number;
    neutralCount: number;
    magnitudePassed: boolean;
} {
    let stateAuthorityCapture: Record<string, unknown> | null = null;
    let stabilizationCapture: Record<string, unknown> | null = null;

    const origInfo = console.info;
    const origLog = console.log;

    const intercept = (...args: unknown[]) => {
        const line = typeof args[0] === "string" ? args[0] : JSON.stringify(args[0]);
        try {
            const parsed = JSON.parse(line);
            if (parsed.symbol === symbol) {
                if (parsed.event === "V2_STATE_AUTHORITY_PROOF") {
                    stateAuthorityCapture = parsed;
                } else if (parsed.event === "V2_DIRECTIONAL_SHOCK_STABILIZATION_PROOF") {
                    stabilizationCapture = parsed;
                }
            }
        } catch { /* ignore */ }
    };

    console.info = (...args: unknown[]) => { intercept(...args); origInfo(...args); };
    console.log  = (...args: unknown[]) => { intercept(...args); origLog(...args); };

    try {
        const v2Input = adaptV2Input(symbol, nowMs, snapshot, mockConfig, state, mockResult, candles);
        runEngineV2(v2Input);
    } finally {
        console.info = origInfo;
        console.log  = origLog;
    }

    // V2_STATE_AUTHORITY_PROOF.directionalShockState = the final stabilized shock used by the engine
    const stableDir = stateAuthorityCapture
        ? String(stateAuthorityCapture["directionalShockState"] ?? "null")
        : null;

    return {
        stableShockDirection: stableDir,
        rawShockDirection: stabilizationCapture ? String(stabilizationCapture["raw_direction"]) : (state.directionalShockState ?? null),
        emergencyBypass: stabilizationCapture ? Boolean(stabilizationCapture["emergency_bypass"]) : false,
        candidateCount: stabilizationCapture ? Number(stabilizationCapture["candidate_count"]) : 0,
        neutralCount: stabilizationCapture ? Number(stabilizationCapture["neutral_count"]) : 0,
        magnitudePassed: stabilizationCapture ? Boolean(stabilizationCapture["magnitude_passed"]) : false,
    };
}

async function main() {
    console.log("=== STARTING DIRECTIONAL SHOCK STABILIZATION VERIFICATION ===");

    // Base Time and baseline candles (60 candles with flat price at 60000)
    const baseTime = Date.now();
    const baselineCandles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
        baselineCandles.push({
            ts: baseTime + i * 60000,
            open: 60000,
            high: 60020,
            low: 59980,
            close: 60000,
            volume: 1000
        });
    }

    // -------------------------------------------------------------
    // Scenario A: ±0.05% 소진폭 교차 진동 -> stabilized NONE 유지
    // rawMovePct ≈ 0.05% < required 0.12% => magnitude fails => stabilized=NONE
    // Uses fresh symbol ETHUSDT_A to avoid state contamination
    // -------------------------------------------------------------
    console.log("\n[SCENARIO A] Small oscillations (0.05% move) -> NONE maintained");
    const candlesA = [...baselineCandles];
    candlesA[candlesA.length - 1] = { ...candlesA[candlesA.length - 1], close: 60030 }; // +0.05%

    const resA = runWithProofCapture("ETHUSDT_A", baseTime + 60 * 60000, makeBaseSnapshot(60030, candlesA), {
        ...mockState,
        directionalShockState: "UP" as any
    }, candlesA);
    const passA = resA.stableShockDirection === "NONE" || resA.stableShockDirection === null;
    console.log(`  stable_direction_after = ${resA.stableShockDirection}, magnitude_passed = ${resA.magnitudePassed}`);
    console.log(`  RESULT: ${passA ? "✅ PASS" : "❌ FAIL"} (expected NONE)`);

    // -------------------------------------------------------------
    // Scenario B: 유효 움직임 raw=UP 1회 -> 후보만 생성, 미활성
    // Move=100 USD (+0.16% > 0.12%) but only 1 tick => candidateCount=1 < 2 => NONE
    // -------------------------------------------------------------
    console.log("\n[SCENARIO B] 1 raw signal with valid move -> shock NONE (insufficient count)");
    const candlesB = [...baselineCandles];
    candlesB[candlesB.length - 1] = { ...candlesB[candlesB.length - 1], close: 60100 }; // +0.16%

    const resB = runWithProofCapture("ETHUSDT_B", baseTime + 60 * 60000, makeBaseSnapshot(60100, candlesB), {
        ...mockState,
        directionalShockState: "UP" as any
    }, candlesB);
    const passB = resB.stableShockDirection !== "UP";
    console.log(`  stable_direction_after = ${resB.stableShockDirection}, candidate_count = ${resB.candidateCount}`);
    console.log(`  RESULT: ${passB ? "✅ PASS" : "❌ FAIL"} (expected not UP_SHOCK yet)`);

    // -------------------------------------------------------------
    // Scenario C: 동일 방향 raw UP 2회 + 30초 -> 활성화
    // Symbol ETHUSDT_C: Tick1 at t0, Tick2 at t0+30s => candidateCount=2, elapsed>=30s => UP_SHOCK
    // -------------------------------------------------------------
    console.log("\n[SCENARIO C] 2 raw signals + 30s elapsed -> UP_SHOCK activated");
    // Tick 1: fresh symbol ETHUSDT_C, first raw UP
    const candlesC1 = [...candlesB];
    runWithProofCapture("ETHUSDT_C", baseTime + 60 * 60000, makeBaseSnapshot(60100, candlesC1), ({
        ...mockState,
        directionalShockState: "UP"
    } as any), candlesC1);
    // Tick 2: 30s later, second raw UP => should activate
    const candlesC2 = [...candlesC1];
    candlesC2[candlesC2.length - 1] = { ...candlesC2[candlesC2.length - 1], ts: baseTime + 60 * 60000 + 30000 };
    const resC = runWithProofCapture("ETHUSDT_C", baseTime + 60 * 60000 + 30000, makeBaseSnapshot(60100, candlesC2), ({
        ...mockState,
        directionalShockState: "UP"
    } as any), candlesC2);
    const passC = resC.stableShockDirection === "UP";
    console.log(`  stable_direction_after = ${resC.stableShockDirection}`);
    console.log(`  RESULT: ${passC ? "✅ PASS" : "❌ FAIL"} (expected UP_SHOCK)`);

    // -------------------------------------------------------------
    // Scenario D: 활성 쇼크 중 반대 방향 micro 진동 -> 기존 유지 (bypass 없음)
    // ETHUSDT_C has UP active. Send DOWN with tiny -0.05% move => no bypass => still UP
    // -------------------------------------------------------------
    console.log("\n[SCENARIO D] Flipped micro raw DOWN (no bypass) -> keep active UP_SHOCK");
    const candlesD = [...baselineCandles];
    candlesD[candlesD.length - 1] = { ...candlesD[candlesD.length - 1], ts: baseTime + 60 * 60000 + 35000, close: 59970 }; // -0.05% too small for bypass

    const resD = runWithProofCapture("ETHUSDT_C", baseTime + 60 * 60000 + 35000, makeBaseSnapshot(60070, candlesD), ({
        ...mockState,
        directionalShockState: "DOWN"
    } as any), candlesD);
    // Direct flip prohibited without emergency bypass => stays UP
    const passD = resD.stableShockDirection === "UP";
    console.log(`  stable_direction_after = ${resD.stableShockDirection} (expected UP, not DOWN)`);
    console.log(`  RESULT: ${passD ? "✅ PASS" : "❌ FAIL"} (expected no direct flip to DOWN)`);

    // -------------------------------------------------------------
    // Scenario E: NONE raw 2회 + 45초 -> 쇼크 해제
    // ETHUSDT_C has UP active since t0+30000. Send NONE at t0+75000, t0+120000 (>=45s after activation)
    // -------------------------------------------------------------
    console.log("\n[SCENARIO E] NONE raw x2 + 45s -> shock release");
    const candlesE1 = [...baselineCandles];
    candlesE1[candlesE1.length - 1] = { ...candlesE1[candlesE1.length - 1], ts: baseTime + 60 * 60000 + 75000 };
    const resE1 = runWithProofCapture("ETHUSDT_C", baseTime + 60 * 60000 + 75000, makeBaseSnapshot(60000, candlesE1), ({
        ...mockState,
        directionalShockState: "NONE"
    } as any), candlesE1);
    console.log(`  Tick 1: stable=${resE1.stableShockDirection} (neutralCount=${resE1.neutralCount})`);

    const candlesE2 = [...candlesE1];
    candlesE2[candlesE2.length - 1] = { ...candlesE1[candlesE1.length - 1], ts: baseTime + 60 * 60000 + 120000 };
    const resE2 = runWithProofCapture("ETHUSDT_C", baseTime + 60 * 60000 + 120000, makeBaseSnapshot(60000, candlesE2), ({
        ...mockState,
        directionalShockState: "NONE"
    } as any), candlesE2);
    const passE = resE2.stableShockDirection === "NONE";
    console.log(`  Tick 2: stable=${resE2.stableShockDirection} (neutralCount=${resE2.neutralCount})`);
    console.log(`  RESULT: ${passE ? "✅ PASS" : "❌ FAIL"} (expected NONE after release)`);

    // -------------------------------------------------------------
    // Scenario F: 0.35% 이상 실제 급변 -> emergency bypass 즉시 활성
    // Fresh ETHUSDT_F. 5m window: 6 candles all at 60250 (+0.41% > 0.35%) => bypass fires => immediate UP
    // -------------------------------------------------------------
    console.log("\n[SCENARIO F] Sudden move >= 0.35% -> instant UP_SHOCK via emergency bypass");
    const candlesF = [...baselineCandles];
    for (let j = 0; j < 5; j++) {
        candlesF[candlesF.length - 1 - j] = { ...candlesF[candlesF.length - 1 - j], close: 60250 };
    }

    const resF = runWithProofCapture("ETHUSDT_F", baseTime + 60 * 60000, makeBaseSnapshot(60250, candlesF), {
        ...mockState,
        directionalShockState: "UP" as any
    }, candlesF);
    // Emergency bypass: should be UP on very first call despite candidateCount=1
    const passF = resF.stableShockDirection === "UP";
    console.log(`  stable_direction_after = ${resF.stableShockDirection} (bypass skips 2-tick requirement)`);
    console.log(`  RESULT: ${passF ? "✅ PASS" : "❌ FAIL"} (expected UP_SHOCK via emergency bypass)`);

    // -------------------------------------------------------------
    // Scenario G: emergency bypass로 반대 방향 즉시 전환 (UP->DOWN)
    // ETHUSDT_G: UP activated via bypass first, then DOWN via bypass => immediate flip
    // -------------------------------------------------------------
    console.log("\n[SCENARIO G] Emergency bypass: instant flip UP->DOWN_SHOCK");
    const candlesF2 = [...baselineCandles];
    for (let j = 0; j < 5; j++) {
        candlesF2[candlesF2.length - 1 - j] = { ...candlesF2[candlesF2.length - 1 - j], close: 60250 };
    }
    runWithProofCapture("ETHUSDT_G", baseTime + 60 * 60000, makeBaseSnapshot(60250, candlesF2), {
        ...mockState,
        directionalShockState: "UP" as any
    }, candlesF2);

    const candlesG = [...baselineCandles];
    for (let j = 0; j < 5; j++) {
        candlesG[candlesG.length - 1 - j] = { ...candlesG[candlesG.length - 1 - j], close: 59700 };
    }
    const resG = runWithProofCapture("ETHUSDT_G", baseTime + 60 * 60000 + 10000, makeBaseSnapshot(59700, candlesG), {
        ...mockState,
        directionalShockState: "DOWN" as any
    }, candlesG);
    const passG = resG.stableShockDirection === "DOWN";
    console.log(`  stable_direction_after = ${resG.stableShockDirection} (bypass allows immediate flip UP->DOWN)`);
    console.log(`  RESULT: ${passG ? "✅ PASS" : "❌ FAIL"} (expected DOWN_SHOCK via emergency bypass)`);

    // -------------------------------------------------------------
    // Scenario H: raw=NONE, no active shock -> stable NONE 유지
    // Fresh ETHUSDT_H with no prior state => NONE
    // -------------------------------------------------------------
    console.log("\n[SCENARIO H] raw=NONE + no active shock -> stable NONE");
    const resH = runWithProofCapture("ETHUSDT_H", baseTime + 60 * 60000 + 200000, makeBaseSnapshot(60000, baselineCandles), {
        ...mockState,
        directionalShockState: "NONE" as const
    }, baselineCandles);
    const passH = resH.stableShockDirection === "NONE";
    console.log(`  stable_direction_after = ${resH.stableShockDirection}`);
    console.log(`  RESULT: ${passH ? "✅ PASS" : "❌ FAIL"} (expected NONE)`);

    // -------------------------------------------------------------
    // Scenario I: 동일 캔들 중복 호출 (Duplicate calls in same tick shouldn't increment count)
    // -------------------------------------------------------------
    console.log("\n[SCENARIO I] Duplicate calls in same tick -> candidate count should not double increment");
    const baseTimeI = baseTime + 70 * 60000;
    // Call 1
    runWithProofCapture("ETHUSDT_I", baseTimeI, makeBaseSnapshot(60100, candlesB), {
        ...mockState,
        directionalShockState: "UP" as any
    }, candlesB);
    // Call 2 (same tick/nowMs)
    const resI = runWithProofCapture("ETHUSDT_I", baseTimeI, makeBaseSnapshot(60100, candlesB), {
        ...mockState,
        directionalShockState: "UP" as any
    }, candlesB);
    const passI = resI.candidateCount === 1; // Not 2!
    console.log(`  candidateCount = ${resI.candidateCount}`);
    console.log(`  RESULT: ${passI ? "✅ PASS" : "❌ FAIL"} (expected count=1)`);

    // -------------------------------------------------------------
    // Scenario J: NONE→UP→NONE 비연속 해제 방지 (Non-consecutive NONE shouldn't release)
    // -------------------------------------------------------------
    console.log("\n[SCENARIO J] Non-consecutive NONE shouldn't release active shock");
    // 1. Activate UP
    const candlesJ1 = [...candlesB];
    runWithProofCapture("ETHUSDT_J", baseTime + 60 * 60000, makeBaseSnapshot(60100, candlesJ1), ({
        ...mockState,
        directionalShockState: "UP"
    } as any), candlesJ1);
    const candlesJ2 = [...candlesJ1];
    candlesJ2[candlesJ2.length - 1] = { ...candlesJ2[candlesJ2.length - 1], ts: baseTime + 60 * 60000 + 30000 };
    runWithProofCapture("ETHUSDT_J", baseTime + 60 * 60000 + 30000, makeBaseSnapshot(60100, candlesJ2), ({
        ...mockState,
        directionalShockState: "UP"
    } as any), candlesJ2);
    // 2. First NONE
    const candlesJ3 = [...baselineCandles];
    candlesJ3[candlesJ3.length - 1] = { ...candlesJ3[candlesJ3.length - 1], ts: baseTime + 60 * 60000 + 75000 };
    runWithProofCapture("ETHUSDT_J", baseTime + 60 * 60000 + 75000, makeBaseSnapshot(60000, candlesJ3), ({
        ...mockState,
        directionalShockState: "NONE"
    } as any), candlesJ3);
    // 3. Interrupt with UP
    const candlesJ4 = [...candlesB];
    candlesJ4[candlesJ4.length - 1] = { ...candlesJ4[candlesJ4.length - 1], ts: baseTime + 60 * 60000 + 80000 };
    runWithProofCapture("ETHUSDT_J", baseTime + 60 * 60000 + 80000, makeBaseSnapshot(60100, candlesJ4), ({
        ...mockState,
        directionalShockState: "UP"
    } as any), candlesJ4);
    // 4. Second NONE, time > 45s, but neutralCount should have reset
    const candlesJ5 = [...baselineCandles];
    candlesJ5[candlesJ5.length - 1] = { ...candlesJ5[candlesJ5.length - 1], ts: baseTime + 60 * 60000 + 120000 };
    const resJ = runWithProofCapture("ETHUSDT_J", baseTime + 60 * 60000 + 120000, makeBaseSnapshot(60000, candlesJ5), ({
        ...mockState,
        directionalShockState: "NONE"
    } as any), candlesJ5);
    const passJ = resJ.stableShockDirection === "UP" && resJ.neutralCount === 1;
    console.log(`  stable_direction_after = ${resJ.stableShockDirection}, neutralCount = ${resJ.neutralCount}`);
    console.log(`  RESULT: ${passJ ? "✅ PASS" : "❌ FAIL"} (expected UP to be maintained, neutralCount=1)`);

    // -------------------------------------------------------------
    // Scenario K: 급락 중 raw UP 불일치 차단 (During sudden drop, raw UP shouldn't trigger bypass)
    // -------------------------------------------------------------
    console.log("\n[SCENARIO K] Sudden drop but raw direction is UP -> Bypass blocked");
    const candlesK = [...baselineCandles];
    for (let j = 0; j < 5; j++) {
        candlesK[candlesK.length - 1 - j] = { ...candlesK[candlesK.length - 1 - j], close: 59000 }; // Huge drop
    }
    const resK = runWithProofCapture("ETHUSDT_K", baseTime + 60 * 60000, makeBaseSnapshot(59000, candlesK), {
        ...mockState,
        directionalShockState: "UP" as any // Raw direction UP despite drop
    }, candlesK);
    const passK = resK.emergencyBypass === false && resK.stableShockDirection === "NONE";
    console.log(`  stable_direction_after = ${resK.stableShockDirection}, emergencyBypass = ${resK.emergencyBypass}`);
    console.log(`  RESULT: ${passK ? "✅ PASS" : "❌ FAIL"} (expected NONE and bypass=false)`);

    // -------------------------------------------------------------
    // Scenario L: 동일 run_cycle_id이지만 input.now가 서로 다른 두 호출
    // -------------------------------------------------------------
    console.log("\n[SCENARIO L] Same run_cycle_id but different input.now -> No duplicate increment");
    const baseTimeL = baseTime + 80 * 60000;
    runWithProofCapture("ETHUSDT_L", baseTimeL, makeBaseSnapshot(60100, candlesB), ({
        ...mockState,
        run_cycle_id: "cycle_L_1",
        directionalShockState: "UP"
    } as any), candlesB);
    const resL = runWithProofCapture("ETHUSDT_L", baseTimeL + 500, makeBaseSnapshot(60100, candlesB), ({
        ...mockState,
        run_cycle_id: "cycle_L_1",
        directionalShockState: "UP"
    } as any), candlesB);
    const passL = resL.candidateCount === 1;
    console.log(`  candidateCount = ${resL.candidateCount}`);
    console.log(`  RESULT: ${passL ? "✅ PASS" : "❌ FAIL"} (expected count=1)`);

    // -------------------------------------------------------------
    // Scenario M: run_cycle_id가 없고 동일 최신 캔들 ts로 두 번 호출
    // -------------------------------------------------------------
    console.log("\n[SCENARIO M] No run_cycle_id, same latest candle ts, different input.now -> No duplicate increment");
    const baseTimeM = baseTime + 90 * 60000;
    // Set a distinct candle ts
    const candlesM = [...baselineCandles];
    candlesM[candlesM.length - 1] = { ...candlesM[candlesM.length - 1], ts: baseTimeM - 30000, close: 60100 };
    runWithProofCapture("ETHUSDT_M", baseTimeM, makeBaseSnapshot(60100, candlesM), ({
        ...mockState,
        run_cycle_id: undefined, // no cycle ID
        directionalShockState: "UP"
    } as any), candlesM);
    const resM = runWithProofCapture("ETHUSDT_M", baseTimeM + 500, makeBaseSnapshot(60100, candlesM), ({
        ...mockState,
        run_cycle_id: undefined, // no cycle ID
        directionalShockState: "UP"
    } as any), candlesM);
    const passM = resM.candidateCount === 1;
    console.log(`  candidateCount = ${resM.candidateCount}`);
    console.log(`  RESULT: ${passM ? "✅ PASS" : "❌ FAIL"} (expected count=1)`);

    // -------------------------------------------------------------
    // Scenario N: 최신 캔들 ts가 변경된 다음 사이클 -> 정상 증가
    // -------------------------------------------------------------
    console.log("\n[SCENARIO N] Latest candle ts changes -> Count increments");
    const baseTimeN = baseTime + 100 * 60000;
    const candlesN1 = [...baselineCandles];
    candlesN1[candlesN1.length - 1] = { ...candlesN1[candlesN1.length - 1], ts: baseTimeN - 60000, close: 60100 };
    runWithProofCapture("ETHUSDT_N", baseTimeN, makeBaseSnapshot(60100, candlesN1), ({
        ...mockState,
        run_cycle_id: undefined,
        directionalShockState: "UP"
    } as any), candlesN1);
    
    const candlesN2 = [...candlesN1];
    candlesN2[candlesN2.length - 1] = { ...candlesN1[candlesN1.length - 1], ts: baseTimeN, close: 60150 };
    const resN = runWithProofCapture("ETHUSDT_N", baseTimeN + 60000, makeBaseSnapshot(60150, candlesN2), ({
        ...mockState,
        run_cycle_id: undefined,
        directionalShockState: "UP"
    } as any), candlesN2);
    const passN = resN.candidateCount === 2;
    console.log(`  candidateCount = ${resN.candidateCount}`);
    console.log(`  RESULT: ${passN ? "✅ PASS" : "❌ FAIL"} (expected count=2)`);


    // =============================================================
    // Summary
    // =============================================================
    const results = [passA, passB, passC, passD, passE, passF, passG, passH, passI, passJ, passK, passL, passM, passN];
    const passCount = results.filter(Boolean).length;
    console.log(`\n=== VERIFICATION COMPLETED: ${passCount}/${results.length} SCENARIOS PASSED ===`);
    const labels = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N"];
    results.forEach((r, i) => console.log(`  Scenario ${labels[i]}: ${r ? "✅ PASS" : "❌ FAIL"}`));
}

main().catch(console.error);
