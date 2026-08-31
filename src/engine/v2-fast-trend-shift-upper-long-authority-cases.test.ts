/**
 * FAST_TREND_SHIFT upper-long vs RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG authority regressions.
 *
 * A. FTS native ENTER + valid trend/HTF/quality + upper zone -> survives RANGE zone veto
 * B. Ordinary RANGE upper long -> still blocked
 * C. FTS upper long without required structural trend confirmation -> blocked
 * D. FTS late chase -> blocked
 * E. FTS HTF-disallowed/countertrend -> blocked
 * F/G/H covered by existing manual/operator + RANGE breakout + TP equality suites
 */

import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { evaluateFastTrendShiftUpperLongZoneConfirmed } from "../engine-v2/market-judgment/fast-trend-shift-upper-long-authority";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { globalShockStates } from "../engine-v2/state/derive";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";

function run(label: string, passed: boolean, detail: string): void {
    const tag = passed ? "PASS" : "FAIL";
    console.log(`[FTS-UPPER-LONG-AUTH][${label}] ${tag} — ${detail}`);
    if (!passed) throw new Error(`[FTS-UPPER-LONG-AUTH][${label}] FAILED: ${detail}`);
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

function makeLiveBridge(overrides: Record<string, unknown> = {}) {
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
        okxLiveEnabled: true,
        okxAuthMode: "live",
        okxAuthReady: true,
        okxExchangeAuthOptIn: true,
        balanceFetchedAt: now,
        positionsFetchedAt: now,
        pendingOrdersFetchedAt: now,
        ...overrides
    };
}

function makeBullishHtf(base: number): Candle[] {
    return Array.from({ length: 120 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60000,
        open: base + i * 2,
        high: base + i * 2 + 5,
        low: base + i * 2 - 5,
        close: base + i * 2 + 2,
        volume: 100
    }));
}

/** ETH production-like FTS upper-hold candles (no closed breakout + retest). */
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

