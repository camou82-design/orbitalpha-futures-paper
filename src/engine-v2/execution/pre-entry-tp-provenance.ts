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
    type AdaptiveRangeProtectionDiagnostics
} from "./adaptive-range-pre-entry-protection";
import { normalizePxToTickSz } from "./entry-order-type";
import {
    resolveInstrumentTickSzAuthority,
    type InstrumentTickSzAuthorityInput
} from "./instrument-tick-authority";

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
    return "adaptive_range_atr_cap";
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
    const tpAuthority = resolveV2PreEntryTp1Authority(input);
    if (!tpAuthority.ok) {
        return {
            ok: false,
            blockReason: tpAuthority.blockReason,
            adaptiveDiagnostics: tpAuthority.adaptiveDiagnostics
        };
    }

    const tickAuthority = resolveInstrumentTickSzAuthority(input);
    if (!tickAuthority.ok) {
        return {
            ok: false,
            blockReason: tickAuthority.blockReason,
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
