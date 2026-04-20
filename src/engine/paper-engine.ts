import * as path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  EngineConfig,
  MarketSymbol,
  PaperClosedPositionRecord,
  PaperOpenPositionRecord,
  PaperEngineMode,
  PaperEngineState,
  DecisionFunnelTick,
  PaperRegimeState,
  MarketModeSelectorOutput,
  RiskExposureOutput,
  PaperExplanationFields,
  RangeBoxZone,
  TrendBreakoutDirection,
  PaperSignalState,
  PaperMarketMode
} from "../models/types";

import type { Logger } from "../logs/logger";
import { JsonStore } from "../storage/json-store";
import type { BybitPublicDiagnostics } from "../exchange/bybit-public";
import { BybitPublicClient } from "../exchange/bybit-public";
import { OkxDemoClient, toOkxSwapInstId } from "../exchange/okx-demo";
import { trendFilterOneMinuteCloses } from "../strategy/trend-filter";
import { evaluatePaperEntryV1 } from "../strategy/entry-signal";
import type { PaperCandidateStrength, PaperSignal } from "../strategy/entry-signal";
import type { FuturesMarketMode } from "../strategy/live-market-mode";
import { evaluateRegimeExitPolicy, stopLossPctForRegime } from "../strategy/regime-exit";
import { evaluatePartialExitPolicy, defaultPartialExitRatioForStage } from "../strategy/live-partial-exit-policy";
import { MIN_POSITION_SIZE_USD } from "../strategy/live-position-sizing";
import {
  entryGateHigherTfKlineLimit,
  entryGateHigherTimeframe,
  evaluateEntryCostAndHigherTfGate,
  atrWilderLast
} from "../strategy/entry-gate";
import { computePaperEntryQualityScore, paperSignalStrengthLabel } from "../strategy/paper-entry-quality";
import {
  detectMarketRegime,
  INITIAL_ENGINE_REGIME,
  MIN_BTC_5M_BARS_REGIME,
  regimeWhenBtcFeedFailed,
  type MarketRegime,
  type MarketRegimeDetection
} from "../strategy/market-regime-detector";
import { evaluateRegimeEntry } from "../strategy/regime-entry";
import { paperHealthStatusLogPayload } from "../storage/paper-health";
import { PositionManager } from "./position-manager";
import { RiskManager } from "./risk-manager";
import { evaluateRiskControls, type RiskControlDecision } from "../strategy/risk-control-layer";
import { rangeExecutorEvaluateEntry, rangeExecutorEvaluateExit } from "../strategy/executors/range-executor";
import { trendExecutorEvaluateEntry } from "../strategy/executors/trend-executor";
import { evaluateAiHighwayQuality } from "./ai-highway-filter";
import { highwayExitEngine } from "./highway-exit-engine";
import type { AnyEntryDecision } from "../strategy/executors/types";
import { executorForExitEventPayload } from "../strategy/executors/executor-normalize";
import { aiApproveEntry, aiInputFromDecision, type AiApprovalInput, type AiApprovalOutput } from "../ai/entry-approval";
import {
  aggregateRejectReasonCountsTick,
  computeFunnelTick,
  DECISION_FUNNEL_RING_MAX,
  sumDecisionFunnelTicks
} from "./decision-funnel";
import {
  applyPaperSignalMarketAlignment,
  evaluatePaperSymbolEntry,
  type EvaluatePaperSymbolEntryResult,
  type SymbolSnapshotLike,
  type RangeStopReentryBlock,
} from "./paper-symbol-decision";
import { deriveDirectionalRoutingOverride } from "./directional-routing";
import {
  computePaperCloseLegMetrics,
  finalizePaperClosedRecord,
  paperExitDisplayMeta,
  type PaperCloseLegMetrics
} from "./paper-close-finalize";
import { evaluateMarketModeSelector } from "./mode-selector";
import { evaluateRiskExposure } from "./risk-exposure";
import { buildPaperExplanation } from "./explanation-layer";
import { runEngineV2, adaptV2Input } from "../engine-v2/index";
import {
  EngineV2Input,
  EngineV2OpMode,
  EngineV2Decision,
  EngineV2SelectorResult,
  EngineV2AdoptionOutcome,
  EngineV2FinalDecision,
  LegacyResultAdapter,
  LegacyDecisionResult,
  SymbolDecisionEnvelope,
  V2BridgeInput,
  V2BridgeSnapshot,
  V2BridgeLegacyDecision,
  V2BridgeConfig,
  V2BridgeState,
  V2BridgePosition,
  EngineV2Side,
  EntryExecutionAuthority
} from "../engine-v2/types";
import {
  reconcileV2Decision,
  resolveSymbolDecisionEnvelope,
  deriveExecutionAuthority,
  buildV2LegacyAdapter,
  buildV2ShadowParityPayload,
  normalizeAuthoritySide,
  normalizeAuthorityDecision,
  normalizePositionSideUpper,
  normalizePositionSideLower
} from "../engine-v2/reconciler";
import {
  evaluateRangeEngineForSymbol,
  evaluateRangeStructuralExit,
  computeRangeProfitTrailStep,
  evaluateRangeReopenAllowed,
  computeRangeEdgeIntensity01,
  marginsForSymbol,
  rangeCycleSizePolicy,
  rangeLadderLegMultiplier,
  rangeAccumulationRecoveryMultiplier,
  RANGE_REOPEN_WINDOW_MS,
  RANGE_ZONE_ACTION_POLICY,
  classifyBoxZone,
  type RangeProfitTrailState,
  type RangeReopenSoftMetrics
} from "./range-engine";
import {
  evaluateTrendEngineForSymbol,
  planTrendSwitch,
  trendPyramidAllowsScaleIn,
  trendPyramidSizeUplift
} from "./trend-engine";

const EP = {
  ticker: "/v5/market/tickers",
  kline: "/v5/market/kline",
  funding: "/v5/market/funding/history"
} as const;

const DEFAULT_PAPER_SIZE_USD = 100;
const SAME_DIR_REENTRY_COOLDOWN_MULT = 1.35;
const RANGE_REVERSAL_SWITCH_PENDING_MS = 90_000;

/** 진입 직후 entry identity 레인 유지: 장세·레인 전환성 전량 청산만 이 구간에서 금지(손절·노출 한도 등은 허용). */
const ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS = 120_000;

/** RANGE 캠페인: 심볼 1회전당 총 배정의 80%만 사용(초기 40% + 추가 40%, 보류 20%). */
const RANGE_CAMPAIGN_TOTAL_RATIO = 0.8;
const RANGE_INITIAL_RATIO = 0.4;
const RANGE_ADD_ON_RATIO = 0.4;
const RANGE_RESERVE_RATIO = 0.2;

type RangeReversalSwitchPending = Readonly<{
  untilMs: number;
  preferredSide: "long" | "short";
  zone: RangeBoxZone;
}>;

type RangeReversalImmediateSwitchArg = Readonly<{
  preferredSide: "long" | "short";
  reason:
  | "upper_flatten_to_short"
  | "lower_flatten_to_long"
  | "upper_flatten_to_short_pending"
  | "lower_flatten_to_long_pending";
}>;

/** RANGE 청산·유지 정책용 박스 위치 구간 (상단 ≥0.62, 하단 ≤0.38). */
function classifyRangeActionZone(boxPos: number): RangeBoxZone {
  if (boxPos >= 0.62) return "upper";
  if (boxPos <= 0.38) return "lower";
  return "mid";
}

function computeAvgBoxCohesion01(
  snapshots: ReadonlyArray<{ boxHigh: number | null; boxLow: number | null; lastPrice: number }>
): number {
  let sum = 0;
  let n = 0;
  for (const s of snapshots) {
    if (s.boxHigh == null || s.boxLow == null || s.lastPrice <= 0) continue;
    const span = s.boxHigh - s.boxLow;
    sum += 1 - Math.min(1, span / s.lastPrice);
    n += 1;
  }
  return n > 0 ? Math.min(1, sum / n) : 0.5;
}

function volumeRatioProxyFromCandles(candles: readonly { volume: number }[]): number {
  if (candles.length < 24) return 1;
  const body = candles.slice(-22, -2);
  if (body.length < 10) return 1;
  const ma = body.reduce((s, c) => s + c.volume, 0) / body.length;
  const lastV = candles[candles.length - 2]?.volume ?? 0;
  return ma > 0 && Number.isFinite(lastV) ? lastV / ma : 1;
}

export interface EngineV2Position {
  symbol: MarketSymbol;
  side: "long" | "short";
  entryPrice: number;
  sizeUsd: number;
  entryStage: number;
  pnlPct: number;
}

type SymbolSnapshot = Readonly<{
  symbol: MarketSymbol;
  lastPrice: number;
  recentCandlesCount: number;
  latestCandleClose: number;
  fundingRate: number;
  fetchedAt: number;
  ema20: number | null;
  ema60: number | null;
  trendOk: boolean;
  entryCandidate: boolean;
  signal: PaperSignal;
  qualityScore: number;
  candidateStrength: PaperCandidateStrength | null;
  emaGap: number | null;
  volumeRatioProxy: number;
  /** RANGE/TREND 판단용 박스(최근 1m) */
  boxHigh: number | null;
  boxLow: number | null;
  boxPos: number | null;
  boxRel: number | null;
  gateExpectedMove: number | null;
  gateRequiredMove: number | null;
  atr: number | null;
  signalMissingReason?: string;
  signalGateBlockedReason?: string | null;
  signalDecisionOrigin?: string;
  rangeSignalOrigin?: string;
  rangeSignalDowngraded?: boolean;
  rangeSignalDowngradeReason?: string;
  rangeSignalKeptByRelax?: boolean;
  rangeConfidence?: number;
  boxCohesion01?: number;
  breakoutFailureRate?: number;
  rangeOscillationScore?: number;
  trendWeaknessScore?: number;
  rangeReasonLabel?: string;
  rangeCycleCount?: number;
  rangeLadderLevel?: number;
  regimeExitRisk?: number;
  boxBreakSide?: "upper" | "lower" | "none";
  regimeStateDiag?: PaperRegimeState;
  candles?: import("../models/types").Candle[];
  highwayKlineLimitRequested?: number;
  highwayEntryTf?: string;
  reviewing_ticks?: number;
}>;

export type SymbolDiagnostic = Readonly<{
  symbol: MarketSymbol;
  endpoint: string;
  httpStatus: number;
  retCode?: number;
  retMsg?: string;
  requestUrl: string;
}>;

type PaperEngineDecisionEnvelope = {
  legacy: EvaluatePaperSymbolEntryResult;
  selector: EngineV2SelectorResult | null;
  authority: EntryExecutionAuthority;
  v1_decision?: string;
  v1_side?: string;
  v1_size?: number;
  v2_decision?: string;
  v2_side?: string;
  v2_size?: number;
  selector_mismatch?: boolean;
};

function toSymbolDiagnostic(symbol: MarketSymbol, endpoint: string, d: BybitPublicDiagnostics): SymbolDiagnostic {
  return {
    symbol,
    endpoint,
    httpStatus: d.httpStatus,
    retCode: d.retCode,
    retMsg: d.retMsg,
    requestUrl: d.requestUrl
  };
}

type RequestDiagnosticsSlice = Readonly<{
  httpStatus: number;
  retCode?: number;
  retMsg?: string;
  requestUrl: string;
}>;

type PerSymbolRequestDiagnostics = Readonly<{
  ticker?: RequestDiagnosticsSlice;
  kline?: RequestDiagnosticsSlice;
  funding?: RequestDiagnosticsSlice;
}>;

export type FailureEndpointKey = "ticker" | "kline" | "funding" | "unknown";

export type FailureSummaryEntry = Readonly<{
  failed: true;
  failedEndpoint: FailureEndpointKey;
  failedReason: string;
  diagnosticRef: string;
}>;

type RunMeta = Readonly<{
  strategyVersion: string;
  signalSummary: Readonly<{
    totalSymbols: number;
    longCandidates: number;
    shortCandidates: number;
    neutralSymbols: number;
  }>;
  fetchedAt: number;
  symbolsRequested: MarketSymbol[];
  symbolsSucceeded: MarketSymbol[];
  symbolsFailed: MarketSymbol[];
  failedReasons: Record<string, string>;
  failureSummary: Record<string, FailureSummaryEntry>;
  symbolDiagnostics: SymbolDiagnostic[];
  requestDiagnostics: Readonly<{
    bySymbol: Record<string, PerSymbolRequestDiagnostics>;
  }>;
  endpointsUsed: {
    ticker: string;
    kline: string;
    funding: string;
  };
  endpointsUsedDetail: Readonly<{
    ticker: { path: string; category: string };
    kline: { path: string; category: string; interval: string; limit: number };
    funding: { path: string; category: string; limit: string };
  }>;
  klineInterval: string;
  klineLimit: number;
  category: string;
  snapshotPath: string;
  latestPath?: string;
  engineMode: PaperEngineMode;
  exchange: "bybit";
  notes: string;
}>;

function buildSignalSummary(snapshots: ReadonlyArray<SymbolSnapshot>) {
  const totalSymbols = snapshots.length;
  const longV1 = snapshots.filter((s) => s.signal === "paper_long_candidate").length;
  const longV2 = snapshots.filter((s) => (s.signal as string) === "paper_long_candidate_v2").length;
  const shortV1 = snapshots.filter((s) => s.signal === "paper_short_candidate").length;
  const shortV2 = snapshots.filter((s) => (s.signal as string) === "paper_short_candidate_v2").length;

  return {
    totalSymbols,
    longCandidates: longV1 + longV2,
    shortCandidates: shortV1 + shortV2,
    neutralSymbols: totalSymbols - (longV1 + longV2 + shortV1 + shortV2),
    longV1, longV2, shortV1, shortV2
  };
}

function deriveRunIdentity(snapshots: ReadonlyArray<SymbolSnapshot>) {
  const v2Sigs = snapshots.filter(s => (s.signal as string).includes("_v2"));
  const v2Count = v2Sigs.length;
  const v2Active = v2Count > 0;

  return {
    runStrategyVersion: v2Active ? "paper-hybrid-v2" : "paper-v1",
    v2AuthorityActive: v2Active,
    v2DecisionCount: v2Count,
    v1DecisionCount: snapshots.length - v2Count,
    mixedAuthorityRun: v2Active && (snapshots.length > v2Count)
  };
}

function diagToSlice(d: SymbolDiagnostic): RequestDiagnosticsSlice {
  return {
    httpStatus: d.httpStatus,
    retCode: d.retCode,
    retMsg: d.retMsg,
    requestUrl: d.requestUrl
  };
}

function buildRequestDiagnosticsBySymbol(diags: SymbolDiagnostic[]): Record<string, PerSymbolRequestDiagnostics> {
  const bySymbol: Record<string, PerSymbolRequestDiagnostics> = {};
  for (const d of diags) {
    const sym = String(d.symbol);
    const cur = bySymbol[sym] ?? {};
    const slice = diagToSlice(d);
    if (d.endpoint === EP.ticker) bySymbol[sym] = { ...cur, ticker: slice };
    else if (d.endpoint === EP.kline) bySymbol[sym] = { ...cur, kline: slice };
    else if (d.endpoint === EP.funding) bySymbol[sym] = { ...cur, funding: slice };
  }
  return bySymbol;
}

/** Latest close per symbol: time + side + 청산 사유·단계 (재진입 쿨다운·완화 판단용). */
function latestCloseMetaBySymbol(
  history: readonly unknown[]
): Map<
  string,
  {
    closedAt: number;
    side: "long" | "short";
    closeReason?: PaperClosedPositionRecord["closeReason"];
    entryStageAtClose?: number;
  }
> {
  const m = new Map<
    string,
    {
      closedAt: number;
      side: "long" | "short";
      closeReason?: PaperClosedPositionRecord["closeReason"];
      entryStageAtClose?: number;
    }
  >();
  for (const row of history) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const sym = o.symbol;
    const closed = o.closedAt;
    const side = o.side;
    if (typeof sym !== "string" || typeof closed !== "number" || !Number.isFinite(closed)) continue;
    if (side !== "long" && side !== "short") continue;
    const prev = m.get(sym);
    if (!prev || closed >= prev.closedAt) {
      const cr = o.closeReason;
      const es = o.entryStageAtClose;
      const closeReason =
        cr === "candidate_lost" ||
          cr === "take_profit" ||
          cr === "stop_loss" ||
          cr === "trailing_stop" ||
          cr === "time_based_exit" ||
          cr === "trend_break_exit" ||
          cr === "regime_exit" ||
          cr === "partial_exit_1" ||
          cr === "partial_exit_2" ||
          cr === "range_box_break" ||
          cr === "range_profit_trail" ||
          cr === "structural_regime_shift" ||
          cr === "trend_switch"
          ? cr
          : undefined;
      const entryStageAtClose = typeof es === "number" && Number.isFinite(es) ? es : undefined;
      m.set(sym, { closedAt: closed, side, closeReason, entryStageAtClose });
    }
  }
  return m;
}

function buildFailureSummary(
  errors: ReadonlyArray<{ symbol: MarketSymbol; error: string; failedEndpoint: FailureEndpointKey }>
): Record<string, FailureSummaryEntry> {
  const out: Record<string, FailureSummaryEntry> = {};
  for (const e of errors) {
    const sym = String(e.symbol);
    const fe = e.failedEndpoint;
    const diagnosticRef =
      fe === "unknown" ? `requestDiagnostics.bySymbol.${sym}` : `requestDiagnostics.bySymbol.${sym}.${fe}`;
    out[sym] = {
      failed: true,
      failedEndpoint: fe,
      failedReason: e.error,
      diagnosticRef
    };
  }
  return out;
}

function exitFullLogKey(cr: PaperClosedPositionRecord["closeReason"]): string {
  switch (cr) {
    case "stop_loss":
      return "exit_full_stop_loss";
    case "take_profit":
      return "exit_full_take_profit";
    case "trailing_stop":
      return "exit_full_trailing";
    case "time_based_exit":
      return "exit_full_time_stop";
    case "trend_break_exit":
      return "exit_full_trend_break";
    case "regime_exit":
      return "exit_full_regime_exit";
    default:
      return "exit_full_other";
  }
}

/** Structured ORDER_BUILD_FAIL observability (paper pipeline has no exchange order draft). */
function orderBuildFailureStructuredPayload(
  first: SymbolSnapshot,
  res: EvaluatePaperSymbolEntryResult,
  entryStage: number,
  regime: string
): Record<string, unknown> {
  const d = res.decision;
  const ex = res.executorDecision;
  const af = res.adaptiveFailure;
  const adaptiveMergedDetail = (res.adaptiveDetail ?? af?.detail ?? null) as Record<string, unknown> | null;
  const entryPolicyProof =
    adaptiveMergedDetail && typeof adaptiveMergedDetail.entry_policy_proof === "object"
      ? adaptiveMergedDetail.entry_policy_proof
      : null;
  const trendVolumeRelaxProof =
    adaptiveMergedDetail && typeof adaptiveMergedDetail.trend_volume_relax_proof === "object"
      ? adaptiveMergedDetail.trend_volume_relax_proof
      : (d.trend_volume_relax_proof ?? null);
  const side =
    res.intentSide ??
    (first.signal === "paper_long_candidate" ? "long" : first.signal === "paper_short_candidate" ? "short" : null);
  return {
    order_build_ok: false,
    order_build_fail_reason: d.order_build_fail_reason ?? af?.orderBuildFailReason ?? "unknown",
    order_build_fail_stage: d.order_build_fail_stage ?? af?.failStage ?? null,
    authority_decision: d.authority_decision ?? null,
    authority_source: d.authority_source ?? null,
    authority_side: d.authority_side ?? null,
    authority_size_usd: d.authority_size_usd ?? null,
    final_block_owner: d.final_block_owner ?? null,
    symbol: String(first.symbol),
    side,
    entryStage,
    regime,
    executor: ex?.executor ?? "IDLE",
    expected_move:
      typeof ex?.expected_move === "number" && Number.isFinite(ex.expected_move) ? ex.expected_move : null,
    fixed_total_cost_usd: d.fixed_total_cost_usd ?? null,
    required_cost_usd: d.required_cost_usd ?? null,
    shortfall_usd: typeof d.shortfall_usd === "number" ? d.shortfall_usd : 0,
    stage1_soft_exec_override: d.stage1_soft_exec_override === true,
    executor_block_reason_original: d.executor_block_reason_original ?? null,
    stage1_size_multiplier_final: d.stage1_size_multiplier_final ?? null,
    sizeUsd: d.sizeUsd ?? null,
    qty: d.qty ?? null,
    price: typeof d.price === "number" && Number.isFinite(d.price) ? d.price : first.lastPrice,
    stopLoss: d.stopLoss ?? null,
    takeProfit: d.takeProfit ?? null,
    riskReward: d.riskReward ?? d.rr ?? null,
    atr_pct: d.atr_pct ?? null,
    tick_size: d.tick_size ?? null,
    qty_step: d.qty_step ?? null,
    min_qty: d.min_qty ?? null,
    min_notional: d.min_notional ?? null,
    adaptive_detail: adaptiveMergedDetail,
    entry_policy_proof: entryPolicyProof,
    trend_volume_relax_proof: trendVolumeRelaxProof
  };
}

/** OKX `submitOrder`/`getOrder` throw 또는 envelope 실패 메시지 파싱 */
function parseOkxSubmitErrorMessage(msg: string): { code: string | null; message: string } {
  const mApi = /^okx_api_([^:]+):([\s\S]*)$/.exec(msg);
  if (mApi) return { code: mApi[1].trim(), message: (mApi[2] ?? "").trim() || "request_failed" };
  const mHttp = /^okx_http_([^:]+):([\s\S]*)$/.exec(msg);
  if (mHttp) return { code: `http_${mHttp[1].trim()}`, message: (mHttp[2] ?? "").trim() || "request_failed" };
  return { code: null, message: msg };
}

function isBtcEthSampleSymbol(symbol: string): boolean {
  const s = String(symbol).toUpperCase();
  return s === "BTCUSDT" || s === "ETHUSDT";
}

type MutablePositionOpenTrace = {
  open_trace_id: string;
  symbol: string;
  sample_symbol_btc_eth: boolean;
  order_submit_requested: boolean;
  order_submit_ack: "accepted" | "rejected" | "skipped_no_okx_demo" | null;
  order_submit_error_code: string | null;
  order_submit_error_message: string | null;
  exchange_client_order_id: string | null;
  exchange_ord_id: string | null;
  exchange_order_state: string | null;
  exchange_fill_px: string | number | null;
  exchange_ack_s_code: string | null;
  exchange_ack_s_msg: string | null;
  position_open_record_written: boolean;
  position_open_final_state: "opened" | "failed" | "aborted_pre_exchange";
  open_fail_stage: string;
  qty_submitted: number | null;
  inst_id: string | null;
};
type RangeManagementState = "INIT" | "REATTACK_READY" | "REATTACK_USED" | "PROFIT_LOCKED";

export function normalizeEntryStageFromSizeEvidence(
  rec: PaperOpenPositionRecord
): { normalized: PaperOpenPositionRecord; changed: boolean } {
  const entryStage = rec.entryStage ?? 1;
  const scaled =
    typeof rec.initialSizeUsd === "number" &&
    rec.initialSizeUsd > 0 &&
    rec.sizeUsd > rec.initialSizeUsd * 1.05;

  if (scaled && entryStage < 2) {
    const normalized = { ...rec, entryStage: 2 };
    // This is a passive alignment (not during execution), but still important to log.
    return {
      normalized,
      changed: true
    };
  }
  return { normalized: rec, changed: false };
}

function normalizeRangeManagementState(
  rec: PaperOpenPositionRecord
): { normalized: PaperOpenPositionRecord; changed: boolean } {
  if (rec.regimeAtEntry !== "RANGE") {
    return { normalized: rec, changed: false };
  }

  let normalized = rec;
  let changed = false;

  const raw = rec.rangeManagementState as string | undefined;
  let currentState: RangeManagementState =
    raw === "REATTACK_ELIGIBLE"
      ? "REATTACK_READY"
      : raw === "REATTACK_READY" || raw === "REATTACK_USED" || raw === "PROFIT_LOCKED"
        ? raw
        : "INIT";

  const isScaled =
    (normalized.entryStage ?? 1) >= 2 ||
    (typeof normalized.initialSizeUsd === "number" &&
      normalized.initialSizeUsd > 0 &&
      normalized.sizeUsd > normalized.initialSizeUsd * 1.05);

  if (normalized.rangeFirstProfitLocked === true) {
    currentState = "PROFIT_LOCKED";
  } else if (isScaled) {
    currentState = "REATTACK_USED";
    if (normalized.rangeAddOnUsed !== true) {
      normalized = { ...normalized, rangeAddOnUsed: true };
      changed = true;
    }
  }

  if (currentState !== (rec.rangeManagementState ?? "INIT")) {
    normalized = { ...normalized, rangeManagementState: currentState };
    changed = true;
  }

  if (changed) {
    console.log(`[POSITION_STATE_ALIGNMENT_PROOF] ${rec.symbol} | Stage: ${rec.entryStage}->${normalized.entryStage} | AddOnUsed: ${rec.rangeAddOnUsed}->${normalized.rangeAddOnUsed} | State: ${rec.rangeManagementState}->${normalized.rangeManagementState} | Size: ${rec.sizeUsd} (Initial: ${rec.initialSizeUsd})`);
  }

  return { normalized, changed };
}

/** Required fields before an open-ledger row may be pruned (OPEN_LEDGER_SAVE_FINAL_GATE). */
function isPaperCloseAttestationComplete(
  row: Pick<PaperClosedPositionRecord, "closeReason" | "exitType" | "closeSource">
): boolean {
  const cr = row.closeReason as string | undefined;
  if (cr == null || cr === "" || (cr as string) === "none") return false;
  const et = row.exitType as string | undefined;
  const cs = row.closeSource as string | undefined;
  if (et == null || String(et).trim() === "") return false;
  if (cs == null || String(cs).trim() === "") return false;
  return true;
}

export class PaperEngine {
  private readonly store: JsonStore;
  private readonly bybit: BybitPublicClient;
  private readonly positions: PositionManager;
  private readonly risk: RiskManager;
  private lastAdaptiveMode: Readonly<{ mode: FuturesMarketMode; detail: Record<string, unknown> }> = { mode: "sideways", detail: {} };
  private lastRegime: MarketRegimeDetection = INITIAL_ENGINE_REGIME;
  private lastHealthyBtcRegime: { detected: MarketRegimeDetection; ts: number } | null = null;
  private lastRisk: RiskControlDecision | null = null;
  private lastEffectiveLane: string = "IDLE";
  private lastModeChangeAt: number = 0;
  private lastEntryDecision: AnyEntryDecision | null = null;
  private rangeCooldownUntilByKey = new Map<string, number>();
  private rangeFailCountByKey = new Map<string, number>();
  private trendCooldownUntilBySymbol = new Map<string, number>();
  /** 비영속: 최근 틱별 `decision_funnel_tick` 스냅샷 (최대 DECISION_FUNNEL_RING_MAX). */
  private decisionFunnelTickRing: DecisionFunnelTick[] = [];
  /** 비영속: Stage 1 진입 검토(SKIP) 중인 심볼의 체류 시간 및 품질 추적 */
  private reviewingState = new Map<string, { ticks: number; initialQuality: number; lastQuality: number }>();
  private lastMarketMode: MarketModeSelectorOutput | null = null;
  private lastRiskExposure: RiskExposureOutput | null = null;
  private lastExplanation: PaperExplanationFields | null = null;
  private rangeRuntimeBySymbol = new Map<string, { lastZone: RangeBoxZone | null; cycle: number; ladder: number }>();
  private trendBreakoutBySymbol = new Map<string, TrendBreakoutDirection>();
  private trendHoldMemoryBySymbol = new Map<string, import("../models/types").TrendBreakoutHoldMemory>();
  private trendPyramidLevelBySymbol = new Map<string, number>();
  /** RANGE 익절 후 재진입 쿨다운 우회 판단용(만료 시각). */
  private rangeReopenArmedUntilBySymbol = new Map<string, number>();
  /** 직전 틱 `evaluateRangeEngineForSymbol` 결과(진입 크기·래더 연동). */
  private lastTickRangeEvalBySymbol = new Map<string, ReturnType<typeof evaluateRangeEngineForSymbol>>();
  private lastTickSymbolSnapshotBySymbol = new Map<string, SymbolSnapshot | null>();
  private rangeReversalImmediateSwitchForSymbol = new Map<string, RangeReversalImmediateSwitchArg>();
  private rangeReversalSwitchPendingBySymbol = new Map<string, RangeReversalSwitchPending>();
  /** TREND 스위칭 시각(1h 카운트 → selector). */
  private trendSwitchTimestampsMs: number[] = [];
  /** RANGE 재진입 성공 시각(윈도 내 횟수 제한). */
  private rangeReopenTimestampsBySymbol = new Map<string, number[]>();
  private trendFollowScoreBySymbol = new Map<string, number>();
  private trendBreakoutConfidenceBySymbol = new Map<string, number>();
  private rangeRoundTripStreakBySymbol = new Map<string, number>();
  /** Consecutive close-eval ticks with raw box break (for EXIT_RANGE_REBALANCE debounce). */
  private rangeBoxBreakConsecutiveBySymbol = new Map<string, number>();
  /** RANGE 수익권 추종: 심볼:openedAt → 피크·잠금 (박스 이탈 리밸런스 지연용). */
  private rangeProfitTrailByKey = new Map<string, RangeProfitTrailState>();
  /** RANGE upper short add-on: per-position one-shot guard (symbol:openedAt -> count). */
  private rangeUpperShortAddOnCountByKey = new Map<string, number>();
  private rangeRecentOutcomeScoresBySymbol = new Map<string, number[]>();
  /** 장세 부적합 종료(EXIT_REGIME) 소모 이력. 동일 흐름 내 반복 진입/종료 방지. */
  private regimeExitConsumedBySymbol = new Map<string, { side: "long" | "short"; ts: number }>();
  /** RANGE edge stop_loss 재진입 차단용 메모리 맵. */
  private rangeStopReentryBlockedBySymbol = new Map<string, RangeStopReentryBlock>();
  private lastExitReasonLabel = "";
  private lastSwitchReasonLabel = "";
  /** 직전 틱 구간 반전 청산 적용(PEL proof용) */
  private rangeReversalExitThisTickBySymbol = new Map<
    string,
    { range_existing_long_reversal_exit_applied?: boolean; range_existing_short_reversal_exit_applied?: boolean }
  >();

  /**
   * Flow-based one-shot deduplication for terminal exits (EXIT_REGIME, EXIT_SL, EXIT_TIME_STOP).
   * Key: `${symbol}:${side}:${openedAt}`
   */
  private readonly terminalExitConsumedByFlow = new Set<string>();

  private readonly okxDemo: OkxDemoClient | null;
  private okxAccountConfigLoaded = false;

  private pruneTrendSwitches1h(now: number): number {
    const cutoff = now - 3_600_000;
    this.trendSwitchTimestampsMs = this.trendSwitchTimestampsMs.filter((t) => t > cutoff);
    return this.trendSwitchTimestampsMs.length;
  }

  private recordRangeRoundTripOutcome(symbolKey: string, win: boolean): void {
    const arr = this.rangeRecentOutcomeScoresBySymbol.get(symbolKey) ?? [];
    arr.push(win ? 1 : -1);
    this.rangeRecentOutcomeScoresBySymbol.set(symbolKey, arr.slice(-8));
    const s = this.rangeRoundTripStreakBySymbol.get(symbolKey) ?? 0;
    this.rangeRoundTripStreakBySymbol.set(symbolKey, win ? s + 1 : 0);
  }

  private recentRangeWinRate01(symbolKey: string): number {
    const arr = this.rangeRecentOutcomeScoresBySymbol.get(symbolKey) ?? [];
    if (arr.length === 0) return 0.5;
    return arr.filter((x) => x > 0).length / arr.length;
  }

