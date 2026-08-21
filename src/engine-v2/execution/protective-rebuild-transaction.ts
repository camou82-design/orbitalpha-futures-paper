import type { ProtectiveAlgoRow } from "./protective-reconcile-plan";
import { planProtectiveOrderReconcile, type ProtectiveReconcileContext } from "./protective-reconcile-plan";

export type ProtectiveRebuildTransactionProof = Readonly<{
    symbol: string;
    side: string;
    oldSlAlgoId: string | null;
    oldSlStillLiveBefore: boolean;
    oldCancelAttempted: boolean;
    oldCancelSucceeded: boolean;
    newCombinedSubmitAttempted: boolean;
    newCombinedSubmitSucceeded: boolean;
    newSlAlgoId: string | null;
    newTpAlgoId: string | null;
    authoritativeRequeryPassed: boolean;
    restoreAttempted: boolean;
    restoreSucceeded: boolean;
    finalSlPresent: boolean;
    finalTpPresent: boolean;
    finalProtectionSatisfied: boolean;
    hardBlockApplied: boolean;
}>;

export function buildProtectiveRebuildTransactionProof(
    input: ProtectiveRebuildTransactionProof
): Record<string, unknown> {
    return { event: "V2_PROTECTIVE_REBUILD_TRANSACTION_PROOF", ...input };
}

export function isSlOnlyOcoRebuildScenario(input: Readonly<{
    submitOco: boolean;
    hasAuthoritativeSl: boolean;
    hasAuthoritativeTp: boolean;
    wantsTp: boolean;
}>): boolean {
    return input.submitOco && input.hasAuthoritativeSl && !input.hasAuthoritativeTp && input.wantsTp;
}

export function evaluateAuthoritativeProtectionPresence(input: Readonly<{
    inventory: readonly ProtectiveAlgoRow[];
    reconcileCtx: ProtectiveReconcileContext;
    tpRequired: boolean;
}>): Readonly<{
    slPresent: boolean;
    tpPresent: boolean;
    slAlgoId: string | null;
    tpAlgoId: string | null;
    protectionSatisfied: boolean;
}> {
    const plan = planProtectiveOrderReconcile([...input.inventory], input.reconcileCtx);
    const slPresent = plan.canonicalSlAlgoId != null;
    const tpPresent = plan.canonicalTpAlgoId != null;
    const protectionSatisfied = slPresent && (!input.tpRequired || tpPresent);
    return {
        slPresent,
        tpPresent,
        slAlgoId: plan.canonicalSlAlgoId,
        tpAlgoId: plan.canonicalTpAlgoId,
        protectionSatisfied
    };
}

export function mergeRebuildTransactionProof(
    base: Partial<ProtectiveRebuildTransactionProof>,
    patch: Partial<ProtectiveRebuildTransactionProof>
): ProtectiveRebuildTransactionProof {
    return {
        symbol: base.symbol ?? "",
        side: base.side ?? "",
        oldSlAlgoId: patch.oldSlAlgoId ?? base.oldSlAlgoId ?? null,
        oldSlStillLiveBefore: patch.oldSlStillLiveBefore ?? base.oldSlStillLiveBefore ?? false,
        oldCancelAttempted: patch.oldCancelAttempted ?? base.oldCancelAttempted ?? false,
        oldCancelSucceeded: patch.oldCancelSucceeded ?? base.oldCancelSucceeded ?? false,
        newCombinedSubmitAttempted: patch.newCombinedSubmitAttempted ?? base.newCombinedSubmitAttempted ?? false,
        newCombinedSubmitSucceeded: patch.newCombinedSubmitSucceeded ?? base.newCombinedSubmitSucceeded ?? false,
        newSlAlgoId: patch.newSlAlgoId ?? base.newSlAlgoId ?? null,
        newTpAlgoId: patch.newTpAlgoId ?? base.newTpAlgoId ?? null,
        authoritativeRequeryPassed: patch.authoritativeRequeryPassed ?? base.authoritativeRequeryPassed ?? false,
        restoreAttempted: patch.restoreAttempted ?? base.restoreAttempted ?? false,
        restoreSucceeded: patch.restoreSucceeded ?? base.restoreSucceeded ?? false,
        finalSlPresent: patch.finalSlPresent ?? base.finalSlPresent ?? false,
        finalTpPresent: patch.finalTpPresent ?? base.finalTpPresent ?? false,
        finalProtectionSatisfied: patch.finalProtectionSatisfied ?? base.finalProtectionSatisfied ?? false,
        hardBlockApplied: patch.hardBlockApplied ?? base.hardBlockApplied ?? false
    };
}
