"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluatePartialExitPolicy = evaluatePartialExitPolicy;
exports.defaultPartialExitRatioForStage = defaultPartialExitRatioForStage;
function params(mode) {
    switch (mode) {
        case "trend":
            return { p1: 0.0045, r1: 0.38, p2: 0.0065, r2: 0.45 };
        case "sideways":
            return { p1: 0.003, r1: 0.48, p2: 0.0045, r2: 0.5 };
        case "risk_off":
            return { p1: 0.002, r1: 0.55, p2: 0.0032, r2: 0.5 };
        default:
            return { p1: 0.0045, r1: 0.38, p2: 0.0065, r2: 0.45 };
    }
}
/**
 * 1차·2차 분할 익절. 손절/최종 청산은 엔진 상위에서 처리.
 */
function evaluatePartialExitPolicy(input) {
    const stage = Math.min(2, Math.max(0, input.partialExitStage));
    const t = params(input.mode);
    if (stage >= 2) {
        return {
            shouldExitPartial: false,
            shouldExitFull: false,
            partialExitRatio: 0,
            reason: "partial_stages_complete",
            detail: { stage }
        };
    }
    if (stage === 0 && input.pnlPctNet >= t.p1) {
        return {
            shouldExitPartial: true,
            shouldExitFull: false,
            partialExitRatio: t.r1,
            reason: "first_profit_target",
            detail: { stage: 0, threshold: t.p1, ratio: t.r1, pnl_pct_net: input.pnlPctNet }
        };
    }
    if (stage === 1 && input.pnlPctNet >= t.p2) {
        return {
            shouldExitPartial: true,
            shouldExitFull: false,
            partialExitRatio: t.r2,
            reason: "second_profit_target",
            detail: { stage: 1, threshold: t.p2, ratio: t.r2, pnl_pct_net: input.pnlPctNet }
        };
    }
    return {
        shouldExitPartial: false,
        shouldExitFull: false,
        partialExitRatio: 0,
        reason: "below_partial_threshold",
        detail: {
            stage,
            pnl_pct_net: input.pnlPctNet,
            highest_pnl_pct_net: input.highestPnlPctNet,
            next_threshold: stage === 0 ? t.p1 : t.p2
        }
    };
}
/**
 * RANGE/TREND 실행기가 `partialExitRatio` 없이 partial_close만 줄 때 사용할 기본 분할 비율.
 * `partialExitStage` 0 → 1차(r1), 1 → 2차(r2).
 */
function defaultPartialExitRatioForStage(mode, partialExitStage) {
    const t = params(mode);
    const s = Math.min(1, Math.max(0, partialExitStage));
    return s === 0 ? t.r1 : t.r2;
}
