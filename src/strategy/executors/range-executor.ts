import type { PaperSignal } from "../entry-signal";
import type { MarketRegime } from "../market-regime-detector";
import type { RangeEntryDecision, RiskState } from "./types";

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
  cooldownActive: boolean;
  cooldownRemainingMs: number;
}>): RangeEntryDecision {
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

  // Range should be selective: require decent quality.
  if (input.qualityScore < 70) {
    return {
      regime: input.regime,
      executor: "RANGE",
      entry_allowed: false,
      blocked_reason: "range_low_quality",
      box_position,
      expected_move: input.expectedMove,
      total_cost: input.totalCost,
      risk_state: input.risk_state,
      detail: { score: input.qualityScore, floor: 70 }
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
    detail: { direction: dir, box_pos: boxPos, box_rel: boxRel }
  };
}

