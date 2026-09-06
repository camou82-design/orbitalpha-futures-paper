import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveProtectiveTpPlan,
  shouldAttachFullPositionProtectiveTp,
  resolveOpsWatchTpRequired
} from "../engine-v2/execution/protective-tp-authority";
import {
  buildV2NewEntryAttachAlgoOrds,
  isV2RangePartialPlanContext
} from "../engine-v2/execution/entry-protection-attach";
import { evaluatePreEntryProtectionPlan } from "../engine-v2/execution/pre-entry-protection-plan";
import {
  planProtectiveOrderReconcile,
  evaluateProtectiveAlgoMatch,
  type ProtectiveAlgoRow,
  type ProtectiveReconcileContext
} from "../engine-v2/execution/protective-reconcile-plan";
import { findProtectiveHintsForInst } from "./position-ops-monitor";
import { evaluatePositionProtectionState } from "../engine-v2/execution/protective-order-state";
import type { PaperOpenPositionRecord } from "../models/types";

console.log("=== RUNNING V2 RANGE TP2 BACKSTOP RESTORATION TEST SUITE ===");

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`[V2-RANGE-TP2-BACKSTOP][${name}] PASS`);
  } catch (err: any) {
    console.error(`[V2-RANGE-TP2-BACKSTOP][${name}] FAIL:`, err.message || err);
    throw err;
  }
}

// 1. BTC V2 RANGE Entry attaches SL 100% + TP2 100% OCO (NOT TP1 50%)
run("1. BTC V2 RANGE Entry attaches SL 100% + TP2 100% OCO", () => {
  const tpPlan = resolveProtectiveTpPlan({
    isV2Authority: true,
    regime: "RANGE",
    isV2RangePartialPlan: true,
    takeProfit1Px: 79500.0,
    takeProfit2Px: 80500.0,
    takeProfitPlan: { tp1: 79500.0, tp2: 80500.0 }
  });

  assert.equal(tpPlan.mode, "RANGE_TP2_BACKSTOP");
  assert.equal(tpPlan.exchangeTpRequired, true);
  assert.equal(tpPlan.exchangeTpPrice, 80500.0, "Entry TP backstop must be TP2 (80500), not TP1");
  assert.equal(tpPlan.exchangeTpSource, "range_tp2_backstop");
  assert.equal(tpPlan.fullPositionTpRequired, true);

  const attach = buildV2NewEntryAttachAlgoOrds({
    clOrdId: "pBTCentry001",
    submitSzStr: "0.51",
    stopPrice: 78000.0,
    takeProfitPrice: tpPlan.exchangeTpPrice,
    isV2RangePartialPlan: true
  });

  assert.equal(attach.attachOrdType, "oco", "Must attach OCO order");
  assert.equal(attach.entryRangeTp2BackstopAttached, true);
  assert.equal(attach.entryFullPositionTpAttached, false);
  assert.equal(attach.exchangeTpSource, "range_tp2_backstop");
  assert.equal(attach.attachAlgoOrds.length, 1);
  assert.equal(attach.attachAlgoOrds[0].sz, "0.51", "OCO size must be 100% full contracts (0.51)");
  assert.equal(attach.attachAlgoOrds[0].slTriggerPx, "78000");
  assert.equal(attach.attachAlgoOrds[0].tpTriggerPx, "80500", "OCO TP leg must be TP2 (80500)");
});

