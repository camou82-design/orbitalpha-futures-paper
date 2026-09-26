import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import type { EvaluateV2ExitPolicyArgs } from "../engine-v2/exit/types";
import type { MarketJudgmentOutput } from "../engine-v2/types";
import type { V2StateAuthority } from "../engine-v2/state/types";
import type { PaperOpenPositionRecord } from "../models/types";
import { markProtectiveReduceEpisodeFilled, isPriorShockDefensiveReduce } from "../engine-v2/execution/reduce-economics";

function assertTrue(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertEq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new Error(`Expected [${expected}] but got [${actual}] - ${msg}`);
  }
}

function makeJudgment(overrides: Partial<MarketJudgmentOutput> = {}): MarketJudgmentOutput {
  return {
    regime_final: "RANGE",
    subtype: "NONE",
    shockPhase: "NONE",
    rangePhase: "MID",
    trendPhase: "NONE",
    transitionPhase: "NONE",
    isAmbiguous: false,
    noTradeReason: "NONE",
    qualityScore: 75,
    metadata: {
      boxPos: 0.5,
      boxBreakSide: "none",
      emaGap: 0,
      trendWeaknessScore: 0.3,
      rangeConfidence: 0.7,
      atr20: 300,
      breakoutFailureRate: 0,
      rangeOscillationScore: 0.8,
      boxCohesion01: 0.9,
      emaExpansionWeak: false
    },
    ...overrides
  } as MarketJudgmentOutput;
}

function makeV2State(symbol: "BTCUSDT" | "ETHUSDT", overrides: Partial<V2StateAuthority> = {}): V2StateAuthority {
  const base: V2StateAuthority = {
    symbol,
    now: Date.now(),
    currentPositions: [],
    symbolPositions: [],
    longPosition: null,
    shortPosition: null,
    hasLongPosition: false,
    hasShortPosition: false,
    longStage: 0,
    shortStage: 0,
    sameSidePosition: null,
    oppositeSidePosition: null,
    hasSameSidePosition: false,
    hasOppositeSidePosition: false,
    currentStage: 0,
    positionStateReady: true,
    marketSnapshotReady: true,
    v2InputReady: true,
    serverTradeEnabled: true,
    closeOnlyMode: false,
    killSwitch: false,
    reconcileSafeMode: false,
    riskMode: "NORMAL",
    dailyLossGuardTriggered: false,
    freshTickBarrierActive: false,
    freshTickExecutionBlocked: false,
    freshTickCompletedCycles: 3,
    freshTickRequiredCycles: 3,
    paperExecutionReady: true,
    signedExecutionReady: false,
    okxAuthMode: "disabled",
    okxAuthReady: false,
    okxExchangeAuthOptIn: false,
    okxLiveEnabled: false,
    okxDemoEnabled: false,
    okxApiKeyPresent: false,
    okxApiSecretPresent: false,
    okxPassphrasePresent: false,
    okxSimulatedTradingHeaderEnabled: false,
    liveMaxOrderNotionalUsdt: 100,
    directionalShockState: "NONE",
    crashState: "NONE",
    pumpState: "NONE",
    longAllow: true,
    shortAllow: true,
    accountEquityKrw: 500_000,
    maxUsableMarginKrw: 420_000,
    exposureNotionalCapKrw: 2_000_000,
    symbolExposureNotionalCapKrw: 1_400_000,
    ledgerExposureNotionalKrw: 20_000,
    symbolLedgerExposureNotionalKrw: 20_000,
    lossStreaks: {},
    entryQualityProfiles: undefined,
    stateAuthoritySource: "v2_state_authority_from_bridge",
    heldPositionSide: "none",
    managementSide: "none",
    candidateIntentSide: "none",
    inferredIntentSide: "none",
    hasOppositeToCandidate: false
  };
  return { ...base, ...overrides };
}

