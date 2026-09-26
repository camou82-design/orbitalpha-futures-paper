import { evaluateHighwayCoreEntryGate } from "../engine-v2/highway-core/highway-entry-gate";

function assertTrue(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertEq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new Error(`Expected [${expected}] but got [${actual}] - ${msg}`);
  }
}

let allOk = true;
function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`[HIGHWAY-DEADLOCK-TEST][PASS] ${name}`);
  } catch (err) {
    allOk = false;
    console.error(`[HIGHWAY-DEADLOCK-TEST][FAIL] ${name}:`, (err as Error).message);
  }
}

console.log("=== HIGHWAY CONTINUATION DEADLOCK REGRESSION SUITE ===\n");

// ── Test 1: RANGE + pure mean reversion → box cap 유지 ──
run("Test 1: RANGE + pure mean reversion caps expectedMove by structureRoom", () => {
  const lastPrice = 65000;
  const boxHigh = 65100; // structureRoom = (65100 - 65000) / 65000 = 0.001538 (0.1538%)
  const plannedTp1Price = 65300; // tp1DistancePct = (65300 - 65000) / 65000 = 0.004615 (0.4615%)
  const plannedStopPrice = 64700; // stopDistancePct = 0.004615

  const result = evaluateHighwayCoreEntryGate({
    symbol: "BTCUSDT",
    side: "long",
    regime: "RANGE",
    subtype: "NONE",
    snapshot: {
      lastPrice,
      boxHigh,
      boxLow: 64500,
      boxPos: 0.25, // edge
      atr20: 500
    },
    execution: {
      decision: "ENTER",
      reason: "v2_range_long_edge",
      metadata: {
        plannedStopPrice,
        plannedTp1Price
      }
    } as any,
    committedRiskPlan: {
      stopPrice: plannedStopPrice,
      plannedTp1Price
    } as any,
    config: {
      highwayMinCostMultiplier: 2.0,
      highwayMinRewardRisk: 1.2
    }
  });

  // Pure range MR: expectedMove is capped by structureRoom (0.1538%)
  assertEq(result.proof.non_range_lineage, false, "non_range_lineage is false");
  assertEq(result.proof.expected_move_source, "range_box_cap", "Source is range_box_cap");
  assertEq(result.proof.structure_room_pct, 0.001538, "structure_room_pct is 0.001538");
  assertEq(result.expectedMovePct, (boxHigh - lastPrice) / lastPrice, "expectedMove capped by boxHigh");
});

// ── Test 2: RANGE + FAST_TREND_SHIFT (BTC) → TP1 distance used (no box cap) ──
run("Test 2: BTC RANGE + FAST_TREND_SHIFT uses full TP1 distance and passes highway gate", () => {
  const lastPrice = 65000;
  const boxHigh = 65095; // structureRoom = 0.1459% (too small for 2.0 * cost ~ 0.26%)
  const plannedTp1Price = 65243; // tp1DistancePct = 0.3735% (>= 0.26%)
  const plannedStopPrice = 64800; // stopDistancePct = 0.3077% (RR = 0.3735 / 0.3077 = 1.214 >= 1.2)

  const result = evaluateHighwayCoreEntryGate({
    symbol: "BTCUSDT",
    side: "long",
    regime: "RANGE",
    subtype: "FAST_TREND_SHIFT",
    snapshot: {
      lastPrice,
      boxHigh,
      boxLow: 64500,
      boxPos: 0.5,
      atr20: 500
    },
    execution: {
      decision: "ENTER",
      reason: "v2_fast_trend_shift_long",
      metadata: {
        plannedStopPrice,
        plannedTp1Price,
        fast_trend_shift: true
      }
    } as any,
    committedRiskPlan: {
      stopPrice: plannedStopPrice,
      plannedTp1Price
    } as any,
    config: {
      highwayMinCostMultiplier: 2.0,
      highwayMinRewardRisk: 1.2
    }
  });

  assertEq(result.allowed, true, "Gate allowed must be true (no deadlock)");
  assertEq(result.finalDecision, "ENTER", "Final decision must be ENTER");
  assertEq(result.rejectReason, null, "No reject reason");
  assertEq(result.proof.non_range_lineage, true, "non_range_lineage is true");
  assertEq(result.proof.expected_move_source, "tp1_distance", "expected_move_source is tp1_distance");
  assertEq(result.proof.structure_room_pct, 0.001462, "structure_room_pct logged");
  assertEq(result.expectedMovePct, (plannedTp1Price - lastPrice) / lastPrice, "Full TP1 distance used");
});

