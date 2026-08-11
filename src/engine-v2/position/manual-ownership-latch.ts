import type { PaperOpenPositionRecord } from "../../models/types";
import {
    isBotAttributedTransientMismatch,
    MANUAL_AVG_PX_MISMATCH_TOLERANCE_RATIO,
    MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO
} from "./ownership-resolver";

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

function isExternalManualLifecycle(ledger: PaperOpenPositionRecord | null): boolean {
    const ls = ledger?.lifecycleState;
    return (
        ls === "EXTERNAL_MANUAL_POSITION" ||
        ls === "OPERATOR_MANAGED" ||
        ls === "EXTERNAL_MANUAL_MANAGED"
    );
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

    if (isExternalManualLifecycle(ledger)) {
        return {
            shouldLatch: true,
            source: "EXPLICIT_MANUAL_LIFECYCLE",
            strength: "STRONG",
            reason: "external_manual_lifecycle_evidence"
        };
    }

    if (input.explicitExternalManualEvidence === true) {
        return {
            shouldLatch: true,
            source: "EXPLICIT_EXTERNAL_FILL",
            strength: "STRONG",
            reason: "explicit_external_manual_evidence"
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
                reason: "paper_okx_contract_mismatch"
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
                    reason: "paper_okx_avgpx_mismatch"
                };
            }
        }
    }

    if (
        hasBotOrderAttribution(ledger) &&
        paperContracts != null &&
        Number.isFinite(paperContracts) &&
        okxContracts > 0 &&
        syncStatus === "ALIGNED"
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
                reason: "paper_okx_contract_mismatch"
            };
        }
    }

    return { shouldLatch: false, source: null, strength: null, reason: null };
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
    const ls = input.ledger.lifecycleState;
    if (ls === "EXTERNAL_MANUAL_POSITION" || ls === "OPERATOR_MANAGED") {
        return { shouldClear: false, reason: null };
    }

    const source =
        input.ledger.manualOwnershipLatchSource ??
        input.ledger.manualOwnershipLatchReason ??
        null;
    if (isStrongManualLatchSource(source)) {
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
}

export function applyManualOwnershipLatch(
    open: PaperOpenPositionRecord,
    input: Readonly<{
        at: number;
        source: string;
        strength: ManualLatchStrength;
        reason: string;
    }>
): void {
    open.manualOwnershipLatch = true;
    open.manualOwnershipLatchSource = input.source;
    open.manualOwnershipLatchStrength = input.strength;
    open.manualOwnershipLatchReason = input.reason;
    open.manualOwnershipLatchAt = input.at;
}

export function buildFalseManualLatchRecoveryProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "V2_FALSE_MANUAL_LATCH_RECOVERY_PROOF", ...input };
}
