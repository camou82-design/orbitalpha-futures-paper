import type {
  EngineConfig,
  MarketSymbol,
  PaperDecisionRejectReason,
  PaperEdgeState,
  PaperEngineRoutingKind,
  PaperExecutionState,
  PaperFinalDecision,
  PaperMarketMode,
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
import { btcBiasFromModeDetail } from "../strategy/live-market-mode";
import { runFuturesAdaptiveEntry, type FuturesAdaptiveEntryResult } from "../strategy/live-entry-pipeline";
import { computePaperSizingAnchorUsd, MIN_POSITION_SIZE_USD } from "../strategy/live-position-sizing";
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
import type { EntryExecutionAuthority } from "../engine-v2/types";
import { resolveSymbolDecisionEnvelope } from "../engine-v2/reconciler";
import { parseEngineV2OpModeFromEnv } from "../engine-v2/op-mode";
import { aiApproveEntry, aiInputFromDecision } from "../ai/entry-approval";
import { HighwayTrendState } from "../models/types";
import { evaluateAiHighwayQuality } from "../engine/ai-highway-filter";
import type { PaperSignal } from "../strategy/entry-signal";
import type { PaperCandidateStrength } from "../strategy/entry-signal";
import { PIPELINE_VERSION } from "./decision-funnel";
import { RANGE_ZONE_ACTION_POLICY } from "./range-engine";
import { classifyRangeZone, type Candle, type RangeBoxZone } from "../models/types";
import {
  evaluateDirectionalTrendEntryGuard,
  deriveDirectionalRoutingOverride,
  type DirectionalRoutingOverride
} from "./directional-routing";

/** Stage0 signal absence proof: 1x per symbol per decision cycle (`input.now`). */
const stage0SignalAbsenceProofLoggedAtBySymbol = new Map<string, number>();

/** RANGE쨌Stage0쨌RISK_FAIL_REENTRY: 遺遺꾩씡??TP 怨꾩뿴 泥?궛 ???숈씪 ?щ낵 ?ъ쭊???湲곕쭔 ?꾪솕(?먯젅쨌利앹븸 ?④퀎 ?쒖쇅). */
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

export type RangeStopReentryBlock = Readonly<{
  side: "long" | "short";
  zone: "upper" | "lower";
  armedAt: number;
  reason: "stop_loss";
  regime: "RANGE";
}>;

/** 吏꾪뻾 以?1m 遊??쒖쇅: ?꾩꽦遊됰쭔?쇰줈 理쒓렐 2媛?吏곸쟾쨌理쒓렐) OHLC */
function getLastTwoCompletedOneMinuteBars(
  candles: readonly Candle[] | null | undefined
): { latest: Pick<Candle, "open" | "high" | "low" | "close">; prev: Pick<Candle, "open" | "high" | "low" | "close"> } | null {
  if (!candles || candles.length < 2) return null;
  // 정적 테스트나 라이브 완성 시점 등 candles의 크기에 따른 바인딩 안정성 확보
  // 진행 봉이 마지막에 묻어있을 가능성을 고려해 배열이 3개 이상일 때는 마지막 진행 중인 봉을 버리고, 
  // 배열이 정확히 2개일 때는 해당 2개를 완성 봉으로 간주하여 사용합니다.
  const targetArray = candles.length > 2 ? candles.slice(0, -1) : candles;
  if (targetArray.length < 2) return null;
  const latest = targetArray[targetArray.length - 1]!;
  const prev = targetArray[targetArray.length - 2]!;
  return { latest, prev };
}


function computeRangeEdgeReversalConfirmation(args: Readonly<{
  zone: RangeBoxZone;
  entrySide: "long" | "short";
  candles: readonly Candle[] | null | undefined;
}>): Readonly<{
  reversal_confirmed: boolean;
  reject_reason: "RANGE_UPPER_SHORT_NO_REVERSAL_CONFIRMATION" | "RANGE_LOWER_LONG_NO_REVERSAL_CONFIRMATION" | null;
  prev: Pick<Candle, "open" | "high" | "low" | "close"> | null;
  latest: Pick<Candle, "open" | "high" | "low" | "close"> | null;
}> {

  const bars = getLastTwoCompletedOneMinuteBars(args.candles);
  if (!bars) {
    const reject =
      args.zone === "upper" && args.entrySide === "short"
        ? ("RANGE_UPPER_SHORT_NO_REVERSAL_CONFIRMATION" as const)
        : args.zone === "lower" && args.entrySide === "long"
          ? ("RANGE_LOWER_LONG_NO_REVERSAL_CONFIRMATION" as const)
          : null;
    return {
      reversal_confirmed: false,
      reject_reason: reject,
      prev: null,
      latest: null
    };
  }
  const { latest, prev } = bars;
  
  if (args.zone === "upper" && args.entrySide === "short") {
    // 하락 종가 확인 (latest.close < prev.close)
    const isCloseDown = latest.close < prev.close;
    // 낮아진 고점
    const isLowerHigh = latest.high < prev.high;
    // 음봉 몸통 (close < open)
    const isBearishBody = latest.close < latest.open;
    // 윗꼬리 돌파 실패 (윗꼬리 길이가 몸통보다 길거나 일정 비율 이상)
    const bodySize = Math.abs(latest.close - latest.open);
    const upperTail = latest.high - Math.max(latest.open, latest.close);
    const isUpperTailRejection = upperTail > bodySize * 0.8 || (latest.high > prev.high && latest.close < prev.close);

    const ok = isCloseDown && (isLowerHigh || isBearishBody || isUpperTailRejection);
    return {
      reversal_confirmed: ok,
      reject_reason: ok ? null : "RANGE_UPPER_SHORT_NO_REVERSAL_CONFIRMATION",
      prev,
      latest
    };
  }
  
  if (args.zone === "lower" && args.entrySide === "long") {
    // 상승 종가 확인 (latest.close > prev.close)
    const isCloseUp = latest.close > prev.close;
    // 높아진 저점
    const isHigherLow = latest.low > prev.low;
    // 양봉 몸통 (close > open)
    const isBullishBody = latest.close > latest.open;
    // 아래꼬리 돌파 실패 (아래꼬리 길이가 몸통보다 길거나 일정 비율 이상)
    const bodySize = Math.abs(latest.close - latest.open);
    const lowerTail = Math.min(latest.open, latest.close) - latest.low;
    const isLowerTailRejection = lowerTail > bodySize * 0.8 || (latest.low < prev.low && latest.close > prev.close);

    const ok = isCloseUp && (isHigherLow || isBullishBody || isLowerTailRejection);
    return {
      reversal_confirmed: ok,
      reject_reason: ok ? null : "RANGE_LOWER_LONG_NO_REVERSAL_CONFIRMATION",
      prev,
      latest
    };
  }
  return { reversal_confirmed: true, reject_reason: null, prev, latest };
}


/** @deprecated use PaperDecisionRejectReason from `../models/types` */
export type RejectReasonCode = PaperDecisionRejectReason;

export type PaperSymbolDecision = PaperSymbolDecisionRecord;

export type SymbolSnapshotLike = Readonly<{
  symbol: MarketSymbol;
  lastPrice: number;
  latestCandleClose: number;
  signal: PaperSignal;
  entryCandidate?: boolean;
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
  signalGateBlockedReason?: string | null;
  rangeSignalDowngraded?: boolean;
  rangeSignalKeptByRelax?: boolean;
  /** ?섏씠?⑥씠: ?〓낫 ?뺤떊??*/
  rangeConfidence?: number;
  /** ?섏씠?⑥씠: 諛뺤뒪 ?묒쭛??*/
  boxCohesion01?: number;
  /** ?섏씠?⑥씠: ?뚰뙆 ?ㅽ뙣??*/
  breakoutFailureRate?: number;
  /** ?섏씠?⑥씠: ?뺣났 鍮덈룄 */
  rangeOscillationScore?: number;
  /** ?섏씠?⑥씠: 異붿꽭 ?쎌꽦 */
  trendWeaknessScore?: number;
  /** ?섏씠?⑥씠: ?〓낫 ?먮떒 洹쇨굅 ?쇰꺼 */
  rangeReasonLabel?: string;
  /** ?섏씠?⑥씠: 諛뺤뒪 ?뺣났 ?꾩쟻 ?잛닔 */
  rangeCycleCount?: number;
  /** ?섏씠?⑥씠: 諛뺤뒪 ??遺꾪븷 吏꾩엯 ?④퀎 */
  rangeLadderLevel?: number;
  /** ?섏씠?⑥씠: RANGE ?댁젣 ?꾪뿕??*/
  regimeExitRisk?: number;
  /** ?섏씠?⑥씠: 諛뺤뒪 遺뺢눼 諛⑺뼢 */
  boxBreakSide?: "upper" | "lower" | "none";
  signal_strength?: "strong" | "ok" | "weak";
  trendOk?: boolean;
  /** ?섏씠?⑥씠: ?꾩옱 ?덉쭚 ?곹깭 */
  regimeStateDiag?: PaperRegimeState;
  /** Raw candles fetched from OKX */
  candles?: import("../models/types").Candle[];
  /** pollSymbol 1m kline 諛곗뿴 湲몄씠(?붿쭊 ?ㅻ깄?? */
  recentCandlesCount?: number;
  /** Highway 吏꾩엯??1m ?붿껌 limit (湲곕낯 120) */
  highwayKlineLimitRequested?: number;
  highwayEntryTf?: string;
  swingHighSlope?: number;
  swingLowSlope?: number;
  rangeCenterSlope?: number;
  boxHighSlope?: number;
  boxLowSlope?: number;
  ema20Slope?: number;
  ema60Slope?: number;
  atrExpansion?: number;
  volumeExpansion?: number;
  htf_candles?: Record<string, import("../models/types").Candle[]>;
}>;

export function paperTradeBlockDecompositionPayload(
  symbol: MarketSymbol,
  resNull: EvaluatePaperSymbolEntryResult,
  fields: {
    nowTick: number;
    regime: string;
    regimeUnknown: boolean;
    isAmbiguous: boolean;
    maxPositionsReached: boolean;
    paperMaxOpenPositions: number;
    openPositionsTotal: number;
    hasOpenForSymbol: boolean;
    dataReady: boolean;
    directionalShockState?: string;
  }
): Record<string, unknown> {
  const p = resNull.decision;
  return {
    symbol: String(symbol),
    final_decision: p.final_decision,
    reject_reason: p.reject_reason,
    reject_reason_original: (p as any).reject_reason_original,
    now: fields.nowTick,
    regime: fields.regime,
    regimeUnknown: fields.regimeUnknown,
    isAmbiguous: fields.isAmbiguous,
    maxPositionsReached: fields.maxPositionsReached,
    paperMaxOpenPositions: fields.paperMaxOpenPositions,
    openPositionsTotal: fields.openPositionsTotal,
    hasOpenForSymbol: fields.hasOpenForSymbol,
    dataReady: fields.dataReady,
    directionalShockState: fields.directionalShockState ?? "NONE"
  };
}

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

export function evaluateDirectionalTrendAddOnGuard(args: {
  config: EngineConfig;
  snapshot: SymbolSnapshotLike;
  risk: RiskControlDecision;
  regime: MarketRegime;
  side: "long" | "short";
  symbol: MarketSymbol;
  directionalOverride: any;
}): {
  allowed: boolean;
  reason: string;
  proof?: Record<string, unknown>;
} {
  const { directionalOverride, snapshot, side, symbol } = args;

  // 1. Check if directional routing is active
  if (!directionalOverride.directionalRoutingActive) {
    return { allowed: true, reason: "DIRECTIONAL_ROUTING_INACTIVE" };
  }

  // 2. Enforce Lane/Side Consistency (Symmetric)
  const bias = directionalOverride.directionalBias;
  const intendedSide = side; // In add-on, we are scaling the existing side
  const shock = directionalOverride.directional_shock_state || "NONE";

  if (bias !== "none" && intendedSide !== bias) {
    return {
      allowed: false,
      reason: `DIRECTIONAL_ADDON_LANE_MISMATCH (pos: ${intendedSide}, bias: ${bias}, shock: ${shock})`,
      proof: {
        symbol: symbol,
        side: side,
        bias,
        shock,
        effective_execution_lane: directionalOverride.effectiveExecutionLane,
        directional_addon_allowed: false
      }
    };
  }

  // 3. Check Cooldown (Directional specific)
  if (directionalOverride.addOnCooldownPassed === false) {
    return {
      allowed: false,
      reason: "DIRECTIONAL_ADDON_COOLDOWN_ACTIVE",
      proof: {
        symbol: symbol,
        side: side,
        bias,
        cooldown_passed: false,
        directional_addon_allowed: false
      }
    };
  }

  // 4. Stricter Trend Continuation Validation
  const qualityOk = snapshot.qualityScore >= 75;
  const trendOk = snapshot.trendOk === true;
  const emaAligned = side === "long"
    ? (snapshot.ema20 ?? 0) > (snapshot.ema60 ?? 0)
    : (snapshot.ema20 ?? 0) < (snapshot.ema60 ?? 0);
  const volumeOk = snapshot.volumeRatioProxy >= 1.25;

  const allowed = qualityOk && trendOk && emaAligned && volumeOk;

  const proof = {
    symbol: symbol,
    side: side,
    bias,
    shock,
    qualityScore: snapshot.qualityScore,
    qualityOk,
    trendOk,
    emaAligned,
    volumeRatioProxy: snapshot.volumeRatioProxy,
    volumeOk,
    effective_execution_lane: directionalOverride.effectiveExecutionLane,
    directional_addon_allowed: allowed
  };

  return {
    allowed,
    reason: allowed ? "DIRECTIONAL_ADDON_GUARD_PASS" : "DIRECTIONAL_ADDON_CONSERVATISM_BLOCK",
    proof
  };
}


/** Stage 1 ?뚯븸 ?먯깋: RANGE쨌紐⑦샇 留λ씫?먯꽌留??덉슜(荑⑤떎?는룸뜲?댄꽣 寃곗넀 ?깆? ?쒖쇅). */
const STAGE1_SOFT_EXPLORE_BLOCKS = new Set([
  "range_not_in_interest_zone",
  "range_center_forbidden",
  "range_low_quality_for_lead",
  "trend_not_in_pullback",
  "trend_direction_weak",
  "trend_low_quality",
  "trend_volume_too_thin"
]);

/** RANGE 諛뺤뒪 ??룹긽???먯? ??Stage 1留??뚰봽???덉슜 + 異붽? ?ъ씠利?異뺤냼. */
const STAGE1_RANGE_EDGE_SOFT_TAGS: Readonly<Record<string, string>> = {
  range_box_too_narrow: "STAGE1_EXPLORE_RANGE_BOX_NARROW",
  range_not_upper_edge: "STAGE1_EXPLORE_RANGE_EDGE_RELAXED",
  range_not_lower_edge: "STAGE1_EXPLORE_RANGE_EDGE_RELAXED"
};

/** 湲곗〈 Stage1 ?먯깋 諛곗닔 ?꾩뿉 ??踰???怨깊븿(?꾩＜ ?뚯븸). */
const STAGE1_RANGE_POSITION_SOFT_MULT = 0.42;

type RangeSignalState = "RANGE_LONG_CANDIDATE" | "RANGE_SHORT_CANDIDATE" | "RANGE_SIGNAL_NONE" | "RANGE_SIGNAL_WAIT_RECHECK";
type RangeGateResult =
  | "RANGE_GATE_PASS"
  | "RANGE_GATE_BLOCK_BOX_MIDDLE"
  | "RANGE_GATE_BLOCK_LOW_CONFIDENCE"
  | "RANGE_GATE_BLOCK_RISK_ENGINE"
  | "RANGE_GATE_BLOCK_REENTRY"
  | "RANGE_GATE_BLOCK_WAIT_RECHECK";
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
  rangeSignal: { signal: RangeSignalState; reason: string; side: "long" | "short" | null; interpretation?: any };
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

  const reversalInfo = rangeSignal.interpretation ?? { tier: "None", confidence_score: 0, reversal_size_mult: 1.0 };
  const tier = reversalInfo.tier;
  const confidenceScore = reversalInfo.confidence_score;

  const edge_subconditions = rangeStage0EdgeSubconditions(edge);
  const relaxedOscMin = Math.max(0.24, RANGE_STAGE0_EDGE_THRESHOLDS.oscillation - 0.06);
  const relaxedEdgeStructureOk =
    !edge.ok &&
    edge.conf >= RANGE_STAGE0_EDGE_THRESHOLDS.conf &&
    edge.cohesion >= RANGE_STAGE0_EDGE_THRESHOLDS.cohesion &&
    edge.oscillation >= relaxedOscMin;

  const branch_order_upper = [
    "0. reversalImmediate (Manual Override) ??strong_reversal",
    "1. paper_short_candidate (Base Signal) ??strong_reversal",
    "2. 3-Tier Reversal Confidence (Scoring Tier: Strong/Watch/Suppress) ??tiered_decision",
    "3. fallback ??suppress"
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
      `inner RANGE_SIGNAL_NONE from long suppress: (edgeStructureOk=${edge.ok}) and (upperExtremeEdge=${boxPos >= 0.74}) so step 2 did not return SHORT; step 3 matched raw long but reinterpretation failed; entryResult=${entryResult}`;
  } else if (rangeSignal.signal === "RANGE_SIGNAL_NONE" && rangeSignal.reason === "range_upper_short_structure_not_ready") {
    range_upper_short_priority_false_because =
      "edgeStructureOk false and raw not long candidate path ??structure_not_ready; short priority branch skipped";
  } else if (rangeSignal.signal === "RANGE_SHORT_CANDIDATE" && gateResult !== "RANGE_GATE_PASS") {
    range_upper_short_priority_false_because = `inner short candidate (${rangeSignal.reason}) but gate blocked: ${gateResult} / ${gateReason}`;
  } else if (rangeSignal.signal === "RANGE_SHORT_CANDIDATE" && lowConfidence && !rangeReversalSwitchMatches) {
    range_upper_short_priority_false_because =
      "inner short candidate but range score gate: lowConfidence && !rangeReversalSwitchMatches ??range_score_below_threshold";
  } else {
    range_upper_short_priority_false_because = `entryResult=${entryResult}, inner=${rangeSignal.signal}/${rangeSignal.reason}, gate=${gateResult}/${gateReason}, edgeOk=${edge.ok}, extreme=${boxPos >= 0.74}`;
  }
  const failedParts = edge_subconditions.filter((r) => !r.pass).map((r) => `${r.id}=${r.value_clamped_01.toFixed(3)}<${r.threshold_min}`);
  const one_line_summary =
    (!edge.ok && !relaxedEdgeStructureOk && rangeSignal.reason === "range_upper_suppress_long_candidate_no_inertia")
      ? `upper+raw_long: structure weak and not extreme_edge ??step3 suppress [${failedParts.join(", ") || edge.failed_checks.join(",")}]`
      : rangeSignal.signal === "RANGE_SHORT_CANDIDATE" && gateResult !== "RANGE_GATE_PASS"
        ? `upper: edgeStructureOk=true ??inner SHORT (${rangeSignal.reason}) but gate ${gateResult}: ${gateReason} ??short_priority_flag false`
        : rangeSignal.signal === "RANGE_SHORT_CANDIDATE" && lowConfidence && !rangeReversalSwitchMatches
          ? `upper: inner SHORT but lowConfidence scores blocked gate ??short_priority_flag false`
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

function calculateRangeReversalConfidenceTier(
  sn: SymbolSnapshotLike,
  boxPos: number,
  zone: RangeBoxZone,
  edgeOk: boolean,
  relaxedEdgeOk: boolean
): { score: number; tier: "strong" | "watch" | "suppress"; extreme: boolean } {
  let score = 0;
  if (edgeOk) score += 40;
  else if (relaxedEdgeOk) score += 20;

  const extremeBonus = zone === "upper" ? boxPos >= 0.74 : zone === "lower" ? boxPos <= 0.26 : false;
  if (extremeBonus) score += 25;

  const confWeight = Math.min(15, (sn.rangeConfidence ?? 0) * 33);
  const cohesionWeight = Math.min(10, (sn.boxCohesion01 ?? 0) * 40);
  const brkFailWeight = Math.min(5, (sn.breakoutFailureRate ?? 0) * 12);
  const trendWeakWeight = Math.min(5, (sn.trendWeaknessScore ?? 0) * 25);

  score += confWeight + cohesionWeight + brkFailWeight + trendWeakWeight;

  let tier: "strong" | "watch" | "suppress" = "suppress";
  if (score >= 75) tier = "strong";
  else if (score >= 45) tier = "watch";

  return { score, tier, extreme: extremeBonus };
}

function evaluateRangeStage0Signal(
  sn: SymbolSnapshotLike,
  reversalImmediate?: Readonly<{ preferredSide: "long" | "short" }> | null
): {
  signal: RangeSignalState;
  reason: string;
  side: "long" | "short" | null;
  interpretation?: {
    checked: boolean;
    passed: boolean;
    failed_reasons: string[];
    raw_side: "long" | "short" | "none";
    confidence_score?: number;
    tier?: "strong" | "watch" | "suppress";
    extreme_edge_bonus?: boolean;
    reversal_size_mult?: number;
  };
} {
  const boxPos = typeof sn.boxPos === "number" ? sn.boxPos : 0.5;
  const zone: RangeBoxZone = classifyRangeZone(boxPos);
  const interpretation: NonNullable<ReturnType<typeof evaluateRangeStage0Signal>["interpretation"]> = {
    checked: false,
    passed: false,
    failed_reasons: [],
    raw_side: sn.signal === "paper_long_candidate" ? "long" : sn.signal === "paper_short_candidate" ? "short" : "none"
  };

  if (reversalImmediate) {
    if (reversalImmediate.preferredSide === "short" && zone === "upper") {
      return {
        signal: "RANGE_SHORT_CANDIDATE",
        reason: "range_reversal_immediate_switch_upper_short",
        side: "short",
        interpretation
      };
    }
    if (reversalImmediate.preferredSide === "long" && zone === "lower") {
      return {
        signal: "RANGE_LONG_CANDIDATE",
        reason: "range_reversal_immediate_switch_lower_long",
        side: "long",
        interpretation
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
      return { signal: "RANGE_SHORT_CANDIDATE", reason: "range_upper_short_from_base_signal", side: "short", interpretation };
    }
    if (upperExtremeEdge && (edgeStructureOk || relaxedEdgeStructureOk)) {
      return { signal: "RANGE_SHORT_CANDIDATE", reason: "range_upper_short_priority_structure", side: "short", interpretation };
    }
    if (sn.signal === "paper_long_candidate") {
      interpretation.checked = true;
      const reversal = calculateRangeReversalConfidenceTier(sn, boxPos, "upper", edgeStructureOk, relaxedEdgeStructureOk);
      interpretation.confidence_score = reversal.score;
      interpretation.tier = reversal.tier;
      interpretation.extreme_edge_bonus = reversal.extreme;
      interpretation.reversal_size_mult =
        reversal.tier === "strong" ? (reversal.extreme ? 1.0 : 0.65) : 0.45;

      if (reversal.tier === "strong") {
        interpretation.passed = true;
        return {
          signal: "RANGE_SHORT_CANDIDATE",
          reason: "range_upper_short_from_long_reversal_strong_tier",
          side: "short",
          interpretation
        };
      } else if (reversal.tier === "watch") {
        // [V2 WATCH TIER RELAX] 1m 완성봉 반전이 이미 충족된 경우 숏 진입 허용 (사이즈 배수 축소)
        const conf = computeRangeEdgeReversalConfirmation({
          zone: "upper",
          entrySide: "short",
          candles: sn.candles ?? []
        });
        if (conf.reversal_confirmed) {
          interpretation.passed = true;
          interpretation.reversal_size_mult = 0.42; // sizeMultiplier 0.42 축소 진입
          return {
            signal: "RANGE_SHORT_CANDIDATE",
            reason: "range_upper_short_from_long_reversal_watch_tier_relaxed",
            side: "short",
            interpretation
          };
        }
        interpretation.passed = false;
        return {
          signal: "RANGE_SIGNAL_WAIT_RECHECK",
          reason: "range_upper_short_recheck_watch_tier",
          side: null,
          interpretation
        };
      }
      // PART 1: upper zone + weak tier long candidate -> strong base signal preservation
      if (sn.signal === "paper_long_candidate" && (sn.signal_strength === "strong" || sn.trendOk === true)) {
        return {
          signal: "RANGE_SIGNAL_WAIT_RECHECK",
          reason: "range_upper_long_candidate_preserved_despite_weak_reversal",
          side: null,
          interpretation
        };
      }
      return {
        signal: "RANGE_SIGNAL_WAIT_RECHECK",
        reason: "range_upper_recheck_weak_tier",
        side: null,
        interpretation
      };
    }
    return { signal: "RANGE_SIGNAL_NONE", reason: "range_upper_short_structure_not_ready", side: null, interpretation };
  }

  if (zone === "lower") {
    const lowerExtremeEdge = boxPos <= 0.26;
    if (sn.signal === "paper_long_candidate") {
      return { signal: "RANGE_LONG_CANDIDATE", reason: "range_lower_long_from_base_signal", side: "long", interpretation };
    }
    if (lowerExtremeEdge && (edgeStructureOk || relaxedEdgeStructureOk)) {
      return { signal: "RANGE_LONG_CANDIDATE", reason: "range_lower_long_priority_structure", side: "long", interpretation };
    }
    if (sn.signal === "paper_short_candidate") {
      interpretation.checked = true;
      const reversal = calculateRangeReversalConfidenceTier(sn, boxPos, "lower", edgeStructureOk, relaxedEdgeStructureOk);
      interpretation.confidence_score = reversal.score;
      interpretation.tier = reversal.tier;
      interpretation.extreme_edge_bonus = reversal.extreme;
      interpretation.reversal_size_mult =
        reversal.tier === "strong" ? (reversal.extreme ? 1.0 : 0.65) : 0.45;

      if (reversal.tier === "strong") {
        interpretation.passed = true;
        return {
          signal: "RANGE_LONG_CANDIDATE",
          reason: "range_lower_long_from_short_reversal_strong_tier",
          side: "long",
          interpretation
        };
      } else if (reversal.tier === "watch") {
        // [V2 WATCH TIER RELAX] 1m 완성봉 반전이 이미 충족된 경우 롱 진입 허용 (사이즈 배수 축소)
        const conf = computeRangeEdgeReversalConfirmation({
          zone: "lower",
          entrySide: "long",
          candles: sn.candles ?? []
        });
        if (conf.reversal_confirmed) {
          interpretation.passed = true;
          interpretation.reversal_size_mult = 0.42; // sizeMultiplier 0.42 축소 진입
          return {
            signal: "RANGE_LONG_CANDIDATE",
            reason: "range_lower_long_from_short_reversal_watch_tier_relaxed",
            side: "long",
            interpretation
          };
        }
        interpretation.passed = false;
        return {
          signal: "RANGE_SIGNAL_WAIT_RECHECK",
          reason: "range_lower_long_recheck_watch_tier",
          side: null,
          interpretation
        };
      }
      return { signal: "RANGE_SIGNAL_NONE", reason: "range_lower_suppress_short_candidate", side: null, interpretation };
    }
    return { signal: "RANGE_SIGNAL_NONE", reason: "range_lower_long_structure_not_ready", side: null, interpretation };
  }


  return { signal: "RANGE_SIGNAL_NONE", reason: "range_mid_wait_no_directional_chase", side: null, interpretation };
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
  /** ?꾩옱 ?대┛ ?ъ???諛⑺뼢(諛섏쟾 泥?궛 遺꾧린쨌proof??. ?놁쑝硫?null */
  openPositionSide?: "long" | "short" | null;
  /**
   * 援ш컙 諛섏쟾 泥?궛 吏곹썑 媛숈? ?굿톚ending 援ш컙?먯꽌 諛섎? 諛⑺뼢 ?ъ쭊?낆쓣 ?덉슜(荑⑤떎?는룹??좊ː 寃뚯씠???꾪솕).
   */
  rangeReversalImmediateSwitch?: Readonly<{
    preferredSide: "long" | "short";
    reason: "upper_flatten_to_short" | "lower_flatten_to_long" | "upper_flatten_to_short_pending" | "lower_flatten_to_long_pending";
  }> | null;
  regime: MarketRegime;
  /** BTC ?덉쭚 `detail` (NO_TRADE ?ъ쑀쨌marginal_history ??. */
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
  /** RANGE ?듭젅 ???ъ쭊????RANGE 荑⑤떎???고쉶(?붿쭊 ?먮떒). */
  rangeReopenCooldownBypass?: boolean;
  /** V2 Engine Authority ??expectancy bypass 寃곗젙?? */
  authority?: EntryExecutionAuthority;
  /** ?μ꽭 遺?곹빀 醫낅즺(EXIT_REGIME) ?뚮え ?대젰 (one-shot). */
  regimeExitConsumed?: { side: "long" | "short"; ts: number } | null;
  /** RANGE edge stop_loss ?ъ쭊??李⑤떒(?붿쭊 硫붾え由????먮떒 ?덉씠???꾨떖). */
  rangeStopReentryBlock?: RangeStopReentryBlock | null;
  /** 吏꾨떒??濡쒓굅 (Proof logging). */
  logger?: { info: (event: string, payload?: any) => void };
  /** `paper-engine` ?쇱슦??activeEngine ??internal V2 MODE瑜?envelope怨??숆린(RANGE 媛뺤젣 engine_v2). */
  routingActiveEngine?: PaperEngineRoutingKind | null;
}>;

/** ?곸쐞 ?쒖옣 紐⑤뱶쨌?붿쭊쨌?좉퇋 諛⑺뼢 ?덉슜 ???쒓렇???덉씠??TREND-UP ?뺣젹(???꾨낫 ?듭젣)??*/
export type PaperSignalMarketAlignmentContext = Readonly<{
  marketMode: PaperMarketMode;
  activeEngine: PaperEngineRoutingKind;
  allowNewLong: boolean;
  allowNewShort: boolean;
}>;

export type PaperSignalMarketAlignmentProofLogger = Readonly<{
  info: (event: string, payload?: Record<string, unknown>) => void;
}>;

function isTrendUpShortSuppressMarketGuard(
  risk: RiskControlDecision | null,
  ctx: PaperSignalMarketAlignmentContext
): boolean {
  if (risk == null) return false;
  if (risk.directionalShockState !== "UP") return false;
  if (ctx.marketMode !== "TREND" && ctx.activeEngine !== "TREND") return false;
  if (!ctx.allowNewLong || ctx.allowNewShort) return false;
  return true;
}

/**
 * ?곸쐞 TREND-UP + 濡??덉슜쨌???좉퇋 湲덉??????섏쐞 `paper_short_candidate`留?`none`?쇰줈 留욎텣??
 * ?뤴넂濡?媛뺤젣 蹂?섏? ?섏? ?딆쑝硫? ?덉쇅???곸쐞 shock/紐⑤뱶/allow ?뚮옒洹멸? 諛붾?寃쎌슦肉먯씠??
 */
export function applyPaperSignalMarketAlignment<T extends SymbolSnapshotLike>(input: Readonly<{
  snapshot: T;
  risk: RiskControlDecision | null;
  signalAlignmentContext: PaperSignalMarketAlignmentContext;
  adaptiveMode: FuturesMarketMode;
  marketSignalProofLogger?: PaperSignalMarketAlignmentProofLogger;
}>): T {
  const { snapshot, risk, signalAlignmentContext: ctx, adaptiveMode, marketSignalProofLogger } = input;
  const raw = snapshot.signal;
  const guardActive = isTrendUpShortSuppressMarketGuard(risk, ctx);
  const rangeStructureContext =
    snapshot.regimeStateDiag === "RANGE" &&
    (raw === "paper_long_candidate" || raw === "paper_short_candidate");
  const alignedDirectionCandidate: "long" | "short" | null =
    raw === "paper_long_candidate" ? "long" : raw === "paper_short_candidate" ? "short" : null;
  const isDirectionalShockUp = risk?.directionalShockState === "UP";
  const isDirectionalShockDown = risk?.directionalShockState === "DOWN";
  const pumpState = (risk as any)?.pumpState ?? null;
  const pump_state = (risk as any)?.pump_state ?? null;
  const resolved_pump_lock = pumpState === "PUMP_LOCK" || pump_state === "PUMP_LOCK";
  // PUMP_LOCK is treated as UP-bias (pump continuation), not a symmetric bias.
  const treatUpBias = isDirectionalShockUp || resolved_pump_lock;
  const treatDownBias = isDirectionalShockDown;
  const suppressByDirectionalShock =
    (treatUpBias && raw === "paper_short_candidate") ||
    (treatDownBias && raw === "paper_long_candidate");
  const preserveByRangeStructure =
    rangeStructureContext &&
    ((isDirectionalShockUp && raw === "paper_long_candidate") ||
      (isDirectionalShockDown && raw === "paper_short_candidate"));

  let alignmentApplied = false;
  let alignmentReason:
    | "TREND_UP_SUPPRESS_RANGE_SHORT"
    | "TREND_DOWN_SUPPRESS_RANGE_LONG"
    | "TREND_UP_KEEP_LONG"
    | "TREND_DOWN_KEEP_SHORT"
    | "NO_ALIGNMENT_APPLIED" =
    "NO_ALIGNMENT_APPLIED";
  let out: T = snapshot;

  if (suppressByDirectionalShock) {
    const emaGap = typeof snapshot.emaGap === "number" && Number.isFinite(snapshot.emaGap) ? snapshot.emaGap : 0;
    const trendOk = snapshot.trendOk === true;
    const qualityOk = typeof snapshot.qualityScore === "number" && Number.isFinite(snapshot.qualityScore) && snapshot.qualityScore >= 68;
    const crashOk = (risk as any)?.crashState !== "CRASH_LOCK";
    const allowLongNow = ctx.allowNewLong === true && (risk?.longAllow ?? true) === true;
    const allowShortNow = ctx.allowNewShort === true && (risk?.shortAllow ?? true) === true;
    const wantLongBreakout = treatUpBias && raw === "paper_short_candidate";
    const wantShortBreakout = treatDownBias && raw === "paper_long_candidate";
    const breakoutEligible =
      (wantLongBreakout && trendOk && emaGap > 0 && allowLongNow && qualityOk && crashOk) ||
      (wantShortBreakout && trendOk && emaGap < 0 && allowShortNow && qualityOk && crashOk);
    if (breakoutEligible) {
      out = {
        ...(snapshot as any),
        signal: wantLongBreakout ? "paper_long_candidate" : "paper_short_candidate",
        signalDecisionOrigin: "directional_shock_breakout_continuation",
        signalMissingReason: undefined,
        signalGateBlockedReason: undefined
      } as T;
      if (marketSignalProofLogger) {
        marketSignalProofLogger.info("DIRECTIONAL_SHOCK_BREAKOUT_SIGNAL_PROOF", {
          symbol: String(snapshot.symbol),
          pumpState,
          pump_state,
          resolved_pump_lock,
          raw_signal: raw,
          directional_shock_state: risk?.directionalShockState ?? "NONE",
          treat_up_bias: treatUpBias,
          treat_down_bias: treatDownBias,
          promoted_signal: (out as any).signal,
          signalDecisionOrigin: (out as any).signalDecisionOrigin ?? null,
          signalGateBlockedReason: (out as any).signalGateBlockedReason ?? null,
          signalMissingReason: (out as any).signalMissingReason ?? null,
          trendOk,
          ema_gap: emaGap,
          qualityScore: snapshot.qualityScore,
          allowLongNow,
          allowShortNow,
          crashOk,
          allow_new_long: ctx.allowNewLong,
          allow_new_short: ctx.allowNewShort,
          long_allow: risk?.longAllow ?? null,
          short_allow: risk?.shortAllow ?? null,
          crash_state: (risk as any)?.crashState ?? null,
          eligibility: { wantLongBreakout, wantShortBreakout, qualityOk }
        });
      }
    } else {
      out = {
        ...(snapshot as any),
        signal: "none",
        signalDecisionOrigin: "directional_shock_range_conflict_wait_pullback",
        signalMissingReason: "RANGE_DIRECTIONAL_SHOCK_CONFLICT_WAIT_PULLBACK",
        signalGateBlockedReason: "RANGE_DIRECTIONAL_SHOCK_CONFLICT_WAIT_PULLBACK"
      } as T;
      if (marketSignalProofLogger) {
        marketSignalProofLogger.info("RANGE_DIRECTIONAL_SHOCK_CONFLICT_PROOF", {
          symbol: String(snapshot.symbol),
          pumpState,
          pump_state,
          resolved_pump_lock,
          directional_shock_state: risk?.directionalShockState ?? "NONE",
          treat_up_bias: treatUpBias,
          treat_down_bias: treatDownBias,
          raw_signal: raw,
          final_signal: "none",
          signalDecisionOrigin: (out as any).signalDecisionOrigin ?? null,
          signalGateBlockedReason: (out as any).signalGateBlockedReason ?? null,
          signalMissingReason: (out as any).signalMissingReason ?? null,
          active_engine: ctx.activeEngine,
          market_mode: ctx.marketMode,
          boxPos: snapshot.boxPos ?? null,
          rangeConfidence: (snapshot as any).rangeConfidence ?? null,
          trendOk,
          ema_gap: emaGap,
          qualityScore: snapshot.qualityScore,
          allowLongNow,
          allowShortNow,
          crashOk,
          allow_new_long: ctx.allowNewLong,
          allow_new_short: ctx.allowNewShort,
          long_allow: risk?.longAllow ?? null,
          short_allow: risk?.shortAllow ?? null,
          crash_state: (risk as any)?.crashState ?? null,
          reject_reason: "RANGE_DIRECTIONAL_SHOCK_CONFLICT_WAIT_PULLBACK"
        });
      }
    }
    alignmentApplied = true;
    alignmentReason = raw === "paper_short_candidate"
      ? "TREND_UP_SUPPRESS_RANGE_SHORT"
      : "TREND_DOWN_SUPPRESS_RANGE_LONG";
  } else if (guardActive && raw === "paper_long_candidate") {
    alignmentReason = "TREND_UP_KEEP_LONG";
  } else if (preserveByRangeStructure) {
    alignmentReason = raw === "paper_long_candidate" ? "TREND_UP_KEEP_LONG" : "TREND_DOWN_KEEP_SHORT";
  }

  const shouldEmit =
    marketSignalProofLogger != null &&
    (raw === "paper_short_candidate" || raw === "paper_long_candidate" || alignmentApplied);

  if (shouldEmit && marketSignalProofLogger) {
    marketSignalProofLogger.info("SIGNAL_MARKET_ALIGNMENT_PROOF", {
      symbol: String(snapshot.symbol),
      directional_shock_state: risk?.directionalShockState ?? "NONE",
      market_mode: ctx.marketMode,
      active_engine: ctx.activeEngine,
      allow_new_long: ctx.allowNewLong,
      allow_new_short: ctx.allowNewShort,
      sideways_mode: adaptiveMode === "sideways",
      regime_state_diag: snapshot.regimeStateDiag ?? null,
      raw_signal_before_alignment: raw,
      signal_after_alignment: out.signal,
      alignment_applied: alignmentApplied,
      alignment_reason: alignmentReason,
      range_structure_context: rangeStructureContext,
      aligned_direction_candidate: alignedDirectionCandidate,
      alignment_preserved_by_range_structure: preserveByRangeStructure,
      alignment_suppressed_by_directional_shock: suppressByDirectionalShock
    });
  }

  return out;
}

export type EvaluatePaperSymbolEntryResult = Readonly<{
  decision: PaperSymbolDecision;
  intentSide: "long" | "short" | null;
  executorDecision: AnyEntryDecision | null;
  adaptiveOk: boolean;
  adaptiveDetail: Record<string, unknown> | null;
  adaptiveResult: Extract<FuturesAdaptiveEntryResult, { ok: true }> | null;
  /** `runFuturesAdaptiveEntry` ?ㅽ뙣 ???곸꽭(?뺤콉/?ъ씠利??④퀎). */
  adaptiveFailure?: Extract<FuturesAdaptiveEntryResult, { ok: false }>;
  /** True once the pipeline reaches adaptive (after AI approval). */
  aiGatePassed: boolean;
}>;

/** TREND adaptive 吏곸쟾: 蹂쇰ⅷ ?섑븳 ?꾪솕 ?곸슜 ?щ?쨌誘몄쟻???ъ쑀瑜?proof濡?怨좎젙. */
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
  fields: any
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
    final_reject_after_priority: fields.final_reject_after_priority,
    authority_decision: fields.authority_decision ?? null,
    authority_source: fields.authority_source ?? null,
    authority_side: fields.authority_side ?? null,
    authority_size_usd: fields.authority_size_usd ?? null,
    entry_quality_grade: fields.entry_quality_grade ?? null,
    leverage_profile: fields.leverage_profile ?? "BASE",
    applied_leverage: fields.applied_leverage ?? null,
    leverage_reason: fields.leverage_reason ?? null,
    leverage_block_reason: fields.leverage_block_reason ?? null,
    exposure_notional_krw: fields.exposure_notional_krw ?? null,
    equity_multiple: fields.equity_multiple ?? null,
    final_block_owner: fields.final_block_owner ?? null,
    adaptive_fail_stage: fields.adaptive_fail_stage ?? null,
    adaptive_fail_reason: fields.adaptive_fail_reason ?? null,
    directional_addon_proof: fields.directional_addon_proof ?? null,
    reject_reason_original: fields.reject_reason_original ?? null,
    effective_execution_lane: fields.effective_execution_lane ?? null,
    directional_shock_state: fields.directional_shock_state ?? null,
    directional_bias: fields.directional_bias ?? null,
    directional_routing_override_applied: fields.directional_routing_override_applied ?? false,
    directional_routing_override_reason: fields.directional_routing_override_reason ?? null,
    // [DIAG-V1] 진단 필드 — 진입 기준·주문 로직 변경 없음
    diag_long_candidate_created: fields.diag_long_candidate_created ?? null,
    diag_short_candidate_created: fields.diag_short_candidate_created ?? null,
    diag_long_rejected_reasons: fields.diag_long_rejected_reasons ?? null,
    diag_short_rejected_reasons: fields.diag_short_rejected_reasons ?? null,
    diag_btc_bias: fields.diag_btc_bias ?? null,
    diag_preferred_direction: fields.diag_preferred_direction ?? null,
    diag_range_signal_score: fields.diag_range_signal_score ?? null,
    diag_range_confidence: fields.diag_range_confidence ?? null,
    diag_box_cohesion01: fields.diag_box_cohesion01 ?? null,
    diag_range_oscillation_score: fields.diag_range_oscillation_score ?? null,
    diag_box_position: fields.diag_box_position ?? null,
    diag_breakout_failure_rate: fields.diag_breakout_failure_rate ?? null,
    diag_regime_exit_risk: fields.diag_regime_exit_risk ?? null,
    diag_reversal_confirmed: fields.diag_reversal_confirmed ?? null,
    diag_directional_guard_blocked: fields.diag_directional_guard_blocked ?? null,
    diag_risk_blocked: fields.diag_risk_blocked ?? null,
    diag_final_block_layer: fields.diag_final_block_layer ?? null,
    diag_final_block_reason: fields.diag_final_block_reason ?? null
  };
}

