import type { EngineV2Regime, EngineV2Side } from "../types";

export type MicroExecutionScoreInput = Readonly<{
  symbol: string;
  side: EngineV2Side;
  regime: EngineV2Regime;
  v2Decision: string;
  lastPrice: number;
  volatilityProxy: number;
  rangeConfidence: number;
  breakoutFailureRate: number;
  trendWeaknessScore: number;
  qualityScore: number;
  dataFreshnessMs: number | null;
}>;

export type MicroExecutionScoreResult = Readonly<{
  score: number;
  grade: "strong" | "normal" | "weak" | "danger";
  sizeMultiplier: 1 | 0.75 | 0.5;
  delayMs: 0 | 500 | 1000 | 2000;
  deferOnce: boolean;
  hardBlockReason: null | "EXTREME_SPREAD" | "EMPTY_LIQUIDITY" | "OPPOSITE_FLOW_SPIKE";
  reasons: string[];
  dataFreshnessMs: number | null;
  usedOrderbook: boolean;
  usedRecentTrades: boolean;
  fallbackNeutral: boolean;
  authoritySource: "v2";
}>;

function clampScore(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

export function deriveMicroExecutionScore(input: MicroExecutionScoreInput): MicroExecutionScoreResult {
  const reasons: string[] = [];
  let score = 55;
  let fallbackNeutral = false;
  const usedOrderbook = false;
  const usedRecentTrades = false;

  const validPrice = Number.isFinite(input.lastPrice) && input.lastPrice > 0;
  if (!validPrice) {
    fallbackNeutral = true;
    reasons.push("MISSING_LAST_PRICE_NEUTRAL");
  } else {
    const volPct = Math.max(0, input.volatilityProxy) / input.lastPrice;
    if (volPct >= 0.012) {
      score -= 20;
      reasons.push("LIQUIDITY_GAP_RISK_HIGH");
    } else if (volPct >= 0.008) {
      score -= 10;
      reasons.push("LIQUIDITY_GAP_RISK_MID");
    }
  }

  if (input.breakoutFailureRate >= 0.8 && input.rangeConfidence < 0.55) {
    score -= 12;
    reasons.push("PUMP_EXHAUSTION_RISK");
  }
  if (input.trendWeaknessScore >= 0.7) {
    score -= 8;
    reasons.push("MOMENTUM_FOLLOW_THROUGH_WEAK");
  }
  if (input.qualityScore >= 85 && input.trendWeaknessScore <= 0.4) {
    score += 8;
    reasons.push("MOMENTUM_FOLLOW_THROUGH_OK");
  }
  if (input.dataFreshnessMs != null && input.dataFreshnessMs > 15_000) {
    score -= 8;
    reasons.push("MICRO_DATA_STALE");
  }

  score = clampScore(score);
  let grade: MicroExecutionScoreResult["grade"] = "normal";
  let sizeMultiplier: MicroExecutionScoreResult["sizeMultiplier"] = 1;
  let delayMs: MicroExecutionScoreResult["delayMs"] = 0;
  let deferOnce = false;
  let hardBlockReason: MicroExecutionScoreResult["hardBlockReason"] = null;

  if (score >= 70) {
    grade = "strong";
    sizeMultiplier = 1;
    delayMs = 0;
  } else if (score >= 50) {
    grade = "normal";
    sizeMultiplier = 1;
    delayMs = 0;
  } else if (score >= 35) {
    grade = "weak";
    sizeMultiplier = 0.75;
    delayMs = 500;
  } else if (score >= 20) {
    grade = "weak";
    sizeMultiplier = 0.5;
    delayMs = 1000;
    deferOnce = true;
  } else {
    grade = "danger";
    sizeMultiplier = 0.5;
    delayMs = 2000;
    deferOnce = true;
    if (reasons.includes("LIQUIDITY_GAP_RISK_HIGH")) {
      hardBlockReason = "EMPTY_LIQUIDITY";
    }
  }

  return {
    score,
    grade,
    sizeMultiplier,
    delayMs,
    deferOnce,
    hardBlockReason,
    reasons,
    dataFreshnessMs: input.dataFreshnessMs,
    usedOrderbook,
    usedRecentTrades,
    fallbackNeutral,
    authoritySource: "v2"
  };
}
