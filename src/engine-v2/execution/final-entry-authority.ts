import type { PositionLifecycleTruthResult, PositionLifecycleState } from "../lifecycle/position-lifecycle-truth";
import type { TerminalReentryBarrierResult } from "../lifecycle/terminal-reentry-barrier";
import type { SameSideLossReentryGateResult } from "../state/loss-reentry-gate";
import type { PreEntryProtectionPlanResult } from "./pre-entry-protection-plan";

export type FinalEntryActionType = "NEW_ENTRY" | "ADDON" | "NONE";
export type FinalEntryEvaluationBoundary = "ENGINE" | "ENQUEUE" | "DEFER" | "CONSUME" | "PRE_SUBMIT";

export type FinalEntryTradeControls = Readonly<{
    serverTradeEnabled: boolean;
    closeOnlyMode: boolean;
    killSwitchActive: boolean;
    reconcileSafetyCloseOnly: boolean;
    paperExecutionReady: boolean;
    signedExecutionReady: boolean;
    riskModeHalt?: boolean;
    dailyLossGuardActive?: boolean;
    freshTickExecutionBlocked?: boolean;
}>;

export type FinalEntryAuthorityContext = Readonly<{
    symbol: string;
    requestedSide: "long" | "short" | string;
    authoritySource: string;
    adoptedEngine: string;
    strategyDecision: string;
    isScaleIn?: boolean;
    addOnAllowed?: boolean;

    lifecycleTruth: PositionLifecycleTruthResult;
    terminalBarrier: TerminalReentryBarrierResult;
    lossReentryGate: SameSideLossReentryGateResult;
    protectionPlan: PreEntryProtectionPlanResult;
    tradeControls: FinalEntryTradeControls;

    mutex: Readonly<{
        blocked: boolean;
        blockReason: string | null;
    }>;
    slotAvailable: boolean;
    minOrderOk: boolean;
    minOrderBlockReason?: string | null;

    evaluationBoundary?: FinalEntryEvaluationBoundary;
    timestamp?: number;
}>;

export type FinalEntryAuthorityResult = Readonly<{
    allowed: boolean;
    actionType: FinalEntryActionType;
    side: "long" | "short" | "none";
    reason: string;

    strategyEnterReady: boolean;
    lifecycleReady: boolean;
    lossReentryReady: boolean;
    protectionPlanReady: boolean;
    tradeControlReady: boolean;
    executionReady: boolean;

    authoritySource: string;
    lifecycleState: PositionLifecycleState;
    positionCycleId: string | null;
    evaluationBoundary: FinalEntryEvaluationBoundary;
    timestamp: number;
}>;

/**
 * Evaluates canonical Final Entry Authority for V2 trading.
 * Combines root strategy intent, canonical lifecycle state, terminal barrier,
 * same-side loss gate, pre-entry SL+TP plan, trade controls, and execution mutex.
 */
