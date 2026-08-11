import type { PaperOpenPositionRecord } from "../models/types";
import {
  recordAuthoritativeFlatZeroObservation,
  shouldPerformAuthoritativeFlatReconcile,
  AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED,
  resolveAuthoritativeFlatCloseAttribution
} from "../engine-v2/position/authoritative-flat-reconcile";
import { classifyPositionSizeDelta } from "../engine-v2/position/manual-reduce-rebase";
import { resolveV2CloseContractAuthority } from "../engine-v2/execution/close-contract-authority";
import { evaluateReduceProtectiveReensure } from "../engine-v2/execution/reduce-protective-reensure";
import {
  evaluateV2ExitExecutionGate,
  inferExitExecutionRequestedAction
} from "../engine-v2/exit/exit-execution-gate";
import { evaluateStaleLedgerExecutionSuppression } from "../engine-v2/position/stale-ledger-execution-guard";

function assertTrue(v: boolean, label: string): void {
  if (!v) throw new Error(`${label}: expected true`);
}

function assertFalse(v: boolean, label: string): void {
  if (v) throw new Error(`${label}: expected false`);
}

function assertEq<T>(a: T, b: T, label: string): void {
  if (a !== b) throw new Error(`${label}: expected ${String(b)}, got ${String(a)}`);
}

function assertNear(a: number, b: number, tol: number, label: string): void {
  if (Math.abs(a - b) > tol) throw new Error(`${label}: expected ~${b}, got ${a}`);
}

function v2Ledger(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    symbol: "BTCUSDT",
    side: "long",
    openedAt: 1,
    entryPrice: 64231.9,
    sizeUsd: 13.475,
    okxContracts: 0.2,
    isV2Authority: true,
    authoritySourceAtEntry: "v2",
    exchangeClOrdId: "pbtc001",
    ...overrides
  } as PaperOpenPositionRecord;
}

// CASE A — ledger BTC long, OKX actual 0, 2 consecutive zero confirms → prune path, no orders
{
  let count = 0;
  count = recordAuthoritativeFlatZeroObservation({
    key: "BTCUSDT:long",
    authoritativeFetchReady: true,
    okxActualExists: false,
    priorCount: count
  });
  assertEq(count, 1, "CASE A first zero count");
  assertFalse(
    shouldPerformAuthoritativeFlatReconcile({
      authoritativeFetchReady: true,
      ledgerExists: true,
      okxActualExists: false,
      zeroConfirmCount: count
    }),
    "CASE A no prune on first zero"
  );

  count = recordAuthoritativeFlatZeroObservation({
    key: "BTCUSDT:long",
    authoritativeFetchReady: true,
    okxActualExists: false,
    priorCount: count
  });
  assertEq(count, AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED, "CASE A second zero count");
  assertTrue(
    shouldPerformAuthoritativeFlatReconcile({
      authoritativeFetchReady: true,
      ledgerExists: true,
      okxActualExists: false,
      zeroConfirmCount: count
    }),
    "CASE A prune on second zero"
  );

  const guard = evaluateStaleLedgerExecutionSuppression({
    symbol: "BTCUSDT",
    side: "long",
    authoritativePositionsReady: true,
    actualKeyExists: false,
    ledgerKeyExists: true
  });
  assertTrue(guard.suppressed, "CASE A stale ledger suppresses close submit");
}

// CASE B — paper 0.20 / actual 0.19, no bot fill evidence → MANUAL_REDUCE_REBASE
{
  const delta = classifyPositionSizeDelta({
    beforeContracts: 0.2,
    afterContracts: 0.19,
    ledger: v2Ledger({ okxContracts: 0.2 }),
    botManaged: true,
    nowMs: Date.now()
  });
  assertEq(delta.classification, "MANUAL_REDUCE_REBASE", "CASE B classification");
  assertFalse(delta.botFillEvidenceFound, "CASE B no bot evidence");
}

// CASE C — paper 0.20 / actual 0.19 with matching bot partial fill evidence → BOT_REDUCE_RECONCILE
{
  const delta = classifyPositionSizeDelta({
    beforeContracts: 0.2,
    afterContracts: 0.19,
    ledger: v2Ledger({
      okxContracts: 0.2,
      partialPendingProcessedContracts: 0.01,
      lifecycleState: "PARTIAL_PENDING"
    }),
    botManaged: true,
    nowMs: Date.now()
  });
  assertEq(delta.classification, "BOT_REDUCE_RECONCILE", "CASE C classification");
  assertTrue(delta.botFillEvidenceFound, "CASE C bot evidence");
}

// CASE D — paper 0.20 / actual 0.25, no bot addon → MANUAL_INCREASE
{
  const delta = classifyPositionSizeDelta({
    beforeContracts: 0.2,
    afterContracts: 0.25,
    ledger: v2Ledger({ okxContracts: 0.2 }),
    botManaged: true,
    nowMs: Date.now()
  });
  assertEq(delta.classification, "MANUAL_INCREASE", "CASE D classification");
}

