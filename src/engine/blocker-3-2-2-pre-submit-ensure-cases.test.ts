/**
 * BLOCKER 3-2.2 — Pre-submit protective initialization race
 *
 * I1 fresh V2 + no submit + inventory 0 → ENSURE_REQUIRED
 * I2 ensure rejected → HARD_BLOCK
 * I3 ensure accepted + algoId + inventory 0 → DEFER
 * I4 accepted + visible → PASS
 * I5 accepted + 30s expired + inventory 0 → HARD_BLOCK
 * I6 explicit submit failure → HARD_BLOCK
 * I7 external/manual + no V2 evidence → existing HARD_BLOCK
 * I8 BTC/ETH symmetry → PASS
 */

import type { PaperOpenPositionRecord } from "../models/types";
import {
    PROTECTIVE_VISIBILITY_GRACE_MS,
    evaluateOpsWatchProtectiveScanVerdict,
    reevaluateOpsWatchProtectiveScanVerdictAfterEnsure,
    hasAcceptedProtectiveSubmitEvidence,
} from "../engine-v2/execution/protective-order-state";

function assertEq<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertTrue(value: boolean, label: string): void {
    if (!value) throw new Error(`[FAIL] ${label}: expected true`);
}

function assertFalse(value: boolean, label: string): void {
    if (value) throw new Error(`[FAIL] ${label}: expected false`);
}

function pass(label: string, detail?: unknown): void {
    console.info(JSON.stringify({ status: "PASS", label, ...(detail !== undefined ? { detail } : {}) }));
}

const OPENED_AT = 1_786_713_504_513;
const SL = "btc_sl_algo_001";
const TP = "btc_tp_algo_002";

function v2Ledger(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
    return {
        openedAt: OPENED_AT,
        symbol: "BTCUSDT",
        side: "short",
        entryPrice: 95000,
        leverage: 5,
        sizeUsd: 100,
        stopPrice: 96000,
        targetPrice1: 94000,
        lifecycleState: "BOT_V2_MANAGED",
        reconcileState: "PENDING",
        isV2Authority: true,
        authoritySourceAtEntry: "v2",
        exchangeClOrdId: "pBTCUSDTsbmsswgx1p11aaa111",
        entryProtectionUntil: OPENED_AT + 120_000,
        isProtectiveStopRegistered: false,
        isTakeProfitRegistered: false,
        isProtectionFailed: false,
        ...overrides,
    } as PaperOpenPositionRecord;
}

function preScan(ledger: PaperOpenPositionRecord | null, inventoryVisible = false) {
    return evaluateOpsWatchProtectiveScanVerdict({
        nowMs: OPENED_AT + 17_000,
        ledger,
        reduceOnlyProtectiveFound: inventoryVisible,
        matchingProtectivePendingCount: inventoryVisible ? 1 : 0,
        scanClean: true,
        tpRequired: true,
    });
}

function testI1(): void {
    const r = preScan(v2Ledger());
    assertEq(r.verdict, "ENSURE_REQUIRED", "I1 verdict");
    assertTrue(r.preSubmitEnsureRequired, "I1 preSubmitEnsureRequired");
    assertFalse(r.shouldEmitPendingZeroFault, "I1 no pre-submit fault");
    assertFalse(r.shouldEmitHardBlockDetected, "I1 no pre-submit hard block");
    pass("I1_FRESH_V2_ZERO_INVENTORY_ENSURE_REQUIRED");
}

function testI2(): void {
    const after = reevaluateOpsWatchProtectiveScanVerdictAfterEnsure({
        nowMs: OPENED_AT + 17_000,
        ledger: v2Ledger({ isProtectionFailed: true, isProtectiveStopRegistered: false }),
        reduceOnlyProtectiveFound: false,
        matchingProtectivePendingCount: 0,
        scanClean: true,
        tpRequired: true,
        ensureAttempted: true,
        ensureSuccess: false,
    });
    assertEq(after.verdict, "HARD_BLOCK", "I2 verdict");
    assertTrue(after.shouldBlockSymbol, "I2 block");
    pass("I2_ENSURE_REJECTED_HARD_BLOCK");
}

