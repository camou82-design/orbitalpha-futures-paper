import type { Candle, MarketSymbol } from "../models/types";

export type CrashState = "NONE" | "CRASH_ALERT" | "CRASH_REDUCE" | "CRASH_EXIT" | "CRASH_LOCK";

export type CrashDecision = Readonly<{
    state: CrashState;
    reason: string;
    intensity: number; // 0-1
    dropPct: number;
    atrBreach: boolean;
    pressure: number;
    volumeSurge: boolean;
    isLatePursuit: boolean;
}>;

export type CrashDetectorInput = Readonly<{
    symbol: MarketSymbol;
    candles: Candle[];
    atr: number | null;
    now: number;
    isGlobal?: boolean;
}>;

/**
 * 하락에 보수적으로 반응하는 Crash Risk Layer.
 * 절대 하락률, ATR 이탈, 봉 압력, 거래량 등을 종합하여 판단한다.
 */
export function evaluateCrashRisk(input: CrashDetectorInput): CrashDecision {
    const { candles, atr, now, isGlobal } = input;
    if (candles.length < 10) {
        return { state: "NONE", reason: "Insufficient data", intensity: 0, dropPct: 0, atrBreach: false, pressure: 0, volumeSurge: false, isLatePursuit: false };
    }

    const latest = candles[candles.length - 1];
    const lastPrice = latest.close;

    // 1. 최근 하락률 (5분, 15분)
    const price5m = candles[candles.length - 6]?.close ?? candles[0].close;
    const price15m = candles[candles.length - 16]?.close ?? candles[0].close;
    const drop5m = (lastPrice - price5m) / price5m;
    const drop15m = (lastPrice - price15m) / price15m;
    const maxDrop = Math.min(drop5m, drop15m); // 음수일수록 하락

    // 2. ATR 이탈폭 (EMA60 - N*ATR 하방 돌파)
    let atrBreach = false;
    let atrSeverity = 0;
    if (atr && atr > 0) {
        const recentHigh = Math.max(...candles.slice(-15).map(c => c.high));
        const dist = recentHigh - lastPrice;
        atrSeverity = dist / atr;
        if (atrSeverity > 3.2) atrBreach = true;
    }

    // 3. 연속 음봉 압력 (최근 5개 캔들의 색상 및 크기 합산)
    let pressure = 0;
    const recent = candles.slice(-5);
    for (const c of recent) {
        const body = (c.close - c.open) / c.open;
        if (body < 0) pressure += Math.abs(body);
        else pressure -= body * 0.5; // 양봉은 압력 상쇄
    }

    // 4. 거래량 수반 여부
    const avgVol = candles.slice(-20, -5).reduce((s, c) => s + c.volume, 0) / 15;
    const lastVol = recent.reduce((s, c) => s + c.volume, 0) / 5;
    const volumeSurge = lastVol > avgVol * 1.8;

    // 5. 바닥 추격 (Late Pursuit) 판단
    // 이미 크게 빠졌거나 ATR 이탈이 극심하면 추격 숏 위험으로 판단
    const dropAbs = Math.abs(maxDrop);
    const isLatePursuit = dropAbs > 0.045 || atrSeverity > 6.5;

    // 최종 판단
    let state: CrashState = "NONE";
    let reason = "";
    let intensity = 0;

    // CRASH_EXIT (급격한 하락)
    if (dropAbs > 0.035 || (atrBreach && atrSeverity > 5.0) || (dropAbs > 0.025 && pressure > 0.015 && volumeSurge)) {
        state = "CRASH_EXIT";
        reason = "급격한 하방 이탈 및 패닉 셀 감지";
        intensity = 1.0;
    }
    // CRASH_REDUCE (위험 축소)
    else if (dropAbs > 0.022 || atrSeverity > 3.8 || (dropAbs > 0.015 && pressure > 0.01)) {
        state = "CRASH_REDUCE";
        reason = "추세적 하락 압력 가중 (위험 축소)";
        intensity = 0.7;
    }
    // CRASH_ALERT (주의)
    else if (dropAbs > 0.012 || atrSeverity > 2.8 || pressure > 0.006) {
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
