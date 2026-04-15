import { EngineV2Input, MarketJudgmentOutput, RegimeConfidenceOutput } from "../types";

export function calculateRegimeConfidence(
    judgment: MarketJudgmentOutput,
    input: EngineV2Input
): RegimeConfidenceOutput {
    const { snapshot: sn } = input;

    let score = 50; // Neutral start

    if (judgment.regime === "RANGE") {
        score = (sn.rangeConfidence || 0) * 100;
    } else if (judgment.regime === "TREND") {
        score = (1 - (sn.trendWeaknessScore || 0)) * 100;
    } else if (judgment.regime === "TRANSITION") {
        score = 40; // Transitions are inherently less confident
    }

    let level: RegimeConfidenceOutput["level"] = "MID";
    if (score >= 75) level = "HIGH";
    else if (score < 50) level = "LOW";

    return { score, level };
}
