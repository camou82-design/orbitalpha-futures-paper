export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function roundTo(n: number, decimals: number): number {
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

/**
 * Last EMA value from a close series (oldest → newest).
 * Seeds with SMA of the first `period` closes, then applies EMA.
 * Returns null if not enough points.
 */
export function emaLastFromCloses(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += closes[i];
  ema /= period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Rounds a quantity according to the instrument's step size.
 * If step is not provided, defaults to 0.000001 (standard micro-probe resolution).
 * Ensure it doesn't zero out if the input was positive.
 */
export function roundQtyByInstrumentStep(qty: number, step: number = 0.000001): number {
  if (qty <= 0 || !Number.isFinite(qty)) return 0;
  if (step <= 0) return qty;
  const inv = 1 / step;
  let rounded = Math.round(qty * inv) / inv;
  if (rounded <= 0 && qty > 0) {
    rounded = step; // Minimum allowed size
  }
  return rounded;
}
