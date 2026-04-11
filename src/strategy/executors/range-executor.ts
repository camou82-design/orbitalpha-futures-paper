import type { PaperSignal } from "../entry-signal";
import type { MarketRegime } from "../market-regime-detector";
import type { RangeEntryDecision, RangeExitDecision, RiskState } from "./types";

function intentDirection(signal: PaperSignal): "long" | "short" | null {
  if (signal === "paper_long_candidate") return "long";
  if (signal === "paper_short_candidate") return "short";
  return null;
}

export function rangeExecutorEvaluateEntry(input: Readonly<{
  regime: MarketRegime;
  risk_state: RiskState;
  symbol: string;
  signal: PaperSignal;
  qualityScore: number;
  boxPos: number | null;
  boxRel: number | null;
  expectedMove: number | null;
  totalCost: number | null;
  atr: number | null;
  cooldownActive: boolean;
  cooldownRemainingMs: number;
  /** 현재 들고 있는 단계 (없으면 0) */
  currentStage?: number;
} & Record<string, unknown>>): RangeEntryDecision {
  const dir = intentDirection(input.signal);
  const boxPos = input.boxPos;
  const boxRel = input.boxRel;

  const box_position =
    boxPos === null || !Number.isFinite(boxPos)
      ? "unknown"
      : boxPos < 0.33
        ? "lower"
        : boxPos > 0.67
          ? "upper"
          : "middle";

  if (input.regime !== "RANGE") {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "regime_not_range",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { symbol: input.symbol }
    };
  }

  if (input.risk_state === "BLOCKED") {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "risk_blocked",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: {}
    };
  }

  if (input.cooldownActive) {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "range_cooldown_active",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { cooldown_remaining_ms: input.cooldownRemainingMs }
    };
  }

  if (dir === null) {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "no_signal",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: {}
    };
  }

  // Box must exist and be wide enough.
  if (boxPos === null || boxRel === null) {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "range_box_missing",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: {}
    };
  }
  if (boxRel < 0.0045) {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "range_box_too_narrow",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { box_rel: boxRel, min: 0.0045 }
    };
  }

  // Middle is forbidden in range.
  if (box_position === "middle") {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "range_center_forbidden",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { box_pos: boxPos }
    };
  }

  // Edge-only single-direction.
  if (dir === "long" && box_position !== "lower") {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "range_not_lower_edge",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { box_pos: boxPos }
    };
  }
  if (dir === "short" && box_position !== "upper") {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "range_not_upper_edge",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { box_pos: boxPos }
    };
  }

  const currentStage = input.currentStage ?? 0;

  // 가이드 메시지 생성
  let guidance = "";
  if (dir === "long") {
    if (box_position === "lower") guidance = "박스 하단 지지 확인 중 (선진입 대기)";
    else guidance = "박스 하단 대기 중";
  } else if (dir === "short") {
    if (box_position === "upper") guidance = "박스 상단 저항 확인 중 (선진입 대기)";
    else guidance = "박스 상단 대기 중";
  }

  // 1차 선진입 조건: 박스 끝단 15% 이내 진입
  const edgeThreshold = 0.15;
  const inInterestZone = dir === "long" ? (boxPos ?? 0) <= edgeThreshold : (boxPos ?? 1) >= (1 - edgeThreshold);

  if (currentStage === 0) {
    if (!inInterestZone) {
      return {
        regime: input.regime,
        executor: "RANGE",
        entry_allowed: false,
        blocked_reason: "range_not_in_interest_zone",
        box_position,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        guidance,
        detail: { box_pos: boxPos, threshold: edgeThreshold }
      };
    }

    // 최소 반응 조건 확인 (여기서는 단순히 qualityScore나 boxPos의 미세 변화를 사용하거나, 
    // 추후 candle 분석 로직을 더 강화할 수 있음. 현재는 qualityScore 60 이상으로 완화)
    if (input.qualityScore < 60) {
      return {
        regime: input.regime,
        executor: "RANGE",
        entry_allowed: false,
        blocked_reason: "range_low_quality_for_lead",
        box_position,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        guidance: "진입 대기: 반전 신호 약함",
        detail: { score: input.qualityScore, floor: 60 }
      };
    }

    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: true,
      blocked_reason: null,
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      target_stage: 1,
      guidance: "1차 선진입 실행 (비중 25%)",
      next_action: "2차 추가진입 대기 (방향 전환 확인 시)",
      invalidate_condition: dir === "long" ? "박스 하단 이탈 시" : "박스 상단 돌파 시",
      risk_note: input.expectedMove && input.expectedMove < 0.005 ? "저변동성 주의" : undefined,
      watch_zone: dir === "long" ? "박스 하단 지지선" : "박스 상단 저항선",
      entry_progress: 25,
      detail: { direction: dir, box_pos: boxPos, box_rel: boxRel, stage: 1 }
    };
  }

  // 2차/3차 추가진입 로직
  if (currentStage === 1) {
    // 2차 조건: 방향 전환 확인 (박스 25% 지점 이상 반전)
    const confirmed = dir === "long" ? (boxPos ?? 0) > 0.25 : (boxPos ?? 1) < 0.75;
    if (confirmed) {
      return {
        regime: input.regime,
        executor: "RANGE",
        entry_allowed: true,
        blocked_reason: null,
        box_position,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        target_stage: 2,
        guidance: "2차 추가진입 실행 (비중 35%)",
        next_action: "3차 확정진입 대기 (중심선 향해 가속 시)",
        invalidate_condition: dir === "long" ? "다시 박스 하단으로 밀릴 시" : "다시 박스 상단으로 밀릴 시",
        entry_progress: 60,
        detail: { stage: 2 }
      };
    }
  }

  if (currentStage === 2) {
    // 3차 조건: 중심선(0.5) 향해 가속 (40% 지점 돌파)
    const finalConfirm = dir === "long" ? (boxPos ?? 0) > 0.4 : (boxPos ?? 1) < 0.6;
    if (finalConfirm) {
      return {
        regime: input.regime,
        executor: "RANGE",
        entry_allowed: true,
        blocked_reason: null,
        box_position,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        target_stage: 3,
        guidance: "3차 확정진입 실행 (비중 40%)",
        next_action: "1차 분할익절 대기 (중심선 도달 시)",
        invalidate_condition: "역추세 발생 시 즉시 정리",
        entry_progress: 100,
        detail: { stage: 3 }
      };
    }
  }

  return {
    regime: input.regime,
    executor: "RANGE",
    entry_allowed: false,
    blocked_reason: "range_scaling_not_triggered",
    box_position,
    expected_move: input.expectedMove,
    total_cost: input.totalCost,
    risk_state: input.risk_state,
    guidance: "추가 진입 대기 및 가격 관찰 중",
    detail: { currentStage, boxPos }
  };
}

