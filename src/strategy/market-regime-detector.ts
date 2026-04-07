import type { Candle } from "../models/types";
import { atrWilderLast } from "./entry-gate";

export type MarketRegime = "RANGE" | "TREND" | "NO_TRADE";

export type MarketRegimeDetection = Readonly<{
  regime: MarketRegime;
  detail: Record<string, unknown>;
}>;

function emaLast(closes: readonly number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes[0]!;
  for (let i = 1; i < closes.length; i++) e = closes[i]! * k + e * (1 - k);
  return e;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Market regime detector (paper futures).
 *
 * Design goal:
 * - RANGE: box-like, mean-reverting context (only edge trades should be allowed by execution layer)
 * - TREND: directional expansion (breakout/pullback entries)
 * - NO_TRADE: unstable / low-quality / risk-off (block all entries, log only)
 *
 * Inputs are intentionally BTC-centric to keep the engine conservative across symbols.
 */
export function detectMarketRegime(input: Readonly<{ btcCandles5m: readonly Candle[] }>): MarketRegimeDetection {
  const c = input.btcCandles5m;
  if (c.length < 60) {
    return {
      regime: "NO_TRADE",
      detail: { reason: "insufficient_btc_5m", len: c.length }
    };
  }

  // Use only completed candles for stability.
  const completed = c.slice(0, -1);
  const closes = completed.map((x) => x.close);
  const last = closes[closes.length - 1]!;

  const e20 = emaLast(closes.slice(-80), 20);
  const e60 = emaLast(closes.slice(-140), 60);
  if (e20 === null || e60 === null || !Number.isFinite(last) || last <= 0) {
    return { regime: "NO_TRADE", detail: { reason: "ema_not_ready_or_bad_price" } };
  }
  const bias: "up" | "down" | "flat" = e20 > e60 * 1.0012 ? "up" : e20 < e60 * 0.9988 ? "down" : "flat";

  // Volatility (ATR) as a fraction of price, plus recent high/low box width.
  const atr = atrWilderLast(completed.slice(-80), 14);
  const atrRel = atr !== null && atr > 0 ? atr / last : 0;

  const lookback = completed.slice(-24); // ~2 hours on 5m
  const hi = Math.max(...lookback.map((x) => x.high));
  const lo = Math.min(...lookback.map((x) => x.low));
  const boxRel = (hi - lo) / (last + 1e-9);

  // Directionality: EMA separation and slope proxy.
  const emaSepRel = Math.abs(e20 - e60) / (last + 1e-9);
  const e20Prev = emaLast(closes.slice(-100, -20), 20);
  const slopeRel = e20Prev !== null ? (e20 - e20Prev) / (last + 1e-9) : 0;

  // "Box maintenance": how much closes stay within the recent box.
  let inside = 0;
  for (const x of lookback) {
    if (x.close <= hi * 1.0005 && x.close >= lo * 0.9995) inside += 1;
  }
  const insideRatio = lookback.length > 0 ? inside / lookback.length : 0;

  // Sharp drawdown / panic -> NO_TRADE.
  const drop5 =
    closes.length >= 6 ? (closes[closes.length - 1]! - closes[closes.length - 6]!) / closes[closes.length - 6]! : 0;
  const drop12 =
    closes.length >= 13
      ? (closes[closes.length - 1]! - closes[closes.length - 13]!) / closes[closes.length - 13]!
      : 0;

  const volTooHigh = atrRel > 0.0105 || boxRel > 0.035; // conservative "unstable" cap
  const dumpRisk = drop5 < -0.013 || drop12 < -0.022;
  if (dumpRisk || volTooHigh) {
    return {
      regime: "NO_TRADE",
      detail: {
        reason: dumpRisk ? "dump_risk" : "vol_too_high",
        atr_rel: atrRel,
        box_rel: boxRel,
        drop5,
        drop12,
        ema_sep_rel: emaSepRel,
        slope_rel: slopeRel,
        inside_ratio: insideRatio,
        bias
      }
    };
  }

  // Trend score: separation + slope + "box break" tendency.
  const sepScore = clamp01((emaSepRel - 0.0025) / 0.0045);
  const slopeScore = clamp01((Math.abs(slopeRel) - 0.0006) / 0.0014);
  const boxScore = clamp01((boxRel - 0.015) / 0.02);
  const trendScore = 0.45 * sepScore + 0.35 * slopeScore + 0.2 * boxScore;

  // Range score: tight box + high inside ratio + low separation.
  const tightScore = clamp01((0.020 - boxRel) / 0.010);
  const insideScore = clamp01((insideRatio - 0.70) / 0.25);
  const flatSepScore = clamp01((0.0036 - emaSepRel) / 0.0022);
  const rangeScore = 0.45 * tightScore + 0.35 * insideScore + 0.2 * flatSepScore;

  if (trendScore >= 0.62 && rangeScore < 0.55) {
    return {
      regime: "TREND",
      detail: {
        atr_rel: atrRel,
        box_rel: boxRel,
        ema20: e20,
        ema60: e60,
        ema_sep_rel: emaSepRel,
        slope_rel: slopeRel,
        inside_ratio: insideRatio,
        bias,
        trend_score: trendScore,
        range_score: rangeScore
      }
    };
  }

  if (rangeScore >= 0.60 && trendScore < 0.62) {
    return {
      regime: "RANGE",
      detail: {
        atr_rel: atrRel,
        box_rel: boxRel,
        ema20: e20,
        ema60: e60,
        ema_sep_rel: emaSepRel,
        slope_rel: slopeRel,
        inside_ratio: insideRatio,
        bias,
        trend_score: trendScore,
        range_score: rangeScore
      }
    };
  }

  // Ambiguous context → NO_TRADE by design ("애매하면 아예 안 친다").
  return {
    regime: "NO_TRADE",
    detail: {
      reason: "ambiguous",
      atr_rel: atrRel,
      box_rel: boxRel,
      ema20: e20,
      ema60: e60,
      ema_sep_rel: emaSepRel,
      slope_rel: slopeRel,
      inside_ratio: insideRatio,
      bias,
      trend_score: trendScore,
      range_score: rangeScore
    }
  };
}