  constructor(
    private readonly config: EngineConfig,
    private readonly logger: Logger
  ) {
    this.store = new JsonStore(path.resolve(config.dataDir));
    this.bybit = new BybitPublicClient();
    this.positions = new PositionManager(this.store);
    this.risk = new RiskManager(config);
    if (config.okxDemoEnabled) {
      const credsReady =
        config.okxDemoApiKey.length > 0 && config.okxDemoApiSecret.length > 0 && config.okxDemoPassphrase.length > 0;
      if (!credsReady) {
        this.okxDemo = null;
        this.logger.error("okx_demo_env_mismatch_detected", {
          okx_demo_enabled: true,
          has_api_key: config.okxDemoApiKey.length > 0,
          has_api_secret: config.okxDemoApiSecret.length > 0,
          has_passphrase: config.okxDemoPassphrase.length > 0
        });
      } else {
        this.okxDemo = new OkxDemoClient({
          baseUrl: config.okxDemoBaseUrl,
          apiKey: config.okxDemoApiKey,
          apiSecret: config.okxDemoApiSecret,
          passphrase: config.okxDemoPassphrase
        });
        this.logger.info("okx_demo_mode_active", {
          okx_demo_base_url: config.okxDemoBaseUrl
        });
        this.logger.info("okx_simulated_trading_header_applied", {
          header_name: "x-simulated-trading",
          header_value: "1"
        });
      }
    } else {
      this.okxDemo = null;
    }
    if (config.okxDemoEnvRequested && !config.okxExchangeAuthOptIn) {
      this.logger.info("okx_exchange_auth_disabled", {
        detail:
          "OKX_DEMO_ENABLED is on but ORBITALPHA_OKX_EXCHANGE_ENABLED is not true — no signed OKX calls; paper execution + public market data only"
      });
    }
    this.logger.info("paper_data_and_execution_mode", {
      market_data: "bybit_public_unauthenticated",
      okx_signed_rest_active: config.okxDemoEnabled,
      position_fill_pnl_path: config.okxDemoEnabled ? "paper_json_plus_okx_submit" : "paper_json_only"
    });
    this.logger.info("paper_entry_gate_config", {
      paper_entry_relaxed: config.paperEntryRelaxed,
      paper_gate_min_move_mult: config.paperGateMinMoveMultiplier,
      paper_require_higher_tf: config.paperRequireHigherTfAlign,
      paper_quality_min: config.paperQualityMinScore,
      paper_quality_min_weak: config.paperQualityMinScoreWeak,
      paper_strong_ema_gap_threshold: config.paperStrongEmaGapThreshold,
      paper_sideways_ema_gap_threshold: config.paperSidewaysEmaGapThreshold,
      paper_reentry_cooldown_ms: config.paperReentryCooldownMs,
      paper_reentry_same_dir_mult: 2,
      paper_max_open_positions: config.paperMaxOpenPositions
    });
  }

