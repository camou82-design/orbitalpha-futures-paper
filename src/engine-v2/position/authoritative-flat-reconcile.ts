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

export function buildV2AuthoritativeFlatReconcileProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "V2_AUTHORITATIVE_FLAT_RECONCILE_PROOF", ...input };
}

export type AuthoritativeFlatCloseAttribution =
    | "BOT_FULL_CLOSE_RECONCILE"
    | "EXTERNAL_MANUAL_FULL_CLOSE";

const BOT_FINAL_CLOSE_GRACE_MS = 120_000;

function isTerminalBotFullCloseReason(reason: string | null | undefined): boolean {
    const r = String(reason ?? "").trim().toLowerCase();
    if (!r) return false;
    if (r.includes("partial") && !r.includes("full")) return false;
    if (r.includes("addon") || r.includes("pyramid") || r.includes("enter")) return false;
    return (
        r.includes("v2_exit") ||
        r.includes("stop_loss") ||
        r.includes("take_profit") ||
        r.includes("executor_") ||
        r.includes("regime_exit") ||
        r.includes("candidate_lost") ||
        r.includes("trend_break") ||
        r.includes("close") ||
        r.includes("trailing")
    );
}

export function resolveAuthoritativeFlatCloseAttribution(input: Readonly<{
    ledger: import("../../models/types").PaperOpenPositionRecord;
    nowMs: number;
}>): Readonly<{
    attribution: AuthoritativeFlatCloseAttribution;
    botFinalFillEvidenceFound: boolean;
    strategyHistoryAppended: false;
}> {
    const { ledger, nowMs } = input;

    if (ledger.closePendingReason && ledger.closePendingAt != null) {
        const age = nowMs - ledger.closePendingAt;
        if (age >= 0 && age <= BOT_FINAL_CLOSE_GRACE_MS) {
            const reason = String(ledger.closePendingReason);
            if (isTerminalBotFullCloseReason(reason)) {
                return {
                    attribution: "BOT_FULL_CLOSE_RECONCILE",
                    botFinalFillEvidenceFound: true,
                    strategyHistoryAppended: false
                };
            }
        }
    }

    const lastAt = ledger.lastBotExecutionAt;
    const lastReason = String(ledger.lastBotExecutionReason ?? "");
    if (
        lastAt != null &&
        Number.isFinite(lastAt) &&
        nowMs - lastAt >= 0 &&
        nowMs - lastAt <= BOT_FINAL_CLOSE_GRACE_MS &&
        isTerminalBotFullCloseReason(lastReason)
    ) {
        return {
            attribution: "BOT_FULL_CLOSE_RECONCILE",
            botFinalFillEvidenceFound: true,
            strategyHistoryAppended: false
        };
    }

    const fills = ledger.positionCycleExitFills;
    if (Array.isArray(fills) && fills.length > 0) {
        const last = fills[fills.length - 1];
        if (
            last &&
            last.at != null &&
            Number.isFinite(last.at) &&
            nowMs - last.at >= 0 &&
            nowMs - last.at <= BOT_FINAL_CLOSE_GRACE_MS &&
            isTerminalBotFullCloseReason(String(last.reason ?? ""))
        ) {
            return {
                attribution: "BOT_FULL_CLOSE_RECONCILE",
                botFinalFillEvidenceFound: true,
                strategyHistoryAppended: false
            };
        }
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
