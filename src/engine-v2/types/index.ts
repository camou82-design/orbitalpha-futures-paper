import { MarketSymbol, PositionSide } from "../../models/types";
import type { V2ExecutionAuthorityEnvelope, V2LegacyComparison } from "../execution/types";

export type EngineV2OpMode = "legacy" | "shadow_v2" | "engine_v2";
export type EngineV2Regime = "RANGE" | "TREND" | "TRANSITION" | "NO_TRADE";
export type EngineV2ConfidenceLevel = "HIGH" | "MID" | "LOW";
export type EngineV2MarketSubtype =
    | "RANGE_MID_CHOP"
    | "RANGE_LOWER_REACTION"
    | "RANGE_UPPER_REACTION"
    | "RANGE_BREAKDOWN_CANDIDATE"
    | "RANGE_BREAKOUT_CANDIDATE"
    | "RANGE_FAKE_BREAKOUT"
    | "TREND_UP_CONTINUATION"
    | "TREND_DOWN_CONTINUATION"
    | "TREND_PULLBACK"
    | "TREND_EXHAUSTION"
    | "TRANSITION_RANGE_TO_TREND"
    | "TRANSITION_TREND_TO_RANGE"
    | "TRANSITION_CONFLICT"
    | "SHOCK_REACTION_DOWN"
    | "SHOCK_REACTION_UP"
    | "NO_TRADE_DATA_NOT_READY"
    | "NO_TRADE_DUMP_PROTECTION"
    | "NO_TRADE_METRICS_INSUFFICIENT";
export type EngineV2SignalState = "LONG_CANDIDATE" | "SHORT_CANDIDATE" | "WAIT_RECHECK" | "NONE";
export type EngineV2Side = "long" | "short" | "none" | null;
export type EngineV2FinalDecision = "ENTER" | "EXIT" | "SKIP" | "HOLD" | "REJECT" | "DISABLED";
export type LeverageProfile = "BASE" | "BOOST_1" | "BOOST_2";
export type EntryQualityGrade = "S" | "A" | "B";
export type TransitionSetupType =
    | "RANGE_TO_TREND_UP"
    | "RANGE_TO_TREND_DOWN"
    | "TREND_TO_RANGE_WEAKENING"
    | "CONFLICT_NO_TRADE"
    | "SHOCK_DOWN_REACTION"
    | "SHOCK_UP_REACTION"
    | "NONE";