  async runOnce(): Promise<void> {
    this.lastExitReasonLabel = "";
    this.lastSwitchReasonLabel = "";
    this.rangeReversalExitThisTickBySymbol.clear();
    await this.positions.ensureHistoryFile();

    // --- 1. Ledger Integrity: High-Fidelity Position Normalization Promotion ---
    const allOpensForNormalization = await this.positions.loadOpenAll();
    const normalizedSymbols: string[] = [];
    const normalizedFieldsSet = new Set<string>();
    let ledgeChanged = false;

    for (let i = 0; i < allOpensForNormalization.length; i++) {
      const pos = allOpensForNormalization[i];
      const norm1 = normalizeEntryStageFromSizeEvidence(pos);
      const norm2 = normalizeRangeManagementState(norm1.normalized);
      if (norm1.changed || norm2.changed) {
        allOpensForNormalization[i] = norm2.normalized;
        ledgeChanged = true;
        normalizedSymbols.push(String(pos.symbol));
        if (norm1.changed) normalizedFieldsSet.add("entryStage");
        if (norm2.changed) normalizedFieldsSet.add("rangeManagementState");
      }
    }

    if (ledgeChanged) {
      await this.positions.saveOpenAll(allOpensForNormalization);
      this.logger.info("paper_position_ledger_normalized", {
        changed_count: normalizedSymbols.length,
        changed_symbols: normalizedSymbols,
        normalized_fields: Array.from(normalizedFieldsSet),
        save_open_all_triggered: true
      });
    }
    // --------------------------------------------------------------------------

    if (this.okxDemo) {
      try {
        if (!this.okxAccountConfigLoaded) {
          const cfg = await this.okxDemo.getAccountConfig();
          this.okxAccountConfigLoaded = true;
          this.logger.info("okx_account_config_loaded", {
            account_level: cfg.data?.[0]?.acctLv ?? null,
            pos_mode: cfg.data?.[0]?.posMode ?? null
          });
        }
        await this.okxDemo.getBalance("USDT");
        const p = await this.okxDemo.getPositions("SWAP");
        this.logger.info("okx_position_sync_success", {
          positions: p.data?.length ?? 0
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error("okx_position_sync_failed", { message: msg });
        if (msg.includes("50101")) {
          this.logger.error("okx_demo_env_mismatch_detected", {
            reason: "50101",
            check: "api_key_type_or_x_simulated_trading_header"
          });
        }
      }
    }
    const history = await this.store.readPositionsHistory();

    const allowed = new Set<MarketSymbol>(["BTCUSDT", "ETHUSDT"]);
    const symbols = this.config.symbols.filter((s) => allowed.has(s));
    const fetchedAt = Date.now();
    const klineTimeframe = "1m" as const;
    const klineInterval = "1";
    const klineLimit = 120;
    const category = "linear";

    const btc5r = await this.bybit.tryGetCandles("BTCUSDT", "5m", 120);
    const btc5 = btc5r.ok ? btc5r.value : [];
    const prevRegime = this.lastRegime.regime;
    const fallbackMaxAgeMs = 90_000;
    let btcFeedFallbackApplied = false;
    let btcFeedFallbackAgeMs: number | null = null;
    let regimeFallbackSource = "direct_btc_feed";
    let regimeDetected: MarketRegimeDetection;
    if (btc5r.ok) {
      regimeDetected = detectMarketRegime({ btcCandles5m: btc5 });
      this.lastHealthyBtcRegime = { detected: regimeDetected, ts: fetchedAt };
    } else {
      const fallback = this.lastHealthyBtcRegime;
      const age = fallback ? fetchedAt - fallback.ts : Number.POSITIVE_INFINITY;
      if (fallback && age <= fallbackMaxAgeMs) {
        btcFeedFallbackApplied = true;
        btcFeedFallbackAgeMs = age;
        regimeFallbackSource = "cached_recent_btc_regime";
        regimeDetected = fallback.detected;
      } else {
        regimeDetected = regimeWhenBtcFeedFailed((btc5r as { error?: string }).error ?? "btc_candles_unavailable");
      }
    }
    this.lastRegime = regimeDetected;

    const btc1m_r = await this.bybit.tryGetCandles("BTCUSDT", "1m", 60);
    const btc1m = btc1m_r.ok ? btc1m_r.value : [];
    const btc1m_atr = btc1m.length > 20 ? atrWilderLast(btc1m, 14) : null;

    const nowStateTs = Date.now();
    this.lastRisk = evaluateRiskControls({
      config: this.config,
      now: nowStateTs,
      history,
      priorState: this.lastRisk,
      globalCandles: btc1m,
      globalAtr: btc1m_atr,
      rangeConfidence: regimeDetected.rangeConfidence
    });
    const risk = this.lastRisk;

    // --- Directional Routing Override Evaluation (Tick Master Switch) ---
    const routingOverride = deriveDirectionalRoutingOverride({
      rawRegime: regimeDetected.regime,
      directionalShockState: risk.directionalShockState
    });

    this.logger.info("regime_decision", {
      regime_final: regimeDetected.log.regime_final,
      regime_raw: regimeDetected.log.regime_raw,
      effective_lane: routingOverride.effectiveExecutionLane,
      shock_state: routingOverride.directionalShockState,
      no_trade_reason: regimeDetected.log.no_trade_reason,
      unknown_reason: regimeDetected.log.unknown_reason,
      data_ready: regimeDetected.log.data_ready,
      dump_protection_hit: regimeDetected.log.dump_protection_hit,
      volatility_guard_hit: regimeDetected.log.volatility_guard_hit,
      len_btc_5m: btc5.length,
      btc_feed_ok: btc5r.ok,
      btc_feed_fallback_applied: btcFeedFallbackApplied,
      btc_feed_fallback_age_ms: btcFeedFallbackAgeMs,
      regime_fallback_source: regimeFallbackSource
    });

    const prevLane = this.lastEffectiveLane;
    if (routingOverride.effectiveExecutionLane !== prevLane) {
      this.lastModeChangeAt = Date.now();
      await this.store.appendJsonlLine("reports/events.jsonl", {
        ts: this.lastModeChangeAt,
        type: "MODE_CHANGE",
        regime_raw: regimeDetected.regime,
        effective_lane: routingOverride.effectiveExecutionLane,
        from_lane: prevLane,
        override_applied: routingOverride.overrideApplied,
        override_reason: routingOverride.overrideReason,
        executor: routingOverride.effectiveExecutionLane
      });
      this.lastEffectiveLane = routingOverride.effectiveExecutionLane;
    }

    const adaptiveMode: FuturesMarketMode =
      routingOverride.effectiveExecutionLane === "TREND" ? "trend" :
        routingOverride.effectiveExecutionLane === "RANGE" ? "sideways" : "risk_off";
    this.lastAdaptiveMode = { mode: adaptiveMode, detail: regimeDetected.detail };


    const snapshots: SymbolSnapshot[] = [];
    const errors: { symbol: MarketSymbol; error: string; failedEndpoint: FailureEndpointKey }[] = [];
    const allSymbolDiagnostics: SymbolDiagnostic[] = [];

    for (const symbol of symbols) {
      const result = await this.pollSymbol(symbol, fetchedAt, klineLimit, regimeDetected);
      allSymbolDiagnostics.push(...result.symbolDiagnostics);
      if (result.ok) {
        snapshots.push(result.snapshot);
      } else {
        errors.push({ symbol, error: result.error, failedEndpoint: result.failedEndpoint });
        this.logger.error("paper_poll_symbol_failed", { symbol, error: result.error });
      }
    }

    const run = { fetchedAt, snapshots, errors };
    const filePath = await this.store.writeJson(`snapshots/${fetchedAt}.json`, run);
    this.logger.info("snapshot_saved", { filePath, symbols: snapshots.map((s) => s.symbol), errorCount: errors.length });

    let latestPath: string | undefined;
    try {
      latestPath = await this.store.writeSnapshotLatest(run);
      this.logger.info("snapshot_latest_saved", { latestPath });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("snapshot_latest_save_failed", { error: msg });
    }

    const symbolsSucceeded = snapshots.map((s) => s.symbol);
    const symbolsFailed = errors.map((e) => e.symbol);
    const failedReasons: Record<string, string> = {};
    for (const e of errors) failedReasons[e.symbol] = e.error;

    const requestDiagnostics: RunMeta["requestDiagnostics"] = {
      bySymbol: buildRequestDiagnosticsBySymbol(allSymbolDiagnostics)
    };

    const signalSummary = buildSignalSummary(snapshots);
    const runId = deriveRunIdentity(snapshots);

    const meta: RunMeta = {
      strategyVersion: runId.runStrategyVersion,
      signalSummary: signalSummary as any,
      fetchedAt,
      symbolsRequested: symbols,
      symbolsSucceeded,
      symbolsFailed,
      failedReasons,
      failureSummary: buildFailureSummary(errors),
      symbolDiagnostics: allSymbolDiagnostics,
      requestDiagnostics,
      endpointsUsed: {
        ticker: EP.ticker,
        kline: EP.kline,
        funding: EP.funding
      },
      endpointsUsedDetail: {
        ticker: { path: EP.ticker, category },
        kline: { path: EP.kline, category, interval: klineInterval, limit: klineLimit },
        funding: { path: EP.funding, category, limit: "1" }
      },
      klineInterval,
      klineLimit,
      category,
      snapshotPath: filePath,
      latestPath,
      engineMode: this.config.paperEngineMode,
      exchange: "bybit",
      v2AuthorityActive: runId.v2AuthorityActive,
      runIdentity: runId as any,
      notes: "paper hybrid authority pipeline; legacy + v2 authority bridge active; position identity stored per executor/regime resolution; run metadata reflects hybrid execution"
    } as any;

    let metaPath: string | undefined;
    try {
      metaPath = await this.store.writeSnapshotLatestMeta(meta);
      this.logger.info("snapshot_latest_meta_saved", { metaPath });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("snapshot_latest_meta_save_failed", { error: msg });
    }

    const hasAnyCandidate = snapshots.some(
      (s) => (s.signal as string).includes("_candidate")
    );
    let candidateRunPath: string | undefined;
    if (hasAnyCandidate && latestPath && metaPath) {
      try {
        const candidateSymbols = snapshots
          .filter(
            (s) => (s.signal as string).includes("_candidate")
          )
          .map((s) => String(s.symbol));
        candidateRunPath = await this.store.writePaperCandidateRun(fetchedAt, {
          fetchedAt,
          strategyVersion: runId.runStrategyVersion,
          longCandidates: signalSummary.longCandidates,
          shortCandidates: signalSummary.shortCandidates,
          candidateSymbols,
          snapshots,
          latestSnapshotPath: latestPath,
          latestMetaPath: metaPath,
          ...(filePath ? { timestampSnapshotPath: filePath } : {})
        });
        this.logger.info("paper_candidate_run_saved", { path: candidateRunPath });

        const indexPath = await this.store.updateRunsIndex({
          fetchedAt,
          runPath: candidateRunPath,
          strategyVersion: runId.runStrategyVersion,
          longCandidates: signalSummary.longCandidates,
          shortCandidates: signalSummary.shortCandidates,
          candidateSymbols,
          ...(latestPath ? { latestSnapshotPath: latestPath } : {}),
          ...(metaPath ? { latestMetaPath: metaPath } : {}),
          ...(filePath ? { timestampSnapshotPath: filePath } : {})
        });
        this.logger.info("paper_candidate_index_updated", { path: indexPath });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error("paper_candidate_run_save_failed", { error: msg });
      }
    }

    const opensBeforeClose = await this.positions.loadOpenAll();
    let volatilityProxy = 0.5;
    if (snapshots.length > 0) {
      let sum = 0;
      let n = 0;
      for (const s of snapshots) {
        if (s.atr != null && s.lastPrice > 0) {
          sum += s.atr / s.lastPrice;
          n += 1;
        }
      }
      if (n > 0) {
        volatilityProxy = Math.min(1, (sum / n) * 40);
      }
    }
    const boxCohesion01 = computeAvgBoxCohesion01(snapshots);
    const rawMarketModeOut = evaluateMarketModeSelector({
      regimeDetection: regimeDetected,
      fetchedAt,
      snapshotCount: snapshots.length,
      errorCount: errors.length,
      volatilityProxy,
      recentTrendSwitchCount1h: this.pruneTrendSwitches1h(fetchedAt),
      boxCohesion01
    });

    const marketModeOut: MarketModeSelectorOutput = {
      ...rawMarketModeOut,
      marketMode: routingOverride.effectiveExecutionLane === "IDLE" ? "NO_TRADE" :
        (routingOverride.effectiveExecutionLane === "TREND" ? "TREND" : "RANGE"),
      routing: {
        ...rawMarketModeOut.routing,
        activeEngine: routingOverride.effectiveExecutionLane
      }
    };
    this.lastMarketMode = marketModeOut;
    const riskExposureOut = evaluateRiskExposure({
      config: this.config,
      marketMode: marketModeOut,
      risk: this.lastRisk!,
      openPositionCount: opensBeforeClose.length,
      fetchedAtMs: fetchedAt,
      proofLogger: this.logger
    });
    this.lastRiskExposure = riskExposureOut;


    const explanationOut = buildPaperExplanation({
      marketMode: marketModeOut,
      risk: riskExposureOut,
      exitHint: this.lastExitReasonLabel,
      switchHint: this.lastSwitchReasonLabel
    });
    this.lastExplanation = explanationOut;

    let opensAfterClose = await this.positions.loadOpenAll();
    const lastCloseMetaBySymbolForDecision =
      this.config.paperReentryCooldownMs > 0 ? latestCloseMetaBySymbol(await this.store.readPositionsHistory()) : null;
    const regimeUnknown = btc5.length < MIN_BTC_5M_BARS_REGIME;
    const polledSymbols = this.config.symbols;
    const decisionBySymbol = new Map<string, PaperEngineDecisionEnvelope>();
    const effectiveLane = routingOverride.effectiveExecutionLane;
    const effectiveRegimeForDecision = (effectiveLane === "IDLE" ? "NO_TRADE" : effectiveLane) as MarketRegime;

    const signalAlignmentContextBase = {
      marketMode: marketModeOut.marketMode,
      activeEngine: marketModeOut.routing.activeEngine,
      allowNewLong: riskExposureOut.allowNewLong,
      allowNewShort: riskExposureOut.allowNewShort
    } as const;

    for (const sym of polledSymbols) {
      const symKeyEarly = String(sym);

      // --- 2.1 Regime Exit Dedup Lifecycle ---
      const consumed = this.regimeExitConsumedBySymbol.get(symKeyEarly);
      if (consumed) {
        const currentSnap = this.lastTickSymbolSnapshotBySymbol.get(symKeyEarly);
        const currentSignalSide =
          currentSnap?.signal === "paper_long_candidate"
            ? "long"
            : currentSnap?.signal === "paper_short_candidate"
              ? "short"
              : "none";
        // 시그널 방향이 바뀌거나 소멸하면 기존 장세 부적합 종료 소모 기록 초기화 (새로운 흐름 허용)
        if (currentSignalSide !== consumed.side) {
          this.regimeExitConsumedBySymbol.delete(symKeyEarly);
        }
      }

      const snap = snapshots.find((s) => s.symbol === sym);
      const snapForDecision =
        snap == null
          ? null
          : applyPaperSignalMarketAlignment({
            snapshot: snap,
            risk,
            signalAlignmentContext: signalAlignmentContextBase,
            adaptiveMode: this.lastAdaptiveMode.mode,
            marketSignalProofLogger: this.logger
          });
      this.lastTickSymbolSnapshotBySymbol.set(symKeyEarly, snapForDecision ?? snap ?? null);

      const stopBlkPre = this.rangeStopReentryBlockedBySymbol.get(symKeyEarly);
      if (stopBlkPre && snapForDecision) {
        const sig = snapForDecision.signal;
        const sigSide = sig === "paper_long_candidate" ? "long" : sig === "paper_short_candidate" ? "short" : "none";
        const bp = typeof snapForDecision.boxPos === "number" ? snapForDecision.boxPos : 0.5;
        const curZone = classifyBoxZone(bp);
        let releaseReason: string | null = null;
        if (effectiveRegimeForDecision !== "RANGE") releaseReason = "regime_not_range";
        else if (sigSide === "none") releaseReason = "signal_none";
        else if (sigSide !== stopBlkPre.side) releaseReason = "signal_opposite";
        else if (curZone !== stopBlkPre.zone) releaseReason = "zone_left_block_zone";
        if (releaseReason) {
          this.logger.info("RANGE_STOP_REENTRY_BLOCK_PROOF", {
            symbol: symKeyEarly,
            side: stopBlkPre.side,
            zone: stopBlkPre.zone,
            block_active: false,
            block_reason: stopBlkPre.reason,
            armed_at: stopBlkPre.armedAt,
            current_signal: snapForDecision.signal,
            current_regime: effectiveRegimeForDecision,
            current_zone: curZone,
            release_reason: releaseReason
          });
          this.rangeStopReentryBlockedBySymbol.delete(symKeyEarly);
        }
      }

      const nowTick = snap;

      this.pruneRangeReversalSwitchPending(symKeyEarly, snap ?? null, fetchedAt);

      const rangeReversalImmediateSwitchEarly = this.getRangeReversalImmediateSwitch(
        symKeyEarly,
        snap ?? null,
        fetchedAt,
        effectiveRegimeForDecision,
        marketModeOut.routing.activeEngine
      );

      const existingPos = opensAfterClose.find((o) => o.symbol === sym);

      // 1. Snapshot-Check & Preliminary Block Logging
      if (!snap) {
        const resNull = evaluatePaperSymbolEntry({
          config: this.config,
          snapshot: null,
          dataReady: regimeUnknown === false,
          openPositionSide: existingPos?.side ?? null,
          regime: effectiveRegimeForDecision,
          regimeDetail: regimeDetected.detail,
          regimeUnknown,
          isAmbiguous: regimeDetected.isAmbiguous,
          risk: risk,
          adaptiveMode: this.lastAdaptiveMode.mode,
          adaptiveDetail: this.lastAdaptiveMode.detail,
          now: fetchedAt,
          rangeCooldownUntilByKey: this.rangeCooldownUntilByKey,
          trendCooldownUntilBySymbol: this.trendCooldownUntilBySymbol,
          lastCloseMetaBySymbol: lastCloseMetaBySymbolForDecision!,
          reentryCooldownMs: this.config.paperReentryCooldownMs,
          sameDirCooldownMult: 2,
          hasOpenPosition: !!existingPos,
          openPositionsTotal: opensAfterClose.length,
          maxPositionsReached: opensAfterClose.length >= this.config.paperMaxOpenPositions,
          currentStage: existingPos?.entryStage ?? 0,
          rangeReversalImmediateSwitch: undefined,
          regimeExitConsumed: this.regimeExitConsumedBySymbol.get(symKeyEarly),
          logger: this.logger
        });

        this.logger.info(
          "PAPER_TRADE_BLOCK_DECOMPOSITION",
          this.paperTradeBlockDecompositionPayload(sym, null, resNull, {
            nowTick: fetchedAt,
            regime: effectiveRegimeForDecision,
            effectiveLane,
            regimeUnknown,
            isAmbiguous: regimeDetected.isAmbiguous,
            maxPositionsReached: false,
            paperMaxOpenPositions: this.config.paperMaxOpenPositions,
            openPositionsTotal: opensAfterClose.length,
            hasOpenForSymbol: !!existingPos,
            dataReady: false
          })
        );
        continue;
      }

      // 2. Decision Logic
      let res = evaluatePaperSymbolEntry({
        config: this.config,
        snapshot: snapForDecision!,
        dataReady: regimeUnknown === false,
        openPositionSide: existingPos?.side ?? null,
        regime: effectiveRegimeForDecision,
        regimeDetail: regimeDetected.detail,
        regimeUnknown,
        isAmbiguous: regimeDetected.isAmbiguous,
        risk: risk,
        adaptiveMode: this.lastAdaptiveMode.mode,
        adaptiveDetail: this.lastAdaptiveMode.detail,
        now: fetchedAt,
        rangeCooldownUntilByKey: this.rangeCooldownUntilByKey,
        trendCooldownUntilBySymbol: this.trendCooldownUntilBySymbol,
        lastCloseMetaBySymbol: lastCloseMetaBySymbolForDecision!,
        reentryCooldownMs: this.config.paperReentryCooldownMs,
        sameDirCooldownMult: 2,
        hasOpenPosition: !!existingPos,
        openPositionsTotal: opensAfterClose.length,
        maxPositionsReached: opensAfterClose.length >= this.config.paperMaxOpenPositions,
        currentStage: existingPos?.entryStage ?? 0,
        rangeReversalImmediateSwitch: rangeReversalImmediateSwitchEarly,
        regimeExitConsumed: this.regimeExitConsumedBySymbol.get(symKeyEarly),
        rangeStopReentryBlock: this.rangeStopReentryBlockedBySymbol.get(symKeyEarly),
        logger: this.logger
      });

      /** Engine-V2 Execution Path (Standard 2: Selector Bridge) */
      const configuredV2Mode = (process.env.ORBITALPHA_ENGINE_V2_MODE as EngineV2OpMode) || "legacy";
      // RANGE lane must not be executed under V1 authority; enforce V2 authority ownership.
      const v2Mode: EngineV2OpMode =
        marketModeOut.routing.activeEngine === "RANGE" ? "engine_v2" : configuredV2Mode;



      const envelope = resolveSymbolDecisionEnvelope({
        symbol: sym,
        fetchedAt,
        snapshot: buildV2SnapshotBridge(snapForDecision!),
        legacy: buildV2LegacyBridge(res),
        config: buildV2ConfigBridge(this.config),
        state: buildV2StateBridge(opensAfterClose, this.lastRisk),
        v2Mode
      });

      const authority = envelope.authority;
      const selectorResult = envelope.selector;

      if (selectorResult) {
        await this.store.appendJsonlLine("reports/v2_shadow_parity.jsonl", {
          ...buildV2ShadowParityPayload(String(sym), fetchedAt, selectorResult),
          v1_decision: envelope.v1_decision,
          v1_side: envelope.v1_side,
          v1_size: envelope.v1_size,
          v2_decision: envelope.v2_decision,
          v2_side: envelope.v2_side,
          v2_size: envelope.v2_size,
          selector_mismatch: envelope.selector_mismatch
        });
      }
      decisionBySymbol.set(symKeyEarly, {
        legacy: res,
        selector: selectorResult,
        authority,
        v1_decision: envelope.v1_decision,
        v1_side: envelope.v1_side,
        v1_size: envelope.v1_size,
        v2_decision: envelope.v2_decision,
        v2_side: envelope.v2_side,
        v2_size: envelope.v2_size,
        selector_mismatch: envelope.selector_mismatch
      });
    } // End of sym loop

    // 1. First closing (including reversals)
    await this.tryPaperPositionClose({
      snapshots,
      errorsCount: errors.length,
      latestPath,
      metaPath,
      filePath,
      marketMode: marketModeOut,
      riskExposure: riskExposureOut,
      decisionBySymbol
    });

    // 2. Then entries/scale-ins
    await this.processPaperSymbolEntries({
      snapshots,
      errorsCount: errors.length,
      candidateRunPath,
      latestPath,
      metaPath,
      filePath,
      decisionBySymbol
    });

    // Post-loop aggregate reporting
    const decisionBySymbolValues: EvaluatePaperSymbolEntryResult[] = [];
    decisionBySymbol.forEach((env) => { decisionBySymbolValues.push(env.legacy); });
    if (decisionBySymbol.size > 0) {
      const legacyMap = new Map<string, EvaluatePaperSymbolEntryResult>();
      decisionBySymbol.forEach((env, k) => legacyMap.set(k, env.legacy));
      const funnel_tick = computeFunnelTick(legacyMap);
      this.decisionFunnelTickRing.push(funnel_tick);
      if (this.decisionFunnelTickRing.length > DECISION_FUNNEL_RING_MAX) {
        this.decisionFunnelTickRing.shift();
      }
      const decision_funnel_50 = sumDecisionFunnelTicks(this.decisionFunnelTickRing);
      const decision_funnel_50_size = this.decisionFunnelTickRing.length;
      const reject_reason_counts_tick = aggregateRejectReasonCountsTick(legacyMap);

      try {
        const risk = this.lastRisk!;
        const regimeBlocked = (risk.blockedRegimes?.[effectiveRegimeForDecision]?.until ?? 0) > fetchedAt;
        const statusRelaxBypass = effectiveRegimeForDecision === "RANGE" &&
          this.config.paperEngineMode === "PAPER_TEST" &&
          decisionBySymbolValues.some((v) =>
            v.decision.range_risk_limit_relax_active === true &&
            (v.decision.risk_cooldown_subreason === "blocked_regime_loss_streak_suspend" ||
              v.decision.risk_cooldown_subreason === "blocked_regime_loss_streak_suspend_relaxed_validation_window" ||
              (v.decision.blocked_regime_reason && v.decision.blocked_regime_reason.indexOf("mode_loss_streak") !== -1) ||
              (v.decision.blocked_regime_reason && v.decision.blocked_regime_reason.indexOf("highway_range_streak") !== -1))
          );

        const statusBlockedReasonOriginal = regimeBlocked
          ? (risk.blockedRegimes?.[effectiveRegimeForDecision]?.reason ?? "mode_suspended")
          : null;
        const statusBlockedReasonFinal = statusRelaxBypass ? null : statusBlockedReasonOriginal;

        await this.store.writeJson("reports/engine-state.json", {
          generatedAt: fetchedAt,
          market_mode_selector: this.lastMarketMode,
          risk_exposure: this.lastRiskExposure,
          explanation: this.lastExplanation,
          last_exit_reason: this.lastExitReasonLabel,
          last_switch_reason: this.lastSwitchReasonLabel,
          engine_mode: this.config.paperEngineMode,
          execution_state: risk.engineBlocked ? "DISABLED" : "PAPER_READY",
          strategy_executor: routingOverride.effectiveExecutionLane,
          current_regime: (routingOverride.effectiveExecutionLane === "IDLE" ? "NO_TRADE" : routingOverride.effectiveExecutionLane) as PaperRegimeState,
          is_ambiguous: regimeDetected.isAmbiguous,
          adaptiveMode: this.lastAdaptiveMode.mode,
          engine_status: risk.dailyLossGuardTriggered ? "PAUSED" : "RUNNING",
          risk_state: risk.riskStatus,
          active_mode_executor: routingOverride.effectiveExecutionLane,
          entryAllowed:
            routingOverride.effectiveExecutionLane !== "IDLE" &&
            risk.engineBlocked !== true &&
            !(regimeBlocked && !statusRelaxBypass),
          blocked_reason:
            routingOverride.effectiveExecutionLane === "IDLE"
              ? (regimeDetected.detail.reason ?? "no_trade")
              : risk.engineBlockReasons?.[0] ?? null,
          expected_move: this.lastEntryDecision?.expected_move ?? null,
          total_cost: this.lastEntryDecision?.total_cost ?? null,
          last_mode_change_at: this.lastModeChangeAt || null,
          recent_loss_streak_by_mode: risk.recentLossStreakByMode,
          daily_loss_guard_triggered: risk.dailyLossGuardTriggered,
          risk_detail: risk.detail,
          decision_funnel_tick: funnel_tick,
          decision_funnel_50,
          decision_funnel_50_size,
          reject_reason_counts_tick,
          symbol_decisions: Object.fromEntries(
            [...decisionBySymbol.entries()].map(([k, v]) => [k, buildEngineStateSymbolDecision(v)])
          )
        });
      } catch (e) {
        this.logger.error("engine_state_write_failed", { error: String(e) });
      }
    }

    // Cleanup memory for stale symbols
    const openAfterEntries = await this.positions.loadOpenAll();
    const openSyms = new Set(openAfterEntries.map(o => String(o.symbol)));
    this.rangeRuntimeBySymbol.forEach((_, symKey) => {
      if (!openSyms.has(symKey)) {
        this.trendHoldMemoryBySymbol.delete(symKey);
        this.trendPyramidLevelBySymbol.delete(symKey);
        // ... other prune logic
        this.regimeExitConsumedBySymbol.delete(symKey);
      }
    });

    try {
      const summary = await this.positions.refreshSummaryReport();
      this.logger.info("summary_report_refreshed", {
        summaryPath: summary.summaryPath,
        health: summary.health.status
      });
    } catch (e) {
      this.logger.error("summary_report_refresh_failed", { error: String(e) });
    }

    if (errors.length > 0) {
      throw new Error(`runOnce failed for ${errors.length} symbol(s)`);
    }
  }

  private async emitPipelineEventsFromDecision(
    first: SymbolSnapshot,
    envelope: PaperEngineDecisionEnvelope,
    nowTs: number,
    entryStage = 0,
    /**
     * When set (final gate, capacity limit, risk cap, etc.), legacy `executorDecision.entry_allowed`
     * must not emit ENTRY_ALLOWED — avoids re-logging after ENTRY_BLOCKED_FINAL_GATE.
     */
    suppressLegacyEntryAllowedReason: string | null | undefined = undefined
  ): Promise<void> {
    const res = envelope.legacy;
    const authority = envelope.authority;
    const sym = String(first.symbol);
    const d = res.decision;
    const ex = res.executorDecision;
    const suppressLegacyEntryAllowed =
      suppressLegacyEntryAllowedReason != null && suppressLegacyEntryAllowedReason !== "";

    if (d.final_decision === "SKIP" && (d.reject_reason === "SIGNAL_NONE" || d.reject_reason === null)) {
      return;
    }

    const effectiveRegime = this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane;
    if (d.final_decision === "SKIP" && d.reject_reason === "LONG_ONLY_SHORT_DEFERRED") {
      await this.store.appendJsonlLine("reports/events.jsonl", {
        ts: nowTs,
        type: "LONG_ONLY_SHORT_DEFERRED",
        symbol: sym,
        regime: effectiveRegime,
        executor: ex?.executor ?? null,
        reject_code: d.reject_reason,
        stage1_result_code: d.stage1_result_code ?? null,
        long_only_restriction: d.long_only_restriction === true,
        original_signal_state: d.original_signal_state ?? null,
        final_signal_state: d.final_signal_state ?? null,
        execution_disabled_reason: d.execution_disabled_reason ?? null,
        expected_move:
          typeof ex?.expected_move === "number" && Number.isFinite(ex.expected_move) ? ex.expected_move : null,
        total_cost: ex?.total_cost ?? null,
        risk_state: ex?.risk_state ?? this.lastRisk?.riskStatus ?? "NORMAL",
        supplemental_reasons: d.supplemental_reasons ?? [],
        adaptive_direction: null,
        detail: res.adaptiveDetail,
        effective_lane: this.lastEffectiveLane,
        ...buildAuthorityEventMeta(authority)
      });
      return;
    }
    if (d.reject_reason === "ORDER_BUILD_FAIL") {
      const structured = orderBuildFailureStructuredPayload(first, res, entryStage, effectiveRegime as MarketRegime);
      await this.store.appendJsonlLine("reports/events.jsonl", {
        ts: nowTs,
        type: "ORDER_BUILD_FAIL",
        reject_code: d.reject_reason,
        stage1_result_code: d.stage1_result_code,
        ...structured,
        ...buildAuthorityEventMeta(authority)
      });
      return;
    }

    if (ex?.entry_allowed && !suppressLegacyEntryAllowed) {
      await this.store.appendJsonlLine("reports/events.jsonl", buildEntryAllowedEventPayload(sym, effectiveRegime, ex, authority));
    }

    if (authority.decision === "REJECT" || authority.decision === "DISABLED") {
      if (ex?.entry_allowed && (d.reject_reason === "AI_REJECT" || d.reject_reason === "AI_DIRECTION_MISMATCH")) {
        const intentSide = (authority.side === "long" || authority.side === "short") ? authority.side : "long";
        const lossStreak = this.lastRisk?.recentLossStreakByMode?.[effectiveRegime as MarketRegime] ?? 0;
        const last10Net =
          typeof this.lastRisk?.detail?.last10_net_usd === "number" && Number.isFinite(this.lastRisk.detail.last10_net_usd)
            ? this.lastRisk.detail.last10_net_usd
            : 0;
        const aiIn = ex
          ? aiInputFromDecision({
            decision: ex,
            executorDirection: intentSide,
            lossStreak,
            last10Net,
            effectiveRegime: effectiveRegime as MarketRegime
          })
          : null;
        if (aiIn) {
          const aiOut = aiApproveEntry(aiIn);
          await this.store.appendJsonlLine("reports/events.jsonl", buildAiEventPayload("AI_APPROVED", sym, effectiveRegime, aiIn, aiOut, authority));
        }
      }

      await this.store.appendJsonlLine("reports/events.jsonl", buildEntryBlockedEventPayload(sym, effectiveRegime, res, authority, this.lastRisk?.riskStatus ?? "NORMAL"));
      return;
    }
  }

  private pruneRangeReversalSwitchPending(symKey: string, snap: SymbolSnapshot | null, nowMs: number): void {
    const p = this.rangeReversalSwitchPendingBySymbol.get(symKey);
    if (!p) return;
    if (nowMs > p.untilMs) {
      this.rangeReversalSwitchPendingBySymbol.delete(symKey);
      return;
    }
    if (snap != null && typeof snap.boxPos === "number" && classifyBoxZone(snap.boxPos) !== p.zone) {
      this.rangeReversalSwitchPendingBySymbol.delete(symKey);
    }
  }

  private getRangeReversalImmediateSwitch(
    symKey: string,
    snap: SymbolSnapshot | null,
    nowMs: number,
    regime: MarketRegime,
    activeEngine: string
  ): RangeReversalImmediateSwitchArg | undefined {
    if (regime !== "RANGE" || activeEngine !== "RANGE") return undefined;
    if (snap == null || typeof snap.boxPos !== "number") return undefined;
    const ex = this.rangeReversalExitThisTickBySymbol.get(symKey);
    if (ex?.range_existing_long_reversal_exit_applied) {
      return { preferredSide: "short", reason: "upper_flatten_to_short" };
    }
    if (ex?.range_existing_short_reversal_exit_applied) {
      return { preferredSide: "long", reason: "lower_flatten_to_long" };
    }
    const pend = this.rangeReversalSwitchPendingBySymbol.get(symKey);
    if (!pend || nowMs > pend.untilMs) return undefined;
    const z = classifyBoxZone(snap.boxPos);
    if (z !== pend.zone) return undefined;
    if (pend.preferredSide === "short" && z === "upper") {
      return { preferredSide: "short", reason: "upper_flatten_to_short_pending" };
    }
    if (pend.preferredSide === "long" && z === "lower") {
      return { preferredSide: "long", reason: "lower_flatten_to_long_pending" };
    }
    return undefined;
  }

  /**
   * 1m kline: Bybit 응답 → 스냅샷 객체 → evaluatePaperSymbolEntry 입력까지 캔들 배열 길이 추적.
   * fetch 빈값 / 스냅샷 누락 / 평가 직전 누락(과거 버그) 구분용.
   */
  private logHighwayCandlePipelineProof(stage: string, payload: Record<string, unknown>): void {
    this.logger.info("HIGHWAY_CANDLE_PIPELINE_PROOF", { pipeline_stage: stage, ...payload });
  }

  /** HIGHWAY_CORE Stage1 과경직: alignment/spacing/volume 붕괴 원인을 executor 단에서 최상위로 남김. */
  private logHighwayCoreStiffnessProofIfNeeded(sym: MarketSymbol, res: EvaluatePaperSymbolEntryResult): void {
    const br = res.executorDecision?.blocked_reason;
    const det = res.executorDecision?.detail as Record<string, unknown> | undefined;
    if (br === "highway_invalid_hard" || br === "highway_invalid_soft") {
      this.logger.warn("HIGHWAY_CORE_STIFFNESS_PROOF", {
        symbol: String(sym),
        regime: res.decision.regime ?? null,
        final_decision: res.decision.final_decision,
        reject_reason: res.decision.reject_reason,
        blocked_reason: br,
        highway_stiffness_proof: det?.highway_stiffness_proof ?? null,
        highway_validity_score: det?.highwayValidityScore ?? null,
        alignment_quality_score: det?.alignmentQualityScore ?? null,
        ema_spacing_health_score: det?.emaSpacingHealthScore ?? null,
        volume_support_score: det?.volumeSupportScore ?? null,
        pullback_quality_score: det?.pullbackQualityScore ?? null,
        highway_invalid_tier: det?.highway_invalid_tier ?? null,
        highway_invalid_reasons: det?.highway_invalid_reasons ?? null,
        score_source: det?.scoreSource ?? null
      });
    }
    if (br === "trend_box_edge_highway_watch") {
      this.logger.warn("HIGHWAY_TREND_BOX_EDGE_WATCH_PROOF", {
        symbol: String(sym),
        regime: res.decision.regime ?? null,
        final_decision: res.decision.final_decision,
        reject_reason: res.decision.reject_reason,
        box_zone: det?.box_zone ?? null,
        highway_stiffness_proof_trend_path: det?.highway_stiffness_proof_trend_path ?? null,
        highway_stiffness_proof_range_attempt: det?.highway_stiffness_proof_range_rescore ?? null
      });
    }
    if (br === "highway_insufficient_candles_watch") {
      this.logger.warn("HIGHWAY_CANDLE_GATE_PROOF", {
        symbol: String(sym),
        regime: res.decision.regime ?? null,
        final_decision: res.decision.final_decision,
        reject_reason: res.decision.reject_reason,
        blocked_reason: br,
        highway_candle_gate_proof: det?.highway_candle_gate_proof ?? null,
        highway_stiffness_proof: det?.highway_stiffness_proof ?? null,
        highway_invalid_reasons: det?.highway_invalid_reasons ?? null
      });
    }
  }

  /**
   * 최종 decision + 모니터 UI가 쓰는 스냅/판정 필드 + 리스크·재진입 활성 값을 한 로그에 묶어
   * “왜 이번 틱에 체결이 더 안 나오는지” 분해한다.
   */
  private paperTradeBlockDecompositionPayload(
    sym: MarketSymbol,
    snap: SymbolSnapshot | null,
    res: EvaluatePaperSymbolEntryResult,
    ctx: Readonly<{
      nowTick: number;
      regime: MarketRegime;
      regimeUnknown: boolean;
      isAmbiguous: boolean;
      maxPositionsReached: boolean;
      paperMaxOpenPositions: number;
      openPositionsTotal: number;
      hasOpenForSymbol: boolean;
      dataReady: boolean;
      effectiveLane: string;
    }>
  ): Record<string, unknown> {
    const d = res.decision;
    const risk = this.lastRisk;
    const rexp = this.lastRiskExposure;
    const ex = res.executorDecision;
    const exDetail = ex?.detail as Record<string, unknown> | undefined;
    const mm = this.lastMarketMode;

    const br = risk?.blockedRegimes?.[ctx.regime];
    const regimeBlockActive = br != null && br.until > ctx.nowTick;

    const uiSourceSnapshot =
      snap == null
        ? { snapshot_absent: true as const }
        : {
          snapshot_absent: false as const,
          signal: snap.signal,
          signal_decision_origin: snap.signalDecisionOrigin ?? null,
          signal_gate_blocked_reason: snap.signalGateBlockedReason ?? null,
          signal_missing_reason: snap.signalMissingReason ?? null,
          quality_score: snap.qualityScore ?? null,
          candidate_strength: snap.candidateStrength ?? null,
          trend_ok: snap.trendOk ?? null,
          regime_state_diag: snap.regimeStateDiag ?? null,
          box_pos: snap.boxPos ?? null,
          range_confidence: snap.rangeConfidence ?? null,
          box_cohesion_01: snap.boxCohesion01 ?? null,
          breakout_failure_rate: snap.breakoutFailureRate ?? null,
          range_oscillation_score: snap.rangeOscillationScore ?? null,
          range_signal_origin: snap.rangeSignalOrigin ?? null,
          range_signal_downgraded: snap.rangeSignalDowngraded ?? null,
          range_signal_downgrade_reason: snap.rangeSignalDowngradeReason ?? null
        };

    const uiSourceDecision = {
      regime: d.regime ?? null,
      current_stage: d.currentStage ?? null,
      signal_state: d.signal_state ?? null,
      final_signal_state: d.final_signal_state ?? null,
      final_decision: d.final_decision,
      reject_reason: d.reject_reason ?? null,
      stage1_result_code: d.stage1_result_code ?? null,
      entry_blocked: d.entry_blocked ?? null,
      guidance: d.guidance ?? null,
      intent_side: res.intentSide,
      adaptive_ok: res.adaptiveOk,
      ai_gate_passed: res.aiGatePassed,
      executor: ex?.executor ?? null,
      executor_entry_allowed: ex?.entry_allowed ?? null,
      executor_blocked_reason: ex?.blocked_reason ?? null,
      range_zone_detected: d.range_zone_detected ?? null,
      range_mid_wait_applied: d.range_mid_wait_applied ?? null,
      range_center_wait: d.range_center_wait ?? null,
      range_upper_edge_near: d.range_upper_edge_near ?? null,
      range_short_allowed: d.range_short_allowed ?? null,
      range_short_allowed_reason: d.range_short_allowed_reason ?? null,
      box_position_diag: d.box_position_diag ?? null,
      range_stage0_engine_taken: d.range_stage0_engine_taken ?? false,
      range_stage0_exit_reason: d.range_stage0_exit_reason ?? null,
      range_final_selected_side: d.range_final_selected_side ?? null,
      range_signal_reason: typeof exDetail?.range_signal_reason === "string" ? exDetail.range_signal_reason : null,
      range_gate_result: typeof exDetail?.range_gate_result === "string" ? exDetail.range_gate_result : null,
      range_fresh_reentry_allowed: d.range_fresh_reentry_allowed ?? false,
      range_fresh_reentry_blocked_reason: d.range_fresh_reentry_blocked_reason ?? null,
      range_fresh_reentry_size_mult: d.range_fresh_reentry_size_mult ?? null,
      range_reentry_wait_bypassed_no_open_position: d.range_reentry_wait_bypassed_no_open_position ?? false,
      range_loss_streak_reduced_entry_applied: d.range_loss_streak_reduced_entry_applied ?? false,
      range_loss_streak_reduced_entry_size_mult: d.range_loss_streak_reduced_entry_size_mult ?? null,
      range_upper_edge_structure_ok: exDetail?.range_upper_edge_structure_ok ?? null,
      range_upper_edge_structure_one_liner: exDetail?.range_upper_edge_structure_one_liner ?? null
    };

    const blockedRegimesCompact =
      risk?.blockedRegimes != null
        ? (Object.entries(risk.blockedRegimes) as [MarketRegime, { until: number; reason: string } | undefined][])
          .filter(([, v]) => v != null)
          .map(([reg, v]) =>
            v
              ? {
                regime: reg,
                until: v.until,
                remaining_ms: Math.max(0, v.until - ctx.nowTick),
                reason: v.reason
              }
              : null
          )
          .filter((x): x is NonNullable<typeof x> => x != null)
        : [];

    let oneLineWhyNoEnter: string;
    if (!ctx.dataReady) {
      oneLineWhyNoEnter = "DATA_NOT_READY: symbol snapshot missing → entry pipeline short-circuited";
    } else if (ctx.maxPositionsReached && !ctx.hasOpenForSymbol) {
      oneLineWhyNoEnter = `CAPACITY: open_slots_full (total=${ctx.openPositionsTotal} max=${ctx.paperMaxOpenPositions}) and this symbol has no position → new entry blocked`;
    } else if (risk?.engineBlocked === true) {
      oneLineWhyNoEnter = `RISK_ENGINE_BLOCKED: ${risk.engineBlockReasons?.[0] ?? "no_reason"}`;
    } else if (ctx.effectiveLane === "IDLE") {
      oneLineWhyNoEnter = `REGIME_IDLE: effective lane is IDLE (raw_regime=${ctx.regime})`;
    } else if (regimeBlockActive && br) {
      oneLineWhyNoEnter = `RISK_REGIME_SUSPENDED: regime=${ctx.regime} remaining_ms=${Math.max(0, br.until - ctx.nowTick)} reason=${br.reason}`;
    } else if (rexp && !rexp.allowNewEntry) {
      oneLineWhyNoEnter = `EXPOSURE_NEW_ENTRY_OFF: ${rexp.riskReasonLabel}`;
    } else if (d.final_decision === "ENTER" && res.adaptiveOk !== true) {
      oneLineWhyNoEnter = "FINAL_ENTER but adaptiveOk=false → adaptive sizing / build did not complete ok";
    } else if (d.final_decision === "ENTER") {
      oneLineWhyNoEnter = "FINAL_ENTER with adaptiveOk=true (if still no fill, check order path / exchange sim)";
    } else {
      const parts = [
        `final_decision=${d.final_decision}`,
        d.reject_reason ? `reject=${d.reject_reason}` : null,
        d.entry_blocked ? `entry_blocked=${d.entry_blocked}` : null,
        ex?.blocked_reason ? `executor_block=${ex.blocked_reason}` : null,
        d.risk_cooldown_subreason ? `risk_cooldown_subreason=${d.risk_cooldown_subreason}` : null,
        typeof d.cooldown_remaining_ms === "number" ? `cooldown_remaining_ms=${d.cooldown_remaining_ms}` : null
      ].filter((x): x is string => x != null);
      oneLineWhyNoEnter = parts.length > 0 ? `DECISION_PATH: ${parts.join(" | ")}` : "No single dominant block; see final_* and executor fields";
    }

    return {
      proof_version: 1,
      marker: "PAPER_TRADE_BLOCK_DECOMPOSITION",
      at_ms: ctx.nowTick,
      symbol: String(sym),
      effective_lane: ctx.effectiveLane,
      data_ready: ctx.dataReady,
      final_core: {
        final_decision: d.final_decision,
        reject_reason: d.reject_reason ?? null,
        stage1_result_code: d.stage1_result_code ?? null,
        entry_blocked: d.entry_blocked ?? null,
        execution_state: d.execution_state ?? null,
        strategy_executor: d.strategy_executor ?? null,
        guidance: d.guidance ?? null
      },
      ui_source_snapshot: uiSourceSnapshot,
      ui_source_decision: uiSourceDecision,
      risk_control_tick: risk
        ? {
          engine_blocked: risk.engineBlocked,
          engine_block_reasons: risk.engineBlockReasons ?? [],
          risk_status: risk.riskStatus,
          daily_loss_guard_triggered: risk.dailyLossGuardTriggered,
          crash_state: risk.crashState,
          crash_reason: risk.crashReason,
          size_multiplier: risk.sizeMultiplier,
          long_allow: risk.longAllow,
          short_allow: risk.shortAllow,
          blocked_regimes_compact: blockedRegimesCompact,
          current_regime_block_active: regimeBlockActive,
          current_regime_block: br
            ? { until: br.until, remaining_ms: Math.max(0, br.until - ctx.nowTick), reason: br.reason }
            : null
        }
        : null,
      risk_exposure_tick: rexp
        ? {
          risk_mode: rexp.riskMode,
          allow_new_entry: rexp.allowNewEntry,
          allow_new_long: rexp.allowNewLong,
          allow_new_short: rexp.allowNewShort,
          allow_add: rexp.allowAdd,
          size_multiplier: rexp.sizeMultiplier,
          allow_range_bidirectional: rexp.allowRangeBidirectional,
          block_trend_opposite_leg: rexp.blockTrendOppositeLeg,
          risk_reason_label: rexp.riskReasonLabel
        }
        : null,
      reentry_and_cooldown: {
        reentry_cooldown_applied: d.reentry_cooldown_applied ?? false,
        reentry_wait_ms: d.reentry_wait_ms ?? null,
        reentry_elapsed_ms: d.reentry_elapsed_ms ?? null,
        cooldown_remaining_ms: d.cooldown_remaining_ms ?? null,
        risk_cooldown_subreason: d.risk_cooldown_subreason ?? null,
        same_dir_cooldown_applied: d.same_dir_cooldown_applied ?? false,
        range_reentry_cooldown_applied: d.range_reentry_cooldown_applied ?? false,
        range_reentry_remaining_ms: d.range_reentry_remaining_ms ?? null,
        range_reentry_same_direction: d.range_reentry_same_direction ?? false,
        range_reentry_source: d.range_reentry_source ?? null,
        range_fresh_reentry_allowed: d.range_fresh_reentry_allowed ?? false,
        range_fresh_reentry_blocked_reason: d.range_fresh_reentry_blocked_reason ?? null,
        range_reentry_wait_bypassed_no_open_position: d.range_reentry_wait_bypassed_no_open_position ?? false
      },
      capacity: {
        max_positions_reached: ctx.maxPositionsReached,
        paper_max_open_positions: ctx.paperMaxOpenPositions,
        open_positions_total: ctx.openPositionsTotal,
        has_open_this_symbol: ctx.hasOpenForSymbol
      },
      regime_and_routing: {
        detected_regime: ctx.regime,
        regime_unknown_data: ctx.regimeUnknown,
        is_ambiguous: ctx.isAmbiguous,
        active_engine: mm?.routing.activeEngine ?? null,
        new_entry_policy: mm?.routing.newEntryPolicy ?? null
      },
      one_line_why_no_enter: oneLineWhyNoEnter
    };
  }

  private resolveEntryIdentity(
    authority: EntryExecutionAuthority,
    decision: NonNullable<EvaluatePaperSymbolEntryResult["executorDecision"]>,
    liveRegime: PaperRegimeState
  ): {
    effectiveStrategyVersion: "paper-v1" | "paper-v2";
    effectiveSourceSignal: "paper_long_candidate" | "paper_short_candidate" | "paper_long_candidate_v2" | "paper_short_candidate_v2";
    effectiveExecutorAtEntry: "RANGE" | "TREND" | "IDLE";
    effectiveRegimeAtEntry: PaperRegimeState;
    attachRangeMetadata: boolean;
  } {
    const isV2 = authority.source === "v2";
    const effectiveStrategyVersion = isV2 ? "paper-v2" : "paper-v1";

    const effectiveSourceSignal = isV2
      ? authority.side === "long"
        ? "paper_long_candidate_v2"
        : "paper_short_candidate_v2"
      : authority.side === "long"
        ? "paper_long_candidate"
        : "paper_short_candidate";

    const authReg = String(authority.regime ?? "").trim().toUpperCase();

    let effectiveExecutorAtEntry: "RANGE" | "TREND" | "IDLE";
    let effectiveRegimeAtEntryCandidate: PaperRegimeState;

    if (authReg === "RANGE") {
      effectiveExecutorAtEntry = "RANGE";
      effectiveRegimeAtEntryCandidate = "RANGE";
    } else if (authReg === "TREND") {
      effectiveExecutorAtEntry = "TREND";
      effectiveRegimeAtEntryCandidate = "TREND";
    } else {
      effectiveExecutorAtEntry =
        decision.executor === "TREND"
          ? "TREND"
          : decision.executor === "RANGE"
            ? "RANGE"
            : "IDLE";
      effectiveRegimeAtEntryCandidate =
        effectiveExecutorAtEntry === "TREND"
          ? "TREND"
          : effectiveExecutorAtEntry === "RANGE"
            ? "RANGE"
            : liveRegime;
    }

    const normalizedRegimeAtEntry: any =
      effectiveRegimeAtEntryCandidate === "UNKNOWN" ? "NO_TRADE" : effectiveRegimeAtEntryCandidate;

    return {
      effectiveStrategyVersion,
      effectiveSourceSignal,
      effectiveExecutorAtEntry,
      effectiveRegimeAtEntry: normalizedRegimeAtEntry,
      attachRangeMetadata: normalizedRegimeAtEntry === "RANGE" && effectiveExecutorAtEntry === "RANGE"
    };
  }

  private isTrendManagedPosition(pos: PaperOpenPositionRecord): boolean {
    if (pos.executorAtEntry === "RANGE") return false;
    if (pos.regimeAtEntry === "RANGE" && pos.executorAtEntry !== "TREND") return false;
    const sourceSignal = typeof pos.sourceSignal === "string" ? pos.sourceSignal : "";
    if (pos.executorAtEntry === "TREND" || pos.regimeAtEntry === "TREND") return true;
    return (
      pos.strategyVersion === "paper-v2" ||
      sourceSignal.includes("_v2") ||
      (pos.executorAtEntry === undefined && pos.strategyVersion === "paper-v2")
    );
  }

  private isEntryPostOpenRegimeLaneProtectActive(openedAt: number, evalAtMs: number): boolean {
    const elapsed = evalAtMs - openedAt;
    return elapsed >= 0 && elapsed < ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS;
  }

  /** true → 전량 청산을 이번 틱에서 하지 않고 유지(장세/레인 전환성). 손절·리스크 한도 등은 호출부에서 별도 허용. */
  private shouldDeferRegimeLaneTransitionClose(
    open: PaperOpenPositionRecord,
    evalAtMs: number,
    closeReason: PaperClosedPositionRecord["closeReason"] | "highway_ema60_break_long" | "highway_ema60_break_short"
  ): boolean {
    if (!this.isEntryPostOpenRegimeLaneProtectActive(open.openedAt, evalAtMs)) return false;
    switch (closeReason) {
      case "regime_exit":
      case "structural_regime_shift":
      case "range_box_break":
      case "range_profit_trail":
      case "trend_break_exit":
      case "candidate_lost":
      case "trend_switch":
      case "highway_ema60_break_long":
      case "highway_ema60_break_short":
        return true;
      default:
        return false;
    }
  }

  /**
   * trend_break 하위 트리거 이후 전량 청산은 상위 시장모드·동틱 V2 authority로만 EXIT 확정.
   * MIXED/TRANSITION·구조 흔들림만으로는 DE_RISK, TREND 레인+반대 ENTER 확정 시에만 EXIT.
   */
  private classifyUpperExitAuthorityTrendBreakTrigger(input: Readonly<{
    marketMode: PaperMarketMode;
    trendOkNow: boolean;
    positionSide: "long" | "short";
    snapSignal: string;
    v2Decision: string | undefined;
    v2Side: string | undefined;
  }>): "HOLD" | "DE_RISK" | "EXIT" {
    const { marketMode, trendOkNow, positionSide, snapSignal, v2Decision, v2Side } = input;

    const opposingSignal =
      (positionSide === "long" && snapSignal === "paper_short_candidate") ||
      (positionSide === "short" && snapSignal === "paper_long_candidate");

    if (marketMode === "RANGE" || marketMode === "NO_TRADE") {
      return "EXIT";
    }
    if (marketMode === "MIXED" || marketMode === "TRANSITION") {
      return "DE_RISK";
    }
    if (marketMode === "TREND" && !trendOkNow) {
      const v2WantsOpposite =
        v2Decision === "ENTER" &&
        v2Side != null &&
        ((positionSide === "long" && v2Side === "short") || (positionSide === "short" && v2Side === "long"));
      if (opposingSignal && v2WantsOpposite) {
        return "EXIT";
      }
      return "DE_RISK";
    }
    if (marketMode === "TREND" && trendOkNow) {
      return "HOLD";
    }
    return "DE_RISK";
  }

  /**
   * RANGE 구간·반전 스위치·적응형까지 한 틱에서 추적(상단 롱 편향·숏 미체결 원인 증명용).
   */
  private rangeZoneEvalProofPayload(
    sym: MarketSymbol,
    snap: SymbolSnapshot | null,
    res: EvaluatePaperSymbolEntryResult,
    rangeReversalImmediateSwitchIn: RangeReversalImmediateSwitchArg | undefined,
    openPositionSide: "long" | "short" | null = null
  ): Record<string, unknown> {
    const d = res.decision;
    const boxPos = snap?.boxPos ?? null;
    const zone = typeof boxPos === "number" && Number.isFinite(boxPos) ? classifyBoxZone(boxPos) : null;
    const sup = d.supplemental_reasons ?? [];
    const raw = snap?.signal ?? null;
    const upperLongRaw = zone === "upper" && raw === "paper_long_candidate";
    const exDetail = res.executorDecision?.detail as Record<string, unknown> | undefined;
    const rangeSigReason =
      typeof exDetail?.range_signal_reason === "string" ? (exDetail.range_signal_reason as string) : null;
    const rangeSigState =
      typeof exDetail?.range_signal === "string" ? (exDetail.range_signal as string) : null;
    const revIn = rangeReversalImmediateSwitchIn ?? null;
    const stalled =
      revIn != null &&
      (d.final_decision !== "ENTER" || res.adaptiveOk !== true || res.adaptiveResult == null);
    return {
      symbol: String(sym),
      box_pos: boxPos,
      zone,
      raw_snapshot_signal: raw,
      signal_decision_origin: snap?.signalDecisionOrigin ?? null,
      range_signal_kept_by_relax: snap?.rangeSignalKeptByRelax ?? false,
      /** (1) 상단에서 raw long 후보가 들어와도 stage0가 무력화하는지 */
      upper_zone_long_candidate_received: upperLongRaw,
      range_stage0_inner_signal_reason: rangeSigReason,
      range_stage0_inner_signal_state: rangeSigState,
      range_stage0_branch_proof: d.range_stage0_branch_proof ?? null,
      range_upper_edge_structure_ok: exDetail?.range_upper_edge_structure_ok ?? null,
      range_upper_edge_structure_failed_checks: exDetail?.range_upper_edge_structure_failed_checks ?? null,
      range_upper_edge_structure_one_liner: exDetail?.range_upper_edge_structure_one_liner ?? null,
      range_reversal_immediate_switch_input: revIn,
      range_stage0_engine_taken: d.range_stage0_engine_taken ?? false,
      range_zone_detected: d.range_zone_detected ?? null,
      range_final_trade_side_by_zone: d.range_final_trade_side_by_zone ?? null,
      range_final_selected_side: d.range_final_selected_side ?? null,
      range_reversal_immediate_switch_applied: d.range_reversal_immediate_switch_applied ?? false,
      range_reversal_immediate_switch_reason: d.range_reversal_immediate_switch_reason ?? null,
      range_mid_wait_applied: d.range_mid_wait_applied ?? false,
      legacy_executor_path_taken: d.legacy_executor_path_taken ?? false,
      legacy_block_test_bypass_applied: d.legacy_block_test_bypass_applied ?? false,
      final_decision: d.final_decision,
      reject_reason: d.reject_reason ?? null,
      intent_side: res.intentSide,
      /** (2)(4) short 평가 이후 적응형·게이트 */
      adaptive_ok: res.adaptiveOk,
      adaptive_direction: null,
      ai_gate_passed: res.aiGatePassed,
      stage1_result_code: d.stage1_result_code ?? null,
      entry_blocked: d.entry_blocked ?? null,
      /** 소프트 롱 승격(하단 전용이나 UNKNOWN 경로에서 롱 편향 재기동 여부) */
      soft_long_v2_path: sup.some((x) => x.includes("STAGE1_SIGNAL_RELAXED_SOFT_CANDIDATE_V2")),
      unknown_regime_range_fallback: sup.some((x) => x.includes("STAGE1_UNKNOWN_REGIME_RANGE_FALLBACK")),
      /** (3) 반전 스위치가 켜졌는데도 ENTER/adaptive 미도달 */
      reversal_switch_stalled: stalled,
      /** stage0가 아닌 경로(레거시 하이웨이 등)에서 상단 롱 의도 — 편향 재기동 추적 */
      long_intent_upper_without_range_stage0:
        d.range_stage0_engine_taken !== true &&
        zone === "upper" &&
        res.intentSide === "long",
      /** 정책 위반 의심: stage0인데 상단·롱 의도 */
      range_stage0_upper_long_intent_anomaly:
        d.range_stage0_engine_taken === true &&
        zone === "upper" &&
        res.intentSide === "long",
      order_build_fail_reason: d.order_build_fail_reason ?? null,
      order_build_fail_stage: d.order_build_fail_stage ?? null,
      open_position_side: openPositionSide
    };
  }

  private async tryPaperPositionClose(input: Readonly<{
    snapshots: SymbolSnapshot[];
    errorsCount: number;
    latestPath: string | undefined;
    metaPath: string | undefined;
    filePath: string | undefined;
    marketMode: MarketModeSelectorOutput;
    riskExposure: RiskExposureOutput;
    decisionBySymbol: ReadonlyMap<string, PaperEngineDecisionEnvelope>;
  }>): Promise<void> {
    if (input.errorsCount > 0) return;

    const rawOpens = await this.positions.loadOpenAll();
    if (rawOpens.length === 0) return;
    const opens = rawOpens.map(o => ({ ...o })); // Use mutable copy for state tracking
    let crashPositionsModified = false;
    let openLedgerPruned = false;
    const crashForceClosedKeys = new Set<string>();
    const crashReducedThisTickKeys = new Set<string>();

    /** Issued only immediately after a successful `appendClosed` row with full attestation (never from terminal-dedup shortcut). */
    const openLedgerPruneAuthorizedFlowIds = new Set<string>();
    const authorizeOpenLedgerPruneAfterAttestedClose = (fid: string, closedRow: PaperClosedPositionRecord) => {
      if (!isPaperCloseAttestationComplete(closedRow)) {
        this.logger.error("LEDGER_PRUNE_AUTHORIZATION_DENIED_INCOMPLETE_CLOSE_ATTESTATION", {
          flowId: fid,
          closeReason: closedRow.closeReason,
          exitType: closedRow.exitType,
          closeSource: closedRow.closeSource
        });
        return;
      }
      openLedgerPruneAuthorizedFlowIds.add(fid);
    };

    // --- ASYMMETRIC CRASH RISK LAYER ---
    const risk = this.lastRisk;
    if (risk && risk.crashState !== "NONE") {
      for (const op of opens) {
        if (op.status !== "open") continue;
        const snap = input.snapshots.find(s => s.symbol === op.symbol);
        if (!snap) continue;

        const isLong = op.side === "long";
        const isShort = op.side === "short";
        const inheritedStrategyVersion = op.strategyVersion ?? "paper-v1";

        // 1. Long Defense (Force Liquidate)
        if (isLong) {
          const forceExit = risk.crashState === "CRASH_EXIT" || risk.crashState === "CRASH_LOCK";
          const forceReduce = risk.crashState === "CRASH_REDUCE";

          if (forceExit || forceReduce) {
            const marginToClose = forceExit ? op.sizeUsd : op.sizeUsd * 0.5;
            const m = computePaperCloseLegMetrics({
              open: op,
              closePrice: snap.lastPrice,
              closedAt: snap.fetchedAt,
              snapFundingRate: snap.fundingRate,
              marginUsd: marginToClose,
              paperTakerFeeRate: this.config.paperTakerFeeRate,
              paperFundingIntervalHours: this.config.paperFundingIntervalHours
            });

            const et = forceExit ? "EXIT_LONG_CRASH_FORCE" : "EXIT_LONG_CRASH_REDUCE";
            const closedRow = finalizePaperClosedRecord({
              open: op,
              symbol: op.symbol,
              closePrice: snap.lastPrice,
              closedAt: snap.fetchedAt,
              closeReason: et as PaperClosedPositionRecord["closeReason"],
              legMarginUsd: marginToClose,
              metrics: m,
              feeRate: this.config.paperTakerFeeRate,
              fundingIntervalHours: this.config.paperFundingIntervalHours,
              strategyVersion: inheritedStrategyVersion,
              exitTypeOverride: et,
              closeSourceOverride: "CRASH_LONG_DEFENSE"
            });

            await this.positions.appendClosed(closedRow);
            authorizeOpenLedgerPruneAfterAttestedClose(`${op.symbol}:${op.side}:${op.openedAt}`, closedRow);
            this.logger.warn("crash_long_defense", { symbol: op.symbol, state: risk.crashState, type: et });

            await this.store.appendJsonlLine("reports/events.jsonl", {
              ts: Date.now(),
              type: et,
              symbol: op.symbol,
              reason: et,
              realized_pnl: m.pnlUsdNet,
              ...buildPositionIdentityMeta(op)
            });

            const key = `${op.symbol}:${op.openedAt}`;
            if (forceExit) {
              (op as { status: string; sizeUsd: number }).status = "closed";
              crashForceClosedKeys.add(key);
              crashPositionsModified = true;
            } else {
              op.sizeUsd -= marginToClose;
              crashReducedThisTickKeys.add(key);
              crashPositionsModified = true;
            }
          }
        }

        // 2. Short Opportunity (Trailing Protection)
        // 숏은 강제 종료하지 않되, 급락 상태에서는 수익 보호를 위해 트레일링 로직 개입 여부만 여기서 플래그 세팅하거나 
        // 하단 일반 로직에서 risk.crashState를 참고하도록 설계.
        // 여기서는 '급락 중 숏 수익보호 모드' 진입 로깅만 남김.
        if (isShort && (risk.crashState === "CRASH_EXIT" || risk.crashState === "CRASH_REDUCE")) {
          this.logger.info("crash_short_opportunity", { symbol: op.symbol, state: risk.crashState, latePursuit: risk.isLatePursuit });
        }
      }
    }
    // ------------------------------------

    let remaining: PaperOpenPositionRecord[] = [];
    const stopBackfillSaveExpectations: Array<{
      flowId: string;
      symbol: string;
      side: string;
      openedAt: number;
      expectedStopPrice: number;
    }> = [];
    const feeRate = this.config.paperTakerFeeRate;
    const intervalH = this.config.paperFundingIntervalHours;

    /** events.jsonl `type` — 레거시 호환(부분익절·트레일 등은 기존과 동일 계열로 유지). */
    const exitEventJsonlType = (r: PaperClosedPositionRecord["closeReason"]): "EXIT_TP" | "EXIT_REGIME" | "EXIT_TREND_BREAK" | "EXIT_SL" | "EXIT_TIME_STOP" | string => {
      if (r === "time_based_exit") return "EXIT_TIME_STOP";
      if (r === "stop_loss") return "EXIT_SL";
      const t = paperExitDisplayMeta(r).exitType;
      if (t === "EXIT_PARTIAL_SPLIT_1" || t === "EXIT_PARTIAL_SPLIT_2") return "EXIT_PARTIAL_SPLIT";
      if (t === "EXIT_PARTIAL_TP" || t === "EXIT_TP_1" || t === "EXIT_TP_2") return "EXIT_TP";
      if (t === "EXIT_TIME_STOP") return "EXIT_TIME_STOP";
      if (t === "EXIT_SL") return "EXIT_SL";
      if (t === "EXIT_TRAILING" || t === "EXIT_REGIME") return "EXIT_REGIME";
      if (t === "EXIT_REGIME_BREAK") return "EXIT_TREND_BREAK";
      return t;
    };

    const exitDetailBase = (open: PaperOpenPositionRecord, m: PaperCloseLegMetrics) => ({
      mode: open.adaptiveModeAtEntry ?? this.lastAdaptiveMode.mode,
      direction: open.side,
      confidenceScore: open.entryConfidenceScore,
      confidenceTier: open.entryConfidenceTier,
      sizeMultiplier: open.entrySizeMultiplier,
      finalPositionSize: open.initialSizeUsd ?? open.sizeUsd,
      remainingSizeUsd: open.sizeUsd,
      pnl: m.pnlUsdNet,
      highestPnl: open.highestPnlPctNet,
      holdingTime: m.holdingMs,
      partialExitStage: open.partialExitStage ?? 0
    });

    for (const openRaw of opens) {
      const posKey = `${openRaw.symbol}:${openRaw.openedAt}`;
      // Unique flow identifier for one-shot terminal exit deduplication
      const flowId = `${openRaw.symbol}:${openRaw.side}:${openRaw.openedAt}`;

      if (this.terminalExitConsumedByFlow.has(flowId)) {
        openLedgerPruned = true;
        this.logger.info("EXIT_TERMINAL_DEDUP_PROOF", {
          symbol: openRaw.symbol,
          side: openRaw.side,
          openedAt: openRaw.openedAt,
          flowId,
          terminal_exit_already_consumed: true,
          action: "blocking_repetitive_exit",
          note: "이 포지션 흐름은 이미 터미널 종료가 발생했으므로 중복 이벤트를 차단함"
        });
        this.logger.info("TERMINAL_FLOW_PRUNED_FROM_OPEN_LEDGER", {
          symbol: openRaw.symbol,
          side: openRaw.side,
          openedAt: openRaw.openedAt,
          flowId,
          prune_reason: "terminal_exit_already_consumed",
          action: "excluded_from_remaining"
        });
        continue;
      }

      const nStage = normalizeEntryStageFromSizeEvidence(openRaw);
      const nRange = normalizeRangeManagementState(nStage.normalized);
      const finalNorm = nRange.normalized;

      let open: PaperOpenPositionRecord = {
        ...finalNorm,
        initialSizeUsd: finalNorm.initialSizeUsd ?? openRaw.sizeUsd,
        partialExitStage: finalNorm.partialExitStage ?? 0,
        rangeManagementState: finalNorm.rangeManagementState ?? "INIT",
        rangeAddOnUsed: finalNorm.rangeAddOnUsed ?? false,
        rangeFirstProfitLocked: finalNorm.rangeFirstProfitLocked ?? false
      };

      // Backfill stopPrice if missing for existing positions
      if (open.status === "open" && (open.stopPrice === undefined || open.stopPrice === null || !Number.isFinite(open.stopPrice))) {
        const slRegime = open.regimeAtEntry ?? "UNKNOWN";
        const slPct = stopLossPctForRegime(slRegime as any);
        const ep = open.entryPrice;
        if (ep > 0) {
          const oldStop = open.stopPrice;
          const newStop = open.side === "long" ? ep * (1 + slPct) : ep * (1 - slPct);
          open = {
            ...open,
            stopPrice: newStop
          };
          crashPositionsModified = true; // Trigger saveOpenAll
          this.logger.info("STOP_BACKFILL_APPLIED", {
            symbol: open.symbol,
            side: open.side,
            openedAt: open.openedAt,
            oldStopPrice: oldStop ?? null,
            newStopPrice: newStop,
            source: "ledger_normalization_backfill"
          });
          stopBackfillSaveExpectations.push({
            flowId: `${open.symbol}:${open.side}:${open.openedAt}`,
            symbol: open.symbol,
            side: open.side,
            openedAt: open.openedAt,
            expectedStopPrice: newStop
          });
        }
      }

      const inheritedStrategyVersion = open.strategyVersion ?? "paper-v1";
      const trendManagedPosition = this.isTrendManagedPosition(open);
      const rangeManagedPosition =
        open.regimeAtEntry === "RANGE" &&
        open.executorAtEntry !== "TREND" &&
        !trendManagedPosition;

      const blockedByExecutorMismatch =
        open.regimeAtEntry === "RANGE" &&
        trendManagedPosition;

      const exitLane: "RANGE" | "TREND" =
        trendManagedPosition ? "TREND" : "RANGE";

      let finalCloseReason: PaperClosedPositionRecord["closeReason"] | "none" = "none";
      let confirmedExitType: string | null = null;
      let confirmedCloseSource: string | null = null;
      let posTrail: PaperOpenPositionRecord = { ...open };

      this.logger.info("REGIME_EXIT_GUARD_PROOF", {
        symbol: open.symbol,
        strategyVersion: open.strategyVersion,
        sourceSignal: open.sourceSignal,
        executorAtEntry: open.executorAtEntry,
        regimeAtEntry: open.regimeAtEntry,
        trendManagedPosition,
        rangeManagedPosition,
        exitLane,
        blockedByExecutorMismatch,
        requestedRangePath: rangeManagedPosition === true,
        requestedTrendPath: trendManagedPosition === true,
        finalCloseAction: "evaluating",
        finalCloseReason
      });

      // A. FORCE CLOSED Short-Circuit: Absolutely exclude from "remaining" to prevent re-entry.
      if (crashForceClosedKeys.has(posKey)) {
        this.logger.info("force_closed_position_excluded_from_open_ledger", {
          symbol: openRaw.symbol,
          openedAt: openRaw.openedAt,
          excluded_from_remaining: true
        });
        continue;
      }

      // B. REDUCE Short-Circuit: Skip general pipeline, push reduced object, and continue.
      if (crashReducedThisTickKeys.has(posKey)) {
        remaining.push(openRaw);
        this.logger.info("crash_close_short_circuit_applied", {
          symbol: openRaw.symbol,
          openedAt: openRaw.openedAt,
          crash_action: "CRASH_REDUCE",
          skipped_general_close_pipeline: true,
          remaining_size_usd_after_crash: openRaw.sizeUsd
        });
        continue;
      }

      if (openRaw.status !== "open") {
        continue;
      }

      const snap = input.snapshots.find((s) => s.symbol === openRaw.symbol);
      if (!snap) {
        remaining.push(openRaw);
        continue;
      }

      const symbol = open.symbol;
      const sk = String(symbol);
      const envelope = input.decisionBySymbol.get(sk)!;
      if (!envelope) {
        remaining.push(open);
        continue;
      }

      const closePrice = snap.lastPrice;
      const closedAt = snap.fetchedAt;
      const regimeAtEntry = open.regimeAtEntry ?? "NO_TRADE";
      const regimeNow = input.marketMode.marketMode as MarketRegime;
      const slRegime: MarketRegime = exitLane === "RANGE" ? "RANGE" : "TREND";
      const leg = (marginUsd: number) =>
        computePaperCloseLegMetrics({
          open,
          closePrice,
          closedAt,
          snapFundingRate: snap.fundingRate,
          marginUsd,
          paperTakerFeeRate: this.config.paperTakerFeeRate,
          paperFundingIntervalHours: this.config.paperFundingIntervalHours
        });

      let m = leg(open.sizeUsd);
      const highWater = Math.max(open.highestPnlPctNet ?? m.pnlPctNet, m.pnlPctNet);
      open = { ...open, highestPnlPctNet: highWater };

      const snapPaths = {
        ...(input.latestPath ? { latestSnapshotPath: input.latestPath } : {}),
        ...(input.metaPath ? { latestMetaPath: input.metaPath } : {}),
        ...(input.filePath ? { timestampSnapshotPath: input.filePath } : {})
      };

      const toClosed = (
        cr: PaperClosedPositionRecord["closeReason"],
        metrics: PaperCloseLegMetrics,
        legMarginUsd: number
      ): PaperClosedPositionRecord =>
        finalizePaperClosedRecord({
          open,
          symbol: open.symbol,
          closePrice,
          closedAt,
          closeReason: cr,
          legMarginUsd,
          metrics,
          feeRate,
          fundingIntervalHours: intervalH,
          strategyVersion: inheritedStrategyVersion,
          ...snapPaths
        });

      const symKey = String(open.symbol);
      const { longUsd, shortUsd } = marginsForSymbol(opens, symKey);
      const rr = this.rangeRuntimeBySymbol.get(symKey) ?? {
        lastZone: null as RangeBoxZone | null,
        cycle: 0,
        ladder: 0
      };

      let rangeState = null as ReturnType<typeof evaluateRangeEngineForSymbol> | null;
      if (rangeManagedPosition) {
        rangeState = evaluateRangeEngineForSymbol({
          symbol: symKey,
          lastPrice: closePrice,
          boxHigh: snap.boxHigh,
          boxLow: snap.boxLow,
          boxPos: snap.boxPos,
          marketMode: input.marketMode,
          longMarginUsd: longUsd,
          shortMarginUsd: shortUsd,
          rangeCycleCountPrior: rr.cycle,
          rangeLadderLevelPrior: rr.ladder,
          lastZone: rr.lastZone
        });
        this.rangeRuntimeBySymbol.set(symKey, {
          lastZone: rangeState.boxZone,
          cycle: rangeState.rangeCycleCount,
          ladder: rangeState.rangeLadderLevel
        });
        this.logger.info("range_engine_tick", rangeState);

        if (rangeState) {
          if (open.side === "long" && typeof snap.boxPos === "number" && Number.isFinite(snap.boxPos)) {
            const raZone = classifyRangeActionZone(snap.boxPos);
            if (raZone === "upper") {
              this.logger.info("REGIME_EXIT_GUARD_PROOF", {
                symbol: open.symbol,
                side: open.side,
                strategyVersion: open.strategyVersion,
                sourceSignal: open.sourceSignal,
                regimeAtEntry: open.regimeAtEntry,
                executorAtEntry: open.executorAtEntry,
                exit_reason_candidate: "regime_exit",
                lane: "range_long_upper_reversal",
                range_exit_guard_blocked: blockedByExecutorMismatch
              });
              if (blockedByExecutorMismatch) {
                this.logger.info("REGIME_EXIT_GUARD_BLOCKED", { symbol: open.symbol, reason: "executor_mismatch_v2_protection", lane: "range_long_upper_reversal" });
                finalCloseReason = "none";
                remaining.push(open);
                continue;
              }

              if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "regime_exit")) {
                this.logger.info("ENTRY_POST_OPEN_REGIME_LANE_PROTECT_ACTIVE", {
                  symbol: open.symbol,
                  side: open.side,
                  flowId,
                  openedAt: open.openedAt,
                  eval_at_ms: closedAt,
                  elapsed_ms: closedAt - open.openedAt,
                  protect_window_ms: ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS,
                  deferred_close_reason: "regime_exit",
                  lane: "range_long_upper_reversal"
                });
                remaining.push(open);
                continue;
              }

              const cr = "regime_exit" as const;
              finalCloseReason = cr;
              confirmedExitType = exitEventJsonlType(cr);
              confirmedCloseSource = "range_reversal_logic";
              const closedRow = finalizePaperClosedRecord({
                open,
                symbol: open.symbol,
                closePrice,
                closedAt,
                closeReason: cr,
                legMarginUsd: open.sizeUsd,
                metrics: m,
                feeRate,
                fundingIntervalHours: intervalH,
                strategyVersion: inheritedStrategyVersion,
                closeReasonLabelOverride: "상단 반전 구간: 롱 정리(숏 평가 우선)",
                ...snapPaths
              });
              await this.positions.appendClosed(closedRow);
              authorizeOpenLedgerPruneAfterAttestedClose(flowId, closedRow);
              this.rangeReversalExitThisTickBySymbol.set(symKey, {
                ...(this.rangeReversalExitThisTickBySymbol.get(symKey) ?? {}),
                range_existing_long_reversal_exit_applied: true
              });
              this.logger.info("RANGE_CLOSE_ALIGNMENT_PROOF", {
                symbol: symKey,
                side: open.side,
                range_zone_detected: raZone,
                range_hold_alignment: false,
                range_hold_misaligned_exit_applied: true,
                box_pos: snap.boxPos,
                phase: "pre_exit_eval_regime_exit_long_upper"
              });
              this.rangeReversalSwitchPendingBySymbol.set(symKey, {
                untilMs: Date.now() + RANGE_REVERSAL_SWITCH_PENDING_MS,
                preferredSide: "short",
                zone: "upper"
              });
              this.lastExitReasonLabel = "상단 반전 구간 롱 정리";

              const mappedType = exitEventJsonlType(cr);
              this.terminalExitConsumedByFlow.add(flowId);
              if (mappedType === "EXIT_REGIME" || mappedType === "EXIT_TREND_BREAK" || mappedType === "EXIT_RANGE_REBALANCE") {
                this.regimeExitConsumedBySymbol.set(symKey, { side: open.side, ts: Date.now() });
              }

              this.logger.info("EXIT_CLASSIFICATION_PROOF", {
                symbol: open.symbol,
                side: open.side,
                openedAt: open.openedAt,
                raw_reason: cr,
                mapped_exit_type: mappedType,
                flowId
              });

              await this.store.appendJsonlLine("reports/events.jsonl", {
                ts: Date.now(),
                type: mappedType,
                symbol: symKey,
                reason: cr,
                range_zone_reversal: "upper_long_flatten",
                realized_pnl: m.pnlUsdNet,
                ...buildPositionIdentityMeta(open)
              });
              continue;
            }
          }
          if (open.side === "short" && typeof snap.boxPos === "number" && Number.isFinite(snap.boxPos)) {
            const raZone = classifyRangeActionZone(snap.boxPos);
            if (raZone === "lower") {
              this.logger.info("REGIME_EXIT_GUARD_PROOF", {
                symbol: open.symbol,
                side: open.side,
                strategyVersion: open.strategyVersion,
                sourceSignal: open.sourceSignal,
                regimeAtEntry: open.regimeAtEntry,
                executorAtEntry: open.executorAtEntry,
                exit_reason_candidate: "regime_exit",
                lane: "range_short_lower_reversal",
                range_exit_guard_blocked: blockedByExecutorMismatch
              });
              if (blockedByExecutorMismatch) {
                this.logger.info("REGIME_EXIT_GUARD_BLOCKED", { symbol: open.symbol, reason: "executor_mismatch_v2_protection", lane: "range_short_lower_reversal" });
                finalCloseReason = "none";
                remaining.push(open);
                continue;
              }

              if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "regime_exit")) {
                this.logger.info("ENTRY_POST_OPEN_REGIME_LANE_PROTECT_ACTIVE", {
                  symbol: open.symbol,
                  side: open.side,
                  flowId,
                  openedAt: open.openedAt,
                  eval_at_ms: closedAt,
                  elapsed_ms: closedAt - open.openedAt,
                  protect_window_ms: ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS,
                  deferred_close_reason: "regime_exit",
                  lane: "range_short_lower_reversal"
                });
                remaining.push(open);
                continue;
              }

              const cr = "regime_exit" as const;
              finalCloseReason = cr;
              confirmedExitType = exitEventJsonlType(cr);
              confirmedCloseSource = "range_reversal_logic";
              const closedRow = finalizePaperClosedRecord({
                open,
                symbol: open.symbol,
                closePrice,
                closedAt,
                closeReason: cr,
                legMarginUsd: open.sizeUsd,
                metrics: m,
                feeRate,
                fundingIntervalHours: intervalH,
                strategyVersion: inheritedStrategyVersion,
                closeReasonLabelOverride: "하단 반전 구간: 숏 정리(롱 평가 우선)",
                ...snapPaths
              });
              await this.positions.appendClosed(closedRow);
              authorizeOpenLedgerPruneAfterAttestedClose(flowId, closedRow);
              this.rangeReversalExitThisTickBySymbol.set(symKey, {
                ...(this.rangeReversalExitThisTickBySymbol.get(symKey) ?? {}),
                range_existing_short_reversal_exit_applied: true
              });
              this.logger.info("RANGE_CLOSE_ALIGNMENT_PROOF", {
                symbol: symKey,
                side: open.side,
                range_zone_detected: raZone,
                range_hold_alignment: false,
                range_hold_misaligned_exit_applied: true,
                box_pos: snap.boxPos,
                phase: "pre_exit_eval_regime_exit_short_lower"
              });
              this.rangeReversalSwitchPendingBySymbol.set(symKey, {
                untilMs: Date.now() + RANGE_REVERSAL_SWITCH_PENDING_MS,
                preferredSide: "long",
                zone: "lower"
              });
              this.lastExitReasonLabel = "하단 반전 구간 숏 정리";

              const mappedType = exitEventJsonlType(cr);
              this.terminalExitConsumedByFlow.add(flowId);
              if (mappedType === "EXIT_REGIME" || mappedType === "EXIT_TREND_BREAK" || mappedType === "EXIT_RANGE_REBALANCE") {
                this.regimeExitConsumedBySymbol.set(symKey, { side: open.side, ts: Date.now() });
              }

              this.logger.info("EXIT_CLASSIFICATION_PROOF", {
                symbol: open.symbol,
                side: open.side,
                openedAt: open.openedAt,
                raw_reason: cr,
                mapped_exit_type: mappedType,
                flowId
              });

              await this.store.appendJsonlLine("reports/events.jsonl", {
                ts: Date.now(),
                type: mappedType,
                symbol: symKey,
                reason: cr,
                range_zone_reversal: "lower_short_flatten",
                realized_pnl: m.pnlUsdNet,
                ...buildPositionIdentityMeta(open)
              });
              continue;
            }
          }
        }
      }

