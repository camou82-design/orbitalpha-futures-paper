import * as path from "node:path";

import type {
  EngineConfig,
  MarketSymbol,
  PaperClosedPositionRecord,
  PaperOpenPositionRecord
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
import { evaluatePartialExitPolicy } from "../strategy/live-partial-exit-policy";
import { MIN_POSITION_SIZE_USD } from "../strategy/live-position-sizing";
import {
  entryGateHigherTfKlineLimit,
  entryGateHigherTimeframe,
  evaluateEntryCostAndHigherTfGate,
  atrWilderLast
} from "../strategy/entry-gate";
import { computePaperEntryQualityScore, paperSignalStrengthLabel } from "../strategy/paper-entry-quality";
import { detectMarketRegime, type MarketRegime } from "../strategy/market-regime-detector";
import { evaluateRegimeEntry } from "../strategy/regime-entry";
import { paperHealthStatusLogPayload } from "../storage/paper-health";
import { PositionManager } from "./position-manager";
import { RiskManager } from "./risk-manager";
import { evaluateRiskControls, type RiskControlDecision } from "../strategy/risk-control-layer";
import { rangeExecutorEvaluateEntry, rangeExecutorEvaluateExit } from "../strategy/executors/range-executor";
import { trendExecutorEvaluateEntry, trendExecutorEvaluateExit } from "../strategy/executors/trend-executor";
import type { AnyEntryDecision } from "../strategy/executors/types";
import { executorForExitEventPayload } from "../strategy/executors/executor-normalize";
import { aiApproveEntry, aiInputFromDecision } from "../ai/entry-approval";
import {
  aggregateRejectReasonCountsTick,
  computeFunnelTick,
  DECISION_FUNNEL_RING_MAX,
  sumDecisionFunnelTicks,
  type DecisionFunnelTick
} from "./decision-funnel";
import { evaluatePaperSymbolEntry, type EvaluatePaperSymbolEntryResult } from "./paper-symbol-decision";

const EP = {
  ticker: "/v5/market/tickers",
  kline: "/v5/market/kline",
  funding: "/v5/market/funding/history"
} as const;

const DEFAULT_PAPER_SIZE_USD = 100;

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
  engineMode: "paper";
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

/** Latest close per symbol: time + side (같은 방향 재진입 쿨다운용). */
function latestCloseMetaBySymbol(history: readonly unknown[]): Map<string, { closedAt: number; side: "long" | "short" }> {
  const m = new Map<string, { closedAt: number; side: "long" | "short" }>();
  for (const row of history) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const sym = o.symbol;
    const closed = o.closedAt;
    const side = o.side;
    if (typeof sym !== "string" || typeof closed !== "number" || !Number.isFinite(closed)) continue;
    if (side !== "long" && side !== "short") continue;
    const prev = m.get(sym);
    if (!prev || closed >= prev.closedAt) m.set(sym, { closedAt: closed, side });
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

type PaperCloseLegMetrics = Readonly<{
  pnlUsdGross: number;
  pnlUsdNet: number;
  pnlPctNet: number;
  feeUsd: number;
  fundingUsd: number;
  fundingPeriods: number;
  fundingRateAppliedOpen: number;
  fundingRateAppliedClose: number;
  fundingRateAverage: number;
  holdingMs: number;
}>;

function computePaperCloseLegMetrics(input: Readonly<{
  open: PaperOpenPositionRecord;
  closePrice: number;
  closedAt: number;
  snapFundingRate: number;
  marginUsd: number;
  paperTakerFeeRate: number;
  paperFundingIntervalHours: number;
}>): PaperCloseLegMetrics {
  const feeRate = input.paperTakerFeeRate;
  const lev = input.open.leverage;
  const margin = input.marginUsd;
  const openNotionalUsd = margin * lev;
  const closeNotionalUsd = margin * lev;
  const feeUsd = (openNotionalUsd + closeNotionalUsd) * feeRate;

  const pnlUsdGross =
    input.open.side === "long"
      ? ((input.closePrice - input.open.entryPrice) / input.open.entryPrice) * margin * lev
      : ((input.open.entryPrice - input.closePrice) / input.open.entryPrice) * margin * lev;

  const rawOpenFr = input.open.openFundingRate;
  const fundingRateAppliedOpen = typeof rawOpenFr === "number" && Number.isFinite(rawOpenFr) ? rawOpenFr : 0;
  const rawCloseFr = input.snapFundingRate;
  const fundingRateAppliedClose =
    typeof rawCloseFr === "number" && Number.isFinite(rawCloseFr)
      ? rawCloseFr
      : fundingRateAppliedOpen !== 0
        ? fundingRateAppliedOpen
        : 0;
  const fundingRateAverage = (fundingRateAppliedOpen + fundingRateAppliedClose) / 2;

  const intervalH = input.paperFundingIntervalHours;
  const intervalMs = intervalH * 60 * 60 * 1000;
  const holdingMsRaw = input.closedAt - input.open.openedAt;
  const holdingMs = holdingMsRaw <= 0 ? 0 : holdingMsRaw;
  const fundingPeriods = intervalMs > 0 && holdingMs > 0 ? holdingMs / intervalMs : 0;
  const fundingUsd = margin * lev * fundingRateAverage * fundingPeriods;
  const pnlUsdNet = pnlUsdGross - feeUsd - fundingUsd;
  const pnlPctNet = margin > 0 ? pnlUsdNet / margin : 0;

  return {
    pnlUsdGross,
    pnlUsdNet,
    pnlPctNet,
    feeUsd,
    fundingUsd,
    fundingPeriods,
    fundingRateAppliedOpen,
    fundingRateAppliedClose,
    fundingRateAverage,
    holdingMs
  };
}

export class PaperEngine {
  private readonly store: JsonStore;
  private readonly bybit: BybitPublicClient;
  private readonly positions: PositionManager;
  private readonly risk: RiskManager;
  private lastAdaptiveMode: Readonly<{ mode: FuturesMarketMode; detail: Record<string, unknown> }> = { mode: "sideways", detail: {} };
  private lastRegime: Readonly<{ regime: MarketRegime; detail: Record<string, unknown> }> = { regime: "NO_TRADE", detail: {} };
  private lastRisk: RiskControlDecision | null = null;
  private lastModeChangeAt: number = 0;
  private lastEntryDecision: AnyEntryDecision | null = null;
  private rangeCooldownUntilByKey = new Map<string, number>();
  private rangeFailCountByKey = new Map<string, number>();
  private trendCooldownUntilBySymbol = new Map<string, number>();
  /** 비영속: 최근 틱별 `decision_funnel_tick` 스냅샷 (최대 DECISION_FUNNEL_RING_MAX). */
  private decisionFunnelTickRing: DecisionFunnelTick[] = [];

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
    await this.positions.ensureHistoryFile();
    const history = await this.store.readPositionsHistory();

    const allowed = new Set<MarketSymbol>(["BTCUSDT", "ETHUSDT"]);
    const symbols = this.config.symbols.filter((s) => allowed.has(s));
    const fetchedAt = Date.now();
    const klineTimeframe = "1m" as const;
    const klineInterval = "1";
    const klineLimit = 120;
    const category = "linear";

    const btc5r = await this.bybit.tryGetCandles("BTCUSDT", "5m", 50);
    const btc5 = btc5r.ok ? btc5r.value : [];
    const prevRegime = this.lastRegime.regime;
    const regimeDetected = detectMarketRegime({ btcCandles5m: btc5 });
    this.lastRegime = regimeDetected;
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

    const regimeLogKey =
      regimeDetected.regime === "TREND"
        ? "market_regime_trend"
        : regimeDetected.regime === "RANGE"
          ? "market_regime_range"
          : "market_regime_no_trade";
    this.logger.info(regimeLogKey, { detail: regimeDetected.detail });
    const nowStateTs = Date.now();
    this.lastRisk = evaluateRiskControls({
      config: this.config,
      now: nowStateTs,
      history,
      priorState: this.lastRisk
    });
    const risk = this.lastRisk;

    const snapshots: SymbolSnapshot[] = [];
    const errors: { symbol: MarketSymbol; error: string; failedEndpoint: FailureEndpointKey }[] = [];
    const allSymbolDiagnostics: SymbolDiagnostic[] = [];

    for (const symbol of symbols) {
      const result = await this.pollSymbol(symbol, fetchedAt, klineLimit);
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
      engineMode: "paper",
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

    await this.tryPaperPositionClose({
      snapshots,
      errorsCount: errors.length,
      latestPath,
      metaPath,
      filePath
    });

    const opensAfterClose = await this.positions.loadOpenAll();
    const lastCloseMetaBySymbolForDecision =
      this.config.paperReentryCooldownMs > 0 ? latestCloseMetaBySymbol(await this.store.readPositionsHistory()) : null;
    const regimeUnknown = btc5.length < 60;
    const decisionBySymbol = new Map<string, EvaluatePaperSymbolEntryResult>();
    const nowTick = Date.now();

    for (const sym of symbols) {
      const snap = snapshots.find((s) => s.symbol === sym) ?? null;
      if (!snap) {
        const res = evaluatePaperSymbolEntry({
          config: this.config,
          snapshot: null,
          dataReady: false,
          regime: regimeDetected.regime,
          regimeUnknown,
          risk: this.lastRisk,
          adaptiveMode: this.lastAdaptiveMode.mode,
          adaptiveDetail: this.lastAdaptiveMode.detail,
          now: nowTick,
          rangeCooldownUntilByKey: this.rangeCooldownUntilByKey,
          trendCooldownUntilBySymbol: this.trendCooldownUntilBySymbol,
          lastCloseMetaBySymbol: lastCloseMetaBySymbolForDecision,
          reentryCooldownMs: this.config.paperReentryCooldownMs,
          sameDirCooldownMult: 2,
          hasOpenPosition: false,
          currentStage: 0,
          maxPositionsReached: false
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
          atr: snap.atr
        },
        dataReady: true,
        regime: regimeDetected.regime,
        regimeUnknown,
        risk: this.lastRisk,
        adaptiveMode: this.lastAdaptiveMode.mode,
        adaptiveDetail: this.lastAdaptiveMode.detail,
        now: nowTick,
        rangeCooldownUntilByKey: this.rangeCooldownUntilByKey,
        trendCooldownUntilBySymbol: this.trendCooldownUntilBySymbol,
        lastCloseMetaBySymbol: lastCloseMetaBySymbolForDecision,
        reentryCooldownMs: this.config.paperReentryCooldownMs,
        sameDirCooldownMult: 2,
        hasOpenPosition: hasOpen,
        currentStage,
        maxPositionsReached: opensAfterClose.length >= this.config.paperMaxOpenPositions
      });
      decisionBySymbol.set(String(sym), res);
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
    try {
      const risk = this.lastRisk!;
      await this.store.writeJson("reports/engine-state.json", {
        generatedAt: nowTick,
        engine_mode: this.config.paperEngineMode,
        execution_state: "PAPER_READY",
        strategy_executor:
          regimeDetected.regime === "RANGE" ? "RANGE" : regimeDetected.regime === "TREND" ? "TREND" : "IDLE",
        current_regime: regimeDetected.regime,
        adaptiveMode,
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
    nowTs: number
  ): Promise<void> {
    const sym = String(first.symbol);
    const d = res.decision;
    const ex = res.executorDecision;

    if (d.final_decision === "SKIP" && (d.reject_reason === "SIGNAL_NONE" || d.reject_reason === null)) {
      return;
    }

    const legacyReason = (code: string | null): string => {
      if (!code) return "blocked";
      const m: Record<string, string> = {
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
            detail: { ai_reason: aiOut.reason, ai_confidence: aiOut.confidence, ai_input: aiIn }
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
            detail: { ai_reason: "방향 불일치", ai_confidence: aiOut.confidence }
          });
          return;
        }
      }

      if (!ex?.entry_allowed && ex) {
        await this.store.appendJsonlLine("reports/events.jsonl", {
          ts: nowTs,
          type: "ENTRY_BLOCKED",
          symbol: sym,
          regime: this.lastRegime.regime,
          executor: ex.executor,
          reason: ex.blocked_reason,
          reject_code: d.reject_reason,
          expected_move: ex.expected_move,
          total_cost: ex.total_cost,
          risk_state: ex.risk_state,
          detail: ex.detail
        });
        return;
      }

      if (d.reject_reason === "ORDER_BUILD_FAIL") {
        await this.store.appendJsonlLine("reports/events.jsonl", {
          ts: nowTs,
          type: "BLOCKED",
          symbol: sym,
          regime: this.lastRegime.regime,
          reason: "adaptive_policy_block",
          reject_code: d.reject_reason,
          detail: res.adaptiveDetail
        });
        return;
      }

      await this.store.appendJsonlLine("reports/events.jsonl", {
        ts: nowTs,
        type: "ENTRY_BLOCKED",
        symbol: sym,
        regime: this.lastRegime.regime,
        reason: legacyReason(d.reject_reason),
        reject_code: d.reject_reason,
        expected_move:
          typeof d.expected_move_pct === "number" && Number.isFinite(d.expected_move_pct) ? d.expected_move_pct / 100 : null,
        risk_state: this.lastRisk?.riskStatus ?? "NORMAL"
      });
    }
  }

  private async tryPaperPositionClose(input: Readonly<{
    snapshots: SymbolSnapshot[];
    errorsCount: number;
    latestPath: string | undefined;
    metaPath: string | undefined;
    filePath: string | undefined;
  }>): Promise<void> {
    if (input.errorsCount > 0) return;

    const opens = await this.positions.loadOpenAll();
    if (opens.length === 0) return;

    const remaining: PaperOpenPositionRecord[] = [];
    const feeRate = this.config.paperTakerFeeRate;
    const intervalH = this.config.paperFundingIntervalHours;

    const exitTypeForReason = (
      r: PaperClosedPositionRecord["closeReason"]
    ): "EXIT_TP" | "EXIT_SL" | "EXIT_REGIME" | "EXIT_TREND_BREAK" => {
      if (r === "take_profit" || r === "partial_exit_1" || r === "partial_exit_2") return "EXIT_TP";
      if (r === "stop_loss") return "EXIT_SL";
      if (r === "trend_break_exit") return "EXIT_TREND_BREAK";
      return "EXIT_REGIME";
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
      const regimeForExit: MarketRegime = regimeAtEntry === "TREND" || regimeAtEntry === "RANGE" ? regimeAtEntry : regimeNow;

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

      // 1. Hard SL check (global safety)
      const slThresh = stopLossPctForRegime(regimeForExit);
      if (m.pnlPctNet <= slThresh) {
        const cr = "stop_loss" as const;
        const closedRow: PaperClosedPositionRecord = {
          openedAt: open.openedAt,
          closedAt,
          symbol: open.symbol,
          side: open.side,
          entryPrice: open.entryPrice,
          closePrice,
          leverage: open.leverage,
          sizeUsd: open.sizeUsd,
          pnlUsd: m.pnlUsdNet,
          pnlUsdGross: m.pnlUsdGross,
          pnlUsdNet: m.pnlUsdNet,
          feeRate,
          feeUsd: m.feeUsd,
          fundingModel: "avg_open_close_rate_v3",
          fundingIntervalHours: intervalH,
          holdingMs: m.holdingMs,
          fundingPeriods: m.fundingPeriods,
          fundingRateAppliedOpen: m.fundingRateAppliedOpen,
          fundingRateAppliedClose: m.fundingRateAppliedClose,
          fundingRateAverage: m.fundingRateAverage,
          fundingUsd: m.fundingUsd,
          strategyVersion: "paper-v1",
          sourceSignal: open.sourceSignal,
          sourceRunPath: open.sourceRunPath,
          regimeAtEntry: open.regimeAtEntry,
          ...(input.latestPath ? { latestSnapshotPath: input.latestPath } : {}),
          ...(input.metaPath ? { latestMetaPath: input.metaPath } : {}),
          ...(input.filePath ? { timestampSnapshotPath: input.filePath } : {}),
          closeReason: cr
        };
        await this.positions.appendClosed(closedRow);
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
          const closedRow: PaperClosedPositionRecord = {
            openedAt: open.openedAt,
            closedAt,
            symbol: open.symbol,
            side: open.side,
            entryPrice: open.entryPrice,
            closePrice,
            leverage: open.leverage,
            sizeUsd: open.sizeUsd,
            pnlUsd: m.pnlUsdNet,
            pnlUsdGross: m.pnlUsdGross,
            pnlUsdNet: m.pnlUsdNet,
            feeRate,
            feeUsd: m.feeUsd,
            fundingModel: "avg_open_close_rate_v3",
            fundingIntervalHours: intervalH,
            holdingMs: m.holdingMs,
            fundingPeriods: m.fundingPeriods,
            fundingRateAppliedOpen: m.fundingRateAppliedOpen,
            fundingRateAppliedClose: m.fundingRateAppliedClose,
            fundingRateAverage: m.fundingRateAverage,
            fundingUsd: m.fundingUsd,
            strategyVersion: "paper-v1",
            sourceSignal: open.sourceSignal,
            sourceRunPath: open.sourceRunPath,
            regimeAtEntry: open.regimeAtEntry,
            ...(input.latestPath ? { latestSnapshotPath: input.latestPath } : {}),
            ...(input.metaPath ? { latestMetaPath: input.metaPath } : {}),
            ...(input.filePath ? { timestampSnapshotPath: input.filePath } : {}),
            closeReason: cr
          };
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

      // 3. Evaluate RegimeSpecific Exit (Scale-out)
      const exitEval = regimeForExit === "RANGE"
        ? rangeExecutorEvaluateExit({
          side: open.side,
          pnlPctNet: m.pnlPctNet,
          mark: closePrice,
          boxPos: snap.boxPos,
          boxHigh: snap.boxHigh,
          boxLow: snap.boxLow,
          atr: snap.atr,
          partialExitStage: open.partialExitStage ?? 0,
          holdingMs: m.holdingMs
        })
        : trendExecutorEvaluateExit({
          side: open.side,
          pnlPctNet: m.pnlPctNet,
          mark: closePrice,
          entryPrice: open.entryPrice,
          atr: snap.atr,
          partialExitStage: open.partialExitStage ?? 0,
          holdingMs: m.holdingMs,
          trailingExtreme: open.trailingExtremePrice
        });

      if (exitEval.action === "close") {
        const cr = exitEval.reason as PaperClosedPositionRecord["closeReason"];
        const closedRow: PaperClosedPositionRecord = {
          openedAt: open.openedAt,
          closedAt,
          symbol: open.symbol,
          side: open.side,
          entryPrice: open.entryPrice,
          closePrice,
          leverage: open.leverage,
          sizeUsd: open.sizeUsd,
          pnlUsd: m.pnlUsdNet,
          pnlUsdGross: m.pnlUsdGross,
          pnlUsdNet: m.pnlUsdNet,
          feeRate,
          feeUsd: m.feeUsd,
          fundingModel: "avg_open_close_rate_v3",
          fundingIntervalHours: intervalH,
          holdingMs: m.holdingMs,
          fundingPeriods: m.fundingPeriods,
          fundingRateAppliedOpen: m.fundingRateAppliedOpen,
          fundingRateAppliedClose: m.fundingRateAppliedClose,
          fundingRateAverage: m.fundingRateAverage,
          fundingUsd: m.fundingUsd,
          strategyVersion: "paper-v1",
          sourceSignal: open.sourceSignal,
          sourceRunPath: open.sourceRunPath,
          regimeAtEntry: open.regimeAtEntry,
          ...(input.latestPath ? { latestSnapshotPath: input.latestPath } : {}),
          ...(input.metaPath ? { latestMetaPath: input.metaPath } : {}),
          ...(input.filePath ? { timestampSnapshotPath: input.filePath } : {}),
          closeReason: cr
        };
        await this.positions.appendClosed(closedRow);
        this.logger.info(exitFullLogKey(cr), { ...exitDetailBase(open, m), exitReason: cr });
        this.logger.info("paper_position_closed", { symbol: open.symbol, side: open.side, pnlUsdNet: m.pnlUsdNet, closeReason: cr });
        await this.store.appendJsonlLine("reports/events.jsonl", {
          ts: Date.now(),
          type: exitTypeForReason(cr),
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
          const k = `${String(open.symbol)}:${open.side}`;
          this.rangeFailCountByKey.set(k, 0);
        }
        if (open.regimeAtEntry === "TREND" && (cr === "stop_loss" || cr === "trend_break_exit")) {
          this.trendCooldownUntilBySymbol.set(String(open.symbol), Date.now() + 12 * 60_000);
        }
        continue;
      }

      if (exitEval.action === "partial_close") {
        const partial = exitEval;
        const ratio = (partial as any).partialExitRatio;
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

          const closedPartial: PaperClosedPositionRecord = {
            openedAt: open.openedAt,
            closedAt,
            symbol: open.symbol,
            side: open.side,
            entryPrice: open.entryPrice,
            closePrice,
            leverage: open.leverage,
            sizeUsd: partialMargin,
            pnlUsd: mp.pnlUsdNet,
            pnlUsdGross: mp.pnlUsdGross,
            pnlUsdNet: mp.pnlUsdNet,
            feeRate,
            feeUsd: mp.feeUsd,
            fundingModel: "avg_open_close_rate_v3",
            fundingIntervalHours: intervalH,
            holdingMs: mp.holdingMs,
            fundingPeriods: mp.fundingPeriods,
            fundingRateAppliedOpen: mp.fundingRateAppliedOpen,
            fundingRateAppliedClose: mp.fundingRateAppliedClose,
            fundingRateAverage: mp.fundingRateAverage,
            fundingUsd: mp.fundingUsd,
            strategyVersion: "paper-v1",
            sourceSignal: open.sourceSignal,
            sourceRunPath: open.sourceRunPath,
            regimeAtEntry: open.regimeAtEntry,
            ...(input.latestPath ? { latestSnapshotPath: input.latestPath } : {}),
            ...(input.metaPath ? { latestMetaPath: input.metaPath } : {}),
            ...(input.filePath ? { timestampSnapshotPath: input.filePath } : {}),
            closeReason: pReason
          };
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
            trailingExtremePrice: (partial as any).trailingExtreme
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
        remaining.push({ ...posTrail, lostAt: undefined });
        continue;
      }

      const minHoldMs = 5 * 60_000;
      const gracePeriodMs = 7 * 60_000;

      if (m.holdingMs < minHoldMs) {
        remaining.push(posTrail);
        continue;
      }

      const lostAt = posTrail.lostAt ?? closedAt;
      const elapsedLost = closedAt - lostAt;

      if (elapsedLost < gracePeriodMs) {
        remaining.push({ ...posTrail, lostAt });
        continue;
      }

      const closedRow: PaperClosedPositionRecord = {
        openedAt: open.openedAt,
        closedAt,
        symbol: open.symbol,
        side: open.side,
        entryPrice: open.entryPrice,
        closePrice,
        leverage: open.leverage,
        sizeUsd: open.sizeUsd,
        pnlUsd: m.pnlUsdNet,
        pnlUsdGross: m.pnlUsdGross,
        pnlUsdNet: m.pnlUsdNet,
        feeRate,
        feeUsd: m.feeUsd,
        fundingModel: "avg_open_close_rate_v3",
        fundingIntervalHours: intervalH,
        holdingMs: m.holdingMs,
        fundingPeriods: m.fundingPeriods,
        fundingRateAppliedOpen: m.fundingRateAppliedOpen,
        fundingRateAppliedClose: m.fundingRateAppliedClose,
        fundingRateAverage: m.fundingRateAverage,
        fundingUsd: m.fundingUsd,
        strategyVersion: "paper-v1",
        sourceSignal: open.sourceSignal,
        sourceRunPath: open.sourceRunPath,
        regimeAtEntry: open.regimeAtEntry,
        ...(input.latestPath ? { latestSnapshotPath: input.latestPath } : {}),
        ...(input.metaPath ? { latestMetaPath: input.metaPath } : {}),
        ...(input.filePath ? { timestampSnapshotPath: input.filePath } : {}),
        closeReason: "candidate_lost"
      };
      await this.positions.appendClosed(closedRow);
      this.logger.info("paper_position_closed", {
        symbol: open.symbol,
        side: open.side,
        pnlUsd: m.pnlUsdNet,
        closeReason: "candidate_lost",
        holdingMs: m.holdingMs
      });
      await this.store.appendJsonlLine("reports/events.jsonl", {
        ts: Date.now(),
        type: "EXIT_REGIME",
        symbol: String(open.symbol),
        regime: open.regimeAtEntry ?? null,
        executor: executorForExitEventPayload(open.executorAtEntry, open.regimeAtEntry),
        reason: "candidate_lost",
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

    const candidates = input.snapshots.filter(
      (s) => s.signal === "paper_long_candidate" || s.signal === "paper_short_candidate"
    );
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
      const existingIdx = next.findIndex((o) => o.symbol === first.symbol);
      const res = input.decisionBySymbol.get(String(first.symbol));
      if (!res) continue;

      if (existingIdx >= 0) {
        const scaled = await this.tryPaperPositionScaleIn(next[existingIdx], res, first, nowTs);
        if (scaled) {
          next[existingIdx] = scaled;
        }
        continue;
      }

      if (next.length >= max) break;

      this.lastEntryDecision = res.executorDecision ?? null;

      if (res.decision.final_decision !== "ENTER" || !res.adaptiveResult) {
        await this.emitPipelineEventsFromDecision(first, res, nowTs);
        continue;
      }

      const decision = res.executorDecision!;
      const adaptive = res.adaptiveResult;
      const sym = String(first.symbol);
      const intentSide = res.intentSide!;

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

      const record: PaperOpenPositionRecord = {
        openedAt: Date.now(),
        symbol: first.symbol,
        side: adaptive.direction,
        entryPrice: first.lastPrice,
        leverage: levScaled,
        sizeUsd: adaptive.sizeUsd,
        initialSizeUsd: adaptive.sizeUsd,
        partialExitStage: 0,
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
        status: "open"
      };

      next.push(record);
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
        risk_state: (this.lastRisk?.riskStatus ?? "NORMAL")
      });
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

    const incrementalSizeUsd = adaptive.sizeUsd;
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
    klineLimit: number
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
    const entry = evaluatePaperEntryV1({
      symbol,
      ema20: trend.ema20,
      ema60: trend.ema60,
      latestCandleClose,
      strongEmaGapThreshold: this.config.paperStrongEmaGapThreshold,
      sidewaysEmaGapThreshold: this.config.paperSidewaysEmaGapThreshold
    });

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
        this.logger.info("DEBUG_ENTRY_BLOCKED_REASON", {
          symbol,
          reason: "quality_below_min",
          paper_entry_relaxed: this.config.paperEntryRelaxed,
          quality_score: qualityScore,
          paper_quality_min_effective: qualityMinEffective,
          paper_quality_min: this.config.paperQualityMinScore,
          paper_quality_min_weak: this.config.paperQualityMinScoreWeak,
          candidate_strength: entry.candidateStrength,
          weak_sideways_lower_floor: entry.candidateStrength === "weak"
        });
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
          this.logger.info("DEBUG_ENTRY_BLOCKED_REASON", {
            symbol,
            reason: gate.blockReason,
            paper_entry_relaxed: this.config.paperEntryRelaxed,
            fee_filter_disabled: gate.feeExpectedMoveGateBypassed === true,
            original_fee_filter_pass: gate.originalExpectedMovePass === true,
            expected_move: gate.expectedMove,
            required_move: gate.requiredMove,
            required_move_threshold: gate.requiredMoveThreshold,
            higher_tf: tfHi,
            higher_tf_aligned: gate.higherTfAligned
          });
        }
      }

      this.logger.info("PAPER_ENTRY_LINE", {
        paper_entry_relaxed: this.config.paperEntryRelaxed,
        symbol,
        trend_ok: trend.trendOk,
        ema_gap: entry.emaGap,
        sideways_mode: entry.sidewaysMode,
        candidate_strength: entry.candidateStrength,
        quality_score: qualityScore,
        signal_strength: signalStrength,
        quality_min_effective: qualityMinEffective,
        weak_sideways_quality_note:
          entry.candidateStrength === "weak"
            ? `weak_floor_${qualityMinEffective}_strong_floor_${this.config.paperQualityMinScore}`
            : null,
        side: entrySide,
        base_signal: entry.signal,
        fee_filter_disabled: gateEval?.feeExpectedMoveGateBypassed === true,
        original_fee_filter_pass: gateEval?.originalExpectedMovePass === true,
        fee_filter_pass:
          gateEval != null
            ? gateEval.feeExpectedMoveGateBypassed === true || gateEval.originalExpectedMovePass === true
            : gateBlockedReason === "quality_below_min"
              ? false
              : null,
        entry_blocked:
          gateBlockedReason ??
          (gateEval && !gateEval.allowed ? gateEval.blockReason : false),
        gate_expected_move: gateEval?.expectedMove,
        gate_required_threshold: gateEval?.requiredMoveThreshold,
        higher_tf_required: this.config.paperRequireHigherTfAlign,
        higher_tf_aligned: gateEval?.higherTfAligned ?? null,
        max_open_positions: this.config.paperMaxOpenPositions,
        final_signal: signal
      });
    } else {
      this.logger.info("PAPER_ENTRY_LINE", {
        paper_entry_relaxed: this.config.paperEntryRelaxed,
        symbol,
        trend_ok: trend.trendOk,
        ema_gap: entry.emaGap,
        sideways_mode: entry.sidewaysMode,
        candidate_strength: entry.candidateStrength,
        quality_score: 0,
        signal_strength: paperSignalStrengthLabel(0, this.config.paperEntryRelaxed),
        quality_min_effective: null,
        weak_sideways_quality_note: null,
        side: null,
        base_signal: entry.signal,
        fee_filter_disabled: null,
        original_fee_filter_pass: null,
        fee_filter_pass: null,
        entry_blocked: null,
        gate_expected_move: null,
        gate_required_threshold: null,
        higher_tf_required: this.config.paperRequireHigherTfAlign,
        higher_tf_aligned: null,
        max_open_positions: this.config.paperMaxOpenPositions,
        final_signal: "none"
      });
    }

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
      atr,
      gateExpectedMove: gateEval?.expectedMove ?? null,
      gateRequiredMove: gateEval?.requiredMove ?? null
    };

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
