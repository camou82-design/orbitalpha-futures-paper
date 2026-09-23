import { EngineV2FinalDecision, EngineV2Side } from "../types";

export interface EthDirectionalAuthorityMismatchInput {
    symbol: string;
    isInitialEntry: boolean;
    hasPosition: boolean;
    currentPositionsCount: number;
    isOperatorManaged: boolean;
    isManualTakeover: boolean;
    isAdoptedExternal: boolean;
    hardControlClear: boolean;
    hardBlockPresent: boolean;
    trendSideCandidate: EngineV2Side;
    rangeSideCandidate: EngineV2Side;
    riskLongAllow: boolean;
    riskShortAllow: boolean;
    allowNewLong: boolean;
    allowNewShort: boolean;
    v2DecisionBeforePromotion: EngineV2FinalDecision | string;
    v2SideBeforePromotion: EngineV2Side;
    v2RejectReasonBeforePromotion: string | null;
    v2DecisionAfterPromotion: EngineV2FinalDecision | string;
    v2SideAfterPromotion: EngineV2Side;
    v2RejectReasonAfterPromotion: string | null;
}

export interface EthDirectionalAuthorityMismatchProof {
    event: "ETH_DIRECTIONAL_AUTHORITY_MISMATCH_RECONCILED_PROOF";
    symbol: string;
    agreed_candidate_side: EngineV2Side;
    stale_side_before: EngineV2Side;
    stale_reject_reason_before: string | null;
    trend_side_candidate: EngineV2Side;
    range_side_candidate: EngineV2Side;
    risk_long_allow: boolean;
    risk_short_allow: boolean;
    allow_new_long: boolean;
    allow_new_short: boolean;
    decision_after_reconciliation: EngineV2FinalDecision;
    side_after_reconciliation: EngineV2Side;
    reconciled_reason: string | null;
}

export interface EthDirectionalAuthorityMismatchResult {
    reconciled: boolean;
    agreedCandidateSide: EngineV2Side;
    reconciledSide: EngineV2Side;
    reconciledDecision: EngineV2FinalDecision;
    reconciledRejectReason: string | null;
    reason: string | null;
    proof: EthDirectionalAuthorityMismatchProof | null;
}

/**
 * Evaluates ETH-specific directional authority mismatch reconciliation.
 *
 * When ETHUSDT is flat, in initial entry, autonomous (non-manual/non-external),
 * and has no hard control block:
 * If both trend_side_candidate and range_side_candidate agree on the SAME direction
 * (e.g., short/short or long/long) and that direction is permitted by risk policy,
 * but a stale opposite side (e.g. stale long or stale short) caused a false
 * SIDE_NOT_ALLOWED_* reject, this reconciler replaces the stale opposite side with the
 * agreed authoritative candidate side and clears the stale rejection so downstream
 * Quality, HTF, Shock, Highway, and 40 USDT cap gates evaluate the true candidate side.
 *
 * Invariant: Never relaxes genuine SIDE_NOT_ALLOWED rejections when risk disallowed.
 * Invariant: BTC and all non-ETH symbols are completely unaffected.
 */
