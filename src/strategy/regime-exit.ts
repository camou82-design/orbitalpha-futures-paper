import type { PaperClosedPositionRecord } from "../models/types";
import type { MarketRegime } from "./market-regime-detector";

export type RegimeExitReason = PaperClosedPositionRecord["closeReason"];

export type RegimeExitOutcome =
  | Readonly<{ action: "hold"; trailingExtreme: number | undefined }>
  | Readonly<{ action: "close"; reason: RegimeExitReason; trailingExtreme: number | undefined }>;

type ExitProfile = "full" | "runner";

function thresholds(regime: MarketRegime): Readonly<{
  tp: number;
  sl: number;
  maxHoldMs: number;
  trailDrawdown: number;
  trailMinPnl: number;
  runnerTp: number;
}> {
  switch (regime) {
    case "TREND":
      return {
        tp: 0.0105,
        sl: -0.0105,
        maxHoldMs: 6 * 60 * 60 * 1000,
        trailDrawdown: 0.0038,
        trailMinPnl: 0.0042,
        runnerTp: 0.0075
      };
    case "RANGE":
      return {
        tp: 0.0025,
        sl: -0.0026,
        maxHoldMs: 28 * 60 * 1000,
        trailDrawdown: 0.0018,
        trailMinPnl: 0.0016,
        runnerTp: 0.0028
      };
    case "NO_TRADE":
    default:
      return {
        tp: 0.0035,
        sl: -0.0035,
        maxHoldMs: 20 * 60 * 1000,
        trailDrawdown: 0.0018,
        trailMinPnl: 0.0012,
        runnerTp: 0.0025
      };
  }
}

/**
 * Regime-specific exit policy (paper).
 *
 * Key differences:
 * - RANGE: short TP, tighter SL, short max hold (box mean reversion only)
 * - TREND: longer TP, trailing allowed, and can be closed immediately by a trend break (handled by caller)
 */
export function evaluateRegimeExitPolicy(input: Readonly<{
  regime: MarketRegime;
  side: "long" | "short";
  pnlPctNet: number;
  holdingMs: number;
  mark: number;
  entryPrice: number; // Added for true price move fraction
  stopPrice?: number; // Added for explicit price gate
  trailingExtreme: number | undefined;
  exitProfile?: ExitProfile;
  partialExitStage?: number;
}>): RegimeExitOutcome {
  const t = thresholds(input.regime);
  const runner = input.exitProfile === "runner" || (input.partialExitStage ?? 0) >= 1;

  let extreme = input.trailingExtreme;
  if (input.side === "long") extreme = extreme === undefined ? input.mark : Math.max(extreme, input.mark);
  else extreme = extreme === undefined ? input.mark : Math.min(extreme, input.mark);

  const tpLevel = runner ? t.runnerTp : t.tp;

  let priceMoveFrac = 0;
  if (input.entryPrice > 0) {
    const rawFrac = input.side === "long" 
      ? (input.mark - input.entryPrice) / input.entryPrice 
      : (input.entryPrice - input.mark) / input.entryPrice;
    priceMoveFrac = Number(rawFrac.toFixed(8));
  }

  if (input.entryPrice > 0 && priceMoveFrac >= tpLevel) return { action: "close", reason: "take_profit", trailingExtreme: extreme };

  // PRICE_MOVE_FRACTION canonical authority for Stop Loss
  // 1. If stopPrice exists, it's the absolute truth
  // 2. Otherwise compute actual price move fraction
  let stopBreached = false;
  if (input.stopPrice !== undefined && input.stopPrice > 0) {
    stopBreached = input.side === "long" ? input.mark <= input.stopPrice : input.mark >= input.stopPrice;
  } else if (input.entryPrice > 0) {
    stopBreached = priceMoveFrac <= t.sl;
  }
  
  if (stopBreached) return { action: "close", reason: "stop_loss", trailingExtreme: extreme };

  if (input.holdingMs >= t.maxHoldMs) return { action: "close", reason: "time_based_exit", trailingExtreme: extreme };

  const allowTrail = input.regime === "TREND" || (runner && input.regime === "RANGE");
  if (allowTrail && extreme !== undefined && input.pnlPctNet >= t.trailMinPnl) {
    if (input.side === "long" && input.mark <= extreme * (1 - t.trailDrawdown)) {
      return { action: "close", reason: "trailing_stop", trailingExtreme: extreme };
    }
    if (input.side === "short" && input.mark >= extreme * (1 + t.trailDrawdown)) {
      return { action: "close", reason: "trailing_stop", trailingExtreme: extreme };
    }
  }

  return { action: "hold", trailingExtreme: extreme };
}

export function stopLossPctForRegime(regime: MarketRegime): number {
  return thresholds(regime).sl;
}

export function takeProfitPctForRegime(regime: MarketRegime): number {
  return thresholds(regime).tp;
}

