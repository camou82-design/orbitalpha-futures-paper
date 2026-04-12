import type { MarketModeSelectorOutput, PaperOpenPositionRecord, RangeEngineState } from "../models/types";

export type RangeEngineInput = Readonly<{
  symbol: string;
  lastPrice: number;
  boxHigh: number | null;
  boxLow: number | null;
  boxPos: number | null;
  marketMode: MarketModeSelectorOutput;
  /** 열린 포지션(해당 심볼) — 없으면 노출 0으로 간주 */
  longMarginUsd: number;
  shortMarginUsd: number;
  rangeCycleCountPrior: number;
  rangeLadderLevelPrior: number;
}>;

function finite(n: number, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
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

  const longExposure = finite(input.longMarginUsd, 0);
  const shortExposure = finite(input.shortMarginUsd, 0);
  const hedgeBalance =
    longExposure + shortExposure > 1e-9
      ? (longExposure - shortExposure) / (longExposure + shortExposure)
      : 0;

  const reopenEligible =
    input.marketMode.marketMode === "RANGE" || input.marketMode.marketMode === "TRANSITION";

  return {
    boxUpper,
    boxLower,
    boxMid,
    boxPosition: boxPositionFinal,
    rangeCycleCount: input.rangeCycleCountPrior,
    longExposure,
    shortExposure,
    hedgeBalance,
    reopenEligible,
    rangeLadderLevel: input.rangeLadderLevelPrior,
    candidateLostExitAllowed: false
  };
}

/** 동일 심볼 오픈 배열에서 롱/숏 마진 합산(페이퍼 단일 레그 가정 시 한쪽만). */
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
