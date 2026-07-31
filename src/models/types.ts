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
  /**
   * RANGE `EXIT_RANGE_REBALANCE` (`range_box_break`): minimum ms from open before a box-break exit may fire.
   * Reduces whipsaw from box recalculation / edge jitter shortly after entry.
   */
  rangeRebalanceMinHoldMs: number;
  /** Paper-only: base position size in USD (anchor when `paperAccountEquityUsd` is unset). Env: `ORBITALPHA_PAPER_BASE_SIZE_USD`. */
  paperBaseSizeUsd: number;
  /**
   * Optional account equity (USD). When set (>0), sizing anchor = `paperAccountEquityUsd * paperEntryNotionalTargetFrac`.
   * Env: `ORBITALPHA_PAPER_ACCOUNT_EQUITY_USD`.
   */
  paperAccountEquityUsd: number | null;
  /**
   * Fraction of equity (or 1.0 when using `paperBaseSizeUsd` only) applied to the sizing anchor. E.g. 0.98 ≈ almost full notional.
   * Env: `ORBITALPHA_PAPER_ENTRY_NOTIONAL_TARGET_FRAC` (default 1).
   */
  paperEntryNotionalTargetFrac: number;
  /**
   * RANGE box-break exit: consecutive close-evaluation ticks with raw price outside box before exiting (>=2).
   * Single-tick spikes or one-off reclassification alone do not clear the bar.
   */
  rangeRebalanceBoxBreakConfirmTicks: number;
  /**
   * Net PnL% on margin (after fees) to enter RANGE profit-trail zone: defer `range_box_break` until pullback trail or disarm.
   */
  rangeRebalanceProfitArmPnlPct: number;
  /**
   * Minimum net PnL USD = margin × this fraction to lock trailing (0 = breakeven net, i.e. pnlUsdNet ≥ 0).
   */
  rangeRebalanceSecuredMinPnlPct: number;
  /** Pullback from peak (fraction of box span) to trigger profit-trail exit when locked. */
  rangeRebalanceTrailPullbackSpanFrac: number;
  /** Minimum pullback as fraction of price (noise floor vs span). */
  rangeRebalanceTrailPullbackMinPriceFrac: number;
  /** ATR multiplier for pullback floor (0 = ignore ATR). */
  rangeRebalanceTrailAtrMult: number;
  /**
   * After profit-arm without lock, max ms to defer box break before releasing (0 = no cap).
   */
  rangeRebalanceTrailMaxArmedNoLockMs: number;
  /** Paper-only: round-trip slippage estimate in bps (1bp = 0.0001). Used by risk fee filter. */
  paperSlippageBps: number;
  /** Paper-only: if today's net PnL <= -limit, block all new entries (<=0 disables). */
  paperDailyLossLimitUsd: number;
  /** Paper-only: last10 net PnL <= -threshold triggers size reduction (<=0 disables). */
  paperLast10NetDegradeThresholdUsd: number;
  /** Paper-only: size multiplier when last10 net is degrading. */
  paperDegradeSizeMultiplier: number;
  /**
   * Consecutive losses (same regime) at/above this → hard regime suspend (`mode_loss_streak_hard_suspended`).
   * Soft-only band is below this and at/above `paperModeLossStreakSoftCount`.
   */
  paperModeLossStreakSuspendCount: number;
  /**
   * Consecutive losses at/above this → soft size reduction only (no hour-long block).
   */
  paperModeLossStreakSoftCount: number;
  /** Paper-only: generic suspend duration ms (legacy caps, crash lock, structural box break upper bound). */
  paperModeSuspendMs: number;
  /**
   * Hard loss-streak suspend duration (ms). Kept shorter than `paperModeSuspendMs` so RANGE/TREND recover faster.
   */
  paperModeHardSuspendMs: number;
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
  /** STAGE1_COST_WARNING weak tail: min shortfall_pct to apply fee-drag size trim. */
  paperFeeDragWeakShortfallPctMin: number;
  /** Weak tail trigger: expected_move_usd / required_cost_usd <= this. */
  paperFeeDragWeakEmRatioMax: number;
  /** Fee-drag tail size multiplier (1 = disabled trim). */
  paperFeeDragTailSizeMult: number;
  /** Extreme tail threshold (em ratio) for stronger size-only trim. */
  paperFeeDragBlockEmRatioMax: number;
  /** Extreme tail minimum shortfall USD for stronger size-only trim. */
  paperFeeDragBlockShortfallUsdMin: number;
  /** Extreme tail minimum shortfall pct for stronger size-only trim. */
  paperFeeDragBlockShortfallPctMin: number;
  /**
   * Paper test: if set (>0), skip dynamic fee/slippage fraction for edge checks and use
   * `required_cost_usd = paperFixedTotalCostUsd * leniency` vs `expected_move_usd = em * paper_sizing_anchor_usd`.
   * Env: `PAPER_FIXED_TOTAL_COST_USD` (e.g. 30).
   */
  paperFixedTotalCostUsd: number | null;
  /**
   * Raw `OKX_DEMO_ENABLED` env (diagnostics). Effective signed REST is `okxDemoEnabled`.
   */
  okxDemoEnvRequested: boolean;
  /**
   * Explicit opt-in `ORBITALPHA_OKX_EXCHANGE_ENABLED` for OKX signed REST (orders/positions/balance).
   * Default false: fills/opens/closes/PnL stay on internal paper paths only; market data stays public OKX.
   */
  okxExchangeAuthOptIn: boolean;
  /**
   * Effective OKX demo adapter: `okxDemoEnvRequested && okxExchangeAuthOptIn`.
   */
  okxDemoEnabled: boolean;
  /** Raw `OKX_LIVE_ENABLED` env (diagnostics). */
  okxLiveEnabled: boolean;
  /** Effective auth mode for signed OKX REST. */
  okxAuthMode: "disabled" | "demo" | "live";
  /** Effective auth readiness for signed OKX REST. */
  okxAuthReady: boolean;
  /** Include `x-simulated-trading: 1` for OKX requests (demo only). */
  okxSimulatedTradingHeaderEnabled: boolean;
  /** Live signed submit guard: max order notional in USDT (null if not explicitly configured). */
  okxLiveMaxOrderNotionalUsdt: number | null;
  /** Live signed submit guard: max add-on order notional in USDT (null if not explicitly configured). */
  okxLiveMaxAddonNotionalUsdt: number | null;
  /** Live signed submit guard: max total symbol notional exposure in USDT (null if not explicitly configured). */
  okxLiveMaxSymbolNotionalUsdt: number | null;
  /** Live signed submit guard: max total account notional exposure in USDT (null if not explicitly configured). */
  okxLiveMaxAccountNotionalUsdt: number | null;
  /** Live signed submit guard: max add-on count per symbol (null if not explicitly configured). */
  okxLiveMaxAddonCount: number | null;
  /** Whether to use static cap or dynamic balance-based cap (default true). */
  okxLiveStaticNotionalCapEnabled: boolean;
  /** Fraction of available balance to use for dynamic capping (default 0.95). */
  okxLiveUsableBalanceRatio: number;
  /** OKX demo REST base URL (default https://www.okx.com). */
  okxDemoBaseUrl: string;
  /** OKX live REST base URL (default https://www.okx.com). */
  okxBaseUrl: string;
  /** OKX live API key. */
  okxApiKey: string;
  /** OKX live API secret. */
  okxApiSecret: string;
  /** OKX live passphrase. */
  okxPassphrase: string;
  /** OKX demo API key. */
  okxDemoApiKey: string;
  /** OKX demo API secret. */
  okxDemoApiSecret: string;
  /** OKX demo passphrase. */
  okxDemoPassphrase: string;
}>;


