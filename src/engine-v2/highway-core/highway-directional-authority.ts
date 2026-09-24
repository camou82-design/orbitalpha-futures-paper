import { Candle, MarketSymbol } from "../../models/types";
import { detectHighwayTrend, HIGHWAY_TREND_MIN_CANDLES } from "../../engine/highway-trend-detector";
import { emaLastFromCloses } from "../../utils/math";

export type HighwayDirectionalState = "STRONG_UP" | "STRONG_DOWN" | "TRANSITION" | "NEUTRAL";

export interface HighwayDirectionalAuthority {
    state: HighwayDirectionalState;
    strongUp: boolean;
    strongDown: boolean;
    ema10: number;
    ema20: number;
    ema60: number;
    ema10SlopeBps: number;
    ema20SlopeBps: number;
    emaGap: number;
    earlyRecoveryUpEligible: boolean;
    earlyRecoveryDownEligible: boolean;
    details: {
        priceAboveEma10: boolean;
        priceAboveEma20: boolean;
        priceAboveEma60: boolean;
        ema10Above20: boolean;
        highwayTrendState?: string;
        highwayAlignScore?: number;
        lastClosedClose?: number;
        ema10SlopeInflectionUp?: boolean;
        ema10SlopeInflectionDown?: boolean;
    };
}

export interface HighwayDirectionalInput {
    snapshot?: any;
    candles?: Candle[] | any[] | null;
    symbol?: string;
    lastPrice?: number;
    ema10?: number | null;
    ema20?: number | null;
    ema60?: number | null;
    emaGap?: number | null;
}

/** Completed closed candles only (exclude in-flight last bar). */
function closedCandleCloses(candles: any[]): number[] {
    if (candles.length === 0) return [];
    const series = candles.length >= 2 ? candles.slice(0, -1) : candles;
    return series
        .map((c: any) => Number(c.close ?? c[4] ?? 0))
        .filter((v: number) => Number.isFinite(v) && v > 0);
}

/**
 * Consensus adapter over canonical `detectHighwayTrend` + snapshot EMA gap/slopes.
 * STRONG_UP / STRONG_DOWN => zero exceptions for opposing RANGE entries (enforced upstream).
 */
