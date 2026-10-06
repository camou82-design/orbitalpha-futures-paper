import type { Candle } from "../../models/types";
import type { EngineV2Side } from "../types";

export interface FastTrendShiftConfirmationInput {
    symbol: string;
    side: EngineV2Side;
    lastPrice: number;
    boxHigh: number;
    boxLow: number;
    volumeExpansion: number;
    macroPolarity?: string | null;
    htf1hBias?: string | null;
    htf4hBias?: string | null;
    candles1m?: Candle[] | null;
    candles5m?: Candle[] | null;
    ftsDetectedAt?: number | null;
    now: number;
}

export interface FastTrendShiftConfirmationResult {
    confirmed: boolean;
    expedited: boolean;
    reason: string;
    blockReason: string | null;
    evidence: {
        volumeSurgePassed: boolean;
        volumeRatio: number;
        boxOutsideClosePassed: boolean;
        boxOutsidePrice: number | null;
        macroPolarityPassed: boolean;
        macroPolarity: string | null;
        m5CandleConfirmed: boolean;
        m5LastClose: number | null;
        m5LastOpen: number | null;
        m5CandleCloseTime?: number | null;
        m5CausalityPassed?: boolean;
        ftsDetectedAt?: number | null;
    };
}

export function evaluateFastTrendShift5mConfirmation(
    input: FastTrendShiftConfirmationInput
): FastTrendShiftConfirmationResult {
    const {
        symbol,
        side,
        lastPrice,
        boxHigh,
        boxLow,
        volumeExpansion,
        macroPolarity,
        htf1hBias,
        htf4hBias,
        candles1m,
        candles5m,
        ftsDetectedAt,
        now
    } = input;

    // 1. 5m 완성봉 시간 인과성 및 방향 검증
    let m5CandleConfirmed = false;
    let m5LastClose: number | null = null;
    let m5LastOpen: number | null = null;
    let m5CandleCloseTime: number | null = null;
    let m5CausalityPassed = false;

    if (Array.isArray(candles5m) && candles5m.length >= 2) {
        // 마지막 완성봉 (진행 중인 봉 직전의 완성된 봉)
        const closed5m = candles5m[candles5m.length - 1];
        m5LastClose = closed5m.close;
        m5LastOpen = closed5m.open;
        const candleTs = Number((closed5m as any).ts ?? (closed5m as any).timestamp ?? 0);
        const candleCloseTime = Number((closed5m as any).closeTime ?? (candleTs > 0 ? candleTs + 300_000 : 0));
        m5CandleCloseTime = candleCloseTime;

        const detectedAt = typeof ftsDetectedAt === "number" && ftsDetectedAt > 0
            ? ftsDetectedAt
            : null;

        // 시간 인과성: 완성봉의 closeTime이 FTS 감지 시점 이상이어야 함
        // (FTS 발생 이전의 과거 5분봉 candleCloseTime < detectedAt 재사용 차단)
        m5CausalityPassed = detectedAt == null || candleCloseTime >= detectedAt;

        if (m5CausalityPassed) {
            if (side === "long" && m5LastClose > m5LastOpen) {
                m5CandleConfirmed = true;
            } else if (side === "short" && m5LastClose < m5LastOpen) {
                m5CandleConfirmed = true;
            }
        }
    }

    // 2. EXPEDITE 3대 조건 검증
    // 조건 1: volume surge >= 2.0x 최근 20봉 평균
    let volumeRatio = Number(volumeExpansion ?? 1.0);
    if ((!Number.isFinite(volumeRatio) || volumeRatio <= 1.0) && Array.isArray(candles1m) && candles1m.length >= 21) {
        const lastCandle = candles1m[candles1m.length - 1];
        const lastVol = Number(lastCandle?.volume ?? 0);
        const prev20 = candles1m.slice(-21, -1);
        const avgVol = prev20.reduce((sum, c) => sum + Number(c.volume ?? 0), 0) / Math.max(1, prev20.length);
        if (avgVol > 0) {
            volumeRatio = lastVol / avgVol;
        }
    }
    const volumeSurgePassed = volumeRatio >= 2.0;

    // 조건 2: completed 5m candle close (or confirmed candle close)가 boxHigh 위 또는 boxLow 아래에서 확정
    let boxOutsideClosePassed = false;
    let boxOutsidePrice: number | null = null;

    const checkClose = m5LastClose ?? (Array.isArray(candles1m) && candles1m.length >= 2 ? candles1m[candles1m.length - 1].close : lastPrice);
    boxOutsidePrice = checkClose;

    if (side === "long" && boxHigh > 0 && checkClose > boxHigh) {
        boxOutsideClosePassed = true;
    } else if (side === "short" && boxLow > 0 && checkClose < boxLow) {
        boxOutsideClosePassed = true;
    }

    // 조건 3: 1H / 4H macro polarity가 진입 방향과 일치
    const macroUpper = String(macroPolarity ?? "").toUpperCase();
    const h1Upper = String(htf1hBias ?? "").toUpperCase();
    const h4Upper = String(htf4hBias ?? "").toUpperCase();

    const isBullishMacro = macroUpper === "BULLISH" || h1Upper === "BULLISH" || h4Upper === "BULLISH";
    const isBearishMacro = macroUpper === "BEARISH" || h1Upper === "BEARISH" || h4Upper === "BEARISH";

    const macroPolarityPassed =
        (side === "long" && isBullishMacro && !isBearishMacro) ||
        (side === "short" && isBearishMacro && !isBullishMacro);

    // EXPEDITE 판정: 3조건 모두 충족 시에만 승인
    const expedited = volumeSurgePassed && boxOutsideClosePassed && macroPolarityPassed;

    const evidence = {
        volumeSurgePassed,
        volumeRatio,
        boxOutsideClosePassed,
        boxOutsidePrice,
        macroPolarityPassed,
        macroPolarity: macroPolarity ?? null,
        m5CandleConfirmed,
        m5LastClose,
        m5LastOpen,
        m5CandleCloseTime,
        m5CausalityPassed,
        ftsDetectedAt: ftsDetectedAt ?? null
    };

    if (expedited) {
        const proof = {
            event: "V2_FTS_EXPEDITE_PROOF",
            symbol,
            side,
            expedited: true,
            reason: "EXPEDITE_ALL_THREE_CONDITIONS_MET",
            evidence
        };
        console.info(JSON.stringify(proof));
        return {
            confirmed: true,
            expedited: true,
            reason: "EXPEDITE_ALL_THREE_CONDITIONS_MET",
            blockReason: null,
            evidence
        };
    }

    if (m5CandleConfirmed) {
        return {
            confirmed: true,
            expedited: false,
            reason: "FTS_5M_CANDLE_CONFIRMED",
            blockReason: null,
            evidence
        };
    }

    // 미충족 -> FTS_CONFIRMATION_PENDING
    const proof = {
        event: "V2_FTS_EXPEDITE_PROOF",
        symbol,
        side,
        expedited: false,
        reason: "FTS_CONFIRMATION_PENDING",
        evidence
    };
    console.info(JSON.stringify(proof));

    return {
        confirmed: false,
        expedited: false,
        reason: "FTS_CONFIRMATION_PENDING",
        blockReason: "FTS_CONFIRMATION_PENDING",
        evidence
    };
}
