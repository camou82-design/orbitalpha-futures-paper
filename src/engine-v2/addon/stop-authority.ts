export type V2AddonStopAuthoritySource =
    | "okx_algo_order"
    | "okx_position_stop"
    | "ledger_stop_px"
    | "ledger_stop_price"
    | "ledger_sl_price"
    | "ledger_breakeven_stop_price"
    | "args_current_stop_price"
    | "none";

export type V2AddonStopAuthorityResult = Readonly<{
    resolvedStopPrice: number | null;
    stopAuthoritySource: V2AddonStopAuthoritySource;
    entryPrice: number;
    isStopLockingProfit: boolean;
    isProtectiveStopRegistered: boolean;
}>;

function toPositiveFiniteNumber(val: unknown): number | null {
    if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
    if (typeof val === "string") {
        const n = parseFloat(val);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

function normalizeSym(s: unknown): string {
    const str = String(s ?? "").toUpperCase().replace(/-/g, "").replace(/_/, "");
    if (str.includes("USDT")) return str.replace("SWAP", "");
    return str;
}

export function resolveV2AddonStopAuthority(input: {
    symbol: string;
    side: "long" | "short" | string | null | undefined;
    position: any;
    algoOrders?: ReadonlyArray<Record<string, unknown>> | null;
    explicitStopPrice?: number;
}): V2AddonStopAuthorityResult {
    const targetSymNorm = normalizeSym(input.symbol);
    const sideLower = String(input.side ?? "").toLowerCase();
    const entryPrice = toPositiveFiniteNumber(input.position?.entryPrice) ?? 0;

    // 1. Highest Priority: Active OKX Protective Algo Order (SL)
    if (Array.isArray(input.algoOrders) && input.algoOrders.length > 0) {
        for (const algo of input.algoOrders) {
            if (!algo) continue;
            const instId = String(algo.instId ?? "");
            const algoSymNorm = normalizeSym(instId);
            if (algoSymNorm !== targetSymNorm && instId !== input.symbol) continue;

            const posSide = String(algo.posSide ?? "").toLowerCase();
            const orderSide = String(algo.side ?? "").toLowerCase();
            const isReduceOnly =
                algo.reduceOnly === true ||
                String(algo.reduceOnly).toLowerCase() === "true" ||
                algo.closeFraction === "1" ||
                String(algo.closeFraction) === "1";

            const sideMatches =
                (posSide.length > 0 && posSide === sideLower) ||
                (sideLower === "long" && (orderSide === "sell" || posSide === "long")) ||
                (sideLower === "short" && (orderSide === "buy" || posSide === "short"));

            if (!sideMatches) continue;

            const slPx =
                toPositiveFiniteNumber(algo.slTriggerPx) ??
                toPositiveFiniteNumber(algo.triggerPx) ??
                toPositiveFiniteNumber(algo.stopPx) ??
                toPositiveFiniteNumber(algo.trigPx) ??
                toPositiveFiniteNumber(algo.slPrice) ??
                toPositiveFiniteNumber(algo.sl);

            if (slPx !== null) {
                const isStopLockingProfit =
                    entryPrice > 0 &&
                    (sideLower === "long" ? slPx > entryPrice : slPx < entryPrice);
                return {
                    resolvedStopPrice: slPx,
                    stopAuthoritySource: "okx_algo_order",
                    entryPrice,
                    isStopLockingProfit,
                    isProtectiveStopRegistered: true
                };
            }
        }
    }

    // 2. Position-level OKX stop field (if populated by live position feed)
    const posOkxStop =
        toPositiveFiniteNumber(input.position?.okx_stop_px) ??
        toPositiveFiniteNumber(input.position?.okxStopPrice) ??
        toPositiveFiniteNumber(input.position?.okxSlTriggerPx);

    if (posOkxStop !== null) {
        const isStopLockingProfit =
            entryPrice > 0 &&
            (sideLower === "long" ? posOkxStop > entryPrice : posOkxStop < entryPrice);
        return {
            resolvedStopPrice: posOkxStop,
            stopAuthoritySource: "okx_position_stop",
            entryPrice,
            isStopLockingProfit,
            isProtectiveStopRegistered: true
        };
    }

    // 3. Ledger stop fields in strict order:
    // ledger_stop_px -> stopPrice -> slPrice -> breakevenStopPrice
    let resolvedStopPrice: number | null = null;
    let stopAuthoritySource: V2AddonStopAuthoritySource = "none";

    const ledgerStopPx = toPositiveFiniteNumber(input.position?.ledger_stop_px);
    const stopPrice = toPositiveFiniteNumber(input.position?.stopPrice);
    const slPrice = toPositiveFiniteNumber(input.position?.slPrice);
    const breakevenStopPrice = toPositiveFiniteNumber(input.position?.breakevenStopPrice);
    const explicitStop = toPositiveFiniteNumber(input.explicitStopPrice);

    if (ledgerStopPx !== null) {
        resolvedStopPrice = ledgerStopPx;
        stopAuthoritySource = "ledger_stop_px";
    } else if (stopPrice !== null) {
        resolvedStopPrice = stopPrice;
        stopAuthoritySource = "ledger_stop_price";
    } else if (slPrice !== null) {
        resolvedStopPrice = slPrice;
        stopAuthoritySource = "ledger_sl_price";
    } else if (breakevenStopPrice !== null) {
        resolvedStopPrice = breakevenStopPrice;
        stopAuthoritySource = "ledger_breakeven_stop_price";
    } else if (explicitStop !== null) {
        resolvedStopPrice = explicitStop;
        stopAuthoritySource = "args_current_stop_price";
    }

    const isProtectiveStopRegistered =
        input.position?.isProtectiveStopRegistered !== undefined
            ? input.position.isProtectiveStopRegistered === true
            : (input.position?.breakevenStopConfirmed === true && resolvedStopPrice !== null);

    // Locked profit requires:
    // 1) A valid resolved stop
    // 2) Protective stop is actively registered
    // 3) Stop strictly beyond entry in profit direction
    const isStopLockingProfit =
        resolvedStopPrice !== null &&
        entryPrice > 0 &&
        isProtectiveStopRegistered &&
        (sideLower === "long" ? resolvedStopPrice > entryPrice : resolvedStopPrice < entryPrice);

    return {
        resolvedStopPrice,
        stopAuthoritySource,
        entryPrice,
        isStopLockingProfit,
        isProtectiveStopRegistered
    };
}
