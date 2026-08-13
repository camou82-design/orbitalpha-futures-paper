import {
  applySoftExitFeeGate,
  computeGrossReturnPct,
  computeSoftExitFeeBreakEvenPct,
  isHardV2FullExitBypass,
  isProfitProtectionFeeGateBypass,
  isSoftExitFeeGateEligible
} from "../engine-v2/exit/soft-exit-fee-gate";

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
  const feeBreakEven = computeSoftExitFeeBreakEvenPct({
    positionNotionalUsd: notional,
    feeRate,
    entryFeeUsd: notional * feeRate,
    slippageBufferPct: 0.0008
  });
  assertTrue(feeBreakEven > 0.001 && feeBreakEven < 0.0025, "CASE feeBreakEven range");

  // CASE 1 — +0.08% trailing stop → profit-protection bypass, EXIT allowed
  {
    assertTrue(isProfitProtectionFeeGateBypass("PROFIT_PROTECTION_TRAILING_STOP"), "CASE1 profit protection bypass");
    const gate = applySoftExitFeeGate({
      action: "FULL_EXIT",
      reason: "PROFIT_PROTECTION_TRAILING_STOP",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: 0.0008,
      positionNotionalUsd: notional,
      feeRate,
      entryFeeUsd: notional * feeRate,
      exitUrgency: "HIGH",
      oppositeHysteresisState: "NONE"
    });
    assertFalse(gate.applied, "CASE1 not applied");
    assertTrue(gate.shouldExit, "CASE1 shouldExit");
    assertEq(gate.gateAction, "FULL_EXIT", "CASE1 gateAction");
    assertEq(gate.bypassReason, "profit_protection_trailing_stop", "CASE1 bypassReason");
  }

  // CASE 2 — +0.05% breakeven protection exit → bypass, EXIT allowed
  {
    const gate = applySoftExitFeeGate({
      action: "FULL_EXIT",
      reason: "PROFIT_PROTECTION_BREAKEVEN_EXIT",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: 0.0005,
      positionNotionalUsd: notional,
      feeRate,
      entryFeeUsd: notional * feeRate,
      exitUrgency: "HIGH"
    });
    assertFalse(gate.applied, "CASE2 not applied");
    assertTrue(gate.shouldExit, "CASE2 shouldExit");
    assertEq(gate.bypassReason, "profit_protection_breakeven_exit", "CASE2 bypassReason");
  }

  // CASE 3 — +0.08% candidate_lost → HOLD_RECHECK
  {
    assertTrue(isSoftExitFeeGateEligible("CANDIDATE_LOST_SOFT_EXIT"), "CASE3 eligible");
    const gate = applySoftExitFeeGate({
      action: "FULL_EXIT",
      reason: "CANDIDATE_LOST_SOFT_EXIT",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: 0.0008,
      positionNotionalUsd: notional,
      feeRate,
      entryFeeUsd: notional * feeRate,
      exitUrgency: "MID"
    });
    assertTrue(gate.applied, "CASE3 applied");
    assertEq(gate.action, "HOLD", "CASE3 action");
    assertEq(gate.reason, "SOFT_EXIT_FEE_HOLD_RECHECK", "CASE3 reason");
    assertEq(gate.gateAction, "HOLD_RECHECK", "CASE3 gateAction");
    assertFalse(gate.shouldExit, "CASE3 shouldExit");
    assertEq(gate.bypassReason, null, "CASE3 bypassReason");
  }

  // CASE 4 — +0.25% candidate_lost → FULL_EXIT allowed (above fee break-even)
  {
    const gate = applySoftExitFeeGate({
      action: "FULL_EXIT",
      reason: "CANDIDATE_LOST_SOFT_EXIT",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: 0.0025,
      positionNotionalUsd: notional,
      feeRate,
      entryFeeUsd: notional * feeRate,
      exitUrgency: "MID"
    });
    assertFalse(gate.applied, "CASE4 not applied");
    assertTrue(gate.shouldExit, "CASE4 shouldExit");
    assertEq(gate.gateAction, "FULL_EXIT", "CASE4 gateAction");
    assertTrue(gate.grossReturnPct > gate.feeBreakEvenPct, "CASE4 gross above break-even");
  }

  // CASE 5 — negative pnl → fee gate bypass, existing exit
  {
    const gate = applySoftExitFeeGate({
      action: "FULL_EXIT",
      reason: "CANDIDATE_LOST_SOFT_EXIT",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: -0.002,
      positionNotionalUsd: notional,
      feeRate,
      exitUrgency: "HIGH"
    });
    assertFalse(gate.applied, "CASE5 loss not gated");
    assertTrue(gate.shouldExit, "CASE5 exit allowed");
    assertEq(gate.bypassReason, "loss_position", "CASE5 bypassReason");
  }

  // CASE 6 — hard shock bypass
  {
    assertTrue(
      isHardV2FullExitBypass({
        reason: "SHOCK_FULL_EXIT_AGAINST_POSITION",
        exitUrgency: "CRITICAL",
        grossReturnPct: 0.001
      }),
      "CASE6 shock bypass"
    );
    const gate = applySoftExitFeeGate({
      action: "FULL_EXIT",
      reason: "SHOCK_FULL_EXIT_AGAINST_POSITION",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: 0.001,
      positionNotionalUsd: notional,
      feeRate,
      exitUrgency: "CRITICAL"
    });
    assertFalse(gate.applied, "CASE6 gate not applied");
    assertEq(gate.bypassReason, "not_fee_gate_eligible_reason", "CASE6 not eligible reason bypass");
  }

  // CASE 7 — invalidation / SL hard bypass
  {
    assertTrue(
      isHardV2FullExitBypass({
        reason: "PNL_STOP_PROTECT",
        exitUrgency: "CRITICAL",
        grossReturnPct: 0.0005
      }),
      "CASE7 pnl stop bypass"
    );
    assertTrue(
      isHardV2FullExitBypass({
        reason: "RANGE_FULL_EXIT_BOX_BREAK",
        exitUrgency: "HIGH",
        invalidationBreachConfirmed: true,
        grossReturnPct: 0.0008
      }),
      "CASE7 box break bypass"
    );
  }

  // CASE 8 — weak quality-regime eligible below break-even → HOLD_RECHECK
  {
    assertTrue(isSoftExitFeeGateEligible("WEAK_QUALITY_REGIME_SOFT_EXIT"), "CASE8 eligible");
    const gate = applySoftExitFeeGate({
      action: "FULL_EXIT",
      reason: "WEAK_QUALITY_REGIME_SOFT_EXIT",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: 0.001,
      positionNotionalUsd: notional,
      feeRate,
      entryFeeUsd: notional * feeRate,
      exitUrgency: "MID"
    });
    assertTrue(gate.applied, "CASE8 applied");
    assertEq(gate.gateAction, "HOLD_RECHECK", "CASE8 gateAction");
  }

  // CASE 9 — general soft full exit not in whitelist → bypass
  {
    const gate = applySoftExitFeeGate({
      action: "FULL_EXIT",
      reason: "TREND_FULL_EXIT_EMA60_INVALID",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: 0.0008,
      positionNotionalUsd: notional,
      feeRate,
      exitUrgency: "HIGH"
    });
    assertFalse(gate.applied, "CASE9 not applied");
    assertEq(gate.bypassReason, "not_fee_gate_eligible_reason", "CASE9 bypassReason");
  }

  // CASE 10 — partial exit unaffected
  {
    const gate = applySoftExitFeeGate({
      action: "PARTIAL_TAKE_PROFIT",
      reason: "TREND_WEAKNESS_REDUCE_30PCT",
      shouldExit: false,
      shouldReduce: false,
      shouldPartial: true,
      reduceRatio: 0.3,
      grossReturnPct: 0.001,
      positionNotionalUsd: notional,
      feeRate,
      exitUrgency: "MID"
    });
    assertFalse(gate.applied, "CASE10 partial unaffected");
    assertFalse(gate.evaluated, "CASE10 not evaluated");
    assertTrue(gate.shouldPartial, "CASE10 shouldPartial");
  }

  // CASE 11 — proof fields populated on evaluation
  {
    const gate = applySoftExitFeeGate({
      action: "FULL_EXIT",
      reason: "GENERAL_SOFT_FULL_EXIT",
      shouldExit: true,
      shouldReduce: false,
      shouldPartial: false,
      reduceRatio: 1,
      grossReturnPct: 0.001,
      positionNotionalUsd: notional,
      feeRate,
      entryFeeUsd: notional * feeRate,
      slippageBufferPct: 0.0008,
      exitUrgency: "MID"
    });
    assertTrue(gate.evaluated, "CASE11 evaluated");
    assertEq(gate.slippageBufferPct, 0.0008, "CASE11 slippage unchanged");
    assertTrue(gate.entryFeePct > 0, "CASE11 entryFeePct");
    assertTrue(gate.exitFeePct > 0, "CASE11 exitFeePct");
    assertTrue(gate.feeBreakEvenPct > gate.entryFeePct + gate.exitFeePct, "CASE11 feeBreakEven includes slippage");
  }

  // CASE 12 — gross return from mark price (long)
  {
    const gross = computeGrossReturnPct({
      positionSide: "long",
      entryPrice: 3000,
      markPrice: 3003,
      reportedPnlPct: 0
    });
    assertTrue(Math.abs(gross - 0.001) < 1e-9, "CASE12 gross from mark");
  }

  console.info(JSON.stringify({
    event: "SOFT_EXIT_FEE_GATE_CASES_PASS",
    cases: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]
  }));
}

runCases();
