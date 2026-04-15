import { EngineV2Input, ExecutorOutput } from "../types";

export function executeTrendRegime(input: EngineV2Input): ExecutorOutput {
    const { snapshot: sn } = input;
    const emaGap = sn.emaGap || 0;
    const trendWeakness = sn.trendWeaknessScore || 0;

    let signal: ExecutorOutput["signal"] = "NONE";
    let side: ExecutorOutput["side"] = "none";

    if (emaGap > 0.001 && trendWeakness < 0.3) {
        signal = "LONG_CANDIDATE";
        side = "long";
    } else if (emaGap < -0.001 && trendWeakness < 0.3) {
        signal = "SHORT_CANDIDATE";
        side = "short";
    }

    return {
        signal,
        side,
        reason: signal !== "NONE" ? "Strong trend alignment" : "Trend weak or absent",
        baseSizeIntent: 1.2,
        recheckSuggested: false,
        metadata: { emaGap }
    };
}
