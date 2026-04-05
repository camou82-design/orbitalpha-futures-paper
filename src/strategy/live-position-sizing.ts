import type { FuturesMarketMode } from "./live-market-mode";
import type { ConfidenceTier } from "./live-trade-confidence";

export type AdaptiveSizingResult = Readonly<{
  sizeMultiplier: number;
  finalPositionSize: number;
  blocked: boolean;
  blockReason: string | null;
  detail: Record<string, unknown>;
}>;

export const MIN_POSITION_SIZE_USD = 15;

/**
 * 모드 베이스 × 신뢰도 티어. 저신뢰는 차단 또는 최소만.
 */
export function calculateAdaptivePositionSize(input: Readonly<{
  mode: FuturesMarketMode;
  confidenceScore: number;
  confidenceTier: ConfidenceTier;
  modeBaseSizeUsd: number;
  modeLeverageMultiplier: number;
  baseSizeUsdCap: number;
}>): AdaptiveSizingResult {
  let confMult = 1;
  if (input.confidenceTier === "top") confMult = 1;
  else if (input.confidenceTier === "high") confMult = 0.75;
  else if (input.confidenceTier === "mid") confMult = 0.5;
  else confMult = 0.25;

  if (input.confidenceTier === "low" && input.confidenceScore < 40) {
    return {
      sizeMultiplier: 0,
      finalPositionSize: 0,
      blocked: true,
      blockReason: "position_size_blocked_low_confidence",
      detail: {
        confidence_score: input.confidenceScore,
        tier: input.confidenceTier,
        mode: input.mode
      }
    };
  }

  let raw = input.modeBaseSizeUsd * confMult;
  raw = Math.max(MIN_POSITION_SIZE_USD, Math.min(input.baseSizeUsdCap, Math.round(raw * 100) / 100));

  const sizeMultiplier = input.modeBaseSizeUsd > 0 ? raw / input.modeBaseSizeUsd : confMult;

  return {
    sizeMultiplier,
    finalPositionSize: raw,
    blocked: false,
    blockReason: null,
    detail: {
      mode: input.mode,
      confidence_score: input.confidenceScore,
      confidence_tier: input.confidenceTier,
      confidence_multiplier: confMult,
      mode_base_usd: input.modeBaseSizeUsd,
      mode_leverage_mult: input.modeLeverageMultiplier,
      min_size_usd: MIN_POSITION_SIZE_USD
    }
  };
}
