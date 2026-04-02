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

