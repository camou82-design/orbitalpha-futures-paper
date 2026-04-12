import type { MarketModeSelectorOutput, TrendBreakoutDirection, TrendEngineState } from "../models/types";

export type TrendEngineInput = Readonly<{
  mark: number;
  entryPrice: number;
  atr: number | null;
  marketMode: MarketModeSelectorOutput;
  priorBreakoutDirection: TrendBreakoutDirection;
  pyramidLevelPrior: number;
  /** 열린 포지션 방향(피라미드 판단). */
  positionSide?: "long" | "short";
}>;

export type TrendSwitchPlan = Readonly<{
  execute: boolean;
  closeSide: "long" | "short" | null;
  openSide: "long" | "short" | null;
  reasonLabel: string;
}>;

function finite(n: number, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/**
 * 추세 지속 시 피라미드 단계(증액 판단 입력).
 */
export function evaluatePyramidLevel(input: Readonly<{
  prior: number;
  trendFollowScore: number;
  breakoutDirection: TrendBreakoutDirection;
  positionSide: "long" | "short";
}>): number {
  const aligned =
    (input.positionSide === "long" && input.breakoutDirection === "up") ||
    (input.positionSide === "short" && input.breakoutDirection === "down");
  if (aligned && input.trendFollowScore >= 0.62) {
    return Math.min(4, input.prior + 1);
  }
  if (input.trendFollowScore < 0.38) {
    return Math.max(0, input.prior - 1);
  }
  return input.prior;
}

/**
 * 반대 돌파 시 청산+역신규를 한 계획으로 표현(실행은 오케스트레이터에서 2레그로 기록).
 */
export function planTrendSwitch(trend: TrendEngineState, openSide: "long" | "short"): TrendSwitchPlan {
  if (!trend.switchEligible || !trend.switchCloseSide || !trend.switchOpenSide) {
    return {
      execute: false,
      closeSide: null,
      openSide: null,
      reasonLabel: "스위칭 조건 미충족"
    };
  }
  if (trend.switchCloseSide !== openSide) {
    return {
      execute: false,
      closeSide: null,
      openSide: null,
      reasonLabel: "현재 포지션 방향과 청산 대상 불일치"
    };
  }
  return {
    execute: true,
    closeSide: trend.switchCloseSide,
    openSide: trend.switchOpenSide,
    reasonLabel: "반대 돌파 확인 — 기존 청산 후 역방향 진입"
  };
}

/**
 * 수렴·돌파·스위칭. breakoutUpper/Lower는 entry±ATR 기준선.
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

  const pri = input.priorBreakoutDirection;
  const opposed =
    (pri === "up" && breakoutDirection === "down") || (pri === "down" && breakoutDirection === "up");

  const routingTrend =
    input.marketMode.routing.activeEngine === "TREND" || input.marketMode.marketMode === "MIXED";

  const switchEligible =
    opposed &&
    breakoutDirection !== "none" &&
    routingTrend &&
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

  const pyramidLevel =
    input.positionSide != null
      ? evaluatePyramidLevel({
          prior: input.pyramidLevelPrior,
          trendFollowScore,
          breakoutDirection,
          positionSide: input.positionSide
        })
      : input.pyramidLevelPrior;

  return {
    compressionScore,
    breakoutUpper,
    breakoutLower,
    breakoutDirection,
    breakoutConfidence,
    trendFollowScore,
    switchEligible,
    pyramidLevel,
    switchCloseSide,
    switchOpenSide
  };
}
