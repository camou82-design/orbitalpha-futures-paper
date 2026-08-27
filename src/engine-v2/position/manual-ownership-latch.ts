import type { PaperOpenPositionRecord } from "../../models/types";
import {
    isBotAttributedTransientMismatch,
    MANUAL_AVG_PX_MISMATCH_TOLERANCE_RATIO,
    MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO
} from "./ownership-resolver";
import { isBotSizeReconcilePendingSyncStatus } from "../../lib/position-reconcile-classification";

export type ManualLatchStrength = "STRONG" | "WEAK" | "LEGACY";

export const STRONG_MANUAL_LATCH_SOURCES = new Set([
    "EXPLICIT_EXTERNAL_FILL",
    "CONFIRMED_MANUAL_SIZE_CHANGE",
    "EXPLICIT_MANUAL_LIFECYCLE",
    "external_manual_lifecycle_evidence"
]);

export const FORBIDDEN_LATCH_SYNC_STATUSES = new Set([
    "KEY_MISMATCH",
    "REMOTE_UNAVAILABLE",
    "LEDGER_ONLY",
    "OKX_ONLY"
]);

export const FORBIDDEN_LATCH_TRIGGER_REASONS = new Set([
    "KEY_MISMATCH",
    "TRANSIENT_OKX_ZERO",
    "OKX_ZERO_UNCONFIRMED",
    "OKX_FETCH_FAILURE",
    "REMOTE_UNAVAILABLE",
    "symbol_external_manual_blocked",
    "manual_ownership_latch_active",
    "paper_okx_contract_mismatch_transient",
    "paper_okx_avgpx_mismatch_transient"
]);

/** Circular / derived origins — must never justify EXPLICIT_MANUAL_LIFECYCLE STRONG. */
export const DERIVED_MANUAL_EVIDENCE_ORIGINS = new Set([
    "DERIVED_FROM_LIFECYCLE_STATE",
    "DERIVED_FROM_EXISTING_LATCH",
    "DERIVED_FROM_OWNERSHIP_CLASS",
    "DERIVED_FROM_RECONCILE_MISMATCH",
    "TRANSIENT_OKX_STATE"
]);

export const INDEPENDENT_MANUAL_EVIDENCE_ORIGINS = new Set([
    "INDEPENDENT_EXTERNAL_FILL",
    "INDEPENDENT_MANUAL_ADOPTION",
    "INDEPENDENT_CONFIRMED_SIZE_CHANGE",
    "INDEPENDENT_USER_MANUAL_FLAG"
]);

/** True external/manual lifecycle origins — not derived from latch feedback. */
export function isIndependentExternalManualLifecycle(
    ledger: PaperOpenPositionRecord | null | undefined
): boolean {
    const ls = ledger?.lifecycleState;
    return ls === "EXTERNAL_MANUAL_POSITION" || ls === "OPERATOR_MANAGED";
}

function hasBotOrderAttribution(ledger: PaperOpenPositionRecord | null | undefined): boolean {
    if (ledger == null) return false;
    if (ledger.isV2Authority === true) return true;
    const authSrc = String(ledger.authoritySourceAtEntry ?? ledger.authority ?? "").trim().toLowerCase();
    if (authSrc === "v2") return true;
    return String(ledger.exchangeClOrdId ?? "").startsWith("p");
}

function contractsAligned(paper: number, okx: number): boolean {
    const contractTol = Math.max(1e-8, MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO * okx);
    return Math.abs(paper - okx) <= contractTol;
}

export function inferManualLatchStrength(
    source: string | null | undefined
): ManualLatchStrength {
    const s = String(source ?? "").trim();
    if (!s) return "LEGACY";
    if (STRONG_MANUAL_LATCH_SOURCES.has(s)) return "STRONG";
    if (
        s === "paper_okx_contract_mismatch" ||
        s === "paper_okx_avgpx_mismatch" ||
        s === "symbol_external_manual_blocked"
    ) {
        return "WEAK";
    }
    return "LEGACY";
}