// ── Test 3: RANGE + CONTINUATION / TREND / BREAKOUT (ETH) → TP1 distance used ──
run("Test 3: ETH RANGE + CONTINUATION uses full TP1 distance", () => {
  const lastPrice = 3000;
  const boxLow = 2995; // Short: structureRoom = (3000 - 2995)/3000 = 0.166%
  const plannedTp1Price = 2985; // tp1DistancePct = (3000 - 2985)/3000 = 0.50%
  const plannedStopPrice = 3010; // stopDistancePct = 0.333% (RR = 1.5)

  const result = evaluateHighwayCoreEntryGate({
    symbol: "ETHUSDT",
    side: "short",
    regime: "RANGE",
    subtype: "TREND_CONTINUATION",
    snapshot: {
      lastPrice,
      boxHigh: 3050,
      boxLow,
      boxPos: 0.5,
      atr20: 25
    },
    execution: {
      decision: "ENTER",
      reason: "v2_trend_continuation_short",
      metadata: {
        plannedStopPrice,
        plannedTp1Price,
        trend_continuation: true
      }
    } as any,
    committedRiskPlan: {
      stopPrice: plannedStopPrice,
      plannedTp1Price
    } as any,
    config: {
      highwayMinCostMultiplier: 2.0,
      highwayMinRewardRisk: 1.2
    }
  });

  assertEq(result.allowed, true, "Gate allowed");
  assertEq(result.finalDecision, "ENTER", "Final decision ENTER");
  assertEq(result.proof.non_range_lineage, true, "non_range_lineage true");
  assertEq(result.proof.expected_move_source, "tp1_distance", "expected_move_source tp1_distance");
  assertEq(result.expectedMovePct, (lastPrice - plannedTp1Price) / lastPrice, "Full TP1 distance used");
});

// ── Test 4: TREND regime → 기존 동작 유지 ──
run("Test 4: TREND regime maintains existing behavior", () => {
  const lastPrice = 65000;
  const plannedTp1Price = 65500;
  const plannedStopPrice = 64600;

  const result = evaluateHighwayCoreEntryGate({
    symbol: "BTCUSDT",
    side: "long",
    regime: "TREND",
    subtype: "TREND_CONFIRMED",
    snapshot: {
      lastPrice,
      boxHigh: 65100,
      boxLow: 64500,
      boxPos: 0.8,
      atr20: 500
    },
    execution: {
      decision: "ENTER",
      reason: "v2_trend_breakout_long",
      metadata: {
        plannedStopPrice,
        plannedTp1Price,
        retestConfirmed: true
      }
    } as any,
    committedRiskPlan: {
      stopPrice: plannedStopPrice,
      plannedTp1Price
    } as any
  });

  assertEq(result.allowed, true, "TREND allowed");
  assertEq(result.finalDecision, "ENTER", "TREND ENTER");
  assertEq(result.proof.structure_room_pct, null, "structure_room_pct is null in TREND");
  assertEq(result.proof.expected_move_source, "tp1_distance", "expected_move_source tp1_distance");
});

