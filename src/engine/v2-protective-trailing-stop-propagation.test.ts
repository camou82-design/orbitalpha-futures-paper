import {
  planProtectiveOrderReconcile,
  type ProtectiveReconcileContext,
  type ProtectiveAlgoRow
} from "../engine-v2/execution/protective-reconcile-plan";
import {
  buildProtectiveClOrdIdCandidates,
  isValidOkxAlgoClOrdId,
  buildOkxAlgoClOrdId,
  mergeProtectiveInventoryRows
} from "../engine-v2/execution/protective-inventory";
import {
  classifyOkxOpenOrderPurpose,
  resolvePendingOrdersExposure
} from "./position-ops-monitor";
import { evaluateOrderOwnership } from "../engine-v2/position/manual-takeover-authority";
import type { PaperOpenPositionRecord } from "../models/types";

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  if (!value) throw new Error(`${label}: expected true`);
}

function assertFalse(value: boolean, label: string): void {
  if (value) throw new Error(`${label}: expected false`);
}

function pass(name: string, detail?: unknown): void {
  console.info(JSON.stringify({ status: "PASS", test: name, ...(detail ? { detail } : {}) }));
}

// ---------------------------------------------------------------------------
// TEST 1: Short trailing stop 2497 -> 2475 updates required stop to 2475
// ---------------------------------------------------------------------------
function testShortTrailingStopPriceUpdate(): void {
  const openedAt = 1714000000000;
  const openedAt36 = openedAt.toString(36);
  const instId = "ETH-USDT-SWAP";
  
  // Existing exchange OCO with old stop 2497 and TP 2400
  const existingOco: ProtectiveAlgoRow = {
    algoId: "oco_algo_eth_1",
    algoClOrdId: `oapETHUSs${openedAt36}s`,
    instId,
    posSide: "short",
    side: "buy",
    reduceOnly: true,
    tdMode: "cross",
    ordType: "oco",
    sz: 10,
    slTriggerPx: "2497",
    tpTriggerPx: "2400"
  };

  // Reconcile context with new required stop 2475 and preserved TP 2400
  const ctxNewStop: ProtectiveReconcileContext = {
    instId,
    positionSide: "short",
    openedAt36,
    tdModeUsed: "cross",
    contractsToProtect: 10,
    activeStopPrice: 2475,
    activeTpPrice: 2400,
    wantsTp: true,
    expectedSide: "buy",
    tickSz: 0.01
  };

  const plan = planProtectiveOrderReconcile([existingOco], ctxNewStop);

  // Since exchange stop 2497 != required 2475, canonicalSl is null and replacement is required
  assertEq(plan.canonicalSl, null, "Existing 2497 OCO should not match required 2475 stop");
  assertTrue(plan.submitOco, "Must trigger new OCO submit for stop update");
  assertEq(plan.cancelAlgoIds.length, 0, "Old OCO must not be cancelled before replacement is live");

  pass("TEST_1_SHORT_TRAILING_STOP_RECONCILE_DETECTS_UPDATE", {
    requiredStop: ctxNewStop.activeStopPrice,
    exchangeStop: existingOco.slTriggerPx,
    submitOco: plan.submitOco
  });
}

