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
    | "RANGE_COMPRESSION"
    | "TRIANGLE_SQUEEZE_CANDIDATE"
    | "BREAKOUT_OBSERVATION"
    | "BREAKOUT_RETEST_CONFIRMED"
    | "RANGE_FLAT"
    | "RANGE_DRIFT_DOWN"
    | "RANGE_DRIFT_UP"
    | "DESCENDING_CHANNEL"
    | "ASCENDING_CHANNEL"
    | "DRIFT_REVERSAL_UP_WATCH"
    | "DRIFT_REVERSAL_DOWN_WATCH"
    | "VOLUME_BREAKDOWN_OBSERVATION"
    | "VOLUME_SHOCK_DOWN"
    | "BREAKDOWN_RETEST_FAILED"
    | "FAKE_VOLUME_BREAKDOWN"
    | "VOLUME_BREAKOUT_OBSERVATION"
    | "VOLUME_SHOCK_UP"
    | "BREAKOUT_RETEST_CONFIRMED_VOLUME"
    | "FAKE_VOLUME_BREAKOUT"
    | "NO_TRADE_DATA_NOT_READY"
    | "NO_TRADE_DUMP_PROTECTION"
    | "NO_TRADE_METRICS_INSUFFICIENT"
    /** Protective / wait umbrella: shock chop, volume spike, unconfirmed retest-reclaim (not an entry mode). */
    | "WHIPSAW_SHOCK_RECHECK"
    | "WHIPSAW_SOFT_WATCH"
    | "EARLY_LONG_PROBE";
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
    ledger_stop_px?: number;
    peakUnrealizedPnlPct?: number;
    peakUnrealizedPnlUsd?: number;
    peakPnlUpdatedAt?: number;
    takeProfitPlan?: {
        tp1: number;
        tp2: number;
        invalidationPx: number;
    } | null;
    tp1Triggered?: boolean;
    tp2Triggered?: boolean;
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
    rangeOscillationScore?: number;
    rangeOscillationDiag?: number;
    reviewing_ticks?: number;
    regimeExitRisk?: number;
    boxBreakSide?: "upper" | "lower" | "none";
    signal?: string;
    qualityScore?: number;
    data_ready?: boolean;
    dump_protection_hit?: boolean;
    volatility_guard_hit?: boolean;
    entryCandidate?: boolean;
    signalGateBlockedReason?: string | null;
    rangeSignalDowngraded?: boolean;
    rangeSignalKeptByRelax?: boolean;
    atr?: number;
    swingHighSlope?: number;
    swingLowSlope?: number;
    rangeCenterSlope?: number;
    boxHighSlope?: number;
    boxLowSlope?: number;
    ema20Slope?: number;
    ema60Slope?: number;
    atrExpansion?: number;
    volumeExpansion?: number;
    candles?: import("../../models/types").Candle[];
    htf_candles?: Record<string, import("../../models/types").Candle[]>;
}

export interface LegacyConfigAdapter {
    paperMaxOpenPositions: number;
    paperReentryCooldownMs: number;
    baseSizeUsd: number;
    okxLiveMaxOrderNotionalUsdt: number;
}

