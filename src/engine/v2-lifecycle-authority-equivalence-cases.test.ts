import assert from "node:assert/strict";
import {
    resolvePositionLifecycleTruth,
    evaluateTerminalReentryBarrier,
    type PositionLifecycleState
} from "../engine-v2/lifecycle/terminal-reentry-barrier";
import type { PaperOpenPositionRecord } from "../models/types";

const NOW = 1771765000000;

function pass(name: string, detail?: unknown) {
    console.log(`[LIFECYCLE-EQUIVALENCE][${name}] PASS${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
}

console.log("=== STARTING PHASE B LIFECYCLE AUTHORITY EQUIVALENCE & GOLDEN REPLAY TESTS ===");

// -------------------------------------------------------------------------------------------------
// SECTION 1: GOLDEN REPLAY FIXTURE (Recent BTC Short loss churn sequence)
// BTC SHORT: entry 77089.2, exit 77093.6, close transition -> new SHORT candidate 77049.9
// -------------------------------------------------------------------------------------------------
{
    // Step 1: Active Open position (entry 77089.2)
    const openRow: PaperOpenPositionRecord = {
        symbol: "BTCUSDT",
        side: "short",
        openedAt: NOW - 60_000,
        entryPrice: 77089.2,
        sizeUsd: 100,
        status: "open",
        lifecycleState: "BOT_V2_MANAGED",
        positionCycleId: "cycle_btc_replay_1"
    } as PaperOpenPositionRecord;

    const truthOpen = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: [openRow],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: true
    });
    assert.equal(truthOpen.lifecycleState, "OPEN");
    assert.equal(truthOpen.isTerminal, false);

    const barrierOpen = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        requestedSide: "short",
        openPositions: [openRow],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: true
    });
    assert.equal(barrierOpen.blocked, false);
    assert.equal(barrierOpen.reason, "NO_TERMINAL_TRANSITION");
    pass("REPLAY_STEP_1_OPEN_STATE_FACTUAL", { state: truthOpen.lifecycleState, blocked: barrierOpen.blocked });

    // Step 2: Close submitted on OKX (closePendingOrdId exists, awaiting fill)
    const closeSubmittedRow: PaperOpenPositionRecord = {
        ...openRow,
        closePendingOrdId: "ord_close_1",
        closePendingClOrdId: "clord_close_1",
        lifecycleState: "CLOSE_PENDING"
    } as PaperOpenPositionRecord;

    const truthSubmitted = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: [closeSubmittedRow],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: true
    });
    assert.equal(truthSubmitted.lifecycleState, "CLOSE_FILL_PENDING");
    assert.equal(truthSubmitted.isTerminal, false);
    assert.equal(truthSubmitted.closePending, true);

    const barrierSubmitted = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        requestedSide: "short",
        openPositions: [closeSubmittedRow],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: true
    });
    assert.equal(barrierSubmitted.blocked, true);
    assert.equal(barrierSubmitted.reason, "CLOSE_PENDING_AWAITING_FILL");
    pass("REPLAY_STEP_2_CLOSE_SUBMITTED_BLOCKS_REENTRY", { state: truthSubmitted.lifecycleState, reason: barrierSubmitted.reason });

    // Step 3: Fill confirmed, but finalize pending (awaiting flat / durable history finalize)
    const finalizePendingRow: PaperOpenPositionRecord = {
        ...openRow,
        finalizePending: true,
        pendingFinalizeExitAvgPx: 77093.6,
        pendingFinalizePositionCycleId: "cycle_btc_replay_1"
    } as PaperOpenPositionRecord;

    const truthFinalize = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: [finalizePendingRow],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: false
    });
    assert.equal(truthFinalize.lifecycleState, "FINALIZE_PENDING");
    assert.equal(truthFinalize.isTerminal, false);
    assert.equal(truthFinalize.finalizePending, true);

    const barrierFinalize = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        requestedSide: "short",
        openPositions: [finalizePendingRow],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: false
    });
    assert.equal(barrierFinalize.blocked, true);
    assert.equal(barrierFinalize.reason, "FINALIZE_PENDING_AWAITING_OKX_FLAT");
    pass("REPLAY_STEP_3_FINALIZE_PENDING_BLOCKS_REENTRY", { state: truthFinalize.lifecycleState, reason: barrierFinalize.reason });

    // Step 4: Fully terminal flat confirmation (open positions empty, OKX actual flat)
    const truthTerminal = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: [],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: false
    });
    assert.equal(truthTerminal.lifecycleState, "TERMINAL");
    assert.equal(truthTerminal.isTerminal, true);

    const barrierTerminal = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        requestedSide: "short",
        openPositions: [],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: false
    });
    assert.equal(barrierTerminal.blocked, false);
    assert.equal(barrierTerminal.reason, "NO_TERMINAL_TRANSITION");
    pass("REPLAY_STEP_4_TERMINAL_ALLOWS_BARRIER", { state: truthTerminal.lifecycleState, blocked: barrierTerminal.blocked });
}

// -------------------------------------------------------------------------------------------------
// SECTION 2: EQUIVALENCE TEST CASES A ~ J
// -------------------------------------------------------------------------------------------------

// Case A: Normal Open
{
    const open: PaperOpenPositionRecord = {
        symbol: "ETHUSDT",
        side: "long",
        openedAt: NOW,
        entryPrice: 2000,
        sizeUsd: 100,
        status: "open",
        lifecycleState: "BOT_V2_MANAGED",
        positionCycleId: "cycle_eth_open"
    } as PaperOpenPositionRecord;

    const truth = resolvePositionLifecycleTruth({ symbol: "ETHUSDT", openPositions: [open], openPositionsSourceAvailable: true });
    assert.equal(truth.lifecycleState, "OPEN");
    assert.equal(truth.isTerminal, false);
    assert.equal(truth.positionCycleId, "cycle_eth_open");

    const barrier = evaluateTerminalReentryBarrier({ symbol: "ETHUSDT", openPositions: [open], openPositionsSourceAvailable: true });
    assert.equal(barrier.blocked, false);
    assert.equal(barrier.reason, "NO_TERMINAL_TRANSITION");
    pass("CASE_A_NORMAL_OPEN", { state: truth.lifecycleState, blocked: barrier.blocked });
}

// Case B: Close Submitted (closePendingOrdId on record)
{
    const open: PaperOpenPositionRecord = {
        symbol: "ETHUSDT",
        side: "long",
        openedAt: NOW,
        closePendingOrdId: "ord_close_b",
        status: "open",
        lifecycleState: "CLOSE_PENDING"
    } as PaperOpenPositionRecord;

    const truth = resolvePositionLifecycleTruth({ symbol: "ETHUSDT", openPositions: [open], openPositionsSourceAvailable: true });
    assert.equal(truth.lifecycleState, "CLOSE_FILL_PENDING");
    assert.equal(truth.closePending, true);
    assert.equal(truth.reason, "CLOSE_PENDING_AWAITING_FILL");

    const barrier = evaluateTerminalReentryBarrier({ symbol: "ETHUSDT", openPositions: [open], openPositionsSourceAvailable: true });
    assert.equal(barrier.blocked, true);
    assert.equal(barrier.reason, "CLOSE_PENDING_AWAITING_FILL");
    pass("CASE_B_CLOSE_SUBMITTED", { state: truth.lifecycleState, reason: barrier.reason });
}

// Case C: Close Fill Pending (closePendingClOrdId on record)
{
    const open: PaperOpenPositionRecord = {
        symbol: "SOLUSDT",
        side: "short",
        openedAt: NOW,
        closePendingClOrdId: "clord_close_c",
        status: "open",
        lifecycleState: "BOT_V2_MANAGED"
    } as PaperOpenPositionRecord;

    const truth = resolvePositionLifecycleTruth({ symbol: "SOLUSDT", openPositions: [open], openPositionsSourceAvailable: true });
    assert.equal(truth.lifecycleState, "CLOSE_FILL_PENDING");
    assert.equal(truth.closePending, true);

    const barrier = evaluateTerminalReentryBarrier({ symbol: "SOLUSDT", openPositions: [open], openPositionsSourceAvailable: true });
    assert.equal(barrier.blocked, true);
    assert.equal(barrier.reason, "CLOSE_PENDING_AWAITING_FILL");
    pass("CASE_C_CLOSE_FILL_PENDING", { state: truth.lifecycleState, reason: barrier.reason });
}

// Case D: OKX still has position (empty ledger rows, but actual OKX position exists)
{
    const truth = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: [],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: true
    });
    assert.equal(truth.lifecycleState, "OPEN");
    assert.equal(truth.isTerminal, false);
    assert.equal(truth.actualPositionExists, true);
    assert.equal(truth.source, "okx_actual");

    const barrier = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        openPositions: [],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: true
    });
    assert.equal(barrier.blocked, false);
    assert.equal(barrier.actualPositionExists, true);
    assert.equal(barrier.reason, "NO_TERMINAL_TRANSITION");
    pass("CASE_D_OKX_STILL_HAS_POSITION", { state: truth.lifecycleState, blocked: barrier.blocked, actualPositionExists: barrier.actualPositionExists });
}

// Case E: OKX flat but finalize pending
{
    const open: PaperOpenPositionRecord = {
        symbol: "BTCUSDT",
        side: "short",
        openedAt: NOW,
        finalizePending: true,
        status: "open",
        lifecycleState: "BOT_V2_MANAGED"
    } as PaperOpenPositionRecord;

    const truth = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: [open],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: false
    });
    assert.equal(truth.lifecycleState, "FINALIZE_PENDING");
    assert.equal(truth.finalizePending, true);
    assert.equal(truth.reason, "FINALIZE_PENDING_AWAITING_OKX_FLAT");

    const barrier = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        openPositions: [open],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: false
    });
    assert.equal(barrier.blocked, true);
    assert.equal(barrier.reason, "FINALIZE_PENDING_AWAITING_OKX_FLAT");
    pass("CASE_E_OKX_FLAT_FINALIZE_PENDING", { state: truth.lifecycleState, reason: barrier.reason });
}

// Case F: Finalize pending with close pending (dual pending transition)
{
    const open: PaperOpenPositionRecord = {
        symbol: "BTCUSDT",
        side: "short",
        openedAt: NOW,
        finalizePending: true,
        closePendingOrdId: "ord_f",
        status: "open",
        lifecycleState: "CLOSE_PENDING"
    } as PaperOpenPositionRecord;

    const truth = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: [open],
        openPositionsSourceAvailable: true
    });
    assert.equal(truth.lifecycleState, "FINALIZE_PENDING");
    assert.equal(truth.reason, "FINALIZE_PENDING_WITH_CLOSE_PENDING");

    const barrier = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        openPositions: [open],
        openPositionsSourceAvailable: true
    });
    assert.equal(barrier.blocked, true);
    assert.equal(barrier.reason, "FINALIZE_PENDING_WITH_CLOSE_PENDING");
    pass("CASE_F_FINALIZE_WITH_CLOSE_PENDING", { state: truth.lifecycleState, reason: barrier.reason });
}

// Case G: Fully Terminal (no positions, no actual OKX position)
{
    const truth = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: [],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: false
    });
    assert.equal(truth.lifecycleState, "TERMINAL");
    assert.equal(truth.isTerminal, true);
    assert.equal(truth.source, "none");

    const barrier = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        openPositions: [],
        openPositionsSourceAvailable: true,
        actualOkxPositionExists: false
    });
    assert.equal(barrier.blocked, false);
    assert.equal(barrier.reason, "NO_TERMINAL_TRANSITION");
    pass("CASE_G_FULLY_TERMINAL", { state: truth.lifecycleState, blocked: barrier.blocked });
}

// Case H: State source unavailable (Fail Closed)
{
    const truth = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: null,
        openPositionsSourceAvailable: false
    });
    assert.equal(truth.lifecycleState, "UNAVAILABLE");
    assert.equal(truth.isTerminal, false);
    assert.equal(truth.reason, "TERMINAL_STATE_UNAVAILABLE_FAIL_CLOSED");

    const barrier = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        openPositions: [],
        openPositionsSourceAvailable: false
    });
    assert.equal(barrier.blocked, true);
    assert.equal(barrier.reason, "TERMINAL_STATE_UNAVAILABLE_FAIL_CLOSED");
    pass("CASE_H_SOURCE_UNAVAILABLE_FAIL_CLOSED", { state: truth.lifecycleState, reason: barrier.reason });
}

// Case I: Restart / Recovery State (terminalExitFlowIds active in-flight)
{
    const open: PaperOpenPositionRecord = {
        symbol: "ETHUSDT",
        side: "short",
        openedAt: 1234567,
        status: "open",
        lifecycleState: "BOT_V2_MANAGED",
        positionCycleId: "cycle_recovery_i"
    } as PaperOpenPositionRecord;

    const flowSet = new Set<string>(["ETHUSDT:short:1234567"]);
    const truth = resolvePositionLifecycleTruth({
        symbol: "ETHUSDT",
        openPositions: [open],
        openPositionsSourceAvailable: true,
        terminalExitFlowIds: flowSet
    });
    assert.equal(truth.lifecycleState, "FINALIZE_PENDING");
    assert.equal(truth.reason, "TERMINAL_EXIT_CONSUMED_AWAITING_FINALIZE");
    assert.equal(truth.source, "terminal_exit_flow");

    const barrier = evaluateTerminalReentryBarrier({
        symbol: "ETHUSDT",
        openPositions: [open],
        openPositionsSourceAvailable: true,
        terminalExitFlowIds: flowSet
    });
    assert.equal(barrier.blocked, true);
    assert.equal(barrier.reason, "TERMINAL_EXIT_CONSUMED_AWAITING_FINALIZE");
    pass("CASE_I_RESTART_RECOVERY_FLOW_STATE", { state: truth.lifecycleState, reason: barrier.reason });
}

// Case J: Manual / External Position in Terminal Transition
{
    const open: PaperOpenPositionRecord = {
        symbol: "BTCUSDT",
        side: "long",
        openedAt: NOW,
        closePendingOrdId: "ord_manual_close",
        status: "open",
        lifecycleState: "CLOSE_ONLY_MANAGED",
        closePendingAt: NOW
    } as PaperOpenPositionRecord;

    const truth = resolvePositionLifecycleTruth({
        symbol: "BTCUSDT",
        openPositions: [open],
        openPositionsSourceAvailable: true
    });
    assert.equal(truth.lifecycleState, "CLOSE_FILL_PENDING");
    assert.equal(truth.closePending, true);

    const barrier = evaluateTerminalReentryBarrier({
        symbol: "BTCUSDT",
        openPositions: [open],
        openPositionsSourceAvailable: true
    });
    assert.equal(barrier.blocked, true);
    assert.equal(barrier.reason, "CLOSE_PENDING_AWAITING_FILL");
    pass("CASE_J_MANUAL_EXTERNAL_CLOSE_PENDING", { state: truth.lifecycleState, reason: barrier.reason });
}

console.log("=== ALL PHASE B LIFECYCLE AUTHORITY EQUIVALENCE & REPLAY TESTS PASSED ===");
