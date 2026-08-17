import { isV2StopPriceBreached, hasValidV2StopPrice } from "./stop-price-authority";

export type PnlStopMeaningfulMoveGateInput = Readonly<{
    symbol: string;
    side: "long" | "short" | "none";
    entryPrice: number;
    markPrice: number;
    leverage: number;
    pnlStopProtectPct: number;
    ledgerStopPx: number | null;
    atr20: number | null;
    slProtectionSatisfied?: boolean;
    slProtectionProvisional?: boolean;
    protectiveVisibilityGraceDeadlineMs?: number | null;
    now?: number;
    protectiveSlAlgoId?: string | null;
    structureBreached?: boolean;
    invalidationBreachConfirmed?: boolean;
    shockAgainst?: boolean;
    hasAdverseDirectionalAuthority?: boolean;
    thresholdActionCandidate: "FULL_EXIT" | "REDUCE" | "NONE";
}>;

export type PnlStopMeaningfulMoveGateResult = Readonly<{
    symbol: string;
    side: "long" | "short" | "none";
    entryPrice: number;
    markPrice: number;
    leverage: number;
    pnlStopProtectPct: number;
    underlyingAdverseMovePct: number;
    atr20: number | null;
    atrPct: number | null;
    adverseMoveAtrMultiple: number | null;
    ledgerStopPx: number | null;
    stopDistancePct: number | null;
    stopProgressRatio: number | null;
    slProtectionSatisfied: boolean;
    slProtectionProvisional: boolean;
    exchangeSlAuthoritativelyConfirmed: boolean;
    protectiveVisibilityGraceActive: boolean;
    exchangeProtectionState: "CONFIRMED" | "PROVISIONAL_PROTECTED" | "UNPROTECTED";
    thresholdActionCandidate: "FULL_EXIT" | "REDUCE" | "NONE";
    meaningfulMovePassed: boolean;
    bypassReason: string | null;
    finalAction: "FULL_EXIT" | "REDUCE" | "HOLD";
    reduceRatio: number;
    evidence: string;
}>;