      const symKeyStr = String(open.symbol);
      const priorBr = this.trendBreakoutBySymbol.get(symKeyStr) ?? "none";
      let trendState = null as ReturnType<typeof evaluateTrendEngineForSymbol> | null;
      if (exitLane === "TREND" || regimeAtEntry === "TREND") {
        trendState = evaluateTrendEngineForSymbol({
          mark: closePrice,
          entryPrice: open.entryPrice,
          atr: snap.atr,
          marketMode: input.marketMode,
          priorBreakoutDirection: priorBr,
          pyramidLevelPrior: this.trendPyramidLevelBySymbol.get(symKeyStr) ?? 0,
          holdMemoryPrior: this.trendHoldMemoryBySymbol.get(symKeyStr) ?? null,
          positionSide: open.side
        });
        this.trendBreakoutBySymbol.set(symKeyStr, trendState.breakoutDirection);
        this.trendHoldMemoryBySymbol.set(symKeyStr, trendState.holdMemory);
        this.trendPyramidLevelBySymbol.set(symKeyStr, trendState.pyramidLevel);
        this.trendFollowScoreBySymbol.set(symKeyStr, trendState.trendFollowScore);
        this.trendBreakoutConfidenceBySymbol.set(symKeyStr, trendState.breakoutConfidence);
        this.logger.info("trend_engine_tick", trendState);
      }

      if (rangeManagedPosition && rangeState) {
        const liveZone =
          typeof snap.boxPos === "number" && Number.isFinite(snap.boxPos)
            ? classifyRangeActionZone(snap.boxPos)
            : ("mid" as const);
        const rangeReattackEligibleNow =
          open.rangeFirstProfitLocked !== true &&
          open.rangeAddOnUsed !== true &&
          ((open.side === "short" && open.rangeEntryZone === "upper" && liveZone === "upper") ||
            (open.side === "long" && open.rangeEntryZone === "lower" && liveZone === "lower"));
        if ((open.rangeManagementState ?? "INIT") === "INIT" && rangeReattackEligibleNow) {
          open = { ...open, rangeManagementState: "REATTACK_READY" };
          this.logger.info("range_add_on_transition", {
            symbol: symKey,
            side: open.side,
            range_add_on_transition_applied: true,
            range_add_on_used: open.rangeAddOnUsed === true,
            range_management_state_before: "INIT",
            range_management_state_after: "REATTACK_READY",
            range_entry_zone: open.rangeEntryZone ?? null,
            box_zone_now: liveZone
          });
        }
        this.logger.info("range_management_path_summary", {
          symbol: symKey,
          side: open.side,
          range_management_state: open.rangeManagementState ?? "INIT",
          range_add_on_used: open.rangeAddOnUsed === true,
          range_first_profit_locked: open.rangeFirstProfitLocked === true,
          partial_exit_stage: open.partialExitStage ?? 0,
          highest_pnl_pct_net: open.highestPnlPctNet ?? null,
          box_pos: snap.boxPos ?? null,
          range_entry_zone: open.rangeEntryZone ?? null
        });
        const rebalanceTickKey = `${symKey}:${open.openedAt}`;
        this.logger.info("REGIME_EXIT_GUARD_PROOF", {
          symbol: open.symbol,
          side: open.side,
          strategyVersion: open.strategyVersion,
          sourceSignal: open.sourceSignal,
          regimeAtEntry: open.regimeAtEntry,
          executorAtEntry: open.executorAtEntry,
          exit_reason_candidate: "range_structural_rebalance_eval",
          range_exit_guard_blocked: blockedByExecutorMismatch
        });
        if (blockedByExecutorMismatch) {
          // Safety break
        }

        let st = evaluateRangeStructuralExit({
          lastPrice: closePrice,
          boxUpper: rangeState.boxUpper,
          boxLower: rangeState.boxLower,
          longUsd,
          shortUsd,
          maxLongExposure: input.riskExposure.maxLongExposure,
          maxShortExposure: input.riskExposure.maxShortExposure,
          marketMode: input.marketMode.marketMode,
          trendConfidence: input.marketMode.trendConfidence,
          structuralTrendShift: regimeAtEntry === "RANGE" && regimeNow === "TREND"
        });

        const holdingMsRange = Math.max(0, closedAt - open.openedAt);
        const priorTrail = this.rangeProfitTrailByKey.get(rebalanceTickKey) ?? null;
        const securedMinUsd = open.sizeUsd * this.config.rangeRebalanceSecuredMinPnlPct;
        const atrSnap = typeof snap.atr === "number" && Number.isFinite(snap.atr) ? snap.atr : null;
        const trailStep = computeRangeProfitTrailStep({
          side: open.side,
          closePrice,
          boxUpper: rangeState.boxUpper,
          boxLower: rangeState.boxLower,
          pnlPctNet: m.pnlPctNet,
          pnlUsdNet: m.pnlUsdNet,
          marginUsd: open.sizeUsd,
          atr: atrSnap,
          prior: priorTrail,
          armPnlPct: this.config.rangeRebalanceProfitArmPnlPct,
          securedMinPnlUsd: securedMinUsd,
          pullbackSpanFrac: this.config.rangeRebalanceTrailPullbackSpanFrac,
          pullbackMinPriceFrac: this.config.rangeRebalanceTrailPullbackMinPriceFrac,
          atrMult: this.config.rangeRebalanceTrailAtrMult,
          holdingMs: holdingMsRange,
          maxArmedNoLockDeferMs: this.config.rangeRebalanceTrailMaxArmedNoLockMs
        });
        if (trailStep.next === null) {
          this.rangeProfitTrailByKey.delete(rebalanceTickKey);
        } else {
          this.rangeProfitTrailByKey.set(rebalanceTickKey, trailStep.next);
        }

        if (trailStep.trailExit) {
          if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "range_profit_trail")) {
            this.logger.info("ENTRY_POST_OPEN_REGIME_LANE_PROTECT_ACTIVE", {
              symbol: open.symbol,
              side: open.side,
              flowId,
              openedAt: open.openedAt,
              eval_at_ms: closedAt,
              elapsed_ms: closedAt - open.openedAt,
              protect_window_ms: ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS,
              deferred_close_reason: "range_profit_trail",
              lane: "range_profit_trail"
            });
            remaining.push(posTrail);
            continue;
          }
          this.rangeBoxBreakConsecutiveBySymbol.delete(rebalanceTickKey);
          const crTrail = "range_profit_trail" as const;
          const closedRowTrail = finalizePaperClosedRecord({
            open,
            symbol: open.symbol,
            closePrice,
            closedAt,
            closeReason: crTrail,
            legMarginUsd: open.sizeUsd,
            metrics: m,
            feeRate,
            fundingIntervalHours: intervalH,
            strategyVersion: inheritedStrategyVersion,
            closeReasonLabelOverride: "수익권 되돌림 추종 청산",
            ...snapPaths
          });
          this.logger.info("REGIME_EXIT_GUARD_PROOF", {
            symbol: open.symbol,
            side: open.side,
            strategyVersion: open.strategyVersion,
            sourceSignal: open.sourceSignal,
            regimeAtEntry: open.regimeAtEntry,
            executorAtEntry: open.executorAtEntry,
            exit_reason_candidate: crTrail,
            range_exit_guard_blocked: blockedByExecutorMismatch
          });
          if (blockedByExecutorMismatch) {
            this.logger.info("REGIME_EXIT_GUARD_BLOCKED", { symbol: open.symbol, reason: "executor_mismatch_v2_protection", lane: "range_profit_trail" });
            remaining.push(posTrail);
            continue;
          }
          finalCloseReason = crTrail;
          confirmedExitType = exitEventJsonlType(crTrail);
          confirmedCloseSource = "range_profit_trail_executor";
          await this.positions.appendClosed(closedRowTrail);
          authorizeOpenLedgerPruneAfterAttestedClose(flowId, closedRowTrail);
          this.lastExitReasonLabel = "수익권 되돌림 추종 청산";

          const mappedType = exitEventJsonlType(crTrail);
          this.terminalExitConsumedByFlow.add(flowId);
          const isRegimeRelatedCode = mappedType === "EXIT_REGIME" || mappedType === "EXIT_TREND_BREAK" || mappedType === "EXIT_RANGE_REBALANCE";
          if (isRegimeRelatedCode) {
            this.regimeExitConsumedBySymbol.set(symKey, { side: open.side, ts: Date.now() });
          }

