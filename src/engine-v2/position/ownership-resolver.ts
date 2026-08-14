import type { PaperOpenPositionRecord } from "../../models/types";
import {
    evaluateFalseManualLatchRecovery,
    evaluateManualOwnershipLatchTrigger,
    evaluatePoisonedStrongManualLatchRecovery,
    hasIndependentManualLifecycleEvidence,
    isIndependentExternalManualLifecycle,
    isStrongManualLatchSource,
    type ManualLatchStrength
} from "./manual-ownership-latch";

export type PositionOwnershipClass =
    | "BOT_V2_MANAGED"
    | "EXTERNAL_MANUAL_MANAGED"
    | "CLOSE_ONLY_MANAGED"
    | "NO_POSITION";

/** Contract mismatch tolerance aligned with reconcile contract tolerance. */
export const MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO = 0.001;

/** AvgPx mismatch tolerance aligned with reconcile price tolerance. */
export const MANUAL_AVG_PX_MISMATCH_TOLERANCE_RATIO = 0.0005;

/** Grace window while bot ENTER/ADDON/REDUCE fill reconciliation catches up to OKX actual. */
export const BOT_ATTRIBUTED_TRANSIENT_MISMATCH_GRACE_MS = 45_000;

export type PositionOwnershipResolveInput = Readonly<{
    symbol: string;
    side: "long" | "short";
    okxActualPositionExists: boolean;
    okxActualContracts: number;
    ledger: PaperOpenPositionRecord | null;
    ledgerPaperContracts?: number | null;
    ledgerEntryPrice?: number | null;
    okxAvgPx?: number | null;
    symbolExternalManualBlocked: boolean;
    manualOwnershipLatchActive?: boolean;
    syncStatus?: string | null;
    okxFetchReady?: boolean;
    reconcileState?: string | null;
    explicitExternalManualEvidence?: boolean;
    latchRecoveryPending?: boolean;
}>;

export type PositionOwnershipResolveResult = Readonly<{
    ownershipClass: PositionOwnershipClass;
    ownershipSource: string;
    persistedV2OwnerFound: boolean;
    botOrderEvidenceFound: boolean;
    externalManualEvidence: boolean;
    manualOwnershipLatchActive: boolean;
    manualLatchShouldBeActive: boolean;
    manualInterventionReason: string | null;
    automatedOrderMutationBlocked: boolean;
    manualLatchTriggerSource: string | null;
    manualLatchTriggerStrength: ManualLatchStrength | null;
    latchRecoveryRecommended: boolean;
    latchRecoveryReason: string | null;
    lifecycleBefore: PaperOpenPositionRecord["lifecycleState"] | null;
    lifecycleAfter: PaperOpenPositionRecord["lifecycleState"];
    v2ManagementRestored: boolean;
    addonManagementAllowed: boolean;
    normalExitPolicyAllowed: boolean;
}>;

function isBotV2LedgerEvidence(ledger: PaperOpenPositionRecord | null): boolean {
    if (ledger == null) return false;
    if (ledger.isV2Authority === true) return true;
    const authSrc = String(ledger.authoritySourceAtEntry ?? ledger.authority ?? "").trim().toLowerCase();
    if (authSrc === "v2") return true;
    if (ledger.lifecycleState === "BOT_V2_MANAGED") return true;
    if (
        ledger.lifecycleState === "OPEN" ||
        ledger.lifecycleState === "ADDON_ACTIVE" ||
        ledger.lifecycleState === "PARTIAL_ACTIVE"
    ) {
        return authSrc === "v2";
    }
    return false;
}

/** @deprecated Use isIndependentExternalManualLifecycle — EXTERNAL_MANUAL_MANAGED is derived, not evidence. */
function isExternalManualLifecycle(ledger: PaperOpenPositionRecord | null): boolean {
    return isIndependentExternalManualLifecycle(ledger);
}

