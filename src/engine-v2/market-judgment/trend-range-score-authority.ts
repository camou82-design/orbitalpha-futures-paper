import type { Candle } from "../../models/types";
import type { EngineV2Input, EngineV2Regime, EngineV2SnapshotAdapter } from "../types";
import { isHtfPolicyCompatibleWithCandidateSide } from "./whipsaw-aged-soft-downgrade";

type RegimeFinalAuthority = Extract<EngineV2Regime, "TREND" | "RANGE" | "NO_TRADE">;

export type FastTrendStructuralEvidence = Readonly<{
    higher_low: boolean;
    higher_high: boolean;
    lower_high: boolean;
    lower_low: boolean;
    box_mid_reclaimed: boolean;
    box_mid_lost: boolean;
    upper_breakout_hold: boolean;
    lower_breakdown_hold: boolean;
}>;

/** Single candle/box authority for FTS structure (mutually exclusive boundary holds). */
export function resolveFastTrendStructuralEvidence(args: Readonly<{
    candles: ReadonlyArray<Candle>;
    snapshot: Pick<
        EngineV2SnapshotAdapter,
        "lastPrice" | "boxHigh" | "boxLow" | "ema20Slope"
    >;
}>): FastTrendStructuralEvidence {
    const { candles, snapshot: sn } = args;
    const lastPrice = Number(sn.lastPrice ?? 0);
    const boxHigh = sn.boxHigh != null ? Number(sn.boxHigh) : null;
    const boxLow = sn.boxLow != null ? Number(sn.boxLow) : null;
    const boxMid = boxHigh != null && boxLow != null ? (boxHigh + boxLow) / 2 : null;

    const empty: FastTrendStructuralEvidence = {
        higher_low: false,
        higher_high: false,
        lower_high: false,
        lower_low: false,
        box_mid_reclaimed: false,
        box_mid_lost: false,
        upper_breakout_hold: false,
        lower_breakdown_hold: false
    };

    if (!Array.isArray(candles) || candles.length < 10 || !(lastPrice > 0)) {
        return empty;
    }

    const recent = candles.slice(-5);
    const prev = candles.slice(-10, -5);
    const recentHigh = Math.max(...recent.map((c) => c.high));
    const prevHigh = Math.max(...prev.map((c) => c.high));
    const recentLow = Math.min(...recent.map((c) => c.low));
    const prevLow = Math.min(...prev.map((c) => c.low));

    let upper_breakout_hold = false;
    let lower_breakdown_hold = false;

    if (boxHigh != null && boxHigh > 0 && lastPrice >= boxHigh * 0.998) {
        const recentMin = Math.min(...recent.map((c) => c.low));
        upper_breakout_hold = recentMin >= boxHigh * 0.998;
    }
    if (boxLow != null && boxLow > 0 && lastPrice <= boxLow * 1.002) {
        const recentMax = Math.max(...recent.map((c) => c.high));
        lower_breakdown_hold = recentMax <= boxLow * 1.002;
    }

    if (upper_breakout_hold && lower_breakdown_hold) {
        if (boxMid != null && Number.isFinite(boxMid)) {
            if (lastPrice > boxMid) lower_breakdown_hold = false;
            else if (lastPrice < boxMid) upper_breakout_hold = false;
            else {
                const hl = recentLow > prevLow;
                const ll = recentLow < prevLow;
                if (hl) lower_breakdown_hold = false;
                else if (ll) upper_breakout_hold = false;
                else upper_breakout_hold = false;
            }
        } else {
            upper_breakout_hold = false;
            lower_breakdown_hold = false;
        }
    }

    let box_mid_reclaimed = false;
    let box_mid_lost = false;
    if (boxMid != null) {
        const prevClose = candles[candles.length - 2]?.close;
        if (Number.isFinite(prevClose)) {
            box_mid_reclaimed = lastPrice > boxMid && prevClose <= boxMid;
            box_mid_lost = lastPrice < boxMid && prevClose >= boxMid;
        }
    }

    return {
        higher_low: recentLow > prevLow,
        higher_high: recentHigh > prevHigh,
        lower_high: recentHigh < prevHigh,
        lower_low: recentLow < prevLow,
        box_mid_reclaimed,
        box_mid_lost,
        upper_breakout_hold,
        lower_breakdown_hold
    };
}

