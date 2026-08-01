"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DECISION_FUNNEL_RING_MAX = exports.PIPELINE_VERSION = void 0;
exports.computeFunnelTick = computeFunnelTick;
exports.sumDecisionFunnelTicks = sumDecisionFunnelTicks;
exports.aggregateRejectReasonCountsTick = aggregateRejectReasonCountsTick;
exports.PIPELINE_VERSION = "2.2-HIGHWAY";
/** 최근 N틱 누적 퍼널 링 버퍼 최대 길이 (비영속). */
exports.DECISION_FUNNEL_RING_MAX = 50;
function computeFunnelTick(m) {
    let raw_signal_count = 0;
    let regime_pass_count = 0;
    let edge_pass_count = 0;
    let risk_pass_count = 0;
    let execution_ready_count = 0;
    let ai_pass_count = 0;
    let enter_count = 0;
    m.forEach((r) => {
        const d = r.decision;
        if (d.signal_state !== "NONE")
            raw_signal_count += 1;
        if (d.regime_state === "TREND" || d.regime_state === "RANGE")
            regime_pass_count += 1;
        if (d.edge_state === "PASS")
            edge_pass_count += 1;
        if (d.risk_state === "PASS" || d.risk_state === "SOFT_BLOCK")
            risk_pass_count += 1;
        if (d.execution_state === "PAPER_READY" || d.execution_state === "IDLE")
            execution_ready_count += 1;
        if (r.aiGatePassed)
            ai_pass_count += 1;
        if (d.final_decision === "ENTER")
            enter_count += 1;
    });
    return {
        raw_signal_count,
        regime_pass_count,
        edge_pass_count,
        risk_pass_count,
        execution_ready_count,
        ai_pass_count,
        enter_count
    };
}
/** 여러 틱 퍼널 카운트의 합(운영용 누적 트렌드). */
function sumDecisionFunnelTicks(ticks) {
    let raw_signal_count = 0;
    let regime_pass_count = 0;
    let edge_pass_count = 0;
    let risk_pass_count = 0;
    let execution_ready_count = 0;
    let ai_pass_count = 0;
    let enter_count = 0;
    for (const t of ticks) {
        raw_signal_count += t.raw_signal_count;
        regime_pass_count += t.regime_pass_count;
        edge_pass_count += t.edge_pass_count;
        risk_pass_count += t.risk_pass_count;
        execution_ready_count += t.execution_ready_count;
        ai_pass_count += t.ai_pass_count;
        enter_count += t.enter_count;
    }
    return {
        raw_signal_count,
        regime_pass_count,
        edge_pass_count,
        risk_pass_count,
        execution_ready_count,
        ai_pass_count,
        enter_count
    };
}
/** Reject reasons for non-ENTER decisions only; `reject_reason === null` excluded. */
function aggregateRejectReasonCountsTick(m) {
    const out = {};
    m.forEach((r) => {
        if (r.decision.final_decision === "ENTER")
            return;
        const code = r.decision.reject_reason;
        if (!code)
            return;
        out[code] = (out[code] ?? 0) + 1;
    });
    return out;
}
