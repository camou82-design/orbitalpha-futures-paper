import { MarketSymbol, PositionSide } from "../../models/types";

export type EngineV2OpMode = "legacy" | "shadow_v2" | "engine_v2";
export type EngineV2Regime = "RANGE" | "TREND" | "TRANSITION" | "NO_TRADE";
export type EngineV2ConfidenceLevel = "HIGH" | "MID" | "LOW";
export type EngineV2SignalState = "LONG_CANDIDATE" | "SHORT_CANDIDATE" | "WAIT_RECHECK" | "NONE";
export type EngineV2Side = "long" | "short" | "none";
export type EngineV2FinalDecision = "ENTER" | "EXIT" | "SKIP" | "HOLD";

/** Engine-V2 Specific Position Type (Independent from legacy) */
export interface EngineV2Position {
    symbol: MarketSymbol;
    side: PositionSide;
    entryPrice: number;
    sizeUsd: number;
    entryStage: number;
    pnlPct: number;
}

/** 
 * Input Adapter: Bridges Legacy Objects to V2 
 * Ensures as any is never needed in bridge logic.
 */
export interface EngineV2Input {
    symbol: MarketSymbol;
    snapshot: EngineV2SnapshotAdapter;
    config: EngineV2ConfigAdapter;
    state: {
        currentPositions: EngineV2Position[];
        lossStreaks: Record<string, number>;
        globalRiskScore: number;
    };
    now: number;
    v1Result: {
        regime: string;
        decision: string;
        side: string;
        isBlocked: boolean;
    };
}

export interface EngineV2SnapshotAdapter {
    lastPrice: number;
    latestCandleClose: number;
    boxHigh: number | null;
    boxLow: number | null;
    boxPos: number | null;
    rangeConfidence: number | null;
    ema20: number | null;
    emaGap: number | null;
    volatilityProxy: number | null;
    boxCohesion01: number | null;
    breakoutFailureRate: number | null;
    trendWeaknessScore: number | null;
    reviewing_ticks: number | null;
    regimeExitRisk: number | null;
    boxBreakSide: "upper" | "lower" | "none" | null;
    signal: string;
    qualityScore: number;
}

export interface EngineV2ConfigAdapter {
    paperMaxOpenPositions: number;
    paperReentryCooldownMs: number;
    baseSizeUsd: number;
}

/** Final V2 Decision Object - Completely Independent Output */
export interface EngineV2Decision {
    symbol: MarketSymbol;
    ts: number;
    regime: EngineV2Regime;
    confidence: EngineV2ConfidenceLevel;
    confidenceScore: number;
    signal: EngineV2SignalState;
    side: EngineV2Side;
    decision: EngineV2FinalDecision;
    risk: {
        isBlocked: boolean;
        blockReason: string | null;
        sizeMultiplier: number;
        baseSizeUsd: number;
        finalSizeUsd: number;
        isAddOn: boolean;
    };
    explanation: {
        reason: string;
        uiLabelRegime: string;
        uiLabelStatus: string;
    };
    rawMetrics: Record<string, number | boolean>;
}

/** Final Adoption Result - Selector Wrapper */
export interface V2SelectorDecision {
    v1: {
        regime: string;
        decision: string;
        side: string | null;
        size: number;
    };
    v2: EngineV2Decision;
    adopted: {
        engine: "V1" | "V2";
        regime: string;
        decision: string;
        side: string | null;
        size: number;
        reason: string;
    };
    mismatch: boolean;
}

/** Tier 1: Market Judgment */
export interface MarketJudgmentOutput {
    regime: EngineV2Regime;
    reason: string;
    metrics: {
        rangeScore: number;
        trendScore: number;
        boxCohesionCollapse: boolean;
        mixedBreakoutState: boolean;
        emaExpansionWeak: boolean;
    };
}

/** Tier 2: Regime Confidence */
export interface RegimeConfidenceOutput {
    score: number;
    level: EngineV2ConfidenceLevel;
}

/** Tier 3: Engine Router */
export interface RouterOutput {
    executor: "RANGE" | "TREND" | "TRANSITION" | "NONE";
    reason: string;
}

/** Tier 4: Executor Output */
export interface ExecutorOutput {
    signal: EngineV2SignalState;
    side: EngineV2Side;
    reason: string;
    baseSizeIntent: number;
    recheckSuggested: boolean;
    isAddOnEligible: boolean;
    metadata: Record<string, string | number | boolean>;
}

/** Tier 5: Risk Sizing Output */
export interface RiskSizingOutput {
    baseSizeUsd: number;
    sizeMultiplier: number;
    finalSizeUsd: number;
    isBlocked: boolean;
    blockReason: string | null;
    isAddOn: boolean;
}

/** Tier 5: Add-on Policy Output */
export interface AddonPolicyOutput {
    allowed: boolean;
    addOnSizeUsd: number;
    reason: string;
}

/** Tier 5: Explanation Output */
export interface ExplanationOutput {
    reason: string;
    uiLabels: {
        regime: string;
        status: string;
    };
}

/** Internal Pipeline Result */
export interface EngineV2InternalResult {
    judgment: MarketJudgmentOutput;
    confidence: RegimeConfidenceOutput;
    routing: RouterOutput;
    execution: ExecutorOutput;
    riskSizing: RiskSizingOutput;
    explanation: ExplanationOutput;
}
