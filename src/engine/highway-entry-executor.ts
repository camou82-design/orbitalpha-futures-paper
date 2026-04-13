// src/engine/highway-entry-executor.ts

import { AiHighwayQualityScores, HighwayTrendState } from "../models/types";
import { isInsufficientCandlesLt60Only } from "./highway-trend-detector";
import type { AnyEntryDecision } from "../strategy/executors/types";

export function highwayExecutorEvaluateEntry(input: Readonly<{
    intentType: "probe" | "standard" | "scale" | "trend";
    highwayState: HighwayTrendState;
    aiScores: AiHighwayQualityScores;
    symbol: string;
    signal: string;
    risk_state: string;
    currentStage?: number;
    expectedMove: number | null;
    totalCost: number | null;
}>): AnyEntryDecision {

    // Default fail
    let entry_allowed = false;
    let blocked_reason: string | null = "highway_weak_signal";
    let target_stage = input.currentStage ?? 1;

    const invalidTier = (input.aiScores as any).invalidTier as "hard_invalid" | "soft_invalid" | "warning" | undefined;
    const invalidReasons = Array.isArray((input.aiScores as any).invalidReasons)
        ? ((input.aiScores as any).invalidReasons as string[])
        : [];
    const aiRaw = (input.aiScores as { aiScoreRaw?: Record<string, unknown> }).aiScoreRaw;
    const stiffnessProof = (aiRaw?.highwayStiffnessProof as Record<string, unknown> | undefined) ?? null;
    const candleGateProof = (aiRaw?.highwayCandleGateProof as Record<string, unknown> | undefined) ?? null;
    // Reject if too weak
    if (input.highwayState === HighwayTrendState.INVALID) {
        if (isInsufficientCandlesLt60Only(invalidReasons)) {
            return {
                entry_allowed: false,
                blocked_reason: "highway_insufficient_candles_watch",
                expected_move: input.expectedMove,
                total_cost: input.totalCost,
                risk_state: input.risk_state as any,
                regime: "TREND",
                executor: "TREND",
                breakout_state: "none",
                pullback_state: "unknown",
                guidance: "Highway: 1m 캔들 부족(워밍업/응답 단축) — hard_invalid 대신 관망",
                detail: {
                    highway_state: "INVALID",
                    highway_invalid_tier: (input.aiScores as { invalidTier?: string }).invalidTier ?? "soft_invalid",
                    highway_invalid_reasons: invalidReasons,
                    highway_candle_gate_proof: candleGateProof,
                    highway_stiffness_proof: stiffnessProof,
                    ...input.aiScores
                }
            };
        }
        const allowSoftInvalidProbe =
            invalidTier === "soft_invalid" &&
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
                risk_state: input.risk_state as any,
                regime: "TREND",
                executor: "TREND",
                breakout_state: "none",
                pullback_state: "unknown",
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
            risk_state: input.risk_state as any,
            regime: "TREND",
            executor: "TREND",
            breakout_state: "none",
            pullback_state: "unknown",
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
    } else if (input.intentType === "standard") {
        if (input.aiScores.highwayValidityScore > 0.6) {
            entry_allowed = true;
            blocked_reason = null;
            target_stage = (input.currentStage === 0) ? 1 : 2;
        }
    } else if (input.intentType === "scale") {
        if (input.aiScores.highwayValidityScore > 0.75 && input.highwayState === HighwayTrendState.VALID && input.aiScores.pullbackQualityScore > 0.7) {
            entry_allowed = true;
            blocked_reason = null;
            target_stage = 3;
        } else {
            // Can't scale, fallback to standard entry logic if we don't have position yet
            if (input.currentStage === 0 && input.aiScores.highwayValidityScore > 0.6) {
                entry_allowed = true;
                blocked_reason = null;
                target_stage = 1;
            } else {
                blocked_reason = "highway_scale_rejected_by_ai";
            }
        }
    } else {
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
        risk_state: input.risk_state as any,
        regime: "TREND",
        executor: "TREND",
        breakout_state: "none",
        pullback_state: "unknown",
        detail: {
            highwayValidity: input.aiScores?.highwayValidityScore,
            intent: input.intentType,
            highway_stiffness_proof: stiffnessProof,
            ...input.aiScores
        }
    };
}
