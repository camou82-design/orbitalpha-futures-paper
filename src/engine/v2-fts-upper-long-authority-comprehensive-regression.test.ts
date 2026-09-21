/**
 * Comprehensive Authority Regression Tests for RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG Resolution.
 *
 * 1. 일반 RANGE upper long chase -> BLOCK (RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG / CHASE_LONG_DISALLOWED_UPPER)
 * 2. FTS wick-only -> BLOCK
 * 3. closed breakout 있으나 retest/reclaim 미완성 -> BLOCK
 * 4. 완결 FTS upper long -> zone veto 면제 (Confirmed)
 * 5. 면제 후 Highway cost / quality 불합격 -> BLOCK
 * 6. Trend not OK -> BLOCK
 * 7. invalid stop/TP -> BLOCK
 * 8. killSwitch / closeOnly / hardBlock -> BLOCK
 * 9. V1 downgraded (signal=none, entryCandidate=false, signalGateBlockedReason=RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG)
 *    + 완결 FTS -> V2 authority로 실제 ENTER 복구 (E2E)
 */

import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { evaluateFastTrendShiftUpperLongZoneConfirmed } from "../engine-v2/market-judgment/fast-trend-shift-upper-long-authority";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";

function run(label: string, passed: boolean, detail: string): void {
    const tag = passed ? "PASS" : "FAIL";
    console.log(`[FTS-AUTH-REGRESSION][${label}] ${tag} — ${detail}`);
    if (!passed) throw new Error(`[FTS-AUTH-REGRESSION][${label}] FAILED: ${detail}`);
}

function captureProofLogs(fn: () => void): Record<string, unknown>[] {
    const logs: Record<string, unknown>[] = [];
    const origInfo = console.info;
    console.info = (msg: unknown) => {
        try {
            const p = JSON.parse(String(msg));
            if (p && typeof p.event === "string") logs.push(p);
        } catch { /* ignore */ }
        origInfo(msg);
    };
    try { fn(); } finally { console.info = origInfo; }
    return logs;
}

function makeProductionBridge(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        closeOnlyMode: false,
        killSwitch: false,
        reconcileSafeMode: false,
        longAllow: true,
        shortAllow: true,
        currentPositions: [],
        executionReadiness: true,
        accountEquityKrw: 10_000_000,
        exposureNotionalCapKrw: 100_000_000,
        symbolExposureNotionalCapKrw: 50_000_000,
        accountEquityUsdt: 10_000,
        availableBalanceUsdt: 10_000,
        liveBalanceReady: true,
        okxActualPositionsReady: true,
        actualAccountNotionalUsdtReady: true,
        okxActualPositions: [],
        okxPendingOrdersReady: true,
        okxPendingOrdersNotionalUsdt: 0,
        okxPendingSymbolNotionalUsdt: 0,
        hasSymbolPendingEntry: false,
        hasUnknownPendingNotional: false,
        okxLiveEnabled: true,
        okxAuthMode: "live",
        okxAuthReady: true,
        okxExchangeAuthOptIn: true,
        okxApiKeyPresent: true,
        okxApiSecretPresent: true,
        okxPassphrasePresent: true,
        balanceFetchedAt: now,
        positionsFetchedAt: now,
        pendingOrdersFetchedAt: now,
        dailyLossGuardTriggered: false,
        ...overrides
    };
}

function makeLiveConfig(overrides: Record<string, unknown> = {}) {
    return {
        paperMaxOpenPositions: 3,
        baseSizeUsd: 100,
        maxSymbolNotionalUsd: 5000,
        maxAccountNotionalUsd: 20000,
        okxLiveEnabled: true,
        okxAuthMode: "live",
        okxExchangeAuthOptIn: true,
        okxLiveMaxOrderNotionalUsdt: 200,
        serverTradeEnabled: true,
        paperTakerFeeRate: 0.0005,
        paperSlippageEstimateBps: 8,
        paperReentryCooldownMs: 0,
        ...overrides
    };
}

