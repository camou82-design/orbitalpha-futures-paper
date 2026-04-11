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
import type { RiskControlDecision } from "./risk-control-layer";
import type { FuturesMarketMode } from "../strategy/live-market-mode";
import { runFuturesAdaptiveEntry, type FuturesAdaptiveEntryResult } from "../strategy/live-entry-pipeline";
import { rangeExecutorEvaluateEntry } from "../strategy/executors/range-executor";
import { trendExecutorEvaluateEntry } from "../strategy/executors/trend-executor";
import type { AnyEntryDecision } from "../strategy/executors/types";
import { aiApproveEntry, aiInputFromDecision } from "../ai/entry-approval";
import type { PaperSignal } from "../strategy/entry-signal";
import type { PaperCandidateStrength } from "../strategy/entry-signal";
import { PIPELINE_VERSION } from "./decision-funnel";

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
  regimeUnknown: boolean;
  isAmbiguous: boolean;
  risk: RiskControlDecision | null;
  adaptiveMode: FuturesMarketMode;
  adaptiveDetail: Record<string, unknown>;
  now: number;
  rangeCooldownUntilByKey: ReadonlyMap<string, number>;
  trendCooldownUntilBySymbol: ReadonlyMap<string, number>;
  lastCloseMetaBySymbol: ReadonlyMap<string, { closedAt: number; side: "long" | "short" }> | null;
  reentryCooldownMs: number;
  sameDirCooldownMult: number;
  hasOpenPosition: boolean;
  currentStage: number;
  maxPositionsReached: boolean;
  reviewingTicks?: number;
  autoEntryTriggered?: boolean;
}>;

