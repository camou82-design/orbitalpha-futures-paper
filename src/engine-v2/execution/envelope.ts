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
    
    const originalDecision = typeof diagnostics["original_v2_decision"] === "string" ? String(diagnostics["original_v2_decision"]) : undefined;
    const originalSide = typeof diagnostics["original_v2_side"] === "string" ? String(diagnostics["original_v2_side"]) : undefined;
    const originalStageMarginKrw = typeof diagnostics["original_stage_margin_krw"] === "number" ? Number(diagnostics["original_stage_margin_krw"]) : undefined;

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
    const newStopPrice = args.newStopPrice;

    if (mode === "engine_v2") {
        const signedReadyBlocked = v2Decision.decision === "ENTER" && signedExecutionReady !== true;

        let finalDecision = v2Decision.decision;
        let finalSide = v2Decision.side;
        let finalStageMarginKrw = Number(v2Decision.risk.stageMarginKrw ?? 0);
        let finalHardBlockPresent = hardBlockPresent;
        let finalHardBlockReason = hardBlockReason;
        let finalAuthorityReason = "engine_v2_mode_uses_v2_execution_envelope";

        if (signedReadyBlocked) {
            finalDecision = "REJECT";
            finalSide = "none";
            finalStageMarginKrw = 0;
            finalHardBlockPresent = true;
            finalHardBlockReason = "SIGNED_EXECUTION_NOT_READY";
            finalAuthorityReason = "signed_execution_not_ready_blocks_enter";
        }

        return {
            symbol,
            mode,
            authoritySource: "v2_execution_envelope",
            authorityOwner: "V2",
            finalEngineOwner: "V2",
            adoptedEngine: selector.adopted_result.engine,
            decision: finalDecision,
            side: finalSide as any,
            stageMarginKrw: finalStageMarginKrw,
            baseStageMarginKrw: Number(v2Decision.risk.baseStageMarginKrw ?? 0),
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
            hardBlockPresent: finalHardBlockPresent,
            hardBlockReason: finalHardBlockReason,
            authorityReason: finalAuthorityReason,
            authorityVersion: "v2_execution_authority_envelope_v1",
            originalDecision,
            originalSide,
            originalStageMarginKrw,
            newStopPrice,
            rangeBoxHighAtEntry: args.rangeBoxHighAtEntry,
            rangeBoxLowAtEntry: args.rangeBoxLowAtEntry,
            rangeBoxMidAtEntry: args.rangeBoxMidAtEntry,
            rangeBoxQuality: args.rangeBoxQuality,
            rangeBoxSlope: args.rangeBoxSlope,
            rangeBoxDistorted: args.rangeBoxDistorted,
            takeProfitPlan: args.takeProfitPlan,
            takeProfit1Px: args.takeProfit1Px,
            takeProfit2Px: args.takeProfit2Px,
            partialExitRatio: args.partialExitRatio,
            invalidationPx: args.invalidationPx,
            aligned_signal: args.alignedSignal,
            selected_side_after_veto: args.selectedSideAfterVeto,
            promotion_applied: args.promotionApplied,
            promotion_reason: args.promotionReason,
            promotion_block_reason: args.promotionBlockReason,
            shock_reaction_block_reason: args.shockReactionBlockReason ?? null,
            quality_score: args.qualityScore ?? null,
            v2_decision: args.v2DecisionFinal ?? null,
            v2_side: args.v2SideFinal ?? null,
            range_side_candidate: args.rangeSideCandidate ?? null,
            trend_side_candidate: args.trendSideCandidate ?? null,
            reversal_confirmed: args.reversalConfirmed ?? null,
            side_zone_valid: args.sideZoneValid ?? null,
            expected_missing_condition: args.expectedMissingCondition ?? null,
            expected_next_action: args.expectedNextAction ?? null,
            macro_source: args.macro_source ?? null,
            daily_bias_actual: args.daily_bias_actual ?? null,
            h4_bias_actual: args.h4_bias_actual ?? null,
            h1_bias_actual: args.h1_bias_actual ?? null,
            m15_bias_actual: args.m15_bias_actual ?? null,
            m5_bias_actual: args.m5_bias_actual ?? null,
            htf_bias: args.htf_bias ?? null,
            htf_entry_policy: args.htf_entry_policy ?? null,
            counter_trend_risk: args.counter_trend_risk ?? null,
            htf_size_multiplier: args.htf_size_multiplier ?? null,
            htf_requires_stronger_confirmation: args.htf_requires_stronger_confirmation ?? null,
            htf_policy_reason: args.htf_policy_reason ?? null,
            htf_hard_block_reason: args.htf_hard_block_reason ?? null
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
            stageMarginKrw: (selector.legacy_result.size ?? 0) * 1400,
            baseStageMarginKrw: (selector.legacy_result.size ?? 0) * 1400, // Legacy fallback
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
            authorityVersion: "v2_execution_authority_envelope_v1",
            originalDecision,
            originalSide,
            originalStageMarginKrw,
            newStopPrice,
            aligned_signal: args.alignedSignal ?? null,
            selected_side_after_veto: args.selectedSideAfterVeto ?? null,
            promotion_applied: args.promotionApplied ?? null,
            promotion_reason: args.promotionReason ?? null,
            promotion_block_reason: args.promotionBlockReason ?? null,
            shock_reaction_block_reason: args.shockReactionBlockReason ?? null,
            quality_score: args.qualityScore ?? null,
            v2_decision: args.v2DecisionFinal ?? null,
            v2_side: args.v2SideFinal ?? null,
            range_side_candidate: args.rangeSideCandidate ?? null,
            trend_side_candidate: args.trendSideCandidate ?? null,
            reversal_confirmed: args.reversalConfirmed ?? null,
            side_zone_valid: args.sideZoneValid ?? null,
            expected_missing_condition: args.expectedMissingCondition ?? null,
            expected_next_action: args.expectedNextAction ?? null,
            macro_source: args.macro_source ?? null,
            daily_bias_actual: args.daily_bias_actual ?? null,
            h4_bias_actual: args.h4_bias_actual ?? null,
            h1_bias_actual: args.h1_bias_actual ?? null,
            m15_bias_actual: args.m15_bias_actual ?? null,
            m5_bias_actual: args.m5_bias_actual ?? null,
            htf_bias: args.htf_bias ?? null,
            htf_entry_policy: args.htf_entry_policy ?? null,
            counter_trend_risk: args.counter_trend_risk ?? null,
            htf_size_multiplier: args.htf_size_multiplier ?? null,
            htf_requires_stronger_confirmation: args.htf_requires_stronger_confirmation ?? null,
            htf_policy_reason: args.htf_policy_reason ?? null,
            htf_hard_block_reason: args.htf_hard_block_reason ?? null
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
        stageMarginKrw: Number(selector.adopted_result.adopted_size_usd ?? 0) * 1400,
        baseStageMarginKrw: Number(selector.adopted_result.adopted_size_usd ?? 0) * 1400, // Adopted fallback
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
        authorityVersion: "v2_execution_authority_envelope_v1",
        originalDecision,
        originalSide,
        originalStageMarginKrw,
        newStopPrice,
        aligned_signal: args.alignedSignal ?? null,
        selected_side_after_veto: args.selectedSideAfterVeto ?? null,
        promotion_applied: args.promotionApplied ?? null,
        promotion_reason: args.promotionReason ?? null,
        promotion_block_reason: args.promotionBlockReason ?? null,
        shock_reaction_block_reason: args.shockReactionBlockReason ?? null,
        quality_score: args.qualityScore ?? null,
        v2_decision: args.v2DecisionFinal ?? null,
        v2_side: args.v2SideFinal ?? null,
        range_side_candidate: args.rangeSideCandidate ?? null,
        trend_side_candidate: args.trendSideCandidate ?? null,
        reversal_confirmed: args.reversalConfirmed ?? null,
        side_zone_valid: args.sideZoneValid ?? null,
        expected_missing_condition: args.expectedMissingCondition ?? null,
        expected_next_action: args.expectedNextAction ?? null,
        macro_source: args.macro_source ?? null,
        daily_bias_actual: args.daily_bias_actual ?? null,
        h4_bias_actual: args.h4_bias_actual ?? null,
        h1_bias_actual: args.h1_bias_actual ?? null,
        m15_bias_actual: args.m15_bias_actual ?? null,
        m5_bias_actual: args.m5_bias_actual ?? null,
        htf_bias: args.htf_bias ?? null,
        htf_entry_policy: args.htf_entry_policy ?? null,
        counter_trend_risk: args.counter_trend_risk ?? null,
        htf_size_multiplier: args.htf_size_multiplier ?? null,
        htf_requires_stronger_confirmation: args.htf_requires_stronger_confirmation ?? null,
        htf_policy_reason: args.htf_policy_reason ?? null,
        htf_hard_block_reason: args.htf_hard_block_reason ?? null
    };
}
