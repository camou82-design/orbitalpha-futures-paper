import { EngineV2Input, ExecutorOutput, EngineV2SignalState, EngineV2Side, MarketJudgmentOutput } from "../types";

/**
 * Tier 4: Trend Executor (Refined)
 * Trend followers only; counter-trend prohibited.
 */
export function executeTrendRegime(input: EngineV2Input, judgment: MarketJudgmentOutput): ExecutorOutput {
    const { snapshot: sn } = input;
    const emaGap = sn.emaGap ?? 0;
    const trendWeakness = sn.trendWeaknessScore ?? 0;

    let signal: EngineV2SignalState = "NONE";
    let side: EngineV2Side = "none";
    let reason = "Waiting for trend alignment";

    if (emaGap >= 0.001 && trendWeakness < 0.3) {
        if (!input.state.longAllow) {
            signal = "NONE";
            side = "none";
            reason = `Strong momentum alignment but long is blocked by directional bias (${input.state.directionalShockState})`;
        } else {
            signal = "LONG_CANDIDATE";
            side = "long";
            reason = "Strong momentum alignment";
        }
    } else if (emaGap <= -0.001 && trendWeakness < 0.3) {
        if (!input.state.shortAllow) {
            signal = "NONE";
            side = "none";
            reason = `Strong downward momentum alignment but short is blocked by directional bias (${input.state.directionalShockState})`;
        } else {
            signal = "SHORT_CANDIDATE";
            side = "short";
            reason = "Strong downward momentum alignment";
        }
    } else if (Math.abs(emaGap) > 0 && trendWeakness < 0.5) {
        signal = "WAIT_RECHECK";
        side = "none";
        reason = "Momentum forming, awaiting confirmation";
    }

    // Phase 5: Breakout Observation Suppression & Retest Confirmation
    if (judgment.subtype === "BREAKOUT_OBSERVATION") {
        signal = "NONE";
        side = "none";
        reason = "SUPPRESSED: Initial breakout candle detected; awaiting retest for TREND validation";
        console.info(JSON.stringify({
            event: "V2_BREAKOUT_OBSERVATION_SUPPRESSION_PROOF",
            symbol: input.symbol,
            subtype: judgment.subtype,
            action: "SUPPRESS_ENTRY"
        }));
    } else if (judgment.subtype === "BREAKOUT_RETEST_CONFIRMED") {
        // If we were already in a candidate state, keep it. 
        // If not, we might want to force a candidate if momentum is still there.
        if (signal === "NONE" || signal === "WAIT_RECHECK") {
            if (Math.abs(emaGap) > 0.0005) {
                signal = emaGap > 0 ? "LONG_CANDIDATE" : "SHORT_CANDIDATE";
                side = emaGap > 0 ? "long" : "short";
                reason = "TREND_CONFIRMED: Breakout retest validated; entering trend phase";
            }
        }
        console.info(JSON.stringify({
            event: "V2_BREAKOUT_RETEST_CONFIRM_PROOF",
            symbol: input.symbol,
            subtype: judgment.subtype,
            action: "ALLOW_ENTRY",
            emaGap
        }));
    }

    const entryPx = sn.lastPrice ?? 0;
    const atr = sn.atr ?? (entryPx * 0.01);
    const ema20 = sn.ema20 && sn.ema20 > 0 ? sn.ema20 : entryPx / (1 + emaGap);

    let stopPrice: number | null = null;
    let invalidationPx: number | null = null;

    if (side === "long") {
        stopPrice = Math.min(ema20 - atr * 0.5, entryPx - atr * 1.5);
        invalidationPx = Math.min(ema20 - atr * 1.0, entryPx - atr * 2.0);
    } else if (side === "short") {
        stopPrice = Math.max(ema20 + atr * 0.5, entryPx + atr * 1.5);
        invalidationPx = Math.max(ema20 + atr * 1.0, entryPx + atr * 2.0);
    }

    return {
        signal,
        side,
        reason,
        baseSizeIntent: signal !== "NONE" ? 1 : 0,
        recheckSuggested: signal === "WAIT_RECHECK",
        isAddOnEligible: true,
        stopPrice,
        invalidationPx,
        metadata: {
            emaGap,
            trendWeakness,
            stopPrice,
            invalidationPx
        }
    };
}
