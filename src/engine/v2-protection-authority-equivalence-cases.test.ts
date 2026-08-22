import assert from "node:assert/strict";
import {
    resolveDesiredProtectionPlan,
    resolveExchangeProtectionTruth,
    planProtectionReconcile,
    resolveFinalProtectionAuthority,
    buildFinalProtectionAuthorityProof
} from "../engine-v2/execution/final-protection-authority";
import type { ProtectiveAlgoRow } from "../engine-v2/execution/protective-reconcile-plan";

function pass(name: string, detail?: unknown) {
    console.log(`[PROTECTION-EQUIVALENCE][${name}] PASS${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
}

console.log("=== STARTING PHASE E PROTECTION AUTHORITY CONSOLIDATION & GOLDEN REPLAY TESTS ===");

const NOW = 1771765000000;

// -------------------------------------------------------------------------------------------------
// CASE A: V2 TREND, SL + TP actual confirmed -> PROTECTED
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    const algos: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_oco_123",
            instId: "BTC-USDT-SWAP",
            ordType: "oco",
            sz: 10,
            slTriggerPx: 77500,
            tpTriggerPx: 76000,
            reduceOnly: true,
            side: "buy",
            posSide: "net"
        }
    ];

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: algos,
        desiredPlan: desired
    });

    const reconcilePlan = planProtectionReconcile({ desired, actual });
    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan
    });

    assert.equal(finalAuth.state, "PROTECTED");
    assert.equal(finalAuth.protectionComplete, true);
    assert.equal(finalAuth.actualSlPresent, true);
    assert.equal(finalAuth.actualTpPresent, true);
    assert.equal(reconcilePlan.action, "NOOP");
    pass("CASE_A_TREND_SL_TP_CONFIRMED_PROTECTED", { state: finalAuth.state, action: reconcilePlan.action });
}

// -------------------------------------------------------------------------------------------------
// CASE B: SL exists, TP missing -> REPAIR_REQUIRED (false protected forbidden)
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    const algos: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_sl_only_123",
            instId: "BTC-USDT-SWAP",
            ordType: "conditional",
            sz: 10,
            slTriggerPx: 77500,
            reduceOnly: true,
            side: "buy",
            posSide: "net"
        }
    ];

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: algos,
        desiredPlan: desired
    });

    const reconcilePlan = planProtectionReconcile({ desired, actual });
    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan
    });

    assert.equal(finalAuth.state, "REPAIR_REQUIRED");
    assert.equal(finalAuth.protectionComplete, false);
    assert.equal(finalAuth.actualSlPresent, true);
    assert.equal(finalAuth.actualTpPresent, false);
    assert.equal(reconcilePlan.action, "REBUILD_SL_ONLY_TO_OCO");
    pass("CASE_B_SL_EXISTS_TP_MISSING_REPAIR_REQUIRED", { state: finalAuth.state, action: reconcilePlan.action });
}

// -------------------------------------------------------------------------------------------------
// CASE C: TP exists, SL missing -> REPAIR_REQUIRED
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    const algos: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_tp_only_123",
            instId: "BTC-USDT-SWAP",
            ordType: "conditional",
            sz: 10,
            tpTriggerPx: 76000,
            reduceOnly: true,
            side: "buy",
            posSide: "net"
        }
    ];

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: algos,
        desiredPlan: desired
    });

    const reconcilePlan = planProtectionReconcile({ desired, actual });
    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan
    });

    assert.equal(finalAuth.state, "REPAIR_REQUIRED");
    assert.equal(finalAuth.protectionComplete, false);
    assert.equal(reconcilePlan.action, "SUBMIT_SL_TP_OCO");
    pass("CASE_C_TP_EXISTS_SL_MISSING_REPAIR_REQUIRED", { state: finalAuth.state, action: reconcilePlan.action });
}

// -------------------------------------------------------------------------------------------------
// CASE D: SL/TP both missing -> SUBMIT_SL_TP_OCO
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: [],
        desiredPlan: desired
    });

    const reconcilePlan = planProtectionReconcile({ desired, actual });
    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan
    });

    assert.equal(finalAuth.state, "REPAIR_REQUIRED");
    assert.equal(reconcilePlan.action, "SUBMIT_SL_TP_OCO");
    assert.equal(reconcilePlan.needSubmitOco, true);
    pass("CASE_D_BOTH_MISSING_SUBMIT_OCO", { state: finalAuth.state, action: reconcilePlan.action });
}

// -------------------------------------------------------------------------------------------------
// CASE E: SL only + TP required + 51088 -> REBUILD_SL_ONLY_TO_OCO
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    const algos: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_sl_old",
            instId: "BTC-USDT-SWAP",
            ordType: "conditional",
            sz: 10,
            slTriggerPx: 77500,
            reduceOnly: true,
            side: "buy",
            posSide: "net"
        }
    ];

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: algos,
        desiredPlan: desired
    });

    const reconcilePlan = planProtectionReconcile({ desired, actual, has51088Error: true });
    assert.equal(reconcilePlan.action, "REBUILD_SL_ONLY_TO_OCO");
    pass("CASE_E_51088_SL_ONLY_REBUILD", { action: reconcilePlan.action, reason: reconcilePlan.reason });
}

// -------------------------------------------------------------------------------------------------
// CASE F: 51088, actual combined SL+TP exists -> ADOPT_EXISTING, PROTECTED
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    const algos: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_oco_confirmed",
            instId: "BTC-USDT-SWAP",
            ordType: "oco",
            sz: 10,
            slTriggerPx: 77500,
            tpTriggerPx: 76000,
            reduceOnly: true,
            side: "buy",
            posSide: "net"
        }
    ];

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: algos,
        desiredPlan: desired
    });

    const reconcilePlan = planProtectionReconcile({ desired, actual, has51088Error: true });
    assert.equal(reconcilePlan.action, "ADOPT_EXISTING");

    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan
    });
    assert.equal(finalAuth.state, "PROTECTED");
    pass("CASE_F_51088_ADOPT_EXISTING_NO_CHURN", { action: reconcilePlan.action, state: finalAuth.state });
}

// -------------------------------------------------------------------------------------------------
// CASE G: Ledger algoId exists, actual exchange order absent, grace expired -> REPAIR_REQUIRED
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: [], // Empty exchange!
        desiredPlan: desired,
        visibilityGracePending: false
    });

    const reconcilePlan = planProtectionReconcile({ desired, actual });
    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan
    });

    assert.equal(finalAuth.state, "REPAIR_REQUIRED");
    assert.equal(finalAuth.protectionComplete, false);
    pass("CASE_G_LEDGER_MEMORY_DOES_NOT_SUBSTITUTE_EXCHANGE_TRUTH", { state: finalAuth.state });
}

// -------------------------------------------------------------------------------------------------
// CASE H: Inside visibility grace -> VISIBILITY_PENDING (not PROTECTED yet)
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: [],
        desiredPlan: desired,
        visibilityGracePending: true
    });

    const reconcilePlan = planProtectionReconcile({ desired, actual });
    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan
    });

    assert.equal(finalAuth.state, "VISIBILITY_PENDING");
    assert.equal(finalAuth.protectionComplete, false);
    assert.equal(reconcilePlan.action, "WAIT_VISIBILITY_GRACE");
    pass("CASE_H_VISIBILITY_GRACE_PENDING", { state: finalAuth.state, action: reconcilePlan.action });
}

// -------------------------------------------------------------------------------------------------
// CASE I: Partial reduce size changed, old protection stale -> REPLACE_STALE_PROTECTION
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 5, // Reduced from 10 to 5
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    const algos: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_old_size_10",
            instId: "BTC-USDT-SWAP",
            ordType: "oco",
            sz: 10, // Stale size!
            slTriggerPx: 77500,
            tpTriggerPx: 76000,
            reduceOnly: true,
            side: "buy",
            posSide: "net"
        }
    ];

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 5,
        authoritativeFetchReady: true,
        pendingAlgos: algos,
        desiredPlan: desired
    });

    assert.equal(actual.staleProtectiveOrders, true);
    assert.equal(actual.staleCount, 1);

    const reconcilePlan = planProtectionReconcile({ desired, actual });
    assert.equal(reconcilePlan.action, "REPLACE_STALE_PROTECTION");
    assert.equal(reconcilePlan.needCancelStale, true);
    pass("CASE_I_PARTIAL_REDUCE_SIZE_CHANGE_TRIGGERS_REPLACE", { action: reconcilePlan.action, staleCount: actual.staleCount });
}

// -------------------------------------------------------------------------------------------------
// CASE J: OKX SL filled + position flat -> TERMINAL_NO_PROTECTION_REQUIRED, no recreation
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 0,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 0, // Flat!
        authoritativeFetchReady: true,
        pendingAlgos: [],
        desiredPlan: desired
    });

    const reconcilePlan = planProtectionReconcile({ desired, actual, isFlatOrTerminal: true });
    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan,
        isFlatOrTerminal: true
    });

    assert.equal(finalAuth.state, "TERMINAL_NO_PROTECTION_REQUIRED");
    assert.equal(reconcilePlan.action, "NOOP");
    assert.equal(reconcilePlan.needSubmitOco, false);
    pass("CASE_J_TERMINAL_POSITION_NO_RECREATION", { state: finalAuth.state, action: reconcilePlan.action });
}

// -------------------------------------------------------------------------------------------------
// CASE K: OKX TP filled + position flat -> TERMINAL_NO_PROTECTION_REQUIRED
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 0,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 0,
        authoritativeFetchReady: true,
        pendingAlgos: [],
        desiredPlan: desired
    });

    const reconcilePlan = planProtectionReconcile({ desired, actual, isFlatOrTerminal: true });
    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan,
        isFlatOrTerminal: true
    });

    assert.equal(finalAuth.state, "TERMINAL_NO_PROTECTION_REQUIRED");
    pass("CASE_K_TP_FILLED_TERMINAL_NO_RECREATION", { state: finalAuth.state });
}

// -------------------------------------------------------------------------------------------------
// CASE L: Manual TP-like order only -> not canonical bot TP
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    // Manual order without algoId or non-reduce-only
    const algos: ProtectiveAlgoRow[] = [
        {
            algoId: "",
            sz: 10,
            tpTriggerPx: 76000,
            reduceOnly: false
        }
    ];

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: algos,
        desiredPlan: desired
    });

    assert.equal(actual.actualTpPresent, false);
    pass("CASE_L_MANUAL_ORDER_NOT_BOT_CANONICAL_TP", { actualTpPresent: actual.actualTpPresent });
}

// -------------------------------------------------------------------------------------------------
// CASE M: Atomic OCO Rebuild Succeeds -> PROTECTED
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    // Fresh fetch after rebuild
    const algosPostRebuild: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_oco_rebuilt_new",
            instId: "BTC-USDT-SWAP",
            ordType: "oco",
            sz: 10,
            slTriggerPx: 77500,
            tpTriggerPx: 76000,
            reduceOnly: true,
            side: "buy",
            posSide: "net"
        }
    ];

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: algosPostRebuild,
        desiredPlan: desired
    });

    const reconcilePlan = planProtectionReconcile({ desired, actual });
    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan
    });

    assert.equal(finalAuth.state, "PROTECTED");
    assert.equal(finalAuth.protectionComplete, true);
    pass("CASE_M_REBUILD_SUCCESS_YIELDS_PROTECTED", { state: finalAuth.state, protectionComplete: finalAuth.protectionComplete });
}

// -------------------------------------------------------------------------------------------------
// CASE N: OCO rebuild fails, restore SL succeeds -> TP still missing -> REPAIR_REQUIRED
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    // Restored SL only
    const algosRestored: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_sl_restored",
            instId: "BTC-USDT-SWAP",
            ordType: "conditional",
            sz: 10,
            slTriggerPx: 77500,
            reduceOnly: true,
            side: "buy",
            posSide: "net"
        }
    ];

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: algosRestored,
        desiredPlan: desired
    });

    const reconcilePlan = planProtectionReconcile({ desired, actual });
    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan
    });

    assert.equal(finalAuth.state, "REPAIR_REQUIRED");
    assert.equal(finalAuth.protectionComplete, false);
    pass("CASE_N_RESTORED_SL_STILL_REPAIR_REQUIRED_WHEN_TP_MISSING", { state: finalAuth.state, protectionComplete: finalAuth.protectionComplete });
}

// -------------------------------------------------------------------------------------------------
// CASE O: OCO rebuild + restore both fail -> HARD_BLOCKED
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77500,
        tpPrice: 76000
    });

    const reconcilePlan = {
        action: "HARD_BLOCK" as const,
        reason: "REBUILD_AND_RESTORE_BOTH_FAILED",
        needSubmitOco: false,
        needSubmitSl: false,
        needSubmitTp: false,
        needCancelStale: false,
        needRebuildSlOnly: false,
        hardBlocked: true
    };

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: [],
        desiredPlan: desired
    });

    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan
    });

    assert.equal(finalAuth.state, "HARD_BLOCKED");
    assert.equal(finalAuth.hardBlocked, true);
    pass("CASE_O_TOTAL_FAILURE_HARD_BLOCKED", { state: finalAuth.state, hardBlocked: finalAuth.hardBlocked });
}

// -------------------------------------------------------------------------------------------------
// SECTION 2: ACTUAL RUNTIME REPLAY (BTC Short 77049.9, 51088 Conflict)
// -------------------------------------------------------------------------------------------------
{
    const desired = resolveDesiredProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        contracts: 10,
        regime: "TREND",
        slPrice: 77293.9,
        tpPrice: 76857.27
    });

    // Actual runtime observed: exchange SL exists, exchange TP null, 51088 conflict
    const algosObserved: ProtectiveAlgoRow[] = [
        {
            algoId: "algo_exchange_sl_77293",
            instId: "BTC-USDT-SWAP",
            ordType: "conditional",
            sz: 10,
            slTriggerPx: 77293.9,
            reduceOnly: true,
            side: "buy",
            posSide: "net"
        }
    ];

    const actual = resolveExchangeProtectionTruth({
        symbol: "BTCUSDT",
        instId: "BTC-USDT-SWAP",
        side: "short",
        actualContracts: 10,
        authoritativeFetchReady: true,
        pendingAlgos: algosObserved,
        desiredPlan: desired
    });

    assert.equal(actual.actualSlPresent, true);
    assert.equal(actual.actualSlPrice, 77293.9);
    assert.equal(actual.actualTpPresent, false);
    assert.equal(actual.protectionComplete, false);

    const reconcilePlan = planProtectionReconcile({ desired, actual, has51088Error: true });
    assert.equal(reconcilePlan.action, "REBUILD_SL_ONLY_TO_OCO");

    const finalAuth = resolveFinalProtectionAuthority({
        symbol: "BTCUSDT",
        side: "short",
        desired,
        actual,
        reconcilePlan
    });

    assert.equal(finalAuth.state, "REPAIR_REQUIRED");
    assert.equal(finalAuth.protectionComplete, false);

    const proof = buildFinalProtectionAuthorityProof(finalAuth);
    assert.equal(proof.event, "V2_FINAL_PROTECTION_AUTHORITY_PROOF");
    assert.equal(proof.actualSlPresent, true);
    assert.equal(proof.actualTpPresent, false);
    assert.equal(proof.reconcileAction, "REBUILD_SL_ONLY_TO_OCO");
    pass("REPLAY_ACTUAL_BTC_51088_RUNTIME_RECONCILE", { proof });
}

console.log("=== ALL PHASE E PROTECTION AUTHORITY CONSOLIDATION & GOLDEN REPLAY TESTS PASSED ===");
