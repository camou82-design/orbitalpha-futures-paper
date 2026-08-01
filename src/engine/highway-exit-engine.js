"use strict";
// src/engine/highway-exit-engine.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.highwayExitEngine = highwayExitEngine;
function highwayExitEngine(input) {
    const { position, aiScores, lastPrice, ema20, ema60 } = input;
    let action = "hold";
    let reason = null;
    let guidance = "Hold position";
    let exitUrgency = "normal";
    if (ema20 !== null && ema60 !== null) {
        if (position.side === "long") {
            // 20 EMA breakdown
            if (lastPrice < ema20) {
                if (lastPrice < ema60) {
                    action = "hold";
                    reason = "highway_ema60_break_long";
                    guidance = "EMA60 break detected; waiting upper exit authority re-evaluation";
                    exitUrgency = "normal";
                }
                else {
                    action = "partial_close";
                    reason = "Highway 20 EMA Breakdown (Long)";
                    guidance = "Partial exit triggered by 20 EMA failure";
                    exitUrgency = "partial";
                }
            }
            else if (aiScores && aiScores.trendExhaustionScore > 0.8) {
                action = "partial_close";
                reason = "AI Trend Exhaustion detected";
                guidance = "Securing profits due to exhaustion";
                exitUrgency = "partial";
            }
        }
        else if (position.side === "short") {
            // 20 EMA breakdown
            if (lastPrice > ema20) {
                if (lastPrice > ema60) {
                    action = "hold";
                    reason = "highway_ema60_break_short";
                    guidance = "EMA60 break detected; waiting upper exit authority re-evaluation";
                    exitUrgency = "normal";
                }
                else {
                    action = "partial_close";
                    reason = "Highway 20 EMA Breakout (Short)";
                    guidance = "Partial exit triggered by 20 EMA failure";
                    exitUrgency = "partial";
                }
            }
            else if (aiScores && aiScores.trendExhaustionScore > 0.8) {
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
