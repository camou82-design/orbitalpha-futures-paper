import type { EngineConfig, MarketModeSelectorOutput, RiskExposureOutput, PaperRiskMode } from "../models/types";
import type { RiskControlDecision } from "./risk-control-layer";
import type { Logger } from "../logs/logger";

export type RiskExposureInput = Readonly<{
  config: EngineConfig;
  marketMode: MarketModeSelectorOutput;
  risk: RiskControlDecision;
  openPositionCount: number;
  /** UTC 기준 세션 세분(미장 개장 전후 등). */
  fetchedAtMs: number;
  /** When set, emits one structured proof line for short new-entry gating (upstream diagnosis). */
  proofLogger?: Logger;
}>;

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function shortBlockedReason(input: {
  riskShortAllow: boolean;
  routingPaused: boolean;
  openPositionCount: number;
  maxSlots: number;
  riskMode: PaperRiskMode;
}): string | null {
  if (!input.riskShortAllow) return "RISK_SHORT_DISALLOWED";
  if (input.routingPaused) return "ROUTING_PAUSED";
  if (!(input.openPositionCount < input.maxSlots)) return "MAX_SLOTS_REACHED";
  if (input.riskMode === "HALT") return "RISK_MODE_HALT";
  return null;
}

function longBlockedReason(input: {
  riskLongAllow: boolean;
  routingPaused: boolean;
  openPositionCount: number;
  maxSlots: number;
  riskMode: PaperRiskMode;
}): string | null {
  if (!input.riskLongAllow) return "RISK_LONG_DISALLOWED";
  if (input.routingPaused) return "ROUTING_PAUSED";
  if (!(input.openPositionCount < input.maxSlots)) return "MAX_SLOTS_REACHED";
  if (input.riskMode === "HALT") return "RISK_MODE_HALT";
  return null;
}

function sessionRiskBias(
  sessionProfile: string,
  volHigh: boolean,
  utcHour: number,
  utcMin: number
): Readonly<{
  rangeHedgeBoost: number;
  trendSwitchBoost: number;
  label: string;
}> {
  const usOpenWindow = utcHour === 13 || utcHour === 14 || (utcHour === 15 && utcMin < 30);
  if (usOpenWindow && sessionProfile === "us_session") {
    return {
      rangeHedgeBoost: 0.88,
      trendSwitchBoost: volHigh ? 1.18 : 1.1,
      label: "미장 개장 전후 — 변동·스위칭 가중"
    };
  }
  if (sessionProfile === "us_session") {
    return {
      rangeHedgeBoost: 0.95,
      trendSwitchBoost: volHigh ? 1.12 : 1.05,
      label: "미장 세션 — 추세·스위칭 가중"
    };
  }
  if (sessionProfile === "asia_quiet") {
    return {
      rangeHedgeBoost: 1.08,
      trendSwitchBoost: 0.92,
      label: "아시아 저유동 — 횡보·헤지 완화"
    };
  }
  if (sessionProfile === "eu_overlap") {
    return {
      rangeHedgeBoost: 1.06,
      trendSwitchBoost: 0.94,
      label: "유럽·저녁 횡보 — RANGE 완화"
    };
  }
  return { rangeHedgeBoost: 1, trendSwitchBoost: 1, label: "기본 세션 프로파일" };
}

/**
 * 모드별 운용 강도: RANGE는 양방향 한도·헤지, TREND는 스위칭·돌파 크기.
 */
