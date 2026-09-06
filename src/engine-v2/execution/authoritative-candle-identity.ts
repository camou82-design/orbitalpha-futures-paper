import type { Candle } from "../../models/types";
import { getClosedCandlesForStructuralStop } from "../risk-sizing/fast-trend-shift-structural-stop";

export type V2AuthoritativeCandleIdentity = Readonly<{
    /** Forming-bar tip ts — aligns with range-executor `lastCandleTimestamp` cycle identity. */
    authoritativeCandleTs: number | null;
    /** Last closed candle ts — aligns with `getClosedCandlesForStructuralStop` gates. */
    closedCandleTs: number | null;
}>;

function candleBarTs(bar: { ts?: number; timestamp?: number } | null | undefined): number | null {
    if (!bar) return null;
    const ts = typeof bar.ts === "number" ? bar.ts : typeof bar.timestamp === "number" ? bar.timestamp : null;
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
    return ts;
}

/**
 * Resolve execution decision candle identity at V2 authority creation time.
 * Never uses wall-clock, fetchedAt, or downstream snapshot re-read.
 */
export function resolveV2AuthoritativeCandleIdentity(
    candles: readonly Candle[] | null | undefined
): V2AuthoritativeCandleIdentity {
    if (!candles || candles.length === 0) {
        return { authoritativeCandleTs: null, closedCandleTs: null };
    }
    const authoritativeCandleTs = candleBarTs(candles[candles.length - 1]);
    const closed = getClosedCandlesForStructuralStop(candles);
    const closedCandleTs = closed.length > 0 ? candleBarTs(closed[closed.length - 1]) : null;
    return { authoritativeCandleTs, closedCandleTs };
}
