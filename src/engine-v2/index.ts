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

    // Tier 5: Explanation (Diagnostics)
    const explanation = generateExplanation(judgment, execution, riskSizing);

    // Final Decision Formulation (Authority Enforcer)
    let finalDecision: EngineV2FinalDecision = "SKIP";

    const rawSignal = input.snapshot?.signal ?? "none";
    const hasRawCandidate =
        rawSignal === "paper_long_candidate" ||
        rawSignal === "paper_short_candidate" ||
        input.snapshot?.entryCandidate === true;

    const hardNoTrade =
        judgment.data_ready === false ||
        judgment.dump_protection_hit === true;

    const softNoTrade =
        judgment.volatility_guard_hit === true ||
        judgment.regime_final === "NO_TRADE" ||
        judgment.no_trade_reason != null;

    const isBlocked = riskSizing.isBlocked;
    const invalidNoneSignal = execution.signal === "NONE";
    const waitingRecheck = execution.signal === "WAIT_RECHECK";
    const invalidSideForEnter = execution.side === "none";
    const invalidSize = riskSizing.finalSizeUsd <= 0;
    const blockReason = riskSizing.blockReason ?? null;

    if (hardNoTrade) {
        finalDecision = "DISABLED";
    } else if (softNoTrade && hasRawCandidate) {
        finalDecision = "HOLD";
    } else if (softNoTrade) {
        finalDecision = "DISABLED";
    } else if (waitingRecheck) {
        finalDecision = "HOLD";
    } else if (isBlocked && blockReason === "NO_TRADE_REGIME") {
        finalDecision = "DISABLED";
    } else if (isBlocked) {
        finalDecision = "REJECT";
    } else if (invalidNoneSignal) {
        finalDecision = "SKIP";
    } else if (invalidSideForEnter) {
        finalDecision = "SKIP";
    } else if (invalidSize) {
        finalDecision = "REJECT";
    } else {
        finalDecision = "ENTER";
    }

    if (softNoTrade && hasRawCandidate && !hardNoTrade) {
        explanation.reason = "SOFT_NO_TRADE_DOWNGRADED_TO_HOLD";
        explanation.summary = "신호는 있으나 상위 시장판단이 보수적으로 작동해 즉시 진입 대신 재확인 대기";
    }

    let finalReason: string;
    if (finalDecision === "ENTER") {
        finalReason = explanation.reason;
    } else if (finalDecision === "HOLD") {
        finalReason = `HOLD: ${explanation.reason || execution.reason}`;
    } else if (finalDecision === "DISABLED") {
        finalReason = `DISABLED: ${judgment.no_trade_reason ?? blockReason ?? judgment.regime}`;
    } else if (finalDecision === "REJECT") {
        finalReason = `REJECTED: ${blockReason ?? execution.reason}`;
    } else {
        finalReason = `SKIPPED: ${execution.reason}`;
    }

    const decision: EngineV2Decision = {
        symbol: input.symbol,
        ts: input.now,
        regime: judgment.regime,
        confidence: confidence.level,
        confidenceScore: confidence.score,
        signal: execution.signal,
        side: execution.side,
        decision: finalDecision,
        risk: riskSizing,
        explanation: {
            reason: finalReason,
            uiLabelRegime: judgment.regime,
            uiLabelStatus: finalDecision === "ENTER" ? "ACTIVE" : "IDLE"
        },
        rawMetrics: {
            ...judgment.metrics,
            confidenceScore: confidence.score,
            sizingMultiplier: riskSizing.sizeMultiplier
        }
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
            boxHigh: snapshot.boxHigh ?? 0,
            boxLow: snapshot.boxLow ?? 0,
            boxPos: snapshot.boxPosDiag ?? 0,
            rangeConfidence: snapshot.rangeConfidenceDiag ?? 0,
            ema20: snapshot.ema20 ?? 0,
            emaGap: snapshot.emaGapDiag ?? 0,
            volatilityProxy: snapshot.volatilityProxyDiag ?? 0,
            boxCohesion01: snapshot.boxCohesion01 ?? snapshot.boxCohesionDiag ?? 0,
            breakoutFailureRate: snapshot.breakoutFailureRate ?? snapshot.breakoutFailureRateDiag ?? 0,
            trendWeaknessScore: snapshot.trendWeaknessScore ?? snapshot.trendWeaknessDiag ?? 0,
            reviewing_ticks: snapshot.reviewing_ticks ?? 0,
            regimeExitRisk: snapshot.regimeExitRisk ?? 0,
            boxBreakSide: snapshot.boxBreakSide ?? "none",
            signal: snapshot.signal ?? "NONE",
            qualityScore: snapshot.qualityScore ?? 0,
            data_ready: snapshot.data_ready ?? true,
            dump_protection_hit: snapshot.dump_protection_hit ?? false,
            volatility_guard_hit: snapshot.volatility_guard_hit ?? false,
            entryCandidate: snapshot.entryCandidate ?? false
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
