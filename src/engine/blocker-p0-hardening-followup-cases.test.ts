/**
 * P0 hardening follow-up — OCO rebuild, terminal fail-closed, pre-entry gate, 51088 state
 */

import assert from "node:assert/strict";
import { evaluateTerminalReentryBarrier, resolveTerminalBarrierContext } from "../engine-v2/lifecycle/terminal-reentry-barrier";
import {
  evaluatePreEntryProtectionPlan,
  buildPreEntryProtectionPlanProof
} from "../engine-v2/execution/pre-entry-protection-plan";
import {
  evaluateAuthoritativeProtectionPresence,
  isSlOnlyOcoRebuildScenario,
  mergeRebuildTransactionProof
} from "../engine-v2/execution/protective-rebuild-transaction";
import { planProtectiveOrderReconcile, type ProtectiveReconcileContext, type ProtectiveAlgoRow } from "../engine-v2/execution/protective-reconcile-plan";
import {
  compute51088EvidenceHash,
  shouldSuppress51088Resubmit,
  record51088RecoveryAttempt,
  reset51088RecoveryState,
  __clearAll51088RecoveryStateForTests
} from "../engine-v2/execution/okx-51088-recovery-state";

function pass(label: string): void {
  console.log(`[P0-HARDENING][${label}] PASS`);
}

const ctx: ProtectiveReconcileContext = {
  instId: "BTC-USDT-SWAP",
  positionSide: "short",
  openedAt36: "abc",
  tdModeUsed: "cross",
  contractsToProtect: 0.5,
  activeStopPrice: 77200,
  activeTpPrice: 76800,
  wantsTp: true,
  expectedSide: "buy",
  tickSz: 0.1
};

// V2 evaluator path: ready empty position state is authoritative (no terminal pending)
{
  const ctx = resolveTerminalBarrierContext({
    positionStateReady: true,
    symbolPositionsCount: 0
  });
  assert.equal(ctx.openPositionsSourceAvailable, true);
  const b = evaluateTerminalReentryBarrier({
    symbol: "BTCUSDT",
    requestedSide: "long",
    openPositions: ctx.openPositions,
    openPositionsSourceAvailable: ctx.openPositionsSourceAvailable
  });
  assert.equal(b.blocked, false);
  pass("TERMINAL_READY_EMPTY_V2_STATE_ALLOWS");
}

// Positions exist but bridge missing => fail closed
{
  const ctx = resolveTerminalBarrierContext({
    positionStateReady: true,
    symbolPositionsCount: 1
  });
  assert.equal(ctx.openPositionsSourceAvailable, false);
  pass("TERMINAL_BRIDGE_MISSING_WITH_POSITIONS_FAIL_CLOSED");
}

{
  const b = evaluateTerminalReentryBarrier({
    symbol: "BTCUSDT",
    requestedSide: "short",
    openPositions: [],
    openPositionsSourceAvailable: false
  });
  assert.equal(b.blocked, true);
  assert.equal(b.reason, "TERMINAL_STATE_UNAVAILABLE_FAIL_CLOSED");
  pass("TERMINAL_STATE_UNAVAILABLE_FAIL_CLOSED");
}

// Terminal pending blocks even with empty bridge snapshot
{
  const b = evaluateTerminalReentryBarrier({
    symbol: "BTCUSDT",
    requestedSide: "short",
    openPositions: [{
      symbol: "BTCUSDT",
      side: "short",
      openedAt: 1,
      entryPrice: 77000,
      finalizePending: true,
      lifecycleState: "BOT_V2_MANAGED"
    } as any],
    openPositionsSourceAvailable: true
  });
  assert.equal(b.blocked, true);
  pass("TERMINAL_PENDING_BLOCKS_WITH_AUTHORITATIVE_OPENS");
}

// SL-only + TP missing => slOnlyOcoRebuild
{
  const slOnly: ProtectiveAlgoRow = {
    algoId: "sl1",
    algoClOrdId: "slabc",
    instId: "BTC-USDT-SWAP",
    posSide: "short",
    side: "buy",
    tdMode: "cross",
    reduceOnly: true,
    ordType: "conditional",
    sz: "0.5",
    slTriggerPx: "77200"
  };
  const plan = planProtectiveOrderReconcile([slOnly], ctx);
  assert.equal(plan.slOnlyOcoRebuild, true);
  assert.equal(plan.submitOco, true);
  assert.ok(isSlOnlyOcoRebuildScenario({
    submitOco: true,
    hasAuthoritativeSl: true,
    hasAuthoritativeTp: false,
    wantsTp: true
  }));
  pass("SL_ONLY_OCO_REBUILD_PLAN");
}

// Authoritative presence after combined OCO inventory
{
  const oco: ProtectiveAlgoRow = {
    algoId: "oco1",
    algoClOrdId: "ocoabc",
    instId: "BTC-USDT-SWAP",
    posSide: "short",
    side: "buy",
    tdMode: "cross",
    reduceOnly: true,
    ordType: "oco",
    sz: "0.5",
    slTriggerPx: "77200",
    tpTriggerPx: "76800"
  };
  const presence = evaluateAuthoritativeProtectionPresence({
    inventory: [oco],
    reconcileCtx: ctx,
    tpRequired: true
  });
  assert.equal(presence.protectionSatisfied, true);
  pass("COMBINED_OCO_PROTECTION_SATISFIED");
}

