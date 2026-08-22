import { protectiveContractSizesMatch, protectiveStopPricesMatch } from "./protective-match";
import type { ProtectiveAlgoRow } from "./protective-reconcile-plan";

export type FinalProtectionState =
    | "PROTECTED"
    | "VISIBILITY_PENDING"
    | "REPAIR_REQUIRED"
    | "REPAIR_IN_PROGRESS"
    | "HARD_BLOCKED"
    | "TERMINAL_NO_PROTECTION_REQUIRED"
    | "UNAVAILABLE_FAIL_CLOSED";

export type ProtectionReconcileAction =
    | "NOOP"
    | "ADOPT_EXISTING"
    | "SUBMIT_SL_TP_OCO"
    | "REBUILD_SL_ONLY_TO_OCO"
    | "REPLACE_STALE_PROTECTION"
    | "REMOVE_DUPLICATE"
    | "WAIT_VISIBILITY_GRACE"
    | "REQUERY_REQUIRED"
    | "HARD_BLOCK";

// -------------------------------------------------------------------------------------------------
// 1. TIER 1: DESIRED PROTECTION PLAN
// -------------------------------------------------------------------------------------------------
export type DesiredProtectionPlanContext = Readonly<{
    symbol: string;
    positionCycleId?: string | null;
    side: "long" | "short";
    contracts: number;
    regime?: "TREND" | "RANGE" | "TRANSITION" | "SHOCK" | "UNKNOWN";
    slPrice: number | null;
    tpPrice: number | null;
    isV2Authority?: boolean;
    hasActivePosition?: boolean;
}>;

export type DesiredProtectionPlan = Readonly<{
    symbol: string;
    positionCycleId: string | null;
    side: "long" | "short";
    contracts: number;
    slRequired: boolean;
    tpRequired: boolean;
    desiredSlPrice: number | null;
    desiredTpPrice: number | null;
    slPriceValid: boolean;
    tpPriceValid: boolean;
    fullPositionProtectionRequired: boolean;
    planReady: boolean;
    blockReason: string | null;
}>;

export function resolveDesiredProtectionPlan(
    context: DesiredProtectionPlanContext
): DesiredProtectionPlan {
    const cycleId = context.positionCycleId ?? null;
    const isV2 = context.isV2Authority !== false;
    const isTrend = context.regime === "TREND";

    const hasContracts = typeof context.contracts === "number" && context.contracts > 0;
    const slRequired = isV2 && hasContracts; // In BOT_V2_MANAGED, SL is mandatory when position has contracts
    const tpRequired = isV2 && hasContracts; // In BOT_V2_MANAGED, TP is mandatory when position has contracts

    const slPrice = context.slPrice;
    const tpPrice = context.tpPrice;

    const slPriceValid = typeof slPrice === "number" && Number.isFinite(slPrice) && slPrice > 0;
    const tpPriceValid = typeof tpPrice === "number" && Number.isFinite(tpPrice) && tpPrice > 0;

    let blockReason: string | null = null;
    if (slRequired && !slPriceValid) {
        blockReason = "V2_MANDATORY_SL_PRICE_INVALID";
    } else if (tpRequired && !tpPriceValid) {
        blockReason = isTrend ? "V2_TREND_TP_PRICE_UNAVAILABLE" : "V2_MANDATORY_TP_PRICE_INVALID";
    }

    const planReady = blockReason === null && context.contracts > 0;

    return {
        symbol: context.symbol,
        positionCycleId: cycleId,
        side: context.side,
        contracts: context.contracts,
        slRequired,
        tpRequired,
        desiredSlPrice: slPriceValid ? slPrice : null,
        desiredTpPrice: tpPriceValid ? tpPrice : null,
        slPriceValid,
        tpPriceValid,
        fullPositionProtectionRequired: true,
        planReady,
        blockReason
    };
}

