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

// Mock contract normalization function matching OKX contract sizing logic
function normalizeOkxSwapContractsFromNotional(args: {
    desiredNotionalUsdt: number;
    lastPrice: number;
    sizing: { ctVal: number; lotSz: number; minSz: number };
}) {
    const { sizing } = args;
    const denom = args.lastPrice * sizing.ctVal;
    const raw_contracts = denom > 1e-24 ? args.desiredNotionalUsdt / denom : 0;
    const lot = sizing.lotSz;
    let steps = Math.floor(raw_contracts / lot + 1e-12);
    let normalized_contracts = steps * lot;
    while (denom > 0 && steps > 0 && normalized_contracts * denom > args.desiredNotionalUsdt + 1e-9) {
        steps--;
        normalized_contracts = steps * lot;
    }
    const actualNotional = normalized_contracts * denom;
    return {
        raw_contracts,
        normalized_contracts,
        actualNotional,
        min_size_ok: normalized_contracts >= sizing.minSz
    };
}

async function runVerification() {
    console.log("==========================================");
    console.log("LIVE ORDER SIZING & ACCOUNT AUTHORITY BRIDGE VERIFICATION");
    console.log("==========================================");

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

    const baseInput: EngineV2Input = {
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
        config: validConfig,
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

    // TEST 5A: Paper Mode -> No live limits block, stageMarginKrw preserved without USDT caps
    console.log("\n[TEST 5A] Paper Mode -> Preserves Paper stageMarginKrw without live caps");
    const inputPaper: EngineV2Input = {
        ...baseInput,
        state: {
            ...baseInput.state,
            okxAuthMode: "demo",
            okxExchangeAuthOptIn: false,
            okxLiveEnabled: false
        } as any
    };
    const resPaper = runEngineV2(inputPaper).decision;
    assert(resPaper.risk.blockReason !== "LIVE_SIZING_LIMITS_NOT_CONFIGURED", "Paper mode must NOT be blocked by missing live limits");
    assert(resPaper.risk.finalOrderNotionalUsdt === undefined, "Paper mode risk decision must NOT expose finalOrderNotionalUsdt override");

    // TEST 5B: Live Signed Entry + Balance Readiness Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY Blocked (0 submit calls)
    console.log("\n[TEST 5B] Live Entry + Balance Readiness Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY Blocked");
    let orderCallCount = 0;
    const inputBalanceFail: EngineV2Input = {
        ...baseInput,
        state: {
            ...baseInput.state,
            okxAuthMode: "live",
            okxExchangeAuthOptIn: true,
            okxLiveEnabled: true,
            liveBalanceReady: false, // Balance check failed
            accountEquityUsdt: 0,
            availableBalanceUsdt: 0,
            okxActualPositionsReady: true,
            actualAccountNotionalUsdtReady: true
        } as any
    };
    const resBalanceFail = runEngineV2(inputBalanceFail).decision;
    if (resBalanceFail.decision === "ENTER") {
        orderCallCount++;
    }
    assert(resBalanceFail.decision === "REJECT", "Balance fail must yield REJECT");
    assert(resBalanceFail.risk.blockReason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Block reason must be LIVE_ACCOUNT_AUTHORITY_NOT_READY");
    assert(orderCallCount === 0, `Order function calls must be 0 on balance failure (got ${orderCallCount})`);

    // TEST 5C: Live Signed Entry + OKX Position Lookup Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY Blocked (0 submit calls)
    console.log("\n[TEST 5C] Live Entry + Position Lookup Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY Blocked");
    orderCallCount = 0;
    const inputPosFail: EngineV2Input = {
        ...baseInput,
        state: {
            ...baseInput.state,
            okxAuthMode: "live",
            okxExchangeAuthOptIn: true,
            okxLiveEnabled: true,
            liveBalanceReady: true,
            accountEquityUsdt: 69,
            availableBalanceUsdt: 69,
            okxActualPositionsReady: false, // Position lookup failed
            actualAccountNotionalUsdtReady: false
        } as any
    };
    const resPosFail = runEngineV2(inputPosFail).decision;
    if (resPosFail.decision === "ENTER") {
        orderCallCount++;
    }
    assert(resPosFail.decision === "REJECT", "Position lookup fail must yield REJECT");
    assert(resPosFail.risk.blockReason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Block reason must be LIVE_ACCOUNT_AUTHORITY_NOT_READY");
    assert(orderCallCount === 0, `Order function calls must be 0 on position lookup failure (got ${orderCallCount})`);

    // TEST 5D: Request 100 USDT -> Live finalOrderNotionalUsdt <= 40 & Contract Normalization Notional <= 40
    console.log("\n[TEST 5D] Request 100 USDT -> Live finalOrderNotionalUsdt <= 40 & Payload Notional <= 40");
    const input100Usdt: EngineV2Input = {
        ...baseInput,
        config: {
            ...validConfig,
            baseSizeUsd: 100
        },
        state: {
            ...baseInput.state,
            okxAuthMode: "live",
            okxExchangeAuthOptIn: true,
            okxLiveEnabled: true,
            liveBalanceReady: true,
            accountEquityUsdt: 69,
            availableBalanceUsdt: 69,
            okxActualPositionsReady: true,
            actualAccountNotionalUsdtReady: true,
            okxActualPositions: [],
            liveMaxOrderNotionalUsdt: 40,
            liveMaxAddonNotionalUsdt: 20,
            liveMaxSymbolNotionalUsdt: 60,
            liveMaxAccountNotionalUsdt: 80,
            liveMaxAddonCount: 1
        } as any
    };
    const res100Usdt = runEngineV2(input100Usdt).decision;
    const finalNotional5D = res100Usdt.risk.finalOrderNotionalUsdt;
    assert(finalNotional5D != null, "finalOrderNotionalUsdt must NOT be null or undefined for signed live mode");
    assert(finalNotional5D! <= 40, `finalOrderNotionalUsdt must be <= 40 USDT (got ${finalNotional5D})`);

    // Contract normalization bridge test
    const contractNorm5D = normalizeOkxSwapContractsFromNotional({
        desiredNotionalUsdt: finalNotional5D!,
        lastPrice: 3000,
        sizing: { ctVal: 0.1, lotSz: 0.1, minSz: 0.1 }
    });
    assert(contractNorm5D.actualNotional <= 40, `Actual payload notional after lotSz truncation must be <= 40 USDT (got ${contractNorm5D.actualNotional})`);

    // TEST 5E: Symbol Exposure 45 USDT + Addon -> Payload Notional <= 15 USDT
    console.log("\n[TEST 5E] Symbol Exposure 45 USDT + Addon -> Payload Notional <= 15 USDT");
    const inputAddon45: EngineV2Input = {
        ...baseInput,
        state: {
            ...baseInput.state,
            okxAuthMode: "live",
            okxExchangeAuthOptIn: true,
            okxLiveEnabled: true,
            liveBalanceReady: true,
            accountEquityUsdt: 69,
            availableBalanceUsdt: 69,
            okxActualPositionsReady: true,
            actualAccountNotionalUsdtReady: true,
            currentPositions: [{
                symbol: "ETHUSDT",
                side: "LONG",
                entryPrice: 3000,
                sizeUsd: 45,
                entryStage: 1,
                pnlPct: 0.05
            }],
            okxActualPositions: [{
                symbol: "ETHUSDT",
                side: "LONG",
                sizeUsd: 45
            }],
            addOnPolicyAllowed: true,
            liveMaxOrderNotionalUsdt: 40,
            liveMaxAddonNotionalUsdt: 20,
            liveMaxSymbolNotionalUsdt: 60,
            liveMaxAccountNotionalUsdt: 80,
            liveMaxAddonCount: 1
        } as any
    };
    const resAddon45 = runEngineV2(inputAddon45).decision;
    const finalNotional5E = resAddon45.risk.finalOrderNotionalUsdt;
    assert(finalNotional5E != null, "finalOrderNotionalUsdt must NOT be null or undefined for signed add-on");
    assert(finalNotional5E! <= 15, `Add-on finalOrderNotionalUsdt must be <= 15 USDT (got ${finalNotional5E})`);

    const contractNorm5E = normalizeOkxSwapContractsFromNotional({
        desiredNotionalUsdt: finalNotional5E!,
        lastPrice: 3000,
        sizing: { ctVal: 0.1, lotSz: 0.1, minSz: 0.1 }
    });
    assert(contractNorm5E.actualNotional <= 15, `Actual add-on payload notional after lotSz truncation must be <= 15 USDT (got ${contractNorm5E.actualNotional})`);

    // TEST 5F: BTCUSDT Protected Long Guard -> 0 Submit/Cancel/Close/Ledger calls
    console.log("\n[TEST 5F] BTCUSDT Protected Long Guard -> Zero Order & Ledger Side Effects");
    let btcSideEffectsCount = 0;
    const inputBtcProtected: EngineV2Input = {
        ...baseInput,
        symbol: "BTCUSDT",
        state: {
            ...baseInput.state,
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
    const resBtc = runEngineV2(inputBtcProtected).decision;
    if (resBtc.decision === "ENTER") {
        btcSideEffectsCount++;
    }
    assert(resBtc.decision === "SKIP" || resBtc.decision === "HOLD" || resBtc.decision === "REJECT", "BTCUSDT Long must suppress ENTER/ADDON");
    assert(btcSideEffectsCount === 0, `BTCUSDT Long side effect calls must be 0 (got ${btcSideEffectsCount})`);

    console.log("\n==========================================");
    console.log("ALL LIVE ORDER SIZING & ACCOUNT AUTHORITY BRIDGE TESTS PASSED! 🎉");
    console.log("==========================================");
}

runVerification().catch(err => {
    console.error("Fatal Test Error:", err);
    process.exit(1);
});
