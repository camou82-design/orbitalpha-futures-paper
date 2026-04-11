import type { Candle, PaperRegimeState } from "../models/types";
import { atrWilderLast } from "./entry-gate";

export type MarketRegime = "RANGE" | "TREND" | "NO_TRADE";

/** 레짐 결정 단일 로그 (엔진·대시보드용). */
export type RegimeDecisionLog = Readonly<{
  regime_raw: MarketRegime;
  regime_final: MarketRegime;
  no_trade_reason: string | null;
  unknown_reason: string | null;
  data_ready: boolean;
  dump_protection_hit: boolean;
  volatility_guard_hit: boolean;
}>;

export type MarketRegimeDetection = Readonly<{
  regime: MarketRegime;
  isAmbiguous: boolean;
  detail: Record<string, unknown>;
  log: RegimeDecisionLog;
}>;

/** 최소 5m 봉 개수: 미만이면 NO_TRADE(필수 데이터 부족). 30~49는 RANGE/TREND+ambiguous로 탐색 허용. */
export const MIN_BTC_5M_BARS_REGIME = 30;

function makeLog(p: {
  regimeRaw: MarketRegime;
  regimeFinal: MarketRegime;
  noTradeReason: string | null;
  unknownReason: string | null;
  dataReady: boolean;
  dumpHit: boolean;
  volHit: boolean;
}): RegimeDecisionLog {
  return {
    regime_raw: p.regimeRaw,
    regime_final: p.regimeFinal,
    no_trade_reason: p.noTradeReason,
    unknown_reason: p.unknownReason,
    data_ready: p.dataReady,
    dump_protection_hit: p.dumpHit,
    volatility_guard_hit: p.volHit
  };
}

/** 엔진 기동 전 스냅샷용 (첫 runOnce 전). */
export const INITIAL_ENGINE_REGIME: MarketRegimeDetection = {
  regime: "NO_TRADE",
  isAmbiguous: false,
  detail: { reason: "engine_init" },
  log: {
    regime_raw: "NO_TRADE",
    regime_final: "NO_TRADE",
    no_trade_reason: null,
    unknown_reason: null,
    data_ready: false,
    dump_protection_hit: false,
    volatility_guard_hit: false
  }
};

/** BTC 캔들 피드 실패 시 전용 NO_TRADE (거래소/피드 이상). */
export function regimeWhenBtcFeedFailed(errorMessage: string): MarketRegimeDetection {
  return {
    regime: "NO_TRADE",
    isAmbiguous: false,
    detail: { reason: "btc_candles_fetch_failed", error: errorMessage },
    log: makeLog({
      regimeRaw: "NO_TRADE",
      regimeFinal: "NO_TRADE",
      noTradeReason: "btc_candles_fetch_failed",
      unknownReason: null,
      dataReady: false,
      dumpHit: false,
      volHit: false
    })
  };
}

