import {
    classifyOkxOpenOrderPurpose,
    findProtectiveHintsForInst,
    orderLooksReduceOnlyProtective
} from "../../engine/position-ops-monitor";
import type { PaperOpenPositionRecord } from "../../models/types";
import { protectiveStopPricesMatch } from "./protective-match";

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