// CASE E — actual position 0 → no protective fault path for zero exposure (gate blocks close)
{
  const auth = resolveV2CloseContractAuthority({
    symbol: "BTCUSDT",
    side: "long",
    closeKind: "full",
    okxActualContracts: 0,
    okxActualAvailable: true,
    ledgerContracts: 0.19,
    isV2Authority: true,
    fullClose: true
  });
  assertFalse(auth.submitAllowed, "CASE E no close when actual zero");
  assertEq(auth.blockReason, "NO_POSITION_TO_CLOSE", "CASE E block reason");

  const gate = evaluateV2ExitExecutionGate({
    symbol: "BTCUSDT",
    side: "long",
    requestedAction: "close",
    requestedReason: "stop_loss",
    isV2Managed: true,
    v2ShouldExit: false,
    v2ShouldReduce: false,
    v2ShouldPartial: false,
    actualStopBreached: false,
    actualPositionExists: false
  });
  assertFalse(gate.allowed, "CASE E gate blocks without actual position");
}

// CASE F — V2 HOLD + candidate_lost → close blocked
{
  const action = inferExitExecutionRequestedAction({ reason: "candidate_lost" });
  assertEq(action, "close", "CASE F inferred close action");
  const gate = evaluateV2ExitExecutionGate({
    symbol: "BTCUSDT",
    side: "long",
    requestedAction: action,
    requestedReason: "candidate_lost",
    isV2Managed: true,
    v2ShouldExit: false,
    v2ShouldReduce: false,
    v2ShouldPartial: false,
    actualStopBreached: false,
    actualPositionExists: true
  });
  assertFalse(gate.allowed, "CASE F candidate_lost blocked under V2 hold");
  assertEq(gate.blockReason, "v2_exit_sovereignty_hold", "CASE F block reason");
}

// CASE G — V2 full close actual=0.19 ledger=0.21 → close exactly 0.19
{
  const auth = resolveV2CloseContractAuthority({
    symbol: "BTCUSDT",
    side: "long",
    closeKind: "full",
    okxActualContracts: 0.19,
    okxActualAvailable: true,
    ledgerContracts: 0.21,
    isV2Authority: true,
    fullClose: true
  });
  assertNear(auth.selectedContracts, 0.19, 1e-8, "CASE G selected contracts");
  assertTrue(auth.submitAllowed, "CASE G submit allowed");
}

// CASE H — V2 full close actual authority unavailable → submit blocked, no ledger fallback
{
  const auth = resolveV2CloseContractAuthority({
    symbol: "BTCUSDT",
    side: "long",
    closeKind: "full",
    okxActualContracts: null,
    okxActualAvailable: false,
    ledgerContracts: 0.21,
    isV2Authority: true,
    fullClose: true
  });
  assertFalse(auth.submitAllowed, "CASE H blocked without authority");
  assertEq(auth.blockReason, "v2_actual_contract_authority_unavailable", "CASE H block reason");
  assertNear(auth.selectedContracts, 0, 1e-8, "CASE H zero selected");
}

// REDUCE protective re-ensure — 0.21 -> 0.19, protective missing => actual-contract reensure
{
  const reensure = evaluateReduceProtectiveReensure({
    open: v2Ledger({ okxContracts: 0.19, stopPrice: 63000, targetPrice1: 66000 }),
    actualContracts: 0.19,
    instId: "BTC-USDT-SWAP",
    pending: [],
    algos: []
  });
  assertTrue(reensure.reensureNeeded, "REDUCE reensure needed when protective missing");
  assertNear(reensure.actualContracts, 0.19, 1e-8, "REDUCE uses actual contracts authority");
  assertFalse(reensure.validProtectivePresent, "REDUCE missing protective detected");
}

// FLAT close attribution — bot final close evidence
{
  const nowMs = Date.now();
  const botFlat = resolveAuthoritativeFlatCloseAttribution({
    ledger: v2Ledger({
      lastBotExecutionAt: nowMs - 1_000,
      lastBotExecutionReason: "executor_v2_exit_authority"
    }),
    nowMs
  });
  assertEq(botFlat.attribution, "BOT_FULL_CLOSE_RECONCILE", "flat bot full close");
  assertTrue(botFlat.botFinalFillEvidenceFound, "flat bot evidence");
  assertFalse(botFlat.strategyHistoryAppended, "flat bot no history append");
}

// FLAT close attribution — external manual when no bot evidence
{
  const externalFlat = resolveAuthoritativeFlatCloseAttribution({
    ledger: v2Ledger(),
    nowMs: Date.now()
  });
  assertEq(externalFlat.attribution, "EXTERNAL_MANUAL_FULL_CLOSE", "flat external manual");
  assertFalse(externalFlat.botFinalFillEvidenceFound, "flat external no bot evidence");
  assertFalse(externalFlat.strategyHistoryAppended, "flat external no history append");
}

console.log("v2-position-authority-reset-cases: ALL PASS");
