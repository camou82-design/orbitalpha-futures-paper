import { Candle } from "../../models/types";
import { detectDriftStructuralReaction } from "./range-drift-entry-timing-gate";
import { resolveHighwayDirectionalAuthority } from "../highway-core/highway-directional-authority";
import {
    buildPostShockProbeEpisodeId,
    resolvePostShockCandleMetrics
} from "./post-shock-probe-episode";

export interface RangePostShockGuardInput {
    symbol: string;
    side: "long" | "short";
    shockPhase?: string | null;
    directionalShockState?: string | null;
    rawDirectionalShockState?: string | null;
    lastPrice: number;
    boxHigh: number;
    boxLow: number;
    boxMid: number;
    boxPos: number | null;
    atr: number;
    candles?: Candle[] | any[] | null;
    boxCohesion01?: number;
    rangeConfidence?: number;
    evaluationMode?: string;
    reversalConfirmed?: boolean;
}

export interface RangePostShockGuardResult {
    blocked: boolean;
    reason: string | null;
    shockDetected: boolean;
    shockDirection: "UP" | "DOWN" | "NONE";
    boxStabilized: boolean;
    structureConfirmed: boolean;
    earlyReversalProbeEligible?: boolean;
    probeMultiplier?: number;
    recommendedStopPrice?: number | null;
    postShockProbeEpisodeId?: string;
    shockExtremumTs?: number;
    details: {
        rawShockMovePct: number;
        requiredShockMovePct: number;
        closedCandlesSinceExtremum: number;
        reactionConfirmed: boolean;
        reclaimConfirmed: boolean;
        rejectionConfirmed: boolean;
        reversalConfirmed: boolean;
    };
}

/**
 * Post-Shock Range Chase Guard:
 * Prevents RANGE_EXECUTOR from misinterpreting a post-shock counter-bounce/pullback
 * as an established box boundary (e.g. rushing into Short on a dead-cat bounce after a crash,
 * or rushing into Long on a pullback after a pump).
 *
 * Release requires BOTH:
 * 1. Box stabilization (minimum closed candles post-shock without new structural extremes, acceptable boxCohesion)
 * 2. Structural confirmation (retest/reclaim/rejection reaction on the tested boundary)
 *
 * Counter-Shock Early Recovery Probe:
 * Allows strictly reduced-size probe (0.25x) in the OPPOSITE direction of the shock
 * ONLY when:
 * 1. Strong opposite Highway authority is broken/weakened (NOT in strong down/up)
 * 2. Completed closed candle reclaims EMA10 and EMA10 slope turns positive/negative
 * 3. Range structural reclaim/rejection is verified on completed closed candles.
 */
