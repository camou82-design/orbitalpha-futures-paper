import {
    classifyOkxOpenOrderPurpose,
    findProtectiveHintsForInst,
    orderLooksReduceOnlyProtective
} from "../../engine/position-ops-monitor";
import { hasBotOwnershipEvidenceOnLedgerRow } from "../../lib/position-reconcile-classification";
import type { PaperOpenPositionRecord } from "../../models/types";
import { protectiveStopPricesMatch } from "./protective-match";

/** BLOCKER 3-2 visibility grace — distinct from entryProtectionUntil (120s post-fill ownership). */
export const PROTECTIVE_VISIBILITY_GRACE_MS = 30_000;

export type OpsWatchProtectiveScanVerdict = "HARD_BLOCK" | "DEFER" | "PASS" | "ENSURE_REQUIRED";

export type OpsWatchProtectiveScanResult = Readonly<{
    verdict: OpsWatchProtectiveScanVerdict;
    shouldEmitPendingZeroFault: boolean;
    shouldEmitOrderFault: boolean;
    shouldEmitHardBlockDetected: boolean;
    shouldBlockSymbol: boolean;
    opsWatchVisibilityGraceApplied: boolean;
    preSubmitEnsureRequired: boolean;
    reason: string;
}>;

const NO_FAULTS = {
    shouldEmitPendingZeroFault: false,
    shouldEmitOrderFault: false,
    shouldEmitHardBlockDetected: false,
    shouldBlockSymbol: false,
    opsWatchVisibilityGraceApplied: false,
    preSubmitEnsureRequired: false
} as const;

/**
 * Canonical submit-acceptance evidence for ops-watch / scanner grace.
 * Registered flags alone are insufficient — require durable algoId(s).
 */
export function hasAcceptedProtectiveSubmitEvidence(
    ledger: PaperOpenPositionRecord | null | undefined,
    tpRequired: boolean
): boolean {
    if (!ledger) return false;
    const slAlgoId = String(ledger.protectiveSlAlgoId ?? ledger.protectiveStopAlgoId ?? "").trim();
    if (!slAlgoId) return false;
    if (!tpRequired) return true;
    const tpAlgoId = String(ledger.protectiveTpAlgoId ?? "").trim();
    if (tpAlgoId.length > 0) return true;
    if (ledger.isTakeProfitRegistered === true) return true;
    return false;
}

/**
 * Fresh V2-owned exposure that may not have attempted protective submit yet.
 * External/manual positions are excluded — existing hard-block policy applies.
 */
export function isFreshV2OwnedPositionRequiringProtectiveEnsure(
    ledger: PaperOpenPositionRecord | null | undefined
): boolean {
    if (!ledger) return false;
    if (ledger.lifecycleState === "EXTERNAL_MANUAL_MANAGED") return false;
    if (ledger.manualOwnershipLatch === true) return false;
    return ledger.lifecycleState === "BOT_V2_MANAGED" || hasBotOwnershipEvidenceOnLedgerRow(ledger);
}

/**
 * Ops-watch / scanner grace precedence (BLOCKER 3-2.1 + 3-2.2):
 *   ENSURE_REQUIRED) fresh V2 + zero inventory + no accepted evidence + no explicit failure
 *   A) submit rejected / failed without algo evidence → HARD_BLOCK
 *   B) submit accepted + algoId + inside visibility deadline + inventory miss → DEFER
 *   C) submit accepted + deadline elapsed + inventory still missing → HARD_BLOCK
 *
 * Does NOT defer on reconcileState=PENDING or entryProtectionUntil alone.
 */
