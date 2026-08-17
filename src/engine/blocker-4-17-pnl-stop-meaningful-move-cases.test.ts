import {
    evaluatePnlStopMeaningfulMoveGate,
    buildPnlStopMeaningfulMoveGateProof,
    type PnlStopMeaningfulMoveGateInput,
    type PnlStopMeaningfulMoveGateResult
} from "../engine-v2/exit/pnl-stop-gate";
import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import type { EvaluateV2ExitPolicyArgs } from "../engine-v2/exit/types";
import type { MarketJudgmentOutput } from "../engine-v2/types/index";

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

function createBaseJudgment(): MarketJudgmentOutput {
    return {
        regime_final: "TREND",
        subtype: "TREND_MOMENTUM_HEALTHY",
        shockPhase: "NONE",
        rangePhase: "NONE",
        trendPhase: "UP",
        transitionPhase: "NONE",
        confidence: 0.85
    } as any;
}

/**
 * FIXED PRODUCTION FIXTURE 1: Live ETH Incident (Tight 0.26% stop distance)
 * entryPrice = 1904.81, ledgerStopPx = 1899.857494, leverage = 10, atr20 = 6.0
 */
function testLiveEthIncident_CaseA_Minus012_Hold(): void {
    // Underlying adverse = 0.12% ($2.2858 move -> mark 1902.5242)
    // Leveraged PnL = -1.20% (threshold hit)
    // stopProgressRatio = 2.2858 / 4.9525 = 46.15%
    // BUT adverseMoveAtrMultiple = 2.2858 / 6.0 = 0.381 ATR (< 1.0 noise floor)
    // EXPECTED: Structure intact + ATR noise inside -> HOLD (REDUCE strictly forbidden!)
    const res = evaluatePnlStopMeaningfulMoveGate({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 1904.81,
        markPrice: 1902.5242,
        leverage: 10,
        pnlStopProtectPct: -0.012,
        ledgerStopPx: 1899.857494,
        atr20: 6.0,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "REDUCE"
    });

    assertEq(res.finalAction, "HOLD", "Live ETH Case A: finalAction MUST be HOLD");
    assertFalse(res.meaningfulMovePassed, "Live ETH Case A: meaningfulMovePassed MUST be false");
    assertEq(res.reduceRatio, 0, "Live ETH Case A: reduceRatio is 0");
    console.info(JSON.stringify({ status: "PASS", label: "LIVE_ETH_CASE_A_MINUS_012_HOLD" }));
}

function testLiveEthIncident_CaseB_Minus020_Hold(): void {
    // Underlying adverse = 0.20% ($3.8096 move -> mark 1901.0004)
    // Leveraged PnL = -2.00% (threshold hit)
    // stopProgressRatio = 3.8096 / 4.9525 = 76.92%
    // BUT adverseMoveAtrMultiple = 3.8096 / 6.0 = 0.635 ATR (< 1.0 noise floor)
    // Actual stop not breached (1901.0004 > 1899.857494) & exchange SL is authoritatively confirmed
    // EXPECTED: Structure intact + committed stop not breached -> HOLD (premature FULL_EXIT strictly forbidden!)
    const res = evaluatePnlStopMeaningfulMoveGate({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 1904.81,
        markPrice: 1901.0004,
        leverage: 10,
        pnlStopProtectPct: -0.020,
        ledgerStopPx: 1899.857494,
        atr20: 6.0,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "FULL_EXIT"
    });

    assertEq(res.finalAction, "HOLD", "Live ETH Case B: finalAction MUST be HOLD");
    assertFalse(res.meaningfulMovePassed, "Live ETH Case B: meaningfulMovePassed MUST be false");
    assertEq(res.reduceRatio, 0, "Live ETH Case B: reduceRatio is 0");
    console.info(JSON.stringify({ status: "PASS", label: "LIVE_ETH_CASE_B_MINUS_020_HOLD" }));
}