export function evaluateRiskExposure(input: RiskExposureInput): RiskExposureOutput {
  const { marketMode, risk, openPositionCount, config } = input;
  const throttle = marketMode.riskThrottle;
  const volHigh = throttle > 0.55;
  const eventVol = throttle > 0.68;
  const d = new Date(input.fetchedAtMs);
  const utcHour = d.getUTCHours();
  const utcMin = d.getUTCMinutes();
  const sess = sessionRiskBias(marketMode.sessionProfile, volHigh || eventVol, utcHour, utcMin);

  let riskMode: PaperRiskMode = "NORMAL";
  if (risk.engineBlocked === true || risk.dailyLossGuardTriggered) riskMode = "HALT";
  else if (throttle > 0.72 || volHigh || risk.crashState === "CRASH_EXIT") riskMode = "DEFENSIVE";
  else if (throttle > 0.45 || risk.riskStatus === "LIMITED" || risk.crashState !== "NONE") riskMode = "REDUCED";

  const baseSize =
    risk.riskStatus === "LIMITED"
      ? config.paperDegradeSizeMultiplier
      : riskMode === "DEFENSIVE"
        ? config.paperDegradeSizeMultiplier * 0.85
        : 1;

  let sizeMultiplier = clamp(baseSize * (1 - throttle * 0.35), 0.12, 1.35);
  const mm = marketMode.marketMode;
  if (eventVol) sizeMultiplier *= 0.78;
  if (mm === "MIXED" || mm === "TRANSITION") sizeMultiplier *= 0.72;
  if (marketMode.routing.newEntryPolicy === "reduced") sizeMultiplier *= 0.65;
  if (marketMode.routing.probeEntryOnly === true) sizeMultiplier *= 0.42;
  if (marketMode.routing.transitionTier === "dominant_reduced") sizeMultiplier *= 1.05;

  // Asymmetric Crash Multipliers
  const longSizeMultiplier = clamp(sizeMultiplier * risk.longSizeMult, 0.0, 1.48);
  const shortSizeMultiplier = clamp(sizeMultiplier * risk.shortSizeMult, 0.12, 1.48);

  let opportunityBias = 1;
  const ae = marketMode.routing.activeEngine;
  if (riskMode === "NORMAL" && throttle < 0.48) {
    if (ae === "TREND" && (mm === "TREND" || mm === "MIXED")) opportunityBias *= 1.07;
    if (ae === "RANGE" && (mm === "RANGE" || mm === "TRANSITION")) opportunityBias *= 1.06;
  }
  if (marketMode.sessionProfile === "us_session" && ae === "TREND" && !volHigh && throttle < 0.52) {
    opportunityBias *= 1.08;
  }
  if (marketMode.sessionProfile === "asia_quiet" && ae === "RANGE" && !volHigh && throttle < 0.5) {
    opportunityBias *= 1.06;
  }

  const finalLongSizeMult = clamp(longSizeMultiplier * opportunityBias, 0.0, 1.48);
  const finalShortSizeMult = clamp(shortSizeMultiplier * opportunityBias, 0.12, 1.48);

  const maxSlots = Math.max(1, config.paperMaxOpenPositions);
  const perSlot = 100;
  let maxLongExposure = perSlot * maxSlots;
  let maxShortExposure = perSlot * maxSlots;

  if (mm === "RANGE" || mm === "TRANSITION" || marketMode.routing.activeEngine === "RANGE") {
    maxLongExposure *= 1.12 * sess.rangeHedgeBoost;
    maxShortExposure *= 1.12 * sess.rangeHedgeBoost;
  } else if (mm === "TREND" || mm === "MIXED" || marketMode.routing.activeEngine === "TREND") {
    maxLongExposure *= 1.02;
    maxShortExposure *= 1.02;
  } else {
    maxLongExposure *= 0.45;
    maxShortExposure *= 0.45;
  }

  const switchSizeMultiplier = clamp(finalLongSizeMult * 0.92 * sess.trendSwitchBoost, 0.18, 1.22);
  const routingPaused = marketMode.routing.newEntryPolicy === "paused";

  const allowNewLong = risk.longAllow && !routingPaused && openPositionCount < maxSlots && riskMode !== "HALT";
  const allowNewShort = risk.shortAllow && !routingPaused && openPositionCount < maxSlots && riskMode !== "HALT";
  const allowNewEntry = allowNewLong || allowNewShort;

  const shortReason = shortBlockedReason({
    riskShortAllow: risk.shortAllow,
    routingPaused,
    openPositionCount,
    maxSlots,
    riskMode
  });
  const longReason = longBlockedReason({
    riskLongAllow: risk.longAllow,
    routingPaused,
    openPositionCount,
    maxSlots,
    riskMode
  });

  if (input.proofLogger) {
    input.proofLogger.info("RISK_EXPOSURE_SHORT_GATE_PROOF", {
      market_mode: mm,
      active_engine: ae,
      new_entry_policy: marketMode.routing.newEntryPolicy,
      routing_paused: routingPaused,
      risk_short_allow: risk.shortAllow,
      risk_long_allow: risk.longAllow,
      risk_mode: riskMode,
      open_position_count: openPositionCount,
      max_slots: maxSlots,
      allow_new_long: allowNewLong,
      allow_new_short: allowNewShort,
      allow_new_entry: allowNewEntry,
      short_blocked_reason: shortReason,
      long_blocked_reason: longReason,
      directional_shock_state: risk.directionalShockState,
      late_pursuit: risk.isLatePursuit,
      late_chase: risk.isLateChase,
      symbol: null
    });
  }

  const allowAdd =
    allowNewEntry &&
    riskMode !== "HALT" &&
    riskMode !== "DEFENSIVE" &&
    (marketMode.routing.newEntryPolicy === "full" || ae === "TREND" || ae === "RANGE");

  const allowRangeBidirectional = ae === "RANGE" && riskMode !== "HALT";
  const blockTrendOppositeLeg = ae === "TREND";
  const allowHedge = allowRangeBidirectional;

  const riskReasonLabel =
    riskMode === "HALT"
      ? "일일 손실 한도 또는 엔진 차단"
      : riskMode === "DEFENSIVE"
        ? `고스로틀·고변동·급락감지 — ${sess.label}`
        : risk.crashState !== "NONE"
          ? `급락 경보 (${risk.crashState}) — ${sess.label}`
          : riskMode === "REDUCED"
            ? `제한 모드 — ${sess.label}`
            : `정상 — ${sess.label}`;

  let riskStanceLabel = "보통";
  if (riskMode === "HALT" || riskMode === "DEFENSIVE") riskStanceLabel = "보수·축소";
  else if (opportunityBias >= 1.08 && throttle < 0.52) riskStanceLabel = "기회·확대";
  else if (opportunityBias <= 0.98 || throttle > 0.58) riskStanceLabel = "주의·보수";

  return {
    riskMode,
    opportunityBias,
    riskStanceLabel,
    sizeMultiplier: finalLongSizeMult, // Legacy support
    longSizeMultiplier: finalLongSizeMult,
    shortSizeMultiplier: finalShortSizeMult,
    maxLongExposure,
    maxShortExposure,
    switchSizeMultiplier,
    allowNewEntry,
    allowNewLong,
    allowNewShort,
    allowAdd,
    allowRangeBidirectional,
    blockTrendOppositeLeg,
    allowHedge,
    riskReasonLabel
  };
}
