/**
 * BOT_V2 Post-Fill Liveness Patch — Shock Exit + Add-on Reachability
 * Dedicated regression suite (no commit/deploy).
 */

import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import type { EvaluateV2ExitPolicyArgs } from "../engine-v2/exit/types";
import {
  isShockFullExitConfirmationMet,
  SHOCK_FULL_EXIT_STRONG_ADVERSE_MOVE_PCT
} from "../engine-v2/exit/shock-full-exit-confirmation";
import { evaluatePnlStopMeaningfulMoveGate } from "../engine-v2/exit/pnl-stop-gate";
import { evaluateV2AddOnPolicy } from "../engine-v2/addon/policy";
import type { V2StateAuthority } from "../engine-v2/state/types";
import type { MarketJudgmentOutput } from "../engine-v2/types";

function run(label: string, passed: boolean, detail: string): boolean {
  console.log(`[POST-FILL-LIVENESS][${label}] ${passed ? "PASS" : "FAIL"} — ${detail}`);
  return passed;
}

function makeJudgment(overrides: Partial<MarketJudgmentOutput> = {}): MarketJudgmentOutput {
  return {
    regime: "TREND",
    regime_final: "TREND",
    subtype: "NONE",
    subtypeReason: "test",
    shockPhase: "NONE",
    rangePhase: "NONE",
    trendPhase: "UP",
    transitionPhase: "NONE",
    judgmentVersion: "v2_market_judgment_subtype_v1",
    no_trade_reason: null,
    data_ready: true,
    dump_protection_hit: false,
    volatility_guard_hit: false,
    reason: "test",
    metrics: { rangeScore: 0.4, trendScore: 0.7 },
    ...overrides
  } as MarketJudgmentOutput;
}

function makeV2State(overrides: Partial<V2StateAuthority> = {}): V2StateAuthority {
  return {
    symbol: "BTCUSDT",
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
    stateAuthoritySource: "v2_state_authority_from_bridge",
    inferredIntentSide: "none",
    ...overrides
  } as V2StateAuthority;
}

function exitArgs(input: {
  side: "long" | "short";
  entryPrice?: number;
  markPrice?: number;
  shockPhase?: "DOWN_SHOCK" | "UP_SHOCK" | "NONE";
  directionalShockState?: "DOWN" | "UP" | "NONE";
  structuralBreakConfirmed?: boolean;
  structureBreached?: boolean;
  invalidationBreachConfirmed?: boolean;
  priorDefensiveReduce?: boolean;
}): EvaluateV2ExitPolicyArgs {
  const entryPrice = input.entryPrice ?? 95000;
  const dss =
    input.directionalShockState ??
    (input.shockPhase === "DOWN_SHOCK" ? "DOWN" : input.shockPhase === "UP_SHOCK" ? "UP" : "NONE");
  const posBase =
    input.side === "long"
      ? {
          symbol: "BTCUSDT",
          side: "long" as const,
          sizeUsd: 120,
          entryPrice,
          leverage: 1,
          pnlPct: -0.0005,
          entryStage: 1,
          structureBreached: input.structureBreached,
          lastReduceReason: input.priorDefensiveReduce ? "SHOCK_PROTECTIVE_REDUCE" : undefined,
          protectivePartialReduceCount: input.priorDefensiveReduce ? 1 : 0
        }
      : {
          symbol: "BTCUSDT",
          side: "short" as const,
          sizeUsd: 120,
          entryPrice,
          leverage: 1,
          pnlPct: -0.0005,
          entryStage: 1,
          structureBreached: input.structureBreached,
          lastReduceReason: input.priorDefensiveReduce ? "SHOCK_PROTECTIVE_REDUCE" : undefined,
          protectivePartialReduceCount: input.priorDefensiveReduce ? 1 : 0
        };
  return {
    symbol: "BTCUSDT",
    v2State: makeV2State({
      symbolPositions: [posBase] as any,
      directionalShockState: dss as any,
      crashState: dss === "DOWN" ? "CRASH_LOCK" : "NONE",
      pumpState: dss === "UP" ? "PUMP_LOCK" : "NONE"
    }),
    judgment: makeJudgment({
      shockPhase: input.shockPhase ?? "NONE",
      trendPhase: input.side === "long" ? "UP" : "DOWN"
    }),
    snapshot: {
      boxPos: 0.5,
      boxBreakSide: "none",
      emaGap: 0,
      trendWeaknessScore: 0.3,
      rangeConfidence: 0.6,
      qualityScore: 75
    },
    markPrice: input.markPrice,
    structuralBreakConfirmed: input.structuralBreakConfirmed,
    invalidationBreachConfirmed: input.invalidationBreachConfirmed
  };
}

