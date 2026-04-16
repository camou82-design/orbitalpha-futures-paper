import { EngineV2Input, MarketJudgmentOutput } from "../types";

export function detectMarketRegime(input: EngineV2Input): MarketJudgmentOutput {
    const { snapshot: sn } = input;

    const rangeScore = sn.rangeConfidence || 0;
    const trendScore = Math.abs(sn.emaGap || 0) * 1000; // Normalized
    const boxCohesionCollapse = (sn.boxCohesion01 || 0) < 0.3;
    const mixedBreakoutState = (sn.breakoutFailureRate || 0) > 0.4 && (sn.breakoutFailureRate || 0) < 0.7;
    const emaExpansionWeak = Math.abs(sn.emaGap || 0) > 0.0003 && (sn.trendWeaknessScore || 0) > 0.6;

    // Standard 3: Strict TRANSITION rule (Conflict-based Scouting)
    // Transition ONLY if scores reflect simultaneous indecision and structural conflict.
    const midRange = rangeScore > 0.4 && rangeScore < 0.7;
    const midTrend = trendScore > 0.4 && trendScore < 0.7;
    const structuralConflict = mixedBreakoutState || boxCohesionCollapse;

    let regime: MarketJudgmentOutput["regime"] = "NO_TRADE";

    if (midRange && midTrend && structuralConflict) {
        regime = "TRANSITION";
    } else if (rangeScore > 0.6) {
        regime = "RANGE";
    } else if (trendScore > 0.7 && (sn.trendWeaknessScore || 0) < 0.5) {
        regime = "TREND";
    }

    let regime_final = regime;
    let no_trade_reason: string | null = null;
    const data_ready = sn.data_ready;
    const dump_protection_hit = sn.dump_protection_hit;

    if (data_ready === false) {
        regime_final = "NO_TRADE";
        no_trade_reason = "DATA_NOT_READY";
    } else if (dump_protection_hit === true) {
        regime_final = "NO_TRADE";
        no_trade_reason = "DUMP_PROTECTION";
    }

    return {
        regime,
        regime_final,
        no_trade_reason,
        data_ready,
        dump_protection_hit,
        volatility_guard_hit: sn.volatility_guard_hit,
        reason: regime_final === "NO_TRADE"
            ? `NO_TRADE: ${no_trade_reason ?? "METRICS_INSUFFICIENT"}`
            : `Market detected as ${regime_final} based on score analysis`,
        metrics: {
            rangeScore,
            trendScore,
            boxCohesionCollapse,
            mixedBreakoutState,
            emaExpansionWeak
        }
    };
}