export interface LegacyPositionAdapter {
    symbol: MarketSymbol;
    side: PositionSide | "long" | "short";
    entryPrice: number;
    sizeUsd: number;
    entryStage?: number;
    pnlPct?: number;
    ledger_stop_px?: number;
    peakUnrealizedPnlPct?: number;
    peakUnrealizedPnlUsd?: number;
    peakPnlUpdatedAt?: number;
    takeProfitPlan?: {
        tp1: number;
        tp2: number;
        invalidationPx: number;
    } | null;
    tp1Triggered?: boolean;
    tp2Triggered?: boolean;
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
        directionalShockState: "UP" | "DOWN" | "NONE" | "UNKNOWN";
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
        lockedProfitUsdt?: number;
        availableRiskBudgetUsdt?: number;
        addonMaxNotionalUsdt?: number;
        finalAddonNotionalUsdt?: number;
    };
    now: number;
    v1Result: {
        regime: string;
        decision: string;
        side: string;
        isBlocked: boolean;
    };
    candles?: import("../../models/types").Candle[];
    htf_candles?: Record<string, import("../../models/types").Candle[]>;
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
    rangeOscillationScore: number;
    reviewing_ticks: number;
    regimeExitRisk: number;
    boxBreakSide: "upper" | "lower" | "none";
    signal: string;
    qualityScore: number;
    data_ready: boolean;
    dump_protection_hit: boolean;
    volatility_guard_hit: boolean;
    entryCandidate: boolean;
    atr?: number;
    signalGateBlockedReason?: string | null;
    rangeSignalDowngraded?: boolean;
    rangeSignalKeptByRelax?: boolean;
    swingHighSlope?: number;
    swingLowSlope?: number;
    rangeCenterSlope?: number;
    boxHighSlope?: number;
    boxLowSlope?: number;
    ema20Slope?: number;
    ema60Slope?: number;
    atrExpansion?: number;
    volumeExpansion?: number;
    candles?: import("../../models/types").Candle[];
    htf_candles?: Record<string, import("../../models/types").Candle[]>;
}

export interface EngineV2ConfigAdapter {
    paperMaxOpenPositions: number;
    paperReentryCooldownMs: number;
    baseSizeUsd: number;
    okxLiveMaxOrderNotionalUsdt: number;
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
    v2ExitAuthority?: V2ExitAuthorityResult;
    v2PartialAuthority?: V2PartialAuthorityResult;
    v2CooldownAuthority?: V2CooldownAuthorityResult;
    v2PositionStateAuthority?: V2PositionStateAuthorityResult;
    rawMetrics: Record<string, number | boolean | string | null>;
    metadata?: Record<string, any>;
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
    breakoutFailureRate: number;
    trendWeaknessScore: number;
    rangeOscillationScore: number;
    ema20: number;
    emaGap: number;
    atr: number;
    signal: string;
    qualityScore: number;
    swingHighSlope: number;
    swingLowSlope: number;
    rangeCenterSlope: number;
    boxHighSlope: number;
    boxLowSlope: number;
    ema20Slope: number;
    ema60Slope: number;
    atrExpansion: number;
    volumeExpansion: number;
    entryCandidate?: boolean;
    signalGateBlockedReason?: string | null;
    rangeSignalDowngraded?: boolean;
    rangeSignalKeptByRelax?: boolean;
    candles?: import("../../models/types").Candle[];
    htf_candles?: Record<string, import("../../models/types").Candle[]>;
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
    okxLiveMaxOrderNotionalUsdt: number;
}

export interface V2BridgePosition {
    symbol: MarketSymbol;
    side: "LONG" | "SHORT";
    entryPrice: number;
    sizeUsd: number;
    entryStage: number;
    peakUnrealizedPnlPct?: number;
    peakUnrealizedPnlUsd?: number;
    peakPnlUpdatedAt?: number;
}

export interface V2BridgeState {
    currentPositions: V2BridgePosition[];
    globalRiskScore: number;
    lossStreaks: Record<string, number>;
    directionalShockState: "UP" | "DOWN" | "NONE" | "UNKNOWN";
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
    lockedProfitUsdt?: number;
    availableRiskBudgetUsdt?: number;
    addonMaxNotionalUsdt?: number;
    finalAddonNotionalUsdt?: number;
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
    hard_block_present?: boolean;
    runtime_authority_owner?: string | null;
    runtime_authority_decision?: string | null;
    runtime_authority_side?: string | null;
    runtime_authority_stage_margin_krw?: number | null;
    runtime_authority_base_stage_margin_krw?: number | null;
    runtime_authority_size_usdt?: number | null;
    runtime_authority_new_stop_px?: number | null;
    runtime_authority_invalidation_px?: number | null;
    // V1/V2 Comparison Metrics (Phase 5 Summary)
    v1_decision?: string;
    v1_side?: string;
    v1_size?: number;
    v2_decision?: string;
    v2_side?: string;
    v2_size?: number;
    selector_mismatch?: boolean;
    v2_paper_cooldown_agreement?: boolean | null;
    v2_cooldown_action?: string | null;
    v2_cooldown_type?: string | null;
    v2_cooldown_reason?: string | null;
    v2_cooldown_urgency?: string | null;
    v2_cooldown_remaining_ms?: number | null;
    v2_direction_blocked?: string | null;
    v2_position_state_action?: string | null;
    v2_position_lifecycle_state?: string | null;
    v2_position_risk_state?: string | null;
    v2_position_stage?: number | null;
    v2_position_pnl_state?: string | null;
    v2_position_hold_ms?: number | null;
    v2_unrealized_pnl_usd_estimate?: number | null;
    v2_paper_position_state_agreement?: boolean | null;
    position_state_authority_owner?: string | null;
    position_state_execution_owner?: string | null;
    cooldown_authority_owner?: string | null;
    cooldown_execution_owner?: string | null;
}

