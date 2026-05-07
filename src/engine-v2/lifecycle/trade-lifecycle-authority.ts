import type { V2TradeLifecycleAuthorityInput, V2TradeLifecycleAuthorityResult, V2CooldownType, V2LifecycleStage } from "../types";

function resolveCooldownType(input: V2TradeLifecycleAuthorityInput): V2CooldownType {
    const reason = String(input.cooldownState.reason ?? "").toLowerCase();
    if (
        (input.directionalShockState === "DOWN" && input.side === "long") ||
        (input.directionalShockState === "UP" && input.side === "short") ||
        reason.includes("direction") ||
        reason.includes("side_not_allowed")
    ) {
        return "direction_block";
    }
    if (reason.includes("risk") || reason.includes("halt") || reason.includes("daily_loss")) return "risk_halt";
    if (reason.includes("reentry_fail") || reason.includes("fail_reentry")) return "fail_reentry";
    if (input.cooldownState.reentryBlocked || reason.includes("reentry") || reason.includes("cooldown")) return "time_reentry";
    return "none";
}

function resolveLifecycleStage(input: V2TradeLifecycleAuthorityInput): V2LifecycleStage {
    if (input.v2Decision === "ENTER") {
        return input.position ? "add_on" : "entry";
    }
    if (input.v2Decision === "EXIT") return "exit";
    const cooldownType = resolveCooldownType(input);
    if (cooldownType !== "none") return "cooldown";
    if (input.position != null && (input.unrealizedPnlPct ?? 0) > 0.003 && input.regime === "RANGE") return "partial";
    return "position_state";
}