// 2. ETH V2 RANGE Entry attaches SL 100% + TP2 100% OCO (Symmetric)
run("2. ETH V2 RANGE Entry attaches SL 100% + TP2 100% OCO (Symmetric with BTC)", () => {
  const tpPlan = resolveProtectiveTpPlan({
    isV2Authority: true,
    regime: "RANGE",
    isV2RangePartialPlan: true,
    takeProfit1Px: 2350.0,
    takeProfit2Px: 2400.0,
    takeProfitPlan: { tp1: 2350.0, tp2: 2400.0 }
  });

  assert.equal(tpPlan.mode, "RANGE_TP2_BACKSTOP");
  assert.equal(tpPlan.exchangeTpRequired, true);
  assert.equal(tpPlan.exchangeTpPrice, 2400.0, "ETH Entry TP backstop must be TP2 (2400)");
  assert.equal(tpPlan.exchangeTpSource, "range_tp2_backstop");

  const attach = buildV2NewEntryAttachAlgoOrds({
    clOrdId: "pETHentry001",
    submitSzStr: "10.0",
    stopPrice: 2280.0,
    takeProfitPrice: tpPlan.exchangeTpPrice,
    isV2RangePartialPlan: true
  });

  assert.equal(attach.attachOrdType, "oco");
  assert.equal(attach.entryRangeTp2BackstopAttached, true);
  assert.equal(attach.attachAlgoOrds[0].sz, "10.0");
  assert.equal(attach.attachAlgoOrds[0].slTriggerPx, "2280");
  assert.equal(attach.attachAlgoOrds[0].tpTriggerPx, "2400");
});

// 3. Pre-entry protection plan sets TP required as TP2 backstop
run("3. Pre-entry protection plan sets TP required as TP2 backstop", () => {
  const preEntryPlan = evaluatePreEntryProtectionPlan({
    symbol: "BTCUSDT",
    side: "long",
    entryReferencePrice: 79000.0,
    slPrice: 78000.0,
    tpPrice: 80500.0, // TP2 price passed
    isV2Authority: true,
    regime: "RANGE",
    isV2RangePartialPlan: true,
    tickSz: 0.1
  });

  assert.equal(preEntryPlan.protectionPlanReady, true);
  assert.equal(preEntryPlan.entryBlocked, false);
  assert.equal(preEntryPlan.slRequired, true);
  assert.equal(preEntryPlan.tpRequired, true, "TP2 backstop is required on exchange");
  assert.equal(preEntryPlan.slPrice, 78000.0);
  assert.equal(preEntryPlan.tpPrice, 80500.0);
});

// 4. Live TP2 OCO is adopted as canonical without false duplicate/replacement submit
run("4. Live TP2 OCO is adopted as canonical without duplicate submit or cancellation", () => {
  const ctx: ProtectiveReconcileContext = {
    instId: "BTC-USDT-SWAP",
    positionSide: "long",
    openedAt36: "34wo0",
    tdModeUsed: "cross",
    contractsToProtect: 0.51,
    activeStopPrice: 78000.0,
    activeTpPrice: 80500.0,
    wantsTp: true,
    expectedSide: "sell",
    tickSz: 0.1
  };

  const liveOco: ProtectiveAlgoRow = {
    algoId: "oco_btc_live_1",
    instId: "BTC-USDT-SWAP",
    side: "sell",
    posSide: "net",
    tdMode: "cross",
    ordType: "oco",
    sz: 0.51,
    slTriggerPx: "78000",
    tpTriggerPx: "80500",
    reduceOnly: true,
    algoClOrdId: "oapBTCUS34wo0s"
  };

  const plan = planProtectiveOrderReconcile([liveOco], ctx);
  assert.equal(plan.canonicalSl?.algoId, "oco_btc_live_1", "Canonical SL adopted");
  assert.equal(plan.canonicalTp?.algoId, "oco_btc_live_1", "Canonical TP adopted from OCO");
  assert.equal(plan.needSubmitSl, false, "No SL submit needed");
  assert.equal(plan.needSubmitTp, false, "No separate TP submit needed (no 51088!)");
  assert.equal(plan.submitOco, false, "No replacement OCO needed");
  assert.equal(plan.cancelAlgoIds.length, 0, "No cancellation of live OCO");
});

