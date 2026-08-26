import type { MarketRegime } from "../../strategy/market-regime-detector";

/** Mirrors range-executor exit-plan distance ratios (range-executor.ts). */
export const RANGE_MIN_STOP_ATR_MULT = 0.5;
export const RANGE_MIN_PROFIT_ATR_MULT = 0.35;
export const RANGE_MIN_STOP_ENTRY_PCT = 0.0015;
export const RANGE_MIN_PROFIT_ENTRY_PCT = 0.001;
export const RANGE_TP1_MIN_SAFETY_BUFFER_PCT = 0.0002;
export const RANGE_TP1_MAX_PCT = 0.0025;

/** TP ATR cap derived from executor stop/profit ratio (~2.0× ATR). */
export const RANGE_ADAPTIVE_TP_ATR_CAP_MULT =
    (RANGE_MIN_STOP_ATR_MULT / RANGE_MIN_PROFIT_ATR_MULT) * 1.4;

const CONFIRMED_BREAKOUT_SUBTYPES = new Set([
    "BREAKOUT_RETEST_CONFIRMED",
    "BREAKOUT_RETEST_CONFIRMED_VOLUME",
    "BREAKDOWN_RETEST_FAILED",
    "BREAKDOWN_RETEST_CONFIRMED",
    "BREAKDOWN_CONTINUATION"
]);

const SHOCK_OR_EMERGENCY_SUBTYPES = new Set([
    "SHOCK_REACTION_UP",
    "SHOCK_REACTION_DOWN",
    "WHIPSAW_SHOCK_RECHECK"
]);

const LOW_VOL_RANGE_SUBTYPES = new Set([
    "RANGE_FLAT",
    "RANGE_MID_CHOP",
    "RANGE_UPPER_REACTION",
    "RANGE_LOWER_REACTION",
    "FAST_TREND_SHIFT"
]);

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function isFinitePositive(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v) && v > 0;
}

export type AdaptiveRangeProtectionDiagnostics = Readonly<{
    adaptive_range_protection_applied: boolean;
    tp_distance_source: string | null;
    sl_distance_source: string | null;
    atr_value: number | null;
    atr_tp_multiple: number | null;
    atr_sl_multiple: number | null;
    box_target_price: number | null;
    raw_policy_tp_price: number | null;
    adaptive_tp_price: number | null;
    raw_policy_sl_price: number | null;
    adaptive_sl_price: number | null;
    final_committed_tp_price: number | null;
    final_committed_sl_price: number | null;
    adaptive_block_reason: string | null;
    structural_stop_price: number | null;
    structural_stop_distance_atr: number | null;
    atr_min_stop_distance: number | null;
    percentage_floor_distance: number | null;
    percentage_floor_applied: boolean;
    final_stop_price: number | null;
    final_stop_distance_atr: number | null;
    final_tp_distance_atr: number | null;
    reward_risk_ratio: number | null;
}>;

export function shouldApplyAdaptiveRangePreEntryProtection(input: Readonly<{
    regime: MarketRegime;
    routingEngine?: string | null;
    marketSubtype?: string | null;
    confirmedBreakout?: boolean;
    strongContinuation?: boolean;
}>): boolean {
    if (input.regime !== "RANGE") return false;
    if (input.routingEngine === "TREND") return false;
    if (input.confirmedBreakout === true || input.strongContinuation === true) return false;

    const subtype = String(input.marketSubtype ?? "").trim();
    if (subtype.length === 0) return false;
    if (CONFIRMED_BREAKOUT_SUBTYPES.has(subtype)) return false;
    if (SHOCK_OR_EMERGENCY_SUBTYPES.has(subtype)) return false;
    if (/BREAKOUT.*CONFIRMED/i.test(subtype) || /BREAKDOWN.*CONFIRMED/i.test(subtype)) return false;

    return LOW_VOL_RANGE_SUBTYPES.has(subtype);
}