function adverseMark(side: "long" | "short", entry: number, adversePct: number): number {
  return side === "long" ? entry * (1 - adversePct) : entry * (1 + adversePct);
}

/** Mirrors paper-engine.ts:6488–6536 — sole production reviewing_ticks producer on decision path. */
function productionReviewingTicks(input: {
  symbol: string;
  signal: string;
  qualityScore: number;
  hasOpenPosition: boolean;
  currentStage: number;
  state?: Map<string, { ticks: number; initialQuality: number; side: "long" | "short" }>;
}): number {
  const state = input.state ?? new Map();
  const symKey = input.symbol;
  const candidateSide: "long" | "short" | null =
    input.signal === "paper_long_candidate"
      ? "long"
      : input.signal === "paper_short_candidate"
        ? "short"
        : null;
  const candidateEligible =
    candidateSide != null && !input.hasOpenPosition && input.currentStage === 0;
  if (!candidateEligible) {
    state.delete(symKey);
    return 0;
  }
  const rev = state.get(symKey);
  const qualityScore = input.qualityScore;
  let nextTicks = 1;
  if (rev && rev.side === candidateSide && qualityScore >= rev.initialQuality - 2) {
    nextTicks = rev.ticks + 1;
  }
  state.set(symKey, { ticks: nextTicks, initialQuality: qualityScore, side: candidateSide });
  return nextTicks;
}

function exitWithProductionSnapshot(input: {
  side: "long" | "short";
  entryPrice: number;
  markPrice: number;
  shockPhase: "DOWN_SHOCK" | "UP_SHOCK";
  directionalShockState: "DOWN" | "UP" | "NONE";
  structuralBreakConfirmed?: boolean;
  structureBreached?: boolean;
}) {
  return evaluateV2ExitPolicy(
    exitArgs({
      side: input.side,
      entryPrice: input.entryPrice,
      markPrice: input.markPrice,
      shockPhase: input.shockPhase,
      directionalShockState: input.directionalShockState,
      structuralBreakConfirmed: input.structuralBreakConfirmed,
      structureBreached: input.structureBreached
    })
  );
}

function baseAddonV2(overrides: Record<string, unknown> = {}): V2StateAuthority {
  return makeV2State({
    longPosition: null,
    shortPosition: null,
    crashState: "",
    pumpState: "",
    accountEquityKrw: 1_960_000,
    ...overrides
  });
}

function shortPosition(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "BTCUSDT",
    side: "short",
    entryPrice: 95000,
    sizeUsd: 120,
    entryStage: 1,
    pnlPct: -0.004,
    breakevenStopConfirmed: false,
    adverseMoveAnchorCandleTs: 1_000_000,
    lastAdverseConfirmationCandleTs: 1_500_000,
    ...overrides
  };
}

function longPosition(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 95000,
    sizeUsd: 120,
    entryStage: 1,
    pnlPct: -0.004,
    breakevenStopConfirmed: false,
    adverseMoveAnchorCandleTs: 1_000_000,
    lastAdverseConfirmationCandleTs: 1_500_000,
    ...overrides
  };
}

