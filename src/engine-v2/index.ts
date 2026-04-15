import { EngineV2Input, EngineV2Decision, EngineV2InternalResult, EngineV2FinalDecision } from "./types";
import type { MarketSymbol } from "../models/types";
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

    const isBlocked = riskSizing.isBlocked;
    const invalidSignalForEnter = execution.signal === "NONE" || execution.signal === "WAIT_RECHECK";
    const invalidSideForEnter = execution.side === "none";
    const invalidSize = riskSizing.finalSizeUsd <= 0;

    /**
     * Standard Execution Authority:
     * ENTER is ONLY allowed if:
     * 1. Signal is valid (LONG/SHORT_CANDIDATE)
     * 2. Side is valid (long/short)
     * 3. Risk sizing did not block the trade
     * 4. Final size is greater than 0
     */
    if (!isBlocked && !invalidSignalForEnter && !invalidSideForEnter && !invalidSize) {
        finalDecision = "ENTER";
    } else {
        finalDecision = "SKIP";
    }

    // Tier 5: Explanation
    const explanation = generateExplanation(judgment, execution, riskSizing);
    const finalReason = isBlocked
        ? `BLOCKED: ${riskSizing.blockReason}`
        : (finalDecision === "ENTER" ? explanation.reason : `SKIPPED: ${execution.reason}`);

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
            reason: finalReason,
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

/** 
 * Legacy-to-V2 Input Adapter to eliminate 'as any' in bridge.
 * Maps legacy complex objects into strictly typed EngineV2Input.
 */
export function adaptV2Input(
    symbol: MarketSymbol,
    now: number,
    snapshot: any,
    config: any,
    state: any,
    v1Decision: any
): EngineV2Input {
    return {
        symbol,
        now,
        snapshot: {
            lastPrice: Number(snapshot.lastPrice) || 0,
            latestCandleClose: Number(snapshot.latestCandleClose) || 0,
            boxHigh: snapshot.boxHigh,
            boxLow: snapshot.boxLow,
            boxPos: snapshot.boxPosDiag,
            rangeConfidence: snapshot.rangeConfidenceDiag,
            ema20: snapshot.ema20,
            emaGap: snapshot.emaGapDiag,
            volatilityProxy: snapshot.volatilityProxyDiag,
            boxCohesion01: snapshot.boxCohesion01 || snapshot.boxCohesionDiag || 0,
            breakoutFailureRate: snapshot.breakoutFailureRate || snapshot.breakoutFailureRateDiag || 0,
            trendWeaknessScore: snapshot.trendWeaknessScore || snapshot.trendWeaknessDiag || 0,
            reviewing_ticks: snapshot.reviewing_ticks || 0,
            regimeExitRisk: snapshot.regimeExitRisk || 0,
            boxBreakSide: snapshot.boxBreakSide || "none",
            signal: snapshot.signal || "NONE",
            qualityScore: Number(snapshot.qualityScore) || 0
        },
        config: {
            paperMaxOpenPositions: Number(config.paperMaxOpenPositions) || 5,
            paperReentryCooldownMs: Number(config.paperReentryCooldownMs) || 180000,
            baseSizeUsd: Number(config.baseSizeUsd) || 100
        },
        state: {
            currentPositions: (state.currentPositions || []).map((p: any) => ({
                symbol: p.symbol,
                side: p.side === "long" ? "LONG" : "SHORT",
                entryPrice: p.entryPrice,
                sizeUsd: p.sizeUsd,
                entryStage: p.entryStage || 0,
                pnlPct: p.pnlPct || 0
            })),
            globalRiskScore: Number(state.globalRiskScore) || 0,
            lossStreaks: state.lossStreaks || {}
        },
        v1Result: {
            regime: String(v1Decision.decision?.regime_state || "UNDEFINED"),
            decision: String(v1Decision.decision?.final_decision || "SKIP"),
            side: String(v1Decision.intentSide || "none"),
            isBlocked: !!v1Decision.decision?.reject_reason
        }
    };
}
