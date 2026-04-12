import type {
  EngineConfig,
  MarketSymbol,
  PaperDecisionRejectReason,
  PaperEdgeState,
  PaperExecutionState,
  PaperFinalDecision,
  PaperRegimeState,
  PaperRiskState,
  PaperSignalState,
  PaperStrategyExecutor,
  PaperSymbolDecisionRecord
} from "../models/types";
import type { MarketRegime } from "../strategy/market-regime-detector";
import { stopLossPctForRegime } from "../strategy/regime-exit";
import type { RiskControlDecision } from "./risk-control-layer";
import type { FuturesMarketMode } from "../strategy/live-market-mode";
import { runFuturesAdaptiveEntry, type FuturesAdaptiveEntryResult } from "../strategy/live-entry-pipeline";
import { rangeExecutorEvaluateEntry } from "../strategy/executors/range-executor";
import { highwayExecutorEvaluateEntry } from "./highway-entry-executor";
import type { AnyEntryDecision } from "../strategy/executors/types";
import { aiApproveEntry, aiInputFromDecision } from "../ai/entry-approval";
import { detectHighwayTrend } from "../engine/highway-trend-detector";
import { HighwayTrendState } from "../models/types";
import { evaluateAiHighwayQuality } from "../engine/ai-highway-filter";
import type { PaperSignal } from "../strategy/entry-signal";
import type { PaperCandidateStrength } from "../strategy/entry-signal";
import { PIPELINE_VERSION } from "./decision-funnel";

/** RANGE·Stage0·RISK_FAIL_REENTRY: 부분익절/TP 계열 청산 후 동일 심볼 재진입 대기만 완화(손절·증액 단계 제외). */
const RANGE_STAGE0_REENTRY_RELAX_MULT = 0.35;
const RANGE_STAGE0_REENTRY_RELAX_MIN_MS = 25_000;

function isRangeStage0ReentryRelaxCloseReason(cr: unknown): boolean {
  if (cr == null || cr === "stop_loss") return false;
  return (
    cr === "partial_exit_1" ||
    cr === "partial_exit_2" ||
    cr === "take_profit" ||
    cr === "trailing_stop" ||
    cr === "time_based_exit" ||
    cr === "regime_exit"
  );
}

/** @deprecated use PaperDecisionRejectReason from `../models/types` */
export type RejectReasonCode = PaperDecisionRejectReason;

export type PaperSymbolDecision = PaperSymbolDecisionRecord;

export type SymbolSnapshotLike = Readonly<{
  symbol: MarketSymbol;
  lastPrice: number;
  latestCandleClose: number;
  signal: PaperSignal;
  gateExpectedMove: number | null;
  gateRequiredMove: number | null;
  qualityScore: number;
  candidateStrength: PaperCandidateStrength | null;
  boxPos: number | null;
  boxRel: number | null;
  ema20: number | null;
  ema60: number | null;
  emaGap: number | null;
  volumeRatioProxy: number;
  boxHigh: number | null;
  boxLow: number | null;
  atr: number | null;
  signalMissingReason?: string;
  /** 하이웨이: 횡보 확신도 */
  rangeConfidence?: number;
  /** 하이웨이: 박스 응집도 */
  boxCohesion01?: number;
  /** 하이웨이: 돌파 실패율 */
  breakoutFailureRate?: number;
  /** 하이웨이: 왕복 빈도 */
  rangeOscillationScore?: number;
  /** 하이웨이: 추세 약성 */
  trendWeaknessScore?: number;
  /** 하이웨이: 횡보 판단 근거 라벨 */
  rangeReasonLabel?: string;
  /** 하이웨이: 박스 왕복 누적 횟수 */
  rangeCycleCount?: number;
  /** 하이웨이: 박스 내 분할 진입 단계 */
  rangeLadderLevel?: number;
  /** 하이웨이: RANGE 해제 위험도 */
  regimeExitRisk?: number;
  /** 하이웨이: 박스 붕괴 방향 */
  boxBreakSide?: "upper" | "lower" | "none";
  /** 하이웨이: 현재 레짐 상태 */
  regimeStateDiag?: PaperRegimeState;
  /** Raw candles fetched from Bybit */
  candles?: import("../models/types").Candle[];
}>;

function signalToState(signal: PaperSignal): PaperSignalState {
  if (signal === "paper_long_candidate") return "LONG_CANDIDATE";
  if (signal === "paper_short_candidate") return "SHORT_CANDIDATE";
  return "NONE";
}

function regimeToState(regime: MarketRegime, regimeUnknown: boolean): PaperRegimeState {
  if (regimeUnknown) return "UNKNOWN";
  return regime;
}

function rrFromRegime(regime: MarketRegime): number {
  if (regime === "RANGE") return 0.0038 / 0.0026;
  if (regime === "TREND") return 0.0105 / 0.0105;
  return 1;
}

/** Stage 1 소액 탐색: RANGE·모호 맥락에서만 허용(쿨다운·데이터 결손 등은 제외). */
const STAGE1_SOFT_EXPLORE_BLOCKS = new Set([
  "range_not_in_interest_zone",
  "range_center_forbidden",
  "range_low_quality_for_lead",
  "trend_not_in_pullback",
  "trend_direction_weak",
  "trend_low_quality",
  "trend_volume_too_thin"
]);

/** RANGE 박스 폭·상단 에지 — Stage 1만 소프트 허용 + 추가 사이즈 축소. */
const STAGE1_RANGE_EDGE_SOFT_TAGS: Readonly<Record<string, string>> = {
  range_box_too_narrow: "STAGE1_EXPLORE_RANGE_BOX_NARROW",
  range_not_upper_edge: "STAGE1_EXPLORE_RANGE_EDGE_RELAXED",
  range_not_lower_edge: "STAGE1_EXPLORE_RANGE_EDGE_RELAXED"
};

/** 기존 Stage1 탐색 배수 위에 한 번 더 곱함(아주 소액). */
const STAGE1_RANGE_POSITION_SOFT_MULT = 0.42;

function mapExecutorBlockToReject(blocked: string | undefined): PaperDecisionRejectReason {
  switch (blocked) {
    case "fee_slippage_insufficient":
      return "EDGE_FAIL_FEE";
    case "range_center_forbidden":
      return "EDGE_FAIL_EXPECTANCY";
    case "range_cooldown_active":
    case "trend_cooldown_active":
      return "RISK_COOLDOWN";
    case "mode_suspended":
      return "RISK_COOLDOWN";
    case "no_trade_regime":
      return "REGIME_NO_TRADE";
    case "trend_need_breakout_or_pullback":
    case "trend_direction_weak":
      return "EDGE_FAIL_EXPECTANCY";
    case "trend_volume_too_thin":
      return "EDGE_FAIL_LOW_VOL";
    default:
      return "LEGACY_BLOCKED";
  }
}

export type EvaluatePaperSymbolEntryInput = Readonly<{
  config: EngineConfig;
  snapshot: SymbolSnapshotLike | null;
  dataReady: boolean;
  regime: MarketRegime;
  /** BTC 레짐 `detail` (NO_TRADE 사유·marginal_history 등). */
  regimeDetail?: Readonly<Record<string, unknown>>;
  regimeUnknown: boolean;
  isAmbiguous: boolean;
  risk: RiskControlDecision | null;
  adaptiveMode: FuturesMarketMode;
  adaptiveDetail: Record<string, unknown>;
  now: number;
  rangeCooldownUntilByKey: ReadonlyMap<string, number>;
  trendCooldownUntilBySymbol: ReadonlyMap<string, number>;
  lastCloseMetaBySymbol: ReadonlyMap<
    string,
    {
      closedAt: number;
      side: "long" | "short";
      closeReason?: import("../models/types").PaperClosedPositionRecord["closeReason"];
      entryStageAtClose?: number;
    }
  > | null;
  reentryCooldownMs: number;
  sameDirCooldownMult: number;
  hasOpenPosition: boolean;
  currentStage: number;
  maxPositionsReached: boolean;
  reviewingTicks?: number;
  autoEntryTriggered?: boolean;
  /** RANGE 익절 후 재진입 — RANGE 쿨다운 우회(엔진 판단). */
  rangeReopenCooldownBypass?: boolean;
}>;

export type EvaluatePaperSymbolEntryResult = Readonly<{
  decision: PaperSymbolDecision;
  intentSide: "long" | "short" | null;
  executorDecision: AnyEntryDecision | null;
  adaptiveOk: boolean;
  adaptiveDirection: "long" | "short" | null;
  adaptiveDetail: Record<string, unknown> | null;
  adaptiveResult: Extract<FuturesAdaptiveEntryResult, { ok: true }> | null;
  /** `runFuturesAdaptiveEntry` 실패 시 상세(정책/사이즈 단계). */
  adaptiveFailure?: Extract<FuturesAdaptiveEntryResult, { ok: false }>;
  /** True once the pipeline reaches adaptive (after AI approval). */
  aiGatePassed: boolean;
}>;

const DEFAULT_PAPER_SIZE_USD = 100;