/** Standard paper entry decision reject codes (see `evaluatePaperSymbolEntry`). */
export type PaperDecisionRejectReason =
  | "DATA_NOT_READY"
  | "SIGNAL_NONE"
  | "RANGE_DIRECTIONAL_SHOCK_CONFLICT_WAIT_PULLBACK"
  | "REGIME_NO_TRADE"
  | "REGIME_UNKNOWN"
  | "AMBIGUOUS_WATCHING"
  | "AMBIGUOUS_TREND_REVIEW"
  | "AMBIGUOUS_RANGE_REVIEW"
  | "HIGHWAY_BOX_EDGE_WATCH"
  | "HIGHWAY_CANDLE_WARMUP_WATCH"
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
  | "AUTHORITY_EXPECTANCY_SOFT_PASS"
  | "AUTHORITY_ADAPTIVE_SOFT_PASS"
  | "ADAPTIVE_POLICY_BLOCK"
  | "SIZE_FLOOR_BLOCK"
  | "ORDER_BUILD_FAIL"
  | "EXECUTOR_INIT_FAIL"
  | "EXECUTION_DISABLED"
  /** RANGE·Stage1·SHORT 후보: Long Only로 숏 미체결·보류(SKIP), EXECUTION_DISABLED 미사용 */
  | "LONG_ONLY_SHORT_DEFERRED"
  | "AI_DIRECTION_MISMATCH"
  | "STAGE1_BLOCKED_LIMIT"
  | "LEGACY_BLOCKED"
  /** RANGE 상단 숏: 완성봉 2개 반전 미충족 */
  | "RANGE_UPPER_SHORT_NO_REVERSAL_CONFIRMATION"
  /** RANGE 하단 롱: 완성봉 2개 반전 미충족 */
  | "RANGE_LOWER_LONG_NO_REVERSAL_CONFIRMATION"
  /** RANGE 엣지 stop_loss 직후 동일 맥락 재진입 차단 */
  | "RANGE_STOP_REENTRY_SAME_CONTEXT_BLOCKED"
  /** Stage1 symbol-level mutex: opposite side position exists */
  | "SYMBOL_OPPOSITE_POSITION_OPEN"
  | "SYMBOL_SAME_SIDE_POSITION_ALREADY_OPEN"
  | "PENDING_EXCHANGE_CONFIRM_LOCK"
  | "EXTERNAL_MANUAL_POSITION_BLOCK"
  | "POSITION_PROTECTION_FAILED_BLOCK"
  | "MANUAL_CLOSE_COOLDOWN_ACTIVE";

export type PaperStage1ResultCode =
  | "STAGE1_ENTERED"
  | "STAGE1_EXEC_PENDING"
  | "STAGE1_COST_WARNING"
  | "STAGE1_SOFT_FILTERED"
  | "STAGE1_PENDING_RECHECK"
  | "STAGE1_BLOCKED_LIMIT"
  | "STAGE1_BLOCKED_EDGE"
  | "STAGE1_BLOCKED_RISK"
  | "STAGE1_BLOCKED_QUALITY"
  | "STAGE1_BLOCKED_REGIME"
  | "STAGE1_BLOCKED_SIGNAL"
  | "STAGE1_BLOCKED_DATA"
  | "STAGE1_LONG_ONLY_SHORT_DEFERRED"
  | "STAGE1_SOFT_EXPECTANCY_PASS"
  | "STAGE1_SOFT_ADAPTIVE_PASS"
  | "STAGE1_UNKNOWN_REGIME_RANGE_FALLBACK";

export type PaperSignalState = "NONE" | "LONG_CANDIDATE" | "SHORT_CANDIDATE";
export type PaperRegimeState = "TREND" | "RANGE" | "NO_TRADE" | "UNKNOWN" | "SHOCK_UP" | "SHOCK_DOWN" | "TREND_UP" | "TREND_DOWN" | "DOWN_SHOCK_CONSOLIDATION";
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
  | "HIGHWAY_BOX_EDGE_WATCH"
  | "HIGHWAY_CANDLE_WARMUP_WATCH"
  | "DISABLED"
  | "INIT_FAIL"
  | "ORDER_BUILD_FAIL";
export enum HighwayTrendState {
  VALID = "VALID",
  WEAK = "WEAK",
  INVALID = "INVALID"
}

