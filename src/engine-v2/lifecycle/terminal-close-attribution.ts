import type { PaperOpenPositionRecord } from "../../models/types";
import {
    classifyTradeSource,
    normalizeFinalCloseReason,
    type FinalCloseReason
} from "./completed-trade";
import { isProtectivePartialReason } from "../execution/reduce-economics";

export type TerminalCloseAttribution = Readonly<{
    closeReason: string;
    finalCloseReason: FinalCloseReason;
    closeSource: string;
    attributionSource: string;
    manualEvidencePresent: boolean;
}>;

const TERMINAL_CLOSE_CAUSALITY_MS = 15 * 60_000;

function isTerminalCloseBotExecutionReason(reason: string | null | undefined): boolean {
    const r = String(reason ?? "").trim();
    if (!r) return false;
    if (isProtectivePartialReason(r)) return false;
    const upper = r.toUpperCase();
    if (upper.includes("PARTIAL") && !upper.includes("FULL")) return false;
    return true;
}

function isTerminalCycleExitFillReason(reason: string | null | undefined): boolean {
    return isTerminalCloseBotExecutionReason(reason);
}

export function resolveTerminalCloseAttribution(input: Readonly<{
    open: PaperOpenPositionRecord;
    reconcileSource: string;
    okxFlatDetectedAt: number;
    manualEvidencePresent: boolean;
}>): TerminalCloseAttribution {
    const { open, reconcileSource, manualEvidencePresent } = input;
    const lastBotReason = String(open.lastBotExecutionReason ?? "").trim();
    const lastBotAt = open.lastBotExecutionAt ?? 0;
    const botRecent =
        lastBotAt > 0 && input.okxFlatDetectedAt - lastBotAt <= TERMINAL_CLOSE_CAUSALITY_MS;
    const botTerminalExecution =
        botRecent &&
        isTerminalCloseBotExecutionReason(lastBotReason) &&
        lastBotReason.length > 0;

    if (open.closePendingReason && open.closePendingAt) {
        const cr = String(open.closePendingReason);
        return {
            closeReason: cr,
            finalCloseReason: normalizeFinalCloseReason({
                closeReason: cr,
                tradeSource: classifyTradeSource(open),
                isStop: cr.includes("stop"),
                isTakeProfit: cr.includes("take_profit")
            }),
            closeSource: "BOT_CLOSE_PENDING_FILL",
            attributionSource: "bot_close_pending",
            manualEvidencePresent
        };
    }

    if (manualEvidencePresent) {
        return {
            closeReason: "manual_full_close_reconciled",
            finalCloseReason: "EXTERNAL_MANUAL_CLOSE",
            closeSource: reconcileSource,
            attributionSource: "explicit_manual_evidence",
            manualEvidencePresent: true
        };
    }

    if (botTerminalExecution) {
        const isStop = lastBotReason.toUpperCase().includes("STOP");
        const isTp = lastBotReason.toUpperCase().includes("TAKE_PROFIT");
        const isShockExit =
            lastBotReason.toUpperCase().includes("SHOCK") &&
            (lastBotReason.toUpperCase().includes("FULL") ||
                lastBotReason.toUpperCase().includes("EXIT"));
        const finalCloseReason = normalizeFinalCloseReason({
            closeReason: lastBotReason,
            tradeSource: classifyTradeSource(open),
            isStop,
            isTakeProfit: isTp
        });
        return {
            closeReason: isShockExit ? "v2_exit_authority" : lastBotReason,
            finalCloseReason: isShockExit ? "SHOCK_PROTECTIVE_REDUCE_FINAL" : finalCloseReason,
            closeSource: "BOT_EXECUTION_ATTRIBUTION",
            attributionSource: "last_bot_execution",
            manualEvidencePresent: false
        };
    }

    const lastFill = open.positionCycleExitFills?.[open.positionCycleExitFills.length - 1];
    if (
        lastFill &&
        input.okxFlatDetectedAt - lastFill.at <= TERMINAL_CLOSE_CAUSALITY_MS &&
        isTerminalCycleExitFillReason(lastFill.reason) &&
        classifyTradeSource(open) === "BOT_V2"
    ) {
        const reason = String(lastFill.reason ?? "v2_exit_authority");
        return {
            closeReason: reason.includes("stop") ? "stop_loss" : "v2_exit_authority",
            finalCloseReason: normalizeFinalCloseReason({
                closeReason: reason,
                tradeSource: "BOT_V2",
                isStop: reason.includes("stop")
            }),
            closeSource: "BOT_CYCLE_EXIT_FILL",
            attributionSource: "position_cycle_exit_fill",
            manualEvidencePresent: false
        };
    }

    if (
        classifyTradeSource(open) === "BOT_V2" &&
        (open.isV2Authority === true || isProtectivePartialReason(open.shockReduceReason))
    ) {
        return {
            closeReason: "v2_exit_authority",
            finalCloseReason: "V2_EXIT",
            closeSource: reconcileSource,
            attributionSource: "bot_v2_reconcile_flat_fallback",
            manualEvidencePresent: false
        };
    }

    return {
        closeReason: "manual_full_close_reconciled",
        finalCloseReason: "UNKNOWN_EXECUTION_CLOSE",
        closeSource: reconcileSource,
        attributionSource: "reconcile_absent_fallback",
        manualEvidencePresent: false
    };
}

export function buildTerminalCloseAttributionProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_TERMINAL_CLOSE_ATTRIBUTION_PROOF", ...input };
}