export function evaluateOpsWatchProtectiveScanVerdict(input: Readonly<{
    nowMs: number;
    ledger: PaperOpenPositionRecord | null | undefined;
    reduceOnlyProtectiveFound: boolean;
    matchingProtectivePendingCount: number;
    scanClean: boolean;
    tpRequired: boolean;
}>): OpsWatchProtectiveScanResult {
    if (input.reduceOnlyProtectiveFound) {
        return { ...NO_FAULTS, verdict: "PASS", reason: "exchange_inventory_visible" };
    }

    const hasEvidence = hasAcceptedProtectiveSubmitEvidence(input.ledger, input.tpRequired);
    const graceDeadline = input.ledger?.protectiveVisibilityGraceDeadlineMs ?? null;
    const insideGrace = graceDeadline != null && input.nowMs < graceDeadline;
    const pendingZeroEligible =
        input.scanClean && input.matchingProtectivePendingCount === 0;

    if (input.ledger?.isProtectionFailed === true && !hasEvidence) {
        return {
            verdict: "HARD_BLOCK",
            shouldEmitPendingZeroFault: pendingZeroEligible,
            shouldEmitOrderFault: true,
            shouldEmitHardBlockDetected: true,
            shouldBlockSymbol: true,
            opsWatchVisibilityGraceApplied: false,
            preSubmitEnsureRequired: false,
            reason: "submit_rejected_or_protection_failed_without_algo_evidence"
        };
    }

    if (!hasEvidence) {
        if (isFreshV2OwnedPositionRequiringProtectiveEnsure(input.ledger)) {
            return {
                verdict: "ENSURE_REQUIRED",
                shouldEmitPendingZeroFault: false,
                shouldEmitOrderFault: false,
                shouldEmitHardBlockDetected: false,
                shouldBlockSymbol: false,
                opsWatchVisibilityGraceApplied: false,
                preSubmitEnsureRequired: true,
                reason: "fresh_v2_zero_inventory_no_submit_evidence_ensure_required"
            };
        }
        return {
            verdict: "HARD_BLOCK",
            shouldEmitPendingZeroFault: pendingZeroEligible,
            shouldEmitOrderFault: true,
            shouldEmitHardBlockDetected: true,
            shouldBlockSymbol: true,
            opsWatchVisibilityGraceApplied: false,
            preSubmitEnsureRequired: false,
            reason: "no_accepted_submit_evidence_inventory_miss"
        };
    }

    if (insideGrace) {
        return {
            verdict: "DEFER",
            shouldEmitPendingZeroFault: false,
            shouldEmitOrderFault: false,
            shouldEmitHardBlockDetected: false,
            shouldBlockSymbol: false,
            opsWatchVisibilityGraceApplied: true,
            preSubmitEnsureRequired: false,
            reason: "accepted_algo_id_inside_visibility_grace_inventory_miss"
        };
    }

    return {
        verdict: "HARD_BLOCK",
        shouldEmitPendingZeroFault: pendingZeroEligible,
        shouldEmitOrderFault: true,
        shouldEmitHardBlockDetected: true,
        shouldBlockSymbol: true,
        opsWatchVisibilityGraceApplied: false,
        preSubmitEnsureRequired: false,
        reason: "accepted_algo_id_grace_expired_inventory_still_missing"
    };
}

/**
 * Re-evaluate ops-watch verdict after ensureProtectiveStopOrder using updated ledger state.
 * When ensure confirms visible protection (registered, not failed, grace cleared), treat inventory as visible.
 */
export function reevaluateOpsWatchProtectiveScanVerdictAfterEnsure(input: Readonly<{
    nowMs: number;
    ledger: PaperOpenPositionRecord;
    reduceOnlyProtectiveFound: boolean;
    matchingProtectivePendingCount: number;
    scanClean: boolean;
    tpRequired: boolean;
    ensureAttempted: boolean;
    ensureSuccess: boolean;
}>): OpsWatchProtectiveScanResult {
    const ensureConfirmedVisible =
        input.ensureAttempted &&
        input.ensureSuccess &&
        input.ledger.isProtectiveStopRegistered === true &&
        input.ledger.isProtectionFailed !== true &&
        input.ledger.protectiveVisibilityGraceDeadlineMs == null &&
        hasAcceptedProtectiveSubmitEvidence(input.ledger, input.tpRequired);

    return evaluateOpsWatchProtectiveScanVerdict({
        nowMs: input.nowMs,
        ledger: input.ledger,
        reduceOnlyProtectiveFound: input.reduceOnlyProtectiveFound || ensureConfirmedVisible,
        matchingProtectivePendingCount: input.matchingProtectivePendingCount,
        scanClean: input.scanClean,
        tpRequired: input.tpRequired
    });
}

function orderMatchesPositionSide(o: Record<string, unknown>, positionSide: "long" | "short"): boolean {
    const ps = String(o.posSide ?? "").trim().toLowerCase();
    if (!ps || ps === "net") return true;
    return ps === positionSide;
}