export type TransitionAction = "WATCH" | "CONFIRM" | "REJECT";

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
        detail?: Record<string, unknown> | null;
    } | null;
    intentSide: EngineV2Side;
    adaptiveOk: boolean;
    adaptiveDetail?: Record<string, unknown> | null;
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
    data_ready?: boolean;
    dump_protection_hit?: boolean;
    volatility_guard_hit?: boolean;
    entryCandidate?: boolean;
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
        directionalShockState: "UP" | "DOWN" | "NONE";
        longAllow: boolean;
        shortAllow: boolean;
        executionReadiness: boolean;
        paperExecutionReady?: boolean;
        signedExecutionReady?: boolean;
        okxAuthMode?: "disabled" | "demo" | "live";
        okxAuthReady?: boolean;
        okxExchangeAuthOptIn?: boolean;
        okxLiveEnabled?: boolean;
        okxDemoEnabled?: boolean;
        okxApiKeyPresent?: boolean;
        okxApiSecretPresent?: boolean;
        okxPassphrasePresent?: boolean;
        okxSimulatedTradingHeaderEnabled?: boolean;
        liveMaxOrderNotionalUsdt?: number;
        freshTickBarrierActive: boolean;
        /** Same tick / post-barrier: execution must not proceed until cleared at end of tick. */
        freshTickExecutionBlocked?: boolean;
        freshTickCompletedCycles: number;
        freshTickRequiredCycles: number;
        entryQualityProfiles?: {
            profit: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number };
            loss: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number };
            contaminated: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number };
        };
        serverTradeEnabled?: boolean;
        closeOnlyMode?: boolean;
        killSwitch?: boolean;
        reconcileSafeMode?: boolean;
        killSwitchActive?: boolean;
        reconcileSafeModeActive?: boolean;
        riskMode?: string;
        dailyLossGuardTriggered?: boolean;
        crashState?: string;
        pumpState?: string;
        pump_state?: string;
        accountEquityKrw?: number;
        maxUsableMarginKrw?: number;
        exposureNotionalCapKrw?: number;
        symbolExposureNotionalCapKrw?: number;
        addOnPolicyAllowed?: boolean;
        addOnPolicyReason?: string;
        addOnPolicyAction?: string;
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
    data_ready: boolean;
    dump_protection_hit: boolean;
    volatility_guard_hit: boolean;
    entryCandidate: boolean;
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
    risk: RiskSizingOutput;
    explanation: {
        reason: string;
        uiLabelRegime: string;
        uiLabelStatus: string;
    };
    microExecution?: MicroExecutionScoreSummary;
    lifecycleAuthority?: V2TradeLifecycleAuthorityResult;
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
    adaptiveDetail?: Record<string, unknown> | null;
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
    directionalShockState: "UP" | "DOWN" | "NONE";
    longAllow: boolean;
    shortAllow: boolean;
    executionReadiness: boolean;
    paperExecutionReady?: boolean;
    signedExecutionReady?: boolean;
    okxAuthMode?: "disabled" | "demo" | "live";
    okxAuthReady?: boolean;
    okxExchangeAuthOptIn?: boolean;
    okxLiveEnabled?: boolean;
    okxDemoEnabled?: boolean;
    okxApiKeyPresent?: boolean;
    okxApiSecretPresent?: boolean;
    okxPassphrasePresent?: boolean;
    okxSimulatedTradingHeaderEnabled?: boolean;
    liveMaxOrderNotionalUsdt?: number;
    freshTickBarrierActive: boolean;
    /** Paper engine: block V2 ENTER until fresh-tick gate clears (includes same-tick post-cycle race). */
    freshTickExecutionBlocked?: boolean;
    freshTickCompletedCycles: number;
    freshTickRequiredCycles: number;
    entryQualityProfiles?: {
        profit: {
            qualityScoreAvg: number;
            emaGapAvg: number;
            atrPctAvg: number;
            volumeRatioAvg: number;
            count: number;
        };
        loss: {
            qualityScoreAvg: number;
            emaGapAvg: number;
            atrPctAvg: number;
            volumeRatioAvg: number;
            count: number;
        };
        contaminated: {
            qualityScoreAvg: number;
            emaGapAvg: number;
            atrPctAvg: number;
            volumeRatioAvg: number;
            count: number;
        };
    };
    serverTradeEnabled?: boolean;
    closeOnlyMode?: boolean;
    killSwitch?: boolean;
    reconcileSafeMode?: boolean;
    killSwitchActive?: boolean;
    reconcileSafeModeActive?: boolean;
    riskMode?: string;
    dailyLossGuardTriggered?: boolean;
    crashState?: string;
    pumpState?: string;
    pump_state?: string;
    accountEquityKrw?: number;
    maxUsableMarginKrw?: number;
    exposureNotionalCapKrw?: number;
    symbolExposureNotionalCapKrw?: number;
    addOnPolicyAllowed?: boolean;
    addOnPolicyReason?: string;
    addOnPolicyAction?: string;
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
    execution_authority_source?: string;
    execution_authority_version?: string;
    v2_execution_envelope?: V2ExecutionAuthorityEnvelope | null;
    legacy_comparison?: V2LegacyComparison | null;
    runtime_authority_owner?: string | null;
    runtime_authority_decision?: string | null;
    runtime_authority_side?: string | null;
    runtime_authority_size_usd?: number | null;
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
    regime_final: EngineV2Regime;
    subtype: EngineV2MarketSubtype;
    subtypeReason: string;
    shockPhase: "NONE" | "DOWN_SHOCK" | "UP_SHOCK" | "CRASH_RECOVERY" | "PUMP_RECOVERY";
    rangePhase: "NONE" | "MID" | "LOWER" | "UPPER" | "BREAKDOWN" | "BREAKOUT" | "FAKE_BREAKOUT";
    trendPhase: "NONE" | "UP" | "DOWN" | "PULLBACK" | "EXHAUSTION";
    transitionPhase: "NONE" | "RANGE_TO_TREND" | "TREND_TO_RANGE" | "CONFLICT";
    judgmentVersion: "v2_market_judgment_subtype_v1";
    no_trade_reason: string | null;
    data_ready: boolean;
    dump_protection_hit: boolean;
    volatility_guard_hit: boolean;
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
    metadata: Record<string, string | number | boolean | null>;
}

export interface TransitionExecutorMetadata extends Record<string, string | number | boolean | null> {
    transitionPhase: MarketJudgmentOutput["transitionPhase"] | "NONE";
    transitionSetupType: TransitionSetupType;
    transitionAction: TransitionAction;
    transitionReason: string;
    transitionConfidence: number;
    transitionPrimarySide: EngineV2Side;
    transitionCounterSide: EngineV2Side;
    transitionWatchOnly: boolean;
    transitionConfirmRequired: boolean;
    transitionRejectReason: string | null;
    transitionConfirmBasis: "box_break" | "ema_gap_only" | "insufficient";
    transitionPreflightSafetyPassed: boolean;
    transitionPreflightBlockReason: string | null;
    transitionEvidence: string;
    emaGap: number;
    trendWeaknessScore: number;
    rangeConfidence: number;
    boxCohesion01: number;
    breakoutFailureRate: number;
    boxPos: number;
    boxBreakSide: "upper" | "lower" | "none";
    qualityScore: number;
    reviewingTicks: number;
    directionalShockState: "UP" | "DOWN" | "NONE";
    longAllow: boolean;
    shortAllow: boolean;
    crashState: string;
    pumpState: string;
}

