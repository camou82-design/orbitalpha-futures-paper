import { EngineV2Input, ExecutorOutput } from "../types";

export function executeRangeRegime(input: EngineV2Input): ExecutorOutput {
    const { snapshot: sn } = input;
    const boxPos = sn.boxPos ?? 0.5;

    let signal: ExecutorOutput["signal"] = "NONE";
    let side: ExecutorOutput["side"] = "none";
    let baseSizeIntent = 1.0;
    let recheckSuggested = false;

    if (boxPos >= 0.74) {
        side = "short";
        if (sn.rangeConfidence > 0.8) signal = "SHORT_CANDIDATE";
        else {
            signal = "WAIT_RECHECK";
            recheckSuggested = true;
        }
    } else if (boxPos <= 0.26) {
        side = "long";
        if (sn.rangeConfidence > 0.8) signal = "LONG_CANDIDATE";
        else {
            signal = "WAIT_RECHECK";
            recheckSuggested = true;
        }
    } else {
        reason: "Box mid-zone; avoiding chase";
    }

    return {
        signal,
        side,
        reason: signal === "NONE" ? "Mid-zone" : "Edge identified",
        baseSizeIntent,
        recheckSuggested,
        metadata: { boxPos }
    };
}
