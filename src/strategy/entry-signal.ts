import type { MarketSymbol } from "../models/types";

export type PaperSignal = "paper_long_candidate" | "none";

export type PaperEntryEvaluation = Readonly<{
  symbol: MarketSymbol;
  entryCandidate: boolean;
  signal: PaperSignal;
}>;

/**
 * Long-only paper v0: trend_ok ∧ close ≥ EMA20 ∧ lastPrice > latest close.
 */
export function evaluatePaperLongEntryV0(input: Readonly<{
  symbol: MarketSymbol;
  trendOk: boolean;
  ema20: number | null;
  lastPrice: number;
  latestCandleClose: number;
}>): PaperEntryEvaluation {
  const { symbol, trendOk, ema20, lastPrice, latestCandleClose } = input;
  if (ema20 === null || !Number.isFinite(ema20)) {
    return { symbol, entryCandidate: false, signal: "none" };
  }
  const entryCandidate =
    trendOk && latestCandleClose >= ema20 && lastPrice > latestCandleClose;
  return {
    symbol,
    entryCandidate,
    signal: entryCandidate ? "paper_long_candidate" : "none"
  };
}
