import type { MarketRegime } from "../../strategy/market-regime-detector";
import { engineMirrorStopPrice, engineMirrorTpPrice, regimeForSl } from "../../engine/position-ops-monitor";

/** Policy-clamped SL used by buildV2PreEntryRiskPlanCommitted and profitability gate (shared). */
export function resolvePreEntryPolicySlPrice(input: Readonly<{
    side: "long" | "short";
    regime: string;
    entryPrice: number;
    rawStructuralSl: number;
}>): number {
    const regime = regimeForSl(input.regime);
    const policySl = engineMirrorStopPrice(input.entryPrice, input.side, regime);
    if (policySl == null) return input.rawStructuralSl;
    if (input.side === "long" && input.rawStructuralSl > policySl) return policySl;
    if (input.side === "short" && input.rawStructuralSl < policySl) return policySl;
    return input.rawStructuralSl;
}
import {
    computeAdaptiveRangePreEntryProtection,
    shouldApplyAdaptiveRangePreEntryProtection,
    RANGE_MIN_PROFIT_ATR_MULT,
    RANGE_MIN_PROFIT_ENTRY_PCT,
    RANGE_ADAPTIVE_TP_ATR_CAP_MULT,
    type AdaptiveRangeProtectionDiagnostics
} from "./adaptive-range-pre-entry-protection";
import { normalizePxToTickSz } from "./entry-order-type";
import {
    resolveInstrumentTickSzAuthority,
    type InstrumentTickSzAuthorityInput
} from "./instrument-tick-authority";
import { evaluateTpProfitabilityAuthority } from "./tp-profitability-authority";

export type V2PreEntryTpSource =
    | "authority_tp_price"
    | "engine_calculated"
    | "engine_mirror_tp_price"
    | "adaptive_range_atr_cap"
    | "adaptive_range_box_target"
    | "adaptive_range_min_profit"
    | "none";

export type ResolveV2PreEntryTp1AuthorityInput = Readonly<{
    side: "long" | "short";
    regime: string;
    entryPrice: number;
    rawStructuralSl: number;
    rawPolicySlPrice: number;
    decisionTakeProfit?: number | null;
    authorityTakeProfit1Px?: number | null;
    execMetaTakeProfitPlanTp1?: number | null;
    execMetaTakeProfit1Px?: number | null;
    marketSubtype?: string | null;
    routingEngine?: string | null;
    rangeBoxHighAtEntry?: number | null;
    rangeBoxLowAtEntry?: number | null;
    rangeBoxMidAtEntry?: number | null;
    atr?: number | null;
    boxHigh?: number | null;
    boxLow?: number | null;
    boxMid?: number | null;
    feeRate?: number | null;
    preserveCanonicalStructuralStop?: boolean;
    confirmedBreakout?: boolean;
    strongContinuation?: boolean;
    adaptiveContextPresent?: boolean;
    promotionReason?: string | null;
    symbol?: string | null;
    paperSlippageEstimateBps?: number | null;
    snapshotTickSz?: number | null;
    instrumentTickSz?: number | null;
}>;

export type ResolveV2PreEntryTp1AuthorityResult = Readonly<
    | {
          ok: true;
          rawTp1Price: number;
          tpSource: V2PreEntryTpSource;
          adaptiveApplied: boolean;
          adaptiveDiagnostics: AdaptiveRangeProtectionDiagnostics | null;
          adaptiveSlPrice: number | null;
          adaptiveSlSource: string | null;
      }
    | {
          ok: false;
          blockReason: string;
          adaptiveDiagnostics: AdaptiveRangeProtectionDiagnostics | null;
      }
>;

function isValidDirectionTp(side: "long" | "short", entry: number, tp: number): boolean {
    return side === "long" ? tp > entry : tp < entry;
}

function readExplicitAuthorityTp(input: ResolveV2PreEntryTp1AuthorityInput): number | null {
    const candidates = [
        input.decisionTakeProfit,
        input.authorityTakeProfit1Px,
        input.execMetaTakeProfitPlanTp1,
        input.execMetaTakeProfit1Px
    ];
    for (const price of candidates) {
        if (typeof price === "number" && Number.isFinite(price) && price !== 0 && isValidDirectionTp(input.side, input.entryPrice, price)) {
            return price;
        }
    }
    return null;
}

