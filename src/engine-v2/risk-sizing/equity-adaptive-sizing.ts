import type { OkxSwapInstrumentSizing } from "../okx-swap-sizing";
import { normalizeOkxSwapContractsFromNotional } from "../okx-swap-sizing";

export const RISK_PER_TRADE_PCT = 0.010;
export const MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE = 2.3;
export const MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE = 2.75;
export const MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE = 3.0;
export const MAX_ADVERSE_ADDON_EQUITY_MULTIPLE = 0.25;
export const MARGIN_RESERVE_RATIO_DEFAULT = 0.2;
export const RISK_BUDGET_TOLERANCE_MULTIPLIER = 1.2;
export const ROUND_TRIP_FEE_RATE_DEFAULT = 0.001;

export type EquitySizingOrderKind = "ENTRY" | "PYRAMIDING_ADDON" | "ADVERSE_ADDON";

export type EvaluateEquitySizingAuthorityInput = Readonly<{
    symbol: string;
    accountEquityUsdt: number | null;
    availableBalanceUsdt: number | null;
    liveBalanceReady: boolean;
    okxAuthReady: boolean;
    equityFresh: boolean;
    equitySource?: string | null;
    equityAgeMs?: number | null;
}>;

export type EvaluateEquityAdaptiveSizingInput = Readonly<{
    symbol: string;
    side: "long" | "short";
    orderKind: EquitySizingOrderKind;
    accountEquityUsdt: number;
    availableBalanceUsdt: number;
    entryReferencePrice: number;
    effectiveStopPrice: number | null;
    appliedLeverage: number;
    entryQualityGrade?: "S" | "A" | "B" | string | null;
    existingSymbolNotionalUsdt: number;
    existingAccountNotionalUsdt: number;
    policyRequestedNotionalUsdt?: number | null;
    adverseRiskBudgetAllowedNotional?: number | null;
    emergencyAbsoluteCapUsdt?: number | null;
    legacyStaticCapUsdt?: number | null;
    marginReserveRatio?: number;
    roundTripFeeRate?: number;
    lastPrice: number;
    instrumentSizing?: OkxSwapInstrumentSizing | null;
    /** HTF PROBE_ONLY sizing cap — applied once to pre-lot notional for ENTRY orders. */
    htfSizeMultiplier?: number;
    /**
     * External market context sizing multiplier (confidence/sizing auxiliary only).
     * Applied after probe + HTF multipliers. Must be > 0; never blocks entry by itself.
     */
    externalSizeMultiplier?: number;
    /** V2 risk-authoritative entries skip legacy 40 USDT and daily emergency ceiling. */
    v2AuthorityEntry?: boolean;
    /**
     * When true, OKX_LIVE_EMERGENCY_MAX_ORDER_NOTIONAL_USDT binds sizing/submit (failsafe only).
     * Normal V2 risk-authoritative entries must leave this false.
     */
    emergencyFailsafeActive?: boolean;
    /**
     * ENTRY probe size multiplier. Applied after equity/symbol/account/emergency caps,
     * before HTF multiplier and OKX lot normalization.
     * - null / undefined       → treated as 1 (no probe reduction)
     * - >= 1                   → treated as 1 (no probe reduction)
     * - 0 < multiplier < 1     → applied as probe fraction of full equity-authoritative notional
     * - multiplier <= 0        → strictly BLOCKED with PROBE_MULTIPLIER_INVALID_ZERO_OR_NEGATIVE (fail-closed, never promoted to full)
     * - ADDON orders: this field is ignored (ADDON path uses policyRequestedNotionalUsdt)
     */
    entryProbeSizeMultiplier?: number | null;
    /** Source label for probe multiplier attribution (e.g. V2_POLARITY_REVERSAL_MICRO_PROBE, CONTINUATION_MICRO_PROBE, DEFAULT_MICRO_PROBE, NONE). */
    entryProbeSizingSource?: string | null;
}>;

