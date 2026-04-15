import { EngineV2Input, ExecutorOutput } from "../types";

/**
 * Tier 4: Range Executor (Refined)
 * Standard return structure and fixed syntax.
 */
export function executeRangeRegime(input: EngineV2Input): ExecutorOutput {
    const { snapshot: sn } = input;
    const boxPos = sn.boxPos ?? 0.5;
    const rangeConfidence = sn.rangeConfidence ?? 0;

    let signal: ExecutorOutput["signal"] = "NONE";
    let side: ExecutorOutput["side"] = "none";
    let baseSizeIntent = 1.0;
    let recheckSuggested = false;
    let reason = "Watching mid-zone";

    if (boxPos >= 0.74) {
        side = "short";
        if (rangeConfidence > 0.8) {
            signal = "SHORT_CANDIDATE";
            reason = "Upper edge reversal identified";
        } else {
            signal = "WAIT_RECHECK";
            reason = "Upper edge reached; awaiting confirmation";
            recheckSuggested = true;
        }
    } else if (boxPos <= 0.26) {
        side = "long";
        if (rangeConfidence > 0.8) {
            signal = "LONG_CANDIDATE";
            reason = "Lower edge reversal identified";
        } else {
            signal = "WAIT_RECHECK";
            reason = "Lower edge reached; awaiting confirmation";
            recheckSuggested = true;
        }
    }

    return {
        signal: signal,
        side: side,
        reason: signal === "NONE" ? "NO_RANGE_EDGE" : reason,
        baseSizeIntent: signal === "NONE" ? 0 : 1,
        recheckSuggested: recheckSuggested,
        isAddOnEligible: true, // RANGE allow add-ons
        metadata: {
            boxPos: input.snapshot.boxPos
        }
    };
}