function emaLast(closes: readonly number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes[0]!;
  for (let i = 1; i < closes.length; i++) e = closes[i]! * k + e * (1 - k);
  return e;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Market regime detector (paper futures).
 *
 * - NO_TRADE: 필수 데이터 부족, 지표 계산 실패, 덤프/비정상 변동 보호만 (진짜 위험·오류).
 * - 그 외 불명확·스코어 경계는 TREND 또는 RANGE + isAmbiguous 로 내려 Stage 1 탐색에 포함.
 */
export function detectMarketRegime(input: Readonly<{ btcCandles5m: readonly Candle[] }>): MarketRegimeDetection {
  const c = input.btcCandles5m;
  const len = c.length;

  if (len < MIN_BTC_5M_BARS_REGIME) {
    return {
      regime: "NO_TRADE",
      isAmbiguous: false,
      detail: { reason: "insufficient_btc_5m", len, min_required: MIN_BTC_5M_BARS_REGIME },
      log: makeLog({
        regimeRaw: "NO_TRADE",
        regimeFinal: "NO_TRADE",
        noTradeReason: "insufficient_btc_5m",
        unknownReason: "insufficient_btc_5m",
        dataReady: false,
        dumpHit: false,
        volHit: false
      })
    };
  }

  const marginalHistory = len < 50;

  // Use only completed candles for stability.
  const completed = c.slice(0, -1);
  const closes = completed.map((x) => x.close);
  const last = closes[closes.length - 1]!;

  const e20 = emaLast(closes.slice(-80), 20);
  const e60 = emaLast(closes.slice(-140), Math.min(60, closes.length));

  if (e20 === null || e60 === null || !Number.isFinite(last) || last <= 0) {
    return {
      regime: "NO_TRADE",
      isAmbiguous: false,
      detail: { reason: "ema_not_ready_or_bad_price", len },
      log: makeLog({
        regimeRaw: "NO_TRADE",
        regimeFinal: "NO_TRADE",
        noTradeReason: "ema_not_ready_or_bad_price",
        unknownReason: null,
        dataReady: false,
        dumpHit: false,
        volHit: false
      })
    };
  }
  const bias: "up" | "down" | "flat" = e20 > e60 * 1.0012 ? "up" : e20 < e60 * 0.9988 ? "down" : "flat";

  const atr = atrWilderLast(completed.slice(-80), 14);
  const atrRel = atr !== null && atr > 0 ? atr / last : 0;

  const lookback = completed.slice(-24);
  const hi = Math.max(...lookback.map((x) => x.high));
  const lo = Math.min(...lookback.map((x) => x.low));
  const boxRel = (hi - lo) / (last + 1e-9);

  const emaSepRel = Math.abs(e20 - e60) / (last + 1e-9);
  const e20Prev = emaLast(closes.slice(-100, -20), 20);
  const slopeRel = e20Prev !== null ? (e20 - e20Prev) / (last + 1e-9) : 0;

  let inside = 0;
  for (const x of lookback) {
    if (x.close <= hi * 1.0005 && x.close >= lo * 0.9995) inside += 1;
  }
  const insideRatio = lookback.length > 0 ? inside / lookback.length : 0;

  const drop5 =
    closes.length >= 6 ? (closes[closes.length - 1]! - closes[closes.length - 6]!) / closes[closes.length - 6]! : 0;
  const drop12 =
    closes.length >= 13
      ? (closes[closes.length - 1]! - closes[closes.length - 13]!) / closes[closes.length - 13]!
      : 0;

  const volTooHigh = atrRel > 0.0105 || boxRel > 0.035;
  const dumpRisk = drop5 < -0.013 || drop12 < -0.022;

  if (dumpRisk || volTooHigh) {
    const reason = dumpRisk ? "dump_risk" : "vol_too_high";
    return {
      regime: "NO_TRADE",
      isAmbiguous: false,
      detail: {
        reason,
        atr_rel: atrRel,
        box_rel: boxRel,
        drop5,
        drop12,
        ema_sep_rel: emaSepRel,
        slope_rel: slopeRel,
        inside_ratio: insideRatio,
        bias,
        len
      },
      log: makeLog({
        regimeRaw: "NO_TRADE",
        regimeFinal: "NO_TRADE",
        noTradeReason: reason,
        unknownReason: null,
        dataReady: true,
        dumpHit: dumpRisk,
        volHit: !dumpRisk && volTooHigh
      })
    };
  }

  const sepScore = clamp01((emaSepRel - 0.0025) / 0.0045);
  const slopeScore = clamp01((Math.abs(slopeRel) - 0.0006) / 0.0014);
  const boxScore = clamp01((boxRel - 0.015) / 0.02);
  const trendScore = 0.45 * sepScore + 0.35 * slopeScore + 0.2 * boxScore;

  const tightScore = clamp01((0.020 - boxRel) / 0.010);
  const insideScore = clamp01((insideRatio - 0.70) / 0.25);
  const flatSepScore = clamp01((0.0036 - emaSepRel) / 0.0022);
  const rangeScore = 0.45 * tightScore + 0.35 * insideScore + 0.2 * flatSepScore;

  const isAmbiguousLength = len < 60;
  const forceAmbiguousMarginal = marginalHistory;
  const ambiguousFlag = isAmbiguousLength || forceAmbiguousMarginal;

  const baseDetail = (extra: Record<string, unknown>) => ({
    atr_rel: atrRel,
    box_rel: boxRel,
    ema20: e20,
    ema60: e60,
    ema_sep_rel: emaSepRel,
    slope_rel: slopeRel,
    inside_ratio: insideRatio,
    bias,
    trend_score: trendScore,
    range_score: rangeScore,
    len,
    ...(marginalHistory ? { marginal_history: true as const } : {}),
    ...extra
  });

  if (trendScore >= 0.62 && rangeScore < 0.55) {
    return {
      regime: "TREND",
      isAmbiguous: ambiguousFlag,
      detail: baseDetail({}),
      log: makeLog({
        regimeRaw: "TREND",
        regimeFinal: "TREND",
        noTradeReason: null,
        unknownReason: null,
        dataReady: true,
        dumpHit: false,
        volHit: false
      })
    };
  }

  if (rangeScore >= 0.60 && trendScore < 0.62) {
    return {
      regime: "RANGE",
      isAmbiguous: ambiguousFlag,
      detail: baseDetail({}),
      log: makeLog({
        regimeRaw: "RANGE",
        regimeFinal: "RANGE",
        noTradeReason: null,
        unknownReason: null,
        dataReady: true,
        dumpHit: false,
        volHit: false
      })
    };
  }

  const higherScoreRegime: PaperRegimeState = trendScore >= rangeScore ? "TREND" : "RANGE";
  const regimeOut = higherScoreRegime as MarketRegime;

  return {
    regime: regimeOut,
    isAmbiguous: true,
    detail: baseDetail({
      reason: "ambiguous_context",
      trend_score: trendScore,
      range_score: rangeScore
    }),
    log: makeLog({
      regimeRaw: regimeOut,
      regimeFinal: regimeOut,
      noTradeReason: null,
      unknownReason: null,
      dataReady: true,
      dumpHit: false,
      volHit: false
    })
  };
}