export function isStrongManualLatchSource(source: string | null | undefined): boolean {
    return inferManualLatchStrength(source) === "STRONG";
}

export function isWeakOrLegacyManualLatchSource(source: string | null | undefined): boolean {
    const strength = inferManualLatchStrength(source);
    return strength === "WEAK" || strength === "LEGACY";
}

export function hasIndependentManualLifecycleEvidence(
    ledger: PaperOpenPositionRecord | null | undefined
): boolean {
    if (ledger == null) return false;
    if (ledger.manualLifecycleEvidenceIndependent === true) return true;
    if (ledger.manualLifecycleEvidenceIndependent === false) return false;

    if (isIndependentExternalManualLifecycle(ledger)) return true;

    const source = String(
        ledger.manualOwnershipLatchSource ?? ledger.manualOwnershipLatchReason ?? ""
    ).trim();
    if (source === "EXPLICIT_EXTERNAL_FILL") return true;
    if (source === "CONFIRMED_MANUAL_SIZE_CHANGE") return true;
    if (source === "EXPLICIT_MANUAL_LIFECYCLE" || source === "external_manual_lifecycle_evidence") {
        return false;
    }
    return false;
}

function resolveLatchEvidenceProvenance(
    input: Readonly<{
        source: string;
        strength: ManualLatchStrength;
        reason: string;
        at: number;
        evidenceOrigin?: string | null;
        evidenceId?: string | null;
        evidenceIndependent?: boolean | null;
    }>,
    ledger: PaperOpenPositionRecord | null
): Readonly<{
    origin: string;
    id: string;
    at: number;
    independent: boolean;
}> {
    if (input.evidenceOrigin != null && input.evidenceOrigin.length > 0) {
        return {
            origin: input.evidenceOrigin,
            id: String(input.evidenceId ?? input.reason),
            at: input.evidenceId != null ? input.at : (ledger?.manualLifecycleEvidenceAt ?? input.at),
            independent: input.evidenceIndependent === true
        };
    }

    switch (input.source) {
        case "EXPLICIT_EXTERNAL_FILL":
            return {
                origin: "INDEPENDENT_EXTERNAL_FILL",
                id: input.reason,
                at: input.at,
                independent: true
            };
        case "CONFIRMED_MANUAL_SIZE_CHANGE":
            return {
                origin: "INDEPENDENT_CONFIRMED_SIZE_CHANGE",
                id: input.reason,
                at: input.at,
                independent: true
            };
        case "EXPLICIT_MANUAL_LIFECYCLE":
            if (isIndependentExternalManualLifecycle(ledger)) {
                return {
                    origin: "INDEPENDENT_MANUAL_ADOPTION",
                    id: String(ledger?.lifecycleState ?? input.reason),
                    at: input.at,
                    independent: true
                };
            }
            return {
                origin: "DERIVED_FROM_LIFECYCLE_STATE",
                id: String(ledger?.lifecycleState ?? input.reason),
                at: input.at,
                independent: false
            };
        default:
            return {
                origin: "DERIVED_FROM_EXISTING_LATCH",
                id: input.reason,
                at: input.at,
                independent: false
            };
    }
}

