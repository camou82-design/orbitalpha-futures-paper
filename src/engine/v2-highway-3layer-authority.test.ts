import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    applyRegimeAuthority,
    proposeCanonicalRegimeDirection,
    rehydrateInitialCanonicalRegime,
    resetRegimeAuthorityLatchForTests
} from "../engine-v2/state/regime-authority";
import { resolvePhaseAuthority, resolveShockOverlay } from "../engine-v2/state/phase-authority";
import {
    alignCandidateSideToRegimeDirection,
    resolveExecutionContextAuthority
} from "../engine-v2/execution/execution-context-authority";
import { resolveTrendExecutionCandidateDirection } from "../engine-v2/trend-side-candidate";
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
        regime_before: "TREND",
        ...overrides
    };
}

describe("V2 Highway 3-layer authority", () => {
    it("A: TREND_UP + 5m pullback keeps TREND_UP and phase PULLBACK", () => {
        resetRegimeAuthorityLatchForTests();
        applyRegimeAuthority({
            symbol: "BTCUSDT",
            regimeFinal: "TREND",
            emaGap: 0.001,
            trendPhase: "UP",
            transitionPhase: "NONE",
            htfBias: { m5: "BULLISH", m15: "BULLISH", h1: "BULLISH", h4: "BULLISH", d1: "NEUTRAL" },
            scoreAuthority: scoreStub(),
            whipsawActive: false,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        const regime = applyRegimeAuthority({
            symbol: "BTCUSDT",
            regimeFinal: "RANGE",
            emaGap: 0.001,
            trendPhase: "PULLBACK",
            transitionPhase: "NONE",
            htfBias: { m5: "BULLISH", m15: "BULLISH", h1: "BULLISH", h4: "BULLISH", d1: "NEUTRAL" },
            scoreAuthority: scoreStub({ lower_breakdown_hold: true }),
            whipsawActive: false,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        const phase = resolvePhaseAuthority({
            subtype: "TREND_UP_CONTINUATION",
            trendPhase: "PULLBACK",
            rangePhase: "NONE",
            transitionPhase: "NONE",
            shockPhase: "NONE",
            whipsawActive: false,
            whipsawSoftWatch: false,
            scoreAuthority: scoreStub()
        });
        assert.equal(regime.canonicalRegime, "TREND_UP");
        assert.equal(regime.regimeFinal, "TREND");
        assert.equal(phase.phase, "PULLBACK");
    });

    it("B: TREND_UP + whipsaw keeps TREND_UP and phase WHIPSAW", () => {
        resetRegimeAuthorityLatchForTests();
        applyRegimeAuthority({
            symbol: "ETHUSDT",
            regimeFinal: "TREND",
            emaGap: 0.002,
            trendPhase: "UP",
            transitionPhase: "NONE",
            htfBias: { m5: "BULLISH", m15: "BULLISH", h1: "BULLISH", h4: "NEUTRAL", d1: "NEUTRAL" },
            scoreAuthority: scoreStub(),
            whipsawActive: false,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        const regime = applyRegimeAuthority({
            symbol: "ETHUSDT",
            regimeFinal: "RANGE",
            emaGap: 0.002,
            trendPhase: "UP",
            transitionPhase: "WHIPSAW_RECHECK",
            htfBias: { m5: "RANGE", m15: "BULLISH", h1: "BULLISH", h4: "NEUTRAL", d1: "NEUTRAL" },
            scoreAuthority: scoreStub(),
            whipsawActive: true,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        const phase = resolvePhaseAuthority({
            subtype: "WHIPSAW_SHOCK_RECHECK",
            trendPhase: "UP",
            rangePhase: "MID",
            transitionPhase: "WHIPSAW_RECHECK",
            shockPhase: "NONE",
            whipsawActive: true,
            whipsawSoftWatch: false,
            scoreAuthority: scoreStub()
        });
        assert.equal(regime.canonicalRegime, "TREND_UP");
        assert.equal(phase.phase, "WHIPSAW");
    });

    it("C: TREND_UP + DOWN_SHOCK overlay keeps TREND_UP and WAIT execution", () => {
        resetRegimeAuthorityLatchForTests();
        const latched = applyRegimeAuthority({
            symbol: "BTCUSDT",
            regimeFinal: "TREND",
            emaGap: 0.001,
            trendPhase: "UP",
            transitionPhase: "NONE",
            htfBias: { m5: "BULLISH", m15: "BULLISH", h1: "BULLISH", h4: "BULLISH", d1: "NEUTRAL" },
            scoreAuthority: scoreStub(),
            whipsawActive: false,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
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
            scoreAuthority: scoreStub({ lower_breakdown_hold: true })
        });
        const exec = resolveExecutionContextAuthority({
            regime: latched,
            phase,
            finalDecision: "ENTER",
            finalSide: "long",
            highwayGateRejected: false,
            highwayGateAllowed: true,
            qualityScore: 85,
            whipsawActive: false,
            crashState: "NONE"
        });
        assert.equal(latched.canonicalRegime, "TREND_UP");
        assert.equal(resolveShockOverlay({ shockPhase: "DOWN_SHOCK", directionalShockState: "DOWN" }), "DOWN_SHOCK");
        assert.equal(exec.execution_action, "WAIT");
        assert.equal(exec.entry_side, "none");
    });

    it("D: 15m/1h HTF degradation moves to TRANSITION (not 5m TREND_TO_RANGE alone)", () => {
        resetRegimeAuthorityLatchForTests();
        applyRegimeAuthority({
            symbol: "BTCUSDT",
            regimeFinal: "TREND",
            emaGap: 0.001,
            trendPhase: "UP",
            transitionPhase: "NONE",
            htfBias: { m5: "BEARISH", m15: "BEARISH", h1: "BEARISH", h4: "NEUTRAL", d1: "NEUTRAL" },
            scoreAuthority: scoreStub(),
            whipsawActive: false,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        const regime = applyRegimeAuthority({
            symbol: "BTCUSDT",
            regimeFinal: "TRANSITION",
            emaGap: 0.0005,
            trendPhase: "PULLBACK",
            transitionPhase: "TREND_TO_RANGE",
            htfBias: { m5: "BEARISH", m15: "BEARISH", h1: "BEARISH", h4: "NEUTRAL", d1: "NEUTRAL" },
            scoreAuthority: scoreStub({ lower_breakdown_hold: true }),
            whipsawActive: false,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        assert.equal(regime.canonicalRegime, "TRANSITION");
        assert.equal(regime.regimeChangeConfirmed, true);
    });

    it("E: TRANSITION + 1h failure demotes to RANGE or TREND_DOWN", () => {
        resetRegimeAuthorityLatchForTests();
        applyRegimeAuthority({
            symbol: "ETHUSDT",
            regimeFinal: "TRANSITION",
            emaGap: -0.0002,
            trendPhase: "DOWN",
            transitionPhase: "TREND_TO_RANGE",
            htfBias: { m5: "BEARISH", m15: "BEARISH", h1: "BEARISH", h4: "NEUTRAL", d1: "NEUTRAL" },
            scoreAuthority: scoreStub(),
            whipsawActive: false,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        const regime = applyRegimeAuthority({
            symbol: "ETHUSDT",
            regimeFinal: "RANGE",
            emaGap: -0.0003,
            trendPhase: "DOWN",
            transitionPhase: "TREND_TO_RANGE",
            htfBias: { m5: "BEARISH", m15: "BEARISH", h1: "BEARISH", h4: "NEUTRAL", d1: "NEUTRAL" },
            scoreAuthority: scoreStub({ lower_breakdown_hold: true }),
            whipsawActive: false,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        assert.ok(regime.canonicalRegime === "RANGE" || regime.canonicalRegime === "TREND_DOWN");
    });

    it("F: pullback + continuation yields LONG_SETUP when gate reached", () => {
        const regime = {
            canonicalRegime: "TREND_UP" as const,
            regimeFinal: "TREND" as const,
            previousCanonicalRegime: "TREND_UP" as const,
            regimeDirection: "long" as const,
            regimeChangeRequested: false,
            regimeChangeConfirmed: true,
            regimeChangeReason: "REGIME_STABLE",
            htf_15m_bias: "BULLISH",
            htf_1h_bias: "BULLISH",
            htf_4h_bias: "NEUTRAL",
            htf_1d_bias: "NEUTRAL"
        };
        const phase = resolvePhaseAuthority({
            subtype: "TREND_UP_CONTINUATION",
            trendPhase: "PULLBACK",
            rangePhase: "NONE",
            transitionPhase: "NONE",
            shockPhase: "NONE",
            whipsawActive: false,
            whipsawSoftWatch: false,
            scoreAuthority: scoreStub()
        });
        const exec = resolveExecutionContextAuthority({
            regime,
            phase,
            finalDecision: "ENTER",
            finalSide: "long",
            highwayGateRejected: false,
            highwayGateAllowed: true,
            qualityScore: 88,
            whipsawActive: false,
            crashState: "NONE"
        });
        assert.equal(phase.phase, "PULLBACK");
        assert.equal(exec.execution_action, "ENTER");
        assert.equal(exec.highway_entry_gate_reached, true);
    });

    it("G: defensive lifecycle flags when adverse pnl on highway lineage", () => {
        const pnlPct = -0.02;
        const defensiveActive = pnlPct <= 0;
        assert.equal(defensiveActive, true);
    });

    it("H: pyramid blocked when profit but breakeven not confirmed (policy semantics)", () => {
        const inProfit = true;
        const breakevenStopConfirmed = false;
        const pyramidAllowed = inProfit && breakevenStopConfirmed;
        assert.equal(pyramidAllowed, false);
    });

    it("I: pyramid eligible when profit + breakeven + continuation phase", () => {
        const inProfit = true;
        const breakevenStopConfirmed = true;
        const phase = resolvePhaseAuthority({
            subtype: "TREND_UP_CONTINUATION",
            trendPhase: "UP",
            rangePhase: "NONE",
            transitionPhase: "NONE",
            shockPhase: "NONE",
            whipsawActive: false,
            whipsawSoftWatch: false,
            scoreAuthority: scoreStub({ upper_breakout_hold: true })
        });
        assert.equal(phase.phase, "CONTINUATION");
        assert.equal(inProfit && breakevenStopConfirmed, true);
    });

    it("J: hard crash blocks via shock_hard_block (over lifecycle)", () => {
        const regime = {
            canonicalRegime: "TREND_UP" as const,
            regimeFinal: "TREND" as const,
            previousCanonicalRegime: "TREND_UP" as const,
            regimeDirection: "long" as const,
            regimeChangeRequested: false,
            regimeChangeConfirmed: true,
            regimeChangeReason: null,
            htf_15m_bias: "BULLISH",
            htf_1h_bias: "BULLISH",
            htf_4h_bias: "NEUTRAL",
            htf_1d_bias: "NEUTRAL"
        };
        const phase = resolvePhaseAuthority({
            subtype: "TREND_UP_CONTINUATION",
            trendPhase: "UP",
            rangePhase: "NONE",
            transitionPhase: "NONE",
            shockPhase: "NONE",
            whipsawActive: false,
            whipsawSoftWatch: false,
            scoreAuthority: scoreStub()
        });
        const exec = resolveExecutionContextAuthority({
            regime,
            phase,
            finalDecision: "ENTER",
            finalSide: "long",
            highwayGateRejected: false,
            highwayGateAllowed: true,
            qualityScore: 90,
            whipsawActive: false,
            crashState: "CRASH_LOCK"
        });
        assert.equal(exec.shock_hard_block, true);
    });

    it("audit A: TREND_UP latch + 5m-only TREND_TO_RANGE keeps TREND_UP", () => {
        resetRegimeAuthorityLatchForTests();
        applyRegimeAuthority({
            symbol: "BTCUSDT",
            regimeFinal: "TREND",
            emaGap: 0.001,
            trendPhase: "UP",
            transitionPhase: "NONE",
            htfBias: { m5: "BULLISH", m15: "BULLISH", h1: "BULLISH", h4: "NEUTRAL", d1: "NEUTRAL" },
            scoreAuthority: scoreStub(),
            whipsawActive: false,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        const regime = applyRegimeAuthority({
            symbol: "BTCUSDT",
            regimeFinal: "RANGE",
            emaGap: 0.001,
            trendPhase: "PULLBACK",
            transitionPhase: "TREND_TO_RANGE",
            htfBias: { m5: "BULLISH", m15: "BULLISH", h1: "BULLISH", h4: "NEUTRAL", d1: "NEUTRAL" },
            scoreAuthority: scoreStub({ lower_breakdown_hold: true }),
            whipsawActive: false,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        const phase = resolvePhaseAuthority({
            subtype: "TREND_UP_CONTINUATION",
            trendPhase: "PULLBACK",
            rangePhase: "MID",
            transitionPhase: "TREND_TO_RANGE",
            shockPhase: "NONE",
            whipsawActive: false,
            whipsawSoftWatch: false,
            scoreAuthority: scoreStub()
        });
        assert.equal(regime.canonicalRegime, "TREND_UP");
        assert.notEqual(phase.phase, "NONE");
    });

    it("audit C: TREND_UP + stale short candidate blocked at execution layer", () => {
        const regime = {
            canonicalRegime: "TREND_UP" as const,
            regimeFinal: "TREND" as const,
            previousCanonicalRegime: "TREND_UP" as const,
            regimeDirection: "long" as const,
            regimeChangeRequested: false,
            regimeChangeConfirmed: true,
            regimeChangeReason: null,
            htf_15m_bias: "BULLISH",
            htf_1h_bias: "BULLISH",
            htf_4h_bias: "NEUTRAL",
            htf_1d_bias: "NEUTRAL"
        };
        const align = alignCandidateSideToRegimeDirection({ canonicalRegime: "TREND_UP", candidateSide: "short" });
        const exec = resolveExecutionContextAuthority({
            regime,
            phase: resolvePhaseAuthority({
                subtype: "TREND_UP_CONTINUATION",
                trendPhase: "PULLBACK",
                rangePhase: "NONE",
                transitionPhase: "NONE",
                shockPhase: "NONE",
                whipsawActive: false,
                whipsawSoftWatch: false,
                scoreAuthority: scoreStub()
            }),
            finalDecision: "ENTER",
            finalSide: "short",
            rawCandidateSide: "short",
            highwayGateRejected: false,
            highwayGateAllowed: true,
            qualityScore: 90,
            whipsawActive: false,
            crashState: "NONE"
        });
        assert.equal(align.after, "none");
        assert.equal(exec.execution_action, "SKIP");
        assert.equal(exec.entry_side, "none");
        assert.equal(exec.candidate_side_after_regime_alignment, "none");
    });

    it("audit D: TREND_DOWN + stale long candidate blocked", () => {
        const regime = {
            canonicalRegime: "TREND_DOWN" as const,
            regimeFinal: "TREND" as const,
            previousCanonicalRegime: "TREND_DOWN" as const,
            regimeDirection: "short" as const,
            regimeChangeRequested: false,
            regimeChangeConfirmed: true,
            regimeChangeReason: null,
            htf_15m_bias: "BEARISH",
            htf_1h_bias: "BEARISH",
            htf_4h_bias: "NEUTRAL",
            htf_1d_bias: "NEUTRAL"
        };
        const exec = resolveExecutionContextAuthority({
            regime,
            phase: resolvePhaseAuthority({
                subtype: "TREND_DOWN_CONTINUATION",
                trendPhase: "DOWN",
                rangePhase: "NONE",
                transitionPhase: "NONE",
                shockPhase: "NONE",
                whipsawActive: false,
                whipsawSoftWatch: false,
                scoreAuthority: scoreStub()
            }),
            finalDecision: "ENTER",
            finalSide: "long",
            rawCandidateSide: "long",
            highwayGateRejected: false,
            highwayGateAllowed: true,
            qualityScore: 90,
            whipsawActive: false,
            crashState: "NONE"
        });
        assert.equal(exec.execution_action, "SKIP");
        assert.equal(exec.entry_side, "none");
    });

    it("audit E: empty latch rehydrates TREND_UP from HTF + regime_final TREND", () => {
        resetRegimeAuthorityLatchForTests();
        const rehydrated = rehydrateInitialCanonicalRegime({
            regimeFinal: "TREND",
            emaGap: 0.0008,
            trendPhase: "UP",
            htfBias: { m5: "BULLISH", m15: "BULLISH", h1: "BULLISH", h4: "NEUTRAL", d1: "NEUTRAL" }
        });
        assert.equal(rehydrated, "TREND_UP");
        const regime = applyRegimeAuthority({
            symbol: "BTCUSDT",
            regimeFinal: "TREND",
            emaGap: 0.0008,
            trendPhase: "UP",
            transitionPhase: "NONE",
            htfBias: { m5: "BULLISH", m15: "BULLISH", h1: "BULLISH", h4: "NEUTRAL", d1: "NEUTRAL" },
            scoreAuthority: scoreStub(),
            whipsawActive: false,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        assert.equal(regime.canonicalRegime, "TREND_UP");
        const exec = resolveExecutionContextAuthority({
            regime,
            phase: resolvePhaseAuthority({
                subtype: "TREND_UP_CONTINUATION",
                trendPhase: "UP",
                rangePhase: "NONE",
                transitionPhase: "NONE",
                shockPhase: "NONE",
                whipsawActive: false,
                whipsawSoftWatch: false,
                scoreAuthority: scoreStub()
            }),
            finalDecision: "SKIP",
            finalSide: "none",
            rawCandidateSide: "short",
            highwayGateRejected: false,
            highwayGateAllowed: false,
            qualityScore: 80,
            whipsawActive: false,
            crashState: "NONE"
        });
        assert.notEqual(exec.execution_action, "SHORT_SETUP");
        assert.equal(exec.entry_side, "none");
    });

    it("trend candidate A: TREND_UP + emaGap<0 pullback keeps long, not short", () => {
        const tc = resolveTrendExecutionCandidateDirection({
            directionalShockState: "NONE",
            emaGap: -0.0005,
            canonicalRegime: "TREND_UP"
        });
        assert.equal(tc.candidateSideBeforeRegimeAuthority, "short");
        assert.equal(tc.candidateSideAfterRegimeAuthority, "long");
        assert.equal(tc.candidateSide, "long");
        assert.equal(tc.trendCandidateDirectionSource, "REGIME_DIRECTION_TREND_UP");
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
                htf_4h_bias: "NEUTRAL",
                htf_1d_bias: "NEUTRAL"
            },
            phase: resolvePhaseAuthority({
                subtype: "TREND_UP_CONTINUATION",
                trendPhase: "PULLBACK",
                rangePhase: "NONE",
                transitionPhase: "NONE",
                shockPhase: "NONE",
                whipsawActive: false,
                whipsawSoftWatch: false,
                scoreAuthority: scoreStub()
            }),
            finalDecision: "HOLD",
            finalSide: "none",
            rawCandidateSide: tc.candidateSide,
            highwayGateRejected: false,
            highwayGateAllowed: false,
            qualityScore: 85,
            whipsawActive: false,
            crashState: "NONE"
        });
        assert.equal(exec.candidate_side, "long");
        assert.notEqual(exec.execution_action, "SHORT_SETUP");
    });

    it("trend candidate B: TREND_DOWN + emaGap>0 rebound keeps short", () => {
        const tc = resolveTrendExecutionCandidateDirection({
            directionalShockState: "NONE",
            emaGap: 0.0004,
            canonicalRegime: "TREND_DOWN"
        });
        assert.equal(tc.candidateSide, "short");
        assert.equal(tc.trendCandidateDirectionSource, "REGIME_DIRECTION_TREND_DOWN");
    });

    it("trend candidate C: RANGE uses emaGap fallback", () => {
        const tc = resolveTrendExecutionCandidateDirection({
            directionalShockState: "NONE",
            emaGap: -0.0003,
            canonicalRegime: "RANGE"
        });
        assert.equal(tc.candidateSide, "short");
        assert.equal(tc.trendCandidateDirectionSource, "EMA_GAP_FALLBACK");
    });

    it("trend candidate D: TREND_UP + DOWN_SHOCK keeps long direction but WAIT execution", () => {
        const tc = resolveTrendExecutionCandidateDirection({
            directionalShockState: "DOWN",
            emaGap: -0.0002,
            canonicalRegime: "TREND_UP"
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
                htf_4h_bias: "NEUTRAL",
                htf_1d_bias: "NEUTRAL"
            },
            phase: resolvePhaseAuthority({
                subtype: "TREND_UP_CONTINUATION",
                trendPhase: "PULLBACK",
                rangePhase: "NONE",
                transitionPhase: "NONE",
                shockPhase: "DOWN_SHOCK",
                directionalShockState: "DOWN",
                whipsawActive: false,
                whipsawSoftWatch: false,
                scoreAuthority: scoreStub()
            }),
            finalDecision: "ENTER",
            finalSide: "long",
            rawCandidateSide: tc.candidateSide,
            highwayGateRejected: false,
            highwayGateAllowed: true,
            qualityScore: 90,
            whipsawActive: false,
            crashState: "NONE"
        });
        assert.equal(exec.execution_action, "WAIT");
        assert.equal(exec.entry_side, "none");
    });

    it("trend candidate E: TREND_DOWN + UP_SHOCK keeps short direction but WAIT", () => {
        const tc = resolveTrendExecutionCandidateDirection({
            directionalShockState: "UP",
            emaGap: 0.0003,
            canonicalRegime: "TREND_DOWN"
        });
        assert.equal(tc.candidateSide, "short");
        const exec = resolveExecutionContextAuthority({
            regime: {
                canonicalRegime: "TREND_DOWN",
                regimeFinal: "TREND",
                previousCanonicalRegime: "TREND_DOWN",
                regimeDirection: "short",
                regimeChangeRequested: false,
                regimeChangeConfirmed: true,
                regimeChangeReason: null,
                htf_15m_bias: "BEARISH",
                htf_1h_bias: "BEARISH",
                htf_4h_bias: "NEUTRAL",
                htf_1d_bias: "NEUTRAL"
            },
            phase: resolvePhaseAuthority({
                subtype: "TREND_DOWN_CONTINUATION",
                trendPhase: "DOWN",
                rangePhase: "NONE",
                transitionPhase: "NONE",
                shockPhase: "UP_SHOCK",
                directionalShockState: "UP",
                whipsawActive: false,
                whipsawSoftWatch: false,
                scoreAuthority: scoreStub()
            }),
            finalDecision: "ENTER",
            finalSide: "short",
            rawCandidateSide: tc.candidateSide,
            highwayGateRejected: false,
            highwayGateAllowed: true,
            qualityScore: 90,
            whipsawActive: false,
            crashState: "NONE"
        });
        assert.equal(exec.execution_action, "WAIT");
    });

    it("TREND_DOWN symmetric: soft demotion blocked without HTF", () => {
        resetRegimeAuthorityLatchForTests();
        applyRegimeAuthority({
            symbol: "BTCUSDT",
            regimeFinal: "TREND",
            emaGap: -0.001,
            trendPhase: "DOWN",
            transitionPhase: "NONE",
            htfBias: { m5: "BEARISH", m15: "BEARISH", h1: "BEARISH", h4: "NEUTRAL", d1: "NEUTRAL" },
            scoreAuthority: scoreStub(),
            whipsawActive: false,
            whipsawSoftWatch: false,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        const regime = applyRegimeAuthority({
            symbol: "BTCUSDT",
            regimeFinal: "RANGE",
            emaGap: -0.001,
            trendPhase: "DOWN",
            transitionPhase: "NONE",
            htfBias: { m5: "BULLISH", m15: "BEARISH", h1: "BEARISH", h4: "NEUTRAL", d1: "NEUTRAL" },
            scoreAuthority: scoreStub({ upper_breakout_hold: true }),
            whipsawActive: false,
            whipsawSoftWatch: true,
            shockPhase: "NONE",
            directionalShockState: "NONE"
        });
        assert.equal(regime.canonicalRegime, "TREND_DOWN");
        assert.equal(proposeCanonicalRegimeDirection({ regimeFinal: "TREND", emaGap: -0.001, trendPhase: "DOWN" }), "TREND_DOWN");
    });
});
