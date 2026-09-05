import { EngineV2Input, ExecutorOutput, RiskSizingOutput, MarketJudgmentOutput, RegimeConfidenceOutput } from "../types";
import { resolveOpenNotionalUsd, resolveOpenMarginUsd, resolveOpenNotionalAuthority, isV2AuthorityRow } from "../live-account/position-size-authority";

/**
 * Tier 5: Risk & Sizing Policy (Refined)
 * Adjusts size based on regime and confidence.
 */
export function calculateRiskSizing(
    judgment: MarketJudgmentOutput,
    confidence: RegimeConfidenceOutput,
    executor: ExecutorOutput,
    input: EngineV2Input,
    externalSizeMultiplier?: number | null
): RiskSizingOutput & { diagnostics?: Record<string, number | string | boolean | null> } {
    const { config } = input;
    const { snapshot, state } = input;
    const baseStageMarginKrw = config.baseSizeUsd;
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
    const profitSampleCount = qualityProfiles?.profit.count ?? 0;
    const lossSampleCount = qualityProfiles?.loss.count ?? 0;
    const contaminatedSampleCount = qualityProfiles?.contaminated.count ?? 0;
    let lossSimilarityWatch = false;
    let lossSimilarityHardRejected = false;
    const entryQualityGrade: "S" | "A" | "B" =
        qualityScore >= 90 ? "S" : qualityScore >= 80 ? "A" : "B";
    const isTrend = judgment.regime === "TREND";
    const shockActive = state.directionalShockState !== "NONE";
    const hasDirectionalSide = executor.side === "long" || executor.side === "short";
    const isBtcMrBypass =
        String(input.symbol).toUpperCase() === "BTCUSDT" &&
        judgment.regime === "RANGE" &&
        (executor.reason === "BTC_RANGE_MR_STALE_DOWN_SHOCK_LOCAL_BYPASS" ||
         executor.reason === "BTC_RANGE_MR_STALE_UP_SHOCK_LOCAL_BYPASS" ||
         (executor.metadata as any)?.btcRangeMrBypass === true);
    const sideAllowed = executor.side === "long"
        ? (state.longAllow || (isBtcMrBypass && executor.side === "long"))
        : executor.side === "short"
            ? (state.shortAllow || (isBtcMrBypass && executor.side === "short"))
            : true;
    const trendLossStreak = Math.max(0, Number(state.lossStreaks?.TREND ?? 0));
    const symbolFlowLossStreak = trendLossStreak;
    const sameSymbolSide = state.currentPositions.filter((p) => p && p.symbol === input.symbol && String(p.side).toLowerCase() === String(executor.side ?? "").toLowerCase());
    const sameSymbolPos = sameSymbolSide[0] ?? state.currentPositions.find((p) => p && p.symbol === input.symbol) ?? null;
    const currentStage = sameSymbolPos ? Math.max(1, sameSymbolPos.entryStage ?? 1) : 0;
    const isAddOn = sameSymbolPos != null;
    const addOnPolicyAllowed = state.addOnPolicyAllowed;
    const addOnPolicyReason = state.addOnPolicyReason;
    const currentMarginUsed = state.currentPositions.reduce((acc, p) => acc + resolveOpenMarginUsd(p as any), 0);

    // BLOCKER 4-6: OKX Actual Notional authority helper.
    // For each paper ledger position, look up a matching OKX actual position
    // (same symbol + same side) and return its notionalUsd as authoritative override.
    // This allows manual/external positions with unknown ledger units to be resolved
    // via OKX Actual instead of triggering UNKNOWN_UNIT_SAFETY_BLOCK.
    // Conditions: okxActualPositionsReady must be true, notionalUsd must be finite > 0.
    // If OKX Actual is absent or not ready, returns undefined → Fail-Closed preserved.
    const okxActualPositionsReady = (state as any).okxActualPositionsReady === true;
    const okxActualPositionsRaw: Array<{ symbol: string; sizeUsd?: number; notionalUsd?: number; side: string }> | undefined =
        okxActualPositionsReady ? ((state as any).okxActualPositions ?? undefined) : undefined;

    function findOkxActualNotional(pSymbol: string, pSide: string): number | undefined {
        if (!Array.isArray(okxActualPositionsRaw)) return undefined;
        const pSideLower = String(pSide).toLowerCase();
        for (const okxP of okxActualPositionsRaw) {
            if (!okxP) continue;
            if (okxP.symbol !== pSymbol) continue;
            if (String(okxP.side).toLowerCase() !== pSideLower) continue;
            const n = typeof okxP.notionalUsd === "number" && Number.isFinite(okxP.notionalUsd) && okxP.notionalUsd > 0
                ? okxP.notionalUsd
                : typeof okxP.sizeUsd === "number" && Number.isFinite(okxP.sizeUsd) && okxP.sizeUsd > 0
                    ? okxP.sizeUsd
                    : undefined;
            if (n !== undefined) return n;
        }
        return undefined;
    }

    let hasUnknownUnit = false;
    const currentNotional = state.currentPositions.reduce((acc, p) => {
        const okxNotional = findOkxActualNotional(String((p as any).symbol ?? ""), String((p as any).side ?? ""));
        const auth = resolveOpenNotionalAuthority(p as any, okxNotional);
        if (!auth.authoritative || auth.valueUsd == null) {
            hasUnknownUnit = true;
            return NaN;
        }
        if (!isV2AuthorityRow(p as any)) return acc;
        return acc + auth.valueUsd;
    }, 0);
    const currentSymbolNotional = state.currentPositions
        .filter((p) => p.symbol === input.symbol)
        .reduce((acc, p) => {
            const okxNotional = findOkxActualNotional(String((p as any).symbol ?? ""), String((p as any).side ?? ""));
            const auth = resolveOpenNotionalAuthority(p as any, okxNotional);
            if (!auth.authoritative || auth.valueUsd == null) {
                hasUnknownUnit = true;
                return NaN;
            }
            if (!isV2AuthorityRow(p as any)) return acc;
            return acc + auth.valueUsd;
        }, 0);
    const marketSnapshotReady =
        snapshot != null &&
        Number.isFinite(snapshot.lastPrice) &&
        snapshot.lastPrice > 0 &&
        Number.isFinite(snapshot.latestCandleClose);
    const positionStateReady = Array.isArray(state.currentPositions);
    const v2InputReady = marketSnapshotReady && positionStateReady;
    const riskModeUpper = String(state.riskMode ?? "").toUpperCase();
    const dailyLossGuardTriggered = state.dailyLossGuardTriggered === true;
    const paperReadinessBlockReasons: string[] = [];
    if (state.serverTradeEnabled === false) paperReadinessBlockReasons.push("SERVER_TRADE_DISABLED");
    if (state.closeOnlyMode === true) paperReadinessBlockReasons.push("CLOSE_ONLY_MODE");
    if (state.killSwitch === true || state.killSwitchActive === true) paperReadinessBlockReasons.push("KILL_SWITCH");
    if (state.reconcileSafeMode === true || state.reconcileSafeModeActive === true) paperReadinessBlockReasons.push("RECONCILE_SAFE_MODE");
    if (riskModeUpper === "HALT") paperReadinessBlockReasons.push("RISK_MODE_HALT");
    if (dailyLossGuardTriggered) paperReadinessBlockReasons.push("DAILY_LOSS_GUARD");
    if (!marketSnapshotReady) paperReadinessBlockReasons.push("MARKET_SNAPSHOT_NOT_READY");
    if (!positionStateReady) paperReadinessBlockReasons.push("POSITION_STATE_NOT_READY");
    if (!v2InputReady) paperReadinessBlockReasons.push("V2_INPUT_NOT_READY");
    if (hasUnknownUnit) paperReadinessBlockReasons.push("UNKNOWN_UNIT_SAFETY_BLOCK");
    const effectivePaperExecutionReady = paperReadinessBlockReasons.length === 0;
    const signedReadinessBlockReason = state.signedExecutionReady === false ? "SIGNED_EXECUTION_NOT_READY" : null;

    const maxOrderNotionalUsdt = config.okxLiveMaxOrderNotionalUsdt ?? ((state as any).liveMaxOrderNotionalUsdt != null ? Number((state as any).liveMaxOrderNotionalUsdt) : null);
    const maxAddonNotionalUsdt = config.okxLiveMaxAddonNotionalUsdt ?? ((state as any).liveMaxAddonNotionalUsdt != null ? Number((state as any).liveMaxAddonNotionalUsdt) : null);
    const maxSymbolNotionalUsdt = config.okxLiveMaxSymbolNotionalUsdt ?? ((state as any).liveMaxSymbolNotionalUsdt != null ? Number((state as any).liveMaxSymbolNotionalUsdt) : null);
    const maxAccountNotionalUsdt = config.okxLiveMaxAccountNotionalUsdt ?? ((state as any).liveMaxAccountNotionalUsdt != null ? Number((state as any).liveMaxAccountNotionalUsdt) : null);
    const maxAddonCount = config.okxLiveMaxAddonCount ?? ((state as any).liveMaxAddonCount != null ? Number((state as any).liveMaxAddonCount) : null);

    const limitsConfigured =
        maxOrderNotionalUsdt != null && maxOrderNotionalUsdt > 0 &&
        maxAddonNotionalUsdt != null && maxAddonNotionalUsdt > 0 &&
        maxSymbolNotionalUsdt != null && maxSymbolNotionalUsdt > 0 &&
        maxAccountNotionalUsdt != null && maxAccountNotionalUsdt > 0 &&
        maxAddonCount != null && maxAddonCount >= 0;

    if (judgment.regime === "NO_TRADE") {
        isBlocked = true;
        blockReason = "NO_TRADE_REGIME";
    } else if (judgment.subtype === "WHIPSAW_SHOCK_RECHECK") {
        isBlocked = true;
        blockReason = "WHIPSAW_SHOCK_RECHECK";
    } else if (judgment.subtype === "EARLY_LONG_PROBE" || judgment.subtype === "EARLY_SHORT_PROBE" || judgment.subtype === "FAST_TREND_SHIFT") {
        // Explicitly allow probe subtypes but enforce structural safety
        isBlocked = false;

        const stopPrice = executor.stopPrice;
        if (!stopPrice || stopPrice <= 0) {
            isBlocked = true;
            blockReason = "ENTRY_BLOCKED_NO_STRUCTURAL_STOP";
        }

        const probeBlockReason = judgment.diagnostics?.early_probe?.block_reason || judgment.diagnostics?.fastTrendShift?.block_reason;
        if (probeBlockReason === "TOTAL_BEARISH_HTF" || probeBlockReason === "TOTAL_BULLISH_HTF") {
            isBlocked = true;
            blockReason = probeBlockReason;
        }
    }
    else if (!effectivePaperExecutionReady) {
        isBlocked = true;
        blockReason = paperReadinessBlockReasons[0] || "EXECUTION_READINESS_FALSE";
    }
    // WAIT_RECHECK: Soft warning / diagnostic only (No longer a hard block)
    else if (executor.signal === "WAIT_RECHECK") {
        // Soft warning handled via diagnostics
    }
    else if (Number.isFinite(dContaminated) && dContaminated < dProfit) {
        isBlocked = true;
        blockReason = "ENTRY_QUALITY_CONTAMINATED_SIMILAR";
    }
    else if (Number.isFinite(dLoss) && dLoss < dProfit) {
        const hasEnoughLossSamples = lossSampleCount >= 5;
        const hasSupportingSamples = profitSampleCount >= 3 || contaminatedSampleCount >= 3;
        const extremeLossSimilarity = dLoss <= 0.08;
        if (hasEnoughLossSamples && hasSupportingSamples && extremeLossSimilarity) {
            isBlocked = true;
            blockReason = "ENTRY_QUALITY_LOSS_SIMILAR";
            lossSimilarityHardRejected = true;
        } else {
            // Loss similarity in low-sample or bootstrap phases is advisory only.
            lossSimilarityWatch = true;
            sizeMultiplier *= 0.7;
        }
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
    else if (isAddOn && addOnPolicyAllowed === false) {
        isBlocked = true;
        blockReason = addOnPolicyReason ?? "ADDON_POLICY_FORBIDDEN";
    }

    // TRANSITION: Force Scouting Mode (Very small size)
    if (judgment.regime === "TRANSITION") {
        sizeMultiplier *= 0.1; // Scouting mode is forced to 10% size
    }

    const isRangeProbeSubtype =
        judgment.subtype === "EARLY_LONG_PROBE" ||
        judgment.subtype === "EARLY_SHORT_PROBE" ||
        judgment.subtype === "FAST_TREND_SHIFT";
    const isRangeProbeInitialSizing = isRangeProbeSubtype && currentStage <= 0 && !isAddOn;

    if (isRangeProbeSubtype) {
        const probeIntent =
            judgment.subtype === "FAST_TREND_SHIFT"
                ? executor.baseSizeIntent > 0
                    ? executor.baseSizeIntent
                    : (judgment.diagnostics?.fastTrendShift?.baseSizeIntent ?? 0.32)
                : 0.32;
        sizeMultiplier = judgment.counter_trend_risk ? 0.22 : probeIntent;
    }

    // Confidence adjustment
    if (confidence.level === "MID") {
        sizeMultiplier *= 0.7;
    } else if (confidence.level === "LOW") {
        sizeMultiplier *= 0.4;
    }

    // Fresh-tick barrier + execution gate: Soft warning / diagnostic only in V2 decision stage.
    // Hard block is handled exclusively at the paper-engine final authority gate.
    if (!isBlocked && (state.freshTickBarrierActive === true || state.freshTickExecutionBlocked === true)) {
        // Diagnostic only, no hard block here.
    }

    if (!isBlocked && Number.isFinite(dProfit)) {
        const similarityScore = Math.max(0, Math.min(1, 1 / (1 + dProfit)));
        if (similarityScore < 0.55) {
            sizeMultiplier *= 0.5;
        }
    }

    const FIXED_LEVERAGE_10X = 10;
    let appliedLeverage = FIXED_LEVERAGE_10X;
    let stageMarginKrw = Math.max(0, baseStageMarginKrw * sizeMultiplier);
    if (judgment.regime === "RANGE") {
        const rangeStageBaseKrw = currentStage <= 0 ? 140_000 : currentStage === 1 ? 80_000 : 40_000;
        if (isRangeProbeInitialSizing) {
            stageMarginKrw = Math.max(0, rangeStageBaseKrw * sizeMultiplier);
        } else {
            stageMarginKrw = rangeStageBaseKrw;
        }
    } else if (shockActive) {
        stageMarginKrw = currentStage <= 0 ? 108_000 : 0;
        if (currentStage > 0) {
            isBlocked = true;
            blockReason = blockReason ?? "SHOCK_ADDON_FORBIDDEN";
        }
    } else if (isTrend && isAddOn && addOnPolicyAllowed) {
        // --- TREND Profit-Funded Pyramid Sizing (Unified Source of Truth) ---
        const finalAddonNotionalUsdt = state.finalAddonNotionalUsdt ?? 0;
        
        // Convert to KRW (using 1400 fixed for consistency with other KRW-based limits)
        stageMarginKrw = (finalAddonNotionalUsdt / appliedLeverage) * 1400;

        console.info(JSON.stringify({
            event: "V2_TREND_PROFIT_FUNDED_PYRAMID_PROOF",
            symbol: input.symbol,
            lockedProfitUsdt: state.lockedProfitUsdt,
            availableRiskBudgetUsdt: state.availableRiskBudgetUsdt,
            finalAddonNotionalUsdt: finalAddonNotionalUsdt,
            stageMarginKrw: stageMarginKrw,
            currentStage: currentStage,
            appliedLeverage: appliedLeverage
        }));

        if (stageMarginKrw < 1000) { // Minimum 1,000 KRW for add-on to support profit-funded scaling
             isBlocked = true;
             blockReason = "PROFIT_FUNDED_SIZE_TOO_SMALL";
        }
    } else if (isTrend && entryQualityGrade === "S") {
        stageMarginKrw = currentStage <= 0 ? 180_000 : currentStage === 1 ? 110_000 : 60_000;
    } else if (isTrend && entryQualityGrade === "A") {
        stageMarginKrw = currentStage <= 0 ? 135_000 : currentStage === 1 ? 82_000 : 45_000;
    }

    leverageProfile = "BASE";
    leverageReason = "v2_fixed_10x";

    if (symbolFlowLossStreak >= 2) {
        stageMarginKrw *= 0.5;
        leverageProfile = "BASE";
        leverageBlockReason = "TWO_CONSECUTIVE_LOSSES_RECOVERY_MODE";
        leverageReason = "v2_fixed_10x";
    }

    // External market context — sizing auxiliary only (never entry block).
    if (
        externalSizeMultiplier != null &&
        Number.isFinite(externalSizeMultiplier) &&
        externalSizeMultiplier > 0 &&
        externalSizeMultiplier !== 1
    ) {
        stageMarginKrw *= externalSizeMultiplier;
    }

    const currentMarginUsedKrw = currentMarginUsed * 1400;
    const currentNotionalKrw = currentNotional * 1400;
    const currentSymbolNotionalKrw = currentSymbolNotional * 1400;
    const proposedNotional = stageMarginKrw * appliedLeverage;

    // Legacy KRW limits are diagnostic checks used only when neither USDT limits nor signed execution apply
    if (!limitsConfigured && !(state as any).okxLiveEnabled) {
        if (!isBlocked && currentMarginUsedKrw + stageMarginKrw > maxUsableMarginKrw) {
            isBlocked = true;
            blockReason = "MAX_USABLE_MARGIN_EXCEEDED";
        }
        if (!isBlocked && currentNotionalKrw + proposedNotional > exposureNotionalCapKrw) {
            isBlocked = true;
            blockReason = "EXPOSURE_NOTIONAL_CAP_EXCEEDED";
        }
        if (!isBlocked && currentSymbolNotionalKrw + proposedNotional > symbolExposureNotionalCapKrw) {
            isBlocked = true;
            blockReason = "SYMBOL_EXPOSURE_NOTIONAL_CAP_EXCEEDED";
        }
    }
    if (!isBlocked && hasDirectionalSide && !sideAllowed) {
        isBlocked = true;
        blockReason = executor.side === "long" ? "SIDE_NOT_ALLOWED_LONG" : "SIDE_NOT_ALLOWED_SHORT";
    }
    if (!isBlocked && state.executionReadiness && trendLossStreak >= 2 && entryQualityGrade === "B") {
        sizeMultiplier *= 0.7;
    }

    const effectiveMargin = isBlocked ? 0 : stageMarginKrw;
    const effectiveNotional = effectiveMargin * appliedLeverage;
    sizeMultiplier = baseStageMarginKrw > 0 ? effectiveMargin / baseStageMarginKrw : 0;

    const diagnostics = {
        entry_quality_distance_profit: Number.isFinite(dProfit) ? dProfit : null,
        entry_quality_distance_loss: Number.isFinite(dLoss) ? dLoss : null,
        entry_quality_distance_contaminated: Number.isFinite(dContaminated) ? dContaminated : null,
        entry_quality_profit_sample_count: profitSampleCount,
        entry_quality_loss_sample_count: lossSampleCount,
        entry_quality_contaminated_sample_count: contaminatedSampleCount,
        loss_similarity_watch: lossSimilarityWatch,
        loss_similarity_hard_rejected: lossSimilarityHardRejected,
        execution_readiness: effectivePaperExecutionReady,
        paper_execution_ready: effectivePaperExecutionReady,
        signed_execution_ready: state.signedExecutionReady ?? null,
        okx_auth_mode: state.okxAuthMode ?? null,
        okx_auth_ready: state.okxAuthReady ?? null,
        okx_exchange_auth_opt_in: state.okxExchangeAuthOptIn ?? null,
        okx_live_enabled: state.okxLiveEnabled ?? null,
        okx_demo_enabled: state.okxDemoEnabled ?? null,
        okx_api_key_present: state.okxApiKeyPresent ?? null,
        okx_api_secret_present: state.okxApiSecretPresent ?? null,
        okx_passphrase_present: state.okxPassphrasePresent ?? null,
        okx_simulated_trading_header_enabled: state.okxSimulatedTradingHeaderEnabled ?? null,
        live_max_order_notional_usdt: state.liveMaxOrderNotionalUsdt ?? null,
        paper_readiness_block_reasons: paperReadinessBlockReasons.join("|") || null,
        signed_readiness_block_reason: signedReadinessBlockReason,
        market_snapshot_ready: marketSnapshotReady,
        position_state_ready: positionStateReady,
        v2_input_ready: v2InputReady,
        risk_mode: state.riskMode ?? null,
        daily_loss_guard_triggered: dailyLossGuardTriggered,
        fresh_tick_barrier_active: state.freshTickBarrierActive,
        fresh_tick_completed_cycles: state.freshTickCompletedCycles,
        fresh_tick_required_cycles: state.freshTickRequiredCycles,
        server_trade_enabled: state.serverTradeEnabled ?? null,
        close_only_mode: state.closeOnlyMode ?? null,
        kill_switch: (state.killSwitch ?? state.killSwitchActive) ?? null,
        reconcile_safe_mode: (state.reconcileSafeMode ?? state.reconcileSafeModeActive) ?? null,
        addon_policy_allowed: addOnPolicyAllowed ?? null,
        addon_policy_reason: addOnPolicyReason ?? null,
        addon_policy_action: state.addOnPolicyAction ?? null,
        entry_quality_grade: entryQualityGrade,
        leverage_profile: leverageProfile,
        applied_leverage: appliedLeverage,
        leverage_reason: leverageReason,
        leverage_block_reason: leverageBlockReason,
        executor_side: executor.side ?? "none",
        executor_side_none_diagnostic: hasDirectionalSide ? null : "EXECUTOR_SIDE_NONE_DIAGNOSTIC",
        exposure_notional_krw: effectiveNotional,
        equity_multiple: accountEquityKrw > 0 ? effectiveNotional / accountEquityKrw : 0,
        wait_recheck: executor.signal === "WAIT_RECHECK",
        soft_warning_reason: executor.signal === "WAIT_RECHECK" ? "WAIT_RECHECK" : null,
        range_probe_sizing_applied: isRangeProbeInitialSizing,
        range_probe_size_intent: isRangeProbeInitialSizing ? sizeMultiplier : null,
        external_size_multiplier_applied:
            externalSizeMultiplier != null &&
            Number.isFinite(externalSizeMultiplier) &&
            externalSizeMultiplier > 0
                ? externalSizeMultiplier
                : null
    };
    return {
        baseStageMarginKrw,
        sizeMultiplier,
        stageMarginKrw: effectiveMargin,
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
