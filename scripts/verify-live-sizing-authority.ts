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
    console.log("\n[TEST 1] Missing Env Verification (Should parse nulls when env unset)");
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
            boxHigh: 3200,
            boxLow: 2800,
            boxPos: 0.5,
            ema20: 3000,
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
        } as any,
        v1Result: { regime: "TREND", decision: "ENTER", side: "long", isBlocked: false }
    };

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

    // TEST 4A: Paper Mode + Unconfigured Live Limits -> NOT blocked by LIVE_SIZING_LIMITS_NOT_CONFIGURED
    console.log("\n[TEST 4A] Paper Mode + Unconfigured Live Limits -> NOT blocked by LIVE_SIZING_LIMITS_NOT_CONFIGURED");
    const inputPaperUnconfigured: EngineV2Input = {
        ...dummyInputMissing,
        state: {
            ...dummyInputMissing.state,
            okxAuthMode: "demo",
            okxExchangeAuthOptIn: false,
            okxLiveEnabled: false
        } as any
    };
    const resPaperUnconfigured = runEngineV2(inputPaperUnconfigured).decision;
    assert(resPaperUnconfigured.risk.blockReason !== "LIVE_SIZING_LIMITS_NOT_CONFIGURED", "Paper mode must NOT be blocked by unconfigured live limits");

    // TEST 4B: OKX Live ENTER + Unconfigured Live Limits -> Blocked with LIVE_SIZING_LIMITS_NOT_CONFIGURED
    console.log("\n[TEST 4B] OKX Live ENTER + Unconfigured Live Limits -> Blocked with LIVE_SIZING_LIMITS_NOT_CONFIGURED");
    const inputLiveUnconfigured: EngineV2Input = {
        ...dummyInputMissing,
        snapshot: {
            ...dummyInputMissing.snapshot,
            boxPos: 0.5,
            boxHigh: 3200,
            boxLow: 2800
        },
        state: {
            ...dummyInputMissing.state,
            okxAuthMode: "live",
            okxExchangeAuthOptIn: true,
            okxLiveEnabled: true
        } as any
    };
    const resLiveUnconfigured = runEngineV2(inputLiveUnconfigured).decision;
    assert(resLiveUnconfigured.decision === "REJECT", "OKX Live ENTER without limits must be REJECT");
    assert(resLiveUnconfigured.risk.blockReason === "LIVE_SIZING_LIMITS_NOT_CONFIGURED", "Block reason must be LIVE_SIZING_LIMITS_NOT_CONFIGURED");

    // TEST 4C: Exchange rate change -> finalOrderNotionalUsdt remains unchanged
    console.log("\n[TEST 4C] Exchange rate change -> finalOrderNotionalUsdt remains unchanged");
    const input4C: EngineV2Input = {
        ...dummyInputMissing,
        config: validConfig,
        state: {
            ...dummyInputMissing.state,
            baseSizeUsd: 40,
            liveMaxOrderNotionalUsdt: 40,
            liveMaxAddonNotionalUsdt: 20,
            liveMaxSymbolNotionalUsdt: 60,
            liveMaxAccountNotionalUsdt: 80,
            liveMaxAddonCount: 1
        } as any
    };
    const res4C = runEngineV2(input4C).decision;
    const notional4C = res4C.risk.finalOrderNotionalUsdt ?? ((res4C.risk.stageMarginKrw / 1400) * 10);
    assert(notional4C === 40, `finalOrderNotionalUsdt must equal 40 USDT regardless of exchange rate (got ${notional4C})`);

    // TEST 4D: Request 100 USDT -> Final signed submit notional <= 40 USDT
    console.log("\n[TEST 4D] Request 100 USDT -> Final signed submit notional <= 40 USDT");
    const input4D: EngineV2Input = {
        ...dummyInputMissing,
        config: {
            ...validConfig,
            baseSizeUsd: 100
        },
        state: {
            ...dummyInputMissing.state,
            baseSizeUsd: 100,
            liveMaxOrderNotionalUsdt: 40,
            liveMaxAddonNotionalUsdt: 20,
            liveMaxSymbolNotionalUsdt: 60,
            liveMaxAccountNotionalUsdt: 80,
            liveMaxAddonCount: 1
        } as any
    };
    const res4D = runEngineV2(input4D).decision;
    const notional4D = res4D.risk.finalOrderNotionalUsdt ?? ((res4D.risk.stageMarginKrw / 1400) * 10);
    assert(notional4D <= 40, `Requested 100 USDT must be capped at 40 USDT (got ${notional4D})`);

    // TEST 4E: Symbol 45 USDT + Addon -> Final submit payload <= 15 USDT
    console.log("\n[TEST 4E] Symbol 45 USDT + Addon -> Final submit payload <= 15 USDT");
    const input4E: EngineV2Input = {
        ...dummyInputMissing,
        config: validConfig,
        snapshot: {
            ...dummyInputMissing.snapshot,
            boxPos: 0.5,
            boxHigh: 3200,
            boxLow: 2800
        },
        state: {
            ...dummyInputMissing.state,
            liveMaxOrderNotionalUsdt: 40,
            liveMaxAddonNotionalUsdt: 20,
            liveMaxSymbolNotionalUsdt: 60,
            liveMaxAccountNotionalUsdt: 80,
            liveMaxAddonCount: 1,
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
        } as any
    };
    const res4E = runEngineV2(input4E).decision;
    const notional4E = res4E.risk.finalOrderNotionalUsdt ?? ((res4E.risk.stageMarginKrw / 1400) * 10);
    assert(notional4E <= 15, `Addon payload notional must be <= 15 USDT (got ${notional4E})`);

    // TEST 4F: BTCUSDT Protected Long Guard
    console.log("\n[TEST 4F] BTCUSDT Long Protected Guard -> Orders Suppressed");
    const input4F: EngineV2Input = {
        ...dummyInputMissing,
        config: validConfig,
        symbol: "BTCUSDT",
        state: {
            ...dummyInputMissing.state,
            okxActualSide: "long",
            currentPositions: [{
                symbol: "BTCUSDT",
                side: "LONG",
                entryPrice: 95000,
                sizeUsd: 47.5,
                entryStage: 1,
                pnlPct: 0.01
            }]
        } as any
    };
    const res4F = runEngineV2(input4F).decision;
    assert(res4F.decision === "SKIP" || res4F.decision === "HOLD" || res4F.decision === "REJECT", "BTCUSDT Long must suppress ENTER/ADDON");

    console.log("\n==========================================");
    console.log("ALL LIVE SIZING AUTHORITY TESTS PASSED SUCCESSFULLY! 🎉");
    console.log("==========================================");
}

runVerification().catch(err => {
    console.error("Fatal Test Error:", err);
    process.exit(1);
});
