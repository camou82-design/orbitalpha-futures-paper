import type { MarketSymbol } from "../models/types";

export type PaperSignal = "paper_long_candidate" | "none";

export type PaperEntryEvaluation = Readonly<{
  symbol: MarketSymbol;
  entryCandidate: boolean;
  signal: PaperSignal;
}>;

/**
 * Long-only paper v0: trend_ok ∧ close ≥ EMA20 ∧ breakout vs latest close.
 * `breakoutStrict`: true → lastPrice > latestCandleClose (stricter). false → lastPrice >= latestCandleClose (paper relaxed, 1-tick).
 */
export function evaluatePaperLongEntryV0(input: Readonly<{
  symbol: MarketSymbol;
  trendOk: boolean;
  ema20: number | null;
  lastPrice: number;
  latestCandleClose: number;
  /** Default true — omit for legacy callers. */
  breakoutStrict?: boolean;
}>): PaperEntryEvaluation {
  const { symbol, trendOk, ema20, lastPrice, latestCandleClose } = input;
  const breakoutStrict = input.breakoutStrict !== false;
  if (ema20 === null || !Number.isFinite(ema20)) {
    return { symbol, entryCandidate: false, signal: "none" };
  }
  const breakoutOk = breakoutStrict
    ? lastPrice > latestCandleClose
    : lastPrice >= latestCandleClose;
  const entryCandidate = trendOk && latestCandleClose >= ema20 && breakoutOk;
  return {
    symbol,
    entryCandidate,
    signal: entryCandidate ? "paper_long_candidate" : "none"
  };
}
