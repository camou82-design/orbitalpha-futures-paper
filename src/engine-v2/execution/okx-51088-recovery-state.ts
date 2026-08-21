export type Okx51088RepairPlan = "adopt_existing" | "combined_oco_rebuild" | "none";

export type Okx51088RecoveryState = Readonly<{
    positionCycleId: string;
    symbol: string;
    side: string;
    last51088At: number;
    recoveryInProgress: boolean;
    inventoryRequeryCompleted: boolean;
    repairPlan: Okx51088RepairPlan;
    nextRetryAt: number | null;
    lastEvidenceHash: string;
    submitSuppressedCount: number;
}>;

const stateByCycleId = new Map<string, Okx51088RecoveryState>();

export function compute51088EvidenceHash(input: Readonly<{
    errorCode: string | null;
    existingAlgoCount: number;
    canonicalSlFound: boolean;
    canonicalTpFound: boolean;
    repairAction: string;
}>): string {
    return [
        input.errorCode ?? "none",
        input.existingAlgoCount,
        input.canonicalSlFound ? "sl" : "no_sl",
        input.canonicalTpFound ? "tp" : "no_tp",
        input.repairAction
    ].join("|");
}

export function get51088RecoveryState(positionCycleId: string): Okx51088RecoveryState | null {
    return stateByCycleId.get(positionCycleId) ?? null;
}

export function reset51088RecoveryState(positionCycleId: string): void {
    stateByCycleId.delete(positionCycleId);
}

export function shouldSuppress51088Resubmit(input: Readonly<{
    positionCycleId: string;
    nowMs: number;
    evidenceHash: string;
    emergencyUnprotected: boolean;
}>): Readonly<{ suppress: boolean; reason: string }> {
    const existing = stateByCycleId.get(input.positionCycleId);
    if (!existing) return { suppress: false, reason: "NO_PRIOR_51088_STATE" };

    if (input.emergencyUnprotected) {
        if (existing.nextRetryAt != null && input.nowMs < existing.nextRetryAt) {
            return { suppress: true, reason: "BOUNDED_RETRY_BACKOFF" };
        }
        return { suppress: false, reason: "EMERGENCY_UNPROTECTED_RETRY_ALLOWED" };
    }

    if (existing.lastEvidenceHash === input.evidenceHash && existing.recoveryInProgress) {
        return { suppress: true, reason: "SAME_EVIDENCE_RECOVERY_IN_PROGRESS" };
    }

    if (existing.lastEvidenceHash === input.evidenceHash && existing.nextRetryAt != null && input.nowMs < existing.nextRetryAt) {
        return { suppress: true, reason: "SAME_EVIDENCE_BACKOFF" };
    }

    return { suppress: false, reason: "EVIDENCE_CHANGED_OR_BACKOFF_EXPIRED" };
}

export function record51088RecoveryAttempt(input: Readonly<{
    positionCycleId: string;
    symbol: string;
    side: string;
    nowMs: number;
    evidenceHash: string;
    repairPlan: Okx51088RepairPlan;
    inventoryRequeryCompleted: boolean;
    recoveryInProgress: boolean;
    nextRetryAtMs?: number | null;
    suppressed?: boolean;
}>): Okx51088RecoveryState {
    const prev = stateByCycleId.get(input.positionCycleId);
    const next: Okx51088RecoveryState = {
        positionCycleId: input.positionCycleId,
        symbol: input.symbol,
        side: input.side,
        last51088At: input.nowMs,
        recoveryInProgress: input.recoveryInProgress,
        inventoryRequeryCompleted: input.inventoryRequeryCompleted,
        repairPlan: input.repairPlan,
        nextRetryAt: input.nextRetryAtMs ?? null,
        lastEvidenceHash: input.evidenceHash,
        submitSuppressedCount: (prev?.submitSuppressedCount ?? 0) + (input.suppressed ? 1 : 0)
    };
    stateByCycleId.set(input.positionCycleId, next);
    return next;
}

export function clear51088RecoveryInProgress(positionCycleId: string): void {
    const existing = stateByCycleId.get(positionCycleId);
    if (!existing) return;
    stateByCycleId.set(positionCycleId, {
        ...existing,
        recoveryInProgress: false,
        nextRetryAt: null
    });
}

/** Test-only */
export function __clearAll51088RecoveryStateForTests(): void {
    stateByCycleId.clear();
}
