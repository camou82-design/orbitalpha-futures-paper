import {
    EngineV2Input,
    EngineV2Decision,
    EngineV2InternalResult,
    EngineV2FinalDecision,
    EngineV2Side,
    ExecutorOutput,
    LegacySnapshotAdapter,
    LegacyConfigAdapter,
    LegacyPositionAdapter,
    LegacyResultAdapter
} from "./types";
import type { MarketSymbol } from "../models/types";
import { detectMarketRegime } from "./market-judgment/detector";
import { calculateRegimeConfidence } from "./regime-confidence/scorer";
import { routeToExecutor } from "./engine-router/selector";
import { executeRangeRegime } from "./executors/range-executor";
import { executeTrendRegime } from "./executors/trend-executor";
import { executeTransitionRegime } from "./executors/transition-executor";
import { calculateRiskSizing } from "./risk-sizing/policy";
import { generateExplanation } from "./explain/diagnostic";
import { deriveV2StateAuthority } from "./state/derive";
import { evaluateV2AddOnPolicy } from "./addon/policy";
import { evaluateV2ExitPolicy } from "./exit/policy";
import { deriveMicroExecutionScore } from "./execution/micro-execution-score";
import { deriveTradeLifecycleAuthority } from "./lifecycle/trade-lifecycle-authority";
import type { MicroExecutionScoreSummary, V2ExitAuthorityResult, V2PartialAuthorityResult, V2TradeLifecycleAuthorityResult, V2CooldownAuthorityResult, V2PositionStateAuthorityResult } from "./types";

const V2_PROOF_KEY_TTL_MS = 60 * 60 * 1000;
const V2_PROOF_KEY_MAX_SIZE = 5000;
const MICRO_EXECUTION_PERF_LOG_INTERVAL_MS = 5 * 60 * 1000;
const v2ProofLastKeyByEventSymbol = new Map<string, { key: string; updatedAtMs: number }>();
const microPerfStats = {
    calculatedCount: 0,
    totalCalcMs: 0,
    maxCalcMs: 0,
    fallbackNeutralCount: 0,
    usedOrderbookCount: 0,
    usedRecentTradesCount: 0,
    appliedCount: 0,
    deferredCount: 0,
    sizeReducedCount: 0,
    hardBlockedCount: 0,
    lastLoggedAtMs: Date.now()
};
function pruneV2ProofKeyMap(nowMs: number): void {
    for (const [k, v] of v2ProofLastKeyByEventSymbol.entries()) {
        if (nowMs - v.updatedAtMs > V2_PROOF_KEY_TTL_MS) {
            v2ProofLastKeyByEventSymbol.delete(k);
        }
    }
    while (v2ProofLastKeyByEventSymbol.size > V2_PROOF_KEY_MAX_SIZE) {
        const oldest = v2ProofLastKeyByEventSymbol.keys().next();
        if (oldest.done) break;
        v2ProofLastKeyByEventSymbol.delete(oldest.value);
    }
}
export function shouldEmitV2Proof(
    eventName: string,
    symbol: string,
    key: string,
    highPriority: boolean
): boolean {
    const nowMs = Date.now();
    pruneV2ProofKeyMap(nowMs);
    const verbose = String(process.env.V2_PROOF_VERBOSE ?? "").toLowerCase() === "true";
    const mapKey = `${eventName}:${symbol}`;
    if (verbose || highPriority) {
        v2ProofLastKeyByEventSymbol.set(mapKey, { key, updatedAtMs: nowMs });
        return true;
    }
    const prev = v2ProofLastKeyByEventSymbol.get(mapKey)?.key;
    if (prev !== key) {
        v2ProofLastKeyByEventSymbol.set(mapKey, { key, updatedAtMs: nowMs });
        return true;
    }
    v2ProofLastKeyByEventSymbol.set(mapKey, { key, updatedAtMs: nowMs });
    return false;
}

/**
 * orchestrator for Engine-V2 5-tier architecture.
 * Produces an independent EngineV2Decision.
 */
