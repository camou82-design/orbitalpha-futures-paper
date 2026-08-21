/**
 * P0 Loss Churn / Exit Authority / Mandatory TP / OKX Protection Repair
 */

import assert from "node:assert/strict";
import {
  evaluateTerminalReentryBarrier,
  buildTerminalReentryBarrierProof
} from "../engine-v2/lifecycle/terminal-reentry-barrier";
import {
  evaluateSameSideLossReentryGate,
  deriveLastLossReentryState,
  countCompletedCandlesSince,
  computeStructuralSetupIdentity,
  inferStructuralSetupEvent
} from "../engine-v2/state/loss-reentry-gate";
import {
  applyV2ExitAuthorityInvariants,
  isNonTerminalExitReason
} from "../engine-v2/exit/exit-authority-invariant";
import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import { shouldAttachFullPositionProtectiveTp } from "../engine-v2/execution/protective-tp-authority";
import {
  planProtectiveOrderReconcile,
  type ProtectiveReconcileContext,
  type ProtectiveAlgoRow
} from "../engine-v2/execution/protective-reconcile-plan";
import {
  evaluateOkx51088ProtectionRecovery,
  isOkx51088FullPositionProtectiveConflict
} from "../engine-v2/execution/okx-protection-51088-recovery";
import { resolveProtectiveExistingAlgoLedgerAdoption } from "./paper-engine";
import type { PaperOpenPositionRecord } from "../models/types";

function pass(label: string, detail?: string): void {
  console.log(`[P0-LOSS-CHURN][${label}] PASS${detail ? ` — ${detail}` : ""}`);
}

const NOW = 1_700_000_000_000;
const baseCtx: ProtectiveReconcileContext = {
  instId: "BTC-USDT-SWAP",
  positionSide: "short",
  openedAt36: "abc123",
  tdModeUsed: "cross",
  contractsToProtect: 0.5,
  activeStopPrice: 77200,
  activeTpPrice: 76800,
  wantsTp: true,
  expectedSide: "buy",
  tickSz: 0.1
};

// CASE 1: finalize pending + OKX position still exists => BLOCK entry
{
  const open: PaperOpenPositionRecord = {
    symbol: "BTCUSDT",
    side: "short",
    openedAt: NOW - 600_000,
    entryPrice: 77089,
    sizeUsd: 500,
    finalizePending: true,
    pendingFinalizeExitAvgPx: 77093.6,
    pendingFinalizeFinalFillAt: NOW - 300_000,
    lifecycleState: "BOT_V2_MANAGED",
    positionCycleId: "cycle_btc_1"
  } as PaperOpenPositionRecord;
  const barrier = evaluateTerminalReentryBarrier({
    symbol: "BTCUSDT",
    requestedSide: "short",
    openPositions: [open],
    actualOkxPositionExists: true
  });
  assert.equal(barrier.blocked, true);
  pass("CASE_1_FINALIZE_PENDING_BLOCKS_REENTRY", barrier.reason);
}

// CASE 2: close fill confirmed, finalize pending => BLOCK
{
  const open: PaperOpenPositionRecord = {
    symbol: "BTCUSDT",
    side: "short",
    openedAt: NOW - 600_000,
    entryPrice: 77089,
    finalizePending: true,
    pendingFinalizeExitAvgPx: 77050,
    pendingFinalizeFinalFillAt: NOW - 60_000,
    lifecycleState: "BOT_V2_MANAGED"
  } as PaperOpenPositionRecord;
  const barrier = evaluateTerminalReentryBarrier({
    symbol: "BTCUSDT",
    requestedSide: "short",
    openPositions: [open]
  });
  assert.equal(barrier.blocked, true);
  assert.equal(barrier.finalizePending, true);
  pass("CASE_2_FINALIZE_HISTORY_PENDING_BLOCKS", barrier.reason);
}

// CASE 3: flat + loss committed in history => gate sees prior loss
{
  const history = [{
    symbol: "BTCUSDT",
    side: "short",
    openedAt: NOW - 900_000,
    closedAt: NOW - 120_000,
    entryPrice: 77089,
    closePrice: 77093.6,
    pnlUsdNet: -2.5,
    closeReason: "RANGE_FULL_EXIT_BOX_BREAK"
  }];
  const loss = deriveLastLossReentryState({ history, openPositions: [], symbol: "BTCUSDT", now: NOW });
  assert.ok(loss);
  const gate = evaluateSameSideLossReentryGate({
    symbol: "BTCUSDT",
    requestedSide: "short",
    currentPrice: 77090,
    now: NOW,
    lastLossState: loss,
    candles: [],
    regime: "RANGE",
    zone: "mid"
  });
  assert.equal(gate.allowed, false);
  pass("CASE_3_FLAT_LOSS_COMMITTED_BLOCKS_SAME_ZONE", gate.reason);
}

