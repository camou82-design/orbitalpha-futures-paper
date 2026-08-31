import {
    EngineV2Decision,
    EngineV2FinalDecision,
    EngineV2Side,
    EngineV2SelectorResult,
    EngineV2AdoptionOutcome,
    LegacyResultAdapter,
    EntryExecutionAuthority,
    LegacyDecisionResult,
    SymbolDecisionEnvelope,
    V2BridgeInput,
    LegacySnapshotAdapter,
    LegacyConfigAdapter
} from "./types";
import { adaptV2Input, runEngineV2 } from "./index";
import { buildV2ExecutionAuthorityEnvelope } from "./execution/envelope";
import type { V2ExecutionAuthorityEnvelope, V2LegacyComparison } from "./execution/types";

type CycleAuthorityCommitRecord = {
    runCycleId: string;
    symbol: string;
    firstAuthorityDecision: string;
    firstAuthoritySide: string;
    firstSignedExecutionReady: boolean;
    decisionSource: "LIVE_EXECUTION" | "DIAGNOSTIC";
    accountEquityUsdt: number | null;
};

const cycleAuthorityCommitByKey = new Map<string, CycleAuthorityCommitRecord>();

function cycleAuthorityKey(runCycleId: string | undefined, symbol: string): string {
    return `${runCycleId ?? "unknown"}:${String(symbol).toUpperCase()}`;
}

function pruneCycleAuthorityCommits(activeRunCycleId: string | undefined): void {
    if (!activeRunCycleId) return;
    const prefix = `${activeRunCycleId}:`;
    for (const key of cycleAuthorityCommitByKey.keys()) {
        if (!key.startsWith(prefix)) {
            cycleAuthorityCommitByKey.delete(key);
        }
    }
}

function readBridgeAccountEquityUsdt(state: V2BridgeInput["state"]): number | null {
    const fromState = (state as { accountEquityUsdt?: unknown }).accountEquityUsdt;
    if (typeof fromState === "number" && Number.isFinite(fromState)) return fromState;
    const wallet = (state as { okxWalletBalanceUsdt?: unknown }).okxWalletBalanceUsdt;
    if (typeof wallet === "number" && Number.isFinite(wallet)) return wallet;
    return null;
}

function emitSingleCycleAuthorityCommitProof(args: {
    runCycleId: string | undefined;
    symbol: string;
    first: CycleAuthorityCommitRecord;
    secondaryEvaluationDetected: boolean;
    secondaryDecision: string | null;
    secondarySide: string | null;
    secondaryAllowedToMutate: boolean;
}): void {
    console.info(JSON.stringify({
        event: "V2_SINGLE_CYCLE_AUTHORITY_COMMIT_PROOF",
        run_cycle_id: args.runCycleId ?? null,
        symbol: args.symbol,
        first_authority_decision: args.first.firstAuthorityDecision,
        first_authority_side: args.first.firstAuthoritySide,
        first_signed_execution_ready: args.first.firstSignedExecutionReady,
        secondary_evaluation_detected: args.secondaryEvaluationDetected,
        secondary_decision: args.secondaryDecision,
        secondary_side: args.secondarySide,
        secondary_allowed_to_mutate: args.secondaryAllowedToMutate,
        final_committed_decision: args.first.firstAuthorityDecision,
        final_committed_side: args.first.firstAuthoritySide
    }));
}

/** 
 * LEGACY NORMALIZATION HELPERS (Phase 4 Independence)
 * Ensures consistent behavior across engine boundaries.
 */
export function normalizePositionSideUpper(
    side: unknown
): "LONG" | "SHORT" | "NONE" {
    if (side === "long" || side === "LONG") return "LONG";
    if (side === "short" || side === "SHORT") return "SHORT";
    return "NONE";
}

export function normalizePositionSideLower(
    side: unknown
): "long" | "short" | "none" {
    if (side === "long" || side === "LONG") return "long";
    if (side === "short" || side === "SHORT") return "short";
    return "none";
}

export function normalizeAuthoritySide(side: unknown): EngineV2Side {
    const s = normalizePositionSideLower(side);
    if (s === "none") return null;
    return s;
}

export function normalizeAuthorityDecision(decision: unknown): EngineV2FinalDecision {
    if (decision === undefined || decision === null) return "SKIP";
    const d = String(decision).trim().toUpperCase();
    if (d === "ENTER" || d === "SKIP" || d === "REJECT" || d === "DISABLED") return d as EngineV2FinalDecision;
    return "SKIP";
}

/** 
 * LEGACY ADAPTER HELPER (Phase 4 Extraction)
 * Decouples raw legacy decision from V2 adaptive input.
 */
export function buildV2LegacyAdapter(res: LegacyDecisionResult): LegacyResultAdapter {
    return {
        decision: {
            regime_state: res.decision?.regime_state ?? "UNKNOWN",
            final_decision: res.decision?.final_decision ?? "SKIP",
            reject_reason: res.decision?.reject_reason ?? null,
            required_cost_usd:
                typeof res.decision?.required_cost_usd === "number" && Number.isFinite(res.decision.required_cost_usd)
                    ? res.decision.required_cost_usd
                    : 0
        },
        executorDecision: res.executorDecision ? {
            entry_allowed: res.executorDecision.entry_allowed ?? false,
            total_cost:
                typeof res.executorDecision.total_cost === "number" && Number.isFinite(res.executorDecision.total_cost)
                    ? res.executorDecision.total_cost
                    : 0
        } : null,
        intentSide: normalizeAuthoritySide(res.intentSide)
    };
}

/** 
 * V2 RECONCILER (Phase 4 Extraction)
 * Final Selector Adoption Logic (Standard 10: No contamination)
 * Returns a strictly decoupled 3-layer selector result.
 */
export function reconcileV2Decision(
    v1: LegacyDecisionResult,
    v2: EngineV2Decision,
    engineMode: string
): EngineV2SelectorResult {
    const legacy_result: EngineV2SelectorResult["legacy_result"] = {
        regime: v1.decision?.regime_state || "UNKNOWN",
        decision: normalizeAuthorityDecision(v1.decision?.final_decision),
        side: normalizeAuthoritySide(v1.intentSide),
        size:
            typeof v1.decision?.required_cost_usd === "number" && Number.isFinite(v1.decision.required_cost_usd)
                ? v1.decision.required_cost_usd
                : 0
    };

    const useV2 = engineMode === "engine_v2" || engineMode === "shadow_v2";

    // Fresh object creation (No legacy mutation)
    const adopted_result: EngineV2AdoptionOutcome = {
        engine: useV2 ? "V2" : "V1",
        adopted_decision: useV2 ? v2.decision : legacy_result.decision,
        adopted_regime: useV2 ? v2.regime : legacy_result.regime,
        adopted_side: useV2 ? v2.side : legacy_result.side,
        adopted_size_usd: useV2 ? v2.risk.stageMarginKrw : legacy_result.size,
        adoption_reason: useV2 ? v2.explanation.reason : "v1_fallback"
    };

    return {
        legacy_result,
        v2_result: v2,
        adopted_result,
        mismatch:
            legacy_result.decision !== v2.decision ||
            legacy_result.side !== v2.side ||
            Math.abs(legacy_result.size - v2.risk.stageMarginKrw) > 0.000001
    };
}

