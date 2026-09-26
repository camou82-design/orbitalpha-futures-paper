/**
 * Canonical Highway branched-lifecycle lineage (sizing + ledger persistence).
 * Fail-closed: only explicit markers or qualified initial TREND native ENTER.
 */

export type HighwayLineageResolveInput = Readonly<{
    isHighwayLineageExplicit?: boolean | null;
    entrySemantic?: string | null;
    v2EntryReason?: string | null;
    promotionReason?: string | null;
    judgmentSubtype?: string | null;
    positionIsHighwayLineage?: boolean | null;
    positionEntrySemantic?: string | null;
    positionV2EntryReason?: string | null;
}>;

const PROMO = (s: string | null | undefined) => String(s ?? "").toUpperCase();
const SUB = (s: string | null | undefined) => String(s ?? "").toUpperCase();

/** Lineages that must never receive Highway sizing or isHighwayLineage persistence. */
export function isHighwayLineageExcluded(input: HighwayLineageResolveInput): boolean {
    const promo = PROMO(input.promotionReason);
    const subtype = SUB(input.judgmentSubtype);

    if (promo.startsWith("SHOCK_REACTION_")) return true;
    if (promo.includes("MICRO_PROBE") || promo.includes("REVERSAL")) return true;
    if (promo.includes("POST_SHOCK") || promo.includes("WHIPSAW")) return true;
    if (promo.startsWith("V2_RANGE_") || promo.startsWith("V2_TRANSITION_")) return true;
    if (promo.startsWith("V2_UPPER_") || promo.startsWith("V2_LOWER_")) return true;
    if (promo.startsWith("V2_CONFLICT_") || promo.startsWith("V2_WAIT_RECHECK")) return true;
    if (promo.startsWith("V2_STAIR_STEP") || promo.startsWith("V2_TREND_CONTINUATION_REVALIDATED")) return true;
    if (promo.startsWith("V2_POLARITY_REVERSAL")) return true;
    if (promo.startsWith("V2_PROBE_")) return true;

    if (subtype === "FAST_TREND_SHIFT") return true;
    if (subtype === "EARLY_LONG_PROBE" || subtype === "EARLY_SHORT_PROBE") return true;
    if (subtype.startsWith("SHOCK_REACTION")) return true;

    const sem = String(input.entrySemantic ?? input.positionEntrySemantic ?? "").toUpperCase();
    if (sem === "V2_POST_SHOCK_COUNTER_PROBE") return true;

    return false;
}

function explicitHighwayMarkers(input: HighwayLineageResolveInput): boolean {
    if (input.isHighwayLineageExplicit === true) return true;
    if (input.positionIsHighwayLineage === true) return true;

    const sem = String(input.entrySemantic ?? input.positionEntrySemantic ?? "");
    if (sem === "HIGHWAY" || sem === "HIGHWAY_CORE") return true;

    const vr = String(input.v2EntryReason ?? input.positionV2EntryReason ?? "");
    if (vr === "HIGHWAY_CORE_ENTRY" || vr === "HIGHWAY_CORE_TREND_PROBE") return true;
    if (vr.startsWith("HIGHWAY_")) return true;

    return false;
}

/** Single source of truth for isHighwayLineage === true (strict). */
export function resolveCanonicalHighwayLineage(input: HighwayLineageResolveInput): boolean {
    if (isHighwayLineageExcluded(input)) return false;
    return explicitHighwayMarkers(input);
}

export type InitialHighwayLineageAssignInput = Readonly<{
    isAddOn: boolean;
    finalDecisionEnter: boolean;
    highwayGateRejected: boolean;
    isMicroProbe: boolean;
    promotionApplied: boolean;
    promotionReason: string | null;
    judgmentRegime: string | null;
    judgmentSubtype: string | null;
    executionMetadata?: Record<string, unknown> | null;
    executionEntrySemantic?: string | null;
}>;

/**
 * Initial ENTRY only: assign ledger/metadata lineage for Highway branched lifecycle.
 * Excludes SHOCK_REACTION, FTS, RANGE, promoted probes, and generic promoted paths.
 */
export function resolveInitialHighwayLineageAssignment(input: InitialHighwayLineageAssignInput): boolean {
    if (!input.finalDecisionEnter || input.isAddOn) return false;
    if (input.highwayGateRejected || input.isMicroProbe) return false;

    const execMeta = input.executionMetadata ?? undefined;
    if (
        resolveCanonicalHighwayLineage({
            isHighwayLineageExplicit: execMeta?.isHighwayLineage === true,
            entrySemantic: input.executionEntrySemantic ?? (typeof execMeta?.entrySemantic === "string" ? execMeta.entrySemantic : null),
            v2EntryReason: typeof execMeta?.v2EntryReason === "string" ? execMeta.v2EntryReason : null,
            promotionReason: input.promotionReason,
            judgmentSubtype: input.judgmentSubtype
        })
    ) {
        return true;
    }

    if (
        isHighwayLineageExcluded({
            promotionReason: input.promotionReason,
            judgmentSubtype: input.judgmentSubtype,
            entrySemantic: input.executionEntrySemantic ?? null
        })
    ) {
        return false;
    }

    if (input.promotionApplied || input.promotionReason) return false;

    const regime = String(input.judgmentRegime ?? "").toUpperCase();
    if (regime !== "TREND") return false;

    return true;
}

export function resolveHighwayLineageFromOpenPosition(position: {
    isHighwayLineage?: boolean;
    entrySemantic?: string;
    v2EntryReason?: string;
} | null | undefined): boolean {
    if (!position) return false;
    return resolveCanonicalHighwayLineage({
        positionIsHighwayLineage: position.isHighwayLineage === true,
        positionEntrySemantic: position.entrySemantic ?? null,
        positionV2EntryReason: position.v2EntryReason ?? null
    });
}
