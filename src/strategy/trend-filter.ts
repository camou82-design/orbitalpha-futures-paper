import { emaLastFromCloses } from "../utils/math";

export type TrendFilterResult = Readonly<{
  ema20: number | null;
  ema60: number | null;
  trendOk: boolean;
  reason: string;
}>;

/**
 * 1m close series (oldest → newest). trend_ok = EMA20 > EMA60 when both EMAs are defined.
 */
export function trendFilterOneMinuteCloses(closes: number[]): TrendFilterResult {
  const ema20 = emaLastFromCloses(closes, 20);
  const ema60 = emaLastFromCloses(closes, 60);
  if (ema20 === null || ema60 === null) {
    return {
      ema20,
      ema60,
      trendOk: false,
      reason: "insufficient_closes_for_ema"
    };
  }
  const trendOk = ema20 > ema60;
  return {
    ema20,
    ema60,
    trendOk,
    reason: trendOk ? "ema20_gt_ema60" : "ema20_lte_ema60"
  };
}
