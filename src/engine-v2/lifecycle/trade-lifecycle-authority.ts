import type { V2TradeLifecycleAuthorityInput, V2TradeLifecycleAuthorityResult, V2CooldownType, V2LifecycleStage } from "../types";
import { classifyRangeZone } from "../../models/types";

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
    const rangeMid = typeof boxPos === "number" && Number.isFinite(boxPos) && classifyRangeZone(boxPos) === "mid";
    const trendHealthy = input.rawMetricsSummary.trendWeaknessScore <= 0.55;

    let result_givebackPct: number | undefined;
    let result_guardThresholdPct: number | undefined;
    let result_guardAction: string | undefined;

    let addOnAllowed: boolean | null = null;
    let newStopPrice: number | undefined;
    let nextAddonNotional: number | undefined;
    let partialAction: V2TradeLifecycleAuthorityResult["partialAction"] = "none";
    let partialReason: string | null = null;
    let exitAction: V2TradeLifecycleAuthorityResult["exitAction"] = "none";
    let exitReason: string | null = null;
    let reduceRatio: number | null = null;
    
    let tp1TriggeredResult: boolean | undefined;
    let tp2TriggeredResult: boolean | undefined;
    let tp1PxResult: number | undefined;
    let tp2PxResult: number | undefined;

    if (input.position != null) {
        if (input.regime === "RANGE") {
            // --- DRIFT_REVERSAL_GUARD (V2 Structure-Aware & Symmetrical) ---
            const isReversalUpWatch = input.rawMetricsSummary.subtype === "DRIFT_REVERSAL_UP_WATCH";
            const isReversalDownWatch = input.rawMetricsSummary.subtype === "DRIFT_REVERSAL_DOWN_WATCH";
            const isDriftDownRegime = input.rawMetricsSummary.subtype === "RANGE_DRIFT_DOWN" || input.rawMetricsSummary.subtype === "DESCENDING_CHANNEL";
            const isDriftUpRegime = input.rawMetricsSummary.subtype === "RANGE_DRIFT_UP" || input.rawMetricsSummary.subtype === "ASCENDING_CHANNEL";
            
            let structuralReversalDetected = false;
            let structuralReversalReason = "";

            const swingHSlope = input.rawMetricsSummary.swingHighSlope ?? 0;
            const swingLSlope = input.rawMetricsSummary.swingLowSlope ?? 0;
            const atrExp = input.rawMetricsSummary.atrExpansion ?? 0;

            if (isDriftDownRegime && input.side === "short") {
                if (swingHSlope > 0.0005 || atrExp > 2.0) {
                    structuralReversalDetected = true;
                    structuralReversalReason = `SHARP_UPWARD_REVERSAL_IN_DRIFT_DOWN (swingHSlope: ${swingHSlope.toFixed(5)}, atrExp: ${atrExp.toFixed(2)})`;
                }
            } else if (isDriftUpRegime && input.side === "long") {
                if (swingLSlope < -0.0005 || atrExp > 2.0) {
                    structuralReversalDetected = true;
                    structuralReversalReason = `SHARP_DOWNWARD_REVERSAL_IN_DRIFT_UP (swingLSlope: ${swingLSlope.toFixed(5)}, atrExp: ${atrExp.toFixed(2)})`;
                }
            }

            // [HARDENED] RANGE TP Plan Execution
            const tpPlan = input.takeProfitPlan;
            if (tpPlan && input.position != null) {
                const lastPx = input.markPrice || 0;
                if (input.side === "long") {
                    // TP2 check first (Full close priority)
                    if (lastPx >= tpPlan.tp2 && !input.tp2Triggered) {
                        tp2TriggeredResult = true;
                        tp2PxResult = tpPlan.tp2;
                        exitAction = "exit";
                        exitReason = "V2_RANGE_TAKE_PROFIT_2_EXIT";
                        
                        console.info(JSON.stringify({
                            event: "V2_RANGE_TP2_TRIGGER_PROOF",
                            symbol: input.symbol,
                            side: input.side,
                            markPrice: lastPx,
                            targetPrice: tpPlan.tp2
                        }));
                    }
                    
                    // TP1 check (only if TP2 not triggered in this tick)
                    if (!tp2TriggeredResult && lastPx >= tpPlan.tp1 && !input.tp1Triggered) {
                        tp1TriggeredResult = true;
                        tp1PxResult = tpPlan.tp1;
                        partialAction = "reduce";
                        partialReason = "V2_RANGE_TAKE_PROFIT_1_REDUCE";
                        reduceRatio = 0.5;
                        
                        console.info(JSON.stringify({
                            event: "V2_RANGE_TP1_TRIGGER_PROOF",
                            symbol: input.symbol,
                            side: input.side,
                            markPrice: lastPx,
                            targetPrice: tpPlan.tp1
                        }));
                    } else if (tp2TriggeredResult && lastPx >= tpPlan.tp1 && !input.tp1Triggered) {
                        console.info(JSON.stringify({
                            event: "V2_RANGE_TP2_SUPPRESS_TP1_SAME_TICK_PROOF",
                            symbol: input.symbol,
                            side: input.side,
                            markPrice: lastPx,
                            tp1: tpPlan.tp1,
                            tp2: tpPlan.tp2
                        }));
                    }
                } else if (input.side === "short") {
                    // TP2 check first
                    if (lastPx <= tpPlan.tp2 && !input.tp2Triggered) {
                        tp2TriggeredResult = true;
                        tp2PxResult = tpPlan.tp2;
                        exitAction = "exit";
                        exitReason = "V2_RANGE_TAKE_PROFIT_2_EXIT";
                        
                        console.info(JSON.stringify({
                            event: "V2_RANGE_TP2_TRIGGER_PROOF",
                            symbol: input.symbol,
                            side: input.side,
                            markPrice: lastPx,
                            targetPrice: tpPlan.tp2
                        }));
                    }
                    
                    // TP1 check
                    if (!tp2TriggeredResult && lastPx <= tpPlan.tp1 && !input.tp1Triggered) {
                        tp1TriggeredResult = true;
                        tp1PxResult = tpPlan.tp1;
                        partialAction = "reduce";
                        partialReason = "V2_RANGE_TAKE_PROFIT_1_REDUCE";
                        reduceRatio = 0.5;
                        
                        console.info(JSON.stringify({
                            event: "V2_RANGE_TP1_TRIGGER_PROOF",
                            symbol: input.symbol,
                            side: input.side,
                            markPrice: lastPx,
                            targetPrice: tpPlan.tp1
                        }));
                    } else if (tp2TriggeredResult && lastPx <= tpPlan.tp1 && !input.tp1Triggered) {
                        console.info(JSON.stringify({
                            event: "V2_RANGE_TP2_SUPPRESS_TP1_SAME_TICK_PROOF",
                            symbol: input.symbol,
                            side: input.side,
                            markPrice: lastPx,
                            tp1: tpPlan.tp1,
                            tp2: tpPlan.tp2
                        }));
                    }
                }
            }

            // --- VOLUME_SHOCK_GUARD (V2 Symmetrical Protection) ---
            const subtype = input.rawMetricsSummary.subtype;
            const isVolDownShock = subtype === "VOLUME_SHOCK_DOWN" || subtype === "VOLUME_BREAKDOWN_OBSERVATION";
            const isVolUpShock = subtype === "VOLUME_SHOCK_UP" || subtype === "VOLUME_BREAKOUT_OBSERVATION";

            if (isVolDownShock || isVolUpShock) {
                const shockDirection = isVolDownShock ? "down" : "up";
                const threatenedSide = shockDirection === "down" ? "long" : "short";
                const isPositionThreatened = input.side === threatenedSide;

                if (isPositionThreatened) {
                    addOnAllowed = false;
                    const isSevere = subtype.includes("SHOCK");
                    exitAction = isSevere ? "exit" : "watch";
                    
                    const tightStopAtr = 0.4;
                    const sideMultiplier = input.side === "long" ? -1 : 1;
                    const tightStop = (input.markPrice ?? input.position.entryPrice) + (sideMultiplier * tightStopAtr * (input.atr ?? 0));
                    
                    newStopPrice = input.side === "long"
                        ? Math.max(input.currentStopPrice ?? 0, tightStop)
                        : Math.min(input.currentStopPrice ?? Infinity, tightStop);

                    proofReasons.push(`VOLUME_${shockDirection.toUpperCase()}_SHOCK_POSITION_PROTECT`);
                    
                    console.info(JSON.stringify({
                        event: "V2_VOLUME_SHOCK_POSITION_PROTECT_PROOF",
                        symbol: input.symbol,
                        shockDirection,
                        threatenedSide,
                        isSevere,
                        stopTightened: newStopPrice !== input.currentStopPrice,
                        action: exitAction,
                        subtype
                    }));
                }
            }

            if (isReversalUpWatch || isReversalDownWatch || structuralReversalDetected) {
                const reversalDirection = (isReversalUpWatch || (structuralReversalDetected && isDriftDownRegime)) ? "up" : "down";
                const protectedSide = reversalDirection === "up" ? "short" : "long";
                const blockedNewSide = reversalDirection === "up" ? "long" : "short";
                const symmetryCase = reversalDirection === "up" ? "REVERSAL_UP_SYMMETRY" : "REVERSAL_DOWN_SYMMETRY";

                addOnAllowed = false;
                const isPositionThreatened = input.side === protectedSide;
                
                if (isPositionThreatened) {
                    exitAction = "exit"; 
                    proofReasons.push("DRIFT_REVERSAL_POSITION_PROTECT_EXIT");
                    
                    // Tighten stop as a fail-safe even if exit is pending
                    const tightStopAtr = 0.5;
                    const sideMultiplier = input.side === "long" ? -1 : 1;
                    const tightStop = (input.markPrice ?? input.position.entryPrice) + (sideMultiplier * tightStopAtr * (input.atr ?? 0));
                    newStopPrice = input.side === "long" 
                        ? Math.max(input.currentStopPrice ?? 0, tightStop)
                        : Math.min(input.currentStopPrice ?? Infinity, tightStop);

                    console.info(JSON.stringify({
                        event: "V2_DRIFT_REVERSAL_GUARD_PROOF",
                        symbol: input.symbol,
                        reversalDirection,
                        protectedSide,
                        blockedNewSide,
                        stopTightened: newStopPrice !== input.currentStopPrice,
                        partialOrFullExitSuggested: "FULL",
                        symmetryCase,
                        reason: structuralReversalReason || "WATCH_THREATENED",
                        action: "PROTECT_EXIT"
                    }));
                } else {
                    // Position is aligned with reversal or neutral
                    exitAction = "watch";
                    proofReasons.push("DRIFT_REVERSAL_WATCH_ACTIVE");
                }
            } else {
                addOnAllowed = rangeEdge && !rangeMid;
                partialAction = (input.unrealizedPnlPct ?? 0) >= 0.003 && rangeEdge ? "protect_profit" : "prepare";
                exitAction = rangeMid && (input.unrealizedPnlPct ?? 0) >= 0.002 ? "watch" : "none";
                proofReasons.push(rangeEdge ? "RANGE_EDGE_MANAGEMENT" : "RANGE_MID_CONSERVATIVE_MANAGEMENT");
            }
        } else if (input.regime === "TREND") {
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

            nextAddonNotional = input.finalAddonNotionalUsdt ?? Math.min(
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
            const addonWorstCase = -(nextAddonNotional ?? 0) * addonLossPctToStop;
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
                (nextAddonNotional ?? 0) >= 10 && // Minimum viable add-on size reduced to 10 for smaller accounts
                worstCasePnlAfterNewStop >= minimumProtectedProfitUsd;

            // --- TREND_GIVEBACK_GUARD (NEW) ---
            const peakPnlPct = input.peakUnrealizedPnlPct ?? 0;
            let givebackPct = 0;
            if (peakPnlPct > 0) {
                const pnlDrawdown = peakPnlPct - pnlPct;
                givebackPct = (pnlDrawdown / peakPnlPct) * 100;
            }

            let guardAction = "none";
            let guardThresholdPct = 0;
            let guardTriggered = false;

            if (peakPnlPct >= 0.005) {
                if (peakPnlPct >= 0.018 && givebackPct >= 30) {
                    guardAction = "FULL_EXIT_GIVEBACK_PROTECT";
                    guardThresholdPct = 30;
                    guardTriggered = true;
                } else if (peakPnlPct >= 0.010 && givebackPct >= 40) {
                    guardAction = "PARTIAL_50_GIVEBACK_PROTECT";
                    guardThresholdPct = 40;
                    guardTriggered = true;
                } else if (peakPnlPct >= 0.005 && givebackPct >= 50) {
                    guardAction = "PARTIAL_30_GIVEBACK_PROTECT";
                    guardThresholdPct = 50;
                    guardTriggered = true;
                }
            }

            // Trend Invalidation Guard
            if (!trendHealthy) {
                if (pnlPct >= 0.003) {
                    guardAction = "TREND_PROFIT_FULL_TAKE_ON_INVALIDATION";
                    guardTriggered = true;
                } else if (pnlPct < -0.01) { // Example threshold for defensive
                    guardAction = "TREND_DEFENSIVE_FULL_EXIT_ON_INVALIDATION";
                    guardTriggered = true;
                }
            }

            if (guardTriggered) {
                console.info(JSON.stringify({
                    event: "V2_TREND_GIVEBACK_GUARD_PROOF",
                    symbol: input.symbol,
                    side,
                    current_pnl_pct: pnlPct,
                    peak_pnl_pct: peakPnlPct,
                    giveback_pct: givebackPct,
                    guard_threshold_pct: guardThresholdPct,
                    guard_action: guardAction
                }));

                // Guard overrides Add-on
                addOnAllowed = false;
                proofReasons.push(`TREND_GIVEBACK_GUARD_${guardAction}`);

                if (guardAction.includes("FULL_EXIT")) {
                    exitAction = "exit";
                } else if (guardAction.includes("PARTIAL_50")) {
                    partialAction = "reduce";
                    // reduceRatio logic would go here if handled by result
                } else if (guardAction.includes("PARTIAL_30")) {
                    partialAction = "protect_profit";
                }

                // Never-worsen stop tightening
                const tightStopAtr = guardAction.includes("PARTIAL") ? 1.2 : 0.8;
                const potentialTightStop = markPrice + (sideMultiplier * tightStopAtr * atr);
                const tightStop = side === "long"
                    ? Math.max(effectiveNewStop, potentialTightStop)
                    : Math.min(effectiveNewStop, potentialTightStop);
                
                if (tightStop !== effectiveNewStop) {
                    newStopPrice = tightStop;
                    console.info(JSON.stringify({
                        event: "V2_TREND_GUARD_STOP_TIGHTEN_PROOF",
                        symbol: input.symbol,
                        side,
                        base_stop: effectiveNewStop,
                        tight_stop: tightStop,
                        guard_action: guardAction
                    }));
                }
            }

            addOnAllowed = pyramidPass && !guardTriggered;
            
            if (pyramidPass && !guardTriggered) {
                console.info(JSON.stringify({
                    event: "V2_TREND_ADDON_BUDGET_PROOF",
                    symbol: input.symbol,
                    availableRiskBudget,
                    addonMaxByProfit,
                    nextAddonNotional,
                    addonLossPctToStop
                }));
            }

            // 7. Stop Management (Finalized)
            if (newStopPrice == null && effectiveNewStop !== currentStop) {
                newStopPrice = effectiveNewStop;
            }

            if (newStopPrice != null && newStopPrice !== currentStop) {
                console.info(JSON.stringify({
                    event: "V2_TREND_STOP_PROPAGATION_PROOF",
                    symbol: input.symbol,
                    oldStop: currentStop,
                    newStop: newStopPrice,
                    reason: guardTriggered ? "GIVEBACK_GUARD_TIGHTENING" : "TRAILING_ATR_PROTECTION"
                }));
            }

            // Update result metadata
            result_givebackPct = givebackPct;
            result_guardThresholdPct = guardThresholdPct;
            result_guardAction = guardAction;

            partialAction = (guardTriggered && partialAction !== "none") ? partialAction : (trendHealthy ? "none" : "prepare");
            exitAction = (guardTriggered && exitAction !== "none") ? exitAction : (trendHealthy ? "none" : "watch");
            proofReasons.push(trendHealthy ? "TREND_CONTINUATION_HOLD" : "TREND_WEAKNESS_EXIT_WATCH");
            if (pyramidPass && !guardTriggered) proofReasons.push("PROFIT_LOCKED_PYRAMID_ACTIVE");
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
        addOnAllowed: addOnAllowed ?? false,
        nextAddonNotional,
        partialAction,
        partialReason,
        exitAction,
        exitReason,
        reduceRatio,
        newStopPrice,
        givebackPct: result_givebackPct,
        guardThresholdPct: result_guardThresholdPct,
        guardAction: result_guardAction,
        cooldownType,
        cooldownReason: input.cooldownState.reason,
        legacyInterventionDetected,
        consistencyPass,
        knownShadowGaps,
        trueInconsistencyReasons,
        inconsistencyReasons,
        proofReasons,
        tp1Triggered: tp1TriggeredResult,
        tp2Triggered: tp2TriggeredResult,
        takeProfit1Px: tp1PxResult,
        takeProfit2Px: tp2PxResult
    };
    return result;
}