function hasBotOrderAttribution(ledger: PaperOpenPositionRecord | null | undefined): boolean {
    if (ledger == null) return false;
    if (ledger.isV2Authority === true) return true;
    const authSrc = String(ledger.authoritySourceAtEntry ?? ledger.authority ?? "").trim().toLowerCase();
    if (authSrc === "v2") return true;
    const clOrdId = String(ledger.exchangeClOrdId ?? "");
    return clOrdId.startsWith("p");
}

/** Bot ENTER/ADDON/REDUCE pending or recent fill reconciliation — not manual intervention. */
export function isBotAttributedTransientMismatch(
    ledger: PaperOpenPositionRecord | null | undefined,
    nowMs: number = Date.now()
): boolean {
    if (ledger == null || !hasBotOrderAttribution(ledger)) return false;

    const ls = ledger.lifecycleState;
    if (
        ls === "INITIAL" ||
        ls === "PENDING_EXCHANGE_CONFIRM" ||
        ls === "PARTIAL_PENDING" ||
        ls === "CLOSE_PENDING" ||
        ls === "ADDON_ACTIVE"
    ) {
        return true;
    }

    if (
        (typeof ledger.partialPendingOrdId === "string" && ledger.partialPendingOrdId.length > 0) ||
        (typeof ledger.partialPendingClOrdId === "string" && ledger.partialPendingClOrdId.length > 0) ||
        (typeof ledger.partialPendingContracts === "number" &&
            Number.isFinite(ledger.partialPendingContracts) &&
            ledger.partialPendingContracts > 0)
    ) {
        return true;
    }

    if (
        (typeof ledger.closePendingOrdId === "string" && ledger.closePendingOrdId.length > 0) ||
        (typeof ledger.closePendingClOrdId === "string" && ledger.closePendingClOrdId.length > 0)
    ) {
        return true;
    }

    if (ledger.addonRebuildPendingConfirmation === true || ledger.addonRebuildRequired === true) {
        return true;
    }

    const shockState = ledger.shockReduceState;
    if (
        shockState === "REQUESTED" ||
        shockState === "SUBMITTED" ||
        shockState === "PARTIALLY_FILLED"
    ) {
        return true;
    }

    const rebuildStartedAt = ledger.addonRebuildMetrics?.rebuildStartedAt;
    if (
        rebuildStartedAt != null &&
        Number.isFinite(rebuildStartedAt) &&
        nowMs - rebuildStartedAt >= 0 &&
        nowMs - rebuildStartedAt <= BOT_ATTRIBUTED_TRANSIENT_MISMATCH_GRACE_MS
    ) {
        return true;
    }

    const partialPendingAt = ledger.partialPendingAt;
    if (
        partialPendingAt != null &&
        Number.isFinite(partialPendingAt) &&
        nowMs - partialPendingAt >= 0 &&
        nowMs - partialPendingAt <= BOT_ATTRIBUTED_TRANSIENT_MISMATCH_GRACE_MS &&
        (ledger.partialPendingOrdId != null || ledger.partialPendingClOrdId != null)
    ) {
        return true;
    }

    return false;
}