// ── Test 5: Opposite Strong Highway / Shock → 기존 차단 유지 ──
run("Test 5: Opposing strong shock or highway is strictly blocked", () => {
  const result = evaluateHighwayCoreEntryGate({
    symbol: "BTCUSDT",
    side: "long",
    regime: "RANGE",
    subtype: "FAST_TREND_SHIFT",
    directionalShockState: "DOWN", // Adverse down shock active without reclaim
    snapshot: {
      lastPrice: 65000,
      boxHigh: 66000,
      boxLow: 64000,
      boxPos: 0.5,
      atr20: 500
    },
    execution: {
      decision: "ENTER",
      reason: "v2_fast_trend_shift_long",
      metadata: {
        plannedStopPrice: 64500,
        plannedTp1Price: 65500,
        fast_trend_shift: true
      }
    } as any,
    committedRiskPlan: {
      stopPrice: 64500,
      plannedTp1Price: 65500
    } as any
  });

  assertEq(result.allowed, false, "Adverse shock must block entry");
  assertEq(result.finalDecision, "HOLD", "Final decision HOLD");
  assertEq(result.rejectReason, "OPPOSING_DOWN_SHOCK_ACTIVE", "Reject reason OPPOSING_DOWN_SHOCK_ACTIVE");
});

// ── Test 6: Invalid TP/SL → fail-closed 유지 ──
run("Test 6: Missing planned TP/SL triggers fail-closed HIGHWAY_PLAN_MISSING", () => {
  const result = evaluateHighwayCoreEntryGate({
    symbol: "BTCUSDT",
    side: "long",
    regime: "RANGE",
    subtype: "FAST_TREND_SHIFT",
    snapshot: {
      lastPrice: 65000,
      boxHigh: 66000,
      boxLow: 64000,
      boxPos: 0.5,
      atr20: 500
    },
    execution: {
      decision: "ENTER",
      reason: "v2_fast_trend_shift_long",
      metadata: {
        fast_trend_shift: true
      }
    } as any,
    committedRiskPlan: null // Missing plan
  });

  assertEq(result.allowed, false, "Missing plan must be rejected");
  assertEq(result.finalDecision, "SKIP", "Final decision SKIP");
  assertEq(result.rejectReason, "HIGHWAY_PLAN_MISSING", "Reject reason HIGHWAY_PLAN_MISSING");
});

// ── Test 7: Proof telemetry fields verification ──
run("Test 7: Proof telemetry fields are properly formatted and populated", () => {
  const lastPrice = 65000;
  const plannedTp1Price = 65250;
  const plannedStopPrice = 64800;

  const result = evaluateHighwayCoreEntryGate({
    symbol: "BTCUSDT",
    side: "long",
    regime: "RANGE",
    subtype: "FAST_TREND_SHIFT",
    snapshot: {
      lastPrice,
      boxHigh: 65100,
      boxLow: 64500,
      boxPos: 0.5,
      atr20: 500
    },
    execution: {
      decision: "ENTER",
      reason: "v2_fast_trend_shift_long",
      metadata: {
        plannedStopPrice,
        plannedTp1Price,
        fast_trend_shift: true
      }
    } as any,
    committedRiskPlan: {
      stopPrice: plannedStopPrice,
      plannedTp1Price
    } as any,
    config: {
      highwayMinCostMultiplier: 2.0
    }
  });

  const p = result.proof;
  assertTrue("expected_move_source" in p, "has expected_move_source");
  assertTrue("structure_room_pct" in p, "has structure_room_pct");
  assertTrue("non_range_lineage" in p, "has non_range_lineage");
  assertTrue("effective_min_required_move_pct" in p, "has effective_min_required_move_pct");
  assertEq(p.expected_move_source, "tp1_distance", "expected_move_source is tp1_distance");
  assertEq(p.non_range_lineage, true, "non_range_lineage is true");
  assertEq(p.structure_room_pct, 0.001538, "structure_room_pct matches boxHigh distance");
  assertEq(p.effective_min_required_move_pct, 0.0026, "effective_min_required_move_pct is 0.0026 (cost * 2.0)");
});

if (!allOk) {
  console.error("\n[HIGHWAY-DEADLOCK-TEST] FAILED!");
  process.exit(1);
} else {
  console.log("\n[HIGHWAY-DEADLOCK-TEST] ALL 7 REGRESSION TESTS PASSED PERFECTLY!");
}