// -------------------------------------------------------------------------------------------------
// 2. TIER 2: EXCHANGE PROTECTION TRUTH
// -------------------------------------------------------------------------------------------------
export type ExchangeProtectionTruthContext = Readonly<{
    symbol: string;
    instId: string;
    positionCycleId?: string | null;
    side: "long" | "short";
    actualContracts: number;
    authoritativeFetchReady: boolean;
    pendingAlgos: readonly ProtectiveAlgoRow[];
    desiredPlan: DesiredProtectionPlan;
    tickSz?: number;
    visibilityGracePending?: boolean;
    truthSource?: "REST_AUTHORITATIVE" | "WS_AUTHORITATIVE" | "RECONCILE_CACHE" | "UNAVAILABLE";
}>;

export type ExchangeProtectionTruth = Readonly<{
    symbol: string;
    instId: string;
    positionCycleId: string | null;
    side: "long" | "short";
    actualContracts: number;
    authoritativeFetchReady: boolean;
    actualSlPresent: boolean;
    actualSlAlgoId: string | null;
    actualSlPrice: number | null;
    actualTpPresent: boolean;
    actualTpAlgoId: string | null;
    actualTpPrice: number | null;
    combinedOcoPresent: boolean;
    slMatchesDesired: boolean;
    tpMatchesDesired: boolean;
    sizeMatches: boolean;
    duplicateProtectiveOrders: boolean;
    duplicateSlCount: number;
    duplicateTpCount: number;
    staleProtectiveOrders: boolean;
    staleCount: number;
    protectionComplete: boolean;
    visibilityGracePending: boolean;
    truthSource: string;
}>;

export function resolveExchangeProtectionTruth(
    context: ExchangeProtectionTruthContext
): ExchangeProtectionTruth {
    const tickSz = context.tickSz ?? 0.1;
    const desired = context.desiredPlan;

    if (!context.authoritativeFetchReady) {
        return {
            symbol: context.symbol,
            instId: context.instId,
            positionCycleId: context.positionCycleId ?? null,
            side: context.side,
            actualContracts: context.actualContracts,
            authoritativeFetchReady: false,
            actualSlPresent: false,
            actualSlAlgoId: null,
            actualSlPrice: null,
            actualTpPresent: false,
            actualTpAlgoId: null,
            actualTpPrice: null,
            combinedOcoPresent: false,
            slMatchesDesired: false,
            tpMatchesDesired: false,
            sizeMatches: false,
            duplicateProtectiveOrders: false,
            duplicateSlCount: 0,
            duplicateTpCount: 0,
            staleProtectiveOrders: false,
            staleCount: 0,
            protectionComplete: false,
            visibilityGracePending: context.visibilityGracePending === true,
            truthSource: context.truthSource ?? "UNAVAILABLE"
        };
    }

    let actualSlAlgoId: string | null = null;
    let actualSlPrice: number | null = null;
    let actualTpAlgoId: string | null = null;
    let actualTpPrice: number | null = null;
    let combinedOcoPresent = false;
    let duplicateSlCount = 0;
    let duplicateTpCount = 0;
    let staleCount = 0;

    for (const algo of context.pendingAlgos) {
        const algoId = String(algo.algoId ?? "").trim();
        if (!algoId) continue; // Must have real OKX identity

        const sz = Number(algo.sz);
        const isCloseFrac = algo.closeFraction === "1" || String(algo.closeFraction ?? "") === "1";
        const sizeOk = isCloseFrac || protectiveContractSizesMatch(context.actualContracts, sz);
        const ordType = String(algo.ordType ?? "").toLowerCase();
        const isOco = ordType === "oco";

        const slPxRaw = algo.slTriggerPx;
        const slPx = typeof slPxRaw === "number" ? slPxRaw : typeof slPxRaw === "string" ? Number(slPxRaw) : null;
        const tpPxRaw = algo.tpTriggerPx;
        const tpPx = typeof tpPxRaw === "number" ? tpPxRaw : typeof tpPxRaw === "string" ? Number(tpPxRaw) : null;

        if (!sizeOk) {
            staleCount++;
            continue;
        }

        if (isOco) {
            if (slPx != null && tpPx != null) {
                if (!actualSlAlgoId) {
                    actualSlAlgoId = algoId;
                    actualSlPrice = slPx;
                    actualTpAlgoId = algoId;
                    actualTpPrice = tpPx;
                    combinedOcoPresent = true;
                } else {
                    duplicateSlCount++;
                    duplicateTpCount++;
                }
            }
        } else {
            if (slPx != null) {
                if (!actualSlAlgoId) {
                    actualSlAlgoId = algoId;
                    actualSlPrice = slPx;
                } else if (actualSlAlgoId !== algoId) {
                    duplicateSlCount++;
                }
            }
            if (tpPx != null) {
                if (!actualTpAlgoId) {
                    actualTpAlgoId = algoId;
                    actualTpPrice = tpPx;
                } else if (actualTpAlgoId !== algoId) {
                    duplicateTpCount++;
                }
            }
        }
    }

    const slMatchesDesired =
        desired.desiredSlPrice != null &&
        actualSlPrice != null &&
        protectiveStopPricesMatch(desired.desiredSlPrice, actualSlPrice, tickSz);

    const tpMatchesDesired =
        !desired.tpRequired ||
        (desired.desiredTpPrice != null &&
            actualTpPrice != null &&
            protectiveStopPricesMatch(desired.desiredTpPrice, actualTpPrice, tickSz));

    const actualSlPresent = actualSlAlgoId !== null;
    const actualTpPresent = actualTpAlgoId !== null;
    const sizeMatches = context.actualContracts > 0 && staleCount === 0;

    const protectionComplete =
        context.actualContracts > 0 &&
        (!desired.slRequired || (actualSlPresent && slMatchesDesired)) &&
        (!desired.tpRequired || (actualTpPresent && tpMatchesDesired)) &&
        sizeMatches;

    return {
        symbol: context.symbol,
        instId: context.instId,
        positionCycleId: context.positionCycleId ?? null,
        side: context.side,
        actualContracts: context.actualContracts,
        authoritativeFetchReady: true,
        actualSlPresent,
        actualSlAlgoId,
        actualSlPrice,
        actualTpPresent,
        actualTpAlgoId,
        actualTpPrice,
        combinedOcoPresent,
        slMatchesDesired,
        tpMatchesDesired,
        sizeMatches,
        duplicateProtectiveOrders: duplicateSlCount > 0 || duplicateTpCount > 0,
        duplicateSlCount,
        duplicateTpCount,
        staleProtectiveOrders: staleCount > 0,
        staleCount,
        protectionComplete,
        visibilityGracePending: context.visibilityGracePending === true,
        truthSource: context.truthSource ?? "REST_AUTHORITATIVE"
    };
}

