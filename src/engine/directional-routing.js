"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveDirectionalRoutingOverride = deriveDirectionalRoutingOverride;
exports.evaluateDirectionalTrendEntryGuard = evaluateDirectionalTrendEntryGuard;
function signalToSide(signal) {
    if (signal === "paper_long_candidate")
        return "long";
    if (signal === "paper_short_candidate")
        return "short";
    return "none";
}
function deriveDirectionalRoutingOverride(input) {
    const { rawRegime, directionalShockState } = input;
    if (directionalShockState === "DOWN") {
        return {
            rawRegime,
            effectiveExecutionLane: "TREND",
            directionalBias: "short",
            directionalShockState,
            overrideApplied: rawRegime === "RANGE",
            overrideReason: rawRegime === "RANGE" ? "directional_shock_down_forces_trend_short" : null
        };
    }
    if (directionalShockState === "UP") {
        return {
            rawRegime,
            effectiveExecutionLane: "TREND",
            directionalBias: "long",
            directionalShockState,
            overrideApplied: rawRegime === "RANGE",
            overrideReason: rawRegime === "RANGE" ? "directional_shock_up_forces_trend_long" : null
        };
    }
    return {
        rawRegime,
        effectiveExecutionLane: rawRegime === "NO_TRADE" ? "IDLE" : rawRegime,
        directionalBias: "none",
        directionalShockState,
        overrideApplied: false,
        overrideReason: null
    };
}
function evaluateDirectionalTrendEntryGuard(input) {
    const override = deriveDirectionalRoutingOverride({
        rawRegime: input.rawRegime,
        directionalShockState: input.directionalShockState
    });
    const signalSide = signalToSide(input.signal);
    const preferredSide = input.rangeReversalImmediateSwitch?.preferredSide ?? null;
    const intendedSide = preferredSide ?? signalSide;
    const blocked = override.directionalBias !== "none" &&
        intendedSide !== "none" &&
        intendedSide !== override.directionalBias;
    return {
        blocked,
        blockedReason: blocked ? "DIRECTIONAL_BIAS_BLOCKED" : null,
        executionDisabledReason: blocked ? "directional_bias_blocked" : null,
        effectiveRegime: override.effectiveExecutionLane === "TREND" ? "TREND" : input.rawRegime,
        shouldBypassRangeStage0: override.effectiveExecutionLane === "TREND" && override.directionalShockState !== "NONE",
        proof: {
            raw_regime: input.rawRegime,
            directional_shock_state: input.directionalShockState,
            effective_execution_lane: override.effectiveExecutionLane,
            override_applied: override.overrideApplied,
            override_reason: override.overrideReason,
            signal_side: signalSide,
            preferred_side: preferredSide,
            intended_side: intendedSide,
            directional_bias: override.directionalBias,
            blocked
        }
    };
}
