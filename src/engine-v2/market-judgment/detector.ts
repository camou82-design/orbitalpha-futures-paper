import { EngineV2Input, EngineV2MarketSubtype, MarketJudgmentOutput } from "../types";

function classifyShockPhase(input: EngineV2Input): MarketJudgmentOutput["shockPhase"] {
    const shock = input.state.directionalShockState ?? "NONE";
    const crashState = String(input.state.crashState ?? "").toUpperCase();
    const pumpState = String(input.state.pumpState ?? input.state.pump_state ?? "").toUpperCase();
    if (shock === "DOWN") return "DOWN_SHOCK";
    if (shock === "UP") return "UP_SHOCK";
    if (crashState.includes("RECOVERY") || crashState.includes("REDUCE")) return "CRASH_RECOVERY";
    if (pumpState.includes("RECOVERY") || pumpState.includes("REDUCE")) return "PUMP_RECOVERY";
    return "NONE";
}

function classifyRangePhase(sn: EngineV2Input["snapshot"]): MarketJudgmentOutput["rangePhase"] {
    const boxPos = Number(sn.boxPos ?? 0.5);
    const boxBreakSide = sn.boxBreakSide ?? "none";
    const emaGap = Number(sn.emaGap ?? 0);
    const breakoutFailureRate = Number(sn.breakoutFailureRate ?? 0);
    if (breakoutFailureRate >= 0.6) return "FAKE_BREAKOUT";
    if (boxBreakSide === "lower" && emaGap < 0) return "BREAKDOWN";
    if (boxBreakSide === "upper" && emaGap > 0) return "BREAKOUT";
    if (boxPos <= 0.26) return "LOWER";
    if (boxPos >= 0.74) return "UPPER";
    return "MID";
}

function classifyTrendPhase(sn: EngineV2Input["snapshot"]): MarketJudgmentOutput["trendPhase"] {
    const emaGap = Number(sn.emaGap ?? 0);
    const tw = Number(sn.trendWeaknessScore ?? 1);
    if (tw >= 0.65) return "EXHAUSTION";
    if (tw >= 0.4) return "PULLBACK";
    if (emaGap > 0) return "UP";
    if (emaGap < 0) return "DOWN";
    return "NONE";
}

function classifyTransitionPhase(
    rangeScore: number,
    trendScore: number,
    boxCohesionCollapse: boolean,
    mixedBreakoutState: boolean,
    trendWeaknessScore: number
): MarketJudgmentOutput["transitionPhase"] {
    const rangeToTrend =
        rangeScore > 0.4 &&
        rangeScore < 0.7 &&
        trendScore >= 0.6 &&
        boxCohesionCollapse;
    const trendToRange = trendWeaknessScore > 0.6 && rangeScore >= 0.6;
    if (rangeToTrend) return "RANGE_TO_TREND";
    if (trendToRange) return "TREND_TO_RANGE";
    if (mixedBreakoutState || boxCohesionCollapse) return "CONFLICT";
    return "NONE";
}

function selectSubtype(args: {
    regimeFinal: MarketJudgmentOutput["regime_final"];
    noTradeReason: string | null;
    shockPhase: MarketJudgmentOutput["shockPhase"];
    rangePhase: MarketJudgmentOutput["rangePhase"];
    trendPhase: MarketJudgmentOutput["trendPhase"];
    transitionPhase: MarketJudgmentOutput["transitionPhase"];
}): { subtype: EngineV2MarketSubtype; subtypeReason: string } {
    const { regimeFinal, noTradeReason, shockPhase, rangePhase, trendPhase, transitionPhase } = args;
    if (regimeFinal === "NO_TRADE") {
        if (noTradeReason === "DATA_NOT_READY") return { subtype: "NO_TRADE_DATA_NOT_READY", subtypeReason: "no_trade_data_not_ready" };
        if (noTradeReason === "DUMP_PROTECTION") return { subtype: "NO_TRADE_DUMP_PROTECTION", subtypeReason: "no_trade_dump_protection" };
        return { subtype: "NO_TRADE_METRICS_INSUFFICIENT", subtypeReason: "no_trade_metrics_insufficient" };
    }
    if (shockPhase === "DOWN_SHOCK") return { subtype: "SHOCK_REACTION_DOWN", subtypeReason: "directional_shock_down" };
    if (shockPhase === "UP_SHOCK") return { subtype: "SHOCK_REACTION_UP", subtypeReason: "directional_shock_up" };
    if (regimeFinal === "RANGE") {
        if (rangePhase === "FAKE_BREAKOUT") return { subtype: "RANGE_FAKE_BREAKOUT", subtypeReason: "range_fake_breakout_failure_rate_high" };
        if (rangePhase === "BREAKDOWN") return { subtype: "RANGE_BREAKDOWN_CANDIDATE", subtypeReason: "range_breakdown_candidate" };
        if (rangePhase === "BREAKOUT") return { subtype: "RANGE_BREAKOUT_CANDIDATE", subtypeReason: "range_breakout_candidate" };
        if (rangePhase === "LOWER") return { subtype: "RANGE_LOWER_REACTION", subtypeReason: "range_lower_reaction" };
        if (rangePhase === "UPPER") return { subtype: "RANGE_UPPER_REACTION", subtypeReason: "range_upper_reaction" };
        return { subtype: "RANGE_MID_CHOP", subtypeReason: "range_mid_chop" };
    }
    if (regimeFinal === "TREND") {
        if (trendPhase === "EXHAUSTION") return { subtype: "TREND_EXHAUSTION", subtypeReason: "trend_exhaustion" };
        if (trendPhase === "PULLBACK") return { subtype: "TREND_PULLBACK", subtypeReason: "trend_pullback" };
        if (trendPhase === "DOWN") return { subtype: "TREND_DOWN_CONTINUATION", subtypeReason: "trend_down_continuation" };
        return { subtype: "TREND_UP_CONTINUATION", subtypeReason: "trend_up_continuation" };
    }
    if (transitionPhase === "RANGE_TO_TREND") return { subtype: "TRANSITION_RANGE_TO_TREND", subtypeReason: "transition_range_to_trend" };
    if (transitionPhase === "TREND_TO_RANGE") return { subtype: "TRANSITION_TREND_TO_RANGE", subtypeReason: "transition_trend_to_range" };
    return { subtype: "TRANSITION_CONFLICT", subtypeReason: "transition_conflict" };
}

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
    const shockPhase = classifyShockPhase(input);
    const rangePhase = classifyRangePhase(sn);
    const trendPhase = classifyTrendPhase(sn);
    const transitionPhase = classifyTransitionPhase(
        rangeScore,
        trendScore,
        boxCohesionCollapse,
        mixedBreakoutState,
        Number(sn.trendWeaknessScore ?? 1)
    );

    if (data_ready === false) {
        regime_final = "NO_TRADE";
        no_trade_reason = "DATA_NOT_READY";
    } else if (dump_protection_hit === true) {
        regime_final = "NO_TRADE";
        no_trade_reason = "DUMP_PROTECTION";
    }
    const subtypeDecision = selectSubtype({
        regimeFinal: regime_final,
        noTradeReason: no_trade_reason,
        shockPhase,
        rangePhase,
        trendPhase,
        transitionPhase
    });

    return {
        regime,
        regime_final,
        subtype: subtypeDecision.subtype,
        subtypeReason: subtypeDecision.subtypeReason,
        shockPhase,
        rangePhase,
        trendPhase,
        transitionPhase,
        judgmentVersion: "v2_market_judgment_subtype_v1",
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