/** 
 * EXECUTION AUTHORITY ENFORCER (Phase 4 Extraction)
 * Final Source of Truth derivation for the engine loop.
 */
export function deriveExecutionAuthority(
    selector: EngineV2SelectorResult
): EntryExecutionAuthority {
    const res = selector.adopted_result;
    const v2Risk = selector.v2_result.risk;
    const useV2 = res.engine === "V2";
    return {
        decision: res.adopted_decision,
        side: res.adopted_side,
        stageMarginKrw: res.adopted_size_usd,
        regime: res.adopted_regime,
        source: useV2 ? "v2" : "v1",
        leverageProfile: useV2 ? v2Risk.leverageProfile : "BASE",
        appliedLeverage: useV2 ? v2Risk.appliedLeverage : 0,
        leverageReason: useV2 ? v2Risk.leverageReason : "legacy_authority",
        leverageBlockReason: useV2 ? v2Risk.leverageBlockReason : null,
        exposureNotionalKrw: useV2 ? v2Risk.exposureNotionalKrw : 0,
        equityMultiple: useV2 ? v2Risk.equityMultiple : 0,
        entryQualityGrade: useV2 ? v2Risk.entryQualityGrade : "B",
        addOnAllowed: useV2 ? v2Risk.isAddOn === true : false,
        originalDecision: useV2 ? v2Risk.diagnostics?.original_v2_decision : undefined,
        originalSide: useV2 ? v2Risk.diagnostics?.original_v2_side : undefined,
        originalStageMarginKrw: useV2 ? (typeof v2Risk.diagnostics?.original_stage_margin_krw === "number" ? v2Risk.diagnostics.original_stage_margin_krw : undefined) : undefined,
        hardBlockPresent: useV2 ? v2Risk.isBlocked === true : undefined,
        hardBlockReason: useV2 ? (v2Risk.blockReason ?? null) : undefined,
        nonBypassableHardBlockPresent: useV2 && v2Risk.blockReason != null ? new Set<string>([
            "KILL_SWITCH_ACTIVE",
            "SERVER_TRADE_DISABLED",
            "CLOSE_ONLY_MODE",
            "RISK_MODE_HALT",
            "DAILY_LOSS_GUARD",
            "RECONCILE_SAFE_MODE",
            "MAX_SLOTS_REACHED",
            "MIN_ORDER_SIZE_UNDERFLOW",
            "ORDER_BUILD_FAIL",
            "CRASH_ENTRY_GUARD_BLOCK",
            "RISK_EXPOSURE_CAP_PRE_SUBMIT",
            "STOP_PRICE_MISSING",
            "LONG_INVALIDATION_ABOVE_ENTRY",
            "SHORT_INVALIDATION_BELOW_ENTRY"
        ]).has(v2Risk.blockReason) : undefined,
        stopPrice: useV2 ? (selector.v2_result.lifecycleAuthority?.newStopPrice ?? null) : null,
        invalidationPx: useV2 ? (selector.v2_result.lifecycleAuthority?.invalidationPx ?? null) : null,
        rangeBoxHighAtEntry: useV2 && typeof selector.v2_result.metadata?.rangeBoxHighAtEntry === "number" ? selector.v2_result.metadata.rangeBoxHighAtEntry : undefined,
        rangeBoxLowAtEntry: useV2 && typeof selector.v2_result.metadata?.rangeBoxLowAtEntry === "number" ? selector.v2_result.metadata.rangeBoxLowAtEntry : undefined,
        rangeBoxMidAtEntry: useV2 && typeof selector.v2_result.metadata?.rangeBoxMidAtEntry === "number" ? selector.v2_result.metadata.rangeBoxMidAtEntry : undefined,
        rangeBoxQuality: useV2 && typeof selector.v2_result.metadata?.rangeBoxQuality === "number" ? selector.v2_result.metadata.rangeBoxQuality : undefined,
        rangeBoxSlope: useV2 && typeof selector.v2_result.metadata?.rangeBoxSlope === "number" ? selector.v2_result.metadata.rangeBoxSlope : undefined,
        rangeBoxDistorted: useV2 && typeof selector.v2_result.metadata?.rangeBoxDistorted === "boolean" ? selector.v2_result.metadata.rangeBoxDistorted : undefined,
        takeProfitPlan: useV2 ? selector.v2_result.metadata?.takeProfitPlan : undefined,
        takeProfit1Px: useV2 && typeof selector.v2_result.metadata?.takeProfit1Px === "number" ? selector.v2_result.metadata.takeProfit1Px : undefined,
        takeProfit2Px: useV2 && typeof selector.v2_result.metadata?.takeProfit2Px === "number" ? selector.v2_result.metadata.takeProfit2Px : undefined,
        partialExitRatio: useV2 && typeof selector.v2_result.metadata?.partialExitRatio === "number" ? selector.v2_result.metadata.partialExitRatio : undefined
    };
}