function testLiveEthIncident_CaseC_AtrSweep(): void {
    // 0.5 ATR (adverse move $3.00 -> mark 1901.81, leveraged pnl = -1.57%)
    const res05Atr = evaluatePnlStopMeaningfulMoveGate({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 1904.81,
        markPrice: 1901.81,
        leverage: 10,
        pnlStopProtectPct: -0.0157,
        ledgerStopPx: 1899.857494,
        atr20: 6.0,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "REDUCE"
    });
    assertEq(res05Atr.finalAction, "HOLD", "Live ETH 0.5 ATR must be HOLD");

    // Just before stop: mark 1900.00 ($4.81 move = 0.80 ATR, stopProgress = 97.1%, unbreached)
    const resBeforeStop = evaluatePnlStopMeaningfulMoveGate({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 1904.81,
        markPrice: 1900.00,
        leverage: 10,
        pnlStopProtectPct: -0.0252,
        ledgerStopPx: 1899.857494,
        atr20: 6.0,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "FULL_EXIT"
    });
    assertEq(resBeforeStop.finalAction, "HOLD", "Live ETH just before stop must be HOLD (let exchange stop trigger)");

    // Actual stop breach: mark 1899.85 <= 1899.857494
    const resStopBreach = evaluatePnlStopMeaningfulMoveGate({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 1904.81,
        markPrice: 1899.85,
        leverage: 10,
        pnlStopProtectPct: -0.0260,
        ledgerStopPx: 1899.857494,
        atr20: 6.0,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "FULL_EXIT"
    });
    assertEq(resStopBreach.finalAction, "FULL_EXIT", "Live ETH actual stop breach yields FULL_EXIT");
    assertEq(resStopBreach.bypassReason, "committed_stop_breached", "Live ETH stop breach bypass matches");
    console.info(JSON.stringify({ status: "PASS", label: "LIVE_ETH_CASE_C_ATR_SWEEP" }));
}

/**
 * BLOCKER 4-17 3-STATE AUTHORITY SEMANTICS REGRESSION SUITE:
 * CASE A: submit accepted, pending scan 미확인, inside visibility grace, provisional=true, pnlStop=-2%
 * EXPECT: PROVISIONAL_PROTECTED -> HOLD (premature FULL_EXIT prevented during valid grace)
 */
function testAuthoritySemantics_CaseA_ProvisionalGrace_Hold(): void {
    const res = evaluatePnlStopMeaningfulMoveGate({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 1904.81,
        markPrice: 1901.00, // -0.20% move, leveraged -2.0%, unbreached
        leverage: 10,
        pnlStopProtectPct: -0.020,
        ledgerStopPx: 1899.857494,
        atr20: 6.0,
        slProtectionSatisfied: true,
        slProtectionProvisional: true, // Inside visibility grace!
        protectiveVisibilityGraceDeadlineMs: Date.now() + 5000,
        thresholdActionCandidate: "FULL_EXIT"
    });

    assertFalse(res.exchangeSlAuthoritativelyConfirmed, "Case A: exchangeSlAuthoritativelyConfirmed is false");
    assertTrue(res.slProtectionProvisional, "Case A: slProtectionProvisional is true");
    assertEq(res.exchangeProtectionState, "PROVISIONAL_PROTECTED", "Case A: state is PROVISIONAL_PROTECTED");
    assertEq(res.finalAction, "HOLD", "Case A: provisional grace MUST HOLD ahead of actual stop");
    assertFalse(res.meaningfulMovePassed, "Case A: meaningfulMovePassed is false");
    console.info(JSON.stringify({ status: "PASS", label: "AUTHORITY_SEMANTICS_CASE_A_PROVISIONAL_GRACE_HOLD" }));
}

/**
 * CASE A (BREACHED VARIANT):
 * Inside visibility grace, but actual committed stop is breached
 * EXPECT: FULL_EXIT immediately via committed_stop_breached bypass
 */
function testAuthoritySemantics_CaseA_ProvisionalGrace_StopBreached_FullExit(): void {
    const res = evaluatePnlStopMeaningfulMoveGate({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 1904.81,
        markPrice: 1899.80, // Actual stop breached!
        leverage: 10,
        pnlStopProtectPct: -0.0263,
        ledgerStopPx: 1899.857494,
        atr20: 6.0,
        slProtectionSatisfied: true,
        slProtectionProvisional: true, // Inside visibility grace
        protectiveVisibilityGraceDeadlineMs: Date.now() + 5000,
        thresholdActionCandidate: "FULL_EXIT"
    });

    assertEq(res.finalAction, "FULL_EXIT", "Case A Breach: actual stop breach MUST immediately FULL_EXIT");
    assertEq(res.bypassReason, "committed_stop_breached", "Case A Breach: bypass reason matches");
    console.info(JSON.stringify({ status: "PASS", label: "AUTHORITY_SEMANTICS_CASE_A_STOP_BREACHED_FULL_EXIT" }));
}