// CASE 4: SHORT loss + price moved UP 1% => displacement ALLOW forbidden
{
  const loss = {
    symbol: "BTCUSDT",
    lastLossExitAt: NOW - 300_000,
    lastLossExitSide: "short" as const,
    lastLossExitPrice: 77000,
    lastLossEntryPrice: 77100,
    lastLossExitReason: "box_break",
    lastLossSetupIdentity: "BTCUSDT:short:RANGE:upper:none:none",
    realizedLossNetUsd: -5,
    source: "finalized_history" as const
  };
  const gate = evaluateSameSideLossReentryGate({
    symbol: "BTCUSDT",
    requestedSide: "short",
    currentPrice: 77770,
    now: NOW,
    lastLossState: loss,
    candles: [],
    atr: 200
  });
  assert.equal(gate.allowed, false);
  pass("CASE_4_SHORT_LOSS_UP_MOVE_BLOCKED", `favorable=false, reason=${gate.reason}`);
}

// CASE 5: SHORT loss + sufficient downward displacement + structural event => ALLOW
{
  const loss = {
    symbol: "BTCUSDT",
    lastLossExitAt: NOW - 600_000,
    lastLossExitSide: "short" as const,
    lastLossExitPrice: 77000,
    lastLossEntryPrice: 77100,
    lastLossExitReason: "box_break",
    lastLossExitCandleTs: NOW - 600_000,
    lastLossSetupIdentity: "BTCUSDT:short:RANGE:upper:range_flat:none",
    realizedLossNetUsd: -5,
    source: "finalized_history" as const
  };
  const candles = Array.from({ length: 6 }, (_, i) => ({
    ts: NOW - 500_000 + i * 60_000,
    close: 76500 - i * 10
  }));
  const gate = evaluateSameSideLossReentryGate({
    symbol: "BTCUSDT",
    requestedSide: "short",
    currentPrice: 76200,
    now: NOW,
    lastLossState: loss,
    candles,
    atr: 200,
    regime: "RANGE",
    zone: "lower",
    subtype: "RANGE_BREAKDOWN",
    structuralEvent: "confirmed_breakdown"
  });
  assert.equal(gate.allowed, true);
  pass("CASE_5_SHORT_DOWN_DISPLACEMENT_STRUCTURAL_ALLOW", gate.reason);
}

// CASE 6: forming candle must not count toward 5 completed candles
{
  const since = NOW - 300_000;
  const candles = [
    { ts: since + 60_000 },
    { ts: since + 120_000 },
    { ts: since + 180_000 },
    { ts: since + 240_000 },
    { ts: NOW - 30_000 }
  ];
  const count = countCompletedCandlesSince(candles, since, NOW);
  assert.equal(count, 4);
  pass("CASE_6_FORMING_CANDLE_EXCLUDED", `completed=${count}`);
}

// CASE 7: box jitter alone is not fresh setup
{
  const lossIdentity = computeStructuralSetupIdentity({
    symbol: "ETHUSDT",
    side: "long",
    regime: "RANGE",
    zone: "mid",
    subtype: "RANGE_FLAT",
    structuralEvent: "none"
  });
  const jitterIdentity = computeStructuralSetupIdentity({
    symbol: "ETHUSDT",
    side: "long",
    regime: "RANGE",
    zone: "mid",
    subtype: "RANGE_FLAT",
    structuralEvent: "none"
  });
  assert.equal(lossIdentity, jitterIdentity);
  const gate = evaluateSameSideLossReentryGate({
    symbol: "ETHUSDT",
    requestedSide: "long",
    currentPrice: 2355,
    now: NOW,
    lastLossState: {
      symbol: "ETHUSDT",
      lastLossExitAt: NOW - 400_000,
      lastLossExitSide: "long",
      lastLossExitPrice: 2350,
      lastLossEntryPrice: 2360,
      lastLossExitReason: "stop",
      lastLossSetupIdentity: lossIdentity,
      realizedLossNetUsd: -3,
      source: "finalized_history"
    },
    candles: Array.from({ length: 6 }, (_, i) => ({ ts: NOW - 350_000 + i * 60_000 })),
    regime: "RANGE",
    zone: "mid",
    subtype: "RANGE_FLAT"
  });
  assert.equal(gate.allowed, false);
  pass("CASE_7_BOX_JITTER_NOT_FRESH_SETUP", gate.reason);
}

