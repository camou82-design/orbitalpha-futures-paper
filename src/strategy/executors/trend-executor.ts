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
  /** ?       ?       ?       ?       (?         ?0) */
  currentStage?: number;
} & Record<string, unknown>>): TrendEntryDecision {
  const dir = intentDirection(input.signal);
  const e20 = input.ema20;
  const e60 = input.ema60;

  const hasBox = input.boxHigh !== null && input.boxLow !== null && input.boxHigh > input.boxLow;
  const breakoutUp = hasBox ? input.lastPrice >= (input.boxHigh as number) * 1.0006 : null;
  const breakoutDown = hasBox ? input.lastPrice <= (input.boxLow as number) * 0.9994 : null;
  const breakout_state =
    breakoutUp === null || breakoutDown === null ? "none" : breakoutUp ? "breakout_up" : breakoutDown ? "breakout_down" : "none";

  const pullbackLong = e20 !== null ? input.lastPrice <= e20 * 1.006 && input.lastPrice >= e20 * 0.994 : null;
  const pullbackShort = e20 !== null ? input.lastPrice >= e20 * 0.994 && input.lastPrice <= e20 * 1.006 : null;
  const pullback_state =
    pullbackLong === null || pullbackShort === null
      ? "none"
      : dir === "long"
        ? pullbackLong
          ? "pullback_ok"
          : "pullback_bad"
        : dir === "short"
          ? pullbackShort
            ? "pullback_ok"
            : "pullback_bad"
          : "none";

  if (input.regime !== "TREND" && (input.currentStage ?? 0) !== 0) {
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

  if (input.qualityScore < 50) {
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
      detail: { score: input.qualityScore, floor: 50 }
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
  const minVol = input.currentStage === 0 ? 1.02 : 1.05; // Slightly loosen Stage 1 volume ratio
  if (input.volumeRatioProxy < minVol) {
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
      detail: { volume_ratio_proxy: input.volumeRatioProxy, min: minVol }
    };
  }

  const breakoutOk =
    dir === "long" ? breakout_state === "breakout_up" : dir === "short" ? breakout_state === "breakout_down" : false;
  const pullbackOk = pullback_state === "pullback_ok";

  const currentStage = input.currentStage ?? 0;

  //      ?                      ?      
  let guidance = "";
  if (dir === "long") {
    if (pullback_state === "pullback_ok") guidance = "FIXED_CORRUPTED_STRING";
    else guidance = "FIXED_CORRUPTED_STRING";
  } else if (dir === "short") {
    if (pullback_state === "pullback_ok") guidance = "FIXED_CORRUPTED_STRING";
    else guidance = "FIXED_CORRUPTED_STRING";
  }

  if (currentStage === 0) {
    // 1   ??      ?? EMA20 ?       ?       OR             ??       ?      
    const canBreakoutRaw = breakoutOk && input.qualityScore > 60; // Allow breakout if high quality

    if (!pullbackOk && !canBreakoutRaw) {
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
        detail: { pullback_state, breakout_state, score: input.qualityScore }
      };
    }

    //           ?       ?       (Stage 1: 48???      ?             ? ?      )
    const floor = 48;
    if (input.qualityScore < floor) {
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
        guidance: "FIXED_CORRUPTED_STRING",
        detail: { score: input.qualityScore, floor }
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
      guidance: canBreakoutRaw ? "breakout_follow_guidance" : "pullback_retest_guidance",
      next_action: "WAIT_FOR_PULLBACK_RETEST",
      invalidate_condition: dir === "long" ? "EMA20_BREAKDOWN" : "EMA20_BREAKOUT",
      risk_note: input.volumeRatioProxy < 1.1 ? "volume_below_typical" : "volume_ok",
      watch_zone: "ema_pullback_band",
      entry_progress: 30,
      detail: { direction: dir, pullbackOk, breakoutOk: canBreakoutRaw, stage: 1 }
    };
  }

  // 2   ?3   ?      ?                    (?             ? 68???      ?                )
  if (input.qualityScore < 68) {
    return {
      regime: input.regime,
      executor: "TREND",
      entry_allowed: false,
      blocked_reason: "trend_scaling_low_quality",
      breakout_state,
      pullback_state,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      guidance: "FIXED_CORRUPTED_STRING",
      detail: { score: input.qualityScore, floor: 68, currentStage }
    };
  }

  // 2   ?3   ?      ?         
  if (currentStage === 1) {
    // 2   ? EMA20          /?     ???       (Price moving away from e20 in favorable direction)
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
        guidance: "FIXED_CORRUPTED_STRING",
        next_action: "FIXED_CORRUPTED_STRING",
        invalidate_condition: "FIXED_CORRUPTED_STRING",
        entry_progress: 60,
        detail: { stage: 2 }
      };
    }
  }

  if (currentStage === 2) {
    // 3   ? ?      ???   ????       (breakoutOk)
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
        guidance: "FIXED_CORRUPTED_STRING",
        next_action: "FIXED_CORRUPTED_STRING",
        invalidate_condition: "FIXED_CORRUPTED_STRING",
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
    guidance: "FIXED_CORRUPTED_STRING",
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
  postEntryCostGuard?: boolean;
}>): TrendExitDecision {
  const isLong = input.side === "long";
  const atr = input.atr ?? 0;
  const cg = input.postEntryCostGuard === true;
  const p1 = cg ? 0.005 : 0.008;
  const p2 = cg ? 0.012 : 0.016;
  const maxHoldCostGuardMs = 50 * 60 * 1000;
  const rr = input.pnlPctNet / (atr / input.entryPrice + 1e-9); // Approx RR based on ATR unit

  // 1. ?                 (      ?           1.5 ATR ?      )
  let stopPrice = 0;
  if (isLong) {
    stopPrice = input.entryPrice - 1.5 * atr;
    if (input.mark < stopPrice) {
      return {
        executor: "TREND",
        action: "close",
        reason: "stop_loss",
        guidance: "FIXED_CORRUPTED_STRING",
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
        guidance: "FIXED_CORRUPTED_STRING",
        exit_progress: 100,
        stop_price: stopPrice,
        detail: { mark: input.mark, stopPrice }
      };
    }
  }

  if (cg && input.holdingMs >= maxHoldCostGuardMs) {
    return {
      executor: "TREND",
      action: "close",
      reason: "time_based_exit",
      guidance: "FIXED_CORRUPTED_STRING",
      exit_progress: 100,
      detail: { holdingMs: input.holdingMs, postEntryCostGuard: true }
    };
  }

  // 2. ?                 (RR                    )
  // Stage 0 -> 1: RR 1.0 (ATR 1   ??      )
  if (input.partialExitStage === 0) {
    if (input.pnlPctNet >= p1) {
      return {
        executor: "TREND",
        action: "partial_close",
        reason: "partial_exit_1",
        guidance: "FIXED_CORRUPTED_STRING",
        next_action: "FIXED_CORRUPTED_STRING",
        exit_progress: 30,
        detail: { pnl: input.pnlPctNet, stage: 1 }
      };
    }
  }

  // Stage 1 -> 2: RR 2.0 (ATR 2   ??      )
  if (input.partialExitStage === 1) {
    if (input.pnlPctNet >= p2) {
      return {
        executor: "TREND",
        action: "partial_close",
        reason: "partial_exit_2",
        guidance: "FIXED_CORRUPTED_STRING",
        next_action: "FIXED_CORRUPTED_STRING",
        exit_progress: 70,
        detail: { pnl: input.pnlPctNet, stage: 2 }
      };
    }
  }

  // 3. ?      ?       ?       (ATR          )
  if (input.partialExitStage >= 1) {
    const extreme = input.trailingExtreme ?? input.mark;
    const trailBuffer = 1.2 * atr;
    const trailLevel = isLong ? extreme - trailBuffer : extreme + trailBuffer;

    const hitTrailing = isLong ? input.mark <= trailLevel : input.mark >= trailLevel;
    if (hitTrailing && input.pnlPctNet >= 0.005) { //           ?       ?      
      return {
        executor: "TREND",
        action: "close",
        reason: "trailing_stop",
        guidance: "FIXED_CORRUPTED_STRING",
        exit_progress: 100,
        detail: { mark: input.mark, trailLevel }
      };
    }
  }

  //           ?   ?
  return {
    executor: "TREND",
    action: "hold",
    reason: null,
    guidance:
      input.partialExitStage === 0 ? "hold_primary_tp_watch" : "scale_out_progress_watch",
    next_action:
      input.partialExitStage === 0 ? "WAIT_FOR_PARTIAL_TP_TRIGGER" : "MANAGE_TRAILING_OR_TP",
    exit_progress: input.partialExitStage === 0 ? 15 : input.partialExitStage === 1 ? 55 : 85,
    stop_price: stopPrice,
    detail: { pnl: input.pnlPctNet, partialExitStage: input.partialExitStage }
  };
}

