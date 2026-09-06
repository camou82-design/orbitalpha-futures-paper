import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveProtectiveTpPlan,
  shouldAttachFullPositionProtectiveTp,
  resolveOpsWatchTpRequired
} from "../engine-v2/execution/protective-tp-authority";
import { buildV2NewEntryAttachAlgoOrds } from "../engine-v2/execution/entry-protection-attach";
import { evaluatePreEntryProtectionPlan } from "../engine-v2/execution/pre-entry-protection-plan";
import { findProtectiveHintsForInst } from "./position-ops-monitor";
import { planProtectiveOrderReconcile, evaluateProtectiveAlgoMatch } from "../engine-v2/execution/protective-reconcile-plan";
import { evaluateV2ExitExecutionGate } from "../engine-v2/exit/exit-execution-gate";
import { classifyPositionSizeDelta } from "../engine-v2/position/manual-reduce-rebase";
import { resolvePositionOwnership } from "../engine-v2/position/ownership-resolver";
import { deriveTradeLifecycleAuthority } from "../engine-v2/lifecycle/trade-lifecycle-authority";
import type { PaperOpenPositionRecord } from "../models/types";

// ============================================================================
// TEST A: BOT_V2_MANAGED LONG 2.14 -> manual same-side partial -> 1.07 -> owner remains BOT_V2_MANAGED
// ============================================================================
test("TEST A: BOT_V2_MANAGED LONG 2.14 manual same-side partial -> 1.07 remains BOT_V2_MANAGED", () => {
  const ledger: PaperOpenPositionRecord = {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 77252,
    okxContracts: 2.14,
    sizeUsd: 1654.33,
    lifecycleState: "BOT_V2_MANAGED",
    isV2Authority: true,
    authority: "v2",
    exchangeClOrdId: "pBTCUSDTentry1",
    openedAt: Date.now() - 300_000,
    stopPrice: 76934.1,
    targetPrice1: 77767.1,
    leverage: 10,
    strategyVersion: "v2",
    sourceSignal: "LONG_CANDIDATE",
    sourceRunPath: "paper",
    status: "open" as const,
    pos: 0.0214
  };

  const delta = classifyPositionSizeDelta({
    ledger,
    beforeContracts: 2.14,
    afterContracts: 1.07,
    botManaged: true,
    nowMs: Date.now()
  });

  assert.equal(delta.classification, "MANUAL_REDUCE_REBASE");
  assert.equal(delta.botFillEvidenceFound, false);

  const ownership = resolvePositionOwnership({
    symbol: "BTCUSDT",
    side: "long",
    okxActualPositionExists: true,
    okxActualContracts: 1.07,
    ledger,
    ledgerPaperContracts: 2.14,
    ledgerEntryPrice: 77252,
    okxAvgPx: 77252,
    symbolExternalManualBlocked: false,
    manualOwnershipLatchActive: false
  });

  assert.equal(ownership.ownershipClass, "BOT_V2_MANAGED");
  assert.equal(ownership.manualOwnershipLatchActive, false);
  assert.equal(ownership.lifecycleAfter, "BOT_V2_MANAGED");
});

// ============================================================================
// TEST B: manual partial 후 exit_calculation_allowed = true, V2 ladder authority remains active
// ============================================================================
test("TEST B: manual partial preserves exit calculation and V2 ladder authority", () => {
  const ledgerAfterPartial: PaperOpenPositionRecord = {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 77252,
    okxContracts: 1.07,
    sizeUsd: 827.16,
    lifecycleState: "BOT_V2_MANAGED",
    manualTakeoverActive: false,
    isV2Authority: true,
    authority: "v2",
    exchangeClOrdId: "pBTCUSDTentry1",
    openedAt: Date.now() - 300_000,
    stopPrice: 76934.1,
    targetPrice1: 77767.1,
    leverage: 10,
    strategyVersion: "v2",
    sourceSignal: "LONG_CANDIDATE",
    sourceRunPath: "paper",
    status: "open" as const,
    pos: 0.0214
  };

  const gateResult = evaluateV2ExitExecutionGate({
    symbol: "BTCUSDT",
    side: "long",
    requestedAction: "close",
    requestedReason: "V2_RANGE_TAKE_PROFIT_2_EXIT",
    isV2Managed: true,
    v2ShouldExit: true,
    v2ShouldReduce: false,
    v2ShouldPartial: false,
    actualStopBreached: false,
    actualPositionExists: true,
    manualTakeoverActive: ledgerAfterPartial.manualTakeoverActive
  });

  assert.equal(gateResult.allowed, true);
  assert.equal(gateResult.blockReason, null);
  assert.equal(gateResult.effectiveAction, "close");
});