export function deriveExecutionAuthorityFromEnvelope(
    envelope: V2ExecutionAuthorityEnvelope
): EntryExecutionAuthority {
    return {
        decision: envelope.decision,
        side: envelope.side,
        stageMarginKrw: envelope.stageMarginKrw,
        baseStageMarginKrw: envelope.baseStageMarginKrw,
        regime: envelope.regime,
        source: envelope.authorityOwner === "V2" ? "v2" : "v1",
        leverageProfile: envelope.leverageProfile == null ? "BASE" : (envelope.leverageProfile as "BASE" | "BOOST_1" | "BOOST_2"),
        appliedLeverage: envelope.appliedLeverage,
        leverageReason: envelope.authorityReason,
        leverageBlockReason: envelope.hardBlockReason,
        exposureNotionalKrw: envelope.exposureNotionalKrw,
        equityMultiple: envelope.equityMultiple,
        entryQualityGrade: envelope.entryQualityGrade == null ? "B" : (envelope.entryQualityGrade as "S" | "A" | "B"),
        addOnAllowed: envelope.addOnAllowed ?? false,
        addOnPolicyMode:
            envelope.addOnPolicyMode === "PYRAMIDING" || envelope.addOnPolicyMode === "CONFIRMED_ADVERSE_ADDON"
                ? envelope.addOnPolicyMode
                : envelope.addOnPolicyMode === "NONE"
                    ? "NONE"
                    : undefined,
        requestedAddonNotionalUsdt: envelope.requestedAddonNotionalUsdt ?? undefined,
        originalDecision: envelope.originalDecision,
        originalSide: envelope.originalSide,
        originalStageMarginKrw: envelope.originalStageMarginKrw,
        hardBlockPresent: envelope.hardBlockPresent,
        hardBlockReason: envelope.hardBlockReason,
        nonBypassableHardBlockPresent: envelope.hardBlockReason != null && new Set<string>([
            "KILL_SWITCH_ACTIVE",
            "SERVER_TRADE_DISABLED",
            "CLOSE_ONLY_MODE",
            "RISK_MODE_HALT",
            "DAILY_LOSS_GUARD",
            "RECONCILE_SAFE_MODE",
            "MAX_SLOTS_REACHED",
            "MIN_ORDER_SIZE_UNDERFLOW",
            "ORDER_BUILD_FAIL",
            "CRASH_ENTRY_GUARD_BLOCK",
            "RISK_EXPOSURE_CAP_PRE_SUBMIT",
            "STOP_PRICE_MISSING",
            "LONG_INVALIDATION_ABOVE_ENTRY",
            "SHORT_INVALIDATION_BELOW_ENTRY"
        ]).has(envelope.hardBlockReason),
        stopPrice: envelope.newStopPrice ?? null,
        invalidationPx: envelope.invalidationPx ?? null,
        rangeBoxHighAtEntry: envelope.rangeBoxHighAtEntry,
        rangeBoxLowAtEntry: envelope.rangeBoxLowAtEntry,
        rangeBoxMidAtEntry: envelope.rangeBoxMidAtEntry,
        rangeBoxQuality: envelope.rangeBoxQuality,
        rangeBoxSlope: envelope.rangeBoxSlope,
        rangeBoxDistorted: envelope.rangeBoxDistorted,
        takeProfitPlan: envelope.takeProfitPlan,
        takeProfit1Px: envelope.takeProfit1Px,
        takeProfit2Px: envelope.takeProfit2Px,
        partialExitRatio: envelope.partialExitRatio
    };
}

/**
 * SHADOW PARITY LOGGING HELPER (Phase 4 Extraction)
 * Standardizes comparison logging between V1 and V2.
 */
export function buildV2ShadowParityPayload(
    symbol: string,
    ts: number,
    selectorResult: EngineV2SelectorResult
): Record<string, unknown> {
    return {
        symbol,
        ts,
        regime_v1: selectorResult.legacy_result.regime,
        regime_v2: selectorResult.v2_result.regime,
        decision_v1: selectorResult.legacy_result.decision,
        decision_v2: selectorResult.v2_result.decision,
        side_v1: selectorResult.legacy_result.side,
        side_v2: selectorResult.v2_result.side,
        size_v1: selectorResult.legacy_result.size,
        size_v2: selectorResult.v2_result.risk.stageMarginKrw,
        adopted_engine: selectorResult.adopted_result.engine,
        adopted_decision: selectorResult.adopted_result.adopted_decision,
        adopted_regime: selectorResult.adopted_result.adopted_regime,
        adopted_side: selectorResult.adopted_result.adopted_side,
        adopted_size: selectorResult.adopted_result.adopted_size_usd,
        adoption_reason: selectorResult.adopted_result.adoption_reason,
        mismatch: selectorResult.mismatch
    };
}

/** 
 * UNIFIED V2 BRIDGE (Phase 4 Strict Decoupling) 
 * Fully externalized bridge implementation for PaperEngine. 
 */
