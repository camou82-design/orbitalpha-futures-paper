import type { MarketRegime } from "../strategy/market-regime-detector";
import type { AnyEntryDecision } from "../strategy/executors/types";

export type AiApprovalAction = "ENTER_LONG" | "ENTER_SHORT" | "NO_ENTRY";

export type AiCostGateMode = "hard_block" | "soft_penalty" | "bypass_due_to_regime_first" | "neutral";

export type AiGateTrace = Readonly<{
  regime: MarketRegime;
  executor: "RANGE" | "TREND";
  /** Rules applied: regime-first (RANGE/TREND lane), else executor fallback. */
  gate_mode: "RANGE" | "TREND";
  expected_move: number | null;
  total_cost: number | null;
  edge: number | null;
  edgeScore: number | null;
  cost_gate_applied: boolean;
  cost_gate_mode: AiCostGateMode;
}>;

export type AiApprovalOutput = Readonly<{
  action: AiApprovalAction;
  reason: string;
  confidence: number; // 0..1
  /** Set on every outcome so logs can correlate regime vs executor vs applied rule set. */
  ai_gate_trace?: AiGateTrace;
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

function costTraceHard(
  input: AiApprovalInput,
  gate_mode: "RANGE" | "TREND",
  cost_gate_mode: AiCostGateMode
): AiGateTrace {
  return {
    regime: input.regime,
    executor: input.executor,
    gate_mode,
    expected_move: input.expected_move,
    total_cost: input.total_cost,
    edge: null,
    edgeScore: null,
    cost_gate_applied: true,
    cost_gate_mode
  };
}

function costTraceSoft(
  input: AiApprovalInput,
  gate_mode: "RANGE" | "TREND",
  em: number,
  tc: number,
  edge: number,
  edgeScore: number,
  cost_gate_mode: AiCostGateMode
): AiGateTrace {
  return {
    regime: input.regime,
    executor: input.executor,
    gate_mode,
    expected_move: em,
    total_cost: tc,
    edge,
    edgeScore,
    cost_gate_applied: true,
    cost_gate_mode
  };
}

/**
 * AI approval layer (deterministic, conservative).
 *
 * This does NOT change strategy logic; it only approves/denies an entry at the very end.
 * Rule: ambiguous => NO_ENTRY.
 *
 * Cost: upper market lane (regime) is authoritative — raw em vs tc is not a duplicate hard veto
 * after executor/authority already advanced the candidate (units may differ).
 */
export function aiApproveEntry(input: AiApprovalInput): AiApprovalOutput {
  const gate_mode: "RANGE" | "TREND" =
    input.regime === "RANGE" ? "RANGE" : input.regime === "TREND" ? "TREND" : input.executor;

  const em = input.expected_move;
  const tc = input.total_cost;

  const attach = (o: Pick<AiApprovalOutput, "action" | "reason" | "confidence">, trace: AiGateTrace): AiApprovalOutput => ({
    ...o,
    ai_gate_trace: trace
  });

  // Hard NOs (must NO_ENTRY).
  if (input.risk_state === "BLOCKED") {
    return attach(
      { action: "NO_ENTRY", reason: "리스크 차단", confidence: 0.99 },
      costTraceHard(input, gate_mode, "hard_block")
    );
  }

  if (typeof em !== "number" || typeof tc !== "number" || !Number.isFinite(em) || !Number.isFinite(tc)) {
    return attach(
      { action: "NO_ENTRY", reason: "비용/기대움직임 불명확", confidence: 0.9 },
      costTraceHard(input, gate_mode, "hard_block")
    );
  }

  const edge = em - tc;
  const edgeScore = clamp01((edge - 0.00025) / 0.0015);

  let cost_gate_mode: AiCostGateMode = "neutral";
  let costPenalty = 1.0;

  if (gate_mode === "RANGE") {
    if (em <= tc || edgeScore < 0.25) {
      cost_gate_mode = "bypass_due_to_regime_first";
      costPenalty = 0.72 + 0.28 * Math.max(edgeScore, 0.08);
    }
  } else {
    if (em <= tc || edgeScore < 0.25) {
      cost_gate_mode = "soft_penalty";
      costPenalty = 0.52 + 0.48 * Math.max(edgeScore, 0.12);
    }
  }

  const costTrace = costTraceSoft(input, gate_mode, em, tc, edge, edgeScore, cost_gate_mode);

  if (gate_mode === "RANGE") {
    if (input.box_position === "middle") {
      return attach({ action: "NO_ENTRY", reason: "박스 중앙", confidence: 0.99 }, costTrace);
    }
  }

  if (gate_mode === "TREND") {
    const bs = input.breakout_state ?? "unknown";
    const ps = input.pullback_state ?? "unknown";
    if (bs === "unknown" || ps === "unknown") {
      return attach({ action: "NO_ENTRY", reason: "추세 상태 불명확", confidence: 0.88 }, costTrace);
    }
    if (bs === "none" && ps !== "pullback_ok") {
      return attach({ action: "NO_ENTRY", reason: "추세 약화", confidence: 0.92 }, costTrace);
    }
  }

  // Loss-flow deterioration => conservative NO.
  if (input.loss_streak >= 2) {
    return attach({ action: "NO_ENTRY", reason: "손실 흐름 악화", confidence: 0.92 }, costTrace);
  }
  if (input.last_10_net < -8) {
    return attach({ action: "NO_ENTRY", reason: "최근 성과 악화", confidence: 0.9 }, costTrace);
  }
  if (input.risk_state === "LIMITED" && input.last_10_net < 0) {
    return attach({ action: "NO_ENTRY", reason: "리스크 제한", confidence: 0.85 }, costTrace);
  }

  let confidence = 0.65 * costPenalty;
  confidence = clamp01(confidence);

  if (gate_mode === "TREND" && confidence < 0.4) {
    return attach({ action: "NO_ENTRY", reason: "비용 우위 부족", confidence: clamp01(confidence) }, costTrace);
  }

  const reason =
    cost_gate_mode === "bypass_due_to_regime_first" || cost_gate_mode === "soft_penalty"
      ? "조건 충족 (비용 edge 보조)"
      : "조건 충족";

  return attach(
    {
      action: input.executor_direction === "long" ? "ENTER_LONG" : "ENTER_SHORT",
      reason,
      confidence
    },
    costTrace
  );
}

export function aiInputFromDecision(
  input: Readonly<{
    decision: AnyEntryDecision;
    executorDirection: "long" | "short";
    lossStreak: number;
    last10Net: number;
    /** Upper market lane (e.g. lastEffectiveLane); overrides decision.regime for AI gating. */
    effectiveRegime?: MarketRegime;
  }>
): AiApprovalInput | null {
  if (input.decision.executor !== "RANGE" && input.decision.executor !== "TREND") return null;
  const regime: MarketRegime = input.effectiveRegime ?? input.decision.regime;
  const base: Omit<AiApprovalInput, "box_position" | "breakout_state" | "pullback_state"> = {
    regime,
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
