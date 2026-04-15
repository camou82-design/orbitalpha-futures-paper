import { EngineV2Input, ExecutorOutput } from "../types";

/**
 * Tier 4: Trend Executor (Refined)
 * Trend followers only; counter-trend prohibited.
 */
export function executeTrendRegime(input: EngineV2Input): ExecutorOutput {
    const { snapshot: sn } = input;
    const emaGap = sn.emaGap ?? 0;
    const trendWeakness = sn.trendWeaknessScore ?? 0;

    let signal: ExecutorOutput["signal"] = "NONE";
    let side: ExecutorOutput["side"] = "none";
    let reason = "Waiting for trend alignment";

    if (emaGap >= 0.001 && trendWeakness < 0.3) {
        signal = "LONG_CANDIDATE";
        side = "long";
        reason = "Strong momentum alignment";
    } else if (emaGap <= -0.001 && trendWeakness < 0.3) {
        signal = "SHORT_CANDIDATE";
        side = "short";
        reason = "Strong downward momentum alignment";
    }

    return {
        signal,
        side,
        reason,
        baseSizeIntent: 1.2,
        recheckSuggested: false,
        metadata: { emaGap }
    };
}
