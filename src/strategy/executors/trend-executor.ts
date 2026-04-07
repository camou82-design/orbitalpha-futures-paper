import type { PaperSignal } from "../entry-signal";
import type { MarketRegime } from "../market-regime-detector";
import type { RiskState, TrendEntryDecision } from "./types";

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
  cooldownActive: boolean;
  cooldownRemainingMs: number;
}>): TrendEntryDecision {
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
  if (!(breakoutOk || pullbackOk)) {
    return {
      regime: input.regime,
      executor: "TREND",
      entry_allowed: false,
      blocked_reason: "trend_need_breakout_or_pullback",
      breakout_state,
      pullback_state,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { breakoutOk, pullbackOk }
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
    detail: { direction: dir, breakoutOk, pullbackOk }
  };
}