// 5. TP1 partial exit in V2 ladder -> remaining position resized to 0.26ct -> SL/TP2 resized idempotently
run("5. Post-TP1 partial exit -> remaining protection resized idempotently", () => {
  const postTp1Ctx: ProtectiveReconcileContext = {
    instId: "BTC-USDT-SWAP",
    positionSide: "long",
    openedAt36: "34wo0",
    tdModeUsed: "cross",
    contractsToProtect: 0.26, // Remaining 50% after TP1 filled
    activeStopPrice: 78000.0,
    activeTpPrice: 80500.0,
    wantsTp: true,
    expectedSide: "sell",
    tickSz: 0.1
  };

  // Stale initial 0.51 OCO on exchange
  const oldOco: ProtectiveAlgoRow = {
    algoId: "old_oco_051",
    instId: "BTC-USDT-SWAP",
    side: "sell",
    posSide: "net",
    tdMode: "cross",
    ordType: "oco",
    sz: 0.51,
    slTriggerPx: "78000",
    tpTriggerPx: "80500",
    reduceOnly: true,
    algoClOrdId: "oapBTCUS34wo0s"
  };

  const plan = planProtectiveOrderReconcile([oldOco], postTp1Ctx);
  assert.equal(plan.staleCount, 1, "Old 0.51ct OCO recognized as stale");
  assert.equal(plan.cancelAlgoIds.includes("old_oco_051"), true, "Old OCO scheduled for cancel");
  assert.equal(plan.submitOco, true, "New resized 0.26ct OCO scheduled for submit");
});

// 6. Ops-watch recognizes live TP2 OCO as satisfying full protection
run("6. Ops-watch recognizes live TP2 OCO as satisfying full protection", () => {
  const ledger = {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 79000.0,
    okxContracts: 0.51,
    sizeUsd: 400.0,
    lifecycleState: "BOT_V2_MANAGED",
    isV2Authority: true,
    regimeAtEntry: "RANGE",
    takeProfit1Px: 79500.0,
    takeProfit2Px: 80500.0,
    takeProfitPlan: { tp1: 79500.0, tp2: 80500.0 },
    stopPrice: 78000.0,
    status: "open" as const,
    pos: 0.0051,
    openedAt: Date.now() - 60_000
  } as unknown as PaperOpenPositionRecord;

  const liveOco = {
    algoId: "live_oco_123",
    instId: "BTC-USDT-SWAP",
    side: "sell",
    posSide: "net",
    ordType: "oco",
    sz: "0.51",
    slTriggerPx: "78000",
    tpTriggerPx: "80500",
    state: "live"
  };

  const hints = findProtectiveHintsForInst("BTC-USDT-SWAP", "long", [], [liveOco], true, {
    ledger,
    tickSz: 0.1,
    requiredStopPx: 78000.0,
    requiredContracts: 0.51
  });

  assert.equal(hints.protectionSatisfied, true);
  assert.equal(hints.slPrice, 78000.0);
  assert.equal(hints.tpPrice, 80500.0);
  assert.equal(hints.matchingProtectiveOrderCount, 1);
});

// 7. No reverse position risk: OCO reduceOnly guarantees cannot open opposite position
run("7. No reverse position risk: OCO reduceOnly guarantees no opposite position", () => {
  const attach = buildV2NewEntryAttachAlgoOrds({
    clOrdId: "pBTCrisk01",
    submitSzStr: "0.51",
    stopPrice: 78000.0,
    takeProfitPrice: 80500.0,
    isV2RangePartialPlan: true
  });

  assert.equal(attach.attachAlgoOrds[0].reduceOnly, true, "reduceOnly must be true");
  assert.equal(attach.attachAlgoOrds[0].ordType, "oco");
});

