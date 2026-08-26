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
    attachOrdType: "oco" | "conditional";
    lifecyclePartialTpAuthority: boolean;
}> {
    const slTriggerPx =
        input.stopPrice != null && Number.isFinite(input.stopPrice) && input.stopPrice > 0
            ? String(input.stopPrice)
            : undefined;
    const hasTpPrice =
        input.takeProfitPrice != null && Number.isFinite(input.takeProfitPrice) && input.takeProfitPrice > 0;
    const entryFullPositionTpAttached = hasTpPrice && !input.isV2RangePartialPlan;
    const attachOrdType: "oco" | "conditional" = entryFullPositionTpAttached ? "oco" : "conditional";
    const tpTriggerPx = entryFullPositionTpAttached ? String(input.takeProfitPrice) : undefined;

    if (!slTriggerPx) {
        return {
            attachAlgoOrds: [],
            entryFullPositionTpAttached: false,
            attachOrdType: "conditional",
            lifecyclePartialTpAuthority: input.isV2RangePartialPlan
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
            ...(attachOrdType === "oco"
                ? { tpTriggerPx, tpOrdPx: "-1", tpTriggerPxType: "last" }
                : {}),
            reduceOnly: true
        }
    ];

    return {
        attachAlgoOrds,
        entryFullPositionTpAttached,
        attachOrdType,
        lifecyclePartialTpAuthority: input.isV2RangePartialPlan
    };
}
