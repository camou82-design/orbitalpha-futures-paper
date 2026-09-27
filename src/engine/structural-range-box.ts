import type { Candle } from "../models/types";
import { classifyRangeZone, type RangeBoxZone } from "../models/types";

/** Completed 1m lookback windows evaluated for structural RANGE authority. */
export const STRUCTURAL_BOX_LOOKBACKS = [30, 60, 120] as const;

/** Regression-calibrated on BTC micro-noise vs chart-wide range fixtures (v2-structural-range-box-cases). */
export const MIN_BOX_HEIGHT_ATR_RATIO = 1.15;

export const MIN_BOUNDARY_TOUCH_COUNT = 2;

/** Consecutive completed-bar closes outside prior box required to allow reformation. */
export const BREAKOUT_HOLD_BARS = 3;

const TOUCH_BAND_ATR_FRACTION = 0.12;
const UPPER_CLUSTER_PERCENTILE = 0.92;
const LOWER_CLUSTER_PERCENTILE = 0.08;

export type PersistedStructuralBoxState = Readonly<{
  boxHigh: number;
  boxLow: number;
  lookback: number;
  selectedReason: string;
  updatedAtTs: number;
}>;

export type StructuralBoxCandidate = Readonly<{
  lookback: number;
  boxHigh: number;
  boxLow: number;
  boxHeight: number;
  upperTouchCount: number;
  lowerTouchCount: number;
  widthValid: boolean;
  touchValid: boolean;
  boxHeightAtrRatio: number | null;
  rejectedReason: string | null;
  score: number;
}>;

export type StructuralBoxProofFields = Readonly<{
  lookback: number | null;
  boxHigh: number | null;
  boxLow: number | null;
  boxHeight: number | null;
  atr: number | null;
  boxHeightAtrRatio: number | null;
  upperTouchCount: number;
  lowerTouchCount: number;
  breakoutHold: boolean;
  selectedReason: string;
  boxPos: number | null;
  zone: RangeBoxZone;
}>;

export type StructuralBoxResolution = Readonly<{
  microBoxHigh: number | null;
  microBoxLow: number | null;
  microBoxHeight: number | null;
  boxHigh: number | null;
  boxLow: number | null;
  boxPos: number | null;
  boxRel: number | null;
  zone: RangeBoxZone;
  lookback: number | null;
  selectedReason: string;
  breakoutHold: boolean;
  upperTouchCount: number;
  lowerTouchCount: number;
  atr: number | null;
  boxHeightAtrRatio: number | null;
  candidates: readonly StructuralBoxCandidate[];
  hysteresisApplied: boolean;
  nextState: PersistedStructuralBoxState | null;
  proof: StructuralBoxProofFields;
}>;

function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (idx - lo);
}

function clusterBounds(window: readonly Candle[]): Readonly<{ boxHigh: number; boxLow: number }> | null {
  if (window.length === 0) return null;
  const highs = window.map((c) => c.high).sort((a, b) => a - b);
  const lows = window.map((c) => c.low).sort((a, b) => a - b);
  const boxHigh = percentile(highs, UPPER_CLUSTER_PERCENTILE);
  const boxLow = percentile(lows, LOWER_CLUSTER_PERCENTILE);
  if (!Number.isFinite(boxHigh) || !Number.isFinite(boxLow) || boxHigh <= boxLow) return null;
  return { boxHigh, boxLow };
}

function touchBand(atr: number | null, boxHeight: number): number {
  const fromAtr = atr !== null && atr > 0 ? atr * TOUCH_BAND_ATR_FRACTION : 0;
  const fromSpan = boxHeight * 0.035;
  return Math.max(fromAtr, fromSpan, 1e-9);
}

export function countBoundaryTouches(
  window: readonly Candle[],
  boxHigh: number,
  boxLow: number,
  atr: number | null
): Readonly<{ upperTouchCount: number; lowerTouchCount: number; band: number }> {
  const boxHeight = boxHigh - boxLow;
  const band = touchBand(atr, boxHeight);
  let upperTouchCount = 0;
  let lowerTouchCount = 0;
  for (const c of window) {
    if (c.high >= boxHigh - band) upperTouchCount += 1;
    if (c.low <= boxLow + band) lowerTouchCount += 1;
  }
  return { upperTouchCount, lowerTouchCount, band };
}