function makeArgs(
  symbol: "BTCUSDT" | "ETHUSDT",
  pos: any,
  v2StateOverrides: Partial<V2StateAuthority>,
  judgmentOverrides: Partial<MarketJudgmentOutput>,
  markPrice: number,
  invalidationBreachConfirmed = false
): EvaluateV2ExitPolicyArgs {
  const positions = pos ? [pos] : [];
  const v2State = makeV2State(symbol, {
    symbolPositions: positions,
    longPosition: pos?.side === "long" ? pos : null,
    shortPosition: pos?.side === "short" ? pos : null,
    hasLongPosition: pos?.side === "long",
    hasShortPosition: pos?.side === "short",
    ...v2StateOverrides
  });
  const judgment = makeJudgment(judgmentOverrides);
  return {
    symbol,
    v2State,
    judgment,
    snapshot: {
      boxPos: 0.5,
      boxBreakSide: "none",
      emaGap: 0,
      trendWeaknessScore: 0.3,
      rangeConfidence: 0.7,
      qualityScore: 75,
      atr20: symbol === "BTCUSDT" ? 500 : 25
    },
    markPrice,
    invalidationBreachConfirmed
  };
}

function makePaperOpen(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  const base = {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 65000,
    sizeUsd: 1000,
    openedAt: Date.now(),
    leverage: 10,
    strategyVersion: "v2",
    sourceSignal: "NONE",
    sourceRunPath: "test",
    entryStage: 1,
    unrealizedPnlPct: -0.005
  };
  return { ...base, ...overrides } as unknown as PaperOpenPositionRecord;
}

let allOk = true;
function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`[PHASE-2A-TEST][PASS] ${name}`);
  } catch (err) {
    allOk = false;
    console.error(`[PHASE-2A-TEST][FAIL] ${name}:`, (err as Error).message);
  }
}

console.log("=== PHASE 2A: SHOCK PROVENANCE & EXIT SOFTEN SUITE (12 TESTS) ===\n");

// ── Test 1: CONFIRMED + first Shock → REDUCE 35% ──
run("Test 1: CONFIRMED + first Shock -> REDUCE 35%", () => {
  const entryPrice = 65000;
  const markPrice = 64800; // -0.307% adverse move (>= 0.15%)
  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 1000,
    entryPrice,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 63500,
    slProtectionSatisfied: true,
    slProtectionProvisional: false, // Authoritative CONFIRMED
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_btc_sl_123"
  };
  const args = makeArgs(
    "BTCUSDT",
    pos,
    { directionalShockState: "DOWN" },
    { shockPhase: "DOWN_SHOCK" },
    markPrice
  );
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "REDUCE", "Action must be REDUCE");
  assertEq(res.reason, "SHOCK_FULL_EXIT_AGAINST_POSITION", "Reason preserved");
  assertEq(res.reduceRatio, 0.35, "ReduceRatio must be 0.35 (35%)");
  assertTrue(res.evidence.includes("shock_full_exit_downgraded_to_reduce:sl_confirmed"), "Evidence tagged");
});

// ── Test 2: first Shock 체결 후 → shockReduceState = FILLED ──
run("Test 2: first Shock fill -> shockReduceState = FILLED", () => {
  const openPos = makePaperOpen({
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 65000,
    sizeUsd: 1000
  });

  markProtectiveReduceEpisodeFilled(openPos, {
    episodeId: "BTCUSDT|long|SHOCK_FULL_EXIT_AGAINST_POSITION|DOWN_SHOCK|SHOCK",
    reason: "SHOCK_FULL_EXIT_AGAINST_POSITION",
    decisionCandleTs: 100000,
    filledAt: Date.now(),
    shockPhase: "DOWN_SHOCK",
    reduceRatio: 0.35
  });

  assertEq(openPos.shockReduceState, "FILLED", "shockReduceState must be FILLED after shock reduce fill");
  assertEq(openPos.lastReduceReason, "SHOCK_FULL_EXIT_AGAINST_POSITION", "lastReduceReason set");
});