export interface AiHighwayQualityScores {
  alignmentQualityScore: number;
  emaSpacingHealthScore: number;
  pullbackQualityScore: number;
  reboundStrengthScore: number;
  volumeSupportScore: number;
  trendExhaustionScore: number;
  highwayValidityScore: number;
  entryRiskScore: number;
  deferEntry?: boolean;
}

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
  /** Stage 1 통합 결과 코드 (Round 7 도입) */
  stage1_result_code?: PaperStage1ResultCode;
  /** 최종 실패 사유 (추적용) */
  final_fail_reason?: string;
  /** 로그용 직접 차단 코드 */
  entry_blocked?: string | null;
  /** RANGE stage0 전용 엔진 분기 탑승 여부 */
  range_stage0_engine_taken?: boolean;
  /** RANGE stage0 전용 엔진 종료 사유 */
  range_stage0_exit_reason?: string | null;
  /** legacy executor 차단 분기 탑승 여부 */
  legacy_executor_path_taken?: boolean;
  /** 요구 이동폭 (비용 포함) % */
  required_move_pct?: number | null;
  /** 부족분 (요구 - 기대) % */
  shortfall_pct?: number | null;
  /** 진단: 신호가 발생하지 않은 구체적인 이유 (BTC 등) */
  signal_missing_reason?: string;
  /** 진단: 박스 내 위치 (0~1) */
  box_position_diag?: number | null;
  /** 진단: EMA 이격도 (ema20-ema60)/ema60 */
  ema_gap_diag?: number | null;
  /** 진단: 변동성/거래량 프록시 */
  volatility_proxy_diag?: number | null;
  /** 하이웨이: 횡보 확신도 (0~1) */
  range_confidence_diag?: number | null;
  /** 하이웨이: 박스 응집도 (0~1) */
  box_cohesion_diag?: number | null;
  /** 하이웨이: 돌파 실패율 (0~1) */
  breakout_failure_rate_diag?: number | null;
  /** 하이웨이: 왕복 빈도 점수 */
  range_oscillation_diag?: number | null;
  /** 하이웨이: 추세 약성 점수 */
  trend_weakness_diag?: number | null;
  /** 하이웨이: 횡보 판단 근거 라벨 */
  range_reason_label?: string | null;
  /** 하이웨이: 박스 왕복 누적 횟수 */
  range_cycle_count?: number | null;
  /** 하이웨이: 박스 내 분할 진입 단계 */
  range_ladder_level?: number | null;
  /** 하이웨이: RANGE 해제 위험도 (0~1) */
  regime_exit_risk?: number | null;
  /** 하이웨이: 박스 붕괴 방향 (upper / lower / none) */
  box_break_side?: "upper" | "lower" | "none";
  /** 하이웨이: 현재 레짐 상태 (RANGE / TREND / UNKNOWN) */
  regime_state_diag?: PaperRegimeState;
  /** 하이웨이: 진입 의도 유형 (probe / standard / scale) */
  entry_intent_type?: "probe" | "standard" | "scale" | "trend";
  /** 하이웨이: 진입 확인 상태 (unconfirmed / reacting / confirmed) */
  entry_confirmation_state?: "unconfirmed" | "reacting" | "confirmed";
  /** 하이웨이: 규모 확대 허용 여부 */
  scaling_permission?: boolean;
  /** 하이웨이: 초소형 탐색 전용 모드 강제 여부 */
  probe_only_mode?: boolean;
  /** Stage 1 완화(Leniency) 적용 여부 */
  stage1_leniency_applied?: boolean;
  /** Stage 1에서 기대이동 < 완화비용이어도 탐색 진입 허용(경고) */
  cost_warning_applied?: boolean;
  /** 비용 경고로 Stage 1 사이즈 축소 적용 */
  stage1_size_reduced_due_to_cost?: boolean;
  /** 진입 후 비용 가드(증액 제한·청산 보수화) 활성 */
  post_entry_cost_guard?: boolean;
  /** 고정 비용 테스트 모드일 때 설정값(예: 30), 아니면 null */
  fixed_total_cost_usd?: number | null;
  /** 기대 이동을 USD로 환산(em × 기준 노셔널, 기본 100) */
  expected_move_usd?: number | null;
  /** 요구 비용 USD(고정 모드: 고정값×완화, 동적 모드: 분수×노셔널) */
  required_cost_usd?: number | null;
  /** USD 기준 부족분 */
  shortfall_usd?: number;
  /** Stage 1 소프트 허용 전 실행기 차단 코드(원본). */
  executor_block_reason_original?: string | null;
  /** Stage 1에서 실행기 소프트 오버라이드로 진입 허용으로 전환했는지 */
  stage1_soft_exec_override?: boolean;
  /** Stage 1 신호 완화 적용 여부 (BTC 등) */
  stage1_signal_relaxed?: boolean;
  /** 신호 완화 구체적 사유 */
  signal_relax_reason?: string | null;
  /** Stage 1 Soft Candidate Micro-Entry 적용 여부 */
  stage1_soft_candidate_enter_applied?: boolean;
  /** Micro-Entry 원본 차단 사유 (보통 no_signal) */
  stage1_soft_candidate_original_block_reason?: string | null;
  /** Micro-Entry 추가 배수 (기본 0.4) */
  stage1_soft_candidate_size_mult?: number | null;
  /** RANGE·Stage0 재진입 쿨다운 완화 적용 여부(RISK_FAIL_REENTRY 경로) */
  reentry_cooldown_applied?: boolean;
  /** 재진입 대기 원래 밀리초(동일 방향 배수 반영 후) */
  reentry_cooldown_original_ms?: number | null;
  /** 실제 비교에 쓴 밀리초(완화 시 축소) */
  reentry_cooldown_effective_ms?: number | null;
  /** 완화/비완화 사유 코드 */
  reentry_cooldown_reason?: string | null;
  /** RISK_COOLDOWN 세부 사유 코드 */
  risk_cooldown_subreason?: string | null;
  /** 현재 쿨다운 잔여 시간(ms) */
  cooldown_remaining_ms?: number | null;
  /** 동일 방향 재진입 배수가 적용됐는지 */
  same_dir_cooldown_applied?: boolean;
  /** blockedRegimes에서 내려온 원본 사유 */
  blocked_regime_reason?: string | null;
  /** 재진입 대기 기준값(ms) */
  reentry_wait_ms?: number | null;
  /** 마지막 청산 후 경과(ms) */
  reentry_elapsed_ms?: number | null;
  /** RANGE stage0에서 long-only short deferred가 실제 적용됐는지 */
  range_long_only_short_deferred_applied?: boolean;
  /** RANGE stage0에서 long-only short deferred를 우회했는지 */
  range_long_only_short_deferred_bypassed?: boolean;
  /** RANGE stage0 전용 비용 경고 적용 여부 */
  range_cost_warning_applied?: boolean;
  /** RANGE stage0 전용 비용 경고 기준치 */
  range_cost_warning_threshold?: number | null;
  /** RANGE stage0 전용 비용 경고 부족분(기준치-기대이동) */
  range_cost_warning_shortfall?: number | null;
  /** RANGE stage0 전용 재진입 쿨다운 적용 여부 */
  range_reentry_cooldown_applied?: boolean;
  /** RANGE stage0 전용 재진입 대기 기준값(ms) */
  range_reentry_wait_ms?: number | null;
  /** RANGE stage0 전용 마지막 청산 후 경과(ms) */
  range_reentry_elapsed_ms?: number | null;
  /** RANGE stage0 전용 재진입 잔여(ms) */
  range_reentry_remaining_ms?: number | null;
  /** RANGE stage0 전용 재진입 판정 소스 */
  range_reentry_source?: string | null;
  /** RANGE stage0 전용 동일 방향 여부 */
  range_reentry_same_direction?: boolean;
  /** RANGE 동일방향 재진입 감속 완화 적용 여부 */
  range_same_direction_reentry_relaxed_applied?: boolean;
  /** RANGE 동일방향 재진입 완화 대기(ms) */
  range_same_direction_reentry_wait_ms?: number | null;
  /** RANGE 동일방향 재진입 완화 사이즈 배수 */
  range_same_direction_reentry_size_mult?: number | null;
  /** RANGE 동일방향 재진입 에지 적합 여부 */
  range_same_direction_reentry_edge_ok?: boolean;
  /** RANGE 동일방향 재진입 중앙부 대기 차단 여부 */
  range_same_direction_reentry_center_blocked?: boolean;
  /** RANGE 동일방향 재진입 최종 허용 여부 */
  range_same_direction_reentry_final_allowed?: boolean;
  /** RANGE 리스크 제한 한시 완화 적용 여부 */
  range_risk_limit_temporarily_relaxed?: boolean;
  /** RANGE 리스크 제한 한시 완화 사유 */
  range_risk_limit_relax_reason?: string | null;
  /** RANGE 리스크 제한 한시 완화 시작 시각(epoch ms) */
  range_risk_limit_relax_started_at?: number | null;
  /** RANGE 리스크 제한 한시 완화 만료 시각(epoch ms) */
  range_risk_limit_relax_expires_at?: number | null;
  /** RANGE 리스크 제한 한시 완화 활성 여부 */
  range_risk_limit_relax_active?: boolean;
  /** RANGE 리스크 제한 한시 완화 만료 여부 */
  range_risk_limit_relax_expired?: boolean;
  /** RANGE stage0 loss streak suspend 소프트 완화 적용 여부 */
  range_soft_suspend_applied?: boolean;
  /** RANGE stage0 loss streak suspend 시 축소 진입 배수 */
  range_soft_suspend_size_mult?: number | null;
  /** RANGE stage0 loss streak suspend 완화 쿨다운(ms) */
  range_soft_suspend_cooldown_ms?: number | null;
  /** RANGE stage0 loss streak suspend 동일 방향 제한 적용 여부 */
  range_soft_suspend_same_direction_restricted?: boolean;
  /** RANGE 엔진에서 양방향 허용 로직 적용 여부 */
  range_bidirectional_applied?: boolean;
  /** RANGE 숏 허용 판정 결과 */
  range_short_allowed?: boolean;
  /** RANGE 숏 허용/대기 판정 사유 */
  range_short_allowed_reason?: string | null;
  /** RANGE 상단 근접 판정 */
  range_upper_edge_near?: boolean;
  /** RANGE 중앙 대기 판정 */
  range_center_wait?: boolean;
  /** RANGE 최종 선택 방향 */
  range_final_selected_side?: "long" | "short" | "none" | null;
  /** RANGE 반전 구간 라벨 */
  range_reversal_zone?: "upper" | "lower" | "mid" | null;
  /** RANGE 구간별 체결·게이트 정책 버전 문자열 */
  range_zone_action_policy?: string | null;
  /** RANGE 정책 기준 감지 구간 */
  range_zone_detected?: "upper" | "lower" | "mid" | null;
  /** 상단 구간에서 숏 우선 정책 적용 */
  range_upper_short_priority_applied?: boolean;
  /** 하단 구간에서 롱 우선 정책 적용 */
  range_lower_long_priority_applied?: boolean;
  /** 중단 구간 대기(비진입) 우선 적용 */
  range_mid_wait_applied?: boolean;
  /** 구간·방향 라벨 기준 최종 의도 side */
  range_final_trade_side_by_zone?: string | null;
  /** RANGE stage0 상단·raw long 등 분기 증명(로그/트레이스용) */
  range_stage0_branch_proof?: Record<string, unknown> | null;
  /** 반전 청산 직후(또는 pending) 반대 방향 즉시 평가 적용 */
  range_reversal_immediate_switch_applied?: boolean;
  range_reversal_immediate_switch_reason?: string | null;
  /** 포지션 없는 상태에서 핵심 extreme 구조가 확인되어 fresh re-entry 허용됨 */
  range_fresh_reentry_allowed?: boolean;
  /** fresh re-entry가 허용되지 않은 경우 차단 이유 */
  range_fresh_reentry_blocked_reason?: string | null;
  /** fresh re-entry 허용 시 적용된 축소 진입 배수 */
  range_fresh_reentry_size_mult?: number | null;
  /** 포지션 없음 조건에서 same-direction reentry wait 우회 여부 */
  range_reentry_wait_bypassed_no_open_position?: boolean;
  /** loss streak suspend를 완전 차단 대신 축소 진입으로 완화 적용 */
  range_loss_streak_reduced_entry_applied?: boolean;
  /** loss streak 완화 진입 시 적용된 축소 배수 */
  range_loss_streak_reduced_entry_size_mult?: number | null;
  /** RANGE 상단 반전 숏 평가 시작 여부 */
  range_reversal_short_eval_started?: boolean;
  /** RANGE 상단에서 기존 롱 정리 트리거 여부 */
  range_reversal_long_exit_triggered?: boolean;
  /** RANGE 상단 반전 숏 진입 허용 여부 */
  range_reversal_short_entry_allowed?: boolean;
  /** RANGE 상단 반전 숏 진입 차단 사유 */
  range_reversal_short_entry_block_reason?: string | null;
  /** 레거시 차단 원인 (executor blocked_reason 원본) */
  legacy_block_reason?: string | null;
  /** 레거시 레짐 게이트 분류값 */
  legacy_regime_gate?: string | null;
  /** 레거시 게이트 발생 소스 */
  legacy_gate_source?: string | null;
  /** 신규 판단 결과가 레거시 게이트로 덮였는지 */
  override_by_legacy?: boolean;
  /** Stage1 차단 기원 레이어 */
  stage1_block_origin?: string | null;
  /** 테스트: 레거시 차단 우회 적용 여부 */
  legacy_block_test_bypass_applied?: boolean;
  /** 테스트: 레거시 차단 우회 사유 */
  legacy_block_test_bypass_reason?: string | null;
  /** 테스트: 우회 전 원본 차단 사유 */
  legacy_block_original_reason?: string | null;
  /** Stage 1 RANGE 방향 보정 적용 여부 */
  stage1_direction_override_applied?: boolean;
  /** 방향 보정 상세 사유 */
  stage1_direction_override_reason?: string | null;
  /** 원래 정책 방향 (none 등) */
  original_policy_direction?: string | null;
  /** 최종 결정 방향 (long/short) */
  final_policy_direction?: string | null;
  /** Stage 1 RANGE 비용 부족 완화(Bypass) 적용 여부 */
  stage1_cost_soft_bypass_applied?: boolean;
  /** 비용 완화 상세 사유 */
  stage1_cost_soft_bypass_reason?: string | null;
  /** 완화 시점의 부족분 % */
  stage1_cost_shortfall_pct?: number | null;
  /** 완화 시점의 부족분 USD */
  stage1_cost_shortfall_usd?: number | null;
  /** 비용 완화로 인한 추가 사이즈 축소 배수 (예: 0.5) */
  stage1_cost_micro_size_mult?: number | null;
  /** Fee-drag tail filter evaluated (Stage1 cost warning tail). */
  fee_drag_filter_applied?: boolean;
  /** Additional size reduction from fee-drag tail. */
  fee_drag_size_reduced?: boolean;
  /** Reserved compatibility field: fee-drag pre-executor hard block is disabled. */
  fee_drag_blocked?: boolean;
  fee_drag_reason?: string | null;
  fee_drag_proof?: Record<string, unknown> | null;
  /** 판단 시점 진입 단계(엔진 currentStage) */
  currentStage?: number;
  /** 판단 시점 레짐 */
  regime?: "TREND" | "RANGE" | "NO_TRADE";
  /** Stage 1 최종 사이즈 배수(리스크·탐색·RANGE 완화 누적 후, adaptive 직전) */
  stage1_size_multiplier_final?: number | null;
  /** 적응형 진입(페이퍼) 주문 구성 결과 — 거래소 호가·계약 스펙 없음 */
  order_build_ok?: boolean;
  order_build_fail_reason?: string | null;
  order_build_fail_stage?: "entry_policy" | "adaptive_sizing" | null;
  /** 페이퍼는 계약 수량 미산출 시 null */
  qty?: number | null;
  price?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  riskReward?: number | null;
  tick_size?: number | null;
  qty_step?: number | null;
  min_qty?: number | null;
  min_notional?: number | null;
  /** 주문 생성 단계에서의 목표 명목(USD), 실패 시 null */
  sizeUsd?: number | null;
  /** Long Only로 RANGE·Stage1 SHORT 후보가 보류된 경우 */
  long_only_restriction?: boolean;
  /** 스냅샷 신호 상태(예: SHORT_CANDIDATE) */
  original_signal_state?: string;
  /** 정책 적용 후 표시용 신호 상태 */
  final_signal_state?: string;
  /** 숏 실행 불가 사유(구조화·EXECUTION_DISABLED 외 서술) */
  execution_disabled_reason?: string | null;
  /** EXECUTION_DISABLED 시 어떤 가드가 막았는지(진단·모니터링) */
  execution_disabled_top_proof?: Record<string, unknown> | null;
  /** TREND adaptive 볼륨 하한 완화 적용/미적용 진단(proof_version≥2) */
  trend_volume_relax_proof?: Record<string, unknown> | null;
  /** 진단: UNKNOWN 레짐에서의 FALLBACK 관측용 */
  regime_original_state?: PaperRegimeState;
  regime_fallback_applied?: boolean;
  regime_fallback_reason?: string | null;
  /** RANGE executor priority applied (fallback path path) */
  range_executor_priority_applied?: boolean;
  /** GAP: RANGE priority fallback reason */
  range_executor_priority_reason?: string | null;
  /** GAP: Original executor before priority shift */
  final_executor_before_priority?: PaperStrategyExecutor | null;
  /** GAP: Final executor after priority shift */
  final_executor_after_priority?: PaperStrategyExecutor | null;
  /** GAP: Original reject reason before priority shift */
  final_reject_before_priority?: string | null;
  /** GAP: Final reject reason after priority shift */
  final_reject_after_priority?: string | null;
  /** V2 Authority decision fields (diagnostics) */
  authority_decision?: string | null;
  authority_source?: string | null;
  authority_side?: string | null;
  authority_size_usd?: number | null;
  /** Accountability: Who definitively blocked this entry? (v1_executor, adaptive_policy, execution_guard, etc) */
  final_block_owner?: string | null;
  /** Diagnostics: adaptive engine fail metadata */
  adaptive_fail_stage?: string | null;
  adaptive_fail_reason?: string | null;

  // =========================================================================
  // [DIAG-V1] 진입 차단 원인 진단 필드 — 진입 기준·주문 로직 변경 없음
  // NO_TRADE_SIGNAL / V7 6개 조건 재확인 대기 연결용
  // =========================================================================
  /** 롱 후보(RANGE_LONG_CANDIDATE 또는 paper_long_candidate)가 생성됐는지 */
  diag_long_candidate_created?: boolean | null;
  /** 숏 후보(RANGE_SHORT_CANDIDATE 또는 paper_short_candidate)가 생성됐는지 */
  diag_short_candidate_created?: boolean | null;
  /** 롱 후보가 제거된 레이어별 사유 목록 */
  diag_long_rejected_reasons?: string[] | null;
  /** 숏 후보가 제거된 레이어별 사유 목록 */
  diag_short_rejected_reasons?: string[] | null;
  /** BTC 5m EMA 편향 ("up" | "down" | "flat") */
  diag_btc_bias?: "up" | "down" | "flat" | null;
  /** 대시보드 표시 기준 우선 방향 ("long" | "short" | "none") */
  diag_preferred_direction?: "long" | "short" | "none" | null;
  /** RANGE 복합 신호 점수 (conf×0.3 + cohesion×0.2 + breakoutFail×0.2 + oscillation×0.2 + edgeProximity×0.1) */
  diag_range_signal_score?: number | null;
  /** 횡보 확신도 (0~1) */
  diag_range_confidence?: number | null;
  /** 박스 응집도 (0~1) */
  diag_box_cohesion01?: number | null;
  /** 왕복 빈도 점수 (0~1) */
  diag_range_oscillation_score?: number | null;
  /** 박스 내 위치 (0=하단, 1=상단) */
  diag_box_position?: number | null;
  /** 돌파 실패율 (0~1) */
  diag_breakout_failure_rate?: number | null;
  /** 레짐 이탈 위험도 (0~1) */
  diag_regime_exit_risk?: number | null;
  /** 1m 봉 반전 확인 여부 (upper→숏: close<prev.close && high<=prev.high) */
  diag_reversal_confirmed?: boolean | null;
  /** Tier-0 방향성 가드(directionalTrendEntryGuard) 차단 여부 */
  diag_directional_guard_blocked?: boolean | null;
  /** 리스크 엔진(crash/pump/daily loss/longAllow/shortAllow) 차단 여부 */
  diag_risk_blocked?: boolean | null;
  /** 최종 차단이 발생한 레이어 이름 */
  diag_final_block_layer?: string | null;
  /** 최종 차단 사유 (gateResult 또는 reject_reason 원문) */
  diag_final_block_reason?: string | null;
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
  /** 직전 틱에서 발생한 ORDER_BUILD_FAIL 요약(관측용) */
  last_order_build_failure?: Record<string, unknown> | null;
  /** 직전 틱 LONG_ONLY_SHORT_DEFERRED 요약(관측용) */
  last_long_only_restriction?: Record<string, unknown> | null;
  /** 직전 틱 Market Mode Selector 출력 */
  market_mode_selector?: MarketModeSelectorOutput;
  /** 직전 틱 Risk & Exposure 출력 */
  risk_exposure?: RiskExposureOutput;
  /** 직전 틱 설명 레이어 */
  explanation?: PaperExplanationFields;
  last_exit_reason?: string;
  last_switch_reason?: string;
  exchange: "okx";
  okx_demo_enabled: boolean;
  okx_demo_keys_loaded: boolean;
  okx_signed_rest_ready: boolean;
  okx_account_config_ok: boolean;
  okx_balance_ok: boolean;
  okx_positions_ok: boolean;
  okx_order_submit_ok: boolean;
  paper_execution_ready?: boolean;
  signed_execution_ready?: boolean;
  signed_submit_mode?: "enabled" | "skipped_not_ready" | "paper_only";
  signed_submit_block_reason?: string | null;
}>;

