import type { PaperOpenPositionRecord } from "../models/types";
import {
  recordAuthoritativeFlatZeroObservation,
  shouldPerformAuthoritativeFlatReconcile,
  AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED,
  resolveAuthoritativeFlatCloseAttribution,
  resolveAuthoritativeFlatFinalizePendingAction,
  isAuthoritativeFlatPreflightCandidate,
  isOpenLedgerRow,
  resolveAuthoritativeFlatPreflightOutcome
} from "../engine-v2/position/authoritative-flat-reconcile";
import { isOpenLedgerTerminalCleanupBlocked } from "../engine-v2/lifecycle/pending-finalize";
import { deriveLiveBalanceAuthority } from "../engine-v2/live-account/balance-authority";
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

// FLAT close attribution — candidate_lost intent only, no confirmed fill => external manual
{
  const nowMs = Date.now();
  const intentOnly = resolveAuthoritativeFlatCloseAttribution({
    ledger: v2Ledger({
      lastBotExecutionAt: nowMs - 5_000,
      lastBotExecutionReason: "candidate_lost",
      closePendingReason: "candidate_lost",
      closePendingAt: nowMs - 4_000
    }),
    nowMs
  });
  assertEq(intentOnly.attribution, "EXTERNAL_MANUAL_FULL_CLOSE", "candidate_lost intent only external");
  assertFalse(intentOnly.botFinalFillEvidenceFound, "candidate_lost intent not bot fill");
}

// FLAT close attribution — confirmed BOT_V2 pending finalize final fill
{
  const nowMs = Date.now();
  const botFlat = resolveAuthoritativeFlatCloseAttribution({
    ledger: v2Ledger({
      finalizePending: true,
      pendingFinalizeTradeSource: "BOT_V2",
      pendingFinalizeFinalFillAt: nowMs - 1_000,
      pendingFinalizeExitAvgPx: 64250,
      pendingFinalizeFinalCloseReason: "V2_EXIT"
    }),
    nowMs
  });
  assertEq(botFlat.attribution, "BOT_FULL_CLOSE_RECONCILE", "flat bot pending finalize");
  assertTrue(botFlat.botFinalFillEvidenceFound, "flat bot confirmed finalize fill");
  assertFalse(botFlat.strategyHistoryAppended, "flat bot no history append");
}

// FLAT close attribution — confirmed BOT_V2 position cycle final fill explaining flat
{
  const nowMs = Date.now();
  const botCycleFlat = resolveAuthoritativeFlatCloseAttribution({
    ledger: v2Ledger({
      okxContracts: 0.2,
      positionCycleMaxContracts: 0.2,
      positionCycleExitFills: [
        {
          px: 64250,
          contracts: 0.2,
          pnlUsdNet: 0.5,
          feeUsd: 0.01,
          at: nowMs - 2_000,
          reason: "v2_exit_authority"
        }
      ]
    }),
    nowMs
  });
  assertEq(botCycleFlat.attribution, "BOT_FULL_CLOSE_RECONCILE", "flat bot cycle fill");
  assertTrue(botCycleFlat.botFinalFillEvidenceFound, "flat bot cycle confirmed fill");
}

// FLAT close attribution — external manual when no confirmed fill evidence
{
  const externalFlat = resolveAuthoritativeFlatCloseAttribution({
    ledger: v2Ledger(),
    nowMs: Date.now()
  });
  assertEq(externalFlat.attribution, "EXTERNAL_MANUAL_FULL_CLOSE", "flat external manual");
  assertFalse(externalFlat.botFinalFillEvidenceFound, "flat external no bot evidence");
  assertFalse(externalFlat.strategyHistoryAppended, "flat external no history append");
}

// FLAT tolerance — baseline 0.20 / bot fills 0.19 => external (residual manual close)
{
  const nowMs = Date.now();
  const partialBot = resolveAuthoritativeFlatCloseAttribution({
    ledger: v2Ledger({
      okxContracts: 0.2,
      positionCycleMaxContracts: 0.2,
      positionCycleExitFills: [
        {
          px: 64250,
          contracts: 0.19,
          pnlUsdNet: 0.4,
          feeUsd: 0.01,
          at: nowMs - 2_000,
          reason: "v2_exit_authority"
        }
      ]
    }),
    nowMs
  });
  assertEq(partialBot.attribution, "EXTERNAL_MANUAL_FULL_CLOSE", "0.19/0.20 fill not full bot close");
  assertFalse(partialBot.botFinalFillEvidenceFound, "residual 0.01 not bot explained");
}

