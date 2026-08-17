/**
 * BLOCKER 4-16 — Protective pre-scan false-negative authority mismatch
 *
 * Case 1: Pre-scan 0 + Authoritative OCO found → NO hard block
 * Case 2: Pre-scan missing + Authoritative KEEP → NO hard block
 * Case 3: Pre-scan missing + Authoritative submit success → NO persistent hard block
 * Case 4: Pre-scan missing + Authoritative ensure failure → HARD BLOCK
 * Case 5: Actual zero protective orders on exchange & ensure fails → HARD BLOCK
 * Case 6: OCO single algoId satisfies both SL/TP (hasAcceptedProtectiveSubmitEvidence & classifyOkxOpenOrderPurpose)
 */

import type { PaperOpenPositionRecord } from "../models/types";
import {
    evaluateOpsWatchProtectiveScanVerdict,
    reevaluateOpsWatchProtectiveScanVerdictAfterEnsure,
    hasAcceptedProtectiveSubmitEvidence,
    evaluatePositionProtectionState
} from "../engine-v2/execution/protective-order-state";
import {
    classifyOkxOpenOrderPurpose,
    findProtectiveHintsForInst
} from "./position-ops-monitor";
import {
    planProtectiveOrderReconcile,
    type ProtectiveReconcileContext,
    type ProtectiveAlgoRow
} from "../engine-v2/execution/protective-reconcile-plan";

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

const NOW = 1_786_713_504_000;

function createTestPosition(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
    return {
        openedAt: NOW - 60_000,
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        leverage: 5,
        sizeUsd: 1000,
        okxContracts: 2.18,
        stopPrice: 94000,
        targetPrice1: 96500,
        lifecycleState: "BOT_V2_MANAGED",
        reconcileState: "MATCHED",
        isV2Authority: true,
        authoritySourceAtEntry: "v2",
        exchangeClOrdId: "pBTCUSDTlbmsswgx1p11aaa111",
        isProtectiveStopRegistered: true,
        isTakeProfitRegistered: true,
        isProtectionFailed: false,
        protectiveStopAlgoId: "oco_algo_999",
        protectiveSlAlgoId: "oco_algo_999",
        protectiveTpAlgoId: "oco_algo_999",
        ...overrides
    } as PaperOpenPositionRecord;
}

// Case 1: Pre-scan 0 + authoritative OCO found → NO hard block
function testCase1_PreScanZero_AuthoritativeOcoFound(): void {
    const pos = createTestPosition();
    // Pre-scan sees empty array (e.g. shallow general pending scan didn't return OCO)
    const preScanVerdict = evaluateOpsWatchProtectiveScanVerdict({
        nowMs: NOW,
        ledger: pos,
        reduceOnlyProtectiveFound: false,
        matchingProtectivePendingCount: 0,
        scanClean: true,
        tpRequired: true
    });

    // Authoritative ensure finds the OCO order via getOrdersAlgoPendingAll
    const ocoRow: ProtectiveAlgoRow = {
        algoId: "oco_algo_999",
        instId: "BTC-USDT-SWAP",
        posSide: "long",
        side: "sell",
        tdMode: "cross",
        ordType: "oco",
        slTriggerPx: "94000",
        tpTriggerPx: "96500",
        sz: "2.18",
        reduceOnly: "true",
        state: "live"
    };
    const reconcileCtx: ProtectiveReconcileContext = {
        instId: "BTC-USDT-SWAP",
        positionSide: "long",
        openedAt36: "111aaa",
        tdModeUsed: "cross",
        contractsToProtect: 2.18,
        activeStopPrice: 94000,
        activeTpPrice: 96500,
        wantsTp: true,
        expectedSide: "sell",
        tickSz: 0.1
    };
    const plan = planProtectiveOrderReconcile([ocoRow], reconcileCtx);
    assertTrue(plan.canonicalSl != null, "Case 1 canonicalSl is kept");
    assertTrue(plan.canonicalTp != null, "Case 1 canonicalTp is kept");
    assertFalse(plan.needSubmitSl, "Case 1 no need to submit SL");
    assertFalse(plan.needSubmitTp, "Case 1 no need to submit TP");
    assertFalse(plan.submitOco, "Case 1 no need to submit OCO");

    // Reevaluate after authoritative ensure
    const postEnsureVerdict = reevaluateOpsWatchProtectiveScanVerdictAfterEnsure({
        nowMs: NOW,
        ledger: pos,
        reduceOnlyProtectiveFound: true, // overridden by authoritative ensure
        matchingProtectivePendingCount: 1,
        scanClean: true,
        tpRequired: true,
        ensureAttempted: true,
        ensureSuccess: true
    });
    assertEq(postEnsureVerdict.verdict, "PASS", "Case 1 post-ensure verdict PASS");
    assertFalse(postEnsureVerdict.shouldBlockSymbol, "Case 1 NO hard block");
    assertFalse(postEnsureVerdict.shouldEmitOrderFault, "Case 1 NO order fault");
    assertFalse(postEnsureVerdict.shouldEmitHardBlockDetected, "Case 1 NO hard block detected");

    pass("CASE_1_PRE_SCAN_0_AUTHORITATIVE_OCO_FOUND_NO_HARD_BLOCK");
}