function mapAdaptiveTpSource(source: string): V2PreEntryTpSource {
    if (source === "adaptive_range_atr_cap" || source === "adaptive_range_box_target" || source === "adaptive_range_min_profit") {
        return source;
    }
    if (source === "adaptive_range_box_mid" || source === "adaptive_range_atr_min_profit_floor") {
        return source === "adaptive_range_box_mid" ? "adaptive_range_box_target" : "adaptive_range_min_profit";
    }
    return "adaptive_range_atr_cap";
}

function isFinitePositive(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isValidTpAgainstStructuralSl(
    side: "long" | "short",
    entry: number,
    tp: number,
    structuralSl: number
): boolean {
    if (!isFinitePositive(structuralSl)) return true;
    if (side === "long") return structuralSl < entry && entry < tp;
    return tp < entry && entry < structuralSl;
}

/** Shock-reaction / FTS promoted RANGE entries — escalate through allowed TP authorities before blocking. */
export function isShockOrFtsPromotedTpEscalationContext(input: Readonly<{
    marketSubtype?: string | null;
    promotionReason?: string | null;
}>): boolean {
    const subtype = String(input.marketSubtype ?? "").trim();
    if (subtype === "FAST_TREND_SHIFT") return true;
    if (subtype === "WHIPSAW_SOFT_WATCH") return true;
    if (subtype.startsWith("SHOCK_REACTION")) return true;
    const promotion = String(input.promotionReason ?? "");
    return promotion.includes("SHOCK_REACTION");
}

export type PromotedRangeTp1Candidate = Readonly<{
    price: number;
    source: V2PreEntryTpSource;
}>;

/**
 * Allowed structural / ATR / box TP1 authorities for shock/FTS RANGE setups (preference order).
 * Does not invent targets beyond range-executor + adaptive-range semantics.
 */
export function enumeratePromotedRangeTp1Candidates(input: Readonly<{
    side: "long" | "short";
    entryPrice: number;
    rawStructuralSl: number;
    atr: number;
    boxHigh: number;
    boxLow: number;
    boxMid?: number | null;
    primaryTp?: number | null;
}>): PromotedRangeTp1Candidate[] {
    const side = input.side;
    const entry = input.entryPrice;
    const atr = input.atr;
    const boxHigh = input.boxHigh;
    const boxLow = input.boxLow;
    if (!(entry > 0) || !(boxHigh > boxLow) || !isFinitePositive(atr)) return [];

    const boxMid = isFinitePositive(input.boxMid) ? input.boxMid : (boxHigh + boxLow) / 2;
    const minProfitDistance = Math.max(atr * RANGE_MIN_PROFIT_ATR_MULT, entry * RANGE_MIN_PROFIT_ENTRY_PCT);
    const maxTpDistance = atr * RANGE_ADAPTIVE_TP_ATR_CAP_MULT;
    const structuralSl = input.rawStructuralSl;

    const rawCandidates: PromotedRangeTp1Candidate[] = [];

    if (
        input.primaryTp != null &&
        isFinitePositive(input.primaryTp) &&
        isValidDirectionTp(side, entry, input.primaryTp)
    ) {
        rawCandidates.push({ price: input.primaryTp, source: "authority_tp_price" });
    }

    const boxDist = side === "long" ? Math.max(boxMid - entry, 0) : Math.max(entry - boxMid, 0);
    const structuralDist = Math.max(boxDist, minProfitDistance);
    const structuralTp = side === "long" ? entry + structuralDist : entry - structuralDist;
    rawCandidates.push({ price: structuralTp, source: "adaptive_range_box_target" });

    const atrCapTp = side === "long" ? entry + maxTpDistance : entry - maxTpDistance;
    rawCandidates.push({ price: atrCapTp, source: "adaptive_range_atr_cap" });

    const boxEdgeTp = side === "long" ? boxHigh : boxLow;
    if (isValidDirectionTp(side, entry, boxEdgeTp)) {
        rawCandidates.push({ price: boxEdgeTp, source: "adaptive_range_box_target" });
    }

    const engineMirror = engineMirrorTpPrice(entry, side, "RANGE");
    if (engineMirror != null && isValidDirectionTp(side, entry, engineMirror)) {
        rawCandidates.push({ price: engineMirror, source: "engine_calculated" });
    }

    const seen = new Set<string>();
    const ordered: PromotedRangeTp1Candidate[] = [];
    for (const candidate of rawCandidates) {
        if (!isValidDirectionTp(side, entry, candidate.price)) continue;
        if (!isValidTpAgainstStructuralSl(side, entry, candidate.price, structuralSl)) continue;
        const key = candidate.price.toFixed(8);
        if (seen.has(key)) continue;
        seen.add(key);
        ordered.push(candidate);
    }
    return ordered;
}

function resolveShockFtsPromotedExecutableTpBundle(
    input: V2PreEntryExecutableTpBundleInput,
    tickAuthority: { tickSz: number; source: "instrument_cache.tickSz" | "snapshot.tickSz" }
): V2PreEntryExecutableTpBundleResult {
    const side = input.side;
    const entryPrice = input.entryPrice;
    const atr =
        input.atr != null && Number.isFinite(input.atr) && input.atr > 0 ? input.atr : null;
    const boxHigh =
        input.rangeBoxHighAtEntry ??
        (input.boxHigh != null && Number.isFinite(input.boxHigh) ? input.boxHigh : null);
    const boxLow =
        input.rangeBoxLowAtEntry ??
        (input.boxLow != null && Number.isFinite(input.boxLow) ? input.boxLow : null);

    if (atr == null || boxHigh == null || boxLow == null) {
        return {
            ok: false,
            blockReason: "range_tp_missing",
            adaptiveDiagnostics: null
        };
    }

    const primaryAuthority = resolveV2PreEntryTp1Authority(input);
    const primaryTp =
        primaryAuthority.ok
            ? primaryAuthority.rawTp1Price
            : readExplicitAuthorityTp(input);

    const candidates = enumeratePromotedRangeTp1Candidates({
        side,
        entryPrice,
        rawStructuralSl: input.rawStructuralSl,
        atr,
        boxHigh,
        boxLow,
        boxMid: input.rangeBoxMidAtEntry ?? input.boxMid ?? null,
        primaryTp
    });

    if (candidates.length === 0) {
        return {
            ok: false,
            blockReason: "range_tp_missing",
            adaptiveDiagnostics: primaryAuthority.ok ? primaryAuthority.adaptiveDiagnostics : null
        };
    }

    const feeRate = input.feeRate ?? null;
    const slippageBps =
        typeof (input as { paperSlippageEstimateBps?: number }).paperSlippageEstimateBps === "number"
            ? (input as { paperSlippageEstimateBps?: number }).paperSlippageEstimateBps
            : undefined;

    for (const candidate of candidates) {
        const executableTp1Price = normalizePxToTickSz(candidate.price, tickAuthority.tickSz);
        if (!(executableTp1Price > 0)) continue;

        const profitability = evaluateTpProfitabilityAuthority({
            symbol: String((input as { symbol?: string }).symbol ?? ""),
            side,
            regime: String(input.regime),
            entryPrice,
            canonicalTp1Price: candidate.price,
            canonicalTp1Source: candidate.source,
            feeRate,
            paperSlippageEstimateBps: slippageBps,
            tickSz: tickAuthority.tickSz
        });

        if (!profitability.entryAllowed) continue;

        const canonicalTp1Source =
            candidate.source === "authority_tp_price"
                ? input.execMetaTakeProfitPlanTp1 != null
                    ? "execMeta.takeProfitPlan.tp1"
                    : input.execMetaTakeProfit1Px != null
                      ? "execMeta.takeProfit1Px"
                      : input.authorityTakeProfit1Px != null
                        ? "authority.takeProfit1Px"
                        : "decision.takeProfit"
                : candidate.source;

        return {
            ok: true,
            rawCanonicalTp1Price: candidate.price,
            executableTp1Price: profitability.executableTp1Price ?? executableTp1Price,
            tpTickSize: tickAuthority.tickSz,
            tickSzSource: tickAuthority.source,
            canonicalTp1Source,
            tpSource: candidate.source,
            adaptiveApplied: candidate.source.startsWith("adaptive_range"),
            adaptiveDiagnostics: primaryAuthority.ok && primaryAuthority.adaptiveDiagnostics
                ? {
                      ...primaryAuthority.adaptiveDiagnostics,
                      final_committed_tp_price: candidate.price
                  }
                : null
        };
    }

    return {
        ok: false,
        blockReason: "V2_TP1_NET_EDGE_INSUFFICIENT",
        adaptiveDiagnostics: primaryAuthority.ok ? primaryAuthority.adaptiveDiagnostics : null
    };
}

/**
 * Single canonical TP1 authority shared by profitability gate and buildV2PreEntryRiskPlanCommitted.
 */
export function resolveV2PreEntryTp1Authority(
    input: ResolveV2PreEntryTp1AuthorityInput
): ResolveV2PreEntryTp1AuthorityResult {
    const side = input.side;
    const entryPrice = input.entryPrice;
    const regime = regimeForSl(input.regime);

    if (regime === "TREND") {
        const authTp = readExplicitAuthorityTp(input);
        if (authTp != null) {
            return {
                ok: true,
                rawTp1Price: authTp,
                tpSource: "authority_tp_price",
                adaptiveApplied: false,
                adaptiveDiagnostics: null,
                adaptiveSlPrice: null,
                adaptiveSlSource: null
            };
        }
        return { ok: false, blockReason: "V2_TREND_TP_PRICE_UNAVAILABLE", adaptiveDiagnostics: null };
    }

    if (regime !== "RANGE") {
        return { ok: false, blockReason: "range_tp_missing", adaptiveDiagnostics: null };
    }

    let finalTpPrice: number | null = null;
    let finalTpSource: V2PreEntryTpSource = "none";

    const authTp = readExplicitAuthorityTp(input);
    if (authTp != null) {
        finalTpPrice = authTp;
        finalTpSource = "authority_tp_price";
    }

    if (finalTpPrice == null) {
        const policyTp = engineMirrorTpPrice(entryPrice, side, regime);
        if (policyTp != null && isValidDirectionTp(side, entryPrice, policyTp)) {
            finalTpPrice = policyTp;
            finalTpSource = "engine_calculated";
        }
    }

    if (finalTpPrice == null) {
        return { ok: false, blockReason: "range_tp_missing", adaptiveDiagnostics: null };
    }

    const rawPolicyTpPrice = finalTpPrice;
    const adaptiveEligible =
        input.adaptiveContextPresent !== false &&
        shouldApplyAdaptiveRangePreEntryProtection({
            regime: "RANGE",
            routingEngine: input.routingEngine ?? null,
            marketSubtype: input.marketSubtype ?? null,
            confirmedBreakout: input.confirmedBreakout === true,
            strongContinuation: input.strongContinuation === true
        });
    const adaptiveAtr =
        input.atr != null && Number.isFinite(input.atr) && input.atr > 0 ? input.atr : null;
    const adaptiveBoxHigh =
        input.rangeBoxHighAtEntry ??
        (input.boxHigh != null && Number.isFinite(input.boxHigh) ? input.boxHigh : null);
    const adaptiveBoxLow =
        input.rangeBoxLowAtEntry ??
        (input.boxLow != null && Number.isFinite(input.boxLow) ? input.boxLow : null);

    if (adaptiveEligible && adaptiveAtr != null && adaptiveBoxHigh != null && adaptiveBoxLow != null) {
        const adaptive = computeAdaptiveRangePreEntryProtection({
            side,
            entryPx: entryPrice,
            rawStructuralSl: input.rawStructuralSl,
            rawPolicySl: input.rawPolicySlPrice,
            rawPolicyTp: rawPolicyTpPrice,
            atr: adaptiveAtr,
            boxHigh: adaptiveBoxHigh,
            boxLow: adaptiveBoxLow,
            boxMid: input.rangeBoxMidAtEntry ?? input.boxMid ?? null,
            feeRate: input.feeRate ?? undefined,
            preserveCanonicalStructuralStop: input.preserveCanonicalStructuralStop === true
        });
        if (!adaptive.ok) {
            return {
                ok: false,
                blockReason: adaptive.blockReason,
                adaptiveDiagnostics: adaptive.diagnostics
            };
        }

        const isEscalationContext = isShockOrFtsPromotedTpEscalationContext(input);

        // In shock / FTS promoted escalation context:
        // 1. If explicit profitability-approved authority TP was provided (e.g. from upstream bundle),
        //    preserve it rather than collapsing inward to adaptive 2ATR cap.
        // 2. Otherwise evaluate candidates against profitability authority to pick first profitable canonical target.
        if (isEscalationContext) {
            if (authTp != null && isValidDirectionTp(side, entryPrice, authTp)) {
                finalTpPrice = authTp;
                finalTpSource = "authority_tp_price";
                return {
                    ok: true,
                    rawTp1Price: finalTpPrice,
                    tpSource: finalTpSource,
                    adaptiveApplied: true,
                    adaptiveDiagnostics: {
                        ...adaptive.diagnostics,
                        final_committed_tp_price: finalTpPrice,
                        final_committed_sl_price: adaptive.slPrice
                    },
                    adaptiveSlPrice: adaptive.slPrice,
                    adaptiveSlSource: adaptive.slSource
                };
            }

            const tickSzAuth = resolveInstrumentTickSzAuthority(input as InstrumentTickSzAuthorityInput);
            const tickSz = tickSzAuth.ok ? tickSzAuth.tickSz : 0.01;
            const candidates = enumeratePromotedRangeTp1Candidates({
                side,
                entryPrice,
                rawStructuralSl: input.rawStructuralSl,
                atr: adaptiveAtr,
                boxHigh: adaptiveBoxHigh,
                boxLow: adaptiveBoxLow,
                boxMid: input.rangeBoxMidAtEntry ?? input.boxMid ?? null,
                primaryTp: adaptive.tpPrice
            });

            for (const candidate of candidates) {
                const execPrice = normalizePxToTickSz(candidate.price, tickSz);
                if (!(execPrice > 0)) continue;

                const prof = evaluateTpProfitabilityAuthority({
                    symbol: String((input as { symbol?: string }).symbol ?? ""),
                    side,
                    regime: "RANGE",
                    entryPrice,
                    canonicalTp1Price: candidate.price,
                    canonicalTp1Source: candidate.source,
                    feeRate: input.feeRate ?? 0.0005,
                    paperSlippageEstimateBps:
                        typeof (input as { paperSlippageEstimateBps?: number }).paperSlippageEstimateBps === "number"
                            ? (input as { paperSlippageEstimateBps?: number }).paperSlippageEstimateBps
                            : undefined,
                    tickSz
                });

                if (prof.entryAllowed) {
                    finalTpPrice = candidate.price;
                    finalTpSource = candidate.source;
                    return {
                        ok: true,
                        rawTp1Price: finalTpPrice,
                        tpSource: finalTpSource,
                        adaptiveApplied: candidate.source.startsWith("adaptive_range"),
                        adaptiveDiagnostics: {
                            ...adaptive.diagnostics,
                            final_committed_tp_price: finalTpPrice,
                            final_committed_sl_price: adaptive.slPrice
                        },
                        adaptiveSlPrice: adaptive.slPrice,
                        adaptiveSlSource: adaptive.slSource
                    };
                }
            }

            return {
                ok: false,
                blockReason: "V2_TP1_NET_EDGE_INSUFFICIENT",
                adaptiveDiagnostics: adaptive.diagnostics
            };
        }

        finalTpPrice = adaptive.tpPrice;
        finalTpSource = mapAdaptiveTpSource(adaptive.tpSource);
        return {
            ok: true,
            rawTp1Price: finalTpPrice,
            tpSource: finalTpSource,
            adaptiveApplied: true,
            adaptiveDiagnostics: {
                ...adaptive.diagnostics,
                final_committed_tp_price: adaptive.tpPrice,
                final_committed_sl_price: adaptive.slPrice
            },
            adaptiveSlPrice: adaptive.slPrice,
            adaptiveSlSource: adaptive.slSource
        };
    }

    return {
        ok: true,
        rawTp1Price: finalTpPrice,
        tpSource: finalTpSource,
        adaptiveApplied: false,
        adaptiveDiagnostics: null,
        adaptiveSlPrice: null,
        adaptiveSlSource: null
    };
}

export type V2PreEntryExecutableTpBundleInput = ResolveV2PreEntryTp1AuthorityInput &
    InstrumentTickSzAuthorityInput & {
        entryReferencePrice?: number;
        symbol?: string;
        paperSlippageEstimateBps?: number | null;
    };

export type V2PreEntryExecutableTpBundleResult = Readonly<
    | {
          ok: true;
          rawCanonicalTp1Price: number;
          executableTp1Price: number;
          tpTickSize: number;
          tickSzSource: "instrument_cache.tickSz" | "snapshot.tickSz";
          canonicalTp1Source: string;
          tpSource: V2PreEntryTpSource;
          adaptiveApplied: boolean;
          adaptiveDiagnostics: AdaptiveRangeProtectionDiagnostics | null;
      }
    | {
          ok: false;
          blockReason: string;
          adaptiveDiagnostics: AdaptiveRangeProtectionDiagnostics | null;
      }
>;

/** Raw + tick-normalized TP bundle for profitability gate and downstream submit parity proofs. */
export function resolveV2PreEntryExecutableTpBundle(
    input: V2PreEntryExecutableTpBundleInput
): V2PreEntryExecutableTpBundleResult {
    const tickAuthority = resolveInstrumentTickSzAuthority(input);
    if (!tickAuthority.ok) {
        return {
            ok: false,
            blockReason: tickAuthority.blockReason,
            adaptiveDiagnostics: null
        };
    }

    if (
        isShockOrFtsPromotedTpEscalationContext(input) &&
        regimeForSl(input.regime) === "RANGE"
    ) {
        return resolveShockFtsPromotedExecutableTpBundle(input, tickAuthority);
    }

    const tpAuthority = resolveV2PreEntryTp1Authority(input);
    if (!tpAuthority.ok) {
        return {
            ok: false,
            blockReason: tpAuthority.blockReason,
            adaptiveDiagnostics: tpAuthority.adaptiveDiagnostics
        };
    }

    const executableTp1Price = normalizePxToTickSz(tpAuthority.rawTp1Price, tickAuthority.tickSz);
    if (!(executableTp1Price > 0)) {
        return {
            ok: false,
            blockReason: "PRE_ENTRY_TP_TICK_ROUND_INVALID",
            adaptiveDiagnostics: tpAuthority.adaptiveDiagnostics
        };
    }

    const canonicalTp1Source =
        tpAuthority.tpSource === "authority_tp_price"
            ? input.execMetaTakeProfitPlanTp1 != null
                ? "execMeta.takeProfitPlan.tp1"
                : input.execMetaTakeProfit1Px != null
                  ? "execMeta.takeProfit1Px"
                  : input.authorityTakeProfit1Px != null
                    ? "authority.takeProfit1Px"
                    : "decision.takeProfit"
            : tpAuthority.tpSource;

    return {
        ok: true,
        rawCanonicalTp1Price: tpAuthority.rawTp1Price,
        executableTp1Price,
        tpTickSize: tickAuthority.tickSz,
        tickSzSource: tickAuthority.source,
        canonicalTp1Source,
        tpSource: tpAuthority.tpSource,
        adaptiveApplied: tpAuthority.adaptiveApplied,
        adaptiveDiagnostics: tpAuthority.adaptiveDiagnostics
    };
}

/** @deprecated Use resolveV2PreEntryExecutableTpBundle / resolveV2PreEntryTp1Authority */
export function resolveCanonicalPreEntryTp1ForProfitability(
    input: ResolveV2PreEntryTp1AuthorityInput & { stopPrice?: number | null; symbol?: string }
) {
    const result = resolveV2PreEntryTp1Authority({
        ...input,
        rawStructuralSl: input.rawStructuralSl ?? input.stopPrice ?? 0,
        rawPolicySlPrice: input.rawPolicySlPrice ?? input.stopPrice ?? 0
    });
    if (!result.ok) {
        return { canonicalTp1Price: null, canonicalTp1Source: "none" as const };
    }
    return {
        canonicalTp1Price: result.rawTp1Price,
        canonicalTp1Source: result.tpSource
    };
}

/** @deprecated Use resolveInstrumentTickSzAuthority */
export function resolveInstrumentTickSz(_symbol: string, snapshotTickSz?: number | null): number | null {
    const resolved = resolveInstrumentTickSzAuthority({ snapshotTickSz });
    return resolved.ok ? resolved.tickSz : null;
}

export function canonicalTpSourceToCommittedSource(source: V2PreEntryTpSource): string {
    if (source === "engine_calculated") return "engine_calculated";
    if (source.startsWith("adaptive_range")) return source;
    return source;
}
