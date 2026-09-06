/**
 * Live Leverage Selection Authority (PHASE LEVERAGE-CONTROL-1).
 * Isolates sizing leverage (fixed 10x) from execution leverage (operator-selected 10/25/50/100x).
 */

export type AllowedExecutionLeverage = 10 | 25 | 50 | 100;

export const ALLOWED_EXECUTION_LEVERAGES: ReadonlyArray<AllowedExecutionLeverage> = [10, 25, 50, 100];

export const DEFAULT_SIZING_LEVERAGE = 10;
export const DEFAULT_EXECUTION_LEVERAGE: AllowedExecutionLeverage = 10;

export function isValidExecutionLeverage(v: unknown): v is AllowedExecutionLeverage {
    return typeof v === "number" && (v === 10 || v === 25 || v === 50 || v === 100);
}

export function normalizeExecutionLeverage(v: unknown, fallback: AllowedExecutionLeverage = 10): AllowedExecutionLeverage {
    const num = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
    if (isValidExecutionLeverage(num)) return num;
    return fallback;
}

export type LeverageSelectionAuthorityInput = Readonly<{
    symbol: string;
    selectedLeverage?: number | null;
    confirmedOkxLeverage?: number | null;
    finalOrderNotionalUsdt: number;
    positionOpen: boolean;
    sizingLeverage?: number;
    allocatedMarginUsdt?: number;
}>;

export type LeverageSelectionAuthorityResult = Readonly<{
    symbol: string;
    sizingLeverage: number;
    selectedExecutionLeverage: AllowedExecutionLeverage;
    confirmedOkxLeverage: number | null;
    allocatedMarginUsdt: number;
    finalOrderNotionalUsdt: number;
    requiredMarginUsdt: number;
    positionOpen: boolean;
    appliesToNextNewEntry: boolean;
    leverageSyncRequired: boolean;
    validationPassed: boolean;
    blockReason: string | null;
}>;

export function evaluateLeverageSelectionAuthority(
    input: LeverageSelectionAuthorityInput
): LeverageSelectionAuthorityResult {
    const symbol = String(input.symbol);
    const sizingLeverage = typeof input.sizingLeverage === "number" && input.sizingLeverage > 0
        ? input.sizingLeverage
        : DEFAULT_SIZING_LEVERAGE;
    const rawNotional = typeof input.finalOrderNotionalUsdt === "number" && Number.isFinite(input.finalOrderNotionalUsdt)
        ? Math.max(0, input.finalOrderNotionalUsdt)
        : 0;
    const allocatedMarginUsdt = typeof input.allocatedMarginUsdt === "number" && Number.isFinite(input.allocatedMarginUsdt) && input.allocatedMarginUsdt > 0
        ? input.allocatedMarginUsdt
        : (sizingLeverage > 0 ? rawNotional / sizingLeverage : rawNotional / DEFAULT_SIZING_LEVERAGE);

    // Validate selected execution leverage
    const rawSelected = input.selectedLeverage;
    const isExplicitlyProvided = rawSelected !== undefined && rawSelected !== null;
    const isValid = isValidExecutionLeverage(rawSelected);

    if (isExplicitlyProvided && !isValid) {
        const finalOrderNotionalUsdt = allocatedMarginUsdt * DEFAULT_EXECUTION_LEVERAGE;
        return {
            symbol,
            sizingLeverage,
            selectedExecutionLeverage: DEFAULT_EXECUTION_LEVERAGE,
            confirmedOkxLeverage: input.confirmedOkxLeverage ?? null,
            allocatedMarginUsdt,
            finalOrderNotionalUsdt,
            requiredMarginUsdt: allocatedMarginUsdt,
            positionOpen: input.positionOpen,
            appliesToNextNewEntry: true,
            leverageSyncRequired: false,
            validationPassed: false,
            blockReason: "INVALID_EXECUTION_LEVERAGE_REJECTED"
        };
    }

    const selectedExecutionLeverage = normalizeExecutionLeverage(rawSelected, DEFAULT_EXECUTION_LEVERAGE);
    const finalOrderNotionalUsdt = allocatedMarginUsdt * selectedExecutionLeverage;
    const requiredMarginUsdt = allocatedMarginUsdt;

    const confirmedOkxLeverage = typeof input.confirmedOkxLeverage === "number" && Number.isFinite(input.confirmedOkxLeverage) && input.confirmedOkxLeverage > 0
        ? input.confirmedOkxLeverage
        : null;

    // Position open rule: If position is currently open, cannot alter live leverage now. Scope is NEXT_NEW_ENTRY.
    if (input.positionOpen) {
        return {
            symbol,
            sizingLeverage,
            selectedExecutionLeverage,
            confirmedOkxLeverage,
            allocatedMarginUsdt,
            finalOrderNotionalUsdt,
            requiredMarginUsdt,
            positionOpen: true,
            appliesToNextNewEntry: true,
            leverageSyncRequired: false,
            validationPassed: true,
            blockReason: null
        };
    }

    // Flat position: Next new entry needs sync if confirmed differs from selected
    const leverageSyncRequired = confirmedOkxLeverage !== selectedExecutionLeverage;

    return {
        symbol,
        sizingLeverage,
        selectedExecutionLeverage,
        confirmedOkxLeverage,
        allocatedMarginUsdt,
        finalOrderNotionalUsdt,
        requiredMarginUsdt,
        positionOpen: false,
        appliesToNextNewEntry: true,
        leverageSyncRequired,
        validationPassed: true,
        blockReason: null
    };
}

export type V2LeverageSelectionAuthorityProof = Readonly<{
    event: "V2_LEVERAGE_SELECTION_AUTHORITY_PROOF";
    symbol: string;
    sizing_leverage: number;
    selected_execution_leverage: AllowedExecutionLeverage;
    confirmed_okx_leverage: number | null;
    allocated_margin_usdt: number;
    final_order_notional_usdt: number;
    required_margin_usdt: number;
    position_open: boolean;
    applies_to_next_new_entry: boolean;
    validation_passed: boolean;
    block_reason: string | null;
}>;

export function buildLeverageSelectionAuthorityProof(
    res: LeverageSelectionAuthorityResult
): V2LeverageSelectionAuthorityProof {
    return {
        event: "V2_LEVERAGE_SELECTION_AUTHORITY_PROOF",
        symbol: res.symbol,
        sizing_leverage: res.sizingLeverage,
        selected_execution_leverage: res.selectedExecutionLeverage,
        confirmed_okx_leverage: res.confirmedOkxLeverage,
        allocated_margin_usdt: res.allocatedMarginUsdt,
        final_order_notional_usdt: res.finalOrderNotionalUsdt,
        required_margin_usdt: res.requiredMarginUsdt,
        position_open: res.positionOpen,
        applies_to_next_new_entry: res.appliesToNextNewEntry,
        validation_passed: res.validationPassed,
        block_reason: res.blockReason
    };
}