/**
 * CASE B: pending authoritative scan에서 SL 실제 확인, provisional=false, pnlStop=-2%, actual stop 미도달
 * EXPECT: CONFIRMED -> HOLD
 */
function testAuthoritySemantics_CaseB_ConfirmedScan_Hold(): void {
    const res = evaluatePnlStopMeaningfulMoveGate({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 1904.81,
        markPrice: 1901.00, // -0.20% move, leveraged -2.0%
        leverage: 10,
        pnlStopProtectPct: -0.020,
        ledgerStopPx: 1899.857494,
        atr20: 6.0,
        slProtectionSatisfied: true,
        slProtectionProvisional: false, // Confirmed on OKX inventory!
        protectiveVisibilityGraceDeadlineMs: null,
        thresholdActionCandidate: "FULL_EXIT"
    });

    assertTrue(res.exchangeSlAuthoritativelyConfirmed, "Case B: exchangeSlAuthoritativelyConfirmed is true");
    assertFalse(res.slProtectionProvisional, "Case B: slProtectionProvisional is false");
    assertEq(res.exchangeProtectionState, "CONFIRMED", "Case B: state is CONFIRMED");
    assertEq(res.finalAction, "HOLD", "Case B: confirmed scan MUST HOLD at -2% ahead of actual stop");
    assertFalse(res.meaningfulMovePassed, "Case B: meaningfulMovePassed is false");
    console.info(JSON.stringify({ status: "PASS", label: "AUTHORITY_SEMANTICS_CASE_B_CONFIRMED_SCAN_HOLD" }));
}

/**
 * CASE C: grace 만료 후 SL 미확인, provisional=false, slProtectionSatisfied=false, pnlStop=-2%
 * EXPECT: UNPROTECTED -> FULL_EXIT (existing capital protection maintained)
 */
function testAuthoritySemantics_CaseC_GraceExpiredUnconfirmed_FullExit(): void {
    const res = evaluatePnlStopMeaningfulMoveGate({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 1904.81,
        markPrice: 1901.00,
        leverage: 10,
        pnlStopProtectPct: -0.020,
        ledgerStopPx: 1899.857494,
        atr20: 6.0,
        slProtectionSatisfied: false, // Unconfirmed!
        slProtectionProvisional: false,
        protectiveVisibilityGraceDeadlineMs: Date.now() - 1000, // Grace expired
        thresholdActionCandidate: "FULL_EXIT"
    });

    assertFalse(res.exchangeSlAuthoritativelyConfirmed, "Case C: exchangeSlAuthoritativelyConfirmed is false");
    assertEq(res.exchangeProtectionState, "UNPROTECTED", "Case C: state is UNPROTECTED");
    assertEq(res.finalAction, "FULL_EXIT", "Case C: grace expired unconfirmed MUST FULL_EXIT");
    assertTrue(res.meaningfulMovePassed, "Case C: meaningfulMovePassed is true");
    console.info(JSON.stringify({ status: "PASS", label: "AUTHORITY_SEMANTICS_CASE_C_GRACE_EXPIRED_FULL_EXIT" }));
}

/**
 * CONTEXT 1 REGRESSIONS:
 * Confirmed exchange SL + valid ledger stop + atr20 missing
 */
function testContext1_ConfirmedSl_MissingAtr_Minus012_Hold(): void {
    const res = evaluatePnlStopMeaningfulMoveGate({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        markPrice: 94886,
        leverage: 10,
        pnlStopProtectPct: -0.012,
        ledgerStopPx: 93860,
        atr20: null, // missing ATR
        slProtectionSatisfied: true, // confirmed exchange SL
        slProtectionProvisional: false,
        thresholdActionCandidate: "REDUCE"
    });

    assertEq(res.finalAction, "HOLD", "Context 1: confirmed SL + valid stop + missing ATR at -0.12% MUST be HOLD");
    assertFalse(res.meaningfulMovePassed, "meaningfulMovePassed is false");
    console.info(JSON.stringify({ status: "PASS", label: "CONTEXT1_CONFIRMED_SL_MISSING_ATR_MINUS_012_HOLD" }));
}