function candidateScore(input: Readonly<{
  lookback: number;
  upperTouchCount: number;
  lowerTouchCount: number;
  boxHeightAtrRatio: number | null;
  widthValid: boolean;
  touchValid: boolean;
}>): number {
  if (!input.widthValid || !input.touchValid) return -1;
  const touchSum = input.upperTouchCount + input.lowerTouchCount;
  const lookbackWeight = (input.lookback / 120) * 40;
  const touchWeight = touchSum * 8;
  const widthWeight =
    input.boxHeightAtrRatio !== null && Number.isFinite(input.boxHeightAtrRatio)
      ? Math.min(input.boxHeightAtrRatio, 6) * 3
      : 0;
  return lookbackWeight + touchWeight + widthWeight;
}

export function buildStructuralBoxCandidate(
  completed1m: readonly Candle[],
  lookback: number,
  atr: number | null,
  minHeightAtrRatio: number = MIN_BOX_HEIGHT_ATR_RATIO
): StructuralBoxCandidate | null {
  if (completed1m.length < lookback) return null;
  const window = completed1m.slice(-lookback);
  const bounds = clusterBounds(window);
  if (bounds === null) return null;
  const { boxHigh, boxLow } = bounds;
  const boxHeight = boxHigh - boxLow;
  const { upperTouchCount, lowerTouchCount } = countBoundaryTouches(window, boxHigh, boxLow, atr);
  const boxHeightAtrRatio =
    atr !== null && atr > 0 && Number.isFinite(atr) ? boxHeight / atr : null;
  const widthValid =
    boxHeightAtrRatio !== null && boxHeightAtrRatio >= minHeightAtrRatio;
  const touchValid =
    upperTouchCount >= MIN_BOUNDARY_TOUCH_COUNT && lowerTouchCount >= MIN_BOUNDARY_TOUCH_COUNT;
  let rejectedReason: string | null = null;
  if (!widthValid) rejectedReason = "width_below_atr_floor";
  else if (!touchValid) rejectedReason = "insufficient_boundary_touches";

  return {
    lookback,
    boxHigh,
    boxLow,
    boxHeight,
    upperTouchCount,
    lowerTouchCount,
    widthValid,
    touchValid,
    boxHeightAtrRatio,
    rejectedReason,
    score: candidateScore({
      lookback,
      upperTouchCount,
      lowerTouchCount,
      boxHeightAtrRatio,
      widthValid,
      touchValid
    })
  };
}

/** Legacy pollSymbol authority: raw min/max over last N completed 1m bars. */
export function computeLegacyMicroBoxBounds(
  completed1m: readonly Candle[],
  lookback = 30
): Readonly<{ boxHigh: number | null; boxLow: number | null; boxHeight: number | null }> {
  const window = completed1m.slice(-lookback);
  if (window.length === 0) return { boxHigh: null, boxLow: null, boxHeight: null };
  const boxHigh = Math.max(...window.map((x) => x.high));
  const boxLow = Math.min(...window.map((x) => x.low));
  const boxHeight = boxHigh > boxLow ? boxHigh - boxLow : null;
  return { boxHigh, boxLow, boxHeight };
}

function consecutiveCloseBreakoutHold(
  completed1m: readonly Candle[],
  boxHigh: number,
  boxLow: number
): boolean {
  if (completed1m.length < BREAKOUT_HOLD_BARS) return false;
  const tail = completed1m.slice(-BREAKOUT_HOLD_BARS);
  const allAbove = tail.every((c) => c.close > boxHigh);
  const allBelow = tail.every((c) => c.close < boxLow);
  return allAbove || allBelow;
}

