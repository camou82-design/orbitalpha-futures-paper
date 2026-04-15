import { EngineV2Input, MarketJudgmentOutput } from "../types";

export function detectMarketRegime(input: EngineV2Input): MarketJudgmentOutput {
    const { snapshot: sn } = input;

    const rangeScore = sn.rangeConfidence || 0;
    const trendScore = Math.abs(sn.emaGap || 0) * 1000; // Normalized
    const boxCohesionCollapse = (sn.boxCohesion01 || 0) < 0.3;
    const mixedBreakoutState = (sn.breakoutFailureRate || 0) > 0.4 && (sn.breakoutFailureRate || 0) < 0.7;
    const emaExpansionWeak = Math.abs(sn.emaGap || 0) > 0.0003 && (sn.trendWeaknessScore || 0) > 0.6;

    // Standard 3: Strict TRANSITION rule (at least 2 of 5)
    const condCount = [
        rangeScore >= 0.5,
        trendScore >= 0.5,
        boxCohesionCollapse,
        mixedBreakoutState,
        emaExpansionWeak
    ].filter(Boolean).length;

    const isTransition = condCount >= 2;

    let regime: MarketJudgmentOutput["regime"] = "NO_TRADE";
    if (isTransition) {
        regime = "TRANSITION";
    } else if (rangeScore > 0.7) {
        regime = "RANGE";
    } else if (trendScore > 0.8 && (sn.trendWeaknessScore || 0) < 0.4) {
        regime = "TREND";
    }

    return {
        regime,
        reason: `Market detected as ${regime} with ${condCount} transition conditions`,
        metrics: {
            rangeScore,
            trendScore,
            boxCohesionCollapse,
            mixedBreakoutState,
            emaExpansionWeak
        }
    };
}
