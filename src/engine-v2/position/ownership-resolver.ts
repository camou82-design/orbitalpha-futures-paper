import type { PaperOpenPositionRecord } from "../../models/types";

export type PositionOwnershipClass =
    | "BOT_V2_MANAGED"
    | "EXTERNAL_MANUAL_MANAGED"
    | "CLOSE_ONLY_MANAGED"
    | "NO_POSITION";

export type PositionOwnershipResolveInput = Readonly<{
    symbol: string;
    side: "long" | "short";
    okxActualPositionExists: boolean;
    okxActualContracts: number;
    ledger: PaperOpenPositionRecord | null;
    externalManualEvidence: boolean;
    symbolExternalManualBlocked: boolean;
}>;

export type PositionOwnershipResolveResult = Readonly<{
    ownershipClass: PositionOwnershipClass;
    ownershipSource: string;
    persistedV2OwnerFound: boolean;
    botOrderEvidenceFound: boolean;
    externalManualEvidence: boolean;
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

function isExternalManualEvidence(input: PositionOwnershipResolveInput): boolean {
    if (input.externalManualEvidence) return true;
    if (input.symbolExternalManualBlocked) return true;
    const ls = input.ledger?.lifecycleState;
    return (
        ls === "EXTERNAL_MANUAL_POSITION" ||
        ls === "OPERATOR_MANAGED" ||
        ls === "EXTERNAL_MANUAL_MANAGED"
    );
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
    const externalManualEvidence = isExternalManualEvidence(input);

    if (!input.okxActualPositionExists || !(input.okxActualContracts > 0)) {
        return {
            ownershipClass: "NO_POSITION",
            ownershipSource: "okx_actual_none",
            persistedV2OwnerFound,
            botOrderEvidenceFound,
            externalManualEvidence,
            lifecycleBefore,
            lifecycleAfter: lifecycleBefore ?? undefined,
            v2ManagementRestored: false,
            addonManagementAllowed: false,
            normalExitPolicyAllowed: false
        };
    }

    if (externalManualEvidence) {
        const lifecycleAfter: PaperOpenPositionRecord["lifecycleState"] =
            input.ledger?.lifecycleState === "EXTERNAL_MANUAL_POSITION"
                ? "EXTERNAL_MANUAL_POSITION"
                : "CLOSE_ONLY_MANAGED";
        return {
            ownershipClass: "EXTERNAL_MANUAL_MANAGED",
            ownershipSource: "external_manual_evidence",
            persistedV2OwnerFound,
            botOrderEvidenceFound,
            externalManualEvidence: true,
            lifecycleBefore,
            lifecycleAfter,
            v2ManagementRestored: false,
            addonManagementAllowed: false,
            normalExitPolicyAllowed: true
        };
    }

    if (botOrderEvidenceFound || persistedV2OwnerFound) {
        const priorCloseOnly =
            lifecycleBefore === "CLOSE_ONLY_MANAGED" ||
            input.ledger?.reconcileState === "ADOPTED";
        const lifecycleAfter: PaperOpenPositionRecord["lifecycleState"] = priorCloseOnly
            ? "BOT_V2_MANAGED"
            : (lifecycleBefore === "ADDON_ACTIVE" ||
                  lifecycleBefore === "PARTIAL_ACTIVE" ||
                  lifecycleBefore === "BOT_V2_MANAGED"
                  ? lifecycleBefore
                  : "BOT_V2_MANAGED");
        return {
            ownershipClass: "BOT_V2_MANAGED",
            ownershipSource: "okx_actual_plus_v2_ledger_evidence",
            persistedV2OwnerFound,
            botOrderEvidenceFound,
            externalManualEvidence: false,
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
    ownership: Pick<PositionOwnershipResolveResult, "ownershipClass">
): boolean {
    return (
        ownership.ownershipClass === "CLOSE_ONLY_MANAGED" ||
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
        persisted_v2_owner_found: result.persistedV2OwnerFound,
        bot_order_evidence_found: result.botOrderEvidenceFound,
        external_manual_evidence: result.externalManualEvidence,
        ownership_source: result.ownershipSource,
        lifecycle_before: result.lifecycleBefore,
        lifecycle_after: result.lifecycleAfter,
        v2_management_restored: result.v2ManagementRestored,
        addon_management_allowed: result.addonManagementAllowed,
        normal_exit_policy_allowed: result.normalExitPolicyAllowed
    };
}
