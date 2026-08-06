import { runEngineV2 } from "../src/engine-v2";
import { EngineV2Input } from "../src/engine-v2/types";

let passedCount = 0;
let failedCount = 0;

function buildBaseInput(): EngineV2Input {
    return {
        symbol: "BTCUSDT",
        evaluationMode: "authoritative",
        now: Date.now(),
        snapshot: {
            lastPrice: 89900,
            latestCandleClose: 89900,
            closedClose: 89800,
            boxHigh: 92000,
            boxLow: 91000,
            boxPos: -0.1,
            rangeConfidence: 0.8,
            ema20: 92000,
            emaGap: -2100,
            volatilityProxy: 500,
            boxCohesion01: 0.8,
            breakoutFailureRate: 0.2,
            trendWeaknessScore: 0.2,
            rangeOscillationScore: 0.2,
            reviewing_ticks: 2,
            regimeExitRisk: 0.1,
            boxBreakSide: "lower",
            signal: "WAIT_RECHECK",
            qualityScore: 85,
            data_ready: true,
            dump_protection_hit: false,
            volatility_guard_hit: false,
            entryCandidate: false,
            atr: 500,
            atr20: 500,
            boxLowSlope: -0.1,
            rcSlope: -0.1,
            boxHighSlope: 0,
            candles: [] as any
        },
        config: {
            paperMaxOpenPositions: 1,
            paperReentryCooldownMs: 1000,
            baseSizeUsd: 100,
            okxLiveMaxOrderNotionalUsdt: 50000,
            okxLiveMaxAddonNotionalUsdt: 50000,
            okxLiveMaxSymbolNotionalUsdt: 100000,
            okxLiveMaxAccountNotionalUsdt: 200000,
            okxLiveMaxAddonCount: 5
        },
        state: {
            currentPositions: [],
            lossStreaks: {},
            globalRiskScore: 0,
            directionalShockState: "DOWN",
            longAllow: true,
            shortAllow: true,
            executionReadiness: true,
            paperExecutionReady: true,
            signedExecutionReady: true,
            freshTickBarrierActive: false,
            freshTickCompletedCycles: 10,
            freshTickRequiredCycles: 2,
            accountEquityKrw: 10000000,
            maxUsableMarginKrw: 1000000,
            exposureNotionalCapKrw: 50000000,
            okxAuthReady: true,
            liveBalanceReady: true,
            okxActualPositionsReady: true,
            actualAccountNotionalUsdtReady: true,
            okxPendingOrdersReady: true,
            accountEquityUsdt: 10000,
            availableBalanceUsdt: 10000
        }
    };
}

function assertTest(name: string, actual: any, expected: any, isSubset: boolean = false) {
    let ok = true;
    if (isSubset) {
        for (const k of Object.keys(expected)) {
            if (actual[k] !== expected[k]) {
                console.error(`[FAIL] ${name}: key ${k} expected ${expected[k]}, got ${actual[k]}`);
                ok = false;
            }
        }
    } else {
        if (actual !== expected) {
            console.error(`[FAIL] ${name}: expected ${expected}, got ${actual}`);
            ok = false;
        }
    }
    
    if (ok) {
        console.log(`[PASS] ${name}`);
        passedCount++;
    } else {
        failedCount++;
    }
}

function testMicroProbeShort() {
    console.log("--- testMicroProbeShort ---");
    const input = buildBaseInput();
    
    // We need the engine to return WHIPSAW_SHOCK_RECHECK before micro probe evaluation.
    // That means range execution should return SKIP or HOLD with reason WHIPSAW_RECHECK_NOT_CONFIRMED.
    // Or we just trick it by setting it directly if we could. Since we can't easily fake the execution response without a mock,
    // we set the state properly.
    input.snapshot.boxBreakSide = "lower";
    input.snapshot.boxLow = 91000;
    input.snapshot.lastPrice = 89900;
    
    // To trigger CONTINUATION_MICRO_PROBE, we need:
    // isWhipsawRecheckBlock && (v2DecisionAfterPromotion === "HOLD" || "SKIP" || "REJECT")
    // Let's set whipsaw blocking condition in judgment or rely on engine's range-executor.
    
    const result = runEngineV2(input);
    
    // Let's check what happened.
    console.log("Decision:", result.decision.decision, result.decision.side, result.decision.reason);
    console.log("Internal Reason:", result.internal?.reject_reason_after);
}

testMicroProbeShort();

if (failedCount > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
