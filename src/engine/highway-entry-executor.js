"use strict";
// src/engine/highway-entry-executor.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.highwayExecutorEvaluateEntry = highwayExecutorEvaluateEntry;
const types_1 = require("../models/types");
const highway_trend_detector_1 = require("./highway-trend-detector");
function highwayExecutorEvaluateEntry(input) {
    // Default fail
    let entry_allowed = false;
    let blocked_reason = "highway_weak_signal";
    let target_stage = input.currentStage ?? 1;
    const invalidTier = input.aiScores.invalidTier;
    const invalidReasons = Array.isArray(input.aiScores.invalidReasons)
        ? input.aiScores.invalidReasons
        : [];
    const aiRaw = input.aiScores.aiScoreRaw;
    const stiffnessProof = aiRaw?.highwayStiffnessProof ?? null;
    const candleGateProof = aiRaw?.highwayCandleGateProof ?? null;
    // Reject if too weak
    if (input.highwayState === types_1.HighwayTrendState.INVALID) {
        if ((0, highway_trend_detector_1.isInsufficientCandlesLt60Only)(invalidReasons)) {
            return {
                entry_allowed: false,
                blocked_reason: "highway_insufficient_candles_watch",
                expected_move: input.expectedMove,
                total_cost: input.totalCost,
                risk_state: input.risk_state,
                regime: "TREND",
                executor: "TREND",
                breakout_state: "none",
                pullback_state: "none",
                guidance: "Highway: 1m 캔들 부족(워밍업/응답 단축) — hard_invalid 대신 관망",
                detail: {
                    highway_state: "INVALID",
                    highway_invalid_tier: input.aiScores.invalidTier ?? "soft_invalid",
                    highway_invalid_reasons: invalidReasons,
                    highway_candle_gate_proof: candleGateProof,
                    highway_stiffness_proof: stiffnessProof,
                    ...input.aiScores
                }
            };
        }
        const allowSoftInvalidProbe = invalidTier === "soft_invalid" &&
            (input.currentStage ?? 0) === 0 &&
            input.aiScores.highwayValidityScore >= 0.38 &&
            input.aiScores.pullbackQualityScore >= 0.25 &&
            !input.aiScores.deferEntry;
        if (allowSoftInvalidProbe) {
            return {
                entry_allowed: true,
                blocked_reason: null,
                target_stage: 1,
                expected_move: input.expectedMove,
                total_cost: input.totalCost,
                risk_state: input.risk_state,
                regime: "TREND",
                executor: "TREND",
                breakout_state: "none",
                pullback_state: "none",
                guidance: "soft-invalid highway: stage1 probe allowed",
                detail: {
                    highway_state: "INVALID",
                    highway_invalid_tier: invalidTier,
                    highway_invalid_reasons: invalidReasons,
                    highway_stiffness_proof: stiffnessProof,
                    ...input.aiScores
                }
            };
        }
        return {
            entry_allowed: false,
            blocked_reason: invalidTier === "soft_invalid" ? "highway_invalid_soft" : "highway_invalid_hard",
            expected_move: input.expectedMove,
            total_cost: input.totalCost,
            risk_state: input.risk_state,
            regime: "TREND",
            executor: "TREND",
            breakout_state: "none",
            pullback_state: "none",
            detail: {
                highway_state: "INVALID",
                highway_invalid_tier: invalidTier ?? "hard_invalid",
                highway_invalid_reasons: invalidReasons,
                highway_stiffness_proof: stiffnessProof,
                ...input.aiScores
            }
        };
    }
    // Determine target stages
    if (input.intentType === "probe") {
        if (input.aiScores.highwayValidityScore > 0.4) {
            entry_allowed = true;
            blocked_reason = null;
            target_stage = 1;
        }
    }
    else if (input.intentType === "standard") {
        if (input.aiScores.highwayValidityScore > 0.6) {
            entry_allowed = true;
            blocked_reason = null;
            target_stage = (input.currentStage === 0) ? 1 : 2;
        }
    }
    else if (input.intentType === "scale") {
        if (input.aiScores.highwayValidityScore > 0.75 && input.highwayState === types_1.HighwayTrendState.VALID && input.aiScores.pullbackQualityScore > 0.7) {
            entry_allowed = true;
            blocked_reason = null;
            target_stage = 3;
        }
        else {
            // Can't scale, fallback to standard entry logic if we don't have position yet
            if (input.currentStage === 0 && input.aiScores.highwayValidityScore > 0.6) {
                entry_allowed = true;
                blocked_reason = null;
                target_stage = 1;
            }
            else {
                blocked_reason = "highway_scale_rejected_by_ai";
            }
        }
    }
    else {
        // "trend" fallback
        if (input.aiScores.highwayValidityScore > 0.5) {
            entry_allowed = true;
            blocked_reason = null;
            target_stage = 1;
        }
    }
    if (input.aiScores.deferEntry) {
        entry_allowed = false;
        blocked_reason = "ai_deferred_entry";
    }
    return {
        entry_allowed,
        blocked_reason,
        target_stage,
        expected_move: input.expectedMove,
        total_cost: input.totalCost,
        risk_state: input.risk_state,
        regime: "TREND",
        executor: "TREND",
        breakout_state: "none",
        pullback_state: "none",
        detail: {
            highwayValidity: input.aiScores?.highwayValidityScore,
            intent: input.intentType,
            highway_stiffness_proof: stiffnessProof,
            ...input.aiScores
        }
    };
}
