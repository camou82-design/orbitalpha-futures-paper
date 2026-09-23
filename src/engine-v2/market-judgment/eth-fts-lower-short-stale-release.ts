export interface EthFtsLowerShortStaleReleaseState {
    symbol: string;
    consecutiveCycles: number;
    suppressionUntil: number; // timestamp ms
    staleReleaseActive: boolean;
    lastResetReason: string | null;
}

export interface EthFtsLowerShortStaleReleaseInput {
    symbol: string;
    isInitialEntry: boolean;
    isOperatorManaged: boolean;
    isManualTakeover: boolean;
    isAdoptedExternal: boolean;
    subtype: string | null | undefined;
    ftsDirection: string | null | undefined;
    trendSideCandidate: string;
    zone: string;
    boxPos: number | null;
    reversalConfirmed?: boolean;
    actualLowerBreakEvidence: boolean;
    closedBreakConfirmed: boolean;
    retestConfirmed: boolean;
    directionalShockState: string;
    hardBlockPresent: boolean;
    htf1hBias: string | null;
    htf4hBias: string | null;
    htf1dBias: string | null;
    htfEntryPolicy: string | null;
    now: number;
    consecutiveCyclesOverride?: number | null;
}

export interface EthFtsLowerShortStaleReleaseProof {
    event: "ETH_FTS_LOWER_SHORT_STALE_RELEASE_PROOF";
    symbol: string;
    boxPos: number | null;
    zone: string;
    trend_side_candidate: string;
    reversal_confirmed: boolean;
    actual_lower_break_evidence: boolean;
    closed_break_confirmed: boolean;
    retest_confirmed: boolean;
    directional_shock_state: string;
    htf_1h_bias: string | null;
    htf_4h_bias: string | null;
    htf_1d_bias: string | null;
    bullish_htf_count: number;
    stale_consecutive_cycles: number;
    stale_release_active: boolean;
    suppression_until: number;
    reset_reason: string | null;
    effective_side_after_release: string;
}

export interface EthFtsLowerShortStaleReleaseResult {
    staleReleaseActive: boolean;
    effectiveTrendSideCandidate: string;
    consecutiveCycles: number;
    suppressionUntil: number;
    resetReason: string | null;
    bullishHtfCount: number;
    bearishHtfCount: number;
    proof: EthFtsLowerShortStaleReleaseProof;
}

export const ethFtsLowerShortStaleStateMap = new Map<string, EthFtsLowerShortStaleReleaseState>();

export function resetEthFtsLowerShortStaleState(symbol?: string): void {
    if (symbol) {
        const norm = String(symbol).toUpperCase().replace("-SWAP", "").replace("-", "");
        ethFtsLowerShortStaleStateMap.delete(norm);
    } else {
        ethFtsLowerShortStaleStateMap.clear();
    }
}

export const ETH_FTS_STALE_SUPPRESSION_WINDOW_MS = 180_000; // 3 minutes (2~3 minute window)

/**
 * Evaluates ETH-specific FTS lower short stale authority release.
 * Ensures that an unconfirmed FTS lower short candidate does not permanently deadlock
 * fresh RANGE / reversal evaluation when HTF remains bullish.
 */