export function validateStrongManualLatchEvidence(input: Readonly<{
    symbol: string;
    requested_source: string;
    requested_strength: ManualLatchStrength;
    ledger: PaperOpenPositionRecord | null;
    evidenceOrigin?: string | null;
    evidenceIndependent?: boolean | null;
    existing_latch?: boolean;
    current_lifecycle?: string | null;
}>): Readonly<{
    strongLatchAllowed: boolean;
    blockReason: string | null;
    evidenceOrigin: string;
    evidenceIndependent: boolean;
}> {
    const provenance = resolveLatchEvidenceProvenance(
        {
            source: input.requested_source,
            strength: input.requested_strength,
            reason: input.requested_source,
            at: Date.now(),
            evidenceOrigin: input.evidenceOrigin,
            evidenceIndependent: input.evidenceIndependent
        },
        input.ledger
    );
    const evidenceOrigin = provenance.origin;
    const evidenceIndependent = provenance.independent;

    if (input.requested_strength !== "STRONG") {
        return {
            strongLatchAllowed: true,
            blockReason: null,
            evidenceOrigin,
            evidenceIndependent
        };
    }

    if (DERIVED_MANUAL_EVIDENCE_ORIGINS.has(evidenceOrigin)) {
        return {
            strongLatchAllowed: false,
            blockReason: `derived_evidence_origin:${evidenceOrigin}`,
            evidenceOrigin,
            evidenceIndependent
        };
    }

    if (input.requested_source === "EXPLICIT_MANUAL_LIFECYCLE" && evidenceIndependent !== true) {
        return {
            strongLatchAllowed: false,
            blockReason: "explicit_manual_lifecycle_missing_independent_evidence",
            evidenceOrigin,
            evidenceIndependent
        };
    }

    if (
        input.requested_source === "EXPLICIT_MANUAL_LIFECYCLE" ||
        input.requested_source === "external_manual_lifecycle_evidence"
    ) {
        if (input.current_lifecycle === "EXTERNAL_MANUAL_MANAGED") {
            return {
                strongLatchAllowed: false,
                blockReason: "derived_external_manual_managed_lifecycle",
                evidenceOrigin,
                evidenceIndependent
            };
        }
    }

    if (evidenceIndependent !== true) {
        return {
            strongLatchAllowed: false,
            blockReason: "missing_independent_manual_evidence",
            evidenceOrigin,
            evidenceIndependent
        };
    }

    return {
        strongLatchAllowed: true,
        blockReason: null,
        evidenceOrigin,
        evidenceIndependent
    };
}

export function buildManualLatchStrongEvidenceProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_MANUAL_LATCH_STRONG_EVIDENCE_PROOF", ...input };
}

