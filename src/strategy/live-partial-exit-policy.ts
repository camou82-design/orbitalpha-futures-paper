import type { FuturesMarketMode } from "./live-market-mode";

export type PartialExitPolicyResult = Readonly<{
  shouldExitPartial: boolean;
  shouldExitFull: boolean;
  partialExitRatio: number;
  reason: string;
  detail: Record<string, unknown>;
}>;

function params(mode: FuturesMarketMode): Readonly<{
  p1: number;
  r1: number;
  p2: number;
  r2: number;
}> {
  switch (mode) {
    case "trend":
      return { p1: 0.0025, r1: 0.38, p2: 0.0042, r2: 0.45 };
    case "sideways":
      return { p1: 0.0016, r1: 0.48, p2: 0.0026, r2: 0.5 };
    case "risk_off":
      return { p1: 0.0011, r1: 0.55, p2: 0.0019, r2: 0.5 };
    default:
      return { p1: 0.0025, r1: 0.38, p2: 0.0042, r2: 0.45 };
  }
}

/**
 * 1차·2차 분할 익절. 손절/최종 청산은 엔진 상위에서 처리.
 */
export function evaluatePartialExitPolicy(input: Readonly<{
  mode: FuturesMarketMode;
  direction: "long" | "short";
  pnlPctNet: number;
  highestPnlPctNet: number;
  holdingMs: number;
  partialExitStage: number;
}>): PartialExitPolicyResult {
  const stage = Math.min(2, Math.max(0, input.partialExitStage));
  const t = params(input.mode);

  if (stage >= 2) {
    return {
      shouldExitPartial: false,
      shouldExitFull: false,
      partialExitRatio: 0,
      reason: "partial_stages_complete",
      detail: { stage }
    };
  }

  if (stage === 0 && input.pnlPctNet >= t.p1) {
    return {
      shouldExitPartial: true,
      shouldExitFull: false,
      partialExitRatio: t.r1,
      reason: "first_profit_target",
      detail: { stage: 0, threshold: t.p1, ratio: t.r1, pnl_pct_net: input.pnlPctNet }
    };
  }

  if (stage === 1 && input.pnlPctNet >= t.p2) {
    return {
      shouldExitPartial: true,
      shouldExitFull: false,
      partialExitRatio: t.r2,
      reason: "second_profit_target",
      detail: { stage: 1, threshold: t.p2, ratio: t.r2, pnl_pct_net: input.pnlPctNet }
    };
  }

  return {
    shouldExitPartial: false,
    shouldExitFull: false,
    partialExitRatio: 0,
    reason: "below_partial_threshold",
    detail: {
      stage,
      pnl_pct_net: input.pnlPctNet,
      highest_pnl_pct_net: input.highestPnlPctNet,
      next_threshold: stage === 0 ? t.p1 : t.p2
    }
  };
}
