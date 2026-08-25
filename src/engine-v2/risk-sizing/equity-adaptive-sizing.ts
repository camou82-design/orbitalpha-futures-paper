import type { OkxSwapInstrumentSizing } from "../okx-swap-sizing";
import { normalizeOkxSwapContractsFromNotional } from "../okx-swap-sizing";

export const RISK_PER_TRADE_PCT = 0.010;
export const MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE = 2.0;
export const MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE = 2.5;
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
    preLotNotionalUsdt: number;
    finalOrderNotionalUsdt: number;
    finalRequiredMarginUsdt: number;
    normalizedContracts: number | null;
    normalizedNotionalUsdt: number | null;
    actualRiskAtStopUsdt: number | null;
    actualRiskPct: number | null;
    usableAvailableBalanceUsdt: number;
    marginCapacityPassed: boolean;
    emergencyCapUsdt: number | null;
    legacyCapSource: string | null;
    htfSizeMultiplierApplied: number;
}>;

export function qualityMultiplierFromGrade(grade: string | null | undefined): number | null {
    const g = String(grade ?? "").trim().toUpperCase();
    if (g === "S" || g === "A") return 1.0;
    if (g === "B") return 0.8;
    return null;
}

export function resolveEmergencyAbsoluteCap(input: Readonly<{
    emergencyCapUsdt?: number | null;
    legacyStaticCapUsdt?: number | null;
}>): Readonly<{ cap: number | null; legacyCapSource: string | null }> {
    if (input.emergencyCapUsdt != null && input.emergencyCapUsdt > 0) {
        return { cap: input.emergencyCapUsdt, legacyCapSource: null };
    }
    if (input.legacyStaticCapUsdt != null && input.legacyStaticCapUsdt > 0) {
        return {
            cap: input.legacyStaticCapUsdt,
            legacyCapSource: "OKX_LIVE_MAX_ORDER_NOTIONAL_USDT_LEGACY_FAILSAFE"
        };
    }
    return { cap: null, legacyCapSource: null };
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
    const emergency = resolveEmergencyAbsoluteCap({
        emergencyCapUsdt: input.emergencyAbsoluteCapUsdt,
        legacyStaticCapUsdt: input.legacyStaticCapUsdt
    });

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
        preLotNotionalUsdt: 0,
        finalOrderNotionalUsdt: 0,
        finalRequiredMarginUsdt: 0,
        normalizedContracts: null,
        normalizedNotionalUsdt: null,
        actualRiskAtStopUsdt: null,
        actualRiskPct: null,
        usableAvailableBalanceUsdt,
        marginCapacityPassed: false,
        emergencyCapUsdt: emergency.cap,
        legacyCapSource: emergency.legacyCapSource,
        htfSizeMultiplierApplied: 1,
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
    if (input.orderKind === "ENTRY") {
        preLotNotionalUsdt = Math.min(
            riskBasedNotionalUsdt,
            equityInitialCapUsdt,
            remainingSymbolCapacity,
            remainingAccountCapacity,
            input.policyRequestedNotionalUsdt ?? Number.POSITIVE_INFINITY,
            emergency.cap ?? Number.POSITIVE_INFINITY
        );
    } else if (input.orderKind === "ADVERSE_ADDON") {
        const policyRequested = Math.max(0, input.policyRequestedNotionalUsdt ?? 0);
        preLotNotionalUsdt = Math.min(
            policyRequested,
            maxAdverseAddonUsdt,
            remainingSymbolCapacity,
            remainingAccountCapacity,
            input.adverseRiskBudgetAllowedNotional ?? Number.POSITIVE_INFINITY,
            emergency.cap ?? Number.POSITIVE_INFINITY
        );
    } else {
        const policyRequested = Math.max(0, input.policyRequestedNotionalUsdt ?? 0);
        preLotNotionalUsdt = Math.min(
            policyRequested,
            remainingSymbolCapacity,
            remainingAccountCapacity,
            emergency.cap ?? Number.POSITIVE_INFINITY
        );
    }

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
            preLotNotionalUsdt: 0
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
            finalOrderNotionalUsdt,
            finalRequiredMarginUsdt,
            normalizedContracts,
            normalizedNotionalUsdt,
            actualRiskAtStopUsdt,
            actualRiskPct,
            marginCapacityPassed: false
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
        preLotNotionalUsdt,
        finalOrderNotionalUsdt,
        finalRequiredMarginUsdt,
        normalizedContracts,
        normalizedNotionalUsdt,
        actualRiskAtStopUsdt,
        actualRiskPct,
        usableAvailableBalanceUsdt,
        marginCapacityPassed: true,
        emergencyCapUsdt: emergency.cap,
        legacyCapSource: emergency.legacyCapSource,
        htfSizeMultiplierApplied
    };
}
