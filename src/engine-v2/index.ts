import {
    EngineV2Input,
    EngineV2Decision,
    EngineV2InternalResult,
    EngineV2FinalDecision,
    LegacySnapshotAdapter,
    LegacyConfigAdapter,
    LegacyPositionAdapter,
    LegacyResultAdapter
} from "./types";
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
    const isWait = execution.signal === "WAIT_RECHECK";
    const invalidSignal = execution.signal === "NONE";
    const invalidSide = execution.side === "none";
    const invalidSize = riskSizing.finalSizeUsd <= 0;

    if (isBlocked) {
        // Distinguish between REJECT (soft) and DISABLED (hard)
        if (riskSizing.blockReason?.includes("MAX_POSITIONS") || riskSizing.blockReason?.includes("COOLDOWN")) {
            finalDecision = "REJECT";
        } else {
            finalDecision = "DISABLED";
        }
    } else if (isWait) {
        finalDecision = "HOLD";
    } else if (invalidSignal || invalidSide || invalidSize) {
        finalDecision = "SKIP";
    } else {
        finalDecision = "ENTER";
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
 * Legacy-to-V2 Input Adapter (Zero Any).
 * Maps legacy complex objects through strict adapter interfaces.
 */
export function adaptV2Input(
    symbol: MarketSymbol,
    now: number,
    snapshot: LegacySnapshotAdapter,
    config: LegacyConfigAdapter,
    state: { currentPositions: LegacyPositionAdapter[], globalRiskScore: number, lossStreaks: Record<string, number> },
    v1Result: LegacyResultAdapter
): EngineV2Input {
    return {
        symbol,
        now,
        snapshot: {
            lastPrice: snapshot.lastPrice,
            latestCandleClose: snapshot.latestCandleClose,
            boxHigh: snapshot.boxHigh,
            boxLow: snapshot.boxLow,
            boxPos: snapshot.boxPosDiag,
            rangeConfidence: snapshot.rangeConfidenceDiag,
            ema20: snapshot.ema20,
            emaGap: snapshot.emaGapDiag,
            volatilityProxy: snapshot.volatilityProxyDiag,
            boxCohesion01: snapshot.boxCohesion01 ?? snapshot.boxCohesionDiag ?? 0,
            breakoutFailureRate: snapshot.breakoutFailureRate ?? snapshot.breakoutFailureRateDiag ?? 0,
            trendWeaknessScore: snapshot.trendWeaknessScore ?? snapshot.trendWeaknessDiag ?? 0,
            reviewing_ticks: snapshot.reviewing_ticks ?? 0,
            regimeExitRisk: snapshot.regimeExitRisk ?? 0,
            boxBreakSide: snapshot.boxBreakSide ?? "none",
            signal: snapshot.signal ?? "NONE",
            qualityScore: snapshot.qualityScore ?? 0
        },
        config: {
            paperMaxOpenPositions: config.paperMaxOpenPositions,
            paperReentryCooldownMs: config.paperReentryCooldownMs,
            baseSizeUsd: config.baseSizeUsd
        },
        state: {
            currentPositions: state.currentPositions.map((p: LegacyPositionAdapter) => ({
                symbol: p.symbol,
                side: p.side === "long" ? "LONG" : "SHORT" as const,
                entryPrice: p.entryPrice,
                sizeUsd: p.sizeUsd,
                entryStage: p.entryStage ?? 0,
                pnlPct: p.pnlPct ?? 0
            })),
            globalRiskScore: state.globalRiskScore,
            lossStreaks: state.lossStreaks
        },
        v1Result: {
            regime: v1Result.decision?.regime_state ?? "UNDEFINED",
            decision: v1Result.decision?.final_decision ?? "SKIP",
            side: v1Result.intentSide ?? "none",
            isBlocked: !!v1Result.decision?.reject_reason
        }
    };
}