export function evaluatePnlStopMeaningfulMoveGate(
    input: PnlStopMeaningfulMoveGateInput
): PnlStopMeaningfulMoveGateResult {
    const {
        symbol,
        side,
        entryPrice,
        markPrice,
        leverage,
        pnlStopProtectPct,
        thresholdActionCandidate
    } = input;

    let underlyingAdverseMovePct = 0;
    if (entryPrice > 0 && markPrice > 0) {
        if (side === "long") {
            underlyingAdverseMovePct = Math.max(0, (entryPrice - markPrice) / entryPrice);
        } else if (side === "short") {
            underlyingAdverseMovePct = Math.max(0, (markPrice - entryPrice) / entryPrice);
        }
    } else if (pnlStopProtectPct < 0) {
        underlyingAdverseMovePct = Math.abs(pnlStopProtectPct) / (leverage > 0 ? leverage : 1);
    }

    // Typed production authority only
    const ledgerStopPx =
        typeof input.ledgerStopPx === "number" && Number.isFinite(input.ledgerStopPx) && input.ledgerStopPx > 0
            ? input.ledgerStopPx
            : null;

    let stopDistancePct: number | null = null;
    if (ledgerStopPx != null && entryPrice > 0) {
        if (side === "long") {
            stopDistancePct = Math.max(0, (entryPrice - ledgerStopPx) / entryPrice);
        } else if (side === "short") {
            stopDistancePct = Math.max(0, (ledgerStopPx - entryPrice) / entryPrice);
        }
    }

    const stopProgressRatio =
        stopDistancePct != null && stopDistancePct > 0
            ? underlyingAdverseMovePct / stopDistancePct
            : null;

    // Typed production authority only
    const atr20 =
        typeof input.atr20 === "number" && Number.isFinite(input.atr20) && input.atr20 > 0
            ? input.atr20
            : null;

    const referencePx = entryPrice > 0 ? entryPrice : markPrice;
    const atrPct =
        atr20 != null && referencePx > 0
            ? atr20 / referencePx
            : null;

    let adverseMoveAtrMultiple: number | null = null;
    if (atr20 != null && entryPrice > 0 && markPrice > 0) {
        const adverseDistancePx =
            side === "long"
                ? Math.max(0, entryPrice - markPrice)
                : side === "short"
                  ? Math.max(0, markPrice - entryPrice)
                  : 0;
        adverseMoveAtrMultiple = adverseDistancePx / atr20;
    }

    // [BLOCKER 4-17 3-STATE AUTHORITY SEMANTICS]:
    // 1. CONFIRMED: OKX inventory/rescan verified non-provisional SL (exchangeSlAuthoritativelyConfirmed = true)
    // 2. PROVISIONAL_PROTECTED: submit accepted + durable algoId + visibility grace active (exchangeSlAuthoritativelyConfirmed = false)
    // 3. UNPROTECTED: unconfirmed SL / grace expired without confirmation
    const currentNow = input.now ?? Date.now();
    const protectiveVisibilityGraceActive =
        typeof input.protectiveVisibilityGraceDeadlineMs === "number" &&
        input.protectiveVisibilityGraceDeadlineMs > currentNow;

    const slProtectionProvisional =
        input.slProtectionProvisional === true || protectiveVisibilityGraceActive;

    const slProtectionSatisfied =
        input.slProtectionSatisfied === true ||
        (typeof input.protectiveSlAlgoId === "string" && input.protectiveSlAlgoId.trim().length > 0);

    const exchangeSlAuthoritativelyConfirmed =
        slProtectionSatisfied && !slProtectionProvisional;

    let exchangeProtectionState: "CONFIRMED" | "PROVISIONAL_PROTECTED" | "UNPROTECTED" = "UNPROTECTED";
    if (exchangeSlAuthoritativelyConfirmed) {
        exchangeProtectionState = "CONFIRMED";
    } else if (slProtectionSatisfied && slProtectionProvisional) {
        exchangeProtectionState = "PROVISIONAL_PROTECTED";
    } else {
        exchangeProtectionState = "UNPROTECTED";
    }

    const hasValidLedgerStop = ledgerStopPx != null && hasValidV2StopPrice(ledgerStopPx);

    const actualStopBreached =
        hasValidLedgerStop &&
        (side === "long" || side === "short") &&
        isV2StopPriceBreached(side, markPrice, ledgerStopPx!);

    // Bypass conditions: Emergency shock, confirmed structural invalidation, or committed stop breach.
    let bypassReason: string | null = null;
    if (input.structureBreached === true) {
        bypassReason = "structure_invalidation_breached";
    } else if (input.invalidationBreachConfirmed === true) {
        bypassReason = "confirmed_invalidation_breached";
    } else if (actualStopBreached) {
        bypassReason = "committed_stop_breached";
    } else if (input.shockAgainst === true) {
        bypassReason = "adverse_shock_against_position";
    } else if (input.hasAdverseDirectionalAuthority === true) {
        bypassReason = "adverse_directional_shock";
    }

    if (bypassReason != null) {
        const finalAction =
            thresholdActionCandidate === "FULL_EXIT"
                ? "FULL_EXIT"
                : thresholdActionCandidate === "REDUCE"
                  ? "REDUCE"
                  : "HOLD";
        const reduceRatio = finalAction === "FULL_EXIT" ? 1 : finalAction === "REDUCE" ? 0.4 : 0;
        return {
            symbol,
            side,
            entryPrice,
            markPrice,
            leverage,
            pnlStopProtectPct,
            underlyingAdverseMovePct,
            atr20,
            atrPct,
            adverseMoveAtrMultiple,
            ledgerStopPx,
            stopDistancePct,
            stopProgressRatio,
            slProtectionSatisfied,
            slProtectionProvisional,
            exchangeSlAuthoritativelyConfirmed,
            protectiveVisibilityGraceActive,
            exchangeProtectionState,
            thresholdActionCandidate,
            meaningfulMovePassed: true,
            bypassReason,
            finalAction,
            reduceRatio,
            evidence: `pnl_stop_bypassed:${bypassReason}`
        };
    }

    if (thresholdActionCandidate === "NONE") {
        return {
            symbol,
            side,
            entryPrice,
            markPrice,
            leverage,
            pnlStopProtectPct,
            underlyingAdverseMovePct,
            atr20,
            atrPct,
            adverseMoveAtrMultiple,
            ledgerStopPx,
            stopDistancePct,
            stopProgressRatio,
            slProtectionSatisfied,
            slProtectionProvisional,
            exchangeSlAuthoritativelyConfirmed,
            protectiveVisibilityGraceActive,
            exchangeProtectionState,
            thresholdActionCandidate,
            meaningfulMovePassed: false,
            bypassReason: null,
            finalAction: "HOLD",
            reduceRatio: 0,
            evidence: "pnl_stop_threshold_not_hit"
        };
    }

    // Meaningful Move Indicators
    const isAtrMeaningful = adverseMoveAtrMultiple != null ? adverseMoveAtrMultiple >= 1.0 : null;
    const isStopProgressMeaningful = stopProgressRatio != null ? stopProgressRatio >= 0.40 : null;

    let meaningfulReducePassed = false;

    if ((exchangeProtectionState === "CONFIRMED" || exchangeProtectionState === "PROVISIONAL_PROTECTED") && hasValidLedgerStop) {
        // [CONFIRMED & PROVISIONAL_PROTECTED]:
        // Both ATR (>= 1.0) AND Stop Progress (>= 40%) MUST be present and satisfied to reduce.
        // If ATR missing (null), stopProgress alone is NEVER an independent REDUCE authority -> stays in HOLD.
        if (isAtrMeaningful != null && isStopProgressMeaningful != null) {
            meaningfulReducePassed = isAtrMeaningful && isStopProgressMeaningful;
        } else {
            meaningfulReducePassed = false;
        }
    } else {
        // [UNPROTECTED]:
        // Capital protection fallback: maintain authoritative 023c5e2 PnL authority
        if (isAtrMeaningful != null && isStopProgressMeaningful != null) {
            meaningfulReducePassed = isAtrMeaningful && isStopProgressMeaningful;
        } else if (isAtrMeaningful != null) {
            meaningfulReducePassed = isAtrMeaningful;
        } else if (isStopProgressMeaningful != null) {
            meaningfulReducePassed = isStopProgressMeaningful;
        } else {
            meaningfulReducePassed = true;
        }
    }

    let finalAction: "FULL_EXIT" | "REDUCE" | "HOLD" = "HOLD";
    let meaningfulMovePassed = false;
    let evidence = "";

    if (thresholdActionCandidate === "FULL_EXIT") {
        if (exchangeProtectionState === "UNPROTECTED" || !hasValidLedgerStop) {
            // [UNPROTECTED]: Exchange SL unconfirmed or grace expired -> internal PNL FULL_EXIT
            finalAction = "FULL_EXIT";
            meaningfulMovePassed = true;
            evidence = "pnl_stop_unprotected_exchange_full_exit";
        } else if (meaningfulReducePassed) {
            // [CONFIRMED or PROVISIONAL_PROTECTED]: Downgrade to protective REDUCE (40%)
            finalAction = "REDUCE";
            meaningfulMovePassed = true;
            evidence = `pnl_stop_downgraded_to_reduce:state=${exchangeProtectionState}|atr=${isAtrMeaningful}|stopProg=${isStopProgressMeaningful}`;
        } else {
            // [CONFIRMED or PROVISIONAL_PROTECTED]: Unbreached / inside noise -> HOLD
            finalAction = "HOLD";
            meaningfulMovePassed = false;
            evidence = `pnl_stop_noise_suppressed_hold:${exchangeProtectionState}`;
        }
    } else if (thresholdActionCandidate === "REDUCE") {
        if (meaningfulReducePassed) {
            finalAction = "REDUCE";
            meaningfulMovePassed = true;
            evidence = `pnl_stop_meaningful_reduce:state=${exchangeProtectionState}|atr=${isAtrMeaningful}|stopProg=${isStopProgressMeaningful}`;
        } else {
            finalAction = "HOLD";
            meaningfulMovePassed = false;
            evidence = `pnl_stop_noise_suppressed_hold:${exchangeProtectionState}`;
        }
    }

    const reduceRatio = finalAction === "FULL_EXIT" ? 1 : finalAction === "REDUCE" ? 0.4 : 0;

    return {
        symbol,
        side,
        entryPrice,
        markPrice,
        leverage,
        pnlStopProtectPct,
        underlyingAdverseMovePct,
        atr20,
        atrPct,
        adverseMoveAtrMultiple,
        ledgerStopPx,
        stopDistancePct,
        stopProgressRatio,
        slProtectionSatisfied,
        slProtectionProvisional,
        exchangeSlAuthoritativelyConfirmed,
        protectiveVisibilityGraceActive,
        exchangeProtectionState,
        thresholdActionCandidate,
        meaningfulMovePassed,
        bypassReason: null,
        finalAction,
        reduceRatio,
        evidence
    };
}