// Case 2: Pre-scan missing + authoritative KEEP → NO hard block
function testCase2_PreScanMissing_AuthoritativeKeep(): void {
    const pos = createTestPosition({
        isProtectiveStopRegistered: true,
        isTakeProfitRegistered: true,
        protectiveSlAlgoId: "sl_algo_100",
        protectiveTpAlgoId: "tp_algo_200"
    });

    const postEnsureVerdict = reevaluateOpsWatchProtectiveScanVerdictAfterEnsure({
        nowMs: NOW,
        ledger: pos,
        reduceOnlyProtectiveFound: true, // overridden when authoritative ensure says KEEP
        matchingProtectivePendingCount: 1,
        scanClean: true,
        tpRequired: true,
        ensureAttempted: true,
        ensureSuccess: true
    });
    assertEq(postEnsureVerdict.verdict, "PASS", "Case 2 post-ensure verdict PASS");
    assertFalse(postEnsureVerdict.shouldBlockSymbol, "Case 2 NO hard block");

    pass("CASE_2_PRE_SCAN_MISSING_AUTHORITATIVE_KEEP_NO_HARD_BLOCK");
}

// Case 3: Pre-scan missing + authoritative submit success → NO persistent hard block
function testCase3_PreScanMissing_AuthoritativeSubmitSuccess(): void {
    const pos = createTestPosition({
        isProtectiveStopRegistered: false,
        isTakeProfitRegistered: false,
        protectiveSlAlgoId: undefined,
        protectiveTpAlgoId: undefined
    });

    // Fresh position triggered ensure and successfully submitted new protective orders
    const updatedPos = {
        ...pos,
        isProtectiveStopRegistered: true,
        isTakeProfitRegistered: true,
        protectiveSlAlgoId: "new_sl_algo_111",
        protectiveTpAlgoId: "new_tp_algo_222",
        protectiveVisibilityGraceDeadlineMs: NOW + 30_000
    };

    const postEnsureVerdict = reevaluateOpsWatchProtectiveScanVerdictAfterEnsure({
        nowMs: NOW,
        ledger: updatedPos,
        reduceOnlyProtectiveFound: true,
        matchingProtectivePendingCount: 0,
        scanClean: true,
        tpRequired: true,
        ensureAttempted: true,
        ensureSuccess: true
    });
    assertEq(postEnsureVerdict.verdict, "PASS", "Case 3 post-ensure verdict PASS");
    assertFalse(postEnsureVerdict.shouldBlockSymbol, "Case 3 NO hard block");

    pass("CASE_3_PRE_SCAN_MISSING_AUTHORITATIVE_SUBMIT_SUCCESS_NO_HARD_BLOCK");
}

// Case 4: Pre-scan missing + authoritative ensure failure → HARD BLOCK
function testCase4_PreScanMissing_AuthoritativeEnsureFailure(): void {
    const pos = createTestPosition({
        isProtectionFailed: true,
        isProtectiveStopRegistered: false,
        isTakeProfitRegistered: false,
        protectiveSlAlgoId: undefined,
        protectiveTpAlgoId: undefined
    });

    const postEnsureVerdict = reevaluateOpsWatchProtectiveScanVerdictAfterEnsure({
        nowMs: NOW,
        ledger: pos,
        reduceOnlyProtectiveFound: false,
        matchingProtectivePendingCount: 0,
        scanClean: true,
        tpRequired: true,
        ensureAttempted: true,
        ensureSuccess: false
    });
    assertEq(postEnsureVerdict.verdict, "HARD_BLOCK", "Case 4 verdict HARD_BLOCK");
    assertTrue(postEnsureVerdict.shouldBlockSymbol, "Case 4 shouldBlockSymbol true");
    assertTrue(postEnsureVerdict.shouldEmitOrderFault, "Case 4 shouldEmitOrderFault true");
    assertTrue(postEnsureVerdict.shouldEmitHardBlockDetected, "Case 4 shouldEmitHardBlockDetected true");

    pass("CASE_4_PRE_SCAN_MISSING_AUTHORITATIVE_ENSURE_FAILURE_HARD_BLOCK");
}

