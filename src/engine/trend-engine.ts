import type { MarketModeSelectorOutput, TrendBreakoutDirection, TrendEngineState } from "../models/types";

export type TrendEngineInput = Readonly<{
  mark: number;
  entryPrice: number;
  atr: number | null;
  marketMode: MarketModeSelectorOutput;
  priorBreakoutDirection: TrendBreakoutDirection;
  pyramidLevelPrior: number;
}>;

function finite(n: number, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/**
 * 수렴·돌파·스위칭 가능 여부 최소 산출. 반대 돌파 시 청산+역진입은 switch* 필드로 표현한다.
 */
export function evaluateTrendEngineForSymbol(input: TrendEngineInput): TrendEngineState {
  const atr = input.atr != null && finite(input.atr, 0) > 0 ? finite(input.atr, 0) : input.mark * 0.002;
  const compressionScore = finite(
    input.marketMode.trendConfidence * (1 - Math.min(1, atr / Math.max(input.mark, 1e-9)))
  );

  const breakoutUpper = input.entryPrice + atr;
  const breakoutLower = input.entryPrice - atr;

  let breakoutDirection: TrendBreakoutDirection = "none";
  if (input.mark > breakoutUpper) breakoutDirection = "up";
  else if (input.mark < breakoutLower) breakoutDirection = "down";

  const breakoutConfidence = finite(
    input.marketMode.trendConfidence * (breakoutDirection === "none" ? 0.35 : 0.85)
  );
  const trendFollowScore = finite(input.marketMode.trendConfidence * 0.9 + compressionScore * 0.1);

  const opposed =
    (input.priorBreakoutDirection === "up" && breakoutDirection === "down") ||
    (input.priorBreakoutDirection === "down" && breakoutDirection === "up");

  const switchEligible =
    opposed &&
    breakoutDirection !== "none" &&
    (input.marketMode.marketMode === "TREND" ||
      input.marketMode.marketMode === "MIXED" ||
      input.marketMode.marketMode === "TRANSITION");

  let switchCloseSide: "long" | "short" | null = null;
  let switchOpenSide: "long" | "short" | null = null;
  if (switchEligible) {
    if (breakoutDirection === "up") {
      switchCloseSide = "short";
      switchOpenSide = "long";
    } else {
      switchCloseSide = "long";
      switchOpenSide = "short";
    }
  }

  return {
    compressionScore,
    breakoutUpper,
    breakoutLower,
    breakoutDirection,
    breakoutConfidence,
    trendFollowScore,
    switchEligible,
    pyramidLevel: input.pyramidLevelPrior,
    switchCloseSide,
    switchOpenSide
  };
}