// ── Test 3: first Shock → TRANSITION_REDUCE_ON_CONFLICT → second Shock → WATCH 0% ──
run("Test 3: first Shock -> TRANSITION_REDUCE_ON_CONFLICT -> second Shock -> WATCH 0%", () => {
  const openPos = makePaperOpen({
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 65000,
    sizeUsd: 1000
  });

  // 1. First shock fill
  markProtectiveReduceEpisodeFilled(openPos, {
    episodeId: "ep1",
    reason: "SHOCK_FULL_EXIT_AGAINST_POSITION",
    decisionCandleTs: 100000,
    filledAt: Date.now(),
    reduceRatio: 0.35
  });
  assertEq(openPos.shockReduceState, "FILLED", "Step 1: shockReduceState is FILLED");

  // 2. Intermediate transition reduce (overwrites lastReduceReason, but shockReduceState stays FILLED)
  markProtectiveReduceEpisodeFilled(openPos, {
    episodeId: "ep2",
    reason: "TRANSITION_REDUCE_ON_CONFLICT",
    decisionCandleTs: 200000,
    filledAt: Date.now(),
    reduceRatio: 0.25
  });
  assertEq(openPos.lastReduceReason, "TRANSITION_REDUCE_ON_CONFLICT", "Step 2: lastReduceReason overwritten");
  assertEq(openPos.shockReduceState, "FILLED", "Step 2: shockReduceState preserved as FILLED");

  // 3. Second shock occurs on this position
  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 500,
    entryPrice: 65000,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 63500,
    slProtectionSatisfied: true,
    slProtectionProvisional: false,
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_btc_sl_123",
    shockReduceState: openPos.shockReduceState,
    lastReduceReason: openPos.lastReduceReason
  };
  const args = makeArgs("BTCUSDT", pos, { directionalShockState: "DOWN" }, { shockPhase: "DOWN_SHOCK" }, 64800);
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "WATCH", "Second shock must be WATCH 0% (repeat suppressed)");
  assertEq(res.reduceRatio, 0, "ReduceRatio 0%");
  assertEq(res.reason, "TRANSITION_PROTECTIVE_WATCH", "Reason is TRANSITION_PROTECTIVE_WATCH");
  assertTrue(res.evidence.includes("repeat_shock_defensive_reduce_suppressed"), "Repeat suppressed tag present");
});

// ── Test 4: first Shock → PNL_STOP_PROTECT reduce → second Shock → WATCH 0% ──
run("Test 4: first Shock -> PNL_STOP_PROTECT reduce -> second Shock -> WATCH 0%", () => {
  const openPos = makePaperOpen({
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 65000,
    sizeUsd: 1000
  });

  // 1. First shock fill
  markProtectiveReduceEpisodeFilled(openPos, {
    episodeId: "ep1",
    reason: "SHOCK_FULL_EXIT_AGAINST_POSITION",
    decisionCandleTs: 100000,
    filledAt: Date.now(),
    reduceRatio: 0.35
  });

  // 2. Intermediate PNL_STOP_PROTECT reduce
  markProtectiveReduceEpisodeFilled(openPos, {
    episodeId: "ep2",
    reason: "PNL_STOP_PROTECT",
    decisionCandleTs: 200000,
    filledAt: Date.now(),
    reduceRatio: 0.25
  });
  assertEq(openPos.lastReduceReason, "PNL_STOP_PROTECT", "lastReduceReason is PNL_STOP_PROTECT");
  assertEq(openPos.shockReduceState, "FILLED", "shockReduceState is still FILLED");

  // 3. Second shock
  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 500,
    entryPrice: 65000,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 63500,
    slProtectionSatisfied: true,
    slProtectionProvisional: false,
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_btc_sl_123",
    shockReduceState: openPos.shockReduceState,
    lastReduceReason: openPos.lastReduceReason
  };
  const args = makeArgs("BTCUSDT", pos, { directionalShockState: "DOWN" }, { shockPhase: "DOWN_SHOCK" }, 64800);
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "WATCH", "Second shock must be WATCH 0%");
  assertEq(res.reduceRatio, 0, "ReduceRatio 0%");
  assertTrue(res.evidence.includes("repeat_shock_defensive_reduce_suppressed"), "Repeat suppressed tag");
});

