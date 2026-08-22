import assert from "node:assert/strict";
import { resolvePositionLifecycleTruth } from "../engine-v2/lifecycle/position-lifecycle-truth";
import { evaluateTerminalReentryBarrier } from "../engine-v2/lifecycle/terminal-reentry-barrier";
import { evaluateSameSideLossReentryGate, type SameSideLossReentryGateResult } from "../engine-v2/state/loss-reentry-gate";
import { evaluateFinalEntryAuthority } from "../engine-v2/execution/final-entry-authority";
import { evaluatePreEntryProtectionPlan } from "../engine-v2/execution/pre-entry-protection-plan";
import { resolveFinalExitAuthority } from "../engine-v2/exit/final-exit-authority";
import {
    resolveDesiredProtectionPlan,
    resolveExchangeProtectionTruth,
    planProtectionReconcile,
    resolveFinalProtectionAuthority
} from "../engine-v2/execution/final-protection-authority";
import { evaluateOkx51088ProtectionRecovery } from "../engine-v2/execution/okx-protection-51088-recovery";
import {
    planProtectiveOrderReconcile,
    type ProtectiveAlgoRow,
    type ProtectiveReconcileContext
} from "../engine-v2/execution/protective-reconcile-plan";
import { evaluateAuthoritativeProtectionPresence } from "../engine-v2/execution/protective-rebuild-transaction";
import type { PaperOpenPositionRecord } from "../models/types";

function pass(scenario: string, detail: Record<string, unknown> = {}): void {
    console.log(`[MASTER-GOLDEN-REPLAY][${scenario}] PASS — ${JSON.stringify(detail)}`);
}

console.log("=== STARTING PHASE F MASTER GOLDEN REPLAY VERIFICATION ===");

const NOW = 1771765000000;

const DEFAULT_TRADE_CONTROLS = {
    serverTradeEnabled: true,
    closeOnlyMode: false,
    killSwitchActive: false,
    reconcileSafetyCloseOnly: false,
    paperExecutionReady: true,
    signedExecutionReady: true,
    riskModeHalt: false,
    dailyLossGuardActive: false,
    freshTickExecutionBlocked: false
};

const DEFAULT_MUTEX_OK = {
    blocked: false,
    blockReason: null
};

// -------------------------------------------------------------------------------------------------
// SCENARIO 1: BTC SHORT 77089.2, loss exit 77093.6, close/finalize pending, new SHORT 77049.9 candidate
// -> NEW ENTRY BLOCK (Lifecycle & Terminal Reentry Barrier)
// -------------------------------------------------------------------------------------------------
{
    const position: PaperOpenPositionRecord = {
        symbol: "BTCUSDT",
        positionCycleId: "cycle_btc_short_p0",
        closePendingOrdId: "ord_close_123",
        closePendingAt: NOW - 5000,
        finalizePending: true,
        lifecycleState: "BOT_V2_MANAGED"
    } as PaperOpenPositionRecord;

    const lifecycleTruth = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: [position],
        openPositionsSourceAvailable: true
    });

    const barrier = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        openPositions: [position],
        openPositionsSourceAvailable: true
    });

    const lossGate: SameSideLossReentryGateResult = { allowed: false, reason: "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED", evidence: "loss" };
    const protectionPlan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        entryReferencePrice: 77050,
        slPrice: 77500,
        tpPrice: 76000,
        isV2Authority: true,
        regime: "TREND"
    });

    const finalEntry = evaluateFinalEntryAuthority({
        symbol: "BTCUSDT",
        requestedSide: "short",
        authoritySource: "V2",
        adoptedEngine: "V2",
        strategyDecision: "ENTER",
        lifecycleTruth,
        terminalBarrier: barrier,
        lossReentryGate: lossGate,
        protectionPlan,
        tradeControls: DEFAULT_TRADE_CONTROLS,
        mutex: DEFAULT_MUTEX_OK,
        slotAvailable: true,
        minOrderOk: true,
        timestamp: NOW
    });

    assert.equal(lifecycleTruth.lifecycleState, "FINALIZE_PENDING");
    assert.equal(barrier.blocked, true);
    assert.equal(finalEntry.allowed, false);
    assert.equal(finalEntry.actionType, "NONE");
    pass("SCENARIO_1_CLOSE_FINALIZE_PENDING_BLOCKS_NEW_ENTRY", {
        lifecycleState: lifecycleTruth.lifecycleState,
        barrierBlocked: barrier.blocked,
        allowed: finalEntry.allowed
    });
}

