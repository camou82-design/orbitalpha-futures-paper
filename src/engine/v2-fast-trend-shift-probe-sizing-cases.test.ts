/**
 * FAST_TREND_SHIFT / early probe RANGE sizing authority regressions.
 * Probe baseSizeIntent must survive calculateRiskSizing() over fixed RANGE stage margins.
 */

import assert from "node:assert/strict";
import { calculateRiskSizing } from "../engine-v2/risk-sizing/policy";
import type { EngineV2Input, ExecutorOutput, MarketJudgmentOutput } from "../engine-v2/types";

const RANGE_STAGE0_MARGIN_KRW = 140_000;
const PROBE_SIZE_INTENT = 0.32;
const EXPECTED_PROBE_MARGIN_KRW = RANGE_STAGE0_MARGIN_KRW * PROBE_SIZE_INTENT;

function pass(label: string, detail?: Record<string, unknown>): void {
  const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
  console.log(`[FAST-TREND-PROBE-SIZING][${label}] PASS${extra}`);
}

function makeInput(overrides: Partial<EngineV2Input> = {}): EngineV2Input {
  return {
    symbol: "BTCUSDT",
    candles: [],
    snapshot: {
      symbol: "BTCUSDT",
      lastPrice: 70000,
      latestCandleClose: 70000,
      boxHigh: 70100,
      boxLow: 69900,
      boxPos: 0.88,
      rangeConfidence: 0.78,
      boxCohesion01: 0.92,
      rangeOscillationScore: 0.65,
      breakoutFailureRate: 0.15,
      trendWeaknessScore: 0.22,
      qualityScore: 72,
      reviewing_ticks: 0,
      regimeExitRisk: 0,
      boxBreakSide: "none",
      signal: "paper_long_candidate",
      data_ready: true,
      dump_protection_hit: false,
      volatility_guard_hit: false,
      entryCandidate: true,
      ema20: 69950,
      emaGap: 0.006,
      volatilityProxy: 250,
      atr: 250,
      volumeExpansion: 1.6,
      ema20Slope: 0.0002
    },
    state: {
      currentPositions: [],
      lossStreaks: {},
      globalRiskScore: 0,
      longAllow: true,
      shortAllow: false,
      executionReadiness: true,
      paperExecutionReady: true,
      signedExecutionReady: true,
      serverTradeEnabled: true,
      closeOnlyMode: false,
      killSwitch: false,
      reconcileSafeMode: false,
      riskMode: "NORMAL",
      dailyLossGuardTriggered: false,
      directionalShockState: "UP",
      accountEquityKrw: 10_000_000,
      maxUsableMarginKrw: 900_000,
      exposureNotionalCapKrw: 5_000_000,
      symbolExposureNotionalCapKrw: 3_000_000,
      okxLiveEnabled: false,
      freshTickBarrierActive: false,
      freshTickCompletedCycles: 5,
      freshTickRequiredCycles: 5
    },
    config: {
      baseSizeUsd: 100,
      okxLiveStaticNotionalCapEnabled: true,
      okxLiveUsableBalanceRatio: 0.95
    },
    now: Date.now(),
    v1Result: {
      regime: "RANGE",
      decision: "SKIP",
      side: "none",
      isBlocked: false
    },
    ...overrides
  } as EngineV2Input;
}

function makeJudgment(overrides: Partial<MarketJudgmentOutput> = {}): MarketJudgmentOutput {
  return {
    regime: "RANGE",
    subtype: "FAST_TREND_SHIFT",
    subtypeReason: "FAST_SHIFT_LONG: higher_low|higher_high|box_mid_ok|ema_up|vol_up",
    shockPhase: "UP_SHOCK",
    trendPhase: "UP",
    rangePhase: "FLAT",
    counter_trend_risk: false,
    diagnostics: {
      fastTrendShift: {
        active: true,
        direction: "long",
        candidate: true,
        allowed: true,
        side: "long",
        reason: "higher_low|higher_high|box_mid_ok|ema_up|vol_up",
        block_reason: "",
        baseSizeIntent: PROBE_SIZE_INTENT,
        stop_price: 69385,
        stop_basis: "atr_1.5_probe_stop"
      }
    },
    ...overrides
  } as MarketJudgmentOutput;
}

function makeFastTrendProbeExecutor(stopPrice = 69385): ExecutorOutput {
  return {
    signal: "LONG_CANDIDATE",
    side: "long",
    reason: "FAST_SHIFT_LONG: higher_low|higher_high|box_mid_ok|ema_up|vol_up",
    baseSizeIntent: PROBE_SIZE_INTENT,
    recheckSuggested: true,
    isAddOnEligible: false,
    stopPrice,
    invalidationPx: stopPrice,
    metadata: {
      early_probe: true,
      fast_trend_shift: true,
      stop_basis: "conservative_probe_basis"
    }
  };
}

function makeNormalRangeExecutor(): ExecutorOutput {
  return {
    signal: "LONG_CANDIDATE",
    side: "long",
    reason: "RANGE_UPPER_LONG",
    baseSizeIntent: 1,
    recheckSuggested: false,
    isAddOnEligible: false,
    stopPrice: 69850,
    invalidationPx: 69850,
    metadata: {}
  };
}

