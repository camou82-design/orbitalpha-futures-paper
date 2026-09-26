import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import type { EvaluateV2ExitPolicyArgs } from "../engine-v2/exit/types";
import type { MarketJudgmentOutput } from "../engine-v2/types";
import type { V2StateAuthority } from "../engine-v2/state/types";

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

console.log("=== PHASE 2A: SHOCK-ONLY FULL EXIT SOFTEN SUITE ===\n");

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

// ── Test 2: CONFIRMED + previous Shock reduce → WATCH 0% (repeat shock suppression) ──
run("Test 2: CONFIRMED + previous Shock reduce -> WATCH 0%", () => {
  const entryPrice = 65000;
  const markPrice = 64800;
  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 650, // reduced from 1000
    entryPrice,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 63500,
    slProtectionSatisfied: true,
    slProtectionProvisional: false,
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_btc_sl_123",
    lastReduceReason: "SHOCK_FULL_EXIT_AGAINST_POSITION"
  };
  const args = makeArgs(
    "BTCUSDT",
    pos,
    { directionalShockState: "DOWN" },
    { shockPhase: "DOWN_SHOCK" },
    markPrice
  );
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "WATCH", "Action must be WATCH");
  assertEq(res.reason, "TRANSITION_PROTECTIVE_WATCH", "Reason is TRANSITION_PROTECTIVE_WATCH");
  assertEq(res.reduceRatio, 0, "ReduceRatio must be 0");
  assertTrue(res.evidence.includes("repeat_shock_defensive_reduce_suppressed"), "Repeat suppressed tag");
});

// ── Test 3: PROVISIONAL_PROTECTED + Shock → FULL_EXIT 100% (Bug 1 fixed: no downgrade during visibility grace) ──
run("Test 3: PROVISIONAL_PROTECTED + Shock -> FULL_EXIT 100%", () => {
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

// ── Test 4: UNPROTECTED + Shock → FULL_EXIT 100% ──
run("Test 4: UNPROTECTED + Shock -> FULL_EXIT 100%", () => {
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

// ── Test 5: TRANSITION_REDUCE_ON_CONFLICT 이력 + first Shock → REDUCE 35% (Bug 2 fixed) ──
run("Test 5: TRANSITION_REDUCE_ON_CONFLICT history + first Shock -> REDUCE 35%", () => {
  const entryPrice = 65000;
  const markPrice = 64800;
  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 750,
    entryPrice,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 63500,
    slProtectionSatisfied: true,
    slProtectionProvisional: false,
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_btc_sl_123",
    lastReduceReason: "TRANSITION_REDUCE_ON_CONFLICT",
    protectivePartialReduceCount: 1
  };
  const args = makeArgs(
    "BTCUSDT",
    pos,
    { directionalShockState: "DOWN" },
    { shockPhase: "DOWN_SHOCK" },
    markPrice
  );
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "REDUCE", "Action must be REDUCE on first Shock despite transition reduce history");
  assertEq(res.reason, "SHOCK_FULL_EXIT_AGAINST_POSITION", "Reason preserved");
  assertEq(res.reduceRatio, 0.35, "ReduceRatio 0.35");
  assertTrue(res.evidence.includes("shock_full_exit_downgraded_to_reduce:sl_confirmed"), "Downgraded tag");
});

// ── Test 6: PNL_STOP_PROTECT 이력 + first Shock → REDUCE 35% (Bug 2 fixed) ──
run("Test 6: PNL_STOP_PROTECT history + first Shock -> REDUCE 35%", () => {
  const entryPrice = 65000;
  const markPrice = 64800;
  const pos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    sizeUsd: 750,
    entryPrice,
    leverage: 10,
    pnlPct: -0.005,
    entryStage: 1,
    ledger_stop_px: 63500,
    slProtectionSatisfied: true,
    slProtectionProvisional: false,
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "algo_btc_sl_123",
    lastReduceReason: "PNL_STOP_PROTECT",
    protectivePartialReduceCount: 1
  };
  const args = makeArgs(
    "BTCUSDT",
    pos,
    { directionalShockState: "DOWN" },
    { shockPhase: "DOWN_SHOCK" },
    markPrice
  );
  const res = evaluateV2ExitPolicy(args);
  assertEq(res.action, "REDUCE", "Action must be REDUCE on first Shock despite pnl stop reduce history");
  assertEq(res.reason, "SHOCK_FULL_EXIT_AGAINST_POSITION", "Reason preserved");
  assertEq(res.reduceRatio, 0.35, "ReduceRatio 0.35");
  assertTrue(res.evidence.includes("shock_full_exit_downgraded_to_reduce:sl_confirmed"), "Downgraded tag");
});

// ── Test 7: actual SL breach → FULL_EXIT 유지 ──
run("Test 7: Actual SL breach triggers sovereign FULL_EXIT", () => {
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

// ── Test 8: V2_EXIT_INVALIDATION → FULL_EXIT 유지 ──
run("Test 8: V2_EXIT_INVALIDATION with structure breached triggers FULL_EXIT", () => {
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

// ── Test 9: BTC/ETH long/short 대칭성 검증 ──
run("Test 9: Symmetrical behavior across BTC and ETH long/short", () => {
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
  console.log("\n[PHASE-2A-TEST] ALL 9 REGRESSION TESTS PASSED PERFECTLY!");
}