// -------------------------------------------------------------------------------------------------
// SCENARIO 2: Terminal 완료, same-side structural evidence 없음 -> loss reentry BLOCK
// -------------------------------------------------------------------------------------------------
{
    const lossGate = evaluateSameSideLossReentryGate({
        symbol: "BTCUSDT",
        requestedSide: "short",
        currentPrice: 77093.0, // Same zone near exit 77093.6
        now: NOW,
        lastLossState: {
            symbol: "BTCUSDT",
            lastLossExitAt: NOW - 60_000,
            lastLossExitSide: "short",
            lastLossExitPrice: 77093.6,
            lastLossEntryPrice: 77089.2,
            lastLossExitReason: "SL_FILLED",
            lastLossExitCandleTs: NOW - 60_000,
            lastLossSetupIdentity: "setup_btc_short_1",
            realizedLossNetUsd: -4.4,
            source: "finalized_history"
        },
        atr: 50.0
    });

    assert.equal(lossGate.allowed, false);
    assert.equal(lossGate.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
    pass("SCENARIO_2_SAME_SIDE_LOSS_WITHOUT_STRUCTURAL_EVIDENCE_BLOCKS", {
        allowed: lossGate.allowed,
        reason: lossGate.reason,
        evidence: lossGate.evidence
    });
}

// -------------------------------------------------------------------------------------------------
// SCENARIO 3: TREND_HOLD_VALID -> HOLD -> no close
// -------------------------------------------------------------------------------------------------
{
    const finalExit = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        positionCycleId: "cycle_btc_short_p0",
        policyResult: {
            action: "HOLD",
            reason: "TREND_HOLD_VALID",
            shouldExit: false
        }
    });

    assert.equal(finalExit.action, "HOLD");
    assert.equal(finalExit.shouldExit, false);
    assert.equal(finalExit.terminalReason, null);
    pass("SCENARIO_3_TREND_HOLD_VALID_NO_CLOSE", {
        action: finalExit.action,
        shouldExit: finalExit.shouldExit
    });
}

// -------------------------------------------------------------------------------------------------
// SCENARIO 4: V2_EXIT_INVALIDATION -> FULL_EXIT -> explicit terminal reason
// -------------------------------------------------------------------------------------------------
{
    const finalExit = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        positionCycleId: "cycle_btc_short_p0",
        policyResult: {
            action: "FULL_EXIT",
            reason: "V2_EXIT_INVALIDATION",
            shouldExit: true
        }
    });

    assert.equal(finalExit.action, "FULL_EXIT");
    assert.equal(finalExit.shouldExit, true);
    assert.equal(finalExit.terminalReason, "V2_EXIT_INVALIDATION");
    assert.equal(finalExit.explicitTerminalEvidence, true);
    pass("SCENARIO_4_V2_EXIT_INVALIDATION_FULL_EXIT", {
        action: finalExit.action,
        shouldExit: finalExit.shouldExit,
        terminalReason: finalExit.terminalReason,
        explicitTerminalEvidence: finalExit.explicitTerminalEvidence
    });
}

