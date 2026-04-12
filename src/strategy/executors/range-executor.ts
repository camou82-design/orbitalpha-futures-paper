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
  risk_note?: string;
  /** 감시 구역 (예: "박스 하단 102k-103k") */
  watch_zone?: string;
  /** 진입 진행도 (0~100%) */
  entry_progress?: number;
  /** 하이웨이: 횡보 확신도 */
  rangeConfidence?: number;
  /** 하이웨이: 박스 응집도 */
  boxCohesion01?: number;
  /** 하이웨이: 추세 약성 */
  trendWeaknessScore?: number;
  /** 하이웨이: 횡보 판단 근거 라벨 */
  rangeReasonLabel?: string;
} & Record<string, unknown>>): RangeEntryDecision {
  const dir = intentDirection(input.signal);
  const boxPos = input.boxPos;
  const boxRel = input.boxRel;
  const currentStage = input.currentStage ?? 0;
  const rangeCycleCount = input.rangeCycleCount ?? 0;
  const rangeConfidence = input.rangeConfidence ?? 0.5;

  const box_position =
    boxPos === null || !Number.isFinite(boxPos)
      ? "unknown"
      : boxPos < 0.35
        ? "lower"
        : boxPos > 0.65
          ? "upper"
          : "middle";

  if (input.regime !== "RANGE" && currentStage === 0) {
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

  if (input.cooldownActive && currentStage === 0) {
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

  // Highway Tiered Box Filter
  if (boxRel < 0.0035) {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "range_box_too_narrow",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { box_rel: boxRel, min: 0.0035 }
    };
  }

  // Highway Zone Priorities
  if (box_position === "lower" && dir === "short" && currentStage === 0) {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "lower_zone_short_forbidden",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      guidance: "하단 존: 숏 신규 진입 금지 (롱 반등 대기)",
      detail: { box_pos: boxPos }
    };
  }
  if (box_position === "upper" && dir === "long" && currentStage === 0) {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "upper_zone_long_forbidden",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      guidance: "상단 존: 롱 신규 진입 금지 (숏 저항 대기)",
      detail: { box_pos: boxPos }
    };
  }

  // Highway Mid-zone Restriction
  if (box_position === "middle" && currentStage === 0) {
    // Only allow very high quality signals or probe_only if rangeConfidence is exceptionally high
    const midZoneAllowed = input.qualityScore >= 75 && rangeConfidence >= 0.85;
    if (!midZoneAllowed) {
      return {
        regime: input.regime,
        executor: "RANGE",
        entry_allowed: false,
        blocked_reason: "range_mid_zone_restricted",
        box_position,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        guidance: "중단 구역: 신규 진입 자제 (상/하단 대기)",
        detail: { score: input.qualityScore, rangeConfidence }
      };
    }
  }

  // 1차 선진입 조건 (Highway Ladder 1)
  const edgeThreshold = 0.25;
  const inInterestZone = dir === "long" ? (boxPos ?? 0) <= edgeThreshold : (boxPos ?? 1) >= (1 - edgeThreshold);

  if (currentStage === 0) {
    if (!inInterestZone && rangeConfidence < 0.85) {
      return {
        regime: input.regime,
        executor: "RANGE",
        entry_allowed: false,
        blocked_reason: "range_not_in_interest_zone",
        box_position,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        guidance: "진입 대기: 주요 구역(상/하단) 접근 필요",
        detail: { box_pos: boxPos, threshold: edgeThreshold }
      };
    }

    const floor = 35; // Stage 1 exploratory ladder floor
    if (input.qualityScore < floor) {
      return {
        regime: input.regime,
        executor: "RANGE",
        entry_allowed: false,
        blocked_reason: "range_low_quality_for_lead",
        box_position,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        guidance: "진입 대기: 반전 신호 미약",
        detail: { score: input.qualityScore, floor }
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
      guidance: `Highway Stage 1 (Confirming ${dir === "long" ? "Support" : "Resistance"})`,
      next_action: "Scaling-in on reversal confirmation",
      invalidate_condition: "Structural box break",
      entry_progress: 25,
      detail: { stage: 1, cycle: rangeCycleCount }
    };
  }

  // Highway Scaling Logic (Ladder 2 & 3)
  const scalingFloor = 65;
  if (input.qualityScore < scalingFloor) {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "range_scaling_low_quality",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      guidance: "Scaling 대기: 모멘텀 하락",
      detail: { score: input.qualityScore, floor: scalingFloor, currentStage }
    };
  }

  if (currentStage === 1) {
    const confirmedReversal = dir === "long" ? (boxPos ?? 0) > 0.30 : (boxPos ?? 1) < 0.70;
    if (confirmedReversal) {
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
        guidance: "Highway Stage 2 (Reversal Confirmed)",
        entry_progress: 60,
        detail: { stage: 2 }
      };
    }
  }

  if (currentStage === 2) {
    const finalPush = dir === "long" ? (boxPos ?? 0) > 0.45 : (boxPos ?? 1) < 0.55;
    if (finalPush) {
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
        guidance: "Highway Stage 3 (Accelerating to Median)",
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
  /** Stage 1 비용 경고 진입: 익절·시간 청산 보수화 */
  postEntryCostGuard?: boolean;
  /** 하이웨이: 횡보 확신도 */
  rangeConfidence?: number;
  /** 하이웨이: 박스 붕괴 감지 여부 (구조적 손절용) */
  boxBreakConfirmed?: boolean;
}>): RangeExitDecision {
  const boxPos = input.boxPos ?? 0.5;
  const isLong = input.side === "long";
  const atr = input.atr ?? 0;
  const rangeConfidence = input.rangeConfidence ?? 0.5;
  const boxBreakConfirmed = input.boxBreakConfirmed === true;

  // Highway Hysteresis: Confirmed RANGE mode reduces exit points
  const highwayMode = rangeConfidence >= 0.70;

  // 1. Highway Structural Stop-Loss
  if (boxBreakConfirmed) {
    return {
      executor: "RANGE",
      action: "close",
      reason: "range_box_break",
      guidance: "박스 구조 붕괴: 긴급 청산",
      exit_progress: 100,
      detail: { rangeConfidence, boxBreakConfirmed: true }
    };
  }

  // 2. Highway Noise Tolerance (Disable minor stop losses in strong RANGE)
  if (!highwayMode) {
    let stopPrice = 0;
    if (isLong) {
      stopPrice = (input.boxLow ?? 0) - 1.2 * atr;
      if (input.mark < stopPrice) {
        return {
          executor: "RANGE",
          action: "close",
          reason: "stop_loss",
          guidance: "박스 하단 이탈 (비보강 모드)",
          exit_progress: 100,
          stop_price: stopPrice,
          detail: { mark: input.mark, stopPrice }
        };
      }
    } else {
      stopPrice = (input.boxHigh ?? 0) + 1.2 * atr;
      if (input.mark > stopPrice) {
        return {
          executor: "RANGE",
          action: "close",
          reason: "stop_loss",
          guidance: "박스 상단 돌파 (비보강 모드)",
          exit_progress: 100,
          stop_price: stopPrice,
          detail: { mark: input.mark, stopPrice }
        };
      }
    }
  }

  // 3. Highway Round-Trip Take Profit (Aggressive in Zones)
  const isUpperZone = boxPos >= 0.65;
  const isLowerZone = boxPos <= 0.35;

  if (isLong && isUpperZone) {
    return {
      executor: "RANGE",
      action: "close",
      reason: "take_profit",
      guidance: "Highway Target Reached (Upper Zone)",
      exit_progress: 100,
      detail: { boxPos }
    };
  }
  if (!isLong && isLowerZone) {
    return {
      executor: "RANGE",
      action: "close",
      reason: "take_profit",
      guidance: "Highway Target Reached (Lower Zone)",
      exit_progress: 100,
      detail: { boxPos }
    };
  }

  // 4. Default Partial Exits (Legacy support for gradual profit taking)
  const t1 = 0.45;
  const t2 = 0.55;

  if (input.partialExitStage === 0) {
    const reachedTp = isLong ? boxPos >= t1 : boxPos <= t2;
    if (reachedTp) {
      return {
        executor: "RANGE",
        action: "partial_close",
        reason: "partial_exit_1",
        guidance: "Highway Milestone 1: Reaching Median",
        exit_progress: 30,
        detail: { boxPos, stage: 1 }
      };
    }
  }

  return {
    executor: "RANGE",
    action: "hold",
    reason: null,
    guidance: "박스 내 왕복 진행 중 (Highway)",
    exit_progress: isLong ? boxPos * 100 : (1 - boxPos) * 100,
    detail: { boxPos, highwayMode }
  };
}
