import type { MarketRegime } from "../strategy/market-regime-detector";
import type { AnyEntryDecision } from "../strategy/executors/types";

export type AiApprovalAction = "ENTER_LONG" | "ENTER_SHORT" | "NO_ENTRY";

export type AiCostGateMode = "hard_block" | "soft_penalty" | "bypass_due_to_regime_first" | "neutral";

export type AiTrendStateGateMode = "hard_block" | "soft_penalty" | "neutral";

export type AiLossFlowGateMode = "hard_block" | "soft_penalty" | "neutral";

export type AiDominantPenaltySource = "cost" | "trend" | "loss_flow" | "none";

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
  loss_flow_gate_applied: boolean;
  loss_flow_gate_mode: AiLossFlowGateMode;
  loss_streak: number;
  last_10_net: number;
  loss_flow_penalty: number;
  dominant_penalty_source: AiDominantPenaltySource;
  dominant_penalty_value: number;
  secondary_penalty_value: number;
  tertiary_penalty_value: number;
  aggregate_penalty: number;
  penalty_aggregation_mode: "dominant_with_light_secondary";
  confidence_before_aggregation: number;
  /** Confidence after aggregation (same as output.confidence when set). */
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
  trend_state_penalty: 1.0
};

const LOSS_FLOW_NEUTRAL = (input: AiApprovalInput) => ({
  loss_flow_gate_applied: false,
  loss_flow_gate_mode: "neutral" as const,
  loss_streak: input.loss_streak,
  last_10_net: input.last_10_net,
  loss_flow_penalty: 1.0
});

const AGG_NEUTRAL: Pick<
  AiGateTrace,
  | "dominant_penalty_source"
  | "dominant_penalty_value"
  | "secondary_penalty_value"
  | "tertiary_penalty_value"
  | "aggregate_penalty"
  | "penalty_aggregation_mode"
  | "confidence_before_aggregation"
> = {
  dominant_penalty_source: "none",
  dominant_penalty_value: 1,
  secondary_penalty_value: 1,
  tertiary_penalty_value: 1,
  aggregate_penalty: 1,
  penalty_aggregation_mode: "dominant_with_light_secondary",
  confidence_before_aggregation: 0.65
};

/** Smallest multiplier = strongest penalty → dominant; others lightly blend (no full product collapse). */
function aggregateSoftPenalties(
  costPenalty: number,
  trendPenalty: number,
  lossPenalty: number,
  baseConfidence: number
): Pick<
  AiGateTrace,
  | "dominant_penalty_source"
  | "dominant_penalty_value"
  | "secondary_penalty_value"
  | "tertiary_penalty_value"
  | "aggregate_penalty"
  | "penalty_aggregation_mode"
  | "confidence_before_aggregation"
> {
  type Src = Exclude<AiDominantPenaltySource, "none">;
  const items: { src: Src; v: number }[] = [
    { src: "cost", v: costPenalty },
    { src: "trend", v: trendPenalty },
    { src: "loss_flow", v: lossPenalty }
  ];
  items.sort((a, b) => a.v - b.v);
  const p1 = items[0].v;
  const p2 = items[1].v;
  const p3 = items[2].v;
  const secondaryPart = 1 - (1 - p2) * 0.35;
  const tertiaryPart = 1 - (1 - p3) * 0.15;
  const rawAgg = p1 * secondaryPart * tertiaryPart;
  const aggregate_penalty = Math.max(0.62, Math.min(1.15, rawAgg));
  const allNeutral = costPenalty >= 0.999 && trendPenalty >= 0.999 && lossPenalty >= 0.999;
  const dominant_penalty_source: AiDominantPenaltySource = allNeutral ? "none" : items[0].src;
  return {
    dominant_penalty_source,
    dominant_penalty_value: p1,
    secondary_penalty_value: p2,
    tertiary_penalty_value: p3,
    aggregate_penalty,
    penalty_aggregation_mode: "dominant_with_light_secondary",
    confidence_before_aggregation: baseConfidence
  };
}

function reasonFromDominant(dom: AiDominantPenaltySource, ok: boolean): string {
  if (ok) {
    if (dom === "none") return "조건 충족";
    if (dom === "trend") return "조건 충족 (추세 확인 약함)";
    if (dom === "loss_flow") return "조건 충족 (손실 흐름 약화)";
    return "조건 충족 (비용 edge 보조)";
  }
  if (dom === "none") return "조건 부족";
  if (dom === "trend") return "조건 부족 (추세 확인 약함)";
  if (dom === "loss_flow") return "조건 부족 (손실 흐름 약화)";
  return "조건 부족 (비용 edge 약함)";
}

