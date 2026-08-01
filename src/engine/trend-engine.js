"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stepTrendBreakoutHold = stepTrendBreakoutHold;
exports.evaluatePyramidLevel = evaluatePyramidLevel;
exports.trendPyramidAllowsScaleIn = trendPyramidAllowsScaleIn;
exports.trendPyramidSizeUplift = trendPyramidSizeUplift;
exports.planTrendSwitch = planTrendSwitch;
exports.evaluateTrendEngineForSymbol = evaluateTrendEngineForSymbol;
function finite(n, fallback = 0) {
    return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}
function bandPos(mark, upper, lower) {
    if (mark > upper)
        return "above";
    if (mark < lower)
        return "below";
    return "inside";
}
/**
 * 돌파 유지 / 실패(박스 복귀) / 재돌파.
 */
function stepTrendBreakoutHold(input) {
    const { mark, upper, lower } = input;
    const pos = bandPos(mark, upper, lower);
    const prev = input.prior ?? {
        bandPos: "inside",
        lastFailedFrom: null,
        rebreakArm: false
    };
    let holdState = "none";
    let label = "박스 내부 구간";
    let lastFailedFrom = prev.lastFailedFrom;
    let rebreakArm = prev.rebreakArm;
    if (pos === "inside") {
        if (prev.bandPos === "above") {
            holdState = "failed";
            label = "상단 돌파 실패(가격 박스 복귀)";
            lastFailedFrom = "up";
            rebreakArm = true;
        }
        else if (prev.bandPos === "below") {
            holdState = "failed";
            label = "하단 돌파 실패(가격 박스 복귀)";
            lastFailedFrom = "down";
            rebreakArm = true;
        }
        else {
            holdState = "none";
        }
    }
    else if (pos === "above") {
        if (rebreakArm && lastFailedFrom === "up") {
            holdState = "rebreak";
            label = "상단 재돌파(이전 상단 돌파 실패 후)";
            rebreakArm = false;
            lastFailedFrom = null;
        }
        else if (prev.bandPos === "inside" || prev.bandPos === "below") {
            holdState = "hold";
            label = prev.bandPos === "below" ? "하단 이탈 후 상단 돌파(반전 시도)" : "상단 돌파 확인";
            if (prev.bandPos === "inside")
                rebreakArm = false;
        }
        else {
            holdState = "hold";
            label = "상단 돌파 유지";
        }
    }
    else {
        /* below */
        if (rebreakArm && lastFailedFrom === "down") {
            holdState = "rebreak";
            label = "하단 재돌파(이전 하단 돌파 실패 후)";
            rebreakArm = false;
            lastFailedFrom = null;
        }
        else if (prev.bandPos === "inside" || prev.bandPos === "above") {
            holdState = "hold";
            label = prev.bandPos === "above" ? "상단 이탈 후 하단 돌파(반전 시도)" : "하단 돌파 확인";
            if (prev.bandPos === "inside")
                rebreakArm = false;
        }
        else {
            holdState = "hold";
            label = "하단 돌파 유지";
        }
    }
    const memory = {
        bandPos: pos,
        lastFailedFrom,
        rebreakArm
    };
    return { holdState, label, memory };
}
/**
 * 추세 지속 시 피라미드 단계(증액 판단 입력).
 */
function evaluatePyramidLevel(input) {
    const aligned = (input.positionSide === "long" && input.breakoutDirection === "up") ||
        (input.positionSide === "short" && input.breakoutDirection === "down");
    if (aligned && input.trendFollowScore >= 0.62) {
        return Math.min(4, input.prior + 1);
    }
    if (input.trendFollowScore < 0.38) {
        return Math.max(0, input.prior - 1);
    }
    return input.prior;
}
/** 추세 지속 점수·단계로 증액(scale-in) 허용 여부(TREND 전용). */
function trendPyramidAllowsScaleIn(trendFollowScore, pyramidLevel) {
    const relax = Math.max(0, trendFollowScore - 0.62) * 0.22;
    if (pyramidLevel <= 0)
        return trendFollowScore >= 0.56 - relax;
    return trendFollowScore >= 0.5 - relax;
}
/** 피라미드·추세 강도를 증액 USD 배수로 직결. */
function trendPyramidSizeUplift(pyramidLevel, trendFollowScore, breakoutConfidence) {
    const p = Math.min(4, Math.max(0, pyramidLevel));
    let m = 1 + 0.12 * p;
    m += Math.max(0, trendFollowScore - 0.55) * 0.42;
    m += Math.max(0, breakoutConfidence - 0.45) * 0.18;
    return Math.min(1.45, m);
}
/**
 * 반대 돌파 시 청산+역신규를 한 계획으로 표현(실행은 오케스트레이터에서 2레그로 기록).
 */