export function runEngineV2(input: EngineV2Input): { decision: EngineV2Decision; internal: EngineV2InternalResult } {
    // Step 1: derive normalized state authority
    const v2State = deriveV2StateAuthority(input);
    // Step 2: project normalized state into authoritative input
    let authoritativeInput: EngineV2Input = {
        ...input,
        state: {
            ...input.state,
            currentPositions: v2State.currentPositions,
            lossStreaks: v2State.lossStreaks,
            directionalShockState: v2State.directionalShockState,
            longAllow: v2State.longAllow,
            shortAllow: v2State.shortAllow,
            executionReadiness: v2State.paperExecutionReady,
            paperExecutionReady: v2State.paperExecutionReady,
            signedExecutionReady: v2State.signedExecutionReady,
            freshTickBarrierActive: v2State.freshTickBarrierActive,
            freshTickExecutionBlocked: v2State.freshTickExecutionBlocked,
            freshTickCompletedCycles: v2State.freshTickCompletedCycles,
            freshTickRequiredCycles: v2State.freshTickRequiredCycles,
            entryQualityProfiles: v2State.entryQualityProfiles,
            serverTradeEnabled: v2State.serverTradeEnabled,
            closeOnlyMode: v2State.closeOnlyMode,
            killSwitch: v2State.killSwitch,
            reconcileSafeMode: v2State.reconcileSafeMode,
            riskMode: v2State.riskMode ?? undefined,
            dailyLossGuardTriggered: v2State.dailyLossGuardTriggered,
            crashState: v2State.crashState,
            pumpState: v2State.pumpState,
            pump_state: v2State.pumpState,
            accountEquityKrw: v2State.accountEquityKrw,
            maxUsableMarginKrw: v2State.maxUsableMarginKrw,
            exposureNotionalCapKrw: v2State.exposureNotionalCapKrw,
            symbolExposureNotionalCapKrw: v2State.symbolExposureNotionalCapKrw
        }
    };

    // Tier 1: Market Judgment (authoritative input only)
    const judgment = detectMarketRegime(authoritativeInput);

    // Tier 2: Regime Confidence (authoritative input only)
    const confidence = calculateRegimeConfidence(judgment, authoritativeInput);

    // Tier 3: Engine Router
    const routing = routeToExecutor(judgment, confidence);
    console.info(JSON.stringify({
        event: "V2_STATE_AUTHORITY_PROOF",
        symbol: String(input.symbol),
        state_authority_source: v2State.stateAuthoritySource,
        position_state_ready: v2State.positionStateReady,
        market_snapshot_ready: v2State.marketSnapshotReady,
        v2_input_ready: v2State.v2InputReady,
        serverTradeEnabled: v2State.serverTradeEnabled,
        closeOnlyMode: v2State.closeOnlyMode,
        killSwitch: v2State.killSwitch,
        reconcileSafeMode: v2State.reconcileSafeMode,
        riskMode: v2State.riskMode,
        dailyLossGuardTriggered: v2State.dailyLossGuardTriggered,
        freshTickBarrierActive: v2State.freshTickBarrierActive,
        freshTickExecutionBlocked: v2State.freshTickExecutionBlocked,
        directionalShockState: v2State.directionalShockState,
        crashState: v2State.crashState,
        pumpState: v2State.pumpState,
        longAllow: v2State.longAllow,
        shortAllow: v2State.shortAllow,
        current_positions_count: v2State.currentPositions.length,
        symbol_positions_count: v2State.symbolPositions.length,
        has_same_side_position: v2State.hasSameSidePosition,
        has_opposite_side_position: v2State.hasOppositeSidePosition,
        currentStage: v2State.currentStage,
        inferredIntentSide: v2State.inferredIntentSide,
        hasLongPosition: v2State.hasLongPosition,
        hasShortPosition: v2State.hasShortPosition,
        longStage: v2State.longStage,
        shortStage: v2State.shortStage,
        position_side_resolution_basis: "inferred_intent_side",
        accountEquityKrw: v2State.accountEquityKrw,
        maxUsableMarginKrw: v2State.maxUsableMarginKrw,
        exposureNotionalCapKrw: v2State.exposureNotionalCapKrw,
        symbolExposureNotionalCapKrw: v2State.symbolExposureNotionalCapKrw
    }));
    const marketProofKey = [
        judgment.subtype,
        judgment.shockPhase,
        judgment.rangePhase,
        judgment.trendPhase,
        judgment.transitionPhase,
        routing.executor,
        routing.reason
    ].join("|");
    if (shouldEmitV2Proof("V2_MARKET_JUDGMENT_PROOF", String(input.symbol), marketProofKey, false)) {
        console.info(JSON.stringify({
            event: "V2_MARKET_JUDGMENT_PROOF",
            symbol: String(input.symbol),
            market_judgment_state_source: "authoritative_input",
            v2_state_authority_source: v2State.stateAuthoritySource,
            judgmentVersion: judgment.judgmentVersion,
            regime: judgment.regime,
            regime_final: judgment.regime_final,
            subtype: judgment.subtype,
            subtypeReason: judgment.subtypeReason,
            shockPhase: judgment.shockPhase,
            rangePhase: judgment.rangePhase,
            trendPhase: judgment.trendPhase,
            transitionPhase: judgment.transitionPhase,
            confidenceScore: confidence.score,
            confidenceLevel: confidence.level,
            routerExecutor: routing.executor,
            routingReason: routing.reason,
            rangeScore: judgment.metrics.rangeScore,
            trendScore: judgment.metrics.trendScore,
            rangeConfidence: authoritativeInput.snapshot?.rangeConfidence ?? null,
            boxPos: authoritativeInput.snapshot?.boxPos ?? null,
            boxBreakSide: authoritativeInput.snapshot?.boxBreakSide ?? null,
            boxCohesion01: authoritativeInput.snapshot?.boxCohesion01 ?? null,
            breakoutFailureRate: authoritativeInput.snapshot?.breakoutFailureRate ?? null,
            emaGap: authoritativeInput.snapshot?.emaGap ?? null,
            trendWeaknessScore: authoritativeInput.snapshot?.trendWeaknessScore ?? null,
            directionalShockState: v2State.directionalShockState,
            crashState: v2State.crashState,
            pumpState: v2State.pumpState,
            data_ready: judgment.data_ready,
            dump_protection_hit: judgment.dump_protection_hit,
            volatility_guard_hit: judgment.volatility_guard_hit
        }));
    }

    // Tier 4: Executors
    let execution: ExecutorOutput;
    if (routing.executor === "RANGE") execution = executeRangeRegime(authoritativeInput);
    else if (routing.executor === "TREND") execution = executeTrendRegime(authoritativeInput);
    else if (routing.executor === "TRANSITION") execution = executeTransitionRegime(authoritativeInput, judgment);
    else {
        execution = {
            signal: "NONE" as const,
            side: "none" as const,
            reason: "No Routing",
            baseSizeIntent: 0,
            recheckSuggested: false,
            isAddOnEligible: false,
            metadata: {}
        };
    }
    const addOnPolicy = evaluateV2AddOnPolicy({
        symbol: String(input.symbol),
        side: execution.side,
        v2State,
        judgment,
        execution,
        snapshot: {
            qualityScore: authoritativeInput.snapshot.qualityScore,
            reviewing_ticks: authoritativeInput.snapshot.reviewing_ticks,
            boxPos: authoritativeInput.snapshot.boxPos,
            emaGap: authoritativeInput.snapshot.emaGap,
            trendWeaknessScore: authoritativeInput.snapshot.trendWeaknessScore,
            rangeConfidence: authoritativeInput.snapshot.rangeConfidence
        }
    });
    const shouldEmitAddOnProof =
        addOnPolicy.action !== "INITIAL_ONLY" ||
        addOnPolicy.hasSameSidePosition ||
        execution.signal === "LONG_CANDIDATE" ||
        execution.signal === "SHORT_CANDIDATE" ||
        execution.signal === "WAIT_RECHECK";
    const addOnProofKey = [
        addOnPolicy.action,
        addOnPolicy.reason,
        addOnPolicy.marketSubtype,
        addOnPolicy.transitionPhase,
        execution.signal,
        execution.side
    ].join("|");
    if (shouldEmitAddOnProof && shouldEmitV2Proof("V2_ADDON_POLICY_PROOF", String(input.symbol), addOnProofKey, addOnPolicy.action !== "INITIAL_ONLY")) {
        console.info(JSON.stringify({
            event: "V2_ADDON_POLICY_PROOF",
            symbol: String(input.symbol),
            side: addOnPolicy.side,
            action: addOnPolicy.action,
            allowed: addOnPolicy.allowed,
            reason: addOnPolicy.reason,
            addOnEligible: addOnPolicy.addOnEligible,
            isInitial: addOnPolicy.isInitial,
            isAddOn: addOnPolicy.isAddOn,
            currentStage: addOnPolicy.currentStage,
            hasSameSidePosition: addOnPolicy.hasSameSidePosition,
            hasOppositeSidePosition: addOnPolicy.hasOppositeSidePosition,
            marketRegime: addOnPolicy.marketRegime,
            marketSubtype: addOnPolicy.marketSubtype,
            shockPhase: addOnPolicy.shockPhase,
            rangePhase: addOnPolicy.rangePhase,
            trendPhase: addOnPolicy.trendPhase,
            transitionPhase: addOnPolicy.transitionPhase,
            qualityScore: addOnPolicy.qualityScore,
            reviewingTicks: addOnPolicy.reviewingTicks,
            pnlPct: addOnPolicy.pnlPct,
            boxPos: addOnPolicy.boxPos,
            emaGap: addOnPolicy.emaGap,
            trendWeaknessScore: addOnPolicy.trendWeaknessScore,
            rangeConfidence: addOnPolicy.rangeConfidence,
            evidence: addOnPolicy.evidence
        }));
    }
    if (
        addOnPolicy.action === "INITIAL_ONLY" &&
        (execution.signal === "LONG_CANDIDATE" || execution.signal === "SHORT_CANDIDATE" || execution.signal === "WAIT_RECHECK") &&
        shouldEmitV2Proof(
            "ADDON_POLICY_INITIAL_BYPASS_PROOF",
            String(input.symbol),
            `${execution.signal}|${execution.side}|${addOnPolicy.reason}`,
            true
        )
    ) {
        console.info(JSON.stringify({
            event: "ADDON_POLICY_INITIAL_BYPASS_PROOF",
            symbol: String(input.symbol),
            side: addOnPolicy.side,
            action: addOnPolicy.action,
            reason: addOnPolicy.reason,
            isInitial: addOnPolicy.isInitial,
            isAddOn: addOnPolicy.isAddOn,
            hasSameSidePosition: addOnPolicy.hasSameSidePosition,
            hasOppositeSidePosition: addOnPolicy.hasOppositeSidePosition,
            initial_blocked_by_addon_policy: false
        }));
    }
    if (addOnPolicy.isAddOn && addOnPolicy.allowed === false && (execution.signal === "LONG_CANDIDATE" || execution.signal === "SHORT_CANDIDATE")) {
        execution = {
            ...execution,
            signal: "WAIT_RECHECK" as const,
            side: "none" as const,
            reason: `ADDON_POLICY_${addOnPolicy.reason}`,
            baseSizeIntent: 0,
            recheckSuggested: true,
            isAddOnEligible: false,
            metadata: {
                ...execution.metadata,
                addonPolicyAction: addOnPolicy.action,
                addonPolicyReason: addOnPolicy.reason,
                addonPolicyAllowed: false
            }
        };
    }
    authoritativeInput = {
        ...authoritativeInput,
        state: {
            ...authoritativeInput.state,
            addOnPolicyAllowed: addOnPolicy.allowed,
            addOnPolicyReason: addOnPolicy.reason,
            addOnPolicyAction: addOnPolicy.action
        }
    };
    const exitPolicy = evaluateV2ExitPolicy({
        symbol: String(input.symbol),
        v2State,
        judgment,
        snapshot: {
            boxPos: authoritativeInput.snapshot.boxPos,
            boxBreakSide: authoritativeInput.snapshot.boxBreakSide,
            emaGap: authoritativeInput.snapshot.emaGap,
            trendWeaknessScore: authoritativeInput.snapshot.trendWeaknessScore,
            rangeConfidence: authoritativeInput.snapshot.rangeConfidence,
            qualityScore: authoritativeInput.snapshot.qualityScore
        }
    });
    if (
        exitPolicy.hasPosition &&
        shouldEmitV2Proof(
            "V2_EXIT_POLICY_PROOF",
            String(input.symbol),
            `${exitPolicy.action}|${exitPolicy.reason}|${exitPolicy.positionSide}|${exitPolicy.currentStage}`,
            true
        )
    ) {
        console.info(JSON.stringify({
            event: "V2_EXIT_POLICY_PROOF",
            symbol: String(input.symbol),
            hasPosition: exitPolicy.hasPosition,
            positionSide: exitPolicy.positionSide,
            positionSizeUsd: exitPolicy.positionSizeUsd,
            currentStage: exitPolicy.currentStage,
            pnlPct: exitPolicy.pnlPct,
            action: exitPolicy.action,
            shouldExit: exitPolicy.shouldExit,
            shouldReduce: exitPolicy.shouldReduce,
            shouldPartial: exitPolicy.shouldPartial,
            reason: exitPolicy.reason,
            reduceRatio: exitPolicy.reduceRatio,
            exitUrgency: exitPolicy.exitUrgency,
            exitConfidence: exitPolicy.exitConfidence,
            marketRegime: exitPolicy.marketRegime,
            marketSubtype: exitPolicy.marketSubtype,
            shockPhase: exitPolicy.shockPhase,
            rangePhase: exitPolicy.rangePhase,
            trendPhase: exitPolicy.trendPhase,
            transitionPhase: exitPolicy.transitionPhase,
            boxPos: exitPolicy.boxPos,
            boxBreakSide: exitPolicy.boxBreakSide,
            emaGap: exitPolicy.emaGap,
            trendWeaknessScore: exitPolicy.trendWeaknessScore,
            rangeConfidence: exitPolicy.rangeConfidence,
            qualityScore: exitPolicy.qualityScore,
            evidence: exitPolicy.evidence
        }));
    }
    if (routing.executor === "TRANSITION") {
        const transitionMeta = (execution.metadata ?? {}) as Record<string, unknown>;
        const transitionAction = String(transitionMeta.transitionAction ?? "REJECT");
        const transitionProofKey = [
            transitionMeta.transitionSetupType ?? "NONE",
            transitionAction,
            execution.signal,
            execution.reason,
            transitionMeta.transitionRejectReason ?? "none"
        ].join("|");
        if (
            shouldEmitV2Proof(
                "V2_TRANSITION_EXECUTOR_PROOF",
                String(input.symbol),
                transitionProofKey,
                transitionAction === "CONFIRM" || execution.signal === "WAIT_RECHECK"
            )
        ) {
            console.info(JSON.stringify({
                event: "V2_TRANSITION_EXECUTOR_PROOF",
                symbol: String(input.symbol),
                market_subtype: judgment.subtype,
                transitionPhase: transitionMeta.transitionPhase ?? judgment.transitionPhase ?? "NONE",
                transitionSetupType: transitionMeta.transitionSetupType ?? "NONE",
                transitionAction,
                signal: execution.signal,
                side: execution.side,
                reason: execution.reason,
                baseSizeIntent: execution.baseSizeIntent,
                isAddOnEligible: execution.isAddOnEligible,
                transitionWatchOnly: transitionMeta.transitionWatchOnly ?? null,
                transitionConfirmRequired: transitionMeta.transitionConfirmRequired ?? null,
                transitionRejectReason: transitionMeta.transitionRejectReason ?? null,
                transition_confirm_basis: transitionMeta.transitionConfirmBasis ?? "insufficient",
                transition_preflight_safety_passed: transitionMeta.transitionPreflightSafetyPassed ?? false,
                transition_preflight_block_reason: transitionMeta.transitionPreflightBlockReason ?? null,
                emaGap: transitionMeta.emaGap ?? authoritativeInput.snapshot?.emaGap ?? null,
                trendWeaknessScore: transitionMeta.trendWeaknessScore ?? authoritativeInput.snapshot?.trendWeaknessScore ?? null,
                rangeConfidence: transitionMeta.rangeConfidence ?? authoritativeInput.snapshot?.rangeConfidence ?? null,
                boxCohesion01: transitionMeta.boxCohesion01 ?? authoritativeInput.snapshot?.boxCohesion01 ?? null,
                breakoutFailureRate: transitionMeta.breakoutFailureRate ?? authoritativeInput.snapshot?.breakoutFailureRate ?? null,
                boxPos: transitionMeta.boxPos ?? authoritativeInput.snapshot?.boxPos ?? null,
                boxBreakSide: transitionMeta.boxBreakSide ?? authoritativeInput.snapshot?.boxBreakSide ?? null,
                qualityScore: transitionMeta.qualityScore ?? authoritativeInput.snapshot?.qualityScore ?? null,
                reviewingTicks: transitionMeta.reviewingTicks ?? authoritativeInput.snapshot?.reviewing_ticks ?? null,
                directionalShockState: transitionMeta.directionalShockState ?? authoritativeInput.state.directionalShockState ?? null,
                longAllow: transitionMeta.longAllow ?? authoritativeInput.state.longAllow ?? null,
                shortAllow: transitionMeta.shortAllow ?? authoritativeInput.state.shortAllow ?? null
            }));
        }
    }

    // Tier 5: Risk Sizing (executor/risk-sizing share same authoritative state)
    const riskSizing = calculateRiskSizing(judgment, confidence, execution, authoritativeInput);

    // Tier 5: Explanation (Diagnostics)
    const explanation = generateExplanation(judgment, execution, riskSizing);

    // Final Decision Formulation (Authority Enforcer)
    let finalDecision: EngineV2FinalDecision = "SKIP";
    const isCrashLockish = (state: string): boolean =>
        state.includes("CRASH_LOCK") || state.includes("CRASH_EXIT");
    const isPumpLockish = (state: string): boolean =>
        state.includes("PUMP_ALERT") || state.includes("PUMP_LOCK");

    const rawSignal = input.snapshot?.signal ?? "none";
    const hasRawCandidate =
        rawSignal === "paper_long_candidate" ||
        rawSignal === "paper_short_candidate" ||
        input.snapshot?.entryCandidate === true;

    const hardNoTrade =
        judgment.data_ready === false ||
        judgment.dump_protection_hit === true;

    const softNoTrade =
        judgment.volatility_guard_hit === true ||
        judgment.regime_final === "NO_TRADE" ||
        judgment.no_trade_reason != null;

    const isBlocked = riskSizing.isBlocked;
    const invalidNoneSignal = execution.signal === "NONE";
    const waitingRecheck = execution.signal === "WAIT_RECHECK";
    const invalidSideForEnter = execution.side === "none";
    const invalidSize = riskSizing.finalSizeUsd <= 0;
    let blockReason = riskSizing.blockReason ?? null;

    if (hardNoTrade) {
        finalDecision = "DISABLED";
    } else if (softNoTrade && hasRawCandidate) {
        finalDecision = "HOLD";
    } else if (softNoTrade) {
        finalDecision = "DISABLED";
    } else if (waitingRecheck) {
        finalDecision = "HOLD";
    } else if (isBlocked && blockReason === "NO_TRADE_REGIME") {
        finalDecision = "DISABLED";
    } else if (isBlocked) {
        finalDecision = "REJECT";
    } else if (invalidNoneSignal) {
        finalDecision = "SKIP";
    } else if (invalidSideForEnter) {
        finalDecision = "SKIP";
    } else if (invalidSize) {
        finalDecision = "REJECT";
    } else {
        finalDecision = "ENTER";
    }

    if (softNoTrade && hasRawCandidate && !hardNoTrade) {
        explanation.reason = "SOFT_NO_TRADE_DOWNGRADED_TO_HOLD";
        explanation.summary = "신호는 있으나 상위 시장판단이 보수적으로 작동해 즉시 진입 대신 재확인 대기";
    }

    let finalReason: string;
    if (finalDecision === "ENTER") {
        finalReason = explanation.reason;
    } else if (finalDecision === "HOLD") {
        finalReason = `HOLD: ${explanation.reason || execution.reason}`;
    } else if (finalDecision === "DISABLED") {
        finalReason = `DISABLED: ${judgment.no_trade_reason ?? blockReason ?? judgment.regime}`;
    } else if (finalDecision === "REJECT") {
        finalReason = `REJECTED: ${blockReason ?? execution.reason}`;
    } else {
        finalReason = `SKIPPED: ${execution.reason}`;
    }
    let decisionBeforeReadiness: EngineV2FinalDecision = finalDecision;
    if (blockReason === "EXECUTION_READINESS_FALSE") {
        if (waitingRecheck) decisionBeforeReadiness = "HOLD";
        else if (invalidNoneSignal || invalidSideForEnter) decisionBeforeReadiness = "SKIP";
        else if (invalidSize) decisionBeforeReadiness = "REJECT";
        else decisionBeforeReadiness = "ENTER";
    }

    const v2DecisionBeforePromotion = finalDecision;
    const v2SideBeforePromotion = execution.side;
    const v2RejectReasonBeforePromotion = blockReason;
    let v2DecisionAfterPromotion = finalDecision;
    let v2SideAfterPromotion: EngineV2Side = execution.side;
    let v2RejectReasonAfterPromotion: string | null = blockReason;
    let promotionApplied = false;
    let promotionReason: string | null = null;
    let promotionBlockReason: string | null = null;
    let promotionMinConditionPassed = false;
    let shockReactionPromotionType: string | null = null;
    let shockReactionBlockReason: string | null = null;
    let shockReactionSetupEvidence: Record<string, unknown> | null = null;
    let countertrendExceptionUsed = false;
    let contaminationSoftened = false;
    let contaminationHardReject = false;
    let contaminationSoftenReason: string | null = null;

    const shock = v2State.directionalShockState ?? "NONE";
    const crashState = String(v2State.crashState ?? "").toUpperCase();
    const pumpStateResolved = String(v2State.pumpState ?? "").toUpperCase();
    const marketMode = String(judgment.regime ?? "UNKNOWN");
    const activeEngineRouting = String(routing.executor ?? "UNKNOWN");
    const qualityScore = Number(input.snapshot?.qualityScore ?? 0);
    const trendWeaknessScore = Number(input.snapshot?.trendWeaknessScore ?? 1);
    const emaGap = Number(input.snapshot?.emaGap ?? 0);
    const trendOk =
        Number.isFinite(emaGap) &&
        Number.isFinite(trendWeaknessScore) &&
        Math.abs(emaGap) >= 0.0004 &&
        trendWeaknessScore < 0.5;
    const entryQualityGrade = riskSizing.entryQualityGrade ?? "B";
    const reviewingTicks = Number(input.snapshot?.reviewing_ticks ?? 0);
    const allowNewLong = Boolean((riskSizing.diagnostics as Record<string, unknown> | undefined)?.allow_new_long ?? v2State.longAllow);
    const allowNewShort = Boolean((riskSizing.diagnostics as Record<string, unknown> | undefined)?.allow_new_short ?? v2State.shortAllow);
    const riskLongAllow = v2State.longAllow;
    const riskShortAllow = v2State.shortAllow;
    const trendSideCandidate: EngineV2Side =
        shock === "DOWN" ? "short" :
            shock === "UP" ? "long" :
                emaGap < 0 ? "short" :
                    emaGap > 0 ? "long" : "none";
    const execMeta = execution.metadata ?? {};
    const readNullableNumber = (...values: unknown[]): number | null => {
        for (const v of values) {
            if (typeof v === "number" && Number.isFinite(v)) return v;
        }
        return null;
    };
    const readNullableBoolean = (...values: unknown[]): boolean | null => {
        for (const v of values) {
            if (typeof v === "boolean") return v;
        }
        return null;
    };
    const boxPos = readNullableNumber(execMeta.boxPos, input.snapshot?.boxPos);
    const boxBreakSide =
        typeof execMeta.boxBreakSide === "string"
            ? String(execMeta.boxBreakSide)
            : typeof input.snapshot?.boxBreakSide === "string"
                ? String(input.snapshot.boxBreakSide)
                : "none";
    const zoneFromMeta = typeof execMeta.zone === "string" ? execMeta.zone : null;
    const zone = zoneFromMeta ?? (boxPos == null ? "mid" : boxPos >= 0.74 ? "upper" : boxPos <= 0.26 ? "lower" : "mid");
    const rangeConfidence = readNullableNumber(execMeta.rangeConfidence, input.snapshot?.rangeConfidence);
    const boxCohesion01 = readNullableNumber(execMeta.boxCohesion01, input.snapshot?.boxCohesion01);
    const trendWeaknessFromMeta = readNullableNumber(execMeta.trendWeaknessScore, input.snapshot?.trendWeaknessScore);
    const relaxedRangeEntry = readNullableBoolean(execMeta.relaxedRangeEntry) === true;
    const reversalConfirmed = readNullableBoolean(execMeta.reversal_confirmed) === true;
    const sideZoneValidMeta = readNullableBoolean(execMeta.sideZoneValid);
    const sideZoneValid =
        sideZoneValidMeta != null
            ? sideZoneValidMeta
            : ((zone === "lower" && allowNewLong && riskLongAllow) || (zone === "upper" && allowNewShort && riskShortAllow));
    const rangeMetadataSource =
        execMeta.rangeConfidence != null ||
            execMeta.boxCohesion01 != null ||
            execMeta.trendWeaknessScore != null ||
            execMeta.boxPos != null ||
            execMeta.zone != null ||
            execMeta.reversal_confirmed != null ||
            execMeta.relaxedRangeEntry != null
            ? "executor_metadata"
            : "snapshot_fallback";
    const rangeMetadataMissingFields = [
        rangeConfidence == null ? "rangeConfidence" : null,
        boxCohesion01 == null ? "boxCohesion01" : null,
        trendWeaknessFromMeta == null ? "trendWeaknessScore" : null,
        boxPos == null ? "boxPos" : null,
        zone == null ? "zone" : null
    ].filter((x): x is string => x != null);
    const rangeSideCandidate: EngineV2Side =
        zone === "lower" && allowNewLong && riskLongAllow ? "long" :
            zone === "upper" && allowNewShort && riskShortAllow ? "short" : "none";
    const rangeEdgeExtreme =
        (rangeSideCandidate === "long" && (boxPos ?? 0.5) <= 0.08) ||
            (rangeSideCandidate === "short" && (boxPos ?? 0.5) >= 0.92);
    const alignedSignal =
        trendSideCandidate === "short" ? "paper_short_candidate" :
            trendSideCandidate === "long" ? "paper_long_candidate" : "none";

    const readinessDiag = (riskSizing.diagnostics ?? {}) as Record<string, unknown>;
    const paperExecutionReady = readinessDiag.paper_execution_ready === true;
    const signedExecutionReady = readinessDiag.signed_execution_ready === true;
    const hardControlClear =
        paperExecutionReady === true &&
        v2State.serverTradeEnabled === true &&
        v2State.closeOnlyMode !== true &&
        v2State.killSwitch !== true &&
        v2State.reconcileSafeMode !== true &&
        String(v2State.riskMode ?? "").toUpperCase() !== "HALT" &&
        v2State.dailyLossGuardTriggered !== true;
    const unpromotableRejectReasons = new Set<string>([
        "ENTRY_QUALITY_CONTAMINATED_SIMILAR",
        "CRASH_ENTRY_GUARD_BLOCK",
        "RISK_EXPOSURE_CAP_PRE_SUBMIT",
        "ORDER_BUILD_FAIL",
        "FRESH_TICK_EXECUTION_BLOCKED",
        "FRESH_TICK_BARRIER_ACTIVE"
    ]);
    const hardBlockReasons = new Set<string>([
        "CRASH_ENTRY_GUARD_BLOCK",
        "RISK_EXPOSURE_CAP_PRE_SUBMIT",
        "ORDER_BUILD_FAIL",
        "MAX_SLOTS_REACHED",
        "MIN_ORDER_SIZE_UNDERFLOW",
        "SERVER_TRADE_DISABLED",
        "CLOSE_ONLY_MODE",
        "KILL_SWITCH_ACTIVE",
        "RECONCILE_SAFE_MODE",
        "RISK_MODE_HALT",
        "DAILY_LOSS_GUARD",
        "FRESH_TICK_EXECUTION_BLOCKED",
        "FRESH_TICK_BARRIER_ACTIVE"
    ]);
    const hardBlockPresent =
        !hardControlClear ||
        (v2RejectReasonAfterPromotion != null && hardBlockReasons.has(v2RejectReasonAfterPromotion));
    const hardBlockReason =
        !hardControlClear
            ? "HARD_CONTROL_NOT_CLEAR"
            : (v2RejectReasonAfterPromotion != null && hardBlockReasons.has(v2RejectReasonAfterPromotion)
                ? v2RejectReasonAfterPromotion
                : null);
    const entryQualityDiag = (riskSizing.diagnostics ?? {}) as Record<string, unknown>;
    const profitDistance = typeof entryQualityDiag.entry_quality_distance_profit === "number"
        ? entryQualityDiag.entry_quality_distance_profit
        : null;
    const lossDistance = typeof entryQualityDiag.entry_quality_distance_loss === "number"
        ? entryQualityDiag.entry_quality_distance_loss
        : null;
    const contaminatedDistance = typeof entryQualityDiag.entry_quality_distance_contaminated === "number"
        ? entryQualityDiag.entry_quality_distance_contaminated
        : null;
    const trendShockAligned =
        shock === "NONE" ||
        (shock === "UP" && trendSideCandidate === "long") ||
        (shock === "DOWN" && trendSideCandidate === "short");
    const rangeSideAligned =
        (zone === "lower" && rangeSideCandidate === "long") ||
        (zone === "upper" && rangeSideCandidate === "short");
    const rangePromotableContext = rangeSideAligned || rangeEdgeExtreme;
    const rangeContextActive = activeEngineRouting === "RANGE" || marketMode === "RANGE";
    const shockDownActive = shock === "DOWN";
    const shockUpActive = shock === "UP";
    const shockDownRangeMidWatch =
        shockDownActive &&
        rangeContextActive &&
        zone === "mid" &&
        isCrashLockish(crashState);
    const shockUpRangeMidWatch =
        shockUpActive &&
        rangeContextActive &&
        zone === "mid" &&
        isPumpLockish(pumpStateResolved);
    const shockReactionWatchActive = shockDownRangeMidWatch || shockUpRangeMidWatch;
    const shockReactionDirection: "DOWN" | "UP" | "NONE" =
        shockDownActive ? "DOWN" : shockUpActive ? "UP" : "NONE";
    const shockReactionAllowedPrimarySide: EngineV2Side =
        shockReactionDirection === "DOWN" ? "short" : shockReactionDirection === "UP" ? "long" : "none";
    const shockEdgeSetupActiveReason: string[] = [];
    if (shockReactionDirection !== "NONE") shockEdgeSetupActiveReason.push("directional_shock_only");
    if (isCrashLockish(crashState)) shockEdgeSetupActiveReason.push("crash_lockish_watch");
    if (isPumpLockish(pumpStateResolved)) shockEdgeSetupActiveReason.push("pump_lockish_watch");
    const crashRecoveryHintFromState =
        crashState.includes("CRASH_REDUCE") ||
        crashState.includes("CRASH_RECOVERY");
    const pumpRecoveryHintFromState =
        pumpStateResolved.includes("PUMP_REDUCE") ||
        pumpStateResolved.includes("PUMP_RECOVERY");
    const shockRecoveryHint =
        relaxedRangeEntry ||
        reversalConfirmed ||
        crashRecoveryHintFromState ||
        pumpRecoveryHintFromState ||
        (typeof execMeta.crash_lock_bypass_reason === "string" && execMeta.crash_lock_bypass_reason.length > 0) ||
        (typeof execMeta.override_reason === "string" && execMeta.override_reason.length > 0);
    if (shockRecoveryHint) shockEdgeSetupActiveReason.push("recovery_hint_present");

    const edgeUpper = (boxPos ?? 0.5) >= 0.92 || zone === "upper";
    const edgeLower = (boxPos ?? 0.5) <= 0.08 || zone === "lower";
    const downUpperFailureShort =
        shockDownActive &&
        rangeContextActive &&
        edgeUpper &&
        (reversalConfirmed || relaxedRangeEntry || trendSideCandidate === "short");
    const downLowerBreakdownContinuationShort =
        shockDownActive &&
        rangeContextActive &&
        (zone === "lower" || boxBreakSide === "lower") &&
        emaGap < 0 &&
        trendSideCandidate === "short";
    const downLowerReversalConfirmedLong =
        shockDownActive &&
        rangeContextActive &&
        edgeLower &&
        reversalConfirmed &&
        shockRecoveryHint;
    const upLowerSupportLong =
        shockUpActive &&
        rangeContextActive &&
        edgeLower &&
        (reversalConfirmed || relaxedRangeEntry || trendSideCandidate === "long");
    const upUpperBreakoutContinuationLong =
        shockUpActive &&
        rangeContextActive &&
        (zone === "upper" || boxBreakSide === "upper") &&
        emaGap > 0 &&
        trendSideCandidate === "long";
    const upUpperReversalConfirmedShort =
        shockUpActive &&
        rangeContextActive &&
        edgeUpper &&
        reversalConfirmed &&
        shockRecoveryHint;

    // Shock reaction watch dry-run matrix (symmetry):
    // - DOWN + RANGE mid => HOLD/WAIT_RECHECK, no ENTER
    // - UP + RANGE mid => HOLD/WAIT_RECHECK, no ENTER
    // - DOWN + upper failure => short candidate setup
    // - DOWN + lower breakdown => short candidate setup
    // - DOWN + lower reversal confirmed => limited long exception setup
    // - UP + lower support => long candidate setup
    // - UP + upper breakout => long candidate setup
    // - UP + upper reversal confirmed => limited short exception setup

    if (hardControlClear) {
        if (shockReactionWatchActive) {
            shockReactionBlockReason = "SHOCK_REACTION_WATCH_MID_CHASE_BLOCKED";
            if (promotionBlockReason == null) promotionBlockReason = shockReactionBlockReason;
            if (v2DecisionAfterPromotion === "ENTER" || v2DecisionAfterPromotion === "SKIP") {
                v2DecisionAfterPromotion = "HOLD";
            }
            v2RejectReasonAfterPromotion = "WAIT_RECHECK";
            console.info(JSON.stringify({
                event: "SHOCK_REACTION_WATCH_PROOF",
                symbol: String(input.symbol),
                directional_shock_state: shock,
                crash_state: crashState || null,
                pump_state: pumpStateResolved || null,
                market_mode: marketMode,
                active_engine_routing: activeEngineRouting,
                boxPos,
                zone,
                side_before: v2SideBeforePromotion,
                side_after: v2SideAfterPromotion,
                decision_before: v2DecisionBeforePromotion,
                decision_after: v2DecisionAfterPromotion,
                promotion_applied: false,
                promotion_type: null,
                promotion_block_reason: promotionBlockReason,
                reversal_confirmed: reversalConfirmed,
                relaxedRangeEntry,
                range_edge_extreme: rangeEdgeExtreme,
                side_zone_valid: sideZoneValid,
                hard_block_present: hardBlockPresent,
                hard_block_reason: hardBlockReason,
                shock_reaction_watch_active: shockReactionWatchActive,
                shock_reaction_reason: "range_mid_requires_reaction_watch",
                shock_edge_setup_active_reason: shockEdgeSetupActiveReason.length > 0 ? shockEdgeSetupActiveReason.join("|") : null,
                shock_reaction_allowed_primary_side: shockReactionAllowedPrimarySide,
                shock_reaction_blocked_chase_reason: "mid_chase_forbidden",
                shock_reaction_next_valid_setups:
                    shockReactionDirection === "DOWN"
                        ? "upper_failure_short|lower_breakdown_short|lower_reversal_confirmed_long"
                        : "lower_support_long|upper_breakout_long|upper_reversal_confirmed_short",
                shock_reaction_promotion_type: null
            }));
            console.info(JSON.stringify({
                event: "SHOCK_REACTION_BLOCKED_MID_CHASE_PROOF",
                symbol: String(input.symbol),
                directional_shock_state: shock,
                crash_state: crashState || null,
                pump_state: pumpStateResolved || null,
                market_mode: marketMode,
                active_engine_routing: activeEngineRouting,
                boxPos,
                zone,
                promotion_block_reason: promotionBlockReason
            }));
            console.info(JSON.stringify({
                event: "SHOCK_REACTION_SYMMETRY_PROOF",
                symbol: String(input.symbol),
                directional_shock_state: shock,
                crash_state: crashState || null,
                pump_state: pumpStateResolved || null,
                market_mode: marketMode,
                active_engine_routing: activeEngineRouting,
                boxPos,
                zone,
                down_watch_active: shockDownRangeMidWatch,
                up_watch_active: shockUpRangeMidWatch,
                shock_reaction_watch_active: shockReactionWatchActive,
                shock_reaction_direction: shockReactionDirection,
                setup_type: null,
                setup_block_reason: promotionBlockReason,
                allowed_primary_side: shockReactionAllowedPrimarySide,
                countertrend_exception_used: false
            }));
        }

        // Shock edge setups (independent of generic promotion): no mid chase, edge-only continuation/reversal.
        if (
            !shockReactionWatchActive &&
            shockReactionDirection !== "NONE" &&
            rangeContextActive &&
            (v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "HOLD")
        ) {
            const continuationQualityOk = qualityScore >= 65 || reviewingTicks >= 1;
            let setupType: string | null = null;
            let setupSide: EngineV2Side = "none";
            let setupEvidence: Record<string, unknown> = {};
            let setupBlockReason: string | null = null;
            let allowedPrimarySide: EngineV2Side = shockReactionAllowedPrimarySide;
            let countertrendUsed = false;

            if (shockReactionDirection === "DOWN") {
                if (downUpperFailureShort && (allowNewShort || riskShortAllow) && continuationQualityOk) {
                    setupType = "upper_failure_short";
                    setupSide = "short";
                    setupEvidence = { edgeUpper, reversalConfirmed, relaxedRangeEntry };
                } else if (downLowerBreakdownContinuationShort && (allowNewShort || riskShortAllow) && continuationQualityOk) {
                    setupType = "lower_breakdown_continuation_short";
                    setupSide = "short";
                    setupEvidence = { boxBreakSide, emaGap, trend_side_candidate: trendSideCandidate };
                } else if (downLowerReversalConfirmedLong) {
                    setupType = "lower_reversal_confirmed_long";
                    setupSide = "long";
                    countertrendUsed = true;
                    setupEvidence = { edgeLower, reversalConfirmed, shockRecoveryHint };
                } else {
                    setupBlockReason = "SHOCK_REACTION_SETUP_NOT_READY_DOWN";
                }
            } else if (shockReactionDirection === "UP") {
                if (upLowerSupportLong && (allowNewLong || riskLongAllow) && continuationQualityOk) {
                    setupType = "lower_support_long";
                    setupSide = "long";
                    setupEvidence = { edgeLower, reversalConfirmed, relaxedRangeEntry };
                } else if (upUpperBreakoutContinuationLong && (allowNewLong || riskLongAllow) && continuationQualityOk) {
                    setupType = "upper_breakout_continuation_long";
                    setupSide = "long";
                    setupEvidence = { boxBreakSide, emaGap, trend_side_candidate: trendSideCandidate };
                } else if (upUpperReversalConfirmedShort) {
                    setupType = "upper_reversal_confirmed_short";
                    setupSide = "short";
                    countertrendUsed = true;
                    setupEvidence = { edgeUpper, reversalConfirmed, shockRecoveryHint };
                } else {
                    setupBlockReason = "SHOCK_REACTION_SETUP_NOT_READY_UP";
                }
            }

            if (setupType != null && setupSide !== "none") {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = setupSide;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = `SHOCK_REACTION_${setupType}`;
                promotionMinConditionPassed = true;
                shockReactionPromotionType = setupType;
                shockReactionSetupEvidence = setupEvidence;
                countertrendExceptionUsed = countertrendUsed;
                shockReactionBlockReason = null;
                promotionBlockReason = null;
            } else if (setupBlockReason != null) {
                v2DecisionAfterPromotion = "HOLD";
                v2SideAfterPromotion = "none";
                v2RejectReasonAfterPromotion = "WAIT_RECHECK";
                promotionApplied = false;
                promotionReason = null;
                promotionMinConditionPassed = false;
                shockReactionPromotionType = null;
                shockReactionSetupEvidence = null;
                countertrendExceptionUsed = false;
                shockReactionBlockReason = setupBlockReason;
                if (promotionBlockReason == null) promotionBlockReason = setupBlockReason;
            }
            if (setupType != null || setupBlockReason != null) {
                console.info(JSON.stringify({
                    event: "SHOCK_REACTION_SYMMETRY_PROOF",
                    symbol: String(input.symbol),
                    directional_shock_state: shock,
                    crash_state: crashState || null,
                    pump_state: pumpStateResolved || null,
                    market_mode: marketMode,
                    active_engine_routing: activeEngineRouting,
                    boxPos,
                    zone,
                    down_watch_active: shockDownRangeMidWatch,
                    up_watch_active: shockUpRangeMidWatch,
                    shock_reaction_watch_active: shockReactionWatchActive,
                    shock_reaction_direction: shockReactionDirection,
                    setup_type: setupType,
                    setup_block_reason: setupBlockReason,
                    shock_edge_setup_active_reason: shockEdgeSetupActiveReason.length > 0 ? shockEdgeSetupActiveReason.join("|") : null,
                    allowed_primary_side: allowedPrimarySide,
                    countertrend_exception_used: countertrendUsed
                }));
            }
        }
        if (v2RejectReasonAfterPromotion != null && unpromotableRejectReasons.has(v2RejectReasonAfterPromotion)) {
            promotionBlockReason = v2RejectReasonAfterPromotion;
        }
        if (v2RejectReasonAfterPromotion === "ENTRY_QUALITY_CONTAMINATED_SIMILAR") {
            const contaminatedClearlyDominant =
                profitDistance != null && contaminatedDistance != null
                    ? contaminatedDistance <= profitDistance * 1.005
                    : false;
            const nearlyEqualToLoss =
                lossDistance != null && contaminatedDistance != null
                    ? contaminatedDistance <= lossDistance * 1.005
                    : false;
            const sideZoneInvalid = activeEngineRouting === "RANGE" && (!sideZoneValid || zone === "mid");
            const explicitHardContamination =
                qualityScore < 70 ||
                sideZoneInvalid ||
                (contaminatedClearlyDominant && nearlyEqualToLoss);
            contaminationHardReject = explicitHardContamination;
            const highQualitySoftenEligible =
                (entryQualityGrade === "S" || entryQualityGrade === "A") &&
                qualityScore >= 80 &&
                paperExecutionReady === true &&
                !hardBlockPresent &&
                v2State.serverTradeEnabled === true &&
                ((activeEngineRouting === "TREND" && trendShockAligned && trendSideCandidate !== "none") ||
                    (activeEngineRouting === "RANGE" && rangePromotableContext));
            if (highQualitySoftenEligible && !explicitHardContamination) {
                contaminationSoftened = true;
                contaminationSoftenReason = "V2_CONTAMINATION_SOFTENED_FOR_HIGH_QUALITY_AUTHORITY";
                v2DecisionAfterPromotion = "HOLD";
                v2RejectReasonAfterPromotion = null;
                promotionBlockReason = null;
            } else if (entryQualityGrade === "B" && !explicitHardContamination) {
                contaminationSoftened = true;
                contaminationSoftenReason = "V2_CONTAMINATION_B_GRADE_REVIEW";
                v2DecisionAfterPromotion = "HOLD";
                v2RejectReasonAfterPromotion = "WAIT_RECHECK";
                promotionBlockReason = null;
            } else if (explicitHardContamination) {
                promotionBlockReason = "ENTRY_QUALITY_CONTAMINATED_SIMILAR";
            }
        }
        const trendPromotionCandidate =
            promotionBlockReason == null &&
            !shockReactionWatchActive &&
            (v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "HOLD" || v2SideAfterPromotion === "none") &&
            (v2RejectReasonAfterPromotion === "WAIT_RECHECK" || v2RejectReasonAfterPromotion == null || contaminationSoftened) &&
            activeEngineRouting === "TREND" &&
            trendSideCandidate !== "none" &&
            trendOk;
        if (trendPromotionCandidate && trendShockAligned) {
            if (entryQualityGrade === "S" || entryQualityGrade === "A") {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = trendSideCandidate;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = contaminationSoftened
                    ? "V2_CONTAMINATION_SOFTENED_FOR_HIGH_QUALITY_AUTHORITY"
                    : "V2_TREND_QUALIFIED_FINAL_PROMOTION";
                promotionMinConditionPassed = true;
            } else if (entryQualityGrade === "B" && (reviewingTicks >= 2 || qualityScore >= 78)) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = trendSideCandidate;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "V2_TREND_QUALIFIED_FINAL_PROMOTION";
                promotionMinConditionPassed = true;
            }
        }

        const rangePromotionCandidate =
            promotionBlockReason == null &&
            !shockReactionWatchActive &&
            (v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "HOLD" || v2SideAfterPromotion === "none") &&
            activeEngineRouting === "RANGE" &&
            rangeSideCandidate !== "none" &&
            zone !== "mid" &&
            sideZoneValid &&
            (rangeConfidence ?? 0) >= 0.65 &&
            (boxCohesion01 ?? 0) >= 0.9 &&
            (trendWeaknessFromMeta ?? 0) >= 0.7 &&
            (
                (
                    qualityScore >= 80 &&
                    (
                        relaxedRangeEntry ||
                        reversalConfirmed ||
                        ((rangeConfidence ?? 0) >= 0.70 && rangeSideCandidate === "long" && (boxPos ?? 1) <= 0.08) ||
                        ((rangeConfidence ?? 0) >= 0.70 && rangeSideCandidate === "short" && (boxPos ?? 0) >= 0.92)
                    )
                ) ||
                (
                    entryQualityGrade === "B" &&
                    (
                        qualityScore >= 78 ||
                        reviewingTicks >= 2 ||
                        ((rangeConfidence ?? 0) >= 0.70 && sideZoneValid && rangeEdgeExtreme)
                    )
                )
            );
        if (rangePromotionCandidate) {
            v2DecisionAfterPromotion = "ENTER";
            v2SideAfterPromotion = rangeSideCandidate;
            v2RejectReasonAfterPromotion = null;
            promotionApplied = true;
            promotionReason = contaminationSoftened
                ? "V2_CONTAMINATION_SOFTENED_FOR_HIGH_QUALITY_AUTHORITY"
                : "V2_RANGE_QUALIFIED_FINAL_PROMOTION";
            promotionMinConditionPassed = true;
        }

        const saCandidateSide = trendSideCandidate !== "none" ? trendSideCandidate : rangeSideCandidate;
        const saPromotionNeeded =
            (entryQualityGrade === "S" || entryQualityGrade === "A") &&
            saCandidateSide !== "none" &&
            !shockReactionWatchActive &&
            (v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "HOLD") &&
            v2SideAfterPromotion === "none";
        if (saPromotionNeeded) {
            v2DecisionAfterPromotion = "ENTER";
            v2SideAfterPromotion = saCandidateSide;
            v2RejectReasonAfterPromotion = null;
            promotionApplied = true;
            promotionReason = promotionReason ?? "V2_TREND_QUALIFIED_FINAL_PROMOTION";
            promotionMinConditionPassed = true;
        }

        if (shock === "DOWN" && v2DecisionAfterPromotion === "ENTER") {
            const downCounterTrendLongAllowed =
                v2SideAfterPromotion === "long" &&
                (zone === "lower" || rangeEdgeExtreme) &&
                reversalConfirmed &&
                shockRecoveryHint;
            if (v2SideAfterPromotion !== "short" && !downCounterTrendLongAllowed) {
                v2DecisionAfterPromotion = "HOLD";
                v2SideAfterPromotion = "none";
                v2RejectReasonAfterPromotion = "WAIT_RECHECK";
                promotionApplied = false;
                promotionReason = null;
                promotionMinConditionPassed = false;
                shockReactionBlockReason = "DOWN_SHOCK_COUNTERTREND_LONG_NOT_CONFIRMED";
                promotionBlockReason = shockReactionBlockReason;
                countertrendExceptionUsed = false;
            }
        }
        if (shock === "UP" && v2DecisionAfterPromotion === "ENTER") {
            const upCounterTrendShortAllowed =
                v2SideAfterPromotion === "short" &&
                (zone === "upper" || rangeEdgeExtreme) &&
                reversalConfirmed &&
                shockRecoveryHint;
            if (v2SideAfterPromotion !== "long" && !upCounterTrendShortAllowed) {
                v2DecisionAfterPromotion = "HOLD";
                v2SideAfterPromotion = "none";
                v2RejectReasonAfterPromotion = "WAIT_RECHECK";
                promotionApplied = false;
                promotionReason = null;
                promotionMinConditionPassed = false;
                shockReactionBlockReason = "UP_SHOCK_COUNTERTREND_SHORT_NOT_CONFIRMED";
                promotionBlockReason = shockReactionBlockReason;
                countertrendExceptionUsed = false;
            }
        }

        if (promotionApplied) {
            if (shockReactionPromotionType == null && shock === "DOWN") {
                if (v2SideAfterPromotion === "short" && zone === "upper") shockReactionPromotionType = "upper_failure_short";
                else if (v2SideAfterPromotion === "short" && zone === "lower") shockReactionPromotionType = "lower_breakdown_continuation_short";
                else if (v2SideAfterPromotion === "long" && zone === "lower" && reversalConfirmed) shockReactionPromotionType = "lower_reversal_confirmed_long";
            } else if (shockReactionPromotionType == null && shock === "UP") {
                if (v2SideAfterPromotion === "long" && zone === "lower") shockReactionPromotionType = "lower_support_long";
                else if (v2SideAfterPromotion === "long" && zone === "upper") shockReactionPromotionType = "upper_breakout_continuation_long";
                else if (v2SideAfterPromotion === "short" && zone === "upper" && reversalConfirmed) shockReactionPromotionType = "upper_reversal_confirmed_short";
            }
            if (shockReactionPromotionType != null) {
                const setupEvidence = shockReactionSetupEvidence ?? {
                    boxBreakSide,
                    emaGap,
                    trend_side_candidate: trendSideCandidate,
                    range_side_candidate: rangeSideCandidate,
                    reversal_confirmed: reversalConfirmed,
                    relaxedRangeEntry,
                    shock_recovery_hint: shockRecoveryHint
                };
                console.info(JSON.stringify({
                    event: "SHOCK_REACTION_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    directional_shock_state: shock,
                    crash_state: crashState || null,
                    pump_state: pumpStateResolved || null,
                    market_mode: marketMode,
                    active_engine_routing: activeEngineRouting,
                    boxPos,
                    zone,
                    side_before: v2SideBeforePromotion,
                    side_after: v2SideAfterPromotion,
                    decision_before: v2DecisionBeforePromotion,
                    decision_after: v2DecisionAfterPromotion,
                    promotion_applied: promotionApplied,
                    promotion_type: shockReactionPromotionType,
                    setup_type: shockReactionPromotionType,
                    setup_evidence: setupEvidence,
                    shock_edge_setup_active_reason: shockEdgeSetupActiveReason.length > 0 ? shockEdgeSetupActiveReason.join("|") : null,
                    boxBreakSide,
                    emaGap,
                    qualityScore,
                    rangeConfidence,
                    boxCohesion01,
                    trendWeaknessScore: trendWeaknessFromMeta,
                    reviewingTicks,
                    trend_side_candidate: trendSideCandidate,
                    range_side_candidate: rangeSideCandidate,
                    promotion_block_reason: promotionBlockReason,
                    promotion_min_condition_passed: promotionMinConditionPassed,
                    reversal_confirmed: reversalConfirmed,
                    relaxedRangeEntry,
                    shock_recovery_hint: shockRecoveryHint,
                    longAllow: riskLongAllow,
                    shortAllow: riskShortAllow,
                    allowed_primary_side: shockReactionAllowedPrimarySide,
                    countertrend_exception_used: countertrendExceptionUsed,
                    range_edge_extreme: rangeEdgeExtreme,
                    side_zone_valid: sideZoneValid,
                    hard_block_present: hardBlockPresent,
                    hard_block_reason: hardBlockReason
                }));
            }
        }
    } else {
        promotionBlockReason = "HARD_CONTROL_NOT_CLEAR";
    }

    finalDecision = v2DecisionAfterPromotion;
    blockReason = v2RejectReasonAfterPromotion;
    const decisionAfterReadiness: EngineV2FinalDecision = finalDecision;
    let microExecution: MicroExecutionScoreSummary | null = null;
    let lifecycleAuthority: V2TradeLifecycleAuthorityResult | null = null;
    let v2ExitAuthority: V2ExitAuthorityResult | null = null;
    let v2PartialAuthority: V2PartialAuthorityResult | null = null;
    let v2CooldownAuthority: V2CooldownAuthorityResult | null = null;
    let v2PositionStateAuthority: V2PositionStateAuthorityResult | null = null;
    const exitActionMap: Record<string, V2ExitAuthorityResult["exitAction"]> = {
        HOLD: "none",
        WATCH: "watch",
        PARTIAL_TAKE_PROFIT: "partial_candidate",
        REDUCE: "partial_candidate",
        FULL_EXIT: "exit"
    };
    const exitUrgencyMap: Record<string, V2ExitAuthorityResult["exitUrgency"]> = {
        LOW: "low",
        MID: "medium",
        HIGH: "high",
        CRITICAL: "emergency"
    };
    const exitTrueInconsistencyReasons: string[] = [];
    const exitKnownShadowGaps: string[] = ["EXIT_EXECUTION_OWNER_NOT_V2"];
    const exitProofReasons = [
        `exit_policy_action:${exitPolicy.action}`,
        `exit_policy_reason:${exitPolicy.reason}`,
        `exit_policy_evidence:${exitPolicy.evidence}`
    ];
    v2ExitAuthority = {
        symbol: String(input.symbol),
        side: exitPolicy.positionSide === "none" ? "none" : exitPolicy.positionSide,
        exitAuthorityOwner: "v2",
        exitExecutionOwner: "paper_engine",
        exitAction: exitActionMap[exitPolicy.action] ?? "none",
        shouldExit: exitPolicy.shouldExit === true,
        exitReason: exitPolicy.hasPosition ? exitPolicy.reason : null,
        exitUrgency: exitUrgencyMap[exitPolicy.exitUrgency] ?? "none",
        exitConfidence: exitPolicy.exitConfidence,
        reduceRatio: exitPolicy.reduceRatio > 0 ? exitPolicy.reduceRatio : null,
        proofReasons: exitProofReasons,
        trueInconsistencyReasons: exitTrueInconsistencyReasons,
        knownShadowGaps: exitKnownShadowGaps
    };
    const partialActionMap: Record<string, V2PartialAuthorityResult["partialAction"]> = {
        HOLD: "none",
        WATCH: "watch",
        PARTIAL_TAKE_PROFIT: "protect_profit",
        REDUCE: "reduce_candidate",
        FULL_EXIT: "none"
    };
    const partialUrgencyMap: Record<string, V2PartialAuthorityResult["partialUrgency"]> = {
        LOW: "low",
        MID: "medium",
        HIGH: "high",
        CRITICAL: "high"
    };
    const partialProofReasons = [
        `exit_policy_action:${exitPolicy.action}`,
        `exit_policy_should_partial:${exitPolicy.shouldPartial}`,
        `exit_policy_should_reduce:${exitPolicy.shouldReduce}`,
        `exit_policy_reason:${exitPolicy.reason}`
    ];
    v2PartialAuthority = {
        symbol: String(input.symbol),
        side: exitPolicy.positionSide === "none" ? "none" : exitPolicy.positionSide,
        partialAuthorityOwner: "v2",
        partialExecutionOwner: "paper_engine",
        partialAction: partialActionMap[exitPolicy.action] ?? "none",
        shouldPartial: exitPolicy.shouldPartial === true || exitPolicy.shouldReduce === true,
        partialReason: exitPolicy.hasPosition ? exitPolicy.reason : null,
        partialUrgency:
            (exitPolicy.shouldPartial === true || exitPolicy.shouldReduce === true)
                ? (partialUrgencyMap[exitPolicy.exitUrgency] ?? "none")
                : "none",
        partialConfidence:
            (exitPolicy.shouldPartial === true || exitPolicy.shouldReduce === true)
                ? exitPolicy.exitConfidence
                : Math.max(0, Math.min(1, exitPolicy.exitConfidence * 0.6)),
        reduceRatio: exitPolicy.reduceRatio > 0 ? exitPolicy.reduceRatio : null,
        proofReasons: partialProofReasons,
        trueInconsistencyReasons: [],
        knownShadowGaps: ["PARTIAL_EXECUTION_OWNER_NOT_V2"]
    };
    if (
        exitPolicy.hasPosition &&
        shouldEmitV2Proof(
            "V2_PARTIAL_AUTHORITY_STATE_PROOF",
            String(input.symbol),
            `${v2PartialAuthority.partialAction}|${v2PartialAuthority.partialReason}|${v2PartialAuthority.partialUrgency}|${v2PartialAuthority.reduceRatio ?? 0}`,
            v2PartialAuthority.trueInconsistencyReasons.length > 0
        )
    ) {
        console.info(JSON.stringify({
            event: "V2_PARTIAL_AUTHORITY_STATE_PROOF",
            symbol: String(input.symbol),
            side: v2PartialAuthority.side,
            partial_authority_owner: v2PartialAuthority.partialAuthorityOwner,
            partial_execution_owner: v2PartialAuthority.partialExecutionOwner,
            v2_partial_action: v2PartialAuthority.partialAction,
            v2_should_partial: v2PartialAuthority.shouldPartial,
            v2_partial_reason: v2PartialAuthority.partialReason,
            v2_partial_urgency: v2PartialAuthority.partialUrgency,
            v2_partial_confidence: v2PartialAuthority.partialConfidence,
            v2_reduce_ratio: v2PartialAuthority.reduceRatio,
            known_shadow_gaps: v2PartialAuthority.knownShadowGaps,
            true_inconsistency_reasons: v2PartialAuthority.trueInconsistencyReasons,
            proof_reasons: v2PartialAuthority.proofReasons
        }));
    }
    if (finalDecision === "ENTER") {
        finalReason = promotionReason ?? explanation.reason;
    } else if (finalDecision === "HOLD" && promotionApplied) {
        finalReason = `HOLD: ${promotionReason ?? "WAIT_RECHECK"}`;
    }

    const isV2EnterCandidate =
        finalDecision === "ENTER" &&
        (v2SideAfterPromotion === "long" || v2SideAfterPromotion === "short");
    if (isV2EnterCandidate) {
        const microStartedAt = Date.now();
        try {
            const rawDataFreshness = Number((judgment.metrics as Record<string, unknown>).dataFreshnessMs);
            const dataFreshnessMs =
                Number.isFinite(rawDataFreshness) && rawDataFreshness >= 0 ? rawDataFreshness : null;
            microExecution = deriveMicroExecutionScore({
                symbol: String(input.symbol),
                side: v2SideAfterPromotion,
                regime: judgment.regime,
                v2Decision: finalDecision,
                lastPrice: input.snapshot.lastPrice,
                volatilityProxy: Math.max(0, input.snapshot.volatilityProxy ?? 0),
                rangeConfidence: Math.max(0, input.snapshot.rangeConfidence ?? 0),
                breakoutFailureRate: Math.max(0, input.snapshot.breakoutFailureRate ?? 0),
                trendWeaknessScore: Math.max(0, input.snapshot.trendWeaknessScore ?? 0),
                qualityScore: Math.max(0, input.snapshot.qualityScore ?? 0),
                dataFreshnessMs
            });
        } catch {
            microExecution = deriveMicroExecutionScore({
                symbol: String(input.symbol),
                side: v2SideAfterPromotion,
                regime: judgment.regime,
                v2Decision: finalDecision,
                lastPrice: 0,
                volatilityProxy: 0,
                rangeConfidence: 0,
                breakoutFailureRate: 0,
                trendWeaknessScore: 0,
                qualityScore: 0,
                dataFreshnessMs: null
            });
        }
        const calcMs = Date.now() - microStartedAt;
        microPerfStats.calculatedCount += 1;
        microPerfStats.totalCalcMs += calcMs;
        microPerfStats.maxCalcMs = Math.max(microPerfStats.maxCalcMs, calcMs);
        if (microExecution.fallbackNeutral) microPerfStats.fallbackNeutralCount += 1;
        if (microExecution.usedOrderbook) microPerfStats.usedOrderbookCount += 1;
        if (microExecution.usedRecentTrades) microPerfStats.usedRecentTradesCount += 1;

        const microProofKey = [
            finalDecision,
            v2SideAfterPromotion,
            microExecution.score,
            microExecution.grade,
            microExecution.deferOnce,
            microExecution.hardBlockReason ?? "NONE"
        ].join("|");
        if (shouldEmitV2Proof("MICRO_EXECUTION_SCORE_PROOF", String(input.symbol), microProofKey, false)) {
            console.info(JSON.stringify({
                event: "MICRO_EXECUTION_SCORE_PROOF",
                symbol: String(input.symbol),
                side: v2SideAfterPromotion,
                regime: judgment.regime,
                v2_decision: finalDecision,
                score: microExecution.score,
                grade: microExecution.grade,
                sizeMultiplier: microExecution.sizeMultiplier,
                delayMs: microExecution.delayMs,
                deferOnce: microExecution.deferOnce,
                hardBlockReason: microExecution.hardBlockReason,
                reasons: microExecution.reasons,
                dataFreshnessMs: microExecution.dataFreshnessMs,
                usedOrderbook: microExecution.usedOrderbook,
                usedRecentTrades: microExecution.usedRecentTrades,
                fallbackNeutral: microExecution.fallbackNeutral,
                authority_source: microExecution.authoritySource
            }));
        }
        const shouldEmitCountSummary = microPerfStats.calculatedCount % 25 === 0;
        const shouldEmitTimeSummary =
            Date.now() - microPerfStats.lastLoggedAtMs >= MICRO_EXECUTION_PERF_LOG_INTERVAL_MS;
        if (shouldEmitCountSummary || shouldEmitTimeSummary) {
            const avgCalcMs = microPerfStats.calculatedCount > 0
                ? Number((microPerfStats.totalCalcMs / microPerfStats.calculatedCount).toFixed(3))
                : 0;
            const fallbackNeutralRate = microPerfStats.calculatedCount > 0
                ? Number((microPerfStats.fallbackNeutralCount / microPerfStats.calculatedCount).toFixed(4))
                : 0;
            console.info(JSON.stringify({
                event: "MICRO_EXECUTION_PERF_PROOF",
                calculatedCount: microPerfStats.calculatedCount,
                avgCalcMs,
                maxCalcMs: microPerfStats.maxCalcMs,
                fallbackNeutralCount: microPerfStats.fallbackNeutralCount,
                fallbackNeutralRate,
                usedOrderbookCount: microPerfStats.usedOrderbookCount,
                usedRecentTradesCount: microPerfStats.usedRecentTradesCount,
                appliedCount: microPerfStats.appliedCount,
                deferredCount: microPerfStats.deferredCount,
                sizeReducedCount: microPerfStats.sizeReducedCount,
                hardBlockedCount: microPerfStats.hardBlockedCount
            }));
            microPerfStats.lastLoggedAtMs = Date.now();
        }
    }

    const sameSidePosition =
        v2SideAfterPromotion === "long" ? v2State.longPosition
            : v2SideAfterPromotion === "short" ? v2State.shortPosition
                : null;
    const heldPosition = v2State.longPosition ?? v2State.shortPosition ?? null;
    const lifecyclePosition = sameSidePosition ?? heldPosition;
    const lifecycleSide: EngineV2Side =
        v2SideAfterPromotion === "none" || v2SideAfterPromotion == null
            ? lifecyclePosition != null
                ? (lifecyclePosition.side === "LONG" ? "long" : "short")
                : "none"
            : v2SideAfterPromotion;
    const hasLifecycleCandidate =
        lifecyclePosition != null ||
        finalDecision === "ENTER" ||
        riskSizing.blockReason != null;
        if (hasLifecycleCandidate) {
        const cooldownReasonRaw = (riskSizing.diagnostics as Record<string, unknown> | undefined)?.cooldown_reason;
        const cooldownRemainingRaw = (riskSizing.diagnostics as Record<string, unknown> | undefined)?.cooldown_remaining_ms;
        lifecycleAuthority = deriveTradeLifecycleAuthority({
            symbol: String(input.symbol),
            side: lifecycleSide,
            regime: judgment.regime,
            marketMode: judgment.regime,
            directionalShockState: v2State.directionalShockState,
            v2Decision: finalDecision,
            v2Side: v2SideAfterPromotion,
            authoritySource: "v2",
            adoptedEngine: "V2",
            position: lifecyclePosition,
            unrealizedPnl: lifecyclePosition != null ? lifecyclePosition.sizeUsd * lifecyclePosition.pnlPct : null,
            unrealizedPnlPct: lifecyclePosition?.pnlPct ?? null,
            holdMs: null,
            entryPrice: lifecyclePosition?.entryPrice ?? null,
            markPrice: input.snapshot.lastPrice ?? null,
            riskState: v2State.riskMode,
            cooldownState: {
                reason: typeof cooldownReasonRaw === "string" ? cooldownReasonRaw : null,
                remainingMs: typeof cooldownRemainingRaw === "number" && Number.isFinite(cooldownRemainingRaw) ? cooldownRemainingRaw : null,
                reentryBlocked: typeof cooldownReasonRaw === "string" && cooldownReasonRaw.length > 0
            },
            microExecution,
            reversalQuality: input.snapshot.qualityScore ?? null,
            rawMetricsSummary: {
                qualityScore: input.snapshot.qualityScore ?? 0,
                rangeConfidence: input.snapshot.rangeConfidence ?? 0,
                trendWeaknessScore: input.snapshot.trendWeaknessScore ?? 0,
                boxPos: input.snapshot.boxPos ?? null
            }
        });

        // Cooldown authority is computed as an independent proof/comparison layer.
        // It does NOT change any actual cooldown application logic (paper engine remains the executor).
        const cooldownType = lifecycleAuthority.cooldownType;
        const shouldCooldown = cooldownType !== "none";

        const cooldownAction: V2CooldownAuthorityResult["cooldownAction"] =
            cooldownType === "none"
                ? "none"
                : cooldownType === "direction_block"
                    ? "block_direction"
                    : cooldownType === "time_reentry"
                        ? "block_entry"
                        : cooldownType === "risk_halt"
                            ? "halt"
                            : "block_entry";

        const cooldownUrgency: V2CooldownAuthorityResult["cooldownUrgency"] =
            cooldownType === "none"
                ? "none"
                : cooldownType === "direction_block"
                    ? "medium"
                    : cooldownType === "time_reentry"
                        ? "low"
                        : cooldownType === "risk_halt"
                            ? "high"
                            : "medium";

        const directionBlocked: V2CooldownAuthorityResult["directionBlocked"] =
            cooldownType !== "direction_block"
                ? "none"
                : v2State.directionalShockState === "DOWN"
                    ? "long"
                    : v2State.directionalShockState === "UP"
                        ? "short"
                        : lifecycleSide === "long"
                            ? "long"
                            : lifecycleSide === "short"
                                ? "short"
                                : "none";

        v2CooldownAuthority = {
            symbol: String(input.symbol),
            side: lifecycleSide,
            cooldownAuthorityOwner: "v2",
            cooldownExecutionOwner: "paper_engine",
            cooldownAction,
            shouldCooldown,
            cooldownType,
            cooldownReason: lifecycleAuthority.cooldownReason,
            cooldownUrgency,
            cooldownRemainingMs:
                shouldCooldown && typeof cooldownRemainingRaw === "number" && Number.isFinite(cooldownRemainingRaw)
                    ? cooldownRemainingRaw
                    : null,
            directionBlocked,
            proofReasons: lifecycleAuthority.proofReasons,
            trueInconsistencyReasons: lifecycleAuthority.trueInconsistencyReasons,
            knownShadowGaps: lifecycleAuthority.knownShadowGaps
        };

        const cooldownProofKey = [
            v2CooldownAuthority.cooldownAction,
            v2CooldownAuthority.shouldCooldown,
            v2CooldownAuthority.cooldownType,
            v2CooldownAuthority.cooldownReason ?? "none",
            v2CooldownAuthority.cooldownUrgency,
            v2CooldownAuthority.directionBlocked
        ].join("|");

        const cooldownHighPriority = v2CooldownAuthority.trueInconsistencyReasons.length > 0;

        if (
            shouldEmitV2Proof(
                "V2_COOLDOWN_AUTHORITY_STATE_PROOF",
                String(input.symbol),
                cooldownProofKey,
                cooldownHighPriority
            )
        ) {
            console.info(JSON.stringify({
                event: "V2_COOLDOWN_AUTHORITY_STATE_PROOF",
                symbol: String(input.symbol),
                side: v2CooldownAuthority.side,
                regime: judgment.regime,
                directional_shock_state: v2State.directionalShockState,
                cooldown_authority_owner: v2CooldownAuthority.cooldownAuthorityOwner,
                cooldown_execution_owner: v2CooldownAuthority.cooldownExecutionOwner,
                v2_cooldown_action: v2CooldownAuthority.cooldownAction,
                v2_should_cooldown: v2CooldownAuthority.shouldCooldown,
                v2_cooldown_type: v2CooldownAuthority.cooldownType,
                v2_cooldown_reason: v2CooldownAuthority.cooldownReason,
                v2_cooldown_urgency: v2CooldownAuthority.cooldownUrgency,
                v2_cooldown_remaining_ms: v2CooldownAuthority.cooldownRemainingMs,
                direction_blocked: v2CooldownAuthority.directionBlocked,
                known_shadow_gaps: v2CooldownAuthority.knownShadowGaps,
                true_inconsistency_reasons: v2CooldownAuthority.trueInconsistencyReasons,
                proof_reasons: v2CooldownAuthority.proofReasons
            }));
        }
        const lifecycleProofKey = [
            lifecycleAuthority.lifecycleStage,
            lifecycleAuthority.lifecycleAuthorityOwner,
            lifecycleAuthority.executionOwner,
            lifecycleAuthority.cooldownType,
            lifecycleAuthority.partialAction,
            lifecycleAuthority.exitAction,
            lifecycleAuthority.consistencyPass,
            lifecycleAuthority.trueInconsistencyReasons.join(",")
        ].join("|");
        if (shouldEmitV2Proof("V2_TRADE_LIFECYCLE_PROOF", String(input.symbol), lifecycleProofKey, lifecycleAuthority.trueInconsistencyReasons.length > 0)) {
            console.info(JSON.stringify({
                event: "V2_TRADE_LIFECYCLE_PROOF",
                symbol: String(input.symbol),
                position_id: lifecyclePosition != null
                    ? `${String(input.symbol)}:${lifecyclePosition.side}:${lifecyclePosition.entryStage}`
                    : `${String(input.symbol)}:none`,
                lifecycle_stage: lifecycleAuthority.lifecycleStage,
                authority_source: lifecycleAuthority.authoritySource,
                adopted_engine: lifecycleAuthority.adoptedEngine,
                regime: judgment.regime,
                market_mode: judgment.regime,
                directional_shock_state: v2State.directionalShockState,
                side: lifecycleSide,
                v2_decision: finalDecision,
                v2_side: v2SideAfterPromotion,
                lifecycle_authority_owner: lifecycleAuthority.lifecycleAuthorityOwner,
                execution_owner: lifecycleAuthority.executionOwner,
                position_state_owner: lifecycleAuthority.positionStateOwner,
                entry_managed_by_v2: lifecycleAuthority.entryManagedByV2,
                add_on_managed_by_v2: lifecycleAuthority.addOnManagedByV2,
                partial_managed_by_v2: lifecycleAuthority.partialManagedByV2,
                exit_managed_by_v2: lifecycleAuthority.exitManagedByV2,
                cooldown_managed_by_v2: lifecycleAuthority.cooldownManagedByV2,
                position_state_managed_by_v2: lifecycleAuthority.positionStateManagedByV2,
                add_on_allowed: lifecycleAuthority.addOnAllowed,
                partial_action: lifecycleAuthority.partialAction,
                exit_action: lifecycleAuthority.exitAction,
                cooldown_type: lifecycleAuthority.cooldownType,
                cooldown_reason: lifecycleAuthority.cooldownReason,
                legacy_intervention_detected: lifecycleAuthority.legacyInterventionDetected,
                consistency_pass: lifecycleAuthority.consistencyPass,
                known_shadow_gaps: lifecycleAuthority.knownShadowGaps,
                true_inconsistency_reasons: lifecycleAuthority.trueInconsistencyReasons,
                inconsistency_reasons: lifecycleAuthority.inconsistencyReasons,
                proof_reasons: lifecycleAuthority.proofReasons
            }));
        }

        // --- V2 Position State Authority (Step 4) ---
        const hasPosition = lifecyclePosition != null;
        const positionLifecycleState: V2PositionStateAuthorityResult["positionLifecycleState"] = (() => {
            if (!hasPosition) return "none";
            if (lifecycleAuthority.exitAction === "exit") return "closing";
            if (lifecycleAuthority.partialAction === "reduce" || lifecycleAuthority.partialAction === "protect_profit") return "reducing";
            if (lifecycleAuthority.addOnAllowed) return "scaling";
            return "open";
        })();

        const positionRiskState: V2PositionStateAuthorityResult["positionRiskState"] = (() => {
            if (!hasPosition) return "none";
            const v2RiskMode = v2State.riskMode;
            if (v2RiskMode === "danger") return "danger";
            if (v2RiskMode === "drawdown_watch") return "drawdown_watch";
            if (lifecycleAuthority.partialAction === "protect_profit") return "profit_protect";
            return "normal";
        })();

        const pnlState: V2PositionStateAuthorityResult["pnlState"] = (() => {
            if (!hasPosition) return "none";
            const pct = lifecyclePosition?.pnlPct ?? 0;
            if (pct > 0.001) return "profit";
            if (pct < -0.001) return "loss";
            return "flat";
        })();

        v2PositionStateAuthority = {
            symbol: String(input.symbol),
            side: lifecycleSide,
            positionStateAuthorityOwner: "v2",
            positionStateExecutionOwner: "paper_engine",
            positionStateAction: hasPosition ? "track" : "none",
            hasPosition,
            positionLifecycleState,
            positionRiskState,
            positionStage: lifecyclePosition?.entryStage ?? null,
            holdMs: null,
            pnlState,
            unrealizedPnlKrw: lifecyclePosition != null ? lifecyclePosition.sizeUsd * lifecyclePosition.pnlPct : null, // USD fallback
            unrealizedPnlPct: lifecyclePosition?.pnlPct ?? null,
            stateReason: lifecycleAuthority.cooldownReason || null,
            proofReasons: [],
            trueInconsistencyReasons: [],
            knownShadowGaps: ["position_state_execution_owner_is_paper_engine"]
        };

        const positionStateProofKey = [
            v2PositionStateAuthority.hasPosition,
            v2PositionStateAuthority.positionLifecycleState,
            v2PositionStateAuthority.positionRiskState,
            v2PositionStateAuthority.positionStage,
            v2PositionStateAuthority.pnlState,
            v2PositionStateAuthority.side
        ].join("|");

        const positionStateHighPriority = v2PositionStateAuthority.trueInconsistencyReasons.length > 0;

        if (shouldEmitV2Proof("V2_POSITION_STATE_AUTHORITY_STATE_PROOF", String(input.symbol), positionStateProofKey, positionStateHighPriority)) {
            console.info(JSON.stringify({
                event: "V2_POSITION_STATE_AUTHORITY_STATE_PROOF",
                symbol: String(input.symbol),
                side: v2PositionStateAuthority.side,
                has_position: v2PositionStateAuthority.hasPosition,
                lifecycle_state: v2PositionStateAuthority.positionLifecycleState,
                risk_state: v2PositionStateAuthority.positionRiskState,
                stage: v2PositionStateAuthority.positionStage,
                pnl_state: v2PositionStateAuthority.pnlState,
                unrealized_pnl_pct: lifecyclePosition?.pnlPct ?? null,
                state_reason: v2PositionStateAuthority.stateReason,
                hold_ms: v2PositionStateAuthority.holdMs
            }));
        }
    }

    console.info(JSON.stringify({
        event: "V2_TREND_AUTHORITY_DIAGNOSTIC_PROOF",
        symbol: String(input.symbol),
        market_mode: marketMode,
        active_engine_routing: activeEngineRouting,
        directional_shock_state: shock,
        risk_long_allow: riskLongAllow,
        risk_short_allow: riskShortAllow,
        allow_new_long: allowNewLong,
        allow_new_short: allowNewShort,
        raw_signal: rawSignal,
        aligned_signal: alignedSignal,
        trend_side_candidate: trendSideCandidate,
        entry_quality_grade: entryQualityGrade,
        quality_score: qualityScore,
        trendOk,
        v2_decision_before: v2DecisionBeforePromotion,
        v2_side_before: v2SideBeforePromotion,
        v2_reject_reason_before: v2RejectReasonBeforePromotion,
        promotion_applied: promotionApplied,
        promotion_reason: promotionReason,
        v2_decision_after: finalDecision,
        v2_side_after: v2SideAfterPromotion,
        v2_reject_reason_after: blockReason
    }));
    console.info(JSON.stringify({
        event: "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF",
        symbol: String(input.symbol),
        market_mode: marketMode,
        active_engine_routing: activeEngineRouting,
        paper_execution_ready: paperExecutionReady,
        signed_execution_ready: signedExecutionReady,
        directional_shock_state: shock,
        trend_side_candidate: trendSideCandidate,
        range_side_candidate: rangeSideCandidate,
        entry_quality_grade: entryQualityGrade,
        quality_score: qualityScore,
        trendOk,
        rangeConfidence,
        boxCohesion01,
        trendWeaknessScore: trendWeaknessFromMeta,
        boxPos: boxPos,
        zone,
        range_metadata_source: rangeMetadataSource,
        range_metadata_missing_fields: rangeMetadataMissingFields.join("|") || null,
        side_zone_valid: sideZoneValid,
        range_edge_extreme: rangeEdgeExtreme,
        relaxedRangeEntry,
        reversal_confirmed: reversalConfirmed,
        decision_before: v2DecisionBeforePromotion,
        side_before: v2SideBeforePromotion,
        reject_reason_before: v2RejectReasonBeforePromotion,
        promotion_applied: promotionApplied,
        promotion_reason: promotionReason,
        decision_after: finalDecision,
        side_after: v2SideAfterPromotion,
        reject_reason_after: blockReason,
        promotion_block_reason: promotionBlockReason,
        promotion_min_condition_passed: promotionMinConditionPassed,
        contamination_softened: contaminationSoftened,
        contamination_hard_reject: contaminationHardReject,
        contamination_soften_reason: contaminationSoftenReason,
        shock_reaction_watch_active: shockReactionWatchActive,
        shock_reaction_direction: shockReactionDirection,
        shock_reaction_promotion_type: shockReactionPromotionType,
        shock_edge_setup_active_reason: shockEdgeSetupActiveReason.length > 0 ? shockEdgeSetupActiveReason.join("|") : null,
        shock_reaction_block_reason: shockReactionBlockReason ?? promotionBlockReason,
        shock_reaction_symmetry_case:
            shock === "DOWN"
                ? "DOWN_SHOCK_RANGE_FLOW"
                : shock === "UP"
                    ? "UP_SHOCK_RANGE_FLOW"
                    : "NONE",
        v2_state_authority_source: v2State.stateAuthoritySource,
        v2_state_position_ready: v2State.positionStateReady,
        v2_state_same_side_position: v2State.hasSameSidePosition,
        v2_state_opposite_side_position: v2State.hasOppositeSidePosition,
        v2_state_current_stage: v2State.currentStage,
        v2_state_inferred_intent_side: v2State.inferredIntentSide,
        v2_state_has_long_position: v2State.hasLongPosition,
        v2_state_has_short_position: v2State.hasShortPosition,
        v2_state_long_stage: v2State.longStage,
        v2_state_short_stage: v2State.shortStage,
        market_subtype: judgment.subtype,
        market_subtype_reason: judgment.subtypeReason,
        market_shock_phase: judgment.shockPhase,
        market_range_phase: judgment.rangePhase,
        market_trend_phase: judgment.trendPhase,
        market_transition_phase: judgment.transitionPhase,
        market_judgment_version: judgment.judgmentVersion,
        market_judgment_state_source: "authoritative_input",
        transition_setup_type: typeof execMeta.transitionSetupType === "string" ? execMeta.transitionSetupType : null,
        transition_action: typeof execMeta.transitionAction === "string" ? execMeta.transitionAction : null,
        transition_watch_only: readNullableBoolean(execMeta.transitionWatchOnly),
        transition_confirm_required: readNullableBoolean(execMeta.transitionConfirmRequired),
        transition_reject_reason: typeof execMeta.transitionRejectReason === "string" ? execMeta.transitionRejectReason : null,
        addon_action: addOnPolicy.action,
        addon_allowed: addOnPolicy.allowed,
        addon_reason: addOnPolicy.reason,
        addon_is_initial: addOnPolicy.isInitial,
        addon_is_addon: addOnPolicy.isAddOn,
        addon_current_stage: addOnPolicy.currentStage,
        addon_has_same_side_position: addOnPolicy.hasSameSidePosition,
        addon_has_opposite_side_position: addOnPolicy.hasOppositeSidePosition,
        exit_action: exitPolicy.action,
        exit_reason: exitPolicy.reason,
        exit_should_exit: exitPolicy.shouldExit,
        exit_should_reduce: exitPolicy.shouldReduce,
        exit_should_partial: exitPolicy.shouldPartial,
        exit_reduce_ratio: exitPolicy.reduceRatio,
        exit_urgency: exitPolicy.exitUrgency,
        exit_confidence: exitPolicy.exitConfidence,
        hard_block_present: hardBlockPresent,
        hard_block_reason: hardBlockReason
    }));
    console.info(JSON.stringify({
        event: "V2_ENTRY_QUALITY_CONTAMINATION_PROOF",
        symbol: String(input.symbol),
        decision_before: v2DecisionBeforePromotion,
        reject_reason_before: v2RejectReasonBeforePromotion,
        entry_quality_grade: entryQualityGrade,
        qualityScore,
        profitDistance,
        lossDistance,
        contaminatedDistance,
        contamination_hard_reject: contaminationHardReject,
        contamination_softened: contaminationSoftened,
        contamination_soften_reason: contaminationSoftenReason,
        final_decision_after: finalDecision,
        hard_block_present: hardBlockPresent,
        hard_block_reason: hardBlockReason
    }));
    console.info(JSON.stringify({
        event: "V2_EXECUTION_READINESS_PROOF",
        symbol: String(input.symbol),
        paper_execution_ready: readinessDiag.paper_execution_ready ?? null,
        signed_execution_ready: readinessDiag.signed_execution_ready ?? null,
        okx_auth_mode: readinessDiag.okx_auth_mode ?? null,
        okx_auth_ready: readinessDiag.okx_auth_ready ?? null,
        okx_exchange_auth_opt_in: readinessDiag.okx_exchange_auth_opt_in ?? null,
        okx_live_enabled: readinessDiag.okx_live_enabled ?? null,
        okx_demo_enabled: readinessDiag.okx_demo_enabled ?? null,
        okx_api_key_present: readinessDiag.okx_api_key_present ?? null,
        okx_api_secret_present: readinessDiag.okx_api_secret_present ?? null,
        okx_passphrase_present: readinessDiag.okx_passphrase_present ?? null,
        okx_simulated_trading_header_enabled: readinessDiag.okx_simulated_trading_header_enabled ?? null,
        live_max_order_notional_usdt: readinessDiag.live_max_order_notional_usdt ?? null,
        paper_readiness_block_reasons: readinessDiag.paper_readiness_block_reasons ?? null,
        signed_readiness_block_reason: readinessDiag.signed_readiness_block_reason ?? null,
        serverTradeEnabled: v2State.serverTradeEnabled,
        closeOnlyMode: v2State.closeOnlyMode,
        killSwitch: v2State.killSwitch,
        reconcileSafeMode: v2State.reconcileSafeMode,
        riskMode: readinessDiag.risk_mode ?? v2State.riskMode ?? null,
        dailyLossGuardTriggered: readinessDiag.daily_loss_guard_triggered ?? v2State.dailyLossGuardTriggered,
        market_snapshot_ready: readinessDiag.market_snapshot_ready ?? null,
        position_state_ready: readinessDiag.position_state_ready ?? null,
        v2_input_ready: readinessDiag.v2_input_ready ?? null,
        decision_before_readiness: decisionBeforeReadiness,
        decision_after_readiness: decisionAfterReadiness
    }));

    const decision: EngineV2Decision = {
        symbol: input.symbol,
        ts: input.now,
        regime: judgment.regime,
        confidence: confidence.level,
        confidenceScore: confidence.score,
        signal: execution.signal,
        side: v2SideAfterPromotion,
        decision: finalDecision,
        risk: riskSizing,
        explanation: {
            reason: finalReason,
            uiLabelRegime: judgment.regime,
            uiLabelStatus: finalDecision === "ENTER" ? "ACTIVE" : "IDLE"
        },
        microExecution: microExecution ?? undefined,
        lifecycleAuthority: lifecycleAuthority ?? undefined,
        v2ExitAuthority: v2ExitAuthority ?? undefined,
        v2PartialAuthority: v2PartialAuthority ?? undefined,
        v2CooldownAuthority: v2CooldownAuthority ?? undefined,
        v2PositionStateAuthority: v2PositionStateAuthority ?? undefined,
        rawMetrics: {
            ...judgment.metrics,
            qualityScore: input.snapshot.qualityScore ?? 0,
            directionalShockState: v2State.directionalShockState,
            confidenceScore: confidence.score,
            sizingMultiplier: riskSizing.sizeMultiplier,
            microExecutionScore: microExecution?.score ?? 0,
            microExecutionFallbackNeutral: microExecution?.fallbackNeutral ?? false,
            lifecycleConsistencyPass: lifecycleAuthority?.consistencyPass ?? false,
            lifecycleLegacyInterventionDetected: lifecycleAuthority?.legacyInterventionDetected ?? false,
            v2ExitShouldExit: v2ExitAuthority?.shouldExit ?? false,
            v2PartialShouldPartial: v2PartialAuthority?.shouldPartial ?? false
        }
    };

    const internal: EngineV2InternalResult = {
        judgment,
        confidence,
        routing,
        execution,
        riskSizing,
        explanation,
        microExecution,
        lifecycleAuthority,
        v2ExitAuthority,
        v2PartialAuthority,
        v2CooldownAuthority,
        v2PositionStateAuthority,
        exitPolicy: {
            action: exitPolicy.action,
            reason: exitPolicy.reason,
            shouldExit: exitPolicy.shouldExit,
            shouldReduce: exitPolicy.shouldReduce,
            shouldPartial: exitPolicy.shouldPartial,
            reduceRatio: exitPolicy.reduceRatio,
            exitUrgency: exitPolicy.exitUrgency,
            exitConfidence: exitPolicy.exitConfidence
        }
    };

    return { decision, internal };
}

