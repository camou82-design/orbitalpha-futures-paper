import {
  classifyRangeZone,
  type MarketModeSelectorOutput,
  type PaperMarketMode,
  type PaperOpenPositionRecord,
  type RangeBoxZone,
  type RangeEngineState
} from "../models/types";

/** @deprecated Use classifyRangeZone — 단일 박스 구간 판정. */
export function classifyBoxZone(boxPos: number | null | undefined): RangeBoxZone {
  return classifyRangeZone(boxPos);
}

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
  /** 吏곸쟾 ??援ш컙(?곹깭癒몄떊). */
  lastZone: RangeBoxZone | null;
}>;

function finite(n: number, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Align all RANGE zone policy, entry, exit, and monitor with the same thresholds. */
export const RANGE_ZONE_ACTION_POLICY =
  "range_reversal_switch_engine_upper_short_lower_long_mid_wait_v2" as const;

/**
 * 援ш컙 ?꾩씠 ???ъ씠?는룸옒??媛깆떊. ?뺣났(以묒븰?붽레?? 移댁슫??
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
  /** True iff price is outside box 짹 structural buffer (before any hold/confirm gating in the engine). */
  rangeBoxBreakRaw: boolean;
}>;

/**
 * RANGE ?듭떖 泥?궛: 諛뺤뒪 遺뺢눼쨌援ъ“???덉쭚 ?꾪솚쨌?몄텧 ?쒕룄. candidate_lost ?꾨떂.
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
  /** ?ъ???吏꾩엯 ??RANGE??붾뜲 湲濡쒕쾶 紐⑤뱶媛 異붿꽭濡?媛뺥븯寃?湲곗슫 寃쎌슦 */
  structuralTrendShift: boolean;
}>): RangeStructuralExitResult {
  const span = input.boxUpper - input.boxLower;
  const buf = span > 0 ? span * 0.018 : input.lastPrice * 0.001;
  const above = input.lastPrice > input.boxUpper + buf;
  const below = input.lastPrice < input.boxLower - buf;
  const rangeBoxBreakRaw = above || below;
  if (rangeBoxBreakRaw) {
    return { shouldExit: true, reason: "range_box_break", rangeBoxBreakRaw: true };
  }
  if (input.structuralTrendShift && input.marketMode === "TREND" && input.trendConfidence >= 0.65) {
    return { shouldExit: true, reason: "structural_regime_shift", rangeBoxBreakRaw: false };
  }
  if (input.longUsd > input.maxLongExposure || input.shortUsd > input.maxShortExposure) {
    return { shouldExit: true, reason: "risk_exposure_breach", rangeBoxBreakRaw: false };
  }
  return { shouldExit: false, reason: null, rangeBoxBreakRaw: false };
}

/** Per-position profit trail (peak + lock) for RANGE defer / pullback exit. */
export type RangeProfitTrailState = Readonly<{
  peakPrice: number;
  locked: boolean;
}>;

/**
 * RANGE ?섏씡沅? ?쇱젙 ?댁씡 援ш컙 吏꾩엯 ?꾩뿉??`range_box_break` 由щ갭?곗뒪瑜?利됱떆 ?덉슜?섏? ?딄퀬,
 * 蹂몄쟾 ?댁긽 ?뺣낫(locked) ???쇳겕 ?鍮??섎룎由쇱씠 ?꾧퀎瑜??섏쓣 ?뚮쭔 泥?궛(trailExit).
 */
