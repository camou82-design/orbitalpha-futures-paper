import type { EngineConfig, MarketModeSelectorOutput, RiskExposureOutput, PaperRiskMode } from "../models/types";
import type { RiskControlDecision } from "../strategy/risk-control-layer";

export type RiskExposureInput = Readonly<{
  config: EngineConfig;
  marketMode: MarketModeSelectorOutput;
  risk: RiskControlDecision;
  openPositionCount: number;
}>;

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 모드·세션·기존 리스크 상태를 종합해 노출 한도와 허용 플래그를 낸다.
 */
export function evaluateRiskExposure(input: RiskExposureInput): RiskExposureOutput {
  const { marketMode, risk, openPositionCount, config } = input;
  const throttle = marketMode.riskThrottle;

  let riskMode: PaperRiskMode = "NORMAL";
  if (risk.engineBlocked === true || risk.dailyLossGuardTriggered) riskMode = "HALT";
  else if (throttle > 0.72) riskMode = "DEFENSIVE";
  else if (throttle > 0.45 || risk.riskStatus === "LIMITED") riskMode = "REDUCED";

  const baseSize =
    risk.riskStatus === "LIMITED"
      ? config.paperDegradeSizeMultiplier
      : riskMode === "DEFENSIVE"
        ? config.paperDegradeSizeMultiplier * 0.85
        : 1;

  const sizeMultiplier = clamp(baseSize * (1 - throttle * 0.35), 0.15, 1.25);

  const maxSlots = Math.max(1, config.paperMaxOpenPositions);
  const perSlot = 100;
  let maxLongExposure = perSlot * maxSlots;
  let maxShortExposure = perSlot * maxSlots;

  if (marketMode.marketMode === "RANGE" || marketMode.marketMode === "TRANSITION") {
    maxLongExposure *= 1.1;
    maxShortExposure *= 1.1;
  } else if (marketMode.marketMode === "TREND" || marketMode.marketMode === "MIXED") {
    maxLongExposure *= 1;
    maxShortExposure *= 1;
  } else {
    maxLongExposure *= 0.5;
    maxShortExposure *= 0.5;
  }

  const switchSizeMultiplier = clamp(sizeMultiplier * 0.95, 0.2, 1.15);

  const allowNewEntry =
    risk.engineBlocked !== true &&
    !risk.dailyLossGuardTriggered &&
    marketMode.marketMode !== "NO_TRADE" &&
    openPositionCount < maxSlots;

  const allowAdd = allowNewEntry && riskMode !== "HALT" && riskMode !== "DEFENSIVE";
  const allowHedge =
    (marketMode.marketMode === "RANGE" || marketMode.marketMode === "MIXED") &&
    riskMode === "NORMAL";

  const riskReasonLabel =
    riskMode === "HALT"
      ? "일일 손실 한도 또는 엔진 차단"
      : riskMode === "DEFENSIVE"
        ? "고스로틀·변동성·NO_TRADE 성향"
        : riskMode === "REDUCED"
          ? "제한적 리스크 상태·스로틀"
          : "정상 프로파일";

  return {
    riskMode,
    sizeMultiplier,
    maxLongExposure,
    maxShortExposure,
    switchSizeMultiplier,
    allowNewEntry,
    allowAdd,
    allowHedge,
    riskReasonLabel
  };
}
