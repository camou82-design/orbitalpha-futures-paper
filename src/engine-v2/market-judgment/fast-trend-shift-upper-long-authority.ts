export type FastTrendShiftUpperLongZoneContext = Readonly<{
    fastTrendShift: Readonly<{
        active?: boolean;
        direction?: string;
        higher_low_detected?: boolean;
        higher_high_detected?: boolean;
        box_mid_reclaimed?: boolean;
        box_upper_breakout_hold?: boolean;
        reason?: string;
        stop_price?: number | null;
    }> | null | undefined;
    zone: string;
    trendOk: boolean;
    qualityScore: number;
    htfEntryPolicy: string;
    htfRequiresStrongerConfirmation: boolean;
    counterTrendRisk: boolean;
    lateChaseBlocked: boolean;
    hardBlockPresent: boolean;
    whipsawShockRecheckActive: boolean;
    riskLongAllow: boolean;
    allowNewLong: boolean;
    hasSameSidePosition: boolean;
    hasOppositeSidePosition: boolean;
    paperExecutionReady: boolean;
    signedExecutionReady: boolean;
    boxMid: number | null;
    lastPrice: number;
}>;

export type FastTrendShiftUpperLongZoneEval = Readonly<{
    confirmed: boolean;
    holdReason: string | null;
}>;

const FTS_UPPER_LONG_MIN_QUALITY = 65;

/**
 * FAST_TREND_SHIFT upper-zone long exemption from ordinary RANGE breakout/retest authority.
 * Distinct from evaluateUpperBreakoutLongConfirmed — uses FTS structural hits (HH/HL/upper_hold).
 */
export function evaluateFastTrendShiftUpperLongZoneConfirmed(
    ctx: FastTrendShiftUpperLongZoneContext
): FastTrendShiftUpperLongZoneEval {
    const fts = ctx.fastTrendShift;
    if (!fts?.active || fts.direction !== "long") {
        return { confirmed: false, holdReason: "FAST_SHIFT_LONG_INACTIVE" };
    }
    if (ctx.zone !== "upper") {
        return { confirmed: false, holdReason: "ZONE_NOT_UPPER" };
    }
    if (!fts.higher_low_detected || !fts.higher_high_detected) {
        return { confirmed: false, holdReason: "FTS_STRUCTURE_INCOMPLETE" };
    }
    const boxMidOk =
        fts.box_mid_reclaimed === true ||
        (ctx.boxMid != null && ctx.lastPrice > ctx.boxMid) ||
        (typeof fts.reason === "string" && fts.reason.includes("box_mid_ok"));
    if (!boxMidOk) {
        return { confirmed: false, holdReason: "FTS_BOX_MID_NOT_OK" };
    }
    const upperHoldOk =
        fts.box_upper_breakout_hold === true ||
        (typeof fts.reason === "string" && fts.reason.includes("upper_hold"));
    if (!upperHoldOk) {
        return { confirmed: false, holdReason: "FTS_UPPER_HOLD_MISSING" };
    }
    if (ctx.trendOk !== true) {
        return { confirmed: false, holdReason: "TREND_NOT_OK" };
    }
    if (!(ctx.qualityScore >= FTS_UPPER_LONG_MIN_QUALITY)) {
        return { confirmed: false, holdReason: "QUALITY_BELOW_THRESHOLD" };
    }
    const stopPx = fts.stop_price;
    if (!(typeof stopPx === "number" && Number.isFinite(stopPx) && stopPx > 0 && stopPx < ctx.lastPrice)) {
        return { confirmed: false, holdReason: "FTS_STRUCTURAL_STOP_INVALID" };
    }
    const policy = String(ctx.htfEntryPolicy ?? "").trim().toUpperCase();
    if (
        policy === "SHORT_ONLY_OR_NONE" ||
        policy === "SHORT_ONLY" ||
        policy === "HOLD" ||
        policy === "NEUTRAL_HTF_DATA_WAIT"
    ) {
        return { confirmed: false, holdReason: "HTF_POLICY_BLOCKS_LONG" };
    }
    if (ctx.counterTrendRisk && ctx.htfRequiresStrongerConfirmation && !upperHoldOk) {
        return { confirmed: false, holdReason: "HTF_STRONGER_CONFIRMATION_REQUIRED" };
    }
    if (ctx.lateChaseBlocked) return { confirmed: false, holdReason: "LATE_CHASE_BLOCKED" };
    if (ctx.hardBlockPresent) return { confirmed: false, holdReason: "HARD_BLOCK_PRESENT" };
    if (ctx.whipsawShockRecheckActive) return { confirmed: false, holdReason: "WHIPSAW_SHOCK_RECHECK" };
    if (!ctx.riskLongAllow || !ctx.allowNewLong) return { confirmed: false, holdReason: "LONG_NOT_ALLOWED" };
    if (ctx.hasSameSidePosition || ctx.hasOppositeSidePosition) {
        return { confirmed: false, holdReason: "POSITION_CONFLICT" };
    }
    if (!ctx.paperExecutionReady || !ctx.signedExecutionReady) {
        return { confirmed: false, holdReason: "EXECUTION_NOT_READY" };
    }
    return { confirmed: true, holdReason: null };
}
