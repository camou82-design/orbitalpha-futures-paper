import type { Timeframe } from "../models/types";

/**
 * Tunable knobs for cost-vs-volatility entry gate (paper only).
 * Adjust here; avoid scattering magic numbers in the engine.
 */
export const ENTRY_GATE_CONFIG = {
  /** ATR / mean-range lookback on the entry timeframe (1m) candles. */
  volatilityAtrPeriod: 14,
  /** Require expected move (ATR/price) to exceed `minRequiredMoveFraction * this`. */
  minMoveVsCostMultiplier: 2.05,
  /** Higher timeframe for trend alignment (long: EMA20 > EMA60 on closes). */
  higherTimeframe: "5m" as Timeframe,
  /** OKX kline `limit` for higher TF (needs ≥ 60 for EMA60). */
  higherTfKlineLimit: 120,
  /**
   * Conservative estimate of funding accrual periods at entry for min-move padding.
   * Uses `|fundingRate| * this` added to round-trip fee fraction (same order of magnitude as engine v3).
   */
  fundingPeriodsForMinMoveEstimate: 1
} as const;
