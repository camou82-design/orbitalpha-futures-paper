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
    if (judgment.subtype === "RANGE_MID_CHOP") score -= 8;
    if (judgment.subtype === "RANGE_LOWER_REACTION" || judgment.subtype === "RANGE_UPPER_REACTION") {
        if ((sn.rangeConfidence || 0) >= 0.7) score += 3;
    }
    if (judgment.subtype === "TREND_EXHAUSTION") score -= 12;
    if (judgment.subtype === "TRANSITION_CONFLICT") score = Math.min(score, 45);
    if (judgment.subtype === "SHOCK_REACTION_DOWN" || judgment.subtype === "SHOCK_REACTION_UP") {
        score = Math.min(score, 62);
    }
    if (judgment.subtype === "WHIPSAW_SHOCK_RECHECK") {
        score = Math.min(score, 48);
    }
    score = Math.max(0, Math.min(100, score));

    let level: RegimeConfidenceOutput["level"] = "MID";
    if (score >= 75) level = "HIGH";
    else if (score < 50) level = "LOW";

    return { score, level };
}
