import type { Candle } from "../../models/types";
import { computeMinimumProfitableTpPct } from "./tp-profitability-authority";
import { engineMirrorTpPrice } from "../../engine/position-ops-monitor";

export type TrendDynamicTpProvenance =
    | "hybrid_atr_structure"
    | "atr_only_fallback"
    | "structure_only_fallback"
    | "engine_calculated_fallback";

export type TrendDynamicTpInput = Readonly<{
    side: "long" | "short";
    entryPrice: number;
    rawStructuralSl?: number | null;
    atr1m?: number | null;
    atr5m?: number | null;
    atr15m?: number | null;
    candles1m?: ReadonlyArray<Candle> | null;
    candles5m?: ReadonlyArray<Candle> | null;
    candles15m?: ReadonlyArray<Candle> | null;
    boxHigh?: number | null;
    boxLow?: number | null;
    rangeBoxHighAtEntry?: number | null;
    rangeBoxLowAtEntry?: number | null;
    feeRate?: number | null;
    paperSlippageEstimateBps?: number | null;
    minimumNetProfitPct?: number | null;
}>;

export type TrendDynamicTpResult = Readonly<{
    ok: boolean;
    rawTp1Price: number;
    tpSource: TrendDynamicTpProvenance;
    targetPct: number;
    minimumTpPct: number;
    atrTargetPct: number | null;
    structureTargetPct: number | null;
    blockReason?: string | null;
}>;

function computeATRFromCandles(candles: ReadonlyArray<Candle> | null | undefined, period = 14): number | null {
    if (!candles || candles.length < period + 1) return null;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1];
        const curr = candles[i];
        const tr = Math.max(
            curr.high - curr.low,
            Math.abs(curr.high - prev.close),
            Math.abs(curr.low - prev.close)
        );
        trs.push(tr);
    }
    if (trs.length < period) return null;
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Deterministically selects the closest valid structure extreme that satisfies the economic floor:
 * SHORT: valid swing low / support / boxLow below entry with distance >= minimumTpPct, pick closest to entry.
 * LONG: valid swing high / resistance / boxHigh above entry with distance >= minimumTpPct, pick closest to entry.
 */
function findClosestEconomicStructurePrice(
    side: "long" | "short",
    entryPrice: number,
    minimumTpPct: number,
    input: TrendDynamicTpInput
): number | null {
    const validCandidates: number[] = [];

    const addIfEligible = (price: unknown) => {
        if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return;
        const distPct = Math.abs(entryPrice - price) / entryPrice;
        if (side === "short") {
            if (price < entryPrice && distPct >= minimumTpPct - 1e-9) {
                validCandidates.push(price);
            }
        } else {
            if (price > entryPrice && distPct >= minimumTpPct - 1e-9) {
                validCandidates.push(price);
            }
        }
    };

    // 1. Box extremes
    addIfEligible(input.rangeBoxLowAtEntry);
    addIfEligible(input.boxLow);
    addIfEligible(input.rangeBoxHighAtEntry);
    addIfEligible(input.boxHigh);

    // 2. Scan recent candles (5m, 15m, 1m)
    const scanCandles = (candles: ReadonlyArray<Candle> | null | undefined, lookback = 20) => {
        if (!candles || candles.length === 0) return;
        const slice = candles.slice(-lookback);
        for (const c of slice) {
            addIfEligible(side === "short" ? c.low : c.high);
        }
    };

    scanCandles(input.candles5m, 20);
    scanCandles(input.candles15m, 20);
    scanCandles(input.candles1m, 30);

    if (validCandidates.length === 0) return null;

    // Pick closest to entryPrice (i.e. smallest distance from entryPrice)
    validCandidates.sort((a, b) => Math.abs(entryPrice - a) - Math.abs(entryPrice - b));
    return validCandidates[0];
}

/**
 * Computes dynamic TREND TP using hybrid ATR and market structure.
 */
