import { EngineV2Side, LegacyConfigAdapter, ExecutorOutput, V2CommittedRiskPlan } from "../types";

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
        0
    );

    const plannedTp1Price = Number(
        (committedRiskPlan as any)?.plannedTp1Price ??
        (committedRiskPlan as any)?.tp1Price ??
        (execution as any)?.tp1Price ??
        (execution?.metadata as any)?.tp1Price ??
        (execution as any)?.takeProfitPrice ??
        (execution?.metadata as any)?.takeProfitPrice ??
        (execution?.metadata as any)?.plannedTp1Price ??
        0
    );

    const hasValidStop = Number.isFinite(plannedStopPrice) && plannedStopPrice > 0;
    const hasValidTp1 = Number.isFinite(plannedTp1Price) && plannedTp1Price > 0;

    let stopDistancePct = 0;
    let tp1DistancePct = 0;
    let isPlanDirectionValid = false;

    if (hasValidStop && hasValidTp1 && lastPrice > 0) {
        if (side === "long") {
            isPlanDirectionValid = plannedStopPrice < lastPrice && plannedTp1Price > lastPrice;
            stopDistancePct = (lastPrice - plannedStopPrice) / lastPrice;
            tp1DistancePct = (plannedTp1Price - lastPrice) / lastPrice;
        } else if (side === "short") {
            isPlanDirectionValid = plannedStopPrice > lastPrice && plannedTp1Price < lastPrice;
            stopDistancePct = (plannedStopPrice - lastPrice) / lastPrice;
            tp1DistancePct = (lastPrice - plannedTp1Price) / lastPrice;
        }
    }

    // 3. Conservative reachable Expected Move based on actual planned TP1 (no artificial floor)
    let structureRoom: number | null = null;
    if (regime === "RANGE" && boxHigh > 0 && boxLow > 0 && lastPrice > 0) {
        if (side === "long") {
            structureRoom = Math.max(0, (boxHigh - lastPrice) / lastPrice);
        } else if (side === "short") {
            structureRoom = Math.max(0, (lastPrice - boxLow) / lastPrice);
        }
    }

    const candidateExpectedMove = structureRoom !== null
        ? Math.min(tp1DistancePct, structureRoom)
        : tp1DistancePct;
    const expectedMovePct = tp1DistancePct > 0
        ? Math.min(candidateExpectedMove, atrPct * 2.0)
        : 0;

    const netEdgePct = expectedMovePct - estimatedCostPct;
    const rewardRisk = stopDistancePct > 0 ? (tp1DistancePct / stopDistancePct) : 0;
    const minRewardRisk = Number(config?.highwayMinRewardRisk ?? 1.2);

    // ── HIGHWAY CORE DECISION PIPELINE (STRICT ORDER) ──────────────────────
    let allowed = true;
    let finalDecision: "ENTER" | "SKIP" | "HOLD" = "ENTER";
    let rejectReason: string | null = null;

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

    // Step 1: 시장장세 (Market Regime)
    if (allowed) {
        if (regime === "NO_TRADE" || regime === "UNKNOWN" || regime === "CHOP") {
            allowed = false;
            finalDecision = "HOLD";
            rejectReason = "REGIME_UNFAVORABLE";
        } else if (directionalShockState === "DOWN" && side === "long") {
            const hasReclaim = (execution?.metadata as any)?.reclaimConfirmed === true;
            if (!hasReclaim) {
                allowed = false;
                finalDecision = "HOLD";
                rejectReason = "OPPOSING_DOWN_SHOCK_ACTIVE";
            }
        } else if (directionalShockState === "UP" && side === "short") {
            const hasReclaim = (execution?.metadata as any)?.reclaimConfirmed === true;
            if (!hasReclaim) {
                allowed = false;
                finalDecision = "HOLD";
                rejectReason = "OPPOSING_UP_SHOCK_ACTIVE";
            }
        }
    }

    // Step 2: 위치 (Position / Location / Structure)
    if (allowed) {
        if (regime === "RANGE" && boxPos !== null) {
            // RANGE: Suppress box middle chase. Only allow entry evaluation at edges.
            if (side === "long" && boxPos > 0.35) {
                allowed = false;
                finalDecision = "SKIP";
                rejectReason = "RANGE_MIDDLE_CHASE_BLOCKED_LONG";
            } else if (side === "short" && boxPos < 0.65) {
                allowed = false;
                finalDecision = "SKIP";
                rejectReason = "RANGE_MIDDLE_CHASE_BLOCKED_SHORT";
            }
        } else if (regime === "TREND" || subtype === "FAST_TREND_SHIFT") {
            // TREND / FAST_TREND_SHIFT: Do not blindly chase extreme tops/bottoms without retest/reclaim
            const meta = (execution?.metadata ?? {}) as Record<string, unknown>;
            const hasStructureEvidence =
                meta.retestConfirmed === true ||
                meta.reclaimConfirmed === true ||
                meta.pullbackConfirmed === true ||
                meta.continuationPhase === "RETEST_TOUCHED";

            const tw = Number(snapshot?.trendWeaknessScore ?? 0);
            if (side === "long" && boxPos !== null && boxPos > 0.90 && tw > 0.60 && !hasStructureEvidence) {
                allowed = false;
                finalDecision = "SKIP";
                rejectReason = "TREND_EXTREME_CHASE_BLOCKED_LONG";
            } else if (side === "short" && boxPos !== null && boxPos < 0.10 && tw > 0.60 && !hasStructureEvidence) {
                allowed = false;
                finalDecision = "SKIP";
                rejectReason = "TREND_EXTREME_CHASE_BLOCKED_SHORT";
            }
        }
    }

    // Step 3 & 4: Expected Move & Transaction Cost Edge (evaluated if plan exists or at final gate)
    if (allowed && (hasValidStop && hasValidTp1 && isPlanDirectionValid)) {
        if (expectedMovePct < minRequiredMovePct) {
            allowed = false;
            finalDecision = "SKIP";
            rejectReason = "INSUFFICIENT_EXPECTED_MOVE_OVER_COST";
        }
    }

    // Step 5: Reward / Risk (RR)
    if (allowed && (hasValidStop && hasValidTp1 && isPlanDirectionValid)) {
        if (rewardRisk < minRewardRisk) {
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
        isPreCheck,
        expectedMovePct: Number(expectedMovePct.toFixed(6)),
        estimatedCostPct: Number(estimatedCostPct.toFixed(6)),
        netEdgePct: Number(netEdgePct.toFixed(6)),
        tp1DistancePct: Number(tp1DistancePct.toFixed(6)),
        stopDistancePct: Number(stopDistancePct.toFixed(6)),
        rewardRisk: Number(rewardRisk.toFixed(3)),
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