function testContext1_ConfirmedSl_MissingAtr_Minus020_Hold(): void {
    const res = evaluatePnlStopMeaningfulMoveGate({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        markPrice: 94810,
        leverage: 10,
        pnlStopProtectPct: -0.020,
        ledgerStopPx: 93860,
        atr20: null, // missing ATR
        slProtectionSatisfied: true, // confirmed exchange SL
        slProtectionProvisional: false,
        thresholdActionCandidate: "FULL_EXIT"
    });

    assertEq(res.finalAction, "HOLD", "Context 1: confirmed SL + valid stop + missing ATR at -2.0% MUST be HOLD");
    assertFalse(res.meaningfulMovePassed, "meaningfulMovePassed is false");
    console.info(JSON.stringify({ status: "PASS", label: "CONTEXT1_CONFIRMED_SL_MISSING_ATR_MINUS_020_HOLD" }));
}

/**
 * FIXED PRODUCTION FIXTURE 2: BTC Wider Stop Setup (1.20% stop distance)
 * entryPrice = 95000, ledgerStopPx = 93860, leverage = 10, atr20 = 250
 */
function testLiveBtcSetup_Sweep(): void {
    // 1. -0.12% move ($114 move -> mark 94886, 0.456 ATR, 10% stop progress)
    const res012 = evaluatePnlStopMeaningfulMoveGate({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        markPrice: 94886,
        leverage: 10,
        pnlStopProtectPct: -0.012,
        ledgerStopPx: 93860,
        atr20: 250,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "REDUCE"
    });
    assertEq(res012.finalAction, "HOLD", "BTC -0.12% move must be HOLD");

    // 2. -0.20% move ($190 move -> mark 94810, 0.76 ATR, 16.6% stop progress)
    const res020 = evaluatePnlStopMeaningfulMoveGate({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        markPrice: 94810,
        leverage: 10,
        pnlStopProtectPct: -0.020,
        ledgerStopPx: 93860,
        atr20: 250,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "FULL_EXIT"
    });
    assertEq(res020.finalAction, "HOLD", "BTC -0.20% move must be HOLD");

    // 3. 0.5 ATR move ($125 move -> mark 94875)
    const res05Atr = evaluatePnlStopMeaningfulMoveGate({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        markPrice: 94875,
        leverage: 10,
        pnlStopProtectPct: -0.0131,
        ledgerStopPx: 93860,
        atr20: 250,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "REDUCE"
    });
    assertEq(res05Atr.finalAction, "HOLD", "BTC 0.5 ATR must be HOLD");

    // 4. 1.0 ATR move ($250 move -> mark 94750, stopProgress = 250 / 1140 = 21.9% < 40%)
    const res10Atr = evaluatePnlStopMeaningfulMoveGate({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        markPrice: 94750,
        leverage: 10,
        pnlStopProtectPct: -0.0263,
        ledgerStopPx: 93860,
        atr20: 250,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "FULL_EXIT"
    });
    assertEq(res10Atr.finalAction, "HOLD", "BTC 1.0 ATR with only 21.9% stop progress stays HOLD");

    // 5. Meaningful move (ATR >= 1.0 AND stopProgress >= 40%):
    // adverse move = $480 -> mark 94520, adverseAtr = 480 / 250 = 1.92 ATR, stopProgress = 480 / 1140 = 42.1%
    const resMeaningful = evaluatePnlStopMeaningfulMoveGate({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        markPrice: 94520,
        leverage: 10,
        pnlStopProtectPct: -0.0505,
        ledgerStopPx: 93860,
        atr20: 250,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "FULL_EXIT"
    });
    assertEq(resMeaningful.finalAction, "REDUCE", "BTC meaningful move (1.92 ATR & 42.1% stop progress) yields REDUCE 40%");
    assertEq(resMeaningful.reduceRatio, 0.4, "BTC meaningful move reduceRatio is 0.4");

    // 6. Actual Stop Breach: mark 93850 <= 93860
    const resBreach = evaluatePnlStopMeaningfulMoveGate({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        markPrice: 93850,
        leverage: 10,
        pnlStopProtectPct: -0.121,
        ledgerStopPx: 93860,
        atr20: 250,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "FULL_EXIT"
    });
    assertEq(resBreach.finalAction, "FULL_EXIT", "BTC stop breach yields FULL_EXIT");
    assertEq(resBreach.bypassReason, "committed_stop_breached", "BTC stop breach bypass reason matched");
    console.info(JSON.stringify({ status: "PASS", label: "LIVE_BTC_SETUP_SWEEP" }));
}

