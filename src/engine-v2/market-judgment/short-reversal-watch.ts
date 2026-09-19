import { getClosedCandlesForStructuralStop } from "../risk-sizing/fast-trend-shift-structural-stop";

export interface ShortReversalWatchInput {
    symbol: string;
    htfPolicy?: string | null;
    originalHtfPolicy?: string | null;
    directionalShockState?: string | null;
    shockPhase?: string | null;
    lastPrice: number;
    boxHigh?: number | null;
    boxLow?: number | null;
    breakoutLevel?: number | null;
    candles?: any[] | null;
    htf?: Record<string, any[]> | null;
    htf1hBias?: string | null;
    htf15mBias?: string | null;
    macroPolarity?: string | null;
    trendWeaknessScore?: number | null;
    canonicalRegime?: string | null;
    regime?: string | null;
    subtype?: string | null;
    zone?: string | null;
}

export interface ShortReversalWatchResult {
    active: boolean;
    breakout_failed: boolean;
    lower_high_confirmed: boolean;
    micro_structure_break: boolean;
    trough_break_confirmed: boolean;
    probe_allowed: boolean;
    probe_block_reason: string | null;
    htf_upgrade_ready: boolean;
    exception_eligible: boolean;
    final_short_authority: string | null;
    size_class: "PROBE" | "NORMAL" | "NONE";
    rejection_reason: string | null;
    invalidationPrice?: number;
    stopPrice?: number;
    proof: Record<string, unknown>;
}