function runEthUpperLongScenario(overrides: {
    symbol?: string;
    boxHigh?: number;
    boxLow?: number;
    lastPrice?: number;
    closedClose?: number;
    boxPos?: number;
    qualityScore?: number;
    emaGap?: number;
    trendWeaknessScore?: number;
    signalGateBlockedReason?: string | null;
    rangeSignalDowngraded?: boolean;
    entryCandidate?: boolean;
    htfPolicyOverride?: Record<string, unknown>;
    execMetaOverride?: Record<string, unknown>;
    bridgeOverride?: Record<string, unknown>;
} = {}) {
    const symbol = overrides.symbol ?? "ETHUSDT";
    clearWhipsawObservationState(symbol);
    const boxHigh = overrides.boxHigh ?? 2550;
    const boxLow = overrides.boxLow ?? 2470;
    const holdFloor = boxHigh * 0.998;
    const lastPrice = overrides.lastPrice ?? holdFloor + 24;
    const closedClose = overrides.closedClose ?? holdFloor + 20;
    const boxPos = overrides.boxPos ?? 0.92;
    const candles = makeEthFtsUpperHoldCandles(boxHigh, boxLow);
    const htf = makeBullishHtf(2400);
    const cycleNow = Date.now();
    const snap = {
        symbol,
        lastPrice,
        latestCandleClose: closedClose,
        signal: "paper_long_candidate",
        entryCandidate: overrides.entryCandidate ?? false,
        qualityScore: overrides.qualityScore ?? 72,
        emaGap: overrides.emaGap ?? 0.006,
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
        trendWeaknessScore: overrides.trendWeaknessScore ?? 0.22,
        boxCohesion01: 0.9,
        breakoutFailureRate: 0.12,
        rangeOscillationScore: 0.62,
        rangeSignalDowngraded: overrides.rangeSignalDowngraded ?? true,
        rangeSignalKeptByRelax: false,
        signalGateBlockedReason: overrides.signalGateBlockedReason ?? "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG",
        candles,
        htf_candles: { "5m": candles, "15m": candles, "1h": htf, "4h": htf },
        canonicalRegime: "RANGE",
        reviewing_ticks: 0,
        ...(overrides.htfPolicyOverride ?? {})
    };
    const input = adaptV2Input(
        symbol as "ETHUSDT",
        cycleNow,
        buildV2SnapshotBridge(snap as any) as any,
        {
            baseSizeUsd: 100,
            okxLiveEnabled: true,
            okxAuthMode: "live",
            okxExchangeAuthOptIn: true,
            okxLiveMaxOrderNotionalUsdt: 500,
            paperTakerFeeRate: 0.0005,
            paperSlippageEstimateBps: 8,
            paperMaxOpenPositions: 3,
            paperReentryCooldownMs: 0
        } as any,
        makeLiveBridge({
            accountEquityUsdt: 10_000,
            liveBalanceReady: true,
            actualAccountNotionalUsdtReady: true,
            okxActualPositionsReady: true,
            okxPendingOrdersReady: true,
            okxApiKeyPresent: true,
            okxApiSecretPresent: true,
            okxPassphrasePresent: true,
            ...(overrides.bridgeOverride ?? {})
        }) as any,
        { decision: { final_decision: "SKIP" }, regime: "RANGE", side: "none", isBlocked: false } as any,
        candles,
        "authoritative",
        `fts_upper_long_${cycleNow}`
    );
    const judgment = detectMarketRegime(input);
    let decision!: ReturnType<typeof runEngineV2>["decision"];
    const proofs = captureProofLogs(() => {
        ({ decision } = runEngineV2(input));
    });
    return {
        judgment,
        decision,
        proofs,
        nativeAuth: proofs.find((p) => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF"),
        sideConsistency: proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF"),
        finalizer: proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF"),
        rangeVeto: proofs.find((p) => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF")
    };
}

// CASE A — ETH FTS upper-hold native ENTER survives RANGE zone veto (no full breakout retest)
{
    const { judgment, decision, nativeAuth, sideConsistency, finalizer, rangeVeto } = runEthUpperLongScenario();
    run(
        "CASE_A_FTS_UPPER_LONG_SURVIVES_ZONE_VETO",
        judgment.subtype === "FAST_TREND_SHIFT" &&
            judgment.diagnostics?.fastTrendShift?.direction === "long" &&
            (judgment.subtypeReason?.includes("upper_hold") ||
                judgment.diagnostics?.fastTrendShift?.box_upper_breakout_hold === true) &&
            finalizer?.decision_before === "ENTER" &&
            finalizer?.side_before === "long" &&
            nativeAuth?.native_executor_enter_authority === true &&
            nativeAuth?.native_fast_trend_shift_upper_long_confirmed === true &&
            nativeAuth?.native_executor_upper_breakout_confirmation_source ===
                "evaluateFastTrendShiftUpperLongZoneConfirmed" &&
            nativeAuth?.range_upper_long_mismatch_after_exemption === false &&
            rangeVeto == null &&
            sideConsistency?.vetoReason == null &&
            finalizer?.reject_reason_after !== "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG" &&
            finalizer?.reject_reason_after !== "CHASE_LONG_DISALLOWED_UPPER" &&
            (decision.decision === "ENTER"
                ? decision.side === "long"
                : finalizer?.reject_reason_after !== "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG"),
        [
            `subtype=${judgment.subtype}`,
            `reason=${judgment.subtypeReason}`,
            `upper_hold=${judgment.diagnostics?.fastTrendShift?.box_upper_breakout_hold}`,
            `fts_confirmed=${nativeAuth?.native_fast_trend_shift_upper_long_confirmed}`,
            `source=${nativeAuth?.native_executor_upper_breakout_confirmation_source}`,
            `mismatch_after=${nativeAuth?.range_upper_long_mismatch_after_exemption}`,
            `veto=${sideConsistency?.vetoReason ?? "none"}`,
            `reject_after=${finalizer?.reject_reason_after ?? "none"}`,
            `final=${decision.decision}/${decision.side}`
        ].join(", ")
    );
}

// CASE B — ordinary RANGE upper long (no FTS) remains blocked
{
    const boxHigh = 2550;
    const boxLow = 2470;
    const lastPrice = boxHigh - 15;
    const candles: Candle[] = Array.from({ length: 120 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60000,
        open: lastPrice,
        high: lastPrice + 8,
        low: lastPrice - 8,
        close: lastPrice + (i % 2 === 0 ? 2 : -2),
        volume: 80
    }));
    const cycleNow = Date.now();
    const snap = {
        symbol: "ETHUSDT",
        lastPrice,
        latestCandleClose: lastPrice,
        signal: "paper_long_candidate",
        entryCandidate: true,
        qualityScore: 75,
        emaGap: 0.0002,
        volumeRatioProxy: 1.2,
        boxHigh,
        boxLow,
        boxPos: 0.88,
        atr: 10,
        tickSz: 0.01,
        trendWeaknessScore: 0.55,
        volumeExpansion: 1.0,
        ema20Slope: 0.00001,
        rangeConfidence: 0.7,
        rangeSignalDowngraded: false,
        signalGateBlockedReason: "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG",
        candles,
        htf_candles: { "5m": candles, "15m": candles, "1h": makeBullishHtf(2400), "4h": makeBullishHtf(2400) },
        canonicalRegime: "RANGE",
        reviewing_ticks: 0
    };
    const input = adaptV2Input(
        "ETHUSDT",
        cycleNow,
        buildV2SnapshotBridge(snap as any) as any,
        {
            baseSizeUsd: 100,
            okxLiveEnabled: true,
            okxAuthMode: "live",
            okxExchangeAuthOptIn: true,
            okxLiveMaxOrderNotionalUsdt: 500,
            paperMaxOpenPositions: 3,
            paperReentryCooldownMs: 0
        } as any,
        makeLiveBridge() as any,
        { decision: { final_decision: "SKIP" } } as any,
        candles,
        "authoritative",
        `ordinary_range_upper_${cycleNow}`
    );
    const judgment = detectMarketRegime(input);
    let decision!: ReturnType<typeof runEngineV2>["decision"];
    const proofs = captureProofLogs(() => {
        ({ decision } = runEngineV2(input));
    });
    const sideConsistency = proofs.find((p) => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF");
    run(
        "CASE_B_ORDINARY_RANGE_UPPER_LONG_BLOCKED",
        judgment.subtype !== "FAST_TREND_SHIFT" &&
            (sideConsistency?.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG" ||
                decision.decision !== "ENTER" ||
                decision.side !== "long"),
        `subtype=${judgment.subtype}, final=${decision.decision}/${decision.side}, veto=${sideConsistency?.vetoReason ?? "none"}`
    );
}

// CASE C — FTS without upper_hold structural confirmation -> blocked
{
    const helper = evaluateFastTrendShiftUpperLongZoneConfirmed({
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_low_detected: true,
            higher_high_detected: true,
            box_mid_reclaimed: true,
            box_upper_breakout_hold: false,
            reason: "higher_low|higher_high|box_mid_ok",
            stop_price: 2460
        },
        zone: "upper",
        trendOk: true,
        qualityScore: 72,
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
        boxMid: 2510,
        lastPrice: 2540
    });
    assert.equal(helper.confirmed, false);
    assert.equal(helper.holdReason, "FTS_UPPER_HOLD_MISSING");

    const { decision, nativeAuth, sideConsistency } = runEthUpperLongScenario({
        trendWeaknessScore: 0.55,
        emaGap: 0.0001
    });
    run(
        "CASE_C_FTS_WEAK_STRUCTURE_OR_TREND_BLOCKED",
        nativeAuth?.native_fast_trend_shift_upper_long_confirmed !== true &&
            (decision.decision !== "ENTER" || sideConsistency?.vetoReason != null),
        `fts_confirmed=${nativeAuth?.native_fast_trend_shift_upper_long_confirmed}, final=${decision.decision}/${decision.side}, veto=${sideConsistency?.vetoReason ?? "none"}`
    );
}

// CASE D — FTS late chase blocked
{
    const late = evaluateFastTrendShiftUpperLongZoneConfirmed({
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_low_detected: true,
            higher_high_detected: true,
            box_mid_reclaimed: true,
            box_upper_breakout_hold: true,
            reason: "higher_low|higher_high|box_mid_ok|upper_hold",
            stop_price: 2460
        },
        zone: "upper",
        trendOk: true,
        qualityScore: 72,
        htfEntryPolicy: "ALLOW",
        htfRequiresStrongerConfirmation: false,
        counterTrendRisk: false,
        lateChaseBlocked: true,
        hardBlockPresent: false,
        whipsawShockRecheckActive: false,
        riskLongAllow: true,
        allowNewLong: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        boxMid: 2510,
        lastPrice: 2560
    });
    assert.equal(late.confirmed, false);
    assert.equal(late.holdReason, "LATE_CHASE_BLOCKED");
    run("CASE_D_FTS_LATE_CHASE_BLOCKED", true, `holdReason=${late.holdReason}`);
}

// CASE E — FTS HTF disallowed
{
    const htfBlock = evaluateFastTrendShiftUpperLongZoneConfirmed({
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_low_detected: true,
            higher_high_detected: true,
            box_mid_reclaimed: true,
            box_upper_breakout_hold: true,
            reason: "higher_low|higher_high|box_mid_ok|upper_hold",
            stop_price: 2460
        },
        zone: "upper",
        trendOk: true,
        qualityScore: 72,
        htfEntryPolicy: "SHORT_ONLY_OR_NONE",
        htfRequiresStrongerConfirmation: false,
        counterTrendRisk: true,
        lateChaseBlocked: false,
        hardBlockPresent: false,
        whipsawShockRecheckActive: false,
        riskLongAllow: true,
        allowNewLong: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        boxMid: 2510,
        lastPrice: 2560
    });
    assert.equal(htfBlock.confirmed, false);
    assert.equal(htfBlock.holdReason, "HTF_POLICY_BLOCKS_LONG");
    run("CASE_E_FTS_HTF_DISALLOWED", true, `holdReason=${htfBlock.holdReason}`);
}

console.log("v2-fast-trend-shift-upper-long-authority-cases: ALL PASS");