function planTrendSwitch(trend, openSide) {
    if (!trend.switchEligible || !trend.switchCloseSide || !trend.switchOpenSide) {
        return {
            execute: false,
            closeSide: null,
            openSide: null,
            reasonLabel: "스위칭 조건 미충족"
        };
    }
    if (trend.switchCloseSide !== openSide) {
        return {
            execute: false,
            closeSide: null,
            openSide: null,
            reasonLabel: "현재 포지션 방향과 청산 대상 불일치"
        };
    }
    return {
        execute: true,
        closeSide: trend.switchCloseSide,
        openSide: trend.switchOpenSide,
        reasonLabel: trend.trendSwitchReasonLabel
    };
}
/**
 * 수렴·돌파·스위칭. breakoutUpper/Lower는 entry±ATR 기준선.
 */
function evaluateTrendEngineForSymbol(input) {
    const atr = input.atr != null && finite(input.atr, 0) > 0 ? finite(input.atr, 0) : input.mark * 0.002;
    const compressionScore = finite(input.marketMode.trendConfidence * (1 - Math.min(1, atr / Math.max(input.mark, 1e-9))));
    const breakoutUpper = input.entryPrice + atr;
    const breakoutLower = input.entryPrice - atr;
    let breakoutDirection = "none";
    if (input.mark > breakoutUpper)
        breakoutDirection = "up";
    else if (input.mark < breakoutLower)
        breakoutDirection = "down";
    const hold = stepTrendBreakoutHold({
        mark: input.mark,
        upper: breakoutUpper,
        lower: breakoutLower,
        prior: input.holdMemoryPrior
    });
    const breakoutConfidence = finite(input.marketMode.trendConfidence * (breakoutDirection === "none" ? 0.35 : 0.85));
    const trendFollowScore = finite(input.marketMode.trendConfidence * 0.9 + compressionScore * 0.1);
    const pri = input.priorBreakoutDirection;
    const opposed = (pri === "up" && breakoutDirection === "down") || (pri === "down" && breakoutDirection === "up");
    /** 성급한 노이즈 반전 방지: 반대 밴드 밖 확인(hold/rebreak) + 점수 하한. */
    const oppositeBreakoutConfirmed = hold.holdState === "hold" || hold.holdState === "rebreak";
    const routingTrend = input.marketMode.routing.activeEngine === "TREND" || input.marketMode.marketMode === "MIXED";
    const speedBoost = Math.max(0, trendFollowScore - 0.62) * 0.38 +
        (hold.holdState === "rebreak" ? 0.09 : 0) +
        (breakoutConfidence >= 0.58 ? 0.04 : 0);
    const minTf = Math.max(0.47, 0.52 - speedBoost * 0.14);
    const minBc = Math.max(0.36, 0.42 - speedBoost * 0.11);
    const switchEligible = opposed &&
        breakoutDirection !== "none" &&
        oppositeBreakoutConfirmed &&
        trendFollowScore >= minTf &&
        breakoutConfidence >= minBc &&
        routingTrend &&
        (input.marketMode.marketMode === "TREND" ||
            input.marketMode.marketMode === "MIXED" ||
            input.marketMode.marketMode === "TRANSITION");
    let switchCloseSide = null;
    let switchOpenSide = null;
    if (switchEligible) {
        if (breakoutDirection === "up") {
            switchCloseSide = "short";
            switchOpenSide = "long";
        }
        else {
            switchCloseSide = "long";
            switchOpenSide = "short";
        }
    }
    const pyramidLevel = input.positionSide != null
        ? evaluatePyramidLevel({
            prior: input.pyramidLevelPrior,
            trendFollowScore,
            breakoutDirection,
            positionSide: input.positionSide
        })
        : input.pyramidLevelPrior;
    const trendSwitchReasonLabel = switchEligible
        ? `반대 돌파 확인 후 전환 · ${hold.label}`
        : "스위칭 조건 미충족";
    return {
        compressionScore,
        breakoutUpper,
        breakoutLower,
        breakoutDirection,
        breakoutConfidence,
        trendFollowScore,
        breakoutHoldState: hold.holdState,
        breakoutHoldLabel: hold.label,
        switchEligible,
        pyramidLevel,
        switchCloseSide,
        switchOpenSide,
        trendSwitchReasonLabel,
        holdMemory: hold.memory
    };
}