// FLAT tolerance — baseline 0.20 / bot fills 0.20 => BOT
{
  const nowMs = Date.now();
  const fullBot = resolveAuthoritativeFlatCloseAttribution({
    ledger: v2Ledger({
      okxContracts: 0.2,
      positionCycleMaxContracts: 0.2,
      positionCycleExitFills: [
        {
          px: 64250,
          contracts: 0.2,
          pnlUsdNet: 0.5,
          feeUsd: 0.01,
          at: nowMs - 2_000,
          reason: "v2_exit_authority"
        }
      ]
    }),
    nowMs
  });
  assertEq(fullBot.attribution, "BOT_FULL_CLOSE_RECONCILE", "0.20/0.20 exact bot close");
  assertTrue(fullBot.botFinalFillEvidenceFound, "exact fill bot evidence");
}

// FLAT tolerance — baseline 0.20 / fills 0.199 within 1% => BOT
{
  const nowMs = Date.now();
  const nearFullBot = resolveAuthoritativeFlatCloseAttribution({
    ledger: v2Ledger({
      okxContracts: 0.2,
      positionCycleMaxContracts: 0.2,
      positionCycleExitFills: [
        {
          px: 64250,
          contracts: 0.199,
          pnlUsdNet: 0.49,
          feeUsd: 0.01,
          at: nowMs - 2_000,
          reason: "v2_exit_authority"
        }
      ]
    }),
    nowMs
  });
  assertEq(nearFullBot.attribution, "BOT_FULL_CLOSE_RECONCILE", "0.199/0.20 within 1% tolerance");
  assertTrue(nearFullBot.botFinalFillEvidenceFound, "near-full fill bot evidence");
}

// A. finalizePending + zeroConfirm=2 + finalize=false => PRUNE
{
  const action = resolveAuthoritativeFlatFinalizePendingAction({
    finalizePending: true,
    authoritativeFetchReady: true,
    zeroConfirmCount: AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED,
    finalizeSucceeded: false
  });
  assertEq(action, "PRUNE_UNRESOLVED_FINALIZE", "CASE A prune unresolved finalize");
}

// B. finalizePending + zeroConfirm=2 + finalize=true => FINALIZE, no duplicate prune
{
  const action = resolveAuthoritativeFlatFinalizePendingAction({
    finalizePending: true,
    authoritativeFetchReady: true,
    zeroConfirmCount: AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED,
    finalizeSucceeded: true
  });
  assertEq(action, "FINALIZE_SUCCEEDED", "CASE B finalize success");
}

// C. finalizePending + zeroConfirm=1 => HOLD
{
  const action = resolveAuthoritativeFlatFinalizePendingAction({
    finalizePending: true,
    authoritativeFetchReady: true,
    zeroConfirmCount: 1,
    finalizeSucceeded: false
  });
  assertEq(action, "HOLD_UNCONFIRMED_ZERO", "CASE C hold on first zero");
}

// D. BTC+ETH stale finalizePending + authoritative positions=[] 2 cycles => both prune eligible
{
  const symbols = ["BTCUSDT:long", "ETHUSDT:long"] as const;
  for (const key of symbols) {
    let count = 0;
    count = recordAuthoritativeFlatZeroObservation({
      key,
      authoritativeFetchReady: true,
      okxActualExists: false,
      priorCount: count
    });
    count = recordAuthoritativeFlatZeroObservation({
      key,
      authoritativeFetchReady: true,
      okxActualExists: false,
      priorCount: count
    });
    const action = resolveAuthoritativeFlatFinalizePendingAction({
      finalizePending: true,
      authoritativeFetchReady: true,
      zeroConfirmCount: count,
      finalizeSucceeded: false
    });
    assertEq(action, "PRUNE_UNRESOLVED_FINALIZE", `CASE D prune ${key}`);
    assertTrue(
      shouldPerformAuthoritativeFlatReconcile({
        authoritativeFetchReady: true,
        ledgerExists: true,
        okxActualExists: false,
        zeroConfirmCount: count
      }),
      `CASE D flat reconcile eligible ${key}`
    );
  }
}

