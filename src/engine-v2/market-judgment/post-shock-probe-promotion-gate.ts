import { evaluateHighwayCoreEntryGate } from "../highway-core/highway-entry-gate";
import type { EngineV2Side, ExecutorOutput } from "../types";

export function evaluatePostShockProbeStandardPromotionRelease(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    regime: string;
    snapshot: any;
    directionalShockState?: string | null;
    stopPrice: number;
    takeProfit1Px: number;
}>): { eligible: boolean; reason: string } {
    const executionStub: ExecutorOutput = {
        signal: input.side === "long" ? "LONG_CANDIDATE" : "SHORT_CANDIDATE",
        side: input.side,
        reason: "POST_SHOCK_PROBE_STANDARD_PROMOTION_CHECK",
        baseSizeIntent: 1,
        recheckSuggested: false,
        isAddOnEligible: true,
        stopPrice: input.stopPrice,
        invalidationPx: input.stopPrice,
        metadata: {
            isProbe: false,
            plannedTp1Price: input.takeProfit1Px,
            takeProfit1Px: input.takeProfit1Px,
            tp1Price: input.takeProfit1Px
        }
    };

    const gate = evaluateHighwayCoreEntryGate({
        symbol: input.symbol,
        side: input.side as EngineV2Side,
        regime: input.regime,
        snapshot: input.snapshot,
        execution: executionStub,
        committedRiskPlan: {
            stopPrice: input.stopPrice,
            plannedTp1Price: input.takeProfit1Px
        } as any,
        hasExistingPosition: true,
        directionalShockState: input.directionalShockState ?? "NONE",
        isPreCheck: false
    });

    if (gate.allowed && gate.finalDecision === "ENTER") {
        return { eligible: true, reason: "STANDARD_HIGHWAY_FULL_ENTRY_GATE_SATISFIED" };
    }
    return {
        eligible: false,
        reason: gate.rejectReason ?? "STANDARD_HIGHWAY_FULL_ENTRY_GATE_PENDING"
    };
}
