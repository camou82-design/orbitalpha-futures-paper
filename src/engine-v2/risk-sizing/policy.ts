import { EngineV2Input, ExecutorOutput, RiskSizingOutput, MarketJudgmentOutput, RegimeConfidenceOutput } from "../types";

/**
 * Tier 5: Risk & Sizing Policy (Refined)
 * Adjusts size based on regime and confidence.
 */
export function calculateRiskSizing(
    judgment: MarketJudgmentOutput,
    confidence: RegimeConfidenceOutput,
    executor: ExecutorOutput,
    input: EngineV2Input
): RiskSizingOutput & { diagnostics?: Record<string, number | string | boolean | null> } {
    const { config } = input;
    const { snapshot, state } = input;
    const baseSizeUsd = config.baseSizeUsd;
    let sizeMultiplier = executor.baseSizeIntent;
    let isBlocked = false;
    let blockReason: string | undefined;
    let leverageProfile: "BASE" | "BOOST_1" | "BOOST_2" = "BASE";
    let leverageBlockReason: string | null = null;
    let leverageReason = "base_profile";

    const accountEquityKrw = state.accountEquityKrw ?? 500_000;
    const maxUsableMarginKrw = state.maxUsableMarginKrw ?? 420_000;
    const exposureNotionalCapKrw = state.exposureNotionalCapKrw ?? 2_000_000;
    const symbolExposureNotionalCapKrw = state.symbolExposureNotionalCapKrw ?? 1_400_000;

    const atrPct = snapshot.lastPrice > 0 ? Math.max(0, (snapshot.volatilityProxy ?? 0) / snapshot.lastPrice) : 0;
    const qualityScore = Math.max(0, snapshot.qualityScore ?? 0);
    const emaGapAbs = Math.abs(snapshot.emaGap ?? 0);
    const volumeRatio = Math.max(0, snapshot.rangeConfidence ?? 0);
    const current = { qualityScore, atrPct, emaGapAbs, volumeRatio };
    const dist = (p: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number }): number => {
        if (p.count <= 0) return Number.POSITIVE_INFINITY;
        const dq = (current.qualityScore - p.qualityScoreAvg) / 100;
        const de = current.emaGapAbs - p.emaGapAvg;
        const da = current.atrPct - p.atrPctAvg;
        const dv = (current.volumeRatio - p.volumeRatioAvg) / 5;
        return Math.sqrt(dq * dq + de * de + da * da + dv * dv);
    };
    const qualityProfiles = state.entryQualityProfiles;
    const dProfit = qualityProfiles ? dist(qualityProfiles.profit) : Number.POSITIVE_INFINITY;
    const dLoss = qualityProfiles ? dist(qualityProfiles.loss) : Number.POSITIVE_INFINITY;
    const dContaminated = qualityProfiles ? dist(qualityProfiles.contaminated) : Number.POSITIVE_INFINITY;
    const entryQualityGrade: "S" | "A" | "B" =
        qualityScore >= 90 ? "S" : qualityScore >= 80 ? "A" : "B";
    const isTrend = judgment.regime === "TREND";
    const shockActive = state.directionalShockState !== "NONE";
    const sideAllowed = executor.side === "long" ? state.longAllow : executor.side === "short" ? state.shortAllow : false;
    const trendLossStreak = Math.max(0, Number(state.lossStreaks?.TREND ?? 0));
    const symbolFlowLossStreak = trendLossStreak;
    const sameSymbolSide = state.currentPositions.filter((p) => p.symbol === input.symbol && String(p.side).toLowerCase() === executor.side);
    const sameSymbolPos = sameSymbolSide[0] ?? null;
    const currentStage = sameSymbolPos ? Math.max(1, sameSymbolPos.entryStage ?? 1) : 0;
    const isAddOn = sameSymbolPos != null;
    const currentMarginUsed = state.currentPositions.reduce((acc, p) => acc + Math.max(0, p.sizeUsd), 0);
    const currentNotional = state.currentPositions.reduce((acc, p) => acc + Math.max(0, p.sizeUsd), 0);
    const currentSymbolNotional = state.currentPositions
        .filter((p) => p.symbol === input.symbol)
        .reduce((acc, p) => acc + Math.max(0, p.sizeUsd), 0);

    // NO_TRADE: Hard block
    if (judgment.regime === "NO_TRADE") {
        isBlocked = true;
        blockReason = "NO_TRADE_REGIME";
    }
    else if (!state.executionReadiness) {
        isBlocked = true;
        blockReason = "EXECUTION_READINESS_FALSE";
    }
    else if (state.freshTickBarrierActive) {
        isBlocked = true;
        blockReason = "FRESH_TICK_BARRIER_ACTIVE";
    }
    // WAIT_RECHECK: Block but diagnostic handled via explanation
    else if (executor.signal === "WAIT_RECHECK") {
        isBlocked = true;
        blockReason = "WAIT_RECHECK";
    }
    else if (Number.isFinite(dContaminated) && dContaminated < dProfit) {
        isBlocked = true;
        blockReason = "ENTRY_QUALITY_CONTAMINATED_SIMILAR";
    }
    else if (Number.isFinite(dLoss) && dLoss < dProfit) {
        isBlocked = true;
        blockReason = "ENTRY_QUALITY_LOSS_SIMILAR";
    }
    else if (state.serverTradeEnabled === false) {
        isBlocked = true;
        blockReason = "SERVER_TRADE_DISABLED";
    }
    else if (state.closeOnlyMode === true) {
        isBlocked = true;
        blockReason = "CLOSE_ONLY_MODE";
    }
    else if (state.killSwitch === true || state.killSwitchActive === true) {
        isBlocked = true;
        blockReason = "KILL_SWITCH_ACTIVE";
    }
    else if (state.reconcileSafeMode === true || state.reconcileSafeModeActive === true) {
        isBlocked = true;
        blockReason = "RECONCILE_SAFE_MODE";
    }

    // TRANSITION: Force Scouting Mode (Very small size)
    if (judgment.regime === "TRANSITION") {
        sizeMultiplier *= 0.1; // Scouting mode is forced to 10% size
    }

    // Confidence adjustment
    if (confidence.level === "MID") {
        sizeMultiplier *= 0.7;
    } else if (confidence.level === "LOW") {
        sizeMultiplier *= 0.4;
    }

    if (!isBlocked && Number.isFinite(dProfit)) {
        const similarityScore = Math.max(0, Math.min(1, 1 / (1 + dProfit)));
        if (similarityScore < 0.55) {
            sizeMultiplier *= 0.5;
        }
    }

    const trendIsStrongDirection = isTrend && sideAllowed && !shockActive;
    const baseLeverage =
        shockActive ? 2 :
            isTrend ? 4 : 3;
    let appliedLeverage = baseLeverage;
    let stageMarginKrw = Math.max(0, baseSizeUsd * sizeMultiplier);
    if (judgment.regime === "RANGE") {
        stageMarginKrw = currentStage <= 0 ? 140_000 : currentStage === 1 ? 80_000 : 40_000;
        leverageReason = "range_fixed_3x";
    } else if (shockActive) {
        stageMarginKrw = currentStage <= 0 ? 108_000 : 0;
        leverageReason = "shock_fixed_2x";
        if (currentStage > 0) {
            isBlocked = true;
            blockReason = blockReason ?? "SHOCK_ADDON_FORBIDDEN";
        }
    } else if (isTrend && entryQualityGrade === "S") {
        stageMarginKrw = currentStage <= 0 ? 180_000 : currentStage === 1 ? 110_000 : 60_000;
    } else if (isTrend && entryQualityGrade === "A") {
        stageMarginKrw = currentStage <= 0 ? 135_000 : currentStage === 1 ? 82_000 : 45_000;
    }

    const canBoostBase =
        !isBlocked &&
        trendIsStrongDirection &&
        entryQualityGrade === "S" &&
        !state.freshTickBarrierActive &&
        Number.isFinite(dProfit) &&
        dProfit <= dLoss &&
        dProfit <= dContaminated &&
        symbolFlowLossStreak < 2;
    if (canBoostBase && isAddOn && currentStage >= 1) {
        leverageProfile = "BOOST_1";
        appliedLeverage = 5;
        leverageReason = "trend_s_grade_addon_revalidated";
    } else {
        leverageProfile = "BASE";
    }
    const pnlFavorable = (sameSymbolPos?.pnlPct ?? 0) > 0.003;
    const canBoost2 =
        canBoostBase &&
        isAddOn &&
        currentStage >= 2 &&
        pnlFavorable;
    if (canBoost2) {
        leverageProfile = "BOOST_2";
        appliedLeverage = 6;
        leverageReason = "trend_s_grade_profit_confirmed";
    }
    const canAGradeBoost =
        !isBlocked &&
        isTrend &&
        entryQualityGrade === "A" &&
        isAddOn &&
        currentStage >= 2 &&
        pnlFavorable &&
        !shockActive &&
        symbolFlowLossStreak < 2;
    if (canAGradeBoost) {
        leverageProfile = "BOOST_1";
        appliedLeverage = 5;
        leverageReason = "trend_a_grade_limited_boost";
    }
    if (entryQualityGrade === "A" && appliedLeverage > 5) {
        appliedLeverage = 5;
        leverageProfile = appliedLeverage === 5 ? "BOOST_1" : "BASE";
        leverageBlockReason = "A_GRADE_MAX_5X";
        leverageReason = "a_grade_cap_5x";
    }
    if (entryQualityGrade !== "S" && (leverageProfile === "BOOST_1" || leverageProfile === "BOOST_2")) {
        leverageProfile = "BASE";
        appliedLeverage = baseLeverage;
        leverageBlockReason = "NON_S_GRADE_BOOST_FORBIDDEN";
        leverageReason = "boost_reverted_non_s_grade";
    }
    if (!isTrend || shockActive) {
        if (leverageProfile !== "BASE") leverageBlockReason = !isTrend ? "BOOST_TREND_ONLY" : "BOOST_FORBIDDEN_IN_SHOCK";
        leverageProfile = "BASE";
        appliedLeverage = baseLeverage;
    }
    if (symbolFlowLossStreak >= 2) {
        stageMarginKrw *= 0.5;
        appliedLeverage = Math.min(appliedLeverage, baseLeverage);
        leverageProfile = "BASE";
        leverageBlockReason = "TWO_CONSECUTIVE_LOSSES_RECOVERY_MODE";
        leverageReason = "loss_recovery_mode";
    }

    const proposedNotional = stageMarginKrw * appliedLeverage;
    if (!isBlocked && currentMarginUsed + stageMarginKrw > maxUsableMarginKrw) {
        isBlocked = true;
        blockReason = "MAX_USABLE_MARGIN_EXCEEDED";
    }
    if (!isBlocked && currentNotional + proposedNotional > exposureNotionalCapKrw) {
        isBlocked = true;
        blockReason = "EXPOSURE_NOTIONAL_CAP_EXCEEDED";
    }
    if (!isBlocked && currentSymbolNotional + proposedNotional > symbolExposureNotionalCapKrw) {
        isBlocked = true;
        blockReason = "SYMBOL_EXPOSURE_NOTIONAL_CAP_EXCEEDED";
    }
    if (!isBlocked && !sideAllowed) {
        isBlocked = true;
        blockReason = executor.side === "long" ? "SIDE_NOT_ALLOWED_LONG" : "SIDE_NOT_ALLOWED_SHORT";
    }
    if (!isBlocked && state.executionReadiness && trendLossStreak >= 2 && entryQualityGrade === "B") {
        isBlocked = true;
        blockReason = "WATCH_MODE_AFTER_LOSS_STREAK";
    }

    const effectiveMargin = isBlocked ? 0 : stageMarginKrw;
    const effectiveNotional = effectiveMargin * appliedLeverage;
    sizeMultiplier = baseSizeUsd > 0 ? effectiveMargin / baseSizeUsd : 0;

    const diagnostics = {
        entry_quality_distance_profit: Number.isFinite(dProfit) ? dProfit : null,
        entry_quality_distance_loss: Number.isFinite(dLoss) ? dLoss : null,
        entry_quality_distance_contaminated: Number.isFinite(dContaminated) ? dContaminated : null,
        execution_readiness: state.executionReadiness,
        fresh_tick_barrier_active: state.freshTickBarrierActive,
        fresh_tick_completed_cycles: state.freshTickCompletedCycles,
        fresh_tick_required_cycles: state.freshTickRequiredCycles,
        server_trade_enabled: state.serverTradeEnabled ?? null,
        close_only_mode: state.closeOnlyMode ?? null,
        kill_switch: (state.killSwitch ?? state.killSwitchActive) ?? null,
        reconcile_safe_mode: (state.reconcileSafeMode ?? state.reconcileSafeModeActive) ?? null,
        entry_quality_grade: entryQualityGrade,
        leverage_profile: leverageProfile,
        applied_leverage: appliedLeverage,
        leverage_reason: leverageReason,
        leverage_block_reason: leverageBlockReason,
        exposure_notional_krw: effectiveNotional,
        equity_multiple: accountEquityKrw > 0 ? effectiveNotional / accountEquityKrw : 0
    };
    return {
        baseSizeUsd,
        sizeMultiplier,
        finalSizeUsd: effectiveMargin,
        isBlocked,
        blockReason: blockReason || null,
        isAddOn,
        leverageProfile,
        appliedLeverage,
        leverageReason,
        leverageBlockReason,
        entryQualityGrade,
        exposureNotionalKrw: effectiveNotional,
        equityMultiple: accountEquityKrw > 0 ? effectiveNotional / accountEquityKrw : 0,
        diagnostics
    };
}