// -------------------------------------------------------------------------------------------------
// 3. TIER 3: RECONCILE PLANNER (Pure Planning)
// -------------------------------------------------------------------------------------------------
export type ProtectionReconcilePlannerContext = Readonly<{
    desired: DesiredProtectionPlan;
    actual: ExchangeProtectionTruth;
    has51088Error?: boolean;
    isFlatOrTerminal?: boolean;
}>;

export type ProtectionReconcilePlanResult = Readonly<{
    action: ProtectionReconcileAction;
    reason: string;
    needSubmitOco: boolean;
    needSubmitSl: boolean;
    needSubmitTp: boolean;
    needCancelStale: boolean;
    needRebuildSlOnly: boolean;
    hardBlocked: boolean;
}>;

export function planProtectionReconcile(
    context: ProtectionReconcilePlannerContext
): ProtectionReconcilePlanResult {
    const { desired, actual, has51088Error, isFlatOrTerminal } = context;

    if (isFlatOrTerminal || actual.actualContracts === 0) {
        return {
            action: "NOOP",
            reason: "TERMINAL_POSITION_FLAT",
            needSubmitOco: false,
            needSubmitSl: false,
            needSubmitTp: false,
            needCancelStale: false,
            needRebuildSlOnly: false,
            hardBlocked: false
        };
    }

    if (!actual.authoritativeFetchReady) {
        return {
            action: "REQUERY_REQUIRED",
            reason: "AUTHORITATIVE_EXCHANGE_NOT_READY",
            needSubmitOco: false,
            needSubmitSl: false,
            needSubmitTp: false,
            needCancelStale: false,
            needRebuildSlOnly: false,
            hardBlocked: false
        };
    }

    if (actual.visibilityGracePending) {
        return {
            action: "WAIT_VISIBILITY_GRACE",
            reason: "AWAITING_VISIBILITY_GRACE",
            needSubmitOco: false,
            needSubmitSl: false,
            needSubmitTp: false,
            needCancelStale: false,
            needRebuildSlOnly: false,
            hardBlocked: false
        };
    }

    if (actual.protectionComplete && !has51088Error) {
        return {
            action: "NOOP",
            reason: "PROTECTION_COMPLETE_AND_MATCHED",
            needSubmitOco: false,
            needSubmitSl: false,
            needSubmitTp: false,
            needCancelStale: actual.staleProtectiveOrders,
            needRebuildSlOnly: false,
            hardBlocked: false
        };
    }

    if (has51088Error) {
        if (actual.combinedOcoPresent && actual.protectionComplete) {
            return {
                action: "ADOPT_EXISTING",
                reason: "51088_ADOPT_CONFIRMED_OCO",
                needSubmitOco: false,
                needSubmitSl: false,
                needSubmitTp: false,
                needCancelStale: false,
                needRebuildSlOnly: false,
                hardBlocked: false
            };
        }
        if (actual.actualSlPresent && !actual.actualTpPresent && desired.tpRequired) {
            return {
                action: "REBUILD_SL_ONLY_TO_OCO",
                reason: "51088_SL_ONLY_OCO_REPAIR",
                needSubmitOco: true,
                needSubmitSl: true,
                needSubmitTp: true,
                needCancelStale: false,
                needRebuildSlOnly: true,
                hardBlocked: false
            };
        }
    }

    if (actual.staleProtectiveOrders) {
        return {
            action: "REPLACE_STALE_PROTECTION",
            reason: "STALE_SIZE_OR_ROUTING_REPLACE",
            needSubmitOco: true,
            needSubmitSl: desired.slRequired,
            needSubmitTp: desired.tpRequired,
            needCancelStale: true,
            needRebuildSlOnly: false,
            hardBlocked: false
        };
    }

    if (actual.actualSlPresent && !actual.actualTpPresent && desired.tpRequired) {
        return {
            action: "REBUILD_SL_ONLY_TO_OCO",
            reason: "SL_EXISTS_TP_MISSING_REBUILD_OCO",
            needSubmitOco: true,
            needSubmitSl: true,
            needSubmitTp: true,
            needCancelStale: false,
            needRebuildSlOnly: true,
            hardBlocked: false
        };
    }

    if (!actual.actualSlPresent && !actual.actualTpPresent) {
        return {
            action: "SUBMIT_SL_TP_OCO",
            reason: "BOTH_SL_AND_TP_MISSING",
            needSubmitOco: desired.slRequired && desired.tpRequired,
            needSubmitSl: desired.slRequired,
            needSubmitTp: desired.tpRequired,
            needCancelStale: false,
            needRebuildSlOnly: false,
            hardBlocked: false
        };
    }

    if (!actual.actualSlPresent && actual.actualTpPresent && desired.slRequired) {
        return {
            action: "SUBMIT_SL_TP_OCO",
            reason: "SL_MISSING_SUBMIT_OCO",
            needSubmitOco: true,
            needSubmitSl: true,
            needSubmitTp: desired.tpRequired,
            needCancelStale: false,
            needRebuildSlOnly: false,
            hardBlocked: false
        };
    }

    return {
        action: "HARD_BLOCK",
        reason: "PROTECTION_STATE_UNRESOLVED",
        needSubmitOco: false,
        needSubmitSl: false,
        needSubmitTp: false,
        needCancelStale: false,
        needRebuildSlOnly: false,
        hardBlocked: true
    };
}

