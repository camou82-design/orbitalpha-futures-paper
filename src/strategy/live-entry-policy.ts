import type { PaperCandidateStrength, PaperSignal } from "./entry-signal";
import type { FuturesMarketMode } from "./live-market-mode";
import { btcBiasFromModeDetail } from "./live-market-mode";

export type PositionDirection = "long" | "short" | "none";

/** 최소 품질 점수 — 진입 파이프라인·방향 결정 공통 하한 (수수료 대비 애매한 진입 감소). */
export const ENTRY_MIN_SCORE = 35;
/** 횡보 모드에서 weak 후보는 더 높은 점수 요구. */
const SIDEWAYS_WEAK_MIN_SCORE = 72;
/** TREND BTC 역풍 완화·하이웨이 strong 연동 등과 동일 하한(72). */
export const STRONG_SCORE = 72;
/** TREND 모드 `evaluateEntryPolicy`: 최소 거래량 비율(스냅샷 `volumeRatioProxy`). trend-executor minVol(1.02)과 정렬. */
export const TREND_POLICY_MIN_VOLUME_RATIO_PROXY = 1.02;
/**
 * Stage1 TREND: 하이웨이 코어 VALID + strong 후보 완화 시 하한(여전히 neutral 이상).
 * `paper-symbol-decision`에서만 override로 전달.
 */
export const TREND_POLICY_MIN_VOLUME_RATIO_PROXY_HIGHWAY_STRONG_RELAX = 1.0;
/**
 * Stage1 TREND weak 후보: 하이웨이 동일 + 엣지(shortfall 없음·기대이동 있음·required_move 낮음) 시
 * strong(1.0)보다 완만한 하한 — `volumeRatioProxy`가 1.01~1.02 사이일 때만 체감.
 */
export const TREND_POLICY_MIN_VOLUME_RATIO_PROXY_HIGHWAY_WEAK_RELAX = 1.01;
/** weak 완화 최소 품질(Highway·엣지 보완 가정). */
export const TREND_VOLUME_RELAX_WEAK_MIN_QUALITY_SCORE = 65;
/** weak이어도 이 점수 이상이면 엣지 양호 시 볼륨 하한을 strong과 동일(1.0)으로 허용. */
export const TREND_VOLUME_RELAX_WEAK_QUALITY_FOR_STRONG_MIN = 70;
/** weak 완화: `required_move_pct`(유효비용×100) 상한 — 비용 부담 큰 틱 제외. */
export const TREND_VOLUME_RELAX_WEAK_MAX_REQUIRED_MOVE_PCT = 0.4;
/** 횡보에서 EMA 분리가 너무 작으면 애매한 구간으로 진입 차단 (|ema20-ema60|/ema60). */
const SIDEWAYS_MIN_EMA_REL_SEP = 0.0035;

/**
 * 시장 모드 + BTC 편향 + 후보 신호로 롱/숏/관망 결정.
 */
export function decidePositionDirection(input: Readonly<{
  mode: FuturesMarketMode;
  modeDetail: Record<string, unknown>;
  signal: PaperSignal;
  signalStrengthScore: number;
  candidateStrength: PaperCandidateStrength | null;
  ema20: number | null;
  ema60: number | null;
  latestCandleClose: number;
}>): PositionDirection {
  const btcB = btcBiasFromModeDetail(input.modeDetail);

  if (input.signal === "none") return "none";

  const wantLong = input.signal === "paper_long_candidate";
  const wantShort = input.signal === "paper_short_candidate";

  if (input.mode === "risk_off") {
    if (wantLong) {
      if (input.signalStrengthScore >= STRONG_SCORE && btcB === "up" && input.candidateStrength === "strong") {
        return "long";
      }
      return "none";
    }
    if (wantShort) return "short";
    return "none";
  }

  if (input.mode === "sideways") {
    /* BTC 5m 편향이 중립이면 횡보 구간에서 방향 진입 보류 */
    if (btcB === "flat") return "none";
    if (wantLong) {
      if (btcB === "down") return "none";
      if (input.candidateStrength === "weak") {
        return input.signalStrengthScore >= SIDEWAYS_WEAK_MIN_SCORE ? "long" : "none";
      }
      return input.signalStrengthScore >= ENTRY_MIN_SCORE ? "long" : "none";
    }
    if (wantShort) {
      if (btcB === "up") return "none";
      if (input.candidateStrength === "weak") {
        return input.signalStrengthScore >= SIDEWAYS_WEAK_MIN_SCORE ? "short" : "none";
      }
      return input.signalStrengthScore >= ENTRY_MIN_SCORE ? "short" : "none";
    }
  }

  /* trend — 약한 점수면 방향 자체를 주지 않음 */
  if (wantLong || wantShort) {
    if (input.signalStrengthScore < ENTRY_MIN_SCORE) return "none";
  }
  if (wantLong) {
    if (btcB === "down" && input.signalStrengthScore < STRONG_SCORE) return "none";
    return "long";
  }
  if (wantShort) {
    if (btcB === "up" && input.signalStrengthScore < STRONG_SCORE) return "none";
    return "short";
  }
  return "none";
}

