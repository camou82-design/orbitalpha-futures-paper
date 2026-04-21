import type { FuturesMarketMode } from "./live-market-mode";
import { btcBiasFromModeDetail } from "./live-market-mode";

export type ConfidenceTier = "low" | "mid" | "high" | "top";

export type TradeConfidenceResult = Readonly<{
  confidenceScore: number;
  confidenceTier: ConfidenceTier;
  detail: Record<string, unknown>;
}>;

function tierFromScore(s: number): ConfidenceTier {
  if (s >= 82) return "top";
  if (s >= 68) return "high";
  if (s >= 52) return "mid";
  return "low";
}

/**
 * 진입 직전 신뢰도 (0~100). 모드·구조·BTC·거래량 반영.
 */
export function buildTradeConfidenceScore(input: Readonly<{
  mode: FuturesMarketMode;
  direction: "long" | "short";
  signalStrengthScore: number;
  entryPolicyDetail: Record<string, unknown>;
  volumeRatioProxy: number;
  modeDetail: Record<string, unknown>;
}>): TradeConfidenceResult {
  let score = 42;
  const d: Record<string, unknown> = {};

  score += Math.min(28, Math.max(0, (input.signalStrengthScore - 50) * 0.9));
  d.signal_strength = input.signalStrengthScore;

  const emaOk = input.entryPolicyDetail.ema_aligned === true;
  const emaSoft = input.entryPolicyDetail.trend_ema_soft_pass === true;
  if (emaOk) {
    score += 12;
    d.ema_aligned_bonus = true;
  } else if (emaSoft) {
    score += 4;
    d.trend_ema_soft_pass = true;
  }

  const pullbackOk = input.entryPolicyDetail.pullback_ok === true;
  const rebreakOk = input.entryPolicyDetail.rebreak_ok === true;
  if (pullbackOk) {
    score += 8;
    d.pullback_ok = true;
  }
  if (rebreakOk) {
    score += 6;
    d.rebreak_ok = true;
  }

  const vol = input.volumeRatioProxy;
  if (vol >= 0.95 && vol <= 2.2) {
    score += 7;
    d.volume_quality = "normal";
  } else if (vol >= 12.0) {
    score -= 35; // Extreme
    d.volume_quality = "extreme_overheated";
  } else if (vol >= 8.0) {
    score -= 25; // Tier 4
    d.volume_quality = "heavy_overheated";
  } else if (vol >= 4.5) {
    score -= 15; // Tier 3
    d.volume_quality = "moderate_overheated";
  } else if (vol >= 2.5) {
    score -= 5; // Tier 2
    d.volume_quality = "mild_overheated";
  } else if (vol < 0.75) {
    score -= 8;
    d.volume_quality = "thin";
  }

  const btcB = btcBiasFromModeDetail(input.modeDetail);
  const long = input.direction === "long";
  const btcAlign =
    (long && (btcB === "up" || btcB === "flat")) || (!long && (btcB === "down" || btcB === "flat"));
  if (btcAlign) {
    score += 6;
    d.btc_alignment = true;
  } else {
    score -= 10;
    d.btc_alignment = false;
  }

  const rangeRel = Number(input.modeDetail.range_rel ?? 0);
  if (input.mode === "sideways" && rangeRel > 0.028) {
    score -= 6;
    d.sideways_wide_range = true;
  }

  if (input.mode === "risk_off" && input.entryPolicyDetail.risk_off_long_exception === true) {
    score -= 12;
    d.risk_off_exception_long = true;
  }

  if (input.mode === "trend" && input.modeDetail.bias === (long ? "up" : "down")) {
    score += 5;
    d.mode_direction_match = true;
  }

  if (input.entryPolicyDetail.sideways === true && input.entryPolicyDetail.pullback_ok !== true) {
    score -= 5;
  }

  score = Math.round(Math.min(100, Math.max(0, score)));
  const confidenceTier = tierFromScore(score);
  d.tier = confidenceTier;

  return { confidenceScore: score, confidenceTier, detail: d };
}
