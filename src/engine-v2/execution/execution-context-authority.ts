import type { EngineV2Side } from "../types";
import type { RegimeAuthorityResult } from "../state/regime-authority";
import type { PhaseAuthorityResult } from "../state/phase-authority";
import type { HighwayLifecycleStage } from "../highway-core/highway-lifecycle-authority";

export type ExecutionActionAuthority =
    | "WAIT"
    | "LONG_SETUP"
    | "SHORT_SETUP"
    | "ENTER"
    | "HOLD"
    | "SKIP"
    | "DEFENSIVE_ADDON_EVAL";

export type ExecutionContextAuthorityResult = Readonly<{
    execution_action: ExecutionActionAuthority;
    candidate_side: EngineV2Side;
    entry_side: EngineV2Side;
    execution_direction_source: string;
    candidate_side_before_regime_alignment: EngineV2Side;
    candidate_side_after_regime_alignment: EngineV2Side;
    highway_entry_gate_reached: boolean;
    quality_score: number;
    edge_ok: boolean;
    rr_ok: boolean;
    chase_blocked: boolean;
    shock_hard_block: boolean;
}>;

export function alignCandidateSideToRegimeDirection(args: Readonly<{
    canonicalRegime: RegimeAuthorityResult["canonicalRegime"];
    candidateSide: EngineV2Side;
}>): Readonly<{ before: EngineV2Side; after: EngineV2Side; source: string }> {
    const before = args.candidateSide;
    if (before !== "long" && before !== "short") {
        return { before, after: before, source: "NO_CANDIDATE" };
    }
    if (args.canonicalRegime === "TREND_UP" && before === "short") {
        return { before, after: "none", source: "REGIME_TREND_UP_BLOCKS_SHORT" };
    }
    if (args.canonicalRegime === "TREND_DOWN" && before === "long") {
        return { before, after: "none", source: "REGIME_TREND_DOWN_BLOCKS_LONG" };
    }
    return { before, after: before, source: "REGIME_DIRECTION_ALIGNED" };
}

export type Highway3LayerAuthorityProof = Readonly<{
    symbol: string;
    canonical_regime: string;
    previous_final_regime: string;
    final_regime: string;
    regime_direction: string;
    trend_candidate_direction_source: string;
    ema_gap: number;
    candidate_side_before_regime_authority: string;
    candidate_side_after_regime_authority: string;
    regime_change_requested: boolean;
    regime_change_confirmed: boolean;
    regime_change_reason: string | null;
    htf_15m_bias: string;
    htf_1h_bias: string;
    htf_4h_bias: string;
    htf_1d_bias: string;
    phase: string;
    phase_reason: string;
    higher_low: boolean;
    higher_high: boolean;
    lower_high: boolean;
    lower_low: boolean;
    upper_breakout_hold: boolean;
    lower_breakdown_hold: boolean;
    structural_box_state: string;
    shock_overlay: string;
    crash_state: string;
    shock_hard_block: boolean;
    execution_action: string;
    execution_direction_source: string;
    candidate_side: string;
    candidate_side_before_regime_alignment: string;
    candidate_side_after_regime_alignment: string;
    entry_side: string;
    highway_entry_gate_reached: boolean;
    quality_score: number;
    edge_ok: boolean;
    rr_ok: boolean;
    chase_blocked: boolean;
    is_highway_lineage: boolean;
    highway_lifecycle_stage: string | null;
    defensive_authority_active: boolean;
    pyramid_authority_active: boolean;
}>;

function crashHard(crashState: string): boolean {
    const u = String(crashState ?? "NONE").toUpperCase();
    return u.includes("LOCK") || u.includes("EXIT");
}

