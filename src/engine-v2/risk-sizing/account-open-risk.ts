/**
 * Account Open-Risk Authority
 *
 * Enforces the 2.50% account total open-risk hard cap across BTC and ETH positions.
 * Aggregates stop-loss dollar risk from actual open positions using strict truth priority:
 *   1. OKX actual current position
 *   2. Canonical exchange protective SL
 *   3. Authoritative ledger stop (only when exchange truth unavailable)
 *   Fallback: UNKNOWN_OPEN_POSITION_RISK_RESERVE = 1.50% equity per unknown-risk position.
 */

export const ACCOUNT_TOTAL_OPEN_RISK_HARD_CAP_PCT = 0.025; // 2.50%
export const UNKNOWN_OPEN_POSITION_RISK_RESERVE_PCT = 0.015; // 1.50%
export const FULL_ENTRY_TARGET_RISK_SA_PCT = 0.015; // 1.50%
export const FULL_ENTRY_TARGET_RISK_B_PCT = 0.010; // 1.00%
export const MICRO_PROBE_TARGET_RISK_PCT = 0.005; // 0.50%

export type PositionRiskStopSource =
    | "EXCHANGE_PROTECTIVE_SL"
    | "AUTHORITATIVE_LEDGER_SL"
    | "UNKNOWN_FALLBACK";

export type PositionRiskSummary = Readonly<{
    symbol: string;
    side: "long" | "short";
    notionalUsdt: number;
    entryPrice: number;
    canonicalStopPrice: number | null;
    stopSource: PositionRiskStopSource;
    stopDistancePct: number | null;
    openRiskUsdt: number;
    openRiskPct: number;
    isStopKnown: boolean;
}>;

export type AccountOpenRiskAuthorityResult = Readonly<{
    positions: ReadonlyArray<PositionRiskSummary>;
    totalOpenRiskUsdt: number;
    totalOpenRiskPct: number;
    accountRiskCapUsdt: number;
    accountRiskCapPct: number;
    remainingAccountRiskUsdt: number;
    remainingAccountRiskPct: number;
    hardCapExceeded: boolean;
}>;

export type DirectPositionRiskInput = Readonly<{
    symbol: string;
    side: "long" | "short" | "LONG" | "SHORT" | string;
    notionalUsdt: number;
    entryPrice: number;
    canonicalStopPrice?: number | null;
    stopPrice?: number | null;
    isStopKnown?: boolean;
    stopSource?: PositionRiskStopSource;
}>;

export type EvaluateAccountOpenRiskInput = Readonly<{
    equityUsdt: number;
    /** Direct pre-parsed positions (if provided, takes precedence) */
    directPositions?: ReadonlyArray<DirectPositionRiskInput> | null;
    /** OKX live positions payload */
    okxActualPositions?: ReadonlyArray<unknown> | null;
    /** Paper ledger open positions */
    paperPositions?: ReadonlyArray<unknown> | null;
    /** OKX active algo/pending orders */
    algoOrders?: ReadonlyArray<unknown> | null;
}>;

function normalizeSymbolKey(sym: string | undefined | null): string {
    if (!sym) return "";
    return String(sym).toUpperCase().replace(/-SWAP$/, "").replace(/-/g, "").replace(/USDT$/, "") + "USDT";
}

function normalizeSide(side: string | undefined | null): "long" | "short" | null {
    if (!side) return null;
    const s = String(side).toLowerCase();
    if (s === "long" || s === "buy") return "long";
    if (s === "short" || s === "sell") return "short";
    return null;
}

