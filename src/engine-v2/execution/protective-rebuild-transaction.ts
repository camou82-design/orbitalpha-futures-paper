import type { ProtectiveAlgoRow } from "./protective-reconcile-plan";
import { planProtectiveOrderReconcile, type ProtectiveReconcileContext } from "./protective-reconcile-plan";
import {
    resolveDesiredProtectionPlan,
    resolveExchangeProtectionTruth,
    planProtectionReconcile as planCanonicalProtectionReconcile,
    resolveFinalProtectionAuthority
} from "./final-protection-authority";

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
    const desired = resolveDesiredProtectionPlan({
        symbol: input.reconcileCtx.instId.split("-")[0] || "BTCUSDT",
        side: input.reconcileCtx.positionSide,
        contracts: input.reconcileCtx.contractsToProtect,
        slPrice: input.reconcileCtx.activeStopPrice,
        tpPrice: input.reconcileCtx.activeTpPrice,
        isV2Authority: true
    });

    const actual = resolveExchangeProtectionTruth({
        symbol: desired.symbol,
        instId: input.reconcileCtx.instId,
        side: input.reconcileCtx.positionSide,
        actualContracts: input.reconcileCtx.contractsToProtect,
        authoritativeFetchReady: true,
        pendingAlgos: input.inventory,
        desiredPlan: desired,
        tickSz: input.reconcileCtx.tickSz
    });

    const reconcilePlan = planCanonicalProtectionReconcile({
        desired,
        actual
    });

    const finalAuth = resolveFinalProtectionAuthority({
        symbol: desired.symbol,
        side: desired.side,
        desired,
        actual,
        reconcilePlan
    });

    const plan = planProtectiveOrderReconcile([...input.inventory], input.reconcileCtx);
    const slPresent = actual.actualSlPresent;
    const tpPresent = actual.actualTpPresent;
    const protectionSatisfied = finalAuth.protectionComplete;
    return {
        slPresent,
        tpPresent,
        slAlgoId: actual.actualSlAlgoId,
        tpAlgoId: actual.actualTpAlgoId,
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
