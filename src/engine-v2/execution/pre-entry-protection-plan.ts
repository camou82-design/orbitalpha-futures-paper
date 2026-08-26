import { normalizePxToTickSz } from "./entry-order-type";
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

function isFinitePositive(px: unknown): px is number {
    return typeof px === "number" && Number.isFinite(px) && px > 0;
}

function isTickCompliant(px: number, tickSz: number): boolean {
    if (!Number.isFinite(tickSz) || tickSz <= 0) return true;
    const normalized = normalizePxToTickSz(px, tickSz);
    return Math.abs(px - normalized) <= tickSz * 0.001;
}

function normalizeProtectionPx(rawPx: number | null, tickSz: number): number | null {
    if (rawPx == null) return null;
    if (!(Number.isFinite(tickSz) && tickSz > 0)) return rawPx;
    const normalized = normalizePxToTickSz(rawPx, tickSz);
    return isFinitePositive(normalized) ? normalized : null;
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
    const tpEval = shouldAttachFullPositionProtectiveTp({
        isV2Authority: input.isV2Authority,
        regime: input.regime,
        isV2RangePartialPlan: input.isV2RangePartialPlan === true,
        rawWantsTp,
        takeProfitRequired: input.takeProfitRequired
    });
    const tpRequired = tpEval.fullPositionTpRequired;

    const tickSz = input.tickSz ?? 0;
    const rawSlPrice = isFinitePositive(input.slPrice) ? input.slPrice : null;
    const rawTpPrice = isFinitePositive(input.tpPrice) ? input.tpPrice : null;
    const slPrice = normalizeProtectionPx(rawSlPrice, tickSz);
    const tpPrice = normalizeProtectionPx(rawTpPrice, tickSz);
    const entryRef = input.entryReferencePrice;

    let slValid = slPrice != null;
    let tpValid = !tpRequired || tpPrice != null;
    let directionValid = false;
    let tickRounded = true;

    if (tickSz > 0) {
        if (rawSlPrice != null && slPrice == null) tickRounded = false;
        if (rawTpPrice != null && tpPrice == null) tickRounded = false;
        if (slPrice != null && !isTickCompliant(slPrice, tickSz)) tickRounded = false;
        if (tpPrice != null && !isTickCompliant(tpPrice, tickSz)) tickRounded = false;
    }

    if (slValid && tpValid && slPrice != null && entryRef > 0) {
        if (input.side === "long") {
            directionValid =
                slPrice < entryRef &&
                (!tpRequired || (tpPrice != null && tpPrice > entryRef));
            if (tpRequired && tpPrice != null && slPrice >= tpPrice) directionValid = false;
        } else {
            directionValid =
                slPrice > entryRef &&
                (!tpRequired || (tpPrice != null && tpPrice < entryRef));
            if (tpRequired && tpPrice != null && slPrice <= tpPrice) directionValid = false;
        }

        const collapseEpsilon = tickSz > 0 ? tickSz * 0.5 : 1e-8;
        if (Math.abs(slPrice - entryRef) <= collapseEpsilon) directionValid = false;
        if (tpRequired && tpPrice != null && Math.abs(tpPrice - entryRef) <= collapseEpsilon) {
            directionValid = false;
        }
    }

    let blockReason: string | null = null;
    if (!slValid) blockReason = "PRE_ENTRY_SL_PRICE_MISSING";
    else if (tpRequired && !tpValid) {
        blockReason = input.regime === "TREND" && !rawWantsTp
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