export type EntryPolicyResult =
  | { ok: true; detail: Record<string, unknown> }
  | { ok: false; blockMessage: string; detail: Record<string, unknown> };

/**
 * 모드별 진입 허용 / 차단 (상위 레이어 — 후보 신호는 이미 통과했다고 가정).
 */
export function evaluateEntryPolicy(input: Readonly<{
  mode: FuturesMarketMode;
  direction: PositionDirection;
  signalStrengthScore: number;
  candidateStrength: PaperCandidateStrength | null;
  ema20: number | null;
  ema60: number | null;
  latestCandleClose: number;
  lastPrice: number;
  volumeRatioProxy: number;
  /** RANGE Stage1 소액 탐색 전용: sideways EMA 이격(`ema_rel_sep`) 하한만 통과 */
  sidewaysStage1SoftSkipEmaRelSep?: boolean;
  /**
   * TREND 볼륨 하한 덮어쓰기(기본 `TREND_POLICY_MIN_VOLUME_RATIO_PROXY`).
   * Highway VALID + trend_core_default + strong 후보 등에서만 낮춤.
   */
  trendVolumeRatioMinOverride?: number | null;
  /**
   * 상위 실행권(V2 ENTER + TREND)일 때: 미세 EMA 불일치·볼륨 하한을 soft(완화)로 처리하고 `trend_ema_soft_pass` 등으로 표시.
   */
  trendEmaSoftGate?: boolean;
}>): EntryPolicyResult {
  if (input.direction === "none") {
    return {
      ok: false,
      blockMessage: "blocked_no_structure",
      detail: { reason: "direction_none", order_build_fail_reason: "policy_direction_none" }
    };
  }

  if (input.signalStrengthScore < ENTRY_MIN_SCORE) {
    return {
      ok: false,
      blockMessage: "blocked_low_signal",
      detail: {
        signal_strength_score: input.signalStrengthScore,
        floor: ENTRY_MIN_SCORE,
        order_build_fail_reason: "policy_low_signal"
      }
    };
  }

  const e20 = input.ema20;
  const e60 = input.ema60;
  const cl = input.latestCandleClose;
  if (e20 === null || e60 === null || !Number.isFinite(e20) || !Number.isFinite(e60)) {
    return {
      ok: false,
      blockMessage: "blocked_no_structure",
      detail: { sub: "ema_missing", order_build_fail_reason: "policy_ema_missing" }
    };
  }

  const emaRelSep = Math.abs((e20 - e60) / e60);

  const emaAlignedLong = e20 > e60 * 1.0002 && cl >= e20 * 0.998;
  const emaAlignedShort = e20 < e60 * 0.9998 && cl <= e20 * 1.002;
  /** V2 soft gate: 약간 느슨한 스택·종가(상·하 대칭). */
  const emaNearAlignedLong = e20 > e60 * 1.00005 && cl >= e20 * 0.994;
  const emaNearAlignedShort = e20 < e60 * 0.99995 && cl <= e20 * 1.006;
  const pullbackLong = cl <= e20 * 1.01;
  const pullbackShort = cl >= e20 * 0.99;
  const chaseLong = input.lastPrice > e20 * 1.012;
  const chaseShort = input.lastPrice < e20 * 0.988;

  if (input.mode === "sideways" && emaRelSep < SIDEWAYS_MIN_EMA_REL_SEP && !input.sidewaysStage1SoftSkipEmaRelSep) {
    return {
      ok: false,
      blockMessage: "blocked_no_structure",
      detail: {
        sub: "sideways_ema_too_flat",
        ema_rel_sep: emaRelSep,
        min: SIDEWAYS_MIN_EMA_REL_SEP,
        order_build_fail_reason: "policy_sideways_ema_too_flat"
      }
    };
  }

  if (input.mode === "trend") {
    let trendEmaSoftPass = false;
    if (input.direction === "long") {
      if (!emaAlignedLong) {
        const soft = input.trendEmaSoftGate === true && emaNearAlignedLong;
        if (!soft) {
          return {
            ok: false,
            blockMessage: "blocked_no_structure",
            detail: { sub: "ema_long_not_aligned", order_build_fail_reason: "policy_trend_long_ema_not_aligned" }
          };
        }
        trendEmaSoftPass = true;
      }
    } else if (input.direction === "short") {
      if (!emaAlignedShort) {
        const soft = input.trendEmaSoftGate === true && emaNearAlignedShort;
        if (!soft) {
          return {
            ok: false,
            blockMessage: "blocked_no_structure",
            detail: { sub: "ema_short_not_aligned", order_build_fail_reason: "policy_trend_short_ema_not_aligned" }
          };
        }
        trendEmaSoftPass = true;
      }
    }
    const trendVolMin =
      typeof input.trendVolumeRatioMinOverride === "number" &&
      Number.isFinite(input.trendVolumeRatioMinOverride) &&
      input.trendVolumeRatioMinOverride > 0
        ? input.trendVolumeRatioMinOverride
        : TREND_POLICY_MIN_VOLUME_RATIO_PROXY;
    const trendVolFloor =
      input.trendEmaSoftGate === true ? Math.min(trendVolMin, 1.0) : trendVolMin;
    if (input.volumeRatioProxy < trendVolFloor) {
      return {
        ok: false,
        blockMessage: "blocked_no_structure",
        detail: {
          sub: "volume_too_thin",
          order_build_fail_reason: "policy_trend_volume_too_thin",
          entry_policy_proof: {
            proof_version: 1,
            policy_id: "trend_volume_ratio_gate",
            branch: "after_trend_ema_alignment_passes",
            min_volume_ratio_proxy: trendVolFloor,
            default_min_volume_ratio_proxy: TREND_POLICY_MIN_VOLUME_RATIO_PROXY,
            volume_ratio_proxy_actual: input.volumeRatioProxy,
            shortfall_ratio: trendVolFloor - input.volumeRatioProxy,
            trend_volume_min_override_applied: trendVolMin !== TREND_POLICY_MIN_VOLUME_RATIO_PROXY,
            trend_volume_floor_effective: trendVolFloor,
            trend_ema_soft_gate: input.trendEmaSoftGate === true,
            pipeline_order_in_runFuturesAdaptiveEntry: [
              "0_paper_symbol_decision: trend_volume_relax_proof (strong 72+ / weak 65+ with edge gates) → trendVolumeRatioMinOverride",
              "1_decidePositionDirection (qualityScore as signal strength, BTC bias, candidateStrength — not Highway volume_support_score)",
              "2_evaluateEntryPolicy: ENTRY_MIN_SCORE, EMA present, trend EMA align long/short, then volumeRatioProxy vs min",
              "3_buildTradeConfidenceScore (uses volumeRatioProxy again)",
              "4_calculateAdaptivePositionSize (may block on low confidence — separate failStage)"
            ],
            not_in_this_stage: {
              required_move_pct: "EDGE/cost gates in paper-symbol-decision before adaptive",
              shortfall_pct: "same upstream edge pipeline",
              same_dir_cooldown: "risk/reentry in paper-symbol-decision before executor/adaptive",
              volume_support_score:
                "Highway `evaluateAiHighwayQuality`; adaptive entry uses `snap.volumeRatioProxy` (1m candle-derived proxy, different formula)"
            }
          }
        }
      };
    }
    return {
      ok: true,
      detail: {
        pullback_ok: input.direction === "long" ? pullbackLong : pullbackShort,
        rebreak_ok: true,
        ema_aligned: !trendEmaSoftPass,
        trend_ema_soft_pass: trendEmaSoftPass,
        trend_volume_ratio_ok: input.volumeRatioProxy,
        trend_volume_min_used: trendVolMin,
        trend_volume_floor_effective: trendVolFloor
      }
    };
  }

  if (input.mode === "sideways") {
    /** vol >= 12.0: Extreme overheating (Hard block) */
    if (input.volumeRatioProxy >= 12.0) {
      return {
        ok: false,
        blockMessage: "blocked_no_structure",
        detail: {
          sub: "volume_extreme_overheated_sideways",
          volume_ratio_proxy: input.volumeRatioProxy,
          order_build_fail_reason: "policy_sideways_volume_overheated_extreme"
        }
      };
    }
    // Note: 2.5 ~ 12.0 구간은 감점 및 사이즈 축소 우선 (position-sizing & trade-confidence 에서 처리)
    if (input.direction === "long" && chaseLong && input.candidateStrength !== "weak") {
      return {
        ok: false,
        blockMessage: "blocked_sideways_chase",
        detail: { side: "long", order_build_fail_reason: "policy_sideways_chase_long" }
      };
    }
    if (input.direction === "short" && chaseShort && input.candidateStrength !== "weak") {
      return {
        ok: false,
        blockMessage: "blocked_sideways_chase",
        detail: { side: "short", order_build_fail_reason: "policy_sideways_chase_short" }
      };
    }
    if (input.direction === "long" && !pullbackLong) {
      return {
        ok: false,
        blockMessage: "blocked_no_structure",
        detail: { sub: "sideways_long_not_near_ema", order_build_fail_reason: "policy_sideways_long_not_near_ema" }
      };
    }
    if (input.direction === "short" && !pullbackShort) {
      return {
        ok: false,
        blockMessage: "blocked_no_structure",
        detail: { sub: "sideways_short_not_near_ema", order_build_fail_reason: "policy_sideways_short_not_near_ema" }
      };
    }
    return {
      ok: true,
      detail: { pullback_ok: true, rebreak_ok: true, sideways: true }
    };
  }

  /* risk_off — 롱은 decide + 강한 예외만 */
  if (input.direction === "long") {
    if (input.signalStrengthScore >= STRONG_SCORE) {
      return { ok: true, detail: { risk_off_long_exception: true, pullback_ok: pullbackLong, rebreak_ok: true } };
    }
    return {
      ok: false,
      blockMessage: "blocked_risk_off_long",
      detail: { signal_strength_score: input.signalStrengthScore, order_build_fail_reason: "policy_risk_off_long" }
    };
  }

  if (input.volumeRatioProxy < 1.0) {
    return {
      ok: false,
      blockMessage: "blocked_no_structure",
      detail: { sub: "risk_off_need_volume", order_build_fail_reason: "policy_risk_off_volume" }
    };
  }
  if (!emaAlignedShort && input.signalStrengthScore < STRONG_SCORE) {
    return {
      ok: false,
      blockMessage: "blocked_no_structure",
      detail: { sub: "risk_off_short_structure", order_build_fail_reason: "policy_risk_off_short_structure" }
    };
  }
  return { ok: true, detail: { risk_off_short: true, pullback_ok: pullbackShort, rebreak_ok: true } };
}

export function calculatePositionSize(input: Readonly<{
  mode: FuturesMarketMode;
  baseSizeUsd: number;
}>): Readonly<{ sizeUsd: number; leverageMultiplier: number }> {
  switch (input.mode) {
    case "trend":
      return { sizeUsd: input.baseSizeUsd, leverageMultiplier: 1 };
    case "sideways":
      return { sizeUsd: input.baseSizeUsd * 0.5, leverageMultiplier: 0.75 };
    case "risk_off":
      return { sizeUsd: input.baseSizeUsd * 0.25, leverageMultiplier: 0.5 };
    default:
      return { sizeUsd: input.baseSizeUsd, leverageMultiplier: 1 };
  }
}
