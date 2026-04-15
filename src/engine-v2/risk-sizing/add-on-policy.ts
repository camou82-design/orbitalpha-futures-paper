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

    // Standard 8: TRANSITION add-on prohibition
    if (regime === "TRANSITION") {
        reason = "TRANSITION add-ons strictly prohibited";
    } else if (!hasOpen) {
        reason = "No position to add on";
    } else {
        // Basic scaling logic (Stage 1 or Stage 2+)
        const currentStage = state.currentPositions[0]?.entryStage ?? 1;

        if (regime === "RANGE" && riskSizing.finalSizeUsd > 0) {
            allowed = true;
            ratioVsInitial = (currentStage === 1) ? 0.5 : 0.3;
            addOnSizeUsd = riskSizing.baseSizeUsd * ratioVsInitial;
            reason = `RANGE stage${currentStage} add-on allowed`;
        }
    }

    return { allowed, addOnSizeUsd, ratioVsInitial, reason };
}
