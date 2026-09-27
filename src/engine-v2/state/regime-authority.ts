import type { EngineV2Regime } from "../types";
import type { MarketJudgmentOutput } from "../types";
import type { TrendRangeScoreAuthority } from "../market-judgment/trend-range-score-authority";

export type CanonicalRegimeDirection = "TREND_UP" | "TREND_DOWN" | "RANGE" | "TRANSITION";

export type RegimeAuthorityResult = Readonly<{
    regimeFinal: EngineV2Regime;
    canonicalRegime: CanonicalRegimeDirection;
    previousCanonicalRegime: CanonicalRegimeDirection;
    regimeDirection: "long" | "short" | "none" | "neutral";
    regimeChangeRequested: boolean;
    regimeChangeConfirmed: boolean;
    regimeChangeReason: string | null;
    htf_15m_bias: string;
    htf_1h_bias: string;
    htf_4h_bias: string;
    htf_1d_bias: string;
}>;

const regimeLatchBySymbol = new Map<string, CanonicalRegimeDirection>();

export function resetRegimeAuthorityLatchForTests(): void {
    regimeLatchBySymbol.clear();
}

function biasUpper(b: string | undefined): string {
    return String(b ?? "UNKNOWN").toUpperCase();
}

function isBearishBias(b: string): boolean {
    return b === "BEARISH";
}

function isBullishBias(b: string): boolean {
    return b === "BULLISH";
}

export function engineRegimeFromCanonical(c: CanonicalRegimeDirection): EngineV2Regime {
    if (c === "TREND_UP" || c === "TREND_DOWN") return "TREND";
    if (c === "TRANSITION") return "TRANSITION";
    return "RANGE";
}

export function proposeCanonicalRegimeDirection(args: Readonly<{
    regimeFinal: EngineV2Regime;
    emaGap: number;
    trendPhase: string;
}>): CanonicalRegimeDirection {
    const { regimeFinal, emaGap, trendPhase } = args;
    if (regimeFinal === "TRANSITION") return "TRANSITION";
    if (regimeFinal === "RANGE") return "RANGE";
    if (regimeFinal === "TREND") {
        const tp = String(trendPhase ?? "").toUpperCase();
        if (tp === "DOWN" || emaGap < -0.00005) return "TREND_DOWN";
        return "TREND_UP";
    }
    return "RANGE";
}

/** 15m/1h bias alignment only — 5m-derived transitionPhase labels are not demotion authority. */
function htfTrendUpDemotionConfirmed(args: Readonly<{
    m15: string;
    h1: string;
    structuralLowerBreakdownHold: boolean;
}>): boolean {
    const { m15, h1, structuralLowerBreakdownHold } = args;
    const htfBearish =
        isBearishBias(h1) && (isBearishBias(m15) || m15 === "RANGE" || m15 === "CONFLICT");
    if (htfBearish) return true;
    if (structuralLowerBreakdownHold && htfBearish) return true;
    return false;
}

function htfTrendDownDemotionConfirmed(args: Readonly<{
    m15: string;
    h1: string;
    structuralUpperBreakoutHold: boolean;
}>): boolean {
    const { m15, h1, structuralUpperBreakoutHold } = args;
    const htfBullish =
        isBullishBias(h1) && (isBullishBias(m15) || m15 === "RANGE" || m15 === "CONFLICT");
    if (htfBullish) return true;
    if (structuralUpperBreakoutHold && htfBullish) return true;
    return false;
}

export function rehydrateInitialCanonicalRegime(args: Readonly<{
    regimeFinal: EngineV2Regime;
    emaGap: number;
    trendPhase: string;
    htfBias?: MarketJudgmentOutput["htf_bias"];
}>): CanonicalRegimeDirection {
    const proposed = proposeCanonicalRegimeDirection({
        regimeFinal: args.regimeFinal,
        emaGap: args.emaGap,
        trendPhase: args.trendPhase
    });
    if (proposed === "TREND_UP" || proposed === "TREND_DOWN" || proposed === "TRANSITION") {
        return proposed;
    }
    const m15 = biasUpper(args.htfBias?.m15);
    const h1 = biasUpper(args.htfBias?.h1);
    if (args.regimeFinal === "TREND") {
        if (isBullishBias(h1) && isBullishBias(m15) && args.emaGap > 0) return "TREND_UP";
        if (isBearishBias(h1) && isBearishBias(m15) && args.emaGap < 0) return "TREND_DOWN";
    }
    return proposed;
}

function shortHorizonDemotionSignal(args: Readonly<{
    whipsawActive: boolean;
    whipsawSoftWatch: boolean;
    shockPhase: string;
    directionalShockState: string;
}>): boolean {
    if (args.whipsawActive || args.whipsawSoftWatch) return true;
    if (args.shockPhase === "DOWN_SHOCK" || args.shockPhase === "UP_SHOCK") return true;
    const dir = String(args.directionalShockState ?? "NONE").toUpperCase();
    return dir === "DOWN" || dir === "UP";
}

function regimeDirectionToSide(c: CanonicalRegimeDirection): RegimeAuthorityResult["regimeDirection"] {
    if (c === "TREND_UP") return "long";
    if (c === "TREND_DOWN") return "short";
    if (c === "TRANSITION") return "neutral";
    return "none";
}