export type EquityAdaptiveSizingResult = Readonly<{
    sizingPassed: boolean;
    blockReason: string | null;
    equityInitialCapUsdt: number;
    symbolCapUsdt: number;
    accountCapUsdt: number;
    maxAdverseAddonUsdt: number;
    riskPct: number;
    qualityMultiplier: number;
    riskBudgetUsdt: number;
    stopDistancePct: number;
    estimatedRoundTripFeeUsdt: number;
    netRiskBudgetUsdt: number;
    riskBasedNotionalUsdt: number;
    /** Full equity-authoritative notional before probe multiplier is applied (ENTRY only). */
    cappedFullEntryNotionalUsdt: number;
    /** Probe multiplier applied (1 if no probe reduction). */
    probeMultiplierApplied: number;
    /** Source label for the probe multiplier decision. */
    probeSizingSource: string;
    /** preLotNotionalUsdt after probe multiplier but before HTF multiplier. */
    probeAdjustedPreLotNotionalUsdt: number;
    preLotNotionalUsdt: number;
    finalOrderNotionalUsdt: number;
    finalRequiredMarginUsdt: number;
    normalizedContracts: number | null;
    normalizedNotionalUsdt: number | null;
    actualRiskAtStopUsdt: number | null;
    actualRiskPct: number | null;
    usableAvailableBalanceUsdt: number;
    marginCapacityPassed: boolean;
    /** Raw OKX_LIVE_EMERGENCY_MAX_ORDER_NOTIONAL_USDT when set. */
    emergencyCapUsdt: number | null;
    /** Raw OKX_LIVE_MAX_ORDER_NOTIONAL_USDT when set. */
    legacyStaticCapUsdt: number | null;
    /** min(emergency, legacy) binding cap for non-V2 live paths; null for normal V2 authority. */
    effectiveLiveCapUsdt: number | null;
    /** Cap applied inside evaluateEquityAdaptiveSizing pre-lot min(); null for normal V2 authority. */
    ultimateSafetyCapUsdt: number | null;
    legacyCapSource: string | null;
    /** usableAvailableBalanceUsdt × appliedLeverage — margin-derived notional ceiling. */
    availableBalanceCapUsdt: number;
    /** Pre-probe notional after equity/symbol/account/failsafe caps (before probe multiplier). */
    preProbeNotionalUsdt: number;
    /** Which authority bound pre-probe notional. */
    limitingAuthority: string;
    /** Final sizing authority label after probe/HTF/lot normalization. */
    finalSizingAuthority: string;
    /** True only when emergency failsafe cap actually bound sizing. */
    emergencyCapApplied: boolean;
    emergencyCapReason: string | null;
    htfSizeMultiplierApplied: number;
    externalSizeMultiplierApplied: number;
    /** Always false — legacy absolute probe cap (baseSizeUsd×multiplier) never used in V2 ENTRY. */
    legacyAbsoluteProbeCapApplied: boolean;
    v2AuthorityEntryApplied?: boolean;
}>;

export type LiveOrderNotionalCapResolution = Readonly<{
    cap: number | null;
    emergencyCapUsdt: number | null;
    legacyStaticCapUsdt: number | null;
    effectiveLiveCapUsdt: number | null;
    legacyCapSource: string | null;
}>;

function positiveCapUsdt(value: number | null | undefined): number | null {
    if (value == null || !Number.isFinite(value) || value <= 0) return null;
    return value;
}

/** Binding live order notional cap: min(emergency, legacy) when both set. */
export function resolveEffectiveLiveOrderNotionalCap(input: Readonly<{
    emergencyCapUsdt?: number | null;
    legacyStaticCapUsdt?: number | null;
}>): LiveOrderNotionalCapResolution {
    const emergencyCapUsdt = positiveCapUsdt(input.emergencyCapUsdt);
    const legacyStaticCapUsdt = positiveCapUsdt(input.legacyStaticCapUsdt);
    let effectiveLiveCapUsdt: number | null = null;
    let legacyCapSource: string | null = null;

    if (emergencyCapUsdt != null && legacyStaticCapUsdt != null) {
        effectiveLiveCapUsdt = Math.min(emergencyCapUsdt, legacyStaticCapUsdt);
        if (effectiveLiveCapUsdt === legacyStaticCapUsdt) {
            legacyCapSource = "OKX_LIVE_MAX_ORDER_NOTIONAL_USDT_LEGACY_FAILSAFE";
        }
    } else if (emergencyCapUsdt != null) {
        effectiveLiveCapUsdt = emergencyCapUsdt;
    } else if (legacyStaticCapUsdt != null) {
        effectiveLiveCapUsdt = legacyStaticCapUsdt;
        legacyCapSource = "OKX_LIVE_MAX_ORDER_NOTIONAL_USDT_LEGACY_FAILSAFE";
    }

    return {
        cap: effectiveLiveCapUsdt,
        emergencyCapUsdt,
        legacyStaticCapUsdt,
        effectiveLiveCapUsdt,
        legacyCapSource
    };
}

