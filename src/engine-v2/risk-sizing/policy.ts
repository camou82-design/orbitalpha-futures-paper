import { EngineV2Input, ExecutorOutput, RiskSizingOutput, MarketJudgmentOutput, RegimeConfidenceOutput } from "../types";

export function calculateRiskSizing(
    judgment: MarketJudgmentOutput,
    confidence: RegimeConfidenceOutput,
    executor: ExecutorOutput,
    input: EngineV2Input
): RiskSizingOutput {
    const baseSizeUsd = input.config.defaultPaperSizeUsd || 100;
    let sizeMultiplier = executor.baseSizeIntent;
    let isBlocked = false;
    let blockReason = undefined;

    if (judgment.regime === "NO_TRADE") {
        isBlocked = true;
        blockReason = "NO_TRADE_REGIME";
    } else if (executor.signal === "WAIT_RECHECK") {
        isBlocked = true;
        blockReason = "WAIT_RECHECK";
    }

    if (judgment.regime === "TRANSITION") {
        sizeMultiplier *= 0.5;
    }

    if (confidence.level === "MID") {
        sizeMultiplier *= 0.8;
    }

    return {
        baseSizeUsd,
        sizeMultiplier,
        finalSizeUsd: isBlocked ? 0 : baseSizeUsd * sizeMultiplier,
        isBlocked,
        blockReason,
        addOnAllowed: false, // Updated by add-on policy
        addOnSizeUsd: 0
    };
}
