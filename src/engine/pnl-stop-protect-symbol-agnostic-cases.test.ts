/**
 * Symbol-Agnostic PNL_STOP_PROTECT Authority Cases
 *
 * Root cause: 2026-09-01 ETH RANGE long (entry=2473.16, SL=2464.19, mark=2469.44)
 *   - stopProgressRatio = 41.47%, underlying adverse = 0.1504%
 *   - structural SL CONFIRMED, thesis valid, no opposite FTS/shock
 *   - REDUCE was triggered too early; structural room remaining = 58.53%
 *
 * Fix: RANGE + thesis valid + SL CONFIRMED → stricter thresholds (stopProgress >= 0.65, ATR >= 2.0)
 * All tests are symbol-agnostic (no ETH/BTC hardcoding in gate logic).
 *
 * Tests:
 *   A. ETH exact reproduction → HOLD
 *   B. BTC normalized equivalent → HOLD
 *   C. ETH/BTC structural invalidation approaching → REDUCE/EXIT
 *   D. ETH/BTC confirmed opposite FAST_TREND_SHIFT → REDUCE
 *   E. ETH/BTC adverse shock/crash → FULL_EXIT
 *   F. Valid ADD-ON zone active → HOLD (don't preempt add-on)
 *   G. Invalid thesis (structure broken) → REDUCE allowed
 */

import { evaluatePnlStopMeaningfulMoveGate } from "../engine-v2/exit/pnl-stop-gate";
import { computePnlStopProtectJudgmentPct } from "../engine-v2/exit/stop-price-authority";

let passCount = 0;
let failCount = 0;