function pickBestCandidate(candidates: readonly StructuralBoxCandidate[]): StructuralBoxCandidate | null {
  let best: StructuralBoxCandidate | null = null;
  for (const c of candidates) {
    if (c.score < 0) continue;
    if (best === null || c.score > best.score || (c.score === best.score && c.lookback > best.lookback)) {
      best = c;
    }
  }
  return best;
}

function computeBoxPos(
  lastPrice: number,
  boxHigh: number | null,
  boxLow: number | null
): number | null {
  if (boxHigh === null || boxLow === null || !(boxHigh > boxLow) || !(lastPrice > 0)) return null;
  return Math.min(1, Math.max(0, (lastPrice - boxLow) / (boxHigh - boxLow)));
}

function proofFromSelection(input: Readonly<{
  lookback: number | null;
  boxHigh: number | null;
  boxLow: number | null;
  atr: number | null;
  upperTouchCount: number;
  lowerTouchCount: number;
  breakoutHold: boolean;
  selectedReason: string;
  lastPrice: number;
}>): StructuralBoxProofFields {
  const boxHeight =
    input.boxHigh !== null && input.boxLow !== null ? input.boxHigh - input.boxLow : null;
  const boxHeightAtrRatio =
    boxHeight !== null && input.atr !== null && input.atr > 0 ? boxHeight / input.atr : null;
  const boxPos = computeBoxPos(input.lastPrice, input.boxHigh, input.boxLow);
  return {
    lookback: input.lookback,
    boxHigh: input.boxHigh,
    boxLow: input.boxLow,
    boxHeight,
    atr: input.atr,
    boxHeightAtrRatio,
    upperTouchCount: input.upperTouchCount,
    lowerTouchCount: input.lowerTouchCount,
    breakoutHold: input.breakoutHold,
    selectedReason: input.selectedReason,
    boxPos,
    zone: classifyRangeZone(boxPos)
  };
}

export type ResolveStructuralRangeBoxInput = Readonly<{
  symbol: string;
  completed1m: readonly Candle[];
  lastPrice: number;
  atr: number | null;
  prevState: PersistedStructuralBoxState | null;
  nowTs: number;
  minHeightAtrRatio?: number;
}>;

