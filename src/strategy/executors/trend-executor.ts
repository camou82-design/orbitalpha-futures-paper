import type { PaperSignal } from "../entry-signal";
import type { MarketRegime } from "../market-regime-detector";
import type { RiskState, TrendEntryDecision, TrendExitDecision } from "./types";

function intentDirection(signal: PaperSignal): "long" | "short" | null {
  if (signal === "paper_long_candidate") return "long";
  if (signal === "paper_short_candidate") return "short";
  return null;
}

export function trendExecutorEvaluateEntry(input: Readonly<{
  regime: MarketRegime;
  risk_state: RiskState;
  symbol: string;
  signal: PaperSignal;
  qualityScore: number;
  lastPrice: number;
  ema20: number | null;
  ema60: number | null;
  volumeRatioProxy: number;
  boxHigh: number | null;
  boxLow: number | null;
  expectedMove: number | null;
  totalCost: number | null;
  atr: number | null;
  cooldownActive: boolean;
  cooldownRemainingMs: number;
  /** 현재 들고 있는 단계 (없으면 0) */
  currentStage?: number;
} & Record<string, unknown>>): TrendEntryDecision {
  const dir = intentDirection(input.signal);
  const e20 = input.ema20;
  const e60 = input.ema60;

  const hasBox = input.boxHigh !== null && input.boxLow !== null && input.boxHigh > input.boxLow;
  const breakoutUp = hasBox ? input.lastPrice >= (input.boxHigh as number) * 1.0006 : null;
  const breakoutDown = hasBox ? input.lastPrice <= (input.boxLow as number) * 0.9994 : null;
  const breakout_state =
    breakoutUp === null || breakoutDown === null ? "unknown" : breakoutUp ? "breakout_up" : breakoutDown ? "breakout_down" : "none";

  const pullbackLong = e20 !== null ? input.lastPrice <= e20 * 1.006 && input.lastPrice >= e20 * 0.994 : null;
  const pullbackShort = e20 !== null ? input.lastPrice >= e20 * 0.994 && input.lastPrice <= e20 * 1.006 : null;
  const pullback_state =
    pullbackLong === null || pullbackShort === null
      ? "unknown"
      : dir === "long"
        ? pullbackLong
          ? "pullback_ok"
          : "pullback_bad"
        : dir === "short"
          ? pullbackShort
            ? "pullback_ok"
            : "pullback_bad"
          : "unknown";

  if (input.regime !== "TREND") {
    return {
      regime: input.regime,
      executor: "TREND",
      entry_allowed: false,
      blocked_reason: "regime_not_trend",
      breakout_state,
      pullback_state,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { symbol: input.symbol }
    };
  }

  if (input.risk_state === "BLOCKED") {
    return {
      regime: input.regime,
      executor: "TREND",
      entry_allowed: false,
      blocked_reason: "risk_blocked",
      breakout_state,
      pullback_state,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: {}
    };
  }

  if (input.cooldownActive) {
    return {
      regime: input.regime,
      executor: "TREND",
      entry_allowed: false,
      blocked_reason: "trend_cooldown_active",
      breakout_state,
      pullback_state,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { cooldown_remaining_ms: input.cooldownRemainingMs }
    };
  }

  if (dir === null) {
    return {
      regime: input.regime,
      executor: "TREND",
      entry_allowed: false,
      blocked_reason: "no_signal",
      breakout_state,
      pullback_state,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: {}
    };
  }

  if (input.qualityScore < 64) {
    return {
      regime: input.regime,
      executor: "TREND",
      entry_allowed: false,
      blocked_reason: "trend_low_quality",
      breakout_state,
      pullback_state,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { score: input.qualityScore, floor: 64 }
    };
  }

  if (e20 === null || e60 === null || !Number.isFinite(e20) || !Number.isFinite(e60)) {
    return {
      regime: input.regime,
      executor: "TREND",
      entry_allowed: false,
      blocked_reason: "trend_ema_missing",
      breakout_state,
      pullback_state,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: {}
    };
  }

  const clAlignedLong = e20 > e60 * 1.0002;
  const clAlignedShort = e20 < e60 * 0.9998;
  if (dir === "long" && !clAlignedLong) {
    return {
      regime: input.regime,
      executor: "TREND",
      entry_allowed: false,
      blocked_reason: "trend_direction_weak",
      breakout_state,
      pullback_state,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { sub: "ema_not_aligned_long" }
    };
  }
  if (dir === "short" && !clAlignedShort) {
    return {
      regime: input.regime,
      executor: "TREND",
      entry_allowed: false,
      blocked_reason: "trend_direction_weak",
      breakout_state,
      pullback_state,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { sub: "ema_not_aligned_short" }
    };
  }

  // Trend should trade less: require stronger activity.
  if (input.volumeRatioProxy < 1.05) {
    return {
      regime: input.regime,
      executor: "TREND",
      entry_allowed: false,
      blocked_reason: "trend_volume_too_thin",
      breakout_state,
      pullback_state,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { volume_ratio_proxy: input.volumeRatioProxy, min: 1.05 }
    };
  }

  const breakoutOk =
    dir === "long" ? breakout_state === "breakout_up" : dir === "short" ? breakout_state === "breakout_down" : false;
  const pullbackOk = pullback_state === "pullback_ok";

  const currentStage = input.currentStage ?? 0;

  // 가이드 메시지 생성
  let guidance = "";
  if (dir === "long") {
    if (pullback_state === "pullback_ok") guidance = "추세 상승 중 눌림 발생 (선진입 대기)";
    else guidance = "추세 상승 중 (눌림 대기)";
  } else if (dir === "short") {
    if (pullback_state === "pullback_ok") guidance = "추세 하락 중 되돌림 발생 (선진입 대기)";
    else guidance = "추세 하랄 중 (되돌림 대기)";
  }

  if (currentStage === 0) {
    // 1차 선진입: EMA20 눌림 확인
    if (!pullbackOk) {
      return {
        regime: input.regime,
        executor: "TREND",
        entry_allowed: false,
        blocked_reason: "trend_not_in_pullback",
        breakout_state,
        pullback_state,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        guidance,
        detail: { pullback_state }
      };
    }

    // 최소 품질 확인
    if (input.qualityScore < 60) {
      return {
        regime: input.regime,
        executor: "TREND",
        entry_allowed: false,
        blocked_reason: "trend_low_quality_for_lead",
        breakout_state,
        pullback_state,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        guidance: "진입 대기: 추세 반응 약함",
        detail: { score: input.qualityScore }
      };
    }

    return {
      regime: input.regime,
      executor: "TREND",
      entry_allowed: true,
      blocked_reason: null,
      breakout_state,
      pullback_state,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      target_stage: 1,
      guidance: "1차 추세 선진입 실행 (비중 30%)",
      next_action: "2차 반등 확인 추가진입 대기",
      invalidate_condition: dir === "long" ? "EMA20 하향 돌파 시" : "EMA20 상향 돌파 시",
      risk_note: input.volumeRatioProxy < 1.1 ? "거래량 다소 부족" : undefined,
      watch_zone: "EMA20 인근",
      entry_progress: 30,
      detail: { direction: dir, pullbackOk, stage: 1 }
    };
  }

  // 2차/3차 추가진입
  if (currentStage === 1) {
    // 2차: EMA20 반등/재하락 시작 (Price moving away from e20 in favorable direction)
    const movingAway = dir === "long" ? input.lastPrice > (e20 ?? 0) * 1.002 : input.lastPrice < (e20 ?? 0) * 0.998;
    if (movingAway) {
      return {
        regime: input.regime,
        executor: "TREND",
        entry_allowed: true,
        blocked_reason: null,
        breakout_state,
        pullback_state,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        target_stage: 2,
        guidance: "2차 반등 확인 추가진입 (비중 30%)",
        next_action: "3차 전고/전저 돌파 확정진입 대기",
        invalidate_condition: "역추세 신호 발생 시",
        entry_progress: 60,
        detail: { stage: 2 }
      };
    }
  }

  if (currentStage === 2) {
    // 3차: 전고점/전저점 돌파 (breakoutOk)
    if (breakoutOk) {
      return {
        regime: input.regime,
        executor: "TREND",
        entry_allowed: true,
        blocked_reason: null,
        breakout_state,
        pullback_state,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        target_stage: 3,
        guidance: "3차 전고/전저 돌파 확정진입 (비중 40%)",
        next_action: "1차 익절 대기 (RR 1.0 도달 시)",
        invalidate_condition: "돌파 실패 및 박스 복귀 시",
        entry_progress: 100,
        detail: { stage: 3 }
      };
    }
  }

  return {
    regime: input.regime,
    executor: "TREND",
    entry_allowed: false,
    blocked_reason: "trend_scaling_not_triggered",
    breakout_state,
    pullback_state,
    expected_move: input.expectedMove,
    total_cost: input.totalCost,
    risk_state: input.risk_state,
    guidance: "추격 신호 대기 및 추세 관찰 중",
    detail: { currentStage, breakout_state }
  };
}

