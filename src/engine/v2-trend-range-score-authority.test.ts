import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    resolveFastTrendStructuralEvidence,
    resolveTrendRangeScoreAuthority,
    applyTrendRangeRegimeFinalAuthority
} from "../engine-v2/market-judgment/trend-range-score-authority";
import type { Candle } from "../models/types";
import type { EngineV2Input } from "../engine-v2/types";

function candlesAround(price: number, n = 24): Candle[] {
    const baseTs = 1788410000000;
    return Array.from({ length: n }, (_, i) => {
        const close = price + i * 5;
        return {
            ts: baseTs + i * 60_000,
            open: close - 2,
            high: close + 4,
            low: close - 3,
            close,
            volume: 100
        };
    });
}

describe("V2 trend/range score authority", () => {
    it("clears conflicting upper/lower holds using same box and price authority", () => {
        const boxHigh = 100;
        const boxLow = 90;
        const lastPrice = 101;
        const candles = candlesAround(98);
        const structural = resolveFastTrendStructuralEvidence({
            candles,
            snapshot: { lastPrice, boxHigh, boxLow, ema20Slope: 0.0002 }
        });
        assert.equal(structural.upper_breakout_hold, true);
        assert.equal(structural.lower_breakdown_hold, false);
    });

    it("elevates final_trend_score from structural evidence when ema gap is weak", () => {
        const candles = candlesAround(80000);
        const input = {
            symbol: "BTCUSDT",
            now: Date.now(),
            candles,
            snapshot: {
                lastPrice: candles[candles.length - 1].close,
                boxHigh: 80100,
                boxLow: 79000,
                boxPos: 0.82,
                emaGap: 0.000106,
                ema20Slope: 0.0002,
                rangeConfidence: 0.688858,
                canonicalRangeConfidence: 0.688858,
                trendWeaknessScore: 0.22,
                boxBreakSide: "upper"
            },
            state: { directionalShockState: "NONE", crashState: "NONE" }
        } as EngineV2Input;
        const structural = resolveFastTrendStructuralEvidence({ candles, snapshot: input.snapshot });
        const score = resolveTrendRangeScoreAuthority({
            input,
            regimeBefore: "RANGE",
            structural,
            htfEntryPolicy: "ALLOW",
            fastTrendShiftActive: true,
            fastTrendDirection: "long",
            ftsProbeAllowed: true
        });
        assert.ok(score.ema_gap_component < 0.2);
        assert.ok(score.final_trend_score >= 0.55);
        assert.ok(score.final_range_score < 0.688858);

        const promo = applyTrendRangeRegimeFinalAuthority({
            regimeFinal: "RANGE",
            shockPhase: "NONE",
            crashState: "NONE",
            directionalShockState: "NONE",
            trendPhase: "PULLBACK",
            htfEntryPolicy: "ALLOW",
            scoreAuthority: score,
            fastTrendShiftActive: true,
            fastTrendDirection: "long",
            ftsProbeAllowed: true
        });
        assert.equal(promo.regimeFinal, "TREND");
    });
});
