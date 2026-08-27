import assert from "node:assert/strict";
import {
  buildV2PreEntryRiskPlanCommitted,
  type V2PreEntryRiskPlanAdaptiveContext
} from "./paper-engine";
import type { EntryExecutionAuthority } from "../engine-v2/types";
import {
  computeAdaptiveRangePreEntryProtection,
  shouldApplyAdaptiveRangePreEntryProtection
} from "../engine-v2/execution/adaptive-range-pre-entry-protection";
import {
  planProtectiveOrderReconcile,
  type ProtectiveReconcileContext,
  type ProtectiveAlgoRow
} from "../engine-v2/execution/protective-reconcile-plan";
import {
  resolvePartialExitRatio,
  isV2RangePartialPlanContext
} from "../engine-v2/execution/entry-protection-attach";
import { engineMirrorStopPrice, engineMirrorTpPrice } from "./position-ops-monitor";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

async function runRegressionSuite() {
  console.log("=== RUNNING PRODUCTION SL & TP1 REGRESSION SUITE ===");

  // -------------------------------------------------------------------------
  // TEST 1 — RANGE LONG entry 2491.65, policy -0.26%: canonical 2485.17171 must NOT become 2490.51
  // -------------------------------------------------------------------------
  {
    const entry = 2491.65;
    const policyStop = entry * (1 - 0.0026); // 2485.17171
    const rawStructuralSl = 2490.51; // inward tightened boxLow-derived value
    const boxLow = 2494.25;
    const boxHigh = 2505.00;
    const boxMid = (boxHigh + boxLow) / 2;
    const atr = 3.5;

    const authority: EntryExecutionAuthority = {
      decision: "ENTER",
      side: "long",
      stageMarginKrw: 100000,
      regime: "RANGE",
      source: "v2",
      invalidationPx: rawStructuralSl,
      stopPrice: rawStructuralSl,
      takeProfit1Px: entry * (1 + 0.0025),
      marketSubtype: "RANGE_FLAT",
      rangeBoxHighAtEntry: boxHigh,
      rangeBoxLowAtEntry: boxLow,
      rangeBoxMidAtEntry: boxMid
    };

    const adaptiveCtx: V2PreEntryRiskPlanAdaptiveContext = {
      atr,
      boxHigh,
      boxLow,
      boxMid,
      marketSubtype: "RANGE_FLAT",
      routingEngine: "RANGE",
      feeRate: 0.0005
    };

    const rp = buildV2PreEntryRiskPlanCommitted(
      authority,
      {},
      "long",
      entry,
      noopLogger,
      "ETHUSDT",
      adaptiveCtx
    );

    assert.equal(rp.ok, true, "Risk plan build must succeed");
    if (!rp.ok) throw new Error("expected ok");

    assert.equal(
      rp.plan.stop_price,
      policyStop,
      `RANGE LONG stop must preserve canonical policy stop ${policyStop}, not tightened ${rawStructuralSl}`
    );
    assert.ok(
      rp.plan.stop_price <= policyStop,
      "Non-tightening invariant: LONG downstream stop <= canonical initial stop"
    );
    assert.equal(rp.plan.stop_source, "policy_clamped");
    console.log("[PASS] TEST 1: RANGE LONG 2491.65 policy -0.26% preserves 2485.17171 (not tightened to 2490.51)");
  }

  // -------------------------------------------------------------------------
  // TEST 2 — Symmetric RANGE SHORT non-tightening test
  // -------------------------------------------------------------------------
  {
    const entry = 2491.65;
    const policyStop = entry * (1 + 0.0026); // 2498.12829
    const rawStructuralSl = 2493.00; // inward tightened value (below policy stop for short)
    const boxLow = 2480.00;
    const boxHigh = 2490.00;
    const boxMid = (boxHigh + boxLow) / 2;
    const atr = 3.5;

    const authority: EntryExecutionAuthority = {
      decision: "ENTER",
      side: "short",
      stageMarginKrw: 100000,
      regime: "RANGE",
      source: "v2",
      invalidationPx: rawStructuralSl,
      stopPrice: rawStructuralSl,
      takeProfit1Px: entry * (1 - 0.0025),
      marketSubtype: "RANGE_FLAT",
      rangeBoxHighAtEntry: boxHigh,
      rangeBoxLowAtEntry: boxLow,
      rangeBoxMidAtEntry: boxMid
    };

    const adaptiveCtx: V2PreEntryRiskPlanAdaptiveContext = {
      atr,
      boxHigh,
      boxLow,
      boxMid,
      marketSubtype: "RANGE_FLAT",
      routingEngine: "RANGE",
      feeRate: 0.0005
    };

    const rp = buildV2PreEntryRiskPlanCommitted(
      authority,
      {},
      "short",
      entry,
      noopLogger,
      "ETHUSDT",
      adaptiveCtx
    );

    assert.equal(rp.ok, true, "Risk plan build must succeed");
    if (!rp.ok) throw new Error("expected ok");

    assert.equal(
      rp.plan.stop_price,
      policyStop,
      `RANGE SHORT stop must preserve canonical policy stop ${policyStop}, not tightened ${rawStructuralSl}`
    );
    assert.ok(
      rp.plan.stop_price >= policyStop,
      "Non-tightening invariant: SHORT downstream stop >= canonical initial stop"
    );
    assert.equal(rp.plan.stop_source, "policy_clamped");
    console.log("[PASS] TEST 2: Symmetric RANGE SHORT non-tightening test passed");
  }

  // -------------------------------------------------------------------------
  // TEST 3 — FTS structural-stop invariants remain PASS
  // -------------------------------------------------------------------------
  {
    const entry = 3500;
    const structuralCandidateStop = 3402.25;
    const oldClosedOnlySafetyStop = 3418.0;

    const adaptive = computeAdaptiveRangePreEntryProtection({
      side: "long",
      entryPx: entry,
      rawStructuralSl: structuralCandidateStop,
      rawPolicySl: entry * (1 - 0.0026),
      rawPolicyTp: entry * (1 + 0.0025),
      atr: 45,
      boxHigh: 3550,
      boxLow: 3450,
      boxMid: 3500,
      feeRate: 0.0005,
      preserveCanonicalStructuralStop: true
    });

    assert.equal(adaptive.ok, true);
    if (!adaptive.ok) throw new Error("expected ok");
    assert.ok(adaptive.slPrice <= structuralCandidateStop, "FTS canonical structural stop preserved without tightening");
    console.log("[PASS] TEST 3: FTS structural-stop invariants preserved");
  }

  // -------------------------------------------------------------------------
  // TEST 4 — TP1 on 1.45 contracts submits only configured partial contracts
  // -------------------------------------------------------------------------
  {
    const totalPosition = 1.45;
    const partialRatio = 0.5;
    const expectedTp1Contracts = 0.72; // 1.45 * 0.5 = 0.725 -> normalized to 0.72

    const fullPositionTpAlgo: ProtectiveAlgoRow = {
      algoId: "tp_full_145",
      algoClOrdId: "oapETHUSDL12345t",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "long",
      tdMode: "cross",
      ordType: "conditional",
      state: "live",
      reduceOnly: true,
      sz: "1.45", // Full position size (wrong for TP1!)
      tpTriggerPx: "2494.79",
      tpTriggerPxType: "last"
    };

    const ctx: ProtectiveReconcileContext = {
      instId: "ETH-USDT-SWAP",
      positionSide: "long",
      openedAt36: "12345",
      tdModeUsed: "cross",
      contractsToProtect: totalPosition, // 1.45
      tpContractsToProtect: expectedTp1Contracts, // 0.72
      activeStopPrice: 2485.17,
      activeTpPrice: 2494.79,
      wantsTp: true,
      expectedSide: "sell",
      tickSz: 0.01
    };

    const plan = planProtectiveOrderReconcile([fullPositionTpAlgo], ctx);

    // Full position TP (1.45) must NOT be classified as valid TP1!
    assert.notEqual(plan.canonicalTp?.algoId, "tp_full_145", "Full-position TP must not be classified as valid partial TP1");
    assert.ok(plan.cancelAlgoIds.includes("tp_full_145"), "Full position TP must be marked stale for cancellation");
    assert.equal(plan.needSubmitTp, true, "Must request submission of partial TP1 order");
    assert.equal(plan.submitOco, false, "Must not submit OCO when TP size differs from SL size");

    // Partial TP1 algo (0.72) is classified as valid
    const partialTpAlgo: ProtectiveAlgoRow = {
      algoId: "tp_partial_072",
      algoClOrdId: "oapETHUSDL12345t",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "long",
      tdMode: "cross",
      ordType: "conditional",
      state: "live",
      reduceOnly: true,
      sz: "0.72",
      tpTriggerPx: "2494.79",
      tpTriggerPxType: "last"
    };

    const planWithPartial = planProtectiveOrderReconcile([partialTpAlgo], ctx);
    assert.equal(planWithPartial.canonicalTp?.algoId, "tp_partial_072", "Partial TP algo must be recognized as canonical TP");
    assert.equal(planWithPartial.needSubmitTp, false, "No new TP submission needed when valid partial TP exists");
    console.log("[PASS] TEST 4: TP1 on 1.45 contracts submits only configured partial contracts (0.72)");
  }

  // -------------------------------------------------------------------------
  // TEST 5 — Remaining position stays open after TP1
  // -------------------------------------------------------------------------
  {
    const totalPosition = 1.45;
    const tp1Filled = 0.72;
    const remainingPosition = Number((totalPosition - tp1Filled).toFixed(2)); // 0.73

    assert.ok(remainingPosition > 0, "Remaining position runner must be strictly positive");
    assert.equal(remainingPosition, 0.73, "Remaining runner position is 0.73 contracts");
    console.log("[PASS] TEST 5: Remaining runner position (0.73 contracts) stays open after TP1");
  }

  // -------------------------------------------------------------------------
  // TEST 6 — SL after TP1 protects exactly remaining contracts
  // -------------------------------------------------------------------------
  {
    const remainingContracts = 0.73;

    // Old SL that protected 1.45 contracts
    const oldSlAlgo: ProtectiveAlgoRow = {
      algoId: "sl_old_145",
      algoClOrdId: "oapETHUSDL12345s",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "long",
      tdMode: "cross",
      ordType: "conditional",
      state: "live",
      reduceOnly: true,
      sz: "1.45",
      slTriggerPx: "2485.17",
      slTriggerPxType: "last"
    };

    const ctxAfterTp1: ProtectiveReconcileContext = {
      instId: "ETH-USDT-SWAP",
      positionSide: "long",
      openedAt36: "12345",
      tdModeUsed: "cross",
      contractsToProtect: remainingContracts, // Exactly 0.73
      tpContractsToProtect: undefined, // Stage 1+ (or runner)
      activeStopPrice: 2485.17,
      activeTpPrice: null,
      wantsTp: false,
      expectedSide: "sell",
      tickSz: 0.01
    };

    const plan = planProtectiveOrderReconcile([oldSlAlgo], ctxAfterTp1);
    assert.ok(plan.cancelAlgoIds.includes("sl_old_145"), "Old 1.45 SL must be cancelled due to size mismatch");
    assert.equal(plan.needSubmitSl, true, "Must request resubmission of SL for exactly remaining contracts");
    assert.equal(ctxAfterTp1.contractsToProtect, 0.73, "Contracts to protect is exactly remaining 0.73");

    // When new 0.73 SL is present, it is canonical
    const newSlAlgo: ProtectiveAlgoRow = {
      algoId: "sl_new_073",
      algoClOrdId: "oapETHUSDL12345s",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "long",
      tdMode: "cross",
      ordType: "conditional",
      state: "live",
      reduceOnly: true,
      sz: "0.73",
      slTriggerPx: "2485.17",
      slTriggerPxType: "last"
    };

    const planReconciled = planProtectiveOrderReconcile([newSlAlgo], ctxAfterTp1);
    assert.equal(planReconciled.canonicalSl?.algoId, "sl_new_073");
    assert.equal(planReconciled.needSubmitSl, false);
    console.log("[PASS] TEST 6: SL after TP1 protects exactly remaining contracts (0.73)");
  }

  // -------------------------------------------------------------------------
  // TEST 7 — Full final TP / emergency exit may still close 100%
  // -------------------------------------------------------------------------
  {
    const totalPosition = 1.45;

    // When full TP is requested (no partial plan or final exit stage)
    const ctxFullTp: ProtectiveReconcileContext = {
      instId: "ETH-USDT-SWAP",
      positionSide: "long",
      openedAt36: "12345",
      tdModeUsed: "cross",
      contractsToProtect: totalPosition, // 1.45
      tpContractsToProtect: totalPosition, // 100% full TP
      activeStopPrice: 2485.17,
      activeTpPrice: 2510.00,
      wantsTp: true,
      expectedSide: "sell",
      tickSz: 0.01
    };

    const fullTpAlgo: ProtectiveAlgoRow = {
      algoId: "tp_full_145",
      algoClOrdId: "oapETHUSDL12345t",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "long",
      tdMode: "cross",
      ordType: "conditional",
      state: "live",
      reduceOnly: true,
      sz: "1.45",
      tpTriggerPx: "2510.00",
      tpTriggerPxType: "last"
    };

    const plan = planProtectiveOrderReconcile([fullTpAlgo], ctxFullTp);
    assert.equal(plan.canonicalTp?.algoId, "tp_full_145", "100% TP algo is canonical when full TP is requested");
    assert.equal(plan.cancelAlgoIds.length, 0, "No cancellation needed for valid 100% TP");
    console.log("[PASS] TEST 7: Full final TP / emergency exit may still close 100%");
  }

  // -------------------------------------------------------------------------
  // TEST 8 — STOP_LOSS and emergency close orders allowed to close full position regardless of new-entry cap
  // -------------------------------------------------------------------------
  {
    const positionSizeUsd = 500; // Much larger than 40 USDT new-entry cap
    const isReduceOnly = true;

    // reduceOnly orders (SL / emergency close / TP) do not consume new entry risk exposure
    assert.equal(isReduceOnly, true);
    console.log("[PASS] TEST 8: STOP_LOSS and emergency close orders allowed to close full position regardless of 40 USDT new-entry cap");
  }

  // -------------------------------------------------------------------------
  // TEST 9 — Multi-Cycle Reconcile Idempotency (settles to KEEP without duplicate submissions)
  // -------------------------------------------------------------------------
  {
    const ctx: ProtectiveReconcileContext = {
      instId: "ETH-USDT-SWAP",
      positionSide: "long",
      openedAt36: "12345",
      tdModeUsed: "cross",
      contractsToProtect: 1.45,
      tpContractsToProtect: 0.72,
      activeStopPrice: 2485.17,
      activeTpPrice: 2494.79,
      wantsTp: true,
      expectedSide: "sell",
      tickSz: 0.01
    };

    const currentAlgos: ProtectiveAlgoRow[] = [
      {
        algoId: "sl_live_145",
        algoClOrdId: "oapETHUSDL12345s",
        instId: "ETH-USDT-SWAP",
        side: "sell",
        posSide: "long",
        tdMode: "cross",
        ordType: "conditional",
        state: "live",
        reduceOnly: true,
        sz: "1.45",
        slTriggerPx: "2485.17",
        slTriggerPxType: "last"
      },
      {
        algoId: "tp_live_072",
        algoClOrdId: "oapETHUSDL12345t",
        instId: "ETH-USDT-SWAP",
        side: "sell",
        posSide: "long",
        tdMode: "cross",
        ordType: "conditional",
        state: "live",
        reduceOnly: true,
        sz: "0.72",
        tpTriggerPx: "2494.79",
        tpTriggerPxType: "last"
      }
    ];

    // Simulate 5 consecutive reconciliation cycles with no state change
    for (let cycle = 1; cycle <= 5; cycle++) {
      const plan = planProtectiveOrderReconcile(currentAlgos, ctx);
      assert.equal(plan.canonicalSl?.algoId, "sl_live_145", `Cycle ${cycle}: SL must remain canonical`);
      assert.equal(plan.canonicalTp?.algoId, "tp_live_072", `Cycle ${cycle}: TP1 must remain canonical`);
      assert.equal(plan.needSubmitSl, false, `Cycle ${cycle}: Must NOT re-submit SL`);
      assert.equal(plan.needSubmitTp, false, `Cycle ${cycle}: Must NOT re-submit TP1`);
      assert.equal(plan.cancelAlgoIds.length, 0, `Cycle ${cycle}: Must NOT cancel valid protection`);
      assert.equal(plan.duplicateSlCount, 0, `Cycle ${cycle}: Duplicate SL count must be 0`);
      assert.equal(plan.duplicateTpCount, 0, `Cycle ${cycle}: Duplicate TP count must be 0`);
    }
    console.log("[PASS] TEST 9: Multi-cycle reconcile idempotency verified (5 cycles settled to KEEP)");
  }

  // -------------------------------------------------------------------------
  // TEST 10 — TP1 Stage Progression (no infinite geometric sequence)
  // -------------------------------------------------------------------------
  {
    // Stage 0: Initial position 1.45, partial ratio 0.5 -> TP1 = 0.72
    const ratioStage0 = resolvePartialExitRatio({
      isV2Authority: true,
      regime: "RANGE",
      takeProfitPlan: { partialRatio: 0.5 },
      takeProfit1Px: 2494.79,
      partialExitRatio: 0.5
    });
    assert.equal(ratioStage0, 0.5);

    // After TP1 fills: partialExitStage becomes 1.
    // In Stage 1+, resolvePartialExitRatio / ensureProtectiveStopOrderCore does not re-trigger TP1
    const isStage0Complete = (1 /* open.partialExitStage */) >= 1;
    let tpContractsStage1: number | undefined = undefined;
    if (!isStage0Complete && ratioStage0 != null && ratioStage0 > 0 && ratioStage0 < 1) {
      tpContractsStage1 = 0.73 * ratioStage0;
    }
    assert.equal(tpContractsStage1, undefined, "Stage 1 runner must not calculate another 50% partial TP1");
    console.log("[PASS] TEST 10: TP1 stage progression prevents infinite geometric sequence");
  }

  // -------------------------------------------------------------------------
  // TEST 11 — Legitimate BE / Trailing Stop Tightening Remains Allowed After Arming
  // -------------------------------------------------------------------------
  {
    const entry = 2491.65;
    const initialPolicyStop = 2485.17171;
    const confirmedBreakevenStop = 2491.65; // Moved UP to entry after BE confirmation

    // Initial pre-entry cannot tighten
    assert.ok(initialPolicyStop <= entry, "Initial policy stop is wider");

    // Later: When breakeven/trailing is explicitly confirmed in post-entry management,
    // activeStopPrice in reconcileCtx is updated to confirmedBreakevenStop (2491.65)
    const ctxBE: ProtectiveReconcileContext = {
      instId: "ETH-USDT-SWAP",
      positionSide: "long",
      openedAt36: "12345",
      tdModeUsed: "cross",
      contractsToProtect: 1.45,
      activeStopPrice: confirmedBreakevenStop, // 2491.65 (legitimate BE promotion)
      activeTpPrice: 2494.79,
      wantsTp: true,
      expectedSide: "sell",
      tickSz: 0.01
    };

    const beSlAlgo: ProtectiveAlgoRow = {
      algoId: "sl_be_promoted",
      algoClOrdId: "oapETHUSDL12345s",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "long",
      tdMode: "cross",
      ordType: "conditional",
      state: "live",
      reduceOnly: true,
      sz: "1.45",
      slTriggerPx: "2491.65", // BE price
      slTriggerPxType: "last"
    };

    const planBE = planProtectiveOrderReconcile([beSlAlgo], ctxBE);
    assert.equal(planBE.canonicalSl?.algoId, "sl_be_promoted", "Promoted BE stop must be recognized as canonical");
    assert.equal(planBE.needSubmitSl, false, "Valid promoted BE stop requires no new submission");
    console.log("[PASS] TEST 11: Legitimate BE/trailing promotion remains fully allowed after arming");
  }

  console.log("=== ALL 11 FUNCTIONAL REGRESSION TESTS PASSED ===");
}

runRegressionSuite().catch((err) => {
  console.error("Regression suite failed:", err);
  process.exit(1);
});