function makeBullishHtf(base = 2400): Candle[] {
    return Array.from({ length: 120 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60000,
        open: base + i * 2,
        high: base + i * 2 + 5,
        low: base + i * 2 - 5,
        close: base + i * 2 + 2,
        volume: 100
    }));
}

function makeEthFtsUpperHoldCandles(boxHigh: number, boxLow: number): Candle[] {
    const flat: Candle[] = Array.from({ length: 110 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60000,
        open: boxLow + 20,
        high: boxLow + 40,
        low: boxLow + 5,
        close: boxLow + 25,
        volume: 80
    }));
    const ramp: Candle[] = Array.from({ length: 8 }, (_, i) => {
        const px = boxLow + 30 + i * ((boxHigh - boxLow) / 8);
        return {
            ts: Date.now() - (10 - i) * 60000,
            open: px,
            high: px + 15,
            low: px - 5,
            close: px + 10,
            volume: 140
        };
    });
    const holdFloor = boxHigh * 0.998;
    const holdAbove: Candle[] = [
        {
            ts: Date.now() - 240000,
            open: holdFloor + 2,
            high: holdFloor + 20,
            low: holdFloor + 1,
            close: holdFloor + 12,
            volume: 160
        },
        {
            ts: Date.now() - 180000,
            open: holdFloor + 10,
            high: holdFloor + 22,
            low: holdFloor + 3,
            close: holdFloor + 16,
            volume: 170
        },
        {
            ts: Date.now() - 120000,
            open: holdFloor + 14,
            high: holdFloor + 26,
            low: holdFloor + 5,
            close: holdFloor + 20,
            volume: 175
        },
        {
            ts: Date.now() - 60000,
            open: holdFloor + 18,
            high: holdFloor + 30,
            low: holdFloor + 8,
            close: holdFloor + 24,
            volume: 180
        }
    ];
    return [...flat, ...ramp, ...holdAbove];
}

console.log("=== RUNNING FTS UPPER LONG COMPREHENSIVE REGRESSION SUITE ===");

// 1. 일반 RANGE upper long chase -> BLOCK
{
    clearWhipsawObservationState("ETHUSDT");
    const cycleNow = Date.now();
    const boxHigh = 2500;
    const boxLow = 2300;
    const boxPos = 0.85;
    const lastPrice = 2470;
    const flatCandles = Array.from({ length: 120 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60000,
        open: 2400, high: 2420, low: 2380, close: 2400, volume: 50
    }));
    const snap = {
        symbol: "ETHUSDT",
        lastPrice,
        latestCandleClose: lastPrice,
        signal: "paper_long_candidate",
        entryCandidate: true,
        qualityScore: 68,
        emaGap: 0.001,
        boxHigh, boxLow, boxPos,
        boxBreakSide: "none",
        atr: 20, atr20: 20,
        rangeConfidence: 0.8,
        trendWeaknessScore: 0.6,
        boxCohesion01: 0.85,
        breakoutFailureRate: 0.7,
        canonicalRegime: "RANGE",
        candles: flatCandles,
        htf_candles: { "5m": flatCandles, "15m": flatCandles, "1h": makeBullishHtf(2400), "4h": makeBullishHtf(2400) }
    };
    const input = adaptV2Input(
        "ETHUSDT", cycleNow, buildV2SnapshotBridge(snap as any) as any,
        makeLiveConfig() as any, makeProductionBridge() as any,
        { decision: { final_decision: "SKIP" } } as any,
        flatCandles, "authoritative", `reg_chase_${cycleNow}`
    );
    let decision: ReturnType<typeof runEngineV2>["decision"];
    const proofs = captureProofLogs(() => { ({ decision } = runEngineV2(input)); });
    const sideConsistency = proofs.find(p => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF");
    
    run("1_ORDINARY_RANGE_UPPER_CHASE_BLOCKED",
        decision!.decision === "SKIP" || decision!.decision === "REJECT" || decision!.decision === "HOLD",
        `decision=${decision!.decision}, veto=${sideConsistency?.vetoReason}`
    );
}

