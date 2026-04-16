import { MarketSymbol, PositionSide } from "../../models/types";

export type EngineV2OpMode = "legacy" | "shadow_v2" | "engine_v2";
export type EngineV2Regime = "RANGE" | "TREND" | "TRANSITION" | "NO_TRADE";
export type EngineV2ConfidenceLevel = "HIGH" | "MID" | "LOW";
export type EngineV2SignalState = "LONG_CANDIDATE" | "SHORT_CANDIDATE" | "WAIT_RECHECK" | "NONE";
export type EngineV2Side = "long" | "short" | "none" | null;
export type EngineV2FinalDecision = "ENTER" | "EXIT" | "SKIP" | "HOLD" | "REJECT" | "DISABLED";

/** Legacy Result Interface for Bridge (Zero-any policy) */
export interface LegacyDecisionResult {
    decision: {
        regime_state: string;
        final_decision: string;
        reject_reason: string | null;
        required_cost_usd: number;
        original_signal_state?: string;
        final_signal_state?: string;
        execution_disabled_reason?: string | null;
        supplemental_reasons?: string[];
    };
    executorDecision: {
        entry_allowed: boolean;
        total_cost: number;
        executor?: string;
        expected_move?: number;
        risk_state?: string;
        detail?: any;
    } | null;
    intentSide: EngineV2Side;
    adaptiveOk: boolean;
    adaptiveDetail?: any;
}

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
 * Zero 'any' policy.
 */
export interface LegacySnapshotAdapter {
    lastPrice: number;
    latestCandleClose: number;
    boxHigh: number | null;
    boxLow: number | null;
    boxPosDiag: number | null;
    rangeConfidenceDiag: number | null;
    ema20: number | null;
    emaGapDiag: number | null;
    volatilityProxyDiag: number | null;
    boxCohesion01?: number;
    boxCohesionDiag?: number;
    breakoutFailureRate?: number;
    breakoutFailureRateDiag?: number;
    trendWeaknessScore?: number;
    trendWeaknessDiag?: number;
    reviewing_ticks?: number;
    regimeExitRisk?: number;
    boxBreakSide?: "upper" | "lower" | "none";
    signal?: string;
    qualityScore?: number;
}

export interface LegacyConfigAdapter {
    paperMaxOpenPositions: number;
    paperReentryCooldownMs: number;
    baseSizeUsd: number;
}

export interface LegacyPositionAdapter {
    symbol: MarketSymbol;
    side: PositionSide | "long" | "short";
    entryPrice: number;
    sizeUsd: number;
    entryStage?: number;
    pnlPct?: number;
}

export interface LegacyResultAdapter {
    decision?: {
        regime_state?: string;
        final_decision?: string;
        reject_reason?: string | null;
        required_cost_usd?: number;
    };
    executorDecision?: {
        entry_allowed?: boolean;
        total_cost?: number;
    } | null;
    intentSide?: EngineV2Side;
}

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
    boxCohesion01: number;
    breakoutFailureRate: number;
    trendWeaknessScore: number;
    reviewing_ticks: number;
    regimeExitRisk: number;
    boxBreakSide: "upper" | "lower" | "none";
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

/** 
 * Bridge Input (Phase 4 Strict Decoupling) 
 * Defines all data required for reconciliation without exposing PaperEngine internals.
 */
/** 
 * V2 INDEPENDENT BRIDGE DTOs (Phase 5)
 * These interfaces decouple engine-v2 from the main paper-engine types.
 */
export interface V2BridgeSnapshot {
    lastPrice: number;
    latestCandleClose: number;
    boxHigh: number;
    boxLow: number;
    boxPos: number;
    rangeConfidence: number;
    ema20: number;
    emaGap: number;
    atr: number;
    signal: string;
    qualityScore: number;
}

export interface V2BridgeLegacyDecision {
    regime: string;
    finalDecision: string;
    rejectReason: string | null;
    requiredCostUsd: number;
    entryAllowed: boolean;
    executorLabel: string;
    intentSide: string | null;
    adaptiveOk: boolean;
    adaptiveDetail?: any;
}

export interface V2BridgeConfig {
    baseSizeUsd: number;
    maxOpenPositions: number;
    reentryCooldownMs: number;
}

export interface V2BridgePosition {
    symbol: MarketSymbol;
    side: "LONG" | "SHORT";
    entryPrice: number;
    sizeUsd: number;
    entryStage: number;
}

export interface V2BridgeState {
    currentPositions: V2BridgePosition[];
    globalRiskScore: number;
    lossStreaks: Record<string, number>;
}

export interface V2BridgeInput {
    symbol: MarketSymbol;
    fetchedAt: number;
    snapshot: V2BridgeSnapshot;
    legacy: V2BridgeLegacyDecision;
    config: V2BridgeConfig;
    state: V2BridgeState;
    v2Mode: EngineV2OpMode;
}

export interface EngineV2AdoptionOutcome {
    engine: "V1" | "V2";
    adopted_decision: EngineV2FinalDecision;
    adopted_regime: string;
    adopted_side: EngineV2Side;
    adopted_size_usd: number;
    adoption_reason: string;
}

export interface EngineV2SelectorResult {
    legacy_result: {
        regime: string;
        decision: EngineV2FinalDecision;
        side: EngineV2Side;
        size: number;
    };
    v2_result: EngineV2Decision;
    adopted_result: EngineV2AdoptionOutcome;
    mismatch: boolean;
}

/** 
 * Unified Bridge Interface (Phase 4 Strict Decoupling) 
 * Zero-any entry point for the paper engine. 
 */
export interface SymbolDecisionEnvelope {
    legacy: LegacyDecisionResult;
    selector: EngineV2SelectorResult | null;
    authority: EntryExecutionAuthority;
    // V1/V2 Comparison Metrics (Phase 5 Summary)
    v1_decision?: string;
    v1_side?: string;
    v1_size?: number;
    v2_decision?: string;
    v2_side?: string;
    v2_size?: number;
    selector_mismatch?: boolean;
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

/** Unified Execution Authority (Phase 4 Independence) */
export type EntryExecutionAuthority = Readonly<{
    decision: EngineV2FinalDecision;
    side: EngineV2Side;
    sizeUsd: number;
    regime: string;
    source: "v1" | "v2";
}>;

/** Internal Pipeline Result */
export interface EngineV2InternalResult {
    judgment: MarketJudgmentOutput;
    confidence: RegimeConfidenceOutput;
    routing: RouterOutput;
    execution: ExecutorOutput;
    riskSizing: RiskSizingOutput;
    explanation: ExplanationOutput;
}