export function resolveSymbolDecisionEnvelope(
    input: V2BridgeInput
): SymbolDecisionEnvelope {
    const { symbol, fetchedAt, snapshot, legacy: legacyBridge, config, state, v2Mode } = input;
    const evaluationMode = input.evaluationMode ?? "authoritative";
    const commitKey = cycleAuthorityKey(input.runCycleId, String(symbol));
    pruneCycleAuthorityCommits(input.runCycleId);
    const existingCommit = cycleAuthorityCommitByKey.get(commitKey);

    if (evaluationMode === "diagnostic") {
        emitSingleCycleAuthorityCommitProof({
            runCycleId: input.runCycleId,
            symbol: String(symbol),
            first: existingCommit ?? {
                runCycleId: input.runCycleId ?? "unknown",
                symbol: String(symbol),
                firstAuthorityDecision: "SKIP",
                firstAuthoritySide: "none",
                firstSignedExecutionReady: false,
                decisionSource: "DIAGNOSTIC",
                accountEquityUsdt: null
            },
            secondaryEvaluationDetected: existingCommit != null,
            secondaryDecision: "DIAGNOSTIC_SKIPPED",
            secondarySide: "none",
            secondaryAllowedToMutate: false
        });
        const diagnosticAuthority: EntryExecutionAuthority = {
            decision: "HOLD",
            source: "v2",
            side: "none",
            stageMarginKrw: 0,
            regime: legacyBridge.regime ?? "UNKNOWN",
            stopPrice: null,
            invalidationPx: null
        };
        const diagnosticLegacy: LegacyDecisionResult = {
            decision: {
                regime_state: legacyBridge.regime,
                final_decision: legacyBridge.finalDecision,
                reject_reason: legacyBridge.rejectReason,
                required_cost_usd: legacyBridge.requiredCostUsd
            },
            executorDecision: null,
            intentSide: normalizeAuthoritySide(legacyBridge.intentSide),
            adaptiveOk: legacyBridge.adaptiveOk,
            adaptiveDetail: legacyBridge.adaptiveDetail
        };
        return {
            legacy: diagnosticLegacy,
            selector: null as unknown as EngineV2SelectorResult,
            authority: diagnosticAuthority,
            execution_authority_source: "diagnostic_observation_only",
            execution_authority_version: "diagnostic_skipped",
            v2_execution_envelope: undefined,
            legacy_comparison: {
                legacyDecision: legacyBridge.finalDecision as EngineV2FinalDecision,
                legacySide: normalizeAuthoritySide(legacyBridge.intentSide),
                legacySize: legacyBridge.requiredCostUsd,
                v2Decision: "SKIP",
                v2Side: "none",
                v2Size: 0,
                selectorMismatch: false
            },
            hard_block_present: false,
            runtime_authority_owner: "V2",
            runtime_authority_decision: "SKIP",
            runtime_authority_side: "none",
            runtime_authority_stage_margin_krw: 0,
            runtime_authority_size_usdt: 0,
            runtime_authority_new_stop_px: null,
            runtime_authority_invalidation_px: null,
            v1_decision: legacyBridge.finalDecision,
            v1_side: normalizeAuthoritySide(legacyBridge.intentSide) ?? undefined,
            v1_size: legacyBridge.requiredCostUsd,
            v2_decision: "SKIP",
            v2_side: "none",
            v2_size: 0,
            selector_mismatch: false
        };
    }

    // 1. Snapshot Mapping (Bridge DTO -> Internal Adapter)
    const snapshotAdapter: LegacySnapshotAdapter = {
        lastPrice: snapshot.lastPrice,
        latestCandleClose: snapshot.latestCandleClose,
        boxHigh: snapshot.boxHigh,
        boxLow: snapshot.boxLow,
        boxPosDiag: snapshot.boxPos,
        rangeConfidenceDiag: snapshot.rangeConfidence,
        ema20: snapshot.ema20,
        emaGapDiag: snapshot.emaGap,
        volatilityProxyDiag: snapshot.atr,
        atr20: snapshot.atr20,
        closedClose: snapshot.closedClose,
        signal: String(snapshot.signal),
        qualityScore: snapshot.qualityScore,
        entryCandidate: snapshot.entryCandidate ?? false,
        signalGateBlockedReason: snapshot.signalGateBlockedReason ?? null,
        rangeSignalDowngraded: snapshot.rangeSignalDowngraded ?? false,
        rangeSignalKeptByRelax: snapshot.rangeSignalKeptByRelax ?? false,
        swingHighSlope: snapshot.swingHighSlope,
        swingLowSlope: snapshot.swingLowSlope,
        rangeCenterSlope: snapshot.rangeCenterSlope,
        boxHighSlope: snapshot.boxHighSlope,
        boxLowSlope: snapshot.boxLowSlope,
        ema20Slope: snapshot.ema20Slope,
        ema60Slope: snapshot.ema60Slope,
        atrExpansion: snapshot.atrExpansion,
        volumeExpansion: snapshot.volumeExpansion,
        boxCohesion01: snapshot.boxCohesion01,
        boxCohesionDiag: snapshot.boxCohesion01,
        trendWeaknessScore: snapshot.trendWeaknessScore,
        trendWeaknessDiag: snapshot.trendWeaknessScore,
        breakoutFailureRate: snapshot.breakoutFailureRate,
        breakoutFailureRateDiag: snapshot.breakoutFailureRate,
        rangeOscillationScore: snapshot.rangeOscillationScore,
        rangeOscillationDiag: snapshot.rangeOscillationScore,
        reviewing_ticks: snapshot.reviewing_ticks,
        candles: snapshot.candles,
        htf_candles: snapshot.htf_candles,
        canonicalRegime: snapshot.canonicalRegime,
        canonicalRegimeSource: snapshot.canonicalRegimeSource,
        canonicalTrendScore: snapshot.canonicalTrendScore,
        canonicalRangeConfidence: snapshot.canonicalRangeConfidence,
        canonicalTrendWeaknessScore: snapshot.canonicalTrendWeaknessScore,
        canonicalRegimeAmbiguous: snapshot.canonicalRegimeAmbiguous,
        tickSz: snapshot.tickSz
    };

    // 2. Config Mapping
    const configAdapter: LegacyConfigAdapter = {
        baseSizeUsd: config.baseSizeUsd,
        paperMaxOpenPositions: config.maxOpenPositions,
        paperReentryCooldownMs: config.reentryCooldownMs,
        okxLiveMaxOrderNotionalUsdt: config.okxLiveMaxOrderNotionalUsdt,
        okxLiveMaxAddonNotionalUsdt: config.okxLiveMaxAddonNotionalUsdt,
        okxLiveMaxSymbolNotionalUsdt: config.okxLiveMaxSymbolNotionalUsdt,
        okxLiveMaxAccountNotionalUsdt: config.okxLiveMaxAccountNotionalUsdt,
        okxLiveMaxAddonCount: config.okxLiveMaxAddonCount,
        okxLiveEmergencyMaxOrderNotionalUsdt: config.okxLiveEmergencyMaxOrderNotionalUsdt,
        okxLiveMarginReserveRatio: config.okxLiveMarginReserveRatio,
        externalMarketContextEnabled: config.externalMarketContextEnabled,
        externalMarketContextShadowMode: config.externalMarketContextShadowMode,
        externalMarketContextFetchEnabled: config.externalMarketContextFetchEnabled,
        externalMarketContextWeight: config.externalMarketContextWeight,
        externalMarketMinSizeMultiplier: config.externalMarketMinSizeMultiplier,
        externalMarketMaxSizeMultiplier: config.externalMarketMaxSizeMultiplier,
        externalMarketContextMaxAgeMs: config.externalMarketContextMaxAgeMs,
        externalMarketEmergencyEventEnabled: config.externalMarketEmergencyEventEnabled
    };

    // 3. Legacy Decision Mapping
    const legacyDecision: LegacyDecisionResult = {
        decision: {
            regime_state: legacyBridge.regime,
            final_decision: legacyBridge.finalDecision,
            reject_reason: legacyBridge.rejectReason,
            required_cost_usd: legacyBridge.requiredCostUsd
        },
        executorDecision: legacyBridge.entryAllowed ? {
            entry_allowed: true,
            total_cost: legacyBridge.requiredCostUsd,
            executor: legacyBridge.executorLabel,
            expected_move: 0,
            risk_state: "OK",
            detail: {},
        } : null,
        intentSide: normalizeAuthoritySide(legacyBridge.intentSide),
        adaptiveOk: legacyBridge.adaptiveOk,
        adaptiveDetail: legacyBridge.adaptiveDetail
    };

    // 4. Execution
    const v2Input = adaptV2Input(
        symbol,
        fetchedAt,
        snapshotAdapter,
        configAdapter,
        state,
        buildV2LegacyAdapter(legacyDecision),
        snapshotAdapter.candles,
        input.evaluationMode,
        input.runCycleId
    );

    const v2ResRaw = runEngineV2(v2Input);
    const v2Res =
        state.reconcileSafeMode === true &&
        v2ResRaw.decision.decision === "ENTER"
            ? {
                ...v2ResRaw,
                decision: {
                    ...v2ResRaw.decision,
                    decision: "REJECT" as const,
                    risk: {
                        ...v2ResRaw.decision.risk,
                        isBlocked: true,
                        blockReason: "RECONCILE_SAFE_MODE_BLOCKED",
                        stageMarginKrw: 0,
                        leverageProfile: "BASE" as const,
                        appliedLeverage: 0,
                        leverageReason: "reconcile_safe_mode_blocked",
                        leverageBlockReason: "RECONCILE_SAFE_MODE_BLOCKED",
                        exposureNotionalKrw: 0,
                        equityMultiple: 0
                    },
                    explanation: {
                        ...v2ResRaw.decision.explanation,
                        reason: "REJECTED: RECONCILE_SAFE_MODE_BLOCKED"
                    }
                }
            }
            : v2ResRaw;
    const selector = reconcileV2Decision(legacyDecision, v2Res.decision, v2Mode);

    // 5. Adoption Reason Refinement (Phase 5)
    let adoption_reason = selector.adopted_result.adoption_reason;
    const v1_dec = legacyDecision.decision.final_decision;
    const v2_dec = v2Res.decision.decision;

    if (v2Mode === "engine_v2") {
        adoption_reason = "v2_mode_forced";
    } else if (v2Mode === "shadow_v2") {
        if (v1_dec === v2_dec && legacyDecision.intentSide === v2Res.decision.side) {
            adoption_reason = "shadow_parity_match";
        } else if (v1_dec === "ENTER" && v2_dec !== "ENTER") {
            adoption_reason = "v2_blocked_v1_open";
        } else if (v1_dec !== "ENTER" && v2_dec === "ENTER") {
            adoption_reason = "v2_open_v1_blocked";
        } else {
            adoption_reason = "shadow_compare_only";
        }
    } else {
        adoption_reason = v2Mode === "legacy" ? "legacy_mode_explicit" : "legacy_mode_unknown";
    }

    const v2FinalDecision = v2Res.decision.decision;
    const v2FinalSide = v2Res.decision.side ?? "none";
    const v2FinalSize = v2Res.decision.risk.stageMarginKrw ?? 0;

    const allowV2Override = process.env.ORBITALPHA_ENGINE_V2_ALLOW_OVERRIDE === "true";

    const refinedSelector: EngineV2SelectorResult = {
        ...selector,
        adopted_result: {
            ...selector.adopted_result,
            engine: allowV2Override ? "V2" : selector.adopted_result.engine,
            adopted_decision: allowV2Override ? "ENTER" : selector.adopted_result.adopted_decision,
            adopted_side: allowV2Override ? v2FinalSide : selector.adopted_result.adopted_side,
            adopted_size_usd: allowV2Override ? v2FinalSize : selector.adopted_result.adopted_size_usd,
            adoption_reason: allowV2Override ? "v2_override_legacy_block" : adoption_reason
        }
    };

    console.log("[V2_OVERRIDE_DECISION_PROOF]", {
        symbol: input.symbol,
        v2_mode: v2Mode,
        override_env_val: process.env.ORBITALPHA_ENGINE_V2_ALLOW_OVERRIDE ?? "undefined",
        override_enabled: allowV2Override,
        v1_blocks: null,
        v2_wants_enter: v2FinalDecision === "ENTER",
        v2_side_valid: (v2FinalSide === "long" || v2FinalSide === "short"),
        v2_size_valid: v2FinalSize > 0,
        allow_v2_override: allowV2Override,
        final_engine: refinedSelector.adopted_result.engine,
        final_adoption_reason: refinedSelector.adopted_result.adoption_reason
    });
    const legacyComparison: V2LegacyComparison = {
        legacyDecision: legacyDecision.decision.final_decision as EngineV2FinalDecision,
        legacySide: legacyDecision.intentSide ?? null,
        legacySize: legacyDecision.executorDecision?.total_cost ?? 0,
        v2Decision: v2Res.decision.decision,
        v2Side: v2Res.decision.side,
        v2Size: v2Res.decision.risk.stageMarginKrw ?? 0,
        selectorMismatch: selector.mismatch
    };
    const execMeta = v2Res.decision.metadata ?? {};
    let executionEnvelope = buildV2ExecutionAuthorityEnvelope({
        symbol: String(symbol),
        mode: v2Mode,
        v2Decision: v2Res.decision,
        selector: refinedSelector,
        legacyComparison,
        marketSubtype: v2Res.internal.judgment.subtype ?? null,
        exitPolicyAction: v2Res.internal.exitPolicy?.action ?? "HOLD",
        exitPolicyReason: v2Res.internal.exitPolicy?.reason ?? "NO_POSITION_HOLD",
        exitShouldExit: v2Res.internal.exitPolicy?.shouldExit ?? false,
        exitShouldReduce: v2Res.internal.exitPolicy?.shouldReduce ?? false,
        exitShouldPartial: v2Res.internal.exitPolicy?.shouldPartial ?? false,
        exitReduceRatio: v2Res.internal.exitPolicy?.reduceRatio ?? 0,
        exitUrgency: v2Res.internal.exitPolicy?.exitUrgency ?? "LOW",
        exitConfidence: v2Res.internal.exitPolicy?.exitConfidence ?? 0,
        newStopPrice: v2Res.internal.lifecycleAuthority?.newStopPrice,
        rangeBoxHighAtEntry: typeof execMeta.rangeBoxHighAtEntry === "number" ? execMeta.rangeBoxHighAtEntry : undefined,
        rangeBoxLowAtEntry: typeof execMeta.rangeBoxLowAtEntry === "number" ? execMeta.rangeBoxLowAtEntry : undefined,
        rangeBoxMidAtEntry: typeof execMeta.rangeBoxMidAtEntry === "number" ? execMeta.rangeBoxMidAtEntry : undefined,
        rangeBoxQuality: typeof execMeta.rangeBoxQuality === "number" ? execMeta.rangeBoxQuality : undefined,
        rangeBoxSlope: typeof execMeta.rangeBoxSlope === "number" ? execMeta.rangeBoxSlope : undefined,
        rangeBoxDistorted: typeof execMeta.rangeBoxDistorted === "boolean" ? execMeta.rangeBoxDistorted : undefined,
        takeProfitPlan: execMeta.takeProfitPlan ?? undefined,
        takeProfit1Px: typeof execMeta.takeProfit1Px === "number" ? execMeta.takeProfit1Px : undefined,
        takeProfit2Px: typeof execMeta.takeProfit2Px === "number" ? execMeta.takeProfit2Px : undefined,
        partialExitRatio: typeof execMeta.partialExitRatio === "number" ? execMeta.partialExitRatio : undefined,
        invalidationPx: typeof v2Res.internal.lifecycleAuthority?.invalidationPx === "number" 
            ? v2Res.internal.lifecycleAuthority.invalidationPx 
            : (typeof execMeta.invalidationPx === "number" ? execMeta.invalidationPx : undefined),
        alignedSignal: execMeta.alignedSignal ?? null,
        selectedSideAfterVeto: execMeta.selectedSideAfterVeto ?? null,
        promotionApplied: execMeta.promotionApplied ?? null,
        promotionReason: execMeta.promotionReason ?? null,
        promotionBlockReason: execMeta.promotionBlockReason ?? null,
        shockReactionBlockReason: execMeta.shockReactionBlockReason ?? null,
        qualityScore: typeof execMeta.qualityScore === "number" ? execMeta.qualityScore : null,
        v2DecisionFinal: execMeta.v2DecisionFinal ?? null,
        v2SideFinal: execMeta.v2SideFinal ?? null,
        rangeSideCandidate: execMeta.rangeSideCandidate ?? null,
        trendSideCandidate: execMeta.trendSideCandidate ?? null,
        reversalConfirmed: execMeta.reversalConfirmed ?? null,
        sideZoneValid: execMeta.sideZoneValid ?? null,
        expectedMissingCondition: execMeta.expectedMissingCondition ?? null,
        expectedNextAction: execMeta.expectedNextAction ?? null,
        primaryMissingCondition: execMeta.primary_missing_condition ?? null,
        secondaryMissingCondition: execMeta.secondary_missing_condition ?? null,
        rawMissingCondition: execMeta.raw_missing_condition ?? null,
        sideVetoDetail: execMeta.side_veto_detail ?? null,
        macro_source: execMeta.macro_source ?? null,
        daily_bias_actual: execMeta.daily_bias_actual ?? null,
        h4_bias_actual: execMeta.h4_bias_actual ?? null,
        h1_bias_actual: execMeta.h1_bias_actual ?? null,
        m15_bias_actual: execMeta.m15_bias_actual ?? null,
        m5_bias_actual: execMeta.m5_bias_actual ?? null,
        htf_bias: execMeta.htf_bias ?? null,
        htf_entry_policy: execMeta.htf_entry_policy ?? null,
        counter_trend_risk: execMeta.counter_trend_risk ?? null,
        htf_size_multiplier: execMeta.htf_size_multiplier ?? null,
        htf_requires_stronger_confirmation: execMeta.htf_requires_stronger_confirmation ?? null,
        htf_policy_reason: execMeta.htf_policy_reason ?? null,
        htf_hard_block_reason: execMeta.htf_hard_block_reason ?? null,
        trendOk: execMeta.trend_ok ?? execMeta.trendOk ?? null,
        displayRetestRequired: execMeta.display_retest_required ?? execMeta.displayRetestRequired ?? null,
        displaySupportRecheckRequired: execMeta.display_support_recheck_required ?? execMeta.displaySupportRecheckRequired ?? null,
        v2RouterExecutor: execMeta.v2_router_executor ?? null,
        stairStepDetected: execMeta.stair_step_detected ?? null,
        stairStepDirection: execMeta.stair_step_direction ?? null,
        stairStepConfidence: execMeta.stair_step_confidence ?? null,
        stairStepBlockReason: execMeta.stair_step_block_reason ?? null
    });


    const htfPolicy = v2Res.internal.judgment.htf_entry_policy ?? "ALLOW";
    if (executionEnvelope.decision === "ENTER") {
        if (htfPolicy === "HOLD" || htfPolicy === "NONE" || htfPolicy === "WAIT_FOR_HTF_ALIGNMENT") {
            const htfReason = v2Res.internal.judgment.htf_hard_block_reason || v2Res.internal.judgment.expected_next_action || htfPolicy;
            executionEnvelope = {
                ...executionEnvelope,
                decision: "REJECT",
                side: "none",
                stageMarginKrw: 0,
                hardBlockPresent: true,
                hardBlockReason: `HTF_POLICY_BLOCK: ${htfReason}`,
                authorityReason: `HTF_POLICY_BLOCK: ${v2Res.internal.judgment.htf_hard_block_reason || htfPolicy}`,
                primary_missing_condition: htfReason,
                raw_missing_condition: htfReason,
                expected_next_action: "WAIT_FOR_HTF_POLARITY_ALIGNMENT"
            };
        } else if (htfPolicy === "LONG_ONLY_OR_NONE" && executionEnvelope.side === "short") {
            executionEnvelope = {
                ...executionEnvelope,
                decision: "REJECT",
                side: "none",
                stageMarginKrw: 0,
                hardBlockPresent: true,
                hardBlockReason: "HTF_SHOCK_LONG_ONLY_BLOCK",
                authorityReason: "shock_reaction_direction_block",
                primary_missing_condition: "HTF_SHOCK_LONG_ONLY_BLOCK",
                raw_missing_condition: "HTF_SHOCK_LONG_ONLY_BLOCK",
                expected_next_action: "WAIT_FOR_HTF_POLARITY_ALIGNMENT"
            };
        } else if (htfPolicy === "SHORT_ONLY_OR_NONE" && executionEnvelope.side === "long") {
            executionEnvelope = {
                ...executionEnvelope,
                decision: "REJECT",
                side: "none",
                stageMarginKrw: 0,
                hardBlockPresent: true,
                hardBlockReason: "HTF_SHOCK_SHORT_ONLY_BLOCK",
                authorityReason: "shock_reaction_direction_block",
                primary_missing_condition: "HTF_SHOCK_SHORT_ONLY_BLOCK",
                raw_missing_condition: "HTF_SHOCK_SHORT_ONLY_BLOCK",
                expected_next_action: "WAIT_FOR_HTF_POLARITY_ALIGNMENT"
            };
        }
    }

    // --- BTCUSDT EXECUTION ENVELOPE PROTECTION GUARD ---
    // CRITICAL: Applied BEFORE authority derivation so authority reflects suppressed state.
    // Do NOT depend on currentPositions.side (may be polluted). Only okxActualSide matters.
    const btcEnvelopeSuppressed = String(symbol) === "BTCUSDT" && state.okxActualSide === "long";

    // --- V2_BTC_PROTECTED_SUPPRESSOR_PRE_AUTHORITY_AUDIT_PROOF (reconciler layer) ---
    // Emitted ALWAYS for BTCUSDT regardless of killSwitch/serverTradeEnabled.
    // This is the final layer before authority is derived from the envelope.
    if (String(symbol) === "BTCUSDT") {
        console.info(JSON.stringify({
            event: "V2_BTC_PROTECTED_SUPPRESSOR_PRE_AUTHORITY_AUDIT_PROOF",
            layer: "reconciler_envelope",
            symbol: "BTCUSDT",
            okxActualSide: state.okxActualSide ?? null,
            hasOkxActualLong: state.okxActualSide === "long",
            isBtcProtected: btcEnvelopeSuppressed,
            decisionBefore: executionEnvelope.decision,
            sideBefore: executionEnvelope.side,
            decisionAfter: btcEnvelopeSuppressed
                ? (executionEnvelope.decision === "ENTER" ? "REJECT" : executionEnvelope.decision)
                : executionEnvelope.decision,
            sideAfter: btcEnvelopeSuppressed ? "none" : executionEnvelope.side,
            hardBlockReason: btcEnvelopeSuppressed ? "BTCUSDT_OKX_LONG_POSITION_PROTECTED" : null,
            exitPolicyActionBefore: executionEnvelope.exitPolicyAction ?? null,
            exitShouldReduceBefore: executionEnvelope.exitShouldReduce ?? null,
            stageMarginKrwBefore: executionEnvelope.stageMarginKrw ?? null,
            ts: Date.now()
        }));
    }

    if (btcEnvelopeSuppressed) {
        executionEnvelope = {
            ...executionEnvelope,
            decision: executionEnvelope.decision === "ENTER" ? "REJECT" : executionEnvelope.decision,
            side: "none",
            stageMarginKrw: 0,
            baseStageMarginKrw: 0,
            exposureNotionalKrw: 0,
            addOnAllowed: false,
            exitPolicyAction: "SUPPRESSED",
            exitShouldExit: false,
            exitShouldReduce: false,
            exitShouldPartial: false,
            exitReduceRatio: 0,
            hardBlockPresent: true,
            hardBlockReason: "BTCUSDT_OKX_LONG_POSITION_PROTECTED",
            authorityReason: "btc_position_protected_suppress"
        } as typeof executionEnvelope;
    }

    const authority =
        v2Mode === "engine_v2"
            ? deriveExecutionAuthorityFromEnvelope(executionEnvelope)
            : deriveExecutionAuthority(refinedSelector);

    const v1Side = legacyDecision.intentSide ?? "none";
    const v2Side = v2Res.decision.side ?? "none";
    const v1Size = (legacyDecision.executorDecision?.total_cost ?? 0) * 1400;
    const v2Size = v2Res.decision.risk.stageMarginKrw ?? 0;

    const selectorMismatch =
        v1_dec !== v2_dec ||
        v1Side !== v2Side ||
        Math.abs(v1Size - v2Size) > 0.000001;
    
    // [V2_EXIT_POLICY_BRIDGE] Task 2: Connect V2 exit policy to execution pipeline
    const exitPolicyUsed = v2Mode === "engine_v2" || v2Mode === "shadow_v2";
    console.info(JSON.stringify({
        event: "EXIT_POLICY_DIAGNOSTIC_ONLY_PROOF",
        symbol: String(symbol),
        mode: v2Mode,
        exit_policy_action: executionEnvelope.exitPolicyAction,
        exit_policy_reason: executionEnvelope.exitPolicyReason,
        exit_should_exit: executionEnvelope.exitShouldExit,
        exit_should_reduce: executionEnvelope.exitShouldReduce,
        exit_should_partial: executionEnvelope.exitShouldPartial,
        runtime_authority_decision: executionEnvelope.decision,
        exit_policy_used_for_execution: exitPolicyUsed,
        diagnostic_only: !exitPolicyUsed
    }));
    const runtimeDecisionMatchesV2 = executionEnvelope.decision === v2_dec;
    const runtimeSideMatchesV2 = executionEnvelope.side === v2Side;
    const runtimeSizeMatchesV2 = Math.abs((executionEnvelope.stageMarginKrw ?? 0) - v2Size) <= 0.000001;
    const hardBlockEnterConflict = executionEnvelope.hardBlockPresent === true && executionEnvelope.decision === "ENTER";
    const invariantFailures: string[] = [];
    if (v2Mode === "engine_v2" && executionEnvelope.authoritySource !== "v2_execution_envelope") invariantFailures.push("AUTHORITY_SOURCE_MISMATCH");
    if (v2Mode === "engine_v2" && !runtimeDecisionMatchesV2) invariantFailures.push("RUNTIME_DECISION_MISMATCH_V2");
    if (v2Mode === "engine_v2" && !runtimeSideMatchesV2) invariantFailures.push("RUNTIME_SIDE_MISMATCH_V2");
    if (v2Mode === "engine_v2" && !runtimeSizeMatchesV2) invariantFailures.push("RUNTIME_SIZE_MISMATCH_V2");
    if (hardBlockEnterConflict) invariantFailures.push("HARDBLOCK_ENTER_CONFLICT");
    const invariantPassed = invariantFailures.length === 0;
    if (hardBlockEnterConflict) {
        console.warn("[V2_AUTHORITY_INVARIANT_WARN]", {
            symbol: String(symbol),
            mode: v2Mode,
            hard_block_present: executionEnvelope.hardBlockPresent,
            hard_block_reason: executionEnvelope.hardBlockReason,
            runtime_authority_decision: executionEnvelope.decision
        });
    }
    const openPositionsCount = Array.isArray(state.currentPositions) ? state.currentPositions.length : 0;
    const symbolLedgerExposureNotionalKrw = (Array.isArray(state.currentPositions) ? state.currentPositions : [])
        .filter((p) => String(p.symbol) === String(symbol))
        .reduce((acc, p) => acc + Math.max(0, Number(p.sizeUsd ?? 0)), 0);
    const ledgerExposureNotionalKrw = (Array.isArray(state.currentPositions) ? state.currentPositions : [])
        .reduce((acc, p) => acc + Math.max(0, Number(p.sizeUsd ?? 0)), 0);
    console.info(JSON.stringify({
        event: "V2_AUTHORITY_INVARIANT_PROOF",
        symbol: String(symbol),
        mode: v2Mode,
        invariant_passed: invariantPassed,
        authority_source: executionEnvelope.authoritySource,
        legacy_used_for_execution: executionEnvelope.authoritySource === "legacy_execution_envelope",
        legacy_comparison_only: executionEnvelope.authoritySource !== "legacy_execution_envelope",
        runtime_authority_decision: executionEnvelope.decision,
        v2_decision: v2_dec,
        runtime_authority_side: executionEnvelope.side,
        v2_side: v2Side,
        runtime_authority_stage_margin_krw: executionEnvelope.stageMarginKrw,
        runtime_authority_base_stage_margin_krw: executionEnvelope.baseStageMarginKrw,
        runtime_authority_size_usdt: executionEnvelope.stageMarginKrw / 1400,
        v2_size: v2Size,
        hard_block_present: executionEnvelope.hardBlockPresent,
        hard_block_reason: executionEnvelope.hardBlockReason,
        invariant_fail_reason: invariantFailures.join("|") || null
    }));
    console.info(JSON.stringify({
        event: "V2_SIZE_EXPOSURE_SANITY_PROOF",
        symbol: String(symbol),
        stageMarginKrw: executionEnvelope.stageMarginKrw,
        sizeUsdt: executionEnvelope.stageMarginKrw / 1400,
        finalStageMarginKrw: v2Size,
        exposureNotionalKrw: executionEnvelope.exposureNotionalKrw,
        candidateExposureNotionalKrw: v2Res.decision.risk.exposureNotionalKrw ?? 0,
        equityMultiple: executionEnvelope.equityMultiple,
        appliedLeverage: executionEnvelope.appliedLeverage,
        ledgerExposureNotionalKrw,
        symbolLedgerExposureNotionalKrw,
        openPositionsCount,
        hasPosition: symbolLedgerExposureNotionalKrw > 0,
        note: "diagnostic_only_size_exposure_sanity"
    }));
    console.info(JSON.stringify({
        event: "V2_EXECUTION_AUTHORITY_ENVELOPE_PROOF",
        symbol: String(symbol),
        mode: v2Mode,
        authority_source: executionEnvelope.authoritySource,
        authority_owner: executionEnvelope.authorityOwner,
        final_engine_owner: executionEnvelope.finalEngineOwner,
        adopted_engine: executionEnvelope.adoptedEngine,
        authority_version: executionEnvelope.authorityVersion,
        decision: executionEnvelope.decision,
        side: executionEnvelope.side,
        stage_margin_krw: executionEnvelope.stageMarginKrw,
        size_usdt: executionEnvelope.stageMarginKrw / 1400,
        regime: executionEnvelope.regime,
        market_subtype: executionEnvelope.marketSubtype,
        entry_quality_grade: executionEnvelope.entryQualityGrade,
        leverage_profile: executionEnvelope.leverageProfile,
        applied_leverage: executionEnvelope.appliedLeverage,
        exposure_notional_krw: executionEnvelope.exposureNotionalKrw,
        equity_multiple: executionEnvelope.equityMultiple,
        add_on_allowed: executionEnvelope.addOnAllowed,
        add_on_policy_action: executionEnvelope.addOnPolicyAction,
        add_on_policy_reason: executionEnvelope.addOnPolicyReason,
        exit_policy_action: executionEnvelope.exitPolicyAction,
        exit_policy_reason: executionEnvelope.exitPolicyReason,
        exit_should_exit: executionEnvelope.exitShouldExit,
        exit_should_reduce: executionEnvelope.exitShouldReduce,
        exit_should_partial: executionEnvelope.exitShouldPartial,
        exit_reduce_ratio: executionEnvelope.exitReduceRatio,
        exit_urgency: executionEnvelope.exitUrgency,
        exit_confidence: executionEnvelope.exitConfidence,
        paper_execution_ready: executionEnvelope.paperExecutionReady,
        signed_execution_ready: executionEnvelope.signedExecutionReady,
        hard_block_present: executionEnvelope.hardBlockPresent,
        hard_block_reason: executionEnvelope.hardBlockReason,
        legacy_decision: v1_dec,
        legacy_side: v1Side,
        legacy_size: v1Size,
        v2_decision: v2_dec,
        v2_side: v2Side,
        v2_size: v2Size,
        selector_mismatch: selectorMismatch,
        legacy_used_for_execution: executionEnvelope.authoritySource === "legacy_execution_envelope",
        legacy_comparison_only: executionEnvelope.authoritySource !== "legacy_execution_envelope",
        htf_entry_policy: executionEnvelope.htf_entry_policy,
        counter_trend_risk: executionEnvelope.counter_trend_risk,
        htf_size_multiplier: executionEnvelope.htf_size_multiplier,
        htf_requires_stronger_confirmation: executionEnvelope.htf_requires_stronger_confirmation,
        htf_policy_reason: executionEnvelope.htf_policy_reason,
        htf_hard_block_reason: executionEnvelope.htf_hard_block_reason,
        macro_source: executionEnvelope.macro_source,
        htf_5m_bias: executionEnvelope.m5_bias_actual,
        htf_15m_bias: executionEnvelope.m15_bias_actual,
        htf_1h_bias: executionEnvelope.h1_bias_actual,
        htf_4h_bias: executionEnvelope.h4_bias_actual,
        htf_1d_bias: executionEnvelope.daily_bias_actual,
        regime_final: executionEnvelope.regime,
        reject_reason: executionEnvelope.hardBlockReason,
        expected_missing_condition: executionEnvelope.expected_missing_condition,
        expected_next_action: executionEnvelope.expected_next_action,
        primary_missing_condition: executionEnvelope.primary_missing_condition,
        secondary_missing_condition: executionEnvelope.secondary_missing_condition,
        raw_missing_condition: executionEnvelope.raw_missing_condition,
        display_retest_required: executionEnvelope.display_retest_required,
        display_support_recheck_required: executionEnvelope.display_support_recheck_required,
        side_veto_detail: executionEnvelope.side_veto_detail,
        trend_ok: executionEnvelope.trend_ok
    }));

    const accountEquityUsdt = readBridgeAccountEquityUsdt(state);
    const signedExecutionReadyCommitted = executionEnvelope.signedExecutionReady === true;
    const liveSizingAuthoritative =
        accountEquityUsdt != null ||
        (executionEnvelope.stageMarginKrw > 0 && signedExecutionReadyCommitted);
    const priorCommit = cycleAuthorityCommitByKey.get(commitKey);
    const currentDecision = String(executionEnvelope.decision);
    const currentSide = String(executionEnvelope.side ?? "none");

    if (liveSizingAuthoritative) {
        const secondaryWeakPass =
            priorCommit != null &&
            priorCommit.decisionSource === "LIVE_EXECUTION" &&
            priorCommit.accountEquityUsdt != null &&
            accountEquityUsdt == null &&
            priorCommit.firstAuthorityDecision === "ENTER" &&
            currentDecision !== "ENTER";

        if (secondaryWeakPass) {
            emitSingleCycleAuthorityCommitProof({
                runCycleId: input.runCycleId,
                symbol: String(symbol),
                first: priorCommit,
                secondaryEvaluationDetected: true,
                secondaryDecision: currentDecision,
                secondarySide: currentSide,
                secondaryAllowedToMutate: false
            });
        } else if (!priorCommit) {
            cycleAuthorityCommitByKey.set(commitKey, {
                runCycleId: input.runCycleId ?? "unknown",
                symbol: String(symbol),
                firstAuthorityDecision: currentDecision,
                firstAuthoritySide: currentSide,
                firstSignedExecutionReady: signedExecutionReadyCommitted,
                decisionSource: "LIVE_EXECUTION",
                accountEquityUsdt
            });
            emitSingleCycleAuthorityCommitProof({
                runCycleId: input.runCycleId,
                symbol: String(symbol),
                first: cycleAuthorityCommitByKey.get(commitKey)!,
                secondaryEvaluationDetected: false,
                secondaryDecision: null,
                secondarySide: null,
                secondaryAllowedToMutate: false
            });
        } else {
            emitSingleCycleAuthorityCommitProof({
                runCycleId: input.runCycleId,
                symbol: String(symbol),
                first: priorCommit,
                secondaryEvaluationDetected: true,
                secondaryDecision: currentDecision,
                secondarySide: currentSide,
                secondaryAllowedToMutate: false
            });
        }
    }

    // 6. Comparison Metrics for Engine-State
    return {
        legacy: legacyDecision,
        selector: refinedSelector,
        authority,
        execution_authority_source: executionEnvelope.authoritySource,
        execution_authority_version: executionEnvelope.authorityVersion,
        v2_execution_envelope: executionEnvelope,
        legacy_comparison: legacyComparison,
        hard_block_present: executionEnvelope.hardBlockPresent,
        runtime_authority_owner: executionEnvelope.authorityOwner,
        runtime_authority_decision: executionEnvelope.decision,
        runtime_authority_side: executionEnvelope.side,
        runtime_authority_stage_margin_krw: executionEnvelope.stageMarginKrw,
        runtime_authority_size_usdt: executionEnvelope.stageMarginKrw / 1400,
        runtime_authority_new_stop_px: executionEnvelope.newStopPrice,
        runtime_authority_invalidation_px: executionEnvelope.invalidationPx,
        v1_decision: v1_dec,
        v1_side: v1Side,
        v1_size: v1Size,
        v2_decision: v2_dec,
        v2_side: v2Side,
        v2_size: v2Size,
        selector_mismatch: selectorMismatch
    };
}