export function resolveStructuralRangeBox(input: ResolveStructuralRangeBoxInput): StructuralBoxResolution {
  const minRatio = input.minHeightAtrRatio ?? MIN_BOX_HEIGHT_ATR_RATIO;
  const micro = computeLegacyMicroBoxBounds(input.completed1m, 30);

  const candidates = STRUCTURAL_BOX_LOOKBACKS.map((lb) =>
    buildStructuralBoxCandidate(input.completed1m, lb, input.atr, minRatio)
  ).filter((c): c is StructuralBoxCandidate => c !== null);

  const best = pickBestCandidate(candidates);

  let boxHigh: number | null = null;
  let boxLow: number | null = null;
  let lookback: number | null = null;
  let selectedReason = "no_structural_candidate";
  let upperTouchCount = 0;
  let lowerTouchCount = 0;
  let breakoutHold = false;
  let hysteresisApplied = false;

  const prev = input.prevState;

  if (best !== null) {
    boxHigh = best.boxHigh;
    boxLow = best.boxLow;
    lookback = best.lookback;
    upperTouchCount = best.upperTouchCount;
    lowerTouchCount = best.lowerTouchCount;
    selectedReason = `structural_candidate_lookback_${best.lookback}`;
  }

  if (prev !== null && Number.isFinite(prev.boxHigh) && Number.isFinite(prev.boxLow) && prev.boxHigh > prev.boxLow) {
    breakoutHold = consecutiveCloseBreakoutHold(input.completed1m, prev.boxHigh, prev.boxLow);
    const candidateDiffers =
      best !== null &&
      (Math.abs(best.boxHigh - prev.boxHigh) > touchBand(input.atr, prev.boxHigh - prev.boxLow) * 0.5 ||
        Math.abs(best.boxLow - prev.boxLow) > touchBand(input.atr, prev.boxHigh - prev.boxLow) * 0.5);

    if (!breakoutHold && candidateDiffers) {
      boxHigh = prev.boxHigh;
      boxLow = prev.boxLow;
      lookback = prev.lookback;
      selectedReason = "hysteresis_hold_prior_structural_box";
      hysteresisApplied = true;
      const prevTouches = countBoundaryTouches(
        input.completed1m.slice(-Math.max(prev.lookback, 30)),
        prev.boxHigh,
        prev.boxLow,
        input.atr
      );
      upperTouchCount = prevTouches.upperTouchCount;
      lowerTouchCount = prevTouches.lowerTouchCount;
    } else if (breakoutHold && best !== null) {
      selectedReason = `breakout_hold_reform_lookback_${best.lookback}`;
    } else if (!candidateDiffers && best === null) {
      boxHigh = prev.boxHigh;
      boxLow = prev.boxLow;
      lookback = prev.lookback;
      selectedReason = "hysteresis_keep_prior_no_new_candidate";
      hysteresisApplied = true;
      const prevTouches = countBoundaryTouches(
        input.completed1m.slice(-Math.max(prev.lookback, 30)),
        prev.boxHigh,
        prev.boxLow,
        input.atr
      );
      upperTouchCount = prevTouches.upperTouchCount;
      lowerTouchCount = prevTouches.lowerTouchCount;
    }
  }

  if (boxHigh === null || boxLow === null) {
    if (best !== null) {
      boxHigh = best.boxHigh;
      boxLow = best.boxLow;
      lookback = best.lookback;
      upperTouchCount = best.upperTouchCount;
      lowerTouchCount = best.lowerTouchCount;
      selectedReason = `fallback_best_effort_lookback_${best.lookback}`;
    } else if (micro.boxHigh !== null && micro.boxLow !== null && micro.boxHigh > micro.boxLow) {
      boxHigh = micro.boxHigh;
      boxLow = micro.boxLow;
      lookback = 30;
      selectedReason = "fallback_micro_not_authoritative_last_resort";
      const t = countBoundaryTouches(
        input.completed1m.slice(-30),
        micro.boxHigh,
        micro.boxLow,
        input.atr
      );
      upperTouchCount = t.upperTouchCount;
      lowerTouchCount = t.lowerTouchCount;
    }
  }

  const boxPos = computeBoxPos(input.lastPrice, boxHigh, boxLow);
  const boxRel =
    boxHigh !== null && boxLow !== null && input.lastPrice > 0
      ? (boxHigh - boxLow) / (input.lastPrice + 1e-9)
      : null;
  const zone = classifyRangeZone(boxPos);

  const proof = proofFromSelection({
    lookback,
    boxHigh,
    boxLow,
    atr: input.atr,
    upperTouchCount,
    lowerTouchCount,
    breakoutHold,
    selectedReason,
    lastPrice: input.lastPrice
  });

  const nextState: PersistedStructuralBoxState | null =
    boxHigh !== null && boxLow !== null && boxHigh > boxLow && lookback !== null
      ? {
          boxHigh,
          boxLow,
          lookback,
          selectedReason,
          updatedAtTs: input.nowTs
        }
      : null;

  return {
    microBoxHigh: micro.boxHigh,
    microBoxLow: micro.boxLow,
    microBoxHeight: micro.boxHeight,
    boxHigh,
    boxLow,
    boxPos,
    boxRel,
    zone,
    lookback,
    selectedReason,
    breakoutHold,
    upperTouchCount,
    lowerTouchCount,
    atr: input.atr,
    boxHeightAtrRatio: proof.boxHeightAtrRatio,
    candidates,
    hysteresisApplied,
    nextState,
    proof
  };
}

export type StructuralBoxLogger = Readonly<{
  info: (event: string, payload: Record<string, unknown>) => void;
}>;

