import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import type { EvaluateV2ExitPolicyArgs } from "../engine-v2/exit/types";

function assertEq<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertTrue(value: boolean, label: string): void {
    if (!value) throw new Error(`[FAIL] ${label}: expected true`);
}

function baseArgs(overrides: {
    side?: "long" | "short";
    entryPrice?: number;
    markPrice?: number;
    ledgerStopPx?: number;
    atr20?: number;
    pnlPct?: number;
    structureBreached?: boolean;
    invalidationBreachConfirmed?: boolean;
    structuralBreakConfirmed?: boolean;
    boxBreakConfirmed?: boolean;
    reversalConfirmed?: boolean;
    lastReduceReason?: string;
    regime?: "TREND" | "RANGE" | "TRANSITION";
    transitionPhase?: string;
} = {}): EvaluateV2ExitPolicyArgs {
    const side = overrides.side ?? "long";
    const entryPrice = overrides.entryPrice ?? 1906.17;
    const markPrice = overrides.markPrice ?? 1905.00;
    return {
        symbol: "ETHUSDT",
        v2State: {
            symbol: "ETHUSDT",
            directionalShockState: "NONE",
            symbolPositions: [
                {
                    symbol: "ETHUSDT",
                    side: side.toUpperCase(),
                    entryPrice,
                    sizeUsd: 100,
                    entryStage: 1,
                    pnlPct: overrides.pnlPct ?? 0,
                    leverage: 10,
                    ledger_stop_px: overrides.ledgerStopPx ?? 1898,
                    slProtectionSatisfied: true,
                    slProtectionProvisional: false,
                    protectiveSlAlgoId: "algo_sl_exit_churn_test",
                    peakUnrealizedPnlPct: 0,
                    structureBreached: overrides.structureBreached === true,
                    lastReduceReason: overrides.lastReduceReason
                } as any
            ]
        } as any,
        judgment: {
            regime_final: overrides.regime ?? "TREND",
            subtype: "TREND_MOMENTUM_HEALTHY",
            shockPhase: "NONE",
            rangePhase: "MID",
            trendPhase: "UP",
            transitionPhase: overrides.transitionPhase ?? "NONE",
            confidence: 0.8
        } as any,
        snapshot: {
            boxPos: 0.5,
            boxBreakSide: "none",
            emaGap: side === "long" ? 0.001 : -0.001,
            trendWeaknessScore: 0.2,
            rangeConfidence: 0.7,
            qualityScore: 80,
            atr20: overrides.atr20 ?? 6
        },
        markPrice,
        invalidationBreachConfirmed: overrides.invalidationBreachConfirmed,
        structuralBreakConfirmed: overrides.structuralBreakConfirmed,
        boxBreakConfirmed: overrides.boxBreakConfirmed,
        reversalConfirmed: overrides.reversalConfirmed
    };
}

// Live regression: 2026-08-18 05:51 ETH LONG had only ~0.061% MAE yet ended in V2_EXIT_INVALIDATION.
function testTinyRawInvalidationMustHold(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        entryPrice: 1906.17,
        markPrice: 1905.00,
        ledgerStopPx: 1898,
        atr20: 6,
        structureBreached: true,
        invalidationBreachConfirmed: true
    }));
    assertEq(res.action, "HOLD", "tiny raw invalidation without independent confirmation must HOLD");
    assertTrue(res.evidence.includes("invalidation_noise_suppressed_wait_confirmation"), "noise suppression proof present");
    console.info(JSON.stringify({ status: "PASS", label: "TINY_RAW_INVALIDATION_HOLD" }));
}

function testConfirmedStructuralBreakCanExit(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        entryPrice: 1906.17,
        markPrice: 1905.00,
        structureBreached: true,
        invalidationBreachConfirmed: true,
        structuralBreakConfirmed: true
    }));
    assertEq(res.action, "FULL_EXIT", "independently confirmed structural break may full exit");
    assertEq(res.reason, "V2_EXIT_INVALIDATION", "confirmed structural break reason");
    console.info(JSON.stringify({ status: "PASS", label: "CONFIRMED_STRUCTURAL_BREAK_EXIT" }));
}

// Force the inner PNL gate to see >=1 ATR and >=40% stop progress, but keep the absolute move at only 0.12%.
function testPnlProtectAbsoluteNoiseFloor(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        entryPrice: 1900,
        markPrice: 1897.72, // -0.12% underlying; 10x => -1.2% PNL threshold
        ledgerStopPx: 1894.30, // 0.30% stop distance => 40% progress
        atr20: 2.0
    }));
    assertEq(res.pnlStopGateResult?.finalAction, "REDUCE", "inner PNL gate fixture must request REDUCE");
    assertEq(res.action, "HOLD", "0.12% underlying move must be blocked by absolute noise floor");
    assertTrue(res.evidence.includes("pnl_stop_absolute_noise_floor_hold"), "absolute noise floor proof present");
    console.info(JSON.stringify({ status: "PASS", label: "PNL_PROTECT_ABSOLUTE_NOISE_FLOOR" }));
}

function testFirstMeaningfulPnlReduceIsSmaller(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        entryPrice: 1900,
        markPrice: 1896.58, // -0.18% underlying; 10x => -1.8%
        ledgerStopPx: 1891.45, // 0.45% stop distance => 40% progress
        atr20: 3.0
    }));
    assertEq(res.action, "REDUCE", "first meaningful PNL protection may reduce");
    assertEq(res.reason, "PNL_STOP_PROTECT", "first meaningful reduce reason");
    assertEq(res.reduceRatio, 0.25, "PNL protective reduce must be 25%, not 40%");
    console.info(JSON.stringify({ status: "PASS", label: "FIRST_PNL_REDUCE_25PCT" }));
}

function testSecondDefensivePnlReduceMustHold(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        entryPrice: 1900,
        markPrice: 1896.58,
        ledgerStopPx: 1891.45,
        atr20: 3.0,
        lastReduceReason: "PNL_STOP_PROTECT"
    }));
    assertEq(res.action, "HOLD", "second defensive PNL reduce must HOLD");
    assertTrue(res.evidence.includes("repeat_defensive_reduce_suppressed"), "repeat defensive reduce proof present");
    console.info(JSON.stringify({ status: "PASS", label: "SECOND_DEFENSIVE_REDUCE_HOLD" }));
}

function testTransitionConflictCannotStackAnotherDefensiveReduce(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        regime: "TRANSITION",
        transitionPhase: "CONFLICT",
        lastReduceReason: "PNL_STOP_PROTECT",
        entryPrice: 1900,
        markPrice: 1900,
        ledgerStopPx: 1880,
        atr20: 5
    }));
    assertEq(res.action, "WATCH", "transition conflict after prior defensive reduce must WATCH");
    assertEq(res.reason, "TRANSITION_PROTECTIVE_WATCH", "transition repeat reduction downgraded to watch");
    console.info(JSON.stringify({ status: "PASS", label: "TRANSITION_REPEAT_REDUCE_WATCH" }));
}

function runAll(): void {
    console.info("=== RUNNING BLOCKER 4-20 EXIT CHURN REGRESSIONS ===");
    testTinyRawInvalidationMustHold();
    testConfirmedStructuralBreakCanExit();
    testPnlProtectAbsoluteNoiseFloor();
    testFirstMeaningfulPnlReduceIsSmaller();
    testSecondDefensivePnlReduceMustHold();
    testTransitionConflictCannotStackAnotherDefensiveReduce();
    console.info("=== ALL BLOCKER 4-20 EXIT CHURN REGRESSIONS PASSED ===");
}

runAll();
