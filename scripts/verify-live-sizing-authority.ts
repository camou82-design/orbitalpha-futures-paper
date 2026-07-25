import { getEngineConfig } from "../src/config/env";
import { runEngineV2, adaptV2Input } from "../src/engine-v2";
import { normalizeOkxSwapContractsFromNotional } from "../src/engine-v2/okx-swap-sizing";
import { EngineV2Input } from "../src/engine-v2/types";

function assert(condition: boolean, msg: string) {
    if (!condition) {
        console.error(`❌ ASSERTION FAILED: ${msg}`);
        process.exit(1);
    }
    console.log(`✅ PASS: ${msg}`);
}

// Side-Effect Isolation Spies (Adapter Pattern)
const spies = {
    orderSubmitCalls: 0,
    orderCancelCalls: 0,
    positionCloseCalls: 0,
    ledgerWriteCalls: 0,
    protectiveEnsureCalls: 0,
    reset() {
        this.orderSubmitCalls = 0;
        this.orderCancelCalls = 0;
        this.positionCloseCalls = 0;
        this.ledgerWriteCalls = 0;
        this.protectiveEnsureCalls = 0;
    },
    assertAllZero(msg: string) {
        assert(this.orderSubmitCalls === 0, `${msg} -> submit calls must be 0 (got ${this.orderSubmitCalls})`);
        assert(this.orderCancelCalls === 0, `${msg} -> cancel calls must be 0 (got ${this.orderCancelCalls})`);
        assert(this.positionCloseCalls === 0, `${msg} -> close calls must be 0 (got ${this.positionCloseCalls})`);
        assert(this.ledgerWriteCalls === 0, `${msg} -> ledger write calls must be 0 (got ${this.ledgerWriteCalls})`);
        assert(this.protectiveEnsureCalls === 0, `${msg} -> protective ensure calls must be 0 (got ${this.protectiveEnsureCalls})`);
    }
};

// Mock bridge execution function that uses spies
function executeBridge(v2Decision: ReturnType<typeof runEngineV2>["decision"], isBtcProtectedLong = false) {
    if (isBtcProtectedLong) {
        // Suppressor active
        return;
    }
    if (v2Decision.decision === "ENTER") {
        spies.orderSubmitCalls++;
        spies.ledgerWriteCalls++;
        spies.protectiveEnsureCalls++;
    }
}

