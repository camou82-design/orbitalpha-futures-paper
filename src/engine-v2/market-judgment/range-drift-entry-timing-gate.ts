import { Candle } from "../../models/types";

export type RangeDriftDirection = "DOWN" | "UP" | "NONE";

export interface RangeDriftEntryTimingGateInput {
    symbol: string;
    candidateSide: "long" | "short" | string;
    canonicalRegime: string;
    rangePhase: string;
    rangeCenterSlope: number;
    ema20Slope: number;
    boxPos: number | null;
    boxHigh?: number | null;
    boxLow?: number | null;
    entryPrice: number;
    candles?: Candle[] | any[] | null;
    reclaimConfirmed?: boolean | null;
    rejectionConfirmed?: boolean | null;
    reversalConfirmed?: boolean | null;
    consecutiveEvaluations?: number | null;
    candleAdvanceCount?: number | null;
    isAddon?: boolean | null;
    marketSubtype?: string | null;
    lifecycleState?: string | null;
    manualTakeoverActive?: boolean | null;
    manualOwnershipLatch?: boolean | null;
    longBoxPosThreshold?: number;
    shortBoxPosThreshold?: number;
    slopeDeadband?: number;
}

export interface RangeDriftEntryTimingGateResult {
    blockedOrWaited: boolean;
    decisionBefore: "ENTER";
    decisionAfter: "ENTER" | "WAIT";
    reason: string | null;
    symbol: string;
    candidateSide: "long" | "short";
    canonicalRegime: string;
    rangePhase: string;
    rangeCenterSlope: number;
    ema20Slope: number;
    driftDirection: RangeDriftDirection;
    driftConfirmed: boolean;
    boxPos: number | null;
    zone: "lower" | "mid" | "upper" | "outside";
    favorableEdgeReached: boolean;
    reactionConfirmed: boolean;
    reclaimConfirmed: boolean;
    rejectionConfirmed: boolean;
    reversalConfirmed: boolean;
}

export const RANGE_DRIFT_DEFAULT_LONG_BOX_POS_THRESH = 0.30;
export const RANGE_DRIFT_DEFAULT_SHORT_BOX_POS_THRESH = 0.70;
export const RANGE_DRIFT_SLOPE_DEADBAND = 0.000001; // 1e-6 deadband to prevent near-zero micro noise

export interface RangeDriftHysteresisState {
    symbol: string;
    lastDriftDirection: RangeDriftDirection;
    consecutiveEvaluations: number;
    lastCandleTimestamp: number | null;
    candleAdvanceCount: number;
}

export const rangeDriftHysteresisMap = new Map<string, RangeDriftHysteresisState>();

export function resetRangeDriftHysteresis(symbol?: string): void {
    if (symbol) {
        rangeDriftHysteresisMap.delete(symbol.toUpperCase());
    } else {
        rangeDriftHysteresisMap.clear();
    }
}

/**
 * Detects structural reaction (rejection, reclaim, reversal/higher-low/lower-high)
 * using authoritative candle progression.
 */