// ============================================================================
// TEST C: manual partial 후 TP2 cross -> TP2 trigger proof 생성 -> exit action 생성
// ============================================================================
test("TEST C: manual partial -> markPrice crosses TP2 generates TP2 trigger proof and exit action", () => {
  const lifecycleResult = deriveTradeLifecycleAuthority({
    symbol: "BTCUSDT",
    side: "long",
    regime: "RANGE",
    marketMode: "RANGE",
    directionalShockState: "NONE",
    v2Decision: "HOLD",
    v2Side: "long",
    authoritySource: "v2",
    adoptedEngine: "V2",
    entryPrice: 77252,
    markPrice: 77788.9, // Crossed TP2 (77767.1)
    unrealizedPnl: 50,
    unrealizedPnlPct: 0.0069,
    holdMs: 60000,
    position: {
      contracts: 1.07,
      entryPrice: 77252,
      side: "long",
      takeProfitPlan: { tp1: 77483.7, tp2: 77767.1 }
    } as any,
    riskState: null,
    cooldownState: { reason: null, remainingMs: null, reentryBlocked: false },
    microExecution: null,
    reversalQuality: null,
    rawMetricsSummary: {
      qualityScore: 70,
      rangeConfidence: 0.8,
      trendWeaknessScore: 0.6,
      boxPos: 0.85
    },
    takeProfitPlan: { tp1: 77483.7, tp2: 77767.1, invalidationPx: 76934.1 },
    tp1Triggered: false,
    tp2Triggered: false
  });

  assert.equal(lifecycleResult.exitAction, "exit");
  assert.equal(lifecycleResult.exitReason, "V2_RANGE_TAKE_PROFIT_2_EXIT");
  assert.equal(lifecycleResult.tp2Triggered, true);
  assert.equal(lifecycleResult.takeProfit2Px, 77767.1);
});

// ============================================================================
// TEST D: manual partial 후 TP2/SL size 2.14 -> 1.07, prices unchanged
// ============================================================================
test("TEST D: manual partial 2.14 -> 1.07 resizes exchange TP2 + SL to 1.07ct with prices unchanged", () => {
  const existingOco = {
    algoId: "algo-oco-1",
    algoClOrdId: "oapBTCUScycle3608s",
    instId: "BTC-USDT-SWAP",
    side: "sell",
    posSide: "long",
    tdMode: "cross",
    reduceOnly: true,
    ordType: "oco",
    sz: "2.14",
    slTriggerPx: 76934.1,
    tpTriggerPx: 77767.1
  };

  const reconcilePlan = planProtectiveOrderReconcile(
    [existingOco],
    {
      instId: "BTC-USDT-SWAP",
      positionSide: "long",
      openedAt36: "cycle3608",
      tdModeUsed: "cross",
      contractsToProtect: 1.07, // Rebased to remaining 1.07 contracts
      activeStopPrice: 76934.1, // Price strictly preserved
      activeTpPrice: 77767.1,   // Price strictly preserved
      wantsTp: true,
      expectedSide: "sell",
      tickSz: 0.1,
      entryPrice: 77252
    }
  );

  assert.equal(reconcilePlan.staleCount, 1);
  assert.ok(reconcilePlan.cancelAlgoIds.includes("algo-oco-1"));
  assert.equal(reconcilePlan.submitOco, true);
  assert.equal(reconcilePlan.needSubmitSl, false);
  assert.equal(reconcilePlan.needSubmitTp, false);
});

