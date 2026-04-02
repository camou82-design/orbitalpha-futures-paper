import type { PaperPosition } from "../models/types";

export function estimateLiquidationPrice(pos: PaperPosition): number | null {
  // Placeholder only. Real liquidation depends on Bybit margin model, maintenance margin, fees, etc.
  // For skeleton: return null when unknown.
  if (pos.leverage <= 0) return null;
  if (pos.side !== "LONG") return null;
  // extremely naive approximation (do not use for real)
  return pos.entryPrice * (1 - 1 / pos.leverage);
}

