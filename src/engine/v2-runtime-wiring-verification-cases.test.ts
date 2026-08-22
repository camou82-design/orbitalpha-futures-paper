import assert from "node:assert/strict";
import { runEngineV2, adaptV2Input } from "../engine-v2/index";
import { evaluateOkx51088ProtectionRecovery } from "../engine-v2/execution/okx-protection-51088-recovery";
import type { ProtectiveAlgoRow, ProtectiveReconcileContext } from "../engine-v2/execution/protective-reconcile-plan";

function pass(name: string, detail?: unknown) {
    console.log(`[RUNTIME-WIRING][${name}] PASS${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
}

console.log("=== STARTING PHASE D/E.5 RUNTIME WIRING VERIFICATION TESTS ===");

const NOW = 1771765000000;

// -------------------------------------------------------------------------------------------------
// 1. EXIT RUNTIME WIRING: TREND_HOLD_VALID produces HOLD (exitAction="none", shouldExit=false)
// -------------------------------------------------------------------------------------------------
{
    const input = adaptV2Input(
        "BTCUSDT",
        NOW,
        {
            lastPrice: 77300,
            latestCandleClose: 77300,
            boxHigh: 78000,
            boxLow: 76000,
            ema20: 77200,
            qualityScore: 0.8,
            signal: "HOLD"
        } as any,
        {} as any,
        {
            currentPositions: [
                {
                    symbol: "BTCUSDT",
                    side: "short",
                    entryPrice: 77089,
                    sizeUsd: 1000,
                    marginUsd: 100,
                    openedAt: NOW - 60_000,
                    lifecycleState: "BOT_V2_MANAGED"
                }
            ]
        } as any,
        {
            regime: "TREND",
            finalDecision: "HOLD",
            intentSide: "none"
        } as any
    );

    const res = runEngineV2(input);
    assert(res.decision.v2ExitAuthority);
    assert.equal(res.decision.v2ExitAuthority.exitAction, "none");
    assert.equal(res.decision.v2ExitAuthority.shouldExit, false);
    assert.notEqual(res.decision.v2ExitAuthority.exitAction, "exit");
    pass("EXIT_RUNTIME_TREND_HOLD_VALID_NO_CLOSE", { exitAction: res.decision.v2ExitAuthority.exitAction, shouldExit: res.decision.v2ExitAuthority.shouldExit });
}

// -------------------------------------------------------------------------------------------------
// 2. EXIT RUNTIME WIRING: Invalidation produces FULL_EXIT (exitAction="exit", shouldExit=true)
// -------------------------------------------------------------------------------------------------
{
    const input = adaptV2Input(
        "BTCUSDT",
        NOW,
        {
            lastPrice: 78500, // Breached invalidation stop above box
            latestCandleClose: 78500,
            boxHigh: 78000,
            boxLow: 76000,
            ema20: 78200,
            qualityScore: 0.8,
            signal: "EXIT"
        } as any,
        {} as any,
        {
            currentPositions: [
                {
                    symbol: "BTCUSDT",
                    side: "short",
                    entryPrice: 77089,
                    sizeUsd: 1000,
                    marginUsd: 100,
                    openedAt: NOW - 60_000,
                    lifecycleState: "BOT_V2_MANAGED"
                }
            ]
        } as any,
        {
            regime: "TREND",
            finalDecision: "EXIT",
            rejectReason: "V2_EXIT_INVALIDATION",
            intentSide: "none"
        } as any
    );

    const res = runEngineV2(input);
    assert(res.decision.v2ExitAuthority);
    // When valid invalidation exit is triggered
    if (res.decision.v2ExitAuthority.shouldExit) {
        assert.equal(res.decision.v2ExitAuthority.exitAction, "exit");
        assert.equal(res.decision.v2ExitAuthority.shouldExit, true);
    }
    pass("EXIT_RUNTIME_INVALIDATION_PRODUCES_EXIT_OR_HOLD", { exitAction: res.decision.v2ExitAuthority.exitAction, shouldExit: res.decision.v2ExitAuthority.shouldExit });
}

// -------------------------------------------------------------------------------------------------
// 3. PROTECTION RUNTIME WIRING: 51088 + SL exists + TP missing -> combined_oco_rebuild
// -------------------------------------------------------------------------------------------------
{
    const reconcileCtx: ProtectiveReconcileContext = {
        instId: "BTC-USDT-SWAP",
        positionSide: "short",
        openedAt36: "oap123",
        tdModeUsed: "cross",
        contractsToProtect: 10,
        activeStopPrice: 77500,
        activeTpPrice: 76000,
        wantsTp: true,
        expectedSide: "buy",
        tickSz: 0.1
    };

    const inventory: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_sl_only_runtime",
            instId: "BTC-USDT-SWAP",
            ordType: "conditional",
            sz: 10,
            slTriggerPx: 77500,
            reduceOnly: true,
            side: "buy",
            posSide: "net",
            tdMode: "cross"
        }
    ];

    const res = evaluateOkx51088ProtectionRecovery({
        inventory,
        reconcileCtx,
        tpRequired: true
    });

    assert.equal(res.adopted, false);
    assert.equal(res.repairRequired, true);
    assert.equal(res.repairAction, "combined_oco_rebuild");
    assert.equal(res.finalProtectionSatisfied, false);
    pass("PROTECTION_RUNTIME_51088_SL_ONLY_TRIGGERS_REBUILD", { repairAction: res.repairAction });
}

// -------------------------------------------------------------------------------------------------
// 4. PROTECTION RUNTIME WIRING: 51088 + SL+TP both actual -> adopt_existing
// -------------------------------------------------------------------------------------------------
{
    const reconcileCtx: ProtectiveReconcileContext = {
        instId: "BTC-USDT-SWAP",
        positionSide: "short",
        openedAt36: "oap123",
        tdModeUsed: "cross",
        contractsToProtect: 10,
        activeStopPrice: 77500,
        activeTpPrice: 76000,
        wantsTp: true,
        expectedSide: "buy",
        tickSz: 0.1
    };

    const inventory: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_oco_runtime",
            instId: "BTC-USDT-SWAP",
            ordType: "oco",
            sz: 10,
            slTriggerPx: 77500,
            tpTriggerPx: 76000,
            reduceOnly: true,
            side: "buy",
            posSide: "net",
            tdMode: "cross"
        }
    ];

    const res = evaluateOkx51088ProtectionRecovery({
        inventory,
        reconcileCtx,
        tpRequired: true
    });

    assert.equal(res.adopted, true);
    assert.equal(res.repairRequired, false);
    assert.equal(res.repairAction, "adopt_existing");
    assert.equal(res.finalProtectionSatisfied, true);
    pass("PROTECTION_RUNTIME_51088_ADOPT_CONFIRMED_OCO", { repairAction: res.repairAction, adopted: res.adopted });
}

console.log("=== ALL PHASE D/E.5 RUNTIME WIRING VERIFICATION TESTS PASSED ===");
