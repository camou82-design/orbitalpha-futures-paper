import type { PaperCandidateStrength, PaperSignal } from "./entry-signal";
import type { FuturesMarketMode } from "./live-market-mode";
import { btcBiasFromModeDetail } from "./live-market-mode";

export type PositionDirection = "long" | "short" | "none";

/** 최소 품질 점수 — 진입 파이프라인·방향 결정 공통 하한 (수수료 대비 애매한 진입 감소). */
export const ENTRY_MIN_SCORE = 62;
/** 횡보 모드에서 weak 후보는 더 높은 점수 요구. */
const SIDEWAYS_WEAK_MIN_SCORE = 68;
const STRONG_SCORE = 72;
/** 횡보에서 EMA 분리가 너무 작으면 애매한 구간으로 진입 차단 (|ema20-ema60|/ema60). */
const SIDEWAYS_MIN_EMA_REL_SEP = 0.0028;

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
}>): EntryPolicyResult {
  if (input.direction === "none") {
    return { ok: false, blockMessage: "blocked_no_structure", detail: { reason: "direction_none" } };
  }

  if (input.signalStrengthScore < ENTRY_MIN_SCORE) {
    return {
      ok: false,
      blockMessage: "blocked_low_signal",
      detail: { signal_strength_score: input.signalStrengthScore, floor: ENTRY_MIN_SCORE }
    };
  }

  const e20 = input.ema20;
  const e60 = input.ema60;
  const cl = input.latestCandleClose;
  if (e20 === null || e60 === null || !Number.isFinite(e20) || !Number.isFinite(e60)) {
    return { ok: false, blockMessage: "blocked_no_structure", detail: { sub: "ema_missing" } };
  }

  const emaRelSep = Math.abs((e20 - e60) / e60);

  const emaAlignedLong = e20 > e60 * 1.0002 && cl >= e20 * 0.998;
  const emaAlignedShort = e20 < e60 * 0.9998 && cl <= e20 * 1.002;
  const pullbackLong = cl <= e20 * 1.01;
  const pullbackShort = cl >= e20 * 0.99;
  const chaseLong = input.lastPrice > e20 * 1.012;
  const chaseShort = input.lastPrice < e20 * 0.988;

  if (input.mode === "sideways" && emaRelSep < SIDEWAYS_MIN_EMA_REL_SEP) {
    return {
      ok: false,
      blockMessage: "blocked_no_structure",
      detail: { sub: "sideways_ema_too_flat", ema_rel_sep: emaRelSep, min: SIDEWAYS_MIN_EMA_REL_SEP }
    };
  }

  if (input.mode === "trend") {
    if (input.direction === "long" && !emaAlignedLong) {
      return { ok: false, blockMessage: "blocked_no_structure", detail: { sub: "ema_long_not_aligned" } };
    }
    if (input.direction === "short" && !emaAlignedShort) {
      return { ok: false, blockMessage: "blocked_no_structure", detail: { sub: "ema_short_not_aligned" } };
    }
    if (input.volumeRatioProxy < 0.95) {
      return { ok: false, blockMessage: "blocked_no_structure", detail: { sub: "volume_too_thin" } };
    }
    return {
      ok: true,
      detail: {
        pullback_ok: input.direction === "long" ? pullbackLong : pullbackShort,
        rebreak_ok: true,
        ema_aligned: true
      }
    };
  }

  if (input.mode === "sideways") {
    if (input.volumeRatioProxy > 2.8) {
      return {
        ok: false,
        blockMessage: "blocked_no_structure",
        detail: { sub: "volume_overheated_sideways", volume_ratio_proxy: input.volumeRatioProxy }
      };
    }
    if (input.direction === "long" && chaseLong && input.candidateStrength !== "weak") {
      return { ok: false, blockMessage: "blocked_sideways_chase", detail: { side: "long" } };
    }
    if (input.direction === "short" && chaseShort && input.candidateStrength !== "weak") {
      return { ok: false, blockMessage: "blocked_sideways_chase", detail: { side: "short" } };
    }
    if (input.direction === "long" && !pullbackLong) {
      return { ok: false, blockMessage: "blocked_no_structure", detail: { sub: "sideways_long_not_near_ema" } };
    }
    if (input.direction === "short" && !pullbackShort) {
      return { ok: false, blockMessage: "blocked_no_structure", detail: { sub: "sideways_short_not_near_ema" } };
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
      detail: { signal_strength_score: input.signalStrengthScore }
    };
  }

  if (input.volumeRatioProxy < 1.0) {
    return { ok: false, blockMessage: "blocked_no_structure", detail: { sub: "risk_off_need_volume" } };
  }
  if (!emaAlignedShort && input.signalStrengthScore < STRONG_SCORE) {
    return { ok: false, blockMessage: "blocked_no_structure", detail: { sub: "risk_off_short_structure" } };
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
      return { sizeUsd: Math.max(1, input.baseSizeUsd * 0.5), leverageMultiplier: 0.75 };
    case "risk_off":
      return { sizeUsd: Math.max(1, input.baseSizeUsd * 0.25), leverageMultiplier: 0.5 };
    default:
      return { sizeUsd: input.baseSizeUsd, leverageMultiplier: 1 };
  }
}
