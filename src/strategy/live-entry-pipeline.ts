import type { PaperSignal } from "./entry-signal";
import type { PaperCandidateStrength } from "./entry-signal";
import type { FuturesMarketMode } from "./live-market-mode";
import {
  calculatePositionSize,
  decidePositionDirection,
  evaluateEntryPolicy,
  type PositionDirection
} from "./live-entry-policy";
import { buildTradeConfidenceScore } from "./live-trade-confidence";
import { calculateAdaptivePositionSize } from "./live-position-sizing";

/** 스냅샷에서 적응형 진입 파이프라인 입력 (signal-monitor/entry-signal 산출 유지). */
export type FuturesAdaptiveSnapshot = Readonly<{
  symbol: string;
  signal: PaperSignal;
  lastPrice: number;
  latestCandleClose: number;
  ema20: number | null;
  ema60: number | null;
  qualityScore: number;
  candidateStrength: PaperCandidateStrength | null;
  emaGap: number | null;
  volumeRatioProxy: number;
}>;

export type FuturesAdaptiveEntryResult =
  | Readonly<{
      ok: true;
      direction: "long" | "short";
      sizeUsd: number;
      leverageMultiplier: number;
      detail: Record<string, unknown>;
    }>
  | Readonly<{
      ok: false;
      logMessage: string;
      detail: Record<string, unknown>;
    }>;

/**
 * 1) 방향 2) 정책 3) 사이즈 — 통과 시에만 주문(페이퍼 오픈) 호출.
 */
export function runFuturesAdaptiveEntry(input: Readonly<{
  mode: FuturesMarketMode;
  modeDetail: Record<string, unknown>;
  snap: FuturesAdaptiveSnapshot;
  baseSizeUsd: number;
}>): FuturesAdaptiveEntryResult {
  const direction: PositionDirection = decidePositionDirection({
    mode: input.mode,
    modeDetail: input.modeDetail,
    signal: input.snap.signal,
    signalStrengthScore: input.snap.qualityScore,
    candidateStrength: input.snap.candidateStrength,
    ema20: input.snap.ema20,
    ema60: input.snap.ema60,
    latestCandleClose: input.snap.latestCandleClose
  });

  const policy = evaluateEntryPolicy({
    mode: input.mode,
    direction,
    signalStrengthScore: input.snap.qualityScore,
    candidateStrength: input.snap.candidateStrength,
    ema20: input.snap.ema20,
    ema60: input.snap.ema60,
    latestCandleClose: input.snap.latestCandleClose,
    lastPrice: input.snap.lastPrice,
    volumeRatioProxy: input.snap.volumeRatioProxy
  });

  if (!policy.ok) {
    return {
      ok: false,
      logMessage: policy.blockMessage,
      detail: {
        mode: input.mode,
        direction,
        symbol: input.snap.symbol,
        signal_strength_score: input.snap.qualityScore,
        ...policy.detail
      }
    };
  }

  const dirSide = direction as "long" | "short";
  const confidence = buildTradeConfidenceScore({
    mode: input.mode,
    direction: dirSide,
    signalStrengthScore: input.snap.qualityScore,
    entryPolicyDetail: policy.detail,
    volumeRatioProxy: input.snap.volumeRatioProxy,
    modeDetail: input.modeDetail
  });

  const modeSizing = calculatePositionSize({
    mode: input.mode,
    baseSizeUsd: input.baseSizeUsd
  });

  const adaptive = calculateAdaptivePositionSize({
    mode: input.mode,
    confidenceScore: confidence.confidenceScore,
    confidenceTier: confidence.confidenceTier,
    modeBaseSizeUsd: modeSizing.sizeUsd,
    modeLeverageMultiplier: modeSizing.leverageMultiplier,
    baseSizeUsdCap: Math.max(modeSizing.sizeUsd, input.baseSizeUsd * 2)
  });

  if (adaptive.blocked) {
    return {
      ok: false,
      logMessage: adaptive.blockReason ?? "position_size_blocked_low_confidence",
      detail: {
        mode: input.mode,
        direction,
        symbol: input.snap.symbol,
        signal_strength_score: input.snap.qualityScore,
        confidence_score: confidence.confidenceScore,
        confidence_tier: confidence.confidenceTier,
        ...confidence.detail,
        ...adaptive.detail
      }
    };
  }

  return {
    ok: true,
    direction: dirSide,
    sizeUsd: adaptive.finalPositionSize,
    leverageMultiplier: modeSizing.leverageMultiplier,
    detail: {
      mode: input.mode,
      direction,
      symbol: input.snap.symbol,
      signal_strength_score: input.snap.qualityScore,
      ema_gap: input.snap.emaGap,
      candidate_strength: input.snap.candidateStrength,
      volume_ratio_proxy: input.snap.volumeRatioProxy,
      confidence_score: confidence.confidenceScore,
      confidence_tier: confidence.confidenceTier,
      confidence_detail: confidence.detail,
      size_multiplier: adaptive.sizeMultiplier,
      final_position_size_usd: adaptive.finalPositionSize,
      adaptive_sizing_detail: adaptive.detail,
      ...policy.detail
    }
  };
}
