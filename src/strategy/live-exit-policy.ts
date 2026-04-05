import type { PaperClosedPositionRecord } from "../models/types";
import type { FuturesMarketMode } from "./live-market-mode";

export type ExitPolicyCloseReason = PaperClosedPositionRecord["closeReason"];

export type ExitPolicyOutcome =
  | { action: "hold"; trailingExtreme: number | undefined }
  | { action: "close"; reason: ExitPolicyCloseReason; trailingExtreme: number | undefined };

export function getModeRiskThresholds(mode: FuturesMarketMode): Readonly<{
  tp: number;
  sl: number;
  maxHoldMs: number;
  trailDrawdown: number;
  trailMinPnl: number;
  runnerTp: number;
}> {
  switch (mode) {
    case "trend":
      return {
        tp: 0.005,
        sl: -0.01,
        maxHoldMs: 4 * 60 * 60 * 1000,
        trailDrawdown: 0.0035,
        trailMinPnl: 0.002,
        runnerTp: 0.0035
      };
    case "sideways":
      return {
        tp: 0.0035,
        sl: -0.0065,
        maxHoldMs: 45 * 60 * 1000,
        trailDrawdown: 0.0025,
        trailMinPnl: 0.0012,
        runnerTp: 0.0022
      };
    case "risk_off":
      return {
        tp: 0.0025,
        sl: -0.0045,
        maxHoldMs: 20 * 60 * 1000,
        trailDrawdown: 0.002,
        trailMinPnl: 0.0008,
        runnerTp: 0.0016
      };
    default:
      return {
        tp: 0.005,
        sl: -0.01,
        maxHoldMs: 4 * 60 * 60 * 1000,
        trailDrawdown: 0.0035,
        trailMinPnl: 0.002,
        runnerTp: 0.0035
      };
  }
}

/**
 * 모드별 TP/SL/시간/트레일링.
 * `exitProfile === "runner"` (분할 후 잔여): 고정 TP는 완화·트레일·손절·시간 중심.
 */
export function evaluateExitPolicy(input: Readonly<{
  mode: FuturesMarketMode;
  side: "long" | "short";
  pnlPctNet: number;
  holdingMs: number;
  mark: number;
  trailingExtreme: number | undefined;
  /** 분할 청산 후 잔여 물량 전용 프로파일 */
  exitProfile?: "full" | "runner";
  partialExitStage?: number;
}>): ExitPolicyOutcome {
  const t = getModeRiskThresholds(input.mode);
  const { side, mark } = input;
  const runner = input.exitProfile === "runner" || (input.partialExitStage ?? 0) >= 1;

  let extreme = input.trailingExtreme;
  if (side === "long") {
    extreme = extreme === undefined ? mark : Math.max(extreme, mark);
  } else {
    extreme = extreme === undefined ? mark : Math.min(extreme, mark);
  }

  const tpLevel = runner ? t.runnerTp : t.tp;

  if (input.pnlPctNet >= tpLevel) {
    return { action: "close", reason: "take_profit", trailingExtreme: extreme };
  }
  if (input.pnlPctNet <= t.sl) {
    return { action: "close", reason: "stop_loss", trailingExtreme: extreme };
  }
  if (input.holdingMs >= t.maxHoldMs) {
    return { action: "close", reason: "time_based_exit", trailingExtreme: extreme };
  }

  const allowTrail = input.mode === "trend" || (runner && input.mode === "sideways");
  if (
    allowTrail &&
    extreme !== undefined &&
    input.pnlPctNet >= t.trailMinPnl
  ) {
    if (side === "long" && mark <= extreme * (1 - t.trailDrawdown)) {
      return { action: "close", reason: "trailing_stop", trailingExtreme: extreme };
    }
    if (side === "short" && mark >= extreme * (1 + t.trailDrawdown)) {
      return { action: "close", reason: "trailing_stop", trailingExtreme: extreme };
    }
  }

  return { action: "hold", trailingExtreme: extreme };
}

export function stopLossPctForMode(mode: FuturesMarketMode): number {
  return getModeRiskThresholds(mode).sl;
}
