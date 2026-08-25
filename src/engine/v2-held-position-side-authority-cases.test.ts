/**
 * V2 held-position vs candidate-intent side authority separation.
 *
 * Regression: ETH adopted LONG + negative emaGap must keep held=long, candidate=short,
 * state authority same-side flags aligned with held position (not intent-as-position).
 */

import { evaluateV2AddOnPolicy } from "../engine-v2/addon/policy";
import { deriveV2StateAuthority } from "../engine-v2/state/derive";
import type { EngineV2Input, MarketJudgmentOutput } from "../engine-v2/types";

function assertEq<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertTrue(value: boolean, label: string): void {
    if (!value) throw new Error(`[FAIL] ${label}: expected true`);
}

function assertFalse(value: boolean, label: string): void {
    if (value) throw new Error(`[FAIL] ${label}: expected false`);
}

function pass(label: string, detail?: Record<string, unknown>): void {
    console.info(JSON.stringify({ status: "PASS", label, ...(detail !== undefined ? { detail } : {}) }));
}

function baseJudgment(overrides: Partial<MarketJudgmentOutput> = {}): MarketJudgmentOutput {
    return {
        regime: "TREND",
        regime_final: "TREND",
        subtype: "TREND_UP",
        confidenceScore: 0.8,
        shockPhase: "NONE",
        trendPhase: "UP",
        rangePhase: "NONE",
        transitionPhase: "RANGE_TO_TREND",
        htf_bias: { m5: "NEUTRAL", m15: "NEUTRAL", h1: "NEUTRAL", h4: "NEUTRAL", d1: "NEUTRAL" },
        htf_entry_policy: "ALLOW_ALL",
        macroPolarity: "NEUTRAL",
        polarityMismatch: false,
        subtypeReason: "test",
        ...overrides
    } as MarketJudgmentOutput;
}

function ethLongHeldInput(overrides: Partial<EngineV2Input["state"]> = {}): EngineV2Input {
    return {
        symbol: "ETHUSDT",
        now: Date.now(),
        candles: [],
        v1Result: null,
        snapshot: {
            symbol: "ETHUSDT",
            lastPrice: 2499.0,
            emaGap: -0.002,
            signal: "paper_short_candidate",
            qualityScore: 75,
            boxPos: 0.5,
            trendWeaknessScore: 0.3,
            rangeConfidence: 0.5,
            reviewing_ticks: 2,
            latestCandleClose: 2499.0
        },
        state: {
            currentPositions: [
                {
                    symbol: "ETHUSDT",
                    side: "long",
                    entryPrice: 2499.25,
                    sizeUsd: 75,
                    entryStage: 1,
                    pnlPct: -0.012,
                    leverage: 10
                }
            ],
            okxActualSide: "long",
            directionalShockState: "NONE",
            serverTradeEnabled: true,
            paperExecutionReady: true,
            signedExecutionReady: true,
            longAllow: true,
            shortAllow: true,
            ...overrides
        },
        config: {
            okxLiveMaxOrderNotionalUsdt: 100
        }
    } as unknown as EngineV2Input;
}

function testEthAdoptedLongNegativeEmaGap(): void {
    const input = ethLongHeldInput();
    const v2State = deriveV2StateAuthority(input);

    assertEq(v2State.heldPositionSide, "long", "ETH held_position_side");
    assertEq(v2State.managementSide, "long", "ETH management_side");
    assertEq(v2State.candidateIntentSide, "short", "ETH candidate_intent_side");
    assertEq(v2State.inferredIntentSide, "short", "ETH inferredIntentSide alias");
    assertTrue(v2State.hasLongPosition, "ETH hasLongPosition");
    assertEq(v2State.sameSidePosition?.side, "long", "ETH sameSidePosition is long ledger");
    assertTrue(v2State.hasSameSidePosition, "ETH hasSameSidePosition (held long)");
    assertFalse(v2State.hasOppositeSidePosition, "ETH hasOppositeSidePosition (no short held)");
    assertTrue(v2State.hasOppositeToCandidate, "ETH hasOppositeToCandidate diagnostic");
    assertEq(v2State.currentStage, 1, "ETH currentStage from held long");

    pass("ETH_ADOPTED_LONG_NEGATIVE_EMA_GAP_HELD_AUTHORITY", {
        held: v2State.heldPositionSide,
        candidate: v2State.candidateIntentSide,
        hasOppositeToCandidate: v2State.hasOppositeToCandidate
    });
}

