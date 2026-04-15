import { EngineV2Input, MarketJudgmentOutput, AddonPolicyOutput, RiskSizingOutput } from "../types";

export function evaluateAddonPolicy(
    judgment: MarketJudgmentOutput,
    riskSizing: RiskSizingOutput,
    input: EngineV2Input
): AddonPolicyOutput {
    const { regime } = judgment;
    const hasOpen = input.state.currentPositions.length > 0;

    let allowed = false;
    let addOnSizeUsd = 0;
    let ratioVsInitial = 0;
    let reason = "Add-on conditions not met";

    if (regime === "TRANSITION") {
        reason = "No add-on in transition";
    } else if (!hasOpen) {
        reason = "No position to add on";
    } else if (judgment.regime === "RANGE" && riskSizing.finalSizeUsd > 0) {
        allowed = true;
        addOnSizeUsd = riskSizing.baseSizeUsd * 0.5;
        ratioVsInitial = 0.5;
        reason = "Range stage1 add-on allowed";
    }

    return { allowed, addOnSizeUsd, ratioVsInitial, reason };
}
