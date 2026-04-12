import type { MarketModeSelectorOutput, PaperMarketMode, PaperOpenPositionRecord, RangeBoxZone, RangeEngineState } from "../models/types";

export type RangeEngineInput = Readonly<{
  symbol: string;
  lastPrice: number;
  boxHigh: number | null;
  boxLow: number | null;
  boxPos: number | null;
  marketMode: MarketModeSelectorOutput;
  longMarginUsd: number;
  shortMarginUsd: number;
  rangeCycleCountPrior: number;
  rangeLadderLevelPrior: number;
  /** 직전 틱 구간(상태머신). */
  lastZone: RangeBoxZone | null;
}>;

function finite(n: number, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

export function classifyBoxZone(boxPosition: number): RangeBoxZone {
  if (boxPosition >= 0.62) return "upper";
  if (boxPosition <= 0.38) return "lower";
  return "mid";
}

/**
 * 구간 전이 시 사이클·래더 갱신. 왕복(중앙↔극단) 카운트.
 */
export function stepRangeZoneMachine(input: Readonly<{
  lastZone: RangeBoxZone | null;
  currentZone: RangeBoxZone;
  priorCycle: number;
  priorLadder: number;
  hedgeBalance: number;
}>): Readonly<{ rangeCycleCount: number; rangeLadderLevel: number }> {
  let cycle = input.priorCycle;
  const lz = input.lastZone;
  const cz = input.currentZone;
  if (lz !== null && lz !== cz) {
    if ((lz === "mid" && (cz === "upper" || cz === "lower")) || ((lz === "upper" || lz === "lower") && cz === "mid")) {
      cycle += 1;
    }
  }
  let ladder = input.priorLadder;
  if (Math.abs(input.hedgeBalance) > 0.42) {
    ladder = Math.min(5, ladder + 1);
  } else if (Math.abs(input.hedgeBalance) < 0.15) {
    ladder = Math.max(0, ladder - 1);
  }
  return { rangeCycleCount: cycle, rangeLadderLevel: ladder };
}

export type RangeStructuralExitResult = Readonly<{
  shouldExit: boolean;
  reason: "range_box_break" | "structural_regime_shift" | "risk_exposure_breach" | null;
}>;

/**
 * RANGE 핵심 청산: 박스 붕괴·구조적 레짐 전환·노출 한도. candidate_lost 아님.
 */
export function evaluateRangeStructuralExit(input: Readonly<{
  lastPrice: number;
  boxUpper: number;
  boxLower: number;
  longUsd: number;
  shortUsd: number;
  maxLongExposure: number;
  maxShortExposure: number;
  marketMode: PaperMarketMode;
  trendConfidence: number;
  /** 포지션 진입 시 RANGE였는데 글로벌 모드가 추세로 강하게 기운 경우 */
  structuralTrendShift: boolean;
}>): RangeStructuralExitResult {
  const span = input.boxUpper - input.boxLower;
  const buf = span > 0 ? span * 0.008 : input.lastPrice * 0.001;
  const above = input.lastPrice > input.boxUpper + buf;
  const below = input.lastPrice < input.boxLower - buf;
  if (above || below) {
    return { shouldExit: true, reason: "range_box_break" };
  }
  if (input.structuralTrendShift && input.marketMode === "TREND" && input.trendConfidence >= 0.58) {
    return { shouldExit: true, reason: "structural_regime_shift" };
  }
  if (input.longUsd > input.maxLongExposure || input.shortUsd > input.maxShortExposure) {
    return { shouldExit: true, reason: "risk_exposure_breach" };
  }
  return { shouldExit: false, reason: null };
}

/**
 * 횡보 전용 상태 산출. 후보 소멸 청산은 RANGE 핵심 사유에서 제외(candidateLostExitAllowed=false).
 */
export function evaluateRangeEngineForSymbol(input: RangeEngineInput): RangeEngineState {
  const hi = input.boxHigh;
  const lo = input.boxLow;
  const valid =
    hi != null &&
    lo != null &&
    Number.isFinite(hi) &&
    Number.isFinite(lo) &&
    hi > lo;

  let boxUpper = valid ? hi! : input.lastPrice * 1.01;
  let boxLower = valid ? lo! : input.lastPrice * 0.99;
  if (boxUpper <= boxLower) {
    boxUpper = input.lastPrice * 1.005;
    boxLower = input.lastPrice * 0.995;
  }
  const boxMid = (boxUpper + boxLower) / 2;
  const span = boxUpper - boxLower;
  let boxPosition = 0.5;
  if (span > 0 && Number.isFinite(input.lastPrice)) {
    boxPosition = (input.lastPrice - boxLower) / span;
  }
  boxPosition = Math.min(1, Math.max(0, finite(boxPosition, 0.5)));

  const posFromSnap = input.boxPos;
  const boxPositionFinal =
    typeof posFromSnap === "number" && Number.isFinite(posFromSnap)
      ? Math.min(1, Math.max(0, posFromSnap))
      : boxPosition;

  const boxZone = classifyBoxZone(boxPositionFinal);
  const stepped = stepRangeZoneMachine({
    lastZone: input.lastZone,
    currentZone: boxZone,
    priorCycle: input.rangeCycleCountPrior,
    priorLadder: input.rangeLadderLevelPrior,
    hedgeBalance:
      finite(input.longMarginUsd, 0) + finite(input.shortMarginUsd, 0) > 1e-9
        ? (finite(input.longMarginUsd, 0) - finite(input.shortMarginUsd, 0)) /
          (finite(input.longMarginUsd, 0) + finite(input.shortMarginUsd, 0))
        : 0
  });

  const longExposure = finite(input.longMarginUsd, 0);
  const shortExposure = finite(input.shortMarginUsd, 0);
  const hedgeBalance =
    longExposure + shortExposure > 1e-9 ? (longExposure - shortExposure) / (longExposure + shortExposure) : 0;

  const reopenEligible =
    input.marketMode.marketMode === "RANGE" ||
    input.marketMode.marketMode === "TRANSITION" ||
    input.marketMode.routing.activeEngine === "RANGE";

  const buf = span > 0 ? span * 0.008 : input.lastPrice * 0.001;
  const boxBreakout = input.lastPrice > boxUpper + buf || input.lastPrice < boxLower - buf;

  return {
    boxUpper,
    boxLower,
    boxMid,
    boxPosition: boxPositionFinal,
    boxZone,
    rangeCycleCount: stepped.rangeCycleCount,
    longExposure,
    shortExposure,
    hedgeBalance,
    reopenEligible,
    rangeLadderLevel: stepped.rangeLadderLevel,
    candidateLostExitAllowed: false,
    boxBreakout
  };
}

/** 동일 심볼 오픈 배열에서 롱/숏 마진 합산. */
export function marginsForSymbol(
  opens: readonly PaperOpenPositionRecord[],
  symbol: string
): { longUsd: number; shortUsd: number } {
  let longUsd = 0;
  let shortUsd = 0;
  for (const o of opens) {
    if (o.status !== "open" || String(o.symbol) !== symbol) continue;
    if (o.side === "long") longUsd += finite(o.sizeUsd, 0);
    else shortUsd += finite(o.sizeUsd, 0);
  }
  return { longUsd, shortUsd };
}