function testAddonPolicySameSideWhenExecutionSideLong(): void {
    const input = ethLongHeldInput();
    const v2State = deriveV2StateAuthority(input);
    const judgment = baseJudgment();

    const addOnPolicy = evaluateV2AddOnPolicy({
        symbol: "ETHUSDT",
        side: "long",
        v2State,
        judgment,
        execution: {
            signal: "LONG_CANDIDATE",
            side: "long",
            reason: "test",
            baseSizeIntent: 0,
            recheckSuggested: false,
            isAddOnEligible: true,
            stopPrice: null,
            invalidationPx: null,
            metadata: {}
        },
        snapshot: {
            qualityScore: 75,
            reviewing_ticks: 2,
            boxPos: 0.5,
            emaGap: -0.002,
            trendWeaknessScore: 0.3,
            rangeConfidence: 0.5,
            lastPrice: 2499.0,
            atr: 5,
            latestCandleTs: Date.now()
        }
    });

    assertEq(addOnPolicy.side, "long", "addon side");
    assertTrue(addOnPolicy.isAddOn, "addon isAddOn");
    assertTrue(addOnPolicy.hasSameSidePosition, "addon hasSameSidePosition");
    assertFalse(addOnPolicy.hasOppositeSidePosition, "addon hasOppositeSidePosition");

    pass("ADDON_EXECUTION_SIDE_LONG_SAME_SIDE_HELD_LONG", {
        action: addOnPolicy.action,
        reason: addOnPolicy.reason
    });
}

function testBtcOkxActualSidePreserved(): void {
    const input = {
        symbol: "BTCUSDT",
        now: Date.now(),
        candles: [],
        v1Result: null,
        snapshot: {
            symbol: "BTCUSDT",
            lastPrice: 65000,
            emaGap: -0.003,
            signal: "paper_short_candidate",
            qualityScore: 80,
            latestCandleClose: 65000
        },
        state: {
            currentPositions: [
                {
                    symbol: "BTCUSDT",
                    side: "long",
                    entryPrice: 64900,
                    sizeUsd: 100,
                    entryStage: 1,
                    pnlPct: 0.01,
                    leverage: 10
                }
            ],
            okxActualSide: "long",
            directionalShockState: "NONE",
            serverTradeEnabled: true,
            paperExecutionReady: true,
            signedExecutionReady: true
        },
        config: {}
    } as unknown as EngineV2Input;

    const v2State = deriveV2StateAuthority(input);

    assertEq(v2State.heldPositionSide, "long", "BTC held from okxActualSide");
    assertEq(v2State.candidateIntentSide, "long", "BTC candidate from okxActualSide (BTC inferIntentSide)");
    assertTrue(v2State.hasSameSidePosition, "BTC hasSameSidePosition");
    assertFalse(v2State.hasOppositeToCandidate, "BTC held aligns with candidate");

    pass("BTC_OKX_ACTUAL_SIDE_BEHAVIOR_PRESERVED");
}

function testNoHeldPositionCandidateOnly(): void {
    const input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        candles: [],
        v1Result: null,
        snapshot: {
            symbol: "ETHUSDT",
            lastPrice: 2500,
            emaGap: -0.002,
            signal: "none",
            qualityScore: 70,
            latestCandleClose: 2500
        },
        state: {
            currentPositions: [],
            directionalShockState: "NONE",
            serverTradeEnabled: true,
            paperExecutionReady: true,
            signedExecutionReady: true
        },
        config: {}
    } as unknown as EngineV2Input;

    const v2State = deriveV2StateAuthority(input);

    assertEq(v2State.heldPositionSide, "none", "no held side");
    assertEq(v2State.candidateIntentSide, "short", "candidate from emaGap");
    assertFalse(v2State.hasSameSidePosition, "no same-side held");
    assertFalse(v2State.hasOppositeSidePosition, "no opposite held");
    assertFalse(v2State.hasOppositeToCandidate, "no held → no opposite-to-candidate");

    pass("NO_HELD_POSITION_CANDIDATE_ONLY");
}

function main(): void {
    testEthAdoptedLongNegativeEmaGap();
    testAddonPolicySameSideWhenExecutionSideLong();
    testBtcOkxActualSidePreserved();
    testNoHeldPositionCandidateOnly();
    console.info(JSON.stringify({ status: "ALL_PASS", suite: "v2-held-position-side-authority-cases" }));
}

main();