export function evaluateManualOwnershipLatchTrigger(input: Readonly<{
    ledger: PaperOpenPositionRecord | null;
    syncStatus?: string | null;
    okxActualContracts: number;
    okxActualPositionExists: boolean;
    okxFetchReady?: boolean;
    ledgerPaperContracts?: number | null;
    ledgerEntryPrice?: number | null;
    okxAvgPx?: number | null;
    symbolExternalManualBlocked?: boolean;
    explicitExternalManualEvidence?: boolean;
    nowMs?: number;
}>): Readonly<{
    shouldLatch: boolean;
    source: string | null;
    strength: ManualLatchStrength | null;
    reason: string | null;
    evidenceOrigin?: string | null;
    evidenceIndependent?: boolean | null;
}> {
    const ledger = input.ledger;
    const nowMs = input.nowMs ?? Date.now();
    const syncStatus = String(input.syncStatus ?? "").trim();

    if (input.okxFetchReady === false) {
        return { shouldLatch: false, source: null, strength: null, reason: "OKX_FETCH_FAILURE" };
    }
    if (FORBIDDEN_LATCH_SYNC_STATUSES.has(syncStatus)) {
        return { shouldLatch: false, source: null, strength: null, reason: syncStatus || "SYNC_STATUS_FORBIDDEN" };
    }
    if (input.okxActualPositionExists !== true || !(input.okxActualContracts > 0)) {
        return { shouldLatch: false, source: null, strength: null, reason: "TRANSIENT_OKX_ZERO" };
    }
    if (isBotAttributedTransientMismatch(ledger, nowMs)) {
        return { shouldLatch: false, source: null, strength: null, reason: "BOT_ATTRIBUTED_TRANSIENT_MISMATCH" };
    }
    if (input.symbolExternalManualBlocked === true) {
        return {
            shouldLatch: false,
            source: null,
            strength: null,
            reason: "symbol_external_manual_blocked_transient"
        };
    }

    // Only independent external lifecycle (not derived EXTERNAL_MANUAL_MANAGED) may trigger STRONG latch.
    if (isIndependentExternalManualLifecycle(ledger)) {
        return {
            shouldLatch: true,
            source: "EXPLICIT_MANUAL_LIFECYCLE",
            strength: "STRONG",
            reason: "external_manual_lifecycle_evidence",
            evidenceOrigin: "INDEPENDENT_MANUAL_ADOPTION",
            evidenceIndependent: true
        };
    }

    if (input.explicitExternalManualEvidence === true) {
        return {
            shouldLatch: true,
            source: "EXPLICIT_EXTERNAL_FILL",
            strength: "STRONG",
            reason: "explicit_external_manual_evidence",
            evidenceOrigin: "INDEPENDENT_EXTERNAL_FILL",
            evidenceIndependent: true
        };
    }

    const paperContracts = input.ledgerPaperContracts;
    const okxContracts = input.okxActualContracts;
    if (
        paperContracts != null &&
        Number.isFinite(paperContracts) &&
        okxContracts > 0 &&
        hasBotOrderAttribution(ledger) === false
    ) {
        const contractDiff = Math.abs(paperContracts - okxContracts);
        const contractTol = Math.max(
            1e-8,
            MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO * okxContracts
        );
        if (contractDiff > contractTol) {
            return {
                shouldLatch: true,
                source: "CONFIRMED_MANUAL_SIZE_CHANGE",
                strength: "STRONG",
                reason: "paper_okx_contract_mismatch",
                evidenceOrigin: "INDEPENDENT_CONFIRMED_SIZE_CHANGE",
                evidenceIndependent: true
            };
        }
    }

    if (
        !hasBotOrderAttribution(ledger) &&
        paperContracts != null &&
        Number.isFinite(paperContracts) &&
        okxContracts > 0
    ) {
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
                return {
                    shouldLatch: true,
                    source: "CONFIRMED_MANUAL_SIZE_CHANGE",
                    strength: "STRONG",
                    reason: "paper_okx_avgpx_mismatch",
                    evidenceOrigin: "INDEPENDENT_CONFIRMED_SIZE_CHANGE",
                    evidenceIndependent: true
                };
            }
        }
    }

    if (
        hasBotOrderAttribution(ledger) &&
        paperContracts != null &&
        Number.isFinite(paperContracts) &&
        okxContracts > 0
    ) {
        const contractDiffSigned = okxContracts - paperContracts;
        const contractTol = Math.max(
            1e-8,
            MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO * okxContracts
        );
        if (contractDiffSigned > contractTol) {
            if (
                isBotAttributedTransientMismatch(ledger, nowMs) ||
                isBotSizeReconcilePendingSyncStatus(syncStatus)
            ) {
                return { shouldLatch: false, source: null, strength: null, reason: "BOT_ATTRIBUTED_TRANSIENT_MISMATCH" };
            }
            return {
                shouldLatch: true,
                source: "CONFIRMED_MANUAL_SIZE_CHANGE",
                strength: "STRONG",
                reason: "paper_okx_contract_mismatch",
                evidenceOrigin: "INDEPENDENT_CONFIRMED_SIZE_CHANGE",
                evidenceIndependent: true
            };
        }
    }

    return { shouldLatch: false, source: null, strength: null, reason: null };
}