// 8. TREND regime unchanged: maintains 100% TP1 full position OCO
run("8. TREND regime maintains 100% TP1 full position OCO unchanged", () => {
  const trendPlan = resolveProtectiveTpPlan({
    isV2Authority: true,
    regime: "TREND",
    isV2RangePartialPlan: false,
    takeProfit1Px: 82000.0,
    takeProfitPlan: { tp1: 82000.0 }
  });

  assert.equal(trendPlan.mode, "TREND_FULL_TP");
  assert.equal(trendPlan.exchangeTpRequired, true);
  assert.equal(trendPlan.exchangeTpPrice, 82000.0);
  assert.equal(trendPlan.exchangeTpSource, "trend_full_tp");
  assert.equal(trendPlan.fullPositionTpRequired, true);

  const attach = buildV2NewEntryAttachAlgoOrds({
    clOrdId: "pBTCtrend01",
    submitSzStr: "0.51",
    stopPrice: 78000.0,
    takeProfitPrice: 82000.0,
    isV2RangePartialPlan: false
  });

  assert.equal(attach.attachOrdType, "oco");
  assert.equal(attach.entryFullPositionTpAttached, true);
  assert.equal(attach.entryRangeTp2BackstopAttached, false);
  assert.equal(attach.exchangeTpSource, "trend_full_tp");
  assert.equal(attach.attachAlgoOrds[0].tpTriggerPx, "82000");
});

// 9. Actual open.json persisted shape replay (no top-level partialExitRatio, no plan.partialRatio)
run("9. Actual open.json persisted shape replay -> IS_V2_RANGE_PARTIAL_PLAN=YES, OPS_TP_REQUIRED=YES, TP2_BACKSTOP_EXPECTED=YES", () => {
  const openJsonRecord = {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 79522.0,
    okxContracts: 0.51,
    sizeUsd: 400.0,
    lifecycleState: "BOT_V2_MANAGED",
    isV2Authority: true,
    regimeAtEntry: "RANGE",
    takeProfit1Px: 80760.8,
    takeProfit2Px: 82000.0,
    takeProfitPlan: {
      tp1: 80760.8,
      executableTp1: 80760.8
      // Note: partialRatio is NOT present in persisted open.json
    },
    stopPrice: 79000.0,
    status: "open",
    pos: 0.0051,
    openedAt: Date.now() - 120_000
    // Note: top-level partialExitRatio is NOT present in persisted open.json
  };

  const isV2Range = isV2RangePartialPlanContext({
    isV2Authority: openJsonRecord.isV2Authority === true,
    regime: openJsonRecord.regimeAtEntry,
    takeProfitPlan: openJsonRecord.takeProfitPlan,
    takeProfit1Px: openJsonRecord.takeProfit1Px,
    partialExitRatio: (openJsonRecord as any).partialExitRatio
  });

  assert.equal(isV2Range, true, "IS_V2_RANGE_PARTIAL_PLAN must be YES for persisted open.json shape");

  const tpPlan = resolveProtectiveTpPlan({
    isV2Authority: true,
    regime: "RANGE",
    isV2RangePartialPlan: isV2Range,
    takeProfit1Px: openJsonRecord.takeProfit1Px,
    takeProfit2Px: openJsonRecord.takeProfit2Px,
    takeProfitPlan: openJsonRecord.takeProfitPlan
  });

  assert.equal(tpPlan.mode, "RANGE_TP2_BACKSTOP", "TP2_BACKSTOP_EXPECTED must be YES");
  assert.equal(tpPlan.exchangeTpRequired, true, "exchangeTpRequired must be YES");
  assert.equal(tpPlan.exchangeTpPrice, 82000.0);
  assert.equal(tpPlan.fullPositionTpRequired, true);

  const opsTpReq = resolveOpsWatchTpRequired({
    isV2RangePartialPlan: isV2Range,
    isV2ManagedTrend: false,
    rawTpRequired: true,
    hasRangeTp2Backstop: true
  });
  assert.equal(opsTpReq, true, "OPS_TP_REQUIRED must be YES");
});

