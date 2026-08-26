import type { Candle } from "../../models/types";

export const FTS_STRUCTURAL_STOP_BASIS = "fast_trend_shift_structural_stop";
export const FTS_STRUCTURAL_ATR_BUFFER_DEFAULT = 0.35;
export const FTS_STRUCTURAL_ATR_BUFFER_MIN = 0.3;
export const FTS_STRUCTURAL_ATR_BUFFER_MAX = 0.5;
export const FTS_ABSOLUTE_SAFETY_MAX_STOP_PCT = 0.03;

export type FastTrendShiftStructuralStopInput = Readonly<{
    side: "long" | "short";
    entryPrice: number;
    lastPrice: number;
    atr: number;
    closedCandles: readonly Candle[];
    boxMid?: number | null;
    previousConfirmedBoxHigh?: number | null;
    previousConfirmedBoxLow?: number | null;
    atrBufferMultiple?: number;
}>;

export type FastTrendShiftStructuralStopResult = Readonly<{
    stopPrice: number | null;
    structuralInvalidationPrice: number | null;
    structuralSource: string | null;
    atrBufferMultiple: number;
    atrBufferPrice: number | null;
    stopBasis: string;
    stopDistancePct: number | null;
    valid: boolean;
    invalidReason: string | null;
    /** Pivot ± ATR buffer before non-tightening floor. */
    structuralCandidateStop?: number | null;
    /** Pre-FTS conservative_probe_basis on closed candles only (range-executor EARLY_* formula). */
    oldClosedOnlySafetyStop?: number | null;
    nonTighteningFloorApplied?: boolean;
}>;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function isFinitePositive(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Closed candles only — excludes the forming/live last bar. */
export function getClosedCandlesForStructuralStop(candles: readonly Candle[] | null | undefined): Candle[] {
    if (!candles || candles.length < 2) return [];
    return candles.slice(0, -1);
}

export function findConfirmedSwingHighs(
    closed: readonly Candle[],
    pivotLookback = 2
): ReadonlyArray<{ index: number; price: number }> {
    const pivots: Array<{ index: number; price: number }> = [];
    if (closed.length < pivotLookback * 2 + 1) return pivots;
    for (let i = pivotLookback; i < closed.length - pivotLookback; i++) {
        const h = closed[i]!.high;
        let isPivot = true;
        for (let j = i - pivotLookback; j <= i + pivotLookback; j++) {
            if (j === i) continue;
            if (closed[j]!.high >= h) {
                isPivot = false;
                break;
            }
        }
        if (isPivot) pivots.push({ index: i, price: h });
    }
    return pivots;
}

export function findConfirmedSwingLows(
    closed: readonly Candle[],
    pivotLookback = 2
): ReadonlyArray<{ index: number; price: number }> {
    const pivots: Array<{ index: number; price: number }> = [];
    if (closed.length < pivotLookback * 2 + 1) return pivots;
    for (let i = pivotLookback; i < closed.length - pivotLookback; i++) {
        const l = closed[i]!.low;
        let isPivot = true;
        for (let j = i - pivotLookback; j <= i + pivotLookback; j++) {
            if (j === i) continue;
            if (closed[j]!.low <= l) {
                isPivot = false;
                break;
            }
        }
        if (isPivot) pivots.push({ index: i, price: l });
    }
    return pivots;
}

function selectNearestConfirmedSwingHighAboveEntry(
    entryPrice: number,
    pivots: ReadonlyArray<{ index: number; price: number }>
): { price: number; source: string } | null {
    const above = pivots.filter((p) => p.price > entryPrice);
    if (above.length === 0) return null;
    const sorted = [...above].sort((a, b) => b.index - a.index);
    const recent = sorted[0]!;
    const prior = sorted.find((p) => p.index < recent.index);
    if (prior && recent.price < prior.price) {
        return { price: recent.price, source: "confirmed_lower_high_swing" };
    }
    return { price: recent.price, source: "confirmed_swing_high" };
}

function selectNearestConfirmedSwingLowBelowEntry(
    entryPrice: number,
    pivots: ReadonlyArray<{ index: number; price: number }>
): { price: number; source: string } | null {
    const below = pivots.filter((p) => p.price < entryPrice);
    if (below.length === 0) return null;
    const sorted = [...below].sort((a, b) => b.index - a.index);
    const recent = sorted[0]!;
    const prior = sorted.find((p) => p.index < recent.index);
    if (prior && recent.price > prior.price) {
        return { price: recent.price, source: "confirmed_higher_low_swing" };
    }
    return { price: recent.price, source: "confirmed_swing_low" };
}

/**
 * Pre-FTS conservative_probe_basis (range-executor.ts EARLY_SHORT_PROBE) with closed candles
 * only for the 10-bar swing component — forming bar excluded.
 */
export function computeClosedOnlyConservativeProbeStopShort(
    lastPrice: number,
    atr: number,
    boxMid: number,
    closed: readonly Candle[]
): number {
    const swingHigh =
        closed.length >= 10 ? Math.max(...closed.slice(-10).map((c) => c.high)) : lastPrice * 1.01;
    const stopBasisMid = boxMid * 1.002;
    const stopBasisAtr = lastPrice + atr * 2.0;
    return Math.max(swingHigh, stopBasisMid, stopBasisAtr);
}

/**
 * Pre-FTS conservative_probe_basis (range-executor.ts EARLY_LONG_PROBE) with closed candles
 * only for the 10-bar swing component — forming bar excluded.
 */
export function computeClosedOnlyConservativeProbeStopLong(
    lastPrice: number,
    atr: number,
    boxMid: number,
    closed: readonly Candle[]
): number {
    const swingLow =
        closed.length >= 10 ? Math.min(...closed.slice(-10).map((c) => c.low)) : lastPrice * 0.99;
    const stopBasisMid = boxMid * 0.998;
    const stopBasisAtr = lastPrice - atr * 2.0;
    return Math.min(swingLow, stopBasisMid, stopBasisAtr);
}

function computeFallbackConservativeProbeShort(
    lastPrice: number,
    atr: number,
    boxMid: number | null,
    closed: readonly Candle[]
): number {
    if (boxMid != null && boxMid > 0) {
        return computeClosedOnlyConservativeProbeStopShort(lastPrice, atr, boxMid, closed);
    }
    const closedSwingHigh =
        closed.length >= 10 ? Math.max(...closed.slice(-10).map((c) => c.high)) : lastPrice * 1.01;
    const stopBasisMid = lastPrice * 1.002;
    const stopBasisAtr = lastPrice + atr * 2.0;
    return Math.max(closedSwingHigh, stopBasisMid, stopBasisAtr);
}

function computeFallbackConservativeProbeLong(
    lastPrice: number,
    atr: number,
    boxMid: number | null,
    closed: readonly Candle[]
): number {
    if (boxMid != null && boxMid > 0) {
        return computeClosedOnlyConservativeProbeStopLong(lastPrice, atr, boxMid, closed);
    }
    const closedSwingLow =
        closed.length >= 10 ? Math.min(...closed.slice(-10).map((c) => c.low)) : lastPrice * 0.99;
    const stopBasisMid = lastPrice * 0.998;
    const stopBasisAtr = lastPrice - atr * 2.0;
    return Math.min(closedSwingLow, stopBasisMid, stopBasisAtr);
}

function resolveOldClosedOnlySafetyStop(
    side: "long" | "short",
    lastPrice: number,
    atr: number,
    boxMid: number | null,
    closed: readonly Candle[]
): number | null {
    if (boxMid == null || !(boxMid > 0)) return null;
    return side === "short"
        ? computeClosedOnlyConservativeProbeStopShort(lastPrice, atr, boxMid, closed)
        : computeClosedOnlyConservativeProbeStopLong(lastPrice, atr, boxMid, closed);
}

function finalizeFastTrendShiftStop(input: {
    side: "long" | "short";
    entryPrice: number;
    structuralCandidateStop: number;
    structuralInvalidationPrice: number;
    structuralSource: string;
    atrBufferMultiple: number;
    atrBufferPrice: number;
    oldClosedOnlySafetyStop: number | null;
}): FastTrendShiftStructuralStopResult {
    const { side, entryPrice, structuralCandidateStop, oldClosedOnlySafetyStop } = input;
    let stopPrice = structuralCandidateStop;
    let nonTighteningFloorApplied = false;
    if (oldClosedOnlySafetyStop != null && Number.isFinite(oldClosedOnlySafetyStop)) {
        if (side === "short" && oldClosedOnlySafetyStop > stopPrice) {
            stopPrice = oldClosedOnlySafetyStop;
            nonTighteningFloorApplied = true;
        } else if (side === "long" && oldClosedOnlySafetyStop < stopPrice) {
            stopPrice = oldClosedOnlySafetyStop;
            nonTighteningFloorApplied = true;
        }
    }
    const directionValid = side === "long" ? stopPrice < entryPrice : stopPrice > entryPrice;
    const stopDistancePct =
        side === "long"
            ? (entryPrice - stopPrice) / entryPrice
            : (stopPrice - entryPrice) / entryPrice;
    if (!directionValid) {
        return invalidResult(side === "long" ? "LONG_STOP_NOT_BELOW_ENTRY" : "SHORT_STOP_NOT_ABOVE_ENTRY", {
            structuralInvalidationPrice: input.structuralInvalidationPrice,
            structuralSource: input.structuralSource,
            atrBufferMultiple: input.atrBufferMultiple,
            atrBufferPrice: input.atrBufferPrice,
            stopPrice,
            structuralCandidateStop,
            oldClosedOnlySafetyStop,
            nonTighteningFloorApplied
        });
    }
    if (stopDistancePct > FTS_ABSOLUTE_SAFETY_MAX_STOP_PCT) {
        return invalidResult("STOP_DISTANCE_TOO_WIDE", {
            structuralInvalidationPrice: input.structuralInvalidationPrice,
            structuralSource: input.structuralSource,
            atrBufferMultiple: input.atrBufferMultiple,
            atrBufferPrice: input.atrBufferPrice,
            stopPrice,
            stopDistancePct,
            structuralCandidateStop,
            oldClosedOnlySafetyStop,
            nonTighteningFloorApplied
        });
    }
    return {
        stopPrice,
        structuralInvalidationPrice: input.structuralInvalidationPrice,
        structuralSource: input.structuralSource,
        atrBufferMultiple: input.atrBufferMultiple,
        atrBufferPrice: input.atrBufferPrice,
        stopBasis: FTS_STRUCTURAL_STOP_BASIS,
        stopDistancePct,
        valid: true,
        invalidReason: null,
        structuralCandidateStop,
        oldClosedOnlySafetyStop,
        nonTighteningFloorApplied
    };
}

function invalidResult(
    invalidReason: string,
    partial: Partial<FastTrendShiftStructuralStopResult> = {}
): FastTrendShiftStructuralStopResult {
    return {
        stopPrice: null,
        structuralInvalidationPrice: null,
        structuralSource: null,
        atrBufferMultiple: FTS_STRUCTURAL_ATR_BUFFER_DEFAULT,
        atrBufferPrice: null,
        stopBasis: FTS_STRUCTURAL_STOP_BASIS,
        stopDistancePct: null,
        valid: false,
        invalidReason,
        ...partial
    };
}

export function resolveFastTrendShiftStructuralStop(
    input: FastTrendShiftStructuralStopInput
): FastTrendShiftStructuralStopResult {
    const entryPrice = input.entryPrice;
    const lastPrice = input.lastPrice;
    const atr = input.atr;
    const closed = input.closedCandles;
    const bufferMult = clamp(
        input.atrBufferMultiple ?? FTS_STRUCTURAL_ATR_BUFFER_DEFAULT,
        FTS_STRUCTURAL_ATR_BUFFER_MIN,
        FTS_STRUCTURAL_ATR_BUFFER_MAX
    );

    if (!isFinitePositive(entryPrice) || !isFinitePositive(lastPrice)) {
        return invalidResult("PRICE_INVALID");
    }
    if (!isFinitePositive(atr)) {
        return invalidResult("ATR_INVALID");
    }

    const boxMid =
        input.boxMid ??
        (isFinitePositive(input.previousConfirmedBoxHigh) && isFinitePositive(input.previousConfirmedBoxLow)
            ? (input.previousConfirmedBoxHigh + input.previousConfirmedBoxLow) / 2
            : null);

    const atrBufferPrice = atr * bufferMult;
    const oldClosedOnlySafetyStop = resolveOldClosedOnlySafetyStop(
        input.side,
        lastPrice,
        atr,
        boxMid,
        closed
    );

    if (input.side === "short") {
        const pivots = findConfirmedSwingHighs(closed);
        const selected = selectNearestConfirmedSwingHighAboveEntry(entryPrice, pivots);
        let structuralInvalidationPrice: number;
        let structuralSource: string;
        if (selected) {
            structuralInvalidationPrice = selected.price;
            structuralSource = selected.source;
        } else {
            structuralInvalidationPrice = computeFallbackConservativeProbeShort(lastPrice, atr, boxMid, closed);
            structuralSource = "fallback_conservative_probe";
        }
        const structuralCandidateStop = structuralInvalidationPrice + atrBufferPrice;
        return finalizeFastTrendShiftStop({
            side: "short",
            entryPrice,
            structuralCandidateStop,
            structuralInvalidationPrice,
            structuralSource,
            atrBufferMultiple: bufferMult,
            atrBufferPrice,
            oldClosedOnlySafetyStop
        });
    }

    const pivots = findConfirmedSwingLows(closed);
    const selected = selectNearestConfirmedSwingLowBelowEntry(entryPrice, pivots);
    let structuralInvalidationPrice: number;
    let structuralSource: string;
    if (selected) {
        structuralInvalidationPrice = selected.price;
        structuralSource = selected.source;
    } else {
        structuralInvalidationPrice = computeFallbackConservativeProbeLong(lastPrice, atr, boxMid, closed);
        structuralSource = "fallback_conservative_probe";
    }
    const structuralCandidateStop = structuralInvalidationPrice - atrBufferPrice;
    return finalizeFastTrendShiftStop({
        side: "long",
        entryPrice,
        structuralCandidateStop,
        structuralInvalidationPrice,
        structuralSource,
        atrBufferMultiple: bufferMult,
        atrBufferPrice,
        oldClosedOnlySafetyStop
    });
}

export function isFastTrendShiftCanonicalStructuralStopBasis(stopBasis: unknown): boolean {
    return stopBasis === FTS_STRUCTURAL_STOP_BASIS;
}
