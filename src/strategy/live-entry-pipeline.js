"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runFuturesAdaptiveEntry = runFuturesAdaptiveEntry;
const live_entry_policy_1 = require("./live-entry-policy");
/** RANGE Stage1 실행기 소프트 이후 adaptive 1차 실패 시, 최종 명목에 한 번 더 곱함(아주 소액 탐색). */
const STAGE1_RANGE_ADAPTIVE_SOFT_EXTRA_SIZE_MULT = 0.28;
const live_trade_confidence_1 = require("./live-trade-confidence");
const live_position_sizing_1 = require("./live-position-sizing");
/**
 * 1) 방향 2) 정책 3) 사이즈 — 통과 시에만 주문(페이퍼 오픈) 호출.
 */
function runFuturesAdaptiveEntry(input) {
    const relaxProofBag = input.trendVolumeRelaxProof != null ? { trend_volume_relax_proof: input.trendVolumeRelaxProof } : {};
    const direction = (0, live_entry_policy_1.decidePositionDirection)({
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
        volumeRatioProxy: input.snap.volumeRatioProxy,
        trendEmaSoftGate: input.trendEmaSoftGate === true
    };
    let policy = (0, live_entry_policy_1.evaluateEntryPolicy)({
        ...policyBase,
        direction,
        sidewaysStage1SoftSkipEmaRelSep: false,
        trendVolumeRatioMinOverride: input.trendVolumeRatioMinOverride ?? null
    });
    let stage1AdaptiveSoftExplore = null;
    if (!policy.ok &&
        input.stage1RangeAdaptiveSoftExplore === true &&
        input.mode === "sideways") {
        const r = policy.detail.order_build_fail_reason;
        if (r === "policy_direction_none") {
            const fd = input.snap.signal === "paper_long_candidate"
                ? "long"
                : input.snap.signal === "paper_short_candidate"
                    ? "short"
                    : "none";
            if (fd !== "none") {
                policy = (0, live_entry_policy_1.evaluateEntryPolicy)({
                    ...policyBase,
                    direction: fd,
                    sidewaysStage1SoftSkipEmaRelSep: true,
                    trendVolumeRatioMinOverride: input.trendVolumeRatioMinOverride ?? null
                });
                if (policy.ok) {
                    stage1AdaptiveSoftExplore = "direction_none";
                }
            }
        }
        else if (r === "policy_sideways_ema_too_flat" && direction !== "none") {
            policy = (0, live_entry_policy_1.evaluateEntryPolicy)({
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
        const orderBuildFailReason = typeof policy.detail.order_build_fail_reason === "string"
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
                ...relaxProofBag,
                ...policy.detail
            }
        };
    }
    const dirSide = stage1AdaptiveSoftExplore === "direction_none"
        ? input.snap.signal === "paper_long_candidate"
            ? "long"
            : "short"
        : direction;
    const confidence = (0, live_trade_confidence_1.buildTradeConfidenceScore)({
        mode: input.mode,
        direction: dirSide,
        signalStrengthScore: input.snap.qualityScore,
        entryPolicyDetail: policy.detail,
        volumeRatioProxy: input.snap.volumeRatioProxy,
        modeDetail: input.modeDetail
    });
    const modeSizing = (0, live_entry_policy_1.calculatePositionSize)({
        mode: input.mode,
        baseSizeUsd: input.baseSizeUsd
    });
    const adaptive = (0, live_position_sizing_1.calculateAdaptivePositionSize)({
        mode: input.mode,
        confidenceScore: confidence.confidenceScore,
        confidenceTier: confidence.confidenceTier,
        modeBaseSizeUsd: modeSizing.sizeUsd,
        modeLeverageMultiplier: modeSizing.leverageMultiplier,
        baseSizeUsdCap: Math.max(modeSizing.sizeUsd, input.baseSizeUsd * 2),
        volumeRatioProxy: input.snap.volumeRatioProxy
    });
    if (adaptive.blocked) {
        const orderBuildFailReason = typeof adaptive.detail.order_build_fail_reason === "string"
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
                ...relaxProofBag,
                ...confidence.detail,
                ...adaptive.detail
            }
        };
    }
    const softMult = stage1AdaptiveSoftExplore !== null ? STAGE1_RANGE_ADAPTIVE_SOFT_EXTRA_SIZE_MULT : 1;
    const finalPositionSizeUsd = Math.round(adaptive.finalPositionSize * softMult * 100) / 100;
    if (finalPositionSizeUsd < live_position_sizing_1.MIN_POSITION_SIZE_USD) {
        return {
            ok: false,
            logMessage: `size_below_min_after_soft_mult:${finalPositionSizeUsd}<${live_position_sizing_1.MIN_POSITION_SIZE_USD}`,
            orderBuildFailReason: "SIZE_FLOOR_BLOCK",
            failStage: "adaptive_sizing",
            detail: {
                mode: input.mode,
                direction,
                symbol: input.snap.symbol,
                signal_strength_score: input.snap.qualityScore,
                confidence_score: confidence.confidenceScore,
                confidence_tier: confidence.confidenceTier,
                ...relaxProofBag,
                ...confidence.detail,
                ...adaptive.detail,
                order_build_fail_reason: "SIZE_FLOOR_BLOCK",
                final_position_size_usd_after_soft_mult: finalPositionSizeUsd,
                min_position_size_usd: live_position_sizing_1.MIN_POSITION_SIZE_USD,
                stage1_adaptive_soft_extra_size_mult: softMult
            }
        };
    }
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
            ...relaxProofBag,
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