export function evaluateFinalEntryAuthority(
    context: FinalEntryAuthorityContext
): FinalEntryAuthorityResult {
    const boundary = context.evaluationBoundary ?? "CONSUME";
    const ts = context.timestamp ?? Date.now();
    const source = context.authoritySource;
    const isV2 = source === "v2" && context.adoptedEngine === "V2";
    const validSide = context.requestedSide === "long" || context.requestedSide === "short";
    const strategyEnterReady = isV2 && context.strategyDecision === "ENTER" && validSide;

    const side: "long" | "short" | "none" = validSide
        ? (context.requestedSide as "long" | "short")
        : "none";

    // 1. Determine Action Type: Strict distinction between NEW_ENTRY vs ADDON
    let actionType: FinalEntryActionType = "NONE";
    const isExistingPosition = context.isScaleIn === true || context.lifecycleTruth.lifecycleState === "OPEN";

    if (isExistingPosition) {
        if (context.addOnAllowed === true && strategyEnterReady) {
            actionType = "ADDON";
        } else {
            actionType = "NONE";
        }
    } else if (context.lifecycleTruth.lifecycleState === "TERMINAL") {
        actionType = strategyEnterReady ? "NEW_ENTRY" : "NONE";
    } else {
        actionType = "NONE";
    }

    // 2. Lifecycle & Barrier readiness
    let lifecycleReady = false;
    if (actionType === "NEW_ENTRY") {
        lifecycleReady = context.lifecycleTruth.lifecycleState === "TERMINAL" && !context.terminalBarrier.blocked;
    } else if (actionType === "ADDON") {
        lifecycleReady = context.lifecycleTruth.lifecycleState === "OPEN" && !context.terminalBarrier.blocked;
    }

    // 3. Loss Reentry Gate readiness
    const lossReentryReady = context.lossReentryGate.allowed === true;

    // 4. Pre-Entry SL+TP Protection Plan readiness
    const protectionPlanReady = context.protectionPlan.protectionPlanReady === true && !context.protectionPlan.entryBlocked;

    // 5. System Trade Controls readiness
    const tc = context.tradeControls;
    const tradeControlReady =
        tc.serverTradeEnabled === true &&
        tc.closeOnlyMode === false &&
        tc.killSwitchActive === false &&
        tc.reconcileSafetyCloseOnly === false &&
        tc.paperExecutionReady === true &&
        tc.signedExecutionReady === true &&
        !tc.riskModeHalt &&
        !tc.dailyLossGuardActive &&
        !tc.freshTickExecutionBlocked;

    // 6. Execution readiness (Mutex, slots, min order)
    const executionReady =
        tradeControlReady &&
        !context.mutex.blocked &&
        context.slotAvailable &&
        context.minOrderOk;

    // 7. Final authorization
    const allowed =
        strategyEnterReady &&
        lifecycleReady &&
        lossReentryReady &&
        protectionPlanReady &&
        executionReady &&
        (actionType === "NEW_ENTRY" || actionType === "ADDON");

    // 8. Canonical reason resolution
    let reason = "ENTRY_AUTHORITY_BLOCKED";
    if (allowed) {
        reason = actionType === "NEW_ENTRY" ? "NEW_ENTRY_ALLOWED" : "ADDON_ALLOWED";
    } else if (!strategyEnterReady) {
        if (context.strategyDecision !== "ENTER") reason = "STRATEGY_DECISION_NOT_ENTER";
        else if (!isV2) reason = "ADOPTED_ENGINE_NOT_V2";
        else if (!validSide) reason = "INVALID_REQUESTED_SIDE";
    } else if (!tc.serverTradeEnabled) reason = "SERVER_TRADE_DISABLED";
    else if (tc.killSwitchActive) reason = "KILL_SWITCH";
    else if (tc.closeOnlyMode) reason = "CLOSE_ONLY_MODE";
    else if (tc.reconcileSafetyCloseOnly) reason = "RECONCILE_SAFE_MODE";
    else if (!tc.paperExecutionReady) reason = "PAPER_EXECUTION_NOT_READY";
    else if (!tc.signedExecutionReady) reason = "SIGNED_EXECUTION_NOT_READY";
    else if (tc.riskModeHalt) reason = "RISK_MODE_HALT";
    else if (tc.dailyLossGuardActive) reason = "DAILY_LOSS_GUARD";
    else if (tc.freshTickExecutionBlocked) reason = "FRESH_TICK_EXECUTION_BLOCKED";
    else if (!lifecycleReady) {
        if (context.terminalBarrier.blocked) reason = context.terminalBarrier.reason;
        else if (isExistingPosition && context.addOnAllowed !== true) reason = "SYMBOL_SAME_SIDE_POSITION_ALREADY_OPEN";
        else reason = "LIFECYCLE_NOT_TERMINAL";
    } else if (!lossReentryReady) {
        reason = context.lossReentryGate.reason || "SAME_SIDE_LOSS_REENTRY_BLOCKED";
    } else if (!context.slotAvailable) {
        reason = "MAX_SLOTS_REACHED";
    } else if (context.mutex.blocked) {
        reason = context.mutex.blockReason || "MUTEX_BLOCKED";
    } else if (!context.minOrderOk) {
        reason = context.minOrderBlockReason || "MIN_ORDER_SIZE_UNDERFLOW";
    } else if (!protectionPlanReady) {
        reason = context.protectionPlan.blockReason || "PRE_ENTRY_PROTECTION_PLAN_BLOCKED";
    }

    return {
        allowed,
        actionType,
        side: allowed ? side : "none",
        reason,
        strategyEnterReady,
        lifecycleReady,
        lossReentryReady,
        protectionPlanReady,
        tradeControlReady,
        executionReady,
        authoritySource: source,
        lifecycleState: context.lifecycleTruth.lifecycleState,
        positionCycleId: context.lifecycleTruth.positionCycleId,
        evaluationBoundary: boundary,
        timestamp: ts
    };
}

export function buildFinalEntryAuthorityProof(
    result: FinalEntryAuthorityResult,
    extra?: Record<string, unknown>
): Record<string, unknown> {
    return {
        event: "V2_FINAL_ENTRY_AUTHORITY_PROOF",
        symbol: extra?.symbol ?? null,
        requestedSide: extra?.requestedSide ?? result.side,
        actionType: result.actionType,
        allowed: result.allowed,
        reason: result.reason,
        strategyEnterReady: result.strategyEnterReady,
        lifecycleState: result.lifecycleState,
        terminalBarrierReady: result.lifecycleReady,
        lossReentryReady: result.lossReentryReady,
        protectionPlanReady: result.protectionPlanReady,
        tradeControlReady: result.tradeControlReady,
        executionReady: result.executionReady,
        evaluationBoundary: result.evaluationBoundary,
        positionCycleId: result.positionCycleId,
        authoritySource: result.authoritySource,
        timestamp: result.timestamp,
        ...extra
    };
}