// CASE 8: TREND_HOLD_VALID => shouldExit false
{
  const policy = evaluateV2ExitPolicy({
    symbol: "ETHUSDT",
    v2State: {
      symbol: "ETHUSDT",
      symbolPositions: [{
        symbol: "ETHUSDT",
        side: "LONG",
        entryPrice: 2350,
        sizeUsd: 300,
        peakUnrealizedPnlPct: 0.001,
        pnlPct: -0.001
      }]
    } as any,
    judgment: {
      regime_final: "TREND",
      subtype: "TREND_UP_CONTINUATION",
      trendPhase: "CONTINUATION",
      shockPhase: "NONE",
      rangePhase: "NONE",
      transitionPhase: "NONE"
    } as any,
    snapshot: {
      boxPos: 0.5,
      boxBreakSide: "none" as const,
      emaGap: 0.002,
      trendWeaknessScore: 0.3,
      rangeConfidence: 0.5,
      qualityScore: 70,
      atr20: 10
    },
    markPrice: 2348,
    trendSideCandidate: "long",
    rangeSideCandidate: "none"
  });
  assert.equal(policy.reason, "TREND_HOLD_VALID");
  assert.equal(policy.shouldExit, false);
  pass("CASE_8_TREND_HOLD_VALID_NO_EXIT", `action=${policy.action}`);
}

// CASE 9: generic EXIT + HOLD policy => fail closed
{
  const sanitized = applyV2ExitAuthorityInvariants({
    symbol: "ETHUSDT",
    side: "long",
    exitAuthorityOwner: "v2",
    exitExecutionOwner: "paper_engine",
    exitAction: "exit",
    shouldExit: true,
    exitReason: "TREND_HOLD_VALID",
    exitUrgency: "low",
    exitConfidence: 0.5,
    reduceRatio: null,
    proofReasons: [],
    trueInconsistencyReasons: [],
    knownShadowGaps: []
  });
  assert.ok(sanitized);
  assert.equal(sanitized!.shouldExit, false);
  assert.equal(sanitized!.exitAction, "none");
  pass("CASE_9_HOLD_COLLISION_FAIL_CLOSED", sanitized!.exitReason ?? "null");
}

// CASE 10: BOT_V2 TREND entry => tpRequired true
{
  const evalTp = shouldAttachFullPositionProtectiveTp({
    isV2Authority: true,
    regime: "TREND",
    isV2RangePartialPlan: false,
    rawWantsTp: true
  });
  assert.equal(evalTp.fullPositionTpRequired, true);
  pass("CASE_10_TREND_V2_TP_REQUIRED", evalTp.reason);
}

// CASE 11: no protection => combined OCO plan
{
  const plan = planProtectiveOrderReconcile([], baseCtx);
  assert.equal(plan.submitOco, true);
  pass("CASE_11_EMPTY_INVENTORY_OCO_PLAN", `submitOco=${plan.submitOco}`);
}

// CASE 12: SL exists / TP missing => combined rebuild not TP-only
{
  const slOnly: ProtectiveAlgoRow = {
    algoId: "sl_live",
    algoClOrdId: "slBTCabc",
    instId: "BTC-USDT-SWAP",
    posSide: "short",
    side: "buy",
    tdMode: "cross",
    reduceOnly: true,
    ordType: "conditional",
    sz: "0.5",
    slTriggerPx: "77200",
    state: "live"
  };
  const plan = planProtectiveOrderReconcile([slOnly], baseCtx);
  assert.equal(plan.submitOco, true);
  assert.equal(plan.needSubmitTp, false);
  pass("CASE_12_SL_ONLY_COMBINED_REBUILD", `submitOco=${plan.submitOco}`);
}

// CASE 13: 51088 + existing full protection => adopt
{
  const oco: ProtectiveAlgoRow = {
    algoId: "oco_live",
    algoClOrdId: "slBTCoco",
    instId: "BTC-USDT-SWAP",
    posSide: "short",
    side: "buy",
    tdMode: "cross",
    reduceOnly: true,
    ordType: "oco",
    sz: "0.5",
    slTriggerPx: "77200",
    tpTriggerPx: "76800",
    state: "live"
  };
  assert.ok(isOkx51088FullPositionProtectiveConflict({ sCode: "51088", sMsg: "You can only place 1 TP/SL order" }));
  const recovery = evaluateOkx51088ProtectionRecovery({
    inventory: [oco],
    reconcileCtx: baseCtx,
    tpRequired: true
  });
  assert.equal(recovery.adopted, true);
  assert.equal(recovery.finalProtectionSatisfied, true);
  pass("CASE_13_51088_ADOPT_EXISTING", recovery.repairAction);
}

