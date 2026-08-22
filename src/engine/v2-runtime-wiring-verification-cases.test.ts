import assert from "node:assert/strict";
import { runEngineV2, adaptV2Input } from "../engine-v2/index";
import { evaluateOkx51088ProtectionRecovery } from "../engine-v2/execution/okx-protection-51088-recovery";
import {
    planProtectiveOrderReconcile,
    type ProtectiveAlgoRow,
    type ProtectiveReconcileContext
} from "../engine-v2/execution/protective-reconcile-plan";
import { evaluateAuthoritativeProtectionPresence } from "../engine-v2/execution/protective-rebuild-transaction";
import {
    resolveDesiredProtectionPlan,
    resolveExchangeProtectionTruth,
    planProtectionReconcile,
    resolveFinalProtectionAuthority
} from "../engine-v2/execution/final-protection-authority";
import { resolveFinalExitAuthority } from "../engine-v2/exit/final-exit-authority";

function pass(name: string, detail?: unknown) {
    console.log(`[RUNTIME-WIRING][${name}] PASS${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
}

console.log("=== STARTING PHASE D/E.6 FINAL RUNTIME COVERAGE & BOUNDARY TESTS ===");

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
// 2. EXIT RUNTIME POSITIVE PATH: Explicit terminal invalidation produces FULL_EXIT
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        policyResult: {
            action: "FULL_EXIT",
            reason: "V2_EXIT_INVALIDATION",
            shouldExit: true,
            shouldReduce: false,
            shouldPartial: false,
            reduceRatio: 1
        },
        lifecycleResult: {
            exitAction: null,
            exitReason: null,
            partialAction: null,
            partialReason: null,
            reduceRatio: 0
        },
        riskResult: {
            action: "exit",
            reason: "V2_EXIT_INVALIDATION",
            shouldExit: true
        },
        timestamp: NOW
    });

    assert.equal(res.action, "FULL_EXIT");
    assert.equal(res.shouldExit, true);
    assert.equal(res.terminalReason, "V2_EXIT_INVALIDATION");
    assert.equal(res.explicitTerminalEvidence, true);
    pass("EXIT_RUNTIME_EXPLICIT_INVALIDATION_FULL_EXIT", {
        action: res.action,
        shouldExit: res.shouldExit,
        terminalReason: res.terminalReason,
        explicitTerminalEvidence: res.explicitTerminalEvidence
    });
}

// -------------------------------------------------------------------------------------------------
// 3. PROTECTION RUNTIME: Normal Periodic Reconcile (SL exists + TP missing -> Repair required)
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
            algoId: "algo_sl_only_periodic",
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

    // Tested via authoritative production presence evaluator
    const presence = evaluateAuthoritativeProtectionPresence({
        inventory,
        reconcileCtx,
        tpRequired: true
    });

    assert.equal(presence.slPresent, true);
    assert.equal(presence.tpPresent, false);
    assert.equal(presence.protectionSatisfied, false);

    // Tested via production planner
    const plan = planProtectiveOrderReconcile(inventory, reconcileCtx);
    assert.equal(plan.slOnlyOcoRebuild, true);
    pass("PROTECTION_RUNTIME_NORMAL_SL_ONLY_REPAIR", {
        slPresent: presence.slPresent,
        tpPresent: presence.tpPresent,
        protectionSatisfied: presence.protectionSatisfied,
        slOnlyOcoRebuild: plan.slOnlyOcoRebuild
    });
}

// -------------------------------------------------------------------------------------------------
// 4. PROTECTION RUNTIME: 51088 Conflict Recovery (SL exists + TP missing -> combined_oco_rebuild)
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
// 5. PROTECTION RUNTIME: 51088 Conflict Recovery (SL+TP both actual -> adopt_existing)
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

// -------------------------------------------------------------------------------------------------
// 6. PROTECTION RUNTIME: Partial Reduce -> Old size protection is stale, replacement planned
// -------------------------------------------------------------------------------------------------
{
    const reducedCtx: ProtectiveReconcileContext = {
        instId: "BTC-USDT-SWAP",
        positionSide: "short",
        openedAt36: "oap123",
        tdModeUsed: "cross",
        contractsToProtect: 5, // Reduced from 10 to 5
        activeStopPrice: 77500,
        activeTpPrice: 76000,
        wantsTp: true,
        expectedSide: "buy",
        tickSz: 0.1
    };

    const oldSizeInventory: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_sl_old_10",
            instId: "BTC-USDT-SWAP",
            ordType: "conditional",
            sz: 10, // Old size 10 vs new size 5
            slTriggerPx: 77500,
            reduceOnly: true,
            side: "buy",
            posSide: "net",
            tdMode: "cross"
        }
    ];

    const plan = planProtectiveOrderReconcile(oldSizeInventory, reducedCtx);
    assert.equal(plan.staleCount, 1);
    assert.deepEqual(plan.cancelAlgoIds, ["algo_sl_old_10"]);
    assert.equal(plan.submitOco, true);

    const presence = evaluateAuthoritativeProtectionPresence({
        inventory: oldSizeInventory,
        reconcileCtx: reducedCtx,
        tpRequired: true
    });
    assert.equal(presence.protectionSatisfied, false); // Not satisfied by stale order
    pass("PROTECTION_RUNTIME_PARTIAL_REDUCE_STALE_SIZE", {
        staleCount: plan.staleCount,
        cancelAlgoIds: plan.cancelAlgoIds,
        submitOco: plan.submitOco,
        protectionSatisfied: presence.protectionSatisfied
    });
}

// -------------------------------------------------------------------------------------------------
// 7. PROTECTION RUNTIME: Flat after SL fill -> TERMINAL_NO_PROTECTION_REQUIRED, no recreate
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 0, // Flat
        slPrice: null,
        tpPrice: null,
        isV2Authority: true
    });

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 0,
        authoritativeFetchReady: true,
        pendingAlgos: [],
        desiredPlan: desired,
        tickSz: 0.1
    });

    const reconcilePlan = planProtectionReconcile({
        desired,
        actual
    });

    const finalAuth = resolveFinalProtectionAuthority({
        symbol: desired.symbol,
        side: desired.side,
        desired,
        actual,
        reconcilePlan
    });

    assert.equal(desired.contracts, 0);
    assert.equal(desired.slRequired, false);
    assert.equal(desired.tpRequired, false);
    assert.equal(reconcilePlan.action, "NOOP");
    assert.equal(reconcilePlan.needSubmitSl, false);
    assert.equal(reconcilePlan.needSubmitTp, false);
    assert.equal(reconcilePlan.needSubmitOco, false);
    assert.equal(finalAuth.state, "TERMINAL_NO_PROTECTION_REQUIRED");
    assert.equal(finalAuth.hardBlocked, false);
    pass("PROTECTION_RUNTIME_FLAT_AFTER_SL_NO_RECREATE", { state: finalAuth.state, action: reconcilePlan.action });
}

// -------------------------------------------------------------------------------------------------
// 8. PROTECTION RUNTIME: Flat after TP fill -> TERMINAL_NO_PROTECTION_REQUIRED, no recreate
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "ETHUSDT",
        side: "long",
        contracts: 0, // Flat after TP fill
        slPrice: null,
        tpPrice: null,
        isV2Authority: true
    });

    const actual = resolveExchangeProtectionTruth({
        symbol: "ETHUSDT",
        instId: "ETH-USDT-SWAP",
        side: "long",
        actualContracts: 0,
        authoritativeFetchReady: true,
        pendingAlgos: [],
        desiredPlan: desired,
        tickSz: 0.01
    });

    const reconcilePlan = planProtectionReconcile({
        desired,
        actual
    });

    const finalAuth = resolveFinalProtectionAuthority({
        symbol: desired.symbol,
        side: desired.side,
        desired,
        actual,
        reconcilePlan
    });

    assert.equal(desired.slRequired, false);
    assert.equal(desired.tpRequired, false);
    assert.equal(reconcilePlan.action, "NOOP");
    assert.equal(reconcilePlan.needSubmitOco, false);
    assert.equal(finalAuth.state, "TERMINAL_NO_PROTECTION_REQUIRED");
    pass("PROTECTION_RUNTIME_FLAT_AFTER_TP_NO_RECREATE", { state: finalAuth.state, action: reconcilePlan.action });
}

console.log("=== ALL PHASE D/E.6 FINAL RUNTIME COVERAGE & BOUNDARY TESTS PASSED ===");
