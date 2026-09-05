import { buildOkxAlgoClOrdId } from "./protective-inventory";

export type V2RangePartialPlanContext = Readonly<{
    isV2Authority?: boolean;
    regime?: string | null;
    takeProfitPlan?: unknown | null;
    takeProfit1Px?: number | null;
    partialExitRatio?: number | null;
}>;

export function resolvePartialExitRatio(input: V2RangePartialPlanContext): number | null {
    if (
        typeof input.partialExitRatio === "number" &&
        Number.isFinite(input.partialExitRatio) &&
        input.partialExitRatio > 0 &&
        input.partialExitRatio < 1
    ) {
        return input.partialExitRatio;
    }
    const plan = input.takeProfitPlan as { partialRatio?: unknown } | null | undefined;
    const fromPlan = plan?.partialRatio;
    if (typeof fromPlan === "number" && Number.isFinite(fromPlan) && fromPlan > 0 && fromPlan < 1) {
        return fromPlan;
    }
    return null;
}

/** Mirrors post-fill ensureProtectiveStopOrder partial-plan sovereignty predicate. */
export function isV2RangePartialPlanContext(input: V2RangePartialPlanContext): boolean {
    const ratio = resolvePartialExitRatio(input);
    return (
        input.isV2Authority === true &&
        input.regime === "RANGE" &&
        input.takeProfitPlan != null &&
        typeof input.takeProfit1Px === "number" &&
        Number.isFinite(input.takeProfit1Px) &&
        input.takeProfit1Px > 0 &&
        ratio != null
    );
}

export function buildV2NewEntryAttachAlgoOrds(input: Readonly<{
    clOrdId: string;
    submitSzStr: string;
    stopPrice: number | null | undefined;
    takeProfitPrice: number | null | undefined;
    isV2RangePartialPlan: boolean;
}>): Readonly<{
    attachAlgoOrds: ReadonlyArray<Record<string, unknown>>;
    entryFullPositionTpAttached: boolean;
    entryRangeTp2BackstopAttached?: boolean;
    attachOrdType: "oco" | "conditional";
    lifecyclePartialTpAuthority: boolean;
    exchangeTpSource?: "trend_full_tp" | "range_tp2_backstop" | "none";
}> {
    const slTriggerPx =
        input.stopPrice != null && Number.isFinite(input.stopPrice) && input.stopPrice > 0
            ? String(input.stopPrice)
            : undefined;
    const hasTpPrice =
        input.takeProfitPrice != null && Number.isFinite(input.takeProfitPrice) && input.takeProfitPrice > 0;
    // [CANONICAL TP SINGLE-WRITER] RANGE partial plan MUST NOT attach TP at entry.
    // OKX attach OCO cannot represent different sizes for TP (50% partial) and SL (100% full).
    // Entry attaches SL-only conditional protection. Canonical reconciler submits TP1 post-fill.
    const entryFullPositionTpAttached = hasTpPrice && !input.isV2RangePartialPlan;
    const entryRangeTp2BackstopAttached = false;
    const shouldAttachOco = entryFullPositionTpAttached;
    const attachOrdType: "oco" | "conditional" = shouldAttachOco ? "oco" : "conditional";
    const tpTriggerPx = shouldAttachOco && hasTpPrice ? String(input.takeProfitPrice) : undefined;
    const exchangeTpSource = entryFullPositionTpAttached
        ? ("trend_full_tp" as const)
        : ("none" as const);

    if (!slTriggerPx) {
        return {
            attachAlgoOrds: [],
            entryFullPositionTpAttached: false,
            entryRangeTp2BackstopAttached: false,
            attachOrdType: "conditional",
            lifecyclePartialTpAuthority: input.isV2RangePartialPlan,
            exchangeTpSource: "none"
        };
    }

    const attachAlgoOrds: Record<string, unknown>[] = [
        {
            attachAlgoOrdId: buildOkxAlgoClOrdId("sl", input.clOrdId),
            ordType: attachOrdType,
            sz: input.submitSzStr,
            slTriggerPx,
            slOrdPx: "-1",
            slTriggerPxType: "last",
            ...(attachOrdType === "oco" && tpTriggerPx != null
                ? { tpTriggerPx, tpOrdPx: "-1", tpTriggerPxType: "last" }
                : {}),
            reduceOnly: true
        }
    ];

    return {
        attachAlgoOrds,
        entryFullPositionTpAttached,
        entryRangeTp2BackstopAttached,
        attachOrdType,
        lifecyclePartialTpAuthority: input.isV2RangePartialPlan,
        exchangeTpSource
    };
}
