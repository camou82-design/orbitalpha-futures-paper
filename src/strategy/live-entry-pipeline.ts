import type { PaperSignal } from "./entry-signal";
import type { PaperCandidateStrength } from "./entry-signal";
import type { FuturesMarketMode } from "./live-market-mode";
import {
  calculatePositionSize,
  decidePositionDirection,
  evaluateEntryPolicy,
  type PositionDirection
} from "./live-entry-policy";

/** RANGE Stage1 실행기 소프트 이후 adaptive 1차 실패 시, 최종 명목에 한 번 더 곱함(아주 소액 탐색). */
const STAGE1_RANGE_ADAPTIVE_SOFT_EXTRA_SIZE_MULT = 0.28;
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
    /** 페이퍼 파이프라인 고정 분기 코드 (거래소 주문 초안 없음 — 정책/사이즈 실패). */
    orderBuildFailReason: string;
    failStage: "entry_policy" | "adaptive_sizing";
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
  /**
   * RANGE·Stage1·실행기 소프트 탐색 경로에서만: adaptive `policy_direction_none` /
   * `policy_sideways_ema_too_flat` 을 소액 탐색 진입으로 완화(Stage2/3에는 전달 금지).
   */
  stage1RangeAdaptiveSoftExplore?: boolean;
  /** TREND: `evaluateEntryPolicy` 볼륨 하한 덮어쓰기 (Highway strong 완화 등). */
  trendVolumeRatioMinOverride?: number | null;
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

  const policyBase = {
    mode: input.mode,
    signalStrengthScore: input.snap.qualityScore,
    candidateStrength: input.snap.candidateStrength,
    ema20: input.snap.ema20,
    ema60: input.snap.ema60,
    latestCandleClose: input.snap.latestCandleClose,
    lastPrice: input.snap.lastPrice,
    volumeRatioProxy: input.snap.volumeRatioProxy
  } as const;

  let policy = evaluateEntryPolicy({
    ...policyBase,
    direction,
    sidewaysStage1SoftSkipEmaRelSep: false,
    trendVolumeRatioMinOverride: input.trendVolumeRatioMinOverride ?? null
  });

  let stage1AdaptiveSoftExplore: "direction_none" | "ema_flat" | null = null;

  if (
    !policy.ok &&
    input.stage1RangeAdaptiveSoftExplore === true &&
    input.mode === "sideways"
  ) {
    const r = policy.detail.order_build_fail_reason;
    if (r === "policy_direction_none") {
      const fd: PositionDirection =
        input.snap.signal === "paper_long_candidate"
          ? "long"
          : input.snap.signal === "paper_short_candidate"
            ? "short"
            : "none";
      if (fd !== "none") {
        policy = evaluateEntryPolicy({
          ...policyBase,
          direction: fd,
          sidewaysStage1SoftSkipEmaRelSep: true,
          trendVolumeRatioMinOverride: input.trendVolumeRatioMinOverride ?? null
        });
        if (policy.ok) {
          stage1AdaptiveSoftExplore = "direction_none";
        }
      }
    } else if (r === "policy_sideways_ema_too_flat" && direction !== "none") {
      policy = evaluateEntryPolicy({
        ...policyBase,
        direction,
        sidewaysStage1SoftSkipEmaRelSep: true,
        trendVolumeRatioMinOverride: input.trendVolumeRatioMinOverride ?? null
      });
      if (policy.ok) {
        stage1AdaptiveSoftExplore = "ema_flat";
      }
    }
  }

  if (!policy.ok) {
    const orderBuildFailReason =
      typeof policy.detail.order_build_fail_reason === "string"
        ? policy.detail.order_build_fail_reason
        : "policy_unknown";
    return {
      ok: false,
      logMessage: policy.blockMessage,
      orderBuildFailReason,
      failStage: "entry_policy",
      detail: {
        mode: input.mode,
        direction,
        symbol: input.snap.symbol,
        signal_strength_score: input.snap.qualityScore,
        block_message: policy.blockMessage,
        ...policy.detail
      }
    };
  }

  const dirSide: "long" | "short" =
    stage1AdaptiveSoftExplore === "direction_none"
      ? input.snap.signal === "paper_long_candidate"
        ? "long"
        : "short"
      : (direction as "long" | "short");
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
    baseSizeUsdCap: Math.max(modeSizing.sizeUsd, input.baseSizeUsd * 2),
    volumeRatioProxy: input.snap.volumeRatioProxy
  });

  if (adaptive.blocked) {
    const orderBuildFailReason =
      typeof adaptive.detail.order_build_fail_reason === "string"
        ? adaptive.detail.order_build_fail_reason
        : adaptive.blockReason === "position_size_blocked_low_confidence"
          ? "size_blocked_low_confidence"
          : "size_blocked_unknown";
    return {
      ok: false,
      logMessage: adaptive.blockReason ?? "position_size_blocked_low_confidence",
      orderBuildFailReason,
      failStage: "adaptive_sizing",
      detail: {
        mode: input.mode,
        direction,
        symbol: input.snap.symbol,
        signal_strength_score: input.snap.qualityScore,
        confidence_score: confidence.confidenceScore,
        confidence_tier: confidence.confidenceTier,
        block_reason: adaptive.blockReason,
        ...confidence.detail,
        ...adaptive.detail
      }
    };
  }

  const softMult =
    stage1AdaptiveSoftExplore !== null ? STAGE1_RANGE_ADAPTIVE_SOFT_EXTRA_SIZE_MULT : 1;
  const finalPositionSizeUsd = Math.max(1, adaptive.finalPositionSize * softMult);

  return {
    ok: true,
    direction: dirSide,
    sizeUsd: finalPositionSizeUsd,
    leverageMultiplier: modeSizing.leverageMultiplier,
    detail: {
      mode: input.mode,
      direction,
      effective_direction: dirSide,
      symbol: input.snap.symbol,
      signal_strength_score: input.snap.qualityScore,
      ema_gap: input.snap.emaGap,
      candidate_strength: input.snap.candidateStrength,
      volume_ratio_proxy: input.snap.volumeRatioProxy,
      confidence_score: confidence.confidenceScore,
      confidence_tier: confidence.confidenceTier,
      confidence_detail: confidence.detail,
      size_multiplier: adaptive.sizeMultiplier,
      final_position_size_usd: finalPositionSizeUsd,
      adaptive_sizing_detail: adaptive.detail,
      ...policy.detail,
      ...(stage1AdaptiveSoftExplore !== null
        ? {
          /** RANGE Stage1: policy_direction_none / policy_sideways_ema_too_flat 소액 강제 진입 */
          stage1_adaptive_force_enter: stage1AdaptiveSoftExplore,
          stage1_adaptive_soft_explore: stage1AdaptiveSoftExplore,
          stage1_adaptive_soft_extra_size_mult: STAGE1_RANGE_ADAPTIVE_SOFT_EXTRA_SIZE_MULT
        }
        : {})
    }
  };
}
