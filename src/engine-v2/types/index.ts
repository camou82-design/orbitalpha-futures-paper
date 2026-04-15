import { PaperRegimeState, PaperSignalState, MarketSymbol, PositionSide } from "../../models/types";

export type EngineV2OpMode = "legacy" | "shadow_v2" | "engine_v2";
export type EngineV2Regime = "RANGE" | "TREND" | "TRANSITION" | "NO_TRADE";
export type EngineV2ConfidenceLevel = "HIGH" | "MID" | "LOW";
export type EngineV2SignalState = "LONG_CANDIDATE" | "SHORT_CANDIDATE" | "WAIT_RECHECK" | "NONE";
export type EngineV2Side = "long" | "short" | "none";

/** Specific interfaces to replace 'any' */
export interface EngineV2Snapshot {
    boxPos?: number | null;
    rangeConfidence?: number | null;
    boxCohesion01?: number | null;
    breakoutFailureRate?: number | null;
    trendWeaknessScore?: number | null;
    emaGap?: number | null;
    volumeRatioProxy?: number | null;
    reviewing_ticks?: number | null;
    [key: string]: any;
}

export interface EngineV2Config {
    defaultPaperSizeUsd?: number;
    paperMaxOpenPositions?: number;
    [key: string]: any;
}

export interface EngineV2State {
    currentPositions: any[];
    lossStreaks: Record<string, number>;
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
    metadata: Record<string, any>;
}

/** Tier 5: Risk Sizing Output */
export interface RiskSizingOutput {
    baseSizeUsd: number;
    sizeMultiplier: number;
    finalSizeUsd: number;
    isBlocked: boolean;
    blockReason?: string;
    addOnAllowed: boolean;
    addOnSizeUsd: number;
}

/** Tier 5: Add-on Policy Output */
export interface AddonPolicyOutput {
    allowed: boolean;
    addOnSizeUsd: number;
    ratioVsInitial: number;
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

/** Composite V2 Output */
export interface EngineV2Output {
    ts: number;
    symbol: MarketSymbol;
    judgment: MarketJudgmentOutput;
    confidence: RegimeConfidenceOutput;
    routing: RouterOutput;
    execution: ExecutorOutput;
    riskSizing: RiskSizingOutput;
    explanation: ExplanationOutput;
}

/** Input for V2 Pipeline */
export interface EngineV2Input {
    symbol: MarketSymbol;
    snapshot: EngineV2Snapshot;
    config: EngineV2Config;
    state: EngineV2State;
}
