import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateStructuralRecoveryAuthority } from "../engine-v2/state/recovery-authority";
import { resolvePhaseAuthority } from "../engine-v2/state/phase-authority";
import {
    resetRecoveryDirectionLatchForTests,
    resolveTrendExecutionCandidateDirection
} from "../engine-v2/trend-side-candidate";
import {
    resolveExecutionContextAuthority,
    resolveShockExecutionGate
} from "../engine-v2/execution/execution-context-authority";
import type { TrendRangeScoreAuthority } from "../engine-v2/market-judgment/trend-range-score-authority";

function scoreStub(overrides: Partial<TrendRangeScoreAuthority> = {}): TrendRangeScoreAuthority {
    return {
        ema_gap_component: 0.5,
        structure_component: 0.4,
        htf_component: 0.1,
        higher_low: true,
        higher_high: true,
        upper_breakout_hold: false,
        lower_breakdown_hold: false,
        trend_score_components: {},
        range_score_components: {},
        final_trend_score: 0.6,
        final_range_score: 0.5,
        regime_before: "RANGE",
        ...overrides
    };
}

describe("V2 structural recovery authority", () => {
    it("A: bullish recovery + HL/HH + HTF + negative emaGap → phase release, candidate long, no forced ENTER", () => {
        const recovery = evaluateStructuralRecoveryAuthority({
            whipsawActive: false,
            whipsawSoftWatch: true,
            whipsawReleaseEligible: false,
            higher_low: true,
            higher_high: true,
            lower_low: false,
            lower_high: false,
            upper_breakout_hold: false,
            lower_breakdown_hold: false,
            htfEntryPolicy: "LONG_ONLY_OR_NONE",
            htfBias: { m15: "BULLISH", h1: "BULLISH", h4: "BULLISH", d1: "BULLISH" }
        });
        assert.equal(recovery.recovery_confirmed, true);
        assert.equal(recovery.recovery_direction, "long");

        const phase = resolvePhaseAuthority({
            subtype: "WHIPSAW_SOFT_WATCH",
            trendPhase: "PULLBACK",
            rangePhase: "UPPER",
            transitionPhase: "NONE",
            shockPhase: "NONE",
            whipsawActive: false,
            whipsawSoftWatch: true,
            scoreAuthority: scoreStub(),
            recoveryAuthority: recovery
        });
        assert.equal(phase.phase_before, "WHIPSAW");
        assert.notEqual(phase.phase_after, "WHIPSAW");

        resetRecoveryDirectionLatchForTests();
        const tc = resolveTrendExecutionCandidateDirection({
            symbol: "ETHUSDT",
            directionalShockState: "NONE",
            emaGap: -0.00005,
            canonicalRegime: "RANGE",
            recoveryAuthority: recovery,
            htfEntryPolicy: "LONG_ONLY_OR_NONE"
        });
        assert.equal(tc.candidateSide, "long");
        assert.equal(tc.trendCandidateDirectionSource, "RECOVERY_DIRECTION_LONG");

        const exec = resolveExecutionContextAuthority({
            regime: {
                canonicalRegime: "RANGE",
                regimeFinal: "RANGE",
                previousCanonicalRegime: "RANGE",
                regimeDirection: "none",
                regimeChangeRequested: false,
                regimeChangeConfirmed: true,
                regimeChangeReason: null,
                htf_15m_bias: "BULLISH",
                htf_1h_bias: "BULLISH",
                htf_4h_bias: "BULLISH",
                htf_1d_bias: "BULLISH"
            },
            phase,
            finalDecision: "HOLD",
            finalSide: "none",
            rawCandidateSide: tc.candidateSide,
            highwayGateRejected: false,
            highwayGateAllowed: false,
            qualityScore: 75,
            whipsawActive: false,
            crashState: "NONE",
            recoveryAuthority: recovery
        });
        assert.equal(exec.execution_action, "LONG_SETUP");
        assert.notEqual(exec.execution_action, "ENTER");
        assert.equal(exec.execution_block_reason, null);
    });

    it("B: soft watch without HL/HH keeps WHIPSAW WAIT", () => {
        const recovery = evaluateStructuralRecoveryAuthority({
            whipsawActive: false,
            whipsawSoftWatch: true,
            whipsawReleaseEligible: false,
            higher_low: false,
            higher_high: false,
            lower_low: false,
            lower_high: false,
            upper_breakout_hold: false,
            lower_breakdown_hold: false,
            htfEntryPolicy: "LONG_ONLY_OR_NONE",
            htfBias: { m15: "BULLISH", h1: "BULLISH", h4: "BULLISH", d1: "BULLISH" }
        });
        assert.equal(recovery.recovery_confirmed, false);
        const phase = resolvePhaseAuthority({
            subtype: "WHIPSAW_SOFT_WATCH",
            trendPhase: "PULLBACK",
            rangePhase: "MID",
            transitionPhase: "NONE",
            shockPhase: "NONE",
            whipsawActive: false,
            whipsawSoftWatch: true,
            scoreAuthority: scoreStub({ higher_low: false, higher_high: false }),
            recoveryAuthority: recovery
        });
        assert.equal(phase.phase, "WHIPSAW");
    });

    it("C: bearish recovery symmetric", () => {
        const recovery = evaluateStructuralRecoveryAuthority({
            whipsawActive: false,
            whipsawSoftWatch: true,
            whipsawReleaseEligible: false,
            higher_low: false,
            higher_high: false,
            lower_low: true,
            lower_high: true,
            upper_breakout_hold: false,
            lower_breakdown_hold: false,
            htfEntryPolicy: "SHORT_ONLY_OR_NONE",
            htfBias: { m15: "BEARISH", h1: "BEARISH", h4: "BEARISH", d1: "BEARISH" }
        });
        assert.equal(recovery.recovery_direction, "short");
        resetRecoveryDirectionLatchForTests();
        const tc = resolveTrendExecutionCandidateDirection({
            symbol: "ETHUSDT",
            directionalShockState: "NONE",
            emaGap: 0.00005,
            canonicalRegime: "RANGE",
            recoveryAuthority: recovery,
            htfEntryPolicy: "SHORT_ONLY_OR_NONE"
        });
        assert.equal(tc.candidateSide, "short");
    });

    it("D: emaGap sign flip does not flip latched recovery direction", () => {
        resetRecoveryDirectionLatchForTests();
        const recovery = evaluateStructuralRecoveryAuthority({
            whipsawActive: false,
            whipsawSoftWatch: true,
            whipsawReleaseEligible: false,
            higher_low: true,
            higher_high: true,
            lower_low: false,
            lower_high: false,
            upper_breakout_hold: false,
            lower_breakdown_hold: false,
            htfEntryPolicy: "LONG_ONLY_OR_NONE",
            htfBias: { m15: "BULLISH", h1: "BULLISH", h4: "BULLISH", d1: "BULLISH" }
        });
        const base = {
            symbol: "ETHUSDT",
            directionalShockState: "NONE" as const,
            canonicalRegime: "RANGE" as const,
            recoveryAuthority: recovery,
            htfEntryPolicy: "LONG_ONLY_OR_NONE"
        };
        const t1 = resolveTrendExecutionCandidateDirection({ ...base, emaGap: -0.0001 });
        const t2 = resolveTrendExecutionCandidateDirection({ ...base, emaGap: 0.0001 });
        const t3 = resolveTrendExecutionCandidateDirection({ ...base, emaGap: -0.00002 });
        assert.equal(t1.candidateSide, "long");
        assert.equal(t2.candidateSide, "long");
        assert.equal(t3.candidateSide, "long");
    });

    it("shock audit: hard DOWN_SHOCK + bullish recovery → WAIT", () => {
        const recovery = evaluateStructuralRecoveryAuthority({
            whipsawActive: false,
            whipsawSoftWatch: false,
            whipsawReleaseEligible: false,
            higher_low: true,
            higher_high: true,
            lower_low: false,
            lower_high: false,
            upper_breakout_hold: false,
            lower_breakdown_hold: false,
            htfEntryPolicy: "LONG_ONLY_OR_NONE",
            htfBias: { m15: "BULLISH", h1: "BULLISH", h4: "BULLISH", d1: "BULLISH" }
        });
        const phase = resolvePhaseAuthority({
            subtype: "TREND_UP_CONTINUATION",
            trendPhase: "PULLBACK",
            rangePhase: "NONE",
            transitionPhase: "NONE",
            shockPhase: "DOWN_SHOCK",
            directionalShockState: "DOWN",
            whipsawActive: false,
            whipsawSoftWatch: false,
            scoreAuthority: scoreStub(),
            recoveryAuthority: recovery
        });
        resetRecoveryDirectionLatchForTests();
        const tc = resolveTrendExecutionCandidateDirection({
            symbol: "ETHUSDT",
            directionalShockState: "DOWN",
            emaGap: -0.0001,
            canonicalRegime: "TREND_UP",
            recoveryAuthority: recovery,
            htfEntryPolicy: "LONG_ONLY_OR_NONE"
        });
        assert.equal(tc.candidateSide, "long");
        const exec = resolveExecutionContextAuthority({
            regime: {
                canonicalRegime: "TREND_UP",
                regimeFinal: "TREND",
                previousCanonicalRegime: "TREND_UP",
                regimeDirection: "long",
                regimeChangeRequested: false,
                regimeChangeConfirmed: true,
                regimeChangeReason: null,
                htf_15m_bias: "BULLISH",
                htf_1h_bias: "BULLISH",
                htf_4h_bias: "BULLISH",
                htf_1d_bias: "BULLISH"
            },
            phase,
            finalDecision: "ENTER",
            finalSide: "long",
            rawCandidateSide: tc.candidateSide,
            highwayGateRejected: false,
            highwayGateAllowed: true,
            qualityScore: 78,
            whipsawActive: false,
            crashState: "NONE",
            recoveryAuthority: recovery
        });
        assert.equal(exec.execution_action, "WAIT");
        assert.equal(exec.execution_block_reason, "SHOCK_OPPOSES_RECOVERY_DIRECTION");
        assert.equal(exec.shock_hard_block, true);
    });

    it("shock audit: stale UP_SHOCK + bullish recovery confirmed → LONG_SETUP", () => {
        const recovery = evaluateStructuralRecoveryAuthority({
            whipsawActive: false,
            whipsawSoftWatch: true,
            whipsawReleaseEligible: false,
            higher_low: true,
            higher_high: true,
            lower_low: false,
            lower_high: false,
            upper_breakout_hold: false,
            lower_breakdown_hold: false,
            htfEntryPolicy: "LONG_ONLY_OR_NONE",
            htfBias: { m15: "BULLISH", h1: "BULLISH", h4: "BULLISH", d1: "BULLISH" }
        });
        const phase = resolvePhaseAuthority({
            subtype: "WHIPSAW_SOFT_WATCH",
            trendPhase: "PULLBACK",
            rangePhase: "UPPER",
            transitionPhase: "NONE",
            shockPhase: "UP_SHOCK",
            directionalShockState: "UP",
            whipsawActive: false,
            whipsawSoftWatch: true,
            scoreAuthority: scoreStub(),
            recoveryAuthority: recovery
        });
        assert.equal(phase.shockOverlay, "UP_SHOCK");
        const gate = resolveShockExecutionGate({
            shockOverlay: phase.shockOverlay,
            crashState: "NONE",
            whipsawActive: false,
            recoveryAuthority: recovery,
            candidateSide: "long"
        });
        assert.equal(gate.shock_execution_block, false);
        assert.equal(gate.execution_block_reason, null);

        const exec = resolveExecutionContextAuthority({
            regime: {
                canonicalRegime: "RANGE",
                regimeFinal: "RANGE",
                previousCanonicalRegime: "RANGE",
                regimeDirection: "none",
                regimeChangeRequested: false,
                regimeChangeConfirmed: true,
                regimeChangeReason: null,
                htf_15m_bias: "BULLISH",
                htf_1h_bias: "BULLISH",
                htf_4h_bias: "BULLISH",
                htf_1d_bias: "BULLISH"
            },
            phase,
            finalDecision: "HOLD",
            finalSide: "none",
            rawCandidateSide: "long",
            highwayGateRejected: false,
            highwayGateAllowed: false,
            qualityScore: 75,
            whipsawActive: false,
            crashState: "NONE",
            recoveryAuthority: recovery
        });
        assert.equal(exec.execution_action, "LONG_SETUP");
    });

    it("shock audit: stale DOWN_SHOCK + bearish recovery → SHORT_SETUP", () => {
        const recovery = evaluateStructuralRecoveryAuthority({
            whipsawActive: false,
            whipsawSoftWatch: true,
            whipsawReleaseEligible: false,
            higher_low: false,
            higher_high: false,
            lower_low: true,
            lower_high: true,
            upper_breakout_hold: false,
            lower_breakdown_hold: false,
            htfEntryPolicy: "SHORT_ONLY_OR_NONE",
            htfBias: { m15: "BEARISH", h1: "BEARISH", h4: "BEARISH", d1: "BEARISH" }
        });
        const phase = resolvePhaseAuthority({
            subtype: "WHIPSAW_SOFT_WATCH",
            trendPhase: "DOWN",
            rangePhase: "LOWER",
            transitionPhase: "NONE",
            shockPhase: "DOWN_SHOCK",
            directionalShockState: "DOWN",
            whipsawActive: false,
            whipsawSoftWatch: true,
            scoreAuthority: scoreStub({ higher_low: false, higher_high: false }),
            recoveryAuthority: recovery
        });
        const gate = resolveShockExecutionGate({
            shockOverlay: phase.shockOverlay,
            crashState: "NONE",
            whipsawActive: false,
            recoveryAuthority: recovery,
            candidateSide: "short"
        });
        assert.equal(gate.shock_execution_block, false);
        const exec = resolveExecutionContextAuthority({
            regime: {
                canonicalRegime: "RANGE",
                regimeFinal: "RANGE",
                previousCanonicalRegime: "RANGE",
                regimeDirection: "none",
                regimeChangeRequested: false,
                regimeChangeConfirmed: true,
                regimeChangeReason: null,
                htf_15m_bias: "BEARISH",
                htf_1h_bias: "BEARISH",
                htf_4h_bias: "BEARISH",
                htf_1d_bias: "BEARISH"
            },
            phase,
            finalDecision: "HOLD",
            finalSide: "none",
            rawCandidateSide: "short",
            highwayGateRejected: false,
            highwayGateAllowed: false,
            qualityScore: 75,
            whipsawActive: false,
            crashState: "NONE",
            recoveryAuthority: recovery
        });
        assert.equal(exec.execution_action, "SHORT_SETUP");
    });

    it("shock audit: UP_SHOCK without recovery confirmed → WAIT", () => {
        const gate = resolveShockExecutionGate({
            shockOverlay: "UP_SHOCK",
            crashState: "NONE",
            whipsawActive: false,
            recoveryAuthority: null,
            candidateSide: "long"
        });
        assert.equal(gate.shock_execution_block, true);
        assert.equal(gate.execution_block_reason, "SHOCK_OVERLAY_ACTIVE");
    });
});