/**
 * V2 risk-authoritative sizing does not use emergency/legacy static caps as daily ceiling.
 * Legacy OKX_LIVE_MAX_ORDER_NOTIONAL_USDT applies to non-V2 submit paths.
 * Emergency cap binds only when emergencyFailsafeActive is explicitly true.
 */
export function resolveUltimateSafetyCapForOrderSizing(input: Readonly<{
    v2AuthorityEntry?: boolean;
    emergencyFailsafeActive?: boolean;
    emergencyCapUsdt?: number | null;
    legacyStaticCapUsdt?: number | null;
}>): LiveOrderNotionalCapResolution {
    const emergencyCapUsdt = positiveCapUsdt(input.emergencyCapUsdt);
    const legacyStaticCapUsdt = positiveCapUsdt(input.legacyStaticCapUsdt);
    if (input.v2AuthorityEntry === true) {
        const bindingCap =
            input.emergencyFailsafeActive === true ? emergencyCapUsdt : null;
        return {
            cap: bindingCap,
            emergencyCapUsdt,
            legacyStaticCapUsdt,
            effectiveLiveCapUsdt: bindingCap,
            legacyCapSource:
                bindingCap != null && emergencyCapUsdt != null
                    ? "OKX_LIVE_EMERGENCY_MAX_ORDER_NOTIONAL_USDT_FAILSAFE"
                    : null
        };
    }
    return resolveEffectiveLiveOrderNotionalCap({ emergencyCapUsdt, legacyStaticCapUsdt });
}

function resolveBindingLimitingAuthority(
    candidates: ReadonlyArray<{ key: string; value: number }>
): string {
    let minValue = Number.POSITIVE_INFINITY;
    let limitingAuthority = "unknown";
    for (const candidate of candidates) {
        if (!(candidate.value >= 0) || !Number.isFinite(candidate.value)) continue;
        if (candidate.value < minValue - 1e-9) {
            minValue = candidate.value;
            limitingAuthority = candidate.key;
        }
    }
    return limitingAuthority;
}

export function qualityMultiplierFromGrade(grade: string | null | undefined): number | null {
    const g = String(grade ?? "").trim().toUpperCase();
    if (g === "S" || g === "A") return 1.0;
    if (g === "B") return 0.8;
    return null;
}

export function resolveEmergencyAbsoluteCap(input: Readonly<{
    emergencyCapUsdt?: number | null;
    legacyStaticCapUsdt?: number | null;
}>): LiveOrderNotionalCapResolution {
    return resolveEffectiveLiveOrderNotionalCap(input);
}

export function evaluateEquitySizingAuthority(
    input: EvaluateEquitySizingAuthorityInput
): Readonly<{
    sizingAuthorityReady: boolean;
    blockReason: string | null;
}> {
    if (!input.okxAuthReady) {
        return { sizingAuthorityReady: false, blockReason: "OKX_AUTH_NOT_READY" };
    }
    if (!input.liveBalanceReady) {
        return { sizingAuthorityReady: false, blockReason: "LIVE_BALANCE_NOT_READY" };
    }
    if (input.equityFresh !== true) {
        return { sizingAuthorityReady: false, blockReason: "EQUITY_STALE" };
    }
    if (!(input.accountEquityUsdt != null && input.accountEquityUsdt > 0)) {
        return { sizingAuthorityReady: false, blockReason: "LIVE_ACCOUNT_EQUITY_NOT_READY" };
    }
    if (!(input.availableBalanceUsdt != null && input.availableBalanceUsdt >= 0)) {
        return { sizingAuthorityReady: false, blockReason: "AVAILABLE_BALANCE_INVALID" };
    }
    if (String(input.equitySource ?? "").trim() !== "" && input.equitySource !== "okx_total_eq") {
        return { sizingAuthorityReady: false, blockReason: "EQUITY_SOURCE_NOT_OKX" };
    }
    return { sizingAuthorityReady: true, blockReason: null };
}

export function buildEquitySizingAuthorityProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_EQUITY_SIZING_AUTHORITY_PROOF", ...input };
}

export function buildRiskBasedNotionalProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_RISK_BASED_NOTIONAL_PROOF", ...input };
}

export function buildMarginCapacityProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_MARGIN_CAPACITY_PROOF", ...input };
}

export function buildEquityAdaptiveSizingProof(input: Record<string, unknown>): Record<string, unknown> {
    return { event: "V2_EQUITY_ADAPTIVE_SIZING_PROOF", ...input };
}

function computeStopDistancePct(entryReferencePrice: number, effectiveStopPrice: number): number | null {
    if (!(entryReferencePrice > 0) || !(effectiveStopPrice > 0)) return null;
    const dist = Math.abs(entryReferencePrice - effectiveStopPrice) / entryReferencePrice;
    return Number.isFinite(dist) && dist > 0 ? dist : null;
}

export function evaluateEquityAdaptiveSizing(
    input: EvaluateEquityAdaptiveSizingInput
): EquityAdaptiveSizingResult {
    const equity = input.accountEquityUsdt;
    const qualityMultiplier =
        input.orderKind === "ENTRY"
            ? qualityMultiplierFromGrade(input.entryQualityGrade)
            : 1.0;
    const equityInitialCapUsdt = equity * MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE;
    const symbolCapUsdt = equity * MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE;
    const accountCapUsdt = equity * MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE;
    const maxAdverseAddonUsdt = equity * MAX_ADVERSE_ADDON_EQUITY_MULTIPLE;
    const marginReserveRatio = input.marginReserveRatio ?? MARGIN_RESERVE_RATIO_DEFAULT;
    const usableAvailableBalanceUsdt = input.availableBalanceUsdt * (1 - marginReserveRatio);
    const availableBalanceCapUsdt =
        usableAvailableBalanceUsdt * Math.max(1, input.appliedLeverage);
    const emergency = resolveUltimateSafetyCapForOrderSizing({
        v2AuthorityEntry: input.v2AuthorityEntry === true,
        emergencyFailsafeActive: input.emergencyFailsafeActive === true,
        emergencyCapUsdt: input.emergencyAbsoluteCapUsdt,
        legacyStaticCapUsdt: input.legacyStaticCapUsdt
    });
    const ultimateSafetyCapUsdt = emergency.effectiveLiveCapUsdt;
    const emergencyCapApplied = ultimateSafetyCapUsdt != null;
    const emergencyCapReason =
        emergencyCapApplied && input.emergencyFailsafeActive === true
            ? emergency.legacyCapSource ?? "OKX_LIVE_EMERGENCY_MAX_ORDER_NOTIONAL_USDT_FAILSAFE"
            : null;

    const baseFail = (
        partial: Partial<EquityAdaptiveSizingResult> & { blockReason: string }
    ): EquityAdaptiveSizingResult => ({
        sizingPassed: false,
        equityInitialCapUsdt,
        symbolCapUsdt,
        accountCapUsdt,
        maxAdverseAddonUsdt,
        riskPct: 0,
        qualityMultiplier: qualityMultiplier ?? 0,
        riskBudgetUsdt: 0,
        stopDistancePct: 0,
        estimatedRoundTripFeeUsdt: 0,
        netRiskBudgetUsdt: 0,
        riskBasedNotionalUsdt: 0,
        cappedFullEntryNotionalUsdt: 0,
        probeMultiplierApplied: 1,
        probeSizingSource: "none",
        probeAdjustedPreLotNotionalUsdt: 0,
        preLotNotionalUsdt: 0,
        finalOrderNotionalUsdt: 0,
        finalRequiredMarginUsdt: 0,
        normalizedContracts: null,
        normalizedNotionalUsdt: null,
        actualRiskAtStopUsdt: null,
        actualRiskPct: null,
        usableAvailableBalanceUsdt,
        marginCapacityPassed: false,
        emergencyCapUsdt: emergency.emergencyCapUsdt,
        legacyStaticCapUsdt: emergency.legacyStaticCapUsdt,
        effectiveLiveCapUsdt: emergency.effectiveLiveCapUsdt,
        legacyCapSource: emergency.legacyCapSource,
        ultimateSafetyCapUsdt,
        availableBalanceCapUsdt,
        preProbeNotionalUsdt: 0,
        limitingAuthority: partial.limitingAuthority ?? "blocked",
        finalSizingAuthority: partial.finalSizingAuthority ?? "blocked",
        emergencyCapApplied,
        emergencyCapReason,
        htfSizeMultiplierApplied: 1,
        externalSizeMultiplierApplied: 1,
        legacyAbsoluteProbeCapApplied: false,
        ...partial
    });

    if (input.orderKind === "ENTRY" && qualityMultiplier == null) {
        return baseFail({ blockReason: "ENTRY_QUALITY_GRADE_BLOCKED" });
    }

    const effectiveStop =
        input.effectiveStopPrice != null && input.effectiveStopPrice > 0
            ? input.effectiveStopPrice
            : null;
    if (effectiveStop == null) {
        return baseFail({ blockReason: "EFFECTIVE_STOP_PRICE_MISSING" });
    }

    const stopDistancePct = computeStopDistancePct(input.entryReferencePrice, effectiveStop);
    if (stopDistancePct == null) {
        return baseFail({ blockReason: "STOP_DISTANCE_INVALID" });
    }

    const riskPct = RISK_PER_TRADE_PCT * (qualityMultiplier ?? 1);
    const riskBudgetUsdt = equity * riskPct;
    const roundTripFeeRate = input.roundTripFeeRate ?? ROUND_TRIP_FEE_RATE_DEFAULT;
    const riskBasedNotionalGross = riskBudgetUsdt / stopDistancePct;
    const estimatedRoundTripFeeUsdt = Math.max(0, riskBasedNotionalGross * roundTripFeeRate);
    const netRiskBudgetUsdt = Math.max(0, riskBudgetUsdt - estimatedRoundTripFeeUsdt);
    const riskBasedNotionalUsdt = netRiskBudgetUsdt / stopDistancePct;

    const remainingSymbolCapacity = Math.max(0, symbolCapUsdt - input.existingSymbolNotionalUsdt);
    const remainingAccountCapacity = Math.max(0, accountCapUsdt - input.existingAccountNotionalUsdt);

    let preLotNotionalUsdt: number;
    let limitingAuthority = "unknown";
    if (input.orderKind === "ENTRY") {
        const policyRequested =
            input.policyRequestedNotionalUsdt ?? Number.POSITIVE_INFINITY;
        const entryCandidates = [
            { key: "risk_based_notional", value: riskBasedNotionalUsdt },
            { key: "equity_initial_cap", value: equityInitialCapUsdt },
            { key: "symbol_capacity", value: remainingSymbolCapacity },
            { key: "account_capacity", value: remainingAccountCapacity },
            ...(Number.isFinite(policyRequested)
                ? [{ key: "policy_requested", value: policyRequested }]
                : []),
            ...(ultimateSafetyCapUsdt != null
                ? [{ key: "emergency_failsafe_cap", value: ultimateSafetyCapUsdt }]
                : [])
        ];
        preLotNotionalUsdt = Math.min(...entryCandidates.map((c) => c.value));
        limitingAuthority = resolveBindingLimitingAuthority(entryCandidates);
    } else if (input.orderKind === "ADVERSE_ADDON") {
        const policyRequested = Math.max(0, input.policyRequestedNotionalUsdt ?? 0);
        const addonCandidates = [
            { key: "policy_requested", value: policyRequested },
            { key: "max_adverse_addon", value: maxAdverseAddonUsdt },
            { key: "symbol_capacity", value: remainingSymbolCapacity },
            { key: "account_capacity", value: remainingAccountCapacity },
            {
                key: "adverse_risk_budget",
                value: input.adverseRiskBudgetAllowedNotional ?? Number.POSITIVE_INFINITY
            },
            ...(ultimateSafetyCapUsdt != null
                ? [{ key: "emergency_failsafe_cap", value: ultimateSafetyCapUsdt }]
                : [])
        ];
        preLotNotionalUsdt = Math.min(...addonCandidates.map((c) => c.value));
        limitingAuthority = resolveBindingLimitingAuthority(addonCandidates);
    } else {
        const policyRequested = Math.max(0, input.policyRequestedNotionalUsdt ?? 0);
        const pyramidCandidates = [
            { key: "policy_requested", value: policyRequested },
            { key: "symbol_capacity", value: remainingSymbolCapacity },
            { key: "account_capacity", value: remainingAccountCapacity },
            ...(ultimateSafetyCapUsdt != null
                ? [{ key: "emergency_failsafe_cap", value: ultimateSafetyCapUsdt }]
                : [])
        ];
        preLotNotionalUsdt = Math.min(...pyramidCandidates.map((c) => c.value));
        limitingAuthority = resolveBindingLimitingAuthority(pyramidCandidates);
    }
    const preProbeNotionalUsdt = preLotNotionalUsdt;

    if (!(preLotNotionalUsdt > 0)) {
        return baseFail({
            blockReason:
                remainingSymbolCapacity <= 0
                    ? "MAX_SYMBOL_NOTIONAL_EXCEEDED"
                    : remainingAccountCapacity <= 0
                      ? "MAX_ACCOUNT_NOTIONAL_EXCEEDED"
                      : "ORDER_BUILD_FAIL",
            riskPct,
            qualityMultiplier: qualityMultiplier ?? 1,
            riskBudgetUsdt,
            stopDistancePct,
            estimatedRoundTripFeeUsdt,
            netRiskBudgetUsdt,
            riskBasedNotionalUsdt,
            preLotNotionalUsdt: 0,
            cappedFullEntryNotionalUsdt: 0,
            probeMultiplierApplied: 1,
            probeSizingSource: "none",
            probeAdjustedPreLotNotionalUsdt: 0,
            legacyAbsoluteProbeCapApplied: false
        });
    }

    // --- Probe multiplier (ENTRY only) ---
    // Applied after equity/symbol/account/emergency caps, before HTF multiplier and lot normalization.
    // null / undefined → 1 (no-op). >= 1 → 1 (no-op).
    // 0 < x < 1 → reduce by fraction.
    // x <= 0 or non-finite when provided → strictly BLOCKED (PROBE_MULTIPLIER_INVALID_ZERO_OR_NEGATIVE)
    // ADDON orders: entryProbeSizeMultiplier is ignored.
    const cappedFullEntryNotionalUsdt = preLotNotionalUsdt;
    let probeMultiplierApplied = 1;
    let probeSizingSource = input.entryProbeSizingSource ?? "NONE";

    if (input.orderKind === "ENTRY" && input.entryProbeSizeMultiplier != null) {
        const mult = input.entryProbeSizeMultiplier;
        if (!Number.isFinite(mult) || mult <= 0) {
            // RELEASE BLOCKER GUARD: multiplier <= 0 MUST NEVER be silently ignored or promoted to full size.
            return baseFail({
                blockReason: "PROBE_MULTIPLIER_INVALID_ZERO_OR_NEGATIVE",
                riskPct,
                qualityMultiplier: qualityMultiplier ?? 1,
                riskBudgetUsdt,
                stopDistancePct,
                estimatedRoundTripFeeUsdt,
                netRiskBudgetUsdt,
                riskBasedNotionalUsdt,
                preLotNotionalUsdt: 0,
                cappedFullEntryNotionalUsdt,
                probeMultiplierApplied: 0,
                probeSizingSource: input.entryProbeSizingSource ?? "INVALID_ZERO_OR_NEGATIVE",
                probeAdjustedPreLotNotionalUsdt: 0,
                legacyAbsoluteProbeCapApplied: false
            });
        } else if (mult < 1) {
            probeMultiplierApplied = mult;
            probeSizingSource = input.entryProbeSizingSource ?? "MICRO_PROBE";
            preLotNotionalUsdt = preLotNotionalUsdt * probeMultiplierApplied;
        } else {
            // mult >= 1: full entry (1.0 no-op)
            probeMultiplierApplied = 1;
            probeSizingSource = input.entryProbeSizingSource ?? "FULL_ENTRY";
        }
    }
    const probeAdjustedPreLotNotionalUsdt = preLotNotionalUsdt;

    if (input.orderKind === "ENTRY" && !(preLotNotionalUsdt > 0)) {
        return baseFail({
            blockReason: "PROBE_MULTIPLIER_ZEROED",
            riskPct,
            qualityMultiplier: qualityMultiplier ?? 1,
            riskBudgetUsdt,
            stopDistancePct,
            estimatedRoundTripFeeUsdt,
            netRiskBudgetUsdt,
            riskBasedNotionalUsdt,
            preLotNotionalUsdt: 0,
            cappedFullEntryNotionalUsdt,
            probeMultiplierApplied,
            probeSizingSource,
            probeAdjustedPreLotNotionalUsdt: 0,
            legacyAbsoluteProbeCapApplied: false
        });
    }

    const htfSizeMultiplierApplied =
        input.orderKind === "ENTRY" &&
        input.htfSizeMultiplier != null &&
        input.htfSizeMultiplier > 0 &&
        input.htfSizeMultiplier < 1
            ? input.htfSizeMultiplier
            : 1;
    if (htfSizeMultiplierApplied < 1) {
        preLotNotionalUsdt = preLotNotionalUsdt * htfSizeMultiplierApplied;
    }

    const externalSizeMultiplierApplied =
        input.orderKind === "ENTRY" &&
        input.externalSizeMultiplier != null &&
        Number.isFinite(input.externalSizeMultiplier) &&
        input.externalSizeMultiplier > 0
            ? input.externalSizeMultiplier
            : 1;
    if (externalSizeMultiplierApplied !== 1) {
        preLotNotionalUsdt = preLotNotionalUsdt * externalSizeMultiplierApplied;
    }

    if (!(preLotNotionalUsdt > 0)) {
        return baseFail({
            blockReason: "HTF_PROBE_SIZE_MULTIPLIER_ZEROED",
            riskPct,
            qualityMultiplier: qualityMultiplier ?? 1,
            riskBudgetUsdt,
            stopDistancePct,
            estimatedRoundTripFeeUsdt,
            netRiskBudgetUsdt,
            riskBasedNotionalUsdt,
            preLotNotionalUsdt: 0,
            cappedFullEntryNotionalUsdt,
            probeMultiplierApplied,
            probeSizingSource,
            probeAdjustedPreLotNotionalUsdt,
            htfSizeMultiplierApplied
        });
    }

    let normalizedContracts: number | null = null;
    let normalizedNotionalUsdt: number | null = preLotNotionalUsdt;
    let actualRiskAtStopUsdt: number | null = null;
    let actualRiskPct: number | null = null;

    if (input.instrumentSizing != null && input.lastPrice > 0) {
        const norm = normalizeOkxSwapContractsFromNotional({
            desiredNotionalUsdt: preLotNotionalUsdt,
            lastPrice: input.lastPrice,
            sizing: input.instrumentSizing
        });
        if (!norm.min_size_ok || norm.normalized_contracts <= 0) {
            return baseFail({
                blockReason: "MIN_LOT_RISK_BUDGET_EXCEEDED",
                riskPct,
                qualityMultiplier: qualityMultiplier ?? 1,
                riskBudgetUsdt,
                stopDistancePct,
                estimatedRoundTripFeeUsdt,
                netRiskBudgetUsdt,
                riskBasedNotionalUsdt,
                preLotNotionalUsdt,
                cappedFullEntryNotionalUsdt,
                probeMultiplierApplied,
                probeSizingSource,
                probeAdjustedPreLotNotionalUsdt,
                normalizedContracts: norm.normalized_contracts,
                normalizedNotionalUsdt: norm.actualNotional
            });
        }
        normalizedContracts = norm.normalized_contracts;
        normalizedNotionalUsdt = norm.actualNotional;
        const normalizedRoundTripFeeUsdt = normalizedNotionalUsdt * roundTripFeeRate;
        actualRiskAtStopUsdt =
            normalizedNotionalUsdt * stopDistancePct + normalizedRoundTripFeeUsdt;
        actualRiskPct = actualRiskAtStopUsdt / equity;
        if (
            input.orderKind === "ENTRY" &&
            actualRiskAtStopUsdt > riskBudgetUsdt * RISK_BUDGET_TOLERANCE_MULTIPLIER
        ) {
            return baseFail({
                blockReason: "MIN_LOT_RISK_BUDGET_EXCEEDED",
                riskPct,
                qualityMultiplier: qualityMultiplier ?? 1,
                riskBudgetUsdt,
                stopDistancePct,
                estimatedRoundTripFeeUsdt,
                netRiskBudgetUsdt,
                riskBasedNotionalUsdt,
                preLotNotionalUsdt,
                cappedFullEntryNotionalUsdt,
                probeMultiplierApplied,
                probeSizingSource,
                probeAdjustedPreLotNotionalUsdt,
                normalizedContracts,
                normalizedNotionalUsdt,
                actualRiskAtStopUsdt,
                actualRiskPct
            });
        }
    }

    const finalOrderNotionalUsdt = normalizedNotionalUsdt ?? preLotNotionalUsdt;
    const finalRequiredMarginUsdt = finalOrderNotionalUsdt / Math.max(1, input.appliedLeverage);
    const marginCapacityPassed = finalRequiredMarginUsdt <= usableAvailableBalanceUsdt + 1e-9;
    let finalSizingAuthority = limitingAuthority;
    if (!marginCapacityPassed) {
        finalSizingAuthority = "available_balance_capacity";
    } else if (normalizedNotionalUsdt != null && Math.abs(normalizedNotionalUsdt - preLotNotionalUsdt) > 1e-6) {
        finalSizingAuthority = "lot_normalization";
    } else if (externalSizeMultiplierApplied !== 1) {
        finalSizingAuthority = "external_size_multiplier";
    } else if (htfSizeMultiplierApplied < 1) {
        finalSizingAuthority = "htf_size_multiplier";
    } else if (probeMultiplierApplied < 1) {
        finalSizingAuthority = "probe_multiplier";
    }

    if (!marginCapacityPassed) {
        return baseFail({
            blockReason: "AVAILABLE_MARGIN_INSUFFICIENT",
            riskPct,
            qualityMultiplier: qualityMultiplier ?? 1,
            riskBudgetUsdt,
            stopDistancePct,
            estimatedRoundTripFeeUsdt,
            netRiskBudgetUsdt,
            riskBasedNotionalUsdt,
            preLotNotionalUsdt,
            preProbeNotionalUsdt,
            cappedFullEntryNotionalUsdt,
            probeMultiplierApplied,
            probeSizingSource,
            probeAdjustedPreLotNotionalUsdt,
            limitingAuthority,
            finalSizingAuthority,
            finalOrderNotionalUsdt,
            finalRequiredMarginUsdt,
            normalizedContracts,
            normalizedNotionalUsdt,
            actualRiskAtStopUsdt,
            actualRiskPct,
            marginCapacityPassed: false,
            htfSizeMultiplierApplied,
            externalSizeMultiplierApplied
        });
    }

    return {
        sizingPassed: true,
        blockReason: null,
        equityInitialCapUsdt,
        symbolCapUsdt,
        accountCapUsdt,
        maxAdverseAddonUsdt,
        riskPct,
        qualityMultiplier: qualityMultiplier ?? 1,
        riskBudgetUsdt,
        stopDistancePct,
        estimatedRoundTripFeeUsdt,
        netRiskBudgetUsdt,
        riskBasedNotionalUsdt,
        cappedFullEntryNotionalUsdt,
        probeMultiplierApplied,
        probeSizingSource,
        probeAdjustedPreLotNotionalUsdt,
        preLotNotionalUsdt,
        finalOrderNotionalUsdt,
        finalRequiredMarginUsdt,
        normalizedContracts,
        normalizedNotionalUsdt,
        actualRiskAtStopUsdt,
        actualRiskPct,
        usableAvailableBalanceUsdt,
        marginCapacityPassed: true,
        emergencyCapUsdt: emergency.emergencyCapUsdt,
        legacyStaticCapUsdt: emergency.legacyStaticCapUsdt,
        effectiveLiveCapUsdt: emergency.effectiveLiveCapUsdt,
        ultimateSafetyCapUsdt,
        legacyCapSource: emergency.legacyCapSource,
        availableBalanceCapUsdt,
        preProbeNotionalUsdt,
        limitingAuthority,
        finalSizingAuthority,
        emergencyCapApplied,
        emergencyCapReason,
        htfSizeMultiplierApplied,
        externalSizeMultiplierApplied,
        legacyAbsoluteProbeCapApplied: false,
        v2AuthorityEntryApplied: input.v2AuthorityEntry === true
    };
}
