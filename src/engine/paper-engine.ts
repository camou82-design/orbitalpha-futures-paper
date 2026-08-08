import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { classifyRangeZone } from "../models/types";
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
  PaperMarketMode,
  PaperCloseSource
} from "../models/types";

import type { Logger } from "../logs/logger";
import { JsonStore } from "../storage/json-store";
import type { OkxPublicDiagnostics } from "../exchange/okx-demo";
import { OkxDemoClient, toOkxSwapInstId } from "../exchange/okx-demo";
import { buildLedgerOkxPositionSyncSnapshot, okxSwapRowToLedgerKey } from "../exchange/okx-position-sync";
import { buildPositionOpsSurface, engineMirrorStopPrice, engineMirrorTpPrice, regimeForSl } from "./position-ops-monitor";
import type { PositionOpsSurface } from "./position-ops-monitor";
import { trendFilterOneMinuteCloses } from "../strategy/trend-filter";
import { evaluatePaperEntryV1 } from "../strategy/entry-signal";
import type { PaperCandidateStrength, PaperSignal } from "../strategy/entry-signal";
import type { FuturesMarketMode } from "../strategy/live-market-mode";
import { evaluateRegimeExitPolicy, stopLossPctForRegime } from "../strategy/regime-exit";
import { evaluatePartialExitPolicy, defaultPartialExitRatioForStage } from "../strategy/live-partial-exit-policy";
import { computePaperSizingAnchorUsd, MIN_POSITION_SIZE_USD } from "../strategy/live-position-sizing";
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
  type RangeStopReentryBlock
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
import { runEngineV2, adaptV2Input, shouldEmitV2Proof } from "../engine-v2/index";
import { normalizeOkxSwapContractsFromNotional, formatOkxSwapContractSzString, okxInstrumentSzDecimals, type OkxSwapInstrumentSizing } from "../engine-v2/okx-swap-sizing";
export { normalizeOkxSwapContractsFromNotional };
import { getPaperLoopIntervalMs } from "../config/env";
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
import type { V2ExecutionAuthorityEnvelope } from "../engine-v2/execution/types";
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

/** RANGE 1m edge reversal candle ?덇굅??寃뚯씠????V2 ?ㅽ뻾 遊됲닾媛 ENTER쨌臾댄븯?쒕툝濡앹씪 ??理쒖쥌 ?ㅽ뻾 寃쎈줈瑜?留됱? ?딅룄濡?遺꾨━?쒕떎. */
const LEGACY_RANGE_EDGE_NO_REVERSAL_REJECTS = new Set<string>([
  "RANGE_LOWER_LONG_NO_REVERSAL_CONFIRMATION",
  "RANGE_UPPER_SHORT_NO_REVERSAL_CONFIRMATION"
]);
import { deriveLiveBalanceAuthority, type LiveBalanceAuthorityResult } from "../engine-v2/live-account/balance-authority";
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
  ticker: "/api/v5/market/ticker",
  kline: "/api/v5/market/candles",
  funding: "/api/v5/public/funding-rate"
} as const;

const SAME_DIR_REENTRY_COOLDOWN_MULT = 1.35;
const RANGE_REVERSAL_SWITCH_PENDING_MS = 90_000;

/** 吏꾩엯 吏곹썑 entry identity ?덉씤 ?좎?: ?μ꽭쨌?덉씤 ?꾪솚???꾨웾 泥?궛留???援ш컙?먯꽌 湲덉?(?먯젅쨌?몄텧 ?쒕룄 ?깆? ?덉슜). */
const ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS = 120_000;

/**
 * Partial ?댄썑 ?붿뿬 ?ъ???蹂댄샇 援ш컙(ms).
 * 遺遺꾩껌??TP_PARTIAL / PARTIAL_SPLIT) 吏곹썑 SIGNAL_LOST / REGIME_EXIT 怨쇰? 泥?궛 李⑤떒.
 * STRUCTURAL / TREND_BREAK / CRASH_FORCE ????援ш컙?먯꽌???덉쇅?곸쑝濡?泥?궛 ?덉슜.
 */
const POST_PARTIAL_REGIME_PROTECT_MS = 3 * 60_000; // 3遺?
/**
 * Crash guard ?먮룞 ?댁젣 ?좎삁 ?쒓컙(ms): CRASH_EXIT/LOCK 諛쒖깮 ?????쒓컙??吏?섍퀬
 * activeEngine ??RANGE 濡??꾪솚???덉쑝硫?濡?吏꾩엯 李⑤떒???댁젣?쒕떎.
 * 洹밸떒 ?щ옒??吏곹썑 臾닿린??block 諛⑹?.
 */
const CRASH_GUARD_REGIME_AWARE_RELEASE_MS = 5 * 60_000; // 5遺?
/** RANGE 罹좏럹?? ?щ낵 1?뚯쟾??珥?諛곗젙??80%留??ъ슜(珥덇린 40% + 異붽? 40%, 蹂대쪟 20%). */
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

/** RANGE 泥?궛쨌?좎? ?뺤콉??諛뺤뒪 ?꾩튂 援ш컙 (?곷떒 ??.62, ?섎떒 ??.38). */


const ENTRY_SIGNAL_LOST_PROTECT_MS = 10 * 60_000;
const ENTRY_SIGNAL_LOST_CONFIRM_TICKS = 3;
const ENTRY_EVIDENCE_TREND_EMA_GAP_MIN = 0.0002;
const ENTRY_EVIDENCE_TREND_WEAKNESS_MAX = 0.65;
const RANGE_RECHECK_PROMOTION_TICKS = 3;
const RANGE_CONFIDENCE_HARD_HOLD_MAX = 0.45;
const RANGE_CONFIDENCE_RECHECK_ALLOW_MIN = 0.55;

function computeEntryEvidenceScore(input: {
  qualityScore: number | null;
  candidateStrength: PaperCandidateStrength | null;
  activeEngine: "RANGE" | "TREND" | "IDLE";
  side: "long" | "short";
  boxPos: number | null;
  trendOk: boolean;
  emaGap: number | null;
  trendWeaknessScore: number | null;
}): number {
  let score = 0;
  const quality = Math.max(0, Math.min(100, input.qualityScore ?? 0));
  score += quality * 0.6;
  if (input.candidateStrength === "strong") score += 20;
  else if (input.candidateStrength === "weak") score += 8;
  if (input.activeEngine === "RANGE" && typeof input.boxPos === "number") {
    const zone = classifyRangeZone(input.boxPos);
    if ((input.side === "short" && zone === "upper") || (input.side === "long" && zone === "lower")) score += 20;
  }
  if (input.activeEngine === "TREND") {
    if (input.trendOk) score += 10;
    if (Math.abs(input.emaGap ?? 0) >= ENTRY_EVIDENCE_TREND_EMA_GAP_MIN) score += 6;
    if ((input.trendWeaknessScore ?? 1) <= ENTRY_EVIDENCE_TREND_WEAKNESS_MAX) score += 4;
  }
  return Math.max(0, Math.min(100, score));
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
  authoritySource?: "v1" | "v2";
  /** RANGE/TREND ?먮떒??諛뺤뒪(理쒓렐 1m) */
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
  htf_candles?: Record<string, import("../models/types").Candle[]>;
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
  snapshot: SymbolSnapshot | null;
  authorityEvaluatedAt: number;
  executorDecisionEvaluatedAt: number;
  signalFetchedAt: number;
  decisionCycleId: number;
  v1_decision?: string;
  v1_side?: string;
  v1_size?: number;
  v2_decision?: string;
  v2_side?: string;
  v2_size?: number;
  selector_mismatch?: boolean;
  v2_paper_cooldown_agreement?: boolean | null;
  v2_cooldown_action?: string | null;
  v2_cooldown_type?: string | null;
  v2_cooldown_reason?: string | null;
  v2_cooldown_urgency?: string | null;
  v2_cooldown_remaining_ms?: number | null;
  v2_direction_blocked?: string | null;
  cooldown_authority_owner?: string | null;
  cooldown_execution_owner?: string | null;
  v2_position_state_action?: string | null;
  v2_position_lifecycle_state?: string | null;
  v2_position_risk_state?: string | null;
  v2_position_stage?: number | null;
  v2_position_pnl_state?: string | null;
  v2_position_hold_ms?: number | null;
  v2_unrealized_pnl_usd_estimate?: number | null;
  v2_paper_position_state_agreement?: boolean | null;
  position_state_authority_owner?: string | null;
  position_state_execution_owner?: string | null;
  v2_execution_envelope?: V2ExecutionAuthorityEnvelope | null;
  hard_block_present?: boolean;
};

type EntryQualityFeatureVector = Readonly<{
  qualityScore: number;
  atrPct: number;
  emaGap: number;
  volumeRatioProxy: number;
  sideBias: number;
}>;

type EntryQualitySample = Readonly<{
  ts: number;
  symbol: string;
  side: "long" | "short";
  source: "profit" | "loss" | "contaminated";
  vector: EntryQualityFeatureVector;
  reason: string;
}>;

type OperatorInstruction = {
  type: "ADOPT_EXCHANGE_STATE";
  symbol: MarketSymbol;
  side: "long" | "short";
  reason: string;
};

type ServerTradeControlState = Readonly<{
  server_trade_enabled: boolean;
  close_only_mode: boolean;
  kill_switch_active: boolean;
  authority_source: "server_state";
  updated_at: number;
  reason: string | null;
  instructions?: OperatorInstruction[];
}>;

function toSymbolDiagnostic(symbol: MarketSymbol, endpoint: string, d: OkxPublicDiagnostics): SymbolDiagnostic {
  return {
    symbol,
    endpoint,
    httpStatus: d.httpStatus,
    retCode: d.retCode ? Number(d.retCode) : undefined,
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
  exchange: "okx";
  okx_demo_enabled: boolean;
  okx_demo_keys_loaded: boolean;
  okx_signed_rest_ready: boolean;
  okx_account_config_ok: boolean;
  okx_balance_ok: boolean;
  okx_positions_ok: boolean;
  okx_order_submit_ok: boolean;
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

/** Latest close per symbol: time + side + 泥?궛 ?ъ쑀쨌?④퀎 (?ъ쭊??荑⑤떎?는룹셿???먮떒??. */
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

/** OKX `submitOrder`/`getOrder` throw ?먮뒗 envelope ?ㅽ뙣 硫붿떆吏 ?뚯떛 */
function parseOkxSubmitErrorMessage(msg: string): { code: string | null; message: string } {
  const mApi = /^okx_api_([^:]+):([\s\S]*)$/.exec(msg);
  if (mApi) return { code: mApi[1].trim(), message: (mApi[2] ?? "").trim() || "request_failed" };
  const mHttp = /^okx_http_([^:]+):([\s\S]*)$/.exec(msg);
  if (mHttp) return { code: `http_${mHttp[1].trim()}`, message: (mHttp[2] ?? "").trim() || "request_failed" };
  return { code: null, message: msg };
}

/** OKX `clOrdId`: letters/digits only, max length 32 (hyphens and underscores rejected by API). */
function okxClOrdIdSideCode(side: "buy" | "sell" | "long" | "short"): string {
  switch (side) {
    case "buy":
      return "b";
    case "sell":
      return "s";
    case "long":
      return "l";
    case "short":
      return "h";
    default:
      return "x";
  }
}

function buildOkxClOrdId(rawSymbol: string, sideForCode: "buy" | "sell" | "long" | "short"): string {
  const sym = String(rawSymbol).replace(/[^A-Za-z0-9]/g, "");
  const sideCode = okxClOrdIdSideCode(sideForCode);
  const ts36 = Date.now().toString(36);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const built = `p${sym}${sideCode}${ts36}${suffix}`;
  return built.length <= 32 ? built : built.slice(0, 32);
}

/**
 * Identifies if an order was originated by this engine.
 * Pattern: "p" prefix + symbol + sideCode + ts36 + suffix.
 */
function isOrderEngineOwned(ord: { clOrdId?: string; ordId?: string }): boolean {
  if (!ord.clOrdId) return false;
  return ord.clOrdId.startsWith("p");
}

function parseOkxSwapInstrumentSizing(inst: Record<string, unknown>): OkxSwapInstrumentSizing | null {
  const lotSz = Number(inst.lotSz);
  const minSz = Number(inst.minSz);
  const ctVal = Number(inst.ctVal);
  const ctValCcy = String(inst.ctValCcy ?? "");
  const tickSz = Number(inst.tickSz);
  if (!Number.isFinite(lotSz) || lotSz <= 0) return null;
  if (!Number.isFinite(minSz) || minSz <= 0) return null;
  if (!Number.isFinite(ctVal) || ctVal <= 0) return null;
  const result = { lotSz, minSz, ctVal, ctValCcy } as OkxSwapInstrumentSizing;
  if (Number.isFinite(tickSz) && tickSz > 0) {
    (result as any).tickSz = tickSz;
  }
  return result;
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
  order_submit_ack: "accepted" | "rejected" | "skipped_no_okx_demo" | "paper_only" | null;
  order_submit_error_code: string | null;
  order_submit_error_message: string | null;
  exchange_client_order_id: string | null;
  exchange_ord_id: string | null;
  exchange_order_state: string | null;
  exchange_fill_px: string | number | null;
  exchange_ack_s_code: string | null;
  exchange_ack_s_msg: string | null;
  position_open_record_written: boolean;
  position_open_final_state: "opened" | "failed" | "aborted_pre_exchange" | "ENTRY_ORDER_PENDING";
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

/** V2 automatic entry: stop must come from strategy/authority fields — never from engine mirror at entry gate. */
export type V2CommittedStopSource =
  | "invalidation_px"
  | "authority_stop_price"
  | "new_stop_price"
  | "decision_stop_loss"
  | "policy_clamped";

export type V2PreEntryRiskPlanCommitted = Readonly<{
  side: "long" | "short";
  reference_entry_px: number;
  stop_price: number;
  initial_tp_price: number | null;
  risk_distance: number;
  protection_required: true;
  stop_source: V2CommittedStopSource;
  take_profit_source: "engine_calculated" | "authority_tp_price" | "none";
  stop_distance_pct: number;
  take_profit_distance_pct: number | null;
  risk_reward_ratio: number | null;
}>;

function isCommittedEntryStopPrice(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v !== 0;
}

function extractV2StrategyStopPriceForEntry(
  authority: EntryExecutionAuthority,
  decisionStopLoss: unknown
): Readonly<{ price: number; source: V2CommittedStopSource }> | null {
  const n = (u: unknown): number | null =>
    typeof u === "number" && Number.isFinite(u) && u !== 0 ? u : null;
  const inv = n(authority.invalidationPx);
  if (inv != null) return { price: inv, source: "invalidation_px" };
  const asp = n(authority.stopPrice);
  if (asp != null) return { price: asp, source: "authority_stop_price" };
  const nsp = n(authority.newStopPrice);
  if (nsp != null) return { price: nsp, source: "new_stop_price" };
  const dsl = n(decisionStopLoss);
  if (dsl != null) return { price: dsl, source: "decision_stop_loss" };
  return null;
}

function buildV2PreEntryRiskPlanCommitted(
  authority: EntryExecutionAuthority,
  decision: { stopLoss?: unknown; takeProfit?: unknown },
  side: "long" | "short",
  referenceEntryPx: number,
  logger: any,
  symbol: string
): { ok: true; plan: V2PreEntryRiskPlanCommitted } | { ok: false; reason?: string } {
  if (!(referenceEntryPx > 0) || !Number.isFinite(referenceEntryPx)) return { ok: false, reason: "invalid_entry_px" };
  const rawSp = extractV2StrategyStopPriceForEntry(authority, decision.stopLoss);
  if (rawSp == null) return { ok: false, reason: "no_raw_stop" };
  
  const regime = regimeForSl(authority.regime);
  const policySl = engineMirrorStopPrice(referenceEntryPx, side, regime);
  
  let finalStopPrice = rawSp.price;
  let finalStopSource = rawSp.source;
  let clampApplied = false;
  
  if (policySl != null) {
    if (side === "long") {
      if (rawSp.price > policySl) {
        finalStopPrice = policySl;
        finalStopSource = "policy_clamped";
        clampApplied = true;
      }
    } else {
      if (rawSp.price < policySl) {
        finalStopPrice = policySl;
        finalStopSource = "policy_clamped";
        clampApplied = true;
      }
    }
  }

  // Directional sanity check
  if (side === "long" && finalStopPrice >= referenceEntryPx) return { ok: false, reason: "invalid_stop_direction_long" };
  if (side === "short" && finalStopPrice <= referenceEntryPx) return { ok: false, reason: "invalid_stop_direction_short" };

  const rawStopDistancePct = (Math.abs(referenceEntryPx - rawSp.price) / referenceEntryPx) * 100;
  const finalStopDistancePct = (Math.abs(referenceEntryPx - finalStopPrice) / referenceEntryPx) * 100;

  if (clampApplied) {
    logger.info("V2_STOP_DISTANCE_CLAMP_PROOF", {
      symbol,
      side,
      entryPrice: referenceEntryPx,
      rawInvalidationPx: rawSp.price,
      policyStopPrice: policySl,
      finalStopPrice,
      rawStopDistancePct,
      finalStopDistancePct,
      clampApplied: true,
      clampReason: "invalidation_too_close"
    });
  }

  let finalTpPrice: number | null = null;
  let finalTpSource: "engine_calculated" | "authority_tp_price" | "none" = "none";
  let policyTpPrice: number | null = null;
  let profitManagementMode: "FIXED_TP" | "PARTIAL_TRAILING" | "NONE" = "NONE";

  if (regime === "RANGE") {
    profitManagementMode = "FIXED_TP";
    const authTp =
      typeof decision.takeProfit === "number" && Number.isFinite(decision.takeProfit) && decision.takeProfit !== 0
        ? decision.takeProfit
        : typeof authority.takeProfit1Px === "number" &&
            Number.isFinite(authority.takeProfit1Px) &&
            authority.takeProfit1Px !== 0
          ? authority.takeProfit1Px
          : null;

    if (authTp != null) {
      const isAuthTpValidDirection =
        side === "long" ? authTp > referenceEntryPx : authTp < referenceEntryPx;
      if (isAuthTpValidDirection) {
        finalTpPrice = authTp;
        finalTpSource = "authority_tp_price";
      } else {
        logger.warn("V2_EXIT_PLAN_AUTHORITY_TP_REJECTED", {
          symbol,
          side,
          rejectedTpPrice: authTp,
          reason: "range_tp_wrong_direction"
        });
      }
    }

    if (finalTpPrice == null) {
      policyTpPrice = engineMirrorTpPrice(referenceEntryPx, side, regime);
      if (policyTpPrice != null) {
        const isPolicyTpValidDirection =
          side === "long" ? policyTpPrice > referenceEntryPx : policyTpPrice < referenceEntryPx;
        if (isPolicyTpValidDirection) {
          finalTpPrice = policyTpPrice;
          finalTpSource = "engine_calculated";
        }
      }
    }

    if (finalTpPrice == null) {
      return { ok: false, reason: "range_tp_missing" };
    }
  } else if (regime === "TREND") {
    profitManagementMode = "PARTIAL_TRAILING";
    finalTpPrice = null;
    finalTpSource = "none";
  }

  let takeProfitDistancePct: number | null = null;
  let riskRewardRatio: number | null = null;

  const risk = Math.abs(referenceEntryPx - finalStopPrice);
  if (finalTpPrice != null && risk > 0) {
    const reward = Math.abs(finalTpPrice - referenceEntryPx);
    takeProfitDistancePct = (reward / referenceEntryPx) * 100;
    riskRewardRatio = reward / risk;
  }

  if (regime === "RANGE" && (riskRewardRatio == null || riskRewardRatio <= 0)) {
    return { ok: false, reason: "range_invalid_rr" };
  }

  logger.info("V2_EXIT_PLAN_AUTHORITY_PROOF", {
    symbol,
    side,
    regime,
    entryPrice: referenceEntryPx,
    rawInvalidationPx: rawSp.price,
    policyStopPrice: policySl,
    finalStopPrice,
    stopSource: finalStopSource,
    policyTakeProfitPrice: policyTpPrice,
    finalTakeProfitPrice: finalTpPrice,
    takeProfitSource: finalTpSource,
    rawStopDistancePct,
    finalStopDistancePct,
    takeProfitDistancePct,
    riskRewardRatio,
    stopClampApplied: clampApplied,
    stopClampReason: clampApplied ? "invalidation_too_close" : null,
    tpRequired: regime === "RANGE",
    authorityOwner: "V2PreEntryRiskPlanCommitted",
    tp_direction_valid: finalTpPrice != null,
    authority_tp_rejected: finalTpSource === "engine_calculated" && finalTpPrice != null,
    final_tp_source: finalTpSource,
    profit_management_mode: profitManagementMode
  });

  return {
    ok: true,
    plan: {
      side,
      reference_entry_px: referenceEntryPx,
      stop_price: finalStopPrice,
      initial_tp_price: finalTpPrice,
      risk_distance: risk,
      protection_required: true,
      stop_source: finalStopSource,
      take_profit_source: finalTpSource,
      stop_distance_pct: finalStopDistancePct,
      take_profit_distance_pct: takeProfitDistancePct,
      risk_reward_ratio: riskRewardRatio
    }
  };
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
  private readonly okxPublic: OkxDemoClient;
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
  /** 鍮꾩쁺?? 理쒓렐 ?깅퀎 `decision_funnel_tick` ?ㅻ깄??(理쒕? DECISION_FUNNEL_RING_MAX). */
  private decisionFunnelTickRing: DecisionFunnelTick[] = [];
  /** 鍮꾩쁺?? Stage 1 吏꾩엯 寃??SKIP) 以묒씤 ?щ낵??泥대쪟 ?쒓컙 諛??덉쭏 異붿쟻 */
  /** 鍮꾩쁺?? Stage 1 吏꾩엯 寃€??SKIP) 以묒씤 ?щ낵??泥대쪟 ?쒓컙 諛??덉쭏 異붿쟻 */
  private reviewingState = new Map<string, { ticks: number; initialQuality: number; lastQuality: number }>();
  private lastMarketMode: MarketModeSelectorOutput | null = null;
  private lastRiskExposure: RiskExposureOutput | null = null;
  private lastExplanation: PaperExplanationFields | null = null;
  private rangeRuntimeBySymbol = new Map<string, { lastZone: RangeBoxZone | null; cycle: number; ladder: number }>();
  private trendBreakoutBySymbol = new Map<string, TrendBreakoutDirection>();
  private trendHoldMemoryBySymbol = new Map<string, import("../models/types").TrendBreakoutHoldMemory>();
  private trendPyramidLevelBySymbol = new Map<string, number>();
  private rangeRecheckPromotionByKey = new Map<string, {
    ticks: number;
    side: "long" | "short";
    zone: RangeBoxZone;
    lastQualityScore: number;
    lastRangeConfidence: number;
    lastPrice: number;
    updatedAt: number;
  }>();
  private v2RecoveryActiveBySymbol = new Map<string, { 
    side: string; 
    ts: number; 
    missedLimitFillCount: number; 
    lastEntryIntentSide: string; 
    originalLimitPrice?: number;
  }>();
  /** RANGE ?듭젅 ???ъ쭊??荑⑤떎???고쉶 ?먮떒??留뚮즺 ?쒓컖). */
  private rangeReopenArmedUntilBySymbol = new Map<string, number>();
  /** 吏곸쟾 ??`evaluateRangeEngineForSymbol` 寃곌낵(吏꾩엯 ?ш린쨌?섎뜑 ?곕룞). */
  private lastTickRangeEvalBySymbol = new Map<string, ReturnType<typeof evaluateRangeEngineForSymbol>>();
  private lastTickSymbolSnapshotBySymbol = new Map<string, SymbolSnapshot | null>();
  private rangeReversalImmediateSwitchForSymbol = new Map<string, RangeReversalImmediateSwitchArg>();
  private rangeReversalSwitchPendingBySymbol = new Map<string, RangeReversalSwitchPending>();
  /** TREND ?ㅼ쐞移??쒓컖(1h 移댁슫????selector). */
  private trendSwitchTimestampsMs: number[] = [];
  /** RANGE ?ъ쭊???깃났 ?쒓컖(?덈룄 ???잛닔 ?쒗븳). */
  private rangeReopenTimestampsBySymbol = new Map<string, number[]>();
  private trendFollowScoreBySymbol = new Map<string, number>();
  private trendBreakoutConfidenceBySymbol = new Map<string, number>();
  private rangeRoundTripStreakBySymbol = new Map<string, number>();
  /** Consecutive close-eval ticks with raw box break (for EXIT_RANGE_REBALANCE debounce). */
  private rangeBoxBreakConsecutiveBySymbol = new Map<string, number>();
  /** RANGE ?섏씡沅?異붿쥌: ?щ낵:openedAt ???쇳겕쨌?좉툑 (諛뺤뒪 ?댄깉 由щ갭?곗뒪 吏?곗슜). */
  private rangeProfitTrailByKey = new Map<string, RangeProfitTrailState>();
  /** RANGE upper short add-on: per-position one-shot guard (symbol:openedAt -> count). */
  private rangeUpperShortAddOnCountByKey = new Map<string, number>();
  private rangeRecentOutcomeScoresBySymbol = new Map<string, number[]>();
  /** ?μ꽭 遺?곹빀 醫낅즺(EXIT_REGIME) ?뚮え ?대젰. ?숈씪 ?먮쫫 ??諛섎났 吏꾩엯/醫낅즺 諛⑹?. */
  private regimeExitConsumedBySymbol = new Map<string, { side: "long" | "short"; ts: number }>();
  /** RANGE edge stop_loss ?ъ쭊??李⑤떒??硫붾え由?留? */
  private rangeStopReentryBlockedBySymbol = new Map<string, RangeStopReentryBlock>();
  private lastExitReasonLabel = "";
  private lastSwitchReasonLabel = "";
  /** 吏곸쟾 ??援ш컙 諛섏쟾 泥?궛 ?곸슜(PEL proof?? */
  private rangeReversalExitThisTickBySymbol = new Map<
    string,
    { range_existing_long_reversal_exit_applied?: boolean; range_existing_short_reversal_exit_applied?: boolean }
  >();

  /**
   * Flow-based one-shot deduplication for terminal exits (EXIT_REGIME, EXIT_SL, EXIT_TIME_STOP).
   * Key: `${symbol}:${side}:${openedAt}`
   */
  private readonly terminalExitConsumedByFlow = new Set<string>();
  /** symbol:side -> true if OKX actual position exists but not in paper ledger. */
  private readonly symbolExternalManualBlocked = new Set<string>();
  /** symbol -> true if protective stop order failed to register; block further entries. */
  private readonly symbolProtectionFailedBlocked = new Set<string>();
  /** Deduplication for V2 exit authority proof logs. Key: `${symbol}_${side}` */
  private lastV2ExitAuthorityProofBySymbol = new Map<string, string>();
  /** Manual close cooldown to prevent immediate re-entry. Key: symbol */
  private manualCloseCooldownBySymbol = new Map<string, { side: "long" | "short"; until: number }>();
  /** Cached active algo orders from exchange for auto-repair logic. */
  private cachedOpsAlgos: any[] = [];
  private instrumentCache = new Map<string, OkxSwapInstrumentSizing>();
  private lastInstrumentCacheUpdateAt = 0;
  private readonly instrumentCacheTTL = 3600_000; // 1 hour

  private readonly okxDemo: OkxDemoClient | null;
  private okxAccountConfigLoaded = false;
  private okxDemoKeysLoaded = false;
  private okxSignedRestReady = false;
  private okxAccountConfigOk = false;
  private okxBalanceOk = false;
  private okxPositionsOk = false;
  private okxOrderSubmitOk = false;
  private okxSmokeTestPerformed = false;
  private okxWalletBalanceUsdt: number | null = null;
  private okxAvailableBalanceUsdt: number | null = null;
  private liveBalanceReady = false;
  private liveBalanceBlockReason: string | null = null;
  private liveBalanceFetchError: string | null = null;
  private lastLiveBalancePayload: Record<string, unknown> | null = null;
  private lastLivePositionsPayload: ReadonlyArray<Record<string, unknown>> | null = null;
  private lastSignedRestError: string | null = null;
  private lastSignedRestSuccessAt: number | null = null;
  private lastSignedRestFailAt: number | null = null;
  private runCycleId = 0;
  private paperExecutionReady = false;
  private paperExecutionReadyChangedAt: number | null = null;
  private signedExecutionReady = false;
  private signedExecutionReadyChangedAt: number | null = null;
  private freshTickRequiredAfterReadiness = false;
  private readinessTransitionCycleId: number | null = null;
  private staleEntryDroppedCount = 0;
  /** barrier hit 시 V2 ENTER 후보를 다음 사이클 재검증까지 보존 (심볼별 1개, Map dedupe) */
  private v2DeferredEntryQueue: Map<string, {
    snapshot: SymbolSnapshot;
    deferredAtCycleId: number;
    deferredAtMs: number;
    symbol: string;
    side: "long" | "short";
    stageMarginKrw: number;
    stopPrice: number | null;
    stopPriceValid: boolean;
    decisionId: string | null;
    barrierReason: string;
  }> = new Map();
  private lastEntryEvaluatedAt: number | null = null;
  private lastEntrySignalFetchedAt: number | null = null;
  private readinessFreshTickCompletedCycles = 0;
  private readinessFreshTickRequiredCycles = 2;
  private readinessFreshTickLastFetchedAt: number | null = null;
  private readinessFreshTickLastCandleTs: number | null = null;
  private contaminatedEntrySamples: EntryQualitySample[] = [];
  private lastEntryQualitySamples = {
    profit: [] as EntryQualitySample[],
    loss: [] as EntryQualitySample[],
    contaminated: [] as EntryQualitySample[]
  };
  private lastEntryQualitySampleSourceBreakdown = {
    history_profit_samples: 0,
    history_loss_samples: 0,
    events_profit_samples: 0,
    events_loss_samples: 0,
    contaminated_samples: 0,
    total_sample_count: 0
  };
  private engineLastTickAt: number | null = null;
  private marketDataLastUpdateAt: number | null = null;
  private v2LastDecisionAt: number | null = null;
  private bundleLastWrittenAt: number | null = null;
  /** Main loop scheduling (mirrors `src/loop.ts` + ORBITALPHA_PAPER_LOOP_INTERVAL_MS). */
  private loopIntervalTargetMs = 10_000;
  private lastLoopDurationMs: number | null = null;
  private lastLoopStartedAt: number | null = null;
  private lastLoopFinishedAt: number | null = null;
  private loopDelayReason: string | null = null;
  private publicMarketDataReady = false;
  private v2JudgmentReady = false;
  private positionTrackingAlive = false;
  private bundleWriterReady = false;
  private entryPipelineReady = false;
  private exitPipelineReady = false;
  private serverTradeControlState: ServerTradeControlState = {
    server_trade_enabled: false,
    close_only_mode: false,
    kill_switch_active: false,
    authority_source: "server_state",
    updated_at: 0,
    reason: null
  };
  private readonly executionKeysConsumed = new Set<string>();
  private historyDirty = true;
  private bundleDirty = true;
  private lastHistoryRefreshAt = 0;
  private lastBundleWriteAt = 0;
  private cachedHistory: PaperClosedPositionRecord[] = [];

  private executionKeysLoaded = false;
  private lastServerTradeControlSignature: string | null = null;
  /** When server trade flips disabled?뭪rue; stale-gate for authority/snapshot timestamps. */
  private serverTradeEnabledTrueAt: number | null = null;
  private lastObservedServerTradeEnabled = false;
  private reconcileSafetyCloseOnly = false;
  private reconcileLastCheckedAt: number | null = null;
  private reconcileLastMismatchReason: string | null = null;
  private readonly reconcileCheckIntervalMs = 30_000;
  private startupRecoveryBarrierApplied = false;

  /** OKX swap pending orders cache ??diagnostics only; never auto-submits protective orders (stage 1). */
  private lastOpsOrdersScanAtMs = 0;
  private readonly opsOrdersScanMinIntervalMs = 10_000;
  private opsOrdersScanEverDone = false;
  private cachedOpsPending: Record<string, unknown>[] = [];
  private cachedOpsFetchErrors: string[] = [];
  private lastPositionOpsSurface: PositionOpsSurface | null = null;
  private positionExitProofThrottleByFlow = new Map<string, number>();

  private tradeControlPath(): string {
    return path.resolve(this.config.dataDir, "control/trade-control.json");
  }

  private executionKeysPath(): string {
    return path.resolve(this.config.dataDir, "reports/execution-keys.json");
  }

  private async loadServerTradeControlState(nowTs: number): Promise<void> {
    const p = this.tradeControlPath();
    try {
      const raw = await fs.readFile(p, "utf8");
      const parsed = JSON.parse(raw) as Partial<ServerTradeControlState>;
      const camel = parsed as {
        serverTradeEnabled?: unknown;
        closeOnlyMode?: unknown;
        killSwitch?: unknown;
        updatedAt?: unknown;
        reason?: unknown;
      };
      this.serverTradeControlState = {
        server_trade_enabled:
          typeof camel.serverTradeEnabled === "boolean"
            ? camel.serverTradeEnabled
            : parsed.server_trade_enabled === true,
        close_only_mode:
          typeof camel.closeOnlyMode === "boolean"
            ? camel.closeOnlyMode
            : parsed.close_only_mode === true,
        kill_switch_active:
          typeof camel.killSwitch === "boolean"
            ? camel.killSwitch
            : parsed.kill_switch_active === true,
        authority_source: "server_state",
        updated_at:
          typeof camel.updatedAt === "number" && Number.isFinite(camel.updatedAt)
            ? camel.updatedAt
            : (typeof parsed.updated_at === "number" && Number.isFinite(parsed.updated_at) ? parsed.updated_at : nowTs),
        reason: typeof camel.reason === "string" ? camel.reason : (typeof parsed.reason === "string" ? parsed.reason : null),
        instructions: Array.isArray(parsed.instructions) ? parsed.instructions : undefined
      };
    } catch {
      this.serverTradeControlState = {
        server_trade_enabled: false,
        close_only_mode: false,
        kill_switch_active: false,
        authority_source: "server_state",
        updated_at: nowTs,
        reason: "default_off_until_operator_enable"
      };
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(
        p,
        JSON.stringify({
          serverTradeEnabled: this.serverTradeControlState.server_trade_enabled,
          closeOnlyMode: this.serverTradeControlState.close_only_mode,
          killSwitch: this.serverTradeControlState.kill_switch_active,
          updatedAt: this.serverTradeControlState.updated_at,
          updatedBy: "engine_bootstrap",
          reason: this.serverTradeControlState.reason
        }, null, 2),
        "utf8"
      );
    }
  }

  private async ensureExecutionKeysLoaded(): Promise<void> {
    if (this.executionKeysLoaded) return;
    const p = this.executionKeysPath();
    try {
      const raw = await fs.readFile(p, "utf8");
      const parsed = JSON.parse(raw) as { consumed?: string[] };
      for (const k of parsed.consumed ?? []) {
        if (typeof k === "string" && k.trim() !== "") this.executionKeysConsumed.add(k);
      }
    } catch {
      // empty bootstrap
    }
    this.executionKeysLoaded = true;
  }

  private async consumeExecutionKey(key: string): Promise<boolean> {
    if (key.trim() === "") return false;
    await this.ensureExecutionKeysLoaded();
    if (this.executionKeysConsumed.has(key)) {
      this.logger.warn("EXECUTION_KEY_DUPLICATE_BLOCKED", { execution_key: key });
      return false;
    }
    this.executionKeysConsumed.add(key);
    const p = this.executionKeysPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    const consumed = Array.from(this.executionKeysConsumed).slice(-4000);
    await fs.writeFile(p, JSON.stringify({ updated_at: Date.now(), consumed }, null, 2), "utf8");
    return true;
  }

  private currentServerTradeControlSignature(): string {
    return [
      this.serverTradeControlState.server_trade_enabled ? "1" : "0",
      this.serverTradeControlState.close_only_mode ? "1" : "0",
      this.serverTradeControlState.kill_switch_active ? "1" : "0",
      String(this.serverTradeControlState.updated_at ?? 0),
      String(this.serverTradeControlState.reason ?? "")
    ].join("|");
  }

  private clearPendingDecisionState(reason: string, changedAt: number, authoritySource: string): void {
    const dropped = {
      reviewing_state: this.reviewingState.size,
      last_tick_range_eval: this.lastTickRangeEvalBySymbol.size,
      last_tick_symbol_snapshot: this.lastTickSymbolSnapshotBySymbol.size,
      range_reversal_switch_pending: this.rangeReversalSwitchPendingBySymbol.size,
      had_last_entry_decision: this.lastEntryDecision != null
    };
    this.reviewingState.clear();
    this.lastTickRangeEvalBySymbol.clear();
    this.lastTickSymbolSnapshotBySymbol.clear();
    this.rangeReversalSwitchPendingBySymbol.clear();
    this.lastEntryDecision = null;
    this.readinessFreshTickCompletedCycles = 0;
    this.readinessFreshTickLastFetchedAt = null;
    this.readinessFreshTickLastCandleTs = null;
    const droppedCount =
      dropped.reviewing_state +
      dropped.last_tick_range_eval +
      dropped.last_tick_symbol_snapshot +
      dropped.range_reversal_switch_pending +
      (dropped.had_last_entry_decision ? 1 : 0);
    this.staleEntryDroppedCount += droppedCount;
    this.logger.warn("PENDING_DECISION_STATE_DROPPED", {
      reason,
      changed_at: changedAt,
      authority_source: authoritySource,
      dropped,
      dropped_count: droppedCount,
      stale_entry_dropped_count_total: this.staleEntryDroppedCount
    });
  }

  private evaluateServerTradeControlTransition(nowTs: number): void {
    const nextSig = this.currentServerTradeControlSignature();
    const enabledNow = this.serverTradeControlState.server_trade_enabled === true;
    if (this.lastServerTradeControlSignature == null) {
      this.lastServerTradeControlSignature = nextSig;
      this.lastObservedServerTradeEnabled = enabledNow;
      return;
    }
    if (this.lastServerTradeControlSignature === nextSig) {
      this.lastObservedServerTradeEnabled = this.serverTradeControlState.server_trade_enabled === true;
      return;
    }
    const enabledBefore = this.lastObservedServerTradeEnabled === true;
    this.lastServerTradeControlSignature = nextSig;
    this.freshTickRequiredAfterReadiness = true;
    const transitionReason =
      !enabledBefore && enabledNow ? "server_trade_enabled_true" : "server_trade_control_transition";
    if (!enabledBefore && enabledNow) {
      this.serverTradeEnabledTrueAt = nowTs;
    }
    this.clearPendingDecisionState(transitionReason, nowTs, this.serverTradeControlState.authority_source);
    this.lastObservedServerTradeEnabled = enabledNow;
    this.logger.warn("SERVER_TRADE_CONTROL_TRANSITION_APPLIED", {
      server_trade_enabled: this.serverTradeControlState.server_trade_enabled,
      close_only_mode: this.serverTradeControlState.close_only_mode,
      kill_switch_active: this.serverTradeControlState.kill_switch_active,
      authority_source: this.serverTradeControlState.authority_source,
      updated_at: this.serverTradeControlState.updated_at,
      reason: this.serverTradeControlState.reason,
      transition_reason: transitionReason,
      server_trade_enabled_true_at: this.serverTradeEnabledTrueAt
    });
  }

  private applyStartupRecoveryBarrier(nowTs: number): void {
    if (this.startupRecoveryBarrierApplied) return;
    this.startupRecoveryBarrierApplied = true;
    this.freshTickRequiredAfterReadiness = true;
    this.clearPendingDecisionState("process_restart_recovery_barrier", nowTs, "server_state");
    this.logger.warn("STARTUP_RECOVERY_ENTRY_BARRIER_APPLIED", {
      run_cycle_id: this.runCycleId,
      reason: "restart_recovery_requires_fresh_tick_reevaluation",
      fresh_tick_required_cycles: this.readinessFreshTickRequiredCycles,
      authority_source: "server_state"
    });
  }

  private async updateInstrumentCache(): Promise<void> {
    const now = Date.now();
    if (now - this.lastInstrumentCacheUpdateAt < this.instrumentCacheTTL && this.instrumentCache.size > 0) return;
    if (!this.okxPublic) return;

    try {
      const res = await this.okxPublic.getInstruments("SWAP");
      if (res.ok && Array.isArray(res.value)) {
        for (const inst of res.value) {
          const row = inst as Record<string, unknown>;
          const iid = row.instId != null ? String(row.instId) : "";
          const sizing = parseOkxSwapInstrumentSizing(row);
          if (iid && sizing) {
            this.instrumentCache.set(iid, sizing);
          }
        }
        this.lastInstrumentCacheUpdateAt = now;
        this.logger.info("OKX_INSTRUMENT_CACHE_UPDATED", { count: this.instrumentCache.size });
      }
    } catch (e) {
      this.logger.error("OKX_INSTRUMENT_CACHE_UPDATE_FAIL", { error: String(e) });
    }
  }

  private async refreshPendingOrdersSnapshot(nowTs: number): Promise<void> {
    const canScan =
      Boolean(this.okxDemo && this.signedExecutionReady) &&
      nowTs - this.lastOpsOrdersScanAtMs >= this.opsOrdersScanMinIntervalMs;

    if (canScan && this.okxDemo) {
      this.lastOpsOrdersScanAtMs = nowTs;
      this.opsOrdersScanEverDone = true;
      this.cachedOpsFetchErrors = [];

      const [pendRes, algoRes] = await Promise.all([
        this.okxDemo.getOrdersPending({ instType: "SWAP" }),
        this.okxDemo.getOrdersAlgoPending({ instType: "SWAP" })
      ]);

      if (pendRes.ok) this.cachedOpsPending = pendRes.value ?? [];
      else {
        this.cachedOpsPending = [];
        this.cachedOpsFetchErrors.push(`orders_pending:${pendRes.error}`);
      }
      if (algoRes.ok) this.cachedOpsAlgos = algoRes.value ?? [];
      else {
        this.cachedOpsAlgos = [];
        this.cachedOpsFetchErrors.push(`orders_algos_pending:${algoRes.error}`);
      }
    }
  }

  /**
   * Post-entry watch: OKX positions vs ledger, protective SL+TP proof on reduce-only algos,
   * hard-blocks new entries when exposure is unprotected, and runs `ensureProtectiveStopOrder`
   * every successful order scan so missing protection is repaired with real OKX submits.
   */
  private async runPositionOperationsWatch(nowTs: number, paperOpens: ReadonlyArray<PaperOpenPositionRecord>): Promise<void> {
    await this.updateInstrumentCache();
    const syncSnap = buildLedgerOkxPositionSyncSnapshot(paperOpens, this.lastLivePositionsPayload, this.instrumentCache);

    this.symbolExternalManualBlocked.clear();
    const currentRunBlockedSymbols = new Set<string>();
    
    // Clear protection block for symbols that are now clean (no ledger pos AND no exchange pos)
    for (const sym of this.symbolProtectionFailedBlocked) {
      const inLedger = paperOpens.some(p => p.symbol === sym);
      const inExchange = (this.lastLivePositionsPayload as any[] ?? []).some(r => {
        const hit = okxSwapRowToLedgerKey(r);
        return hit && hit.symbol === sym;
      });
      if (!inLedger && !inExchange) {
        this.logger.info("PROTECTION_FAILURE_BLOCK_CLEARED", { symbol: sym, reason: "position_zeroed" });
        this.symbolProtectionFailedBlocked.delete(sym);
      }
    }
    if (this.lastLivePositionsPayload && Array.isArray(this.lastLivePositionsPayload)) {
      for (const row of this.lastLivePositionsPayload) {
        const hit = okxSwapRowToLedgerKey(row as Record<string, unknown>);
        if (!hit) continue;
        const key = hit.key; // symbol:side
        
        // Block if not in ledger OR if in ledger as EXTERNAL_MANUAL_POSITION
        const isNormalInLedger = paperOpens.some(p => 
          `${p.symbol}:${p.side}` === key && 
          (p.lifecycleState !== "EXTERNAL_MANUAL_POSITION" || 
           (p.reconcileState === "MATCHED" && syncSnap.sync_status === "ALIGNED"))
        );

        if (!isNormalInLedger) {
          if (!this.symbolExternalManualBlocked.has(key)) {
            this.symbolExternalManualBlocked.add(key);
            this.logger.warn("SYMBOL_EXTERNAL_MANUAL_POSITION_BLOCK", {
              symbol: hit.symbol,
              side: hit.side,
              okx_position_exists: true,
              source: "okx_actual_or_external_manual",
              action: "BLOCK_THIS_SYMBOL_ONLY",
              global_trade_blocked: false,
              detail: "Position exists on OKX but is not a normal paper-ledger position. Blocking entries for this symbol:side."
            });
          }
        }
      }
    }

    // Also include keys from sync mismatch in symbol-level block
    for (const mk of syncSnap.mismatched_keys) {
      const [msym, mside] = mk.split(":");
      const paperRow = paperOpens.find(p => `${p.symbol}:${p.side}` === mk);
      const okxRow = syncSnap.okx_positions_preview.find(rv => `${rv.symbol}:${rv.side}` === mk);

      if (!this.symbolExternalManualBlocked.has(mk)) {
        this.symbolExternalManualBlocked.add(mk);
        this.logger.warn("SYMBOL_EXTERNAL_MANUAL_POSITION_BLOCK_INITIAL", {
          symbol: msym,
          side: mside,
          sync_status: syncSnap.sync_status,
          action: "BLOCK_AUTOMATED_MANAGEMENT",
          detail: `Sync mismatch (${syncSnap.sync_status}) detected. Enforcing initial manual reconciliation block for ${mk}.`
        });
      }

      // Per-tick audit log for mismatched state
      this.logger.warn("V2_POSITION_INTEGRITY_MISMATCH_TICK_AUDIT", {
        symbol: msym,
        side: mside,
        sync_status: syncSnap.sync_status,
        delta: {
          paper_notional: paperRow?.notionalUsd ?? paperRow?.sizeUsd ?? 0,
          okx_notional: okxRow?.notionalUsd ?? 0,
          paper_price: paperRow?.entryPrice ?? 0,
          okx_price: okxRow?.avgPx ?? 0,
          paper_contracts: paperRow?.okxContracts ?? 0,
          okx_contracts: okxRow?.okxContracts ?? 0,
          notional_diff: (okxRow?.notionalUsd ?? 0) - (paperRow?.notionalUsd ?? paperRow?.sizeUsd ?? 0),
          price_diff_ratio: paperRow?.entryPrice ? ((okxRow?.avgPx ?? 0) - paperRow.entryPrice) / paperRow.entryPrice : 0
        },
        reconcile_state: paperRow?.reconcileState ?? "unknown",
        lifecycle_state: paperRow?.lifecycleState ?? "unknown"
      });
    }

    const unblockedMismatches = syncSnap.mismatched_keys.filter(mk => !this.symbolExternalManualBlocked.has(mk));
    const hasUnblockedMismatch = unblockedMismatches.length > 0;

    const ignoredStatuses = new Set<string>([
      "ALIGNED", 
      "REMOTE_UNAVAILABLE", 
      "LEDGER_ONLY", 
      "OKX_ONLY", 
      "KEY_MISMATCH", 
      "NOTIONAL_MISMATCH", 
      "AVG_PRICE_MISMATCH", 
      "SIZE_MISMATCH", 
      "MANUAL_PARTIAL_DETECTED", 
      "MANUAL_FULL_CLOSE_DETECTED", 
      "ADOPTED_POSITION_SIZE_MISMATCH", 
      "ADOPTED_POSITION_MANUAL_PARTIAL_DETECTED", 
      "EXTERNAL_MANUAL_LARGE_DRIFT", 
      "EXTERNAL_MANUAL_MISMATCH_IGNORED"
    ]);

    const criticalMismatch = 
      hasUnblockedMismatch &&
      !ignoredStatuses.has(syncSnap.sync_status);

    if (criticalMismatch) {
      this.reconcileSafetyCloseOnly = true;
      this.reconcileLastMismatchReason = `sync_watch_${syncSnap.sync_status}`;
    } else {
      // If we previously set safe mode via sync_watch but it's now recovered to a non-critical state,
      // allow clearing it. Serious mismatches from runPositionStateReconciliation (auth check) 
      // will still persist until the next 30s auth-check runs.
      if (this.reconcileSafetyCloseOnly && this.reconcileLastMismatchReason?.startsWith("sync_watch_")) {
        this.logger.info("POSITION_RECONCILE_WATCH_RECOVERED", { 
          sync_status: syncSnap.sync_status,
          prev_reason: this.reconcileLastMismatchReason 
        });
        this.reconcileSafetyCloseOnly = false;
        this.reconcileLastMismatchReason = null;
      }
    }


    await this.refreshPendingOrdersSnapshot(nowTs);

    if (this.okxDemo && this.opsOrdersScanEverDone) {
      const okxActualFlat: Record<string, unknown>[] = [];
      if (this.lastLivePositionsPayload && Array.isArray(this.lastLivePositionsPayload)) {
        for (const row of this.lastLivePositionsPayload) {
          const hit = okxSwapRowToLedgerKey(row as Record<string, unknown>);
          if (!hit) continue;
          const avgPxRaw = (row as Record<string, unknown>).avgPx;
          const avgPx =
            typeof avgPxRaw === "number"
              ? avgPxRaw
              : typeof avgPxRaw === "string"
                ? Number(avgPxRaw)
                : NaN;
          okxActualFlat.push({
            instId: hit.instId,
            symbol: hit.symbol,
            side: hit.side,
            pos: hit.posSigned,
            avgPx: Number.isFinite(avgPx) ? avgPx : null
          });
        }
      }

      this.logger.info("LEDGER_OKX_POSITION_SYNC_PROOF", {
        ts: nowTs,
        ...syncSnap
      });

      this.logger.info("OKX_ACTUAL_POSITION_PROOF", {
        ts: nowTs,
        okx_positions_payload_count: Array.isArray(this.lastLivePositionsPayload)
          ? this.lastLivePositionsPayload.length
          : 0,
        nonzero_positions: okxActualFlat
      });

      const surfaceScan = buildPositionOpsSurface({
        now: nowTs,
        paperOpens,
        okxPayload: this.lastLivePositionsPayload,
        pendingOrders: this.cachedOpsPending,
        algoOrders: this.cachedOpsAlgos,
        ordersScanPerformed: true,
        ordersScanErrors: this.cachedOpsFetchErrors,
        instrumentByInstId: this.instrumentCache
      });

      this.logger.info("POSITION_PROTECTION_STATE_PROOF", {
        ts: nowTs,
        rows: surfaceScan.rows
      });

      this.logger.info("EMERGENCY_STOP_ORDER_STATUS_PROOF", {
        ts: nowTs,
        pending_swap_orders_count: this.cachedOpsPending.length,
        pending_algo_orders_count: this.cachedOpsAlgos.length,
        fetch_errors: this.cachedOpsFetchErrors,
        diag_note: "reduce_only_SL_TP_protection_enforced_submit_on_reconcile_and_ops_watch"
      });

      for (const r of surfaceScan.rows) {
        const scanClean = this.cachedOpsFetchErrors.length === 0;
        const liveExposure = Math.abs(r.okx_pos_signed) > 0;

        if (scanClean && liveExposure && r.matching_protective_pending_count === 0) {
          this.logger.error("POSITION_PROTECTIVE_PENDING_ZERO_FAULT", {
            ts: nowTs,
            symbol: r.symbol,
            side: r.side,
            inst_id: r.inst_id,
            pending_swap_orders_count: this.cachedOpsPending.length,
            pending_algo_orders_count: this.cachedOpsAlgos.length,
            matching_protective_pending_count: r.matching_protective_pending_count,
            tp_required: r.tp_required_for_exchange_protection,
            detail: "Live OKX swap exposure but zero reduce-only protective pending rows for this instId+posSide after a clean order scan."
          });
        }

        if (!r.reduce_only_protective_found) {
          this.symbolProtectionFailedBlocked.add(r.symbol);

          this.logger.error("POSITION_PROTECTIVE_ORDER_FAULT", {
            ts: nowTs,
            symbol: r.symbol,
            side: r.side,
            inst_id: r.inst_id,
            reference_entry_px: r.reference_entry_px,
            initial_stop_px_engine_mirror: r.initial_stop_px_engine_mirror,
            initial_tp_px_engine_mirror: r.initial_tp_px_engine_mirror,
            ledger_stop_px: r.ledger_stop_px,
            ledger_tp_px: r.ledger_tp_px,
            exchange_stop_px: r.exchange_stop_px,
            exchange_tp_px: r.exchange_tp_px,
            reduce_only_protective_found: false,
            matching_protective_pending_count: r.matching_protective_pending_count,
            pending_algo_orders_count: this.cachedOpsAlgos.length,
            tp_required: r.tp_required_for_exchange_protection,
            detail: "Policy requires reduce-only SL (+ TP when applicable) on OKX; exchange state does not satisfy full protection."
          });

          this.logger.error("POSITION_UNPROTECTED_HARD_BLOCK_DETECTED", {
            symbol: r.symbol,
            side: r.side,
            inst_id: r.inst_id,
            reconcile_state: r.reconcile_state,
            sync_status: r.sync_status,
            action: "HARD_BLOCK_NEW_ENTRIES",
            reason: "confirmed_unprotected_exposure_on_exchange"
          });
        } else if (this.symbolProtectionFailedBlocked.has(r.symbol)) {
          this.symbolProtectionFailedBlocked.delete(r.symbol);
          this.logger.info("POSITION_PROTECTION_VERIFIED_UNBLOCK", {
            symbol: r.symbol,
            side: r.side,
            exchange_stop_px: r.exchange_stop_px,
            exchange_tp_px: r.exchange_tp_px,
            reduce_only_protective_found: true,
            matching_protective_pending_count: r.matching_protective_pending_count,
            detail: "Protective SL+TP requirements satisfied on exchange. Clearing hard block."
          });
        }

        // [TASK_4 & TASK_7] Open order purpose classification and stale entry auto-cancel
        const algoForSymbol = (this as any).cachedOpsAlgos?.filter((a: any) => a.instId === r.inst_id) ?? [];
        const swapForSymbol = (this as any).cachedOpsPending?.filter((a: any) => a.instId === r.inst_id) ?? [];
        const allOpenOrders = [...algoForSymbol, ...swapForSymbol];

        if (allOpenOrders.length > 0) {
          for (const ord of allOpenOrders) {
            const isReduceOnly = ord.reduceOnly === "true" || ord.reduceOnly === true;
            const hasEngineClOrdId = ord.clOrdId && String(ord.clOrdId).length > 0;

            let purpose = "unknown";
            if (!isReduceOnly && hasEngineClOrdId) purpose = "entry-purpose";
            else if (isReduceOnly && hasEngineClOrdId) purpose = "protective-purpose";
            else if (isReduceOnly && !hasEngineClOrdId) purpose = "manual-reduce-purpose";
            else purpose = "manual-entry-purpose";

            this.logger.info("OKX_OPEN_ORDER_PURPOSE_CLASSIFY_PROOF", {
              symbol: r.symbol,
              ordId: ord.ordId,
              algoId: ord.algoId,
              clOrdId: ord.clOrdId,
              side: ord.side,
              posSide: ord.posSide,
              reduceOnly: isReduceOnly,
              purpose
            });

            if (purpose === "manual-reduce-purpose") {
              this.logger.info("MANUAL_REDUCE_ORDER_DETECTED_PROOF", { symbol: r.symbol, ordId: ord.ordId, side: ord.side });
            }

            if (!isReduceOnly && (ord.ordId || ord.algoId) && liveExposure) {
              this.logger.info("OKX_STALE_ENTRY_ORDER_CANCEL_ATTEMPT_PROOF", { symbol: r.symbol, ordId: ord.ordId, algoId: ord.algoId });
              try {
                if (ord.algoId) {
                  await this.okxDemo?.cancelAlgoOrder([{ instId: toOkxSwapInstId(r.symbol), algoId: ord.algoId }]);
                } else if (ord.ordId) {
                  await this.okxDemo?.cancelOrder(toOkxSwapInstId(r.symbol), ord.ordId);
                }
                this.logger.info("OKX_STALE_ENTRY_ORDER_CANCEL_PROOF", {
                  symbol: r.symbol,
                  ordId: ord.ordId,
                  algoId: ord.algoId,
                  side: ord.side,
                  reason: "position_already_exists_cancelling_stale_entry"
                });
              } catch (err) {
                this.logger.error("OKX_STALE_ENTRY_ORDER_CANCEL_FAIL_PROOF", {
                  symbol: r.symbol,
                  ordId: ord.ordId,
                  algoId: ord.algoId,
                  error: String(err)
                });
              }
            }
          }
        }

        const ledgerPos = paperOpens.find((p) => p.symbol === r.symbol && p.side === r.side);
        let ensureOutcome: { success: boolean; modified: boolean } | null = null;
        if (r.symbol === "BTCUSDT" && this.isBtcSuppressionTarget()) {
          await this.logAndSuppressBtcUsdtAction("ops_watch_protect_cycle", r.side, ["PROTECTIVE_ENSURE", "REDUCE", "PARTIAL"]);
        } else if (
          ledgerPos &&
          liveExposure &&
          ledgerPos.lifecycleState !== "FAILED" &&
          ledgerPos.reconcileState !== "RECONCILE_MISMATCH"
        ) {
          const pricingLast =
            r.okx_avg_px != null && r.okx_avg_px > 0 ? r.okx_avg_px : ledgerPos.entryPrice > 0 ? ledgerPos.entryPrice : undefined;
          const flowId = `ops_watch_protect_cycle:${r.symbol}:${r.side}:${nowTs}`;
          const res = await this.ensureProtectiveStopOrder(ledgerPos, flowId, pricingLast);
          ensureOutcome = { success: res.success, modified: res.modified };
          if (res.modified) {
            const idx = paperOpens.findIndex((p) => p.symbol === r.symbol && p.side === r.side);
            if (idx >= 0) {
              const nextArray = [...paperOpens];
              nextArray[idx] = res.record;
              await this.positions.saveOpenAll(nextArray);
              this.bundleDirty = true;
            }
          }
          if (res.success && res.record.isProtectiveStopRegistered) {
            this.symbolProtectionFailedBlocked.delete(r.symbol);
          } else if (!res.success) {
            this.symbolProtectionFailedBlocked.add(r.symbol);
            this.logger.error("PROTECTIVE_ORDER_SUBMIT_FAILED", {
              symbol: r.symbol,
              side: r.side,
              flowId,
              reconcile_state: ledgerPos.reconcileState,
              detail: "ensureProtectiveStopOrder reported failure during ops-watch protection cycle (see PROTECTIVE_STOP_SUBMIT_RESULT / TAKE_PROFIT_SUBMIT_RESULT)."
            });
            this.logger.error("POSITION_UNPROTECTED_HARD_BLOCK", {
              symbol: r.symbol,
              side: r.side,
              scope: "ops_watch_post_ensure",
              action: "HARD_BLOCK_NEW_ENTRIES",
              reason: "protective_order_submit_failed_or_incomplete"
            });
          }
        }

        if (!r.reduce_only_protective_found && ledgerPos) {
          this.logger.info("PROTECTIVE_STOP_MISSING_PROOF", {
            ts: nowTs,
            symbol: r.symbol,
            side: r.side,
            inst_id: r.inst_id,
            ledger_stop_px: r.ledger_stop_px,
            mirror_stop_px: r.initial_stop_px_engine_mirror,
            reduce_only_protective_found: false,
            consistency_check: "FAIL",
            pre_scan_fault: true,
            ensure_attempted: ensureOutcome != null,
            ensure_success: ensureOutcome?.success ?? false,
            ensure_modified: ensureOutcome?.modified ?? false
          });
        }
      }
    }

    this.lastPositionOpsSurface = buildPositionOpsSurface({
      now: nowTs,
      paperOpens,
      okxPayload: this.lastLivePositionsPayload,
      pendingOrders: this.cachedOpsPending,
      algoOrders: this.cachedOpsAlgos,
      ordersScanPerformed: this.opsOrdersScanEverDone,
      ordersScanErrors: [...this.cachedOpsFetchErrors],
      instrumentByInstId: this.instrumentCache
    });
  }

  private async logAndSuppressBtcUsdtAction(
    action: string,
    paperSide: string = "none",
    extraSuppressedActions: string[] = []
  ): Promise<void> {
    let okxActualSide = "none";
    if (this.lastLivePositionsPayload && Array.isArray(this.lastLivePositionsPayload)) {
      for (const p of this.lastLivePositionsPayload) {
        const hit = okxSwapRowToLedgerKey(p as Record<string, unknown>);
        if (hit && hit.symbol === "BTCUSDT") {
          okxActualSide = hit.side;
          break;
        }
      }
    }

    let resolvedPaperSide = paperSide;
    if (resolvedPaperSide === "none") {
      try {
        const opens = await this.positions.loadOpenAll();
        const paperBtcPos = opens.find((p: any) => p && p.symbol === "BTCUSDT");
        if (paperBtcPos) {
          resolvedPaperSide = String(paperBtcPos.side).toLowerCase();
        }
      } catch (e) {
        // Ignored
      }
    }

    const v2InferredSide = (this.lastRisk as any)?.v2InferredSide ?? okxActualSide;

    const baseSuppressed = [
      "ENTER",
      "ADDON",
      "CLOSE",
      "PARTIAL",
      "REDUCE",
      "REVERSE",
      "ORDER_SUBMIT",
      "HISTORY_WRITE",
      "LEDGER_PRUNE",
      "PROTECTIVE_ENSURE"
    ];
    const suppressedActions = Array.from(new Set([...baseSuppressed, ...extraSuppressedActions]));

    this.logger.warn("POSITION_SIDE_RECONCILE_PROTECTED", {
      symbol: "BTCUSDT",
      okx_actual_side: okxActualSide,
      paper_side: resolvedPaperSide,
      v2_inferred_side: v2InferredSide,
      protected_reason: `BTCUSDT execution suppressor - ${action} bypassed`,
      suppressed_actions: suppressedActions
    });
  }

  private isBtcSuppressionTarget(): boolean {
    return true;
  }

  private async runPositionStateReconciliation(nowTs: number): Promise<void> {
    if (this.reconcileLastCheckedAt != null && nowTs - this.reconcileLastCheckedAt < this.reconcileCheckIntervalMs) return;
    this.reconcileLastCheckedAt = nowTs;
    if (!this.okxDemo || !this.signedExecutionReady) return;

    const rawOpens = await this.positions.loadOpenAll();
    await this.updateInstrumentCache();
    const okxPosRes = await this.okxDemo.getPositions("SWAP");
    if (!okxPosRes.ok) {
      this.reconcileSafetyCloseOnly = true;
      this.reconcileLastMismatchReason = `remote_positions_unavailable:${okxPosRes.error}`;
      this.logger.error("POSITION_RECONCILE_MISMATCH_SAFE_MODE", { error: okxPosRes.error });
      return;
    }

    const okxPositions = okxPosRes.value;
    const effectiveCloseOnlyMode = this.serverTradeControlState.close_only_mode || this.reconcileSafetyCloseOnly;
    const remoteMap = new Map<string, { size: number; instId: string; posSide: string; avgPx: number; notionalUsd: number }>();
    for (const row of okxPositions) {
      const hit = okxSwapRowToLedgerKey(row as Record<string, unknown>);
      if (!hit) continue;
      const posSideRaw = String((row as any).posSide ?? "").toLowerCase();
      const instId = hit.instId;
      const inst = this.instrumentCache.get(instId);
      const ctVal = inst?.ctVal ?? 1;

      const baseSz = Math.abs(hit.posSigned) * ctVal;
      let nu = hit.notionalUsd;
      if ((!Number.isFinite(nu) || nu === 0) && hit.avgPx > 0 && baseSz > 0) {
        nu = baseSz * hit.avgPx;
      }

      remoteMap.set(hit.key, {
        size: baseSz,
        instId,
        posSide: posSideRaw,
        avgPx: hit.avgPx,
        notionalUsd: nu
      });
    }

    const next: PaperOpenPositionRecord[] = [];
    let ledgerModified = false;
    let mismatchCount = 0;
    const mismatchDetails: string[] = [];
    const untrackedFills: string[] = [];
    const RECONCILE_GRACE_PERIOD_MS = 30_000;

    const reconcileManualFullClose = async (open: PaperOpenPositionRecord, source: string) => {
      if (open.symbol === "BTCUSDT") {
        if (this.isBtcSuppressionTarget()) {
          await this.logAndSuppressBtcUsdtAction("reconcileManualFullClose", open.side, ["CLOSE", "close history write", "ledger prune"]);
          return;
        }
      }
      const snap = this.lastTickSymbolSnapshotBySymbol.get(open.symbol);
      const closePrice = snap?.lastPrice || open.entryPrice;
      const closedAt = nowTs;
      
      this.logger.warn("MANUAL_FULL_CLOSE_RECONCILE_PROOF", {
        symbol: open.symbol,
        side: open.side,
        lifecycle_state: open.lifecycleState,
        reconcile_state: open.reconcileState,
        close_price: closePrice,
        source,
        detail: "OPEN_LEDGER_MISSING_ON_EXCHANGE_REPAIRING",
        action: "RECORD_HISTORY_AND_PRUNE"
      });

      const metrics = computePaperCloseLegMetrics({
        open,
        closePrice,
        closedAt,
        snapFundingRate: snap?.fundingRate || 0,
        marginUsd: open.sizeUsd,
        paperTakerFeeRate: this.config.paperTakerFeeRate,
        paperFundingIntervalHours: this.config.paperFundingIntervalHours
      });

      const closedRow = finalizePaperClosedRecord({
        open,
        symbol: open.symbol as MarketSymbol,
        closePrice,
        closedAt,
        closeReason: "manual_full_close_reconciled",
        legMarginUsd: open.sizeUsd,
        metrics,
        feeRate: this.config.paperTakerFeeRate,
        fundingIntervalHours: this.config.paperFundingIntervalHours,
        strategyVersion: open.strategyVersion ?? "paper-v2"
      });

      await this.appendClosedWithStandardRouting({
        closedRow,
        open,
        flowId: `${open.symbol}:${open.side}:${open.openedAt}`,
        exitReason: "manual_full_close_reconciled",
        closeSource: source,
        currentRegime: this.lastRegime.regime || "NO_TRADE"
      });

      // [HARDENING] Manual close cooldown (5 min) to prevent immediate re-entry
      this.manualCloseCooldownBySymbol.set(String(open.symbol), {
        side: open.side,
        until: nowTs + 300_000
      });

      this.logger.info("MANUAL_CLOSE_REENTRY_GUARD_PROOF", {
        symbol: open.symbol,
        side: open.side,
        cooldown_until: nowTs + 300_000,
        reason: "manual_full_close_reconciled"
      });

      // Also cancel any stale entry-purpose open orders for this symbol to prevent unwanted re-entry
      if (this.okxDemo) {
         try {
             const instId = toOkxSwapInstId(open.symbol as MarketSymbol);
             const pendRes = await this.okxDemo.getOrdersPending({ instType: "SWAP", instId });
             if (pendRes.ok && pendRes.value) {
                 for (const ord of pendRes.value) {
                    const isReduceOnly = ord.reduceOnly === "true" || (ord as any).reduceOnly === true;
                    if (!isReduceOnly && ord.ordId) {
                        this.logger.info("OKX_STALE_ENTRY_ORDER_CANCEL_AFTER_MANUAL_CLOSE_PROOF", {
                            symbol: open.symbol,
                            ordId: ord.ordId,
                            side: ord.side,
                            posSide: ord.posSide
                        });
                        await this.okxDemo?.cancelOrder(toOkxSwapInstId(open.symbol as MarketSymbol), String(ord.ordId));
                    }
                 }
             }
         } catch (err) {
             this.logger.error("STALE_ENTRY_CANCEL_FAIL_AFTER_MANUAL_CLOSE", { symbol: open.symbol, error: String(err) });
         }
      }

      ledgerModified = true;
      if (open.lifecycleState !== "EXTERNAL_MANUAL_POSITION") {
        mismatchCount++;
      }
    };

    for (let open of rawOpens) {
      const isNew = nowTs - open.openedAt < RECONCILE_GRACE_PERIOD_MS;
      const isPending = open.lifecycleState === "PENDING_EXCHANGE_CONFIRM";
      const isClosePending = open.lifecycleState === "CLOSE_PENDING";
      const isPartialPending = open.lifecycleState === "PARTIAL_PENDING";
      
      const key = `${open.symbol}:${open.side}`;
      const remotePos = remoteMap.get(key);

      // --- ADOPTED FAMILY POSITION METADATA SYNC (Notional Alignment) ---
      const isAdoptedFamily =
        open.reconcileState === "ADOPTED" ||
        open.lifecycleState === "OKX_UNTRACKED_FILL" ||
        open.sourceSignal === "okx_reconcile_adopted" ||
        open.sourceSignal === "OPERATOR_ADOPTED";

      if (isAdoptedFamily && remotePos && remotePos.notionalUsd > 0) {
        const remoteNotional = Math.abs(remotePos.notionalUsd);
        const needsCurrentNotionalSync =
          Math.abs(open.sizeUsd - remoteNotional) > 0.5 ||
          !open.notionalUsd ||
          Math.abs(open.notionalUsd - remoteNotional) > 0.5;

        // Check if initialSizeUsd has not been synced yet (first-time correction for legacy/incorrect adoption)
        const isFirstTimeSync = !open.adoptedMetadataSyncedAt;

        if (needsCurrentNotionalSync || isFirstTimeSync) {
          open.sizeUsd = remoteNotional;
          open.notional = remoteNotional;
          open.notionalUsd = remoteNotional;
          if (remotePos.size > 0) {
            open.pos = remotePos.size;
            open.baseQty = remotePos.size;
          }

          // Fix initialSizeUsd ONLY on the very first sync
          if (isFirstTimeSync) {
            open.initialSizeUsd = remoteNotional;
            open.adoptedMetadataSyncedAt = nowTs;
          }

          ledgerModified = true;
          this.logger.info("LEDGER_OKX_POSITION_NOTIONAL_SYNCED_PROOF", {
            symbol: open.symbol,
            side: open.side,
            sync_reason: isFirstTimeSync ? "initial_and_current_notional_first_sync" : "current_notional_sync",
            okxNotionalUsd: remoteNotional,
            okxBaseQty: remotePos.size,
            initialSizeUsd: open.initialSizeUsd,
            adoptedMetadataSyncedAt: open.adoptedMetadataSyncedAt
          });
        }
      }

      // --- EXTERNAL MANUAL RESIDUE PRUNING (Quiet) ---
      // If OKX actual position is zero and paper open position exists as manual residue, prune it quietly.
      if (!remotePos && !isNew) {
        const isManualFlagged = open.lifecycleState === "EXTERNAL_MANUAL_POSITION";
        const isManualBlocked = this.symbolExternalManualBlocked.has(key);
        
        if (isManualFlagged || isManualBlocked) {
          const beforeCount = rawOpens.length;
          const afterCount = rawOpens.length - 1;

          this.logger.warn("EXTERNAL_MANUAL_POSITION_LEDGER_RESIDUE_PRUNED", {
            symbol: open.symbol,
            side: open.side,
            flowId: `${open.symbol}:${open.side}:${open.openedAt}`,
            reason: "okx_actual_position_zero_external_manual_residue",
            history_appended: false,
            okx_order_submitted: false,
            before_open_count: beforeCount,
            after_open_count: Math.max(0, afterCount)
          });
          ledgerModified = true;
          // Clear the block for this symbol to allow immediate re-entry if strategy permits
          this.symbolExternalManualBlocked.delete(key);
          continue; // Skip pushing to next, effectively pruning it.
        }
      }

      // 1. Handle Entry Pending States (Normalization)

      if (isPending || open.lifecycleState === "INITIAL" || !open.lifecycleState) {
        if (remotePos) {
          const instIdR = toOkxSwapInstId(open.symbol);
          const instR = this.instrumentCache.get(instIdR);
          const ctValR = instR?.ctVal ?? 1;
          const baseFromRemote = remotePos.size;
          let nuR = remotePos.notionalUsd;
          if ((!Number.isFinite(nuR) || nuR === 0) && remotePos.avgPx > 0 && baseFromRemote > 0) {
            nuR = baseFromRemote * remotePos.avgPx;
          }
          open.lifecycleState = "OPEN";
          open.reconcileState = "MATCHED";
          open.lastCheckedAt = nowTs;
          open.baseQty = baseFromRemote;
          open.pos = baseFromRemote;
          open.notionalUsd = Math.abs(nuR);
          if (ctValR > 0) {
            const contractsAbs = baseFromRemote / ctValR;
            open.okxContracts = contractsAbs;
            open.exchangeFilledSize = contractsAbs;
          }
          if (remotePos.avgPx > 0) {
            open.avgPx = remotePos.avgPx;
            open.entryPrice = remotePos.avgPx;
          }
          ledgerModified = true;
          this.logger.info("POSITION_OPEN_RECONCILE_PROOF", { symbol: open.symbol, side: open.side, status: "confirmed" });
          
          const protectRes = await this.ensureProtectiveStopOrder(open, `${open.symbol}:${open.side}:${open.openedAt}`);
          if (protectRes.modified) {
            open = protectRes.record;
          }
          if (!protectRes.success) {
            this.symbolProtectionFailedBlocked.add(open.symbol);
            this.logger.error("PROTECTIVE_ORDER_SUBMIT_FAILED", {
              symbol: open.symbol,
              side: open.side,
              flowId: `${open.symbol}:${open.side}:${open.openedAt}`,
              scope: "reconcile_position_opened",
              detail: "ensureProtectiveStopOrder failed right after OKX position became MATCHED (see PROTECTIVE_STOP_SUBMIT_RESULT)."
            });
            this.logger.error("POSITION_UNPROTECTED_HARD_BLOCK", {
              symbol: open.symbol,
              side: open.side,
              scope: "reconcile_post_open",
              action: "HARD_BLOCK_NEW_ENTRIES",
              reason: "protective_submit_failed_on_reconcile"
            });
          }

          this.logger.info("paper_position_opened", {
            symbol: open.symbol,
            side: open.side,
            source: open.sourceSignal,
            reconcile_confirmed: true,
            detected_at: nowTs,
            protected: open.isProtectiveStopRegistered === true
          });
        } else if (!isNew) {
          const exchangeOrdId = open.exchangeOrdId || "unknown";
          const elapsedMs = nowTs - open.openedAt;
          open.lifecycleState = "FAILED";
          open.reconcileState = "FAILED";
          open.lastCheckedAt = nowTs;
          ledgerModified = true;
          mismatchCount++;
          this.logger.error("POSITION_OPEN_CONFIRM_FAILED", {
            symbol: open.symbol,
            side: open.side,
            exchange_ord_id: exchangeOrdId,
            elapsed_ms: elapsedMs,
            open_ledger_removed: true,
            detail: "PENDING_TIMEOUT_NO_EXCHANGE_POSITION",
            action: "MARK_FAILED_AND_REMOVE"
          });
          continue; 
        } else {
          open.lifecycleState = "PENDING_EXCHANGE_CONFIRM";
          open.reconcileState = "PENDING";
          open.lastCheckedAt = nowTs;
          next.push(open);
          continue;
        }
      }

      // 2. Handle Exit/Partial Pending States (Atomic Reconciliation)
      if (isClosePending || isPartialPending) {
        const ordId = isClosePending ? open.closePendingOrdId : open.partialPendingOrdId;
        const clOrdId = isClosePending ? open.closePendingClOrdId : open.partialPendingClOrdId;
        const pendingAt = isClosePending ? open.closePendingAt : open.partialPendingAt;
        const PENDING_TIMEOUT_MS = 180_000;

        if (pendingAt && nowTs - pendingAt > PENDING_TIMEOUT_MS) {
          this.logger.warn("V2_PENDING_ORDER_TIMEOUT_PROOF", {
            symbol: open.symbol,
            side: open.side,
            lifecycle_state: open.lifecycleState,
            ord_id: ordId,
            pending_elapsed_ms: nowTs - pendingAt,
            action: "WATCH"
          });
        }

        if (!(ordId || clOrdId)) {
          if (!remotePos && !isNew) {
            await reconcileManualFullClose(open, "RECONCILE_ABSENT_PENDING_NO_ID");
            continue;
          }
          if (isPartialPending) {
            this.logger.warn("V2_PARTIAL_PENDING_MISSING_ORDER_IDS_RECOVER", {
              symbol: open.symbol,
              side: open.side,
              pending_at: pendingAt ?? null,
              detail: "no_ord_id_pollable_clearing_pending_shell"
            });
            open.lifecycleState = "OPEN";
            open.reconcileState = "MATCHED";
            open.lastCheckedAt = nowTs;
            open.partialPendingOrdId = undefined;
            open.partialPendingClOrdId = undefined;
            open.partialPendingSizeUsd = undefined;
            open.partialPendingOriginalSizeUsd = undefined;
            open.partialPendingProcessedFillSz = undefined;
            open.partialPendingProcessedUsd = undefined;
            open.partialPendingAt = undefined;
            open.partialPendingReduceRatio = undefined;
            open.partialPendingReason = undefined;
            open.partialPendingPrice = undefined;
            open.partialPendingFundingRate = undefined;
            if (remotePos && remotePos.avgPx > 0) {
              const instIdR = toOkxSwapInstId(open.symbol);
              const instR = this.instrumentCache.get(instIdR);
              const ctValR = instR?.ctVal ?? 1;
              const baseFromRemote = remotePos.size;
              let nuR = remotePos.notionalUsd;
              if ((!Number.isFinite(nuR) || nuR === 0) && remotePos.avgPx > 0 && baseFromRemote > 0) {
                nuR = baseFromRemote * remotePos.avgPx;
              }
              open.baseQty = baseFromRemote;
              open.pos = baseFromRemote;
              open.notionalUsd = Math.abs(nuR);
              if (ctValR > 0) {
                const cAbs = baseFromRemote / ctValR;
                open.okxContracts = cAbs;
                open.exchangeFilledSize = cAbs;
              }
              open.avgPx = remotePos.avgPx;
              open.entryPrice = remotePos.avgPx;
            }
            ledgerModified = true;
          } else if (isClosePending && pendingAt && nowTs - pendingAt > PENDING_TIMEOUT_MS && remotePos) {
            const prevEntryPx = open.entryPrice;
            const nextLifecycle = "EXTERNAL_MANUAL_POSITION";

            this.logger.warn("STALE_CLOSE_PENDING_REPAIRED_PROOF", {
              symbol: open.symbol,
              side: open.side,
              pending_elapsed_ms: nowTs - pendingAt,
              had_close_order_id: false,
              prev_entry_px: prevEntryPx,
              new_entry_px: remotePos.avgPx,
              action: "KEEP_POSITION_NO_HISTORY_APPEND_SYMBOL_BLOCK_ONLY"
            });

            this.logger.info("STALE_CLOSE_PENDING_EXTERNAL_POSITION_HELD_PROOF", {
              symbol: open.symbol,
              side: open.side,
              pending_elapsed_ms: nowTs - pendingAt,
              close_order_id_present: false,
              okx_position_exists: true,
              action: "KEEP_POSITION_NO_HISTORY_APPEND_SYMBOL_BLOCK_ONLY"
            });

            open.lifecycleState = nextLifecycle;
            open.reconcileState = "MATCHED";
            open.lastCheckedAt = nowTs;

            // Clear pending fields
            open.closePendingAt = undefined;
            open.closePendingReason = undefined;
            open.closePendingPrice = undefined;
            open.closePendingFundingRate = undefined;
            open.closePendingFilledSize = undefined;
            open.closePendingRemainingSize = undefined;
            open.closePendingOrdId = undefined;
            open.closePendingClOrdId = undefined;

            // Update to OKX actual
            open.entryPrice = remotePos.avgPx;
            open.avgPx = remotePos.avgPx;
            open.baseQty = remotePos.size;
            open.pos = remotePos.size;
            open.notionalUsd = Math.abs(remotePos.notionalUsd);

            const instIdR = toOkxSwapInstId(open.symbol);
            const instR = this.instrumentCache.get(instIdR);
            const ctValR = instR?.ctVal ?? 1;
            if (ctValR > 0) {
              const cAbs = remotePos.size / ctValR;
              open.okxContracts = cAbs;
              open.exchangeFilledSize = cAbs;
            }

            // stopPrice recalculation
            const slReg = regimeForSl(open.regimeAtEntry);
            const newStop = engineMirrorStopPrice(remotePos.avgPx, open.side, slReg);
            if (newStop != null && Number.isFinite(newStop)) {
              open.stopPrice = newStop;
            }

            ledgerModified = true;
          }
          next.push(open);
          continue;
        }

        const ordRes = await this.okxDemo.getOrder(toOkxSwapInstId(open.symbol), ordId, clOrdId);
          if (ordRes.ok && ordRes.value.length > 0) {
            const ord = (ordRes.value[0] as any);
            const orderState = ord.state;
            const fillSzRaw = Number(ord.fillSz) || 0;

            if (orderState === "filled" || (orderState === "partially_filled" && fillSzRaw > 0)) {
              const fillPx = Number(ord.fillPx) || (isClosePending ? open.closePendingPrice : open.partialPendingPrice) || 0;
              const fillTime = Number(ord.fillTime) || nowTs;
              const flowId = `${open.symbol}:${open.side}:${open.openedAt}`;
              const snap = this.lastTickSymbolSnapshotBySymbol.get(open.symbol);
              const fundingRate = (isClosePending ? open.closePendingFundingRate : open.partialPendingFundingRate) || snap?.fundingRate || 0;
              
              const requestedQty = Number(ord.sz);
              const cumulativeFillSz = fillSzRaw;
              const previousProcessedFillSz = isPartialPending ? (open.partialPendingProcessedFillSz ?? 0) : (open.closePendingProcessedFillSz ?? 0);
              const deltaFillSz = Math.max(0, cumulativeFillSz - previousProcessedFillSz);

              if (!requestedQty || requestedQty <= 0) {
                 this.logger.warn("V2_PENDING_RECONCILE_UNIT_ERROR", { symbol: open.symbol, ordId, state: orderState, sz: ord.sz });
                 next.push(open); 
                 continue;
              }

              if (deltaFillSz <= 0 && orderState === "partially_filled") {
                 this.logger.info("V2_PARTIAL_PENDING_RECONCILE_PROOF", { 
                    symbol: open.symbol, 
                    side: open.side, 
                    ordId, 
                    state: orderState, 
                    delta_fill_sz: deltaFillSz, 
                    previous_processed_fill_sz: previousProcessedFillSz, 
                    cumulative_fill_sz: cumulativeFillSz, 
                    ledger_update_applied: false, 
                    reason: "NO_NEW_FILL_DELTA" 
                 });
                 next.push(open); 
                 continue;
              }

              const deltaFillRatio = deltaFillSz / requestedQty;
              const totalFillRatio = cumulativeFillSz / requestedQty;
              const baseOriginalPendingUsd = isPartialPending ? (open.partialPendingOriginalSizeUsd ?? open.partialPendingSizeUsd ?? 0) : open.sizeUsd;
              const deltaFilledUsd = baseOriginalPendingUsd * deltaFillRatio;
              const totalFilledUsdComputed = baseOriginalPendingUsd * totalFillRatio;
              const unitConversionOk = Number.isFinite(deltaFilledUsd) && deltaFilledUsd >= 0;

              if (isClosePending) {
                if (orderState === "filled") {
                  this.logger.info("V2_CLOSE_PENDING_RECONCILE_PROOF", { symbol: open.symbol, side: open.side, ordId, state: orderState, fillPx });
                  
                  const metrics = computePaperCloseLegMetrics({
                    open,
                    closePrice: fillPx,
                    closedAt: fillTime,
                    snapFundingRate: fundingRate,
                    marginUsd: open.sizeUsd,
                    paperTakerFeeRate: this.config.paperTakerFeeRate,
                    paperFundingIntervalHours: this.config.paperFundingIntervalHours
                  });
                  
                  const closedRow = finalizePaperClosedRecord({
                    open,
                    symbol: open.symbol as MarketSymbol,
                    closePrice: fillPx,
                    closedAt: fillTime,
                    closeReason: (open.closePendingReason as any) || "v2_exit_authority",
                    legMarginUsd: open.sizeUsd,
                    metrics,
                    feeRate: this.config.paperTakerFeeRate,
                    fundingIntervalHours: this.config.paperFundingIntervalHours,
                    strategyVersion: open.strategyVersion ?? "paper-v2"
                  });
                  
                  await this.appendClosedWithStandardRouting({
                    closedRow,
                    open,
                    flowId,
                    exitReason: open.closePendingReason || "v2_exit_authority",
                    closeSource: "V2_RECONCILE",
                    currentRegime: this.lastRegime.regime || "NO_TRADE"
                  });
                  
                  this.logger.info("PAPER_POSITION_CLOSED_PROOF", { 
                    symbol: open.symbol, 
                    side: open.side, 
                    reason: open.closePendingReason, 
                    pnl: metrics.pnlUsdNet,
                    path: "reconcile_filled"
                  });
                  
                  ledgerModified = true;
                  continue; // Pruned from open ledger
                } else {
                  // CLOSE_PENDING partially_filled
                  open.closePendingFilledSize = cumulativeFillSz;
                  open.closePendingRemainingSize = Math.max(0, requestedQty - cumulativeFillSz);
                  open.closePendingProcessedFillSz = cumulativeFillSz;

                  this.logger.info("V2_CLOSE_PENDING_PARTIAL_FILL_PROOF", {
                    symbol: open.symbol,
                    side: open.side,
                    ord_id: ordId,
                    remote_size: remotePos?.size ?? 0,
                    ledger_size: open.sizeUsd,
                    filled_qty_raw: cumulativeFillSz,
                    delta_fill_sz: deltaFillSz,
                    total_filled_usd: totalFilledUsdComputed
                  });
                  ledgerModified = true;
                  next.push(open);
                  continue;
                }
              } else if (isPartialPending) {
                if (unitConversionOk && deltaFillSz > 0) {
                  this.logger.info("V2_PARTIAL_PENDING_RECONCILE_PROOF", { 
                    symbol: open.symbol, 
                    side: open.side, 
                    ordId, 
                    state: orderState, 
                    fillPx, 
                    delta_fill_sz: deltaFillSz,
                    cumulative_fill_sz: cumulativeFillSz,
                    requested_qty: requestedQty,
                    delta_fill_ratio: deltaFillRatio,
                    delta_filled_usd: deltaFilledUsd,
                    unit_conversion_ok: true
                  });
                  
                  const metrics = computePaperCloseLegMetrics({
                    open,
                    closePrice: fillPx,
                    closedAt: fillTime,
                    snapFundingRate: fundingRate,
                    marginUsd: deltaFilledUsd,
                    paperTakerFeeRate: this.config.paperTakerFeeRate,
                    paperFundingIntervalHours: this.config.paperFundingIntervalHours
                  });
                  
                  const instId = toOkxSwapInstId(open.symbol);
                  const inst = this.instrumentCache.get(instId);
                  const ctVal = inst?.ctVal ?? 1;

                  open.sizeUsd = Math.max(0, open.sizeUsd - deltaFilledUsd);
                  open.realizedPnl = (open.realizedPnl ?? 0) + metrics.pnlUsdNet;

                  // Update decoupled quantity fields
                  if (open.pos != null) open.pos = open.sizeUsd / (open.entryPrice || 1);
                  if (open.baseQty != null) open.baseQty = Math.max(0, open.baseQty - (deltaFillSz * ctVal));
                  if (open.okxContracts != null) open.okxContracts = Math.max(0, open.okxContracts - deltaFillSz);
                  if (open.notionalUsd != null) open.notionalUsd = Math.max(0, open.notionalUsd - deltaFilledUsd);
                  
                  // Update processed counters
                  open.partialPendingProcessedFillSz = cumulativeFillSz;
                  open.partialPendingProcessedUsd = (open.partialPendingProcessedUsd ?? 0) + deltaFilledUsd;

                  // Force protective stop re-registration on size change
                  if (open.protectiveStopAlgoId && open.isProtectiveStopRegistered) {
                    this.logger.info("PROTECTIVE_STOP_UPDATE_REQUIRED_PARTIAL_FILL", { 
                      symbol: open.symbol, 
                      oldAlgoId: open.protectiveStopAlgoId,
                      newSize: open.okxContracts,
                      flowId
                    });
                    await this.cancelProtectiveStopOrder(open.symbol, open.protectiveStopAlgoId, flowId);
                    open.protectiveStopAlgoId = undefined;
                    open.isProtectiveStopRegistered = false;
                  }

                  if (orderState === "filled") {
                    open.lifecycleState = "OPEN";
                    open.partialExitStage = (open.partialExitStage ?? 0) + 1;
                    // Clear pending fields
                    open.partialPendingOrdId = undefined;
                    open.partialPendingClOrdId = undefined;
                    open.partialPendingSizeUsd = undefined;
                    open.partialPendingOriginalSizeUsd = undefined;
                    open.partialPendingProcessedFillSz = undefined;
                    open.partialPendingProcessedUsd = undefined;
                    open.partialPendingAt = undefined;
                    open.partialPendingReduceRatio = undefined;
                    open.partialPendingReason = undefined;
                    open.partialPendingPrice = undefined;
                    open.partialPendingFundingRate = undefined;
                  } else {
                    // partially_filled: update remaining pending size using delta
                    if (open.partialPendingSizeUsd) {
                      open.partialPendingSizeUsd = Math.max(0, open.partialPendingSizeUsd - deltaFilledUsd);
                    }
                  }
                  
                  this.logger.info("V2_PARTIAL_POSITION_UPDATE_PROOF", {
                    symbol: open.symbol,
                    side: open.side,
                    delta_reduced_usd: deltaFilledUsd,
                    total_processed_usd: open.partialPendingProcessedUsd,
                    remaining_size_usd: open.sizeUsd,
                    realized_pnl: metrics.pnlUsdNet,
                    total_realized_pnl: open.realizedPnl,
                    is_final: orderState === "filled"
                  });
                  
                  ledgerModified = true;
                } else {
                   this.logger.warn("V2_PARTIAL_PENDING_RECONCILE_PROOF", { 
                    symbol: open.symbol, 
                    side: open.side, 
                    ordId, 
                    state: orderState,
                    unit_conversion_ok: unitConversionOk,
                    delta_fill_sz: deltaFillSz,
                    detail: "SKIPPING_LEDGER_UPDATE"
                  });
                  next.push(open);
                  continue;
                }
              }
            } else if (orderState === "canceled" || orderState === "rejected") {
              const prevLifecycle = open.lifecycleState;
              this.logger.warn("V2_PENDING_ORDER_FAILED_PROOF", { symbol: open.symbol, side: open.side, ordId, state: orderState });
              
              open.lifecycleState = "OPEN";
              open.reconcileState = "MATCHED";
              open.lastCheckedAt = nowTs;

              // Clear all pending fields
              open.closePendingOrdId = undefined;
              open.closePendingClOrdId = undefined;
              open.closePendingAt = undefined;
              open.closePendingReason = undefined;
              open.closePendingPrice = undefined;
              open.closePendingFundingRate = undefined;
              open.closePendingFilledSize = undefined;
              open.closePendingRemainingSize = undefined;
              
              open.partialPendingOrdId = undefined;
              open.partialPendingClOrdId = undefined;
              open.partialPendingSizeUsd = undefined;
              open.partialPendingOriginalSizeUsd = undefined;
              open.partialPendingProcessedFillSz = undefined;
              open.partialPendingProcessedUsd = undefined;
              open.partialPendingAt = undefined;
              open.partialPendingReduceRatio = undefined;
              open.partialPendingReason = undefined;
              open.partialPendingPrice = undefined;
              open.partialPendingFundingRate = undefined;

              this.logger.info("V2_PENDING_ORDER_RECOVERED_PROOF", {
                symbol: open.symbol,
                side: open.side,
                ord_id: ordId,
                state: orderState,
                previous_lifecycle: prevLifecycle,
                restored_lifecycle: "OPEN",
                pending_fields_cleared: true,
                reconcile_state_set: "MATCHED"
              });

              ledgerModified = true;
              next.push(open);
              continue;
            } else {
              next.push(open);
              continue;
            }
          } else {
            // ordRes.ok but value is empty (Order not found in OKX)
            if (ordRes.ok && ordRes.value.length === 0 && !remotePos && !isNew) {
              await reconcileManualFullClose(open, "RECONCILE_ABSENT_PENDING_NOT_FOUND");
              continue;
            }

            if (
              isClosePending &&
              ordRes.ok && ordRes.value.length === 0 &&
              remotePos &&
              pendingAt != null &&
              nowTs - pendingAt > PENDING_TIMEOUT_MS
            ) {
              this.logger.warn("STALE_CLOSE_PENDING_REPAIRED_PROOF", {
                symbol: open.symbol,
                side: open.side,
                ord_id: ordId,
                pending_elapsed_ms: nowTs - pendingAt,
                detail: "CLOSE_ORDER_NOT_FOUND_BUT_POSITION_EXISTS_STALE_PENDING_RESTORED"
              });
              open.lifecycleState = effectiveCloseOnlyMode ? "CLOSE_ONLY_MANAGED" : "OPEN";
              open.reconcileState = "MATCHED";
              open.lastCheckedAt = nowTs;
              open.closePendingOrdId = undefined;
              open.closePendingClOrdId = undefined;
              open.closePendingAt = undefined;
              open.closePendingReason = undefined;
              open.closePendingPrice = undefined;
              open.closePendingFundingRate = undefined;
              open.closePendingFilledSize = undefined;
              open.closePendingRemainingSize = undefined;

              // stopPrice correction based on actual avgPx after recovery
              if (remotePos && remotePos.avgPx > 0) {
                const slReg = regimeForSl(open.regimeAtEntry);
                const newStop = engineMirrorStopPrice(remotePos.avgPx, open.side, slReg);
                if (newStop != null && Number.isFinite(newStop)) {
                  open.stopPrice = newStop;
                }
              }

              ledgerModified = true;
              next.push(open);
              continue;
            }

            if (
              isPartialPending &&
              pendingAt != null &&
              nowTs - pendingAt > PENDING_TIMEOUT_MS
            ) {
              this.logger.warn("V2_PARTIAL_PENDING_ORDER_POLL_TIMEOUT_RECOVER", {
                symbol: open.symbol,
                side: open.side,
                ord_id: ordId,
                cl_ord_id: clOrdId ?? null,
                pending_elapsed_ms: nowTs - pendingAt,
                detail: "get_order_empty_or_failed_after_timeout"
              });
              open.lifecycleState = "OPEN";
              open.reconcileState = "MATCHED";
              open.lastCheckedAt = nowTs;
              open.partialPendingOrdId = undefined;
              open.partialPendingClOrdId = undefined;
              open.partialPendingSizeUsd = undefined;
              open.partialPendingOriginalSizeUsd = undefined;
              open.partialPendingProcessedFillSz = undefined;
              open.partialPendingProcessedUsd = undefined;
              open.partialPendingAt = undefined;
              open.partialPendingReduceRatio = undefined;
              open.partialPendingReason = undefined;
              open.partialPendingPrice = undefined;
              open.partialPendingFundingRate = undefined;
              if (remotePos && remotePos.avgPx > 0) {
                const instIdR = toOkxSwapInstId(open.symbol);
                const instR = this.instrumentCache.get(instIdR);
                const ctValR = instR?.ctVal ?? 1;
                const baseFromRemote = remotePos.size;
                let nuR = remotePos.notionalUsd;
                if ((!Number.isFinite(nuR) || nuR === 0) && remotePos.avgPx > 0 && baseFromRemote > 0) {
                  nuR = baseFromRemote * remotePos.avgPx;
                }
                open.baseQty = baseFromRemote;
                open.pos = baseFromRemote;
                open.notionalUsd = Math.abs(nuR);
                if (ctValR > 0) {
                  const cAbs = baseFromRemote / ctValR;
                  open.okxContracts = cAbs;
                  open.exchangeFilledSize = cAbs;
                }
                open.avgPx = remotePos.avgPx;
                open.entryPrice = remotePos.avgPx;

                // stopPrice correction based on actual avgPx after recovery
                const slReg = regimeForSl(open.regimeAtEntry);
                const newStop = engineMirrorStopPrice(remotePos.avgPx, open.side, slReg);
                if (newStop != null && Number.isFinite(newStop)) {
                  open.stopPrice = newStop;
                }
              }
              ledgerModified = true;
              next.push(open);
              continue;
            }
            next.push(open);
            continue;
          }
      }

      // 3. Regular Open Position Reconciliation (Deep Comparison & Repair)
      if (open.lifecycleState === "OPEN" || open.lifecycleState === "CLOSE_ONLY_MANAGED") {
        if (!remotePos) {
          await reconcileManualFullClose(open, "RECONCILE_ABSENT");
          continue; // Pruned
        }

        // Deep comparison: avgPx + notional first; base size only when paper.baseQty is explicit (exchange-derived).
        const isAdoptedOrManaged = open.reconcileState === "ADOPTED" || open.lifecycleState === "CLOSE_ONLY_MANAGED";
        const paperNotional = open.notionalUsd ?? open.sizeUsd;
        const priceDiffRatio = Math.abs(open.entryPrice - remotePos.avgPx) / (open.entryPrice || 1);
        const notionalDiff = Math.abs(Math.abs(paperNotional) - Math.abs(remotePos.notionalUsd));
        const paperBaseForCompare =
          typeof open.baseQty === "number" && Number.isFinite(open.baseQty) && open.baseQty > 0
            ? open.baseQty
            : paperNotional / Math.max(1e-12, open.entryPrice || 1);
        const sizeDiff =
          typeof open.baseQty === "number" && Number.isFinite(open.baseQty) && open.baseQty > 0
            ? Math.abs(open.baseQty - remotePos.size)
            : 0;

        let mismatchDetected = false;
        let mismatchType: string = "MATCHED";

        if (priceDiffRatio > 0.0005) {
          mismatchDetected = true;
          mismatchType = "AVG_PRICE_MISMATCH";
        } else if (notionalDiff > 1.0) {
          mismatchDetected = true;
          mismatchType = "NOTIONAL_MISMATCH";
        } else if (
          typeof open.baseQty === "number" &&
          Number.isFinite(open.baseQty) &&
          open.baseQty > 0 &&
          sizeDiff > Math.max(1e-8, 0.002 * Math.max(open.baseQty, remotePos.size))
        ) {
          mismatchDetected = true;
          mismatchType = isAdoptedOrManaged ? "MANUAL_PARTIAL_DETECTED" : "SIZE_MISMATCH";
        }

        // --- Mandatory Hydration from OKX Actual ---
        const instIdHydrate = toOkxSwapInstId(open.symbol);
        const instHydrate = this.instrumentCache.get(instIdHydrate);
        const ctHydrate = instHydrate?.ctVal ?? 1;

        const actualContracts = remotePos.size / ctHydrate;
        const actualNotionalUsd = Math.abs(remotePos.notionalUsd);
        const actualMarginUsd = actualNotionalUsd / (open.leverage || 10);
        const remainingSizeRatio = open.initialSizeUsd ? (actualMarginUsd / open.initialSizeUsd) : 1;

        // Detect manual size change (excluding active partial/close pending states)
        const sizeDiffAbs = Math.abs((open.okxContracts ?? 0) - actualContracts);
        const isSizeMismatched = sizeDiffAbs > Math.max(1e-8, 0.001 * (open.okxContracts ?? actualContracts));

        if (isSizeMismatched && !isPartialPending && !isClosePending) {
          this.logger.warn("MANUAL_SIZE_CHANGE_DETECTED_PROOF", {
            symbol: open.symbol,
            side: open.side,
            prev_contracts: open.okxContracts,
            new_contracts: actualContracts,
            prev_size_usd: open.sizeUsd,
            new_size_usd: actualMarginUsd,
            mismatch_type: mismatchType,
            detail: "OKX_ACTUAL_SIZE_DIFFERS_FROM_LEDGER_HYDRATING"
          });
          
          if (actualContracts < (open.okxContracts ?? 0)) {
            this.logger.info("MANUAL_PARTIAL_SIZE_RECONCILE_PROOF", {
              symbol: open.symbol,
              side: open.side,
              reduced_contracts: (open.okxContracts ?? 0) - actualContracts,
              remaining_contracts: actualContracts
            });
          }
        }

        // --- Zero-Trust Reconciliation Hardening ---
        if (mismatchDetected || isSizeMismatched) {
           this.logger.warn("V2_POSITION_RECONCILE_MISMATCH_BLOCK_PROOF", {
             symbol: open.symbol,
             side: open.side,
             mismatch_type: mismatchType,
             actual_contracts: actualContracts,
             actual_notional: actualNotionalUsd,
             actual_margin: actualMarginUsd,
             ledger_notional: paperNotional,
             ledger_margin: open.sizeUsd,
             action: "BLOCK_HYDRATION_AND_KEEP_ORIGINAL_LEDGER"
           });
           
           open.reconcileState = "RECONCILE_MISMATCH";
           open.lastCheckedAt = nowTs;
           ledgerModified = true;
           // Do NOT proceed to hydration - keep original ledger values for audit visibility
        } else {
          // Hydrate all fields (Only for MATCHED/ALIGNED positions)
          open.actualContracts = actualContracts;
          open.actualNotionalUsd = actualNotionalUsd;
          open.actualMarginUsd = actualMarginUsd;
          open.actualPos = remotePos.size;
          open.actualAvgPx = remotePos.avgPx;
          open.actualUnrealizedPnl = 0; 
          open.actualUnrealizedPnlPct = 0;
          open.remainingSizeRatio = remainingSizeRatio;

          // Update legacy fields to match actuals
          open.okxContracts = actualContracts;
          open.pos = remotePos.size;
          open.baseQty = remotePos.size;
          open.notionalUsd = actualNotionalUsd;
          open.avgPx = remotePos.avgPx;
          open.entryPrice = remotePos.avgPx;
          open.sizeUsd = actualMarginUsd; // sizeUsd now represents current margin

          open.reconcileState = "MATCHED";
          open.lastCheckedAt = nowTs;

          this.logger.info("POSITION_CARD_HYDRATE_FROM_OKX_PROOF", {
            symbol: open.symbol,
            side: open.side,
            actualContracts: open.actualContracts,
            actualNotionalUsd: open.actualNotionalUsd,
            actualMarginUsd: open.actualMarginUsd,
            initialSizeUsd: open.initialSizeUsd,
            remainingSizeRatio: open.remainingSizeRatio
          });
        }

        // --- V2 Risk Integrity Hardening (Hydrate & Prove) ---
        const hydration = this.hydrateRiskPlan(open);
        if (hydration.modified) {
          open = hydration.record;
          ledgerModified = true;
        }

        // Periodic check for protection or size update for OPEN positions
        const protectRes = await this.ensureProtectiveStopOrder(open, `tick:${this.runCycleId}:${open.symbol}`);
        if (protectRes.modified) {
          open = protectRes.record;
          ledgerModified = true;
        }
        if (!protectRes.success) {
          this.symbolProtectionFailedBlocked.add(open.symbol);
          this.logger.error("PROTECTIVE_ORDER_SUBMIT_FAILED", {
            symbol: open.symbol,
            side: open.side,
            flowId: `tick:${this.runCycleId}:${open.symbol}`,
            scope: "reconcile_tick_hydrate",
            detail: "ensureProtectiveStopOrder failed during periodic MATCHED position tick."
          });
          this.logger.error("POSITION_UNPROTECTED_HARD_BLOCK", {
            symbol: open.symbol,
            side: open.side,
            scope: "reconcile_tick_hydrate",
            action: "HARD_BLOCK_NEW_ENTRIES",
            reason: "protective_submit_failed_on_tick"
          });
        }

        const riskSafe = open.stopPrice != null && Number.isFinite(open.stopPrice);
        const reconcileSafe = open.reconcileState !== "RECONCILE_MISMATCH";
        
        if (!riskSafe || !reconcileSafe) {
          this.logger.error("V2_OPEN_POSITION_RISK_STATE_PROOF", {
            symbol: open.symbol,
            side: open.side,
            lifecycleState: open.lifecycleState,
            reconcileState: open.reconcileState,
            stopPrice: open.stopPrice ?? null,
            invalidationPx: open.invalidationPx ?? null,
            safety_check: "FAILED",
            action: "FORCE_CLOSE_ONLY_MANAGED",
            audit_flag: !riskSafe ? "RECOVERY_POSITION_STOP_MISSING" : "RECOVERY_POSITION_RECONCILE_MISMATCH"
          });
          open.lifecycleState = "CLOSE_ONLY_MANAGED";
          ledgerModified = true;
        } else {
          this.logger.info("V2_OPEN_POSITION_RISK_STATE_PROOF", {
            symbol: open.symbol,
            side: open.side,
            lifecycleState: open.lifecycleState,
            stopPrice: open.stopPrice,
            invalidationPx: open.invalidationPx ?? null,
            safety_check: "PASSED"
          });
        }
      }

      next.push(open);
    }

    // 4. Remote-Only Ghost Positions (Adopt/Repair Path)
    for (const [key, remoteVal] of remoteMap.entries()) {
      if (!rawOpens.some(p => `${p.symbol}:${p.side}` === key)) {
        // We do NOT increment mismatchCount for Remote-Only Ghost positions anymore.
        // Instead, we adopt them as EXTERNAL_MANUAL_POSITION which only blocks that symbol.
        const [symbol, sideToken] = key.split(":");
        const side: "long" | "short" = sideToken === "short" ? "short" : "long";

        this.logger.warn("POSITION_LEDGER_ADOPTION_START_PROOF", {
          symbol,
          side,
          instId: remoteVal.instId,
          size: remoteVal.size,
          detail: "EXCHANGE_POSITION_MISSING_IN_LEDGER_ADOPTING"
        });

        // Search for the raw row in lastLivePositionsPayload to get more details
        const okxRow = (this.lastLivePositionsPayload as any[] || []).find(r => 
          String(r.instId) === remoteVal.instId && 
          String(r.posSide ?? "").toLowerCase() === remoteVal.posSide
        );

        const avgPx = Number(okxRow?.avgPx) || 0;
        const leverage = Number(okxRow?.lever) || 10;
        const notional = Number(okxRow?.notionalUsd) || 0;
        const marginMode = String(okxRow?.mgnMode || "cross");

        if (notional <= 0) {
          this.logger.error("POSITION_LEDGER_ADOPTION_BLOCKED_PROOF", {
            symbol,
            side,
            instId: remoteVal.instId,
            reason: "NOTIONAL_USD_MISSING",
            detail: "Cannot safely adopt position without explicit OKX notionalUsd value"
          });
          continue;
        }

        const isEngineOwned = isOrderEngineOwned({ clOrdId: okxRow?.clOrdId, ordId: okxRow?.ordId });
        const lifecycleState = isEngineOwned ? "UNTRACKED_AUTO_ORIGIN" : "OKX_UNTRACKED_FILL";
        
        const adopted: PaperOpenPositionRecord = {
          openedAt: nowTs,
          symbol: symbol as MarketSymbol,
          side,
          entryPrice: avgPx,
          leverage,
          sizeUsd: notional,
          initialSizeUsd: notional,
          strategyVersion: "paper-v2",
          sourceSignal: isEngineOwned ? "okx_reconcile_untracked_auto" : "okx_reconcile_adopted",
          sourceRunPath: isEngineOwned ? "auto_adoption_untracked" : "manual_adoption",
          lifecycleState,
          reconcileState: "ADOPTED",
          lastCheckedAt: nowTs,
          status: "open",
          regimeAtEntry: this.lastRegime.regime || "NO_TRADE",
          executorAtEntry: "IDLE",
          
          // Adoption specific fields (USER priority 6)
          adoptedAt: nowTs,
          detectedAt: nowTs,
          sync_status: "ADOPTED_FROM_OKX",
          marginMode,
          notional,
          pos: remoteVal.size,
          instId: remoteVal.instId
        };

        // --- V2 Risk Integrity Hardening for Adopted ---
        const hydration = this.hydrateRiskPlan(adopted);
        if (hydration.modified) {
          // record updated in-place by hydrateRiskPlan as it's not a read-only object here
        }
        
        if (adopted.stopPrice == null || !Number.isFinite(adopted.stopPrice)) {
          adopted.lifecycleState = "CLOSE_ONLY_MANAGED";
          this.logger.error("V2_OPEN_POSITION_RISK_STATE_PROOF", {
            symbol: adopted.symbol,
            side: adopted.side,
            lifecycleState: adopted.lifecycleState,
            stopPrice: null,
            safety_check: "FAILED",
            audit_flag: "RECOVERY_POSITION_STOP_MISSING",
            reason: "ADOPTED_POSITION_STOP_MISSING"
          });
        }

        next.push(adopted);
        ledgerModified = true;

        this.logger.info("POSITION_OPEN_RECONCILE_PROOF", { 
          symbol, 
          side, 
          status: "adopted", 
          source: "okx_reconcile_adopted" 
        });

        this.logger.info("paper_position_opened", {
          symbol,
          side,
          source: adopted.sourceSignal,
          lifecycleState: adopted.lifecycleState,
          adopted_at: nowTs,
          size_usd: notional,
          is_repair: true,
          clOrdId: okxRow?.clOrdId,
          ordId: okxRow?.ordId,
          isEngineOwned
        });

        if (lifecycleState === "UNTRACKED_AUTO_ORIGIN" || lifecycleState === "OKX_UNTRACKED_FILL") {
          untrackedFills.push(`${symbol}:${side}:${lifecycleState}`);
          this.logger.warn("OKX_UNTRACKED_FILL_AUDIT_LOG", {
            symbol,
            side,
            lifecycleState,
            clOrdId: okxRow?.clOrdId,
            ordId: okxRow?.ordId,
            fillPx: avgPx,
            fillSz: remoteVal.size,
            fee: okxRow?.fee ?? 0,
            posSide: okxRow?.posSide,
            source: "reconcile_ghost_path"
          });
        }
      }
    }

    const nonBtcMismatchCount = rawOpens.filter(p => p.symbol !== "BTCUSDT" && p.reconcileState === "RECONCILE_MISMATCH" && p.lifecycleState !== "EXTERNAL_MANUAL_POSITION").length;
    const hasNonBtcSeriousAdopted = next.some(p => 
      p.symbol !== "BTCUSDT" &&
      p.sourceSignal === "okx_reconcile_adopted" && 
      p.lifecycleState !== "EXTERNAL_MANUAL_POSITION" &&
      p.lifecycleState !== "CLOSE_ONLY_MANAGED"
    );
    const hasNonBtcUntrackedFills = next.some(p => 
      p.symbol !== "BTCUSDT" &&
      (p.lifecycleState === "UNTRACKED_AUTO_ORIGIN" || p.lifecycleState === "OKX_UNTRACKED_FILL")
    );
    const nonBtcUntrackedFillsList = untrackedFills.filter(sym => sym !== "BTCUSDT");

    const hasBtcMismatch = rawOpens.some(p => p.symbol === "BTCUSDT" && p.reconcileState === "RECONCILE_MISMATCH");
    if (hasBtcMismatch) {
      this.logger.warn("POSITION_SIDE_RECONCILE_PROTECTED", {
        symbol: "BTCUSDT",
        detail: "BTCUSDT side mismatch detected but symbol-level protected tracking applied - 전역 safeMode 격상 방지"
      });
    }

    if (nonBtcMismatchCount > 0 || hasNonBtcSeriousAdopted || hasNonBtcUntrackedFills || nonBtcUntrackedFillsList.length > 0) {
      this.reconcileSafetyCloseOnly = true;
      let reason = "position_state_mismatch";
      if (hasNonBtcUntrackedFills || nonBtcUntrackedFillsList.length > 0) reason = `untracked_fills_detected_gate_blocked:${nonBtcUntrackedFillsList.join(",")}`;
      else if (hasNonBtcSeriousAdopted) reason = "unquarantined_adopted_position_block";
      this.reconcileLastMismatchReason = reason;
    } else {
      if (this.reconcileSafetyCloseOnly) {
        this.logger.info("POSITION_RECONCILE_RECOVERED_SAFE_MODE_OFF", {});
      }
      this.reconcileSafetyCloseOnly = false;
      this.reconcileLastMismatchReason = null;
    }

    if (ledgerModified) {
      await this.positions.saveOpenAll(next);
      this.bundleDirty = true;
    }

    // --- [NEW] Orphan Protective Order Cleanup (Offline) ---
    // Requirement: OKX position=0 + paper open=0 + engine-owned pending algo 존재 시 자동 취소.
    // Scan all pending algo orders for symbols we manage and prune any that are engine-owned but have no matching ledger position.
    for (const symbol of this.config.symbols) {
      const instId = toOkxSwapInstId(symbol);
      const key = `${symbol}:long`; // simplified check as remoteMap covers both
      const keyShort = `${symbol}:short`;
      
      const hasRemote = remoteMap.has(key) || remoteMap.has(keyShort);
      const hasLedger = next.some(p => p.symbol === symbol);

      if (!hasRemote && !hasLedger) {
        const pendTry = await this.okxDemo.getOrdersAlgoPending({ instType: "SWAP", instId });
        if (pendTry.ok && pendTry.value) {
          let cancelledCount = 0;
          for (const algo of pendTry.value) {
            const clOrdId = String(algo.algoClOrdId || "");
            if (clOrdId.startsWith("oap")) {
              await this.okxDemo.cancelAlgoOrder([{ instId, algoId: String(algo.algoId) }]);
              cancelledCount++;
            }
          }

          if (cancelledCount > 0) {
            // Post-cancellation verification for orphan sweeper
            await new Promise(resolve => setTimeout(resolve, 500));
            const verifyTry = await this.okxDemo.getOrdersAlgoPending({ instType: "SWAP", instId });
            let remainingOrphanCount = 0;
            if (verifyTry.ok && verifyTry.value) {
              remainingOrphanCount = verifyTry.value.filter(algo => String(algo.algoClOrdId || "").startsWith("oap")).length;
            } else if (!verifyTry.ok) {
              remainingOrphanCount = -1; // Unknown
            }

            const finalOrphanClean = remainingOrphanCount === 0;
            this.logger.warn("PROTECTIVE_ORDER_ORPHAN_CLEANUP_PROOF", {
              symbol,
              cancelled_count: cancelledCount,
              remaining_orphan_count: remainingOrphanCount,
              final_orphan_clean: finalOrphanClean,
              action: "FORCE_CANCEL_ORPHAN_AND_VERIFY"
            });

            if (!finalOrphanClean) {
              this.symbolProtectionFailedBlocked.add(symbol);
            }
          }
        }
      }
    }
  }


  private computePaperExecutionReadiness(): boolean {
    const previousPaperExecutionReady = this.paperExecutionReady;
    
    const serverTradeEnabled = this.serverTradeControlState.server_trade_enabled === true;
    const closeOnlyMode = this.serverTradeControlState.close_only_mode === true;
    const killSwitch = this.serverTradeControlState.kill_switch_active === true;
    const reconcileSafe = this.reconcileSafetyCloseOnly === true;

    const serverAuthorityOk = serverTradeEnabled && !closeOnlyMode && !killSwitch && !reconcileSafe;
    const engineLoopHealthy = this.engineLastTickAt != null;
    const pipelineReady = this.entryPipelineReady && this.exitPipelineReady;
    const marketReady = this.publicMarketDataReady === true;
    const writerReady = this.bundleWriterReady === true;
    const positionStateReady = this.positionTrackingAlive === true;
    
    const currentPaper = serverAuthorityOk && engineLoopHealthy && pipelineReady && marketReady && writerReady && positionStateReady;

    if (!currentPaper) {
      const reasons: string[] = [];
      if (!serverTradeEnabled) reasons.push("SERVER_TRADE_DISABLED");
      if (closeOnlyMode) reasons.push("CLOSE_ONLY_MODE");
      if (killSwitch) reasons.push("KILL_SWITCH");
      if (reconcileSafe) reasons.push("RECONCILE_SAFE_MODE");
      if (!engineLoopHealthy) reasons.push("ENGINE_LOOP_NOT_HEALTHY");
      if (!marketReady) reasons.push("MARKET_DATA_NOT_READY");
      if (!positionStateReady) reasons.push("POSITION_TRACKING_NOT_ALIVE");
      if (!writerReady) reasons.push("BUNDLE_WRITER_NOT_READY");
      if (!pipelineReady) reasons.push("PIPELINE_NOT_READY");

      this.logger.warn("PAPER_EXECUTION_READINESS_BREAKDOWN", {
        ready: false,
        reasons,
        serverTradeEnabled,
        closeOnlyMode,
        killSwitch,
        reconcileSafeMode: reconcileSafe,
        reconcileLastMismatchReason: this.reconcileLastMismatchReason,
        run_cycle_id: this.runCycleId
      });
    }

    return currentPaper;
  }

  private computeSignedExecutionReadiness(): boolean {
    if (!this.config.okxAuthReady) return false;
    return (
      this.okxSignedRestReady === true &&
      this.okxAccountConfigOk === true &&
      this.okxBalanceOk === true &&
      this.okxPositionsOk === true &&
      (this.okxOrderSubmitOk === true || this.okxSignedRestReady === true)
    );
  }

  private signedSubmitMode(): "enabled" | "skipped_not_ready" | "paper_only" {
    if (!this.config.okxExchangeAuthOptIn) return "paper_only";
    if (!this.config.okxAuthReady) return "skipped_not_ready";
    return this.signedExecutionReady ? "enabled" : "skipped_not_ready";
  }

  private signedSubmitBlockReason(mode: "enabled" | "skipped_not_ready" | "paper_only"): string | null {
    return mode === "enabled" ? null : "SIGNED_EXECUTION_NOT_READY";
  }

  private estimateLiquidationPrice(input: {
    side: "buy" | "sell";
    entryPrice: number;
    leverage: number;
  }): number | null {
    if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) return null;
    if (!Number.isFinite(input.leverage) || input.leverage <= 0) return null;
    const mmr = 0.005;
    const moveFrac = Math.max(0.0001, (1 / input.leverage) - mmr);
    if (input.side === "buy") {
      return input.entryPrice * (1 - moveFrac);
    }
    return input.entryPrice * (1 + moveFrac);
  }

  private applyLiveBalanceAuthorityResult(result: LiveBalanceAuthorityResult): void {
    this.okxWalletBalanceUsdt = result.okx_wallet_balance_usdt;
    this.okxAvailableBalanceUsdt = result.okx_available_balance_usdt;
    this.liveBalanceReady = result.live_balance_ready;
    this.liveBalanceBlockReason = result.live_balance_block_reason;
  }

  private async refreshLiveBalanceSnapshot(nowTs: number): Promise<void> {
    const prevSignedReady = this.signedExecutionReady;

    if (this.config.okxAuthMode !== "disabled" && this.okxDemo) {
      // 1. If smoke test never performed OR failed last time, try full check (including config)
      const needsSmokeTest = !this.okxSmokeTestPerformed || !this.okxSignedRestReady;
      
      if (needsSmokeTest) {
        this.okxSmokeTestPerformed = true; // Mark that we attempted at least once
        try {
          const ready = await this.okxDemo.checkSignedReady();
          this.okxAccountConfigOk = ready.configOk;
          this.okxBalanceOk = ready.balanceOk;
          this.okxPositionsOk = ready.positionsOk;
          this.okxSignedRestReady = ready.configOk && ready.balanceOk && ready.positionsOk;

          if (this.okxSignedRestReady) {
            this.lastSignedRestSuccessAt = nowTs;
            this.lastSignedRestError = null;
          } else {
            this.lastSignedRestFailAt = nowTs;
            const errs = [];
            if (!ready.configOk) errs.push(`cfg:${ready.diagnostics.config?.retMsg || "fail"}`);
            if (!ready.balanceOk) errs.push(`bal:${ready.diagnostics.balance?.retMsg || "fail"}`);
            if (!ready.positionsOk) errs.push(`pos:${ready.diagnostics.positions?.retMsg || "fail"}`);
            this.lastSignedRestError = errs.join("|");
          }

          // Mode-aware logs
          if (this.okxAccountConfigOk) this.logger.info("OKX_SIGNED_ACCOUNT_CONFIG_OK", { okx_auth_mode: this.config.okxAuthMode });
          else this.logger.error("OKX_SIGNED_ACCOUNT_CONFIG_FAIL", { ...ready.diagnostics.config, okx_auth_mode: this.config.okxAuthMode });

          if (this.okxBalanceOk) this.logger.info("OKX_SIGNED_BALANCE_OK", { okx_auth_mode: this.config.okxAuthMode });
          else this.logger.error("OKX_SIGNED_BALANCE_FAIL", { ...ready.diagnostics.balance, okx_auth_mode: this.config.okxAuthMode });

          if (this.okxPositionsOk) this.logger.info("OKX_SIGNED_POSITIONS_OK", { okx_auth_mode: this.config.okxAuthMode });
          else this.logger.error("OKX_SIGNED_POSITIONS_FAIL", { ...ready.diagnostics.positions, okx_auth_mode: this.config.okxAuthMode });

          if (this.okxSignedRestReady) {
            this.logger.info("OKX_SIGNED_REST_READY", { okx_auth_mode: this.config.okxAuthMode });
          } else {
            this.logger.error("OKX_SIGNED_REST_INCOMPLETE", { okx_auth_mode: this.config.okxAuthMode });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.lastSignedRestError = msg;
          this.lastSignedRestFailAt = nowTs;
          this.logger.error("OKX_SIGNED_REST_CRITICAL_ERROR", { error: msg, okx_auth_mode: this.config.okxAuthMode });
        }
      }

      // 2. Regular background sync (this might also recover readiness if it was false)
      try {
        const [bal, pos] = await Promise.all([
          this.okxDemo.getBalance("USDT"),
          this.okxDemo.getPositions("SWAP")
        ]);

        if (bal.ok) {
          this.lastLiveBalancePayload = (bal.value?.[0] as Record<string, unknown> | undefined) ?? null;
          this.liveBalanceFetchError = null;
          this.okxBalanceOk = true;
          this.lastSignedRestSuccessAt = nowTs;
        } else {
          this.lastLiveBalancePayload = null;
          this.liveBalanceFetchError = bal.error || bal.diagnostics.retMsg || "LIVE_BALANCE_FETCH_FAILED";
          this.okxBalanceOk = false;
          this.lastSignedRestFailAt = nowTs;
          this.lastSignedRestError = bal.diagnostics.retCode === "50102" ? "TIMESTAMP_EXPIRED" : (bal.error || "fetch_fail");
        }

        if (pos.ok) {
          this.lastLivePositionsPayload = pos.value ?? null;
          this.okxPositionsOk = true;
          this.lastSignedRestSuccessAt = nowTs;
        } else {
          this.lastLivePositionsPayload = null;
          this.okxPositionsOk = false;
          this.lastSignedRestFailAt = nowTs;
          if (!this.lastSignedRestError) {
             this.lastSignedRestError = pos.diagnostics.retCode === "50102" ? "TIMESTAMP_EXPIRED" : (pos.error || "fetch_fail");
          }
        }

        // Recover okxSignedRestReady if everything looks good now
        if (this.okxAccountConfigOk && this.okxBalanceOk && this.okxPositionsOk) {
          if (!this.okxSignedRestReady) {
            this.okxSignedRestReady = true;
            this.lastSignedRestError = null;
            this.logger.info("OKX_SIGNED_REST_RECOVERED", { okx_auth_mode: this.config.okxAuthMode });
          }
        } else if (this.okxSignedRestReady) {
          // If it was ready but now something failed
          this.okxSignedRestReady = false;
          this.logger.warn("OKX_SIGNED_REST_LOST", { 
            okx_auth_mode: this.config.okxAuthMode,
            okx_balance_ok: this.okxBalanceOk,
            okx_positions_ok: this.okxPositionsOk
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.lastLiveBalancePayload = null;
        this.lastLivePositionsPayload = null;
        this.liveBalanceFetchError = msg;
        this.lastSignedRestError = msg;
        this.lastSignedRestFailAt = nowTs;
      }
    } else {
      this.lastLiveBalancePayload = null;
      this.lastLivePositionsPayload = null;
      this.liveBalanceFetchError = this.config.okxAuthMode === "live" ? "LIVE_BALANCE_CLIENT_NOT_READY" : null;
    }

    // Update the engine's internal signedExecutionReady state
    this.evaluateReadinessTransition(nowTs);

    const result = this.buildBalanceDisplayContext(await this.positions.loadOpenAll());
    this.applyLiveBalanceAuthorityResult(result);

    if (this.config.okxAuthMode !== "disabled" && (this.signedExecutionReady !== prevSignedReady || this.runCycleId % 10 === 0)) {
      this.logger.info("OKX_SIGNED_READINESS_RECOVERY_PROOF", {
        okx_auth_mode: this.config.okxAuthMode,
        okx_balance_ok: this.okxBalanceOk,
        okx_positions_ok: this.okxPositionsOk,
        okx_order_submit_ok: this.okxOrderSubmitOk,
        signed_execution_ready_before: prevSignedReady,
        signed_execution_ready_after: this.signedExecutionReady,
        signed_submit_mode: this.signedSubmitMode(),
        signed_submit_block_reason: this.signedSubmitBlockReason(this.signedSubmitMode()),
        last_signed_rest_error: this.lastSignedRestError,
        last_signed_rest_success_at: this.lastSignedRestSuccessAt,
        last_signed_rest_fail_at: this.lastSignedRestFailAt
      });
    }

    this.logger.info("OKX_RAW_POSITIONS_AUTHORITY_PROOF", {
      ts: nowTs,
      okx_auth_mode: this.config.okxAuthMode,
      okx_positions_payload_present: !!this.lastLivePositionsPayload,
      okx_positions_count: Array.isArray(this.lastLivePositionsPayload) ? this.lastLivePositionsPayload.length : 0,
      okx_position_parse_source: result.okx_position_parse_source,
      okx_used_margin_usdt: result.okx_used_margin_usdt,
      okx_total_position_notional_usdt: result.okx_total_position_notional_usdt,
      paper_position_estimated_used_margin_usdt: result.paper_position_estimated_used_margin_usdt
    });

    this.logger.info("V2_LIVE_BALANCE_AUTHORITY_PROOF", {
      ts: nowTs,
      ...result
    });
    this.logger.info("OKX_LIVE_BALANCE_PROOF", {
      ts: nowTs,
      okx_auth_mode: this.config.okxAuthMode,
      balance_source: result.balance_source,
      live_balance_ready: result.live_balance_ready,
      live_balance_block_reason: result.live_balance_block_reason,
      okx_wallet_balance_usdt: result.okx_wallet_balance_usdt,
      okx_available_balance_usdt: result.okx_available_balance_usdt
    });
  }

  private okxAuthProofContext(): {
    okx_auth_mode: "disabled" | "demo" | "live";
    okx_auth_ready: boolean;
    okx_exchange_auth_opt_in: boolean;
    okx_live_enabled: boolean;
    okx_demo_enabled: boolean;
    okx_api_key_present: boolean;
    okx_api_secret_present: boolean;
    okx_passphrase_present: boolean;
    okx_simulated_trading_header_enabled: boolean;
    live_max_order_notional_usdt: number;
    balance_source: "okx_live_wallet" | "paper_config" | "unavailable";
    position_source: "okx_actual" | "paper_estimated" | "unavailable";
    okx_wallet_balance_usdt: number | null;
    okx_available_balance_usdt: number | null;
    okx_used_margin_usdt: number | null;
    okx_total_position_notional_usdt: number | null;
    okx_effective_leverage_used: number | null;
    okx_position_parse_source: string | null;
    paper_position_estimated_used_margin_usdt: number;
    paper_position_estimated_notional_usdt: number;
    paper_position_estimated_effective_leverage_used: number | null;
    account_equity_display_source: "okx_live_wallet" | "paper_config" | "unavailable";
    account_equity_krw_display: number | null;
    account_equity_krw_effective: number | null;
    max_usable_margin_krw_effective: number | null;
    live_balance_ready: boolean;
    live_balance_block_reason: string | null;
  } {
    return this.buildBalanceDisplayContext([]);
  }

  private buildBalanceDisplayContext(opens: ReadonlyArray<PaperOpenPositionRecord>): LiveBalanceAuthorityResult & {
    okx_auth_ready: boolean;
    okx_exchange_auth_opt_in: boolean;
    okx_live_enabled: boolean;
    okx_demo_enabled: boolean;
    okx_api_key_present: boolean;
    okx_api_secret_present: boolean;
    okx_passphrase_present: boolean;
    okx_simulated_trading_header_enabled: boolean;
    live_max_order_notional_usdt: number;
  } {
    const mode = this.config.okxAuthMode;
    const apiKey = mode === "live" ? this.config.okxApiKey : mode === "demo" ? this.config.okxDemoApiKey : "";
    const apiSecret = mode === "live" ? this.config.okxApiSecret : mode === "demo" ? this.config.okxDemoApiSecret : "";
    const passphrase = mode === "live" ? this.config.okxPassphrase : mode === "demo" ? this.config.okxDemoPassphrase : "";
    const authority = deriveLiveBalanceAuthority({
      okxAuthMode: mode,
      balancePayload: this.lastLiveBalancePayload,
      balanceFetchError: this.liveBalanceFetchError,
      okxPositionsPayload: this.lastLivePositionsPayload,
      positions: opens.map((p) => ({
        symbol: String(p.symbol),
        side: String(p.side),
        sizeUsd: Number.isFinite(p.sizeUsd) ? p.sizeUsd : 0,
        leverage: Number.isFinite(p.leverage) ? p.leverage : 1
      }))
    });
    return {
      ...authority,
      okx_auth_ready: this.config.okxAuthReady,
      okx_exchange_auth_opt_in: this.config.okxExchangeAuthOptIn,
      okx_live_enabled: this.config.okxLiveEnabled,
      okx_demo_enabled: this.config.okxDemoEnvRequested,
      okx_api_key_present: apiKey.length > 0,
      okx_api_secret_present: apiSecret.length > 0,
      okx_passphrase_present: passphrase.length > 0,
      okx_simulated_trading_header_enabled: this.config.okxSimulatedTradingHeaderEnabled,
      live_max_order_notional_usdt: this.config.okxLiveMaxOrderNotionalUsdt ?? 0
    };
  }

  private dropReadinessStaleState(reason: string, changedAt: number): void {
    const beforeDroppedTotal = this.staleEntryDroppedCount;
    this.clearPendingDecisionState(reason, changedAt, "server_state");
    const droppedCount = this.staleEntryDroppedCount - beforeDroppedTotal;
    this.logger.warn("READINESS_STALE_ENTRY_DROPPED", {
      reason,
      changed_at: changedAt,
      dropped_count: droppedCount,
      dropped_previous_side_intent: true,
      dropped_pending_stage: true,
      stale_entry_dropped_count_total: this.staleEntryDroppedCount
    });
  }

  private maxCandleTsFromSnapshots(snapshots: ReadonlyArray<SymbolSnapshot>): number | null {
    let maxTs: number | null = null;
    for (const s of snapshots) {
      const candles = Array.isArray(s.candles) ? s.candles : [];
      for (const c of candles) {
        const ts = (c as { ts?: unknown }).ts;
        if (typeof ts === "number" && Number.isFinite(ts)) {
          maxTs = maxTs == null ? ts : Math.max(maxTs, ts);
        }
      }
    }
    return maxTs;
  }

  private updateReadinessFreshTickBarrierProgress(
    fetchedAt: number,
    snapshots: ReadonlyArray<SymbolSnapshot>
  ): void {
    if (!this.freshTickRequiredAfterReadiness) return;
    const candleTs = this.maxCandleTsFromSnapshots(snapshots);
    if (this.readinessFreshTickLastFetchedAt == null || this.readinessFreshTickLastCandleTs == null || candleTs == null) {
      this.readinessFreshTickLastFetchedAt = fetchedAt;
      this.readinessFreshTickLastCandleTs = candleTs;
      this.logger.warn("READINESS_FRESH_TICK_BARRIER_ACTIVE", {
        run_cycle_id: this.runCycleId,
        fresh_tick_completed_cycles: this.readinessFreshTickCompletedCycles,
        fresh_tick_required_cycles: this.readinessFreshTickRequiredCycles,
        reason: "baseline_captured_or_candle_missing",
        snapshot_fetched_at: fetchedAt,
        max_candle_ts: candleTs
      });
      return;
    }
    const fetchedAdvanced = fetchedAt > this.readinessFreshTickLastFetchedAt;
    const candleAdvanced = candleTs > this.readinessFreshTickLastCandleTs;
    if (fetchedAdvanced && candleAdvanced) {
      this.readinessFreshTickCompletedCycles += 1;
      this.readinessFreshTickLastFetchedAt = fetchedAt;
      this.readinessFreshTickLastCandleTs = candleTs;
    }
    this.logger.warn("READINESS_FRESH_TICK_BARRIER_ACTIVE", {
      run_cycle_id: this.runCycleId,
      fresh_tick_completed_cycles: this.readinessFreshTickCompletedCycles,
      fresh_tick_required_cycles: this.readinessFreshTickRequiredCycles,
      fetched_advanced: fetchedAdvanced,
      candle_advanced: candleAdvanced,
      snapshot_fetched_at: fetchedAt,
      max_candle_ts: candleTs
    });
  }

  private evaluateReadinessTransition(nowTs: number): void {
    const currentPaper = this.computePaperExecutionReadiness();
    const currentSigned = this.computeSignedExecutionReadiness();

    this.logger.info("V2_READINESS_AUTHORITY_STATE_PROOF", {
      ts: nowTs,
      paper_execution_ready: currentPaper,
      signed_execution_ready: currentSigned,
      reconcile_safe_mode: this.reconcileSafetyCloseOnly,
      reconcile_last_mismatch_reason: this.reconcileLastMismatchReason,
      server_trade_enabled: this.serverTradeControlState.server_trade_enabled,
      close_only_mode: this.serverTradeControlState.close_only_mode
    });

    if (!this.paperExecutionReady && currentPaper) {
      this.paperExecutionReadyChangedAt = nowTs;
      this.freshTickRequiredAfterReadiness = true;
      this.readinessTransitionCycleId = this.runCycleId;
      this.logger.info("PAPER_EXECUTION_READINESS_CHANGED", {
        from: false,
        to: true,
        run_cycle_id: this.runCycleId
      });
      this.dropReadinessStaleState("false_to_true_transition", nowTs);
    } else if (this.paperExecutionReady !== currentPaper) {
      this.paperExecutionReadyChangedAt = nowTs;
      this.logger.info("PAPER_EXECUTION_READINESS_CHANGED", {
        from: this.paperExecutionReady,
        to: currentPaper,
        run_cycle_id: this.runCycleId
      });
    }
    
    if (this.signedExecutionReady !== currentSigned) {
      this.signedExecutionReadyChangedAt = nowTs;
      this.logger.info("SIGNED_EXECUTION_READINESS_TRANSITION", {
        from: this.signedExecutionReady,
        to: currentSigned,
        run_cycle_id: this.runCycleId
      });
    }
    this.paperExecutionReady = currentPaper;
    this.signedExecutionReady = currentSigned;
  }

  private async processOperatorInstructions(nowTs: number): Promise<void> {
    if (!this.serverTradeControlState.instructions || this.serverTradeControlState.instructions.length === 0) return;

    let ledgerModified = false;
    const opens = await this.positions.loadOpenAll();
    const nextOpens = [...opens];

    for (const inst of this.serverTradeControlState.instructions) {
      if (inst.type === "ADOPT_EXCHANGE_STATE") {
        const { symbol, side } = inst;
        const key = `${symbol}:${side}`;
        const okxPos = (this.lastLivePositionsPayload as any[])?.find(p => {
          const k = okxSwapRowToLedgerKey(p)?.key;
          return k === key;
        });

        if (!okxPos) {
          this.logger.error("OPERATOR_INSTRUCTION_FAILED", { inst, reason: "OKX_POSITION_NOT_FOUND" });
          continue;
        }

        const instId = toOkxSwapInstId(symbol);
        const instInfo = this.instrumentCache.get(instId);
        const ctVal = instInfo?.ctVal ?? 1;
        const baseQty = Math.abs(Number(okxPos.pos)) * ctVal;
        
        let foundIdx = nextOpens.findIndex(p => p.symbol === symbol && p.side === side);

        const adoptedRecord: PaperOpenPositionRecord = {
          ...(foundIdx >= 0 ? nextOpens[foundIdx] : {
            openedAt: nowTs,
            symbol: symbol as MarketSymbol,
            side: side as "long" | "short",
            leverage: 10,
            sizeUsd: Math.abs(Number(okxPos.notionalUsd || 0)),
            initialSizeUsd: Math.abs(Number(okxPos.notionalUsd || 0)),
            strategyVersion: "paper-v2",
            sourceSignal: "OPERATOR_ADOPTED",
            sourceRunPath: "operator",
            status: "open",
            isV2Authority: true
          }),
          lifecycleState: "OPEN",
          reconcileState: "ADOPTED",
          lastCheckedAt: nowTs,
          entryPrice: Number(okxPos.avgPx),
          avgPx: Number(okxPos.avgPx),
          baseQty: baseQty,
          pos: baseQty,
          notionalUsd: Math.abs(Number(okxPos.notionalUsd || 0)),
          okxContracts: Math.abs(Number(okxPos.pos)),
          exchangeFilledSize: Math.abs(Number(okxPos.pos)),
          adoptedAt: nowTs,
          sync_status: "ALIGNED"
        };

        if (foundIdx >= 0) {
          nextOpens[foundIdx] = adoptedRecord;
        } else {
          nextOpens.push(adoptedRecord);
        }
        ledgerModified = true;
        this.logger.info("OPERATOR_INSTRUCTION_SUCCESS", { 
          inst, 
          detail: "POSITION_ADOPTED", 
          new_size: baseQty, 
          new_price: okxPos.avgPx 
        });
      }
    }

    if (ledgerModified) {
      await this.positions.saveOpenAll(nextOpens);
      this.bundleDirty = true;
      // Note: We don't clear the instructions from the file here because ServerTradeControlState 
      // is usually managed by an external UI/process that writes the control file.
    }
  }

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
    private readonly logger: Logger,
    okxClientOverride?: any,
    storeOverride?: any
  ) {
    this.store = storeOverride ?? new JsonStore(path.resolve(config.dataDir));
    this.okxPublic = new OkxDemoClient({
      baseUrl: "https://www.okx.com",
      apiKey: "",
      apiSecret: "",
      passphrase: "",
      simulatedTradingHeaderEnabled: config.okxAuthMode === "demo"
    });
    this.positions = new PositionManager(this.store);
    this.risk = new RiskManager(config);
    if (okxClientOverride != null) {
      this.okxDemo = okxClientOverride;
      this.okxDemoKeysLoaded = true;
    } else if (config.okxAuthMode === "demo" || config.okxAuthMode === "live") {
      const selectedApiKey = config.okxAuthMode === "live" ? config.okxApiKey : config.okxDemoApiKey;
      const selectedApiSecret = config.okxAuthMode === "live" ? config.okxApiSecret : config.okxDemoApiSecret;
      const selectedPassphrase = config.okxAuthMode === "live" ? config.okxPassphrase : config.okxDemoPassphrase;
      const selectedBaseUrl = config.okxAuthMode === "live" ? config.okxBaseUrl : config.okxDemoBaseUrl;
      this.okxDemoKeysLoaded =
        selectedApiKey.length > 0 && selectedApiSecret.length > 0 && selectedPassphrase.length > 0;

      if (!this.okxDemoKeysLoaded) {
        this.okxDemo = null;
        this.logger.error("okx_demo_keys_incomplete", {
          ...this.okxAuthProofContext()
        });
      } else {
        this.okxDemo = new OkxDemoClient({
          baseUrl: selectedBaseUrl,
          apiKey: selectedApiKey,
          apiSecret: selectedApiSecret,
          passphrase: selectedPassphrase,
          simulatedTradingHeaderEnabled: config.okxSimulatedTradingHeaderEnabled
        });
        this.logger.info("okx_auth_client_initialized", {
          okx_base_url: selectedBaseUrl,
          okx_keys_loaded: true,
          ...this.okxAuthProofContext()
        });
      }
    } else {
      this.okxDemo = null;
      this.okxDemoKeysLoaded = false;
    }

    if ((config.okxDemoEnvRequested || config.okxLiveEnabled) && !config.okxExchangeAuthOptIn) {
      this.logger.info("okx_exchange_auth_disabled", {
        ...this.okxAuthProofContext(),
        detail:
          "OKX auth env is on but ORBITALPHA_OKX_EXCHANGE_ENABLED is not true ??no signed OKX calls; paper execution + public market data only"
      });
    }
    this.logger.info("paper_data_and_execution_mode", {
      exchange: "okx",
      market_data: "okx_public_unauthenticated",
      okx_demo_effective_enabled: config.okxDemoEnabled,
      okx_signed_rest_active: config.okxAuthReady,
      position_fill_pnl_path: config.okxAuthReady ? "paper_json_plus_okx_submit" : "paper_json_only",
      ...this.okxAuthProofContext()
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

  public async runTick(): Promise<void> {
    return this.runOnce();
  }

  async runOnce(): Promise<void> {
    this.runCycleId += 1;
    const tickNow = Date.now();
    const loopWallStart = tickNow;
    this.lastLoopStartedAt = loopWallStart;
    let okx_balance_ms = 0;
    let okx_position_reconcile_ms = 0;
    let market_data_fetch_ms = 0;
    let htf_fetch_ms = 0;
    let snapshot_write_ms = 0;
    let v2_decision_ms = 0;
    let entry_queue_consume_ms = 0;
    let bundle_write_ms = 0;

    let pre_tick_setup_ms = 0;
    let report_write_ms = 0;
    let history_write_ms = 0;
    let dashboard_bundle_prepare_ms = 0;
    let bundle_file_write_ms = 0;
    let post_tick_cleanup_ms = 0;
    this.engineLastTickAt = tickNow;
    const tPre0 = Date.now();
    await this.loadServerTradeControlState(tickNow);
    this.logger.info("TRADE_CONTROL_STATE_PROOF", {
      serverTradeEnabled: this.serverTradeControlState.server_trade_enabled,
      closeOnlyMode: this.serverTradeControlState.close_only_mode,
      killSwitch: this.serverTradeControlState.kill_switch_active,
      control_source: this.serverTradeControlState.authority_source,
      control_file_path: this.tradeControlPath(),
      control_updated_at: this.serverTradeControlState.updated_at
    });
    if (this.runCycleId === 1) {
      this.logger.info("SERVER_TRADE_CONTROL_STATE_RESTORED", {
        serverTradeEnabled: this.serverTradeControlState.server_trade_enabled,
        closeOnlyMode: this.serverTradeControlState.close_only_mode,
        killSwitch: this.serverTradeControlState.kill_switch_active,
        authority_source: this.serverTradeControlState.authority_source,
        updated_at: this.serverTradeControlState.updated_at,
        reason: this.serverTradeControlState.reason
      });
      this.applyStartupRecoveryBarrier(tickNow);
    }
    this.evaluateServerTradeControlTransition(tickNow);
    this.lastExitReasonLabel = "";
    this.lastSwitchReasonLabel = "";
    this.rangeReversalExitThisTickBySymbol.clear();
    await this.positions.ensureHistoryFile();
    this.positionTrackingAlive = true;
    pre_tick_setup_ms = Date.now() - tPre0;

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
      this.bundleDirty = true;

      this.logger.info("paper_position_ledger_normalized", {
        changed_count: normalizedSymbols.length,
        changed_symbols: normalizedSymbols,
        normalized_fields: Array.from(normalizedFieldsSet),
        save_open_all_triggered: true
      });
    }
    // --------------------------------------------------------------------------


    const tBal0 = Date.now();
    await this.refreshLiveBalanceSnapshot(Date.now());
    okx_balance_ms = Date.now() - tBal0;
    const tRec0 = Date.now();
    await this.runPositionStateReconciliation(Date.now());
    await this.processOperatorInstructions(Date.now());
    okx_position_reconcile_ms = Date.now() - tRec0;
    this.evaluateReadinessTransition(Date.now());
    await this.refreshPendingOrdersSnapshot(Date.now());
    let history_write_skipped = false;
    let history_write_skip_reason = "";
    const fiveMinMs = 5 * 60_000;
    const tHist0 = Date.now();
    let history: unknown[] = this.cachedHistory;
    if (this.historyDirty || (tHist0 - this.lastHistoryRefreshAt > fiveMinMs) || this.cachedHistory.length === 0) {
      history = await this.store.readPositionsHistory();
      this.cachedHistory = history as PaperClosedPositionRecord[];
      await this.refreshEntryQualitySamples(this.cachedHistory);
      this.lastHistoryRefreshAt = tHist0;
      this.historyDirty = false;
      history_write_ms = Date.now() - tHist0;
    } else {
      history_write_skipped = true;
      history_write_skip_reason = "no_history_change_within_5min";
      history_write_ms = 0;
    }


    const allowed = new Set<MarketSymbol>(["BTCUSDT", "ETHUSDT"]);
    const symbols = this.config.symbols.filter((s) => allowed.has(s));
    const fetchedAt = Date.now();
    const klineTimeframe = "1m" as const;
    const klineInterval = "1";
    const klineLimit = 120;
    const category = "SWAP";

    const tMarketWall0 = Date.now();
    const btc5r = await this.okxPublic.tryGetCandles("BTCUSDT", "5m", 120);
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

    const btc1m_r = await this.okxPublic.tryGetCandles("BTCUSDT", "1m", 60);
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
    let sumBasePollMs = 0;
    let sumHtfPollMs = 0;

    for (const symbol of symbols) {
      const result = await this.pollSymbol(symbol, fetchedAt, klineLimit, regimeDetected);
      allSymbolDiagnostics.push(...result.symbolDiagnostics);
      if (result.ok) {
        snapshots.push(result.snapshot);
        sumBasePollMs += result.basePollMs;
        sumHtfPollMs += result.htfFetchMs;
      } else {
        errors.push({ symbol, error: result.error, failedEndpoint: result.failedEndpoint });
        this.logger.error("paper_poll_symbol_failed", { symbol, error: result.error });
      }
    }
    htf_fetch_ms = sumHtfPollMs;
    market_data_fetch_ms = Math.max(0, Date.now() - tMarketWall0 - sumHtfPollMs);

    const tSnapWrite0 = Date.now();
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
    this.marketDataLastUpdateAt = fetchedAt;
    this.publicMarketDataReady = errors.length === 0 && snapshots.length > 0;
    this.updateReadinessFreshTickBarrierProgress(fetchedAt, snapshots);
    const readinessBarrierActive =
      this.freshTickRequiredAfterReadiness &&
      this.readinessFreshTickCompletedCycles < this.readinessFreshTickRequiredCycles;
    const runId = deriveRunIdentity(snapshots);

    const signedSubmitMode = this.signedSubmitMode();
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
      exchange: "okx",
      okx_demo_effective_enabled: this.config.okxDemoEnabled,
      okx_demo_keys_loaded: this.okxDemoKeysLoaded,
      okx_signed_rest_ready: this.okxSignedRestReady,
      okx_account_config_ok: this.okxAccountConfigOk,
      okx_balance_ok: this.okxBalanceOk,
      okx_positions_ok: this.okxPositionsOk,
      okx_order_submit_ok: this.okxOrderSubmitOk,
      ...this.okxAuthProofContext(),
      paper_execution_ready: this.paperExecutionReady,
      signed_execution_ready: this.signedExecutionReady,
      signed_submit_mode: signedSubmitMode,
      signed_submit_block_reason: this.signedSubmitBlockReason(signedSubmitMode),
      v2AuthorityActive: runId.v2AuthorityActive,
      runIdentity: runId as any,
      notes: "paper okx-demo unified pipeline; legacy + v2 authority bridge active; position identity stored per executor/regime resolution; run metadata reflects okx-demo execution"
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
    snapshot_write_ms = Date.now() - tSnapWrite0;

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
    const openSymbols = opensAfterClose.map(o => String(o.symbol));
    const polledSymbols = Array.from(new Set([...this.config.symbols, ...openSymbols]));

    const tV2Decision0 = Date.now();
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
        // ?쒓렇??諛⑺뼢??諛붾뚭굅???뚮㈇?섎㈃ 湲곗〈 ?μ꽭 遺?곹빀 醫낅즺 ?뚮え 湲곕줉 珥덇린??(?덈줈???먮쫫 ?덉슜)
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
        const curZone = classifyRangeZone(bp);
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

      const symbolManualBlocked = this.symbolExternalManualBlocked.has(`${sym}:long`) || 
                                 this.symbolExternalManualBlocked.has(`${sym}:short`);
      const symbolProtectionBlocked = this.symbolProtectionFailedBlocked.has(sym);
      
      const symbolBlocked = symbolManualBlocked || symbolProtectionBlocked;

      const manualCooldown = this.manualCloseCooldownBySymbol.get(symKeyEarly);
      const isManualCooldownActive = manualCooldown && fetchedAt < manualCooldown.until;

      const blockRes: EvaluatePaperSymbolEntryResult | null = symbolBlocked ? {
        decision: {
          ts: fetchedAt,
          timestamp: new Date(fetchedAt).toISOString(),
          symbol: sym,
          engine_mode: this.config.paperEngineMode,
          signal_state: "NONE",
          regime_state: effectiveRegimeForDecision as PaperRegimeState,
          edge_state: "PASS",
          risk_state: "HARD_BLOCK",
          execution_state: "DISABLED",
          final_decision: "REJECT",
          strategy_executor: "IDLE",
          reject_reason: symbolProtectionBlocked ? "POSITION_PROTECTION_FAILED_BLOCK" : "EXTERNAL_MANUAL_POSITION_BLOCK",
          final_block_owner: symbolProtectionBlocked ? "protection_gate" : "external_manual_gate",
          guidance: symbolProtectionBlocked 
            ? "Symbol hard-blocked: OKX protective order missing or failed to register. Entry halted for safety."
            : "Symbol blocked due to external manual position on OKX",
          next_action: symbolProtectionBlocked
            ? "Wait for automated protection repair or verify OKX algo orders"
            : "Wait for manual position to close on OKX"
        },
        intentSide: null,
        executorDecision: null,
        adaptiveOk: false,
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      } : (isManualCooldownActive ? {
        decision: {
          ts: fetchedAt,
          timestamp: new Date(fetchedAt).toISOString(),
          symbol: sym,
          engine_mode: this.config.paperEngineMode,
          signal_state: "NONE",
          regime_state: effectiveRegimeForDecision as PaperRegimeState,
          edge_state: "PASS",
          risk_state: "COOLDOWN",
          execution_state: "DISABLED",
          final_decision: "REJECT",
          strategy_executor: "IDLE",
          reject_reason: "MANUAL_CLOSE_COOLDOWN_ACTIVE",
          final_block_owner: "manual_close_gate",
          guidance: `Symbol in manual close cooldown until ${new Date(manualCooldown!.until).toISOString()}`,
          next_action: "Wait for cooldown to expire"
        },
        intentSide: null,
        executorDecision: null,
        adaptiveOk: false,
        adaptiveDetail: null,
        adaptiveResult: null,
        aiGatePassed: false
      } : null);

      // 1. Snapshot-Check & Preliminary Block Logging
      if (!snap) {
        const resNull = blockRes || evaluatePaperSymbolEntry({
          runCycleId: String(this.runCycleId),
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
          routingActiveEngine: marketModeOut.routing.activeEngine,
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
      let res = blockRes || evaluatePaperSymbolEntry({
          runCycleId: String(this.runCycleId),
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
        routingActiveEngine: marketModeOut.routing.activeEngine,
        logger: this.logger
      });

      // --- Adopted / Close-Only Entry Block ---
      const isAdoptedOrCloseOnly = 
        existingPos?.reconcileState === "ADOPTED" || 
        existingPos?.lifecycleState === "CLOSE_ONLY_MANAGED";
      
      if (isAdoptedOrCloseOnly && res.decision.final_signal_state !== "NONE") {
        this.logger.info("ADOPTED_POSITION_ENTRY_BLOCKED_PROOF", {
          symbol: sym,
          side: existingPos?.side,
          reconcileState: existingPos?.reconcileState,
          lifecycleState: existingPos?.lifecycleState,
          original_entry_signal: res.decision.final_signal_state,
          action: "forced_no_trade"
        });
        // We override the signal to NONE to block entry/add-on for adopted/close-only positions.
        (res as any).decision.final_signal_state = "NONE";
      }


      /** Engine-V2 Execution Path (Standard 2: Selector Bridge) */
      // Entry authority is fully transferred to engine-v2.
      const v2Mode: EngineV2OpMode = "engine_v2";



      const envelope = resolveSymbolDecisionEnvelope({
        symbol: sym,
        fetchedAt,
        runCycleId: String(this.runCycleId),
        evaluationMode: "authoritative",
        snapshot: buildV2SnapshotBridge(snapForDecision!),
        legacy: buildV2LegacyBridge(res),
        config: buildV2ConfigBridge(this.config),
        state: (() => {
          const pendingFetchPerformed =
            this.opsOrdersScanEverDone === true &&
            typeof this.lastOpsOrdersScanAtMs === "number" &&
            this.lastOpsOrdersScanAtMs > 0;

          const cachedOpsPendingIsArray = Array.isArray(this.cachedOpsPending);
          const cachedOpsAlgosIsArray = Array.isArray(this.cachedOpsAlgos);
          const pendingFetchErrorsCount = this.cachedOpsFetchErrors ? this.cachedOpsFetchErrors.length : 0;
          const cachedOpsPendingCount = cachedOpsPendingIsArray ? this.cachedOpsPending.length : 0;
          const cachedOpsAlgosCount = cachedOpsAlgosIsArray ? this.cachedOpsAlgos.length : 0;

          const pendingFetchReady =
            pendingFetchPerformed &&
            cachedOpsPendingIsArray &&
            cachedOpsAlgosIsArray &&
            pendingFetchErrorsCount === 0;

          const pendingPayloadEmpty =
            cachedOpsPendingCount === 0 &&
            cachedOpsAlgosCount === 0;

          const pendingOrdersExposureReady = pendingFetchReady && pendingPayloadEmpty;

          let authorityMode = "FETCH_NOT_READY";
          if (!pendingFetchPerformed) {
             authorityMode = "FETCH_NOT_READY";
          } else if (pendingFetchErrorsCount > 0 || !cachedOpsPendingIsArray || !cachedOpsAlgosIsArray) {
             authorityMode = "FETCH_ERROR";
          } else if (!pendingPayloadEmpty) {
             authorityMode = "NONEMPTY_PENDING_FAIL_CLOSED";
          } else if (pendingOrdersExposureReady) {
             authorityMode = "ZERO_PENDING_SAFE";
          }

          this.logger.info("V2_PENDING_ORDER_BRIDGE_AUTHORITY_PROOF", {
             pendingFetchPerformed,
             pendingFetchTimestamp: this.lastOpsOrdersScanAtMs,
             pendingFetchErrorsCount,
             cachedOpsPendingIsArray,
             cachedOpsAlgosIsArray,
             cachedOpsPendingCount,
             cachedOpsAlgosCount,
             pendingPayloadEmpty,
             pendingOrdersExposureReady,
             accountPendingNotionalUsdt: 0,
             symbolPendingNotionalUsdt: 0,
             authorityMode
          });

          return buildV2StateBridge(
            opensAfterClose,
            this.lastRisk,
            this.config,
            this.paperExecutionReady,
            this.signedExecutionReady,
            readinessBarrierActive,
            this.freshTickRequiredAfterReadiness,
            this.readinessFreshTickCompletedCycles,
            this.readinessFreshTickRequiredCycles,
            this.buildEntryQualityProfilesForV2(),
            this.serverTradeControlState,
            this.reconcileSafetyCloseOnly,
            this.lastLivePositionsPayload,
            this.liveBalanceReady,
            this.okxWalletBalanceUsdt,
            this.okxAvailableBalanceUsdt,
            this.okxPositionsOk,
            pendingOrdersExposureReady,
            0,
            0,
            this.lastSignedRestSuccessAt ?? fetchedAt,
            this.lastSignedRestSuccessAt ?? fetchedAt,
            this.lastOpsOrdersScanAtMs ?? fetchedAt
          );
        })(),
        v2Mode
      });

      const authority = envelope.authority;
      const selectorResult = envelope.selector;

      const v2CooldownAuthority = selectorResult?.v2_result.v2CooldownAuthority;
      const paperRejectReason = res.decision.reject_reason as string;
      const paperRiskCooldownSubreason = (res.decision as any).risk_cooldown_subreason ?? null;

      const paperCooldownAction: "none" | "watch" | "block_entry" | "block_direction" | "halt" = (() => {
        if (!paperRejectReason) return "none";
        if (paperRejectReason === "DIRECTIONAL_LONG_BLOCK" || paperRejectReason === "DIRECTIONAL_SHORT_BLOCK" || paperRejectReason === "DIRECTION_BLOCK") {
          return "block_direction";
        }
        if (paperRejectReason === "RISK_HALT") return "halt";
        if (paperRejectReason.includes("COOLDOWN") || paperRejectReason === "RANGE_GATE_BLOCK_REENTRY" || paperRejectReason === "RANGE_STOP_REENTRY_SAME_CONTEXT_BLOCKED") {
          return "block_entry";
        }
        return "none";
      })();

      const paperCooldownType: "none" | "direction_block" | "time_reentry" | "risk_halt" | "fail_reentry" = (() => {
        if (!paperRejectReason) return "none";
        if (paperRejectReason === "DIRECTIONAL_LONG_BLOCK" || paperRejectReason === "DIRECTIONAL_SHORT_BLOCK" || paperRejectReason === "DIRECTION_BLOCK") {
          return "direction_block";
        }
        if (paperRejectReason === "RISK_HALT") return "risk_halt";
        if (paperRejectReason.includes("COOLDOWN") || paperRejectReason === "RANGE_GATE_BLOCK_REENTRY" || paperRejectReason === "RANGE_STOP_REENTRY_SAME_CONTEXT_BLOCKED") {
          return "time_reentry";
        }
        return "none";
      })();

      const cooldown_superseded_by_server_authority =
        !this.serverTradeControlState.server_trade_enabled ||
        this.serverTradeControlState.kill_switch_active ||
        this.serverTradeControlState.close_only_mode ||
        this.reconcileSafetyCloseOnly;

      const v2_paper_cooldown_agreement = (() => {
        if (!v2CooldownAuthority) return true;
        if (cooldown_superseded_by_server_authority) return true;
        const v2Should = v2CooldownAuthority.shouldCooldown;
        const paperShould = paperCooldownAction !== "none";
        if (v2Should !== paperShould) return false;
        if (v2Should && v2CooldownAuthority.cooldownType !== paperCooldownType) {
          if (v2CooldownAuthority.cooldownAction === "block_entry" && paperCooldownAction === "block_entry") return true;
          return false;
        }
        return true;
      })();

      let cooldownProofHandled = false;
      if (v2CooldownAuthority) {
        const v2Should = v2CooldownAuthority.shouldCooldown;
        const proofKey = `${v2Should}:${paperCooldownAction}:${v2CooldownAuthority.cooldownType}:${paperCooldownType}:${paperRejectReason}:${v2_paper_cooldown_agreement}`;
        const highPriority = v2_paper_cooldown_agreement === false || (v2CooldownAuthority.trueInconsistencyReasons?.length ?? 0) > 0;

        if (shouldEmitV2Proof("V2_COOLDOWN_AUTHORITY_PROOF", String(sym), proofKey, highPriority)) {
          this.logger.info("V2_COOLDOWN_AUTHORITY_PROOF", {
            symbol: sym,
            side: v2CooldownAuthority.side,
            regime: selectorResult?.v2_result.regime ?? null,
            market_mode: marketModeOut.marketMode ?? null,
            directional_shock_state: (selectorResult?.v2_result.rawMetrics as any)?.directionalShockState ?? "UNKNOWN",
            cooldown_authority_owner: v2CooldownAuthority.cooldownAuthorityOwner,
            cooldown_execution_owner: v2CooldownAuthority.cooldownExecutionOwner,
            v2_cooldown_action: v2CooldownAuthority.cooldownAction,
            v2_should_cooldown: v2CooldownAuthority.shouldCooldown,
            v2_cooldown_type: v2CooldownAuthority.cooldownType,
            v2_cooldown_reason: v2CooldownAuthority.cooldownReason,
            v2_cooldown_urgency: v2CooldownAuthority.cooldownUrgency,
            v2_cooldown_remaining_ms: v2CooldownAuthority.cooldownRemainingMs,
            direction_blocked: v2CooldownAuthority.directionBlocked,
            paper_cooldown_action: paperCooldownAction,
            paper_cooldown_type: paperCooldownType,
            paper_cooldown_reason: paperRejectReason,
            paper_reject_reason: paperRejectReason,
            paper_risk_cooldown_subreason: paperRiskCooldownSubreason,
            cooldown_superseded_by_server_authority,
            v2_paper_cooldown_agreement,
            known_shadow_gaps: v2CooldownAuthority.knownShadowGaps,
            true_inconsistency_reasons: v2CooldownAuthority.trueInconsistencyReasons,
            proof_reasons: v2CooldownAuthority.proofReasons
          });
        }
        cooldownProofHandled = true;
      }

      // --- V2 Position State Authority Proof (Step 4) ---
      const v2PositionStateAuthority = selectorResult?.v2_result.v2PositionStateAuthority;
      let v2_paper_position_state_agreement = true;
      let positionStateProofHandled = false;

      if (v2PositionStateAuthority) {
        const paperPos = opensAfterClose.find(p => p.symbol === sym);
        const paperHasPosition = !!paperPos;
        const v2HasPosition = v2PositionStateAuthority.hasPosition;

        const trueInconsistencyReasons: string[] = [];
        const proofReasons: string[] = [];
        const knownShadowGaps: string[] = [...v2PositionStateAuthority.knownShadowGaps];

        if (v2HasPosition !== paperHasPosition) {
          v2_paper_position_state_agreement = false;
          trueInconsistencyReasons.push("POSITION_EXISTENCE_MISMATCH");
        }

        if (paperHasPosition && v2HasPosition && paperPos && v2PositionStateAuthority) {
          if (paperPos.side.toLowerCase() !== v2PositionStateAuthority.side?.toLowerCase()) {
            v2_paper_position_state_agreement = false;
            trueInconsistencyReasons.push("SIDE_MISMATCH");
          }
          
          if (paperPos!.entryStage !== v2PositionStateAuthority.positionStage) {
            proofReasons.push("STAGE_DIFF");
          }

          const pnlDiff = Math.abs((paperPos.unrealizedPnlPct ?? 0) - (v2PositionStateAuthority.unrealizedPnlPct ?? 0));
          if (pnlDiff > 0.05) { // 5% diff
            v2_paper_position_state_agreement = false;
            trueInconsistencyReasons.push("LARGE_PNL_DIFF");
          } else if (pnlDiff > 0.01) {
            proofReasons.push("MINOR_PNL_DIFF");
          }
        }

        if (v2PositionStateAuthority.positionStateExecutionOwner === "paper_engine") {
          knownShadowGaps.push("EXECUTION_OWNER_IS_PAPER_ENGINE");
        }

        const positionStateProofKey = [
          v2_paper_position_state_agreement,
          v2PositionStateAuthority.hasPosition,
          paperHasPosition,
          v2PositionStateAuthority.positionLifecycleState,
          v2PositionStateAuthority.positionRiskState,
          v2PositionStateAuthority.positionStage,
          paperPos?.entryStage ?? null
        ].join("|");

        const positionStateHighPriority = !v2_paper_position_state_agreement || trueInconsistencyReasons.length > 0;

        if (shouldEmitV2Proof("V2_POSITION_STATE_AUTHORITY_PROOF", String(sym), positionStateProofKey, positionStateHighPriority)) {
          this.logger.info("V2_POSITION_STATE_AUTHORITY_PROOF", {
            symbol: sym,
            side: v2PositionStateAuthority.side,
            regime: effectiveRegimeForDecision,
            market_mode: marketModeOut.marketMode,
            directional_shock_state: (selectorResult?.v2_result.rawMetrics as any)?.directionalShockState ?? "UNKNOWN",
            position_state_authority_owner: v2PositionStateAuthority.positionStateAuthorityOwner,
            position_state_execution_owner: v2PositionStateAuthority.positionStateExecutionOwner,
            v2_position_state_action: v2PositionStateAuthority.positionStateAction,
            v2_has_position: v2HasPosition,
            v2_position_lifecycle_state: v2PositionStateAuthority.positionLifecycleState,
            v2_position_risk_state: v2PositionStateAuthority.positionRiskState,
            v2_position_stage: v2PositionStateAuthority.positionStage,
            v2_hold_ms: v2PositionStateAuthority.holdMs,
            v2_pnl_state: v2PositionStateAuthority.pnlState,
            v2_unrealized_pnl_krw: v2PositionStateAuthority.unrealizedPnlKrw,
            v2_unrealized_pnl_usd_estimate: v2PositionStateAuthority.unrealizedPnlUsdEstimate,
            v2_unrealized_pnl_pct: v2PositionStateAuthority.unrealizedPnlPct,
            paper_has_position: paperHasPosition,
            paper_position_side: paperPos?.side ?? null,
            paper_position_stage: paperPos?.entryStage ?? null,
            paper_hold_ms: paperPos ? (Date.now() - paperPos.openedAt) : null,
            paper_unrealized_pnl_krw: paperPos?.unrealizedPnl ?? null,
            paper_unrealized_pnl_pct: paperPos?.unrealizedPnlPct ?? null,
            paper_position_state: paperHasPosition ? "open" : "none",
            v2_paper_position_state_agreement,
            known_shadow_gaps: knownShadowGaps,
            true_inconsistency_reasons: trueInconsistencyReasons,
            proof_reasons: proofReasons
          });
        }
        positionStateProofHandled = true;

        envelope.v2_position_state_action = v2PositionStateAuthority.positionStateAction;
        envelope.v2_position_lifecycle_state = v2PositionStateAuthority.positionLifecycleState;
        envelope.v2_position_risk_state = v2PositionStateAuthority.positionRiskState;
        envelope.v2_position_stage = v2PositionStateAuthority.positionStage;
        envelope.v2_position_pnl_state = v2PositionStateAuthority.pnlState;
        envelope.v2_position_hold_ms = v2PositionStateAuthority.holdMs;
        envelope.v2_unrealized_pnl_usd_estimate = v2PositionStateAuthority.unrealizedPnlUsdEstimate;
        envelope.v2_paper_position_state_agreement = v2_paper_position_state_agreement;
        envelope.position_state_authority_owner = v2PositionStateAuthority.positionStateAuthorityOwner;
        envelope.position_state_execution_owner = v2PositionStateAuthority.positionStateExecutionOwner;
      }

      envelope.v2_paper_cooldown_agreement = v2_paper_cooldown_agreement;
      envelope.v2_cooldown_action = v2CooldownAuthority?.cooldownAction ?? null;
      envelope.v2_cooldown_type = v2CooldownAuthority?.cooldownType ?? null;
      envelope.v2_cooldown_reason = v2CooldownAuthority?.cooldownReason ?? null;
      envelope.v2_cooldown_urgency = v2CooldownAuthority?.cooldownUrgency ?? null;
      envelope.v2_cooldown_remaining_ms = v2CooldownAuthority?.cooldownRemainingMs ?? null;
      envelope.v2_direction_blocked = v2CooldownAuthority?.directionBlocked ?? null;
      envelope.cooldown_authority_owner = v2CooldownAuthority?.cooldownAuthorityOwner ?? null;
      envelope.cooldown_execution_owner = v2CooldownAuthority?.cooldownExecutionOwner ?? null;

      const ledgerExposureNotionalKrw = computeLedgerSymbolExposureNotionalKrw(opensAfterClose, String(sym));
      const ledgerEquityMultiple = ledgerExposureNotionalKrw / 500_000;

      const v2Env = envelope.v2_execution_envelope;
      const v2Res = selectorResult?.v2_result;

      // 4.5 Entry Authority Envelope Proof (Restored Legacy Block)
      this.logger.info("ENTRY_AUTHORITY_ENVELOPE_PROOF", {
        symbol: sym,
        authority_owner: envelope.runtime_authority_owner,
        runtime_authority_decision: envelope.runtime_authority_decision,
        runtime_authority_side: envelope.runtime_authority_side,
        v2_decision: v2Res?.decision ?? null,
        v2_side: v2Res?.side ?? null,
        market_subtype: v2Env?.marketSubtype ?? null,
        active_engine_routing: marketModeOut.routing.activeEngine,
        paper_execution_ready: this.paperExecutionReady,
        signed_execution_ready: this.signedExecutionReady,
        serverTradeEnabled: this.serverTradeControlState.server_trade_enabled,
        closeOnlyMode: this.serverTradeControlState.close_only_mode,
        ledger_exposure_notional_krw: ledgerExposureNotionalKrw,
        ledger_equity_multiple: ledgerEquityMultiple
      });

      // 5. V2 No-Entry Audit (Required by USER - Consolidated location)
      if (
        (envelope.runtime_authority_owner === "V2" || authority.source === "v2") &&
        envelope.runtime_authority_decision !== "ENTER"
      ) {
        const v2 = selectorResult?.v2_result;
        const v2Env = envelope.v2_execution_envelope;
        const v2Risk = v2?.risk;

        // Pre-compute detailed reasons for SIDE_NONE_AFTER_VETO
        const raw = (v2?.rawMetrics as any) || {};
        const boxPos = snapForDecision?.boxPos ?? raw.boxPos ?? 0.5;
        const rangeConfidence = snapForDecision?.rangeConfidence ?? raw.rangeConfidence ?? 0;
        const trendWeaknessScore = snapForDecision?.trendWeaknessScore ?? raw.trendWeaknessScore ?? 0;
        const emaGap = snapForDecision?.emaGap ?? raw.emaGap ?? 0;
        const trendOk = snapForDecision?.trendOk ?? raw.trendOk ?? false;
        const zone = classifyRangeZone(boxPos);
        
        const recovery_mode_active = v2Risk?.blockReason === "TWO_CONSECUTIVE_LOSSES_RECOVERY_MODE";
        const size_suppressed_by_recovery = recovery_mode_active && ((v2Risk?.equityMultiple ?? 0) === 0 || (v2Env?.exposureNotionalKrw ?? 0) === 0);
        
        let range_trend_conflict = false;
        if (v2Env?.range_side_candidate && v2Env?.trend_side_candidate && 
            v2Env.range_side_candidate !== "none" && v2Env.trend_side_candidate !== "none" && 
            v2Env.range_side_candidate !== v2Env.trend_side_candidate) {
          range_trend_conflict = true;
        }

        let side_veto_detail = v2Env?.side_veto_detail || null;
        if (v2Env?.marketSubtype === "WHIPSAW_SHOCK_RECHECK") {
          side_veto_detail = "WHIPSAW_SHOCK_RECHECK_ACTIVE";
        } else if (!side_veto_detail && v2Env?.selected_side_after_veto === "none") {
          if (v2Env?.marketSubtype === "SHOCK_REACTION_UP" && v2Env?.trend_side_candidate === "long") {
            if (zone === "mid") side_veto_detail = "SHOCK_UP_MID_RETEST_REQUIRED";
            else if (trendOk === false) side_veto_detail = "SHOCK_UP_TREND_CONFIRMATION_WEAK";
            else if (v2Env?.reversal_confirmed === false) side_veto_detail = "SHOCK_UP_RECLAIM_NOT_CONFIRMED";
          } else if (v2Env?.marketSubtype === "SHOCK_REACTION_DOWN" && v2Env?.trend_side_candidate === "short") {
            if (zone === "mid") side_veto_detail = "SHOCK_DOWN_MID_RETEST_REQUIRED";
            else if (trendOk === false) side_veto_detail = "SHOCK_DOWN_TREND_CONFIRMATION_WEAK";
            else if (v2Env?.reversal_confirmed === false) side_veto_detail = "SHOCK_DOWN_BREAKDOWN_RETEST_NOT_CONFIRMED";
          } else if (range_trend_conflict) {
            side_veto_detail = "RANGE_TREND_SIDE_CONFLICT";
          } else if ((!v2Env?.range_side_candidate || v2Env?.range_side_candidate === "none") && v2Env?.trend_side_candidate && v2Env?.trend_side_candidate !== "none" && v2Env?.promotion_applied === false) {
            side_veto_detail = v2Env?.promotion_block_reason || "TREND_PROMOTION_VETOED";
          } else if (size_suppressed_by_recovery) {
            side_veto_detail = "RECOVERY_MODE_SIZE_SUPPRESSED";
          } else if (v2Env?.marketSubtype === "FAST_TREND_SHIFT" || v2Env?.marketSubtype === "EARLY_LONG_PROBE" || v2Env?.marketSubtype === "EARLY_SHORT_PROBE") {
            if (v2Env?.raw_missing_condition === "ENTRY_BLOCKED_NO_STRUCTURAL_STOP") {
              side_veto_detail = "PROBE_BLOCKED_MISSING_STRUCTURAL_STOP";
            } else if (v2Env?.raw_missing_condition === "TOTAL_BEARISH_HTF" || v2Env?.raw_missing_condition === "TOTAL_BULLISH_HTF") {
              side_veto_detail = "PROBE_HTF_ALIGNMENT_VETOED";
            }
          }
        }

        // Refine expected_missing_condition (Priority: Authoritative metadata primary/expected -> fallback)
        let refinedMissingCondition = 
          v2Env?.primary_missing_condition || 
          v2Env?.expected_missing_condition || 
          v2Env?.side_veto_detail || 
          v2Env?.promotion_block_reason || 
          null;

        if (!refinedMissingCondition) {
          if (v2Env?.marketSubtype === "WHIPSAW_SHOCK_RECHECK") {
            refinedMissingCondition = "WHIPSAW_RECHECK_NOT_CONFIRMED";
          } else if (v2Env?.shock_reaction_block_reason) {
            refinedMissingCondition = v2Env.shock_reaction_block_reason;
          } else if (v2Env?.promotion_block_reason) {
            refinedMissingCondition = v2Env.promotion_block_reason;
          } else if (side_veto_detail) {
            refinedMissingCondition = side_veto_detail;
          } else if (v2Risk?.blockReason) {
            refinedMissingCondition = v2Risk.blockReason;
          } else if (v2Env?.marketSubtype === "SHOCK_REACTION_UP" && v2Env?.trend_side_candidate === "long" && v2?.decision === "HOLD") {
            refinedMissingCondition = "SHOCK_REACTION_UP_RETEST_NOT_CONFIRMED";
          } else if (v2Env?.marketSubtype === "SHOCK_REACTION_DOWN" && v2Env?.trend_side_candidate === "short" && v2?.decision === "HOLD") {
            refinedMissingCondition = "SHOCK_REACTION_DOWN_RETEST_NOT_CONFIRMED";
          } else if (v2Env?.selected_side_after_veto === "none" && v2Env?.trend_side_candidate && v2Env?.trend_side_candidate !== "none") {
            refinedMissingCondition = "SIDE_NONE_AFTER_VETO";
          } else if (marketModeOut.routing.activeEngine === "TREND" && v2Env?.promotion_applied === false) {
            refinedMissingCondition = "TREND_ENTRY_NOT_PROMOTED";
          } else if (v2?.decision === "HOLD") {
            refinedMissingCondition = "V2_HOLD_NO_ENTRY_SIDE";
          } else {
            refinedMissingCondition = v2Env?.expected_missing_condition || "UNKNOWN_HOLD_REASON";
          }
        }

        // Refine expected_next_action
        let refinedNextAction = v2Env?.expected_next_action || null;
        const sideNoneFinal = v2Env?.selected_side_after_veto === "none";

        if (envelope.runtime_authority_decision !== "ENTER" || v2?.side === "none" || !v2?.side) {
          if (v2Env?.marketSubtype === "WHIPSAW_SHOCK_RECHECK") {
            refinedNextAction = "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION";
          } else if (v2Env?.marketSubtype === "SHOCK_REACTION_UP" && v2Env?.trend_side_candidate === "long" && v2?.decision === "HOLD") {
            refinedNextAction = "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION";
          } else if (v2Env?.marketSubtype === "SHOCK_REACTION_DOWN" && v2Env?.trend_side_candidate === "short" && v2?.decision === "HOLD") {
            refinedNextAction = "WAIT_FOR_BREAKDOWN_RETEST_FAILURE";
          } else if (sideNoneFinal) {
            refinedNextAction = "WAIT_FOR_VALID_SIDE_CONFIRMATION";
          } else if (v2Risk?.blockReason === "TWO_CONSECUTIVE_LOSSES_RECOVERY_MODE") {
            refinedNextAction = "WAIT_FOR_RECOVERY_MODE_CLEAR_OR_HIGH_CONFIDENCE_RETEST";
          } else if (refinedNextAction === "EXECUTE_V2_AUTHORITY") {
            // Absolute prohibition: HOLD cannot have EXECUTE_V2_AUTHORITY
            refinedNextAction = "WAIT_FOR_VALID_ENTRY_SIGNAL";
          }
        }

        // Audit/log only: align expected_next_action with concrete missing / veto tokens (operational readability).
        const noEntryAuditNextByVetoOrMissing: Record<string, string> = {
          WHIPSAW_SHOCK_RECHECK_ACTIVE: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
          WHIPSAW_RECHECK_NOT_CONFIRMED: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
          SHOCK_UP_RECLAIM_NOT_CONFIRMED: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
          SHOCK_UP_MID_RETEST_REQUIRED: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
          SHOCK_UP_TREND_CONFIRMATION_WEAK: "WAIT_FOR_TREND_CONFIRMATION",
          SHOCK_DOWN_BREAKDOWN_RETEST_NOT_CONFIRMED: "WAIT_FOR_BREAKDOWN_RETEST_FAILURE",
          SHOCK_DOWN_MID_RETEST_REQUIRED: "WAIT_FOR_BREAKDOWN_RETEST_FAILURE",
          SHOCK_DOWN_TREND_CONFIRMATION_WEAK: "WAIT_FOR_TREND_CONFIRMATION",
          RANGE_TREND_SIDE_CONFLICT: "WAIT_FOR_RANGE_TREND_ALIGNMENT",
          TREND_PROMOTION_BLOCKED_HTF_DATA_NOT_READY: "WAIT_FOR_HTF_DATA_READY",
          TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD: "WAIT_FOR_QUALITY_IMPROVEMENT",
          TREND_PROMOTION_BLOCKED_QUALITY: "WAIT_FOR_QUALITY_IMPROVEMENT",
          TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED: "WAIT_FOR_BREAKOUT_RETEST_SUPPORT_CONFIRM",
          TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED: "WAIT_FOR_RECHECK_OR_RETEST",
          TREND_PROMOTION_VETOED: "WAIT_FOR_PROMOTION_CONFIRMATION",
          RECOVERY_MODE_SIZE_SUPPRESSED: "WAIT_FOR_RECOVERY_MODE_CLEAR_OR_HIGH_CONFIDENCE_RETEST",
          POLARITY_MISMATCH_BULLISH_MACRO_LIMITS_SHORT_SHOCK: "WAIT_FOR_HTF_POLARITY_ALIGNMENT"
        };

        const vetoKey = side_veto_detail != null ? String(side_veto_detail) : "";
        const missingKey =
          refinedMissingCondition != null && typeof refinedMissingCondition === "string" ? refinedMissingCondition : "";
        const nextFromAuditKey =
          (vetoKey && noEntryAuditNextByVetoOrMissing[vetoKey]) ||
          (missingKey && noEntryAuditNextByVetoOrMissing[missingKey]) ||
          null;
        if (nextFromAuditKey != null) {
          refinedNextAction = nextFromAuditKey;
        }
        if (
          (envelope.runtime_authority_decision !== "ENTER" || v2?.side === "none" || !v2?.side) &&
          refinedNextAction === "EXECUTE_V2_AUTHORITY"
        ) {
          refinedNextAction = "WAIT_FOR_VALID_ENTRY_SIGNAL";
        }

        // SHOCK_REACTION specifics
        let chase_blocked = false;
        let retest_required = false;
        let reclaim_required = false;
        let expected_retest_direction: string | null = null;

        if (v2Env?.marketSubtype === "WHIPSAW_SHOCK_RECHECK") {
          chase_blocked = true;
          retest_required = true;
          reclaim_required = true;
          expected_retest_direction = "whipsaw_recheck_structural";
        } else if (v2Env?.marketSubtype === "SHOCK_REACTION_UP") {
          chase_blocked = !!v2Env?.shock_reaction_block_reason?.includes("CHASE");
          retest_required = true;
          reclaim_required = true;
          expected_retest_direction = "breakout_retest_support_or_reclaim";
        } else if (v2Env?.marketSubtype === "SHOCK_REACTION_DOWN") {
          chase_blocked = !!v2Env?.shock_reaction_block_reason?.includes("CHASE");
          retest_required = true;
          expected_retest_direction = "breakdown_retest_resistance";
        }

        this.logger.info("V2_NO_ENTRY_REASON_AUDIT_PROOF", {
          symbol: sym,
          market_subtype: v2Env?.marketSubtype ?? null,
          active_engine_routing: marketModeOut.routing.activeEngine,
          runtime_authority_decision: envelope.runtime_authority_decision,
          runtime_authority_side: envelope.runtime_authority_side,
          v2_decision: v2?.decision ?? null,
          v2_side: v2?.side ?? null,
          v2_reject_reason: v2Risk?.blockReason ?? null,
          range_side_candidate: v2Env?.range_side_candidate ?? null,
          trend_side_candidate: v2Env?.trend_side_candidate ?? null,
          selected_side_after_veto: v2Env?.selected_side_after_veto ?? null,
          side_veto_detail,
          promotion_applied: v2Env?.promotion_applied ?? false,
          promotion_reason: v2Env?.promotion_reason ?? null,
          promotion_block_reason: v2Env?.promotion_block_reason ?? null,
          shock_reaction_block_reason: v2Env?.shock_reaction_block_reason ?? null,
          chase_blocked,
          retest_required: v2Env?.display_retest_required ?? retest_required,
          reclaim_required: v2Env?.display_support_recheck_required ?? reclaim_required,
          display_retest_required: v2Env?.display_retest_required ?? false,
          display_support_recheck_required: v2Env?.display_support_recheck_required ?? false,
          expected_retest_direction,
          quality_score: v2Env?.quality_score ?? null,
          entry_quality_grade: v2Risk?.entryQualityGrade ?? null,
          reversal_confirmed: v2Env?.reversal_confirmed ?? null,
          side_zone_valid: v2Env?.side_zone_valid ?? null,
          expected_missing_condition: refinedMissingCondition,
          raw_missing_condition: v2Env?.raw_missing_condition || v2Env?.expected_missing_condition || null,
          primary_missing_condition: v2Env?.primary_missing_condition || null,
          secondary_missing_condition: v2Env?.secondary_missing_condition || null,
          expected_next_action: refinedNextAction,
          paper_execution_ready: v2Env?.paperExecutionReady ?? this.paperExecutionReady,
          signed_execution_ready: v2Env?.signedExecutionReady ?? this.signedExecutionReady,
          serverTradeEnabled: this.serverTradeControlState.server_trade_enabled,
          closeOnlyMode: this.serverTradeControlState.close_only_mode,
          killSwitch: this.serverTradeControlState.kill_switch_active,
          riskMode: this.config.paperEngineMode,
          leverage_block_reason: (v2Risk as any)?.legacy_block_reason ?? v2Risk?.blockReason ?? null,
          candidate_equity_multiple: v2Risk?.equityMultiple,
          recovery_mode_active,
          size_suppressed_by_recovery,
          range_trend_conflict,
          boxPos,
          zone,
          trendOk: v2Env?.trend_ok ?? trendOk,
          emaGap,
          trendWeaknessScore,
          rangeConfidence,
          v2_entry_quality_loss_distance: (v2Risk as any)?.diagnostics?.["entry_quality_distance_loss"] ?? null,
          htf_entry_policy: v2Env?.htf_entry_policy ?? null,
          counter_trend_risk: v2Env?.counter_trend_risk ?? null,
          htf_size_multiplier: v2Env?.htf_size_multiplier ?? null,
          htf_requires_stronger_confirmation: v2Env?.htf_requires_stronger_confirmation ?? null,
          htf_hard_block_reason: v2Env?.htf_hard_block_reason ?? null,
          macro_source: v2Env?.macro_source ?? null,
          htf_5m_bias: v2Env?.m5_bias_actual ?? null,
          htf_15m_bias: v2Env?.m15_bias_actual ?? null,
          htf_1h_bias: v2Env?.h1_bias_actual ?? null,
          htf_4h_bias: v2Env?.h4_bias_actual ?? null,
          htf_1d_bias: v2Env?.daily_bias_actual ?? null,
          audit_source: "v2_execution_envelope",
          audit_cycle_consistent: true
        });

        const noEntryAuditRow: Record<string, unknown> = {
          expected_missing_condition: refinedMissingCondition,
          raw_missing_condition: v2Env?.raw_missing_condition || v2Env?.expected_missing_condition || null,
          primary_missing_condition: v2Env?.primary_missing_condition || null,
          secondary_missing_condition: v2Env?.secondary_missing_condition || null,
          expected_next_action: refinedNextAction,
          market_subtype: v2Env?.marketSubtype ?? null,
          active_engine_routing: marketModeOut.routing.activeEngine,
          trend_side_candidate: v2Env?.trend_side_candidate ?? null,
          range_side_candidate: v2Env?.range_side_candidate ?? null,
          selected_side_after_veto: v2Env?.selected_side_after_veto ?? null,
          side_veto_detail: side_veto_detail,
          boxPos,
          zone,
          trendOk: v2Env?.trend_ok ?? trendOk,
          quality_score: v2Env?.quality_score ?? null,
          entry_quality_grade: v2Risk?.entryQualityGrade ?? null,
          reversal_confirmed: v2Env?.reversal_confirmed ?? null,
          side_zone_valid: v2Env?.side_zone_valid ?? null,
          chase_blocked,
          retest_required,
          reclaim_required,
          expected_retest_direction,
          leverage_block_reason: (v2Risk as any)?.legacy_block_reason ?? v2Risk?.blockReason ?? null,
          recovery_mode_active,
          size_suppressed_by_recovery,
          htf_entry_policy: v2Env?.htf_entry_policy ?? null,
          counter_trend_risk: v2Env?.counter_trend_risk ?? null,
          htf_size_multiplier: v2Env?.htf_size_multiplier ?? null,
          htf_requires_stronger_confirmation: v2Env?.htf_requires_stronger_confirmation ?? null,
          htf_hard_block_reason: v2Env?.htf_hard_block_reason ?? null,
          macro_source: v2Env?.macro_source ?? null,
          htf_5m_bias: v2Env?.m5_bias_actual ?? null,
          htf_15m_bias: v2Env?.m15_bias_actual ?? null,
          htf_1h_bias: v2Env?.h1_bias_actual ?? null,
          htf_4h_bias: v2Env?.h4_bias_actual ?? null,
          htf_1d_bias: v2Env?.daily_bias_actual ?? null,
        };
        await this.store.mergeNoEntryAuditSnapshot(String(sym), noEntryAuditRow);
      }


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
        snapshot: snapForDecision ?? snap ?? null,
        authorityEvaluatedAt: fetchedAt,
        executorDecisionEvaluatedAt: fetchedAt,
        signalFetchedAt: snapForDecision?.fetchedAt ?? snap?.fetchedAt ?? fetchedAt,
        decisionCycleId: this.runCycleId,
        v1_decision: envelope.v1_decision,
        v1_side: envelope.v1_side,
        v1_size: envelope.v1_size,
        v2_decision: envelope.v2_decision,
        v2_side: envelope.v2_side,
        v2_size: envelope.v2_size,
        selector_mismatch: envelope.selector_mismatch,
        hard_block_present: envelope.hard_block_present,
        v2_execution_envelope: envelope.v2_execution_envelope ?? undefined
      });
    } // End of sym loop
    this.v2JudgmentReady = decisionBySymbol.size > 0;
    if (decisionBySymbol.size > 0) this.v2LastDecisionAt = fetchedAt;
    this.entryPipelineReady = this.publicMarketDataReady && this.v2JudgmentReady;
    this.exitPipelineReady = this.publicMarketDataReady && snapshots.length > 0;
    this.evaluateReadinessTransition(Date.now());
    v2_decision_ms = Date.now() - tV2Decision0;

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
    const effectiveCloseOnlyMode = this.serverTradeControlState.close_only_mode || this.reconcileSafetyCloseOnly;
    const tEntryQ0 = Date.now();
    await this.processPaperSymbolEntries({
      snapshots,
      errorsCount: errors.length,
      candidateRunPath,
      latestPath,
      metaPath,
      filePath,
      decisionBySymbol,
      paperExecutionReady: this.paperExecutionReady,
      readinessBarrierActive,
      readinessChangedAt: this.paperExecutionReadyChangedAt,
      serverTradeEnabled: this.serverTradeControlState.server_trade_enabled,
      closeOnlyMode: effectiveCloseOnlyMode,
      killSwitchActive: this.serverTradeControlState.kill_switch_active
    });
    entry_queue_consume_ms = Date.now() - tEntryQ0;

    if (this.freshTickRequiredAfterReadiness && !readinessBarrierActive) {
      this.freshTickRequiredAfterReadiness = false;
      this.logger.info("READINESS_REEVALUATION_PASSED", {
        run_cycle_id: this.runCycleId,
        paper_execution_ready: this.paperExecutionReady,
        paper_execution_ready_changed_at: this.paperExecutionReadyChangedAt,
        signed_execution_ready: this.signedExecutionReady,
        signed_execution_ready_changed_at: this.signedExecutionReadyChangedAt,
        fresh_tick_completed_cycles: this.readinessFreshTickCompletedCycles,
        fresh_tick_required_cycles: this.readinessFreshTickRequiredCycles
      });
    }

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
        const stateNow = Date.now();
        const opensForBalanceDisplay = await this.positions.loadOpenAll();
        const balanceDisplay = this.buildBalanceDisplayContext(opensForBalanceDisplay);
        await this.runPositionOperationsWatch(stateNow, opensForBalanceDisplay);
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

        const tRep0 = Date.now();
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
          directional_shock_state: risk.directionalShockState ?? "NONE",
          long_allow: risk.longAllow,
          short_allow: risk.shortAllow,
          entryAllowedLong: Array.from(decisionBySymbol.values()).some(env => 
            (env.v2_side ?? env.selector?.v2_result.side) === "long" && 
            (env.v2_decision ?? env.selector?.v2_result.decision) === "ENTER"
          ),
          entryAllowedShort: Array.from(decisionBySymbol.values()).some(env => 
            (env.v2_side ?? env.selector?.v2_result.side) === "short" && 
            (env.v2_decision ?? env.selector?.v2_result.decision) === "ENTER"
          ),
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
          symbol_decisions: mergeEngineSymbolDecisionsWithOpenLedgerExposure(
            decisionBySymbol,
            opensForBalanceDisplay,
            500_000,
            this.logger
          ),
          exchange: "okx",
          okx_demo_effective_enabled: this.config.okxDemoEnabled,
          okx_demo_keys_loaded: this.okxDemoKeysLoaded,
          paper_execution_ready: this.paperExecutionReady,
          paper_execution_ready_changed_at: this.paperExecutionReadyChangedAt,
          fresh_tick_required_after_readiness: this.freshTickRequiredAfterReadiness,
          fresh_tick_completed_cycles_after_readiness: this.readinessFreshTickCompletedCycles,
          fresh_tick_required_cycles_after_readiness: this.readinessFreshTickRequiredCycles,
          stale_entry_dropped_count: this.staleEntryDroppedCount,
          last_entry_evaluated_at: this.lastEntryEvaluatedAt,
          last_entry_signal_fetched_at: this.lastEntrySignalFetchedAt,
          entry_quality_profit_samples: this.lastEntryQualitySamples.profit.length,
          entry_quality_loss_samples: this.lastEntryQualitySamples.loss.length,
          entry_quality_contaminated_samples: this.lastEntryQualitySamples.contaminated.length,
          entry_quality_history_profit_samples: this.lastEntryQualitySampleSourceBreakdown.history_profit_samples,
          entry_quality_history_loss_samples: this.lastEntryQualitySampleSourceBreakdown.history_loss_samples,
          entry_quality_events_profit_samples: this.lastEntryQualitySampleSourceBreakdown.events_profit_samples,
          entry_quality_events_loss_samples: this.lastEntryQualitySampleSourceBreakdown.events_loss_samples,
          entry_quality_total_sample_count: this.lastEntryQualitySampleSourceBreakdown.total_sample_count,
          engine_loop_alive: true,
          engine_last_tick_at: this.engineLastTickAt,
          market_data_last_update_at: this.marketDataLastUpdateAt,
          v2_last_decision_at: this.v2LastDecisionAt,
          bundle_last_written_at: this.bundleLastWrittenAt,
          signed_execution_ready: this.signedExecutionReady,
          signed_submit_mode: this.signedSubmitMode(),
          signed_submit_block_reason: this.signedSubmitBlockReason(this.signedSubmitMode()),
          server_trade_enabled: this.serverTradeControlState.server_trade_enabled,
          serverTradeEnabled: this.serverTradeControlState.server_trade_enabled,
          close_only_mode: this.serverTradeControlState.close_only_mode,
          closeOnlyMode: this.serverTradeControlState.close_only_mode,
          close_only_mode_effective: this.serverTradeControlState.close_only_mode || this.reconcileSafetyCloseOnly,
          closeOnlyModeEffective: this.serverTradeControlState.close_only_mode || this.reconcileSafetyCloseOnly,
          kill_switch_active: this.serverTradeControlState.kill_switch_active,
          killSwitch: this.serverTradeControlState.kill_switch_active,
          authority_source: this.serverTradeControlState.authority_source,
          trade_control_authority_source: this.serverTradeControlState.authority_source,
          trade_control_updated_at: this.serverTradeControlState.updated_at,
          trade_control_reason: this.serverTradeControlState.reason,
          reconcile_safe_mode_active: this.reconcileSafetyCloseOnly,
          reconcileSafeMode: this.reconcileSafetyCloseOnly,
          reconcile_last_mismatch_reason: this.reconcileLastMismatchReason,
          reconcile_last_checked_at: this.reconcileLastCheckedAt,
          public_market_data_ready: this.publicMarketDataReady,
          v2_judgment_ready: this.v2JudgmentReady,
          position_state_ready: this.positionTrackingAlive,
          bundle_writer_ready: this.bundleWriterReady,
          position_tracking_alive: this.positionTrackingAlive,
          entry_pipeline_ready: this.entryPipelineReady,
          exit_pipeline_ready: this.exitPipelineReady,
          fresh_tick_age_ms:
            this.readinessFreshTickLastFetchedAt != null ? Math.max(0, stateNow - this.readinessFreshTickLastFetchedAt) : null,
          snapshot_age_ms:
            this.marketDataLastUpdateAt != null ? Math.max(0, stateNow - this.marketDataLastUpdateAt) : null,
          okx_signed_rest_ready: this.okxSignedRestReady,
          okx_account_config_ok: this.okxAccountConfigOk,
          okx_balance_ok: this.okxBalanceOk,
          okx_positions_ok: this.okxPositionsOk,
          okx_order_submit_ok: this.okxOrderSubmitOk,
          ledger_okx_position_sync: buildLedgerOkxPositionSyncSnapshot(
            opensForBalanceDisplay,
            this.lastLivePositionsPayload,
            this.instrumentCache
          ),
          position_ops_surface: this.lastPositionOpsSurface,
          ...balanceDisplay
        });
        report_write_ms = Date.now() - tRep0;
        this.logger.info("LIVE_LEVERAGE_USAGE_PROOF", {
          ts: fetchedAt,
          ...balanceDisplay,
          position_margin_lines: balanceDisplay.position_margin_lines
        });
        this.logger.info("DASHBOARD_BALANCE_SOURCE_PROOF", {
          ts: fetchedAt,
          balance_source: balanceDisplay.balance_source,
          account_equity_display_source: balanceDisplay.account_equity_display_source,
          account_equity_krw_display: balanceDisplay.account_equity_krw_display,
          live_balance_ready: balanceDisplay.live_balance_ready,
          live_balance_block_reason: balanceDisplay.live_balance_block_reason
        });
      } catch (e) {
        this.logger.error("engine_state_write_failed", { error: String(e) });
      }
    }

    // Cleanup memory for stale symbols
    const openAfterEntries = await this.positions.loadOpenAll();
    const openSyms = new Set(openAfterEntries.map(o => String(o.symbol)));
    const tCleanup0 = Date.now();
    this.rangeRuntimeBySymbol.forEach((_, symKey) => {
      if (!openSyms.has(symKey)) {
        this.trendHoldMemoryBySymbol.delete(symKey);
        this.trendPyramidLevelBySymbol.delete(symKey);
        this.regimeExitConsumedBySymbol.delete(symKey);
      }
    });
    post_tick_cleanup_ms = Date.now() - tCleanup0;

    try {
      const tBundle0 = Date.now();
      const balanceDisplay = this.buildBalanceDisplayContext(openAfterEntries);
      dashboard_bundle_prepare_ms = Date.now() - tBundle0;

      const tBundleFile0 = Date.now();
      let bundle_write_skipped = false;
      let bundle_write_skip_reason = "";
      let lightweight_status_write_ms = 0;

      if (this.bundleDirty || (Date.now() - this.lastBundleWriteAt > fiveMinMs)) {
        const summary = await this.positions.refreshSummaryReport({
          okx_balance_mode: balanceDisplay.okx_balance_mode,
          okx_balance_source: balanceDisplay.okx_balance_source,
          okx_available_balance_usdt: balanceDisplay.okx_available_balance_usdt,
          okx_total_equity_usdt: balanceDisplay.okx_total_equity_usdt,
          okx_cash_balance_usdt: balanceDisplay.okx_cash_balance_usdt,
          okx_margin_used_usdt: balanceDisplay.okx_used_margin_usdt,
          okx_unrealized_pnl_usdt: balanceDisplay.okx_unrealized_pnl_usdt,
          okx_balance_updated_at: balanceDisplay.okx_balance_updated_at,
          okx_balance_age_ms: balanceDisplay.okx_balance_age_ms,
          okx_balance_fresh: balanceDisplay.okx_balance_fresh,
          okx_balance_error: balanceDisplay.okx_balance_error
        });
        bundle_file_write_ms = Date.now() - tBundleFile0;
        bundle_write_ms = Date.now() - tBundle0;
        this.bundleLastWrittenAt = Date.now();
        this.bundleWriterReady = true;
        this.bundleDirty = false;
        this.lastBundleWriteAt = this.bundleLastWrittenAt;

        this.logger.info("summary_report_refreshed", {
          summaryPath: summary.summaryPath,
          health: summary.health.status
        });
      } else {
        bundle_write_skipped = true;
        bundle_write_skip_reason = "no_core_data_change_within_5min";
        const tLight0 = Date.now();
        await this.store.writeLightweightStatus({
          generatedAt: Date.now(),
          heartbeat: true,
          ...balanceDisplay
        });
        lightweight_status_write_ms = Date.now() - tLight0;
        bundle_file_write_ms = 0;
        bundle_write_ms = Date.now() - tBundle0;
      }

      this.evaluateReadinessTransition(Date.now());

      const nextLoopTiming = getPaperLoopIntervalMs(process.env);
      this.loopIntervalTargetMs = nextLoopTiming.intervalMs;
      this.loopDelayReason = nextLoopTiming.delayReason;

      // Update timing before logging status
      const total_loop_ms = Date.now() - loopWallStart;
      this.lastLoopFinishedAt = Date.now();
      this.lastLoopDurationMs = total_loop_ms;

      this.logger.info("ENGINE_24H_RUNTIME_STATUS", {
        engine_loop_alive: true,
        engine_last_tick_at: this.engineLastTickAt,
        market_data_last_update_at: this.marketDataLastUpdateAt,
        v2_last_decision_at: this.v2LastDecisionAt,
        bundle_last_written_at: this.bundleLastWrittenAt,
        signed_execution_ready: this.signedExecutionReady,
        paper_execution_ready: this.paperExecutionReady,
        signed_submit_mode: this.signedSubmitMode(),
        signed_submit_block_reason: this.signedSubmitBlockReason(this.signedSubmitMode()),
        server_trade_enabled: this.serverTradeControlState.server_trade_enabled,
        serverTradeEnabled: this.serverTradeControlState.server_trade_enabled,
        close_only_mode: this.serverTradeControlState.close_only_mode,
        closeOnlyMode: this.serverTradeControlState.close_only_mode,
        close_only_mode_effective: this.serverTradeControlState.close_only_mode || this.reconcileSafetyCloseOnly,
        closeOnlyModeEffective: this.serverTradeControlState.close_only_mode || this.reconcileSafetyCloseOnly,
        kill_switch_active: this.serverTradeControlState.kill_switch_active,
        killSwitch: this.serverTradeControlState.kill_switch_active,
        authority_source: this.serverTradeControlState.authority_source,
        trade_control_authority_source: this.serverTradeControlState.authority_source,
        reconcile_safe_mode_active: this.reconcileSafetyCloseOnly,
        reconcileSafeMode: this.reconcileSafetyCloseOnly,
        reconcile_last_mismatch_reason: this.reconcileLastMismatchReason,
        fresh_tick_age_ms:
          this.readinessFreshTickLastFetchedAt != null ? Math.max(0, Date.now() - this.readinessFreshTickLastFetchedAt) : null,
        snapshot_age_ms:
          this.marketDataLastUpdateAt != null ? Math.max(0, Date.now() - this.marketDataLastUpdateAt) : null,
        public_market_data_ready: this.publicMarketDataReady,
        v2_judgment_ready: this.v2JudgmentReady,
        position_state_ready: this.positionTrackingAlive,
        bundle_writer_ready: this.bundleWriterReady,
        entry_pipeline_ready: this.entryPipelineReady,
        exit_pipeline_ready: this.exitPipelineReady,
        loop_interval_target_ms: this.loopIntervalTargetMs,
        last_loop_duration_ms: this.lastLoopDurationMs,
        last_loop_started_at: this.lastLoopStartedAt,
        last_loop_finished_at: this.lastLoopFinishedAt,
        loop_delay_reason: this.loopDelayReason,
        ...balanceDisplay
      });

      const measured_sum = market_data_fetch_ms + htf_fetch_ms + v2_decision_ms + snapshot_write_ms + bundle_write_ms + okx_balance_ms + okx_position_reconcile_ms + entry_queue_consume_ms + pre_tick_setup_ms + report_write_ms + history_write_ms + post_tick_cleanup_ms + lightweight_status_write_ms;
      const unmeasured_ms = Math.max(0, total_loop_ms - measured_sum);

      const phaseRows: [string, number][] = [
        ["market_data_fetch_ms", market_data_fetch_ms],
        ["htf_fetch_ms", htf_fetch_ms],
        ["v2_decision_ms", v2_decision_ms],
        ["snapshot_write_ms", snapshot_write_ms],
        ["bundle_write_ms", bundle_write_ms],
        ["okx_balance_ms", okx_balance_ms],
        ["okx_position_reconcile_ms", okx_position_reconcile_ms],
        ["entry_queue_consume_ms", entry_queue_consume_ms],
        ["pre_tick_setup_ms", pre_tick_setup_ms],
        ["report_write_ms", report_write_ms],
        ["history_write_ms", history_write_ms],
        ["post_tick_cleanup_ms", post_tick_cleanup_ms],
        ["lightweight_status_write_ms", lightweight_status_write_ms],
        ["unmeasured_ms", unmeasured_ms]
      ];
      const longestPhase = phaseRows.reduce(
        (best, cur) => (cur[1] > best[1] ? cur : best),
        ["none", 0] as [string, number]
      );

      this.logger.info("V2_LOOP_PHASE_TIMING_PROOF", {
        run_cycle_id: this.runCycleId,
        market_data_fetch_ms,
        htf_fetch_ms,
        v2_decision_ms,
        snapshot_write_ms,
        bundle_write_ms,
        bundle_prepare_ms: dashboard_bundle_prepare_ms,
        bundle_file_write_ms,
        bundle_write_skipped,
        bundle_write_skip_reason,
        lightweight_status_write_ms,
        okx_balance_ms,
        okx_position_reconcile_ms,
        entry_queue_consume_ms,
        pre_tick_setup_ms,
        report_write_ms,
        history_write_ms,
        history_write_skipped,
        history_write_skip_reason,
        post_tick_cleanup_ms,
        unmeasured_ms,
        total_loop_ms,
        next_loop_delay_ms: this.loopIntervalTargetMs,
        longest_phase_key: longestPhase[0],
        longest_phase_ms: longestPhase[1],
        loop_delay_reason: this.loopDelayReason
      });

    } catch (e) {
      this.bundleWriterReady = false;
      this.evaluateReadinessTransition(Date.now());
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
     * must not emit ENTRY_ALLOWED ??avoids re-logging after ENTRY_BLOCKED_FINAL_GATE.
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
    if (snap != null && typeof snap.boxPos === "number" && classifyRangeZone(snap.boxPos) !== p.zone) {
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
    const z = classifyRangeZone(snap.boxPos);
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
   * 1m kline: OKX ?묐떟 ???ㅻ깄??媛앹껜 ??evaluatePaperSymbolEntry ?낅젰源뚯? 罹붾뱾 諛곗뿴 湲몄씠 異붿쟻.
   * fetch 鍮덇컪 / ?ㅻ깄???꾨씫 / ?됯? 吏곸쟾 ?꾨씫(怨쇨굅 踰꾧렇) 援щ텇??
   */
  private logHighwayCandlePipelineProof(stage: string, payload: Record<string, unknown>): void {
    this.logger.info("HIGHWAY_CANDLE_PIPELINE_PROOF", { pipeline_stage: stage, ...payload });
  }

  /** HIGHWAY_CORE Stage1 怨쇨꼍吏? alignment/spacing/volume 遺뺢눼 ?먯씤??executor ?⑥뿉??理쒖긽?꾨줈 ?④?. */
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
   * 理쒖쥌 decision + 紐⑤땲??UI媛 ?곕뒗 ?ㅻ깄/?먯젙 ?꾨뱶 + 由ъ뒪??룹옱吏꾩엯 ?쒖꽦 媛믪쓣 ??濡쒓렇??臾띠뼱
   * ?쒖솢 ?대쾲 ?깆뿉 泥닿껐???????섏삤?붿???遺꾪빐?쒕떎.
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
      oneLineWhyNoEnter = "DATA_NOT_READY: symbol snapshot missing ??entry pipeline short-circuited";
    } else if (ctx.maxPositionsReached && !ctx.hasOpenForSymbol) {
      oneLineWhyNoEnter = `CAPACITY: open_slots_full (total=${ctx.openPositionsTotal} max=${ctx.paperMaxOpenPositions}) and this symbol has no position ??new entry blocked`;
    } else if (risk?.engineBlocked === true) {
      oneLineWhyNoEnter = `RISK_ENGINE_BLOCKED: ${risk.engineBlockReasons?.[0] ?? "no_reason"}`;
    } else if (ctx.effectiveLane === "IDLE") {
      oneLineWhyNoEnter = `REGIME_IDLE: effective lane is IDLE (raw_regime=${ctx.regime})`;
    } else if (regimeBlockActive && br) {
      oneLineWhyNoEnter = `RISK_REGIME_SUSPENDED: regime=${ctx.regime} remaining_ms=${Math.max(0, br.until - ctx.nowTick)} reason=${br.reason}`;
    } else if (rexp && !rexp.allowNewEntry) {
      oneLineWhyNoEnter = `EXPOSURE_NEW_ENTRY_OFF: ${rexp.riskReasonLabel}`;
    } else if (d.final_decision === "ENTER" && res.adaptiveOk !== true) {
      oneLineWhyNoEnter = "FINAL_ENTER but adaptiveOk=false ??adaptive sizing / build did not complete ok";
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

  private isEntryPostOpenRegimeLaneProtectActive(openedAt: number, evalAtMs: number, record?: PaperOpenPositionRecord): boolean {
    const elapsed = evalAtMs - openedAt;
    const baseProtect = elapsed >= 0 && elapsed < ENTRY_POST_OPEN_REGIME_LANE_PROTECT_MS;
    const explicitProtect = record?.entryProtectionUntil != null && evalAtMs < record.entryProtectionUntil;
    return baseProtect || explicitProtect;
  }

  private isV2AuthorityPosition(open: PaperOpenPositionRecord): boolean {
    const authSrc = String(open.authoritySourceAtEntry ?? open.authority ?? "").trim().toLowerCase();
    return authSrc === "v2";
  }

  /** true ???꾨웾 泥?궛???대쾲 ?깆뿉???섏? ?딄퀬 ?좎?(?μ꽭/?덉씤 ?꾪솚??. ?먯젅쨌由ъ뒪???쒕룄 ?깆? ?몄텧遺?먯꽌 蹂꾨룄 ?덉슜. */
  private shouldDeferRegimeLaneTransitionClose(
    open: PaperOpenPositionRecord,
    evalAtMs: number,
    closeReason: PaperClosedPositionRecord["closeReason"] | "highway_ema60_break_long" | "highway_ema60_break_short",
    postPartialProtectActive?: boolean
  ): boolean {
    if (!this.isEntryPostOpenRegimeLaneProtectActive(open.openedAt, evalAtMs, open)) {
      // 吏꾩엯 吏곹썑 ?ъ???蹂댄샇 ?놁?留? 遺遺꾩껌??吏곹썑 蹂댄샇???ъ쟾???곹깭?????덈떎.
      if (postPartialProtectActive === true) {
        switch (closeReason) {
          case "regime_exit":
          case "candidate_lost":
          case "trend_switch":
          case "range_box_break":
          case "range_profit_trail":
          case "highway_ema60_break_long":
          case "highway_ema60_break_short":
            this.logger.info("POST_PARTIAL_PROTECT_DEFER", {
              symbol: open.symbol,
              side: open.side,
              closeReason,
              postPartialProtectActive: true,
              note: "遺遺꾩껌??吏곹썑 蹂댄샇 援ш컙: 吏?뺣맂 ?좏샇/?덉쭠 已먯텧 泥?궛 ?쇱떆 ?좎삁"
            });
            return true;
          default:
            return false;
        }
      }
      return false;
    }
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
        this.logger.info("ENTRY_POST_OPEN_PROTECTION_PROOF", {
          symbol: open.symbol,
          side: open.side,
          opened_at: open.openedAt,
          eval_at: evalAtMs,
          elapsed_ms: evalAtMs - open.openedAt,
          protection_until: open.entryProtectionUntil ?? (open.openedAt + 120_000),
          close_reason: closeReason,
          status: "PROTECTION_ACTIVE_DEFERRING_EXIT"
        });
        return true;
      default:
        return false;
    }
  }

  /**
   * REGIME_EXIT ?꾨낫 ?먯젙 諛??뺤젙 援ъ“ (V2)
   * ?⑥닚 ?덉쭚 ?쇰꺼 蹂寃쎈쭔?쇰줈 ?꾨웾 泥?궛?섎뒗 寃껋쓣 留됯퀬,
   * ?꾨낫 ?곹깭媛 ?쇱젙 ???곗냽?섍굅???뺤젙??援ъ“??臾댄슚?붽? ?꾩쟻???뚮쭔 理쒖쥌 泥?궛 ?밴꺽.
   */
  private evaluateRegimeExitConfirmation(
    open: PaperOpenPositionRecord,
    triggerOwner: string,
    invalidationReason: string,
    requiredTicks: number = 2,
    evalAtMs: number
  ): { confirmed: boolean; updatedPosition: PaperOpenPositionRecord } {
    if (!this.isV2AuthorityPosition(open)) {
      return { confirmed: true, updatedPosition: open };
    }

    const o = { ...open };

    const gapMs = o.regime_exit_last_eval_ms ? evalAtMs - o.regime_exit_last_eval_ms : 0;
    const isContiguous = gapMs >= 0 && gapMs < 20000;

    if (
      o.regime_exit_trigger_owner !== triggerOwner ||
      o.invalidation_reason !== invalidationReason ||
      o.regime_exit_candidate !== true ||
      !isContiguous
    ) {
      o.regime_exit_candidate = true;
      o.regime_exit_confirmed = false;
      o.regime_exit_confirmation_ticks = 1;
      o.regime_exit_trigger_owner = triggerOwner;
      o.invalidation_reason = invalidationReason;
      o.regime_exit_last_eval_ms = evalAtMs;
      
      this.logger.info("REGIME_EXIT_CANDIDATE_STARTED", {
        symbol: o.symbol,
        side: o.side,
        regimeAtEntry: o.regimeAtEntry,
        executorAtEntry: o.executorAtEntry,
        position_identity_at_entry: o.executorAtEntry,
        current_executor: triggerOwner,
        trigger_owner: triggerOwner,
        invalidation_reason: invalidationReason,
        gap_ms: gapMs,
        reset_reason: !isContiguous ? "non_contiguous_ticks" : "new_reason"
      });
      return { confirmed: false, updatedPosition: o };
    }

    o.regime_exit_last_eval_ms = evalAtMs;

    o.regime_exit_confirmation_ticks = (o.regime_exit_confirmation_ticks ?? 1) + 1;

    if (o.regime_exit_confirmation_ticks >= requiredTicks) {
      o.regime_exit_confirmed = true;
      this.logger.info("REGIME_EXIT_CONFIRMED", {
        symbol: o.symbol,
        side: o.side,
        ticks: o.regime_exit_confirmation_ticks,
        position_identity_at_entry: o.executorAtEntry,
        current_executor: triggerOwner,
        trigger_owner: triggerOwner,
        invalidation_reason: invalidationReason
      });
      return { confirmed: true, updatedPosition: o };
    }

    this.logger.info("REGIME_EXIT_CANDIDATE_WAITING", {
      symbol: o.symbol,
      side: o.side,
      ticks: o.regime_exit_confirmation_ticks,
      position_identity_at_entry: o.executorAtEntry,
      current_executor: triggerOwner,
      trigger_owner: triggerOwner,
      invalidation_reason: invalidationReason
    });
    return { confirmed: false, updatedPosition: o };
  }

  /**
   * MIXED/TRANSITION쨌援ъ“ ?붾뱾由쇰쭔?쇰줈??DE_RISK, TREND ?덉씤+諛섎? ENTER ?뺤젙 ?쒖뿉留?EXIT.
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
   * RANGE 援ш컙쨌諛섏쟾 ?ㅼ쐞移샕룹쟻?묓삎源뚯? ???깆뿉??異붿쟻(?곷떒 濡??명뼢쨌??誘몄껜寃??먯씤 利앸챸??.
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
    const zone = typeof boxPos === "number" && Number.isFinite(boxPos) ? classifyRangeZone(boxPos) : null;
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
      /** (1) ?곷떒?먯꽌 raw long ?꾨낫媛 ?ㅼ뼱???stage0媛 臾대젰?뷀븯?붿? */
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
      /** (2)(4) short ?됯? ?댄썑 ?곸쓳?빧룰쾶?댄듃 */
      adaptive_ok: res.adaptiveOk,
      adaptive_direction: null,
      ai_gate_passed: res.aiGatePassed,
      stage1_result_code: d.stage1_result_code ?? null,
      entry_blocked: d.entry_blocked ?? null,
      /** ?뚰봽??濡??밴꺽(?섎떒 ?꾩슜?대굹 UNKNOWN 寃쎈줈?먯꽌 濡??명뼢 ?ш린???щ?) */
      soft_long_v2_path: sup.some((x) => x.includes("STAGE1_SIGNAL_RELAXED_SOFT_CANDIDATE_V2")),
      unknown_regime_range_fallback: sup.some((x) => x.includes("STAGE1_UNKNOWN_REGIME_RANGE_FALLBACK")),
      /** (3) 諛섏쟾 ?ㅼ쐞移섍? 耳쒖죱?붾뜲??ENTER/adaptive 誘몃룄??*/
      reversal_switch_stalled: stalled,
      /** stage0媛 ?꾨땶 寃쎈줈(?덇굅???섏씠?⑥씠 ???먯꽌 ?곷떒 濡??섎룄 ???명뼢 ?ш린??異붿쟻 */
      long_intent_upper_without_range_stage0:
        d.range_stage0_engine_taken !== true &&
        zone === "upper" &&
        res.intentSide === "long",
      /** ?뺤콉 ?꾨컲 ?섏떖: stage0?몃뜲 ?곷떒쨌濡??섎룄 */
      range_stage0_upper_long_intent_anomaly:
        d.range_stage0_engine_taken === true &&
        zone === "upper" &&
        res.intentSide === "long",
      order_build_fail_reason: d.order_build_fail_reason ?? null,
      order_build_fail_stage: d.order_build_fail_stage ?? null,
      open_position_side: openPositionSide
    };
  }

  /**
   * Helper to dispatch an OKX order to close (fully or partially) a paper position.
   */
  /** 
   * Unified OKX Contract Size Normalizer for REDUCE-ONLY orders.
   * Respects lotSz/minSz and supports fractional contracts (0.43, 0.12).
   * Prioritizes ledger/exchange contract counts over USD estimates.
   */
  private normalizeOkxReduceOrderSize(args: {
    symbol: string;
    okxContracts: number;
    sizing: OkxSwapInstrumentSizing;
    flowId: string;
    reason: string;
  }): {
    raw_contracts: number;
    normalized_contracts: number;
    normalized_sz: string;
    ok: boolean;
  } {
    const { okxContracts, sizing, flowId, reason, symbol } = args;
    const lot = sizing.lotSz;
    const minSz = sizing.minSz;

    // Floor to ensure we don't attempt to close more than we have (reduce-only safety)
    const steps = Math.floor(okxContracts / lot + 1e-12);
    let normalized_contracts = steps * lot;

    // Floating point hygiene: use instrument-specific precision
    normalized_contracts = Number(
      normalized_contracts.toFixed(Math.min(12, okxInstrumentSzDecimals(lot)))
    );

    const normalized_sz = formatOkxSwapContractSzString(normalized_contracts, lot);
    const ok = normalized_contracts > 0 && normalized_contracts + 1e-12 >= minSz;

    this.logger.info("V2_REDUCE_ORDER_SIZE_UNIT_PROOF", {
      symbol,
      reason,
      input_contracts: okxContracts,
      lotSz: lot,
      minSz,
      normalized_contracts,
      normalized_sz,
      ok,
      flowId
    });

    return { raw_contracts: okxContracts, normalized_contracts, normalized_sz, ok };
  }

  private async dispatchOkxClose(input: {
    symbol: string;
    side: "long" | "short";
    sizeUsd: number;
    /** Position leverage at margin `sizeUsd` (paper margin 횞 lev ??OKX notional). */
    appliedLeverage: number;
    lastPrice: number;
    flowId: string;
    reason: string;
    closeSource?: string;
    authorityOwner?: string;
    executionOwner?: string;
    isV2Authority?: boolean;
    isStopLoss?: boolean;
    isTakeProfit?: boolean;
    isTrailingStop?: boolean;
    isPartial?: boolean;
    /** Explicit contract count for accurate reduction (0.43, 0.12 etc) */
    okxContracts?: number;
  }): Promise<{ 
    ok: boolean; 
    ordId?: string; 
    fillConfirmed?: boolean;
    clOrdId?: string;
    errorCode?: string | null;
    errorMessage?: string | null;
  }> {
    if (!this.okxDemo || this.signedSubmitMode() !== "enabled") {
      this.logger.info("okx_close_dispatch_skipped", {
        symbol: input.symbol,
        reason: input.reason,
        okx_demo_active: !!this.okxDemo,
        okx_signed_ready: this.okxSignedRestReady
      });
      return { ok: false, errorMessage: "okx_client_or_mode_not_ready" };
    }

    const side = input.side === "long" ? "sell" : "buy";
    const posSide = input.side === "long" ? "long" : "short";
    const lev = typeof input.appliedLeverage === "number" && Number.isFinite(input.appliedLeverage) && input.appliedLeverage > 0 ? input.appliedLeverage : 1;

    const instId = toOkxSwapInstId(input.symbol);
    const inst = this.instrumentCache.get(instId);
    let finalQty = 0;
    let finalSzStr = "0";

    if (inst) {
      // Use explicit okxContracts if provided, fallback to estimation from sizeUsd
      let sourceContracts = input.okxContracts;
      if (sourceContracts == null || sourceContracts <= 0) {
        sourceContracts = (input.sizeUsd / Math.max(1e-9, input.lastPrice)) / (inst.ctVal || 1);
      }

      const norm = this.normalizeOkxReduceOrderSize({
        symbol: input.symbol,
        okxContracts: sourceContracts,
        sizing: inst,
        flowId: input.flowId,
        reason: input.reason
      });

      finalQty = norm.normalized_contracts;
      finalSzStr = norm.normalized_sz;
    } else {
      // Legacy fallback (should rarely happen if instrumentCache is warm)
      finalQty = Math.max(0.001, Math.round((input.sizeUsd / Math.max(1e-9, input.lastPrice)) * 1_000_000) / 1_000_000);
      finalSzStr = String(finalQty);
    }

    const desiredNotionalUsdt = Math.max(0, input.sizeUsd);
    this.logger.info("V2_CLOSE_SIZE_UNIT_PROOF", {
      symbol: input.symbol,
      size_usd: input.sizeUsd,
      desired_notional_usdt: desiredNotionalUsdt,
      applied_leverage: lev
    });
    const clOrdId = buildOkxClOrdId(input.symbol, side);

    const closeReason = input.reason;
    const isStopLoss = input.isStopLoss ?? (closeReason === "stop_loss" || closeReason.includes("stop_loss"));
    const isTakeProfit = input.isTakeProfit ?? (closeReason === "take_profit" || closeReason.includes("take_profit"));
    const isTrailingStop = input.isTrailingStop ?? (closeReason === "trailing_stop" || closeReason.includes("trailing_stop") || closeReason.includes("range_profit_trail"));

    if (isStopLoss) {
      this.logger.info("STOP_LOSS_ORDER_PATH_PROOF", {
        symbol: input.symbol,
        side,
        qty_legacy_base_estimate: finalQty,
        desired_notional_usdt: desiredNotionalUsdt,
        close_reason: closeReason,
        flowId: input.flowId,
        clOrdId
      });
    } else if (isTakeProfit) {
      this.logger.info("TAKE_PROFIT_ORDER_PATH_PROOF", {
        symbol: input.symbol,
        side,
        qty_legacy_base_estimate: finalQty,
        desired_notional_usdt: desiredNotionalUsdt,
        close_reason: closeReason,
        flowId: input.flowId,
        clOrdId
      });
    } else if (isTrailingStop) {
      this.logger.info("TRAILING_STOP_ORDER_PATH_PROOF", {
        symbol: input.symbol,
        side,
        qty_legacy_base_estimate: finalQty,
        desired_notional_usdt: desiredNotionalUsdt,
        close_reason: closeReason,
        flowId: input.flowId,
        clOrdId
      });
    } else if (closeReason === "range_profit_trail") {
      this.logger.info("RANGE_PROFIT_TRAIL_ORDER_PATH_PROOF", {
        symbol: input.symbol,
        side,
        qty_legacy_base_estimate: finalQty,
        desired_notional_usdt: desiredNotionalUsdt,
        close_reason: closeReason,
        flowId: input.flowId,
        clOrdId
      });
    } else if (closeReason.includes("regime_exit") || closeReason.includes("regime")) {
      this.logger.info("REGIME_EXIT_ORDER_PATH_PROOF", {
        symbol: input.symbol,
        side,
        qty_legacy_base_estimate: finalQty,
        desired_notional_usdt: desiredNotionalUsdt,
        close_reason: closeReason,
        flowId: input.flowId,
        clOrdId
      });
    } else if (closeReason.includes("trend_break")) {
      this.logger.info("TREND_BREAK_ORDER_PATH_PROOF", {
        symbol: input.symbol,
        side,
        qty_legacy_base_estimate: finalQty,
        desired_notional_usdt: desiredNotionalUsdt,
        close_reason: closeReason,
        flowId: input.flowId,
        clOrdId
      });
    }

    this.logger.info("CLOSE_ORDER_PATH_PROOF", {
      symbol: input.symbol,
      side,
      close_side_order: side,
      qty_legacy_base_estimate: finalQty,
      desired_notional_usdt: desiredNotionalUsdt,
      applied_leverage: lev,
      sizeUsd: input.sizeUsd,
      lastPrice: input.lastPrice,
      close_reason: closeReason,
      close_source: input.closeSource ?? "unknown",
      authority_owner: input.authorityOwner ?? "unknown",
      execution_owner: input.executionOwner ?? "paper_engine",
      is_v2_authority: input.isV2Authority ?? false,
      is_stop_loss: isStopLoss,
      is_take_profit: isTakeProfit,
      is_trailing_stop: isTrailingStop,
      is_partial: input.isPartial ?? false,
      flowId: input.flowId,
      clOrdId
    });

    const finalIsStopLoss = input.isStopLoss === true || isStopLoss;

    const result = await this.submitOkxOrder({
      symbol: input.symbol as MarketSymbol,
      side,
      posSide,
      qty: finalQty,
      okxContracts: finalQty,
      desiredNotionalUsdt,
      pricingReferencePx: input.lastPrice,
      appliedLeverage: lev,
      clOrdId,
      traceId: input.flowId,
      reason: input.reason,
      isNewEntry: false,
      reduceOnly: true,
      ordType: finalIsStopLoss ? "market" : undefined
    });

    return { 
      ok: result.ok, 
      ordId: result.ordId ?? undefined, 
      fillConfirmed: result.fillConfirmed,
      clOrdId: result.clOrdId,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage
    };
  }

  private buildLiveLimitOrderPrice(input: {
    symbol: string;
    side: "buy" | "sell";
    bid: number;
    ask: number;
    tickSize: number;
    priceBufferTicks: number;
    purpose: string;
  }): number {
    const { side, bid, ask, tickSize, priceBufferTicks, symbol, purpose } = input;
    
    if (ask < bid) {
      this.logger.error("LIVE_LIMIT_PRICE_BUILD_FAIL", { symbol, purpose, reason: "ask_below_bid", ask, bid });
      throw new Error("LIVE_LIMIT_PRICE_BUILD_FAIL: ask < bid");
    }

    let finalPx: number;
    if (side === "buy") {
      finalPx = ask + (tickSize * priceBufferTicks);
    } else {
      finalPx = bid - (tickSize * priceBufferTicks);
    }
    
    const precision = Math.max(0, -Math.floor(Math.log10(tickSize) + 0.0001));
    const normalizedPx = Number(finalPx.toFixed(precision));

    if (normalizedPx <= 0) {
      this.logger.error("LIVE_LIMIT_PRICE_BUILD_FAIL", { symbol, purpose, reason: "price_not_positive", normalizedPx });
      throw new Error("LIVE_LIMIT_PRICE_BUILD_FAIL: px <= 0");
    }

    this.logger.info("LIVE_LIMIT_ORDER_PRICE_PROOF", {
      symbol,
      purpose,
      side,
      bid,
      ask,
      tick_size: tickSize,
      buffer_ticks: priceBufferTicks,
      final_px: normalizedPx
    });

    return normalizedPx;
  }

  private async cancelProtectiveStopOrder(symbol: string, algoId: string, flowId: string): Promise<boolean> {
    if (!this.okxDemo) return false;
    this.logger.info("OKX_PROTECTIVE_STOP_ORDER_CANCEL_SUBMIT", { symbol, algoId, flowId });
    const res = await this.okxDemo.cancelAlgoOrder([{ instId: toOkxSwapInstId(symbol as MarketSymbol), algoId }]);
    if (res.ok) {
      this.logger.info("OKX_PROTECTIVE_STOP_ORDER_CANCEL_ACCEPTED", { symbol, algoId, flowId });
      return true;
    } else {
      const error = (res as any).error || "unknown_error";
      this.logger.error("OKX_PROTECTIVE_STOP_ORDER_CANCEL_FAILED", { symbol, algoId, error, flowId });
      return false;
    }
  }

  /**
   * [CENTRALIZED] Cleans up all engine-owned protective algo orders for a closed position.
   * Scans OKX for algo orders prefixed with 'oap' + position-specific openedAt base36.
   */
  private async cancelProtectionOrdersForClosedPosition(
    symbol: string,
    posSide: "long" | "short",
    openedAt: number,
    reason: string
  ): Promise<void> {
    if (!this.okxDemo) return;
    const instId = toOkxSwapInstId(symbol);
    const openedAt36 = openedAt.toString(36);
    // Unique but identifiable prefix for this specific position instance
    const engineOwnedPrefix = `oap${symbol.slice(0, 5)}${posSide[0]}${openedAt36}`;

    try {
      const pendingTry = await this.okxDemo.getOrdersAlgoPending({ instType: "SWAP", instId });
      if (!pendingTry.ok) {
        this.logger.error("PROTECTIVE_ORDER_CANCEL_QUERY_FAILED", { symbol, openedAt, error: pendingTry.error });
        return;
      }

      const cancelTargets = pendingTry.value.filter(algo => {
        const clOrdId = String(algo.algoClOrdId || "");
        return clOrdId.startsWith(engineOwnedPrefix);
      });

      if (cancelTargets.length === 0) {
        this.logger.info("PROTECTIVE_ORDER_CLOSE_CLEANUP_SKIPPED_NO_TARGETS", { symbol, openedAt, reason });
        return;
      }

      this.logger.info("PROTECTIVE_ORDER_CLOSE_CLEANUP_PLAN_PROOF", {
        symbol,
        posSide,
        openedAt,
        target_count: cancelTargets.length,
        algo_ids: cancelTargets.map(t => t.algoId),
        cl_ord_ids: cancelTargets.map(t => t.algoClOrdId),
        reason
      });

      const results: Array<{ algoId: string; success: boolean; error?: string }> = [];
      for (const target of cancelTargets) {
        const res = await this.okxDemo.cancelAlgoOrder([{ instId, algoId: String(target.algoId) }]);
        results.push({ 
          algoId: String(target.algoId), 
          success: res.ok, 
          error: res.ok ? undefined : (res as any).error || "unknown" 
        });
      }

      // [HARDENING] Post-cancellation verification
      await new Promise(resolve => setTimeout(resolve, 500));
      const verifyTry = await this.okxDemo.getOrdersAlgoPending({ instType: "SWAP", instId });
      let remainingCount = 0;
      let finalOrphanClean = false;

      if (verifyTry.ok && verifyTry.value) {
        remainingCount = verifyTry.value.filter(algo => String(algo.algoClOrdId || "").startsWith(engineOwnedPrefix)).length;
        finalOrphanClean = remainingCount === 0;
      } else if (!verifyTry.ok) {
        remainingCount = -1; // unknown
        finalOrphanClean = false; // Query failed, cannot confirm clean
      }

      const allSuccess = results.every(r => r.success) && finalOrphanClean;

      this.logger.info("PROTECTIVE_ORDER_CLOSE_CLEANUP_RESULT", {
        symbol,
        posSide,
        openedAt,
        all_success: allSuccess,
        results,
        remaining_engine_owned_count: remainingCount,
        final_orphan_clean: finalOrphanClean
      });

      if (!allSuccess || remainingCount > 0) {
        // [HARDENING] Block symbol if cleanup failed or residue remains
        this.symbolProtectionFailedBlocked.add(symbol);
        this.logger.error("PROTECTIVE_ORDER_CLEANUP_FAILED_BLOCKING_SYMBOL", { 
          symbol, 
          reason: remainingCount > 0 ? "residue_detected_after_cleanup" : "cleanup_call_failed",
          failed_count: results.filter(r => !r.success).length,
          remaining_count: remainingCount
        });
      }

    } catch (e) {
      this.logger.error("PROTECTIVE_ORDER_CLOSE_CLEANUP_CRASH", {
        symbol,
        openedAt,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  private extractOkxOrderAlgoRowCodes(diagnostics: OkxPublicDiagnostics | undefined): {
    sCode: string | null;
    sMsg: string | null;
  } {
    const data = diagnostics?.okxData;
    if (Array.isArray(data) && data.length > 0) {
      const row = data[0] as Record<string, unknown>;
      const sCode = row.sCode != null ? String(row.sCode) : null;
      const sMsg = row.sMsg != null ? String(row.sMsg) : null;
      if ((sCode && sCode.length > 0) || (sMsg && sMsg.length > 0)) {
        return { sCode, sMsg };
      }
    }
    return {
      sCode: diagnostics?.retCode != null ? String(diagnostics.retCode) : null,
      sMsg: diagnostics?.retMsg != null ? String(diagnostics.retMsg) : null
    };
  }

  private validateProtectiveOkxTriggerLayout(input: {
    positionSide: "long" | "short";
    lastPx: number;
    slTriggerPx: number;
    tpTriggerPx: number | null | undefined;
  }): { ok: true } | { ok: false; violations: string[] } {
    const { positionSide, lastPx, slTriggerPx, tpTriggerPx } = input;
    const violations: string[] = [];
    if (!Number.isFinite(lastPx) || lastPx <= 0) {
      violations.push("LAST_PRICE_INVALID");
      return { ok: false, violations };
    }
    if (!Number.isFinite(slTriggerPx) || slTriggerPx <= 0) {
      violations.push("SL_TRIGGER_INVALID");
      return { ok: false, violations };
    }
    if (positionSide === "long") {
      if (!(slTriggerPx < lastPx)) violations.push("LONG_SL_MUST_BE_BELOW_LAST");
      if (tpTriggerPx != null && Number.isFinite(tpTriggerPx) && tpTriggerPx > 0 && !(tpTriggerPx > lastPx)) {
        violations.push("LONG_TP_MUST_BE_ABOVE_LAST");
      }
    } else {
      if (!(slTriggerPx > lastPx)) violations.push("SHORT_SL_MUST_BE_ABOVE_LAST");
      if (tpTriggerPx != null && Number.isFinite(tpTriggerPx) && tpTriggerPx > 0 && !(tpTriggerPx < lastPx)) {
        violations.push("SHORT_TP_MUST_BE_BELOW_LAST");
      }
    }
    return violations.length === 0 ? { ok: true } : { ok: false, violations };
  }

  public async ensureProtectiveStopOrder(
    open: PaperOpenPositionRecord,
    flowId: string,
    pricingLastInput?: number,
    protectionSource?: "post_fill_algo" | "ops_watch_algo" | "reconcile_algo"
  ): Promise<{ modified: boolean; success: boolean; record: PaperOpenPositionRecord }> {
    if (!this.okxDemo) return { modified: false, success: false, record: open };

    if (open.symbol === "BTCUSDT") {
      if (this.isBtcSuppressionTarget()) {
        await this.logAndSuppressBtcUsdtAction("ensureProtectiveStopOrder", open.side, ["order submit", "PROTECTIVE_ENSURE"]);
        return { modified: false, success: true, record: open };
      }
    }

    const instId = toOkxSwapInstId(open.symbol);
    const openedAt36 = open.openedAt.toString(36);
    // Unique but identifiable prefix for this specific position instance
    // Format: oap{shortSymbol}{sideChar}{openedAtBase36}
    const engineOwnedPrefix = `oap${open.symbol.slice(0, 5)}${open.side[0]}${openedAt36}`; 
    const slAlgoClOrdId = `${engineOwnedPrefix}s`;
    const tpAlgoClOrdId = `${engineOwnedPrefix}t`;

    const symSideKey = `${open.symbol}:${open.side}`;
    const paperOpensForSync = await this.positions.loadOpenAll();
    const syncSnap = buildLedgerOkxPositionSyncSnapshot(paperOpensForSync, this.lastLivePositionsPayload, this.instrumentCache);
    const isTrueExternalManual = syncSnap.ignored_external_manual_keys.includes(symSideKey);

    if (isTrueExternalManual) {
      this.logger.info("V2_PROTECTIVE_STOP_SKIP_TRUE_EXTERNAL_MANUAL_PROOF", {
        symbol: open.symbol,
        side: open.side,
        lifecycle: open.lifecycleState,
        flowId
      });
      return { modified: false, success: true, record: open };
    }

    // 1. Position Context & Mode Check
    const cfgTry = await this.okxDemo.getAccountConfig();
    if (!cfgTry.ok || !cfgTry.value?.[0]) {
      this.logger.error("PROTECTIVE_ORDER_ACCOUNT_CONFIG_FAILED_PROOF", {
        symbol: open.symbol,
        side: open.side,
        flowId,
        error: cfgTry.ok ? "empty_data" : (cfgTry as any).error,
        diag: cfgTry.diagnostics
      });
      this.symbolProtectionFailedBlocked.add(open.symbol);
      return { modified: false, success: false, record: { ...open, isProtectionFailed: true } };
    }
    const accountConfig = cfgTry.value[0] as any;
    const okxPosMode = String(accountConfig.posMode ?? "").trim().toLowerCase();

    const posTry = await this.okxDemo.getPositions();
    if (!posTry.ok) {
      this.logger.error("PROTECTIVE_ORDER_POSITION_QUERY_FAILED_PROOF", {
        symbol: open.symbol,
        flowId,
        error: posTry.error
      });
      this.symbolProtectionFailedBlocked.add(open.symbol);
      return { modified: false, success: false, record: { ...open, isProtectionFailed: true } };
    }
    
    const actualPos = posTry.value.find(p => {
      const sameInst = p.instId === instId;
      if (!sameInst) return false;
      if (okxPosMode === "long_short_mode") {
        return p.posSide === (open.side === "long" ? "long" : "short");
      }
      return true; // net mode
    });

    if (!actualPos) {
      this.logger.warn("PROTECTIVE_ORDER_SKIP_NO_ACTUAL_POSITION", {
        symbol: open.symbol,
        side: open.side,
        flowId,
        detail: "Ledger has position but OKX reports none for this symbol/side; skipping protection until sync."
      });
      return { modified: false, success: true, record: open };
    }

    const actualMgnMode = String(actualPos.mgnMode || "cross").toLowerCase() as "isolated" | "cross";
    const tdModeUsed = actualMgnMode;
    const actualSz = Math.abs(Number(actualPos.pos || 0));
    const contractsToProtect = actualSz;

    // 2. Derive Target Prices
    let activeStopPrice = open.stopPrice ?? (open as any).ledger_stop_px;
    let activeTpPrice = open.targetPrice1;

    // V2 Breakeven Promotion: If BE is required and better than current SL, use BE
    if (open.breakevenStopRequired === true && open.breakevenStopPrice != null) {
      const isBetter = open.side === "long"
        ? open.breakevenStopPrice > (activeStopPrice ?? -999999)
        : open.breakevenStopPrice < (activeStopPrice ?? 999999);
      if (isBetter) {
        activeStopPrice = open.breakevenStopPrice;
      }
    }
    
    const regime = regimeForSl(open.regimeAtEntry);
    const refPx = Number(actualPos.avgPx) || open.avgPx || open.entryPrice;

    if (!activeStopPrice || !Number.isFinite(activeStopPrice)) {
      if (open.isV2Authority !== true) {
        const mirroredSl = engineMirrorStopPrice(refPx, open.side, regime);
        if (mirroredSl != null && Number.isFinite(mirroredSl)) {
          activeStopPrice = mirroredSl;
        }
      }
    }
    if (!activeTpPrice || !Number.isFinite(activeTpPrice)) {
      if (open.isV2Authority !== true) {
        const mirroredTp = engineMirrorTpPrice(refPx, open.side, regime);
        if (mirroredTp != null && Number.isFinite(mirroredTp)) {
          activeTpPrice = mirroredTp;
        }
      }
    }

    if (!activeStopPrice || !Number.isFinite(activeStopPrice)) {
      this.logger.error("PROTECTIVE_ORDER_SUBMIT_FAILED", {
        symbol: open.symbol,
        side: open.side,
        flowId,
        reason: "no_sl_price_after_mirror"
      });
      this.symbolProtectionFailedBlocked.add(open.symbol);
      return { modified: false, success: false, record: { ...open, isProtectionFailed: true } };
    }

    let pricingLast = pricingLastInput;
    if (!pricingLast || pricingLast <= 0) pricingLast = refPx;
    if (!pricingLast || pricingLast <= 0) pricingLast = this.lastTickSymbolSnapshotBySymbol.get(open.symbol)?.lastPrice;
    if (!pricingLast || pricingLast <= 0) pricingLast = 0;

    const tickerTry = await this.okxDemo.tryGetTicker(open.symbol);
    const lastPxForOkx = tickerTry.ok ? tickerTry.value.last : pricingLast;
    const wantsTp = activeTpPrice != null && Number.isFinite(activeTpPrice) && activeTpPrice > 0;

    this.logger.info("PROTECTIVE_ORDER_POSITION_CONTEXT_PROOF", {
      symbol: open.symbol,
      positionSide: open.side,
      okxPosSide: actualPos.posSide,
      accountPosMode: okxPosMode,
      actualMgnMode,
      tdModeUsed,
      positionSize: actualSz,
      entryPrice: refPx,
      ledgerPositionId: open.openedAt
    });

    // [VALIDATOR] Trigger price layout check
    const layoutCheck = this.validateProtectiveOkxTriggerLayout({ 
      positionSide: open.side, 
      lastPx: lastPxForOkx, 
      slTriggerPx: activeStopPrice, 
      tpTriggerPx: wantsTp ? activeTpPrice : null 
    });
    if (!layoutCheck.ok) {
      this.logger.error("PROTECTIVE_ORDER_LAYOUT_INVALID", { symbol: open.symbol, violations: layoutCheck.violations, flowId });
      this.symbolProtectionFailedBlocked.add(open.symbol);
      return { modified: false, success: false, record: { ...open, isProtectionFailed: true } };
    }

    // 3. Pending Algo Scan
    const pendingTry = await this.okxDemo.getOrdersAlgoPending({ instType: "SWAP", instId });
    if (!pendingTry.ok) {
      this.logger.error("PROTECTIVE_ORDER_PENDING_QUERY_FAILED_PROOF", {
        symbol: open.symbol,
        flowId,
        error: pendingTry.error
      });
      return { modified: false, success: false, record: { ...open, isProtectionFailed: true } };
    }

    const pendingAlgos = pendingTry.value;
    let engineOwnedSl: any = null;
    let engineOwnedTp: any = null;
    let duplicateSlCount = 0;
    let duplicateTpCount = 0;
    let manualUnknownCount = 0;
    let wrongTdModeCount = 0;
    let wrongSizeCount = 0;
    let wrongSideCount = 0;
    let wrongPriceCount = 0;
    let structuralFallbackSlCount = 0;
    let structuralFallbackTpCount = 0;
    let anonymousManualCount = 0;
    
    const cancelTargets: Array<{ instId: string; algoId: string }> = [];
    const expectedSide = open.side === "long" ? "sell" : "buy";

    const cachedSizing = this.instrumentCache.get(instId) as any;
    const tickSz = cachedSizing?.tickSz ? Number(cachedSizing.tickSz) : 1e-8;
    const priceTolerance = Math.max(tickSz, 1e-8);
    const isPriceMatch = (pxA: number, pxB: number) => Math.abs(pxA - pxB) <= priceTolerance;

    for (const algo of pendingAlgos) {
      const curAlgoClOrdId = String(algo.algoClOrdId || "");
      const isOapPrefix = curAlgoClOrdId.startsWith("oap");
      const isEmptyId = curAlgoClOrdId === "";
      const isMyPosition = isOapPrefix ? curAlgoClOrdId.includes(openedAt36) : false;
      
      const hasSlTrigger = (algo.slTriggerPx && Number(algo.slTriggerPx) > 0);
      const hasTpTrigger = (algo.tpTriggerPx && Number(algo.tpTriggerPx) > 0);
      const isOco = algo.ordType === "oco";
      
      const isSlLeg = hasSlTrigger || (isOco && !hasTpTrigger); // OCO usually has both, but safety first
      const isTpLeg = hasTpTrigger || (isOco && !hasSlTrigger);

      if (!isOapPrefix && !isEmptyId) {
        manualUnknownCount++;
        continue;
      }

      const algoTdMode = String(algo.tdMode).toLowerCase();
      const algoSz = Number(algo.sz);
      const algoSide = algo.side;
      const algoPosSide = String(algo.posSide || "net").toLowerCase();
      const algoReduceOnly = algo.reduceOnly === true || String(algo.reduceOnly).toLowerCase() === "true";

      let isWrong = false;
      if (algoTdMode !== tdModeUsed) { wrongTdModeCount++; isWrong = true; }
      if (Math.abs(algoSz - contractsToProtect) > 1e-8) { wrongSizeCount++; isWrong = true; }
      if (algoSide !== expectedSide) { wrongSideCount++; isWrong = true; }
      
      if (hasSlTrigger && !isPriceMatch(Number(algo.slTriggerPx), activeStopPrice)) { wrongPriceCount++; isWrong = true; }
      if (hasTpTrigger && wantsTp && !isPriceMatch(Number(algo.tpTriggerPx), activeTpPrice!)) { wrongPriceCount++; isWrong = true; }

      let isStructuralFallback = false;
      if (isEmptyId) {
        const strictMatch = !isWrong && 
                            algo.instId === instId && 
                            algoReduceOnly && 
                            (algoPosSide === "net" || algoPosSide === open.side);
        if (strictMatch) {
          isStructuralFallback = true;
        } else {
          anonymousManualCount++;
          continue;
        }
      }

      const isOwnedOrAdopted = isMyPosition || isStructuralFallback;

      if (hasSlTrigger || (isOco && wantsTp)) {
        if (!engineOwnedSl && !isWrong && isOwnedOrAdopted) {
          engineOwnedSl = algo;
          if (isStructuralFallback) structuralFallbackSlCount++;
        } else {
          duplicateSlCount++;
          if (!isStructuralFallback) cancelTargets.push({ instId, algoId: algo.algoId as string });
        }
      }
      
      if (hasTpTrigger || (isOco && wantsTp)) {
        if (engineOwnedSl && engineOwnedSl.algoId === algo.algoId) {
          engineOwnedTp = algo;
          if (isStructuralFallback && !structuralFallbackSlCount) structuralFallbackTpCount++; // Ensure we don't double count if it's the exact same OCO object
          else if (isStructuralFallback && engineOwnedSl.algoId !== algo.algoId) structuralFallbackTpCount++;
          else if (isStructuralFallback && engineOwnedSl.algoId === algo.algoId) structuralFallbackTpCount++; // actually we should count both legs if we want
        } else if (!engineOwnedTp && !isWrong && isOwnedOrAdopted) {
          engineOwnedTp = algo;
          if (isStructuralFallback) structuralFallbackTpCount++;
        } else {
          duplicateTpCount++;
          if (!isStructuralFallback && !cancelTargets.some(t => t.algoId === algo.algoId)) {
            cancelTargets.push({ instId, algoId: algo.algoId as string });
          }
        }
      }
    }
    
    // V2 Breakeven Confirmation
    if (engineOwnedSl && open.breakevenStopRequired === true && open.breakevenStopPrice != null) {
      const confirmedPx = Number(engineOwnedSl.slTriggerPx);
      const isConfirmed = open.side === "long"
        ? confirmedPx >= open.breakevenStopPrice - 1e-8
        : confirmedPx <= open.breakevenStopPrice + 1e-8;
      
      open.breakevenStopConfirmed = isConfirmed;
      if (isConfirmed) {
        open.breakevenStopConfirmedAt = Date.now();
        open.breakevenStopAlgoId = engineOwnedSl.algoId;
        open.breakevenStopConfirmSource = "okx_pending_algo";
      }

      this.logger.info("V2_BREAKEVEN_STOP_CONFIRM_PROOF", {
        symbol: open.symbol,
        side: open.side,
        requiredBreakevenStopPrice: open.breakevenStopPrice,
        confirmedStopPrice: confirmedPx,
        confirmed: isConfirmed,
        algoId: engineOwnedSl.algoId,
        pendingAlgoCount: pendingAlgos.length
      });
    } else if (open.breakevenStopRequired === false || open.breakevenStopRequired === undefined) {
      open.breakevenStopConfirmed = false; // Reset if not required
    }

    // [V2_ADDON_GATING] Atomic Rebuild Trigger
    if (open.addonRebuildRequired === true) {
      // Capture pre-rebuild state
      open.addonRebuildMetrics = {
        oldSize: open.initialSizeUsd ?? open.sizeUsd, 
        newSize: actualSz, 
        oldAvgEntry: open.entryPrice,
        newAvgEntry: Number(actualPos.avgPx) || open.entryPrice,
        rebuildStartedAt: Date.now(),
        fillConfirmed: true
      };

      this.logger.info("V2_ADDON_POST_FILL_PROTECTION_REBUILD_START_PROOF", {
        symbol: open.symbol,
        side: open.side,
        reason: "addon_fill_detected",
        old_sl_algo_id: engineOwnedSl?.algoId,
        old_tp_algo_id: engineOwnedTp?.algoId,
        ...open.addonRebuildMetrics
      });

      // Force cleanup by treating them as duplicates/wrong
      if (engineOwnedSl && !cancelTargets.some(t => t.algoId === engineOwnedSl.algoId)) {
        cancelTargets.push({ instId, algoId: engineOwnedSl.algoId });
      }
      if (engineOwnedTp && !cancelTargets.some(t => t.algoId === engineOwnedTp.algoId)) {
        cancelTargets.push({ instId, algoId: engineOwnedTp.algoId });
      }
      
      engineOwnedSl = null;
      engineOwnedTp = null;
      open.addonRebuildRequired = false; 
      open.addonRebuildPendingConfirmation = true;
    }

    this.logger.info("PROTECTIVE_ORDER_PENDING_ALGO_SCAN_PROOF", {
      symbol: open.symbol,
      pendingAlgoCount: pendingAlgos.length,
      engineOwnedSlCount: engineOwnedSl ? 1 : 0,
      engineOwnedTpCount: engineOwnedTp ? 1 : 0,
      manualUnknownCount,
      duplicateSlCount,
      duplicateTpCount,
      wrongTdModeCount,
      wrongSizeCount,
      wrongSideCount,
      wrongPriceCount,
      structuralFallbackSlCount,
      structuralFallbackTpCount,
      anonymousManualCount,
      breakevenStopConfirmed: open.breakevenStopConfirmed ?? false
    });

    // 4. Reconcile Plan
    const needSubmitSl = !engineOwnedSl;
    const needSubmitTp = wantsTp && !engineOwnedTp;
    
    this.logger.info("PROTECTIVE_ORDER_RECONCILE_PLAN_PROOF", {
      symbol: open.symbol,
      action: (needSubmitSl || needSubmitTp || cancelTargets.length > 0) ? "MODIFY" : "KEEP",
      reason: needSubmitSl ? "missing_sl" : needSubmitTp ? "missing_tp" : cancelTargets.length > 0 ? "cleanup_duplicates" : "reconciled",
      needSubmitSl,
      needSubmitTp,
      needCancelDuplicate: cancelTargets.length > 0,
      cancelTargetsCount: cancelTargets.length,
      manualOrdersIgnoredCount: manualUnknownCount
    });

    // 5. Execution
    let modified = false;
    if (cancelTargets.length > 0) {
      await this.okxDemo.cancelAlgoOrder(cancelTargets);
      modified = true;
    }

    const hedgePosSide = open.side === "long" ? "long" : "short";
    const inst = this.instrumentCache.get(instId);
    const szStr = inst ? this.normalizeOkxReduceOrderSize({ 
      symbol: open.symbol, 
      okxContracts: contractsToProtect, 
      sizing: inst, 
      flowId, 
      reason: "protective_stop_registration" 
    }).normalized_sz : String(contractsToProtect);

    if (needSubmitSl) {
      if (open.breakevenStopRequired === true) {
        this.logger.info("V2_BREAKEVEN_STOP_UPDATE_SUBMIT_PROOF", {
          symbol: open.symbol,
          side: open.side,
          requiredBreakevenStopPrice: open.breakevenStopPrice,
          activeStopPrice,
          flowId,
          ts: Date.now()
        });
      }
      const slRes = await this.okxDemo.submitAlgoOrder({
        instId, tdMode: tdModeUsed, side: expectedSide, posSide: hedgePosSide, accountPosMode: okxPosMode,
        ordType: "conditional", sz: szStr, reduceOnly: true,
        slTriggerPx: String(activeStopPrice), slOrdPx: "-1", slTriggerPxType: "last",
        algoClOrdId: slAlgoClOrdId
      });
      if (slRes.ok) {
        modified = true;
        this.logger.info("PROTECTIVE_STOP_SUBMIT_RESULT", { symbol: open.symbol, success: true, algoId: slRes.value[0].algoId, flowId });
      } else {
        this.logger.error("PROTECTIVE_STOP_SUBMIT_FAILED", { symbol: open.symbol, flowId, diag: slRes.diagnostics });
      }
    }

    if (needSubmitTp) {
      const tpRes = await this.okxDemo.submitAlgoOrder({
        instId, tdMode: tdModeUsed, side: expectedSide, posSide: hedgePosSide, accountPosMode: okxPosMode,
        ordType: "conditional", sz: szStr, reduceOnly: true,
        tpTriggerPx: String(activeTpPrice), tpOrdPx: "-1", tpTriggerPxType: "last",
        algoClOrdId: tpAlgoClOrdId
      });
      if (tpRes.ok) {
        modified = true;
        this.logger.info("TAKE_PROFIT_SUBMIT_RESULT", { symbol: open.symbol, success: true, algoId: tpRes.value[0].algoId, flowId });
      } else {
        this.logger.error("TAKE_PROFIT_SUBMIT_FAILED", { symbol: open.symbol, flowId, diag: tpRes.diagnostics });
      }
    }

    // 6. Final State Evaluation (Success only if confirmed in scan, or just submitted successfully)
    // We strictly use the scan results for "registered" status to ensure ground truth.
    // If we just submitted, it will be picked up in the next tick's scan.
    const slRegistered = !!engineOwnedSl;
    const tpRegistered = !wantsTp || !!engineOwnedTp;
    const protectionSuccess = slRegistered && tpRegistered;

    this.logger.info("PROTECTIVE_ORDER_FINAL_STATE_PROOF", {
      symbol: open.symbol,
      slRegistered,
      tpRegistered,
      slAlgoId: engineOwnedSl?.algoId,
      tpAlgoId: engineOwnedTp?.algoId,
      protectionSuccess,
      isProtectionFailed: !protectionSuccess
    });
    
    // Final Atomic Rebuild Completion Gate
    if (open.addonRebuildPendingConfirmation === true && protectionSuccess === true) {
      this.logger.info("V2_ADDON_POST_FILL_PROTECTION_REBUILD_PROOF", {
        symbol: open.symbol,
        side: open.side,
        fillConfirmed: open.addonRebuildMetrics?.fillConfirmed ?? true,
        oldSize: open.addonRebuildMetrics?.oldSize,
        newSize: open.addonRebuildMetrics?.newSize,
        oldAvgEntry: open.addonRebuildMetrics?.oldAvgEntry,
        newAvgEntry: open.addonRebuildMetrics?.newAvgEntry,
        slRebuilt: slRegistered,
        tpRebuilt: tpRegistered,
        pendingConfirmed: true,
        protectionSuccess: true,
        ts: Date.now()
      });
      open.addonRebuildPendingConfirmation = false;
      open.addonRebuildMetrics = undefined;
    }

    const updatedRecord: PaperOpenPositionRecord = {
      ...open,
      stopPrice: activeStopPrice,
      targetPrice1: wantsTp ? activeTpPrice : undefined,
      protectiveSlAlgoId: engineOwnedSl?.algoId as (string | undefined),
      protectiveTpAlgoId: engineOwnedTp?.algoId as (string | undefined),
      isProtectiveStopRegistered: slRegistered,
      isTakeProfitRegistered: tpRegistered,
      isProtectionFailed: !protectionSuccess
    };

    if (!protectionSuccess) {
      this.symbolProtectionFailedBlocked.add(open.symbol);
    } else {
      this.symbolProtectionFailedBlocked.delete(open.symbol);
    }

    return { modified, success: protectionSuccess, record: updatedRecord };
  }

  public async submitOkxOrder(input: {
    symbol: MarketSymbol;
    side: "buy" | "sell";
    posSide: "long" | "short";
    qty: number;
    clOrdId: string;
    traceId: string;
    reason: string;
    authoritySource?: string | null;
    adoptedEngine?: string | null;
    entryQualityGrade?: string | null;
    leverageProfile?: string | null;
    appliedLeverage?: number | null;
    marketSubtype?: string | null;
    marketRegime?: string | null;
    isAddOn?: boolean;
    entryPrice?: number | null;
    stopPrice?: number | null;
    takeProfitPrice?: number | null;
    paperExecutionReady?: boolean;
    stageMarginKrw?: number | null;
    exposureNotionalKrw?: number | null;
    isNewEntry: boolean;
    orderNotionalUsdt?: number | null;
    /** Explicit USDT notional for SWAP contract sizing (e.g. close margin * leverage). */
    desiredNotionalUsdt?: number | null;
    /** Mark/last price for `notional / (price * ctVal)` when ticker not yet loaded here. */
    pricingReferencePx?: number | null;
    reduceOnly?: boolean;
    ordType?: "market" | "limit";
    /** Explicit contract count for accurate reduction/close */
    okxContracts?: number;
  }): Promise<{
    ok: boolean;
    ordId: string | null;
    fillPx: string | number | null;
    fillSize: number;
    errorCode: string | null;
    errorMessage: string | null;
    ackCode: "accepted" | "rejected";
    orderState: string | null;
    fillConfirmed: boolean;
    submittedContractSz?: string | null;
    okxContracts?: number;
    baseQty?: number;
    notionalUsd?: number;
    avgPx?: number;
    clOrdId: string;
  }> {
    if (!this.okxDemo) {
      return { ok: false, ordId: null, fillPx: null, fillSize: 0, errorCode: "no_client", errorMessage: "OKX signed client not initialized", ackCode: "rejected", orderState: null, fillConfirmed: false, clOrdId: input.clOrdId };
    }
    const instId = toOkxSwapInstId(input.symbol);
    const logCtx = {
      order_trace_id: input.traceId,
      symbol: input.symbol,
      instId,
      side: input.side,
      posSide: input.posSide,
      qty: input.qty,
      clOrdId: input.clOrdId,
      order_reason: input.reason,
      order_ts: Date.now(),
      authority_source: input.authoritySource ?? null,
      adopted_engine: input.adoptedEngine ?? null,
      entry_quality_grade: input.entryQualityGrade ?? null,
      leverage_profile: input.leverageProfile ?? null,
      applied_leverage: input.appliedLeverage ?? null,
      paper_execution_ready: input.paperExecutionReady ?? this.paperExecutionReady,
      signed_execution_ready: this.signedExecutionReady,
      live_order_notional_usdt: null as number | null,
      live_cap_passed: null as boolean | null,
      live_cap_block_reason: null as string | null,
      available_balance_usdt: this.okxAvailableBalanceUsdt,
      ...this.okxAuthProofContext()
    };

    const rawSymbolStr = String(input.symbol);
    const clOrdId_alnum_only = /^[A-Za-z0-9]+$/.test(input.clOrdId);
    const clOrdId_max32 = input.clOrdId.length <= 32;
    this.logger.info("OKX_CLIENT_ORDER_ID_PROOF", {
      symbol: input.symbol,
      side: input.side,
      raw_symbol: rawSymbolStr,
      clOrdId: input.clOrdId,
      clOrdId_length: input.clOrdId.length,
      clOrdId_alnum_only,
      clOrdId_max32
    });
    if (!clOrdId_alnum_only || !clOrdId_max32) {
      this.logger.info("ORDER_BUILD_FAIL", {
        order_build_fail_reason: "OKX_CLIENT_ORDER_ID_INVALID",
        symbol: input.symbol,
        side: input.side,
        raw_symbol: rawSymbolStr,
        clOrdId: input.clOrdId,
        clOrdId_length: input.clOrdId.length,
        clOrdId_alnum_only,
        clOrdId_max32
      });
      return {
        ok: false,
        ordId: null,
        fillPx: null,
        fillSize: 0,
        errorCode: "OKX_CLIENT_ORDER_ID_INVALID",
        errorMessage: "clOrdId must be alphanumeric ASCII only and length <= 32",
        ackCode: "rejected",
        orderState: null,
        fillConfirmed: false,
        clOrdId: input.clOrdId
      };
    }

    if (!this.signedExecutionReady) {
      const reason = "SIGNED_EXECUTION_NOT_READY";
      const tag =
        input.reason.indexOf("close") !== -1
          ? "SIGNED_CLOSE_SUBMIT_SKIPPED_NOT_READY"
          : input.reason.indexOf("scale_in") !== -1
            ? "SIGNED_SCALE_IN_SUBMIT_SKIPPED_NOT_READY"
            : "SIGNED_ORDER_SUBMIT_SKIPPED_NOT_READY";
      this.logger.warn("SIGNED_EXECUTION_NOT_READY", { ...logCtx, reason });
      this.logger.warn(tag, { ...logCtx, reason });
      return { ok: false, ordId: null, fillPx: null, fillSize: 0, errorCode: "signed_not_ready", errorMessage: "OKX signed REST smoke test not passed", ackCode: "rejected", orderState: null, fillConfirmed: false, clOrdId: input.clOrdId };
    }

    const instTryAll = await this.okxDemo.tryGetInstrument(instId);
    if (!instTryAll.ok || !instTryAll.value) {
      this.logger.info("ORDER_BUILD_FAIL", {
        order_build_fail_reason: "OKX_INSTRUMENT_FETCH_FAILED",
        symbol: input.symbol,
        instId,
        error: instTryAll.ok ? null : (instTryAll as any).error
      });
      return {
        ok: false,
        ordId: null,
        fillPx: null,
        fillSize: 0,
        errorCode: "OKX_INSTRUMENT_FETCH_FAILED",
        errorMessage: instTryAll.ok ? "empty_instrument" : (instTryAll as any).error,
        ackCode: "rejected",
        orderState: null,
        fillConfirmed: false,
        clOrdId: input.clOrdId
      };
    }
    const sizingMeta = parseOkxSwapInstrumentSizing(instTryAll.value as Record<string, unknown>);
    if (!sizingMeta) {
      this.logger.info("ORDER_BUILD_FAIL", {
        order_build_fail_reason: "OKX_INSTRUMENT_SIZING_METADATA_INVALID",
        symbol: input.symbol,
        instId,
        instrument_keys: Object.keys(instTryAll.value as object)
      });
      return {
        ok: false,
        ordId: null,
        fillPx: null,
        fillSize: 0,
        errorCode: "OKX_INSTRUMENT_SIZING_METADATA_INVALID",
        errorMessage: "instrument lotSz/minSz/ctVal missing or invalid",
        ackCode: "rejected",
        orderState: null,
        fillConfirmed: false,
        clOrdId: input.clOrdId
      };
    }

    const cfgTry = await this.okxDemo.getAccountConfig();
    if (!cfgTry.ok || !cfgTry.value?.[0]) {
      this.logger.info("ORDER_BUILD_FAIL", {
        order_build_fail_reason: "OKX_ACCOUNT_CONFIG_FETCH_FAILED",
        symbol: input.symbol,
        instId,
        error: cfgTry.ok ? "empty_data" : (cfgTry as any).error
      });
      return {
        ok: false,
        ordId: null,
        fillPx: null,
        fillSize: 0,
        errorCode: "OKX_ACCOUNT_CONFIG_FETCH_FAILED",
        errorMessage: cfgTry.ok ? "OKX account/config empty" : (cfgTry as any).error,
        ackCode: "rejected",
        orderState: null,
        fillConfirmed: false,
        clOrdId: input.clOrdId
      };
    }
    const cfgRow0 = cfgTry.value[0] as Record<string, unknown>;
    const okxAcctLv = String(cfgRow0.acctLv ?? "").trim();
    const okxPosMode = String(cfgRow0.posMode ?? "").trim();

    this.logger.info("OKX_ACCOUNT_MODE_PROOF", {
      symbol: input.symbol,
      instId,
      acctLv: okxAcctLv,
      posMode: okxPosMode,
      order_trace_id: input.traceId,
      order_reason: input.reason
    });

    if (okxAcctLv === "1") {
      this.logger.info("ORDER_BUILD_FAIL", {
        order_build_fail_reason: "OKX_ACCOUNT_MODE_INCOMPATIBLE",
        detail: "acctLv_spot_mode_derivatives",
        acctLv: okxAcctLv,
        posMode: okxPosMode,
        symbol: input.symbol,
        instId
      });
      return {
        ok: false,
        ordId: null,
        fillPx: null,
        fillSize: 0,
        errorCode: "OKX_ACCOUNT_MODE_INCOMPATIBLE",
        errorMessage: "OKX account is Spot mode (acctLv=1); SWAP orders are incompatible",
        ackCode: "rejected",
        orderState: null,
        fillConfirmed: false,
        clOrdId: input.clOrdId
      };
    }

    const orderTdMode: "isolated" | "cross" =
      okxAcctLv === "3" || okxAcctLv === "4" ? "cross" : "isolated";
    const payloadPosSide: "long" | "short" | undefined =
      okxPosMode === "long_short_mode" ? input.posSide : undefined;

    let refPrice: number | null = null;
    let final_submitted_notional_usdt: number | null = null;
    let limitPrice: number | null = null;

    if (this.config.okxAuthMode === "live") {
      const tickerTry = await this.okxPublic.tryGetTicker(input.symbol);
      if (!tickerTry.ok || tickerTry.value.bid == null || tickerTry.value.ask == null) {
        const reason = "LIVE_LIMIT_PRICE_BUILD_FAIL";
        this.logger.error(reason, { ...logCtx, detail: "ticker_missing_bid_ask" });
        return { ok: false, ordId: null, fillPx: null, fillSize: 0, errorCode: "ticker_error", errorMessage: "Failed to get bid/ask for limit order", ackCode: "rejected", orderState: null, fillConfirmed: false, clOrdId: input.clOrdId };
      }
      const ticker = tickerTry.value;
      refPrice = ticker.last;

      if (!instTryAll.value.tickSz) {
        const reason = "LIVE_LIMIT_PRICE_BUILD_FAIL";
        this.logger.error(reason, { ...logCtx, detail: "instrument_missing_tick_size" });
        return { ok: false, ordId: null, fillPx: null, fillSize: 0, errorCode: "instrument_error", errorMessage: "Failed to get tick size for limit order", ackCode: "rejected", orderState: null, fillConfirmed: false, clOrdId: input.clOrdId };
      }
      const tickSize = Number(instTryAll.value.tickSz);

      try {
        if (input.entryPrice && input.reason.includes("recovery")) {
          limitPrice = input.entryPrice;
        } else {
          limitPrice = this.buildLiveLimitOrderPrice({
            symbol: input.symbol,
            side: input.side,
            bid: ticker.bid!,
            ask: ticker.ask!,
            tickSize,
            priceBufferTicks: 1,
            purpose: input.reason
          });
        }
      } catch (e) {
        return { ok: false, ordId: null, fillPx: null, fillSize: 0, errorCode: "price_build_fail", errorMessage: String(e), ackCode: "rejected", orderState: null, fillConfirmed: false, clOrdId: input.clOrdId };
      }

      // 1. V2 Intended Metrics (Decision Basis)
      const v2_intended_qty = input.qty;
      let v2_intended_notional_usdt: number | null = null;
      if ((input.orderNotionalUsdt ?? 0) > 0) v2_intended_notional_usdt = input.orderNotionalUsdt!;
      else if ((input.desiredNotionalUsdt ?? 0) > 0) v2_intended_notional_usdt = input.desiredNotionalUsdt!;
      else if ((input.exposureNotionalKrw ?? 0) > 0)
        v2_intended_notional_usdt = input.exposureNotionalKrw! / PAPER_LEDGER_KRW_NOTIONAL_PER_USD;
      else {
        const marginUsdt = (input.stageMarginKrw ?? 0) / PAPER_LEDGER_KRW_NOTIONAL_PER_USD;
        const lev = input.appliedLeverage ?? 1;
        if (marginUsdt > 0 && lev > 0) v2_intended_notional_usdt = marginUsdt * lev;
        else if (refPrice != null && Number.isFinite(refPrice) && v2_intended_qty > 0)
          v2_intended_notional_usdt = v2_intended_qty * refPrice;
      }
      
      // v2_risk_cap_usdt represents the V2's sizing decision.
      const v2_risk_cap_usdt = v2_intended_notional_usdt;

      // 2. OKX Reality Context (Exchange State)
      const okxLeverage = await this.okxDemo.getLeverage(instId, orderTdMode);
      let okx_confirmed_leverage = okxLeverage.ok ? Number(okxLeverage.value?.[0]?.lever ?? 0) : null;
      const okx_available_balance_usdt = this.okxAvailableBalanceUsdt;

      // 3. Dynamic Capping (Execution Reality)
      // 3. Dynamic Capping (Execution Reality)
      let static_safety_cap = this.config.okxLiveMaxOrderNotionalUsdt;
      
      // V2 EXCEPTION: V2 authoritative signals bypass legacy static caps to allow 100 USDT probes
      if (input.authoritySource === "v2") {
        static_safety_cap = Math.max(static_safety_cap ?? 0, 500); 
      }

      // 3.5 Leverage Sync for V2
      if (input.authoritySource === "v2" && input.appliedLeverage != null && okx_confirmed_leverage != null && okx_confirmed_leverage !== input.appliedLeverage) {
        this.logger.info("V2_LEVERAGE_SYNC_ATTEMPT", {
          symbol: input.symbol,
          intended_leverage: input.appliedLeverage,
          current_okx_leverage: okx_confirmed_leverage
        });
        const setLevRes = await this.okxDemo.setLeverage({
          instId,
          lever: String(input.appliedLeverage),
          mgnMode: orderTdMode,
          ...(okxPosMode === "long_short_mode" ? { posSide: input.posSide } : {})
        });
        if (setLevRes.ok) {
          this.logger.info("V2_LEVERAGE_SYNC_PROOF", {
            symbol: input.symbol,
            synced_leverage: input.appliedLeverage,
            prev_leverage: okx_confirmed_leverage
          });
          okx_confirmed_leverage = input.appliedLeverage;
        } else {
          this.logger.error("V2_LEVERAGE_SYNC_FAIL", {
            symbol: input.symbol,
            error: (setLevRes as any).error,
            diagnostics: setLevRes.diagnostics
          });
        }
      }

      const okx_dynamic_notional_cap_usdt = 
        okx_available_balance_usdt != null && okx_confirmed_leverage != null
          ? (okx_available_balance_usdt * (this.config.okxLiveUsableBalanceRatio ?? 0.95)) * okx_confirmed_leverage
          : 0;

      // 4. Final Sizing Logic (Strict "Min" Policy)
      // Rule: Never expand beyond what V2 intended.
      let final_size_source: "v2_risk" | "okx_dynamic_cap" | "static_safety_cap" | "min_order_block" = "v2_risk";
      final_submitted_notional_usdt = v2_intended_notional_usdt ?? 0;

      // Constraint: Dynamic Cap (Exchange liquidity)
      if (final_submitted_notional_usdt > okx_dynamic_notional_cap_usdt) {
        final_submitted_notional_usdt = okx_dynamic_notional_cap_usdt;
        final_size_source = "okx_dynamic_cap";
      }

      // Constraint: Static Cap (Optional safety override)
      if (this.config.okxLiveStaticNotionalCapEnabled && static_safety_cap != null && final_submitted_notional_usdt > static_safety_cap) {
        final_submitted_notional_usdt = static_safety_cap;
        final_size_source = "static_safety_cap";
      }

      const logCtxReality = {
        ...logCtx,
        v2_intended_qty,
        v2_intended_notional_usdt,
        v2_risk_cap_usdt,
        okx_available_balance_usdt,
        okx_confirmed_leverage,
        okx_dynamic_notional_cap_usdt,
        final_submitted_notional_usdt,
        final_size_source,
        static_safety_cap,
        static_cap_enabled: this.config.okxLiveStaticNotionalCapEnabled,
        ref_price: refPrice
      };

      // 5. Execution Reality Proofs
      this.logger.info("OKX_EXECUTION_REALITY_PROOF", logCtxReality);
      this.logger.info("LIVE_LEVERAGE_AVAILABILITY_PROOF", {
        ...logCtxReality,
        okx_leverage_payload: okxLeverage.ok ? okxLeverage.value : null
      });

      // 6. Hard Execution Blocks
      // Guard: Verification Failure
      if (!okxLeverage.ok || okx_confirmed_leverage == null || okx_confirmed_leverage === 0 || okx_available_balance_usdt == null) {
        const reject_reason = "OKX_BALANCE_OR_LEVERAGE_UNCONFIRMED";
        this.logger.warn("EXCHANGE_REALITY_BLOCK", { ...logCtxReality, reject_reason });
        return {
          ok: false, ordId: null, fillPx: null, fillSize: 0,
          errorCode: "okx_reality_unconfirmed", 
          errorMessage: "Exchange balance or leverage could not be verified", 
          ackCode: "rejected", orderState: null, fillConfirmed: false,
          clOrdId: input.clOrdId
        };
      }

      // Guard: Leverage Mismatch (Still needed if sync failed or was skipped)
      if (input.appliedLeverage != null && okx_confirmed_leverage !== input.appliedLeverage) {
        const reject_reason = "EXCHANGE_REALITY_BLOCK";
        this.logger.warn("EXCHANGE_REALITY_BLOCK", { ...logCtxReality, reject_reason, detail: "leverage_mismatch" });
        return {
          ok: false, ordId: null, fillPx: null, 
          errorCode: "leverage_mismatch", 
          errorMessage: `Leverage mismatch: Engine=${input.appliedLeverage}, OKX=${okx_confirmed_leverage}`, 
          ackCode: "rejected", orderState: null, fillSize: 0, fillConfirmed: false,
          clOrdId: input.clOrdId
        };
      }

      // Final Liquidation Buffer Verification (Safety Layer)
      const stopPrice = Number.isFinite(input.stopPrice) ? Number(input.stopPrice) : null;
      const entryPriceVal = Number.isFinite(input.entryPrice)
        ? Number(input.entryPrice)
        : (refPrice != null && Number.isFinite(refPrice) ? refPrice : null);

      const appliedLeverage = okx_confirmed_leverage;
      let estimatedLiquidationPrice =
        appliedLeverage != null && entryPriceVal != null ? this.estimateLiquidationPrice({ side: input.side, entryPrice: entryPriceVal, leverage: appliedLeverage }) : null;

      // Reinforced Liquidation Estimation for New Entries (using Wallet Balance as additional buffer)
      if (input.isNewEntry && estimatedLiquidationPrice !== null && entryPriceVal !== null && (this.okxAvailableBalanceUsdt ?? 0) > 0) {
        const marginUsdt = (input.stageMarginKrw ?? 0) / PAPER_LEDGER_KRW_NOTIONAL_PER_USD;
        const entryPriceSafe: number = entryPriceVal;
        const notionalUsdt = (marginUsdt > 0 ? marginUsdt : (Number(input.qty) * entryPriceSafe)) * (appliedLeverage ?? 10);
        if (notionalUsdt > 0) {
          const mmr = 0.005;
          const moveFrac = Math.max(0.0001, ((this.okxAvailableBalanceUsdt ?? 0) / notionalUsdt) - mmr);
          const walletBasedLiqPrice = input.side === "buy" 
            ? entryPriceSafe * (1 - moveFrac)
            : entryPriceSafe * (1 + moveFrac);
          
          estimatedLiquidationPrice = walletBasedLiqPrice;
        }
      }
      
      const canEvaluateLiquidation = stopPrice !== null && entryPriceVal !== null && entryPriceVal > 0 && estimatedLiquidationPrice !== null;
      
      let stopDistancePct =
        canEvaluateLiquidation && stopPrice !== null && entryPriceVal !== null
          ? Math.abs(entryPriceVal - stopPrice) / Math.max(1e-9, entryPriceVal)
          : null;
      let liquidationDistancePct =
        canEvaluateLiquidation && estimatedLiquidationPrice !== null && entryPriceVal !== null
          ? Math.abs(entryPriceVal - estimatedLiquidationPrice) / Math.max(1e-9, entryPriceVal)
          : null;
      let stopBeforeLiquidation =
        canEvaluateLiquidation && estimatedLiquidationPrice !== null && stopPrice !== null && entryPriceVal !== null
          ? (input.side === "buy"
            ? (entryPriceVal > stopPrice && stopPrice > estimatedLiquidationPrice)
            : (entryPriceVal < stopPrice && stopPrice < estimatedLiquidationPrice))
          : false;
      let liquidationBufferRatio =
        stopDistancePct != null && stopDistancePct > 0 && liquidationDistancePct != null
          ? liquidationDistancePct / stopDistancePct
          : null;
      
      const requiredBufferRatio = 1.5;
      const liveLeverageAllowed =
        stopBeforeLiquidation === true &&
        liquidationBufferRatio != null &&
        liquidationBufferRatio >= requiredBufferRatio;
      
      if (!liveLeverageAllowed) {
        const isRiskReducingClose = input.reduceOnly === true && input.isNewEntry === false;
        
        if (isRiskReducingClose) {
          this.logger.info("REDUCE_ONLY_LIQUIDATION_BUFFER_BYPASS_PROOF", {
            symbol: input.symbol,
            reason: input.reason || "unknown",
            isNewEntry: input.isNewEntry,
            reduceOnly: input.reduceOnly,
            stopPrice,
            liquidationBufferRatio,
            bypass_scope: "liquidation_buffer_only"
          });
        } else {
          const isV2NewEntry = input.isNewEntry === true && input.authoritySource === "v2";
          const isLiqDataMissing = liquidationBufferRatio == null || estimatedLiquidationPrice == null || entryPriceVal == null;

          // V2 New Entry Hardening: Only allow warning if data is truly missing (N/A).
          // If data is present but buffer is insufficient, it's a hard block.
          if (isV2NewEntry && isLiqDataMissing) {
            this.logger.warn("LIQUIDATION_BUFFER_PREOPEN_UNAVAILABLE_WARNING", {
              symbol: input.symbol,
              liquidationBufferRatio,
              stopBeforeLiquidation,
              isNewEntry: true,
              authoritySource: "v2",
              notionalUsdt: v2_intended_notional_usdt,
              appliedLeverage: okx_confirmed_leverage,
              reason: "new_probe_entry_allowed_due_to_missing_liq_calc_data"
            });
          } else {
            const reject_reason = "EXCHANGE_REALITY_BLOCK";
            const detail = "LIVE_LIQUIDATION_BUFFER_INSUFFICIENT";
            const missingFields = [];
            if (stopPrice === null) missingFields.push("stopPrice");
            if (entryPriceVal === null) missingFields.push("entryPrice");
            if (estimatedLiquidationPrice === null) missingFields.push("estimatedLiquidationPrice");
            
            const errorMsg = `Live liquidation buffer insufficient (Required: ${requiredBufferRatio}, Available: ${liquidationBufferRatio?.toFixed(2) ?? "N/A"}${missingFields.length > 0 ? ", Missing: " + missingFields.join("|") : ""})`;
            this.logger.warn("EXCHANGE_REALITY_BLOCK", { 
              ...logCtxReality, 
              reject_reason, 
              detail, 
              error: errorMsg,
              stopPrice,
              entryPrice: entryPriceVal,
              estimatedLiquidationPrice,
              isNewEntry: input.isNewEntry,
              walletBalance: this.okxAvailableBalanceUsdt,
              stopBeforeLiquidation,
              liquidationBufferRatio
            });
            return {
              ok: false, ordId: null, fillPx: null, fillSize: 0,
              errorCode: "live_liquidation_buffer_insufficient", 
              errorMessage: errorMsg, 
              ackCode: "rejected", orderState: null, fillConfirmed: false,
              clOrdId: input.clOrdId
            };
          }
        }
      }
    }

    let pricingLast: number | null = refPrice;
    let effectiveNotionalUsdt: number | null =
      this.config.okxAuthMode === "live" ? final_submitted_notional_usdt : null;

    if (this.config.okxAuthMode !== "live") {
      pricingLast = input.pricingReferencePx ?? input.entryPrice ?? null;
      if (pricingLast == null || !Number.isFinite(pricingLast)) {
        const tickerDemo = await this.okxPublic.tryGetTicker(input.symbol);
        if (!tickerDemo.ok || !Number.isFinite(tickerDemo.value.last)) {
          this.logger.error("ORDER_BUILD_FAIL", {
            order_build_fail_reason: "OKX_TICKER_FOR_SIZE_UNAVAILABLE",
            symbol: input.symbol,
            instId
          });
          return {
            ok: false,
            ordId: null,
            fillPx: null,
            fillSize: 0,
            errorCode: "ticker_error",
            errorMessage: "Failed to get last price for OKX contract sizing",
            ackCode: "rejected",
            orderState: null,
            fillConfirmed: false,
            clOrdId: input.clOrdId
          };
        }
        pricingLast = tickerDemo.value.last;
      }
      if ((input.orderNotionalUsdt ?? 0) > 0) effectiveNotionalUsdt = input.orderNotionalUsdt!;
      else if ((input.desiredNotionalUsdt ?? 0) > 0) effectiveNotionalUsdt = input.desiredNotionalUsdt!;
      else if ((input.exposureNotionalKrw ?? 0) > 0)
        effectiveNotionalUsdt = input.exposureNotionalKrw! / PAPER_LEDGER_KRW_NOTIONAL_PER_USD;
      else {
        const marginUsdt = (input.stageMarginKrw ?? 0) / PAPER_LEDGER_KRW_NOTIONAL_PER_USD;
        const lev = input.appliedLeverage ?? 1;
        if (marginUsdt > 0 && lev > 0) effectiveNotionalUsdt = marginUsdt * lev;
        else if (pricingLast != null && Number.isFinite(pricingLast) && input.qty > 0)
          effectiveNotionalUsdt = input.qty * pricingLast;
      }
    }

    if (
      effectiveNotionalUsdt == null ||
      !Number.isFinite(effectiveNotionalUsdt) ||
      effectiveNotionalUsdt <= 0 ||
      pricingLast == null ||
      !Number.isFinite(pricingLast) ||
      pricingLast <= 0
    ) {
      this.logger.info("ORDER_BUILD_FAIL", {
        order_build_fail_reason: "OKX_ORDER_NOTIONAL_OR_PRICE_INVALID",
        symbol: input.symbol,
        instId,
        effectiveNotionalUsdt,
        pricingLast
      });
      return {
        ok: false,
        ordId: null,
        fillPx: null,
        fillSize: 0,
        errorCode: "OKX_ORDER_NOTIONAL_OR_PRICE_INVALID",
        errorMessage: "Cannot derive positive USDT notional and reference price for SWAP sizing",
        ackCode: "rejected",
        orderState: null,
        fillConfirmed: false,
        clOrdId: input.clOrdId
      };
    }

    const previousBaseQty = input.qty;
    let norm: { 
      raw_contracts: number; 
      normalized_contracts: number; 
      normalized_sz: string; 
      sz_lot_multiple_ok: boolean; 
      min_size_ok: boolean 
    };

    if (input.reduceOnly) {
      // Prioritize explicit contracts or fall back to estimated qty
      const sourceContracts = input.okxContracts ?? input.qty;
      const res = this.normalizeOkxReduceOrderSize({
        symbol: input.symbol,
        okxContracts: sourceContracts,
        sizing: sizingMeta,
        flowId: input.traceId,
        reason: input.reason
      });
      norm = {
        ...res,
        sz_lot_multiple_ok: true, // normalizeOkxReduceOrderSize already ensures this
        min_size_ok: res.ok
      };
    } else {
      norm = normalizeOkxSwapContractsFromNotional({
        desiredNotionalUsdt: effectiveNotionalUsdt,
        lastPrice: pricingLast,
        sizing: sizingMeta
      });
    }

    this.logger.info("OKX_ORDER_SIZE_NORMALIZATION_PROOF", {
      symbol: input.symbol,
      instId,
      side: input.side,
      posSide: input.posSide,
      desired_notional_usdt: effectiveNotionalUsdt,
      last_price: pricingLast,
      ctVal: sizingMeta.ctVal,
      ctValCcy: sizingMeta.ctValCcy,
      lotSz: sizingMeta.lotSz,
      minSz: sizingMeta.minSz,
      raw_contracts: norm.raw_contracts,
      normalized_contracts: norm.normalized_contracts,
      normalized_sz: norm.normalized_sz,
      sz_lot_multiple_ok: norm.sz_lot_multiple_ok,
      min_size_ok: norm.min_size_ok,
      previous_base_qty_if_any: previousBaseQty
    });

    if (!norm.sz_lot_multiple_ok) {
      this.logger.info("ORDER_BUILD_FAIL", {
        order_build_fail_reason: "OKX_ORDER_SIZE_NOT_LOT_MULTIPLE",
        symbol: input.symbol,
        instId,
        normalized_sz: norm.normalized_sz,
        lotSz: sizingMeta.lotSz
      });
      return {
        ok: false,
        ordId: null,
        fillPx: null,
        fillSize: 0,
        errorCode: "OKX_ORDER_SIZE_NOT_LOT_MULTIPLE",
        errorMessage: "OKX SWAP sz is not a multiple of lotSz after normalization",
        ackCode: "rejected",
        orderState: null,
        fillConfirmed: false,
        clOrdId: input.clOrdId
      };
    }
    if (!norm.min_size_ok) {
      this.logger.info("ORDER_BUILD_FAIL", {
        order_build_fail_reason: "OKX_ORDER_SIZE_UNDER_MIN",
        symbol: input.symbol,
        instId,
        normalized_contracts: norm.normalized_contracts,
        minSz: sizingMeta.minSz
      });
      return {
        ok: false,
        ordId: null,
        fillPx: null,
        fillSize: 0,
        errorCode: "OKX_ORDER_SIZE_UNDER_MIN",
        errorMessage: `Normalized contract size ${norm.normalized_contracts} below instrument minSz ${sizingMeta.minSz}`,
        ackCode: "rejected",
        orderState: null,
        fillConfirmed: false,
        clOrdId: input.clOrdId
      };
    }

    const submitSzStr = norm.normalized_sz;
    input.qty = norm.normalized_contracts;

    this.logger.info("OKX_ORDER_SIZE_PROOF", {
      symbol: input.symbol,
      instId,
      order_trace_id: input.traceId,
      side: input.side,
      posSide: input.posSide,
      req_sz: submitSzStr,
      lotSz: sizingMeta.lotSz,
      minSz: sizingMeta.minSz,
      sz_lot_multiple_ok: norm.sz_lot_multiple_ok,
      min_size_ok: norm.min_size_ok,
      chain_hint: "after_OKX_ACCOUNT_MODE_PROOF_before_OKX_ORDER_PAYLOAD_MODE_PROOF"
    });

    const stageMarginKrw = input.stageMarginKrw ?? 0;
    const stageMarginUsdt = stageMarginKrw / PAPER_LEDGER_KRW_NOTIONAL_PER_USD;
    const authoritySizeUsdt = stageMarginUsdt;
    const finalOrderNotionalUsdt = effectiveNotionalUsdt;
    const formulaNotionalUsdt = (stageMarginKrw / PAPER_LEDGER_KRW_NOTIONAL_PER_USD) * (input.appliedLeverage ?? 1);
    
    if (input.ordType === "limit" && limitPrice == null) {
      limitPrice = input.entryPrice ?? pricingLast ?? null;
    }

    this.logger.info("LIVE_ORDER_SIZE_PROOF", {
      ...logCtx,
      symbol: input.symbol,
      side: input.side,
      posSide: input.posSide,
      applied_leverage: input.appliedLeverage ?? null,
      leverage_profile: input.leverageProfile ?? null,
      leverage_reason: null,
      leverage_block_reason: null,
      entry_quality_grade: input.entryQualityGrade ?? null,
      size_unit_source: "stageMarginKrw",
      stage_margin_krw: stageMarginKrw,
      stage_margin_usdt: stageMarginUsdt,
      authority_size_usdt: authoritySizeUsdt,
      final_order_notional_usdt: finalOrderNotionalUsdt,
      formula_notional_usdt: formulaNotionalUsdt,
      formula_match: Math.abs(finalOrderNotionalUsdt - formulaNotionalUsdt) < 0.01,
      final_submitted_contracts: norm.normalized_contracts,
      req_sz: submitSzStr,
      ref_price: pricingLast ?? refPrice ?? input.entryPrice ?? null,
      limit_price: limitPrice
    });

    const orderExecutionKey = `order:${input.traceId}:${input.reason}:${input.side}:${input.posSide}:${submitSzStr}`;
    const orderKeyOk = await this.consumeExecutionKey(orderExecutionKey);
    if (!orderKeyOk) {
      return { ok: false, ordId: null, fillPx: null, fillSize: 0, errorCode: "duplicate_execution_key", errorMessage: "Duplicate order execution key blocked", ackCode: "rejected", orderState: null, fillConfirmed: false, clOrdId: input.clOrdId };
    }

    if (input.isNewEntry && input.authoritySource === "v2" && !isCommittedEntryStopPrice(input.stopPrice)) {
      this.logger.error("V2_ENTRY_BLOCKED_PROTECTION_PLAN_MISSING", {
        symbol: input.symbol,
        reason: "STOP_PRICE_REQUIRED_BEFORE_ENTRY",
        scope: "submit_okx_order",
        order_trace_id: input.traceId,
        stop_price: input.stopPrice ?? null
      });
      return {
        ok: false,
        ordId: null,
        fillPx: null,
        fillSize: 0,
        errorCode: "STOP_PRICE_REQUIRED_BEFORE_ENTRY",
        errorMessage: "V2 new entry requires committed stop_price before OKX submit",
        ackCode: "rejected",
        orderState: null,
        fillConfirmed: false,
        clOrdId: input.clOrdId
      };
    }

    this.logger.info("OKX_ENTRY_SUBMIT_ATTEMPT", {
      order_trace_id: input.traceId,
      instId,
      symbol: input.symbol,
      side: input.side,
      posSide: payloadPosSide ?? null,
      td_mode: orderTdMode,
      ord_type: input.ordType ?? (this.config.okxAuthMode === "live" ? "limit" : "market"),
      sz: submitSzStr,
      reduce_only: input.reduceOnly === true,
      is_new_entry: input.isNewEntry,
      authority_source: input.authoritySource ?? null,
      committed_stop_price: input.stopPrice ?? null,
      order_reason: input.reason
    });

    this.logger.info("OKX_ORDER_PAYLOAD_MODE_PROOF", {
      symbol: input.symbol,
      instId,
      order_trace_id: input.traceId,
      order_reason: input.reason,
      acctLv: okxAcctLv,
      posMode: okxPosMode,
      engine_pos_side: input.posSide,
      payload_td_mode: orderTdMode,
      payload_pos_side_omitted: payloadPosSide === undefined,
      payload_pos_side: payloadPosSide ?? null,
      req_sz: submitSzStr,
      req_side: input.side,
      req_ordType: input.ordType ?? (this.config.okxAuthMode === "live" ? "limit" : "market"),
      chain_hint: "after_OKX_ACCOUNT_MODE_PROOF_and_OKX_ORDER_SIZE_PROOF_before_submit"
    });

    // [V2_PROTECTION_HARDENING] Build attachAlgoOrds for mandatory entry-time protection
    const attachAlgoOrds: any[] = [];
    if (input.isNewEntry && (input.stopPrice || input.takeProfitPrice)) {
      const ordType = input.takeProfitPrice && input.takeProfitPrice > 0 ? "oco" : "conditional";
      const slTriggerPx = input.stopPrice ? String(input.stopPrice) : undefined;
      const tpTriggerPx = (ordType === "oco" && input.takeProfitPrice) ? String(input.takeProfitPrice) : undefined;

      if (slTriggerPx) {
        attachAlgoOrds.push({
          attachAlgoOrdId: `sl_${input.clOrdId}`,
          ordType,
          sz: submitSzStr,
          slTriggerPx,
          slOrdPx: "-1",
          slTriggerPxType: "last",
          ...(ordType === "oco" ? { tpTriggerPx, tpOrdPx: "-1", tpTriggerPxType: "last" } : {}),
          reduceOnly: true
        });
      }
    }

    if (instId.startsWith("BTC-")) {
      if (this.isBtcSuppressionTarget()) {
        await this.logAndSuppressBtcUsdtAction("submitOrder", "none", ["order submit"]);
        return { ok: false, error: "BTCUSDT_PROTECTED_BYPASS" } as any;
      }
    }

    try {
      const submit = await this.okxDemo.submitOrder({
        instId,
        side: input.side,
        ...(payloadPosSide !== undefined ? { posSide: payloadPosSide } : {}),
        sz: submitSzStr,
        clOrdId: input.clOrdId,
        tdMode: orderTdMode,
        ordType: input.ordType ?? (this.config.okxAuthMode === "live" ? "limit" : "market"),
        px: limitPrice ? String(limitPrice) : undefined,
        reduceOnly: input.reduceOnly,
        attachAlgoOrds: attachAlgoOrds.length > 0 ? attachAlgoOrds : undefined
      });

      if (!submit.ok) {
        const fullResponse = submit.diagnostics.fullResponse as any;
        const row0 = fullResponse?.data?.[0];
        this.logger.info("OKX_ORDER_REJECT_DETAIL_PROOF", {
          resp_code: fullResponse?.code,
          resp_msg: fullResponse?.msg,
          resp_data: fullResponse?.data,
          resp_sCode: row0?.sCode,
          resp_sMsg: row0?.sMsg,
          resp_ordId: row0?.ordId,
          resp_clOrdId: row0?.clOrdId,
          req_instId: instId,
          req_tdMode: orderTdMode,
          req_side: input.side,
          req_posSide: payloadPosSide ?? null,
          req_pos_side_omitted: payloadPosSide === undefined,
          req_ordType: input.ordType ?? (this.config.okxAuthMode === "live" ? "limit" : "market"),
          req_sz: submitSzStr,
          req_px: limitPrice ? String(limitPrice) : undefined,
          req_reduceOnly: input.reduceOnly,
          req_clOrdId: input.clOrdId,
          applied_leverage: input.appliedLeverage ?? null,
          margin_mode: orderTdMode,
          okx_pos_mode: okxPosMode,
          okx_acct_lv: okxAcctLv,
          chain_hint: "after_OKX_ORDER_PAYLOAD_MODE_PROOF"
        });

        const errorCode = (submit as any).diagnostics?.retCode || "submit_error";
        const errorMessage = (submit as any).diagnostics?.retMsg || (submit as any).error || "order_level_ack_failed";
        this.logger.error("okx_order_submit_rejected", { ...logCtx, order_submit_ack: "rejected", order_error_code: errorCode, order_error_msg: errorMessage });
        return { ok: false, ordId: null, fillPx: null, fillSize: 0, errorCode, errorMessage, ackCode: "rejected", orderState: null, fillConfirmed: false, clOrdId: input.clOrdId };
      }

      this.okxOrderSubmitOk = true;
      const row0 = submit.value?.[0];
      const ordId = String(row0?.ordId ?? "");

      // Poll for status/fill
      const status = await this.okxDemo.getOrder(instId, ordId || undefined, input.clOrdId);
      if (!status.ok) {
        const pollError = (status as any).error || "poll_failed";
        this.logger.warn("okx_order_poll_failed", { ...logCtx, ordId, order_submit_ack: "accepted", error: pollError });
        return { ok: true, ordId, fillPx: null, fillSize: 0, errorCode: null, errorMessage: pollError, ackCode: "accepted", orderState: null, fillConfirmed: false, clOrdId: input.clOrdId };
      }

      let st0 = status.value?.[0];
      let fillPx = st0?.fillPx ?? null;
      let fillSize = st0?.fillSz != null ? Number(st0.fillSz) : 0;
      let orderState = st0?.state != null ? String(st0.state) : null;
      if (
        fillSize === 0 &&
        (orderState === "live" || orderState === "partially_filled" || orderState === "mmp_canceled")
      ) {
        await new Promise((r) => setTimeout(r, 280));
        const status2 = await this.okxDemo.getOrder(instId, ordId || undefined, input.clOrdId);
        if (status2.ok && status2.value?.[0]) {
          st0 = status2.value[0];
          fillPx = st0?.fillPx ?? null;
          fillSize = st0?.fillSz != null ? Number(st0.fillSz) : 0;
          orderState = st0?.state != null ? String(st0.state) : orderState;
        }
      }
      const fillConfirmed = orderState === "filled" || orderState === "partially_filled" || fillSize > 0;

      this.logger.info("okx_order_submit_accepted", {
        ...logCtx,
        ordId,
        order_submit_ack: "accepted",
        order_state: orderState,
        order_fill_px: fillPx,
        order_fill_size: fillSize
      });

      this.logger.info("OKX_ORDER_FILL_STATUS_PROOF", {
        symbol: input.symbol,
        side: input.side,
        ord_id: ordId,
        client_order_id: input.clOrdId,
        order_state: orderState,
        fill_px: fillPx,
        fill_size: fillSize,
        accepted_at: Date.now(),
        checked_at: Date.now(),
        fill_confirmed: fillConfirmed
      });

      return {
        ok: true,
        ordId,
        fillPx: typeof fillPx === "string" || typeof fillPx === "number" ? fillPx : (fillPx != null ? String(fillPx) : null),
        fillSize,
        errorCode: null,
        errorMessage: null,
        ackCode: "accepted" as const,
        orderState,
        fillConfirmed,
        submittedContractSz: submitSzStr,
        
        // Decoupled metadata for reconciliation
        okxContracts: norm.normalized_contracts,
        baseQty: norm.normalized_contracts * sizingMeta.ctVal,
        notionalUsd: (fillPx != null && Number.isFinite(Number(fillPx))) 
          ? (norm.normalized_contracts * sizingMeta.ctVal * Number(fillPx)) 
          : finalOrderNotionalUsdt,
        avgPx: fillPx != null ? Number(fillPx) : (pricingLast ?? undefined),
        clOrdId: input.clOrdId
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const parsed = parseOkxSubmitErrorMessage(msg);
      this.logger.error("okx_order_submit_exception", { ...logCtx, errorCode: parsed.code, errorMessage: parsed.message });
      return { ok: false, ordId: null, fillPx: null, fillSize: 0, errorCode: parsed.code, errorMessage: parsed.message, ackCode: "rejected", orderState: null, fillConfirmed: false, clOrdId: input.clOrdId };
    }
  }

  private buildInvariantProofPayload(input: Readonly<{
    symbol: string;
    side: string | null;
    authority: EntryExecutionAuthority | null;
    adoptedEngine: string | null;
    lifecycleState: string | null;
    reason: string;
  }>): Record<string, unknown> {
    return {
      symbol: input.symbol,
      side: input.side,
      authority_source: input.authority?.source ?? null,
      adopted_engine: input.adoptedEngine,
      entry_quality_grade: input.authority?.entryQualityGrade ?? null,
      leverage_profile: input.authority?.leverageProfile ?? null,
      applied_leverage: input.authority?.appliedLeverage ?? null,
      paper_execution_ready: this.paperExecutionReady,
      signed_execution_ready: this.signedExecutionReady,
      signed_submit_mode: this.signedSubmitMode(),
      signed_submit_block_reason: this.signedSubmitBlockReason(this.signedSubmitMode()),
      ...this.okxAuthProofContext(),
      serverTradeEnabled: this.serverTradeControlState.server_trade_enabled,
      closeOnlyMode: this.serverTradeControlState.close_only_mode,
      killSwitch: this.serverTradeControlState.kill_switch_active,
      reconcileSafeMode: this.reconcileSafetyCloseOnly,
      lifecycleState: input.lifecycleState,
      reason: input.reason
    };
  }

  private async isHistoryDuplicate(record: PaperClosedPositionRecord): Promise<boolean> {
    try {
      const history = await this.store.readPositionsHistory();
      if (!Array.isArray(history)) return false;
      return history.some((h: any) =>
        h &&
        h.symbol === record.symbol &&
        h.side === record.side &&
        h.openedAt === record.openedAt &&
        h.entryPrice === record.entryPrice &&
        h.exitType === record.exitType &&
        h.closeReason === record.closeReason
      );
    } catch {
      return false;
    }
  }

  private async appendClosedWithStandardRouting(input: Readonly<{
    closedRow: PaperClosedPositionRecord;
    open: PaperOpenPositionRecord;
    flowId: string;
    envelope?: PaperEngineDecisionEnvelope | null;
    exitReason: string;
    closeSource: string;
    currentRegime: MarketRegime | "NO_TRADE";
  }>): Promise<PaperClosedPositionRecord> {
    const authoritySource =
      input.envelope?.authority.source ??
      input.open.authoritySourceAtEntry ??
      input.open.authority ??
      null;
    const adoptedEngine =
      input.envelope?.selector?.adopted_result.engine ??
      (authoritySource === "v2" ? "V2" : authoritySource === "v1" ? "V1" : null);
    const closeOnlyManaged = this.serverTradeControlState.close_only_mode || this.reconcileSafetyCloseOnly;
    const routedExitReason = closeOnlyManaged ? "close_only_exit" : input.exitReason;
    const routedCloseSource = closeOnlyManaged ? "server_close_only" : input.closeSource;
    const normalized: PaperClosedPositionRecord = {
      ...input.closedRow,
      closeSource: routedCloseSource as PaperCloseSource,
      exitReason: routedExitReason,
      ...(authoritySource != null ? { authority: authoritySource } : {}),
      ...(input.open.authoritySideAtEntry != null ? { authoritySide: input.open.authoritySideAtEntry } : {})
    };

    // --- History Append Guard ---
    const okxPos = this.lastLivePositionsPayload?.find((p: any) => {
      const hit = okxSwapRowToLedgerKey(p);
      return hit && hit.symbol === input.open.symbol && hit.side === input.open.side;
    });

    if (input.open.protectiveStopAlgoId && input.open.isProtectiveStopRegistered) {
      this.logger.info("PROTECTIVE_STOP_CLEANUP_REQUIRED_V1", {
        symbol: input.open.symbol,
        algoId: input.open.protectiveStopAlgoId,
        reason: input.exitReason,
        flowId: input.flowId
      });
      await this.cancelProtectiveStopOrder(input.open.symbol, input.open.protectiveStopAlgoId, input.flowId);
    }

    // [V2 CENTRALIZED CLEANUP] 
    // This handles both SL and TP legs by scanning for the position-specific 'oap' prefix
    await this.cancelProtectionOrdersForClosedPosition(
      String(input.open.symbol),
      input.open.side,
      input.open.openedAt,
      input.exitReason
    );

    const isDuplicate = await this.isHistoryDuplicate(normalized);
    if (isDuplicate) {
      this.logger.warn("HISTORY_APPEND_DUPLICATE_BLOCKED", {
        symbol: normalized.symbol,
        side: normalized.side,
        openedAt: normalized.openedAt,
        entryPrice: normalized.entryPrice,
        exitType: normalized.exitType,
        closeReason: normalized.closeReason
      });
      return normalized;
    }

    const okxPositionExists = !!okxPos;
    const invalidPrice = !normalized.closePrice || !Number.isFinite(normalized.closePrice) || normalized.closePrice <= 0;

    const blockReason = 
        invalidPrice ? "INVALID_CLOSE_PRICE" :
        (okxPositionExists ? "OKX_POSITION_STILL_EXISTS_NO_CLOSE_FILL" : null);

    if (blockReason) {
      this.logger.warn("HISTORY_APPEND_BLOCKED_EXTERNAL_MANUAL_POSITION", {
        symbol: normalized.symbol,
        side: normalized.side,
        sourceSignal: input.open.sourceSignal,
        lifecycleState: input.open.lifecycleState,
        closeReason: normalized.closeReason,
        exitType: normalized.exitType,
        closePrice: normalized.closePrice,
        okx_position_exists: okxPositionExists,
        okx_avg_px: okxPos ? (okxPos as any).avgPx : null,
        okx_base_qty: okxPos ? (okxPos as any).baseQty : null,
        okx_contracts: okxPos ? (okxPos as any).pos : null,
        reason: blockReason,
        action: "SKIP_HISTORY_APPEND_KEEP_EXTERNAL_POSITION"
      });
      return normalized;
    }

    await this.positions.appendClosed(normalized);
    this.historyDirty = true;
    this.bundleDirty = true;

    this.logger.info("EXIT_STANDARD_ROUTING_PROOF", {
      symbol: input.open.symbol,
      side: input.open.side,
      flowId: input.flowId,
      exitReason: routedExitReason,
      exitType: normalized.exitType ?? null,
      closeSource: normalized.closeSource ?? null,
      authority_source: authoritySource,
      adopted_engine: adoptedEngine,
      lifecycleState: input.open.lifecycleState ?? "INITIAL",
      position_regime_at_entry: input.open.regimeAtEntry ?? null,
      current_regime: input.currentRegime,
      serverTradeEnabled: this.serverTradeControlState.server_trade_enabled,
      closeOnlyMode: this.serverTradeControlState.close_only_mode,
      killSwitch: this.serverTradeControlState.kill_switch_active,
      reconcileSafeMode: this.reconcileSafetyCloseOnly
    });
    return normalized;
  }

  public async tryPaperPositionClose(input: Readonly<{
    snapshots: SymbolSnapshot[];
    errorsCount: number;
    latestPath: string | undefined;
    metaPath: string | undefined;
    filePath: string | undefined;
    marketMode: MarketModeSelectorOutput;
    riskExposure: RiskExposureOutput;
    decisionBySymbol: ReadonlyMap<string, PaperEngineDecisionEnvelope>;
  }>): Promise<void> {
    // Remove aggressive errorsCount check to ensure exit evaluation for successful symbols
    // if (input.errorsCount > 0) return;


    const rawOpens = await this.positions.loadOpenAll();
    if (rawOpens.length === 0) return;
    const opens = rawOpens.map(o => ({ ...o })); // Use mutable copy for state tracking
    const effectiveCloseOnlyMode = this.serverTradeControlState.close_only_mode || this.reconcileSafetyCloseOnly;
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
        if (op.symbol === "BTCUSDT") continue;
        if (op.status !== "open") continue;
        const snap = input.snapshots.find(s => s.symbol === op.symbol);
        if (!snap) continue;

        const isLong = op.side === "long";
        const isShort = op.side === "short";
        const inheritedStrategyVersion = op.strategyVersion ?? "paper-v1";

        // 1. Long Defense (Force Liquidate) - legacy cleanup only.
        if (isLong) {
          if (this.isV2AuthorityPosition(op)) {
            this.logger.info("CRASH_LONG_DEFENSE_SKIPPED_V2_POSITION", {
              symbol: op.symbol,
              state: risk.crashState,
              authority_owner: op.authoritySourceAtEntry ?? op.authority ?? null,
              executor_at_entry: op.executorAtEntry ?? null,
              regime_at_entry: op.regimeAtEntry ?? null
            });
            continue;
          }

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
            await this.dispatchOkxClose({
              symbol: op.symbol,
              side: op.side,
              sizeUsd: marginToClose,
              appliedLeverage: Math.max(1, op.leverage ?? 1),
              lastPrice: snap.lastPrice,
              flowId: `${op.symbol}:${op.side}:${op.openedAt}`,
              reason: et
            });

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

            // [FIX: history-ledger] CRASH_REDUCE is a partial defense event (50% reduction).
            // Only full-liquidation (forceExit ??EXIT_LONG_CRASH_FORCE) goes into history.json.
            // CRASH_REDUCE is recorded to events.jsonl only (see below).
            if (forceExit) {
              const routedClosed = await this.appendClosedWithStandardRouting({
                closedRow,
                open: op,
                flowId: `${op.symbol}:${op.side}:${op.openedAt}`,
                envelope: null,
                exitReason: et,
                closeSource: "CRASH_LONG_DEFENSE",
                currentRegime: (input.marketMode.marketMode as MarketRegime) ?? "NO_TRADE"
              });
              authorizeOpenLedgerPruneAfterAttestedClose(`${op.symbol}:${op.side}:${op.openedAt}`, routedClosed);
            } else {
              this.logger.info("CRASH_REDUCE_PARTIAL_EVENT_ONLY", {
                symbol: op.symbol,
                state: risk.crashState,
                type: et,
                note: "CRASH_REDUCE is a partial defense event ??not appended to history.json ledger"
              });
            }
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
        // ?륁? 媛뺤젣 醫낅즺?섏? ?딅릺, 湲됰씫 ?곹깭?먯꽌???섏씡 蹂댄샇瑜??꾪빐 ?몃젅?쇰쭅 濡쒖쭅 媛쒖엯 ?щ?留??ш린???뚮옒洹??명똿?섍굅??
        // ?섎떒 ?쇰컲 濡쒖쭅?먯꽌 risk.crashState瑜?李멸퀬?섎룄濡??ㅺ퀎.
        // ?ш린?쒕뒗 '湲됰씫 以????섏씡蹂댄샇 紐⑤뱶' 吏꾩엯 濡쒓퉭留??④?.
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

    /** events.jsonl `type` ???덇굅???명솚(遺遺꾩씡?댟룻듃?덉씪 ?깆? 湲곗〈怨??숈씪 怨꾩뿴濡??좎?). */
    const exitEventJsonlType = (r: PaperClosedPositionRecord["closeReason"]): "EXIT_TP" | "EXIT_REGIME" | "EXIT_TREND_BREAK" | "EXIT_SL" | "EXIT_TIME_STOP" | string => {
      if (r === "time_based_exit") return "EXIT_TIME_STOP";
      if (r === "stop_loss") return "EXIT_SL";
      const t = paperExitDisplayMeta(r).exitType;
      if (t === "EXIT_PARTIAL_SPLIT_1" || t === "EXIT_PARTIAL_SPLIT_2") return "EXIT_PARTIAL_SPLIT";
      if (t === "EXIT_PARTIAL_TP" || t === "EXIT_TP_1" || t === "EXIT_TP_2") return "EXIT_TP";
      if (t === "EXIT_TIME_STOP") return "EXIT_TIME_STOP";
      if (t === "EXIT_SL") return "EXIT_SL";
      if (r === "v2_exit_authority") return "EXIT_V2_AUTHORITY";
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
      if (openRaw.symbol === "BTCUSDT") {
        if (this.isBtcSuppressionTarget()) {
          await this.logAndSuppressBtcUsdtAction("tryPaperPositionClose normal loop", openRaw.side, ["CLOSE", "PARTIAL", "PARTIAL_CLOSE", "REVERSE", "close history write", "ledger prune"]);
          remaining.push(openRaw);
          continue;
        }
      }
      const posKey = `${openRaw.symbol}:${openRaw.openedAt}`;
      // Unique flow identifier for one-shot terminal exit deduplication
      const flowId = `${openRaw.symbol}:${openRaw.side}:${openRaw.openedAt}`;
      const symSideKey = `${openRaw.symbol}:${openRaw.side}`;

      // 1. Normalization & Backfill StopPrice (Moved up for priority SL check)
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
      if (effectiveCloseOnlyMode && open.lifecycleState !== "CLOSE_ONLY_MANAGED") {
        open = { ...open, lifecycleState: "CLOSE_ONLY_MANAGED" };
        crashPositionsModified = true;
      }

      if (open.status === "open" && (open.stopPrice === undefined || open.stopPrice === null || !Number.isFinite(open.stopPrice))) {
        const ep = open.entryPrice;
        const slReg = regimeForSl(open.regimeAtEntry);
        const newStop = ep > 0 ? engineMirrorStopPrice(ep, open.side, slReg) : null;
        if (newStop != null && Number.isFinite(newStop)) {
          const oldStop = open.stopPrice;
          open = {
            ...open,
            stopPrice: newStop
          };
          crashPositionsModified = true;
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

      if (this.terminalExitConsumedByFlow.has(flowId)) {
        openLedgerPruned = true;
        this.logger.info("EXIT_TERMINAL_DEDUP_PROOF", {
          symbol: openRaw.symbol,
          side: openRaw.side,
          openedAt: openRaw.openedAt,
          flowId,
          terminal_exit_already_consumed: true
        });
        continue;
      }

      // A. FORCE CLOSED Short-Circuit
      if (crashForceClosedKeys.has(posKey)) {
        this.logger.info("force_closed_position_excluded_from_open_ledger", {
          symbol: openRaw.symbol,
          openedAt: openRaw.openedAt,
          excluded_from_remaining: true
        });
        continue;
      }

      // B. REDUCE Short-Circuit
      if (crashReducedThisTickKeys.has(posKey)) {
        remaining.push(openRaw);
        this.logger.info("crash_close_short_circuit_applied", {
          symbol: openRaw.symbol,
          openedAt: openRaw.openedAt,
          crash_action: "CRASH_REDUCE",
          remaining_size_usd_after_crash: openRaw.sizeUsd
        });
        continue;
      }

      if (openRaw.status !== "open") {
        continue;
      }

      // --- [PRIORITY STOP LOSS DECOUPLING] ---
      const snap = input.snapshots.find((s) => s.symbol === openRaw.symbol);
      const trendManagedPosition = this.isTrendManagedPosition(open);
      const exitLane: "RANGE" | "TREND" = trendManagedPosition ? "TREND" : "RANGE";
      const slRegime: MarketRegime = exitLane === "RANGE" ? "RANGE" : "TREND";
      const inheritedStrategyVersion = open.strategyVersion ?? "paper-v1";

      // 4. Snapshot & Metrics (Consolidated for priority SL and managed evaluation)
      let m: PaperCloseLegMetrics | null = null;
      let closePrice: number | null = null;
      if (snap) {
        closePrice = snap.lastPrice;
        m = computePaperCloseLegMetrics({
          open,
          closePrice,
          closedAt: snap.fetchedAt,
          snapFundingRate: snap.fundingRate,
          marginUsd: open.sizeUsd,
          paperTakerFeeRate: this.config.paperTakerFeeRate,
          paperFundingIntervalHours: this.config.paperFundingIntervalHours
        });
        const highWater = Math.max(open.highestPnlPctNet ?? m.pnlPctNet, m.pnlPctNet);
        const peakUnrealized = Math.max(open.peakUnrealizedPnlPct ?? m.pnlPctNet, m.pnlPctNet);
        const currentPnlPct = m.pnlPctNet;

        // V2 Breakeven logic: PnL >= 0.4% or Peak >= 0.6%
        const beRequired = currentPnlPct >= 0.004 || peakUnrealized >= 0.006;
        const feeBuffer = 0.0008; // 0.08% buffer for fees and slippage
        const bePrice = open.side === "long"
          ? open.entryPrice * (1 + feeBuffer)
          : open.entryPrice * (1 - feeBuffer);

        if (beRequired && !open.breakevenStopRequired) {
          this.logger.info("V2_BREAKEVEN_STOP_REQUIRED_PROOF", {
            symbol: open.symbol,
            side: open.side,
            entryPrice: open.entryPrice,
            markPrice: closePrice,
            pnlPct: currentPnlPct,
            peakUnrealizedPnlPct: peakUnrealized,
            currentStopPrice: open.stopPrice,
            requiredBreakevenStopPrice: bePrice,
            reason: "pnl_threshold_met"
          });
        }

        open = { 
          ...open, 
          highestPnlPctNet: highWater, 
          peakUnrealizedPnlPct: peakUnrealized,
          peakPnlUpdatedAt: peakUnrealized > (open.peakUnrealizedPnlPct ?? -999) ? Date.now() : open.peakPnlUpdatedAt,
          breakevenStopRequired: beRequired,
          breakevenStopPrice: bePrice
        };
      }


      // --- [STANDARD BLOCKS] ---
      if (this.symbolExternalManualBlocked.has(symSideKey)) {
        this.logger.info("EXIT_EVAL_SKIPPED_EXTERNAL_MANUAL_BLOCK", { symbol: open.symbol, side: open.side, flowId });
        remaining.push(openRaw);
        continue;
      }

      const isManaged = 
        open.lifecycleState === "OPEN" || 
        open.lifecycleState === undefined || 
        open.lifecycleState === null || 
        open.lifecycleState === "ADDON_ACTIVE" || 
        open.lifecycleState === "PARTIAL_ACTIVE" ||
        open.lifecycleState === "CLOSE_ONLY_MANAGED";
      
      if (!isManaged) {
        remaining.push(openRaw);
        continue;
      }

      if (!snap || !m || closePrice == null) {
        remaining.push(openRaw);
        continue;
      }

      const closedAt = snap.fetchedAt;
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



      const rangeManagedPosition =
        open.regimeAtEntry === "RANGE" &&
        open.executorAtEntry !== "TREND" &&
        !trendManagedPosition;

      const blockedByExecutorMismatch =
        open.regimeAtEntry === "RANGE" &&
        trendManagedPosition;

      let finalCloseReason: PaperClosedPositionRecord["closeReason"] | "none" = "none";
      let confirmedExitType: string | null = null;
      let confirmedCloseSource: string | null = null;
      let posTrail: PaperOpenPositionRecord = { ...open };

      this.logger.info("REGIME_EXIT_GUARD_PROOF", {
        symbol: open.symbol,
        strategyVersion: open.strategyVersion,
        trendManagedPosition,
        rangeManagedPosition,
        exitLane,
        blockedByExecutorMismatch,
        flowId
      });

      const regimeNow = input.marketMode.marketMode as MarketRegime;
      const snapPaths = {
        ...(input.latestPath ? { latestSnapshotPath: input.latestPath } : {}),
        ...(input.metaPath ? { latestMetaPath: input.metaPath } : {}),
        ...(input.filePath ? { timestampSnapshotPath: input.filePath } : {})
      };

      // 3. [PENDING ORDER REVIEW]
      // Before evaluating new exits, check if there's an in-flight close order.
      if (open.lifecycleState === "CLOSE_PENDING" && open.closePendingClOrdId) {
        if (!this.okxDemo) continue;
        const ordId = open.closePendingOrdId;
        const instId = toOkxSwapInstId(open.symbol);
        const status = await this.okxDemo.getOrder(instId, ordId || undefined, open.closePendingClOrdId);
        
        this.logger.info("OKX_ORDER_FILL_STATUS_PROOF", {
          symbol: open.symbol,
          instId,
          ordId,
          clOrdId: open.closePendingClOrdId,
          ok: status.ok,
          state: (status as any).value?.[0]?.state,
          fillSz: (status as any).value?.[0]?.fillSz,
          flowId
        });

        if (status.ok && (status as any).value?.[0]) {
          const st = (status as any).value[0];
          const isFilled = st.state === "filled";
          const fillSize = st.fillSz != null ? Number(st.fillSz) : 0;
          
          const isActuallyClosedOnOkx = isFilled;
          
          if (isActuallyClosedOnOkx) {
            this.logger.info("STOP_LOSS_POSITION_CLOSED", { symbol: open.symbol, flowId, fillSize });
            
            const fillPxStr = st.fillPx || st.avgPx;
            const parsedFillPx = fillPxStr ? Number(fillPxStr) : NaN;
            const actualExitPrice = Number.isFinite(parsedFillPx) && parsedFillPx > 0 ? parsedFillPx : closePrice;
            
            const actualMetrics = computePaperCloseLegMetrics({
              open,
              closePrice: actualExitPrice,
              closedAt: snap!.fetchedAt,
              snapFundingRate: snap!.fundingRate,
              marginUsd: open.sizeUsd,
              paperTakerFeeRate: this.config.paperTakerFeeRate,
              paperFundingIntervalHours: this.config.paperFundingIntervalHours
            });
            
            const closedRow = finalizePaperClosedRecord({
              open,
              symbol: open.symbol,
              closePrice: actualExitPrice,
              closedAt: snap!.fetchedAt,
              closeReason: (open as any).closePendingReason || "stop_loss",
              legMarginUsd: open.sizeUsd,
              metrics: actualMetrics,
              feeRate: this.config.paperTakerFeeRate,
              fundingIntervalHours: this.config.paperFundingIntervalHours,
              strategyVersion: inheritedStrategyVersion,
              ...snapPaths
            });
            const routedClosed = await this.appendClosedWithStandardRouting({
              closedRow,
              open,
              flowId,
              envelope: null as any,
              exitReason: (open as any).closePendingReason || "stop_loss",
              closeSource: "priority_stop_loss_gate_fill_confirmed",
              currentRegime: input.marketMode.marketMode as MarketRegime
            });
            
            authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosed);
            this.terminalExitConsumedByFlow.add(flowId);
            openLedgerPruned = true;
            this.logger.info("STOP_LOSS_LEDGER_PRUNE_AFTER_FILL", { symbol: open.symbol, flowId });
            continue; 
          } else if (fillSize > 0) {
            this.logger.info("STOP_LOSS_CLOSE_PARTIAL_FILLED", { symbol: open.symbol, flowId, fillSize, state: st.state });
            remaining.push(posTrail);
            continue;
          } else {
            this.logger.info("STOP_LOSS_CLOSE_PENDING", { symbol: open.symbol, flowId, state: st.state });
            remaining.push(posTrail);
            continue;
          }
        } else {
          this.logger.warn("STOP_LOSS_CLOSE_PENDING_RETRY", { symbol: open.symbol, flowId, error: (status as any).error });
          remaining.push(posTrail);
          continue;
        }
      }

      // 4. [PRIORITY STOP LOSS DECOUPLING]
      // Goal: Priority execution with strict fill verification and manual position protection.
      let isSlTriggered = false;
      if (snap && m && closePrice != null) {
        if (typeof open.stopPrice === "number" && Number.isFinite(open.stopPrice)) {
          isSlTriggered = open.side === "long" ? closePrice <= open.stopPrice : closePrice >= open.stopPrice;
        } else {
          isSlTriggered = m.pnlPctNet <= stopLossPctForRegime(slRegime);
        }

        if (isSlTriggered) {
          // EXCLUDE: symbolExternalManualBlocked, EXTERNAL_MANUAL_POSITION, OPERATOR_MANAGED
          const isOperatorManaged = 
            this.symbolExternalManualBlocked.has(symSideKey) ||
            open.lifecycleState === "EXTERNAL_MANUAL_POSITION" || 
            open.lifecycleState === "OPERATOR_MANAGED" || 
            open.lifecycleState === "CLOSE_ONLY_MANAGED" || 
            (open as any).isOperatorManaged === true;
            
          if (isOperatorManaged) {
            this.logger.info("OPERATOR_MANAGED_STOP_LOSS_SKIPPED", { symbol: open.symbol, side: open.side, flowId });
            remaining.push(posTrail);
            continue;
          }

          const isActuallyOpenOnOkx = open.reconcileState === "MATCHED" || open.reconcileState === "ADOPTED";
          if (isActuallyOpenOnOkx) {
            this.logger.info("STOP_LOSS_TRIGGER_DETECTED", {
              symbol: open.symbol,
              side: open.side,
              markPrice: closePrice,
              stopPrice: open.stopPrice,
              pnlPctNet: m.pnlPctNet,
              reconcileState: open.reconcileState,
              flowId
            });

            this.logger.info("STOP_LOSS_CLOSE_ORDER_SUBMIT", { symbol: open.symbol, flowId });
            const closeResult = await this.dispatchOkxClose({
              symbol: open.symbol,
              side: open.side,
              sizeUsd: open.sizeUsd,
              okxContracts: open.okxContracts ?? undefined,
              appliedLeverage: Math.max(1, open.leverage ?? 1),
              lastPrice: closePrice,
              flowId,
              reason: `stop_loss_priority_close`,
              isStopLoss: true
            });

            if (closeResult && closeResult.ok) {
              this.logger.info("STOP_LOSS_CLOSE_ORDER_ACCEPTED", { symbol: open.symbol, flowId, ordId: closeResult.ordId });
              
              // Transition to PENDING, do NOT prune yet.
              posTrail = {
                ...posTrail,
                lifecycleState: "CLOSE_PENDING",
                closePendingClOrdId: closeResult.clOrdId,
                closePendingOrdId: closeResult.ordId || undefined,
                closePendingAt: Date.now(),
                closePendingReason: "stop_loss"
              };
              crashPositionsModified = true;
              remaining.push(posTrail);
              continue;
            } else {
              this.logger.error("STOP_LOSS_CLOSE_ORDER_FAILED", { symbol: open.symbol, flowId, error: closeResult?.errorMessage || "unknown_error" });
              // If failed, we should still bypass the rest of the close logic for this tick to avoid duplicate processing.
              remaining.push(posTrail);
              continue;
            }
          }
        }
      }

      // --- Mandatory Diagnostic Log for Adopted/Close-Only positions ---
      if (open.reconcileState === "ADOPTED" || open.lifecycleState === "CLOSE_ONLY_MANAGED") {
        const tpMissing = open.targetPrice1 === undefined || open.targetPrice1 === null;
        this.logger.info("POSITION_CLOSE_EVALUATION_PROOF", {
          symbol: open.symbol,
          side: open.side,
          sourceSignal: open.sourceSignal,
          lifecycleState: open.lifecycleState,
          reconcileState: open.reconcileState,
          markPrice: closePrice,
          stopPrice: open.stopPrice,
          targetPrice1: open.targetPrice1,
          tp_status: tpMissing ? "TP_NOT_SET" : "TP_CONFIGURED",
          trailingStopPrice: open.trailingStopPrice,
          pnlPctNet: m.pnlPctNet,
          isManaged: true,
          reduce_only: true,
          current_position_size: open.sizeUsd,
          requested_close_size: open.sizeUsd,
          remaining_position_size: 0,
          ledger_update_required: true,
          flowId
        });

        if (tpMissing) {
          this.logger.info("POSITION_TAKE_PROFIT_EVALUATION_PROOF", {
            symbol: open.symbol,
            tp_triggered: false,
            status: "tp_not_configured",
            flowId
          });
        }
      }


      // --- 1. V2 RANGE Hardened TP1/TP2 Monitoring ---
      if (open.isV2Authority && open.takeProfit1Px != null) {
        const tp1 = open.takeProfit1Px;
        const tp2 = open.takeProfit2Px;
        const ratio = open.partialExitRatio ?? 0.5;
        const stage = open.partialExitStage ?? 0;
        
        const tp1Hit = typeof tp1 === "number" && (open.side === "long" ? closePrice >= tp1 : closePrice <= tp1);
        const tp2Hit = typeof tp2 === "number" && (open.side === "long" ? closePrice >= tp2 : closePrice <= tp2);

        // TP2: Final Exit (High Priority)
        if (stage < 2 && !open.v2RangeTp2Triggered && tp2Hit) {
          // Check for same-tick TP1 suppression
          if (tp1Hit && !open.v2RangeTp1Triggered) {
            this.logger.info("V2_RANGE_TP2_SUPPRESS_TP1_SAME_TICK_PROOF", {
              symbol: open.symbol,
              side: open.side,
              tp1_px: tp1,
              tp2_px: tp2,
              close_price: closePrice,
              flowId
            });
          }

          this.logger.info("V2_RANGE_TP2_TRIGGER_PROOF", {
            event: "V2_RANGE_TP2_TRIGGER_PROOF",
            symbol: open.symbol,
            side: open.side,
            tp2_px: tp2,
            close_price: closePrice,
            flowId
          });

          const metricsF = leg(open.sizeUsd);
          const closedRowF = finalizePaperClosedRecord({
            open,
            symbol: open.symbol,
            closePrice,
            closedAt,
            closeReason: "take_profit_2" as any,
            legMarginUsd: open.sizeUsd,
            metrics: metricsF,
            feeRate: this.config.paperTakerFeeRate,
            fundingIntervalHours: this.config.paperFundingIntervalHours,
            strategyVersion: inheritedStrategyVersion,
            exitTypeOverride: "EXIT_TP_2",
            closeSourceOverride: "V2_AUTOMATED_TP_GATE",
            ...snapPaths
          });

          const tp2Submit = await this.dispatchOkxClose({
            symbol: open.symbol,
            side: open.side,
            sizeUsd: open.sizeUsd,
            okxContracts: open.okxContracts ?? undefined,
            appliedLeverage: Math.max(1, open.leverage ?? 1),
            lastPrice: closePrice,
            flowId,
            reason: "v2_tp2_automated",
            isTakeProfit: true
          });

          this.logger.info("V2_RANGE_TP2_CLOSE_ORDER_SUBMIT_PROOF", {
            symbol: open.symbol,
            side: open.side,
            ord_id: tp2Submit?.ordId ?? null,
            fill_confirmed: tp2Submit?.fillConfirmed ?? false,
            close_price: closePrice,
            size_usd: open.sizeUsd,
            flowId
          });

          const isExchangeEnabledTp2 = this.okxDemo && this.signedSubmitMode() === "enabled";

          if (isExchangeEnabledTp2) {
            if (tp2Submit?.ordId == null) {
              // ord_id null = submit failed: retain open position for next-tick retry
              this.logger.info("V2_RANGE_TP2_CLOSE_ORDER_SUBMIT_FAIL_PROOF", {
                symbol: open.symbol,
                side: open.side,
                ord_id: null,
                error_code: tp2Submit?.errorCode ?? null,
                error_message: tp2Submit?.errorMessage ?? null,
                close_price: closePrice,
                size_usd: open.sizeUsd,
                flowId
              });
              remaining.push({ ...open });
              continue;
            }

            if (tp2Submit.fillConfirmed !== true) {
              // ord_id present but not yet filled: transition to CLOSE_PENDING
              const updatedOpen: PaperOpenPositionRecord = {
                ...open,
                lifecycleState: "CLOSE_PENDING",
                closePendingOrdId: tp2Submit.ordId,
                closePendingClOrdId: tp2Submit?.clOrdId ?? undefined,
                closePendingAt: Date.now(),
                closePendingReason: "v2_tp2_automated",
                closePendingPrice: closePrice,
                closePendingFundingRate: snap?.fundingRate
              };
              this.logger.info("V2_RANGE_TP2_CLOSE_PENDING_PROOF", {
                symbol: open.symbol,
                side: open.side,
                ord_id: tp2Submit.ordId,
                pending_reason: "fill_not_confirmed",
                flowId
              });
              crashPositionsModified = true;
              remaining.push(updatedOpen);
              continue;
            }
          }

          // Fill confirmed (or exchange disabled): commit all ledger mutations
          this.logger.info("V2_RANGE_TP2_CLOSE_FILL_STATUS_PROOF", {
            symbol: open.symbol,
            side: open.side,
            ord_id: tp2Submit?.ordId ?? null,
            fill_confirmed: true,
            close_price: closePrice,
            flowId
          });

          // Persist trigger flag only after fill confirmed
          open.v2RangeTp2Triggered = true;
          this.logger.info("V2_RANGE_TP_TRIGGER_LEDGER_SAVE_PROOF", {
            symbol: open.symbol,
            tp1Triggered: open.v2RangeTp1Triggered ?? false,
            tp2Triggered: true,
            flowId
          });

          const routedClosedF = await this.appendClosedWithStandardRouting({
            closedRow: closedRowF,
            open,
            flowId,
            envelope: null as any,
            exitReason: "take_profit_2" as any,
            closeSource: "V2_AUTOMATED_TP_GATE",
            currentRegime: regimeNow
          });

          this.logger.info("V2_RANGE_TP2_CLOSE_LEDGER_UPDATE_PROOF", {
            symbol: open.symbol,
            side: open.side,
            ord_id: tp2Submit?.ordId ?? null,
            history_appended: true,
            ledger_pruned: true,
            flowId
          });

          authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosedF);
          this.terminalExitConsumedByFlow.add(flowId);
          continue; // Full exit
        }

        // TP1: Partial Exit (Lower Priority)
        if (stage < 1 && !open.v2RangeTp1Triggered && tp1Hit) {
          this.logger.info("V2_RANGE_TP1_TRIGGER_PROOF", {
            event: "V2_RANGE_TP1_TRIGGER_PROOF",
            symbol: open.symbol,
            side: open.side,
            tp1_px: tp1,
            close_price: closePrice,
            ratio,
            flowId
          });

          const partialSizeUsd = open.sizeUsd * ratio;
          const metricsP = leg(partialSizeUsd);
          const closedRowP = finalizePaperClosedRecord({
            open,
            symbol: open.symbol,
            closePrice,
            closedAt,
            closeReason: "take_profit_1" as any,
            legMarginUsd: partialSizeUsd,
            metrics: metricsP,
            feeRate: this.config.paperTakerFeeRate,
            fundingIntervalHours: this.config.paperFundingIntervalHours,
            strategyVersion: inheritedStrategyVersion,
            exitTypeOverride: "EXIT_TP_1",
            closeSourceOverride: "V2_AUTOMATED_TP_GATE",
            ...snapPaths
          });

          const tp1Submit = await this.dispatchOkxClose({
            symbol: open.symbol,
            side: open.side,
            sizeUsd: partialSizeUsd,
            okxContracts: open.okxContracts != null ? open.okxContracts * ratio : undefined,
            appliedLeverage: Math.max(1, open.leverage ?? 1),
            lastPrice: closePrice,
            flowId,
            reason: "v2_tp1_automated",
            isTakeProfit: true
          });

          this.logger.info("V2_RANGE_TP1_REDUCE_ORDER_SUBMIT_PROOF", {
            symbol: open.symbol,
            side: open.side,
            ord_id: tp1Submit?.ordId ?? null,
            fill_confirmed: tp1Submit?.fillConfirmed ?? false,
            partial_size_usd: partialSizeUsd,
            close_price: closePrice,
            flowId
          });

          const isExchangeEnabledTp1 = this.okxDemo && this.signedSubmitMode() === "enabled";

          if (isExchangeEnabledTp1) {
            if (tp1Submit?.ordId == null) {
              // ord_id null = submit failed: retain open position for next-tick retry
              this.logger.info("V2_RANGE_TP1_REDUCE_ORDER_SUBMIT_FAIL_PROOF", {
                symbol: open.symbol,
                side: open.side,
                ord_id: null,
                error_code: tp1Submit?.errorCode ?? null,
                error_message: tp1Submit?.errorMessage ?? null,
                partial_size_usd: partialSizeUsd,
                close_price: closePrice,
                flowId
              });
              remaining.push({ ...open });
              continue;
            }

            if (tp1Submit.fillConfirmed !== true) {
              // ord_id present but not yet filled: transition to PARTIAL_PENDING
              const updatedOpen: PaperOpenPositionRecord = {
                ...open,
                lifecycleState: "PARTIAL_PENDING",
                partialPendingOrdId: tp1Submit.ordId,
                partialPendingClOrdId: tp1Submit?.clOrdId ?? undefined,
                partialPendingSizeUsd: partialSizeUsd,
                partialPendingOriginalSizeUsd: partialSizeUsd,
                partialPendingProcessedFillSz: 0,
                partialPendingProcessedUsd: 0,
                partialPendingAt: Date.now(),
                partialPendingReduceRatio: ratio,
                partialPendingReason: "v2_tp1_automated",
                partialPendingPrice: closePrice,
                partialPendingFundingRate: snap?.fundingRate
              };
              this.logger.info("V2_RANGE_TP1_REDUCE_PENDING_PROOF", {
                symbol: open.symbol,
                side: open.side,
                ord_id: tp1Submit.ordId,
                pending_reason: "fill_not_confirmed",
                partial_size_usd: partialSizeUsd,
                flowId
              });
              crashPositionsModified = true;
              remaining.push(updatedOpen);
              continue;
            }
          }

          // Fill confirmed (or exchange disabled): commit all ledger mutations
          this.logger.info("V2_RANGE_TP1_REDUCE_FILL_STATUS_PROOF", {
            symbol: open.symbol,
            side: open.side,
            ord_id: tp1Submit?.ordId ?? null,
            fill_confirmed: true,
            partial_size_usd: partialSizeUsd,
            close_price: closePrice,
            flowId
          });

          // Persist trigger flag only after fill confirmed
          open.v2RangeTp1Triggered = true;
          this.logger.info("V2_RANGE_TP_TRIGGER_LEDGER_SAVE_PROOF", {
            symbol: open.symbol,
            tp1Triggered: true,
            tp2Triggered: open.v2RangeTp2Triggered ?? false,
            flowId
          });

          await this.appendClosedWithStandardRouting({
            closedRow: closedRowP,
            open,
            flowId,
            envelope: null as any,
            exitReason: "take_profit_1" as any,
            closeSource: "V2_AUTOMATED_TP_GATE",
            currentRegime: regimeNow
          });

          open.sizeUsd -= partialSizeUsd;
          open.partialExitStage = 1;
          open.lastPartialAt = closedAt;
          crashPositionsModified = true;

          this.logger.info("V2_RANGE_TP1_REDUCE_LEDGER_UPDATE_PROOF", {
            symbol: open.symbol,
            side: open.side,
            ord_id: tp1Submit?.ordId ?? null,
            history_appended: true,
            size_after_usd: open.sizeUsd,
            partial_exit_stage: open.partialExitStage,
            flowId
          });
        }
      }

      // --- 2. Hard TP check (Safety Gate) ---
      let isTpTriggered = false;
      if (typeof open.targetPrice1 === "number" && Number.isFinite(open.targetPrice1)) {
        isTpTriggered = open.side === "long" ? closePrice >= open.targetPrice1 : closePrice <= open.targetPrice1;
      }

      // --- 3. Hard Trailing Stop check (Safety Gate) ---
      let isTrailingTriggered = false;
      if (typeof open.trailingStopPrice === "number" && Number.isFinite(open.trailingStopPrice)) {
        isTrailingTriggered = open.side === "long" ? closePrice <= open.trailingStopPrice : closePrice >= open.trailingStopPrice;
      }

      if (isSlTriggered || isTpTriggered || isTrailingTriggered) {
        if (isTpTriggered) {
          this.logger.info("POSITION_TAKE_PROFIT_EVALUATION_PROOF", {
            symbol: open.symbol,
            tp_triggered: true,
            target_price: open.targetPrice1,
            close_price: closePrice,
            flowId
          });
        }

        const cr = isSlTriggered ? "stop_loss" : isTpTriggered ? "take_profit" : ("trailing_stop" as const);
        finalCloseReason = cr;
        confirmedExitType = isSlTriggered ? "EXIT_SL" : isTpTriggered ? "EXIT_TP" : "EXIT_TRAILING";
        confirmedCloseSource = isSlTriggered ? "hard_stop_loss_gate_primary" : isTpTriggered ? "hard_tp_gate_primary" : "hard_trailing_gate_primary";
        
        const feeRate = this.config.paperTakerFeeRate;
        const intervalH = this.config.paperFundingIntervalHours;
        const toClosedLocal = (crLoc: PaperClosedPositionRecord["closeReason"], metricsLoc: PaperCloseLegMetrics, legMarginUsdLoc: number) => 
            finalizePaperClosedRecord({
                open,
                symbol: open.symbol,
                closePrice,
                closedAt,
                closeReason: crLoc,
                legMarginUsd: legMarginUsdLoc,
                metrics: metricsLoc,
                feeRate,
                fundingIntervalHours: intervalH,
                strategyVersion: inheritedStrategyVersion,
                ...snapPaths
            });

        const closedRow = toClosedLocal(cr, m, open.sizeUsd);
        
        if (open.reconcileState === "ADOPTED" || open.lifecycleState === "CLOSE_ONLY_MANAGED") {
          this.logger.info("ADOPTED_EXIT_TRIGGERED_PROOF", {
            symbol: open.symbol,
            side: open.side,
            reconcileState: open.reconcileState,
            lifecycleState: open.lifecycleState,
            triggerReason: cr,
            tp_triggered: isTpTriggered,
            trailing_triggered: isTrailingTriggered,
            stopPrice: open.stopPrice,
            targetPrice1: open.targetPrice1,
            trailingStopPrice: open.trailingStopPrice,
            closePrice,
            flowId
          });
        }

        await this.dispatchOkxClose({
          symbol: open.symbol,
          side: open.side,
          sizeUsd: open.sizeUsd,
          okxContracts: open.okxContracts ?? undefined,
          appliedLeverage: Math.max(1, open.leverage ?? 1),
          lastPrice: closePrice,
          flowId,
          reason: `${cr}_close`,
          isStopLoss: isSlTriggered,
          isTakeProfit: isTpTriggered,
          isTrailingStop: isTrailingTriggered
        });

        const routedClosed = await this.appendClosedWithStandardRouting({
          closedRow,
          open,
          flowId,
          envelope: null as any, 
          exitReason: cr,
          closeSource: confirmedCloseSource,
          currentRegime: regimeNow
        });
        authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosed);
        this.terminalExitConsumedByFlow.add(flowId);
        continue;
      }

      const symbol = open.symbol;
      const sk = String(symbol);
      const envelope = input.decisionBySymbol.get(sk)!;
      if (!envelope) {
        remaining.push(open);
        continue;
      }
      const v2ExitAuthority = envelope.selector?.v2_result.v2ExitAuthority ?? null;
      const v2PartialAuthority = envelope.selector?.v2_result.v2PartialAuthority ?? null;
      const lifecycleAuthority = envelope.selector?.v2_result.lifecycleAuthority ?? null;

      const v2NewStop = lifecycleAuthority?.newStopPrice;
      if (typeof v2NewStop === "number" && Number.isFinite(v2NewStop) && v2NewStop > 0) {
        const oldStop = posTrail.stopPrice;
        let validUpdate = false;
        if (oldStop == null || !Number.isFinite(oldStop)) {
          validUpdate = true;
        } else {
          // Enforce only favorable direction: long -> up, short -> down
          if (posTrail.side === "long") {
            if (v2NewStop > oldStop + 1e-8) validUpdate = true;
          } else {
            if (v2NewStop < oldStop - 1e-8) validUpdate = true;
          }
        }

        if (validUpdate) {
          const prevStop = posTrail.stopPrice;
          posTrail.stopPrice = v2NewStop;
          crashPositionsModified = true;
          this.logger.info("V2_TREND_STOP_RAISE_PROOF", {
            symbol: sk,
            side: posTrail.side,
            oldStop: oldStop ?? 0,
            newStop: v2NewStop,
            flowId
          });
          this.logger.info("V2_TREND_LEDGER_STOP_UPDATE_PROOF", {
            symbol: sk,
            side: posTrail.side,
            prevStop: prevStop ?? 0,
            newStop: v2NewStop,
            openedAt: posTrail.openedAt,
            reason: "lifecycle_authority_propagation",
            flowId
          });
        } else if (Math.abs((oldStop ?? 0) - v2NewStop) > 1e-8) {
          this.logger.warn("V2_STOP_UPDATE_REJECTED_UNFAVORABLE", {
            symbol: sk,
            side: posTrail.side,
            oldStop,
            newStop: v2NewStop,
            flowId
          });
        }
      }

      const isV2Pos = this.isV2AuthorityPosition(open);
      const exitManagedByV2 = isV2Pos && (lifecycleAuthority?.exitManagedByV2 === true);
      const partialManagedByV2 = isV2Pos && (lifecycleAuthority?.partialManagedByV2 === true);

      // [V2_LIFECYCLE_AUTHORITY_PROOF]
      if (isV2Pos) {
        this.logger.info("V2_LIFECYCLE_AUTHORITY_PROOF", {
          symbol: open.symbol,
          side: open.side,
          openedAt: open.openedAt,
          exitManaged: exitManagedByV2,
          partialManaged: partialManagedByV2,
          cooldownManaged: lifecycleAuthority?.cooldownManagedByV2 ?? false,
          stateManaged: lifecycleAuthority?.positionStateManagedByV2 ?? false,
          authorityOwner: lifecycleAuthority?.lifecycleAuthorityOwner ?? "unknown",
          executionOwner: lifecycleAuthority?.executionOwner ?? "unknown",
          stage: lifecycleAuthority?.lifecycleStage ?? "unknown"
        });
      }
      
      let v2TakeoverAction: "none" | "close" | "partial_close" = "none";
      let v2TakeoverReason: string | null = null;
      let v2TakeoverDetail: any = null;

      if (v2ExitAuthority?.shouldExit === true) {
        v2TakeoverAction = "close";
        // Map V2 exit reason to standard closeReason
        const rawExitReason = v2ExitAuthority.exitReason ?? "";
        let mappedCloseReason: string;
        if (/stop[_\s]?loss/i.test(rawExitReason)) {
          mappedCloseReason = "stop_loss";
        } else if (/take[_\s]?profit/i.test(rawExitReason)) {
          mappedCloseReason = "take_profit";
        } else if (/trail/i.test(rawExitReason)) {
          mappedCloseReason = "trailing_stop";
        } else if (/trend[_\s]?break/i.test(rawExitReason)) {
          mappedCloseReason = "trend_break_exit";
        } else if (/regime[_\s]?exit/i.test(rawExitReason)) {
          mappedCloseReason = "regime_exit";
        } else if (/range[_\s]?box[_\s]?break/i.test(rawExitReason)) {
          mappedCloseReason = "range_box_break";
        } else {
          mappedCloseReason = "v2_exit_authority";
        }
        v2TakeoverReason = mappedCloseReason;
        v2TakeoverDetail = {
          v2_exit_takeover_applied: true,
          v2_raw_exit_reason: rawExitReason,
          v2_mapped_close_reason: mappedCloseReason,
          v2_exit_urgency: v2ExitAuthority.exitUrgency
        };
      } else if (v2PartialAuthority?.shouldPartial === true) {
        v2TakeoverAction = "partial_close";
        v2TakeoverReason = "v2_partial_authority";
        v2TakeoverDetail = {
          v2_partial_takeover_applied: true,
          v2_partial_reason: v2PartialAuthority.partialReason,
          v2_partial_urgency: v2PartialAuthority.partialUrgency,
          v2_reduce_ratio: v2PartialAuthority.reduceRatio
        };
      }

      let paperExitProofHandled = false;
      let paperPartialProofHandled = false;

      const handleV2ExitAuthorityProof = (paperExitAction: "none" | "exit", paperExitReason: string | null): void => {
        if (!v2ExitAuthority || paperExitProofHandled) return;
        paperExitProofHandled = true;

        const v2PaperExitAgreement =
          (v2ExitAuthority.shouldExit === true && paperExitAction === "exit") ||
          (v2ExitAuthority.shouldExit !== true && paperExitAction === "none");

        const highPriority =
          v2PaperExitAgreement === false ||
          (Array.isArray(v2ExitAuthority.trueInconsistencyReasons) && v2ExitAuthority.trueInconsistencyReasons.length > 0);

        const proofKey = [
          v2ExitAuthority.exitAction,
          v2ExitAuthority.shouldExit,
          v2ExitAuthority.exitUrgency,
          paperExitAction,
          paperExitReason ?? "none",
          v2PaperExitAgreement
        ].join("|");

        if (shouldEmitV2Proof("V2_EXIT_AUTHORITY_PROOF", sk, proofKey, highPriority)) {
          this.logger.info("V2_EXIT_AUTHORITY_PROOF", {
            symbol: sk,
            position_id: `${sk}:${open.side}:${open.entryStage ?? 1}`,
            side: open.side,
            regime: open.regimeAtEntry ?? "NO_TRADE",
            market_mode: input.marketMode.marketMode,
            directional_shock_state: this.lastRisk?.directionalShockState ?? "NONE",
            lifecycle_authority_owner: lifecycleAuthority?.lifecycleAuthorityOwner ?? "unknown",
            exit_authority_owner: v2ExitAuthority.exitAuthorityOwner,
            exit_execution_owner: v2ExitAuthority.exitExecutionOwner,
            v2_exit_action: v2ExitAuthority.exitAction,
            v2_should_exit: v2ExitAuthority.shouldExit,
            v2_exit_reason: v2ExitAuthority.exitReason,
            v2_exit_urgency: v2ExitAuthority.exitUrgency,
            v2_exit_confidence: v2ExitAuthority.exitConfidence,
            v2_reduce_ratio: v2ExitAuthority.reduceRatio,
            paper_exit_action: paperExitAction,
            paper_exit_reason: paperExitReason,
            v2_paper_exit_agreement: v2PaperExitAgreement,
            known_shadow_gaps: v2ExitAuthority.knownShadowGaps ?? [],
            true_inconsistency_reasons: v2ExitAuthority.trueInconsistencyReasons ?? [],
            proof_reasons: v2ExitAuthority.proofReasons ?? []
          });
        }

        const execProofKey = `${v2ExitAuthority.shouldExit}|${paperExitAction}|${v2ExitAuthority.exitReason}|${paperExitReason}`;
        if (shouldEmitV2Proof("V2_EXIT_EXECUTION_AUTHORITY_PROOF", sk, execProofKey, highPriority)) {
          this.logger.info("V2_EXIT_EXECUTION_AUTHORITY_PROOF", {
            symbol: sk,
            side: open.side,
            v2_should_exit: v2ExitAuthority.shouldExit,
            v2_exit_reason: v2ExitAuthority.exitReason,
            v2_exit_urgency: v2ExitAuthority.exitUrgency,
            v2_exit_action: v2ExitAuthority.exitAction,
            paper_exit_action: paperExitAction,
            paper_exit_reason: paperExitReason,
            agreement: v2PaperExitAgreement
          });
        }
      };

      const handleV2PartialAuthorityProof = (
        paperPartialAction: "none" | "partial" | "reduce" | "superseded_by_exit",
        paperPartialReason: string | null
      ): void => {
        if (!v2PartialAuthority || paperPartialProofHandled) return;
        paperPartialProofHandled = true;
        const v2PaperPartialAgreement =
          paperPartialAction === "superseded_by_exit" ||
          (v2PartialAuthority.shouldPartial === true && (paperPartialAction === "partial" || paperPartialAction === "reduce")) ||
          (v2PartialAuthority.shouldPartial !== true && paperPartialAction === "none");
        const proofKey = [
          v2PartialAuthority.partialAction,
          v2PartialAuthority.shouldPartial,
          v2PartialAuthority.partialUrgency,
          paperPartialAction,
          paperPartialReason ?? "none",
          v2PaperPartialAgreement
        ].join("|");
        const highPriority =
          v2PaperPartialAgreement === false ||
          (Array.isArray(v2PartialAuthority.trueInconsistencyReasons) && v2PartialAuthority.trueInconsistencyReasons.length > 0);
        if (!shouldEmitV2Proof("V2_PARTIAL_AUTHORITY_PROOF", sk, proofKey, highPriority)) return;
        this.logger.info("V2_PARTIAL_AUTHORITY_PROOF", {
          symbol: sk,
          position_id: `${sk}:${open.side}:${open.entryStage ?? 1}`,
          side: open.side,
          regime: open.regimeAtEntry ?? "NO_TRADE",
          market_mode: input.marketMode.marketMode,
          directional_shock_state: this.lastRisk?.directionalShockState ?? "NONE",
          lifecycle_authority_owner: lifecycleAuthority?.lifecycleAuthorityOwner ?? "unknown",
          partial_authority_owner: v2PartialAuthority.partialAuthorityOwner,
          partial_execution_owner: v2PartialAuthority.partialExecutionOwner,
          v2_partial_action: v2PartialAuthority.partialAction,
          v2_should_partial: v2PartialAuthority.shouldPartial,
          v2_partial_reason: v2PartialAuthority.partialReason,
          v2_partial_urgency: v2PartialAuthority.partialUrgency,
          v2_partial_confidence: v2PartialAuthority.partialConfidence,
          v2_reduce_ratio: v2PartialAuthority.reduceRatio,
          paper_partial_action: paperPartialAction,
          partial_superseded_by_exit: paperPartialAction === "superseded_by_exit",
          paper_partial_reason: paperPartialReason,
          v2_paper_partial_agreement: v2PaperPartialAgreement,
          known_shadow_gaps: v2PartialAuthority.knownShadowGaps ?? [],
          true_inconsistency_reasons: v2PartialAuthority.trueInconsistencyReasons ?? [],
          proof_reasons: v2PartialAuthority.proofReasons ?? []
        });
      };

      const regimeAtEntry = open.regimeAtEntry ?? "NO_TRADE";

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

      if (v2TakeoverAction === "close") {
        this.logger.info("V2_EXIT_EXECUTION_EARLY_TAKEOVER_PROOF", {
          symbol: open.symbol,
          side: open.side,
          v2_raw_exit_reason: v2ExitAuthority?.exitReason ?? null,
          v2_mapped_close_reason: v2TakeoverReason,
          takeover_applied: true,
          path: "early_exit"
        });
        // V2_EXIT_REASON_MAPPING_PROOF
        this.logger.info("V2_EXIT_REASON_MAPPING_PROOF", {
          symbol: open.symbol,
          side: open.side,
          v2_raw_exit_reason: v2ExitAuthority?.exitReason ?? null,
          mapped_close_reason: v2TakeoverReason,
          v2_exit_urgency: v2ExitAuthority?.exitUrgency ?? null,
          v2_exit_confidence: v2ExitAuthority?.exitConfidence ?? null,
          close_source: "V2_AUTHORITY"
        });
        const cr = v2TakeoverReason as PaperClosedPositionRecord["closeReason"];
        const metricsV2 = leg(open.sizeUsd);
        const closedRow = toClosed(cr, metricsV2, open.sizeUsd);
        
        handleV2ExitAuthorityProof("exit", cr);
        handleV2PartialAuthorityProof("superseded_by_exit", null);
        
        const isStopLossClose = cr === "stop_loss" || String(cr).includes("stop_loss");
        const isTakeProfitClose = cr === "take_profit" || String(cr).includes("take_profit");
        const isTrailingClose = cr === "trailing_stop" || String(cr).includes("trail");
        const closeSubmit = await this.dispatchOkxClose({
          symbol: open.symbol,
          side: open.side,
          sizeUsd: open.sizeUsd,
          okxContracts: open.okxContracts ?? undefined,
          appliedLeverage: Math.max(1, open.leverage ?? 1),
          lastPrice: closePrice,
          flowId,
          reason: cr,
          closeSource: "V2_AUTHORITY",
          authorityOwner: "V2",
          executionOwner: "paper_engine",
          isV2Authority: true,
          isStopLoss: isStopLossClose,
          isTakeProfit: isTakeProfitClose,
          isTrailingStop: isTrailingClose
        });

        if (cr === "take_profit" && String(v2ExitAuthority?.exitReason).startsWith("V2_RANGE")) {
          this.logger.info("V2_RANGE_TP2_CLOSE_ORDER_SUBMIT_PROOF", {
            symbol: open.symbol,
            side: open.side,
            ord_id: closeSubmit?.ordId,
            target_price: closePrice,
            reason: v2ExitAuthority?.exitReason ?? "take_profit"
          });
        }

        const isExchangeEnabled = this.okxDemo && this.signedSubmitMode() === "enabled";
        const closeConfirmed = !isExchangeEnabled || (closeSubmit?.ordId != null && closeSubmit?.fillConfirmed === true);

        if (isExchangeEnabled && !closeConfirmed) {
          const updatedOpen: PaperOpenPositionRecord = { 
            ...open, 
            lifecycleState: "CLOSE_PENDING",
            closePendingOrdId: closeSubmit?.ordId ?? undefined,
            closePendingAt: Date.now(),
            closePendingReason: cr,
            closePendingPrice: closePrice,
            closePendingFundingRate: snap.fundingRate
          };
          this.logger.info("V2_CLOSE_PENDING_EXCHANGE_CONFIRM", {
            symbol: updatedOpen.symbol,
            side: updatedOpen.side,
            ord_id: closeSubmit?.ordId,
            reason: cr
          });
          remaining.push(updatedOpen);
          continue;
        }

        const routedClosed = await this.appendClosedWithStandardRouting({
          closedRow,
          open,
          flowId,
          envelope,
          exitReason: cr,
          closeSource: "V2_AUTHORITY",
          currentRegime: regimeNow
        });

        this.logger.info("V2_CLOSE_EXCHANGE_CONFIRM_PROOF", {
          symbol: open.symbol,
          side: open.side,
          ord_id: closeSubmit?.ordId,
          fill_confirmed: true,
          close_reason: cr
        });

        authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosed);
        
        this.terminalExitConsumedByFlow.add(flowId);
        const mappedType = exitEventJsonlType(cr);
        await this.store.appendJsonlLine("reports/events.jsonl", {
          ts: Date.now(),
          type: mappedType,
          symbol: String(open.symbol),
          side: open.side,
          regime: open.regimeAtEntry ?? null,
          executor: "V2_AUTHORITY",
          reason: cr,
          hold_time: m.holdingMs,
          realized_pnl: m.pnlUsdNet,
          ...buildPositionIdentityMeta(open)
        });
        continue;
      }


      const symKey = String(open.symbol);
      const { longUsd, shortUsd } = marginsForSymbol(opens, symKey);

      // [PARTIAL EXIT PROTECTION]
      // 遺遺꾩껌??TP_PARTIAL / PARTIAL_SPLIT) 吏곹썑 ?붿뿬 ?ъ??섏? POST_PARTIAL_REGIME_PROTECT_MS ?숈븞
      // 二쇱슂 ?덉쭠/?좏샇 ?뚮㈇ 泥?궛(regime_exit, candidate_lost, trend_switch) ?쇱떆 李⑤떒.
      // ??STRUCTURAL, CRASH_FORCE, STOP_LOSS, TRAILING ? ?덉슜?쒕떎(?덉쟾留??곗냼).
      // ???뚮옒洹몃뒗 shouldDeferRegimeLaneTransitionClose ?덉뿉??李몄“?쒕떎.
      const postPartialProtectActive: boolean = (
        (open.partialExitStage ?? 0) >= 1 &&
        open.lastPartialAt !== undefined &&
        closedAt - open.lastPartialAt < POST_PARTIAL_REGIME_PROTECT_MS
      );
      if (postPartialProtectActive) {
        this.logger.info("POST_PARTIAL_REGIME_PROTECT_ACTIVE", {
          symbol: open.symbol,
          side: open.side,
          flowId,
          partialExitStage: open.partialExitStage,
          lastPartialAt: open.lastPartialAt,
          elapsed_since_partial_ms: open.lastPartialAt ? closedAt - open.lastPartialAt : null,
          protect_window_ms: POST_PARTIAL_REGIME_PROTECT_MS,
          note: "regime_exit/candidate_lost 醫낅쪟 ????낅룄 ?쇱떆 李⑤떒"
        });
      }

      const rr = this.rangeRuntimeBySymbol.get(symKey) ?? {
        lastZone: null as RangeBoxZone | null,
        cycle: 0,
        ladder: 0
      };

      let rangeState = null as ReturnType<typeof evaluateRangeEngineForSymbol> | null;
      // [V2_EXIT_SOVEREIGNTY_GATE] Skip legacy RANGE exit logic if V2 is managing
      if (rangeManagedPosition && !exitManagedByV2) {
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
            const raZone = classifyRangeZone(snap.boxPos);
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

              if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "regime_exit", postPartialProtectActive)) {
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
                remaining.push(posTrail);
                continue;
              }

              const exitConf = this.evaluateRegimeExitConfirmation(posTrail, "RANGE_EXECUTOR", "range_long_upper_reversal_confirmed", 2, closedAt);
              if (!exitConf.confirmed) {
                remaining.push(exitConf.updatedPosition);
                continue;
              }
              posTrail = exitConf.updatedPosition;

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
                closeReasonLabelOverride: "?곷떒 諛섏쟾 援ш컙: 濡??뺣━(???됯? ?곗꽑)",
                ...snapPaths
              });
              handleV2ExitAuthorityProof("exit", cr);
              handleV2PartialAuthorityProof("superseded_by_exit", null);
              await this.dispatchOkxClose({
                symbol: open.symbol,
                side: open.side,
                sizeUsd: open.sizeUsd,
                okxContracts: open.okxContracts ?? undefined,
                appliedLeverage: Math.max(1, open.leverage ?? 1),
                lastPrice: closePrice,
                flowId,
                reason: "range_long_upper_reversal"
              });
              const routedClosed = await this.appendClosedWithStandardRouting({
                closedRow,
                open,
                flowId,
                envelope,
                exitReason: cr,
                closeSource: "range_reversal_logic",
                currentRegime: regimeNow
              });
              authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosed);
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
              this.lastExitReasonLabel = "?곷떒 諛섏쟾 援ш컙 濡??뺣━";

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
              handleV2ExitAuthorityProof("none", null);
              handleV2PartialAuthorityProof("none", null);
              continue;
            }
          }
          if (open.side === "short" && typeof snap.boxPos === "number" && Number.isFinite(snap.boxPos)) {
            const raZone = classifyRangeZone(snap.boxPos);
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

              if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "regime_exit", postPartialProtectActive)) {
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
                remaining.push(posTrail);
                continue;
              }

              const exitConf = this.evaluateRegimeExitConfirmation(posTrail, "RANGE_EXECUTOR", "range_short_lower_reversal_confirmed", 2, closedAt);
              if (!exitConf.confirmed) {
                remaining.push(exitConf.updatedPosition);
                continue;
              }
              posTrail = exitConf.updatedPosition;

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
                closeReasonLabelOverride: "?섎떒 諛섏쟾 援ш컙: ???뺣━(濡??됯? ?곗꽑)",
                ...snapPaths
              });
              handleV2ExitAuthorityProof("exit", cr);
              handleV2PartialAuthorityProof("superseded_by_exit", null);
              await this.dispatchOkxClose({
                symbol: open.symbol,
                side: open.side,
                sizeUsd: open.sizeUsd,
                okxContracts: open.okxContracts ?? undefined,
                appliedLeverage: Math.max(1, open.leverage ?? 1),
                lastPrice: closePrice,
                flowId,
                reason: "range_short_lower_reversal"
              });
              const routedClosed = await this.appendClosedWithStandardRouting({
                closedRow,
                open,
                flowId,
                envelope,
                exitReason: cr,
                closeSource: "range_reversal_logic",
                currentRegime: regimeNow
              });
              authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosed);
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
              this.lastExitReasonLabel = "?섎떒 諛섏쟾 援ш컙 ???뺣━";

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
              handleV2ExitAuthorityProof("none", null);
              handleV2PartialAuthorityProof("none", null);
              continue;
            }
          }
        }
      }

      const symKeyStr = String(open.symbol);
      const priorBr = this.trendBreakoutBySymbol.get(symKeyStr) ?? "none";
      let trendState = null as ReturnType<typeof evaluateTrendEngineForSymbol> | null;
      // [V2_EXIT_SOVEREIGNTY_GATE] Skip legacy TREND switch logic if V2 is managing
      if ((exitLane === "TREND" || regimeAtEntry === "TREND") && !exitManagedByV2) {
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
            ? classifyRangeZone(snap.boxPos)
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
          if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "range_profit_trail", postPartialProtectActive)) {
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
            closeReasonLabelOverride: "?섏씡沅??섎룎由?異붿쥌 泥?궛",
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
          handleV2ExitAuthorityProof("exit", crTrail);
          handleV2PartialAuthorityProof("superseded_by_exit", null);
          await this.dispatchOkxClose({
            symbol: open.symbol,
            side: open.side,
            sizeUsd: open.sizeUsd,
            okxContracts: open.okxContracts ?? undefined,
            appliedLeverage: Math.max(1, open.leverage ?? 1),
            lastPrice: closePrice,
            flowId,
            reason: "range_profit_trail"
          });
          const routedClosedTrail = await this.appendClosedWithStandardRouting({
            closedRow: closedRowTrail,
            open,
            flowId,
            envelope,
            exitReason: crTrail,
            closeSource: "range_profit_trail",
            currentRegime: regimeNow
          });
          authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosedTrail);
          this.lastExitReasonLabel = "?섏씡沅??섎룎由?異붿쥌 泥?궛";

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
          handleV2ExitAuthorityProof("none", null);
          handleV2PartialAuthorityProof("none", null);
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
            typeof snap.boxPos === "number" && Number.isFinite(snap.boxPos) ? classifyRangeZone(snap.boxPos) : ("mid" as const);
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
                closeReasonLabelOverride: "由ъ뒪???몄텧 ?쒕룄 珥덇낵",
                ...snapPaths
              })
              : toClosed(cr, m, open.sizeUsd);
          handleV2ExitAuthorityProof("exit", cr);
          handleV2PartialAuthorityProof("superseded_by_exit", null);
          await this.dispatchOkxClose({
            symbol: open.symbol,
            side: open.side,
            sizeUsd: open.sizeUsd,
            appliedLeverage: Math.max(1, open.leverage ?? 1),
            lastPrice: closePrice,
            flowId,
            reason: st.reason ?? cr
          });
          const routedClosed = await this.appendClosedWithStandardRouting({
            closedRow,
            open,
            flowId,
            envelope,
            exitReason: cr,
            closeSource: confirmedCloseSource ?? "executor_close_action",
            currentRegime: regimeNow
          });
          authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosed);
          this.lastExitReasonLabel =
            st.reason === "range_box_break"
              ? "諛뺤뒪 遺뺢눼 泥?궛"
              : st.reason === "structural_regime_shift"
                ? "援ъ“??異붿꽭 ?꾪솚 泥?궛"
                : "?몄텧 ?쒕룄 泥?궛";

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
          handleV2ExitAuthorityProof("none", null);
          handleV2PartialAuthorityProof("none", null);
          continue;
        }
      }

      if (regimeAtEntry === "TREND" && trendState) {
        const plan = planTrendSwitch(trendState, open.side);
        if (plan.execute && plan.openSide && plan.closeSide) {
          if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "trend_switch", postPartialProtectActive)) {
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
          handleV2ExitAuthorityProof("exit", cr);
          handleV2PartialAuthorityProof("superseded_by_exit", null);
          await this.dispatchOkxClose({
            symbol: open.symbol,
            side: open.side,
            sizeUsd: open.sizeUsd,
            appliedLeverage: Math.max(1, open.leverage ?? 1),
            lastPrice: closePrice,
            flowId,
            reason: "trend_switch_close"
          });

          let newSz = Math.max(
            MIN_POSITION_SIZE_USD,
            Math.round(open.sizeUsd * input.riskExposure.switchSizeMultiplier * 100) / 100
          );
          if (this.okxDemo) {
            const oSide = plan.openSide === "long" ? "buy" : "sell";
            const oPosSide = plan.openSide === "long" ? "long" : "short";
            const oQtyLegacy = Math.max(0.001, Math.round((newSz / Math.max(1e-9, closePrice)) * 1_000_000) / 1_000_000);
            const oLev = Math.max(1, open.leverage ?? 1);
            await this.submitOkxOrder({
              symbol: open.symbol,
              side: oSide,
              posSide: oPosSide,
              qty: oQtyLegacy,
              desiredNotionalUsdt: newSz * oLev,
              pricingReferencePx: closePrice,
              appliedLeverage: oLev,
              clOrdId: buildOkxClOrdId(open.symbol, oSide),
              traceId: flowId,
              reason: "trend_switch_open",
              isNewEntry: true
            });
          }

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
          const routedClosed = await this.appendClosedWithStandardRouting({
            closedRow,
            open,
            flowId,
            envelope,
            exitReason: cr,
            closeSource: String(closedRow.closeSource ?? "executor_close_action"),
            currentRegime: regimeNow
          });
          authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosed);
          this.lastExitReasonLabel = "異붿꽭 諛섎? ?뚰뙆濡?泥?궛";
          this.lastSwitchReasonLabel = trendState.trendSwitchReasonLabel;
          this.trendSwitchTimestampsMs.push(Date.now());
          const mappedType = exitEventJsonlType(cr);
          this.terminalExitConsumedByFlow.add(flowId);
          if (mappedType === "EXIT_TREND_SWITCH") {
            // ?ㅼ쐞移?? 諛섎? 諛⑺뼢?쇰줈 ?대━誘濡?Dedup????吏꾩엯??留됱? ?딆쓬 (諛⑺뼢???ㅻ쫫)
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
          newSz = Math.max(
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
            pos: newSz / (closePrice || 1),
            notional: newSz,
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
            ...(open.authoritySourceAtEntry !== undefined
              ? { authoritySourceAtEntry: open.authoritySourceAtEntry }
              : {}),
            ...(open.authoritySideAtEntry !== undefined
              ? { authoritySideAtEntry: open.authoritySideAtEntry }
              : {}),
            ...(typeof open.authority === "string" ? { authority: open.authority } : {}),
            ...(typeof open.authoritySide === "string" ? { authoritySide: open.authoritySide } : {}),
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



      // 2. Regime Flip / Trend Break check (?섏쐞 ?몃━嫄????곸쐞 exit authority ?ы뙋???꾩뿉留??꾨웾 泥?궛)
      // [V2_EXIT_SOVEREIGNTY_GATE] Skip legacy TREND break logic if V2 is managing
      if (regimeAtEntry === "TREND" && !exitManagedByV2) {
        const trendOkNow = snap.trendOk === true;
        if (regimeNow !== "TREND" || !trendOkNow) {
          if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "trend_break_exit", postPartialProtectActive)) {
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
            remaining.push(posTrail);
            continue;
          }
          const cr: PaperClosedPositionRecord["closeReason"] =
            marketMode === "RANGE" || marketMode === "NO_TRADE" ? "regime_exit" : "trend_break_exit";

          const exitConf = this.evaluateRegimeExitConfirmation(posTrail, "UPPER_ENGINE", `upper_authority_trend_break_${cr}`, 2, closedAt);
          if (!exitConf.confirmed) {
            remaining.push(exitConf.updatedPosition);
            continue;
          }
          posTrail = exitConf.updatedPosition;

          finalCloseReason = cr;
          confirmedExitType = exitEventJsonlType(cr);
          confirmedCloseSource =
            cr === "regime_exit"
              ? "trend_gate_upper_regime_lane_exit"
              : "trend_regime_shift_gate_upper_opposing_trend_confirmed";
          const closedRow = toClosed(cr, m, open.sizeUsd);
          handleV2ExitAuthorityProof("exit", cr);
          handleV2PartialAuthorityProof("superseded_by_exit", null);
          await this.dispatchOkxClose({
            symbol: open.symbol,
            side: open.side,
            sizeUsd: open.sizeUsd,
            appliedLeverage: Math.max(1, open.leverage ?? 1),
            lastPrice: closePrice,
            flowId,
            reason: `regime_shift_${cr}`
          });
          const routedClosed = await this.appendClosedWithStandardRouting({
            closedRow,
            open,
            flowId,
            envelope,
            exitReason: cr,
            closeSource: String(closedRow.closeSource ?? "executor_close_action"),
            currentRegime: regimeNow
          });
          authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosed);
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

      // 3. RANGE / TREND ?ㅽ뻾湲?遺꾨━(?ъ????덉쭚쨌?곸쐞 紐⑤뱶濡??덉씤 ?좏깮)
      // [V2_EXIT_SOVEREIGNTY_GATE] Skip legacy executor evaluation if V2 is managing exit/partial
      let exitEval: { action: "hold" | "close" | "partial_close"; reason?: string | null; detail?: any; [key: string]: any } = { action: "hold" };

      if (!exitManagedByV2 && !partialManagedByV2) {
        exitEval =
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
      }

      const regimeExitSnap = evaluateRegimeExitPolicy({
        regime: slRegime,
        side: open.side,
        pnlPctNet: m.pnlPctNet,
        holdingMs: m.holdingMs,
        mark: closePrice,
        trailingExtreme: open.trailingExtremePrice,
        partialExitStage: open.partialExitStage ?? 0
      });
      const partialPol = evaluatePartialExitPolicy({
        mode: open.adaptiveModeAtEntry ?? this.lastAdaptiveMode.mode,
        direction: open.side,
        pnlPctNet: m.pnlPctNet,
        highestPnlPctNet: open.highestPnlPctNet ?? m.pnlPctNet,
        holdingMs: m.holdingMs,
        partialExitStage: open.partialExitStage ?? 0
      });
      const diagTs = Date.now();
      const lastExitPf = this.positionExitProofThrottleByFlow.get(flowId) ?? 0;

      // --- Adopted / Close-Only Policy Enforcement ---
      if (open.reconcileState === "ADOPTED" || open.lifecycleState === "CLOSE_ONLY_MANAGED") {
        const policyAction = regimeExitSnap.action;
        
        if (policyAction === "close") {
          const policyReason = regimeExitSnap.reason;
          this.logger.info("ADOPTED_POLICY_EXIT_OVERRIDE_PROOF", {
            symbol: open.symbol,
            side: open.side,
            policy_reason: policyReason,
            original_executor_action: exitEval.action,
            action: "override_to_close"
          });
          exitEval = {
            ...exitEval,
            action: "close",
            reason: policyReason as any
          };
        } else if (partialPol.shouldExitPartial && exitEval.action === "hold") {
          this.logger.info("ADOPTED_POLICY_PARTIAL_OVERRIDE_PROOF", {
            symbol: open.symbol,
            side: open.side,
            partial_reason: partialPol.reason,
            action: "override_to_partial"
          });
          exitEval = {
            ...exitEval,
            action: "partial_close",
            reason: partialPol.reason as any
          };
        }
      }


      if (diagTs - lastExitPf >= 15_000) {

        this.positionExitProofThrottleByFlow.set(flowId, diagTs);
        this.logger.info("POSITION_EXIT_POLICY_PROOF", {
          symbol: open.symbol,
          side: open.side,
          flowId,
          regime_at_entry: open.regimeAtEntry ?? null,
          exit_lane_sl_regime: slRegime,
          mark: closePrice,
          holding_ms: m.holdingMs,
          pnl_pct_net: m.pnlPctNet,
          stop_price_ledger: open.stopPrice ?? null,
          stop_loss_pct_gate: stopLossPctForRegime(slRegime),
          regime_exit_snapshot: regimeExitSnap,
          executor_exit_eval_action: exitEval.action,
          executor_exit_eval_reason:
            exitEval && typeof (exitEval as { reason?: unknown }).reason === "string"
              ? (exitEval as { reason: string }).reason
              : null
        });
        this.logger.info("POSITION_PARTIAL_POLICY_PROOF", {
          symbol: open.symbol,
          side: open.side,
          flowId,
          adaptive_mode: open.adaptiveModeAtEntry ?? this.lastAdaptiveMode.mode,
          partial_stage: open.partialExitStage ?? 0,
          partial_policy: partialPol,
          executor_partial_signal: exitEval.action === "partial_close"
        });
      }

      // --- V2 AUTHORITY TAKEOVER (Hoisted & Hardened) ---
      // [BLOCK_FIRST_POLICY] Skip all automated V2 takeover actions if symbol is blocked (KEY_MISMATCH)
      if (this.symbolExternalManualBlocked.has(symSideKey)) {
        this.logger.info("V2_TAKEOVER_SKIPPED_SYNC_BLOCK", {
          symbol: open.symbol,
          side: open.side,
          v2_action: v2TakeoverAction,
          reason: "KEY_MISMATCH_OR_EXTERNAL_MANUAL_BLOCK"
        });
        remaining.push(openRaw);
        continue;
      }
      // V2 EXIT???꾩뿉???대? early return?덉쑝誘濡??ш린??partial_close ?좏샇留??⑥쓬.
      // partial_close??exitEval???듭?濡?二쇱엯?섏? ?딄퀬 ?낅┰ 寃쎈줈濡?泥섎━?쒕떎.
      if ((v2TakeoverAction as string) !== "none" && (v2TakeoverAction as string) !== "partial_close") {
        // V2 EXIT_BRIDGE_PROOF (??寃쎈줈????early takeover?먯꽌 泥섎━?? 諛⑹뼱?⑸쭔 ?④?)
        this.logger.info("V2_EXIT_EXECUTION_BRIDGE_PROOF", {
          symbol: open.symbol,
          side: open.side,
          v2_action: v2TakeoverAction,
          v2_reason: v2TakeoverReason,
          original_action: exitEval.action,
          takeover_applied: true
        });
      }

      // V2 PARTIAL: ?낅┰ early takeover 寃쎈줈. exitEval ?ㅼ뿼 ?놁씠 吏곸젒 ?ㅽ뻾.
      if ((v2TakeoverAction as string) === "partial_close" && v2PartialAuthority?.shouldPartial === true) {
        const reduceRatio = v2PartialAuthority.reduceRatio ?? 0.5;
        const partialSizeUsd = open.sizeUsd * reduceRatio;
        
        // [PARTIAL_EXECUTION_PROOF] Task 5: Detailed partial execution log for V2 authority
        this.logger.info("PARTIAL_EXECUTION_PROOF", {
          ts: Date.now(),
          symbol: open.symbol,
          side: open.side,
          partial_ratio: reduceRatio,
          partial_size_usd: partialSizeUsd,
          remaining_size_usd: open.sizeUsd - partialSizeUsd,
          reason: v2PartialAuthority.partialReason,
          urgency: v2PartialAuthority.partialUrgency,
          authority_owner: "V2"
        });

        const MIN_PARTIAL_NOTIONAL = 5; // minimum $5 partial
        if (partialSizeUsd < MIN_PARTIAL_NOTIONAL) {
          this.logger.warn("V2_PARTIAL_SIZE_BUILD_PROOF", {
            symbol: open.symbol,
            side: open.side,
            reduce_ratio: reduceRatio,
            full_size_usd: open.sizeUsd,
            partial_size_usd: partialSizeUsd,
            min_notional: MIN_PARTIAL_NOTIONAL,
            blocked: true,
            block_reason: "partial_size_below_min_notional"
          });
          remaining.push(open);
          continue;
        }

        this.logger.info("V2_PARTIAL_EXECUTION_EARLY_TAKEOVER_PROOF", {
          symbol: open.symbol,
          side: open.side,
          v2_partial_reason: v2PartialAuthority.partialReason,
          v2_partial_urgency: v2PartialAuthority.partialUrgency,
          v2_reduce_ratio: reduceRatio,
          takeover_applied: true,
          path: "early_partial"
        });
        this.logger.info("V2_PARTIAL_SIZE_BUILD_PROOF", {
          symbol: open.symbol,
          side: open.side,
          reduce_ratio: reduceRatio,
          full_size_usd: open.sizeUsd,
          partial_size_usd: partialSizeUsd,
          min_notional: MIN_PARTIAL_NOTIONAL,
          blocked: false
        });

        const pSide = open.side === "long" ? "sell" : "buy";
        const pPosSide = open.side;
        this.logger.info("V2_PARTIAL_ORDER_PATH_PROOF", {
          symbol: open.symbol,
          side: pSide,
          pos_side: pPosSide,
          partial_size_usd: partialSizeUsd,
          last_price: closePrice,
          v2_partial_reason: v2PartialAuthority.partialReason,
          flowId
        });

        const partialSubmit = await this.dispatchOkxClose({
          symbol: open.symbol,
          side: open.side,
          sizeUsd: partialSizeUsd,
          appliedLeverage: Math.max(1, open.leverage ?? 1),
          lastPrice: closePrice,
          flowId,
          reason: v2PartialAuthority.partialReason ?? "v2_partial_exit",
          closeSource: "V2_PARTIAL_AUTHORITY",
          authorityOwner: "V2",
          executionOwner: "paper_engine",
          isV2Authority: true,
          isPartial: true
        });

        this.logger.info("PARTIAL_EXECUTION_PROOF", {
          symbol: open.symbol,
          side: open.side,
          requested_ratio: reduceRatio,
          partial_size_usd: partialSizeUsd,
          lev: open.leverage,
          desired_notional_usdt: partialSizeUsd,
          submit_ok: partialSubmit?.ok,
          ord_id: partialSubmit?.ordId,
          fill_confirmed: partialSubmit?.fillConfirmed,
          reason: v2PartialAuthority.partialReason ?? "v2_partial_exit"
        });

        if (String(v2PartialAuthority.partialReason).startsWith("V2_RANGE_TAKE_PROFIT")) {
          this.logger.info("V2_RANGE_TP1_REDUCE_ORDER_SUBMIT_PROOF", {
            symbol: open.symbol,
            side: open.side,
            ord_id: partialSubmit?.ordId,
            target_price: closePrice,
            reason: v2PartialAuthority.partialReason
          });
        }

        const isExchangeEnabled = this.okxDemo && this.signedSubmitMode() === "enabled";
        const partialConfirmed = !isExchangeEnabled || (partialSubmit?.ordId != null && partialSubmit?.fillConfirmed === true);

        if (isExchangeEnabled && !partialConfirmed) {
          const updatedOpen: PaperOpenPositionRecord = {
            ...open,
            lifecycleState: "PARTIAL_PENDING",
            partialPendingOrdId: partialSubmit?.ordId ?? undefined,
            partialPendingSizeUsd: partialSizeUsd,
            partialPendingOriginalSizeUsd: partialSizeUsd,
            partialPendingProcessedFillSz: 0,
            partialPendingProcessedUsd: 0,
            partialPendingAt: Date.now(),
            partialPendingReduceRatio: reduceRatio,
            partialPendingReason: v2PartialAuthority.partialReason ?? "v2_partial_exit",
            partialPendingPrice: closePrice,
            partialPendingFundingRate: snap.fundingRate
          };
          this.logger.info("V2_PARTIAL_EXCHANGE_PENDING_PROOF", {
            symbol: open.symbol,
            side: open.side,
            ord_id: partialSubmit?.ordId,
            partial_size_usd: partialSizeUsd
          });
          remaining.push(updatedOpen);
          continue;
        }

        this.logger.info("V2_PARTIAL_EXCHANGE_CONFIRM_PROOF", {
          symbol: open.symbol,
          side: open.side,
          ord_id: partialSubmit?.ordId,
          fill_confirmed: true,
          partial_size_usd: partialSizeUsd
        });

        this.logger.info("POSITION_PARTIAL_CLOSE_EVALUATION_PROOF", {
          symbol: open.symbol,
          partial_triggered: true,
          reduce_only: true,
          current_position_size: open.sizeUsd,
          requested_close_size: partialSizeUsd,
          remaining_position_size: Math.max(0, open.sizeUsd - partialSizeUsd),
          ledger_update_required: true,
          flowId
        });

        // Partial position update - reduce size, pos, notional
        const remainingSizeUsd = Math.max(0, open.sizeUsd - partialSizeUsd);
        const ratioRemaining = open.sizeUsd > 0 ? (remainingSizeUsd / open.sizeUsd) : 0;
        const updatedOpen: typeof open = {
          ...open,
          sizeUsd: remainingSizeUsd,
          pos: (open.pos ?? 0) * ratioRemaining,
          notional: (open.notional ?? 0) * ratioRemaining,
          initialSizeUsd: (open.initialSizeUsd ?? open.sizeUsd) * ratioRemaining,
          partialExitStage: (open.partialExitStage ?? 0) + 1,
          lastPartialAt: closedAt
        };
        this.logger.info("V2_PARTIAL_POSITION_UPDATE_PROOF", {
          symbol: open.symbol,
          side: open.side,
          size_before_usd: open.sizeUsd,
          partial_size_executed_usd: partialSizeUsd,
          size_after_usd: remainingSizeUsd,
          partial_exit_stage_after: updatedOpen.partialExitStage,
          full_close_prevented: true,
          open_ledger_pruned: false
        });

        handleV2PartialAuthorityProof("partial", v2PartialAuthority.partialReason);
        handleV2ExitAuthorityProof("none", null);
        remaining.push(updatedOpen);
        continue;
      }

      if (
        exitLane === "RANGE" &&
        open.regimeAtEntry === "RANGE" &&
        ((open.side === "short" && open.rangeEntryZone === "upper") ||
          (open.side === "long" && open.rangeEntryZone === "lower")) &&
        (open.partialExitStage ?? 0) === 0 &&
        open.rangeFirstProfitLocked !== true &&
        exitEval.action === "hold" &&
        !partialManagedByV2 // [V2_PARTIAL_SOVEREIGNTY_GATE]
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
            guidance: open.side === "short" ? "RANGE upper short 泥??섏씡沅?誘몄꽭 ?좉툑" : "RANGE lower long 泥??섏씡沅?誘몄꽭 ?좉툑",
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
        if (m.pnlPctNet > 0.005) { // 0.5% ?댁긽 ?섏씡沅뚯씠硫???댄듃?섍쾶 蹂댄샇
          const trailGap = (snap.atr ?? 0) * 0.48;
          const crashTrailStop = (open.trailingExtremePrice ?? open.entryPrice) + trailGap;
          // ?륁씠誘濡?媛寃⑹씠 ?곸듅?섏뿬 ??吏?먯쓣 ?곗튂?섎㈃ 泥?궛
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
        if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, highwayReason, postPartialProtectActive)) {
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
        if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, cr, postPartialProtectActive)) {
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
          remaining.push(posTrail);
          continue;
        }

        if (cr === "regime_exit" || cr === "trend_break_exit" || cr === "candidate_lost" || cr === "trend_switch") {
          const exDetail = (exitEval.detail ?? {}) as Record<string, unknown>;
          const triggerOwner = trendManagedPosition ? "TREND_EXECUTOR" : "RANGE_EXECUTOR";
          const invalidationReason = exDetail["upper_authority_exit_trigger"] ? String(exDetail["upper_authority_exit_trigger"]) : `executor_verdict_${cr}`;
          
          const exitConf = this.evaluateRegimeExitConfirmation(posTrail, triggerOwner, invalidationReason, 2, closedAt);
          if (!exitConf.confirmed) {
            remaining.push(exitConf.updatedPosition);
            continue;
          }
          posTrail = exitConf.updatedPosition;
        }

        finalCloseReason = cr;
        confirmedExitType = exitEventJsonlType(cr);
        confirmedCloseSource = cr === "v2_exit_authority" ? "V2_AUTHORITY" : "executor_close_action";
        const exDetail = (exitEval.detail ?? {}) as Record<string, unknown>;
        const closedRow = toClosed(cr, m, open.sizeUsd);
        handleV2ExitAuthorityProof("exit", cr);
        handleV2PartialAuthorityProof("superseded_by_exit", null);
        const exitSubmit = await this.dispatchOkxClose({
          symbol: open.symbol,
          side: open.side,
          sizeUsd: open.sizeUsd,
          appliedLeverage: Math.max(1, open.leverage ?? 1),
          lastPrice: closePrice,
          flowId,
          reason: `executor_${cr}`,
          isV2Authority: true
        });

        const isExchangeEnabled = this.okxDemo && this.signedSubmitMode() === "enabled";
        const closeConfirmed = !isExchangeEnabled || (exitSubmit?.ordId != null && exitSubmit?.fillConfirmed === true);

        if (isExchangeEnabled && !closeConfirmed) {
          const updatedOpen: PaperOpenPositionRecord = {
            ...open,
            lifecycleState: "CLOSE_PENDING",
            closePendingOrdId: exitSubmit?.ordId ?? undefined,
            closePendingAt: Date.now(),
            closePendingReason: cr,
            closePendingPrice: closePrice
          };
          this.logger.info("V2_CLOSE_EXCHANGE_PENDING_PROOF", {
            symbol: open.symbol,
            side: open.side,
            ord_id: exitSubmit?.ordId,
            reason: cr
          });
          remaining.push(updatedOpen);
          continue;
        }

        const routedClosed = await this.appendClosedWithStandardRouting({
          closedRow,
          open,
          flowId,
          envelope,
          exitReason: cr,
          closeSource: String(closedRow.closeSource ?? "executor_close_action"),
          currentRegime: regimeNow
        });
        authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosed);
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

        if (cr === "v2_exit_authority") {
          this.lastExitReasonLabel = `V2 ?곗꽑 沅뚰븳 泥?궛 (${v2ExitAuthority?.exitReason ?? "N/A"})`;
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
          handleV2PartialAuthorityProof("partial", pReason);
          const mp = leg(partialMargin);

          // [FIX: history-ledger] Partial exits (partial_exit_1, partial_exit_2) are
          // intermediate sub-events within a position lifecycle ??NOT final position closes.
          // They must NOT be appended to positions/history.json.
          // The position identity is preserved; only the final full-close goes to the ledger.
          // Sub-events are recorded to events.jsonl only (below).
          if (this.okxDemo) {
            const pSide = open.side === "long" ? "sell" : "buy";
            const pPosSide = open.side === "long" ? "long" : "short";
            const pQtyLegacy = Math.max(0.001, Math.round((partialMargin / Math.max(1e-9, mp.mark)) * 1_000_000) / 1_000_000);
            const pLev = Math.max(1, open.leverage ?? 1);
            const partialClOrdId = buildOkxClOrdId(open.symbol, pSide);
            this.logger.info("V2_PARTIAL_ORDER_PATH_PROOF", {
              symbol: open.symbol,
              side: pSide,
              qty_legacy_base_estimate: pQtyLegacy,
              desired_notional_usdt: partialMargin * pLev,
              clOrdId: partialClOrdId,
              traceId: flowId,
              reason: `partial_close_${pReason}`
            });
            await this.submitOkxOrder({
              symbol: open.symbol,
              side: pSide,
              posSide: pPosSide,
              qty: pQtyLegacy,
              desiredNotionalUsdt: partialMargin * pLev,
              pricingReferencePx: mp.mark,
              appliedLeverage: pLev,
              clOrdId: partialClOrdId,
              traceId: flowId,
              reason: `partial_close_${pReason}`,
              isNewEntry: false
            });
          }
          const closedPartial = toClosed(pReason, mp, partialMargin);
          // NOTE: appendClosed intentionally omitted here. closedPartial is for events.jsonl only.

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

          this.logger.info("POSITION_PARTIAL_CLOSE_EVALUATION_PROOF", {
            symbol: open.symbol,
            partial_triggered: true,
            reduce_only: true,
            current_position_size: open.sizeUsd,
            requested_close_size: partialMargin,
            remaining_position_size: newMargin,
            ledger_update_required: true,
            flowId
          });

          const ratioRemaining = open.sizeUsd > 0 ? (newMargin / open.sizeUsd) : 0;
          open = {
            ...open,
            sizeUsd: newMargin,
            pos: (open.pos ?? 0) * ratioRemaining,
            notional: (open.notional ?? 0) * ratioRemaining,
            initialSizeUsd: (open.initialSizeUsd ?? open.sizeUsd) * ratioRemaining,
            partialExitStage: stage,
            lifecycleState: "PARTIAL_ACTIVE",
            lastPartialAt: closedAt,
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
            ? classifyRangeZone(snap.boxPos)
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
          if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "regime_exit", postPartialProtectActive)) {
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

          const exitConf = this.evaluateRegimeExitConfirmation(posTrail, "RANGE_EXECUTOR", "range_misaligned_safety_net_confirmed", 2, closedAt);
          if (!exitConf.confirmed) {
            remaining.push(exitConf.updatedPosition);
            continue;
          }
          posTrail = exitConf.updatedPosition;

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
                ? "RANGE ?뺥빀?? ?곷떒 濡?媛뺤젣 泥?궛"
                : "RANGE ?뺥빀?? ?섎떒 ??媛뺤젣 泥?궛",
            ...snapPaths
          });
          await this.dispatchOkxClose({
            symbol: open.symbol,
            side: open.side,
            sizeUsd: open.sizeUsd,
            appliedLeverage: Math.max(1, open.leverage ?? 1),
            lastPrice: closePrice,
            flowId,
            reason: "safety_net_alignment"
          });
          const routedClosed = await this.appendClosedWithStandardRouting({
            closedRow,
            open,
            flowId,
            envelope,
            exitReason: cr,
            closeSource: "range_misaligned_safety_net",
            currentRegime: regimeNow
          });
          authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosed);
          this.logger.info("RANGE_CLOSE_ALIGNMENT_PROOF", {
            symbol: open.symbol,
            side: open.side,
            range_zone_detected: raZone,
            range_hold_alignment: false,
            range_hold_misaligned_exit_applied: true,
            box_pos: snap.boxPos ?? null,
            phase: "default_persistence_regime_exit_safety_net"
          });
          this.lastExitReasonLabel = open.side === "long" ? "RANGE ?곷떒 濡??뺥빀??泥?궛" : "RANGE ?섎떒 ???뺥빀??泥?궛";
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
        // mid: 臾댁“嫄??좎? 湲덉? ???꾨옒 minHold / candidate_lost 濡?吏꾪뻾
      } else {
        const zk =
          typeof snap.boxPos === "number" && Number.isFinite(snap.boxPos) ? classifyRangeZone(snap.boxPos) : ("mid" as const);
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

      /** 利앹븸(?ㅽ뀒?댁? 2+)쨌洹쒕え ?뺣? ?ъ??? ?좏샇 ?뚮㈇ ???쒓컙 泥?궛쨌?좎삁瑜???吏㏐쾶 (RANGE ?ъ??섏? ?곷떒?먯꽌 ?대? 遺꾧린?? */
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
        ((open.side === "long" && classifyRangeZone(snap.boxPos) !== "lower") ||
          (open.side === "short" && classifyRangeZone(snap.boxPos) !== "upper"));

      const tightHold = open.regimeAtEntry === "RANGE" && opposingSignal && zoneMismatch;
      const isImmatureRange = !stagedOrScaled && open.rangeFirstProfitLocked !== true;

      const baseMinHoldMs = stagedOrScaled ? 4 * 60_000 : 5 * 60_000;
      const baseGracePeriodMs = stagedOrScaled ? 4 * 60_000 : 7 * 60_000;

      const tightMinHoldMs = isImmatureRange ? 3 * 60_000 : 1 * 60_000;
      const tightGracePeriodMs = isImmatureRange ? 3 * 60_000 : 1 * 60_000;

      const minHoldMsEff = tightHold ? Math.min(baseMinHoldMs, tightMinHoldMs) : baseMinHoldMs;
      const gracePeriodMs = tightHold ? Math.min(baseGracePeriodMs, tightGracePeriodMs) : baseGracePeriodMs;
      const minLostStreak = ENTRY_SIGNAL_LOST_CONFIRM_TICKS;
      const signalLostCandidateCount = (posTrail.candidateLostStreak ?? 0) + 1;
      const entryEvidence = open.entryEvidence;

      if (m.pnlPctNet < 0) {
        this.logger.info("EXIT_PRIORITY_PROOF", {
          symbol: open.symbol,
          side: open.side,
          flowId,
          pnl_pct_net: m.pnlPctNet,
          pnl_usd_net: m.pnlUsdNet,
          skipped_exit: "candidate_lost_watchdog",
          priority_rule: "risk_sl_trend_break_before_signal_lost_under_loss",
          candidate_lost_candidate_count: signalLostCandidateCount
        });
        remaining.push({ ...posTrail, candidateLostStreak: 0 });
        continue;
      }

      const trendStructureStillValid =
        open.regimeAtEntry === "TREND"
          ? (snap.trendOk === true &&
            Math.abs(snap.emaGap ?? 0) >= ENTRY_EVIDENCE_TREND_EMA_GAP_MIN &&
            (snap.trendWeaknessScore ?? 1) <= ENTRY_EVIDENCE_TREND_WEAKNESS_MAX)
          : false;
      const rangeStructureStillValid =
        open.regimeAtEntry === "RANGE"
          ? (typeof snap.boxPos === "number" &&
            ((open.side === "short" && classifyRangeZone(snap.boxPos) === "upper") ||
              (open.side === "long" && classifyRangeZone(snap.boxPos) === "lower")))
          : false;
      const entryEvidenceStillValid =
        entryEvidence == null
          ? (rangeStructureStillValid || trendStructureStillValid)
          : (entryEvidence.regime_at_entry === "RANGE"
            ? rangeStructureStillValid
            : entryEvidence.regime_at_entry === "TREND"
              ? trendStructureStillValid
              : false);

      if (m.holdingMs < minHoldMsEff) {
        this.logger.info("SIGNAL_LOST_WATCH", {
          symbol: open.symbol,
          side: open.side,
          signal_lost_candidate_count: signalLostCandidateCount,
          holding_ms: m.holdingMs,
          min_hold_ms: minHoldMsEff,
          entry_evidence_still_valid: entryEvidenceStillValid
        });
        this.logger.info("SIGNAL_LOST_PROTECTED", {
          symbol: open.symbol,
          side: open.side,
          reason: "min_hold_protection",
          protect_ms: minHoldMsEff
        });
        remaining.push({ ...posTrail, candidateLostStreak: signalLostCandidateCount });
        continue;
      }

      if (m.holdingMs < ENTRY_SIGNAL_LOST_PROTECT_MS) {
        this.logger.info("SIGNAL_LOST_WATCH", {
          symbol: open.symbol,
          side: open.side,
          signal_lost_candidate_count: signalLostCandidateCount,
          holding_ms: m.holdingMs,
          protect_ms: ENTRY_SIGNAL_LOST_PROTECT_MS,
          entry_evidence_still_valid: entryEvidenceStillValid
        });
        this.logger.info("SIGNAL_LOST_PROTECTED", {
          symbol: open.symbol,
          side: open.side,
          reason: "entry_signal_lost_protect_window"
        });
        remaining.push({ ...posTrail, candidateLostStreak: signalLostCandidateCount });
        continue;
      }

      if (entryEvidenceStillValid) {
        this.logger.info("SIGNAL_LOST_PROTECTED", {
          symbol: open.symbol,
          side: open.side,
          reason: "entry_evidence_still_valid",
          entry_regime: open.regimeAtEntry ?? null
        });
        remaining.push({ ...posTrail, candidateLostStreak: signalLostCandidateCount });
        continue;
      }

      if (signalLostCandidateCount < minLostStreak) {
        this.logger.info("SIGNAL_LOST_WATCH", {
          symbol: open.symbol,
          side: open.side,
          signal_lost_candidate_count: signalLostCandidateCount,
          required_count: minLostStreak,
          holding_ms: m.holdingMs,
          entry_evidence_still_valid: entryEvidenceStillValid
        });
        remaining.push({ ...posTrail, candidateLostStreak: signalLostCandidateCount });
        continue;
      }

      if (this.shouldDeferRegimeLaneTransitionClose(open, closedAt, "candidate_lost", postPartialProtectActive)) {
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
      this.logger.info("EXIT_ENTRY_EVIDENCE_INVALIDATED", {
        symbol: open.symbol,
        side: open.side,
        signal_lost_candidate_count: signalLostCandidateCount,
        required_count: minLostStreak,
        entry_regime: open.regimeAtEntry ?? null,
        range_structure_still_valid: rangeStructureStillValid,
        trend_structure_still_valid: trendStructureStillValid,
        entry_evidence_still_valid: entryEvidenceStillValid
      });
      finalCloseReason = cr;
      confirmedExitType = exitEventJsonlType(cr);
      confirmedCloseSource = "candidate_lost_watchdog";
      const closedRow = toClosed(cr, m, open.sizeUsd);
      await this.dispatchOkxClose({
        symbol: open.symbol,
        side: open.side,
        sizeUsd: open.sizeUsd,
        appliedLeverage: Math.max(1, open.leverage ?? 1),
        lastPrice: closePrice,
        flowId,
        reason: "candidate_lost"
      });
      const routedClosed = await this.appendClosedWithStandardRouting({
        closedRow,
        open,
        flowId,
        envelope,
        exitReason: cr,
        closeSource: String(closedRow.closeSource ?? "executor_close_action"),
        currentRegime: regimeNow
      });
      authorizeOpenLedgerPruneAfterAttestedClose(flowId, routedClosed);
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
        // Every tick authority tracking (deduped internally via shouldEmitV2Proof)
        handleV2ExitAuthorityProof("none", null);
        handleV2PartialAuthorityProof("none", null);

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
      this.bundleDirty = true;

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
    legacyAdaptive: NonNullable<EvaluatePaperSymbolEntryResult["adaptiveResult"]> | null | undefined,
    forceEnter = false
  ): NonNullable<EvaluatePaperSymbolEntryResult["adaptiveResult"]> | null {
    if (!forceEnter && authority.decision !== "ENTER") return null;

    const side = authority.side;
    if (side !== "long" && side !== "short") return null;

    const stageMarginKrw =
      (authority.stageMarginKrw ?? 0) > 0
        ? (authority.stageMarginKrw ?? 0)
        : forceEnter
          ? Math.max(
            MIN_POSITION_SIZE_USD * PAPER_LEDGER_KRW_NOTIONAL_PER_USD,
            Math.round(computePaperSizingAnchorUsd(this.config) * 0.35 * PAPER_LEDGER_KRW_NOTIONAL_PER_USD * 100) / 100
          )
          : 0;
    const sizeUsd = Math.round((stageMarginKrw / PAPER_LEDGER_KRW_NOTIONAL_PER_USD) * 100) / 100;
    if (sizeUsd <= 0) return null;

    const bridgeSizeUsd = sizeUsd;
    const appliedLeverage = Math.max(0, authority.appliedLeverage ?? this.config.leverage);
    const leverageMultiplier =
      this.config.leverage > 0 ? Math.max(0.5, appliedLeverage / this.config.leverage) : 1.0;

    // Build synthetic fallback bridge for V2 or missing results (execution size follows legacy adaptive when side matches)
    return {
      ok: true,
      direction: side as "long" | "short",
      sizeUsd: bridgeSizeUsd,
      leverageMultiplier,
      detail: {
        source: "v2_authority_execution_bridge",
        bridge_activated: true,
        authority_source: authority.source,
        authority_side: side,
        authority_selector_size_usd: sizeUsd,
        authority_size_usd: bridgeSizeUsd,
        recheck_promotion_applied: forceEnter,
        finalSizeUsd: bridgeSizeUsd,
        entry_quality_grade: authority.entryQualityGrade ?? null,
        leverage_profile: authority.leverageProfile ?? "BASE",
        applied_leverage: appliedLeverage,
        leverage_reason: authority.leverageReason ?? null,
        leverage_block_reason: authority.leverageBlockReason ?? null,
        exposure_notional_krw: authority.exposureNotionalKrw ?? null,
        equity_multiple: authority.equityMultiple ?? null,
        confidence_score: 1.0,
        confidence_tier: "top",
        size_multiplier: 1.0
      }
    };
  }

  private evaluateRangeRecheckPromotion(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    authoritySource: string;
    authorityDecision: string;
    authorityRegime: string | null;
    authorityEntryQualityGrade: string | null;
    adoptedEngine: string | null;
    finalEngineOwner: string | null;
    activeEngine: "RANGE" | "TREND" | "IDLE";
    boxPos: number | null;
    rangeConfidence: number | null;
    boxCohesion01: number | null;
    trendWeaknessScore: number | null;
    trendOk: boolean;
    emaGap: number | null;
    qualityScore: number;
    lastPrice: number;
    v2BlockReason: string | null;
    v2Signal: string | null;
    relaxedRangeEntry: boolean;
    reversalConfirmed: boolean;
    directionalShockState: string | null;
    serverTradeEnabled: boolean;
    closeOnlyMode: boolean;
    killSwitch: boolean;
    reconcileSafeMode: boolean;
    riskMode: string | null;
    dailyLossGuardActive: boolean;
    openPositionCount: number;
    maxSlots: number;
    entryEvidenceScore: number;
  }>): { promote: boolean; reason: string; ticks: number } {
    const key = `${input.symbol}:${input.side}`;
    const reasonRaw = String(input.v2BlockReason ?? "");
    const signalRaw = String(input.v2Signal ?? "");
    const isV2Owner = input.authoritySource === "v2";
    const finalEngineOwnerUpper = String(input.finalEngineOwner ?? "").toUpperCase();
    const adoptedEngineUpper = String(input.adoptedEngine ?? "").toUpperCase();
    const v2EngineOwner = adoptedEngineUpper === "V2" || finalEngineOwnerUpper === "V2";
    const decisionHold = String(input.authorityDecision ?? "").toUpperCase() === "HOLD";
    const waitRecheckCandidate =
      reasonRaw === "WAIT_RECHECK" ||
      signalRaw === "WAIT_RECHECK";
    const qualityGrade = String(input.authorityEntryQualityGrade ?? "").toUpperCase();
    const qualityGradeAllowed = qualityGrade === "S" || qualityGrade === "A" || qualityGrade === "B";
    const serverControlOpen =
      input.serverTradeEnabled &&
      !input.closeOnlyMode &&
      !input.killSwitch &&
      !input.reconcileSafeMode;
    const riskNotHalt = String(input.riskMode ?? "").toUpperCase() !== "HALT";
    const hasCapacity = input.openPositionCount < input.maxSlots;
    const commonEligible =
      isV2Owner &&
      v2EngineOwner &&
      decisionHold &&
      waitRecheckCandidate &&
      qualityGradeAllowed &&
      serverControlOpen &&
      riskNotHalt &&
      !input.dailyLossGuardActive &&
      hasCapacity;
    if (!commonEligible) {
      this.rangeRecheckPromotionByKey.delete(key);
      return { promote: false, reason: "not_v2_wait_recheck_candidate", ticks: 0 };
    }
    if (input.side !== "long" && input.side !== "short") {
      this.rangeRecheckPromotionByKey.delete(key);
      return { promote: false, reason: "non_directional_side", ticks: 0 };
    }
    const authorityRegimeUpper = String(input.authorityRegime ?? "").toUpperCase();
    const regimeAtDecision: "RANGE" | "TREND" =
      authorityRegimeUpper === "RANGE" || input.activeEngine === "RANGE" ? "RANGE" : "TREND";
    const prev = this.rangeRecheckPromotionByKey.get(key);
    const qualityNotWorse = !prev || input.qualityScore >= prev.lastQualityScore - 2;
    const structureNotBroken = !prev || Math.abs(input.lastPrice - prev.lastPrice) / Math.max(1e-9, prev.lastPrice) <= 0.02;
    const ticks = prev && qualityNotWorse && structureNotBroken ? prev.ticks + 1 : 1;
    const zone = typeof input.boxPos === "number" && Number.isFinite(input.boxPos)
      ? classifyRangeZone(input.boxPos)
      : "mid";
    this.rangeRecheckPromotionByKey.set(key, {
      ticks,
      side: input.side,
      zone,
      lastQualityScore: input.qualityScore,
      lastRangeConfidence: Math.max(0, input.rangeConfidence ?? 0),
      lastPrice: input.lastPrice,
      updatedAt: Date.now()
    });
    if (regimeAtDecision === "RANGE") {
      if (zone === "mid") return { promote: false, reason: "range_mid_wait_not_promotable", ticks };
      const zoneAligned =
        (input.side === "short" && zone === "upper") ||
        (input.side === "long" && zone === "lower");
      if (!zoneAligned) return { promote: false, reason: "range_side_zone_mismatch", ticks };
      const rangeConfidence = Math.max(0, input.rangeConfidence ?? 0);
      const rangeStructureQualified =
        rangeConfidence >= 0.65 &&
        (input.boxCohesion01 ?? 0) >= 0.9 &&
        (input.trendWeaknessScore ?? 0) >= 0.7 &&
        input.qualityScore >= 70;
      if (!rangeStructureQualified) {
        return { promote: false, reason: "range_structure_quality_not_met", ticks };
      }
      const promotionTrigger = input.relaxedRangeEntry || input.reversalConfirmed || ticks >= 2;
      if (!promotionTrigger) {
        return { promote: false, reason: "range_wait_recheck_needs_confirmation", ticks };
      }
      return { promote: true, reason: "range_wait_recheck_promoted_qualified", ticks };
    }
    const shock = String(input.directionalShockState ?? "NONE").toUpperCase();
    const trendDirectionalAligned =
      shock === "NONE" ||
      (shock === "UP" && input.side === "long") ||
      (shock === "DOWN" && input.side === "short");
    if (!trendDirectionalAligned) {
      this.rangeRecheckPromotionByKey.delete(key);
      return { promote: false, reason: "trend_directional_shock_mismatch", ticks: 0 };
    }
    const trendQualityOk = input.trendOk === true && input.qualityScore >= 70;
    if (!trendQualityOk) {
      return { promote: false, reason: "trend_quality_not_met", ticks };
    }
    if (shock === "NONE") {
      const emaGapAbs = Math.abs(input.emaGap ?? 0);
      if (emaGapAbs < ENTRY_EVIDENCE_TREND_EMA_GAP_MIN) {
        return { promote: false, reason: "trend_ema_gap_not_met", ticks };
      }
    }
    if (qualityGrade === "S" || qualityGrade === "A") {
      return { promote: true, reason: "trend_wait_recheck_promoted_top_grade", ticks };
    }
    if (qualityGrade === "B" && ticks >= 2) {
      return { promote: true, reason: "trend_wait_recheck_promoted_b_after_2ticks", ticks };
    }
    return { promote: false, reason: "trend_wait_recheck_watch", ticks };
  }

  private toEntryQualityVectorFromSnapshot(
    snapshot: Pick<SymbolSnapshot, "qualityScore" | "atr" | "lastPrice" | "emaGap" | "volumeRatioProxy">,
    side: "long" | "short"
  ): EntryQualityFeatureVector {
    const atrPct = snapshot.atr != null && snapshot.lastPrice > 0 ? snapshot.atr / snapshot.lastPrice : 0;
    return {
      qualityScore: Number.isFinite(snapshot.qualityScore) ? snapshot.qualityScore : 0,
      atrPct: Number.isFinite(atrPct) ? atrPct : 0,
      emaGap: Number.isFinite(snapshot.emaGap ?? NaN) ? Math.abs(snapshot.emaGap ?? 0) : 0,
      volumeRatioProxy: Number.isFinite(snapshot.volumeRatioProxy) ? snapshot.volumeRatioProxy : 0,
      sideBias: side === "long" ? 1 : -1
    };
  }

  private qualityVectorDistance(a: EntryQualityFeatureVector, b: EntryQualityFeatureVector): number {
    const dq = (a.qualityScore - b.qualityScore) / 100;
    const datr = a.atrPct - b.atrPct;
    const dema = a.emaGap - b.emaGap;
    const dvol = (a.volumeRatioProxy - b.volumeRatioProxy) / 5;
    const dside = a.sideBias - b.sideBias;
    return Math.sqrt(dq * dq + datr * datr + dema * dema + dvol * dvol + dside * dside);
  }

  private async buildEntryQualitySamplesFromHistory(
    history: ReadonlyArray<PaperClosedPositionRecord>
  ): Promise<{ profit: EntryQualitySample[]; loss: EntryQualitySample[] }> {
    const profit: EntryQualitySample[] = [];
    const loss: EntryQualitySample[] = [];
    for (const row of history.slice(-120)) {
      const symbol = String(row.symbol ?? "");
      const side = row.side === "short" ? "short" : "long";
      const tsPathRaw = typeof row.timestampSnapshotPath === "string" ? row.timestampSnapshotPath : "";
      if (symbol === "" || tsPathRaw === "") continue;
      try {
        const raw = await fs.readFile(tsPathRaw, "utf8");
        const parsed = JSON.parse(raw) as { snapshots?: unknown[] };
        const snaps = Array.isArray(parsed.snapshots) ? parsed.snapshots : [];
        const snap = snaps.find((s) => String((s as { symbol?: unknown }).symbol ?? "") === symbol) as
          | (Pick<SymbolSnapshot, "qualityScore" | "atr" | "lastPrice" | "emaGap" | "volumeRatioProxy"> & Record<string, unknown>)
          | undefined;
        if (!snap) continue;
        const vector = this.toEntryQualityVectorFromSnapshot(
          {
            qualityScore: Number((snap as { qualityScore?: unknown }).qualityScore ?? 0),
            atr: Number((snap as { atr?: unknown }).atr ?? 0),
            lastPrice: Number((snap as { lastPrice?: unknown }).lastPrice ?? 0),
            emaGap: Number((snap as { emaGap?: unknown }).emaGap ?? 0),
            volumeRatioProxy: Number((snap as { volumeRatioProxy?: unknown }).volumeRatioProxy ?? 0)
          },
          side
        );
        const sample: EntryQualitySample = {
          ts: Number(row.openedAt ?? Date.now()),
          symbol,
          side,
          source: row.pnlUsdNet > 0 ? "profit" : "loss",
          vector,
          reason: row.closeReason ?? "history_close_reason_unknown"
        };
        if (sample.source === "profit") profit.push(sample);
        else loss.push(sample);
      } catch {
        // ignore malformed/rotated snapshot files
      }
    }
    return { profit, loss };
  }

  private toNumberOrNull(v: unknown): number | null {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  private toEntryQualityVectorFromEvent(
    ev: Record<string, unknown>,
    side: "long" | "short"
  ): EntryQualityFeatureVector {
    const qualityScore =
      this.toNumberOrNull(ev.entry_quality_score) ??
      this.toNumberOrNull(ev.quality_score) ??
      this.toNumberOrNull(ev.qualityScore) ??
      50;
    const atrPct =
      this.toNumberOrNull(ev.atr_pct) ??
      this.toNumberOrNull(ev.atrPct) ??
      0;
    const emaGapAbs =
      Math.abs(
        this.toNumberOrNull(ev.ema_gap) ??
        this.toNumberOrNull(ev.emaGap) ??
        this.toNumberOrNull(ev.entry_ema_gap) ??
        0
      );
    const volumeRatioProxy =
      this.toNumberOrNull(ev.range_confidence) ??
      this.toNumberOrNull(ev.rangeConfidence) ??
      this.toNumberOrNull(ev.volume_ratio_proxy) ??
      this.toNumberOrNull(ev.volumeRatioProxy) ??
      0;
    return {
      qualityScore,
      atrPct,
      emaGap: emaGapAbs,
      volumeRatioProxy,
      sideBias: side === "long" ? 1 : -1
    };
  }

  private eventTypeFromEvent(ev: Record<string, unknown>): {
    value: string;
    source: "type" | "event" | "name" | "reason" | "none";
  } {
    if (ev.type != null) return { value: String(ev.type), source: "type" };
    if (ev.event != null) return { value: String(ev.event), source: "event" };
    if (ev.name != null) return { value: String(ev.name), source: "name" };
    const reasonLike =
      ev.eventType ?? ev.exitType ?? ev.closeType ?? ev.reason ?? ev.closeReason ?? ev.exitReason;
    if (reasonLike != null) return { value: String(reasonLike), source: "reason" };
    return { value: "", source: "none" };
  }

  private sideFromEvent(ev: Record<string, unknown>): "long" | "short" | null {
    const raws = [
      ev.side,
      ev.positionSide,
      ev.posSide,
      ev.authority_side,
      ev.effectiveSide
    ];
    for (const raw of raws) {
      const s = String(raw ?? "").toLowerCase();
      if (s === "long" || s === "buy") return "long";
      if (s === "short" || s === "sell") return "short";
    }
    return null;
  }

  private symbolFromEvent(ev: Record<string, unknown>): string {
    const direct =
      (typeof ev.symbol === "string" && ev.symbol.trim().length > 0
        ? ev.symbol
        : typeof ev.marketSymbol === "string" && ev.marketSymbol.trim().length > 0
          ? ev.marketSymbol
          : "") as string;
    if (direct) return direct.toUpperCase();
    const instIdRaw = typeof ev.instId === "string" ? ev.instId.toUpperCase() : "";
    if (instIdRaw.endsWith("-USDT-SWAP")) {
      return `${instIdRaw.slice(0, -"-USDT-SWAP".length)}USDT`;
    }
    return instIdRaw;
  }

  private async buildEntryQualitySamplesFromEvents(): Promise<{
    profit: EntryQualitySample[];
    loss: EntryQualitySample[];
    contaminated: EntryQualitySample[];
    diagnostics: {
      events_lines: number;
      entry_opened_events: number;
      exit_events: number;
      exit_candidate_events: number;
      usable_exit_samples: number;
      contaminated_events: number;
      event_type_field_hits_type: number;
      event_type_field_hits_event: number;
      event_type_field_hits_name: number;
      event_type_field_hits_reason: number;
      exit_contaminated_missing_side: number;
      exit_contaminated_missing_pnl: number;
    };
  }> {
    const profit: EntryQualitySample[] = [];
    const loss: EntryQualitySample[] = [];
    const contaminated: EntryQualitySample[] = [];
    const diagnostics = {
      events_lines: 0,
      entry_opened_events: 0,
      exit_events: 0,
      exit_candidate_events: 0,
      usable_exit_samples: 0,
      contaminated_events: 0,
      event_type_field_hits_type: 0,
      event_type_field_hits_event: 0,
      event_type_field_hits_name: 0,
      event_type_field_hits_reason: 0,
      exit_contaminated_missing_side: 0,
      exit_contaminated_missing_pnl: 0
    };
    const p = path.resolve(this.config.dataDir, "reports/events.jsonl");
    let raw = "";
    try {
      raw = await fs.readFile(p, "utf8");
    } catch {
      return { profit, loss, contaminated, diagnostics };
    }
    const lines = raw.split("\n");
    diagnostics.events_lines = lines.filter((x) => x.trim().length > 0).length;
    for (const line of lines) {
      const t = line.trim();
      if (t === "") continue;
      let ev: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(t) as unknown;
        if (parsed && typeof parsed === "object") ev = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!ev) continue;
      const { value: type, source: typeSource } = this.eventTypeFromEvent(ev);
      if (typeSource === "type") diagnostics.event_type_field_hits_type += 1;
      else if (typeSource === "event") diagnostics.event_type_field_hits_event += 1;
      else if (typeSource === "name") diagnostics.event_type_field_hits_name += 1;
      else if (typeSource === "reason") diagnostics.event_type_field_hits_reason += 1;
      if (type === "ENTRY_OPENED" || type.includes("ENTRY_OPENED")) diagnostics.entry_opened_events += 1;
      const hasExitReason =
        ev.closeReason != null || ev.exitReason != null || ev.exitType != null || ev.closeType != null;
      const isExitCandidate =
        type.startsWith("EXIT_") || type.includes("EXIT_") || hasExitReason;
      if (!isExitCandidate) continue;
      diagnostics.exit_candidate_events += 1;
      if (type.startsWith("EXIT_") || type.includes("EXIT_")) diagnostics.exit_events += 1;
      const side = this.sideFromEvent(ev);
      if (side == null) {
        diagnostics.contaminated_events += 1;
        diagnostics.exit_contaminated_missing_side += 1;
        contaminated.push({
          ts: this.toNumberOrNull(ev.ts) ?? Date.now(),
          symbol: this.symbolFromEvent(ev) || "UNKNOWN",
          side: "long",
          source: "contaminated",
          vector: this.toEntryQualityVectorFromEvent(ev, "long"),
          reason: "events_exit_missing_side"
        });
        continue;
      }
      const pnlUsd =
        this.toNumberOrNull(ev.realizedPnlUsd) ??
        this.toNumberOrNull(ev.realized_pnl_usd) ??
        this.toNumberOrNull(ev.realized_pnl) ??
        this.toNumberOrNull(ev.pnlUsd) ??
        this.toNumberOrNull(ev.pnl) ??
        this.toNumberOrNull(ev.realizedPnl);
      const pnlPct =
        this.toNumberOrNull(ev.realizedPnlPct) ??
        this.toNumberOrNull(ev.pnlPct);
      if (pnlUsd == null && pnlPct == null) {
        diagnostics.contaminated_events += 1;
        diagnostics.exit_contaminated_missing_pnl += 1;
        contaminated.push({
          ts: this.toNumberOrNull(ev.ts) ?? Date.now(),
          symbol: this.symbolFromEvent(ev) || "UNKNOWN",
          side,
          source: "contaminated",
          vector: this.toEntryQualityVectorFromEvent(ev, side),
          reason: "events_exit_missing_pnl"
        });
        continue;
      }
      const effectivePnl = pnlUsd ?? pnlPct ?? 0;
      const sample: EntryQualitySample = {
        ts: this.toNumberOrNull(ev.ts) ?? Date.now(),
        symbol: this.symbolFromEvent(ev) || "UNKNOWN",
        side,
        source: effectivePnl > 0 ? "profit" : "loss",
        vector: this.toEntryQualityVectorFromEvent(ev, side),
        reason: pnlUsd == null
          ? `${String(ev.reason ?? ev.closeReason ?? ev.exitReason ?? type)}|events_exit_pct_only_sample`
          : String(ev.reason ?? ev.closeReason ?? ev.exitReason ?? type)
      };
      diagnostics.usable_exit_samples += 1;
      if (sample.source === "profit") profit.push(sample);
      else loss.push(sample);
    }
    return { profit: profit.slice(-600), loss: loss.slice(-600), contaminated: contaminated.slice(-300), diagnostics };
  }

  private async refreshEntryQualitySamples(history: ReadonlyArray<PaperClosedPositionRecord>): Promise<void> {
    const [fromHistory, fromEvents] = await Promise.all([
      this.buildEntryQualitySamplesFromHistory(history),
      this.buildEntryQualitySamplesFromEvents()
    ]);
    const maxPerClass = 160;
    const mergedProfit = [
      ...fromHistory.profit,
      ...fromEvents.profit
    ].slice(-maxPerClass);
    const mergedLoss = [
      ...fromHistory.loss,
      ...fromEvents.loss
    ].slice(-maxPerClass);
    const mergedContaminated = [
      ...fromEvents.contaminated,
      ...this.contaminatedEntrySamples
    ].slice(-160);
    this.lastEntryQualitySamples = {
      profit: mergedProfit,
      loss: mergedLoss,
      contaminated: mergedContaminated
    };
    this.lastEntryQualitySampleSourceBreakdown = {
      history_profit_samples: fromHistory.profit.length,
      history_loss_samples: fromHistory.loss.length,
      events_profit_samples: fromEvents.profit.length,
      events_loss_samples: fromEvents.loss.length,
      contaminated_samples: this.lastEntryQualitySamples.contaminated.length,
      total_sample_count:
        this.lastEntryQualitySamples.profit.length +
        this.lastEntryQualitySamples.loss.length +
        this.lastEntryQualitySamples.contaminated.length
    };
    this.logger.info("ENTRY_QUALITY_SAMPLE_SOURCE_BREAKDOWN", {
      ...this.lastEntryQualitySampleSourceBreakdown,
      events_lines: fromEvents.diagnostics.events_lines,
      entry_opened_events: fromEvents.diagnostics.entry_opened_events,
      exit_events: fromEvents.diagnostics.exit_events,
      exit_candidate_events: fromEvents.diagnostics.exit_candidate_events,
      usable_exit_samples: fromEvents.diagnostics.usable_exit_samples,
      contaminated_events: fromEvents.diagnostics.contaminated_events,
      event_type_field_hits_type: fromEvents.diagnostics.event_type_field_hits_type,
      event_type_field_hits_event: fromEvents.diagnostics.event_type_field_hits_event,
      event_type_field_hits_name: fromEvents.diagnostics.event_type_field_hits_name,
      event_type_field_hits_reason: fromEvents.diagnostics.event_type_field_hits_reason,
      exit_contaminated_missing_side: fromEvents.diagnostics.exit_contaminated_missing_side,
      exit_contaminated_missing_pnl: fromEvents.diagnostics.exit_contaminated_missing_pnl
    });
    this.logger.info("ENTRY_QUALITY_SAMPLE_COMPARISON", {
      profit_samples: this.lastEntryQualitySamples.profit.length,
      loss_samples: this.lastEntryQualitySamples.loss.length,
      contaminated_samples: this.lastEntryQualitySamples.contaminated.length,
      history_profit_samples: this.lastEntryQualitySampleSourceBreakdown.history_profit_samples,
      history_loss_samples: this.lastEntryQualitySampleSourceBreakdown.history_loss_samples,
      events_profit_samples: this.lastEntryQualitySampleSourceBreakdown.events_profit_samples,
      events_loss_samples: this.lastEntryQualitySampleSourceBreakdown.events_loss_samples,
      total_sample_count: this.lastEntryQualitySampleSourceBreakdown.total_sample_count
    });
    const recent = history.slice(-20);
    const prev = history.slice(-40, -20);
    const regimeExitRate = (rows: ReadonlyArray<PaperClosedPositionRecord>): number => {
      if (rows.length === 0) return 0;
      let regimeExits = 0;
      for (const r of rows) {
        const reason = String(r.closeReason ?? "").toLowerCase();
        if (reason.includes("regime")) regimeExits += 1;
      }
      return regimeExits / rows.length;
    };
    const recentRate = regimeExitRate(recent);
    const prevRate = regimeExitRate(prev);
    this.logger.info("EARLY_REGIME_EXIT_RATE_PROOF", {
      recent_window_count: recent.length,
      previous_window_count: prev.length,
      recent_regime_exit_rate: recentRate,
      previous_regime_exit_rate: prevRate,
      reduced_vs_previous: prev.length > 0 ? recentRate < prevRate : null
    });
  }

  private evaluateEntryQualityGate(
    snapshot: SymbolSnapshot,
    side: "long" | "short"
  ): { pass: boolean; shrink: boolean; sizeMultiplier: number; score: number; reason: string } {
    const current = this.toEntryQualityVectorFromSnapshot(snapshot, side);
    const nearest = (samples: EntryQualitySample[]): number => {
      if (samples.length === 0) return Number.POSITIVE_INFINITY;
      let best = Number.POSITIVE_INFINITY;
      for (const s of samples) best = Math.min(best, this.qualityVectorDistance(current, s.vector));
      return best;
    };
    const dProfit = nearest(this.lastEntryQualitySamples.profit);
    const dLoss = nearest(this.lastEntryQualitySamples.loss);
    const dContam = nearest(this.lastEntryQualitySamples.contaminated);
    const similarityScore = Math.max(0, Math.min(1, 1 / (1 + dProfit)));
    if (Number.isFinite(dContam) && dContam < dProfit) {
      return { pass: false, shrink: false, sizeMultiplier: 0, score: similarityScore, reason: "similar_to_contaminated_sample" };
    }
    if (Number.isFinite(dLoss) && dLoss < dProfit) {
      return { pass: false, shrink: false, sizeMultiplier: 0, score: similarityScore, reason: "similar_to_loss_sample" };
    }
    if (!Number.isFinite(dProfit)) {
      return { pass: false, shrink: false, sizeMultiplier: 0, score: 0, reason: "profit_sample_missing" };
    }
    if (similarityScore < 0.55) {
      return { pass: true, shrink: true, sizeMultiplier: 0.5, score: similarityScore, reason: "weak_similarity_to_profit_sample" };
    }
    return { pass: true, shrink: false, sizeMultiplier: 1, score: similarityScore, reason: "similar_to_profit_sample" };
  }

  private buildEntryQualityProfilesForV2(): {
    profit: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number };
    loss: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number };
    contaminated: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number };
  } {
    const avg = (rows: EntryQualitySample[]) => {
      if (rows.length === 0) return { qualityScoreAvg: 0, emaGapAvg: 0, atrPctAvg: 0, volumeRatioAvg: 0, count: 0 };
      let q = 0;
      let e = 0;
      let a = 0;
      let v = 0;
      for (const r of rows) {
        q += r.vector.qualityScore;
        e += Math.abs(r.vector.emaGap);
        a += Math.abs(r.vector.atrPct);
        v += r.vector.volumeRatioProxy;
      }
      return {
        qualityScoreAvg: q / rows.length,
        emaGapAvg: e / rows.length,
        atrPctAvg: a / rows.length,
        volumeRatioAvg: v / rows.length,
        count: rows.length
      };
    };
    return {
      profit: avg(this.lastEntryQualitySamples.profit),
      loss: avg(this.lastEntryQualitySamples.loss),
      contaminated: avg(this.lastEntryQualitySamples.contaminated)
    };
  }

  /**
   * RANGE ??갑??臾쇳?湲?water-entry) ?꾩슜 ?덉씠????V2 ENTER ?먃룹큹湲?吏꾩엯 濡쒖쭅怨?遺꾨━.
   * ?ъ???蹂댁쑀 ?쒖뿉留??됯?쨌?ㅽ뻾?쒕떎.
   */

  private async processPaperSymbolEntries(input: Readonly<{
    snapshots: SymbolSnapshot[];
    errorsCount: number;
    candidateRunPath: string | undefined;
    latestPath: string | undefined;
    metaPath: string | undefined;
    filePath: string | undefined;
    decisionBySymbol: ReadonlyMap<string, PaperEngineDecisionEnvelope>;
    paperExecutionReady: boolean;
    readinessBarrierActive: boolean;
    readinessChangedAt: number | null;
    serverTradeEnabled: boolean;
    closeOnlyMode: boolean;
    killSwitchActive: boolean;
  }>): Promise<void> {
    if (input.errorsCount > 0) return;
    if (input.killSwitchActive || !input.serverTradeEnabled) {
      this.logger.error("SERVER_AUTHORITY_INVARIANT_BROKEN", this.buildInvariantProofPayload({
        symbol: "*",
        side: null,
        authority: null,
        adoptedEngine: null,
        lifecycleState: null,
        reason: input.killSwitchActive ? "kill_switch_active" : "server_trade_disabled"
      }));
      this.logger.warn("ENTRY_BLOCKED_SERVER_AUTHORITY_STATE", {
        reason: input.killSwitchActive ? "kill_switch_active" : "server_trade_disabled",
        authority_source: "server_state"
      });
      return;
    }
    if (input.closeOnlyMode) {
      this.logger.error("SERVER_AUTHORITY_INVARIANT_BROKEN", this.buildInvariantProofPayload({
        symbol: "*",
        side: null,
        authority: null,
        adoptedEngine: null,
        lifecycleState: null,
        reason: this.reconcileSafetyCloseOnly ? "reconcile_safe_mode_close_only" : "close_only_mode"
      }));
      this.logger.warn("ENTRY_BLOCKED_SERVER_AUTHORITY_STATE", {
        reason: this.reconcileSafetyCloseOnly ? "reconcile_safe_mode_close_only" : "close_only_mode",
        authority_source: "server_state"
      });
      return;
    }
    if (!input.paperExecutionReady) {
      this.logger.warn("READINESS_REEVALUATION_BLOCKED", {
        reason: "paper_execution_ready_false",
        run_cycle_id: this.runCycleId
      });
      return;
    }

    const executionSnapshot = {
      paperReady: this.paperExecutionReady,
      signedReady: this.signedExecutionReady,
      tradeEnabled: this.serverTradeControlState.server_trade_enabled,
      closeOnly: this.serverTradeControlState.close_only_mode,
      killSwitch: this.serverTradeControlState.kill_switch_active,
      reconcileSafe: this.reconcileSafetyCloseOnly,
      dailyLossGuard: this.lastRisk?.dailyLossGuardTriggered === true,
      riskModeHalt: String(this.lastRiskExposure?.riskMode ?? "").toUpperCase() === "HALT",
      runCycleId: this.runCycleId,
      readinessChangedAt: input.readinessChangedAt,
      serverTradeEnabledTrueAt: this.serverTradeEnabledTrueAt
    };

    const snapshotBySymbol = new Map<string, SymbolSnapshot>();
    for (const s of input.snapshots) {
      snapshotBySymbol.set(String(s.symbol), s);
    }
    const entryQueue: SymbolSnapshot[] = [];

    // --- V2 Deferred Entry Queue 재검증 (barrier 해제 후 재소비) ---
    // 이전 사이클에서 fresh_tick/readiness barrier로 인해 즉시 소비 못한 V2 후보를 재검증한다.
    // barrier가 아직 활성이면 재검증하지 않고 보존 유지한다.
    // stale tick(현재 runCycleId - deferredAtCycleId > 2)은 즉시 폐기한다.
    const currentBarrierActive = this.freshTickRequiredAfterReadiness || input.readinessBarrierActive;
    const currentFreshTickOk = !this.freshTickRequiredAfterReadiness;
    const currentReadinessOk = !input.readinessBarrierActive;

    if (this.v2DeferredEntryQueue.size > 0) {
      // position mutex 확인용 최신 포지션 로드 (async이므로 가능)
      let deferredCheckPositions: Awaited<ReturnType<typeof this.positions.loadOpenAll>> = [];
      try {
        deferredCheckPositions = await this.positions.loadOpenAll();
      } catch {
        deferredCheckPositions = [];
      }

      const toDelete: string[] = [];

      for (const [symKey, deferred] of this.v2DeferredEntryQueue) {
        const cycleAge = this.runCycleId - deferred.deferredAtCycleId;
        const symbolStr = deferred.symbol;

        // stale tick: 2사이클 초과 시 즉시 폐기
        if (cycleAge > 2) {
          this.logger.warn("V2_ENTRY_QUEUE_DROPPED_PROOF", {
            symbol: symbolStr,
            previous_run_cycle_id: deferred.deferredAtCycleId,
            current_run_cycle_id: this.runCycleId,
            drop_reason: "STALE_TICK_CYCLE_AGE_EXCEEDED",
            cycle_age: cycleAge,
            deferred_at_ms: deferred.deferredAtMs
          });
          toDelete.push(symKey);
          continue;
        }

        // barrier 아직 활성이면 보존 유지 (재검증 생략)
        if (currentBarrierActive) {
          continue;
        }

        // barrier 해제 → 재검증 시작
        const freshTickOk = currentFreshTickOk;
        const readinessOk = currentReadinessOk;

        // [수정4] stopPrice 방향 유효성 검증
        const lastPrice = Number(deferred.snapshot.lastPrice ?? 0);
        const sp = deferred.stopPrice;
        let stopPriceValid = sp != null && Number.isFinite(sp);
        let stopDirectionValid = false;
        if (stopPriceValid && lastPrice > 0) {
          if (deferred.side === "short") {
            stopDirectionValid = sp! > lastPrice;
          } else {
            stopDirectionValid = sp! < lastPrice;
          }
        } else if (stopPriceValid) {
          stopDirectionValid = true; // lastPrice 미확인 시 방향 검증 스킵
        }
        if (stopPriceValid && lastPrice > 0 && !stopDirectionValid) {
          stopPriceValid = false;
        }

        const serverTradeEnabledOk = this.serverTradeControlState.server_trade_enabled === true;
        const signedExecutionReadyOk = this.signedExecutionReady === true;
        const paperExecutionReadyOk = this.paperExecutionReady === true;
        const closeOnlyOk = this.serverTradeControlState.close_only_mode !== true;
        const killSwitchOk = this.serverTradeControlState.kill_switch_active !== true;
        const reconcileSafeOk = this.reconcileSafetyCloseOnly !== true;
        const dailyLossGuardOk = this.lastRisk?.dailyLossGuardTriggered !== true;
        const riskModeOk = String(this.lastRiskExposure?.riskMode ?? "").toUpperCase() !== "HALT";

        // [수정3] symbol position mutex 검사
        const symPositions = deferredCheckPositions.filter(p => String(p.symbol) === symbolStr);
        const sameSideOpen = symPositions.some(p => String(p.side).toLowerCase() === deferred.side);
        const oppositeSideOpen = symPositions.some(p => {
          const ps = String(p.side).toLowerCase();
          return ps !== deferred.side && (ps === "long" || ps === "short");
        });
        const positionConflict = sameSideOpen || oppositeSideOpen;
        const positionConflictReason = oppositeSideOpen
          ? "SYMBOL_OPPOSITE_POSITION_OPEN"
          : sameSideOpen
            ? "SYMBOL_SAME_SIDE_POSITION_ALREADY_OPEN"
            : null;

        let invalidReason: string | null = null;
        if (!freshTickOk) invalidReason = "FRESH_TICK_NOT_OK";
        else if (!readinessOk) invalidReason = "READINESS_NOT_OK";
        else if (positionConflict) invalidReason = positionConflictReason ?? "SYMBOL_POSITION_CONFLICT";
        else if (!stopPriceValid) invalidReason = lastPrice > 0 && !stopDirectionValid ? "STOP_PRICE_DIRECTION_INVALID" : "STOP_PRICE_INVALID";
        else if (!serverTradeEnabledOk) invalidReason = "SERVER_TRADE_DISABLED";
        else if (!signedExecutionReadyOk) invalidReason = "SIGNED_EXECUTION_NOT_READY";
        else if (!paperExecutionReadyOk) invalidReason = "PAPER_EXECUTION_NOT_READY";
        else if (!closeOnlyOk) invalidReason = "CLOSE_ONLY_MODE";
        else if (!killSwitchOk) invalidReason = "KILL_SWITCH_ACTIVE";
        else if (!reconcileSafeOk) invalidReason = "RECONCILE_SAFE_MODE";
        else if (!dailyLossGuardOk) invalidReason = "DAILY_LOSS_GUARD";
        else if (!riskModeOk) invalidReason = "RISK_MODE_HALT";

        const stillValid = invalidReason === null;

        this.logger.info("V2_ENTRY_QUEUE_REVALIDATE_PROOF", {
          previous_run_cycle_id: deferred.deferredAtCycleId,
          current_run_cycle_id: this.runCycleId,
          cycle_age: cycleAge,
          symbol: symbolStr,
          side: deferred.side,
          stage_margin_krw: deferred.stageMarginKrw,
          still_valid: stillValid,
          invalid_reason: invalidReason ?? "NONE",
          fresh_tick_ok: freshTickOk,
          readiness_ok: readinessOk,
          stop_price_valid: stopPriceValid,
          stop_price_direction_valid: stopDirectionValid,
          stop_price: deferred.stopPrice,
          last_price: lastPrice,
          symbol_position_conflict: positionConflict,
          same_side_open: sameSideOpen,
          opposite_side_open: oppositeSideOpen,
          serverTradeEnabled: serverTradeEnabledOk,
          signed_execution_ready: signedExecutionReadyOk,
          paper_execution_ready: paperExecutionReadyOk,
          decision_id: deferred.decisionId
        });

        if (stillValid) {
          // 재검증 통과 → entryQueue에 주입
          entryQueue.push(deferred.snapshot);
          this.logger.info("V2_ENTRY_QUEUE_CONSUME_AFTER_BARRIER_PROOF", {
            symbol: symbolStr,
            side: deferred.side,
            stage_margin_krw: deferred.stageMarginKrw,
            consumed: true,
            order_build_allowed: true,
            previous_run_cycle_id: deferred.deferredAtCycleId,
            current_run_cycle_id: this.runCycleId,
            decision_id: deferred.decisionId
          });
        } else {
          // 재검증 실패 → 폐기
          this.logger.warn("V2_ENTRY_QUEUE_DROPPED_PROOF", {
            symbol: symbolStr,
            previous_run_cycle_id: deferred.deferredAtCycleId,
            current_run_cycle_id: this.runCycleId,
            drop_reason: `REVALIDATION_FAILED|${invalidReason ?? "UNKNOWN"}`,
            cycle_age: cycleAge,
            fresh_tick_ok: freshTickOk,
            readiness_ok: readinessOk,
            stop_price_valid: stopPriceValid,
            stop_price_direction_valid: stopDirectionValid,
            symbol_position_conflict: positionConflict,
            serverTradeEnabled: serverTradeEnabledOk,
            signed_execution_ready: signedExecutionReadyOk
          });
        }
        toDelete.push(symKey);
      }

      for (const k of toDelete) {
        this.v2DeferredEntryQueue.delete(k);
      }
    }
    // --- deferred queue 재검증 종료 ---

    input.decisionBySymbol.forEach((envelope, symKey) => {
      const { authority, snapshot } = envelope;
      const base = snapshotBySymbol.get(symKey) ?? snapshot;

      if (symKey === "BTCUSDT") {
        if (this.isBtcSuppressionTarget()) {
          if (authority.decision === "ENTER") {
            this.logAndSuppressBtcUsdtAction("processPaperSymbolEntries ENTER gate", "none", ["ENTER", "ADDON"]);
          }
          return;
        }
      }

      // Local Symbol Block for External Manual Positions
      const symBlocked = this.symbolExternalManualBlocked.has(`${symKey}:long`) || 
                         this.symbolExternalManualBlocked.has(`${symKey}:short`);
      if (symBlocked) {
        if (authority.decision === "ENTER") {
          this.logger.warn("ENTRY_BLOCKED_EXTERNAL_MANUAL_SYMBOL", {
            symbol: symKey,
            decision: authority.decision,
            side: authority.side,
            reason: "symbol_level_external_manual_block_active",
            detail: "Entry blocked because this symbol has an external manual position or sync mismatch."
          });
        }
        return;
      }

      // Local Symbol Block for Protection Registration Failures
      if (this.symbolProtectionFailedBlocked.has(symKey)) {
        if (authority.decision === "ENTER") {
          this.logger.error("POSITION_UNPROTECTED_HARD_BLOCK", {
            symbol: symKey,
            decision: authority.decision,
            side: authority.side,
            reason: "position_unprotected_on_exchange",
            detail: "Entry blocked because OKX server-side protection is missing or failed to register. Operational safety violation."
          });
        }
        return;
      }

      if (authority.source === "v2") {
        const v2QueueAllowed =
          envelope.v2_execution_envelope?.authoritySource === "v2_execution_envelope" &&
          authority.decision === "ENTER" &&
          (authority.side === "long" || authority.side === "short") &&
          (authority.stageMarginKrw ?? 0) > 0 &&
          authority.hardBlockPresent !== true &&
          authority.nonBypassableHardBlockPresent !== true &&
          executionSnapshot.paperReady === true &&
          executionSnapshot.signedReady === true &&
          executionSnapshot.tradeEnabled === true &&
          executionSnapshot.closeOnly === false &&
          executionSnapshot.killSwitch === false &&
          executionSnapshot.reconcileSafe === false &&
          executionSnapshot.dailyLossGuard === false &&
          executionSnapshot.riskModeHalt === false;

        if (!v2QueueAllowed) {
          if (authority.decision === "ENTER" || (authority as any).originalDecision === "ENTER") {
            let blockReason = "v2_hard_safety_block";
            if (authority.decision !== "ENTER") blockReason = "authority_decision_not_enter";
            else if (authority.hardBlockPresent === true) blockReason = "hard_block_present";
            else if (authority.nonBypassableHardBlockPresent === true) blockReason = "non_bypassable_hard_block";
            else if (!executionSnapshot.signedReady) blockReason = "signed_not_ready";
            else if (!executionSnapshot.tradeEnabled) blockReason = "trade_disabled";
            else if (executionSnapshot.dailyLossGuard) blockReason = "daily_loss_guard";

            this.logger.info("V2_ENTER_CANDIDATE_ENQUEUE_PROOF", {
              symbol: symKey,
              authority_decision: authority.decision,
              original_decision: (authority as any).originalDecision ?? null,
              authority_side: authority.side,
              original_side: (authority as any).originalSide ?? null,
              stage_margin_krw: authority.stageMarginKrw ?? 0,
              original_stage_margin_krw: (authority as any).originalStageMarginKrw ?? 0,
              hard_block_present: authority.hardBlockPresent === true,
              hard_block_reason: authority.hardBlockReason ?? null,
              signed_execution_ready: executionSnapshot.signedReady,
              paper_execution_ready: executionSnapshot.paperReady,
              enqueued: false,
              enqueue_block_reason: blockReason,
              run_cycle_id: executionSnapshot.runCycleId,
              decision_id: (authority as any).decision_id ?? null
            });
          }
          return;
        }

        if (!base) {
          this.logger.info("V2_ENTER_CANDIDATE_ENQUEUE_PROOF", {
            symbol: symKey,
            authority_decision: authority.decision,
            enqueued: false,
            enqueue_block_reason: "snapshot_missing",
            run_cycle_id: executionSnapshot.runCycleId
          });
          return;
        }

        this.logger.info("V2_ENTER_CANDIDATE_ENQUEUE_PROOF", {
          symbol: symKey,
          authority_decision: authority.decision,
          original_decision: (authority as any).originalDecision ?? null,
          authority_side: authority.side,
          original_side: (authority as any).originalSide ?? null,
          stage_margin_krw: authority.stageMarginKrw ?? 0,
          original_stage_margin_krw: (authority as any).originalStageMarginKrw ?? 0,
          hard_block_present: !!authority.hardBlockPresent,
          hard_block_reason: authority.hardBlockReason ?? null,
          signed_execution_ready: executionSnapshot.signedReady,
          paper_execution_ready: executionSnapshot.paperReady,
          enqueued: true,
          enqueue_block_reason: null,
          run_cycle_id: executionSnapshot.runCycleId,
          decision_id: (authority as any).decision_id ?? null
        });

        const sig: PaperSignal = authority.side === "long" ? "paper_long_candidate" : "paper_short_candidate";
        entryQueue.push({ ...base, signal: sig, authoritySource: "v2" });
        return;
      }

      if (authority.source === "v1") {
        const effectiveAdaptiveResult = this.buildAuthorityAdaptiveBridge(authority, envelope.legacy.adaptiveResult);
        if (effectiveAdaptiveResult == null) return;
        if (!base) return;

        const sig: PaperSignal = authority.side === "long" ? "paper_long_candidate" : "paper_short_candidate";
        entryQueue.push({ ...base, signal: sig, authoritySource: "v1" });
      }
    });
    entryQueue.sort((a, b) => {
      const aMajor = a.symbol === "BTCUSDT" || a.symbol === "ETHUSDT";
      const bMajor = b.symbol === "BTCUSDT" || b.symbol === "ETHUSDT";
      if (aMajor && !bMajor) return -1;
      if (!aMajor && bMajor) return +1;
      return 0;
    });
    if (entryQueue.length === 0) {
      const barrierActive = this.freshTickRequiredAfterReadiness === true || input.readinessBarrierActive === true;
      const emptyPayload = {
        run_cycle_id: this.runCycleId,
        entry_queue_length: 0,
        block_reason: "entry_queue_empty",
        return_point: "entry_queue_empty_return",
        candidate_run_path: input.candidateRunPath,
        v2_bypass_ready: false,
        has_v2_authority_enter: false,
        has_v2_enqueued: false,
        fresh_tick_barrier_active: this.freshTickRequiredAfterReadiness,
        readiness_barrier_active: input.readinessBarrierActive
      };
      if (barrierActive) {
        this.logger.warn("ENTRY_QUEUE_PRE_CONSUME_BLOCKED_PROOF", emptyPayload);
      } else {
        this.logger.info("ENTRY_QUEUE_PRE_CONSUME_BLOCKED_PROOF", emptyPayload);
      }
      return;
    }

    const hasV2Enqueued = entryQueue.some(q => q.authoritySource === "v2");
    const hasV2AuthorityEnter = entryQueue.some(q => q.authoritySource === "v2");
    const v2BypassReadyValue = entryQueue.some(q => {
      const envelope = input.decisionBySymbol.get(String(q.symbol));
      if (!envelope) return false;
      const { authority } = envelope;
      const adoptedEngine = envelope.selector?.adopted_result.engine ?? null;
      return adoptedEngine === "V2" &&
        envelope.v2_execution_envelope?.authoritySource === "v2_execution_envelope" &&
        authority.source === "v2" &&
        authority.decision === "ENTER" &&
        (authority.side === "long" || authority.side === "short") &&
        (authority.stageMarginKrw ?? 0) > 0 &&
        executionSnapshot.paperReady === true &&
        executionSnapshot.signedReady === true &&
        executionSnapshot.tradeEnabled === true &&
        executionSnapshot.closeOnly === false &&
        executionSnapshot.killSwitch === false &&
        executionSnapshot.reconcileSafe === false &&
        executionSnapshot.dailyLossGuard === false &&
        executionSnapshot.riskModeHalt === false &&
        authority.hardBlockPresent !== true &&
        authority.nonBypassableHardBlockPresent !== true;
    });

    const storagePathsReady = Boolean(input.latestPath && input.metaPath && input.filePath);
    const onlyCandidateRunPathMissing = !input.candidateRunPath && storagePathsReady;
    const shouldBypassPathCheckForV2 =
      hasV2Enqueued === true &&
      hasV2AuthorityEnter === true &&
      v2BypassReadyValue === true &&
      storagePathsReady === true;

    const mandatoryPathsMissing = !input.candidateRunPath || !storagePathsReady;
    const freshTickBlocked = (input.readinessBarrierActive || this.freshTickRequiredAfterReadiness);

    this.logger.info("ENTRY_QUEUE_BUILD_COMPLETE_PROOF", {
      run_cycle_id: this.runCycleId,
      entry_queue_length: entryQueue.length,
      symbols: entryQueue.map(q => q.symbol),
      v2_count: entryQueue.filter(q => q.authoritySource === "v2").length,
      v1_count: entryQueue.filter(q => q.authoritySource === "v1").length,
      has_v2_enqueued: hasV2Enqueued,
      fresh_tick_barrier_active: this.freshTickRequiredAfterReadiness,
      readiness_barrier_active: input.readinessBarrierActive,
      candidate_run_path: input.candidateRunPath,
      will_enter_consume_loop:
        entryQueue.length > 0 &&
        (!mandatoryPathsMissing || shouldBypassPathCheckForV2) &&
        (!freshTickBlocked || v2BypassReadyValue)
    });

    this.logger.info("READINESS_REEVALUATION_STARTED", {
      run_cycle_id: this.runCycleId,
      queued_entries: entryQueue.length,
      readiness_changed_at: input.readinessChangedAt
    });
    const freshTickHardBlock =
      input.readinessBarrierActive || this.freshTickRequiredAfterReadiness;

    // V2 Execution Bridge logic now integrated into the main entry loop to ensure atomic diagnostic chains
    // and deterministic execution path logging.

    if (freshTickHardBlock) {
      const blockReason = input.readinessBarrierActive
        ? "fresh_tick_barrier_active"
        : "fresh_tick_required_pending_clear";

      // V2 Bypass: If all V2 authoritative criteria are met, bypass the fresh tick barrier.
      const v2BypassReady = v2BypassReadyValue;

      if (v2BypassReady) {
        this.logger.info("V2_AUTHORITY_BYPASS_FRESH_TICK_BARRIER", {
          run_cycle_id: this.runCycleId,
          barrier_reason: blockReason,
          readiness_barrier_active: input.readinessBarrierActive,
          fresh_tick_required_after_readiness: this.freshTickRequiredAfterReadiness
        });
      } else {
        this.logger.warn("ENTRY_BLOCKED_PREPARED_BUT_NOT_REEVALUATED", {
          reason: blockReason,
          queued_entries: entryQueue.length,
          run_cycle_id: this.runCycleId,
          readiness_changed_at: input.readinessChangedAt,
          readiness_barrier_active: input.readinessBarrierActive,
          fresh_tick_required_after_readiness: this.freshTickRequiredAfterReadiness,
          fresh_tick_completed_cycles: this.readinessFreshTickCompletedCycles,
          fresh_tick_required_cycles: this.readinessFreshTickRequiredCycles
        });
        this.logger.warn("READINESS_REEVALUATION_BLOCKED", {
          reason: blockReason,
          run_cycle_id: this.runCycleId
        });
        this.logger.warn("FRESH_TICK_BARRIER_HARD_BLOCK_PROOF", {
          run_cycle_id: this.runCycleId,
          block_reason: blockReason,
          readiness_barrier_active: input.readinessBarrierActive,
          fresh_tick_required_after_readiness: this.freshTickRequiredAfterReadiness,
          fresh_tick_completed_cycles: this.readinessFreshTickCompletedCycles,
          fresh_tick_required_cycles: this.readinessFreshTickRequiredCycles,
          queued_entries: entryQueue.length,
          paper_position_opened_will_not_run: true
        });
        this.logger.warn("V2_FINAL_HARD_BLOCK_PROOF", {
          gate: "fresh_tick_or_readiness_barrier",
          block_reason: blockReason,
          run_cycle_id: this.runCycleId,
          queued_entries: entryQueue.length
        });
        for (const q of entryQueue) {
          if (q.authoritySource === "v2") {
            // V2 후보는 deferred queue에 보존 (다음 사이클 재검증용, 심볼별 1개 Map upsert)
            const symStr = String(q.symbol);
            const envelope = input.decisionBySymbol.get(symStr);
            const authority = envelope?.authority;

            // [수정1] side: authority.side 우선, runtime/v2_side 참조, 최후 fallback만 q.signal
            const authSide = (
              authority?.side ??
              (authority as any)?.runtime_authority_side ??
              (authority as any)?.v2_side ??
              (authority as any)?.final_side ??
              null
            );
            const resolvedSide: "long" | "short" =
              authSide === "long" || authSide === "short"
                ? authSide
                : q.signal === "paper_short_candidate" ? "short" : "long";

            const stopPx = (authority as any)?.stopPrice ?? null;
            const stopPxNum = typeof stopPx === "number" ? stopPx : null;

            const existingDeferred = this.v2DeferredEntryQueue.get(symStr);
            const isReplacing = existingDeferred !== undefined;

            // [수정2] Map.set → 심볼별 1개, 최신 후보로 대체
            this.v2DeferredEntryQueue.set(symStr, {
              snapshot: q,
              deferredAtCycleId: this.runCycleId,
              deferredAtMs: Date.now(),
              symbol: symStr,
              side: resolvedSide,
              stageMarginKrw: authority?.stageMarginKrw ?? 0,
              stopPrice: stopPxNum,
              stopPriceValid: stopPxNum != null && Number.isFinite(stopPxNum),
              decisionId: (authority as any)?.decision_id ?? null,
              barrierReason: blockReason
            });
            this.logger.info("V2_ENTRY_QUEUE_DEFERRED_BY_BARRIER_PROOF", {
              run_cycle_id: this.runCycleId,
              symbol: symStr,
              side: resolvedSide,
              side_source: authSide != null ? "authority.side" : "q.signal_fallback",
              stage_margin_krw: authority?.stageMarginKrw ?? 0,
              stop_price: stopPxNum,
              reason: blockReason,
              fresh_tick_barrier_active: this.freshTickRequiredAfterReadiness,
              readiness_barrier_active: input.readinessBarrierActive,
              preserved: true,
              replaced_existing: isReplacing,
              decision_id: (authority as any)?.decision_id ?? null
            });
          } else {
            // V1 후보는 오염 샘플로만 기록
            const v1Side: "long" | "short" = q.signal === "paper_short_candidate" ? "short" : "long";
            this.contaminatedEntrySamples.push({
              ts: Date.now(),
              symbol: String(q.symbol),
              side: v1Side,
              source: "contaminated",
              vector: this.toEntryQualityVectorFromSnapshot(q, v1Side),
              reason: "blocked_by_readiness_fresh_tick_barrier"
            });
          }
        }

        this.logger.warn("ENTRY_QUEUE_PRE_CONSUME_BLOCKED_PROOF", {
          run_cycle_id: this.runCycleId,
          entry_queue_length: entryQueue.length,
          block_reason: blockReason,
          return_point: "fresh_tick_barrier_return",
          candidate_run_path: input.candidateRunPath,
          v2_bypass_ready: v2BypassReady,
          has_v2_authority_enter: entryQueue.some(q => q.authoritySource === "v2"),
          has_v2_enqueued: hasV2Enqueued,
          fresh_tick_barrier_active: this.freshTickRequiredAfterReadiness,
          readiness_barrier_active: input.readinessBarrierActive,
          v2_deferred_preserved: entryQueue.filter(q => q.authoritySource === "v2").length
        });
        return;

      }
    }

    // V2 Bypass logic moved to main loop

    if (mandatoryPathsMissing && !shouldBypassPathCheckForV2) {
      this.logger.warn("ENTRY_QUEUE_PRE_CONSUME_BLOCKED_PROOF", {
        run_cycle_id: this.runCycleId,
        entry_queue_length: entryQueue.length,
        block_reason: "mandatory_paths_missing",
        return_point: "path_check_return",
        missing_paths: {
          candidateRunPath: !input.candidateRunPath,
          latestPath: !input.latestPath,
          metaPath: !input.metaPath,
          filePath: !input.filePath
        },
        fresh_tick_barrier_active: this.freshTickRequiredAfterReadiness,
        readiness_barrier_active: input.readinessBarrierActive,
        v2_bypass_ready: v2BypassReadyValue,
        has_v2_authority_enter: hasV2AuthorityEnter,
        has_v2_enqueued: hasV2Enqueued,
        candidate_run_path: input.candidateRunPath,
        latest_path: input.latestPath,
        meta_path: input.metaPath,
        file_path: input.filePath
      });
      return;
    }

    if (shouldBypassPathCheckForV2 && !input.candidateRunPath) {
      this.logger.warn("ENTRY_QUEUE_PATH_FALLBACK_PROOF", {
        run_cycle_id: this.runCycleId,
        entry_queue_length: entryQueue.length,
        has_v2_enqueued: hasV2Enqueued,
        has_v2_authority_enter: hasV2AuthorityEnter,
        v2_bypass_ready: v2BypassReadyValue,
        storage_paths_ready: storagePathsReady,
        missing_paths: {
          candidateRunPath: !input.candidateRunPath,
          latestPath: !input.latestPath,
          metaPath: !input.metaPath,
          filePath: !input.filePath
        },
        fallback_reason: "candidate_run_path_missing_but_v2_authority_ready"
      });
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
    const isNewEntry = next.length === 0;
    const nowTs = Date.now();
    this.lastEntryDecision = null;

    let consumeIdx = 0;
    
    // [PENDING ENTRY REGISTRY PROCESSING]
    let pendingRegistryModified = false;
    let pendingEntryOrders = await this.store.readPendingEntryOrders();
    const activePendingEntryOrders: import("../models/types").PendingEntryOrderRecord[] = [];
    const shouldCancelPending = !executionSnapshot.tradeEnabled || executionSnapshot.closeOnly || executionSnapshot.killSwitch;

    for (const pending of pendingEntryOrders) {
      const ordId = pending.ordId;
      const liveOrder = this.cachedOpsPending.find(o => String(o.ordId) === ordId);
      
      if (shouldCancelPending) {
        let cancelSuccess = false;
        if (this.okxDemo) {
          try {
            const res = await this.okxDemo.cancelOrder(pending.instId, ordId);
            if (res.ok) cancelSuccess = true;
          } catch (e) {}
        }
        if (cancelSuccess) {
          this.logger.info("OKX_STALE_ENTRY_ORDER_CANCEL_PROOF", { symbol: pending.symbol, side: pending.side, ord_id: ordId, reason: "global_trade_disabled_or_kill_switch" });
          this.logger.info("PENDING_ENTRY_ORDER_CLEARED_PROOF", { symbol: pending.symbol, side: pending.side, ord_id: ordId, reason: "canceled_due_to_global_flags" });
          pendingRegistryModified = true;
        } else {
          this.logger.warn("OKX_STALE_ENTRY_ORDER_CANCEL_FAIL_PROOF", { symbol: pending.symbol, side: pending.side, ord_id: ordId, reason: "cancel_failed_or_network_error" });
          activePendingEntryOrders.push(pending);
        }
        continue;
      }

      if (liveOrder) {
        this.logger.info("PENDING_ENTRY_ORDER_FILL_CHECK_PROOF", { symbol: pending.symbol, side: pending.side, ord_id: ordId, status: "still_pending" });
        
        // --- V2 Missed Limit Fill Recovery Trigger ---
        const ageMs = Date.now() - pending.createdAt;
        if (pending.authority_source === "v2" && ageMs > 20_000) {
            this.logger.warn("V2_MISSED_LIMIT_FILL_PROOF", {
                symbol: pending.symbol,
                side: pending.side,
                ord_id: ordId,
                age_ms: ageMs,
                status: "stale_unfilled",
                action: "CANCEL_AND_RECOVER"
            });
            
            let cancelSuccess = false;
            if (this.okxDemo) {
                try {
                    const res = await this.okxDemo.cancelOrder(pending.instId, ordId);
                    if (res.ok) cancelSuccess = true;
                    else {
                        const getRes = await this.okxDemo.getOrder(pending.instId, ordId);
                        if (getRes.ok && getRes.value?.[0]?.state === "filled") {
                            activePendingEntryOrders.push(pending);
                            continue;
                        }
                    }
                } catch (e) {}
            }
            
            if (cancelSuccess) {
                const newCount = (pending.missedLimitFillCount ?? 0) + 1;
                this.logger.info("V2_MISSED_LIMIT_FILL_RECOVERY_PROOF", {
                    symbol: pending.symbol,
                    side: pending.side,
                    missedLimitFillCount: newCount,
                    lastEntryIntentSide: pending.side,
                    originalLimitPrice: pending.originalLimitPrice,
                    ts: Date.now()
                });
                
                this.v2RecoveryActiveBySymbol.set(pending.symbol, { 
                    side: pending.side, 
                    ts: Date.now(),
                    missedLimitFillCount: newCount,
                    lastEntryIntentSide: pending.side,
                    originalLimitPrice: pending.originalLimitPrice
                });
                pendingRegistryModified = true;
                continue; 
            }
        }
        
        activePendingEntryOrders.push(pending);
      } else {
        let orderState = "unknown";
        let ordResRef: any = null;
        if (this.okxDemo) {
          try {
            const res = await this.okxDemo.getOrder(pending.instId, ordId, pending.clOrdId);
            if (res.ok && res.value && res.value.length > 0) {
              ordResRef = res.value[0];
              orderState = String(ordResRef.state).toLowerCase();
            }
          } catch (e) {}
        }
        
        if (orderState === "filled") {
           // Snapshot Guard
           if (!pending.paperRecordSnapshot || typeof pending.paperRecordSnapshot !== "object") {
             this.logger.error("PENDING_ENTRY_FILLED_TO_LEDGER_OPEN_FAIL_PROOF", { symbol: pending.symbol, side: pending.side, ord_id: ordId, reason: "null_or_invalid_snapshot" });
             activePendingEntryOrders.push(pending);
             continue;
           }

           let actualPos = null;
           if (this.lastLivePositionsPayload && Array.isArray(this.lastLivePositionsPayload)) {
             actualPos = this.lastLivePositionsPayload.find((p: any) => p.instId === pending.instId && String(p.posSide).toLowerCase() === pending.side);
             if (!actualPos) {
               actualPos = this.lastLivePositionsPayload.find((p: any) => {
                 if (p.instId !== pending.instId) return false;
                 const posNum = Number(p.pos) || 0;
                 const deducedSide = posNum > 0 ? "long" : (posNum < 0 ? "short" : null);
                 return deducedSide === pending.side;
               });
             }
           }
           
           if (!actualPos) {
             this.logger.error("PENDING_ENTRY_FILLED_TO_LEDGER_OPEN_FAIL_PROOF", { symbol: pending.symbol, side: pending.side, ord_id: ordId, reason: "actual_position_not_found" });
             activePendingEntryOrders.push(pending);
             continue;
           }

           const actualAvgPx = Number(actualPos.avgPx);
           const actualBase = Number(actualPos.pos);
           const instR = this.instrumentCache.get(pending.instId);
           const ctValR = instR?.ctVal ?? 1;
           const baseQtyAbs = Math.abs(actualBase);

           const record = pending.paperRecordSnapshot;
           record.openedAt = Date.now();
           record.lifecycleState = "OPEN";
           record.avgPx = actualAvgPx;
           record.entryPrice = actualAvgPx;
           record.pos = actualBase;
           record.baseQty = baseQtyAbs;
           record.okxContracts = ctValR > 0 ? baseQtyAbs / ctValR : baseQtyAbs;
           record.exchangeFilledSize = record.okxContracts;
           
           let nuR = Number(actualPos.notionalUsd);
           if ((!Number.isFinite(nuR) || nuR === 0) && actualAvgPx > 0 && baseQtyAbs > 0) {
             nuR = baseQtyAbs * actualAvgPx;
           }
           record.notionalUsd = Math.abs(nuR);
           record.sizeUsd = record.notionalUsd;

           if (!isCommittedEntryStopPrice(record.stopPrice) && isCommittedEntryStopPrice(pending.stopPrice)) {
             record.stopPrice = pending.stopPrice as number;
           }
           if (!isCommittedEntryStopPrice(record.stopPrice)) {
             this.logger.error("PAPER_POSITION_OPEN_BLOCKED_MISSING_STOP", {
               symbol: pending.symbol,
               side: pending.side,
               path: "pending_entry_filled",
               pending_registry_stop: pending.stopPrice ?? null,
               snapshot_stop: record.stopPrice ?? null
             });
             this.logger.error("PROTECTION_REPAIR_REQUIRED", {
               symbol: pending.symbol,
               side: pending.side,
               detail: "pending_fill_without_committed_stop_on_snapshot"
             });
             this.symbolProtectionFailedBlocked.add(String(pending.symbol));
             activePendingEntryOrders.push(pending);
             continue;
           }

           this.logger.info("PENDING_ENTRY_FILLED_TO_LEDGER_OPEN_PROOF", { symbol: pending.symbol, side: pending.side, ord_id: ordId });
           
           next.push(record);
           openPositionsChanged = true;
           
           const protectRes = await this.ensureProtectiveStopOrder(record, `v2_pending_filled_auto:${record.symbol}:${record.openedAt}`);
           if (protectRes.modified) {
             record.isProtectiveStopRegistered = protectRes.record.isProtectiveStopRegistered;
             record.protectiveStopAlgoId = protectRes.record.protectiveStopAlgoId;
           }
           
           this.logger.info("paper_position_opened", {
             ...pending.authoritySnapshot,
             open_trace_id: pending.openTraceId,
             symbol: pending.symbol,
             side: pending.side,
             ord_id: ordId,
             path: "positions/open.json",
             size_usd: record.sizeUsd
           });
           try {
             await this.store.appendJsonlLine("reports/events.jsonl", buildEntryOpenedEventPayload(pending.symbol, pending.authoritySnapshot as any, record));
           } catch(e) {}
           
           pendingRegistryModified = true;
        } else if (orderState === "canceled" || orderState === "mmp_canceled" || orderState === "rejected" || orderState === "expired") {
           this.logger.info("PENDING_ENTRY_ORDER_CLEARED_PROOF", { symbol: pending.symbol, side: pending.side, ord_id: ordId, reason: orderState });
           pendingRegistryModified = true;
        } else if (orderState === "unknown") {
           this.logger.warn("PENDING_ENTRY_ORDER_FILL_CHECK_FAIL_PROOF", { symbol: pending.symbol, side: pending.side, ord_id: ordId, reason: "get_order_failed_or_unknown" });
           activePendingEntryOrders.push(pending);
        } else {
           this.logger.info("PENDING_ENTRY_ORDER_FILL_CHECK_PROOF", { symbol: pending.symbol, side: pending.side, ord_id: ordId, status: orderState });
           activePendingEntryOrders.push(pending);
        }
      }
    }
    
    if (pendingRegistryModified) {
      await this.store.writePendingEntryOrders(activePendingEntryOrders);
      pendingEntryOrders = activePendingEntryOrders;
    }

    for (const first of entryQueue) {
      const envelope = input.decisionBySymbol.get(String(first.symbol))!;
      const authority = envelope.authority;

      if (activePendingEntryOrders.some(p => p.symbol === String(first.symbol) && p.side === authority.side)) {
        this.logger.warn("V2_DUPLICATE_PENDING_ENTRY_BLOCK_PROOF", { symbol: first.symbol, side: authority.side });
        consumeIdx++;
        continue;
      }

      this.logger.info("ENTRY_QUEUE_CONSUME_PROOF", {
        run_cycle_id: this.runCycleId,
        queue_length: entryQueue.length,
        index: consumeIdx,
        symbol: first.symbol,
        signal: first.signal,
        authoritySource: first.authoritySource,
        has_decision_envelope: !!envelope,
        authority_decision: authority?.decision,
        authority_side: authority?.side,
        stage_margin_krw: authority?.stageMarginKrw,
        signed_execution_ready: executionSnapshot.signedReady,
        paper_execution_ready: executionSnapshot.paperReady
      });
      consumeIdx++;

      const res = envelope.legacy;
      const adoptedEngine = envelope.selector?.adopted_result.engine ?? null;
      this.lastEntryEvaluatedAt = nowTs;
      this.lastEntrySignalFetchedAt = envelope.signalFetchedAt ?? first.fetchedAt ?? null;

      const readinessChangedAt = executionSnapshot.readinessChangedAt;
      const gateTimestamps = [readinessChangedAt, executionSnapshot.serverTradeEnabledTrueAt].filter(
        (x): x is number => typeof x === "number" && Number.isFinite(x)
      );
      const effectiveReadinessGateTs = gateTimestamps.length > 0 ? Math.max(...gateTimestamps) : null;
      const staleReasons: string[] = [];
      if (effectiveReadinessGateTs != null) {
        const g = effectiveReadinessGateTs;
        if ((envelope.signalFetchedAt ?? first.fetchedAt) < g) staleReasons.push("signal_fetched_before_readiness_or_trade_enable_gate");
        if (envelope.authorityEvaluatedAt < g) staleReasons.push("authority_evaluated_before_readiness_or_trade_enable_gate");
        if (envelope.executorDecisionEvaluatedAt < g) staleReasons.push("executor_decision_before_readiness_or_trade_enable_gate");
        if (first.fetchedAt < g) staleReasons.push("snapshot_fetched_before_readiness_or_trade_enable_gate");
        if (envelope.decisionCycleId < executionSnapshot.runCycleId) staleReasons.push("order_basis_previous_cycle");
      }
      const v2BypassConditionsMet = 
        envelope.selector?.adopted_result.engine === "V2" &&
        authority.decision === "ENTER" &&
        (authority.side === "long" || authority.side === "short") &&
        (authority.stageMarginKrw ?? 0) > 0 &&
        executionSnapshot.paperReady === true &&
        executionSnapshot.signedReady === true &&
        executionSnapshot.tradeEnabled === true &&
        executionSnapshot.closeOnly === false &&
        executionSnapshot.killSwitch === false &&
        executionSnapshot.reconcileSafe === false &&
        executionSnapshot.dailyLossGuard === false &&
        executionSnapshot.riskModeHalt === false;

      if (staleReasons.length > 0 && !v2BypassConditionsMet) {
        this.logger.warn("ENTRY_BLOCKED_STALE_SIGNAL", {
          symbol: first.symbol,
          stale_reasons: staleReasons,
          readiness_changed_at: readinessChangedAt,
          server_trade_enabled_true_at: this.serverTradeEnabledTrueAt,
          effective_readiness_gate_ts: effectiveReadinessGateTs,
          signal_fetched_at: envelope.signalFetchedAt ?? first.fetchedAt,
          authority_evaluated_at: envelope.authorityEvaluatedAt,
          executor_decision_evaluated_at: envelope.executorDecisionEvaluatedAt,
          snapshot_fetched_at: first.fetchedAt,
          decision_cycle_id: envelope.decisionCycleId,
          current_cycle_id: this.runCycleId
        });
        this.contaminatedEntrySamples.push({
          ts: Date.now(),
          symbol: String(first.symbol),
          side: authority.side === "short" ? "short" : "long",
          source: "contaminated",
          vector: this.toEntryQualityVectorFromSnapshot(first, authority.side === "short" ? "short" : "long"),
          reason: staleReasons.join("|")
        });
        continue;
      }
      
      if (staleReasons.length > 0 && v2BypassConditionsMet) {
        this.logger.info("V2_AUTHORITY_STALE_SIGNAL_BYPASS_PROOF", {
          symbol: first.symbol,
          stale_reasons: staleReasons,
          authority_source: authority.source,
          authority_decision: authority.decision,
          v2_bypass_conditions_met: true
        });
      }
      if (
        readinessChangedAt != null &&
        authority.decision === "ENTER" &&
        this.readinessTransitionCycleId != null &&
        this.readinessTransitionCycleId === this.runCycleId
      ) {
        if (!v2BypassConditionsMet) {
          this.logger.error("ENTRY_HARD_BLOCKED", this.buildInvariantProofPayload({
            symbol: String(first.symbol),
            side: authority.side,
            authority,
            adoptedEngine,
            lifecycleState: null,
            reason: "entry_attempt_same_cycle_after_readiness_recovery"
          }));
          this.logger.warn("V2_FINAL_HARD_BLOCK_PROOF", {
            gate: "readiness_same_cycle_recovery",
            symbol: first.symbol,
            run_cycle_id: this.runCycleId,
            readiness_transition_cycle_id: this.readinessTransitionCycleId
          });
          continue;
        } else {
          this.logger.info("V2_AUTHORITY_RECOVERY_CYCLE_BYPASS_PROOF", {
            symbol: first.symbol,
            run_cycle_id: this.runCycleId,
            readiness_transition_cycle_id: this.readinessTransitionCycleId,
            v2_bypass_conditions_met: true
          });
        }
      }

      const v2BlockReason = envelope.selector?.v2_result.risk.blockReason ?? null;
      const v2Signal = envelope.selector?.v2_result.signal ?? null;
      const exDetailForRecheck = (res.executorDecision?.detail ?? {}) as Record<string, unknown>;
      const activeEngine = this.lastMarketMode?.routing.activeEngine ?? "IDLE";
      const serverTradeEnabled = this.serverTradeControlState.server_trade_enabled;
      const closeOnlyMode = this.serverTradeControlState.close_only_mode;
      const killSwitch = this.serverTradeControlState.kill_switch_active;
      const reconcileSafeMode = this.reconcileSafetyCloseOnly;
      const riskModeForPromotion = this.lastRiskExposure?.riskMode ?? null;
      const dailyLossGuardForPromotion = this.lastRisk?.dailyLossGuardTriggered === true;
      const preEntryEvidenceScore = computeEntryEvidenceScore({
        qualityScore: first.qualityScore ?? null,
        candidateStrength: first.candidateStrength ?? null,
        activeEngine,
        side: (authority.side ?? "long") as "long" | "short",
        boxPos: first.boxPos ?? null,
        trendOk: first.trendOk === true,
        emaGap: first.emaGap ?? null,
        trendWeaknessScore: first.trendWeaknessScore ?? null
      });
      const recheckPromotion =
        authority.side === "long" || authority.side === "short"
          ? this.evaluateRangeRecheckPromotion({
            symbol: String(first.symbol),
            side: authority.side,
            authoritySource: authority.source,
            authorityDecision: authority.decision,
            authorityRegime: authority.regime ?? null,
            authorityEntryQualityGrade: authority.entryQualityGrade ?? null,
            adoptedEngine,
            finalEngineOwner: envelope.selector?.adopted_result.engine ?? null,
            activeEngine,
            boxPos: first.boxPos ?? null,
            rangeConfidence: first.rangeConfidence ?? null,
            boxCohesion01: first.boxCohesion01 ?? null,
            trendWeaknessScore: first.trendWeaknessScore ?? null,
            trendOk: first.trendOk === true,
            emaGap: first.emaGap ?? null,
            qualityScore: first.qualityScore ?? 0,
            lastPrice: first.lastPrice,
            v2BlockReason,
            v2Signal,
            relaxedRangeEntry:
              exDetailForRecheck.relaxedRangeEntry === true ||
              first.rangeSignalKeptByRelax === true,
            reversalConfirmed: exDetailForRecheck.reversal_confirmed === true,
            directionalShockState: this.lastRisk?.directionalShockState ?? null,
            serverTradeEnabled,
            closeOnlyMode,
            killSwitch,
            reconcileSafeMode,
            riskMode: riskModeForPromotion,
            dailyLossGuardActive: dailyLossGuardForPromotion,
            openPositionCount: next.length,
            maxSlots: max,
            entryEvidenceScore: preEntryEvidenceScore
          })
          : { promote: false, reason: "no_directional_side", ticks: 0 };
      const authorityDecisionForExecution =
        (authority.source === "v2" && adoptedEngine === "V2")
          ? authority.decision
          : (authority.decision === "ENTER" || recheckPromotion.promote
            ? "ENTER"
            : authority.decision);

      if (recheckPromotion.promote) {
        this.logger.info("ENTRY_EVIDENCE_RECHECK_PASS", {
          symbol: first.symbol,
          side: authority.side,
          ticks: recheckPromotion.ticks,
          recheck_reason: recheckPromotion.reason,
          range_confidence: first.rangeConfidence ?? null,
          box_pos: first.boxPos ?? null,
          entry_evidence_score: preEntryEvidenceScore,
          authority_source: authority.source,
          adopted_engine: adoptedEngine
        });
        this.logger.info("V2_WAIT_RECHECK_PROMOTED_TO_ENTER", {
          symbol: first.symbol,
          side: authority.side,
          authority_source: authority.source,
          authority_decision_before: authority.decision,
          authority_decision_after: authorityDecisionForExecution,
          v2_reject_reason_before: v2BlockReason,
          entry_quality_grade: authority.entryQualityGrade ?? null,
          regime_at_decision: authority.regime ?? null,
          active_engine_routing: this.lastMarketMode?.routing.activeEngine ?? null,
          rangeConfidence: first.rangeConfidence ?? null,
          boxCohesion01: first.boxCohesion01 ?? null,
          trendWeaknessScore: first.trendWeaknessScore ?? null,
          qualityScore: first.qualityScore ?? null,
          boxPos: first.boxPos ?? null,
          zone: typeof first.boxPos === "number" && Number.isFinite(first.boxPos)
            ? classifyRangeZone(first.boxPos)
            : "mid",
          reviewing_ticks: recheckPromotion.ticks,
          relaxedRangeEntry:
            exDetailForRecheck.relaxedRangeEntry === true ||
            first.rangeSignalKeptByRelax === true,
          reversal_confirmed: exDetailForRecheck.reversal_confirmed === true,
          directionalShockState: this.lastRisk?.directionalShockState ?? "NONE",
          promotion_reason: recheckPromotion.reason
        });
      }
      // V2 ENTRY REHYDRATION: originalDecision/originalSide/originalStageMarginKrw 湲곕컲?쇰줈
      // readiness ?ы룊媛€濡?REJECT濡?諛붾€?authority瑜?媛뺤젣 蹂듭썝?쒕떎.
      // ?덈? ?고쉶 遺덇? 釉붾줉(KILL_SWITCH ?????놁쓣 ?뚮쭔 ?곸슜.
      const NON_BYPASSABLE_HARD_BLOCKS = new Set<string>([
        "SERVER_TRADE_DISABLED", "CLOSE_ONLY_MODE", "KILL_SWITCH", "RECONCILE_SAFE_MODE",
        "RISK_MODE_HALT", "DAILY_LOSS_GUARD", "MAX_SLOTS_REACHED", "MIN_ORDER_SIZE_UNDERFLOW",
        "ORDER_BUILD_FAIL", "RISK_EXPOSURE_CAP_PRE_SUBMIT", "CRASH_ENTRY_GUARD_BLOCK",
        "SYMBOL_OPPOSITE_POSITION_OPEN", "SYMBOL_SAME_SIDE_POSITION_ALREADY_OPEN",
        "AUTHORITY_SIDE_INVALID"
      ]);
      const isV2Source = authority.source === "v2" && adoptedEngine === "V2";
      const hasOriginalEnterIntent =
        (authority.originalDecision === "ENTER" || authority.decision === "ENTER") &&
        (authority.originalSide === "long" || authority.originalSide === "short" ||
         authority.side === "long" || authority.side === "short") &&
        (authority.originalStageMarginKrw ?? authority.stageMarginKrw ?? 0) > 0;
      const nonBypassableActive =
        authority.nonBypassableHardBlockPresent === true ||
        (authority.hardBlockReason != null && NON_BYPASSABLE_HARD_BLOCKS.has(authority.hardBlockReason));
      const safetyGatesOk =
        input.serverTradeEnabled === true &&
        input.closeOnlyMode === false &&
        input.killSwitchActive === false &&
        this.reconcileSafetyCloseOnly === false &&
        this.paperExecutionReady === true &&
        this.signedExecutionReady === true;

      let rehydratedDecisionForExecution = authorityDecisionForExecution;
      let rehydratedSide = authority.side;
      let rehydratedStageMarginKrw = authority.stageMarginKrw ?? 0;
      let rehydrationApplied = false;
      let bypassed_reason: string | null = null;

      if (isV2Source && hasOriginalEnterIntent && !nonBypassableActive && safetyGatesOk &&
          authorityDecisionForExecution !== "ENTER") {
        bypassed_reason = authority.hardBlockReason ?? "readiness_barrier_overrode_v2_enter";
        rehydratedDecisionForExecution = "ENTER";
        rehydratedSide = (authority.originalSide ?? authority.side) as "long" | "short";
        rehydratedStageMarginKrw = authority.originalStageMarginKrw ?? authority.stageMarginKrw ?? 0;
        rehydrationApplied = true;
      }

      if (isV2Source && hasOriginalEnterIntent) {
        this.logger.info("V2_ENTRY_AUTHORITY_REHYDRATED_PROOF", {
          symbol: first.symbol,
          original_decision: authority.originalDecision ?? authority.decision,
          original_side: authority.originalSide ?? authority.side,
          original_stage_margin_krw: authority.originalStageMarginKrw ?? authority.stageMarginKrw ?? 0,
          decision_before: authorityDecisionForExecution,
          side_before: authority.side,
          stage_margin_before: authority.stageMarginKrw ?? 0,
          decision_after: rehydratedDecisionForExecution,
          side_after: rehydratedSide,
          stage_margin_after: rehydratedStageMarginKrw,
          bypassed_reason,
          non_bypassable_hard_block_present: nonBypassableActive,
          final_blocked_reason: rehydratedDecisionForExecution === "ENTER" ? null : (authority.hardBlockReason ?? null),
          rehydration_applied: rehydrationApplied
        });
      }

      const effectiveAuthorityDecision = rehydratedDecisionForExecution;
      const effectiveSideForExecution = rehydrationApplied ? rehydratedSide : (authority.side as "long" | "short");

      const effectiveAdaptiveResult = this.buildAuthorityAdaptiveBridge(
        { ...authority, decision: effectiveAuthorityDecision as typeof authority.decision, side: effectiveSideForExecution },
        res.adaptiveResult,
        effectiveAuthorityDecision === "ENTER" && authority.decision !== "ENTER"
      );

      if (effectiveAdaptiveResult == null) continue;

      this.logger.info("V2_EXECUTION_BRIDGE_LOG_ADAPTIVE", {
        symbol: first.symbol,
        authority_decision: authority.decision,
        authority_decision_for_execution: authorityDecisionForExecution,
        authority_source: authority.source,
        authority_side: authority.side,
        authority_stage_margin_krw: authority.stageMarginKrw ?? 0,
        authority_selector_size_krw: authority.stageMarginKrw ?? 0,
        authority_size_usd: effectiveAdaptiveResult.sizeUsd,
        authority_owns_execution: authority.source === "v2",
        recheck_promotion_applied: recheckPromotion.promote,
        recheck_promotion_ticks: recheckPromotion.ticks,
        range_confidence: first.rangeConfidence ?? null,
        legacy_adaptive_present: res.adaptiveResult != null,
        effective_adaptive_present: effectiveAdaptiveResult != null
      });

      if (this.lastEffectiveLane === "RANGE") {
        const origSnap = input.snapshots.find((s) => s.symbol === first.symbol);
        const qz = typeof first.boxPos === "number" ? classifyRangeZone(first.boxPos) : null;

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
      let v2CommittedRiskPlan: V2PreEntryRiskPlanCommitted | null = null;
      const existingOpen = next.find((o) => o.symbol === first.symbol && o.side === intentSide);
      const entryStage = existingOpen?.entryStage ?? 0;
      const existingIdx = next.findIndex((o) => o.symbol === first.symbol && o.side === intentSide);
      const otherLeg = next.some((o) => o.symbol === first.symbol && o.side !== intentSide);

      const absHardBlockPresent =
        authority.hardBlockPresent === true || envelope.hard_block_present === true;
      /** ?좉퇋 吏꾩엯(existingIdx<0) ?꾩슜: ?ㅼ??쇱씤쨌?좊뱶??寃쎈줈?먯꽌???덇굅??RANGE no-reversal 臾댁떆瑜??곸슜?섏? ?딅뒗?? */
      const v2EnterSignedPaperReadyHandoff =
        authority.source === "v2" &&
        adoptedEngine === "V2" &&
        authorityDecisionForExecution === "ENTER" &&
        !absHardBlockPresent &&
        executionSnapshot.paperReady === true &&
        executionSnapshot.signedReady === true;
      const legacyRangeRejectIgnoredForV2 =
        v2EnterSignedPaperReadyHandoff &&
        existingIdx < 0 &&
        res.decision.reject_reason != null &&
        LEGACY_RANGE_EDGE_NO_REVERSAL_REJECTS.has(String(res.decision.reject_reason));

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
      // Resolve market subtype: authority wins, fallback to v2_execution_envelope
      const effectiveMarketSubtype: string =
        authority.marketSubtype != null
          ? String(authority.marketSubtype)
          : String(envelope.v2_execution_envelope?.marketSubtype ?? "");
      const decision = res.executorDecision!;
      const authorityRegimeUpper = String(authority.regime ?? "").toUpperCase();
      const activeEngineRouting = this.lastMarketMode?.routing.activeEngine ?? null;
      let stage1ExecutorLabel = decision.executor;
      if (
        authority.source === "v2" &&
        (authorityRegimeUpper === "RANGE" || activeEngineRouting === "RANGE") &&
        (authority.decision === "ENTER" || authority.decision === "HOLD") &&
        stage1ExecutorLabel !== "RANGE"
      ) {
        const executorBefore = stage1ExecutorLabel;
        stage1ExecutorLabel = "RANGE";
        this.logger.info("V2_EXECUTOR_ROUTING_ALIGNED", {
          symbol: sym,
          authority_source: authority.source,
          authority_regime: authority.regime ?? null,
          active_engine_routing: activeEngineRouting,
          executor_before: executorBefore,
          executor_after: stage1ExecutorLabel,
          alignment_reason: "v2_range_authority_execution_context_alignment"
        });
      }
      const stage1ExecutionEngine: "RANGE" | "TREND" | "IDLE" =
        stage1ExecutorLabel === "RANGE" || stage1ExecutorLabel === "TREND"
          ? stage1ExecutorLabel
          : activeEngine;
      const adaptive = effectiveAdaptiveResult;
      const entryQualitySizeMultiplier = 1;

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
      const crashState = this.lastRisk?.crashState ?? "NONE";
      const crashLockUntil = this.lastRisk?.crashLockUntil ?? 0;
      const nowForCrash = Date.now();

      // [CRASH GUARD REDESIGN]
      // CRASH_REDUCE: ?ъ씠利?異뺤냼/怨듦꺽???쏀솕 ?꾩슜 ??吏꾩엯 ?먯껜??李⑤떒?섏? ?딅뒗??
      //   longAllow=false 瑜??듯빐 risk-exposure ?덉씠?댁뿉???대? ?듭ெ??
      // CRASH_EXIT/LOCK: 媛뺥븳 no-entry ?덉슜. ???꾨옒 議곌꾨뱾??紐⑤몢 異⑹”?섎㈃ ?먮룞 ?댁젣:
      //   (a) ?꾩옱 activeEngine ??RANGE (?쒖옣?먮떒???대? 諛붾€??곹깭)
      //   (b) crashLockUntil ??留뚮즺?먭굅??=0) CRASH_GUARD_REGIME_AWARE_RELEASE_MS 寃쎄낵
      // 紐⑺몴: crash guard 媛€ ?쒖옣?먮떒 蹂€寃??꾩뿉??臾닿린???꾩껜 吏꾩엯???쇰━吏€ ?딄쾶.
      const crashLockExpiredOrSoon =
        crashLockUntil === 0 ||
        nowForCrash >= crashLockUntil ||
        (nowForCrash + CRASH_GUARD_REGIME_AWARE_RELEASE_MS) >= crashLockUntil;
      const crashGuardRegimeAwareReleased =
        (crashState === "CRASH_EXIT" || crashState === "CRASH_LOCK") &&
        activeEngine === "RANGE" &&
        crashLockExpiredOrSoon;

      // CRASH_REDUCE ?????댁긽 濡?吏꾩엯 ?꾨㈃ 李⑤떒?섏? ?딆쓬 (size 異뺤냼 ?덉씠?대줈 ?€泥?
      const crashEntryGuardApplies =
        authority.side === "long" &&
        (crashState === "CRASH_EXIT" || crashState === "CRASH_LOCK") &&
        !crashGuardRegimeAwareReleased;

      const zone = typeof first.boxPos === "number" && Number.isFinite(first.boxPos) ? classifyRangeZone(first.boxPos) : null;
      const exDetail = (res.executorDecision?.detail ?? null) as Record<string, unknown> | null;
      const bypassReason =
        typeof exDetail?.crash_lock_bypass_reason === "string" && exDetail.crash_lock_bypass_reason.length > 0
          ? exDetail.crash_lock_bypass_reason
          : typeof exDetail?.bypass_reason === "string" && exDetail.bypass_reason.length > 0
            ? exDetail.bypass_reason
            : null;
      const overrideReason =
        typeof exDetail?.override_reason === "string" && exDetail.override_reason.length > 0
          ? exDetail.override_reason
          : bypassReason;
      const preRiskCrashState =
        typeof exDetail?.pre_risk_crash_state === "string" && exDetail.pre_risk_crash_state.length > 0
          ? exDetail.pre_risk_crash_state
          : crashState;
      const reversalConfirmedFromLegacyExecutor =
        res.executorDecision?.entry_allowed === true &&
        (res.executorDecision?.blocked_reason == null ||
          !String(res.executorDecision?.blocked_reason).toLowerCase().includes("reversal_confirm"));
      const reversalConfirmed =
        legacyRangeRejectIgnoredForV2 || reversalConfirmedFromLegacyExecutor;
      const relaxedRangeEntryForCrashBypass =
        exDetail?.relaxedRangeEntry === true ||
        first.rangeSignalKeptByRelax === true;
      const rangeZoneAlignedForCrashBypass =
        (authority.side === "long" && zone === "lower") ||
        (authority.side === "short" && zone === "upper");
      const rangeContextForCrashBypass =
        activeEngine === "RANGE" || String(authority.regime ?? "").toUpperCase() === "RANGE";
      const serverControlAllowsEntry =
        executionSnapshot.tradeEnabled &&
        !executionSnapshot.closeOnly &&
        !executionSnapshot.killSwitch &&
        !executionSnapshot.reconcileSafe;
      const riskModeHaltForCrashBypass =
        String(this.lastRiskExposure?.riskMode ?? "").toUpperCase() === "HALT";
      const dailyLossGuardForCrashBypass =
        this.lastRisk?.dailyLossGuardTriggered === true;
      const ngeStage0UpperLongBlock =
        authority.side === "long" &&
        zone === "upper" &&
        res.decision.range_stage0_engine_taken === true;
      const entryEvidenceScore = computeEntryEvidenceScore({
        qualityScore: first.qualityScore ?? null,
        candidateStrength: first.candidateStrength ?? null,
        activeEngine,
        side: authority.side as "long" | "short",
        boxPos: first.boxPos ?? null,
        trendOk: first.trendOk === true,
        emaGap: first.emaGap ?? null,
        trendWeaknessScore: first.trendWeaknessScore ?? null
      });
      let entryEvidenceReason = "ENTRY_EVIDENCE_ACCEPTED";
      this.logger.info("ENTRY_EVIDENCE_SNAPSHOT", {
        symbol: first.symbol,
        regime_at_entry: (this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane),
        active_engine_at_entry: activeEngine,
        entry_signal: first.signal,
        entry_quality_grade: authority.entryQualityGrade ?? null,
        entry_quality_score: first.qualityScore ?? null,
        side: authority.side,
        boxPos: first.boxPos ?? null,
        rangeConfidence: first.rangeConfidence ?? null,
        emaGap: first.emaGap ?? null,
        trendWeaknessScore: first.trendWeaknessScore ?? null,
        candidateStrength: first.candidateStrength ?? null,
        authority_source: authority.source,
        adopted_engine: adoptedEngine,
        entry_evidence_score: entryEvidenceScore
      });

      // Opposite-leg / hedge: part of final gate (single blocked_reason source).
      let oppositeLegBlockedReason: string | null = null;
      if (otherLeg) {
        if (!this.lastRiskExposure) {
          oppositeLegBlockedReason = "OPPOSITE_LEG_BLOCKED_NON_ACTIVE_ENGINE";
        } else if (stage1ExecutionEngine === "RANGE" && !this.lastRiskExposure.allowRangeBidirectional) {
          oppositeLegBlockedReason = "RANGE_HEDGE_BLOCKED";
        } else if (stage1ExecutionEngine === "TREND" && this.lastRiskExposure.blockTrendOppositeLeg) {
          oppositeLegBlockedReason = "TREND_OPPOSITE_LEG_BLOCKED";
        } else if (stage1ExecutionEngine !== "RANGE" && stage1ExecutionEngine !== "TREND") {
          oppositeLegBlockedReason = "OPPOSITE_LEG_BLOCKED_NON_ACTIVE_ENGINE";
        }
      }

      if (authority.source !== "v2") {
        this.logger.error("ENTRY_AUTHORITY_INVARIANT_BROKEN", this.buildInvariantProofPayload({
          symbol: sym,
          side: authority.side,
          authority,
          adoptedEngine,
          lifecycleState: existingOpen?.lifecycleState ?? null,
          reason: "authority_source_not_v2"
        }));
        finalBlockedReason = "AUTHORITY_SOURCE_NOT_V2";
      } else if (adoptedEngine !== "V2") {
        this.logger.error("ENTRY_AUTHORITY_INVARIANT_BROKEN", this.buildInvariantProofPayload({
          symbol: sym,
          side: authority.side,
          authority,
          adoptedEngine,
          lifecycleState: existingOpen?.lifecycleState ?? null,
          reason: "adopted_engine_not_v2"
        }));
        finalBlockedReason = "ADOPTED_ENGINE_NOT_V2";
      } else if (authorityDecisionForExecution !== "ENTER") {
        finalBlockedReason = "AUTHORITY_DECISION_NOT_ENTER";
      } else if (crashEntryGuardApplies) {
        finalBlockedReason = "CRASH_ENTRY_GUARD_BLOCK";
      } else if (!validSide) {
        finalBlockedReason = "AUTHORITY_ENTER_WITH_INVALID_SIDE";
      } else if (ngeStage0UpperLongBlock) {
        finalBlockedReason = "NGE_STAGE0_UPPER_LONG_BLOCK";
      } else if (
        first.candidateStrength === "weak" &&
        (authority.entryQualityGrade == null || authority.entryQualityGrade === "B")
      ) {
        finalBlockedReason = "ENTRY_EVIDENCE_RECHECK_WEAK_CANDIDATE";
        entryEvidenceReason = "weak_candidate_with_low_grade_recheck";
      } else if (stage1ExecutionEngine === "RANGE") {
        if (typeof first.boxPos !== "number" || !Number.isFinite(first.boxPos)) {
          finalBlockedReason = "ENTRY_EVIDENCE_RECHECK_RANGE_ZONE_UNKNOWN";
          entryEvidenceReason = "range_zone_unknown_recheck";
        } else {
          const rz = classifyRangeZone(first.boxPos);
          const rangeSideOk = (authority.side === "short" && rz === "upper") || (authority.side === "long" && rz === "lower");
          if (!rangeSideOk) {
            finalBlockedReason = "ENTRY_EVIDENCE_RECHECK_RANGE_ZONE_MISMATCH";
            entryEvidenceReason = "range_zone_mismatch_recheck";
          }
        }
      } else if (stage1ExecutionEngine === "TREND") {
        const emaGapAbs = Math.abs(first.emaGap ?? 0);
        const trendWeakness = first.trendWeaknessScore ?? 1;
        const trendEvidenceOk =
          first.trendOk === true &&
          emaGapAbs >= ENTRY_EVIDENCE_TREND_EMA_GAP_MIN &&
          trendWeakness <= ENTRY_EVIDENCE_TREND_WEAKNESS_MAX;
        if (!trendEvidenceOk) {
          finalBlockedReason = "ENTRY_EVIDENCE_RECHECK_TREND_WEAK";
          entryEvidenceReason = "trend_structure_insufficient_recheck";
        }
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

      // [CRASH ENTRY GUARD EVALUATION]
      if (finalBlockedReason === "CRASH_ENTRY_GUARD_BLOCK") {
        const finalBlockedReasonBefore = finalBlockedReason;
        const crashBypassEligible =
          rangeContextForCrashBypass &&
          authorityDecisionForExecution === "ENTER" &&
          rangeZoneAlignedForCrashBypass &&
          (reversalConfirmed || relaxedRangeEntryForCrashBypass) &&
          (crashState === "CRASH_LOCK" || crashState === "CRASH_EXIT") &&
          serverControlAllowsEntry &&
          !riskModeHaltForCrashBypass &&
          !dailyLossGuardForCrashBypass;

        if (crashBypassEligible) {
          finalBlockedReason = null;
          this.logger.info("CRASH_ENTRY_GUARD_BYPASS_APPLIED", {
            symbol: sym,
            side: authority.side,
            zone,
            crash_state: crashState,
            pre_risk_crash_state: preRiskCrashState,
            crash_lock_until: crashLockUntil,
            bypass_reason: bypassReason,
            override_reason: overrideReason,
            reversal_confirmed: reversalConfirmed,
            rangeConfidence: first.rangeConfidence ?? null,
            authority_decision: authorityDecisionForExecution,
            authority_source: authority.source,
            active_engine_routing: this.lastMarketMode?.routing.activeEngine ?? null,
            final_blocked_reason_before: finalBlockedReasonBefore,
            final_blocked_reason_after: finalBlockedReason
          });
        }
      }

      // [SOFT BLOCK CONFLICT CHECK]
      if (finalBlockedReason === null) {
        const d = adaptive.detail as Record<string, unknown>;
        const adaptiveConfTierRaw = typeof d?.confidence_tier === "string" ? String(d.confidence_tier).toLowerCase() : "";
        const adaptiveConfScore =
          typeof d?.confidence_score === "number" && Number.isFinite(d.confidence_score) ? (d.confidence_score as number) : null;
        const tierAggressive = adaptiveConfTierRaw === "top" || adaptiveConfTierRaw === "high";
        const evidenceLow =
          entryEvidenceScore < 60 ||
          first.candidateStrength === "weak" ||
          authority.entryQualityGrade === "B";
        if (tierAggressive && evidenceLow) {
          finalBlockedReason = "ENTRY_QUALITY_CONFLICT_BLOCK";
          entryEvidenceReason = "confidence_evidence_conflict";
          this.logger.warn("ENTRY_QUALITY_CONFLICT_BLOCK_PROOF", {
            symbol: sym,
            adaptive_confidence_tier: adaptiveConfTierRaw,
            adaptive_confidence_score: adaptiveConfScore,
            entry_evidence_score: entryEvidenceScore,
            candidate_strength: first.candidateStrength ?? null,
            entry_quality_grade: authority.entryQualityGrade ?? null
          });
        }
      }

      const finalBlockedReasonBeforeV2Finalizer = finalBlockedReason;
      const finalAuthorizedBeforeV2Finalizer = finalBlockedReasonBeforeV2Finalizer === null;

      // [UNIFIED V2 FINALIZER & PROOF CHAIN]
      let hardBlockPresent = false;
      let hardBlockReason: string | null = null;
      const softBlockWarnings: string[] = [];
      const v2AuthorityCandidate =
        authority.source === "v2" &&
        adoptedEngine === "V2";
      const v2FinalAuthorizationApplied = v2AuthorityCandidate && authorityDecisionForExecution === "ENTER";

      const activeEngineRoutingForFinalizer = this.lastMarketMode?.routing.activeEngine ?? null;
      const stage1ExecutionEngineForFinalizer = stage1ExecutionEngine;
      const authorityStageMarginKrwForFinalizer = authority.stageMarginKrw ?? 0;

      const hardReasons = new Set<string>([
        "SERVER_TRADE_DISABLED", "CLOSE_ONLY_MODE", "KILL_SWITCH", "RECONCILE_SAFE_MODE",
        "RISK_MODE_HALT", "DAILY_LOSS_GUARD", "MAX_SLOTS_REACHED", "MIN_ORDER_SIZE_UNDERFLOW",
        "ORDER_BUILD_FAIL", "RISK_EXPOSURE_CAP_PRE_SUBMIT", "CRASH_ENTRY_GUARD_BLOCK",
        "SYMBOL_OPPOSITE_POSITION_OPEN", "SYMBOL_SAME_SIDE_POSITION_ALREADY_OPEN",
        "AUTHORITY_SIDE_INVALID", "FRESH_TICK_EXECUTION_BLOCKED", "SIGNED_EXECUTION_NOT_READY"
      ]);
      const softReasons = new Set<string>([
        "WAIT_RECHECK",
        "ENTRY_EVIDENCE_RECHECK_WEAK_CANDIDATE",
        "SIDE_NOT_ALLOWED_LONG",
        "SIDE_NOT_ALLOWED_SHORT",
        "RISK_LONG_DISALLOWED",
        "RISK_SHORT_DISALLOWED",
        "ENTRY_QUALITY_CONTAMINATED_SIMILAR",
        "ENTRY_QUALITY_CONFLICT_BLOCK",
        "ADAPTIVE_RESULT_NULL",
        "AI_POLICY_BLOCKED",
        "POLICY_PAUSED_OR_FORBIDDEN"
      ]);

      const localSnapshot = {
        ...executionSnapshot,
        freshTickBlocked: authority.hardBlockReason === "FRESH_TICK_EXECUTION_BLOCKED"
      };

      // 1. V2_FINAL_AUTHORIZATION_PROOF (System Level)
      if (v2AuthorityCandidate) {
        let systemHardBlock: string | null = null;
        if (!localSnapshot.tradeEnabled) systemHardBlock = "SERVER_TRADE_DISABLED";
        else if (localSnapshot.killSwitch) systemHardBlock = "KILL_SWITCH";
        else if (localSnapshot.closeOnly) systemHardBlock = "CLOSE_ONLY_MODE";
        else if (localSnapshot.reconcileSafe) systemHardBlock = "RECONCILE_SAFE_MODE";
        else if (!localSnapshot.paperReady) systemHardBlock = "PAPER_EXECUTION_NOT_READY";
        else if (!localSnapshot.signedReady) systemHardBlock = "SIGNED_EXECUTION_NOT_READY";
        else if (localSnapshot.riskModeHalt) systemHardBlock = "RISK_MODE_HALT";
        else if (localSnapshot.dailyLossGuard) systemHardBlock = "DAILY_LOSS_GUARD";
        else if (localSnapshot.freshTickBlocked) systemHardBlock = "FRESH_TICK_EXECUTION_BLOCKED";

        this.logger.info("V2_FINAL_AUTHORIZATION_PROOF", {
          symbol: sym,
          run_cycle_id: this.runCycleId,
          decision_id: (authority as any).decision_id ?? null,
          system_ready: systemHardBlock == null,
          hard_block_reason: systemHardBlock,
          paper_execution_ready: localSnapshot.paperReady,
          signed_execution_ready: localSnapshot.signedReady,
          envelope_hard_block_reason: authority.hardBlockReason ?? null,
          ...buildAuthorityEventMeta(authority)
        });
        if (systemHardBlock) {
          hardBlockPresent = true;
          hardBlockReason = systemHardBlock;
        }
      }

      // 2. Mutex Evaluation & SYMBOL_POSITION_MUTEX_PROOF
      const authoritySideLower = normalizePositionSideLower(authority.side);
      const authoritySideInvalidForEnter = authorityDecisionForExecution === "ENTER" && authoritySideLower == null;
      
      const mutexEvaluated = !authoritySideInvalidForEnter && !hardBlockPresent;
      const mutexSkippedReason = hardBlockPresent ? "PRIOR_HARD_BLOCK" : (authoritySideInvalidForEnter ? "AUTHORITY_SIDE_INVALID" : null);
      
      const mutexEval = mutexEvaluated
        ? this.positions.evaluateSymbolPositionMutex(sym, authoritySideLower as "long" | "short", next, existingIdx >= 0, authority.addOnAllowed === true)
        : { blocked: false, blockReason: null as any, sameSymbolOpenCount: 0, existingSides: [], existingPositionIds: [] };

      if (v2AuthorityCandidate) {
        this.logger.info("SYMBOL_POSITION_MUTEX_PROOF", {
          symbol: sym,
          run_cycle_id: this.runCycleId,
          decision_id: (authority as any).decision_id ?? null,
          requested_side: authoritySideLower ?? authority.side,
          mutex_evaluated: mutexEvaluated,
          mutex_skipped_reason: mutexSkippedReason,
          mutex_allowed: mutexEvaluated ? !mutexEval.blocked : null,
          mutex_block_reason: mutexEval.blockReason,
          pending_confirm_present: next.some(p => p.symbol === sym && p.lifecycleState === "PENDING_EXCHANGE_CONFIRM"),
          ...buildAuthorityEventMeta(authority)
        });
        if (!hardBlockPresent && mutexEval.blocked) {
          hardBlockPresent = true;
          hardBlockReason = mutexEval.blockReason;
        }
        if (!hardBlockPresent && authoritySideInvalidForEnter) {
          hardBlockPresent = true;
          hardBlockReason = "AUTHORITY_SIDE_INVALID";
        }
      }

      // 3. V2_FINAL_MIN_ORDER_CHECK_PROOF
      const marginUsdt = (authority.stageMarginKrw ?? 0) / PAPER_LEDGER_KRW_NOTIONAL_PER_USD;
      const appliedLev = authority.appliedLeverage ?? (authority.source === "v2" ? 10 : 1);
      const computedNotionalUsdt = marginUsdt * appliedLev;
      
      let minReqNotional = MIN_POSITION_SIZE_USD;
      let minOrderUnderflow = false;
      let minOrderBlockReason: string | null = null;
      if (authority.source === "v2") {
        const currentPrice = first?.lastPrice ?? 0;
        const instId = sym.replace("USDT", "-USDT-SWAP");
        const inst = this.instrumentCache.get(instId);
        if (!inst || currentPrice <= 0) {
          // Fail-Closed: instrument 또는 가격 미준비 시 최소 명목 추정 금지
          minOrderUnderflow = true;
          minOrderBlockReason = "OKX_INSTRUMENT_SIZING_NOT_READY";
        } else {
          // Linear USDT SWAP 기준: lotSz 반영한 실제 최소 계약 수
          const minContracts = Math.ceil(inst.minSz / inst.lotSz - 1e-12) * inst.lotSz;
          minReqNotional = minContracts * inst.ctVal * currentPrice;
          if ((authority.stageMarginKrw ?? 0) > 0 && computedNotionalUsdt < minReqNotional) minOrderUnderflow = true;
        }
      } else if ((authority.stageMarginKrw ?? 0) > 0 && marginUsdt < MIN_POSITION_SIZE_USD) {
        minOrderUnderflow = true;
      }
      const minOrderOk = !minOrderUnderflow;

      if (v2AuthorityCandidate) {
        this.logger.info("V2_FINAL_MIN_ORDER_CHECK_PROOF", {
          symbol: sym,
          run_cycle_id: this.runCycleId,
          decision_id: (authority as any).decision_id ?? null,
          authority_size_usdt: marginUsdt,
          applied_leverage: appliedLev,
          computed_order_notional_usdt: computedNotionalUsdt,
          min_required_notional_usdt: minReqNotional,
          min_order_ok: minOrderOk,
          min_order_underflow: minOrderUnderflow,
          min_order_block_reason: minOrderBlockReason ?? null,
          ...buildAuthorityEventMeta(authority)
        });
      }
      if (!hardBlockPresent && !minOrderOk) {
        hardBlockPresent = true;
        hardBlockReason = minOrderBlockReason ?? "MIN_ORDER_SIZE_UNDERFLOW";
      }

      // Final Readiness & Taxonomy Consolidation
      if (!hardBlockPresent) {
        if (isNewEntry && next.length >= max) {
          hardBlockReason = "MAX_SLOTS_REACHED";
        } else if (res.decision.reject_reason === "ORDER_BUILD_FAIL") {
          hardBlockReason = "ORDER_BUILD_FAIL";
        } else if (finalBlockedReason != null && hardReasons.has(finalBlockedReason)) {
          hardBlockReason = finalBlockedReason;
        }
        if (hardBlockReason) hardBlockPresent = true;
      }

      if (hardBlockPresent) {
        finalBlockedReason = hardBlockReason;
      } else {
        if (finalBlockedReason != null) {
          if (softReasons.has(finalBlockedReason)) {
            softBlockWarnings.push(finalBlockedReason);
          } else {
            softBlockWarnings.push(`LEGACY_SOFT_GATE:${finalBlockedReason}`);
          }
          // V2 Authoritative ENTER: Clear any legacy non-hard blocks
          if (v2AuthorityCandidate && authorityDecisionForExecution === "ENTER") {
            finalBlockedReason = null;
          }
        }
      }

      const finalBlockedReasonAfterV2Finalizer = finalBlockedReason;
      const finalAuthorizedAfterV2Finalizer = finalBlockedReasonAfterV2Finalizer === null;

      const nonBypassableHardBlockPresent = authority.nonBypassableHardBlockPresent === true;
      const orderBuildReady = res.decision.reject_reason !== "ORDER_BUILD_FAIL";
      const validSideGate = validSide && !authoritySideInvalidForEnter;

      const finalEntryAuthorization = 
        authorityDecisionForExecution === "ENTER" &&
        hardBlockPresent === false &&
        nonBypassableHardBlockPresent === false &&
        finalBlockedReason === null &&
        validSideGate === true &&
        orderBuildReady === true &&
        !mutexEval.blocked &&
        minOrderOk === true &&
        localSnapshot.paperReady === true &&
        localSnapshot.signedReady === true &&
        localSnapshot.tradeEnabled === true &&
        localSnapshot.closeOnly === false &&
        localSnapshot.killSwitch === false &&
        localSnapshot.reconcileSafe === false &&
        localSnapshot.freshTickBlocked === false;

      if (v2AuthorityCandidate) {
        const skip_reason = finalEntryAuthorization ? "NONE" : (hardBlockReason || finalBlockedReason || "AUTHORITY_PIPELINE_BLOCKED");
        this.logger.info("V2_QUEUE_CONSUME_PROOF", {
          symbol: sym,
          signal: first.signal,
          authoritySource: first.authoritySource,
          authority_decision: authority.decision,
          authority_side: authority.side,
          stage_margin_krw: authority.stageMarginKrw ?? 0,
          v2AuthorityCandidate,
          authorityDecisionForExecution,
          finalEntryAuthorization,
          skip_reason,
          source_v2: authority.source === "v2",
          engine_v2: adoptedEngine === "V2",
          decision_enter: authorityDecisionForExecution === "ENTER",
          signed_ready: executionSnapshot.signedReady,
          paper_ready: executionSnapshot.paperReady,
          trade_enabled: executionSnapshot.tradeEnabled,
          close_only: executionSnapshot.closeOnly,
          kill_switch: executionSnapshot.killSwitch,
          daily_loss: executionSnapshot.dailyLossGuard,
          risk_halt: executionSnapshot.riskModeHalt,
          mutex_allowed: !mutexEval.blocked
        });
      }

      const positionOpenAttempted = finalEntryAuthorization && authorityDecisionForExecution === "ENTER";

      // 4. V2_POST_BRIDGE_EXECUTION_HANDOFF_PROOF
      if (v2AuthorityCandidate) {
        const handoffSkipReason = finalEntryAuthorization ? "NONE" : (hardBlockReason || finalBlockedReason || "AUTHORITY_PIPELINE_BLOCKED");
        this.logger.info("V2_POST_BRIDGE_EXECUTION_HANDOFF_PROOF", {
          symbol: sym,
          run_cycle_id: executionSnapshot.runCycleId,
          decision_id: (authority as any).decision_id ?? null,
          order_path_allowed: finalEntryAuthorization,
          skip_reason: handoffSkipReason,
          legacy_range_reject_ignored_for_v2: legacyRangeRejectIgnoredForV2,
          ...buildAuthorityEventMeta(authority)
        });
      }

      // 5. V2_FINAL_EXECUTION_DECISION_PROOF
      if (v2AuthorityCandidate) {
        this.logger.info("V2_FINAL_EXECUTION_DECISION_PROOF", {
          symbol: sym,
          run_cycle_id: this.runCycleId,
          decision_id: (authority as any).decision_id ?? null,
          authority_source: authority.source,
          final_authorized: finalEntryAuthorization,
          hard_block_reason: hardBlockReason,
          final_blocked_reason: finalBlockedReason,
          order_path_called: positionOpenAttempted,
          ...buildAuthorityEventMeta(authority)
        });
      }

      if (v2FinalAuthorizationApplied) {
        // V2_ENTER_EXECUTION_BRIDGE_PROOF now correctly represents the gate pass just before submission.
        // If it's skipped after this, a subsequent skip_reason log will be issued.
      }
      this.logger.info("STAGE1_ENTER_DECIDED", {
        symbol: sym,
        regime: (this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane),
        executor: stage1ExecutorLabel,
        final_authorized: finalEntryAuthorization,
        final_blocked_reason: finalBlockedReason,
        v2_final_authorization_applied: v2FinalAuthorizationApplied,
        hard_block_present: hardBlockPresent,
        hard_block_reason: hardBlockReason,
        soft_block_warnings: softBlockWarnings,
        final_authorized_before_v2_finalizer: finalAuthorizedBeforeV2Finalizer,
        final_authorized_after_v2_finalizer: finalAuthorizedAfterV2Finalizer,
        final_blocked_reason_before_v2_finalizer: finalBlockedReasonBeforeV2Finalizer,
        final_blocked_reason_after_v2_finalizer: finalBlockedReasonAfterV2Finalizer,
        authority_source: authority.source,
        authority_side: authority.side,
        authority_size_krw: authorityStageMarginKrwForFinalizer,
        authority_size_usdt: authorityStageMarginKrwForFinalizer / 1400,
        active_engine_routing: activeEngineRoutingForFinalizer,
        stage1_execution_engine: stage1ExecutionEngineForFinalizer,
        ai_approved: aiExecutionApproved,
        policy_paused: policyPaused,
        allow_long: allowLongGuard,
        allow_short: allowShortGuard,
        is_scale_in: existingIdx >= 0,
        serverTradeEnabled: this.serverTradeControlState.server_trade_enabled,
        closeOnlyMode: this.serverTradeControlState.close_only_mode,
        killSwitch: this.serverTradeControlState.kill_switch_active,
        reconcileSafeMode: this.reconcileSafetyCloseOnly,
        ...buildAuthorityEventMeta(authority)
      });
      if (positionOpenAttempted) {
        this.logger.info("STAGE1_POSITION_OPEN_ATTEMPT", {
          symbol: sym,
          side: authority.side,
          authority_source: authority.source,
          adopted_engine: adoptedEngine,
          v2_decision: authorityDecisionForExecution,
          hard_block_present: hardBlockPresent,
          hard_block_reason: hardBlockReason,
          soft_block_warnings: softBlockWarnings
        });
      }
      if (finalBlockedReason === "CRASH_ENTRY_GUARD_BLOCK") {
        this.logger.warn("CRASH_ENTRY_GUARD_BLOCK", {
          symbol: sym,
          crash_state: crashState,
          crash_lock_until: crashLockUntil,
          crash_guard_regime_aware_released: crashGuardRegimeAwareReleased,
          crash_lock_expired_or_soon: crashLockExpiredOrSoon,
          final_decision: "SKIP",
          reject_reason: finalBlockedReason,
          authority_owner: authority.source,
          active_engine_routing: this.lastMarketMode?.routing.activeEngine ?? null,
          note: "CRASH_REDUCE no longer blocks entry ??only CRASH_EXIT/LOCK when regime still in shock"
        });
      }
      if (finalBlockedReason === "NGE_STAGE0_UPPER_LONG_BLOCK") {
        this.logger.warn("NGE_STAGE0_UPPER_LONG_BLOCK", {
          symbol: sym,
          zone,
          range_stage0_engine_taken: res.decision.range_stage0_engine_taken ?? false,
          final_decision: "SKIP",
          reject_reason: finalBlockedReason,
          authority_owner: authority.source,
          active_engine_routing: this.lastMarketMode?.routing.activeEngine ?? null
        });
      }

      if (!finalEntryAuthorization) {
        this.logger.info("ENTRY_EVIDENCE_RECHECK", {
          symbol: first.symbol,
          side: authority.side,
          blocked_reason: finalBlockedReason,
          entry_evidence_score: entryEvidenceScore,
          entry_evidence_reason: entryEvidenceReason,
          authority_source: authority.source,
          adopted_engine: adoptedEngine
        });
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

        // V2_NO_ENTRY_REASON_AUDIT_PROOF removed from here and moved to runOnce for global coverage

        await this.emitPipelineEventsFromDecision(first, refinedEnvelope, Date.now(), entryStage, finalBlockedReason);
        continue;
      }
      this.logger.info("ENTRY_EVIDENCE_ACCEPTED", {
        symbol: first.symbol,
        side: authority.side,
        entry_evidence_score: entryEvidenceScore,
        entry_evidence_reason: entryEvidenceReason,
        authority_source: authority.source,
        adopted_engine: adoptedEngine
      });

      const levScaled = Math.max(
        1,
        Math.round(this.config.leverage * adaptive.leverageMultiplier * 100) / 100
      );
      const liveRegimeForEntryIdentity = (this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane) as PaperRegimeState;
      const entryIdentity = this.resolveEntryIdentity(authority, decision, liveRegimeForEntryIdentity);

      let entrySizeUsd = adaptive.sizeUsd;
      if (authority.source !== "v2") {
        entrySizeUsd = Math.max(MIN_POSITION_SIZE_USD, Math.round(entrySizeUsd * entryQualitySizeMultiplier * 100) / 100);
      } else {
        entrySizeUsd = Math.max(MIN_POSITION_SIZE_USD, Math.round(entrySizeUsd * 100) / 100);
      }

      const riskE = this.lastRiskExposure;

      // --- [GUARD-1] V2: committed risk plan (no mirror) before any OKX entry / queue consume ---
      if (authority.source === "v2" && authorityDecisionForExecution === "ENTER") {
        const rp = buildV2PreEntryRiskPlanCommitted(authority, res.decision, intentSide, first.lastPrice, this.logger, sym);
        if (!rp.ok) {
          this.logger.error("V2_ENTRY_BLOCKED_PROTECTION_PLAN_MISSING", {
            symbol: sym,
            run_cycle_id: executionSnapshot.runCycleId,
            decision_id: (authority as any).decision_id ?? null,
            intent_side: intentSide,
            reference_entry_px: first.lastPrice,
            reason: (rp as any).reason || "STOP_PRICE_REQUIRED_BEFORE_ENTRY",
            invalidation_px: authority.invalidationPx ?? null,
            authority_stop_price: authority.stopPrice ?? null,
            new_stop_price: authority.newStopPrice ?? null,
            decision_stop_loss: typeof res.decision.stopLoss === "number" ? res.decision.stopLoss : null
          });
          continue;
        }
        v2CommittedRiskPlan = rp.plan;
        this.logger.info("V2_ENTRY_RISK_PLAN_PROOF", {
          symbol: sym,
          run_cycle_id: executionSnapshot.runCycleId,
          decision_id: (authority as any).decision_id ?? null,
          ...rp.plan
        });

        const auditSide = authority.side;
        const auditNotional = entrySizeUsd;
        const auditStopOk = isCommittedEntryStopPrice(rp.plan.stop_price);
        const auditNotionalOk = typeof auditNotional === "number" && auditNotional > 0;
        const auditSideOk = auditSide === "long" || auditSide === "short";
        const auditReadyOk = executionSnapshot.paperReady === true && executionSnapshot.signedReady === true;
        const auditFail = !auditSideOk || !auditNotionalOk || !auditReadyOk || !auditStopOk;

        this.logger.info("V2_ENTRY_ORDER_BUILD_AUDIT_PROOF", {
          symbol: sym,
          side: auditSide,
          order_notional_usdt: auditNotional,
          stop_price_present: auditStopOk,
          committed_stop_price: rp.plan.stop_price,
          stop_source: rp.plan.stop_source,
          initial_tp_price: rp.plan.initial_tp_price,
          invalidation_px: authority.invalidationPx ?? null,
          paper_execution_ready: executionSnapshot.paperReady,
          signed_execution_ready: executionSnapshot.signedReady,
          side_ok: auditSideOk,
          notional_ok: auditNotionalOk,
          stop_ok: auditStopOk,
          readiness_ok: auditReadyOk,
          authority_source: authority.source,
          market_subtype: effectiveMarketSubtype || null,
          regime: authority.regime ?? null,
          macro_source: envelope.v2_execution_envelope?.macro_source ?? null,
          daily_bias_actual: envelope.v2_execution_envelope?.daily_bias_actual ?? null,
          h4_bias_actual: envelope.v2_execution_envelope?.h4_bias_actual ?? null
        });

        if (auditFail) {
          const auditFailReason =
            !auditSideOk ? "INVALID_SIDE" :
            !auditNotionalOk ? "NOTIONAL_ZERO_OR_NEGATIVE" :
            !auditStopOk ? "STOP_PRICE_MISSING" :
            "READINESS_NOT_MET";
          this.logger.warn("V2_ENTRY_TO_FILL_AUDIT_FAIL_HARD_BLOCK", {
            symbol: sym,
            side: auditSide,
            order_notional_usdt: auditNotional,
            fail_reason: auditFailReason,
            invalidation_px: authority.invalidationPx ?? null,
            committed_stop_price: rp.plan.stop_price,
            stop_price_present: auditStopOk,
            paper_execution_ready: executionSnapshot.paperReady,
            signed_execution_ready: executionSnapshot.signedReady
          });
          continue;
        }

        this.logger.info("V2_ENTRY_TO_FILL_AUDIT_PROOF", {
          symbol: sym,
          side: auditSide,
          order_notional_usdt: auditNotional,
          stop_present: auditStopOk,
          paper_execution_ready: executionSnapshot.paperReady,
          signed_execution_ready: executionSnapshot.signedReady,
          audit_passed: true,
          market_subtype: effectiveMarketSubtype || null
        });
      }

      // --- V2 AUTHORITATIVE EXECUTION FAST-PATH ---
      if (v2AuthorityCandidate && authorityDecisionForExecution === "ENTER") {
        // 0. V2_ENTER_EXECUTION_BRIDGE_PROOF (Mandatory visibility for all authoritative ENTER signals)
        this.logger.info("V2_ENTER_EXECUTION_BRIDGE_PROOF", {
          symbol: sym,
          decision: authorityDecisionForExecution,
          side: authority.side,
          stage_margin_krw: authority.stageMarginKrw ?? 0,
          exposure_notional_krw: authority.exposureNotionalKrw ?? 0,
          size_usdt: entrySizeUsd,
          paper_execution_ready: executionSnapshot.paperReady,
          signed_execution_ready: executionSnapshot.signedReady,
          run_cycle_id: executionSnapshot.runCycleId,
          final_authorized: finalEntryAuthorization
        });

        if (!finalEntryAuthorization) {
          const skip_reason = hardBlockReason || finalBlockedReason || "AUTHORITY_PIPELINE_BLOCKED";
          this.logger.warn("V2_EXECUTION_FAST_PATH_SKIPPED", { symbol: sym, skip_reason });
          continue;
        }

        // 1. Slot Check (Hard Block)
        if (next.length >= max) {
          const skip_reason = "V2_EXECUTION_BLOCKED_MAX_SLOTS";
          this.logger.info("V2_EXECUTION_BLOCKED_MAX_SLOTS", { symbol: sym, count: next.length, max });
          this.logger.info("V2_POST_BRIDGE_EXECUTION_HANDOFF_PROOF", {
            symbol: sym,
            run_cycle_id: executionSnapshot.runCycleId,
            decision_id: (authority as any).decision_id ?? null,
            order_path_allowed: false,
            skip_reason,
            ...buildAuthorityEventMeta(authority)
          });
          continue;
        }

        // 2. Execution Key (Race Protection)
        const v2EntryKey = `v2entry:${sym}:${intentSide}:${executionSnapshot.runCycleId}`;
        const v2KeyOk = await this.consumeExecutionKey(v2EntryKey);
        if (!v2KeyOk) {
          const skip_reason = "V2_EXECUTION_DUPLICATE_KEY_BLOCKED";
          this.logger.warn("V2_EXECUTION_DUPLICATE_KEY_BLOCKED", { symbol: sym, key: v2EntryKey });
          this.logger.info("V2_POST_BRIDGE_EXECUTION_HANDOFF_PROOF", {
            symbol: sym,
            run_cycle_id: executionSnapshot.runCycleId,
            decision_id: (authority as any).decision_id ?? null,
            order_path_allowed: false,
            skip_reason,
            ...buildAuthorityEventMeta(authority)
          });
          continue;
        }

        // 3. Mutex Re-check (Pre-persist Safety)
        const latestPositions = await this.positions.loadOpenAll();
        const v2Mutex = this.positions.evaluateSymbolPositionMutex(sym, intentSide, latestPositions, false, authority.addOnAllowed === true);
        if (v2Mutex.blocked) {
          const skip_reason = "V2_EXECUTION_MUTEX_FINAL_BLOCKED";
          this.logger.warn("V2_EXECUTION_MUTEX_FINAL_BLOCKED", { symbol: sym, side: intentSide, reason: v2Mutex.blockReason });
          this.logger.info("V2_POST_BRIDGE_EXECUTION_HANDOFF_PROOF", {
            symbol: sym,
            run_cycle_id: executionSnapshot.runCycleId,
            decision_id: (authority as any).decision_id ?? null,
            order_path_allowed: false,
            skip_reason,
            ...buildAuthorityEventMeta(authority)
          });
          continue;
        }

        // 4. Sizing (Respect V2 Authority - Prioritize Notional)
        const marginUsdt = (authority.stageMarginKrw ?? 0) / PAPER_LEDGER_KRW_NOTIONAL_PER_USD;
        const authorityNotionalUsdt =
          typeof authority.exposureNotionalKrw === "number" && authority.exposureNotionalKrw > 0
            ? authority.exposureNotionalKrw / PAPER_LEDGER_KRW_NOTIONAL_PER_USD
            : marginUsdt * (authority.appliedLeverage ?? 10);

        const liveMaxOrderNotionalUsdt =
          typeof this.config.okxLiveMaxOrderNotionalUsdt === "number" && this.config.okxLiveMaxOrderNotionalUsdt > 0
            ? this.config.okxLiveMaxOrderNotionalUsdt
            : authorityNotionalUsdt;

        const v2OrderNotionalUsdt = Math.min(authorityNotionalUsdt, liveMaxOrderNotionalUsdt);
        let v2EntrySizeUsd = v2OrderNotionalUsdt;
        const symS = String(first.symbol);
        const mPreV2 = marginsForSymbol(next, symS);
        if (riskE) {
          const cap = authority.side === "long" ? riskE.maxLongExposure : riskE.maxShortExposure;
          const currentUsd = authority.side === "long" ? mPreV2.longUsd : mPreV2.shortUsd;
          if (currentUsd + v2EntrySizeUsd > cap) {
            v2EntrySizeUsd = Math.max(0, cap - currentUsd);
            if (v2EntrySizeUsd < MIN_POSITION_SIZE_USD) {
              const skip_reason = "V2_EXECUTION_EXPOSURE_CAP_BLOCKED";
              this.logger.warn("V2_EXECUTION_EXPOSURE_CAP_BLOCKED", { symbol: sym, cap, currentUsd, intended: entrySizeUsd });
              this.logger.info("V2_POST_BRIDGE_EXECUTION_HANDOFF_PROOF", {
                symbol: sym,
                run_cycle_id: executionSnapshot.runCycleId,
                decision_id: (authority as any).decision_id ?? null,
                order_path_allowed: false,
                skip_reason,
                ...buildAuthorityEventMeta(authority)
              });
              continue;
            }
          }
        }

        // 5. Execution Handoff
        const openTraceId = randomUUID();
        const signedMode = this.signedSubmitMode();

        // Mandatory Diagnostic Proof Chain for V2 Candidates reaching the bridge
        this.logger.info("V2_POST_BRIDGE_EXECUTION_HANDOFF_PROOF", {
          symbol: sym,
          run_cycle_id: executionSnapshot.runCycleId,
          decision_id: (authority as any).decision_id ?? null,
          order_path_allowed: true,
          skip_reason: null,
          ...buildAuthorityEventMeta(authority)
        });

        this.logger.info("V2_FINAL_EXECUTION_DECISION_PROOF", {
          symbol: sym,
          run_cycle_id: executionSnapshot.runCycleId,
          decision_id: (authority as any).decision_id ?? null,
          decision: "EXECUTE",
          notional_usdt: v2EntrySizeUsd,
          ...buildAuthorityEventMeta(authority)
        });

        this.logger.info("STAGE1_POSITION_OPEN_ATTEMPT", {
          open_trace_id: openTraceId,
          symbol: sym,
          side: authority.side,
          sizeUsd: v2EntrySizeUsd,
          authority_source: authority.source,
          v2_fast_path: true
        });

        if (this.okxDemo && signedMode === "enabled") {
          const side = authority.side === "long" ? "buy" : "sell";
          const posSide = authority.side === "long" ? "long" : "short";
          const qtyLegacyEst = Math.max(0.001, v2EntrySizeUsd / Math.max(1e-9, first.lastPrice));
          const clOrdId = buildOkxClOrdId(sym, side);

          // --- [GUARD-2] Market Chase Guard: first-candle shock/breakdown ??WAIT_RECHECK ---
          const chaseBlockSubtypes = new Set([
            "VOLUME_BREAKDOWN_OBSERVATION",
            "VOLUME_SHOCK_DOWN",
            "VOLUME_BREAKOUT_OBSERVATION",
            "VOLUME_SHOCK_UP",
            "BREAKOUT_OBSERVATION"
          ]);
          const retestReadySubtypes = new Set([
            "BREAKDOWN_RETEST_FAILED",
            "BREAKOUT_RETEST_CONFIRMED_VOLUME",
            "BREAKOUT_RETEST_CONFIRMED"
          ]);
          const currentSubtype = effectiveMarketSubtype;
          const isChaseBlock = chaseBlockSubtypes.has(currentSubtype);
          const isRetestReady = retestReadySubtypes.has(currentSubtype);

          if (isChaseBlock && !isRetestReady) {
            this.logger.info("V2_MARKET_CHASE_BLOCKED_RETEST_REQUIRED_PROOF", {
              symbol: sym,
              side: authority.side,
              market_subtype: currentSubtype,
              action: "WAIT_RECHECK",
              reason: "first_candle_shock_or_breakdown_no_retest_confirmation",
              retest_required: true
            });
            this.logger.info("V2_RETEST_REQUIRED_NO_MARKET_ORDER_PROOF", {
              symbol: sym,
              side: authority.side,
              market_subtype: currentSubtype,
              blocked_decision: "ENTER",
              required_subtypes_for_entry: [...retestReadySubtypes]
            });
            continue;
          }

          if (isRetestReady) {
            if (currentSubtype === "BREAKDOWN_RETEST_FAILED") {
              this.logger.info("V2_BREAKDOWN_RETEST_SHORT_READY_PROOF", {
                symbol: sym,
                side: authority.side,
                market_subtype: currentSubtype,
                chase_guard_passed: true
              });
            } else {
              this.logger.info("V2_BREAKOUT_RETEST_LONG_READY_PROOF", {
                symbol: sym,
                side: authority.side,
                market_subtype: currentSubtype,
                chase_guard_passed: true
              });
            }
          }

          // --- [GUARD-3] Macro Bias Risk Filter ---
          // Daily/H4 bias proxy via marketSubtype + regime (no direct D/H4 candle ingestion yet)
          // 1D/4H??confidence/sizeMultiplier/counterTrendRisk 議곗젙留? ENTER 吏곸옒 ?앹꽦 湲덉?.
          const macroUpSubtypes = new Set([
            "VOLUME_BREAKOUT_OBSERVATION",
            "VOLUME_SHOCK_UP",
            "BREAKOUT_RETEST_CONFIRMED_VOLUME",
            "BREAKOUT_RETEST_CONFIRMED",
            "ASCENDING_CHANNEL"
          ]);
          const macroDownSubtypes = new Set([
            "VOLUME_BREAKDOWN_OBSERVATION",
            "VOLUME_SHOCK_DOWN",
            "BREAKDOWN_RETEST_FAILED",
            "DESCENDING_CHANNEL"
          ]);
          const macroNeutralSubtypes = new Set([
            "RANGE_FLAT", "RANGE_MID_CHOP", "RANGE_LOWER_REACTION", "RANGE_UPPER_REACTION",
            "RANGE_DRIFT_DOWN", "RANGE_DRIFT_UP", "DRIFT_REVERSAL_UP_WATCH", "DRIFT_REVERSAL_DOWN_WATCH"
          ]);

          type MacroBiasDir = "DAILY_BULLISH" | "DAILY_NEUTRAL_RANGE" | "DAILY_LOWER_HIGH_RISK" | "DAILY_BEARISH";
          const intendedSide = authority.side as "long" | "short";
          let macroBias: MacroBiasDir = "DAILY_NEUTRAL_RANGE";
          let macroCounterTrend = false;
          let macroSizeMultiplier = 1.0;

          if (macroUpSubtypes.has(currentSubtype)) {
            macroBias = "DAILY_BULLISH";
            if (intendedSide === "short") { macroCounterTrend = true; macroSizeMultiplier = 0.6; }
          } else if (macroDownSubtypes.has(currentSubtype)) {
            macroBias = "DAILY_BEARISH";
            if (intendedSide === "long") { macroCounterTrend = true; macroSizeMultiplier = 0.6; }
          } else if (macroNeutralSubtypes.has(currentSubtype)) {
            macroBias = "DAILY_NEUTRAL_RANGE";
          }

          this.logger.info("V2_MACRO_BIAS_PROOF", {
            symbol: sym,
            side: intendedSide,
            market_subtype: currentSubtype,
            macro_bias: macroBias,
            is_counter_trend: macroCounterTrend,
            macro_size_multiplier: macroSizeMultiplier,
            // ?ㅼ젣 1D/H4 罹붾뱾 湲곕컲???꾨땶 marketSubtype proxy?꾩쓣 紐낆떆
            macro_source: "market_subtype_proxy",
            daily_bias_actual: null,
            h4_bias_actual: null,
            note: "macro_bias_is_risk_filter_only_not_enter_generator"
          });

          if (macroCounterTrend) {
            // Validate counter-trend entry requires strong regime confirmation
            const isStrongCounterTrendSignal =
              currentSubtype === "BREAKDOWN_RETEST_FAILED" ||
              currentSubtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME" ||
              currentSubtype === "BREAKOUT_RETEST_CONFIRMED";

            if (!isStrongCounterTrendSignal) {
              this.logger.warn("V2_MACRO_COUNTER_TREND_RISK_PROOF", {
                symbol: sym,
                side: intendedSide,
                macro_bias: macroBias,
                market_subtype: currentSubtype,
                counter_trend_risk: true,
                strong_signal_required: true,
                action: "COUNTER_TREND_WEAK_SIGNAL_BLOCKED"
              });
              this.logger.info("V2_MACRO_DIRECT_ENTER_FORBIDDEN_PROOF", {
                symbol: sym,
                side: intendedSide,
                macro_bias: macroBias,
                detail: "1D_4H_bias_does_not_generate_ENTER_only_filters_weak_counter_trend"
              });
              continue;
            }

            this.logger.warn("V2_MACRO_COUNTER_TREND_CONFIRM_REQUIRED_PROOF", {
              symbol: sym,
              side: intendedSide,
              macro_bias: macroBias,
              market_subtype: currentSubtype,
              counter_trend: true,
              strong_signal_confirmed: true,
              size_multiplier: macroSizeMultiplier
            });

            // Apply size reduction for confirmed but risky counter-trend entries
            v2EntrySizeUsd = Math.max(
              MIN_POSITION_SIZE_USD,
              Math.round(v2EntrySizeUsd * macroSizeMultiplier * 100) / 100
            );
            this.logger.warn("V2_MACRO_COUNTER_TREND_SIZE_REDUCED_PROOF", {
              symbol: sym,
              side: intendedSide,
              original_size_usd: v2OrderNotionalUsdt,
              reduced_size_usd: v2EntrySizeUsd,
              size_multiplier: macroSizeMultiplier,
              macro_bias: macroBias
            });
          }

          if (!v2CommittedRiskPlan) {
            this.logger.error("V2_ENTRY_BLOCKED_PROTECTION_PLAN_MISSING", {
              symbol: sym,
              run_cycle_id: executionSnapshot.runCycleId,
              decision_id: (authority as any).decision_id ?? null,
              reason: "STOP_PRICE_REQUIRED_BEFORE_ENTRY",
              detail: "committed_risk_plan_missing_in_fast_path"
            });
            continue;
          }
          const stopPrice = v2CommittedRiskPlan.stop_price;
          const initialTpForRecord =
            v2CommittedRiskPlan.initial_tp_price != null ? v2CommittedRiskPlan.initial_tp_price : undefined;

          this.logger.info("ORDER_BUILD_PROTECTION_PLAN_PROOF", {
            symbol: sym,
            execution_path: "v2_fast_path",
            open_trace_id: openTraceId,
            ...v2CommittedRiskPlan
          });

          const recoveryInfo = this.v2RecoveryActiveBySymbol.get(sym);
          const maxChaseBps = 12; // 8~15bps range per instruction
          
          let isRecovery = !!(recoveryInfo && recoveryInfo.side === side && (Date.now() - recoveryInfo.ts < 60_000));
          
          if (isRecovery && recoveryInfo) {
              const currentPrice = first.lastPrice;
              const originalPrice = recoveryInfo.originalLimitPrice ?? currentPrice;
              const chaseBps = Math.abs(currentPrice - originalPrice) / originalPrice * 10000;
              
              // Strict Condition Check
              const hasPosition = opens.some(p => p.symbol === sym);
              const signedReady = this.signedExecutionReady === true;
              const protectionBlocked = this.symbolProtectionFailedBlocked.has(sym);
              
              const conditionsPassed = 
                  !hasPosition && 
                  !!stopPrice && 
                  signedReady && 
                  !protectionBlocked && 
                  chaseBps <= maxChaseBps;

              if (!conditionsPassed) {
                  this.logger.warn("MISSED_LIMIT_FILL_RECOVERY_SKIPPED", {
                      symbol: sym,
                      side,
                      chaseBps,
                      maxChaseBps,
                      hasPosition,
                      hasStopPrice: !!stopPrice,
                      signedReady,
                      protectionBlocked,
                      reason: chaseBps > maxChaseBps ? "CHASE_DISTANCE_EXCEEDED" : "STRICT_CONDITION_NOT_MET"
                  });
                  this.v2RecoveryActiveBySymbol.delete(sym);
                  isRecovery = false;
                  continue; 
              }

              this.logger.info("V2_RECOVERY_ENTRY_TRIGGER_PROOF", {
                  symbol: sym,
                  side,
                  reason: "missed_limit_fill_recovery",
                  action: "USE_MARKETABLE_LIMIT_ORDER",
                  missedLimitFillCount: recoveryInfo.missedLimitFillCount,
                  lastEntryIntentSide: recoveryInfo.lastEntryIntentSide,
                  chaseBps
              });
          }

          // Marketable Limit Pricing for Recovery (5bps buffer)
          const recoveryPriceOffset = 0.0005;
          const finalEntryPrice = isRecovery 
              ? (side === "buy" ? first.lastPrice * (1 + recoveryPriceOffset) : first.lastPrice * (1 - recoveryPriceOffset))
              : first.lastPrice;

          const submit = await this.submitOkxOrder({
            symbol: first.symbol,
            side,
            posSide,
            qty: qtyLegacyEst,
            clOrdId,
            traceId: openTraceId,
            ordType: "limit", // Explicit marketable limit
            reason: isRecovery ? "v2_authorized_recovery_path" : "v2_authorized_fast_path",
            authoritySource: authority.source,
            adoptedEngine,
            entryQualityGrade: authority.entryQualityGrade ?? null,
            leverageProfile: authority.leverageProfile ?? null,
            appliedLeverage: authority.appliedLeverage ?? null,
            marketRegime: authority.regime ?? null,
            entryPrice: finalEntryPrice,
            stopPrice,
            takeProfitPrice: initialTpForRecord,
            paperExecutionReady: executionSnapshot.paperReady,
            stageMarginKrw: authority.stageMarginKrw ?? null,
            exposureNotionalKrw: authority.exposureNotionalKrw ?? null,
            isNewEntry: true,
            orderNotionalUsdt: v2EntrySizeUsd
          });

          if (isRecovery) {
              this.logger.info("V2_ENTRY_RECOVERY_ORDER_RESULT_PROOF", {
                  symbol: sym,
                  side,
                  success: submit.ok,
                  ordId: submit.ordId,
                  errorCode: submit.errorCode,
                  ts: Date.now()
              });
              if (submit.ok) this.v2RecoveryActiveBySymbol.delete(sym);
          }

          this.logger.info("V2_ENTER_ORDER_PATH_PROOF", {
            symbol: sym,
            run_cycle_id: this.runCycleId,
            decision_id: (authority as any).decision_id ?? null,
            side,
            posSide,
            req_sz: submit.submittedContractSz ?? null,
            qty_legacy_base_estimate: qtyLegacyEst,
            clOrdId,
            v2_fast_path: true,
            stage_margin_krw: authority.stageMarginKrw ?? 0,
            margin_usdt: marginUsdt,
            applied_leverage: authority.appliedLeverage ?? 10,
            authority_exposure_notional_krw: authority.exposureNotionalKrw ?? 0,
            authority_notional_usdt: authorityNotionalUsdt,
            order_notional_usdt: v2EntrySizeUsd,
            live_max_order_notional_usdt: liveMaxOrderNotionalUsdt,
            min_order_notional_usdt: MIN_POSITION_SIZE_USD,
            notional_ok: v2EntrySizeUsd >= MIN_POSITION_SIZE_USD,
            entry_price: first.lastPrice,
            submit_ok: submit.ok,
            submit_error_code: submit.errorCode,
            submit_error_message: submit.errorMessage
          });

          // [V2_ENTRY_TO_FILL] OKX Fill Status Proof
          this.logger.info("OKX_ORDER_FILL_STATUS_PROOF", {
            symbol: sym,
            side: authority.side,
            ord_id: submit.ordId ?? null,
            submit_ok: submit.ok,
            fill_confirmed: submit.fillConfirmed ?? false,
            fill_px: submit.fillPx ?? null,
            fill_size: submit.fillSize ?? null,
            error_code: submit.errorCode ?? null,
            error_message: submit.errorMessage ?? null,
            order_notional_usdt: v2EntrySizeUsd
          });

          if (submit.ok) {
            const slReg = regimeForSl(authority.regime);
            const isPending = submit.fillConfirmed !== true;
            const fillPxNum =
              submit.fillPx != null && String(submit.fillPx).length > 0 ? Number(submit.fillPx) : NaN;
            const entryPxOpen = Number.isFinite(fillPxNum) && fillPxNum > 0 ? fillPxNum : first.lastPrice;
            const baseQtyOpen =
              typeof submit.baseQty === "number" && Number.isFinite(submit.baseQty) && submit.baseQty > 0
                ? submit.baseQty
                : v2EntrySizeUsd / Math.max(1e-12, entryPxOpen || 1);
            const record: PaperOpenPositionRecord = {
              openedAt: Date.now(),
              symbol: sym,
              side: intentSide,
              entryPrice: entryPxOpen,
              leverage: levScaled,
              sizeUsd: v2EntrySizeUsd,
              initialSizeUsd: v2EntrySizeUsd,
              isV2Authority: true,
              pos: baseQtyOpen,
              baseQty: baseQtyOpen,
              okxContracts: submit.okxContracts,
              notionalUsd:
                typeof submit.notionalUsd === "number" && Number.isFinite(submit.notionalUsd)
                  ? submit.notionalUsd
                  : v2EntrySizeUsd,
              avgPx:
                typeof submit.avgPx === "number" && Number.isFinite(submit.avgPx)
                  ? submit.avgPx
                  : entryPxOpen,
              notional: v2EntrySizeUsd,
              regimeAtEntry: slReg,
              lifecycleState: isPending ? "PENDING_EXCHANGE_CONFIRM" : "OPEN",
              isProtectiveStopRegistered: submit.ok === true,
              isProtectionFailed: submit.ok !== true,
              exchangeOrdId: submit.ordId ?? undefined,
              exchangeClOrdId: clOrdId,
              exchangeFilledSize: submit.fillSize ?? 0,
              entryProtectionUntil: Date.now() + 120_000,
              realizedPnl: 0,
              stopPrice,
              targetPrice1: initialTpForRecord,
              strategyVersion: entryIdentity.effectiveStrategyVersion,
              sourceSignal: entryIdentity.effectiveSourceSignal,
              authoritySourceAtEntry: authority.source,
              authoritySideAtEntry: String(authority.side),
              sourceRunPath: input.candidateRunPath ?? input.filePath ?? input.latestPath ?? "",
              status: "open",
              // V2 RANGE Hardening: Persistent Box Quality & Exit Plan
              rangeBoxHighAtEntry: authority.rangeBoxHighAtEntry,
              rangeBoxLowAtEntry: authority.rangeBoxLowAtEntry,
              rangeBoxMidAtEntry: authority.rangeBoxMidAtEntry,
              rangeBoxQuality: authority.rangeBoxQuality,
              rangeBoxSlope: authority.rangeBoxSlope,
              rangeBoxDistorted: authority.rangeBoxDistorted,
              takeProfitPlan: authority.takeProfitPlan,
              takeProfit1Px: authority.takeProfit1Px,
              takeProfit2Px: authority.takeProfit2Px,
              partialExitRatio: authority.partialExitRatio,
              invalidationPx: stopPrice
            };
            if (isPending) {
              this.logger.info("PAPER_OPEN_BLOCKED_UNFILLED_ORDER_PROOF", { open_trace_id: openTraceId, symbol: sym, side: intentSide, fast_path: true });
              this.logger.info("LIMIT_ENTRY_PENDING_STATE_PROOF", { symbol: sym, side: intentSide, ord_id: submit.ordId });
              
              const pendingReg: import("../models/types").PendingEntryOrderRecord = {
                symbol: sym,
                side: intentSide,
                ordId: String(submit.ordId),
                clOrdId: submit.clOrdId ?? "",
                instId: toOkxSwapInstId(sym as MarketSymbol),
                authority_source: authority.source,
                intended_notional_usdt: v2EntrySizeUsd,
                stopPrice,
                createdAt: Date.now(),
                status: "ENTRY_ORDER_PENDING",
                paperRecordSnapshot: record,
                authoritySnapshot: authority,
                openTraceId: openTraceId
              };
              const currentPending = await this.store.readPendingEntryOrders();
              const existingIdx = currentPending.findIndex(p => p.ordId === pendingReg.ordId || (p.clOrdId === pendingReg.clOrdId && p.clOrdId !== "") || (p.symbol === pendingReg.symbol && p.side === pendingReg.side));
              if (existingIdx >= 0) {
                this.logger.info("PENDING_ENTRY_ORDER_UPSERT_PROOF", { symbol: sym, side: intentSide, ord_id: submit.ordId });
                currentPending[existingIdx] = pendingReg;
              } else {
                currentPending.push(pendingReg);
                this.logger.info("PENDING_ENTRY_ORDER_REGISTERED_PROOF", { symbol: sym, side: intentSide, ord_id: submit.ordId });
              }
              await this.store.writePendingEntryOrders(currentPending);
              
              continue;
            }

            if (!isCommittedEntryStopPrice(record.stopPrice)) {
              this.logger.error("PAPER_POSITION_OPEN_BLOCKED_MISSING_STOP", {
                symbol: sym,
                side: intentSide,
                open_trace_id: openTraceId,
                fast_path: true,
                submit_ok: submit.ok,
                fill_confirmed: submit.fillConfirmed ?? false
              });
              if (submit.ok && submit.fillConfirmed === true) {
                this.logger.error("PROTECTION_REPAIR_REQUIRED", {
                  symbol: sym,
                  side: intentSide,
                  detail: "okx_fill_confirmed_without_ledger_committed_stop"
                });
                this.symbolProtectionFailedBlocked.add(sym);
              }
              continue;
            }

            try {
              next.push(record);
              
              // [V2_PROTECTIVE_STOP_AUTO_REGISTRATION]
              const protectRes = await this.ensureProtectiveStopOrder(record, `v2_fast_entry_auto:${record.symbol}:${record.openedAt}`);
              if (protectRes.modified) {
                record.isProtectiveStopRegistered = protectRes.record.isProtectiveStopRegistered;
                record.protectiveStopAlgoId = protectRes.record.protectiveStopAlgoId;
              }
              
              openPositionsChanged = true;
              this.logger.info("LIMIT_ENTRY_FILLED_TO_PAPER_OPEN_PROOF", { symbol: sym, side: intentSide, ord_id: submit.ordId });
              this.logger.info("paper_position_opened", { open_trace_id: openTraceId, symbol: sym, side: intentSide, fast_path: true });
          } catch (err) {
            this.logger.error("PENDING_ENTRY_FILLED_TO_LEDGER_OPEN_FAIL_PROOF", {
              symbol: sym,
              side: intentSide,
              ordId: submit.ordId,
              clOrdId,
              fillPx: submit.fillPx,
              fillSz: submit.fillSize,
              error: String(err)
            });
            // Task 5 & 6: Don't prune or manual-flag. Move to failed-entry-audit.
            await this.store.appendJsonlLine("reports/failed-entry-audit.jsonl", {
              ts: Date.now(),
              symbol: sym,
              side: intentSide,
              ordId: submit.ordId,
              clOrdId,
              fillPx: submit.fillPx,
              fillSz: submit.fillSize,
              error: String(err),
              note: "Filled but failed to initialize in ledger. Stored for operator investigation."
            });
            // Remove from pending to stop retry loops
            const currentPending = await this.store.readPendingEntryOrders();
            const filtered = currentPending.filter(p => p.ordId !== submit.ordId);
            await this.store.writePendingEntryOrders(filtered);
            continue;
          }

            // [V2_ENTRY_TO_FILL] Post-open ledger open proof
            this.logger.info("V2_POST_FILL_LEDGER_OPEN_PROOF", {
              symbol: sym,
              side: intentSide,
              ord_id: submit.ordId ?? null,
              entry_price: record.entryPrice,
              size_usd: record.sizeUsd,
              lifecycle_state: record.lifecycleState,
              stop_price: record.stopPrice ?? null,
              open_trace_id: openTraceId
            });

            // [V2_ENTRY_TO_FILL] Post-fill protective stop audit
            this.logger.info("V2_POST_FILL_PROTECTIVE_STOP_AUDIT_PROOF", {
              symbol: sym,
              side: intentSide,
              reduce_only_protective_found: record.isProtectiveStopRegistered === true,
              protective_stop_algo_id: record.protectiveStopAlgoId ?? null,
              stop_price: record.stopPrice ?? null,
              protective_stop_registration_ok: record.isProtectiveStopRegistered === true
            });

            // [V2_ENTRY_TO_FILL] Post-fill actual position reconcile check
            // posSide ?곗꽑, 遺덉씪移???pos 遺?몃줈 side fallback
            const instIdTarget = toOkxSwapInstId(sym as MarketSymbol);
            let actualPosReconcile: any = null;
            let reconcileMatchMethod: "posSide" | "pos_sign" | "none" = "none";
            if (this.lastLivePositionsPayload && Array.isArray(this.lastLivePositionsPayload)) {
              // 1李? posSide 吏곸젒 留ㅼ묶
              actualPosReconcile = this.lastLivePositionsPayload.find((p: any) =>
                p.instId === instIdTarget &&
                String(p.posSide).toLowerCase() === intentSide
              );
              if (actualPosReconcile) {
                reconcileMatchMethod = "posSide";
              } else {
                // 2李? instId 留ㅼ묶 ??pos 遺?몃줈 side fallback
                const samePosInstId = this.lastLivePositionsPayload.filter((p: any) => p.instId === instIdTarget);
                for (const p of samePosInstId) {
                  const posNum = Number(p.pos);
                  const deducedSide = posNum > 0 ? "long" : posNum < 0 ? "short" : null;
                  if (deducedSide === intentSide) {
                    actualPosReconcile = p;
                    reconcileMatchMethod = "pos_sign";
                    break;
                  }
                }
              }
            }
            const reconcileFound = actualPosReconcile != null;
            this.logger.info("V2_POST_FILL_ACTUAL_POSITION_RECONCILE_PROOF", {
              symbol: sym,
              side: intentSide,
              paper_size_usd: record.sizeUsd,
              actual_pos_found: reconcileFound,
              actual_pos_usd: reconcileFound ? Math.abs(Number(actualPosReconcile.notionalUsd ?? 0)) : null,
              ledger_actual_match: reconcileFound,
              match_method: reconcileMatchMethod,
              note: !reconcileFound ? "actual_position_not_yet_visible_will_reconcile_next_cycle" : "reconciled"
            });

            // Post-fill: block symbol until live reconcile sees actual position (when payload available).
            if (!reconcileFound) {
              this.logger.error("V2_POST_FILL_ACTUAL_POSITION_RECONCILE_FAIL_BLOCK_PROOF", {
                symbol: sym,
                side: intentSide,
                paper_size_usd: record.sizeUsd,
                action: "symbol_level_new_entry_blocked_pending_actual_reconcile",
                reason: "filled_but_actual_position_not_found_in_live_payload"
              });
              this.symbolProtectionFailedBlocked.add(sym);
            }

            if (record.isProtectiveStopRegistered !== true) {
              this.logger.error("V2_POST_FILL_PROTECTIVE_STOP_MISSING_BLOCK_PROOF", {
                symbol: sym,
                side: intentSide,
                stop_price: record.stopPrice ?? null,
                action: "symbol_level_protection_failure_flagged"
              });
              this.symbolProtectionFailedBlocked.add(sym);
            }
            
            await this.store.appendJsonlLine("reports/events.jsonl", buildEntryOpenedEventPayload(sym, authority, record));
          } else {
            this.logger.error("paper_position_open_failed", { symbol: sym, error: submit.errorMessage });
          }
          continue; // End of V2 fast-path
        } else {
          // Closed legacy bypass: If signed mode is disabled, log explicit skip and continue
          const skip_reason = !this.okxDemo ? "OKX_CLIENT_NOT_READY" : "SIGNED_MODE_NOT_ENABLED";
          this.logger.info("V2_POST_BRIDGE_EXECUTION_HANDOFF_PROOF", {
            symbol: sym,
            run_cycle_id: executionSnapshot.runCycleId,
            decision_id: (authority as any).decision_id ?? null,
            order_path_allowed: false,
            skip_reason,
            ...buildAuthorityEventMeta(authority)
          });
          continue;
        }
      }

      // --- LEGACY EXECUTION BRANCHING (Scale-In vs New Entry) ---

      // 3. SCALE-IN BRANCH (final gate passed; max open positions does not apply to scale-in)
      if (existingIdx >= 0) {
        const existingRow = next[existingIdx];
        const pnlPctPreScale =
          intentSide === "long"
            ? (first.lastPrice - existingRow.entryPrice) / Math.max(1e-9, existingRow.entryPrice)
            : (existingRow.entryPrice - first.lastPrice) / Math.max(1e-9, existingRow.entryPrice);
        if (pnlPctPreScale <= 0) {
          this.logger.info("ADDON_PRECHECK_BLOCK_PROOF", {
            symbol: sym,
            side: intentSide,
            pnl_pct: pnlPctPreScale,
            block_reason: "loss_averaging_forbidden",
            add_on_candidate_suppressed: true
          });
          continue;
        }
        const struct = this.evaluateAddOnStructureReinforced(existingRow, first, intentSide);
        if (!struct.ok) {
          this.logger.info("ADDON_PRECHECK_BLOCK_PROOF", {
            symbol: sym,
            side: intentSide,
            pnl_pct: pnlPctPreScale,
            block_reason: struct.reason,
            add_on_candidate_suppressed: true
          });
          continue;
        }
        const targetScaleStage = (existingRow.entryStage ?? 1) + 1;
        const scaleExecutionKey = `scalein:${sym}:${intentSide}:${existingRow.openedAt}:stage${targetScaleStage}`;
        const scaleKeyOk = await this.consumeExecutionKey(scaleExecutionKey);
        if (!scaleKeyOk) continue;
        const scaled = await this.tryPaperPositionScaleIn(existingRow, envelope, first, nowTs, entryQualitySizeMultiplier);
        if (scaled) {
          next[existingIdx] = scaled;
          openPositionsChanged = true;
          // Scale-in: POSITION_SCALE_IN_SUCCESS only ??no ENTRY_OPENED here (initial entry records ENTRY_OPENED).
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

      // 4. Max open positions (new entry only ??single check after final gate, after scale-in branch)
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
      const entryExecutionKey = `entry:${sym}:${intentSide}:${first.fetchedAt}:${this.runCycleId}`;
      const entryKeyOk = await this.consumeExecutionKey(entryExecutionKey);
      if (!entryKeyOk) continue;
      await this.store.appendJsonlLine("reports/events.jsonl", buildEntryAllowedEventPayload(sym, (this.lastEffectiveLane === "IDLE" ? "NO_TRADE" : this.lastEffectiveLane) as MarketRegime, decision, authority));

      const sourceSignal = first.signal;
      let confScore =
        typeof adaptive.detail.confidence_score === "number" && Number.isFinite(adaptive.detail.confidence_score)
          ? adaptive.detail.confidence_score
          : undefined;
      let confTier =
        typeof adaptive.detail.confidence_tier === "string" ? adaptive.detail.confidence_tier : undefined;
      let sizeMult =
        typeof adaptive.detail.size_multiplier === "number" && Number.isFinite(adaptive.detail.size_multiplier)
          ? adaptive.detail.size_multiplier
          : undefined;
      const evidenceClamdown =
        authority.entryQualityGrade === "B" ||
        first.candidateStrength === "weak" ||
        entryEvidenceScore < 60;
      const tierLower = typeof confTier === "string" ? confTier.toLowerCase() : "";
      if (evidenceClamdown && (tierLower === "top" || tierLower === "high")) {
        confTier = "mid";
        confScore = Math.min(typeof confScore === "number" ? confScore : 0.55, 0.55);
        sizeMult = Math.min(typeof sizeMult === "number" ? sizeMult : 1, 0.75);
        this.logger.info("ENTRY_QUALITY_CONFIDENCE_CLAMPDOWN_PROOF", {
          symbol: first.symbol,
          entry_quality_grade: authority.entryQualityGrade ?? null,
          candidate_strength: first.candidateStrength ?? null,
          entry_evidence_score: entryEvidenceScore,
          stored_confidence_tier: confTier,
          stored_confidence_score: confScore,
          stored_size_multiplier: sizeMult
        });
      }

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

      const isRangeCampaignNewEntry =
        entryIdentity.effectiveExecutorAtEntry === "RANGE" && entryIdentity.effectiveRegimeAtEntry === "RANGE";

      const adaptiveSizeUsdBefore = adaptive.sizeUsd;
      if (authority.source === "v2" && entryQualitySizeMultiplier !== 1) {
        this.logger.error("SIZING_AUTHORITY_INVARIANT_BROKEN", this.buildInvariantProofPayload({
          symbol: sym,
          side: authority.side,
          authority,
          adoptedEngine,
          lifecycleState: existingOpen?.lifecycleState ?? null,
          reason: "v2_entry_local_multiplier_reintervention_detected"
        }));
      }
      if (authority.source !== "v2") {
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
          const paperBase = computePaperSizingAnchorUsd(this.config);
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
      }

      let positionOpenTraceRef: MutablePositionOpenTrace | null = null;
      try {
        const latestOpenPositions = await this.positions.loadOpenAll();
        const prePersistMutexEval = authoritySideLower == null
          ? {
            sameSymbolOpenCount: 0,
            sameSideOpen: false,
            oppositeSideOpen: false,
            existingSides: [] as ("long" | "short")[],
            existingPositionIds: [] as string[],
            blocked: false,
            blockReason: null as "SYMBOL_OPPOSITE_POSITION_OPEN" | "SYMBOL_SAME_SIDE_POSITION_ALREADY_OPEN" | null
          }
          : this.positions.evaluateSymbolPositionMutex(
            sym,
            authoritySideLower as "long" | "short",
            latestOpenPositions,
            existingIdx >= 0,
            authority.addOnAllowed === true
          );
        if (prePersistMutexEval.blocked) {
          const mutexReason = prePersistMutexEval.blockReason ?? "SYMBOL_OPPOSITE_POSITION_OPEN";
          this.logger.warn("SYMBOL_POSITION_MUTEX_PRE_PERSIST_BLOCKED", {
            symbol: sym,
            side: authority.side,
            requested_side: authoritySideLower ?? authority.side,
            mutex_block_reason: mutexReason,
            existing_sides: prePersistMutexEval.existingSides,
            existing_position_ids: prePersistMutexEval.existingPositionIds
          });
          await this.emitPipelineEventsFromDecision(
            first,
            {
              ...envelope,
              legacy: {
                ...res,
                decision: {
                  ...res.decision,
                  final_decision: "SKIP",
                  reject_reason: mutexReason
                }
              }
            },
            nowTs,
            entryStage,
            mutexReason
          );
          continue;
        }
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
          this.logger.info("EXECUTION_BRIDGE_ENTER_ACTION_PROOF", {
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

        const symS = String(first.symbol);
        const mPre = marginsForSymbol(next, symS);
        if (
          riskE &&
          ((authority.side === "long" && mPre.longUsd + entrySizeUsd > riskE.maxLongExposure) ||
            (authority.side === "short" && mPre.shortUsd + entrySizeUsd > riskE.maxShortExposure))
        ) {
          const cap = authority.side === "long" ? riskE.maxLongExposure : riskE.maxShortExposure;
          const currentExposureUsd = authority.side === "long" ? mPre.longUsd : mPre.shortUsd;
          const projectedExposureUsd = currentExposureUsd + entrySizeUsd;
          const ledgerExposureNotionalKrw = computeLedgerSymbolExposureNotionalKrw(next, String(first.symbol));
          const capRemainingUsd = Math.max(0, cap - currentExposureUsd);
          const reducedSizeUsd =
            capRemainingUsd >= MIN_POSITION_SIZE_USD
              ? Math.max(MIN_POSITION_SIZE_USD, Math.round(Math.min(entrySizeUsd, capRemainingUsd) * 100) / 100)
              : 0;
          const riskModeNow = this.lastRiskExposure?.riskMode ?? null;
          const serverControlsBlocked =
            !this.serverTradeControlState.server_trade_enabled ||
            this.serverTradeControlState.close_only_mode ||
            this.serverTradeControlState.kill_switch_active ||
            this.reconcileSafetyCloseOnly;
          const canReduceSize =
            reducedSizeUsd >= MIN_POSITION_SIZE_USD &&
            riskModeNow !== "HALT" &&
            !serverControlsBlocked;
          const blockReason = canReduceSize ? null : "risk_exposure_cap_for_leg";
          this.logger.warn("RISK_EXPOSURE_CAP_PRE_SUBMIT_PROOF", {
            symbol: first.symbol,
            side: authority.side,
            authority_source: authority.source,
            authority_stage_margin_krw: authority.stageMarginKrw ?? null,
            authority_size_usdt: (authority.stageMarginKrw ?? 0) / PAPER_LEDGER_KRW_NOTIONAL_PER_USD,
            authority_selector_size_krw: authority.stageMarginKrw ?? null,
            applied_leverage: authority.appliedLeverage ?? null,
            exposure_notional_krw: ledgerExposureNotionalKrw,
            candidate_exposure_notional_krw: authority.exposureNotionalKrw ?? null,
            equity_multiple: authority.equityMultiple ?? null,
            open_position_count: next.length,
            max_slots: max,
            current_exposure_usdt: currentExposureUsd,
            projected_exposure_usdt: projectedExposureUsd,
            max_allowed_exposure_usdt: cap,
            cap_remaining_usdt: capRemainingUsd,
            risk_mode: riskModeNow,
            market_mode: this.lastMarketMode?.marketMode ?? null,
            active_engine_routing: this.lastMarketMode?.routing.activeEngine ?? null,
            block_reason: blockReason,
          });
          if (canReduceSize) {
            const originalSizeUsd = entrySizeUsd;
            entrySizeUsd = reducedSizeUsd;
            this.logger.info("RISK_EXPOSURE_CAP_SIZE_REDUCED", {
              symbol: first.symbol,
              side: authority.side,
              original_size_usdt: originalSizeUsd,
              reduced_size_usdt: entrySizeUsd,
              cap_remaining_usdt: capRemainingUsd,
              reason: "v2_authority_size_reduced_to_fit_cap"
            });
          } else {
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
        }

        const lowExpectedMoveRelaxSizeLimited =
          first.rangeSignalKeptByRelax === true &&
          first.rangeSignalDowngradeReason === "low_expected_move_relaxed_by_range_structure";
        if (lowExpectedMoveRelaxSizeLimited) {
          const capped = Math.max(
            MIN_POSITION_SIZE_USD,
            Math.round(computePaperSizingAnchorUsd(this.config) * 0.4 * 100) / 100
          );
          const beforeCap = entrySizeUsd;
          entrySizeUsd = Math.min(entrySizeUsd, capped);
          this.logger.info("RANGE_LOW_EXPECTED_MOVE_RELAX_PROOF", {
            symbol: first.symbol,
            side: authority.side,
            boxPos: first.boxPos ?? null,
            rangeConfidence: first.rangeConfidence ?? null,
            boxCohesion01: first.boxCohesion01 ?? null,
            breakoutFailureRate: first.breakoutFailureRate ?? null,
            gateExpectedMove: first.gateExpectedMove ?? null,
            gateRequiredMove: first.gateRequiredMove ?? null,
            expectedMoveRatio:
              first.gateExpectedMove != null && first.gateRequiredMove != null && first.gateRequiredMove > 0
                ? first.gateExpectedMove / first.gateRequiredMove
                : null,
            rangeSignalKeptByRelax: first.rangeSignalKeptByRelax ?? false,
            low_expected_move_relax_size_limited: true,
            size_before_cap_usd: beforeCap,
            size_after_cap_usd: entrySizeUsd
          });
        }

        const signedModeForEntry = this.signedSubmitMode();
        let submit: Awaited<ReturnType<typeof this.submitOkxOrder>> | undefined;

        if (this.okxDemo && signedModeForEntry === "enabled") {
          const instId = toOkxSwapInstId(first.symbol);
          trace.inst_id = instId;
          const side = authority.side === "long" ? "buy" : "sell";
          const posSide = authority.side === "long" ? "long" : "short";
          const entryOrderNotionalUsdt = entrySizeUsd;
          const qtyLegacyEst = Math.max(0.001, Math.round((entrySizeUsd / Math.max(1e-9, first.lastPrice)) * 1_000_000) / 1_000_000);
          trace.qty_submitted = qtyLegacyEst;
          const clOrdId = buildOkxClOrdId(first.symbol, side);
          trace.exchange_client_order_id = clOrdId;
          trace.order_submit_requested = true;

          if (authority.source === "v2") {
            if (!v2CommittedRiskPlan) {
              this.logger.error("V2_ENTRY_BLOCKED_PROTECTION_PLAN_MISSING", {
                symbol: first.symbol,
                reason: "STOP_PRICE_REQUIRED_BEFORE_ENTRY",
                scope: "legacy_okx_submit_precheck",
                decision_id: (authority as any).decision_id ?? null
              });
              trace.open_fail_stage = "v2_protection_plan_missing";
              emitPositionOpenTraceFinal();
              logPaperPositionOpenFailed();
              continue;
            }
            this.logger.info("ORDER_BUILD_PROTECTION_PLAN_PROOF", {
              symbol: first.symbol,
              execution_path: "legacy_v2_signed_entry",
              open_trace_id: openTraceId,
              ...v2CommittedRiskPlan
            });
          }

          const committedStopForSubmit =
            authority.source === "v2" && v2CommittedRiskPlan
              ? v2CommittedRiskPlan.stop_price
              : typeof res.decision.stopLoss === "number" && Number.isFinite(res.decision.stopLoss) && res.decision.stopLoss !== 0
                ? res.decision.stopLoss
                : null;

          const committedTpForSubmit =
            authority.source === "v2"
              ? (v2CommittedRiskPlan?.initial_tp_price ?? null)
              : typeof res.decision.takeProfit === "number" && Number.isFinite(res.decision.takeProfit) && res.decision.takeProfit !== 0
                ? res.decision.takeProfit
                : null;

          if (authority.source === "v2") {
            const v2DecisionObj = (res as any).v2Decision ?? (res as any).decision;
            if (!v2DecisionObj || !v2CommittedRiskPlan) {
              this.logger.error("V2_ENTRY_BLOCKED_PROTECTION_PLAN_OR_DECISION_MISSING", {
                symbol: first.symbol,
                reason: "FAIL_CLOSED_V2_MISSING_PLAN_OR_DECISION"
              });
              trace.open_fail_stage = "v2_plan_or_decision_missing";
              emitPositionOpenTraceFinal();
              logPaperPositionOpenFailed();
              continue; // FAIL-CLOSED!
            }

            const rawPlan = v2DecisionObj.committedRiskPlan;

            if (!rawPlan) {
              this.logger.error("V2_ENTRY_BLOCKED_COMMITTED_PLAN_MISSING", {
                symbol: first.symbol,
                reason: "FAIL_CLOSED_V2_COMMITTED_PLAN_MISSING"
              });
              trace.open_fail_stage = "v2_committed_plan_missing";
              emitPositionOpenTraceFinal();
              logPaperPositionOpenFailed();
              continue; // FAIL-CLOSED!
            }

            // Requirement 3: Strict match validation with decision (Zero fallback, zero re-assembly!)
            const planValid =
              rawPlan.symbol === String(first.symbol) &&
              rawPlan.side === v2DecisionObj.side &&
              rawPlan.action === v2DecisionObj.executionAction &&
              rawPlan.ts === v2DecisionObj.ts &&
              typeof v2DecisionObj.risk?.finalOrderNotionalUsdt === "number" &&
              rawPlan.finalOrderNotionalUsdt === v2DecisionObj.risk.finalOrderNotionalUsdt;

            if (!planValid) {
              this.logger.error("V2_ENTRY_BLOCKED_COMMITTED_PLAN_MISMATCH", {
                symbol: first.symbol,
                reason: "FAIL_CLOSED_V2_COMMITTED_PLAN_MISMATCH",
                planSymbol: rawPlan.symbol, decisionSymbol: first.symbol,
                planSide: rawPlan.side, decisionSide: v2DecisionObj.side,
                planAction: rawPlan.action, decisionAction: v2DecisionObj.executionAction,
                planTs: rawPlan.ts, decisionTs: v2DecisionObj.ts,
                planNotional: rawPlan.finalOrderNotionalUsdt, decisionNotional: v2DecisionObj.risk?.finalOrderNotionalUsdt
              });
              trace.open_fail_stage = "v2_committed_plan_mismatch";
              emitPositionOpenTraceFinal();
              logPaperPositionOpenFailed();
              continue; // FAIL-CLOSED! Do not reassemble or correct!
            }

            const bridgeRes = await this.executeAuthorizedV2Action({
              symbol: first.symbol,
              v2Decision: v2DecisionObj,
              lastPrice: first.lastPrice,
              committedRiskPlan: rawPlan
            });

            this.logger.info("V2_ENTER_ORDER_PATH_PROOF", {
              symbol: first.symbol,
              run_cycle_id: this.runCycleId,
              decision_id: (authority as any).decision_id ?? null,
              side,
              posSide,
              executed: bridgeRes.executed,
              block_reason: bridgeRes.blockReason ?? null,
              pending_only: bridgeRes.pendingOnly ?? false
            });

            // V2 executeAuthorizedV2Action owns order submission, ledger write, and protective stop.
            // DO NOT fall through to legacy position push & protective stop creation! Immediately continue.
            continue;
          }

          submit = await this.submitOkxOrder({
            symbol: first.symbol,
            side,
            posSide,
            qty: qtyLegacyEst,
            clOrdId,
            traceId: openTraceId,
            reason: "entry_authorized",
            authoritySource: authority.source,
            adoptedEngine,
            entryQualityGrade: authority.entryQualityGrade ?? null,
            leverageProfile: authority.leverageProfile ?? null,
            appliedLeverage: authority.appliedLeverage ?? null,
            marketSubtype: null,
            marketRegime: authority.regime ?? null,
            isAddOn: false,
            entryPrice: first.lastPrice,
            stopPrice: committedStopForSubmit,
            takeProfitPrice: committedTpForSubmit,
            paperExecutionReady: this.paperExecutionReady,
            stageMarginKrw: authority.stageMarginKrw ?? null,
            isNewEntry,
            orderNotionalUsdt: entryOrderNotionalUsdt
          });

          if (!submit) {
            continue;
          }

          this.logger.info("V2_ENTER_ORDER_PATH_PROOF", {
            symbol: first.symbol,
            run_cycle_id: this.runCycleId,
            decision_id: (authority as any).decision_id ?? null,
            side,
            posSide,
            req_sz: submit.submittedContractSz ?? null,
            qty_legacy_base_estimate: qtyLegacyEst,
            clOrdId,
            authority_source: authority.source,
            order_notional_usdt: entryOrderNotionalUsdt,
            note: "Authoritative V2 entry decision handed off to exchange submission",
            submit_ok: submit.ok,
            submit_error_code: submit.errorCode,
            submit_error_message: submit.errorMessage
          });

          trace.order_submit_ack = submit.ackCode;
          trace.order_submit_error_code = submit.errorCode;
          trace.order_submit_error_message = submit.errorMessage;
          trace.exchange_ord_id = submit.ordId;
          trace.exchange_order_state = submit.orderState;
          trace.exchange_fill_px = submit.fillPx;

          if (!submit.ok) {
            const low = (submit.errorMessage || "").toLowerCase();
            trace.open_fail_stage =
              submit.errorCode === "51121" || low.includes("minimum") || low.includes("min") || low.includes("lot")
                ? "exchange_reject_min_sz_or_lot"
                : "exchange_submit_rejected_in_ack";
            
            emitPositionOpenTraceFinal();
            logPaperPositionOpenFailed();
            continue;
          }
        } else {
          trace.order_submit_requested = false;
          trace.order_submit_ack = this.okxDemo ? "paper_only" : "skipped_no_okx_demo";
          trace.open_fail_stage = "none";
          this.logger.info("SIGNED_ORDER_SUBMIT_SKIPPED_PAPER_ONLY", {
            symbol: first.symbol,
            side: authority.side,
            authority_source: authority.source,
            adopted_engine: adoptedEngine,
            entry_quality_grade: authority.entryQualityGrade ?? null,
            leverage_profile: authority.leverageProfile ?? null,
            applied_leverage: authority.appliedLeverage ?? null,
            paper_execution_ready: this.paperExecutionReady,
            signed_execution_ready: this.signedExecutionReady,
            signed_submit_mode: signedModeForEntry,
            reason: this.signedSubmitBlockReason(signedModeForEntry),
            ...this.okxAuthProofContext()
          });
        }

        const isExchangeEnabled = this.okxDemo && signedModeForEntry === "enabled";
        const isPendingConfirm = isExchangeEnabled && submit?.fillConfirmed !== true;

        if (isPendingConfirm) {
          this.logger.info("POSITION_OPEN_PENDING_EXCHANGE_CONFIRM", {
            symbol: first.symbol,
            side: authority.side,
            ord_id: submit?.ordId,
            cl_ord_id: trace.exchange_client_order_id,
            entry_price: first.lastPrice,
            size_usd: entrySizeUsd,
            accepted_at: Date.now()
          });
          this.logger.info("PAPER_OPEN_BLOCKED_UNFILLED_ORDER_PROOF", { open_trace_id: trace.open_trace_id, symbol: first.symbol, side: authority.side, fast_path: false });
          this.logger.info("LIMIT_ENTRY_PENDING_STATE_PROOF", { symbol: first.symbol, side: authority.side, ord_id: trace.exchange_ord_id });
          
          const symStr = String(first.symbol);
          const pendingCommittedStop =
            authority.source === "v2" && v2CommittedRiskPlan
              ? v2CommittedRiskPlan.stop_price
              : authority.newStopPrice != null && isCommittedEntryStopPrice(authority.newStopPrice)
                ? authority.newStopPrice
                : authority.invalidationPx != null && isCommittedEntryStopPrice(authority.invalidationPx)
                  ? authority.invalidationPx
                  : typeof res.decision.stopLoss === "number" && isCommittedEntryStopPrice(res.decision.stopLoss)
                    ? res.decision.stopLoss
                    : undefined;
          const pendingCommittedTp =
            authority.source === "v2" && v2CommittedRiskPlan?.initial_tp_price != null
              ? v2CommittedRiskPlan.initial_tp_price
              : typeof res.decision.takeProfit === "number"
                ? res.decision.takeProfit
                : undefined;

          const legacyPendingReg: import("../models/types").PendingEntryOrderRecord = {
            symbol: symStr,
            side: authority.side as "long" | "short",
            ordId: String(submit!.ordId),
            clOrdId: trace.exchange_client_order_id ?? "",
            instId: toOkxSwapInstId(symStr as MarketSymbol),
            authority_source: authority.source,
            intended_notional_usdt: entrySizeUsd,
            stopPrice: pendingCommittedStop,
            createdAt: Date.now(),
            status: "ENTRY_ORDER_PENDING",
            paperRecordSnapshot: null, // Legacy delays record build. Let's build a temporary one.
            authoritySnapshot: authority,
            openTraceId: trace.open_trace_id
          };
          
          const tempRecord: PaperOpenPositionRecord = {
            openedAt: legacyPendingReg.createdAt,
            lastCheckedAt: legacyPendingReg.createdAt,
            symbol: symStr as MarketSymbol,
            side: legacyPendingReg.side,
            entryPrice: first.lastPrice,
            avgPx: first.lastPrice,
            baseQty: entrySizeUsd / first.lastPrice,
            pos: (authority.side === "short" ? -1 : 1) * (entrySizeUsd / first.lastPrice),
            notionalUsd: entrySizeUsd,
            sizeUsd: entrySizeUsd,
            lifecycleState: "OPEN",
            reconcileState: "PENDING",
            sourceSignal: "v2",
            strategyVersion: "paper-v2",
            exchangeOrdId: legacyPendingReg.ordId,
            exchangeClOrdId: legacyPendingReg.clOrdId,
            leverage: levScaled,
            sourceRunPath: input.candidateRunPath ?? input.filePath ?? input.latestPath ?? "",
            status: "open",
            ...(pendingCommittedStop != null ? { stopPrice: pendingCommittedStop } : {}),
            ...(pendingCommittedTp != null ? { targetPrice1: pendingCommittedTp } : {}),
            ...(pendingCommittedStop != null ? { invalidationPx: pendingCommittedStop } : {}),
            ...buildAuthorityEventMeta(authority, entrySizeUsd)
          };
          legacyPendingReg.paperRecordSnapshot = tempRecord;
          
          const currentPending = await this.store.readPendingEntryOrders();
          const existingIdx = currentPending.findIndex(p => p.ordId === legacyPendingReg.ordId || (p.clOrdId === legacyPendingReg.clOrdId && p.clOrdId !== "") || (p.symbol === legacyPendingReg.symbol && p.side === legacyPendingReg.side));
          if (existingIdx >= 0) {
            this.logger.info("PENDING_ENTRY_ORDER_UPSERT_PROOF", { symbol: first.symbol, side: authority.side, ord_id: legacyPendingReg.ordId });
            currentPending[existingIdx] = legacyPendingReg;
          } else {
            currentPending.push(legacyPendingReg);
            this.logger.info("PENDING_ENTRY_ORDER_REGISTERED_PROOF", { symbol: first.symbol, side: authority.side, ord_id: legacyPendingReg.ordId });
          }
          await this.store.writePendingEntryOrders(currentPending);
          
          trace.position_open_final_state = "ENTRY_ORDER_PENDING";
          emitPositionOpenTraceFinal();
          continue;
        }

        const lifecycleState: PaperOpenPositionRecord["lifecycleState"] = isExchangeEnabled ? "OPEN" : "INITIAL";

        const record: PaperOpenPositionRecord = {
          openedAt: Date.now(),
          symbol: first.symbol,
          side: authority.side as "long" | "short",
          entryPrice: first.lastPrice,
          leverage: levScaled,
          sizeUsd: (authority.source === "v2") ? entrySizeUsd : entrySizeUsd / (levScaled || 1),
          initialSizeUsd: (authority.source === "v2") ? entrySizeUsd : entrySizeUsd / (levScaled || 1),
          isV2Authority: (authority.source === "v2"),
          partialExitStage: 0,
          lifecycleState,
          exchangeOrdId: submit?.ordId ?? undefined,
          exchangeClOrdId: trace.exchange_client_order_id ?? undefined,
          exchangeFilledSize: submit?.fillSize ?? 0,
          entryProtectionUntil: Date.now() + 120_000,
          realizedPnl: 0,
          stopPrice: (() => {
            if (authority.source === "v2" && v2CommittedRiskPlan) return v2CommittedRiskPlan.stop_price;
            if (authority.invalidationPx != null && isCommittedEntryStopPrice(authority.invalidationPx))
              return authority.invalidationPx;
            const val = typeof res.decision.stopLoss === "number" ? res.decision.stopLoss : undefined;
            if (val !== undefined && isCommittedEntryStopPrice(val)) return val;
            return undefined;
          })(),
          targetPrice1: (() => {
            if (authority.source === "v2") {
              if (v2CommittedRiskPlan?.initial_tp_price != null) return v2CommittedRiskPlan.initial_tp_price;
              if (authority.takeProfit1Px !== undefined && isCommittedEntryStopPrice(authority.takeProfit1Px)) return authority.takeProfit1Px;
              return undefined;
            }
            return typeof res.decision.takeProfit === "number" ? res.decision.takeProfit : undefined;
          })(),
          pos: submit?.baseQty ?? (entrySizeUsd / first.lastPrice),
          okxContracts: submit?.okxContracts ?? undefined,
          baseQty: submit?.baseQty ?? undefined,
          notionalUsd: submit?.notionalUsd ?? undefined,
          avgPx: submit?.avgPx ?? undefined,
          notional: entrySizeUsd,
          strategyVersion: entryIdentity.effectiveStrategyVersion,
          sourceSignal: entryIdentity.effectiveSourceSignal,
          authoritySourceAtEntry: authority.source,
          ...(authority.side == null
            ? {}
            : { authoritySideAtEntry: String(authority.side) }),
          sourceRunPath: input.candidateRunPath ?? input.filePath ?? input.latestPath ?? "",
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
              ...(typeof first.boxPos === "number" ? { rangeEntryBoxPos: first.boxPos, rangeEntryZone: classifyRangeZone(first.boxPos) } : {}),
              rangeManagementState: "INIT" as RangeManagementState,
              rangeAddOnUsed: false,
              rangeFirstProfitLocked: false,
              entryStage: 1,
              scalingWeights: [0.5, 0.5],
              ...(res.decision.range_reversal_immediate_switch_applied === true ? { rangeEntryFromReversalSwitch: true } : {})
            }
            : {}),
          entryEvidence: {
            capturedAt: nowTs,
            regime_at_entry: regimeForSl(
              entryIdentity.effectiveRegimeAtEntry === "UNKNOWN" ? "NO_TRADE" : entryIdentity.effectiveRegimeAtEntry
            ),
            active_engine_at_entry: activeEngine,
            entry_signal: first.signal,
            entry_quality_grade: authority.entryQualityGrade ?? null,
            entry_quality_score: first.qualityScore ?? null,
            side: authority.side as "long" | "short",
            boxPos: first.boxPos ?? null,
            rangeConfidence: first.rangeConfidence ?? null,
            emaGap: first.emaGap ?? null,
            trendWeaknessScore: first.trendWeaknessScore ?? null,
            candidateStrength: first.candidateStrength ?? null,
            authority_source: authority.source,
            adopted_engine: adoptedEngine,
            entry_evidence_score: entryEvidenceScore,
            entry_evidence_reason: entryEvidenceReason
          },
          status: "open",
          // V2 RANGE Hardening: Persistent Box Quality & Exit Plan
          rangeBoxHighAtEntry: authority.rangeBoxHighAtEntry,
          rangeBoxLowAtEntry: authority.rangeBoxLowAtEntry,
          rangeBoxMidAtEntry: authority.rangeBoxMidAtEntry,
          rangeBoxQuality: authority.rangeBoxQuality,
          rangeBoxSlope: authority.rangeBoxSlope,
          rangeBoxDistorted: authority.rangeBoxDistorted,
          takeProfitPlan: authority.takeProfitPlan,
          takeProfit1Px: authority.takeProfit1Px,
          takeProfit2Px: authority.takeProfit2Px,
          partialExitRatio: authority.partialExitRatio,
          invalidationPx:
            authority.source === "v2" && v2CommittedRiskPlan
              ? v2CommittedRiskPlan.stop_price
              : authority.invalidationPx ?? undefined
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

        if (
          record.isV2Authority === true &&
          !isCommittedEntryStopPrice(record.stopPrice)
        ) {
          this.logger.error("PAPER_POSITION_OPEN_BLOCKED_MISSING_STOP", {
            symbol: record.symbol,
            side: record.side,
            open_trace_id: trace.open_trace_id,
            fast_path: false,
            submit_ok: submit?.ok ?? null,
            fill_confirmed: submit?.fillConfirmed ?? null
          });
          if (submit?.ok === true && submit.fillConfirmed === true) {
            this.logger.error("PROTECTION_REPAIR_REQUIRED", {
              symbol: record.symbol,
              side: record.side,
              detail: "okx_fill_confirmed_without_ledger_committed_stop_legacy_path"
            });
            this.symbolProtectionFailedBlocked.add(String(record.symbol));
          }
          trace.open_fail_stage = "ledger_blocked_missing_stop";
          emitPositionOpenTraceFinal();
          logPaperPositionOpenFailed();
          continue;
        }

        next.push(record);
        
        // [V2_PROTECTIVE_STOP_AUTO_REGISTRATION]
        const protectRes = await this.ensureProtectiveStopOrder(record, `v2_legacy_entry_auto:${record.symbol}:${record.openedAt}`);
        if (protectRes.modified) {
          record.isProtectiveStopRegistered = protectRes.record.isProtectiveStopRegistered;
          record.protectiveStopAlgoId = protectRes.record.protectiveStopAlgoId;
        }
        
        openPositionsChanged = true;

        this.logger.info("STOP_STATE_PROOF", {
          symbol: record.symbol,
          side: record.side,
          stopPrice_at_entry: record.stopPrice ?? null,
          entryPrice: record.entryPrice,
          source:
            authority.source === "v2" && v2CommittedRiskPlan
              ? `v2_committed_risk_plan:${v2CommittedRiskPlan.stop_source}`
              : typeof res.decision.stopLoss === "number"
                ? "executor_decision"
                : "none"
        });
        trace.position_open_record_written = true;
        if (res.decision.range_reversal_immediate_switch_applied === true) {
          this.rangeReversalSwitchPendingBySymbol.delete(sym);
        }
        if (this.lastEffectiveLane === "RANGE") {
          const fillZone = typeof first.boxPos === "number" ? classifyRangeZone(first.boxPos) : null;
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
          // [ENTRY IDENTITY FIX] RANGE anomaly ?먯젙? 諛섎뱶??吏꾩엯 ?쒖젏??湲곕줉??rangeEntryZone 湲곗??댁뼱???쒕떎.
          // fillZone(?꾩옱 ?ㅻ깄??boxPos)?쇰줈 ?먯젙?섎㈃ TREND濡??대┛ ?ъ??섏씠 ?섏쨷??諛뺤뒪 ?곷떒???덉쓣 ???ㅽ깘??諛쒖깮?쒕떎.
          // executorAtEntry媛 TREND???ъ??섏? RANGE anomaly ?먯젙 ??곸씠 ?꾨땲??
          const entryZoneForAnomaly = record.rangeEntryZone ?? fillZone;
          const isRangeOriginPosition = record.executorAtEntry === "RANGE" || record.regimeAtEntry === "RANGE";
          if (entryZoneForAnomaly === "upper" && record.side === "long" && isRangeOriginPosition) {
            this.logger.warn("RANGE_ANOMALY_UPPER_LONG_OPEN_CODE_PATH", {
              ...fillProof,
              entry_zone_for_anomaly: entryZoneForAnomaly,
              anomaly_source: record.rangeEntryZone ? "rangeEntryZone_stored" : "fillZone_fallback",
              anomaly_note:
                "RANGE stage0 ?곷떒?먯꽌??濡?吏꾩엯???섏삤硫????????덇굅???섏씠?⑥씠쨌?뚯뒪??諛붿씠?⑥뒪쨌?덉뒪?좊━ zone ?쇰꺼 遺덉씪移??깆쓣 ?섏떖"
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
          low_expected_move_relax_size_limited:
            first.rangeSignalKeptByRelax === true &&
            first.rangeSignalDowngradeReason === "low_expected_move_relaxed_by_range_structure",
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
        this.logger.info("LIMIT_ENTRY_FILLED_TO_PAPER_OPEN_PROOF", { symbol: record.symbol, side: record.side, ord_id: trace.exchange_ord_id });
        this.logger.info("paper_position_opened", {
          open_trace_id: trace.open_trace_id,
          sample_symbol_btc_eth: trace.sample_symbol_btc_eth,
          order_submit_requested: trace.order_submit_requested,
          order_submit_ack: trace.order_submit_ack,
          order_submit_error_code: trace.order_submit_error_code,
          order_submit_error_message: trace.order_submit_error_message,
          position_open_record_written: trace.position_open_record_written,
          low_expected_move_relax_size_limited:
            first.rangeSignalKeptByRelax === true &&
            first.rangeSignalDowngradeReason === "low_expected_move_relaxed_by_range_structure",
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
        this.bundleDirty = true;

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

  private evaluateAddOnStructureReinforced(
    open: PaperOpenPositionRecord,
    snap: SymbolSnapshot,
    intentSide: "long" | "short"
  ): { ok: boolean; reason: string } {
    const reg = String(open.regimeAtEntry ?? "").toUpperCase();
    const exec = String(open.executorAtEntry ?? "").toUpperCase();
    if (reg === "RANGE" || exec === "RANGE") {
      if (typeof snap.boxPos !== "number" || !Number.isFinite(snap.boxPos)) {
        return { ok: false, reason: "addon_range_zone_unknown" };
      }
      const rz = classifyRangeZone(snap.boxPos);
      const ok =
        (intentSide === "long" && rz === "lower") ||
        (intentSide === "short" && rz === "upper");
      return ok ? { ok: true, reason: "addon_range_structure_reinforced" } : { ok: false, reason: "addon_range_structure_not_reinforced" };
    }
    const trendStructureOk =
      snap.trendOk === true &&
      Math.abs(snap.emaGap ?? 0) >= ENTRY_EVIDENCE_TREND_EMA_GAP_MIN &&
      (snap.trendWeaknessScore ?? 1) <= ENTRY_EVIDENCE_TREND_WEAKNESS_MAX;
    const dirAligned =
      (intentSide === "long" && (snap.emaGap ?? 0) >= ENTRY_EVIDENCE_TREND_EMA_GAP_MIN) ||
      (intentSide === "short" && (snap.emaGap ?? 0) <= -ENTRY_EVIDENCE_TREND_EMA_GAP_MIN);
    return trendStructureOk && dirAligned
      ? { ok: true, reason: "addon_trend_structure_reinforced" }
      : { ok: false, reason: "addon_trend_structure_not_reinforced" };
  }

  private async tryPaperPositionScaleIn(
    existing: PaperOpenPositionRecord,
    envelope: PaperEngineDecisionEnvelope,
    first: SymbolSnapshot,
    nowTs: number,
    entryQualitySizeMultiplier = 1
  ): Promise<PaperOpenPositionRecord | null> {
    const { legacy: res, authority } = envelope;
    const emitScaleInvariantBroken = (reason: string): null => {
      this.logger.error("SCALE_IN_INVARIANT_BROKEN", this.buildInvariantProofPayload({
        symbol: String(existing.symbol),
        side: authority.side,
        authority,
        adoptedEngine: envelope.selector?.adopted_result.engine ?? null,
        lifecycleState: existing.lifecycleState ?? null,
        reason
      }));
      return null;
    };
    if (authority.source !== "v2") {
      emitScaleInvariantBroken("authority_source_not_v2");
      this.logger.info("scale_in_blocked_non_v2_authority", { symbol: existing.symbol, authority_source: authority.source });
      return null;
    }
    if (authority.decision !== "ENTER") {
      emitScaleInvariantBroken("authority_decision_not_enter");
      this.logger.info("scale_in_blocked_authority_not_enter", { symbol: existing.symbol, authority_decision: authority.decision });
      return null;
    }
    if (authority.side !== existing.side) {
      emitScaleInvariantBroken("authority_side_mismatch");
      this.logger.info("scale_in_blocked_side_mismatch", {
        symbol: existing.symbol,
        authority_side: authority.side,
        existing_side: existing.side
      });
      return null;
    }
    if (authority.addOnAllowed !== true) {
      emitScaleInvariantBroken("authority_addon_not_allowed");
      this.logger.info("scale_in_blocked_authority_addon_not_allowed", {
        symbol: existing.symbol,
        add_on_allowed: authority.addOnAllowed ?? false,
        authority_source: authority.source
      });
      return null;
    }
    const pnlPctNow =
      existing.side === "long"
        ? (first.lastPrice - existing.entryPrice) / Math.max(1e-9, existing.entryPrice)
        : (existing.entryPrice - first.lastPrice) / Math.max(1e-9, existing.entryPrice);
    if (pnlPctNow <= 0) {
      this.logger.info("ADDON_PRECHECK_BLOCK_PROOF", {
        symbol: existing.symbol,
        pnl_pct: pnlPctNow,
        block_reason: "loss_averaging_forbidden",
        note: "defense_in_depth_scale_in_path_should_be_prefiltered"
      });
      this.logger.info("scale_in_blocked_loss_averaging_forbidden", {
        symbol: existing.symbol,
        pnl_pct: pnlPctNow
      });
      return null;
    }
    if (authority.regime != null && existing.regimeAtEntry != null) {
      const authorityRegime = String(authority.regime).toUpperCase();
      if (authorityRegime !== String(existing.regimeAtEntry).toUpperCase()) {
        emitScaleInvariantBroken("authority_regime_mismatch");
        this.logger.info("scale_in_blocked_regime_identity_mismatch", {
          symbol: existing.symbol,
          authority_regime: authority.regime,
          position_regime_at_entry: existing.regimeAtEntry
        });
        return null;
      }
    }
    if (this.freshTickRequiredAfterReadiness) {
      this.logger.warn("ENTRY_BLOCKED_PREPARED_BUT_NOT_REEVALUATED", {
        symbol: existing.symbol,
        mode: "scale_in",
        reason: "fresh_tick_required_after_readiness"
      });
      return null;
    }
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

    if (authority.source === "v2") {
      targetStage = Math.min(3, (existing.entryStage ?? 1) + 1);
      scalingWeights = existing.scalingWeights ?? [0.5, 0.5];
      rangeAddOnSizeMultApplied = 1;
      incrementalSizeUsd = authority.source === "v2"
        ? Math.max(10, Math.round(adaptive.sizeUsd * 100) / 100)
        : Math.max(MIN_POSITION_SIZE_USD, Math.round(adaptive.sizeUsd * 100) / 100);
      this.logger.info("V2_POLICY_SCALE_IN_SIZING_APPLIED", {
        symbol: existing.symbol,
        side: existing.side,
        target_stage: targetStage,
        authority_stage_margin_krw: authority.stageMarginKrw ?? null,
        adaptive_size_usd: adaptive.sizeUsd,
        final_incremental_usd: incrementalSizeUsd
      });
    } else if (isRangeCampaignScaleIn) {
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
      const paperBase = computePaperSizingAnchorUsd(this.config);
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
        classifyRangeZone(first.boxPos) === "upper" &&
        res.decision.range_upper_short_priority_applied === true &&
        edgeStructureOk === true;
      const lowerLongAddOnCandidate =
        existing.regimeAtEntry === "RANGE" &&
        existing.side === "long" &&
        existing.rangeEntryZone === "lower" &&
        typeof first.boxPos === "number" &&
        classifyRangeZone(first.boxPos) === "lower" &&
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
        const zz = classifyRangeZone(first.boxPos);
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
    if (entryQualitySizeMultiplier < 1) {
      incrementalSizeUsd = Math.max(
        MIN_POSITION_SIZE_USD,
        Math.round(incrementalSizeUsd * entryQualitySizeMultiplier * 100) / 100
      );
      this.logger.info("ENTRY_QUALITY_SCALE_IN_SIZE_REDUCED", {
        symbol: existing.symbol,
        side: existing.side,
        entry_quality_size_multiplier: entryQualitySizeMultiplier,
        final_incremental_size_usd: incrementalSizeUsd
      });
    }

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
        box_zone: classifyRangeZone(first.boxPos),
        box_pos: first.boxPos,
        snapshot_signal: first.signal,
        adaptive_direction: adaptive.direction,
        incremental_usd: incrementalSizeUsd,
        target_stage: targetStage,
        note: "range_scale_in_long_upper_blocked_logged_separately"
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
      lifecycleState: "ADDON_ACTIVE",
      scalingWeights,
      rangeAddOnUsed: (targetStage >= 2 || rangeAddOnCandidate || rangeCampaignScaleInPath) ? true : existing.rangeAddOnUsed,
      rangeManagementState: (targetStage >= 2 || rangeAddOnCandidate || rangeCampaignScaleInPath)
        ? ("REATTACK_USED" as RangeManagementState)
        : (existing.rangeManagementState ?? "INIT"),
      addonRebuildRequired: true, // Trigger protection rebuild on next reconciliation
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
        stopPrice_before: existing.stopPrice ?? null,
        stopPrice_after: updatedRecord.stopPrice ?? null,
        source: typeof res.decision.stopLoss === "number" ? "executor_decision" : "persisted_value"
      });
    }

    if (this.okxDemo) {
      const sSide = existing.side === "long" ? "buy" : "sell";
      const sPosSide = existing.side === "long" ? "long" : "short";
      const sQtyLegacy = Math.max(0.001, Math.round((incrementalSizeUsd / Math.max(1e-9, first.lastPrice)) * 1_000_000) / 1_000_000);
      const sLev = Math.max(1, existing.leverage ?? authority.appliedLeverage ?? 1);
      await this.submitOkxOrder({
        symbol: existing.symbol,
        side: sSide,
        posSide: sPosSide,
        qty: sQtyLegacy,
        desiredNotionalUsdt: (existing as any).isV2Authority === true ? incrementalSizeUsd : (incrementalSizeUsd * sLev),
        pricingReferencePx: first.lastPrice,
        appliedLeverage: authority.appliedLeverage ?? existing.leverage ?? null,
        clOrdId: buildOkxClOrdId(existing.symbol, sSide),
        traceId: `${existing.symbol}:${existing.side}:${existing.openedAt}`,
        reason: "scale_in_authorized",
        authoritySource: authority.source,
        adoptedEngine: envelope.selector?.adopted_result.engine ?? null,
        entryQualityGrade: authority.entryQualityGrade ?? null,
        leverageProfile: authority.leverageProfile ?? null,
        paperExecutionReady: this.paperExecutionReady,
        isNewEntry: false
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
    | Readonly<{ ok: true; snapshot: SymbolSnapshot; symbolDiagnostics: SymbolDiagnostic[]; basePollMs: number; htfFetchMs: number }>
    | Readonly<{ ok: false; error: string; symbolDiagnostics: SymbolDiagnostic[]; failedEndpoint: FailureEndpointKey; basePollMs: number; htfFetchMs: number }>
  > {
    const symbolDiagnostics: SymbolDiagnostic[] = [];
    const HTF_TF_DEADLINE_MS = 12_000;

    const tBasePoll0 = Date.now();
    const rT = await this.okxPublic.tryGetTicker(symbol);
    symbolDiagnostics.push(toSymbolDiagnostic(symbol, EP.ticker, rT.diagnostics));

    const rC = await this.okxPublic.tryGetCandles(symbol, "1m", klineLimit);
    symbolDiagnostics.push(toSymbolDiagnostic(symbol, EP.kline, rC.diagnostics));

    const rF = await this.okxPublic.tryGetFundingRate(symbol);
    symbolDiagnostics.push(toSymbolDiagnostic(symbol, EP.funding, rF.diagnostics));
    const basePollMs = Date.now() - tBasePoll0;

    if (!rT.ok || !rC.ok || !rF.ok) {
      const parts: string[] = [];
      if (!rT.ok) parts.push(rT.error);
      if (!rC.ok) parts.push(rC.error);
      if (!rF.ok) parts.push(rF.error ?? "unknown");
      const failedEndpoint: FailureEndpointKey = !rT.ok ? "ticker" : (!rC.ok ? "kline" : (!rF.ok ? "funding" : "unknown"));
      return { ok: false, error: parts.join("; "), symbolDiagnostics, failedEndpoint, basePollMs, htfFetchMs: 0 };
    }

    const htf_candles: Record<string, import("../models/types").Candle[]> = {};
    const htfTimeframes = ["5m", "15m", "1h", "4h", "1d"] as const;
    const htf_diagnostics: Record<string, any> = {};

    const tHtf0 = Date.now();
    for (const tf of htfTimeframes) {
      const res = await Promise.race([
        this.okxPublic.tryGetCandles(symbol, tf, 120),
        new Promise<"__htf_timeout__">((resolve) => {
          setTimeout(() => resolve("__htf_timeout__"), HTF_TF_DEADLINE_MS);
        })
      ]);
      if (res === "__htf_timeout__") {
        htf_diagnostics[tf] = {
          ok: false,
          candle_count: 0,
          last_ts: null,
          error: "htf_fetch_timeout"
        };
        this.logger.warn("V2_HTF_CANDLE_FETCH_TIMEOUT_PROOF", {
          symbol: String(symbol),
          tf,
          deadline_ms: HTF_TF_DEADLINE_MS
        });
        continue;
      }
      htf_diagnostics[tf] = {
        ok: res.ok,
        candle_count: res.ok ? res.value.length : 0,
        last_ts: res.ok && res.value.length > 0 ? res.value[res.value.length - 1].ts : null,
        error: res.ok ? null : res.error
      };
      if (res.ok) {
        htf_candles[tf] = res.value;
      }
    }
    const htfFetchMs = Date.now() - tHtf0;

    console.info(JSON.stringify({
      event: "HTF_CANDLE_FETCH_PROOF",
      symbol: String(symbol),
      htf_diagnostics
    }));

    const lastPrice = rT.value.last;
    const recentCandlesCount = rC.value.length;
    const latestCandleClose = rC.value.length > 0 ? rC.value[rC.value.length - 1].close : undefined;
    if (!Number.isFinite(lastPrice)) {
      return { ok: false, error: `Invalid lastPrice for ${symbol}`, symbolDiagnostics, failedEndpoint: "ticker", basePollMs, htfFetchMs };
    }
    if (!Number.isFinite(recentCandlesCount)) {
      return { ok: false, error: `Invalid candles count for ${symbol}`, symbolDiagnostics, failedEndpoint: "kline", basePollMs, htfFetchMs };
    }
    if (latestCandleClose === undefined || !Number.isFinite(latestCandleClose)) {
      return { ok: false, error: `Invalid latestCandleClose for ${symbol}`, symbolDiagnostics, failedEndpoint: "kline", basePollMs, htfFetchMs };
    }
    if (!Number.isFinite(rF.value.rate)) {
      return { ok: false, error: `Invalid fundingRate for ${symbol}`, symbolDiagnostics, failedEndpoint: "funding", basePollMs, htfFetchMs };
    }

    const okxKlineLen = rC.value.length;
    this.logHighwayCandlePipelineProof("okx_kline_ok", {
      trace_fetched_at_ms: fetchedAt,
      symbol: String(symbol),
      okx_kline_array_length: okxKlineLen,
      kline_limit_requested: klineLimit,
      interval: "1m",
      classify:
        okxKlineLen === 0
          ? "okx_returned_empty_array"
          : okxKlineLen < klineLimit
            ? "okx_fewer_than_requested"
            : "okx_length_matches_or_exceeds_request"
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

    // BTC-specific candidate signal relaxation for RANGE regime (?꾨낫留? 泥닿껐? 湲곗〈 寃뚯씠???좎?)
    let signalDecisionOrigin = "entry_signal_raw";
    let signal_missing_reason = "NONE";
    let rangeSignalOrigin = "entry_signal_raw";
    let rangeSignalDowngraded = false;
    let rangeSignalDowngradeReason = "none";
    let rangeSignalKeptByRelax = false;
    if (symbol === "BTCUSDT" && regimeDetected.regime === "RANGE" && entry.signal === "none") {
      if (boxPos !== null && boxRel !== null && boxRel >= 0.0035) {
        // RANGE edge soft candidates use deep box thresholds (0.26 / 0.74).
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
      const isRangeRegime = regimeDetected.regime === "RANGE";
      const hasRangeEdge = boxPos !== null && (boxPos <= 0.38 || boxPos >= 0.62);
      const sideEdgeAligned =
        hasRangeEdge &&
        ((entrySide === "long" && (boxPos ?? 0.5) <= 0.38) ||
          (entrySide === "short" && (boxPos ?? 0.5) >= 0.62));
      let rangeSideZoneMismatchReason: string | null = null;
      if (isRangeRegime && typeof boxPos === "number" && Number.isFinite(boxPos)) {
        if (entrySide === "short" && boxPos <= 0.38) {
          rangeSideZoneMismatchReason = "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT";
        } else if (entrySide === "long" && boxPos >= 0.62) {
          rangeSideZoneMismatchReason = "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG";
        } else if (boxPos > 0.38 && boxPos < 0.62) {
          rangeSideZoneMismatchReason = "RANGE_SIDE_ZONE_MISMATCH_MID_WAIT";
        }
      }
      const rangeStructureStrong =
        isRangeRegime &&
        (regimeDetected.rangeConfidence ?? 0) >= 0.70 &&
        (regimeDetected.boxCohesion01 ?? 0) >= 0.8 &&
        (regimeDetected.breakoutFailureRate ?? 0) >= 0.7 &&
        (regimeDetected.trendWeaknessScore ?? 0) >= 0.55 &&
        sideEdgeAligned;
      const rangeSignalKeepByRelaxCandidate =
        symbol === "BTCUSDT" &&
        isRangeRegime &&
        (regimeDetected.rangeConfidence ?? 0) >= 0.5 &&
        (regimeDetected.boxCohesion01 ?? 0) >= 0.45 &&
        (regimeDetected.trendWeaknessScore ?? 0) >= 0.5 &&
        hasRangeEdge;
      if (rangeSideZoneMismatchReason !== null) {
        const zone = classifyRangeZone(boxPos ?? 0.5);
        let mismatchDiagnosticSource:
          | "reused_existing_gate"
          | "local_entry_tf_only_no_extra_fetch"
          | "null_no_extra_fetch" = "null_no_extra_fetch";
        let proofGateExpectedMove: number | null = null;
        let proofGateRequiredMove: number | null = null;
        let proofExpectedMoveRatio: number | null = null;

        const reusedGateSnapshot: ReturnType<typeof evaluateEntryCostAndHigherTfGate> | null =
          gateEval as ReturnType<typeof evaluateEntryCostAndHigherTfGate> | null;
        if (reusedGateSnapshot !== null) {
          mismatchDiagnosticSource = "reused_existing_gate";
          const ge = reusedGateSnapshot.expectedMove;
          const gr = reusedGateSnapshot.requiredMove;
          proofGateExpectedMove = Number.isFinite(ge) ? ge : null;
          proofGateRequiredMove = Number.isFinite(gr) ? gr : null;
          if (
            typeof gr === "number" &&
            gr > 0 &&
            Number.isFinite(ge) &&
            Number.isFinite(gr)
          ) {
            proofExpectedMoveRatio = ge / gr;
          }
        } else if (rC.value.length > 0 && Number.isFinite(lastPrice) && lastPrice > 0) {
          mismatchDiagnosticSource = "local_entry_tf_only_no_extra_fetch";
          const localOnlyGate = evaluateEntryCostAndHigherTfGate({
            entryTimeframeCandles: rC.value,
            higherTfCandles: null,
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
          const ge = localOnlyGate.expectedMove;
          const gr = localOnlyGate.requiredMove;
          proofGateExpectedMove = Number.isFinite(ge) ? ge : null;
          proofGateRequiredMove = Number.isFinite(gr) ? gr : null;
          if (
            typeof gr === "number" &&
            gr > 0 &&
            Number.isFinite(ge) &&
            Number.isFinite(gr)
          ) {
            proofExpectedMoveRatio = ge / gr;
          }
        }

        signal = "none";
        entryCandidate = false;
        gateBlockedReason = rangeSideZoneMismatchReason;
        signalDecisionOrigin = `entry_gate_blocked_${String(gateBlockedReason).toLowerCase()}`;
        rangeSignalDowngraded = true;
        rangeSignalDowngradeReason = gateBlockedReason;
        this.logger.info("RANGE_SIDE_ZONE_MISMATCH_PROOF", {
          symbol: String(symbol),
          side: entrySide,
          boxPos: boxPos ?? null,
          zone,
          rangeConfidence: regimeDetected.rangeConfidence ?? null,
          gateExpectedMove: proofGateExpectedMove,
          gateRequiredMove: proofGateRequiredMove,
          expectedMoveRatio: proofExpectedMoveRatio,
          boxCohesion01: regimeDetected.boxCohesion01 ?? null,
          breakoutFailureRate: regimeDetected.breakoutFailureRate ?? null,
          trendWeaknessScore: regimeDetected.trendWeaknessScore ?? null,
          rangeSignalOrigin,
          candidateStrength: entry.candidateStrength ?? null,
          qualityScore,
          signalDecisionOrigin,
          finalRejectReason: gateBlockedReason,
          activeEngine: "RANGE",
          mismatchDiagnosticSource
        });
      } else if (this.config.paperQualityMinScore > 0 && qualityScore < qualityMinEffective) {
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
        const rC5 = await this.okxPublic.tryGetCandles(symbol, tfHi, limHi);
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
          const expectedMoveRatio =
            gate.requiredMove > 0 && Number.isFinite(gate.expectedMove) && Number.isFinite(gate.requiredMove)
              ? gate.expectedMove / gate.requiredMove
              : null;
          const lowExpectedMoveRelaxCandidate =
            gate.blockReason === "low_expected_move" &&
            isRangeRegime &&
            rangeStructureStrong &&
            expectedMoveRatio != null &&
            expectedMoveRatio >= 0.25;
          const lowExpectedMoveRelaxHardBlocked =
            gate.blockReason === "low_expected_move" &&
            expectedMoveRatio != null &&
            expectedMoveRatio < 0.25;
          if (lowExpectedMoveRelaxCandidate || rangeSignalKeepByRelaxCandidate) {
            signal = entry.signal;
            entryCandidate = true;
            rangeSignalKeptByRelax = true;
            signalDecisionOrigin = lowExpectedMoveRelaxCandidate
              ? "entry_gate_low_expected_move_relaxed_by_range_structure"
              : `btc_range_relax_keep_candidate_gate_${String(gate.blockReason ?? "gate")}`;
            rangeSignalDowngradeReason = lowExpectedMoveRelaxCandidate
              ? "low_expected_move_relaxed_by_range_structure"
              : "none";
            this.logger.info("RANGE_LOW_EXPECTED_MOVE_RELAX_PROOF", {
              symbol: String(symbol),
              side: entrySide,
              boxPos,
              rangeConfidence: regimeDetected.rangeConfidence ?? null,
              boxCohesion01: regimeDetected.boxCohesion01 ?? null,
              breakoutFailureRate: regimeDetected.breakoutFailureRate ?? null,
              gateExpectedMove: gate.expectedMove ?? null,
              gateRequiredMove: gate.requiredMove ?? null,
              expectedMoveRatio,
              rangeSignalKeptByRelax: true,
              low_expected_move_relax_size_limited: lowExpectedMoveRelaxCandidate
            });
          } else {
            signal = "none";
            entryCandidate = false;
            gateBlockedReason = gate.blockReason ?? "gate";
            signalDecisionOrigin = `entry_gate_blocked_${String(gateBlockedReason)}`;
            rangeSignalDowngraded = true;
            rangeSignalDowngradeReason = gateBlockedReason;
            if (gate.blockReason === "low_expected_move") {
              this.logger.info("RANGE_LOW_EXPECTED_MOVE_RELAX_PROOF", {
                symbol: String(symbol),
                side: entrySide,
                boxPos,
                rangeConfidence: regimeDetected.rangeConfidence ?? null,
                boxCohesion01: regimeDetected.boxCohesion01 ?? null,
                breakoutFailureRate: regimeDetected.breakoutFailureRate ?? null,
                gateExpectedMove: gate.expectedMove ?? null,
                gateRequiredMove: gate.requiredMove ?? null,
                expectedMoveRatio,
                rangeSignalKeptByRelax: false,
                low_expected_move_relax_size_limited: false,
                hard_block_due_to_expected_move_ratio_below_min: lowExpectedMoveRelaxHardBlocked
              });
            }
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
      highwayEntryTf: "1m",
      htf_candles
    };

    this.logHighwayCandlePipelineProof("snapshot_before_return", {
      trace_fetched_at_ms: fetchedAt,
      symbol: String(symbol),
      snapshot_candles_array_length: snapshot.candles?.length ?? 0,
      snapshot_recent_candles_count: snapshot.recentCandlesCount,
      candles_same_reference_as_okx_response: snapshot.candles === rC.value,
      classify:
        (snapshot.candles?.length ?? 0) === 0
          ? "snapshot_candles_empty_after_poll_ok"
          : (snapshot.candles?.length ?? 0) !== snapshot.recentCandlesCount
            ? "snapshot_len_mismatch_candles_vs_recent_count"
            : "snapshot_candles_consistent"
    });

    /** ENTRY_LINE? runTick 猷⑦봽?먯꽌 ?섏궗寃곗젙 寃곌낵(Intent ??? ?⑹퀜??濡쒓퉭?섍린 ?꾪빐 ?ш린?쒕뒗 ?앸왂 */
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

    return { ok: true, snapshot, symbolDiagnostics, basePollMs, htfFetchMs };
  }

  private hydrateRiskPlan(record: PaperOpenPositionRecord): { modified: boolean; record: PaperOpenPositionRecord } {
    let modified = false;
    const regime = regimeForSl(record.regimeAtEntry);
    
    if (record.stopPrice == null || !Number.isFinite(record.stopPrice)) {
      const mirrored = engineMirrorStopPrice(record.entryPrice, record.side, regime);
      if (mirrored != null && Number.isFinite(mirrored)) {
        record.stopPrice = mirrored;
        modified = true;
      }
    }

    if (record.targetPrice1 == null || !Number.isFinite(record.targetPrice1)) {
      const mirroredTp = engineMirrorTpPrice(record.entryPrice, record.side, regime);
      if (mirroredTp != null && Number.isFinite(mirroredTp)) {
        record.targetPrice1 = mirroredTp;
        modified = true;
      }
    }

    if (record.invalidationPx == null || !Number.isFinite(record.invalidationPx)) {
       if (record.stopPrice != null && Number.isFinite(record.stopPrice)) {
         record.invalidationPx = record.stopPrice;
         modified = true;
       }
    }

    return { modified, record };
  }

  public async writeOpenPositions(positions: PaperOpenPositionRecord[]): Promise<void> {
    await this.positions.saveOpenAll(positions);
  }

  public async writeClosedPositions(positions: PaperClosedPositionRecord[]): Promise<void> {
    for (const p of positions) {
      await this.positions.appendClosed(p);
    }
  }

  public computeOkxFilledNotionalUsdt(
    fillSize: number | string,
    fillPx: number | string,
    ctVal: number = 0.001
  ): number {
    const sz = Number(fillSize) || 0;
    const px = Number(fillPx) || 0;
    if (sz <= 0 || px <= 0) return 0;
    return sz * ctVal * px;
  }

  public async cancelOrder(symbol: string, ordId: string, algoId?: string): Promise<boolean> {
    if (!this.okxDemo) return false;
    if (algoId) {
      const res = await this.okxDemo.cancelAlgoOrder([{ instId: toOkxSwapInstId(symbol as MarketSymbol), algoId }]);
      return res.ok;
    }
    const res = await this.okxDemo.cancelOrder(toOkxSwapInstId(symbol as MarketSymbol), ordId);
    return res.ok;
  }

  public async prunePositions(symbol: string): Promise<void> {
    await this.removeClosedPositionFromLedger(symbol);
  }

  public async removeClosedPositionFromLedger(symbol: string): Promise<void> {
    const opens = await this.positions.loadOpenAll();
    const filtered = opens.filter((p) => p.symbol !== symbol);
    await this.writeOpenPositions(filtered);
  }

  private async helperUpsertPendingOrder(existingPendingList: any[], newPendingItem: any): Promise<void> {
    const list = [...(existingPendingList || [])];
    const idx = list.findIndex((p: any) => p && ((newPendingItem.ordId && p.ordId === newPendingItem.ordId) || (newPendingItem.clOrdId && p.clOrdId === newPendingItem.clOrdId)));
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...newPendingItem };
    } else {
      list.push(newPendingItem);
    }
    await (this.store as any)?.writePendingEntryOrders?.(list);
  }

  public async executeAuthorizedV2Action(args: {
    symbol: MarketSymbol;
    v2Decision: EngineV2Decision;
    lastPrice: number;
    committedRiskPlan: import("../engine-v2/types").V2CommittedRiskPlan;
  }): Promise<{ executed: boolean; submitResult?: any; blockReason?: string | null; updatedRecord?: PaperOpenPositionRecord; pendingOnly?: boolean }> {
    const { symbol, v2Decision, lastPrice, committedRiskPlan } = args;

    // BTC Suppressor (Requirement 5): Use okxSwapRowToLedgerKey parser exclusively
    let hasBtcLongActual = false;
    if (symbol === "BTCUSDT" && Array.isArray(this.lastLivePositionsPayload)) {
      for (const p of this.lastLivePositionsPayload) {
        const hit = okxSwapRowToLedgerKey(p as Record<string, unknown>);
        if (hit && hit.symbol === "BTCUSDT" && hit.side === "long") {
          hasBtcLongActual = true;
          break;
        }
      }
    }
    if (hasBtcLongActual) {
      await this.logAndSuppressBtcUsdtAction("v2_authorized_entry", "long", ["ENTER", "ADDON", "ORDER_SUBMIT"]);
      console.log("EXECUTE_AUTH_FAIL", "BTCUSDT_OKX_LONG_POSITION_PROTECTED");
      return { executed: false, blockReason: "BTCUSDT_OKX_LONG_POSITION_PROTECTED" };
    }

    // Requirement 1: executionAction strictly from v2Decision. NO RE-INFERRING!
    const executionAction = v2Decision.executionAction;
    if (!executionAction || (executionAction !== "ENTER" && executionAction !== "ADDON")) {
      console.log("EXECUTE_AUTH_FAIL", "ORDER_BUILD_FAIL_ACTION_INVALID");
      return { executed: false, blockReason: "ORDER_BUILD_FAIL_ACTION_INVALID" };
    }

    // Requirement 2: committedRiskPlan is MANDATORY. Zero re-assembly fallback from v2Decision!
    if (!committedRiskPlan) {
      console.log("EXECUTE_AUTH_FAIL", "ORDER_BUILD_FAIL_NO_PLAN");
      return { executed: false, blockReason: "ORDER_BUILD_FAIL_NO_PLAN" };
    }

    const plan = committedRiskPlan;

    // Requirement 2: Strict match of symbol, side, action with v2Decision
    if (plan.symbol !== symbol || plan.side !== v2Decision.side || plan.action !== executionAction) {
      console.log("EXECUTE_AUTH_FAIL", "ORDER_BUILD_FAIL_MISMATCH");
      return { executed: false, blockReason: "ORDER_BUILD_FAIL_MISMATCH" };
    }

    if (typeof v2Decision.risk?.finalOrderNotionalUsdt === "number" && v2Decision.risk.finalOrderNotionalUsdt > 0) {
      if (Math.abs(plan.finalOrderNotionalUsdt - v2Decision.risk.finalOrderNotionalUsdt) > 1e-4) {
        console.log("EXECUTE_AUTH_FAIL", "ORDER_BUILD_FAIL_NOTIONAL_MISMATCH");
        return { executed: false, blockReason: "ORDER_BUILD_FAIL_NOTIONAL_MISMATCH" };
      }
    }

    // Requirement 2: Timestamp & ageMs validation (0 <= ageMs <= 60000). No missing, infinite, or future timestamp!
    const nowTs = Date.now();
    if (typeof plan.ts !== "number" || !Number.isFinite(plan.ts)) {
      console.log("EXECUTE_AUTH_FAIL", "ORDER_BUILD_FAIL_TS_INVALID");
      return { executed: false, blockReason: "ORDER_BUILD_FAIL_TS_INVALID" };
    }
    const ageMs = nowTs - plan.ts;
    if (ageMs < 0 || ageMs > 60000) {
      console.log("EXECUTE_AUTH_FAIL", "ORDER_BUILD_FAIL_AGE", ageMs);
      return { executed: false, blockReason: "ORDER_BUILD_FAIL_AGE" };
    }

    // Requirement 2: Strict parameter validation without fallbacks (NO invalidationPx ?? stopPrice)
    const finalOrderNotionalUsdt = plan.finalOrderNotionalUsdt;
    const appliedLeverage = plan.appliedLeverage;
    const sideCandidate = plan.side;
    const stopPrice = plan.stopPrice;
    const invalidationPx = plan.invalidationPx;

    const notionalValid = typeof finalOrderNotionalUsdt === "number" && Number.isFinite(finalOrderNotionalUsdt) && finalOrderNotionalUsdt > 0;
    const leverageValid = typeof appliedLeverage === "number" && Number.isFinite(appliedLeverage) && appliedLeverage >= 1 && appliedLeverage <= 125;
    const stopValid = typeof stopPrice === "number" && Number.isFinite(stopPrice) && stopPrice > 0 &&
      (sideCandidate === "long" ? stopPrice < lastPrice : stopPrice > lastPrice);
    const invalidationValid = typeof invalidationPx === "number" && Number.isFinite(invalidationPx) && invalidationPx > 0 &&
      (sideCandidate === "long" ? invalidationPx < lastPrice : invalidationPx > lastPrice);

    if (!notionalValid || !leverageValid || !stopValid || !invalidationValid || !sideCandidate || (sideCandidate as string) === "none") {
      const br = `ORDER_BUILD_FAIL_PARAMS_${notionalValid}_${leverageValid}_${stopValid}_${invalidationValid}`;
      console.log("EXECUTE_AUTH_FAIL", br);
      return { executed: false, blockReason: br };
    }

    if (!this.okxDemo || this.signedSubmitMode() !== "enabled") {
      console.log("EXECUTE_AUTH_FAIL", "SIGNED_EXECUTION_NOT_READY", !!this.okxDemo, this.signedSubmitMode());
      return { executed: false, blockReason: "SIGNED_EXECUTION_NOT_READY" };
    }

    // Condition 5 & 7: Check pending orders. If active pending order exists for symbol, block duplicate order!
    const pendingList: any[] = (await (this.store as any)?.readPendingEntryOrders?.()) ?? [];
    const activePendingForSymbol = pendingList.find((p: any) => p && p.symbol === symbol && p.status !== "filled" && p.status !== "cancelled");
    if (activePendingForSymbol) {
      console.log("EXECUTE_AUTH_FAIL", "ACTIVE_PENDING_ORDER_EXISTS");
      return { executed: false, blockReason: "ACTIVE_PENDING_ORDER_EXISTS" };
    }

    const existingPositions = await this.positions.loadOpenAll();
    const existingProtectionPending = existingPositions.find((p) => p.symbol === symbol && (p.status as any) === "PROTECTION_PENDING");
    if (existingProtectionPending) {
      console.log("EXECUTE_AUTH_FAIL", "PROTECTION_PENDING");
      return { executed: false, blockReason: "PROTECTION_PENDING" };
    }
    const existing = existingPositions.find((p) => p.symbol === symbol && (p.status ?? "open") === "open");

    // Condition 6: Position authority check
    if (executionAction === "ENTER" && existing) {
      console.log("EXECUTE_AUTH_FAIL", "POSITION_AUTHORITY_MISMATCH");
      return { executed: false, blockReason: "POSITION_AUTHORITY_MISMATCH" };
    }
    if (executionAction === "ADDON") {
      if (!existing) {
        return { executed: false, blockReason: "NO_EXISTING_POSITION_FOR_ADDON" };
      }
      if (existing.side !== sideCandidate) {
        return { executed: false, blockReason: "ADDON_SIDE_MISMATCH" };
      }
    }

    const sharedParams = {
      symbol,
      sideCandidate: sideCandidate as "long" | "short",
      finalOrderNotionalUsdt,
      appliedLeverage,
      stopPrice,
      invalidationPx,
      lastPrice,
      existing,
      existingPositions,
      v2Decision,
      pendingList
    };

    switch (executionAction) {
      case "ENTER":
        return this.executeAuthorizedV2Entry(sharedParams);
      case "ADDON":
        return this.executeAuthorizedV2Addon(sharedParams);
      default:
        return { executed: false, blockReason: "NO_EXECUTION_ACTION" };
    }
  }

  // Common Entry execution handler (Requirement 2, 4)
  private async executeAuthorizedV2Entry(params: {
    symbol: MarketSymbol;
    sideCandidate: "long" | "short";
    finalOrderNotionalUsdt: number;
    appliedLeverage: number;
    stopPrice: number;
    invalidationPx: number;
    lastPrice: number;
    existingPositions: PaperOpenPositionRecord[];
    v2Decision: EngineV2Decision;
    pendingList: any[];
  }): Promise<{ executed: boolean; submitResult?: any; blockReason?: string | null; updatedRecord?: PaperOpenPositionRecord; pendingOnly?: boolean }> {
    const { symbol, sideCandidate, finalOrderNotionalUsdt, appliedLeverage, stopPrice, invalidationPx, lastPrice, existingPositions, v2Decision, pendingList } = params;

    const instMeta = getOkxInstrumentMeta(symbol);
    if (!instMeta) {
      return { executed: false, blockReason: "ORDER_BUILD_FAIL" };
    }

    const side = sideCandidate === "long" ? "buy" : "sell";
    const posSide = sideCandidate === "long" ? "long" : "short";
    const clOrdId = buildOkxClOrdId(symbol, side);
    const traceId = `v2_auth_${Date.now()}`;
    const calculatedContractQty = Math.max(instMeta.lotSz, finalOrderNotionalUsdt / Math.max(1, lastPrice * instMeta.ctVal));

    const submitRes = await this.submitOkxOrder({
      symbol,
      side,
      posSide,
      qty: calculatedContractQty,
      clOrdId,
      traceId,
      reason: "v2_authorized_signed_bridge",
      authoritySource: "v2",
      adoptedEngine: "V2",
      entryQualityGrade: "S",
      appliedLeverage,
      marketRegime: v2Decision.regime,
      entryPrice: lastPrice,
      stopPrice,
      isNewEntry: true,
      desiredNotionalUsdt: finalOrderNotionalUsdt,
      pricingReferencePx: lastPrice
    });

    if (!submitRes.ok) {
      return { executed: false, submitResult: submitRes };
    }

    const isFilled = submitRes.fillConfirmed === true || submitRes.orderState === "filled";

    if (isFilled && (!submitRes.fillPx || !submitRes.fillSize || Number(submitRes.fillPx) <= 0 || Number(submitRes.fillSize) <= 0)) {
      return { executed: false, blockReason: "FAIL_CLOSED_FILL_DETAILS_MISSING" };
    }

    const fillPx = submitRes.fillPx ? Number(submitRes.fillPx) : lastPrice;
    const fillSize = submitRes.fillSize ? Number(submitRes.fillSize) : 0;
    const filledNotional = isFilled ? (fillSize ? computeOkxFilledNotionalUsdt(fillSize, fillPx, instMeta.ctVal) : finalOrderNotionalUsdt) : (fillSize ? computeOkxFilledNotionalUsdt(fillSize, fillPx, instMeta.ctVal) : 0);

    // Unfilled or 0 filled notional -> record pending order via upsert
    if (!isFilled && filledNotional <= 0) {
      await this.helperUpsertPendingOrder(pendingList, {
        symbol,
        clOrdId,
        ordId: submitRes.ordId ?? "pending_ord",
        side,
        posSide,
        desiredNotionalUsdt: finalOrderNotionalUsdt,
        filledNotionalUsdt: 0,
        status: "live",
        submittedAt: Date.now()
      });
      return { executed: false, submitResult: submitRes, pendingOnly: true };
    }

    // Filled or Partially Filled with filledNotional > 0
    const openRecord: PaperOpenPositionRecord = {
      symbol,
      side: sideCandidate,
      entryPrice: fillPx,
      sizeUsd: filledNotional,
      initialSizeUsd: filledNotional,
      leverage: appliedLeverage,
      openedAt: Date.now(),
      entryStage: 1,
      stopPrice,
      invalidationPx,
      strategyVersion: "paper-v2",
      sourceSignal: "V2",
      sourceRunPath: "",
      status: "open",
      pos: fillSize || (filledNotional / fillPx),
      isV2Authority: true
    };

    // Condition 8: If protective stop order creation fails, mark protection pending and block new orders!
    let stopCreated = false;
    try {
      const okStop = await this.ensureProtectiveStopOrder(openRecord, `v2_bridge_auto:${symbol}:${openRecord.openedAt}`);
      stopCreated = Boolean(okStop && okStop.success !== false);
    } catch (e) {
      stopCreated = false;
    }

    if (!stopCreated) {
      openRecord.status = "PROTECTION_PENDING" as any;
      await this.writeOpenPositions([...existingPositions, openRecord]);
      return { executed: false, blockReason: "PROTECTION_PENDING", updatedRecord: openRecord };
    }

    await this.writeOpenPositions([...existingPositions, openRecord]);
    
    // If partial fill, upsert remaining pending balance
    if (!isFilled && filledNotional < finalOrderNotionalUsdt) {
      await this.helperUpsertPendingOrder(pendingList, {
        symbol,
        clOrdId,
        ordId: submitRes.ordId ?? "pending_partial_ord",
        side,
        posSide,
        desiredNotionalUsdt: finalOrderNotionalUsdt - filledNotional,
        filledNotionalUsdt: filledNotional,
        status: "partially_filled",
        submittedAt: Date.now()
      });
    }

    return { executed: true, submitResult: submitRes, updatedRecord: openRecord };
  }

  // Common Addon scale-in execution handler (Requirement 4)
  private async executeAuthorizedV2Addon(params: {
    symbol: MarketSymbol;
    sideCandidate: "long" | "short";
    finalOrderNotionalUsdt: number;
    appliedLeverage: number;
    stopPrice: number;
    invalidationPx: number;
    lastPrice: number;
    existing?: PaperOpenPositionRecord;
    existingPositions: PaperOpenPositionRecord[];
    v2Decision: EngineV2Decision;
    pendingList: any[];
  }): Promise<{ executed: boolean; submitResult?: any; blockReason?: string | null; updatedRecord?: PaperOpenPositionRecord; pendingOnly?: boolean }> {
    const { symbol, sideCandidate, finalOrderNotionalUsdt, appliedLeverage, stopPrice, invalidationPx, lastPrice, existing, existingPositions, v2Decision, pendingList } = params;

    if (!existing) {
      return { executed: false, blockReason: "NO_EXISTING_POSITION_FOR_ADDON" };
    }

    const instMeta = getOkxInstrumentMeta(symbol);
    if (!instMeta) {
      return { executed: false, blockReason: "ORDER_BUILD_FAIL" };
    }

    const side = sideCandidate === "long" ? "buy" : "sell";
    const posSide = sideCandidate === "long" ? "long" : "short";
    const clOrdId = buildOkxClOrdId(symbol, side);
    const traceId = `v2_auth_${Date.now()}`;
    const calculatedContractQty = Math.max(instMeta.lotSz, finalOrderNotionalUsdt / Math.max(1, lastPrice * instMeta.ctVal));

    const submitRes = await this.submitOkxOrder({
      symbol,
      side,
      posSide,
      qty: calculatedContractQty,
      clOrdId,
      traceId,
      reason: "scale_in_authorized",
      authoritySource: "v2",
      adoptedEngine: "V2",
      entryQualityGrade: "S",
      appliedLeverage,
      marketRegime: v2Decision.regime,
      entryPrice: lastPrice,
      stopPrice,
      isNewEntry: false, // Strictly false for add-on!
      desiredNotionalUsdt: finalOrderNotionalUsdt,
      pricingReferencePx: lastPrice
    });

    if (!submitRes.ok) {
      return { executed: false, submitResult: submitRes };
    }

    const isFilled = submitRes.fillConfirmed === true || submitRes.orderState === "filled";

    if (isFilled && (!submitRes.fillPx || !submitRes.fillSize || Number(submitRes.fillPx) <= 0 || Number(submitRes.fillSize) <= 0)) {
      return { executed: false, blockReason: "FAIL_CLOSED_FILL_DETAILS_MISSING" };
    }

    const fillPx = submitRes.fillPx ? Number(submitRes.fillPx) : lastPrice;
    const fillSize = submitRes.fillSize ? Number(submitRes.fillSize) : 0;
    const filledNotional = isFilled ? (fillSize ? computeOkxFilledNotionalUsdt(fillSize, fillPx, instMeta.ctVal) : finalOrderNotionalUsdt) : (fillSize ? computeOkxFilledNotionalUsdt(fillSize, fillPx, instMeta.ctVal) : 0);

    // Unfilled or 0 fill -> upsert pending order via helperUpsertPendingOrder
    if (!isFilled && filledNotional <= 0) {
      await this.helperUpsertPendingOrder(pendingList, {
        symbol,
        clOrdId,
        ordId: submitRes.ordId ?? "pending_addon_ord",
        side,
        posSide,
        desiredNotionalUsdt: finalOrderNotionalUsdt,
        filledNotionalUsdt: 0,
        status: "live",
        submittedAt: Date.now()
      });
      return { executed: false, submitResult: submitRes, pendingOnly: true };
    }

    // Filled or Partially Filled with filledNotional > 0
    const newTotalSizeUsd = existing.sizeUsd + filledNotional;
    const newEntryPrice = (existing.entryPrice * existing.sizeUsd + fillPx * filledNotional) / newTotalSizeUsd;
    const nextStage = (existing.entryStage ?? 1) + 1;

    const updatedRecord: PaperOpenPositionRecord = {
      ...existing,
      sizeUsd: newTotalSizeUsd,
      entryPrice: newEntryPrice,
      entryStage: nextStage,
      addonCount: nextStage - 1,
      lifecycleState: "ADDON_ACTIVE",
      stopPrice,
      invalidationPx
    };

    // Rebuild protective stop order for filled portion
    let stopCreated = false;
    try {
      const okStop = await this.ensureProtectiveStopOrder(updatedRecord, `v2_bridge_addon:${symbol}:${Date.now()}`);
      stopCreated = Boolean(okStop && okStop.success !== false);
    } catch (e) {
      stopCreated = false;
    }

    if (!stopCreated) {
      updatedRecord.status = "PROTECTION_PENDING" as any;
      const otherPositions = existingPositions.filter(p => p.symbol !== symbol);
      await this.writeOpenPositions([...otherPositions, updatedRecord]);
      return { executed: false, blockReason: "PROTECTION_PENDING", updatedRecord };
    }

    const otherPositions = existingPositions.filter(p => p.symbol !== symbol);
    await this.writeOpenPositions([...otherPositions, updatedRecord]);

    // Partial fill -> upsert remaining pending balance
    if (!isFilled && filledNotional < finalOrderNotionalUsdt) {
      await this.helperUpsertPendingOrder(pendingList, {
        symbol,
        clOrdId,
        ordId: submitRes.ordId ?? "pending_addon_partial",
        side,
        posSide,
        desiredNotionalUsdt: finalOrderNotionalUsdt - filledNotional,
        filledNotionalUsdt: filledNotional,
        status: "partially_filled",
        submittedAt: Date.now()
      });
    }

    return { executed: true, submitResult: submitRes, updatedRecord };
  }
}

const PAPER_LEDGER_KRW_NOTIONAL_PER_USD = 1400;

function computeLedgerSymbolExposureNotionalKrw(
  opens: ReadonlyArray<PaperOpenPositionRecord>,
  symbol: string
): number {
  let sum = 0;
  for (const o of opens) {
    if (String(o.symbol) !== symbol || (o.status ?? "open") !== "open") continue;
    const lev = typeof o.leverage === "number" && Number.isFinite(o.leverage) && o.leverage > 0 ? o.leverage : 1;
    sum += Math.max(0, o.sizeUsd) * lev * PAPER_LEDGER_KRW_NOTIONAL_PER_USD;
  }
  return Math.round(sum);
}

function mergeEngineSymbolDecisionsWithOpenLedgerExposure(
  decisionBySymbol: ReadonlyMap<string, PaperEngineDecisionEnvelope>,
  opens: ReadonlyArray<PaperOpenPositionRecord>,
  accountEquityKrw: number,
  proofLogger: Logger
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of decisionBySymbol.entries()) {
    const base = buildEngineStateSymbolDecision(v);
    const prev = typeof base.exposure_notional_krw === "number" ? base.exposure_notional_krw : 0;
    const recon = computeLedgerSymbolExposureNotionalKrw(opens, k);
    const eqMul = accountEquityKrw > 0 ? recon / accountEquityKrw : 0;
    proofLogger.info("POSITION_EXPOSURE_RECONCILE_PROOF", {
      symbol: k,
      exposure_notional_krw_before_authority: prev,
      exposure_notional_krw_open_ledger: recon,
      exposure_notional_krw_after: recon,
      equity_multiple_after: eqMul,
      open_leg_count: opens.filter((o) => String(o.symbol) === k && (o.status ?? "open") === "open").length
    });
    out[k] = {
      ...base,
      exposure_notional_krw: recon,
      equity_multiple: eqMul
    };
  }
  return out;
}

/**
 * ENGINE STATE SUMMARY HELPER (Phase 2 Extraction)
 * Promotes authority-first status for terminal/dashboard state.
 */
function buildEngineStateSymbolDecision(envelope: PaperEngineDecisionEnvelope): Record<string, unknown> {
  const { legacy, authority, selector } = envelope;
  const adopted = selector?.adopted_result.engine ?? null;
  return {
    decision: legacy.decision.final_decision,
    adaptiveOk: legacy.adaptiveOk,
    
    reject_reason: legacy.decision.reject_reason ?? null,
    risk_state: legacy.decision.risk_state ?? null,
    risk_cooldown_subreason: legacy.decision.risk_cooldown_subreason ?? null,
    final_decision: legacy.decision.final_decision,
    fail_stage: legacy.decision.stage1_result_code ?? null,

    authority_decision: authority.decision,
    authority_side: authority.side,
    authority_stage_margin_krw: authority.decision === "ENTER" ? authority.stageMarginKrw : 0,
    authority_size_usdt: authority.decision === "ENTER" ? (authority.stageMarginKrw / PAPER_LEDGER_KRW_NOTIONAL_PER_USD) : 0,
    authority_source: authority.source,
    authority_owner: authority.source,
    final_engine_owner: adopted ?? authority.source,

    selector_engine: adopted ?? "unknown",
    adopted_engine: adopted ?? "unknown",
    adoption_reason: selector?.adopted_result.adoption_reason ?? "no_selector_result",

    v1_decision: envelope.v1_decision ?? legacy.decision.final_decision,
    v1_side: envelope.v1_side ?? legacy.intentSide ?? "none",
    v1_size: envelope.v1_size ?? legacy.executorDecision?.total_cost ?? 0,

    v2_decision: envelope.v2_decision ?? selector?.v2_result.decision ?? "SKIP",
    v2_side: envelope.v2_side ?? selector?.v2_result.side ?? "none",
    v2_size: envelope.v2_size ?? selector?.v2_result.risk.stageMarginKrw ?? 0,
    micro_execution_score: selector?.v2_result.microExecution?.score ?? null,
    micro_execution_grade: selector?.v2_result.microExecution?.grade ?? null,
    micro_execution_delay_ms: selector?.v2_result.microExecution?.delayMs ?? null,
    micro_execution_fallback_neutral: selector?.v2_result.microExecution?.fallbackNeutral ?? null,
    v2_lifecycle_stage: selector?.v2_result.lifecycleAuthority?.lifecycleStage ?? null,
    v2_position_state_owner: selector?.v2_result.lifecycleAuthority?.positionStateOwner ?? null,
    v2_partial_action:
      selector?.v2_result.v2PartialAuthority?.partialAction ??
      selector?.v2_result.lifecycleAuthority?.partialAction ??
      null,
    v2_partial_reason: selector?.v2_result.v2PartialAuthority?.partialReason ?? null,
    v2_partial_urgency: selector?.v2_result.v2PartialAuthority?.partialUrgency ?? null,
    v2_partial_confidence: selector?.v2_result.v2PartialAuthority?.partialConfidence ?? null,
    v2_paper_partial_agreement: null,
    partial_authority_owner: selector?.v2_result.v2PartialAuthority?.partialAuthorityOwner ?? null,
    partial_execution_owner: selector?.v2_result.v2PartialAuthority?.partialExecutionOwner ?? null,
    v2_exit_action:
      selector?.v2_result.v2ExitAuthority?.exitAction ??
      selector?.v2_result.lifecycleAuthority?.exitAction ??
      null,
    v2_exit_reason: selector?.v2_result.v2ExitAuthority?.exitReason ?? null,
    v2_exit_urgency: selector?.v2_result.v2ExitAuthority?.exitUrgency ?? null,
    v2_exit_confidence: selector?.v2_result.v2ExitAuthority?.exitConfidence ?? null,
    v2_paper_exit_agreement: null,
    exit_authority_owner: selector?.v2_result.v2ExitAuthority?.exitAuthorityOwner ?? null,
    exit_execution_owner: selector?.v2_result.v2ExitAuthority?.exitExecutionOwner ?? null,
    v2_cooldown_action: envelope.v2_cooldown_action ?? null,
    v2_cooldown_type: envelope.v2_cooldown_type ?? null,
    v2_cooldown_reason: envelope.v2_cooldown_reason ?? null,
    v2_cooldown_urgency: envelope.v2_cooldown_urgency ?? null,
    v2_cooldown_remaining_ms: envelope.v2_cooldown_remaining_ms ?? null,
    v2_direction_blocked: envelope.v2_direction_blocked ?? null,
    v2_paper_cooldown_agreement: envelope.v2_paper_cooldown_agreement ?? null,
    cooldown_authority_owner: envelope.cooldown_authority_owner ?? null,
    cooldown_execution_owner: envelope.cooldown_execution_owner ?? null,
    v2_lifecycle_consistency_pass: selector?.v2_result.lifecycleAuthority?.consistencyPass ?? null,
    v2_lifecycle_inconsistency_reasons: selector?.v2_result.lifecycleAuthority?.inconsistencyReasons ?? null,
    v2_legacy_intervention_detected: selector?.v2_result.lifecycleAuthority?.legacyInterventionDetected ?? null,
    entry_quality_grade: selector?.v2_result.risk.entryQualityGrade ?? authority.entryQualityGrade ?? "B",
    leverage_profile: selector?.v2_result.risk.leverageProfile ?? authority.leverageProfile ?? "BASE",
    applied_leverage: selector?.v2_result.risk.appliedLeverage ?? authority.appliedLeverage ?? 0,
    leverage_reason: selector?.v2_result.risk.leverageReason ?? authority.leverageReason ?? null,
    leverage_block_reason: selector?.v2_result.risk.leverageBlockReason ?? authority.leverageBlockReason ?? null,
    exposure_notional_krw: selector?.v2_result.risk.exposureNotionalKrw ?? authority.exposureNotionalKrw ?? 0,
    equity_multiple: selector?.v2_result.risk.equityMultiple ?? authority.equityMultiple ?? 0,

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
    authority_stage_margin_krw: useExecuted ? (executedEntrySizeUsd * PAPER_LEDGER_KRW_NOTIONAL_PER_USD) : authority.decision === "ENTER" ? authority.stageMarginKrw : 0,
    authority_size_usdt: useExecuted ? executedEntrySizeUsd : authority.decision === "ENTER" ? (authority.stageMarginKrw / PAPER_LEDGER_KRW_NOTIONAL_PER_USD) : 0,
    authority_source: authority.source,
    authority_regime: authority.regime,
    entry_quality_grade: authority.entryQualityGrade ?? null,
    leverage_profile: authority.leverageProfile ?? "BASE",
    applied_leverage: authority.appliedLeverage ?? 0,
    leverage_reason: authority.leverageReason ?? null,
    leverage_block_reason: authority.leverageBlockReason ?? null,
    exposure_notional_krw: authority.exposureNotionalKrw ?? 0,
    equity_multiple: authority.equityMultiple ?? 0,
    add_on_allowed: authority.addOnAllowed ?? false
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
    breakoutFailureRate: snap.breakoutFailureRate ?? 0,
    trendWeaknessScore: snap.trendWeaknessScore ?? 0,
    rangeOscillationScore: snap.rangeOscillationScore ?? 0,
    ema20: snap.ema20 ?? 0,
    emaGap: snap.emaGap ?? 0,
    atr: snap.atr ?? 0,
    signal: snap.signal ?? "NONE",
    qualityScore: snap.qualityScore ?? 0,
    entryCandidate: snap.entryCandidate ?? false,
    signalGateBlockedReason: snap.signalGateBlockedReason ?? null,
    rangeSignalDowngraded: snap.rangeSignalDowngraded ?? false,
    rangeSignalKeptByRelax: snap.rangeSignalKeptByRelax ?? false,
    swingHighSlope: snap.swingHighSlope ?? 0,
    swingLowSlope: snap.swingLowSlope ?? 0,
    rangeCenterSlope: snap.rangeCenterSlope ?? 0,
    boxHighSlope: snap.boxHighSlope ?? 0,
    boxLowSlope: snap.boxLowSlope ?? 0,
    ema20Slope: snap.ema20Slope ?? 0,
    ema60Slope: snap.ema60Slope ?? 0,
    atrExpansion: snap.atrExpansion ?? 0,
    volumeExpansion: snap.volumeExpansion ?? 0,
    candles: snap.candles ?? [],
    htf_candles: snap.htf_candles
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

export function buildV2ConfigBridge(config: EngineConfig): V2BridgeConfig {
  return {
    baseSizeUsd: computePaperSizingAnchorUsd(config),
    maxOpenPositions: config.paperMaxOpenPositions,
    reentryCooldownMs: config.paperReentryCooldownMs,
    okxLiveMaxOrderNotionalUsdt: config.okxLiveMaxOrderNotionalUsdt ?? null,
    okxLiveMaxAddonNotionalUsdt: config.okxLiveMaxAddonNotionalUsdt ?? null,
    okxLiveMaxSymbolNotionalUsdt: config.okxLiveMaxSymbolNotionalUsdt ?? null,
    okxLiveMaxAccountNotionalUsdt: config.okxLiveMaxAccountNotionalUsdt ?? null,
    okxLiveMaxAddonCount: config.okxLiveMaxAddonCount ?? null
  };
}

export function buildV2StateBridge(
  opensAfterClose: ReadonlyArray<PaperOpenPositionRecord>,
  lastRisk: RiskControlDecision | null,
  config: EngineConfig,
  paperExecutionReady: boolean,
  signedExecutionReady: boolean,
  freshTickBarrierActive: boolean,
  freshTickExecutionBlocked: boolean,
  freshTickCompletedCycles: number,
  freshTickRequiredCycles: number,
  entryQualityProfiles: {
    profit: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number };
    loss: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number };
    contaminated: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number };
  },
  serverTradeControlState: ServerTradeControlState,
  reconcileSafeModeActive: boolean,
  lastLivePositionsPayload?: ReadonlyArray<Record<string, unknown>> | null,
  liveBalanceReady?: boolean,
  okxWalletBalanceUsdt?: number | null,
  okxAvailableBalanceUsdt?: number | null,
  okxPositionsOk?: boolean,
  okxPendingOrdersReady?: boolean,
  pendingOrdersNotionalUsdt?: number,
  pendingSymbolNotionalUsdt?: number,
  balanceFetchedAt?: number,
  positionsFetchedAt?: number,
  pendingOrdersFetchedAt?: number
): V2BridgeState {
  let okxActualSide = "none";
  if (lastLivePositionsPayload && Array.isArray(lastLivePositionsPayload)) {
    for (const p of lastLivePositionsPayload) {
      const hit = okxSwapRowToLedgerKey(p as Record<string, unknown>);
      if (hit && hit.symbol === "BTCUSDT") {
        okxActualSide = hit.side;
        break;
      }
    }
  }

  const okxActualPositions = Array.isArray(lastLivePositionsPayload)
    ? lastLivePositionsPayload.map((p) => {
        const hit = okxSwapRowToLedgerKey(p as Record<string, unknown>);
        const symbol = hit?.symbol ?? (p as any).symbol ?? String((p as any).instId ?? "").replace("-SWAP", "").replace("-USDT", "USDT");
        const rawSide = hit?.side ?? (p as any).side ?? (p as any).posSide ?? "";
        const sideStr = String(rawSide).toLowerCase();
        const normSideStr = sideStr === "buy" ? "long" : sideStr === "sell" ? "short" : sideStr;
        const rawNotional = Number((p as any).notionalUsd ?? (p as any).notionalUSDT ?? (p as any).sizeUsd ?? 0);
        return {
          symbol,
          side: normSideStr === "long" ? "LONG" : normSideStr === "short" ? "SHORT" : normSideStr.toUpperCase(),
          sizeUsd: Math.abs(rawNotional),
          notionalUsd: Math.abs(rawNotional)
        };
      })
    : undefined;

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
          entryStage: p.entryStage ?? 1,
          peakUnrealizedPnlPct: p.peakUnrealizedPnlPct,
          peakPnlUpdatedAt: p.peakPnlUpdatedAt,
          breakevenStopRequired: p.breakevenStopRequired,
          breakevenStopConfirmed: p.breakevenStopConfirmed,
          breakevenStopPrice: p.breakevenStopPrice
        };
      })
      .filter((x): x is V2BridgePosition => x !== null),
    globalRiskScore: 0.5,
    lossStreaks: lastRisk?.recentLossStreakByMode ?? {},
    directionalShockState: (lastRisk?.directionalShockState ?? "UNKNOWN") as "UP" | "DOWN" | "NONE" | "UNKNOWN",
    longAllow: lastRisk?.longAllow ?? true,
    shortAllow: lastRisk?.shortAllow ?? true,
    executionReadiness: paperExecutionReady,
    paperExecutionReady,
    signedExecutionReady,
    okxAuthMode: config.okxAuthMode,
    okxAuthReady: config.okxAuthReady,
    okxExchangeAuthOptIn: config.okxExchangeAuthOptIn,
    okxLiveEnabled: config.okxLiveEnabled,
    okxDemoEnabled: config.okxDemoEnvRequested,
    okxApiKeyPresent: config.okxAuthMode === "live" ? config.okxApiKey.length > 0 : config.okxDemoApiKey.length > 0,
    okxApiSecretPresent: config.okxAuthMode === "live" ? config.okxApiSecret.length > 0 : config.okxDemoApiSecret.length > 0,
    okxPassphrasePresent: config.okxAuthMode === "live" ? config.okxPassphrase.length > 0 : config.okxDemoPassphrase.length > 0,
    okxSimulatedTradingHeaderEnabled: config.okxSimulatedTradingHeaderEnabled,
    liveMaxOrderNotionalUsdt: config.okxLiveMaxOrderNotionalUsdt ?? null,
    liveMaxAddonNotionalUsdt: config.okxLiveMaxAddonNotionalUsdt ?? null,
    liveMaxSymbolNotionalUsdt: config.okxLiveMaxSymbolNotionalUsdt ?? null,
    liveMaxAccountNotionalUsdt: config.okxLiveMaxAccountNotionalUsdt ?? null,
    liveMaxAddonCount: config.okxLiveMaxAddonCount ?? null,
    okxLiveMaxOrderNotionalUsdt: config.okxLiveMaxOrderNotionalUsdt ?? null,
    okxLiveMaxAddonNotionalUsdt: config.okxLiveMaxAddonNotionalUsdt ?? null,
    okxLiveMaxSymbolNotionalUsdt: config.okxLiveMaxSymbolNotionalUsdt ?? null,
    okxLiveMaxAccountNotionalUsdt: config.okxLiveMaxAccountNotionalUsdt ?? null,
    okxLiveMaxAddonCount: config.okxLiveMaxAddonCount ?? null,
    liveBalanceReady: liveBalanceReady ?? false,
    accountEquityUsdt: okxWalletBalanceUsdt ?? undefined,
    availableBalanceUsdt: okxAvailableBalanceUsdt ?? undefined,
    okxActualPositionsReady: okxPositionsOk ?? Array.isArray(lastLivePositionsPayload),
    actualAccountNotionalUsdtReady: okxPositionsOk ?? Array.isArray(lastLivePositionsPayload),
    okxActualPositions,
    okxPendingOrdersReady: okxPendingOrdersReady ?? true,
    okxPendingOrdersNotionalUsdt: pendingOrdersNotionalUsdt,
    okxPendingSymbolNotionalUsdt: pendingSymbolNotionalUsdt,
    balanceFetchedAt,
    positionsFetchedAt,
    pendingOrdersFetchedAt,
    freshTickBarrierActive,
    freshTickExecutionBlocked,
    freshTickCompletedCycles,
    freshTickRequiredCycles,
    entryQualityProfiles,
    serverTradeEnabled: serverTradeControlState.server_trade_enabled,
    closeOnlyMode: serverTradeControlState.close_only_mode,
    killSwitch: serverTradeControlState.kill_switch_active,
    reconcileSafeMode: reconcileSafeModeActive,
    killSwitchActive: serverTradeControlState.kill_switch_active,
    reconcileSafeModeActive,
    riskMode: lastRisk?.riskStatus ?? undefined,
    dailyLossGuardTriggered: lastRisk?.dailyLossGuardTriggered ?? false,
    crashState: lastRisk?.crashState ?? undefined,
    pumpState: lastRisk?.pumpState ?? undefined,
    pump_state: lastRisk?.pumpState ?? undefined,
    accountEquityKrw: 500_000,
    maxUsableMarginKrw: 420_000,
    exposureNotionalCapKrw: 2_000_000,
    symbolExposureNotionalCapKrw: 1_400_000,
    okxActualSide
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

export function computeOkxFilledNotionalUsdt(
  fillSize: number | string,
  fillPx: number | string,
  ctVal: number = 0.001
): number {
  const sz = Number(fillSize) || 0;
  const px = Number(fillPx) || 0;
  if (sz <= 0 || px <= 0) return 0;
  return sz * ctVal * px;
}

export interface OkxInstrumentMeta {
  ctVal: number;
  ctValCcy: string;
  lotSz: number;
}

export const OKX_INSTRUMENT_SPECS: Record<string, OkxInstrumentMeta> = {
  "ETHUSDT": { ctVal: 0.1, ctValCcy: "ETH", lotSz: 0.1 },
  "ETH-USDT-SWAP": { ctVal: 0.1, ctValCcy: "ETH", lotSz: 0.1 },
  "BTCUSDT": { ctVal: 0.01, ctValCcy: "BTC", lotSz: 0.01 },
  "BTC-USDT-SWAP": { ctVal: 0.01, ctValCcy: "BTC", lotSz: 0.01 },
  "SOLUSDT": { ctVal: 1, ctValCcy: "SOL", lotSz: 1 },
  "SOL-USDT-SWAP": { ctVal: 1, ctValCcy: "SOL", lotSz: 1 },
  "XRPUSDT": { ctVal: 100, ctValCcy: "XRP", lotSz: 1 },
  "XRP-USDT-SWAP": { ctVal: 100, ctValCcy: "XRP", lotSz: 1 }
};

export function getOkxInstrumentMeta(symbol: string): OkxInstrumentMeta | null {
  const norm = String(symbol).trim().toUpperCase();
  if (OKX_INSTRUMENT_SPECS[norm]) return OKX_INSTRUMENT_SPECS[norm];
  const swapNorm = norm.includes("-SWAP") ? norm : `${norm.replace("USDT", "")}-USDT-SWAP`;
  if (OKX_INSTRUMENT_SPECS[swapNorm]) return OKX_INSTRUMENT_SPECS[swapNorm];
  return null;
}

