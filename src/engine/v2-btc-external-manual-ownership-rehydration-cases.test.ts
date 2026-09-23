/**
 * BTC external manual short — ownership rehydration after restart (latch cleared, evidence retained).
 */
import type { PaperOpenPositionRecord } from "../models/types";
import {
  isIndependentExternalManualLifecycle,
  hasIndependentManualLifecycleEvidence
} from "../engine-v2/position/manual-ownership-latch";
import {
  resolvePositionOwnership,
  buildOwnershipRehydrationProof,
  isAutomatedOrderMutationBlockedForOwnership
} from "../engine-v2/position/ownership-resolver";
import { resolvePositionMutationAuthority } from "../engine-v2/position/manual-takeover-authority";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`FAIL [${msg}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL [${msg}]: expected true`);
}

function assertFalse(cond: boolean, msg: string): void {
  if (cond) throw new Error(`FAIL [${msg}]: expected false`);
}

/** Cycle-18-style BTC short after restart: strong evidence persisted, latch/takeover booleans cleared. */
function makeBtcExternalManualShortRestartLedger(): PaperOpenPositionRecord {
  return {
    openedAt: 1_700_000_000_000,
    symbol: "BTCUSDT",
    side: "short",
    entryPrice: 83_819.43605442176,
    leverage: 10,
    sizeUsd: 400,
    initialSizeUsd: 400,
    strategyVersion: "paper-v2",
    sourceSignal: "manual_intervention_fill",
    sourceRunPath: "manual_adoption",
    lifecycleState: "MANUAL_SIZE_AUGMENTED",
    manualAugmentActive: true,
    manualTakeoverActive: false,
    manualTakeoverReason: "EXTERNAL_MANUAL_POSITION",
    manualOwnershipLatch: false,
    manualOwnershipLatchReason: undefined,
    manualOwnershipLatchStrength: undefined,
    manualLifecycleEvidenceIndependent: false,
    reconcileState: "MATCHED",
    status: "open",
    okxContracts: 17.64,
    pos: 17.64,
    isV2Authority: false
  };
}

function runCases(): void {
  console.log("=== V2 BTC EXTERNAL MANUAL OWNERSHIP REHYDRATION CASES ===");

  const ledger = makeBtcExternalManualShortRestartLedger();
  const okxContracts = 17.64;
  const avgPx = 83_819.43605442176;

  assertTrue(isIndependentExternalManualLifecycle(ledger), "CASE 1 independent external lifecycle");
  assertTrue(hasIndependentManualLifecycleEvidence(ledger), "CASE 1 independent evidence despite false flag");
  console.log("[CASE 1] PASS: stored adoption fields recognized");

  const ownership = resolvePositionOwnership({
    symbol: "BTCUSDT",
    side: "short",
    okxActualPositionExists: true,
    okxActualContracts: okxContracts,
    ledger,
    ledgerPaperContracts: okxContracts,
    ledgerEntryPrice: ledger.entryPrice,
    okxAvgPx: avgPx,
    explicitExternalManualEvidence: isIndependentExternalManualLifecycle(ledger),
    symbolExternalManualBlocked: false,
    manualOwnershipLatchActive: false,
    syncStatus: "ALIGNED",
    okxFetchReady: true,
    reconcileState: "MATCHED"
  });

  assertEq(ownership.ownershipClass, "EXTERNAL_MANUAL_MANAGED", "CASE 2 ownership class");
  assertFalse(ownership.ownershipSource === "fail_safe_unclear_ownership", "CASE 2 not fail_safe");
  assertTrue(ownership.externalManualEvidence, "CASE 2 external manual evidence");
  assertTrue(ownership.manualLatchShouldBeActive, "CASE 2 latch should re-arm");
  assertFalse(ownership.normalExitPolicyAllowed, "CASE 2 no bot FULL_EXIT policy");
  assertFalse(ownership.botOrderEvidenceFound, "CASE 2 no bot order evidence");
  console.log("[CASE 2] PASS: ownership resolver EXTERNAL_MANUAL_MANAGED");

  const authority = resolvePositionMutationAuthority({ open: ledger });
  assertEq(authority.effectiveAuthorityOwner, "OPERATOR", "CASE 3 authority owner");
  assertFalse(authority.positionMutationAllowed, "CASE 3 mutation blocked");
  assertFalse(authority.exitCalculationAllowed, "CASE 3 exit calc blocked");
  console.log("[CASE 3] PASS: mutation authority OPERATOR / blocked");

  const mutationBlocked = isAutomatedOrderMutationBlockedForOwnership(ownership);
  assertTrue(mutationBlocked, "CASE 4 automated mutation blocked");
  console.log("[CASE 4] PASS: suppressor active (ownership block)");

  const proof = buildOwnershipRehydrationProof(
    {
      symbol: "BTCUSDT",
      side: "short",
      okxActualPositionExists: true,
      okxActualContracts: okxContracts,
      ledger,
      ledgerPaperContracts: okxContracts,
      ledgerEntryPrice: ledger.entryPrice,
      okxAvgPx: avgPx,
      explicitExternalManualEvidence: true,
      symbolExternalManualBlocked: false,
      manualOwnershipLatchActive: false,
      syncStatus: "ALIGNED",
      okxFetchReady: true,
      reconcileState: "MATCHED"
    },
    ownership
  );
  assertTrue(proof.external_manual_evidence === true, "CASE 5 proof external_manual_evidence");
  assertTrue(proof.manual_latch_should_be_active === true, "CASE 5 proof latch should be active");
  console.log("[CASE 5] PASS: rehydration proof fields");

  // ETH bot long must not inherit BTC external-manual predicate
  const ethBot: PaperOpenPositionRecord = {
    ...ledger,
    symbol: "ETHUSDT",
    side: "long",
    lifecycleState: "BOT_V2_MANAGED",
    sourceSignal: "v2",
    sourceRunPath: "live_run",
    manualTakeoverReason: undefined,
    manualAugmentActive: false,
    isV2Authority: true
  };
  assertFalse(isIndependentExternalManualLifecycle(ethBot), "CASE 6 ETH not external manual");
  const ethOwnership = resolvePositionOwnership({
    symbol: "ETHUSDT",
    side: "long",
    okxActualPositionExists: true,
    okxActualContracts: 1,
    ledger: ethBot,
    ledgerPaperContracts: 1,
    ledgerEntryPrice: 3000,
    okxAvgPx: 3000,
    explicitExternalManualEvidence: false,
    symbolExternalManualBlocked: false,
    manualOwnershipLatchActive: false,
    syncStatus: "ALIGNED",
    okxFetchReady: true,
    reconcileState: "MATCHED"
  });
  assertEq(ethOwnership.ownershipClass, "BOT_V2_MANAGED", "CASE 6 ETH remains bot managed");
  console.log("[CASE 6] PASS: ETH regression guard");

  console.log("=== ALL BTC EXTERNAL MANUAL OWNERSHIP REHYDRATION CASES PASSED ===");
}

runCases();
