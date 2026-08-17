import { stopLossPctForRegime } from "../../strategy/regime-exit";
import type { MarketRegime } from "../../strategy/market-regime-detector";

export function isV2StopPriceBreached(
    side: "long" | "short",
    mark: number,
    stopPrice: number
): boolean {
    if (!(Number.isFinite(mark) && mark > 0)) return false;
    if (!(Number.isFinite(stopPrice) && stopPrice > 0)) return false;
    return side === "long" ? mark <= stopPrice : mark >= stopPrice;
}

export function hasValidV2StopPrice(stopPrice: number | null | undefined): stopPrice is number {
    return typeof stopPrice === "number" && Number.isFinite(stopPrice) && stopPrice > 0;
}

/**
 * PNL_STOP_PROTECT judgment authority — separate from accounting/dashboard pnlPctNet.
 * Uses unlevered price move × actual leverage; falls back to pnlPctNet when inputs are unavailable.
 */
export function computePnlStopProtectJudgmentPct(input: Readonly<{
    side: "long" | "short";
    entryPrice: number;
    markPrice: number;
    leverage: number;
    pnlPctNetFallback: number;
}>): Readonly<{
    pnlStopProtectPct: number;
    source: "price_move_x_leverage" | "pnl_pct_net_fallback";
}> {
    const entry = input.entryPrice;
    const mark = input.markPrice;
    const leverage = input.leverage;
    if (!(entry > 0 && mark > 0 && leverage > 0 && Number.isFinite(leverage))) {
        return {
            pnlStopProtectPct: input.pnlPctNetFallback,
            source: "pnl_pct_net_fallback"
        };
    }
    const priceMoveFrac =
        input.side === "long" ? (mark - entry) / entry : (entry - mark) / entry;
    return {
        pnlStopProtectPct: priceMoveFrac * leverage,
        source: "price_move_x_leverage"
    };
}

export function evaluateV2StopLossSubmitAuthority(input: Readonly<{
    side: "long" | "short";
    mark: number;
    stopPrice: number | null | undefined;
    pnlPctNet: number;
    slRegime: MarketRegime;
    isV2Authority: boolean;
}>): Readonly<{
    actualStopBreached: boolean;
    pnlGateTriggered: boolean;
    stopSubmitAllowed: boolean;
    authority: "price_stop" | "pnl_gate" | "none";
}> {
    const priceStopActive = input.isV2Authority && hasValidV2StopPrice(input.stopPrice);
    const actualStopBreached = priceStopActive
        ? isV2StopPriceBreached(input.side, input.mark, input.stopPrice)
        : false;
    const pnlGateTriggered = input.pnlPctNet <= stopLossPctForRegime(input.slRegime);

    if (priceStopActive) {
        return {
            actualStopBreached,
            pnlGateTriggered,
            stopSubmitAllowed: actualStopBreached,
            authority: actualStopBreached ? "price_stop" : "none"
        };
    }

    return {
        actualStopBreached: false,
        pnlGateTriggered,
        stopSubmitAllowed: pnlGateTriggered,
        authority: pnlGateTriggered ? "pnl_gate" : "none"
    };
}