export function detectManualInterventionEvidence(
    input: Pick<
        PositionOwnershipResolveInput,
        | "ledgerPaperContracts"
        | "okxActualContracts"
        | "ledgerEntryPrice"
        | "okxAvgPx"
        | "symbolExternalManualBlocked"
        | "manualOwnershipLatchActive"
    > & {
        ledger?: PaperOpenPositionRecord | null;
        nowMs?: number;
        explicitExternalManualEvidence?: boolean;
    }
): { detected: boolean; reason: string | null } {
    if (
        input.manualOwnershipLatchActive === true &&
        input.ledger != null &&
        isStrongManualLatchSource(
            input.ledger.manualOwnershipLatchSource ?? input.ledger.manualOwnershipLatchReason
        ) &&
        hasIndependentManualLifecycleEvidence(input.ledger)
    ) {
        return { detected: true, reason: "manual_ownership_latch_active" };
    }

    if (isIndependentExternalManualLifecycle(input.ledger ?? null)) {
        return { detected: true, reason: "external_manual_lifecycle_evidence" };
    }

    const botTransient = isBotAttributedTransientMismatch(
        input.ledger,
        input.nowMs ?? Date.now()
    );
    if (botTransient) {
        return { detected: false, reason: null };
    }

    if (input.explicitExternalManualEvidence === true) {
        return { detected: true, reason: "external_manual_evidence" };
    }

    const paperContracts = input.ledgerPaperContracts;
    const okxContracts = input.okxActualContracts;
    if (
        paperContracts != null &&
        Number.isFinite(paperContracts) &&
        okxContracts > 0 &&
        !hasBotOrderAttribution(input.ledger)
    ) {
        const contractDiff = Math.abs(paperContracts - okxContracts);
        const contractTol = Math.max(
            1e-8,
            MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO * okxContracts
        );
        if (contractDiff > contractTol) {
            return { detected: true, reason: "paper_okx_contract_mismatch" };
        }
    }

    const entryPx = input.ledgerEntryPrice;
    const okxPx = input.okxAvgPx;
    if (
        !hasBotOrderAttribution(input.ledger) &&
        entryPx != null &&
        okxPx != null &&
        Number.isFinite(entryPx) &&
        Number.isFinite(okxPx) &&
        entryPx > 0 &&
        okxPx > 0
    ) {
        const priceDiffRatio = Math.abs(entryPx - okxPx) / entryPx;
        if (priceDiffRatio > MANUAL_AVG_PX_MISMATCH_TOLERANCE_RATIO) {
            return { detected: true, reason: "paper_okx_avgpx_mismatch" };
        }
    }

    return { detected: false, reason: null };
}

export function isManualOwnershipLatched(
    ledger: PaperOpenPositionRecord | null | undefined
): boolean {
    return ledger?.manualOwnershipLatch === true;
}

