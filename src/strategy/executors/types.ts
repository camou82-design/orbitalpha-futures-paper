import type { MarketRegime } from "../market-regime-detector";

/** RANGE/TREND = 활성 전략 실행기, IDLE = 대기·미진입·NO_TRADE 등 (레거시 NONE 대체). */
export type ExecutorName = "RANGE" | "TREND" | "IDLE";

export type RiskState = "NORMAL" | "LIMITED" | "BLOCKED";

export type EntryDecisionBase = Readonly<{
  entry_allowed: boolean;
  blocked_reason: string | null;
  expected_move: number | null;
  total_cost: number | null;
  risk_state: RiskState;
  regime: MarketRegime;
  executor: ExecutorName;
  detail: Record<string, unknown>;
  /** 목표 진입 단계 (1, 2, 3) */
  target_stage?: number;
  /** 현재 행동 가이드 */
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
  /** 하이웨이: 진입 의도 */
  entryIntentType?: "probe" | "standard" | "scale" | "trend";
  /** 하이웨이: 진입 확정 상태 */
  entryConfirmationState?: "unconfirmed" | "reacting" | "confirmed";
  /** 하이웨이: 불확실 구간 축소 진입 여부 */
  probeOnlyMode?: boolean;
  /** 하이웨이: 추가 불타기 권한 */
  scalingPermission?: boolean;
}>;

export type RangeEntryDecision = Readonly<
  EntryDecisionBase & {
    executor: "RANGE";
    box_position: "upper" | "lower" | "middle" | "unknown";
  }
>;

export type TrendEntryDecision = Readonly<
  EntryDecisionBase & {
    executor: "TREND";
    breakout_state: "breakout_up" | "breakout_down" | "none" | "unknown";
    pullback_state: "pullback_ok" | "pullback_bad" | "unknown";
  }
>;

/** 진입 불가·대기 상태의 결정 (레거시 NoopEntryDecision / executor NONE). */
export type IdleEntryDecision = Readonly<EntryDecisionBase & { executor: "IDLE" }>;

/** @deprecated IdleEntryDecision 사용. */
export type NoopEntryDecision = IdleEntryDecision;

export type AnyEntryDecision = RangeEntryDecision | TrendEntryDecision | IdleEntryDecision;

export type ExitAction = "hold" | "partial_close" | "close";

export type ExitOutcomeBase = Readonly<{
  action: ExitAction;
  reason: string | null;
  /** 현재 행동 가이드 */
  guidance?: string;
  /** 다음 예상 행동 */
  next_action?: string;
  /** 시나리오 무효화 조건 */
  invalidate_condition?: string;
  /** 리스크 특이사항 */
  risk_note?: string;
  /** 목표가 1 (1차 익절) */
  target_price_1?: number;
  /** 목표가 2 (2차 익절) */
  target_price_2?: number;
  /** 손절가 (동적) */
  stop_price?: number;
  /** 탈출 진행도 (0~100%) */
  exit_progress?: number;
  detail: Record<string, unknown>;
}>;

export type RangeExitDecision = Readonly<
  ExitOutcomeBase & {
    executor: "RANGE";
  }
>;

export type TrendExitDecision = Readonly<
  ExitOutcomeBase & {
    executor: "TREND";
  }
>;

export type AnyExitDecision = RangeExitDecision | TrendExitDecision;