export function evaluateShortReversalWatch(
    input: ShortReversalWatchInput
): ShortReversalWatchResult {
    const symbol = String(input.symbol ?? "").toUpperCase();
    const lastPrice = Number(input.lastPrice ?? 0);
    const boxHigh = Number(input.boxHigh ?? input.breakoutLevel ?? 0);
    const rawCandles = input.candles || [];
    const closedCandles = getClosedCandlesForStructuralStop(rawCandles);
    const directionalShockState = String(input.directionalShockState ?? "NONE").toUpperCase();
    const shockPhase = String(input.shockPhase ?? "NONE").toUpperCase();
    const originalHtfPolicy = String(input.originalHtfPolicy ?? input.htfPolicy ?? "").toUpperCase();
    const macroPolarity = String(input.macroPolarity ?? "NEUTRAL").toUpperCase();
    const canonicalRegime = String(input.canonicalRegime ?? input.regime ?? "RANGE").toUpperCase();
    const regime = String(input.regime ?? input.canonicalRegime ?? "RANGE").toUpperCase();
    const subtype = String(input.subtype ?? "").toUpperCase();
    const rawZone = String(input.zone ?? "").toLowerCase();
    const normalizedZone = (rawZone === "upper" || rawZone === "upper-extreme" || rawZone === "upper_extreme") ? rawZone : (rawZone || "unknown");

    if (directionalShockState === "DOWN" || shockPhase === "DOWN_SHOCK" || originalHtfPolicy === "SHORT_ONLY_OR_NONE") {
        const rejection_reason = "DOWN_SHOCK_ACTIVE";
        const proof = {
            event: "V2_SHORT_REVERSAL_WATCH_PROOF",
            symbol,
            breakout_failed: false,
            lower_high_confirmed: false,
            micro_structure_break: false,
            probe_allowed: false,
            probe_block_reason: rejection_reason,
            htf_upgrade_ready: false
        };
        console.info(JSON.stringify(proof));

        console.info(JSON.stringify({
            event: "V2_SHORT_REVERSAL_POLARITY_EXCEPTION_PROOF",
            symbol,
            regime: canonicalRegime || regime,
            subtype,
            zone: normalizedZone,
            macro_polarity: macroPolarity,
            original_htf_policy: originalHtfPolicy,
            breakout_failed: false,
            lower_high_confirmed: false,
            trough_break_confirmed: false,
            exception_eligible: false,
            final_short_authority: null,
            size_class: "NONE",
            rejection_reason
        }));

        return {
            active: false,
            breakout_failed: false,
            lower_high_confirmed: false,
            micro_structure_break: false,
            trough_break_confirmed: false,
            probe_allowed: false,
            probe_block_reason: rejection_reason,
            htf_upgrade_ready: false,
            exception_eligible: false,
            final_short_authority: null,
            size_class: "NONE",
            rejection_reason,
            proof
        };
    }

    // 1. Breakout failed: Price pierced above boxHigh / breakoutLevel on closed candles and re-entered below
    let breakout_failed = false;
    let maxRecentHigh = 0;
    let maxHighIdx = -1;

    const lookback = closedCandles.slice(-25);
    if (boxHigh > 0 && lastPrice > 0 && lookback.length >= 3) {
        for (let i = 0; i < lookback.length; i++) {
            const h = Number(lookback[i].high ?? 0);
            if (h > maxRecentHigh) {
                maxRecentHigh = h;
                maxHighIdx = i;
            }
        }
        // Strict boxHigh touch or pierce (at least maxRecentHigh >= boxHigh)
        const piercedAbove = maxRecentHigh >= boxHigh;
        const lastClosedPrice = Number(lookback[lookback.length - 1].close ?? 0);
        const reenteredBelow = lastClosedPrice < boxHigh;
        breakout_failed = piercedAbove && reenteredBelow;
    }

    // 2. Lower-high confirmed (Strict multi-candle structure on closed candles, NOT a single candle drop)
    let lower_high_confirmed = false;
    let micro_structure_break = false;
    let intermediateLow = Infinity;
    let lowerHighPrice = 0;

    if (breakout_failed && lookback.length >= 4 && maxHighIdx >= 0) {
        // Look for peaks after maxHighIdx
        let foundTrough = false;
        let troughIdx = -1;
        let troughLow = Infinity;

        for (let i = maxHighIdx + 1; i < lookback.length - 1; i++) {
            const low = Number(lookback[i].low ?? 0);
            if (low > 0 && low < troughLow) {
                troughLow = low;
                troughIdx = i;
                foundTrough = true;
            }
        }

        if (foundTrough && troughIdx > maxHighIdx) {
            intermediateLow = troughLow;
            let secondaryPeakHigh = 0;
            let secondaryPeakIdx = -1;

            for (let i = troughIdx + 1; i < lookback.length; i++) {
                const h = Number(lookback[i].high ?? 0);
                if (h > secondaryPeakHigh) {
                    secondaryPeakHigh = h;
                    secondaryPeakIdx = i;
                }
            }

            // Lower high requires:
            // 1. secondary peak is below primary peak (maxRecentHigh)
            // 2. secondary peak had a noticeable bounce above the trough (at least 0.1% bounce)
            // 3. closed confirmation candle rejecting from secondary peak
            const bounceValid = secondaryPeakHigh > troughLow * 1.001;
            const isLower = secondaryPeakHigh < maxRecentHigh * 0.9995;
            const lastClosedClose = Number(lookback[lookback.length - 1].close ?? 0);
            const hasConfirmationCandle = secondaryPeakIdx < lookback.length - 1 || lastClosedClose < secondaryPeakHigh;

            if (isLower && bounceValid && hasConfirmationCandle) {
                lower_high_confirmed = true;
                lowerHighPrice = secondaryPeakHigh;
            }

            // 3. Micro structure break / intermediate trough low break confirmed ON CLOSED CANDLES
            if (lower_high_confirmed && Number.isFinite(intermediateLow) && secondaryPeakIdx >= 0) {
                for (let i = secondaryPeakIdx; i < lookback.length; i++) {
                    const c = Number(lookback[i].close ?? 0);
                    const l = Number(lookback[i].low ?? 0);
                    if (c < intermediateLow || l < intermediateLow) {
                        micro_structure_break = true;
                        break;
                    }
                }
            }
        }
    }

    // Single candle false break protection: If candle count after breakout is < 3, never confirm lower high
    if (lookback.length - maxHighIdx < 3) {
        lower_high_confirmed = false;
        micro_structure_break = false;
    }

    const trough_break_confirmed = micro_structure_break;
    const probe_allowed = breakout_failed && lower_high_confirmed && trough_break_confirmed;
    let probe_block_reason: string | null = null;
    if (!probe_allowed) {
        if (!breakout_failed) {
            probe_block_reason = "BREAKOUT_NOT_FAILED";
        } else if (!lower_high_confirmed) {
            probe_block_reason = "LOWER_HIGH_NOT_CONFIRMED";
        } else if (!trough_break_confirmed) {
            probe_block_reason = "MICRO_STRUCTURE_NOT_BROKEN";
        }
    }

    // 4. HTF Upgrade Check (15m and 1h weakness alignment)
    let htf_upgrade_ready = false;
    if (probe_allowed) {
        const h1 = String(input.htf1hBias ?? "").toUpperCase();
        const h15 = String(input.htf15mBias ?? "").toUpperCase();

        const htf15mWeak =
            h15.includes("BEAR") ||
            h15.includes("WEAK") ||
            h15.includes("DOWN") ||
            (input.htf?.["15m"] && isHtfCandleSequenceBearish(input.htf["15m"]));

        const htf1hWeak =
            h1.includes("BEAR") ||
            h1.includes("WEAK") ||
            h1.includes("DOWN") ||
            macroPolarity === "BEARISH" ||
            (input.htf?.["1h"] && isHtfCandleSequenceBearish(input.htf["1h"]));

        if (htf15mWeak && htf1hWeak) {
            htf_upgrade_ready = true;
        }
    }

    // 5. Polarity Exception Evaluation (Controlled Bullish HTF Exception)
    // Exception conditions:
    // - canonicalRegime === RANGE
    // - upper / upper-extreme zone
    // - RANGE_FAKE_BREAKOUT or WHIPSAW_SOFT_WATCH (or fallback if full 3-step structural confirmation met)
    // - breakout failure confirmed
    // - multi-candle lower-high confirmed
    // - intermediate trough low break confirmed
    const isRangeRegime = canonicalRegime ? canonicalRegime === "RANGE" : regime === "RANGE";
    const isUpperZone = normalizedZone === "upper" || normalizedZone === "upper-extreme" || normalizedZone === "upper_extreme";
    const isTargetSubtype =
        subtype === "RANGE_FAKE_BREAKOUT" ||
        subtype === "WHIPSAW_SOFT_WATCH" ||
        subtype === "FAKE_BREAKOUT" ||
        subtype === "WHIPSAW_SHOCK_RECHECK" ||
        subtype === "" ||
        subtype === "UNKNOWN";

    const isStructuralReversalComplete = breakout_failed && lower_high_confirmed && trough_break_confirmed;

    let exception_eligible = false;
    let final_short_authority: string | null = null;
    let size_class: "PROBE" | "NORMAL" | "NONE" = "NONE";
    let rejection_reason: string | null = probe_block_reason;

    if (isStructuralReversalComplete) {
        if (!isRangeRegime) {
            rejection_reason = "NOT_RANGE_REGIME";
        } else if (!isUpperZone) {
            rejection_reason = "NOT_UPPER_ZONE";
        } else if (!isTargetSubtype) {
            rejection_reason = "SUBTYPE_NOT_ELIGIBLE";
        } else {
            exception_eligible = true;
            if (htf_upgrade_ready) {
                final_short_authority = "V2_SHORT_REVERSAL_HTF_UPGRADED_AUTHORITY";
                size_class = "NORMAL";
            } else {
                final_short_authority = "V2_SHORT_REVERSAL_WATCH_PROBE";
                size_class = "PROBE";
            }
            rejection_reason = null;
        }
    }

    const active = breakout_failed;
    const invalidationPrice = maxRecentHigh > 0 ? maxRecentHigh * 1.002 : undefined;
    const stopPrice = lowerHighPrice > 0 ? lowerHighPrice * 1.002 : invalidationPrice;

    const proof = {
        event: "V2_SHORT_REVERSAL_WATCH_PROOF",
        symbol,
        breakout_failed,
        lower_high_confirmed,
        micro_structure_break,
        probe_allowed,
        probe_block_reason,
        htf_upgrade_ready
    };

    console.info(JSON.stringify(proof));

    console.info(JSON.stringify({
        event: "V2_SHORT_REVERSAL_POLARITY_EXCEPTION_PROOF",
        symbol,
        regime: canonicalRegime || regime,
        subtype,
        zone: normalizedZone,
        macro_polarity: macroPolarity,
        original_htf_policy: originalHtfPolicy,
        breakout_failed,
        lower_high_confirmed,
        trough_break_confirmed,
        exception_eligible,
        final_short_authority,
        size_class,
        rejection_reason
    }));

    return {
        active,
        breakout_failed,
        lower_high_confirmed,
        micro_structure_break,
        trough_break_confirmed,
        probe_allowed,
        probe_block_reason,
        htf_upgrade_ready,
        exception_eligible,
        final_short_authority,
        size_class,
        rejection_reason,
        invalidationPrice,
        stopPrice,
        proof
    };
}

function isHtfCandleSequenceBearish(candles: any[]): boolean {
    if (!Array.isArray(candles) || candles.length < 2) return false;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const lastClose = Number(last.close ?? last.c ?? 0);
    const lastOpen = Number(last.open ?? last.o ?? 0);
    const prevClose = Number(prev.close ?? prev.c ?? 0);
    return lastClose < lastOpen || lastClose < prevClose;
}