// -------------------------------------------------------------------------------------------------
// 4. TIER 4: FINAL PROTECTION AUTHORITY (Canonical State Aggregator)
// -------------------------------------------------------------------------------------------------
export type FinalProtectionAuthorityContext = Readonly<{
    symbol: string;
    positionCycleId?: string | null;
    side: "long" | "short";
    desired: DesiredProtectionPlan;
    actual: ExchangeProtectionTruth;
    reconcilePlan: ProtectionReconcilePlanResult;
    isFlatOrTerminal?: boolean;
    timestamp?: number;
}>;

export type FinalProtectionAuthorityResult = Readonly<{
    state: FinalProtectionState;
    symbol: string;
    positionCycleId: string | null;
    side: "long" | "short";
    slRequired: boolean;
    tpRequired: boolean;
    desiredSlPrice: number | null;
    desiredTpPrice: number | null;
    actualSlPresent: boolean;
    actualTpPresent: boolean;
    actualSlAlgoId: string | null;
    actualTpAlgoId: string | null;
    actualSlPrice: number | null;
    actualTpPrice: number | null;
    contractsMatch: boolean;
    authoritativeExchangeReady: boolean;
    visibilityGracePending: boolean;
    reconcileAction: ProtectionReconcileAction;
    reconcileReason: string;
    protectionComplete: boolean;
    hardBlocked: boolean;
    timestamp: number;
}>;