/** Tier 1: Market Judgment */
export interface MarketJudgmentOutput {
    regime: EngineV2Regime;
    regime_final: EngineV2Regime;
    subtype: EngineV2MarketSubtype;
    subtypeReason: string;
    shockPhase: "NONE" | "DOWN_SHOCK" | "UP_SHOCK" | "CRASH_RECOVERY" | "PUMP_RECOVERY";
    rangePhase:
        | "NONE"
        | "MID"
        | "LOWER"
        | "UPPER"
        | "BREAKDOWN"
        | "BREAKOUT"
        | "FAKE_BREAKOUT"
        | "COMPRESSION"
        | "TRIANGLE_SQUEEZE"
        | "BREAKOUT_OBSERVATION"
        | "FLAT"
        | "DRIFT_DOWN"
        | "DRIFT_UP"
        | "DESCENDING_CHANNEL"
        | "ASCENDING_CHANNEL"
        | "REVERSAL_UP_WATCH"
        | "REVERSAL_DOWN_WATCH"
        | "VOLUME_BREAKDOWN_OBSERVATION"
        | "VOLUME_SHOCK_DOWN"
        | "BREAKDOWN_RETEST_FAILED"
        | "FAKE_VOLUME_BREAKDOWN"
        | "VOLUME_BREAKOUT_OBSERVATION"
        | "VOLUME_SHOCK_UP"
        | "BREAKOUT_RETEST_CONFIRMED_VOLUME"
        | "FAKE_VOLUME_BREAKOUT";
    trendPhase: "NONE" | "UP" | "DOWN" | "PULLBACK" | "EXHAUSTION";
    transitionPhase:
        | "NONE"
        | "RANGE_TO_TREND"
        | "TREND_TO_RANGE"
        | "CONFLICT"
        | "RETEST_CONFIRMED"
        /** Internal whipsaw / shock-recheck markers (orthogonal to range↔trend transition). */
        | "WHIPSAW_RECHECK"
        | "SHOCK_RECLAIM_RECHECK"
        | "SHOCK_RETEST_UNCONFIRMED";
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
    htf_bias?: {
        m5: string;
        m15: string;
        h1: string;
        h4: string;
        d1: string;
    };
    macro_source?: "actual_candles" | "partial_actual_candles" | "market_subtype_proxy_fallback" | "data_not_ready";
    macroPolarity?: "BULLISH" | "BEARISH" | "NEUTRAL";
    polarityMismatch?: boolean;
    daily_bias_actual?: string;
    h4_bias_actual?: string;
    h1_bias_actual?: string;
    m15_bias_actual?: string;
    m5_bias_actual?: string;
    htf_conflict?: boolean;
    counter_trend_risk?: boolean;
    htf_entry_policy?: string;
    expected_next_action?: string;
    htf_size_multiplier?: number;
    htf_requires_stronger_confirmation?: boolean;
    htf_policy_reason?: string;
    htf_hard_block_reason?: string;
    diagnostics?: {
        structural_hit_count: number;
        context_hit_count: number;
        structural_hits: string[];
        context_hits: string[];
        confirmation_wait_reasons: string[];
        early_probe?: {
            allowed: boolean;
            reason: string;
            block_reason: string;
            hits: string[];
            counter_trend_risk: boolean;
        };
    };
    metadata?: Record<string, any>;
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
    stopPrice: number | null;
    invalidationPx: number | null;
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
    directionalShockState: "UP" | "DOWN" | "NONE" | "UNKNOWN";
    longAllow: boolean;
    shortAllow: boolean;
    crashState: string;
    pumpState: string;
}