function instIdMatchesRow(expectedInstId: string, rowInstId: string): boolean {
    return String(rowInstId ?? "").trim() === String(expectedInstId ?? "").trim();
}

export function evaluatePositionProtectionState(input: Readonly<{
    instId: string;
    positionSide: "long" | "short";
    pending: readonly Record<string, unknown>[];
    algos: readonly Record<string, unknown>[];
    tpRequired: boolean;
    ledger?: PaperOpenPositionRecord | null;
    tickSz?: number;
    requiredStopPx?: number | null;
    requiredContracts?: number | null;
}>): Readonly<{
    reduceOnlyProtectiveFound: boolean;
    matchingProtectivePendingCount: number;
    consistencyCheck: "PASS" | "FAIL";
    preScanFault: boolean;
    exchangeStopPx: number | null;
    exchangeTpPx: number | null;
    hints: string[];
    canonicalProtectiveSlFound: boolean;
}> {
    const hintsResult = findProtectiveHintsForInst(
        input.instId,
        input.positionSide,
        input.pending,
        input.algos,
        input.tpRequired,
        {
            ledger: input.ledger ?? null,
            tickSz: input.tickSz,
            requiredStopPx: input.requiredStopPx ?? null,
            requiredContracts: input.requiredContracts ?? null
        }
    );

    let canonicalProtectiveSlFound = false;
    let matchingProtectivePendingCount = 0;

    const extractSlPx = (o: Record<string, unknown>): number | null => {
        const val = o.slTriggerPx ?? o.triggerPx ?? o.stopPx ?? o.trigPx;
        const n = typeof val === "number" ? val : typeof val === "string" ? Number(val) : NaN;
        return Number.isFinite(n) && n > 0 ? n : null;
    };

    const consider = (o: Record<string, unknown>) => {
        if (!instIdMatchesRow(input.instId, String(o.instId ?? ""))) return;
        if (!orderMatchesPositionSide(o, input.positionSide)) return;
        const classified = classifyOkxOpenOrderPurpose(o, input.ledger ?? null);
        const reduceOnly = o.reduceOnly === "true" || o.reduceOnly === true;
        const isCanonical =
            classified.isBotManagedProtection === true ||
            (reduceOnly && orderLooksReduceOnlyProtective(o));
        if (!isCanonical) return;

        matchingProtectivePendingCount += 1;
        const slPx = extractSlPx(o);
        const hasSlTrigger = slPx != null;
        const closeSideOk =
            input.positionSide === "long"
                ? String(o.side ?? "").toLowerCase() === "sell"
                : String(o.side ?? "").toLowerCase() === "buy";

        const reqStop = input.requiredStopPx ?? null;
        const tickSz = input.tickSz ?? 0;
        const priceMatch =
            reqStop != null && slPx != null && tickSz > 0
                ? protectiveStopPricesMatch(reqStop, slPx, tickSz)
                : hasSlTrigger;

        if (
            reduceOnly &&
            closeSideOk &&
            hasSlTrigger &&
            priceMatch &&
            (classified.purpose === "protective-stop" ||
                classified.purpose === "bot-managed-protection" ||
                classified.purpose === "protective-purpose" ||
                classified.matchedProtectiveAlgo != null)
        ) {
            canonicalProtectiveSlFound = true;
        }
    };

    for (const o of input.algos) consider(o);
    for (const o of input.pending) consider(o);

    const reduceOnlyProtectiveFound =
        canonicalProtectiveSlFound ||
        (matchingProtectivePendingCount > 0 && hintsResult.protectionSatisfied);

    return {
        reduceOnlyProtectiveFound,
        matchingProtectivePendingCount:
            Math.max(matchingProtectivePendingCount, hintsResult.matchingProtectiveOrderCount),
        consistencyCheck: reduceOnlyProtectiveFound ? "PASS" : "FAIL",
        preScanFault: !reduceOnlyProtectiveFound,
        exchangeStopPx: hintsResult.slPrice,
        exchangeTpPx: hintsResult.tpPrice,
        hints: hintsResult.hints,
        canonicalProtectiveSlFound
    };
}

export function buildPositionProtectionStateProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "POSITION_PROTECTION_STATE_PROOF", ...input };
}
