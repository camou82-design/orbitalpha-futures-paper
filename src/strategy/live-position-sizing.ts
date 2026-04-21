import type { EngineConfig } from "../models/types";
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
 * Paper sizing anchor: `paperAccountEquityUsd * paperEntryNotionalTargetFrac` when equity is set; else `paperBaseSizeUsd`.
 */
export function computePaperSizingAnchorUsd(
  config: Readonly<
    Pick<EngineConfig, "paperBaseSizeUsd" | "paperAccountEquityUsd" | "paperEntryNotionalTargetFrac">
  >
): number {
  const frac =
    Number.isFinite(config.paperEntryNotionalTargetFrac) && config.paperEntryNotionalTargetFrac > 0
      ? Math.min(1, config.paperEntryNotionalTargetFrac)
      : 1;
  if (
    config.paperAccountEquityUsd != null &&
    Number.isFinite(config.paperAccountEquityUsd) &&
    config.paperAccountEquityUsd > 0
  ) {
    return Math.round(config.paperAccountEquityUsd * frac * 100) / 100;
  }
  const base =
    Number.isFinite(config.paperBaseSizeUsd) && config.paperBaseSizeUsd > 0 ? config.paperBaseSizeUsd : 100;
  return Math.round(base * 100) / 100;
}

/**
 * 모드 베이스 × 신뢰도 티어. 저신뢰는 차단 또는 최소만.
 * 최소 명목(MIN)은 `runFuturesAdaptiveEntry` 종단에서만 강제(소프트 배수 이후).
 */
export function calculateAdaptivePositionSize(input: Readonly<{
  mode: FuturesMarketMode;
  confidenceScore: number;
  confidenceTier: ConfidenceTier;
  modeBaseSizeUsd: number;
  modeLeverageMultiplier: number;
  baseSizeUsdCap: number;
  volumeRatioProxy?: number;
}>): AdaptiveSizingResult {
  let confMult = 1;
  if (input.confidenceTier === "top") confMult = 1;
  else if (input.confidenceTier === "high") confMult = 0.75;
  else if (input.confidenceTier === "mid") confMult = 0.5;
  else confMult = 0.25;

  let volMult = 1.0;
  if (input.volumeRatioProxy !== undefined) {
    const vol = input.volumeRatioProxy;
    if (vol >= 8.0) volMult = 0.15; // User rule: 0.1x ~ 0.2x
    else if (vol >= 4.5) volMult = 0.3; // User rule: 0.25x ~ 0.4x
    // Note: 2.5 ~ 4.5 is handled by confidence penalty only
  }

  if (input.confidenceTier === "low" && input.confidenceScore < 40) {
    return {
      sizeMultiplier: 0,
      finalPositionSize: 0,
      blocked: true,
      blockReason: "position_size_blocked_low_confidence",
      detail: {
        confidence_score: input.confidenceScore,
        tier: input.confidenceTier,
        mode: input.mode,
        order_build_fail_reason: "size_blocked_low_confidence"
      }
    };
  }

  let raw = input.modeBaseSizeUsd * confMult * volMult;
  raw = Math.min(input.baseSizeUsdCap, Math.round(raw * 100) / 100);
  if (raw <= 0 || !Number.isFinite(raw)) {
    return {
      sizeMultiplier: 0,
      finalPositionSize: 0,
      blocked: true,
      blockReason: "position_size_invalid",
      detail: {
        mode: input.mode,
        order_build_fail_reason: "size_invalid"
      }
    };
  }

  const sizeMultiplier = input.modeBaseSizeUsd > 0 ? raw / input.modeBaseSizeUsd : confMult * volMult;

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
      min_size_usd: MIN_POSITION_SIZE_USD,
      volume_mult: volMult
    }
  };
}
