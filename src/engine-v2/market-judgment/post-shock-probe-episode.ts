import type { Candle } from "../../models/types";

export type PostShockDirection = "UP" | "DOWN" | "NONE";

export interface PostShockCandleMetrics {
    shockDirection: PostShockDirection;
    shockDetected: boolean;
    shockExtremumTs: number;
    closedCandlesSinceExtremum: number;
    rawShockMovePct: number;
    requiredShockMovePct: number;
}

function candleTs(c: any): number {
    const ts = Number(c?.ts ?? c?.[0] ?? 0);
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
}

export function buildPostShockProbeEpisodeId(input: Readonly<{
    symbol: string;
    shockDirection: "UP" | "DOWN";
    shockExtremumTs: number;
}>): string {
    const sym = String(input.symbol ?? "").toUpperCase();
    const dir = input.shockDirection;
    const ts = Math.max(0, Math.floor(Number(input.shockExtremumTs ?? 0)));
    return `${sym}:${dir}:${ts}`;
}

export function resolvePostShockCandleMetrics(input: Readonly<{
    lastPrice: number;
    atr: number;
    candles?: Candle[] | any[] | null;
    shockPhase?: string | null;
    directionalShockState?: string | null;
    rawDirectionalShockState?: string | null;
}>): PostShockCandleMetrics {
    const lastPrice = Number(input.lastPrice ?? 0);
    const atr = Number(input.atr ?? (lastPrice * 0.01));
    const atrPct = lastPrice > 0 ? atr / lastPrice : 0.01;
    const requiredShockMovePct = Math.max(0.0030, atrPct * 1.35);
    const candles = input.candles ?? [];

    const shockPhase = String(input.shockPhase ?? "").toUpperCase();
    const dss = String(input.directionalShockState ?? "").toUpperCase();
    const rawDss = String(input.rawDirectionalShockState ?? "").toUpperCase();

    let shockDirection: PostShockDirection = "NONE";
    let shockDetected = false;
    let rawShockMovePct = 0;
    let closedCandlesSinceExtremum = 0;
    let shockExtremumTs = 0;

    if (shockPhase === "DOWN_SHOCK" || dss === "DOWN" || rawDss === "DOWN") {
        shockDirection = "DOWN";
        shockDetected = true;
    } else if (shockPhase === "UP_SHOCK" || dss === "UP" || rawDss === "UP") {
        shockDirection = "UP";
        shockDetected = true;
    }

    if (candles && candles.length >= 4) {
        const closed = candles.slice(0, -1);
        const lookback = closed.slice(-15);
        if (lookback.length >= 3) {
            let maxHigh = -Infinity;
            let maxHighIdx = -1;
            let minLow = Infinity;
            let minLowIdx = -1;

            lookback.forEach((c: any, idx: number) => {
                const h = Number(c.high ?? c[2] ?? 0);
                const l = Number(c.low ?? c[3] ?? 0);
                if (h > maxHigh) {
                    maxHigh = h;
                    maxHighIdx = idx;
                }
                if (l < minLow) {
                    minLow = l;
                    minLowIdx = idx;
                }
            });

            if (maxHighIdx < minLowIdx && maxHigh > 0 && minLow > 0) {
                const dropPct = (maxHigh - minLow) / maxHigh;
                if (dropPct >= requiredShockMovePct) {
                    rawShockMovePct = Math.max(rawShockMovePct, dropPct);
                    shockDirection = "DOWN";
                    shockDetected = true;
                    closedCandlesSinceExtremum = lookback.length - 1 - minLowIdx;
                    shockExtremumTs = candleTs(lookback[minLowIdx]);
                }
            }

            if (minLowIdx < maxHighIdx && minLow > 0 && maxHigh > 0) {
                const pumpPct = (maxHigh - minLow) / minLow;
                if (pumpPct >= requiredShockMovePct) {
                    rawShockMovePct = Math.max(rawShockMovePct, pumpPct);
                    shockDirection = "UP";
                    shockDetected = true;
                    closedCandlesSinceExtremum = lookback.length - 1 - maxHighIdx;
                    shockExtremumTs = candleTs(lookback[maxHighIdx]);
                }
            }
        }
    }

    if (shockDetected && shockExtremumTs <= 0 && candles.length >= 2) {
        const closed = candles.slice(0, -1);
        const lastClosed = closed[closed.length - 1];
        shockExtremumTs = candleTs(lastClosed);
    }

    return {
        shockDirection,
        shockDetected,
        shockExtremumTs,
        closedCandlesSinceExtremum,
        rawShockMovePct,
        requiredShockMovePct
    };
}