export type TrendRangeScoreAuthority = Readonly<{
    ema_gap_component: number;
    structure_component: number;
    htf_component: number;
    higher_low: boolean;
    higher_high: boolean;
    upper_breakout_hold: boolean;
    lower_breakdown_hold: boolean;
    trend_score_components: Readonly<Record<string, number>>;
    range_score_components: Readonly<Record<string, number>>;
    final_trend_score: number;
    final_range_score: number;
    regime_before: EngineV2Regime;
}>;

export function resolveTrendRangeScoreAuthority(args: Readonly<{
    input: EngineV2Input;
    regimeBefore: EngineV2Regime;
    structural: FastTrendStructuralEvidence;
    htfEntryPolicy: string;
    fastTrendShiftActive: boolean;
    fastTrendDirection: "long" | "short" | "none";
    ftsProbeAllowed: boolean;
}>): TrendRangeScoreAuthority {
    const sn = args.input.snapshot;
    const emaGap = Number(sn.emaGap ?? 0);
    const ema_gap_component = Math.abs(emaGap) * 1000;
    const e20Slope = Number(sn.ema20Slope ?? 0);
    const trendWeakness = Number(sn.canonicalTrendWeaknessScore ?? sn.trendWeaknessScore ?? 1);
    const canonicalTrend =
        typeof sn.canonicalTrendScore === "number" && Number.isFinite(sn.canonicalTrendScore)
            ? sn.canonicalTrendScore
            : ema_gap_component;

    const { structural: s } = args;
    const trend_score_components: Record<string, number> = {
        ema_gap: ema_gap_component,
        canonical_trend: canonicalTrend
    };

    let structure_component = 0;
    if (s.higher_low) {
        structure_component += 0.18;
        trend_score_components.higher_low = 0.18;
    }
    if (s.higher_high) {
        structure_component += 0.18;
        trend_score_components.higher_high = 0.18;
    }
    if (s.upper_breakout_hold) {
        structure_component += 0.32;
        trend_score_components.upper_breakout_hold = 0.32;
    }
    if (s.lower_breakdown_hold) {
        structure_component += 0.32;
        trend_score_components.lower_breakdown_hold = 0.32;
    }
    if (e20Slope > 0.0001) {
        structure_component += 0.12;
        trend_score_components.ema20_slope_up = 0.12;
    } else if (e20Slope < -0.0001) {
        structure_component += 0.12;
        trend_score_components.ema20_slope_down = 0.12;
    }
    structure_component = Math.min(1, structure_component);
    trend_score_components.structure_total = structure_component;

    const htfOkLong = isHtfPolicyCompatibleWithCandidateSide(args.htfEntryPolicy, "long");
    const htfOkShort = isHtfPolicyCompatibleWithCandidateSide(args.htfEntryPolicy, "short");
    let htf_component = 0;
    if (args.fastTrendDirection === "long" && htfOkLong) htf_component = 0.1;
    else if (args.fastTrendDirection === "short" && htfOkShort) htf_component = 0.1;
    else if (htfOkLong || htfOkShort) htf_component = 0.05;
    trend_score_components.htf_alignment = htf_component;

    let final_trend_score = Math.max(ema_gap_component, canonicalTrend, structure_component + htf_component);
    if (
        args.fastTrendShiftActive &&
        args.ftsProbeAllowed &&
        (args.fastTrendDirection === "long" || args.fastTrendDirection === "short")
    ) {
        final_trend_score = Math.max(final_trend_score, structure_component + htf_component);
    }
    if (trendWeakness < 0.5 && structure_component >= 0.5) {
        final_trend_score = Math.max(final_trend_score, 0.55);
    }

    const rangeBase =
        typeof sn.canonicalRangeConfidence === "number" && Number.isFinite(sn.canonicalRangeConfidence)
            ? sn.canonicalRangeConfidence
            : Number(sn.rangeConfidence ?? 0);

    const range_score_components: Record<string, number> = {
        canonical_range: rangeBase,
        snapshot_range: Number(sn.rangeConfidence ?? 0)
    };

    let rangeErosion = 0;
    const boxPos = Number(sn.boxPos ?? 0.5);
    const breakSide = String(sn.boxBreakSide ?? "none").toLowerCase();
    if (s.upper_breakout_hold) {
        rangeErosion += 0.1;
        range_score_components.breakout_hold_erosion = 0.1;
    }
    if (s.upper_breakout_hold && s.higher_low && s.higher_high) {
        rangeErosion += 0.08;
        range_score_components.hl_hh_erosion = 0.08;
    }
    if (breakSide === "upper" || boxPos >= 0.72) {
        rangeErosion += 0.06;
        range_score_components.upper_zone_erosion = 0.06;
    }
    if (
        args.fastTrendShiftActive &&
        args.fastTrendDirection === "long" &&
        args.ftsProbeAllowed &&
        s.upper_breakout_hold
    ) {
        rangeErosion += 0.05;
        range_score_components.fts_long_breakout_erosion = 0.05;
    }

    const final_range_score = Math.max(0.2, rangeBase - rangeErosion);

    return {
        ema_gap_component,
        structure_component,
        htf_component,
        higher_low: s.higher_low,
        higher_high: s.higher_high,
        upper_breakout_hold: s.upper_breakout_hold,
        lower_breakdown_hold: s.lower_breakdown_hold,
        trend_score_components,
        range_score_components,
        final_trend_score,
        final_range_score,
        regime_before: args.regimeBefore
    };
}

