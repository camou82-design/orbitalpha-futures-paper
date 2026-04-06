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
import { detectFuturesMarketMode, type FuturesMarketMode } from "../strategy/live-market-mode";
import { runFuturesAdaptiveEntry } from "../strategy/live-entry-pipeline";
import { evaluateExitPolicy, stopLossPctForMode } from "../strategy/live-exit-policy";
import { evaluatePartialExitPolicy } from "../strategy/live-partial-exit-policy";
import { MIN_POSITION_SIZE_USD } from "../strategy/live-position-sizing";
import {
  entryGateHigherTfKlineLimit,
  entryGateHigherTimeframe,
  evaluateEntryCostAndHigherTfGate
} from "../strategy/entry-gate";
import { computePaperEntryQualityScore, paperSignalStrengthLabel } from "../strategy/paper-entry-quality";
import { paperHealthStatusLogPayload } from "../storage/paper-health";
import { PositionManager } from "./position-manager";
import { RiskManager } from "./risk-manager";

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
  private lastAdaptiveMode: Readonly<{ mode: FuturesMarketMode; detail: Record<string, unknown> }> = {
    mode: "sideways",
    detail: {}
  };

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

    const allowed = new Set<MarketSymbol>(["BTCUSDT", "ETHUSDT"]);
    const symbols = this.config.symbols.filter((s) => allowed.has(s));
    const fetchedAt = Date.now();
    const klineTimeframe = "1m" as const;
    const klineInterval = "1";
    const klineLimit = 120;
    const category = "linear";

    const btc5r = await this.bybit.tryGetCandles("BTCUSDT", "5m", 50);
    const btc5 = btc5r.ok ? btc5r.value : [];
    const modeDetected = detectFuturesMarketMode({ btcCandles5m: btc5 });
    this.lastAdaptiveMode = modeDetected;
    const modeLogKey =
      modeDetected.mode === "trend"
        ? "market_mode_trend"
        : modeDetected.mode === "sideways"
          ? "market_mode_sideways"
          : "market_mode_risk_off";
    this.logger.info(modeLogKey, { detail: modeDetected.detail });

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

    await this.tryPaperPositionOpen({
      snapshots,
      errorsCount: errors.length,
      candidateRunPath,
      latestPath,
      metaPath,
      filePath
    });

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
      const modeForExit: FuturesMarketMode = open.adaptiveModeAtEntry ?? this.lastAdaptiveMode.mode;

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

      const slThresh = stopLossPctForMode(modeForExit);
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
        continue;
      }

      const partial = evaluatePartialExitPolicy({
        mode: modeForExit,
        direction: open.side,
        pnlPctNet: m.pnlPctNet,
        highestPnlPctNet: open.highestPnlPctNet ?? m.pnlPctNet,
        holdingMs: m.holdingMs,
        partialExitStage: open.partialExitStage ?? 0
      });

      if (partial.shouldExitPartial) {
        const ratio = partial.partialExitRatio;
        const partialMargin = Math.round(open.sizeUsd * ratio * 100) / 100;
        const newMargin = Math.round((open.sizeUsd - partialMargin) * 100) / 100;
        if (newMargin < MIN_POSITION_SIZE_USD) {
          this.logger.info("partial_exit_skipped", {
            ...exitDetailBase(open, m),
            reason: "remaining_below_min",
            partial_ratio: ratio,
            remaining_after: newMargin,
            min_usd: MIN_POSITION_SIZE_USD,
            detail: partial.detail
          });
        } else {
          const stage = open.partialExitStage ?? 0;
          const pReason = stage === 0 ? ("partial_exit_1" as const) : ("partial_exit_2" as const);
          const pLog = stage === 0 ? "partial_exit_first" : "partial_exit_second";
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
          open = {
            ...open,
            sizeUsd: newMargin,
            partialExitStage: stage + 1
          };
          m = leg(open.sizeUsd);
        }
      }

      const exitEval = evaluateExitPolicy({
        mode: modeForExit,
        side: open.side,
        pnlPctNet: m.pnlPctNet,
        holdingMs: m.holdingMs,
        mark: closePrice,
        trailingExtreme: open.trailingExtremePrice,
        exitProfile: (open.partialExitStage ?? 0) >= 1 ? "runner" : "full",
        partialExitStage: open.partialExitStage ?? 0
      });

      if (exitEval.action === "close") {
        const cr = exitEval.reason;
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
        continue;
      }

      const posTrail = { ...open, trailingExtremePrice: exitEval.trailingExtreme };

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

      const closed: PaperClosedPositionRecord = {
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
        ...(input.latestPath ? { latestSnapshotPath: input.latestPath } : {}),
        ...(input.metaPath ? { latestMetaPath: input.metaPath } : {}),
        ...(input.filePath ? { timestampSnapshotPath: input.filePath } : {}),
        closeReason: "candidate_lost"
      };

      await this.positions.appendClosed(closed);
      this.logger.info("paper_position_closed", {
        symbol: open.symbol,
        side: open.side,
        pnlUsd: m.pnlUsdNet,
        closeReason: "candidate_lost",
        holdingMs: m.holdingMs
      });
    }

    if (remaining.length !== opens.length) {
      await this.positions.saveOpenAll(remaining);
    }
  }

  private async tryPaperPositionOpen(input: Readonly<{
    snapshots: SymbolSnapshot[];
    errorsCount: number;
    candidateRunPath: string | undefined;
    latestPath: string | undefined;
    metaPath: string | undefined;
    filePath: string | undefined;
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
    const cooldownMs = this.config.paperReentryCooldownMs;
    const sameDirCooldownMult = 2;
    const lastCloseMetaBySymbol =
      cooldownMs > 0 ? latestCloseMetaBySymbol(await this.store.readPositionsHistory()) : null;
    const nowOpen = Date.now();

    for (const first of candidates) {
      if (next.length >= max) break;
      if (next.some((o) => o.symbol === first.symbol)) {
        this.logger.info("paper_position_skipped_existing_open", { symbol: first.symbol });
        continue;
      }
      if (lastCloseMetaBySymbol !== null) {
        const meta = lastCloseMetaBySymbol.get(String(first.symbol));
        const lastClose = meta?.closedAt ?? 0;
        const elapsed = nowOpen - lastClose;
        const intentSide: "long" | "short" =
          first.signal === "paper_long_candidate" ? "long" : "short";
        const sameDirection = meta !== undefined && meta.side === intentSide;
        const waitMs = sameDirection ? cooldownMs * sameDirCooldownMult : cooldownMs;
        if (lastClose > 0 && elapsed < waitMs) {
          this.logger.info("paper_position_skipped_reentry_cooldown", {
            symbol: first.symbol,
            ms_since_close: elapsed,
            cooldown_ms: waitMs,
            same_direction_reentry: sameDirection
          });
          continue;
        }
      }

      const adaptive = runFuturesAdaptiveEntry({
        mode: this.lastAdaptiveMode.mode,
        modeDetail: this.lastAdaptiveMode.detail,
        snap: {
          symbol: String(first.symbol),
          signal: first.signal,
          lastPrice: first.lastPrice,
          latestCandleClose: first.latestCandleClose,
          ema20: first.ema20,
          ema60: first.ema60,
          qualityScore: first.qualityScore,
          candidateStrength: first.candidateStrength,
          emaGap: first.emaGap,
          volumeRatioProxy: first.volumeRatioProxy
        },
        baseSizeUsd: DEFAULT_PAPER_SIZE_USD
      });

      if (!adaptive.ok) {
        this.logger.info(adaptive.logMessage, adaptive.detail);
        this.logger.info("entry_blocked_reason", { reason: adaptive.logMessage, ...adaptive.detail });
        if (adaptive.logMessage === "position_size_blocked_low_confidence") {
          this.logger.info("position_size_blocked_low_confidence", adaptive.detail);
        }
        continue;
      }

      const expectedSide: "long" | "short" =
        first.signal === "paper_long_candidate" ? "long" : "short";
      if (adaptive.direction !== expectedSide) {
        this.logger.info("entry_blocked_reason", {
          reason: "blocked_no_structure",
          sub: "direction_signal_mismatch",
          signal_side: expectedSide,
          adaptive_side: adaptive.direction,
          symbol: first.symbol
        });
        continue;
      }

      if (this.config.longOnly && adaptive.direction === "short") {
        this.logger.info("entry_blocked_reason", { reason: "long_only_short_blocked", symbol: first.symbol });
        continue;
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
    }

    if (next.length !== before) {
      await this.positions.saveOpenAll(next);
    }
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
      volumeRatioProxy: volumeRatioProxyFromCandles(rC.value)
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
