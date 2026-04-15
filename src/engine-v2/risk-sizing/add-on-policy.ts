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
    let addOnSizeUsd = 0;
    let ratioVsInitial = 0;
    let reason = "Add-on conditions not met";

    // Standard 8: State-based Add-on Policy
    const position = state.currentPositions[0];
    const avgPriceImprovement = position ? (position.side === "LONG" ? input.snapshot.lastPrice > position.entryPrice : input.snapshot.lastPrice < position.entryPrice) : false;
    const sameDirection = position ? (position.side === (riskSizing.isAddOn ? position.side : "NONE")) : true; // logic placeholder
    const confidenceThreshold = 0.7; // Example high threshold for add-on

    if (regime === "TRANSITION") {
        reason = "TRANSITION add-ons strictly prohibited (Highway Standard)";
    } else if (!position) {
        reason = "No position to add on";
    } else if (position.pnlPct < -0.02) {
        reason = "Add-on blocked: Loss exceeding threshold (Protection)";
    } else if (state.currentPositions.length >= 3) {
        reason = "Add-on blocked: Max count reached";
    } else if (regime === "RANGE" && riskSizing.finalSizeUsd > 0) {
        allowed = true;
        addOnSizeUsd = riskSizing.baseSizeUsd * 0.5;
        reason = "RANGE state-based add-on allowed";
    }

    return { allowed, addOnSizeUsd, reason };
}