// ── Test 5: first Shock → restart/reload → second Shock → WATCH 0% ──
run("Test 5: first Shock -> restart/reload -> second Shock -> WATCH 0%", () => {
  const openPos = makePaperOpen({
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 65000,
    sizeUsd: 1000
  });

  markProtectiveReduceEpisodeFilled(openPos, {
    episodeId: "ep1",
    reason: "SHOCK_FULL_EXIT_AGAINST_POSITION",
    decisionCandleTs: 100000,
    filledAt: Date.now(),
    reduceRatio: 0.35
  });

  // Simulate process restart: JSON serialize / deserialize from open.json
  const serialized = JSON.stringify(openPos);
  const restored = JSON.parse(serialized) as PaperOpenPositionRecord;
  assertEq(restored.shockReduceState, "FILLED", "Restored position preserves shockReduceState=FILLED");

  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 650,
    entryPrice: 65000,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 63500,
    slProtectionSatisfied: true,
    slProtectionProvisional: false,
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_btc_sl_123",
    shockReduceState: restored.shockReduceState,
    lastReduceReason: restored.lastReduceReason
  };
  const args = makeArgs("BTCUSDT", pos, { directionalShockState: "DOWN" }, { shockPhase: "DOWN_SHOCK" }, 64800);
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "WATCH", "Restored position with shockReduceState=FILLED produces WATCH 0%");
  assertEq(res.reduceRatio, 0, "ReduceRatio 0%");
  assertTrue(res.evidence.includes("repeat_shock_defensive_reduce_suppressed"), "Repeat suppressed tag");
});

// ── Test 6: first Shock → non-shock reduce → restart/reload → second Shock → WATCH 0% ──
run("Test 6: first Shock -> non-shock reduce -> restart/reload -> second Shock -> WATCH 0%", () => {
  const openPos = makePaperOpen({
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 65000,
    sizeUsd: 1000
  });

  // 1. Shock reduce
  markProtectiveReduceEpisodeFilled(openPos, {
    episodeId: "ep1",
    reason: "SHOCK_FULL_EXIT_AGAINST_POSITION",
    decisionCandleTs: 100000,
    filledAt: Date.now(),
    reduceRatio: 0.35
  });

  // 2. Non-shock reduce (overwriting lastReduceReason)
  markProtectiveReduceEpisodeFilled(openPos, {
    episodeId: "ep2",
    reason: "TRANSITION_REDUCE_ON_CONFLICT",
    decisionCandleTs: 200000,
    filledAt: Date.now(),
    reduceRatio: 0.25
  });

  // 3. Process restart / open.json reload
  const serialized = JSON.stringify(openPos);
  const restored = JSON.parse(serialized) as PaperOpenPositionRecord;
  assertEq(restored.shockReduceState, "FILLED", "Restored shockReduceState is FILLED");
  assertEq(restored.lastReduceReason, "TRANSITION_REDUCE_ON_CONFLICT", "Restored lastReduceReason is transition reduce");

  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 487.5,
    entryPrice: 65000,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 63500,
    slProtectionSatisfied: true,
    slProtectionProvisional: false,
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_btc_sl_123",
    shockReduceState: restored.shockReduceState,
    lastReduceReason: restored.lastReduceReason
  };
  const args = makeArgs("BTCUSDT", pos, { directionalShockState: "DOWN" }, { shockPhase: "DOWN_SHOCK" }, 64800);
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "WATCH", "Restored position after intermediate reduce produces WATCH 0%");
  assertEq(res.reduceRatio, 0, "ReduceRatio 0%");
  assertTrue(res.evidence.includes("repeat_shock_defensive_reduce_suppressed"), "Repeat suppressed tag");
});

