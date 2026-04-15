import { EngineV2Input, ExecutorOutput, RiskSizingOutput, MarketJudgmentOutput, RegimeConfidenceOutput } from "../types";

/**
 * Tier 5: Risk & Sizing Policy (Refined)
 * Adjusts size based on regime and confidence.
 */
export function calculateRiskSizing(
    judgment: MarketJudgmentOutput,
    confidence: RegimeConfidenceOutput,
    executor: ExecutorOutput,
    input: EngineV2Input
): RiskSizingOutput {
    const { config } = input;
    const baseSizeUsd = config.baseSizeUsd;
    let sizeMultiplier = executor.baseSizeIntent;
    let isBlocked = false;
    let blockReason = undefined;

    // NO_TRADE: Hard block
    if (judgment.regime === "NO_TRADE") {
        isBlocked = true;
        blockReason = "NO_TRADE_REGIME";
    }
    // WAIT_RECHECK: Block but diagnostic handled via explanation
    else if (executor.signal === "WAIT_RECHECK") {
        isBlocked = true;
        blockReason = "WAIT_RECHECK";
    }

    // TRANSITION: Scale down
    if (judgment.regime === "TRANSITION") {
        sizeMultiplier *= 0.5;
    }

    // Confidence adjustment
    if (confidence.level === "MID") {
        sizeMultiplier *= 0.8;
    } else if (confidence.level === "LOW") {
        sizeMultiplier *= 0.5;
    }

    return {
        baseSizeUsd,
        sizeMultiplier,
        finalSizeUsd: isBlocked ? 0 : baseSizeUsd * sizeMultiplier,
        isBlocked,
        blockReason: blockReason || null,
        isAddOn: false // Logic for add-on will be handled by addon-policy if needed
    };
}
