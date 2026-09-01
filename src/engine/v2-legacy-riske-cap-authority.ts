import { MIN_POSITION_SIZE_USD } from "../strategy/live-position-sizing";

/** V2 authoritative execution notional — must not be mutated by legacy evaluateRiskExposure leg caps. */
export function resolveV2AuthoritativeFastPathEntryNotionalUsdt(authorityNotionalUsdt: number): number {
  return authorityNotionalUsdt;
}

/** Legacy/V1 pre-submit riskE leg cap (paper-engine non-fast-path). */
export function applyLegacyV1RiskExposureCapClamp(input: Readonly<{
  entrySizeUsd: number;
  side: "long" | "short";
  maxLongExposure: number;
  maxShortExposure: number;
  longUsd: number;
  shortUsd: number;
}>): Readonly<{ sizeUsd: number; clampApplied: boolean }> {
  const cap = input.side === "long" ? input.maxLongExposure : input.maxShortExposure;
  const currentExposureUsd = input.side === "long" ? input.longUsd : input.shortUsd;
  if (
    (input.side === "long" && input.longUsd + input.entrySizeUsd <= input.maxLongExposure) ||
    (input.side === "short" && input.shortUsd + input.entrySizeUsd <= input.maxShortExposure)
  ) {
    return { sizeUsd: input.entrySizeUsd, clampApplied: false };
  }
  const capRemainingUsd = Math.max(0, cap - currentExposureUsd);
  const reducedSizeUsd =
    capRemainingUsd >= MIN_POSITION_SIZE_USD
      ? Math.max(MIN_POSITION_SIZE_USD, Math.round(Math.min(input.entrySizeUsd, capRemainingUsd) * 100) / 100)
      : 0;
  return { sizeUsd: reducedSizeUsd, clampApplied: true };
}