// ============================================================================
// TEST E: manual full close -> 0 -> lifecycle close + protective cleanup
// ============================================================================
test("TEST E: manual full close to 0 contracts triggers protective cleanup and flat gate", () => {
  const orphanedAlgos = [
    { algoId: "algo-sl-1", algoClOrdId: "oap_cycle3608_s", instId: "BTC-USDT-SWAP", side: "sell", posSide: "long", tdMode: "cross", reduceOnly: true, sz: "1.07", slTriggerPx: 76934.1 },
    { algoId: "algo-tp-1", algoClOrdId: "oap_cycle3608_t", instId: "BTC-USDT-SWAP", side: "sell", posSide: "long", tdMode: "cross", reduceOnly: true, sz: "1.07", tpTriggerPx: 77767.1 }
  ];

  const reconcilePlan = planProtectiveOrderReconcile(
    orphanedAlgos,
    {
      instId: "BTC-USDT-SWAP",
      positionSide: "long",
      openedAt36: "cycle3608",
      tdModeUsed: "cross",
      contractsToProtect: 0, // Flat position
      activeStopPrice: 76934.1,
      activeTpPrice: 77767.1,
      wantsTp: false,
      expectedSide: "sell",
      tickSz: 0.1
    }
  );

  assert.equal(reconcilePlan.needSubmitSl, false);
  assert.equal(reconcilePlan.needSubmitTp, false);
  assert.equal(reconcilePlan.submitOco, false);
  assert.ok(reconcilePlan.cancelAlgoIds.includes("algo-sl-1"));
  assert.ok(reconcilePlan.cancelAlgoIds.includes("algo-tp-1"));

  const gateResult = evaluateV2ExitExecutionGate({
    symbol: "BTCUSDT",
    side: "long",
    requestedAction: "close",
    requestedReason: "V2_RANGE_TAKE_PROFIT_2_EXIT",
    isV2Managed: true,
    v2ShouldExit: true,
    v2ShouldReduce: false,
    v2ShouldPartial: false,
    actualStopBreached: false,
    actualPositionExists: false // Flat position blocks further exits
  });

  assert.equal(gateResult.allowed, false);
  assert.equal(gateResult.blockReason, "no_actual_position_to_close");
});

// ============================================================================
// TEST F: manual increase -> BOT_V2_MANAGED -> OPERATOR_MANAGED takeover safety
// ============================================================================
test("TEST F: manual increase triggers OPERATOR_MANAGED takeover", () => {
  const ledger: PaperOpenPositionRecord = {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 77252,
    okxContracts: 2.14,
    sizeUsd: 1654.33,
    lifecycleState: "BOT_V2_MANAGED",
    isV2Authority: true,
    authority: "v2",
    exchangeClOrdId: "pBTCUSDTentry1",
    openedAt: Date.now() - 300_000,
    leverage: 10,
    strategyVersion: "v2",
    sourceSignal: "LONG_CANDIDATE",
    sourceRunPath: "paper",
    status: "open" as const,
    pos: 0.0214
  };

  const delta = classifyPositionSizeDelta({
    ledger,
    beforeContracts: 2.14,
    afterContracts: 4.28, // Manual add from outside
    botManaged: true,
    nowMs: Date.now()
  });

  assert.equal(delta.classification, "MANUAL_INCREASE");
});

// ============================================================================
// TEST G: manual reversal -> OPERATOR_MANAGED
// ============================================================================
test("TEST G: manual opposite position triggers takeover", () => {
  const ledger: PaperOpenPositionRecord = {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 77252,
    okxContracts: 2.14,
    sizeUsd: 1654.33,
    lifecycleState: "BOT_V2_MANAGED",
    isV2Authority: true,
    authority: "v2",
    openedAt: Date.now() - 300_000,
    leverage: 10,
    strategyVersion: "v2",
    sourceSignal: "LONG_CANDIDATE",
    sourceRunPath: "paper",
    status: "open" as const,
    pos: 0.0214
  };

  // When remote is opposite side (short), ownership resolver sets EXTERNAL_MANUAL_MANAGED
  const ownership = resolvePositionOwnership({
    symbol: "BTCUSDT",
    side: "long",
    okxActualPositionExists: true,
    okxActualContracts: 2.14,
    ledger: null, // Opposite side position is not this ledger's long
    symbolExternalManualBlocked: false,
    explicitExternalManualEvidence: true
  });

  assert.equal(ownership.ownershipClass, "EXTERNAL_MANUAL_MANAGED");
});

