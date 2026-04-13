import * as path from "node:path";

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
  TrendBreakoutDirection
} from "../models/types";
import type { Logger } from "../logs/logger";
import { JsonStore } from "../storage/json-store";
import type { BybitPublicDiagnostics } from "../exchange/bybit-public";
import { BybitPublicClient } from "../exchange/bybit-public";
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
import { aiApproveEntry, aiInputFromDecision } from "../ai/entry-approval";
import {
  aggregateRejectReasonCountsTick,
  computeFunnelTick,
  DECISION_FUNNEL_RING_MAX,
  sumDecisionFunnelTicks
} from "./decision-funnel";
import { evaluatePaperSymbolEntry, type EvaluatePaperSymbolEntryResult } from "./paper-symbol-decision";
import {
  computePaperCloseLegMetrics,
  finalizePaperClosedRecord,
  paperExitDisplayMeta,
  type PaperCloseLegMetrics
} from "./paper-close-finalize";
import { evaluateMarketModeSelector } from "./mode-selector";
import { evaluateRiskExposure } from "./risk-exposure";
import { buildPaperExplanation } from "./explanation-layer";
import {
  evaluateRangeEngineForSymbol,
  evaluateRangeStructuralExit,
  evaluateRangeReopenAllowed,
  computeRangeEdgeIntensity01,
  marginsForSymbol,
  rangeCycleSizePolicy,
  rangeLadderLegMultiplier,
  rangeAccumulationRecoveryMultiplier,
  RANGE_REOPEN_WINDOW_MS,
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
}>;

export type SymbolDiagnostic = Readonly<{
  symbol: MarketSymbol;
  endpoint: string;
  httpStatus: number;
  retCode?: number;
  retMsg?: string;
  requestUrl: string;
}>;

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