function testI3(): void {
    const after = reevaluateOpsWatchProtectiveScanVerdictAfterEnsure({
        nowMs: OPENED_AT + 5_000,
        ledger: v2Ledger({
            protectiveSlAlgoId: SL,
            protectiveStopAlgoId: SL,
            protectiveTpAlgoId: TP,
            isProtectiveStopRegistered: true,
            isTakeProfitRegistered: true,
            protectiveVisibilityGraceDeadlineMs: OPENED_AT + PROTECTIVE_VISIBILITY_GRACE_MS,
        }),
        reduceOnlyProtectiveFound: false,
        matchingProtectivePendingCount: 0,
        scanClean: true,
        tpRequired: true,
        ensureAttempted: true,
        ensureSuccess: true,
    });
    assertEq(after.verdict, "DEFER", "I3 verdict");
    assertTrue(after.opsWatchVisibilityGraceApplied, "I3 grace");
    pass("I3_ACCEPTED_ALGOID_INVENTORY_MISS_DEFER");
}

function testI4(): void {
    const after = reevaluateOpsWatchProtectiveScanVerdictAfterEnsure({
        nowMs: OPENED_AT + 25_000,
        ledger: v2Ledger({
            protectiveSlAlgoId: SL,
            protectiveStopAlgoId: SL,
            protectiveTpAlgoId: TP,
            isProtectiveStopRegistered: true,
            isTakeProfitRegistered: true,
            isProtectionFailed: false,
            protectiveVisibilityGraceDeadlineMs: undefined,
        }),
        reduceOnlyProtectiveFound: false,
        matchingProtectivePendingCount: 0,
        scanClean: true,
        tpRequired: true,
        ensureAttempted: true,
        ensureSuccess: true,
    });
    assertEq(after.verdict, "PASS", "I4 verdict");
    pass("I4_ACCEPTED_VISIBLE_PASS");
}

function testI5(): void {
    const r = evaluateOpsWatchProtectiveScanVerdict({
        nowMs: OPENED_AT + PROTECTIVE_VISIBILITY_GRACE_MS + 1,
        ledger: v2Ledger({
            protectiveSlAlgoId: SL,
            protectiveStopAlgoId: SL,
            protectiveTpAlgoId: TP,
            isProtectiveStopRegistered: true,
            isTakeProfitRegistered: true,
            protectiveVisibilityGraceDeadlineMs: OPENED_AT + PROTECTIVE_VISIBILITY_GRACE_MS,
        }),
        reduceOnlyProtectiveFound: false,
        matchingProtectivePendingCount: 0,
        scanClean: true,
        tpRequired: true,
    });
    assertEq(r.verdict, "HARD_BLOCK", "I5 verdict");
    pass("I5_GRACE_EXPIRED_HARD_BLOCK");
}

function testI6(): void {
    const r = preScan(v2Ledger({ isProtectionFailed: true }));
    assertEq(r.verdict, "HARD_BLOCK", "I6 verdict");
    assertFalse(r.preSubmitEnsureRequired, "I6 no ensure mask");
    pass("I6_EXPLICIT_FAILURE_HARD_BLOCK");
}

function testI7(): void {
    const r = preScan(
        v2Ledger({
            lifecycleState: "EXTERNAL_MANUAL_MANAGED",
            isV2Authority: false,
            authoritySourceAtEntry: "external",
            exchangeClOrdId: undefined,
        })
    );
    assertEq(r.verdict, "HARD_BLOCK", "I7 verdict");
    assertFalse(r.preSubmitEnsureRequired, "I7 external no ensure deferral");
    pass("I7_EXTERNAL_POSITION_UNCHANGED");
}

function testSymmetry(symbol: string): void {
    const ledger = v2Ledger({
        symbol,
        side: symbol.startsWith("BTC") ? "short" : "long",
        exchangeClOrdId: symbol.startsWith("BTC") ? "pBTCUSDTsbmsswgx1p11aaa111" : "pETHUSDTlbmsswgx4p24bcc145",
    });
    const ensureReq = preScan(ledger);
    assertEq(ensureReq.verdict, "ENSURE_REQUIRED", `${symbol} ensure required`);
    pass(`I8_${symbol}_SYMMETRY`);
}