export function resolveExecutionContextAuthority(args: Readonly<{
    regime: RegimeAuthorityResult;
    phase: PhaseAuthorityResult;
    finalDecision: string;
    finalSide: EngineV2Side;
    highwayGateRejected: boolean;
    highwayGateAllowed: boolean;
    qualityScore: number;
    expectedNextAction?: string | null;
    whipsawActive: boolean;
    crashState: string;
    chaseBlocked?: boolean;
    edgeOk?: boolean;
    rrOk?: boolean;
    rawCandidateSide?: EngineV2Side;
}>): ExecutionContextAuthorityResult {
    const shock_hard_block = crashHard(args.crashState) || args.whipsawActive;

    let execution_action: ExecutionActionAuthority = "WAIT";
    let entry_side: EngineV2Side = "none";

    const rawCandidate: EngineV2Side =
        args.rawCandidateSide === "long" || args.rawCandidateSide === "short"
            ? args.rawCandidateSide
            : args.finalSide === "long" || args.finalSide === "short"
              ? args.finalSide
              : "none";
    const alignment = alignCandidateSideToRegimeDirection({
        canonicalRegime: args.regime.canonicalRegime,
        candidateSide: rawCandidate
    });
    const candidate_side = alignment.after;
    const execution_direction_source = alignment.source;

    const setupLong =
        args.regime.canonicalRegime === "TREND_UP" &&
        (args.phase.phase === "PULLBACK" || args.phase.phase === "BREAKOUT" || args.phase.phase === "RETEST" || args.phase.phase === "CONTINUATION");
    const setupShort =
        args.regime.canonicalRegime === "TREND_DOWN" &&
        (args.phase.phase === "PULLBACK" || args.phase.phase === "BREAKOUT" || args.phase.phase === "RETEST" || args.phase.phase === "CONTINUATION");

    if (shock_hard_block) {
        execution_action = "WAIT";
        entry_side = "none";
    } else if (args.phase.shockOverlay !== "NONE") {
        execution_action = "WAIT";
        entry_side = "none";
    } else if (args.phase.phase === "DEEP_PULLBACK" && args.regime.canonicalRegime.startsWith("TREND")) {
        execution_action = "DEFENSIVE_ADDON_EVAL";
    } else if (
        args.finalDecision === "ENTER" &&
        candidate_side !== "none" &&
        args.highwayGateAllowed &&
        !args.highwayGateRejected
    ) {
        execution_action = "ENTER";
        entry_side = candidate_side;
    } else if (setupLong && candidate_side === "long") {
        execution_action = "LONG_SETUP";
        entry_side = candidate_side === "long" ? "long" : "none";
    } else if (setupShort && candidate_side === "short") {
        execution_action = "SHORT_SETUP";
        entry_side = "short";
    } else if (args.finalDecision === "HOLD") {
        execution_action = "HOLD";
    } else if (args.finalDecision === "SKIP") {
        execution_action = "SKIP";
    } else {
        execution_action = "WAIT";
    }

    if (args.phase.phase === "WHIPSAW" || args.phase.phase === "CONSOLIDATION") {
        if (execution_action === "LONG_SETUP" || execution_action === "SHORT_SETUP") {
            execution_action = "WAIT";
        }
    }

    if (args.finalDecision === "ENTER" && candidate_side === "none" && rawCandidate !== "none") {
        execution_action = "SKIP";
        entry_side = "none";
    }

    const highway_entry_gate_reached =
        args.finalDecision === "ENTER" && !args.highwayGateRejected && args.highwayGateAllowed;

    return {
        execution_action,
        candidate_side,
        entry_side,
        execution_direction_source,
        candidate_side_before_regime_alignment: alignment.before,
        candidate_side_after_regime_alignment: alignment.after,
        highway_entry_gate_reached,
        quality_score: args.qualityScore,
        edge_ok: args.edgeOk ?? highway_entry_gate_reached,
        rr_ok: args.rrOk ?? highway_entry_gate_reached,
        chase_blocked: args.chaseBlocked ?? args.highwayGateRejected,
        shock_hard_block
    };
}

export function buildHighway3LayerAuthorityProof(args: Readonly<{
    symbol: string;
    regime: RegimeAuthorityResult;
    phase: PhaseAuthorityResult;
    execution: ExecutionContextAuthorityResult;
    crashState: string;
    isHighwayLineage: boolean;
    highwayLifecycleStage: HighwayLifecycleStage | null;
    defensiveAuthorityActive: boolean;
    pyramidAuthorityActive: boolean;
    trendCandidateDirectionSource: string;
    emaGap: number;
    candidateSideBeforeRegimeAuthority: string;
    candidateSideAfterRegimeAuthority: string;
}>): Highway3LayerAuthorityProof {
    return {
        symbol: args.symbol,
        canonical_regime: args.regime.canonicalRegime,
        previous_final_regime: args.regime.previousCanonicalRegime,
        final_regime: args.regime.canonicalRegime,
        regime_direction: args.regime.regimeDirection,
        trend_candidate_direction_source: args.trendCandidateDirectionSource,
        ema_gap: args.emaGap,
        candidate_side_before_regime_authority: args.candidateSideBeforeRegimeAuthority,
        candidate_side_after_regime_authority: args.candidateSideAfterRegimeAuthority,
        regime_change_requested: args.regime.regimeChangeRequested,
        regime_change_confirmed: args.regime.regimeChangeConfirmed,
        regime_change_reason: args.regime.regimeChangeReason,
        htf_15m_bias: args.regime.htf_15m_bias,
        htf_1h_bias: args.regime.htf_1h_bias,
        htf_4h_bias: args.regime.htf_4h_bias,
        htf_1d_bias: args.regime.htf_1d_bias,
        phase: args.phase.phase,
        phase_reason: args.phase.phaseReason,
        higher_low: args.phase.higher_low,
        higher_high: args.phase.higher_high,
        lower_high: args.phase.lower_high,
        lower_low: args.phase.lower_low,
        upper_breakout_hold: args.phase.upper_breakout_hold,
        lower_breakdown_hold: args.phase.lower_breakdown_hold,
        structural_box_state: args.phase.structural_box_state,
        shock_overlay: args.phase.shockOverlay,
        crash_state: String(args.crashState ?? "NONE"),
        shock_hard_block: args.execution.shock_hard_block,
        execution_action: args.execution.execution_action,
        execution_direction_source: args.execution.execution_direction_source,
        candidate_side: String(args.execution.candidate_side),
        candidate_side_before_regime_alignment: String(args.execution.candidate_side_before_regime_alignment),
        candidate_side_after_regime_alignment: String(args.execution.candidate_side_after_regime_alignment),
        entry_side: String(args.execution.entry_side),
        highway_entry_gate_reached: args.execution.highway_entry_gate_reached,
        quality_score: args.execution.quality_score,
        edge_ok: args.execution.edge_ok,
        rr_ok: args.execution.rr_ok,
        chase_blocked: args.execution.chase_blocked,
        is_highway_lineage: args.isHighwayLineage,
        highway_lifecycle_stage: args.highwayLifecycleStage,
        defensive_authority_active: args.defensiveAuthorityActive,
        pyramid_authority_active: args.pyramidAuthorityActive
    };
}
