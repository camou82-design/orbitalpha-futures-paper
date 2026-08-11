import type { PaperOpenPositionRecord } from "../../models/types";
import { MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO } from "./ownership-resolver";

export type SizeDeltaClassification =
    | "BOT_REDUCE_RECONCILE"
    | "MANUAL_REDUCE_REBASE"
    | "MANUAL_INCREASE"
    | "ALIGNED"
    | "UNKNOWN";

const BOT_REDUCE_FILL_GRACE_MS = 120_000;

function contractTol(baseline: number): number {
    return Math.max(1e-8, MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO * Math.max(baseline, 1));
}

function hasMatchingBotReduceFillEvidence(
    ledger: PaperOpenPositionRecord | null | undefined,
    deltaContracts: number,
    nowMs: number
): boolean {
    if (ledger == null || !(deltaContracts > 0)) return false;

    const tol = contractTol(deltaContracts);
    const processed = ledger.partialPendingProcessedContracts ?? ledger.partialPendingProcessedFillSz ?? null;
    if (processed != null && Number.isFinite(processed) && Math.abs(processed - deltaContracts) <= tol) {
        return true;
    }

    const pending = ledger.partialPendingContracts ?? null;
    if (
        pending != null &&
        Number.isFinite(pending) &&
        Math.abs(pending - deltaContracts) <= tol &&
        (ledger.lifecycleState === "PARTIAL_PENDING" ||
            (typeof ledger.partialPendingOrdId === "string" && ledger.partialPendingOrdId.length > 0) ||
            (typeof ledger.partialPendingClOrdId === "string" && ledger.partialPendingClOrdId.length > 0))
    ) {
        return true;
    }

    const at = ledger.lastBotExecutionAt;
    const reason = String(ledger.lastBotExecutionReason ?? "").toLowerCase();
    const recentBotExec =
        at != null &&
        Number.isFinite(at) &&
        nowMs - at >= 0 &&
        nowMs - at <= BOT_REDUCE_FILL_GRACE_MS &&
        (reason.includes("reduce") ||
            reason.includes("partial") ||
            reason.includes("stop_loss") ||
            reason.includes("v2_partial") ||
            reason.includes("v2_exit") ||
            reason.includes("executor_"));

    if (!recentBotExec) return false;

    if (
        (typeof ledger.closePendingOrdId === "string" && ledger.closePendingOrdId.length > 0) ||
        (typeof ledger.closePendingClOrdId === "string" && ledger.closePendingClOrdId.length > 0)
    ) {
        return true;
    }

    if (pending != null && Number.isFinite(pending) && Math.abs(pending - deltaContracts) <= tol) {
        return true;
    }

    return false;
}

function hasBotAddonEvidence(ledger: PaperOpenPositionRecord | null | undefined, nowMs: number): boolean {
    if (ledger == null) return false;
    if (ledger.addonRebuildPendingConfirmation === true || ledger.addonRebuildRequired === true) {
        return true;
    }
    const rebuildStartedAt = ledger.addonRebuildMetrics?.rebuildStartedAt;
    if (
        rebuildStartedAt != null &&
        Number.isFinite(rebuildStartedAt) &&
        nowMs - rebuildStartedAt >= 0 &&
        nowMs - rebuildStartedAt <= BOT_REDUCE_FILL_GRACE_MS
    ) {
        return true;
    }
    const reason = String(ledger.lastBotExecutionReason ?? "").toLowerCase();
    const at = ledger.lastBotExecutionAt;
    if (
        at != null &&
        Number.isFinite(at) &&
        nowMs - at >= 0 &&
        nowMs - at <= BOT_REDUCE_FILL_GRACE_MS &&
        (reason.includes("addon") || reason.includes("pyramid") || reason.includes("enter"))
    ) {
        return true;
    }
    return false;
}

export function classifyPositionSizeDelta(input: Readonly<{
    beforeContracts: number;
    afterContracts: number;
    ledger?: PaperOpenPositionRecord | null;
    botManaged?: boolean;
    nowMs?: number;
}>): Readonly<{
    classification: SizeDeltaClassification;
    deltaContracts: number;
    botFillEvidenceFound: boolean;
    matchingBotReduceContracts: number | null;
}> {
    const before = input.beforeContracts;
    const after = input.afterContracts;
    const deltaSigned = before - after;
    const deltaAbs = Math.abs(deltaSigned);
    const tol = contractTol(Math.max(before, after, 1));
    const nowMs = input.nowMs ?? Date.now();

    if (deltaAbs <= tol) {
        return {
            classification: "ALIGNED",
            deltaContracts: deltaSigned,
            botFillEvidenceFound: false,
            matchingBotReduceContracts: null
        };
    }

    if (deltaSigned > tol) {
        const botFillEvidenceFound = hasMatchingBotReduceFillEvidence(input.ledger, deltaAbs, nowMs);
        if (botFillEvidenceFound) {
            return {
                classification: "BOT_REDUCE_RECONCILE",
                deltaContracts: deltaSigned,
                botFillEvidenceFound: true,
                matchingBotReduceContracts: deltaAbs
            };
        }
        if (input.botManaged === true) {
            return {
                classification: "MANUAL_REDUCE_REBASE",
                deltaContracts: deltaSigned,
                botFillEvidenceFound: false,
                matchingBotReduceContracts: null
            };
        }
        return {
            classification: "UNKNOWN",
            deltaContracts: deltaSigned,
            botFillEvidenceFound: false,
            matchingBotReduceContracts: null
        };
    }

    if (after > before + tol) {
        const botAddon = hasBotAddonEvidence(input.ledger, nowMs);
        if (botAddon) {
            return {
                classification: "BOT_REDUCE_RECONCILE",
                deltaContracts: deltaSigned,
                botFillEvidenceFound: true,
                matchingBotReduceContracts: null
            };
        }
        return {
            classification: "MANUAL_INCREASE",
            deltaContracts: deltaSigned,
            botFillEvidenceFound: false,
            matchingBotReduceContracts: null
        };
    }

    return {
        classification: "UNKNOWN",
        deltaContracts: deltaSigned,
        botFillEvidenceFound: false,
        matchingBotReduceContracts: null
    };
}

export function buildV2ManualReduceRebaseProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_MANUAL_REDUCE_REBASE_PROOF", ...input };
}
