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
import {
  STRONG_SCORE,
  TREND_POLICY_MIN_VOLUME_RATIO_PROXY,
  TREND_POLICY_MIN_VOLUME_RATIO_PROXY_HIGHWAY_STRONG_RELAX,
  TREND_POLICY_MIN_VOLUME_RATIO_PROXY_HIGHWAY_WEAK_RELAX,
  TREND_VOLUME_RELAX_WEAK_MAX_REQUIRED_MOVE_PCT,
  TREND_VOLUME_RELAX_WEAK_MIN_QUALITY_SCORE,
  TREND_VOLUME_RELAX_WEAK_QUALITY_FOR_STRONG_MIN
} from "../strategy/live-entry-policy";
import { rangeExecutorEvaluateEntry } from "../strategy/executors/range-executor";
import { highwayExecutorEvaluateEntry } from "./highway-entry-executor";
import type { AnyEntryDecision } from "../strategy/executors/types";
import { aiApproveEntry, aiInputFromDecision } from "../ai/entry-approval";
import { HighwayTrendState } from "../models/types";
import { evaluateAiHighwayQuality } from "../engine/ai-highway-filter";
import type { PaperSignal } from "../strategy/entry-signal";
import type { PaperCandidateStrength } from "../strategy/entry-signal";
import { PIPELINE_VERSION } from "./decision-funnel";
import { classifyBoxZone, RANGE_ZONE_ACTION_POLICY } from "./range-engine";
import type { RangeBoxZone } from "../models/types";

/** RANGE·Stage0·RISK_FAIL_REENTRY: 부분익절/TP 계열 청산 후 동일 심볼 재진입 대기만 완화(손절·증액 단계 제외). */
const RANGE_STAGE0_REENTRY_RELAX_MULT = 0.35;
const RANGE_STAGE0_REENTRY_RELAX_MIN_MS = 25_000;
const RANGE_RISK_LIMIT_RELAX_WINDOW_MS = 3 * 60 * 60 * 1000;
const RANGE_RISK_LIMIT_RELAX_STARTED_AT = Date.now();
const RANGE_RISK_LIMIT_RELAX_EXPIRES_AT = RANGE_RISK_LIMIT_RELAX_STARTED_AT + RANGE_RISK_LIMIT_RELAX_WINDOW_MS;
const RANGE_RISK_LIMIT_RELAX_REASON = "paper_exit_validation_3h";

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
  /** pollSymbol 1m kline 배열 길이(엔진 스냅샷) */
  recentCandlesCount?: number;
  /** Highway 진입용 1m 요청 limit (기본 120) */
  highwayKlineLimitRequested?: number;
  highwayEntryTf?: string;
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

type RangeSignalState = "RANGE_LONG_CANDIDATE" | "RANGE_SHORT_CANDIDATE" | "RANGE_SIGNAL_NONE";
type RangeGateResult =
  | "RANGE_GATE_PASS"
  | "RANGE_GATE_BLOCK_BOX_MIDDLE"
  | "RANGE_GATE_BLOCK_LOW_CONFIDENCE"
  | "RANGE_GATE_BLOCK_RISK_ENGINE"
  | "RANGE_GATE_BLOCK_REENTRY";
type RangeEntryResult = "RANGE_LONG_ENTRY" | "RANGE_SHORT_ENTRY" | "RANGE_ENTRY_NONE";

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const RANGE_STAGE0_EDGE_THRESHOLDS = { conf: 0.38, cohesion: 0.32, oscillation: 0.3 } as const;

function rangeStage0EdgeStructureGate(sn: SymbolSnapshotLike): {
  ok: boolean;
  conf: number;
  cohesion: number;
  oscillation: number;
  thresholds: typeof RANGE_STAGE0_EDGE_THRESHOLDS;
  failed_checks: string[];
} {
  const conf = clamp01(sn.rangeConfidence ?? 0);
  const cohesion = clamp01(sn.boxCohesion01 ?? 0);
  const oscillation = clamp01(sn.rangeOscillationScore ?? 0);
  const failed_checks: string[] = [];
  if (conf < RANGE_STAGE0_EDGE_THRESHOLDS.conf) failed_checks.push("conf_below_min");
  if (cohesion < RANGE_STAGE0_EDGE_THRESHOLDS.cohesion) failed_checks.push("cohesion_below_min");
  if (oscillation < RANGE_STAGE0_EDGE_THRESHOLDS.oscillation) failed_checks.push("oscillation_below_min");
  return {
    ok: failed_checks.length === 0,
    conf,
    cohesion,
    oscillation,
    thresholds: RANGE_STAGE0_EDGE_THRESHOLDS,
    failed_checks
  };
}

function rangeStage0EdgeSubconditions(
  edge: ReturnType<typeof rangeStage0EdgeStructureGate>
): ReadonlyArray<{
  id: "conf" | "cohesion" | "oscillation";
  snapshot_field: string;
  value_clamped_01: number;
  threshold_min: number;
  pass: boolean;
  shortfall: number;
}> {
  const t = edge.thresholds;
  return [
    {
      id: "conf",
      snapshot_field: "rangeConfidence",
      value_clamped_01: edge.conf,
      threshold_min: t.conf,
      pass: edge.conf >= t.conf,
      shortfall: Math.max(0, t.conf - edge.conf)
    },
    {
      id: "cohesion",
      snapshot_field: "boxCohesion01",
      value_clamped_01: edge.cohesion,
      threshold_min: t.cohesion,
      pass: edge.cohesion >= t.cohesion,
      shortfall: Math.max(0, t.cohesion - edge.cohesion)
    },
    {
      id: "oscillation",
      snapshot_field: "rangeOscillationScore",
      value_clamped_01: edge.oscillation,
      threshold_min: t.oscillation,
      pass: edge.oscillation >= t.oscillation,
      shortfall: Math.max(0, t.oscillation - edge.oscillation)
    }
  ];
}

function buildRangeUpperLongSuppressBranchProof(args: {
  edge: ReturnType<typeof rangeStage0EdgeStructureGate>;
  rangeSignal: { signal: RangeSignalState; reason: string; side: "long" | "short" | null };
  rawSnapshotSignal: string;
  sn: SymbolSnapshotLike;
  boxPos: number;
  zone: RangeBoxZone;
  reversalImmediate: Readonly<{ preferredSide: "long" | "short" }> | null | undefined;
  gateResult: RangeGateResult;
  gateReason: string;
  entryResult: RangeEntryResult;
  range_upper_short_priority_applied: boolean;
  lowConfidence: boolean;
  rangeReversalSwitchMatches: boolean;
}): Record<string, unknown> {
  const {
    edge,
    rangeSignal,
    rawSnapshotSignal,
    sn,
    boxPos,
    zone,
    reversalImmediate,
    gateResult,
    gateReason,
    entryResult,
    range_upper_short_priority_applied,
    lowConfidence,
    rangeReversalSwitchMatches
  } = args;
  const edge_subconditions = rangeStage0EdgeSubconditions(edge);
  const branch_order_upper = [
    "0. reversalImmediate preferredSide=short && zone=upper → RANGE_SHORT_CANDIDATE / range_reversal_immediate_switch_upper_short",
    "1. sn.signal === paper_short_candidate → RANGE_SHORT_CANDIDATE / range_upper_short_from_base_signal",
    "2. edgeStructureOk (conf/cohesion/oscillation thresholds) → RANGE_SHORT_CANDIDATE / range_upper_short_priority_structure",
    "3. sn.signal === paper_long_candidate → RANGE_SIGNAL_NONE / range_upper_suppress_long_candidate_no_inertia",
    "4. else → RANGE_SIGNAL_NONE / range_upper_short_structure_not_ready"
  ];
  const reversalShortUpperArmed =
    reversalImmediate != null &&
    reversalImmediate.preferredSide === "short" &&
    zone === "upper";
  const step0Taken = rangeSignal.reason === "range_reversal_immediate_switch_upper_short";
  const step1WouldMatch = sn.signal === "paper_short_candidate";
  const step2WouldMatch = edge.ok;
  const step3WouldMatch = sn.signal === "paper_long_candidate";
  let firedStepIndex: number;
  let firedStepLabel: string;
  if (step0Taken) {
    firedStepIndex = 0;
    firedStepLabel = branch_order_upper[0] ?? "";
  } else if (step1WouldMatch) {
    firedStepIndex = 1;
    firedStepLabel = branch_order_upper[1] ?? "";
  } else if (step2WouldMatch) {
    firedStepIndex = 2;
    firedStepLabel = branch_order_upper[2] ?? "";
  } else if (step3WouldMatch) {
    firedStepIndex = 3;
    firedStepLabel = branch_order_upper[3] ?? "";
  } else {
    firedStepIndex = 4;
    firedStepLabel = branch_order_upper[4] ?? "";
  }
  const return_order_matches_code =
    (rangeSignal.reason === "range_reversal_immediate_switch_upper_short" && firedStepIndex === 0) ||
    (rangeSignal.reason === "range_upper_short_from_base_signal" && firedStepIndex === 1) ||
    (rangeSignal.reason === "range_upper_short_priority_structure" && firedStepIndex === 2) ||
    (rangeSignal.reason === "range_upper_suppress_long_candidate_no_inertia" && firedStepIndex === 3) ||
    (rangeSignal.reason === "range_upper_short_structure_not_ready" && firedStepIndex === 4);
  const raw_long_suppress_implies_edge_false =
    rawSnapshotSignal === "paper_long_candidate" && rangeSignal.reason === "range_upper_suppress_long_candidate_no_inertia"
      ? !edge.ok
      : null;
  let range_upper_short_priority_false_because: string;
  if (range_upper_short_priority_applied) {
    range_upper_short_priority_false_because = "range_upper_short_priority_applied is true (zone upper and RANGE_SHORT_ENTRY)";
  } else if (entryResult === "RANGE_SHORT_ENTRY") {
    range_upper_short_priority_false_because = "invariant: entry short but flag false (should not happen)";
  } else if (rangeSignal.signal === "RANGE_SIGNAL_NONE" && rangeSignal.reason === "range_upper_suppress_long_candidate_no_inertia") {
    range_upper_short_priority_false_because =
      "inner RANGE_SIGNAL_NONE from long suppress: edgeStructureOk was false so step 2 did not return SHORT; step 3 matched raw long → suppress; entryResult RANGE_ENTRY_NONE → range_upper_short_priority_applied false";
  } else if (rangeSignal.signal === "RANGE_SIGNAL_NONE" && rangeSignal.reason === "range_upper_short_structure_not_ready") {
    range_upper_short_priority_false_because =
      "edgeStructureOk false and raw not long candidate path → structure_not_ready; short priority branch skipped";
  } else if (rangeSignal.signal === "RANGE_SHORT_CANDIDATE" && gateResult !== "RANGE_GATE_PASS") {
    range_upper_short_priority_false_because = `inner short candidate (${rangeSignal.reason}) but gate blocked: ${gateResult} / ${gateReason}`;
  } else if (rangeSignal.signal === "RANGE_SHORT_CANDIDATE" && lowConfidence && !rangeReversalSwitchMatches) {
    range_upper_short_priority_false_because =
      "inner short candidate but range score gate: lowConfidence && !rangeReversalSwitchMatches → range_score_below_threshold";
  } else {
    range_upper_short_priority_false_because = `entryResult=${entryResult}, inner=${rangeSignal.signal}/${rangeSignal.reason}, gate=${gateResult}/${gateReason}`;
  }
  const failedParts = edge_subconditions.filter((r) => !r.pass).map((r) => `${r.id}=${r.value_clamped_01.toFixed(3)}<${r.threshold_min}`);
  const one_line_summary =
    !edge.ok
      ? `upper+raw_long: edgeStructureOk=false [${failedParts.join(", ") || edge.failed_checks.join(",")}] → step3 long suppress → inner NONE; short_priority_flag false (no RANGE_SHORT_ENTRY)`
      : rangeSignal.signal === "RANGE_SHORT_CANDIDATE" && gateResult !== "RANGE_GATE_PASS"
        ? `upper: edgeStructureOk=true → inner SHORT (${rangeSignal.reason}) but gate ${gateResult}: ${gateReason} → short_priority_flag false`
        : rangeSignal.signal === "RANGE_SHORT_CANDIDATE" && lowConfidence && !rangeReversalSwitchMatches
          ? `upper: inner SHORT but lowConfidence scores blocked gate → short_priority_flag false`
          : `upper: ${range_upper_short_priority_false_because}`;
  return {
    proof_version: 2,
    scenario: "range_upper_raw_paper_long_candidate",
    raw_snapshot_signal: rawSnapshotSignal,
    box_pos: boxPos,
    zone,
    branch_order_upper,
    edge_structure_ok: edge.ok,
    edge_structure_failed_checks: edge.failed_checks,
    edge_subconditions_detail: edge_subconditions,
    edge_structure_gate: {
      ok: edge.ok,
      conf: edge.conf,
      cohesion: edge.cohesion,
      oscillation: edge.oscillation,
      thresholds: edge.thresholds,
      failed_checks: edge.failed_checks
    },
    upper_eval_runtime_trace: {
      reversal_immediate_switch_input: reversalImmediate ?? null,
      reversal_short_upper_armed: reversalShortUpperArmed,
      step0_reversal_short_upper_returned: step0Taken,
      step1_raw_is_paper_short: step1WouldMatch,
      step2_edge_structure_ok: edge.ok,
      step3_raw_is_paper_long: step3WouldMatch,
      fired_step_index: firedStepIndex,
      fired_step_label: firedStepLabel,
      return_order_matches_code,
      invariant_raw_long_suppress_requires_edge_false: raw_long_suppress_implies_edge_false,
      note: "If edgeStructureOk is true, step 2 returns RANGE_SHORT_CANDIDATE before step 3; raw paper_long with suppress reason implies edge was false at runtime."
    },
    legacy_order_bug_note:
      "Previously paper_long_candidate was checked before edgeStructureOk, so short structure never ran on long-raw ticks.",
    evaluate_range_stage0_signal_out: {
      signal: rangeSignal.signal,
      reason: rangeSignal.reason,
      side: rangeSignal.side
    },
    prior_order_would_skip_short_eval:
      rawSnapshotSignal === "paper_long_candidate"
        ? {
          first_matching_branch: "paper_long_candidate",
          immediate_return: "RANGE_SIGNAL_NONE",
          immediate_reason: "range_upper_suppress_long_candidate_no_inertia",
          short_priority_never_reached: true
        }
        : null,
    post_reorder_inner_when_raw_long: edge.ok
      ? { signal: "RANGE_SHORT_CANDIDATE", reason: "range_upper_short_priority_structure" }
      : { signal: "RANGE_SIGNAL_NONE", reason: "range_upper_suppress_long_candidate_no_inertia" },
    gate_result: gateResult,
    gate_reason: gateReason,
    entry_result: entryResult,
    range_upper_short_priority_applied,
    range_upper_short_priority_false_because,
    one_line_summary,
    formula:
      "range_upper_short_priority_applied := (zone === 'upper') && (entryResult === 'RANGE_SHORT_ENTRY')"
  };
}

function evaluateRangeStage0Signal(
  sn: SymbolSnapshotLike,
  reversalImmediate?: Readonly<{ preferredSide: "long" | "short" }> | null
): { signal: RangeSignalState; reason: string; side: "long" | "short" | null } {
  const boxPos = typeof sn.boxPos === "number" ? sn.boxPos : 0.5;
  const zone: RangeBoxZone = classifyBoxZone(boxPos);
  if (reversalImmediate) {
    if (reversalImmediate.preferredSide === "short" && zone === "upper") {
      return {
        signal: "RANGE_SHORT_CANDIDATE",
        reason: "range_reversal_immediate_switch_upper_short",
        side: "short"
      };
    }
    if (reversalImmediate.preferredSide === "long" && zone === "lower") {
      return {
        signal: "RANGE_LONG_CANDIDATE",
        reason: "range_reversal_immediate_switch_lower_long",
        side: "long"
      };
    }
  }
  const edgeGate = rangeStage0EdgeStructureGate(sn);
  const edgeStructureOk = edgeGate.ok;
  const strictOscMin = RANGE_STAGE0_EDGE_THRESHOLDS.oscillation;
  const relaxedOscMin = Math.max(0.24, strictOscMin - 0.06);
  const relaxedEdgeStructureOk =
    !edgeStructureOk &&
    edgeGate.conf >= RANGE_STAGE0_EDGE_THRESHOLDS.conf &&
    edgeGate.cohesion >= RANGE_STAGE0_EDGE_THRESHOLDS.cohesion &&
    edgeGate.oscillation >= relaxedOscMin;

  if (zone === "upper") {
    const upperExtremeEdge = boxPos >= 0.74;
    if (sn.signal === "paper_short_candidate") {
      return { signal: "RANGE_SHORT_CANDIDATE", reason: "range_upper_short_from_base_signal", side: "short" };
    }
    if (upperExtremeEdge && (edgeStructureOk || relaxedEdgeStructureOk)) {
      return { signal: "RANGE_SHORT_CANDIDATE", reason: "range_upper_short_priority_structure", side: "short" };
    }
    if (sn.signal === "paper_long_candidate") {
      return { signal: "RANGE_SIGNAL_NONE", reason: "range_upper_suppress_long_candidate_no_inertia", side: null };
    }
    return { signal: "RANGE_SIGNAL_NONE", reason: "range_upper_short_structure_not_ready", side: null };
  }

  if (zone === "lower") {
    const lowerExtremeEdge = boxPos <= 0.26;
    if (sn.signal === "paper_long_candidate") {
      return { signal: "RANGE_LONG_CANDIDATE", reason: "range_lower_long_from_base_signal", side: "long" };
    }
    if (lowerExtremeEdge && (edgeStructureOk || relaxedEdgeStructureOk)) {
      return { signal: "RANGE_LONG_CANDIDATE", reason: "range_lower_long_priority_structure", side: "long" };
    }
    if (sn.signal === "paper_short_candidate") {
      return { signal: "RANGE_SIGNAL_NONE", reason: "range_lower_suppress_short_candidate", side: null };
    }
    return { signal: "RANGE_SIGNAL_NONE", reason: "range_lower_long_structure_not_ready", side: null };
  }

  return { signal: "RANGE_SIGNAL_NONE", reason: "range_mid_wait_no_directional_chase", side: null };
}