export type EvaluatePaperSymbolEntryResult = Readonly<{
  decision: PaperSymbolDecision;
  intentSide: "long" | "short" | null;
  executorDecision: AnyEntryDecision | null;
  adaptiveOk: boolean;
  adaptiveDirection: "long" | "short" | null;
  adaptiveDetail: Record<string, unknown> | null;
  adaptiveResult: Extract<FuturesAdaptiveEntryResult, { ok: true }> | null;
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
    post_entry_cost_guard: fields.post_entry_cost_guard
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

  const sym = input.snapshot?.symbol ?? ("UNKNOWN" as MarketSymbol);
  let em: number | null = null;

  let signal_state: PaperSignalState = "NONE";
  let regime_state = regimeToState(input.regime, input.regimeUnknown);
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

  const totalCost = (typeof rm === "number" && Number.isFinite(rm)) ? rm + slipFrac + safety : null;
  const effectiveTotalCost = totalCost !== null ? totalCost * leniency : null;
  const required_move_pct = effectiveTotalCost !== null ? effectiveTotalCost * 100 : null;
  const shortfall_pct = (effectiveTotalCost !== null && em !== null && effectiveTotalCost > em) ? (effectiveTotalCost - em) * 100 : 0;

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
    }>,
    res: {
      intentSide: "long" | "short" | null;
      executorDecision: AnyEntryDecision | null;
      adaptiveOk: boolean;
      adaptiveDirection: "long" | "short" | null;
      adaptiveDetail: Record<string, unknown> | null;
      adaptiveResult: Extract<FuturesAdaptiveEntryResult, { ok: true }> | null;
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
      post_entry_cost_guard: extra.post_entry_cost_guard
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

  if (input.regime === "RANGE" || input.regime === "TREND") {
    strategy_executor = input.regime;
  }

  if (typeof em === "number" && Number.isFinite(em)) {
    expected_move_pct = em * 100;
    atr_pct = em * 100;
  }
  if (typeof rm === "number" && Number.isFinite(rm)) {
    fee_estimate_pct = rm * 100;
  }

  if (signal_state === "NONE") {
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

  if (regime_state === "UNKNOWN" && !(input.currentStage === 0 && input.isAmbiguous)) {
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

  if (input.regime === "NO_TRADE" && !(input.currentStage === 0 && input.isAmbiguous)) {
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
        guidance: null,
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

  const supplemental_reasons: string[] = [];
  let stage1LoosenedEntry = false;
  /** Stage 1만: 기대이동이 완화 비용 이하여도 탐색 진입 허용(하드 REJECT 안 함) */
  let costWarningStage1 = false;

  if (typeof em === "number" && typeof rm === "number" && effectiveTotalCost !== null) {
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

  /** Stage 2/3 증액: 완화 비용선보다 여유 있어야 함(Stage 1 소액 허용과 분리) */
  if (
    input.currentStage >= 1 &&
    typeof em === "number" &&
    effectiveTotalCost !== null &&
    em <= effectiveTotalCost * 1.08
  ) {
    edge_state = "FAIL_FEE";
    reject_reason = "EDGE_FAIL_FEE";
    final_decision = "REJECT";
    supplemental_reasons.push("EDGE_FAIL_FEE_STAGE2_STRICT");
  }

  const minVol = input.config.paperMinEdgeVolatilityMove;
  // Loosen minVol for Stage 1 too
  const effectiveMinVol = input.currentStage === 0 ? minVol * 0.8 : minVol;
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
    const waitMs = sameDirection ? input.reentryCooldownMs * input.sameDirCooldownMult : input.reentryCooldownMs;
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
  const trendUntil = input.trendCooldownUntilBySymbol.get(String(sym)) ?? 0;

  executorDecision =
    input.regime === "RANGE"
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
        cooldownActive: rangeUntil > nowOpen,
        cooldownRemainingMs: rangeUntil > nowOpen ? rangeUntil - nowOpen : 0,
        currentStage: input.currentStage,
        autoEntryTriggered: input.autoEntryTriggered,
        reviewingTicks: input.reviewingTicks
      })
      : input.regime === "TREND"
        ? trendExecutorEvaluateEntry({
          regime: input.regime,
          risk_state: (input.risk?.riskStatus ?? "NORMAL") as "NORMAL" | "LIMITED" | "BLOCKED",
          symbol: String(sym),
          signal: sn.signal,
          qualityScore: sn.qualityScore,
          lastPrice: sn.lastPrice,
          ema20: sn.ema20,
          ema60: sn.ema60,
          volumeRatioProxy: sn.volumeRatioProxy,
          boxHigh: sn.boxHigh ?? null,
          boxLow: sn.boxLow ?? null,
          expectedMove: typeof em === "number" ? em : null,
          totalCost,
          atr: sn.atr,
          cooldownActive: trendUntil > nowOpen,
          cooldownRemainingMs: trendUntil > nowOpen ? trendUntil - nowOpen : 0,
          currentStage: input.currentStage,
          autoEntryTriggered: input.autoEntryTriggered,
          reviewingTicks: input.reviewingTicks
        })
        : null;

  // Round 3: Conditional Override for Auto-Entry Soft Blocks (Stage 1 only)
  if (
    !executorDecision?.entry_allowed &&
    input.autoEntryTriggered &&
    input.currentStage === 0 &&
    (executorDecision?.blocked_reason === "trend_not_in_pullback" || executorDecision?.blocked_reason === "range_not_in_interest_zone")
  ) {
    // Override soft block to force execution for persistent candidates
    executorDecision = {
      ...executorDecision!,
      entry_allowed: true,
      blocked_reason: null,
      guidance: `검토 유지 자동 진입 (${executorDecision?.blocked_reason} 무시)`,
      target_stage: 1
    };
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

    // AI Role refinement: Only EXTREME_LOW (quality < 40 for stage 1 or < 45 for others) is hard REJECT
    let aiFloorRelaxed = false;
    if (aiOut.action === "NO_ENTRY") {
      const effectiveFloor = input.currentStage === 0 ? 40 : 45;
      if (input.currentStage === 0 && sn.qualityScore >= 40 && sn.qualityScore < 45) {
        aiFloorRelaxed = true;
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
        // Quality 40/45~60: Allow but size down + label as LOW_QUALITY
        stage1LoosenedEntry = true;
        supplemental_reasons.push("AI_LOW_QUALITY_CAUTION");
        if (aiFloorRelaxed) supplemental_reasons.push("AI_FLOOR_RELAXED_FOR_STAGE1");
      }
    }

    // Size Multiplier Calculation
    let dynamicSizeMult = input.risk?.sizeMultiplier ?? 1;
    if (stage1LoosenedEntry && input.currentStage === 0) {
      dynamicSizeMult *= 0.25;
    }
    if (costWarningStage1 && input.currentStage === 0) {
      dynamicSizeMult *= 0.35;
    }
    if (input.isAmbiguous) {
      dynamicSizeMult *= 0.8; // Extra caution for ambiguous market
    }

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
      baseSizeUsd: DEFAULT_PAPER_SIZE_USD * dynamicSizeMult
    });
    adaptiveDetailOut = adaptive.detail ?? null;
    if (!adaptive.ok) {
      reject_reason = "ORDER_BUILD_FAIL";
      final_decision = "REJECT";
      execution_state = "ORDER_BUILD_FAIL";
      supplemental_reasons.push("ORDER_BUILD_FAIL");
      return ret(
        {
          reject_reason: "ORDER_BUILD_FAIL",
          final_decision: "REJECT",
          execution_state: "ORDER_BUILD_FAIL",
          ai_decision: "APPROVE",
          adaptive_decision: "REJECT",
          guidance: "결정 구성 실패",
          target_stage: null,
          supplemental_reasons,
          stage1_result_code: "STAGE1_BLOCKED_DATA",
          required_move_pct,
          shortfall_pct
        },
        {
          intentSide,
          executorDecision,
          adaptiveOk: false,
          adaptiveDirection: null,
          adaptiveDetail: adaptiveDetailOut,
          adaptiveResult: null,
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
      reject_reason = "EXECUTION_DISABLED";
      final_decision = "REJECT";
      supplemental_reasons.push("LONG_ONLY_RESTRICTION");
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

    final_decision = "ENTER";
    reject_reason = null;

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
          execution_state === "STAGE1_EXEC_PENDING"
            ? "STAGE1_EXEC_PENDING"
            : costWarningStage1
              ? "STAGE1_COST_WARNING"
              : "STAGE1_ENTERED",
        required_move_pct,
        shortfall_pct,
        cost_warning_applied: costWarningStage1,
        stage1_size_reduced_due_to_cost: costWarningStage1 || (stage1LoosenedEntry && input.currentStage === 0),
        post_entry_cost_guard: costWarningStage1
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