export function rangeExecutorEvaluateExit(input: Readonly<{
  side: "long" | "short";
  pnlPctNet: number;
  mark: number;
  boxPos: number | null;
  boxHigh: number | null;
  boxLow: number | null;
  atr: number | null;
  partialExitStage: number;
  holdingMs: number;
}>): RangeExitDecision {
  const boxPos = input.boxPos ?? 0.5;
  const isLong = input.side === "long";
  const atr = input.atr ?? 0;

  // 1. 손절 조건 (박스 이탈 + 0.5 ATR 버퍼)
  let stopPrice = 0;
  if (isLong) {
    stopPrice = (input.boxLow ?? 0) - 0.5 * atr;
    if (input.mark < stopPrice) {
      return {
        executor: "RANGE",
        action: "close",
        reason: "stop_loss",
        guidance: "박스 하단 이탈로 인한 손절",
        exit_progress: 100,
        stop_price: stopPrice,
        detail: { mark: input.mark, stopPrice, boxLow: input.boxLow }
      };
    }
  } else {
    stopPrice = (input.boxHigh ?? 0) + 0.5 * atr;
    if (input.mark > stopPrice) {
      return {
        executor: "RANGE",
        action: "close",
        reason: "stop_loss",
        guidance: "박스 상단 돌파로 인한 손절",
        exit_progress: 100,
        stop_price: stopPrice,
        detail: { mark: input.mark, stopPrice, boxHigh: input.boxHigh }
      };
    }
  }

  // 2. 익절 조건 (3단계 분할)
  // Stage 0 -> 1: 박스 중심선 근처 (0.4 ~ 0.6) 진입 시 70-90% 지점
  if (input.partialExitStage === 0) {
    const reachedFirstTp = isLong ? boxPos >= 0.42 : boxPos <= 0.58;
    if (reachedFirstTp) {
      return {
        executor: "RANGE",
        action: "partial_close",
        reason: "partial_exit_1",
        guidance: "1차 익절구역 도달 (중심선 인근)",
        next_action: "2차 익절 대기 (중심선 완전 도달 시)",
        exit_progress: 30,
        detail: { boxPos, stage: 1 }
      };
    }
  }

  // Stage 1 -> 2: 박스 중심선 (0.5) 도달
  if (input.partialExitStage === 1) {
    const reachedSecondTp = isLong ? boxPos >= 0.5 : boxPos <= 0.5;
    if (reachedSecondTp) {
      return {
        executor: "RANGE",
        action: "partial_close",
        reason: "partial_exit_2",
        guidance: "2차 익절구역 도달 (중심선 확정)",
        next_action: "잔량 트레일링 및 역추세 감시",
        exit_progress: 70,
        detail: { boxPos, stage: 2 }
      };
    }
  }

  // 3. 반전 청산 (중심선 넘었다가 다시 밀릴 때)
  if (input.partialExitStage >= 1) {
    const reversed = isLong ? boxPos < 0.45 : boxPos > 0.55;
    if (reversed) {
      return {
        executor: "RANGE",
        action: "close",
        reason: "trend_break_exit",
        guidance: "중심선 지지 실패로 인한 조기 청산",
        exit_progress: 100,
        detail: { boxPos }
      };
    }
  }

  // 기본 유지
  return {
    executor: "RANGE",
    action: "hold",
    reason: null,
    guidance: input.partialExitStage === 0 ? "중심선 방향 진행 중" : "잔량 수익 극대화 중",
    next_action: input.partialExitStage === 0 ? "1차 익절 대기" : "최종 청산 대기",
    exit_progress: input.partialExitStage === 0 ? 10 : input.partialExitStage === 1 ? 50 : 80,
    stop_price: stopPrice,
    detail: { boxPos, partialExitStage: input.partialExitStage }
  };
}