export function detectDriftStructuralReaction(args: {
    candles: Candle[] | any[] | null;
    side: "long" | "short";
    boxHigh: number;
    boxLow: number;
    entryPrice: number;
}): {
    reclaimConfirmed: boolean;
    rejectionConfirmed: boolean;
    reversalConfirmed: boolean;
    reactionConfirmed: boolean;
} {
    const { candles, side, boxHigh, boxLow, entryPrice } = args;
    // Canonical Engine Contract: the last element is the in-flight forming candle.
    // Isolate strictly closed candles by excluding the last in-flight forming candle.
    // Minimum 2 closed candles required (+ 1 in-flight forming candle = 3 total).
    if (!candles || candles.length < 3) {
        return {
            reclaimConfirmed: false,
            rejectionConfirmed: false,
            reversalConfirmed: false,
            reactionConfirmed: false
        };
    }

    const closedCandles = candles.slice(0, -1);
    const cLast = closedCandles[closedCandles.length - 1];
    const cPrev = closedCandles[closedCandles.length - 2];
    const recent = closedCandles.slice(-5);

    const cLastClose = Number(cLast.close ?? cLast[4] ?? entryPrice);
    const cLastOpen = Number(cLast.open ?? cLast[1] ?? cLastClose);
    const cLastHigh = Number(cLast.high ?? cLast[2] ?? cLastClose);
    const cLastLow = Number(cLast.low ?? cLast[3] ?? cLastClose);

    const cPrevClose = Number(cPrev.close ?? cPrev[4] ?? cLastClose);
    const cPrevOpen = Number(cPrev.open ?? cPrev[1] ?? cPrevClose);
    const cPrevHigh = Number(cPrev.high ?? cPrev[2] ?? cPrevClose);
    const cPrevLow = Number(cPrev.low ?? cPrev[3] ?? cPrevClose);

    if (side === "long") {
        // Lower reaction:
        // 1. Lower rejection: test of lower boundary with upward bounce / lower wick
        const touchLower = recent.some((c: any) => {
            const l = Number(c.low ?? c[3] ?? 0);
            return l > 0 && boxLow > 0 && l <= boxLow * 1.002;
        });
        const bounceLower = boxLow > 0 && cLastClose > boxLow * 1.0003;
        const lowerWick = (cLastClose - cLastLow) > (cLastHigh - cLastClose);
        const rejectionConfirmed = touchLower && (bounceLower || lowerWick);

        // 2. Reclaim: prior candle closed below boxLow, now closed back above boxLow,
        // or closed above prior candle high
        const reclaimConfirmed = (boxLow > 0 && cPrevClose < boxLow && cLastClose >= boxLow) || (cLastClose > cPrevHigh);

        // 3. Higher low / reversal
        const reversalConfirmed = (cLastLow > cPrevLow && cLastClose >= cLastOpen);

        const reactionConfirmed = rejectionConfirmed || reclaimConfirmed || reversalConfirmed;
        return {
            reclaimConfirmed,
            rejectionConfirmed,
            reversalConfirmed,
            reactionConfirmed
        };
    } else {
        // Upper reaction:
        // 1. Upper rejection: test of upper boundary with downward rejection / upper wick
        const touchUpper = recent.some((c: any) => {
            const h = Number(c.high ?? c[2] ?? 0);
            return h > 0 && boxHigh > 0 && h >= boxHigh * 0.998;
        });
        const bounceUpper = boxHigh > 0 && cLastClose < boxHigh * 0.9997;
        const upperWick = (cLastHigh - cLastClose) > (cLastClose - cLastLow);
        const rejectionConfirmed = touchUpper && (bounceUpper || upperWick);

        // 2. Reclaim: prior candle closed above boxHigh, now closed back below boxHigh,
        // or closed below prior candle low
        const reclaimConfirmed = (boxHigh > 0 && cPrevClose > boxHigh && cLastClose <= boxHigh) || (cLastClose < cPrevLow);

        // 3. Lower high / reversal
        const reversalConfirmed = (cLastHigh < cPrevHigh && cLastClose <= cLastOpen);

        const reactionConfirmed = rejectionConfirmed || reclaimConfirmed || reversalConfirmed;
        return {
            reclaimConfirmed,
            rejectionConfirmed,
            reversalConfirmed,
            reactionConfirmed
        };
    }
}

/**
 * Entry-only Timing Gate for RANGE / FLAT markets experiencing directional drift.
 * Ensures counter-drift entries wait for favorable edge + structural reaction confirmation.
 */