export function computeRangeProfitTrailStep(input: Readonly<{
  side: "long" | "short";
  closePrice: number;
  boxUpper: number;
  boxLower: number;
  pnlPctNet: number;
  pnlUsdNet: number;
  marginUsd: number;
  atr: number | null;
  prior: RangeProfitTrailState | null;
  armPnlPct: number;
  securedMinPnlUsd: number;
  pullbackSpanFrac: number;
  pullbackMinPriceFrac: number;
  atrMult: number;
  holdingMs: number;
  maxArmedNoLockDeferMs: number;
}>): Readonly<{
  next: RangeProfitTrailState | null;
  deferBoxBreak: boolean;
  trailExit: boolean;
}> {
  if (input.pnlUsdNet < 0) {
    return { next: null, deferBoxBreak: false, trailExit: false };
  }
  const armed = input.pnlPctNet >= input.armPnlPct;
  if (!armed) {
    return { next: null, deferBoxBreak: false, trailExit: false };
  }
  const locked = input.pnlUsdNet >= input.securedMinPnlUsd;
  if (input.prior?.locked && !locked) {
    return { next: null, deferBoxBreak: false, trailExit: false };
  }
  const timeoutNoLock =
    !locked &&
    input.maxArmedNoLockDeferMs > 0 &&
    input.holdingMs >= input.maxArmedNoLockDeferMs;
  if (timeoutNoLock) {
    return { next: null, deferBoxBreak: false, trailExit: false };
  }

  const span = Math.max(0, input.boxUpper - input.boxLower);
  const trailDist = Math.max(
    span * input.pullbackSpanFrac,
    input.closePrice * input.pullbackMinPriceFrac,
    (input.atr ?? 0) * input.atrMult
  );

  const prior = input.prior;
  let peak = prior?.peakPrice ?? input.closePrice;
  const wasLocked = prior?.locked ?? false;

  if (locked) {
    if (!wasLocked) {
      peak = input.closePrice;
    } else {
      peak = input.side === "long" ? Math.max(peak, input.closePrice) : Math.min(peak, input.closePrice);
    }
  } else {
    peak = input.closePrice;
  }

  const next: RangeProfitTrailState = { peakPrice: peak, locked };

  let trailExit = false;
  if (locked) {
    if (input.side === "long") {
      trailExit = input.closePrice <= peak - trailDist;
    } else {
      trailExit = input.closePrice >= peak + trailDist;
    }
  }

  if (trailExit) {
    return { next: null, deferBoxBreak: false, trailExit: true };
  }

  return { next, deferBoxBreak: true, trailExit: false };
}

/**
 * ?〓낫 ?꾩슜 ?곹깭 ?곗텧. ?꾨낫 ?뚮㈇ 泥?궛? RANGE ?듭떖 ?ъ쑀?먯꽌 ?쒖쇅(candidateLostExitAllowed=false).
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

  const boxZone = classifyRangeZone(boxPositionFinal);
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

/** 吏㏃? ?쒓컙 ??RANGE ?ъ쭊??怨쇰떎 諛⑹?(李?湲몄씠쨌理쒕? ?잛닔). */
export const RANGE_REOPEN_WINDOW_MS = 30 * 60_000;
export const RANGE_REOPEN_MAX_PER_WINDOW = 2;
const REOPEN_HEDGE_MAX_ABS = 0.52;
const EXPOSURE_HEADROOM = 0.92;

/** 媛?μ옄由??ъ젒洹?媛뺣룄(0??). */
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
  /** TP ???ъ쭊??ARM???좏슚??寃? */
  armed: boolean;
  state: RangeEngineState;
  intentSide: "long" | "short";
  maxLongExposure: number;
  maxShortExposure: number;
  longUsd: number;
  shortUsd: number;
  /** ?ㅻ뱶猷?寃?ъ슜 ?섎룄 ?ш린(USD). */
  proposedEntryUsd: number;
  /** `RANGE_REOPEN_WINDOW_MS` ?덉쓽 ?ъ쭊???깃났 ?잛닔. */
  reopenCountInWindow: number;
  /** 醫뗭? ?뺣났 湲고쉶 ??寃뚯씠???꾪솕(怨쇱엵 諛⑹? ?섎뱶 議곌굔? ?좎?). */
  soft?: RangeReopenSoftMetrics;
}>;

/**
 * ?듭젅 ARM + 諛뺤뒪쨌?ㅼ?쨌?몄텧쨌諛섎났 + (?좏깮) 湲고쉶 ?먯닔濡??ъ삤??
 */