/** 
 * Legacy-to-V2 Input Adapter (Zero Any).
 * Maps legacy complex objects through strict adapter interfaces.
 */
export function adaptV2Input(
    symbol: MarketSymbol,
    now: number,
    snapshot: LegacySnapshotAdapter,
    config: LegacyConfigAdapter,
    state: {
        currentPositions: LegacyPositionAdapter[];
        globalRiskScore: number;
        lossStreaks: Record<string, number>;
        directionalShockState: "UP" | "DOWN" | "NONE" | "UNKNOWN";
        longAllow: boolean;
        shortAllow: boolean;
        executionReadiness: boolean;
        paperExecutionReady?: boolean;
        signedExecutionReady?: boolean;
        freshTickBarrierActive: boolean;
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
        accountEquityKrw?: number;
        maxUsableMarginKrw?: number;
        exposureNotionalCapKrw?: number;
        symbolExposureNotionalCapKrw?: number;
        riskMode?: string | null;
        dailyLossGuardTriggered?: boolean;
        crashState?: string | null;
        pumpState?: string | null;
        pump_state?: string | null;
    },
    v1Result: LegacyResultAdapter
): EngineV2Input {
    return {
        symbol,
        now,
        snapshot: {
            lastPrice: snapshot.lastPrice,
            latestCandleClose: snapshot.latestCandleClose,
            boxHigh: snapshot.boxHigh ?? 0,
            boxLow: snapshot.boxLow ?? 0,
            boxPos: snapshot.boxPosDiag ?? 0,
            rangeConfidence: snapshot.rangeConfidenceDiag ?? 0,
            ema20: snapshot.ema20 ?? 0,
            emaGap: snapshot.emaGapDiag ?? 0,
            volatilityProxy: snapshot.volatilityProxyDiag ?? 0,
            boxCohesion01: snapshot.boxCohesion01 ?? snapshot.boxCohesionDiag ?? 0,
            breakoutFailureRate: snapshot.breakoutFailureRate ?? snapshot.breakoutFailureRateDiag ?? 0,
            trendWeaknessScore: snapshot.trendWeaknessScore ?? snapshot.trendWeaknessDiag ?? 0,
            reviewing_ticks: snapshot.reviewing_ticks ?? 0,
            regimeExitRisk: snapshot.regimeExitRisk ?? 0,
            boxBreakSide: snapshot.boxBreakSide ?? "none",
            signal: snapshot.signal ?? "NONE",
            qualityScore: snapshot.qualityScore ?? 0,
            data_ready: snapshot.data_ready ?? true,
            dump_protection_hit: snapshot.dump_protection_hit ?? false,
            volatility_guard_hit: snapshot.volatility_guard_hit ?? false,
            entryCandidate: snapshot.entryCandidate ?? false
        },
        config: {
            paperMaxOpenPositions: config.paperMaxOpenPositions,
            paperReentryCooldownMs: config.paperReentryCooldownMs,
            baseSizeUsd: config.baseSizeUsd
        },
        state: {
            currentPositions: state.currentPositions.map((p: LegacyPositionAdapter) => ({
                symbol: p.symbol,
                side: p.side === "long" ? "LONG" : "SHORT" as const,
                entryPrice: p.entryPrice,
                sizeUsd: p.sizeUsd,
                entryStage: p.entryStage ?? 0,
                pnlPct: p.pnlPct ?? 0
            })),
            globalRiskScore: state.globalRiskScore,
            lossStreaks: state.lossStreaks,
            directionalShockState: state.directionalShockState,
            longAllow: state.longAllow,
            shortAllow: state.shortAllow,
            executionReadiness: state.executionReadiness,
            paperExecutionReady: state.paperExecutionReady,
            signedExecutionReady: state.signedExecutionReady,
            freshTickBarrierActive: state.freshTickBarrierActive,
            freshTickExecutionBlocked: state.freshTickExecutionBlocked === true,
            freshTickCompletedCycles: state.freshTickCompletedCycles,
            freshTickRequiredCycles: state.freshTickRequiredCycles,
            entryQualityProfiles: state.entryQualityProfiles,
            serverTradeEnabled: state.serverTradeEnabled,
            closeOnlyMode: state.closeOnlyMode,
            killSwitch: state.killSwitch,
            reconcileSafeMode: state.reconcileSafeMode,
            killSwitchActive: state.killSwitchActive,
            reconcileSafeModeActive: state.reconcileSafeModeActive,
            riskMode: state.riskMode ?? undefined,
            dailyLossGuardTriggered: state.dailyLossGuardTriggered ?? false,
            crashState: state.crashState ?? undefined,
            pumpState: state.pumpState ?? undefined,
            pump_state: state.pump_state ?? undefined,
            accountEquityKrw: state.accountEquityKrw,
            maxUsableMarginKrw: state.maxUsableMarginKrw,
            exposureNotionalCapKrw: state.exposureNotionalCapKrw,
            symbolExposureNotionalCapKrw: state.symbolExposureNotionalCapKrw
        },
        v1Result: {
            regime: v1Result.decision?.regime_state ?? "UNDEFINED",
            decision: v1Result.decision?.final_decision ?? "SKIP",
            side: v1Result.intentSide ?? "none",
            isBlocked: !!v1Result.decision?.reject_reason
        }
    };
}
