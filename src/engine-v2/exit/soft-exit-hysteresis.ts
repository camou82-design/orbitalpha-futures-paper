export interface SoftExitHysteresisState {
    candidateReason: string;
    lastConfirmedCandleTs: number;
    confirmationCount: number;
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

export function isPureTakeProfitReason(reason: string, action?: string, pnlPct?: number): boolean {
    const r = String(reason || "").toUpperCase();
    const act = String(action || "").toUpperCase();
    if (isHardExitReason(reason)) return false;

    // Normal take profit / TP1 partial execution is immediate (no hysteresis)
    return (
        r.includes("TP1") ||
        r.includes("TAKE_PROFIT_1") ||
        r.includes("PROFIT_PROTECTION_PARTIAL_TP") ||
        (act === "PARTIAL_TAKE_PROFIT" && (pnlPct == null || pnlPct > 0) && !r.includes("WEAKNESS") && !r.includes("CONFLICT"))
    );
}

export function isSoftExitReason(reason: string, action?: string, pnlPct?: number): boolean {
    const r = String(reason || "").toUpperCase();
    const act = String(action || "").toUpperCase();
    if (isHardExitReason(reason)) return false;
    if (isPureTakeProfitReason(reason, action, pnlPct)) return false;

    return (
        act === "REDUCE" ||
        r.includes("WEAKNESS") ||
        r.includes("CONFLICT") ||
        r.includes("PROTECTIVE_REDUCE") ||
        r.includes("TRANSITION_REDUCE") ||
        r.includes("SHOCK_PROTECTIVE_REDUCE") ||
        r.includes("SOFT_EXIT")
    );
}

export interface ApplySoftExitHysteresisArgs {
    symbol: string;
    action: string;
    reason: string;
    evidence: string;
    now?: number;
    latestClosedCandleTs?: number | null;
    pnlPct?: number;
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
        latestClosedCandleTs = null,
        pnlPct = 0,
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

    // 2. Pure Take Profit / TP1 -> Immediate execution, no hysteresis delay
    if (isPureTakeProfitReason(reason, action, pnlPct)) {
        return {
            action,
            reason,
            evidence: `${evidence}|take_profit_immediate_no_hysteresis`,
            hysteresisApplied: false,
            confirmationCount: 0
        };
    }

    // 3. Soft Exit Candidate (Weakness/Conflict/Defensive Reduction)
    if (isSoftExitReason(reason, action, pnlPct)) {
        const existing = symbolSoftExitCandidateMap.get(symKey);

        // Strict Requirement: MUST have authoritative closed-candle timestamp
        const hasAuthoritativeClosedCandleTs =
            typeof latestClosedCandleTs === "number" &&
            Number.isFinite(latestClosedCandleTs) &&
            latestClosedCandleTs > 0;

        if (!hasAuthoritativeClosedCandleTs) {
            // Closed candle timestamp missing: do NOT increment count, maintain existing count and HOLD
            return {
                action: "HOLD",
                reason: "SOFT_EXIT_WAITING_CLOSED_CANDLE_AUTHORITY",
                evidence: `${evidence}|soft_exit_waiting_closed_candle_authority`,
                hysteresisApplied: true,
                confirmationCount: existing ? existing.confirmationCount : 0
            };
        }

        const effectiveCandleTs = latestClosedCandleTs;

        if (!existing || existing.candidateReason !== reason) {
            // First detection in this authoritative 5m closed candle
            symbolSoftExitCandidateMap.set(symKey, {
                candidateReason: reason,
                lastConfirmedCandleTs: effectiveCandleTs,
                confirmationCount: 1,
                firstDetectedAt: now
            });
            return {
                action: "HOLD",
                reason: "SOFT_EXIT_HYSTERESIS_WATCH",
                evidence: `${evidence}|soft_exit_hysteresis_pending_candle_1_of_${requiredConfirmations}`,
                hysteresisApplied: true,
                confirmationCount: 1
            };
        } else {
            // Repeated detection: check if candle timestamp is distinct
            if (effectiveCandleTs === existing.lastConfirmedCandleTs) {
                // Same 5m candle repeated tick -> do NOT increment count
                return {
                    action: "HOLD",
                    reason: "SOFT_EXIT_HYSTERESIS_WATCH",
                    evidence: `${evidence}|soft_exit_hysteresis_same_candle_recheck_count_${existing.confirmationCount}`,
                    hysteresisApplied: true,
                    confirmationCount: existing.confirmationCount
                };
            } else if (effectiveCandleTs > existing.lastConfirmedCandleTs) {
                // Next distinct closed 5m candle confirmed!
                const newCount = existing.confirmationCount + 1;
                if (newCount < requiredConfirmations) {
                    symbolSoftExitCandidateMap.set(symKey, {
                        ...existing,
                        lastConfirmedCandleTs: effectiveCandleTs,
                        confirmationCount: newCount
                    });
                    return {
                        action: "HOLD",
                        reason: "SOFT_EXIT_HYSTERESIS_WATCH",
                        evidence: `${evidence}|soft_exit_hysteresis_pending_candle_${newCount}_of_${requiredConfirmations}`,
                        hysteresisApplied: true,
                        confirmationCount: newCount
                    };
                } else {
                    // Confirmed across required distinct closed 5m candles! Allow soft exit and start cooldown
                    symbolSoftExitCandidateMap.delete(symKey);
                    symbolSoftExitCooldownMap.set(symKey, {
                        exitedAt: now,
                        side: "none",
                        reason
                    });
                    return {
                        action,
                        reason,
                        evidence: `${evidence}|soft_exit_hysteresis_confirmed_${newCount}_closed_5m_candles`,
                        hysteresisApplied: false,
                        confirmationCount: newCount
                    };
                }
            }
        }
    }

    // 4. Normal hold or clear state -> reset candidate state
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
