import type { MarketRegime } from "../strategy/market-regime-detector";
import type { DirectionalShockState } from "./risk-control-layer";

export type EffectiveExecutionLane = "RANGE" | "TREND" | "IDLE";
export type DirectionalBias = "long" | "short" | "none";

export type DirectionalRoutingOverride = Readonly<{
  rawRegime: MarketRegime;
  effectiveExecutionLane: EffectiveExecutionLane;
  directionalBias: DirectionalBias;
  directionalShockState: DirectionalShockState;
  overrideApplied: boolean;
  overrideReason: string | null;
}>;

export type DirectionalTrendEntryGuardResult = Readonly<{
  blocked: boolean;
  blockedReason: "DIRECTIONAL_BIAS_BLOCKED" | null;
  executionDisabledReason: "directional_bias_blocked" | null;
  effectiveRegime: MarketRegime;
  shouldBypassRangeStage0: boolean;
  proof: Record<string, unknown>;
}>;

function signalToSide(signal: string | null | undefined): DirectionalBias {
  if (signal === "paper_long_candidate") return "long";
  if (signal === "paper_short_candidate") return "short";
  return "none";
}

export function deriveDirectionalRoutingOverride(input: Readonly<{
  rawRegime: MarketRegime;
  directionalShockState: DirectionalShockState;
}>): DirectionalRoutingOverride {
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

export function evaluateDirectionalTrendEntryGuard(input: Readonly<{
  rawRegime: MarketRegime;
  directionalShockState: DirectionalShockState;
  signal: string | null | undefined;
  rangeReversalImmediateSwitch?: Readonly<{ preferredSide: "long" | "short" }> | null;
}>): DirectionalTrendEntryGuardResult {
  const override = deriveDirectionalRoutingOverride({
    rawRegime: input.rawRegime,
    directionalShockState: input.directionalShockState
  });

  const signalSide = signalToSide(input.signal);
  const preferredSide = input.rangeReversalImmediateSwitch?.preferredSide ?? null;
  const intendedSide: DirectionalBias = preferredSide ?? signalSide;

  const blocked =
    override.directionalBias !== "none" &&
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