export function resolvePositionOwnership(
    input: PositionOwnershipResolveInput
): PositionOwnershipResolveResult {
    const lifecycleBefore = input.ledger?.lifecycleState ?? null;
    const persistedV2OwnerFound = isBotV2LedgerEvidence(input.ledger);
    const botOrderEvidenceFound =
        persistedV2OwnerFound ||
        (input.ledger != null &&
            typeof input.ledger.exchangeClOrdId === "string" &&
            input.ledger.exchangeClOrdId.startsWith("p"));
    const poisonedRecovery =
        input.ledger != null
            ? evaluatePoisonedStrongManualLatchRecovery({
                  ledger: input.ledger,
                  reconcileState: input.reconcileState ?? input.ledger.reconcileState,
                  okxActualContracts: input.okxActualContracts,
                  okxActualPositionExists: input.okxActualPositionExists,
                  ledgerPaperContracts: input.ledgerPaperContracts,
                  ledgerSide: input.side,
                  okxSide: input.side,
                  syncStatus: input.syncStatus
              })
            : { shouldClear: false, reason: null };
    const latchRecovery =
        poisonedRecovery.shouldClear
            ? poisonedRecovery
            : input.ledger != null
              ? evaluateFalseManualLatchRecovery({
                    ledger: input.ledger,
                    reconcileState: input.reconcileState ?? input.ledger.reconcileState,
                    okxActualContracts: input.okxActualContracts,
                    okxActualPositionExists: input.okxActualPositionExists,
                    ledgerPaperContracts: input.ledgerPaperContracts,
                    syncStatus: input.syncStatus,
                    explicitManualEvidence:
                        input.explicitExternalManualEvidence === true ||
                        hasIndependentManualLifecycleEvidence(input.ledger)
                })
              : { shouldClear: false, reason: null };
    const latchTrigger = evaluateManualOwnershipLatchTrigger({
        ledger: input.ledger,
        syncStatus: input.syncStatus,
        okxActualContracts: input.okxActualContracts,
        okxActualPositionExists: input.okxActualPositionExists,
        okxFetchReady: input.okxFetchReady,
        ledgerPaperContracts: input.ledgerPaperContracts,
        ledgerEntryPrice: input.ledgerEntryPrice,
        okxAvgPx: input.okxAvgPx,
        symbolExternalManualBlocked: input.symbolExternalManualBlocked,
        explicitExternalManualEvidence: input.explicitExternalManualEvidence
    });
    const existingLatch =
        !latchRecovery.shouldClear &&
        (input.manualOwnershipLatchActive === true || isManualOwnershipLatched(input.ledger));
    const strongLatchActive =
        existingLatch &&
        input.ledger != null &&
        isStrongManualLatchSource(
            input.ledger.manualOwnershipLatchSource ?? input.ledger.manualOwnershipLatchReason
        ) &&
        hasIndependentManualLifecycleEvidence(input.ledger);
    const manualIntervention = detectManualInterventionEvidence({
        ledgerPaperContracts: input.ledgerPaperContracts,
        okxActualContracts: input.okxActualContracts,
        ledgerEntryPrice: input.ledgerEntryPrice,
        okxAvgPx: input.okxAvgPx,
        explicitExternalManualEvidence:
            input.explicitExternalManualEvidence === true ||
            isIndependentExternalManualLifecycle(input.ledger),
        symbolExternalManualBlocked: input.symbolExternalManualBlocked,
        manualOwnershipLatchActive: strongLatchActive,
        ledger: input.ledger
    });
    const manualLatchShouldBeActive = latchTrigger.shouldLatch;
    const operationalManualBlock =
        manualIntervention.detected ||
        (input.symbolExternalManualBlocked === true && !botOrderEvidenceFound);
    const baseMeta = {
        manualLatchTriggerSource: latchTrigger.source,
        manualLatchTriggerStrength: latchTrigger.strength,
        latchRecoveryRecommended: latchRecovery.shouldClear,
        latchRecoveryReason: latchRecovery.reason
    };

    if (!input.okxActualPositionExists || !(input.okxActualContracts > 0)) {
        return {
            ownershipClass: "NO_POSITION",
            ownershipSource: "okx_actual_none",
            persistedV2OwnerFound,
            botOrderEvidenceFound,
            externalManualEvidence: strongLatchActive,
            manualOwnershipLatchActive: strongLatchActive,
            manualLatchShouldBeActive: false,
            manualInterventionReason: null,
            automatedOrderMutationBlocked: false,
            ...baseMeta,
            lifecycleBefore,
            lifecycleAfter: lifecycleBefore ?? undefined,
            v2ManagementRestored: false,
            addonManagementAllowed: false,
            normalExitPolicyAllowed: false
        };
    }

    if (
        strongLatchActive ||
        manualIntervention.detected ||
        (manualLatchShouldBeActive && latchTrigger.strength === "STRONG")
    ) {
        return {
            ownershipClass: "EXTERNAL_MANUAL_MANAGED",
            ownershipSource: strongLatchActive
                ? "manual_ownership_latch"
                : manualIntervention.reason ?? latchTrigger.reason ?? "external_manual_evidence",
            persistedV2OwnerFound,
            botOrderEvidenceFound,
            externalManualEvidence: true,
            manualOwnershipLatchActive: strongLatchActive || manualLatchShouldBeActive,
            manualLatchShouldBeActive,
            manualInterventionReason: manualIntervention.reason,
            automatedOrderMutationBlocked: true,
            ...baseMeta,
            lifecycleBefore,
            lifecycleAfter: "EXTERNAL_MANUAL_MANAGED",
            v2ManagementRestored: false,
            addonManagementAllowed: false,
            normalExitPolicyAllowed: false
        };
    }

    if (botOrderEvidenceFound || persistedV2OwnerFound) {
        const priorCloseOnly =
            lifecycleBefore === "CLOSE_ONLY_MANAGED" ||
            lifecycleBefore === "EXTERNAL_MANUAL_MANAGED" ||
            input.ledger?.reconcileState === "ADOPTED";
        const lifecycleAfter: PaperOpenPositionRecord["lifecycleState"] = priorCloseOnly
            ? "BOT_V2_MANAGED"
            : lifecycleBefore === "ADDON_ACTIVE" ||
                lifecycleBefore === "PARTIAL_ACTIVE" ||
                lifecycleBefore === "BOT_V2_MANAGED"
              ? lifecycleBefore
              : "BOT_V2_MANAGED";
        return {
            ownershipClass: "BOT_V2_MANAGED",
            ownershipSource: "okx_actual_plus_v2_ledger_evidence",
            persistedV2OwnerFound,
            botOrderEvidenceFound,
            externalManualEvidence: false,
            manualOwnershipLatchActive: false,
            manualLatchShouldBeActive,
            manualInterventionReason: null,
            automatedOrderMutationBlocked: operationalManualBlock,
            ...baseMeta,
            lifecycleBefore,
            lifecycleAfter,
            v2ManagementRestored: priorCloseOnly,
            addonManagementAllowed: !operationalManualBlock,
            normalExitPolicyAllowed: true
        };
    }

    return {
        ownershipClass: "CLOSE_ONLY_MANAGED",
        ownershipSource: "fail_safe_unclear_ownership",
        persistedV2OwnerFound,
        botOrderEvidenceFound,
        externalManualEvidence: false,
        manualOwnershipLatchActive: false,
        manualLatchShouldBeActive: false,
        manualInterventionReason: null,
        automatedOrderMutationBlocked: operationalManualBlock,
        ...baseMeta,
        lifecycleBefore,
        lifecycleAfter: "CLOSE_ONLY_MANAGED",
        v2ManagementRestored: false,
        addonManagementAllowed: false,
        normalExitPolicyAllowed: true
    };
}