export function emitStructuralRangeBoxProofLogs(
  logger: StructuralBoxLogger,
  symbol: string,
  resolution: StructuralBoxResolution
): void {
  const base = { symbol };
  for (const c of resolution.candidates) {
    logger.info("V2_STRUCTURAL_BOX_CANDIDATES_PROOF", {
      ...base,
      lookback: c.lookback,
      boxHigh: c.boxHigh,
      boxLow: c.boxLow,
      boxHeight: c.boxHeight,
      atr: resolution.atr,
      boxHeightAtrRatio: c.boxHeightAtrRatio,
      upperTouchCount: c.upperTouchCount,
      lowerTouchCount: c.lowerTouchCount,
      breakoutHold: resolution.breakoutHold,
      selectedReason: c.rejectedReason ?? "candidate_ok",
      boxPos: resolution.boxPos,
      zone: resolution.zone,
      widthValid: c.widthValid,
      touchValid: c.touchValid,
      score: c.score
    });
  }

  logger.info("V2_STRUCTURAL_BOX_SELECTION_PROOF", {
    ...base,
    ...resolution.proof,
    hysteresisApplied: resolution.hysteresisApplied,
    microBoxHigh: resolution.microBoxHigh,
    microBoxLow: resolution.microBoxLow,
    microBoxHeight: resolution.microBoxHeight
  });

  const selected =
    resolution.candidates.find((c) => c.lookback === resolution.lookback) ?? resolution.candidates[0];
  logger.info("V2_BOX_TOUCH_CLUSTER_PROOF", {
    ...base,
    ...resolution.proof,
    clusterUpperPercentile: UPPER_CLUSTER_PERCENTILE,
    clusterLowerPercentile: LOWER_CLUSTER_PERCENTILE,
    touchBandAtrFraction: TOUCH_BAND_ATR_FRACTION
  });

  logger.info("V2_BOX_WIDTH_VALIDATION_PROOF", {
    ...base,
    ...resolution.proof,
    minBoxHeightAtrRatio: MIN_BOX_HEIGHT_ATR_RATIO,
    widthValid: selected?.widthValid ?? false
  });

  logger.info("V2_BOX_HYSTERESIS_PROOF", {
    ...base,
    ...resolution.proof,
    hysteresisApplied: resolution.hysteresisApplied,
    breakoutHoldBarsRequired: BREAKOUT_HOLD_BARS
  });
}

export function emitPositionStructuralBoxSnapshotProof(
  logger: StructuralBoxLogger,
  input: Readonly<{
    symbol: string;
    side: "long" | "short";
    rangeBoxHighAtEntry: number | null | undefined;
    rangeBoxLowAtEntry: number | null | undefined;
    liveStructuralProof: StructuralBoxProofFields;
    entryPrice: number;
  }>
): void {
  const boxHigh =
    typeof input.rangeBoxHighAtEntry === "number" && Number.isFinite(input.rangeBoxHighAtEntry)
      ? input.rangeBoxHighAtEntry
      : null;
  const boxLow =
    typeof input.rangeBoxLowAtEntry === "number" && Number.isFinite(input.rangeBoxLowAtEntry)
      ? input.rangeBoxLowAtEntry
      : null;
  const boxHeight = boxHigh !== null && boxLow !== null ? boxHigh - boxLow : null;
  const boxPos = computeBoxPos(input.entryPrice, boxHigh, boxLow);
  logger.info("V2_POSITION_BOX_SNAPSHOT_PROOF", {
    symbol: input.symbol,
    side: input.side,
    lookback: input.liveStructuralProof.lookback,
    boxHigh,
    boxLow,
    boxHeight,
    atr: input.liveStructuralProof.atr,
    boxHeightAtrRatio:
      boxHeight !== null && input.liveStructuralProof.atr
        ? boxHeight / input.liveStructuralProof.atr
        : input.liveStructuralProof.boxHeightAtrRatio,
    upperTouchCount: input.liveStructuralProof.upperTouchCount,
    lowerTouchCount: input.liveStructuralProof.lowerTouchCount,
    breakoutHold: input.liveStructuralProof.breakoutHold,
    selectedReason: "entry_ledger_structural_snapshot",
    boxPos,
    zone: classifyRangeZone(boxPos),
    entryPrice: input.entryPrice,
    liveBoxHigh: input.liveStructuralProof.boxHigh,
    liveBoxLow: input.liveStructuralProof.boxLow
  });
}
