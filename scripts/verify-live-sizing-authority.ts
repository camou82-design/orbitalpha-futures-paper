import { getEngineConfig } from "../src/config/env";
import { runEngineV2 } from "../src/engine-v2";
import { EngineV2Input } from "../src/engine-v2/types";

function assert(condition: boolean, msg: string) {
    if (!condition) {
        console.error(`❌ ASSERTION FAILED: ${msg}`);
        process.exit(1);
    }
    console.log(`✅ PASS: ${msg}`);
}

async function runVerification() {
    console.log("==========================================");
    console.log("LIVE ORDER SIZING AUTHORITY VERIFICATION");
    console.log("==========================================");

    // 1. Missing Env Verification
    console.log("\n[TEST 1] Missing Env Verification (Should block with LIVE_SIZING_LIMITS_NOT_CONFIGURED)");
    const missingEnvConfig = getEngineConfig({});
    assert(missingEnvConfig.okxLiveMaxOrderNotionalUsdt === null, "okxLiveMaxOrderNotionalUsdt must be null when env unset");
    assert(missingEnvConfig.okxLiveMaxAddonNotionalUsdt === null, "okxLiveMaxAddonNotionalUsdt must be null when env unset");
    assert(missingEnvConfig.okxLiveMaxSymbolNotionalUsdt === null, "okxLiveMaxSymbolNotionalUsdt must be null when env unset");
    assert(missingEnvConfig.okxLiveMaxAccountNotionalUsdt === null, "okxLiveMaxAccountNotionalUsdt must be null when env unset");
    assert(missingEnvConfig.okxLiveMaxAddonCount === null, "okxLiveMaxAddonCount must be null when env unset");

    const dummyInputMissing: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: {
            lastPrice: 3000,
            latestCandleClose: 3000,
            qualityScore: 95,
            volatilityProxy: 10,
            emaGap: 50,
            rangeConfidence: 0.1,
            boxHigh: 2900,
            boxLow: 2700,
            boxPos: 1.5,
            ema20: 2900,
            boxCohesion01: 0.9,
            breakoutFailureRate: 0.05
        } as any,
        config: {
            ...missingEnvConfig,
            baseSizeUsd: 100
        } as any,
        state: {
            currentPositions: [],
            lossStreaks: {},
            globalRiskScore: 0,
            directionalShockState: "NONE",
            longAllow: true,
            shortAllow: true,
            executionReadiness: true,
            freshTickBarrierActive: false,
            freshTickCompletedCycles: 1,
            freshTickRequiredCycles: 1
        },
        v1Result: { regime: "TREND", decision: "ENTER", side: "long", isBlocked: false }
    };

    const res1 = runEngineV2(dummyInputMissing).decision;
    assert(res1.decision === "REJECT", "Decision must be REJECT when env not configured");
    assert(
        res1.risk.blockReason === "LIVE_SIZING_LIMITS_NOT_CONFIGURED" ||
        res1.explanation.reason.includes("LIVE_SIZING_LIMITS_NOT_CONFIGURED"),
        `Block reason must be LIVE_SIZING_LIMITS_NOT_CONFIGURED (got risk.blockReason=${res1.risk.blockReason}, explanation.reason=${res1.explanation.reason})`
    );

    // 2. Explicit Env Verification (40 / 20 / 60 / 80 / 1)
    console.log("\n[TEST 2] Explicit Env Verification (40 / 20 / 60 / 80 / 1)");
    const explicitEnv = {
        OKX_LIVE_MAX_ORDER_NOTIONAL_USDT: "40",
        OKX_LIVE_MAX_ADDON_NOTIONAL_USDT: "20",
        OKX_LIVE_MAX_SYMBOL_NOTIONAL_USDT: "60",
        OKX_LIVE_MAX_ACCOUNT_NOTIONAL_USDT: "80",
        OKX_LIVE_MAX_ADDON_COUNT: "1"
    };
    const validConfig = {
        ...getEngineConfig(explicitEnv),
        baseSizeUsd: 100
    } as any;
    assert(validConfig.okxLiveMaxOrderNotionalUsdt === 40, "okxLiveMaxOrderNotionalUsdt must be 40");
    assert(validConfig.okxLiveMaxAddonNotionalUsdt === 20, "okxLiveMaxAddonNotionalUsdt must be 20");
    assert(validConfig.okxLiveMaxSymbolNotionalUsdt === 60, "okxLiveMaxSymbolNotionalUsdt must be 60");
    assert(validConfig.okxLiveMaxAccountNotionalUsdt === 80, "okxLiveMaxAccountNotionalUsdt must be 80");
    assert(validConfig.okxLiveMaxAddonCount === 1, "okxLiveMaxAddonCount must be 1");

    // Scenario A: Initial Entry Requested 100 USDT -> Final <= 40 USDT
    console.log("\n[TEST 2A] Initial Entry Request 100 USDT -> Capped <= 40 USDT");
    const input2A: EngineV2Input = {
        ...dummyInputMissing,
        config: validConfig,
        state: {
            ...dummyInputMissing.state,
            liveMaxOrderNotionalUsdt: 40,
            liveMaxAddonNotionalUsdt: 20,
            liveMaxSymbolNotionalUsdt: 60,
            liveMaxAccountNotionalUsdt: 80,
            liveMaxAddonCount: 1,
            accountEquityUsdt: 69,
            availableBalanceUsdt: 69,
            existingAccountNotionalUsdt: 0,
            existingSymbolNotionalUsdt: 0
        }
    };
    const res2A = runEngineV2(input2A).decision;
    const finalNotional2A = (res2A.risk.stageMarginKrw / 1400) * 10;
    assert(finalNotional2A <= 40, `Final order notional must be <= 40 USDT (got ${finalNotional2A})`);

    // Scenario B: Existing Symbol Exposure 45 USDT + Addon 20 USDT -> Final <= 15 USDT (Total 60 USDT)
    console.log("\n[TEST 2B] Existing Symbol Exposure 45 USDT + Addon 20 USDT -> Final <= 15 USDT");
    const input2B: EngineV2Input = {
        ...input2A,
        snapshot: {
            ...input2A.snapshot,
            boxPos: 0.5,
            boxHigh: 3200,
            boxLow: 2800
        },
        state: {
            ...input2A.state,
            currentPositions: [{
                symbol: "ETHUSDT",
                side: "LONG",
                entryPrice: 3000,
                sizeUsd: 45,
                entryStage: 1,
                pnlPct: 0.05
            }],
            addOnPolicyAllowed: true,
            existingAccountNotionalUsdt: 45,
            existingSymbolNotionalUsdt: 45
        }
    };
    const res2B = runEngineV2(input2B).decision;
    const finalNotional2B = (res2B.risk.stageMarginKrw / 1400) * 10;
    assert(res2B.risk.isAddOn === true, "Risk sizing must detect isAddOn === true");
    assert(finalNotional2B <= 15, `Addon notional must be <= 15 USDT to respect 60 USDT symbol cap (got ${finalNotional2B})`);

    // Scenario C: Existing Symbol Exposure 60 USDT -> Addon Blocked
    console.log("\n[TEST 2C] Existing Symbol Exposure 60 USDT -> Addon Blocked");
    const input2C: EngineV2Input = {
        ...input2A,
        snapshot: {
            ...input2A.snapshot,
            boxPos: 0.5,
            boxHigh: 3200,
            boxLow: 2800
        },
        state: {
            ...input2A.state,
            currentPositions: [{
                symbol: "ETHUSDT",
                side: "LONG",
                entryPrice: 3000,
                sizeUsd: 60,
                entryStage: 1,
                pnlPct: 0.05
            }],
            addOnPolicyAllowed: true,
            existingAccountNotionalUsdt: 60,
            existingSymbolNotionalUsdt: 60
        }
    };
    const res2C = runEngineV2(input2C).decision;
    assert(res2C.decision === "REJECT" || res2C.risk.isBlocked, "Decision must be REJECT or risk blocked when symbol exposure is 60 USDT");

    // Scenario D: Account Exposure 70 USDT + New 20 USDT -> Final <= 10 USDT or Blocked
    console.log("\n[TEST 2D] Account Exposure 70 USDT + New Entry -> Final <= 10 USDT");
    const input2D: EngineV2Input = {
        ...input2A,
        symbol: "SOLUSDT",
        snapshot: {
            ...input2A.snapshot,
            boxPos: 0.5,
            boxHigh: 3200,
            boxLow: 2800
        },
        state: {
            ...input2A.state,
            currentPositions: [{
                symbol: "ETHUSDT",
                side: "LONG",
                entryPrice: 3000,
                sizeUsd: 70,
                entryStage: 1,
                pnlPct: 0.02
            }],
            existingAccountNotionalUsdt: 70,
            existingSymbolNotionalUsdt: 0
        }
    };
    const res2D = runEngineV2(input2D).decision;
    const finalNotional2D = (res2D.risk.stageMarginKrw / 1400) * 10;
    assert(finalNotional2D <= 10, `New entry notional must be <= 10 USDT to respect 80 USDT account cap (got ${finalNotional2D})`);

    // Scenario E: Addon Count = 1 -> Additional Addon Blocked
    console.log("\n[TEST 2E] Addon Count = 1 -> Additional Addon Blocked");
    const input2E: EngineV2Input = {
        ...input2A,
        snapshot: {
            ...input2A.snapshot,
            qualityScore: 99,
            boxPos: 0.5,
            boxHigh: 3200,
            boxLow: 2800
        },
        state: {
            ...input2A.state,
            currentPositions: [{
                symbol: "ETHUSDT",
                side: "LONG",
                entryPrice: 3000,
                sizeUsd: 30,
                entryStage: 2,
                pnlPct: 0.03,
                addonCount: 1
            } as any],
            addOnPolicyAllowed: true,
            addOnPolicyReason: "ADDON_POLICY_ALLOWED",
            existingAccountNotionalUsdt: 30,
            existingSymbolNotionalUsdt: 30
        }
    };
    const res2E = runEngineV2(input2E).decision;
    assert(res2E.decision === "REJECT", "Decision must be REJECT when addonCount >= 1");
    assert(
        res2E.risk.blockReason === "MAX_ADDON_COUNT_EXCEEDED" ||
        res2E.explanation.reason.includes("MAX_ADDON_COUNT_EXCEEDED"),
        `Block reason must be MAX_ADDON_COUNT_EXCEEDED (got risk.blockReason=${res2E.risk.blockReason}, explanation.reason=${res2E.explanation.reason})`
    );

    // Scenario F: BTCUSDT Long Protected Guard
    console.log("\n[TEST 2F] BTCUSDT Long Protected Guard -> Orders Suppressed");
    const input2F: EngineV2Input = {
        ...input2A,
        symbol: "BTCUSDT",
        state: {
            ...input2A.state,
            okxActualSide: "long",
            currentPositions: [{
                symbol: "BTCUSDT",
                side: "LONG",
                entryPrice: 95000,
                sizeUsd: 47.5,
                entryStage: 1,
                pnlPct: 0.01
            }]
        }
    };
    const res2F = runEngineV2(input2F).decision;
    assert(res2F.decision === "SKIP" || res2F.decision === "HOLD" || res2F.decision === "REJECT", "BTCUSDT Long must suppress ENTER/ADDON");

    console.log("\n==========================================");
    console.log("ALL LIVE SIZING AUTHORITY TESTS PASSED SUCCESSFULLY! 🎉");
    console.log("==========================================");
}

runVerification().catch(err => {
    console.error("Fatal Test Error:", err);
    process.exit(1);
});
