import { Candle } from "../../models/types";
import { detectDriftStructuralReaction } from "./range-drift-entry-timing-gate";

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
 */
export function evaluateRangePostShockGuard(input: RangePostShockGuardInput): RangePostShockGuardResult {
    const symbol = String(input.symbol ?? "").toUpperCase();
    const side = input.side;
    const lastPrice = Number(input.lastPrice ?? 0);
    const boxHigh = Number(input.boxHigh ?? lastPrice * 1.003);
    const boxLow = Number(input.boxLow ?? lastPrice * 0.997);
    const atr = Number(input.atr ?? (lastPrice * 0.01));
    const atrPct = lastPrice > 0 ? (atr / lastPrice) : 0.01;
    const candles = input.candles ?? [];
    const boxCohesion = typeof input.boxCohesion01 === "number" && Number.isFinite(input.boxCohesion01) ? input.boxCohesion01 : 0.5;

    // Minimum move to qualify as directional shock (ATR-normalized to handle ETH high volatility proportionally)
    const requiredShockMovePct = Math.max(0.0030, atrPct * 1.35);

    // 1. Identify Directional Shock presence
    const shockPhase = String(input.shockPhase ?? "").toUpperCase();
    const dss = String(input.directionalShockState ?? "").toUpperCase();
    const rawDss = String(input.rawDirectionalShockState ?? "").toUpperCase();

    let shockDirection: "UP" | "DOWN" | "NONE" = "NONE";
    let shockDetected = false;
    let rawShockMovePct = 0;

    if (shockPhase === "DOWN_SHOCK" || dss === "DOWN" || rawDss === "DOWN") {
        shockDirection = "DOWN";
        shockDetected = true;
    } else if (shockPhase === "UP_SHOCK" || dss === "UP" || rawDss === "UP") {
        shockDirection = "UP";
        shockDetected = true;
    }

    // Candle-level directional shock measurement (inspect up to last 15 closed candles)
    let closedCandlesSinceExtremum = 0;
    if (candles && candles.length >= 4) {
        const closed = candles.slice(0, -1);
        const lookback = closed.slice(-15);
        if (lookback.length >= 3) {
            let maxHigh = -Infinity;
            let maxHighIdx = -1;
            let minLow = Infinity;
            let minLowIdx = -1;

            lookback.forEach((c: any, idx: number) => {
                const h = Number(c.high ?? c[2] ?? 0);
                const l = Number(c.low ?? c[3] ?? 0);
                if (h > maxHigh) { maxHigh = h; maxHighIdx = idx; }
                if (l < minLow) { minLow = l; minLowIdx = idx; }
            });

            const currentClose = Number(closed[closed.length - 1].close ?? closed[closed.length - 1][4] ?? lastPrice);

            // Recent sharp drop: high occurred before low, and magnitude >= requiredShockMovePct
            if (maxHighIdx < minLowIdx && maxHigh > 0 && minLow > 0) {
                const dropPct = (maxHigh - minLow) / maxHigh;
                if (dropPct >= requiredShockMovePct) {
                    rawShockMovePct = Math.max(rawShockMovePct, dropPct);
                    shockDirection = "DOWN";
                    shockDetected = true;
                    closedCandlesSinceExtremum = lookback.length - 1 - minLowIdx;
                }
            }

            // Recent sharp pump: low occurred before high, and magnitude >= requiredShockMovePct
            if (minLowIdx < maxHighIdx && minLow > 0 && maxHigh > 0) {
                const pumpPct = (maxHigh - minLow) / minLow;
                if (pumpPct >= requiredShockMovePct) {
                    rawShockMovePct = Math.max(rawShockMovePct, pumpPct);
                    shockDirection = "UP";
                    shockDetected = true;
                    closedCandlesSinceExtremum = lookback.length - 1 - maxHighIdx;
                }
            }
        }
    }

    // If no directional shock applies, pass cleanly
    if (!shockDetected || shockDirection === "NONE") {
        return {
            blocked: false,
            reason: null,
            shockDetected: false,
            shockDirection: "NONE",
            boxStabilized: true,
            structureConfirmed: true,
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

    // 2. Evaluate Structural Reaction (Retest / Reclaim / Rejection)
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
    const minStabilizingCandles = symbol === "ETHUSDT" ? 3 : 2;
    const boxStabilized = closedCandlesSinceExtremum >= minStabilizingCandles && boxCohesion >= 0.35;

    // 4. Pinpoint Guard Check:
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