// 10. Existing manual TP preservation replay
run("10. Existing manual TP preservation replay -> MANUAL_TP_CANCELLED_BY_BOT=NO, DUPLICATE_TP_CREATED=NO", () => {
  const manualTpOrder = {
    algoId: "manual_tp_9999",
    instId: "BTC-USDT-SWAP",
    side: "sell",
    posSide: "net",
    tdMode: "cross",
    reduceOnly: true,
    sz: "0.51",
    tpTriggerPx: "80760.8",
    tpOrdPx: "-1",
    triggerPx: "80760.8",
    triggerPxType: "last",
    state: "live"
    // No algoClOrdId -> not bot owned
  };

  const reconcileCtx: ProtectiveReconcileContext = {
    instId: "BTC-USDT-SWAP",
    positionSide: "long",
    openedAt36: (1700000000000).toString(36),
    tdModeUsed: "cross",
    contractsToProtect: 0.51,
    tpContractsToProtect: 0.51,
    activeStopPrice: 79000.0,
    activeTpPrice: 80760.8,
    wantsTp: true,
    expectedSide: "sell",
    tickSz: 0.1
  };

  const evalResult = evaluateProtectiveAlgoMatch(manualTpOrder, reconcileCtx);
  assert.equal(evalResult.tpLegValid, true, "Matching price and size must be recognized as valid live TP");
  assert.equal(evalResult.stale, false, "Live matching TP must not be marked stale");

  const plan = planProtectiveOrderReconcile([manualTpOrder], reconcileCtx);
  assert.equal(plan.staleCount, 0, "Manual matching TP must not be marked stale");
  assert.equal(plan.cancelAlgoIds.length, 0, "MANUAL_TP_CANCELLED_BY_BOT=NO");
  assert.equal(plan.needSubmitTp, false, "DUPLICATE_TP_CREATED=NO");
});

// 11. Pre-entry protection plan TP2 evaluation proof
run("11. Pre-entry protection plan TP2 evaluation proof -> PRE_ENTRY_TP_SOURCE=takeProfit2Px, ENTRY_OCO_TP_EQUALS_TP2=YES, ENTRY_OCO_TP_EQUALS_TP1=NO", () => {
  const takeProfit1Px = 80760.8;
  const takeProfit2Px = 82500.0;
  const stopPrice = 78500.0;
  const entryPrice = 79500.0;

  // Pre-entry plan evaluates with TP2
  const preEntryPlan = evaluatePreEntryProtectionPlan({
    symbol: "BTCUSDT",
    side: "long",
    entryReferencePrice: entryPrice,
    slPrice: stopPrice,
    tpPrice: takeProfit2Px, // TP2 backstop passed to pre-entry
    isV2Authority: true,
    regime: "RANGE",
    isV2RangePartialPlan: true,
    tickSz: 0.1
  });

  assert.equal(preEntryPlan.protectionPlanReady, true);
  assert.equal(preEntryPlan.entryBlocked, false);
  assert.equal(preEntryPlan.tpRequired, true);
  assert.equal(preEntryPlan.tpPrice, 82500.0, "Pre-entry TP price must match TP2");
  assert.notEqual(preEntryPlan.tpPrice, takeProfit1Px, "Pre-entry TP price must NOT be TP1");

  const attach = buildV2NewEntryAttachAlgoOrds({
    clOrdId: "pBTCproof01",
    submitSzStr: "0.51",
    stopPrice: preEntryPlan.slPrice,
    takeProfitPrice: preEntryPlan.tpPrice,
    isV2RangePartialPlan: true
  });

  assert.equal(attach.attachOrdType, "oco");
  assert.equal(attach.entryRangeTp2BackstopAttached, true);
  assert.equal(attach.attachAlgoOrds[0].tpTriggerPx, "82500", "ENTRY_OCO_TP_EQUALS_TP2=YES");
  assert.notEqual(attach.attachAlgoOrds[0].tpTriggerPx, String(takeProfit1Px), "ENTRY_OCO_TP_EQUALS_TP1=NO");

  console.log("\n[PROOF OUTPUT]");
  console.log("PRE_ENTRY_TP_SOURCE=takeProfit2Px");
  console.log("ENTRY_OCO_TP_EQUALS_TP2=YES");
  console.log("ENTRY_OCO_TP_EQUALS_TP1=NO");
});

console.log("\n>>> ALL 11 V2 RANGE TP2 BACKSTOP RESTORATION INVARIANTS VERIFIED SUCCESSFULLY <<<\n");
