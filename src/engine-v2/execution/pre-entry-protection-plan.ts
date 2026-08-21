import { shouldAttachFullPositionProtectiveTp } from "./protective-tp-authority";
import type { MarketRegime } from "../../strategy/market-regime-detector";

export type PreEntryProtectionPlanResult = Readonly<{
    protectionPlanReady: boolean;
    entryBlocked: boolean;
    blockReason: string | null;
    slRequired: boolean;
    tpRequired: boolean;
    slPrice: number | null;
    tpPrice: number | null;
    slValid: boolean;
    tpValid: boolean;
    directionValid: boolean;
    tickRounded: boolean;
}>;

function roundToTick(px: number, tickSz: number): number {
    if (!Number.isFinite(tickSz) || tickSz <= 0) return px;
    return Math.round(px / tickSz) * tickSz;
}

function isFinitePositive(px: unknown): px is number {
    return typeof px === "number" && Number.isFinite(px) && px > 0;
}

export function evaluatePreEntryProtectionPlan(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    entryReferencePrice: number;
    slPrice: number | null | undefined;
    tpPrice: number | null | undefined;
    isV2Authority: boolean;
    regime: MarketRegime;
    isV2RangePartialPlan?: boolean;
    takeProfitRequired?: boolean;
    tickSz?: number;
}>): PreEntryProtectionPlanResult {
    const slRequired = true;
    const rawWantsTp = isFinitePositive(input.tpPrice);
    const isV2TrendMandatory =
        input.isV2Authority && input.regime === "TREND" && input.isV2RangePartialPlan !== true;
    const tpEval = shouldAttachFullPositionProtectiveTp({
        isV2Authority: input.isV2Authority,
        regime: input.regime,
        isV2RangePartialPlan: input.isV2RangePartialPlan === true,
        rawWantsTp: rawWantsTp || isV2TrendMandatory,
        takeProfitRequired: input.takeProfitRequired
    });
    const tpRequired = isV2TrendMandatory ? true : tpEval.fullPositionTpRequired;

    const slPrice = isFinitePositive(input.slPrice) ? input.slPrice : null;
    const tpPrice = isFinitePositive(input.tpPrice) ? input.tpPrice : null;
    const entryRef = input.entryReferencePrice;

    let slValid = slPrice != null;
    let tpValid = !tpRequired || tpPrice != null;
    let directionValid = false;
    let tickRounded = true;

    if (slValid && tpValid && slPrice != null && entryRef > 0) {
        if (input.side === "long") {
            directionValid = slPrice < entryRef && (!tpRequired || (tpPrice != null && tpPrice > entryRef));
            if (tpRequired && tpPrice != null && slPrice >= tpPrice) directionValid = false;
        } else {
            directionValid = slPrice > entryRef && (!tpRequired || (tpPrice != null && tpPrice < entryRef));
            if (tpRequired && tpPrice != null && slPrice <= tpPrice) directionValid = false;
        }
    }

    const tickSz = input.tickSz ?? 0;
    if (tickSz > 0 && slPrice != null) {
        const roundedSl = roundToTick(slPrice, tickSz);
        if (Math.abs(roundedSl - slPrice) > tickSz * 0.001) tickRounded = false;
    }
    if (tickSz > 0 && tpPrice != null) {
        const roundedTp = roundToTick(tpPrice, tickSz);
        if (Math.abs(roundedTp - tpPrice) > tickSz * 0.001) tickRounded = false;
    }

    let blockReason: string | null = null;
    if (!slValid) blockReason = "PRE_ENTRY_SL_PRICE_MISSING";
    else if (tpRequired && !tpValid) {
        blockReason = isV2TrendMandatory && !rawWantsTp
            ? "V2_TREND_TP_PRICE_UNAVAILABLE"
            : "PRE_ENTRY_TP_PRICE_MISSING";
    }
    else if (!directionValid) blockReason = "PRE_ENTRY_SL_TP_DIRECTION_INVALID";
    else if (!tickRounded) blockReason = "PRE_ENTRY_SL_TP_TICK_ROUND_INVALID";

    const protectionPlanReady = blockReason == null;
    return {
        protectionPlanReady,
        entryBlocked: !protectionPlanReady,
        blockReason,
        slRequired,
        tpRequired,
        slPrice,
        tpPrice,
        slValid,
        tpValid,
        directionValid,
        tickRounded
    };
}

export function buildPreEntryProtectionPlanProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_PRE_ENTRY_PROTECTION_PLAN_PROOF", ...input };
}