// ---------------------------------------------------------------------------
// TEST 2: Atomic OCO replacement and TP preservation
// ---------------------------------------------------------------------------
function testAtomicOcoReplacementPreservesTp(): void {
  const openedAt = 1714000000000;
  const openedAt36 = openedAt.toString(36);
  const instId = "ETH-USDT-SWAP";
  
  const oldOcoAlgoId = "oco_algo_eth_old";
  const newOcoAlgoId = "oco_algo_eth_new";

  const oldOco: ProtectiveAlgoRow = {
    algoId: oldOcoAlgoId,
    algoClOrdId: `oapETHUSs${openedAt36}s`,
    instId,
    posSide: "short",
    side: "buy",
    reduceOnly: true,
    tdMode: "cross",
    ordType: "oco",
    sz: 10,
    slTriggerPx: "2497",
    tpTriggerPx: "2400"
  };

  const newOco: ProtectiveAlgoRow = {
    algoId: newOcoAlgoId,
    algoClOrdId: `oapETHUSs${openedAt36}r1s`,
    instId,
    posSide: "short",
    side: "buy",
    reduceOnly: true,
    tdMode: "cross",
    ordType: "oco",
    sz: 10,
    slTriggerPx: "2475",
    tpTriggerPx: "2400"
  };

  const ctx: ProtectiveReconcileContext = {
    instId,
    positionSide: "short",
    openedAt36,
    tdModeUsed: "cross",
    contractsToProtect: 10,
    activeStopPrice: 2475,
    activeTpPrice: 2400,
    wantsTp: true,
    expectedSide: "buy",
    tickSz: 0.01
  };

  // Post-submit rescan has both old and new OCOs in inventory
  const inventoryPostSubmit = [oldOco, newOco];
  const plan = planProtectiveOrderReconcile(inventoryPostSubmit, ctx);

  assertEq(plan.canonicalSl?.algoId, newOcoAlgoId, "New 2475 OCO must be adopted as canonical SL");
  assertEq(plan.canonicalTp?.algoId, newOcoAlgoId, "New 2400 TP leg must be adopted as canonical TP");
  assertEq(plan.submitOco, false, "No further OCO submit needed once new order is present");
  assertTrue(plan.cancelAlgoIds.includes(oldOcoAlgoId), "Old 2497 OCO must now be cancelled as duplicate/stale");

  pass("TEST_2_ATOMIC_OCO_REPLACEMENT_PRESERVES_TP", {
    canonicalSlAlgoId: plan.canonicalSl?.algoId,
    cancelledOldAlgoId: oldOcoAlgoId,
    tpPreserved: plan.canonicalTp != null
  });
}

// ---------------------------------------------------------------------------
// TEST 3: Fail-safe on replacement failure (No cancellation of existing protection)
// ---------------------------------------------------------------------------
function testFailSafeOnSubmitError(): void {
  const openedAt = 1714000000000;
  const openedAt36 = openedAt.toString(36);
  const instId = "ETH-USDT-SWAP";
  
  const existingOco: ProtectiveAlgoRow = {
    algoId: "oco_algo_eth_live",
    algoClOrdId: `oapETHUSs${openedAt36}s`,
    instId,
    posSide: "short",
    side: "buy",
    reduceOnly: true,
    tdMode: "cross",
    ordType: "oco",
    sz: 10,
    slTriggerPx: "2497",
    tpTriggerPx: "2400"
  };

  const ctx: ProtectiveReconcileContext = {
    instId,
    positionSide: "short",
    openedAt36,
    tdModeUsed: "cross",
    contractsToProtect: 10,
    activeStopPrice: 2475,
    activeTpPrice: 2400,
    wantsTp: true,
    expectedSide: "buy",
    tickSz: 0.01
  };

  const plan = planProtectiveOrderReconcile([existingOco], ctx);

  // Even though reconcile plan wants to submit replacement, cancelAlgoIds MUST NOT include the live protective order
  assertFalse(plan.cancelAlgoIds.includes("oco_algo_eth_live"), "Live OCO must remain intact when replacement is pending");

  pass("TEST_3_FAILSAFE_PRESERVES_EXISTING_PROTECTION_ON_REPLACE");
}

// ---------------------------------------------------------------------------
// TEST 4: Manual / Operator order protection (No mutation or cancellation)
// ---------------------------------------------------------------------------
function testOperatorOrderProtection(): void {
  const instId = "BTC-USDT-SWAP";
  
  const operatorOrder: Record<string, unknown> = {
    ordId: "op_ord_btc_999",
    clOrdId: "manual_btc_limit_1",
    instId,
    posSide: "long",
    side: "sell",
    reduceOnly: true,
    px: "95000",
    sz: 1
  };

  const evalResult = evaluateOrderOwnership(operatorOrder, false, []);
  assertEq(evalResult.ownership, "OPERATOR_OWNED", "Operator order must be OPERATOR_OWNED");
  assertEq(evalResult.mutationAllowed, false, "Operator order mutation must be forbidden");
  assertEq(evalResult.cancelAllowed, false, "Operator order cancellation must be forbidden");

  pass("TEST_4_OPERATOR_ORDER_MUTATION_FORBIDDEN");
}

