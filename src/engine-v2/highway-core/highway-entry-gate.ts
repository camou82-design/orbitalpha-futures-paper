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
        directionalShockState = "NONE"
    } = input;

    const lastPrice = Number(snapshot?.lastPrice ?? 0);
    const boxPos = typeof snapshot?.boxPos === "number" && Number.isFinite(snapshot.boxPos) ? snapshot.boxPos : null;
    const boxHigh = Number(snapshot?.boxHigh ?? 0);
    const boxLow = Number(snapshot?.boxLow ?? 0);
    const atrVal = Number(snapshot?.atr20 ?? snapshot?.atr ?? 0);
    const atrPct = lastPrice > 0 && atrVal > 0 ? atrVal / lastPrice : 0.008; // default 0.8% ATR if missing

    // 1. Transaction Cost Estimation (Dynamic, no fixed dollar amounts)
    const takerFeeRate = Number(config?.paperTakerFeeRate ?? config?.takerFeeRate ?? 0.0005);
    const roundTripFeePct = takerFeeRate * 2; // e.g., 0.10%
    const estimatedSlippagePct = Number(config?.estimatedSlippagePct ?? 0.0003); // e.g., 0.03%
    const estimatedCostPct = roundTripFeePct + estimatedSlippagePct; // e.g., 0.13%
    const minCostMultiplier = Number(config?.highwayMinCostMultiplier ?? 2.0); // 2.0 ~ 2.5x
    const minRequiredMovePct = estimatedCostPct * minCostMultiplier;

    // 2. Dynamic Expected Move (Dynamic ATR/Volatility based)
    let expectedMovePct = Math.max(0.003, atrPct * 1.5);
    if (regime === "RANGE" && boxHigh > 0 && boxLow > 0 && lastPrice > 0) {
        if (side === "long") {
            const distToBoxHigh = Math.max(0, (boxHigh - lastPrice) / lastPrice);
            expectedMovePct = Math.min(Math.max(distToBoxHigh, 0.5 * atrPct), 3.0 * atrPct);
        } else if (side === "short") {
            const distToBoxLow = Math.max(0, (lastPrice - boxLow) / lastPrice);
            expectedMovePct = Math.min(Math.max(distToBoxLow, 0.5 * atrPct), 3.0 * atrPct);
        }
    } else if (regime === "TREND" || subtype === "FAST_TREND_SHIFT") {
        expectedMovePct = Math.max(0.004, atrPct * 1.5);
    }
    const netEdgePct = expectedMovePct - estimatedCostPct;

    // 3. Planned TP1 / Stop Loss distances & Reward/Risk
    const stopPrice = Number(
        execution?.stopPrice ??
        execution?.invalidationPx ??
        committedRiskPlan?.stopPrice ??
        (side === "long" ? lastPrice * (1 - Math.max(0.005, atrPct)) : lastPrice * (1 + Math.max(0.005, atrPct)))
    );

    const tp1Price = Number(
        (execution as any)?.tp1Price ??
        (execution?.metadata as any)?.tp1Price ??
        (committedRiskPlan as any)?.tp1Price ??
        (side === "long" ? lastPrice * (1 + expectedMovePct) : lastPrice * (1 - expectedMovePct))
    );

    const stopDistancePct = lastPrice > 0 && stopPrice > 0
        ? Math.abs(lastPrice - stopPrice) / lastPrice
        : Math.max(0.004, atrPct);
    const tp1DistancePct = lastPrice > 0 && tp1Price > 0
        ? Math.abs(tp1Price - lastPrice) / lastPrice
        : expectedMovePct;

    const rewardRisk = stopDistancePct > 0 ? (tp1DistancePct / stopDistancePct) : 0;
    const minRewardRisk = Number(config?.highwayMinRewardRisk ?? 1.2); // configurable 1.2 ~ 1.3

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

    // Step 3 & 4: Expected Move & Transaction Cost Edge
    if (allowed) {
        if (expectedMovePct < minRequiredMovePct) {
            allowed = false;
            finalDecision = "SKIP";
            rejectReason = "INSUFFICIENT_EXPECTED_MOVE_OVER_COST";
        }
    }

    // Step 5: Reward / Risk (RR)
    if (allowed) {
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
