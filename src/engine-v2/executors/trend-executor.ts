import { EngineV2Input, ExecutorOutput, EngineV2SignalState, EngineV2Side, MarketJudgmentOutput } from "../types";

/**
 * Tier 4: Trend Executor (Refined)
 * Trend followers only; counter-trend prohibited.
 */
export function executeTrendRegime(input: EngineV2Input, judgment: MarketJudgmentOutput): ExecutorOutput {
    const { snapshot: sn } = input;
    if (judgment.subtype === "WHIPSAW_SHOCK_RECHECK") {
        return {
            signal: "WAIT_RECHECK",
            side: "none",
            reason: "WHIPSAW_SHOCK_RECHECK_TREND_HOLD",
            baseSizeIntent: 0,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice: null,
            invalidationPx: null,
            metadata: { whipsaw_shock_recheck: true }
        };
    }

    if (judgment.subtype === "EARLY_LONG_PROBE" || (judgment.subtype === "FAST_TREND_SHIFT" && judgment.diagnostics?.fastTrendShift?.direction === "long")) {
        const lastPrice = sn.lastPrice;
        const boxHigh = sn.boxHigh ?? lastPrice;
        const boxLow = sn.boxLow ?? lastPrice;
        const boxMid = (boxHigh + boxLow) / 2;
        const atr = sn.atr ?? (lastPrice * 0.01);
        
        const recentCandles = input.candles ?? [];
        const swingLow = recentCandles.length >= 10 
            ? Math.min(...recentCandles.slice(-10).map(c => c.low)) 
            : lastPrice * 0.99;
        
        const stopBasisMid = boxMid * 0.998; 
        const stopBasisAtr = lastPrice - (atr * 2.0);
        const stopPrice = Math.min(swingLow, stopBasisMid, stopBasisAtr);

        const baseSizeIntent = judgment.diagnostics?.fastTrendShift?.baseSizeIntent ?? 0.32;

        return {
            signal: "LONG_CANDIDATE",
            side: "long",
            reason: judgment.subtypeReason,
            baseSizeIntent,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice,
            invalidationPx: stopPrice,
            metadata: { 
                early_probe: true,
                fast_trend_shift: judgment.subtype === "FAST_TREND_SHIFT",
                stop_basis: "conservative_probe_basis",
                swing_low: swingLow,
                box_mid: boxMid,
                atr_stop: stopBasisAtr
            }
        };
    }

    if (judgment.subtype === "EARLY_SHORT_PROBE" || (judgment.subtype === "FAST_TREND_SHIFT" && judgment.diagnostics?.fastTrendShift?.direction === "short")) {
        const lastPrice = sn.lastPrice;
        const boxHigh = sn.boxHigh ?? lastPrice;
        const boxLow = sn.boxLow ?? lastPrice;
        const boxMid = (boxHigh + boxLow) / 2;
        const atr = sn.atr ?? (lastPrice * 0.01);
        
        const recentCandles = input.candles ?? [];
        const swingHigh = recentCandles.length >= 10 
            ? Math.max(...recentCandles.slice(-10).map(c => c.high)) 
            : lastPrice * 1.01;
        
        const stopBasisMid = boxMid * 1.002; 
        const stopBasisAtr = lastPrice + (atr * 2.0);
        const stopPrice = Math.max(swingHigh, stopBasisMid, stopBasisAtr);

        const baseSizeIntent = judgment.diagnostics?.fastTrendShift?.baseSizeIntent ?? 0.32;

        return {
            signal: "SHORT_CANDIDATE",
            side: "short",
            reason: judgment.subtypeReason,
            baseSizeIntent,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice,
            invalidationPx: stopPrice,
            metadata: { 
                early_probe: true,
                fast_trend_shift: judgment.subtype === "FAST_TREND_SHIFT",
                stop_basis: "conservative_probe_basis",
                swing_high: swingHigh,
                box_mid: boxMid,
                atr_stop: stopBasisAtr
            }
        };
    }
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