          this.logger.info("EXIT_CLASSIFICATION_PROOF", {
            symbol: open.symbol,
            side: open.side,
            openedAt: open.openedAt,
            raw_reason: crTrail,
            mapped_exit_type: mappedType,
            regime_dedup_set: mappedType === "EXIT_REGIME",
            flowId
          });

          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: Date.now(),
            type: mappedType,
            symbol: symKey,
            reason: crTrail,
            structural: "range_profit_trail",
            realized_pnl: m.pnlUsdNet,
            ...buildPositionIdentityMeta(open)
          });
          continue;
        }

        if (trailStep.deferBoxBreak && st.shouldExit && st.reason === "range_box_break") {
          this.rangeBoxBreakConsecutiveBySymbol.delete(rebalanceTickKey);
          this.logger.info("range_rebalance_exit_deferred", {
            symbol: symKey,
            gate: "profit_trail_defer_box_break",
            range_rebalance_exit_deferred_reason: "profit_trail_defer_box_break",
            pnl_pct_net: m.pnlPctNet,
            pnl_usd_net: m.pnlUsdNet,
            range_box_break_raw: st.rangeBoxBreakRaw
          });
          st = { shouldExit: false, reason: null, rangeBoxBreakRaw: st.rangeBoxBreakRaw };
        } else if (st.shouldExit && st.reason === "range_box_break") {
          const holdingMs = Math.max(0, closedAt - open.openedAt);
          const minHold = this.config.rangeRebalanceMinHoldMs;
          const needTicks = this.config.rangeRebalanceBoxBreakConfirmTicks;
          const boxZoneNow =
            typeof snap.boxPos === "number" && Number.isFinite(snap.boxPos) ? classifyRangeActionZone(snap.boxPos) : ("mid" as const);
          const addOnKey = `${symKey}:${open.openedAt}`;
          const addOnCount = this.rangeUpperShortAddOnCountByKey.get(addOnKey) ?? 0;
          const addOnUsed = open.rangeAddOnUsed === true || addOnCount >= 1;
          const addOnAvailableForStateLoop =
            open.regimeAtEntry === "RANGE" &&
            ((open.side === "short" && open.rangeEntryZone === "upper") ||
              (open.side === "long" && open.rangeEntryZone === "lower")) &&
            (open.partialExitStage ?? 0) === 0 &&
            boxZoneNow === open.rangeEntryZone &&
            !addOnUsed;
          const profitLockWindowActive =
            open.rangeFirstProfitLocked !== true &&
            (open.partialExitStage ?? 0) === 0 &&
            m.pnlPctNet >= -0.0002;
          const holdExtraMs = 120_000;
          const isReattackUsed = open.rangeManagementState === "REATTACK_USED";
          const preferHoldOverRebalance =
            (open.rangeManagementState ?? "INIT") !== "PROFIT_LOCKED" &&
            (addOnAvailableForStateLoop || profitLockWindowActive || isReattackUsed) &&
            holdingMs >= minHold &&
            holdingMs <= minHold + (isReattackUsed ? holdExtraMs + 60_000 : holdExtraMs);
          if (preferHoldOverRebalance) {
            this.rangeBoxBreakConsecutiveBySymbol.delete(rebalanceTickKey);
            this.logger.info("range_rebalance_exit_deferred", {
              symbol: symKey,
              gate: addOnAvailableForStateLoop ? "range_add_on_window_hold" : (isReattackUsed ? "reattack_used_hold" : "range_profit_lock_window_hold"),
              range_rebalance_exit_deferred_reason: addOnAvailableForStateLoop
                ? "range_add_on_window"
                : (isReattackUsed ? "reattack_used_priority" : "range_profit_lock_window"),
              range_exit_hold_preferred_over_rebalance: true,
              range_add_on_entry_count: addOnCount,
              range_add_on_used: addOnUsed,
              range_management_state: open.rangeManagementState ?? "INIT",
              rangeManagementState: open.rangeManagementState ?? "INIT",
              range_first_profit_locked: open.rangeFirstProfitLocked === true,
              holding_ms: holdingMs,
              min_hold_ms: minHold,
              hold_extra_ms: isReattackUsed ? holdExtraMs + 60_000 : holdExtraMs,
              remaining_ms: Math.max(0, minHold + (isReattackUsed ? holdExtraMs + 60_000 : holdExtraMs) - holdingMs),
              range_box_break_raw: st.rangeBoxBreakRaw
            });
            st = { shouldExit: false, reason: null, rangeBoxBreakRaw: st.rangeBoxBreakRaw };
          } else if (holdingMs < minHold) {
            this.rangeBoxBreakConsecutiveBySymbol.delete(rebalanceTickKey);
            this.logger.info("range_rebalance_exit_deferred", {
              symbol: symKey,
              gate: "min_hold_ms",
              range_rebalance_exit_deferred_reason: "min_hold_ms",
              holding_ms: holdingMs,
              min_hold_ms: minHold,
              range_box_break_raw: st.rangeBoxBreakRaw
            });
            st = { shouldExit: false, reason: null, rangeBoxBreakRaw: st.rangeBoxBreakRaw };
          } else if (st.rangeBoxBreakRaw) {
            const next = (this.rangeBoxBreakConsecutiveBySymbol.get(rebalanceTickKey) ?? 0) + 1;
            this.rangeBoxBreakConsecutiveBySymbol.set(rebalanceTickKey, next);
            if (next < needTicks) {
              this.logger.info("range_rebalance_exit_deferred", {
                symbol: symKey,
                gate: "confirm_ticks",
                range_rebalance_exit_deferred_reason: "confirm_ticks",
                consecutive_box_break_ticks: next,
                required_ticks: needTicks,
                holding_ms: holdingMs
              });
              st = { shouldExit: false, reason: null, rangeBoxBreakRaw: true };
            }
          }
        } else if (!st.rangeBoxBreakRaw) {
          this.rangeBoxBreakConsecutiveBySymbol.delete(rebalanceTickKey);
        }
        if (st.shouldExit && st.reason) {
          if (st.reason === "range_box_break") {
            this.rangeBoxBreakConsecutiveBySymbol.delete(rebalanceTickKey);
          }
          let cr: PaperClosedPositionRecord["closeReason"] = "range_box_break";
          if (st.reason === "structural_regime_shift") cr = "structural_regime_shift";
          if (st.reason === "risk_exposure_breach") cr = "regime_exit";

          if (
            st.reason !== "risk_exposure_breach" &&
            this.isEntryPostOpenRegimeLaneProtectActive(open.openedAt, closedAt)
          ) {
            this.logger.info("ENTRY_POST_OPEN_REGIME_LANE_PROTECT_ACTIVE", {
              symbol: open.symbol,
              side: open.side,
              flowId,
              openedAt: open.openedAt,
              eval_at_ms: closedAt,
              elapsed_ms: closedAt - open.openedAt,
              protect_window_ms: ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS,
              deferred_close_reason: cr,
              structural_reason: st.reason,
              lane: "range_structural_exit"
            });
            remaining.push(posTrail);
            continue;
          }

          this.logger.info("REGIME_EXIT_GUARD_PROOF", {
            symbol: open.symbol,
            side: open.side,
            strategyVersion: open.strategyVersion,
            sourceSignal: open.sourceSignal,
            regimeAtEntry: open.regimeAtEntry,
            executorAtEntry: open.executorAtEntry,
            exit_reason_candidate: cr,
            range_exit_guard_blocked: blockedByExecutorMismatch
          });
          if (blockedByExecutorMismatch) {
            this.logger.info("REGIME_EXIT_GUARD_BLOCKED", { symbol: open.symbol, reason: "executor_mismatch_v2_protection", lane: "range_structural_exit" });
            remaining.push(posTrail);
            continue;
          }
          finalCloseReason = cr;
          confirmedExitType = st.reason === "risk_exposure_breach" ? "EXIT_RISK" : exitEventJsonlType(cr);
          confirmedCloseSource = "range_structural_engine";
          const closedRow =
            st.reason === "risk_exposure_breach"
              ? finalizePaperClosedRecord({
                open,
                symbol: open.symbol,
                closePrice,
                closedAt,
                closeReason: cr,
                legMarginUsd: open.sizeUsd,
                metrics: m,
                feeRate,
                fundingIntervalHours: intervalH,
                strategyVersion: inheritedStrategyVersion,
                exitTypeOverride: "EXIT_RISK",
                closeReasonLabelOverride: "리스크 노출 한도 초과",
                ...snapPaths
              })
              : toClosed(cr, m, open.sizeUsd);
          await this.positions.appendClosed(closedRow);
          authorizeOpenLedgerPruneAfterAttestedClose(flowId, closedRow);
          this.lastExitReasonLabel =
            st.reason === "range_box_break"
              ? "박스 붕괴 청산"
              : st.reason === "structural_regime_shift"
                ? "구조적 추세 전환 청산"
                : "노출 한도 청산";

          const mappedType = exitEventJsonlType(cr);
          this.terminalExitConsumedByFlow.add(flowId);
          const isRegimeRelatedCode = mappedType === "EXIT_REGIME" || mappedType === "EXIT_TREND_BREAK" || mappedType === "EXIT_RANGE_REBALANCE";
          if (isRegimeRelatedCode) {
            this.regimeExitConsumedBySymbol.set(symKey, { side: open.side, ts: Date.now() });
          }

          this.logger.info("EXIT_CLASSIFICATION_PROOF", {
            symbol: open.symbol,
            side: open.side,
            openedAt: open.openedAt,
            raw_reason: cr,
            mapped_exit_type: mappedType,
            regime_dedup_set: mappedType === "EXIT_REGIME",
            flowId
          });

          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: Date.now(),
            type: mappedType,
            symbol: symKey,
            side: open.side,
            reason: cr,
            structural: st.reason,
            realized_pnl: m.pnlUsdNet,
            ...buildPositionIdentityMeta(open)
          });
          continue;
        }
      }

      if (regimeAtEntry === "TREND" && trendState) {
        const plan = planTrendSwitch(trendState, open.side);
        if (plan.execute && plan.openSide && plan.closeSide) {
          if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "trend_switch")) {
            this.logger.info("ENTRY_POST_OPEN_REGIME_LANE_PROTECT_ACTIVE", {
              symbol: open.symbol,
              side: open.side,
              flowId,
              openedAt: open.openedAt,
              eval_at_ms: closedAt,
              elapsed_ms: closedAt - open.openedAt,
              protect_window_ms: ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS,
              deferred_close_reason: "trend_switch",
              lane: "trend_engine_switch"
            });
            remaining.push(open);
            continue;
          }
          const cr = "trend_switch" as const;
          finalCloseReason = cr;
          confirmedExitType = "EXIT_TREND_SWITCH";
          confirmedCloseSource = "trend_engine_switch";
          const closedRow = finalizePaperClosedRecord({
            open,
            symbol: open.symbol,
            closePrice,
            closedAt,
            closeReason: cr,
            legMarginUsd: open.sizeUsd,
            metrics: m,
            feeRate,
            fundingIntervalHours: intervalH,
            strategyVersion: inheritedStrategyVersion,
            ...snapPaths
          });
          await this.positions.appendClosed(closedRow);
          authorizeOpenLedgerPruneAfterAttestedClose(flowId, closedRow);
          this.lastExitReasonLabel = "추세 반대 돌파로 청산";
          this.lastSwitchReasonLabel = trendState.trendSwitchReasonLabel;
          this.trendSwitchTimestampsMs.push(Date.now());
          const mappedType = exitEventJsonlType(cr);
          this.terminalExitConsumedByFlow.add(flowId);
          if (mappedType === "EXIT_TREND_SWITCH") {
            // 스위칭은 반대 방향으로 열리므로 Dedup이 새 진입을 막지 않음 (방향이 다름)
            this.regimeExitConsumedBySymbol.set(symKey, { side: open.side, ts: Date.now() });
          }

          this.logger.info("EXIT_CLASSIFICATION_PROOF", {
            symbol: open.symbol,
            side: open.side,
            openedAt: open.openedAt,
            raw_reason: cr,
            mapped_exit_type: mappedType,
            regime_dedup_set: true,
            flowId
          });

          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: Date.now(),
            type: mappedType,
            phase: "close",
            symbol: symKey,
            side: open.side,
            realized_pnl: m.pnlUsdNet,
            ...buildPositionIdentityMeta(open)
          });
          const newSz = Math.max(
            MIN_POSITION_SIZE_USD,
            Math.round(open.sizeUsd * input.riskExposure.switchSizeMultiplier * 100) / 100
          );
          const rev: PaperOpenPositionRecord = {
            openedAt: closedAt,
            symbol: open.symbol,
            side: plan.openSide,
            entryPrice: closePrice,
            leverage: open.leverage,
            sizeUsd: newSz,
            initialSizeUsd: newSz,
            partialExitStage: 0,
            realizedPnl: 0,
            strategyVersion: inheritedStrategyVersion,
            sourceSignal: open.sourceSignal,
            sourceRunPath: open.sourceRunPath,
            latestSnapshotPath: input.latestPath,
            latestMetaPath: input.metaPath,
            timestampSnapshotPath: input.filePath,
            ...(Number.isFinite(snap.fundingRate) ? { openFundingRate: snap.fundingRate } : {}),
            trailingExtremePrice: closePrice,
            adaptiveModeAtEntry: open.adaptiveModeAtEntry,
            regimeAtEntry: "TREND",
            executorAtEntry: "TREND",
            entryStage: Math.min(3, (open.entryStage ?? 1) + 1),
            status: "open"
          };
          remaining.push(rev);
          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: Date.now(),
            type: "EXIT_TREND_SWITCH",
            phase: "open",
            symbol: symKey,
            side: plan.openSide,
            size_usd: newSz,
            ...buildPositionIdentityMeta(rev)
          });
          continue;
        }
      }

      // 1. Hard SL check
      let isSlTriggered = false;
      if (typeof open.stopPrice === "number" && Number.isFinite(open.stopPrice)) {
        isSlTriggered = open.side === "long" ? closePrice <= open.stopPrice : closePrice >= open.stopPrice;
      } else {
        const slThresh = stopLossPctForRegime(slRegime);
        isSlTriggered = m.pnlPctNet <= slThresh;
      }

      if (isSlTriggered) {
        const cr = "stop_loss" as const;
        finalCloseReason = cr;
        confirmedExitType = "EXIT_SL";
        confirmedCloseSource = "hard_stop_loss_gate";
        const closedRow = toClosed(cr, m, open.sizeUsd);
        await this.positions.appendClosed(closedRow);
        authorizeOpenLedgerPruneAfterAttestedClose(flowId, closedRow);
        this.lastExitReasonLabel = "손절 청산";
        this.logger.info(exitFullLogKey(cr), {
          ...exitDetailBase(open, m),
          exitReason: cr
        });
        this.logger.info("paper_position_closed", { symbol: open.symbol, side: open.side, pnlUsdNet: m.pnlUsdNet, closeReason: cr });

        const mappedType = exitEventJsonlType(cr);
        this.terminalExitConsumedByFlow.add(flowId);
        this.logger.info("EXIT_CLASSIFICATION_PROOF", {
          symbol: open.symbol,
          side: open.side,
          openedAt: open.openedAt,
          raw_reason: cr,
          mapped_exit_type: mappedType,
          regime_dedup_set: false,
          flowId
        });

        await this.store.appendJsonlLine("reports/events.jsonl", {
          ts: Date.now(),
          type: mappedType,
          symbol: String(open.symbol),
          side: open.side,
          regime: open.regimeAtEntry ?? null,
          executor: executorForExitEventPayload(open.executorAtEntry, open.regimeAtEntry),
          reason: cr,
          expected_move: open.expectedMoveAtEntry ?? null,
          total_cost: open.totalCostAtEntry ?? null,
          hold_time: m.holdingMs,
          realized_pnl: m.pnlUsdNet,
          fee: m.feeUsd,
          ...buildPositionIdentityMeta(open)
        });

        if (open.regimeAtEntry === "RANGE") {
          this.recordRangeRoundTripOutcome(symKey, false);
          const k = `${String(open.symbol)}:${open.side}`;
          const prev = this.rangeFailCountByKey.get(k) ?? 0;
          const nextFail = prev + 1;
          this.rangeFailCountByKey.set(k, nextFail);
          if (nextFail >= 2) {
            this.rangeCooldownUntilByKey.set(k, Date.now() + 20 * 60_000);
            this.rangeFailCountByKey.set(k, 0);
          } else {
            this.rangeCooldownUntilByKey.set(k, Date.now() + 8 * 60_000);
          }

          // [ARM RANGE STOP REENTRY BLOCK]
          const entryZone = open.rangeEntryZone;
          const isEdgeStop = (open.side === "short" && entryZone === "upper") || (open.side === "long" && entryZone === "lower");
          if (isEdgeStop && entryZone && (entryZone === "upper" || entryZone === "lower")) {
            const armedAt = Date.now();
            this.rangeStopReentryBlockedBySymbol.set(symKey, {
              side: open.side,
              zone: entryZone,
              armedAt,
              reason: "stop_loss",
              regime: "RANGE"
            });
            this.logger.info("RANGE_STOP_REENTRY_BLOCK_ARMED", {
              symbol: open.symbol,
              side: open.side,
              zone: entryZone,
              armed_at: armedAt,
              close_reason: cr,
              openedAt: open.openedAt,
              regimeAtEntry: open.regimeAtEntry ?? null,
              executorAtEntry: open.executorAtEntry ?? null
            });
          }
        }
        continue;
      }

      // 2. Regime Flip / Trend Break check (하위 트리거 → 상위 exit authority 재판정 후에만 전량 청산)
      if (regimeAtEntry === "TREND") {
        const trendOkNow = snap.trendOk === true;
        if (regimeNow !== "TREND" || !trendOkNow) {
          if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "trend_break_exit")) {
            this.logger.info("ENTRY_POST_OPEN_REGIME_LANE_PROTECT_ACTIVE", {
              symbol: open.symbol,
              side: open.side,
              flowId,
              openedAt: open.openedAt,
              eval_at_ms: closedAt,
              elapsed_ms: closedAt - open.openedAt,
              protect_window_ms: ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS,
              deferred_close_reason: "trend_break_exit",
              lane: "trend_regime_shift_gate"
            });
            remaining.push(open);
            continue;
          }
          const marketMode = input.marketMode.marketMode;
          const upperExitVerdict = this.classifyUpperExitAuthorityTrendBreakTrigger({
            marketMode,
            trendOkNow,
            positionSide: open.side,
            snapSignal: snap.signal ?? "",
            v2Decision: envelope.v2_decision,
            v2Side: envelope.v2_side
          });
          this.logger.info("UPPER_EXIT_AUTHORITY_TREND_BREAK_REEVAL", {
            symbol: open.symbol,
            side: open.side,
            flowId,
            upper_exit_verdict: upperExitVerdict,
            market_mode: marketMode,
            regime_now_lane: regimeNow,
            trend_ok_snapshot: trendOkNow,
            authority_decision: envelope.authority.decision,
            authority_regime: envelope.authority.regime,
            authority_source: envelope.authority.source,
            v2_decision: envelope.v2_decision ?? null,
            v2_side: envelope.v2_side ?? null,
            trend_break_substrate: "regime_shift_or_trend_ok_false"
          });
          if (upperExitVerdict !== "EXIT") {
            remaining.push(open);
            continue;
          }
          const cr: PaperClosedPositionRecord["closeReason"] =
            marketMode === "RANGE" || marketMode === "NO_TRADE" ? "regime_exit" : "trend_break_exit";
          finalCloseReason = cr;
          confirmedExitType = exitEventJsonlType(cr);
          confirmedCloseSource =
            cr === "regime_exit"
              ? "trend_gate_upper_regime_lane_exit"
              : "trend_regime_shift_gate_upper_opposing_trend_confirmed";
          const closedRow = toClosed(cr, m, open.sizeUsd);
          await this.positions.appendClosed(closedRow);
          authorizeOpenLedgerPruneAfterAttestedClose(flowId, closedRow);
          this.logger.info(exitFullLogKey(cr), { ...exitDetailBase(open, m), exitReason: cr });

          const mappedType = exitEventJsonlType(cr);
          this.terminalExitConsumedByFlow.add(flowId);
          const isRegimeRelatedCode = mappedType === "EXIT_REGIME" || mappedType === "EXIT_TREND_BREAK" || mappedType === "EXIT_RANGE_REBALANCE";
          if (isRegimeRelatedCode) {
            this.regimeExitConsumedBySymbol.set(symKey, { side: open.side, ts: Date.now() });
          }

          this.logger.info("EXIT_CLASSIFICATION_PROOF", {
            symbol: open.symbol,
            side: open.side,
            openedAt: open.openedAt,
            raw_reason: cr,
            mapped_exit_type: mappedType,
            regime_dedup_set: mappedType === "EXIT_REGIME" || mappedType === "EXIT_TREND_BREAK",
            flowId
          });

          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: Date.now(),
            type: mappedType,
            symbol: String(open.symbol),
            side: open.side,
            regime: open.regimeAtEntry ?? null,
            executor: executorForExitEventPayload(open.executorAtEntry, open.regimeAtEntry),
            reason: cr,
            expected_move: open.expectedMoveAtEntry ?? null,
            total_cost: open.totalCostAtEntry ?? null,
            hold_time: m.holdingMs,
            realized_pnl: m.pnlUsdNet,
            fee: m.feeUsd,
            ...buildPositionIdentityMeta(open)
          });
          continue;
        }
      }

      // 3. RANGE / TREND 실행기 분리(포지션 레짐·상위 모드로 레인 선택)
      let exitEval =
        exitLane === "RANGE"
          ? rangeExecutorEvaluateExit({
            side: open.side,
            pnlPctNet: m.pnlPctNet,
            mark: closePrice,
            boxPos: snap.boxPos,
            boxHigh: snap.boxHigh,
            boxLow: snap.boxLow,
            atr: snap.atr,
            partialExitStage: open.partialExitStage ?? 0,
            holdingMs: m.holdingMs,
            postEntryCostGuard: open.postEntryCostGuard === true,
            rangeConfidence: this.lastRegime.rangeConfidence,
            boxBreakConfirmed: rangeState?.boxBreakout ?? false
          })
          : highwayExitEngine({
            position: open,
            aiScores: evaluateAiHighwayQuality(snap.candles ?? [], open.symbol),
            lastPrice: closePrice,
            ema20: snap.ema20,
            ema60: snap.ema60
          });

      if (
        exitLane === "RANGE" &&
        open.regimeAtEntry === "RANGE" &&
        ((open.side === "short" && open.rangeEntryZone === "upper") ||
          (open.side === "long" && open.rangeEntryZone === "lower")) &&
        (open.partialExitStage ?? 0) === 0 &&
        open.rangeFirstProfitLocked !== true &&
        exitEval.action === "hold"
      ) {
        const firstProfitLockThreshold = 0.00035;
        const profitLockSymmetryBranch = open.side === "short" ? "upper_short" : "lower_long";
        const profitLockSide = open.side;
        const firstProfitLockEligible =
          m.pnlPctNet >= firstProfitLockThreshold &&
          m.pnlUsdNet >= Math.max(0.01, open.sizeUsd * 0.00002);
        if (firstProfitLockEligible) {
          const detail = ((exitEval.detail ?? {}) as Record<string, unknown>);
          exitEval = {
            ...exitEval,
            action: "partial_close",
            reason: "partial_exit_1",
            guidance: open.side === "short" ? "RANGE upper short 첫 수익권 미세 잠금" : "RANGE lower long 첫 수익권 미세 잠금",
            exit_progress: Math.max(35, exitEval.exit_progress ?? 0),
            detail: {
              ...detail,
              range_first_profit_lock_applied: true,
              range_first_profit_lock_threshold: firstProfitLockThreshold,
              range_profit_lock_side: profitLockSide,
              range_profit_lock_symmetry_branch: profitLockSymmetryBranch
            }
          };
          this.logger.info("range_first_profit_lock", {
            symbol: open.symbol,
            side: open.side,
            range_profit_lock_transition_applied: true,
            range_first_profit_lock_applied: true,
            range_first_profit_lock_threshold: firstProfitLockThreshold,
            range_profit_lock_side: profitLockSide,
            range_profit_lock_symmetry_branch: profitLockSymmetryBranch,
            pnl_pct_net: m.pnlPctNet,
            pnl_usd_net: m.pnlUsdNet,
            partial_exit_stage: open.partialExitStage ?? 0
          });
        }
      }

      // --- CRASH MOMENTUM TRAILING OVERRIDE for SHORTS ---
      if (open.side === "short" && risk && (risk.crashState === "CRASH_EXIT" || risk.crashState === "CRASH_REDUCE")) {
        if (m.pnlPctNet > 0.005) { // 0.5% 이상 수익권이면 타이트하게 보호
          const trailGap = (snap.atr ?? 0) * 0.48;
          const crashTrailStop = (open.trailingExtremePrice ?? open.entryPrice) + trailGap;
          // 숏이므로 가격이 상승하여 이 지점을 터치하면 청산
          if (closePrice >= crashTrailStop) {
            exitEval = {
              ...exitEval,
              action: "close",
              reason: "trailing_stop",
              detail: { crash_momentum_trail: true, stop: crashTrailStop }
            };
          }
        }
      }
      // --------------------------------------------------

      const ema60ReevalTrigger =
        exitLane === "TREND" &&
        (exitEval.reason === "highway_ema60_break_long" || exitEval.reason === "highway_ema60_break_short");
      if (ema60ReevalTrigger) {
        const highwayReason = exitEval.reason as "highway_ema60_break_long" | "highway_ema60_break_short";
        if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, highwayReason)) {
          this.logger.info("ENTRY_POST_OPEN_REGIME_LANE_PROTECT_ACTIVE", {
            symbol: open.symbol,
            side: open.side,
            flowId,
            openedAt: open.openedAt,
            eval_at_ms: closedAt,
            elapsed_ms: closedAt - open.openedAt,
            protect_window_ms: ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS,
            deferred_close_reason: highwayReason,
            lane: "highway_ema60_upper_authority_gate"
          });
          remaining.push(open);
          continue;
        }

        const marketMode = input.marketMode.marketMode;
        const upperExitVerdict = this.classifyUpperExitAuthorityTrendBreakTrigger({
          marketMode,
          trendOkNow: snap.trendOk === true,
          positionSide: open.side,
          snapSignal: snap.signal ?? "",
          v2Decision: envelope.v2_decision,
          v2Side: envelope.v2_side
        });
        this.logger.info("UPPER_EXIT_AUTHORITY_TREND_BREAK_REEVAL", {
          symbol: open.symbol,
          side: open.side,
          flowId,
          trigger_reason: highwayReason,
          upper_exit_verdict: upperExitVerdict,
          market_mode: marketMode,
          regime_now_lane: regimeNow,
          trend_ok_snapshot: snap.trendOk === true,
          authority_decision: envelope.authority.decision,
          authority_regime: envelope.authority.regime,
          authority_source: envelope.authority.source,
          v2_decision: envelope.v2_decision ?? null,
          v2_side: envelope.v2_side ?? null,
          trend_break_substrate: "highway_ema60_break_trigger"
        });

        if (upperExitVerdict !== "EXIT") {
          remaining.push(open);
          continue;
        }

        exitEval = {
          ...exitEval,
          action: "close",
          reason: marketMode === "RANGE" || marketMode === "NO_TRADE" ? "regime_exit" : "trend_break_exit",
          detail: {
            ...(exitEval.detail ?? {}),
            upper_authority_exit_confirmed: true,
            upper_authority_exit_trigger: highwayReason
          }
        };
      }

      if (exitEval.action === "close") {
        const cr = exitEval.reason as PaperClosedPositionRecord["closeReason"];
        if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, cr)) {
          this.logger.info("ENTRY_POST_OPEN_REGIME_LANE_PROTECT_ACTIVE", {
            symbol: open.symbol,
            side: open.side,
            flowId,
            openedAt: open.openedAt,
            eval_at_ms: closedAt,
            elapsed_ms: closedAt - open.openedAt,
            protect_window_ms: ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS,
            deferred_close_reason: cr,
            lane: "executor_close_action"
          });
          remaining.push(open);
          continue;
        }
        finalCloseReason = cr;
        confirmedExitType = exitEventJsonlType(cr);
        confirmedCloseSource = "executor_close_action";
        const exDetail = (exitEval.detail ?? {}) as Record<string, unknown>;
        const closedRow = toClosed(cr, m, open.sizeUsd);
        await this.positions.appendClosed(closedRow);
        authorizeOpenLedgerPruneAfterAttestedClose(flowId, closedRow);
        this.logger.info(exitFullLogKey(cr), {
          ...exitDetailBase(open, m),
          exitReason: cr,
          range_exit_protection_applied: exDetail["range_exit_protection_applied"] ?? null,
          range_exit_protection_remaining_ms: exDetail["range_exit_protection_remaining_ms"] ?? null,
          range_exit_mode: exDetail["range_exit_mode"] ?? null,
          range_exit_box_break_confirmed: exDetail["range_exit_box_break_confirmed"] ?? null,
          range_exit_mid_target_hit: exDetail["range_exit_mid_target_hit"] ?? null,
          range_exit_far_target_hit: exDetail["range_exit_far_target_hit"] ?? null,
          range_exit_min_profit_after_cost_ok: exDetail["range_exit_min_profit_after_cost_ok"] ?? null,
          range_exit_reason_detail: exDetail["range_exit_reason_detail"] ?? null
        });
        this.logger.info("paper_position_closed", {
          symbol: open.symbol,
          side: open.side,
          pnlUsdNet: m.pnlUsdNet,
          closeReason: cr,
          range_exit_protection_applied: exDetail["range_exit_protection_applied"] ?? null,
          range_exit_protection_remaining_ms: exDetail["range_exit_protection_remaining_ms"] ?? null,
          range_exit_mode: exDetail["range_exit_mode"] ?? null,
          range_exit_box_break_confirmed: exDetail["range_exit_box_break_confirmed"] ?? null,
          range_exit_mid_target_hit: exDetail["range_exit_mid_target_hit"] ?? null,
          range_exit_far_target_hit: exDetail["range_exit_far_target_hit"] ?? null,
          range_exit_min_profit_after_cost_ok: exDetail["range_exit_min_profit_after_cost_ok"] ?? null,
          range_exit_reason_detail: exDetail["range_exit_reason_detail"] ?? null
        });
        const mappedType = exitEventJsonlType(cr);
        this.terminalExitConsumedByFlow.add(flowId);

        const isRegimeRelated = mappedType === "EXIT_REGIME" || mappedType === "EXIT_TREND_BREAK" || mappedType === "EXIT_RANGE_REBALANCE";
        if (isRegimeRelated) {
          this.regimeExitConsumedBySymbol.set(symKey, { side: open.side, ts: Date.now() });
        }

        this.logger.info("EXIT_CLASSIFICATION_PROOF", {
          symbol: open.symbol,
          side: open.side,
          openedAt: open.openedAt,
          raw_reason: cr,
          mapped_exit_type: mappedType,
          regime_dedup_set: isRegimeRelated,
          flowId
        });

        await this.store.appendJsonlLine("reports/events.jsonl", {
          ts: Date.now(),
          type: mappedType,
          symbol: String(open.symbol),
          side: open.side,
          regime: open.regimeAtEntry ?? null,
          executor: executorForExitEventPayload(open.executorAtEntry, open.regimeAtEntry),
          reason: cr,
          expected_move: open.expectedMoveAtEntry ?? null,
          total_cost: open.totalCostAtEntry ?? null,
          hold_time: m.holdingMs,
          realized_pnl: m.pnlUsdNet,
          fee: m.feeUsd,
          ...buildPositionIdentityMeta(open)
        });

        if (open.regimeAtEntry === "RANGE" && cr === "take_profit") {
          this.recordRangeRoundTripOutcome(symKey, true);
          const k = `${String(open.symbol)}:${open.side}`;
          this.rangeFailCountByKey.set(k, 0);
          this.rangeReopenArmedUntilBySymbol.set(symKey, Date.now() + 15 * 60_000);
        }
        if (
          open.regimeAtEntry === "TREND" &&
          (cr === "stop_loss" ||
            cr === "trend_break_exit" ||
            cr === "regime_exit")
        ) {
          this.trendCooldownUntilBySymbol.set(String(open.symbol), Date.now() + 12 * 60_000);
        }
        continue;
      }

      if (exitEval.action === "partial_close") {
        const partial = exitEval;
        const partialDetail = (partial.detail ?? {}) as Record<string, unknown>;
        const adaptiveMode: FuturesMarketMode = open.adaptiveModeAtEntry ?? this.lastAdaptiveMode.mode;
        const rawRatio = (partial as { partialExitRatio?: number }).partialExitRatio;
        let ratio =
          typeof rawRatio === "number" && Number.isFinite(rawRatio) && rawRatio > 0
            ? rawRatio
            : defaultPartialExitRatioForStage(adaptiveMode, open.partialExitStage ?? 0);
        ratio = Math.min(1, Math.max(0.05, ratio));
        const partialMargin = Math.round(open.sizeUsd * ratio * 100) / 100;
        const newMargin = Math.round((open.sizeUsd - partialMargin) * 100) / 100;

        if (newMargin < MIN_POSITION_SIZE_USD) {
          this.logger.info("partial_exit_skipped", {
            ...exitDetailBase(open, m),
            reason: "remaining_below_min",
            partial_ratio: ratio,
            remaining_after: newMargin,
            min_usd: MIN_POSITION_SIZE_USD
          });
        } else {
          const stage = (open.partialExitStage ?? 0) + 1;
          const pReason = stage === 1 ? ("partial_exit_1" as const) : ("partial_exit_2" as const);
          const pLog = stage === 1 ? "partial_exit_first" : "partial_exit_second";
          const mp = leg(partialMargin);

          const closedPartial = toClosed(pReason, mp, partialMargin);
          await this.positions.appendClosed(closedPartial);

          const partialEventProfitable = mp.pnlUsdNet > 1e-9 && mp.pnlPctNet > 1e-9;

          this.logger.info(pLog, {
            ...exitDetailBase(open, mp),
            exitReason: pReason,
            partial_ratio: ratio,
            partial_margin_usd: partialMargin,
            remaining_margin_usd: newMargin,
            detail: partial.detail,
            range_exit_protection_applied: partialDetail["range_exit_protection_applied"] ?? null,
            range_exit_protection_remaining_ms: partialDetail["range_exit_protection_remaining_ms"] ?? null,
            range_exit_mode: partialDetail["range_exit_mode"] ?? null,
            range_exit_box_break_confirmed: partialDetail["range_exit_box_break_confirmed"] ?? null,
            range_exit_mid_target_hit: partialDetail["range_exit_mid_target_hit"] ?? null,
            range_exit_far_target_hit: partialDetail["range_exit_far_target_hit"] ?? null,
            range_exit_min_profit_after_cost_ok: partialDetail["range_exit_min_profit_after_cost_ok"] ?? null,
            range_exit_reason_detail: partialDetail["range_exit_reason_detail"] ?? null
          });

          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: Date.now(),
            type: partialEventProfitable ? "EXIT_TP" : "EXIT_PARTIAL_SPLIT",
            symbol: String(open.symbol),
            regime: open.regimeAtEntry ?? null,
            executor: executorForExitEventPayload(open.executorAtEntry, open.regimeAtEntry),
            reason: pReason,
            expected_move: open.expectedMoveAtEntry ?? null,
            total_cost: open.totalCostAtEntry ?? null,
            hold_time: mp.holdingMs,
            realized_pnl: mp.pnlUsdNet,
            fee: mp.feeUsd,
            ...buildPositionIdentityMeta(open)
          });

          open = {
            ...open,
            sizeUsd: newMargin,
            partialExitStage: stage,
            realizedPnl: (open.realizedPnl ?? 0) + mp.pnlUsdNet,
            trailingExtremePrice: (partial as { trailingExtreme?: number }).trailingExtreme,
            ...(partialDetail["range_first_profit_lock_applied"] === true
              ? ({
                rangeFirstProfitLocked: true,
                rangeManagementState: "PROFIT_LOCKED"
              } as const)
              : {}),
            candidateLostStreak: 0
          };
          if (partialDetail["range_first_profit_lock_applied"] === true) {
            this.logger.info("range_profit_lock_transition", {
              symbol: open.symbol,
              side: open.side,
              range_management_state_before: open.rangeAddOnUsed === true ? "REATTACK_USED" : "REATTACK_READY",
              range_management_state_after: "PROFIT_LOCKED",
              range_profit_lock_transition_applied: true,
              range_profit_lock_threshold: partialDetail["range_first_profit_lock_threshold"] ?? null,
              range_first_profit_locked: true,
              range_profit_lock_side: partialDetail["range_profit_lock_side"] ?? open.side,
              range_profit_lock_symmetry_branch: partialDetail["range_profit_lock_symmetry_branch"] ?? null,
              partial_exit_stage_after: stage
            });
          }
          remaining.push(open);
          continue;
        }
      }

      // 4. Default persistence (with Trailing SL update)
      posTrail = { ...posTrail, trailingExtremePrice: (exitEval as { trailingExtreme?: number }).trailingExtreme };

      if (rangeManagedPosition) {
        const raZone =
          typeof snap.boxPos === "number" && Number.isFinite(snap.boxPos)
            ? classifyRangeActionZone(snap.boxPos)
            : ("mid" as const);
        const aligned =
          (open.side === "long" && raZone === "lower") || (open.side === "short" && raZone === "upper");
        this.logger.info("RANGE_CLOSE_ALIGNMENT_PROOF", {
          symbol: open.symbol,
          side: open.side,
          range_zone_detected: raZone,
          range_hold_alignment: aligned,
          range_hold_misaligned_exit_applied: false,
          box_pos: snap.boxPos ?? null,
          phase: "default_persistence"
        });
        if (aligned) {
          remaining.push({ ...posTrail, lostAt: undefined, candidateLostStreak: 0 });
          continue;
        }
        if ((open.side === "long" && raZone === "upper") || (open.side === "short" && raZone === "lower")) {
          const cr = "regime_exit" as const;
          this.logger.info("REGIME_EXIT_GUARD_PROOF", {
            symbol: open.symbol,
            strategyVersion: open.strategyVersion,
            sourceSignal: open.sourceSignal,
            executorAtEntry: open.executorAtEntry,
            regimeAtEntry: open.regimeAtEntry,
            trendManagedPosition,
            rangeManagedPosition,
            exitLane,
            blockedByExecutorMismatch,
            requestedRangePath: true,
            requestedTrendPath: false,
            finalCloseAction: blockedByExecutorMismatch ? "blocked" : "closing",
            finalCloseReason: cr
          });
          if (blockedByExecutorMismatch) {
            this.logger.info("REGIME_EXIT_GUARD_BLOCKED", { symbol: open.symbol, reason: "executor_mismatch_v2_protection", lane: "range_safety_net" });
            remaining.push(posTrail);
            continue;
          }
          if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "regime_exit")) {
            this.logger.info("ENTRY_POST_OPEN_REGIME_LANE_PROTECT_ACTIVE", {
              symbol: open.symbol,
              side: open.side,
              flowId,
              openedAt: open.openedAt,
              eval_at_ms: closedAt,
              elapsed_ms: closedAt - open.openedAt,
              protect_window_ms: ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS,
              deferred_close_reason: "regime_exit",
              lane: "range_safety_net_misaligned"
            });
            remaining.push(posTrail);
            continue;
          }
          finalCloseReason = cr;
          confirmedExitType = exitEventJsonlType(cr);
          confirmedCloseSource = "range_misaligned_safety_net";

          const closedRow = finalizePaperClosedRecord({
            open,
            symbol: open.symbol,
            closePrice,
            closedAt,
            closeReason: cr,
            legMarginUsd: open.sizeUsd,
            metrics: m,
            feeRate,
            fundingIntervalHours: intervalH,
            strategyVersion: inheritedStrategyVersion,
            closeReasonLabelOverride:
              open.side === "long"
                ? "RANGE 정합성: 상단 롱 강제 청산"
                : "RANGE 정합성: 하단 숏 강제 청산",
            ...snapPaths
          });
          await this.positions.appendClosed(closedRow);
          authorizeOpenLedgerPruneAfterAttestedClose(flowId, closedRow);
          this.logger.info("RANGE_CLOSE_ALIGNMENT_PROOF", {
            symbol: open.symbol,
            side: open.side,
            range_zone_detected: raZone,
            range_hold_alignment: false,
            range_hold_misaligned_exit_applied: true,
            box_pos: snap.boxPos ?? null,
            phase: "default_persistence_regime_exit_safety_net"
          });
          this.lastExitReasonLabel = open.side === "long" ? "RANGE 상단 롱 정합성 청산" : "RANGE 하단 숏 정합성 청산";
          const mappedType = exitEventJsonlType(cr);
          this.terminalExitConsumedByFlow.add(flowId);

          const isRegimeRelatedCode =
            mappedType === "EXIT_REGIME" ||
            mappedType === "EXIT_TREND_BREAK" ||
            mappedType === "EXIT_RANGE_REBALANCE";

          if (isRegimeRelatedCode) {
            this.regimeExitConsumedBySymbol.set(String(open.symbol), { side: open.side, ts: closedAt });
          }

          this.logger.info("EXIT_CLASSIFICATION_PROOF", {
            symbol: open.symbol,
            side: open.side,
            openedAt: open.openedAt,
            raw_reason: cr,
            mapped_exit_type: mappedType,
            regime_dedup_set: isRegimeRelatedCode,
            flowId
          });

          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: Date.now(),
            type: mappedType,
            symbol: String(open.symbol),
            side: open.side,
            reason: cr,
            realized_pnl: m.pnlUsdNet,
            ...buildPositionIdentityMeta(open)
          });
          continue;
        }
        // mid: 무조건 유지 금지 → 아래 minHold / candidate_lost 로 진행
      } else {
        const zk =
          typeof snap.boxPos === "number" && Number.isFinite(snap.boxPos) ? classifyBoxZone(snap.boxPos) : ("mid" as const);
        const keep =
          (open.side === "long" &&
            snap.signal === "paper_long_candidate" &&
            zk !== "upper") ||
          (open.side === "short" &&
            snap.signal === "paper_short_candidate" &&
            zk !== "lower");
        if (keep) {
          remaining.push({ ...posTrail, lostAt: undefined, candidateLostStreak: 0 });
          continue;
        }
      }

      /** 증액(스테이지 2+)·규모 확대 포지션: 신호 소멸 후 시간 청산·유예를 더 짧게 (RANGE 포지션은 상단에서 이미 분기됨) */
      const stagedOrScaled =
        (open.entryStage ?? 1) >= 2 ||
        (typeof open.initialSizeUsd === "number" &&
          open.initialSizeUsd > 0 &&
          open.sizeUsd > open.initialSizeUsd * 1.05);

      const opposingSignal =
        (open.side === "long" && snap.signal === "paper_short_candidate") ||
        (open.side === "short" && snap.signal === "paper_long_candidate");

      const zoneMismatch =
        typeof snap.boxPos === "number" &&
        ((open.side === "long" && classifyRangeActionZone(snap.boxPos) !== "lower") ||
          (open.side === "short" && classifyRangeActionZone(snap.boxPos) !== "upper"));

      const tightHold = open.regimeAtEntry === "RANGE" && opposingSignal && zoneMismatch;
      const isImmatureRange = !stagedOrScaled && open.rangeFirstProfitLocked !== true;

      const baseMinHoldMs = stagedOrScaled ? 4 * 60_000 : 5 * 60_000;
      const baseGracePeriodMs = stagedOrScaled ? 4 * 60_000 : 7 * 60_000;

      const tightMinHoldMs = isImmatureRange ? 3 * 60_000 : 1 * 60_000;
      const tightGracePeriodMs = isImmatureRange ? 3 * 60_000 : 1 * 60_000;

      const minHoldMsEff = tightHold ? Math.min(baseMinHoldMs, tightMinHoldMs) : baseMinHoldMs;
      const gracePeriodMs = tightHold ? Math.min(baseGracePeriodMs, tightGracePeriodMs) : baseGracePeriodMs;
      const minLostStreak = 1;

      if (m.holdingMs < minHoldMsEff) {
        remaining.push({ ...posTrail, candidateLostStreak: 0 });
        continue;
      }

      if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "candidate_lost")) {
        this.logger.info("ENTRY_POST_OPEN_REGIME_LANE_PROTECT_ACTIVE", {
          symbol: open.symbol,
          side: open.side,
          flowId,
          openedAt: open.openedAt,
          eval_at_ms: closedAt,
          elapsed_ms: closedAt - open.openedAt,
          protect_window_ms: ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS,
          deferred_close_reason: "candidate_lost",
          lane: "candidate_lost_watchdog"
        });
        remaining.push({ ...posTrail, candidateLostStreak: 0 });
        continue;
      }

      const cr = "candidate_lost" as const;
      finalCloseReason = cr;
      confirmedExitType = exitEventJsonlType(cr);
      confirmedCloseSource = "candidate_lost_watchdog";
      const closedRow = toClosed(cr, m, open.sizeUsd);
      await this.positions.appendClosed(closedRow);
      authorizeOpenLedgerPruneAfterAttestedClose(flowId, closedRow);
      this.logger.info("paper_position_closed", {
        symbol: open.symbol,
        side: open.side,
        pnlUsd: m.pnlUsdNet,
        closeReason: cr,
        holdingMs: m.holdingMs
      });
      await this.store.appendJsonlLine("reports/events.jsonl", {
        ts: Date.now(),
        type: exitEventJsonlType(cr),
        symbol: String(open.symbol),
        regime: open.regimeAtEntry ?? null,
        executor: executorForExitEventPayload(open.executorAtEntry, open.regimeAtEntry),
        reason: cr,
        expected_move: open.expectedMoveAtEntry ?? null,
        total_cost: open.totalCostAtEntry ?? null,
        hold_time: m.holdingMs,
        realized_pnl: m.pnlUsdNet,
        fee: m.feeUsd,
        ...buildPositionIdentityMeta(open)
      });

      // --- FINAL SAFETY PERSISTENCE ---
      this.logger.info("FINAL_CLOSE_CONFIRMATION_PROOF", {
        symbol: open.symbol,
        side: open.side,
        openedAt: open.openedAt,
        finalCloseReason,
        confirmedExitType,
        confirmedCloseSource,
        will_be_removed_from_ledger: (finalCloseReason as any) !== "none"
      });

      if ((finalCloseReason as any) === "none") {
        remaining.push(posTrail);
      }
    }

    // OPEN_LEDGER_SAVE_FINAL_GATE: deny open-ledger prune unless this tick's attested close row OR prior terminal-exit registry (set only after appendClosed elsewhere).
    const remainingIdsBeforeFinalGate = new Set(remaining.map((r) => `${r.symbol}:${r.side}:${r.openedAt}`));
    const rescuedForUnauthorizedLedgerPrune: Array<{
      flowId: string;
      symbol: string;
      side: string;
      openedAt: number;
    }> = [];
    for (const o of opens) {
      const fid = `${o.symbol}:${o.side}:${o.openedAt}`;
      if (remainingIdsBeforeFinalGate.has(fid)) continue;
      const ledgerPruneAllowed =
        openLedgerPruneAuthorizedFlowIds.has(fid) || this.terminalExitConsumedByFlow.has(fid);
      if (ledgerPruneAllowed) continue;
      remaining.push(o);
      rescuedForUnauthorizedLedgerPrune.push({
        flowId: fid,
        symbol: String(o.symbol),
        side: o.side,
        openedAt: o.openedAt
      });
    }
    if (rescuedForUnauthorizedLedgerPrune.length > 0) {
      this.logger.warn("OPEN_LEDGER_REMOVAL_BLOCKED_RESCUED", {
        gate: "OPEN_LEDGER_SAVE_FINAL_GATE",
        finalCloseReason_none_ledger_prune_denied: true,
        rescued_flows: rescuedForUnauthorizedLedgerPrune
      });
    }

    this.logger.info("FINAL_CLOSE_CONFIRMATION_PROOF", {
      phase: "open_ledger_save_final_gate",
      prune_authorized_flow_ids: openLedgerPruneAuthorizedFlowIds.size,
      prune_auth_issued_only_after_attested_close_record: true,
      unauthorized_prune_rescues: rescuedForUnauthorizedLedgerPrune.length,
      final_gate_ok: rescuedForUnauthorizedLedgerPrune.length === 0
    });

    const remainingIds = new Set(remaining.map((r) => `${r.symbol}:${r.side}:${r.openedAt}`));
    const removedFlows = opens
      .filter((o) => !remainingIds.has(`${o.symbol}:${o.side}:${o.openedAt}`))
      .map((o) => ({
        flowId: `${o.symbol}:${o.side}:${o.openedAt}`,
        symbol: o.symbol,
        side: o.side,
        openedAt: o.openedAt
      }));
    const remainingFlows = remaining.map((r) => ({
      flowId: `${r.symbol}:${r.side}:${r.openedAt}`,
      symbol: r.symbol,
      side: r.side,
      openedAt: r.openedAt
    }));
    const openPositionsChanged =
      remaining.length !== opens.length || remaining.some((r, i) => r !== opens[i]);
    const shouldSaveOpenLedger =
      crashPositionsModified || openLedgerPruned || openPositionsChanged;

    this.logger.info("OPEN_LEDGER_SAVE_PROOF", {
      before_count: opens.length,
      after_count: remaining.length,
      removed_flows: removedFlows,
      remaining_flows: remainingFlows,
      save_called: shouldSaveOpenLedger,
      caller: "tryPaperPositionClose",
      crashPositionsModified,
      openLedgerPruned,
      openPositionsChanged
    });

    if (shouldSaveOpenLedger) {
      await this.positions.saveOpenAll(remaining);
      const removedFlowIds = removedFlows.map((x) => x.flowId);
      const reloaded = await this.positions.loadOpenAll();
      const reloadedIds = new Set(reloaded.map((r) => `${r.symbol}:${r.side}:${r.openedAt}`));
      const stillPresentFlows = removedFlowIds.filter((id) => reloadedIds.has(id));
      const removedFlowIdSet = new Set(removedFlowIds);
      const stillPresentFlowSet = new Set(stillPresentFlows);
      const stopBackfillVerifiedPresentFlows: string[] = [];
      const stopBackfillSkippedRemovedFlows: string[] = [];
      const stopBackfillStillMissing: string[] = [];
      for (const exp of stopBackfillSaveExpectations) {
        const row = reloaded.find((r) => `${r.symbol}:${r.side}:${r.openedAt}` === exp.flowId);
        const sp = row?.stopPrice;
        const tol = Math.max(1e-6, 1e-9 * Math.abs(exp.expectedStopPrice));
        const priceOk =
          row != null &&
          typeof sp === "number" &&
          Number.isFinite(sp) &&
          Math.abs(sp - exp.expectedStopPrice) <= tol;
        if (priceOk) {
          stopBackfillVerifiedPresentFlows.push(exp.flowId);
          continue;
        }
        if (removedFlowIdSet.has(exp.flowId) && !stillPresentFlowSet.has(exp.flowId)) {
          stopBackfillSkippedRemovedFlows.push(exp.flowId);
          continue;
        }
        stopBackfillStillMissing.push(exp.flowId);
      }
      this.logger.info("OPEN_LEDGER_POST_SAVE_VERIFY", {
        removed_flows: removedFlowIds,
        still_present_flows: stillPresentFlows,
        verify_ok: stillPresentFlows.length === 0,
        stop_backfill_expected: stopBackfillSaveExpectations,
        stop_backfill_verified_present_flows: stopBackfillVerifiedPresentFlows,
        stop_backfill_skipped_removed_flows: stopBackfillSkippedRemovedFlows,
        stop_backfill_still_missing: stopBackfillStillMissing,
        stop_backfill_verify_ok: stopBackfillStillMissing.length === 0,
        stop_backfill_verify_mode: "present_or_removed_same_tick_ok"
      });
    }
  }

  /**
   * V2 AUTHORITY EXECUTION BRIDGE (Standard 10)
   * Unifies initial entry and scale-in pathways to prioritize V2 authority signals.
   * Ensures type-safe fallback when legacy adaptive results are missing.
   */
  private buildAuthorityAdaptiveBridge(
    authority: EntryExecutionAuthority,
    legacyAdaptive: NonNullable<EvaluatePaperSymbolEntryResult["adaptiveResult"]> | null | undefined
  ): NonNullable<EvaluatePaperSymbolEntryResult["adaptiveResult"]> | null {
    if (authority.decision !== "ENTER") return null;

    const side = authority.side;
    if (side !== "long" && side !== "short") return null;

    const sizeUsd = authority.sizeUsd ?? 0;
    if (sizeUsd <= 0) return null;

    // Use legacy results if they already match authority intent
    if (legacyAdaptive && legacyAdaptive.ok && legacyAdaptive.direction === side) {
      return legacyAdaptive;
    }

    let bridgeSizeUsd = sizeUsd;
    if (
      legacyAdaptive &&
      legacyAdaptive.direction === side &&
      typeof legacyAdaptive.sizeUsd === "number" &&
      Number.isFinite(legacyAdaptive.sizeUsd) &&
      legacyAdaptive.sizeUsd > 0
    ) {
      bridgeSizeUsd = legacyAdaptive.sizeUsd;
    }
    if (bridgeSizeUsd <= 0) return null;

    // Build synthetic fallback bridge for V2 or missing results (execution size follows legacy adaptive when side matches)
    return {
      ok: true,
      direction: side as "long" | "short",
      sizeUsd: bridgeSizeUsd,
      leverageMultiplier: 1.0,
      detail: {
        source: "v2_authority_execution_bridge",
        bridge_activated: true,
        authority_source: authority.source,
        authority_side: side,
        authority_selector_size_usd: sizeUsd,
        authority_size_usd: bridgeSizeUsd,
        finalSizeUsd: bridgeSizeUsd,
        confidence_score: 1.0,
        confidence_tier: "top",
        size_multiplier: 1.0
      }
    };
  }

  private async processPaperSymbolEntries(input: Readonly<{
    snapshots: SymbolSnapshot[];
    errorsCount: number;
    candidateRunPath: string | undefined;
    latestPath: string | undefined;
    metaPath: string | undefined;
    filePath: string | undefined;
    decisionBySymbol: ReadonlyMap<string, PaperEngineDecisionEnvelope>;
  }>): Promise<void> {
    if (input.errorsCount > 0) return;

    const snapshotBySymbol = new Map<string, SymbolSnapshot>();
    for (const s of input.snapshots) {
      snapshotBySymbol.set(String(s.symbol), s);
    }
    const entryQueue: SymbolSnapshot[] = [];
    input.decisionBySymbol.forEach((envelope, symKey) => {
      const { authority } = envelope;

      const effectiveAdaptiveResult = this.buildAuthorityAdaptiveBridge(authority, envelope.legacy.adaptiveResult);
      if (effectiveAdaptiveResult == null) return;

      const base = snapshotBySymbol.get(symKey);
      if (!base) return;

      const sig: PaperSignal = authority.side === "long" ? "paper_long_candidate" : "paper_short_candidate";
      entryQueue.push({ ...base, signal: sig });
    });
    entryQueue.sort((a, b) => {
      const aMajor = a.symbol === "BTCUSDT" || a.symbol === "ETHUSDT";
      const bMajor = b.symbol === "BTCUSDT" || b.symbol === "ETHUSDT";
      if (aMajor && !bMajor) return -1;
      if (!aMajor && bMajor) return +1;
      return 0;
    });
    if (entryQueue.length === 0) return;

    if (!input.candidateRunPath || !input.latestPath || !input.metaPath || !input.filePath) {
      return;
    }

    const max = this.config.paperMaxOpenPositions;
    const opensRawFull = await this.positions.loadOpenAll();
    let openPositionsChanged = false;
    const opensRaw = opensRawFull.filter((o) => {
      const fid = `${o.symbol}:${o.side}:${o.openedAt}`;
      return !this.terminalExitConsumedByFlow.has(fid);
    });
    if (opensRaw.length !== opensRawFull.length) {
      openPositionsChanged = true;
    }
    const opens = opensRaw.map((r) => {
      let current = r;
      let changed = false;
      const stageN = normalizeEntryStageFromSizeEvidence(current);
      if (stageN.changed) { current = stageN.normalized; changed = true; }
      const rangeN = normalizeRangeManagementState(current);
      if (rangeN.changed) { current = rangeN.normalized; changed = true; }
      if (changed) openPositionsChanged = true;
      return current;
    });
    const before = opens.length;
    const next = [...opens];
    const nowTs = Date.now();
    this.lastEntryDecision = null;

    for (const first of entryQueue) {
      const envelope = input.decisionBySymbol.get(String(first.symbol))!;
      const res = envelope.legacy;
      const authority = envelope.authority;

      const effectiveAdaptiveResult = this.buildAuthorityAdaptiveBridge(authority, res.adaptiveResult);

      if (effectiveAdaptiveResult == null) continue;

      this.logger.info("V2_EXECUTION_BRIDGE_PROOF", {
        symbol: first.symbol,
        authority_decision: authority.decision,
        authority_source: authority.source,
        authority_side: authority.side,
        authority_selector_size_usd: authority.sizeUsd ?? 0,
        authority_size_usd: effectiveAdaptiveResult.sizeUsd,
        authority_owns_execution: authority.source === "v2",
        legacy_adaptive_present: res.adaptiveResult != null,
        effective_adaptive_present: effectiveAdaptiveResult != null
      });

      if (this.lastEffectiveLane === "RANGE") {
        const origSnap = input.snapshots.find((s) => s.symbol === first.symbol);
        const qz = typeof first.boxPos === "number" ? classifyBoxZone(first.boxPos) : null;

        this.logger.info("RANGE_OPEN_QUEUE_PROOF", {
          symbol: first.symbol,
          zone: qz,
          original_snapshot_signal: origSnap?.signal ?? null,
          queued_signal_after_merge: first.signal,
          signal_corrected_for_intent: origSnap != null && origSnap.signal !== first.signal,
          intent_side: authority.side,
          final_decision: authority.decision,
          reject_reason: res.decision.reject_reason ?? null,
          adaptive_ok: res.adaptiveOk || authority.source === "v2",
          adaptive_direction: null,
          range_reversal_immediate_switch_applied: res.decision.range_reversal_immediate_switch_applied ?? false,
          will_attempt_open: authority.decision === "ENTER" && effectiveAdaptiveResult != null,
          active_engine: this.lastMarketMode?.routing.activeEngine ?? null
        });
      }

      const intentSide = authority.side as "long" | "short";
      const existingOpen = next.find((o) => o.symbol === first.symbol && o.side === intentSide);
      const entryStage = existingOpen?.entryStage ?? 0;
      const existingIdx = next.findIndex((o) => o.symbol === first.symbol && o.side === intentSide);
      const otherLeg = next.some((o) => o.symbol === first.symbol && o.side !== intentSide);
      const activeEngine = this.lastMarketMode?.routing.activeEngine ?? "IDLE";

      this.lastEntryDecision = res.executorDecision ?? null;

      if (res.decision.reject_reason === "ORDER_BUILD_FAIL" && res.executorDecision?.entry_allowed) {
        const ob = orderBuildFailureStructuredPayload(first, res, entryStage, (this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane) as MarketRegime);
        this.logger.info("STAGE1_ENTER_DECIDED", ob);
        this.logger.info("STAGE1_POSITION_OPEN_ATTEMPT", ob);
        this.logger.info("ORDER_BUILD_FAIL", ob);
        if (ob.order_build_fail_reason === "policy_trend_volume_too_thin") {
          this.logger.warn("ADAPTIVE_ENTRY_POLICY_TREND_VOLUME_PROOF", ob);
        }
      }

      const sym = String(first.symbol);
      const decision = res.executorDecision!;
      const adaptive = effectiveAdaptiveResult;

      // --- UNIFIED ENTRY GATE CONSOLIDATION (Phase 1: Decision Logic & Guards) ---
      const effectiveRegimeForAi = (this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane) as MarketRegime;
      const aiIn = aiInputFromDecision({
        decision,
        executorDirection: authority.side as "long" | "short",
        lossStreak: this.lastRisk?.recentLossStreakByMode?.[effectiveRegimeForAi] ?? 0,
        last10Net: typeof this.lastRisk?.detail?.last10_net_usd === "number" ? this.lastRisk.detail.last10_net_usd : 0,
        effectiveRegime: effectiveRegimeForAi
      });

      let aiExecutionApproved = true;
      let aiOutput: AiApprovalOutput | null = null;
      if (aiIn) {
        aiOutput = aiApproveEntry(aiIn);
        if (aiOutput.action === "NO_ENTRY") {
          aiExecutionApproved = false;
        }
      }

      const policyPaused = !this.lastRiskExposure?.allowNewEntry || this.lastMarketMode?.routing.newEntryPolicy === "paused";
      const isNewEntry = existingIdx < 0;

      // Reinforced Side Validation & Allow-Guards
      const validSide = authority.side === "long" || authority.side === "short";
      const allowLongGuard = this.lastRiskExposure?.allowNewLong !== false; // default true if undefined
      const allowShortGuard = this.lastRiskExposure?.allowNewShort !== false; // default true if undefined

      const sideAllowedByGuard =
        authority.side === "long" ? allowLongGuard :
          authority.side === "short" ? allowShortGuard : false;

      let finalBlockedReason: string | null = null;

      // Opposite-leg / hedge: part of final gate (single blocked_reason source).
      let oppositeLegBlockedReason: string | null = null;
      if (otherLeg) {
        if (!this.lastRiskExposure) {
          oppositeLegBlockedReason = "OPPOSITE_LEG_BLOCKED_NON_ACTIVE_ENGINE";
        } else if (activeEngine === "RANGE" && !this.lastRiskExposure.allowRangeBidirectional) {
          oppositeLegBlockedReason = "RANGE_HEDGE_BLOCKED";
        } else if (activeEngine === "TREND" && this.lastRiskExposure.blockTrendOppositeLeg) {
          oppositeLegBlockedReason = "TREND_OPPOSITE_LEG_BLOCKED";
        } else if (activeEngine !== "RANGE" && activeEngine !== "TREND") {
          oppositeLegBlockedReason = "OPPOSITE_LEG_BLOCKED_NON_ACTIVE_ENGINE";
        }
      }

      if (authority.decision !== "ENTER") {
        finalBlockedReason = "AUTHORITY_DECISION_NOT_ENTER";
      } else if (!validSide) {
        finalBlockedReason = "AUTHORITY_ENTER_WITH_INVALID_SIDE";
      } else if (!sideAllowedByGuard) {
        finalBlockedReason = authority.side === "long" ? "SIDE_NOT_ALLOWED_LONG" : "SIDE_NOT_ALLOWED_SHORT";
      } else if (oppositeLegBlockedReason) {
        finalBlockedReason = oppositeLegBlockedReason;
      } else if (effectiveAdaptiveResult == null) {
        finalBlockedReason = "ADAPTIVE_RESULT_NULL";
      } else if (!aiExecutionApproved) {
        finalBlockedReason = "AI_POLICY_BLOCKED";
      } else if (isNewEntry && policyPaused) {
        finalBlockedReason = "POLICY_PAUSED_OR_FORBIDDEN";
      }

      // Final Authorization Boolean: The ONLY gate that allows execution
      const finalEntryAuthorization = (finalBlockedReason === null);

      // --- PIEPLINE EVENT EMISSION ---
      // 1. AI Event (Report BLOCKED if AI rejected)
      if (aiIn && aiOutput) {
        const aiEventType = aiExecutionApproved ? "AI_APPROVED" : "AI_BLOCKED";
        await this.store.appendJsonlLine("reports/events.jsonl", buildAiEventPayload(aiEventType, sym, (this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane), aiIn, aiOutput, authority));
      }

      // 2. Final Decision Log & ENTRY_ALLOWED (Strictly Gated)
      this.logger.info("STAGE1_ENTER_DECIDED", {
        symbol: sym,
        regime: (this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane),
        executor: decision.executor,
        final_authorized: finalEntryAuthorization,
        final_blocked_reason: finalBlockedReason,
        ai_approved: aiExecutionApproved,
        policy_paused: policyPaused,
        allow_long: allowLongGuard,
        allow_short: allowShortGuard,
        is_scale_in: existingIdx >= 0,
        ...buildAuthorityEventMeta(authority)
      });

      if (!finalEntryAuthorization) {
        // Report specific block event to events.jsonl
        await this.store.appendJsonlLine("reports/events.jsonl", {
          ts: Date.now(),
          type: "ENTRY_BLOCKED_FINAL_GATE",
          symbol: sym,
          regime: (this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane),
          blocked_reason: finalBlockedReason,
          ...buildAuthorityEventMeta(authority)
        });

        const refinedEnvelope = { ...envelope };
        refinedEnvelope.legacy = {
          ...res,
          ...(res.executorDecision != null
            ? {
              executorDecision: {
                ...res.executorDecision,
                entry_allowed: false
              }
            }
            : {}),
          decision: {
            ...res.decision,
            final_decision: "SKIP",
            reject_reason: (finalBlockedReason as any) || "FINAL_GATE_BLOCKED"
          }
        };
        await this.emitPipelineEventsFromDecision(first, refinedEnvelope, nowTs, entryStage, finalBlockedReason);
        continue;
      }

      // --- EXECUTION BRANCHING (Scale-In vs New Entry) ---

      // 3. SCALE-IN BRANCH (final gate passed; max open positions does not apply to scale-in)
      if (existingIdx >= 0) {
        const scaled = await this.tryPaperPositionScaleIn(next[existingIdx], envelope, first, nowTs);
        if (scaled) {
          next[existingIdx] = scaled;
          openPositionsChanged = true;
          // Scale-in: POSITION_SCALE_IN_SUCCESS only — no ENTRY_OPENED here (initial entry records ENTRY_OPENED).
          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: Date.now(),
            type: "POSITION_SCALE_IN_SUCCESS",
            symbol: sym,
            regime: (this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane),
            side: scaled.side,
            new_size: scaled.sizeUsd,
            stop_price: scaled.stopPrice ?? null,
            ...buildAuthorityEventMeta(authority)
          });
        }
        continue;
      }

      // 4. Max open positions (new entry only — single check after final gate, after scale-in branch)
      if (next.length >= max) {
        if (authority.decision === "ENTER") {
          const limitBlockedEnvelope: PaperEngineDecisionEnvelope = {
            ...envelope,
            legacy: {
              ...res,
              decision: {
                ...res.decision,
                stage1_result_code: "STAGE1_BLOCKED_LIMIT" as const
              }
            }
          };
          await this.emitPipelineEventsFromDecision(first, limitBlockedEnvelope, nowTs, entryStage, "STAGE1_BLOCKED_LIMIT");
        }
        continue;
      }

      // 5. New entry only: ENTRY_ALLOWED here; ENTRY_OPENED after successful open below (not on scale-in).
      await this.store.appendJsonlLine("reports/events.jsonl", buildEntryAllowedEventPayload(sym, (this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane) as MarketRegime, decision, authority));

      const sourceSignal = first.signal;
      const levScaled = Math.max(
        1,
        Math.round(this.config.leverage * adaptive.leverageMultiplier * 100) / 100
      );
      const confScore =
        typeof adaptive.detail.confidence_score === "number" && Number.isFinite(adaptive.detail.confidence_score)
          ? adaptive.detail.confidence_score
          : undefined;
      const confTier =
        typeof adaptive.detail.confidence_tier === "string" ? adaptive.detail.confidence_tier : undefined;
      const sizeMult =
        typeof adaptive.detail.size_multiplier === "number" && Number.isFinite(adaptive.detail.size_multiplier)
          ? adaptive.detail.size_multiplier
          : undefined;

      this.logger.info("trade_confidence_scored", {
        symbol: first.symbol,
        mode: this.lastAdaptiveMode.mode,
        direction: adaptive.direction,
        confidenceScore: confScore,
        confidenceTier: confTier,
        detail: adaptive.detail
      });
      if (confTier === "low") {
        this.logger.info("trade_confidence_low", { symbol: first.symbol, confidenceScore: confScore, detail: adaptive.detail });
      } else if (confTier === "mid") {
        this.logger.info("trade_confidence_mid", { symbol: first.symbol, confidenceScore: confScore, detail: adaptive.detail });
      } else if (confTier === "high") {
        this.logger.info("trade_confidence_high", { symbol: first.symbol, confidenceScore: confScore, detail: adaptive.detail });
      } else if (confTier === "top") {
        this.logger.info("trade_confidence_top", { symbol: first.symbol, confidenceScore: confScore, detail: adaptive.detail });
      }

      this.logger.info("position_size_adjusted", {
        symbol: first.symbol,
        mode: this.lastAdaptiveMode.mode,
        sizeMultiplier: sizeMult,
        finalPositionSize: adaptive.sizeUsd,
        detail: adaptive.detail
      });
      if (this.lastAdaptiveMode.mode === "sideways") {
        this.logger.info("position_size_reduced_sideways", { symbol: first.symbol, finalPositionSize: adaptive.sizeUsd });
      }
      if (this.lastAdaptiveMode.mode === "risk_off") {
        this.logger.info("position_size_reduced_risk_off", { symbol: first.symbol, finalPositionSize: adaptive.sizeUsd });
      }

      const liveRegimeForEntryIdentity = (this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane) as PaperRegimeState;
      const entryIdentity = this.resolveEntryIdentity(authority, decision, liveRegimeForEntryIdentity);
      const isRangeCampaignNewEntry =
        entryIdentity.effectiveExecutorAtEntry === "RANGE" && entryIdentity.effectiveRegimeAtEntry === "RANGE";

      const riskE = this.lastRiskExposure;
      const adaptiveSizeUsdBefore = adaptive.sizeUsd;
      let entrySizeUsd = adaptive.sizeUsd;
      if (!isRangeCampaignNewEntry && riskE) {
        entrySizeUsd = Math.max(
          MIN_POSITION_SIZE_USD,
          Math.round(adaptive.sizeUsd * riskE.sizeMultiplier * 100) / 100
        );
      }
      const symS = String(first.symbol);
      if (!isRangeCampaignNewEntry && this.lastMarketMode?.routing.activeEngine === "TREND") {
        const pyr = this.trendPyramidLevelBySymbol.get(symS) ?? 0;
        entrySizeUsd = Math.max(
          MIN_POSITION_SIZE_USD,
          Math.round(entrySizeUsd * (1 + Math.min(4, pyr) * 0.07) * 100) / 100
        );
      }
      if (!isRangeCampaignNewEntry && this.lastMarketMode?.routing.activeEngine === "RANGE") {
        const rSt = this.lastTickRangeEvalBySymbol.get(symS);
        if (rSt) {
          const cycleM = rangeCycleSizePolicy(rSt.rangeCycleCount, rSt.hedgeBalance);
          const legM = rangeLadderLegMultiplier(rSt.rangeLadderLevel, rSt.hedgeBalance);
          const recM = rangeAccumulationRecoveryMultiplier(rSt.hedgeBalance, adaptive.direction, rSt.rangeCycleCount);
          entrySizeUsd = Math.max(
            MIN_POSITION_SIZE_USD,
            Math.round(entrySizeUsd * cycleM * legM * recM * 100) / 100
          );
        }
      }
      if (isRangeCampaignNewEntry) {
        const paperBase = this.config.paperBaseSizeUsd;
        const campaignTotalUsd = paperBase * RANGE_CAMPAIGN_TOTAL_RATIO;
        const campaignInitialUsd = paperBase * RANGE_INITIAL_RATIO;
        const campaignAddOnUsd = paperBase * RANGE_ADD_ON_RATIO;
        const campaignReserveUsd = paperBase * RANGE_RESERVE_RATIO;
        const riskM = riskE?.sizeMultiplier ?? 1;
        const plannedInitialUsd = paperBase * RANGE_INITIAL_RATIO;
        const riskScaledInitialUsd = plannedInitialUsd * riskM;
        entrySizeUsd = Math.max(MIN_POSITION_SIZE_USD, Math.round(riskScaledInitialUsd * 100) / 100);
        this.logger.info("RANGE_CAMPAIGN_SIZING_PROOF", {
          symbol: first.symbol,
          side: authority.side,
          regime: entryIdentity.effectiveRegimeAtEntry,
          executor: entryIdentity.effectiveExecutorAtEntry,
          paper_base_size_usd: paperBase,
          campaign_total_usd: campaignTotalUsd,
          campaign_initial_usd: campaignInitialUsd,
          campaign_add_on_usd: campaignAddOnUsd,
          campaign_reserve_usd: campaignReserveUsd,
          risk_size_multiplier: riskM,
          final_applied_size_usd: entrySizeUsd,
          path: "new_entry" as const
        });
        this.logger.info("RANGE_SIZE_OVERRIDE_PROOF", {
          symbol: first.symbol,
          adaptive_size_usd_before: adaptiveSizeUsdBefore,
          final_range_campaign_size_usd_after: entrySizeUsd,
          override_applied: true,
          reason: "range_campaign_normalization"
        });
      }

      let positionOpenTraceRef: MutablePositionOpenTrace | null = null;
      try {
        const openTraceId = randomUUID();
        const sampleBtcEth = isBtcEthSampleSymbol(sym);
        const trace: MutablePositionOpenTrace = {
          open_trace_id: openTraceId,
          symbol: sym,
          sample_symbol_btc_eth: sampleBtcEth,
          order_submit_requested: false,
          order_submit_ack: null,
          order_submit_error_code: null,
          order_submit_error_message: null,
          exchange_client_order_id: null,
          exchange_ord_id: null,
          exchange_order_state: null,
          exchange_fill_px: null,
          exchange_ack_s_code: null,
          exchange_ack_s_msg: null,
          position_open_record_written: false,
          position_open_final_state: "failed",
          open_fail_stage: "none",
          qty_submitted: null,
          inst_id: null
        };
        positionOpenTraceRef = trace;

        const emitPositionOpenTraceFinal = () => {
          this.logger.info("POSITION_OPEN_TRACE_FINAL", {
            ...trace,
            exchange_ack: trace.order_submit_ack,
            stored_position: trace.position_open_record_written,
            final_open_result: trace.position_open_final_state
          });
        };
        const logPaperPositionOpenFailed = () => {
          this.logger.error("paper_position_open_failed", {
            ...trace,
            exchange_ack: trace.order_submit_ack,
            stored_position: trace.position_open_record_written,
            final_open_result: trace.position_open_final_state
          });
        };

        this.logger.info("STAGE1_POSITION_OPEN_ATTEMPT", {
          open_trace_id: openTraceId,
          sample_symbol_btc_eth: sampleBtcEth,
          symbol: first.symbol,
          side: authority.side as "long" | "short",
          sizeUsd: entrySizeUsd,
          ...buildAuthorityEventMeta(authority, entrySizeUsd)
        });

        const mPre = marginsForSymbol(next, symS);
        if (
          riskE &&
          ((authority.side === "long" && mPre.longUsd + entrySizeUsd > riskE.maxLongExposure) ||
            (authority.side === "short" && mPre.shortUsd + entrySizeUsd > riskE.maxShortExposure))
        ) {
          trace.open_fail_stage = "risk_exposure_cap_pre_submit";
          trace.position_open_final_state = "aborted_pre_exchange";
          trace.order_submit_requested = false;
          trace.order_submit_ack = null;
          emitPositionOpenTraceFinal();
          logPaperPositionOpenFailed();
          await this.emitPipelineEventsFromDecision(
            first,
            {
              ...envelope,
              legacy: {
                ...res,
                decision: {
                  ...res.decision,
                  final_decision: "SKIP",
                  reject_reason: "EXECUTION_DISABLED",
                  execution_disabled_reason: "risk_exposure_cap_for_leg"
                },
                adaptiveResult: null
              }
            },
            nowTs,
            entryStage,
            "risk_exposure_cap_for_leg"
          );
          continue;
        }

        if (this.okxDemo) {
          const instId = toOkxSwapInstId(first.symbol);
          trace.inst_id = instId;
          const side = authority.side === "long" ? "buy" : "sell";
          const posSide = authority.side === "long" ? "long" : "short";
          const qty = Math.max(0.001, Math.round((entrySizeUsd / Math.max(1e-9, first.lastPrice)) * 1_000_000) / 1_000_000);
          trace.qty_submitted = qty;
          const clOrdId = `paper-${first.symbol}-${Date.now()}`;
          trace.exchange_client_order_id = clOrdId;
          trace.order_submit_requested = true;
          this.logger.info("okx_order_submit_requested", {
            open_trace_id: openTraceId,
            sample_symbol_btc_eth: sampleBtcEth,
            symbol: first.symbol,
            instId,
            side,
            posSide,
            qty,
            clOrdId
          });
          try {
            const submit = await this.okxDemo.submitOrder({
              instId,
              side,
              posSide,
              sz: String(qty),
              clOrdId,
              tdMode: "isolated",
              ordType: "market"
            });
            const row0 = submit.data?.[0] as Record<string, unknown> | undefined;
            const ackS = row0?.sCode != null ? String(row0.sCode) : null;
            const ackM = row0?.sMsg != null ? String(row0.sMsg) : "";
            trace.exchange_ack_s_code = ackS;
            trace.exchange_ack_s_msg = ackM || null;
            if (ackS !== null && ackS !== "0") {
              trace.order_submit_ack = "rejected";
              trace.order_submit_error_code = ackS;
              trace.order_submit_error_message = ackM || "order_level_ack_failed";
              const low = ackM.toLowerCase();
              trace.open_fail_stage =
                ackS === "51121" || low.includes("minimum") || low.includes("min") || low.includes("lot")
                  ? "exchange_reject_min_sz_or_lot"
                  : "exchange_submit_rejected_in_ack";
              this.logger.error("okx_order_submit_rejected", {
                open_trace_id: openTraceId,
                sample_symbol_btc_eth: sampleBtcEth,
                symbol: first.symbol,
                instId,
                clOrdId,
                exchange_ack_s_code: ackS,
                exchange_ack_s_msg: ackM,
                open_fail_stage: trace.open_fail_stage
              });
              emitPositionOpenTraceFinal();
              logPaperPositionOpenFailed();
              continue;
            }
            const ordId = String(row0?.ordId ?? "");
            trace.exchange_ord_id = ordId || null;
            let status: Awaited<ReturnType<OkxDemoClient["getOrder"]>>;
            try {
              status = await this.okxDemo.getOrder(instId, ordId || undefined, clOrdId);
            } catch (pollErr) {
              const pmsg = pollErr instanceof Error ? pollErr.message : String(pollErr);
              const parsed = parseOkxSubmitErrorMessage(pmsg);
              trace.order_submit_ack = "rejected";
              trace.order_submit_error_code = parsed.code;
              trace.order_submit_error_message = parsed.message;
              trace.open_fail_stage = "exchange_order_status_poll_failed";
              this.logger.error("okx_order_submit_rejected", {
                open_trace_id: openTraceId,
                sample_symbol_btc_eth: sampleBtcEth,
                symbol: first.symbol,
                instId,
                clOrdId,
                ordId: ordId || null,
                phase: "getOrder_after_submit",
                message: pmsg,
                open_fail_stage: trace.open_fail_stage
              });
              emitPositionOpenTraceFinal();
              logPaperPositionOpenFailed();
              continue;
            }
            const st0 = status.data?.[0] as Record<string, unknown> | undefined;
            trace.order_submit_ack = "accepted";
            trace.exchange_order_state = st0?.state != null ? String(st0.state) : null;
            const rawFill = st0?.fillPx;
            trace.exchange_fill_px =
              typeof rawFill === "string" || typeof rawFill === "number" ? rawFill : rawFill != null ? String(rawFill) : null;
            this.logger.info("okx_order_submit_accepted", {
              open_trace_id: openTraceId,
              sample_symbol_btc_eth: sampleBtcEth,
              symbol: first.symbol,
              instId,
              ordId: ordId || null,
              clOrdId,
              order_state: trace.exchange_order_state,
              fill_px: trace.exchange_fill_px,
              exchange_ack_s_code: trace.exchange_ack_s_code,
              exchange_ack_s_msg: trace.exchange_ack_s_msg
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const parsed = parseOkxSubmitErrorMessage(msg);
            trace.order_submit_ack = "rejected";
            trace.order_submit_error_code = parsed.code;
            trace.order_submit_error_message = parsed.message;
            if (msg.includes("50101")) {
              trace.open_fail_stage = "okx_auth_passphrase_or_demo_header";
              this.logger.error("okx_demo_env_mismatch_detected", {
                open_trace_id: openTraceId,
                reason: "50101",
                check: "api_key_type_or_x_simulated_trading_header"
              });
            } else if (/51121|min(imum)?\s*(sz|size|notional)|lot/i.test(msg)) {
              trace.open_fail_stage = "exchange_reject_min_sz_or_lot";
            } else if (parsed.code?.startsWith("http_")) {
              trace.open_fail_stage = "exchange_http_before_json";
            } else {
              trace.open_fail_stage = "exchange_submit_exception_before_ack";
            }
            this.logger.error("okx_order_submit_rejected", {
              open_trace_id: openTraceId,
              sample_symbol_btc_eth: sampleBtcEth,
              symbol: first.symbol,
              instId,
              clOrdId,
              message: msg,
              order_submit_error_code: trace.order_submit_error_code,
              open_fail_stage: trace.open_fail_stage
            });
            emitPositionOpenTraceFinal();
            logPaperPositionOpenFailed();
            continue;
          }
        } else {
          trace.order_submit_requested = false;
          trace.order_submit_ack = "skipped_no_okx_demo";
        }

        const record: PaperOpenPositionRecord = {
          openedAt: Date.now(),
          symbol: first.symbol,
          side: authority.side as "long" | "short",
          entryPrice: first.lastPrice,
          leverage: levScaled,
          sizeUsd: entrySizeUsd,
          initialSizeUsd: entrySizeUsd,
          partialExitStage: 0,
          realizedPnl: 0,
          stopPrice: (() => {
            const val = typeof res.decision.stopLoss === "number" ? res.decision.stopLoss : undefined;
            if (val !== undefined) return val;
            // Fallback calculation if decision lacks stopLoss
            const slThresh = 0.05; // 5% hard fallback
            const fallback = (authority.side === "long")
              ? first.lastPrice * (1 - slThresh)
              : first.lastPrice * (1 + slThresh);
            return fallback;
          })(),
          strategyVersion: entryIdentity.effectiveStrategyVersion,
          sourceSignal: entryIdentity.effectiveSourceSignal,
          sourceRunPath: input.candidateRunPath,
          latestSnapshotPath: input.latestPath,
          latestMetaPath: input.metaPath,
          timestampSnapshotPath: input.filePath,
          ...(Number.isFinite(first.fundingRate) ? { openFundingRate: first.fundingRate } : {}),
          trailingExtremePrice: first.lastPrice,
          adaptiveModeAtEntry: this.lastAdaptiveMode.mode,
          regimeAtEntry: entryIdentity.effectiveRegimeAtEntry as any,
          executorAtEntry: entryIdentity.effectiveExecutorAtEntry,
          ...(typeof decision.expected_move === "number" ? { expectedMoveAtEntry: decision.expected_move } : {}),
          ...(Number.isFinite(entrySizeUsd) && entrySizeUsd > 0 ? { totalCostAtEntry: entrySizeUsd } : {}),
          ...(confScore !== undefined ? { entryConfidenceScore: confScore } : {}),
          ...(confTier !== undefined ? { entryConfidenceTier: confTier } : {}),
          ...(confTier !== undefined ? { entrySizeMultiplier: sizeMult } : {}),
          ...(res.decision.post_entry_cost_guard === true ? { postEntryCostGuard: true } : {}),
          ...(entryIdentity.attachRangeMetadata
            ? {
              ...(typeof first.boxPos === "number" ? { rangeEntryBoxPos: first.boxPos, rangeEntryZone: classifyBoxZone(first.boxPos) } : {}),
              rangeManagementState: "INIT" as RangeManagementState,
              rangeAddOnUsed: false,
              rangeFirstProfitLocked: false,
              entryStage: 1,
              scalingWeights: [0.5, 0.5],
              ...(res.decision.range_reversal_immediate_switch_applied === true ? { rangeEntryFromReversalSwitch: true } : {})
            }
            : {}),
          status: "open"
        };

        this.logger.info("POSITION_ENGINE_IDENTITY_PROOF", {
          symbol: record.symbol,
          strategyVersion: record.strategyVersion,
          sourceSignal: record.sourceSignal,
          executorAtEntry: record.executorAtEntry,
          regimeAtEntry: record.regimeAtEntry,
          attachRangeMetadata: entryIdentity.attachRangeMetadata,
          hasRangeEntryZone: !!record.rangeEntryZone,
          hasRangeManagementState: !!record.rangeManagementState,
          trendManagedPosition: this.isTrendManagedPosition(record),
          rangeManagedPosition: (record.regimeAtEntry === "RANGE" && record.executorAtEntry !== "TREND" && !this.isTrendManagedPosition(record))
        });

        next.push(record);
        openPositionsChanged = true;

        this.logger.info("STOP_STATE_PROOF", {
          symbol: record.symbol,
          side: record.side,
          stopPrice_at_entry: record.stopPrice ?? "미설정",
          entryPrice: record.entryPrice,
          source: typeof res.decision.stopLoss === "number" ? "executor_decision" : "engine_fallback"
        });
        trace.position_open_record_written = true;
        if (res.decision.range_reversal_immediate_switch_applied === true) {
          this.rangeReversalSwitchPendingBySymbol.delete(sym);
        }
        if (this.lastEffectiveLane === "RANGE") {
          const fillZone = typeof first.boxPos === "number" ? classifyBoxZone(first.boxPos) : null;
          const origOpen = input.snapshots.find((s) => s.symbol === first.symbol);
          const fillProof = {
            symbol: record.symbol,
            side: record.side,
            strategyVersion: record.strategyVersion,
            executorAtEntry: record.executorAtEntry,
            regimeAtEntry: record.regimeAtEntry,
            source_signal_stored_on_record: record.sourceSignal,
            range_entry_zone: record.rangeEntryZone ?? fillZone,
            box_pos_at_open: first.boxPos,
            original_snapshot_signal: origOpen?.signal ?? null,
            queued_signal_at_execution: first.signal,
            range_stage0_engine_taken: res.decision.range_stage0_engine_taken ?? false,
            range_reversal_immediate_switch_applied: res.decision.range_reversal_immediate_switch_applied ?? false,
            range_final_trade_side_by_zone: res.decision.range_final_trade_side_by_zone ?? null,
            legacy_executor_path_taken: res.decision.legacy_executor_path_taken ?? false,
            legacy_block_test_bypass_applied: res.decision.legacy_block_test_bypass_applied ?? false,
            stage1_result_code: res.decision.stage1_result_code ?? null,
            adaptive_soft_explore:
              (adaptive.detail as { stage1_adaptive_soft_explore?: string | null })?.stage1_adaptive_soft_explore ?? null
          };
          this.logger.info("RANGE_FILL_PATH_PROOF", fillProof);
          if (fillZone === "upper" && record.side === "long") {
            this.logger.warn("RANGE_ANOMALY_UPPER_LONG_OPEN_CODE_PATH", {
              ...fillProof,
              anomaly_note:
                "RANGE stage0 상단에서는 롱 진입이 나오면 안 됨 — 레거시 하이웨이·테스트 바이패스·히스토리 zone 라벨 불일치 등을 의심"
            });
            try {
              await this.store.appendJsonlLine("reports/events.jsonl", {
                ts: Date.now(),
                type: "RANGE_ANOMALY_UPPER_LONG_OPEN",
                ...fillProof
              });
            } catch (appendErr) {
              const m = appendErr instanceof Error ? appendErr.message : String(appendErr);
              this.logger.error("range_anomaly_event_append_failed", { error: m });
            }
          }
        }
        const reopenArmActive = (this.rangeReopenArmedUntilBySymbol.get(symS) ?? 0) > nowTs;
        if (reopenArmActive && this.lastMarketMode?.routing.activeEngine === "RANGE") {
          const arr = this.rangeReopenTimestampsBySymbol.get(symS) ?? [];
          arr.push(Date.now());
          this.rangeReopenTimestampsBySymbol.set(
            symS,
            arr.filter((t) => t > Date.now() - RANGE_REOPEN_WINDOW_MS)
          );
        }
        if (this.lastMarketMode?.routing.activeEngine === "RANGE") {
          this.rangeReopenArmedUntilBySymbol.delete(symS);
        }

        trace.position_open_final_state = "opened";
        trace.open_fail_stage = "none";

        this.logger.info("STAGE1_POSITION_OPEN_SUCCESS", {
          open_trace_id: trace.open_trace_id,
          sample_symbol_btc_eth: trace.sample_symbol_btc_eth,
          symbol: record.symbol,
          side: record.side,
          stage1_result_code: res.decision.stage1_result_code,
          fixed_total_cost_usd: res.decision.fixed_total_cost_usd ?? null,
          expected_move_usd: res.decision.expected_move_usd ?? null,
          required_cost_usd: entrySizeUsd,
          shortfall_usd: res.decision.shortfall_usd ?? 0,
          executor_block_reason_original: res.decision.executor_block_reason_original ?? null,
          stage1_soft_exec_override: res.decision.stage1_soft_exec_override === true,
          stage1_size_multiplier_final: res.decision.stage1_size_multiplier_final ?? null,
          ...buildAuthorityEventMeta(authority, entrySizeUsd)
        });

        const entryOpenedKey = record.side === "long" ? "entry_long_opened" : "entry_short_opened";
        this.logger.info(entryOpenedKey, {
          open_trace_id: trace.open_trace_id,
          sample_symbol_btc_eth: trace.sample_symbol_btc_eth,
          symbol: record.symbol,
          side: record.side,
          mode: this.lastAdaptiveMode.mode,
          size_usd: record.sizeUsd,
          leverage: record.leverage,
          confidenceScore: confScore,
          confidenceTier: confTier,
          sizeMultiplier: sizeMult,
          entry_pipeline: adaptive.detail,
          total_cost_at_entry: record.totalCostAtEntry ?? null,
          ...buildAuthorityEventMeta(authority, entrySizeUsd)
        });
        this.logger.info("paper_position_opened", {
          open_trace_id: trace.open_trace_id,
          sample_symbol_btc_eth: trace.sample_symbol_btc_eth,
          order_submit_requested: trace.order_submit_requested,
          order_submit_ack: trace.order_submit_ack,
          order_submit_error_code: trace.order_submit_error_code,
          order_submit_error_message: trace.order_submit_error_message,
          position_open_record_written: trace.position_open_record_written,
          position_open_final_state: trace.position_open_final_state,
          open_fail_stage: trace.open_fail_stage,
          exchange_client_order_id: trace.exchange_client_order_id,
          stored_position: "queued_in_memory_before_saveOpenAll",
          symbol: record.symbol,
          side: record.side,
          path: "positions/open.json",
          size_usd: record.sizeUsd,
          total_cost_at_entry: record.totalCostAtEntry ?? null,
          ...buildAuthorityEventMeta(authority, entrySizeUsd)
        });
        try {
          await this.store.appendJsonlLine("reports/events.jsonl", buildEntryOpenedEventPayload(sym, authority, record));
        } catch (appendErr) {
          const am = appendErr instanceof Error ? appendErr.message : String(appendErr);
          trace.open_fail_stage = "events_jsonl_append_failed";
          trace.order_submit_error_message = trace.order_submit_error_message ?? am;
          this.logger.error("entry_opened_jsonl_append_failed", {
            open_trace_id: trace.open_trace_id,
            sample_symbol_btc_eth: trace.sample_symbol_btc_eth,
            message: am
          });
        }
        emitPositionOpenTraceFinal();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const tr = positionOpenTraceRef;
        if (tr) {
          tr.position_open_final_state = tr.position_open_record_written ? "failed" : "aborted_pre_exchange";
          tr.open_fail_stage = tr.position_open_record_written ? "internal_exception_after_record_push" : "internal_exception_before_record_push";
          tr.order_submit_error_message = tr.order_submit_error_message ?? msg;
          this.logger.info("POSITION_OPEN_TRACE_FINAL", {
            ...tr,
            exchange_ack: tr.order_submit_ack,
            stored_position: tr.position_open_record_written,
            final_open_result: tr.position_open_final_state
          });
          this.logger.error("paper_position_open_failed", {
            ...tr,
            exchange_ack: tr.order_submit_ack,
            stored_position: tr.position_open_record_written,
            final_open_result: tr.position_open_final_state
          });
        }
        this.logger.error("STAGE1_POSITION_OPEN_FAIL", {
          open_trace_id: tr?.open_trace_id ?? null,
          sample_symbol_btc_eth: tr?.sample_symbol_btc_eth ?? isBtcEthSampleSymbol(sym),
          symbol: sym,
          stage1_result_code: res.decision.stage1_result_code,
          fixed_total_cost_usd: res.decision.fixed_total_cost_usd ?? null,
          expected_move_usd: res.decision.expected_move_usd ?? null,
          required_cost_usd: entrySizeUsd,
          shortfall_usd: res.decision.shortfall_usd ?? 0,
          final_fail_reason: msg,
          reviewing_ticks: res.decision.reviewing_ticks,
          auto_entry_triggered: res.decision.auto_entry_triggered,
          required_move_pct: res.decision.required_move_pct,
          shortfall_pct: res.decision.shortfall_pct,
          ...buildAuthorityEventMeta(authority, entrySizeUsd)
        });
      }
    }

    if (openPositionsChanged || next.length !== before) {
      try {
        await this.positions.saveOpenAll(next);
        this.logger.info("paper_positions_persist_open_batch_ok", { added: next.length - before });
      } catch (persistErr) {
        const pm = persistErr instanceof Error ? persistErr.message : String(persistErr);
        this.logger.error("paper_positions_persist_open_batch_failed", {
          message: pm,
          added: next.length - before,
          open_fail_stage: "persist_save_open_all_failed"
        });
      }
    }
  }

  private async tryPaperPositionScaleIn(
    existing: PaperOpenPositionRecord,
    envelope: PaperEngineDecisionEnvelope,
    first: SymbolSnapshot,
    nowTs: number
  ): Promise<PaperOpenPositionRecord | null> {
    const { legacy: res, authority } = envelope;
    const effectiveAdaptiveResult = this.buildAuthorityAdaptiveBridge(authority, res.adaptiveResult);
    if (!effectiveAdaptiveResult) return null;
    if (!this.lastRiskExposure?.allowAdd) {
      this.logger.info("scale_in_blocked_risk_allow_add", { symbol: existing.symbol });
      return null;
    }
    if (existing.postEntryCostGuard === true) {
      this.logger.info("scale_in_blocked_post_entry_cost_guard", { symbol: existing.symbol });
      return null;
    }

    const decision = res.executorDecision!;
    const adaptive = effectiveAdaptiveResult;
    const isRangeCampaignScaleIn = existing.regimeAtEntry === "RANGE" && existing.executorAtEntry === "RANGE";

    const addOnKey = `${String(existing.symbol)}:${existing.openedAt}`;
    let rangeAddOnCandidate = false;
    let edgeStructureOkForAddon = false;

    let incrementalSizeUsd: number;
    let targetStage: number;
    let scalingWeights: number[];
    let rangeAddOnSizeMultApplied: number;
    let minSizeGuardApplied = false;
    let rangeCampaignScaleInPath = false;
    let baseEntrySizeUsdForTrace = existing.initialSizeUsd ?? existing.sizeUsd;

    if (isRangeCampaignScaleIn) {
      if ((existing.entryStage ?? 1) >= 2 || existing.rangeAddOnUsed === true) {
        this.logger.info("RANGE_ADD_ON_CAP_REACHED", {
          symbol: existing.symbol,
          side: existing.side,
          entryStage: existing.entryStage ?? 1,
          rangeAddOnUsed: existing.rangeAddOnUsed === true,
          attempted_target_stage: res.decision.target_stage ?? (existing.entryStage ?? 1) + 1,
          reason: "already_stage2_or_addon_used"
        });
        return null;
      }
      const requestedTargetStage = res.decision.target_stage ?? (existing.entryStage ?? 1) + 1;
      if (requestedTargetStage > 2) {
        this.logger.info("RANGE_ADD_ON_CAP_REACHED", {
          symbol: existing.symbol,
          side: existing.side,
          entryStage: existing.entryStage ?? 1,
          rangeAddOnUsed: existing.rangeAddOnUsed ?? false,
          attempted_target_stage: requestedTargetStage,
          reason: "target_stage_gt_2"
        });
        return null;
      }
      rangeCampaignScaleInPath = true;
      targetStage = 2;
      scalingWeights = [0.5, 0.5];
      rangeAddOnSizeMultApplied = 1;
      const paperBase = this.config.paperBaseSizeUsd;
      const riskM = this.lastRiskExposure?.sizeMultiplier ?? 1;
      const plannedAddOnUsd = paperBase * RANGE_ADD_ON_RATIO;
      const riskScaledAddOnUsd = plannedAddOnUsd * riskM;
      incrementalSizeUsd = Math.max(MIN_POSITION_SIZE_USD, Math.round(riskScaledAddOnUsd * 100) / 100);
      this.logger.info("stage2_size_calculation_trace", {
        range_campaign_scale_in: true,
        target_stage: targetStage,
        mult_add_on: rangeAddOnSizeMultApplied,
        min_size_guard_applied: minSizeGuardApplied,
        final_incremental_usd: incrementalSizeUsd,
        original_stage1_size: existing.initialSizeUsd ?? existing.sizeUsd
      });
      this.logger.info("RANGE_CAMPAIGN_SIZING_PROOF", {
        symbol: existing.symbol,
        side: existing.side,
        regime: existing.regimeAtEntry ?? null,
        executor: existing.executorAtEntry ?? null,
        paper_base_size_usd: paperBase,
        campaign_total_usd: paperBase * RANGE_CAMPAIGN_TOTAL_RATIO,
        campaign_initial_usd: paperBase * RANGE_INITIAL_RATIO,
        campaign_add_on_usd: paperBase * RANGE_ADD_ON_RATIO,
        campaign_reserve_usd: paperBase * RANGE_RESERVE_RATIO,
        risk_size_multiplier: riskM,
        final_applied_size_usd: incrementalSizeUsd,
        path: "scale_in" as const
      });
      this.logger.info("RANGE_SIZE_OVERRIDE_PROOF", {
        symbol: existing.symbol,
        adaptive_size_usd_before: adaptive.sizeUsd,
        final_range_campaign_size_usd_after: incrementalSizeUsd,
        override_applied: true,
        reason: "range_campaign_normalization"
      });
    } else {
      const stageAtLeast2 = (existing.entryStage ?? 1) >= 2;
      if (stageAtLeast2 && first.qualityScore < 72) {
        this.logger.info("scale_in_blocked_stage2plus_quality", {
          symbol: existing.symbol,
          qualityScore: first.qualityScore,
          entryStage: existing.entryStage
        });
        return null;
      }

      const addOnCount = this.rangeUpperShortAddOnCountByKey.get(addOnKey) ?? 0;
      const addOnUsed = existing.rangeAddOnUsed === true || addOnCount >= 1;
      const exDetail = (decision.detail ?? {}) as Record<string, unknown>;
      const rangeSignalReason = typeof exDetail.range_signal_reason === "string" ? exDetail.range_signal_reason : null;
      const edgeStructureOk =
        exDetail.range_upper_edge_structure_ok === true ||
        rangeSignalReason === "range_upper_short_priority_structure" ||
        rangeSignalReason === "range_lower_long_priority_structure";
      const upperShortAddOnCandidate =
        existing.regimeAtEntry === "RANGE" &&
        existing.side === "short" &&
        existing.rangeEntryZone === "upper" &&
        typeof first.boxPos === "number" &&
        classifyRangeActionZone(first.boxPos) === "upper" &&
        res.decision.range_upper_short_priority_applied === true &&
        edgeStructureOk === true;
      const lowerLongAddOnCandidate =
        existing.regimeAtEntry === "RANGE" &&
        existing.side === "long" &&
        existing.rangeEntryZone === "lower" &&
        typeof first.boxPos === "number" &&
        classifyRangeActionZone(first.boxPos) === "lower" &&
        res.decision.range_lower_long_priority_applied === true &&
        edgeStructureOk === true;
      rangeAddOnCandidate = upperShortAddOnCandidate || lowerLongAddOnCandidate;
      edgeStructureOkForAddon = edgeStructureOk;
      if (rangeAddOnCandidate && addOnUsed) {
        this.logger.info("range_add_on_entry_guard_blocked", {
          symbol: existing.symbol,
          side: existing.side,
          range_add_on_entry_applied: false,
          range_add_on_transition_applied: false,
          range_add_on_used: true,
          range_management_state_before: existing.rangeManagementState ?? "INIT",
          range_management_state_after: existing.rangeManagementState ?? "INIT",
          range_add_on_entry_count: addOnCount,
          range_add_on_entry_size_mult: 0,
          range_entry_zone: existing.rangeEntryZone ?? null,
          range_upper_short_priority_applied: res.decision.range_upper_short_priority_applied ?? false,
          range_lower_long_priority_applied: res.decision.range_lower_long_priority_applied ?? false,
          edgeStructureOk
        });
        return null;
      }
      if (existing.regimeAtEntry === "RANGE" && typeof first.boxPos === "number") {
        const zz = classifyRangeActionZone(first.boxPos);
        if (existing.side === "long" && zz === "upper" && adaptive.direction === "long") {
          this.logger.info("scale_in_blocked_range_upper_long_add", { symbol: existing.symbol, box_zone: zz });
          return null;
        }
        if (existing.side === "short" && zz === "lower" && adaptive.direction === "short") {
          this.logger.info("scale_in_blocked_range_lower_short_add", { symbol: existing.symbol, box_zone: zz });
          return null;
        }
      }
      targetStage = res.decision.target_stage ?? (existing.entryStage ?? 1) + 1;

      let sw = existing.scalingWeights;
      if (!sw) {
        if (existing.regimeAtEntry === "RANGE") sw = [0.30, 0.30, 0.40];
        else if (existing.regimeAtEntry === "TREND") sw = [0.30, 0.30, 0.40];
        else sw = [1.0];
      }
      scalingWeights = sw;

      const weight = scalingWeights[targetStage - 1] ?? 0;
      if (weight <= 0) return null;

      const baseStageWeight = scalingWeights[0] || 1;
      baseEntrySizeUsdForTrace = existing.initialSizeUsd ?? existing.sizeUsd;
      const baseFullSize = baseEntrySizeUsdForTrace / baseStageWeight;
      incrementalSizeUsd = Math.round(baseFullSize * weight * 100) / 100;

      rangeAddOnSizeMultApplied = 1;

      if (incrementalSizeUsd < MIN_POSITION_SIZE_USD) {
        incrementalSizeUsd = MIN_POSITION_SIZE_USD;
        minSizeGuardApplied = true;
      }

      const sizeTrace = {
        original_stage1_size: baseEntrySizeUsdForTrace,
        base_stage_weight: baseStageWeight,
        target_stage: targetStage,
        target_weight: weight,
        stage_weight_ratio: weight / baseStageWeight,
        base_full_size_usd: baseFullSize,
        base_target_usd: baseFullSize * weight,
        mult_risk_exposure: 1,
        mult_range_leg: 1,
        mult_range_cycle: 1,
        mult_range_recovery: 1,
        mult_add_on: rangeAddOnSizeMultApplied,
        min_size_guard_applied: minSizeGuardApplied,
        final_incremental_usd: incrementalSizeUsd
      };
      this.logger.info("stage2_size_calculation_trace", sizeTrace);
    }

    const re = this.lastRiskExposure;
    const symEx = String(existing.symbol);

    if (existing.regimeAtEntry === "TREND") {
      const pyr = this.trendPyramidLevelBySymbol.get(symEx) ?? 0;
      const tfs = this.trendFollowScoreBySymbol.get(symEx) ?? 0;
      if (!trendPyramidAllowsScaleIn(tfs, pyr)) {
        this.logger.info("scale_in_blocked_trend_pyramid_policy", {
          symbol: existing.symbol,
          trendFollowScore: tfs,
          pyramidLevel: pyr
        });
        return null;
      }
    }

    const opensList = await this.positions.loadOpenAll();
    const { longUsd, shortUsd } = marginsForSymbol(opensList, symEx);
    if (re) {
      if (existing.side === "long" && longUsd + incrementalSizeUsd > re.maxLongExposure) {
        this.logger.info("scale_in_blocked_max_long_exposure", { symbol: existing.symbol });
        return null;
      }
      if (existing.side === "short" && shortUsd + incrementalSizeUsd > re.maxShortExposure) {
        this.logger.info("scale_in_blocked_max_short_exposure", { symbol: existing.symbol });
        return null;
      }
    }
    const newTotalSizeUsd = existing.sizeUsd + incrementalSizeUsd;

    // Weighted average price
    const newEntryPrice = (existing.entryPrice * existing.sizeUsd + first.lastPrice * incrementalSizeUsd) / newTotalSizeUsd;

    // NOTE: ENTRY_OPENED is no longer recorded here. 
    // It is recorded in the main loop or as POSITION_SCALE_IN_SUCCESS.

    if (existing.regimeAtEntry === "RANGE" && typeof first.boxPos === "number") {
      this.logger.info("RANGE_SCALE_IN_SUCCESS_PROOF", {
        symbol: existing.symbol,
        side: existing.side,
        box_zone: classifyRangeActionZone(first.boxPos),
        box_pos: first.boxPos,
        snapshot_signal: first.signal,
        adaptive_direction: adaptive.direction,
        incremental_usd: incrementalSizeUsd,
        target_stage: targetStage,
        note: "상단 롱 증액은 별도 블록에서 차단됨 — 이 로그는 통과한 증액만"
      });
    }

    this.logger.info("paper_position_scaled_in", {
      symbol: existing.symbol,
      side: existing.side,
      prev_stage: existing.entryStage,
      target_stage: targetStage,
      incremental_size: incrementalSizeUsd,
      new_total_size: newTotalSizeUsd,
      guidance: res.decision.guidance
    });
    if (rangeCampaignScaleInPath || rangeAddOnCandidate) {
      const addOnCount = this.rangeUpperShortAddOnCountByKey.get(addOnKey) ?? 0;
      const nextAddOnCount = addOnCount + 1;
      this.rangeUpperShortAddOnCountByKey.set(addOnKey, nextAddOnCount);
      const nextState: RangeManagementState =
        existing.rangeFirstProfitLocked === true ? "PROFIT_LOCKED" : "REATTACK_USED";
      this.logger.info("range_add_on_entry", {
        symbol: existing.symbol,
        side: existing.side,
        range_add_on_entry_applied: true,
        range_add_on_transition_applied: true,
        range_add_on_used: true,
        range_campaign_scale_in: rangeCampaignScaleInPath,
        range_management_state_before: existing.rangeManagementState ?? "INIT",
        range_management_state_after: nextState,
        range_add_on_entry_count: nextAddOnCount,
        range_add_on_entry_size_mult: rangeAddOnSizeMultApplied,
        range_entry_zone: existing.rangeEntryZone ?? null,
        range_upper_short_priority_applied: res.decision.range_upper_short_priority_applied ?? false,
        range_lower_long_priority_applied: res.decision.range_lower_long_priority_applied ?? false,
        edgeStructureOk: edgeStructureOkForAddon
      });
    }

    const updatedRecord: PaperOpenPositionRecord = {
      ...existing,
      sizeUsd: newTotalSizeUsd,
      entryPrice: newEntryPrice,
      entryStage: targetStage,
      scalingWeights,
      rangeAddOnUsed: (targetStage >= 2 || rangeAddOnCandidate || rangeCampaignScaleInPath) ? true : existing.rangeAddOnUsed,
      rangeManagementState: (targetStage >= 2 || rangeAddOnCandidate || rangeCampaignScaleInPath)
        ? ("REATTACK_USED" as RangeManagementState)
        : (existing.rangeManagementState ?? "INIT"),
      stopPrice: typeof res.decision.stopLoss === "number" ? res.decision.stopLoss : existing.stopPrice,
      trailingExtremePrice: existing.side === "long"
        ? Math.max(existing.trailingExtremePrice ?? 0, first.lastPrice)
        : Math.min(existing.trailingExtremePrice ?? 999999, first.lastPrice)
    };

    this.logger.info("POSITION_STATE_ALIGNMENT_PROOF", {
      symbol: existing.symbol,
      side: existing.side,
      entryStage_before: existing.entryStage,
      entryStage_after: updatedRecord.entryStage,
      rangeAddOnUsed_before: existing.rangeAddOnUsed,
      rangeAddOnUsed_after: updatedRecord.rangeAddOnUsed,
      rangeManagementState_before: existing.rangeManagementState ?? "INIT",
      rangeManagementState_after: updatedRecord.rangeManagementState,
      is_scale_in: true,
      reason: rangeCampaignScaleInPath
        ? "range_campaign_scale_in"
        : rangeAddOnCandidate
          ? "range_add_on_candidate"
          : "standard_scale_in"
    });

    if (updatedRecord.stopPrice !== existing.stopPrice || existing.stopPrice === undefined) {
      this.logger.info("STOP_STATE_PROOF", {
        symbol: existing.symbol,
        side: existing.side,
        stopPrice_before: existing.stopPrice ?? "미설정",
        stopPrice_after: updatedRecord.stopPrice ?? "미설정",
        source: typeof res.decision.stopLoss === "number" ? "executor_decision" : "persisted_value"
      });
    }

    return updatedRecord;
  }

  private async pollSymbol(
    symbol: MarketSymbol,
    fetchedAt: number,
    klineLimit: number,
    regimeDetected: MarketRegimeDetection
  ): Promise<
    | Readonly<{ ok: true; snapshot: SymbolSnapshot; symbolDiagnostics: SymbolDiagnostic[] }>
    | Readonly<{ ok: false; error: string; symbolDiagnostics: SymbolDiagnostic[]; failedEndpoint: FailureEndpointKey }>
  > {
    const symbolDiagnostics: SymbolDiagnostic[] = [];

    const rT = await this.bybit.tryGetTicker(symbol);
    symbolDiagnostics.push(toSymbolDiagnostic(symbol, EP.ticker, rT.diagnostics));

    const rC = await this.bybit.tryGetCandles(symbol, "1m", klineLimit);
    symbolDiagnostics.push(toSymbolDiagnostic(symbol, EP.kline, rC.diagnostics));

    const rF = await this.bybit.tryGetFundingRate(symbol);
    symbolDiagnostics.push(toSymbolDiagnostic(symbol, EP.funding, rF.diagnostics));

    if (!rT.ok || !rC.ok || !rF.ok) {
      const parts: string[] = [];
      if (!rT.ok) parts.push(rT.error);
      if (!rC.ok) parts.push(rC.error);
      if (!rF.ok) parts.push(rF.error ?? "unknown");
      const failedEndpoint: FailureEndpointKey = !rT.ok ? "ticker" : (!rC.ok ? "kline" : (!rF.ok ? "funding" : "unknown"));
      return { ok: false, error: parts.join("; "), symbolDiagnostics, failedEndpoint };
    }

    const lastPrice = rT.value.last;
    const recentCandlesCount = rC.value.length;
    const latestCandleClose = rC.value.length > 0 ? rC.value[rC.value.length - 1].close : undefined;
    if (!Number.isFinite(lastPrice)) {
      return { ok: false, error: `Invalid lastPrice for ${symbol}`, symbolDiagnostics, failedEndpoint: "ticker" };
    }
    if (!Number.isFinite(recentCandlesCount)) {
      return { ok: false, error: `Invalid candles count for ${symbol}`, symbolDiagnostics, failedEndpoint: "kline" };
    }
    if (latestCandleClose === undefined || !Number.isFinite(latestCandleClose)) {
      return { ok: false, error: `Invalid latestCandleClose for ${symbol}`, symbolDiagnostics, failedEndpoint: "kline" };
    }
    if (!Number.isFinite(rF.value.rate)) {
      return { ok: false, error: `Invalid fundingRate for ${symbol}`, symbolDiagnostics, failedEndpoint: "funding" };
    }

    const bybitKlineLen = rC.value.length;
    this.logHighwayCandlePipelineProof("bybit_kline_ok", {
      trace_fetched_at_ms: fetchedAt,
      symbol: String(symbol),
      bybit_kline_array_length: bybitKlineLen,
      kline_limit_requested: klineLimit,
      interval: "1m",
      classify:
        bybitKlineLen === 0
          ? "bybit_returned_empty_array"
          : bybitKlineLen < klineLimit
            ? "bybit_fewer_than_requested"
            : "bybit_length_matches_or_exceeds_request"
    });

    const closes = rC.value.map((c) => c.close);
    const atr = atrWilderLast(rC.value, 14);
    const trend = trendFilterOneMinuteCloses(closes);

    // Box context from recent completed 1m candles (used to enforce RANGE edge-only and TREND breakout/pullback).
    const completed1m = rC.value.slice(0, -1);
    const boxLookback = completed1m.slice(-30);
    const boxHigh = boxLookback.length > 0 ? Math.max(...boxLookback.map((x) => x.high)) : null;
    const boxLow = boxLookback.length > 0 ? Math.min(...boxLookback.map((x) => x.low)) : null;
    const boxRel = boxHigh !== null && boxLow !== null && lastPrice > 0 ? (boxHigh - boxLow) / (lastPrice + 1e-9) : null;
    const boxPos =
      boxHigh !== null && boxLow !== null && boxHigh > boxLow
        ? Math.min(1, Math.max(0, (lastPrice - boxLow) / (boxHigh - boxLow)))
        : null;

    let entry = evaluatePaperEntryV1({
      symbol,
      ema20: trend.ema20,
      ema60: trend.ema60,
      latestCandleClose,
      strongEmaGapThreshold: this.config.paperStrongEmaGapThreshold,
      sidewaysEmaGapThreshold: this.config.paperSidewaysEmaGapThreshold
    });

    // BTC-specific candidate signal relaxation for RANGE regime (후보만; 체결은 기존 게이트 유지)
    let signalDecisionOrigin = "entry_signal_raw";
    let signal_missing_reason = "NONE";
    let rangeSignalOrigin = "entry_signal_raw";
    let rangeSignalDowngraded = false;
    let rangeSignalDowngradeReason = "none";
    let rangeSignalKeptByRelax = false;
    if (symbol === "BTCUSDT" && regimeDetected.regime === "RANGE" && entry.signal === "none") {
      if (boxPos !== null && boxRel !== null && boxRel >= 0.0035) {
        // 가장자리 기준 소폭 확대(0.28/0.72 → 0.26/0.74): 후보 노출만
        if (boxPos <= 0.26) {
          entry = {
            ...entry,
            signal: "paper_long_candidate",
            candidateStrength: "weak",
            sidewaysMode: true,
            entryCandidate: true
          };
          signalDecisionOrigin = "btc_range_soft_candidate_lower_edge";
          rangeSignalOrigin = signalDecisionOrigin;
        } else if (boxPos >= 0.74) {
          entry = {
            ...entry,
            signal: "paper_short_candidate",
            candidateStrength: "weak",
            sidewaysMode: true,
            entryCandidate: true
          };
          signalDecisionOrigin = "btc_range_soft_candidate_upper_edge";
          rangeSignalOrigin = signalDecisionOrigin;
        } else {
          signal_missing_reason = `BOX_CENTER (pos:${boxPos.toFixed(2)})`;
          signalDecisionOrigin = "btc_range_soft_candidate_rejected_box_center";
          rangeSignalOrigin = signalDecisionOrigin;
        }
      } else if (boxRel !== null && boxRel < 0.0035) {
        signal_missing_reason = `BOX_TOO_NARROW (rel:${boxRel.toFixed(5)})`;
        signalDecisionOrigin = "btc_range_soft_candidate_rejected_box_too_narrow";
        rangeSignalOrigin = signalDecisionOrigin;
      } else {
        signal_missing_reason = "BOX_MISSING";
        signalDecisionOrigin = "btc_range_soft_candidate_rejected_box_missing";
        rangeSignalOrigin = signalDecisionOrigin;
      }
    } else if (entry.signal === "none") {
      signal_missing_reason = "EMA_CRITERIA_NOT_MET";
      signalDecisionOrigin = "entry_signal_none";
      rangeSignalOrigin = signalDecisionOrigin;
    } else {
      rangeSignalOrigin = "entry_signal_candidate";
    }

    const sideForQuality =
      entry.signal === "paper_long_candidate"
        ? "long"
        : entry.signal === "paper_short_candidate"
          ? "short"
          : null;
    const qualityScore =
      sideForQuality === null || entry.candidateStrength === null
        ? 0
        : computePaperEntryQualityScore({
          ema20: trend.ema20,
          ema60: trend.ema60,
          lastPrice,
          latestCandleClose,
          side: sideForQuality,
          candidateStrength: entry.candidateStrength,
          emaGap: entry.emaGap ?? 0,
          sidewaysEmaGapThreshold: this.config.paperSidewaysEmaGapThreshold
        });
    const signalStrength = paperSignalStrengthLabel(qualityScore, this.config.paperEntryRelaxed);

    let signal: PaperSignal = entry.signal;
    let entryCandidate = entry.entryCandidate;
    let gateEval: ReturnType<typeof evaluateEntryCostAndHigherTfGate> | null = null;
    let gateBlockedReason: string | null = null;
    const entrySide: "long" | "short" | null =
      entry.signal === "paper_long_candidate"
        ? "long"
        : entry.signal === "paper_short_candidate"
          ? "short"
          : null;

    const qualityMinEffective =
      entry.candidateStrength === "weak"
        ? Math.min(this.config.paperQualityMinScore, this.config.paperQualityMinScoreWeak)
        : this.config.paperQualityMinScore;

    if (entrySide !== null) {
      const isBtcRange = symbol === "BTCUSDT" && regimeDetected.regime === "RANGE";
      const hasRangeEdge = boxPos !== null && (boxPos <= 0.36 || boxPos >= 0.64);
      const rangeSignalKeepByRelaxCandidate =
        isBtcRange &&
        (regimeDetected.rangeConfidence ?? 0) >= 0.5 &&
        (regimeDetected.boxCohesion01 ?? 0) >= 0.45 &&
        (regimeDetected.trendWeaknessScore ?? 0) >= 0.5 &&
        hasRangeEdge;
      if (this.config.paperQualityMinScore > 0 && qualityScore < qualityMinEffective) {
        if (rangeSignalKeepByRelaxCandidate) {
          signal = entry.signal;
          entryCandidate = true;
          rangeSignalKeptByRelax = true;
          signalDecisionOrigin = "btc_range_relax_keep_candidate_quality";
        } else {
          signal = "none";
          entryCandidate = false;
          gateBlockedReason = "quality_below_min";
          signalDecisionOrigin = "entry_gate_blocked_quality_min";
          rangeSignalDowngraded = true;
          rangeSignalDowngradeReason = "quality_below_min";
        }
      } else {
        const tfHi = entryGateHigherTimeframe();
        const limHi = entryGateHigherTfKlineLimit();
        const rC5 = await this.bybit.tryGetCandles(symbol, tfHi, limHi);
        symbolDiagnostics.push(toSymbolDiagnostic(symbol, EP.kline, rC5.diagnostics));

        const higherCandles = rC5.ok ? rC5.value : null;
        const gate = evaluateEntryCostAndHigherTfGate({
          entryTimeframeCandles: rC.value,
          higherTfCandles: higherCandles,
          refPrice: lastPrice,
          takerFeeRate: this.config.paperTakerFeeRate,
          fundingRate: rF.value.rate,
          gateOptions: {
            minMoveMultiplier: this.config.paperGateMinMoveMultiplier,
            requireHigherTfAlign: this.config.paperRequireHigherTfAlign
          },
          paperBypassExpectedMoveGate: false,
          entryDirection: entrySide
        });
        gateEval = gate;

        if (!gate.allowed) {
          if (rangeSignalKeepByRelaxCandidate) {
            signal = entry.signal;
            entryCandidate = true;
            rangeSignalKeptByRelax = true;
            signalDecisionOrigin = `btc_range_relax_keep_candidate_gate_${String(gate.blockReason ?? "gate")}`;
          } else {
            signal = "none";
            entryCandidate = false;
            gateBlockedReason = gate.blockReason ?? "gate";
            signalDecisionOrigin = `entry_gate_blocked_${String(gateBlockedReason)}`;
            rangeSignalDowngraded = true;
            rangeSignalDowngradeReason = gateBlockedReason;
          }
        }
      }
    }

    // ------------------------------------------------------------------------
    // Construct Snapshot
    // ------------------------------------------------------------------------
    const snapshot: SymbolSnapshot = {
      symbol,
      lastPrice,
      recentCandlesCount,
      latestCandleClose,
      fundingRate: rF.value.rate,
      fetchedAt,
      ema20: trend.ema20,
      ema60: trend.ema60,
      trendOk: trend.trendOk,
      entryCandidate,
      signal,
      qualityScore,
      candidateStrength: entry.candidateStrength,
      emaGap: entry.emaGap,
      volumeRatioProxy: volumeRatioProxyFromCandles(rC.value),
      boxHigh,
      boxLow,
      boxPos,
      boxRel,
      gateExpectedMove: gateEval?.expectedMove ?? null,
      gateRequiredMove: gateEval?.requiredMove ?? null,
      atr,
      signalMissingReason: signal_missing_reason,
      signalGateBlockedReason: gateBlockedReason,
      signalDecisionOrigin,
      rangeSignalOrigin,
      rangeSignalDowngraded,
      rangeSignalDowngradeReason,
      rangeSignalKeptByRelax,
      rangeConfidence: regimeDetected.rangeConfidence,
      boxCohesion01: regimeDetected.boxCohesion01,
      breakoutFailureRate: regimeDetected.breakoutFailureRate,
      rangeOscillationScore: regimeDetected.rangeOscillationScore,
      trendWeaknessScore: regimeDetected.trendWeaknessScore,
      rangeReasonLabel: regimeDetected.rangeReasonLabel,
      rangeCycleCount: (this.rangeRuntimeBySymbol.get(String(symbol))?.cycle ?? 0),
      rangeLadderLevel: (this.rangeRuntimeBySymbol.get(String(symbol))?.ladder ?? 0),
      regimeExitRisk: regimeDetected.regimeExitRisk,
      boxBreakSide: regimeDetected.boxBreakSide,
      regimeStateDiag: regimeDetected.regimeState,
      candles: rC.value,
      highwayKlineLimitRequested: klineLimit,
      highwayEntryTf: "1m"
    };

    this.logHighwayCandlePipelineProof("snapshot_before_return", {
      trace_fetched_at_ms: fetchedAt,
      symbol: String(symbol),
      snapshot_candles_array_length: snapshot.candles?.length ?? 0,
      snapshot_recent_candles_count: snapshot.recentCandlesCount,
      candles_same_reference_as_bybit_response: snapshot.candles === rC.value,
      classify:
        (snapshot.candles?.length ?? 0) === 0
          ? "snapshot_candles_empty_after_poll_ok"
          : (snapshot.candles?.length ?? 0) !== snapshot.recentCandlesCount
            ? "snapshot_len_mismatch_candles_vs_recent_count"
            : "snapshot_candles_consistent"
    });

    /** ENTRY_LINE은 runTick 루프에서 의사결정 결과(Intent 등)와 합쳐서 로깅하기 위해 여기서는 생략 */
    this.logger.info("symbol_snapshot", snapshot);
    this.logger.info("symbol_signal", {
      symbol,
      signal,
      base_signal: entry.signal,
      ema_gap: entry.emaGap,
      sideways_mode: entry.sidewaysMode,
      candidate_strength: entry.candidateStrength,
      signal_strength: signalStrength,
      trendOk: trend.trendOk
    });

    return { ok: true, snapshot, symbolDiagnostics };
  }

}