// ── Test 7: non-shock reduce만 존재하고 Shock 이력 없음 → first Shock → REDUCE 35% ──
run("Test 7: Non-shock reduce only, no shock history -> first Shock -> REDUCE 35%", () => {
  const openPos = makePaperOpen({
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 65000,
    sizeUsd: 1000
  });

  // Only a transition reduce has happened
  markProtectiveReduceEpisodeFilled(openPos, {
    episodeId: "ep_trans",
    reason: "TRANSITION_REDUCE_ON_CONFLICT",
    decisionCandleTs: 100000,
    filledAt: Date.now(),
    reduceRatio: 0.25
  });
  assertEq(openPos.shockReduceState, undefined, "shockReduceState must NOT be set to FILLED by transition reduce");
  assertEq(openPos.lastReduceReason, "TRANSITION_REDUCE_ON_CONFLICT", "lastReduceReason recorded");

  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 750,
    entryPrice: 65000,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 63500,
    slProtectionSatisfied: true,
    slProtectionProvisional: false,
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_btc_sl_123",
    shockReduceState: openPos.shockReduceState,
    lastReduceReason: openPos.lastReduceReason,
    protectivePartialReduceCount: openPos.protectivePartialReduceCount
  };
  const args = makeArgs("BTCUSDT", pos, { directionalShockState: "DOWN" }, { shockPhase: "DOWN_SHOCK" }, 64800);
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "REDUCE", "First Shock must execute REDUCE 35% even if transition reduce happened before");
  assertEq(res.reason, "SHOCK_FULL_EXIT_AGAINST_POSITION", "Reason preserved");
  assertEq(res.reduceRatio, 0.35, "ReduceRatio 0.35");
  assertTrue(res.evidence.includes("shock_full_exit_downgraded_to_reduce:sl_confirmed"), "Downgraded tag");
});

// ── Test 8: PROVISIONAL_PROTECTED + Shock → FULL_EXIT 100% ──
run("Test 8: PROVISIONAL_PROTECTED + Shock -> FULL_EXIT 100%", () => {
  const entryPrice = 65000;
  const markPrice = 64900; // -0.1538% adverse move
  const now = Date.now();
  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 1000,
    entryPrice,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 63500,
    slProtectionSatisfied: true, // AlgoId exists
    slProtectionProvisional: true, // But unconfirmed on OKX (in visibility grace)
    protectiveVisibilityGraceDeadlineMs: now + 25000,
    protectiveSlAlgoId: "algo_provisional_unconfirmed"
  };
  const args = makeArgs(
    "BTCUSDT",
    pos,
    { directionalShockState: "DOWN" },
    { shockPhase: "DOWN_SHOCK" },
    markPrice
  );
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "FULL_EXIT", "Action must be FULL_EXIT because SL is provisional");
  assertEq(res.reason, "SHOCK_FULL_EXIT_AGAINST_POSITION", "Reason must be SHOCK_FULL_EXIT_AGAINST_POSITION");
  assertEq(res.reduceRatio, 1, "ReduceRatio must be 1");
  assertTrue(res.evidence.includes("shock_full_exit_unprotected_exchange_sl"), "Tagged as unprotected");
});

// ── Test 9: UNPROTECTED + Shock → FULL_EXIT 100% ──
run("Test 9: UNPROTECTED + Shock -> FULL_EXIT 100%", () => {
  const entryPrice = 65000;
  const markPrice = 64900;
  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 1000,
    entryPrice,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: null, // No SL registered
    slProtectionSatisfied: false
  };
  const args = makeArgs(
    "BTCUSDT",
    pos,
    { directionalShockState: "DOWN" },
    { shockPhase: "DOWN_SHOCK" },
    markPrice
  );
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "FULL_EXIT", "Action must be FULL_EXIT");
  assertEq(res.reason, "SHOCK_FULL_EXIT_AGAINST_POSITION", "Reason must be SHOCK_FULL_EXIT_AGAINST_POSITION");
  assertEq(res.reduceRatio, 1, "ReduceRatio must be 1");
  assertTrue(res.evidence.includes("shock_full_exit_unprotected_exchange_sl"), "Unprotected SL tag");
});

