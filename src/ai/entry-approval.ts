import type { MarketRegime } from "../strategy/market-regime-detector";
import type { AnyEntryDecision } from "../strategy/executors/types";

export type AiApprovalAction = "ENTER_LONG" | "ENTER_SHORT" | "NO_ENTRY";

export type AiApprovalOutput = Readonly<{
  action: AiApprovalAction;
  reason: string;
  confidence: number; // 0..1
}>;

export type AiApprovalInput = Readonly<{
  regime: MarketRegime;
  executor: "RANGE" | "TREND";
  /** Direction proposed by the executor (derived from signal). AI must not change this. */
  executor_direction: "long" | "short";
  expected_move: number | null;
  total_cost: number | null;
  box_position?: "upper" | "lower" | "middle" | "unknown";
  breakout_state?: "breakout_up" | "breakout_down" | "none" | "unknown";
  pullback_state?: "pullback_ok" | "pullback_bad" | "unknown";
  loss_streak: number;
  last_10_net: number;
  risk_state: "NORMAL" | "LIMITED" | "BLOCKED";
}>;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * AI approval layer (deterministic, conservative).
 *
 * This does NOT change strategy logic; it only approves/denies an entry at the very end.
 * Rule: ambiguous => NO_ENTRY.
 */
export function aiApproveEntry(input: AiApprovalInput): AiApprovalOutput {
  const em = input.expected_move;
  const tc = input.total_cost;

  // Hard NOs (must NO_ENTRY).
  if (input.risk_state === "BLOCKED") return { action: "NO_ENTRY", reason: "리스크 차단", confidence: 0.99 };

  if (typeof em === "number" && typeof tc === "number") {
    if (!Number.isFinite(em) || !Number.isFinite(tc) || em <= tc) {
      return { action: "NO_ENTRY", reason: "비용 우위 부족", confidence: 0.99 };
    }
  } else {
    // Missing cost/move => ambiguous => deny.
    return { action: "NO_ENTRY", reason: "비용/기대움직임 불명확", confidence: 0.9 };
  }

  if (input.executor === "RANGE") {
    if (input.box_position === "middle") {
      return { action: "NO_ENTRY", reason: "박스 중앙", confidence: 0.99 };
    }
  }

  if (input.executor === "TREND") {
    const bs = input.breakout_state ?? "unknown";
    const ps = input.pullback_state ?? "unknown";
    if (bs === "unknown" || ps === "unknown") {
      return { action: "NO_ENTRY", reason: "추세 상태 불명확", confidence: 0.88 };
    }
    if (bs === "none" && ps !== "pullback_ok") {
      return { action: "NO_ENTRY", reason: "추세 약화", confidence: 0.92 };
    }
  }

  // Loss-flow deterioration => conservative NO.
  if (input.loss_streak >= 2) {
    return { action: "NO_ENTRY", reason: "손실 흐름 악화", confidence: 0.92 };
  }
  if (input.last_10_net < -8) {
    return { action: "NO_ENTRY", reason: "최근 성과 악화", confidence: 0.9 };
  }
  if (input.risk_state === "LIMITED" && input.last_10_net < 0) {
    return { action: "NO_ENTRY", reason: "리스크 제한", confidence: 0.85 };
  }

  // Cost edge must be meaningful; otherwise deny.
  const edge = em - tc;
  const edgeScore = clamp01((edge - 0.00025) / 0.0015);
  if (edgeScore < 0.25) {
    return { action: "NO_ENTRY", reason: "비용 우위 부족", confidence: 0.8 };
  }

  // Approve ONLY in executor's proposed direction (AI must not propose a new direction).
  return {
    action: input.executor_direction === "long" ? "ENTER_LONG" : "ENTER_SHORT",
    reason: "조건 충족",
    confidence: 0.65
  };
}

export function aiInputFromDecision(input: Readonly<{
  decision: AnyEntryDecision;
  executorDirection: "long" | "short";
  lossStreak: number;
  last10Net: number;
}>): AiApprovalInput | null {
  if (input.decision.executor !== "RANGE" && input.decision.executor !== "TREND") return null;
  const base: Omit<AiApprovalInput, "box_position" | "breakout_state" | "pullback_state"> = {
    regime: input.decision.regime,
    executor: input.decision.executor,
    executor_direction: input.executorDirection,
    expected_move: input.decision.expected_move,
    total_cost: input.decision.total_cost,
    loss_streak: input.lossStreak,
    last_10_net: input.last10Net,
    risk_state: input.decision.risk_state
  };
  if (input.decision.executor === "RANGE") {
    return { ...base, box_position: input.decision.box_position };
  }
  return {
    ...base,
    breakout_state: input.decision.breakout_state,
    pullback_state: input.decision.pullback_state
  };
}