// E. flat authoritative actual=0 => no close submit / no protective fault path
{
  for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
    const guard = evaluateStaleLedgerExecutionSuppression({
      symbol,
      side: "long",
      authoritativePositionsReady: true,
      actualKeyExists: false,
      ledgerKeyExists: true
    });
    assertTrue(guard.suppressed, `CASE E stale suppress ${symbol}`);
    assertTrue(guard.suppressedActions.includes("signed_order_submit"), `CASE E no submit ${symbol}`);
  }
  const gate = evaluateV2ExitExecutionGate({
    symbol: "BTCUSDT",
    side: "long",
    requestedAction: "close",
    requestedReason: "candidate_lost",
    isV2Managed: true,
    v2ShouldExit: false,
    v2ShouldReduce: false,
    v2ShouldPartial: false,
    actualStopBreached: false,
    actualPositionExists: false
  });
  assertFalse(gate.allowed, "CASE E no close when actual flat");
}

// Prune attribution ordering — confirmed pendingFinalize BOT_V2 before cleanup => BOT
{
  const nowMs = Date.now();
  const ledgerBeforePrune = v2Ledger({
    finalizePending: true,
    pendingFinalizeTradeSource: "BOT_V2",
    pendingFinalizeFinalFillAt: nowMs - 1_000,
    pendingFinalizeExitAvgPx: 64250,
    pendingFinalizeFinalCloseReason: "V2_EXIT"
  });
  const action = resolveAuthoritativeFlatFinalizePendingAction({
    finalizePending: true,
    authoritativeFetchReady: true,
    zeroConfirmCount: AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED,
    finalizeSucceeded: false
  });
  assertEq(action, "PRUNE_UNRESOLVED_FINALIZE", "prune path for unresolved finalize");
  const attribution = resolveAuthoritativeFlatCloseAttribution({
    ledger: ledgerBeforePrune,
    nowMs
  });
  assertEq(attribution.attribution, "BOT_FULL_CLOSE_RECONCILE", "prune snapshot bot attribution");
  assertTrue(attribution.botFinalFillEvidenceFound, "pending finalize evidence preserved pre-cleanup");
}

// Prune attribution ordering — no confirmed bot fill before cleanup => EXTERNAL
{
  const nowMs = Date.now();
  const ledgerBeforePrune = v2Ledger({
    finalizePending: true,
    lastBotExecutionAt: nowMs - 1_000,
    lastBotExecutionReason: "candidate_lost"
  });
  const attribution = resolveAuthoritativeFlatCloseAttribution({
    ledger: ledgerBeforePrune,
    nowMs
  });
  assertEq(attribution.attribution, "EXTERNAL_MANUAL_FULL_CLOSE", "prune snapshot external attribution");
  assertFalse(attribution.botFinalFillEvidenceFound, "intent-only not bot attribution");
}

// REG 1 — PARTIAL_ACTIVE + finalizePending + remote absent, zero=1 => HOLD
{
  const ledgerExists = isOpenLedgerRow({ okxContracts: 0.2, status: "open" });
  assertTrue(
    isAuthoritativeFlatPreflightCandidate({
      remotePosExists: false,
      isNew: false,
      lifecycleState: "PARTIAL_ACTIVE",
      ledgerExists
    }),
    "REG 1 PARTIAL_ACTIVE is preflight candidate"
  );
  const outcome = resolveAuthoritativeFlatPreflightOutcome({
    candidate: true,
    authoritativeFetchReady: true,
    ledgerExists,
    zeroConfirmCount: 1,
    finalizePending: true,
    finalizeSucceeded: false
  });
  assertEq(outcome, "HOLD_UNCONFIRMED_ZERO", "REG 1 hold on first zero");
}

// REG 2 — PARTIAL_ACTIVE + finalizePending + remote absent, zero=2, finalize fail => PRUNE
{
  const outcome = resolveAuthoritativeFlatPreflightOutcome({
    candidate: true,
    authoritativeFetchReady: true,
    ledgerExists: true,
    zeroConfirmCount: AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED,
    finalizePending: true,
    finalizeSucceeded: false
  });
  assertEq(outcome, "PRUNE_UNRESOLVED_FINALIZE", "REG 2 prune unresolved finalize");
}