function evaluateRangeStage0Scores(sn: SymbolSnapshotLike): { rangeSignalScore: number; rangeEntryScore: number; reason: string } {
  const conf = clamp01(sn.rangeConfidence ?? 0);
  const cohesion = clamp01(sn.boxCohesion01 ?? 0);
  const breakoutFail = clamp01(sn.breakoutFailureRate ?? 0);
  const oscillation = clamp01(sn.rangeOscillationScore ?? 0);
  const weakness = clamp01(sn.trendWeaknessScore ?? 0.5);
  const boxPos = typeof sn.boxPos === "number" ? sn.boxPos : 0.5;
  const edgeProximity = clamp01(Math.abs(boxPos - 0.5) / 0.5);
  const emaGapAbs = Math.abs(sn.emaGap ?? 0);
  const emaAssist = clamp01(1 - Math.min(1, emaGapAbs / 0.0015));
  const volAssist = clamp01(1 - Math.min(1, Math.abs((sn.volumeRatioProxy ?? 1) - 1) / 1.5));
  const rangeSignalScore = clamp01(0.3 * conf + 0.2 * cohesion + 0.2 * breakoutFail + 0.2 * oscillation + 0.1 * edgeProximity);
  const rangeEntryScore = clamp01(0.25 * conf + 0.2 * cohesion + 0.15 * oscillation + 0.15 * weakness + 0.15 * emaAssist + 0.1 * volAssist);
  return {
    rangeSignalScore,
    rangeEntryScore,
    reason: `conf=${conf.toFixed(2)},cohesion=${cohesion.toFixed(2)},edge=${edgeProximity.toFixed(2)}`
  };
}

function mapExecutorBlockToReject(blocked: string | undefined): PaperDecisionRejectReason {
  switch (blocked) {
    case "highway_invalid":
    case "highway_invalid_hard":
    case "highway_invalid_soft":
      return "EDGE_FAIL_EXPECTANCY";
    case "trend_box_edge_highway_watch":
      return "HIGHWAY_BOX_EDGE_WATCH";
    case "highway_insufficient_candles_watch":
      return "HIGHWAY_CANDLE_WARMUP_WATCH";
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
      return "EDGE_FAIL_EXPECTANCY";
  }
}