// CASE 14: 51088 + SL only + TP required => repair required
{
  const slOnly: ProtectiveAlgoRow = {
    algoId: "sl_live",
    algoClOrdId: "slBTCabc",
    instId: "BTC-USDT-SWAP",
    posSide: "short",
    side: "buy",
    tdMode: "cross",
    reduceOnly: true,
    ordType: "conditional",
    sz: "0.5",
    slTriggerPx: "77200",
    state: "live"
  };
  const recovery = evaluateOkx51088ProtectionRecovery({
    inventory: [slOnly],
    reconcileCtx: baseCtx,
    tpRequired: true
  });
  assert.equal(recovery.repairRequired, true);
  assert.equal(recovery.repairAction, "combined_oco_rebuild");
  assert.equal(recovery.finalProtectionSatisfied, false);
  pass("CASE_14_51088_SL_ONLY_REPAIR", recovery.repairAction);
}

// CASE 15: tpRequired + no tpAlgoId => not satisfied
{
  const res = resolveProtectiveExistingAlgoLedgerAdoption({
    previousIsProtectiveStopRegistered: true,
    previousIsProtectionFailed: false,
    previousIsTakeProfitRegistered: false,
    previousProtectiveStopAlgoId: "sl1",
    previousProtectiveSlAlgoId: "sl1",
    previousProtectiveTpAlgoId: undefined,
    slAlgoId: "sl1",
    tpAlgoId: null,
    wantsTp: true,
    tpRequired: true,
    slRequired: true,
    slCanonicalMatch: true,
    tpCanonicalMatch: false
  });
  assert.equal(res.tpProtectionSatisfied, false);
  assert.equal(res.protectionComplete, false);
  pass("CASE_15_TP_REQUIRED_NO_ALGO_NOT_SATISFIED");
}

// CASE 16: SL+TP visible => protectionComplete
{
  const res = resolveProtectiveExistingAlgoLedgerAdoption({
    previousIsProtectiveStopRegistered: true,
    previousIsProtectionFailed: false,
    previousIsTakeProfitRegistered: true,
    previousProtectiveStopAlgoId: "sl1",
    previousProtectiveSlAlgoId: "sl1",
    previousProtectiveTpAlgoId: "tp1",
    slAlgoId: "sl1",
    tpAlgoId: "tp1",
    wantsTp: true,
    tpRequired: true,
    slRequired: true,
    slCanonicalMatch: true,
    tpCanonicalMatch: true
  });
  assert.equal(res.protectionComplete, true);
  pass("CASE_16_BOTH_LEGS_PROTECTION_COMPLETE");
}

// CASE 17: external manual position => no automatic V2 ownership breach in barrier
{
  const external: PaperOpenPositionRecord = {
    symbol: "ETHUSDT",
    side: "long",
    openedAt: NOW - 100_000,
    entryPrice: 2350,
    lifecycleState: "EXTERNAL_MANUAL_MANAGED",
    manualOwnershipLatch: true
  } as PaperOpenPositionRecord;
  const barrier = evaluateTerminalReentryBarrier({
    symbol: "ETHUSDT",
    requestedSide: "long",
    openPositions: [external],
    openPositionsSourceAvailable: true
  });
  assert.equal(barrier.blocked, false);
  pass("CASE_17_EXTERNAL_MANUAL_NO_FALSE_TERMINAL_BARRIER");
}

// CASE 18: lifecycle source unavailable => fail closed
{
  const barrier = evaluateTerminalReentryBarrier({
    symbol: "BTCUSDT",
    requestedSide: "short",
    openPositions: [],
    openPositionsSourceAvailable: false
  });
  assert.equal(barrier.blocked, true);
  assert.equal(barrier.reason, "TERMINAL_STATE_UNAVAILABLE_FAIL_CLOSED");
  pass("CASE_18_TERMINAL_STATE_UNAVAILABLE_FAIL_CLOSED");
}

assert.ok(isNonTerminalExitReason("TREND_HOLD_VALID"));
assert.ok(buildTerminalReentryBarrierProof({ symbol: "BTCUSDT", blocked: true }).event === "V2_TERMINAL_REENTRY_BARRIER_PROOF");
assert.equal(inferStructuralSetupEvent({ subtype: "RANGE_BREAKOUT" }), "confirmed_breakout");

console.log("\nALL P0 LOSS CHURN / EXIT / PROTECTION TESTS PASSED");
