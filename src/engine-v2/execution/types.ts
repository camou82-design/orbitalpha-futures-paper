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
}>;
