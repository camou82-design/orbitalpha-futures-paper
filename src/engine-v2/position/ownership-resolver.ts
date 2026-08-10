import type { PaperOpenPositionRecord } from "../../models/types";

export type PositionOwnershipClass =
    | "BOT_V2_MANAGED"
    | "EXTERNAL_MANUAL_MANAGED"
    | "CLOSE_ONLY_MANAGED"
    | "NO_POSITION";

/** Contract mismatch tolerance aligned with reconcile contract tolerance. */
export const MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO = 0.001;

/** AvgPx mismatch tolerance aligned with reconcile price tolerance. */
export const MANUAL_AVG_PX_MISMATCH_TOLERANCE_RATIO = 0.0005;

export type PositionOwnershipResolveInput = Readonly<{
    symbol: string;
    side: "long" | "short";
    okxActualPositionExists: boolean;
    okxActualContracts: number;
    ledger: PaperOpenPositionRecord | null;
    ledgerPaperContracts?: number | null;
    ledgerEntryPrice?: number | null;
    okxAvgPx?: number | null;
    externalManualEvidence: boolean;
    symbolExternalManualBlocked: boolean;
    manualOwnershipLatchActive?: boolean;
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
    const clOrdId = String(ledger.exchangeClOrdId ?? "");
    if (clOrdId.startsWith("p")) return true;
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

function isExternalManualLifecycle(ledger: PaperOpenPositionRecord | null): boolean {
    const ls = ledger?.lifecycleState;
    return (
        ls === "EXTERNAL_MANUAL_POSITION" ||
        ls === "OPERATOR_MANAGED" ||
        ls === "EXTERNAL_MANUAL_MANAGED"
    );
}

export function detectManualInterventionEvidence(
    input: Pick<
        PositionOwnershipResolveInput,
        | "ledgerPaperContracts"
        | "okxActualContracts"
        | "ledgerEntryPrice"
        | "okxAvgPx"
        | "externalManualEvidence"
        | "symbolExternalManualBlocked"
        | "manualOwnershipLatchActive"
    >
): { detected: boolean; reason: string | null } {
    if (input.manualOwnershipLatchActive === true) {
        return { detected: true, reason: "manual_ownership_latch_active" };
    }
    if (input.externalManualEvidence || input.symbolExternalManualBlocked) {
        return {
            detected: true,
            reason: input.symbolExternalManualBlocked
                ? "symbol_external_manual_blocked"
                : "external_manual_lifecycle_evidence"
        };
    }

    const paperContracts = input.ledgerPaperContracts;
    const okxContracts = input.okxActualContracts;
    if (
        paperContracts != null &&
        Number.isFinite(paperContracts) &&
        okxContracts > 0
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
    const manualLatchActive =
        input.manualOwnershipLatchActive === true ||
        isManualOwnershipLatched(input.ledger);
    const manualIntervention = detectManualInterventionEvidence({
        ledgerPaperContracts: input.ledgerPaperContracts,
        okxActualContracts: input.okxActualContracts,
        ledgerEntryPrice: input.ledgerEntryPrice,
        okxAvgPx: input.okxAvgPx,
        externalManualEvidence: input.externalManualEvidence || isExternalManualLifecycle(input.ledger),
        symbolExternalManualBlocked: input.symbolExternalManualBlocked,
        manualOwnershipLatchActive: manualLatchActive
    });
    const manualLatchShouldBeActive = manualIntervention.detected;
    const automatedOrderMutationBlocked = manualIntervention.detected;

    if (!input.okxActualPositionExists || !(input.okxActualContracts > 0)) {
        return {
            ownershipClass: "NO_POSITION",
            ownershipSource: "okx_actual_none",
            persistedV2OwnerFound,
            botOrderEvidenceFound,
            externalManualEvidence: manualIntervention.detected,
            manualOwnershipLatchActive: false,
            manualLatchShouldBeActive: false,
            manualInterventionReason: null,
            automatedOrderMutationBlocked: false,
            lifecycleBefore,
            lifecycleAfter: lifecycleBefore ?? undefined,
            v2ManagementRestored: false,
            addonManagementAllowed: false,
            normalExitPolicyAllowed: false
        };
    }

    if (manualIntervention.detected) {
        return {
            ownershipClass: "EXTERNAL_MANUAL_MANAGED",
            ownershipSource: manualLatchActive
                ? "manual_ownership_latch"
                : manualIntervention.reason ?? "external_manual_evidence",
            persistedV2OwnerFound,
            botOrderEvidenceFound,
            externalManualEvidence: true,
            manualOwnershipLatchActive: manualLatchActive || manualLatchShouldBeActive,
            manualLatchShouldBeActive,
            manualInterventionReason: manualIntervention.reason,
            automatedOrderMutationBlocked: true,
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
            manualLatchShouldBeActive: false,
            manualInterventionReason: null,
            automatedOrderMutationBlocked: false,
            lifecycleBefore,
            lifecycleAfter,
            v2ManagementRestored: priorCloseOnly,
            addonManagementAllowed: true,
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
        automatedOrderMutationBlocked: false,
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