/** One leg in `positions/open.json` (JSON array of up to `paperMaxOpenPositions` records). */
export type PaperOpenPositionRecord = {
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
  /** Lifecycle status for exchange confirmation hardening and engine state. */
  lifecycleState?: 
    | "INITIAL" 
    | "PENDING_EXCHANGE_CONFIRM" 
    | "OPEN" 
    | "CLOSE_PENDING" 
    | "PARTIAL_PENDING"
    | "ADDON_ACTIVE" 
    | "PARTIAL_ACTIVE" 
    | "CLOSE_ONLY_MANAGED"
    | "EXTERNAL_MANUAL_POSITION"
    | "UNTRACKED_AUTO_ORIGIN"
    | "OKX_UNTRACKED_FILL"
    | "OPERATOR_MANAGED"
    | "FAILED";
  exchangeOrdId?: string;
  exchangeClOrdId?: string;
  exchangeFilledSize?: number;
  
  // --- RANGE Box & Exit Plan (V2 Hardening) ---
  rangeBoxHighAtEntry?: number;
  rangeBoxLowAtEntry?: number;
  rangeBoxMidAtEntry?: number;
  rangeBoxQuality?: number;
  rangeBoxSlope?: number;
  rangeBoxDistorted?: boolean;
  takeProfitPlan?: any;
  takeProfit1Px?: number;
  takeProfit2Px?: number;
  partialExitRatio?: number;
  invalidationPx?: number;
  /** Persistence for V2 Range TP */
  v2RangeTp1Triggered?: boolean;
  v2RangeTp2Triggered?: boolean;

  /** V2 probe 진입 사유 (EARLY_REVERSAL_SHORT_PROBE 등) - exit/partial 단계에서 읽음. */
  v2EntryReason?: string;
  /** Probe TP1 주문 제출 완료 여부 (요청 ≠ 체결 분리). */
  probeTP1Submitted?: boolean;
  /** Probe TP1 체결 완료 여부. */
  probeTP1Filled?: boolean;
  /** Probe TP1 체결 평균 가격. */
  probeTP1AvgFillPrice?: number;
  /** Probe TP1 체결 수량. */
  probeTP1FilledQty?: number;
  /** Probe TP1 체결 후 남은 수량. */
  probeRemainingQty?: number;
  /** Probe 진입 bar 기준 시각 (ms) - 5분봉 time stop 계산용. */
  probeEntryBarTime?: number;
  /** Probe 5분봉 홀드 카운트 (마지막 확인 시점). */
  probeHeld5mBars?: number;

  
  
  // Close Pending Tracking
  closePendingOrdId?: string;
  closePendingClOrdId?: string;
  closePendingAt?: number;
  closePendingReason?: string;
  closePendingPrice?: number;
  closePendingFundingRate?: number;
  closePendingFilledSize?: number;
  closePendingRemainingSize?: number;
  closePendingProcessedFillSz?: number;

  // Protective Stop Order Tracking
  protectiveStopAlgoId?: string;
  protectiveSlAlgoId?: string;
  protectiveTpAlgoId?: string;
  isProtectiveStopRegistered?: boolean;
  /** New field for granular TP tracking */
  isTakeProfitRegistered?: boolean;
  /** Whether OKX protective order registration failed and requires repair. */
  isProtectionFailed?: boolean;
  /** Whether the position was opened by V2 authority. Used for unit scaling logic. */
  isV2Authority?: boolean;
  addonCount?: number;

  // Partial Pending Tracking
  partialPendingOrdId?: string;
  partialPendingClOrdId?: string;
  partialPendingSizeUsd?: number;
  partialPendingOriginalSizeUsd?: number;
  partialPendingProcessedFillSz?: number;
  partialPendingProcessedUsd?: number;
  partialPendingAt?: number;
  partialPendingReduceRatio?: number;
  partialPendingReason?: string;
  partialPendingPrice?: number;
  partialPendingFundingRate?: number;

  lastCheckedAt?: number;
  reconcileState?: "PENDING" | "MATCHED" | "FAILED" | "ADOPTED" | "RECONCILE_MISMATCH";
  /** 진입 직후 보호구간 종료 시각(ms) */
  entryProtectionUntil?: number;
  /** 최초 진입 마진(USD). 미설정 시 `sizeUsd`만 사용(레거시). */
  initialSizeUsd?: number;
  /** 진입 후 관측한 최고 순이익률(순손익/마진). 분할·트레일 참고. */
  highestPnlPctNet?: number;
  /** 진입 후 관측한 최고 미실현 수익률(%). V2 Profit Protection용. */
  peakUnrealizedPnlPct?: number;
  peakPnlUpdatedAt?: number;
  breakevenStopRequired?: boolean;
  breakevenStopPrice?: number;
  breakevenStopConfirmed?: boolean;
  breakevenStopConfirmedAt?: number;
  breakevenStopAlgoId?: string;
  breakevenStopConfirmSource?: "okx_pending_algo" | "ledger" | "none";
  addonBlockedReason?: string;
  addonRebuildRequired?: boolean;
  addonRebuildPendingConfirmation?: boolean;
  addonRebuildMetrics?: {
    oldSize?: number;
    newSize?: number;
    oldAvgEntry?: number;
    newAvgEntry?: number;
    rebuildStartedAt?: number;
    fillConfirmed?: boolean;
  };
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
  /** Stage 1이 비용 경고 하에 열렸으면 증액(스케일인) 제한·청산 보수화 */
  postEntryCostGuard?: boolean;
  /** RANGE 진입 시 박스 내 상대 위치 (분석·최근 체결 분포용) */
  rangeEntryBoxPos?: number;
  /** RANGE 진입 시 구간(상단/중단/하단) */
  rangeEntryZone?: "upper" | "lower" | "mid";
  /** 구간 반전 청산 직후 합성 후보로 연결된 진입 */
  rangeEntryFromReversalSwitch?: boolean;
  /** RANGE 포지션 운용 상태(INIT → REATTACK_READY → REATTACK_USED → PROFIT_LOCKED) */
  rangeManagementState?: "INIT" | "REATTACK_READY" | "REATTACK_USED" | "PROFIT_LOCKED";
  /** RANGE 동일 extreme 재접근 add-on 1회 사용 여부 */
  rangeAddOnUsed?: boolean;
  /** RANGE first profit lock(미세 수익 잠금) 성공 여부 */
  rangeFirstProfitLocked?: boolean;
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
  /** 신호 불일치 연속 틱 수 (candidate_lost 완화·연속 확인용). */
  candidateLostStreak?: number;
  /**
   * 마지막 부분청산(TP_PARTIAL / PARTIAL_SPLIT) 발생 시각(ms).
   * POST_PARTIAL_REGIME_PROTECT_MS 보호 윈도우 계산에 사용.
   * undefined = 부분청산 없음.
   */
  lastPartialAt?: number;
  /** 진입 시점 실행 권한 소스 스냅샷(종료 history alias `authority` 우선값). */
  authoritySourceAtEntry?: string;
  /** 진입 시점 권한 방향 스냅샷(종료 history alias `authoritySide` 우선값). */
  authoritySideAtEntry?: string;
  /** 레거시 단일 authority 문자열(디스크·구버전; alias 해석 시 fallback). */
  authority?: string;
  /** 레거시 authority 방향. */
  authoritySide?: string;

  /** REGIME_EXIT 2단계 구조: 후보 상태 여부 */
  regime_exit_candidate?: boolean;
  /** REGIME_EXIT 2단계 구조: 확정 여부 */
  regime_exit_confirmed?: boolean;
  /** REGIME_EXIT 2단계 구조: 후보 상태 연속 틱 수 */
  regime_exit_confirmation_ticks?: number;
  /** REGIME_EXIT 발동 주체 (e.g. "TREND_EXECUTOR", "RANGE_EXECUTOR") */
  regime_exit_trigger_owner?: string;
  /** REGIME_EXIT 발생 시 기존 진입 논리 무효화 사유 */
  invalidation_reason?: string;
  /** REGIME_EXIT 후보 연속성 검증을 위한 최근 평가 시각 */
  regime_exit_last_eval_ms?: number;
  /** Adoption metadata */
  adoptedAt?: number;
  adoptedMetadataSyncedAt?: number;
  detectedAt?: number;
  sync_status?: string;
  marginMode?: string;
  notional?: number;
  pos: number;
  instId?: string;

  /** OKX reporting fields (reconcile metadata) */
  okxContracts?: number;
  baseQty?: number;
  notionalUsd?: number;
  avgPx?: number;

  /** Entry-time evidence snapshot for entry/exit consistency checks. */
  entryEvidence?: Readonly<{
    capturedAt: number;
    regime_at_entry: "RANGE" | "TREND" | "NO_TRADE";
    active_engine_at_entry: "RANGE" | "TREND" | "IDLE";
    entry_signal: string;
    entry_quality_grade: string | null;
    entry_quality_score: number | null;
    side: "long" | "short";
    boxPos: number | null;
    rangeConfidence: number | null;
    emaGap: number | null;
    trendWeaknessScore: number | null;
    candidateStrength: string | null;
    authority_source: string | null;
    adopted_engine: string | null;
    entry_evidence_score: number;
    entry_evidence_reason: string;
  }>;

  // --- OKX Actual Hydration (Manual Size Change Tracking) ---
  /** OKX 실제 계약 수 (lot 정규화 완료) */
  actualContracts?: number;
  /** OKX 실제 노셔널 (USD) */
  actualNotionalUsd?: number;
  /** OKX 실제 마진 (USD) */
  actualMarginUsd?: number;
  /** OKX 실제 수량 (Signed) */
  actualPos?: number;
  /** OKX 실제 평단가 */
  actualAvgPx?: number;
  /** OKX 실제 미실현 손익 */
  actualUnrealizedPnl?: number;
  /** OKX 실제 미실현 수익률 */
  actualUnrealizedPnlPct?: number;
  /** 최초 진입 대비 잔여 수량 비율 (0~1) */
  remainingSizeRatio?: number;
};

