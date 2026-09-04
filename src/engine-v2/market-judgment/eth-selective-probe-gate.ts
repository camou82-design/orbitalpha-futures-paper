export interface EthStructuralConfirmationSelectiveFilterInput {
    symbol: string;
    side: "long" | "short";
    probeSemantic: string; // "EARLY_LONG_PROBE" | "EARLY_SHORT_PROBE" | "FAST_TREND_SHIFT_PROBE"
    macroPolarity?: "BULLISH" | "BEARISH" | "NEUTRAL" | null;
    htfH1Bias?: string | null;
    htfH4Bias?: string | null;
    shockPhase?: string | null;
    directionalShockState?: string | null;
    emaGap?: number | null;
    trendWeaknessScore?: number | null;
    reclaimConfirmed?: boolean | null;
    retestConfirmed?: boolean | null;
    reversalConfirmed?: boolean | null;
}

export interface EthStructuralConfirmationSelectiveFilterResult {
    blocked: boolean;
    blockReason: string | null;
    countertrendAgainstMacro: boolean;
    countertrendSource: string;
    reclaimConfirmed: boolean;
    retestConfirmed: boolean;
    reversalConfirmed: boolean;
    structuralConfirmationCount: number;
    trendWeaknessScore: number;
    emaGap: number;
    counterShockActive: boolean;
    riskClausePassed: boolean;
}

/**
 * Selective structural confirmation filter for ETHUSDT probes.
 * Blocks unconfirmed counter-trend probes without modifying BTC, HTF hard vetos, stop policies, or winning entries.
 */
export function evaluateEthStructuralConfirmationSelectiveFilter(
    input: EthStructuralConfirmationSelectiveFilterInput
): EthStructuralConfirmationSelectiveFilterResult {
    const isEth = String(input.symbol ?? "").toUpperCase() === "ETHUSDT";
    const side = input.side;
    const probeSemantic = input.probeSemantic;

    const isProbe = (
        probeSemantic === "EARLY_LONG_PROBE" ||
        probeSemantic === "EARLY_SHORT_PROBE" ||
        probeSemantic === "FAST_TREND_SHIFT_PROBE"
    );

    const shock = String(input.shockPhase ?? "").toUpperCase();
    const dss = String(input.directionalShockState ?? "").toUpperCase();
    const emaGap = typeof input.emaGap === "number" && Number.isFinite(input.emaGap) ? input.emaGap : 0;
    const tw = typeof input.trendWeaknessScore === "number" && Number.isFinite(input.trendWeaknessScore) ? input.trendWeaknessScore : 1;
    const macroPol = String(input.macroPolarity ?? "NEUTRAL").toUpperCase();
    const h1 = String(input.htfH1Bias ?? "").toUpperCase();
    const h4 = String(input.htfH4Bias ?? "").toUpperCase();

    let countertrendAgainstMacro = false;
    let countertrendSource = "none";
    let counterShockActive = false;

    if (side === "long") {
        if (shock === "DOWN_SHOCK" || dss === "DOWN") {
            countertrendAgainstMacro = true;
            counterShockActive = true;
            countertrendSource = "down_shock_active";
        } else if (macroPol === "BEARISH" || h4 === "BEARISH" || h1 === "BEARISH") {
            countertrendAgainstMacro = true;
            countertrendSource = "htf_bearish_bias";
        } else if (emaGap < -0.003) {
            countertrendAgainstMacro = true;
            countertrendSource = "negative_ema_gap";
        }
    } else if (side === "short") {
        if (shock === "UP_SHOCK" || dss === "UP") {
            countertrendAgainstMacro = true;
            counterShockActive = true;
            countertrendSource = "up_shock_active";
        } else if (macroPol === "BULLISH" || h4 === "BULLISH" || h1 === "BULLISH") {
            countertrendAgainstMacro = true;
            countertrendSource = "htf_bullish_bias";
        } else if (emaGap > 0.003) {
            countertrendAgainstMacro = true;
            countertrendSource = "positive_ema_gap";
        }
    }

    const reclaimConfirmed = input.reclaimConfirmed === true;
    const retestConfirmed = input.retestConfirmed === true;
    const reversalConfirmed = input.reversalConfirmed === true;

    let structuralConfirmationCount = 0;
    if (reclaimConfirmed) structuralConfirmationCount++;
    if (retestConfirmed) structuralConfirmationCount++;
    if (reversalConfirmed) structuralConfirmationCount++;

    const riskClausePassed = tw >= 0.40 || Math.abs(emaGap) > 0.003 || counterShockActive;

    const shouldBlock = (
        isEth &&
        isProbe &&
        countertrendAgainstMacro &&
        structuralConfirmationCount === 0 &&
        riskClausePassed
    );

    const blockReason = shouldBlock ? "ETH_UNCONFIRMED_COUNTER_TREND_PROBE_BLOCKED" : null;

    if (isEth && isProbe) {
        console.info(
            JSON.stringify({
                event: "ETH_STRUCTURAL_CONFIRMATION_SELECTIVE_FILTER_PROOF",
                symbol: input.symbol,
                side: input.side,
                probe_semantic: probeSemantic,
                countertrend_against_macro: countertrendAgainstMacro,
                countertrend_source: countertrendSource,
                reclaim_confirmed: reclaimConfirmed,
                retest_confirmed: retestConfirmed,
                reversal_confirmed: reversalConfirmed,
                structural_confirmation_count: structuralConfirmationCount,
                trend_weakness_score: tw,
                ema_gap: emaGap,
                counter_shock_active: counterShockActive,
                risk_clause_passed: riskClausePassed,
                blocked: shouldBlock,
                block_reason: blockReason
            })
        );
    }

    return {
        blocked: shouldBlock,
        blockReason,
        countertrendAgainstMacro,
        countertrendSource,
        reclaimConfirmed,
        retestConfirmed,
        reversalConfirmed,
        structuralConfirmationCount,
        trendWeaknessScore: tw,
        emaGap,
        counterShockActive,
        riskClausePassed
    };
}
