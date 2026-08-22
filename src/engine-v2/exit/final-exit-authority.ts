import { isExplicitTerminalExitReason, isNonTerminalExitReason } from "./exit-authority-invariant";

export type FinalExitAuthoritySource =
    | "V2_POLICY"
    | "LIFECYCLE"
    | "RISK"
    | "EXCHANGE_PROTECTIVE_FILL"
    | "MANUAL_EXTERNAL"
    | "NONE";

export type FinalExitAction = "HOLD" | "WATCH" | "PARTIAL_REDUCE" | "FULL_EXIT";

export type FinalExitAuthorityContext = Readonly<{
    symbol: string;
    side: "long" | "short" | "none";
    positionCycleId?: string | null;

    policyResult?: {
        action?: string | null;
        reason?: string | null;
        shouldExit?: boolean;
        shouldReduce?: boolean;
        shouldPartial?: boolean;
        reduceRatio?: number;
    } | null;

    lifecycleResult?: {
        exitAction?: string | null;
        exitReason?: string | null;
        partialAction?: string | null;
        partialReason?: string | null;
        reduceRatio?: number;
    } | null;

    riskResult?: {
        action?: string | null;
        reason?: string | null;
        shouldExit?: boolean;
    } | null;

    exchangeFillEvent?: {
        filledType?: "SL" | "TP" | "MANUAL" | "EXTERNAL" | "OTHER";
        fillReason?: string | null;
    } | null;

    manualExternalEvent?: {
        action?: "MANUAL_CLOSE" | "MANUAL_REDUCE" | "EXTERNAL_SYNC";
        reason?: string | null;
        reduceRatio?: number;
    } | null;

    timestamp?: number;
}>;

export type FinalExitAuthorityResult = Readonly<{
    action: FinalExitAction;
    shouldExit: boolean;
    shouldReduce: boolean;
    terminalReason: string | null;
    reduceReason: string | null;
    reduceRatio: number;
    authoritySource: FinalExitAuthoritySource;
    policyAction: string;
    policyReason: string | null;
    lifecycleAction: string;
    lifecycleReason: string | null;
    explicitTerminalEvidence: boolean;
    positionCycleId: string | null;
    symbol: string;
    side: "long" | "short" | "none";
    timestamp: number;
}>;

/**
 * Resolves the canonical Final Exit Authority for a position.
 * Disambiguates between HOLD, WATCH, PARTIAL_REDUCE, and FULL_EXIT across
 * Strategy Policy, Lifecycle, Risk Safety, Exchange Protective Fills, and Manual Operations.
 */