/** 종료 레코드·이벤트에 함께 쓰는 종료 유형 코드(레저·로그 공통). */
export type PaperExitType =
  | "EXIT_SL"
  | "EXIT_TP"
  | "EXIT_TP_1"
  | "EXIT_TP_2"
  /** 분할 청산 레그(손익 무관 코드) — 손실·보합 시 TP 라벨과 분리 */
  | "EXIT_PARTIAL_SPLIT_1"
  | "EXIT_PARTIAL_SPLIT_2"
  | "EXIT_PARTIAL_TP"
  | "EXIT_TRAILING"
  | "EXIT_TIME_STOP"
  | "EXIT_TREND_BREAK"
  | "EXIT_REGIME"
  | "EXIT_REGIME_BREAK"
  | "EXIT_SIGNAL_LOST"
  | "EXIT_RANGE_REBALANCE"
  | "EXIT_TREND_SWITCH"
  | "EXIT_RISK"
  | "EXIT_LONG_CRASH_FORCE"
  | "EXIT_LONG_CRASH_REDUCE"
  | "EXIT_SHORT_MOMENTUM_TRAIL"
  | "EXIT_CRASH_FORCE"
  | "EXIT_CRASH_REDUCE"
  | "EXIT_V2_AUTHORITY"
  | "EXIT_UNKNOWN";

