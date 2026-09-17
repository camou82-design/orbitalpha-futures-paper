/**
 * V2 Add-on Stop Authority
 *
 * Active Stop  = OKX에 실제 등록된 보호 주문(Algo SL 또는 Position-level OKX stop field).
 *               사용자가 SL을 수동 삭제하면 activeStopPrice = null 이 됨.
 * Reference Stop = Ledger/런타임 기록값. Active SL이 없을 때 참고용으로만 사용.
 *                  절대로 locked profit 계산의 authority가 될 수 없음.
 *
 * 수동 SL 삭제 ≠ 포지션 ownership 이전. BOT_V2가 포지션을 계속 소유함.
 */

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
    /** OKX에 실제 등록된 보호 SL 가격. 없으면 null. */
    activeStopPrice: number | null;
    /** activeStop의 source. 없으면 "none" */
    activeStopSource: Extract<V2AddonStopAuthoritySource, "okx_algo_order" | "okx_position_stop" | "none">;

    /** Ledger/runtime 기록의 참고 스탑 가격. Active SL과 무관하게 항상 채워짐 (있을 경우). */
    referenceStopPrice: number | null;
    /** referenceStop의 source. */
    referenceStopSource: V2AddonStopAuthoritySource;

    /**
     * @deprecated Use activeStopPrice for locked-profit logic.
     * Kept for backward compatibility: equals activeStopPrice if active exists, else referenceStopPrice.
     */
    resolvedStopPrice: number | null;
    /** @deprecated Use activeStopSource / referenceStopSource */
    stopAuthoritySource: V2AddonStopAuthoritySource;

    entryPrice: number;

    /**
     * true iff activeStopPrice exists AND strictly beyond entryPrice in profit direction.
     * NEVER true based on referenceStopPrice alone.
     */
    isStopLockingProfit: boolean;

    /**
     * true iff an OKX protective stop order is actually registered.
     * false when user manually deleted SL – even if referenceStopPrice is set.
     */
    isProtectiveStopRegistered: boolean;
}>;

// ────────────────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────────────────

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

    // ── PART A: ACTIVE STOP (OKX Protective SL) ─────────────────────────────

    let activeStopPrice: number | null = null;
    let activeStopSource: V2AddonStopAuthorityResult["activeStopSource"] = "none";

    // A1. OKX Algo Order (highest authority)
    if (Array.isArray(input.algoOrders) && input.algoOrders.length > 0) {
        for (const algo of input.algoOrders) {
            if (!algo) continue;
            const instId = String(algo.instId ?? "");
            const algoSymNorm = normalizeSym(instId);
            if (algoSymNorm !== targetSymNorm && instId !== input.symbol) continue;

            const posSide = String(algo.posSide ?? "").toLowerCase();
            const orderSide = String(algo.side ?? "").toLowerCase();

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
                activeStopPrice = slPx;
                activeStopSource = "okx_algo_order";
                break;
            }
        }
    }

    // A2. Position-level OKX stop field (if populated by live position feed)
    if (activeStopPrice === null) {
        const posOkxStop =
            toPositiveFiniteNumber(input.position?.okx_stop_px) ??
            toPositiveFiniteNumber(input.position?.okxStopPrice) ??
            toPositiveFiniteNumber(input.position?.okxSlTriggerPx);

        if (posOkxStop !== null) {
            activeStopPrice = posOkxStop;
            activeStopSource = "okx_position_stop";
        }
    }

    const isProtectiveStopRegistered = activeStopPrice !== null;

    // ── PART B: REFERENCE STOP (Ledger / Runtime record) ────────────────────

    let referenceStopPrice: number | null = null;
    let referenceStopSource: V2AddonStopAuthoritySource = "none";

    const ledgerStopPx = toPositiveFiniteNumber(input.position?.ledger_stop_px);
    const stopPrice = toPositiveFiniteNumber(input.position?.stopPrice);
    const slPrice = toPositiveFiniteNumber(input.position?.slPrice);
    const breakevenStopPrice = toPositiveFiniteNumber(input.position?.breakevenStopPrice);
    const explicitStop = toPositiveFiniteNumber(input.explicitStopPrice);

    if (ledgerStopPx !== null) {
        referenceStopPrice = ledgerStopPx;
        referenceStopSource = "ledger_stop_px";
    } else if (stopPrice !== null) {
        referenceStopPrice = stopPrice;
        referenceStopSource = "ledger_stop_price";
    } else if (slPrice !== null) {
        referenceStopPrice = slPrice;
        referenceStopSource = "ledger_sl_price";
    } else if (breakevenStopPrice !== null) {
        referenceStopPrice = breakevenStopPrice;
        referenceStopSource = "ledger_breakeven_stop_price";
    } else if (explicitStop !== null) {
        referenceStopPrice = explicitStop;
        referenceStopSource = "args_current_stop_price";
    }

    // ── PART C: LOCKED PROFIT — Active Stop 기준만 ───────────────────────────

    // isStopLockingProfit은 반드시 activeStopPrice 기준.
    // referenceStopPrice가 entry보다 유리하더라도, 실제 OKX SL이 없으면 false.
    const isStopLockingProfit =
        activeStopPrice !== null &&
        entryPrice > 0 &&
        (sideLower === "long" ? activeStopPrice > entryPrice : activeStopPrice < entryPrice);

    // ── PART D: BACKWARD COMPAT resolvedStopPrice ───────────────────────────

    // resolvedStopPrice: active가 있으면 active, 없으면 reference (참고용 노출)
    const resolvedStopPrice = activeStopPrice ?? referenceStopPrice;
    const stopAuthoritySource = activeStopSource !== "none" ? activeStopSource : referenceStopSource;

    return {
        activeStopPrice,
        activeStopSource,
        referenceStopPrice,
        referenceStopSource,
        resolvedStopPrice,
        stopAuthoritySource,
        entryPrice,
        isStopLockingProfit,
        isProtectiveStopRegistered
    };
}
