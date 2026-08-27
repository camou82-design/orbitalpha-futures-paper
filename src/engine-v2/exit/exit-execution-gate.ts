export type ExitExecutionRequestedAction = "close" | "partial_close" | "reduce" | "hold";

export function evaluateV2ExitExecutionGate(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    requestedAction: ExitExecutionRequestedAction;
    requestedReason: string | null;
    isV2Managed: boolean;
    v2ShouldExit: boolean;
    v2ShouldReduce: boolean;
    v2ShouldPartial: boolean;
    actualStopBreached: boolean;
    actualPositionExists: boolean;
    isLiquidationEmergency?: boolean;
    manualTakeoverActive?: boolean;
}>): Readonly<{
    allowed: boolean;
    blockReason: string | null;
    effectiveAction: ExitExecutionRequestedAction;
}> {
    if (input.manualTakeoverActive === true) {
        return {
            allowed: false,
            blockReason: "MANUAL_TAKEOVER_ACTIVE",
            effectiveAction: "hold"
        };
    }

    if (!input.isV2Managed) {
        return {
            allowed: input.requestedAction !== "hold",
            blockReason: input.requestedAction === "hold" ? "hold_requested" : null,
            effectiveAction: input.requestedAction
        };
    }

    if (input.requestedAction === "hold") {
        return { allowed: false, blockReason: "hold_requested", effectiveAction: "hold" };
    }

    if (input.isLiquidationEmergency === true) {
        return { allowed: true, blockReason: null, effectiveAction: input.requestedAction };
    }

    if (!input.actualPositionExists) {
        return {
            allowed: false,
            blockReason: "no_actual_position_to_close",
            effectiveAction: "hold"
        };
    }

    if (input.requestedAction === "close") {
        if (input.v2ShouldExit) {
            return { allowed: true, blockReason: null, effectiveAction: "close" };
        }
        const stopReason =
            input.requestedReason === "stop_loss" ||
            (input.requestedReason != null && input.requestedReason.includes("stop_loss"));
        if (input.actualStopBreached && stopReason) {
            return { allowed: true, blockReason: null, effectiveAction: "close" };
        }
        return {
            allowed: false,
            blockReason: "v2_exit_sovereignty_hold",
            effectiveAction: "hold"
        };
    }

    if (input.requestedAction === "partial_close" || input.requestedAction === "reduce") {
        if (input.v2ShouldPartial || input.v2ShouldReduce) {
            return { allowed: true, blockReason: null, effectiveAction: input.requestedAction };
        }
        return {
            allowed: false,
            blockReason: "v2_partial_sovereignty_hold",
            effectiveAction: "hold"
        };
    }

    return {
        allowed: false,
        blockReason: "unsupported_exit_action",
        effectiveAction: "hold"
    };
}

export function buildV2ExitExecutionGateProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_EXIT_EXECUTION_GATE_PROOF", ...input };
}

export function inferExitExecutionRequestedAction(input: Readonly<{
    isPartial?: boolean;
    reason: string;
}>): ExitExecutionRequestedAction {
    if (input.isPartial === true) {
        return input.reason.includes("reduce") ? "reduce" : "partial_close";
    }
    return "close";
}
