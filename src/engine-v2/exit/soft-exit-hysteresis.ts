export interface SoftExitHysteresisState {
    candidateReason: string;
    count: number;
    firstDetectedAt: number;
}

export interface SoftExitCooldownState {
    exitedAt: number;
    side: string;
    reason: string;
}

const symbolSoftExitCandidateMap = new Map<string, SoftExitHysteresisState>();
const symbolSoftExitCooldownMap = new Map<string, SoftExitCooldownState>();

export const DEFAULT_SOFT_EXIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export function isHardExitReason(reason: string, evidence?: string): boolean {
    const r = String(reason || "").toUpperCase();
    const ev = String(evidence || "").toLowerCase();
    return (
        r.includes("COMMITTED_STOP") ||
        ev.includes("committed_stop_breached") ||
        ev.includes("hard_invalidation_confirmed") ||
        ev.includes("shock_full_exit") ||
        r === "V2_EXIT_INVALIDATION" ||
        r === "SHOCK_FULL_EXIT_AGAINST_POSITION" ||
        (r === "PNL_STOP_PROTECT" && ev.includes("pnl_stop_critical")) ||
        (r === "RANGE_FULL_EXIT_BOX_BREAK" && ev.includes("box_break"))
    );
}

export function isSoftExitReason(reason: string, action?: string): boolean {
    const r = String(reason || "").toUpperCase();
    const act = String(action || "").toUpperCase();
    if (isHardExitReason(reason)) return false;
    return (
        act === "REDUCE" ||
        act === "PARTIAL_TAKE_PROFIT" ||
        r.includes("WEAKNESS") ||
        r.includes("CONFLICT") ||
        r.includes("PROTECTIVE_REDUCE") ||
        r.includes("PARTIAL_AT_OPPOSITE_EDGE") ||
        r.includes("PULLBACK") ||
        r.includes("TRANSITION_REDUCE") ||
        r.includes("SHOCK_PROTECTIVE_REDUCE")
    );
}

export interface ApplySoftExitHysteresisArgs {
    symbol: string;
    action: string;
    reason: string;
    evidence: string;
    now?: number;
    requiredConfirmations?: number;
}

export interface ApplySoftExitHysteresisResult {
    action: string;
    reason: string;
    evidence: string;
    hysteresisApplied: boolean;
    confirmationCount: number;
}

export function applySoftExitHysteresis(args: ApplySoftExitHysteresisArgs): ApplySoftExitHysteresisResult {
    const {
        symbol,
        action,
        reason,
        evidence,
        now = Date.now(),
        requiredConfirmations = 2
    } = args;

    const symKey = String(symbol || "").toUpperCase();

    // 1. Hard Exit -> Immediate execution, clear soft exit state
    if (isHardExitReason(reason, evidence)) {
        symbolSoftExitCandidateMap.delete(symKey);
        return {
            action,
            reason,
            evidence: `${evidence}|hard_exit_immediate_no_hysteresis`,
            hysteresisApplied: false,
            confirmationCount: 0
        };
    }

    // 2. Soft Exit Candidate -> Require hysteresis confirmation (2 consecutive)
    if (isSoftExitReason(reason, action) && (action === "REDUCE" || action === "PARTIAL_TAKE_PROFIT" || action === "FULL_EXIT")) {
        const existing = symbolSoftExitCandidateMap.get(symKey);
        if (!existing || existing.candidateReason !== reason) {
            // First detection
            symbolSoftExitCandidateMap.set(symKey, {
                candidateReason: reason,
                count: 1,
                firstDetectedAt: now
            });
            return {
                action: "HOLD",
                reason: "SOFT_EXIT_HYSTERESIS_WATCH",
                evidence: `${evidence}|soft_exit_hysteresis_pending_confirmation_1_of_${requiredConfirmations}`,
                hysteresisApplied: true,
                confirmationCount: 1
            };
        } else {
            // Consecutive confirmation
            const newCount = existing.count + 1;
            if (newCount < requiredConfirmations) {
                symbolSoftExitCandidateMap.set(symKey, {
                    ...existing,
                    count: newCount
                });
                return {
                    action: "HOLD",
                    reason: "SOFT_EXIT_HYSTERESIS_WATCH",
                    evidence: `${evidence}|soft_exit_hysteresis_pending_confirmation_${newCount}_of_${requiredConfirmations}`,
                    hysteresisApplied: true,
                    confirmationCount: newCount
                };
            } else {
                // Confirmed! Allow soft exit and register cooldown
                symbolSoftExitCandidateMap.delete(symKey);
                symbolSoftExitCooldownMap.set(symKey, {
                    exitedAt: now,
                    side: "none",
                    reason
                });
                return {
                    action,
                    reason,
                    evidence: `${evidence}|soft_exit_hysteresis_confirmed_${newCount}_cycles`,
                    hysteresisApplied: false,
                    confirmationCount: newCount
                };
            }
        }
    }

    // 3. No soft/hard exit condition active -> reset candidate state
    if (action === "HOLD" || action === "WATCH" || reason === "NO_EXIT_SIGNAL" || reason === "NO_POSITION_HOLD") {
        symbolSoftExitCandidateMap.delete(symKey);
    }

    return {
        action,
        reason,
        evidence,
        hysteresisApplied: false,
        confirmationCount: 0
    };
}

export function isSoftExitCooldownActive(symbol: string, now: number = Date.now(), cooldownDurationMs: number = DEFAULT_SOFT_EXIT_COOLDOWN_MS): boolean {
    const symKey = String(symbol || "").toUpperCase();
    const record = symbolSoftExitCooldownMap.get(symKey);
    if (!record) return false;
    const elapsed = now - record.exitedAt;
    if (elapsed < 0 || elapsed >= cooldownDurationMs) {
        symbolSoftExitCooldownMap.delete(symKey);
        return false;
    }
    return true;
}

export function clearSoftExitState(symbol?: string): void {
    if (symbol) {
        const symKey = String(symbol).toUpperCase();
        symbolSoftExitCandidateMap.delete(symKey);
        symbolSoftExitCooldownMap.delete(symKey);
    } else {
        symbolSoftExitCandidateMap.clear();
        symbolSoftExitCooldownMap.clear();
    }
}