// Rebuild proof merge — submit fail + restore success shape
{
  const proof = mergeRebuildTransactionProof(
    { symbol: "BTCUSDT", side: "short", oldSlAlgoId: "sl_old" },
    {
      oldCancelAttempted: true,
      oldCancelSucceeded: true,
      newCombinedSubmitAttempted: true,
      newCombinedSubmitSucceeded: false,
      restoreAttempted: true,
      restoreSucceeded: true,
      finalSlPresent: true,
      finalTpPresent: false,
      finalProtectionSatisfied: true,
      hardBlockApplied: false
    }
  );
  assert.equal(proof.restoreSucceeded, true);
  assert.equal(proof.hardBlockApplied, false);
  pass("REBUILD_RESTORE_SUCCESS_PROOF_SHAPE");
}

// Rebuild proof — restore fail => hard block
{
  const proof = mergeRebuildTransactionProof(
    { symbol: "BTCUSDT", side: "short" },
    { restoreAttempted: true, restoreSucceeded: false, hardBlockApplied: true, finalProtectionSatisfied: false }
  );
  assert.equal(proof.hardBlockApplied, true);
  pass("REBUILD_RESTORE_FAIL_HARD_BLOCK");
}

// Pre-entry: TREND TP missing blocks when TP is required
{
  const plan = evaluatePreEntryProtectionPlan({
    symbol: "BTCUSDT",
    side: "short",
    entryReferencePrice: 77000,
    slPrice: 77200,
    tpPrice: null,
    isV2Authority: true,
    regime: "TREND",
    takeProfitRequired: true,
    tickSz: 0.1
  });
  assert.equal(plan.entryBlocked, true);
  assert.equal(plan.blockReason, "V2_TREND_TP_PRICE_UNAVAILABLE");
  pass("PRE_ENTRY_TREND_TP_MISSING_BLOCK");
}

// Pre-entry: invalid TP direction for SHORT
{
  const plan = evaluatePreEntryProtectionPlan({
    symbol: "BTCUSDT",
    side: "short",
    entryReferencePrice: 77000,
    slPrice: 77200,
    tpPrice: 77500,
    isV2Authority: true,
    regime: "TREND",
    tickSz: 0.1
  });
  assert.equal(plan.entryBlocked, true);
  assert.equal(plan.blockReason, "PRE_ENTRY_SL_TP_DIRECTION_INVALID");
  pass("PRE_ENTRY_INVALID_TP_DIRECTION_BLOCK");
}

// Pre-entry: valid SL+TP allows
{
  const plan = evaluatePreEntryProtectionPlan({
    symbol: "BTCUSDT",
    side: "short",
    entryReferencePrice: 77000,
    slPrice: 77200,
    tpPrice: 76500,
    isV2Authority: true,
    regime: "TREND",
    tickSz: 0.1
  });
  assert.equal(plan.protectionPlanReady, true);
  assert.equal(plan.entryBlocked, false);
  pass("PRE_ENTRY_VALID_SL_TP_ALLOW");
}

assert.ok(buildPreEntryProtectionPlanProof({ symbol: "BTCUSDT" }).event === "V2_PRE_ENTRY_PROTECTION_PLAN_PROOF");

// 51088 retry suppress same evidence
{
  __clearAll51088RecoveryStateForTests();
  const cycle = "cycle_a";
  const hash = compute51088EvidenceHash({
    errorCode: "51088",
    existingAlgoCount: 1,
    canonicalSlFound: true,
    canonicalTpFound: false,
    repairAction: "combined_oco_rebuild"
  });
  record51088RecoveryAttempt({
    positionCycleId: cycle,
    symbol: "BTCUSDT",
    side: "short",
    nowMs: 1000,
    evidenceHash: hash,
    repairPlan: "combined_oco_rebuild",
    inventoryRequeryCompleted: true,
    recoveryInProgress: true,
    nextRetryAtMs: 5000
  });
  const suppress = shouldSuppress51088Resubmit({
    positionCycleId: cycle,
    nowMs: 2000,
    evidenceHash: hash,
    emergencyUnprotected: false
  });
  assert.equal(suppress.suppress, true);
  pass("51088_SAME_EVIDENCE_SUPPRESSED");
}

// 51088 cycle reset allows retry
{
  reset51088RecoveryState("cycle_a");
  const suppress = shouldSuppress51088Resubmit({
    positionCycleId: "cycle_b",
    nowMs: 2000,
    evidenceHash: "new",
    emergencyUnprotected: false
  });
  assert.equal(suppress.suppress, false);
  pass("51088_NEW_CYCLE_NO_SUPPRESS");
}

__clearAll51088RecoveryStateForTests();
console.log("\nALL P0 HARDENING FOLLOW-UP TESTS PASSED");
