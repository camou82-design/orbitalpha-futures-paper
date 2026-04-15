import { MarketJudgmentOutput, RegimeConfidenceOutput, RouterOutput } from "../types";

export function routeToExecutor(
    judgment: MarketJudgmentOutput,
    confidence: RegimeConfidenceOutput
): RouterOutput {
    const { regime } = judgment;
    const { level } = confidence;

    // Rule: If confidence is LOW, Trend/Range are downgraded to TRANSITION
    if (level === "LOW" && (regime === "TREND" || regime === "RANGE")) {
        return {
            executor: "TRANSITION",
            reason: "Downgraded due to low confidence"
        };
    }

    if (regime === "RANGE") return { executor: "RANGE", reason: "Standard range routing" };
    if (regime === "TREND") return { executor: "TREND", reason: "Standard trend routing" };
    if (regime === "TRANSITION") return { executor: "TRANSITION", reason: "Strict transition routing" };

    return { executor: "NONE", reason: "No clear regime" };
}