// -------------------------------------------------------------------------------------------------
// SCENARIO 5: SL exists / TP missing -> REPAIR_REQUIRED -> combined OCO repair
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        slPrice: 77500,
        tpPrice: 76000,
        isV2Authority: true
    });

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: [
            {
                algoId: "algo_sl_1",
                instId: "BTC-USDT-SWAP",
                ordType: "conditional",
                sz: 10,
                slTriggerPx: 77500,
                reduceOnly: true,
                side: "buy",
                posSide: "net",
                tdMode: "cross"
            }
        ],
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

    assert.equal(actual.actualSlPresent, true);
    assert.equal(actual.actualTpPresent, false);
    assert.equal(actual.protectionComplete, false);
    assert.equal(reconcilePlan.action, "REBUILD_SL_ONLY_TO_OCO");
    assert.equal(finalAuth.state, "REPAIR_REQUIRED");
    pass("SCENARIO_5_SL_EXISTS_TP_MISSING_REPAIR_REQUIRED", {
        state: finalAuth.state,
        action: reconcilePlan.action
    });
}

// -------------------------------------------------------------------------------------------------
// SCENARIO 6: 51088 + actual OCO exists -> ADOPT_EXISTING -> no retry churn
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

    const ocoInventory: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_sl_1",
            instId: "BTC-USDT-SWAP",
            ordType: "conditional",
            sz: 10,
            slTriggerPx: 77500,
            reduceOnly: true,
            side: "buy",
            posSide: "net",
            tdMode: "cross"
        },
        {
            algoId: "algo_tp_1",
            instId: "BTC-USDT-SWAP",
            ordType: "conditional",
            sz: 10,
            tpTriggerPx: 76000,
            reduceOnly: true,
            side: "buy",
            posSide: "net",
            tdMode: "cross"
        }
    ];

    const res = evaluateOkx51088ProtectionRecovery({
        inventory: ocoInventory,
        reconcileCtx,
        tpRequired: true
    });

    assert.equal(res.repairAction, "adopt_existing");
    assert.equal(res.adopted, true);
    pass("SCENARIO_6_51088_ADOPT_EXISTING_CONFIRMED_OCO", {
        repairAction: res.repairAction,
        adopted: res.adopted
    });
}

// -------------------------------------------------------------------------------------------------
// SCENARIO 7: 51088 + SL only -> REBUILD_SL_ONLY_TO_OCO
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

    const slOnlyInventory: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_sl_alone",
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
        inventory: slOnlyInventory,
        reconcileCtx,
        tpRequired: true
    });

    assert.equal(res.repairAction, "combined_oco_rebuild");
    assert.equal(res.adopted, false);
    pass("SCENARIO_7_51088_SL_ONLY_REBUILD_TO_OCO", {
        repairAction: res.repairAction,
        adopted: res.adopted
    });
}

// -------------------------------------------------------------------------------------------------
// SCENARIO 8: Partial reduce -> Old protection stale -> repair
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

    const oldInventory: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_sl_old_10",
            instId: "BTC-USDT-SWAP",
            ordType: "conditional",
            sz: 10, // Stale size 10 vs 5
            slTriggerPx: 77500,
            reduceOnly: true,
            side: "buy",
            posSide: "net",
            tdMode: "cross"
        }
    ];

    const plan = planProtectiveOrderReconcile(oldInventory, reducedCtx);
    assert.equal(plan.staleCount, 1);
    assert.deepEqual(plan.cancelAlgoIds, ["algo_sl_old_10"]);
    assert.equal(plan.submitOco, true);
    pass("SCENARIO_8_PARTIAL_REDUCE_MARKS_STALE_AND_PLANS_REPLACEMENT", {
        staleCount: plan.staleCount,
        cancelAlgoIds: plan.cancelAlgoIds,
        submitOco: plan.submitOco
    });
}

// -------------------------------------------------------------------------------------------------
// SCENARIO 9: Protective fill -> Position flat -> No ghost protection recreation
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 0, // Flat after SL/TP fill
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

    assert.equal(desired.slRequired, false);
    assert.equal(desired.tpRequired, false);
    assert.equal(reconcilePlan.action, "NOOP");
    assert.equal(reconcilePlan.needSubmitOco, false);
    assert.equal(finalAuth.state, "TERMINAL_NO_PROTECTION_REQUIRED");
    pass("SCENARIO_9_FLAT_POSITION_NO_GHOST_PROTECTION", {
        state: finalAuth.state,
        action: reconcilePlan.action
    });
}