export function evaluateEthDirectionalAuthorityMismatch(
    input: EthDirectionalAuthorityMismatchInput
): EthDirectionalAuthorityMismatchResult {
    const rawSymbol = String(input.symbol ?? "");
    const normSymbol = rawSymbol.toUpperCase().replace("-SWAP", "").replace("-", "");
    const isEth = normSymbol === "ETHUSDT";

    const defaultDecision = (input.v2DecisionAfterPromotion as EngineV2FinalDecision) ?? "HOLD";

    if (!isEth) {
        return {
            reconciled: false,
            agreedCandidateSide: "none",
            reconciledSide: input.v2SideAfterPromotion,
            reconciledDecision: defaultDecision,
            reconciledRejectReason: input.v2RejectReasonAfterPromotion,
            reason: "SYMBOL_NOT_ETH",
            proof: null
        };
    }

    const isFlatInitialEntry =
        input.isInitialEntry === true &&
        input.hasPosition === false &&
        input.currentPositionsCount === 0;

    if (!isFlatInitialEntry) {
        return {
            reconciled: false,
            agreedCandidateSide: "none",
            reconciledSide: input.v2SideAfterPromotion,
            reconciledDecision: defaultDecision,
            reconciledRejectReason: input.v2RejectReasonAfterPromotion,
            reason: "NOT_FLAT_INITIAL_ENTRY",
            proof: null
        };
    }

    const isAutonomousClean =
        !input.isOperatorManaged &&
        !input.isManualTakeover &&
        !input.isAdoptedExternal;

    if (!isAutonomousClean) {
        return {
            reconciled: false,
            agreedCandidateSide: "none",
            reconciledSide: input.v2SideAfterPromotion,
            reconciledDecision: defaultDecision,
            reconciledRejectReason: input.v2RejectReasonAfterPromotion,
            reason: "MANUAL_OR_EXTERNAL_CONTROL_PRESENT",
            proof: null
        };
    }

    const isHardBlockFree =
        input.hardControlClear === true &&
        input.hardBlockPresent === false;

    if (!isHardBlockFree) {
        return {
            reconciled: false,
            agreedCandidateSide: "none",
            reconciledSide: input.v2SideAfterPromotion,
            reconciledDecision: defaultDecision,
            reconciledRejectReason: input.v2RejectReasonAfterPromotion,
            reason: "HARD_BLOCK_PRESENT_OR_CONTROL_NOT_CLEAR",
            proof: null
        };
    }

    // Case A: Symmetrical SHORT agreement (trend=short, range=short, risk_short_allow=true, allow_new_short=true)
    const isAgreedShort =
        input.trendSideCandidate === "short" &&
        input.rangeSideCandidate === "short" &&
        input.riskShortAllow === true &&
        input.allowNewShort === true;

    const hasStaleOppositeLong =
        input.v2SideBeforePromotion === "long" ||
        input.v2SideAfterPromotion === "long" ||
        input.v2RejectReasonBeforePromotion === "SIDE_NOT_ALLOWED_LONG" ||
        input.v2RejectReasonAfterPromotion === "SIDE_NOT_ALLOWED_LONG";

    if (isAgreedShort && hasStaleOppositeLong) {
        const proof: EthDirectionalAuthorityMismatchProof = {
            event: "ETH_DIRECTIONAL_AUTHORITY_MISMATCH_RECONCILED_PROOF",
            symbol: rawSymbol,
            agreed_candidate_side: "short",
            stale_side_before: input.v2SideBeforePromotion,
            stale_reject_reason_before: input.v2RejectReasonBeforePromotion,
            trend_side_candidate: input.trendSideCandidate,
            range_side_candidate: input.rangeSideCandidate,
            risk_long_allow: input.riskLongAllow,
            risk_short_allow: input.riskShortAllow,
            allow_new_long: input.allowNewLong,
            allow_new_short: input.allowNewShort,
            decision_after_reconciliation: "HOLD",
            side_after_reconciliation: "short",
            reconciled_reason: "ETH_AGREED_SHORT_RECONCILED_FROM_STALE_LONG"
        };

        return {
            reconciled: true,
            agreedCandidateSide: "short",
            reconciledSide: "short",
            reconciledDecision: "HOLD",
            reconciledRejectReason: null,
            reason: "ETH_AGREED_SHORT_RECONCILED_FROM_STALE_LONG",
            proof
        };
    }

    // Case B: Symmetrical LONG agreement (trend=long, range=long, risk_long_allow=true, allow_new_long=true)
    const isAgreedLong =
        input.trendSideCandidate === "long" &&
        input.rangeSideCandidate === "long" &&
        input.riskLongAllow === true &&
        input.allowNewLong === true;

    const hasStaleOppositeShort =
        input.v2SideBeforePromotion === "short" ||
        input.v2SideAfterPromotion === "short" ||
        input.v2RejectReasonBeforePromotion === "SIDE_NOT_ALLOWED_SHORT" ||
        input.v2RejectReasonAfterPromotion === "SIDE_NOT_ALLOWED_SHORT";

    if (isAgreedLong && hasStaleOppositeShort) {
        const proof: EthDirectionalAuthorityMismatchProof = {
            event: "ETH_DIRECTIONAL_AUTHORITY_MISMATCH_RECONCILED_PROOF",
            symbol: rawSymbol,
            agreed_candidate_side: "long",
            stale_side_before: input.v2SideBeforePromotion,
            stale_reject_reason_before: input.v2RejectReasonBeforePromotion,
            trend_side_candidate: input.trendSideCandidate,
            range_side_candidate: input.rangeSideCandidate,
            risk_long_allow: input.riskLongAllow,
            risk_short_allow: input.riskShortAllow,
            allow_new_long: input.allowNewLong,
            allow_new_short: input.allowNewShort,
            decision_after_reconciliation: "HOLD",
            side_after_reconciliation: "long",
            reconciled_reason: "ETH_AGREED_LONG_RECONCILED_FROM_STALE_SHORT"
        };

        return {
            reconciled: true,
            agreedCandidateSide: "long",
            reconciledSide: "long",
            reconciledDecision: "HOLD",
            reconciledRejectReason: null,
            reason: "ETH_AGREED_LONG_RECONCILED_FROM_STALE_SHORT",
            proof
        };
    }

    return {
        reconciled: false,
        agreedCandidateSide: "none",
        reconciledSide: input.v2SideAfterPromotion,
        reconciledDecision: defaultDecision,
        reconciledRejectReason: input.v2RejectReasonAfterPromotion,
        reason: "NO_AGREED_DIRECTIONAL_MISMATCH",
        proof: null
    };
}
