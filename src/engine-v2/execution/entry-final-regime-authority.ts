import type { EngineV2Regime } from "../types";

export type FinalRegimeExecutionAuthority = Readonly<{
    canonical_regime: string;
    regime_final: EngineV2Regime;
    router_executor: string;
    market_mode: string;
    has_final_trend_execution_authority: boolean;
    range_to_trend_promotion_applicable: boolean;
    promotion_gate_applicable: boolean;
    promotion_gate_bypass_reason: string | null;
    range_zone_veto_applicable: boolean;
    range_zone_veto_bypass_reason: string | null;
}>;

export function resolveFinalRegimeExecutionAuthority(args: Readonly<{
    canonicalRegime?: string | null;
    regimeFinal: EngineV2Regime;
    regime: EngineV2Regime;
    routerExecutor: string;
}>): FinalRegimeExecutionAuthority {
    const canonical = String(args.canonicalRegime ?? args.regime ?? "UNKNOWN");
    const regimeFinal = args.regimeFinal;
    const router = String(args.routerExecutor ?? "UNKNOWN");
    const hasFinalTrendExecutionAuthority =
        regimeFinal === "TREND" && router === "TREND";
    const rangeToTrendPromotionApplicable = !hasFinalTrendExecutionAuthority;

    const isPureRangeExecution =
        regimeFinal === "RANGE" && router === "RANGE" && !hasFinalTrendExecutionAuthority;
    const rangeZoneVetoApplicable = isPureRangeExecution;
    const rangeZoneVetoBypassReason = !rangeZoneVetoApplicable
        ? hasFinalTrendExecutionAuthority
            ? "FINAL_TREND_ROUTING_AUTHORITY"
            : regimeFinal === "TREND"
                ? "TREND_FINAL_REGIME_AUTHORITY"
                : router === "TREND"
                    ? "TREND_ROUTER_AUTHORITY"
                    : router === "TRANSITION"
                        ? "TRANSITION_ROUTER_AUTHORITY"
                        : "NON_RANGE_ROUTING_AUTHORITY"
        : null;

    return {
        canonical_regime: canonical,
        regime_final: regimeFinal,
        router_executor: router,
        market_mode: String(regimeFinal ?? "UNKNOWN"),
        has_final_trend_execution_authority: hasFinalTrendExecutionAuthority,
        range_to_trend_promotion_applicable: rangeToTrendPromotionApplicable,
        promotion_gate_applicable: rangeToTrendPromotionApplicable,
        promotion_gate_bypass_reason: hasFinalTrendExecutionAuthority
            ? "FINAL_TREND_ROUTING_AUTHORITY"
            : null,
        range_zone_veto_applicable: rangeZoneVetoApplicable,
        range_zone_veto_bypass_reason: rangeZoneVetoBypassReason
    };
}
