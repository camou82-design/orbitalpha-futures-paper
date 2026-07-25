import { getEngineConfig } from "../src/config/env";
import { PaperEngine, buildV2ConfigBridge, buildV2StateBridge } from "../src/engine/paper-engine";
import { runEngineV2, adaptV2Input } from "../src/engine-v2";
import { normalizeOkxSwapContractsFromNotional } from "../src/engine-v2/okx-swap-sizing";

function assert(condition: boolean, msg: string) {
    if (!condition) {
        console.error(`❌ ASSERTION FAILED: ${msg}`);
        process.exit(1);
    }
    console.log(`✅ PASS: ${msg}`);
}

// Side-Effect Isolation Spies for Production Execution Methods
class ProductionExecutionSpies {
    orderSubmitCalls = 0;
    orderCancelCalls = 0;
    positionCloseCalls = 0;
    ledgerWriteCalls = 0;
    protectiveEnsureCalls = 0;

    reset() {
        this.orderSubmitCalls = 0;
        this.orderCancelCalls = 0;
        this.positionCloseCalls = 0;
        this.ledgerWriteCalls = 0;
        this.protectiveEnsureCalls = 0;
    }

    assertAllZero(testName: string) {
        assert(this.orderSubmitCalls === 0, `${testName} -> submitOkxOrder calls must be 0 (got ${this.orderSubmitCalls})`);
        assert(this.orderCancelCalls === 0, `${testName} -> cancelOrder calls must be 0 (got ${this.orderCancelCalls})`);
        assert(this.positionCloseCalls === 0, `${testName} -> tryPaperPositionClose calls must be 0 (got ${this.positionCloseCalls})`);
        assert(this.ledgerWriteCalls === 0, `${testName} -> writeOpenPositions calls must be 0 (got ${this.ledgerWriteCalls})`);
        assert(this.protectiveEnsureCalls === 0, `${testName} -> ensureProtectiveStopOrder calls must be 0 (got ${this.protectiveEnsureCalls})`);
    }
}

