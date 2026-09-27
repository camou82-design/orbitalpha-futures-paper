import { resolveHighwayLineageFromOpenPosition } from "./highway-lineage-authority";

/** Single management authority for open Highway lineage positions (not RANGE-held ledger). */
export const HIGHWAY_LIFECYCLE_MANAGEMENT_AUTHORITY = "HIGHWAY_LIFECYCLE" as const;

export type HighwayLifecycleStage =
    | "HIGHWAY_INITIAL"
    | "HIGHWAY_DEFENSIVE_ADVERSE"
    | "HIGHWAY_PROTECTED_PYRAMID";

export type HighwayLifecycleStageSource =
    | "ledger_highway_pyramid_addon_count"
    | "ledger_highway_lifecycle_stage"
    | "ledger_highway_protected_pyramid_executed"
    | "ledger_highway_defensive_executed"
    | "ledger_adverse_addon_count"
    | "ledger_inferred_pyramid_addon_delta"
    | "ledger_initial";

export type HighwayLifecycleLedgerFields = Readonly<{
    adverseAddonCount?: number;
    addonCount?: number;
    positionCycleAdverseAddonCount?: number;
    positionCycleAddonCount?: number;
    highwayLifecycleStage?: string;
    highwayDefensiveAddonExecuted?: boolean;
    highwayProtectedPyramidExecuted?: boolean;
    highwayPyramidAddonCount?: number;
    isHighwayLineage?: boolean;
    entrySemantic?: string;
    v2EntryReason?: string;
}>;

/** Legacy addon delta inference applies only to confirmed Highway lineage opens. */
export function isHighwayLifecycleLegacyInferenceEligible(
    position: HighwayLifecycleLedgerFields | null | undefined
): boolean {
    return resolveHighwayLineageFromOpenPosition(position);
}

export type HighwayLifecycleStageResolution = Readonly<{
    stage: HighwayLifecycleStage;
    source: HighwayLifecycleStageSource;
}>;

export type HighwayLifecycleManagementAuthority = Readonly<{
    active: boolean;
    managementAuthority: typeof HIGHWAY_LIFECYCLE_MANAGEMENT_AUTHORITY | "GENERIC_V2";
    stage: HighwayLifecycleStage | null;
    stageSource: HighwayLifecycleStageSource | null;
    initialMarginEquityFraction: 0.25;
    defensiveMarginEquityFraction: 0.225;
    pyramidMarginEquityFraction: 0.25;
}>;

function normalizeExplicitStage(raw: string | undefined): HighwayLifecycleStage | null {
    const s = String(raw ?? "").toUpperCase();
    if (s === "HIGHWAY_PROTECTED_PYRAMID" || s === "PROTECTED_PYRAMID") return "HIGHWAY_PROTECTED_PYRAMID";
    if (s === "HIGHWAY_DEFENSIVE_ADVERSE" || s === "DEFENSIVE_ADVERSE") return "HIGHWAY_DEFENSIVE_ADVERSE";
    if (s === "HIGHWAY_INITIAL" || s === "INITIAL") return "HIGHWAY_INITIAL";
    return null;
}

/** Protected pyramid fills only — never generic addonCount alone. */
export function resolveHighwayProtectedPyramidAddonCount(
    position: HighwayLifecycleLedgerFields | null | undefined
): number {
    if (!position) return 0;
    const explicit = Math.max(0, Number(position.highwayPyramidAddonCount ?? 0));
    if (explicit > 0) return explicit;
    if (position.highwayProtectedPyramidExecuted === true) return 1;
    const adverse = Math.max(
        0,
        Number(position.adverseAddonCount ?? position.positionCycleAdverseAddonCount ?? 0)
    );
    const addon = Math.max(0, Number(position.addonCount ?? position.positionCycleAddonCount ?? 0));
    const inferredDelta = Math.max(0, addon - adverse);
    if (inferredDelta > 0 && isHighwayLifecycleLegacyInferenceEligible(position)) {
        return inferredDelta;
    }
    return 0;
}

/**
 * Committed Highway lifecycle stage from explicit execution history.
 * Unidirectional: INITIAL → DEFENSIVE → PYRAMID (no pnl-based regression).
 */