export function evaluateRangePostShockGuard(input: RangePostShockGuardInput): RangePostShockGuardResult {
    const symbol = String(input.symbol ?? "").toUpperCase();
    const side = input.side;
    const lastPrice = Number(input.lastPrice ?? 0);
    const boxHigh = Number(input.boxHigh ?? lastPrice * 1.003);
    const boxLow = Number(input.boxLow ?? lastPrice * 0.997);
    const atr = Number(input.atr ?? (lastPrice * 0.01));
    const candles = input.candles ?? [];
    const boxCohesion = typeof input.boxCohesion01 === "number" && Number.isFinite(input.boxCohesion01) ? input.boxCohesion01 : 0.5;
    const boxPos = typeof input.boxPos === "number" && Number.isFinite(input.boxPos) ? input.boxPos : 0.5;

    const shockMetrics = resolvePostShockCandleMetrics({
        lastPrice,
        atr,
        candles,
        shockPhase: input.shockPhase,
        directionalShockState: input.directionalShockState,
        rawDirectionalShockState: input.rawDirectionalShockState
    });
    const {
        shockDirection,
        shockDetected,
        shockExtremumTs,
        closedCandlesSinceExtremum,
        rawShockMovePct,
        requiredShockMovePct
    } = shockMetrics;
    const postShockProbeEpisodeId =
        shockDirection === "UP" || shockDirection === "DOWN"
            ? buildPostShockProbeEpisodeId({ symbol, shockDirection, shockExtremumTs })
            : undefined;

    // If no directional shock applies, pass cleanly
    if (!shockDetected || shockDirection === "NONE") {
        return {
            blocked: false,
            reason: null,
            shockDetected: false,
            shockDirection: "NONE",
            boxStabilized: true,
            structureConfirmed: true,
            earlyReversalProbeEligible: false,
            probeMultiplier: 1.0,
            recommendedStopPrice: null,
            details: {
                rawShockMovePct,
                requiredShockMovePct,
                closedCandlesSinceExtremum,
                reactionConfirmed: true,
                reclaimConfirmed: false,
                rejectionConfirmed: false,
                reversalConfirmed: input.reversalConfirmed === true
            }
        };
    }

    // 2. Evaluate Structural Reaction (Retest / Reclaim / Rejection on closed candles)
    const reaction = detectDriftStructuralReaction({
        candles,
        side,
        boxHigh,
        boxLow,
        entryPrice: lastPrice
    });

    const structureConfirmed = reaction.reactionConfirmed || reaction.rejectionConfirmed || reaction.reclaimConfirmed || (input.reversalConfirmed === true && reaction.reversalConfirmed);

    // 3. Evaluate Box Stabilization
    // Needs at least 3 closed candles since shock extreme without making new extreme, plus reasonable box cohesion
    const minStabilizingCandles = symbol.includes("ETH") ? 3 : 2;
    const boxStabilized = closedCandlesSinceExtremum >= minStabilizingCandles && boxCohesion >= 0.35;

    // 4. Evaluate Canonical Highway Directional Authority
    const highwayAuth = resolveHighwayDirectionalAuthority({
        snapshot: input,
        candles,
        symbol,
        lastPrice
    });

    const closedCandles = candles && candles.length >= 3 ? candles.slice(0, -1) : [];
    const cLast = closedCandles.length > 0 ? closedCandles[closedCandles.length - 1] : null;
    const cLastClose = Number(cLast?.close ?? cLast?.[4] ?? lastPrice);
    const cLastOpen = Number(cLast?.open ?? cLast?.[1] ?? cLastClose);
    const cLastHigh = Number(cLast?.high ?? cLast?.[2] ?? cLastClose);
    const cLastLow = Number(cLast?.low ?? cLast?.[3] ?? cLastClose);
    const bodySize = Math.abs(cLastClose - cLastOpen);
    const isEth = symbol.includes("ETH");

    // A) DOWN_SHOCK followed by RANGE Long (Post-Shock Counter-Recovery Probe)
    if (shockDirection === "DOWN" && side === "long") {
        if (!highwayAuth.strongDown && highwayAuth.earlyRecoveryUpEligible) {
            const lowerZoneOk = boxPos <= 0.35 || cLastClose <= boxLow * 1.002 || reaction.rejectionConfirmed;
            const lowerWick = cLastClose > cLastOpen ? (cLastOpen - cLastLow) : (cLastClose - cLastLow);
            const btcWickReversal = reaction.reversalConfirmed && (lowerWick >= bodySize * 0.8 || reaction.rejectionConfirmed);
            const structuralProbeOk = isEth
                ? (reaction.reclaimConfirmed && (reaction.reversalConfirmed || input.reversalConfirmed === true))
                : (reaction.reclaimConfirmed || btcWickReversal);

            if (lowerZoneOk && structuralProbeOk) {
                const lowestRecentLow = Math.min(...closedCandles.slice(-5).map((c: any) => Number(c.low ?? c[3] ?? lastPrice)));
                const minStopBuffer = Math.max(lastPrice * 0.0025, atr * 0.45);
                const calculatedStop = Math.min(lowestRecentLow - (lastPrice * 0.0005), lastPrice - minStopBuffer);

                console.info(JSON.stringify({
                    event: "V2_RANGE_POST_SHOCK_COUNTER_PROBE_ALLOWED_PROOF",
                    symbol,
                    side: "long",
                    shockDirection: "DOWN",
                    highwayState: highwayAuth.state,
                    boxPos,
                    reclaimConfirmed: reaction.reclaimConfirmed,
                    reversalConfirmed: reaction.reversalConfirmed,
                    probeMultiplier: 0.25,
                    recommendedStopPrice: calculatedStop,
                    reason: "V2_RANGE_POST_DOWN_SHOCK_LONG_EARLY_PROBE"
                }));

                return {
                    blocked: false,
                    reason: "V2_RANGE_POST_DOWN_SHOCK_LONG_EARLY_PROBE",
                    shockDetected: true,
                    shockDirection: "DOWN",
                    boxStabilized,
                    structureConfirmed: true,
                    earlyReversalProbeEligible: true,
                    probeMultiplier: 0.25,
                    recommendedStopPrice: calculatedStop,
                    postShockProbeEpisodeId,
                    shockExtremumTs,
                    details: {
                        rawShockMovePct,
                        requiredShockMovePct,
                        closedCandlesSinceExtremum,
                        reactionConfirmed: reaction.reactionConfirmed,
                        reclaimConfirmed: reaction.reclaimConfirmed,
                        rejectionConfirmed: reaction.rejectionConfirmed,
                        reversalConfirmed: reaction.reversalConfirmed
                    }
                };
            }
        }
    }

    // B) UP_SHOCK followed by RANGE Short (Post-Shock Counter-Recovery Probe)
    if (shockDirection === "UP" && side === "short") {
        if (!highwayAuth.strongUp && highwayAuth.earlyRecoveryDownEligible) {
            const upperZoneOk = boxPos >= 0.65 || cLastClose >= boxHigh * 0.998 || reaction.rejectionConfirmed;
            const upperWick = cLastClose > cLastOpen ? (cLastHigh - cLastClose) : (cLastHigh - cLastOpen);
            const btcWickReversal = reaction.reversalConfirmed && (upperWick >= bodySize * 0.8 || reaction.rejectionConfirmed);
            const structuralProbeOk = isEth
                ? (reaction.reclaimConfirmed && (reaction.reversalConfirmed || input.reversalConfirmed === true))
                : (reaction.reclaimConfirmed || btcWickReversal);

            if (upperZoneOk && structuralProbeOk) {
                const highestRecentHigh = Math.max(...closedCandles.slice(-5).map((c: any) => Number(c.high ?? c[2] ?? lastPrice)));
                const minStopBuffer = Math.max(lastPrice * 0.0025, atr * 0.45);
                const calculatedStop = Math.max(highestRecentHigh + (lastPrice * 0.0005), lastPrice + minStopBuffer);

                console.info(JSON.stringify({
                    event: "V2_RANGE_POST_SHOCK_COUNTER_PROBE_ALLOWED_PROOF",
                    symbol,
                    side: "short",
                    shockDirection: "UP",
                    highwayState: highwayAuth.state,
                    boxPos,
                    reclaimConfirmed: reaction.reclaimConfirmed,
                    reversalConfirmed: reaction.reversalConfirmed,
                    probeMultiplier: 0.25,
                    recommendedStopPrice: calculatedStop,
                    reason: "V2_RANGE_POST_UP_SHOCK_SHORT_EARLY_PROBE"
                }));

                return {
                    blocked: false,
                    reason: "V2_RANGE_POST_UP_SHOCK_SHORT_EARLY_PROBE",
                    shockDetected: true,
                    shockDirection: "UP",
                    boxStabilized,
                    structureConfirmed: true,
                    earlyReversalProbeEligible: true,
                    probeMultiplier: 0.25,
                    recommendedStopPrice: calculatedStop,
                    postShockProbeEpisodeId,
                    shockExtremumTs,
                    details: {
                        rawShockMovePct,
                        requiredShockMovePct,
                        closedCandlesSinceExtremum,
                        reactionConfirmed: reaction.reactionConfirmed,
                        reclaimConfirmed: reaction.reclaimConfirmed,
                        rejectionConfirmed: reaction.rejectionConfirmed,
                        reversalConfirmed: reaction.reversalConfirmed
                    }
                };
            }
        }
    }

    // 5. Pinpoint Same-Direction Chase Guards (Strictly Blocked):
    // A) DOWN_SHOCK followed by RANGE Short (Counter-bounce chase on dead-cat bounce)
    if (shockDirection === "DOWN" && side === "short") {
        const allowRelease = boxStabilized && structureConfirmed;
        if (!allowRelease) {
            const reason = !boxStabilized
                ? "V2_RANGE_POST_DOWN_SHOCK_SHORT_WAIT_BOX_STABILIZATION"
                : "V2_RANGE_POST_DOWN_SHOCK_SHORT_WAIT_STRUCTURAL_REACTION";

            console.warn(JSON.stringify({
                event: "V2_RANGE_POST_SHOCK_GUARD_BLOCKED_PROOF",
                symbol,
                side,
                shockDirection,
                rawShockMovePct,
                requiredShockMovePct,
                closedCandlesSinceExtremum,
                boxCohesion,
                boxStabilized,
                structureConfirmed,
                rejectionConfirmed: reaction.rejectionConfirmed,
                reclaimConfirmed: reaction.reclaimConfirmed,
                reversalConfirmed: reaction.reversalConfirmed,
                reason
            }));

            return {
                blocked: true,
                reason,
                shockDetected: true,
                shockDirection: "DOWN",
                boxStabilized,
                structureConfirmed,
                details: {
                    rawShockMovePct,
                    requiredShockMovePct,
                    closedCandlesSinceExtremum,
                    reactionConfirmed: reaction.reactionConfirmed,
                    reclaimConfirmed: reaction.reclaimConfirmed,
                    rejectionConfirmed: reaction.rejectionConfirmed,
                    reversalConfirmed: reaction.reversalConfirmed
                }
            };
        }
    }

    // B) UP_SHOCK followed by RANGE Long (Pullback chase after pump)
    if (shockDirection === "UP" && side === "long") {
        const allowRelease = boxStabilized && structureConfirmed;
        if (!allowRelease) {
            const reason = !boxStabilized
                ? "V2_RANGE_POST_UP_SHOCK_LONG_WAIT_BOX_STABILIZATION"
                : "V2_RANGE_POST_UP_SHOCK_LONG_WAIT_STRUCTURAL_REACTION";

            console.warn(JSON.stringify({
                event: "V2_RANGE_POST_SHOCK_GUARD_BLOCKED_PROOF",
                symbol,
                side,
                shockDirection,
                rawShockMovePct,
                requiredShockMovePct,
                closedCandlesSinceExtremum,
                boxCohesion,
                boxStabilized,
                structureConfirmed,
                rejectionConfirmed: reaction.rejectionConfirmed,
                reclaimConfirmed: reaction.reclaimConfirmed,
                reversalConfirmed: reaction.reversalConfirmed,
                reason
            }));

            return {
                blocked: true,
                reason,
                shockDetected: true,
                shockDirection: "UP",
                boxStabilized,
                structureConfirmed,
                details: {
                    rawShockMovePct,
                    requiredShockMovePct,
                    closedCandlesSinceExtremum,
                    reactionConfirmed: reaction.reactionConfirmed,
                    reclaimConfirmed: reaction.reclaimConfirmed,
                    rejectionConfirmed: reaction.reversalConfirmed,
                    reversalConfirmed: reaction.reversalConfirmed
                }
            };
        }
    }

    return {
        blocked: false,
        reason: null,
        shockDetected: true,
        shockDirection,
        boxStabilized,
        structureConfirmed,
        details: {
            rawShockMovePct,
            requiredShockMovePct,
            closedCandlesSinceExtremum,
            reactionConfirmed: reaction.reactionConfirmed,
            reclaimConfirmed: reaction.reclaimConfirmed,
            rejectionConfirmed: reaction.rejectionConfirmed,
            reversalConfirmed: reaction.reversalConfirmed
        }
    };
}
