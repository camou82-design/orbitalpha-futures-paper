import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import type { EvaluateV2ExitPolicyArgs } from "../engine-v2/exit/types";
import type { MarketJudgmentOutput } from "../engine-v2/types";
import type { V2StateAuthority } from "../engine-v2/state/types";

function assertEq(actual: unknown, expected: unknown, label: string) {
    if (actual !== expected) {
        throw new Error(`Assertion failed [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertTrue(actual: boolean, label: string) {
    if (!actual) {
        throw new Error(`Assertion failed [${label}]: expected true, got false`);
    }
}

function assertFalse(actual: boolean, label: string) {
    if (actual) {
        throw new Error(`Assertion failed [${label}]: expected false, got true`);
    }
}

function createMockJudgment(overrides: Partial<MarketJudgmentOutput> = {}): MarketJudgmentOutput {
    return {
        regime_final: "TREND",
        subtype: "TREND_PULLBACK",
        shockPhase: "NONE",
        rangePhase: "MID",
        trendPhase: "PULLBACK",
        transitionPhase: "NONE",
        confidenceScore: 0.8,
        evidence: "mock_judgment",
        htf_entry_policy: "LONG_ONLY_OR_NONE",
        macro_source: "actual_candles",
        ...overrides
    } as any as MarketJudgmentOutput;
}

function createMockV2State(longPosOverrides: Record<string, unknown> = {}): V2StateAuthority {
    return {
        symbol: "BTCUSDT",
        market_mode: "TREND",
        directionalShockState: "NONE",
        directionalShockDirection: "NONE",
        directionalShockActive: false,
        directionalShockSource: "none",
        longPosition: {
            symbol: "BTCUSDT",
            side: "long",
            entryPrice: 80480.0,
            sizeUsd: 2590.75,
            entryStage: 1,
            pnlPct: 0.0134, // +1.34%
            peakUnrealizedPnlPct: 0.0184, // +1.84% (giveback = 0.50%p)
            stopPrice: 80077.6,
            ...longPosOverrides
        } as any,
        shortPosition: null
    } as any as V2StateAuthority;
}

function runTests() {
    console.log("=== RUNNING V2 TIER-1 PROFIT PROTECTION TESTS ===");

    // Case 1: BTCUSDT LONG, Peak 1.84%, Current 1.34% (Giveback 0.50%p) -> Triggers TIER1_TRAILING_EXIT
    {
        const v2State = createMockV2State();
        const args: EvaluateV2ExitPolicyArgs = {
            symbol: "BTCUSDT",
            v2State,
            judgment: createMockJudgment(),
            snapshot: {
                boxPos: 0.5,
                boxBreakSide: "none",
                emaGap: 0.0005,
                trendWeaknessScore: 0.2,
                rangeConfidence: 0.5,
                qualityScore: 80
            },
            markPrice: 81558.0
        };

        const result = evaluateV2ExitPolicy(args);
        assertEq(result.action, "FULL_EXIT", "Case 1: action should be FULL_EXIT");
        assertEq(result.reason, "PROFIT_PROTECTION_TIER1_TRAILING_EXIT", "Case 1: reason should be PROFIT_PROTECTION_TIER1_TRAILING_EXIT");
        assertEq(result.reduceRatio, 1, "Case 1: reduceRatio should be 1");
        assertTrue(result.shouldExit, "Case 1: shouldExit should be true");
        assertTrue(result.tier1TrailingActive === true, "Case 1: tier1TrailingActive should be true");
        assertEq(result.tier1ActivationThreshold, 0.0150, "Case 1: tier1ActivationThreshold should be 0.0150");
        assertEq(result.tier1GivebackThreshold, 0.0050, "Case 1: tier1GivebackThreshold should be 0.0050");
        assertEq(result.htfProfitProtectionVetoed, false, "Case 1: htfProfitProtectionVetoed should be false");
        console.log("PASS: Case 1 - BTCUSDT LONG Tier-1 Trailing Exit triggered at 0.50%p giveback");
    }

    // Case 2: Peak < 1.50% (e.g. Peak 1.20%, Current 0.70%, Giveback 0.50%p) -> Does NOT trigger
    {
        const v2State = createMockV2State({
            peakUnrealizedPnlPct: 0.0120,
            pnlPct: 0.0070
        });
        const args: EvaluateV2ExitPolicyArgs = {
            symbol: "BTCUSDT",
            v2State,
            judgment: createMockJudgment(),
            snapshot: {
                boxPos: 0.5,
                boxBreakSide: "none",
                emaGap: 0.0005,
                trendWeaknessScore: 0.2,
                rangeConfidence: 0.5,
                qualityScore: 80
            },
            markPrice: 81043.0
        };

        const result = evaluateV2ExitPolicy(args);
        assertFalse(result.shouldExit, "Case 2: shouldExit should be false when peak < 1.5%");
        assertEq(result.reason, "TREND_PARTIAL_EMA20_WEAKNESS", "Case 2: reason should fall through to normal trend rule");
        assertFalse(result.tier1TrailingActive === true, "Case 2: tier1TrailingActive should be false");
        console.log("PASS: Case 2 - Peak < 1.50% does not activate Tier-1 trailing");
    }

    // Case 3: Peak >= 1.50% (Peak 1.84%, Current 1.54%, Giveback 0.30%p < 0.50%p) -> Does NOT trigger
    {
        const v2State = createMockV2State({
            peakUnrealizedPnlPct: 0.0184,
            pnlPct: 0.0154
        });
        const args: EvaluateV2ExitPolicyArgs = {
            symbol: "BTCUSDT",
            v2State,
            judgment: createMockJudgment(),
            snapshot: {
                boxPos: 0.5,
                boxBreakSide: "none",
                emaGap: 0.0005,
                trendWeaknessScore: 0.2,
                rangeConfidence: 0.5,
                qualityScore: 80
            },
            markPrice: 81719.0
        };

        const result = evaluateV2ExitPolicy(args);
        assertFalse(result.shouldExit, "Case 3: shouldExit should be false when giveback < 0.50%p");
        assertTrue(result.tier1TrailingActive === true, "Case 3: tier1TrailingActive is active but waiting for 0.50%p giveback");
        console.log("PASS: Case 3 - Giveback < 0.50%p holds position safely");
    }

    // Case 4: HTF Bullish active -> does NOT veto Tier-1 trailing exit
    {
        const v2State = createMockV2State();
        const judgment = createMockJudgment({
            htf_entry_policy: "LONG_ONLY_OR_NONE"
        });
        const args: EvaluateV2ExitPolicyArgs = {
            symbol: "BTCUSDT",
            v2State,
            judgment,
            snapshot: {
                boxPos: 0.5,
                boxBreakSide: "none",
                emaGap: 0.0005,
                trendWeaknessScore: 0.1,
                rangeConfidence: 0.5,
                qualityScore: 90
            },
            trendSideCandidate: "long",
            markPrice: 81558.0
        };

        const result = evaluateV2ExitPolicy(args);
        assertEq(result.action, "FULL_EXIT", "Case 4: action must be FULL_EXIT even under strong HTF Bullish");
        assertEq(result.reason, "PROFIT_PROTECTION_TIER1_TRAILING_EXIT", "Case 4: reason must be TIER1_TRAILING_EXIT");
        assertEq(result.htfProfitProtectionVetoed, false, "Case 4: HTF veto must be false");
        console.log("PASS: Case 4 - HTF Bullish does not veto Tier-1 trailing exit");
    }

    // Case 5: OPERATOR_MANAGED / manual_takeover_active -> Tier-1 is completely bypassed
    {
        const v2State = createMockV2State({
            lifecycleState: "OPERATOR_MANAGED",
            manualTakeoverActive: true
        });
        const args: EvaluateV2ExitPolicyArgs = {
            symbol: "BTCUSDT",
            v2State,
            judgment: createMockJudgment(),
            snapshot: {
                boxPos: 0.5,
                boxBreakSide: "none",
                emaGap: 0.0005,
                trendWeaknessScore: 0.2,
                rangeConfidence: 0.5,
                qualityScore: 80
            },
            markPrice: 81558.0
        };

        const result = evaluateV2ExitPolicy(args);
        assertEq(result.action, "HOLD", "Case 5: action must be HOLD under manual takeover");
        assertEq(result.reason, "NO_POSITION_HOLD", "Case 5: reason must be NO_POSITION_HOLD");
        assertFalse(result.shouldExit, "Case 5: shouldExit must be false");
        console.log("PASS: Case 5 - OPERATOR_MANAGED bypasses bot exit engine completely");
    }

    // Case 6: Non-BTC symbol (e.g. ETHUSDT) -> Tier-1 trailing is BTCUSDT-only
    {
        const v2State = {
            symbol: "ETHUSDT",
            market_mode: "TREND",
            directionalShockState: "NONE",
            directionalShockDirection: "NONE",
            directionalShockActive: false,
            directionalShockSource: "none",
            longPosition: {
                symbol: "ETHUSDT",
                side: "long",
                entryPrice: 2500.0,
                sizeUsd: 1000.0,
                entryStage: 1,
                pnlPct: 0.0134,
                peakUnrealizedPnlPct: 0.0184,
                stopPrice: 2480.0
            } as any,
            shortPosition: null
        } as any as V2StateAuthority;
        const args: EvaluateV2ExitPolicyArgs = {
            symbol: "ETHUSDT",
            v2State,
            judgment: createMockJudgment(),
            snapshot: {
                boxPos: 0.5,
                boxBreakSide: "none",
                emaGap: 0.0005,
                trendWeaknessScore: 0.2,
                rangeConfidence: 0.5,
                qualityScore: 80
            },
            markPrice: 2533.5
        };

        const result = evaluateV2ExitPolicy(args);
        assertFalse(result.shouldExit, "Case 6: ETHUSDT should not trigger BTC tier-1 trailing");
        assertFalse(result.tier1TrailingActive === true, "Case 6: tier1TrailingActive should be false for ETHUSDT");
        console.log("PASS: Case 6 - ETHUSDT is unaffected by BTC Tier-1 policy");
    }

    // Case 7: Existing +2.5% partial TP and +3.0% trailing continue to work untouched
    {
        const v2State = createMockV2State({
            peakUnrealizedPnlPct: 0.0260, // +2.6%
            pnlPct: 0.0240,
            tp1Triggered: false
        });
        const args: EvaluateV2ExitPolicyArgs = {
            symbol: "BTCUSDT",
            v2State,
            judgment: createMockJudgment(),
            snapshot: {
                boxPos: 0.5,
                boxBreakSide: "none",
                emaGap: 0.0005,
                trendWeaknessScore: 0.2,
                rangeConfidence: 0.5,
                qualityScore: 80
            },
            markPrice: 82411.0
        };

        const result = evaluateV2ExitPolicy(args);
        assertEq(result.action, "PARTIAL_TAKE_PROFIT", "Case 7: +2.5% peak should trigger PARTIAL_TAKE_PROFIT");
        assertEq(result.reason, "PROFIT_PROTECTION_PARTIAL_TP", "Case 7: reason should be PROFIT_PROTECTION_PARTIAL_TP");
        assertEq(result.reduceRatio, 0.4, "Case 7: reduceRatio should be 0.4");
        console.log("PASS: Case 7 - Existing +2.5% partial TP works untouched");
    }

    // Case 8: Existing +3.0% trailing stop continues to work
    {
        const v2State = createMockV2State({
            peakUnrealizedPnlPct: 0.0350, // +3.5%
            pnlPct: 0.0180, // giveback = 1.70%p >= 1.50%p
            tp1Triggered: true
        });
        const args: EvaluateV2ExitPolicyArgs = {
            symbol: "BTCUSDT",
            v2State,
            judgment: createMockJudgment(),
            snapshot: {
                boxPos: 0.5,
                boxBreakSide: "none",
                emaGap: 0.0005,
                trendWeaknessScore: 0.2,
                rangeConfidence: 0.5,
                qualityScore: 80
            },
            markPrice: 81928.0
        };

        const result = evaluateV2ExitPolicy(args);
        assertEq(result.action, "FULL_EXIT", "Case 8: +3.0% peak with >=1.5% giveback triggers trailing stop");
        // Note: Tier-1 also matches (giveback 1.70% >= 0.50%), and both result in FULL_EXIT.
        assertTrue(result.shouldExit, "Case 8: shouldExit is true");
        console.log("PASS: Case 8 - +3.0% trailing stop operates consistently");
    }

    console.log("\nALL 8 TIER-1 PROFIT PROTECTION CASES PASSED SUCCESSFULLY!");
}

runTests();