function testEmergencyBypasses(): void {
    // Structure breach bypass
    const resStruct = evaluatePnlStopMeaningfulMoveGate({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        markPrice: 94900,
        leverage: 10,
        pnlStopProtectPct: -0.010,
        ledgerStopPx: 93860,
        atr20: 250,
        structureBreached: true,
        thresholdActionCandidate: "FULL_EXIT"
    });
    assertEq(resStruct.finalAction, "FULL_EXIT", "Structure breach bypass yields FULL_EXIT");

    // Adverse emergency shock bypass
    const resShock = evaluatePnlStopMeaningfulMoveGate({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        markPrice: 94900,
        leverage: 10,
        pnlStopProtectPct: -0.010,
        ledgerStopPx: 93860,
        atr20: 250,
        shockAgainst: true,
        thresholdActionCandidate: "FULL_EXIT"
    });
    assertEq(resShock.finalAction, "FULL_EXIT", "Shock against bypass yields FULL_EXIT");
    console.info(JSON.stringify({ status: "PASS", label: "EMERGENCY_BYPASSES_PASS" }));
}

function testLongShortSymmetry(): void {
    // SHORT position: entry 2700, mark 2703.24 (adverse move +3.24, 0.405 ATR, stopProgress 9.2%) -> HOLD
    const resShortNoise = evaluatePnlStopMeaningfulMoveGate({
        symbol: "ETHUSDT",
        side: "short",
        entryPrice: 2700,
        markPrice: 2703.24,
        leverage: 10,
        pnlStopProtectPct: -0.012,
        ledgerStopPx: 2735,
        atr20: 8.0,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "REDUCE"
    });
    assertEq(resShortNoise.finalAction, "HOLD", "SHORT noise suppressed to HOLD");

    // SHORT position stop breach: mark 2736 >= 2735 -> FULL_EXIT
    const resShortBreach = evaluatePnlStopMeaningfulMoveGate({
        symbol: "ETHUSDT",
        side: "short",
        entryPrice: 2700,
        markPrice: 2736,
        leverage: 10,
        pnlStopProtectPct: -0.133,
        ledgerStopPx: 2735,
        atr20: 8.0,
        slProtectionSatisfied: true,
        slProtectionProvisional: false,
        thresholdActionCandidate: "FULL_EXIT"
    });
    assertEq(resShortBreach.finalAction, "FULL_EXIT", "SHORT stop breach yields FULL_EXIT");
    console.info(JSON.stringify({ status: "PASS", label: "LONG_SHORT_SYMMETRY_PASS" }));
}

function testMissingAtrDeterministicFallback(): void {
    // Both ATR and stop missing -> PnL threshold directly dictates protection
    const resMissingReduce = evaluatePnlStopMeaningfulMoveGate({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        markPrice: 94886,
        leverage: 10,
        pnlStopProtectPct: -0.012,
        ledgerStopPx: null,
        atr20: null,
        thresholdActionCandidate: "REDUCE"
    });
    assertEq(resMissingReduce.finalAction, "REDUCE", "Missing ATR/stop fallback respects REDUCE threshold");

    const resMissingFull = evaluatePnlStopMeaningfulMoveGate({
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 95000,
        markPrice: 94800,
        leverage: 10,
        pnlStopProtectPct: -0.020,
        ledgerStopPx: null,
        atr20: null,
        thresholdActionCandidate: "FULL_EXIT"
    });
    assertEq(resMissingFull.finalAction, "FULL_EXIT", "Missing ATR/stop fallback respects FULL_EXIT threshold");
    console.info(JSON.stringify({ status: "PASS", label: "MISSING_ATR_FALLBACK_PASS" }));
}