export function resolveHighwayLifecycleStage(
    position: HighwayLifecycleLedgerFields | null | undefined
): HighwayLifecycleStageResolution {
    const explicit = normalizeExplicitStage(position?.highwayLifecycleStage);
    const protectedPyramidCount = resolveHighwayProtectedPyramidAddonCount(position);
    const adverse = Math.max(
        0,
        Number(position?.adverseAddonCount ?? position?.positionCycleAdverseAddonCount ?? 0)
    );

    if (
        protectedPyramidCount > 0 ||
        explicit === "HIGHWAY_PROTECTED_PYRAMID" ||
        position?.highwayProtectedPyramidExecuted === true
    ) {
        if (protectedPyramidCount > 0) {
            return { stage: "HIGHWAY_PROTECTED_PYRAMID", source: "ledger_highway_pyramid_addon_count" };
        }
        if (position?.highwayProtectedPyramidExecuted === true) {
            return { stage: "HIGHWAY_PROTECTED_PYRAMID", source: "ledger_highway_protected_pyramid_executed" };
        }
        if (isHighwayLifecycleLegacyInferenceEligible(position)) {
            return { stage: "HIGHWAY_PROTECTED_PYRAMID", source: "ledger_inferred_pyramid_addon_delta" };
        }
        return { stage: "HIGHWAY_INITIAL", source: "ledger_initial" };
    }

    if (
        adverse > 0 ||
        explicit === "HIGHWAY_DEFENSIVE_ADVERSE" ||
        position?.highwayDefensiveAddonExecuted === true
    ) {
        if (position?.highwayDefensiveAddonExecuted === true) {
            return { stage: "HIGHWAY_DEFENSIVE_ADVERSE", source: "ledger_highway_defensive_executed" };
        }
        if (explicit === "HIGHWAY_DEFENSIVE_ADVERSE") {
            return { stage: "HIGHWAY_DEFENSIVE_ADVERSE", source: "ledger_highway_lifecycle_stage" };
        }
        return { stage: "HIGHWAY_DEFENSIVE_ADVERSE", source: "ledger_adverse_addon_count" };
    }

    if (explicit === "HIGHWAY_INITIAL") {
        return { stage: "HIGHWAY_INITIAL", source: "ledger_highway_lifecycle_stage" };
    }

    return { stage: "HIGHWAY_INITIAL", source: "ledger_initial" };
}

export function isRangeHeldPositionForHighwayLifecycle(
    pos: Readonly<{ regimeAtEntry?: string; entrySemantic?: string; isHighwayLineage?: boolean }> | null | undefined
): boolean {
    if (!pos) return false;
    if (pos.regimeAtEntry === "RANGE") return true;
    if (resolveHighwayLineageFromOpenPosition(pos)) return false;
    const sem = String(pos.entrySemantic ?? "").toUpperCase();
    return sem.includes("RANGE");
}

export function resolveHighwayLifecycleManagementAuthority(input: Readonly<{
    position: HighwayLifecycleLedgerFields &
        Readonly<{
            regimeAtEntry?: string;
            entrySemantic?: string;
            isHighwayLineage?: boolean;
            v2EntryReason?: string;
        }> | null | undefined;
    isAddOn: boolean;
}>): HighwayLifecycleManagementAuthority {
    const inactive: HighwayLifecycleManagementAuthority = {
        active: false,
        managementAuthority: "GENERIC_V2",
        stage: null,
        stageSource: null,
        initialMarginEquityFraction: 0.25,
        defensiveMarginEquityFraction: 0.225,
        pyramidMarginEquityFraction: 0.25
    };
    if (!input.isAddOn || !input.position) return inactive;
    if (!resolveHighwayLineageFromOpenPosition(input.position)) return inactive;
    if (isRangeHeldPositionForHighwayLifecycle(input.position)) return inactive;

    const resolved = resolveHighwayLifecycleStage(input.position);

    return {
        active: true,
        managementAuthority: HIGHWAY_LIFECYCLE_MANAGEMENT_AUTHORITY,
        stage: resolved.stage,
        stageSource: resolved.source,
        initialMarginEquityFraction: 0.25,
        defensiveMarginEquityFraction: 0.225,
        pyramidMarginEquityFraction: 0.25
    };
}

export type HighwayLifecycleLedgerStamp = Readonly<{
    highwayDefensiveAddonExecuted?: boolean;
    highwayProtectedPyramidExecuted?: boolean;
    highwayLifecycleStage?: HighwayLifecycleStage;
    adverseAddonCount?: number;
    highwayPyramidAddonCount?: number;
}>;

export function stampHighwayLifecycleAfterDefensiveFill(
    existing: HighwayLifecycleLedgerFields
): HighwayLifecycleLedgerStamp {
    return {
        highwayDefensiveAddonExecuted: true,
        highwayLifecycleStage: "HIGHWAY_DEFENSIVE_ADVERSE",
        adverseAddonCount: Math.max(0, Number(existing.adverseAddonCount ?? 0)) + 1
    };
}

export function stampHighwayLifecycleAfterProtectedPyramidFill(
    existing: HighwayLifecycleLedgerFields
): HighwayLifecycleLedgerStamp {
    return {
        highwayProtectedPyramidExecuted: true,
        highwayLifecycleStage: "HIGHWAY_PROTECTED_PYRAMID",
        highwayPyramidAddonCount: Math.max(0, Number(existing.highwayPyramidAddonCount ?? 0)) + 1
    };
}

/** Generic RANGE/TRANSITION addon vetoes must not override active Highway lifecycle (except hard-risk paths). */
export function genericRangeTransitionAddonVetoApplies(highwayLifecycleActive: boolean): boolean {
    return !highwayLifecycleActive;
}

export function resolveHighwayLifecycleProtectiveTpReason(stage: HighwayLifecycleStage | null): string {
    const s = stage ?? "HIGHWAY_INITIAL";
    return `HIGHWAY_LIFECYCLE_${s}_PROTECTIVE_TP_DEFERRED`;
}

/** Same minimum protected profit floor as generic TREND profit-funded pyramid policy. */
export function resolveHighwayMinimumProtectedProfitUsd(accountEquityUsd: number): number {
    return Math.max(0.5, accountEquityUsd * 0.0015);
}
