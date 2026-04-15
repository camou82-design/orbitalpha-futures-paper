import { EngineV2Input, MarketJudgmentOutput } from "../types";

export function detectMarketRegime(input: EngineV2Input): MarketJudgmentOutput {
    const { snapshot: sn } = input;

    const rangeScore = sn.rangeConfidence || 0;
    const trendScore = Math.abs(sn.emaGap || 0) * 1000; // Normalized
    const boxCohesionCollapse = (sn.boxCohesion01 || 0) < 0.3;
    const mixedBreakoutState = (sn.breakoutFailureRate || 0) > 0.4 && (sn.breakoutFailureRate || 0) < 0.7;
    const emaExpansionWeak = Math.abs(sn.emaGap || 0) > 0.0003 && (sn.trendWeaknessScore || 0) > 0.6;

    // Standard 3: Strict TRANSITION rule (Conflict-based)
    // Transition if at least 2 criteria are met (Mid Range, Mid Trend, Collapse, Mixed Breakout, or Weak EMA Expansion)
    let transitionScore = 0;
    if (rangeScore > 0.45) transitionScore++;
    if (trendScore > 0.45) transitionScore++;
    if (boxCohesionCollapse) transitionScore++;
    if (mixedBreakoutState) transitionScore++;
    if (emaExpansionWeak) transitionScore++;

    let regime: MarketJudgmentOutput["regime"] = "NO_TRADE";

    if (transitionScore >= 2) {
        regime = "TRANSITION";
    } else if (rangeScore > 0.6) {
        regime = "RANGE";
    } else if (trendScore > 0.7 && (sn.trendWeaknessScore || 0) < 0.5) {
        regime = "TREND";
    }

    return {
        regime,
        reason: transitionScore >= 2
            ? `Conflict detected (${transitionScore} criteria); entering scouting mode.`
            : `Market detected as ${regime} based on score analysis`,
        metrics: {
            rangeScore,
            trendScore,
            boxCohesionCollapse,
            mixedBreakoutState,
            emaExpansionWeak
        }
    };
}
