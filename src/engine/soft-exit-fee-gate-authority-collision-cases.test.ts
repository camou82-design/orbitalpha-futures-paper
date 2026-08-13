import { evaluatePaperCloseSoftExitFeeGate } from "../engine-v2/exit/soft-exit-fee-live-bridge";
import { evaluateV2ExitExecutionGate } from "../engine-v2/exit/exit-execution-gate";
import { evaluateV2ExitSovereigntyGuard } from "../engine-v2/exit/exit-sovereignty-guard";
import {
  resolvePaperSoftExitSubmitDecision,
  simulateExitCycleSubmitCount
} from "../engine-v2/exit/soft-exit-fee-authority-collision";

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

function runCases(): void {
  const feeRate = 0.0005;
  const notional = 100;
  const entryPrice = 100_000;
  const markApprove = entryPrice * 1.0025;
  const markHold = entryPrice * 1.0008;

  // CASE A — candidate_lost + fee APPROVE + V2 HOLD → submit 0
  {
    const fee = evaluatePaperCloseSoftExitFeeGate({
      closeReason: "candidate_lost",
      closeSource: "candidate_lost_watchdog",
      positionSide: "long",
      entryPrice,
      markPrice: markApprove,
      positionNotionalUsd: notional,
      feeRate
    });
    assertTrue(fee.proceed, "CASE A fee proceed");
    const decision = resolvePaperSoftExitSubmitDecision({
      feeGateProceed: fee.proceed,
      isV2AuthorityPosition: true,
      v2ShouldExit: false
    });
    assertFalse(decision.allowSubmit, "CASE A submit blocked");
    assertEq(decision.blockReason, "v2_exit_sovereignty_hold", "CASE A block reason");
    assertEq(
      simulateExitCycleSubmitCount({
        v2ShouldExit: false,
        isV2AuthorityPosition: true,
        candidateLostEligible: true,
        feeGateProceed: fee.proceed
      }),
      0,
      "CASE A cycle submit count"
    );
  }

  // CASE B — candidate_lost + fee HOLD_RECHECK → submit 0
  {
    const fee = evaluatePaperCloseSoftExitFeeGate({
      closeReason: "candidate_lost",
      closeSource: "candidate_lost_watchdog",
      positionSide: "long",
      entryPrice,
      markPrice: markHold,
      positionNotionalUsd: notional,
      feeRate
    });
    assertFalse(fee.proceed, "CASE B fee blocked");
    const decision = resolvePaperSoftExitSubmitDecision({
      feeGateProceed: fee.proceed,
      isV2AuthorityPosition: true,
      v2ShouldExit: false
    });
    assertFalse(decision.allowSubmit, "CASE B submit blocked");
    assertEq(decision.blockReason, "soft_exit_fee_hold_recheck", "CASE B block reason");
  }

  // CASE C — candidate_lost + fee APPROVE + V2 FULL_EXIT → submit 1 (V2 early path)
  {
    assertEq(
      simulateExitCycleSubmitCount({
        v2ShouldExit: true,
        isV2AuthorityPosition: true,
        candidateLostEligible: true,
        feeGateProceed: true
      }),
      1,
      "CASE C single V2 submit"
    );
    const gate = evaluateV2ExitExecutionGate({
      symbol: "BTCUSDT",
      side: "long",
      requestedAction: "close",
      requestedReason: "v2_exit_authority",
      isV2Managed: true,
      v2ShouldExit: true,
      v2ShouldReduce: false,
      v2ShouldPartial: false,
      actualStopBreached: false,
      actualPositionExists: true
    });
    assertTrue(gate.allowed, "CASE C V2 exit gate allowed");
  }

  // CASE D — paper close + V2 exit both eligible → submit 1 (early takeover wins)
  {
    assertEq(
      simulateExitCycleSubmitCount({
        v2ShouldExit: true,
        isV2AuthorityPosition: true,
        candidateLostEligible: true,
        feeGateProceed: true
      }),
      1,
      "CASE D no double submit"
    );
  }

  // CASE E — V2 HOLD + softExitFeeGateApproved must NOT bypass execution gate
  {
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
      actualPositionExists: true
    });
    assertFalse(gate.allowed, "CASE E execution gate blocked");
    assertEq(gate.blockReason, "v2_exit_sovereignty_hold", "CASE E block reason");
    const sovereignty = evaluateV2ExitSovereigntyGuard({
      symbol: "BTCUSDT",
      side: "long",
      isV2AuthorityPosition: true,
      v2ExitAuthorityAvailable: true,
      v2ShouldExit: false,
      v2ExitAction: "none",
      paperCandidateAction: "close",
      paperCandidateReason: "candidate_lost",
      actualStopBreached: false
    });
    assertFalse(sovereignty.overrideAllowed, "CASE E sovereignty blocked");
  }

  // CASE F — SL hard exit bypasses fee gate and sovereignty via stop breach
  {
    const gate = evaluateV2ExitExecutionGate({
      symbol: "BTCUSDT",
      side: "long",
      requestedAction: "close",
      requestedReason: "stop_loss",
      isV2Managed: true,
      v2ShouldExit: false,
      v2ShouldReduce: false,
      v2ShouldPartial: false,
      actualStopBreached: true,
      actualPositionExists: true
    });
    assertTrue(gate.allowed, "CASE F SL allowed");
    const sovereignty = evaluateV2ExitSovereigntyGuard({
      symbol: "BTCUSDT",
      side: "long",
      isV2AuthorityPosition: true,
      v2ExitAuthorityAvailable: true,
      v2ShouldExit: false,
      v2ExitAction: "none",
      paperCandidateAction: "close",
      paperCandidateReason: "stop_loss",
      actualStopBreached: true
    });
    assertTrue(sovereignty.overrideAllowed, "CASE F sovereignty SL allowed");
  }

  console.info(JSON.stringify({
    event: "SOFT_EXIT_FEE_GATE_AUTHORITY_COLLISION_CASES_PASS",
    cases: ["A", "B", "C", "D", "E", "F"]
  }));
}

runCases();
