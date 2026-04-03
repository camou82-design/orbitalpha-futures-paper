/**
 * Paper-only heuristic quality score (0–100). Not used by live trading.
 */
export function computePaperEntryQualityScore(input: Readonly<{
  ema20: number | null;
  ema60: number | null;
  lastPrice: number;
  latestCandleClose: number;
  side: "long" | "short";
}>): number {
  if (input.ema20 === null || !Number.isFinite(input.ema20) || input.ema20 <= 0) return 0;
  if (input.ema60 === null || !Number.isFinite(input.ema60)) return 0;

  if (input.side === "long") {
    if (!(input.ema20 > input.ema60 && input.latestCandleClose >= input.ema20)) return 0;
    let score = 35;
    score += 25;
    const priceVsEma = (input.lastPrice - input.ema20) / input.ema20;
    score += Math.min(25, Math.max(0, priceVsEma * 4000));
    if (input.lastPrice > input.latestCandleClose) score += 15;
    else if (input.lastPrice >= input.latestCandleClose) score += 8;
    return Math.round(Math.min(100, Math.max(0, score)));
  }

  if (!(input.ema20 < input.ema60 && input.latestCandleClose <= input.ema20)) return 0;
  let score = 35;
  score += 25;
  const priceVsEma = (input.ema20 - input.lastPrice) / input.ema20;
  score += Math.min(25, Math.max(0, priceVsEma * 4000));
  if (input.lastPrice < input.latestCandleClose) score += 15;
  else if (input.lastPrice <= input.latestCandleClose) score += 8;
  return Math.round(Math.min(100, Math.max(0, score)));
}

export function paperSignalStrengthLabel(score: number, relaxed: boolean): "strong" | "ok" | "weak" {
  const strongMin = relaxed ? 65 : 75;
  const okMin = relaxed ? 55 : 65;
  if (score >= strongMin) return "strong";
  if (score >= okMin) return "ok";
  return "weak";
}
