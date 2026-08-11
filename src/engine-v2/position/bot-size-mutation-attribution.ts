import type { PaperOpenPositionRecord } from "../../models/types";
import { MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO } from "./ownership-resolver";

export type PositionSizeMutationAttribution = "BOT" | "MANUAL" | "UNKNOWN";

const BOT_REDUCE_REASON_MARKERS = [
    "stop_loss",
    "partial",
    "reduce",
    "v2_partial",
    "v2_exit",
    "executor_stop",
    "SHOCK",
    "protective"
];

function hasRecentBotExecutionEvidence(
    ledger: PaperOpenPositionRecord | null | undefined,
    nowMs: number,
    graceMs: number
): boolean {
    if (ledger == null) return false;
    const at = ledger.lastBotExecutionAt;
    if (at == null || !Number.isFinite(at)) return false;
    if (nowMs - at < 0 || nowMs - at > graceMs) return false;
    const reason = String(ledger.lastBotExecutionReason ?? "").toLowerCase();
    if (!reason) return true;
    return BOT_REDUCE_REASON_MARKERS.some((m) => reason.includes(m.toLowerCase()));
}

function hasBotPendingReduceEvidence(ledger: PaperOpenPositionRecord | null | undefined): boolean {
    if (ledger == null) return false;
    if (ledger.lifecycleState === "PARTIAL_PENDING" || ledger.lifecycleState === "CLOSE_PENDING") {
        return true;
    }
    if (
        (typeof ledger.partialPendingOrdId === "string" && ledger.partialPendingOrdId.length > 0) ||
        (typeof ledger.partialPendingClOrdId === "string" && ledger.partialPendingClOrdId.length > 0) ||
        (typeof ledger.closePendingOrdId === "string" && ledger.closePendingOrdId.length > 0) ||
        (typeof ledger.closePendingClOrdId === "string" && ledger.closePendingClOrdId.length > 0)
    ) {
        return true;
    }
    const shock = ledger.shockReduceState;
    return shock === "REQUESTED" || shock === "SUBMITTED" || shock === "PARTIALLY_FILLED";
}

export function attributePositionSizeMutation(input: Readonly<{
    beforeContracts: number;
    afterContracts: number;
    botOrderEvidenceFound: boolean;
    matchingBotReduceContracts?: number | null;
    ledger?: PaperOpenPositionRecord | null;
    manualEvidenceIndependent?: boolean;
    nowMs?: number;
    graceMs?: number;
}>): Readonly<{
    deltaContracts: number;
    botOrderEvidenceFound: boolean;
    matchingBotReduceContracts: number | null;
    manualEvidenceIndependent: boolean;
    attribution: PositionSizeMutationAttribution;
}> {
    const before = input.beforeContracts;
    const after = input.afterContracts;
    const delta = before - after;
    const tol = Math.max(1e-8, MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO * Math.max(before, after, 1));
    const nowMs = input.nowMs ?? Date.now();
    const graceMs = input.graceMs ?? 120_000;

    const botPending = hasBotPendingReduceEvidence(input.ledger);
    const recentBotExec = hasRecentBotExecutionEvidence(input.ledger, nowMs, graceMs);
    const botEvidence =
        input.botOrderEvidenceFound === true || botPending || recentBotExec;

    const matching =
        input.matchingBotReduceContracts != null &&
        Number.isFinite(input.matchingBotReduceContracts) &&
        input.matchingBotReduceContracts > 0
            ? input.matchingBotReduceContracts
            : null;

    if (Math.abs(delta) <= tol) {
        return {
            deltaContracts: delta,
            botOrderEvidenceFound: botEvidence,
            matchingBotReduceContracts: matching,
            manualEvidenceIndependent: input.manualEvidenceIndependent === true,
            attribution: "BOT"
        };
    }

    if (botEvidence) {
        if (matching != null && Math.abs(Math.abs(delta) - matching) <= tol) {
            return {
                deltaContracts: delta,
                botOrderEvidenceFound: true,
                matchingBotReduceContracts: matching,
                manualEvidenceIndependent: false,
                attribution: "BOT"
            };
        }
        if (delta > 0 && after >= 0) {
            return {
                deltaContracts: delta,
                botOrderEvidenceFound: true,
                matchingBotReduceContracts: matching ?? Math.abs(delta),
                manualEvidenceIndependent: false,
                attribution: "BOT"
            };
        }
    }

    if (input.manualEvidenceIndependent === true) {
        return {
            deltaContracts: delta,
            botOrderEvidenceFound: botEvidence,
            matchingBotReduceContracts: matching,
            manualEvidenceIndependent: true,
            attribution: "MANUAL"
        };
    }

    return {
        deltaContracts: delta,
        botOrderEvidenceFound: botEvidence,
        matchingBotReduceContracts: matching,
        manualEvidenceIndependent: false,
        attribution: "UNKNOWN"
    };
}

export function buildBotPositionSizeMutationAttributionProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "BOT_POSITION_SIZE_MUTATION_ATTRIBUTION_PROOF", ...input };
}

export function buildFalseManualLatchRecoveredProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "FALSE_MANUAL_LATCH_RECOVERED_PROOF", ...input };
}