/** Internal candidate discovery for V2 authority when not injected from caller. */
function internalDiscoverV2Authority(input: EvaluatePaperSymbolEntryInput): EntryExecutionAuthority {
  const configuredV2Mode = parseEngineV2OpModeFromEnv(process.env.ORBITALPHA_ENGINE_V2_MODE);
  const rangeLaneForcesV2 =
    input.regime === "RANGE" || input.routingActiveEngine === "RANGE";
  const v2Mode = rangeLaneForcesV2 ? "engine_v2" : configuredV2Mode;
  const sn = input.snapshot;
  if (!sn) {
    return { decision: "HOLD", source: "v2", side: "none", stageMarginKrw: 0, regime: "UNKNOWN", stopPrice: null, invalidationPx: null };
  }

  const v2Env = resolveSymbolDecisionEnvelope({
    symbol: sn.symbol,
    fetchedAt: input.now,
    snapshot: {
      lastPrice: sn.lastPrice,
      latestCandleClose: sn.latestCandleClose,
      boxHigh: sn.boxHigh ?? 0,
      boxLow: sn.boxLow ?? 0,
      boxPos: sn.boxPos ?? 0.5,
      rangeConfidence: sn.rangeConfidence ?? 0.5,
      breakoutFailureRate: sn.breakoutFailureRate ?? 0,
      trendWeaknessScore: sn.trendWeaknessScore ?? 0,
      rangeOscillationScore: sn.rangeOscillationScore ?? 0,
      ema20: sn.ema20 ?? 0,
      emaGap: sn.emaGap ?? 0,
      atr: sn.atr ?? 0,
      signal: sn.signal ?? "NONE",
      qualityScore: sn.qualityScore ?? 0,
      swingHighSlope: sn.swingHighSlope ?? 0,
      swingLowSlope: sn.swingLowSlope ?? 0,
      rangeCenterSlope: sn.rangeCenterSlope ?? 0,
      boxHighSlope: sn.boxHighSlope ?? 0,
      boxLowSlope: sn.boxLowSlope ?? 0,
      ema20Slope: sn.ema20Slope ?? 0,
      ema60Slope: sn.ema60Slope ?? 0,
      atrExpansion: sn.atrExpansion ?? 0,
      volumeExpansion: sn.volumeExpansion ?? 0,
      candles: sn.candles ?? [],
      htf_candles: sn.htf_candles
    },
    legacy: {
      regime: input.regime,
      finalDecision: "SKIP",
      rejectReason: "v2_dry_run_candidate",
      requiredCostUsd: 0,
      entryAllowed: false,
      executorLabel: "none",
      intentSide: null,
      adaptiveOk: false
    },
    config: {
      baseSizeUsd: computePaperSizingAnchorUsd(input.config),
      maxOpenPositions: input.config.paperMaxOpenPositions,
      reentryCooldownMs: input.config.paperReentryCooldownMs,
      okxLiveMaxOrderNotionalUsdt: input.config.okxLiveMaxOrderNotionalUsdt ?? 0
    },
    state: {
      currentPositions: [], // Dry run only
      globalRiskScore: 0.5,
      lossStreaks: input.risk?.recentLossStreakByMode ?? {},
      directionalShockState: input.risk?.directionalShockState ?? "NONE",
      longAllow: input.risk?.longAllow ?? true,
      shortAllow: input.risk?.shortAllow ?? true,
      executionReadiness: true,
      freshTickBarrierActive: false,
      freshTickExecutionBlocked: false,
      freshTickCompletedCycles: 2,
      freshTickRequiredCycles: 2,
      serverTradeEnabled: true,
      closeOnlyMode: false,
      killSwitch: false,
      reconcileSafeMode: false,
      killSwitchActive: false,
      reconcileSafeModeActive: false,
      accountEquityKrw: 500_000,
      maxUsableMarginKrw: 420_000,
      exposureNotionalCapKrw: 2_000_000,
      symbolExposureNotionalCapKrw: 1_400_000
    },
    v2Mode
  });

  return v2Env.authority;
}