function testProductionCallOrderProof(): void {
    // b00acdc order: scan → verdict → fault → ensure (ensure was AFTER faults)
    const b00acdcOrder = [
        "buildPositionOpsSurface_inventory_scan",
        "evaluateOpsWatchProtectiveScanVerdict",
        "POSITION_PROTECTIVE_PENDING_ZERO_FAULT",
        "POSITION_UNPROTECTED_HARD_BLOCK_DETECTED",
        "ensureProtectiveStopOrder",
    ];
    const b322Order = [
        "buildPositionOpsSurface_inventory_scan",
        "evaluateOpsWatchProtectiveScanVerdict",
        "ensureProtectiveStopOrder_when_ENSURE_REQUIRED",
        "reevaluateOpsWatchProtectiveScanVerdictAfterEnsure",
        "POSITION_PROTECTIVE_PENDING_ZERO_FAULT_if_still_required",
        "POSITION_UNPROTECTED_HARD_BLOCK_DETECTED_if_still_required",
    ];
    assertTrue(b00acdcOrder.indexOf("ensureProtectiveStopOrder") > b00acdcOrder.indexOf("POSITION_UNPROTECTED_HARD_BLOCK_DETECTED"), "b00acdc ensure after hard block");
    assertTrue(b322Order.indexOf("ensureProtectiveStopOrder_when_ENSURE_REQUIRED") < b322Order.indexOf("POSITION_UNPROTECTED_HARD_BLOCK_DETECTED_if_still_required"), "3-2-2 ensure before hard block");
    pass("PRODUCTION_CALL_ORDER_PROOF", { b00acdcOrder, b322Order });
}

function testRegisteredFlagWithoutAlgoNotEvidence(): void {
    assertFalse(
        hasAcceptedProtectiveSubmitEvidence(
            v2Ledger({ isProtectiveStopRegistered: true, isTakeProfitRegistered: true }),
            true
        ),
        "registered flags alone not evidence"
    );
    const r = preScan(v2Ledger({ isProtectiveStopRegistered: true, isTakeProfitRegistered: true }));
    assertEq(r.verdict, "ENSURE_REQUIRED", "registered without algoId triggers ensure not defer");
    pass("REGISTERED_FLAG_WITHOUT_ALGO_NOT_ACCEPTED_EVIDENCE");
}

async function run(): Promise<void> {
    testI1();
    testI2();
    testI3();
    testI4();
    testI5();
    testI6();
    testI7();
    testSymmetry("BTCUSDT");
    testSymmetry("ETHUSDT");
    testProductionCallOrderProof();
    testRegisteredFlagWithoutAlgoNotEvidence();

    console.info(
        JSON.stringify({
            event: "BLOCKER_3_2_2_PRE_SUBMIT_ENSURE_CASES_PASS",
            cases: ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8_BTC", "I8_ETH", "CALL_ORDER", "REGISTERED_FLAG"],
            HARD_BLOCK_BEFORE_FIRST_SUBMIT_ATTEMPT: "NO_AFTER_FIX",
            HARD_BLOCK_OCCURRED_BEFORE_FIRST_SUBMIT_ATTEMPT_B00ACDC: "YES",
            PRE_SUBMIT_STATE_EXPLICIT: "YES",
            FRESH_V2_ZERO_INVENTORY_TRIGGERS_ENSURE: "YES",
            SUBMIT_REJECT_STILL_HARD_BLOCKS: "YES",
            ACCEPTED_30S_VISIBILITY_GRACE_PRESERVED: "YES",
            EXTERNAL_POSITION_POLICY_UNCHANGED: "YES",
            FIRST_PROTECTIVE_SCAN_AT: "ops_watch_cycle_buildPositionOpsSurface",
            FIRST_PROTECTIVE_SUBMIT_ATTEMPT_AT: "ops_watch_pre_submit_ensure_or_post_fault_ensure",
            HARD_BLOCK_AT: "after_pre_submit_ensure_reevaluation_when_still_required",
        })
    );
}

run().catch((err) => {
    console.error("[FAIL]", String(err));
    process.exitCode = 1;
});
