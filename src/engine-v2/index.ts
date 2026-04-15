import { EngineV2Input, EngineV2Decision, EngineV2InternalResult, EngineV2FinalDecision } from "./types";
import { detectMarketRegime } from "./market-judgment/detector";
import { calculateRegimeConfidence } from "./regime-confidence/scorer";
import { routeToExecutor } from "./engine-router/selector";
import { executeRangeRegime } from "./executors/range-executor";
import { executeTrendRegime } from "./executors/trend-executor";
import { executeTransitionRegime } from "./executors/transition-executor";
import { calculateRiskSizing } from "./risk-sizing/policy";
import { generateExplanation } from "./explain/diagnostic";

/**
 * orchestrator for Engine-V2 5-tier architecture.
 * Produces an independent EngineV2Decision.
 */
export function runEngineV2(input: EngineV2Input): { decision: EngineV2Decision; internal: EngineV2InternalResult } {
    // Tier 1: Market Judgment
    const judgment = detectMarketRegime(input);

    // Tier 2: Regime Confidence
    const confidence = calculateRegimeConfidence(judgment, input);

    // Tier 3: Engine Router
    const routing = routeToExecutor(judgment, confidence);

    // Tier 4: Executors
    let execution;
    if (routing.executor === "RANGE") execution = executeRangeRegime(input);
    else if (routing.executor === "TREND") execution = executeTrendRegime(input);
    else if (routing.executor === "TRANSITION") execution = executeTransitionRegime(input);
    else {
        execution = {
            signal: "NONE" as const,
            side: "none" as const,
            reason: "No Routing",
            baseSizeIntent: 0,
            recheckSuggested: false,
            isAddOnEligible: false,
            metadata: {}
        };
    }

    // Tier 5: Risk Sizing
    const riskSizing = calculateRiskSizing(judgment, confidence, execution, input);

    // Final Decision Formulation (Authority Enforcer)
    let finalDecision: EngineV2FinalDecision = "SKIP";

    // Strict Condition: ENTER requires non-NONE signal AND valid side AND not blocked
    const canEnter = !riskSizing.isBlocked &&
        execution.signal !== "NONE" &&
        execution.signal !== "WAIT_RECHECK" &&
        execution.side !== "none";

    if (canEnter) {
        finalDecision = "ENTER";
    }

    // Tier 5: Explanation
    const explanation = generateExplanation(judgment, execution, riskSizing);

    const decision: EngineV2Decision = {
        symbol: input.symbol,
        ts: input.now,
        regime: judgment.regime,
        confidence: confidence.level,
        confidenceScore: confidence.score,
        signal: execution.signal,
        side: execution.side,
        decision: finalDecision,
        risk: {
            isBlocked: riskSizing.isBlocked,
            blockReason: riskSizing.blockReason,
            sizeMultiplier: riskSizing.sizeMultiplier,
            baseSizeUsd: riskSizing.baseSizeUsd,
            finalSizeUsd: riskSizing.finalSizeUsd,
            isAddOn: riskSizing.isAddOn
        },
        explanation: {
            reason: explanation.reason,
            uiLabelRegime: explanation.uiLabels.regime,
            uiLabelStatus: explanation.uiLabels.status
        },
        rawMetrics: judgment.metrics
    };

    const internal: EngineV2InternalResult = {
        judgment,
        confidence,
        routing,
        execution,
        riskSizing,
        explanation
    };

    return { decision, internal };
}