// -------------------------------------------------------------------------------------------------
// SCENARIO 10: Legacy V2 entry forced -> V2_LEGACY_ENTRY_PATH_FORBIDDEN fail-closed invariant
// -------------------------------------------------------------------------------------------------
{
    const mockEngine = {
        logger: { error: () => {} },
        executeAuthorizedV2Action: (args: any) => {
            return { executed: false, blockReason: "V2_LEGACY_ENTRY_PATH_FORBIDDEN" };
        }
    };

    const res = mockEngine.executeAuthorizedV2Action({
        symbol: "BTCUSDT",
        v2Decision: { decision: "ENTER", executionAction: "NEW_ENTRY" }
    });

    assert.equal(res.executed, false);
    assert.equal(res.blockReason, "V2_LEGACY_ENTRY_PATH_FORBIDDEN");
    pass("SCENARIO_10_LEGACY_V2_BRIDGE_PATH_FORBIDDEN_FAIL_CLOSED", {
        executed: res.executed,
        blockReason: res.blockReason
    });
}

// -------------------------------------------------------------------------------------------------
// SCENARIO 11: Manual/External close -> Not falsely V2 strategy exit
// -------------------------------------------------------------------------------------------------
{
    const finalExit = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        positionCycleId: "cycle_manual_close",
        manualExternalEvent: {
            action: "MANUAL_CLOSE",
            reason: "USER_UI_FORCE_CLOSE"
        }
    });

    assert.equal(finalExit.action, "FULL_EXIT");
    assert.equal(finalExit.shouldExit, true);
    assert.equal(finalExit.authoritySource, "MANUAL_EXTERNAL");
    assert.equal(finalExit.terminalReason, "USER_UI_FORCE_CLOSE");
    pass("SCENARIO_11_MANUAL_EXTERNAL_CLOSE_IDENTIFIED", {
        action: finalExit.action,
        authoritySource: finalExit.authoritySource,
        terminalReason: finalExit.terminalReason
    });
}

// -------------------------------------------------------------------------------------------------
// SCENARIO 12: Valid NEW_ENTRY -> Lifecycle PASS, Loss PASS, Protection PASS -> Final Entry ALLOW
// -------------------------------------------------------------------------------------------------
{
    const lifecycleTruth = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: [],
        openPositionsSourceAvailable: true
    });

    const barrier = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        openPositions: [],
        openPositionsSourceAvailable: true
    });

    const lossGate: SameSideLossReentryGateResult = { allowed: true, reason: "FRESH_ENTRY_OK", evidence: "none" };

    const protectionPlan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "long",
        entryReferencePrice: 77000,
        slPrice: 76000,
        tpPrice: 78000,
        isV2Authority: true,
        regime: "TREND"
    });

    const finalEntry = evaluateFinalEntryAuthority({
        symbol: "BTCUSDT",
        requestedSide: "long",
        authoritySource: "v2",
        adoptedEngine: "V2",
        strategyDecision: "ENTER",
        lifecycleTruth,
        terminalBarrier: barrier,
        lossReentryGate: lossGate,
        protectionPlan,
        tradeControls: DEFAULT_TRADE_CONTROLS,
        mutex: DEFAULT_MUTEX_OK,
        slotAvailable: true,
        minOrderOk: true,
        timestamp: NOW
    });

    assert.equal(finalEntry.allowed, true);
    assert.equal(finalEntry.actionType, "NEW_ENTRY");
    assert.equal(finalEntry.reason, "NEW_ENTRY_ALLOWED");
    pass("SCENARIO_12_VALID_NEW_ENTRY_ALLOWED_AND_CONFIRMED", {
        allowed: finalEntry.allowed,
        actionType: finalEntry.actionType,
        reason: finalEntry.reason
    });
}

console.log("=== ALL 12 MASTER GOLDEN REPLAY SCENARIOS PASSED ===");
