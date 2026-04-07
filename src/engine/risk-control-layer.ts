import type { EngineConfig, PaperClosedPositionRecord } from "../models/types";
import type { MarketRegime } from "../strategy/market-regime-detector";

export type RiskStatus = "NORMAL" | "LIMITED" | "BLOCKED";

export type RiskControlDecision = Readonly<{
  engineBlocked: boolean;
  engineBlockReasons: string[];
  /** Regime-specific suspension */
  blockedRegimes: Partial<Record<MarketRegime, { until: number; reason: string }>>;
  /** Recent consecutive loss streak by regime (most recent streak). */
  recentLossStreakByMode: Partial<Record<MarketRegime, number>>;
  /** Position size multiplier (<=1). */
  sizeMultiplier: number;
  riskStatus: RiskStatus;
  dailyLossGuardTriggered: boolean;
  detail: Record<string, unknown>;
}>;

function startOfUtcDayMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

function asNet(r: unknown): number | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const p = o.pnlUsdNet ?? o.pnlUsd;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

function asClosedAt(r: unknown): number | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const t = o.closedAt;
  return typeof t === "number" && Number.isFinite(t) ? t : null;
}

function asRegimeAtEntry(r: unknown): MarketRegime | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const m = o.regimeAtEntry;
  return m === "RANGE" || m === "TREND" || m === "NO_TRADE" ? m : null;
}

/**
 * Risk control layer (paper-only).
 *
 * Must run under the regime detector and can block entries even when signals pass.
 * Also produces a size multiplier for "최근 10건 성과 악화 → 포지션 축소".
 */
export function evaluateRiskControls(input: Readonly<{
  config: EngineConfig;
  now: number;
  history: readonly unknown[];
  priorState: RiskControlDecision | null;
}>): RiskControlDecision {
  const { config, now } = input;
  const last10 = [...input.history].slice(-10);

  // Daily net PnL cutoff.
  const dayStart = startOfUtcDayMs(now);
  let todayNet = 0;
  for (const r of input.history) {
    const t = asClosedAt(r);
    const p = asNet(r);
    if (t === null || p === null) continue;
    if (t >= dayStart && t <= now) todayNet += p;
  }

  const engineBlockReasons: string[] = [];
  const dailyLimit = config.paperDailyLossLimitUsd;
  const dailyLossGuardTriggered = dailyLimit > 0 && todayNet <= -dailyLimit;
  if (dailyLossGuardTriggered) {
    engineBlockReasons.push("daily_loss_limit_exceeded");
  }

  // Size reduction: last10 net degradation.
  let last10Net = 0;
  for (const r of last10) {
    const p = asNet(r);
    if (p !== null) last10Net += p;
  }
  const degradeThresh = config.paperLast10NetDegradeThresholdUsd;
  const shouldDegrade = degradeThresh > 0 && last10.length >= 5 && last10Net <= -degradeThresh;
  const sizeMultiplier = shouldDegrade ? Math.max(0.15, Math.min(1, config.paperDegradeSizeMultiplier)) : 1;

  // Per-regime 3-loss streak suspension (based on regimeAtEntry).
  const blockedRegimes: RiskControlDecision["blockedRegimes"] = {};
  const recentLossStreakByMode: RiskControlDecision["recentLossStreakByMode"] = {};
  const streakN = Math.max(2, config.paperModeLossStreakSuspendCount);
  const suspendMs = Math.max(60_000, config.paperModeSuspendMs);
  const regimes: MarketRegime[] = ["RANGE", "TREND", "NO_TRADE"];
  for (const regime of regimes) {
    // Track most recent consecutive losses for this regime.
    let streak = 0;
    for (let i = input.history.length - 1; i >= 0; i--) {
      const r = input.history[i] as unknown;
      const m = asRegimeAtEntry(r);
      if (m !== regime) continue;
      const p = asNet(r);
      if (p === null) continue;
      if (p < 0) {
        streak += 1;
        if (streak >= streakN) break;
      } else if (p > 0) {
        break;
      } else {
        break;
      }
    }
    recentLossStreakByMode[regime] = streak;
    const prior = input.priorState?.blockedRegimes?.[regime];
    const priorUntil = prior?.until ?? 0;
    const stillBlocked = priorUntil > now ? priorUntil : 0;
    if (stillBlocked > 0) {
      blockedRegimes[regime] = { until: stillBlocked, reason: prior?.reason ?? "mode_suspended" };
      continue;
    }
    if (streak >= streakN && regime !== "NO_TRADE") {
      blockedRegimes[regime] = { until: now + suspendMs, reason: "mode_loss_streak_suspended" };
    }
  }

  const engineBlocked = engineBlockReasons.length > 0;
  const anyModeBlocked =
    Object.values(blockedRegimes).some((x) => x && typeof x.until === "number" && x.until > now) || false;

  const riskStatus: RiskStatus = engineBlocked ? "BLOCKED" : shouldDegrade || anyModeBlocked ? "LIMITED" : "NORMAL";

  return {
    engineBlocked,
    engineBlockReasons,
    blockedRegimes,
    recentLossStreakByMode,
    sizeMultiplier,
    riskStatus,
    dailyLossGuardTriggered,
    detail: {
      today_net_usd: todayNet,
      daily_loss_limit_usd: dailyLimit,
      last10_net_usd: last10Net,
      last10_count: last10.length,
      degrade_threshold_usd: degradeThresh,
      size_multiplier: sizeMultiplier,
      mode_suspend_loss_streak: streakN,
      mode_suspend_ms: suspendMs
    }
  };
}

