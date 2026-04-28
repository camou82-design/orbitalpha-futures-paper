import type { BuildExecutionEnvelopeArgs, V2ExecutionAuthorityEnvelope } from "./types";

export function buildV2ExecutionAuthorityEnvelope(args: BuildExecutionEnvelopeArgs): V2ExecutionAuthorityEnvelope {
    const { symbol, mode, v2Decision, selector } = args;
    const risk = v2Decision.risk;
    const diagnostics = (risk as { diagnostics?: Record<string, unknown> }).diagnostics ?? {};
    const paperExecutionReady = diagnostics["paper_execution_ready"] === true;
    const signedExecutionReady = diagnostics["signed_execution_ready"] === true;
    const hardBlockPresent = risk.isBlocked === true;
    const hardBlockReason = risk.blockReason ?? null;
    const addOnPolicyAction = typeof diagnostics["addon_policy_action"] === "string" ? String(diagnostics["addon_policy_action"]) : null;
    const addOnPolicyReason = typeof diagnostics["addon_policy_reason"] === "string" ? String(diagnostics["addon_policy_reason"]) : null;
    const addOnAllowed = typeof diagnostics["addon_policy_allowed"] === "boolean" ? Boolean(diagnostics["addon_policy_allowed"]) : null;
    const entryQualityGrade = risk.entryQualityGrade ?? null;
    const leverageProfile = risk.leverageProfile ?? null;
    const appliedLeverage = Number(risk.appliedLeverage ?? 0);
    const exposureNotionalKrw = Number(risk.exposureNotionalKrw ?? 0);
    const equityMultiple = Number(risk.equityMultiple ?? 0);
    const marketSubtype = args.marketSubtype ?? null;
    const exitPolicyAction = args.exitPolicyAction ?? "HOLD";
    const exitPolicyReason = args.exitPolicyReason ?? "NO_POSITION_HOLD";
    const exitShouldExit = args.exitShouldExit ?? false;
    const exitShouldReduce = args.exitShouldReduce ?? false;
    const exitShouldPartial = args.exitShouldPartial ?? false;
    const exitReduceRatio = args.exitReduceRatio ?? 0;
    const exitUrgency = args.exitUrgency ?? "LOW";
    const exitConfidence = args.exitConfidence ?? 0;

    if (mode === "engine_v2") {
        return {
            symbol,
            mode,
            authoritySource: "v2_execution_envelope",
            authorityOwner: "V2",
            finalEngineOwner: "V2",
            adoptedEngine: selector.adopted_result.engine,
            decision: v2Decision.decision,
            side: v2Decision.side,
            sizeUsd: Number(v2Decision.risk.finalSizeUsd ?? 0),
            regime: String(v2Decision.regime),
            marketSubtype,
            entryQualityGrade,
            leverageProfile,
            appliedLeverage,
            exposureNotionalKrw,
            equityMultiple,
            addOnAllowed,
            addOnPolicyAction,
            addOnPolicyReason,
            exitPolicyAction,
            exitPolicyReason,
            exitShouldExit,
            exitShouldReduce,
            exitShouldPartial,
            exitReduceRatio,
            exitUrgency,
            exitConfidence,
            paperExecutionReady,
            signedExecutionReady,
            hardBlockPresent,
            hardBlockReason,
            authorityReason: "engine_v2_mode_uses_v2_execution_envelope",
            authorityVersion: "v2_execution_authority_envelope_v1"
        };
    }
    if (mode === "legacy") {
        return {
            symbol,
            mode,
            authoritySource: "legacy_execution_envelope",
            authorityOwner: "V1",
            finalEngineOwner: "V1",
            adoptedEngine: "V1",
            decision: selector.legacy_result.decision,
            side: selector.legacy_result.side,
            sizeUsd: selector.legacy_result.size,
            regime: selector.legacy_result.regime,
            marketSubtype,
            entryQualityGrade: null,
            leverageProfile: null,
            appliedLeverage: 0,
            exposureNotionalKrw: 0,
            equityMultiple: 0,
            addOnAllowed: null,
            addOnPolicyAction: null,
            addOnPolicyReason: null,
            exitPolicyAction,
            exitPolicyReason,
            exitShouldExit,
            exitShouldReduce,
            exitShouldPartial,
            exitReduceRatio,
            exitUrgency,
            exitConfidence,
            paperExecutionReady,
            signedExecutionReady,
            hardBlockPresent: false,
            hardBlockReason: null,
            authorityReason: "legacy_mode_uses_v1_execution",
            authorityVersion: "v2_execution_authority_envelope_v1"
        };
    }
    return {
        symbol,
        mode,
        authoritySource: "shadow_compare_only",
        authorityOwner: selector.adopted_result.engine,
        finalEngineOwner: selector.adopted_result.engine,
        adoptedEngine: selector.adopted_result.engine,
        decision: selector.adopted_result.adopted_decision,
        side: selector.adopted_result.adopted_side,
        sizeUsd: Number(selector.adopted_result.adopted_size_usd ?? 0),
        regime: String(selector.adopted_result.adopted_regime ?? "UNKNOWN"),
        marketSubtype,
        entryQualityGrade: selector.adopted_result.engine === "V2" ? entryQualityGrade : null,
        leverageProfile: selector.adopted_result.engine === "V2" ? leverageProfile : null,
        appliedLeverage: selector.adopted_result.engine === "V2" ? appliedLeverage : 0,
        exposureNotionalKrw: selector.adopted_result.engine === "V2" ? exposureNotionalKrw : 0,
        equityMultiple: selector.adopted_result.engine === "V2" ? equityMultiple : 0,
        addOnAllowed: selector.adopted_result.engine === "V2" ? addOnAllowed : null,
        addOnPolicyAction: selector.adopted_result.engine === "V2" ? addOnPolicyAction : null,
        addOnPolicyReason: selector.adopted_result.engine === "V2" ? addOnPolicyReason : null,
        exitPolicyAction,
        exitPolicyReason,
        exitShouldExit,
        exitShouldReduce,
        exitShouldPartial,
        exitReduceRatio,
        exitUrgency,
        exitConfidence,
        paperExecutionReady,
        signedExecutionReady,
        hardBlockPresent: selector.adopted_result.engine === "V2" ? hardBlockPresent : false,
        hardBlockReason: selector.adopted_result.engine === "V2" ? hardBlockReason : null,
        authorityReason: "shadow_mode_runtime_preserved_compare_only",
        authorityVersion: "v2_execution_authority_envelope_v1"
    };
}