/**
 * ENGINE STATE SUMMARY HELPER (Phase 2 Extraction)
 * Promotes authority-first status for terminal/dashboard state.
 */
function buildEngineStateSymbolDecision(envelope: PaperEngineDecisionEnvelope): Record<string, unknown> {
  const { legacy, authority, selector } = envelope;
  return {
    decision: legacy.decision.final_decision,
    adaptiveOk: legacy.adaptiveOk,

    authority_decision: authority.decision,
    authority_side: authority.side,
    authority_size_usd: authority.decision === "ENTER" ? authority.sizeUsd : 0,
    authority_source: authority.source,

    selector_engine: selector?.adopted_result.engine ?? "v1",
    adopted_engine: selector?.adopted_result.engine ?? "v1",
    adoption_reason: selector?.adopted_result.adoption_reason ?? "legacy_fallback",

    v1_decision: envelope.v1_decision ?? legacy.decision.final_decision,
    v1_side: envelope.v1_side ?? legacy.intentSide ?? "none",
    v1_size: envelope.v1_size ?? legacy.executorDecision?.total_cost ?? 0,

    v2_decision: envelope.v2_decision ?? selector?.v2_result.decision ?? "SKIP",
    v2_side: envelope.v2_side ?? selector?.v2_result.side ?? "none",
    v2_size: envelope.v2_size ?? selector?.v2_result.risk.finalSizeUsd ?? 0,

    selector_mismatch:
      envelope.selector_mismatch ??
      (selector ? selector.mismatch : false)
  };
}