export function runPostFillLivenessCaseTests(): boolean {
  let ok = true;
  const entry = 95000;

  // ── A. Shock exit sensitivity ───────────────────────────────────────────

  {
    const r = evaluateV2ExitPolicy(
      exitArgs({
        side: "long",
        shockPhase: "DOWN_SHOCK",
        markPrice: adverseMark("long", entry, 0.0018)
      })
    );
    ok =
      run(
        "SHOCK-A1 instant shock 0.18% no confirm → no FULL_EXIT (long)",
        r.reason !== "SHOCK_FULL_EXIT_AGAINST_POSITION" &&
          (r.action === "REDUCE" || r.action === "WATCH"),
        `action=${r.action} reason=${r.reason}`
      ) && ok;
  }

  {
    const r = evaluateV2ExitPolicy(
      exitArgs({
        side: "short",
        shockPhase: "UP_SHOCK",
        markPrice: adverseMark("short", entry, 0.0018)
      })
    );
    ok =
      run(
        "SHOCK-A2 instant shock 0.18% no confirm → no FULL_EXIT (short)",
        r.reason !== "SHOCK_FULL_EXIT_AGAINST_POSITION" &&
          (r.action === "REDUCE" || r.action === "WATCH"),
        `action=${r.action} reason=${r.reason}`
      ) && ok;
  }

  {
    const movePx = Math.round(entry * 0.003);
    const r = evaluateV2ExitPolicy(
      exitArgs({
        side: "long",
        shockPhase: "DOWN_SHOCK",
        markPrice: entry - movePx
      })
    );
    ok =
      run(
        "SHOCK-A3 strong adverse ≥0.30% → FULL_EXIT (long)",
        r.action === "FULL_EXIT" && r.reason === "SHOCK_FULL_EXIT_AGAINST_POSITION",
        `action=${r.action} reason=${r.reason}`
      ) && ok;
  }

  {
    const r = evaluateV2ExitPolicy(
      exitArgs({
        side: "long",
        shockPhase: "DOWN_SHOCK",
        markPrice: adverseMark("long", entry, 0.002),
        structuralBreakConfirmed: true,
        structureBreached: true
      })
    );
    ok =
      run(
        "SHOCK-A6 structural invalidation → V2_EXIT_INVALIDATION unchanged",
        r.action === "FULL_EXIT" && r.reason === "V2_EXIT_INVALIDATION",
        `action=${r.action} reason=${r.reason}`
      ) && ok;
  }

  {
    const r = evaluateV2ExitPolicy(
      exitArgs({
        side: "short",
        shockPhase: "UP_SHOCK",
        markPrice: adverseMark("short", entry, 0.0018)
      })
    );
    ok =
      run(
        "SHOCK-A7 shock unconfirmed → partial reduce (short)",
        r.action === "REDUCE" && r.reason === "SHOCK_PROTECTIVE_REDUCE" && r.reduceRatio === 0.3,
        `action=${r.action} reason=${r.reason} ratio=${r.reduceRatio}`
      ) && ok;
  }

  // ── Authority audit: threshold / ticks / ROE / resurrection ─────────────

  {
    const r = evaluateV2ExitPolicy(
      exitArgs({
        side: "long",
        shockPhase: "DOWN_SHOCK",
        markPrice: adverseMark("long", entry, 0.0022),
        directionalShockState: "NONE"
      })
    );
    ok =
      run(
        "AUDIT-1 adverse 0.15~0.29% no confirmation → FULL_EXIT forbidden",
        r.reason !== "SHOCK_FULL_EXIT_AGAINST_POSITION",
        `action=${r.action} reason=${r.reason}`
      ) && ok;
  }

  {
    const r299 = evaluateV2ExitPolicy(
      exitArgs({
        side: "long",
        shockPhase: "DOWN_SHOCK",
        markPrice: adverseMark("long", entry, 0.00299),
        directionalShockState: "NONE"
      })
    );
    ok =
      run(
        "AUDIT-6 underlying 0.299% → FULL_EXIT forbidden",
        r299.reason !== "SHOCK_FULL_EXIT_AGAINST_POSITION",
        `action=${r299.action} reason=${r299.reason}`
      ) && ok;
  }

  {
    const movePx = Math.round(entry * 0.003);
    const r300long = evaluateV2ExitPolicy(
      exitArgs({
        side: "long",
        shockPhase: "DOWN_SHOCK",
        markPrice: entry - movePx,
        directionalShockState: "NONE"
      })
    );
    const r300short = evaluateV2ExitPolicy(
      exitArgs({
        side: "short",
        shockPhase: "UP_SHOCK",
        markPrice: entry + movePx,
        directionalShockState: "NONE"
      })
    );
    ok =
      run(
        "AUDIT-7 underlying 0.300% → FULL_EXIT allowed (long/short symmetric)",
        r300long.reason === "SHOCK_FULL_EXIT_AGAINST_POSITION" &&
          r300short.reason === "SHOCK_FULL_EXIT_AGAINST_POSITION",
        `long=${r300long.reason} short=${r300short.reason}`
      ) && ok;
  }

  {
    const gate = evaluatePnlStopMeaningfulMoveGate({
      symbol: "BTCUSDT",
      side: "long",
      entryPrice: entry,
      markPrice: adverseMark("long", entry, 0.0005),
      leverage: 10,
      pnlStopProtectPct: -0.2,
      ledgerStopPx: null,
      atr20: null,
      thresholdActionCandidate: "FULL_EXIT"
    });
    const confirm = isShockFullExitConfirmationMet({
      secondaryInvalidationConfirmation: false,
      underlyingAdverseMovePct: gate.underlyingAdverseMovePct,
      adverseMoveMeasured: true
    });
    ok =
      run(
        "AUDIT-8 ROE -20% but underlying 0.05% → 0.30% shortcut forbidden",
        gate.underlyingAdverseMovePct < SHOCK_FULL_EXIT_STRONG_ADVERSE_MOVE_PCT && !confirm,
        `underlying=${gate.underlyingAdverseMovePct} confirm=${confirm}`
      ) && ok;
  }

  {
    const longGate = evaluatePnlStopMeaningfulMoveGate({
      symbol: "BTCUSDT",
      side: "long",
      entryPrice: entry,
      markPrice: adverseMark("long", entry, 0.003),
      leverage: 10,
      pnlStopProtectPct: -0.03,
      ledgerStopPx: null,
      atr20: null,
      thresholdActionCandidate: "NONE"
    });
    const shortGate = evaluatePnlStopMeaningfulMoveGate({
      symbol: "BTCUSDT",
      side: "short",
      entryPrice: entry,
      markPrice: adverseMark("short", entry, 0.003),
      leverage: 10,
      pnlStopProtectPct: -0.03,
      ledgerStopPx: null,
      atr20: null,
      thresholdActionCandidate: "NONE"
    });
    ok =
      run(
        "AUDIT-9 underlying move symmetric long/short at 0.30%",
        Math.abs(longGate.underlyingAdverseMovePct - 0.003) < 1e-6 &&
          Math.abs(shortGate.underlyingAdverseMovePct - 0.003) < 1e-6 &&
          Math.abs(longGate.underlyingAdverseMovePct - shortGate.underlyingAdverseMovePct) < 1e-6,
        `long=${longGate.underlyingAdverseMovePct} short=${shortGate.underlyingAdverseMovePct}`
      ) && ok;
  }

  {
    const r = evaluateV2ExitPolicy(
      exitArgs({
        side: "long",
        shockPhase: "DOWN_SHOCK",
        markPrice: adverseMark("long", entry, 0.0018),
        directionalShockState: "DOWN",
        priorDefensiveReduce: true
      })
    );
    ok =
      run(
        "AUDIT-10 prior defensive reduce + unconfirmed shock → no repeat FULL_EXIT/REDUCE",
        r.action === "WATCH" && r.reason === "TRANSITION_PROTECTIVE_WATCH",
        `action=${r.action} reason=${r.reason}`
      ) && ok;
  }

  {
    const stopPos = {
      symbol: "BTCUSDT",
      side: "long" as const,
      sizeUsd: 120,
      entryPrice: entry,
      leverage: 10,
      pnlPct: -0.025,
      entryStage: 1,
      ledger_stop_px: adverseMark("long", entry, 0.0025)
    };
    const r = evaluateV2ExitPolicy({
      symbol: "BTCUSDT",
      v2State: makeV2State({
        symbolPositions: [stopPos] as any,
        directionalShockState: "DOWN"
      }),
      judgment: makeJudgment({ shockPhase: "DOWN_SHOCK" }),
      snapshot: {
        boxPos: 0.5,
        boxBreakSide: "none",
        emaGap: 0,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.6,
        qualityScore: 75
      },
      markPrice: adverseMark("long", entry, 0.0025)
    });
    ok =
      run(
        "AUDIT-11 actualStopBreached beats shock confirmation",
        r.reason === "PNL_STOP_PROTECT" && r.action === "FULL_EXIT",
        `action=${r.action} reason=${r.reason}`
      ) && ok;
  }

  {
    const r = evaluateV2ExitPolicy(
      exitArgs({
        side: "long",
        shockPhase: "DOWN_SHOCK",
        markPrice: adverseMark("long", entry, 0.0018),
        directionalShockState: "DOWN",
        structuralBreakConfirmed: true,
        structureBreached: true
      })
    );
    ok =
      run(
        "AUDIT-12 hardInvalidationConfirmed beats shock path",
        r.reason === "V2_EXIT_INVALIDATION",
        `action=${r.action} reason=${r.reason}`
      ) && ok;
  }

  // PNL_STOP hard safety unchanged (leveraged path still preempts shock)
  {
    const stopPos = {
      symbol: "BTCUSDT",
      side: "long" as const,
      sizeUsd: 120,
      entryPrice: entry,
      leverage: 10,
      pnlPct: -0.025,
      entryStage: 1
    };
    const r = evaluateV2ExitPolicy({
      symbol: "BTCUSDT",
      v2State: makeV2State({ symbolPositions: [stopPos] as any }),
      judgment: makeJudgment({ shockPhase: "DOWN_SHOCK", trendPhase: "UP" }),
      snapshot: {
        boxPos: 0.5,
        boxBreakSide: "none",
        emaGap: 0,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.6,
        qualityScore: 75
      },
      markPrice: adverseMark("long", entry, 0.0025)
    });
    ok =
      run(
        "SHOCK-A8 PNL_STOP critical → FULL_EXIT unchanged",
        r.action === "FULL_EXIT" && r.reason === "PNL_STOP_PROTECT",
        `action=${r.action} reason=${r.reason}`
      ) && ok;
  }

  // ── B. Transition add-on reachability ───────────────────────────────────

  const trendToRangePullbackJudgment = {
    regime_final: "RANGE",
    subtype: "NONE",
    shockPhase: "NONE",
    rangePhase: "UPPER",
    trendPhase: "PULLBACK",
    transitionPhase: "TREND_TO_RANGE",
    htf_entry_policy: "BOTH",
    counter_trend_risk: false
  } as any;

  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "short",
      v2State: baseAddonV2({ shortPosition: shortPosition() as any }),
      judgment: trendToRangePullbackJudgment,
      execution: {
        signal: "SHORT_CANDIDATE",
        side: "short",
        invalidationPx: 98000,
        stopPrice: 98000
      } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.85,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 95400,
        atr: 500,
        latestCandleTs: 2_000_000
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    ok =
      run(
        "ADDON-B1 TREND_TO_RANGE pullback thesis valid → adverse evaluator reachable",
        policy.reason !== "TRANSITION_ADDON_FORBIDDEN" &&
          policy.addonMode === "CONFIRMED_ADVERSE_ADDON",
        `reason=${policy.reason} mode=${policy.addonMode} block=${policy.addonBlockedReason ?? "none"}`
      ) && ok;
  }

  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "short",
      v2State: baseAddonV2({ shortPosition: shortPosition() as any }),
      judgment: { ...trendToRangePullbackJudgment, trendPhase: "EXHAUSTION" },
      execution: { signal: "SHORT_CANDIDATE", side: "short" } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.85,
        emaGap: 0.004,
        trendWeaknessScore: 0.8,
        rangeConfidence: 0.7,
        lastPrice: 95400,
        atr: 500
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    ok =
      run(
        "ADDON-B2 TREND_TO_RANGE + EXHAUSTION → forbidden",
        policy.reason === "TRANSITION_ADDON_FORBIDDEN",
        `reason=${policy.reason} evidence=${policy.evidence}`
      ) && ok;
  }

  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "short",
      v2State: baseAddonV2({ shortPosition: shortPosition() as any }),
      judgment: { ...trendToRangePullbackJudgment, trendPhase: "UP" },
      execution: {
        signal: "SHORT_CANDIDATE",
        side: "short",
        metadata: { reversal_confirmed_against_position: true }
      } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.85,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 95400,
        atr: 500,
        latestCandleTs: 2_000_000
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    ok =
      run(
        "ADDON-B3 reversal confirmed → forbidden",
        policy.reason === "TRANSITION_ADDON_FORBIDDEN",
        `reason=${policy.reason} evidence=${policy.evidence}`
      ) && ok;
  }

  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "short",
      v2State: baseAddonV2({
        shortPosition: shortPosition() as any,
        crashState: "CRASH_LOCK",
        pumpState: "NONE"
      }),
      judgment: { ...trendToRangePullbackJudgment, shockPhase: "DOWN_SHOCK" },
      execution: { signal: "SHORT_CANDIDATE", side: "short" } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.85,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 95400,
        atr: 500
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    ok =
      run(
        "ADDON-B4 opposite shock → SHOCK_ADDON_FORBIDDEN",
        policy.reason === "SHOCK_ADDON_FORBIDDEN",
        `reason=${policy.reason}`
      ) && ok;
  }

  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "short",
      v2State: baseAddonV2({ shortPosition: shortPosition() as any }),
      judgment: {
        ...trendToRangePullbackJudgment,
        htf_entry_policy: "TOTAL_BULLISH_HTF",
        counter_trend_risk: false
      },
      execution: {
        signal: "SHORT_CANDIDATE",
        side: "short",
        invalidationPx: 98000,
        stopPrice: 98000
      } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.85,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 95400,
        atr: 500,
        latestCandleTs: 2_000_000
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    ok =
      run(
        "ADDON-B5 HTF polarity mismatch → blocked in adverse evaluator",
        policy.reason !== "TRANSITION_ADDON_FORBIDDEN" &&
          policy.addonBlockedReason === "HTF_POLARITY_MISMATCH",
        `reason=${policy.reason} block=${policy.addonBlockedReason}`
      ) && ok;
  }

  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "short",
      v2State: baseAddonV2({ shortPosition: shortPosition() as any }),
      judgment: trendToRangePullbackJudgment,
      execution: {
        signal: "SHORT_CANDIDATE",
        side: "short",
        invalidationPx: 98000,
        stopPrice: 98000
      } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.85,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 95400,
        atr: 500,
        latestCandleTs: 2_000_000
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    ok =
      run(
        "ADDON-B6 full adverse confirmation → CONFIRMED_ADVERSE_ADDON_ALLOWED",
        policy.allowed === true &&
          policy.reason === "CONFIRMED_ADVERSE_ADDON_ALLOWED" &&
          policy.addonMode === "CONFIRMED_ADVERSE_ADDON",
        `allowed=${policy.allowed} reason=${policy.reason}`
      ) && ok;
  }

  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "short",
      v2State: baseAddonV2({
        shortPosition: {
          ...shortPosition(),
          pnlPct: 0.006,
          breakevenStopRequired: true,
          breakevenStopConfirmed: true,
          breakevenStopPrice: 94800
        } as any
      }),
      judgment: {
        regime_final: "TREND",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "NONE",
        trendPhase: "DOWN",
        transitionPhase: "TREND_TO_RANGE",
        htf_entry_policy: "BOTH",
        counter_trend_risk: false
      } as any,
      execution: { signal: "SHORT_CANDIDATE", side: "short" } as any,
      snapshot: {
        qualityScore: 80,
        reviewing_ticks: 2,
        boxPos: 0.85,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 94800,
        atr: 500
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    ok =
      run(
        "ADDON-B7 profit-funded pyramid TREND_TO_RANGE pullback → reachable",
        policy.addonMode === "PYRAMIDING" && policy.reason !== "TRANSITION_ADDON_FORBIDDEN",
        `mode=${policy.addonMode} allowed=${policy.allowed} reason=${policy.reason}`
      ) && ok;
  }

  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "short",
      v2State: baseAddonV2({
        shortPosition: shortPosition() as any,
        longPosition: longPosition({ pnlPct: 0.01 }) as any
      }),
      judgment: trendToRangePullbackJudgment,
      execution: { signal: "SHORT_CANDIDATE", side: "short" } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.85,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 95400,
        atr: 500
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 240
    });
    ok =
      run(
        "ADDON-B8 opposite position safety unchanged",
        policy.reason === "OPPOSITE_POSITION_EXISTS_FORBIDDEN",
        `reason=${policy.reason}`
      ) && ok;
  }

  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      v2State: baseAddonV2({ longPosition: longPosition() as any }),
      judgment: {
        ...trendToRangePullbackJudgment,
        rangePhase: "LOWER",
        trendPhase: "PULLBACK"
      },
      execution: {
        signal: "LONG_CANDIDATE",
        side: "long",
        invalidationPx: 92000,
        stopPrice: 92000
      } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.15,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 94600,
        atr: 500,
        latestCandleTs: 2_000_000
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    ok =
      run(
        "ADDON-B9 long symmetric TREND_TO_RANGE pullback → adverse reachable",
        policy.reason !== "TRANSITION_ADDON_FORBIDDEN" &&
          policy.addonMode === "CONFIRMED_ADVERSE_ADDON",
        `reason=${policy.reason} mode=${policy.addonMode}`
      ) && ok;
  }

  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "short",
      v2State: baseAddonV2({ shortPosition: shortPosition() as any }),
      judgment: {
        regime_final: "TRANSITION",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "NONE",
        trendPhase: "PULLBACK",
        transitionPhase: "CONFLICT"
      } as any,
      execution: { signal: "SHORT_CANDIDATE", side: "short" } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.85,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 95400,
        atr: 500
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    ok =
      run(
        "ADDON-B10 regime TRANSITION / CONFLICT → still forbidden",
        policy.reason === "TRANSITION_ADDON_FORBIDDEN",
        `reason=${policy.reason} evidence=${policy.evidence}`
      ) && ok;
  }

  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "short",
      v2State: baseAddonV2({ shortPosition: shortPosition() as any }),
      judgment: {
        subtype: "WHIPSAW_SHOCK_RECHECK",
        regime_final: "RANGE",
        shockPhase: "NONE",
        rangePhase: "UPPER",
        trendPhase: "PULLBACK",
        transitionPhase: "TREND_TO_RANGE"
      } as any,
      execution: { signal: "SHORT_CANDIDATE", side: "short" } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.85,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 95400,
        atr: 500
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    ok =
      run(
        "ADDON-B11 WHIPSAW_SHOCK_RECHECK → forbidden",
        policy.reason === "WHIPSAW_SHOCK_RECHECK_ADDON_FORBIDDEN",
        `reason=${policy.reason}`
      ) && ok;
  }

  const adverseAddonBase = {
    symbol: "BTCUSDT",
    side: "short" as const,
    v2State: baseAddonV2({ shortPosition: shortPosition() as any }),
    execution: {
      signal: "SHORT_CANDIDATE",
      side: "short",
      invalidationPx: 98000,
      stopPrice: 98000
    } as any,
    snapshot: {
      qualityScore: 82,
      reviewing_ticks: 3,
      boxPos: 0.85,
      emaGap: 0.004,
      trendWeaknessScore: 0.3,
      rangeConfidence: 0.7,
      lastPrice: 95400,
      atr: 500,
      latestCandleTs: 2_000_000
    },
    accountEquityUsd: 1400,
    currentSymbolNotionalUsd: 120,
    currentGlobalNotionalUsd: 120
  };

  {
    const noTransition = evaluateV2AddOnPolicy({
      ...adverseAddonBase,
      judgment: {
        regime_final: "TREND",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "NONE",
        trendPhase: "PULLBACK",
        transitionPhase: "NONE",
        htf_entry_policy: "BOTH",
        counter_trend_risk: false
      } as any
    });
    const trendToRange = evaluateV2AddOnPolicy({
      ...adverseAddonBase,
      judgment: trendToRangePullbackJudgment
    });
    ok =
      run(
        "AUDIT-13 transition gate pass uses existing sizing authority (numeric match)",
        noTransition.allowed === true &&
          trendToRange.allowed === true &&
          noTransition.requestedAddonNotionalUsdt === trendToRange.requestedAddonNotionalUsdt &&
          noTransition.addonMaxNotionalUsdt === trendToRange.addonMaxNotionalUsdt,
        `none=${noTransition.requestedAddonNotionalUsdt} t2r=${trendToRange.requestedAddonNotionalUsdt}`
      ) && ok;
  }

  {
    const policy = evaluateV2AddOnPolicy({
      ...adverseAddonBase,
      judgment: trendToRangePullbackJudgment,
      execution: { signal: "WAIT_RECHECK", side: "none" } as any
    });
    ok =
      run(
        "AUDIT-14 gate pass + adverse confirmation fail → ADDON forbidden",
        policy.reason !== "TRANSITION_ADDON_FORBIDDEN" &&
          policy.allowed === false &&
          policy.addonBlockedReason === "SAME_SIDE_CONFIRMATION_NOT_MET",
        `reason=${policy.reason} block=${policy.addonBlockedReason}`
      ) && ok;
  }

  {
    const policy = evaluateV2AddOnPolicy({
      ...adverseAddonBase,
      judgment: trendToRangePullbackJudgment
    });
    ok =
      run(
        "AUDIT-15 gate pass alone ≠ ADDON_ALLOWED without downstream gates",
        policy.reason === "CONFIRMED_ADVERSE_ADDON_ALLOWED" &&
          (policy.requestedAddonNotionalUsdt ?? 0) > 0 &&
          (policy.requestedAddonNotionalUsdt ?? 0) <= 1400 * 0.25,
        `req=${policy.requestedAddonNotionalUsdt} cap=${1400 * 0.25}`
      ) && ok;
  }

  // ── Production-shaped reachability (no synthetic reviewing_ticks injection) ─

  {
    const state = new Map<string, { ticks: number; initialQuality: number; side: "long" | "short" }>();
    const ticksCycle1 = productionReviewingTicks({
      symbol: "BTCUSDT",
      signal: "paper_long_candidate",
      qualityScore: 80,
      hasOpenPosition: true,
      currentStage: 1,
      state
    });
    const ticksCycle2 = productionReviewingTicks({
      symbol: "BTCUSDT",
      signal: "paper_long_candidate",
      qualityScore: 81,
      hasOpenPosition: true,
      currentStage: 1,
      state
    });
    const ticksCycle3 = productionReviewingTicks({
      symbol: "BTCUSDT",
      signal: "paper_long_candidate",
      qualityScore: 82,
      hasOpenPosition: true,
      currentStage: 1,
      state
    });
    ok =
      run(
        "PROD-1 post-fill 3 cycles → reviewing_ticks stays 0 (producer proof)",
        ticksCycle1 === 0 && ticksCycle2 === 0 && ticksCycle3 === 0 && !state.has("BTCUSDT"),
        `ticks=[${ticksCycle1},${ticksCycle2},${ticksCycle3}] stateDeleted=${!state.has("BTCUSDT")}`
      ) && ok;
  }

  {
    const prodTicks = productionReviewingTicks({
      symbol: "BTCUSDT",
      signal: "none",
      qualityScore: 75,
      hasOpenPosition: true,
      currentStage: 1
    });
    const movePx = Math.round(entry * 0.0018);
    const r = exitWithProductionSnapshot({
      side: "long",
      entryPrice: entry,
      markPrice: entry - movePx,
      shockPhase: "DOWN_SHOCK",
      directionalShockState: "DOWN"
    });
    ok =
      run(
        "PROD-2 production ticks=0 + adverse 0.18% + shock latch → FULL_EXIT forbidden",
        prodTicks === 0 && r.reason !== "SHOCK_FULL_EXIT_AGAINST_POSITION",
        `prodTicks=${prodTicks} action=${r.action} reason=${r.reason}`
      ) && ok;
  }

  {
    const prodTicks = productionReviewingTicks({
      symbol: "BTCUSDT",
      signal: "none",
      qualityScore: 75,
      hasOpenPosition: true,
      currentStage: 1
    });
    const movePx = Math.round(entry * 0.003);
    const rLong = exitWithProductionSnapshot({
      side: "long",
      entryPrice: entry,
      markPrice: entry - movePx,
      shockPhase: "DOWN_SHOCK",
      directionalShockState: "DOWN"
    });
    const rShort = exitWithProductionSnapshot({
      side: "short",
      entryPrice: entry,
      markPrice: entry + movePx,
      shockPhase: "UP_SHOCK",
      directionalShockState: "UP"
    });
    ok =
      run(
        "PROD-3 production ticks=0 + adverse ≥0.30% → FULL_EXIT allowed (long/short)",
        prodTicks === 0 &&
          rLong.reason === "SHOCK_FULL_EXIT_AGAINST_POSITION" &&
          rShort.reason === "SHOCK_FULL_EXIT_AGAINST_POSITION",
        `long=${rLong.reason} short=${rShort.reason}`
      ) && ok;
  }

  {
    const prodTicks = productionReviewingTicks({
      symbol: "BTCUSDT",
      signal: "none",
      qualityScore: 75,
      hasOpenPosition: true,
      currentStage: 1
    });
    const movePx = Math.round(entry * 0.0018);
    const r = exitWithProductionSnapshot({
      side: "long",
      entryPrice: entry,
      markPrice: entry - movePx,
      shockPhase: "DOWN_SHOCK",
      directionalShockState: "DOWN",
      structuralBreakConfirmed: true,
      structureBreached: true
    });
    ok =
      run(
        "PROD-4 production ticks=0 + structural confirm → FULL_EXIT allowed",
        r.reason === "V2_EXIT_INVALIDATION" && r.action === "FULL_EXIT",
        `action=${r.action} reason=${r.reason}`
      ) && ok;
  }

  {
    const confirmAt018 = isShockFullExitConfirmationMet({
      secondaryInvalidationConfirmation: false,
      underlyingAdverseMovePct: 0.0018,
      adverseMoveMeasured: true
    });
    const confirmAt030 = isShockFullExitConfirmationMet({
      secondaryInvalidationConfirmation: false,
      underlyingAdverseMovePct: 0.003,
      adverseMoveMeasured: true
    });
    const confirmRoeOnly = isShockFullExitConfirmationMet({
      secondaryInvalidationConfirmation: false,
      underlyingAdverseMovePct: 0.02,
      adverseMoveMeasured: false
    });
    ok =
      run(
        "PROD-5 0.30% needs measured=true; ROE fallback blocked",
        !confirmAt018 && confirmAt030 && !confirmRoeOnly,
        `018=${confirmAt018} 030=${confirmAt030} roeFallback=${confirmRoeOnly}`
      ) && ok;
  }

  {
    const rNoMark = evaluateV2ExitPolicy(
      exitArgs({
        side: "long",
        shockPhase: "DOWN_SHOCK",
        markPrice: 0,
        directionalShockState: "DOWN"
      })
    );
    const rNoEntry = evaluateV2ExitPolicy({
      symbol: "BTCUSDT",
      v2State: makeV2State({
        symbolPositions: [{
          symbol: "BTCUSDT",
          side: "long",
          sizeUsd: 120,
          entryPrice: 0,
          leverage: 10,
          pnlPct: -0.2,
          entryStage: 1
        }] as any,
        directionalShockState: "DOWN"
      }),
      judgment: makeJudgment({ shockPhase: "DOWN_SHOCK" }),
      snapshot: {
        boxPos: 0.5,
        boxBreakSide: "none",
        emaGap: 0,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.6,
        qualityScore: 75
      },
      markPrice: entry
    });
    ok =
      run(
        "PROD-6 invalid mark/entry → 0.30% shortcut blocked",
        rNoMark.reason !== "SHOCK_FULL_EXIT_AGAINST_POSITION" &&
          rNoEntry.reason !== "SHOCK_FULL_EXIT_AGAINST_POSITION",
        `noMark=${rNoMark.reason} noEntry=${rNoEntry.reason}`
      ) && ok;
  }

  return ok;
}

if (require.main === module) {
  const ok = runPostFillLivenessCaseTests();
  console.log(`\n[POST-FILL-LIVENESS] Overall: ${ok ? "ALL PASS" : "SOME FAIL"}`);
  process.exit(ok ? 0 : 1);
}
