import type { Candle, MarketSymbol } from "../models/types";

export type CrashState = "NONE" | "CRASH_ALERT" | "CRASH_REDUCE" | "CRASH_EXIT" | "CRASH_LOCK";
export type PumpState = "NONE" | "PUMP_ALERT" | "PUMP_REDUCE" | "PUMP_EXIT" | "PUMP_LOCK";

export type CrashDecision = Readonly<{
  state: CrashState;
  reason: string;
  intensity: number;
  dropPct: number;
  atrBreach: boolean;
  pressure: number;
  volumeSurge: boolean;
  isLatePursuit: boolean;
}>;

export type PumpDecision = Readonly<{
  state: PumpState;
  reason: string;
  intensity: number;
  risePct: number;
  atrBreach: boolean;
  pressure: number;
  volumeSurge: boolean;
  isLateChase: boolean;
}>;

export type CrashDetectorInput = Readonly<{
  symbol: MarketSymbol;
  candles: Candle[];
  atr: number | null;
  now: number;
  isGlobal?: boolean;
}>;

function safeRecentWindow(candles: Candle[], count: number): Candle[] {
  return candles.slice(-Math.max(1, count));
}

function avgVolume(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  return candles.reduce((s, c) => s + c.volume, 0) / candles.length;
}

/**
 * 하락 충격 감지.
 * 급락장에서 롱을 추격하지 않도록 보수적으로 판단한다.
 */
export function evaluateCrashRisk(input: CrashDetectorInput): CrashDecision {
  const { candles, atr, isGlobal } = input;
  if (candles.length < 10) {
    return {
      state: "NONE",
      reason: "Insufficient data",
      intensity: 0,
      dropPct: 0,
      atrBreach: false,
      pressure: 0,
      volumeSurge: false,
      isLatePursuit: false
    };
  }

  const latest = candles[candles.length - 1];
  const lastPrice = latest.close;
  const price5m = candles[candles.length - 6]?.close ?? candles[0].close;
  const price15m = candles[candles.length - 16]?.close ?? candles[0].close;
  const drop5m = (lastPrice - price5m) / price5m;
  const drop15m = (lastPrice - price15m) / price15m;
  const maxDrop = Math.min(drop5m, drop15m);

  let atrBreach = false;
  let atrSeverity = 0;
  if (atr && atr > 0) {
    const recentHigh = Math.max(...safeRecentWindow(candles, 15).map((c) => c.high));
    const dist = recentHigh - lastPrice;
    atrSeverity = dist / atr;
    if (atrSeverity > 3.2) atrBreach = true;
  }

  let pressure = 0;
  for (const c of safeRecentWindow(candles, 5)) {
    const body = (c.close - c.open) / c.open;
    if (body < 0) pressure += Math.abs(body);
    else pressure -= body * 0.5;
  }

  const avgVol = avgVolume(candles.slice(-20, -5));
  const lastVol = avgVolume(safeRecentWindow(candles, 5));
  const volumeSurge = avgVol > 0 ? lastVol > avgVol * 1.8 : false;

  const dropAbs = Math.abs(maxDrop);
  const isLatePursuit = dropAbs > 0.045 || atrSeverity > 6.5;

  let state: CrashState = "NONE";
  let reason = "";
  let intensity = 0;

  if (dropAbs > 0.035 || (atrBreach && atrSeverity > 5.0) || (dropAbs > 0.025 && pressure > 0.015 && volumeSurge)) {
    state = "CRASH_EXIT";
    reason = "급격한 하방 이탈 및 패닉 셀 감지";
    intensity = 1.0;
  } else if (dropAbs > 0.022 || atrSeverity > 3.8 || (dropAbs > 0.015 && pressure > 0.01)) {
    state = "CRASH_REDUCE";
    reason = "추세적 하락 압력 가중 (위험 축소)";
    intensity = 0.7;
  } else if (dropAbs > 0.012 || atrSeverity > 2.8 || pressure > 0.006) {
    state = "CRASH_ALERT";
    reason = "하방 변동성 증가 주의";
    intensity = 0.4;
  }

  return {
    state,
    reason: isGlobal ? `[GLOBAL] ${reason}` : reason,
    intensity,
    dropPct: maxDrop * 100,
    atrBreach,
    pressure,
    volumeSurge,
    isLatePursuit
  };
}

/**
 * 상방 충격 감지.
 * 급등장에서 숏을 무리하게 맞서는 것을 막기 위한 대칭형 레이어.
 */
export function evaluatePumpRisk(input: CrashDetectorInput): PumpDecision {
  const { candles, atr, isGlobal } = input;
  if (candles.length < 10) {
    return {
      state: "NONE",
      reason: "Insufficient data",
      intensity: 0,
      risePct: 0,
      atrBreach: false,
      pressure: 0,
      volumeSurge: false,
      isLateChase: false
    };
  }

  const latest = candles[candles.length - 1];
  const lastPrice = latest.close;
  const price5m = candles[candles.length - 6]?.close ?? candles[0].close;
  const price15m = candles[candles.length - 16]?.close ?? candles[0].close;
  const rise5m = (lastPrice - price5m) / price5m;
  const rise15m = (lastPrice - price15m) / price15m;
  const maxRise = Math.max(rise5m, rise15m);

  let atrBreach = false;
  let atrSeverity = 0;
  if (atr && atr > 0) {
    const recentLow = Math.min(...safeRecentWindow(candles, 15).map((c) => c.low));
    const dist = lastPrice - recentLow;
    atrSeverity = dist / atr;
    if (atrSeverity > 3.2) atrBreach = true;
  }

  let pressure = 0;
  for (const c of safeRecentWindow(candles, 5)) {
    const body = (c.close - c.open) / c.open;
    if (body > 0) pressure += Math.abs(body);
    else pressure -= Math.abs(body) * 0.5;
  }

  const avgVol = avgVolume(candles.slice(-20, -5));
  const lastVol = avgVolume(safeRecentWindow(candles, 5));
  const volumeSurge = avgVol > 0 ? lastVol > avgVol * 1.8 : false;

  const riseAbs = Math.abs(maxRise);
  const isLateChase = riseAbs > 0.045 || atrSeverity > 6.5;

  let state: PumpState = "NONE";
  let reason = "";
  let intensity = 0;

  if (riseAbs > 0.035 || (atrBreach && atrSeverity > 5.0) || (riseAbs > 0.025 && pressure > 0.015 && volumeSurge)) {
    state = "PUMP_EXIT";
    reason = "급격한 상방 이탈 및 패닉 바잉 감지";
    intensity = 1.0;
  } else if (riseAbs > 0.022 || atrSeverity > 3.8 || (riseAbs > 0.015 && pressure > 0.01)) {
    state = "PUMP_REDUCE";
    reason = "추세적 상방 압력 가중 (위험 축소)";
    intensity = 0.7;
  } else if (riseAbs > 0.012 || atrSeverity > 2.8 || pressure > 0.006) {
    state = "PUMP_ALERT";
    reason = "상방 변동성 증가 주의";
    intensity = 0.4;
  }

  return {
    state,
    reason: isGlobal ? `[GLOBAL] ${reason}` : reason,
    intensity,
    risePct: maxRise * 100,
    atrBreach,
    pressure,
    volumeSurge,
    isLateChase
  };
}