// REG 3 — BOT_V2_MANAGED + pending-not-found scenario + remote absent, zero=1 => HOLD
{
  assertTrue(
    isAuthoritativeFlatPreflightCandidate({
      remotePosExists: false,
      isNew: false,
      lifecycleState: "BOT_V2_MANAGED",
      ledgerExists: true
    }),
    "REG 3 BOT_V2_MANAGED is preflight candidate"
  );
  const outcome = resolveAuthoritativeFlatPreflightOutcome({
    candidate: true,
    authoritativeFetchReady: true,
    ledgerExists: true,
    zeroConfirmCount: 1,
    finalizePending: false,
    finalizeSucceeded: false
  });
  assertEq(outcome, "HOLD_UNCONFIRMED_ZERO", "REG 3 hold on first zero without finalizePending");
}

// REG 4 — BOT_V2_MANAGED + remote absent, zero=2 => PRUNE
{
  const outcome = resolveAuthoritativeFlatPreflightOutcome({
    candidate: true,
    authoritativeFetchReady: true,
    ledgerExists: true,
    zeroConfirmCount: AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED,
    finalizePending: false,
    finalizeSucceeded: false
  });
  assertEq(outcome, "PRUNE_ZERO_CONFIRMED", "REG 4 prune on second zero");
}

// REG 5 — remote position reappears => zero counter reset, no prune
{
  let count = AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED;
  count = recordAuthoritativeFlatZeroObservation({
    key: "BTCUSDT:long",
    authoritativeFetchReady: true,
    okxActualExists: true,
    priorCount: count
  });
  assertEq(count, 0, "REG 5 zero counter reset when remote reappears");
  assertFalse(
    shouldPerformAuthoritativeFlatReconcile({
      authoritativeFetchReady: true,
      ledgerExists: true,
      okxActualExists: true,
      zeroConfirmCount: count
    }),
    "REG 5 no prune when remote exists"
  );
  assertFalse(
    isAuthoritativeFlatPreflightCandidate({
      remotePosExists: true,
      isNew: false,
      lifecycleState: "BOT_V2_MANAGED",
      ledgerExists: true
    }),
    "REG 5 not a flat preflight candidate when remote exists"
  );
}

// REG 6 — confirmed BOT final fill => BOT_FULL_CLOSE_RECONCILE
{
  const nowMs = Date.now();
  const botFlat = resolveAuthoritativeFlatCloseAttribution({
    ledger: v2Ledger({
      lifecycleState: "PARTIAL_ACTIVE",
      finalizePending: true,
      pendingFinalizeTradeSource: "BOT_V2",
      pendingFinalizeFinalFillAt: nowMs - 1_000,
      pendingFinalizeExitAvgPx: 64250,
      pendingFinalizeFinalCloseReason: "V2_EXIT"
    }),
    nowMs
  });
  assertEq(botFlat.attribution, "BOT_FULL_CLOSE_RECONCILE", "REG 6 confirmed bot final fill");
}

// REG 7 — candidate_lost intent only => EXTERNAL_MANUAL_FULL_CLOSE
{
  const nowMs = Date.now();
  const intentOnly = resolveAuthoritativeFlatCloseAttribution({
    ledger: v2Ledger({
      lifecycleState: "BOT_V2_MANAGED",
      lastBotExecutionAt: nowMs - 5_000,
      lastBotExecutionReason: "candidate_lost",
      closePendingReason: "candidate_lost",
      closePendingAt: nowMs - 4_000
    }),
    nowMs
  });
  assertEq(intentOnly.attribution, "EXTERNAL_MANUAL_FULL_CLOSE", "REG 7 candidate_lost intent only");
}

// BLOCKER 1 — finalizePending + remote absent + authoritative ready + zero=1 => ledger hold via preflight
{
  const ledger = v2Ledger({ finalizePending: true, lifecycleState: "BOT_V2_MANAGED", status: "open" });
  assertTrue(isOpenLedgerTerminalCleanupBlocked(ledger), "BLOCKER 1 terminal cleanup blocked");
  assertTrue(
    isAuthoritativeFlatPreflightCandidate({
      remotePosExists: false,
      isNew: false,
      lifecycleState: ledger.lifecycleState,
      ledgerExists: isOpenLedgerRow({ okxContracts: ledger.okxContracts, status: ledger.status })
    }),
    "BLOCKER 1 preflight candidate despite finalizePending"
  );
  const outcome = resolveAuthoritativeFlatPreflightOutcome({
    candidate: true,
    authoritativeFetchReady: true,
    ledgerExists: true,
    zeroConfirmCount: 1,
    finalizePending: true,
    finalizeSucceeded: false
  });
  assertEq(outcome, "HOLD_UNCONFIRMED_ZERO", "BLOCKER 1 hold on first zero");
}