function pack(
  input: EvaluatePaperSymbolEntryInput,
  sym: MarketSymbol,
  em: number | null,
  fields: {
    signal_state: PaperSignalState;
    regime_state: PaperRegimeState;
    edge_state: PaperEdgeState;
    risk_state: PaperRiskState;
    execution_state: PaperExecutionState;
    final_decision: PaperFinalDecision;
    reject_reason: PaperDecisionRejectReason | null;
    expected_move_pct: number | null;
    fee_estimate_pct: number | null;
    slippage_buffer_pct: number;
    safety_margin_pct: number;
    rr: number | null;
    atr_pct: number | null;
    strategy_executor: PaperStrategyExecutor;
    engine_mode: EngineConfig["paperEngineMode"];
    ai_decision: string | null;
    adaptive_decision: string | null;
    guidance: string | null;
    next_action: string | null;
    invalidate_condition: string | null;
    risk_note: string | null;
    watch_zone: string | null;
    entry_progress: number | null;
    target_stage: number | null;
    supplemental_reasons?: string[];
    is_ambiguous?: boolean;
    stage1_loosened_entry?: boolean;
    ai_floor_relaxed?: boolean;
    auto_entry_triggered?: boolean;
    reviewing_ticks?: number;
    stage1_result_code?: import("../models/types").PaperStage1ResultCode;
    final_fail_reason?: string;
    required_move_pct?: number | null;
    shortfall_pct?: number | null;
    signal_missing_reason?: string;
    box_position_diag?: number | null;
    ema_gap_diag?: number | null;
    volatility_proxy_diag?: number | null;
    stage1_leniency_applied?: boolean;
    cost_warning_applied?: boolean;
    stage1_size_reduced_due_to_cost?: boolean;
    post_entry_cost_guard?: boolean;
    fixed_total_cost_usd?: number | null;
    expected_move_usd?: number | null;
    required_cost_usd?: number | null;
    shortfall_usd?: number;
    executor_block_reason_original?: string | null;
    stage1_soft_exec_override?: boolean;
    stage1_size_multiplier_final?: number | null;
    order_build_ok?: boolean;
    order_build_fail_reason?: string | null;
    order_build_fail_stage?: "entry_policy" | "adaptive_sizing" | null;
    qty?: number | null;
    price?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
    riskReward?: number | null;
    tick_size?: number | null;
    qty_step?: number | null;
    min_qty?: number | null;
    min_notional?: number | null;
    sizeUsd?: number | null;
    long_only_restriction?: boolean;
    original_signal_state?: string;
    final_signal_state?: string;
    execution_disabled_reason?: string | null;
    reentry_cooldown_applied?: boolean;
    reentry_cooldown_original_ms?: number | null;
    reentry_cooldown_effective_ms?: number | null;
    reentry_cooldown_reason?: string | null;
    currentStage?: number;
    regime?: "TREND" | "RANGE" | "NO_TRADE";
    stage1_signal_relaxed?: boolean;
    signal_relax_reason?: string | null;
    regime_original_state?: PaperRegimeState;
    regime_fallback_applied?: boolean;
    regime_fallback_reason?: string | null;
    range_confidence_diag?: number | null;
    box_cohesion_diag?: number | null;
    breakout_failure_rate_diag?: number | null;
    range_oscillation_diag?: number | null;
    trend_weakness_diag?: number | null;
    range_reason_label?: string | null;
    range_cycle_count?: number | null;
    range_ladder_level?: number | null;
    regime_exit_risk?: number | null;
    box_break_side?: "upper" | "lower" | "none";
    regime_state_diag?: PaperRegimeState;
    entry_intent_type?: "probe" | "standard" | "scale" | "trend";
    entry_confirmation_state?: "unconfirmed" | "reacting" | "confirmed";
    scaling_permission?: boolean;
    probe_only_mode?: boolean;
  }
): PaperSymbolDecision {
  return {
    ts: input.now,
    timestamp: new Date(input.now).toISOString(),
    symbol: String(sym),
    pipeline_version: PIPELINE_VERSION,
    volatility_move: typeof em === "number" && Number.isFinite(em) ? em : null,
    ...fields,
    guidance: fields.guidance ?? undefined,
    next_action: fields.next_action ?? undefined,
    invalidate_condition: fields.invalidate_condition ?? undefined,
    risk_note: fields.risk_note ?? undefined,
    watch_zone: fields.watch_zone ?? undefined,
    entry_progress: fields.entry_progress ?? undefined,
    target_stage: fields.target_stage ?? undefined,
    supplemental_reasons: fields.supplemental_reasons,
    is_ambiguous: fields.is_ambiguous,
    stage1_loosened_entry: fields.stage1_loosened_entry,
    ai_floor_relaxed: fields.ai_floor_relaxed,
    auto_entry_triggered: fields.auto_entry_triggered,
    reviewing_ticks: fields.reviewing_ticks,
    stage1_result_code: fields.stage1_result_code,
    final_fail_reason: fields.final_fail_reason,
    required_move_pct: fields.required_move_pct,
    shortfall_pct: fields.shortfall_pct,
    signal_missing_reason: fields.signal_missing_reason,
    box_position_diag: fields.box_position_diag,
    ema_gap_diag: fields.ema_gap_diag,
    volatility_proxy_diag: fields.volatility_proxy_diag,
    stage1_leniency_applied: fields.stage1_leniency_applied,
    cost_warning_applied: fields.cost_warning_applied,
    stage1_size_reduced_due_to_cost: fields.stage1_size_reduced_due_to_cost,
    post_entry_cost_guard: fields.post_entry_cost_guard,
    fixed_total_cost_usd: fields.fixed_total_cost_usd,
    expected_move_usd: fields.expected_move_usd,
    required_cost_usd: fields.required_cost_usd,
    shortfall_usd: fields.shortfall_usd ?? 0,
    executor_block_reason_original: fields.executor_block_reason_original,
    stage1_soft_exec_override: fields.stage1_soft_exec_override,
    stage1_size_multiplier_final: fields.stage1_size_multiplier_final,
    order_build_ok: fields.order_build_ok,
    order_build_fail_reason: fields.order_build_fail_reason,
    order_build_fail_stage: fields.order_build_fail_stage,
    qty: fields.qty,
    price: fields.price,
    stopLoss: fields.stopLoss,
    takeProfit: fields.takeProfit,
    riskReward: fields.riskReward,
    atr_pct: fields.atr_pct,
    tick_size: fields.tick_size,
    qty_step: fields.qty_step,
    min_qty: fields.min_qty,
    min_notional: fields.min_notional,
    sizeUsd: fields.sizeUsd,
    long_only_restriction: fields.long_only_restriction,
    original_signal_state: fields.original_signal_state,
    final_signal_state: fields.final_signal_state,
    execution_disabled_reason: fields.execution_disabled_reason,
    reentry_cooldown_applied: fields.reentry_cooldown_applied ?? false,
    reentry_cooldown_original_ms: fields.reentry_cooldown_original_ms ?? null,
    reentry_cooldown_effective_ms: fields.reentry_cooldown_effective_ms ?? null,
    reentry_cooldown_reason: fields.reentry_cooldown_reason ?? null,
    currentStage: fields.currentStage,
    regime: fields.regime,
    stage1_signal_relaxed: fields.stage1_signal_relaxed,
    signal_relax_reason: fields.signal_relax_reason,
    regime_original_state: fields.regime_original_state,
    regime_fallback_applied: fields.regime_fallback_applied,
    regime_fallback_reason: fields.regime_fallback_reason,
    range_confidence_diag: fields.range_confidence_diag,
    box_cohesion_diag: fields.box_cohesion_diag,
    breakout_failure_rate_diag: fields.breakout_failure_rate_diag,
    range_oscillation_diag: fields.range_oscillation_diag,
    trend_weakness_diag: fields.trend_weakness_diag,
    range_reason_label: fields.range_reason_label,
    range_cycle_count: fields.range_cycle_count,
    range_ladder_level: fields.range_ladder_level,
    regime_exit_risk: fields.regime_exit_risk,
    box_break_side: fields.box_break_side,
    regime_state_diag: fields.regime_state_diag,
    entry_intent_type: fields.entry_intent_type,
    entry_confirmation_state: fields.entry_confirmation_state,
    scaling_permission: fields.scaling_permission,
    probe_only_mode: fields.probe_only_mode
  };
}

/**
 * Pipeline: DATA → SIGNAL → REGIME → EDGE → RISK → EXECUTION → AI → ADAPTIVE.
 */