/**
 * Pipeline: DATA ??SIGNAL ??REGIME ??EDGE ??RISK ??EXECUTION ??AI ??ADAPTIVE.
 */
export function evaluatePaperSymbolEntry(input: EvaluatePaperSymbolEntryInput): EvaluatePaperSymbolEntryResult {
  const slipFrac = (Math.max(0, input.config.paperSlippageBps) / 10_000) * 2;
  const safety = 0.0001;
  const slippage_buffer_pct = slipFrac * 100;
  const safety_margin_pct = safety * 100;
  const emMode = input.config.paperEngineMode;

  const supplemental_reasons: string[] = [];

  const sn = input.snapshot;
  if (!sn) {
    return {
      decision: pack(input, "UNKNOWN" as MarketSymbol, null, {
        signal_state: "NONE",
        regime_state: "UNKNOWN",
        edge_state: "FAIL_EXPECTANCY", // Placeholder
        risk_state: "PASS",
        execution_state: "PAPER_READY",
        final_decision: "DISABLED",
        reject_reason: "DATA_NOT_READY",
        stage1_result_code: "STAGE1_BLOCKED_DATA"
      } as any),
      intentSide: null,
      executorDecision: null,
      adaptiveOk: false,
      adaptiveDetail: null,
      adaptiveResult: null,
      aiGatePassed: false
    };
  }
  const sym = sn.symbol;


  const authority = input.authority || internalDiscoverV2Authority(input);
  const v2AuthorityOwnsExecution =
    authority.decision === "ENTER" &&
    authority.source === "v2" &&
    (authority.side === "long" || authority.side === "short") &&
    (authority.stageMarginKrw ?? 0) > 0;

  // --- 4. Decision State Accumulators (Hoisted to avoid scoping/TDZ issues) ---
  let em: number | null = null;
  let signal_state: PaperSignalState = signalToState(sn.signal);
  let regime_state: PaperRegimeState = regimeToState(input.regime, input.regimeUnknown);
  const originalRegimeState = regime_state;
  let overrideRegime: MarketRegime = input.regime;

  // --- [V2 HARDENING] Directional Shock Regime Override ---
  // If we are in a directional shock state, we must override the generic "RANGE" or "TREND"
  // to descriptive directional states to prevent misclassification and ensure directional safety.
  if (input.risk?.directionalShockState === "DOWN") {
    if (regime_state === "RANGE") {
      regime_state = "DOWN_SHOCK_CONSOLIDATION";
    } else if (regime_state === "TREND") {
      regime_state = "TREND_DOWN";
    } else if (regime_state === "UNKNOWN") {
      regime_state = "SHOCK_DOWN";
    }
  } else if (input.risk?.directionalShockState === "UP") {
    if (regime_state === "TREND") {
      regime_state = "TREND_UP";
    } else if (regime_state === "UNKNOWN") {
      regime_state = "SHOCK_UP";
    }
    // Note: UP-bias in RANGE is often still just RANGE or handled by breakout continuation,
    // but we can add SHOCK_UP if needed for transparency.
  }

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
  let aiGatePassed = false;
  let adaptiveOk = false;
  let adaptiveResult: any = null;
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
  let stage1_block_origin: string | null = null;
  let legacy_block_reason: string | null = null;
  let legacy_regime_gate: string | null = null;
  let legacy_gate_source: string | null = null;
  let override_by_legacy = false;
  let reentry_cooldown_applied = false;
  let reentry_cooldown_original_ms: number | null = null;
  let reentry_cooldown_effective_ms: number | null = null;
  let reentry_cooldown_reason: string | null = null;

  let risk_cooldown_subreason: string | null = null;
  let cooldown_remaining_ms: number | null = null;
  let same_dir_cooldown_applied = false;
  let blocked_regime_reason: string | null = null;
  let reentry_wait_ms: number | null = null;
  let reentry_elapsed_ms: number | null = null;
  let range_long_only_short_deferred_applied = false;
  let range_long_only_short_deferred_bypassed = false;
  let stage1LoosenedEntry = false;
  let costWarningStage1 = false;
  let stage1ExploreSoftExec = false;
  let stage1HigherTfBypassSizeMult: number | null = null;
  let stage1RangeLowerEdgeSoftSizeMult: number | null = null;
  let stage1RangeEdgeSoftApplied = false;
  let stage1SoftExecOverrideFlag = false;
  let fixedUsd: number | null = null;
  let expectedMoveUsd: number | null = null;
  let requiredCostUsd: number | null = null;
  let shortfallUsd: number | null = null;
  let executorBlockReasonOriginal: string | null = null;
  let totalCost: number | null = null;
  let effectiveTotalCost: number | null = null;
  let stage1SizeMultFinal: number | null = null;
  let range_executor_priority_applied = false;
  let range_executor_priority_reason: string | null = null;

  // New hoists for resolving compilation errors
  let useFixedCost = false;
  let rangeSignal: any = null;
  let rangeScores: any = null;
  let boxPos = 0.5;
  let zone: any = null;
  let crashLockBypassApplied = false;
  let crashLockBypassReason: string | null = null;
  let crashLockBypassSizeMult = 1.0;
  let lowConfidenceSignalMin = 0.34;
  let lowConfidenceEntryMin = 0.36;
  let lowConfidence = false;
  let edgeRelaxZoneForConfidence = false;
  let gateResult: any = null;
  let gateReason = "";
  let entryResult: any = null;
  let rangeReversalTier = "None";
  let rangeReversalSizeMult = 1.0;
  let rangeReversalConfidence = 0;
  let waitMs = 0;
  let rangeStopReentrySameContextBlock = false;
  let rangeStopReentryRejectOverride: PaperDecisionRejectReason | null = null;
  let rangeEdgeConfirmationReject: PaperDecisionRejectReason | null = null;

  // [DIAG-V1] 진단 변수 — 진입 기준·주문 로직 변경 없음
  let diag_long_candidate_created: boolean | null = null;
  let diag_short_candidate_created: boolean | null = null;
  let diag_long_rejected_reasons: string[] = [];
  let diag_short_rejected_reasons: string[] = [];
  let diag_btc_bias: "up" | "down" | "flat" | null = null;
  let diag_preferred_direction: "long" | "short" | "none" | null = null;
  let diag_range_signal_score: number | null = null;
  let diag_range_confidence: number | null = null;
  let diag_box_cohesion01: number | null = null;
  let diag_range_oscillation_score: number | null = null;
  let diag_box_position: number | null = null;
  let diag_breakout_failure_rate: number | null = null;
  let diag_regime_exit_risk: number | null = null;
  let diag_reversal_confirmed: boolean | null = null;
  let diag_directional_guard_blocked: boolean | null = null;
  let diag_risk_blocked: boolean | null = null;
  let diag_final_block_layer: string | null = null;
  let diag_final_block_reason: string | null = null;


  const directionalGuardResult = evaluateDirectionalTrendEntryGuard({
    rawRegime: input.regime,
    directionalShockState: input.risk?.directionalShockState ?? "NONE",
    signal: sn.signal,
    rangeReversalImmediateSwitch: input.rangeReversalImmediateSwitch
  } as any);

  if (directionalGuardResult.blocked) {
    diag_directional_guard_blocked = true;
    diag_final_block_layer = "directional_guard_tier0";
    diag_final_block_reason = directionalGuardResult.blockedReason ?? "DIRECTIONAL_BIAS_BLOCKED";
    diag_long_candidate_created = sn.signal === "paper_long_candidate";
    diag_short_candidate_created = sn.signal === "paper_short_candidate";
    if (sn.signal === "paper_long_candidate") diag_long_rejected_reasons = [diag_final_block_reason];
    if (sn.signal === "paper_short_candidate") diag_short_rejected_reasons = [diag_final_block_reason];
    diag_box_position = typeof sn.boxPos === "number" ? sn.boxPos : null;
    diag_range_confidence = sn.rangeConfidence ?? null;
    diag_box_cohesion01 = sn.boxCohesion01 ?? null;
    diag_range_oscillation_score = sn.rangeOscillationScore ?? null;
    diag_breakout_failure_rate = sn.breakoutFailureRate ?? null;
    diag_regime_exit_risk = sn.regimeExitRisk ?? null;
    return {
      decision: pack(input, sym, null, {
        signal_state,
        regime_state,
        edge_state: "PASS",
        risk_state: "PASS",
        execution_state: "DISABLED",
        final_decision: "DISABLED",
        reject_reason: "DIRECTIONAL_BIAS_BLOCKED" as any,
        stage1_result_code: "STAGE1_BLOCKED_RISK",
        final_fail_reason: directionalGuardResult.blockedReason,
        execution_disabled_reason: "directional_bias_blocked",
        final_block_owner: "directional_guard",
        execution_disabled_top_proof: directionalGuardResult.proof,
        // [DIAG-V1]
        diag_long_candidate_created,
        diag_short_candidate_created,
        diag_long_rejected_reasons: diag_long_rejected_reasons.length > 0 ? diag_long_rejected_reasons : null,
        diag_short_rejected_reasons: diag_short_rejected_reasons.length > 0 ? diag_short_rejected_reasons : null,
        diag_directional_guard_blocked,
        diag_final_block_layer,
        diag_final_block_reason,
        diag_box_position,
        diag_range_confidence,
        diag_box_cohesion01,
        diag_range_oscillation_score,
        diag_breakout_failure_rate,
        diag_regime_exit_risk
      } as any),
      intentSide: null,
      executorDecision: null,
      adaptiveOk: false,
      adaptiveDetail: null,
      adaptiveResult: null,
      aiGatePassed: false
    };
  }

  const shouldBypassRangeStage0 = directionalGuardResult.shouldBypassRangeStage0;
  let elapsedMs = 0;
  let meta: any = null;
  let sameDirection = false;
  let severeRiskLock: boolean = false;
  let stage1SignalRelaxed = false;
  let signalRelaxReason: string | null = null;
  let edgeStructureOkCurrent = false;
  let edgeGateCurrent: any = null;
  let stage1SoftCandidateMicroEnter = false;
  let stage1CostSoftBypassApplied = false;
  let stage1CostSoftBypassReason: string | null = null;
  let useRangeStage0Engine = false;
  let reentryBlocked = false;
  let riskEngineBlocked = false;
  let blockedRegimeActive = false;
  let blockedRegimeLossStreakSuspend = false;
  let freshReentryCandidate = false;
  let noOpenPos = false;
  let hasBaseCandidate = false;
  let hasStrongBaseSignal = false;
  let hardBlockedForSoftPass = false;
  let scoringRegime: any = null;
  let rangeStage0ContextExpected = false;
  let aiForHighway: any = null;
  let skipHighwayExecutorCall = false;
  let trendBoxEdgeBufferEligible = false;
  let z: any = null;
  let _entryIntent: any = null;

  let blockedRegime: any = null;
  let blockedRegimeReasonText = "";
  let rangeRiskRelaxEligible = false;
  let riskEngineHardBlocked = false;
  let riskEngineBlockedBySuspendOnly = false;
  let isRangeLowerLong = false;
  let hasQuality = false;
  let extremeLower = false;
  let prioritySignalAligned = false;
  let noOpenPositionFreshEntry = false;
  let rangeLowerEdge = false;
  let rangeExitRiskOk = false;
  let rangeConfidenceOk = false;
  let rangeBreakoutFailureOk = false;
  let rangeSameDirBaseEligible = false;
  let rangeReversalSwitchMatches = false;

  // --- 5. Directional Routing Override Calculation ---
  const directionalOverride: any = deriveDirectionalRoutingOverride({
    rawRegime: overrideRegime,
    directionalShockState: input.risk?.directionalShockState ?? "NONE"
  });

  // --- 6. Packaging Helpers (Restored) ---
  const extra: any = {};
  const ret = (patch: any, res: any = {}): EvaluatePaperSymbolEntryResult => {
    Object.assign(extra, patch);
    return {
      decision: pack(input, sym, em, {
        signal_state: (extra.signal_state ?? signal_state) as any,
        regime_state: (extra.regime_state ?? regime_state) as any,
        edge_state: (extra.edge_state ?? edge_state) as any,
        risk_state: (extra.risk_state ?? risk_state) as any,
        execution_state: (extra.execution_state ?? execution_state) as any,
        final_decision: (extra.final_decision ?? final_decision) as any,
        reject_reason: (extra.reject_reason ?? reject_reason) as any,
        expected_move_pct: "expected_move_pct" in extra ? extra.expected_move_pct : expected_move_pct,
        fee_estimate_pct: "fee_estimate_pct" in extra ? extra.fee_estimate_pct : fee_estimate_pct,
        slippage_buffer_pct,
        safety_margin_pct,
        rr: "rr" in extra ? extra.rr : rr,
        atr_pct: "atr_pct" in extra ? extra.atr_pct : atr_pct,
        strategy_executor: (extra.strategy_executor ?? strategy_executor) as any,
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
        supplemental_reasons: extra.supplemental_reasons ?? (supplemental_reasons || []),
        is_ambiguous: extra.is_ambiguous ?? false,
        stage1_loosened_entry: extra.stage1_loosened_entry ?? stage1LoosenedEntry,
        ai_floor_relaxed: extra.ai_floor_relaxed ?? false,
        auto_entry_triggered: extra.auto_entry_triggered !== undefined ? extra.auto_entry_triggered : input.autoEntryTriggered,
        reviewing_ticks: extra.reviewing_ticks !== undefined ? extra.reviewing_ticks : input.reviewingTicks,
        stage1_result_code: extra.stage1_result_code ?? (stage1ResultCodeOverride ?? "STAGE0_ENTERED"),
        final_fail_reason: extra.final_fail_reason ?? null,
        entry_blocked: extra.entry_blocked ?? null,
        range_executor_priority_applied: extra.range_executor_priority_applied ?? range_executor_priority_applied,
        range_executor_priority_reason: extra.range_executor_priority_reason ?? range_executor_priority_reason,
        final_executor_before_priority: extra.final_executor_before_priority ?? final_executor_before_priority,
        final_executor_after_priority: extra.final_executor_after_priority ?? final_executor_after_priority,
        final_reject_before_priority: extra.final_reject_before_priority ?? final_reject_before_priority,
        final_reject_after_priority: extra.final_reject_after_priority ?? final_reject_after_priority,
        range_stage0_engine_taken: extra.range_stage0_engine_taken ?? range_stage0_engine_taken,
        range_stage0_exit_reason: extra.range_stage0_exit_reason ?? range_stage0_exit_reason,
        legacy_executor_path_taken: extra.legacy_executor_path_taken ?? legacy_executor_path_taken,
        required_move_pct: "required_move_pct" in extra ? extra.required_move_pct : required_move_pct,
        shortfall_pct: "shortfall_pct" in extra ? extra.shortfall_pct : (shortfall_pct ?? 0),
        signal_missing_reason: extra.signal_missing_reason ?? (sn?.signalMissingReason ?? null),
        box_position_diag: "box_position_diag" in extra ? extra.box_position_diag : (sn?.boxPos ?? 0.5),
        ema_gap_diag: "ema_gap_diag" in extra ? extra.ema_gap_diag : (sn?.emaGap ?? 0),
        volatility_proxy_diag: "volatility_proxy_diag" in extra ? extra.volatility_proxy_diag : (sn?.volumeRatioProxy ?? 1),
        stage1_leniency_applied: extra.stage1_leniency_applied ?? stage1_leniency_applied,
        cost_warning_applied: extra.cost_warning_applied ?? costWarningStage1,
        stage1_size_reduced_due_to_cost: extra.stage1_size_reduced_due_to_cost ?? false,
        post_entry_cost_guard: extra.post_entry_cost_guard ?? false,
        fixed_total_cost_usd: extra.fixed_total_cost_usd !== undefined ? extra.fixed_total_cost_usd : fixedUsd,
        expected_move_usd: extra.expected_move_usd !== undefined ? extra.expected_move_usd : expectedMoveUsd,
        required_cost_usd: extra.required_cost_usd !== undefined ? extra.required_cost_usd : requiredCostUsd,
        shortfall_usd: extra.shortfall_usd !== undefined ? extra.shortfall_usd : shortfallUsd,
        executor_block_reason_original: extra.executor_block_reason_original !== undefined ? extra.executor_block_reason_original : executorBlockReasonOriginal,
        stage1_soft_exec_override: extra.stage1_soft_exec_override !== undefined ? extra.stage1_soft_exec_override : stage1SoftExecOverrideFlag,
        stage1_size_multiplier_final: "stage1_size_multiplier_final" in extra ? extra.stage1_size_multiplier_final : (input.currentStage === 0 ? stage1SizeMultFinal : null),
        authority_decision: extra.authority_decision ?? (authority?.decision || "HOLD"),
        authority_source: extra.authority_source ?? (authority?.source || "unknown"),
        authority_side: extra.authority_side ?? (authority?.side || "none"),
        authority_stage_margin_krw: extra.authority_stage_margin_krw ?? (authority?.stageMarginKrw || 0),
        authority_size_usdt: extra.authority_size_usdt ?? ((authority?.stageMarginKrw || 0) / 1400),
        entry_quality_grade: extra.entry_quality_grade ?? (authority?.entryQualityGrade ?? null),
        leverage_profile: extra.leverage_profile ?? (authority?.leverageProfile ?? "BASE"),
        applied_leverage: extra.applied_leverage ?? (authority?.appliedLeverage ?? null),
        leverage_reason: extra.leverage_reason ?? (authority?.leverageReason ?? null),
        leverage_block_reason: extra.leverage_block_reason ?? (authority?.leverageBlockReason ?? null),
        exposure_notional_krw: extra.exposure_notional_krw ?? (authority?.exposureNotionalKrw ?? null),
        equity_multiple: extra.equity_multiple ?? (authority?.equityMultiple ?? null),
        effective_execution_lane: (extra.effective_execution_lane ?? directionalOverride?.effective_execution_lane) || null,
        directional_shock_state: (extra.directional_shock_state ?? directionalOverride?.directional_shock_state) || "NONE",
        directional_bias: (extra.directional_bias ?? directionalOverride?.directional_bias) || "none",
        directional_routing_override_applied: extra.directional_routing_override_applied ?? directionalOverride?.directional_routing_override_applied,
        directional_routing_override_reason: extra.directional_routing_override_reason ?? directionalOverride?.reason,
        regime_original_state: extra.regime_original_state ?? originalRegimeState,
        regime_fallback_applied: extra.regime_fallback_applied ?? regimeFallbackApplied,
        regime_fallback_reason: extra.regime_fallback_reason ?? regimeFallbackReason,
        // [DIAG-V1] 진단 필드 연계 바인딩
        diag_long_candidate_created: extra.diag_long_candidate_created ?? diag_long_candidate_created,
        diag_short_candidate_created: extra.diag_short_candidate_created ?? diag_short_candidate_created,
        diag_long_rejected_reasons: extra.diag_long_rejected_reasons ?? (diag_long_rejected_reasons.length > 0 ? diag_long_rejected_reasons : null),
        diag_short_rejected_reasons: extra.diag_short_rejected_reasons ?? (diag_short_rejected_reasons.length > 0 ? diag_short_rejected_reasons : null),
        diag_btc_bias: extra.diag_btc_bias ?? diag_btc_bias,
        diag_preferred_direction: extra.diag_preferred_direction ?? diag_preferred_direction,
        diag_range_signal_score: extra.diag_range_signal_score ?? diag_range_signal_score,
        diag_range_confidence: extra.diag_range_confidence ?? diag_range_confidence,
        diag_box_cohesion01: extra.diag_box_cohesion01 ?? diag_box_cohesion01,
        diag_range_oscillation_score: extra.diag_range_oscillation_score ?? diag_range_oscillation_score,
        diag_box_position: extra.diag_box_position ?? diag_box_position,
        diag_breakout_failure_rate: extra.diag_breakout_failure_rate ?? diag_breakout_failure_rate,
        diag_regime_exit_risk: extra.diag_regime_exit_risk ?? diag_regime_exit_risk,
        diag_reversal_confirmed: extra.diag_reversal_confirmed ?? diag_reversal_confirmed,
        diag_directional_guard_blocked: extra.diag_directional_guard_blocked ?? diag_directional_guard_blocked,
        diag_risk_blocked: extra.diag_risk_blocked ?? diag_risk_blocked,
        diag_final_block_layer: extra.diag_final_block_layer ?? diag_final_block_layer,
        diag_final_block_reason: extra.diag_final_block_reason ?? diag_final_block_reason
      }),
      ...res
    };
  };


  // --- 7. Ultimate Directional Guard Early Exit ---
  const incomingSide = sn.signal === "paper_long_candidate" ? "long" : sn.signal === "paper_short_candidate" ? "short" : "none";
  if (directionalOverride.directional_routing_override_applied) {
    const bias = directionalOverride.directional_bias;
    const isMismatched = (bias === "short" && incomingSide === "long") || (bias === "long" && incomingSide === "short");

    if (isMismatched || directionalOverride.reason.includes("BLOCKED")) {
      const blockReasonStr = incomingSide === "long" ? "DIRECTIONAL_LONG_BLOCK" : incomingSide === "short" ? "DIRECTIONAL_SHORT_BLOCK" : "DIRECTIONAL_BIAS_BLOCKED";
      return ret({
        signal_state: signalToState(sn.signal),
        final_decision: "DISABLED",
        reject_reason: blockReasonStr as any,
        execution_disabled_reason: "directional_bias_blocked",
        final_block_owner: "directional_guard",
        execution_disabled_top_proof: {
          symbol: String(sym),
          shock: directionalOverride.directional_shock_state,
          bias: directionalOverride.directional_bias,
          incoming_signal: sn.signal,
          override_reason: directionalOverride.reason
        },
        directional_routing_override_applied: true,
        directional_routing_override_reason: directionalOverride.reason
      }, {
        intentSide: (incomingSide === "none" ? null : incomingSide) as any,
        executorDecision: null,
        adaptiveOk: false,
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      });
    }

    if (directionalOverride.allowTrendOverride && overrideRegime === "RANGE") {
      overrideRegime = "TREND";
      regime_state = "TREND";
      (sn as any).directionalRoutingApplied = true;
    }

    if (input.currentStage >= 1 && input.hasOpenPosition && input.openPositionSide) {
      const addOnGuard = evaluateDirectionalTrendAddOnGuard({
        config: input.config,
        snapshot: sn,
        risk: input.risk!,
        regime: overrideRegime,
        side: input.openPositionSide,
        symbol: sym as MarketSymbol,
        directionalOverride
      });

      if (!addOnGuard.allowed) {
        return ret({
          signal_state: signalToState(sn.signal),
          final_decision: "DISABLED",
          reject_reason: "DIRECTIONAL_ADDON_BLOCKED",
          execution_disabled_reason: "directional_addon_mismatch",
          final_block_owner: "directional_addon_guard",
          directional_addon_proof: addOnGuard.proof,
          directional_routing_override_applied: true,
          directional_routing_override_reason: addOnGuard.reason
        }, {
          intentSide: (input.openPositionSide === ("none" as any) ? null : input.openPositionSide) as any,
          executorDecision: null,
          adaptiveOk: false,
          adaptiveDetail: null,
          adaptiveResult: null,
          aiGatePassed: false
        });
      }
    }
  }

  // Working metrics and intermediate states (already partially hoisted, consolidating remaining)
  // Working metrics and intermediate states consolidated
  let reentryBlocked_local_deprecated: boolean = false; // Placeholder if needed by other legacy code, but we use top scope
  let lowConfidence_local: boolean = false;
  let gateResult_local: any = "RANGE_GATE_PASS";
  let gateReason_local: string = "range_gate_pass";
  let entryResult_local: any = "RANGE_ENTRY_NONE";

  rangeReversalTier = "None";
  rangeReversalSizeMult = 1.0;
  rangeReversalConfidence = 0;


  const rm = sn?.gateRequiredMove;
  const emFromSn = sn?.gateExpectedMove ?? null;
  em = emFromSn;

  let leniency = 1.0;
  if (input.currentStage === 0) {
    if (input.regime === "TREND") leniency *= 0.65;
    else if (input.regime === "RANGE") leniency *= 0.75;
  }

  stage1_leniency_applied = input.currentStage === 0 && leniency < 1.0;

  const refNotionalUsd = computePaperSizingAnchorUsd(input.config);
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


  // --- 8. Core Pipeline Routing & Execution ---
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
        /** ?좏샇 遺?ъ? 援щ텇: ?쒖꽭/罹붾뱾 ???쒖옣 ?곗씠??誘몄?鍮꾨쭔 */
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
      { intentSide: null, executorDecision: null, adaptiveOk: false, adaptiveDetail: null, adaptiveResult: null, aiGatePassed: false }
    );
  }
  signal_state = signalToState(sn.signal);
  intentSide = (sn.signal === "paper_long_candidate") ? "long" : (sn.signal === "paper_short_candidate" ? "short" : "none") as any;
  workingSignal = sn.signal as any;

  const contextRangeDiag = sn.regimeStateDiag === "RANGE";
  const hasRangeContextMetrics = (sn.rangeConfidence ?? 0) >= 0.3 && (sn.boxCohesion01 ?? 0) >= 0.25;
  isRangeFallbackActive = contextRangeDiag && hasRangeContextMetrics && input.regime !== "NO_TRADE";

  useRangeStage0Engine =
    !v2AuthorityOwnsExecution &&
    !directionalGuardResult.blocked &&
    !shouldBypassRangeStage0 &&
    ((sn as any).directionalRoutingApplied ? false : (overrideRegime === "RANGE" || isRangeFallbackActive)) &&
    input.currentStage === 0;

  if (overrideRegime === "RANGE") {
    console.log("STAGE_ROUTING_BOTTLENECK_PROOF", {
      symbol: String(sn.symbol),
      currentStage: input.currentStage,
      hasOpenPosition: input.hasOpenPosition,
      isRangeFallbackActive,
      v2AuthorityOwnsExecution,
      authority_decision: authority.decision,
      authority_source: authority.source,
      authority_side: authority.side,
      authority_stage_margin_krw: authority.stageMarginKrw,
      authority_size_usdt: (authority.stageMarginKrw ?? 0) / 1400,
      useRangeStage0Engine,
      classify: v2AuthorityOwnsExecution
        ? "range_stage0_blocked_by_v2_authority"
        : useRangeStage0Engine
          ? "range_stage0_eligible"
          : "range_stage0_bypassed_by_stage"
    });
  }

  if (useRangeStage0Engine) {
    if (isRangeFallbackActive && input.regime !== "RANGE") {
      supplemental_reasons.push(`[RANGE_PRIORITY_FALLBACK] regime=${input.regime},diag=${sn.regimeStateDiag},conf=${sn.rangeConfidence}`);
    }
    range_stage0_engine_taken = true;
    strategy_executor = "RANGE";
    rangeSignal = evaluateRangeStage0Signal(sn, input.rangeReversalImmediateSwitch);
    rangeScores = evaluateRangeStage0Scores(sn);
    // [DIAG-V1] 신호 생성 직후 진단 변수 채우기
    diag_range_signal_score = rangeScores.rangeSignalScore;
    diag_range_confidence = sn.rangeConfidence ?? null;
    diag_box_cohesion01 = sn.boxCohesion01 ?? null;
    diag_range_oscillation_score = sn.rangeOscillationScore ?? null;
    diag_box_position = typeof sn.boxPos === "number" ? sn.boxPos : null;
    diag_breakout_failure_rate = sn.breakoutFailureRate ?? null;
    diag_regime_exit_risk = sn.regimeExitRisk ?? null;
    diag_long_candidate_created = rangeSignal.signal === "RANGE_LONG_CANDIDATE" || sn.signal === "paper_long_candidate";
    diag_short_candidate_created = rangeSignal.signal === "RANGE_SHORT_CANDIDATE" || sn.signal === "paper_short_candidate";
    diag_directional_guard_blocked = false;
    diag_risk_blocked = false;
    blockedRegime = input.risk?.blockedRegimes?.[input.regime];

    blockedRegimeActive = !!(blockedRegime && blockedRegime.until > input.now);
    blockedRegimeReasonText = String(blockedRegime?.reason ?? "");
    blockedRegimeLossStreakSuspend =
      blockedRegimeReasonText.includes("mode_loss_streak") || blockedRegimeReasonText.includes("highway_range_streak");
    rangeRiskRelaxEligible = input.regime === "RANGE" && blockedRegimeLossStreakSuspend;
    range_risk_limit_temporarily_relaxed = rangeRiskRelaxEligible;
    if (rangeRiskRelaxEligible) {
      range_risk_limit_relax_reason = RANGE_RISK_LIMIT_RELAX_REASON;
      range_risk_limit_relax_started_at = RANGE_RISK_LIMIT_RELAX_STARTED_AT;
      range_risk_limit_relax_expires_at = RANGE_RISK_LIMIT_RELAX_EXPIRES_AT;
      range_risk_limit_relax_active = input.now < (RANGE_RISK_LIMIT_RELAX_EXPIRES_AT as number);
      range_risk_limit_relax_expired = !range_risk_limit_relax_active;
    }
    boxPos = typeof sn.boxPos === "number" ? sn.boxPos : 0.5;
    zone = classifyRangeZone(boxPos);

    riskEngineHardBlocked = input.risk?.crashState !== undefined && input.risk.crashState !== "NONE";
    riskEngineBlockedBySuspendOnly =
      input.risk?.engineBlocked === true &&
      blockedRegimeActive &&
      blockedRegimeLossStreakSuspend &&
      range_risk_limit_relax_active;

    crashLockBypassApplied = false;
    crashLockBypassReason = null;
    crashLockBypassSizeMult = 1.0;

    if (riskEngineHardBlocked && input.risk?.dailyLossGuardTriggered !== true) {
      isRangeLowerLong = zone === "lower" && rangeSignal.side === "long" && rangeSignal.signal === "RANGE_LONG_CANDIDATE";
      hasQuality = (sn.rangeConfidence ?? 0) >= 0.45 && (sn.boxCohesion01 ?? 0) >= 0.25;
      extremeLower = boxPos <= 0.22;

      if (isRangeLowerLong && hasQuality && extremeLower) {
        crashLockBypassApplied = true;
        crashLockBypassReason = `range_lower_long_crash_bypass_allowed_${input.risk?.crashState}`;
        crashLockBypassSizeMult = 0.35;
      }
    }

    riskEngineBlocked = (!crashLockBypassApplied && riskEngineHardBlocked) || (input.risk?.engineBlocked === true && !riskEngineBlockedBySuspendOnly);

    if (zone === "lower" && rangeSignal.signal === "RANGE_LONG_CANDIDATE") {
      console.log("[RANGE_LONG_BLOCK_PROOF]", {
        symbol: String(sn.symbol),
        lower_zone_recognized: zone === "lower",
        long_candidate_established: rangeSignal.signal === "RANGE_LONG_CANDIDATE",
        pre_risk_crash_state: input.risk?.crashState,
        pre_risk_allow_long: input.risk?.longAllow,
        risk_engine_blocked_before_bypass: riskEngineHardBlocked || input.risk?.engineBlocked === true,
        risk_engine_bypass_applied: crashLockBypassApplied,
        risk_engine_final_block: riskEngineBlocked,
        bypass_reason: crashLockBypassReason
      });
    }

    if (input.risk?.longAllow === false || riskEngineHardBlocked) {
      console.log("[CRASH_LOCK_POLICY_TRACE]", {
        symbol: String(sn.symbol),
        why_allow_new_long_false: input.risk?.crashReason ?? "loss_limit_or_unknown",
        price_drop_state: input.risk?.crashState,
        range_bypass_eligible: crashLockBypassApplied,
        range_bypass_ineligible_reasons: !crashLockBypassApplied ? `zone=${zone},side=${rangeSignal.side},boxPos=${boxPos.toFixed(3)},conf=${sn.rangeConfidence?.toFixed(2)}` : null
      });
    }

    const RANGE_SOFT_SUSPEND_SIZE_MULT = 0.35;
    const RANGE_SOFT_SUSPEND_COOLDOWN_MS = 45_000;
    edgeGateCurrent = rangeStage0EdgeStructureGate(sn);
    edgeStructureOkCurrent = edgeGateCurrent.ok;
    prioritySignalAligned =
      (zone === "upper" && rangeSignal.side === "short") || (zone === "lower" && rangeSignal.side === "long");
    noOpenPositionFreshEntry = !input.hasOpenPosition && input.openPositionsTotal === 0;
    freshReentryCandidate =
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
    rangeLowerEdge = zone === "lower";
    rangeExitRiskOk = (sn.regimeExitRisk ?? 0) <= 0.62;
    rangeConfidenceOk = (sn.rangeConfidence ?? 0) >= 0.45;
    rangeBreakoutFailureOk = (sn.breakoutFailureRate ?? 0) >= 0.42;
    rangeSameDirBaseEligible = rangeConfidenceOk && rangeBreakoutFailureOk && rangeExitRiskOk;
    rangeReversalSwitchMatches =
      input.rangeReversalImmediateSwitch != null &&
      rangeSignal.side === input.rangeReversalImmediateSwitch.preferredSide &&
      ((input.rangeReversalImmediateSwitch.preferredSide === "short" && zone === "upper") ||
        (input.rangeReversalImmediateSwitch.preferredSide === "long" && zone === "lower"));
    range_short_allowed =
      (rangeSignal.side === "short" &&
      range_upper_edge_near &&
      !range_center_wait &&
      !rangeLowerEdge &&
      (rangeReversalSwitchMatches ||
        (rangeConfidenceOk && rangeBreakoutFailureOk && rangeExitRiskOk))) ||
      (rangeSignal.reason === "range_upper_short_from_long_reversal_watch_tier_relaxed");
    if (rangeSignal.side === "short") {
      if (range_center_wait) range_short_allowed_reason = "range_center_wait";
      else if (rangeLowerEdge) range_short_allowed_reason = "range_lower_zone_short_forbidden";
      else if (!range_upper_edge_near) range_short_allowed_reason = "range_upper_edge_not_near";
      else if (!rangeConfidenceOk && rangeSignal.reason !== "range_upper_short_from_long_reversal_watch_tier_relaxed") range_short_allowed_reason = "range_confidence_low";
      else if (!rangeBreakoutFailureOk) range_short_allowed_reason = "range_breakout_failure_low";
      else if (!rangeExitRiskOk && !rangeReversalSwitchMatches) range_short_allowed_reason = "range_exit_risk_high";
      else if (rangeReversalSwitchMatches) range_short_allowed_reason = "range_reversal_immediate_short_after_upper_flatten";
      else range_short_allowed_reason = "range_short_allowed_upper_edge";
    } else if (rangeSignal.side === "long") {
      range_short_allowed_reason = range_center_wait ? "range_center_wait" : "range_long_path";
    }
    range_reversal_short_entry_allowed = range_short_allowed;
    range_reversal_short_entry_block_reason = range_short_allowed ? null : range_short_allowed_reason;
    edgeRelaxZoneForConfidence =
      (zone === "upper" && boxPos >= 0.74 && rangeSignal.side === "short") ||
      (zone === "lower" && boxPos <= 0.26 && rangeSignal.side === "long");
    lowConfidenceSignalMin = edgeRelaxZoneForConfidence ? 0.31 : 0.34;
    lowConfidenceEntryMin = edgeRelaxZoneForConfidence ? 0.33 : 0.36;
    lowConfidence = (rangeScores.rangeSignalScore < lowConfidenceSignalMin || rangeScores.rangeEntryScore < lowConfidenceEntryMin) &&
      rangeSignal.reason !== "range_upper_short_from_long_reversal_watch_tier_relaxed" &&
      rangeSignal.reason !== "range_lower_long_from_short_reversal_watch_tier_relaxed";


    reentryBlocked = false;
    range_reentry_wait_ms = null;
    range_reentry_elapsed_ms = null;
    range_reentry_remaining_ms = null;
    range_reentry_same_direction = false;
    range_reentry_source = "range_stage0_reentry";

    // --- [DEDUP GATE] Regime Exit Consumption (One-Shot) ---
    if (input.regimeExitConsumed && rangeSignal.side === input.regimeExitConsumed.side) {
      reentryBlocked = true;
      range_reentry_source = "regime_exit_dedup";
      supplemental_reasons.push("REGIME_EXIT_DEDUP_BLOCKED");
      console.log("REGIME_EXIT_DEDUP_PROOF", {
        symbol: String(sym),
        side: rangeSignal.side,
        consumedAt: input.regimeExitConsumed.ts,
        blockingAt: input.now,
        one_shot_block: true
      });
    }

    // [STOP REENTRY BLOCK] ?숈씪 symbol / side / zone / RANGE + base signal 諛⑺뼢 ?쇱튂 ???ъ쭊??湲덉?
    if (input.rangeStopReentryBlock && input.regime === "RANGE") {
      const blk = input.rangeStopReentryBlock;
      const snSigSide =
        sn.signal === "paper_long_candidate" ? "long" : sn.signal === "paper_short_candidate" ? "short" : null;
      const candidateMatches =
        rangeSignal.side != null &&
        rangeSignal.side === blk.side &&
        zone === blk.zone &&
        snSigSide === blk.side;
      if (candidateMatches) {
        rangeStopReentrySameContextBlock = true;
        rangeStopReentryRejectOverride = "RANGE_STOP_REENTRY_SAME_CONTEXT_BLOCKED";
        range_reentry_source = "range_stop_reentry_same_context";
        supplemental_reasons.push("RANGE_STOP_REENTRY_SAME_CONTEXT");
        input.logger?.info("RANGE_STOP_REENTRY_BLOCK_PROOF", {
          symbol: String(sym),
          side: blk.side,
          zone: blk.zone,
          block_active: true,
          block_reason: blk.reason,
          armed_at: blk.armedAt,
          current_signal: sn.signal,
          current_regime: input.regime,
          current_zone: zone,
          release_reason: null
        });
      }
    }

    if (input.lastCloseMetaBySymbol && rangeSignal.side) {
      meta = input.lastCloseMetaBySymbol.get(String(sym));
      sameDirection = meta !== undefined && meta.side === rangeSignal.side;
      const waitMsBase = sameDirection ? input.reentryCooldownMs * input.sameDirCooldownMult : input.reentryCooldownMs;
      waitMs = Math.min(waitMsBase, 95_000);
      elapsedMs = input.now - (meta?.closedAt ?? 0);
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
    // --- Phase 1: Unified Authority Filtering (Down-classify weak/blocked candidates early) ---
    if (rangeSignal.signal.includes("CANDIDATE")) {
      const sideRiskBlocked = rangeSignal.side === "long" ? input.risk?.longAllow === false : rangeSignal.side === "short" ? input.risk?.shortAllow === false : false;
      const isRiskBlocked = riskEngineBlocked || sideRiskBlocked ||
        (blockedRegimeActive &&
          (!blockedRegimeLossStreakSuspend || !range_risk_limit_relax_active) &&
          !(freshReentryCandidate && blockedRegimeLossStreakSuspend));

      if (lowConfidence && !rangeReversalSwitchMatches) {
        rangeSignal.signal = "RANGE_SIGNAL_WAIT_RECHECK";
        rangeSignal.reason = "range_score_below_threshold";
      } else if (isRiskBlocked) {
        rangeSignal.signal = "RANGE_SIGNAL_WAIT_RECHECK";
        rangeSignal.reason = "range_risk_auth_blocked";
      }
    }

    // --- Phase 2: Final Gate Evaluation ---
    if (rangeSignal.signal === "RANGE_SIGNAL_NONE") {
      gateResult = "RANGE_GATE_BLOCK_LOW_CONFIDENCE";
      gateReason = rangeSignal.reason;
    } else if (rangeSignal.signal === "RANGE_SIGNAL_WAIT_RECHECK") {
      // Authority Philosophy: Wait/Recheck is an observation state, never a candidate.
      gateResult = "RANGE_GATE_BLOCK_WAIT_RECHECK";
      gateReason = rangeSignal.reason;
    } else if (reentryBlocked) {
      gateResult = "RANGE_GATE_BLOCK_REENTRY";
      gateReason = "range_reentry_cooldown_active";
    } else if (rangeStopReentrySameContextBlock) {
      gateResult = "RANGE_GATE_BLOCK_REENTRY";
      gateReason = "range_stop_reentry_same_context_blocked";
    } else {
      // Only high-confidence, authorized candidates reach here.
      gateResult = "RANGE_GATE_PASS";
      gateReason = "range_gate_pass";
    }

    // Capture interpretation results for scaling and proofs (tier/mult must stay consistent ??avoid undefined.toUpperCase downstream).
    if (rangeSignal.interpretation) {
      const interp = rangeSignal.interpretation;
      const rawTier = interp.tier;
      const rawMult = interp.reversal_size_mult;
      const rawConf = interp.confidence_score;
      const tierMissing = rawTier === undefined || rawTier === null || (typeof rawTier === "string" && rawTier.length === 0);
      const multMissing = rawMult === undefined || rawMult === null || (typeof rawMult === "number" && !Number.isFinite(rawMult));
      if (tierMissing || multMissing) {
        supplemental_reasons.push("RANGE_REVERSAL_INTERPRETATION_INCOMPLETE_GUARD");
      }
      rangeReversalTier = typeof rawTier === "string" && rawTier.length > 0 ? rawTier : "None";
      rangeReversalSizeMult = typeof rawMult === "number" && Number.isFinite(rawMult) ? rawMult : 1.0;
      rangeReversalConfidence = typeof rawConf === "number" && Number.isFinite(rawConf) ? rawConf : 0;
    }

    entryResult =
      gateResult !== "RANGE_GATE_PASS"
        ? "RANGE_ENTRY_NONE"
        : rangeSignal.signal === "RANGE_LONG_CANDIDATE"
          ? "RANGE_LONG_ENTRY"
          : "RANGE_SHORT_ENTRY";

    // [RANGE EDGE REVERSAL CONFIRMATION] ?꾩꽦 1m 遊?2媛?close/high ?먮뒗 close/low) ??吏꾪뻾 遊??쒖쇅
    let rangeReversalConfirmed = true;
    if (entryResult === "RANGE_SHORT_ENTRY" && zone === "upper") {
      const conf = computeRangeEdgeReversalConfirmation({
        zone,
        entrySide: "short",
        candles: sn.candles ?? []
      });
      rangeReversalConfirmed = conf.reversal_confirmed;
      diag_reversal_confirmed = conf.reversal_confirmed;
      if (!conf.reversal_confirmed && conf.reject_reason) rangeEdgeConfirmationReject = conf.reject_reason;
      input.logger?.info("RANGE_EDGE_CONFIRMATION_PROOF", {
        symbol: String(sym),
        side: "short" as const,
        zone,
        prev_completed_close: conf.prev?.close ?? null,
        latest_completed_close: conf.latest?.close ?? null,
        prev_completed_high: conf.prev?.high ?? null,
        latest_completed_high: conf.latest?.high ?? null,
        prev_completed_low: conf.prev?.low ?? null,
        latest_completed_low: conf.latest?.low ?? null,
        reversal_confirmed: conf.reversal_confirmed,
        reject_reason: conf.reject_reason,
        source_signal: sn.signal,
        range_signal_reason: rangeSignal.reason
      });
      if (!rangeReversalConfirmed) entryResult = "RANGE_ENTRY_NONE";
    } else if (entryResult === "RANGE_LONG_ENTRY" && zone === "lower") {
      const conf = computeRangeEdgeReversalConfirmation({
        zone,
        entrySide: "long",
        candles: sn.candles ?? []
      });
      rangeReversalConfirmed = conf.reversal_confirmed;
      diag_reversal_confirmed = conf.reversal_confirmed;
      if (!conf.reversal_confirmed && conf.reject_reason) rangeEdgeConfirmationReject = conf.reject_reason;
      input.logger?.info("RANGE_EDGE_CONFIRMATION_PROOF", {
        symbol: String(sym),
        side: "long" as const,
        zone,
        prev_completed_close: conf.prev?.close ?? null,
        latest_completed_close: conf.latest?.close ?? null,
        prev_completed_high: conf.prev?.high ?? null,
        latest_completed_high: conf.latest?.high ?? null,
        prev_completed_low: conf.prev?.low ?? null,
        latest_completed_low: conf.latest?.low ?? null,
        reversal_confirmed: conf.reversal_confirmed,
        reject_reason: conf.reject_reason,
        source_signal: sn.signal,
        range_signal_reason: rangeSignal.reason
      });
      if (!rangeReversalConfirmed) entryResult = "RANGE_ENTRY_NONE";
    }


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
        gateReason: gateReason || "none",
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
    // [DIRECTION LOCK] RANGE Engine Sets Intent (諛섏쟾 誘명솗????entryResult 湲곗??쇰줈 ?쒓렇???뚭굅)
    workingSignal = (
      entryResult === "RANGE_LONG_ENTRY"
        ? "paper_long_candidate"
        : entryResult === "RANGE_SHORT_ENTRY"
          ? "paper_short_candidate"
          : "none"
    ) as PaperSignal;
    signal_state = signalToState(workingSignal);
    intentSide = (entryResult === "RANGE_LONG_ENTRY" ? "long" : entryResult === "RANGE_SHORT_ENTRY" ? "short" : null) as
      | "long"
      | "short"
      | null;

    executorDecision = {
      entry_allowed: gateResult === "RANGE_GATE_PASS",
      blocked_reason: gateResult === "RANGE_GATE_PASS" ? null : gateResult,
      expected_move: typeof em === "number" ? em : null,
      total_cost: totalCost,
      risk_state: (input.risk?.riskStatus ?? "NORMAL") as any,
      regime: "RANGE",
      executor: "RANGE",
      box_position: classifyRangeZone(boxPos),
      entryIntentType: entryResult === "RANGE_ENTRY_NONE" ? "probe" : "standard",
      detail: {
        crash_lock_bypass_applied: crashLockBypassApplied,
        crash_lock_bypass_reason: crashLockBypassReason,
        reversal_confirmed: rangeReversalConfirmed,
        crash_lock_bypass_size_mult: crashLockBypassSizeMult,
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
        range_reversal_tier: rangeReversalTier,
        range_reversal_confidence: rangeReversalConfidence,
        range_reversal_size_mult: rangeReversalSizeMult,
        final_entry_reason: entryResult,
        range_zone_detected: zone,
        range_zone_action_policy: RANGE_ZONE_ACTION_POLICY,
        // Interpretation Evidence
        lower_raw_short_seen: zone === "lower" && rangeSignal.interpretation?.raw_side === "short",
        lower_raw_short_reversal_interpret_checked: zone === "lower" && (rangeSignal.interpretation?.checked ?? false),
        lower_raw_short_reversal_interpret_passed: zone === "lower" && (rangeSignal.interpretation?.passed ?? false),
        lower_raw_short_reversal_interpret_failed_reasons: zone === "lower" ? (rangeSignal.interpretation?.failed_reasons ?? []) : [],
        upper_raw_long_seen: zone === "upper" && rangeSignal.interpretation?.raw_side === "long",
        upper_raw_long_reversal_interpret_checked: zone === "upper" && (rangeSignal.interpretation?.checked ?? false),
        upper_raw_long_reversal_interpret_passed: zone === "upper" && (rangeSignal.interpretation?.passed ?? false),
        upper_raw_long_reversal_interpret_failed_reasons: zone === "upper" ? (rangeSignal.interpretation?.failed_reasons ?? []) : [],
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

    console.log("[RANGE_RISK_DECISION_TRACE]", {
      symbol: String(sn.symbol),
      marketMode: input.adaptiveMode,
      activeEngine: input.regime,
      crash_state: input.risk?.crashState ?? "NONE",
      risk_state: input.risk?.riskStatus ?? "NORMAL",
      allowNewLong: input.risk?.longAllow ?? true,
      allowNewShort: input.risk?.shortAllow ?? true,
      range_zone_detected: zone,
      signal_state: signal_state,
      final_trade_side: intentSide,
      blocked_by: gateResult !== "RANGE_GATE_PASS" ? gateResult : null,
      blocked_reason: gateResult !== "RANGE_GATE_PASS" ? gateReason : null,
      override_applied: crashLockBypassApplied,
      override_reason: crashLockBypassReason
    });

    if (rangeEdgeConfirmationReject != null && executorDecision) {
      executorDecision = {
        ...executorDecision,
        entry_allowed: false,
        blocked_reason: String(rangeEdgeConfirmationReject)
      };
    }

    if (gateResult !== "RANGE_GATE_PASS" || rangeEdgeConfirmationReject != null) {
      const rangeFinalBlockReason =
        rangeEdgeConfirmationReject != null
          ? String(rangeEdgeConfirmationReject)
          : gateResult === "RANGE_GATE_BLOCK_LOW_CONFIDENCE" && rangeSignal.signal === "RANGE_SIGNAL_NONE"
            ? "RANGE_SIGNAL_NONE"
            : gateResult === "RANGE_GATE_BLOCK_RISK_ENGINE"
              ? "RANGE_RISK_BLOCK_ENGINE"
              : gateResult === "RANGE_GATE_BLOCK_REENTRY"
                ? "RANGE_RISK_BLOCK_REENTRY"
                : gateResult;
      const stage1Code =
        rangeEdgeConfirmationReject != null
          ? "STAGE1_BLOCKED_EDGE"
          : gateResult === "RANGE_GATE_BLOCK_REENTRY" || gateResult === "RANGE_GATE_BLOCK_RISK_ENGINE"
            ? "STAGE1_BLOCKED_RISK"
            : gateResult === "RANGE_GATE_BLOCK_WAIT_RECHECK"
              ? "STAGE1_PENDING_RECHECK"
              : gateResult === "RANGE_GATE_BLOCK_LOW_CONFIDENCE" && rangeSignal.signal === "RANGE_SIGNAL_NONE"
                ? "STAGE1_BLOCKED_SIGNAL"
                : "STAGE1_BLOCKED_EDGE";
      const blockedRegimeIsLossStreak =
        blockedRegimeReasonText.includes("mode_loss_streak") || blockedRegimeReasonText.includes("highway_range_streak");
      const rangeRiskSubreason =
        rangeEdgeConfirmationReject != null
          ? String(rangeEdgeConfirmationReject)
          : gateResult === "RANGE_GATE_BLOCK_REENTRY"
            ? rangeStopReentryRejectOverride != null
              ? "range_stop_reentry_same_context_blocked"
              : range_reentry_same_direction
                ? "range_reentry_same_direction_wait_active"
                : "range_reentry_wait_active"
            : gateResult === "RANGE_GATE_BLOCK_RISK_ENGINE"
              ? blockedRegimeActive
                ? (blockedRegimeIsLossStreak ? "range_blocked_regime_loss_streak_suspend" : "range_blocked_regime_until_active")
                : "range_risk_unknown"
              : null;
      const rangeCooldownRemainingMs =
        rangeEdgeConfirmationReject != null
          ? 0
          : gateResult === "RANGE_GATE_BLOCK_REENTRY"
            ? (range_reentry_remaining_ms ?? 0)
            : gateResult === "RANGE_GATE_BLOCK_RISK_ENGINE" && blockedRegimeActive
              ? Math.max(0, (blockedRegime?.until ?? input.now) - input.now)
              : 0;
      const rangeReentryWaitMsOut = range_reentry_wait_ms ?? 0;
      const rangeReentryElapsedMsOut = range_reentry_elapsed_ms ?? 0;
      const rangeReentryRemainingMsOut = range_reentry_remaining_ms ?? 0;
      const rangeReentrySourceOut =
        rangeEdgeConfirmationReject != null
          ? "range_edge_reversal_confirmation"
          : gateResult === "RANGE_GATE_BLOCK_REENTRY"
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
          reject_reason:
            rangeEdgeConfirmationReject != null
              ? rangeEdgeConfirmationReject
              : gateResult === "RANGE_GATE_BLOCK_REENTRY"
                ? (rangeStopReentryRejectOverride ?? "RISK_FAIL_REENTRY")
                : gateResult === "RANGE_GATE_BLOCK_RISK_ENGINE"
                  ? "RISK_COOLDOWN"
                  : "EDGE_FAIL_EXPECTANCY",
          stage1_result_code: stage1Code as any,
          entry_blocked: rangeFinalBlockReason,
          range_stage0_engine_taken: true,
          range_stage0_exit_reason: rangeFinalBlockReason,
          legacy_executor_path_taken: false,
          risk_cooldown_subreason: rangeRiskSubreason,
          cooldown_remaining_ms: rangeCooldownRemainingMs,
          range_reentry_cooldown_applied:
            gateResult === "RANGE_GATE_BLOCK_REENTRY" &&
            rangeEdgeConfirmationReject == null &&
            rangeStopReentryRejectOverride == null,
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
          final_fail_reason: rangeFinalBlockReason,
          // [DIAG-V1] 최종 차단 진단 필드
          diag_long_candidate_created,
          diag_short_candidate_created,
          diag_long_rejected_reasons: (() => {
            const reasons: string[] = [];
            if (rangeSignal.signal === "RANGE_SIGNAL_WAIT_RECHECK") reasons.push(`range_signal_wait_recheck:${rangeSignal.reason}`);
            if (rangeSignal.signal === "RANGE_SIGNAL_NONE") reasons.push(`range_signal_none:${rangeSignal.reason}`);
            if (gateResult !== "RANGE_GATE_PASS") reasons.push(`gate_blocked:${gateResult}:${gateReason}`);
            if (rangeEdgeConfirmationReject) reasons.push(`reversal_confirmation_failed:${rangeEdgeConfirmationReject}`);
            if (riskEngineBlocked) reasons.push("risk_engine_hard_blocked");
            if (input.risk?.longAllow === false) reasons.push("risk_long_allow_false");
            return reasons.length > 0 ? reasons : null;
          })(),
          diag_short_rejected_reasons: (() => {
            const reasons: string[] = [];
            if (rangeSignal.signal === "RANGE_SIGNAL_WAIT_RECHECK") reasons.push(`range_signal_wait_recheck:${rangeSignal.reason}`);
            if (rangeSignal.signal === "RANGE_SIGNAL_NONE") reasons.push(`range_signal_none:${rangeSignal.reason}`);
            if (!range_short_allowed && rangeSignal.side === "short") reasons.push(`short_not_allowed:${range_short_allowed_reason ?? "unknown"}`);
            if (gateResult !== "RANGE_GATE_PASS") reasons.push(`gate_blocked:${gateResult}:${gateReason}`);
            if (rangeEdgeConfirmationReject) reasons.push(`reversal_confirmation_failed:${rangeEdgeConfirmationReject}`);
            if (riskEngineBlocked) reasons.push("risk_engine_hard_blocked");
            if (input.risk?.shortAllow === false) reasons.push("risk_short_allow_false");
            return reasons.length > 0 ? reasons : null;
          })(),
          diag_directional_guard_blocked: false,
          diag_risk_blocked: riskEngineBlocked || input.risk?.longAllow === false || input.risk?.shortAllow === false,
          diag_reversal_confirmed: rangeEdgeConfirmationReject == null ? true : false,
          diag_final_block_layer: rangeEdgeConfirmationReject != null
            ? "reversal_confirmation"
            : gateResult === "RANGE_GATE_BLOCK_WAIT_RECHECK"
              ? "range_signal_wait_recheck"
              : gateResult === "RANGE_GATE_BLOCK_REENTRY"
                ? "reentry_cooldown"
                : gateResult === "RANGE_GATE_BLOCK_RISK_ENGINE"
                  ? "risk_engine"
                  : "range_signal_none",
          diag_final_block_reason: rangeFinalBlockReason,
          diag_range_signal_score,
          diag_range_confidence,
          diag_box_cohesion01,
          diag_range_oscillation_score,
          diag_box_position,
          diag_breakout_failure_rate,
          diag_regime_exit_risk
        },
        {
          intentSide,
          executorDecision,
          adaptiveOk: false,
          adaptiveDetail: null,
          adaptiveResult: null,
          aiGatePassed: false
        }
      );
    } else {
      // gateResult === "RANGE_GATE_PASS" and rangeReversalConfirmed === true
      // Successfully passed all stage0 filters! Return ENTER decision.
      const sizeMult = rangeReversalSizeMult; // watch tier인 경우 0.42로 완화됨
      return ret(
        {
          strategy_executor: "RANGE",
          final_decision: "ENTER",
          reject_reason: null,
          stage1_result_code: "STAGE0_ENTERED",
          entry_blocked: null,
          range_stage0_engine_taken: true,
          range_stage0_exit_reason: null,
          legacy_executor_path_taken: false,
          stage1_size_multiplier_final: sizeMult,
          // [DIAG-V1] 최종 진단 필드
          diag_long_candidate_created,
          diag_short_candidate_created,
          diag_long_rejected_reasons: null,
          diag_short_rejected_reasons: null,
          diag_directional_guard_blocked: false,
          diag_risk_blocked: false,
          diag_reversal_confirmed: true,
          diag_final_block_layer: null,
          diag_final_block_reason: null,
          diag_range_signal_score,
          diag_range_confidence,
          diag_box_cohesion01,
          diag_range_oscillation_score,
          diag_box_position,
          diag_breakout_failure_rate,
          diag_regime_exit_risk
        },
        {
          intentSide,
          executorDecision,
          adaptiveOk: true,
          adaptiveDetail: null,
          adaptiveResult: null,
          aiGatePassed: true
        }
      );
    }
  }



  // Initial core detection and scoring
  // Use an effective scoring regime so stage0 UNKNOWN/ambiguous contexts can still exercise RANGE-stage0 scoring.
  scoringRegime =
    input.currentStage === 0 && (input.regime === "RANGE" || (regime_state === "UNKNOWN" && input.isAmbiguous))
      ? "RANGE"
      : (input.regime as "TREND" | "RANGE" | "NO_TRADE");
  rangeStage0ContextExpected = scoringRegime === "RANGE" && input.currentStage === 0;

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
    aiForHighway = _aiResult;
    skipHighwayExecutorCall = false;
    trendBoxEdgeBufferEligible =
      input.regime === "TREND" &&
      input.currentStage === 0 &&
      typeof sn.boxPos === "number" &&
      !_aiResult.rangeStage0ScoringApplied &&
      _aiResult.state === HighwayTrendState.INVALID &&
      _aiResult.invalidTier === "hard_invalid";
    if (trendBoxEdgeBufferEligible) {
      z = classifyRangeZone(sn.boxPos as number);
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
            pullback_state: "none",
            guidance:
              "諛뺤뒪 ?겶룻븯??洹쇱쿂 TREND: Highway 肄붿뼱 怨쇨꼍吏???RANGE ?ъ젏?섎룄 臾댄슚. ?쎌텛??愿留?HIGHWAY_BOX_EDGE_WATCH).",
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
      _entryIntent = "trend";
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

    // [DIRECTION LOCK] TREND Engine Sets Intent
    signal_state = signalToState(workingSignal);
    intentSide = (workingSignal === "paper_long_candidate" ? "long" : workingSignal === "paper_short_candidate" ? "short" : null);
  } else {
    supplemental_reasons.push("RANGE_STAGE0_ENGINE_ACTIVE");
  }

  // Unified Direction Lock Verification
  // This guard only triggers if NO direction was determined by ANY active engine (SIGNAL_NONE)
  if (!intentSide || intentSide === ("none" as any)) {
    const explicitMissingReason =
      typeof sn?.signalMissingReason === "string" && sn.signalMissingReason.length > 0
        ? sn.signalMissingReason
        : null;
    const explicitGateReason =
      typeof (sn as any)?.signalGateBlockedReason === "string" && (sn as any).signalGateBlockedReason.length > 0
        ? String((sn as any).signalGateBlockedReason)
        : null;
    const explicitReason =
      explicitMissingReason === "RANGE_DIRECTIONAL_SHOCK_CONFLICT_WAIT_PULLBACK" ||
        explicitGateReason === "RANGE_DIRECTIONAL_SHOCK_CONFLICT_WAIT_PULLBACK"
        ? ("RANGE_DIRECTIONAL_SHOCK_CONFLICT_WAIT_PULLBACK" as const)
        : null;

    const finalReject = (explicitReason ?? "SIGNAL_NONE") as any;
    const shouldProof =
      final_decision === "SKIP" &&
      (finalReject === "SIGNAL_NONE" || finalReject === "RANGE_DIRECTIONAL_SHOCK_CONFLICT_WAIT_PULLBACK");
    const symbolKey = String(sym);
    const nowKey = input.now;
    if (shouldProof && stage0SignalAbsenceProofLoggedAtBySymbol.get(symbolKey) !== nowKey) {
      stage0SignalAbsenceProofLoggedAtBySymbol.set(symbolKey, nowKey);
      const pumpState = (input.risk as any)?.pumpState ?? null;
      const pump_state = (input.risk as any)?.pump_state ?? null;
      const resolved_pump_lock = pumpState === "PUMP_LOCK" || pump_state === "PUMP_LOCK";
      const boxPos = sn?.boxPos ?? null;
      const zone = typeof boxPos === "number" && Number.isFinite(boxPos) ? classifyRangeZone(boxPos) : null;
      const range_edge_extreme =
        typeof boxPos === "number" && Number.isFinite(boxPos) ? (boxPos <= 0.08 || boxPos >= 0.92) : null;
      const logger = input.logger?.info ? input.logger : null;
      const payload = {
        symbol: symbolKey,
        raw_signal_before_alignment: (sn as any)?.signal ?? null,
        signal_after_alignment: workingSignal ?? null,
        signalDecisionOrigin: (sn as any)?.signalDecisionOrigin ?? null,
        signalMissingReason: (sn as any)?.signalMissingReason ?? null,
        signalGateBlockedReason: (sn as any)?.signalGateBlockedReason ?? null,
        reject_reason: finalReject,
        final_decision,
        intentSide: null,
        market_mode: input.regime,
        active_engine: input.regime,
        active_engine_routing: input.routingActiveEngine ?? null,
        directional_shock_state: input.risk?.directionalShockState ?? "NONE",
        pumpState,
        pump_state,
        resolved_pump_lock,
        crash_state: (input.risk as any)?.crashState ?? "NONE",
        long_allow: input.risk?.longAllow ?? null,
        short_allow: input.risk?.shortAllow ?? null,
        allow_new_long: input.risk?.longAllow ?? null,
        allow_new_short: input.risk?.shortAllow ?? null,
        boxPos,
        zone,
        rangeConfidence: sn?.rangeConfidence ?? null,
        trendOk: sn?.trendOk ?? null,
        emaGap: sn?.emaGap ?? null,
        trendWeaknessScore: sn?.trendWeaknessScore ?? null,
        qualityScore: sn?.qualityScore ?? null,
        candidateStrength: (sn as any)?.candidateStrength ?? null,
        entryCandidate: (sn as any)?.entryCandidate ?? null,
        range_side_candidate: null,
        trend_side_candidate: null,
        side_zone_valid: null,
        range_edge_extreme,
        relaxedRangeEntry: (sn as any)?.rangeSignalKeptByRelax === true || (sn as any)?.relaxedRangeEntry === true,
        reversal_confirmed: (sn as any)?.reversal_confirmed ?? null,
        promotion_min_condition_passed: null,
        promotion_block_reason: null,
        hard_block_present: null,
        hard_block_reason: null
      };
      if (logger) logger.info("STAGE0_SIGNAL_ABSENCE_PROOF", payload);
      else console.log("STAGE0_SIGNAL_ABSENCE_PROOF", payload);
    }
    return ret({
      signal_state: "NONE",
      final_decision: "SKIP",
      reject_reason: finalReject,
      signal_missing_reason: explicitReason ?? "NO_ENGINE_SIGNAL"
    }, {
      intentSide: null,
      executorDecision,
      adaptiveOk: false,
      adaptiveDetail: null,
      adaptiveResult: null,
      aiGatePassed: false
    });
  }

  // Retain core executor selection; overriding removed

  if (typeof em === "number" && Number.isFinite(em)) {
    expected_move_pct = em * 100;
    atr_pct = em * 100;
  }
  if (typeof rm === "number" && Number.isFinite(rm)) {
    fee_estimate_pct = rm * 100;
  }

  /**
   * regimeUnknown: BTC 5m 理쒖냼 遊?誘몃쭔 ??regime_state UNKNOWN.
   */

  /**
   * regimeUnknown: BTC 5m 理쒖냼 遊?誘몃쭔 ??regime_state UNKNOWN.
   */

  if (regime_state === "UNKNOWN" && input.currentStage === 0 && stage1SignalRelaxed) {
    // Stage 1 soft candidate + UNKNOWN regime -> Fallback to RANGE if safety criteria met
    boxPos = sn?.boxPos ?? 0.5;
    const zoneFb = classifyRangeZone(boxPos);
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
   * Stage 2+ ????긽 李⑤떒. Stage 1 + isAmbiguous ???뚮쭔 ?듦낵(?덇굅???꾪솕).
   */
  const unknownBlocksEntry =
    regime_state === "UNKNOWN" &&
    (input.currentStage >= 1 || !(input.currentStage === 0 && input.isAmbiguous));
  /** 荑⑤떎??泥댄겕(RISK_FAIL_REENTRY) ?꾪솕 (RANGE Stage 1 ?쒖젙) */
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
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      }
    );
  }

  /** NO_TRADE는 감지기에서 위험/오류나 필수 데이터 부족만; 모호함/약세 신호 등은 NO_TRADE로 내리지 않음 */
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
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      }
    );
  }

  intentSide = workingSignal === "paper_long_candidate" ? "long" : "short";
  rr = rrFromRegime(input.regime);

  stage1LoosenedEntry = false;
  /** Stage 1만 기대이동이 완화 비용 이하라도 탐색 진입 허용 (하드 REJECT 우회) */
  costWarningStage1 = false;

  /** Stage 2+ 증액: 비용 대비 기대이동 여유를 Stage 1(초기 진입)보다 엄격하게 요구 */
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
    /** Stage 1만 기대 변동성 게이트 (expected move) 하한 추가 완화; Stage 2+는 기본 대비 강화 */
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

  /** Stage 2+ 증액: 비용 대비 기대이동 여유를 Stage 1(초기 진입)보다 엄격하게 요구 */
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
  /** Stage 1만 기대 변동성 게이트(expected move) 하한 추가 완화; Stage 2+는 기본 대비 강화 */
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

  blockedRegime = input.risk?.blockedRegimes?.[input.regime];
  if (blockedRegime && blockedRegime.until > input.now) {
    const remainingMs = blockedRegime.until - input.now;
    blocked_regime_reason = blockedRegime.reason;
    cooldown_remaining_ms = remainingMs;
    const nearEdgeRangeCandidate =
      input.currentStage === 0 &&
      input.regime === "RANGE" &&
      typeof sn.boxPos === "number" &&
      (sn.boxPos <= 0.38 || sn.boxPos >= 0.62);
    const streakSuspend =
      blockedRegime.reason.includes("mode_loss_streak") || blockedRegime.reason.includes("highway_range_streak");
    const relaxModeCooldown =
      nearEdgeRangeCandidate &&
      streakSuspend &&
      (input.rangeReopenCooldownBypass === true || remainingMs <= 12 * 60_000);

    if (relaxModeCooldown) {
      risk_state = "SOFT_BLOCK";
      risk_cooldown_subreason = "blocked_regime_relaxed_range_stage0";
      supplemental_reasons.push("RISK_COOLDOWN_RELAXED_RANGE_STAGE0");
      supplemental_reasons.push(`RISK_COOLDOWN_REASON_${String(blockedRegime.reason).toUpperCase()}`);
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
      // `isCrashAligningShort` broad exception has been removed.
      // Directional filtering is now handled natively via `longAllow`/`shortAllow` in the V2 engine pipeline.
      // Therefore, global `crashState` or `dump_protection` correctly blocks legacy entry without needing side-specific exceptions here.
      const upperRiskHit =
        (input.risk?.engineBlocked === true && !engineBlockedOnlyByLossSuspend) ||
        (input.risk?.crashState !== undefined && input.risk.crashState !== "NONE") ||
        (input.regimeDetail?.dump_protection_hit === true) ||
        input.regimeDetail?.volatility_guard_hit === true;
      meta = input.lastCloseMetaBySymbol?.get(String(sym));
      sameDirection = meta !== undefined && meta.side === intentSide;
      waitMs = sameDirection
        ? input.reentryCooldownMs * input.sameDirCooldownMult
        : input.reentryCooldownMs;
      elapsedMs = input.now - (meta?.closedAt ?? 0);
      const previewReentryActive =
        (meta?.closedAt ?? 0) > 0 &&
        waitMs > 0 &&
        elapsedMs < waitMs;
      if (rangeRelaxWindowActive && streakSuspend && !upperRiskHit && rangeStage0SignalActive) {
        risk_state = "SOFT_BLOCK";
        risk_cooldown_subreason = "blocked_regime_loss_streak_suspend_relaxed_validation_window";
        supplemental_reasons.push("RANGE_RISK_LIMIT_RELAX_WINDOW_ACTIVE");
      } else {
        risk_state = "COOLDOWN";
        risk_cooldown_subreason =
          rangeStage0SignalActive && streakSuspend
            ? "blocked_regime_loss_streak_suspend"
            : "blocked_regime_until_active";
        if (!reject_reason) reject_reason = "RISK_COOLDOWN";
        final_decision = "REJECT";
        supplemental_reasons.push("RISK_COOLDOWN");
        supplemental_reasons.push(`RISK_COOLDOWN_REASON_${String(blockedRegime.reason).toUpperCase()}`);
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
    ((input.rangeReversalImmediateSwitch.preferredSide === "short" && classifyRangeZone(sn.boxPos) === "upper") ||
      (input.rangeReversalImmediateSwitch.preferredSide === "long" && classifyRangeZone(sn.boxPos) === "lower"));

  if (input.lastCloseMetaBySymbol && input.reentryCooldownMs > 0 && intentSide) {
    meta = input.lastCloseMetaBySymbol.get(String(sym));
    const lastClose = meta?.closedAt ?? 0;
    elapsedMs = input.now - lastClose;
    sameDirection = meta !== undefined && meta.side === intentSide;
    same_dir_cooldown_applied = sameDirection;
    waitMs = sameDirection ? input.reentryCooldownMs * input.sameDirCooldownMult : input.reentryCooldownMs;
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
      const enoughTimeElapsed = elapsedMs >= Math.max(45_000, Math.floor(waitMs * 0.55));
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
      reentry_elapsed_ms = elapsedMs;
    }

    if (lastClose > 0 && elapsedMs < waitMs && !rangeReversalGlobalReentryBypass) {
      risk_state = "COOLDOWN";
      risk_cooldown_subreason =
        rangeStage0SignalActive && sameDirection
          ? "reentry_same_direction_wait_active"
          : "reentry_wait_active";
      cooldown_remaining_ms = waitMs - elapsedMs;
      if (!reject_reason) reject_reason = "RISK_FAIL_REENTRY";
      final_decision = "REJECT";
      supplemental_reasons.push("RISK_FAIL_REENTRY");
      if (reentry_cooldown_reason) supplemental_reasons.push(`REENTRY_COOLDOWN_REASON_${reentry_cooldown_reason}`);
      supplemental_reasons.push(`REENTRY_COOLDOWN_WAIT_MS_${String(waitMs)}`);
    } else if (lastClose > 0 && elapsedMs < waitMs && rangeReversalGlobalReentryBypass) {
      supplemental_reasons.push("RANGE_REVERSAL_GLOBAL_REENTRY_BYPASS");
    }
  }

  if (input.risk && input.risk.sizeMultiplier < 1 && !input.risk.dailyLossGuardTriggered) {
    blockedRegime = input.risk.blockedRegimes?.[input.regime];
    if (!(blockedRegime && blockedRegime.until > input.now)) {
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
        guidance: "최대 포지션 달성",
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

  // --- [V2 HARDENING] Strict RANGE Veto Rules ---
  // 1. Forbid SHORT entries in RANGE lower zones (veto against catching falling knives or invalid range shorts).
  // 2. Forbid LONG entries in RANGE upper zones (veto against chasing breakouts without reversal confirmation).
  if (input.regime === "RANGE" && input.currentStage === 0) {
    const boxPos = sn?.boxPos ?? 0.5;
    const zone = classifyRangeZone(boxPos);
    
    if (zone === "lower" && intentSide === "short") {
      return ret({
        signal_state: signalToState(sn.signal),
        regime_state,
        final_decision: "REJECT",
        reject_reason: "RANGE_LOWER_ZONE_SHORT_VETO",
        guidance: "RANGE 하단부 숏 진입 금지 (Veto)",
        stage1_result_code: "STAGE1_BLOCKED_RISK",
        final_fail_reason: "RANGE_LOWER_SHORT_VETO"
      }, {
        intentSide: "short",
        executorDecision,
        adaptiveOk: false,
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      });
    }

    if (zone === "upper" && intentSide === "long" && !input.rangeReopenCooldownBypass) {
      // Basic protection against range-top long chasing.
      return ret({
        signal_state: signalToState(sn.signal),
        regime_state,
        final_decision: "REJECT",
        reject_reason: "RANGE_UPPER_ZONE_LONG_VETO",
        guidance: "RANGE 상단부 롱 추격 금지 (Veto)",
        stage1_result_code: "STAGE1_BLOCKED_RISK",
        final_fail_reason: "RANGE_UPPER_LONG_VETO"
      }, {
        intentSide: "long",
        executorDecision,
        adaptiveOk: false,
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      });
    }
  }

  // Highway Engine Universal Evaluation - Regime is only secondary veto logic

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
          : rangeFinalBlockReason === "RANGE_GATE_BLOCK_WAIT_RECHECK"
            ? "STAGE1_PENDING_RECHECK"
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

    if (zone === "upper" && sn.signal === "paper_long_candidate") {
      const relaxedOscMin = Math.max(0.24, RANGE_STAGE0_EDGE_THRESHOLDS.oscillation - 0.06);
      const relaxedEdgeStructureOk = !edgeStructureOkCurrent &&
        edgeGateCurrent.conf >= RANGE_STAGE0_EDGE_THRESHOLDS.conf &&
        edgeGateCurrent.cohesion >= RANGE_STAGE0_EDGE_THRESHOLDS.cohesion &&
        edgeGateCurrent.oscillation >= relaxedOscMin;

      console.log("RANGE_REVERSAL_BOTTLENECK_PROOF", {
        symbol: String(sn.symbol),
        raw_snapshot_signal: sn.signal,
        box_pos: boxPos,
        zone,
        reversal_3tier_result: {
          tier: rangeReversalTier,
          confidence_score: rangeReversalConfidence,
          size_mult: rangeReversalSizeMult,
          is_extreme_edge: (zone as string) === "upper" ? boxPos >= 0.74 : boxPos <= 0.26
        },
        metrics: {
          rangeConfidence: sn.rangeConfidence,
          boxCohesion01: sn.boxCohesion01,
          breakoutFailureRate: sn.breakoutFailureRate,
          trendWeaknessScore: sn.trendWeaknessScore,
          rangeOscillationScore: sn.rangeOscillationScore
        },
        priority_structure: {
          upperExtremeEdge: boxPos >= 0.74,
          edgeStructureOk: edgeStructureOkCurrent,
          relaxedEdgeStructureOk,
          range_reversal_interpretation_logic_tier: rangeReversalTier
        },
        reversal_interpretation: {
          interpretation_checked: rangeSignal.interpretation?.checked ?? false,
          interpretation_passed: rangeSignal.interpretation?.passed ?? false,
          interpretation_failed_reasons: rangeSignal.interpretation?.failed_reasons ?? []
        },
        scores_and_gate: {
          rangeSignalScore: rangeScores.rangeSignalScore,
          rangeEntryScore: rangeScores.rangeEntryScore,
          lowConfidenceSignalMin,
          lowConfidenceEntryMin,
          lowConfidence
        },
        final_result: {
          rangeSignal_signal: rangeSignal.signal,
          rangeSignal_reason: rangeSignal.reason,
          gateResult,
          gateReason,
          entryResult,
          final_decision: "SKIP",
          stage1_result_code: rangeStage1Code,
          reject_reason: reject_reason
        }
      });
    }

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
    const useRangeStage0Engine =
      overrideRegime === "RANGE" &&
      input.currentStage === 0 &&
      !shouldBypassRangeStage0;

    const hasAuthorityEnterFromV2 = authority.decision === "ENTER" && authority.source === "v2";
    const authorityExpectancySoftPassEligible =
      hasAuthorityEnterFromV2 &&
      !severeRiskLock &&
      (authority.stageMarginKrw ?? 0) > 0 &&
      (authority.side === "long" || authority.side === "short");

    if (reject_reason === "EDGE_FAIL_EXPECTANCY" && authorityExpectancySoftPassEligible) {
      reject_reason = "AUTHORITY_EXPECTANCY_SOFT_PASS";

      console.log("[AUTHORITY_EXPECTANCY_DECISION_PROOF]", {
        authority_decision: authority.decision,
        authority_source: authority.source,
        authority_side: authority.side,
        authority_stage_margin_krw: authority.stageMarginKrw,
        authority_size_usdt: (authority.stageMarginKrw ?? 0) / 1400,
        expectancy_failed: true,
        allow_authority_expectancy_soft_pass: true,
        reject_reason: "AUTHORITY_EXPECTANCY_SOFT_PASS",
        final_decision: input.currentStage === 0 ? "SKIP" : "REJECT",
        adaptive_ok: true,
        authority_expectancy_soft_pass_size_mult: 0.5
      });
    } else {
      if (executorDecision?.entry_allowed) {
        stage1_block_origin = "legacy_executor_gate_passed";
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

        if (typeof br === "string" && br.length > 0) supplemental_reasons.push(`EXEC_BLOCKED_${br.toUpperCase()}`);
        if (typeof invalidTier === "string" && invalidTier.length > 0) {
          supplemental_reasons.push(`HIGHWAY_INVALID_TIER_${invalidTier.toUpperCase()}`);
        }
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
            adaptiveDetail: null,
            adaptiveResult: null,
            aiGatePassed: false
          }
        );
      }
    }
  }

  const lossStreak = input.risk?.recentLossStreakByMode?.[input.regime] ?? 0;
  const last10Net =
    typeof input.risk?.detail?.last10_net_usd === "number" && Number.isFinite(input.risk.detail.last10_net_usd as number)
      ? (input.risk.detail.last10_net_usd as number)
      : 0;

  const aiIn = executorDecision
    ? aiInputFromDecision({
      decision: executorDecision,
      executorDirection: intentSide,
      lossStreak,
      last10Net,
      effectiveRegime: input.regime
    })
    : null;

  let dynamicSizeMult = input.risk?.sizeMultiplier ?? 1;
  let adaptive: FuturesAdaptiveEntryResult | null = null;

  if (aiIn) {
    const aiOut = aiApproveEntry(aiIn);
    // [ROLE REDUCTION] AI only handles quality approval/rejection for the locked direction

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
            guidance: `AI 품질 미달 거절 (Floor: ${effectiveFloor})`,
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
    dynamicSizeMult = input.risk?.sizeMultiplier ?? 1;
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
    if (crashLockBypassApplied && crashLockBypassSizeMult !== 1.0) {
      const dynamicSizeMult_before = dynamicSizeMult;
      dynamicSizeMult *= crashLockBypassSizeMult;
      supplemental_reasons.push("RANGE_CRASH_BYPASS_SIZE_APPLIED");
      console.log("[RANGE_CRASH_BYPASS_SIZE_APPLIED]", {
        symbol: String(sn.symbol),
        crashLockBypassApplied,
        crashLockBypassSizeMult,
        dynamicSizeMult_before,
        dynamicSizeMult_after: dynamicSizeMult
      });
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

    if (
      input.currentStage === 0 &&
      input.regime === "RANGE" &&
      typeof rangeReversalSizeMult === "number" &&
      Number.isFinite(rangeReversalSizeMult) &&
      rangeReversalSizeMult !== 1.0
    ) {
      dynamicSizeMult *= rangeReversalSizeMult;
      const tierTag =
        typeof rangeReversalTier === "string" && rangeReversalTier.length > 0
          ? rangeReversalTier.toUpperCase()
          : "UNKNOWN";
      supplemental_reasons.push(`RANGE_REVERSAL_TIER_${tierTag}_SIZE_REDUCED`);
    }

    const authorityExpectancySoftPassSizeMult =
      reject_reason === "AUTHORITY_EXPECTANCY_SOFT_PASS" ? 0.5 : 1.0;

    if (authorityExpectancySoftPassSizeMult < 1.0) {
      dynamicSizeMult *= authorityExpectancySoftPassSizeMult;
      supplemental_reasons.push("AUTHORITY_EXPECTANCY_SOFT_PASS");
    }

    const authorityAdaptiveSoftPassSizeMult =
      reject_reason === "AUTHORITY_ADAPTIVE_SOFT_PASS" ? 0.5 : 1.0;

    if (authorityAdaptiveSoftPassSizeMult < 1.0) {
      dynamicSizeMult *= authorityAdaptiveSoftPassSizeMult;
      supplemental_reasons.push("AUTHORITY_ADAPTIVE_SOFT_PASS");
    }

    /**
     * Fee-drag (STAGE1_COST_WARNING 처리만): 비용 경고 구역에서 추가 사이즈 축소만
     * `return ret(...)`로 REJECT 금지; `fee_drag_blocked`항상 false(전환 확인).
     * `range_lower_long_priority_applied` / `range_upper_short_priority_applied` true이면 fee-drag 전체 스킵.
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

    stage1SizeMultFinal = input.currentStage === 0 ? dynamicSizeMult : null;

    /** Stage1 RANGE 탐색: 소프트 탐색/자동진입 소프트; 또는 실행기 자체 허용(소프트 없음). */
    const stage1RangeExplorePath =
      stage1ExploreSoftExec ||
      stage1RangeEdgeSoftApplied ||
      (stage1SoftExecOverrideFlag &&
        input.autoEntryTriggered === true &&
        (executorBlockReasonOriginal === "trend_not_in_pullback" ||
          executorBlockReasonOriginal === "range_not_in_interest_zone"));
    /** 실행기가 별도 소프트 없이 RANGE에서 허용된 경우(조건 충족 시). */
    const naturalRangeStage1EntryAllowed = input.regime === "RANGE" && input.currentStage === 0 && !stage1SoftExecOverrideFlag;
    /** EXEC_BLOCKED_RANGE_NOT_LOWER_EDGE 소프트는 별도 확인 아니고 엔진 블록이면 adaptive 소프트 탐색 */
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

    const trendEmaSoftGate =
      authority.decision === "ENTER" &&
      authority.source === "v2" &&
      input.adaptiveMode === "trend";

    const effectiveV2ModeForLog =
      input.regime === "RANGE" || input.routingActiveEngine === "RANGE"
        ? "engine_v2"
        : parseEngineV2OpModeFromEnv(process.env.ORBITALPHA_ENGINE_V2_MODE);

    console.log("[ENTRY_EXECUTION_AUTHORITY_TRACE]", {
      symbol: String(sym),
      authority_owner: authority.source,
      authority_decision: authority.decision,
      configured_v2_mode: parseEngineV2OpModeFromEnv(process.env.ORBITALPHA_ENGINE_V2_MODE),
      effective_v2_mode_in_decision: effectiveV2ModeForLog,
      final_engine_owner: authority.source === "v2" ? "engine_v2" : "legacy_selector",
      block_owner: null,
      hard_block_reason: null,
      soft_pass_applied: trendEmaSoftGate,
      trend_ema_soft_gate: trendEmaSoftGate,
      regime_at_decision: input.regime,
      executor_at_decision: strategy_executor,
      adaptive_mode: input.adaptiveMode
    });

    adaptive = runFuturesAdaptiveEntry({
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
      baseSizeUsd: computePaperSizingAnchorUsd(input.config) * dynamicSizeMult,
      stage1RangeAdaptiveSoftExplore,
      trendVolumeRatioMinOverride,
      trendVolumeRelaxProof,
      trendEmaSoftGate
    });
    adaptiveDetailOut = adaptive.detail ?? null;

    console.log("[ADAPTIVE_RESULT_SUMMARY]", {
      authority_decision: authority?.decision ?? null,
      authority_source: authority?.source ?? null,
      authority_side: authority?.side ?? null,
      authority_stage_margin_krw: authority?.stageMarginKrw ?? null,
      authority_size_usdt: (authority?.stageMarginKrw ?? 0) / 1400,
      adaptive_ok: adaptive?.ok ?? null,
      fail_stage: (adaptive && !adaptive.ok) ? (adaptive as any).failStage ?? null : null,
      fail_reason: (adaptive && !adaptive.ok) ? (adaptive as any).orderBuildFailReason ?? null : null,
      signal: sn?.signal ?? null,
      trend_ok: sn?.trendOk ?? null,
      candidate_strength: (sn as any)?.candidateStrength ?? null,
      quality_score: sn?.qualityScore ?? null
    });

    // Consolidate reasons: Use policy failure over executor failure if it's from entry_policy
    if (adaptive && !adaptive.ok) {
      executorBlockReasonOriginal = (adaptive as any).orderBuildFailReason;
    }
  }

  const hasAuthorityEnterFromV2 =
    authority.decision === "ENTER" &&
    authority.source === "v2" &&
    (authority.side === "long" || authority.side === "short") &&
    (authority.stageMarginKrw ?? 0) > 0;

  const hardBlockedForExecution =
    !!severeRiskLock ||
    risk_state === "HARD_BLOCK";

  if (adaptive && !adaptive.ok) {
    const af: any = adaptive;
    const isEntryPolicyFailure = af.failStage === "entry_policy";
    const authorityBypassesPolicyVeto = hasAuthorityEnterFromV2 && isEntryPolicyFailure && !hardBlockedForExecution;

    if (authorityBypassesPolicyVeto) {
      // Philosophy: V2 Authority ENTER overrides adaptive's entry_policy re-check.
      // We log the policy failure but proceed to sizing/execution.
      reject_reason = "AUTHORITY_ADAPTIVE_SOFT_PASS";
      supplemental_reasons.push("AUTHORITY_ADAPTIVE_SOFT_PASS");
      adaptiveOk = true;
      adaptiveDetailOut = (adaptive as any).detail ?? null;

      const bypassSide =
        authority.side === "long" || authority.side === "short"
          ? authority.side
          : intentSide === "long" || intentSide === "short"
            ? intentSide
            : null;
      const authUsdt =
        typeof authority.stageMarginKrw === "number" && Number.isFinite(authority.stageMarginKrw) && authority.stageMarginKrw > 0
          ? (authority.stageMarginKrw / 1400)
          : 0;
      const anchorMult = computePaperSizingAnchorUsd(input.config) * dynamicSizeMult;
      if (bypassSide != null) {
        adaptive = {
          ok: true,
          direction: bypassSide,
          sizeUsd: Math.max(MIN_POSITION_SIZE_USD, authUsdt > 0 ? authUsdt : anchorMult),
          leverageMultiplier: 1,
          detail: {
            source: "v2_authority_policy_bypass_synthetic_adaptive",
            parked_fail_stage: af.failStage,
            parked_fail_reason: af.orderBuildFailReason,
            parked_policy_detail: af.detail ?? null
          }
        };
      }

      console.log("[AUTHORITY_ADAPTIVE_Bypass_POLICY_VETO]", {
        authority_decision: authority.decision,
        authority_source: authority.source,
        authority_side: authority.side,
        authority_stage_margin_krw: authority.stageMarginKrw,
        authority_size_usdt: (authority.stageMarginKrw ?? 0) / 1400,
        parked_fail_stage: af.failStage,
        parked_fail_reason: af.orderBuildFailReason,
        final_block_owner: null,
        decision_action: "BYPASS_VETO_PROCEED_TO_EXECUTION",
        authority_owner: authority.source,
        block_owner: "adaptive_policy_bypassed_by_v2",
        hard_block_reason: null,
        soft_pass_applied: true,
        regime_at_decision: input.regime,
        executor_at_decision: strategy_executor
      });
    } else {
      // Physical failure (sizing) or Policy failure without V2 override
      const finalRejectReason = isEntryPolicyFailure
        ? "ADAPTIVE_POLICY_BLOCK"
        : af.orderBuildFailReason === "SIZE_FLOOR_BLOCK"
          ? "SIZE_FLOOR_BLOCK"
          : "ORDER_BUILD_FAIL";
      const blockOwner = isEntryPolicyFailure ? "adaptive_policy" : "adaptive_sizing";

      console.log("[ENTRY_EXECUTION_BLOCKED_BY_ADAPTIVE]", {
        authority_decision: authority?.decision ?? null,
        authority_source: authority?.source ?? null,
        authority_side: authority?.side ?? null,
        authority_stage_margin_krw: authority?.stageMarginKrw ?? null,
        authority_size_usdt: (authority?.stageMarginKrw ?? 0) / 1400,
        authority_owner: authority?.source ?? null,
        adaptive_ok: false,
        fail_stage: af.failStage ?? null,
        fail_reason: af.orderBuildFailReason ?? null,
        reject_reason: finalRejectReason,
        final_block_owner: blockOwner,
        block_owner: blockOwner,
        hard_block_reason: isEntryPolicyFailure ? String(af.orderBuildFailReason ?? "") : null,
        soft_pass_applied: false,
        regime_at_decision: input.regime,
        executor_at_decision: strategy_executor,
        signal: sn?.signal ?? null,
        trend_ok: sn?.trendOk ?? null
      });

      return ret(
        {
          reject_reason: finalRejectReason,
          final_decision: "REJECT",
          execution_state: "ORDER_BUILD_FAIL",
          ai_decision: "APPROVE",
          adaptive_decision: "REJECT",
          guidance: `Adaptive entry blocked [${blockOwner}]: ${af.orderBuildFailReason}`,
          target_stage: null,
          supplemental_reasons,
          stage1_result_code: isEntryPolicyFailure ? "STAGE1_SOFT_FILTERED" : "STAGE1_BLOCKED_SIGNAL",
          required_move_pct,
          shortfall_pct,
          order_build_ok: false,
          order_build_fail_reason: af.orderBuildFailReason,
          order_build_fail_stage: af.failStage,
          final_block_owner: blockOwner,
          adaptive_fail_stage: af.failStage,
          adaptive_fail_reason: af.orderBuildFailReason,
          logMessage: af.logMessage
        },
        {
          intentSide,
          executorDecision,
          adaptiveOk: false,
          adaptiveDetail: adaptiveDetailOut,
          adaptiveResult: null,
          adaptiveFailure: af,
          aiGatePassed: true
        }
      );
    }
  }

  if (adaptive) {
    adaptiveOk = true;
    adaptiveResult = adaptive;
  }

  // [EXECUTION GUARD] Simplify Long Only Policy
  const longOnlyActive = input.config.longOnly;
  const isExecutionBlockedByLongOnly = longOnlyActive && intentSide === "short";

  console.log("[LONG_ONLY_POLICY_TRACE]", {
    symbol: String(sn!.symbol),
    longOnly_effective_value: longOnlyActive,
    config_source: "input.config.longOnly",
    intended_side: intentSide,
    execution_blocked: isExecutionBlockedByLongOnly,
    blocked_reason: isExecutionBlockedByLongOnly ? "long_only_restriction" : "none"
  });

  if (input.regime === "RANGE" || strategy_executor === "RANGE") {
    console.log("[RANGE_EXECUTION_POLICY_ALIGNMENT]", {
      symbol: String(sn!.symbol),
      zone: executorDecision?.detail?.range_zone_detected ?? "none",
      signal_state: signal_state,
      final_trade_side: intentSide,
      longOnly: longOnlyActive,
      action_taken: isExecutionBlockedByLongOnly ? "BLOCK" : "ALLOW",
      action_reason: isExecutionBlockedByLongOnly ? "intent_short_but_longOnly_is_true" : "passed_execution_guard"
    });
  }

  if (isExecutionBlockedByLongOnly) {
    supplemental_reasons.push("LONG_ONLY_RESTRICTION");
    return ret(
      {
        reject_reason: "EXECUTION_DISABLED",
        final_decision: "REJECT",
        execution_state: "DISABLED",
        ai_decision: "APPROVE",
        adaptive_decision: "REJECT",
        guidance: "Long Only 제한으로 숏 진입 차단",
        target_stage: null,
        supplemental_reasons,
        stage1_result_code: "STAGE1_BLOCKED_RISK",
        final_block_owner: "execution_guard"
      },
      { intentSide, executorDecision, aiGatePassed, adaptiveOk: false, adaptiveDetail: adaptiveDetailOut, adaptiveResult: null }
    );
  }

  const rangeSoftPassSizeMult = 1.0;

  const authorityAdaptiveSoftPassSizeMult =
    reject_reason === "AUTHORITY_ADAPTIVE_SOFT_PASS" ? 0.5 : 1.0;

  const authorityExpectancySoftPassSizeMult =
    reject_reason === "AUTHORITY_EXPECTANCY_SOFT_PASS" ? 0.45 : 1.0;

  const initialEntryQty =
    adaptive?.ok === true && typeof adaptive.sizeUsd === "number" && Number.isFinite(adaptive.sizeUsd) && sn!.lastPrice > 0
      ? adaptive.sizeUsd / sn!.lastPrice
      : 0;
  if (initialEntryQty <= 0) {
    console.log("[ORDER_BUILD_ZERO_QTY_PROOF]", {
      authority_decision: authority?.decision ?? null,
      authority_source: authority?.source ?? null,
      authority_side: authority?.side ?? null,
      authority_stage_margin_krw: authority?.stageMarginKrw ?? null,
      authority_size_usdt: (authority?.stageMarginKrw ?? 0) / 1400,
      dynamic_size_mult: dynamicSizeMult,
      range_soft_pass_size_mult: rangeSoftPassSizeMult,
      authority_expectancy_soft_pass_size_mult: authorityExpectancySoftPassSizeMult,
      authority_adaptive_soft_pass_size_mult: authorityAdaptiveSoftPassSizeMult,
      last_price: sn?.lastPrice ?? null,
      initial_entry_qty: initialEntryQty,
      reject_reason: "ORDER_BUILD_FAIL",
      final_block_owner: "adaptive_sizing"
    });

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
        shortfall_pct,
        order_build_fail_reason: "ZERO_QTY",
        order_build_fail_stage: "adaptive_sizing",
        final_block_owner: "adaptive_sizing"
      },
      {
        intentSide,
        executorDecision,
        adaptiveOk: false,
        adaptiveDetail: adaptiveDetailOut,
        adaptiveResult: adaptiveOk ? (adaptive as any) : null,
        aiGatePassed: true
      }
    );
  }

  final_decision = "ENTER";
  reject_reason = null;
  execution_state = "PAPER_READY";

  const forceEnterAdaptive =
    adaptive?.detail["stage1_adaptive_force_enter"] ?? adaptive?.detail["stage1_adaptive_soft_explore"];
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
          reject_reason === "AUTHORITY_EXPECTANCY_SOFT_PASS"
            ? "STAGE1_SOFT_EXPECTANCY_PASS"
            : execution_state === "STAGE1_EXEC_PENDING"
              ? "STAGE1_EXEC_PENDING"
              : gateReason === "range_upper_long_candidate_preserved_despite_weak_reversal"
                ? "STAGE1_PENDING_RECHECK"
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
      sizeUsd: (adaptive?.ok ? adaptive.sizeUsd : 0),
      original_signal_state: signal_state as any,
      final_signal_state: signal_state as any,
      range_bidirectional_applied: range_bidirectional_applied,
      range_short_allowed: range_short_allowed,
      range_short_allowed_reason: range_short_allowed_reason,
      range_upper_edge_near: range_upper_edge_near,
      range_center_wait: range_center_wait,
      range_final_selected_side: intentSide,
      range_reversal_zone: range_reversal_zone,
      range_reversal_short_eval_started: range_reversal_short_eval_started,
      range_reversal_long_exit_triggered: range_reversal_long_exit_triggered,
      range_reversal_short_entry_allowed: range_reversal_short_entry_allowed,
      range_reversal_short_entry_block_reason: range_reversal_short_entry_block_reason,
      range_reversal_immediate_switch_applied: range_reversal_immediate_switch_applied,
      range_reversal_immediate_switch_reason: range_reversal_immediate_switch_reason,
      // [DIAG-V1] 정상 진입 시 최종 진단 필드
      diag_long_candidate_created: sn?.signal === "paper_long_candidate",
      diag_short_candidate_created: sn?.signal === "paper_short_candidate",
      diag_long_rejected_reasons: null,
      diag_short_rejected_reasons: null,
      diag_btc_bias: (() => {
        const btcB = btcBiasFromModeDetail(input.adaptiveDetail || {});
        return btcB === "flat" ? "flat" : btcB === "up" ? "up" : btcB === "down" ? "down" : null;
      })(),
      diag_preferred_direction: (() => {
        const bias = input.risk?.directionalShockState;
        return bias === "UP" ? "long" : bias === "DOWN" ? "short" : "none";
      })(),
      diag_range_signal_score: rangeScores?.rangeSignalScore ?? null,
      diag_range_confidence: sn?.rangeConfidence ?? null,
      diag_box_cohesion01: sn?.boxCohesion01 ?? null,
      diag_range_oscillation_score: sn?.rangeOscillationScore ?? null,
      diag_box_position: typeof sn?.boxPos === "number" ? sn.boxPos : null,
      diag_breakout_failure_rate: sn?.breakoutFailureRate ?? null,
      diag_regime_exit_risk: sn?.regimeExitRisk ?? null,
      diag_reversal_confirmed: true,
      diag_directional_guard_blocked: false,
      diag_risk_blocked: false,
      diag_final_block_layer: null,
      diag_final_block_reason: null
    },
    {
      intentSide,
      executorDecision,
      adaptiveOk: true,
      adaptiveDetail: adaptiveDetailOut,
      adaptiveResult: (adaptiveOk && adaptive) ? (adaptive as any) : null,
      aiGatePassed: true
    }
  );


  if (directionalOverride.blockRangeEntirely) {
    const isMatchingSide = (sn?.signal === "paper_long_candidate" && directionalOverride.forcedSide === "long") ||
      (sn?.signal === "paper_short_candidate" && directionalOverride.forcedSide === "short");

    if (!isMatchingSide) {
      const intentSide = sn?.signal === "paper_long_candidate" ? "long" : "short";
      const blockReasonStr = intentSide === "long" ? "DIRECTIONAL_LONG_BLOCK" : "DIRECTIONAL_SHORT_BLOCK";
      return ret(
        {
          signal_state: signalToState(sn?.signal as any),
          regime_state: regime_state,
          edge_state: "FAIL_EXPECTANCY",
          risk_state: "DIRECTIONAL_SHOCK",
          execution_state: "DISABLED",
          final_decision: "REJECT",
          reject_reason: blockReasonStr as any,
          stage1_result_code: "STAGE1_BLOCKED_RISK",
          supplemental_reasons: [blockReasonStr, `shock:${directionalOverride.reason}`],
          adaptive_decision: "REJECT"
        },
        {
          intentSide: (sn?.signal === "paper_long_candidate") ? "long" : "short",
          executorDecision: null,
          adaptiveOk: false,
          adaptiveDetail: { directional_blocking: true, reason: directionalOverride.reason },
          adaptiveResult: null,
          aiGatePassed: false
        }
      );
    }
  }
}