function extractNumber(val: unknown): number | null {
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (typeof val === "string" && val.trim().length > 0) {
        const n = Number(val);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/**
 * Resolves protective stop price from OKX algo order payload.
 */
function resolveStopPriceFromAlgo(algo: unknown): number | null {
    if (!algo || typeof algo !== "object") return null;
    const a = algo as Record<string, unknown>;
    const sl = extractNumber(a.slTriggerPx) ??
        extractNumber(a.triggerPx) ??
        extractNumber(a.stopPx) ??
        extractNumber(a.trigPx);
    if (sl != null && sl > 0) return sl;
    return null;
}

/**
 * Resolves account-wide open risk and remaining risk budget under the 2.50% hard cap.
 */
export function resolveAccountOpenRiskAuthority(
    input: EvaluateAccountOpenRiskInput
): AccountOpenRiskAuthorityResult {
    const equity = Math.max(0, input.equityUsdt);
    const accountRiskCapUsdt = equity * ACCOUNT_TOTAL_OPEN_RISK_HARD_CAP_PCT;

    const positions: PositionRiskSummary[] = [];

    // 1. Direct positions mode (for tests or pre-calculated positions)
    if (Array.isArray(input.directPositions) && input.directPositions.length > 0) {
        for (const dp of input.directPositions) {
            const sym = normalizeSymbolKey(dp.symbol);
            const side = normalizeSide(dp.side);
            if (!sym || !side) continue;
            const notional = Math.max(0, dp.notionalUsdt);
            if (!(notional > 0)) continue;

            const entryPrice = Math.max(0, dp.entryPrice);
            const rawStop = dp.canonicalStopPrice ?? dp.stopPrice ?? null;
            const isStopKnownInput = dp.isStopKnown ?? (rawStop != null && rawStop > 0);

            let isStopKnown = false;
            let canonicalStopPrice: number | null = null;
            let stopDistancePct: number | null = null;
            let openRiskUsdt = 0;
            let stopSource: PositionRiskStopSource = dp.stopSource ?? "UNKNOWN_FALLBACK";

            if (isStopKnownInput && rawStop != null && rawStop > 0 && entryPrice > 0) {
                const isValidSide = side === "long" ? rawStop < entryPrice : rawStop > entryPrice;
                if (isValidSide) {
                    canonicalStopPrice = rawStop;
                    stopDistancePct = Math.abs(entryPrice - rawStop) / entryPrice;
                    if (stopDistancePct > 0) {
                        isStopKnown = true;
                        openRiskUsdt = notional * stopDistancePct;
                        if (!dp.stopSource) stopSource = "EXCHANGE_PROTECTIVE_SL";
                    }
                }
            }

            if (!isStopKnown) {
                canonicalStopPrice = null;
                stopDistancePct = null;
                stopSource = "UNKNOWN_FALLBACK";
                openRiskUsdt = equity * UNKNOWN_OPEN_POSITION_RISK_RESERVE_PCT;
            }

            const openRiskPct = equity > 0 ? openRiskUsdt / equity : 0;
            positions.push({
                symbol: sym,
                side,
                notionalUsdt: notional,
                entryPrice,
                canonicalStopPrice,
                stopSource,
                stopDistancePct,
                openRiskUsdt,
                openRiskPct,
                isStopKnown
            });
        }
    } else {
        // 2. Production mode: Extract positions from OKX actual (Priority 1) or Paper Ledger
        const candidateSymbols = new Set<string>();

        // Collect positions from OKX actual
        const okxList = Array.isArray(input.okxActualPositions) ? input.okxActualPositions : [];
        const paperList = Array.isArray(input.paperPositions) ? input.paperPositions : [];
        const algosList = Array.isArray(input.algoOrders) ? input.algoOrders : [];

        // Build map of positions by symbol
        type PosInfo = {
            symbol: string;
            side: "long" | "short";
            notionalUsdt: number;
            entryPrice: number;
        };
        const resolvedPositions: PosInfo[] = [];

        if (okxList.length > 0) {
            for (const p of okxList) {
                const pObj = p as any;
                const sym = normalizeSymbolKey(String(pObj.symbol ?? pObj.instId ?? ""));
                const side = normalizeSide(String(pObj.side ?? pObj.posSide ?? ""));
                if (!sym || !side) continue;
                const notional = Math.abs(extractNumber(pObj.sizeUsd) ?? extractNumber(pObj.notionalUsd) ?? extractNumber(pObj.notionalUSDT) ?? 0);
                if (!(notional > 0)) continue;
                const entryPrice = Math.abs(extractNumber(pObj.entryPrice) ?? extractNumber(pObj.avgPx) ?? extractNumber(pObj.openPrice) ?? 0);
                resolvedPositions.push({ symbol: sym, side, notionalUsdt: notional, entryPrice });
                candidateSymbols.add(sym);
            }
        } else if (paperList.length > 0) {
            for (const p of paperList) {
                const pObj = p as any;
                const status = String(pObj.status ?? "open").toLowerCase();
                if (status !== "open") continue;
                const sym = normalizeSymbolKey(String(pObj.symbol ?? pObj.instId ?? ""));
                const side = normalizeSide(String(pObj.side ?? ""));
                if (!sym || !side) continue;
                const notional = Math.abs(extractNumber(pObj.sizeUsd) ?? extractNumber(pObj.notionalUsd) ?? 0);
                if (!(notional > 0)) continue;
                const entryPrice = Math.abs(extractNumber(pObj.entryPrice) ?? extractNumber(pObj.avgPx) ?? 0);
                resolvedPositions.push({ symbol: sym, side, notionalUsdt: notional, entryPrice });
                candidateSymbols.add(sym);
            }
        }

        for (const pos of resolvedPositions) {
            let canonicalStopPrice: number | null = null;
            let stopSource: PositionRiskStopSource = "UNKNOWN_FALLBACK";
            let isStopKnown = false;

            // Priority 1: Check OKX matching protective SL from algoOrders
            for (const algo of algosList) {
                const aObj = algo as any;
                const aSym = normalizeSymbolKey(String(aObj.symbol ?? aObj.instId ?? ""));
                if (aSym !== pos.symbol) continue;
                const aPosSide = normalizeSide(String(aObj.posSide ?? ""));
                if (aPosSide && aPosSide !== pos.side) continue;

                const slCandidate = resolveStopPriceFromAlgo(algo);
                if (slCandidate != null && slCandidate > 0) {
                    const validDirection =
                        pos.side === "long" ? slCandidate < pos.entryPrice : slCandidate > pos.entryPrice;
                    if (validDirection) {
                        canonicalStopPrice = slCandidate;
                        stopSource = "EXCHANGE_PROTECTIVE_SL";
                        isStopKnown = true;
                        break;
                    }
                }
            }

            // Priority 2: Authoritative ledger stop if exchange SL not visible
            if (!isStopKnown) {
                const ledgerMatch = paperList.find((p) => {
                    const lObj = p as any;
                    const lSym = normalizeSymbolKey(String(lObj.symbol ?? ""));
                    const lSide = normalizeSide(String(lObj.side ?? ""));
                    return lSym === pos.symbol && lSide === pos.side;
                });
                if (ledgerMatch) {
                    const lObj = ledgerMatch as any;
                    const ledgerSl = extractNumber(lObj.invalidationPx) ??
                        extractNumber(lObj.stopPrice) ??
                        extractNumber(lObj.stopLossPrice);
                    if (ledgerSl != null && ledgerSl > 0) {
                        const validDirection =
                            pos.side === "long" ? ledgerSl < pos.entryPrice : ledgerSl > pos.entryPrice;
                        if (validDirection) {
                            canonicalStopPrice = ledgerSl;
                            stopSource = "AUTHORITATIVE_LEDGER_SL";
                            isStopKnown = true;
                        }
                    }
                }
            }

            let stopDistancePct: number | null = null;
            let openRiskUsdt = 0;

            if (isStopKnown && canonicalStopPrice != null && canonicalStopPrice > 0 && pos.entryPrice > 0) {
                stopDistancePct = Math.abs(pos.entryPrice - canonicalStopPrice) / pos.entryPrice;
                if (stopDistancePct > 0) {
                    openRiskUsdt = pos.notionalUsdt * stopDistancePct;
                } else {
                    isStopKnown = false;
                    canonicalStopPrice = null;
                    stopDistancePct = null;
                    stopSource = "UNKNOWN_FALLBACK";
                    openRiskUsdt = equity * UNKNOWN_OPEN_POSITION_RISK_RESERVE_PCT;
                }
            } else {
                isStopKnown = false;
                canonicalStopPrice = null;
                stopDistancePct = null;
                stopSource = "UNKNOWN_FALLBACK";
                openRiskUsdt = equity * UNKNOWN_OPEN_POSITION_RISK_RESERVE_PCT;
            }

            const openRiskPct = equity > 0 ? openRiskUsdt / equity : 0;
            positions.push({
                symbol: pos.symbol,
                side: pos.side,
                notionalUsdt: pos.notionalUsdt,
                entryPrice: pos.entryPrice,
                canonicalStopPrice,
                stopSource,
                stopDistancePct,
                openRiskUsdt,
                openRiskPct,
                isStopKnown
            });
        }
    }

    const totalOpenRiskUsdt = positions.reduce((sum, p) => sum + p.openRiskUsdt, 0);
    const totalOpenRiskPct = equity > 0 ? totalOpenRiskUsdt / equity : 0;
    const remainingAccountRiskUsdt = Math.max(0, accountRiskCapUsdt - totalOpenRiskUsdt);
    const remainingAccountRiskPct = equity > 0 ? remainingAccountRiskUsdt / equity : 0;
    const hardCapExceeded = totalOpenRiskUsdt >= accountRiskCapUsdt;

    return {
        positions,
        totalOpenRiskUsdt,
        totalOpenRiskPct,
        accountRiskCapUsdt,
        accountRiskCapPct: ACCOUNT_TOTAL_OPEN_RISK_HARD_CAP_PCT,
        remainingAccountRiskUsdt,
        remainingAccountRiskPct,
        hardCapExceeded
    };
}