export function evaluateEthFtsLowerShortStaleRelease(
    input: EthFtsLowerShortStaleReleaseInput
): EthFtsLowerShortStaleReleaseResult {
    const rawSymbol = String(input.symbol ?? "");
    const normSymbol = rawSymbol.toUpperCase().replace("-SWAP", "").replace("-", "");
    const isEth = normSymbol === "ETHUSDT";

    // 1. Invariant: ETHUSDT dedicated (BTC and all others ignored)
    if (!isEth) {
        return {
            staleReleaseActive: false,
            effectiveTrendSideCandidate: input.trendSideCandidate,
            consecutiveCycles: 0,
            suppressionUntil: 0,
            resetReason: "SYMBOL_NOT_ETH",
            bullishHtfCount: 0,
            bearishHtfCount: 0,
            proof: {
                event: "ETH_FTS_LOWER_SHORT_STALE_RELEASE_PROOF",
                symbol: normSymbol,
                boxPos: input.boxPos,
                zone: input.zone,
                trend_side_candidate: input.trendSideCandidate,
                reversal_confirmed: input.reversalConfirmed === true,
                actual_lower_break_evidence: input.actualLowerBreakEvidence === true,
                closed_break_confirmed: input.closedBreakConfirmed === true,
                retest_confirmed: input.retestConfirmed === true,
                directional_shock_state: input.directionalShockState ?? "NONE",
                htf_1h_bias: input.htf1hBias ?? null,
                htf_4h_bias: input.htf4hBias ?? null,
                htf_1d_bias: input.htf1dBias ?? null,
                bullish_htf_count: 0,
                stale_consecutive_cycles: 0,
                stale_release_active: false,
                suppression_until: 0,
                reset_reason: "SYMBOL_NOT_ETH",
                effective_side_after_release: input.trendSideCandidate
            }
        };
    }

    // Breakdown and shock verification
    const hasBreakdownEvidence =
        input.actualLowerBreakEvidence === true ||
        input.closedBreakConfirmed === true ||
        input.retestConfirmed === true;
    const isDownShock = String(input.directionalShockState ?? "").toUpperCase() === "DOWN";

    // FTS short subtype & direction
    const isFtsSubtype = String(input.subtype ?? "").toUpperCase() === "FAST_TREND_SHIFT";
    const isFtsShort = String(input.ftsDirection ?? "").toLowerCase() === "short";
    const isFtsShortCandidate = isFtsSubtype && isFtsShort;

    // Location & candidate
    const isLowerZone = input.zone === "lower" || input.zone === "lower-extreme";
    const isBoxPosWithinThresh =
        typeof input.boxPos === "number" && Number.isFinite(input.boxPos) && input.boxPos <= 0.12;
    const isTrendShortCandidate = String(input.trendSideCandidate ?? "").toLowerCase() === "short";

    // Clean non-operator initial entry
    const isCleanInitial =
        input.isInitialEntry &&
        !input.isOperatorManaged &&
        !input.isManualTakeover &&
        !input.isAdoptedExternal;
    const noHardBlock = !input.hardBlockPresent;

    // HTF Alignment Protection:
    // Stale release is allowed if:
    // 1h / 4h / 1d 중 최소 2개 이상 BULLISH
    // 또는 기존 canonical HTF authority가 short continuation을 명시적으로 지지하지 않는 경우.
    // BEARISH HTF 다수 정렬이면 stale release 금지.
    const htfBiases = [
        String(input.htf1hBias ?? "").toUpperCase(),
        String(input.htf4hBias ?? "").toUpperCase(),
        String(input.htf1dBias ?? "").toUpperCase()
    ];
    const bullishHtfCount = htfBiases.filter((b) => b === "BULLISH").length;
    const bearishHtfCount = htfBiases.filter((b) => b === "BEARISH").length;
    const policy = String(input.htfEntryPolicy ?? "").trim().toUpperCase();
    const htfPolicyForbidsShort =
        policy === "LONG_ONLY_OR_NONE" ||
        policy === "LONG_ONLY" ||
        policy === "HOLD" ||
        policy === "NEUTRAL_HTF_DATA_WAIT";
    const htfAllowsRelease = (bullishHtfCount >= 2 || htfPolicyForbidsShort) && bearishHtfCount < 2;

    // Determine reset reason if any invariant fails
    let resetReason: string | null = null;
    if (!isCleanInitial) {
        resetReason = "POSITION_OR_MANUAL_ACTIVE";
    } else if (!noHardBlock) {
        resetReason = "HARD_BLOCK_PRESENT";
    } else if (hasBreakdownEvidence) {
        resetReason = "LOWER_BREAKDOWN_OR_RETEST_CONFIRMED";
    } else if (isDownShock) {
        resetReason = "DOWN_SHOCK_TRIGGERED";
    } else if (!isFtsShortCandidate) {
        resetReason = "FTS_SHORT_INACTIVE";
    } else if (!isLowerZone) {
        resetReason = "ZONE_NOT_LOWER";
    } else if (!isBoxPosWithinThresh) {
        resetReason = "BOX_POS_ABOVE_THRESHOLD";
    } else if (!isTrendShortCandidate) {
        resetReason = "TREND_SIDE_NOT_SHORT";
    } else if (!htfAllowsRelease) {
        resetReason = "HTF_BEARISH_ALIGNMENT_FORBIDS_RELEASE";
    }

    let state = ethFtsLowerShortStaleStateMap.get(normSymbol);
    if (!state) {
        state = {
            symbol: normSymbol,
            consecutiveCycles: 0,
            suppressionUntil: 0,
            staleReleaseActive: false,
            lastResetReason: null
        };
        ethFtsLowerShortStaleStateMap.set(normSymbol, state);
    }

    const now = input.now ?? Date.now();

    if (resetReason != null) {
        state.consecutiveCycles = 0;
        state.suppressionUntil = 0;
        state.staleReleaseActive = false;
        state.lastResetReason = resetReason;
    } else {
        state.lastResetReason = null;
        if (typeof input.consecutiveCyclesOverride === "number") {
            state.consecutiveCycles = input.consecutiveCyclesOverride;
        } else {
            state.consecutiveCycles += 1;
        }

        if (state.suppressionUntil > now) {
            state.staleReleaseActive = true;
        } else if (state.consecutiveCycles >= 3) {
            state.staleReleaseActive = true;
            state.suppressionUntil = now + ETH_FTS_STALE_SUPPRESSION_WINDOW_MS;
        } else {
            state.staleReleaseActive = false;
        }
    }

    const effectiveSide = state.staleReleaseActive ? "none" : input.trendSideCandidate;

    const proof: EthFtsLowerShortStaleReleaseProof = {
        event: "ETH_FTS_LOWER_SHORT_STALE_RELEASE_PROOF",
        symbol: normSymbol,
        boxPos: input.boxPos,
        zone: input.zone,
        trend_side_candidate: input.trendSideCandidate,
        reversal_confirmed: input.reversalConfirmed === true,
        actual_lower_break_evidence: input.actualLowerBreakEvidence === true,
        closed_break_confirmed: input.closedBreakConfirmed === true,
        retest_confirmed: input.retestConfirmed === true,
        directional_shock_state: input.directionalShockState ?? "NONE",
        htf_1h_bias: input.htf1hBias ?? null,
        htf_4h_bias: input.htf4hBias ?? null,
        htf_1d_bias: input.htf1dBias ?? null,
        bullish_htf_count: bullishHtfCount,
        stale_consecutive_cycles: state.consecutiveCycles,
        stale_release_active: state.staleReleaseActive,
        suppression_until: state.suppressionUntil,
        reset_reason: resetReason,
        effective_side_after_release: effectiveSide
    };

    console.info(JSON.stringify(proof));

    return {
        staleReleaseActive: state.staleReleaseActive,
        effectiveTrendSideCandidate: effectiveSide,
        consecutiveCycles: state.consecutiveCycles,
        suppressionUntil: state.suppressionUntil,
        resetReason,
        bullishHtfCount,
        bearishHtfCount,
        proof
    };
}

