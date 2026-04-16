import { EngineV2Input, ExecutorOutput, EngineV2SignalState, EngineV2Side } from "../types";

/**
 * Tier 4: Trend Executor (Refined)
 * Trend followers only; counter-trend prohibited.
 */
export function executeTrendRegime(input: EngineV2Input): ExecutorOutput {
    const { snapshot: sn } = input;
    const emaGap = sn.emaGap ?? 0;
    const trendWeakness = sn.trendWeaknessScore ?? 0;

    let signal: EngineV2SignalState = "NONE";
    let side: EngineV2Side = "none";
    let reason = "Waiting for trend alignment";

    if (emaGap >= 0.001 && trendWeakness < 0.3) {
        signal = "LONG_CANDIDATE";
        side = "long";
        reason = "Strong momentum alignment";
    } else if (emaGap <= -0.001 && trendWeakness < 0.3) {
        signal = "SHORT_CANDIDATE";
        side = "short";
        reason = "Strong downward momentum alignment";
    } else if (Math.abs(emaGap) > 0 && trendWeakness < 0.5) {
        signal = "WAIT_RECHECK";
        side = "none";
        reason = "Momentum forming, awaiting confirmation";
    }

    return {
        signal,
        side,
        reason,
        baseSizeIntent: signal !== "NONE" ? 1 : 0,
        recheckSuggested: signal === "WAIT_RECHECK",
        isAddOnEligible: true,
        metadata: {
            emaGap,
            trendWeakness
        }
    };
}
