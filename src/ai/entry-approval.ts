import type { MarketRegime } from "../strategy/market-regime-detector";
import type { AnyEntryDecision } from "../strategy/executors/types";

export type AiApprovalAction = "ENTER_LONG" | "ENTER_SHORT" | "NO_ENTRY";

export type AiCostGateMode = "hard_block" | "soft_penalty" | "bypass_due_to_regime_first" | "neutral";

export type AiTrendStateGateMode = "hard_block" | "soft_penalty" | "neutral";

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
  trend_state_gate_applied: boolean;
  trend_state_gate_mode: AiTrendStateGateMode;
  breakout_state: string | null;
  pullback_state: string | null;
  trend_state_penalty: number;
  /** Confidence after cost × trend penalties (same as output.confidence when set). */
  final_confidence_after_penalty: number | null;
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

const TREND_TRACE_NEUTRAL = {
  trend_state_gate_applied: false,
  trend_state_gate_mode: "neutral" as const,
  breakout_state: null as string | null,
  pullback_state: null as string | null,
  trend_state_penalty: 1.0,
  final_confidence_after_penalty: null as number | null
};

function costTraceHard(
  input: AiApprovalInput,
  gate_mode: "RANGE" | "TREND",
  cost_gate_mode: AiCostGateMode,
  finalConfidence: number | null
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
    cost_gate_mode,
    ...TREND_TRACE_NEUTRAL,
    final_confidence_after_penalty: finalConfidence
  };
}

function buildGateTrace(
  input: AiApprovalInput,
  gate_mode: "RANGE" | "TREND",
  em: number,
  tc: number,
  edge: number,
  edgeScore: number,
  cost_gate_mode: AiCostGateMode,
  trend: Readonly<{
    trend_state_gate_applied: boolean;
    trend_state_gate_mode: AiTrendStateGateMode;
    breakout_state: string | null;
    pullback_state: string | null;
    trend_state_penalty: number;
    final_confidence_after_penalty: number | null;
  }>
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
    cost_gate_mode,
    ...trend
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
 *
 * TREND: breakout/pullback unknown or weak states apply soft penalties only — no duplicate hard veto
 * after upper routing + authority ENTER.
 */
export function aiApproveEntry(input: AiApprovalInput): AiApprovalOutput {
  const gate_mode: "RANGE" | "TREND" =
    input.regime === "RANGE" ? "RANGE" : input.regime === "TREND" ? "TREND" : input.executor;

  const em = input.expected_move;
  const tc = input.total_cost;

  const attach = (o: Pick<AiApprovalOutput, "action" | "reason" | "confidence">, trace: AiGateTrace): AiApprovalOutput => ({
    ...o,
    ai_gate_trace: { ...trace, final_confidence_after_penalty: o.confidence }
  });

  // Hard NOs (must NO_ENTRY).
  if (input.risk_state === "BLOCKED") {
    return attach(
      { action: "NO_ENTRY", reason: "리스크 차단", confidence: 0.99 },
      costTraceHard(input, gate_mode, "hard_block", 0.99)
    );
  }

  if (typeof em !== "number" || typeof tc !== "number" || !Number.isFinite(em) || !Number.isFinite(tc)) {
    return attach(
      { action: "NO_ENTRY", reason: "비용/기대움직임 불명확", confidence: 0.9 },
      costTraceHard(input, gate_mode, "hard_block", 0.9)
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

  let trend_state_gate_applied = false;
  let trend_state_gate_mode: AiTrendStateGateMode = "neutral";
  let trend_state_penalty = 1.0;
  let breakout_state: string | null = null;
  let pullback_state: string | null = null;

  if (gate_mode === "TREND") {
    const bs = input.breakout_state ?? "unknown";
    const ps = input.pullback_state ?? "unknown";
    breakout_state = bs;
    pullback_state = ps;
    trend_state_gate_applied = true;

    const unknownish = bs === "unknown" || ps === "unknown";
    const weakish = bs === "none" && ps !== "pullback_ok";

    if (unknownish) {
      trend_state_gate_mode = "soft_penalty";
      trend_state_penalty = bs === "unknown" && ps === "unknown" ? 0.65 : 0.72;
    } else if (weakish) {
      trend_state_gate_mode = "soft_penalty";
      trend_state_penalty = 0.78;
    }
  }

  const trendTrace = {
    trend_state_gate_applied,
    trend_state_gate_mode,
    breakout_state,
    pullback_state,
    trend_state_penalty,
    final_confidence_after_penalty: null as number | null
  };

  const costTrace = buildGateTrace(input, gate_mode, em, tc, edge, edgeScore, cost_gate_mode, trendTrace);

  if (gate_mode === "RANGE") {
    if (input.box_position === "middle") {
      return attach({ action: "NO_ENTRY", reason: "박스 중앙", confidence: 0.99 }, costTrace);
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

  const baseConfidence = 0.65;
  let confidence = baseConfidence * costPenalty * trend_state_penalty;
  confidence = clamp01(confidence);

  const minPass = 0.38;
  if (confidence < minPass) {
    const costSoft = cost_gate_mode === "soft_penalty" || cost_gate_mode === "bypass_due_to_regime_first";
    const reason =
      trend_state_penalty < 1
        ? "조건 부족 (추세 확인 약함)"
        : costSoft
          ? "조건 부족 (비용 edge 보조)"
          : "조건 부족";
    return attach({ action: "NO_ENTRY", reason, confidence }, costTrace);
  }

  let reason = "조건 충족";
  if (trend_state_penalty < 1) {
    reason = "조건 충족 (추세 확인 약함)";
  } else if (cost_gate_mode === "bypass_due_to_regime_first" || cost_gate_mode === "soft_penalty") {
    reason = "조건 충족 (비용 edge 보조)";
  }

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