export function buildPnlStopMeaningfulMoveGateProof(
    res: PnlStopMeaningfulMoveGateResult
): Record<string, unknown> {
    return {
        event: "V2_PNL_STOP_MEANINGFUL_MOVE_GATE_PROOF",
        symbol: res.symbol,
        side: res.side,
        entryPrice: res.entryPrice,
        markPrice: res.markPrice,
        leverage: res.leverage,
        pnlStopProtectPct: res.pnlStopProtectPct,
        underlyingAdverseMovePct: res.underlyingAdverseMovePct,
        atr20: res.atr20,
        atrPct: res.atrPct,
        adverseMoveAtrMultiple: res.adverseMoveAtrMultiple,
        ledgerStopPx: res.ledgerStopPx,
        stopDistancePct: res.stopDistancePct,
        stopProgressRatio: res.stopProgressRatio,
        slProtectionSatisfied: res.slProtectionSatisfied,
        slProtectionProvisional: res.slProtectionProvisional,
        exchangeSlAuthoritativelyConfirmed: res.exchangeSlAuthoritativelyConfirmed,
        protectiveVisibilityGraceActive: res.protectiveVisibilityGraceActive,
        exchangeProtectionState: res.exchangeProtectionState,
        thresholdActionCandidate: res.thresholdActionCandidate,
        meaningfulMovePassed: res.meaningfulMovePassed,
        bypassReason: res.bypassReason,
        finalAction: res.finalAction
    };
}