/** 종료 저장·API용 카테고리(SL/TP/…). */
export type PaperCloseSource =
  | "SL"
  | "TP"
  | "TP_PARTIAL"
  /** partial_exit 레그 중 실현손익이 익절 조건을 만족하지 않을 때 */
  | "PARTIAL_SPLIT"
  | "TRAIL"
  | "TIME"
  | "REGIME_EXIT"
  | "TREND_BREAK"
  | "STRUCTURAL"
  | "RISK"
  | "SWITCH"
  | "SIGNAL_LOST"
  | "CRASH_LONG_DEFENSE"
  | "CRASH_SHORT_MOMENTUM"
  | "CRASH"
  | "V2_AUTHORITY"
  | "V2_AUTOMATED_TP_GATE"
  | "UNKNOWN";

/** Market Mode Selector 단일 출력(틱 단위). */
export type PaperMarketMode = "RANGE" | "TREND" | "MIXED" | "TRANSITION" | "NO_TRADE";

export type PaperEngineRoutingKind = "RANGE" | "TREND" | "IDLE";

/** MIXED/TRANSITION 단계(전량 금지 전제). */
export type TransitionPolicyTier = "paused" | "probe_only" | "reduced" | "dominant_reduced";

/** Selector가 결정하는 상위 라우팅(실제 엔진 지휘). */
export type EngineRoutingDecision = Readonly<{
  activeEngine: PaperEngineRoutingKind;
  /** 신규 진입 정책: 전량 / 축소 / 보류 */
  newEntryPolicy: "full" | "reduced" | "paused";
  routingReasonLabel: string;
  /** MIXED/TRANSITION 등: 초소형 탐색만(리스크에서 추가 축소). */
  probeEntryOnly?: boolean;
  /** 혼합·전환 구간 세분(비해당 시 생략). */
  transitionTier?: TransitionPolicyTier;
}>;

