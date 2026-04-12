import type { EngineConfig, PaperClosedPositionRecord, Candle } from "../models/types";
import type { MarketRegime } from "../strategy/market-regime-detector";
import { evaluateCrashRisk, type CrashState } from "./crash-detector";

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
  crashState: CrashState;
  crashReason: string | null;
  crashLockUntil: number;
  isLatePursuit: boolean;
  longAllow: boolean;
  shortAllow: boolean;
  longSizeMult: number;
  shortSizeMult: number;
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

export function evaluateRiskControls(input: Readonly<{
  config: EngineConfig;
  now: number;
  history: readonly unknown[];
  priorState: RiskControlDecision | null;
  globalCandles?: Candle[];
  globalAtr?: number | null;
  /** 하이웨이: 횡보 확신도 (Opportunity Bias 용) */
  rangeConfidence?: number;
  /** 하이웨이: 레짐 이탈 리스크 (사이즈 축소용) */
  regimeExitRisk?: number;
  /** 하이웨이: 박스 붕괴 방향 */
  boxBreakSide?: "up" | "down" | "none";
}>): RiskControlDecision {
  const { config, now, globalCandles, globalAtr, history, priorState } = input;
  const last10 = [...input.history].slice(-10);

  // 1. Daily net PnL cutoff.
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

  // 2. Crash Detection (Direction-Aware)
  let crashState: CrashState = "NONE";
  let crashReason: string | null = null;
  let crashLockUntil = input.priorState?.crashLockUntil ?? 0;
  let isLatePursuit = false;
  let longAllow = true;
  let shortAllow = true;
  let longSizeMult = 1.0;
  let shortSizeMult = 1.0;

  if (globalCandles) {
    const globalCrash = evaluateCrashRisk({
      symbol: "BTCUSDT",
      candles: globalCandles,
      atr: globalAtr ?? null,
      now,
      isGlobal: true
    });

    isLatePursuit = globalCrash.isLatePursuit;

    function stateOrder(s: CrashState): number {
      if (s === "NONE") return 0;
      if (s === "CRASH_ALERT") return 1;
      if (s === "CRASH_REDUCE") return 2;
      if (s === "CRASH_EXIT") return 3;
      if (s === "CRASH_LOCK") return 4;
      return 0;
    }

    if (crashLockUntil > now) {
      crashState = "CRASH_LOCK";
      crashReason = "급락 후 롱 진입 제한 대기 중";
      longAllow = false;
      shortAllow = !isLatePursuit; // 락 상태라도 late pursuit 아니면 숏은 허용 가능
    } else if (globalCrash.state !== "NONE") {
      crashState = globalCrash.state;
      crashReason = globalCrash.reason;

      // Asymmetric Logic
      longAllow = false; // Any crash level blocks new Longs
      shortAllow = !isLatePursuit; // Allow shorts while momentum is starting

      if (crashState === "CRASH_ALERT") {
        longSizeMult = 0.55;
      } else if (crashState === "CRASH_REDUCE") {
        longSizeMult = 0.22;
      }

      if (stateOrder(crashState) >= stateOrder("CRASH_EXIT")) {
        crashLockUntil = now + Math.max(15 * 60 * 1000, config.paperModeSuspendMs);
      }
    }
  }

  if (dailyLossGuardTriggered) {
    longAllow = false;
    shortAllow = false;
  }

  if (crashState !== "NONE" && crashState !== "CRASH_ALERT" && crashState !== "CRASH_LOCK") {
    // Only block "engine" (UI red alert) if it's broad risk, but our specific flags handle entry.
    // engineBlockReasons.push(`crash_risk_${crashState.toLowerCase()}`);
  }

  // 3. Size reduction: last10 net degradation & Regime Exit Risk.
  let last10Net = 0;
  for (const r of last10) {
    const p = asNet(r);
    if (p !== null) last10Net += p;
  }
  const degradeThresh = config.paperLast10NetDegradeThresholdUsd;
  const shouldDegrade = degradeThresh > 0 && last10.length >= 5 && last10Net <= -degradeThresh;
  const baseSizeMult = shouldDegrade ? Math.max(0.15, Math.min(1, config.paperDegradeSizeMultiplier)) : 1;

  // Highway: Scale down if regime exit risk is high
  const exitRiskScale = 1 - (input.regimeExitRisk ?? 0);
  const highwayScaleMult = Math.max(0.1, exitRiskScale);

  longSizeMult *= baseSizeMult * highwayScaleMult;
  shortSizeMult *= baseSizeMult * highwayScaleMult;

  // 4. Per-regime suspension.
  const blockedRegimes: RiskControlDecision["blockedRegimes"] = {};
  const recentLossStreakByMode: RiskControlDecision["recentLossStreakByMode"] = {};
  const streakN_soft = 3;
  const streakN_hard = 5;
  const suspendMs = Math.max(30 * 60 * 1000, config.paperModeSuspendMs);
  const regimes: MarketRegime[] = ["RANGE", "TREND", "NO_TRADE"];
  const highwayMode = (input.rangeConfidence ?? 0) >= 0.72;
  for (const regime of regimes) {
    let streak = 0;
    const isHighwayRange = regime === "RANGE" && highwayMode;
    const effectiveStreakSoft = isHighwayRange ? 5 : 3;
    const effectiveStreakHard = isHighwayRange ? 8 : 5;
    for (let i = input.history.length - 1; i >= 0; i--) {
      const r = input.history[i] as unknown;
      if (asRegimeAtEntry(r) !== regime) continue;
      const p = asNet(r);
      if (p === null) continue;
      if (p < 0) {
        streak += 1;
        if (streak >= streakN_hard) break;
      } else if (p > 0) break;
      else break;
    }
    recentLossStreakByMode[regime] = streak;
    const prior = input.priorState?.blockedRegimes?.[regime];
    const priorUntil = prior?.until ?? 0;
    const stillBlocked = priorUntil > now ? priorUntil : 0;
    if (stillBlocked > 0) {
      blockedRegimes[regime] = { until: stillBlocked, reason: prior?.reason ?? "mode_suspended" };
      continue;
    }
    if (streak >= effectiveStreakHard && regime !== "NO_TRADE") {
      blockedRegimes[regime] = {
        until: now + suspendMs,
        reason: isHighwayRange ? "highway_range_streak_hard_suspended" : "mode_loss_streak_hard_suspended"
      };
    } else if (streak >= effectiveStreakSoft && regime !== "NO_TRADE") {
      // Soft penalty: streakSizeMult 0.2
      longSizeMult *= 0.2;
      shortSizeMult *= 0.2;
    }

    // Highway: Structural Box Break Suspension
    if (regime === "RANGE" && input.boxBreakSide && input.boxBreakSide !== "none") {
      blockedRegimes[regime] = {
        until: now + Math.max(20 * 60 * 1000, config.paperModeSuspendMs),
        reason: `structural_box_break_${input.boxBreakSide}`
      };
    }
  }

  const engineBlocked = dailyLossGuardTriggered; // Only hard-block engine on total loss limit
  const anyModeBlocked = Object.values(blockedRegimes).some((x) => x && x.until > now) || false;
  const riskStatus: RiskStatus = engineBlocked ? "BLOCKED" : shouldDegrade || anyModeBlocked || crashState !== "NONE" ? "LIMITED" : "NORMAL";

  return {
    engineBlocked,
    engineBlockReasons,
    blockedRegimes,
    recentLossStreakByMode,
    sizeMultiplier: baseSizeMult, // Legacy field
    riskStatus,
    dailyLossGuardTriggered,
    crashState,
    crashReason,
    crashLockUntil,
    isLatePursuit,
    longAllow,
    shortAllow,
    longSizeMult,
    shortSizeMult,
    detail: {
      today_net_usd: todayNet,
      daily_loss_limit_usd: dailyLimit,
      last10_net_usd: last10Net,
      size_multiplier: baseSizeMult,
      crash_state: crashState,
      long_allow: longAllow,
      short_allow: shortAllow,
      late_pursuit: isLatePursuit
    }
  };
}
