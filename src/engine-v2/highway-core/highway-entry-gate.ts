import { EngineV2Side, LegacyConfigAdapter, ExecutorOutput, V2CommittedRiskPlan } from "../types";
import { resolveHighwayDirectionalAuthority } from "./highway-directional-authority";

export interface HighwayEntryGateInput {
    symbol: string;
    side: EngineV2Side;
    regime: string;
    subtype?: string;
    snapshot: any;
    execution: ExecutorOutput;
    committedRiskPlan?: V2CommittedRiskPlan | null;
    config?: LegacyConfigAdapter | any;
    hasExistingPosition?: boolean;
    softExitCooldownActive?: boolean;
    directionalShockState?: string | null;
    isPreCheck?: boolean;
}

export interface HighwayEntryGateResult {
    allowed: boolean;
    finalDecision: "ENTER" | "SKIP" | "HOLD";
    rejectReason: string | null;
    symbol: string;
    side: EngineV2Side;
    regime: string;
    boxPos: number | null;
    expectedMovePct: number;
    estimatedCostPct: number;
    netEdgePct: number;
    tp1DistancePct: number;
    stopDistancePct: number;
    rewardRisk: number;
    proof: Record<string, unknown>;
}

export function evaluateHighwayCoreEntryGate(input: HighwayEntryGateInput): HighwayEntryGateResult {
    const {
        symbol,
        side,
        regime,
        subtype,
        snapshot,
        execution,
        committedRiskPlan,
        config = {},
        hasExistingPosition = false,
        softExitCooldownActive = false,
        directionalShockState = "NONE",
        isPreCheck = false
    } = input;

    const lastPrice = Number(snapshot?.lastPrice ?? 0);
    const boxPos = typeof snapshot?.boxPos === "number" && Number.isFinite(snapshot.boxPos) ? snapshot.boxPos : null;
    const boxHigh = Number(snapshot?.boxHigh ?? 0);
    const boxLow = Number(snapshot?.boxLow ?? 0);
    const atrVal = Number(snapshot?.atr20 ?? snapshot?.atr ?? 0);
    const atrPct = lastPrice > 0 && atrVal > 0 ? atrVal / lastPrice : 0.008;

    // 1. Transaction Cost Estimation (OKX execution fee authority / config)
    const takerFeeRate = Number(
        config?.okxTakerFeeRate ??
        config?.paperTakerFeeRate ??
        config?.takerFeeRate ??
        0.0005
    );
    const roundTripFeePct = takerFeeRate * 2;
    const estimatedSlippagePct = Number(config?.estimatedSlippagePct ?? 0.0003);
    const estimatedCostPct = roundTripFeePct + estimatedSlippagePct;
    const minCostMultiplier = Number(config?.highwayMinCostMultiplier ?? 2.0);
    const minRequiredMovePct = estimatedCostPct * minCostMultiplier;

    // 2. Authoritative Planned TP1 / Stop Loss Resolution (No synthetic plan fallback)
    const plannedStopPrice = Number(
        committedRiskPlan?.stopPrice ??
        execution?.stopPrice ??
        execution?.invalidationPx ??
        (execution?.metadata as any)?.plannedStopPrice ??
        (execution?.metadata as any)?.stopPrice ??
        0
    );

    const plannedTp1Price = Number(
        (committedRiskPlan as any)?.plannedTp1Price ??
        (committedRiskPlan as any)?.tp1Price ??
        (committedRiskPlan as any)?.executableTp1Price ??
        (committedRiskPlan as any)?.takeProfit1Px ??
        (execution as any)?.plannedTp1Price ??
        (execution?.metadata as any)?.plannedTp1Price ??
        (execution as any)?.tp1Price ??
        (execution?.metadata as any)?.tp1Price ??
        (execution as any)?.takeProfitPrice ??
        (execution?.metadata as any)?.takeProfitPrice ??
        (execution as any)?.takeProfit1Px ??
        (execution?.metadata as any)?.takeProfit1Px ??
        (execution as any)?.executableTp1Price ??
        (execution?.metadata as any)?.executableTp1Price ??
        (execution as any)?.takeProfitPlan?.executableTp1 ??
        (execution?.metadata as any)?.takeProfitPlan?.executableTp1 ??
        (execution as any)?.takeProfitPlan?.tp1 ??
        (execution?.metadata as any)?.takeProfitPlan?.tp1 ??
        (execution as any)?.targetPrice1 ??
        (execution?.metadata as any)?.targetPrice1 ??
        0
    );

    const hasValidStop = Number.isFinite(plannedStopPrice) && plannedStopPrice > 0;
    const hasValidTp1 = Number.isFinite(plannedTp1Price) && plannedTp1Price > 0;

    let stopDistancePct = 0;
    let tp1DistancePct = 0;
    let isPlanDirectionValid = false;

    if (hasValidStop && lastPrice > 0) {
        if (side === "long" && plannedStopPrice < lastPrice) {
            stopDistancePct = (lastPrice - plannedStopPrice) / lastPrice;
        } else if (side === "short" && plannedStopPrice > lastPrice) {
            stopDistancePct = (plannedStopPrice - lastPrice) / lastPrice;
        }
    }

    if (hasValidTp1 && lastPrice > 0) {
        if (side === "long" && plannedTp1Price > lastPrice) {
            tp1DistancePct = (plannedTp1Price - lastPrice) / lastPrice;
        } else if (side === "short" && plannedTp1Price < lastPrice) {
            tp1DistancePct = (lastPrice - plannedTp1Price) / lastPrice;
        }
    }

    if (stopDistancePct > 0 && tp1DistancePct > 0) {
        isPlanDirectionValid = true;
    }

    const executionReasonStr = String(execution?.reason ?? "").toLowerCase();
    const execMeta = (execution?.metadata ?? {}) as Record<string, unknown>;
    const subtypeStr = String(subtype ?? "").toUpperCase();
    const isNonRangeLineage =
        subtypeStr === "FAST_TREND_SHIFT" ||
        subtypeStr === "EARLY_LONG_PROBE" ||
        subtypeStr === "EARLY_SHORT_PROBE" ||
        subtypeStr.includes("TREND") ||
        subtypeStr.includes("BREAKOUT") ||
        subtypeStr.includes("BREAKDOWN") ||
        subtypeStr.includes("CONTINUATION") ||
        executionReasonStr.includes("trend") ||
        executionReasonStr.includes("continuation") ||
        executionReasonStr.includes("breakout") ||
        executionReasonStr.includes("breakdown") ||
        executionReasonStr.includes("fast_shift") ||
        executionReasonStr.includes("fast_trend") ||
        execMeta.trend_continuation === true ||
        execMeta.fast_trend_shift === true;

    // 3. Conservative reachable Expected Move based on actual planned TP1 (no artificial floor)
    let structureRoom: number | null = null;
    if (regime === "RANGE" && boxHigh > 0 && boxLow > 0 && lastPrice > 0) {
        if (side === "long") {
            structureRoom = Math.max(0, (boxHigh - lastPrice) / lastPrice);
        } else if (side === "short") {
            structureRoom = Math.max(0, (lastPrice - boxLow) / lastPrice);
        }
    }

    let expectedMovePct = 0;
    let expectedMoveSource: "tp1_distance" | "range_box_cap" | "zero_plan" = "zero_plan";

    if (tp1DistancePct > 0) {
        if (regime === "RANGE" && !isNonRangeLineage && structureRoom !== null) {
            if (structureRoom < tp1DistancePct) {
                expectedMovePct = structureRoom;
                expectedMoveSource = "range_box_cap";
            } else {
                expectedMovePct = tp1DistancePct;
                expectedMoveSource = "tp1_distance";
            }
        } else {
            expectedMovePct = tp1DistancePct;
            expectedMoveSource = "tp1_distance";
        }
    }

    const netEdgePct = expectedMovePct - estimatedCostPct;
    const rewardRisk = stopDistancePct > 0 ? (tp1DistancePct / stopDistancePct) : 0;
    const minRewardRisk = Number(config?.highwayMinRewardRisk ?? 1.2);

    // ── HIGHWAY CORE DECISION PIPELINE (STRICT ORDER) ──────────────────────
    let allowed = true;
    let finalDecision: "ENTER" | "SKIP" | "HOLD" = "ENTER";
    let rejectReason: string | null = null;
    let highwayAuthForProof: ReturnType<typeof resolveHighwayDirectionalAuthority> | null = null;
    let rawBoxPos: number | null = null;
    let breakoutDistancePct = 0;
    let minPenetrationPct = 0;
    let chaseCapPct = 0;
    let initialBreakoutExempt = false;
    let chaseRiskReason: string | null = null;

    // Step 0: Directional validity & Cooldown check
    if (side !== "long" && side !== "short") {
        allowed = false;
        finalDecision = "HOLD";
        rejectReason = "NO_DIRECTIONAL_SIDE";
    } else if (softExitCooldownActive && !hasExistingPosition) {
        allowed = false;
        finalDecision = "HOLD";
        rejectReason = "SOFT_EXIT_COOLDOWN_ACTIVE";
    } else if (!isPreCheck && (!hasValidStop || !hasValidTp1 || !isPlanDirectionValid)) {
        // At final execution gate, missing planned TP1 or committed stop is a hard fail-closed
        allowed = false;
        finalDecision = "SKIP";
        rejectReason = "HIGHWAY_PLAN_MISSING";
    }

    // Step 1: 시장장세 (Market Regime & Highway Directional Consensus)
    if (allowed) {
        if (regime === "NO_TRADE" || regime === "UNKNOWN" || regime === "CHOP") {
            allowed = false;
            finalDecision = "HOLD";
            rejectReason = "REGIME_UNFAVORABLE";
        } else {
            highwayAuthForProof = resolveHighwayDirectionalAuthority({
                snapshot,
                candles: snapshot?.candles,
                symbol,
                lastPrice
            });
            const highwayAuth = highwayAuthForProof;

            if (side === "short" && highwayAuth.strongUp) {
                allowed = false;
                finalDecision = "SKIP";
                rejectReason = "OPPOSING_STRONG_HIGHWAY_UP_ACTIVE";
            } else if (side === "long" && highwayAuth.strongDown) {
                allowed = false;
                finalDecision = "SKIP";
                rejectReason = "OPPOSING_STRONG_HIGHWAY_DOWN_ACTIVE";
            } else if (directionalShockState === "DOWN" && side === "long") {
                const isBtcMrBypass = (execution?.metadata as any)?.isBtcRangeMrStaleDownShockBypass === true;
                const hasReclaim = (execution?.metadata as any)?.reclaimConfirmed === true;
                const isLongReversalWatch =
                    (execution?.metadata as any)?.long_reversal_watch_promoted === true ||
                    (execution?.metadata as any)?.entryReason === "V2_LONG_REVERSAL_WATCH_PROBE" ||
                    (execution?.metadata as any)?.entryReason === "V2_LONG_REVERSAL_HTF_UPGRADED_AUTHORITY" ||
                    (execution?.metadata as any)?.isProbe === true;
                if (!hasReclaim && !isLongReversalWatch && !isBtcMrBypass) {
                    allowed = false;
                    finalDecision = "HOLD";
                    rejectReason = "OPPOSING_DOWN_SHOCK_ACTIVE";
                }
            } else if (directionalShockState === "UP" && side === "short") {
                const isBtcMrBypass = (execution?.metadata as any)?.isBtcRangeMrStaleUpShockBypass === true;
                const hasReclaim = (execution?.metadata as any)?.reclaimConfirmed === true;
                const isShortReversalWatch =
                    (execution?.metadata as any)?.short_reversal_watch_promoted === true ||
                    (execution?.metadata as any)?.entryReason === "V2_SHORT_REVERSAL_WATCH_PROBE" ||
                    (execution?.metadata as any)?.entryReason === "V2_SHORT_REVERSAL_HTF_UPGRADED_AUTHORITY" ||
                    (execution?.metadata as any)?.isProbe === true;
                if (!hasReclaim && !isShortReversalWatch && !isBtcMrBypass) {
                    allowed = false;
                    finalDecision = "HOLD";
                    rejectReason = "OPPOSING_UP_SHOCK_ACTIVE";
                }
            }
        }
    }

    // Step 2: 위치 (Position / Location / Structure)
    if (allowed) {
        if (regime === "RANGE" && !isNonRangeLineage && boxPos !== null) {
            // RANGE: Suppress box middle chase. Only allow entry evaluation at edges for canonical RANGE mean-reversion.
            if (side === "long" && boxPos > 0.35) {
                allowed = false;
                finalDecision = "SKIP";
                rejectReason = "RANGE_MIDDLE_CHASE_BLOCKED_LONG";
            } else if (side === "short" && boxPos < 0.65) {
                allowed = false;
                finalDecision = "SKIP";
                rejectReason = "RANGE_MIDDLE_CHASE_BLOCKED_SHORT";
            }
        } else if (regime === "TREND" || subtype === "FAST_TREND_SHIFT" || isNonRangeLineage) {
            const meta = (execution?.metadata ?? {}) as Record<string, unknown>;
            const structureOk =
                meta.retestConfirmed === true ||
                meta.reclaimConfirmed === true ||
                meta.pullbackConfirmed === true ||
                meta.continuationPhase === "RETEST_TOUCHED" ||
                meta.fast_trend_shift === true ||
                meta.early_probe === true;

            const highwayAuth =
                highwayAuthForProof ??
                resolveHighwayDirectionalAuthority({
                    snapshot,
                    candles: snapshot?.candles,
                    symbol,
                    lastPrice
                });
            const tw = Number(snapshot?.trendWeaknessScore ?? 0);
            const emaGap = Number(snapshot?.emaGap ?? highwayAuth.emaGap ?? 0);
            const tickSz = Number(snapshot?.tickSz ?? config?.tickSz ?? 0.1);
            const closedCloseRaw =
                typeof snapshot?.closedClose === "number" && Number.isFinite(snapshot.closedClose)
                    ? snapshot.closedClose
                    : Array.isArray(snapshot?.candles) && snapshot.candles.length >= 2
                      ? Number(snapshot.candles[snapshot.candles.length - 2]?.close ?? NaN)
                      : null;
            const closedClose =
                closedCloseRaw != null && Number.isFinite(closedCloseRaw) ? closedCloseRaw : null;
            const boxWidth = boxHigh > boxLow ? boxHigh - boxLow : 0;
            if (boxHigh > boxLow && lastPrice > 0) {
                rawBoxPos = (lastPrice - boxLow) / (boxHigh - boxLow);
            }

            const isLong = side === "long";
            const isShort = side === "short";
            if (isLong || isShort) {
                const boundary = isLong ? boxHigh : boxLow;
                const minPenAbs = Math.max(
                    boxWidth > 0 ? boxWidth * 0.08 : 0,
                    atrVal > 0 ? atrVal * 0.2 : 0,
                    5 * tickSz,
                    boundary > 0 ? boundary * 0.0005 : 0
                );
                minPenetrationPct = boundary > 0 ? minPenAbs / boundary : 0;
                const chaseCapMultiplier = Number(config?.highwayChaseCapMultiplier ?? 1.25);
                chaseCapPct = Number(
                    config?.highwayChaseCapPct ?? minPenetrationPct * chaseCapMultiplier
                );
                breakoutDistancePct = isLong
                    ? lastPrice > boxHigh && boxHigh > 0
                        ? (lastPrice - boxHigh) / boxHigh
                        : 0
                    : lastPrice < boxLow && boxLow > 0
                      ? (boxLow - lastPrice) / boxLow
                      : 0;

                const distanceOk = breakoutDistancePct <= chaseCapPct;
                const closedBreak = isLong
                    ? closedClose != null && boxHigh > 0 && closedClose > boxHigh
                    : closedClose != null && boxLow > 0 && closedClose < boxLow;
                const livePen = isLong
                    ? lastPrice > boxHigh && lastPrice - boxHigh >= minPenAbs
                    : lastPrice < boxLow && boxLow - lastPrice >= minPenAbs;
                // Price-confirmed break only (boxBreakSide alone can be stale; see index.ts upper/lower evidence)
                const breakAuthorityOk = closedBreak || livePen;
                const alignmentOk = isLong
                    ? highwayAuth.strongUp === true && emaGap > 0
                    : highwayAuth.strongDown === true && emaGap < 0;

                initialBreakoutExempt =
                    distanceOk && breakAuthorityOk && (alignmentOk || structureOk);

                const extremeLocation = isLong
                    ? (boxPos !== null && boxPos > 0.90) || (rawBoxPos != null && rawBoxPos > 1.02)
                    : (boxPos !== null && boxPos < 0.10) || (rawBoxPos != null && rawBoxPos < -0.02);

                let chaseRisk = false;
                if (extremeLocation && !initialBreakoutExempt) {
                    if (breakoutDistancePct > chaseCapPct) {
                        chaseRisk = true;
                        chaseRiskReason = "BREAKOUT_DISTANCE_ABOVE_CHASE_CAP";
                    } else if (tw > 0.6) {
                        chaseRisk = true;
                        chaseRiskReason = "TREND_WEAKNESS_HIGH_NO_EXEMPT";
                    } else if (rawBoxPos != null && (isLong ? rawBoxPos > 1.05 : rawBoxPos < -0.05)) {
                        chaseRisk = true;
                        chaseRiskReason = "RAW_BOX_OVEREXTENSION";
                    } else if (
                        isLong
                            ? !highwayAuth.strongUp && rawBoxPos != null && rawBoxPos > 1.0
                            : !highwayAuth.strongDown && rawBoxPos != null && rawBoxPos < 0.0
                    ) {
                        chaseRisk = true;
                        chaseRiskReason = isLong
                            ? "UPPER_EXTENSION_WITHOUT_STRONG_UP"
                            : "LOWER_EXTENSION_WITHOUT_STRONG_DOWN";
                    }
                }

                if (extremeLocation && chaseRisk) {
                    allowed = false;
                    finalDecision = "SKIP";
                    rejectReason = isLong
                        ? "TREND_EXTREME_CHASE_BLOCKED_LONG"
                        : "TREND_EXTREME_CHASE_BLOCKED_SHORT";
                }
            }
        }
    }

    const isBtcMrBypass =
        (execution?.metadata as any)?.isBtcRangeMrStaleDownShockBypass === true ||
        (execution?.metadata as any)?.isBtcRangeMrStaleUpShockBypass === true;

    // Step 3 & 4: Expected Move & Transaction Cost Edge (evaluated if plan exists or at final gate)
    if (allowed && (hasValidStop && hasValidTp1 && isPlanDirectionValid)) {
        if (expectedMovePct < minRequiredMovePct && !isBtcMrBypass) {
            allowed = false;
            finalDecision = "SKIP";
            rejectReason = "INSUFFICIENT_EXPECTED_MOVE_OVER_COST";
        }
    }

    // Step 5: Reward / Risk (RR)
    if (allowed && (hasValidStop && hasValidTp1 && isPlanDirectionValid)) {
        if (rewardRisk < minRewardRisk && !isBtcMrBypass) {
            allowed = false;
            finalDecision = "SKIP";
            rejectReason = "POOR_REWARD_RISK_RATIO";
        }
    }

    const proof = {
        event: "HIGHWAY_ENTRY_GATE_PROOF",
        symbol,
        side,
        regime,
        boxPos,
        raw_box_pos: rawBoxPos != null ? Number(rawBoxPos.toFixed(6)) : null,
        breakout_distance_pct: Number(breakoutDistancePct.toFixed(6)),
        min_penetration_pct: Number(minPenetrationPct.toFixed(6)),
        chase_cap_pct: Number(chaseCapPct.toFixed(6)),
        initial_breakout_exempt: initialBreakoutExempt,
        chase_risk_reason: chaseRiskReason,
        isPreCheck,
        non_range_lineage: isNonRangeLineage,
        expected_move_source: expectedMoveSource,
        structure_room_pct: structureRoom !== null ? Number(structureRoom.toFixed(6)) : null,
        effective_min_required_move_pct: Number(minRequiredMovePct.toFixed(6)),
        expectedMovePct: Number(expectedMovePct.toFixed(6)),
        estimatedCostPct: Number(estimatedCostPct.toFixed(6)),
        netEdgePct: Number(netEdgePct.toFixed(6)),
        tp1DistancePct: Number(tp1DistancePct.toFixed(6)),
        stopDistancePct: Number(stopDistancePct.toFixed(6)),
        rewardRisk: Number(rewardRisk.toFixed(3)),
        atrPct: Number(atrPct.toFixed(6)),
        finalDecision,
        rejectReason
    };

    console.info(JSON.stringify(proof));

    return {
        allowed,
        finalDecision,
        rejectReason,
        symbol,
        side,
        regime,
        boxPos,
        expectedMovePct,
        estimatedCostPct,
        netEdgePct,
        tp1DistancePct,
        stopDistancePct,
        rewardRisk,
        proof
    };
}
