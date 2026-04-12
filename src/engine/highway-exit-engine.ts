// src/engine/highway-exit-engine.ts

import { PaperOpenPositionRecord, AiHighwayQualityScores } from "../models/types";
import type { TrendExitDecision } from "../strategy/executors/types";

export function highwayExitEngine(input: Readonly<{
    position: PaperOpenPositionRecord;
    aiScores: AiHighwayQualityScores | null;
    lastPrice: number;
    ema20: number | null;
    ema60: number | null;
}>): TrendExitDecision {
    const { position, aiScores, lastPrice, ema20, ema60 } = input;

    let action: "hold" | "partial_close" | "close" = "hold";
    let reason: string | null = null;
    let guidance = "Hold position";
    let exitUrgency: "normal" | "urgent" | "partial" = "normal";

    if (ema20 !== null && ema60 !== null) {
        if (position.side === "long") {
            // 20 EMA breakdown
            if (lastPrice < ema20) {
                if (lastPrice < ema60) {
                    action = "close";
                    reason = "Highway 60 EMA Breakdown (Long)";
                    guidance = "Full exit triggered by 60 EMA failure";
                    exitUrgency = "urgent";
                } else {
                    action = "partial_close";
                    reason = "Highway 20 EMA Breakdown (Long)";
                    guidance = "Partial exit triggered by 20 EMA failure";
                    exitUrgency = "partial";
                }
            } else if (aiScores && aiScores.trendExhaustionScore > 0.8) {
                action = "partial_close";
                reason = "AI Trend Exhaustion detected";
                guidance = "Securing profits due to exhaustion";
                exitUrgency = "partial";
            }
        } else if (position.side === "short") {
            // 20 EMA breakdown
            if (lastPrice > ema20) {
                if (lastPrice > ema60) {
                    action = "close";
                    reason = "Highway 60 EMA Breakout (Short)";
                    guidance = "Full exit triggered by 60 EMA failure";
                    exitUrgency = "urgent";
                } else {
                    action = "partial_close";
                    reason = "Highway 20 EMA Breakout (Short)";
                    guidance = "Partial exit triggered by 20 EMA failure";
                    exitUrgency = "partial";
                }
            } else if (aiScores && aiScores.trendExhaustionScore > 0.8) {
                action = "partial_close";
                reason = "AI Trend Exhaustion detected";
                guidance = "Securing profits due to exhaustion";
                exitUrgency = "partial";
            }
        }
    }

    return {
        action,
        reason,
        guidance,
        executor: "TREND",
        detail: {
            exitUrgency,
            highwayAim: "protect_trend"
        }
    };
}