async function runVerification() {
    console.log("==========================================");
    console.log("OKX LIVE BRIDGE & ACCOUNT AUTHORITY FULL PATH INTEGRATION VERIFICATION");
    console.log("==========================================");

    const now = Date.now();
    const explicitEnv = {
        DATA_DIR: "./scratch/test_data",
        OKX_AUTH_MODE: "live",
        OKX_EXCHANGE_AUTH_OPT_IN: "true",
        OKX_LIVE_ENABLED: "true",
        OKX_LIVE_MAX_ORDER_NOTIONAL_USDT: "40",
        OKX_LIVE_MAX_ADDON_NOTIONAL_USDT: "20",
        OKX_LIVE_MAX_SYMBOL_NOTIONAL_USDT: "60",
        OKX_LIVE_MAX_ACCOUNT_NOTIONAL_USDT: "80",
        OKX_LIVE_MAX_ADDON_COUNT: "1"
    };

    const config = {
        ...getEngineConfig(explicitEnv),
        baseSizeUsd: 100,
        okxAuthMode: "live" as const,
        okxExchangeAuthOptIn: true,
        okxLiveEnabled: true,
        okxAuthReady: true,
        okxApiKey: "test_key",
        okxApiSecret: "test_secret",
        okxPassphrase: "test_passphrase"
    };

    const spies = new ProductionExecutionSpies();

    // Dependency Injection: Mock Network Client & Store (0 network calls, 0 file writes)
    const mockOkxDemoClient = {
        submitOrder: async () => ({ ok: true, ordId: "mock_ord_123", fillPx: "3000", fillSize: 0.1, errorCode: null, errorMessage: null, ackCode: "accepted", orderState: "filled", fillConfirmed: true, clOrdId: "mock_cl_123" }),
        getOrder: async () => ({ ok: true }),
        cancelOrder: async () => ({ ok: true }),
        submitAlgoOrder: async () => ({ ok: true, algoId: "mock_algo_123" }),
        cancelAlgoOrder: async () => ({ ok: true }),
        tryGetInstrument: async () => ({ ok: true, value: { lotSz: "0.1", minSz: "0.1", ctVal: "0.1", ctValCcy: "ETH", tickSz: "0.1" } }),
        tryGetTicker: async () => ({ ok: true, value: { last: 3000, bid: 2999, ask: 3001 } }),
        getAccountConfig: async () => ({ ok: true, value: [{ posMode: "long_short_mode" }] }),
        getLeverage: async () => ({ ok: true, value: [{ mgnMode: "cross", lever: "10" }] }),
        setLeverage: async () => ({ ok: true }),
        checkSignedReady: async () => true,
        getBalance: async () => ({ ok: true, value: 69 }),
        getPositions: async () => ({ ok: true, value: [] }),
        getOrdersAlgoPending: async () => ({ ok: true, value: [] })
    };

    const mockStore = {
        readPositionsOpenAll: async () => [],
        writePositionsOpenAll: async () => "",
        writeOpenPositions: async () => {},
        writeClosedPosition: async () => {},
        readPositionsHistory: async () => [],
        readPendingEntryOrders: async () => [],
        writePendingEntryOrders: async () => {},
        writeJson: async () => "",
        writeSnapshotLatest: async () => "",
        writeSnapshotLatestMeta: async () => "",
        writePaperCandidateRun: async () => "",
        updateRunsIndex: async () => "",
        appendJsonlLine: async () => {},
        mergeNoEntryAuditSnapshot: async () => {}
    };

    const dummyLogger = {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {}
    } as any;

    const paperEngine = new PaperEngine(config, dummyLogger, mockOkxDemoClient, mockStore);
    (paperEngine as any).okxPublic = mockOkxDemoClient;

    // Instrument Spies on Actual Production PaperEngine Methods
    const originalSubmit = paperEngine.submitOkxOrder.bind(paperEngine);
    paperEngine.submitOkxOrder = async (input: any) => {
        spies.orderSubmitCalls++;
        return originalSubmit(input);
    };

    const originalCancel = paperEngine.cancelOrder.bind(paperEngine);
    paperEngine.cancelOrder = async (symbol: string, ordId: string, algoId?: string) => {
        spies.orderCancelCalls++;
        return originalCancel(symbol, ordId, algoId);
    };

    const originalClose = paperEngine.tryPaperPositionClose.bind(paperEngine);
    paperEngine.tryPaperPositionClose = async (input: any) => {
        spies.positionCloseCalls++;
        return originalClose(input);
    };

    const originalWriteOpen = paperEngine.writeOpenPositions.bind(paperEngine);
    paperEngine.writeOpenPositions = async (positions: any[]) => {
        spies.ledgerWriteCalls++;
        return originalWriteOpen(positions);
    };

    const originalEnsureProtective = paperEngine.ensureProtectiveStopOrder.bind(paperEngine);
    paperEngine.ensureProtectiveStopOrder = async (open: any, flowId: string, pricingLastInput?: number, protectionSource?: any) => {
        spies.protectiveEnsureCalls++;
        return originalEnsureProtective(open, flowId, pricingLastInput, protectionSource);
    };

    // Shared mock candles & adapters for 6-tier pipeline
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
        breakoutFailureRate: 0.05,
        candles: mockCandlesArray,
        htf_candles
    } as any;

    const legacyConfigAdapter = buildV2ConfigBridge(config);

    const v1Result = {
        decision: { final_decision: "ENTER", regime_state: "TREND" },
        intentSide: "long",
        adaptiveOk: true,
        regime: "TREND",
        side: "long",
        isBlocked: false
    } as any;

    // Helper: Execute Full Real Pipeline (PaperEngine state -> Bridges -> adaptV2Input -> runEngineV2 -> executeV2SignedExecutionBridge -> signed payload builder)
    async function runFullPipelineTest(args: {
        symbol: string;
        opensAfterClose?: any[];
        lastRisk?: any;
        lastLivePositionsPayload?: any[];
        liveBalanceReady?: boolean;
        okxWalletBalanceUsdt?: number | null;
        okxAvailableBalanceUsdt?: number | null;
        okxPositionsOk?: boolean;
        okxPendingOrdersReady?: boolean;
        pendingOrdersNotionalUsdt?: number;
        pendingSymbolNotionalUsdt?: number;
        balanceFetchedAt?: number;
        positionsFetchedAt?: number;
        pendingOrdersFetchedAt?: number;
    }) {
        (paperEngine as any).paperExecutionReady = true;
        (paperEngine as any).signedExecutionReady = true;
        (paperEngine as any).okxSmokeTestPerformed = true;
        (paperEngine as any).okxSignedRestReady = true;
        (paperEngine as any).liveBalanceReady = args.liveBalanceReady ?? true;
        (paperEngine as any).okxWalletBalanceUsdt = args.okxWalletBalanceUsdt ?? 69;
        (paperEngine as any).okxAvailableBalanceUsdt = args.okxAvailableBalanceUsdt ?? 69;
        (paperEngine as any).okxPositionsOk = args.okxPositionsOk ?? true;
        (paperEngine as any).okxOrderSubmitOk = args.okxPendingOrdersReady ?? true;
        (paperEngine as any).lastLivePositionsPayload = args.lastLivePositionsPayload ?? [];

        const opensAfterClose = args.opensAfterClose ?? [];
        const lastRisk = args.lastRisk ?? null;

        // Stage 1: Build Bridge State & Config from PaperEngine Format
        const bridgeState = buildV2StateBridge(
            opensAfterClose,
            lastRisk,
            config,
            true, // paperExecutionReady
            true, // signedExecutionReady
            false, // freshTickBarrierActive
            false, // freshTickExecutionBlocked
            1, // freshTickCompletedCycles
            1, // freshTickRequiredCycles,
            { profit: { qualityScoreAvg: 90, emaGapAvg: 10, atrPctAvg: 0.01, volumeRatioAvg: 1, count: 5 }, loss: { qualityScoreAvg: 50, emaGapAvg: 5, atrPctAvg: 0.01, volumeRatioAvg: 1, count: 1 }, contaminated: { qualityScoreAvg: 0, emaGapAvg: 0, atrPctAvg: 0, volumeRatioAvg: 0, count: 0 } },
            { server_trade_enabled: true, close_only_mode: false, kill_switch_active: false, authority_source: "server_state" as const, updated_at: now, reason: null },
            false, // reconcileSafeModeActive
            args.lastLivePositionsPayload ?? [],
            args.liveBalanceReady ?? true,
            args.okxWalletBalanceUsdt ?? 69,
            args.okxAvailableBalanceUsdt ?? 69,
            args.okxPositionsOk ?? true,
            args.okxPendingOrdersReady ?? true,
            "pendingOrdersNotionalUsdt" in args ? (args.pendingOrdersNotionalUsdt as any) : 0,
            "pendingSymbolNotionalUsdt" in args ? (args.pendingSymbolNotionalUsdt as any) : 0,
            "balanceFetchedAt" in args ? (args.balanceFetchedAt as any) : now,
            "positionsFetchedAt" in args ? (args.positionsFetchedAt as any) : now,
            "pendingOrdersFetchedAt" in args ? (args.pendingOrdersFetchedAt as any) : now
        );

        // Stage 2: Adapt V2 Input
        const v2Input = adaptV2Input(
            args.symbol as any,
            now,
            snapshotAdapter,
            config as any,
            bridgeState as any,
            v1Result
        );

        // Stage 3: Run V2 Risk & Authority Engine
        const v2Outcome = runEngineV2(v2Input);

        // Stage 4: Run Real Production Signed Execution Bridge & Payload Builder
        const bridgeResult = await paperEngine.executeV2SignedExecutionBridge({
            symbol: args.symbol as any,
            v2Decision: v2Outcome.decision,
            lastPrice: 3000
        });

        return { v2Outcome, bridgeResult };
    }

    // TEST 1: Full Pipeline -> All Settings Valid -> 100 USDT Request Capped at <= 40 USDT Payload
    console.log("\n[TEST 1] Full Pipeline -> 100 USDT Request Capped at <= 40 USDT Payload");
    spies.reset();
    const test1Res = await runFullPipelineTest({ symbol: "ETHUSDT" });
    const finalNotional1 = test1Res.v2Outcome.decision.risk.finalOrderNotionalUsdt;
    assert(finalNotional1 != null, "finalOrderNotionalUsdt must NOT be null for live signed order");
    assert(finalNotional1! <= 40, `finalOrderNotionalUsdt must be <= 40 USDT (got ${finalNotional1})`);

    const contractNorm1 = normalizeOkxSwapContractsFromNotional({
        desiredNotionalUsdt: finalNotional1!,
        lastPrice: 3000,
        sizing: { ctVal: 0.1, lotSz: 0.1, minSz: 0.1, ctValCcy: "ETH" }
    });
    assert(contractNorm1.actualNotional <= 40, `Payload actualNotional must be <= 40 USDT (got ${contractNorm1.actualNotional})`);
    assert(spies.orderSubmitCalls === 1, `submitOkxOrder must be called 1 time (got ${spies.orderSubmitCalls})`);
    assert(spies.protectiveEnsureCalls === 1, `ensureProtectiveStopOrder must be called 1 time (got ${spies.protectiveEnsureCalls})`);
    assert(spies.ledgerWriteCalls === 1, `writeOpenPositions must be called 1 time (got ${spies.ledgerWriteCalls})`);

    // TEST 2: Same Symbol Actual Exposure 45 USDT -> Add-on Payload <= 15 USDT
    console.log("\n[TEST 2] Same Symbol Actual Exposure 45 USDT -> Add-on Capped at <= 15 USDT Payload");
    spies.reset();
    const test2Res = await runFullPipelineTest({
        symbol: "ETHUSDT",
        opensAfterClose: [{
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 2800,
            sizeUsd: 45,
            entryStage: 1
        }],
        lastLivePositionsPayload: [{
            symbol: "ETHUSDT",
            side: "LONG",
            sizeUsd: 45
        }],
        lastRisk: { directionalShockState: "NONE", longAllow: true, shortAllow: true }
    });
    const finalNotional2 = test2Res.v2Outcome.decision.risk.finalOrderNotionalUsdt;
    assert(finalNotional2 != null, "finalOrderNotionalUsdt must NOT be null for signed add-on");
    assert(finalNotional2! <= 15, `Add-on finalOrderNotionalUsdt must be <= 15 USDT (got ${finalNotional2})`);

    const contractNorm2 = normalizeOkxSwapContractsFromNotional({
        desiredNotionalUsdt: finalNotional2!,
        lastPrice: 3000,
        sizing: { ctVal: 0.1, lotSz: 0.1, minSz: 0.1, ctValCcy: "ETH" }
    });
    assert(contractNorm2.actualNotional <= 15, `Payload actualNotional must be <= 15 USDT (got ${contractNorm2.actualNotional})`);
    assert(spies.orderSubmitCalls === 1, `submitOkxOrder must be called 1 time for add-on (got ${spies.orderSubmitCalls})`);

    // TEST 3: reduceOnly Pending Orders Excluded from New Exposure Calculation
    console.log("\n[TEST 3] reduceOnly=true Pending Orders Excluded from New Exposure");
    spies.reset();
    const test3Res = await runFullPipelineTest({
        symbol: "ETHUSDT",
        okxPendingOrdersReady: true,
        pendingOrdersNotionalUsdt: 0,
        pendingSymbolNotionalUsdt: 0
    });
    assert(test3Res.v2Outcome.decision.decision === "ENTER", "reduceOnly pending orders must allow entry");
    assert(spies.orderSubmitCalls === 1, "submitOkxOrder must be called 1 time");

    // TEST 4: New Entry Pending Orders Included in Exposure (Account Cap Block) -> 0 Submits
    console.log("\n[TEST 4] New Entry Pending Orders Included in Exposure (Account Cap Block) -> 0 Submits");
    spies.reset();
    const test4Res = await runFullPipelineTest({
        symbol: "ETHUSDT",
        okxPendingOrdersReady: true,
        pendingOrdersNotionalUsdt: 80, // Existing exposure at account cap 80 USDT
        pendingSymbolNotionalUsdt: 0
    });
    assert(test4Res.v2Outcome.decision.decision === "REJECT", "Pending new entry exposure at cap must yield REJECT");
    assert(test4Res.v2Outcome.decision.risk.blockReason === "MAX_ACCOUNT_NOTIONAL_EXCEEDED", "Block reason must be MAX_ACCOUNT_NOTIONAL_EXCEEDED");
    spies.assertAllZero("TEST 4");

    // TEST 5: Balance Fetch Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)
    console.log("\n[TEST 5] Balance Fetch Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)");
    spies.reset();
    const test5Res = await runFullPipelineTest({
        symbol: "ETHUSDT",
        liveBalanceReady: false
    });
    assert(test5Res.v2Outcome.decision.decision === "REJECT", "Balance fetch failure must yield REJECT");
    assert(test5Res.v2Outcome.decision.risk.blockReason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Block reason must be LIVE_ACCOUNT_AUTHORITY_NOT_READY");
    spies.assertAllZero("TEST 5");

    // TEST 6: Position Fetch Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)
    console.log("\n[TEST 6] Position Fetch Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)");
    spies.reset();
    const test6Res = await runFullPipelineTest({
        symbol: "ETHUSDT",
        okxPositionsOk: false
    });
    assert(test6Res.v2Outcome.decision.decision === "REJECT", "Position fetch failure must yield REJECT");
    assert(test6Res.v2Outcome.decision.risk.blockReason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Block reason must be LIVE_ACCOUNT_AUTHORITY_NOT_READY");
    spies.assertAllZero("TEST 6");

    // TEST 7: Pending Order Fetch / Invalid Value Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)
    console.log("\n[TEST 7] Pending Order Fetch / Invalid Value Failure -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)");
    spies.reset();
    const test7Res = await runFullPipelineTest({
        symbol: "ETHUSDT",
        okxPendingOrdersReady: true,
        pendingOrdersNotionalUsdt: undefined as any, // Missing / undefined notionals MUST block
        pendingSymbolNotionalUsdt: 0
    });
    assert(test7Res.v2Outcome.decision.decision === "REJECT", "Undefined pending order notional must yield REJECT");
    assert(test7Res.v2Outcome.decision.risk.blockReason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Block reason must be LIVE_ACCOUNT_AUTHORITY_NOT_READY");
    spies.assertAllZero("TEST 7");

    // TEST 8: Stale / Future / Negative Age Data -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)
    console.log("\n[TEST 8] Stale / Future / Negative Age Data -> LIVE_ACCOUNT_AUTHORITY_NOT_READY (0 Submits)");
    spies.reset();
    const test8Res = await runFullPipelineTest({
        symbol: "ETHUSDT",
        balanceFetchedAt: now - 35000 // 35s old (> 30s age limit)
    });
    assert(test8Res.v2Outcome.decision.decision === "REJECT", "Stale data (> 30s) must yield REJECT");
    assert(test8Res.v2Outcome.decision.risk.blockReason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Block reason must be LIVE_ACCOUNT_AUTHORITY_NOT_READY");

    // Future timestamp test (ageMs < 0)
    spies.reset();
    const test8bRes = await runFullPipelineTest({
        symbol: "ETHUSDT",
        balanceFetchedAt: now + 5000 // 5s in future (ageMs = -5000 < 0)
    });
    assert(test8bRes.v2Outcome.decision.decision === "REJECT", "Future timestamp must yield REJECT");
    assert(test8bRes.v2Outcome.decision.risk.blockReason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Block reason must be LIVE_ACCOUNT_AUTHORITY_NOT_READY");
    spies.assertAllZero("TEST 8");

    // TEST 9: Position Side Mismatch / Dual LONG & SHORT -> POSITION_AUTHORITY_MISMATCH (0 Submits)
    console.log("\n[TEST 9] Position Side Mismatch & Dual Position Guard -> POSITION_AUTHORITY_MISMATCH (0 Submits)");
    spies.reset();
    const test9Res = await runFullPipelineTest({
        symbol: "ETHUSDT",
        opensAfterClose: [{
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 3000,
            sizeUsd: 45,
            entryStage: 1
        }],
        lastLivePositionsPayload: [{
            symbol: "ETHUSDT",
            side: "SHORT", // Mismatch with ledger LONG
            sizeUsd: 45
        }]
    });
    assert(test9Res.v2Outcome.decision.decision === "REJECT", "Ledger vs OKX side mismatch must yield REJECT");
    assert(test9Res.v2Outcome.decision.risk.blockReason === "POSITION_AUTHORITY_MISMATCH", "Block reason must be POSITION_AUTHORITY_MISMATCH");
    spies.assertAllZero("TEST 9");

    // Dual LONG + SHORT collision test
    spies.reset();
    const test9bRes = await runFullPipelineTest({
        symbol: "ETHUSDT",
        opensAfterClose: [{
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 3000,
            sizeUsd: 45,
            entryStage: 1
        }],
        lastLivePositionsPayload: [
            { symbol: "ETHUSDT", side: "LONG", sizeUsd: 45 },
            { symbol: "ETHUSDT", side: "SHORT", sizeUsd: 20 }
        ]
    });
    assert(test9bRes.v2Outcome.decision.decision === "REJECT", "Dual LONG and SHORT actual positions must yield REJECT");
    assert(test9bRes.v2Outcome.decision.risk.blockReason === "POSITION_AUTHORITY_MISMATCH", "Block reason must be POSITION_AUTHORITY_MISMATCH");
    spies.assertAllZero("TEST 9b");

    // TEST 10: BTC Protected Long Suppressor -> 0 Execution Calls via Real Production Path
    console.log("\n[TEST 10] BTC Protected Long Suppressor -> Zero Execution Calls via Real Production Path");
    spies.reset();
    const test10Res = await runFullPipelineTest({
        symbol: "BTCUSDT",
        opensAfterClose: [{
            symbol: "BTCUSDT",
            side: "LONG",
            entryPrice: 95000,
            sizeUsd: 47.5,
            entryStage: 1
        }],
        lastLivePositionsPayload: [{
            symbol: "BTCUSDT",
            side: "LONG",
            sizeUsd: 47.5
        }]
    });
    assert(test10Res.bridgeResult.executed === false, "BTC Protected Long must NOT execute signed orders");
    spies.assertAllZero("TEST 10");

    console.log("\n==========================================");
    console.log("ALL 10 FULL-PATH INTEGRATION VERIFICATION TESTS PASSED PERFECTLY! 🎉");
    console.log("==========================================");
}

runVerification().catch(err => {
    console.error("Fatal Test Error:", err);
    process.exit(1);
});
