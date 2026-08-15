/**
 * BLOCKER 4-5 — STALE / DIRECTION-BLIND SHOCK LOCK EXIT FIX
 * Regression test suite
 *
 * Validates that:
 * - CRASH_LOCK / PUMP_LOCK alone (stale time-latch) do NOT trigger SHOCK_PROTECTIVE_REDUCE
 * - BOTH-LOCK + directionalShockState=NONE → REDUCE = NO
 * - Real DOWN_SHOCK for LONG → adverse protection preserved
 * - Real UP_SHOCK for SHORT → adverse protection preserved
 * - SHOCK_FULL_EXIT_AGAINST_POSITION preserved
 * - Actual PNL stop / TP behaviors unchanged
 */

import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import type { EvaluateV2ExitPolicyArgs } from "../engine-v2/exit/types";
import type { V2StateAuthority } from "../engine-v2/state/types";
import type { MarketJudgmentOutput } from "../engine-v2/types";

function run(label: string, passed: boolean, detail: string): boolean {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[BLOCKER-4-5][${label}] ${tag} — ${detail}`);
  return passed;
}

// ── shared builder helpers ──────────────────────────────────────────────────

function makeJudgment(
  overrides: Partial<MarketJudgmentOutput> = {}
): MarketJudgmentOutput {
  return {
    regime: "RANGE",
    regime_final: "RANGE",
    subtype: "RANGE_MID",
    subtypeReason: "test",
    shockPhase: "NONE",
    rangePhase: "MID",
    trendPhase: "NONE",
    transitionPhase: "NONE",
    judgmentVersion: "v2_market_judgment_subtype_v1",
    no_trade_reason: null,
    data_ready: true,
    dump_protection_hit: false,
    volatility_guard_hit: false,
    reason: "test",
    metrics: {
      rangeScore: 0.6,
      trendScore: 0.2,
      boxCohesionCollapse: false,
      mixedBreakoutState: false,
      emaExpansionWeak: false
    },
    ...overrides
  } as MarketJudgmentOutput;
}

function makeV2State(
  overrides: Partial<V2StateAuthority> = {}
): V2StateAuthority {
  const base: V2StateAuthority = {
    symbol: "ETHUSDT",
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
    inferredIntentSide: "none"
  };
  return { ...base, ...overrides };
}

function makeShortPosition() {
  return {
    symbol: "ETHUSDT",
    side: "short" as const,
    sizeUsd: 20,
    entryPrice: 3000,
    leverage: 10,
    pnlPct: 0.003,
    entryStage: 1,
    peakUnrealizedPnlPct: 0.005
  };
}

function makeLongPosition() {
  return {
    symbol: "ETHUSDT",
    side: "long" as const,
    sizeUsd: 20,
    entryPrice: 3000,
    leverage: 10,
    pnlPct: 0.003,
    entryStage: 1,
    peakUnrealizedPnlPct: 0.005
  };
}

function makeArgs(
  positions: unknown[],
  stateOverrides: Partial<V2StateAuthority>,
  judgmentOverrides: Partial<MarketJudgmentOutput> = {}
): EvaluateV2ExitPolicyArgs {
  const v2State = makeV2State({
    symbolPositions: positions as any,
    ...stateOverrides
  });
  return {
    symbol: "ETHUSDT",
    v2State,
    judgment: makeJudgment(judgmentOverrides),
    snapshot: {
      boxPos: 0.5,
      boxBreakSide: "none",
      emaGap: 0,
      trendWeaknessScore: 0.2,
      rangeConfidence: 0.6,
      qualityScore: 75
    }
  };
}

let allOk = true;

// ── CASE A: SHORT + directionalShockState=NONE + CRASH_LOCK + PUMP_LOCK ────
// Expected: SHOCK_PROTECTIVE_REDUCE = NO
{
  const args = makeArgs(
    [makeShortPosition()],
    {
      directionalShockState: "NONE",
      crashState: "CRASH_LOCK",
      pumpState: "PUMP_LOCK",
      longAllow: true,
      shortAllow: true
    }
  );
  const result = evaluateV2ExitPolicy(args);
  const passed =
    result.reason !== "SHOCK_PROTECTIVE_REDUCE" &&
    result.action !== "REDUCE";
  allOk =
    run(
      "CASE A",
      passed,
      `action=${result.action} reason=${result.reason} (short+both-lock+NONE → no reduce)`
    ) && allOk;
}

// ── CASE B: LONG + directionalShockState=NONE + CRASH_LOCK + PUMP_LOCK ─────
// Expected: SHOCK_PROTECTIVE_REDUCE = NO
{
  const args = makeArgs(
    [makeLongPosition()],
    {
      directionalShockState: "NONE",
      crashState: "CRASH_LOCK",
      pumpState: "PUMP_LOCK",
      longAllow: true,
      shortAllow: true
    }
  );
  const result = evaluateV2ExitPolicy(args);
  const passed =
    result.reason !== "SHOCK_PROTECTIVE_REDUCE" &&
    result.action !== "REDUCE";
  allOk =
    run(
      "CASE B",
      passed,
      `action=${result.action} reason=${result.reason} (long+both-lock+NONE → no reduce)`
    ) && allOk;
}

// ── CASE C: LONG + DOWN_SHOCK → adverse shock protection preserved ──────────
// shockAgainst=true → SHOCK_FULL_EXIT_AGAINST_POSITION
{
  const args = makeArgs(
    [makeLongPosition()],
    {
      directionalShockState: "DOWN",
      crashState: "CRASH_LOCK",
      pumpState: "NONE",
      longAllow: false,
      shortAllow: true
    },
    { shockPhase: "DOWN_SHOCK" }
  );
  const result = evaluateV2ExitPolicy(args);
  const isShockExit =
    result.reason === "SHOCK_FULL_EXIT_AGAINST_POSITION" ||
    result.reason === "SHOCK_PROTECTIVE_REDUCE";
  allOk =
    run(
      "CASE C",
      isShockExit && result.action !== "HOLD",
      `action=${result.action} reason=${result.reason} (long+DOWN_SHOCK → adverse protection preserved)`
    ) && allOk;
}

// ── CASE D: SHORT + UP_SHOCK → adverse shock protection preserved ──────────
// shockAgainst=true → SHOCK_FULL_EXIT_AGAINST_POSITION
{
  const args = makeArgs(
    [makeShortPosition()],
    {
      directionalShockState: "UP",
      crashState: "NONE",
      pumpState: "PUMP_LOCK",
      longAllow: true,
      shortAllow: false
    },
    { shockPhase: "UP_SHOCK" }
  );
  const result = evaluateV2ExitPolicy(args);
  const isShockExit =
    result.reason === "SHOCK_FULL_EXIT_AGAINST_POSITION" ||
    result.reason === "SHOCK_PROTECTIVE_REDUCE";
  allOk =
    run(
      "CASE D",
      isShockExit && result.action !== "HOLD",
      `action=${result.action} reason=${result.reason} (short+UP_SHOCK → adverse protection preserved)`
    ) && allOk;
}

// ── CASE E: SHORT + CRASH_LOCK only + directionalShockState=NONE ──────────
// CRASH_LOCK is adverse to LONG, not SHORT. directionalShockState=NONE.
// Expected: SHOCK_PROTECTIVE_REDUCE = NO
{
  const args = makeArgs(
    [makeShortPosition()],
    {
      directionalShockState: "NONE",
      crashState: "CRASH_LOCK",
      pumpState: "NONE",
      longAllow: true,
      shortAllow: true
    }
  );
  const result = evaluateV2ExitPolicy(args);
  const passed = result.reason !== "SHOCK_PROTECTIVE_REDUCE";
  allOk =
    run(
      "CASE E",
      passed,
      `action=${result.action} reason=${result.reason} (short+CRASH_LOCK+NONE → no reduce)`
    ) && allOk;
}

// ── CASE F: LONG + PUMP_LOCK only + directionalShockState=NONE ───────────
// PUMP_LOCK is adverse to SHORT, not LONG. directionalShockState=NONE.
// Expected: SHOCK_PROTECTIVE_REDUCE = NO
{
  const args = makeArgs(
    [makeLongPosition()],
    {
      directionalShockState: "NONE",
      crashState: "NONE",
      pumpState: "PUMP_LOCK",
      longAllow: true,
      shortAllow: true
    }
  );
  const result = evaluateV2ExitPolicy(args);
  const passed = result.reason !== "SHOCK_PROTECTIVE_REDUCE";
  allOk =
    run(
      "CASE F",
      passed,
      `action=${result.action} reason=${result.reason} (long+PUMP_LOCK+NONE → no reduce)`
    ) && allOk;
}

// ── CASE G: Actual STOP breached (pnlPct <= -0.02) → FULL_EXIT preserved ──
{
  const stopPos = { ...makeLongPosition(), pnlPct: -0.022, peakUnrealizedPnlPct: -0.018 };
  const args = makeArgs(
    [stopPos],
    {
      directionalShockState: "NONE",
      crashState: "NONE",
      pumpState: "NONE"
    }
  );
  const result = evaluateV2ExitPolicy(args);
  allOk =
    run(
      "CASE G",
      result.action === "FULL_EXIT" && result.reason === "PNL_STOP_PROTECT",
      `action=${result.action} reason=${result.reason} (stop breach → FULL_EXIT preserved)`
    ) && allOk;
}

// ── CASE H: TP zone (RANGE UPPER edge + positive PnL) → TP not disrupted ──
{
  const tpPos = { ...makeLongPosition(), pnlPct: 0.018, peakUnrealizedPnlPct: 0.02 };
  const args: EvaluateV2ExitPolicyArgs = {
    symbol: "ETHUSDT",
    v2State: makeV2State({
      symbolPositions: [tpPos] as any,
      directionalShockState: "NONE",
      crashState: "NONE",
      pumpState: "NONE"
    }),
    judgment: makeJudgment({
      regime_final: "RANGE",
      rangePhase: "UPPER"
    }),
    snapshot: {
      boxPos: 0.82,
      boxBreakSide: "none",
      emaGap: 10,
      trendWeaknessScore: 0.2,
      rangeConfidence: 0.7,
      qualityScore: 80
    }
  };
  const result = evaluateV2ExitPolicy(args);
  // TP zone: PARTIAL_TAKE_PROFIT from RANGE_PARTIAL_AT_OPPOSITE_EDGE
  // or profit-pipeline-related exit — must NOT be a shock-related reduce
  const isNotShockReduce = result.reason !== "SHOCK_PROTECTIVE_REDUCE";
  allOk =
    run(
      "CASE H",
      isNotShockReduce,
      `action=${result.action} reason=${result.reason} (TP zone behavior not disrupted by shock logic)`
    ) && allOk;
}

// ── CASE I: SHOCK_FULL_EXIT_AGAINST_POSITION preserved ────────────────────
// LONG with shockPhase=DOWN_SHOCK → shockAgainst=true → FULL_EXIT (not REDUCE)
{
  const args = makeArgs(
    [makeLongPosition()],
    {
      directionalShockState: "DOWN",
      crashState: "CRASH_LOCK",
      pumpState: "NONE"
    },
    { shockPhase: "DOWN_SHOCK" }
  );
  const result = evaluateV2ExitPolicy(args);
  allOk =
    run(
      "CASE I",
      result.reason === "SHOCK_FULL_EXIT_AGAINST_POSITION" &&
        result.action === "FULL_EXIT" &&
        result.reduceRatio === 1,
      `action=${result.action} reason=${result.reason} reduceRatio=${result.reduceRatio} (SHOCK_FULL_EXIT_AGAINST_POSITION preserved)`
    ) && allOk;
}

console.log(
  `\n[BLOCKER-4-5] Regression suite complete. Overall: ${allOk ? "ALL PASS" : "SOME FAIL"}`
);
if (!allOk) process.exit(1);
