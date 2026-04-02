import type { EngineConfig, MarketSymbol, PaperPosition } from "../models/types";

export type RiskDecision = Readonly<
  | { ok: true }
  | { ok: false; reason: string }
>;

export class RiskManager {
  constructor(private readonly config: EngineConfig) {}

  canOpenNewPosition(symbol: MarketSymbol, existing: PaperPosition | null, side: "LONG" | "SHORT"): RiskDecision {
    if (existing) return { ok: false, reason: "single_position_only" };
    if (this.config.longOnly && side !== "LONG") return { ok: false, reason: "long_only" };
    if (!this.config.symbols.includes(symbol)) return { ok: false, reason: "symbol_not_allowed" };
    return { ok: true };
  }
}

