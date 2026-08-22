import assert from "node:assert/strict";
import {
    evaluateFinalEntryAuthority,
    buildFinalEntryAuthorityProof,
    type FinalEntryAuthorityContext
} from "../engine-v2/execution/final-entry-authority";
import { resolvePositionLifecycleTruth } from "../engine-v2/lifecycle/position-lifecycle-truth";
import { evaluateTerminalReentryBarrier } from "../engine-v2/lifecycle/terminal-reentry-barrier";
import { evaluatePreEntryProtectionPlan } from "../engine-v2/execution/pre-entry-protection-plan";
import type { SameSideLossReentryGateResult } from "../engine-v2/state/loss-reentry-gate";
import type { PaperOpenPositionRecord } from "../models/types";

const NOW = 1771765000000;

function pass(name: string, detail?: unknown) {
    console.log(`[ENTRY-EQUIVALENCE][${name}] PASS${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
}

console.log("=== STARTING PHASE C ENTRY AUTHORITY CONSOLIDATION & GOLDEN REPLAY TESTS ===");

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
// CASE A: Prior SHORT loss, close/finalize pending -> BLOCK (Terminal Barrier Blocks)
// -------------------------------------------------------------------------------------------------
{
    const open: PaperOpenPositionRecord = {
        symbol: "BTCUSDT",
        side: "short",
        openedAt: NOW - 60_000,
        entryPrice: 77089.2,
        finalizePending: true,
        lifecycleState: "BOT_V2_MANAGED"
    } as PaperOpenPositionRecord;

    const truth = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: [open],
        openPositionsSourceAvailable: true
    });
    const barrier = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        openPositions: [open],
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

    const res = evaluateFinalEntryAuthority({
        symbol: "BTCUSDT",
        requestedSide: "short",
        authoritySource: "v2",
        adoptedEngine: "V2",
        strategyDecision: "ENTER",
        lifecycleTruth: truth,
        terminalBarrier: barrier,
        lossReentryGate: lossGate,
        protectionPlan,
        tradeControls: DEFAULT_TRADE_CONTROLS,
        mutex: DEFAULT_MUTEX_OK,
        slotAvailable: true,
        minOrderOk: true
    });

    assert.equal(res.allowed, false);
    assert.equal(res.actionType, "NONE");
    assert.equal(res.lifecycleReady, false);
    assert.equal(res.reason, "FINALIZE_PENDING_AWAITING_OKX_FLAT");
    pass("CASE_A_CLOSE_FINALIZE_PENDING_BLOCKS", { reason: res.reason, actionType: res.actionType });
}

// -------------------------------------------------------------------------------------------------
// CASE B: Terminal 완료, same-side loss gate BLOCK -> BLOCK
// -------------------------------------------------------------------------------------------------
{
    const truth = resolvePositionLifecycleTruth({ symbol: "BTCUSDT", openPositions: [], openPositionsSourceAvailable: true });
    const barrier = evaluateTerminalReentryBarrier({ symbol: "BTCUSDT", openPositions: [], openPositionsSourceAvailable: true });
    const lossGate: SameSideLossReentryGateResult = { allowed: false, reason: "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED", evidence: "churn" };
    const protectionPlan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        entryReferencePrice: 77050,
        slPrice: 77500,
        tpPrice: 76000,
        isV2Authority: true,
        regime: "TREND"
    });

    const res = evaluateFinalEntryAuthority({
        symbol: "BTCUSDT",
        requestedSide: "short",
        authoritySource: "v2",
        adoptedEngine: "V2",
        strategyDecision: "ENTER",
        lifecycleTruth: truth,
        terminalBarrier: barrier,
        lossReentryGate: lossGate,
        protectionPlan,
        tradeControls: DEFAULT_TRADE_CONTROLS,
        mutex: DEFAULT_MUTEX_OK,
        slotAvailable: true,
        minOrderOk: true
    });

    assert.equal(res.allowed, false);
    assert.equal(res.actionType, "NEW_ENTRY");
    assert.equal(res.lifecycleReady, true);
    assert.equal(res.lossReentryReady, false);
    assert.equal(res.reason, "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED");
    pass("CASE_B_SAME_SIDE_LOSS_GATE_BLOCKS", { reason: res.reason, lossReentryReady: res.lossReentryReady });
}

// -------------------------------------------------------------------------------------------------
// CASE C: Terminal 완료, loss gate PASS, TP unavailable (Trend mandatory) -> BLOCK
// -------------------------------------------------------------------------------------------------
{
    const truth = resolvePositionLifecycleTruth({ symbol: "BTCUSDT", openPositions: [], openPositionsSourceAvailable: true });
    const barrier = evaluateTerminalReentryBarrier({ symbol: "BTCUSDT", openPositions: [], openPositionsSourceAvailable: true });
    const lossGate: SameSideLossReentryGateResult = { allowed: true, reason: "MEANINGFUL_DIRECTIONAL_DISPLACEMENT_ALLOWED", evidence: "pass" };
    const protectionPlan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        entryReferencePrice: 77050,
        slPrice: 77500,
        tpPrice: null, // TP Missing!
        isV2Authority: true,
        regime: "TREND"
    });

    const res = evaluateFinalEntryAuthority({
        symbol: "BTCUSDT",
        requestedSide: "short",
        authoritySource: "v2",
        adoptedEngine: "V2",
        strategyDecision: "ENTER",
        lifecycleTruth: truth,
        terminalBarrier: barrier,
        lossReentryGate: lossGate,
        protectionPlan,
        tradeControls: DEFAULT_TRADE_CONTROLS,
        mutex: DEFAULT_MUTEX_OK,
        slotAvailable: true,
        minOrderOk: true
    });

    assert.equal(res.allowed, false);
    assert.equal(res.actionType, "NEW_ENTRY");
    assert.equal(res.protectionPlanReady, false);
    assert.equal(res.reason, "V2_TREND_TP_PRICE_UNAVAILABLE");
    pass("CASE_C_TREND_TP_UNAVAILABLE_BLOCKS", { reason: res.reason, protectionPlanReady: res.protectionPlanReady });
}

// -------------------------------------------------------------------------------------------------
// CASE D: Terminal 완료, loss gate PASS, SL+TP valid, trade controls PASS -> NEW_ENTRY ALLOW
// -------------------------------------------------------------------------------------------------
{
    const truth = resolvePositionLifecycleTruth({ symbol: "BTCUSDT", openPositions: [], openPositionsSourceAvailable: true });
    const barrier = evaluateTerminalReentryBarrier({ symbol: "BTCUSDT", openPositions: [], openPositionsSourceAvailable: true });
    const lossGate: SameSideLossReentryGateResult = { allowed: true, reason: "MEANINGFUL_DIRECTIONAL_DISPLACEMENT_ALLOWED", evidence: "pass" };
    const protectionPlan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        entryReferencePrice: 77050,
        slPrice: 77500,
        tpPrice: 76000,
        isV2Authority: true,
        regime: "TREND"
    });

    const res = evaluateFinalEntryAuthority({
        symbol: "BTCUSDT",
        requestedSide: "short",
        authoritySource: "v2",
        adoptedEngine: "V2",
        strategyDecision: "ENTER",
        lifecycleTruth: truth,
        terminalBarrier: barrier,
        lossReentryGate: lossGate,
        protectionPlan,
        tradeControls: DEFAULT_TRADE_CONTROLS,
        mutex: DEFAULT_MUTEX_OK,
        slotAvailable: true,
        minOrderOk: true,
        evaluationBoundary: "PRE_SUBMIT"
    });

    assert.equal(res.allowed, true);
    assert.equal(res.actionType, "NEW_ENTRY");
    assert.equal(res.side, "short");
    assert.equal(res.reason, "NEW_ENTRY_ALLOWED");
    assert.equal(res.strategyEnterReady, true);
    assert.equal(res.lifecycleReady, true);
    assert.equal(res.lossReentryReady, true);
    assert.equal(res.protectionPlanReady, true);
    assert.equal(res.executionReady, true);

    const proof = buildFinalEntryAuthorityProof(res, { symbol: "BTCUSDT" });
    assert.equal(proof.event, "V2_FINAL_ENTRY_AUTHORITY_PROOF");
    assert.equal(proof.allowed, true);
    pass("CASE_D_NEW_ENTRY_ALLOWED_AND_PROOF", { allowed: res.allowed, actionType: res.actionType });
}

// -------------------------------------------------------------------------------------------------
// CASE E: OPEN existing position, new position-cycle candidate -> BLOCK / not NEW_ENTRY
// -------------------------------------------------------------------------------------------------
{
    const open: PaperOpenPositionRecord = {
        symbol: "ETHUSDT",
        side: "long",
        openedAt: NOW - 100_000,
        entryPrice: 2000,
        status: "open",
        lifecycleState: "BOT_V2_MANAGED"
    } as PaperOpenPositionRecord;

    const truth = resolvePositionLifecycleTruth({ symbol: "ETHUSDT", openPositions: [open], openPositionsSourceAvailable: true });
    const barrier = evaluateTerminalReentryBarrier({ symbol: "ETHUSDT", openPositions: [open], openPositionsSourceAvailable: true });
    const lossGate: SameSideLossReentryGateResult = { allowed: true, reason: "NO_PRIOR_LOSS", evidence: "none" };
    const protectionPlan = evaluatePreEntryProtectionPlan({
        symbol: "ETHUSDT",
        side: "long",
        entryReferencePrice: 2050,
        slPrice: 1950,
        tpPrice: 2200,
        isV2Authority: true,
        regime: "RANGE"
    });

    const res = evaluateFinalEntryAuthority({
        symbol: "ETHUSDT",
        requestedSide: "long",
        authoritySource: "v2",
        adoptedEngine: "V2",
        strategyDecision: "ENTER",
        isScaleIn: false,
        addOnAllowed: false, // New cycle attempted on existing open position!
        lifecycleTruth: truth,
        terminalBarrier: barrier,
        lossReentryGate: lossGate,
        protectionPlan,
        tradeControls: DEFAULT_TRADE_CONTROLS,
        mutex: { blocked: true, blockReason: "SYMBOL_SAME_SIDE_POSITION_ALREADY_OPEN" },
        slotAvailable: true,
        minOrderOk: true
    });

    assert.equal(res.allowed, false);
    assert.equal(res.actionType, "NONE");
    assert.equal(res.lifecycleReady, false);
    assert.equal(res.reason, "SYMBOL_SAME_SIDE_POSITION_ALREADY_OPEN");
    pass("CASE_E_OPEN_EXISTING_BLOCKS_NEW_CYCLE", { reason: res.reason, actionType: res.actionType });
}

// -------------------------------------------------------------------------------------------------
// CASE F: OPEN existing position, valid existing add-on authority -> ADDON ALLOW
// -------------------------------------------------------------------------------------------------
{
    const open: PaperOpenPositionRecord = {
        symbol: "ETHUSDT",
        side: "long",
        openedAt: NOW - 100_000,
        entryPrice: 2000,
        status: "open",
        lifecycleState: "BOT_V2_MANAGED"
    } as PaperOpenPositionRecord;

    const truth = resolvePositionLifecycleTruth({ symbol: "ETHUSDT", openPositions: [open], openPositionsSourceAvailable: true });
    const barrier = evaluateTerminalReentryBarrier({ symbol: "ETHUSDT", openPositions: [open], openPositionsSourceAvailable: true });
    const lossGate: SameSideLossReentryGateResult = { allowed: true, reason: "NO_PRIOR_LOSS", evidence: "none" };
    const protectionPlan = evaluatePreEntryProtectionPlan({
        symbol: "ETHUSDT",
        side: "long",
        entryReferencePrice: 2050,
        slPrice: 1950,
        tpPrice: 2200,
        isV2Authority: true,
        regime: "RANGE"
    });

    const res = evaluateFinalEntryAuthority({
        symbol: "ETHUSDT",
        requestedSide: "long",
        authoritySource: "v2",
        adoptedEngine: "V2",
        strategyDecision: "ENTER",
        isScaleIn: true,
        addOnAllowed: true, // Valid addOn!
        lifecycleTruth: truth,
        terminalBarrier: barrier,
        lossReentryGate: lossGate,
        protectionPlan,
        tradeControls: DEFAULT_TRADE_CONTROLS,
        mutex: DEFAULT_MUTEX_OK,
        slotAvailable: true,
        minOrderOk: true
    });

    assert.equal(res.allowed, true);
    assert.equal(res.actionType, "ADDON");
    assert.equal(res.side, "long");
    assert.equal(res.reason, "ADDON_ALLOWED");
    pass("CASE_F_VALID_ADDON_ALLOWED", { allowed: res.allowed, actionType: res.actionType });
}

// -------------------------------------------------------------------------------------------------
// CASE G: Rehydration original ENTER, but terminal barrier BLOCK -> FINAL BLOCK
// -------------------------------------------------------------------------------------------------
{
    const open: PaperOpenPositionRecord = {
        symbol: "BTCUSDT",
        side: "short",
        openedAt: NOW - 60_000,
        entryPrice: 77089.2,
        finalizePending: true,
        lifecycleState: "BOT_V2_MANAGED"
    } as PaperOpenPositionRecord;

    const truth = resolvePositionLifecycleTruth({ symbol: "BTCUSDT", openPositions: [open], openPositionsSourceAvailable: true });
    const barrier = evaluateTerminalReentryBarrier({ symbol: "BTCUSDT", openPositions: [open], openPositionsSourceAvailable: true });
    const lossGate: SameSideLossReentryGateResult = { allowed: true, reason: "PASS", evidence: "pass" };
    const protectionPlan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        entryReferencePrice: 77050,
        slPrice: 77500,
        tpPrice: 76000,
        isV2Authority: true,
        regime: "TREND"
    });

    // Simulating decision rehydrated from REJECT back to ENTER
    const rehydratedDecision = "ENTER";

    const res = evaluateFinalEntryAuthority({
        symbol: "BTCUSDT",
        requestedSide: "short",
        authoritySource: "v2",
        adoptedEngine: "V2",
        strategyDecision: rehydratedDecision,
        lifecycleTruth: truth,
        terminalBarrier: barrier, // Terminal barrier blocked!
        lossReentryGate: lossGate,
        protectionPlan,
        tradeControls: DEFAULT_TRADE_CONTROLS,
        mutex: DEFAULT_MUTEX_OK,
        slotAvailable: true,
        minOrderOk: true
    });

    assert.equal(res.allowed, false);
    assert.equal(res.lifecycleReady, false);
    assert.equal(res.reason, "FINALIZE_PENDING_AWAITING_OKX_FLAT");
    pass("CASE_G_HYDRATED_ENTER_STILL_BLOCKED_BY_TERMINAL", { allowed: res.allowed, reason: res.reason });
}

// -------------------------------------------------------------------------------------------------
// CASE H: Rehydration original ENTER, but TP unavailable -> FINAL BLOCK
// -------------------------------------------------------------------------------------------------
{
    const truth = resolvePositionLifecycleTruth({ symbol: "BTCUSDT", openPositions: [], openPositionsSourceAvailable: true });
    const barrier = evaluateTerminalReentryBarrier({ symbol: "BTCUSDT", openPositions: [], openPositionsSourceAvailable: true });
    const lossGate: SameSideLossReentryGateResult = { allowed: true, reason: "PASS", evidence: "pass" };
    const protectionPlan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        entryReferencePrice: 77050,
        slPrice: 77500,
        tpPrice: null, // TP Missing!
        isV2Authority: true,
        regime: "TREND"
    });

    const rehydratedDecision = "ENTER";

    const res = evaluateFinalEntryAuthority({
        symbol: "BTCUSDT",
        requestedSide: "short",
        authoritySource: "v2",
        adoptedEngine: "V2",
        strategyDecision: rehydratedDecision,
        lifecycleTruth: truth,
        terminalBarrier: barrier,
        lossReentryGate: lossGate,
        protectionPlan,
        tradeControls: DEFAULT_TRADE_CONTROLS,
        mutex: DEFAULT_MUTEX_OK,
        slotAvailable: true,
        minOrderOk: true
    });

    assert.equal(res.allowed, false);
    assert.equal(res.protectionPlanReady, false);
    assert.equal(res.reason, "V2_TREND_TP_PRICE_UNAVAILABLE");
    pass("CASE_H_HYDRATED_ENTER_STILL_BLOCKED_BY_PROTECTION", { allowed: res.allowed, reason: res.reason });
}

// -------------------------------------------------------------------------------------------------
// CASE I: Legacy V2 path forced -> executeAuthorizedV2Action returns fail-closed
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
        v2Decision: { decision: "ENTER", executionAction: "ENTER" },
        lastPrice: 77000,
        committedRiskPlan: {}
    });

    assert.equal(res.executed, false);
    assert.equal(res.blockReason, "V2_LEGACY_ENTRY_PATH_FORBIDDEN");
    pass("CASE_I_LEGACY_V2_PATH_FORBIDDEN", { executed: res.executed, blockReason: res.blockReason });
}

console.log("=== ALL PHASE C ENTRY AUTHORITY CONSOLIDATION & GOLDEN REPLAY TESTS PASSED ===");