export function computeAdaptiveRangePreEntryProtection(input: Readonly<{
    side: "long" | "short";
    entryPx: number;
    rawStructuralSl: number;
    rawPolicySl: number;
    rawPolicyTp: number | null;
    atr: number;
    boxHigh: number;
    boxLow: number;
    boxMid?: number | null;
    feeRate?: number;
    /** FAST_TREND_SHIFT canonical stop — never tighten inward; only keep or widen outward. */
    preserveCanonicalStructuralStop?: boolean;
}>):
    | Readonly<{
          ok: true;
          slPrice: number;
          tpPrice: number;
          slSource: string;
          tpSource: string;
          diagnostics: AdaptiveRangeProtectionDiagnostics;
      }>
    | Readonly<{ ok: false; blockReason: string; diagnostics: AdaptiveRangeProtectionDiagnostics }> {
    const emptyDiag = (partial: Partial<AdaptiveRangeProtectionDiagnostics>): AdaptiveRangeProtectionDiagnostics => ({
        adaptive_range_protection_applied: false,
        tp_distance_source: null,
        sl_distance_source: null,
        atr_value: isFinitePositive(input.atr) ? input.atr : null,
        atr_tp_multiple: null,
        atr_sl_multiple: null,
        box_target_price: null,
        raw_policy_tp_price: input.rawPolicyTp,
        adaptive_tp_price: null,
        raw_policy_sl_price: input.rawPolicySl,
        adaptive_sl_price: null,
        final_committed_tp_price: null,
        final_committed_sl_price: null,
        adaptive_block_reason: null,
        structural_stop_price: isFinitePositive(input.rawStructuralSl) ? input.rawStructuralSl : null,
        structural_stop_distance_atr: null,
        atr_min_stop_distance: null,
        percentage_floor_distance: null,
        percentage_floor_applied: false,
        final_stop_price: null,
        final_stop_distance_atr: null,
        final_tp_distance_atr: null,
        reward_risk_ratio: null,
        ...partial
    });

    const entryPx = input.entryPx;
    const atr = input.atr;
    if (!(entryPx > 0) || !isFinitePositive(atr)) {
        return {
            ok: false,
            blockReason: "ADAPTIVE_RANGE_ATR_UNAVAILABLE",
            diagnostics: emptyDiag({ adaptive_block_reason: "ADAPTIVE_RANGE_ATR_UNAVAILABLE" })
        };
    }

    const boxHigh = input.boxHigh;
    const boxLow = input.boxLow;
    if (!(boxHigh > boxLow && boxLow > 0)) {
        return {
            ok: false,
            blockReason: "ADAPTIVE_RANGE_BOX_UNAVAILABLE",
            diagnostics: emptyDiag({ adaptive_block_reason: "ADAPTIVE_RANGE_BOX_UNAVAILABLE" })
        };
    }

    const boxMid = isFinitePositive(input.boxMid) ? input.boxMid : (boxHigh + boxLow) / 2;
    const atrMinStopDistance = atr * RANGE_MIN_STOP_ATR_MULT;
    const percentageFloorDistance = entryPx * RANGE_MIN_STOP_ENTRY_PCT;
    const minProfitDistance = Math.max(atr * RANGE_MIN_PROFIT_ATR_MULT, entryPx * RANGE_MIN_PROFIT_ENTRY_PCT);
    const maxTpDistance = atr * RANGE_ADAPTIVE_TP_ATR_CAP_MULT;

    const structuralSl = input.rawStructuralSl;
    const structuralDist = Math.abs(entryPx - structuralSl);
    const structuralStopDistanceAtr = structuralDist / atr;

    if (maxTpDistance + 1e-9 < minProfitDistance) {
        return {
            ok: false,
            blockReason: "ADAPTIVE_RANGE_TP_PLAN_INFEASIBLE",
            diagnostics: emptyDiag({
                box_target_price: boxMid,
                atr_min_stop_distance: atrMinStopDistance,
                percentage_floor_distance: percentageFloorDistance,
                structural_stop_distance_atr: structuralStopDistanceAtr,
                adaptive_block_reason: "ADAPTIVE_RANGE_TP_PLAN_INFEASIBLE"
            })
        };
    }

    let adaptiveSl: number;
    let slSource: string;
    let percentageFloorApplied = false;
    const structuralDirectionValid =
        input.side === "long" ? structuralSl < entryPx : structuralSl > entryPx;

    if (!structuralDirectionValid) {
        return {
            ok: false,
            blockReason: "ADAPTIVE_RANGE_SL_DIRECTION_INVALID",
            diagnostics: emptyDiag({
                adaptive_sl_price: structuralSl,
                sl_distance_source: "adaptive_range_structural_invalidation",
                box_target_price: boxMid,
                atr_min_stop_distance: atrMinStopDistance,
                percentage_floor_distance: percentageFloorDistance,
                structural_stop_distance_atr: structuralStopDistanceAtr,
                adaptive_block_reason: "ADAPTIVE_RANGE_SL_DIRECTION_INVALID"
            })
        };
    }

    if (structuralDist >= atrMinStopDistance - 1e-9) {
        adaptiveSl = structuralSl;
        slSource = "adaptive_range_structural_invalidation";
    } else if (input.preserveCanonicalStructuralStop === true) {
        adaptiveSl = structuralSl;
        slSource = "fast_trend_shift_canonical_structural";
    } else {
        adaptiveSl =
            input.side === "long"
                ? Math.min(structuralSl, entryPx - atrMinStopDistance)
                : Math.max(structuralSl, entryPx + atrMinStopDistance);
        slSource = "adaptive_range_atr_min_buffer";
    }

    if (input.preserveCanonicalStructuralStop === true) {
        adaptiveSl =
            input.side === "long"
                ? Math.min(adaptiveSl, structuralSl)
                : Math.max(adaptiveSl, structuralSl);
    }

    const pctWidenCandidate =
        input.side === "long" ? entryPx - percentageFloorDistance : entryPx + percentageFloorDistance;
    const pctWouldWiden =
        input.side === "long"
            ? pctWidenCandidate < adaptiveSl - 1e-9
            : pctWidenCandidate > adaptiveSl + 1e-9;
    if (pctWouldWiden && slSource === "adaptive_range_structural_invalidation") {
        percentageFloorApplied = false;
    } else if (
        slSource === "adaptive_range_atr_min_buffer" &&
        Math.abs(Math.abs(entryPx - adaptiveSl) - percentageFloorDistance) <= atr * 0.01
    ) {
        percentageFloorApplied = true;
    }

    const slDistance = Math.abs(entryPx - adaptiveSl);
    const atrSlMultiple = slDistance / atr;

    if (input.rawPolicyTp == null || !isFinitePositive(input.rawPolicyTp)) {
        return {
            ok: false,
            blockReason: "ADAPTIVE_RANGE_TP_UNAVAILABLE",
            diagnostics: emptyDiag({
                adaptive_sl_price: adaptiveSl,
                sl_distance_source: slSource,
                atr_sl_multiple: atrSlMultiple,
                box_target_price: boxMid,
                adaptive_block_reason: "ADAPTIVE_RANGE_TP_UNAVAILABLE"
            })
        };
    }

    const boxDist =
        input.side === "long" ? Math.max(boxMid - entryPx, 0) : Math.max(entryPx - boxMid, 0);
    const rawTpDist = Math.max(boxDist, minProfitDistance);
    const cappedTpDist = clamp(rawTpDist, minProfitDistance, maxTpDistance);

    if (cappedTpDist < minProfitDistance - 1e-9) {
        return {
            ok: false,
            blockReason: "ADAPTIVE_RANGE_TP_BELOW_MIN_PROFIT_DISTANCE",
            diagnostics: emptyDiag({
                adaptive_sl_price: adaptiveSl,
                sl_distance_source: slSource,
                atr_sl_multiple: atrSlMultiple,
                box_target_price: boxMid,
                adaptive_block_reason: "ADAPTIVE_RANGE_TP_BELOW_MIN_PROFIT_DISTANCE"
            })
        };
    }

    const adaptiveTp =
        input.side === "long" ? entryPx + cappedTpDist : entryPx - cappedTpDist;

    const tpSource =
        Math.abs(cappedTpDist - boxDist) <= atr * 0.05
            ? "adaptive_range_box_mid"
            : cappedTpDist >= maxTpDistance - 1e-9
              ? "adaptive_range_atr_cap"
              : "adaptive_range_atr_min_profit_floor";

    if (input.side === "long" && adaptiveTp <= entryPx) {
        return {
            ok: false,
            blockReason: "ADAPTIVE_RANGE_TP_DIRECTION_INVALID",
            diagnostics: emptyDiag({
                adaptive_sl_price: adaptiveSl,
                adaptive_tp_price: adaptiveTp,
                sl_distance_source: slSource,
                tp_distance_source: tpSource,
                adaptive_block_reason: "ADAPTIVE_RANGE_TP_DIRECTION_INVALID"
            })
        };
    }
    if (input.side === "short" && adaptiveTp >= entryPx) {
        return {
            ok: false,
            blockReason: "ADAPTIVE_RANGE_TP_DIRECTION_INVALID",
            diagnostics: emptyDiag({
                adaptive_sl_price: adaptiveSl,
                adaptive_tp_price: adaptiveTp,
                sl_distance_source: slSource,
                tp_distance_source: tpSource,
                adaptive_block_reason: "ADAPTIVE_RANGE_TP_DIRECTION_INVALID"
            })
        };
    }
    if (input.side === "long" && adaptiveSl >= adaptiveTp) {
        return {
            ok: false,
            blockReason: "ADAPTIVE_RANGE_SL_TP_COLLAPSE",
            diagnostics: emptyDiag({
                adaptive_sl_price: adaptiveSl,
                adaptive_tp_price: adaptiveTp,
                sl_distance_source: slSource,
                tp_distance_source: tpSource,
                adaptive_block_reason: "ADAPTIVE_RANGE_SL_TP_COLLAPSE"
            })
        };
    }
    if (input.side === "short" && adaptiveSl <= adaptiveTp) {
        return {
            ok: false,
            blockReason: "ADAPTIVE_RANGE_SL_TP_COLLAPSE",
            diagnostics: emptyDiag({
                adaptive_sl_price: adaptiveSl,
                adaptive_tp_price: adaptiveTp,
                sl_distance_source: slSource,
                tp_distance_source: tpSource,
                adaptive_block_reason: "ADAPTIVE_RANGE_SL_TP_COLLAPSE"
            })
        };
    }

    const tpDistance = Math.abs(entryPx - adaptiveTp);
    const atrTpMultiple = tpDistance / atr;
    const rewardRiskRatio = slDistance > 0 ? tpDistance / slDistance : null;

    const diagnostics: AdaptiveRangeProtectionDiagnostics = {
        adaptive_range_protection_applied: true,
        tp_distance_source: tpSource,
        sl_distance_source: slSource,
        atr_value: atr,
        atr_tp_multiple: atrTpMultiple,
        atr_sl_multiple: atrSlMultiple,
        box_target_price: boxMid,
        raw_policy_tp_price: input.rawPolicyTp,
        adaptive_tp_price: adaptiveTp,
        raw_policy_sl_price: input.rawPolicySl,
        adaptive_sl_price: adaptiveSl,
        final_committed_tp_price: adaptiveTp,
        final_committed_sl_price: adaptiveSl,
        adaptive_block_reason: null,
        structural_stop_price: structuralSl,
        structural_stop_distance_atr: structuralStopDistanceAtr,
        atr_min_stop_distance: atrMinStopDistance,
        percentage_floor_distance: percentageFloorDistance,
        percentage_floor_applied: percentageFloorApplied,
        final_stop_price: adaptiveSl,
        final_stop_distance_atr: atrSlMultiple,
        final_tp_distance_atr: atrTpMultiple,
        reward_risk_ratio: rewardRiskRatio
    };

    return {
        ok: true,
        slPrice: adaptiveSl,
        tpPrice: adaptiveTp,
        slSource,
        tpSource,
        diagnostics
    };
}