/** Tier 5: Risk Sizing Output */
export interface RiskSizingDiagnostics {
    original_v2_decision?: string;
    original_v2_side?: string;
    original_stage_margin_krw?: number;
    [key: string]: unknown;
}

export interface RiskSizingOutput {
    baseStageMarginKrw: number;
    sizeMultiplier: number;
    stageMarginKrw: number;
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
    diagnostics?: RiskSizingDiagnostics;
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

export interface V2ExitAuthorityResult {
    symbol: string;
    side: EngineV2Side;
    exitAuthorityOwner: "v2";
    exitExecutionOwner: "paper_engine" | "v2_executor" | "legacy" | "unknown";
    exitAction: "none" | "watch" | "partial_candidate" | "exit";
    shouldExit: boolean;
    exitReason: string | null;
    exitUrgency: "none" | "low" | "medium" | "high" | "emergency";
    exitConfidence: number;
    reduceRatio: number | null;
    proofReasons: string[];
    trueInconsistencyReasons: string[];
    knownShadowGaps: string[];
}

export interface V2PartialAuthorityResult {
    symbol: string;
    side: EngineV2Side;
    partialAuthorityOwner: "v2";
    partialExecutionOwner: "paper_engine" | "v2_executor" | "legacy" | "unknown";
    partialAction: "none" | "watch" | "protect_profit" | "reduce_candidate";
    shouldPartial: boolean;
    partialReason: string | null;
    partialUrgency: "none" | "low" | "medium" | "high";
    partialConfidence: number;
    reduceRatio: number | null;
    proofReasons: string[];
    trueInconsistencyReasons: string[];
    knownShadowGaps: string[];
}

export interface V2CooldownAuthorityResult {
    symbol: string;
    side: EngineV2Side;
    cooldownAuthorityOwner: "v2";
    cooldownExecutionOwner: "paper_engine";
    cooldownAction: "none" | "watch" | "block_entry" | "block_direction" | "halt";
    shouldCooldown: boolean;
    cooldownType: V2CooldownType;
    cooldownReason: string | null;
    cooldownUrgency: "none" | "low" | "medium" | "high";
    cooldownRemainingMs: number | null;
    directionBlocked: "none" | "long" | "short";
    proofReasons: string[];
    trueInconsistencyReasons: string[];
    knownShadowGaps: string[];
}

export interface V2PositionStateAuthorityResult {
    symbol: string;
    side: EngineV2Side;
    positionStateAuthorityOwner: "v2";
    positionStateExecutionOwner: "paper_engine";
    positionStateAction: "none" | "track" | "watch" | "protect" | "stale" | "closed";
    hasPosition: boolean;
    positionLifecycleState: "none" | "opening" | "open" | "scaling" | "reducing" | "closing" | "closed" | "unknown";
    positionRiskState: "none" | "normal" | "profit_protect" | "drawdown_watch" | "danger" | "unknown";
    positionStage: number | null;
    holdMs: number | null;
    pnlState: "none" | "profit" | "loss" | "flat" | "unknown";
    unrealizedPnlKrw: number | null;
    unrealizedPnlUsdEstimate: number | null;
    unrealizedPnlPct: number | null;
    peakUnrealizedPnlPct: number | null;
    peakUnrealizedPnlUsd: number | null;
    givebackPct: number | null;
    stateReason: string | null;
    proofReasons: string[];
    trueInconsistencyReasons: string[];
    knownShadowGaps: string[];
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
    directionalShockState: "UP" | "DOWN" | "NONE" | "UNKNOWN";
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
        subtype?: EngineV2MarketSubtype;
        boxHigh?: number;
        boxLow?: number;
        boxHighSlope?: number;
        boxLowSlope?: number;
        swingHighSlope?: number;
        swingLowSlope?: number;
        ema20?: number;
        ema20Slope?: number;
        atrExpansion?: number;
        volumeExpansion?: number;
        breakoutFailureRate?: number;
    };
    atr?: number;
    currentStopPrice?: number;
    accountEquityUsd?: number;
    currentSymbolNotionalUsd?: number;
    currentGlobalNotionalUsd?: number;
    liveMaxOrderNotionalUsdt?: number;
    finalAddonNotionalUsdt?: number;
    peakUnrealizedPnlPct?: number;
    peakUnrealizedPnlUsd?: number;
    peakPnlUpdatedAt?: number;
    takeProfitPlan?: {
        tp1: number;
        tp2: number;
        invalidationPx: number;
    } | null;
    tp1Triggered?: boolean;
    tp2Triggered?: boolean;
    suggestedStopPrice?: number | null;
    suggestedInvalidationPx?: number | null;
}

