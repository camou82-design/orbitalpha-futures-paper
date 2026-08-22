import assert from "node:assert/strict";
import {
    resolveFinalExitAuthority,
    buildFinalExitAuthorityProof,
    type FinalExitAuthorityContext
} from "../engine-v2/exit/final-exit-authority";
import { applyV2ExitAuthorityInvariants } from "../engine-v2/exit/exit-authority-invariant";

const NOW = 1771765000000;

function pass(name: string, detail?: unknown) {
    console.log(`[EXIT-EQUIVALENCE][${name}] PASS${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
}

console.log("=== STARTING PHASE D EXIT AUTHORITY CONSOLIDATION & GOLDEN REPLAY TESTS ===");

// -------------------------------------------------------------------------------------------------
// CASE A: TREND_HOLD_VALID -> HOLD, shouldExit=false
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        policyResult: {
            action: "HOLD",
            reason: "TREND_HOLD_VALID",
            shouldExit: false,
            shouldReduce: false
        }
    });

    assert.equal(res.action, "HOLD");
    assert.equal(res.shouldExit, false);
    assert.equal(res.shouldReduce, false);
    assert.equal(res.terminalReason, null);
    assert.equal(res.explicitTerminalEvidence, false);
    pass("CASE_A_TREND_HOLD_VALID", { action: res.action, shouldExit: res.shouldExit });
}

// -------------------------------------------------------------------------------------------------
// CASE B: WATCH reason -> WATCH, shouldExit=false
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "ETHUSDT",
        side: "long",
        policyResult: {
            action: "WATCH",
            reason: "TRANSITION_PROTECTIVE_WATCH",
            shouldExit: false,
            shouldReduce: false
        }
    });

    assert.equal(res.action, "WATCH");
    assert.equal(res.shouldExit, false);
    assert.equal(res.shouldReduce, false);
    assert.equal(res.terminalReason, null);
    pass("CASE_B_WATCH_REASON", { action: res.action, shouldExit: res.shouldExit });
}

// -------------------------------------------------------------------------------------------------
// CASE C: Generic finalDecision=EXIT with no explicit terminal reason -> HOLD fail-closed
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        policyResult: {
            action: "EXIT",
            reason: null, // No explicit terminal reason!
            shouldExit: true
        }
    });

    assert.equal(res.action, "HOLD");
    assert.equal(res.shouldExit, false);
    assert.equal(res.terminalReason, null);
    assert.equal(res.explicitTerminalEvidence, false);
    pass("CASE_C_GENERIC_EXIT_NO_REASON_FAILS_CLOSED_TO_HOLD", { action: res.action, shouldExit: res.shouldExit });
}

// -------------------------------------------------------------------------------------------------
// CASE D: V2_EXIT_INVALIDATION, explicit terminal evidence -> FULL_EXIT
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        policyResult: {
            action: "FULL_EXIT",
            reason: "V2_EXIT_INVALIDATION",
            shouldExit: true
        }
    });

    assert.equal(res.action, "FULL_EXIT");
    assert.equal(res.shouldExit, true);
    assert.equal(res.shouldReduce, false);
    assert.equal(res.terminalReason, "V2_EXIT_INVALIDATION");
    assert.equal(res.authoritySource, "V2_POLICY");
    assert.equal(res.explicitTerminalEvidence, true);
    pass("CASE_D_INVALIDATION_FULL_EXIT", { action: res.action, terminalReason: res.terminalReason });
}

// -------------------------------------------------------------------------------------------------
// CASE E: RANGE_FULL_EXIT_BOX_BREAK -> FULL_EXIT
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "ETHUSDT",
        side: "long",
        policyResult: {
            action: "FULL_EXIT",
            reason: "RANGE_FULL_EXIT_BOX_BREAK",
            shouldExit: true
        }
    });

    assert.equal(res.action, "FULL_EXIT");
    assert.equal(res.shouldExit, true);
    assert.equal(res.terminalReason, "RANGE_FULL_EXIT_BOX_BREAK");
    assert.equal(res.explicitTerminalEvidence, true);
    pass("CASE_E_BOX_BREAK_FULL_EXIT", { action: res.action, terminalReason: res.terminalReason });
}

// -------------------------------------------------------------------------------------------------
// CASE F: PNL_STOP_PROTECT -> FULL_EXIT (Source: RISK)
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "long",
        riskResult: {
            action: "FULL_EXIT",
            reason: "PNL_STOP_PROTECT",
            shouldExit: true
        }
    });

    assert.equal(res.action, "FULL_EXIT");
    assert.equal(res.shouldExit, true);
    assert.equal(res.terminalReason, "PNL_STOP_PROTECT");
    assert.equal(res.authoritySource, "RISK");
    assert.equal(res.explicitTerminalEvidence, true);
    pass("CASE_F_PNL_STOP_PROTECT_RISK_EXIT", { action: res.action, authoritySource: res.authoritySource });
}

// -------------------------------------------------------------------------------------------------
// CASE G: TRANSITION_REDUCE_ON_CONFLICT -> PARTIAL_REDUCE, shouldExit=false, shouldReduce=true
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        policyResult: {
            action: "REDUCE",
            reason: "TRANSITION_REDUCE_ON_CONFLICT",
            shouldReduce: true,
            shouldExit: false,
            reduceRatio: 0.5
        }
    });

    assert.equal(res.action, "PARTIAL_REDUCE");
    assert.equal(res.shouldExit, false);
    assert.equal(res.shouldReduce, true);
    assert.equal(res.reduceReason, "TRANSITION_REDUCE_ON_CONFLICT");
    assert.equal(res.reduceRatio, 0.5);
    assert.equal(res.terminalReason, null);
    pass("CASE_G_PARTIAL_REDUCE_SEPARATION", { action: res.action, shouldReduce: res.shouldReduce, shouldExit: res.shouldExit });
}

// -------------------------------------------------------------------------------------------------
// CASE H: OKX SL actually filled -> FULL_EXIT (Source: EXCHANGE_PROTECTIVE_FILL)
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        exchangeFillEvent: {
            filledType: "SL",
            fillReason: "OKX_ALGO_STOP_LOSS_FILLED"
        }
    });

    assert.equal(res.action, "FULL_EXIT");
    assert.equal(res.shouldExit, true);
    assert.equal(res.authoritySource, "EXCHANGE_PROTECTIVE_FILL");
    assert.equal(res.terminalReason, "OKX_ALGO_STOP_LOSS_FILLED");
    assert.equal(res.explicitTerminalEvidence, true);
    pass("CASE_H_OKX_SL_FILL_EXCHANGE_SOURCE", { action: res.action, authoritySource: res.authoritySource });
}

// -------------------------------------------------------------------------------------------------
// CASE I: OKX TP actually filled -> FULL_EXIT (Source: EXCHANGE_PROTECTIVE_FILL)
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        exchangeFillEvent: {
            filledType: "TP",
            fillReason: "OKX_ALGO_TAKE_PROFIT_FILLED"
        }
    });

    assert.equal(res.action, "FULL_EXIT");
    assert.equal(res.shouldExit, true);
    assert.equal(res.authoritySource, "EXCHANGE_PROTECTIVE_FILL");
    assert.equal(res.terminalReason, "OKX_ALGO_TAKE_PROFIT_FILLED");
    pass("CASE_I_OKX_TP_FILL_EXCHANGE_SOURCE", { action: res.action, authoritySource: res.authoritySource });
}

// -------------------------------------------------------------------------------------------------
// CASE J: Manual User Close -> FULL_EXIT (Source: MANUAL_EXTERNAL)
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        manualExternalEvent: {
            action: "MANUAL_CLOSE",
            reason: "USER_DASHBOARD_PANIC_CLOSE"
        }
    });

    assert.equal(res.action, "FULL_EXIT");
    assert.equal(res.shouldExit, true);
    assert.equal(res.authoritySource, "MANUAL_EXTERNAL");
    assert.equal(res.terminalReason, "USER_DASHBOARD_PANIC_CLOSE");
    pass("CASE_J_MANUAL_USER_CLOSE", { action: res.action, authoritySource: res.authoritySource });
}

// -------------------------------------------------------------------------------------------------
// CASE K: Stale prior reason=TREND_HOLD_VALID, new generic EXIT without explicit reason -> HOLD
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        policyResult: {
            action: "EXIT",
            reason: "TREND_HOLD_VALID", // Stale carry-forward reason!
            shouldExit: true
        }
    });

    assert.equal(res.action, "HOLD");
    assert.equal(res.shouldExit, false);
    assert.equal(res.terminalReason, null);
    pass("CASE_K_STALE_HOLD_REASON_CANNOT_AUTHORIZE_EXIT", { action: res.action, shouldExit: res.shouldExit });
}

// -------------------------------------------------------------------------------------------------
// CASE L: FULL_EXIT + null terminalReason -> Invariant Rejection -> HOLD
// -------------------------------------------------------------------------------------------------
{
    const res = resolveFinalExitAuthority({
        symbol: "BTCUSDT",
        side: "short",
        policyResult: {
            action: "FULL_EXIT",
            reason: "",
            shouldExit: true
        }
    });

    assert.equal(res.action, "HOLD");
    assert.equal(res.shouldExit, false);
    assert.equal(res.terminalReason, null);
    pass("CASE_L_EMPTY_TERMINAL_REASON_REJECTED", { action: res.action, shouldExit: res.shouldExit });
}

// -------------------------------------------------------------------------------------------------
// SECTION 2: ACTUAL ISSUE TRANSACTION REPLAY (BTC Short 77317.4 -> 77400.2)
// -------------------------------------------------------------------------------------------------
{
    // When policy produces TREND_HOLD_VALID, resolveFinalExitAuthority MUST NEVER produce FULL_EXIT
    const replayContext: FinalExitAuthorityContext = {
        symbol: "BTCUSDT",
        side: "short",
        positionCycleId: "cycle_btc_replay_p0",
        policyResult: {
            action: "HOLD",
            reason: "TREND_HOLD_VALID",
            shouldExit: false,
            shouldReduce: false
        }
    };

    const res = resolveFinalExitAuthority(replayContext);
    assert.equal(res.action, "HOLD");
    assert.equal(res.shouldExit, false);
    assert.equal(res.terminalReason, null);

    const proof = buildFinalExitAuthorityProof(res);
    assert.equal(proof.event, "V2_FINAL_EXIT_AUTHORITY_PROOF");
    assert.equal(proof.action, "HOLD");
    assert.equal(proof.shouldExit, false);
    pass("REPLAY_ACTUAL_ISSUE_TREND_HOLD_VALID_PRODUCES_NO_FULL_EXIT", { proof });
}

console.log("=== ALL PHASE D EXIT AUTHORITY CONSOLIDATION & GOLDEN REPLAY TESTS PASSED ===");
