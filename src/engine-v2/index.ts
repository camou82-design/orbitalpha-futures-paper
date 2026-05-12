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
import { MarketSymbol, classifyRangeZone, rangeZoneLowerExtreme, rangeZoneUpperExtreme } from "../models/types";
import { detectMarketRegime, emitRangeDriftStateProof } from "./market-judgment/detector";
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

    // Phase 6 Proof: Range Drift Analysis
    if (judgment.regime === "RANGE") {
        emitRangeDriftStateProof(String(input.symbol), judgment, authoritativeInput.snapshot);
    }

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

    if (shouldEmitV2Proof("V2_LIVE_MAX_ORDER_NOTIONAL_RESOLVE_PROOF", String(input.symbol), `${v2State.liveMaxOrderNotionalUsdt}`, false)) {
        console.info(JSON.stringify({
            event: "V2_LIVE_MAX_ORDER_NOTIONAL_RESOLVE_PROOF",
            symbol: String(input.symbol),
            input_state_val: input.state.liveMaxOrderNotionalUsdt,
            input_config_val: input.config.okxLiveMaxOrderNotionalUsdt,
            resolved_val: v2State.liveMaxOrderNotionalUsdt,
            is_fallback_applied: v2State.liveMaxOrderNotionalUsdt !== input.state.liveMaxOrderNotionalUsdt,
            fallback_source: v2State.liveMaxOrderNotionalUsdt === input.config.okxLiveMaxOrderNotionalUsdt ? "config" :
                             v2State.liveMaxOrderNotionalUsdt === 100 ? "default_100" : "none",
            ts: Date.now()
        }));
    }

    if (v2State.directionalShockState === "DOWN" && v2State.inferredIntentSide === "long") {
        console.warn(JSON.stringify({
            event: "V2_INTENT_SIDE_ALIGNMENT_PROOF",
            symbol: String(input.symbol),
            directional_shock_state: v2State.directionalShockState,
            inferred_intent_side_before: v2State.inferredIntentSide,
            fixed: true,
            reason: "DOWN_SHOCK_EXCLUDES_LONG_INTENT"
        }));
    } else {
        console.info(JSON.stringify({
            event: "V2_INTENT_SIDE_ALIGNMENT_PROOF",
            symbol: String(input.symbol),
            directional_shock_state: v2State.directionalShockState,
            inferred_intent_side: v2State.inferredIntentSide,
            fixed: false
        }));
    }
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
    let v2CalculatedInvalidationPx: number | null = null;
    let expectedMissingCondition: string | null = null;
    let expectedNextAction: string | null = null;
    let execution: ExecutorOutput;
    if (routing.executor === "RANGE") execution = executeRangeRegime(authoritativeInput, judgment);
    else if (routing.executor === "TREND") execution = executeTrendRegime(authoritativeInput, judgment);
    else if (routing.executor === "TRANSITION") execution = executeTransitionRegime(authoritativeInput, judgment);
    else {
        execution = {
            signal: "NONE" as const,
            side: "none" as const,
            reason: "No Routing",
            baseSizeIntent: 0,
            recheckSuggested: false,
            isAddOnEligible: false,
            stopPrice: null,
            invalidationPx: null,
            metadata: {}
        };
    }
    v2CalculatedInvalidationPx = execution.invalidationPx;
    const USD_PER_KRW = 1 / 1400;
    const accountEquityUsd = (v2State.accountEquityKrw ?? 0) * USD_PER_KRW;
    const currentSymbolNotionalUsd = (v2State.symbolLedgerExposureNotionalKrw ?? 0) * USD_PER_KRW;
    const currentGlobalNotionalUsd = (v2State.ledgerExposureNotionalKrw ?? 0) * USD_PER_KRW;

    const preAddOnPosition = v2State.currentPositions.find(
        p => p.symbol === input.symbol && String(p.side).toLowerCase() === execution.side
    );

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
            rangeConfidence: authoritativeInput.snapshot.rangeConfidence,
            lastPrice: authoritativeInput.snapshot.lastPrice,
            atr: authoritativeInput.snapshot.atr,
            volatilityProxyDiag: authoritativeInput.snapshot.volatilityProxy
        },
        accountEquityUsd,
        currentSymbolNotionalUsd,
        currentGlobalNotionalUsd,
        currentStopPrice: preAddOnPosition?.ledger_stop_px ?? undefined
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
    // --- Unified finalAddonNotionalUsdt Calculation (Pyramid Sizing Source of Truth) ---
    const symbolMaxNotionalUsdt = accountEquityUsd * 0.8;
    const globalMaxNotionalUsdt = accountEquityUsd * 1.5;
    const remainingSymbolRoom = Math.max(0, symbolMaxNotionalUsdt - currentSymbolNotionalUsd);
    const remainingGlobalRoom = Math.max(0, globalMaxNotionalUsdt - currentGlobalNotionalUsd);
    const liveMaxOrderNotionalUsdt = v2State.liveMaxOrderNotionalUsdt ?? 500;

    const finalAddonNotionalUsdt = Math.min(
        addOnPolicy.addonMaxNotionalUsdt ?? 0,
        liveMaxOrderNotionalUsdt,
        remainingSymbolRoom,
        remainingGlobalRoom
    );

    console.info(JSON.stringify({
        event: "V2_TREND_FINAL_ADDON_NOTIONAL_PROOF",
        symbol: String(input.symbol),
        addonPolicyMax: addOnPolicy.addonMaxNotionalUsdt,
        liveMaxOrder: liveMaxOrderNotionalUsdt,
        remainingSymbolRoom,
        remainingGlobalRoom,
        finalAddonNotionalUsdt
    }));

    authoritativeInput = {
        ...authoritativeInput,
        state: {
            ...authoritativeInput.state,
            addOnPolicyAllowed: addOnPolicy.allowed,
            addOnPolicyReason: addOnPolicy.reason,
            addOnPolicyAction: addOnPolicy.action,
            lockedProfitUsdt: addOnPolicy.lockedProfitUsdt,
            availableRiskBudgetUsdt: addOnPolicy.availableRiskBudgetUsdt,
            addonMaxNotionalUsdt: addOnPolicy.addonMaxNotionalUsdt,
            finalAddonNotionalUsdt: finalAddonNotionalUsdt
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

    if (judgment.subtype === "WHIPSAW_SHOCK_RECHECK" && exitPolicy.hasPosition && (exitPolicy.shouldExit || exitPolicy.shouldReduce || exitPolicy.shouldPartial)) {
        console.info(JSON.stringify({
            event: "V2_WHIPSAW_EXIT_PASSTHROUGH_PROOF",
            symbol: String(input.symbol),
            subtype: judgment.subtype,
            exit_action: exitPolicy.action,
            exit_reason: exitPolicy.reason,
            pnl_pct: exitPolicy.pnlPct,
            detail: "WHIPSAW state active but existing position exit/reduction is allowed and passed through."
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
    const invalidSize = riskSizing.stageMarginKrw <= 0;
    let blockReason = riskSizing.blockReason ?? null;

    if (hardNoTrade) {
        finalDecision = "DISABLED";
    } else if (softNoTrade && hasRawCandidate) {
        finalDecision = "HOLD";
    } else if (softNoTrade) {
        finalDecision = "DISABLED";
    } else if (isBlocked && blockReason === "WHIPSAW_SHOCK_RECHECK") {
        finalDecision = "REJECT";
    } else if (waitingRecheck && invalidSideForEnter) {
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
        explanation.summary = "신호는 존재하나 하위 시장 판단이 보수적이므로 즉시 진입 유보 및 확증 대기";
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
    const whipsawShockRecheckActive = judgment.subtype === "WHIPSAW_SHOCK_RECHECK";
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
    const rangeLowerThreshold = 0.26;
    const rangeUpperThreshold = 0.74;
    const boxBreakSide =
        typeof execMeta.boxBreakSide === "string"
            ? String(execMeta.boxBreakSide)
            : typeof input.snapshot?.boxBreakSide === "string"
                ? String(input.snapshot.boxBreakSide)
                : "none";
    // Canonical RANGE zone: classifyRangeZone(boxPos). Executor metadata may not match legacy zone (V2 inconsistency prevention).
    const zone = boxPos == null || !Number.isFinite(boxPos) ? ("mid" as const) : classifyRangeZone(boxPos);
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
            execMeta.reversal_confirmed != null ||
            execMeta.relaxedRangeEntry != null
            ? "executor_metadata"
            : "snapshot_fallback";
    const rangeMetadataMissingFields = [
        rangeConfidence == null ? "rangeConfidence" : null,
        boxCohesion01 == null ? "boxCohesion01" : null,
        trendWeaknessFromMeta == null ? "trendWeaknessScore" : null,
        boxPos == null ? "boxPos" : null
    ].filter((x): x is string => x != null);
    const signalGateBlockedReason =
        typeof input.snapshot?.signalGateBlockedReason === "string"
            ? input.snapshot.signalGateBlockedReason
            : null;
    const rangeSignalDowngraded = input.snapshot?.rangeSignalDowngraded === true;
    const rangeSignalKeptByRelax = input.snapshot?.rangeSignalKeptByRelax === true;
    const entryCandidate = input.snapshot?.entryCandidate === true;
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

    // Fix 1. stale FRESH_TICK block cleanup
    if (v2RejectReasonAfterPromotion === "FRESH_TICK_EXECUTION_BLOCKED" || v2RejectReasonAfterPromotion === "FRESH_TICK_BARRIER_ACTIVE") {
        const isActuallyBlocked =
            v2State.freshTickExecutionBlocked === true ||
            v2State.freshTickBarrierActive === true ||
            paperExecutionReady !== true;

        const canClear =
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            v2State.freshTickBarrierActive !== true &&
            v2State.freshTickExecutionBlocked !== true;

        if (canClear && !isActuallyBlocked) {
            const reasonBefore = v2RejectReasonAfterPromotion;
            v2RejectReasonAfterPromotion = null;
            console.info(JSON.stringify({
                event: "FRESH_TICK_STALE_BLOCK_CLEARED_PROOF",
                symbol: String(input.symbol),
                reason_before: reasonBefore,
                paper_execution_ready: paperExecutionReady,
                signed_execution_ready: signedExecutionReady,
                barrier_active: v2State.freshTickBarrierActive,
                execution_blocked: v2State.freshTickExecutionBlocked
            }));
        }
    }

    const unpromotableRejectReasons = new Set<string>([
        "ENTRY_QUALITY_CONTAMINATED_SIMILAR",
        "CRASH_ENTRY_GUARD_BLOCK",
        "RISK_EXPOSURE_CAP_PRE_SUBMIT",
        "ORDER_BUILD_FAIL",
        "FRESH_TICK_EXECUTION_BLOCKED",
        "FRESH_TICK_BARRIER_ACTIVE",
        "WHIPSAW_SHOCK_RECHECK"
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
        "FRESH_TICK_BARRIER_ACTIVE",
        "WHIPSAW_SHOCK_RECHECK"
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
            const shockUpMidMomentumConfirmed =
                shock === "UP" &&
                trendSideCandidate === "long" &&
                riskLongAllow === true &&
                allowNewLong === true &&
                emaGap > 0 &&
                qualityScore >= 70 &&
                trendWeaknessScore < 0.65 &&
                !pumpStateResolved.includes("ULTRA") &&
                !pumpStateResolved.includes("CRITICAL") &&
                hardBlockPresent === false;

            const shockDownMidMomentumConfirmed =
                shock === "DOWN" &&
                trendSideCandidate === "short" &&
                riskShortAllow === true &&
                allowNewShort === true &&
                emaGap < 0 &&
                qualityScore >= 60 && // Adjust: 70 -> 60 softened
                trendOk === true &&   // Adjust: trendOk condition specified
                paperExecutionReady === true && // Adjust: execution ready condition specified
                trendWeaknessScore < 0.75 && // Adjust: slightly softened (0.65 -> 0.75)
                !crashState.includes("ULTRA") &&
                !crashState.includes("CRITICAL") &&
                hardBlockPresent === false;

            if (shockUpMidMomentumConfirmed) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = "long";
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "SHOCK_REACTION_UP_MID_MOMENTUM_CONFIRMED";
                shockReactionPromotionType = "MID_MOMENTUM_CONFIRMED";
                shockReactionBlockReason = null;
                promotionBlockReason = null;
                console.info(JSON.stringify({
                    event: "V2_SHOCK_REACTION_SHORT_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    shock_state: shock,
                    side: "long",
                    zone: zone,
                    quality_score: qualityScore,
                    promotion_reason: "SHOCK_REACTION_UP_MID_MOMENTUM_CONFIRMED"
                }));
            } else if (shockDownMidMomentumConfirmed) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = "short";
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "SHOCK_REACTION_DOWN_MID_MOMENTUM_CONFIRMED";
                shockReactionPromotionType = "MID_MOMENTUM_CONFIRMED";
                shockReactionBlockReason = null;
                promotionBlockReason = null;
                console.info(JSON.stringify({
                    event: "V2_SHOCK_REACTION_SHORT_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    shock_state: shock,
                    side: "short",
                    zone: zone,
                    quality_score: qualityScore,
                    promotion_reason: "SHOCK_REACTION_DOWN_MID_MOMENTUM_CONFIRMED"
                }));
            } else {
                shockReactionBlockReason = "SHOCK_REACTION_WATCH_MID_CHASE_BLOCKED";
                if (promotionBlockReason == null) promotionBlockReason = shockReactionBlockReason;

                expectedMissingCondition = shockReactionBlockReason;
                if (shock === "DOWN") {
                    expectedNextAction = "WAIT_FOR_BREAKDOWN_RETEST_FAILURE";
                } else if (shock === "UP") {
                    expectedNextAction = "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION";
                }

                if (v2DecisionAfterPromotion === "ENTER" || v2DecisionAfterPromotion === "SKIP") {
                    v2DecisionAfterPromotion = "HOLD";
                }
                v2RejectReasonAfterPromotion = "WAIT_RECHECK";
            }

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
                promotion_applied: promotionApplied,
                promotion_type: shockReactionPromotionType,
                promotion_block_reason: promotionBlockReason,
                reversal_confirmed: reversalConfirmed,
                relaxedRangeEntry,
                range_edge_extreme: rangeEdgeExtreme,
                side_zone_valid: sideZoneValid,
                hard_block_present: hardBlockPresent,
                hard_block_reason: hardBlockReason,
                shock_reaction_watch_active: shockReactionWatchActive,
                shock_reaction_reason: promotionApplied ? promotionReason : "range_mid_requires_reaction_watch",
                shock_edge_setup_active_reason: shockEdgeSetupActiveReason.length > 0 ? shockEdgeSetupActiveReason.join("|") : null,
                shock_reaction_allowed_primary_side: shockReactionAllowedPrimarySide,
                shock_reaction_blocked_chase_reason: promotionApplied ? null : "mid_chase_forbidden",
                shock_reaction_next_valid_setups:
                    shockReactionDirection === "DOWN"
                        ? "upper_failure_short|lower_breakdown_short|lower_reversal_confirmed_long"
                        : "lower_support_long|upper_breakout_long|upper_reversal_confirmed_short",
                shock_reaction_promotion_type: shockReactionPromotionType
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
                } else if (downLowerReversalConfirmedLong && false) { // ?섏젙: SHOCK_REACTION_DOWN?먯꽌 long 諛곗젣
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

                if (shock === "DOWN" && setupSide === "short") {
                    console.info(JSON.stringify({
                        event: "V2_SHOCK_REACTION_SHORT_PROMOTION_PROOF",
                        symbol: String(input.symbol),
                        shock_state: shock,
                        side: "short",
                        zone: zone,
                        quality_score: qualityScore,
                        promotion_reason: promotionReason
                    }));
                }
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

        const saCandidateSide: EngineV2Side =
            activeEngineRouting === "RANGE" ? rangeSideCandidate :
            activeEngineRouting === "TREND" ? trendSideCandidate :
            (trendSideCandidate !== "none" ? trendSideCandidate : rangeSideCandidate);
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
                shockRecoveryHint &&
                false; // ?섏젙: DOWN shock?먯꽌??long 臾댁“嫄?李⑤떒
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

        // ?섏젙 2. 怨듯넻 V2 probe ENTER 寃쎈줈 異붽?
        const hasSameSidePosition = v2State.currentPositions.some(p => p.symbol === input.symbol && String(p.side).toLowerCase() === trendSideCandidate);
        const hasOppositeSidePosition = v2State.currentPositions.some(p => p.symbol === input.symbol && String(p.side).toLowerCase() !== trendSideCandidate);

        const probeCommonOk =
            !whipsawShockRecheckActive &&
            hardControlClear === true &&
            hardBlockPresent === false &&
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            !hasSameSidePosition &&
            !hasOppositeSidePosition &&
            qualityScore >= 67 &&
            trendOk === true &&
            (entryQualityGrade === "S" || entryQualityGrade === "A" || entryQualityGrade === "B") &&
            (readinessDiag.live_balance_block == null || readinessDiag.live_balance_ready === true);

        if (probeCommonOk && (v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "REJECT")) {
            const probeDownOk =
                shock === "DOWN" &&
                trendSideCandidate === "short" &&
                riskShortAllow === true &&
                allowNewShort === true &&
                emaGap < 0 &&
                !crashState.includes("ULTRA") &&
                !crashState.includes("CRITICAL");

            const probeUpOk =
                shock === "UP" &&
                trendSideCandidate === "long" &&
                riskLongAllow === true &&
                allowNewLong === true &&
                emaGap > 0 &&
                !pumpStateResolved.includes("ULTRA") &&
                !pumpStateResolved.includes("CRITICAL");

            if (probeDownOk || probeUpOk) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = trendSideCandidate;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "V2_PROBE_ENTRY_CONFIRMED";
                promotionBlockReason = null;
                shockReactionBlockReason = null;
            }
        }

        // ?섏젙 4. RANGE_MID_CHOP ?꾩슜 micro probe ENTER 寃쎈줈 異붽?
        const isRangeMidChop = judgment.regime === "RANGE" && judgment.subtype === "RANGE_MID_CHOP";
        const microProbeCommonOk =
            !whipsawShockRecheckActive &&
            isRangeMidChop &&
            shock === "NONE" &&
            hardControlClear === true &&
            hardBlockPresent === false &&
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            !hasSameSidePosition &&
            !hasOppositeSidePosition &&
            (rangeConfidence ?? 0) >= 0.75 &&
            (entryQualityGrade === "S" || entryQualityGrade === "A" || entryQualityGrade === "B") &&
            qualityScore >= 64 &&
            trendOk === true &&
            (trendSideCandidate === "long" || trendSideCandidate === "short") &&
            (readinessDiag.live_balance_block == null || readinessDiag.live_balance_ready === true) &&
            !pumpStateResolved.includes("ULTRA") && !pumpStateResolved.includes("CRITICAL") &&
            !crashState.includes("ULTRA") && !crashState.includes("CRITICAL");

        if (microProbeCommonOk && (v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "REJECT")) {
            const sideAllowed = trendSideCandidate === "long" ? (riskLongAllow && allowNewLong) : (riskShortAllow && allowNewShort);
            if (sideAllowed) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = trendSideCandidate;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "V2_RANGE_MID_MICRO_PROBE_CONFIRMED";
                promotionBlockReason = null;
                shockReactionBlockReason = null;
            }
        }

        // ?섏젙 5. WAIT_RECHECK 諛섎났 ?밴꺽 寃쎈줈 異붽? (recheck promotion path)
        const recheckPromotionEligible =
            !whipsawShockRecheckActive &&
            v2RejectReasonAfterPromotion === "WAIT_RECHECK" &&
            reviewingTicks >= 2 && // 2~3??諛섎났
            hardControlClear === true &&
            hardBlockPresent === false &&
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            !hasSameSidePosition &&
            !hasOppositeSidePosition &&
            qualityScore >= 60;

        if (recheckPromotionEligible && (v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP")) {
            const sideAllowed = trendSideCandidate === "long" ? (riskLongAllow && allowNewLong) : (riskShortAllow && allowNewShort);
            if (sideAllowed && trendSideCandidate !== "none" && trendOk) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = trendSideCandidate;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "V2_WAIT_RECHECK_QUALIFIED_PROMOTION";
                promotionBlockReason = null;
                console.info(JSON.stringify({
                    event: "V2_WAIT_RECHECK_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    reviewing_ticks: reviewingTicks,
                    side: trendSideCandidate,
                    quality_score: qualityScore,
                    promotion_reason: "V2_WAIT_RECHECK_QUALIFIED_PROMOTION"
                }));
            }
        }

        // ?섏젙 6. TRANSITION WATCH + SHOCK_REACTION_DOWN + upper short valid => micro/probe short probe
        // reviewingTicks=0?댁뼱??1?뚯감遺???덉슜. full size 湲덉?, micro/probe cap 媛뺤젣.
        const transitionWatchShortMeta = (execution.metadata ?? {}) as Record<string, unknown>;
        const transitionWatchShortSetupType = String(transitionWatchShortMeta.transitionSetupType ?? "NONE");
        const transitionWatchShortAction = String(transitionWatchShortMeta.transitionAction ?? "REJECT");
        const transitionWatchShortRejectReason = transitionWatchShortMeta.transitionRejectReason as string | null ?? null;

        const isTransitionWatchShortEligibleContext =
            activeEngineRouting === "TRANSITION" &&
            shock === "DOWN" &&
            (transitionWatchShortSetupType === "SHOCK_DOWN_REACTION" || judgment.subtype === "SHOCK_REACTION_DOWN") &&
            transitionWatchShortAction === "WATCH" &&
            (transitionWatchShortRejectReason === "INSUFFICIENT_CONFIRMATION" || transitionWatchShortRejectReason === "EMA_GAP_ONLY_PREFLIGHT_BLOCKED");

        const transitionWatchShortZoneOk =
            zone === "upper" || rangeSideCandidate === "short";

        const transitionWatchShortConditionsMet =
            !whipsawShockRecheckActive &&
            isTransitionWatchShortEligibleContext &&
            transitionWatchShortZoneOk &&
            trendSideCandidate === "short" &&
            riskShortAllow === true &&
            allowNewShort === true &&
            qualityScore >= 60 &&
            emaGap < 0 &&
            hardBlockPresent === false &&
            hardControlClear === true &&
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            !hasSameSidePosition &&
            !hasOppositeSidePosition &&
            !crashState.includes("ULTRA") &&
            !crashState.includes("CRITICAL") &&
            (v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "REJECT");

        let transitionWatchShortPromotionPassed = false;
        let transitionWatchShortFailReason: string | null = null;

        if (!isTransitionWatchShortEligibleContext) {
            if (activeEngineRouting !== "TRANSITION") transitionWatchShortFailReason = "NOT_TRANSITION_WATCH";
            else if (shock !== "DOWN") transitionWatchShortFailReason = "NOT_DOWN_SHOCK";
            else if (!(transitionWatchShortSetupType === "SHOCK_DOWN_REACTION" || judgment.subtype === "SHOCK_REACTION_DOWN")) transitionWatchShortFailReason = "NOT_SHOCK_REACTION_SETUP";
            else if (transitionWatchShortAction !== "WATCH") transitionWatchShortFailReason = "ACTION_NOT_WATCH";
            else transitionWatchShortFailReason = "NOT_ELIGIBLE_CONTEXT_OTHER";
        } else {
            if (!transitionWatchShortZoneOk) transitionWatchShortFailReason = "ZONE_NOT_UPPER";
            else if (trendSideCandidate !== "short") transitionWatchShortFailReason = "TREND_SIDE_NOT_SHORT";
            else if (!riskShortAllow || !allowNewShort) transitionWatchShortFailReason = "SHORT_NOT_ALLOWED";
            else if (qualityScore < 60) transitionWatchShortFailReason = "QUALITY_TOO_LOW";
            else if (emaGap >= 0) transitionWatchShortFailReason = "EMA_GAP_NOT_NEGATIVE";
            else if (hardBlockPresent) transitionWatchShortFailReason = "HARD_BLOCK_PRESENT";
            else if (!hardControlClear) transitionWatchShortFailReason = "HARD_CONTROL_NOT_CLEAR";
            else if (!paperExecutionReady) transitionWatchShortFailReason = "PAPER_EXECUTION_NOT_READY";
            else if (!signedExecutionReady) transitionWatchShortFailReason = "SIGNED_EXECUTION_NOT_READY";
            else if (hasSameSidePosition || hasOppositeSidePosition) transitionWatchShortFailReason = "HAS_POSITION";
            else if (crashState.includes("ULTRA") || crashState.includes("CRITICAL")) transitionWatchShortFailReason = "CRASH_STATE_ACTIVE";
            else if (v2DecisionAfterPromotion === "ENTER") transitionWatchShortFailReason = "ALREADY_PROMOTED";
            else transitionWatchShortPromotionPassed = transitionWatchShortConditionsMet;
        }

        if (shouldEmitV2Proof(
            "V2_TRANSITION_WATCH_SHORT_PROMOTION_PROOF",
            String(input.symbol),
            `${transitionWatchShortSetupType}|${transitionWatchShortAction}|${transitionWatchShortRejectReason}|${zone}|${qualityScore}|${transitionWatchShortPromotionPassed}`,
            isTransitionWatchShortEligibleContext
        )) {
            console.info(JSON.stringify({
                event: "V2_TRANSITION_WATCH_SHORT_PROMOTION_PROOF",
                symbol: String(input.symbol),
                transition_action: transitionWatchShortAction,
                transition_reject_reason: transitionWatchShortRejectReason,
                zone,
                range_side_candidate: rangeSideCandidate,
                trend_side_candidate: trendSideCandidate,
                short_allow: riskShortAllow && allowNewShort,
                quality_score: qualityScore,
                ema_gap: emaGap,
                promotion_passed: transitionWatchShortPromotionPassed,
                promotion_fail_reason: transitionWatchShortFailReason
            }));
        }

        // Step 7. Retest Recognition Layer (Breakdown/Breakout Retest Promotion)
        const isRetestEligiblePhase = judgment.subtype === "BREAKDOWN_RETEST_FAILED" ||
                                     judgment.subtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME" ||
                                     judgment.subtype === "BREAKOUT_RETEST_CONFIRMED";

        const m = (judgment.metadata as any) ?? {};
        const retestLevel = m.retestLevel ?? (judgment.subtype === "BREAKDOWN_RETEST_FAILED" ? (input.snapshot.boxLow ?? 0) : (input.snapshot.boxHigh ?? 0));
        const lastPrice = input.snapshot.lastPrice;
        const retestTouched = m.retestTouched ?? false;
        const retestRejected = m.retestRejected ?? false;
        const retestConfirmed = m.retestConfirmed ?? false;
        const distanceFromRetestPct = m.distanceFromRetestPct ?? 0;
        const chaseDistanceBlocked = m.chaseDistanceBlocked ?? (isRetestEligiblePhase && distanceFromRetestPct > 0.005);

        const isShortRetestPhase = judgment.subtype === "BREAKDOWN_RETEST_FAILED";

        const retestCommonOk =
            !whipsawShockRecheckActive &&
            isRetestEligiblePhase &&
            hardControlClear === true &&
            hardBlockPresent === false &&
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            !hasSameSidePosition &&
            !hasOppositeSidePosition &&
            qualityScore >= 55 &&
            !chaseDistanceBlocked &&
            retestTouched &&
            retestRejected &&
            retestConfirmed;

        if (isRetestEligiblePhase && !retestCommonOk) {
            if (!retestTouched) expectedMissingCondition = "RETEST_TOUCH";
            else if (!retestRejected) expectedMissingCondition = "RETEST_REJECTION";
            else if (!retestConfirmed) expectedMissingCondition = "RETEST_CONFIRMATION";
            else if (chaseDistanceBlocked) expectedMissingCondition = "CHASE_DISTANCE_LIMIT";

            expectedNextAction = "WATCH_FOR_RETEST_REJECTION";
        }

        if (retestCommonOk && (v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "REJECT")) {
            const isShortRetest = isShortRetestPhase && trendSideCandidate === "short" && riskShortAllow && allowNewShort && emaGap <= 0;
            const isLongRetest = (judgment.subtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME" || judgment.subtype === "BREAKOUT_RETEST_CONFIRMED") &&
                                trendSideCandidate === "long" && riskLongAllow && allowNewLong && emaGap >= 0;

            if (isShortRetest || isLongRetest) {
                const atr = Number(input.snapshot.atr ?? 0);
                const side = isShortRetest ? "short" : "long";
                let retestInvalidationPx = 0;

                if (side === "short") {
                    retestInvalidationPx = retestLevel + Math.max(retestLevel * 0.002, atr * 0.35);
                } else {
                    retestInvalidationPx = retestLevel - Math.max(retestLevel * 0.002, atr * 0.35);
                }

                let stopPriceValid = retestInvalidationPx > 0 && !isNaN(retestInvalidationPx);
                if (stopPriceValid) {
                    if (side === "short" && retestInvalidationPx <= lastPrice) stopPriceValid = false;
                    if (side === "long" && retestInvalidationPx >= lastPrice) stopPriceValid = false;
                }

                if (!stopPriceValid) {
                    console.warn(JSON.stringify({
                        event: "V2_RETEST_STOP_PRICE_INVALID_BLOCK_PROOF",
                        symbol: String(input.symbol),
                        side,
                        lastPrice,
                        calculatedInvalidationPx: retestInvalidationPx,
                        retestLevel
                    }));
                } else {
                    v2DecisionAfterPromotion = "ENTER";
                    v2SideAfterPromotion = trendSideCandidate;
                    v2RejectReasonAfterPromotion = null;
                    promotionApplied = true;
                    promotionReason = isShortRetest ? "V2_RETEST_SHORT_CONFIRMED" : "V2_RETEST_LONG_CONFIRMED";
                    promotionBlockReason = null;
                    promotionMinConditionPassed = true;

                    // Store for later metadata population
                    v2CalculatedInvalidationPx = retestInvalidationPx;

                    console.info(JSON.stringify({
                        event: "V2_RETEST_STOP_PRICE_PLAN_PROOF",
                        symbol: String(input.symbol),
                        side,
                        retestLevel,
                        lastPrice,
                        invalidationPx: retestInvalidationPx,
                        buffer_used: Math.abs(retestInvalidationPx - retestLevel)
                    }));

                    console.info(JSON.stringify({
                        event: isShortRetest ? "V2_BREAKDOWN_RETEST_RECOGNITION_PROOF" : "V2_BREAKOUT_RETEST_RECOGNITION_PROOF",
                        symbol: String(input.symbol),
                        phase: judgment.subtype,
                        side: trendSideCandidate,
                        retestLevel,
                        distanceFromRetestPct,
                        retestTouched,
                        retestRejected,
                        retestConfirmed,
                        ema_gap: emaGap,
                        quality_score: qualityScore,
                        reviewing_ticks: reviewingTicks,
                        promotion_reason: promotionReason,
                        invalidationPx: retestInvalidationPx
                    }));
                }
            }
        }

        // --- Hardening 2026-05-10: Detailed Trend Promotion Block Reasons & RANGE Zone Safety ---
        const regimeLabel = String(judgment.regime ?? "");
        const trendPromotionBlockApplies =
            !whipsawShockRecheckActive &&
            trendSideCandidate !== "none" &&
            !promotionApplied &&
            (activeEngineRouting === "TREND" || regimeLabel === "RANGE" || regimeLabel === "TRANSITION");

        if (trendPromotionBlockApplies) {
            const metaRec = execMeta as Record<string, unknown>;
            const upperLongProbeEligible =
                trendSideCandidate === "long" &&
                zone === "upper" &&
                qualityScore >= 70 &&
                (v2DecisionAfterPromotion === "SKIP" ||
                    v2DecisionAfterPromotion === "HOLD" ||
                    v2DecisionAfterPromotion === "REJECT");

            if (upperLongProbeEligible) {
                const st = judgment.subtype;
                const rp = judgment.rangePhase;
                const breakoutWatchOk =
                    st === "BREAKOUT_OBSERVATION" ||
                    st === "RANGE_BREAKOUT_CANDIDATE" ||
                    st === "VOLUME_BREAKOUT_OBSERVATION" ||
                    st === "VOLUME_SHOCK_UP" ||
                    st === "BREAKOUT_RETEST_CONFIRMED_VOLUME" ||
                    st === "BREAKOUT_RETEST_CONFIRMED" ||
                    String(boxBreakSide).toLowerCase() === "upper" ||
                    rp === "BREAKOUT" ||
                    rp === "BREAKOUT_OBSERVATION" ||
                    rp === "VOLUME_BREAKOUT_OBSERVATION" ||
                    rp === "VOLUME_SHOCK_UP";

                const strongConfirmationOk =
                    reversalConfirmed === true || breakoutWatchOk === true;

                const chaseBlockedFlag = metaRec.late_chase_blocked === true;
                const retestPendingSubtype =
                    st === "VOLUME_BREAKOUT_OBSERVATION" ||
                    st === "VOLUME_SHOCK_UP";
                const retestConfirmedSubtype =
                    st === "BREAKOUT_RETEST_CONFIRMED_VOLUME" || st === "BREAKOUT_RETEST_CONFIRMED";
                const retestRequiredFlag =
                    metaRec.retest_required === true ||
                    (retestPendingSubtype && !retestConfirmedSubtype);

                const supportRecheckFlag = metaRec.support_recheck_required === true;

                const boxHigh = Number(authoritativeInput.snapshot.boxHigh ?? 0);
                const boxLow = Number(authoritativeInput.snapshot.boxLow ?? 0);
                const boxMid = (boxHigh + boxLow) / 2;
                const atrProbe = Number(authoritativeInput.snapshot.atr ?? 0);
                const lastPriceProbe = Number(authoritativeInput.snapshot.lastPrice ?? 0);
                const entryPxProbe = lastPriceProbe;
                const minProfitDistProbe = Math.max(atrProbe * 0.35, entryPxProbe * 0.001);
                const minStopDistProbe = Math.max(atrProbe * 0.5, entryPxProbe * 0.0015);
                let probeInv = Math.min(boxLow - minStopDistProbe, entryPxProbe - minStopDistProbe);
                let probeTp1 = Math.max(boxMid, entryPxProbe + minProfitDistProbe);
                if (probeTp1 <= entryPxProbe) probeTp1 = entryPxProbe + minProfitDistProbe;
                let probeTp2 = Math.max(boxHigh, probeTp1 + minProfitDistProbe);
                if (probeTp2 <= probeTp1) probeTp2 = probeTp1 + minProfitDistProbe;
                const boxHeight = boxHigh - boxLow;
                const boxHeightPct = boxLow > 0 ? boxHeight / boxLow : 0;
                const longOrderOkProbe =
                    probeInv < entryPxProbe && entryPxProbe < probeTp1 && probeTp1 < probeTp2;
                const longPlanGeomInvalid =
                    !Number.isFinite(entryPxProbe) ||
                    entryPxProbe <= 0 ||
                    !Number.isFinite(probeTp1) ||
                    !Number.isFinite(probeTp2) ||
                    !Number.isFinite(probeInv) ||
                    probeTp1 <= 0 ||
                    probeTp2 <= 0 ||
                    probeInv <= 0 ||
                    boxHeightPct < 0.0008 ||
                    !longOrderOkProbe;
                const stopValidLong =
                    probeInv > 0 &&
                    Number.isFinite(probeInv) &&
                    Number.isFinite(lastPriceProbe) &&
                    probeInv < lastPriceProbe;
                const tpValidLong = !longPlanGeomInvalid;

                type UpperLongGate = string | null;
                let upperLongGate: UpperLongGate = null;
                if (chaseBlockedFlag) upperLongGate = "TREND_PROMOTION_BLOCKED_CHASE_BLOCKED";
                else if (retestRequiredFlag) upperLongGate = "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED";
                else if (supportRecheckFlag) upperLongGate = "TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED";
                else if (!(riskLongAllow && allowNewLong)) upperLongGate = "TREND_PROMOTION_BLOCKED_LONG_NOT_ALLOWED";
                else if (!paperExecutionReady) upperLongGate = "TREND_PROMOTION_BLOCKED_PAPER_EXECUTION_NOT_READY";
                else if (!signedExecutionReady) upperLongGate = "TREND_PROMOTION_BLOCKED_SIGNED_EXECUTION_NOT_READY";
                else if (hasSameSidePosition || hasOppositeSidePosition) {
                    upperLongGate = "TREND_PROMOTION_BLOCKED_OPEN_POSITION_CONFLICT";
                } else if (hardBlockPresent) upperLongGate = "TREND_PROMOTION_BLOCKED_HARD_BLOCK_PRESENT";
                else if (!trendOk) upperLongGate = "TREND_PROMOTION_BLOCKED_TREND_NOT_CONFIRMED";
                else if (judgment.htf_requires_stronger_confirmation === true && !strongConfirmationOk) {
                    upperLongGate = "TREND_PROMOTION_BLOCKED_HTF_STRONG_CONFIRMATION_REQUIRED";
                } else if (!stopValidLong) upperLongGate = "TREND_PROMOTION_BLOCKED_STOP_PRICE_MISSING";
                else if (!tpValidLong) upperLongGate = "TREND_PROMOTION_BLOCKED_TP_SL_PLAN_INVALID";
                else if (!sideZoneValid && !breakoutWatchOk) {
                    upperLongGate = "TREND_PROMOTION_BLOCKED_SIDE_ZONE_AND_BREAKOUT_WATCH";
                }

                if (upperLongGate != null) {
                    promotionBlockReason = upperLongGate;
                    expectedMissingCondition = upperLongGate;
                    expectedNextAction = "WAIT_FOR_UPPER_LONG_PROBE_GATE";
                    console.info(
                        JSON.stringify({
                            event: "V2_UPPER_LONG_PROBE_GATE_SKIP_PROOF",
                            symbol: String(input.symbol),
                            expected_missing_condition: upperLongGate,
                            promotion_block_reason: upperLongGate,
                            zone,
                            qualityScore,
                            trend_side_candidate: trendSideCandidate,
                            chase_blocked: chaseBlockedFlag,
                            retest_required: retestRequiredFlag,
                            support_recheck_required: supportRecheckFlag,
                            paper_execution_ready: paperExecutionReady,
                            signed_execution_ready: signedExecutionReady,
                            htf_entry_policy: judgment.htf_entry_policy ?? null,
                            htf_requires_stronger_confirmation: judgment.htf_requires_stronger_confirmation ?? false,
                            side_zone_valid: sideZoneValid,
                            breakout_watch_ok: breakoutWatchOk,
                            strong_confirmation_ok: strongConfirmationOk,
                            decision_before_gate: v2DecisionAfterPromotion,
                            boxBreakSide,
                            subtype: st,
                            range_phase: rp
                        })
                    );
                } else {
                    v2DecisionAfterPromotion = "ENTER";
                    v2SideAfterPromotion = "long";
                    v2RejectReasonAfterPromotion = null;
                    promotionApplied = true;
                    promotionReason = "V2_UPPER_LONG_PROBE_PROMOTION";
                    promotionBlockReason = null;
                    promotionMinConditionPassed = true;
                    v2CalculatedInvalidationPx = probeInv;

                    console.info(
                        JSON.stringify({
                            event: "V2_TREND_PROMOTION_TO_ENTER_PROOF",
                            symbol: String(input.symbol),
                            side: "long",
                            zone,
                            qualityScore,
                            htf_entry_policy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
                            htf_size_multiplier:
                                typeof judgment.htf_size_multiplier === "number"
                                    ? judgment.htf_size_multiplier
                                    : null,
                            htf_requires_stronger_confirmation: judgment.htf_requires_stronger_confirmation ?? false,
                            entryPx: lastPriceProbe,
                            stopPrice: probeInv,
                            tp1: probeTp1,
                            tp2: probeTp2,
                            finalDecision: "ENTER",
                            promotion_reason: promotionReason,
                            breakout_watch_ok: breakoutWatchOk,
                            side_zone_valid: sideZoneValid
                        })
                    );
                }
            } else if (
                !promotionApplied &&
                (rangeSideCandidate === "long" || trendSideCandidate === "long") &&
                zone === "lower" &&
                sideZoneValid === true &&
                (judgment.htf_entry_policy === "LONG_ONLY_OR_NONE" || judgment.htf_entry_policy === "ALLOW") &&
                (judgment.macro_source === "actual_candles" || judgment.macro_source === "partial_actual_candles") &&
                qualityScore >= 60 &&
                (v2DecisionAfterPromotion === "SKIP" ||
                    v2DecisionAfterPromotion === "HOLD" ||
                    v2DecisionAfterPromotion === "REJECT")
            ) {
                const macroSrc = judgment.macro_source ?? "data_not_ready";
                const htfPol = judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT";
                const chaseBlockedLower = (execMeta as Record<string, unknown>).late_chase_blocked === true;
                const retestReqLower = (execMeta as Record<string, unknown>).retest_required === true;
                const reclaimReqLower = (execMeta as Record<string, unknown>).reclaim_required === true;

                const boxHighL = Number(authoritativeInput.snapshot.boxHigh ?? 0);
                const boxLowL = Number(authoritativeInput.snapshot.boxLow ?? 0);
                const boxMidL = (boxHighL + boxLowL) / 2;
                const atrL = Number(authoritativeInput.snapshot.atr ?? 0);
                const entryPxL = Number(authoritativeInput.snapshot.lastPrice ?? 0);
                const minProfitL = Math.max(atrL * 0.35, entryPxL * 0.001);
                const minStopL = Math.max(atrL * 0.5, entryPxL * 0.0015);
                let stopPxL = Math.min(boxLowL - minStopL, entryPxL - minStopL);
                let tp1L = Math.max(boxMidL, entryPxL + minProfitL);
                if (tp1L <= entryPxL) tp1L = entryPxL + minProfitL;
                let tp2L = Math.max(boxHighL, tp1L + minProfitL);
                if (tp2L <= tp1L) tp2L = tp1L + minProfitL;
                const boxHeightL = boxHighL - boxLowL;
                const boxHeightPctL = boxLowL > 0 ? boxHeightL / boxLowL : 0;
                const longOrderOkL =
                    stopPxL < entryPxL && entryPxL < tp1L && tp1L < tp2L;
                const planInvalidL =
                    !Number.isFinite(entryPxL) ||
                    entryPxL <= 0 ||
                    !Number.isFinite(tp1L) ||
                    !Number.isFinite(tp2L) ||
                    !Number.isFinite(stopPxL) ||
                    tp1L <= 0 ||
                    tp2L <= 0 ||
                    stopPxL <= 0 ||
                    boxHeightPctL < 0.0008 ||
                    !longOrderOkL;

                type LowerLongGate = string | null;
                let lowerLongGate: LowerLongGate = null;
                if (chaseBlockedLower) lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_CHASE_BLOCKED";
                else if (!(riskLongAllow && allowNewLong)) {
                    lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_LONG_NOT_ALLOWED";
                } else if (!paperExecutionReady || !signedExecutionReady) {
                    lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_EXECUTION_READINESS";
                } else if (hasSameSidePosition || hasOppositeSidePosition) {
                    lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_POSITION_CONFLICT";
                } else if (hardBlockPresent) lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_HARD_BLOCK";
                else if (!(stopPxL > 0 && stopPxL < entryPxL)) {
                    lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_STOP_PRICE_MISSING";
                } else if (planInvalidL) lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_TP_SL_PLAN_INVALID";

                if (lowerLongGate != null) {
                    promotionBlockReason = lowerLongGate;
                    expectedMissingCondition = lowerLongGate;
                    expectedNextAction = "WAIT_FOR_LOWER_LONG_REACTION_PROBE_GATE";
                    console.info(
                        JSON.stringify({
                            event: "V2_LOWER_LONG_REACTION_PROBE_GATE_SKIP_PROOF",
                            symbol: String(input.symbol),
                            gate_reason: lowerLongGate,
                            zone,
                            qualityScore,
                            range_side_candidate: rangeSideCandidate,
                            trend_side_candidate: trendSideCandidate,
                            side_zone_valid: sideZoneValid,
                            htf_entry_policy: htfPol,
                            macro_source: macroSrc,
                            chase_blocked: chaseBlockedLower,
                            retest_required: retestReqLower,
                            reclaim_required: reclaimReqLower,
                            paper_execution_ready: paperExecutionReady,
                            signed_execution_ready: signedExecutionReady,
                            decision_before_gate: v2DecisionAfterPromotion
                        })
                    );
                } else {
                    v2DecisionAfterPromotion = "ENTER";
                    v2SideAfterPromotion = "long";
                    v2RejectReasonAfterPromotion = null;
                    promotionApplied = true;
                    promotionReason = "V2_LOWER_LONG_REACTION_PROBE_PROMOTION";
                    promotionBlockReason = null;
                    promotionMinConditionPassed = true;
                    v2CalculatedInvalidationPx = stopPxL;

                    console.info(
                        JSON.stringify({
                            event: "V2_TREND_PROMOTION_TO_ENTER_PROOF",
                            symbol: String(input.symbol),
                            side: "long",
                            zone,
                            qualityScore,
                            htf_entry_policy: htfPol,
                            htf_size_multiplier:
                                typeof judgment.htf_size_multiplier === "number"
                                    ? judgment.htf_size_multiplier
                                    : null,
                            htf_requires_stronger_confirmation: judgment.htf_requires_stronger_confirmation ?? false,
                            entryPx: entryPxL,
                            stopPrice: stopPxL,
                            tp1: tp1L,
                            tp2: tp2L,
                            finalDecision: "ENTER",
                            promotion_reason: promotionReason,
                            macro_source: macroSrc,
                            retest_required: retestReqLower,
                            reclaim_required: reclaimReqLower,
                            micro_probe_cap_forced: retestReqLower || reclaimReqLower,
                            side_zone_valid: sideZoneValid
                        })
                    );
                }
            } else if (
                !promotionApplied &&
                (judgment.subtype === "SHOCK_REACTION_DOWN" || judgment.shockPhase === "DOWN_SHOCK") &&
                (trendSideCandidate === "short" || rangeSideCandidate === "short") &&
                (zone === "upper" || (judgment.subtype === "BREAKDOWN_RETEST_FAILED" && zone === "mid")) &&
                (v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "REJECT")
            ) {
                const htfPol = judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT";
                const chaseBlocked = (execMeta as Record<string, unknown>).late_chase_blocked === true;
                const breakdownRetestFailure = judgment.subtype === "BREAKDOWN_RETEST_FAILED" || (judgment.metadata?.retestConfirmed === true);

                const boxHighS = Number(authoritativeInput.snapshot.boxHigh ?? 0);
                const boxLowS = Number(authoritativeInput.snapshot.boxLow ?? 0);
                const boxMidS = (boxHighS + boxLowS) / 2;
                const atrS = Number(authoritativeInput.snapshot.atr ?? 0);
                const entryPxS = Number(authoritativeInput.snapshot.lastPrice ?? 0);
                const minProfitS = Math.max(atrS * 0.35, entryPxS * 0.001);
                const minStopS = Math.max(atrS * 0.5, entryPxS * 0.0015);

                let stopPxS = Math.max(boxHighS + minStopS, entryPxS + minStopS);
                let tp1S = Math.min(boxMidS, entryPxS - minProfitS);
                if (tp1S >= entryPxS) tp1S = entryPxS - minProfitS;
                let tp2S = Math.min(boxLowS, tp1S - minProfitS);
                if (tp2S >= tp1S) tp2S = tp1S - minProfitS;

                const boxHeightS = boxHighS - boxLowS;
                const boxHeightPctS = boxLowS > 0 ? boxHeightS / boxLowS : 0;

                const shortOrderOkS = tp2S < tp1S && tp1S < entryPxS && entryPxS < stopPxS;
                const planInvalidS =
                    !Number.isFinite(entryPxS) || entryPxS <= 0 ||
                    !Number.isFinite(tp1S) || !Number.isFinite(tp2S) || !Number.isFinite(stopPxS) ||
                    tp1S <= 0 || tp2S <= 0 || stopPxS <= 0 ||
                    boxHeightPctS < 0.0008 ||
                    !shortOrderOkS;

                let gate: string | null = null;

                const htfLongOnly = htfPol === "LONG_ONLY_OR_NONE";
                const htfHold = htfPol === "HOLD";
                const isShockReactionDown = judgment.subtype === "SHOCK_REACTION_DOWN";

                let htfBlocked = htfLongOnly;
                if (htfHold) {
                    if (isShockReactionDown && breakdownRetestFailure) {
                        htfBlocked = false;
                    } else {
                        htfBlocked = true;
                    }
                }

                if (htfBlocked) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_HTF_LONG_ONLY";
                else if (chaseBlocked && !breakdownRetestFailure) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_CHASE_NOT_RETESTED";
                else if (qualityScore < 60) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_QUALITY_BELOW_60";
                else if (!(riskShortAllow && allowNewShort)) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_SHORT_NOT_ALLOWED";
                else if (!paperExecutionReady || !signedExecutionReady) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_EXECUTION_NOT_READY";
                else if (hasSameSidePosition || hasOppositeSidePosition) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_OPEN_POSITION_CONFLICT";
                else if (hardBlockPresent) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_HARD_BLOCK_PRESENT";
                else if (!(stopPxS > 0 && stopPxS > entryPxS)) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_STOP_PRICE_MISSING";
                else if (planInvalidS) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_TP_SL_PLAN_INVALID";
                else if (!(zone === "upper" || (breakdownRetestFailure && zone === "mid"))) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_ZONE_NOT_VALID";

                if (gate != null) {
                    promotionBlockReason = gate;
                    expectedMissingCondition = gate;
                    expectedNextAction = "WAIT_FOR_UPPER_SHORT_REACTION_PROBE_GATE";
                    console.info(JSON.stringify({
                        event: "V2_UPPER_SHORT_REACTION_PROBE_GATE_SKIP_PROOF",
                        symbol: String(input.symbol),
                        gate_reason: gate,
                        zone,
                        qualityScore,
                        market_subtype: judgment.subtype,
                        htf_entry_policy: htfPol,
                        chase_blocked: chaseBlocked,
                        breakdown_retest_failure: breakdownRetestFailure
                    }));
                } else {
                    v2DecisionAfterPromotion = "ENTER";
                    v2SideAfterPromotion = "short";
                    v2RejectReasonAfterPromotion = null;
                    promotionApplied = true;
                    promotionReason = "V2_UPPER_SHORT_REACTION_PROBE_PROMOTION";
                    promotionBlockReason = null;
                    promotionMinConditionPassed = true;
                    v2CalculatedInvalidationPx = stopPxS;

                    console.info(JSON.stringify({
                        event: "V2_TREND_PROMOTION_TO_ENTER_PROOF",
                        symbol: String(input.symbol),
                        promotion_reason: "V2_UPPER_SHORT_REACTION_PROBE_PROMOTION",
                        side: "short",
                        entryPx: entryPxS,
                        stopPrice: stopPxS,
                        tp1: tp1S,
                        tp2: tp2S,
                        qualityScore,
                        zone,
                        market_subtype: judgment.subtype,
                        htf_entry_policy: htfPol,
                        macro_source: judgment.macro_source ?? "unknown",
                        retest_required: (execMeta as any).retest_required ?? false,
                        breakdown_retest_failure: breakdownRetestFailure,
                        micro_probe_cap_forced: true
                    }));
                }
            } else if (qualityScore < 70) {
                promotionBlockReason = "TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD";
                expectedNextAction = "WAIT_FOR_QUALITY_IMPROVEMENT";
                expectedMissingCondition = "TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD";
            } else if (zone === "lower" && trendSideCandidate === "short") {
                promotionBlockReason = "TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKDOWN_CONFIRMED";
                v2DecisionAfterPromotion = "HOLD";
                v2RejectReasonAfterPromotion = "WAIT_RECHECK";
                expectedNextAction = "WAIT_FOR_BREAKDOWN_RETEST_RESISTANCE_CONFIRM";
                expectedMissingCondition = "TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKDOWN_CONFIRMED";
            } else if (marketMode === "RANGE" && (boxBreakSide === "none" || boxBreakSide === "UNKNOWN")) {
                promotionBlockReason = "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED";
                expectedNextAction = "WAIT_FOR_BREAKOUT_RETEST_SUPPORT_CONFIRM";
                expectedMissingCondition = "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED";
            } else {
                promotionBlockReason = "TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED";
                expectedNextAction = "WAIT_FOR_RECHECK_OR_RETEST";
                expectedMissingCondition = "TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED";
            }
        }

        if (transitionWatchShortConditionsMet) {
            const atr = Number(input.snapshot.atr ?? 0);
            const transitionInvalidationPx = lastPrice + Math.max(lastPrice * 0.002, atr * 0.35);

            let stopPriceValid = transitionInvalidationPx > lastPrice && !isNaN(transitionInvalidationPx);

            if (!stopPriceValid) {
                 console.warn(JSON.stringify({
                    event: "V2_TRANSITION_STOP_PRICE_INVALID_BLOCK_PROOF",
                    symbol: String(input.symbol),
                    side: "short",
                    lastPrice,
                    calculatedInvalidationPx: transitionInvalidationPx
                }));
            } else {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = "short";
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "V2_TRANSITION_WATCH_SHORT_PROBE";
                promotionBlockReason = null;
                shockReactionBlockReason = null;
                v2CalculatedInvalidationPx = transitionInvalidationPx;

                console.info(JSON.stringify({
                    event: "V2_SHOCK_REACTION_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    shock_state: shock,
                    side: "short",
                    zone,
                    quality_score: qualityScore,
                    promotion_reason: "V2_TRANSITION_WATCH_SHORT_PROBE",
                    invalidationPx: transitionInvalidationPx
                }));
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

    // Tier 5+: Side Consistency Enforcer (Authoritative)
    const sideCandidateBeforeVetoEnforced = v2SideAfterPromotion;
    const selectedSideFinal: EngineV2Side =
        activeEngineRouting === "RANGE" ? rangeSideCandidate :
        activeEngineRouting === "TREND" ? trendSideCandidate :
        v2SideAfterPromotion;

    const upperLongProbePromotion = promotionReason === "V2_UPPER_LONG_PROBE_PROMOTION";
    const lowerLongProbePromotion = promotionReason === "V2_LOWER_LONG_REACTION_PROBE_PROMOTION";
    const upperShortProbePromotion = promotionReason === "V2_UPPER_SHORT_REACTION_PROBE_PROMOTION";
    if (v2DecisionAfterPromotion === "ENTER" && !upperLongProbePromotion && !lowerLongProbePromotion && !upperShortProbePromotion) {
        v2SideAfterPromotion = selectedSideFinal;
    }

    const finalDecisionBeforeVeto = v2DecisionAfterPromotion;
    const sideCandidateBeforeVeto = v2SideAfterPromotion;
    let vetoReason: string | null = null;
    const rangeLowerShortMismatchByReason = signalGateBlockedReason === "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT";
    const rangeUpperLongMismatchByReason = signalGateBlockedReason === "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG";
    const isRangeRouting = activeEngineRouting === "RANGE";
    const rangeLowerShortMismatch = isRangeRouting && sideCandidateBeforeVeto === "short" && (rangeLowerShortMismatchByReason || (boxPos ?? 0.5) <= rangeLowerThreshold);
    const rangeUpperLongMismatch = isRangeRouting && sideCandidateBeforeVeto === "long" && (rangeUpperLongMismatchByReason || (boxPos ?? 0.5) >= rangeUpperThreshold);
    const rangeDowngradedHardBlock = rangeSignalDowngraded && !rangeSignalKeptByRelax;
    const entryCandidateHardBlock = !entryCandidate && !promotionApplied;
    const trendPromotionHardBlock = activeEngineRouting === "TREND" && trendOk !== true && sideCandidateBeforeVeto !== "none";
    const rangeMidConservativeBlock =
        rangeContextActive &&
        zone === "mid" &&
        sideCandidateBeforeVeto !== "none" &&
        !reversalConfirmed &&
        !relaxedRangeEntry &&
        !rangeEdgeExtreme &&
        !shockRecoveryHint;

    if (v2DecisionAfterPromotion === "ENTER") {
        if (rangeLowerShortMismatch && !execMeta.sideOverrideApplied && !upperShortProbePromotion) {
            vetoReason = "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT";
        } else if (rangeUpperLongMismatch && !execMeta.sideOverrideApplied && !upperLongProbePromotion) {
            vetoReason = "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG";
        } else if (rangeDowngradedHardBlock) {
            vetoReason = "RANGE_SIGNAL_DOWNGRADED_NOT_RELAXED";
        } else if (entryCandidateHardBlock && !upperLongProbePromotion && !lowerLongProbePromotion && !upperShortProbePromotion) {
            vetoReason = "ENTRY_CANDIDATE_FALSE_VETO";
        } else if (trendPromotionHardBlock) {
            vetoReason = "TREND_PROMOTION_BLOCKED_TREND_NOT_OK";
        } else if (rangeMidConservativeBlock && !execMeta.sideOverrideApplied) {
            vetoReason = "RANGE_MID_CONSERVATIVE_VETO";
        }
    }

    if (vetoReason != null) {
        v2DecisionAfterPromotion = "SKIP";
        v2SideAfterPromotion = "none";
        v2RejectReasonAfterPromotion = vetoReason;
        promotionApplied = false;
        promotionReason = null;
        console.info(JSON.stringify({
            event: "V2_RANGE_SIDE_ZONE_VETO_PROOF",
            symbol: String(input.symbol),
            regime: marketMode,
            boxPos,
            rangeZone: zone,
            sideCandidate: sideCandidateBeforeVeto,
            signalGateBlockedReason,
            rangeSignalDowngraded,
            rangeSignalKeptByRelax,
            entryCandidate,
            trendOk,
            long_allow: allowNewLong,
            short_allow: allowNewShort,
            finalDecisionBeforeVeto,
            finalDecisionAfterVeto: v2DecisionAfterPromotion,
            vetoReason
        }));
    }

    // Tier 5+: Selected Side Consistency Log
    console.info(JSON.stringify({
        event: "V2_SELECTED_SIDE_CONSISTENCY_PROOF",
        symbol: String(input.symbol),
        active_engine_routing: activeEngineRouting,
        market_subtype: judgment.subtype,
        range_zone: zone,
        range_side_candidate: rangeSideCandidate,
        trend_side_candidate: trendSideCandidate,
        aligned_signal: alignedSignal,
        selected_side_before_veto: sideCandidateBeforeVetoEnforced,
        selected_side_after_veto: v2SideAfterPromotion,
        side_zone_valid: sideZoneValid,
        entryCandidate: entryCandidate,
        vetoReason: vetoReason,
        finalDecisionBeforeVeto: finalDecisionBeforeVeto,
        finalDecisionAfterVeto: v2DecisionAfterPromotion
    }));

    console.info(JSON.stringify({
        event: "V2_ENTRY_CANDIDATE_PROMOTION_PROOF",
        symbol: String(input.symbol),
        judgment_regime: judgment.regime,
        judgment_subtype: judgment.subtype,
        range_phase: judgment.rangePhase,
        range_side_candidate: rangeSideCandidate,
        trend_side_candidate: trendSideCandidate,
        selected_side_before_veto: sideCandidateBeforeVetoEnforced,
        selected_side_after_veto: v2SideAfterPromotion,
        promotion_applied: promotionApplied,
        promotion_reason: promotionReason,
        final_decision: v2DecisionAfterPromotion,
        side_override_applied: !!execMeta.sideOverrideApplied
    }));

    // Side Veto Detail Calculation (Diagnostic)
    const rangeTrendConflict =
        rangeSideCandidate && trendSideCandidate &&
        rangeSideCandidate !== "none" && trendSideCandidate !== "none" &&
        rangeSideCandidate !== trendSideCandidate;

    let sideVetoDetail: string | null = null;
    if (judgment.subtype === "WHIPSAW_SHOCK_RECHECK") {
        sideVetoDetail = "WHIPSAW_SHOCK_RECHECK_ACTIVE";
    } else if (v2SideAfterPromotion === "none" || v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP") {
        if (judgment.subtype === "SHOCK_REACTION_UP" && trendSideCandidate === "long") {
            if (zone === "mid") sideVetoDetail = "SHOCK_UP_MID_RETEST_REQUIRED";
            else if (trendOk === false) sideVetoDetail = "SHOCK_UP_TREND_CONFIRMATION_WEAK";
            else if (reversalConfirmed === false) sideVetoDetail = "SHOCK_UP_RECLAIM_NOT_CONFIRMED";
        } else if (judgment.subtype === "SHOCK_REACTION_DOWN" && trendSideCandidate === "short") {
            if (zone === "mid") sideVetoDetail = "SHOCK_DOWN_MID_RETEST_REQUIRED";
            else if (trendOk === false) sideVetoDetail = "SHOCK_DOWN_TREND_CONFIRMATION_WEAK";
            else if (reversalConfirmed === false) sideVetoDetail = "SHOCK_DOWN_BREAKDOWN_RETEST_NOT_CONFIRMED";
        } else if (rangeTrendConflict) {
            sideVetoDetail = "RANGE_TREND_SIDE_CONFLICT";
        } else if ((!rangeSideCandidate || rangeSideCandidate === "none") && trendSideCandidate && trendSideCandidate !== "none" && promotionApplied === false) {
            sideVetoDetail = promotionBlockReason || "TREND_PROMOTION_VETOED";
        }
    }

    // Polarity Check V2: Strict suppression for HTF mismatch
    if (judgment.polarityMismatch && (v2DecisionAfterPromotion === "ENTER" || promotionApplied)) {
        const macroPol = judgment.macroPolarity;
        const finalSide = v2SideAfterPromotion;
        if (macroPol === "BULLISH" && finalSide === "short") {
            v2DecisionAfterPromotion = "HOLD";
            v2RejectReasonAfterPromotion = "HTF_POLICY_POLARITY_MISMATCH";
            promotionApplied = false;
            promotionBlockReason = "HTF_POLICY_POLARITY_MISMATCH";
            expectedMissingCondition = "HTF_POLICY_POLARITY_MISMATCH";
            expectedNextAction = "WAIT_FOR_MACRO_ALIGNMENT_OR_STABILIZATION";
        } else if (macroPol === "BEARISH" && finalSide === "long") {
            v2DecisionAfterPromotion = "HOLD";
            v2RejectReasonAfterPromotion = "HTF_POLICY_POLARITY_MISMATCH";
            promotionApplied = false;
            promotionBlockReason = "HTF_POLICY_POLARITY_MISMATCH";
            expectedMissingCondition = "HTF_POLICY_POLARITY_MISMATCH";
            expectedNextAction = "WAIT_FOR_MACRO_ALIGNMENT_OR_STABILIZATION";
        }
    }

    // Tier 5.5: Side-Zone Mismatch Hard Guard (V2 Hard Protection)
    if (v2DecisionAfterPromotion === "ENTER") {
        const sideFinal = v2SideAfterPromotion;
        const htfPol = judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT";
        const htfHardBlockReason = judgment.htf_hard_block_reason ?? "";

        const boxBreakSideFinal =
            typeof authoritativeInput.snapshot?.boxBreakSide === "string"
                ? String(authoritativeInput.snapshot.boxBreakSide)
                : "none";

        const isShockReactionDown = judgment.subtype === "SHOCK_REACTION_DOWN" || judgment.shockPhase === "DOWN_SHOCK";
        const isShockReactionUp = judgment.subtype === "SHOCK_REACTION_UP" || judgment.shockPhase === "UP_SHOCK";

        const breakdownRetestFailure =
            judgment.subtype === "BREAKDOWN_RETEST_FAILED" ||
            judgment.metadata?.breakdownRetestFailure === true ||
            judgment.metadata?.breakdown_retest_failure === true ||
            (judgment.metadata?.retestRejected === true && judgment.metadata?.retestConfirmed === true && sideFinal === "short");

        const breakoutRetestConfirmation =
            judgment.subtype === "BREAKOUT_RETEST_CONFIRMED" ||
            judgment.subtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME" ||
            judgment.metadata?.breakoutRetestConfirmed === true ||
            judgment.metadata?.breakout_retest_confirmed === true ||
            (judgment.metadata?.retestRejected === false && judgment.metadata?.retestConfirmed === true && sideFinal === "long");

        let mismatchReason: string | null = null;
        if (sideFinal === "short" && zone === "lower") {
            const shortException = breakdownRetestFailure || boxBreakSideFinal === "lower" || isShockReactionDown;
            const htfStrongBullish = htfHardBlockReason === "STRONG_BULLISH_HTF_ALIGNMENT";

            if (!shortException || htfStrongBullish) {
                mismatchReason = "SIDE_ZONE_MISMATCH_LOWER_SHORT";
            }
        } else if (sideFinal === "long" && zone === "upper") {
            const longException = breakoutRetestConfirmation || boxBreakSideFinal === "upper" || isShockReactionUp;
            const htfStrongBearish = htfHardBlockReason === "STRONG_BEARISH_HTF_ALIGNMENT";

            if (!longException || htfStrongBearish) {
                mismatchReason = "SIDE_ZONE_MISMATCH_UPPER_LONG";
            }
        }

        if (mismatchReason != null) {
            const decisionBeforeMismatchBlock = v2DecisionAfterPromotion;
            v2DecisionAfterPromotion = "HOLD";
            v2SideAfterPromotion = "none";
            v2RejectReasonAfterPromotion = mismatchReason;
            promotionApplied = false;
            promotionReason = null;
            expectedMissingCondition = mismatchReason;
            expectedNextAction = sideFinal === "short"
                ? "WAIT_FOR_UPPER_REJECTION_OR_BREAKDOWN_RETEST"
                : "WAIT_FOR_LOWER_REJECTION_OR_BREAKOUT_RETEST";

            console.info(JSON.stringify({
                event: "V2_SIDE_ZONE_MISMATCH_BLOCK_PROOF",
                symbol: String(input.symbol),
                side: sideFinal,
                zone,
                boxPos,
                boxBreakSide: boxBreakSideFinal,
                market_subtype: judgment.subtype,
                shockPhase: judgment.shockPhase,
                htf_entry_policy: htfPol,
                htf_hard_block_reason: htfHardBlockReason,
                macro_source: judgment.macro_source ?? "unknown",
                qualityScore,
                finalDecisionBefore: decisionBeforeMismatchBlock,
                finalDecisionAfter: v2DecisionAfterPromotion,
                reason: mismatchReason
            }));
        }
    }

    finalDecision = v2DecisionAfterPromotion;
    blockReason = v2RejectReasonAfterPromotion;

    const decisionAfterReadiness: EngineV2FinalDecision = finalDecision;

    // Live order size authority: fixed 10x leverage + strict env notional cap.
    const stageMarginKrwBefore = riskSizing.stageMarginKrw;
    let stageMarginKrwAfter = stageMarginKrwBefore;
    let cap_applied = false;
    let cap_reason: string | null = null;
    let cap_kind: string | null = null;
    let min_order_check_passed = true;
    let min_order_block_reason: string | null = null;
    const minProbeMarginKrw = 14000;
    const minNotionalUsdtRequiredAtFixed10x = 100;
    const rawEnvLiveMaxNotionalUsdt = process.env.OKX_LIVE_MAX_ORDER_NOTIONAL_USDT ?? null;
    const stateLiveMaxOrderNotionalUsdt = Number(v2State.liveMaxOrderNotionalUsdt);
    const liveMaxNotionalSource = "process.env.OKX_LIVE_MAX_ORDER_NOTIONAL_USDT";
    let envParsed = NaN;
    let liveMaxNotionalUsdtFinal = 0;
    if (rawEnvLiveMaxNotionalUsdt != null && rawEnvLiveMaxNotionalUsdt.trim() !== "") {
        envParsed = Number(rawEnvLiveMaxNotionalUsdt.trim());
        if (Number.isFinite(envParsed) && envParsed > 0) {
            liveMaxNotionalUsdtFinal = Math.min(10_000, envParsed);
        }
    }
    const liveMaxNotionalKrwFinal = liveMaxNotionalUsdtFinal > 0 ? liveMaxNotionalUsdtFinal * 1400 : null;
    const appliedLeverage = 10;
    const leverageSource = "v2_fixed";
    const leverageReason = "v2_fixed_10x";
    const liveMaxStageMarginKrwCap = liveMaxNotionalKrwFinal != null ? Math.floor(liveMaxNotionalKrwFinal / appliedLeverage) : null;

    const isMicroProbe =
        promotionReason === "V2_RANGE_MID_MICRO_PROBE_CONFIRMED" ||
        promotionReason === "V2_PROBE_ENTRY_CONFIRMED" ||
        promotionReason === "V2_WAIT_RECHECK_QUALIFIED_PROMOTION" ||
        promotionReason === "SHOCK_REACTION_DOWN_MID_MOMENTUM_CONFIRMED" ||
        promotionReason === "V2_TRANSITION_WATCH_SHORT_PROBE" ||
        promotionReason === "V2_UPPER_LONG_PROBE_PROMOTION" ||
        promotionReason === "V2_LOWER_LONG_REACTION_PROBE_PROMOTION" ||
        promotionReason === "V2_UPPER_SHORT_REACTION_PROBE_PROMOTION";

    if (finalDecision === "ENTER") {
        riskSizing.appliedLeverage = appliedLeverage;
        riskSizing.leverageReason = leverageReason;
        const envMissing = rawEnvLiveMaxNotionalUsdt == null || rawEnvLiveMaxNotionalUsdt.trim() === "";
        const envInvalid =
            !envMissing && (!Number.isFinite(envParsed) || envParsed <= 0);
        if (
            liveMaxNotionalUsdtFinal > 0 &&
            (!Number.isFinite(stateLiveMaxOrderNotionalUsdt) ||
                stateLiveMaxOrderNotionalUsdt !== liveMaxNotionalUsdtFinal)
        ) {
            console.info(JSON.stringify({
                event: "LIVE_MAX_NOTIONAL_STATE_MISMATCH_PROOF",
                symbol: String(input.symbol),
                raw_env_OKX_LIVE_MAX_ORDER_NOTIONAL_USDT: rawEnvLiveMaxNotionalUsdt,
                live_max_notional_usdt_final: liveMaxNotionalUsdtFinal,
                state_live_max_order_notional_usdt: Number.isFinite(v2State.liveMaxOrderNotionalUsdt)
                    ? v2State.liveMaxOrderNotionalUsdt
                    : null,
                promotion_reason: promotionReason,
                decision_before_promotion: v2DecisionBeforePromotion
            }));
        }
        if (envMissing || envInvalid) {
            min_order_check_passed = false;
            min_order_block_reason = envMissing
                ? "LIVE_MAX_NOTIONAL_CONFIG_MISSING"
                : "LIVE_MAX_NOTIONAL_CONFIG_INVALID";
            finalDecision = "REJECT";
            v2DecisionAfterPromotion = "REJECT";
            v2SideAfterPromotion = "none";
            riskSizing.isBlocked = true;
            riskSizing.blockReason = min_order_block_reason;
            riskSizing.stageMarginKrw = 0;
            stageMarginKrwAfter = 0;
            blockReason = min_order_block_reason;
        }

        if (finalDecision === "ENTER" && isMicroProbe) {
            const maxProbeMarginKrw = liveMaxStageMarginKrwCap != null ? Math.min(35000, liveMaxStageMarginKrwCap) : 35000;
            if (stageMarginKrwAfter < minProbeMarginKrw) {
                stageMarginKrwAfter = minProbeMarginKrw;
            }
            if (stageMarginKrwAfter > maxProbeMarginKrw) {
                stageMarginKrwAfter = maxProbeMarginKrw;
                cap_applied = true;
                cap_reason = "MICRO_PROBE_CAP";
                cap_kind = "probe_margin_cap";
            }

            let reductionMultiplier = 1.0;
            if (!sideZoneValid) reductionMultiplier *= 0.8;
            if (!rangeEdgeExtreme && activeEngineRouting === "RANGE") reductionMultiplier *= 0.9;
            if (!reversalConfirmed && shock !== "NONE") reductionMultiplier *= 0.85;

            if (reductionMultiplier < 1.0) {
                stageMarginKrwAfter = Math.round(stageMarginKrwAfter * reductionMultiplier);
                if (stageMarginKrwAfter < minProbeMarginKrw) stageMarginKrwAfter = minProbeMarginKrw;
            }
        }

        // live max cap ?꾩뿭 ?곸슜
        if (finalDecision === "ENTER" && liveMaxStageMarginKrwCap != null && stageMarginKrwAfter > liveMaxStageMarginKrwCap) {
            stageMarginKrwAfter = liveMaxStageMarginKrwCap;
            cap_applied = true;
            cap_reason = cap_reason ?? "LIVE_MAX_ORDER_NOTIONAL_CAP";
            cap_kind = "live_max_notional_margin_cap_at_fixed_10x";
        }

        // 理쒖냼 二쇰Ц underflow 泥섎━
        if (finalDecision === "ENTER" && stageMarginKrwAfter < minProbeMarginKrw) {
            min_order_check_passed = false;
            if (liveMaxNotionalUsdtFinal > 0 && liveMaxNotionalUsdtFinal < minNotionalUsdtRequiredAtFixed10x) {
                min_order_block_reason = "LIVE_MAX_NOTIONAL_UNDER_MIN_PROBE";
            } else {
                min_order_block_reason = "MIN_ORDER_SIZE_UNDERFLOW";
            }

            finalDecision = "REJECT";
            v2DecisionAfterPromotion = "REJECT";
            v2SideAfterPromotion = "none";
            riskSizing.isBlocked = true;
            riskSizing.blockReason = min_order_block_reason;
            riskSizing.stageMarginKrw = 0;
            stageMarginKrwAfter = 0;
            blockReason = min_order_block_reason;
        } else if (finalDecision === "ENTER") {
            riskSizing.stageMarginKrw = stageMarginKrwAfter;
        }
    }

    // Tier 5.6: Mandatory Risk Plan Audit (STOP_PRICE_MISSING Hard Block)
    if (finalDecision === "ENTER") {
        const structuralStopPx = execution.stopPrice;
        const structuralInvalidationPx = execution.invalidationPx;
        const lastPrice = authoritativeInput.snapshot.lastPrice ?? 0;
        const sideFinal = v2SideAfterPromotion;

        let riskAuditFailed = false;
        let riskAuditReason: string | null = null;

        if (structuralStopPx == null || structuralInvalidationPx == null || isNaN(structuralStopPx) || isNaN(structuralInvalidationPx)) {
            riskAuditFailed = true;
            riskAuditReason = "STOP_PRICE_MISSING";
        } else {
            // Directional Safety Check
            if (sideFinal === "long" && (structuralInvalidationPx >= lastPrice || (structuralStopPx >= lastPrice && Math.abs(structuralStopPx - lastPrice) > 0.00000001))) {
                riskAuditFailed = true;
                riskAuditReason = "LONG_INVALIDATION_ABOVE_ENTRY";
            } else if (sideFinal === "short" && (structuralInvalidationPx <= lastPrice || (structuralStopPx <= lastPrice && Math.abs(structuralStopPx - lastPrice) > 0.00000001))) {
                riskAuditFailed = true;
                riskAuditReason = "SHORT_INVALIDATION_BELOW_ENTRY";
            }
        }

        if (riskAuditFailed) {
            console.error(JSON.stringify({
                event: "V2_ENTRY_PLAN_RISK_PROOF",
                symbol: String(input.symbol),
                side: sideFinal,
                lastPrice,
                stopPrice: structuralStopPx,
                invalidationPx: structuralInvalidationPx,
                audit_passed: false,
                fail_reason: riskAuditReason,
                action: "HARD_BLOCK_ENTRY"
            }));

            finalDecision = "REJECT";
            v2DecisionAfterPromotion = "REJECT";
            v2SideAfterPromotion = "none";
            blockReason = riskAuditReason;
            stageMarginKrwAfter = 0;
            expectedMissingCondition = riskAuditReason;
            expectedNextAction = "FIX_EXECUTOR_RISK_PLAN";
        } else {
             console.info(JSON.stringify({
                event: "V2_ENTRY_PLAN_RISK_PROOF",
                symbol: String(input.symbol),
                side: sideFinal,
                lastPrice,
                stopPrice: structuralStopPx,
                invalidationPx: structuralInvalidationPx,
                audit_passed: true,
                action: "ALLOW_ENTRY"
            }));
        }
    }

    if (!riskSizing.diagnostics) {
        (riskSizing as { diagnostics?: import("./types").RiskSizingDiagnostics }).diagnostics = {};
    }

    // 理쒖쥌 諛섏쁺??decision怨?margin??authority envelope??李몄“?섎룄濡?diagnostics 媛깆떊
    riskSizing.diagnostics!.original_v2_decision = finalDecision;
    riskSizing.diagnostics!.original_v2_side = v2SideAfterPromotion != null ? String(v2SideAfterPromotion) : undefined;
    riskSizing.diagnostics!.original_stage_margin_krw = stageMarginKrwAfter;

    if (promotionApplied || min_order_block_reason != null) {
        console.info(JSON.stringify({
            event: "V2_PROMOTION_STATE_COMMIT_PROOF",
            symbol: String(input.symbol),
            decision_before: v2DecisionBeforePromotion,
            side_before: v2SideBeforePromotion,
            decision_after: finalDecision,
            side_after: v2SideAfterPromotion,
            block_reason: blockReason,
            stage_margin_krw_after: stageMarginKrwAfter,
            is_micro_probe: isMicroProbe,
            promotion_reason: promotionReason,
            raw_env_OKX_LIVE_MAX_ORDER_NOTIONAL_USDT: rawEnvLiveMaxNotionalUsdt,
            live_max_notional_source: liveMaxNotionalSource,
            state_live_max_order_notional_usdt: Number.isFinite(stateLiveMaxOrderNotionalUsdt)
                ? stateLiveMaxOrderNotionalUsdt
                : null,
            live_max_notional_usdt: liveMaxNotionalUsdtFinal,
            live_max_notional_krw: liveMaxNotionalKrwFinal,
            live_max_notional_usdt_final: liveMaxNotionalUsdtFinal,
            live_max_notional_krw_final: liveMaxNotionalKrwFinal,
            applied_leverage: appliedLeverage,
            leverage_source: leverageSource,
            leverage_reason: leverageReason,
            cap_kind,
            min_margin_krw_required: minProbeMarginKrw,
            min_notional_usdt_required_at_fixed_10x: minNotionalUsdtRequiredAtFixed10x,
            cap_applied,
            cap_reason,
            min_order_check_passed,
            min_order_block_reason
        }));
    }

    if (finalDecision === "ENTER" || min_order_block_reason != null) {
        console.info(JSON.stringify({
            event: "LIVE_ORDER_SIZE_PROOF",
            symbol: String(input.symbol),
            decision: finalDecision,
            side: v2SideAfterPromotion,
            promotion_reason: promotionReason,
            stage_margin_krw_before: stageMarginKrwBefore,
            stage_margin_krw_after: stageMarginKrwAfter,
            is_micro_probe: isMicroProbe,
            raw_env_OKX_LIVE_MAX_ORDER_NOTIONAL_USDT: rawEnvLiveMaxNotionalUsdt,
            live_max_notional_source: liveMaxNotionalSource,
            state_live_max_order_notional_usdt: Number.isFinite(stateLiveMaxOrderNotionalUsdt)
                ? stateLiveMaxOrderNotionalUsdt
                : null,
            live_max_notional_usdt: liveMaxNotionalUsdtFinal,
            live_max_notional_krw: liveMaxNotionalKrwFinal,
            live_max_notional_usdt_final: liveMaxNotionalUsdtFinal,
            live_max_notional_krw_final: liveMaxNotionalKrwFinal,
            applied_leverage: appliedLeverage,
            leverage_source: leverageSource,
            leverage_reason: leverageReason,
            cap_kind,
            min_margin_krw_required: minProbeMarginKrw,
            min_notional_usdt_required_at_fixed_10x: minNotionalUsdtRequiredAtFixed10x,
            cap_applied,
            cap_reason,
            min_order_check_passed,
            min_order_block_reason,
            side_zone_valid: sideZoneValid,
            range_edge_extreme: rangeEdgeExtreme,
            reversal_confirmed: reversalConfirmed
        }));
        if (promotionReason === "V2_RANGE_MID_MICRO_PROBE_CONFIRMED") {
            console.info(JSON.stringify({
                event: "V2_RANGE_MID_MICRO_PROBE_PROOF",
                symbol: String(input.symbol),
                market_subtype: judgment.subtype,
                rangeConfidence,
                boxPos,
                zone,
                trendSideCandidate,
                qualityScore,
                trendOk,
                paperExecutionReady,
                signedExecutionReady,
                hardBlockPresent,
                hardControlClear,
                decision_before: v2DecisionBeforePromotion,
                decision_after: finalDecision,
                side_after: v2SideAfterPromotion,
                stageMarginKrwBefore: riskSizing.stageMarginKrw,
                stageMarginKrwAfter: stageMarginKrwAfter,
                promotionReason
            }));
        }

        if (promotionReason === "V2_PROBE_ENTRY_CONFIRM_PROOF" || promotionReason === "V2_PROBE_ENTRY_CONFIRMED") {
            console.info(JSON.stringify({
                event: "V2_PROBE_ENTRY_CONFIRM_PROOF",
                symbol: String(input.symbol),
                shock,
                trendSideCandidate,
                decision_before: v2DecisionBeforePromotion,
                decision_after: finalDecision,
                side_after: v2SideAfterPromotion,
                qualityScore,
                trendOk,
                emaGap,
                trendWeaknessScore,
                paperExecutionReady,
                signedExecutionReady,
                hardBlockPresent,
                hardControlClear,
                stageMarginKrwBefore: riskSizing.stageMarginKrw,
                stageMarginKrwAfter: stageMarginKrwAfter,
                promotionReason
            }));
        }
    }

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

    const sameSidePosition_latest =
        v2SideAfterPromotion === "long" ? v2State.longPosition
            : v2SideAfterPromotion === "short" ? v2State.shortPosition
                : null;
    const heldPosition = v2State.longPosition ?? v2State.shortPosition ?? null;
    const lifecyclePosition_latest = sameSidePosition_latest ?? heldPosition;
    const lifecycleSide: EngineV2Side =
        lifecyclePosition_latest != null
            ? (lifecyclePosition_latest.side === "LONG" ? "long" : "short")
            : (v2SideAfterPromotion !== "none" && v2SideAfterPromotion != null)
                ? v2SideAfterPromotion
                : "none";
    const hasLifecycleCandidate =
        lifecyclePosition_latest != null ||
        finalDecision === "ENTER" ||
        riskSizing.blockReason != null;

    if (lifecyclePosition_latest != null) {
        const currentPnlPct = lifecyclePosition_latest.pnlPct;
        const currentPnlUsd = lifecyclePosition_latest.sizeUsd * currentPnlPct;
        const oldPeakPct = lifecyclePosition_latest.peakUnrealizedPnlPct ?? -Infinity;
        const isNewPeak = currentPnlPct > oldPeakPct || lifecyclePosition_latest.peakUnrealizedPnlPct == null;

        if (isNewPeak) {
            lifecyclePosition_latest.peakUnrealizedPnlPct = currentPnlPct;
            lifecyclePosition_latest.peakUnrealizedPnlUsd = currentPnlUsd;
            lifecyclePosition_latest.peakPnlUpdatedAt = Date.now();
        }

        if (shouldEmitV2Proof("V2_TREND_PEAK_PNL_TRACK_PROOF", String(input.symbol), `${lifecyclePosition_latest.peakUnrealizedPnlPct}|${isNewPeak}`, false)) {
            console.info(JSON.stringify({
                event: "V2_TREND_PEAK_PNL_TRACK_PROOF",
                symbol: String(input.symbol),
                side: lifecyclePosition_latest.side,
                current_pnl_pct: currentPnlPct,
                peak_pnl_pct: lifecyclePosition_latest.peakUnrealizedPnlPct,
                peak_pnl_usd: lifecyclePosition_latest.peakUnrealizedPnlUsd,
                updated: isNewPeak
            }));
        }
    }

    if (hasLifecycleCandidate) {
        const cooldownReasonRaw = (riskSizing.diagnostics as Record<string, unknown> | undefined)?.risk_cooldown_subreason;
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
            position: lifecyclePosition_latest,
            unrealizedPnl: lifecyclePosition_latest != null ? lifecyclePosition_latest.sizeUsd * lifecyclePosition_latest.pnlPct : null,
            unrealizedPnlPct: lifecyclePosition_latest?.pnlPct ?? null,
            holdMs: null,
            entryPrice: lifecyclePosition_latest?.entryPrice ?? null,
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
                boxPos: input.snapshot.boxPos ?? null,
                subtype: judgment.subtype,
                boxHigh: input.snapshot.boxHigh ?? undefined,
                boxLow: input.snapshot.boxLow ?? undefined,
                boxHighSlope: input.snapshot.boxHighSlope,
                boxLowSlope: input.snapshot.boxLowSlope,
                swingHighSlope: input.snapshot.swingHighSlope,
                swingLowSlope: input.snapshot.swingLowSlope,
                ema20: input.snapshot.ema20 ?? undefined,
                ema20Slope: input.snapshot.ema20Slope,
                atrExpansion: input.snapshot.atrExpansion,
                volumeExpansion: input.snapshot.volumeExpansion,
                breakoutFailureRate: input.snapshot.breakoutFailureRate
            },
            atr: input.snapshot.atr,
            currentStopPrice: lifecyclePosition_latest?.ledger_stop_px ?? undefined,
            accountEquityUsd: v2State.accountEquityKrw / 1400,
            currentSymbolNotionalUsd: v2State.symbolLedgerExposureNotionalKrw / 1400,
            currentGlobalNotionalUsd: v2State.ledgerExposureNotionalKrw / 1400,
            liveMaxOrderNotionalUsdt: v2State.liveMaxOrderNotionalUsdt,
            finalAddonNotionalUsdt: finalAddonNotionalUsdt,
            peakUnrealizedPnlPct: lifecyclePosition_latest?.peakUnrealizedPnlPct,
            peakUnrealizedPnlUsd: lifecyclePosition_latest?.peakUnrealizedPnlUsd,
            peakPnlUpdatedAt: lifecyclePosition_latest?.peakPnlUpdatedAt,
            takeProfitPlan: lifecyclePosition_latest?.takeProfitPlan,
            tp1Triggered: lifecyclePosition_latest?.tp1Triggered,
            tp2Triggered: lifecyclePosition_latest?.tp2Triggered,
            suggestedStopPrice: execution.stopPrice,
            suggestedInvalidationPx: execution.invalidationPx
        });

        if (lifecycleAuthority.tp1Triggered && lifecyclePosition_latest) {
            lifecyclePosition_latest.tp1Triggered = true;
        }
        if (lifecycleAuthority.tp2Triggered && lifecyclePosition_latest) {
            lifecyclePosition_latest.tp2Triggered = true;
        }

        // Bridge back to v2ExitAuthority and v2PartialAuthority if managed by V2
        if (lifecycleAuthority.exitManagedByV2 && lifecycleAuthority.exitAction === "exit") {
            v2ExitAuthority = {
                ...v2ExitAuthority,
                exitAction: "exit",
                shouldExit: true,
                exitReason: lifecycleAuthority.exitReason || v2ExitAuthority.exitReason,
                exitUrgency: "medium"
            };
        }
        if (lifecycleAuthority.partialManagedByV2 && lifecycleAuthority.partialAction === "reduce") {
            v2PartialAuthority = {
                ...v2PartialAuthority,
                partialAction: "protect_profit",
                shouldPartial: true,
                partialReason: lifecycleAuthority.partialReason || v2PartialAuthority.partialReason,
                reduceRatio: lifecycleAuthority.reduceRatio || v2PartialAuthority.reduceRatio
            };
        }

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
                position_id: lifecyclePosition_latest != null
                    ? `${String(input.symbol)}:${lifecyclePosition_latest.side}:${lifecyclePosition_latest.entryStage}`
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
                proof_reasons: lifecycleAuthority.proofReasons,
                giveback_pct: lifecycleAuthority.givebackPct,
                guard_threshold_pct: lifecycleAuthority.guardThresholdPct,
                guard_action: lifecycleAuthority.guardAction
            }));
        }

        // --- V2 Position State Authority (Step 4) ---
        const hasPosition = lifecyclePosition_latest != null;
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
            const pct = lifecyclePosition_latest?.pnlPct ?? 0;
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
            positionStage: lifecyclePosition_latest?.entryStage ?? null,
            holdMs: null,
            pnlState,
            unrealizedPnlKrw: null,
            unrealizedPnlUsdEstimate: lifecyclePosition_latest != null ? lifecyclePosition_latest.sizeUsd * lifecyclePosition_latest.pnlPct : null,
            unrealizedPnlPct: lifecyclePosition_latest?.pnlPct ?? null,
            peakUnrealizedPnlPct: lifecyclePosition_latest?.peakUnrealizedPnlPct ?? null,
            peakUnrealizedPnlUsd: lifecyclePosition_latest?.peakUnrealizedPnlUsd ?? null,
            givebackPct: lifecycleAuthority.givebackPct ?? null,
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
                unrealized_pnl_usd_estimate: v2PositionStateAuthority.unrealizedPnlUsdEstimate,
                unrealized_pnl_pct: lifecyclePosition_latest?.pnlPct ?? null,
                peak_pnl_pct: v2PositionStateAuthority.peakUnrealizedPnlPct,
                peak_pnl_usd: v2PositionStateAuthority.peakUnrealizedPnlUsd,
                giveback_pct: v2PositionStateAuthority.givebackPct,
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
        range_zone_lower_extreme: rangeZoneLowerExtreme(boxPos),
        range_zone_upper_extreme: rangeZoneUpperExtreme(boxPos),
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

    // Tier 6: Unify diagnostic suppression reasons for audit-ready transparency
    const whipsawBlocking = judgment.subtype === "WHIPSAW_SHOCK_RECHECK";
    const auditRawMissingCondition = promotionBlockReason || v2RejectReasonAfterPromotion || expectedMissingCondition || (finalDecision === "SKIP" ? "MIN_QUALITY_NOT_MET" : "NONE");
    
    // Priority Logic for primary_missing_condition (Requirement 2 & 3 & 4)
    const htfPolarityMismatchReason = (judgment.htf_policy_reason || "").includes("POLARITY_MISMATCH") ? judgment.htf_policy_reason : null;
    
    // Requirement 4: Shock/Retest/Reclaim check
    const isShockRetestBlock =
        judgment.subtype === "WHIPSAW_SHOCK_RECHECK" ||
        sideVetoDetail === "WHIPSAW_SHOCK_RECHECK_ACTIVE" ||
        sideVetoDetail === "SHOCK_UP_RECLAIM_NOT_CONFIRMED" ||
        sideVetoDetail === "SHOCK_UP_MID_RETEST_REQUIRED" ||
        sideVetoDetail === "SHOCK_DOWN_MID_RETEST_REQUIRED" ||
        sideVetoDetail === "SHOCK_DOWN_BREAKDOWN_RETEST_NOT_CONFIRMED" ||
        shockReactionBlockReason === "SHOCK_REACTION_WATCH_MID_CHASE_BLOCKED" ||
        shockReactionBlockReason === "SHOCK_REACTION_SETUP_NOT_READY_UP" ||
        sideVetoDetail === "SHOCK_REACTION_UP_RETEST_NOT_CONFIRMED" ||
        sideVetoDetail === "SHOCK_REACTION_DOWN_RETEST_NOT_CONFIRMED";

    const shockRetestReason = isShockRetestBlock ? (sideVetoDetail || shockReactionBlockReason) : null;

    // Requirement 3: Handle SIGNED_EXECUTION_NOT_READY priority
    const signedReadyBlocked = (finalDecision === "REJECT" || finalDecision === "HOLD") && hardBlockReason === "SIGNED_EXECUTION_NOT_READY";

    let primaryMissingCondition =
        (whipsawBlocking ? "WHIPSAW_RECHECK_NOT_CONFIRMED" : null) ||
        (signedReadyBlocked ? "SIGNED_EXECUTION_NOT_READY" : null) ||
        (hardBlockReason ? hardBlockReason : null) ||
        htfPolarityMismatchReason ||
        shockRetestReason ||
        auditRawMissingCondition;

    // Force alignment for shock/retest cases (Requirement 4)
    if (isShockRetestBlock && !signedReadyBlocked && !hardBlockReason) {
        primaryMissingCondition = shockRetestReason || primaryMissingCondition;
    }

    const secondaryMissingCondition =
        auditRawMissingCondition && auditRawMissingCondition !== primaryMissingCondition
            ? auditRawMissingCondition
            : null;

    const dashboardMissingCondition = primaryMissingCondition;
    let dashboardNextAction = expectedNextAction || (finalDecision === "SKIP" ? "WAIT_FOR_STRUCTURAL_REVERSAL_OR_RETEST" : "EXECUTE_V2_AUTHORITY");

    if (whipsawBlocking) {
        dashboardNextAction = "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION";
    }

    // Requirement 3 & 4: align expected_next_action
    if (primaryMissingCondition === "SIGNED_EXECUTION_NOT_READY") {
        dashboardNextAction = "WAIT_FOR_SIGNED_EXECUTION_READY";
    } else if (primaryMissingCondition && (primaryMissingCondition.includes("POLARITY_MISMATCH") || primaryMissingCondition.includes("HTF_BIAS_MISMATCH"))) {
        dashboardNextAction = "WAIT_FOR_HTF_POLARITY_ALIGNMENT";
    } else if (isShockRetestBlock) {
        dashboardNextAction = "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION";
    } else if (sideVetoDetail === "SHOCK_DOWN_TREND_CONFIRMATION_WEAK") {
        dashboardNextAction = "WAIT_FOR_TREND_CONFIRMATION";
    }

    // Requirement 5: If primary is retest/shock/hard-block, do not overwrite WAIT_FOR_QUALITY_IMPROVEMENT
    if (dashboardNextAction === "WAIT_FOR_QUALITY_IMPROVEMENT" && (isShockRetestBlock || hardBlockReason || htfPolarityMismatchReason)) {
        // Keep the more specific wait state if it was already set
        if (isShockRetestBlock) dashboardNextAction = "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION";
        else if (hardBlockReason) dashboardNextAction = "WAIT_FOR_STRUCTURAL_REVERSAL_OR_RETEST"; // Fallback for general hard block
    }

    const displayRetestRequired =
        isShockRetestBlock ||
        primaryMissingCondition === "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED" ||
        primaryMissingCondition === "TREND_PROMOTION_BLOCKED_BREAKDOWN_RETEST_NOT_CONFIRMED" ||
        primaryMissingCondition === "TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKOUT_CONFIRMED" ||
        primaryMissingCondition === "TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKDOWN_CONFIRMED" ||
        (execMeta as any).retest_required === true;

    const displaySupportRecheckRequired =
        sideVetoDetail === "SHOCK_UP_RECLAIM_NOT_CONFIRMED" ||
        primaryMissingCondition === "TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED" ||
        (execMeta as any).support_recheck_required === true ||
        (isShockRetestBlock && sideVetoDetail?.includes("SHOCK_UP"));

    // Requirement 7: decision이 ENTER가 아니면 최종 실행 side는 none으로 정규화
    const normalizedV2Side = finalDecision === "ENTER" ? v2SideAfterPromotion : "none";

    const decision: EngineV2Decision = {
        symbol: input.symbol,
        ts: input.now,
        regime: judgment.regime,
        confidence: confidence.level,
        confidenceScore: confidence.score,
        signal: execution.signal,
        side: normalizedV2Side as any,
        decision: finalDecision,
        risk: {
            ...riskSizing,
            isBlocked: hardBlockPresent,
            blockReason: hardBlockReason,
            stageMarginKrw: finalDecision === "ENTER" ? stageMarginKrwAfter : 0,
            exposureNotionalKrw: (finalDecision === "ENTER" ? stageMarginKrwAfter : 0) * riskSizing.appliedLeverage
        },
        explanation: {
            reason: finalReason,
            uiLabelRegime: judgment.subtype === "WHIPSAW_SHOCK_RECHECK" ? "WHIPSAW" : judgment.regime,
            uiLabelStatus: explanation.uiLabels.status
        },
        microExecution: microExecution ?? undefined,
        lifecycleAuthority: lifecycleAuthority ?? undefined,
        metadata: {
            ...execMeta,
            alignedSignal,
            selectedSideAfterVeto: selectedSideFinal,
            promotionApplied,
            promotionReason,
            promotionBlockReason,
            shockReactionBlockReason,
            qualityScore,
            v2DecisionFinal: finalDecision,
            v2SideFinal: normalizedV2Side,
            rangeSideCandidate,
            trendSideCandidate,
            reversalConfirmed,
            sideZoneValid,
            invalidationPx: v2CalculatedInvalidationPx ?? execMeta.invalidationPx ?? undefined,
            expectedMissingCondition: dashboardMissingCondition,
            expectedNextAction: dashboardNextAction,
            primary_missing_condition: primaryMissingCondition,
            secondary_missing_condition: secondaryMissingCondition,
            raw_missing_condition: primaryMissingCondition,
            retest_required: displayRetestRequired,
            reclaim_required: displaySupportRecheckRequired,
            display_retest_required: displayRetestRequired,
            display_support_recheck_required: displaySupportRecheckRequired,
            side_veto_detail: sideVetoDetail,
            macro_source: judgment.macro_source ?? "data_not_ready",
            daily_bias_actual: judgment.daily_bias_actual ?? "DATA_NOT_READY",
            h4_bias_actual: judgment.h4_bias_actual ?? "DATA_NOT_READY",
            h1_bias_actual: judgment.h1_bias_actual ?? "DATA_NOT_READY",
            m15_bias_actual: judgment.m15_bias_actual ?? "DATA_NOT_READY",
            m5_bias_actual: judgment.m5_bias_actual ?? "DATA_NOT_READY",
            htf_bias: judgment.htf_bias ?? { m5: "DATA_NOT_READY", m15: "DATA_NOT_READY", h1: "DATA_NOT_READY", h4: "DATA_NOT_READY", d1: "DATA_NOT_READY" },
            htf_entry_policy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
            htf_policy_reason: judgment.htf_policy_reason ?? "HTF_DATA_NOT_READY",
            htf_hard_block_reason: judgment.htf_hard_block_reason ?? null,
            counter_trend_risk: judgment.counter_trend_risk ?? false,
            htf_size_multiplier: judgment.htf_size_multiplier ?? 1.0,
            htf_requires_stronger_confirmation: judgment.htf_requires_stronger_confirmation ?? false,
            macro_polarity: judgment.macroPolarity ?? "NEUTRAL",
            polarity_mismatch: judgment.polarityMismatch ?? false,
            trend_ok: trendOk
        },
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

    // Audit Coverage for all suppression paths
    if (finalDecision !== "ENTER") {
        console.info(JSON.stringify({
            event: "V2_NO_ENTER_PATH_AUDIT_PROOF",
            symbol: String(input.symbol),
            final_decision: finalDecision,
            regime: judgment.regime,
            subtype: judgment.subtype,
            side_candidate: v2SideAfterPromotion || v2SideBeforePromotion || "none",
            macro_polarity: judgment.macroPolarity ?? "NEUTRAL",
            htf_policy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
            polarity_mismatch: judgment.polarityMismatch ?? false,
            promotion_applied: promotionApplied,
            promotion_reason: promotionReason,
            promotion_block_reason: promotionBlockReason,
            primary_missing_condition: primaryMissingCondition,
            secondary_missing_condition: secondaryMissingCondition,
            expected_missing_condition: dashboardMissingCondition,
            raw_missing_condition: primaryMissingCondition,
            expected_next_action: dashboardNextAction,
            htf_policy_reason: judgment.htf_policy_reason ?? "HTF_DATA_NOT_READY",
            macro_source: judgment.macro_source ?? "data_not_ready",
            side_veto_detail: sideVetoDetail,
            shock_reaction_block_reason: shockReactionBlockReason,
            quality_score: qualityScore,
            counter_trend_risk: judgment.counter_trend_risk ?? false,
            trend_ok: trendOk
        }));
    }


    console.info(JSON.stringify({
        event: "V2_ENTRY_EXECUTION_BRIDGE_PROOF",
        symbol: String(input.symbol),
        final_decision: decision.decision,
        final_side: decision.side,
        final_signal: decision.signal,
        stage_margin_krw: decision.risk.stageMarginKrw,
        applied_leverage: decision.risk.appliedLeverage,
        exposure_notional_krw: decision.risk.exposureNotionalKrw,
        stop_price: decision.lifecycleAuthority?.newStopPrice ?? null,
        risk_blocked: decision.risk.isBlocked,
        risk_block_reason: decision.risk.blockReason,
        promotion_reason: promotionReason,
        judgment_subtype: judgment.subtype
    }));

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
        finalAddonNotionalUsdt?: number;
        addonMaxNotionalUsdt?: number;
        riskMode?: string | null;
        dailyLossGuardTriggered?: boolean;
        crashState?: string | null;
        pumpState?: string | null;
        pump_state?: string | null;
    },
    v1Result: LegacyResultAdapter,
    recentCandles?: import("../models/types").Candle[]
): EngineV2Input {
    const htfCandlesRef = snapshot.htf_candles;
    return {
        symbol,
        now,
        htf_candles: htfCandlesRef,
        snapshot: {
            lastPrice: snapshot.lastPrice,
            latestCandleClose: snapshot.latestCandleClose,
            boxHigh: snapshot.boxHigh ?? 0,
            boxLow: snapshot.boxLow ?? 0,
            boxPos:
                typeof snapshot.boxPosDiag === "number" && Number.isFinite(snapshot.boxPosDiag)
                    ? snapshot.boxPosDiag
                    : 0.5,
            rangeConfidence: snapshot.rangeConfidenceDiag ?? 0,
            ema20: snapshot.ema20 ?? 0,
            emaGap: snapshot.emaGapDiag ?? 0,
            volatilityProxy: snapshot.volatilityProxyDiag ?? 0,
            boxCohesion01: snapshot.boxCohesion01 ?? snapshot.boxCohesionDiag ?? 0,
            breakoutFailureRate: snapshot.breakoutFailureRate ?? snapshot.breakoutFailureRateDiag ?? 0,
            trendWeaknessScore: snapshot.trendWeaknessScore ?? snapshot.trendWeaknessDiag ?? 0,
            rangeOscillationScore: snapshot.rangeOscillationScore ?? snapshot.rangeOscillationDiag ?? 0,
            reviewing_ticks: snapshot.reviewing_ticks ?? 0,
            regimeExitRisk: snapshot.regimeExitRisk ?? 0,
            boxBreakSide: snapshot.boxBreakSide ?? "none",
            signal: snapshot.signal ?? "NONE",
            qualityScore: snapshot.qualityScore ?? 0,
            data_ready: snapshot.data_ready ?? true,
            dump_protection_hit: snapshot.dump_protection_hit ?? false,
            volatility_guard_hit: snapshot.volatility_guard_hit ?? false,
            entryCandidate: snapshot.entryCandidate ?? false,
            signalGateBlockedReason: snapshot.signalGateBlockedReason ?? null,
            rangeSignalDowngraded: snapshot.rangeSignalDowngraded ?? false,
            rangeSignalKeptByRelax: snapshot.rangeSignalKeptByRelax ?? false,
            atr: snapshot.atr ?? snapshot.volatilityProxyDiag ?? 0,
            swingHighSlope: snapshot.swingHighSlope ?? 0,
            swingLowSlope: snapshot.swingLowSlope ?? 0,
            rangeCenterSlope: snapshot.rangeCenterSlope ?? 0,
            boxHighSlope: snapshot.boxHighSlope ?? 0,
            boxLowSlope: snapshot.boxLowSlope ?? 0,
            ema20Slope: snapshot.ema20Slope ?? 0,
            ema60Slope: snapshot.ema60Slope ?? 0,
            atrExpansion: snapshot.atrExpansion ?? 0,
            volumeExpansion: snapshot.volumeExpansion ?? 0,
            candles: recentCandles,
            htf_candles: htfCandlesRef
        },
        config: {
            paperMaxOpenPositions: config.paperMaxOpenPositions,
            paperReentryCooldownMs: config.paperReentryCooldownMs,
            baseSizeUsd: config.baseSizeUsd,
            okxLiveMaxOrderNotionalUsdt: config.okxLiveMaxOrderNotionalUsdt
        },
        state: {
            currentPositions: state.currentPositions.map((p: LegacyPositionAdapter) => ({
                symbol: p.symbol,
                side: p.side === "long" ? "LONG" : "SHORT" as const,
                entryPrice: p.entryPrice,
                sizeUsd: p.sizeUsd,
                entryStage: p.entryStage ?? 0,
                pnlPct: p.pnlPct ?? 0,
                ledger_stop_px: p.ledger_stop_px,
                peakUnrealizedPnlPct: p.peakUnrealizedPnlPct,
                peakUnrealizedPnlUsd: p.peakUnrealizedPnlUsd,
                peakPnlUpdatedAt: p.peakPnlUpdatedAt,
                takeProfitPlan: p.takeProfitPlan,
                tp1Triggered: p.tp1Triggered,
                tp2Triggered: p.tp2Triggered
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
            symbolExposureNotionalCapKrw: state.symbolExposureNotionalCapKrw,
            finalAddonNotionalUsdt: (state as any).finalAddonNotionalUsdt,
            addonMaxNotionalUsdt: (state as any).addonMaxNotionalUsdt
        },
        v1Result: {
            regime: v1Result.decision?.regime_state ?? "UNDEFINED",
            decision: v1Result.decision?.final_decision ?? "SKIP",
            side: v1Result.intentSide ?? "none",
            isBlocked: !!v1Result.decision?.reject_reason
        }
    };
}