// BLOCKER 2 — finalizePending + zero=2 + finalize fail => authoritative prune
{
  const outcome = resolveAuthoritativeFlatPreflightOutcome({
    candidate: true,
    authoritativeFetchReady: true,
    ledgerExists: true,
    zeroConfirmCount: AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED,
    finalizePending: true,
    finalizeSucceeded: false
  });
  assertEq(outcome, "PRUNE_UNRESOLVED_FINALIZE", "BLOCKER 2 prune unresolved finalize");
}

// BLOCKER 3 — finalizePending + zero=2 + finalize success => finalize path
{
  const outcome = resolveAuthoritativeFlatPreflightOutcome({
    candidate: true,
    authoritativeFetchReady: true,
    ledgerExists: true,
    zeroConfirmCount: AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED,
    finalizePending: true,
    finalizeSucceeded: true
  });
  assertEq(outcome, "FINALIZE_SUCCEEDED", "BLOCKER 3 finalize success path");
}

// BLOCKER 4 — PARTIAL_ACTIVE + finalizePending + actual zero => 2-cycle prune
{
  const outcome = resolveAuthoritativeFlatPreflightOutcome({
    candidate: isAuthoritativeFlatPreflightCandidate({
      remotePosExists: false,
      isNew: false,
      lifecycleState: "PARTIAL_ACTIVE",
      ledgerExists: true
    }),
    authoritativeFetchReady: true,
    ledgerExists: true,
    zeroConfirmCount: AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED,
    finalizePending: true,
    finalizeSucceeded: false
  });
  assertEq(outcome, "PRUNE_UNRESOLVED_FINALIZE", "BLOCKER 4 PARTIAL_ACTIVE prune");
}

// BLOCKER 5 — BOT_V2_MANAGED + finalizePending + actual zero => 2-cycle prune
{
  const outcome = resolveAuthoritativeFlatPreflightOutcome({
    candidate: isAuthoritativeFlatPreflightCandidate({
      remotePosExists: false,
      isNew: false,
      lifecycleState: "BOT_V2_MANAGED",
      ledgerExists: true
    }),
    authoritativeFetchReady: true,
    ledgerExists: true,
    zeroConfirmCount: AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED,
    finalizePending: true,
    finalizeSucceeded: false
  });
  assertEq(outcome, "PRUNE_UNRESOLVED_FINALIZE", "BLOCKER 5 BOT_V2_MANAGED prune");
}

// BLOCKER 6 — remotePos exists => not flat preflight candidate, terminal block inactive when remote present
{
  assertFalse(
    isAuthoritativeFlatPreflightCandidate({
      remotePosExists: true,
      isNew: false,
      lifecycleState: "BOT_V2_MANAGED",
      ledgerExists: true
    }),
    "BLOCKER 6 no flat preflight when remote exists"
  );
  const outcome = resolveAuthoritativeFlatPreflightOutcome({
    candidate: false,
    authoritativeFetchReady: true,
    ledgerExists: true,
    zeroConfirmCount: AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED,
    finalizePending: true,
    finalizeSucceeded: false
  });
  assertEq(outcome, "NOT_APPLICABLE", "BLOCKER 6 preflight not applicable with remote");
}

// BLOCKER 7 — pruned positions input => paper balance notional zero
{
  const stalePositions = [
    { symbol: "BTCUSDT", side: "long", sizeUsd: 5.28, leverage: 10 },
    { symbol: "ETHUSDT", side: "long", sizeUsd: 5.29, leverage: 10 }
  ];
  const before = deriveLiveBalanceAuthority({
    okxAuthMode: "demo",
    balancePayload: null,
    balanceFetchError: null,
    okxPositionsPayload: [],
    positions: stalePositions
  });
  assertTrue(
    before.paper_position_estimated_notional_usdt > 0,
    "BLOCKER 7 stale positions contribute notional"
  );
  const after = deriveLiveBalanceAuthority({
    okxAuthMode: "demo",
    balancePayload: null,
    balanceFetchError: null,
    okxPositionsPayload: [],
    positions: []
  });
  assertEq(after.paper_position_estimated_notional_usdt, 0, "BLOCKER 7 pruned positions zero notional");
  assertEq(after.position_margin_lines.length, 0, "BLOCKER 7 no margin lines after prune");
}

console.log("v2-position-authority-reset-cases: ALL PASS");