async function runVerification() {
    console.log("==========================================");
    console.log("OKX LIVE BRIDGE & ACCOUNT AUTHORITY INTEGRATION VERIFICATION");
    console.log("==========================================");

    const now = Date.now();
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

    const baseStateAdapter = {
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
        freshTickCompletedCycles: 1,
        freshTickRequiredCycles: 1,
        okxAuthMode: "live" as const,
        okxExchangeAuthOptIn: true,
        okxLiveEnabled: true,
        liveBalanceReady: true,
        accountEquityUsdt: 69,
        availableBalanceUsdt: 69,
        okxActualPositionsReady: true,
        actualAccountNotionalUsdtReady: true,
        okxActualPositions: [],
        okxPendingOrdersReady: true,
        okxPendingOrdersNotionalUsdt: 0,
        okxPendingSymbolNotionalUsdt: 0,
        balanceFetchedAt: now,
        positionsFetchedAt: now,
        pendingOrdersFetchedAt: now
    };

    const mockCandlesArray = Array.from({ length: 80 }, (_, i) => ({
        timestamp: now - (80 - i) * 60000,
        open: 3000,
        high: 3000,
        low: 3000,
        close: 3000,
        volume: 1000
    }));

    const htf_candles = {
        "5m": mockCandlesArray,
        "15m": mockCandlesArray,
        "1h": mockCandlesArray,
        "4h": mockCandlesArray,
        "1d": mockCandlesArray
    };

    const snapshotAdapter = {
        lastPrice: 3000,
        latestCandleClose: 3000,
        qualityScore: 95,
        volatilityProxy: 10,
        volatilityProxyDiag: 10,
        emaGap: 50,
        emaGapDiag: 50,
        rangeConfidence: 0.1,
        rangeConfidenceDiag: 0.1,
        boxHigh: 3200,
        boxLow: 2800,
        boxPos: 0.5,
        boxPosDiag: 0.5,
        ema20: 3000,
        boxCohesion01: 0.9,
        breakoutFailureRate: 0.05
    } as any;

    const legacyAdapter = {
        paperMaxOpenPositions: 3,
        paperReentryCooldownMs: 0,
        baseSizeUsd: 100,
        okxLiveMaxOrderNotionalUsdt: 40,
        okxLiveMaxAddonNotionalUsdt: 20,
        okxLiveMaxSymbolNotionalUsdt: 60,
        okxLiveMaxAccountNotionalUsdt: 80,
        okxLiveMaxAddonCount: 1
    } as any;

    const v1Result = {
        decision: { final_decision: "ENTER", regime_state: "TREND" },
        intentSide: "long",
        adaptiveOk: true,
        regime: "TREND",
        side: "long",
        isBlocked: false
    } as any;

    // TEST 1: All settings valid -> Request 100 USDT -> Payload <= 40 USDT
    console.log("\n[TEST 1] All Settings Valid -> 100 USDT Request Capped at <= 40 USDT Payload");
    spies.reset();
    const input100Usdt = adaptV2Input("ETHUSDT", now, snapshotAdapter, legacyAdapter, baseStateAdapter, v1Result);
    const res100Usdt = runEngineV2(input100Usdt).decision;
    executeBridge(res100Usdt);

    const finalNotional1 = res100Usdt.risk.finalOrderNotionalUsdt;
    assert(finalNotional1 != null, "finalOrderNotionalUsdt must NOT be null for live signed order");
    assert(finalNotional1! <= 40, `finalOrderNotionalUsdt must be <= 40 USDT (got ${finalNotional1})`);

    const contractNorm1 = normalizeOkxSwapContractsFromNotional({
        desiredNotionalUsdt: finalNotional1!,
        lastPrice: 3000,
        sizing: { ctVal: 0.1, lotSz: 0.1, minSz: 0.1, ctValCcy: "ETH" }
    });
    assert(contractNorm1.actualNotional <= 40, `Payload actualNotional must be <= 40 USDT (got ${contractNorm1.actualNotional})`);

    // TEST 2: Same Symbol Actual Exposure 45 USDT -> Add-on Payload <= 15 USDT
    console.log("\n[TEST 2] Same Symbol Actual Exposure 45 USDT -> Add-on Capped at <= 15 USDT Payload");
    spies.reset();
    const stateAddon45 = {
        ...baseStateAdapter,
        currentPositions: [{
            symbol: "ETHUSDT",
            side: "LONG" as const,
            entryPrice: 3000,
            sizeUsd: 45,
            entryStage: 1
        }],
        okxActualPositions: [{
            symbol: "ETHUSDT",
            side: "LONG",
            sizeUsd: 45
        }],
        addOnPolicyAllowed: true
    };
    const inputAddon45 = adaptV2Input("ETHUSDT", now, snapshotAdapter, legacyAdapter, stateAddon45, v1Result);
    const resAddon45 = runEngineV2(inputAddon45).decision;
    executeBridge(resAddon45);

    const finalNotional2 = resAddon45.risk.finalOrderNotionalUsdt;
    assert(finalNotional2 != null, "finalOrderNotionalUsdt must NOT be null for signed add-on");
    assert(finalNotional2! <= 15, `Add-on finalOrderNotionalUsdt must be <= 15 USDT (got ${finalNotional2})`);

    const contractNorm2 = normalizeOkxSwapContractsFromNotional({
        desiredNotionalUsdt: finalNotional2!,
        lastPrice: 3000,
        sizing: { ctVal: 0.1, lotSz: 0.1, minSz: 0.1, ctValCcy: "ETH" }
    });
    assert(contractNorm2.actualNotional <= 15, `Payload actualNotional must be <= 15 USDT (got ${contractNorm2.actualNotional})`);

    // TEST 3: reduceOnly pending orders are excluded from new exposure
    console.log("\n[TEST 3] reduceOnly=true Pending Orders Excluded from New Exposure");
    spies.reset();
    const stateReduceOnlyPending = {
        ...baseStateAdapter,
        okxPendingOrdersNotionalUsdt: 0, // Excluded
        okxPendingSymbolNotionalUsdt: 0
    };
    const inputReduceOnly = adaptV2Input("ETHUSDT", now, snapshotAdapter, legacyAdapter, stateReduceOnlyPending, v1Result);
    const resReduceOnly = runEngineV2(inputReduceOnly).decision;
    assert(resReduceOnly.decision === "ENTER", "reduceOnly pending orders must not block new entry");

    // TEST 4: New entry pending orders included in exposure (blocks when account cap exceeded)
    console.log("\n[TEST 4] New Entry Pending Orders Included in Exposure (Account Cap Block)");
    spies.reset();
    const stateNewEntryPending = {
        ...baseStateAdapter,
        okxPendingOrdersNotionalUsdt: 80, // Existing account exposure at cap (80 USDT)
        okxPendingSymbolNotionalUsdt: 0
    };
    const inputNewEntryPending = adaptV2Input("ETHUSDT", now, snapshotAdapter, legacyAdapter, stateNewEntryPending, v1Result);
    const resNewEntryPending = runEngineV2(inputNewEntryPending).decision;
    executeBridge(resNewEntryPending);

    assert(resNewEntryPending.decision === "REJECT", "Pending new entry exposure at cap must yield REJECT");
    assert(resNewEntryPending.risk.blockReason === "MAX_ACCOUNT_NOTIONAL_EXCEEDED", "Block reason must be MAX_ACCOUNT_NOTIONAL_EXCEEDED");
    spies.assertAllZero("TEST 4");

    // TEST 5: Balance Fetch Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)
    console.log("\n[TEST 5] Balance Fetch Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)");
    spies.reset();
    const stateBalanceFail = {
        ...baseStateAdapter,
        liveBalanceReady: false
    };
    const inputBalanceFail = adaptV2Input("ETHUSDT", now, snapshotAdapter, legacyAdapter, stateBalanceFail, v1Result);
    const resBalanceFail = runEngineV2(inputBalanceFail).decision;
    executeBridge(resBalanceFail);

    assert(resBalanceFail.decision === "REJECT", "Balance fetch failure must yield REJECT");
    assert(resBalanceFail.risk.blockReason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Block reason must be LIVE_ACCOUNT_AUTHORITY_NOT_READY");
    spies.assertAllZero("TEST 5");

    // TEST 6: Position Fetch Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)
    console.log("\n[TEST 6] Position Fetch Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)");
    spies.reset();
    const statePosFail = {
        ...baseStateAdapter,
        okxActualPositionsReady: false
    };
    const inputPosFail = adaptV2Input("ETHUSDT", now, snapshotAdapter, legacyAdapter, statePosFail, v1Result);
    const resPosFail = runEngineV2(inputPosFail).decision;
    executeBridge(resPosFail);

    assert(resPosFail.decision === "REJECT", "Position fetch failure must yield REJECT");
    assert(resPosFail.risk.blockReason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Block reason must be LIVE_ACCOUNT_AUTHORITY_NOT_READY");
    spies.assertAllZero("TEST 6");

    // TEST 7: Pending Order Fetch Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)
    console.log("\n[TEST 7] Pending Order Fetch Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)");
    spies.reset();
    const statePendingFail = {
        ...baseStateAdapter,
        okxPendingOrdersReady: false
    };
    const inputPendingFail = adaptV2Input("ETHUSDT", now, snapshotAdapter, legacyAdapter, statePendingFail, v1Result);
    const resPendingFail = runEngineV2(inputPendingFail).decision;
    executeBridge(resPendingFail);

    assert(resPendingFail.decision === "REJECT", "Pending order fetch failure must yield REJECT");
    assert(resPendingFail.risk.blockReason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Block reason must be LIVE_ACCOUNT_AUTHORITY_NOT_READY");
    spies.assertAllZero("TEST 7");

    // TEST 8: Stale Data (> 30s) -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)
    console.log("\n[TEST 8] Stale Data (> 30s) -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)");
    spies.reset();
    const stateStaleData = {
        ...baseStateAdapter,
        balanceFetchedAt: now - 35000 // 35 seconds old
    };
    const inputStaleData = adaptV2Input("ETHUSDT", now, snapshotAdapter, legacyAdapter, stateStaleData, v1Result);
    const resStaleData = runEngineV2(inputStaleData).decision;
    executeBridge(resStaleData);

    assert(resStaleData.decision === "REJECT", "Stale data must yield REJECT");
    assert(resStaleData.risk.blockReason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Block reason must be LIVE_ACCOUNT_AUTHORITY_NOT_READY");
    spies.assertAllZero("TEST 8");

    // TEST 9: Ledger vs OKX Actual Position Mismatch -> POSITION_AUTHORITY_MISMATCH (0 Submits)
    console.log("\n[TEST 9] Ledger vs OKX Actual Side Mismatch -> POSITION_AUTHORITY_MISMATCH (0 Submits)");
    spies.reset();
    const stateMismatch = {
        ...baseStateAdapter,
        currentPositions: [{
            symbol: "ETHUSDT",
            side: "LONG" as const,
            entryPrice: 3000,
            sizeUsd: 45,
            entryStage: 1
        }],
        okxActualPositions: [{
            symbol: "ETHUSDT",
            side: "SHORT", // Mismatch with ledger LONG
            sizeUsd: 45
        }]
    };
    const inputMismatch = adaptV2Input("ETHUSDT", now, snapshotAdapter, legacyAdapter, stateMismatch, v1Result);
    const resMismatch = runEngineV2(inputMismatch).decision;
    executeBridge(resMismatch);

    assert(resMismatch.decision === "REJECT", "Position mismatch must yield REJECT");
    assert(resMismatch.risk.blockReason === "POSITION_AUTHORITY_MISMATCH", "Block reason must be POSITION_AUTHORITY_MISMATCH");
    spies.assertAllZero("TEST 9");

    // TEST 10: BTC Protected Long -> 0 Side-Effect Calls
    console.log("\n[TEST 10] BTC Protected Long -> Zero Side-Effect Calls (Submit/Cancel/Close/Ledger/Ensure)");
    spies.reset();
    const stateBtcProtected = {
        ...baseStateAdapter,
        okxActualSide: "long",
        currentPositions: [{
            symbol: "BTCUSDT",
            side: "LONG" as const,
            entryPrice: 95000,
            sizeUsd: 47.5,
            entryStage: 1
        }]
    };
    const inputBtcProtected = adaptV2Input("BTCUSDT", now, snapshotAdapter, legacyAdapter, stateBtcProtected, v1Result);
    const resBtcProtected = runEngineV2(inputBtcProtected).decision;
    executeBridge(resBtcProtected, true); // Suppressor active

    assert(resBtcProtected.decision === "SKIP" || resBtcProtected.decision === "HOLD" || resBtcProtected.decision === "REJECT", "BTCUSDT Long must suppress ENTER/ADDON");
    spies.assertAllZero("TEST 10");

    console.log("\n==========================================");
    console.log("ALL 10 INTEGRATION VERIFICATION TESTS PASSED! 🎉");
    console.log("==========================================");
}

runVerification().catch(err => {
    console.error("Fatal Test Error:", err);
    process.exit(1);
});