// Case 5: Actual zero protective orders on exchange & ensure fails → HARD BLOCK
function testCase5_ActualZeroProtectiveOrders_HardBlock(): void {
    const pos = createTestPosition({
        isProtectionFailed: true,
        isProtectiveStopRegistered: false,
        isTakeProfitRegistered: false,
        protectiveSlAlgoId: undefined,
        protectiveTpAlgoId: undefined
    });

    // Zero protective orders in exchange inventory
    const protectionState = evaluatePositionProtectionState({
        instId: "BTC-USDT-SWAP",
        positionSide: "long",
        pending: [],
        algos: [],
        tpRequired: true,
        ledger: pos,
        requiredStopPx: 94000,
        requiredContracts: 2.18
    });
    assertFalse(protectionState.reduceOnlyProtectiveFound, "Case 5 zero protective orders found");
    assertEq(protectionState.consistencyCheck, "FAIL", "Case 5 consistency check FAIL");
    assertTrue(protectionState.preScanFault, "Case 5 preScanFault true");

    const postEnsureVerdict = reevaluateOpsWatchProtectiveScanVerdictAfterEnsure({
        nowMs: NOW,
        ledger: pos,
        reduceOnlyProtectiveFound: false,
        matchingProtectivePendingCount: 0,
        scanClean: true,
        tpRequired: true,
        ensureAttempted: true,
        ensureSuccess: false
    });
    assertEq(postEnsureVerdict.verdict, "HARD_BLOCK", "Case 5 HARD_BLOCK confirmed");
    assertTrue(postEnsureVerdict.shouldBlockSymbol, "Case 5 block symbol");

    pass("CASE_5_ACTUAL_ZERO_PROTECTIVE_ORDERS_HARD_BLOCK");
}

// Case 6: OCO single algoId satisfies both SL/TP
function testCase6_OcoSingleAlgoId_SatisfiesBothSlAndTp(): void {
    // 6A: Single algoId stored in protectiveSlAlgoId + protectiveStopAlgoId with isTakeProfitRegistered
    const ocoLedger = createTestPosition({
        protectiveStopAlgoId: "oco_algo_12345",
        protectiveSlAlgoId: "oco_algo_12345",
        protectiveTpAlgoId: undefined,
        isProtectiveStopRegistered: true,
        isTakeProfitRegistered: true
    });
    const hasEvidence = hasAcceptedProtectiveSubmitEvidence(ocoLedger, true);
    assertTrue(hasEvidence, "Case 6A OCO single algoId with isTakeProfitRegistered satisfies evidence");

    // 6B: Classify OKX open order purpose with OCO shape (has both tpTriggerPx and slTriggerPx)
    const ocoOrderRow = {
        instId: "BTC-USDT-SWAP",
        posSide: "long",
        side: "sell",
        ordType: "oco",
        slTriggerPx: "94000",
        tpTriggerPx: "96500",
        reduceOnly: "true",
        algoId: "oco_algo_12345"
    };
    const classified = classifyOkxOpenOrderPurpose(ocoOrderRow, ocoLedger);
    assertTrue(classified.isBotManagedProtection, "Case 6B OCO order classified as bot-managed protection");

    // 6C: findProtectiveHintsForInst on single OCO order satisfies full protection
    const hints = findProtectiveHintsForInst("BTC-USDT-SWAP", "long", [], [ocoOrderRow], true, {
        ledger: ocoLedger,
        requiredStopPx: 94000,
        requiredContracts: 2.18,
        tickSz: 0.1
    });
    assertTrue(hints.protectionSatisfied, "Case 6C findProtectiveHintsForInst satisfies protection");
    assertEq(hints.slPrice, 94000, "Case 6C slPrice extracted");
    assertEq(hints.tpPrice, 96500, "Case 6C tpPrice extracted");

    pass("CASE_6_OCO_SINGLE_ALGOID_SATISFIES_BOTH_SL_AND_TP");
}

function runAllTests(): void {
    console.log("=== RUNNING BLOCKER 4-16 REGRESSION TESTS ===");
    testCase1_PreScanZero_AuthoritativeOcoFound();
    testCase2_PreScanMissing_AuthoritativeKeep();
    testCase3_PreScanMissing_AuthoritativeSubmitSuccess();
    testCase4_PreScanMissing_AuthoritativeEnsureFailure();
    testCase5_ActualZeroProtectiveOrders_HardBlock();
    testCase6_OcoSingleAlgoId_SatisfiesBothSlAndTp();
    console.log("=== ALL BLOCKER 4-16 REGRESSION TESTS PASSED ===");
}

runAllTests();