export function trendExecutorEvaluateExit(input: Readonly<{
  side: "long" | "short";
  pnlPctNet: number;
  mark: number;
  entryPrice: number;
  atr: number | null;
  partialExitStage: number;
  holdingMs: number;
  trailingExtreme?: number;
}>): TrendExitDecision {
  const isLong = input.side === "long";
  const atr = input.atr ?? 0;
  const rr = input.pnlPctNet / (atr / input.entryPrice + 1e-9); // Approx RR based on ATR unit

  // 1. 손절 조건 (반대 방향 1.5 ATR 이탈)
  let stopPrice = 0;
  if (isLong) {
    stopPrice = input.entryPrice - 1.5 * atr;
    if (input.mark < stopPrice) {
      return {
        executor: "TREND",
        action: "close",
        reason: "stop_loss",
        guidance: "추세 반전 및 손절가 이탈",
        exit_progress: 100,
        stop_price: stopPrice,
        detail: { mark: input.mark, stopPrice }
      };
    }
  } else {
    stopPrice = input.entryPrice + 1.5 * atr;
    if (input.mark > stopPrice) {
      return {
        executor: "TREND",
        action: "close",
        reason: "stop_loss",
        guidance: "추세 반전 및 손절가 이탈",
        exit_progress: 100,
        stop_price: stopPrice,
        detail: { mark: input.mark, stopPrice }
      };
    }
  }

  // 2. 익절 조건 (RR 기반 분할)
  // Stage 0 -> 1: RR 1.0 (ATR 1배 수익)
  if (input.partialExitStage === 0) {
    if (input.pnlPctNet >= 0.008) { // 고정 최소 수익률 0.8% or RR 1.0
      return {
        executor: "TREND",
        action: "partial_close",
        reason: "partial_exit_1",
        guidance: "1차 익절 도달 (추세 유지 확인)",
        next_action: "2차 익절 대기 (RR 2.0 도달 시)",
        exit_progress: 30,
        detail: { pnl: input.pnlPctNet, stage: 1 }
      };
    }
  }

  // Stage 1 -> 2: RR 2.0 (ATR 2배 수익)
  if (input.partialExitStage === 1) {
    if (input.pnlPctNet >= 0.016) {
      return {
        executor: "TREND",
        action: "partial_close",
        reason: "partial_exit_2",
        guidance: "2차 익절 도달 (수익 확보 완료)",
        next_action: "잔량 트레일링 스탑 추적 시작",
        exit_progress: 70,
        detail: { pnl: input.pnlPctNet, stage: 2 }
      };
    }
  }

  // 3. 트레일링 스탑 (ATR 기반)
  if (input.partialExitStage >= 1) {
    const extreme = input.trailingExtreme ?? input.mark;
    const trailBuffer = 1.2 * atr;
    const trailLevel = isLong ? extreme - trailBuffer : extreme + trailBuffer;

    const hitTrailing = isLong ? input.mark <= trailLevel : input.mark >= trailLevel;
    if (hitTrailing && input.pnlPctNet >= 0.005) { // 최소 수익 담보
      return {
        executor: "TREND",
        action: "close",
        reason: "trailing_stop",
        guidance: "추세 둔화로 인한 트레일링 스탑 체결",
        exit_progress: 100,
        detail: { mark: input.mark, trailLevel }
      };
    }
  }

  // 기본 유지
  return {
    executor: "TREND",
    action: "hold",
    reason: null,
    guidance: input.partialExitStage === 0 ? "추세 확장 중" : "수익 보호 및 추적 중",
    next_action: input.partialExitStage === 0 ? "1차 익절(RR 1.0) 대기" : "트레일링 종료 대기",
    exit_progress: input.partialExitStage === 0 ? 15 : input.partialExitStage === 1 ? 55 : 85,
    stop_price: stopPrice,
    detail: { pnl: input.pnlPctNet, partialExitStage: input.partialExitStage }
  };
}