// 2. FTS wick-only -> BLOCK
{
    const evalResult = evaluateFastTrendShiftUpperLongZoneConfirmed({
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_low_detected: true,
            higher_high_detected: true,
            box_mid_reclaimed: true,
            box_upper_breakout_hold: false, // wick only (no hold)
            reason: "wick_spike_above",
            stop_price: 2450
        },
        zone: "upper",
        trendOk: true,
        qualityScore: 75,
        htfEntryPolicy: "ALLOW",
        htfRequiresStrongerConfirmation: false,
        counterTrendRisk: false,
        lateChaseBlocked: false,
        hardBlockPresent: false,
        whipsawShockRecheckActive: false,
        riskLongAllow: true,
        allowNewLong: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        boxMid: 2400,
        lastPrice: 2480
    });
    run("2_FTS_WICK_ONLY_BLOCKED",
        evalResult.confirmed === false && evalResult.holdReason === "FTS_UPPER_HOLD_MISSING",
        `confirmed=${evalResult.confirmed}, holdReason=${evalResult.holdReason}`
    );
}

// 3. Closed breakout 있으나 retest/reclaim 미완성 (구조 미완성) -> BLOCK
{
    const evalResult = evaluateFastTrendShiftUpperLongZoneConfirmed({
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_low_detected: false, // HL missing
            higher_high_detected: true,
            box_mid_reclaimed: true,
            box_upper_breakout_hold: true,
            reason: "upper_hold",
            stop_price: 2450
        },
        zone: "upper",
        trendOk: true,
        qualityScore: 75,
        htfEntryPolicy: "ALLOW",
        htfRequiresStrongerConfirmation: false,
        counterTrendRisk: false,
        lateChaseBlocked: false,
        hardBlockPresent: false,
        whipsawShockRecheckActive: false,
        riskLongAllow: true,
        allowNewLong: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        boxMid: 2400,
        lastPrice: 2480
    });
    run("3_FTS_STRUCTURE_INCOMPLETE_BLOCKED",
        evalResult.confirmed === false && evalResult.holdReason === "FTS_STRUCTURE_INCOMPLETE",
        `confirmed=${evalResult.confirmed}, holdReason=${evalResult.holdReason}`
    );
}

// 4. 완결 FTS upper long -> Zone Veto 면제 (Confirmed)
{
    const evalResult = evaluateFastTrendShiftUpperLongZoneConfirmed({
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_low_detected: true,
            higher_high_detected: true,
            box_mid_reclaimed: true,
            box_upper_breakout_hold: true,
            reason: "higher_low|higher_high|box_mid_ok|upper_hold",
            stop_price: 2450
        },
        zone: "upper",
        trendOk: true,
        qualityScore: 78,
        htfEntryPolicy: "ALLOW",
        htfRequiresStrongerConfirmation: false,
        counterTrendRisk: false,
        lateChaseBlocked: false,
        hardBlockPresent: false,
        whipsawShockRecheckActive: false,
        riskLongAllow: true,
        allowNewLong: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        boxMid: 2400,
        lastPrice: 2480
    });
    run("4_COMPLETE_FTS_UPPER_LONG_CONFIRMED",
        evalResult.confirmed === true && evalResult.holdReason === null,
        `confirmed=${evalResult.confirmed}, holdReason=${evalResult.holdReason}`
    );
}