export interface V2TradeLifecycleAuthorityResult {
    symbol: string;
    side: EngineV2Side;
    lifecycleStage: V2LifecycleStage;
    authoritySource: "v2" | "v1";
    adoptedEngine: "V2" | "V1" | "UNKNOWN";
    lifecycleAuthorityOwner: "v2" | "legacy" | "unknown";
    executionOwner: "paper_engine" | "v2_executor" | "legacy" | "unknown";
    positionStateOwner: "paper_engine" | "v2_executor" | "legacy" | "unknown";
    entryManagedByV2: boolean;
    addOnManagedByV2: boolean;
    partialManagedByV2: boolean;
    exitManagedByV2: boolean;
    cooldownManagedByV2: boolean;
    positionStateManagedByV2: boolean;
    addOnAllowed: boolean | null;
    nextAddonNotional?: number;
    exitAction: V2LifecycleExitAction;
    exitReason?: string | null;
    partialAction: V2LifecyclePartialAction;
    partialReason?: string | null;
    reduceRatio?: number | null;
    newStopPrice?: number;
    givebackPct?: number;
    guardThresholdPct?: number;
    guardAction?: string;
    cooldownType: V2CooldownType;
    cooldownReason: string | null;
    legacyInterventionDetected: boolean;
    consistencyPass: boolean;
    knownShadowGaps: string[];
    trueInconsistencyReasons: string[];
    inconsistencyReasons: string[];
    proofReasons: string[];
    tp1Triggered?: boolean;
    tp2Triggered?: boolean;
    takeProfit1Px?: number;
    takeProfit2Px?: number;
    invalidationPx?: number | null;
}

/** Tier 5: Add-on Policy Output */
export interface AddonPolicyOutput {
    allowed: boolean;
    addOnStageMarginKrw: number;
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
    stageMarginKrw: number;
    baseStageMarginKrw?: number;
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

    // -- Added for V2 Bridge Hardening --
    marketSubtype?: string | null;
    originalDecision?: string;
    originalSide?: string;
    originalStageMarginKrw?: number;
    hardBlockPresent?: boolean;
    hardBlockReason?: string | null;
    nonBypassableHardBlockPresent?: boolean;
    newStopPrice?: number;
    // --- RANGE Box & Exit Plan (V2 Hardening) ---
    rangeBoxHighAtEntry?: number;
    rangeBoxLowAtEntry?: number;
    rangeBoxMidAtEntry?: number;
    rangeBoxQuality?: number;
    rangeBoxSlope?: number;
    rangeBoxDistorted?: boolean;
    takeProfitPlan?: any;
    takeProfit1Px?: number;
    takeProfit2Px?: number;
    partialExitRatio?: number;
    invalidationPx: number | null;
    stopPrice: number | null;
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
    v2ExitAuthority: V2ExitAuthorityResult | null;
    v2PartialAuthority: V2PartialAuthorityResult | null;
    v2CooldownAuthority: V2CooldownAuthorityResult | null;
    v2PositionStateAuthority: V2PositionStateAuthorityResult | null;
    exitPolicy: ExitPolicyDiagnosticsSummary | null;
}