export function resolveHighwayDirectionalAuthority(input: HighwayDirectionalInput): HighwayDirectionalAuthority {
    const symbol = String(input.symbol ?? input.snapshot?.symbol ?? "").toUpperCase();
    const candles = input.candles ?? input.snapshot?.candles ?? [];
    const sn = input.snapshot ?? {};

    const lastPrice = Number(
        input.lastPrice ??
        sn.lastPrice ??
        (candles.length > 0 ? Number(candles[candles.length - 1].close ?? candles[candles.length - 1][4] ?? 0) : 0)
    );

    const closedCloses = closedCandleCloses(candles);
    const lastClosedClose =
        closedCloses.length > 0 ? closedCloses[closedCloses.length - 1] : lastPrice;

    let ema10 =
        typeof input.ema10 === "number" && Number.isFinite(input.ema10) ? input.ema10 : Number(sn.ema10 ?? 0);
    let ema20 =
        typeof input.ema20 === "number" && Number.isFinite(input.ema20) ? input.ema20 : Number(sn.ema20 ?? 0);
    let ema60 =
        typeof input.ema60 === "number" && Number.isFinite(input.ema60) ? input.ema60 : Number(sn.ema60 ?? 0);

    const closesForEma = closedCloses.length >= 10 ? closedCloses : closedCloses;
    if (closesForEma.length >= 10 && (ema10 <= 0 || !Number.isFinite(ema10))) {
        ema10 = emaLastFromCloses(closesForEma, 10) ?? lastClosedClose;
    }
    if (closesForEma.length >= 20 && (ema20 <= 0 || !Number.isFinite(ema20))) {
        ema20 = emaLastFromCloses(closesForEma, 20) ?? lastClosedClose;
    }
    if (closesForEma.length >= 60 && (ema60 <= 0 || !Number.isFinite(ema60))) {
        ema60 = emaLastFromCloses(closesForEma, 60) ?? lastClosedClose;
    }

    if (ema10 <= 0) ema10 = lastClosedClose;
    if (ema20 <= 0) ema20 = lastClosedClose;
    if (ema60 <= 0) ema60 = lastClosedClose;

    let ema10SlopeBps = 0;
    let ema20SlopeBps = 0;
    let prevEma10SlopeBps = 0;

    if (closedCloses.length >= 12) {
        const prevCloses = closedCloses.slice(0, -1);
        const prevEma10 = emaLastFromCloses(prevCloses, 10) ?? ema10;
        const prevEma20 = emaLastFromCloses(prevCloses, 20) ?? ema20;
        const prev2Closes = closedCloses.length >= 13 ? closedCloses.slice(0, -2) : prevCloses;
        const prev2Ema10 = emaLastFromCloses(prev2Closes, 10) ?? prevEma10;

        if (prevEma10 > 0) {
            ema10SlopeBps = ((ema10 - prevEma10) / prevEma10) * 10000;
        }
        if (prevEma20 > 0) {
            ema20SlopeBps = ((ema20 - prevEma20) / prevEma20) * 10000;
        }
        if (prev2Ema10 > 0 && prevEma10 > 0) {
            prevEma10SlopeBps = ((prevEma10 - prev2Ema10) / prev2Ema10) * 10000;
        }
    } else if (typeof sn.ema10Slope === "number" && Number.isFinite(sn.ema10Slope)) {
        ema10SlopeBps = sn.ema10Slope * 10000;
    }

    let emaGap =
        typeof input.emaGap === "number" && Number.isFinite(input.emaGap)
            ? input.emaGap
            : typeof sn.emaGap === "number" && Number.isFinite(sn.emaGap)
              ? sn.emaGap
              : ema60 > 0
                ? (ema20 - ema60) / ema60
                : 0;

    let highwayTrendState = "UNKNOWN";
    let highwayAlignScore = 0;
    const closedCandlesForHighway =
        candles.length >= HIGHWAY_TREND_MIN_CANDLES + 1
            ? (candles.slice(0, -1) as Candle[])
            : (candles as Candle[]);

    if (closedCandlesForHighway.length >= HIGHWAY_TREND_MIN_CANDLES && symbol) {
        try {
            const hTrend = detectHighwayTrend(closedCandlesForHighway, symbol as MarketSymbol);
            highwayTrendState = String(hTrend.state);
            highwayAlignScore = Number(hTrend.alignmentScore ?? 0);
        } catch {
            // fall through
        }
    }

    const ema10Above60 = ema10 > ema60;
    const canonicalStrongAlignment = highwayAlignScore >= 0.9;

    const strongUp =
        canonicalStrongAlignment &&
        ema10Above60 &&
        lastClosedClose > ema20 &&
        ema10 >= ema20 * 0.9998 &&
        ema10SlopeBps > 0.3 &&
        ema20SlopeBps >= -0.1 &&
        (emaGap > 0 || lastClosedClose > ema60);

    const strongDown =
        canonicalStrongAlignment &&
        !ema10Above60 &&
        lastClosedClose < ema20 &&
        ema10 <= ema20 * 1.0002 &&
        ema10SlopeBps < -0.3 &&
        ema20SlopeBps <= 0.1 &&
        (emaGap < 0 || lastClosedClose < ema60);

    const ema10SlopeInflectionUp = ema10SlopeBps > 0.2 && prevEma10SlopeBps <= 0;
    const ema10SlopeInflectionDown = ema10SlopeBps < -0.2 && prevEma10SlopeBps >= 0;

    const earlyRecoveryUpEligible =
        !strongDown &&
        lastClosedClose > ema10 &&
        ema10SlopeInflectionUp &&
        ema10SlopeBps > 0.2;

    const earlyRecoveryDownEligible =
        !strongUp &&
        lastClosedClose < ema10 &&
        ema10SlopeInflectionDown &&
        ema10SlopeBps < -0.2;

    let state: HighwayDirectionalState = "NEUTRAL";
    if (strongUp) state = "STRONG_UP";
    else if (strongDown) state = "STRONG_DOWN";
    else if (earlyRecoveryUpEligible || earlyRecoveryDownEligible) state = "TRANSITION";

    return {
        state,
        strongUp,
        strongDown,
        ema10,
        ema20,
        ema60,
        ema10SlopeBps,
        ema20SlopeBps,
        emaGap,
        earlyRecoveryUpEligible,
        earlyRecoveryDownEligible,
        details: {
            priceAboveEma10: lastClosedClose > ema10,
            priceAboveEma20: lastClosedClose > ema20,
            priceAboveEma60: lastClosedClose > ema60,
            ema10Above20: ema10 >= ema20,
            highwayTrendState,
            highwayAlignScore,
            lastClosedClose,
            ema10SlopeInflectionUp,
            ema10SlopeInflectionDown
        }
    };
}
