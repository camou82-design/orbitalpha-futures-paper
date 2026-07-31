import type { PaperSignal } from "../entry-signal";
import type { MarketRegime } from "../market-regime-detector";
import type { RangeEntryDecision, RangeExitDecision, RiskState } from "./types";
import { classifyRangeZone } from "../../models/types";

function intentDirection(signal: PaperSignal): "long" | "short" | null {
  if (signal === "paper_long_candidate") return "long";
  if (signal === "paper_short_candidate") return "short";
  return null;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function rangeExecutorEvaluateEntry(input: Readonly<{
  regime: MarketRegime;
  risk_state: RiskState;
  symbol: string;
  signal: PaperSignal;
  qualityScore: number;
  boxPos: number | null;
  boxRel: number | null;
  boxHigh: number | null;
  boxLow: number | null;
  boxMid: number | null;
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
  rangeCycleCount?: number;
  boxBreakConfirmed?: boolean;

  // --- V2 Hardening Additions ---
  shockPhase?: string;
  trendPhase?: string;
  emaGap?: number;
  reversalConfirmed?: boolean;
  isDistorted?: boolean;
  isDrifting?: boolean;
  distortionFactor?: number;
  bhSlope?: number;
  blSlope?: number;
} & Record<string, unknown>>): RangeEntryDecision & { 
    takeProfitPlan?: any; 
    takeProfit1Px?: number; 
    takeProfit2Px?: number; 
    partialExitRatio?: number; 
    invalidationPx?: number;
    rangeBoxHighAtEntry?: number;
    rangeBoxLowAtEntry?: number;
    rangeBoxMidAtEntry?: number;
    rangeBoxQuality?: number;
    rangeBoxSlope?: number;
    rangeBoxDistorted?: boolean;
} {
  const dir = intentDirection(input.signal);
  const boxPos = input.boxPos;
  const boxRel = input.boxRel;
  const currentStage = input.currentStage ?? 0;
  const rangeCycleCount = input.rangeCycleCount ?? 0;
  const rangeConfidence = input.rangeConfidence ?? 0.5;
  const shockPhase = input.shockPhase ?? "NONE";
  const trendPhase = input.trendPhase ?? "NONE";
  const emaGap = input.emaGap ?? 0;
  const reversalConfirmed = input.reversalConfirmed === true;
  const isDistorted = input.isDistorted === true;
  const isDrifting = input.isDrifting === true;

  const box_position = classifyRangeZone(boxPos);

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

  // --- BOX QUALITY GUARD ---
  if ((isDistorted || isDrifting) && currentStage === 0) {
    console.warn(JSON.stringify({
        event: "V2_RANGE_MEAN_REVERSION_DISABLED_BY_BOX_DISTORTION_PROOF",
        symbol: input.symbol,
        isDistorted,
        isDrifting,
        distortionFactor: input.distortionFactor
    }));
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "range_box_distorted",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      guidance: "박스 품질 불량: 평균회귀 신뢰도 부족으로 진입 차단",
      detail: { isDistorted, isDrifting, distortionFactor: input.distortionFactor }
    };
  }

  // --- SHOCK & TREND GUARD ---
  if (dir === "long" && box_position === "lower" && currentStage === 0) {
    if (shockPhase === "DOWN_SHOCK") {
        console.warn(JSON.stringify({
            event: "V2_RANGE_LOWER_LONG_BLOCKED_BY_DOWN_SHOCK_PROOF",
            symbol: input.symbol,
            shockPhase,
            trendPhase,
            emaGap,
            reversalConfirmed
        }));
        return {
            regime: input.regime,
            executor: "RANGE",
            entry_allowed: false,
            blocked_reason: "V2_RANGE_LOWER_LONG_BLOCKED_BY_DOWN_SHOCK",
            box_position,
            expected_move: input.expectedMove,
            total_cost: input.totalCost,
            risk_state: input.risk_state,
            guidance: "하락 쇼크 중 하단 롱 차단",
            detail: { shockPhase, trendPhase, emaGap }
        };
    } else if (trendPhase === "DOWN" || emaGap < 0) {
        if (!reversalConfirmed) {
            console.warn(JSON.stringify({
                event: "V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND_PROOF",
                symbol: input.symbol,
                shockPhase,
                trendPhase,
                emaGap,
                reversalConfirmed
            }));
            return {
                regime: input.regime,
                executor: "RANGE",
                entry_allowed: false,
                blocked_reason: "V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND",
                box_position,
                expected_move: input.expectedMove,
                total_cost: input.totalCost,
                risk_state: input.risk_state,
                guidance: "하락 추세 중 하단 롱 관망 (반전 미확인)",
                detail: { shockPhase, trendPhase, emaGap, reversalConfirmed }
            };
        }
    }
  }

  if (dir === "short" && box_position === "upper" && currentStage === 0) {
    if (shockPhase === "UP_SHOCK") {
        console.warn(JSON.stringify({
            event: "V2_RANGE_UPPER_SHORT_BLOCKED_BY_UP_SHOCK_PROOF",
            symbol: input.symbol,
            shockPhase,
            trendPhase,
            emaGap,
            reversalConfirmed
        }));
        return {
            regime: input.regime,
            executor: "RANGE",
            entry_allowed: false,
            blocked_reason: "V2_RANGE_UPPER_SHORT_BLOCKED_BY_UP_SHOCK",
            box_position,
            expected_move: input.expectedMove,
            total_cost: input.totalCost,
            risk_state: input.risk_state,
            guidance: "상승 쇼크 중 상단 숏 차단",
            detail: { shockPhase, trendPhase, emaGap }
        };
    } else if (trendPhase === "UP" || emaGap > 0) {
        if (!reversalConfirmed) {
            console.warn(JSON.stringify({
                event: "V2_RANGE_UPPER_SHORT_WAITING_DUE_TO_UP_TREND_PROOF",
                symbol: input.symbol,
                shockPhase,
                trendPhase,
                emaGap,
                reversalConfirmed
            }));
            return {
                regime: input.regime,
                executor: "RANGE",
                entry_allowed: false,
                blocked_reason: "V2_RANGE_UPPER_SHORT_WAITING_DUE_TO_UP_TREND",
                box_position,
                expected_move: input.expectedMove,
                total_cost: input.totalCost,
                risk_state: input.risk_state,
                guidance: "상승 추세 중 상단 숏 관망 (반전 미확인)",
                detail: { shockPhase, trendPhase, emaGap, reversalConfirmed }
            };
        }
    }
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
  const minBoxWidth = 0.0035;
  if (boxRel < minBoxWidth) {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "range_box_too_narrow",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { box_rel: boxRel, min: minBoxWidth }
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
  if (box_position === "mid" && currentStage === 0) {
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

  // --- EXIT PLAN GENERATION (Mandatory for RANGE) ---
  const boxHigh = input.boxHigh ?? 0;
  const boxLow = input.boxLow ?? 0;
  const boxMid = input.boxMid ?? (boxHigh + boxLow) / 2;
  const atr = input.atr ?? 0;

  let tp1 = 0;
  let tp2 = 0;
  let inv = 0;

  if (dir === "long") {
    tp1 = boxMid;
    tp2 = boxHigh * 0.998;
    inv = boxLow - Math.max(atr * 0.5, boxLow * 0.0015);
  } else {
    tp1 = boxMid;
    tp2 = boxLow * 1.002;
    inv = boxHigh + Math.max(atr * 0.5, boxHigh * 0.0015);
  }

  const takeProfitPlan = {
    tp1,
    tp2,
    invalidation: inv,
    partialRatio: 0.5,
    version: "v2_range_fixed_plan_v1"
  };

  console.info(JSON.stringify({
    event: "V2_RANGE_TAKE_PROFIT_PLAN_PROOF",
    symbol: input.symbol,
    side: dir,
    tp1,
    tp2,
    invalidation: inv,
    boxMid,
    boxHigh,
    boxLow
  }));

  // 1차 탐색 진입 (Highway Probe - Ladder 1)
  const probeEdgeThreshold = 0.30;
  const inProbeZone = dir === "long" ? (boxPos ?? 0) <= probeEdgeThreshold : (boxPos ?? 1) >= (1 - probeEdgeThreshold);

  if (currentStage === 0) {
    if (!inProbeZone && rangeConfidence < 0.88) {
      return {
        regime: input.regime,
        executor: "RANGE",
        entry_allowed: false,
        blocked_reason: "range_not_in_probe_zone",
        box_position,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        guidance: "진입 대기: 주요 구역(상/하단) 외곽 접근 대기",
        detail: { box_pos: boxPos, threshold: probeEdgeThreshold }
      };
    }

    const probeFloor = 35;
    if (input.qualityScore < probeFloor) {
      return {
        regime: input.regime,
        executor: "RANGE",
        entry_allowed: false,
        blocked_reason: "range_low_quality_for_probe",
        box_position,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        guidance: "진입 대기: 탐색 신호 미달",
        detail: { score: input.qualityScore, floor: probeFloor }
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
      entryIntentType: "probe",
      entryConfirmationState: "unconfirmed",
      guidance: `Highway Stage 1 (Probe ${dir === "long" ? "Support" : "Resistance"})`,
      entry_progress: 20,
      detail: { stage: 1, cycle: rangeCycleCount },
      takeProfitPlan,
      takeProfit1Px: tp1,
      takeProfit2Px: tp2,
      partialExitRatio: 0.5,
      invalidationPx: inv,
      rangeBoxHighAtEntry: boxHigh,
      rangeBoxLowAtEntry: boxLow,
      rangeBoxMidAtEntry: boxMid,
      rangeBoxQuality: input.qualityScore,
      rangeBoxSlope: input.rcSlope as number,
      rangeBoxDistorted: isDistorted
    };
  }

  // Highway Reaction & Standard (Ladder 2)
  const standardFloor = 60;

  // Cycle Fatigue: Reduce priority as cycle count grows
  const fatigueFactor = clamp01((5 - rangeCycleCount) / 4); // 5 cycles = hard limit
  const cycleBlocked = rangeCycleCount >= 5;

  if (currentStage === 1) {
    if (cycleBlocked) {
      return {
        regime: input.regime,
        executor: "RANGE",
        entry_allowed: false,
        blocked_reason: "range_cycle_fatigue",
        box_position,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        guidance: "사이클 피로도 누적: 박스 이탈 가능성 대비 관망",
        detail: { cycle: rangeCycleCount }
      };
    }
    // Reaction check: slight bounce away from edge
    const reactionConfirmed = dir === "long" ? (boxPos ?? 0) > 0.15 : (boxPos ?? 1) < 0.85;
    if (input.qualityScore >= standardFloor && reactionConfirmed) {
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
        entryIntentType: "standard",
        entryConfirmationState: "reacting",
        scalingPermission: true,
        guidance: "Highway Stage 2 (Standard - Reaction Confirmed)",
        entry_progress: 55,
        detail: { stage: 2 },
        takeProfitPlan,
        takeProfit1Px: tp1,
        takeProfit2Px: tp2,
        partialExitRatio: 0.5,
        invalidationPx: inv,
        rangeBoxHighAtEntry: boxHigh,
        rangeBoxLowAtEntry: boxLow,
        rangeBoxMidAtEntry: boxMid,
        rangeBoxQuality: input.qualityScore,
        rangeBoxSlope: input.rcSlope as number,
        rangeBoxDistorted: isDistorted
      };
    } else {
      return {
        regime: input.regime,
        executor: "RANGE",
        entry_allowed: false,
        blocked_reason: reactionConfirmed ? "standard_score_insufficient" : "waiting_reversal_reaction",
        box_position,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        guidance: reactionConfirmed ? "표준 진입 점수 대기" : "단기 반전 반응 확인 중",
        detail: { score: input.qualityScore, boxPos, currentStage }
      };
    }
  }

  // Highway Acceleration & Scale (Ladder 3)
  if (currentStage === 2) {
    const momentumAccelerating = dir === "long" ? (boxPos ?? 0) > 0.40 : (boxPos ?? 1) < 0.60;
    if (input.qualityScore >= 75 && momentumAccelerating) {
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
        entryIntentType: "scale",
        entryConfirmationState: "confirmed",
        guidance: "Highway Stage 3 (Scale - Acceleration towards Median)",
        entry_progress: 100,
        detail: { stage: 3 },
        takeProfitPlan,
        takeProfit1Px: tp1,
        takeProfit2Px: tp2,
        partialExitRatio: 0.5,
        invalidationPx: inv,
        rangeBoxHighAtEntry: boxHigh,
        rangeBoxLowAtEntry: boxLow,
        rangeBoxMidAtEntry: boxMid,
        rangeBoxQuality: input.qualityScore,
        rangeBoxSlope: input.rcSlope as number,
        rangeBoxDistorted: isDistorted
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
    detail: { currentStage, boxPos, fatigueFactor }
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
  const PROTECTION_MS = 75_000;
  const protectionRemainingMs = Math.max(0, PROTECTION_MS - input.holdingMs);
  const protectionApplied = protectionRemainingMs > 0;
  const minProfitAfterCostPct = 0.0012;
  const minProfitAfterCostOk = input.pnlPctNet >= minProfitAfterCostPct;
  const midTargetHit = isLong ? boxPos >= 0.5 : boxPos <= 0.5;
  const farTargetHit = isLong ? boxPos >= 0.8 : boxPos <= 0.2;
  const baseDetail = {
    range_exit_protection_applied: protectionApplied,
    range_exit_protection_remaining_ms: protectionRemainingMs,
    range_exit_box_break_confirmed: boxBreakConfirmed,
    range_exit_mid_target_hit: midTargetHit,
    range_exit_far_target_hit: farTargetHit,
    range_exit_min_profit_after_cost_ok: minProfitAfterCostOk
  };

  if (boxBreakConfirmed) {
    return {
      executor: "RANGE",
      action: "close",
      reason: "range_box_break",
      guidance: "박스 구조 훼손 확정 청산",
      exit_progress: 100,
      detail: {
        ...baseDetail,
        range_exit_mode: "box_break_exit",
        range_exit_reason_detail: "box_break_confirmed"
      }
    };
  }

  // Avoid immediate noise exits right after entry unless structural break is confirmed.
  if (protectionApplied) {
    return {
      executor: "RANGE",
      action: "hold",
      reason: null,
      guidance: "RANGE 초기 보호구간 유지",
      exit_progress: isLong ? boxPos * 100 : (1 - boxPos) * 100,
      detail: {
        ...baseDetail,
        range_exit_mode: "noise_hold",
        range_exit_reason_detail: "entry_protection_window_active"
      }
    };
  }

  // Structural stop only when box boundary is clearly violated.
  if (isLong) {
    const breakLevel = (input.boxLow ?? input.mark) - Math.max(atr * 0.35, input.mark * 0.0009);
    if (input.mark < breakLevel) {
      return {
        executor: "RANGE",
        action: "close",
        reason: "stop_loss",
        guidance: "박스 하단 구조 이탈 청산",
        stop_price: breakLevel,
        exit_progress: 100,
        detail: {
          ...baseDetail,
          range_exit_mode: "box_break_exit",
          range_exit_reason_detail: "long_structure_break_below_box_low"
        }
      };
    }
  } else {
    const breakLevel = (input.boxHigh ?? input.mark) + Math.max(atr * 0.35, input.mark * 0.0009);
    if (input.mark > breakLevel) {
      return {
        executor: "RANGE",
        action: "close",
        reason: "stop_loss",
        guidance: "박스 상단 구조 이탈 청산",
        stop_price: breakLevel,
        exit_progress: 100,
        detail: {
          ...baseDetail,
          range_exit_mode: "box_break_exit",
          range_exit_reason_detail: "short_structure_break_above_box_high"
        }
      };
    }
  }

  // Partial on median, full near opposite edge only if net profitability is sufficient.
  if (input.partialExitStage === 0 && midTargetHit && minProfitAfterCostOk) {
    return {
      executor: "RANGE",
      action: "partial_close",
      reason: "partial_exit_1",
      guidance: "RANGE 중간 목표 1차 청산",
      exit_progress: 45,
      detail: {
        ...baseDetail,
        range_exit_mode: "tp_partial",
        range_exit_reason_detail: "mid_target_hit"
      }
    };
  }

  if (farTargetHit && minProfitAfterCostOk) {
    return {
      executor: "RANGE",
      action: "close",
      reason: "take_profit",
      guidance: "RANGE 반대편 목표 도달 청산",
      exit_progress: 100,
      detail: {
        ...baseDetail,
        range_exit_mode: "tp_full",
        range_exit_reason_detail: "far_target_hit"
      }
    };
  }

  if (input.holdingMs >= 30 * 60_000 && !midTargetHit && !farTargetHit) {
    return {
      executor: "RANGE",
      action: "close",
      reason: "time_based_exit",
      guidance: "RANGE 시간 소모/맥락 약화 청산",
      exit_progress: 100,
      detail: {
        ...baseDetail,
        range_exit_mode: "time_decay_exit",
        range_exit_reason_detail: "time_decay_without_target_progress"
      }
    };
  }

  return {
    executor: "RANGE",
    action: "hold",
    reason: null,
    guidance: "박스 구조 유지: 노이즈 보유",
    exit_progress: isLong ? boxPos * 100 : (1 - boxPos) * 100,
    detail: {
      ...baseDetail,
      range_exit_mode: "noise_hold",
      range_exit_reason_detail: "box_structure_intact"
    }
  };
}
