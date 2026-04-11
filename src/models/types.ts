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

export type PaperEngineMode = "PAPER_TEST" | "SAFE" | "RESEARCH";

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
  /** Paper observation: engine label for dashboards (default PAPER_TEST). */
  paperEngineMode: PaperEngineMode;
  /** Min RR from regime TP/SL design; below => EDGE_FAIL_RR (default 1.0). */
  paperMinEdgeRr: number;
  /** Min gate expected move (fraction of price) for EDGE_FAIL_LOW_VOL (default 0.00003). */
  paperMinEdgeVolatilityMove: number;
}>;

/** Standard paper entry decision reject codes (see `evaluatePaperSymbolEntry`). */
export type PaperDecisionRejectReason =
  | "DATA_NOT_READY"
  | "SIGNAL_NONE"
  | "REGIME_NO_TRADE"
  | "REGIME_UNKNOWN"
  | "AMBIGUOUS_WATCHING"
  | "AMBIGUOUS_TREND_REVIEW"
  | "AMBIGUOUS_RANGE_REVIEW"
  | "EDGE_FAIL_FEE"
  | "EDGE_FAIL_RR"
  | "EDGE_FAIL_LOW_VOL"
  | "EDGE_FAIL_EXPECTANCY"
  | "RISK_FAIL_REENTRY"
  | "RISK_COOLDOWN"
  | "RISK_LOSS_STREAK"
  | "RISK_MAX_DRAWDOWN"
  | "RISK_MAX_POSITIONS"
  | "AI_REJECT"
  | "AI_LOW_CONFIDENCE"
  | "ADAPTIVE_REJECT"
  | "ORDER_BUILD_FAIL"
  | "EXECUTOR_INIT_FAIL"
  | "EXECUTION_DISABLED"
  | "AI_DIRECTION_MISMATCH"
  | "LEGACY_BLOCKED";

export type PaperSignalState = "NONE" | "LONG_CANDIDATE" | "SHORT_CANDIDATE";
export type PaperRegimeState = "TREND" | "RANGE" | "NO_TRADE" | "UNKNOWN";
export type PaperEdgeState = "PASS" | "FAIL_FEE" | "FAIL_RR" | "FAIL_LOW_VOL" | "FAIL_EXPECTANCY";
export type PaperRiskState =
  | "PASS"
  | "SOFT_BLOCK"
  | "HARD_BLOCK"
  | "COOLDOWN"
  | "LOSS_STREAK"
  | "MAX_DRAWDOWN";
export type PaperExecutionState =
  | "PAPER_READY"
  | "IDLE"
  | "STAGE1_EXEC_PENDING"
  | "AMBIGUOUS_TREND_REVIEW"
  | "AMBIGUOUS_RANGE_REVIEW"
  | "DISABLED"
  | "INIT_FAIL"
  | "ORDER_BUILD_FAIL";
export type PaperFinalDecision = "ENTER" | "REJECT" | "SKIP" | "DISABLED";
export type PaperStrategyExecutor = "TREND" | "RANGE" | "IDLE";

/**
 * One symbol’s pipeline result (JSON-serializable; also written to `reports/decisions.jsonl`).
 */
export type PaperSymbolDecisionRecord = Readonly<{
  ts: number;
  /** ISO-8601 for operators / external tools */
  timestamp: string;
  symbol: string;
  engine_mode: string;
  signal_state: PaperSignalState;
  regime_state: PaperRegimeState;
  edge_state: PaperEdgeState;
  risk_state: PaperRiskState;
  execution_state: PaperExecutionState;
  final_decision: PaperFinalDecision;
  strategy_executor: PaperStrategyExecutor;
  reject_reason: PaperDecisionRejectReason | null;
  expected_move_pct?: number | null;
  fee_estimate_pct?: number | null;
  rr?: number | null;
  /** Gate expected move as fraction of price (same basis as `gateExpectedMove`). */
  volatility_move?: number | null;
  slippage_buffer_pct?: number;
  safety_margin_pct?: number;
  atr_pct?: number | null;
  ai_decision?: string | null;
  adaptive_decision?: string | null;
  pipeline_version?: string;
  /** 현재 행동 가이드 (UI 표시용) */
  guidance?: string;
  /** 다음 예상 행동 */
  next_action?: string;
  /** 시나리오 무효화 조건 */
  invalidate_condition?: string;
  /** 리스크 특이사항 */
  risk_note?: string;
  /** 감시 구역 (예: "박스 하단 102k-103k") */
  watch_zone?: string;
  /** 진입 진행도 (0~100%) */
  entry_progress?: number;
  /** 진입/추가진입 목표 단계 (1, 2, 3) */
  target_stage?: number;
  /** 보조 차단 사유들 */
  supplemental_reasons?: string[];
  /** 애매한 장세 여부 */
  is_ambiguous?: boolean;
  /** Stage 1 비용 완화 적용 여부 */
  stage1_loosened_entry?: boolean;
  /** AI 품질 바닥가 완화 적용 여부 */
  ai_floor_relaxed?: boolean;
  /** 자동 진입(시간/틱 유지) 발생 여부 */
  auto_entry_triggered?: boolean;
  /** 현재 검토 중인 틱 수 */
  reviewing_ticks?: number;
}>;

