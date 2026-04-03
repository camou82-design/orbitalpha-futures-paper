import type { Candle, Timeframe } from "../models/types";
import { emaLastFromCloses } from "../utils/math";
import { ENTRY_GATE_CONFIG } from "./entry-gate-config";

export type EntryGateBlockReason = "low_expected_move" | "higher_tf_mismatch";

export type EntryGateEvaluation = Readonly<{
  allowed: boolean;
  /** Set when `allowed` is false. */
  blockReason?: EntryGateBlockReason;
  /** ATR / reference price (dimensionless, comparable to required move fraction). */
  expectedMove: number;
  /** Round-trip fee + conservative funding estimate as fraction of price (before multiplier). */
  requiredMove: number;
  /** `requiredMove * minMoveVsCostMultiplier` — volatility must exceed this. */
  requiredMoveThreshold: number;
  higherTfAligned: boolean;
  /** Paper-only: fee/ATR vs threshold would have passed without code bypass. */
  originalExpectedMovePass?: boolean;
  /** Paper-only: expected-move gate skipped in code (`paperBypassExpectedMoveGate`). */
  feeExpectedMoveGateBypassed?: boolean;
}>;

function trueRange(high: number, low: number, prevClose: number): number {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

/**
 * Last Wilder ATR value; `candles` oldest → newest, need length > period + 1.
 */
export function atrWilderLast(candles: readonly Candle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!.close;
    const c = candles[i]!;
    tr.push(trueRange(c.high, c.low, prev));
  }
  if (tr.length < period) return null;
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i]!;
  atr /= period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
  }
  return atr;
}

/**
 * Minimum absolute price return (fraction) to cover taker round-trip + a small funding pad.
 * Matches paper PnL scaling: breakeven on fees ≈ `2 * takerFeeRate` in price-return space.
 */
export function minRequiredMoveFraction(input: Readonly<{
  takerFeeRate: number;
  fundingRate: number;
  fundingPeriodsEstimate: number;
}>): number {
  const feeRoundTrip = 2 * input.takerFeeRate;
  const fundPad = Math.abs(input.fundingRate) * Math.max(0, input.fundingPeriodsEstimate);
  return feeRoundTrip + fundPad;
}

export function higherTfLongTrendOk(closes: readonly number[]): boolean {
  const ema20 = emaLastFromCloses([...closes], 20);
  const ema60 = emaLastFromCloses([...closes], 60);
  if (ema20 === null || ema60 === null) return false;
  return ema20 > ema60;
}

export type EntryGateRuntimeOptions = Readonly<{
  /** Overrides `ENTRY_GATE_CONFIG.minMoveVsCostMultiplier` (paper relaxed vs strict). */
  minMoveMultiplier: number;
  /** When false, higher-TF EMA alignment is not required after vol passes. */
  requireHigherTfAlign: boolean;
}>;

export function evaluateEntryCostAndHigherTfGate(input: Readonly<{
  entryTimeframeCandles: readonly Candle[];
  higherTfCandles: readonly Candle[] | null;
  refPrice: number;
  takerFeeRate: number;
  fundingRate: number;
  /** If omitted, uses strict defaults from `ENTRY_GATE_CONFIG`. */
  gateOptions?: EntryGateRuntimeOptions;
  /**
   * Paper simulation only: when true, never block on `low_expected_move` (fee/ATR vs threshold).
   * Live trading code paths must not set this.
   */
  paperBypassExpectedMoveGate?: boolean;
}>): EntryGateEvaluation {
  const period = ENTRY_GATE_CONFIG.volatilityAtrPeriod;
  const mult =
    input.gateOptions?.minMoveMultiplier ?? ENTRY_GATE_CONFIG.minMoveVsCostMultiplier;
  const requireHigherTfAlign = input.gateOptions?.requireHigherTfAlign ?? true;
  const paperBypass = input.paperBypassExpectedMoveGate === true;

  const requiredMove = minRequiredMoveFraction({
    takerFeeRate: input.takerFeeRate,
    fundingRate: input.fundingRate,
    fundingPeriodsEstimate: ENTRY_GATE_CONFIG.fundingPeriodsForMinMoveEstimate
  });
  const requiredMoveThreshold = requiredMove * mult;

  const refOk = Number.isFinite(input.refPrice) && input.refPrice > 0;
  const atr = atrWilderLast(input.entryTimeframeCandles, period);
  const expectedMove = refOk && atr !== null ? atr / input.refPrice : 0;

  let higherTfAligned = false;
  if (input.higherTfCandles !== null && input.higherTfCandles.length > 0) {
    const hCloses = input.higherTfCandles.map((c) => c.close);
    higherTfAligned = higherTfLongTrendOk(hCloses);
  }

  const volOk = refOk && atr !== null && expectedMove >= requiredMoveThreshold;
  const originalExpectedMovePass = volOk;

  if (!paperBypass) {
    if (!refOk) {
      return {
        allowed: false,
        blockReason: "low_expected_move",
        expectedMove: 0,
        requiredMove,
        requiredMoveThreshold,
        higherTfAligned: false,
        originalExpectedMovePass: false,
        feeExpectedMoveGateBypassed: false
      };
    }
    if (atr === null) {
      return {
        allowed: false,
        blockReason: "low_expected_move",
        expectedMove: 0,
        requiredMove,
        requiredMoveThreshold,
        higherTfAligned,
        originalExpectedMovePass: false,
        feeExpectedMoveGateBypassed: false
      };
    }
    if (!volOk) {
      return {
        allowed: false,
        blockReason: "low_expected_move",
        expectedMove,
        requiredMove,
        requiredMoveThreshold,
        higherTfAligned,
        originalExpectedMovePass: false,
        feeExpectedMoveGateBypassed: false
      };
    }
  }

  if (requireHigherTfAlign && !higherTfAligned) {
    return {
      allowed: false,
      blockReason: "higher_tf_mismatch",
      expectedMove,
      requiredMove,
      requiredMoveThreshold,
      higherTfAligned: false,
      originalExpectedMovePass,
      feeExpectedMoveGateBypassed: paperBypass
    };
  }

  return {
    allowed: true,
    expectedMove,
    requiredMove,
    requiredMoveThreshold,
    higherTfAligned,
    originalExpectedMovePass,
    feeExpectedMoveGateBypassed: paperBypass
  };
}

export function entryGateHigherTimeframe(): Timeframe {
  return ENTRY_GATE_CONFIG.higherTimeframe;
}

export function entryGateHigherTfKlineLimit(): number {
  return ENTRY_GATE_CONFIG.higherTfKlineLimit;
}
