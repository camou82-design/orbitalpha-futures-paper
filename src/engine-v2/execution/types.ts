import type {
    EngineV2Decision,
    EngineV2FinalDecision,
    EngineV2OpMode,
    EngineV2SelectorResult,
    EngineV2Side
} from "../types";

export type V2ExecutionAuthoritySource =
    | "v2_execution_envelope"
    | "legacy_execution_envelope"
    | "shadow_compare_only";

export type V2ExecutionAuthorityEnvelope = Readonly<{
    symbol: string;
    mode: EngineV2OpMode;
    authoritySource: V2ExecutionAuthoritySource;
    authorityOwner: "V1" | "V2";
    finalEngineOwner: "V1" | "V2";
    adoptedEngine: "V1" | "V2";
    decision: EngineV2FinalDecision;
    side: EngineV2Side;
    stageMarginKrw: number;
    baseStageMarginKrw: number;
    regime: string;
    marketSubtype: string | null;
    entryQualityGrade: string | null;
    leverageProfile: string | null;
    appliedLeverage: number;
    exposureNotionalKrw: number;
    equityMultiple: number;
    addOnAllowed: boolean | null;
    addOnPolicyAction: string | null;
    addOnPolicyReason: string | null;
    exitPolicyAction: string | null;
    exitPolicyReason: string | null;
    exitShouldExit: boolean | null;
    exitShouldReduce: boolean | null;
    exitShouldPartial: boolean | null;
    exitReduceRatio: number | null;
    exitUrgency: string | null;
    exitConfidence: number | null;
    paperExecutionReady: boolean | null;
    signedExecutionReady: boolean | null;
    hardBlockPresent: boolean;
    hardBlockReason: string | null;
    authorityReason: string;
    authorityVersion: "v2_execution_authority_envelope_v1";
    newStopPrice?: number;

    // -- Added for Bridge V2 Original Intent --
    originalDecision?: string;
    originalSide?: string;
    originalStageMarginKrw?: number;

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
    invalidationPx?: number;

    // --- Diagnostic Audit Fields (V2 Hardening) ---
    aligned_signal?: string | null;
    selected_side_after_veto?: string | null;
    promotion_applied?: boolean | null;
    promotion_reason?: string | null;
    promotion_block_reason?: string | null;
    shock_reaction_block_reason: string | null;
    quality_score: number | null;
    v2_decision: string | null;
    v2_side: string | null;
    range_side_candidate: string | null;
    trend_side_candidate: string | null;
    reversal_confirmed: boolean | null;
    side_zone_valid: boolean | null;
    expected_missing_condition: string | null;
    expected_next_action: string | null;
    primary_missing_condition: string | null;
    secondary_missing_condition: string | null;
    raw_missing_condition: string | null;
    side_veto_detail: string | null;
    macro_source?: string | null;
    daily_bias_actual?: string | null;
    h4_bias_actual?: string | null;
    h1_bias_actual?: string | null;
    m15_bias_actual?: string | null;
    m5_bias_actual?: string | null;
    htf_bias?: any | null;
    htf_entry_policy?: string | null;
    counter_trend_risk?: boolean | null;
    htf_size_multiplier?: number | null;
    htf_requires_stronger_confirmation?: boolean | null;
    htf_policy_reason?: string | null;
    htf_hard_block_reason?: string | null;
    trend_ok?: boolean | null;
    display_retest_required: boolean;
    display_support_recheck_required: boolean;
}>;
export type V2LegacyComparison = Readonly<{
    legacyDecision: EngineV2FinalDecision;
    legacySide: EngineV2Side;
    legacySize: number;
    v2Decision: EngineV2FinalDecision;
    v2Side: EngineV2Side;
    v2Size: number;
    selectorMismatch: boolean;
}>;

export type BuildExecutionEnvelopeArgs = Readonly<{
    symbol: string;
    mode: EngineV2OpMode;
    v2Decision: EngineV2Decision;
    selector: EngineV2SelectorResult;
    legacyComparison: V2LegacyComparison;
    marketSubtype: string | null;
    exitPolicyAction?: string | null;
    exitPolicyReason?: string | null;
    exitShouldExit?: boolean | null;
    exitShouldReduce?: boolean | null;
    exitShouldPartial?: boolean | null;
    exitReduceRatio?: number | null;
    exitUrgency?: string | null;
    exitConfidence?: number | null;
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
    invalidationPx?: number;

    // --- Diagnostic Audit Fields (V2 Hardening) ---
    alignedSignal?: string | null;
    selectedSideAfterVeto?: string | null;
    promotionApplied?: boolean | null;
    promotionReason?: string | null;
    promotionBlockReason?: string | null;
    shockReactionBlockReason?: string | null;
    qualityScore?: number | null;
    v2DecisionFinal?: string | null;
    v2SideFinal?: string | null;
    rangeSideCandidate?: string | null;
    trendSideCandidate?: string | null;
    reversalConfirmed?: boolean | null;
    sideZoneValid?: boolean | null;
    expectedMissingCondition?: string | null;
    expectedNextAction?: string | null;
    primaryMissingCondition?: string | null;
    secondaryMissingCondition?: string | null;
    rawMissingCondition?: string | null;
    sideVetoDetail?: string | null;
    macro_source?: string | null;
    daily_bias_actual?: string | null;
    h4_bias_actual?: string | null;
    h1_bias_actual?: string | null;
    m15_bias_actual?: string | null;
    m5_bias_actual?: string | null;
    htf_bias?: any | null;
    htf_entry_policy?: string | null;
    counter_trend_risk?: boolean | null;
    htf_size_multiplier?: number | null;
    htf_requires_stronger_confirmation?: boolean | null;
    htf_policy_reason?: string | null;
    htf_hard_block_reason?: string | null;
    trendOk?: boolean | null;
    displayRetestRequired?: boolean | null;
    displaySupportRecheckRequired?: boolean | null;
}>;