export function applyTrendRangeRegimeFinalAuthority(args: Readonly<{
    regimeFinal: EngineV2Regime;
    shockPhase: string;
    crashState: string;
    directionalShockState: string;
    trendPhase: string;
    htfEntryPolicy: string;
    scoreAuthority: TrendRangeScoreAuthority;
    fastTrendShiftActive: boolean;
    fastTrendDirection: "long" | "short" | "none";
    ftsProbeAllowed: boolean;
}>): Readonly<{ regimeFinal: RegimeFinalAuthority | null; reason: string | null }> {
    const {
        regimeFinal,
        shockPhase,
        crashState,
        directionalShockState,
        trendPhase,
        htfEntryPolicy,
        scoreAuthority,
        fastTrendShiftActive,
        fastTrendDirection,
        ftsProbeAllowed
    } = args;

    if (regimeFinal === "NO_TRADE") return { regimeFinal: null, reason: null };

    const shockDown =
        shockPhase === "DOWN_SHOCK" ||
        String(directionalShockState ?? "NONE").toUpperCase() === "DOWN";
    const crashS = String(crashState ?? "").toUpperCase();
    if (shockDown || crashS.includes("LOCK") || crashS.includes("EXIT")) {
        return { regimeFinal: null, reason: null };
    }

    const sa = scoreAuthority;
    const trendStructureOk =
        String(trendPhase).toUpperCase().includes("PULLBACK") ||
        String(trendPhase).toUpperCase().includes("UP") ||
        sa.final_trend_score >= 0.55;

    const longFtsReady =
        fastTrendShiftActive &&
        fastTrendDirection === "long" &&
        ftsProbeAllowed &&
        sa.higher_low &&
        sa.higher_high &&
        sa.upper_breakout_hold &&
        isHtfPolicyCompatibleWithCandidateSide(htfEntryPolicy, "long");

    const scoreTrendReady =
        sa.final_trend_score >= 0.55 &&
        sa.final_range_score <= 0.65 &&
        sa.upper_breakout_hold &&
        (sa.higher_low || sa.higher_high) &&
        isHtfPolicyCompatibleWithCandidateSide(htfEntryPolicy, "long");

    const promote =
        trendStructureOk &&
        (longFtsReady || scoreTrendReady) &&
        (regimeFinal === "RANGE" || regimeFinal === "TRANSITION");

    if (!promote) return { regimeFinal: null, reason: null };

    return {
        regimeFinal: "TREND",
        reason: longFtsReady
            ? "FTS_STRUCTURAL_TREND_RANGE_SCORE_AUTHORITY"
            : "TREND_RANGE_SCORE_AUTHORITY"
    };
}