export function evaluateRangeReopenAllowed(input: RangeReopenGateInput): Readonly<{
  allowed: boolean;
  blockReason: string;
}> {
  if (!input.armed) {
    return { allowed: false, blockReason: "?ъ쭊??ARM ?놁쓬" };
  }
  const st = input.state;
  if (!st.reopenEligible) {
    return { allowed: false, blockReason: "mode_reopen_not_eligible" };
  }
  if (st.boxBreakout) {
    return { allowed: false, blockReason: "諛뺤뒪 ?댄깉(遺뺢눼) 援ш컙" };
  }
  if (st.boxZone === "mid") {
    return { allowed: false, blockReason: "以묒븰? ???뺣났 媛?μ옄由??꾨떂" };
  }

  const opp = input.soft ? rangeReopenOpportunityScore(input.soft) : 0;
  const hedgeLimit = REOPEN_HEDGE_MAX_ABS + opp * 0.12;
  const maxReopens = opp >= 0.68 ? 3 : RANGE_REOPEN_MAX_PER_WINDOW;

  if (Math.abs(st.hedgeBalance) > hedgeLimit) {
    return { allowed: false, blockReason: "?ㅼ? ?몄쨷 怨쇰떎" };
  }
  if (input.reopenCountInWindow >= maxReopens) {
    return { allowed: false, blockReason: "?ъ쭊??鍮덈룄 ?곹븳" };
  }
  const addL = input.intentSide === "long" ? input.proposedEntryUsd : 0;
  const addS = input.intentSide === "short" ? input.proposedEntryUsd : 0;
  if (input.longUsd + addL > input.maxLongExposure * EXPOSURE_HEADROOM) {
    return { allowed: false, blockReason: "long_exposure_headroom" };
  }
  if (input.shortUsd + addS > input.maxShortExposure * EXPOSURE_HEADROOM) {
    return { allowed: false, blockReason: "short_exposure_headroom" };
  }
  return { allowed: true, blockReason: "" };
}

/**
 * ?뺣났 ?ъ씠?는룻뿤吏 ?덉젙 ???ш린 ?곹뼢(怨쇰룄???꾩쟻 ?쒖뿏 ?ъ쟾??媛먯뇿).
 */
export function rangeCycleSizePolicy(rangeCycleCount: number, hedgeBalance: number): number {
  const c = Math.min(12, Math.max(0, rangeCycleCount));
  const stab = 1 - Math.abs(hedgeBalance);
  let m = 1 - 0.026 * c;
  if (stab > 0.74) m += 0.022 * Math.min(6, c);
  return Math.max(0.6, Math.min(1.14, m));
}

/** @deprecated rangeCycleSizePolicy 沅뚯옣 */
export function rangeCycleEntryMultiplier(rangeCycleCount: number): number {
  return rangeCycleSizePolicy(rangeCycleCount, 0);
}

/**
 * 諛섎? ?덇렇濡??몄쨷 ?꾪솕 ???뚯닔쨌?꾩쟻 蹂댁젙.
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
 * ?덈뜑쨌?ㅼ? ?꾩쟻???곕Ⅸ 諛섎? ?덇렇/異붽? 吏꾩엯 異뺤냼.
 */
export function rangeLadderLegMultiplier(rangeLadderLevel: number, hedgeBalance: number): number {
  const ladder = Math.min(5, Math.max(0, rangeLadderLevel));
  const hb = Math.abs(hedgeBalance);
  const ladderPart = Math.max(0.48, 1 - 0.085 * ladder);
  const hedgePart = hb > 0.48 ? Math.max(0.55, 1 - 0.2 * (hb - 0.48)) : 1;
  return Math.max(0.45, Math.min(1, ladderPart * hedgePart));
}

import { resolveOpenNotionalUsd, resolveOpenNotionalAuthority } from "../engine-v2/live-account/position-size-authority";

/** ?숈씪 ?щ낵 ?ㅽ뵂 諛곗뿴?먯꽌 濡???留덉쭊 ?⑹궛. */
export function marginsForSymbol(
  opens: readonly PaperOpenPositionRecord[],
  symbol: string
): { longUsd: number; shortUsd: number; authoritative: boolean; blockReason?: string } {
  let longUsd = 0;
  let shortUsd = 0;
  for (const o of opens) {
    if (o.status !== "open" || String(o.symbol) !== symbol) continue;
    const auth = resolveOpenNotionalAuthority(o as any);
    if (!auth.authoritative || auth.valueUsd == null) return { longUsd: NaN, shortUsd: NaN, authoritative: false, blockReason: "UNKNOWN_UNIT_SAFETY_BLOCK" }; // Fail closed
    if (o.side === "long") longUsd += finite(auth.valueUsd, 0);
    else shortUsd += finite(auth.valueUsd, 0);
  }
  return { longUsd, shortUsd, authoritative: true };
}
