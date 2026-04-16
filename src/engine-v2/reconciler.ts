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

/** 
 * LEGACY NORMALIZATION HELPERS (Phase 4 Independence)
 * Ensures consistent behavior across engine boundaries.
 */
export function normalizeAuthoritySide(side: unknown): EngineV2Side {
    return side === "long" || side === "short" ? (side as EngineV2Side) : null;
}

export function normalizeAuthorityDecision(decision: unknown): EngineV2FinalDecision {
    const d = String(decision).toUpperCase();
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

    const useV2 = engineMode === "engine_v2";

    // Fresh object creation (No legacy mutation)
    const adopted_result: EngineV2AdoptionOutcome = {
        engine: useV2 ? "V2" : "V1",
        adopted_decision: useV2 ? v2.decision : legacy_result.decision,
        adopted_regime: useV2 ? v2.regime : legacy_result.regime,
        adopted_side: useV2 ? v2.side : legacy_result.side,
        adopted_size_usd: useV2 ? v2.risk.finalSizeUsd : legacy_result.size,
        adoption_reason: useV2 ? v2.explanation.reason : "v1_fallback"
    };

    return {
        legacy_result,
        v2_result: v2,
        adopted_result,
        mismatch: legacy_result.decision !== v2.decision || legacy_result.side !== v2.side
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
    return {
        decision: res.adopted_decision,
        side: res.adopted_side,
        sizeUsd: res.adopted_size_usd,
        regime: res.adopted_regime,
        source: res.engine === "V2" ? "v2" : "v1"
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
        size_v2: selectorResult.v2_result.risk.finalSizeUsd,
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
        signal: snapshot.signal as any,
        qualityScore: snapshot.qualityScore
    };

    // 2. Config Mapping
    const configAdapter: LegacyConfigAdapter = {
        baseSizeUsd: config.baseSizeUsd,
        paperMaxOpenPositions: config.maxOpenPositions,
        paperReentryCooldownMs: config.reentryCooldownMs
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
            detail: null
        } : null,
        intentSide: legacyBridge.intentSide as any,
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
        buildV2LegacyAdapter(legacyDecision)
    );

    const v2Res = runEngineV2(v2Input);
    const selector = reconcileV2Decision(legacyDecision, v2Res.decision, v2Mode);

    // 5. Adoption Reason Refinement (Phase 5)
    let adoption_reason = selector.adopted_result.adoption_reason;
    const v1_dec = legacyDecision.decision.final_decision;
    const v2_dec = v2Res.decision.decision;

    if (v2Mode === "engine_v2") {
        adoption_reason = "v2_mode_forced";
    } else if (v2Mode === "legacy") {
        adoption_reason = "legacy_mode_forced";
    } else if (v2Mode === "shadow_v2") {
        if (v1_dec === v2_dec) {
            adoption_reason = v1_dec === "ENTER" ? "parity_match_v2" : "parity_match_v1";
        } else {
            if (v1_dec === "ENTER" && v2_dec !== "ENTER") adoption_reason = "v2_blocked_v1_open";
            else if (v1_dec !== "ENTER" && v2_dec === "ENTER") adoption_reason = "v2_open_v1_blocked";
            else adoption_reason = "shadow_compare_only";
        }
    }

    const refinedSelector: EngineV2SelectorResult = {
        ...selector,
        adopted_result: {
            ...selector.adopted_result,
            adoption_reason
        }
    };
    const authority = deriveExecutionAuthority(refinedSelector);

    // 6. Comparison Metrics for Engine-State
    return {
        legacy: legacyDecision,
        selector: refinedSelector,
        authority,
        v1_decision: v1_dec,
        v1_side: legacyDecision.intentSide ?? "none",
        v1_size: legacyDecision.executorDecision?.total_cost ?? 0,
        v2_decision: v2_dec,
        v2_side: v2Res.decision.side ?? "none",
        v2_size: v2Res.decision.risk.finalSizeUsd,
        selector_mismatch: v1_dec !== v2_dec
    };
}
