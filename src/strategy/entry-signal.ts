import type { MarketSymbol } from "../models/types";

export type PaperSignal = "paper_long_candidate" | "none";

export type PaperEntryEvaluation = Readonly<{
  symbol: MarketSymbol;
  entryCandidate: boolean;
  signal: PaperSignal;
}>;

/**
 * Long-only paper v0: trend_ok ∧ latest candle close ≥ EMA20.
 * No lastPrice vs close breakout confirmation (sample collection: candidate = entry path).
 */
export function evaluatePaperLongEntryV0(input: Readonly<{
  symbol: MarketSymbol;
  trendOk: boolean;
  ema20: number | null;
  latestCandleClose: number;
}>): PaperEntryEvaluation {
  const { symbol, trendOk, ema20, latestCandleClose } = input;
  if (ema20 === null || !Number.isFinite(ema20)) {
    return { symbol, entryCandidate: false, signal: "none" };
  }
  const entryCandidate = trendOk && latestCandleClose >= ema20;
  return {
    symbol,
    entryCandidate,
    signal: entryCandidate ? "paper_long_candidate" : "none"
  };
}
