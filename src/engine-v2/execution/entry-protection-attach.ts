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
    if (input.isV2Authority === true && input.regime === "RANGE" && input.takeProfitPlan != null) {
        return 0.5;
    }
    return null;
}

/** Mirrors post-fill ensureProtectiveStopOrder partial-plan sovereignty predicate. */
export function isV2RangePartialPlanContext(input: V2RangePartialPlanContext): boolean {
    const ratio = resolvePartialExitRatio(input);
    const plan = input.takeProfitPlan as { tp1?: unknown; executableTp1?: unknown } | null | undefined;
    const hasValidTp1 =
        (typeof input.takeProfit1Px === "number" && Number.isFinite(input.takeProfit1Px) && input.takeProfit1Px > 0) ||
        (typeof plan?.tp1 === "number" && Number.isFinite(plan.tp1) && plan.tp1 > 0) ||
        (typeof plan?.executableTp1 === "number" && Number.isFinite(plan.executableTp1) && plan.executableTp1 > 0);

    return (
        input.isV2Authority === true &&
        input.regime === "RANGE" &&
        input.takeProfitPlan != null &&
        hasValidTp1 &&
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
    const entryFullPositionTpAttached = hasTpPrice && !input.isV2RangePartialPlan;
    const entryRangeTp2BackstopAttached = hasTpPrice && input.isV2RangePartialPlan;
    const shouldAttachOco = entryFullPositionTpAttached || entryRangeTp2BackstopAttached;
    const attachOrdType: "oco" | "conditional" = shouldAttachOco ? "oco" : "conditional";
    const tpTriggerPx = shouldAttachOco && hasTpPrice ? String(input.takeProfitPrice) : undefined;
    const exchangeTpSource = entryFullPositionTpAttached
        ? ("trend_full_tp" as const)
        : entryRangeTp2BackstopAttached
          ? ("range_tp2_backstop" as const)
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