function buildSignalSummary(snapshots: ReadonlyArray<SymbolSnapshot>): RunMeta["signalSummary"] {
  const totalSymbols = snapshots.length;
  const longCandidates = snapshots.filter((s) => s.signal === "paper_long_candidate").length;
  const shortCandidates = snapshots.filter((s) => s.signal === "paper_short_candidate").length;
  return {
    totalSymbols,
    longCandidates,
    shortCandidates,
    neutralSymbols: totalSymbols - longCandidates - shortCandidates
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
  const side =
    res.intentSide ??
    (first.signal === "paper_long_candidate" ? "long" : first.signal === "paper_short_candidate" ? "short" : null);
  return {
    order_build_ok: false,
    order_build_fail_reason: d.order_build_fail_reason ?? af?.orderBuildFailReason ?? "unknown",
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
    order_build_fail_stage: d.order_build_fail_stage ?? af?.failStage ?? null,
    adaptive_detail: res.adaptiveDetail ?? af?.detail ?? null
  };
}

export class PaperEngine {
  private readonly store: JsonStore;
  private readonly bybit: BybitPublicClient;
  private readonly positions: PositionManager;
  private readonly risk: RiskManager;
  private lastAdaptiveMode: Readonly<{ mode: FuturesMarketMode; detail: Record<string, unknown> }> = { mode: "sideways", detail: {} };
  private lastRegime: MarketRegimeDetection = INITIAL_ENGINE_REGIME;
  private lastRisk: RiskControlDecision | null = null;
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
  /** TREND 스위칭 시각(1h 카운트 → selector). */
  private trendSwitchTimestampsMs: number[] = [];
  /** RANGE 재진입 성공 시각(윈도 내 횟수 제한). */
  private rangeReopenTimestampsBySymbol = new Map<string, number[]>();
  private trendFollowScoreBySymbol = new Map<string, number>();
  private trendBreakoutConfidenceBySymbol = new Map<string, number>();
  private rangeRoundTripStreakBySymbol = new Map<string, number>();
  private rangeRecentOutcomeScoresBySymbol = new Map<string, number[]>();
  private lastExitReasonLabel = "";
  private lastSwitchReasonLabel = "";

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
    await this.positions.ensureHistoryFile();
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
    const regimeDetected: MarketRegimeDetection = btc5r.ok
      ? detectMarketRegime({ btcCandles5m: btc5 })
      : regimeWhenBtcFeedFailed(btc5r.error ?? "btc_candles_unavailable");
    this.lastRegime = regimeDetected;
    this.logger.info("regime_decision", {
      regime_final: regimeDetected.log.regime_final,
      regime_raw: regimeDetected.log.regime_raw,
      no_trade_reason: regimeDetected.log.no_trade_reason,
      unknown_reason: regimeDetected.log.unknown_reason,
      data_ready: regimeDetected.log.data_ready,
      dump_protection_hit: regimeDetected.log.dump_protection_hit,
      volatility_guard_hit: regimeDetected.log.volatility_guard_hit,
      len_btc_5m: btc5.length,
      btc_feed_ok: btc5r.ok
    });
    if (regimeDetected.regime !== prevRegime) {
      this.lastModeChangeAt = Date.now();
      await this.store.appendJsonlLine("reports/events.jsonl", {
        ts: this.lastModeChangeAt,
        type: "MODE_CHANGE",
        regime: regimeDetected.regime,
        from: prevRegime,
        executor: regimeDetected.regime === "RANGE" ? "RANGE" : regimeDetected.regime === "TREND" ? "TREND" : "IDLE"
      });
    }
    const adaptiveMode: FuturesMarketMode =
      regimeDetected.regime === "TREND" ? "trend" : regimeDetected.regime === "RANGE" ? "sideways" : "risk_off";
    this.lastAdaptiveMode = { mode: adaptiveMode, detail: regimeDetected.detail };

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
        this.logger.error("pollSymbol_failed", { symbol, error: result.error });
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

    const meta: RunMeta = {
      strategyVersion: "paper-v1",
      signalSummary,
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
      notes: `paper-v1 EMA20/EMA60 1m long/short; +0.5%/-1.0% net TP/SL; 3m min_hold + 5m grace; public-only; ${klineTimeframe}`
    };

    let metaPath: string | undefined;
    try {
      metaPath = await this.store.writeSnapshotLatestMeta(meta);
      this.logger.info("snapshot_latest_meta_saved", { metaPath });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("snapshot_latest_meta_save_failed", { error: msg });
    }

    const hasAnyCandidate = snapshots.some(
      (s) => s.signal === "paper_long_candidate" || s.signal === "paper_short_candidate"
    );
    let candidateRunPath: string | undefined;
    if (hasAnyCandidate && latestPath && metaPath) {
      try {
        const candidateSymbols = snapshots
          .filter(
            (s) => s.signal === "paper_long_candidate" || s.signal === "paper_short_candidate"
          )
          .map((s) => String(s.symbol));
        candidateRunPath = await this.store.writePaperCandidateRun(fetchedAt, {
          fetchedAt,
          strategyVersion: "paper-v1",
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
          strategyVersion: "paper-v1",
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
    const marketModeOut = evaluateMarketModeSelector({
      regimeDetection: regimeDetected,
      fetchedAt,
      snapshotCount: snapshots.length,
      errorCount: errors.length,
      volatilityProxy,
      recentTrendSwitchCount1h: this.pruneTrendSwitches1h(fetchedAt),
      boxCohesion01
    });
    this.lastMarketMode = marketModeOut;
    const riskExposureOut = evaluateRiskExposure({
      config: this.config,
      marketMode: marketModeOut,
      risk: this.lastRisk!,
      openPositionCount: opensBeforeClose.length,
      fetchedAtMs: fetchedAt
    });
    this.lastRiskExposure = riskExposureOut;

    await this.tryPaperPositionClose({
      snapshots,
      errorsCount: errors.length,
      latestPath,
      metaPath,
      filePath,
      marketMode: marketModeOut,
      riskExposure: riskExposureOut
    });

    const explanationOut = buildPaperExplanation({
      marketMode: marketModeOut,
      risk: riskExposureOut,
      exitHint: this.lastExitReasonLabel,
      switchHint: this.lastSwitchReasonLabel
    });
    this.lastExplanation = explanationOut;

    const opensAfterClose = await this.positions.loadOpenAll();
    const lastCloseMetaBySymbolForDecision =
      this.config.paperReentryCooldownMs > 0 ? latestCloseMetaBySymbol(await this.store.readPositionsHistory()) : null;
    const regimeUnknown = btc5.length < MIN_BTC_5M_BARS_REGIME;
    const decisionBySymbol = new Map<string, EvaluatePaperSymbolEntryResult>();
    const nowTick = Date.now();
    this.lastTickRangeEvalBySymbol.clear();

    for (const sym of symbols) {
      const snap = snapshots.find((s) => s.symbol === sym) ?? null;
      if (!snap) {
        const res = evaluatePaperSymbolEntry({
          config: this.config,
          snapshot: null,
          dataReady: false,
          regime: regimeDetected.regime,
          regimeDetail: regimeDetected.detail,
          regimeUnknown,
          isAmbiguous: regimeDetected.isAmbiguous,
          risk: this.lastRisk,
          adaptiveMode: this.lastAdaptiveMode.mode,
          adaptiveDetail: this.lastAdaptiveMode.detail,
          now: nowTick,
          rangeCooldownUntilByKey: this.rangeCooldownUntilByKey,
          trendCooldownUntilBySymbol: this.trendCooldownUntilBySymbol,
          lastCloseMetaBySymbol: lastCloseMetaBySymbolForDecision,
          reentryCooldownMs: this.config.paperReentryCooldownMs,
          sameDirCooldownMult: SAME_DIR_REENTRY_COOLDOWN_MULT,
          hasOpenPosition: false,
          currentStage: 0,
          maxPositionsReached: false,
          rangeReopenCooldownBypass: false
        });
        decisionBySymbol.set(String(sym), res);
        try {
          await this.store.appendJsonlLine("reports/decisions.jsonl", { ...res.decision, pipeline: "v1" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.error("decisions_jsonl_append_failed", { error: msg, symbol: String(sym) });
        }
        continue;
      }
      const openPos = opensAfterClose.find((o) => o.symbol === snap.symbol && o.status === "open");
      const hasOpen = !!openPos;
      const currentStage = openPos?.entryStage ?? 0;
      const isCandidate = snap.signal === "paper_long_candidate" || snap.signal === "paper_short_candidate";

      const rev = this.reviewingState.get(String(snap.symbol));
      let reviewingTicks = rev?.ticks ?? 0;
      let autoEntryTriggered = false;

      // Condition-maintained auto-entry check for Stage 1
      if (isCandidate && currentStage === 0 && !hasOpen) {
        if (rev) {
          const qualityDropped = snap.qualityScore < rev.initialQuality - 1; // Strict stability (max 1pt drop)
          const highEnough = snap.qualityScore >= 40; // Maintain absolute minimum quality

          const isMajor = snap.symbol === "BTCUSDT" || snap.symbol === "ETHUSDT";
          const tickThreshold = isMajor ? 3 : 4; // Round 4: Faster Stage 1 entry (Majors 3 ticks, Others 4 ticks)

          if (!qualityDropped && highEnough && rev.ticks >= tickThreshold) {
            autoEntryTriggered = true;
          }
        }
      }

      const rrKey = String(snap.symbol);
      const marginOpens = opensAfterClose.filter((o) => o.status === "open");
      const { longUsd, shortUsd } = marginsForSymbol(marginOpens, rrKey);
      const rr0 = this.rangeRuntimeBySymbol.get(rrKey) ?? {
        lastZone: null as RangeBoxZone | null,
        cycle: 0,
        ladder: 0
      };
      const rsEval = evaluateRangeEngineForSymbol({
        symbol: rrKey,
        lastPrice: snap.lastPrice,
        boxHigh: snap.boxHigh,
        boxLow: snap.boxLow,
        boxPos: snap.boxPos,
        marketMode: marketModeOut,
        longMarginUsd: longUsd,
        shortMarginUsd: shortUsd,
        rangeCycleCountPrior: rr0.cycle,
        rangeLadderLevelPrior: rr0.ladder,
        lastZone: rr0.lastZone
      });
      this.rangeRuntimeBySymbol.set(rrKey, {
        lastZone: rsEval.boxZone,
        cycle: rsEval.rangeCycleCount,
        ladder: rsEval.rangeLadderLevel
      });
      this.lastTickRangeEvalBySymbol.set(rrKey, rsEval);
      const armed = this.rangeReopenArmedUntilBySymbol.get(rrKey) ?? 0;
      const reopenRecent =
        this.rangeReopenTimestampsBySymbol.get(rrKey)?.filter((t) => t > nowTick - RANGE_REOPEN_WINDOW_MS) ?? [];
      const intentSideForReopen = snap.signal === "paper_short_candidate" ? ("short" as const) : ("long" as const);
      const proposedUsd = Math.max(
        MIN_POSITION_SIZE_USD,
        this.lastRiskExposure
          ? Math.round(DEFAULT_PAPER_SIZE_USD * this.lastRiskExposure.sizeMultiplier * 100) / 100
          : DEFAULT_PAPER_SIZE_USD
      );
      const reopenSoft: RangeReopenSoftMetrics = {
        edgeIntensity01: computeRangeEdgeIntensity01(rsEval.boxPosition, rsEval.boxZone),
        rangeCycleCount: rsEval.rangeCycleCount,
        recentRoundTripWinRate01: this.recentRangeWinRate01(rrKey),
        roundTripStreak: this.rangeRoundTripStreakBySymbol.get(rrKey) ?? 0
      };
      const reopenGate = evaluateRangeReopenAllowed({
        armed: armed > nowTick,
        state: rsEval,
        intentSide: intentSideForReopen,
        maxLongExposure: this.lastRiskExposure!.maxLongExposure,
        maxShortExposure: this.lastRiskExposure!.maxShortExposure,
        longUsd,
        shortUsd,
        proposedEntryUsd: proposedUsd,
        reopenCountInWindow: reopenRecent.length,
        soft: reopenSoft
      });
      const rangeReopenCooldownBypass = reopenGate.allowed;

      const res = evaluatePaperSymbolEntry({
        config: this.config,
        snapshot: {
          symbol: snap.symbol,
          lastPrice: snap.lastPrice,
          latestCandleClose: snap.latestCandleClose,
          signal: snap.signal,
          gateExpectedMove: snap.gateExpectedMove,
          gateRequiredMove: snap.gateRequiredMove,
          qualityScore: snap.qualityScore,
          candidateStrength: snap.candidateStrength,
          boxPos: snap.boxPos,
          boxRel: snap.boxRel,
          ema20: snap.ema20,
          ema60: snap.ema60,
          emaGap: snap.emaGap,
          volumeRatioProxy: snap.volumeRatioProxy,
          boxHigh: snap.boxHigh,
          boxLow: snap.boxLow,
          atr: snap.atr,
          rangeConfidence: snap.rangeConfidence,
          boxCohesion01: snap.boxCohesion01,
          breakoutFailureRate: snap.breakoutFailureRate,
          rangeOscillationScore: snap.rangeOscillationScore,
          trendWeaknessScore: snap.trendWeaknessScore,
          rangeReasonLabel: snap.rangeReasonLabel,
          rangeCycleCount: snap.rangeCycleCount,
          rangeLadderLevel: snap.rangeLadderLevel,
          regimeExitRisk: snap.regimeExitRisk,
          boxBreakSide: snap.boxBreakSide,
          regimeStateDiag: snap.regimeStateDiag
        },
        dataReady: true,
        regime: regimeDetected.regime,
        regimeDetail: regimeDetected.detail,
        regimeUnknown,
        isAmbiguous: regimeDetected.isAmbiguous,
        risk: this.lastRisk,
        adaptiveMode: this.lastAdaptiveMode.mode,
        adaptiveDetail: this.lastAdaptiveMode.detail,
        now: nowTick,
        rangeCooldownUntilByKey: this.rangeCooldownUntilByKey,
        trendCooldownUntilBySymbol: this.trendCooldownUntilBySymbol,
        lastCloseMetaBySymbol: lastCloseMetaBySymbolForDecision,
        reentryCooldownMs: this.config.paperReentryCooldownMs,
        sameDirCooldownMult: SAME_DIR_REENTRY_COOLDOWN_MULT,
        hasOpenPosition: hasOpen,
        currentStage,
        maxPositionsReached: (opensAfterClose.length >= this.config.paperMaxOpenPositions && !hasOpen),
        reviewingTicks,
        autoEntryTriggered,
        rangeReopenCooldownBypass
      });

      // Update reviewing state for next tick
      if (res.decision.final_decision === "SKIP" && isCandidate && currentStage === 0 && !hasOpen) {
        this.reviewingState.set(String(snap.symbol), {
          ticks: reviewingTicks + 1,
          initialQuality: rev?.initialQuality ?? snap.qualityScore,
          lastQuality: snap.qualityScore
        });
      } else {
        this.reviewingState.delete(String(snap.symbol));
      }
      decisionBySymbol.set(String(sym), res);

      const decisionSnap = snapshots.find((s) => s.symbol === sym);
      if (decisionSnap || res.executorDecision) {
        const d = res.decision;
        const exDetail = res.executorDecision?.detail;

        // Force HIGHWAY_CORE if Highway metrics are present or regime is TREND
        const isHighwayExecutor =
          res.executorDecision?.executor === "TREND" ||
          exDetail?.highwayValidityScore !== undefined ||
          exDetail?.alignmentQualityScore !== undefined ||
          regimeDetected.regime === "TREND";

        this.logger.info("PAPER_ENTRY_LINE", {
          symbol: String(sym),
          decision_source: isHighwayExecutor ? "HIGHWAY_CORE" : "LEGACY_RANGE",
          side: res.intentSide,
          entry_intent_type: d.entry_intent_type,
          entry_blocked: d.reject_reason !== null ? d.reject_reason : false,
          final_signal: d.final_decision === "ENTER" ? d.final_signal_state : "none",

          // --- PRIMARY HIGHWAY METRICS ---
          highway_validity_score: exDetail?.highwayValidityScore,
          alignment_quality_score: exDetail?.alignmentQualityScore,
          ema_spacing_health_score: exDetail?.emaSpacingHealthScore,
          pullback_quality_score: exDetail?.pullbackQualityScore,
          rebound_strength_score: exDetail?.reboundStrengthScore,
          volume_support_score: exDetail?.volumeSupportScore,
          trend_exhaustion_score: exDetail?.trendExhaustionScore,
          entry_risk_score: exDetail?.entryRiskScore,

          // --- EXECUTION DETAILS ---
          stage1_result_code: d.stage1_result_code,
          reject_reason: d.reject_reason,
          guidance: d.guidance,
          required_move_pct: d.required_move_pct,
          shortfall_pct: d.shortfall_pct,

          // --- AUXILIARY LEGACY DIAGNOSTICS ---
          legacy_base_signal: decisionSnap?.signal ?? "none",
          legacy_trend_ok: decisionSnap?.trendOk ?? false,
          legacy_ema_gap: decisionSnap?.emaGap ?? null,
          legacy_quality_score: decisionSnap?.qualityScore ?? 0,
          legacy_candidate_strength: decisionSnap?.candidateStrength ?? null,
          legacy_signal_strength: decisionSnap ? paperSignalStrengthLabel(decisionSnap.qualityScore, this.config.paperEntryRelaxed) : null,

          // --- RANGE/BOX AUXILIARY ---
          range_confidence: decisionSnap?.rangeConfidence,
          box_cohesion: decisionSnap?.boxCohesion01,
          breakout_failure_rate: decisionSnap?.breakoutFailureRate,
          range_oscillation_score: decisionSnap?.rangeOscillationScore,
          trend_weakness_score: decisionSnap?.trendWeaknessScore,
          regime_exit_risk: decisionSnap?.regimeExitRisk,
          range_cycle_count: decisionSnap?.rangeCycleCount,
          range_ladder_level: decisionSnap?.rangeLadderLevel,
          regime_state_diag: decisionSnap?.regimeStateDiag,

          paper_entry_relaxed: this.config.paperEntryRelaxed
        });
      }

      try {
        await this.store.appendJsonlLine("reports/decisions.jsonl", { ...res.decision, pipeline: "v1" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error("decisions_jsonl_append_failed", { error: msg, symbol: String(sym) });
      }
    }

    const funnel_tick = computeFunnelTick(decisionBySymbol);
    this.decisionFunnelTickRing.push(funnel_tick);
    if (this.decisionFunnelTickRing.length > DECISION_FUNNEL_RING_MAX) {
      this.decisionFunnelTickRing.shift();
    }
    const decision_funnel_50 = sumDecisionFunnelTicks(this.decisionFunnelTickRing);
    const decision_funnel_50_size = this.decisionFunnelTickRing.length;
    const reject_reason_counts_tick = aggregateRejectReasonCountsTick(decisionBySymbol);
    let last_order_build_failure: Record<string, unknown> | null = null;
    for (const sym of symbols) {
      const r = decisionBySymbol.get(String(sym));
      if (r?.decision.reject_reason !== "ORDER_BUILD_FAIL") continue;
      const snap = snapshots.find((s) => s.symbol === sym);
      if (!snap) continue;
      const openPos = opensAfterClose.find((o) => o.symbol === sym && o.status === "open");
      const es = openPos?.entryStage ?? 0;
      last_order_build_failure = orderBuildFailureStructuredPayload(snap, r, es, regimeDetected.regime);
    }
    let last_long_only_restriction: Record<string, unknown> | null = null;
    for (const sym of symbols) {
      const r = decisionBySymbol.get(String(sym));
      if (r?.decision.reject_reason !== "LONG_ONLY_SHORT_DEFERRED") continue;
      const d = r.decision;
      last_long_only_restriction = {
        symbol: String(sym),
        regime: regimeDetected.regime,
        long_only_restriction: d.long_only_restriction === true,
        original_signal_state: d.original_signal_state ?? null,
        final_signal_state: d.final_signal_state ?? null,
        execution_disabled_reason: d.execution_disabled_reason ?? null,
        reject_reason: d.reject_reason,
        stage1_result_code: d.stage1_result_code ?? null
      };
    }
    try {
      const risk = this.lastRisk!;
      await this.store.writeJson("reports/engine-state.json", {
        generatedAt: nowTick,
        market_mode_selector: this.lastMarketMode,
        risk_exposure: this.lastRiskExposure,
        explanation: this.lastExplanation,
        last_exit_reason: this.lastExitReasonLabel,
        last_switch_reason: this.lastSwitchReasonLabel,
        engine_mode: this.config.paperEngineMode,
        execution_state: risk.engineBlocked ? "DISABLED" : "PAPER_READY",
        strategy_executor:
          this.lastAdaptiveMode.mode === "trend" ? "TREND" : this.lastAdaptiveMode.mode === "sideways" ? "RANGE" : "IDLE",
        current_regime: (regimeDetected.regime === "TREND" ? "TREND" : regimeDetected.regime === "RANGE" ? "RANGE" : "NO_TRADE") as PaperRegimeState,
        is_ambiguous: regimeDetected.isAmbiguous,
        adaptiveMode: this.lastAdaptiveMode.mode,
        engine_status: risk.dailyLossGuardTriggered ? "PAUSED" : "RUNNING",
        risk_state: risk.riskStatus,
        active_mode_executor:
          regimeDetected.regime === "RANGE" ? "RANGE" : regimeDetected.regime === "TREND" ? "TREND" : "IDLE",
        entryAllowed:
          regimeDetected.regime !== "NO_TRADE" &&
          risk.engineBlocked !== true &&
          !((risk.blockedRegimes?.[regimeDetected.regime]?.until ?? 0) > nowTick),
        blockedReasons: [
          ...(regimeDetected.regime === "NO_TRADE" ? ["no_trade_regime"] : []),
          ...(risk.engineBlockReasons ?? []),
          ...(((risk.blockedRegimes?.[regimeDetected.regime]?.until ?? 0) > nowTick)
            ? [risk.blockedRegimes?.[regimeDetected.regime]?.reason ?? "mode_suspended"]
            : [])
        ],
        blocked_reason:
          regimeDetected.regime === "NO_TRADE"
            ? (regimeDetected.detail.reason ?? "no_trade")
            : risk.engineBlockReasons?.[0] ?? null,
        expected_move: this.lastEntryDecision?.expected_move ?? null,
        total_cost: this.lastEntryDecision?.total_cost ?? null,
        last_mode_change_at: this.lastModeChangeAt || null,
        mode_cooldown_status: {
          RANGE: [...this.rangeCooldownUntilByKey.entries()].map(([k, until]) => ({ key: k, until })),
          TREND: [...this.trendCooldownUntilBySymbol.entries()].map(([s, until]) => ({ symbol: s, until }))
        },
        recent_loss_streak_by_mode: risk.recentLossStreakByMode,
        daily_loss_guard_triggered: risk.dailyLossGuardTriggered,
        risk_detail: risk.detail,
        decision_funnel_tick: funnel_tick,
        decision_funnel_50,
        decision_funnel_50_size,
        reject_reason_counts_tick,
        last_order_build_failure,
        last_long_only_restriction,
        symbol_decisions: Object.fromEntries(
          [...decisionBySymbol.entries()].map(([k, v]) => [k, { decision: v.decision, adaptiveOk: v.adaptiveOk }])
        )
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("engine_state_write_failed", { error: msg });
    }

    await this.processPaperSymbolEntries({
      snapshots,
      errorsCount: errors.length,
      candidateRunPath,
      latestPath,
      metaPath,
      filePath,
      decisionBySymbol
    });

    const openAfterEntries = await this.positions.loadOpenAll();
    for (const sym of symbols) {
      const sk = String(sym);
      if (!openAfterEntries.some((o) => o.symbol === sym && o.status === "open")) {
        this.trendHoldMemoryBySymbol.delete(sk);
        this.trendPyramidLevelBySymbol.delete(sk);
        this.trendBreakoutBySymbol.delete(sk);
        this.trendFollowScoreBySymbol.delete(sk);
        this.trendBreakoutConfidenceBySymbol.delete(sk);
        this.rangeRoundTripStreakBySymbol.delete(sk);
        this.rangeRecentOutcomeScoresBySymbol.delete(sk);
      }
    }

    // Update AI-block outcome evaluation store (prices after 5/15/30m).
    try {
      const events = await this.store.readEventsJsonlFile();
      const symbolRows = snapshots.map((s) => ({ symbol: String(s.symbol), lastPrice: s.lastPrice }));
      await this.store.updateAiBlockEvaluations({
        now: Date.now(),
        symbolRows,
        events,
        criteria: {
          good_block_threshold_pct: this.config.aiBlockGoodThresholdPct,
          missed_opportunity_threshold_pct: this.config.aiBlockMissedThresholdPct,
          evaluation_horizon_priority: this.config.aiBlockEvaluationHorizonPriorityMins
        }
      } as any);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("ai_block_eval_update_failed", { error: msg });
    }

    try {
      const { summaryPath, dailyPath, windowPath, healthPath, health } = await this.positions.refreshSummaryReport();
      this.logger.info("paper_summary_report_saved", { path: summaryPath });
      this.logger.info("paper_summary_daily_report_saved", { path: dailyPath });
      this.logger.info("paper_summary_window_report_saved", { path: windowPath });
      this.logger.info("paper_summary_health_report_saved", { path: healthPath });
      this.logger.info("PAPER_HEALTH_STATUS", paperHealthStatusLogPayload(health));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("paper_summary_report_failed", { error: msg });
    }

    if (errors.length > 0) {
      throw new Error(`runOnce failed for ${errors.length} symbol(s)`);
    }
  }

  private async emitPipelineEventsFromDecision(
    first: SymbolSnapshot,
    res: EvaluatePaperSymbolEntryResult,
    nowTs: number,
    entryStage = 0
  ): Promise<void> {
    const sym = String(first.symbol);
    const d = res.decision;
    const ex = res.executorDecision;

    if (d.final_decision === "SKIP" && (d.reject_reason === "SIGNAL_NONE" || d.reject_reason === null)) {
      return;
    }

    if (d.final_decision === "SKIP" && d.reject_reason === "LONG_ONLY_SHORT_DEFERRED") {
      await this.store.appendJsonlLine("reports/events.jsonl", {
        ts: nowTs,
        type: "LONG_ONLY_SHORT_DEFERRED",
        symbol: sym,
        regime: this.lastRegime.regime,
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
        adaptive_direction: res.adaptiveDirection,
        detail: res.adaptiveDetail
      });
      return;
    }

    const legacyReason = (code: string | null): string => {
      if (!code) return "blocked";
      const m: Record<string, string> = {
        highway_invalid: "highway_invalid",
        highway_invalid_hard: "highway_invalid_hard",
        highway_invalid_soft: "highway_invalid_soft",
        EDGE_FAIL_FEE: "fee_slippage_insufficient",
        EDGE_FAIL_RR: "edge_fail_rr",
        EDGE_FAIL_LOW_VOL: "edge_fail_low_vol",
        REGIME_NO_TRADE: "no_trade_regime",
        REGIME_UNKNOWN: "regime_unknown",
        RISK_MAX_DRAWDOWN: "daily_loss_limit_exceeded",
        RISK_COOLDOWN: "mode_suspended",
        RISK_FAIL_REENTRY: "reentry_cooldown",
        AI_REJECT: "AI_REJECT",
        AI_FILTER: "AI_REJECT",
        AI_DIRECTION_MISMATCH: "AI_DIRECTION_MISMATCH",
        ORDER_BUILD_FAIL: "adaptive_policy_block",
        EXECUTION_DISABLED: "long_only_short_blocked",
        DATA_NOT_READY: "DATA_NOT_READY"
      };
      return m[code] ?? code;
    };

    if (ex?.entry_allowed) {
      await this.store.appendJsonlLine("reports/events.jsonl", {
        ts: nowTs,
        type: "ENTRY_ALLOWED",
        symbol: sym,
        regime: this.lastRegime.regime,
        executor: ex.executor,
        reason: "executor_allowed",
        expected_move: ex.expected_move,
        total_cost: ex.total_cost,
        risk_state: ex.risk_state,
        detail: ex.detail
      });
    }

    if (d.final_decision === "REJECT" || d.final_decision === "DISABLED") {
      if (ex?.entry_allowed && (d.reject_reason === "AI_REJECT" || d.reject_reason === "AI_DIRECTION_MISMATCH")) {
        const intentSide = res.intentSide ?? "long";
        const lossStreak = this.lastRisk?.recentLossStreakByMode?.[this.lastRegime.regime] ?? 0;
        const last10Net =
          typeof this.lastRisk?.detail?.last10_net_usd === "number" && Number.isFinite(this.lastRisk.detail.last10_net_usd)
            ? this.lastRisk.detail.last10_net_usd
            : 0;
        const aiIn = ex ? aiInputFromDecision({ decision: ex, executorDirection: intentSide, lossStreak, last10Net }) : null;
        if (d.reject_reason === "AI_REJECT" && aiIn) {
          const aiOut = aiApproveEntry(aiIn);
          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: nowTs,
            type: "ENTRY_BLOCKED",
            symbol: sym,
            regime: this.lastRegime.regime,
            executor: ex.executor,
            reason: "AI_REJECT",
            reject_code: d.reject_reason,
            expected_move: ex.expected_move,
            total_cost: ex.total_cost,
            risk_state: ex.risk_state,
            executor_direction: intentSide,
            ai_direction: "none",
            mismatch: false,
            blocked_at_price: first.lastPrice,
            price_after_5m: null,
            price_after_15m: null,
            price_after_30m: null,
            hypothetical_outcome_hint: null,
            detail: { ai_reason: aiOut.reason, ai_confidence: aiOut.confidence, ai_input: aiIn },
            stage1_result_code: d.stage1_result_code
          });
          return;
        }
        if (d.reject_reason === "AI_DIRECTION_MISMATCH" && aiIn) {
          const aiOut = aiApproveEntry(aiIn);
          const aiDir = aiOut.action === "ENTER_LONG" ? "long" : aiOut.action === "ENTER_SHORT" ? "short" : "none";
          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: nowTs,
            type: "ENTRY_BLOCKED",
            symbol: sym,
            regime: this.lastRegime.regime,
            executor: ex.executor,
            reason: "AI_DIRECTION_MISMATCH",
            reject_code: d.reject_reason,
            expected_move: ex.expected_move,
            total_cost: ex.total_cost,
            risk_state: ex.risk_state,
            executor_direction: intentSide,
            ai_direction: aiDir,
            mismatch: true,
            blocked_at_price: first.lastPrice,
            price_after_5m: null,
            price_after_15m: null,
            price_after_30m: null,
            hypothetical_outcome_hint: null,
            detail: { ai_reason: "방향 불일치", ai_confidence: aiOut.confidence },
            stage1_result_code: d.stage1_result_code
          });
          return;
        }
      }

      if (!ex?.entry_allowed && ex) {
        await this.store.appendJsonlLine("reports/events.jsonl", {
          ts: nowTs,
          type: "ENTRY_BLOCKED",
          symbol: sym,
          regime: d.regime ?? this.lastRegime.regime,
          executor: ex.executor,
          reason: ex.blocked_reason,
          reject_code: d.reject_reason,
          expected_move: ex.expected_move,
          total_cost: ex.total_cost,
          risk_state: ex.risk_state,
          detail: ex.detail,
          stage1_result_code: d.stage1_result_code,
          reentry_cooldown_applied: d.reentry_cooldown_applied ?? false,
          reentry_cooldown_original_ms: d.reentry_cooldown_original_ms ?? null,
          reentry_cooldown_effective_ms: d.reentry_cooldown_effective_ms ?? null,
          reentry_cooldown_reason: d.reentry_cooldown_reason ?? null,
          currentStage: d.currentStage
        });
        return;
      }

      if (d.reject_reason === "ORDER_BUILD_FAIL") {
        const structured = orderBuildFailureStructuredPayload(first, res, entryStage, this.lastRegime.regime);
        await this.store.appendJsonlLine("reports/events.jsonl", {
          ts: nowTs,
          type: "ORDER_BUILD_FAIL",
          reject_code: d.reject_reason,
          stage1_result_code: d.stage1_result_code,
          ...structured
        });
        return;
      }

      await this.store.appendJsonlLine("reports/events.jsonl", {
        ts: nowTs,
        type: "ENTRY_BLOCKED",
        symbol: sym,
        regime: d.regime ?? this.lastRegime.regime,
        reason: legacyReason(d.reject_reason),
        reject_code: d.reject_reason,
        expected_move:
          typeof d.expected_move_pct === "number" && Number.isFinite(d.expected_move_pct) ? d.expected_move_pct / 100 : null,
        risk_state: this.lastRisk?.riskStatus ?? "NORMAL",
        stage1_result_code: d.stage1_result_code,
        reentry_cooldown_applied: d.reentry_cooldown_applied ?? false,
        reentry_cooldown_original_ms: d.reentry_cooldown_original_ms ?? null,
        reentry_cooldown_effective_ms: d.reentry_cooldown_effective_ms ?? null,
        reentry_cooldown_reason: d.reentry_cooldown_reason ?? null,
        currentStage: d.currentStage
      });
    }
  }

  private async tryPaperPositionClose(input: Readonly<{
    snapshots: SymbolSnapshot[];
    errorsCount: number;
    latestPath: string | undefined;
    metaPath: string | undefined;
    filePath: string | undefined;
    marketMode: MarketModeSelectorOutput;
    riskExposure: RiskExposureOutput;
  }>): Promise<void> {
    if (input.errorsCount > 0) return;

    const rawOpens = await this.positions.loadOpenAll();
    if (rawOpens.length === 0) return;
    const opens = rawOpens.map(o => ({ ...o })); // Use mutable copy for state tracking

    // --- ASYMMETRIC CRASH RISK LAYER ---
    const risk = this.lastRisk;
    if (risk && risk.crashState !== "NONE") {
      for (const op of opens) {
        if (op.status !== "open") continue;
        const snap = input.snapshots.find(s => s.symbol === op.symbol);
        if (!snap) continue;

        const isLong = op.side === "long";
        const isShort = op.side === "short";

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
              closeReason: et as any,
              legMarginUsd: marginToClose,
              metrics: m,
              feeRate: this.config.paperTakerFeeRate,
              fundingIntervalHours: this.config.paperFundingIntervalHours,
              strategyVersion: "paper-v1-crash-defense",
              exitTypeOverride: et,
              closeSourceOverride: "CRASH_LONG_DEFENSE"
            });

            await this.positions.appendClosed(closedRow);
            this.logger.warn("crash_long_defense", { symbol: op.symbol, state: risk.crashState, type: et });

            if (forceExit) {
              (op as any).status = "closed";
            } else {
              (op as any).sizeUsd -= marginToClose;
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

    const remaining: PaperOpenPositionRecord[] = [];
    const feeRate = this.config.paperTakerFeeRate;
    const intervalH = this.config.paperFundingIntervalHours;

    /** events.jsonl `type` — 레거시 호환(부분익절·트레일 등은 기존과 동일 계열로 유지). */
    const exitEventJsonlType = (r: PaperClosedPositionRecord["closeReason"]): string => {
      const t = paperExitDisplayMeta(r).exitType;
      if (t === "EXIT_PARTIAL_TP" || t === "EXIT_TP_1" || t === "EXIT_TP_2") return "EXIT_TP";
      if (t === "EXIT_TRAILING" || t === "EXIT_TIME_STOP" || t === "EXIT_REGIME") return "EXIT_REGIME";
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
      if (openRaw.status !== "open") {
        remaining.push(openRaw);
        continue;
      }

      const snap = input.snapshots.find((s) => s.symbol === openRaw.symbol);
      if (!snap) {
        remaining.push(openRaw);
        continue;
      }

      let open: PaperOpenPositionRecord = {
        ...openRaw,
        initialSizeUsd: openRaw.initialSizeUsd ?? openRaw.sizeUsd,
        partialExitStage: openRaw.partialExitStage ?? 0
      };

      const closePrice = snap.lastPrice;
      const closedAt = snap.fetchedAt;
      const regimeAtEntry = open.regimeAtEntry ?? "NO_TRADE";
      const regimeNow = this.lastRegime.regime;
      const exitLane: "RANGE" | "TREND" =
        open.regimeAtEntry === "RANGE"
          ? "RANGE"
          : open.regimeAtEntry === "TREND"
            ? "TREND"
            : input.marketMode.routing.activeEngine === "TREND"
              ? "TREND"
              : "RANGE";
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
          strategyVersion: "paper-v1",
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
      if (exitLane === "RANGE" || regimeAtEntry === "RANGE") {
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
      }

      const priorBr = this.trendBreakoutBySymbol.get(symKey) ?? "none";
      let trendState = null as ReturnType<typeof evaluateTrendEngineForSymbol> | null;
      if (exitLane === "TREND" || regimeAtEntry === "TREND") {
        trendState = evaluateTrendEngineForSymbol({
          mark: closePrice,
          entryPrice: open.entryPrice,
          atr: snap.atr,
          marketMode: input.marketMode,
          priorBreakoutDirection: priorBr,
          pyramidLevelPrior: this.trendPyramidLevelBySymbol.get(symKey) ?? 0,
          holdMemoryPrior: this.trendHoldMemoryBySymbol.get(symKey) ?? null,
          positionSide: open.side
        });
        this.trendBreakoutBySymbol.set(symKey, trendState.breakoutDirection);
        this.trendHoldMemoryBySymbol.set(symKey, trendState.holdMemory);
        this.trendPyramidLevelBySymbol.set(symKey, trendState.pyramidLevel);
        this.trendFollowScoreBySymbol.set(symKey, trendState.trendFollowScore);
        this.trendBreakoutConfidenceBySymbol.set(symKey, trendState.breakoutConfidence);
        this.logger.info("trend_engine_tick", trendState);
      }

      if (regimeAtEntry === "RANGE" && rangeState) {
        const st = evaluateRangeStructuralExit({
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
        if (st.shouldExit && st.reason) {
          let cr: PaperClosedPositionRecord["closeReason"] = "range_box_break";
          if (st.reason === "structural_regime_shift") cr = "structural_regime_shift";
          if (st.reason === "risk_exposure_breach") cr = "regime_exit";
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
                strategyVersion: "paper-v1",
                exitTypeOverride: "EXIT_RISK",
                closeReasonLabelOverride: "리스크 노출 한도 초과",
                ...snapPaths
              })
              : toClosed(cr, m, open.sizeUsd);
          await this.positions.appendClosed(closedRow);
          this.lastExitReasonLabel =
            st.reason === "range_box_break"
              ? "박스 붕괴 청산"
              : st.reason === "structural_regime_shift"
                ? "구조적 추세 전환 청산"
                : "노출 한도 청산";
          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: Date.now(),
            type: "EXIT_REGIME",
            symbol: symKey,
            reason: cr,
            structural: st.reason,
            realized_pnl: m.pnlUsdNet
          });
          continue;
        }
      }

      if (regimeAtEntry === "TREND" && trendState) {
        const plan = planTrendSwitch(trendState, open.side);
        if (plan.execute && plan.openSide && plan.closeSide) {
          const cr = "trend_switch" as const;
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
            strategyVersion: "paper-v1",
            ...snapPaths
          });
          await this.positions.appendClosed(closedRow);
          this.lastExitReasonLabel = "추세 반대 돌파로 청산";
          this.lastSwitchReasonLabel = trendState.trendSwitchReasonLabel;
          this.trendSwitchTimestampsMs.push(Date.now());
          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: Date.now(),
            type: "EXIT_TREND_SWITCH",
            phase: "close",
            symbol: symKey,
            side: open.side,
            realized_pnl: m.pnlUsdNet
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
            strategyVersion: "paper-v1",
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
            size_usd: newSz
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
        const closedRow = toClosed(cr, m, open.sizeUsd);
        await this.positions.appendClosed(closedRow);
        this.lastExitReasonLabel = "손절 청산";
        this.logger.info(exitFullLogKey(cr), {
          ...exitDetailBase(open, m),
          exitReason: cr
        });
        this.logger.info("paper_position_closed", { symbol: open.symbol, side: open.side, pnlUsdNet: m.pnlUsdNet, closeReason: cr });
        await this.store.appendJsonlLine("reports/events.jsonl", {
          ts: Date.now(),
          type: "EXIT_SL",
          symbol: String(open.symbol),
          regime: open.regimeAtEntry ?? null,
          executor: executorForExitEventPayload(open.executorAtEntry, open.regimeAtEntry),
          reason: cr,
          expected_move: open.expectedMoveAtEntry ?? null,
          total_cost: open.totalCostAtEntry ?? null,
          hold_time: m.holdingMs,
          realized_pnl: m.pnlUsdNet,
          fee: m.feeUsd
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
        }
        continue;
      }

      // 2. Regime Flip / Trend Break check
      if (regimeAtEntry === "TREND") {
        const trendOkNow = snap.trendOk === true;
        if (regimeNow !== "TREND" || !trendOkNow) {
          const cr = "trend_break_exit" as const;
          const closedRow = toClosed(cr, m, open.sizeUsd);
          await this.positions.appendClosed(closedRow);
          this.logger.info(exitFullLogKey(cr), { ...exitDetailBase(open, m), exitReason: cr });
          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: Date.now(),
            type: "EXIT_TREND_BREAK",
            symbol: String(open.symbol),
            regime: open.regimeAtEntry ?? null,
            executor: executorForExitEventPayload(open.executorAtEntry, open.regimeAtEntry),
            reason: cr,
            expected_move: open.expectedMoveAtEntry ?? null,
            total_cost: open.totalCostAtEntry ?? null,
            hold_time: m.holdingMs,
            realized_pnl: m.pnlUsdNet,
            fee: m.feeUsd
          });
          continue;
        }
      }

      // 3. RANGE / TREND 실행기 분리(포지션 레짐·상위 모드로 레인 선택)
      const exitEval =
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

      // --- CRASH MOMENTUM TRAILING OVERRIDE for SHORTS ---
      if (open.side === "short" && risk && (risk.crashState === "CRASH_EXIT" || risk.crashState === "CRASH_REDUCE")) {
        if (m.pnlPctNet > 0.005) { // 0.5% 이상 수익권이면 타이트하게 보호
          const trailGap = (snap.atr ?? 0) * 0.48;
          const crashTrailStop = (open.trailingExtremePrice ?? open.entryPrice) + trailGap;
          // 숏이므로 가격이 상승하여 이 지점을 터치하면 청산
          if (closePrice >= crashTrailStop) {
            (exitEval as any).action = "close";
            (exitEval as any).reason = "trailing_stop";
            (exitEval as any).detail = { crash_momentum_trail: true, stop: crashTrailStop };
          }
        }
      }
      // --------------------------------------------------

      if (exitEval.action === "close") {
        const cr = exitEval.reason as PaperClosedPositionRecord["closeReason"];
        const closedRow = toClosed(cr, m, open.sizeUsd);
        await this.positions.appendClosed(closedRow);
        this.logger.info(exitFullLogKey(cr), { ...exitDetailBase(open, m), exitReason: cr });
        this.logger.info("paper_position_closed", { symbol: open.symbol, side: open.side, pnlUsdNet: m.pnlUsdNet, closeReason: cr });
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
          fee: m.feeUsd
        });

        if (open.regimeAtEntry === "RANGE" && cr === "take_profit") {
          this.recordRangeRoundTripOutcome(symKey, true);
          const k = `${String(open.symbol)}:${open.side}`;
          this.rangeFailCountByKey.set(k, 0);
          this.rangeReopenArmedUntilBySymbol.set(symKey, Date.now() + 15 * 60_000);
        }
        if (open.regimeAtEntry === "TREND" && (cr === "stop_loss" || cr === "trend_break_exit")) {
          this.trendCooldownUntilBySymbol.set(String(open.symbol), Date.now() + 12 * 60_000);
        }
        continue;
      }

      if (exitEval.action === "partial_close") {
        const partial = exitEval;
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

          this.logger.info(pLog, {
            ...exitDetailBase(open, mp),
            exitReason: pReason,
            partial_ratio: ratio,
            partial_margin_usd: partialMargin,
            remaining_margin_usd: newMargin,
            detail: partial.detail
          });

          await this.store.appendJsonlLine("reports/events.jsonl", {
            ts: Date.now(),
            type: "EXIT_TP",
            symbol: String(open.symbol),
            regime: open.regimeAtEntry ?? null,
            executor: executorForExitEventPayload(open.executorAtEntry, open.regimeAtEntry),
            reason: pReason,
            expected_move: open.expectedMoveAtEntry ?? null,
            total_cost: open.totalCostAtEntry ?? null,
            hold_time: mp.holdingMs,
            realized_pnl: mp.pnlUsdNet,
            fee: mp.feeUsd
          });

          open = {
            ...open,
            sizeUsd: newMargin,
            partialExitStage: stage,
            realizedPnl: (open.realizedPnl ?? 0) + mp.pnlUsdNet,
            trailingExtremePrice: (partial as any).trailingExtreme,
            candidateLostStreak: 0
          };
          remaining.push(open);
          continue;
        }
      }

      // 4. Default persistence (with Trailing SL update)
      const posTrail = { ...open, trailingExtremePrice: (exitEval as any).trailingExtreme };

      const keep =
        (open.side === "long" && snap.signal === "paper_long_candidate") ||
        (open.side === "short" && snap.signal === "paper_short_candidate");

      if (keep) {
        remaining.push({ ...posTrail, lostAt: undefined, candidateLostStreak: 0 });
        continue;
      }

      if (regimeAtEntry === "RANGE") {
        remaining.push({ ...posTrail, lostAt: undefined, candidateLostStreak: 0 });
        this.logger.info("range_hold_signal_mismatch_no_candidate_lost", {
          symbol: open.symbol,
          market_mode: input.marketMode.marketMode
        });
        continue;
      }

      /** 증액(스테이지 2+)·규모 확대 포지션: 신호 소멸 후 시간 청산·유예를 더 짧게 (RANGE 포지션은 상단에서 이미 분기됨) */
      const stagedOrScaled =
        (open.entryStage ?? 1) >= 2 ||
        (typeof open.initialSizeUsd === "number" &&
          open.initialSizeUsd > 0 &&
          open.sizeUsd > open.initialSizeUsd * 1.05);
      const minHoldMs = stagedOrScaled ? 4 * 60_000 : 5 * 60_000;
      const minHoldMsEff = minHoldMs;
      const gracePeriodMs = stagedOrScaled ? 4 * 60_000 : 7 * 60_000;
      const minLostStreak = 1;

      if (m.holdingMs < minHoldMsEff) {
        remaining.push({ ...posTrail, candidateLostStreak: 0 });
        continue;
      }

      const lostAt = posTrail.lostAt ?? closedAt;
      const elapsedLost = closedAt - lostAt;
      const lostStreak = (posTrail.candidateLostStreak ?? 0) + 1;

      if (elapsedLost < gracePeriodMs || lostStreak < minLostStreak) {
        remaining.push({ ...posTrail, lostAt, candidateLostStreak: lostStreak });
        continue;
      }

      const cr = "candidate_lost" as const;
      const closedRow = toClosed(cr, m, open.sizeUsd);
      await this.positions.appendClosed(closedRow);
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
        fee: m.feeUsd
      });
    }

    if (remaining.length !== opens.length || remaining.some((r, i) => r !== opens[i])) {
      await this.positions.saveOpenAll(remaining);
    }
  }


  private async processPaperSymbolEntries(input: Readonly<{
    snapshots: SymbolSnapshot[];
    errorsCount: number;
    candidateRunPath: string | undefined;
    latestPath: string | undefined;
    metaPath: string | undefined;
    filePath: string | undefined;
    decisionBySymbol: ReadonlyMap<string, EvaluatePaperSymbolEntryResult>;
  }>): Promise<void> {
    if (input.errorsCount > 0) return;

    const candidates = input.snapshots
      .filter((s) => s.signal === "paper_long_candidate" || s.signal === "paper_short_candidate")
      .sort((a, b) => {
        const aMajor = a.symbol === "BTCUSDT" || a.symbol === "ETHUSDT";
        const bMajor = b.symbol === "BTCUSDT" || b.symbol === "ETHUSDT";
        if (aMajor && !bMajor) return -1;
        if (!aMajor && bMajor) return +1;
        return 0;
      });
    if (candidates.length === 0) return;

    if (!input.candidateRunPath || !input.latestPath || !input.metaPath || !input.filePath) {
      return;
    }

    const max = this.config.paperMaxOpenPositions;
    const opens = await this.positions.loadOpenAll();
    const before = opens.length;
    const next = [...opens];
    const nowTs = Date.now();
    this.lastEntryDecision = null;

    for (const first of candidates) {
      const res = input.decisionBySymbol.get(String(first.symbol));
      if (!res) continue;
      const intentSide = res.intentSide ?? (first.signal === "paper_short_candidate" ? "short" : "long");
      const existingOpen = next.find((o) => o.symbol === first.symbol && o.side === intentSide);
      const entryStage = existingOpen?.entryStage ?? 0;
      const existingIdx = next.findIndex((o) => o.symbol === first.symbol && o.side === intentSide);
      const otherLeg = next.some((o) => o.symbol === first.symbol && o.side !== intentSide);
      const activeEngine = this.lastMarketMode?.routing.activeEngine ?? "IDLE";
      let hedgeEntryBlocked = false;
      if (otherLeg && this.lastRiskExposure) {
        if (activeEngine === "RANGE") hedgeEntryBlocked = !this.lastRiskExposure.allowRangeBidirectional;
        else if (activeEngine === "TREND") hedgeEntryBlocked = this.lastRiskExposure.blockTrendOppositeLeg;
        else hedgeEntryBlocked = true;
      }
      if (hedgeEntryBlocked) {
        await this.emitPipelineEventsFromDecision(
          first,
          {
            ...res,
            decision: {
              ...res.decision,
              final_decision: "SKIP",
              reject_reason: "EXECUTION_DISABLED",
              execution_disabled_reason:
                activeEngine === "TREND" ? "trend_opposite_leg_blocked_by_policy" : "hedge_blocked_non_range_engine"
            },
            adaptiveResult: null
          },
          nowTs,
          entryStage
        );
        continue;
      }

      if (existingIdx >= 0) {
        const scaled = await this.tryPaperPositionScaleIn(next[existingIdx], res, first, nowTs);
        if (scaled) {
          next[existingIdx] = scaled;
        }
        continue;
      }

      if (next.length >= max) {
        if (res.decision.final_decision === "ENTER") {
          // Track as blocked by limit even if it was internally allowed
          const limitBlocked = {
            ...res,
            decision: {
              ...res.decision,
              stage1_result_code: "STAGE1_BLOCKED_LIMIT" as const
            }
          };
          await this.emitPipelineEventsFromDecision(first, limitBlocked, nowTs, entryStage);
        }
        continue;
      }

      this.lastEntryDecision = res.executorDecision ?? null;

      if (res.decision.reject_reason === "ORDER_BUILD_FAIL" && res.executorDecision?.entry_allowed) {
        const ob = orderBuildFailureStructuredPayload(first, res, entryStage, this.lastRegime.regime);
        this.logger.info("STAGE1_ENTER_DECIDED", ob);
        this.logger.info("STAGE1_POSITION_OPEN_ATTEMPT", ob);
        this.logger.info("ORDER_BUILD_FAIL", ob);
      }

      if (res.decision.final_decision !== "ENTER" || !res.adaptiveResult) {
        await this.emitPipelineEventsFromDecision(first, res, nowTs, entryStage);
        continue;
      }

      const blockNew =
        !this.lastRiskExposure?.allowNewEntry || this.lastMarketMode?.routing.newEntryPolicy === "paused";
      if (existingIdx < 0 && blockNew) {
        await this.emitPipelineEventsFromDecision(
          first,
          {
            ...res,
            decision: {
              ...res.decision,
              final_decision: "SKIP",
              reject_reason: "REGIME_NO_TRADE"
            },
            adaptiveResult: null
          },
          nowTs,
          entryStage
        );
        continue;
      }

      const decision = res.executorDecision!;
      const adaptive = res.adaptiveResult;
      const sym = String(first.symbol);

      await this.store.appendJsonlLine("reports/events.jsonl", {
        ts: Date.now(),
        type: "ENTRY_ALLOWED",
        symbol: sym,
        regime: this.lastRegime.regime,
        executor: decision.executor,
        reason: "executor_allowed",
        expected_move: decision.expected_move,
        total_cost: decision.total_cost,
        risk_state: decision.risk_state,
        detail: decision.detail
      });
      const lossStreak = this.lastRisk?.recentLossStreakByMode?.[this.lastRegime.regime] ?? 0;
      const last10Net =
        typeof this.lastRisk?.detail?.last10_net_usd === "number" && Number.isFinite(this.lastRisk.detail.last10_net_usd)
          ? this.lastRisk.detail.last10_net_usd
          : 0;
      const aiIn = aiInputFromDecision({ decision, executorDirection: intentSide, lossStreak, last10Net });
      if (aiIn) {
        const aiOut = aiApproveEntry(aiIn);
        const aiDir = aiOut.action === "ENTER_LONG" ? "long" : aiOut.action === "ENTER_SHORT" ? "short" : "none";
        await this.store.appendJsonlLine("reports/events.jsonl", {
          ts: Date.now(),
          type: "AI_APPROVED",
          symbol: sym,
          regime: this.lastRegime.regime,
          executor: decision.executor,
          reason: "ai_approved",
          expected_move: decision.expected_move,
          total_cost: decision.total_cost,
          risk_state: decision.risk_state,
          executor_direction: intentSide,
          ai_direction: aiDir,
          mismatch: false,
          detail: { ai_reason: aiOut.reason, ai_confidence: aiOut.confidence }
        });
      }

      this.logger.info("STAGE1_ENTER_DECIDED", {
        symbol: sym,
        regime: this.lastRegime.regime,
        executor: decision.executor,
        stage1_result_code: res.decision.stage1_result_code,
        fixed_total_cost_usd: res.decision.fixed_total_cost_usd ?? null,
        expected_move_usd: res.decision.expected_move_usd ?? null,
        required_cost_usd: res.decision.required_cost_usd ?? null,
        shortfall_usd: res.decision.shortfall_usd ?? 0,
        required_move_pct: res.decision.required_move_pct,
        shortfall_pct: res.decision.shortfall_pct,
        executor_block_reason_original: res.decision.executor_block_reason_original ?? null,
        stage1_soft_exec_override: res.decision.stage1_soft_exec_override === true,
        stage1_size_multiplier_final: res.decision.stage1_size_multiplier_final ?? null
      });

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

      try {
        this.logger.info("STAGE1_POSITION_OPEN_ATTEMPT", {
          symbol: first.symbol,
          side: adaptive.direction,
          sizeUsd: adaptive.sizeUsd,
          stage1_result_code: res.decision.stage1_result_code,
          fixed_total_cost_usd: res.decision.fixed_total_cost_usd ?? null,
          expected_move_usd: res.decision.expected_move_usd ?? null,
          required_cost_usd: res.decision.required_cost_usd ?? null,
          shortfall_usd: res.decision.shortfall_usd ?? 0,
          executor_block_reason_original: res.decision.executor_block_reason_original ?? null,
          stage1_soft_exec_override: res.decision.stage1_soft_exec_override === true,
          stage1_size_multiplier_final: res.decision.stage1_size_multiplier_final ?? null
        });

        let entrySizeUsd = adaptive.sizeUsd;
        const riskE = this.lastRiskExposure;
        if (riskE) {
          entrySizeUsd = Math.max(
            MIN_POSITION_SIZE_USD,
            Math.round(adaptive.sizeUsd * riskE.sizeMultiplier * 100) / 100
          );
        }
        const symS = String(first.symbol);
        if (this.lastRegime.regime === "TREND" && this.lastMarketMode?.routing.activeEngine === "TREND") {
          const pyr = this.trendPyramidLevelBySymbol.get(symS) ?? 0;
          entrySizeUsd = Math.max(
            MIN_POSITION_SIZE_USD,
            Math.round(entrySizeUsd * (1 + Math.min(4, pyr) * 0.07) * 100) / 100
          );
        }
        if (this.lastMarketMode?.routing.activeEngine === "RANGE") {
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
        const mPre = marginsForSymbol(next, symS);
        if (
          riskE &&
          ((adaptive.direction === "long" && mPre.longUsd + entrySizeUsd > riskE.maxLongExposure) ||
            (adaptive.direction === "short" && mPre.shortUsd + entrySizeUsd > riskE.maxShortExposure))
        ) {
          await this.emitPipelineEventsFromDecision(
            first,
            {
              ...res,
              decision: {
                ...res.decision,
                final_decision: "SKIP",
                reject_reason: "EXECUTION_DISABLED",
                execution_disabled_reason: "risk_exposure_cap_for_leg"
              },
              adaptiveResult: null
            },
            nowTs,
            entryStage
          );
          continue;
        }
        const record: PaperOpenPositionRecord = {
          openedAt: Date.now(),
          symbol: first.symbol,
          side: adaptive.direction,
          entryPrice: first.lastPrice,
          leverage: levScaled,
          sizeUsd: entrySizeUsd,
          initialSizeUsd: entrySizeUsd,
          partialExitStage: 0,
          realizedPnl: 0,
          stopPrice: typeof res.decision.stopLoss === "number" ? res.decision.stopLoss : undefined,
          strategyVersion: "paper-v1",
          sourceSignal,
          sourceRunPath: input.candidateRunPath,
          latestSnapshotPath: input.latestPath,
          latestMetaPath: input.metaPath,
          timestampSnapshotPath: input.filePath,
          ...(Number.isFinite(first.fundingRate) ? { openFundingRate: first.fundingRate } : {}),
          trailingExtremePrice: first.lastPrice,
          adaptiveModeAtEntry: this.lastAdaptiveMode.mode,
          regimeAtEntry: this.lastRegime.regime,
          executorAtEntry: decision.executor,
          ...(typeof decision.expected_move === "number" ? { expectedMoveAtEntry: decision.expected_move } : {}),
          ...(typeof decision.total_cost === "number" ? { totalCostAtEntry: decision.total_cost } : {}),
          ...(confScore !== undefined ? { entryConfidenceScore: confScore } : {}),
          ...(confTier !== undefined ? { entryConfidenceTier: confTier } : {}),
          ...(sizeMult !== undefined ? { entrySizeMultiplier: sizeMult } : {}),
          ...(res.decision.post_entry_cost_guard === true ? { postEntryCostGuard: true } : {}),
          status: "open"
        };

        next.push(record);
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

        this.logger.info("STAGE1_POSITION_OPEN_SUCCESS", {
          symbol: record.symbol,
          side: record.side,
          stage1_result_code: res.decision.stage1_result_code,
          fixed_total_cost_usd: res.decision.fixed_total_cost_usd ?? null,
          expected_move_usd: res.decision.expected_move_usd ?? null,
          required_cost_usd: res.decision.required_cost_usd ?? null,
          shortfall_usd: res.decision.shortfall_usd ?? 0,
          executor_block_reason_original: res.decision.executor_block_reason_original ?? null,
          stage1_soft_exec_override: res.decision.stage1_soft_exec_override === true,
          stage1_size_multiplier_final: res.decision.stage1_size_multiplier_final ?? null
        });

        const entryOpenedKey = record.side === "long" ? "entry_long_opened" : "entry_short_opened";
        this.logger.info(entryOpenedKey, {
          symbol: record.symbol,
          side: record.side,
          mode: this.lastAdaptiveMode.mode,
          size_usd: record.sizeUsd,
          leverage: record.leverage,
          confidenceScore: confScore,
          confidenceTier: confTier,
          sizeMultiplier: sizeMult,
          entry_pipeline: adaptive.detail
        });
        this.logger.info("paper_position_opened", {
          symbol: record.symbol,
          side: record.side,
          path: "positions/open.json"
        });
        await this.store.appendJsonlLine("reports/events.jsonl", {
          ts: Date.now(),
          type: "ENTRY_OPENED",
          symbol: String(record.symbol),
          side: record.side,
          regime: this.lastRegime.regime,
          executor: decision.executor,
          sizeUsd: record.sizeUsd,
          leverage: record.leverage,
          expected_move: decision.expected_move,
          total_cost: decision.total_cost,
          risk_state: (this.lastRisk?.riskStatus ?? "NORMAL"),
          stage1_result_code: res.decision.stage1_result_code,
          fixed_total_cost_usd: res.decision.fixed_total_cost_usd ?? null,
          expected_move_usd: res.decision.expected_move_usd ?? null,
          required_cost_usd: res.decision.required_cost_usd ?? null,
          shortfall_usd: res.decision.shortfall_usd ?? 0,
          executor_block_reason_original: res.decision.executor_block_reason_original ?? null,
          stage1_soft_exec_override: res.decision.stage1_soft_exec_override === true,
          stage1_size_multiplier_final: res.decision.stage1_size_multiplier_final ?? null
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error("STAGE1_POSITION_OPEN_FAIL", {
          symbol: sym,
          stage1_result_code: res.decision.stage1_result_code,
          fixed_total_cost_usd: res.decision.fixed_total_cost_usd ?? null,
          expected_move_usd: res.decision.expected_move_usd ?? null,
          required_cost_usd: res.decision.required_cost_usd ?? null,
          shortfall_usd: res.decision.shortfall_usd ?? 0,
          final_fail_reason: msg,
          reviewing_ticks: res.decision.reviewing_ticks,
          auto_entry_triggered: res.decision.auto_entry_triggered,
          required_move_pct: res.decision.required_move_pct,
          shortfall_pct: res.decision.shortfall_pct
        });
      }
    }

    if (next.length !== before) {
      await this.positions.saveOpenAll(next);
    }
  }

  private async tryPaperPositionScaleIn(
    existing: PaperOpenPositionRecord,
    res: EvaluatePaperSymbolEntryResult,
    first: SymbolSnapshot,
    nowTs: number
  ): Promise<PaperOpenPositionRecord | null> {
    if (res.decision.final_decision !== "ENTER" || !res.adaptiveResult) return null;
    if (!this.lastRiskExposure?.allowAdd) {
      this.logger.info("scale_in_blocked_risk_allow_add", { symbol: existing.symbol });
      return null;
    }
    if (existing.postEntryCostGuard === true) {
      this.logger.info("scale_in_blocked_post_entry_cost_guard", { symbol: existing.symbol });
      return null;
    }

    const stageAtLeast2 = (existing.entryStage ?? 1) >= 2;
    if (stageAtLeast2 && first.qualityScore < 72) {
      this.logger.info("scale_in_blocked_stage2plus_quality", {
        symbol: existing.symbol,
        qualityScore: first.qualityScore,
        entryStage: existing.entryStage
      });
      return null;
    }

    const decision = res.executorDecision!;
    const adaptive = res.adaptiveResult;
    const targetStage = res.decision.target_stage ?? (existing.entryStage ?? 1) + 1;

    // scaling_weights based on regime
    let scalingWeights = existing.scalingWeights;
    if (!scalingWeights) {
      if (existing.regimeAtEntry === "RANGE") scalingWeights = [0.25, 0.35, 0.40];
      else if (existing.regimeAtEntry === "TREND") scalingWeights = [0.30, 0.30, 0.40];
      else scalingWeights = [1.0]; // fallback
    }

    const weight = scalingWeights[targetStage - 1] ?? 0;
    if (weight <= 0) return null;

    // Calculate incremental size. 
    // initialSizeUsd was the 100% target or the logic's target size.
    // In our case, adaptive.sizeUsd is already scaled by weight in Executors. 
    // BUT adaptiveResult in executors (adaptive-entry-policy) might be recalculating the whole size.
    // Actually, Executor returns EntryDecisionBase.size_usd which is the incremental size?
    // Let's check executors.
    // RangeExecutor: targetUsd = initialTotalUsd * weight;
    // So adaptive.sizeUsd is the INCREMENTAL size.

    let incrementalSizeUsd = adaptive.sizeUsd;
    const re = this.lastRiskExposure;
    const symEx = String(existing.symbol);
    if (re) {
      incrementalSizeUsd = Math.round(incrementalSizeUsd * re.sizeMultiplier * 100) / 100;
    }
    if (existing.regimeAtEntry === "TREND") {
      const pyr = this.trendPyramidLevelBySymbol.get(symEx) ?? 0;
      const tfs = this.trendFollowScoreBySymbol.get(symEx) ?? 0;
      const bcf = this.trendBreakoutConfidenceBySymbol.get(symEx) ?? 0.5;
      if (!trendPyramidAllowsScaleIn(tfs, pyr)) {
        this.logger.info("scale_in_blocked_trend_pyramid_policy", {
          symbol: existing.symbol,
          trendFollowScore: tfs,
          pyramidLevel: pyr
        });
        return null;
      }
      const uplift = trendPyramidSizeUplift(pyr, tfs, bcf);
      incrementalSizeUsd = Math.round(
        incrementalSizeUsd * uplift * (re?.switchSizeMultiplier ?? 1) * 100
      ) / 100;
    }
    if (existing.regimeAtEntry === "RANGE") {
      const rSt = this.lastTickRangeEvalBySymbol.get(symEx);
      if (rSt) {
        const legM = rangeLadderLegMultiplier(rSt.rangeLadderLevel, rSt.hedgeBalance);
        const cycM = rangeCycleSizePolicy(rSt.rangeCycleCount, rSt.hedgeBalance);
        const recM = rangeAccumulationRecoveryMultiplier(rSt.hedgeBalance, existing.side, rSt.rangeCycleCount);
        incrementalSizeUsd = Math.round(incrementalSizeUsd * legM * cycM * recM * 100) / 100;
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

    await this.store.appendJsonlLine("reports/events.jsonl", {
      ts: nowTs,
      type: "ENTRY_OPENED", // reusing type to track increments
      symbol: String(existing.symbol),
      side: existing.side,
      regime: this.lastRegime.regime,
      executor: decision.executor,
      sizeUsd: incrementalSizeUsd,
      leverage: existing.leverage,
      expected_move: decision.expected_move,
      total_cost: decision.total_cost,
      risk_state: (this.lastRisk?.riskStatus ?? "NORMAL"),
      detail: {
        is_scale_in: true,
        prev_stage: existing.entryStage,
        target_stage: targetStage,
        prev_size: existing.sizeUsd,
        new_total_size: newTotalSizeUsd,
        guidance: res.decision.guidance
      }
    });

    this.logger.info("paper_position_scaled_in", {
      symbol: existing.symbol,
      side: existing.side,
      prev_stage: existing.entryStage,
      target_stage: targetStage,
      incremental_size: incrementalSizeUsd,
      new_total_size: newTotalSizeUsd,
      guidance: res.decision.guidance
    });

    return {
      ...existing,
      sizeUsd: newTotalSizeUsd,
      entryPrice: newEntryPrice,
      entryStage: targetStage,
      scalingWeights,
      trailingExtremePrice: existing.side === "long"
        ? Math.max(existing.trailingExtremePrice ?? 0, first.lastPrice)
        : Math.min(existing.trailingExtremePrice ?? 999999, first.lastPrice)
    };
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
      if (!rF.ok) parts.push(rF.error);
      const failedEndpoint: FailureEndpointKey = !rT.ok ? "ticker" : !rC.ok ? "kline" : !rF.ok ? "funding" : "unknown";
      return { ok: false, error: parts.join("; "), symbolDiagnostics, failedEndpoint };
    }

    const lastPrice = rT.value.last;
    const recentCandlesCount = rC.value.length;
    const latestCandleClose = rC.value.at(-1)?.close;
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
    let signal_missing_reason = "NONE";
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
        } else if (boxPos >= 0.74) {
          entry = {
            ...entry,
            signal: "paper_short_candidate",
            candidateStrength: "weak",
            sidewaysMode: true,
            entryCandidate: true
          };
        } else {
          signal_missing_reason = `BOX_CENTER (pos:${boxPos.toFixed(2)})`;
        }
      } else if (boxRel !== null && boxRel < 0.0035) {
        signal_missing_reason = `BOX_TOO_NARROW (rel:${boxRel.toFixed(5)})`;
      } else {
        signal_missing_reason = "BOX_MISSING";
      }
    } else if (entry.signal === "none") {
      signal_missing_reason = "EMA_CRITERIA_NOT_MET";
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
      if (this.config.paperQualityMinScore > 0 && qualityScore < qualityMinEffective) {
        signal = "none";
        entryCandidate = false;
        gateBlockedReason = "quality_below_min";
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
          signal = "none";
          entryCandidate = false;
          gateBlockedReason = gate.blockReason ?? "gate";
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
      candles: rC.value
    };

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
