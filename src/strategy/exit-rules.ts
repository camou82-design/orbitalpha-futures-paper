import type { PaperPosition } from "../models/types";

export type ExitLevels = Readonly<{
  stopLoss: number;
  takeProfit?: number;
  reason: string;
}>;

export function computeExitLevels(_pos: PaperPosition): ExitLevels {
  // Placeholder: fixed % stop / RR take-profit later.
  const stopLoss = _pos.entryPrice * 0.99;
  const takeProfit = _pos.entryPrice * 1.02;
  return { stopLoss, takeProfit, reason: "placeholder_levels" };
}