export function evaluatePoisonedStrongManualLatchRecovery(input: Readonly<{
    ledger: PaperOpenPositionRecord;
    reconcileState?: string | null;
    okxActualContracts: number;
    okxActualPositionExists: boolean;
    ledgerPaperContracts?: number | null;
    ledgerSide?: "long" | "short" | null;
    okxSide?: "long" | "short" | null;
    syncStatus?: string | null;
}>): Readonly<{ shouldClear: boolean; reason: string | null }> {
    if (input.ledger.manualOwnershipLatch !== true) {
        return { shouldClear: false, reason: null };
    }

    if (input.ledger.manualTakeoverActive === true || input.ledger.lifecycleState === "OPERATOR_MANAGED") {
        return { shouldClear: false, reason: null };
    }

    if (hasIndependentManualLifecycleEvidence(input.ledger)) {
        return { shouldClear: false, reason: null };
    }

    const source = String(
        input.ledger.manualOwnershipLatchSource ??
            input.ledger.manualOwnershipLatchReason ??
            ""
    ).trim();
    const strength =
        input.ledger.manualOwnershipLatchStrength ?? inferManualLatchStrength(source);

    if (strength !== "STRONG") {
        return { shouldClear: false, reason: null };
    }

    if (source === "EXPLICIT_EXTERNAL_FILL") {
        return { shouldClear: false, reason: null };
    }
    if (isIndependentExternalManualLifecycle(input.ledger)) {
        return { shouldClear: false, reason: null };
    }

    const reconcileState = String(input.reconcileState ?? input.ledger.reconcileState ?? "");
    const ledgerSide = input.ledgerSide ?? input.ledger.side ?? null;
    const okxSide = input.okxSide ?? ledgerSide;
    if (ledgerSide != null && okxSide != null && ledgerSide !== okxSide) {
        return { shouldClear: false, reason: null };
    }

    const paperContracts = input.ledgerPaperContracts ?? input.ledger.okxContracts ?? null;
    const botAttributed = hasBotOrderAttribution(input.ledger);
    const contractDeltaExplainedByBot =
        input.okxActualPositionExists === true &&
        input.okxActualContracts > 0 &&
        paperContracts != null &&
        Number.isFinite(paperContracts) &&
        paperContracts > input.okxActualContracts &&
        botAttributed;

    if (source === "CONFIRMED_MANUAL_SIZE_CHANGE") {
        if (
            botAttributed &&
            !hasIndependentManualLifecycleEvidence(input.ledger) &&
            (contractDeltaExplainedByBot ||
                reconcileState === "MATCHED" ||
                String(input.syncStatus ?? "") === "ALIGNED" ||
                String(input.syncStatus ?? "") === "BOT_POSITION_SIZE_RECONCILE_PENDING")
        ) {
            return { shouldClear: true, reason: "confirmed_manual_size_change_bot_attribution_recovery" };
        }
        return { shouldClear: false, reason: null };
    }

    if (reconcileState !== "MATCHED") {
        return { shouldClear: false, reason: null };
    }

    const aligned =
        input.okxActualPositionExists === true &&
        input.okxActualContracts > 0 &&
        paperContracts != null &&
        Number.isFinite(paperContracts) &&
        contractsAligned(paperContracts, input.okxActualContracts);

    if (!aligned || !botAttributed) {
        return { shouldClear: false, reason: null };
    }

    if (
        source === "EXPLICIT_MANUAL_LIFECYCLE" ||
        source === "external_manual_lifecycle_evidence"
    ) {
        return { shouldClear: true, reason: "poisoned_explicit_manual_lifecycle_strong_recovery" };
    }

    return { shouldClear: false, reason: null };
}

export function buildPoisonedStrongManualLatchRecoveryProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "V2_POISONED_STRONG_MANUAL_LATCH_RECOVERY_PROOF", ...input };
}

export function evaluateFalseManualLatchRecovery(input: Readonly<{
    ledger: PaperOpenPositionRecord;
    reconcileState?: string | null;
    okxActualContracts: number;
    okxActualPositionExists: boolean;
    ledgerPaperContracts?: number | null;
    syncStatus?: string | null;
    explicitManualEvidence?: boolean;
}>): Readonly<{ shouldClear: boolean; reason: string | null }> {
    if (input.ledger.manualOwnershipLatch !== true) {
        return { shouldClear: false, reason: null };
    }
    if (input.explicitManualEvidence === true) {
        return { shouldClear: false, reason: null };
    }
    if (isIndependentExternalManualLifecycle(input.ledger)) {
        return { shouldClear: false, reason: null };
    }

    const source =
        input.ledger.manualOwnershipLatchSource ??
        input.ledger.manualOwnershipLatchReason ??
        null;
    if (isStrongManualLatchSource(source) && hasIndependentManualLifecycleEvidence(input.ledger)) {
        return { shouldClear: false, reason: null };
    }

    const reconcileState = String(input.reconcileState ?? input.ledger.reconcileState ?? "");
    const paperContracts = input.ledgerPaperContracts ?? input.ledger.okxContracts ?? null;
    const aligned =
        input.okxActualPositionExists === true &&
        input.okxActualContracts > 0 &&
        paperContracts != null &&
        contractsAligned(paperContracts, input.okxActualContracts);

    if (
        (reconcileState === "MATCHED" || String(input.syncStatus ?? "") === "ALIGNED") &&
        aligned &&
        hasBotOrderAttribution(input.ledger)
    ) {
        return { shouldClear: true, reason: "matched_bot_attribution_false_latch_recovery" };
    }

    return { shouldClear: false, reason: null };
}

