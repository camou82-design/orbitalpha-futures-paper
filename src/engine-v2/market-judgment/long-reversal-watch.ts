import { getClosedCandlesForStructuralStop } from "../risk-sizing/fast-trend-shift-structural-stop";

export interface LongReversalWatchInput {
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

export interface LongReversalWatchResult {
    active: boolean;
    breakdown_failed: boolean;
    higher_low_confirmed: boolean;
    micro_structure_break: boolean;
    peak_break_confirmed: boolean;
    probe_allowed: boolean;
    probe_block_reason: string | null;
    htf_upgrade_ready: boolean;
    exception_eligible: boolean;
    final_long_authority: string | null;
    size_class: "PROBE" | "NORMAL" | "NONE";
    rejection_reason: string | null;
    invalidationPrice?: number;
    stopPrice?: number;
    proof: Record<string, unknown>;
}

export function evaluateLongReversalWatch(
    input: LongReversalWatchInput
): LongReversalWatchResult {
    const symbol = String(input.symbol ?? "").toUpperCase();
    const lastPrice = Number(input.lastPrice ?? 0);
    const boxLow = Number(input.boxLow ?? input.breakoutLevel ?? 0);
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
    const normalizedZone = (rawZone === "lower" || rawZone === "lower-extreme" || rawZone === "lower_extreme") ? rawZone : (rawZone || "unknown");

    if (directionalShockState === "UP" || shockPhase === "UP_SHOCK" || originalHtfPolicy === "LONG_ONLY_OR_NONE") {
        const rejection_reason = "UP_SHOCK_ACTIVE";
        const proof = {
            event: "V2_LONG_REVERSAL_WATCH_PROOF",
            symbol,
            breakdown_failed: false,
            higher_low_confirmed: false,
            micro_structure_break: false,
            probe_allowed: false,
            probe_block_reason: rejection_reason,
            htf_upgrade_ready: false
        };
        console.info(JSON.stringify(proof));

        console.info(JSON.stringify({
            event: "V2_LONG_REVERSAL_POLARITY_EXCEPTION_PROOF",
            symbol,
            regime: canonicalRegime || regime,
            subtype,
            zone: normalizedZone,
            macro_polarity: macroPolarity,
            original_htf_policy: originalHtfPolicy,
            breakdown_failed: false,
            higher_low_confirmed: false,
            peak_break_confirmed: false,
            exception_eligible: false,
            final_long_authority: null,
            size_class: "NONE",
            rejection_reason
        }));

        console.info(JSON.stringify({
            event: "V2_LONG_REVERSAL_WATCH_EVALUATION_PROOF",
            symbol,
            canonical_regime: canonicalRegime || regime,
            zone: normalizedZone,
            boxLow,
            minRecentLow: null,
            piercedBelow: false,
            lastClosedPrice: null,
            reenteredAbove: false,
            higherLowConfirmed: false,
            intermediatePeakPrice: null,
            peakBreakConfirmed: false,
            probe_allowed: false,
            exception_eligible: false,
            htf_upgrade_ready: false,
            promotion_reason: null
        }));

        return {
            active: false,
            breakdown_failed: false,
            higher_low_confirmed: false,
            micro_structure_break: false,
            peak_break_confirmed: false,
            probe_allowed: false,
            probe_block_reason: rejection_reason,
            htf_upgrade_ready: false,
            exception_eligible: false,
            final_long_authority: null,
            size_class: "NONE",
            rejection_reason,
            proof
        };
    }

    // 1. Breakdown failed: Price pierced below boxLow / breakoutLevel on closed candles and re-entered above
    let breakdown_failed = false;
    let minRecentLow = Infinity;
    let minLowIdx = -1;

    const lookback = closedCandles.slice(-25);
    let piercedBelow = false;
    let lastClosedPrice = 0;
    let reenteredAbove = false;

    if (boxLow > 0 && lastPrice > 0 && lookback.length >= 3) {
        for (let i = 0; i < lookback.length; i++) {
            const l = Number(lookback[i].low ?? 0);
            if (l > 0 && l < minRecentLow) {
                minRecentLow = l;
                minLowIdx = i;
            }
        }
        // Strict boxLow touch or pierce (at least minRecentLow <= boxLow)
        piercedBelow = Number.isFinite(minRecentLow) && minRecentLow <= boxLow;
        lastClosedPrice = Number(lookback[lookback.length - 1].close ?? 0);
        reenteredAbove = lastClosedPrice > boxLow;
        breakdown_failed = piercedBelow && reenteredAbove;
    }

    // 2. Higher-low confirmed (Strict multi-candle structure on closed candles, NOT a single candle jump)
    let higher_low_confirmed = false;
    let micro_structure_break = false;
    let intermediatePeakPrice = 0;
    let higherLowPrice = 0;

    if (breakdown_failed && lookback.length >= 4 && minLowIdx >= 0) {
        // Look for peaks after minLowIdx
        let foundPeak = false;
        let peakIdx = -1;
        let peakHigh = 0;

        for (let i = minLowIdx + 1; i < lookback.length - 1; i++) {
            const high = Number(lookback[i].high ?? 0);
            if (high > peakHigh) {
                peakHigh = high;
                peakIdx = i;
                foundPeak = true;
            }
        }

        if (foundPeak && peakIdx > minLowIdx) {
            intermediatePeakPrice = peakHigh;
            let secondaryTroughLow = Infinity;
            let secondaryTroughIdx = -1;

            for (let i = peakIdx + 1; i < lookback.length; i++) {
                const l = Number(lookback[i].low ?? 0);
                if (l > 0 && l < secondaryTroughLow) {
                    secondaryTroughLow = l;
                    secondaryTroughIdx = i;
                }
            }

            // Higher low requires:
            // 1. secondary trough is above primary trough (minRecentLow)
            // 2. secondary trough had a noticeable pullback below the peak (at least 0.1% pullback)
            // 3. closed confirmation candle rejecting/bouncing from secondary trough
            const pullbackValid = secondaryTroughLow < peakHigh * 0.999;
            const isHigher = secondaryTroughLow > minRecentLow * 1.0005;
            const lastClosedClose = Number(lookback[lookback.length - 1].close ?? 0);
            const hasConfirmationCandle = secondaryTroughIdx < lookback.length - 1 || lastClosedClose > secondaryTroughLow;

            if (isHigher && pullbackValid && hasConfirmationCandle) {
                higher_low_confirmed = true;
                higherLowPrice = secondaryTroughLow;
            }

            // 3. Micro structure break / intermediate peak high break confirmed ON CLOSED CANDLES
            if (higher_low_confirmed && intermediatePeakPrice > 0 && secondaryTroughIdx >= 0) {
                for (let i = secondaryTroughIdx; i < lookback.length; i++) {
                    const c = Number(lookback[i].close ?? 0);
                    const h = Number(lookback[i].high ?? 0);
                    if (c > intermediatePeakPrice || h > intermediatePeakPrice) {
                        micro_structure_break = true;
                        break;
                    }
                }
            }
        }
    }

    // Single candle false break protection: If candle count after breakdown is < 3, never confirm higher low
    if (lookback.length - minLowIdx < 3) {
        higher_low_confirmed = false;
        micro_structure_break = false;
    }

    const peak_break_confirmed = micro_structure_break;
    const probe_allowed = breakdown_failed && higher_low_confirmed && peak_break_confirmed;
    let probe_block_reason: string | null = null;
    if (!probe_allowed) {
        if (!breakdown_failed) {
            probe_block_reason = "BREAKDOWN_NOT_FAILED";
        } else if (!higher_low_confirmed) {
            probe_block_reason = "HIGHER_LOW_NOT_CONFIRMED";
        } else if (!peak_break_confirmed) {
            probe_block_reason = "MICRO_STRUCTURE_NOT_BROKEN";
        }
    }

    // 4. HTF Upgrade Check (15m and 1h bullish alignment)
    let htf_upgrade_ready = false;
    if (probe_allowed) {
        const h1 = String(input.htf1hBias ?? "").toUpperCase();
        const h15 = String(input.htf15mBias ?? "").toUpperCase();

        const htf15mBullish =
            h15.includes("BULL") ||
            h15.includes("STRONG") ||
            h15.includes("UP") ||
            (input.htf?.["15m"] && isHtfCandleSequenceBullish(input.htf["15m"]));

        const htf1hBullish =
            h1.includes("BULL") ||
            h1.includes("STRONG") ||
            h1.includes("UP") ||
            macroPolarity === "BULLISH" ||
            (input.htf?.["1h"] && isHtfCandleSequenceBullish(input.htf["1h"]));

        if (htf15mBullish && htf1hBullish) {
            htf_upgrade_ready = true;
        }
    }

    // 5. Polarity Exception Evaluation (Controlled Bearish HTF Exception)
    // Exception conditions:
    // - canonicalRegime === RANGE
    // - lower / lower-extreme zone
    // - RANGE_FAKE_BREAKDOWN or WHIPSAW_SOFT_WATCH (or fallback if full 3-step structural confirmation met)
    // - breakdown failure confirmed
    // - multi-candle higher-low confirmed
    // - intermediate peak high break confirmed
    const isRangeRegime = canonicalRegime ? canonicalRegime === "RANGE" : regime === "RANGE";
    const isLowerZone = normalizedZone === "lower" || normalizedZone === "lower-extreme" || normalizedZone === "lower_extreme";
    const isTargetSubtype =
        subtype === "RANGE_FAKE_BREAKDOWN" ||
        subtype === "WHIPSAW_SOFT_WATCH" ||
        subtype === "FAKE_BREAKOUT" ||
        subtype === "WHIPSAW_SHOCK_RECHECK" ||
        subtype.startsWith("RANGE") ||
        subtype === "" ||
        subtype === "UNKNOWN";

    const isStructuralReversalComplete = breakdown_failed && higher_low_confirmed && peak_break_confirmed;

    let exception_eligible = false;
    let final_long_authority: string | null = null;
    let size_class: "PROBE" | "NORMAL" | "NONE" = "NONE";
    let rejection_reason: string | null = probe_block_reason;

    if (isStructuralReversalComplete) {
        if (!isRangeRegime) {
            rejection_reason = "NOT_RANGE_REGIME";
        } else if (!isLowerZone) {
            rejection_reason = "NOT_LOWER_ZONE";
        } else if (!isTargetSubtype) {
            rejection_reason = "SUBTYPE_NOT_ELIGIBLE";
        } else {
            exception_eligible = true;
            if (htf_upgrade_ready) {
                final_long_authority = "V2_LONG_REVERSAL_HTF_UPGRADED_AUTHORITY";
                size_class = "NORMAL";
            } else {
                final_long_authority = "V2_LONG_REVERSAL_WATCH_PROBE";
                size_class = "PROBE";
            }
            rejection_reason = null;
        }
    }

    const active = breakdown_failed;
    const invalidationPrice = minRecentLow > 0 && Number.isFinite(minRecentLow) ? minRecentLow * 0.998 : undefined;
    const stopPrice = higherLowPrice > 0 ? higherLowPrice * 0.998 : invalidationPrice;

    const proof = {
        event: "V2_LONG_REVERSAL_WATCH_PROOF",
        symbol,
        breakdown_failed,
        higher_low_confirmed,
        micro_structure_break,
        probe_allowed,
        probe_block_reason,
        htf_upgrade_ready
    };

    console.info(JSON.stringify(proof));

    console.info(JSON.stringify({
        event: "V2_LONG_REVERSAL_POLARITY_EXCEPTION_PROOF",
        symbol,
        regime: canonicalRegime || regime,
        subtype,
        zone: normalizedZone,
        macro_polarity: macroPolarity,
        original_htf_policy: originalHtfPolicy,
        breakdown_failed,
        higher_low_confirmed,
        peak_break_confirmed,
        exception_eligible,
        final_long_authority,
        size_class,
        rejection_reason
    }));

    console.info(JSON.stringify({
        event: "V2_LONG_REVERSAL_WATCH_EVALUATION_PROOF",
        symbol,
        canonical_regime: canonicalRegime || regime,
        zone: normalizedZone,
        boxLow,
        minRecentLow: Number.isFinite(minRecentLow) ? minRecentLow : null,
        piercedBelow,
        lastClosedPrice,
        reenteredAbove,
        higherLowConfirmed: higher_low_confirmed,
        intermediatePeakPrice: intermediatePeakPrice > 0 ? intermediatePeakPrice : null,
        peakBreakConfirmed: peak_break_confirmed,
        probe_allowed,
        exception_eligible,
        htf_upgrade_ready,
        promotion_reason: final_long_authority
    }));

    return {
        active,
        breakdown_failed,
        higher_low_confirmed,
        micro_structure_break,
        peak_break_confirmed,
        probe_allowed,
        probe_block_reason,
        htf_upgrade_ready,
        exception_eligible,
        final_long_authority,
        size_class,
        rejection_reason,
        invalidationPrice,
        stopPrice,
        proof
    };
}

function isHtfCandleSequenceBullish(candles: any[]): boolean {
    if (!Array.isArray(candles) || candles.length < 2) return false;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const lastClose = Number(last.close ?? last.c ?? 0);
    const lastOpen = Number(last.open ?? last.o ?? 0);
    const prevClose = Number(prev.close ?? prev.c ?? 0);
    return lastClose > lastOpen && lastClose > prevClose;
}