export function resolveFinalExitAuthority(
    context: FinalExitAuthorityContext
): FinalExitAuthorityResult {
    const ts = context.timestamp ?? Date.now();
    const sym = context.symbol;
    const side = context.side;
    const cycleId = context.positionCycleId ?? null;

    const policyActionRaw = String(context.policyResult?.action ?? "HOLD").toUpperCase();
    const policyReasonRaw = context.policyResult?.reason ?? null;

    const lifecycleActionRaw = String(context.lifecycleResult?.exitAction ?? "none").toLowerCase();
    const lifecycleReasonRaw = context.lifecycleResult?.exitReason ?? null;

    // 1. Priority: Manual / External Events
    if (context.manualExternalEvent) {
        const ev = context.manualExternalEvent;
        if (ev.action === "MANUAL_CLOSE") {
            return {
                action: "FULL_EXIT",
                shouldExit: true,
                shouldReduce: false,
                terminalReason: ev.reason || "MANUAL_USER_CLOSE",
                reduceReason: null,
                reduceRatio: 0,
                authoritySource: "MANUAL_EXTERNAL",
                policyAction: policyActionRaw,
                policyReason: policyReasonRaw,
                lifecycleAction: lifecycleActionRaw,
                lifecycleReason: lifecycleReasonRaw,
                explicitTerminalEvidence: true,
                positionCycleId: cycleId,
                symbol: sym,
                side,
                timestamp: ts
            };
        }
        if (ev.action === "MANUAL_REDUCE") {
            return {
                action: "PARTIAL_REDUCE",
                shouldExit: false,
                shouldReduce: true,
                terminalReason: null,
                reduceReason: ev.reason || "MANUAL_USER_REDUCE",
                reduceRatio: ev.reduceRatio ?? 0.5,
                authoritySource: "MANUAL_EXTERNAL",
                policyAction: policyActionRaw,
                policyReason: policyReasonRaw,
                lifecycleAction: lifecycleActionRaw,
                lifecycleReason: lifecycleReasonRaw,
                explicitTerminalEvidence: false,
                positionCycleId: cycleId,
                symbol: sym,
                side,
                timestamp: ts
            };
        }
    }

    // 2. Priority: Exchange-side Protective Fill Events (Authoritative execution truth)
    if (context.exchangeFillEvent) {
        const fill = context.exchangeFillEvent;
        const terminalReason =
            fill.fillReason ||
            (fill.filledType === "SL" ? "PROTECTIVE_SL_FILLED" : fill.filledType === "TP" ? "PROTECTIVE_TP_FILLED" : "EXCHANGE_CLOSE_FILLED");
        return {
            action: "FULL_EXIT",
            shouldExit: true,
            shouldReduce: false,
            terminalReason,
            reduceReason: null,
            reduceRatio: 0,
            authoritySource: "EXCHANGE_PROTECTIVE_FILL",
            policyAction: policyActionRaw,
            policyReason: policyReasonRaw,
            lifecycleAction: lifecycleActionRaw,
            lifecycleReason: lifecycleReasonRaw,
            explicitTerminalEvidence: true,
            positionCycleId: cycleId,
            symbol: sym,
            side,
            timestamp: ts
        };
    }

    // 3. Priority: Emergency / Risk Stop Protect
    if (context.riskResult?.shouldExit === true && isExplicitTerminalExitReason(context.riskResult.reason)) {
        return {
            action: "FULL_EXIT",
            shouldExit: true,
            shouldReduce: false,
            terminalReason: context.riskResult.reason!,
            reduceReason: null,
            reduceRatio: 0,
            authoritySource: "RISK",
            policyAction: policyActionRaw,
            policyReason: policyReasonRaw,
            lifecycleAction: lifecycleActionRaw,
            lifecycleReason: lifecycleReasonRaw,
            explicitTerminalEvidence: true,
            positionCycleId: cycleId,
            symbol: sym,
            side,
            timestamp: ts
        };
    }

    // 4. Lifecycle Terminal Transition
    if (lifecycleActionRaw === "exit" && isExplicitTerminalExitReason(lifecycleReasonRaw)) {
        return {
            action: "FULL_EXIT",
            shouldExit: true,
            shouldReduce: false,
            terminalReason: lifecycleReasonRaw!,
            reduceReason: null,
            reduceRatio: 0,
            authoritySource: "LIFECYCLE",
            policyAction: policyActionRaw,
            policyReason: policyReasonRaw,
            lifecycleAction: lifecycleActionRaw,
            lifecycleReason: lifecycleReasonRaw,
            explicitTerminalEvidence: true,
            positionCycleId: cycleId,
            symbol: sym,
            side,
            timestamp: ts
        };
    }

    // 5. Strategy Policy Full Exit
    const isPolicyFullExit =
        policyActionRaw === "FULL_EXIT" ||
        policyActionRaw === "EXIT" ||
        context.policyResult?.shouldExit === true;

    if (isPolicyFullExit) {
        // Enforce: Non-terminal reasons (e.g. TREND_HOLD_VALID, WATCH, etc.) CANNOT authorize FULL_EXIT
        if (isNonTerminalExitReason(policyReasonRaw) || !isExplicitTerminalExitReason(policyReasonRaw)) {
            // Fail Closed to HOLD / WATCH
            const fallbackAction: FinalExitAction = policyReasonRaw && String(policyReasonRaw).includes("WATCH") ? "WATCH" : "HOLD";
            return {
                action: fallbackAction,
                shouldExit: false,
                shouldReduce: false,
                terminalReason: null,
                reduceReason: null,
                reduceRatio: 0,
                authoritySource: "V2_POLICY",
                policyAction: policyActionRaw,
                policyReason: policyReasonRaw,
                lifecycleAction: lifecycleActionRaw,
                lifecycleReason: lifecycleReasonRaw,
                explicitTerminalEvidence: false,
                positionCycleId: cycleId,
                symbol: sym,
                side,
                timestamp: ts
            };
        }

        return {
            action: "FULL_EXIT",
            shouldExit: true,
            shouldReduce: false,
            terminalReason: policyReasonRaw!,
            reduceReason: null,
            reduceRatio: 0,
            authoritySource: "V2_POLICY",
            policyAction: policyActionRaw,
            policyReason: policyReasonRaw,
            lifecycleAction: lifecycleActionRaw,
            lifecycleReason: lifecycleReasonRaw,
            explicitTerminalEvidence: true,
            positionCycleId: cycleId,
            symbol: sym,
            side,
            timestamp: ts
        };
    }

    // 6. Partial Reduce (Strategy or Lifecycle)
    const isPolicyReduce =
        policyActionRaw === "REDUCE" ||
        policyActionRaw === "PARTIAL_REDUCE" ||
        policyActionRaw === "PARTIAL_TAKE_PROFIT" ||
        context.policyResult?.shouldReduce === true ||
        context.policyResult?.shouldPartial === true;

    const isLifecycleReduce =
        context.lifecycleResult?.partialAction === "reduce" ||
        context.lifecycleResult?.partialAction === "protect_profit";

    if (isPolicyReduce || isLifecycleReduce) {
        const reduceReason =
            context.policyResult?.reason ||
            context.lifecycleResult?.partialReason ||
            "PARTIAL_REDUCE_MANAGED";
        const reduceRatio =
            context.policyResult?.reduceRatio ??
            context.lifecycleResult?.reduceRatio ??
            0.5;

        return {
            action: "PARTIAL_REDUCE",
            shouldExit: false,
            shouldReduce: true,
            terminalReason: null,
            reduceReason,
            reduceRatio,
            authoritySource: isPolicyReduce ? "V2_POLICY" : "LIFECYCLE",
            policyAction: policyActionRaw,
            policyReason: policyReasonRaw,
            lifecycleAction: lifecycleActionRaw,
            lifecycleReason: lifecycleReasonRaw,
            explicitTerminalEvidence: false,
            positionCycleId: cycleId,
            symbol: sym,
            side,
            timestamp: ts
        };
    }

    // 7. Watch / Hold State
    const action: FinalExitAction =
        policyActionRaw === "WATCH" || (policyReasonRaw != null && String(policyReasonRaw).includes("WATCH"))
            ? "WATCH"
            : "HOLD";

    return {
        action,
        shouldExit: false,
        shouldReduce: false,
        terminalReason: null,
        reduceReason: null,
        reduceRatio: 0,
        authoritySource: "V2_POLICY",
        policyAction: policyActionRaw,
        policyReason: policyReasonRaw,
        lifecycleAction: lifecycleActionRaw,
        lifecycleReason: lifecycleReasonRaw,
        explicitTerminalEvidence: false,
        positionCycleId: cycleId,
        symbol: sym,
        side,
        timestamp: ts
    };
}

export function buildFinalExitAuthorityProof(
    result: FinalExitAuthorityResult,
    extra?: Record<string, unknown>
): Record<string, unknown> {
    return {
        event: "V2_FINAL_EXIT_AUTHORITY_PROOF",
        symbol: result.symbol,
        side: result.side,
        action: result.action,
        shouldExit: result.shouldExit,
        shouldReduce: result.shouldReduce,
        terminalReason: result.terminalReason,
        reduceReason: result.reduceReason,
        reduceRatio: result.reduceRatio,
        authoritySource: result.authoritySource,
        policyAction: result.policyAction,
        policyReason: result.policyReason,
        lifecycleAction: result.lifecycleAction,
        lifecycleReason: result.lifecycleReason,
        explicitTerminalEvidence: result.explicitTerminalEvidence,
        positionCycleId: result.positionCycleId,
        timestamp: result.timestamp,
        ...extra
    };
}