export function deriveTradeLifecycleAuthority(input: V2TradeLifecycleAuthorityInput): V2TradeLifecycleAuthorityResult {
    const proofReasons: string[] = [];
    const trueInconsistencyReasons: string[] = [];
    const knownShadowGaps: string[] = [];
    const cooldownType = resolveCooldownType(input);
    const lifecycleStage = resolveLifecycleStage(input);
    const lifecycleAuthorityOwner: V2TradeLifecycleAuthorityResult["lifecycleAuthorityOwner"] =
        input.authoritySource === "v2" && input.adoptedEngine === "V2"
            ? "v2"
            : input.authoritySource === "v1"
                ? "legacy"
                : "unknown";
    const isV2Owner = lifecycleAuthorityOwner === "v2";

    // V2 MIGRATION: Execution owners are now V2 by default for V2-owned positions
    const executionOwner: V2TradeLifecycleAuthorityResult["executionOwner"] = isV2Owner ? "v2_executor" : "paper_engine";
    const partialExecutionOwner = isV2Owner ? "v2_executor" : "paper_engine";
    const exitExecutionOwner = isV2Owner ? "v2_executor" : "paper_engine";
    const cooldownExecutionOwner = isV2Owner ? "v2_executor" : "paper_engine";
    const positionStateExecutionOwner: V2TradeLifecycleAuthorityResult["positionStateOwner"] = isV2Owner ? "v2_executor" : "paper_engine";
    const postEntryExecutionOwner = isV2Owner ? "v2_executor" : "paper_engine";

    if (input.directionalShockState === "DOWN" && input.side === "long") {
        proofReasons.push("DOWN_SHOCK_LONG_RESTRICTED_MANAGEMENT");
    } else if (input.directionalShockState === "UP" && input.side === "short") {
        proofReasons.push("UP_SHOCK_SHORT_RESTRICTED_MANAGEMENT");
    }

    const boxPos = input.rawMetricsSummary.boxPos;
    const rangeEdge =
        typeof boxPos === "number" && Number.isFinite(boxPos) && (boxPos <= 0.15 || boxPos >= 0.85);
    const rangeMid =
        typeof boxPos === "number" && Number.isFinite(boxPos) && boxPos > 0.35 && boxPos < 0.65;
    const trendHealthy = input.rawMetricsSummary.trendWeaknessScore <= 0.55;

    let addOnAllowed: boolean | null = null;
    let newStopPrice: number | undefined;
    let partialAction: V2TradeLifecycleAuthorityResult["partialAction"] = "none";
    let exitAction: V2TradeLifecycleAuthorityResult["exitAction"] = "none";

    if (input.position != null) {
        if (input.regime === "RANGE") {
            addOnAllowed = rangeEdge && !rangeMid;
            partialAction = (input.unrealizedPnlPct ?? 0) >= 0.003 && rangeEdge ? "protect_profit" : "prepare";
            exitAction = rangeMid && (input.unrealizedPnlPct ?? 0) >= 0.002 ? "watch" : "none";
            proofReasons.push(rangeEdge ? "RANGE_EDGE_MANAGEMENT" : "RANGE_MID_CONSERVATIVE_MANAGEMENT");
        } else if (input.regime === "TREND" && input.position != null) {
            const side = input.side;
            const entryPrice = input.position.entryPrice;
            const sizeUsd = input.position.sizeUsd;
            const markPrice = input.markPrice ?? entryPrice;
            const currentStop = input.currentStopPrice;
            
            const accountEquityUsd = input.accountEquityUsd ?? 500;
            const minimumProtectedProfitUsd = Math.max(0.5, accountEquityUsd * 0.0015);
            
            // 1. lockedProfitUsd: Profit guaranteed if stopped out at current stop
            // Requirement: currentStop must exist and be better than entryPrice
            let lockedProfitUsd = 0;
            if (currentStop != null && Number.isFinite(currentStop) && currentStop > 0) {
                if (side === "long") {
                    lockedProfitUsd = sizeUsd * (currentStop - entryPrice) / entryPrice;
                } else if (side === "short") {
                    lockedProfitUsd = sizeUsd * (entryPrice - currentStop) / entryPrice;
                }
            }

            console.info(JSON.stringify({
                event: "V2_TREND_LOCKED_PROFIT_PROOF",
                symbol: input.symbol,
                side,
                entryPrice,
                currentStop,
                lockedProfitUsd,
                minimumProtectedProfitUsd
            }));

            // 2. Risk Budget Calculation
            const availableRiskBudget = Math.max(0, lockedProfitUsd - minimumProtectedProfitUsd);
            const pnlPct = input.unrealizedPnlPct ?? 0;
            
            // 3. Potential New Stop (Trailing 2.2x ATR)
            const atr = input.atr ?? 0;
            const sideMultiplier = side === "long" ? -1 : 1;
            const potentialStop = markPrice + (sideMultiplier * 2.2 * atr);
            const effectiveNewStop = side === "long" 
                ? Math.max(currentStop ?? 0, potentialStop) 
                : Math.min(currentStop ?? Infinity, potentialStop);

            // 4. Add-on Sizing based on Profit Buffer
            const addonLossPctToStop = side === "long"
                ? (markPrice - effectiveNewStop) / markPrice
                : (effectiveNewStop - markPrice) / markPrice;

            const addonMaxByProfit = addonLossPctToStop > 0 ? availableRiskBudget / addonLossPctToStop : 0;
            
            // 5. Total Exposure Pyramid Limits
            const symbolMaxNotional = accountEquityUsd * 0.8;
            const globalMaxNotional = accountEquityUsd * 1.5;
            const currentSymbolNotional = input.currentSymbolNotionalUsd ?? sizeUsd;
            const currentGlobalNotional = input.currentGlobalNotionalUsd ?? currentSymbolNotional;
            
            const remainingSymbolRoom = Math.max(0, symbolMaxNotional - currentSymbolNotional);
            const remainingGlobalRoom = Math.max(0, globalMaxNotional - currentGlobalNotional);
            const liveMaxOrderNotional = input.liveMaxOrderNotionalUsdt ?? 500;

            const nextAddonNotional = Math.min(
                remainingSymbolRoom,
                remainingGlobalRoom,
                addonMaxByProfit,
                liveMaxOrderNotional
            );

            console.info(JSON.stringify({
                event: "V2_TREND_TOTAL_EXPOSURE_PYRAMID_PROOF",
                symbol: input.symbol,
                symbolMaxNotional,
                globalMaxNotional,
                currentSymbolNotional,
                currentGlobalNotional,
                remainingSymbolRoom,
                remainingGlobalRoom,
                nextAddonNotional
            }));

            // 6. worstCasePnlAfterNewStop verification
            // Calculate total PnL if stopped at effectiveNewStop after adding nextAddonNotional
            const originalWorstCase = side === "long"
                ? (effectiveNewStop - entryPrice) / entryPrice * sizeUsd
                : (entryPrice - effectiveNewStop) / entryPrice * sizeUsd;
            
            // Loss on the new add-on if stopped at effectiveNewStop
            const addonWorstCase = -nextAddonNotional * addonLossPctToStop;
            const worstCasePnlAfterNewStop = originalWorstCase + addonWorstCase;

            console.info(JSON.stringify({
                event: "V2_TREND_WORST_CASE_PNL_PROOF",
                symbol: input.symbol,
                originalWorstCase,
                addonWorstCase,
                worstCasePnlAfterNewStop,
                requiredMin: minimumProtectedProfitUsd
            }));

            const pyramidPass = 
                trendHealthy && 
                pnlPct >= 0.002 && 
                lockedProfitUsd > minimumProtectedProfitUsd && // Must have locked profit buffer
                nextAddonNotional >= 10 && // Minimum viable add-on size reduced to 10 for smaller accounts
                worstCasePnlAfterNewStop >= minimumProtectedProfitUsd;

            addOnAllowed = pyramidPass;
            
            if (pyramidPass) {
                console.info(JSON.stringify({
                    event: "V2_TREND_ADDON_BUDGET_PROOF",
                    symbol: input.symbol,
                    availableRiskBudget,
                    addonMaxByProfit,
                    nextAddonNotional,
                    addonLossPctToStop
                }));
            }

            // 7. Stop Management
            if (effectiveNewStop !== currentStop) {
                newStopPrice = effectiveNewStop;
                console.info(JSON.stringify({
                    event: "V2_TREND_STOP_PROPAGATION_PROOF",
                    symbol: input.symbol,
                    oldStop: currentStop,
                    newStop: effectiveNewStop,
                    reason: "TRAILING_ATR_PROTECTION"
                }));
            }

            partialAction = trendHealthy ? "none" : "prepare";
            exitAction = trendHealthy ? "none" : "watch";
            proofReasons.push(trendHealthy ? "TREND_CONTINUATION_HOLD" : "TREND_WEAKNESS_EXIT_WATCH");
            if (pyramidPass) proofReasons.push("PROFIT_LOCKED_PYRAMID_ACTIVE");
        } else {
            addOnAllowed = false;
            partialAction = "none";
            exitAction = input.v2Decision === "EXIT" ? "exit" : "watch";
            proofReasons.push("NON_RANGE_TREND_DEFENSIVE_MANAGEMENT");
        }
    }

    if (input.v2Decision === "EXIT") {
        exitAction = "exit";
        proofReasons.push("V2_DECISION_EXIT_CONFIRMED");
    }

    if (cooldownType !== "none" && input.v2Decision === "ENTER") {
        trueInconsistencyReasons.push("COOLDOWN_ENTER_CONFLICT");
    }
    if (input.authoritySource !== "v2") {
        trueInconsistencyReasons.push("AUTHORITY_SOURCE_NOT_V2");
    }
    if (input.adoptedEngine !== "V2") {
        trueInconsistencyReasons.push("ADOPTED_ENGINE_NOT_V2");
    }
    if (input.v2Side !== input.side && input.side !== null && input.v2Side !== null && input.v2Side !== "none") {
        trueInconsistencyReasons.push("SIDE_MISMATCH_V2_SIDE");
    }
    if (
        input.directionalShockState === "DOWN" &&
        input.side === "long" &&
        cooldownType === "risk_halt" &&
        String(input.cooldownState.reason ?? "").toLowerCase().includes("direction")
    ) {
        trueInconsistencyReasons.push("DIRECTION_BLOCK_MERGED_INTO_RISK_COOLDOWN");
    }

    // Shadow Gap Clearance: Only log as shadow gaps if not owned by V2
    if (!isV2Owner) {
        knownShadowGaps.push("PARTIAL_EXECUTION_OWNER_NOT_V2");
        knownShadowGaps.push("EXIT_EXECUTION_OWNER_NOT_V2");
        knownShadowGaps.push("COOLDOWN_OWNER_NOT_V2");
        knownShadowGaps.push("POSITION_STATE_OWNER_NOT_V2");
        knownShadowGaps.push("POST_ENTRY_EXECUTION_OWNER_PAPER_ENGINE");
    }
    
    proofReasons.push(`partial_execution_owner=${partialExecutionOwner}`);
    proofReasons.push(`exit_execution_owner=${exitExecutionOwner}`);
    proofReasons.push(`cooldown_owner=${cooldownExecutionOwner}`);
    proofReasons.push(`position_state_owner=${positionStateExecutionOwner}`);
    proofReasons.push(`post_entry_execution_owner=${postEntryExecutionOwner}`);

    if (isV2Owner && postEntryExecutionOwner === "paper_engine") {
        knownShadowGaps.push("V2_LIFECYCLE_WITH_PAPER_EXECUTION_OWNER");
        proofReasons.push("lifecycle_authority_v2_execution_owner_paper_engine");
    }

    const inconsistencyReasons = [...trueInconsistencyReasons, ...knownShadowGaps];
    const legacyInterventionDetected =
        !isV2Owner ||
        (executionOwner as string) === "paper_engine" ||
        (executionOwner as string) === "legacy" ||
        (executionOwner as string) === "unknown";
    const consistencyPass = trueInconsistencyReasons.length === 0;


    const result: V2TradeLifecycleAuthorityResult = {
        symbol: input.symbol,
        side: input.side,
        lifecycleStage,
        authoritySource: input.authoritySource,
        adoptedEngine: input.adoptedEngine,
        lifecycleAuthorityOwner,
        executionOwner,
        positionStateOwner: positionStateExecutionOwner,
        entryManagedByV2: isV2Owner,
        addOnManagedByV2: isV2Owner,
        partialManagedByV2: isV2Owner,
        exitManagedByV2: isV2Owner,
        cooldownManagedByV2: isV2Owner,
        positionStateManagedByV2: isV2Owner,
        addOnAllowed,
        partialAction,
        exitAction,
        newStopPrice,
        cooldownType,
        cooldownReason: input.cooldownState.reason,
        legacyInterventionDetected,
        consistencyPass,
        knownShadowGaps,
        trueInconsistencyReasons,
        inconsistencyReasons,
        proofReasons
    };
    return result;
}

