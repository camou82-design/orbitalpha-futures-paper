export type FastTrendShiftLowerShortZoneContext = Readonly<{
    fastTrendShift: Readonly<{
        active?: boolean;
        direction?: string;
        lower_high_detected?: boolean;
        lower_low_detected?: boolean;
        box_mid_lost?: boolean;
        box_lower_breakdown_hold?: boolean;
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
    riskShortAllow: boolean;
    allowNewShort: boolean;
    hasSameSidePosition: boolean;
    hasOppositeSidePosition: boolean;
    paperExecutionReady: boolean;
    signedExecutionReady: boolean;
    boxMid: number | null;
    lastPrice: number;
}>;

export type FastTrendShiftLowerShortZoneEval = Readonly<{
    confirmed: boolean;
    holdReason: string | null;
}>;

const FTS_LOWER_SHORT_MIN_QUALITY = 65;

/**
 * FAST_TREND_SHIFT lower-zone short exemption from ordinary RANGE breakdown/retest authority.
 * Symmetrical counterpart to evaluateFastTrendShiftUpperLongZoneConfirmed — uses FTS structural hits (LH/LL/lower_hold).
 */
export function evaluateFastTrendShiftLowerShortZoneConfirmed(
    ctx: FastTrendShiftLowerShortZoneContext
): FastTrendShiftLowerShortZoneEval {
    const fts = ctx.fastTrendShift;
    if (!fts?.active || fts.direction !== "short") {
        return { confirmed: false, holdReason: "FAST_SHIFT_SHORT_INACTIVE" };
    }
    if (ctx.zone !== "lower") {
        return { confirmed: false, holdReason: "ZONE_NOT_LOWER" };
    }
    if (!fts.lower_high_detected || !fts.lower_low_detected) {
        return { confirmed: false, holdReason: "FTS_STRUCTURE_INCOMPLETE" };
    }
    const boxMidLost =
        fts.box_mid_lost === true ||
        (ctx.boxMid != null && ctx.lastPrice < ctx.boxMid) ||
        (typeof fts.reason === "string" && fts.reason.includes("box_mid_lost"));
    if (!boxMidLost) {
        return { confirmed: false, holdReason: "FTS_BOX_MID_NOT_LOST" };
    }
    const lowerHoldOk =
        fts.box_lower_breakdown_hold === true ||
        (typeof fts.reason === "string" && fts.reason.includes("lower_hold"));
    if (!lowerHoldOk) {
        return { confirmed: false, holdReason: "FTS_LOWER_HOLD_MISSING" };
    }
    if (ctx.trendOk !== true) {
        return { confirmed: false, holdReason: "TREND_NOT_OK" };
    }
    if (!(ctx.qualityScore >= FTS_LOWER_SHORT_MIN_QUALITY)) {
        return { confirmed: false, holdReason: "QUALITY_BELOW_THRESHOLD" };
    }
    const stopPx = fts.stop_price;
    if (!(typeof stopPx === "number" && Number.isFinite(stopPx) && stopPx > 0 && stopPx > ctx.lastPrice)) {
        return { confirmed: false, holdReason: "FTS_STRUCTURAL_STOP_INVALID" };
    }
    const policy = String(ctx.htfEntryPolicy ?? "").trim().toUpperCase();
    if (
        policy === "LONG_ONLY_OR_NONE" ||
        policy === "LONG_ONLY" ||
        policy === "HOLD" ||
        policy === "NEUTRAL_HTF_DATA_WAIT"
    ) {
        return { confirmed: false, holdReason: "HTF_POLICY_BLOCKS_SHORT" };
    }
    if (ctx.counterTrendRisk && ctx.htfRequiresStrongerConfirmation && !lowerHoldOk) {
        return { confirmed: false, holdReason: "HTF_STRONGER_CONFIRMATION_REQUIRED" };
    }
    if (ctx.lateChaseBlocked) return { confirmed: false, holdReason: "LATE_CHASE_BLOCKED" };
    if (ctx.hardBlockPresent) return { confirmed: false, holdReason: "HARD_BLOCK_PRESENT" };
    if (ctx.whipsawShockRecheckActive) return { confirmed: false, holdReason: "WHIPSAW_SHOCK_RECHECK" };
    if (!ctx.riskShortAllow || !ctx.allowNewShort) return { confirmed: false, holdReason: "SHORT_NOT_ALLOWED" };
    if (ctx.hasSameSidePosition || ctx.hasOppositeSidePosition) {
        return { confirmed: false, holdReason: "POSITION_CONFLICT" };
    }
    if (!ctx.paperExecutionReady || !ctx.signedExecutionReady) {
        return { confirmed: false, holdReason: "EXECUTION_NOT_READY" };
    }
    return { confirmed: true, holdReason: null };
}