// 5. 면제 후 Highway Cost / Quality 불합격 -> BLOCK
{
    const evalResult = evaluateFastTrendShiftUpperLongZoneConfirmed({
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_low_detected: true,
            higher_high_detected: true,
            box_mid_reclaimed: true,
            box_upper_breakout_hold: true,
            reason: "higher_low|higher_high|box_mid_ok|upper_hold",
            stop_price: 2450
        },
        zone: "upper",
        trendOk: true,
        qualityScore: 50, // quality below threshold 65
        htfEntryPolicy: "ALLOW",
        htfRequiresStrongerConfirmation: false,
        counterTrendRisk: false,
        lateChaseBlocked: false,
        hardBlockPresent: false,
        whipsawShockRecheckActive: false,
        riskLongAllow: true,
        allowNewLong: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        boxMid: 2400,
        lastPrice: 2480
    });
    run("5_QUALITY_BELOW_THRESHOLD_BLOCKED",
        evalResult.confirmed === false && evalResult.holdReason === "QUALITY_BELOW_THRESHOLD",
        `confirmed=${evalResult.confirmed}, holdReason=${evalResult.holdReason}`
    );
}

// 6. Trend not OK -> BLOCK
{
    const evalResult = evaluateFastTrendShiftUpperLongZoneConfirmed({
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_low_detected: true,
            higher_high_detected: true,
            box_mid_reclaimed: true,
            box_upper_breakout_hold: true,
            reason: "higher_low|higher_high|box_mid_ok|upper_hold",
            stop_price: 2450
        },
        zone: "upper",
        trendOk: false, // trendOk false
        qualityScore: 78,
        htfEntryPolicy: "ALLOW",
        htfRequiresStrongerConfirmation: false,
        counterTrendRisk: false,
        lateChaseBlocked: false,
        hardBlockPresent: false,
        whipsawShockRecheckActive: false,
        riskLongAllow: true,
        allowNewLong: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        boxMid: 2400,
        lastPrice: 2480
    });
    run("6_TREND_NOT_OK_BLOCKED",
        evalResult.confirmed === false && evalResult.holdReason === "TREND_NOT_OK",
        `confirmed=${evalResult.confirmed}, holdReason=${evalResult.holdReason}`
    );
}

// 7. Invalid structural stop -> BLOCK
{
    const evalResult = evaluateFastTrendShiftUpperLongZoneConfirmed({
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_low_detected: true,
            higher_high_detected: true,
            box_mid_reclaimed: true,
            box_upper_breakout_hold: true,
            reason: "higher_low|higher_high|box_mid_ok|upper_hold",
            stop_price: 2500 // stop >= lastPrice (invalid!)
        },
        zone: "upper",
        trendOk: true,
        qualityScore: 78,
        htfEntryPolicy: "ALLOW",
        htfRequiresStrongerConfirmation: false,
        counterTrendRisk: false,
        lateChaseBlocked: false,
        hardBlockPresent: false,
        whipsawShockRecheckActive: false,
        riskLongAllow: true,
        allowNewLong: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        boxMid: 2400,
        lastPrice: 2480
    });
    run("7_INVALID_STOP_PRICE_BLOCKED",
        evalResult.confirmed === false && evalResult.holdReason === "FTS_STRUCTURAL_STOP_INVALID",
        `confirmed=${evalResult.confirmed}, holdReason=${evalResult.holdReason}`
    );
}

// 8. killSwitch / closeOnly / hardBlock -> BLOCK
{
    const evalResult = evaluateFastTrendShiftUpperLongZoneConfirmed({
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_low_detected: true,
            higher_high_detected: true,
            box_mid_reclaimed: true,
            box_upper_breakout_hold: true,
            reason: "higher_low|higher_high|box_mid_ok|upper_hold",
            stop_price: 2450
        },
        zone: "upper",
        trendOk: true,
        qualityScore: 78,
        htfEntryPolicy: "ALLOW",
        htfRequiresStrongerConfirmation: false,
        counterTrendRisk: false,
        lateChaseBlocked: false,
        hardBlockPresent: true, // hard block
        whipsawShockRecheckActive: false,
        riskLongAllow: true,
        allowNewLong: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        boxMid: 2400,
        lastPrice: 2480
    });
    run("8_HARD_BLOCK_PREVENTS_CONFIRMATION",
        evalResult.confirmed === false && evalResult.holdReason === "HARD_BLOCK_PRESENT",
        `confirmed=${evalResult.confirmed}, holdReason=${evalResult.holdReason}`
    );
}

