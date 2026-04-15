import { EngineV2Input, ExecutorOutput } from "../types";

export function executeTransitionRegime(input: EngineV2Input): ExecutorOutput {
    let signal: ExecutorOutput["signal"] = "WAIT_RECHECK";
    let side: ExecutorOutput["side"] = "none";

    // Transition logic: Exploration only, small size
    return {
        signal,
        side,
        reason: "Transition zone search; passive waiting",
        baseSizeIntent: 0.5,
        recheckSuggested: true,
        metadata: {}
    };
}