/**
 * AUTHORITY EVENT METADATA HELPER (Phase 3)
 */
function buildAuthorityEventMeta(
  authority: EntryExecutionAuthority,
  executedEntrySizeUsd?: number | null
): Record<string, unknown> {
  const useExecuted =
    authority.decision === "ENTER" &&
    typeof executedEntrySizeUsd === "number" &&
    Number.isFinite(executedEntrySizeUsd) &&
    executedEntrySizeUsd > 0;
  return {
    authority_decision: authority.decision,
    authority_side: authority.side,
    authority_size_usd: useExecuted ? executedEntrySizeUsd : authority.decision === "ENTER" ? authority.sizeUsd : 0,
    authority_source: authority.source,
    authority_regime: authority.regime
  };
}

/**
 * ENTRY ALLOWED EVENT PAYLOAD HELPER (Phase 3)
 */
function buildEntryAllowedEventPayload(
  symbol: string,
  regime: string,
  ex: NonNullable<EvaluatePaperSymbolEntryResult["executorDecision"]>,
  authority: EntryExecutionAuthority
): Record<string, unknown> {
  return {
    ts: Date.now(),
    type: "ENTRY_ALLOWED",
    symbol,
    regime,
    executor: ex.executor,
    reason: "executor_allowed",
    expected_move: ex.expected_move,
    total_cost: ex.total_cost,
    risk_state: ex.risk_state,
    detail: ex.detail,
    ...buildAuthorityEventMeta(authority)
  };
}