// ---------------------------------------------------------------------------
// TEST 5: Protective clOrdId format alphanumeric check
// ---------------------------------------------------------------------------
function testProtectiveClOrdIdAlphanumeric(): void {
  const entryCl = "posETHUSDTl123456789";
  const slId = buildOkxAlgoClOrdId("sl", entryCl);
  const tpId = buildOkxAlgoClOrdId("tp", entryCl);

  assertTrue(isValidOkxAlgoClOrdId(slId), `SL ID ${slId} must be valid alphanumeric`);
  assertTrue(isValidOkxAlgoClOrdId(tpId), `TP ID ${tpId} must be valid alphanumeric`);
  assertFalse(isValidOkxAlgoClOrdId("sl_pos_123"), "Underscore ID must be rejected by validator");

  pass("TEST_5_ALPHANUMERIC_CLORDID_ENFORCED", { slId, tpId });
}

// ---------------------------------------------------------------------------
// TEST 6: Bot protective OCO classified as bot-managed-protection in bridge authority
// ---------------------------------------------------------------------------
function testBotOcoClassifiedConsistently(): void {
  const openedAt = 1714000000000;
  const openedAt36 = openedAt.toString(36);
  const instId = "ETH-USDT-SWAP";

  const mockOpen: PaperOpenPositionRecord = {
    symbol: "ETHUSDT" as any,
    side: "short",
    openedAt,
    entryPrice: 2500,
    sizeUsd: 1000,
    stopPrice: 2497,
    status: "open",
    instId,
    leverage: 10,
    strategyVersion: "v2",
    sourceSignal: "TEST",
    sourceRunPath: "test",
    pos: 0.4,
    protectiveStopAlgoId: "oco_algo_eth_1",
    protectiveSlAlgoId: "oco_algo_eth_1"
  };

  const ocoAlgo: Record<string, unknown> = {
    algoId: "oco_algo_eth_1",
    algoClOrdId: `oapETHUSs${openedAt36}s`,
    instId,
    posSide: "short",
    side: "buy",
    reduceOnly: true,
    ordType: "oco",
    sz: 10,
    slTriggerPx: "2497",
    tpTriggerPx: "2400"
  };

  // 1. Order ownership evaluation
  const ownership = evaluateOrderOwnership(ocoAlgo, true, [mockOpen]);
  assertEq(ownership.ownership, "ENGINE_OWNED", "ETH OCO must be evaluated as ENGINE_OWNED");

  // 2. Open order purpose classification
  const purposeResult = classifyOkxOpenOrderPurpose(ocoAlgo, mockOpen);
  assertTrue(purposeResult.isBotManagedProtection, "ETH OCO must be recognized as bot managed protection");
  assertEq(purposeResult.manualReduceDetected, false, "Must not detect manual reduce for bot OCO");
  assertFalse(purposeResult.purpose === "manual-reduce-purpose", "Purpose must not be manual-reduce-purpose");

  // 3. Pending orders exposure analysis
  const exposureAnalysis = resolvePendingOrdersExposure({
    pending: [],
    algos: [ocoAlgo],
    opens: [mockOpen],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  assertEq(exposureAnalysis.blockingAlgosCount, 0, "Bot protective OCO must not block exposure");
  assertEq(exposureAnalysis.botManagedProtectiveCount, 1, "Must be counted as bot-managed protective");

  pass("TEST_6_BOT_OCO_CLASSIFICATION_CONSISTENT", {
    ownership: ownership.ownership,
    purpose: purposeResult.purpose,
    botManagedProtectiveCount: exposureAnalysis.botManagedProtectiveCount
  });
}

// ---------------------------------------------------------------------------
// TEST 7: BTCUSDT BOT_V2_MANAGED position trailing stop & OCO reconciliation (Symbol-Agnostic)
// ---------------------------------------------------------------------------
function testBtcBotV2TrailingStopAndOcoReconciliation(): void {
  const openedAt = 1714000000000;
  const openedAt36 = openedAt.toString(36);
  const instId = "BTC-USDT-SWAP";

  // 1. Existing BTC OCO with old stop 65000 and TP 60000
  const oldBtcOco: ProtectiveAlgoRow = {
    algoId: "oco_btc_old",
    algoClOrdId: `oapBTCUSs${openedAt36}s`,
    instId,
    posSide: "short",
    side: "buy",
    reduceOnly: true,
    tdMode: "cross",
    ordType: "oco",
    sz: 1,
    slTriggerPx: "65000",
    tpTriggerPx: "60000"
  };

  // 2. Trailing stop tightened to 64000
  const ctxNewBtcStop: ProtectiveReconcileContext = {
    instId,
    positionSide: "short",
    openedAt36,
    tdModeUsed: "cross",
    contractsToProtect: 1,
    activeStopPrice: 64000,
    activeTpPrice: 60000,
    wantsTp: true,
    expectedSide: "buy",
    tickSz: 0.1
  };

  const plan = planProtectiveOrderReconcile([oldBtcOco], ctxNewBtcStop);
  assertEq(plan.canonicalSl, null, "BTC existing 65000 OCO must not match new 64000 stop");
  assertTrue(plan.submitOco, "BTC must trigger atomic OCO replacement for trailing stop raise");

  // 3. Post-submit rescan adopts new 64000 OCO and cancels old 65000 OCO
  const newBtcOco: ProtectiveAlgoRow = {
    algoId: "oco_btc_new",
    algoClOrdId: `oapBTCUSs${openedAt36}r1s`,
    instId,
    posSide: "short",
    side: "buy",
    reduceOnly: true,
    tdMode: "cross",
    ordType: "oco",
    sz: 1,
    slTriggerPx: "64000",
    tpTriggerPx: "60000"
  };

  const planPost = planProtectiveOrderReconcile([oldBtcOco, newBtcOco], ctxNewBtcStop);
  assertEq(planPost.canonicalSl?.algoId, "oco_btc_new", "BTC new OCO adopted as canonical SL");
  assertEq(planPost.canonicalTp?.algoId, "oco_btc_new", "BTC TP leg preserved in new OCO");
  assertTrue(planPost.cancelAlgoIds.includes("oco_btc_old"), "BTC old OCO marked for cancel post-adopt");

  pass("TEST_7_BTC_BOT_V2_TRAILING_STOP_AND_OCO_RECONCILIATION_PASS");
}

// ---------------------------------------------------------------------------
// TEST 8: BTC OPERATOR_MANAGED / manual takeover position is 100% frozen (No Mutation)
// ---------------------------------------------------------------------------
function testBtcOperatorManagedFrozen(): void {
  const btcOperatorPosition: PaperOpenPositionRecord = {
    symbol: "BTCUSDT" as any,
    side: "long",
    openedAt: 1714000000000,
    entryPrice: 65000,
    sizeUsd: 5000,
    stopPrice: 64000,
    status: "open",
    instId: "BTC-USDT-SWAP",
    leverage: 10,
    strategyVersion: "manual",
    sourceSignal: "OPERATOR",
    sourceRunPath: "manual",
    pos: 0.0769,
    lifecycleState: "OPERATOR_MANAGED",
    manualTakeoverActive: true
  };

  const isOperatorManaged =
    btcOperatorPosition.lifecycleState === "OPERATOR_MANAGED" ||
    btcOperatorPosition.manualTakeoverActive === true;

  assertTrue(isOperatorManaged, "BTC operator position must be recognized as OPERATOR_MANAGED");

  // Verify that any order from operator remains untouched
  const opOrder: Record<string, unknown> = {
    ordId: "op_btc_order_123",
    clOrdId: "manual_btc_sl_1",
    instId: "BTC-USDT-SWAP",
    posSide: "long",
    side: "sell",
    reduceOnly: true,
    slTriggerPx: "63000"
  };

  const ownership = evaluateOrderOwnership(opOrder, true, [btcOperatorPosition]);
  assertEq(ownership.ownership, "OPERATOR_OWNED", "Operator order must be OPERATOR_OWNED");
  assertEq(ownership.mutationAllowed, false, "Mutation must be strictly forbidden for operator position");
  assertEq(ownership.cancelAllowed, false, "Cancel must be strictly forbidden for operator position");

  pass("TEST_8_BTC_OPERATOR_MANAGED_STRICTLY_FROZEN_PASS");
}

function runAllTests(): void {
  testShortTrailingStopPriceUpdate();
  testAtomicOcoReplacementPreservesTp();
  testFailSafeOnSubmitError();
  testOperatorOrderProtection();
  testProtectiveClOrdIdAlphanumeric();
  testBotOcoClassifiedConsistently();
  testBtcBotV2TrailingStopAndOcoReconciliation();
  testBtcOperatorManagedFrozen();
  console.info(JSON.stringify({ event: "ALL_V2_PROTECTIVE_TRAILING_STOP_REGRESSION_TESTS_PASS" }));
}

runAllTests();