export function isAddonManagementAllowedForOwnership(
    ownership: Pick<PositionOwnershipResolveResult, "ownershipClass" | "addonManagementAllowed">
): boolean {
    return ownership.ownershipClass === "BOT_V2_MANAGED" && ownership.addonManagementAllowed === true;
}

export function isEntryAddonBlockedForOwnership(
    ownership: Pick<PositionOwnershipResolveResult, "ownershipClass" | "automatedOrderMutationBlocked">
): boolean {
    return (
        ownership.ownershipClass === "CLOSE_ONLY_MANAGED" ||
        ownership.ownershipClass === "EXTERNAL_MANUAL_MANAGED" ||
        ownership.automatedOrderMutationBlocked === true
    );
}

export function isAutomatedOrderMutationBlockedForOwnership(
    ownership: Pick<PositionOwnershipResolveResult, "ownershipClass" | "automatedOrderMutationBlocked">
): boolean {
    return (
        ownership.automatedOrderMutationBlocked === true ||
        ownership.ownershipClass === "EXTERNAL_MANUAL_MANAGED"
    );
}

export function buildOwnershipRehydrationProof(
    input: PositionOwnershipResolveInput,
    result: PositionOwnershipResolveResult
): Record<string, unknown> {
    return {
        event: "V2_POSITION_OWNERSHIP_REHYDRATION_PROOF",
        symbol: input.symbol,
        side: input.side,
        okx_actual_position_exists: input.okxActualPositionExists,
        okx_actual_contracts: input.okxActualContracts,
        ledger_paper_contracts: input.ledgerPaperContracts ?? null,
        okx_avg_px: input.okxAvgPx ?? null,
        persisted_v2_owner_found: result.persistedV2OwnerFound,
        bot_order_evidence_found: result.botOrderEvidenceFound,
        external_manual_evidence: result.externalManualEvidence,
        manual_ownership_latch_active: result.manualOwnershipLatchActive,
        manual_latch_should_be_active: result.manualLatchShouldBeActive,
        manual_intervention_reason: result.manualInterventionReason,
        automated_order_mutation_blocked: result.automatedOrderMutationBlocked,
        ownership_source: result.ownershipSource,
        lifecycle_before: result.lifecycleBefore,
        lifecycle_after: result.lifecycleAfter,
        v2_management_restored: result.v2ManagementRestored,
        addon_management_allowed: result.addonManagementAllowed,
        normal_exit_policy_allowed: result.normalExitPolicyAllowed
    };
}