export type EvaluatePaperSymbolEntryInput = Readonly<{
  config: EngineConfig;
  snapshot: SymbolSnapshotLike | null;
  dataReady: boolean;
  /** 현재 열린 포지션 방향(반전 청산 분기·proof용). 없으면 null */
  openPositionSide?: "long" | "short" | null;
  /**
   * 구간 반전 청산 직후 같은 틱·pending 구간에서 반대 방향 재진입을 허용(쿨다운·저신뢰 게이트 완화).
   */
  rangeReversalImmediateSwitch?: Readonly<{
    preferredSide: "long" | "short";
    reason: "upper_flatten_to_short" | "lower_flatten_to_long" | "upper_flatten_to_short_pending" | "lower_flatten_to_long_pending";
  }> | null;
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
  openPositionsTotal: number;
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

/** TREND adaptive 직전: 볼륨 하한 완화 적용 여부·미적용 사유를 proof로 고정. */
function computeTrendVolumeRelaxForAdaptive(input: Readonly<{
  adaptiveMode: FuturesMarketMode;
  currentStage: number;
  highwayDet: Record<string, unknown> | undefined;
  highwayStateOk: boolean;
  highwayCoreFinalOk: boolean;
  scoreSourceOk: boolean;
  candidateStrength: PaperCandidateStrength | null;
  qualityScore: number;
  required_move_pct: number | null;
  shortfall_pct: number;
  em: number | null;
}>): { override: number | null; proof: Record<string, unknown> } {
  const notRelaxedReasons: string[] = [];
  const gates = {
    adaptive_mode_trend: input.adaptiveMode === "trend",
    stage0: input.currentStage === 0,
    highway_state_valid: input.highwayStateOk,
    highway_core_final_ok: input.highwayCoreFinalOk,
    score_source_trend_core_default: input.scoreSourceOk,
    candidate_strength: input.candidateStrength,
    quality_score: input.qualityScore,
    strong_tier_eligible:
      input.candidateStrength === "strong" && input.qualityScore >= STRONG_SCORE,
    weak_candidate: input.candidateStrength === "weak",
    weak_tier_quality_ok: input.qualityScore >= TREND_VOLUME_RELAX_WEAK_MIN_QUALITY_SCORE,
    weak_tier_edge_shortfall_ok: input.shortfall_pct <= 0,
    weak_tier_expected_move_available: input.em !== null && Number.isFinite(input.em),
    weak_tier_required_move_available:
      input.required_move_pct !== null && Number.isFinite(input.required_move_pct),
    weak_tier_required_move_low_enough:
      input.required_move_pct !== null &&
      input.required_move_pct <= TREND_VOLUME_RELAX_WEAK_MAX_REQUIRED_MOVE_PCT,
    weak_tier_uses_strong_volume_min:
      input.qualityScore >= TREND_VOLUME_RELAX_WEAK_QUALITY_FOR_STRONG_MIN
  };

  const baseOk =
    gates.adaptive_mode_trend &&
    gates.stage0 &&
    gates.highway_state_valid &&
    gates.highway_core_final_ok &&
    gates.score_source_trend_core_default;

  if (!gates.adaptive_mode_trend) notRelaxedReasons.push("adaptive_mode_not_trend");
  if (!gates.stage0) notRelaxedReasons.push("not_stage0");
  if (!gates.highway_state_valid) notRelaxedReasons.push("highway_state_not_valid");
  if (!gates.highway_core_final_ok) notRelaxedReasons.push("highway_core_or_final_not_valid");
  if (!gates.score_source_trend_core_default) notRelaxedReasons.push("score_source_not_trend_core_default");

  let relaxTier: "strong_highway" | "weak_highway_edge_ok" | null = null;
  let override: number | null = null;

  if (baseOk) {
    if (gates.strong_tier_eligible) {
      relaxTier = "strong_highway";
      override = TREND_POLICY_MIN_VOLUME_RATIO_PROXY_HIGHWAY_STRONG_RELAX;
    } else if (
      gates.weak_candidate &&
      gates.weak_tier_quality_ok &&
      gates.weak_tier_edge_shortfall_ok &&
      gates.weak_tier_expected_move_available &&
      gates.weak_tier_required_move_available &&
      gates.weak_tier_required_move_low_enough
    ) {
      relaxTier = "weak_highway_edge_ok";
      override =
        input.qualityScore >= TREND_VOLUME_RELAX_WEAK_QUALITY_FOR_STRONG_MIN
          ? TREND_POLICY_MIN_VOLUME_RATIO_PROXY_HIGHWAY_STRONG_RELAX
          : TREND_POLICY_MIN_VOLUME_RATIO_PROXY_HIGHWAY_WEAK_RELAX;
      notRelaxedReasons.length = 0;
    } else {
      if (input.candidateStrength === "strong" && !gates.strong_tier_eligible) {
        notRelaxedReasons.push("strong_candidate_but_quality_below_72");
      }
      if (input.candidateStrength === "weak") {
        if (!gates.weak_tier_quality_ok) {
          notRelaxedReasons.push(`weak_candidate_quality_below_${TREND_VOLUME_RELAX_WEAK_MIN_QUALITY_SCORE}`);
        }
        if (!gates.weak_tier_edge_shortfall_ok) {
          notRelaxedReasons.push("weak_tier_blocked_positive_shortfall_pct");
        }
        if (!gates.weak_tier_expected_move_available) {
          notRelaxedReasons.push("weak_tier_blocked_expected_move_missing");
        }
        if (!gates.weak_tier_required_move_available) {
          notRelaxedReasons.push("weak_tier_blocked_required_move_pct_missing");
        } else if (!gates.weak_tier_required_move_low_enough) {
          notRelaxedReasons.push(
            `weak_tier_blocked_required_move_pct_above_${TREND_VOLUME_RELAX_WEAK_MAX_REQUIRED_MOVE_PCT}`
          );
        }
      }
      if (input.candidateStrength !== "strong" && input.candidateStrength !== "weak") {
        notRelaxedReasons.push("candidate_strength_neither_strong_nor_weak");
      }
    }
  }

  return {
    override,
    proof: {
      proof_version: 2,
      relax_evaluated: true,
      relax_applied: override !== null,
      relax_tier: relaxTier,
      trend_volume_ratio_min_override: override,
      default_min_volume_ratio_proxy: TREND_POLICY_MIN_VOLUME_RATIO_PROXY,
      strong_relax_min: TREND_POLICY_MIN_VOLUME_RATIO_PROXY_HIGHWAY_STRONG_RELAX,
      weak_relax_min: TREND_POLICY_MIN_VOLUME_RATIO_PROXY_HIGHWAY_WEAK_RELAX,
      gates,
      not_relaxed_reasons: relaxTier !== null ? [] : [...new Set(notRelaxedReasons)]
    }
  };
}

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
    entry_blocked?: string | null;
    range_stage0_engine_taken?: boolean;
    range_stage0_exit_reason?: string | null;
    legacy_executor_path_taken?: boolean;
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
    execution_disabled_top_proof?: Record<string, unknown> | null;
    trend_volume_relax_proof?: Record<string, unknown> | null;
    reentry_cooldown_applied?: boolean;
    reentry_cooldown_original_ms?: number | null;
    reentry_cooldown_effective_ms?: number | null;
    reentry_cooldown_reason?: string | null;
    risk_cooldown_subreason?: string | null;
    cooldown_remaining_ms?: number | null;
    same_dir_cooldown_applied?: boolean;
    blocked_regime_reason?: string | null;
    reentry_wait_ms?: number | null;
    reentry_elapsed_ms?: number | null;
    blocked_regime_until_bypass_applied?: boolean;
    blocked_regime_until_bypass_reason?: string | null;
    blocked_regime_original_until_ms?: number | null;
    blocked_regime_original_reason?: string | null;
    range_long_only_short_deferred_applied?: boolean;
    range_long_only_short_deferred_bypassed?: boolean;
    range_cost_warning_applied?: boolean;
    range_cost_warning_threshold?: number | null;
    range_cost_warning_shortfall?: number | null;
    range_reentry_cooldown_applied?: boolean;
    range_reentry_wait_ms?: number | null;
    range_reentry_elapsed_ms?: number | null;
    range_reentry_remaining_ms?: number | null;
    range_reentry_source?: string | null;
    range_reentry_same_direction?: boolean;
    range_same_direction_reentry_relaxed_applied?: boolean;
    range_same_direction_reentry_wait_ms?: number | null;
    range_same_direction_reentry_size_mult?: number | null;
    range_same_direction_reentry_edge_ok?: boolean;
    range_same_direction_reentry_center_blocked?: boolean;
    range_same_direction_reentry_final_allowed?: boolean;
    range_risk_limit_temporarily_relaxed?: boolean;
    range_risk_limit_relax_reason?: string | null;
    range_risk_limit_relax_started_at?: number | null;
    range_risk_limit_relax_expires_at?: number | null;
    range_risk_limit_relax_active?: boolean;
    range_risk_limit_relax_expired?: boolean;
    range_soft_suspend_applied?: boolean;
    range_soft_suspend_size_mult?: number | null;
    range_soft_suspend_cooldown_ms?: number | null;
    range_soft_suspend_same_direction_restricted?: boolean;
    range_bidirectional_applied?: boolean;
    range_short_allowed?: boolean;
    range_short_allowed_reason?: string | null;
    range_upper_edge_near?: boolean;
    range_center_wait?: boolean;
    range_final_selected_side?: "long" | "short" | "none" | null;
    range_reversal_zone?: "upper" | "lower" | "mid" | null;
    range_reversal_short_eval_started?: boolean;
    range_reversal_long_exit_triggered?: boolean;
    range_reversal_short_entry_allowed?: boolean;
    range_reversal_short_entry_block_reason?: string | null;
    range_reversal_immediate_switch_applied?: boolean;
    range_reversal_immediate_switch_reason?: string | null;
    range_fresh_reentry_allowed?: boolean;
    range_fresh_reentry_blocked_reason?: string | null;
    range_fresh_reentry_size_mult?: number | null;
    range_reentry_wait_bypassed_no_open_position?: boolean;
    range_loss_streak_reduced_entry_applied?: boolean;
    range_loss_streak_reduced_entry_size_mult?: number | null;
    range_zone_action_policy?: string | null;
    range_zone_detected?: "upper" | "lower" | "mid" | null;
    range_upper_short_priority_applied?: boolean;
    range_lower_long_priority_applied?: boolean;
    range_mid_wait_applied?: boolean;
    range_final_trade_side_by_zone?: string | null;
    range_stage0_branch_proof?: Record<string, unknown> | null;
    legacy_block_reason?: string | null;
    legacy_regime_gate?: string | null;
    legacy_gate_source?: string | null;
    override_by_legacy?: boolean;
    stage1_block_origin?: string | null;
    legacy_block_test_bypass_applied?: boolean;
    legacy_block_test_bypass_reason?: string | null;
    legacy_block_original_reason?: string | null;
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
    fee_drag_filter_applied?: boolean;
    fee_drag_size_reduced?: boolean;
    fee_drag_blocked?: boolean;
    fee_drag_reason?: string | null;
    fee_drag_proof?: Record<string, unknown> | null;
    range_executor_priority_applied?: boolean;
    range_executor_priority_reason?: string | null;
    final_executor_before_priority?: PaperStrategyExecutor | null;
    final_executor_after_priority?: PaperStrategyExecutor | null;
    final_reject_before_priority?: string | null;
    final_reject_after_priority?: string | null;
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
    entry_blocked: fields.entry_blocked ?? null,
    range_stage0_engine_taken: fields.range_stage0_engine_taken ?? false,
    range_stage0_exit_reason: fields.range_stage0_exit_reason ?? null,
    legacy_executor_path_taken: fields.legacy_executor_path_taken ?? false,
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
    execution_disabled_top_proof: fields.execution_disabled_top_proof ?? null,
    trend_volume_relax_proof: fields.trend_volume_relax_proof ?? null,
    reentry_cooldown_applied: fields.reentry_cooldown_applied ?? false,
    reentry_cooldown_original_ms: fields.reentry_cooldown_original_ms ?? null,
    reentry_cooldown_effective_ms: fields.reentry_cooldown_effective_ms ?? null,
    reentry_cooldown_reason: fields.reentry_cooldown_reason ?? null,
    risk_cooldown_subreason: fields.risk_cooldown_subreason ?? null,
    cooldown_remaining_ms: fields.cooldown_remaining_ms ?? null,
    same_dir_cooldown_applied: fields.same_dir_cooldown_applied ?? false,
    blocked_regime_reason: fields.blocked_regime_reason ?? null,
    reentry_wait_ms: fields.reentry_wait_ms ?? null,
    reentry_elapsed_ms: fields.reentry_elapsed_ms ?? null,
    blocked_regime_until_bypass_applied: fields.blocked_regime_until_bypass_applied ?? false,
    blocked_regime_until_bypass_reason: fields.blocked_regime_until_bypass_reason ?? null,
    blocked_regime_original_until_ms: fields.blocked_regime_original_until_ms ?? null,
    blocked_regime_original_reason: fields.blocked_regime_original_reason ?? null,
    range_long_only_short_deferred_applied: fields.range_long_only_short_deferred_applied ?? false,
    range_long_only_short_deferred_bypassed: fields.range_long_only_short_deferred_bypassed ?? false,
    range_cost_warning_applied: fields.range_cost_warning_applied ?? false,
    range_cost_warning_threshold: fields.range_cost_warning_threshold ?? null,
    range_cost_warning_shortfall: fields.range_cost_warning_shortfall ?? null,
    range_reentry_cooldown_applied: fields.range_reentry_cooldown_applied ?? false,
    range_reentry_wait_ms: fields.range_reentry_wait_ms ?? null,
    range_reentry_elapsed_ms: fields.range_reentry_elapsed_ms ?? null,
    range_reentry_remaining_ms: fields.range_reentry_remaining_ms ?? null,
    range_reentry_source: fields.range_reentry_source ?? null,
    range_reentry_same_direction: fields.range_reentry_same_direction ?? false,
    range_same_direction_reentry_relaxed_applied: fields.range_same_direction_reentry_relaxed_applied ?? false,
    range_same_direction_reentry_wait_ms: fields.range_same_direction_reentry_wait_ms ?? null,
    range_same_direction_reentry_size_mult: fields.range_same_direction_reentry_size_mult ?? null,
    range_same_direction_reentry_edge_ok: fields.range_same_direction_reentry_edge_ok ?? false,
    range_same_direction_reentry_center_blocked: fields.range_same_direction_reentry_center_blocked ?? false,
    range_same_direction_reentry_final_allowed: fields.range_same_direction_reentry_final_allowed ?? false,
    range_risk_limit_temporarily_relaxed: fields.range_risk_limit_temporarily_relaxed ?? false,
    range_risk_limit_relax_reason: fields.range_risk_limit_relax_reason ?? null,
    range_risk_limit_relax_started_at: fields.range_risk_limit_relax_started_at ?? null,
    range_risk_limit_relax_expires_at: fields.range_risk_limit_relax_expires_at ?? null,
    range_risk_limit_relax_active: fields.range_risk_limit_relax_active ?? false,
    range_risk_limit_relax_expired: fields.range_risk_limit_relax_expired ?? false,
    range_soft_suspend_applied: fields.range_soft_suspend_applied ?? false,
    range_soft_suspend_size_mult: fields.range_soft_suspend_size_mult ?? null,
    range_soft_suspend_cooldown_ms: fields.range_soft_suspend_cooldown_ms ?? null,
    range_soft_suspend_same_direction_restricted: fields.range_soft_suspend_same_direction_restricted ?? false,
    range_bidirectional_applied: fields.range_bidirectional_applied ?? false,
    range_short_allowed: fields.range_short_allowed ?? false,
    range_short_allowed_reason: fields.range_short_allowed_reason ?? null,
    range_upper_edge_near: fields.range_upper_edge_near ?? false,
    range_center_wait: fields.range_center_wait ?? false,
    range_final_selected_side: fields.range_final_selected_side ?? null,
    range_reversal_zone: fields.range_reversal_zone ?? null,
    range_reversal_short_eval_started: fields.range_reversal_short_eval_started ?? false,
    range_reversal_long_exit_triggered: fields.range_reversal_long_exit_triggered ?? false,
    range_reversal_short_entry_allowed: fields.range_reversal_short_entry_allowed ?? false,
    range_reversal_short_entry_block_reason: fields.range_reversal_short_entry_block_reason ?? null,
    range_reversal_immediate_switch_applied: fields.range_reversal_immediate_switch_applied ?? false,
    range_reversal_immediate_switch_reason: fields.range_reversal_immediate_switch_reason ?? null,
    range_fresh_reentry_allowed: fields.range_fresh_reentry_allowed ?? false,
    range_fresh_reentry_blocked_reason: fields.range_fresh_reentry_blocked_reason ?? null,
    range_fresh_reentry_size_mult: fields.range_fresh_reentry_size_mult ?? null,
    range_reentry_wait_bypassed_no_open_position: fields.range_reentry_wait_bypassed_no_open_position ?? false,
    range_loss_streak_reduced_entry_applied: fields.range_loss_streak_reduced_entry_applied ?? false,
    range_loss_streak_reduced_entry_size_mult: fields.range_loss_streak_reduced_entry_size_mult ?? null,
    range_zone_action_policy: fields.range_zone_action_policy ?? null,
    range_zone_detected: fields.range_zone_detected ?? null,
    range_upper_short_priority_applied: fields.range_upper_short_priority_applied ?? false,
    range_lower_long_priority_applied: fields.range_lower_long_priority_applied ?? false,
    range_mid_wait_applied: fields.range_mid_wait_applied ?? false,
    range_final_trade_side_by_zone: fields.range_final_trade_side_by_zone ?? null,
    range_stage0_branch_proof: fields.range_stage0_branch_proof ?? null,
    legacy_block_reason: fields.legacy_block_reason ?? null,
    legacy_regime_gate: fields.legacy_regime_gate ?? null,
    legacy_gate_source: fields.legacy_gate_source ?? null,
    override_by_legacy: fields.override_by_legacy ?? false,
    stage1_block_origin: fields.stage1_block_origin ?? null,
    legacy_block_test_bypass_applied: fields.legacy_block_test_bypass_applied ?? false,
    legacy_block_test_bypass_reason: fields.legacy_block_test_bypass_reason ?? null,
    legacy_block_original_reason: fields.legacy_block_original_reason ?? null,
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
    probe_only_mode: fields.probe_only_mode,
    fee_drag_filter_applied: fields.fee_drag_filter_applied ?? false,
    fee_drag_size_reduced: fields.fee_drag_size_reduced ?? false,
    fee_drag_blocked: fields.fee_drag_blocked ?? false,
    fee_drag_reason: fields.fee_drag_reason ?? null,
    fee_drag_proof: fields.fee_drag_proof ?? null,
    range_executor_priority_applied: fields.range_executor_priority_applied,
    range_executor_priority_reason: fields.range_executor_priority_reason,
    final_executor_before_priority: fields.final_executor_before_priority,
    final_executor_after_priority: fields.final_executor_after_priority,
    final_reject_before_priority: fields.final_reject_before_priority,
    final_reject_after_priority: fields.final_reject_after_priority
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
  let trendVolumeRelaxProof: Record<string, unknown> | null = null;
  let guidanceOut: string | null = null;
  let workingSignal: PaperSignal = "none";
  let final_executor_before_priority: PaperStrategyExecutor = "IDLE";
  let final_reject_before_priority: string | null = null;
  let final_decision_before_priority: PaperFinalDecision = "SKIP";
  let final_executor_after_priority: PaperStrategyExecutor = "IDLE";
  let final_reject_after_priority: string | null = null;
  let final_decision_after_priority: PaperFinalDecision = "SKIP";
  let br: string | null = null;

  let fee_drag_filter_applied = false;
  let fee_drag_size_reduced = false;
  let fee_drag_blocked = false;
  let fee_drag_reason: string | null = null;
  let legacy_block_original_reason: string | null = null;
  let isRangeFallbackActive = false;
  let fee_drag_proof: Record<string, unknown> | null = null;
  let range_stage0_engine_taken = false;
  let range_stage0_exit_reason: string | null = null;
  let legacy_executor_path_taken = false;
  let required_move_pct: number | null = null;
  let shortfall_pct = 0;
  let stage1_leniency_applied = false;
  let range_cost_warning_applied = false;
  let range_cost_warning_threshold: number | null = null;
  let range_cost_warning_shortfall: number | null = null;
  let range_reentry_cooldown_applied = false;
  let range_reentry_wait_ms: number | null = null;
  let range_reentry_elapsed_ms: number | null = null;
  let range_reentry_remaining_ms: number | null = null;
  let range_reentry_source: string | null = null;
  let range_reentry_same_direction = false;
  let range_same_direction_reentry_relaxed_applied = false;
  let range_same_direction_reentry_wait_ms: number | null = null;
  let range_same_direction_reentry_size_mult: number | null = null;
  let range_same_direction_reentry_edge_ok = false;
  let range_same_direction_reentry_center_blocked = false;
  let range_same_direction_reentry_final_allowed = false;
  let range_risk_limit_temporarily_relaxed = false;
  let range_risk_limit_relax_reason: string | null = null;
  let range_risk_limit_relax_started_at: number | null = null;
  let range_risk_limit_relax_expires_at: number | null = null;
  let range_risk_limit_relax_active = false;
  let range_risk_limit_relax_expired = false;
  let range_soft_suspend_applied = false;
  let range_soft_suspend_size_mult: number | null = null;
  let range_soft_suspend_cooldown_ms: number | null = null;
  let range_soft_suspend_same_direction_restricted = false;
  let range_bidirectional_applied = false;
  let range_short_allowed = false;
  let range_short_allowed_reason: string | null = null;
  let range_upper_edge_near = false;
  let range_center_wait = false;
  let range_final_selected_side: "long" | "short" | "none" | null = null;
  let range_reversal_zone: "upper" | "lower" | "mid" | null = null;
  let range_reversal_short_eval_started = false;
  let range_reversal_long_exit_triggered = false;
  let range_reversal_short_entry_allowed = false;
  let range_reversal_short_entry_block_reason: string | null = null;
  let range_reversal_immediate_switch_applied = false;
  let range_reversal_immediate_switch_reason: string | null = null;
  let range_fresh_reentry_allowed = false;
  let range_fresh_reentry_blocked_reason: string | null = null;
  let range_fresh_reentry_size_mult: number | null = null;
  let range_reentry_wait_bypassed_no_open_position = false;
  let range_loss_streak_reduced_entry_applied = false;
  let range_loss_streak_reduced_entry_size_mult: number | null = null;
  let range_zone_action_policy: string | null = null;
  let range_zone_detected: "upper" | "lower" | "mid" | string | null = null;
  let range_upper_short_priority_applied = false;
  let range_lower_long_priority_applied = false;
  let range_mid_wait_applied = false;
  let range_final_trade_side_by_zone: string | null = null;
  let range_stage0_branch_proof: Record<string, unknown> | null = null;
  let legacy_block_reason: string | null = null;
  let legacy_regime_gate: string | null = null;
  let legacy_gate_source: string | null = null;
  let override_by_legacy = false;
  let stage1_block_origin: string | null = null;
  let legacy_block_test_bypass_applied = false;
  let legacy_block_test_bypass_reason: string | null = null;
  let reentry_cooldown_applied = false;
  let reentry_cooldown_original_ms: number | null = null;
  let reentry_cooldown_effective_ms: number | null = null;
  let reentry_cooldown_reason: string | null = null;

  // Working metrics and intermediate states
  let waitMs: number = 0;
  let elapsedMs: number = 0;
  let meta: any = null;
  let sameDirection: boolean = false;
  let reentryBlocked: boolean = false;
  let lowConfidence: boolean = false;
  let zone: "upper" | "lower" | "mid" | string = "mid";
  let boxPos: number = 0.5;
  let rangeSignal: any = null;
  let rangeScores: any = null;
  let lowConfidenceSignalMin: number = 0.34;
  let lowConfidenceEntryMin: number = 0.36;
  let edgeRelaxZoneForConfidence: boolean = false;
  let blockedRegimeActive: boolean = false;
  let blockedRegimeLossStreakSuspend: boolean = false;
  let freshReentryCandidate: boolean = false;
  let blockedRegime: any = null;
  let blockedRegimeReasonText: string = "";
  let edgeGateCurrent: any = null;
  let edgeStructureOkCurrent: boolean = false;
  let prioritySignalAligned: boolean = false;
  let noOpenPositionFreshEntry: boolean = false;
  let rangeRiskRelaxEligible: boolean = false;
  let riskEngineHardBlocked: boolean = false;
  let riskEngineBlockedBySuspendOnly: boolean = false;
  let riskEngineBlocked: boolean = false;
  let sameDirRelaxEligible: boolean = false;
  let stage1SignalRelaxed = false;
  let signalRelaxReason: string | null = null;
  let stage1SoftCandidateMicroEnter = false;
  let stage1CostSoftBypassApplied = false;
  let stage1CostSoftBypassReason: string | null = null;
  let effectiveTotalCost: number | null = null;
  let useFixedCost: boolean = false;
  let cooldowned: boolean = false;
  let cooldown_remaining_ms: number | null = null;
  let stage1ExploreSoftExec = false;
  let stage1HigherTfBypassSizeMult: number | null = null;
  let stage1RangeLowerEdgeSoftSizeMult: number | null = null;
  let stage1RangeEdgeSoftApplied = false;
  let range_executor_priority_applied = false;
  let range_executor_priority_reason: string | null = null;
  final_executor_before_priority = "IDLE";
  final_executor_after_priority = "IDLE";
  final_reject_before_priority = null;
  final_reject_after_priority = null;
  final_decision_before_priority = "SKIP";
  final_decision_after_priority = "SKIP";
  let risk_cooldown_subreason: string | null = null;
  let same_dir_cooldown_applied = false;
  let blocked_regime_reason: string | null = null;
  let reentry_wait_ms: number | null = null;
  let reentry_elapsed_ms: number | null = null;
  let blocked_regime_until_bypass_applied = false;
  let blocked_regime_until_bypass_reason: string | null = null;
  let blocked_regime_original_until_ms: number | null = null;
  let blocked_regime_original_reason: string | null = null;
  let range_long_only_short_deferred_applied = false;
  let range_long_only_short_deferred_bypassed = false;
  let stage1SoftExecOverrideFlag = false;
  let fixedUsd: number | null = null;
  let expectedMoveUsd: number | null = null;
  let requiredCostUsd: number | null = null;
  let shortfallUsd: number | null = null;
  let executorBlockReasonOriginal: string | null = null;
  let totalCost: number | null = null;

  const sn = input.snapshot;
  const rm = sn?.gateRequiredMove;
  const emFromSn = sn?.gateExpectedMove ?? null;
  em = emFromSn;

  let leniency = 1.0;
  if (input.currentStage === 0) {
    if (input.regime === "TREND") leniency *= 0.65;
    else if (input.regime === "RANGE") leniency *= 0.75;
    if (sym === "ETHUSDT") leniency *= 0.6;
  }

  stage1_leniency_applied = input.currentStage === 0 && leniency < 1.0;

  const refNotionalUsd = DEFAULT_PAPER_SIZE_USD;
  fixedUsd = input.config.paperFixedTotalCostUsd;
  useFixedCost = fixedUsd !== null && fixedUsd > 0;

  if (useFixedCost) {
    totalCost = (fixedUsd as number) / refNotionalUsd;
    requiredCostUsd = (fixedUsd as number) * leniency;
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

  required_move_pct = effectiveTotalCost !== null ? effectiveTotalCost * 100 : null;
  shortfall_pct = (effectiveTotalCost !== null && em !== null && effectiveTotalCost > em) ? (effectiveTotalCost - em) * 100 : 0;

  executorBlockReasonOriginal = null;
  stage1SoftExecOverrideFlag = false;

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
      entry_blocked?: string | null;
      range_stage0_engine_taken?: boolean;
      range_stage0_exit_reason?: string | null;
      legacy_executor_path_taken?: boolean;
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
      stage1_soft_exec_override_reason?: string | null;
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
      execution_disabled_top_proof?: Record<string, unknown> | null;
      trend_volume_relax_proof?: Record<string, unknown> | null;
      reentry_cooldown_applied?: boolean;
      reentry_cooldown_original_ms?: number | null;
      reentry_cooldown_effective_ms?: number | null;
      reentry_cooldown_reason?: string | null;
      risk_cooldown_subreason?: string | null;
      cooldown_remaining_ms?: number | null;
      same_dir_cooldown_applied?: boolean;
      blocked_regime_reason?: string | null;
      reentry_wait_ms?: number | null;
      reentry_elapsed_ms?: number | null;
      blocked_regime_until_bypass_applied?: boolean;
      blocked_regime_until_bypass_reason?: string | null;
      blocked_regime_original_until_ms?: number | null;
      blocked_regime_original_reason?: string | null;
      range_long_only_short_deferred_applied?: boolean;
      range_long_only_short_deferred_bypassed?: boolean;
      range_cost_warning_applied?: boolean;
      range_cost_warning_threshold?: number | null;
      range_cost_warning_shortfall?: number | null;
      range_reentry_cooldown_applied?: boolean;
      range_reentry_wait_ms?: number | null;
      range_reentry_elapsed_ms?: number | null;
      range_reentry_remaining_ms?: number | null;
      range_reentry_source?: string | null;
      range_reentry_same_direction?: boolean;
      range_same_direction_reentry_relaxed_applied?: boolean;
      range_same_direction_reentry_wait_ms?: number | null;
      range_same_direction_reentry_size_mult?: number | null;
      range_same_direction_reentry_edge_ok?: boolean;
      range_same_direction_reentry_center_blocked?: boolean;
      range_same_direction_reentry_final_allowed?: boolean;
      range_risk_limit_temporarily_relaxed?: boolean;
      range_risk_limit_relax_reason?: string | null;
      range_risk_limit_relax_started_at?: number | null;
      range_risk_limit_relax_expires_at?: number | null;
      range_risk_limit_relax_active?: boolean;
      range_risk_limit_relax_expired?: boolean;
      range_soft_suspend_applied?: boolean;
      range_soft_suspend_size_mult?: number | null;
      range_soft_suspend_cooldown_ms?: number | null;
      range_soft_suspend_same_direction_restricted?: boolean;
      range_bidirectional_applied?: boolean;
      range_short_allowed?: boolean;
      range_short_allowed_reason?: string | null;
      range_upper_edge_near?: boolean;
      range_center_wait?: boolean;
      range_final_selected_side?: "long" | "short" | "none" | null;
      range_reversal_zone?: "upper" | "lower" | "mid" | null;
      range_reversal_short_eval_started?: boolean;
      range_reversal_long_exit_triggered?: boolean;
      range_reversal_short_entry_allowed?: boolean;
      range_reversal_short_entry_block_reason?: string | null;
      range_reversal_immediate_switch_applied?: boolean;
      range_reversal_immediate_switch_reason?: string | null;
      range_fresh_reentry_allowed?: boolean;
      range_fresh_reentry_blocked_reason?: string | null;
      range_fresh_reentry_size_mult?: number | null;
      range_reentry_wait_bypassed_no_open_position?: boolean;
      range_loss_streak_reduced_entry_applied?: boolean;
      range_loss_streak_reduced_entry_size_mult?: number | null;
      range_zone_action_policy?: string | null;
      range_zone_detected?: "upper" | "lower" | "mid" | null;
      range_upper_short_priority_applied?: boolean;
      range_lower_long_priority_applied?: boolean;
      range_mid_wait_applied?: boolean;
      range_final_trade_side_by_zone?: string | null;
      range_stage0_branch_proof?: Record<string, unknown> | null;
      legacy_block_reason?: string | null;
      legacy_regime_gate?: string | null;
      legacy_gate_source?: string | null;
      override_by_legacy?: boolean;
      stage1_block_origin?: string | null;
      legacy_block_test_bypass_applied?: boolean;
      legacy_block_test_bypass_reason?: string | null;
      legacy_block_original_reason?: string | null;
      stage1_direction_override_applied?: boolean;
      stage1_direction_override_reason?: string | null;
      original_policy_direction?: string | null;
      final_policy_direction?: string | null;
      stage1_cost_soft_bypass_applied?: boolean;
      stage1_cost_soft_bypass_reason?: string | null;
      stage1_cost_shortfall_pct?: number | null;
      stage1_cost_shortfall_usd?: number | null;
      stage1_cost_micro_size_mult?: number | null;
      fee_drag_filter_applied?: boolean;
      fee_drag_size_reduced?: boolean;
      fee_drag_blocked?: boolean;
      fee_drag_reason?: string | null;
      fee_drag_proof?: Record<string, unknown> | null;
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
  ): EvaluatePaperSymbolEntryResult => {
    final_executor_before_priority = extra.strategy_executor ?? strategy_executor;
    final_reject_before_priority = extra.reject_reason !== undefined ? (extra.reject_reason ? String(extra.reject_reason) : null) : (reject_reason ? String(reject_reason) : null);
    final_decision_before_priority = extra.final_decision ?? final_decision;

    final_executor_after_priority = final_executor_before_priority;
    final_reject_after_priority = final_reject_before_priority;
    final_decision_after_priority = final_decision_before_priority;

    if (isRangeFallbackActive && final_decision_before_priority === "REJECT" && final_executor_before_priority === "TREND" && (extra.reject_reason === "EDGE_FAIL_FEE" || reject_reason === "EDGE_FAIL_FEE")) {
      final_executor_after_priority = "RANGE";
      final_reject_after_priority = null;
      final_decision_after_priority = "SKIP";
      range_executor_priority_applied = true;
      range_executor_priority_reason = "range_diag_context_override_trend_reject_fee";
    }

    return {
      decision: pack(input, sym, em, {
        signal_state: (extra.signal_state ?? signal_state) as any,
        regime_state: (extra.regime_state ?? regime_state) as any,
        edge_state: (extra.edge_state ?? edge_state) as any,
        risk_state: (extra.risk_state ?? risk_state) as any,
        execution_state: (extra.execution_state ?? execution_state) as any,
        final_decision: (final_decision_after_priority as any),
        reject_reason: (final_reject_after_priority as any),
        expected_move_pct: extra.expected_move_pct !== undefined ? extra.expected_move_pct : expected_move_pct,
        fee_estimate_pct: extra.fee_estimate_pct !== undefined ? extra.fee_estimate_pct : fee_estimate_pct,
        slippage_buffer_pct,
        safety_margin_pct,
        rr: extra.rr !== undefined ? extra.rr : rr,
        atr_pct: extra.atr_pct !== undefined ? extra.atr_pct : atr_pct,
        strategy_executor: final_executor_after_priority,
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
        supplemental_reasons: extra.supplemental_reasons ?? supplemental_reasons,
        is_ambiguous: extra.is_ambiguous ?? false,
        stage1_loosened_entry: extra.stage1_loosened_entry,
        ai_floor_relaxed: extra.ai_floor_relaxed,
        auto_entry_triggered: extra.auto_entry_triggered !== undefined ? extra.auto_entry_triggered : input.autoEntryTriggered,
        reviewing_ticks: extra.reviewing_ticks !== undefined ? extra.reviewing_ticks : input.reviewingTicks,
        stage1_result_code: extra.stage1_result_code,
        final_fail_reason: extra.final_fail_reason,
        entry_blocked: extra.entry_blocked ?? null,
        range_executor_priority_applied,
        range_executor_priority_reason,
        final_executor_before_priority,
        final_executor_after_priority,
        final_reject_before_priority: final_reject_before_priority ? String(final_reject_before_priority) : null,
        final_reject_after_priority: final_reject_after_priority ? String(final_reject_after_priority) : null,
        range_stage0_engine_taken: extra.range_stage0_engine_taken ?? range_stage0_engine_taken,
        range_stage0_exit_reason: extra.range_stage0_exit_reason ?? range_stage0_exit_reason,
        legacy_executor_path_taken: extra.legacy_executor_path_taken ?? legacy_executor_path_taken,
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
        execution_disabled_top_proof: extra.execution_disabled_top_proof,
        trend_volume_relax_proof:
          "trend_volume_relax_proof" in extra ? extra.trend_volume_relax_proof : trendVolumeRelaxProof,
        reentry_cooldown_applied: extra.reentry_cooldown_applied ?? reentry_cooldown_applied,
        reentry_cooldown_original_ms: extra.reentry_cooldown_original_ms ?? reentry_cooldown_original_ms,
        reentry_cooldown_effective_ms: extra.reentry_cooldown_effective_ms ?? reentry_cooldown_effective_ms,
        reentry_cooldown_reason: extra.reentry_cooldown_reason ?? reentry_cooldown_reason,
        risk_cooldown_subreason: extra.risk_cooldown_subreason ?? risk_cooldown_subreason,
        cooldown_remaining_ms: extra.cooldown_remaining_ms ?? cooldown_remaining_ms,
        same_dir_cooldown_applied: extra.same_dir_cooldown_applied ?? same_dir_cooldown_applied,
        blocked_regime_reason: extra.blocked_regime_reason ?? blocked_regime_reason,
        reentry_wait_ms: extra.reentry_wait_ms ?? reentry_wait_ms,
        reentry_elapsed_ms: extra.reentry_elapsed_ms ?? reentry_elapsed_ms,
        blocked_regime_until_bypass_applied:
          extra.blocked_regime_until_bypass_applied ?? blocked_regime_until_bypass_applied,
        blocked_regime_until_bypass_reason:
          extra.blocked_regime_until_bypass_reason ?? blocked_regime_until_bypass_reason,
        blocked_regime_original_until_ms:
          extra.blocked_regime_original_until_ms ?? blocked_regime_original_until_ms,
        blocked_regime_original_reason:
          extra.blocked_regime_original_reason ?? blocked_regime_original_reason,
        range_long_only_short_deferred_applied:
          extra.range_long_only_short_deferred_applied ?? range_long_only_short_deferred_applied,
        range_long_only_short_deferred_bypassed:
          extra.range_long_only_short_deferred_bypassed ?? range_long_only_short_deferred_bypassed,
        range_cost_warning_applied: extra.range_cost_warning_applied ?? range_cost_warning_applied,
        range_cost_warning_threshold: extra.range_cost_warning_threshold ?? range_cost_warning_threshold,
        range_cost_warning_shortfall: extra.range_cost_warning_shortfall ?? range_cost_warning_shortfall,
        range_reentry_cooldown_applied: extra.range_reentry_cooldown_applied ?? range_reentry_cooldown_applied,
        range_reentry_wait_ms: extra.range_reentry_wait_ms ?? range_reentry_wait_ms,
        range_reentry_elapsed_ms: extra.range_reentry_elapsed_ms ?? range_reentry_elapsed_ms,
        range_reentry_remaining_ms: extra.range_reentry_remaining_ms ?? range_reentry_remaining_ms,
        range_reentry_source: extra.range_reentry_source ?? range_reentry_source,
        range_reentry_same_direction: extra.range_reentry_same_direction ?? range_reentry_same_direction,
        range_same_direction_reentry_relaxed_applied:
          extra.range_same_direction_reentry_relaxed_applied ?? range_same_direction_reentry_relaxed_applied,
        range_same_direction_reentry_wait_ms:
          extra.range_same_direction_reentry_wait_ms ?? range_same_direction_reentry_wait_ms,
        range_same_direction_reentry_size_mult:
          extra.range_same_direction_reentry_size_mult ?? range_same_direction_reentry_size_mult,
        range_same_direction_reentry_edge_ok:
          extra.range_same_direction_reentry_edge_ok ?? range_same_direction_reentry_edge_ok,
        range_same_direction_reentry_center_blocked:
          extra.range_same_direction_reentry_center_blocked ?? range_same_direction_reentry_center_blocked,
        range_same_direction_reentry_final_allowed:
          extra.range_same_direction_reentry_final_allowed ?? range_same_direction_reentry_final_allowed,
        range_risk_limit_temporarily_relaxed:
          extra.range_risk_limit_temporarily_relaxed ?? range_risk_limit_temporarily_relaxed,
        range_risk_limit_relax_reason: extra.range_risk_limit_relax_reason ?? range_risk_limit_relax_reason,
        range_risk_limit_relax_started_at:
          extra.range_risk_limit_relax_started_at ?? range_risk_limit_relax_started_at,
        range_risk_limit_relax_expires_at:
          extra.range_risk_limit_relax_expires_at ?? range_risk_limit_relax_expires_at,
        range_risk_limit_relax_active: extra.range_risk_limit_relax_active ?? range_risk_limit_relax_active,
        range_risk_limit_relax_expired: extra.range_risk_limit_relax_expired ?? range_risk_limit_relax_expired,
        range_soft_suspend_applied: extra.range_soft_suspend_applied ?? range_soft_suspend_applied,
        range_soft_suspend_size_mult: extra.range_soft_suspend_size_mult ?? range_soft_suspend_size_mult,
        range_soft_suspend_cooldown_ms: extra.range_soft_suspend_cooldown_ms ?? range_soft_suspend_cooldown_ms,
        range_soft_suspend_same_direction_restricted:
          extra.range_soft_suspend_same_direction_restricted ?? range_soft_suspend_same_direction_restricted,
        range_bidirectional_applied: extra.range_bidirectional_applied ?? range_bidirectional_applied,
        range_short_allowed: extra.range_short_allowed ?? range_short_allowed,
        range_short_allowed_reason: extra.range_short_allowed_reason ?? range_short_allowed_reason,
        range_upper_edge_near: extra.range_upper_edge_near ?? range_upper_edge_near,
        range_center_wait: extra.range_center_wait ?? range_center_wait,
        range_final_selected_side: extra.range_final_selected_side ?? range_final_selected_side,
        range_reversal_zone: extra.range_reversal_zone ?? range_reversal_zone,
        range_reversal_short_eval_started: extra.range_reversal_short_eval_started ?? range_reversal_short_eval_started,
        range_reversal_long_exit_triggered: extra.range_reversal_long_exit_triggered ?? range_reversal_long_exit_triggered,
        range_reversal_short_entry_allowed: extra.range_reversal_short_entry_allowed ?? range_reversal_short_entry_allowed,
        range_reversal_short_entry_block_reason:
          extra.range_reversal_short_entry_block_reason ?? range_reversal_short_entry_block_reason,
        range_reversal_immediate_switch_applied:
          extra.range_reversal_immediate_switch_applied ?? range_reversal_immediate_switch_applied,
        range_reversal_immediate_switch_reason:
          extra.range_reversal_immediate_switch_reason ?? range_reversal_immediate_switch_reason,
        range_fresh_reentry_allowed: extra.range_fresh_reentry_allowed ?? range_fresh_reentry_allowed,
        range_fresh_reentry_blocked_reason: extra.range_fresh_reentry_blocked_reason ?? range_fresh_reentry_blocked_reason,
        range_fresh_reentry_size_mult: extra.range_fresh_reentry_size_mult ?? range_fresh_reentry_size_mult,
        range_reentry_wait_bypassed_no_open_position:
          extra.range_reentry_wait_bypassed_no_open_position ?? range_reentry_wait_bypassed_no_open_position,
        range_loss_streak_reduced_entry_applied:
          extra.range_loss_streak_reduced_entry_applied ?? range_loss_streak_reduced_entry_applied,
        range_loss_streak_reduced_entry_size_mult:
          extra.range_loss_streak_reduced_entry_size_mult ?? range_loss_streak_reduced_entry_size_mult,
        range_zone_action_policy: extra.range_zone_action_policy ?? range_zone_action_policy,
        range_zone_detected: (extra.range_zone_detected ?? range_zone_detected) as any,
        range_upper_short_priority_applied: extra.range_upper_short_priority_applied ?? range_upper_short_priority_applied,
        range_lower_long_priority_applied: extra.range_lower_long_priority_applied ?? range_lower_long_priority_applied,
        range_mid_wait_applied: extra.range_mid_wait_applied ?? range_mid_wait_applied,
        range_final_trade_side_by_zone: extra.range_final_trade_side_by_zone ?? range_final_trade_side_by_zone,
        range_stage0_branch_proof:
          "range_stage0_branch_proof" in extra ? extra.range_stage0_branch_proof : range_stage0_branch_proof,
        legacy_block_reason: extra.legacy_block_reason ?? legacy_block_reason,
        legacy_regime_gate: extra.legacy_regime_gate ?? legacy_regime_gate,
        legacy_gate_source: extra.legacy_gate_source ?? legacy_gate_source,
        override_by_legacy: extra.override_by_legacy ?? override_by_legacy,
        stage1_block_origin: extra.stage1_block_origin ?? stage1_block_origin,
        legacy_block_test_bypass_applied: extra.legacy_block_test_bypass_applied ?? legacy_block_test_bypass_applied,
        legacy_block_test_bypass_reason: extra.legacy_block_test_bypass_reason ?? legacy_block_test_bypass_reason,
        legacy_block_original_reason: extra.legacy_block_original_reason ?? legacy_block_original_reason,
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
        probe_only_mode: extra.probe_only_mode !== undefined ? extra.probe_only_mode : res.executorDecision?.probeOnlyMode,
        fee_drag_filter_applied: extra.fee_drag_filter_applied ?? fee_drag_filter_applied,
        fee_drag_size_reduced: extra.fee_drag_size_reduced ?? fee_drag_size_reduced,
        fee_drag_blocked: extra.fee_drag_blocked ?? fee_drag_blocked,
        fee_drag_reason: extra.fee_drag_reason !== undefined ? extra.fee_drag_reason : fee_drag_reason,
        fee_drag_proof: extra.fee_drag_proof !== undefined ? extra.fee_drag_proof : fee_drag_proof
      }),
      ...res
    };
  };

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
  intentSide = (sn.signal === "paper_long_candidate") ? "long" : (sn.signal === "paper_short_candidate" ? "short" : "none") as any;
  workingSignal = sn.signal as any;

  const contextRangeDiag = sn.regimeStateDiag === "RANGE";
  const hasRangeContextMetrics = (sn.rangeConfidence ?? 0) >= 0.3 && (sn.boxCohesion01 ?? 0) >= 0.25;
  isRangeFallbackActive = contextRangeDiag && hasRangeContextMetrics && input.regime !== "NO_TRADE";

  const useRangeStage0Engine = (input.regime === "RANGE" || isRangeFallbackActive) && input.currentStage === 0;
  if (useRangeStage0Engine) {
    if (isRangeFallbackActive && input.regime !== "RANGE") {
      supplemental_reasons.push(`[RANGE_PRIORITY_FALLBACK] regime=${input.regime},diag=${sn.regimeStateDiag},conf=${sn.rangeConfidence}`);
    }
    range_stage0_engine_taken = true;
    strategy_executor = "RANGE";
    const rangeSignal = evaluateRangeStage0Signal(sn, input.rangeReversalImmediateSwitch);
    const rangeScores = evaluateRangeStage0Scores(sn);
    const blockedRegime = input.risk?.blockedRegimes?.[input.regime];
    const blockedRegimeActive = !!(blockedRegime && blockedRegime.until > input.now);
    const blockedRegimeReasonText = String(blockedRegime?.reason ?? "");
    const blockedRegimeLossStreakSuspend =
      blockedRegimeReasonText.includes("mode_loss_streak") || blockedRegimeReasonText.includes("highway_range_streak");
    const rangeRiskRelaxEligible = input.regime === "RANGE" && blockedRegimeLossStreakSuspend;
    range_risk_limit_temporarily_relaxed = rangeRiskRelaxEligible;
    if (rangeRiskRelaxEligible) {
      range_risk_limit_relax_reason = RANGE_RISK_LIMIT_RELAX_REASON;
      range_risk_limit_relax_started_at = RANGE_RISK_LIMIT_RELAX_STARTED_AT;
      range_risk_limit_relax_expires_at = RANGE_RISK_LIMIT_RELAX_EXPIRES_AT;
      range_risk_limit_relax_active = input.now < (RANGE_RISK_LIMIT_RELAX_EXPIRES_AT as number);
      range_risk_limit_relax_expired = !range_risk_limit_relax_active;
    }
    const riskEngineHardBlocked = input.risk?.crashState !== undefined && input.risk.crashState !== "NONE";
    const riskEngineBlockedBySuspendOnly =
      input.risk?.engineBlocked === true &&
      blockedRegimeActive &&
      blockedRegimeLossStreakSuspend &&
      range_risk_limit_relax_active;
    const riskEngineBlocked = riskEngineHardBlocked || (input.risk?.engineBlocked === true && !riskEngineBlockedBySuspendOnly);
    const RANGE_SOFT_SUSPEND_SIZE_MULT = 0.35;
    const RANGE_SOFT_SUSPEND_COOLDOWN_MS = 45_000;
    const boxPos = typeof sn.boxPos === "number" ? sn.boxPos : 0.5;
    const zone = classifyBoxZone(boxPos);
    const edgeGateCurrent = rangeStage0EdgeStructureGate(sn);
    const edgeStructureOkCurrent = edgeGateCurrent.ok;
    const prioritySignalAligned =
      (zone === "upper" && rangeSignal.side === "short") || (zone === "lower" && rangeSignal.side === "long");
    const noOpenPositionFreshEntry = !input.hasOpenPosition && input.openPositionsTotal === 0;
    const freshReentryCandidate =
      noOpenPositionFreshEntry &&
      prioritySignalAligned &&
      edgeStructureOkCurrent &&
      rangeSignal.signal !== "RANGE_SIGNAL_NONE";
    const RANGE_FRESH_REENTRY_SIZE_MULT = 0.42;
    if (freshReentryCandidate) {
      range_fresh_reentry_allowed = true;
      range_fresh_reentry_size_mult = RANGE_FRESH_REENTRY_SIZE_MULT;
      range_fresh_reentry_blocked_reason = null;
    } else {
      range_fresh_reentry_blocked_reason =
        input.hasOpenPosition
          ? "has_open_this_symbol"
          : input.openPositionsTotal > 0
            ? "open_positions_total_not_zero"
            : zone === "mid"
              ? "range_mid_wait_no_directional_chase"
              : !prioritySignalAligned
                ? "priority_signal_not_aligned"
                : !edgeStructureOkCurrent
                  ? "edge_structure_not_ok"
                  : rangeSignal.signal === "RANGE_SIGNAL_NONE"
                    ? "range_signal_none"
                    : "fresh_reentry_not_eligible";
    }
    range_zone_action_policy = RANGE_ZONE_ACTION_POLICY;
    range_zone_detected = zone;
    range_mid_wait_applied = zone === "mid";
    range_upper_edge_near = zone === "upper";
    range_center_wait = zone === "mid";
    range_reversal_zone = zone;
    range_reversal_short_eval_started = zone === "upper";
    range_reversal_long_exit_triggered = zone === "upper" && input.openPositionSide === "long";
    const rangeLowerEdge = zone === "lower";
    const rangeExitRiskOk = (sn.regimeExitRisk ?? 0) <= 0.62;
    const rangeConfidenceOk = (sn.rangeConfidence ?? 0) >= 0.45;
    const rangeBreakoutFailureOk = (sn.breakoutFailureRate ?? 0) >= 0.42;
    const rangeSameDirBaseEligible = rangeConfidenceOk && rangeBreakoutFailureOk && rangeExitRiskOk;
    const rangeReversalSwitchMatches =
      input.rangeReversalImmediateSwitch != null &&
      rangeSignal.side === input.rangeReversalImmediateSwitch.preferredSide &&
      ((input.rangeReversalImmediateSwitch.preferredSide === "short" && zone === "upper") ||
        (input.rangeReversalImmediateSwitch.preferredSide === "long" && zone === "lower"));
    range_short_allowed =
      rangeSignal.side === "short" &&
      range_upper_edge_near &&
      !range_center_wait &&
      !rangeLowerEdge &&
      (rangeReversalSwitchMatches ||
        (rangeConfidenceOk && rangeBreakoutFailureOk && rangeExitRiskOk));
    if (rangeSignal.side === "short") {
      if (range_center_wait) range_short_allowed_reason = "range_center_wait";
      else if (rangeLowerEdge) range_short_allowed_reason = "range_lower_zone_short_forbidden";
      else if (!range_upper_edge_near) range_short_allowed_reason = "range_upper_edge_not_near";
      else if (!rangeConfidenceOk) range_short_allowed_reason = "range_confidence_low";
      else if (!rangeBreakoutFailureOk) range_short_allowed_reason = "range_breakout_failure_low";
      else if (!rangeExitRiskOk && !rangeReversalSwitchMatches) range_short_allowed_reason = "range_exit_risk_high";
      else if (rangeReversalSwitchMatches) range_short_allowed_reason = "range_reversal_immediate_short_after_upper_flatten";
      else range_short_allowed_reason = "range_short_allowed_upper_edge";
    } else if (rangeSignal.side === "long") {
      range_short_allowed_reason = range_center_wait ? "range_center_wait" : "range_long_path";
    }
    range_reversal_short_entry_allowed = range_short_allowed;
    range_reversal_short_entry_block_reason = range_short_allowed ? null : range_short_allowed_reason;
    const edgeRelaxZoneForConfidence =
      (zone === "upper" && boxPos >= 0.74 && rangeSignal.side === "short") ||
      (zone === "lower" && boxPos <= 0.26 && rangeSignal.side === "long");
    const lowConfidenceSignalMin = edgeRelaxZoneForConfidence ? 0.31 : 0.34;
    const lowConfidenceEntryMin = edgeRelaxZoneForConfidence ? 0.33 : 0.36;
    const lowConfidence = rangeScores.rangeSignalScore < lowConfidenceSignalMin || rangeScores.rangeEntryScore < lowConfidenceEntryMin;
    let reentryBlocked = false;
    range_reentry_wait_ms = null;
    range_reentry_elapsed_ms = null;
    range_reentry_remaining_ms = null;
    range_reentry_same_direction = false;
    range_reentry_source = "range_stage0_reentry";
    if (input.lastCloseMetaBySymbol && rangeSignal.side) {
      const meta = input.lastCloseMetaBySymbol.get(String(sym));
      const sameDirection = meta !== undefined && meta.side === rangeSignal.side;
      const waitMsBase = sameDirection ? input.reentryCooldownMs * input.sameDirCooldownMult : input.reentryCooldownMs;
      let waitMs = Math.min(waitMsBase, 95_000);
      const elapsedMs = input.now - (meta?.closedAt ?? 0);
      range_reentry_same_direction = sameDirection;
      range_same_direction_reentry_center_blocked = range_center_wait;
      const rangeEdgeOkForSameDir =
        rangeSignal.side === "long"
          ? boxPos <= 0.38
          : rangeSignal.side === "short"
            ? boxPos >= 0.62
            : false;
      range_same_direction_reentry_edge_ok = rangeEdgeOkForSameDir;
      const sameDirRelaxEligible =
        sameDirection &&
        !range_center_wait &&
        rangeEdgeOkForSameDir &&
        rangeSameDirBaseEligible;
      if (sameDirRelaxEligible) {
        const relaxedWaitMs = Math.min(45_000, Math.max(20_000, Math.floor(waitMs * 0.35)));
        waitMs = relaxedWaitMs;
        range_same_direction_reentry_relaxed_applied = true;
        range_same_direction_reentry_wait_ms = relaxedWaitMs;
        range_same_direction_reentry_size_mult = 0.5;
      } else if (sameDirection) {
        range_same_direction_reentry_wait_ms = waitMs;
      }
      if (blockedRegimeActive && blockedRegimeLossStreakSuspend) {
        if (freshReentryCandidate) {
          range_loss_streak_reduced_entry_applied = true;
          range_loss_streak_reduced_entry_size_mult = RANGE_FRESH_REENTRY_SIZE_MULT;
          range_soft_suspend_applied = false;
          range_soft_suspend_size_mult = null;
          range_soft_suspend_cooldown_ms = null;
          range_soft_suspend_same_direction_restricted = false;
        } else {
          range_soft_suspend_applied = true;
          range_soft_suspend_size_mult = RANGE_SOFT_SUSPEND_SIZE_MULT;
          range_soft_suspend_cooldown_ms = RANGE_SOFT_SUSPEND_COOLDOWN_MS;
          range_soft_suspend_same_direction_restricted = sameDirection;
          waitMs = sameDirection ? RANGE_SOFT_SUSPEND_COOLDOWN_MS : 0;
        }
      }
      if (sameDirection && freshReentryCandidate) {
        waitMs = 0;
        range_reentry_wait_bypassed_no_open_position = true;
        range_reentry_source = "range_fresh_reentry_no_open_position";
      }
    }
    range_reentry_wait_ms = waitMs;
    range_reentry_elapsed_ms = elapsedMs;
    range_reentry_remaining_ms = (meta?.closedAt ?? 0) > 0 && elapsedMs < waitMs ? waitMs - elapsedMs : 0;
    if ((meta?.closedAt ?? 0) > 0 && elapsedMs < waitMs) reentryBlocked = true;
    range_same_direction_reentry_final_allowed =
      sameDirection && (meta?.closedAt ?? 0) > 0 ? elapsedMs >= waitMs : true;

    if (rangeReversalSwitchMatches) {
      reentryBlocked = false;
      range_reentry_remaining_ms = 0;
      range_reentry_wait_ms = 0;
      range_same_direction_reentry_final_allowed = true;
      supplemental_reasons.push("RANGE_REVERSAL_IMMEDIATE_REENTRY_BYPASS");
    }
    let gateResult: RangeGateResult = "RANGE_GATE_PASS";
    let gateReason = "range_gate_pass";
    if (rangeSignal.signal === "RANGE_SIGNAL_NONE") {
      gateResult = "RANGE_GATE_BLOCK_LOW_CONFIDENCE";
      gateReason = rangeSignal.reason;
    } else if (
      riskEngineBlocked ||
      (blockedRegimeActive &&
        (!blockedRegimeLossStreakSuspend || !range_risk_limit_relax_active) &&
        !(freshReentryCandidate && blockedRegimeLossStreakSuspend))
    ) {
      gateResult = "RANGE_GATE_BLOCK_RISK_ENGINE";
      gateReason = blockedRegimeLossStreakSuspend ? "mode_loss_streak_soft_suspended" : (blockedRegime?.reason ?? "risk_engine_block");
    } else if (reentryBlocked) {
      gateResult = "RANGE_GATE_BLOCK_REENTRY";
      gateReason = blockedRegimeLossStreakSuspend
        ? "range_reentry_cooldown_active_soft_suspend_same_direction"
        : "range_reentry_cooldown_active";
    } else if (lowConfidence && !rangeReversalSwitchMatches) {
      gateResult = "RANGE_GATE_BLOCK_LOW_CONFIDENCE";
      gateReason = "range_score_below_threshold";
    }
    const entryResult: RangeEntryResult =
      gateResult !== "RANGE_GATE_PASS"
        ? "RANGE_ENTRY_NONE"
        : rangeSignal.signal === "RANGE_LONG_CANDIDATE"
          ? "RANGE_LONG_ENTRY"
          : "RANGE_SHORT_ENTRY";
    range_final_selected_side = entryResult === "RANGE_LONG_ENTRY" ? "long" : entryResult === "RANGE_SHORT_ENTRY" ? "short" : "none";
    range_upper_short_priority_applied = zone === "upper" && entryResult === "RANGE_SHORT_ENTRY";
    range_lower_long_priority_applied = zone === "lower" && entryResult === "RANGE_LONG_ENTRY";
    range_final_trade_side_by_zone =
      zone === "upper"
        ? `upper:${entryResult === "RANGE_SHORT_ENTRY" ? "short" : "none"}`
        : zone === "lower"
          ? `lower:${entryResult === "RANGE_LONG_ENTRY" ? "long" : "none"}`
          : `mid:wait`;
    if (zone === "upper" && sn.signal === "paper_long_candidate") {
      range_stage0_branch_proof = buildRangeUpperLongSuppressBranchProof({
        edge: rangeStage0EdgeStructureGate(sn),
        rangeSignal,
        rawSnapshotSignal: sn.signal,
        sn,
        boxPos,
        zone,
        reversalImmediate: input.rangeReversalImmediateSwitch,
        gateResult,
        gateReason,
        entryResult,
        range_upper_short_priority_applied,
        lowConfidence,
        rangeReversalSwitchMatches
      });
    }
    if (gateResult === "RANGE_GATE_PASS" && rangeReversalSwitchMatches) {
      range_reversal_immediate_switch_applied = true;
      range_reversal_immediate_switch_reason = input.rangeReversalImmediateSwitch?.reason ?? null;
    }
    workingSignal = (entryResult === "RANGE_LONG_ENTRY"
      ? "paper_long_candidate"
      : entryResult === "RANGE_SHORT_ENTRY"
        ? "paper_short_candidate"
        : "none") as any;
    signal_state = signalToState(workingSignal);
    intentSide = (entryResult === "RANGE_LONG_ENTRY" ? "long" : entryResult === "RANGE_SHORT_ENTRY" ? "short" : null) as "long" | "short" | null;
    executorDecision = {
      entry_allowed: gateResult === "RANGE_GATE_PASS",
      blocked_reason: gateResult === "RANGE_GATE_PASS" ? null : gateResult,
      expected_move: typeof em === "number" ? em : null,
      total_cost: totalCost,
      risk_state: (input.risk?.riskStatus ?? "NORMAL") as any,
      regime: "RANGE",
      executor: "RANGE",
      box_position: boxPos <= 0.34 ? "lower" : boxPos >= 0.66 ? "upper" : "middle",
      entryIntentType: entryResult === "RANGE_ENTRY_NONE" ? "probe" : "standard",
      detail: {
        range_signal: rangeSignal.signal,
        range_signal_reason: rangeSignal.reason,
        range_signal_score: rangeScores.rangeSignalScore,
        range_entry_score: rangeScores.rangeEntryScore,
        range_score_reason: rangeScores.reason,
        range_low_conf_signal_min: lowConfidenceSignalMin,
        range_low_conf_entry_min: lowConfidenceEntryMin,
        range_low_conf_edge_relaxed: edgeRelaxZoneForConfidence,
        range_gate_result: gateResult,
        range_gate_reason: gateReason,
        final_entry_reason: entryResult,
        range_zone_detected: zone,
        range_zone_action_policy: RANGE_ZONE_ACTION_POLICY,
        ...(range_stage0_branch_proof && zone === "upper" && sn.signal === "paper_long_candidate"
          ? {
            range_upper_edge_structure_ok: (range_stage0_branch_proof as { edge_structure_ok?: boolean }).edge_structure_ok,
            range_upper_edge_structure_failed_checks: (range_stage0_branch_proof as { edge_structure_failed_checks?: string[] })
              .edge_structure_failed_checks,
            range_upper_edge_structure_one_liner: (range_stage0_branch_proof as { one_line_summary?: string }).one_line_summary
          }
          : {}),
        ...(range_stage0_branch_proof ? { range_stage0_branch_proof } : {})
      }
    };
    supplemental_reasons.push(rangeSignal.signal);
    supplemental_reasons.push(gateResult);
    supplemental_reasons.push(entryResult);
    if (gateResult !== "RANGE_GATE_PASS") {
      const rangeFinalBlockReason =
        gateResult === "RANGE_GATE_BLOCK_LOW_CONFIDENCE" && rangeSignal.signal === "RANGE_SIGNAL_NONE"
          ? "RANGE_SIGNAL_NONE"
          : gateResult === "RANGE_GATE_BLOCK_RISK_ENGINE"
            ? "RANGE_RISK_BLOCK_ENGINE"
            : gateResult === "RANGE_GATE_BLOCK_REENTRY"
              ? "RANGE_RISK_BLOCK_REENTRY"
              : gateResult;
      const stage1Code =
        gateResult === "RANGE_GATE_BLOCK_REENTRY" || gateResult === "RANGE_GATE_BLOCK_RISK_ENGINE"
          ? "STAGE1_BLOCKED_RISK"
          : gateResult === "RANGE_GATE_BLOCK_LOW_CONFIDENCE" && rangeSignal.signal === "RANGE_SIGNAL_NONE"
            ? "STAGE1_BLOCKED_SIGNAL"
            : "STAGE1_BLOCKED_EDGE";
      const blockedRegimeIsLossStreak =
        blockedRegimeReasonText.includes("mode_loss_streak") || blockedRegimeReasonText.includes("highway_range_streak");
      const rangeRiskSubreason =
        gateResult === "RANGE_GATE_BLOCK_REENTRY"
          ? (range_reentry_same_direction ? "range_reentry_same_direction_wait_active" : "range_reentry_wait_active")
          : gateResult === "RANGE_GATE_BLOCK_RISK_ENGINE"
            ? blockedRegimeActive
              ? (blockedRegimeIsLossStreak ? "range_blocked_regime_loss_streak_suspend" : "range_blocked_regime_until_active")
              : "range_risk_unknown"
            : null;
      const rangeCooldownRemainingMs =
        gateResult === "RANGE_GATE_BLOCK_REENTRY"
          ? (range_reentry_remaining_ms ?? 0)
          : gateResult === "RANGE_GATE_BLOCK_RISK_ENGINE" && blockedRegimeActive
            ? Math.max(0, (blockedRegime?.until ?? input.now) - input.now)
            : 0;
      const rangeReentryWaitMsOut = range_reentry_wait_ms ?? 0;
      const rangeReentryElapsedMsOut = range_reentry_elapsed_ms ?? 0;
      const rangeReentryRemainingMsOut = range_reentry_remaining_ms ?? 0;
      const rangeReentrySourceOut =
        gateResult === "RANGE_GATE_BLOCK_REENTRY"
          ? range_reentry_source
          : gateResult === "RANGE_GATE_BLOCK_RISK_ENGINE" && blockedRegimeActive
            ? "range_blocked_regime"
            : "range_risk_engine";
      if (rangeFinalBlockReason === "RANGE_RISK_BLOCK_REENTRY") {
        console.log("[RANGE_REENTRY_VALUE_PROOF]", {
          symbol: String(sym),
          risk_cooldown_subreason: rangeRiskSubreason,
          cooldown_remaining_ms: rangeCooldownRemainingMs,
          reentry_wait_ms: rangeReentryWaitMsOut,
          reentry_elapsed_ms: rangeReentryElapsedMsOut,
          range_reentry_wait_ms: rangeReentryWaitMsOut,
          range_reentry_elapsed_ms: rangeReentryElapsedMsOut,
          range_reentry_remaining_ms: rangeReentryRemainingMsOut,
          range_reentry_source: rangeReentrySourceOut,
          range_reentry_same_direction: range_reentry_same_direction
        });
      }
      return ret(
        {
          strategy_executor: "RANGE",
          final_decision: "SKIP",
          reject_reason: gateResult === "RANGE_GATE_BLOCK_REENTRY" ? "RISK_FAIL_REENTRY" : gateResult === "RANGE_GATE_BLOCK_RISK_ENGINE" ? "RISK_COOLDOWN" : "EDGE_FAIL_EXPECTANCY",
          stage1_result_code: stage1Code as any,
          entry_blocked: rangeFinalBlockReason,
          range_stage0_engine_taken: true,
          range_stage0_exit_reason: rangeFinalBlockReason,
          legacy_executor_path_taken: false,
          risk_cooldown_subreason: rangeRiskSubreason,
          cooldown_remaining_ms: rangeCooldownRemainingMs,
          range_reentry_cooldown_applied: gateResult === "RANGE_GATE_BLOCK_REENTRY",
          range_reentry_wait_ms: rangeReentryWaitMsOut,
          range_reentry_elapsed_ms: rangeReentryElapsedMsOut,
          range_reentry_remaining_ms: rangeReentryRemainingMsOut,
          range_reentry_source: rangeReentrySourceOut,
          range_reentry_same_direction: range_reentry_same_direction,
          range_same_direction_reentry_relaxed_applied: range_same_direction_reentry_relaxed_applied,
          range_same_direction_reentry_wait_ms: range_same_direction_reentry_wait_ms,
          range_same_direction_reentry_size_mult: range_same_direction_reentry_size_mult,
          range_same_direction_reentry_edge_ok: range_same_direction_reentry_edge_ok,
          range_same_direction_reentry_center_blocked: range_same_direction_reentry_center_blocked,
          range_same_direction_reentry_final_allowed: range_same_direction_reentry_final_allowed,
          range_risk_limit_temporarily_relaxed: range_risk_limit_temporarily_relaxed,
          range_risk_limit_relax_reason: range_risk_limit_relax_reason,
          range_risk_limit_relax_started_at: range_risk_limit_relax_started_at,
          range_risk_limit_relax_expires_at: range_risk_limit_relax_expires_at,
          range_risk_limit_relax_active: range_risk_limit_relax_active,
          range_risk_limit_relax_expired: range_risk_limit_relax_expired,
          range_soft_suspend_applied: range_soft_suspend_applied,
          range_soft_suspend_size_mult: range_soft_suspend_size_mult,
          range_soft_suspend_cooldown_ms: range_soft_suspend_cooldown_ms,
          range_soft_suspend_same_direction_restricted: range_soft_suspend_same_direction_restricted,
          range_reversal_zone: range_reversal_zone,
          range_reversal_short_eval_started: range_reversal_short_eval_started,
          range_reversal_long_exit_triggered: range_reversal_long_exit_triggered,
          range_reversal_short_entry_allowed: range_reversal_short_entry_allowed,
          range_reversal_short_entry_block_reason: range_reversal_short_entry_block_reason,
          range_reversal_immediate_switch_applied: range_reversal_immediate_switch_applied,
          range_reversal_immediate_switch_reason: range_reversal_immediate_switch_reason,
          range_zone_action_policy: range_zone_action_policy,
          range_zone_detected: range_zone_detected as any,
          range_upper_short_priority_applied: range_upper_short_priority_applied,
          range_lower_long_priority_applied: range_lower_long_priority_applied,
          range_mid_wait_applied: range_mid_wait_applied,
          range_final_trade_side_by_zone: range_final_trade_side_by_zone,
          reentry_wait_ms: rangeReentryWaitMsOut,
          reentry_elapsed_ms: rangeReentryElapsedMsOut,
          guidance: gateReason,
          required_move_pct,
          shortfall_pct,
          supplemental_reasons,
          final_fail_reason: rangeFinalBlockReason
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
  }

  // Initial core detection and scoring
  // Use an effective scoring regime so stage0 UNKNOWN/ambiguous contexts can still exercise RANGE-stage0 scoring.
  const scoringRegime: "TREND" | "RANGE" | "NO_TRADE" =
    input.currentStage === 0 && (input.regime === "RANGE" || (regime_state === "UNKNOWN" && input.isAmbiguous))
      ? "RANGE"
      : (input.regime as "TREND" | "RANGE" | "NO_TRADE");
  const rangeStage0ContextExpected = scoringRegime === "RANGE" && input.currentStage === 0;

  const _aiResult = evaluateAiHighwayQuality(input.snapshot?.candles ?? [], sym, {
    regime: scoringRegime,
    currentStage: input.currentStage,
    boxPos: sn?.boxPos,
    emaGap: sn?.emaGap,
    volumeRatioProxy: sn?.volumeRatioProxy,
    rangeConfidence: sn?.rangeConfidence,
    boxCohesion01: sn?.boxCohesion01,
    breakoutFailureRate: sn?.breakoutFailureRate,
    rangeOscillationScore: sn?.rangeOscillationScore,
    trendWeaknessScore: sn?.trendWeaknessScore,
    snapshotRecentCandlesCount: sn?.recentCandlesCount ?? null,
    klineLimitRequested: sn?.highwayKlineLimitRequested ?? null,
    entryTimeframe: sn?.highwayEntryTf ?? "1m"
  });
  supplemental_reasons.push(`AI_SCORE_CONTEXT_REGIME_${scoringRegime}`);
  supplemental_reasons.push(`AI_SCORE_CONTEXT_STAGE_${String(input.currentStage)}`);
  supplemental_reasons.push(`AI_SCORE_CONTEXT_RANGE_STAGE0_EXPECTED_${rangeStage0ContextExpected ? "Y" : "N"}`);
  supplemental_reasons.push(`AI_SCORE_CONTEXT_RANGE_STAGE0_APPLIED_${_aiResult.rangeStage0ScoringApplied ? "Y" : "N"}`);

  if (!useRangeStage0Engine) {
    let aiForHighway = _aiResult;
    let skipHighwayExecutorCall = false;
    const trendBoxEdgeBufferEligible =
      input.regime === "TREND" &&
      input.currentStage === 0 &&
      typeof sn.boxPos === "number" &&
      !_aiResult.rangeStage0ScoringApplied &&
      _aiResult.state === HighwayTrendState.INVALID &&
      _aiResult.invalidTier === "hard_invalid";
    if (trendBoxEdgeBufferEligible) {
      const z = classifyBoxZone(sn.boxPos);
      const atBoxEdge = z === "upper" || z === "lower";
      if (atBoxEdge) {
        const rangeRescore = evaluateAiHighwayQuality(input.snapshot?.candles ?? [], sym, {
          regime: "RANGE",
          currentStage: 0,
          boxPos: sn.boxPos,
          emaGap: sn.emaGap,
          volumeRatioProxy: sn.volumeRatioProxy,
          rangeConfidence: sn.rangeConfidence,
          boxCohesion01: sn.boxCohesion01,
          breakoutFailureRate: sn.breakoutFailureRate,
          rangeOscillationScore: sn.rangeOscillationScore,
          trendWeaknessScore: sn.trendWeaknessScore,
          snapshotRecentCandlesCount: sn.recentCandlesCount ?? null,
          klineLimitRequested: sn.highwayKlineLimitRequested ?? null,
          entryTimeframe: sn.highwayEntryTf ?? "1m"
        });
        supplemental_reasons.push("HIGHWAY_TREND_BOX_EDGE_RANGE_RESCORE");
        const rangeStillHardInvalid =
          rangeRescore.state === HighwayTrendState.INVALID && rangeRescore.invalidTier === "hard_invalid";
        const rangeEscapesHardInvalid = !rangeStillHardInvalid;
        if (rangeEscapesHardInvalid) {
          aiForHighway = rangeRescore;
          supplemental_reasons.push("HIGHWAY_TREND_BOX_EDGE_RANGE_FALLBACK_APPLIED");
        } else if (rangeRescore.highwayValidityScore > _aiResult.highwayValidityScore + 0.03) {
          aiForHighway = rangeRescore;
          supplemental_reasons.push("HIGHWAY_TREND_BOX_EDGE_RANGE_SCORE_PRIORITY");
        } else {
          executorDecision = {
            entry_allowed: false,
            blocked_reason: "trend_box_edge_highway_watch",
            target_stage: 1,
            expected_move: typeof em === "number" ? em : null,
            total_cost: totalCost,
            risk_state: (input.risk?.riskStatus ?? "NORMAL") as "NORMAL" | "LIMITED" | "BLOCKED",
            regime: "TREND",
            executor: "TREND",
            breakout_state: "none",
            pullback_state: "unknown",
            guidance:
              "박스 상·하단 근처 TREND: Highway 코어 과경직 — RANGE 재점수도 무효. 약추세 관망(HIGHWAY_BOX_EDGE_WATCH).",
            detail: {
              highway_state: "INVALID",
              highway_invalid_tier: "hard_invalid",
              highway_invalid_reasons: _aiResult.invalidReasons,
              highway_stiffness_proof_trend_path: (_aiResult.aiScoreRaw as { highwayStiffnessProof?: unknown } | undefined)
                ?.highwayStiffnessProof,
              highway_stiffness_proof_range_rescore: (rangeRescore.aiScoreRaw as { highwayStiffnessProof?: unknown } | undefined)
                ?.highwayStiffnessProof,
              trend_path_ai_scores: _aiResult,
              range_rescore_ai_scores: rangeRescore,
              trend_box_edge_watch: true,
              box_zone: z
            }
          };
          supplemental_reasons.push("HIGHWAY_TREND_BOX_EDGE_WATCH_ONLY");
          skipHighwayExecutorCall = true;
        }
      }
    }

    if (!skipHighwayExecutorCall) {
      let _entryIntent: "probe" | "standard" | "scale" | "trend" = "trend";
      if (aiForHighway.state === HighwayTrendState.VALID) {
        _entryIntent = "standard";
      } else if (aiForHighway.state === HighwayTrendState.WEAK) {
        _entryIntent = "probe";
      }

      executorDecision = highwayExecutorEvaluateEntry({
        intentType: _entryIntent,
        highwayState: aiForHighway.state,
        aiScores: aiForHighway,
        symbol: String(sym),
        signal: workingSignal,
        risk_state: (input.risk?.riskStatus ?? "NORMAL") as "NORMAL" | "LIMITED" | "BLOCKED",
        currentStage: input.currentStage,
        expectedMove: typeof em === "number" ? em : null,
        totalCost
      });
      if (trendBoxEdgeBufferEligible && aiForHighway !== _aiResult) {
        executorDecision = {
          ...executorDecision,
          detail: {
            ...executorDecision.detail,
            trend_box_edge_range_ai_blend: true,
            trend_path_stiffness: (_aiResult.aiScoreRaw as { highwayStiffnessProof?: unknown } | undefined)?.highwayStiffnessProof
          }
        };
      }
    }
    strategy_executor = "TREND";
  } else {
    supplemental_reasons.push("RANGE_STAGE0_ENGINE_ACTIVE");
  }

  // Highway Result & AI Result previously computed and assigned to executorDecision

  // Retain core executor selection; overriding removed

  if (typeof em === "number" && Number.isFinite(em)) {
    expected_move_pct = em * 100;
    atr_pct = em * 100;
  }
  if (typeof rm === "number" && Number.isFinite(rm)) {
    fee_estimate_pct = rm * 100;
  }

  if (signal_state === "NONE") {
    /** 진단: BTC 등 지수급 심볼의 Stage 1 신호 부재 시 모호하지 않고 특정 조건 충족 시 SOFT_RANGE_CANDIDATE 허용. */
    let softCandidateAllowed = false;

    if (input.currentStage === 0 && input.regime === "RANGE") {
      const boxPos = sn?.boxPos ?? 0.5;
      if (classifyBoxZone(boxPos) === "lower") {
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
    const zoneFb = classifyBoxZone(boxPos);
    const boxNotCentered = boxPos < 0.45 || boxPos > 0.55;
    const qualityHighEnough = sn.qualityScore >= 35;

    if (boxNotCentered && qualityHighEnough && zoneFb !== "mid") {
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
    stage1_block_origin = "regime_unknown_gate";
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

  /** NO_TRADE 는 감지기에서 위험/오류·필수 데이터 부족만 — 모호·약추세 등은 NO_TRADE 로 내리지 않음 */
  if (input.regime === "NO_TRADE") {
    stage1_block_origin = "regime_no_trade_gate";
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

  intentSide = workingSignal === "paper_long_candidate" ? "long" : "short";
  rr = rrFromRegime(input.regime);

  let stage1LoosenedEntry = false;
  /** Stage 1만: 기대이동이 완화 비용 이하여도 탐색 진입 허용(하드 REJECT 안 함) */
  let costWarningStage1 = false;

  const costGateComparable =
    typeof em === "number" &&
    effectiveTotalCost !== null &&
    (useFixedCost || (typeof rm === "number" && totalCost !== null));

  if (costGateComparable && em !== null && effectiveTotalCost !== null) {
    const rangeStage0CostMode = input.currentStage === 0 && input.regime === "RANGE";
    const costThreshold = rangeStage0CostMode ? effectiveTotalCost * 0.82 : effectiveTotalCost;
    if (rangeStage0CostMode) {
      range_cost_warning_threshold = costThreshold;
      range_cost_warning_shortfall = em < costThreshold ? costThreshold - em : 0;
    }
    const feeWouldBlock = em <= costThreshold;
    if (feeWouldBlock) {
      if (input.currentStage === 0) {
        costWarningStage1 = true;
        if (rangeStage0CostMode) range_cost_warning_applied = true;
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

  const rangeStage0SignalActive =
    input.currentStage === 0 &&
    input.regime === "RANGE" &&
    (signal_state === "LONG_CANDIDATE" || signal_state === "SHORT_CANDIDATE");

  const rBlock = input.risk?.blockedRegimes?.[input.regime];
  if (rBlock && rBlock.until > input.now) {
    const remainingMs = rBlock.until - input.now;
    blocked_regime_reason = rBlock.reason;
    cooldown_remaining_ms = remainingMs;
    const nearEdgeRangeCandidate =
      input.currentStage === 0 &&
      input.regime === "RANGE" &&
      signal_state !== "NONE" &&
      typeof sn.boxPos === "number" &&
      (sn.boxPos <= 0.38 || sn.boxPos >= 0.62);
    const streakSuspend =
      rBlock.reason.includes("mode_loss_streak") || rBlock.reason.includes("highway_range_streak");
    const relaxModeCooldown =
      nearEdgeRangeCandidate &&
      streakSuspend &&
      (input.rangeReopenCooldownBypass === true || remainingMs <= 12 * 60_000);

    if (relaxModeCooldown) {
      risk_state = "SOFT_BLOCK";
      risk_cooldown_subreason = "blocked_regime_relaxed_range_stage0";
      supplemental_reasons.push("RISK_COOLDOWN_RELAXED_RANGE_STAGE0");
      supplemental_reasons.push(`RISK_COOLDOWN_REASON_${String(rBlock.reason).toUpperCase()}`);
    } else {
      const regimeStateIsRange = sn.regimeStateDiag === "RANGE" || input.regime === "RANGE";
      const rangeRelaxWindowEligible = regimeStateIsRange && input.currentStage === 0 && streakSuspend;
      const rangeRelaxWindowActive = rangeRelaxWindowEligible && input.now < RANGE_RISK_LIMIT_RELAX_EXPIRES_AT;
      if (rangeRelaxWindowEligible) {
        range_risk_limit_temporarily_relaxed = true;
        range_risk_limit_relax_reason = RANGE_RISK_LIMIT_RELAX_REASON;
        range_risk_limit_relax_started_at = RANGE_RISK_LIMIT_RELAX_STARTED_AT;
        range_risk_limit_relax_expires_at = RANGE_RISK_LIMIT_RELAX_EXPIRES_AT;
        range_risk_limit_relax_active = rangeRelaxWindowActive;
        range_risk_limit_relax_expired = !rangeRelaxWindowActive;
      }
      const engineBlockedOnlyByLossSuspend =
        input.risk?.engineBlocked === true &&
        streakSuspend &&
        rangeRelaxWindowActive &&
        (input.risk?.crashState === undefined || input.risk.crashState === "NONE");
      const upperRiskHit =
        (input.risk?.engineBlocked === true && !engineBlockedOnlyByLossSuspend) ||
        (input.risk?.crashState !== undefined && input.risk.crashState !== "NONE") ||
        input.regimeDetail?.dump_protection_hit === true ||
        input.regimeDetail?.volatility_guard_hit === true;
      const previewMeta = input.lastCloseMetaBySymbol?.get(String(sym));
      const previewSameDir = previewMeta !== undefined && previewMeta.side === intentSide;
      const previewWaitMs = previewSameDir
        ? input.reentryCooldownMs * input.sameDirCooldownMult
        : input.reentryCooldownMs;
      const previewElapsedMs = input.now - (previewMeta?.closedAt ?? 0);
      const previewReentryActive =
        (previewMeta?.closedAt ?? 0) > 0 &&
        previewWaitMs > 0 &&
        previewElapsedMs < previewWaitMs;
      const bypassBlockedRegimeUntilOnly =
        input.config.paperTestBypassBlockedRegimeUntilRangeStage0 === true &&
        regimeStateIsRange &&
        input.currentStage === 0 &&
        rangeStage0SignalActive &&
        !upperRiskHit &&
        !streakSuspend &&
        !previewSameDir &&
        !previewReentryActive;
      if (rangeRelaxWindowActive && streakSuspend && !upperRiskHit && rangeStage0SignalActive) {
        risk_state = "SOFT_BLOCK";
        risk_cooldown_subreason = "blocked_regime_loss_streak_suspend_relaxed_validation_window";
        supplemental_reasons.push("RANGE_RISK_LIMIT_RELAX_WINDOW_ACTIVE");
      } else if (bypassBlockedRegimeUntilOnly) {
        blocked_regime_until_bypass_applied = true;
        blocked_regime_until_bypass_reason = "range_stage0_signal_alive_blocked_regime_until_only";
        blocked_regime_original_until_ms = remainingMs;
        blocked_regime_original_reason = rBlock.reason;
        risk_state = "SOFT_BLOCK";
        risk_cooldown_subreason = "blocked_regime_until_bypassed_test";
        supplemental_reasons.push("BLOCKED_REGIME_UNTIL_BYPASS_APPLIED");
      } else {
        risk_state = "COOLDOWN";
        risk_cooldown_subreason =
          rangeStage0SignalActive && streakSuspend
            ? "blocked_regime_loss_streak_suspend"
            : "blocked_regime_until_active";
        if (!reject_reason) reject_reason = "RISK_COOLDOWN";
        final_decision = "REJECT";
        supplemental_reasons.push("RISK_COOLDOWN");
        supplemental_reasons.push(`RISK_COOLDOWN_REASON_${String(rBlock.reason).toUpperCase()}`);
      }
    }
  }

  const rangeReversalGlobalReentryBypass =
    input.rangeReversalImmediateSwitch != null &&
    intentSide === input.rangeReversalImmediateSwitch.preferredSide &&
    input.regime === "RANGE" &&
    input.currentStage === 0 &&
    sn != null &&
    typeof sn.boxPos === "number" &&
    ((input.rangeReversalImmediateSwitch.preferredSide === "short" && classifyBoxZone(sn.boxPos) === "upper") ||
      (input.rangeReversalImmediateSwitch.preferredSide === "long" && classifyBoxZone(sn.boxPos) === "lower"));

  if (input.lastCloseMetaBySymbol && input.reentryCooldownMs > 0 && intentSide) {
    const meta = input.lastCloseMetaBySymbol.get(String(sym));
    const lastClose = meta?.closedAt ?? 0;
    const elapsed = input.now - lastClose;
    const sameDirection = meta !== undefined && meta.side === intentSide;
    same_dir_cooldown_applied = sameDirection;
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

    const rangeStage0 = input.currentStage === 0 && input.regime === "RANGE";
    if (rangeStage0 && meta != null && waitMs > 0) {
      const boxReformed =
        typeof sn.rangeCycleCount === "number" &&
        sn.rangeCycleCount >= 2 &&
        (sn.boxCohesion01 ?? 0) >= 0.45;
      const directionFlipped = sameDirection === false;
      const enoughTimeElapsed = elapsed >= Math.max(45_000, Math.floor(waitMs * 0.55));
      const lowerEdgeCandidate = typeof sn.boxPos === "number" && sn.boxPos <= 0.30;
      const upperEdgeCandidate = typeof sn.boxPos === "number" && sn.boxPos >= 0.70;
      const edgeCandidate = lowerEdgeCandidate || upperEdgeCandidate;

      if (directionFlipped || boxReformed || (enoughTimeElapsed && edgeCandidate)) {
        const relaxedByStructure = Math.max(
          RANGE_STAGE0_REENTRY_RELAX_MIN_MS,
          Math.floor(waitMs * (directionFlipped ? 0.45 : 0.6))
        );
        if (relaxedByStructure < waitMs) {
          waitMs = relaxedByStructure;
          reentry_cooldown_applied = true;
          reentry_cooldown_effective_ms = relaxedByStructure;
          reentry_cooldown_reason =
            directionFlipped
              ? "range_reentry_relax_direction_flip"
              : boxReformed
                ? "range_reentry_relax_box_reformed"
                : "range_reentry_relax_edge_after_elapsed";
        }
      }
    }
    if (rangeStage0 && waitMs > 0) {
      waitMs = Math.min(waitMs, 95_000);
      reentry_cooldown_effective_ms = waitMs;
    }

    if (rangeStage0SignalActive && lastClose > 0) {
      reentry_wait_ms = waitMs;
      reentry_elapsed_ms = elapsed;
    }

    if (lastClose > 0 && elapsed < waitMs && !rangeReversalGlobalReentryBypass) {
      risk_state = "COOLDOWN";
      risk_cooldown_subreason =
        rangeStage0SignalActive && sameDirection
          ? "reentry_same_direction_wait_active"
          : "reentry_wait_active";
      cooldown_remaining_ms = waitMs - elapsed;
      if (!reject_reason) reject_reason = "RISK_FAIL_REENTRY";
      final_decision = "REJECT";
      supplemental_reasons.push("RISK_FAIL_REENTRY");
      if (reentry_cooldown_reason) supplemental_reasons.push(`REENTRY_COOLDOWN_REASON_${reentry_cooldown_reason}`);
      supplemental_reasons.push(`REENTRY_COOLDOWN_WAIT_MS_${String(waitMs)}`);
    } else if (lastClose > 0 && elapsed < waitMs && rangeReversalGlobalReentryBypass) {
      supplemental_reasons.push("RANGE_REVERSAL_GLOBAL_REENTRY_BYPASS");
    }
  }

  if (input.risk && input.risk.sizeMultiplier < 1 && !input.risk.dailyLossGuardTriggered) {
    const br = input.risk.blockedRegimes?.[input.regime];
    if (!(br && br.until > input.now)) {
      risk_state = "SOFT_BLOCK";
    }
  }

  if (final_decision === "REJECT") {
    stage1_block_origin = stage1_block_origin ?? "pre_executor_risk_or_edge_gate";
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
        executorDecision,
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
        executorDecision,
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

  // Highway Engine Universal Evaluation - Regime is only secondary veto logic
  // Highway Engine Universal Evaluation already performed earlier to preserve metrics

  // Auxiliary RANGE Veto / Downgrade Logic (executed only if Highway returns some valid intent but score is weak-ish)
  if (!useRangeStage0Engine && executorDecision?.entry_allowed && _aiResult.highwayValidityScore < 0.6) {
    const currentExecutor = executorDecision;
    const penalty = sn.rangeConfidence ?? 0;
    const isChaos = (sn.breakoutFailureRate ?? 0) > 0.8;

    if (penalty > 0.85 || isChaos) {
      executorDecision = {
        ...currentExecutor,
        entry_allowed: false,
        blocked_reason: "range_extreme_veto",
        guidance: "Highway blocked by extreme RANGE chaos/noise"
      };
    } else if (penalty > 0.7 && currentExecutor.target_stage && currentExecutor.target_stage > 1) {
      executorDecision = {
        ...currentExecutor,
        target_stage: 1,
        guidance: "Highway downgraded to Probe/Scale 1 due to RANGE noise"
      };
    }
  }

  // Rounds 3, 3.5, 3.6 (Legacy Stage 1 Soft Bypasses) have been removed.
  // Highway evaluation is now the sole authority for entry decisions.


  if (useRangeStage0Engine && (!executorDecision || !executorDecision.entry_allowed)) {
    const rangeBlocked = executorDecision?.blocked_reason ?? "RANGE_GATE_BLOCK_UNKNOWN";
    const rangeFinalBlockReason =
      rangeBlocked === "RANGE_GATE_BLOCK_LOW_CONFIDENCE" && signal_state === "NONE"
        ? "RANGE_SIGNAL_NONE"
        : rangeBlocked === "RANGE_GATE_BLOCK_RISK_ENGINE"
          ? "RANGE_RISK_BLOCK_ENGINE"
          : rangeBlocked === "RANGE_GATE_BLOCK_REENTRY"
            ? "RANGE_RISK_BLOCK_REENTRY"
            : rangeBlocked.startsWith("RANGE_GATE_BLOCK_")
              ? rangeBlocked
              : "RANGE_GATE_BLOCK_UNKNOWN";
    const rangeStage1Code =
      rangeFinalBlockReason.startsWith("RANGE_RISK_BLOCK_")
        ? "STAGE1_BLOCKED_RISK"
        : rangeFinalBlockReason === "RANGE_SIGNAL_NONE"
          ? "STAGE1_BLOCKED_SIGNAL"
          : "STAGE1_BLOCKED_EDGE";
    reject_reason =
      rangeFinalBlockReason === "RANGE_RISK_BLOCK_REENTRY"
        ? "RISK_FAIL_REENTRY"
        : rangeFinalBlockReason.startsWith("RANGE_RISK_BLOCK_")
          ? "RISK_COOLDOWN"
          : rangeFinalBlockReason === "RANGE_SIGNAL_NONE"
            ? "SIGNAL_NONE"
            : "EDGE_FAIL_EXPECTANCY";
    if (reject_reason === "RISK_COOLDOWN" || reject_reason === "RISK_FAIL_REENTRY") risk_state = "COOLDOWN";
    supplemental_reasons.push(`RANGE_FINAL_BLOCK_${rangeFinalBlockReason}`);
    range_stage0_exit_reason = rangeFinalBlockReason;
    return ret(
      {
        execution_state,
        final_decision: "SKIP",
        strategy_executor: "RANGE",
        ai_decision: "N/A",
        adaptive_decision: "N/A",
        guidance: executorDecision?.guidance ?? null,
        target_stage: null,
        supplemental_reasons,
        stage1_result_code: rangeStage1Code as any,
        entry_blocked: rangeFinalBlockReason,
        range_stage0_engine_taken: true,
        range_stage0_exit_reason: rangeFinalBlockReason,
        legacy_executor_path_taken: false,
        required_move_pct,
        shortfall_pct,
        reject_reason,
        final_fail_reason: rangeFinalBlockReason
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

  if (!executorDecision || !executorDecision.entry_allowed) {
    legacy_executor_path_taken = true;
    br = executorDecision?.blocked_reason ?? null;
    legacy_block_original_reason = br ?? "executor_block_reason_missing";
    legacy_block_reason = br ?? "executor_block_reason_missing";
    legacy_regime_gate = input.currentStage === 0 && !input.isAmbiguous ? "STAGE1_BLOCKED_REGIME" : "STAGE1_EXEC_PENDING";
    legacy_gate_source = executorDecision?.executor ? `executor_${String(executorDecision.executor).toLowerCase()}` : "executor_unknown";
    stage1_block_origin = "legacy_executor_gate";
    reject_reason = br ? mapExecutorBlockToReject(br) : (input.isAmbiguous ? "AMBIGUOUS_WATCHING" : "EDGE_FAIL_EXPECTANCY");
    if (reject_reason === "HIGHWAY_BOX_EDGE_WATCH") {
      execution_state = "HIGHWAY_BOX_EDGE_WATCH";
    }
    if (reject_reason === "HIGHWAY_CANDLE_WARMUP_WATCH") {
      execution_state = "HIGHWAY_CANDLE_WARMUP_WATCH";
    }
    const stage1BlockCode =
      input.currentStage === 0
        ? reject_reason === "HIGHWAY_BOX_EDGE_WATCH" || reject_reason === "HIGHWAY_CANDLE_WARMUP_WATCH"
          ? "STAGE1_EXEC_PENDING"
          : input.isAmbiguous
            ? "STAGE1_EXEC_PENDING"
            : reject_reason === "RISK_COOLDOWN" || reject_reason === "RISK_FAIL_REENTRY"
              ? "STAGE1_BLOCKED_RISK"
              : reject_reason?.startsWith("EDGE")
                ? "STAGE1_BLOCKED_EDGE"
                : "STAGE1_BLOCKED_REGIME"
        : "STAGE1_BLOCKED_RISK";
    override_by_legacy = stage1BlockCode === "STAGE1_BLOCKED_REGIME";
    if (reject_reason === "RISK_COOLDOWN") risk_state = "COOLDOWN";
    const invalidTier = (executorDecision?.detail?.highway_invalid_tier as string | undefined) ?? null;
    const invalidReasonsRaw = executorDecision?.detail?.highway_invalid_reasons;
    const invalidReasons = Array.isArray(invalidReasonsRaw) ? invalidReasonsRaw : [];
    const baseCandidateExists =
      workingSignal === "paper_long_candidate" ||
      workingSignal === "paper_short_candidate" ||
      signal_state === "LONG_CANDIDATE" ||
      signal_state === "SHORT_CANDIDATE";
    const requiredMoveLowEnough = typeof required_move_pct === "number" && required_move_pct <= 0.25;
    const rangeStage0LegacyPath =
      (sn.regimeStateDiag ?? input.regime) === "RANGE" &&
      input.currentStage === 0 &&
      baseCandidateExists &&
      requiredMoveLowEnough;
    const detailDumpHit = input.regimeDetail?.dump_protection_hit === true;
    const detailVolHit = input.regimeDetail?.volatility_guard_hit === true;
    const severeRiskLock =
      input.risk?.engineBlocked === true ||
      (input.risk?.crashState !== undefined && input.risk.crashState !== "NONE") ||
      detailDumpHit ||
      detailVolHit;
    const testBypassAllowed =
      input.config.paperTestBypassLegacyRangeStage0 === true &&
      rangeStage0LegacyPath &&
      !severeRiskLock &&
      reject_reason !== "RISK_COOLDOWN" &&
      reject_reason !== "RISK_FAIL_REENTRY";

    if (testBypassAllowed && executorDecision) {
      legacy_block_test_bypass_applied = true;
      legacy_block_test_bypass_reason = "range_stage0_legacy_block_test_bypass";
      supplemental_reasons.push("LEGACY_BLOCK_TEST_BYPASS_APPLIED");
      executorDecision = {
        ...executorDecision,
        entry_allowed: true,
        blocked_reason: null,
        target_stage: executorDecision.target_stage ?? 1,
        guidance: "test bypass: legacy range stage0 block skipped"
      };
      reject_reason = null;
      final_decision = "SKIP";
    }

    if (executorDecision?.entry_allowed) {
      stage1_block_origin = "legacy_executor_gate_bypassed_for_test";
      override_by_legacy = false;
    } else {
      // Round 4 & 5: Active Stage 1 candidate evaluation (Execution over Review)
      final_decision = input.currentStage === 0 ? "SKIP" : "REJECT";

      if (
        input.isAmbiguous &&
        final_decision === "SKIP" &&
        reject_reason !== "HIGHWAY_BOX_EDGE_WATCH" &&
        reject_reason !== "HIGHWAY_CANDLE_WARMUP_WATCH"
      ) {
        const ambCode = input.regime === "TREND" ? "AMBIGUOUS_TREND_REVIEW" : "AMBIGUOUS_RANGE_REVIEW";
        reject_reason = ambCode;
        execution_state = ambCode;
      }

      if (br) supplemental_reasons.push(`EXEC_BLOCKED_${br.toUpperCase()}`);
      if (invalidTier) supplemental_reasons.push(`HIGHWAY_INVALID_TIER_${invalidTier.toUpperCase()}`);
      for (const reason of invalidReasons.slice(0, 3)) {
        supplemental_reasons.push(`HIGHWAY_INVALID_SUBREASON_${String(reason).toUpperCase()}`);
      }
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
          stage1_result_code: stage1BlockCode as any,
          legacy_block_reason,
          legacy_regime_gate,
          legacy_gate_source,
          override_by_legacy,
          stage1_block_origin,
          legacy_block_test_bypass_applied,
          legacy_block_test_bypass_reason,
          legacy_block_original_reason,
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
    if (input.currentStage === 0 && input.regime === "RANGE" && range_soft_suspend_applied && range_soft_suspend_size_mult) {
      dynamicSizeMult *= range_soft_suspend_size_mult;
      supplemental_reasons.push("RANGE_SOFT_SUSPEND_SIZE_REDUCED");
    }
    if (
      input.currentStage === 0 &&
      input.regime === "RANGE" &&
      range_same_direction_reentry_relaxed_applied &&
      range_same_direction_reentry_size_mult
    ) {
      dynamicSizeMult *= range_same_direction_reentry_size_mult;
      supplemental_reasons.push("RANGE_SAME_DIRECTION_REENTRY_SIZE_REDUCED");
    }
    if (
      input.currentStage === 0 &&
      input.regime === "RANGE" &&
      range_fresh_reentry_allowed &&
      range_fresh_reentry_size_mult !== null
    ) {
      dynamicSizeMult *= range_fresh_reentry_size_mult;
      supplemental_reasons.push("RANGE_FRESH_REENTRY_SIZE_REDUCED");
    }
    if (
      input.currentStage === 0 &&
      input.regime === "RANGE" &&
      range_loss_streak_reduced_entry_applied &&
      range_loss_streak_reduced_entry_size_mult !== null
    ) {
      dynamicSizeMult *= range_loss_streak_reduced_entry_size_mult;
      supplemental_reasons.push("RANGE_LOSS_STREAK_REDUCED_ENTRY_APPLIED");
    }

    /**
     * Fee-drag (STAGE1_COST_WARNING 후처리만): 비용 경고 꼬리에서 추가 사이즈 축소만.
     * `return ret(...)`로 REJECT 금지 · `fee_drag_blocked`는 항상 false(호환 필드).
     * `range_lower_long_priority_applied` / `range_upper_short_priority_applied` true면 fee-drag 전체 스킵.
     */
    const feeDragRangePriorityProtected =
      input.regime === "RANGE" &&
      input.currentStage === 0 &&
      (range_lower_long_priority_applied || range_upper_short_priority_applied);

    if (costWarningStage1 && input.currentStage === 0 && !feeDragRangePriorityProtected) {
      const rc = requiredCostUsd;
      const emU = expectedMoveUsd;
      if (rc !== null && rc > 0 && emU !== null) {
        const emRatio = emU / rc;
        const c = input.config;
        const extremeTail =
          emRatio <= c.paperFeeDragBlockEmRatioMax &&
          shortfallUsd >= c.paperFeeDragBlockShortfallUsdMin &&
          shortfall_pct >= c.paperFeeDragBlockShortfallPctMin;
        if (extremeTail && c.paperFeeDragTailSizeMult < 1) {
          const extremeMult = c.paperFeeDragTailSizeMult * c.paperFeeDragTailSizeMult;
          dynamicSizeMult *= extremeMult;
          fee_drag_filter_applied = true;
          fee_drag_size_reduced = true;
          fee_drag_reason = "extreme_cost_tail_size_mult";
          fee_drag_proof = {
            fee_drag_filter_applied: true,
            fee_drag_size_reduced: true,
            fee_drag_blocked: false,
            fee_drag_reason,
            shortfall_pct,
            shortfall_usd: shortfallUsd,
            expected_move_usd: emU,
            required_cost_usd: rc,
            em_ratio: emRatio,
            tail_size_mult_applied: extremeMult,
            range_priority_protected: false,
            thresholds: {
              block_em_ratio_max: c.paperFeeDragBlockEmRatioMax,
              block_shortfall_usd_min: c.paperFeeDragBlockShortfallUsdMin,
              block_shortfall_pct_min: c.paperFeeDragBlockShortfallPctMin
            }
          };
          supplemental_reasons.push("fee_drag_filter_applied");
          supplemental_reasons.push("fee_drag_size_reduced");
        } else {
          const weakTail =
            shortfall_pct >= c.paperFeeDragWeakShortfallPctMin &&
            emRatio <= c.paperFeeDragWeakEmRatioMax;
          if (weakTail && c.paperFeeDragTailSizeMult < 1) {
            dynamicSizeMult *= c.paperFeeDragTailSizeMult;
            fee_drag_filter_applied = true;
            fee_drag_size_reduced = true;
            fee_drag_reason = "weak_cost_tail_size_mult";
            fee_drag_proof = {
              fee_drag_filter_applied: true,
              fee_drag_size_reduced: true,
              fee_drag_blocked: false,
              fee_drag_reason,
              shortfall_pct,
              shortfall_usd: shortfallUsd,
              expected_move_usd: emU,
              required_cost_usd: rc,
              em_ratio: emRatio,
              tail_size_mult_applied: c.paperFeeDragTailSizeMult,
              range_priority_protected: false,
              thresholds: {
                weak_shortfall_pct_min: c.paperFeeDragWeakShortfallPctMin,
                weak_em_ratio_max: c.paperFeeDragWeakEmRatioMax
              }
            };
            supplemental_reasons.push("fee_drag_filter_applied");
            supplemental_reasons.push("fee_drag_size_reduced");
          }
        }
      }
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

    const highwayDet = executorDecision?.detail as Record<string, unknown> | undefined;
    const highwayAiRaw = highwayDet?.aiScoreRaw as Record<string, unknown> | undefined;
    const highwayStateOk = highwayDet?.state === HighwayTrendState.VALID;
    const highwayCoreFinalOk =
      !highwayAiRaw ||
      (highwayAiRaw.coreState === HighwayTrendState.VALID && highwayAiRaw.finalState === HighwayTrendState.VALID);
    const scoreSourceTrendCore = highwayDet?.scoreSource === "trend_core_default";

    let trendVolumeRatioMinOverride: number | null = null;
    if (input.adaptiveMode === "trend") {
      const volRelax = computeTrendVolumeRelaxForAdaptive({
        adaptiveMode: input.adaptiveMode,
        currentStage: input.currentStage,
        highwayDet,
        highwayStateOk,
        highwayCoreFinalOk,
        scoreSourceOk: scoreSourceTrendCore,
        candidateStrength: sn!.candidateStrength,
        qualityScore: sn!.qualityScore,
        required_move_pct,
        shortfall_pct: shortfall_pct ?? 0,
        em
      });
      trendVolumeRatioMinOverride = volRelax.override;
      trendVolumeRelaxProof = volRelax.proof;
      const tier = volRelax.proof["relax_tier"];
      if (tier === "strong_highway") supplemental_reasons.push("ADAPTIVE_TREND_VOLUME_MIN_RELAXED_HIGHWAY_STRONG");
      if (tier === "weak_highway_edge_ok") supplemental_reasons.push("ADAPTIVE_TREND_VOLUME_MIN_RELAXED_HIGHWAY_WEAK_EDGE");
    } else {
      trendVolumeRelaxProof = null;
    }

    const adaptive = runFuturesAdaptiveEntry({
      mode: input.adaptiveMode,
      modeDetail: input.adaptiveDetail,
      snap: {
        symbol: String(sym),
        signal: workingSignal,
        lastPrice: sn!.lastPrice,
        latestCandleClose: sn!.latestCandleClose,
        ema20: sn!.ema20,
        ema60: sn!.ema60,
        qualityScore: sn!.qualityScore,
        candidateStrength: sn!.candidateStrength,
        emaGap: sn!.emaGap,
        volumeRatioProxy: sn!.volumeRatioProxy
      },
      baseSizeUsd: DEFAULT_PAPER_SIZE_USD * dynamicSizeMult,
      stage1RangeAdaptiveSoftExplore,
      trendVolumeRatioMinOverride,
      trendVolumeRelaxProof
    });
    adaptiveDetailOut = adaptive.detail ?? null;

    // Consolidate reasons: Use policy failure over executor failure if it's from entry_policy
    if (!adaptive.ok && adaptive.orderBuildFailReason && adaptive.failStage === "entry_policy") {
      executorBlockReasonOriginal = adaptive.orderBuildFailReason;
    }
    if (!adaptive.ok) {
      let stage1DirectionOverrideApplied = false;
      let stage1DirectionOverrideReason: string | null = null;
      let originalPolicyDirection: string | null = (adaptive as any).orderBuildFailReason === "policy_direction_none" ? "none" : null;
      let finalPolicyDirection: string | null = null;

      // Stage 1 Range Directional Override (DEACTIVATED)
      if (
        false && // stage1SoftCandidateMicroEnter disabled
        (adaptive as any).orderBuildFailReason === "policy_direction_none" &&
        input.currentStage === 0 &&
        input.regime === "RANGE"
      ) {
        // Logic removed.
      }

      if (!stage1DirectionOverrideApplied) {
        const af = adaptive as Extract<FuturesAdaptiveEntryResult, { ok: false }>;
        return ret(
          {
            reject_reason: "ORDER_BUILD_FAIL",
            final_decision: "REJECT",
            execution_state: "ORDER_BUILD_FAIL",
            ai_decision: "APPROVE",
            adaptive_decision: "REJECT",
            guidance: `Adaptive entry failed: ${af.orderBuildFailReason}`,
            target_stage: null,
            supplemental_reasons,
            stage1_result_code: "STAGE1_BLOCKED_SIGNAL",
            required_move_pct,
            shortfall_pct,
            order_build_ok: false,
            order_build_fail_reason: af.orderBuildFailReason,
            order_build_fail_stage: af.failStage
          },
          {
            intentSide,
            executorDecision,
            adaptiveOk: false,
            adaptiveDirection: null,
            adaptiveDetail: adaptiveDetailOut,
            adaptiveResult: null,
            adaptiveFailure: af,
            aiGatePassed: true
          }
        );
      } else {
        // This path is unreachable due to false && above, but kept for type safety/future use
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
            required_move_pct, shortfall_pct,
            stage1_direction_override_applied: true,
            stage1_direction_override_reason: stage1DirectionOverrideReason,
            original_policy_direction: originalPolicyDirection,
            final_policy_direction: finalPolicyDirection,
            qty: (DEFAULT_PAPER_SIZE_USD * dynamicSizeMult) / sn!.lastPrice,
            price: sn!.lastPrice,
            stopLoss: null,
            takeProfit: null,
            riskReward: rr,
            atr_pct: atr_pct!
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
    }

    const expectedSide: "long" | "short" = workingSignal === "paper_long_candidate" ? "long" : "short";
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
          guidance: `Adaptive 방향 불일치 (${adaptive.direction} vs ${expectedSide})`,
          target_stage: null,
          supplemental_reasons,
          stage1_result_code: "STAGE1_BLOCKED_SIGNAL",
          required_move_pct,
          shortfall_pct
        },
        {
          intentSide,
          executorDecision,
          adaptiveOk: false,
          adaptiveDirection: adaptive.direction,
          adaptiveDetail: adaptiveDetailOut,
          adaptiveResult: adaptive,
          aiGatePassed: true
        }
      );
    }

    if (input.config.longOnly && adaptive.direction === "short") {
      supplemental_reasons.push("LONG_ONLY_RESTRICTION");
      const longOnlyBoxPos = typeof sn.boxPos === "number" ? sn.boxPos : null;
      const longOnlyClassifiedZone = longOnlyBoxPos !== null ? classifyBoxZone(longOnlyBoxPos) : null;
      const longOnlyZoneUpperBypass = longOnlyClassifiedZone === "upper";
      /** RANGE Stage0 숏 의도: workingSignal만 보면 레인지 엔진과 불일치 시 Long Only 차단에 걸림 → final_selected_side 포함 */
      const rangeBidirectionalShortIntent =
        input.currentStage === 0 &&
        input.regime === "RANGE" &&
        (workingSignal === "paper_short_candidate" || range_final_selected_side === "short");
      const allowRangeShortDespiteLongOnly = range_short_allowed || longOnlyZoneUpperBypass;

      if (rangeBidirectionalShortIntent) {
        range_bidirectional_applied = true;
        if (allowRangeShortDespiteLongOnly) {
          if (range_short_allowed) supplemental_reasons.push("RANGE_SHORT_ALLOWED_BIDIRECTIONAL");
          if (longOnlyZoneUpperBypass && !range_short_allowed) {
            supplemental_reasons.push("RANGE_UPPER_SHORT_LONG_ONLY_EXEC_BYPASS");
          }
          range_long_only_short_deferred_applied = false;
          range_long_only_short_deferred_bypassed = longOnlyZoneUpperBypass && !range_short_allowed;
        } else {
          range_long_only_short_deferred_applied = true;
          return ret(
            {
              final_decision: "SKIP",
              reject_reason: "EDGE_FAIL_EXPECTANCY",
              execution_state: "PAPER_READY",
              ai_decision: "APPROVE",
              adaptive_decision: "DEFERRED",
              guidance: range_short_allowed_reason ?? "range_short_not_allowed",
              target_stage: null,
              supplemental_reasons,
              stage1_result_code: "STAGE1_BLOCKED_EDGE",
              required_move_pct,
              shortfall_pct,
              range_long_only_short_deferred_applied: true,
              range_long_only_short_deferred_bypassed: false,
              range_bidirectional_applied: true,
              range_short_allowed: false,
              range_short_allowed_reason: range_short_allowed_reason,
              range_upper_edge_near: range_upper_edge_near,
              range_center_wait: range_center_wait,
              range_final_selected_side: "none",
              range_reversal_zone: range_reversal_zone,
              range_reversal_short_eval_started: range_reversal_short_eval_started,
              range_reversal_long_exit_triggered: range_reversal_long_exit_triggered,
              range_reversal_short_entry_allowed: range_reversal_short_entry_allowed,
              range_reversal_short_entry_block_reason: range_reversal_short_entry_block_reason,
              long_only_restriction: true,
              original_signal_state: "SHORT_CANDIDATE",
              final_signal_state: "SHORT_CANDIDATE_RANGE_WAIT",
              execution_disabled_reason: "range_short_condition_not_met"
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
      } else {
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
            range_long_only_short_deferred_applied: false,
            range_long_only_short_deferred_bypassed: range_long_only_short_deferred_bypassed,
            long_only_restriction: true,
            original_signal_state: "SHORT_CANDIDATE",
            final_signal_state: "SHORT_CANDIDATE",
            execution_disabled_reason: "EXECUTION_DISABLED_long_only_short_non_range_or_stage_gt0",
            execution_disabled_top_proof: {
              guard_id: "LONG_ONLY_STRICT_SHORT_BLOCK",
              proof_version: 1,
              at_ms: input.now,
              symbol: String(sym),
              long_only_config: input.config.longOnly,
              regime: input.regime,
              current_stage: input.currentStage,
              signal_state,
              working_signal: workingSignal,
              intent_side: intentSide,
              adaptive_direction: adaptive.direction,
              expected_side_from_working_signal: expectedSide,
              range_stage0_engine_taken,
              range_final_selected_side,
              range_short_allowed,
              range_short_allowed_reason,
              range_zone_detected,
              range_upper_edge_near,
              box_pos: longOnlyBoxPos,
              classify_box_zone: longOnlyClassifiedZone,
              long_only_zone_upper_bypass_would_apply: longOnlyZoneUpperBypass,
              range_bidirectional_short_intent_would_apply: rangeBidirectionalShortIntent
            }
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
    }

    const initialEntryQty = (DEFAULT_PAPER_SIZE_USD * dynamicSizeMult) / sn!.lastPrice;
    if (initialEntryQty <= 0) {
      reject_reason = "ORDER_BUILD_FAIL";
      final_decision = "REJECT";
      supplemental_reasons.push("ZERO_QTY_FAIL");
      return ret(
        {
          reject_reason: "ORDER_BUILD_FAIL",
          final_decision: "REJECT",
          execution_state: "ORDER_BUILD_FAIL",
          ai_decision: "APPROVE",
          adaptive_decision: "REJECT",
          guidance: "진입 수량 0",
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
          adaptiveResult: adaptive,
          aiGatePassed: true
        }
      );
    }

    final_decision = "ENTER";
    reject_reason = null;
    execution_state = "PAPER_READY";

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
        stage1_size_multiplier_final: stage1SizeMultFinal,
        expected_move_usd: expectedMoveUsd,
        required_cost_usd: requiredCostUsd,
        shortfall_usd: shortfallUsd,
        fee_drag_filter_applied,
        fee_drag_size_reduced,
        fee_drag_blocked,
        fee_drag_reason,
        fee_drag_proof,
        qty: initialEntryQty,
        price: sn!.lastPrice,
        stopLoss: (() => {
          const slThresh = stopLossPctForRegime(input.regime);
          // Protective SL: fallback to regime SL %
          const baseSlPrice = intentSide === "long"
            ? sn!.lastPrice * (1 + slThresh) // slThresh is negative
            : sn!.lastPrice * (1 - slThresh);

          // ATR-based SL if available (2.5 * ATR)
          if (atr_pct && atr_pct > 0) {
            const atrSlDist = sn!.lastPrice * atr_pct * 2.5;
            const atrSlPrice = intentSide === "long"
              ? sn!.lastPrice - atrSlDist
              : sn!.lastPrice + atrSlDist;

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
        original_signal_state: (input.currentStage === 0 && input.regime === "RANGE" && workingSignal === ("none" as any)) ? "NONE" : signal_state as any,
        final_signal_state: (input.currentStage === 0 && input.regime === "RANGE" && workingSignal === ("none" as any)) ? "SOFT_RANGE_CANDIDATE" : signal_state as any,
        range_bidirectional_applied: range_bidirectional_applied,
        range_short_allowed: range_short_allowed,
        range_short_allowed_reason: range_short_allowed_reason,
        range_upper_edge_near: range_upper_edge_near,
        range_center_wait: range_center_wait,
        range_final_selected_side: adaptive.direction,
        range_reversal_zone: range_reversal_zone,
        range_reversal_short_eval_started: range_reversal_short_eval_started,
        range_reversal_long_exit_triggered: range_reversal_long_exit_triggered,
        range_reversal_short_entry_allowed: range_reversal_short_entry_allowed,
        range_reversal_short_entry_block_reason: range_reversal_short_entry_block_reason,
        range_reversal_immediate_switch_applied: range_reversal_immediate_switch_applied,
        range_reversal_immediate_switch_reason: range_reversal_immediate_switch_reason
      },
      {
        intentSide: intentSide ?? (workingSignal === "paper_long_candidate" || workingSignal === "none" ? "long" : "short"),
        executorDecision,
        adaptiveOk: true,
        adaptiveDirection: adaptive.direction,
        adaptiveDetail: adaptiveDetailOut,
        adaptiveResult: adaptive as any,
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
