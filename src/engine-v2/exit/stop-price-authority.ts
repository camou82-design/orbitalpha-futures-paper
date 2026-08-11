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