export type MarketModeSelectorOutput = Readonly<{
  marketMode: PaperMarketMode;
  /** 0–100 정규화 점수. */
  marketModeScore: number;
  /** 0–1 RANGE 적합도. */
  rangeConfidence: number;
  /** 0–1 TREND 적합도. */
  trendConfidence: number;
  /** 세션/시간대 프로파일 라벨. */
  sessionProfile: string;
  /** 0–1 리스크 스로틀(높을수록 보수). */
  riskThrottle: number;
  modeReasonLabel: string;
  /** 하이웨이: 횡보 판단 근거 라벨 */
  rangeReasonLabel?: string;
  /** 하이웨이: 박스 응집도 */
  boxCohesion01?: number;
  /** 하이웨이: 돌파 실패율 */
  breakoutFailureRate?: number;
  /** 하이웨이: 왕복 빈도 */
  rangeOscillationScore?: number;
  /** 하이웨이: 추세 약성 */
  trendWeaknessScore?: number;
  /** 하이웨이: 박스 왕복 횟수 */
  rangeCycleCount?: number;
  /** 하이웨이: 박스 붕괴 위험도 */
  regimeExitRisk?: number;
  /** 하이웨이: 레짐 상태 */
  regimeState?: PaperRegimeState;
  /** 하이웨이: 진입 의도 */
  entryIntentType?: "probe" | "standard" | "scale" | "trend";
  /** 하이웨이: 진입 확인 상태 */
  entryConfirmationState?: "unconfirmed" | "reacting" | "confirmed";
  /** 하이웨이: 스케일링 권한 */
  scalingPermission?: boolean;
  /** 하이웨이: 탐색 전용 모드 */
  probeOnlyMode?: boolean;
  routing: EngineRoutingDecision;
}>;

export type RangeBoxZone = "upper" | "lower" | "mid";

/**
 * Standardized RANGE zone classification logic.
 * Criteria: lower <= 0.38, upper >= 0.62, else mid.
 * Ref: USER instruction 2026-05-10
 */
export function classifyRangeZone(boxPos: number | null | undefined): RangeBoxZone {
  if (boxPos === null || boxPos === undefined || !Number.isFinite(boxPos)) return "mid";
  if (boxPos >= 0.62) return "upper";
  if (boxPos <= 0.38) return "lower";
  return "mid";
}

/**
 * 보조 진단 전용: 박스 하단/상단 “깊은” 극단. `classifyRangeZone` Primary 밴드(0.38/0.62)와 별개로
 * 기존 리버설·게이트 휴리스틱(0.26/0.74)과 맞춘다.
 */
export const RANGE_ZONE_LOWER_EXTREME_MAX = 0.26;
export const RANGE_ZONE_UPPER_EXTREME_MIN = 0.74;

export function rangeZoneLowerExtreme(boxPos: number | null | undefined): boolean {
  return typeof boxPos === "number" && Number.isFinite(boxPos) && boxPos <= RANGE_ZONE_LOWER_EXTREME_MAX;
}

export function rangeZoneUpperExtreme(boxPos: number | null | undefined): boolean {
  return typeof boxPos === "number" && Number.isFinite(boxPos) && boxPos >= RANGE_ZONE_UPPER_EXTREME_MIN;
}


/** RANGE 엔진이 심볼·틱마다 유지하는 상태(양방향·박스 기준). */
export type RangeEngineState = Readonly<{
  boxUpper: number;
  boxLower: number;
  boxMid: number;
  /** 0–1 또는 엔진 정의 스케일. */
  boxPosition: number;
  /** 상단/하단/중앙 과밀 구간 분기. */
  boxZone: RangeBoxZone;
  rangeCycleCount: number;
  longExposure: number;
  shortExposure: number;
  hedgeBalance: number;
  reopenEligible: boolean;
  rangeLadderLevel: number;
  /** RANGE 철학상 후보 소멸만으로 청산할지 — 기본 false. */
  candidateLostExitAllowed: boolean;
  /** 박스 붕괴(구조적 이탈) 감지. */
  boxBreakout: boolean;
}>;

export type TrendBreakoutDirection = "up" | "down" | "none";

/** 돌파 확인 / 실패 / 재돌파 추적(스위칭 문구·정책용). */
export type TrendBreakoutHoldState = "none" | "hold" | "failed" | "rebreak";

/** 틱 간 돌파 추적 메모리(오케스트레이터 맵에 저장). */
export type TrendBreakoutHoldMemory = Readonly<{
  bandPos: "inside" | "above" | "below";
  lastFailedFrom: "up" | "down" | null;
  rebreakArm: boolean;
}>;

/** TREND 엔진이 심볼·틱마다 산출하는 상태. */
export type TrendEngineState = Readonly<{
  compressionScore: number;
  breakoutUpper: number;
  breakoutLower: number;
  breakoutDirection: TrendBreakoutDirection;
  breakoutConfidence: number;
  trendFollowScore: number;
  /** 돌파 유지·실패·재돌파. */
  breakoutHoldState: TrendBreakoutHoldState;
  /** 사람이 읽는 한 줄(스위칭·대시보드). */
  breakoutHoldLabel: string;
  switchEligible: boolean;
  pyramidLevel: number;
  /** 반대 돌파 시 스위칭(청산+역진입) 스키마용 힌트. */
  switchCloseSide: "long" | "short" | null;
  switchOpenSide: "long" | "short" | null;
  /** 스위칭 시 표시할 상세 사유. */
  trendSwitchReasonLabel: string;
  /** 다음 틱에 전달할 돌파 추적 메모리. */
  holdMemory: TrendBreakoutHoldMemory;
}>;

export type PaperRiskMode = "NORMAL" | "REDUCED" | "DEFENSIVE" | "HALT";

/** Risk & Exposure 엔진 출력. */
export type RiskExposureOutput = Readonly<{
  riskMode: PaperRiskMode;
  /** 0=방어, 1=중립, >1=기회 구간 확대 가중 적용됨. */
  opportunityBias: number;
  /** 수익 확대 vs 보수 운용 한 줄. */
  riskStanceLabel: string;
  sizeMultiplier: number;
  maxLongExposure: number;
  maxShortExposure: number;
  switchSizeMultiplier: number;
  allowNewEntry: boolean;
  allowNewLong: boolean;
  allowNewShort: boolean;
  longSizeMultiplier: number;
  shortSizeMultiplier: number;
  allowAdd: boolean;
  /** RANGE 라우팅 시 같은 심볼 반대 레그(양방향) 허용. */
  allowRangeBidirectional: boolean;
  /** TREND 라우팅 시 반대 레그 신규(헤지) 차단. */
  blockTrendOppositeLeg: boolean;
  /** @deprecated allowRangeBidirectional 참고 */
  allowHedge: boolean;
  riskReasonLabel: string;
}>;

