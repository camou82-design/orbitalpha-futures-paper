/** Stronger adverse move required for shock-only full exit without structural confirm. */
export const SHOCK_FULL_EXIT_STRONG_ADVERSE_MOVE_PCT = 0.003; // 0.30%

export function isShockFullExitConfirmationMet(input: Readonly<{
    secondaryInvalidationConfirmation: boolean;
    underlyingAdverseMovePct: number;
    adverseMoveMeasured: boolean;
}>): boolean {
    if (input.secondaryInvalidationConfirmation) return true;
    if (
        input.adverseMoveMeasured &&
        input.underlyingAdverseMovePct >= SHOCK_FULL_EXIT_STRONG_ADVERSE_MOVE_PCT
    ) {
        return true;
    }
    return false;
}