// 9. V1 downgraded (signal=none, entryCandidate=false, signalGateBlockedReason=RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG)
//    + 완결 FTS -> V2 authority로 실제 ENTER 복구 검증 (E2E)
{
    clearWhipsawObservationState("ETHUSDT");
    const boxHigh = 2550;
    const boxLow = 2470;
    const holdFloor = boxHigh * 0.998;
    const lastPrice = holdFloor + 24;
    const closedClose = holdFloor + 20;
    const boxPos = 0.92;
    const candles = makeEthFtsUpperHoldCandles(boxHigh, boxLow);
    const htf = makeBullishHtf(2400);
    const cycleNow = Date.now();
    const snap = {
        symbol: "ETHUSDT",
        lastPrice,
        latestCandleClose: closedClose,
        signal: "paper_long_candidate",
        entryCandidate: false, // V1 downgraded entryCandidate
        qualityScore: 72,
        emaGap: 0.006,
        volumeRatioProxy: 1.4,
        volumeExpansion: 1.7,
        ema20Slope: 0.0003,
        boxHigh,
        boxLow,
        boxPos,
        atr: 10,
        atr20: 10,
        tickSz: 0.01,
        closedClose,
        rangeConfidence: 0.78,
        trendWeaknessScore: 0.22,
        boxCohesion01: 0.9,
        breakoutFailureRate: 0.12,
        rangeOscillationScore: 0.62,
        rangeSignalDowngraded: true, // V1 downgraded
        rangeSignalKeptByRelax: false,
        signalGateBlockedReason: "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG", // V1 blocked reason
        candles,
        htf_candles: { "5m": candles, "15m": candles, "1h": htf, "4h": htf },
        canonicalRegime: "RANGE",
        reviewing_ticks: 0
    };

    const input = adaptV2Input(
        "ETHUSDT",
        cycleNow,
        buildV2SnapshotBridge(snap as any) as any,
        makeLiveConfig() as any,
        makeProductionBridge({ balanceFetchedAt: cycleNow, positionsFetchedAt: cycleNow, pendingOrdersFetchedAt: cycleNow }) as any,
        { decision: { final_decision: "SKIP" } } as any,
        candles,
        "authoritative",
        `fts_e2e_recovery_${cycleNow}`
    );

    const judgment = detectMarketRegime(input);
    let decision: ReturnType<typeof runEngineV2>["decision"];
    const proofs = captureProofLogs(() => { ({ decision } = runEngineV2(input)); });
    const nativeAuth = proofs.find(p => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
    const sideConsistency = proofs.find(p => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF");
    const finalizer = proofs.find(p => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");
    const rangeVeto = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" && p.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG");

    run("9_V1_DOWNGRADED_FTS_RECOVERS_VIA_V2_AUTHORITY",
        judgment.subtype === "FAST_TREND_SHIFT" &&
        rangeVeto == null &&
        sideConsistency?.vetoReason == null &&
        nativeAuth?.range_upper_long_mismatch_after_exemption === false &&
        nativeAuth?.native_fast_trend_shift_upper_long_confirmed === true &&
        finalizer?.decision_before === "ENTER" &&
        finalizer?.side_before === "long" &&
        finalizer?.reject_reason_after !== "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG",
        `subtype=${judgment.subtype}, sideBefore=${finalizer?.side_before}, vetoAfter=${nativeAuth?.range_upper_long_mismatch_after_exemption}, ftsConfirmed=${nativeAuth?.native_fast_trend_shift_upper_long_confirmed}`
    );
}

console.log("=== ALL FTS UPPER LONG COMPREHENSIVE REGRESSION TESTS PASSED ===");
