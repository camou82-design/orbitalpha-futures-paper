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
  /** Test-only: bypass legacy block path for RANGE stage0 candidate diagnostics. */
  paperTestBypassLegacyRangeStage0: boolean;
  /** Test-only: bypass only blocked_regime_until_active for RANGE stage0 candidate diagnostics. */
  paperTestBypassBlockedRegimeUntilRangeStage0: boolean;
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
  /**
   * Paper test: if set (>0), skip dynamic fee/slippage fraction for edge checks and use
   * `required_cost_usd = paperFixedTotalCostUsd * leniency` vs `expected_move_usd = em * DEFAULT_PAPER_SIZE_USD`.
   * Env: `PAPER_FIXED_TOTAL_COST_USD` (e.g. 30).
   */
  paperFixedTotalCostUsd: number | null;
  /** OKX demo adapter toggle (strictly isolated from live env). */
  okxDemoEnabled: boolean;
  /** OKX demo REST base URL (default https://www.okx.com). */
  okxDemoBaseUrl: string;
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
  | "ORDER_BUILD_FAIL"
  | "EXECUTOR_INIT_FAIL"
  | "EXECUTION_DISABLED"
  /** RANGE·Stage1·SHORT 후보: Long Only로 숏 미체결·보류(SKIP), EXECUTION_DISABLED 미사용 */
  | "LONG_ONLY_SHORT_DEFERRED"
  | "AI_DIRECTION_MISMATCH"
  | "STAGE1_BLOCKED_LIMIT"
  | "LEGACY_BLOCKED";

export type PaperStage1ResultCode =
  | "STAGE1_ENTERED"
  | "STAGE1_EXEC_PENDING"
  | "STAGE1_COST_WARNING"
  | "STAGE1_BLOCKED_LIMIT"
  | "STAGE1_BLOCKED_EDGE"
  | "STAGE1_BLOCKED_RISK"
  | "STAGE1_BLOCKED_QUALITY"
  | "STAGE1_BLOCKED_REGIME"
  | "STAGE1_BLOCKED_SIGNAL"
  | "STAGE1_BLOCKED_DATA"
  | "STAGE1_LONG_ONLY_SHORT_DEFERRED"
  | "STAGE1_UNKNOWN_REGIME_RANGE_FALLBACK";

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
  /** 테스트: blocked_regime_until_active 단일 우회 적용 여부 */
  blocked_regime_until_bypass_applied?: boolean;
  /** 테스트: blocked_regime_until_active 우회 사유 */
  blocked_regime_until_bypass_reason?: string | null;
  /** 테스트: 우회 전 blocked regime 잔여(ms) */
  blocked_regime_original_until_ms?: number | null;
  /** 테스트: 우회 전 blocked regime 원본 사유 */
  blocked_regime_original_reason?: string | null;
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
  /** 반전 청산 직후(또는 pending) 반대 방향 즉시 평가 적용 */
  range_reversal_immediate_switch_applied?: boolean;
  range_reversal_immediate_switch_reason?: string | null;
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
  /** 대시보드용 직전 청산 라벨(설명·이벤트와 동기화) */
  last_exit_reason?: string;
  /** 대시보드용 직전 TREND 스위칭 라벨 */
  last_switch_reason?: string;
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
  /** Stage 1이 비용 경고 하에 열렸으면 증액(스케일인) 제한·청산 보수화 */
  postEntryCostGuard?: boolean;
  /** RANGE 진입 시 박스 내 상대 위치 (분석·최근 체결 분포용) */
  rangeEntryBoxPos?: number;
  /** RANGE 진입 시 구간(상단/중단/하단) */
  rangeEntryZone?: "upper" | "lower" | "mid";
  /** 구간 반전 청산 직후 합성 후보로 연결된 진입 */
  rangeEntryFromReversalSwitch?: boolean;
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
}>;

/** 종료 레코드·이벤트에 함께 쓰는 종료 유형 코드(레저·로그 공통). */
export type PaperExitType =
  | "EXIT_SL"
  | "EXIT_TP"
  | "EXIT_TP_1"
  | "EXIT_TP_2"
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
  | "EXIT_UNKNOWN";

/** 종료 저장·API용 카테고리(SL/TP/…). */
export type PaperCloseSource =
  | "SL"
  | "TP"
  | "TP_PARTIAL"
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
  | "structural_regime_shift"
  | "trend_switch";
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

// --- EOF ---
