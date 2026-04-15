import { EngineV2Input, EngineV2Output } from "./types";
import { detectMarketRegime } from "./market-judgment/detector";
import { calculateRegimeConfidence } from "./regime-confidence/scorer";
import { routeToExecutor } from "./engine-router/selector";
import { executeRangeRegime } from "./executors/range-executor";
import { executeTrendRegime } from "./executors/trend-executor";
import { executeTransitionRegime } from "./executors/transition-executor";
import { calculateRiskSizing } from "./risk-sizing/policy";
import { evaluateAddonPolicy } from "./risk-sizing/add-on-policy";
import { generateExplanation } from "./explain/diagnostic";

export function runEngineV2(input: EngineV2Input): EngineV2Output {
    const judgment = detectMarketRegime(input);
    const confidence = calculateRegimeConfidence(judgment, input);
    const routing = routeToExecutor(judgment, confidence);

    let execution;
    if (routing.executor === "RANGE") execution = executeRangeRegime(input);
    else if (routing.executor === "TREND") execution = executeTrendRegime(input);
    else if (routing.executor === "TRANSITION") execution = executeTransitionRegime(input);
    else execution = { signal: "NONE", side: "none", reason: "None", baseSizeIntent: 0, recheckSuggested: false, metadata: {} };

    const riskSizing = calculateRiskSizing(judgment, confidence, execution as any, input);
    const addon = evaluateAddonPolicy(judgment, riskSizing, input);
    riskSizing.addOnAllowed = addon.allowed;
    riskSizing.addOnSizeUsd = addon.addOnSizeUsd;

    const explanation = generateExplanation(judgment, execution as any, riskSizing);

    return {
        ts: Date.now(),
        symbol: input.symbol,
        judgment,
        confidence,
        routing,
        execution: execution as any,
        riskSizing,
        explanation
    };
}