export function evaluateRangeDriftEntryTimingGate(
    input: RangeDriftEntryTimingGateInput
): RangeDriftEntryTimingGateResult {
    const symbol = String(input.symbol ?? "").toUpperCase();
    const side = String(input.candidateSide ?? "").toLowerCase() as "long" | "short";
    const canonicalRegime = String(input.canonicalRegime ?? "").toUpperCase();
    const rangePhase = String(input.rangePhase ?? "").toUpperCase();
    const rcSlope = Number(input.rangeCenterSlope ?? 0);
    const e20Slope = Number(input.ema20Slope ?? 0);
    const boxPos = typeof input.boxPos === "number" && Number.isFinite(input.boxPos) ? input.boxPos : null;
    const entryPrice = Number(input.entryPrice ?? 0);
    const boxHigh = Number(input.boxHigh ?? (entryPrice > 0 ? entryPrice * 1.003 : 0));
    const boxLow = Number(input.boxLow ?? (entryPrice > 0 ? entryPrice * 0.997 : 0));

    const longThresh = input.longBoxPosThreshold ?? RANGE_DRIFT_DEFAULT_LONG_BOX_POS_THRESH;
    const shortThresh = input.shortBoxPosThreshold ?? RANGE_DRIFT_DEFAULT_SHORT_BOX_POS_THRESH;
    const deadband = input.slopeDeadband ?? RANGE_DRIFT_SLOPE_DEADBAND;

    // Classify zone
    let zone: "lower" | "mid" | "upper" | "outside" = "mid";
    if (boxPos !== null) {
        if (boxPos < 0.0 || boxPos > 1.0) {
            zone = "outside";
        } else if (boxPos <= 0.33) {
            zone = "lower";
        } else if (boxPos >= 0.67) {
            zone = "upper";
        } else {
            zone = "mid";
        }
    }

    const makeResult = (
        blockedOrWaited: boolean,
        reason: string | null,
        driftDirection: RangeDriftDirection,
        driftConfirmed: boolean,
        favorableEdgeReached: boolean,
        reactionConfirmed: boolean,
        reclaimConfirmed: boolean,
        rejectionConfirmed: boolean,
        reversalConfirmed: boolean
    ): RangeDriftEntryTimingGateResult => {
        const res: RangeDriftEntryTimingGateResult = {
            blockedOrWaited,
            decisionBefore: "ENTER",
            decisionAfter: blockedOrWaited ? "WAIT" : "ENTER",
            reason,
            symbol,
            candidateSide: side,
            canonicalRegime,
            rangePhase,
            rangeCenterSlope: rcSlope,
            ema20Slope: e20Slope,
            driftDirection,
            driftConfirmed,
            boxPos,
            zone,
            favorableEdgeReached,
            reactionConfirmed,
            reclaimConfirmed,
            rejectionConfirmed,
            reversalConfirmed
        };

        if (symbol === "BTCUSDT" || symbol === "ETHUSDT") {
            console.info(
                JSON.stringify({
                    event: "V2_RANGE_DRIFT_ENTRY_TIMING_GATE_PROOF",
                    symbol,
                    candidate_side: side,
                    canonical_regime: canonicalRegime,
                    range_phase: rangePhase,
                    range_center_slope: rcSlope,
                    ema20_slope: e20Slope,
                    drift_direction: driftDirection,
                    drift_confirmed: driftConfirmed,
                    box_pos: boxPos,
                    zone,
                    reclaim_confirmed: reclaimConfirmed,
                    rejection_confirmed: rejectionConfirmed,
                    reversal_confirmed: reversalConfirmed,
                    favorable_edge_reached: favorableEdgeReached,
                    reaction_confirmed: reactionConfirmed,
                    decision_before: "ENTER",
                    decision_after: res.decisionAfter,
                    blocked_or_waited: blockedOrWaited,
                    reason
                })
            );
        }

        return res;
    };

    // 1. Invariant: Applicable only to BTCUSDT and ETHUSDT
    if (symbol !== "BTCUSDT" && symbol !== "ETHUSDT") {
        return makeResult(false, null, "NONE", false, true, true, false, false, false);
    }

    // 2. Invariant: Initial Entry only (Add-on strictly bypassed)
    if (input.isAddon === true) {
        rangeDriftHysteresisMap.delete(symbol);
        return makeResult(false, null, "NONE", false, true, true, false, false, false);
    }

    // 3. Invariant: Strict OPERATOR / Manual takeover bypass
    const ls = String(input.lifecycleState ?? "");
    if (
        ls === "OPERATOR_MANAGED" ||
        ls === "EXTERNAL_MANUAL_POSITION" ||
        input.manualTakeoverActive === true ||
        input.manualOwnershipLatch === true
    ) {
        rangeDriftHysteresisMap.delete(symbol);
        return makeResult(false, null, "NONE", false, true, true, false, false, false);
    }

    // 4. Invariant: canonicalRegime === "RANGE" only
    if (canonicalRegime !== "RANGE") {
        rangeDriftHysteresisMap.delete(symbol);
        return makeResult(false, null, "NONE", false, true, true, false, false, false);
    }

    // 5. Invariant: TREND / SHOCK / confirmed breakout continuation bypassed
    const subtype = String(input.marketSubtype ?? "").toUpperCase();
    if (
        subtype.includes("TREND") ||
        subtype.includes("SHOCK") ||
        subtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME" ||
        subtype === "BREAKDOWN_RETEST_FAILED"
    ) {
        rangeDriftHysteresisMap.delete(symbol);
        return makeResult(false, null, "NONE", false, true, true, false, false, false);
    }

    // 6. Drift Determination
    const isFlat = rangePhase === "FLAT" || rangePhase === "RANGE_FLAT";
    const downDriftRaw = isFlat && rcSlope < -deadband && e20Slope < -deadband;
    const upDriftRaw = isFlat && rcSlope > deadband && e20Slope > deadband;

    const rawDriftDirection: RangeDriftDirection = downDriftRaw ? "DOWN" : (upDriftRaw ? "UP" : "NONE");

    if (rawDriftDirection === "NONE") {
        rangeDriftHysteresisMap.delete(symbol);
        return makeResult(false, null, "NONE", false, true, true, false, false, false);
    }

    // 7. Hysteresis Evaluation (stabilization against single-tick flicker)
    let driftConfirmed = true;
    if (input.consecutiveEvaluations != null || input.candleAdvanceCount != null) {
        const consec = input.consecutiveEvaluations ?? 1;
        const candleAdv = input.candleAdvanceCount ?? 0;
        driftConfirmed = consec >= 2 && candleAdv >= 1;
    } else {
        // In-memory state tracking for live ticks
        const currentCandleTs = input.candles && input.candles.length > 0
            ? Number((input.candles[input.candles.length - 1] as any).timestamp ?? (input.candles[input.candles.length - 1] as any)[0] ?? 0)
            : 0;

        let st = rangeDriftHysteresisMap.get(symbol);
        if (!st) {
            st = {
                symbol,
                lastDriftDirection: rawDriftDirection,
                consecutiveEvaluations: 1,
                lastCandleTimestamp: currentCandleTs,
                candleAdvanceCount: 0
            };
            rangeDriftHysteresisMap.set(symbol, st);
            driftConfirmed = false;
        } else {
            if (st.lastDriftDirection === rawDriftDirection) {
                st.consecutiveEvaluations++;
                if (currentCandleTs > 0 && st.lastCandleTimestamp != null && currentCandleTs > st.lastCandleTimestamp) {
                    st.candleAdvanceCount++;
                    st.lastCandleTimestamp = currentCandleTs;
                }
            } else {
                st.lastDriftDirection = rawDriftDirection;
                st.consecutiveEvaluations = 1;
                st.lastCandleTimestamp = currentCandleTs;
                st.candleAdvanceCount = 0;
            }
            driftConfirmed = st.consecutiveEvaluations >= 2 && st.candleAdvanceCount >= 1;
        }
    }

    if (!driftConfirmed) {
        return makeResult(false, null, rawDriftDirection, false, true, true, false, false, false);
    }

    // 8. Drift-aligned entries are strictly preserved (never touched)
    // DOWN_DRIFT + SHORT -> ALLOW
    // UP_DRIFT + LONG -> ALLOW
    if (rawDriftDirection === "DOWN" && side === "short") {
        return makeResult(false, null, "DOWN", true, true, true, false, false, false);
    }
    if (rawDriftDirection === "UP" && side === "long") {
        return makeResult(false, null, "UP", true, true, true, false, false, false);
    }

    // 9. Structural Reaction Confirmation Evidence
    let reclaimConfirmed = input.reclaimConfirmed === true;
    let rejectionConfirmed = input.rejectionConfirmed === true;
    let reversalConfirmed = input.reversalConfirmed === true;

    if (!reclaimConfirmed && !rejectionConfirmed && !reversalConfirmed && input.candles && input.candles.length >= 2) {
        const detected = detectDriftStructuralReaction({
            candles: input.candles,
            side,
            boxHigh,
            boxLow,
            entryPrice
        });
        reclaimConfirmed = detected.reclaimConfirmed;
        rejectionConfirmed = detected.rejectionConfirmed;
        reversalConfirmed = detected.reversalConfirmed;
    }

    const reactionConfirmed = reclaimConfirmed || rejectionConfirmed || reversalConfirmed;

    // 10. Counter-Drift Evaluation
    if (rawDriftDirection === "DOWN" && side === "long") {
        // DOWN-DRIFT RANGE with LONG Candidate
        // Favorable edge: boxPos <= longThresh (and not a catastrophic breakdown below -2.0)
        const favorableEdgeReached = boxPos !== null && boxPos <= longThresh && boxPos >= -2.0;
        if (!favorableEdgeReached) {
            return makeResult(
                true,
                "RANGE_DOWN_DRIFT_LONG_WAIT_LOWER_EDGE",
                "DOWN",
                true,
                false,
                reactionConfirmed,
                reclaimConfirmed,
                rejectionConfirmed,
                reversalConfirmed
            );
        }

        if (!reactionConfirmed) {
            return makeResult(
                true,
                "RANGE_DOWN_DRIFT_LONG_WAIT_REACTION",
                "DOWN",
                true,
                true,
                false,
                reclaimConfirmed,
                rejectionConfirmed,
                reversalConfirmed
            );
        }

        // Favorable lower edge + structural reaction confirmed -> ALLOW
        return makeResult(
            false,
            null,
            "DOWN",
            true,
            true,
            true,
            reclaimConfirmed,
            rejectionConfirmed,
            reversalConfirmed
        );
    }

    if (rawDriftDirection === "UP" && side === "short") {
        // UP-DRIFT RANGE with SHORT Candidate (completely symmetric)
        // Favorable edge: boxPos >= shortThresh (and not a catastrophic breakout above 3.0)
        const favorableEdgeReached = boxPos !== null && boxPos >= shortThresh && boxPos <= 3.0;
        if (!favorableEdgeReached) {
            return makeResult(
                true,
                "RANGE_UP_DRIFT_SHORT_WAIT_UPPER_EDGE",
                "UP",
                true,
                false,
                reactionConfirmed,
                reclaimConfirmed,
                rejectionConfirmed,
                reversalConfirmed
            );
        }

        if (!reactionConfirmed) {
            return makeResult(
                true,
                "RANGE_UP_DRIFT_SHORT_WAIT_REACTION",
                "UP",
                true,
                true,
                false,
                reclaimConfirmed,
                rejectionConfirmed,
                reversalConfirmed
            );
        }

        // Favorable upper edge + structural reaction confirmed -> ALLOW
        return makeResult(
            false,
            null,
            "UP",
            true,
            true,
            true,
            reclaimConfirmed,
            rejectionConfirmed,
            reversalConfirmed
        );
    }

    return makeResult(false, null, rawDriftDirection, true, true, true, false, false, false);
}
