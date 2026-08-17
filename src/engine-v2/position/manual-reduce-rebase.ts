import type { PaperOpenPositionRecord } from "../../models/types";
import { MANUAL_CONTRACT_MISMATCH_TOLERANCE_RATIO } from "./ownership-resolver";
import { engineMirrorStopPrice, engineMirrorTpPrice, regimeForSl } from "../../engine/position-ops-monitor";

export type SizeDeltaClassification =
    | "BOT_REDUCE_RECONCILE"
    | "MANUAL_REDUCE_REBASE"
    | "MANUAL_INCREASE"
    | "ALIGNED"
    | "UNKNOWN";

const BOT_REDUCE_FILL_GRACE_MS = 120_000;

export function isEligibleForManualIncreaseAdoption(open: PaperOpenPositionRecord | null | undefined): boolean {
    if (open == null) return false;
    // Reject explicit external manual positions
    if (open.lifecycleState === "EXTERNAL_MANUAL_POSITION") return false;
    if (open.lifecycleState === "EXTERNAL_MANUAL_MANAGED") return false;
    if (open.lifecycleState === "CLOSE_ONLY_MANAGED" && open.isV2Authority !== true) return false;

    // Must have verified V2 ownership evidence (never bare OPEN without V2 authority)
    if (open.isV2Authority === true) return true;
    const authSrc = String(open.authoritySourceAtEntry ?? open.authority ?? "").trim().toLowerCase();
    if (authSrc === "v2") return true;
    if (open.lifecycleState === "BOT_V2_MANAGED") return true;

    return false;
}

export type RebasePositionProtectiveResult = Readonly<{
    rebaseStatus: "REBASE_SUCCESS" | "REBASE_REJECTED_STRUCTURE_ALREADY_BREACHED";
    rebasedStop: number | null;
    rebasedTp: number | null;
    rebasedStopSource: string;
    rebasedTpSource: string;
    rebaseReason: string;
}>;