/** Tier 5: Risk Sizing Output */
export interface RiskSizingOutput {
    baseSizeUsd: number;
    sizeMultiplier: number;
    finalSizeUsd: number;
    isBlocked: boolean;
    blockReason: string | null;
    isAddOn: boolean;
    leverageProfile: LeverageProfile;
    appliedLeverage: number;
    leverageReason: string;
    leverageBlockReason: string | null;
    entryQualityGrade: EntryQualityGrade;
    exposureNotionalKrw: number;
    equityMultiple: number;
}

export interface MicroExecutionScoreSummary {
    score: number;
    grade: "strong" | "normal" | "weak" | "danger";
    sizeMultiplier: 1 | 0.75 | 0.5;
    delayMs: 0 | 500 | 1000 | 2000;
    deferOnce: boolean;
    hardBlockReason: null | "EXTREME_SPREAD" | "EMPTY_LIQUIDITY" | "OPPOSITE_FLOW_SPIKE";
    reasons: string[];
    dataFreshnessMs: number | null;
    usedOrderbook: boolean;
    usedRecentTrades: boolean;
    fallbackNeutral: boolean;
    authoritySource: "v2";
}

export type V2LifecycleStage = "entry" | "add_on" | "partial" | "exit" | "cooldown" | "position_state";
export type V2CooldownType = "none" | "direction_block" | "time_reentry" | "risk_halt" | "fail_reentry";
export type V2LifecyclePartialAction = "none" | "prepare" | "reduce" | "protect_profit";
export type V2LifecycleExitAction = "none" | "watch" | "exit";

export interface V2TradeLifecycleAuthorityInput {
    symbol: string;
    side: EngineV2Side;
    regime: EngineV2Regime;
    marketMode: EngineV2Regime;
    directionalShockState: "UP" | "DOWN" | "NONE";
    v2Decision: EngineV2FinalDecision;
    v2Side: EngineV2Side;
    authoritySource: "v2" | "v1";
    adoptedEngine: "V2" | "V1" | "UNKNOWN";
    position: EngineV2Position | null;
    unrealizedPnl: number | null;
    unrealizedPnlPct: number | null;
    holdMs: number | null;
    entryPrice: number | null;
    markPrice: number | null;
    riskState: string | null;
    cooldownState: {
        reason: string | null;
        remainingMs: number | null;
        reentryBlocked: boolean;
    };
    microExecution: MicroExecutionScoreSummary | null;
    reversalQuality: number | null;
    rawMetricsSummary: {
        qualityScore: number;
        rangeConfidence: number;
        trendWeaknessScore: number;
        boxPos: number | null;
    };
}

export interface V2TradeLifecycleAuthorityResult {
    symbol: string;
    side: EngineV2Side;
    lifecycleStage: V2LifecycleStage;
    authoritySource: "v2" | "v1";
    adoptedEngine: "V2" | "V1" | "UNKNOWN";
    positionStateOwner: "v2" | "legacy" | "unknown";
    entryManagedByV2: boolean;
    addOnManagedByV2: boolean;
    partialManagedByV2: boolean;
    exitManagedByV2: boolean;
    cooldownManagedByV2: boolean;
    positionStateManagedByV2: boolean;
    addOnAllowed: boolean | null;
    partialAction: V2LifecyclePartialAction;
    exitAction: V2LifecycleExitAction;
    cooldownType: V2CooldownType;
    cooldownReason: string | null;
    legacyInterventionDetected: boolean;
    consistencyPass: boolean;
    inconsistencyReasons: string[];
    proofReasons: string[];
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
    summary?: string;
    uiLabels: {
        regime: string;
        status: string;
    };
}

export interface ExitPolicyDiagnosticsSummary {
    action: string;
    reason: string;
    shouldExit: boolean;
    shouldReduce: boolean;
    shouldPartial: boolean;
    reduceRatio: number;
    exitUrgency: string;
    exitConfidence: number;
}

/** Unified Execution Authority (Phase 4 Independence) */
export type EntryExecutionAuthority = Readonly<{
    decision: EngineV2FinalDecision;
    side: EngineV2Side;
    sizeUsd: number;
    regime: string;
    source: "v1" | "v2";
    leverageProfile?: LeverageProfile;
    appliedLeverage?: number;
    leverageReason?: string;
    leverageBlockReason?: string | null;
    exposureNotionalKrw?: number;
    equityMultiple?: number;
    entryQualityGrade?: EntryQualityGrade;
    addOnAllowed?: boolean;
}>;

/** Internal Pipeline Result */
export interface EngineV2InternalResult {
    judgment: MarketJudgmentOutput;
    confidence: RegimeConfidenceOutput;
    routing: RouterOutput;
    execution: ExecutorOutput;
    riskSizing: RiskSizingOutput;
    explanation: ExplanationOutput;
    microExecution: MicroExecutionScoreSummary | null;
    lifecycleAuthority: V2TradeLifecycleAuthorityResult | null;
    exitPolicy: ExitPolicyDiagnosticsSummary | null;
}