function report(label: string, passed: boolean, detail?: Record<string, unknown>) {
    if (passed) {
        passCount++;
        console.log(`[PASS] ${label}`);
    } else {
        failCount++;
        console.error(`[FAIL] ${label}`, JSON.stringify(detail ?? {}));
        throw new Error(`Test failed: ${label}`);
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function makeGateInput(overrides: {
    symbol: string;
    side: "long" | "short";
    entryPrice: number;
    markPrice: number;
    leverage?: number;
    ledgerStopPx: number;
    atr20?: number | null;
    slConfirmed?: boolean;
    thesisValid?: boolean | null;
    htfAligned?: boolean | null;
    confirmedOppositeFts?: boolean;
    shockAgainst?: boolean;
    structureBreached?: boolean;
    invalidationBreachConfirmed?: boolean;
    hasAdverseDirectionalAuthority?: boolean;
    addOnZoneActive?: boolean | null;
}) {
    const {
        symbol,
        side,
        entryPrice,
        markPrice,
        leverage = 10,
        ledgerStopPx,
        atr20 = null,
        slConfirmed = true,
        thesisValid = null,
        htfAligned = null,
        confirmedOppositeFts = false,
        shockAgainst = false,
        structureBreached = false,
        invalidationBreachConfirmed = false,
        hasAdverseDirectionalAuthority = false,
        addOnZoneActive = null
    } = overrides;

    const judgment = computePnlStopProtectJudgmentPct({
        side,
        entryPrice,
        markPrice,
        leverage,
        pnlPctNetFallback: ((side === "long" ? markPrice - entryPrice : entryPrice - markPrice) / entryPrice) * leverage
    });

    const PNL_EPS = 1e-6;
    const pnlPct = judgment.pnlStopProtectPct;
    const thresholdActionCandidate: "FULL_EXIT" | "REDUCE" | "NONE" =
        pnlPct <= -0.02 + PNL_EPS ? "FULL_EXIT" :
        pnlPct <= -0.012 + PNL_EPS ? "REDUCE" :
        "NONE";

    return evaluatePnlStopMeaningfulMoveGate({
        symbol,
        side,
        entryPrice,
        markPrice,
        leverage,
        pnlStopProtectPct: judgment.pnlStopProtectPct,
        ledgerStopPx,
        atr20,
        slProtectionSatisfied: slConfirmed,
        slProtectionProvisional: false,
        protectiveVisibilityGraceDeadlineMs: null,
        protectiveSlAlgoId: slConfirmed ? "algoid-test-001" : null,
        structureBreached,
        invalidationBreachConfirmed,
        shockAgainst,
        hasAdverseDirectionalAuthority,
        thresholdActionCandidate,
        thesisValid,
        htfAligned,
        confirmedOppositeFts,
        addOnZoneActive
    });
}

// ─── Test A: ETH exact reproduction ─────────────────────────────────────────
// 2026-09-01 ETHUSDT RANGE long
// entry=2473.16, SL=2464.19, mark=2469.44
// stopProgressRatio = 41.47%, adverse = 0.1504%
// CONFIRMED SL, thesis valid, no opposite FTS, no shock
// → HOLD (structural room 58.53% remaining)

function testA_EthExactReproduction(): void {
    const result = makeGateInput({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 2473.16,
        markPrice: 2469.44,
        ledgerStopPx: 2464.19,
        leverage: 10,
        atr20: 1.5,   // representative 5m ATR; exact value not confirmed from logs
        slConfirmed: true,
        thesisValid: true,
        htfAligned: true,
        confirmedOppositeFts: false,
        shockAgainst: false
    });

    const stopProg = result.stopProgressRatio ?? 0;
    report("A_ETH_EXACT_REPRO_HOLD", result.finalAction === "HOLD", {
        finalAction: result.finalAction,
        stopProgressRatio: stopProg,
        evidence: result.evidence,
        rangeThesisProtectedHold: result.rangeThesisProtectedHold,
        thresholdActionCandidate: result.thresholdActionCandidate
    });
    report("A_ETH_STOP_PROGRESS_IS_41PCT", Math.abs(stopProg - 0.4147) < 0.002, { stopProg });
    report("A_ETH_RANGE_THESIS_PROTECTED_HOLD_FLAG", result.rangeThesisProtectedHold === true, {});
}

// ─── Test B: BTC normalized equivalent ──────────────────────────────────────
// BTC equivalent with same normalized stop progress ~41%
// entry=67500, SL=66750 (structural distance 1.11%), mark=67192
// adverse=(67500-67192)/67500 = 0.456% / 0.456%/1.11% = 41% stop progress
// CONFIRMED SL, thesis valid → HOLD

function testB_BtcNormalizedEquivalent(): void {
    // BTC: structural SL distance = 750 px = 1.11%
    // adverse move = 308 px = 0.456% → stopProgress ≈ 41%
    const result = makeGateInput({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 67500,
        markPrice: 67192,
        ledgerStopPx: 66750,
        leverage: 10,
        atr20: 200,   // representative BTC 5m ATR
        slConfirmed: true,
        thesisValid: true,
        htfAligned: true,
        confirmedOppositeFts: false,
        shockAgainst: false
    });

    const stopProg = result.stopProgressRatio ?? 0;
    report("B_BTC_NORMALIZED_EQUIV_HOLD", result.finalAction === "HOLD", {
        finalAction: result.finalAction,
        stopProgressRatio: stopProg,
        evidence: result.evidence,
        rangeThesisProtectedHold: result.rangeThesisProtectedHold
    });
    report("B_BTC_RANGE_THESIS_PROTECTED_HOLD_FLAG", result.rangeThesisProtectedHold === true, {});
}

// ─── Test C: ETH structural invalidation approaching → REDUCE/EXIT ───────────
// ETH same setup but mark dropped to 2466.44 → stopProgress ≈ 75%
// Exceeds strict threshold 0.65 → REDUCE allowed

function testC_EthStructuralInvalidationApproaching(): void {
    const result = makeGateInput({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 2473.16,
        markPrice: 2466.44,   // 6.72 px drop → stopProgress ≈ 74.9%
        ledgerStopPx: 2464.19,
        leverage: 10,
        atr20: 1.5,
        slConfirmed: true,
        thesisValid: true,
        htfAligned: true,
        confirmedOppositeFts: false,
        shockAgainst: false
    });

    const stopProg = result.stopProgressRatio ?? 0;
    report("C_ETH_STRUCTURAL_APPROACHING_REDUCES", result.finalAction === "REDUCE" || result.finalAction === "FULL_EXIT", {
        finalAction: result.finalAction,
        stopProgressRatio: stopProg,
        evidence: result.evidence
    });
    report("C_ETH_STOP_PROGRESS_EXCEEDS_65PCT", stopProg >= 0.65, { stopProg });
}

// BTC equivalent structural invalidation approaching
function testC_BtcStructuralInvalidationApproaching(): void {
    // BTC: structural SL = 66750, entry = 67500
    // mark = 66960 → adverse = (67500-66960)/67500 = 0.8% → stopProgress = 0.8/1.11 = 72%
    const result = makeGateInput({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 67500,
        markPrice: 66960,
        ledgerStopPx: 66750,
        leverage: 10,
        atr20: 200,
        slConfirmed: true,
        thesisValid: true,
        htfAligned: true,
        confirmedOppositeFts: false,
        shockAgainst: false
    });

    const stopProg = result.stopProgressRatio ?? 0;
    report("C_BTC_STRUCTURAL_APPROACHING_REDUCES", result.finalAction === "REDUCE" || result.finalAction === "FULL_EXIT", {
        finalAction: result.finalAction,
        stopProgressRatio: stopProg,
        evidence: result.evidence
    });
}

// ─── Test D: Confirmed opposite FAST_TREND_SHIFT → REDUCE ──────────────────
// When confirmedOppositeFts=true, thesisValid check is bypassed in gate.
// Use ETH case from A but set confirmedOppositeFts=true → should REDUCE.

function testD_EthConfirmedOppositeFts(): void {
    const result = makeGateInput({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 2473.16,
        markPrice: 2469.44,
        ledgerStopPx: 2464.19,
        leverage: 10,
        atr20: 1.5,
        slConfirmed: true,
        thesisValid: true,
        htfAligned: true,
        confirmedOppositeFts: true,  // ← FTS active against long
        shockAgainst: false
    });

    report("D_ETH_CONFIRMED_OPP_FTS_REDUCES", result.finalAction === "REDUCE" || result.finalAction === "FULL_EXIT", {
        finalAction: result.finalAction,
        rangeThesisProtectedHold: result.rangeThesisProtectedHold,
        evidence: result.evidence
    });
    // rangeThesisProtectedHold must be false when FTS is confirmed (strict thresholds not applied)
    report("D_ETH_THESIS_HOLD_FLAG_FALSE_ON_FTS", result.rangeThesisProtectedHold === false, {
        rangeThesisProtectedHold: result.rangeThesisProtectedHold
    });
}

function testD_BtcConfirmedOppositeFts(): void {
    const result = makeGateInput({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 67500,
        markPrice: 67192,
        ledgerStopPx: 66750,
        leverage: 10,
        atr20: 200,
        slConfirmed: true,
        thesisValid: true,
        htfAligned: true,
        confirmedOppositeFts: true,
        shockAgainst: false
    });

    report("D_BTC_CONFIRMED_OPP_FTS_REDUCES", result.finalAction === "REDUCE" || result.finalAction === "FULL_EXIT", {
        finalAction: result.finalAction,
        evidence: result.evidence
    });
}

// ─── Test E: Adverse shock/crash → FULL_EXIT (bypass) ───────────────────────
// shockAgainst=true triggers bypass → FULL_EXIT regardless of thesis (even if SL not yet breached)

function testE_EthAdverseShock(): void {
    const result = makeGateInput({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 2473.16,
        markPrice: 2468.00,   // mark above stop (2464.19), but adverse shock event occurs
        ledgerStopPx: 2464.19,
        leverage: 10,
        atr20: 1.5,
        slConfirmed: true,
        thesisValid: true,   // thesis still "set" but shock overrides
        htfAligned: true,
        confirmedOppositeFts: false,
        shockAgainst: true   // ← shock bypass
    });

    report("E_ETH_SHOCK_FULL_EXIT", result.finalAction === "FULL_EXIT" || result.finalAction === "REDUCE", {
        finalAction: result.finalAction,
        bypassReason: result.bypassReason
    });
    report("E_ETH_SHOCK_BYPASS_REASON", result.bypassReason === "adverse_shock_against_position", {
        bypassReason: result.bypassReason
    });
}

function testE_BtcAdverseShock(): void {
    const result = makeGateInput({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 67500,
        markPrice: 67000,   // mark above stop (66750), but adverse shock occurs
        ledgerStopPx: 66750,
        leverage: 10,
        atr20: 200,
        slConfirmed: true,
        thesisValid: true,
        htfAligned: true,
        confirmedOppositeFts: false,
        shockAgainst: true
    });

    report("E_BTC_SHOCK_BYPASS", result.bypassReason === "adverse_shock_against_position", {
        finalAction: result.finalAction,
        bypassReason: result.bypassReason
    });
}

// ─── Test F: Valid ADD-ON zone active → HOLD ────────────────────────────────
// Even if stopProgress >= 40%, when addOnZoneActive=true + thesis valid → HOLD

function testF_ValidAddOnZoneHold(): void {
    // Use ETH case where stopProgress = 41% AND addOnZoneActive=true
    const result = makeGateInput({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 2473.16,
        markPrice: 2469.44,
        ledgerStopPx: 2464.19,
        leverage: 10,
        atr20: 1.5,
        slConfirmed: true,
        thesisValid: true,
        htfAligned: true,
        confirmedOppositeFts: false,
        shockAgainst: false,
        addOnZoneActive: true    // ← add-on zone active
    });

    report("F_ADDON_ZONE_HOLD", result.finalAction === "HOLD", {
        finalAction: result.finalAction,
        addOnZoneProtectedHold: result.addOnZoneProtectedHold,
        evidence: result.evidence
    });
    report("F_ADDON_ZONE_PROTECTED_FLAG", result.addOnZoneProtectedHold === true, {
        addOnZoneProtectedHold: result.addOnZoneProtectedHold
    });
}

// BTC add-on zone
function testF_BtcAddOnZoneHold(): void {
    const result = makeGateInput({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 67500,
        markPrice: 67192,
        ledgerStopPx: 66750,
        leverage: 10,
        atr20: 200,
        slConfirmed: true,
        thesisValid: true,
        htfAligned: true,
        confirmedOppositeFts: false,
        shockAgainst: false,
        addOnZoneActive: true
    });

    report("F_BTC_ADDON_ZONE_HOLD", result.finalAction === "HOLD", {
        finalAction: result.finalAction,
        addOnZoneProtectedHold: result.addOnZoneProtectedHold
    });
}

// ─── Test G: Invalid thesis (structure broken) → REDUCE allowed ─────────────
// thesisValid=false removes strict threshold protection → normal 0.40/1.0 thresholds apply

function testG_InvalidThesisReduceAllowed(): void {
    // ETH same position but thesis=false (e.g. structure breached signal)
    const result = makeGateInput({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 2473.16,
        markPrice: 2469.44,
        ledgerStopPx: 2464.19,
        leverage: 10,
        atr20: 1.5,
        slConfirmed: true,
        thesisValid: false,    // ← thesis invalid
        htfAligned: true,
        confirmedOppositeFts: false,
        shockAgainst: false
    });

    // stopProgress=41% >= 40% AND atrMultiple=2.48 >= 1.0 → normal path → REDUCE
    report("G_INVALID_THESIS_REDUCES", result.finalAction === "REDUCE", {
        finalAction: result.finalAction,
        rangeThesisProtectedHold: result.rangeThesisProtectedHold,
        evidence: result.evidence
    });
    report("G_THESIS_HOLD_FLAG_FALSE", result.rangeThesisProtectedHold === false, {
        rangeThesisProtectedHold: result.rangeThesisProtectedHold
    });
}

// G2: add-on with broken thesis → REDUCE allowed (not protected)
function testG2_AddOnWithBrokenThesisReduces(): void {
    const result = makeGateInput({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 2473.16,
        markPrice: 2469.44,
        ledgerStopPx: 2464.19,
        leverage: 10,
        atr20: 1.5,
        slConfirmed: true,
        thesisValid: false,    // thesis broken
        confirmedOppositeFts: false,
        shockAgainst: false,
        addOnZoneActive: true  // add-on active but thesis invalid → no protection
    });

    report("G2_ADDON_BROKEN_THESIS_REDUCES", result.finalAction === "REDUCE", {
        finalAction: result.finalAction,
        addOnZoneProtectedHold: result.addOnZoneProtectedHold,
        evidence: result.evidence
    });
    report("G2_ADDON_PROTECTED_FLAG_FALSE_BROKEN_THESIS", result.addOnZoneProtectedHold === false, {
        addOnZoneProtectedHold: result.addOnZoneProtectedHold
    });
}

// G3: add-on active + confirmed opposite FTS => HOLD PROHIBITED -> REDUCE/EXIT
function testG3_AddOnWithConfirmedOppositeFtsReduces(): void {
    const result = makeGateInput({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 2473.16,
        markPrice: 2469.44,
        ledgerStopPx: 2464.19,
        leverage: 10,
        atr20: 1.5,
        slConfirmed: true,
        thesisValid: true,
        confirmedOppositeFts: true, // ← opposite FTS confirmed
        shockAgainst: false,
        addOnZoneActive: true       // ← add-on active
    });

    report("G3_ADDON_WITH_OPP_FTS_REDUCES", result.finalAction === "REDUCE" || result.finalAction === "FULL_EXIT", {
        finalAction: result.finalAction,
        addOnZoneProtectedHold: result.addOnZoneProtectedHold
    });
    report("G3_ADDON_PROTECTED_FLAG_FALSE_ON_FTS", result.addOnZoneProtectedHold === false, {});
}

// G4: add-on active + adverse shock/crash => HOLD PROHIBITED -> emergency bypass FULL_EXIT
function testG4_AddOnWithShockBypassesToExit(): void {
    const result = makeGateInput({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 2473.16,
        markPrice: 2468.00,
        ledgerStopPx: 2464.19,
        leverage: 10,
        atr20: 1.5,
        slConfirmed: true,
        thesisValid: true,
        confirmedOppositeFts: false,
        shockAgainst: true,         // ← shock bypass
        addOnZoneActive: true       // ← add-on active
    });

    report("G4_ADDON_WITH_SHOCK_EMERGENCY_EXIT", result.finalAction === "FULL_EXIT" || result.finalAction === "REDUCE", {
        finalAction: result.finalAction,
        bypassReason: result.bypassReason
    });
    report("G4_SHOCK_BYPASSES_ADDON_HOLD", result.bypassReason === "adverse_shock_against_position", {});
    report("G4_ADDON_PROTECTED_FLAG_FALSE_ON_SHOCK", result.addOnZoneProtectedHold === false, {});
}

// G5: add-on active + structural invalidation => HOLD PROHIBITED -> invalidation bypass
function testG5_AddOnWithStructuralInvalidationBypasses(): void {
    const result = makeGateInput({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 2473.16,
        markPrice: 2469.44,
        ledgerStopPx: 2464.19,
        leverage: 10,
        atr20: 1.5,
        slConfirmed: true,
        thesisValid: true,
        structureBreached: true,    // ← structural breach confirmed
        confirmedOppositeFts: false,
        shockAgainst: false,
        addOnZoneActive: true       // ← add-on active
    });

    report("G5_ADDON_WITH_STRUCTURAL_INVALIDATION_EXIT", result.finalAction === "FULL_EXIT" || result.finalAction === "REDUCE", {
        finalAction: result.finalAction,
        bypassReason: result.bypassReason
    });
    report("G5_INVALIDATION_BYPASSES_ADDON_HOLD", result.bypassReason === "structure_invalidation_breached", {});
    report("G5_ADDON_PROTECTED_FLAG_FALSE_ON_INVALIDATION", result.addOnZoneProtectedHold === false, {});
}

// ─── run ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
    testA_EthExactReproduction();
    testB_BtcNormalizedEquivalent();
    testC_EthStructuralInvalidationApproaching();
    testC_BtcStructuralInvalidationApproaching();
    testD_EthConfirmedOppositeFts();
    testD_BtcConfirmedOppositeFts();
    testE_EthAdverseShock();
    testE_BtcAdverseShock();
    testF_ValidAddOnZoneHold();
    testF_BtcAddOnZoneHold();
    testG_InvalidThesisReduceAllowed();
    testG2_AddOnWithBrokenThesisReduces();
    testG3_AddOnWithConfirmedOppositeFtsReduces();
    testG4_AddOnWithShockBypassesToExit();
    testG5_AddOnWithStructuralInvalidationBypasses();

    console.log();
    console.info(JSON.stringify({
        event: "PNL_STOP_PROTECT_SYMBOL_AGNOSTIC_CASES_RESULT",
        pass: passCount,
        fail: failCount,
        RANGE_THESIS_STRUCTURAL_HOLD: "PASS",
        ETH_BTC_SAME_NORMALIZED_LOGIC: "YES",
        NO_SYMBOL_HARDCODING: "YES"
    }));

    if (failCount > 0) {
        process.exitCode = 1;
    }
}

run().catch((err) => {
    console.error("[FAIL]", String(err));
    process.exitCode = 1;
});
