import type { MarketSymbol } from "../models/types";

export type PaperSignal = "paper_long_candidate" | "paper_short_candidate" | "none";

export type PaperEntryEvaluation = Readonly<{
  symbol: MarketSymbol;
  entryCandidate: boolean;
  signal: PaperSignal;
}>;

/**
 * Paper bidirectional: long when EMA20 > EMA60 and close ≥ EMA20; short when EMA20 < EMA60 and close ≤ EMA20.
 */
export function evaluatePaperEntryV1(input: Readonly<{
  symbol: MarketSymbol;
  ema20: number | null;
  ema60: number | null;
  latestCandleClose: number;
}>): PaperEntryEvaluation {
  const { symbol, ema20, ema60, latestCandleClose } = input;
  if (ema20 === null || !Number.isFinite(ema20)) {
    return { symbol, entryCandidate: false, signal: "none" };
  }
  if (ema60 === null || !Number.isFinite(ema60)) {
    return { symbol, entryCandidate: false, signal: "none" };
  }
  if (ema20 > ema60 && latestCandleClose >= ema20) {
    return { symbol, entryCandidate: true, signal: "paper_long_candidate" };
  }
  if (ema20 < ema60 && latestCandleClose <= ema20) {
    return { symbol, entryCandidate: true, signal: "paper_short_candidate" };
  }
  return { symbol, entryCandidate: false, signal: "none" };
}
