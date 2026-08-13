import {
  evaluatePaperCloseSoftExitFeeGate,
  evaluateV2ExitPolicySoftExitFeeGate
} from "../engine-v2/exit/soft-exit-fee-live-bridge";
import {
  mapPaperCloseToSoftExitFeeGateReason,
  mapV2ExitPolicyToSoftExitFeeGateReason
} from "../engine-v2/exit/soft-exit-fee-reason-map";
import { evaluateV2ExitExecutionGate } from "../engine-v2/exit/exit-execution-gate";

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

  // INT1 — live candidate_lost mapping + gross +0.08% → HOLD_RECHECK
  {
    assertEq(
      mapPaperCloseToSoftExitFeeGateReason({
        closeReason: "candidate_lost",
        closeSource: "candidate_lost_watchdog"
      }),
      "CANDIDATE_LOST_SOFT_EXIT",
      "INT1 mapping"
    );
    const markPrice = entryPrice * 1.0008;
    const live = evaluatePaperCloseSoftExitFeeGate({
      closeReason: "candidate_lost",
      closeSource: "candidate_lost_watchdog",
      positionSide: "long",
      entryPrice,
      markPrice,
      positionNotionalUsd: notional,
      feeRate
    });
    assertTrue(live.wired, "INT1 wired");
    assertFalse(live.proceed, "INT1 proceed");
    assertEq(live.gate?.gateAction, "HOLD_RECHECK", "INT1 gateAction");
    assertEq(live.gate?.bypassReason, null, "INT1 bypassReason");
    assertEq(live.proof?.gate_action, "HOLD_RECHECK", "INT1 proof gate_action");
    assertEq(live.proof?.mapped_fee_gate_reason, "CANDIDATE_LOST_SOFT_EXIT", "INT1 mapped reason");
    assertEq(live.proof?.authoritative_close_reason, "candidate_lost", "INT1 authoritative reason");
  }

  // INT2 — live candidate_lost + gross +0.25% → FULL_EXIT
  {
    const markPrice = entryPrice * 1.0025;
    const live = evaluatePaperCloseSoftExitFeeGate({
      closeReason: "candidate_lost",
      closeSource: "candidate_lost_watchdog",
      positionSide: "long",
      entryPrice,
      markPrice,
      positionNotionalUsd: notional,
      feeRate
    });
    assertTrue(live.proceed, "INT2 proceed");
    assertTrue(live.softExitFeeGateApproved, "INT2 approved");
    assertEq(live.gate?.gateAction, "FULL_EXIT", "INT2 gateAction");
    assertEq(live.proof?.gate_action, "FULL_EXIT", "INT2 proof gate_action");
  }

  // INT3 — candidate_lost negative gross → bypass, proceed
  {
    const markPrice = entryPrice * 0.998;
    const live = evaluatePaperCloseSoftExitFeeGate({
      closeReason: "candidate_lost",
      closeSource: "candidate_lost_watchdog",
      positionSide: "long",
      entryPrice,
      markPrice,
      positionNotionalUsd: notional,
      feeRate
    });
    assertTrue(live.proceed, "INT3 proceed");
    assertEq(live.gate?.bypassReason, "loss_position", "INT3 bypassReason");
    assertEq(live.proof?.gate_action, "FULL_EXIT", "INT3 proof gate_action");
  }

  // INT4 — trailing/breakeven profit-protection bypass
  {
    const trailing = evaluateV2ExitPolicySoftExitFeeGate({
      policyReason: "PROFIT_PROTECTION_TRAILING_STOP",
      policyAction: "FULL_EXIT",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: 0.0008,
      positionNotionalUsd: notional,
      feeRate,
      exitUrgency: "HIGH"
    });
    assertFalse(trailing.applied, "INT4 trailing not applied");
    assertEq(trailing.bypassReason, "profit_protection_trailing_stop", "INT4 trailing bypass");
    assertEq(trailing.mappedFeeGateReason, "PROFIT_PROTECTION_TRAILING_STOP", "INT4 mapped unchanged");

    const breakeven = evaluateV2ExitPolicySoftExitFeeGate({
      policyReason: "PROFIT_PROTECTION_BREAKEVEN_EXIT",
      policyAction: "FULL_EXIT",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: 0.0005,
      positionNotionalUsd: notional,
      feeRate,
      exitUrgency: "HIGH"
    });
    assertFalse(breakeven.applied, "INT4 breakeven not applied");
    assertEq(breakeven.bypassReason, "profit_protection_breakeven_exit", "INT4 breakeven bypass");
  }

  // INT5 — SL/invalidation/shock/reversal bypass (not reclassified)
  {
    assertEq(
      mapV2ExitPolicyToSoftExitFeeGateReason("PNL_STOP_PROTECT"),
      "PNL_STOP_PROTECT",
      "INT5 pnl stop passthrough"
    );
    assertEq(
      mapV2ExitPolicyToSoftExitFeeGateReason("SHOCK_FULL_EXIT_AGAINST_POSITION"),
      "SHOCK_FULL_EXIT_AGAINST_POSITION",
      "INT5 shock passthrough"
    );
    assertEq(
      mapV2ExitPolicyToSoftExitFeeGateReason("TREND_FULL_EXIT_EMA60_INVALID"),
      "TREND_FULL_EXIT_EMA60_INVALID",
      "INT5 invalidation passthrough"
    );

    const shock = evaluateV2ExitPolicySoftExitFeeGate({
      policyReason: "SHOCK_FULL_EXIT_AGAINST_POSITION",
      policyAction: "FULL_EXIT",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: 0.0008,
      positionNotionalUsd: notional,
      feeRate,
      exitUrgency: "CRITICAL"
    });
    assertFalse(shock.applied, "INT5 shock not applied");
    assertEq(shock.bypassReason, "not_fee_gate_eligible_reason", "INT5 shock bypass reason");

    const invalidation = evaluateV2ExitPolicySoftExitFeeGate({
      policyReason: "TREND_FULL_EXIT_EMA60_INVALID",
      policyAction: "FULL_EXIT",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: 0.0008,
      positionNotionalUsd: notional,
      feeRate,
      exitUrgency: "HIGH",
      invalidationBreachConfirmed: true
    });
    assertFalse(invalidation.applied, "INT5 invalidation not applied");
    assertEq(invalidation.bypassReason, "not_fee_gate_eligible_reason", "INT5 invalidation bypass reason");
  }

  // INT6 — weak quality regime explicit mapping
  {
    assertEq(
      mapPaperCloseToSoftExitFeeGateReason({
        closeReason: "regime_exit",
        closeSource: "range_reversal_logic"
      }),
      "WEAK_QUALITY_REGIME_SOFT_EXIT",
      "INT6 regime mapping"
    );
    assertEq(
      mapPaperCloseToSoftExitFeeGateReason({
        closeReason: "regime_exit",
        closeSource: "range_structural_engine"
      }),
      null,
      "INT6 structural source not mapped"
    );
  }

  // INT7 — fee-gate approval alone cannot bypass V2 sovereignty execution gate
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
    assertFalse(gate.allowed, "INT7 blocked without V2 exit authority");
    assertEq(gate.blockReason, "v2_exit_sovereignty_hold", "INT7 block reason");
  }

  console.info(JSON.stringify({
    event: "SOFT_EXIT_FEE_GATE_LIVE_CASES_PASS",
    cases: ["INT1", "INT2", "INT3", "INT4", "INT5", "INT6", "INT7"]
  }));
}

runCases();
