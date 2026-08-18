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
    shockPhase?: "NONE" | "DOWN_SHOCK" | "UP_SHOCK";
    directionalShockState?: "NONE" | "DOWN" | "UP";
    trendWeaknessScore?: number;
    trendPhase?: string;
    slProtectionSatisfied?: boolean;
    protectiveSlAlgoId?: string | null;
} = {}): EvaluateV2ExitPolicyArgs {
    const side = overrides.side ?? "long";
    const entryPrice = overrides.entryPrice ?? 1906.17;
    const markPrice = overrides.markPrice ?? 1905.00;
    return {
        symbol: "ETHUSDT",
        v2State: {
            symbol: "ETHUSDT",
            directionalShockState: overrides.directionalShockState ?? "NONE",
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
                    slProtectionSatisfied: overrides.slProtectionSatisfied ?? true,
                    slProtectionProvisional: false,
                    protectiveSlAlgoId: overrides.protectiveSlAlgoId === undefined
                        ? "algo_sl_exit_churn_test"
                        : overrides.protectiveSlAlgoId,
                    peakUnrealizedPnlPct: 0,
                    structureBreached: overrides.structureBreached === true,
                    lastReduceReason: overrides.lastReduceReason
                } as any
            ]
        } as any,
        judgment: {
            regime_final: overrides.regime ?? "TREND",
            subtype: "TREND_MOMENTUM_HEALTHY",
            shockPhase: overrides.shockPhase ?? "NONE",
            rangePhase: "MID",
            trendPhase: overrides.trendPhase ?? "UP",
            transitionPhase: overrides.transitionPhase ?? "NONE",
            confidence: 0.8
        } as any,
        snapshot: {
            boxPos: 0.5,
            boxBreakSide: "none",
            emaGap: side === "long" ? 0.001 : -0.001,
            trendWeaknessScore: overrides.trendWeaknessScore ?? 0.2,
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
}

// Review C1: directional state cannot upgrade a ~0.06% raw invalidation into terminal exit.
function testTinyDirectionalShockPlusInvalidationMustHold(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        entryPrice: 1906.17,
        markPrice: 1905.00,
        structureBreached: true,
        invalidationBreachConfirmed: true,
        directionalShockState: "DOWN"
    }));
    assertEq(res.action, "HOLD", "micro raw invalidation + directional state must HOLD");
    assertTrue(!res.shouldExit, "directional state alone cannot be terminal confirmation");
}

// Review C2/C3: even a current adverse shock may not mutate a position inside measured micro-noise.
function testTinyAdverseShockMustWatchNotExit(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        entryPrice: 1906.17,
        markPrice: 1905.00,
        shockPhase: "DOWN_SHOCK",
        directionalShockState: "DOWN"
    }));
    assertEq(res.action, "WATCH", "measured ~0.06% adverse shock must WATCH");
    assertTrue(!res.shouldExit && !res.shouldReduce, "micro shock cannot close or reduce");
}

function testConfirmedStructuralBreakStillNeedsMeaningfulMove(): void {
    const micro = evaluateV2ExitPolicy(baseArgs({
        entryPrice: 1906.17,
        markPrice: 1905.00,
        structureBreached: true,
        invalidationBreachConfirmed: true,
        structuralBreakConfirmed: true
    }));
    assertEq(micro.action, "HOLD", "confirmed structural metadata inside micro-noise must HOLD");

    const meaningful = evaluateV2ExitPolicy(baseArgs({
        entryPrice: 1906.17,
        markPrice: 1902.90, // ~0.1715% adverse
        structureBreached: true,
        invalidationBreachConfirmed: true,
        structuralBreakConfirmed: true
    }));
    assertEq(meaningful.action, "FULL_EXIT", "confirmed structural break + meaningful move may exit");
    assertEq(meaningful.reason, "V2_EXIT_INVALIDATION", "confirmed structural break reason");
}

// Avoid an exact 40.0000% floating point boundary: this fixture is deliberately >40% stop progress.
function testPnlProtectAbsoluteNoiseFloor(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        entryPrice: 1900,
        markPrice: 1897.72, // -0.12% underlying; 10x => -1.2%
        ledgerStopPx: 1894.50, // stop distance 5.50; progress ~41.45%
        atr20: 2.0
    }));
    assertEq(res.pnlStopGateResult?.finalAction, "REDUCE", "inner PNL gate fixture must request REDUCE");
    assertEq(res.action, "HOLD", "0.12% underlying move must be blocked by absolute noise floor");
    assertTrue(res.evidence.includes("pnl_stop_absolute_noise_floor_hold"), "absolute noise floor proof present");
}

function testFirstMeaningfulPnlReduceIsSmaller(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        entryPrice: 1900,
        markPrice: 1896.58, // -0.18% underlying
        ledgerStopPx: 1891.45,
        atr20: 3.0
    }));
    assertEq(res.action, "REDUCE", "first meaningful PNL protection may reduce");
    assertEq(res.reason, "PNL_STOP_PROTECT", "first meaningful reduce reason");
    assertEq(res.reduceRatio, 0.25, "PNL protective reduce must be 25%, not 40%");
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
}

function testTransitionMicroLossCannotTrim(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        regime: "TRANSITION",
        transitionPhase: "CONFLICT",
        entryPrice: 1906.17,
        markPrice: 1905.00,
        pnlPct: -0.001
    }));
    assertEq(res.action, "WATCH", "transition conflict inside micro adverse move must WATCH");
    assertTrue(!res.shouldReduce, "transition micro loss cannot trim");
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
}

// Review C4: an underwater trend weakness signal may not stack a second trim after PNL protection.
function testTrendWeaknessCannotStackAfterDefensiveReduce(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        regime: "TREND",
        trendWeaknessScore: 0.56,
        pnlPct: -0.005,
        entryPrice: 1900,
        markPrice: 1896.5,
        lastReduceReason: "PNL_STOP_PROTECT"
    }));
    assertEq(res.action, "WATCH", "underwater trend weakness after defensive trim must WATCH");
    assertTrue(!res.shouldPartial && !res.shouldReduce, "trend weakness cannot stack another trim while underwater");
    assertTrue(res.evidence.includes("trend_reduce_after_defensive_trim_suppressed"), "trend stack suppression proof present");
}

function testActualCommittedStopStillFullExits(): void {
    const res = evaluateV2ExitPolicy(baseArgs({
        entryPrice: 1900,
        markPrice: 1889.9,
        ledgerStopPx: 1890,
        shockPhase: "NONE"
    }));
    assertEq(res.action, "FULL_EXIT", "actual committed stop breach must remain FULL_EXIT");
    assertEq(res.reason, "PNL_STOP_PROTECT", "actual stop authority reason preserved");
}

function runAll(): void {
    console.info("=== RUNNING BLOCKER 4-20 EXIT CHURN REGRESSIONS ===");
    testTinyRawInvalidationMustHold();
    testTinyDirectionalShockPlusInvalidationMustHold();
    testTinyAdverseShockMustWatchNotExit();
    testConfirmedStructuralBreakStillNeedsMeaningfulMove();
    testPnlProtectAbsoluteNoiseFloor();
    testFirstMeaningfulPnlReduceIsSmaller();
    testSecondDefensivePnlReduceMustHold();
    testTransitionMicroLossCannotTrim();
    testTransitionConflictCannotStackAnotherDefensiveReduce();
    testTrendWeaknessCannotStackAfterDefensiveReduce();
    testActualCommittedStopStillFullExits();
    console.info("=== ALL BLOCKER 4-20 EXIT CHURN REGRESSIONS PASSED ===");
}

runAll();
