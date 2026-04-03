import * as path from "node:path";

import type { EngineConfig, MarketSymbol, PaperClosedPositionRecord, PaperOpenPositionRecord } from "../models/types";
import type { Logger } from "../logs/logger";
import { JsonStore } from "../storage/json-store";
import type { BybitPublicDiagnostics } from "../exchange/bybit-public";
import { BybitPublicClient } from "../exchange/bybit-public";
import { trendFilterOneMinuteCloses } from "../strategy/trend-filter";
import { evaluatePaperLongEntryV0 } from "../strategy/entry-signal";
import type { PaperSignal } from "../strategy/entry-signal";
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
  return {
    totalSymbols,
    longCandidates,
    neutralSymbols: totalSymbols - longCandidates
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

export class PaperEngine {
  private readonly store: JsonStore;
  private readonly bybit: BybitPublicClient;
  private readonly positions: PositionManager;
  private readonly risk: RiskManager;

  constructor(
    private readonly config: EngineConfig,
    private readonly logger: Logger
  ) {
    this.store = new JsonStore(path.resolve(config.dataDir));
    this.bybit = new BybitPublicClient();
    this.positions = new PositionManager(this.store);
    this.risk = new RiskManager(config);
    if (config.paperMaxOpenPositions > 1) {
      this.logger.warn("paper_max_open_positions_unsupported_schema", {
        configured: config.paperMaxOpenPositions,
        effective: 1,
        note: "data/positions/open.json is single-position v1; clamp behavior to 1 open"
      });
    }
    this.logger.info("paper_entry_gate_config", {
      paper_entry_relaxed: config.paperEntryRelaxed,
      paper_gate_min_move_mult: config.paperGateMinMoveMultiplier,
      paper_require_higher_tf: config.paperRequireHigherTfAlign,
      paper_quality_min: config.paperQualityMinScore,
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
      strategyVersion: "paper-v0",
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
      notes: `paper-v0 EMA20/EMA60 1m long filter; public-only; ${klineTimeframe}; strict-number-parsing`
    };

    let metaPath: string | undefined;
    try {
      metaPath = await this.store.writeSnapshotLatestMeta(meta);
      this.logger.info("snapshot_latest_meta_saved", { metaPath });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("snapshot_latest_meta_save_failed", { error: msg });
    }

    const hasLongCandidate = snapshots.some((s) => s.signal === "paper_long_candidate");
    let candidateRunPath: string | undefined;
    if (hasLongCandidate && latestPath && metaPath) {
      try {
        const candidateSymbols = snapshots
          .filter((s) => s.signal === "paper_long_candidate")
          .map((s) => String(s.symbol));
        candidateRunPath = await this.store.writePaperCandidateRun(fetchedAt, {
          fetchedAt,
          strategyVersion: "paper-v0",
          longCandidates: signalSummary.longCandidates,
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
          strategyVersion: "paper-v0",
          longCandidates: signalSummary.longCandidates,
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

    const open = await this.positions.loadOpen();
    if (!open || open.status !== "open") return;

    const snap = input.snapshots.find((s) => s.symbol === open.symbol);
    if (!snap) return;

    if (snap.signal === "paper_long_candidate") {
      return;
    }

    const closePrice = snap.lastPrice;
    const closedAt = snap.fetchedAt;
    if (!Number.isFinite(closePrice) || !Number.isFinite(open.entryPrice) || open.entryPrice === 0) {
      return;
    }

    const feeRate = this.config.paperTakerFeeRate;
    const openNotionalUsd = open.sizeUsd * open.leverage;
    const closeNotionalUsd = open.sizeUsd * open.leverage;
    const feeUsd = (openNotionalUsd + closeNotionalUsd) * feeRate;
    const pnlUsdGross =
      ((closePrice - open.entryPrice) / open.entryPrice) * open.sizeUsd * open.leverage;
    const rawOpenFr = open.openFundingRate;
    const fundingRateAppliedOpen = typeof rawOpenFr === "number" && Number.isFinite(rawOpenFr) ? rawOpenFr : 0;
    const rawCloseFr = snap.fundingRate;
    const fundingRateAppliedClose =
      typeof rawCloseFr === "number" && Number.isFinite(rawCloseFr)
        ? rawCloseFr
        : fundingRateAppliedOpen !== 0
          ? fundingRateAppliedOpen
          : 0;
    const fundingRateAverage = (fundingRateAppliedOpen + fundingRateAppliedClose) / 2;

    const intervalH = this.config.paperFundingIntervalHours;
    const intervalMs = intervalH * 60 * 60 * 1000;
    const holdingMsRaw = closedAt - open.openedAt;
    const holdingMs = holdingMsRaw <= 0 ? 0 : holdingMsRaw;
    const fundingPeriods = intervalMs > 0 && holdingMs > 0 ? holdingMs / intervalMs : 0;
    const fundingUsd = open.sizeUsd * open.leverage * fundingRateAverage * fundingPeriods;
    const pnlUsdNet = pnlUsdGross - feeUsd - fundingUsd;

    const closed: PaperClosedPositionRecord = {
      openedAt: open.openedAt,
      closedAt,
      symbol: open.symbol,
      side: "long",
      entryPrice: open.entryPrice,
      closePrice,
      leverage: open.leverage,
      sizeUsd: open.sizeUsd,
      pnlUsd: pnlUsdNet,
      pnlUsdGross,
      pnlUsdNet,
      feeRate,
      feeUsd,
      fundingModel: "avg_open_close_rate_v3",
      fundingIntervalHours: intervalH,
      holdingMs,
      fundingPeriods,
      fundingRateAppliedOpen,
      fundingRateAppliedClose,
      fundingRateAverage,
      fundingUsd,
      strategyVersion: open.strategyVersion,
      sourceSignal: open.sourceSignal,
      sourceRunPath: open.sourceRunPath,
      ...(input.latestPath ? { latestSnapshotPath: input.latestPath } : {}),
      ...(input.metaPath ? { latestMetaPath: input.metaPath } : {}),
      ...(input.filePath ? { timestampSnapshotPath: input.filePath } : {}),
      closeReason: "candidate_lost"
    };

    await this.positions.appendClosed(closed);
    await this.positions.deleteOpen();
    this.logger.info("paper_position_closed", {
      symbol: open.symbol,
      pnlUsd: pnlUsdNet,
      pnlUsdGross,
      feeUsd,
      fundingUsd,
      fundingModel: "avg_open_close_rate_v3",
      fundingRateAverage,
      fundingPeriods,
      closeReason: "candidate_lost"
    });
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

    const first = input.snapshots.find((s) => s.signal === "paper_long_candidate");
    if (!first) return;

    const existing = await this.positions.loadOpen();
    if (existing && existing.status === "open") {
      this.logger.info("paper_position_skipped_existing_open", { symbol: existing.symbol });
      return;
    }

    if (!input.candidateRunPath || !input.latestPath || !input.metaPath || !input.filePath) {
      return;
    }

    const record: PaperOpenPositionRecord = {
      openedAt: Date.now(),
      symbol: first.symbol,
      side: "long",
      entryPrice: first.lastPrice,
      leverage: this.config.leverage,
      sizeUsd: DEFAULT_PAPER_SIZE_USD,
      strategyVersion: "paper-v0",
      sourceSignal: "paper_long_candidate",
      sourceRunPath: input.candidateRunPath,
      latestSnapshotPath: input.latestPath,
      latestMetaPath: input.metaPath,
      timestampSnapshotPath: input.filePath,
      ...(Number.isFinite(first.fundingRate) ? { openFundingRate: first.fundingRate } : {}),
      status: "open"
    };

    const openPath = await this.positions.saveOpen(record);
    this.logger.info("paper_position_opened", { symbol: record.symbol, path: openPath });
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
    const entry = evaluatePaperLongEntryV0({
      symbol,
      trendOk: trend.trendOk,
      ema20: trend.ema20,
      latestCandleClose
    });

    const qualityScore = computePaperEntryQualityScore({
      trendOk: trend.trendOk,
      ema20: trend.ema20,
      ema60: trend.ema60,
      lastPrice,
      latestCandleClose
    });
    const signalStrength = paperSignalStrengthLabel(qualityScore, this.config.paperEntryRelaxed);

    let signal: PaperSignal = entry.signal;
    let entryCandidate = entry.entryCandidate;
    let gateEval: ReturnType<typeof evaluateEntryCostAndHigherTfGate> | null = null;
    let gateBlockedReason: string | null = null;

    if (entry.signal === "paper_long_candidate") {
      if (
        this.config.paperEntryRelaxed &&
        this.config.paperQualityMinScore > 0 &&
        qualityScore < this.config.paperQualityMinScore
      ) {
        signal = "none";
        entryCandidate = false;
        gateBlockedReason = "quality_below_min";
        this.logger.info("DEBUG_ENTRY_BLOCKED_REASON", {
          symbol,
          reason: "quality_below_min",
          paper_entry_relaxed: this.config.paperEntryRelaxed,
          quality_score: qualityScore,
          paper_quality_min: this.config.paperQualityMinScore
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
          paperBypassExpectedMoveGate: true
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
        quality_score: qualityScore,
        signal_strength: signalStrength,
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
      signal
    };

    this.logger.info("symbol_snapshot", snapshot);
    this.logger.info("symbol_signal", { symbol, signal, trendOk: trend.trendOk });
    return { ok: true, snapshot, symbolDiagnostics };
  }
}