/** Streak bands: 2–3 → 0.88~0.82, 4–6 → 0.78~0.70, 7+ → down to ~0.58 floor with overall product floor. */
function computeLossFlowPenalty(input: AiApprovalInput): {
  loss_flow_penalty: number;
  loss_flow_gate_applied: boolean;
  loss_flow_gate_mode: AiLossFlowGateMode;
} {
  const ls = input.loss_streak;
  const ln = input.last_10_net;
  let p = 1.0;
  let applied = false;

  if (ls >= 2) {
    applied = true;
    if (ls <= 3) {
      p *= 0.88 - (ls - 2) * 0.06;
    } else if (ls <= 6) {
      p *= 0.78 - (ls - 4) * (0.08 / 2);
    } else {
      p *= Math.max(0.58, 0.66 - (ls - 7) * 0.01);
    }
  }

  if (ln < 0) {
    applied = true;
    p *= ln <= -8 ? 0.92 : 0.96;
  }

  if (input.risk_state === "LIMITED" && ln < 0) {
    applied = true;
    p *= 0.93;
  }

  p = Math.max(0.42, p);
  return {
    loss_flow_penalty: p,
    loss_flow_gate_applied: applied,
    loss_flow_gate_mode: applied ? "soft_penalty" : "neutral"
  };
}

function costTraceHard(
  input: AiApprovalInput,
  gate_mode: "RANGE" | "TREND",
  cost_gate_mode: AiCostGateMode,
  finalConfidence: number | null
): AiGateTrace {
  const lf = LOSS_FLOW_NEUTRAL(input);
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
    ...lf,
    ...AGG_NEUTRAL,
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
  }>,
  lossFlow: Readonly<{
    loss_flow_gate_applied: boolean;
    loss_flow_gate_mode: AiLossFlowGateMode;
    loss_flow_penalty: number;
  }>,
  aggregation: Pick<
    AiGateTrace,
    | "dominant_penalty_source"
    | "dominant_penalty_value"
    | "secondary_penalty_value"
    | "tertiary_penalty_value"
    | "aggregate_penalty"
    | "penalty_aggregation_mode"
    | "confidence_before_aggregation"
  >
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
    ...trend,
    loss_streak: input.loss_streak,
    last_10_net: input.last_10_net,
    ...lossFlow,
    ...aggregation,
    final_confidence_after_penalty: null
  };
}

/**
 * AI approval layer (deterministic, conservative).
 *
 * Soft penalties: dominant weakest multiplier + light secondary blend + floor — not full product
 * (avoids stacked “soft” becoming effective hard veto after regime/authority ENTER).
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

  const { loss_flow_penalty, loss_flow_gate_applied, loss_flow_gate_mode } = computeLossFlowPenalty(input);

  const trendTrace = {
    trend_state_gate_applied,
    trend_state_gate_mode,
    breakout_state,
    pullback_state,
    trend_state_penalty
  };

  const lossTrace = {
    loss_flow_gate_applied,
    loss_flow_gate_mode,
    loss_flow_penalty
  };

  const baseConfidence = 0.65;
  const aggregation = aggregateSoftPenalties(costPenalty, trend_state_penalty, loss_flow_penalty, baseConfidence);
  const costTrace = buildGateTrace(
    input,
    gate_mode,
    em,
    tc,
    edge,
    edgeScore,
    cost_gate_mode,
    trendTrace,
    lossTrace,
    aggregation
  );

  if (gate_mode === "RANGE") {
    if (input.box_position === "middle") {
      return attach({ action: "NO_ENTRY", reason: "박스 중앙", confidence: 0.99 }, costTrace);
    }
  }

  let confidence = clamp01(baseConfidence * aggregation.aggregate_penalty);
  const minPass = 0.38;
  const dom = aggregation.dominant_penalty_source;

  if (confidence < minPass) {
    return attach(
      { action: "NO_ENTRY", reason: reasonFromDominant(dom, false), confidence },
      costTrace
    );
  }

  return attach(
    {
      action: input.executor_direction === "long" ? "ENTER_LONG" : "ENTER_SHORT",
      reason: reasonFromDominant(dom, true),
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