function testProductionExitPolicyLiveEthFixture(): void {
    // Full production evaluateV2ExitPolicy call with Live ETH fixture
    const args: EvaluateV2ExitPolicyArgs = {
        symbol: "ETHUSDT",
        v2State: {
            symbol: "ETHUSDT",
            directionalShockState: "NONE",
            symbolPositions: [
                {
                    symbol: "ETHUSDT",
                    side: "LONG",
                    entryPrice: 1904.81,
                    sizeUsd: 5000,
                    entryStage: 1,
                    pnlPct: -0.012,
                    leverage: 10,
                    ledger_stop_px: 1899.857494,
                    slProtectionSatisfied: true,
                    slProtectionProvisional: false,
                    protectiveSlAlgoId: "algo_sl_123",
                    peakUnrealizedPnlPct: 0
                } as any
            ]
        } as any,
        judgment: createBaseJudgment(),
        snapshot: {
            boxPos: 0.5,
            boxBreakSide: "none",
            emaGap: 0.001,
            trendWeaknessScore: 0.2,
            rangeConfidence: 0.8,
            qualityScore: 80,
            atr20: 6.0
        },
        markPrice: 1902.5242 // -0.12% move
    };

    const policyRes = evaluateV2ExitPolicy(args);
    assertEq(policyRes.action, "HOLD", "Live ETH production policy action MUST be HOLD");
    assertEq(policyRes.reason, "TREND_HOLD_VALID", "Live ETH production reason is TREND_HOLD_VALID");
    assertFalse(policyRes.shouldReduce, "Live ETH shouldReduce is false");
    assertFalse(policyRes.shouldExit, "Live ETH shouldExit is false");

    const proof = buildPnlStopMeaningfulMoveGateProof(policyRes.pnlStopGateResult!);
    assertEq(proof.event, "V2_PNL_STOP_MEANINGFUL_MOVE_GATE_PROOF", "Proof event name matches");
    assertEq(proof.thresholdActionCandidate, "REDUCE", "Proof thresholdActionCandidate matches");
    assertEq(proof.finalAction, "HOLD", "Proof finalAction is HOLD");
    assertEq(proof.slProtectionSatisfied, true, "Proof slProtectionSatisfied is true");
    assertEq(proof.slProtectionProvisional, false, "Proof slProtectionProvisional is false");
    assertEq(proof.exchangeSlAuthoritativelyConfirmed, true, "Proof exchangeSlAuthoritativelyConfirmed is true");
    assertEq(proof.exchangeProtectionState, "CONFIRMED", "Proof exchangeProtectionState is CONFIRMED");
    console.info(JSON.stringify({ status: "PASS", label: "PRODUCTION_EXIT_POLICY_LIVE_ETH_PASS" }));
}

function runAllTests(): void {
    console.info("=== RUNNING BLOCKER 4-17 REGRESSION TESTS ===");
    testLiveEthIncident_CaseA_Minus012_Hold();
    testLiveEthIncident_CaseB_Minus020_Hold();
    testLiveEthIncident_CaseC_AtrSweep();
    testAuthoritySemantics_CaseA_ProvisionalGrace_Hold();
    testAuthoritySemantics_CaseA_ProvisionalGrace_StopBreached_FullExit();
    testAuthoritySemantics_CaseB_ConfirmedScan_Hold();
    testAuthoritySemantics_CaseC_GraceExpiredUnconfirmed_FullExit();
    testContext1_ConfirmedSl_MissingAtr_Minus012_Hold();
    testContext1_ConfirmedSl_MissingAtr_Minus020_Hold();
    testLiveBtcSetup_Sweep();
    testEmergencyBypasses();
    testLongShortSymmetry();
    testMissingAtrDeterministicFallback();
    testProductionExitPolicyLiveEthFixture();
    console.info("=== ALL BLOCKER 4-17 REGRESSION TESTS PASSED ===");
}

runAllTests();