export function resolveFinalProtectionAuthority(
    context: FinalProtectionAuthorityContext
): FinalProtectionAuthorityResult {
    const { desired, actual, reconcilePlan, isFlatOrTerminal } = context;
    const ts = context.timestamp ?? Date.now();
    const cycleId = context.positionCycleId ?? desired.positionCycleId ?? null;

    let state: FinalProtectionState;

    if (isFlatOrTerminal || actual.actualContracts === 0) {
        state = "TERMINAL_NO_PROTECTION_REQUIRED";
    } else if (!actual.authoritativeFetchReady) {
        state = "UNAVAILABLE_FAIL_CLOSED";
    } else if (actual.visibilityGracePending) {
        state = "VISIBILITY_PENDING";
    } else if (reconcilePlan.hardBlocked) {
        state = "HARD_BLOCKED";
    } else if (actual.protectionComplete) {
        state = "PROTECTED";
    } else {
        state = "REPAIR_REQUIRED";
    }

    return {
        state,
        symbol: context.symbol,
        positionCycleId: cycleId,
        side: context.side,
        slRequired: desired.slRequired,
        tpRequired: desired.tpRequired,
        desiredSlPrice: desired.desiredSlPrice,
        desiredTpPrice: desired.desiredTpPrice,
        actualSlPresent: actual.actualSlPresent,
        actualTpPresent: actual.actualTpPresent,
        actualSlAlgoId: actual.actualSlAlgoId,
        actualTpAlgoId: actual.actualTpAlgoId,
        actualSlPrice: actual.actualSlPrice,
        actualTpPrice: actual.actualTpPrice,
        contractsMatch: actual.sizeMatches,
        authoritativeExchangeReady: actual.authoritativeFetchReady,
        visibilityGracePending: actual.visibilityGracePending,
        reconcileAction: reconcilePlan.action,
        reconcileReason: reconcilePlan.reason,
        protectionComplete: actual.protectionComplete,
        hardBlocked: reconcilePlan.hardBlocked,
        timestamp: ts
    };
}

export function buildFinalProtectionAuthorityProof(
    result: FinalProtectionAuthorityResult,
    extra?: Record<string, unknown>
): Record<string, unknown> {
    return {
        event: "V2_FINAL_PROTECTION_AUTHORITY_PROOF",
        symbol: result.symbol,
        side: result.side,
        positionCycleId: result.positionCycleId,
        state: result.state,
        slRequired: result.slRequired,
        tpRequired: result.tpRequired,
        desiredSlPrice: result.desiredSlPrice,
        desiredTpPrice: result.desiredTpPrice,
        actualSlPresent: result.actualSlPresent,
        actualTpPresent: result.actualTpPresent,
        actualSlAlgoId: result.actualSlAlgoId,
        actualTpAlgoId: result.actualTpAlgoId,
        actualSlPrice: result.actualSlPrice,
        actualTpPrice: result.actualTpPrice,
        contractsMatch: result.contractsMatch,
        authoritativeExchangeReady: result.authoritativeExchangeReady,
        visibilityGracePending: result.visibilityGracePending,
        reconcileAction: result.reconcileAction,
        reconcileReason: result.reconcileReason,
        protectionComplete: result.protectionComplete,
        hardBlocked: result.hardBlocked,
        timestamp: result.timestamp,
        ...extra
    };
}
