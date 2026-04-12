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

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
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
  const buf = span > 0 ? span * 0.018 : input.lastPrice * 0.001;
  const above = input.lastPrice > input.boxUpper + buf;
  const below = input.lastPrice < input.boxLower - buf;
  if (above || below) {
    return { shouldExit: true, reason: "range_box_break" };
  }
  if (input.structuralTrendShift && input.marketMode === "TREND" && input.trendConfidence >= 0.65) {
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

/** 짧은 시간 내 RANGE 재진입 과다 방지(창 길이·최대 횟수). */
export const RANGE_REOPEN_WINDOW_MS = 30 * 60_000;
export const RANGE_REOPEN_MAX_PER_WINDOW = 2;
const REOPEN_HEDGE_MAX_ABS = 0.52;
const EXPOSURE_HEADROOM = 0.92;

/** 가장자리 재접근 강도(0–1). */
export function computeRangeEdgeIntensity01(boxPosition: number, boxZone: RangeBoxZone): number {
  if (boxZone === "mid") return 0;
  if (boxZone === "upper") return clamp01((boxPosition - 0.62) / 0.38 + 0.32);
  return clamp01((0.38 - boxPosition) / 0.38 + 0.32);
}

export type RangeReopenSoftMetrics = Readonly<{
  edgeIntensity01: number;
  rangeCycleCount: number;
  recentRoundTripWinRate01: number;
  roundTripStreak: number;
}>;

export function rangeReopenOpportunityScore(m: RangeReopenSoftMetrics): number {
  const edge = m.edgeIntensity01;
  const cycle = Math.min(1, m.rangeCycleCount / 10);
  const win = m.recentRoundTripWinRate01;
  const streak = Math.min(1, m.roundTripStreak / 5);
  return clamp01(edge * 0.28 + cycle * 0.22 + win * 0.28 + streak * 0.22);
}

export type RangeReopenGateInput = Readonly<{
  /** TP 후 재진입 ARM이 유효할 것. */
  armed: boolean;
  state: RangeEngineState;
  intentSide: "long" | "short";
  maxLongExposure: number;
  maxShortExposure: number;
  longUsd: number;
  shortUsd: number;
  /** 헤드룸 검사용 의도 크기(USD). */
  proposedEntryUsd: number;
  /** `RANGE_REOPEN_WINDOW_MS` 안의 재진입 성공 횟수. */
  reopenCountInWindow: number;
  /** 좋은 왕복 기회 시 게이트 완화(과잉 방지 하드 조건은 유지). */
  soft?: RangeReopenSoftMetrics;
}>;

/**
 * 익절 ARM + 박스·헤지·노출·반복 + (선택) 기회 점수로 재오픈.
 */
export function evaluateRangeReopenAllowed(input: RangeReopenGateInput): Readonly<{
  allowed: boolean;
  blockReason: string;
}> {
  if (!input.armed) {
    return { allowed: false, blockReason: "재진입 ARM 없음" };
  }
  const st = input.state;
  if (!st.reopenEligible) {
    return { allowed: false, blockReason: "모드상 재진입 비허용" };
  }
  if (st.boxBreakout) {
    return { allowed: false, blockReason: "박스 이탈(붕괴) 구간" };
  }
  if (st.boxZone === "mid") {
    return { allowed: false, blockReason: "중앙대 — 왕복 가장자리 아님" };
  }

  const opp = input.soft ? rangeReopenOpportunityScore(input.soft) : 0;
  const hedgeLimit = REOPEN_HEDGE_MAX_ABS + opp * 0.12;
  const maxReopens = opp >= 0.68 ? 3 : RANGE_REOPEN_MAX_PER_WINDOW;

  if (Math.abs(st.hedgeBalance) > hedgeLimit) {
    return { allowed: false, blockReason: "헤지 편중 과다" };
  }
  if (input.reopenCountInWindow >= maxReopens) {
    return { allowed: false, blockReason: "재진입 빈도 상한" };
  }
  const addL = input.intentSide === "long" ? input.proposedEntryUsd : 0;
  const addS = input.intentSide === "short" ? input.proposedEntryUsd : 0;
  if (input.longUsd + addL > input.maxLongExposure * EXPOSURE_HEADROOM) {
    return { allowed: false, blockReason: "롱 노출 여유 부족" };
  }
  if (input.shortUsd + addS > input.maxShortExposure * EXPOSURE_HEADROOM) {
    return { allowed: false, blockReason: "숏 노출 여유 부족" };
  }
  return { allowed: true, blockReason: "" };
}

/**
 * 왕복 사이클·헤지 안정 시 크기 상향(과도한 누적 시엔 여전히 감쇠).
 */
export function rangeCycleSizePolicy(rangeCycleCount: number, hedgeBalance: number): number {
  const c = Math.min(12, Math.max(0, rangeCycleCount));
  const stab = 1 - Math.abs(hedgeBalance);
  let m = 1 - 0.026 * c;
  if (stab > 0.74) m += 0.022 * Math.min(6, c);
  return Math.max(0.6, Math.min(1.14, m));
}

/** @deprecated rangeCycleSizePolicy 권장 */
export function rangeCycleEntryMultiplier(rangeCycleCount: number): number {
  return rangeCycleSizePolicy(rangeCycleCount, 0);
}

/**
 * 반대 레그로 편중 완화 시 회수·누적 보정.
 */
export function rangeAccumulationRecoveryMultiplier(
  hedgeBalance: number,
  intentSide: "long" | "short",
  rangeCycleCount: number
): number {
  const skew = hedgeBalance;
  const reduces =
    (skew > 0.1 && intentSide === "short") || (skew < -0.1 && intentSide === "long");
  if (!reduces) return 1;
  return Math.min(1.16, 1 + 0.038 * Math.min(8, rangeCycleCount) + (Math.abs(skew) - 0.1) * 0.12);
}

/**
 * 레더·헤지 누적에 따른 반대 레그/추가 진입 축소.
 */
export function rangeLadderLegMultiplier(rangeLadderLevel: number, hedgeBalance: number): number {
  const ladder = Math.min(5, Math.max(0, rangeLadderLevel));
  const hb = Math.abs(hedgeBalance);
  const ladderPart = Math.max(0.48, 1 - 0.085 * ladder);
  const hedgePart = hb > 0.48 ? Math.max(0.55, 1 - 0.2 * (hb - 0.48)) : 1;
  return Math.max(0.45, Math.min(1, ladderPart * hedgePart));
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