export function evaluatePaperSymbolEntry(input: EvaluatePaperSymbolEntryInput): EvaluatePaperSymbolEntryResult {
  const slipFrac = (Math.max(0, input.config.paperSlippageBps) / 10_000) * 2;
  const safety = 0.0001;
  const slippage_buffer_pct = slipFrac * 100;
  const safety_margin_pct = safety * 100;
  const emMode = input.config.paperEngineMode;

  const supplemental_reasons: string[] = [];

  const sym = input.snapshot?.symbol ?? ("UNKNOWN" as MarketSymbol);
  let em: number | null = null;

  let signal_state: PaperSignalState = "NONE";
  let regime_state = regimeToState(input.regime, input.regimeUnknown);
  const originalRegimeState = regime_state;
  let regimeFallbackApplied = false;
  let regimeFallbackReason: string | null = null;
  let stage1ResultCodeOverride: import("../models/types").PaperStage1ResultCode | null = null;
  let edge_state: PaperEdgeState = "PASS";
  let risk_state: PaperRiskState = "PASS";
  let execution_state: PaperExecutionState = "PAPER_READY";
  let final_decision: PaperFinalDecision = "SKIP";
  let reject_reason: PaperDecisionRejectReason | null = null;
  let expected_move_pct: number | null = null;
  let fee_estimate_pct: number | null = null;
  let rr: number | null = null;
  let atr_pct: number | null = null;
  let strategy_executor: PaperStrategyExecutor = "IDLE";

  let intentSide: "long" | "short" | null = null;
  let executorDecision: AnyEntryDecision | null = null;
  let adaptiveDetailOut: Record<string, unknown> | null = null;
  let guidanceOut: string | null = null;

  const sn = input.snapshot;
  const rm = sn?.gateRequiredMove;
  const emFromSn = sn?.gateExpectedMove ?? null;
  em = emFromSn; // Use the let-declared em

  let leniency = 1.0;
  if (input.currentStage === 0) {
    if (input.regime === "TREND") leniency *= 0.65;
    else if (input.regime === "RANGE") leniency *= 0.75;
    /** ETH만 추가 완화(0.60). BTC는 후보 생성 경로에서만 완화, 비용 게이트는 레짐 배수만 적용. */
    if (sym === "ETHUSDT") leniency *= 0.6;
  }

  const stage1_leniency_applied = input.currentStage === 0 && leniency < 1.0;

  const refNotionalUsd = DEFAULT_PAPER_SIZE_USD;
  const fixedUsd = input.config.paperFixedTotalCostUsd;
  const useFixedCost = fixedUsd !== null && fixedUsd > 0;

  let totalCost: number | null;
  let effectiveTotalCost: number | null;
  let expectedMoveUsd: number | null;
  let requiredCostUsd: number | null;
  let shortfallUsd: number;

  if (useFixedCost) {
    totalCost = fixedUsd / refNotionalUsd;
    requiredCostUsd = fixedUsd * leniency;
    effectiveTotalCost = requiredCostUsd / refNotionalUsd;
    expectedMoveUsd =
      em !== null && typeof em === "number" && Number.isFinite(em) ? em * refNotionalUsd : null;
    shortfallUsd =
      expectedMoveUsd !== null && requiredCostUsd !== null
        ? Math.max(0, requiredCostUsd - expectedMoveUsd)
        : requiredCostUsd !== null
          ? requiredCostUsd
          : 0;
  } else {
    totalCost = (typeof rm === "number" && Number.isFinite(rm)) ? rm + slipFrac + safety : null;
    effectiveTotalCost = totalCost !== null ? totalCost * leniency : null;
    requiredCostUsd = effectiveTotalCost !== null ? effectiveTotalCost * refNotionalUsd : null;
    expectedMoveUsd =
      em !== null && typeof em === "number" && Number.isFinite(em) ? em * refNotionalUsd : null;
    shortfallUsd =
      effectiveTotalCost !== null && em !== null && effectiveTotalCost > em
        ? (effectiveTotalCost - em) * refNotionalUsd
        : 0;
  }

  const required_move_pct = effectiveTotalCost !== null ? effectiveTotalCost * 100 : null;
  const shortfall_pct = (effectiveTotalCost !== null && em !== null && effectiveTotalCost > em) ? (effectiveTotalCost - em) * 100 : 0;

  let executorBlockReasonOriginal: string | null = null;
  let stage1SoftExecOverrideFlag = false;
  let stage1RangeEdgeSoftApplied = false;

  let reentry_cooldown_applied = false;
  let reentry_cooldown_original_ms: number | null = null;
  let reentry_cooldown_effective_ms: number | null = null;
  let reentry_cooldown_reason: string | null = null;

  const ret = (
    extra: Partial<{
      signal_state: PaperSignalState;
      regime_state: PaperRegimeState;
      edge_state: PaperEdgeState;
      risk_state: PaperRiskState;
      execution_state: PaperExecutionState;
      final_decision: PaperFinalDecision;
      reject_reason: PaperDecisionRejectReason | null;
      expected_move_pct: number | null;
      fee_estimate_pct: number | null;
      rr: number | null;
      atr_pct: number | null;
      strategy_executor: PaperStrategyExecutor;
      ai_decision: string | null;
      adaptive_decision: string | null;
      guidance: string | null;
      next_action: string | null;
      invalidate_condition: string | null;
      risk_note: string | null;
      watch_zone: string | null;
      entry_progress: number | null;
      target_stage: number | null;
      supplemental_reasons?: string[];
      is_ambiguous?: boolean;
      stage1_loosened_entry?: boolean;
      ai_floor_relaxed?: boolean;
      auto_entry_triggered?: boolean;
      reviewing_ticks?: number;
      stage1_result_code?: import("../models/types").PaperStage1ResultCode;
      final_fail_reason?: string;
      required_move_pct?: number | null;
      shortfall_pct?: number | null;
      signal_missing_reason?: string;
      box_position_diag?: number | null;
      ema_gap_diag?: number | null;
      volatility_proxy_diag?: number | null;
      stage1_leniency_applied?: boolean;
      cost_warning_applied?: boolean;
      stage1_size_reduced_due_to_cost?: boolean;
      post_entry_cost_guard?: boolean;
      fixed_total_cost_usd?: number | null;
      expected_move_usd?: number | null;
      required_cost_usd?: number | null;
      shortfall_usd?: number;
      executor_block_reason_original?: string | null;
      stage1_soft_exec_override?: boolean;
      stage1_signal_relaxed?: boolean;
      signal_relax_reason?: string | null;
      stage1_soft_candidate_enter_applied?: boolean;
      stage1_soft_candidate_original_block_reason?: string | null;
      stage1_soft_candidate_size_mult?: number | null;
      stage1_size_multiplier_final?: number | null;
      order_build_ok?: boolean;
      order_build_fail_reason?: string | null;
      order_build_fail_stage?: "entry_policy" | "adaptive_sizing" | null;
      qty?: number | null;
      price?: number | null;
      stopLoss?: number | null;
      takeProfit?: number | null;
      riskReward?: number | null;
      tick_size?: number | null;
      qty_step?: number | null;
      min_qty?: number | null;
      min_notional?: number | null;
      sizeUsd?: number | null;
      long_only_restriction?: boolean;
      original_signal_state?: string;
      final_signal_state?: string;
      execution_disabled_reason?: string | null;
      reentry_cooldown_applied?: boolean;
      reentry_cooldown_original_ms?: number | null;
      reentry_cooldown_effective_ms?: number | null;
      reentry_cooldown_reason?: string | null;
      stage1_direction_override_applied?: boolean;
      stage1_direction_override_reason?: string | null;
      original_policy_direction?: string | null;
      final_policy_direction?: string | null;
      stage1_cost_soft_bypass_applied?: boolean;
      stage1_cost_soft_bypass_reason?: string | null;
      stage1_cost_shortfall_pct?: number | null;
      stage1_cost_shortfall_usd?: number | null;
      stage1_cost_micro_size_mult?: number | null;
      currentStage?: number;
      regime?: "TREND" | "RANGE" | "NO_TRADE";
      regime_original_state?: PaperRegimeState;
      regime_fallback_applied?: boolean;
      regime_fallback_reason?: string | null;
      range_confidence_diag?: number | null;
      box_cohesion_diag?: number | null;
      breakout_failure_rate_diag?: number | null;
      range_oscillation_diag?: number | null;
      trend_weakness_diag?: number | null;
      range_reason_label?: string | null;
      range_cycle_count?: number | null;
      range_ladder_level?: number | null;
      regime_exit_risk?: number | null;
      box_break_side?: "upper" | "lower" | "none";
      regime_state_diag?: PaperRegimeState;
      entry_intent_type?: "probe" | "standard" | "scale" | "trend";
      entry_confirmation_state?: "unconfirmed" | "reacting" | "confirmed";
      scaling_permission?: boolean;
      probe_only_mode?: boolean;
    }>,
    res: {
      intentSide: "long" | "short" | null;
      executorDecision: AnyEntryDecision | null;
      adaptiveOk: boolean;
      adaptiveDirection: "long" | "short" | null;
      adaptiveDetail: Record<string, unknown> | null;
      adaptiveResult: Extract<FuturesAdaptiveEntryResult, { ok: true }> | null;
      adaptiveFailure?: Extract<FuturesAdaptiveEntryResult, { ok: false }>;
      aiGatePassed: boolean;
    }
  ): EvaluatePaperSymbolEntryResult => ({
    decision: pack(input, sym, em, {
      signal_state: extra.signal_state ?? signal_state,
      regime_state: extra.regime_state ?? regime_state,
      edge_state: extra.edge_state ?? edge_state,
      risk_state: extra.risk_state ?? risk_state,
      execution_state: extra.execution_state ?? execution_state,
      final_decision: extra.final_decision ?? final_decision,
      reject_reason: extra.reject_reason !== undefined ? extra.reject_reason : reject_reason,
      expected_move_pct: extra.expected_move_pct !== undefined ? extra.expected_move_pct : expected_move_pct,
      fee_estimate_pct: extra.fee_estimate_pct !== undefined ? extra.fee_estimate_pct : fee_estimate_pct,
      slippage_buffer_pct,
      safety_margin_pct,
      rr: extra.rr !== undefined ? extra.rr : rr,
      atr_pct: extra.atr_pct !== undefined ? extra.atr_pct : atr_pct,
      strategy_executor: extra.strategy_executor ?? strategy_executor,
      engine_mode: emMode,
      ai_decision: extra.ai_decision !== undefined ? extra.ai_decision : null,
      adaptive_decision: extra.adaptive_decision !== undefined ? extra.adaptive_decision : null,
      guidance: extra.guidance !== undefined ? extra.guidance : guidanceOut,
      next_action: extra.next_action !== undefined ? extra.next_action : null,
      invalidate_condition: extra.invalidate_condition !== undefined ? extra.invalidate_condition : null,
      risk_note: extra.risk_note !== undefined ? extra.risk_note : null,
      watch_zone: extra.watch_zone !== undefined ? extra.watch_zone : null,
      entry_progress: extra.entry_progress !== undefined ? extra.entry_progress : null,
      target_stage: extra.target_stage !== undefined ? extra.target_stage : null,
      supplemental_reasons: extra.supplemental_reasons,
      is_ambiguous: extra.is_ambiguous !== undefined ? extra.is_ambiguous : input.isAmbiguous,
      stage1_loosened_entry: extra.stage1_loosened_entry,
      ai_floor_relaxed: extra.ai_floor_relaxed,
      auto_entry_triggered: extra.auto_entry_triggered !== undefined ? extra.auto_entry_triggered : input.autoEntryTriggered,
      reviewing_ticks: extra.reviewing_ticks !== undefined ? extra.reviewing_ticks : input.reviewingTicks,
      stage1_result_code: extra.stage1_result_code,
      final_fail_reason: extra.final_fail_reason,
      required_move_pct: "required_move_pct" in extra ? extra.required_move_pct : required_move_pct,
      shortfall_pct: "shortfall_pct" in extra ? extra.shortfall_pct : (shortfall_pct ?? 0),
      signal_missing_reason: extra.signal_missing_reason ?? sn?.signalMissingReason,
      box_position_diag: "box_position_diag" in extra ? extra.box_position_diag : sn?.boxPos,
      ema_gap_diag: "ema_gap_diag" in extra ? extra.ema_gap_diag : sn?.emaGap,
      volatility_proxy_diag: "volatility_proxy_diag" in extra ? extra.volatility_proxy_diag : sn?.volumeRatioProxy,
      stage1_leniency_applied: extra.stage1_leniency_applied ?? stage1_leniency_applied,
      cost_warning_applied: extra.cost_warning_applied,
      stage1_size_reduced_due_to_cost: extra.stage1_size_reduced_due_to_cost,
      post_entry_cost_guard: extra.post_entry_cost_guard,
      fixed_total_cost_usd: extra.fixed_total_cost_usd !== undefined ? extra.fixed_total_cost_usd : fixedUsd,
      expected_move_usd: extra.expected_move_usd !== undefined ? extra.expected_move_usd : expectedMoveUsd,
      required_cost_usd: extra.required_cost_usd !== undefined ? extra.required_cost_usd : requiredCostUsd,
      shortfall_usd: extra.shortfall_usd !== undefined ? extra.shortfall_usd : shortfallUsd,
      executor_block_reason_original: extra.executor_block_reason_original !== undefined ? extra.executor_block_reason_original : executorBlockReasonOriginal,
      stage1_soft_exec_override: extra.stage1_soft_exec_override !== undefined ? extra.stage1_soft_exec_override : stage1SoftExecOverrideFlag,
      stage1_size_multiplier_final: extra.stage1_size_multiplier_final !== undefined ? extra.stage1_size_multiplier_final : null,
      order_build_ok: extra.order_build_ok,
      order_build_fail_reason: extra.order_build_fail_reason,
      order_build_fail_stage: extra.order_build_fail_stage,
      qty: extra.qty,
      price: extra.price,
      stopLoss: extra.stopLoss,
      takeProfit: extra.takeProfit,
      riskReward: extra.riskReward,
      tick_size: extra.tick_size,
      qty_step: extra.qty_step,
      min_qty: extra.min_qty,
      min_notional: extra.min_notional,
      sizeUsd: extra.sizeUsd,
      long_only_restriction: extra.long_only_restriction,
      original_signal_state: extra.original_signal_state,
      final_signal_state: extra.final_signal_state,
      execution_disabled_reason: extra.execution_disabled_reason,
      reentry_cooldown_applied: extra.reentry_cooldown_applied ?? reentry_cooldown_applied,
      reentry_cooldown_original_ms: extra.reentry_cooldown_original_ms ?? reentry_cooldown_original_ms,
      reentry_cooldown_effective_ms: extra.reentry_cooldown_effective_ms ?? reentry_cooldown_effective_ms,
      reentry_cooldown_reason: extra.reentry_cooldown_reason ?? reentry_cooldown_reason,
      currentStage: extra.currentStage !== undefined ? extra.currentStage : input.currentStage,
      regime: extra.regime !== undefined ? extra.regime : input.regime,
      stage1_signal_relaxed: extra.stage1_signal_relaxed ?? stage1SignalRelaxed,
      signal_relax_reason: extra.signal_relax_reason ?? signalRelaxReason,
      regime_original_state: extra.regime_original_state ?? originalRegimeState,
      regime_fallback_applied: extra.regime_fallback_applied ?? regimeFallbackApplied,
      regime_fallback_reason: extra.regime_fallback_reason ?? regimeFallbackReason,
      range_confidence_diag: extra.range_confidence_diag !== undefined ? extra.range_confidence_diag : sn?.rangeConfidence,
      box_cohesion_diag: extra.box_cohesion_diag !== undefined ? extra.box_cohesion_diag : sn?.boxCohesion01,
      breakout_failure_rate_diag: extra.breakout_failure_rate_diag !== undefined ? extra.breakout_failure_rate_diag : sn?.breakoutFailureRate,
      range_oscillation_diag: extra.range_oscillation_diag !== undefined ? extra.range_oscillation_diag : sn?.rangeOscillationScore,
      trend_weakness_diag: extra.trend_weakness_diag !== undefined ? extra.trend_weakness_diag : sn?.trendWeaknessScore,
      range_reason_label: extra.range_reason_label !== undefined ? extra.range_reason_label : sn?.rangeReasonLabel,
      range_cycle_count: extra.range_cycle_count !== undefined ? extra.range_cycle_count : sn?.rangeCycleCount,
      range_ladder_level: extra.range_ladder_level !== undefined ? extra.range_ladder_level : sn?.rangeLadderLevel,
      regime_exit_risk: extra.regime_exit_risk !== undefined ? extra.regime_exit_risk : sn?.regimeExitRisk,
      box_break_side: extra.box_break_side !== undefined ? extra.box_break_side : sn?.boxBreakSide,
      regime_state_diag: extra.regime_state_diag !== undefined ? extra.regime_state_diag : sn?.regimeStateDiag,
      entry_intent_type: extra.entry_intent_type !== undefined ? extra.entry_intent_type : res.executorDecision?.entryIntentType,
      entry_confirmation_state: extra.entry_confirmation_state !== undefined ? extra.entry_confirmation_state : res.executorDecision?.entryConfirmationState,
      scaling_permission: extra.scaling_permission !== undefined ? extra.scaling_permission : res.executorDecision?.scalingPermission,
      probe_only_mode: extra.probe_only_mode !== undefined ? extra.probe_only_mode : res.executorDecision?.probeOnlyMode
    }),
    ...res
  });

  if (!input.dataReady || !input.snapshot) {
    return ret(
      {
        signal_state: "NONE",
        edge_state: "FAIL_EXPECTANCY",
        risk_state: "PASS",
        execution_state: "INIT_FAIL",
        final_decision: "DISABLED",
        reject_reason: "DATA_NOT_READY",
        expected_move_pct: null,
        fee_estimate_pct: null,
        rr: null,
        atr_pct: null,
        strategy_executor: "IDLE",
        ai_decision: "N/A",
        adaptive_decision: "N/A",
        guidance: null,
        next_action: null,
        invalidate_condition: null,
        risk_note: null,
        watch_zone: null,
        entry_progress: null,
        target_stage: null,
        supplemental_reasons: ["DATA_NOT_READY"],
        is_ambiguous: false,
        stage1_result_code: "STAGE1_BLOCKED_DATA",
        required_move_pct,
        shortfall_pct,
        /** 신호 부재와 구분: 시세/캔들 등 시장 데이터 미준비만 */
        signal_missing_reason: "MARKET_DATA_NOT_READY",
        box_position_diag: null,
        ema_gap_diag: null,
        volatility_proxy_diag: null,
        stage1_leniency_applied
      },
      {
        intentSide: null,
        executorDecision: null,
        adaptiveOk: false,
        adaptiveDirection: null,
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      }
    );
  }

  if (!sn) {
    return ret(
      {
        signal_state: "NONE",
        edge_state: "FAIL_EXPECTANCY",
        execution_state: "INIT_FAIL",
        final_decision: "DISABLED",
        reject_reason: "DATA_NOT_READY",
        stage1_result_code: "STAGE1_BLOCKED_DATA",
        signal_missing_reason: "SNAPSHOT_NULL",
        box_position_diag: null,
        ema_gap_diag: null,
        volatility_proxy_diag: null,
        supplemental_reasons: ["INTERNAL_SNAPSHOT_NULL"],
        stage1_leniency_applied
      },
      { intentSide: null, executorDecision: null, adaptiveOk: false, adaptiveDirection: null, adaptiveDetail: null, adaptiveResult: null, aiGatePassed: false }
    );
  }
  signal_state = signalToState(sn.signal);

  // Core Highway detection and AI quality scoring
  const highwayResult = detectHighwayTrend(input.snapshot?.candles ?? [], sym);
  const _aiResult = evaluateAiHighwayQuality(input.snapshot?.candles ?? [], sym);
  // Determine executor based on core state and AI defer flag
  let _entryIntent: "probe" | "standard" | "scale" | "trend" = "trend";
  if (highwayResult.state === HighwayTrendState.VALID) {
    _entryIntent = "standard";
  } else if (highwayResult.state === HighwayTrendState.WEAK) {
    _entryIntent = "probe";
  } else {
    _entryIntent = "trend"; // fallback, will likely be rejected later
  }
  strategy_executor = "TREND"; // Use TREND executor for highway core
  // Attach AI scores to decision fields later via pack call

  // Retain core executor selection; overriding removed

  if (typeof em === "number" && Number.isFinite(em)) {
    expected_move_pct = em * 100;
    atr_pct = em * 100;
  }
  if (typeof rm === "number" && Number.isFinite(rm)) {
    fee_estimate_pct = rm * 100;
  }

  let stage1SignalRelaxed = false;
  let signalRelaxReason: string | null = null;

  if (signal_state === "NONE") {
    /** 진단: BTC 등 지수급 심볼의 Stage 1 신호 부재 시 모호하지 않고 특정 조건 충족 시 SOFT_RANGE_CANDIDATE 허용. */
    let softCandidateAllowed = false;

    if (input.currentStage === 0 && input.regime === "RANGE") {
      const boxPos = sn?.boxPos ?? 0.5;
      const boxCentered = boxPos > 0.45 && boxPos < 0.55; // Phase 2: 0.4->0.45, 0.6->0.55
      const emaGap = Math.abs(sn?.emaGap ?? 0);
      const volProxy = sn?.volumeRatioProxy ?? 0;

      // Phase 2: emaGap 0.0001->0.00005, volProxy 0.1->0.05
      if (!boxCentered && emaGap > 0.00005 && volProxy > 0.05) {
        softCandidateAllowed = true;
        stage1SignalRelaxed = true;
        signal_state = "LONG_CANDIDATE"; // 임시 승격하여 EDGE/RISK 태움
        signalRelaxReason = "stage1_range_soft_candidate_v2";
        supplemental_reasons.push("STAGE1_SIGNAL_RELAXED_SOFT_CANDIDATE_V2");
      }
    }

    if (!softCandidateAllowed) {
      reject_reason = "SIGNAL_NONE";
      final_decision = "SKIP";
      return ret(
        {
          execution_state: "PAPER_READY",
          ai_decision: "N/A",
          adaptive_decision: "N/A",
          stage1_result_code: "STAGE1_BLOCKED_SIGNAL",
          required_move_pct: null,
          shortfall_pct: 0,
          signal_missing_reason: sn?.signalMissingReason ?? "EMA_CRITERIA_NOT_MET",
          box_position_diag: sn?.boxPos,
          ema_gap_diag: sn?.emaGap,
          volatility_proxy_diag: sn?.volumeRatioProxy,
          stage1_leniency_applied,
          original_signal_state: "NONE",
          final_signal_state: "NONE"
        },
        {
          intentSide: null,
          executorDecision: null,
          adaptiveOk: false,
          adaptiveDirection: null,
          adaptiveDetail: null,
          adaptiveResult: null,
          aiGatePassed: false
        }
      );
    } else {
      // SOFT_RANGE_CANDIDATE 경로 진입
      // signal_state가 LONG_CANDIDATE/SHORT_CANDIDATE로 잡혀 아래 로직을 계속 타게 됨
      // 단, PACK 시 final_signal_state를 위해 변수 유지
    }
  }

  /**
   * regimeUnknown: BTC 5m 최소 봉 미만 → regime_state UNKNOWN.
   */

  if (regime_state === "UNKNOWN" && input.currentStage === 0 && stage1SignalRelaxed) {
    // Stage 1 soft candidate + UNKNOWN regime -> Fallback to RANGE if safety criteria met
    const boxPos = sn?.boxPos ?? 0.5;
    const boxNotCentered = boxPos < 0.45 || boxPos > 0.55;
    const qualityHighEnough = sn.qualityScore >= 35;

    if (boxNotCentered && qualityHighEnough) {
      regime_state = "RANGE";
      strategy_executor = "RANGE";
      regimeFallbackApplied = true;
      regimeFallbackReason = "stage1_unknown_fallback_to_range_soft_candidate_safe";
      stage1ResultCodeOverride = "STAGE1_UNKNOWN_REGIME_RANGE_FALLBACK";
      supplemental_reasons.push("STAGE1_UNKNOWN_REGIME_RANGE_FALLBACK_APPLIED");
    }
  }

  /**
   * Stage 2+ 는 항상 차단. Stage 1 + isAmbiguous 일 때만 통과(레거시 완화).
   */
  const unknownBlocksEntry =
    regime_state === "UNKNOWN" &&
    (input.currentStage >= 1 || !(input.currentStage === 0 && input.isAmbiguous));
  /** 쿨다운 체크(RISK_FAIL_REENTRY) 완화 (RANGE Stage 1 한정) */
  if ((risk_state as string) === "COOLDOWN" && input.currentStage === 0 && input.regime === "RANGE") {
    const lastMeta = input.lastCloseMetaBySymbol?.get(String(sym));
    const closeReason = lastMeta?.closeReason;
    const entryStageAtClose = lastMeta?.entryStageAtClose ?? 0;
    const elapsedSinceCloseMs = lastMeta ? input.now - lastMeta.closedAt : Infinity;

    const isRelaxReason =
      closeReason === "partial_exit_1" ||
      closeReason === "partial_exit_2" ||
      closeReason === "take_profit" ||
      closeReason === "trailing_stop" ||
      closeReason === "time_based_exit" ||
      closeReason === "regime_exit";

    if (isRelaxReason && entryStageAtClose < 2) {
      reentry_cooldown_applied = true;
      reentry_cooldown_reason = `range_v3_relax_reentry_cooldown_${String(closeReason)}`;

      const relaxMult = 0.05; // Phase 3: Further relaxation (95% reduction)
      const baseCooldownMs = input.reentryCooldownMs;
      reentry_cooldown_original_ms = baseCooldownMs;

      const calculatedEffective = Math.floor(baseCooldownMs * relaxMult);
      reentry_cooldown_effective_ms = Math.max(calculatedEffective, RANGE_STAGE0_REENTRY_RELAX_MIN_MS);

      if (elapsedSinceCloseMs >= reentry_cooldown_effective_ms) {
        risk_state = "PASS";
        reject_reason = null;
        supplemental_reasons.push("RANGE_STAGE0_REENTRY_RELAXED");
      }
    }
  }

  if (unknownBlocksEntry) {
    reject_reason = input.isAmbiguous ? "AMBIGUOUS_WATCHING" : "REGIME_UNKNOWN";
    final_decision = "REJECT";
    edge_state = "FAIL_EXPECTANCY";
    return ret(
      {
        reject_reason,
        final_decision,
        execution_state: "PAPER_READY",
        ai_decision: "N/A",
        adaptive_decision: "N/A",
        guidance: input.isAmbiguous ? "애매한 장세 관망 중" : "적합한 레짐 없음",
        stage1_result_code: stage1ResultCodeOverride ?? "STAGE1_BLOCKED_REGIME",
        required_move_pct: null,
        shortfall_pct: 0
      },
      {
        intentSide: null,
        executorDecision: null,
        adaptiveOk: false,
        adaptiveDirection: null,
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      }
    );
  }

  /** NO_TRADE 는 감지기에서 위험/오류·필수 데이터 부족만 — 모호·약추세 등은 NO_TRADE 로 내리지 않음 */
  if (input.regime === "NO_TRADE") {
    reject_reason = "REGIME_NO_TRADE";
    final_decision = "REJECT";
    regime_state = "NO_TRADE";
    strategy_executor = "IDLE";
    execution_state = "IDLE";
    return ret(
      {
        regime_state: "NO_TRADE",
        execution_state: "IDLE",
        ai_decision: "N/A",
        adaptive_decision: "N/A",
        guidance:
          typeof input.regimeDetail?.reason === "string"
            ? `NO_TRADE (${String(input.regimeDetail.reason)})`
            : null,
        target_stage: null,
        stage1_result_code: "STAGE1_BLOCKED_REGIME",
        required_move_pct: null,
        shortfall_pct: 0
      },
      {
        intentSide: null,
        executorDecision: null,
        adaptiveOk: false,
        adaptiveDirection: null,
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      }
    );
  }

  intentSide = sn.signal === "paper_long_candidate" ? "long" : "short";
  rr = rrFromRegime(input.regime);

  let stage1LoosenedEntry = false;
  /** Stage 1 소액 탐색: 실행기 소프트 차단 오버라이드 시 true (사이즈 추가 축소). */
  let stage1ExploreSoftExec = false;
  /** Stage 1만: 기대이동이 완화 비용 이하여도 탐색 진입 허용(하드 REJECT 안 함) */
  let costWarningStage1 = false;
  let stage1HigherTfBypassSizeMult: number | null = null;
  let stage1RangeLowerEdgeSoftSizeMult: number | null = null;

  const costGateComparable =
    typeof em === "number" &&
    effectiveTotalCost !== null &&
    (useFixedCost || (typeof rm === "number" && totalCost !== null));

  if (costGateComparable && em !== null && effectiveTotalCost !== null) {
    const feeWouldBlock = em <= effectiveTotalCost;
    if (feeWouldBlock) {
      if (input.currentStage === 0) {
        costWarningStage1 = true;
        stage1LoosenedEntry = true;
        edge_state = "PASS";
        supplemental_reasons.push("STAGE1_COST_WARNING_ALLOWED");
      } else {
        edge_state = "FAIL_FEE";
        reject_reason = "EDGE_FAIL_FEE";
        final_decision = "REJECT";
        supplemental_reasons.push("EDGE_FAIL_FEE");
      }
    } else if (totalCost !== null && em <= totalCost) {
      stage1LoosenedEntry = true;
      supplemental_reasons.push("STAGE1_LOOSENED_COST");
    }
  }

  /** Stage 2+ 증액: 비용 대비 기대이동 여유를 Stage 1(초기 틱)보다 엄격히 요구 */
  const stage2plusFeeHeadroomMult = input.currentStage >= 2 ? 1.15 : 1.1;
  if (
    input.currentStage >= 1 &&
    typeof em === "number" &&
    effectiveTotalCost !== null &&
    em <= effectiveTotalCost * stage2plusFeeHeadroomMult
  ) {
    edge_state = "FAIL_FEE";
    reject_reason = "EDGE_FAIL_FEE";
    final_decision = "REJECT";
    supplemental_reasons.push(
      input.currentStage >= 2 ? "EDGE_FAIL_FEE_STAGE3_STRICT" : "EDGE_FAIL_FEE_STAGE2_STRICT"
    );
  }

  const minVol = input.config.paperMinEdgeVolatilityMove;
  /** Stage 1만 기대 변동(게이트 expected move) 하한 추가 완화; Stage 2+는 기본 대비 강화 */
  const effectiveMinVol =
    input.currentStage === 0 ? minVol * 0.52 : input.currentStage === 1 ? minVol * 1.1 : minVol * 1.18;
  if (typeof em === "number" && em < effectiveMinVol) {
    edge_state = "FAIL_LOW_VOL";
    if (!reject_reason) reject_reason = "EDGE_FAIL_LOW_VOL";
    final_decision = "REJECT";
    supplemental_reasons.push("EDGE_FAIL_LOW_VOL");
  }

  const minRr = input.config.paperMinEdgeRr;
  if (rr < minRr) {
    edge_state = "FAIL_RR";
    if (!reject_reason) reject_reason = "EDGE_FAIL_RR";
    final_decision = "REJECT";
    supplemental_reasons.push("EDGE_FAIL_RR");
  }

  if (input.risk?.engineBlocked) {
    risk_state = "HARD_BLOCK";
    if (!reject_reason) reject_reason = "RISK_MAX_DRAWDOWN";
    final_decision = "REJECT";
    supplemental_reasons.push("RISK_MAX_DRAWDOWN");
  }

  const rBlock = input.risk?.blockedRegimes?.[input.regime];
  if (rBlock && rBlock.until > input.now) {
    risk_state = "COOLDOWN";
    if (!reject_reason) reject_reason = "RISK_COOLDOWN";
    final_decision = "REJECT";
    supplemental_reasons.push("RISK_COOLDOWN");
  }

  if (input.lastCloseMetaBySymbol && input.reentryCooldownMs > 0 && intentSide) {
    const meta = input.lastCloseMetaBySymbol.get(String(sym));
    const lastClose = meta?.closedAt ?? 0;
    const elapsed = input.now - lastClose;
    const sameDirection = meta !== undefined && meta.side === intentSide;
    let waitMs = sameDirection ? input.reentryCooldownMs * input.sameDirCooldownMult : input.reentryCooldownMs;
    reentry_cooldown_original_ms = waitMs;
    reentry_cooldown_effective_ms = waitMs;
    reentry_cooldown_applied = false;
    reentry_cooldown_reason = null;

    const scaledFromClose = meta != null && (meta.entryStageAtClose ?? 1) >= 2;
    const relaxEligible =
      input.currentStage === 0 &&
      input.regime === "RANGE" &&
      meta != null &&
      !scaledFromClose &&
      isRangeStage0ReentryRelaxCloseReason(meta.closeReason);

    if (relaxEligible && waitMs > 0) {
      const relaxed = Math.max(
        RANGE_STAGE0_REENTRY_RELAX_MIN_MS,
        Math.floor(waitMs * RANGE_STAGE0_REENTRY_RELAX_MULT)
      );
      if (relaxed < waitMs) {
        waitMs = relaxed;
        reentry_cooldown_applied = true;
        reentry_cooldown_effective_ms = relaxed;
        reentry_cooldown_reason = `range_v3_relax_reentry_cooldown_${String(meta.closeReason)}`;
      }
    }

    if (lastClose > 0 && elapsed < waitMs) {
      risk_state = "COOLDOWN";
      if (!reject_reason) reject_reason = "RISK_FAIL_REENTRY";
      final_decision = "REJECT";
      supplemental_reasons.push("RISK_FAIL_REENTRY");
    }
  }

  if (input.risk && input.risk.sizeMultiplier < 1 && !input.risk.dailyLossGuardTriggered) {
    const br = input.risk.blockedRegimes?.[input.regime];
    if (!(br && br.until > input.now)) {
      risk_state = "SOFT_BLOCK";
    }
  }

  if (final_decision === "REJECT") {
    return ret(
      {
        execution_state: "PAPER_READY",
        ai_decision: "N/A",
        adaptive_decision: "N/A",
        supplemental_reasons,
        stage1_result_code: (reject_reason?.startsWith("EDGE") ? "STAGE1_BLOCKED_EDGE" : "STAGE1_BLOCKED_RISK") as any,
        required_move_pct,
        shortfall_pct
      },
      {
        intentSide,
        executorDecision: null,
        adaptiveOk: false,
        adaptiveDirection: null,
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      }
    );
  }

  if (input.maxPositionsReached) {
    final_decision = "SKIP";
    reject_reason = "RISK_MAX_POSITIONS";
    execution_state = "IDLE";
    supplemental_reasons.push("RISK_MAX_POSITIONS");
    return ret(
      {
        execution_state: "IDLE",
        ai_decision: "N/A",
        adaptive_decision: "N/A",
        guidance: "최대 포지션 도달",
        target_stage: null,
        supplemental_reasons,
        stage1_result_code: "STAGE1_BLOCKED_LIMIT",
        required_move_pct,
        shortfall_pct
      },
      {
        intentSide,
        executorDecision: null,
        adaptiveOk: false,
        adaptiveDirection: null,
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      }
    );
  }

  const nowOpen = input.now;
  const key = `${String(sym)}:${intentSide}`;
  const rangeUntil = input.rangeCooldownUntilByKey.get(key) ?? 0;
  const rangeCooldownBypass = input.rangeReopenCooldownBypass === true;
  const effectiveRangeUntil = rangeCooldownBypass ? 0 : rangeUntil;
  const trendUntil = input.trendCooldownUntilBySymbol.get(String(sym)) ?? 0;

  // Highway Engine First - Regime is only secondary veto logic
  const isHighwayAcceptable = highwayResult.state === HighwayTrendState.VALID || highwayResult.state === HighwayTrendState.WEAK;

  if (isHighwayAcceptable && _aiResult.highwayValidityScore >= 0.3) {
    executorDecision = highwayExecutorEvaluateEntry({
      intentType: _entryIntent,
      highwayState: highwayResult.state,
      aiScores: _aiResult,
      symbol: String(sym),
      signal: sn.signal,
      risk_state: (input.risk?.riskStatus ?? "NORMAL") as "NORMAL" | "LIMITED" | "BLOCKED",
      currentStage: input.currentStage,
      expectedMove: typeof em === "number" ? em : null,
      totalCost
    });

    // Auxiliary RANGE Veto / Downgrade Logic (executed only if Highway is weak-ish)
    if (executorDecision.entry_allowed && _aiResult.highwayValidityScore < 0.6) {
      const penalty = sn.rangeConfidence ?? 0;
      const isChaos = (sn.breakoutFailureRate ?? 0) > 0.8;

      if (penalty > 0.85 || isChaos) {
        executorDecision = {
          ...executorDecision,
          entry_allowed: false,
          blocked_reason: "range_extreme_veto",
          guidance: "Highway blocked by extreme RANGE chaos/noise"
        };
      } else if (penalty > 0.7 && executorDecision.target_stage && executorDecision.target_stage > 1) {
        executorDecision = {
          ...executorDecision,
          target_stage: 1,
          guidance: "Highway downgraded to Probe/Scale 1 due to RANGE noise"
        };
      }
    }
  } else {
    // Legacy fallback for structural RANGE exploration when not a highway setup
    executorDecision = input.regime === "RANGE"
      ? rangeExecutorEvaluateEntry({
        regime: input.regime,
        risk_state: (input.risk?.riskStatus ?? "NORMAL") as "NORMAL" | "LIMITED" | "BLOCKED",
        symbol: String(sym),
        signal: sn.signal,
        qualityScore: sn.qualityScore,
        boxPos: sn.boxPos ?? null,
        boxRel: sn.boxRel ?? null,
        expectedMove: typeof em === "number" ? em : null,
        totalCost,
        atr: sn.atr,
        cooldownActive: effectiveRangeUntil > nowOpen,
        cooldownRemainingMs: effectiveRangeUntil > nowOpen ? effectiveRangeUntil - nowOpen : 0,
        currentStage: input.currentStage,
        autoEntryTriggered: input.autoEntryTriggered,
        reviewingTicks: input.reviewingTicks,
        rangeConfidence: sn.rangeConfidence,
        boxCohesion01: sn.boxCohesion01,
        trendWeaknessScore: sn.trendWeaknessScore,
        rangeReasonLabel: sn.rangeReasonLabel
      })
      : null;
  }

  // Round 3: Stage 1 — RANGE·모호 소액 탐색 + 자동 진입 + RANGE 박스/에지 소프트 허용
  executorBlockReasonOriginal = executorDecision?.blocked_reason ?? null;
  const brExec = executorBlockReasonOriginal;
  if (!executorDecision?.entry_allowed && input.currentStage === 0 && brExec) {
    const isQualityHighForBypass = sn.qualityScore >= 45;
    const isQualityVeryHighForBypass = sn.qualityScore >= 50;
    const crashSafe = input.risk?.crashState === "NONE";

    const allowHigherTfSoft = brExec === "higher_tf_mismatch" && isQualityHighForBypass && crashSafe;
    const allowRangeLowerEdgeSoft = brExec === "range_not_lower_edge" && isQualityVeryHighForBypass && crashSafe;

    const allowExploreSoft =
      (STAGE1_SOFT_EXPLORE_BLOCKS.has(brExec) || allowHigherTfSoft || allowRangeLowerEdgeSoft) &&
      (input.isAmbiguous || input.regime === "RANGE" || allowHigherTfSoft);

    const allowAutoEntrySoft =
      input.autoEntryTriggered && (brExec === "trend_not_in_pullback" || brExec === "range_not_in_interest_zone");
    const rangeEdgeTag = input.regime === "RANGE" ? STAGE1_RANGE_EDGE_SOFT_TAGS[brExec] : undefined;
    const allowRangeEdgeSoft = rangeEdgeTag !== undefined;

    if (allowExploreSoft || allowAutoEntrySoft || allowRangeEdgeSoft) {
      stage1ExploreSoftExec = allowExploreSoft;
      executorBlockReasonOriginal = brExec;
      stage1SoftExecOverrideFlag = true;

      if (allowRangeEdgeSoft) {
        stage1RangeEdgeSoftApplied = true;
        supplemental_reasons.push(rangeEdgeTag!);
      }

      // Special size penalty for higher_tf_mismatch bypass
      if (allowHigherTfSoft) {
        stage1HigherTfBypassSizeMult = 0.5;
        supplemental_reasons.push("STAGE1_HIGHER_TF_SOFT_BYPASS");
      }
      if (allowRangeLowerEdgeSoft) {
        stage1RangeLowerEdgeSoftSizeMult = 0.5;
        supplemental_reasons.push("STAGE1_RANGE_LOWER_EDGE_SOFT_BYPASS");
      }

      executorDecision = {
        ...executorDecision!,
        entry_allowed: true,
        blocked_reason: null,
        guidance: allowHigherTfSoft
          ? `Stage1 상위추세 불일치 소액 허용 (${sn.qualityScore}점)`
          : allowRangeLowerEdgeSoft
            ? `Stage1 RANGE 하단 미달 소액 허용 (${sn.qualityScore}점)`
            : allowRangeEdgeSoft
              ? `Stage1 RANGE 위치 탐색 (${brExec})`
              : allowExploreSoft
                ? `Stage1 소액 탐색 (${brExec})`
                : `검토 유지 자동 진입 (${brExec} 무시)`,
        target_stage: 1
      };
      if (allowExploreSoft && !allowHigherTfSoft && !allowRangeLowerEdgeSoft) {
        supplemental_reasons.push("STAGE1_EXPLORE_SOFT_EXEC");
      }
    }
  }

  /** Round 3.5: RANGE Stage1 Soft Candidate Micro-Entry (no_signal 재차단 우회) */
  let stage1SoftCandidateMicroEnter = false;
  if (
    !executorDecision?.entry_allowed &&
    input.currentStage === 0 &&
    input.regime === "RANGE" &&
    stage1SignalRelaxed === true &&
    (executorDecision?.blocked_reason === "no_signal" || executorDecision?.blocked_reason === "range_low_quality_for_lead")
  ) {
    stage1SoftCandidateMicroEnter = true;
    stage1SoftCandidateMicroEnter = true;
    executorDecision = {
      ...executorDecision,
      entry_allowed: true,
      blocked_reason: null,
      guidance: `Stage1 Micro-Entry (${executorBlockReasonOriginal})`,
      target_stage: 1
    };
    supplemental_reasons.push("STAGE1_SOFT_CANDIDATE_MICRO_ENTER");
  }

  /** Round 3.6: Stage 1 RANGE Cost/LowVol Soft Bypass (shortfall_pct <= 0.25) */
  let stage1CostSoftBypassApplied = false;
  let stage1CostSoftBypassReason: string | null = null;
  const brCost = executorDecision?.blocked_reason;
  if (
    !executorDecision?.entry_allowed &&
    input.currentStage === 0 &&
    input.regime === "RANGE" &&
    stage1SignalRelaxed === true &&
    (brCost === "fail_fee" || brCost === "fail_low_vol") &&
    (required_move_pct ?? 0) > 0
  ) {
    const costShortfallPctRaw = shortfall_pct ?? 0;
    // Condition: shortfall_pct <= 0.25 (Relaxed limit)
    const allowCostBypass = costShortfallPctRaw <= 0.25;

    // Additional restriction for FAIL_LOW_VOL: needs to be more conservative
    const isActuallyAllowed = brCost === "fail_fee"
      ? allowCostBypass
      : (allowCostBypass && (sn.qualityScore >= 45)); // FAIL_LOW_VOL requires slightly better quality

    if (isActuallyAllowed) {
      stage1CostSoftBypassApplied = true;
      stage1CostSoftBypassReason = brCost.toUpperCase();
      executorDecision = {
        ...executorDecision!,
        entry_allowed: true,
        blocked_reason: null,
        guidance: `Stage1 Cost Bypass (${brCost})`,
        target_stage: 1
      };
      supplemental_reasons.push(`STAGE1_COST_SOFT_BYPASS_${brCost.toUpperCase()}`);
    }
  }

  if (!executorDecision || !executorDecision.entry_allowed) {
    const br = executorDecision?.blocked_reason;
    reject_reason = br ? mapExecutorBlockToReject(br) : (input.isAmbiguous ? "AMBIGUOUS_WATCHING" : "LEGACY_BLOCKED");
    if (reject_reason === "RISK_COOLDOWN") risk_state = "COOLDOWN";

    // Round 4 & 5: Active Stage 1 candidate evaluation (Execution over Review)
    final_decision = input.currentStage === 0 ? "SKIP" : "REJECT";

    if (input.isAmbiguous && final_decision === "SKIP") {
      const ambCode = input.regime === "TREND" ? "AMBIGUOUS_TREND_REVIEW" : "AMBIGUOUS_RANGE_REVIEW";
      reject_reason = ambCode;
      execution_state = ambCode;
    }

    if (br) supplemental_reasons.push(`EXEC_BLOCKED_${br.toUpperCase()}`);
    return ret(
      {
        execution_state,
        final_decision,
        ai_decision: "N/A",
        adaptive_decision: "N/A",
        guidance: executorDecision?.guidance ?? null,
        next_action: executorDecision?.next_action ?? null,
        invalidate_condition: executorDecision?.invalidate_condition ?? null,
        risk_note: executorDecision?.risk_note ?? null,
        watch_zone: executorDecision?.watch_zone ?? null,
        entry_progress: executorDecision?.entry_progress ?? null,
        target_stage: null,
        supplemental_reasons,
        stage1_result_code: (input.currentStage === 0 && input.isAmbiguous) ? "STAGE1_EXEC_PENDING" : "STAGE1_BLOCKED_REGIME",
        stage1_signal_relaxed: stage1SignalRelaxed,
        signal_relax_reason: signalRelaxReason,
        stage1_soft_candidate_enter_applied: stage1SoftCandidateMicroEnter,
        stage1_soft_candidate_original_block_reason: stage1SoftCandidateMicroEnter ? executorBlockReasonOriginal : null,
        stage1_soft_candidate_size_mult: stage1SoftCandidateMicroEnter ? 0.4 : null,
        stage1_cost_soft_bypass_applied: stage1CostSoftBypassApplied,
        stage1_cost_soft_bypass_reason: stage1CostSoftBypassReason,
        stage1_cost_shortfall_pct: shortfall_pct,
        stage1_cost_shortfall_usd: ((required_move_pct ?? 0) > 0 && shortfall_pct && totalCost !== null) ? (totalCost * shortfall_pct) : null,
        stage1_cost_micro_size_mult: stage1CostSoftBypassApplied ? 0.5 : null,
        currentStage: input.currentStage,
        required_move_pct,
        shortfall_pct
      },
      {
        intentSide,
        executorDecision,
        adaptiveOk: false,
        adaptiveDirection: null,
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      }
    );
  }

  const lossStreak = input.risk?.recentLossStreakByMode?.[input.regime] ?? 0;
  const last10Net =
    typeof input.risk?.detail?.last10_net_usd === "number" && Number.isFinite(input.risk.detail.last10_net_usd as number)
      ? (input.risk.detail.last10_net_usd as number)
      : 0;
  const aiIn = aiInputFromDecision({ decision: executorDecision, executorDirection: intentSide, lossStreak, last10Net });
  if (aiIn) {
    const aiOut = aiApproveEntry(aiIn);
    const aiDir = aiOut.action === "ENTER_LONG" ? "long" : aiOut.action === "ENTER_SHORT" ? "short" : "none";
    const mismatch = aiDir !== "none" && aiDir !== intentSide;
    if (mismatch) {
      reject_reason = "AI_DIRECTION_MISMATCH";
      final_decision = "REJECT";
      supplemental_reasons.push("AI_DIRECTION_MISMATCH");
      return ret(
        {
          reject_reason: "AI_DIRECTION_MISMATCH",
          final_decision: "REJECT",
          ai_decision: "REJECT",
          adaptive_decision: "N/A",
          guidance: "AI 방향 불일치",
          target_stage: null,
          supplemental_reasons,
          stage1_result_code: "STAGE1_BLOCKED_QUALITY",
          required_move_pct,
          shortfall_pct
        },
        {
          intentSide,
          executorDecision,
          adaptiveOk: false,
          adaptiveDirection: null,
          adaptiveDetail: null,
          adaptiveResult: null,
          aiGatePassed: false
        }
      );
    }

    // AI Role refinement: Stage 1 floor relaxed to 35
    let aiFloorRelaxed = false;
    let aiSizeLadderMult = 1.0;

    if (aiOut.action === "NO_ENTRY") {
      const effectiveFloor = input.currentStage === 0 ? 35 : 45;
      if (input.currentStage === 0 && sn.qualityScore >= 35 && sn.qualityScore < 45) {
        aiFloorRelaxed = true;
        // Ladder: 35~39: 0.25x, 40~44: 0.38x (User rule)
        aiSizeLadderMult = sn.qualityScore < 40 ? 0.25 : 0.38;
      }

      if (sn.qualityScore < effectiveFloor) {
        reject_reason = "AI_REJECT";
        final_decision = "REJECT";
        supplemental_reasons.push("AI_REJECT_LOW_QUALITY");
        return ret(
          {
            reject_reason: "AI_REJECT",
            final_decision: "REJECT",
            ai_decision: "REJECT",
            adaptive_decision: "N/A",
            guidance: `AI 품질 미달 거부 (Floor: ${effectiveFloor})`,
            target_stage: null,
            supplemental_reasons,
            ai_floor_relaxed: aiFloorRelaxed,
            stage1_result_code: "STAGE1_BLOCKED_QUALITY",
            required_move_pct,
            shortfall_pct
          },
          {
            intentSide,
            executorDecision,
            adaptiveOk: false,
            adaptiveDirection: null,
            adaptiveDetail: null,
            adaptiveResult: null,
            aiGatePassed: false
          }
        );
      } else {
        // Quality 35~60: Allow but size down + label as LOW_QUALITY
        stage1LoosenedEntry = true;
        supplemental_reasons.push("AI_LOW_QUALITY_CAUTION");
        if (aiFloorRelaxed) {
          supplemental_reasons.push("AI_FLOOR_RELAXED_FOR_STAGE1");
          supplemental_reasons.push(`AI_SIZE_LADDER_${Math.round(aiSizeLadderMult * 100)}PCT`);
        }
      }
    }

    // Size Multiplier Calculation
    let dynamicSizeMult = input.risk?.sizeMultiplier ?? 1;
    if (stage1LoosenedEntry && input.currentStage === 0) {
      // Use AI size ladder if applicable, otherwise default Stage 1 loosening
      dynamicSizeMult *= aiFloorRelaxed ? aiSizeLadderMult : 0.25;
    }
    if (costWarningStage1 && input.currentStage === 0) {
      dynamicSizeMult *= 0.35;
    }
    if (stage1ExploreSoftExec && input.currentStage === 0) {
      dynamicSizeMult *= 0.28;
    }
    if (stage1HigherTfBypassSizeMult !== null) {
      dynamicSizeMult *= stage1HigherTfBypassSizeMult;
    }
    if (stage1RangeLowerEdgeSoftSizeMult !== null) {
      dynamicSizeMult *= stage1RangeLowerEdgeSoftSizeMult;
    }
    if (stage1RangeEdgeSoftApplied && input.currentStage === 0) {
      dynamicSizeMult *= STAGE1_RANGE_POSITION_SOFT_MULT;
    }
    if (input.isAmbiguous) {
      dynamicSizeMult *= 0.8; // Extra caution for ambiguous market
    }

    if (stage1SoftCandidateMicroEnter) {
      dynamicSizeMult *= 0.4; // STAGE1_SOFT_CANDIDATE_MICRO_MULT
    }

    if (stage1CostSoftBypassApplied) {
      dynamicSizeMult *= 0.5; // Additional restriction for cost bypass
    }

    const stage1SizeMultFinal = input.currentStage === 0 ? dynamicSizeMult : null;

    /** Stage1 RANGE 탐색: 소프트 탐색·에지·자동진입 소프트, 또는 실행기 자연 허용(소프트 없음). */
    const stage1RangeExplorePath =
      stage1ExploreSoftExec ||
      stage1RangeEdgeSoftApplied ||
      (stage1SoftExecOverrideFlag &&
        input.autoEntryTriggered === true &&
        (executorBlockReasonOriginal === "trend_not_in_pullback" ||
          executorBlockReasonOriginal === "range_not_in_interest_zone"));
    /** 실행기가 별도 소프트 없이 RANGE에서 허용한 경우(에지 충족 등). */
    const naturalRangeStage1EntryAllowed = input.regime === "RANGE" && input.currentStage === 0 && !stage1SoftExecOverrideFlag;
    /** EXEC_BLOCKED_RANGE_NOT_LOWER_EDGE 소프트는 본 완화 대상 아님 — 원인 블록이면 adaptive 소프트 비적용. */
    const stage1RangeAdaptiveSoftExplore =
      input.currentStage === 0 &&
      input.regime === "RANGE" &&
      input.adaptiveMode === "sideways" &&
      executorBlockReasonOriginal !== "range_not_lower_edge" &&
      (stage1RangeExplorePath || naturalRangeStage1EntryAllowed);

    const adaptive = runFuturesAdaptiveEntry({
      mode: input.adaptiveMode,
      modeDetail: input.adaptiveDetail,
      snap: {
        symbol: String(sym),
        signal: sn.signal,
        lastPrice: sn.lastPrice,
        latestCandleClose: sn.latestCandleClose,
        ema20: sn.ema20,
        ema60: sn.ema60,
        qualityScore: sn.qualityScore,
        candidateStrength: sn.candidateStrength,
        emaGap: sn.emaGap,
        volumeRatioProxy: sn.volumeRatioProxy
      },
      baseSizeUsd: DEFAULT_PAPER_SIZE_USD * dynamicSizeMult,
      stage1RangeAdaptiveSoftExplore
    });
    adaptiveDetailOut = adaptive.detail ?? null;

    // Consolidate reasons: Use policy failure over executor failure if it's from entry_policy
    if (!adaptive.ok && adaptive.orderBuildFailReason && adaptive.failStage === "entry_policy") {
      executorBlockReasonOriginal = adaptive.orderBuildFailReason;
    }
    if (!adaptive.ok) {
      let stage1DirectionOverrideApplied = false;
      let stage1DirectionOverrideReason: string | null = null;
      let originalPolicyDirection: string | null = adaptive.orderBuildFailReason === "policy_direction_none" ? "none" : null;
      let finalPolicyDirection: string | null = null;

      if (
        adaptive.orderBuildFailReason === "policy_direction_none" &&
        input.currentStage === 0 &&
        input.regime === "RANGE" &&
        stage1SoftCandidateMicroEnter === true
      ) {
        // Apply Direction Override Rule: < 0.5 Long, >= 0.5 Short
        const boxPosDiag = sn.boxPos ?? 0.5;
        finalPolicyDirection = boxPosDiag < 0.5 ? "long" : "short";
        stage1DirectionOverrideApplied = true;
        stage1DirectionOverrideReason = `SoftCandidate Micro-Entry: boxPos ${boxPosDiag.toFixed(2)} -> ${finalPolicyDirection}`;

        // Check longOnly restriction
        if (input.config.longOnly && finalPolicyDirection === "short") {
          supplemental_reasons.push("STAGE1_DIRECTION_OVERRIDE_LONG_ONLY_REJECT");
          // Fall through to normal reject or handle here? Let's handle here for precision.
          return ret(
            {
              reject_reason: "LONG_ONLY_SHORT_DEFERRED",
              final_decision: "SKIP",
              execution_state: "PAPER_READY",
              ai_decision: "APPROVE",
              adaptive_decision: "REJECT",
              guidance: "방향 보정 결과가 숏이나 longOnly 제한됨",
              target_stage: null,
              supplemental_reasons,
              stage1_result_code: "STAGE1_LONG_ONLY_SHORT_DEFERRED",
              required_move_pct,
              shortfall_pct,
              stage1_direction_override_applied: true,
              stage1_direction_override_reason: stage1DirectionOverrideReason + " (Blocked by longOnly)",
              original_policy_direction: originalPolicyDirection,
              final_policy_direction: "short"
            },
            {
              intentSide,
              executorDecision,
              adaptiveOk: false,
              adaptiveDirection: "short",
              adaptiveDetail: adaptiveDetailOut,
              adaptiveResult: null,
              adaptiveFailure: adaptive,
              aiGatePassed: true
            }
          );
        }

        // Successfully overrode direction - what's next? 
        // We can either re-run build or manually construct a minimal "mock" adaptive success 
        // but given the complexity of runFuturesAdaptiveEntry, the cleanest is to allow the fall-through 
        // to ENTER if we can "fix" the adaptive object or simply handle ENTER here.
        // For Stage 1 RANGE, the adaptive result is simple enough.

        return ret(
          {
            final_decision: "ENTER",
            reject_reason: null,
            execution_state: "PAPER_READY",
            ai_decision: "APPROVE",
            adaptive_decision: "OK",
            guidance: `방향 보정 진입 (${stage1DirectionOverrideReason})`,
            target_stage: 1,
            supplemental_reasons,
            stage1_result_code: "STAGE1_ENTERED",
            required_move_pct,
            shortfall_pct,
            stage1_direction_override_applied: true,
            stage1_direction_override_reason: stage1DirectionOverrideReason,
            original_policy_direction: originalPolicyDirection,
            final_policy_direction: finalPolicyDirection,
            qty: (DEFAULT_PAPER_SIZE_USD * dynamicSizeMult) / sn.lastPrice,
            price: sn.lastPrice,
            stopLoss: null,
            takeProfit: null,
            riskReward: rr,
            atr_pct
          },
          {
            intentSide,
            executorDecision,
            adaptiveOk: true,
            adaptiveDirection: finalPolicyDirection as any,
            adaptiveDetail: adaptiveDetailOut,
            adaptiveResult: { ...adaptive, ok: true, direction: finalPolicyDirection as any } as any,
            aiGatePassed: true
          }
        );
      }

      return ret(
        {
          reject_reason: "ORDER_BUILD_FAIL",
          final_decision: "REJECT",
          execution_state: "ORDER_BUILD_FAIL",
          ai_decision: "APPROVE",
          adaptive_decision: "REJECT",
          guidance: `결정 구성 실패 (${adaptive.orderBuildFailReason})`,
          target_stage: null,
          supplemental_reasons,
          stage1_result_code: "STAGE1_BLOCKED_DATA",
          required_move_pct,
          shortfall_pct,
          order_build_ok: false,
          order_build_fail_reason: adaptive.orderBuildFailReason,
          order_build_fail_stage: adaptive.failStage,
          qty: null,
          price: sn.lastPrice,
          stopLoss: null,
          takeProfit: null,
          riskReward: rr,
          atr_pct,
          tick_size: null,
          qty_step: null,
          min_qty: null,
          min_notional: null,
          sizeUsd: null
        },
        {
          intentSide,
          executorDecision,
          adaptiveOk: false,
          adaptiveDirection: null,
          adaptiveDetail: adaptiveDetailOut,
          adaptiveResult: null,
          adaptiveFailure: adaptive,
          aiGatePassed: true
        }
      );
    }

    const expectedSide: "long" | "short" = sn.signal === "paper_long_candidate" ? "long" : "short";
    if (adaptive.direction !== expectedSide) {
      reject_reason = "ADAPTIVE_REJECT";
      final_decision = "REJECT";
      supplemental_reasons.push("ADAPTIVE_DIRECTION_MISMATCH");
      return ret(
        {
          reject_reason: "ADAPTIVE_REJECT",
          final_decision: "REJECT",
          ai_decision: "APPROVE",
          adaptive_decision: "REJECT",
          guidance: "방향 불일치 (Adaptive)",
          target_stage: null,
          supplemental_reasons,
          stage1_result_code: "STAGE1_BLOCKED_RISK",
          required_move_pct,
          shortfall_pct
        },
        {
          intentSide,
          executorDecision,
          adaptiveOk: false,
          adaptiveDirection: adaptive.direction,
          adaptiveDetail: adaptiveDetailOut,
          adaptiveResult: null,
          aiGatePassed: true
        }
      );
    }

    if (input.config.longOnly && adaptive.direction === "short") {
      supplemental_reasons.push("LONG_ONLY_RESTRICTION");
      if (
        input.currentStage === 0 &&
        input.regime === "RANGE" &&
        sn.signal === "paper_short_candidate"
      ) {
        return ret(
          {
            final_decision: "SKIP",
            reject_reason: "LONG_ONLY_SHORT_DEFERRED",
            execution_state: "PAPER_READY",
            ai_decision: "APPROVE",
            adaptive_decision: "DEFERRED",
            guidance: "Long Only: 숏 신호 보류(롱 전환 대기), EXECUTION_DISABLED 미발생",
            target_stage: null,
            supplemental_reasons,
            stage1_result_code: "STAGE1_LONG_ONLY_SHORT_DEFERRED",
            required_move_pct,
            shortfall_pct,
            long_only_restriction: true,
            original_signal_state: "SHORT_CANDIDATE",
            final_signal_state: "SHORT_CANDIDATE_LONG_ONLY_DEFERRED",
            execution_disabled_reason: "long_only_no_short_execution; deferred_skip_not_EXECUTION_DISABLED"
          },
          {
            intentSide,
            executorDecision,
            adaptiveOk: true,
            adaptiveDirection: adaptive.direction,
            adaptiveDetail: adaptiveDetailOut,
            adaptiveResult: adaptive,
            aiGatePassed: true
          }
        );
      }
      return ret(
        {
          reject_reason: "EXECUTION_DISABLED",
          final_decision: "REJECT",
          ai_decision: "APPROVE",
          adaptive_decision: "OK",
          guidance: "방향 제한 (Long Only)",
          target_stage: null,
          supplemental_reasons,
          stage1_result_code: "STAGE1_BLOCKED_REGIME",
          required_move_pct,
          shortfall_pct,
          long_only_restriction: true,
          original_signal_state: "SHORT_CANDIDATE",
          final_signal_state: "SHORT_CANDIDATE",
          execution_disabled_reason: "EXECUTION_DISABLED_long_only_short_non_range_or_stage_gt0"
        },
        {
          intentSide,
          executorDecision,
          adaptiveOk: false,
          adaptiveDirection: adaptive.direction,
          adaptiveDetail: adaptiveDetailOut,
          adaptiveResult: null,
          aiGatePassed: true
        }
      );
    }

    final_decision = "ENTER";
    reject_reason = null;

    const forceEnterAdaptive =
      adaptive.detail["stage1_adaptive_force_enter"] ?? adaptive.detail["stage1_adaptive_soft_explore"];
    if (forceEnterAdaptive === "direction_none") supplemental_reasons.push("STAGE1_EXPLORE_ADAPTIVE_DIRECTION_NONE");
    if (forceEnterAdaptive === "ema_flat") supplemental_reasons.push("STAGE1_EXPLORE_ADAPTIVE_EMA_FLAT");

    // Round 4 & 5: Stage 1 Execution Pending prioritize
    if (input.currentStage === 0 && input.autoEntryTriggered) {
      execution_state = "STAGE1_EXEC_PENDING";
      guidanceOut = "Stage 1 실행 대기 (검토 조건 유지)";
    }

    return ret(
      {
        final_decision: "ENTER",
        reject_reason: null,
        ai_decision: "APPROVE",
        adaptive_decision: "OK",
        guidance: executorDecision?.guidance ?? null,
        next_action: executorDecision?.next_action ?? null,
        invalidate_condition: executorDecision?.invalidate_condition ?? null,
        risk_note: executorDecision?.risk_note ?? null,
        watch_zone: executorDecision?.watch_zone ?? null,
        entry_progress: executorDecision?.entry_progress ?? null,
        target_stage: executorDecision?.target_stage ?? null,
        supplemental_reasons,
        auto_entry_triggered: input.autoEntryTriggered,
        stage1_result_code:
          stage1ResultCodeOverride ?? (
            execution_state === "STAGE1_EXEC_PENDING"
              ? "STAGE1_EXEC_PENDING"
              : costWarningStage1
                ? "STAGE1_COST_WARNING"
                : "STAGE1_ENTERED"
          ),
        required_move_pct,
        shortfall_pct,
        cost_warning_applied: costWarningStage1,
        stage1_size_reduced_due_to_cost: costWarningStage1 || (stage1LoosenedEntry && input.currentStage === 0),
        post_entry_cost_guard: costWarningStage1,
        executor_block_reason_original: executorBlockReasonOriginal,
        stage1_soft_exec_override: stage1SoftExecOverrideFlag,
        stage1_signal_relaxed: stage1SignalRelaxed,
        signal_relax_reason: signalRelaxReason,
        stage1_soft_candidate_enter_applied: stage1SoftCandidateMicroEnter,
        stage1_soft_candidate_original_block_reason: stage1SoftCandidateMicroEnter ? executorBlockReasonOriginal : null,
        stage1_soft_candidate_size_mult: stage1SoftCandidateMicroEnter ? 0.4 : null,
        stage1_cost_soft_bypass_applied: stage1CostSoftBypassApplied,
        stage1_cost_soft_bypass_reason: stage1CostSoftBypassReason,
        stage1_cost_shortfall_pct: shortfall_pct,
        stage1_cost_shortfall_usd: ((required_move_pct ?? 0) > 0 && shortfall_pct && totalCost !== null) ? (totalCost * shortfall_pct) : null,
        stage1_cost_micro_size_mult: stage1CostSoftBypassApplied ? 0.5 : null,
        stage1_size_multiplier_final: stage1SizeMultFinal,
        currentStage: input.currentStage,
        regime: input.regime,
        order_build_ok: true,
        order_build_fail_reason: null,
        order_build_fail_stage: null,
        qty: null,
        price: sn.lastPrice,
        stopLoss: (() => {
          const slThresh = stopLossPctForRegime(input.regime);
          // Protective SL: fallback to regime SL %
          const baseSlPrice = intentSide === "long"
            ? sn.lastPrice * (1 + slThresh) // slThresh is negative
            : sn.lastPrice * (1 - slThresh);

          // ATR-based SL if available (2.5 * ATR)
          if (atr_pct && atr_pct > 0) {
            const atrSlDist = sn.lastPrice * atr_pct * 2.5;
            const atrSlPrice = intentSide === "long"
              ? sn.lastPrice - atrSlDist
              : sn.lastPrice + atrSlDist;

            // Use the more conservative one (closer to price for protection)
            return intentSide === "long"
              ? Math.max(baseSlPrice, atrSlPrice)
              : Math.min(baseSlPrice, atrSlPrice);
          }
          return baseSlPrice;
        })(),
        takeProfit: null,
        riskReward: rr,
        atr_pct,
        tick_size: null,
        qty_step: null,
        min_qty: null,
        min_notional: null,
        sizeUsd: adaptive.sizeUsd,
        original_signal_state: (input.currentStage === 0 && input.regime === "RANGE" && sn.signal === "none") ? "NONE" : signal_state,
        final_signal_state: (input.currentStage === 0 && input.regime === "RANGE" && sn.signal === "none") ? "SOFT_RANGE_CANDIDATE" : signal_state
      },
      {
        intentSide: intentSide ?? (sn.signal === "paper_long_candidate" || sn.signal === "none" ? "long" : "short"),
        executorDecision,
        adaptiveOk: true,
        adaptiveDirection: adaptive.direction,
        adaptiveDetail: adaptiveDetailOut,
        adaptiveResult: adaptive,
        aiGatePassed: true
      }
    );
  }

  // Handle fallback if aiIn is null or logic flows outside
  return ret(
    {
      final_decision: "SKIP",
      reject_reason: "SIGNAL_NONE",
      guidance: "신호 분석 불가",
      supplemental_reasons,
      stage1_result_code: "STAGE1_BLOCKED_SIGNAL",
      required_move_pct,
      shortfall_pct
    },
    {
      intentSide: null,
      executorDecision: null,
      adaptiveOk: false,
      adaptiveDirection: null,
      adaptiveDetail: null,
      adaptiveResult: null,
      aiGatePassed: false
    }
  );
}
