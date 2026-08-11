import type { PaperOpenPositionRecord } from "../../models/types";
import { isProtectivePartialReason } from "../execution/reduce-economics";
import { classifyTradeSource } from "../lifecycle/completed-trade";

export const AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED = 2;

export function authoritativeFlatKey(symbol: string, side: "long" | "short"): string {
    return `${symbol}:${side}`;
}

export function recordAuthoritativeFlatZeroObservation(input: Readonly<{
    key: string;
    authoritativeFetchReady: boolean;
    okxActualExists: boolean;
    priorCount: number;
}>): number {
    if (!input.authoritativeFetchReady) return 0;
    if (input.okxActualExists) return 0;
    return input.priorCount + 1;
}

export function shouldPerformAuthoritativeFlatReconcile(input: Readonly<{
    authoritativeFetchReady: boolean;
    ledgerExists: boolean;
    okxActualExists: boolean;
    zeroConfirmCount: number;
}>): boolean {
    return (
        input.authoritativeFetchReady &&
        input.ledgerExists &&
        !input.okxActualExists &&
        input.zeroConfirmCount >= AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED
    );
}

export function isAuthoritativeFlatConfirmed(input: Readonly<{
    authoritativeFetchReady: boolean;
    zeroConfirmCount: number;
}>): boolean {
    return (
        input.authoritativeFetchReady &&
        input.zeroConfirmCount >= AUTHORITATIVE_FLAT_ZERO_CONFIRM_REQUIRED
    );
}

export type AuthoritativeFlatFinalizePendingAction =
    | "HOLD_UNCONFIRMED_ZERO"
    | "FINALIZE_SUCCEEDED"
    | "PRUNE_UNRESOLVED_FINALIZE"
    | "NOT_APPLICABLE";

export function resolveAuthoritativeFlatFinalizePendingAction(input: Readonly<{
    finalizePending: boolean;
    authoritativeFetchReady: boolean;
    zeroConfirmCount: number;
    finalizeSucceeded: boolean;
}>): AuthoritativeFlatFinalizePendingAction {
    if (!input.finalizePending) return "NOT_APPLICABLE";
    if (
        !isAuthoritativeFlatConfirmed({
            authoritativeFetchReady: input.authoritativeFetchReady,
            zeroConfirmCount: input.zeroConfirmCount
        })
    ) {
        return "HOLD_UNCONFIRMED_ZERO";
    }
    if (input.finalizeSucceeded) return "FINALIZE_SUCCEEDED";
    return "PRUNE_UNRESOLVED_FINALIZE";
}

export function buildV2AuthoritativeFlatReconcileProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "V2_AUTHORITATIVE_FLAT_RECONCILE_PROOF", ...input };
}

export type AuthoritativeFlatCloseAttribution =
    | "BOT_FULL_CLOSE_RECONCILE"
    | "EXTERNAL_MANUAL_FULL_CLOSE";

const BOT_FINAL_CLOSE_GRACE_MS = 120_000;
const CONTRACT_MISMATCH_TOLERANCE_RATIO = 0.01;

function isRecentTimestamp(at: number, nowMs: number): boolean {
    return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at <= BOT_FINAL_CLOSE_GRACE_MS;
}

function isBotV2TradeSource(source: string | null | undefined): boolean {
    const normalized = String(source ?? "").trim().toUpperCase();
    return normalized === "BOT_V2";
}

function isBotV2ManagedLedger(ledger: PaperOpenPositionRecord): boolean {
    return classifyTradeSource(ledger) === "BOT_V2";
}

function contractTolerance(baseline: number): number {
    return Math.max(1e-8, CONTRACT_MISMATCH_TOLERANCE_RATIO * baseline);
}

function isConfirmedPositionCycleExitFill(
    fill: NonNullable<PaperOpenPositionRecord["positionCycleExitFills"]>[number]
): boolean {
    return (
        fill != null &&
        Number.isFinite(fill.at) &&
        Number.isFinite(fill.px) &&
        fill.px > 0 &&
        Number.isFinite(fill.contracts) &&
        fill.contracts > 0
    );
}

function isTerminalConfirmedExitFillReason(reason: string | null | undefined): boolean {
    const r = String(reason ?? "").trim();
    if (!r) return false;
    if (isProtectivePartialReason(r)) return false;
    if (r.includes("partial_exit") || r === "take_profit_1" || r === "v2_partial_authority") {
        return false;
    }
    return true;
}

function hasPendingFinalizeBotConfirmedFinalFill(
    ledger: PaperOpenPositionRecord,
    nowMs: number
): boolean {
    if (ledger.finalizePending !== true) return false;

    const fillAt = ledger.pendingFinalizeFinalFillAt;
    if (fillAt == null || !isRecentTimestamp(fillAt, nowMs)) return false;
    if (!isBotV2TradeSource(ledger.pendingFinalizeTradeSource)) return false;

    const exitPx = ledger.pendingFinalizeExitAvgPx;
    return exitPx != null && Number.isFinite(exitPx) && exitPx > 0;
}

function hasPositionCycleConfirmedFinalFillExplainingFlat(
    ledger: PaperOpenPositionRecord,
    nowMs: number
): boolean {
    if (!isBotV2ManagedLedger(ledger)) return false;

    const fills = ledger.positionCycleExitFills;
    if (!Array.isArray(fills) || fills.length === 0) return false;

    const baseline =
        ledger.positionCycleMaxContracts ??
        ledger.okxContracts ??
        0;
    if (!(baseline > 0)) return false;

    let cumulativeRecentExitContracts = 0;
    let hasRecentTerminalFill = false;

    for (const fill of fills) {
        if (!isConfirmedPositionCycleExitFill(fill)) continue;
        if (!isRecentTimestamp(fill.at, nowMs)) continue;

        cumulativeRecentExitContracts += fill.contracts;
        if (isTerminalConfirmedExitFillReason(fill.reason)) {
            hasRecentTerminalFill = true;
        }
    }

    if (!hasRecentTerminalFill) return false;

    const tol = contractTolerance(baseline);
    return cumulativeRecentExitContracts + tol >= baseline;
}

export function resolveAuthoritativeFlatCloseAttribution(input: Readonly<{
    ledger: PaperOpenPositionRecord;
    nowMs: number;
}>): Readonly<{
    attribution: AuthoritativeFlatCloseAttribution;
    botFinalFillEvidenceFound: boolean;
    strategyHistoryAppended: false;
}> {
    const { ledger, nowMs } = input;

    if (hasPendingFinalizeBotConfirmedFinalFill(ledger, nowMs)) {
        return {
            attribution: "BOT_FULL_CLOSE_RECONCILE",
            botFinalFillEvidenceFound: true,
            strategyHistoryAppended: false
        };
    }

    if (hasPositionCycleConfirmedFinalFillExplainingFlat(ledger, nowMs)) {
        return {
            attribution: "BOT_FULL_CLOSE_RECONCILE",
            botFinalFillEvidenceFound: true,
            strategyHistoryAppended: false
        };
    }

    return {
        attribution: "EXTERNAL_MANUAL_FULL_CLOSE",
        botFinalFillEvidenceFound: false,
        strategyHistoryAppended: false
    };
}

export function buildAuthoritativeFlatCloseAttributionProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "V2_AUTHORITATIVE_FLAT_CLOSE_ATTRIBUTION_PROOF", ...input };
}
