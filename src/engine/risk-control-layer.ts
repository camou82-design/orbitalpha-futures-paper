import type { EngineConfig, Candle } from "../models/types";
import type { MarketRegime } from "../strategy/market-regime-detector";
import { evaluateCrashRisk, evaluatePumpRisk, type CrashState, type PumpState } from "./crash-detector";

export type RiskStatus = "NORMAL" | "LIMITED" | "BLOCKED";
export type DirectionalShockState = "UP" | "DOWN" | "NONE";

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
  pumpState: PumpState;
  pumpReason: string | null;
  pumpLockUntil: number;
  directionalShockState: DirectionalShockState;
  isLatePursuit: boolean;
  isLateChase: boolean;
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

function asCloseReason(r: unknown): string | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const c = o.closeReason;
  return typeof c === "string" ? c : null;
}

function stateOrder(s: CrashState | PumpState): number {
  if (s === "NONE") return 0;
  if (s === "CRASH_ALERT" || s === "PUMP_ALERT") return 1;
  if (s === "CRASH_REDUCE" || s === "PUMP_REDUCE") return 2;
  if (s === "CRASH_EXIT" || s === "PUMP_EXIT") return 3;
  if (s === "CRASH_LOCK" || s === "PUMP_LOCK") return 4;
  return 0;
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
  const { config, now, globalCandles, globalAtr } = input;
  const last10 = [...input.history].slice(-10);

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

  let crashState: CrashState = "NONE";
  let crashReason: string | null = null;
  let crashLockUntil = input.priorState?.crashLockUntil ?? 0;
  let pumpState: PumpState = "NONE";
  let pumpReason: string | null = null;
  let pumpLockUntil = input.priorState?.pumpLockUntil ?? 0;
  let directionalShockState: DirectionalShockState = "NONE";
  let isLatePursuit = false;
  let isLateChase = false;
  let longAllow = true;
  let shortAllow = true;
  let longSizeMult = 1.0;
  let shortSizeMult = 1.0;
  let crashLockRangeRecoveryBypassActive = false;

  if (globalCandles) {
    const globalCrash = evaluateCrashRisk({
      symbol: "BTCUSDT",
      candles: globalCandles,
      atr: globalAtr ?? null,
      now,
      isGlobal: true
    });
    const globalPump = evaluatePumpRisk({
      symbol: "BTCUSDT",
      candles: globalCandles,
      atr: globalAtr ?? null,
      now,
      isGlobal: true
    });

    isLatePursuit = globalCrash.isLatePursuit;
    isLateChase = globalPump.isLateChase;

    const rangeRecoveryEligible =
      (input.rangeConfidence ?? 0) >= 0.6 &&
      (input.regimeExitRisk ?? 1) <= 0.55 &&
      (input.boxBreakSide ?? "none") === "none";

    if (crashLockUntil > now) {
      if (rangeRecoveryEligible) {
        crashState = "NONE";
        crashReason = null;
        crashLockRangeRecoveryBypassActive = true;
      } else {
        crashState = "CRASH_LOCK";
        crashReason = "급락 후 롱 진입 제한 대기 중";
      }
    } else if (globalCrash.state !== "NONE") {
      if (globalCrash.state === "CRASH_LOCK" && rangeRecoveryEligible) {
        crashState = "NONE";
        crashReason = null;
        crashLockRangeRecoveryBypassActive = true;
      } else {
        crashState = globalCrash.state;
        crashReason = globalCrash.reason;
        if (stateOrder(crashState) >= stateOrder("CRASH_EXIT")) {
          crashLockUntil = now + Math.max(15 * 60 * 1000, config.paperModeSuspendMs);
        }
      }
    }

    if (pumpLockUntil > now) {
      pumpState = "PUMP_LOCK";
      pumpReason = "급등 후 숏 진입 제한 대기 중";
    } else if (globalPump.state !== "NONE") {
      pumpState = globalPump.state;
      pumpReason = globalPump.reason;
      if (stateOrder(pumpState) >= stateOrder("PUMP_EXIT")) {
        pumpLockUntil = now + Math.max(15 * 60 * 1000, config.paperModeSuspendMs);
      }
    }

    if (stateOrder(crashState) > stateOrder(pumpState)) directionalShockState = "DOWN";
    else if (stateOrder(pumpState) > stateOrder(crashState)) directionalShockState = "UP";
    else directionalShockState = "NONE";

    if (directionalShockState === "DOWN") {
      longAllow = false;
      shortAllow = !isLatePursuit;
      if (crashState === "CRASH_ALERT") longSizeMult *= 0.55;
      else if (crashState === "CRASH_REDUCE") longSizeMult *= 0.22;
      else if (crashState === "CRASH_EXIT" || crashState === "CRASH_LOCK") longSizeMult *= 0.1;
      if (isLatePursuit) shortSizeMult *= 0.35;
    } else if (directionalShockState === "UP") {
      shortAllow = false;
      longAllow = !isLateChase;
      if (pumpState === "PUMP_ALERT") shortSizeMult *= 0.55;
      else if (pumpState === "PUMP_REDUCE") shortSizeMult *= 0.22;
      else if (pumpState === "PUMP_EXIT" || pumpState === "PUMP_LOCK") shortSizeMult *= 0.1;
      if (isLateChase) longSizeMult *= 0.35;
    }
  }

  if (dailyLossGuardTriggered) {
    longAllow = false;
    shortAllow = false;
  }

  let last10Net = 0;
  for (const r of last10) {
    const p = asNet(r);
    if (p !== null) last10Net += p;
  }
  const degradeThresh = config.paperLast10NetDegradeThresholdUsd;
  const shouldDegrade = degradeThresh > 0 && last10.length >= 5 && last10Net <= -degradeThresh;
  const baseSizeMult = shouldDegrade ? Math.max(0.15, Math.min(1, config.paperDegradeSizeMultiplier)) : 1;

  const exitRiskScale = 1 - (input.regimeExitRisk ?? 0);
  const highwayScaleMult = Math.max(0.1, exitRiskScale);

  longSizeMult *= baseSizeMult * highwayScaleMult;
  shortSizeMult *= baseSizeMult * highwayScaleMult;

  const blockedRegimes: RiskControlDecision["blockedRegimes"] = {};
  const recentLossStreakByMode: RiskControlDecision["recentLossStreakByMode"] = {};
  const recentCrashDefenseCountByMode: Record<string, number> = {};

  const lossStreakSoftSizeMult = 0.45;
  const hardSuspendMs = Math.max(45_000, Math.floor(Math.max(60_000, config.paperModeHardSuspendMs) * 0.6));
  const regimes: MarketRegime[] = ["RANGE", "TREND", "NO_TRADE"];
  const highwayMode = (input.rangeConfidence ?? 0) >= 0.72;
  const baseSoft = config.paperModeLossStreakSoftCount;
  const baseHard = config.paperModeLossStreakSuspendCount;
  const lossStreakThresholdsByMode: Partial<Record<MarketRegime, { soft: number; hard: number; highwayRange: boolean }>> = {};
  for (const regime of regimes) {
    let streak = 0;
    let crashDefenseCount = 0;
    const isHighwayRange = regime === "RANGE" && highwayMode;
    const effectiveStreakSoft = isHighwayRange ? baseSoft + 2 : baseSoft;
    const effectiveStreakHardBase = isHighwayRange ? baseHard + 4 : baseHard + 2;
    const effectiveStreakHard = Math.max(effectiveStreakSoft + 2, effectiveStreakHardBase);
    lossStreakThresholdsByMode[regime] = {
      soft: effectiveStreakSoft,
      hard: effectiveStreakHard,
      highwayRange: isHighwayRange
    };
    for (let i = input.history.length - 1; i >= 0; i--) {
      const r = input.history[i] as unknown;
      if (asRegimeAtEntry(r) !== regime) continue;

      const reason = asCloseReason(r);
      const isCrashDefense = reason && (
        reason === "EXIT_LONG_CRASH_FORCE" ||
        reason === "EXIT_LONG_CRASH_REDUCE" ||
        reason === "EXIT_CRASH_FORCE" ||
        reason === "EXIT_CRASH_REDUCE"
      );

      const p = asNet(r);
      if (p === null) continue;

      if (isCrashDefense) {
        crashDefenseCount += 1;
        if (regime === "RANGE") {
          console.log(`[RISK] RANGE_STREAK_CLASSIFICATION | symbol: BTCUSDT | regimeAtEntry: ${regime} | closeReason: ${reason} | pnlUsdNet: ${p} | counted_as_general_range_loss: false | counted_as_crash_defense_event: true | excluded_from_general_loss_streak_reason: protective_crash_defense`);
        }
        continue;
      }

      if (p < 0) {
        streak += 1;
        if (regime === "RANGE") {
          console.log(`[RISK] RANGE_STREAK_CLASSIFICATION | symbol: BTCUSDT | regimeAtEntry: ${regime} | closeReason: ${reason ?? "unknown"} | pnlUsdNet: ${p} | counted_as_general_range_loss: true | counted_as_crash_defense_event: false | excluded_from_general_loss_streak_reason: none`);
        }
        if (streak >= effectiveStreakHard) break;
      } else {
        if (regime === "RANGE") {
          console.log(`[RISK] RANGE_STREAK_CLASSIFICATION | symbol: BTCUSDT | regimeAtEntry: ${regime} | closeReason: ${reason ?? "unknown"} | pnlUsdNet: ${p} | counted_as_general_range_loss: false | counted_as_crash_defense_event: false | excluded_from_general_loss_streak_reason: positive_or_flat_pnl_breaks_streak`);
        }
        break;
      }
    }
    recentLossStreakByMode[regime] = streak;
    recentCrashDefenseCountByMode[regime] = crashDefenseCount;
    const prior = input.priorState?.blockedRegimes?.[regime];
    const priorUntil = prior?.until ?? 0;
    const stillBlocked = priorUntil > now ? priorUntil : 0;
    if (stillBlocked > 0) {
      blockedRegimes[regime] = { until: stillBlocked, reason: prior?.reason ?? "mode_suspended" };
      continue;
    }
    if (streak >= effectiveStreakHard && regime !== "NO_TRADE") {
      const suspendReason = isHighwayRange ? "highway_range_streak_hard_suspended" : "mode_loss_streak_hard_suspended";
      blockedRegimes[regime] = {
        until: now + hardSuspendMs,
        reason: suspendReason
      };
      if (regime === "RANGE") {
        console.log(`[RISK] RANGE_HARD_SUSPEND_DECISION_TRACE | regime: ${regime} | effective_general_loss_streak: ${streak} | effective_crash_defense_count: ${crashDefenseCount} | soft_threshold: ${effectiveStreakSoft} | hard_threshold: ${effectiveStreakHard} | hard_suspend_triggered: true | hard_suspend_reason: ${suspendReason}`);
      }
    } else if (streak >= effectiveStreakSoft && regime !== "NO_TRADE") {
      longSizeMult *= lossStreakSoftSizeMult;
      shortSizeMult *= lossStreakSoftSizeMult;
      if (regime === "RANGE") {
        console.log(`[RISK] RANGE_HARD_SUSPEND_DECISION_TRACE | regime: ${regime} | effective_general_loss_streak: ${streak} | effective_crash_defense_count: ${crashDefenseCount} | soft_threshold: ${effectiveStreakSoft} | hard_threshold: ${effectiveStreakHard} | hard_suspend_triggered: false | soft_degrade_triggered: true`);
      }
    } else {
      if (regime === "RANGE") {
        console.log(`[RISK] RANGE_HARD_SUSPEND_DECISION_TRACE | regime: ${regime} | effective_general_loss_streak: ${streak} | effective_crash_defense_count: ${crashDefenseCount} | soft_threshold: ${effectiveStreakSoft} | hard_threshold: ${effectiveStreakHard} | hard_suspend_triggered: false | reason: below_threshold`);
      }
    }

    if (regime === "RANGE" && input.boxBreakSide && input.boxBreakSide !== "none") {
      blockedRegimes[regime] = {
        until: now + Math.max(20 * 60 * 1000, config.paperModeSuspendMs),
        reason: `structural_box_break_${input.boxBreakSide}`
      };
    }
  }

  const engineBlocked = dailyLossGuardTriggered;
  const anyModeBlocked = Object.values(blockedRegimes).some((x) => x && x.until > now) || false;
  const riskStatus: RiskStatus =
    engineBlocked ? "BLOCKED" : shouldDegrade || anyModeBlocked || directionalShockState !== "NONE" ? "LIMITED" : "NORMAL";

  return {
    engineBlocked,
    engineBlockReasons,
    blockedRegimes,
    recentLossStreakByMode,
    sizeMultiplier: baseSizeMult,
    riskStatus,
    dailyLossGuardTriggered,
    crashState,
    crashReason,
    crashLockUntil,
    pumpState,
    pumpReason,
    pumpLockUntil,
    directionalShockState,
    isLatePursuit,
    isLateChase,
    longAllow,
    shortAllow,
    longSizeMult,
    shortSizeMult,
    detail: {
      today_net_usd: todayNet,
      daily_loss_limit_usd: dailyLimit,
      last10_net_usd: last10Net,
      size_multiplier: baseSizeMult,
      mode_loss_streak_soft_size_mult: lossStreakSoftSizeMult,
      mode_loss_streak_hard_suspend_ms_applied: hardSuspendMs,
      mode_loss_streak_thresholds_by_mode: lossStreakThresholdsByMode,
      recent_crash_defense_count_by_mode: recentCrashDefenseCountByMode,
      crash_state: crashState,
      crash_lock_range_recovery_bypass_active: crashLockRangeRecoveryBypassActive,
      pump_state: pumpState,
      directional_shock_state: directionalShockState,
      long_allow: longAllow,
      short_allow: shortAllow,
      late_pursuit: isLatePursuit,
      late_chase: isLateChase,
      pump_lock_until: pumpLockUntil,
      crash_lock_until: crashLockUntil
    }
  };
}