export function computeTrendDynamicTp(input: TrendDynamicTpInput): TrendDynamicTpResult {
    const { side, entryPrice } = input;
    if (!(entryPrice > 0)) {
        return {
            ok: false,
            rawTp1Price: 0,
            tpSource: "engine_calculated_fallback",
            targetPct: 0,
            minimumTpPct: 0,
            atrTargetPct: null,
            structureTargetPct: null,
            blockReason: "V2_TREND_TP_PRICE_UNAVAILABLE"
        };
    }

    // 1. Economic Floor: computeMinimumProfitableTpPct (~0.30%)
    const minimumTpPct = computeMinimumProfitableTpPct({
        feeRate: input.feeRate,
        paperSlippageEstimateBps: input.paperSlippageEstimateBps,
        minimumNetProfitPct: input.minimumNetProfitPct
    });

    // 2. Resolve Multi-Timeframe ATR
    // Rule 2: atrTargetPct = max(atr5mPct * 2.5, atr15mPct * 1.5). 5m/15m 없을 때만 1m ATR fallback.
    const atr5mVal = input.atr5m ?? computeATRFromCandles(input.candles5m, 14);
    const atr15mVal = input.atr15m ?? computeATRFromCandles(input.candles15m, 14);
    const atr1mVal = input.atr1m ?? computeATRFromCandles(input.candles1m, 14);

    let atrTargetPct: number | null = null;
    if (atr5mVal != null && atr15mVal != null) {
        const atr5mPct = atr5mVal / entryPrice;
        const atr15mPct = atr15mVal / entryPrice;
        atrTargetPct = Math.max(atr5mPct * 2.5, atr15mPct * 1.5);
    } else if (atr5mVal != null) {
        atrTargetPct = (atr5mVal / entryPrice) * 2.5;
    } else if (atr15mVal != null) {
        atrTargetPct = (atr15mVal / entryPrice) * 1.5;
    } else if (atr1mVal != null) {
        // Fallback only when 5m/15m not available
        atrTargetPct = (atr1mVal / entryPrice) * 4.5;
    }

    // 3. Resolve Structure Target (Deterministic & Economic floor satisfying)
    const structPrice = findClosestEconomicStructurePrice(side, entryPrice, minimumTpPct, input);
    let structureTargetPct: number | null = null;
    if (structPrice != null) {
        const rawDistPct = Math.abs(entryPrice - structPrice) / entryPrice;
        if (rawDistPct > 0) {
            structureTargetPct = rawDistPct;
        }
    }

    // 4. Hybrid Synthesis & Provenance Resolution
    let finalTargetPct = 0;
    let tpSource: TrendDynamicTpProvenance = "engine_calculated_fallback";

    if (structureTargetPct != null && atrTargetPct != null) {
        // Rule 3:
        // lowerBound = max(minimumProfitableTpPct, atrTargetPct * 0.6)
        // upperBound = max(minimumProfitableTpPct, atrTargetPct * 1.6)
        // finalTargetPct = clamp(structureDistPct, lowerBound, upperBound)
        const lowerBound = Math.max(minimumTpPct, atrTargetPct * 0.6);
        const upperBound = Math.max(minimumTpPct, atrTargetPct * 1.6);
        finalTargetPct = clamp(structureTargetPct, lowerBound, upperBound);
        tpSource = "hybrid_atr_structure";
    } else if (atrTargetPct != null) {
        // ATR only fallback
        finalTargetPct = Math.max(atrTargetPct, minimumTpPct);
        tpSource = "atr_only_fallback";
    } else if (structureTargetPct != null) {
        // Structure only fallback
        finalTargetPct = Math.max(structureTargetPct, minimumTpPct);
        tpSource = "structure_only_fallback";
    } else {
        // Rule 3: 고정 1.05%는 ATR/structure 둘 다 없는 최종 fallback에서만 사용.
        const mirrorTp = engineMirrorTpPrice(entryPrice, side, "TREND");
        if (mirrorTp != null) {
            finalTargetPct = Math.max(Math.abs(entryPrice - mirrorTp) / entryPrice, minimumTpPct);
        } else {
            finalTargetPct = Math.max(0.0105, minimumTpPct);
        }
        tpSource = "engine_calculated_fallback";
    }

    // 5. Directional Invariant Calculation
    const rawTp1Price = side === "long"
        ? entryPrice * (1 + finalTargetPct)
        : entryPrice * (1 - finalTargetPct);

    // Directional Invariant Guard: Short must have TP < entry; Long must have TP > entry
    if (side === "short" && !(rawTp1Price < entryPrice)) {
        return {
            ok: false,
            rawTp1Price: 0,
            tpSource,
            targetPct: finalTargetPct,
            minimumTpPct,
            atrTargetPct,
            structureTargetPct,
            blockReason: "TP_DIRECTION_INVALID"
        };
    }
    if (side === "long" && !(rawTp1Price > entryPrice)) {
        return {
            ok: false,
            rawTp1Price: 0,
            tpSource,
            targetPct: finalTargetPct,
            minimumTpPct,
            atrTargetPct,
            structureTargetPct,
            blockReason: "TP_DIRECTION_INVALID"
        };
    }

    return {
        ok: true,
        rawTp1Price,
        tpSource,
        targetPct: finalTargetPct,
        minimumTpPct,
        atrTargetPct,
        structureTargetPct,
        blockReason: null
    };
}