export function rebasePositionProtectiveAuthority(input: Readonly<{
    open: PaperOpenPositionRecord;
    newAvgPx: number;
    markPrice?: number | null;
    currentSnapshot?: Readonly<{
        boxHigh?: number | null;
        boxLow?: number | null;
        lastPrice?: number | null;
    }> | null;
}>): RebasePositionProtectiveResult {
    const { open, newAvgPx, currentSnapshot } = input;
    const side = open.side;
    const regime = regimeForSl(open.regimeAtEntry);
    const mark = typeof input.markPrice === "number" && Number.isFinite(input.markPrice) && input.markPrice > 0
        ? input.markPrice
        : newAvgPx;

    // 1. Identify Existing Structural Invalidation Target
    const invPx = typeof open.invalidationPx === "number" && Number.isFinite(open.invalidationPx) && open.invalidationPx > 0
        ? open.invalidationPx
        : null;
    const boxLow = typeof open.rangeBoxLowAtEntry === "number" && Number.isFinite(open.rangeBoxLowAtEntry) && open.rangeBoxLowAtEntry > 0
        ? open.rangeBoxLowAtEntry
        : null;
    const boxHigh = typeof open.rangeBoxHighAtEntry === "number" && Number.isFinite(open.rangeBoxHighAtEntry) && open.rangeBoxHighAtEntry > 0
        ? open.rangeBoxHighAtEntry
        : null;
    const existingStop = typeof open.stopPrice === "number" && Number.isFinite(open.stopPrice) && open.stopPrice > 0
        ? open.stopPrice
        : null;

    const structuralStop = invPx ?? (side === "long" ? boxLow : boxHigh) ?? existingStop;

    // 2. Structural Breach Check — DO NOT mark clamp or relax if structure is already breached!
    if (structuralStop != null) {
        const isBreached = side === "long" ? mark <= structuralStop : mark >= structuralStop;
        if (isBreached) {
            return {
                rebaseStatus: "REBASE_REJECTED_STRUCTURE_ALREADY_BREACHED",
                rebasedStop: structuralStop,
                rebasedTp: null,
                rebasedStopSource: "structure_breached_retained",
                rebasedTpSource: "none",
                rebaseReason: "structure_already_breached_by_current_mark"
            };
        }
    }

    // 3. Current Box vs Entry Box Authority for Stop
    const currBoxHigh = typeof currentSnapshot?.boxHigh === "number" && Number.isFinite(currentSnapshot.boxHigh) ? currentSnapshot.boxHigh : null;
    const currBoxLow = typeof currentSnapshot?.boxLow === "number" && Number.isFinite(currentSnapshot.boxLow) ? currentSnapshot.boxLow : null;
    const hasValidCurrentBox = currBoxHigh != null && currBoxLow != null && currBoxHigh > currBoxLow;

    let rebasedStop: number | null = null;
    let rebasedStopSource = "none";

    if (invPx != null) {
        const isInvValidDirection = side === "long" ? (invPx < newAvgPx && invPx < mark) : (invPx > newAvgPx && invPx > mark);
        if (isInvValidDirection) {
            rebasedStop = invPx;
            rebasedStopSource = "preserved_invalidation_px";
        }
    }

    if (rebasedStop == null && hasValidCurrentBox) {
        if (side === "long" && currBoxLow! < newAvgPx && currBoxLow! < mark) {
            rebasedStop = currBoxLow;
            rebasedStopSource = "current_box_low_authority";
        } else if (side === "short" && currBoxHigh! > newAvgPx && currBoxHigh! > mark) {
            rebasedStop = currBoxHigh;
            rebasedStopSource = "current_box_high_authority";
        }
    }

    if (rebasedStop == null) {
        if (side === "long" && boxLow != null && boxLow < newAvgPx && boxLow < mark) {
            rebasedStop = boxLow;
            rebasedStopSource = "preserved_entry_box_low";
        } else if (side === "short" && boxHigh != null && boxHigh > newAvgPx && boxHigh > mark) {
            rebasedStop = boxHigh;
            rebasedStopSource = "preserved_entry_box_high";
        }
    }

    // 4. Fallback: Mirror policy ONLY if structural metadata was missing/invalid
    if (rebasedStop == null) {
        const mirrored = engineMirrorStopPrice(newAvgPx, side, regime);
        if (mirrored != null && Number.isFinite(mirrored)) {
            const isMirrorBreached = side === "long" ? mark <= mirrored : mark >= mirrored;
            if (isMirrorBreached) {
                return {
                    rebaseStatus: "REBASE_REJECTED_STRUCTURE_ALREADY_BREACHED",
                    rebasedStop: mirrored,
                    rebasedTp: null,
                    rebasedStopSource: "mirror_stop_breached",
                    rebasedTpSource: "none",
                    rebaseReason: "mirror_fallback_stop_breached_by_current_mark"
                };
            }
            rebasedStop = mirrored;
            rebasedStopSource = "mirror_policy_fallback";
        }
    }

    if (rebasedStop == null) {
        rebasedStop = side === "long" ? newAvgPx * 0.99 : newAvgPx * 1.01;
        rebasedStopSource = "emergency_fallback";
    }

    // 5. TP Rebase (RANGE: distinguish Current Box Mid vs Entry Box Mid with explicit proof source)
    let rebasedTp: number | null = null;
    let rebasedTpSource = "none";

    if (regime === "RANGE") {
        if (hasValidCurrentBox) {
            const currentMid = (currBoxHigh! + currBoxLow!) / 2;
            const isCurrMidValid = side === "long" ? (currentMid > newAvgPx && currentMid > mark) : (currentMid < newAvgPx && currentMid < mark);
            if (isCurrMidValid) {
                rebasedTp = currentMid;
                rebasedTpSource = "current_box_mid_authority";
            }
        }

        if (rebasedTp == null) {
            const boxMid = typeof open.rangeBoxMidAtEntry === "number" && Number.isFinite(open.rangeBoxMidAtEntry) && open.rangeBoxMidAtEntry > 0
                ? open.rangeBoxMidAtEntry
                : null;

            if (boxMid != null) {
                const isMidValid = side === "long" ? (boxMid > newAvgPx && boxMid > mark) : (boxMid < newAvgPx && boxMid < mark);
                if (isMidValid) {
                    rebasedTp = boxMid;
                    rebasedTpSource = "ENTRY_STRUCTURE_PRESERVED_NO_CURRENT_BOX_AUTHORITY";
                }
            }
        }

        if (rebasedTp == null) {
            const mirroredTp = engineMirrorTpPrice(newAvgPx, side, regime);
            if (mirroredTp != null && Number.isFinite(mirroredTp)) {
                rebasedTp = mirroredTp;
                rebasedTpSource = "mirror_policy_fallback";
            }
        }
    }

    return {
        rebaseStatus: "REBASE_SUCCESS",
        rebasedStop,
        rebasedTp,
        rebasedStopSource,
        rebasedTpSource,
        rebaseReason: "rebase_applied_successfully"
    };
}

export function buildV2ManualIncreaseRebaseProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_MANUAL_INCREASE_REBASE_PROOF", ...input };
}

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