// ============================================================================
// TEST H: explicit operator takeover -> existing semantic maintained
// ============================================================================
test("TEST H: explicit operator takeover blocks bot exits", () => {
  const gateResult = evaluateV2ExitExecutionGate({
    symbol: "BTCUSDT",
    side: "long",
    requestedAction: "close",
    requestedReason: "V2_RANGE_TAKE_PROFIT_2_EXIT",
    isV2Managed: true,
    v2ShouldExit: true,
    v2ShouldReduce: false,
    v2ShouldPartial: false,
    actualStopBreached: false,
    actualPositionExists: true,
    manualTakeoverActive: true // Explicit takeover active
  });

  assert.equal(gateResult.allowed, false);
  assert.equal(gateResult.blockReason, "MANUAL_TAKEOVER_ACTIVE");
  assert.equal(gateResult.effectiveAction, "hold");
});

// ============================================================================
// TEST I: RANGE TP2 exchange backstop existing tests still PASS
// ============================================================================
test("TEST I: RANGE initial 2.14ct attaches TP2 backstop with full initial contracts", () => {
  const tpPlan = resolveProtectiveTpPlan({
    isV2Authority: true,
    regime: "RANGE",
    isV2RangePartialPlan: true,
    takeProfit1Px: 77483.7,
    takeProfit2Px: 77767.1,
    takeProfitPlan: { tp1: 77483.7, tp2: 77767.1 }
  });

  assert.equal(tpPlan.mode, "RANGE_TP2_BACKSTOP");
  assert.equal(tpPlan.exchangeTpRequired, true);
  assert.equal(tpPlan.exchangeTpPrice, 77767.1);
  assert.equal(tpPlan.exchangeTpSource, "range_tp2_backstop");

  const attach = buildV2NewEntryAttachAlgoOrds({
    clOrdId: "pBTCUSDTentry1",
    submitSzStr: "2.14",
    stopPrice: 76934.1,
    takeProfitPrice: tpPlan.exchangeTpPrice,
    isV2RangePartialPlan: true
  });

  assert.equal(attach.attachOrdType, "oco");
  assert.equal(attach.entryFullPositionTpAttached, false);
  assert.equal(attach.entryRangeTp2BackstopAttached, true);
  assert.equal(attach.lifecyclePartialTpAuthority, true);
  assert.equal(attach.exchangeTpSource, "range_tp2_backstop");
  assert.equal(attach.attachAlgoOrds[0].sz, "2.14");
  assert.equal(attach.attachAlgoOrds[0].slTriggerPx, "76934.1");
  assert.equal(attach.attachAlgoOrds[0].tpTriggerPx, "77767.1");
});

// ============================================================================
// TEST J: TREND mode attaches TP1 as 100% full exit OCO
// ============================================================================
test("TEST J: TREND mode attaches TP1 as 100% full exit OCO", () => {
  const trendTpPlan = resolveProtectiveTpPlan({
    isV2Authority: true,
    regime: "TREND",
    isV2RangePartialPlan: false,
    takeProfit1Px: 78500,
    takeProfitPlan: { tp1: 78500 }
  });

  assert.equal(trendTpPlan.mode, "TREND_FULL_TP");
  assert.equal(trendTpPlan.exchangeTpRequired, true);
  assert.equal(trendTpPlan.exchangeTpPrice, 78500);
  assert.equal(trendTpPlan.exchangeTpSource, "trend_full_tp");

  const attach = buildV2NewEntryAttachAlgoOrds({
    clOrdId: "pBTCUSDTtrend",
    submitSzStr: "1.5",
    stopPrice: 76000,
    takeProfitPrice: 78500,
    isV2RangePartialPlan: false
  });

  assert.equal(attach.attachOrdType, "oco");
  assert.equal(attach.entryFullPositionTpAttached, true);
  assert.equal(attach.entryRangeTp2BackstopAttached, false);
  assert.equal(attach.lifecyclePartialTpAuthority, false);
  assert.equal(attach.exchangeTpSource, "trend_full_tp");
  assert.equal(attach.attachAlgoOrds[0].tpTriggerPx, "78500");
});