// CASE A — BTC production-like FAST_TREND_SHIFT probe preserves 32% of RANGE stage-0 margin
{
  const input = makeInput();
  const judgment = makeJudgment();
  const executor = makeFastTrendProbeExecutor();
  const risk = calculateRiskSizing(
    judgment,
    { level: "HIGH", score: 78 },
    executor,
    input
  );

  assert.equal(risk.isBlocked, false);
  assert.equal(risk.diagnostics?.range_probe_sizing_applied, true);
  assert.equal(risk.stageMarginKrw, EXPECTED_PROBE_MARGIN_KRW);
  assert.ok(
    risk.stageMarginKrw < RANGE_STAGE0_MARGIN_KRW * 0.5,
    "probe margin must be materially below normal RANGE stage-0 margin"
  );
  assert.ok(executor.stopPrice != null && executor.stopPrice > 0, "structural stop authority preserved on executor");

  pass("CASE_A_BTC_FAST_TREND_SHIFT_PROBE_MARGIN", {
    regime: judgment.regime,
    subtype: judgment.subtype,
    baseSizeIntent: executor.baseSizeIntent,
    stage: 0,
    range_stage0_margin_krw: RANGE_STAGE0_MARGIN_KRW,
    stageMarginKrw: risk.stageMarginKrw,
    expected_probe_margin_krw: EXPECTED_PROBE_MARGIN_KRW,
    stopPrice: executor.stopPrice
  });
}

// CASE B — normal RANGE stage-0 sizing unchanged
{
  const input = makeInput();
  const judgment = makeJudgment({
    subtype: "RANGE_UPPER_REACTION",
    subtypeReason: "RANGE_UPPER_LONG",
    diagnostics: undefined
  });
  const executor = makeNormalRangeExecutor();
  const risk = calculateRiskSizing(
    judgment,
    { level: "HIGH", score: 80 },
    executor,
    input
  );

  assert.equal(risk.isBlocked, false);
  assert.equal(risk.diagnostics?.range_probe_sizing_applied, false);
  assert.equal(risk.stageMarginKrw, RANGE_STAGE0_MARGIN_KRW);

  pass("CASE_B_NORMAL_RANGE_STAGE0_UNCHANGED", {
    subtype: judgment.subtype,
    stageMarginKrw: risk.stageMarginKrw
  });
}

// CASE C — EARLY_LONG_PROBE uses probe sizing, not full RANGE stage margin
{
  const input = makeInput();
  const judgment = makeJudgment({
    subtype: "EARLY_LONG_PROBE",
    subtypeReason: "EARLY_PROBE: higher_low|higher_high"
  });
  const executor = makeFastTrendProbeExecutor(69350);
  const risk = calculateRiskSizing(
    judgment,
    { level: "HIGH", score: 75 },
    executor,
    input
  );

  assert.equal(risk.isBlocked, false);
  assert.equal(risk.diagnostics?.range_probe_sizing_applied, true);
  assert.equal(risk.stageMarginKrw, EXPECTED_PROBE_MARGIN_KRW);
  assert.ok(risk.stageMarginKrw < RANGE_STAGE0_MARGIN_KRW);

  pass("CASE_C_EARLY_LONG_PROBE_SIZING", {
    stageMarginKrw: risk.stageMarginKrw,
    stopPrice: executor.stopPrice
  });
}

// CASE D — FAST_TREND_SHIFT without structural stop remains fail-closed
{
  const input = makeInput();
  const judgment = makeJudgment();
  const executor = { ...makeFastTrendProbeExecutor(), stopPrice: undefined as unknown as number };
  const risk = calculateRiskSizing(
    judgment,
    { level: "HIGH", score: 78 },
    executor,
    input
  );

  assert.equal(risk.isBlocked, true);
  assert.equal(risk.blockReason, "ENTRY_BLOCKED_NO_STRUCTURAL_STOP");

  pass("CASE_D_PROBE_STOP_PROTECTION_FAIL_CLOSED", {
    blockReason: risk.blockReason
  });
}

// CASE E — stage>0 addon path keeps normal RANGE stage ladder (no probe override)
{
  const input = makeInput({
    state: {
      ...makeInput().state,
      currentPositions: [
        {
          symbol: "BTCUSDT",
          side: "long",
          entryStage: 1,
          size: 1,
          entryPrice: 70000
        } as any
      ]
    } as any
  });
  const judgment = makeJudgment();
  const executor = makeFastTrendProbeExecutor();
  const risk = calculateRiskSizing(
    judgment,
    { level: "HIGH", score: 78 },
    executor,
    input
  );

  assert.equal(risk.diagnostics?.range_probe_sizing_applied, false);
  assert.equal(risk.stageMarginKrw, 80_000);

  pass("CASE_E_STAGE1_NO_PROBE_OVERRIDE", {
    stageMarginKrw: risk.stageMarginKrw
  });
}

console.log("v2-fast-trend-shift-probe-sizing-cases: ALL PASS");
