"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiApproveEntry = aiApproveEntry;
exports.aiInputFromDecision = aiInputFromDecision;
function clamp01(x) {
    if (!Number.isFinite(x))
        return 0;
    return x < 0 ? 0 : x > 1 ? 1 : x;
}
const TREND_TRACE_NEUTRAL = {
    trend_state_gate_applied: false,
    trend_state_gate_mode: "neutral",
    breakout_state: null,
    pullback_state: null,
    trend_state_penalty: 1.0
};
const LOSS_FLOW_NEUTRAL = (input) => ({
    loss_flow_gate_applied: false,
    loss_flow_gate_mode: "neutral",
    loss_streak: input.loss_streak,
    last_10_net: input.last_10_net,
    loss_flow_penalty: 1.0
});
const AGG_NEUTRAL = {
    dominant_penalty_source: "none",
    dominant_penalty_value: 1,
    secondary_penalty_value: 1,
    tertiary_penalty_value: 1,
    aggregate_penalty: 1,
    penalty_aggregation_mode: "dominant_with_light_secondary",
    confidence_before_aggregation: 0.65
};
/** Smallest multiplier = strongest penalty → dominant; others lightly blend (no full product collapse). */
function aggregateSoftPenalties(costPenalty, trendPenalty, lossPenalty, baseConfidence) {
    const items = [
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
    const dominant_penalty_source = allNeutral ? "none" : items[0].src;
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
function reasonFromDominant(dom, ok) {
    if (ok) {
        if (dom === "none")
            return "조건 충족";
        if (dom === "trend")
            return "조건 충족 (추세 확인 약함)";
        if (dom === "loss_flow")
            return "조건 충족 (손실 흐름 약화)";
        return "조건 충족 (비용 edge 보조)";
    }
    if (dom === "none")
        return "조건 부족";
    if (dom === "trend")
        return "조건 부족 (추세 확인 약함)";
    if (dom === "loss_flow")
        return "조건 부족 (손실 흐름 약화)";
    return "조건 부족 (비용 edge 약함)";
}
/** Streak bands: 2–3 → 0.88~0.82, 4–6 → 0.78~0.70, 7+ → down to ~0.58 floor with overall product floor. */
function computeLossFlowPenalty(input) {
    const ls = input.loss_streak;
    const ln = input.last_10_net;
    let p = 1.0;
    let applied = false;
    if (ls >= 2) {
        applied = true;
        if (ls <= 3) {
            p *= 0.88 - (ls - 2) * 0.06;
        }
        else if (ls <= 6) {
            p *= 0.78 - (ls - 4) * (0.08 / 2);
        }
        else {
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
function costTraceHard(input, gate_mode, cost_gate_mode, finalConfidence) {
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
function buildGateTrace(input, gate_mode, em, tc, edge, edgeScore, cost_gate_mode, trend, lossFlow, aggregation) {
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
function aiApproveEntry(input) {
    const gate_mode = input.regime === "RANGE" ? "RANGE" : input.regime === "TREND" ? "TREND" : input.executor;
    const em = input.expected_move;
    const tc = input.total_cost;
    const attach = (o, trace) => ({
        ...o,
        ai_gate_trace: { ...trace, final_confidence_after_penalty: o.confidence }
    });
    // Hard NOs (must NO_ENTRY).
    if (input.risk_state === "BLOCKED") {
        return attach({ action: "NO_ENTRY", reason: "리스크 차단", confidence: 0.99 }, costTraceHard(input, gate_mode, "hard_block", 0.99));
    }
    if (typeof em !== "number" || typeof tc !== "number" || !Number.isFinite(em) || !Number.isFinite(tc)) {
        return attach({ action: "NO_ENTRY", reason: "비용/기대움직임 불명확", confidence: 0.9 }, costTraceHard(input, gate_mode, "hard_block", 0.9));
    }
    const edge = em - tc;
    const edgeScore = clamp01((edge - 0.00025) / 0.0015);
    let cost_gate_mode = "neutral";
    let costPenalty = 1.0;
    if (gate_mode === "RANGE") {
        if (em <= tc || edgeScore < 0.25) {
            cost_gate_mode = "bypass_due_to_regime_first";
            costPenalty = 0.72 + 0.28 * Math.max(edgeScore, 0.08);
        }
    }
    else {
        if (em <= tc || edgeScore < 0.25) {
            cost_gate_mode = "soft_penalty";
            costPenalty = 0.52 + 0.48 * Math.max(edgeScore, 0.12);
        }
    }
    let trend_state_gate_applied = false;
    let trend_state_gate_mode = "neutral";
    let trend_state_penalty = 1.0;
    let breakout_state = null;
    let pullback_state = null;
    if (gate_mode === "TREND") {
        const bs = input.breakout_state ?? "none";
        const ps = input.pullback_state ?? "none";
        breakout_state = bs;
        pullback_state = ps;
        trend_state_gate_applied = true;
        const weakish = bs === "none" || ps !== "pullback_ok";
        if (weakish) {
            trend_state_gate_mode = "soft_penalty";
            trend_state_penalty = bs === "none" && ps === "none" ? 0.65 : 0.78;
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
    const costTrace = buildGateTrace(input, gate_mode, em, tc, edge, edgeScore, cost_gate_mode, trendTrace, lossTrace, aggregation);
    if (gate_mode === "RANGE") {
        if (input.box_position === "mid") {
            return attach({ action: "NO_ENTRY", reason: "박스 중앙", confidence: 0.99 }, costTrace);
        }
    }
    let confidence = clamp01(baseConfidence * aggregation.aggregate_penalty);
    const minPass = 0.38;
    const dom = aggregation.dominant_penalty_source;
    if (confidence < minPass) {
        return attach({ action: "NO_ENTRY", reason: reasonFromDominant(dom, false), confidence }, costTrace);
    }
    return attach({
        action: input.executor_direction === "long" ? "ENTER_LONG" : "ENTER_SHORT",
        reason: reasonFromDominant(dom, true),
        confidence
    }, costTrace);
}
function aiInputFromDecision(input) {
    if (input.decision.executor !== "RANGE" && input.decision.executor !== "TREND")
        return null;
    const regime = input.effectiveRegime ?? input.decision.regime;
    const base = {
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