/** Minimal row shape for funnel math. */
export type DecisionFunnelRow = Readonly<{
  decision: Readonly<{
    signal_state: string;
    regime_state: string;
    edge_state: string;
    risk_state: string;
    execution_state: string;
    final_decision: PaperFinalDecision;
    reject_reason: PaperDecisionRejectReason | null;
  }>;
  aiGatePassed: boolean;
}>;

/** One engine tick funnel (per-symbol rows). */
export type DecisionFunnelTick = Readonly<{
  raw_signal_count: number;
  regime_pass_count: number;
  edge_pass_count: number;
  risk_pass_count: number;
  execution_ready_count: number;
  ai_pass_count: number;
  enter_count: number;
}>;

/** Detailed engine state (written to `reports/engine-state.json`). */
export type PaperEngineState = Readonly<{
  generatedAt: number;
  engine_mode: PaperEngineMode;
  execution_state: PaperExecutionState;
  strategy_executor: PaperStrategyExecutor;
  current_regime: PaperRegimeState;
  adaptiveMode: string;
  engine_status: "RUNNING" | "PAUSED" | "STOPPED";
  risk_state: string;
  active_mode_executor: PaperStrategyExecutor;
  entryAllowed: boolean;
  blockedReasons: string[];
  blocked_reason: string | null;
  expected_move: number | null;
  total_cost: number | null;
  last_mode_change_at: number | null;
  mode_cooldown_status: {
    RANGE: Array<{ key: string; until: number }>;
    TREND: Array<{ symbol: string; until: number }>;
  };
  recent_loss_streak_by_mode: Record<string, number>;
  daily_loss_guard_triggered: boolean;
  risk_detail: Record<string, unknown>;
  decision_funnel_tick: DecisionFunnelTick;
  decision_funnel_50: DecisionFunnelTick;
  decision_funnel_50_size: number;
  reject_reason_counts_tick: Record<string, number>;
  is_ambiguous?: boolean;
  symbol_decisions: Record<string, { decision: PaperSymbolDecisionRecord; adaptiveOk: boolean }>;
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
  /** 실행기(RANGE/TREND/IDLE) — 이벤트/리포트 해석용. 레거시 파일의 NONE은 로드 시 IDLE로 정규화. */
  executorAtEntry?: "RANGE" | "TREND" | "IDLE";
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
  /** 현재 진입 단계 (1=선진입, 2=추가진입, 3=확정진입) */
  entryStage?: number;
  /** 분할 비중 (예: [0.25, 0.35, 0.40]) */
  scalingWeights?: number[];
  /** 현재가 (마지막 폴링 기준) */
  currentPrice?: number;
  /** 1차 목표가 (분할익절) */
  targetPrice1?: number;
  /** 2차 목표가 (분할익절) */
  targetPrice2?: number;
  /** 손절가 (ATR 기반 동적 계산) */
  stopPrice?: number;
  /** 트레일링 스탑 활성화 가격 */
  trailingStopPrice?: number;
  /** 미실현 손익 (USD) */
  unrealizedPnl?: number;
  /** 미실현 수익률 (%) */
  unrealizedPnlPct?: number;
  /** 실현 손익 (USD, 분할익절 시 발생) */
  realizedPnl?: number;
  /** 포지션 상태 (예: "관찰중", "익절완료") */
  positionStatus?: string;
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