export interface StaleFtsLowerShortRejectEligibilityInput {
    ethFtsLowerShortStaleActive: boolean;
    v2DecisionAfterPromotion: string;
    v2RejectReasonAfterPromotion: string | null;
    v2SideBeforePromotion?: string | null;
    v2SideAfterPromotion?: string | null;
    trendSideCandidate: string;
    ftsDirection: string | null | undefined;
    zone: string;
    hardBlockPresent: boolean;
    hardControlClear: boolean;
    isCleanManual: boolean;
    hasBreakdownEvidence: boolean;
    directionalShockState: string;
}

/**
 * Validates whether an active REJECT state originated from a stale FTS lower short
 * structural-stop failure / risk blocker and is strictly eligible for fresh RANGE re-evaluation.
 * Ensures that generic REJECTs (e.g. kill switches, daily loss, exposure limits, wrong zone) are NOT bypassed.
 */
export function isStaleFtsLowerShortRejectEligibleForFreshRangeReevaluation(
    input: StaleFtsLowerShortRejectEligibilityInput
): boolean {
    if (!input.ethFtsLowerShortStaleActive) return false;
    if (input.v2DecisionAfterPromotion !== "REJECT") return false;
    if (input.hardBlockPresent) return false;
    if (!input.hardControlClear) return false;
    if (!input.isCleanManual) return false;
    if (input.hasBreakdownEvidence) return false;
    if (String(input.directionalShockState ?? "").toUpperCase() === "DOWN") return false;
    if (input.zone !== "lower" && input.zone !== "lower-extreme") return false;
    if (String(input.ftsDirection ?? "").toLowerCase() !== "short") return false;

    const isShortOrigin =
        input.v2SideBeforePromotion === "short" ||
        input.trendSideCandidate === "short" ||
        input.v2SideAfterPromotion === "short";
    if (!isShortOrigin) return false;

    const reason = String(input.v2RejectReasonAfterPromotion ?? "");
    const isStaleRiskOrigin =
        reason.includes("STOP_DISTANCE_TOO_WIDE") ||
        reason.includes("ENTRY_BLOCKED_NO_STRUCTURAL_STOP") ||
        reason.includes("NO_STRUCTURAL_STOP") ||
        reason.includes("STOP_PRICE_MISSING") ||
        reason.includes("CHASE_SHORT_DISALLOWED_LOWER") ||
        reason.includes("SIDE_ZONE_MISMATCH_LOWER_SHORT") ||
        reason.includes("WAIT_RECHECK") ||
        reason.includes("NO_BREAKDOWN_CONFIRMED") ||
        reason.includes("CONFLICT_TREND_STOP_INVALID") ||
        reason.includes("CONFLICT_STOP_PRICE_NULL") ||
        reason.includes("STOP_PLAN_INVALID");

    return isStaleRiskOrigin;
}

