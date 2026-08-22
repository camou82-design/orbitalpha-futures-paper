import type { ProtectiveReconcileContext } from "./protective-reconcile-plan";
import type { ProtectiveAlgoRow } from "./protective-reconcile-plan";
import { planProtectiveOrderReconcile } from "./protective-reconcile-plan";
import {
    resolveDesiredProtectionPlan,
    resolveExchangeProtectionTruth,
    planProtectionReconcile as planCanonicalProtectionReconcile
} from "./final-protection-authority";

export const OKX_FULL_POSITION_TP_SL_CONFLICT = "51088";

export function isOkx51088FullPositionProtectiveConflict(input: Readonly<{
    sCode?: string | null;
    sMsg?: string | null;
}>): boolean {
    if (String(input.sCode ?? "") === OKX_FULL_POSITION_TP_SL_CONFLICT) return true;
    const msg = String(input.sMsg ?? "").toLowerCase();
    return msg.includes("only place 1 tp/sl order") || msg.includes("close an entire position");
}

export type Okx51088RecoveryResult = Readonly<{
    adopted: boolean;
    repairRequired: boolean;
    repairAction: "adopt_existing" | "combined_oco_rebuild" | "none";
    canonicalSlFound: boolean;
    canonicalTpFound: boolean;
    slPrice: number | null;
    tpPrice: number | null;
    finalProtectionSatisfied: boolean;
    slAlgoId: string | null;
    tpAlgoId: string | null;
}>;

function extractPx(row: ProtectiveAlgoRow, field: "slTriggerPx" | "tpTriggerPx"): number | null {
    const val = row[field];
    const n = typeof val === "number" ? val : typeof val === "string" ? Number(val) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
}

export function evaluateOkx51088ProtectionRecovery(input: Readonly<{
    inventory: readonly ProtectiveAlgoRow[];
    reconcileCtx: ProtectiveReconcileContext;
    tpRequired: boolean;
}>): Okx51088RecoveryResult {
    // 1. Canonical Desired & Exchange Truth Resolution (Phase E/E.5 runtime wiring)
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

    const canonicalPlan = planCanonicalProtectionReconcile({
        desired,
        actual,
        has51088Error: true
    });

    const plan = planProtectiveOrderReconcile([...input.inventory], input.reconcileCtx);
    const slAlgoId = plan.canonicalSlAlgoId;
    const tpAlgoId = plan.canonicalTpAlgoId;
    const slPrice = plan.canonicalSl ? extractPx(plan.canonicalSl, "slTriggerPx") : null;
    const tpPrice = plan.canonicalTp ? extractPx(plan.canonicalTp, "tpTriggerPx") : null;
    const canonicalSlFound = slAlgoId != null;
    const canonicalTpFound = tpAlgoId != null;
    const slOk = canonicalSlFound;
    const tpOk = !input.tpRequired || canonicalTpFound;
    const finalProtectionSatisfied = slOk && tpOk;

    if (finalProtectionSatisfied) {
        return {
            adopted: true,
            repairRequired: false,
            repairAction: "adopt_existing",
            canonicalSlFound,
            canonicalTpFound,
            slPrice,
            tpPrice,
            finalProtectionSatisfied: true,
            slAlgoId,
            tpAlgoId
        };
    }

    if (canonicalSlFound && input.tpRequired && !canonicalTpFound) {
        return {
            adopted: false,
            repairRequired: true,
            repairAction: "combined_oco_rebuild",
            canonicalSlFound,
            canonicalTpFound,
            slPrice,
            tpPrice,
            finalProtectionSatisfied: false,
            slAlgoId,
            tpAlgoId
        };
    }

    return {
        adopted: false,
        repairRequired: !finalProtectionSatisfied,
        repairAction: "none",
        canonicalSlFound,
        canonicalTpFound,
        slPrice,
        tpPrice,
        finalProtectionSatisfied: false,
        slAlgoId,
        tpAlgoId
    };
}

export function buildOkx51088RecoveryProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_OKX_PROTECTION_51088_RECOVERY_PROOF", ...input };
}