export function clearManualOwnershipLatchFields(open: PaperOpenPositionRecord): void {
    open.manualOwnershipLatch = undefined;
    open.manualOwnershipLatchReason = undefined;
    open.manualOwnershipLatchAt = undefined;
    open.manualOwnershipLatchSource = undefined;
    open.manualOwnershipLatchStrength = undefined;
    open.manualLifecycleEvidenceOrigin = undefined;
    open.manualLifecycleEvidenceId = undefined;
    open.manualLifecycleEvidenceAt = undefined;
    open.manualLifecycleEvidenceIndependent = undefined;
}

export function applyManualOwnershipLatch(
    open: PaperOpenPositionRecord,
    input: Readonly<{
        at: number;
        source: string;
        strength: ManualLatchStrength;
        reason: string;
        evidenceOrigin?: string | null;
        evidenceId?: string | null;
        evidenceIndependent?: boolean | null;
    }>
): void {
    const provenance = resolveLatchEvidenceProvenance(input, open);
    open.manualOwnershipLatch = true;
    open.manualOwnershipLatchSource = input.source;
    open.manualOwnershipLatchStrength = input.strength;
    open.manualOwnershipLatchReason = input.reason;
    open.manualOwnershipLatchAt = input.at;
    open.manualLifecycleEvidenceOrigin = provenance.origin;
    open.manualLifecycleEvidenceId = provenance.id;
    open.manualLifecycleEvidenceAt = provenance.at;
    open.manualLifecycleEvidenceIndependent = provenance.independent;
}

export function applyManualOwnershipLatchGuarded(
    open: PaperOpenPositionRecord,
    input: Readonly<{
        at: number;
        source: string;
        strength: ManualLatchStrength;
        reason: string;
        evidenceOrigin?: string | null;
        evidenceId?: string | null;
        evidenceIndependent?: boolean | null;
    }>,
    context: Readonly<{ symbol: string }>
): Readonly<{ applied: boolean; proof: Record<string, unknown> }> {
    const validation = validateStrongManualLatchEvidence({
        symbol: context.symbol,
        requested_source: input.source,
        requested_strength: input.strength,
        ledger: open,
        evidenceOrigin: input.evidenceOrigin,
        evidenceIndependent: input.evidenceIndependent,
        existing_latch: open.manualOwnershipLatch === true,
        current_lifecycle: open.lifecycleState ?? null
    });

    const proof = buildManualLatchStrongEvidenceProof({
        symbol: context.symbol,
        requested_source: input.source,
        requested_strength: input.strength,
        evidence_origin: validation.evidenceOrigin,
        evidence_independent: validation.evidenceIndependent,
        existing_latch: open.manualOwnershipLatch === true,
        current_lifecycle: open.lifecycleState ?? null,
        strong_latch_allowed: validation.strongLatchAllowed,
        block_reason: validation.blockReason
    });

    if (input.strength === "STRONG" && !validation.strongLatchAllowed) {
        return { applied: false, proof };
    }

    applyManualOwnershipLatch(open, {
        ...input,
        evidenceOrigin: validation.evidenceOrigin,
        evidenceIndependent: validation.evidenceIndependent
    });
    return { applied: true, proof };
}

export function buildFalseManualLatchRecoveryProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "V2_FALSE_MANUAL_LATCH_RECOVERY_PROOF", ...input };
}
