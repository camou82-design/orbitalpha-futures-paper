import { EngineV2Input, MarketJudgmentOutput } from "../types";

export function detectMarketRegime(input: EngineV2Input): MarketJudgmentOutput {
    const { snapshot: sn } = input;

    const rangeScore = sn.rangeConfidence || 0;
    const trendScore = Math.abs(sn.emaGap || 0) * 1000; // Normalized
    const boxCohesionCollapse = (sn.boxCohesion01 || 0) < 0.3;
    const mixedBreakoutState = (sn.breakoutFailureRate || 0) > 0.4 && (sn.breakoutFailureRate || 0) < 0.7;
    const emaExpansionWeak = Math.abs(sn.emaGap || 0) > 0.0003 && (sn.trendWeaknessScore || 0) > 0.6;

    // Standard 3: Strict TRANSITION rule (Conflict-based)
    // Transition if both scores are high but neither is dominant, or if signals conflict.
    const isConflict = (rangeScore > 0.4 && trendScore > 0.4);
    const isBreakoutIndecision = (sn.breakoutFailureRate || 0) > 0.5 && (sn.boxCohesion01 || 0) < 0.3;

    let regime: MarketJudgmentOutput["regime"] = "NO_TRADE";

    if (isConflict || isBreakoutIndecision) {
        regime = "TRANSITION";
    } else if (rangeScore > 0.6) {
        regime = "RANGE";
    } else if (trendScore > 0.7 && (sn.trendWeaknessScore || 0) < 0.5) {
        regime = "TREND";
    }

    return {
        regime,
        reason: `Market detected as ${regime} based on score analysis`,
        metrics: {
            rangeScore,
            trendScore,
            boxCohesionCollapse,
            mixedBreakoutState,
            emaExpansionWeak
        }
    };
}