// ── Test 10: actual SL breach → FULL_EXIT 유지 ──
run("Test 10: Actual SL breach triggers sovereign FULL_EXIT", () => {
  const entryPrice = 65000;
  const markPrice = 63400; // breached ledger_stop_px 63500
  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 1000,
    entryPrice,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 63500,
    slProtectionSatisfied: true,
    slProtectionProvisional: false,
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_btc_sl_123"
  };
  const args = makeArgs(
    "BTCUSDT",
    pos,
    { directionalShockState: "DOWN" },
    { shockPhase: "DOWN_SHOCK" },
    markPrice
  );
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "FULL_EXIT", "Action must be FULL_EXIT");
  assertEq(res.reason, "PNL_STOP_PROTECT", "Reason must be PNL_STOP_PROTECT");
  assertEq(res.reduceRatio, 1, "ReduceRatio must be 1");
  assertTrue(res.evidence.includes("committed_stop_breached"), "Committed stop tag");
});

// ── Test 11: V2_EXIT_INVALIDATION → FULL_EXIT 유지 ──
run("Test 11: V2_EXIT_INVALIDATION with structure breached triggers FULL_EXIT", () => {
  const entryPrice = 65000;
  const markPrice = 64800;
  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 1000,
    entryPrice,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 63500,
    structureBreached: true,
    slProtectionSatisfied: true,
    slProtectionProvisional: false,
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_btc_sl_123"
  };
  const args = makeArgs(
    "BTCUSDT",
    pos,
    { directionalShockState: "DOWN" },
    { shockPhase: "DOWN_SHOCK" },
    markPrice,
    true
  );
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "FULL_EXIT", "Action must be FULL_EXIT");
  assertEq(res.reason, "V2_EXIT_INVALIDATION", "Reason must be V2_EXIT_INVALIDATION");
  assertEq(res.reduceRatio, 1, "ReduceRatio must be 1");
  assertTrue(res.evidence.includes("hard_invalidation_confirmed_with_absolute_move"), "Hard invalidation tag");
});

// ── Test 12: BTC/ETH long/short 대칭성 검증 ──
run("Test 12: Symmetrical behavior across BTC and ETH long/short", () => {
  const btcShortPos = {
    symbol: "BTCUSDT",
    side: "short" as const,
    sizeUsd: 1000,
    entryPrice: 65000,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 66500,
    slProtectionSatisfied: true,
    slProtectionProvisional: false,
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_btc"
  };
  const ethLongPos = {
    symbol: "ETHUSDT",
    side: "long" as const,
    sizeUsd: 500,
    entryPrice: 3000,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 2900,
    slProtectionSatisfied: true,
    slProtectionProvisional: false,
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_eth"
  };

  const btcArgs = makeArgs("BTCUSDT", btcShortPos, { directionalShockState: "UP" }, { shockPhase: "UP_SHOCK" }, 65200);
  const ethArgs = makeArgs("ETHUSDT", ethLongPos, { directionalShockState: "DOWN" }, { shockPhase: "DOWN_SHOCK" }, 2990);

  const btcRes = evaluateV2ExitPolicy(btcArgs);
  const ethRes = evaluateV2ExitPolicy(ethArgs);

  assertEq(btcRes.action, "REDUCE", "BTC action REDUCE");
  assertEq(ethRes.action, "REDUCE", "ETH action REDUCE");
  assertEq(btcRes.reduceRatio, 0.35, "BTC reduceRatio 0.35");
  assertEq(ethRes.reduceRatio, 0.35, "ETH reduceRatio 0.35");
  assertEq(btcRes.reason, ethRes.reason, "Reasons match");
});

if (!allOk) {
  console.error("\n[PHASE-2A-TEST] FAILED!");
  process.exit(1);
} else {
  console.log("\n[PHASE-2A-TEST] ALL 12 REGRESSION TESTS PASSED PERFECTLY!");
}

