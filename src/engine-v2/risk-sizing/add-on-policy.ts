import { EngineV2Input, MarketJudgmentOutput, AddonPolicyOutput, RiskSizingOutput } from "../types";

/**
 * Tier 5: Add-on Policy (Refined)
 * Strict rules for scaling positions.
 */
export function evaluateAddonPolicy(
    judgment: MarketJudgmentOutput,
    riskSizing: RiskSizingOutput,
    input: EngineV2Input
): AddonPolicyOutput {
    const { regime } = judgment;
    const { state } = input;
    const hasOpen = state.currentPositions.length > 0;

    let allowed = false;
    let addOnStageMarginKrw = 0;
    let reason = "Add-on conditions not met";

    // Standard 8: State-based Add-on Policy
    const position = state.currentPositions[0];
    const lossStreakCount = input.state.lossStreaks[input.symbol] || 0;
    const isLossStreak = lossStreakCount > 2;
    const confidenceThreshold = (input.snapshot.qualityScore || 0) > 0.7;

    // 1. Position-based state
    const hasPosition = !!position;
    const sideMatch = position?.side === (input.snapshot.signal === "LONG_CANDIDATE" ? "LONG" : "SHORT");
    const avgPriceImprovement = position ? (position.side === "LONG" ? input.snapshot.lastPrice > position.entryPrice : input.snapshot.lastPrice < position.entryPrice) : false;
    const pnlProtection = position ? position.pnlPct >= -0.015 : true; // Prevent add-on if pnl < -1.5%
    const maxAddonsReached = state.currentPositions.length >= 3;

    if (regime === "TRANSITION") {
        reason = "TRANSITION (Scouting mode) add-ons strictly prohibited";
    } else if (!hasPosition) {
        reason = "No active position to aggregate";
    } else if (!sideMatch) {
        reason = "Add-on blocked: Signal direction mismatch with existing position";
    } else if (isLossStreak) {
        reason = `Add-on blocked: Symbol loss streak (${lossStreakCount}) protection active`;
    } else if (!confidenceThreshold) {
        reason = "Add-on blocked: Signal quality below threshold (0.7)";
    } else if (!pnlProtection) {
        reason = "Add-on blocked: Existing position underwater (>1.5%)";
    } else if (maxAddonsReached) {
        reason = "Add-on blocked: Max position count (3) reached";
    } else if (regime === "RANGE" && riskSizing.stageMarginKrw > 0) {
        if (riskSizing.sizeMultiplier > 0.8 && avgPriceImprovement) {
            allowed = true;
            addOnStageMarginKrw = riskSizing.baseStageMarginKrw * 0.5;
            reason = "RANGE state-based add-on allowed (Price Improved + High Multiplier)";
        } else {
            reason = "RANGE add-on skipped: Size multiplier low or price not improved";
        }
    } else if (regime === "TREND" && riskSizing.stageMarginKrw > 0) {
        if (avgPriceImprovement) {
            allowed = true;
            addOnStageMarginKrw = riskSizing.baseStageMarginKrw * 0.3;
            reason = "TREND pyramid add-on allowed (Price Improved)";
        } else {
            reason = "TREND add-on skipped: Price worsening (No averaging down in trend)";
        }
    }

    return { allowed, addOnStageMarginKrw, reason };
}