/**
 * AI event payload helper (approved / blocked).
 */
function buildAiEventPayload(
  type: "AI_APPROVED" | "AI_BLOCKED",
  symbol: string,
  regime: string,
  aiIn: AiApprovalInput,
  aiOut: AiApprovalOutput,
  authority: EntryExecutionAuthority
): Record<string, unknown> {
  return {
    ts: Date.now(),
    type,
    symbol,
    regime,
    ai_input: aiIn,
    ai_output: aiOut,
    ...buildAuthorityEventMeta(authority)
  };
}

/**
 * ENTRY BLOCKED EVENT PAYLOAD HELPER (Phase 3)
 */
function buildEntryBlockedEventPayload(
  symbol: string,
  regime: string,
  res: EvaluatePaperSymbolEntryResult,
  authority: EntryExecutionAuthority,
  riskStatus: string
): Record<string, unknown> {
  const d = res.decision;
  const ex = res.executorDecision;
  return {
    ts: Date.now(),
    type: "ENTRY_BLOCKED",
    symbol,
    regime,
    legacy_decision: d.final_decision,
    reject_reason: d.reject_reason,
    original_signal_state: d.original_signal_state ?? null,
    final_signal_state: d.final_signal_state ?? null,
    execution_disabled_reason: d.execution_disabled_reason ?? null,
    expected_move: typeof ex?.expected_move === "number" && Number.isFinite(ex.expected_move) ? ex.expected_move : null,
    total_cost: ex?.total_cost ?? null,
    risk_state: ex?.risk_state ?? riskStatus,
    supplemental_reasons: d.supplemental_reasons ?? [],
    adaptive_direction: null,
    detail: res.adaptiveDetail,
    ...buildAuthorityEventMeta(authority)
  };
}

/**
 * ENTRY OPENED EVENT PAYLOAD HELPER (Phase 3)
 */
function buildEntryOpenedEventPayload(
  symbol: string,
  authority: EntryExecutionAuthority,
  pos: PaperOpenPositionRecord
): Record<string, unknown> {
  return {
    ts: Date.now(),
    type: "ENTRY_OPENED",
    symbol,
    side: pos.side,
    entry_price: pos.entryPrice,
    size_usd: pos.sizeUsd,
    initial_size_usd: pos.initialSizeUsd,
    leverage: pos.leverage,
    regime: pos.regimeAtEntry,
    executor: pos.executorAtEntry,
    entry_stage: pos.entryStage,
    stop_price: pos.stopPrice ?? null,
    ...buildPositionIdentityMeta(pos),
    ...buildAuthorityEventMeta(authority, pos.sizeUsd)
  };
}
function buildV2SnapshotBridge(snap: SymbolSnapshotLike): V2BridgeSnapshot {
  return {
    lastPrice: snap.lastPrice,
    latestCandleClose: snap.latestCandleClose,
    boxHigh: snap.boxHigh ?? 0,
    boxLow: snap.boxLow ?? 0,
    boxPos: snap.boxPos ?? 0.5,
    rangeConfidence: snap.rangeConfidence ?? 0.5,
    ema20: snap.ema20 ?? 0,
    emaGap: snap.emaGap ?? 0,
    atr: snap.atr ?? 0,
    signal: snap.signal ?? "NONE",
    qualityScore: snap.qualityScore ?? 0
  };
}

function buildV2LegacyBridge(res: EvaluatePaperSymbolEntryResult): V2BridgeLegacyDecision {
  return {
    regime: String(res.decision.regime ?? "UNKNOWN"),
    finalDecision: res.decision.final_decision,
    rejectReason: res.decision.reject_reason,
    requiredCostUsd: res.decision.required_cost_usd ?? 0,
    entryAllowed: res.executorDecision?.entry_allowed ?? false,
    executorLabel: res.executorDecision?.executor ?? "unknown",
    intentSide: res.intentSide === "long" || res.intentSide === "short" ? res.intentSide : null,
    adaptiveOk: res.adaptiveOk,
    adaptiveDetail: res.adaptiveDetail
  };
}

function buildV2ConfigBridge(config: EngineConfig): V2BridgeConfig {
  return {
    baseSizeUsd: config.paperBaseSizeUsd,
    maxOpenPositions: config.paperMaxOpenPositions,
    reentryCooldownMs: config.paperReentryCooldownMs
  };
}

function buildV2StateBridge(
  opensAfterClose: ReadonlyArray<PaperOpenPositionRecord>,
  lastRisk: RiskControlDecision | null
): V2BridgeState {
  return {
    currentPositions: opensAfterClose
      .map((p): V2BridgePosition | null => {
        const side = normalizePositionSideUpper(p.side);
        if (side === "NONE") return null;
        return {
          symbol: p.symbol,
          side: side,
          entryPrice: p.entryPrice,
          sizeUsd: p.sizeUsd,
          entryStage: p.entryStage ?? 1
        };
      })
      .filter((x): x is V2BridgePosition => x !== null),
    globalRiskScore: 0.5,
    lossStreaks: lastRisk?.recentLossStreakByMode ?? {}
  };
}

function buildPositionIdentityMeta(pos: PaperOpenPositionRecord | PaperClosedPositionRecord): Record<string, unknown> {
  const p = pos as any;
  return {
    strategyVersion: p.strategyVersion ?? "paper-v1",
    sourceSignal: p.sourceSignal ?? null,
    executorAtEntry: p.executorAtEntry ?? null,
    regimeAtEntry: p.regimeAtEntry ?? null
  };
}