export function applyRegimeAuthority(args: Readonly<{
    symbol: string;
    regimeFinal: EngineV2Regime;
    emaGap: number;
    trendPhase: string;
    transitionPhase: MarketJudgmentOutput["transitionPhase"];
    htfBias?: MarketJudgmentOutput["htf_bias"];
    scoreAuthority: TrendRangeScoreAuthority | null | undefined;
    whipsawActive: boolean;
    whipsawSoftWatch: boolean;
    shockPhase: string;
    directionalShockState: string;
}>): RegimeAuthorityResult {
    const m15 = biasUpper(args.htfBias?.m15);
    const h1 = biasUpper(args.htfBias?.h1);
    const h4 = biasUpper(args.htfBias?.h4);
    const d1 = biasUpper(args.htfBias?.d1);

    const structural = args.scoreAuthority;
    const lowerHold = structural?.lower_breakdown_hold === true;
    const upperHold = structural?.upper_breakout_hold === true;

    if (args.regimeFinal === "NO_TRADE") {
        return {
            regimeFinal: "NO_TRADE",
            canonicalRegime: "RANGE",
            previousCanonicalRegime: regimeLatchBySymbol.get(args.symbol) ?? "RANGE",
            regimeDirection: "none",
            regimeChangeRequested: false,
            regimeChangeConfirmed: false,
            regimeChangeReason: "NO_TRADE_UNCHANGED",
            htf_15m_bias: m15,
            htf_1h_bias: h1,
            htf_4h_bias: h4,
            htf_1d_bias: d1
        };
    }

    const proposed = proposeCanonicalRegimeDirection({
        regimeFinal: args.regimeFinal,
        emaGap: args.emaGap,
        trendPhase: args.trendPhase
    });

    const latched = regimeLatchBySymbol.get(args.symbol);
    const previous =
        latched ??
        rehydrateInitialCanonicalRegime({
            regimeFinal: args.regimeFinal,
            emaGap: args.emaGap,
            trendPhase: args.trendPhase,
            htfBias: args.htfBias
        });
    const changeRequested = proposed !== previous;

    let confirmed: CanonicalRegimeDirection = proposed;
    let changeConfirmed = !changeRequested;
    let reason: string | null = changeRequested ? null : "REGIME_STABLE";

    const trendLatched = previous === "TREND_UP" || previous === "TREND_DOWN";
    const demotionTarget = proposed === "RANGE" || proposed === "TRANSITION";

    if (trendLatched && demotionTarget) {
        const demotionOk =
            previous === "TREND_UP"
                ? htfTrendUpDemotionConfirmed({
                      m15,
                      h1,
                      structuralLowerBreakdownHold: lowerHold
                  })
                : htfTrendDownDemotionConfirmed({
                      m15,
                      h1,
                      structuralUpperBreakoutHold: upperHold
                  });

        if (proposed === "TRANSITION" && demotionOk) {
            confirmed = "TRANSITION";
            changeConfirmed = true;
            reason = "REGIME_HTF_TRANSITION_STAGE";
        } else if (proposed === "TRANSITION" && !demotionOk) {
            confirmed = previous;
            changeConfirmed = false;
            reason = "REGIME_HYSTERESIS_TRANSITION_BLOCKED";
        } else if (proposed === "RANGE") {
            if (demotionOk) {
                if (
                    previous === "TREND_UP" &&
                    isBearishBias(h1) &&
                    isBearishBias(m15)
                ) {
                    confirmed = "TREND_DOWN";
                    reason = "REGIME_HTF_REVERSAL_TO_TREND_DOWN";
                } else if (
                    previous === "TREND_DOWN" &&
                    isBullishBias(h1) &&
                    isBullishBias(m15)
                ) {
                    confirmed = "TREND_UP";
                    reason = "REGIME_HTF_REVERSAL_TO_TREND_UP";
                } else {
                    confirmed = "RANGE";
                    reason = "REGIME_HTF_DEMOTION_TO_RANGE";
                }
                changeConfirmed = true;
            } else if (shortHorizonDemotionSignal(args)) {
                confirmed = previous;
                changeConfirmed = false;
                reason = "REGIME_HYSTERESIS_5M_DEMOTION_BLOCKED";
            } else {
                confirmed = previous;
                changeConfirmed = false;
                reason = "REGIME_HYSTERESIS_INSUFFICIENT_HTF";
            }
        }
    } else if (changeRequested) {
        changeConfirmed = true;
        reason = "REGIME_PROPOSAL_ACCEPTED";
    }

    if (
        (previous === "RANGE" || previous === "TRANSITION") &&
        (proposed === "TREND_UP" || proposed === "TREND_DOWN")
    ) {
        confirmed = proposed;
        changeConfirmed = true;
        reason = reason ?? "REGIME_TREND_PROMOTION_ACCEPTED";
    }

    regimeLatchBySymbol.set(args.symbol, confirmed);

    return {
        regimeFinal: engineRegimeFromCanonical(confirmed),
        canonicalRegime: confirmed,
        previousCanonicalRegime: previous,
        regimeDirection: regimeDirectionToSide(confirmed),
        regimeChangeRequested: changeRequested,
        regimeChangeConfirmed: changeConfirmed,
        regimeChangeReason: reason,
        htf_15m_bias: m15,
        htf_1h_bias: h1,
        htf_4h_bias: h4,
        htf_1d_bias: d1
    };
}