/** 설명 레이어(번들·엔진 상태에 병기). */
export type PaperExplanationFields = Readonly<{
  modeReasonLabel: string;
  engineReasonLabel: string;
  riskReasonLabel: string;
  entryReasonLabel: string;
  exitReasonLabel: string;
  switchReasonLabel: string;
  /** 하이웨이: 횡보 판단 상세 사유 */
  rangeReasonLabel?: string;
  activeEngine: PaperEngineRoutingKind;
  newEntryPolicy: EngineRoutingDecision["newEntryPolicy"];
}>;

/** 대시보드/번들 상단 운영 요약(엔진 상태에서 파생). */
export type PaperOperationalSnapshot = Readonly<{
  modeReasonLabel: string;
  engineReasonLabel: string;
  riskReasonLabel: string;
  activeEngine: PaperEngineRoutingKind;
  newEntryPolicy: EngineRoutingDecision["newEntryPolicy"];
  lastExitReasonLabel: string;
  lastSwitchReasonLabel: string;
  /** UI 한 줄 문구(고정 키). */
  dashboardLines: Readonly<{
    currentMarketJudgment: string;
    currentActiveEngine: string;
    newEntryPolicyLine: string;
    currentRiskState: string;
    /** 공격/보수/보통 한눈에. */
    stanceLine: string;
    lastExitReasonLine: string;
    lastSwitchReasonLine: string;
  }>;
  last_exit_reason?: string;
  last_switch_reason?: string;
  exchange: "okx";
  okx_demo_enabled: boolean;
  okx_demo_keys_loaded: boolean;
  okx_signed_rest_ready: boolean;
  okx_account_config_ok: boolean;
  okx_balance_ok: boolean;
  okx_positions_ok: boolean;
  okx_order_submit_ok: boolean;
  paper_execution_ready?: boolean;
  signed_execution_ready?: boolean;
  signed_submit_mode?: "enabled" | "skipped_not_ready" | "paper_only";
  signed_submit_block_reason?: string | null;
  strategy_executor: PaperEngineRoutingKind;
  current_regime: PaperRegimeState;
  entryAllowedLong: boolean;
  entryAllowedShort: boolean;
  directional_shock_state: string;
  long_allow: boolean;
  short_allow: boolean;
  server_trade_enabled?: boolean;
  close_only_mode?: boolean;
  close_only_mode_effective?: boolean;
  serverTradeEnabled?: boolean;
  closeOnlyMode?: boolean;
  closeOnlyModeEffective?: boolean;
  killSwitch?: boolean;
  reconcileSafeMode?: boolean;
  entry_quality_grade?: string | null;
  leverage_profile?: string | null;
  applied_leverage?: number | null;
  leverage_reason?: string | null;
  leverage_block_reason?: string | null;
  exposure_notional_krw?: number | null;
  equity_multiple?: number | null;
  authority_source?: string;
  fresh_tick_age_ms?: number | null;
  snapshot_age_ms?: number | null;
  position_tracking_alive?: boolean;
  entry_pipeline_ready?: boolean;
  exit_pipeline_ready?: boolean;
  reconcile_safe_mode_active?: boolean;
  reconcile_last_mismatch_reason?: string | null;
  symbol_decisions: Record<string, { decision: PaperSymbolDecisionRecord; adaptiveOk: boolean }>;

  /** OKX Real-time Balance Fields */
  okx_wallet_balance_usdt?: number | null;
  okx_available_balance_usdt?: number | null;
  okx_used_margin_usdt?: number | null;
  okx_total_position_notional_usdt?: number | null;
  okx_unrealized_pnl_usdt?: number | null;
  okx_total_equity_usdt?: number | null;
  usdt_frozen_bal?: number | null;
  okx_balance_updated_at?: number;
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
  /** 진입 시 실행기(RANGE/TREND/IDLE) — 종료 행에도 보존. */
  executorAtEntry?: "RANGE" | "TREND" | "IDLE";
  /** 진입 시점 레짐(RANGE/TREND/NO_TRADE) — 모드별 성과 분리용. */
  regimeAtEntry?: "RANGE" | "TREND" | "NO_TRADE";
  /** `executorAtEntry`와 동일 의미의 뷰 alias(전략/실행기). */
  strategy?: "RANGE" | "TREND" | "IDLE";
  /** `regimeAtEntry`와 동일 의미의 뷰 alias. */
  regime?: "RANGE" | "TREND" | "NO_TRADE";
  /** `sourceSignal`과 동일 의미의 뷰 alias(진입 신호·진입 사유). */
  entryReason?: string;
  /** 권한 소스 alias(`authoritySourceAtEntry` 우선, 없으면 레거시 `authority`). */
  authority?: string;
  /** 권한 방향 alias(`authoritySideAtEntry` 우선, 없으면 레거시 `authoritySide`). */
  authoritySide?: string;
  /** RANGE 진입 시 박스 위치·구간 스냅샷 */
  rangeEntryBoxPos?: number;
  rangeEntryZone?: "upper" | "lower" | "mid";
  rangeEntryFromReversalSwitch?: boolean;
  /** 청산 시점 진입 단계(1=초기, 2+=증액). 재진입 쿨다운 정책용. */
  entryStageAtClose?: number;
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
  | "partial_exit_2"
  | "range_box_break"
  | "range_profit_trail"
  | "structural_regime_shift"
  | "trend_switch"
  | "manual_full_close_reconciled"
  | "EXIT_LONG_CRASH_FORCE"
  | "EXIT_LONG_CRASH_REDUCE"
  | "EXIT_SHORT_MOMENTUM_TRAIL"
  | "EXIT_CRASH_FORCE"
  | "EXIT_CRASH_REDUCE"
  | "v2_exit_authority"
  | "v2_partial_authority";
  /** 표준 종료 유형 (내부 코드). */
  exitType: PaperExitType;
  /** 사용자·리포트용 종료 사유 문구. */
  closeReasonLabel: string;
  /** API/UI 명시명 — 보통 `closeReasonLabel`과 동일(신규 건 항상 기록). */
  exitReason?: string;
  /** SL / TP / TIME / RISK 등 카테고리(신규 건 항상 기록). */
  closeSource?: PaperCloseSource;
  /** 실현 손익 USD (= pnlUsdNet, 신규 건 항상 기록). */
  realizedPnlUsd?: number;
  /** 마진 대비 실현 손익률(레그 기준, 신규 건 항상 기록). */
  realizedPnlPct?: number;
  /** 익/손/보합(신규 건 항상 기록). */
  outcomeStatus?: "win" | "loss" | "flat";
}>;

// --- PENDING ENTRY REGISTRY ---
export interface PendingEntryOrderRecord {
  symbol: string;
  side: "long" | "short";
  ordId: string;
  clOrdId: string;
  instId: string;
  authority_source: string;
  intended_notional_usdt: number;
  stopPrice?: number;
  createdAt: number;
  status: "ENTRY_ORDER_PENDING";
  
  /** To recreate the full open position and events once filled */
  paperRecordSnapshot: any;
  authoritySnapshot: any;
  openTraceId: string;

  /** V2 Recovery Pipeline Metrics */
  recoveryAttemptCount?: number;
  lastRecoveryAt?: number;
  originalLimitPrice?: number;
  missedFillReason?: "stale" | "price_moved" | "cancel_requested";
  missedLimitFillCount?: number;
  lastEntryIntentSide?: string;
}

// --- EOF ---
