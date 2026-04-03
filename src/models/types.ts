export type MarketSymbol = "BTCUSDT" | "ETHUSDT" | (string & {});

export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export type Candle = Readonly<{
  ts: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>;

export type Ticker = Readonly<{
  symbol: MarketSymbol;
  ts: number; // epoch ms
  last: number;
  bid?: number;
  ask?: number;
}>;

export type FundingRate = Readonly<{
  symbol: MarketSymbol;
  ts: number; // epoch ms
  rate: number; // e.g. 0.0001 = 0.01%
}>;

export type PositionSide = "LONG" | "SHORT";

export type PaperPosition = Readonly<{
  symbol: MarketSymbol;
  side: PositionSide;
  qty: number;
  entryPrice: number;
  leverage: number;
  openedAt: number;
  stopLoss?: number;
  takeProfit?: number;
}>;

export type EngineFees = Readonly<{
  maker: number;
  taker: number;
}>;

export type EngineConfig = Readonly<{
  symbols: MarketSymbol[];
  leverage: number;
  longOnly: boolean;
  fees: EngineFees;
  /** Taker fee rate for paper futures close PnL (round-trip fees). See env ORBITALPHA_PAPER_FUTURES_TAKER_FEE_RATE. */
  paperTakerFeeRate: number;
  /** Hours per funding accrual period (v3). See ORBITALPHA_PAPER_FUTURES_FUNDING_INTERVAL_HOURS. */
  paperFundingIntervalHours: number;
  dataDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Paper-only: relax gates (this repo is paper-only; no live engine here). */
  paperEntryRelaxed: boolean;
  paperGateMinMoveMultiplier: number;
  paperRequireHigherTfAlign: boolean;
  paperQualityMinScore: number;
  /** When relaxed + weak sideways candidate, quality floor (lower than `paperQualityMinScore`). */
  paperQualityMinScoreWeak: number;
  paperMaxOpenPositions: number;
  /** Min positive (ema20-ema60)/ema60 for "strong" long; symmetric for short. Paper-only. */
  paperStrongEmaGapThreshold: number;
  /** Max |emaGap| for weak/sideways long or short (must be >= strong threshold). Paper-only. */
  paperSidewaysEmaGapThreshold: number;
}>;

/** One leg in `positions/open.json` (JSON array of up to `paperMaxOpenPositions` records). */
export type PaperOpenPositionRecord = Readonly<{
  openedAt: number;
  symbol: MarketSymbol;
  side: "long" | "short";
  entryPrice: number;
  leverage: number;
  sizeUsd: number;
  strategyVersion: string;
  sourceSignal: string;
  sourceRunPath: string;
  latestSnapshotPath?: string;
  latestMetaPath?: string;
  timestampSnapshotPath?: string;
  /** Perpetual funding rate from the open snapshot (`snapshot.fundingRate`); used in funding v3. */
  openFundingRate?: number;
  status: "open";
}>;

/** Appended to `data/positions/history.json` when a paper position is closed. */
export type PaperClosedPositionRecord = Readonly<{
  openedAt: number;
  closedAt: number;
  symbol: MarketSymbol;
  side: "long" | "short";
  entryPrice: number;
  closePrice: number;
  leverage: number;
  sizeUsd: number;
  /** Same as `pnlUsdNet` (gross minus fees and v3 funding). */
  pnlUsd: number;
  pnlUsdGross: number;
  pnlUsdNet: number;
  feeRate: number;
  feeUsd: number;
  fundingModel: "avg_open_close_rate_v3";
  fundingIntervalHours: number;
  holdingMs: number;
  fundingPeriods: number;
  fundingRateAppliedOpen: number;
  /** Close snapshot rate; if invalid, falls back to open rate or 0. */
  fundingRateAppliedClose: number;
  /** `(fundingRateAppliedOpen + fundingRateAppliedClose) / 2`. */
  fundingRateAverage: number;
  /** `sizeUsd * leverage * fundingRateAverage * fundingPeriods`. */
  fundingUsd: number;
  strategyVersion: string;
  sourceSignal: string;
  sourceRunPath: string;
  latestSnapshotPath?: string;
  latestMetaPath?: string;
  timestampSnapshotPath?: string;
  closeReason: "candidate_lost";
}>;

