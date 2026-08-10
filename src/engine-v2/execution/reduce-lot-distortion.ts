/** Medium shock protective reduce: hold if lot distortion exceeds this ratio. */
export const V2_REDUCE_LOT_DISTORTION_HOLD_THRESHOLD = 1.75;

/** Urgent invalidation/stop paths may execute despite distortion. */
export const V2_REDUCE_LOT_DISTORTION_URGENT_REASONS = new Set([
    "SHOCK_FULL_EXIT_AGAINST_POSITION",
    "PNL_STOP_PROTECT",
    "INVALIDATION_REACHED",
    "STRUCTURAL_EXIT",
    "FULL_EXIT"
]);

export type ReduceLotDistortionResult = Readonly<{
    desiredReduceRatio: number;
    desiredReduceContracts: number;
    normalizedReduceContracts: number;
    actualReduceRatio: number;
    lotSizeDistortionRatio: number;
    holdDueToDistortion: boolean;
    executeDespiteDistortion: boolean;
}>;

export function evaluateReduceLotDistortion(input: Readonly<{
    positionContracts: number;
    desiredReduceRatio: number;
    normalizedReduceContracts: number;
    reason: string;
}>): ReduceLotDistortionResult {
    const positionContracts = Math.max(0, input.positionContracts);
    const desiredReduceContracts = positionContracts * Math.max(0, Math.min(1, input.desiredReduceRatio));
    const normalized = Math.max(0, input.normalizedReduceContracts);
    const actualReduceRatio =
        positionContracts > 0 ? normalized / positionContracts : normalized > 0 ? 1 : 0;
    const desiredRatio = Math.max(0, Math.min(1, input.desiredReduceRatio));
    const lotSizeDistortionRatio =
        desiredRatio > 0 ? actualReduceRatio / desiredRatio : actualReduceRatio > 0 ? Infinity : 1;
    const urgent = V2_REDUCE_LOT_DISTORTION_URGENT_REASONS.has(String(input.reason).toUpperCase()) ||
        String(input.reason).includes("FULL_EXIT") ||
        String(input.reason).includes("INVALIDATION");
    const holdDueToDistortion =
        !urgent && lotSizeDistortionRatio > V2_REDUCE_LOT_DISTORTION_HOLD_THRESHOLD;
    return {
        desiredReduceRatio: desiredRatio,
        desiredReduceContracts,
        normalizedReduceContracts: normalized,
        actualReduceRatio,
        lotSizeDistortionRatio,
        holdDueToDistortion,
        executeDespiteDistortion: urgent
    };
}

export function buildReduceLotDistortionProof(
    symbol: string,
    side: string,
    result: ReduceLotDistortionResult
): Record<string, unknown> {
    return {
        event: "V2_REDUCE_LOT_DISTORTION_PROOF",
        symbol,
        side,
        desired_reduce_ratio: result.desiredReduceRatio,
        desired_reduce_contracts: result.desiredReduceContracts,
        normalized_reduce_contracts: result.normalizedReduceContracts,
        actual_reduce_ratio: result.actualReduceRatio,
        lot_size_distortion_ratio: result.lotSizeDistortionRatio,
        hold_due_to_distortion: result.holdDueToDistortion,
        execute_despite_distortion: result.executeDespiteDistortion,
        distortion_hold_threshold: V2_REDUCE_LOT_DISTORTION_HOLD_THRESHOLD
    };
}
