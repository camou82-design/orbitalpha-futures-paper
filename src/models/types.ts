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
  /**
   * Min ms after a symbol’s last close before a new open on that symbol (0 = off).
   * Paper-only; cuts fee churn from immediate re-entry after candidate_lost.
   */
  paperReentryCooldownMs: number;
  /** Paper-only: round-trip slippage estimate in bps (1bp = 0.0001). Used by risk fee filter. */
  paperSlippageBps: number;
  /** Paper-only: if today's net PnL <= -limit, block all new entries (<=0 disables). */
  paperDailyLossLimitUsd: number;
  /** Paper-only: last10 net PnL <= -threshold triggers size reduction (<=0 disables). */
  paperLast10NetDegradeThresholdUsd: number;
  /** Paper-only: size multiplier when last10 net is degrading. */
  paperDegradeSizeMultiplier: number;
  /** Paper-only: per-regime loss streak count to suspend that regime. */
  paperModeLossStreakSuspendCount: number;
  /** Paper-only: suspend duration ms for a regime after loss streak. */
  paperModeSuspendMs: number;
  /** AI block evaluator: good_block threshold (percent). Example: -0.25 means <= -0.25% is good_block. */
  aiBlockGoodThresholdPct: number;
  /** AI block evaluator: missed_opportunity threshold (percent). Example: 0.35 means >= +0.35% is missed. */
  aiBlockMissedThresholdPct: number;
  /** AI block evaluator horizon priority, comma-separated minutes in env (e.g. "30,15,5"). */
  aiBlockEvaluationHorizonPriorityMins: ReadonlyArray<5 | 15 | 30>;
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
  /** Timestamp in ms when the signal first disappeared (candidate_lost). Used for grace period. */
  lostAt?: number;
  /** 롱: 고점 / 숏: 저점 — 트레일링 스탑용 */
  trailingExtremePrice?: number;
  /** 진입 시점 적응형 모드 (청산 임계 분기). */
  adaptiveModeAtEntry?: "trend" | "sideways" | "risk_off";
  /** 진입 시점 레짐(RANGE/TREND/NO_TRADE). */
  regimeAtEntry?: "RANGE" | "TREND" | "NO_TRADE";
  /** 실행기(RANGE/TREND/NONE) — 이벤트/리포트 해석용. */
  executorAtEntry?: "RANGE" | "TREND" | "NONE";
  /** 진입 시점 기대 움직임(ATR/price), 비용 대비 필터 값(옵션). */
  expectedMoveAtEntry?: number;
  /** 진입 시점 총 비용(fee+slippage+safety) (옵션). */
  totalCostAtEntry?: number;
  /** 분할 청산 단계 (0=없음, 1=1차 완료, 2=2차 완료·잔여만). 하위 호환: 미설정은 0. */
  partialExitStage?: number;
  /** 최초 진입 마진(USD). 미설정 시 `sizeUsd`만 사용(레거시). */
  initialSizeUsd?: number;
  /** 진입 후 관측한 최고 순이익률(순손익/마진). 분할·트레일 참고. */
  highestPnlPctNet?: number;
  /** 트레일링 기준으로 마지막으로 잠근 가격/레벨(옵션). */
  lastTrailLevel?: number;
  /** 진입 시 신뢰도(로그·분석용, 옵션). */
  entryConfidenceScore?: number;
  entryConfidenceTier?: string;
  entrySizeMultiplier?: number;
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
  /** 진입 시점 레짐(RANGE/TREND/NO_TRADE) — 모드별 성과 분리용. */
  regimeAtEntry?: "RANGE" | "TREND" | "NO_TRADE";
  latestSnapshotPath?: string;
  latestMetaPath?: string;
  timestampSnapshotPath?: string;
  closeReason:
    | "candidate_lost"
    | "take_profit"
    | "stop_loss"
    | "trailing_stop"
    | "time_based_exit"
    | "trend_break_exit"
    | "regime_exit"
    | "partial_exit_1"
    | "partial_exit_2";
}>;

