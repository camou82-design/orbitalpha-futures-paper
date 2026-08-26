/**
 * FAST_TREND_SHIFT probe survival — canonical structural stop regressions (CASE A–J).
 */

import assert from "node:assert/strict";
import { ensurePromotedEntryRiskPlan } from "../engine-v2/index";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { executeRangeRegime } from "../engine-v2/executors/range-executor";
import { evaluateV2AddOnPolicy } from "../engine-v2/addon/policy";
import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import { isV2StopPriceBreached } from "../engine-v2/exit/stop-price-authority";
import {
    evaluateEquityAdaptiveSizing,
    RISK_PER_TRADE_PCT,
    resolveEffectiveLiveOrderNotionalCap
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import {
    FTS_STRUCTURAL_STOP_BASIS,
    getClosedCandlesForStructuralStop,
    resolveFastTrendShiftStructuralStop
} from "../engine-v2/risk-sizing/fast-trend-shift-structural-stop";
import { computeAdaptiveRangePreEntryProtection } from "../engine-v2/execution/adaptive-range-pre-entry-protection";
import type { Candle } from "../models/types";
import type { EngineV2Input, ExecutorOutput, MarketJudgmentOutput } from "../engine-v2/types";

const ENTRY = 70_000;
const ATR = 50;
const BOX_HIGH = 70_100;
const BOX_LOW = 69_900;
const BOX_MID = (BOX_HIGH + BOX_LOW) / 2;
const EQUITY = 10_000;

function pass(label: string, detail?: Record<string, unknown>): void {
    const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
    console.log(`[FTS-PROBE-SURVIVAL][${label}] PASS${extra}`);
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

function oldMicroProbeStopShort(lastPrice: number, atr: number, candles: Candle[]): number {
    const swingHigh = candles.length >= 10 ? Math.max(...candles.slice(-10).map((c) => c.high)) : lastPrice * 1.01;
    const stopBasisMid = BOX_MID * 1.002;
    const stopBasisAtr = lastPrice + atr * 2.0;
    return Math.max(swingHigh, stopBasisMid, stopBasisAtr);
}

function buildShortSurvivalCandles(): Candle[] {
    const candles: Candle[] = [];
    let ts = 1_000_000;
    for (let i = 0; i < 12; i++) {
        if (i === 8) {
            candles.push({
                ts,
                open: ENTRY - 50,
                high: ENTRY + 200,
                low: ENTRY - 80,
                close: ENTRY - 30,
                volume: 100
            });
        } else if (i === 7 || i === 9) {
            candles.push({
                ts,
                open: ENTRY - 40,
                high: ENTRY + 80,
                low: ENTRY - 60,
                close: ENTRY - 20,
                volume: 100
            });
        } else {
            candles.push({
                ts,
                open: ENTRY,
                high: ENTRY + 30,
                low: ENTRY - 40,
                close: ENTRY - 10,
                volume: 100
            });
        }
        ts += 60_000;
    }
    // forming bar — wick pierces old 10-bar micro stop but stays below canonical structural stop
    candles.push({
        ts,
        open: ENTRY - 20,
        high: ENTRY + 210,
        low: ENTRY - 50,
        close: ENTRY - 25,
        volume: 120
    });
    return candles;
}

function buildLongSurvivalCandles(): Candle[] {
    const candles: Candle[] = [];
    let ts = 2_000_000;
    for (let i = 0; i < 12; i++) {
        if (i === 8) {
            candles.push({
                ts,
                open: ENTRY + 50,
                high: ENTRY + 80,
                low: ENTRY - 200,
                close: ENTRY + 30,
                volume: 100
            });
        } else if (i === 7 || i === 9) {
            candles.push({
                ts,
                open: ENTRY + 40,
                high: ENTRY + 60,
                low: ENTRY - 80,
                close: ENTRY + 20,
                volume: 100
            });
        } else {
            candles.push({
                ts,
                open: ENTRY,
                high: ENTRY + 40,
                low: ENTRY - 30,
                close: ENTRY + 10,
                volume: 100
            });
        }
        ts += 60_000;
    }
    candles.push({
        ts,
        open: ENTRY + 20,
        high: ENTRY + 50,
        low: ENTRY - 210,
        close: ENTRY + 25,
        volume: 120
    });
    return candles;
}

function makeEngineInput(candles: Candle[], side: "long" | "short"): EngineV2Input {
    const lastPrice = candles[candles.length - 1]!.close;
    return {
        symbol: "BTCUSDT",
        candles,
        snapshot: {
            symbol: "BTCUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            boxHigh: BOX_HIGH,
            boxLow: BOX_LOW,
            boxPos: side === "short" ? 0.12 : 0.88,
            rangeConfidence: 0.78,
            boxCohesion01: 0.92,
            rangeOscillationScore: 0.65,
            breakoutFailureRate: 0.15,
            trendWeaknessScore: 0.22,
            qualityScore: 82,
            reviewing_ticks: 3,
            regimeExitRisk: 0,
            boxBreakSide: "none",
            signal: side === "long" ? "paper_long_candidate" : "paper_short_candidate",
            data_ready: true,
            dump_protection_hit: false,
            volatility_guard_hit: false,
            entryCandidate: true,
            ema20: lastPrice - (side === "long" ? 50 : -50),
            emaGap: side === "long" ? 0.006 : -0.006,
            volatilityProxy: ATR,
            atr: ATR,
            volumeExpansion: 1.6,
            ema20Slope: side === "long" ? 0.0002 : -0.0002,
            candles
        },
        state: {
            currentPositions: [],
            lossStreaks: {},
            globalRiskScore: 0,
            longAllow: true,
            shortAllow: true,
            executionReadiness: true,
            paperExecutionReady: true,
            signedExecutionReady: true,
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            riskMode: "NORMAL",
            dailyLossGuardTriggered: false,
            directionalShockState: side === "long" ? "UP" : "DOWN",
            accountEquityKrw: 10_000_000,
            maxUsableMarginKrw: 900_000,
            exposureNotionalCapKrw: 5_000_000,
            symbolExposureNotionalCapKrw: 3_000_000,
            okxLiveEnabled: false,
            freshTickBarrierActive: false,
            freshTickCompletedCycles: 5,
            freshTickRequiredCycles: 5
        },
        config: { baseSizeUsd: 100 },
        now: Date.now(),
        v1Result: { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: false }
    } as unknown as EngineV2Input;
}

function ftsJudgment(direction: "long" | "short", resolved: ReturnType<typeof resolveFastTrendShiftStructuralStop>): MarketJudgmentOutput {
    return {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "FAST_TREND_SHIFT",
        subtypeReason: direction === "long" ? "FAST_SHIFT_LONG" : "FAST_SHIFT_SHORT",
        shockPhase: direction === "long" ? "UP_SHOCK" : "DOWN_SHOCK",
        trendPhase: direction === "long" ? "UP" : "DOWN",
        rangePhase: "FLAT",
        counter_trend_risk: false,
        diagnostics: {
            fastTrendShift: {
                active: true,
                direction,
                candidate: true,
                allowed: true,
                side: direction,
                reason: "test",
                block_reason: "",
                higher_low_detected: direction === "long",
                higher_high_detected: direction === "long",
                lower_high_detected: direction === "short",
                lower_low_detected: direction === "short",
                box_mid_reclaimed: direction === "long",
                box_mid_lost: direction === "short",
                box_upper_breakout_hold: false,
                box_lower_breakdown_hold: false,
                ema_slope_shift: true,
                volume_expansion: true,
                baseSizeIntent: 0.32,
                stop_price: resolved.stopPrice,
                stop_basis: resolved.stopBasis,
                structural_invalidation_price: resolved.structuralInvalidationPrice,
                structural_source: resolved.structuralSource,
                atr_buffer_multiple: resolved.atrBufferMultiple,
                atr_buffer_price: resolved.atrBufferPrice,
                stop_distance_pct: resolved.stopDistancePct
            }
        }
    } as MarketJudgmentOutput;
}

// CASE A — SHORT ordinary wick survives
{
    const candles = buildShortSurvivalCandles();
    const lastPrice = candles[candles.length - 1]!.close;
    const closed = getClosedCandlesForStructuralStop(candles);
    const resolved = resolveFastTrendShiftStructuralStop({
        side: "short",
        entryPrice: lastPrice,
        lastPrice,
        atr: ATR,
        closedCandles: closed,
        boxMid: BOX_MID,
        previousConfirmedBoxHigh: BOX_HIGH,
        previousConfirmedBoxLow: BOX_LOW
    });
    assert.equal(resolved.valid, true);
    const oldStop = oldMicroProbeStopShort(lastPrice, ATR, candles);
    const noiseWickHigh = ENTRY + 210;
    assert.ok(noiseWickHigh > oldStop - 1, `noise wick ${noiseWickHigh} should breach old micro stop ${oldStop}`);
    assert.ok(resolved.stopPrice! > noiseWickHigh, "canonical stop above noise wick");

    const input = makeEngineInput(candles, "short");
    const judgment = ftsJudgment("short", resolved);
    const exec = executeRangeRegime(input, judgment);
    assert.equal(exec.side, "short");
    assert.equal(exec.metadata?.stop_basis, FTS_STRUCTURAL_STOP_BASIS);
    assert.equal(exec.stopPrice, resolved.stopPrice);

    const exit = evaluateV2ExitPolicy({
        symbol: "BTCUSDT",
        v2State: {
            shortPosition: {
                symbol: "BTCUSDT",
                side: "short",
                entryPrice: lastPrice,
                sizeUsd: 40,
                entryStage: 0,
                pnlPct: 0.001
            },
            longPosition: null,
            currentPositions: [],
            crashState: "",
            pumpState: ""
        } as any,
        judgment: judgment as any,
        snapshot: { atr: ATR, qualityScore: 82, boxPos: 0.5, boxBreakSide: "none", emaGap: 0, trendWeaknessScore: 0.3, rangeConfidence: 0.7 } as any,
        markPrice: noiseWickHigh
    });
    assert.notEqual(exit.action, "FULL_EXIT", `unexpected exit on noise wick: ${exit.reason}`);
    pass("CASE-A short wick survives", {
        oldStop,
        canonicalStop: resolved.stopPrice,
        noiseWickHigh,
        structuralInvalidation: resolved.structuralInvalidationPrice
    });
}

// CASE B — LONG symmetric wick survival
{
    const candles = buildLongSurvivalCandles();
    const lastPrice = candles[candles.length - 1]!.close;
    const closed = getClosedCandlesForStructuralStop(candles);
    const resolved = resolveFastTrendShiftStructuralStop({
        side: "long",
        entryPrice: lastPrice,
        lastPrice,
        atr: ATR,
        closedCandles: closed,
        boxMid: BOX_MID,
        previousConfirmedBoxHigh: BOX_HIGH,
        previousConfirmedBoxLow: BOX_LOW
    });
    assert.equal(resolved.valid, true);
    const oldSwingLow = candles.length >= 10 ? Math.min(...candles.slice(-10).map((c) => c.low)) : lastPrice * 0.99;
    const oldStop = Math.min(oldSwingLow, BOX_MID * 0.998, lastPrice - ATR * 2);
    const noiseWickLow = ENTRY - 210;
    assert.ok(noiseWickLow < oldStop + 1, "noise wick breaches old micro stop zone");
    assert.ok(resolved.stopPrice! < noiseWickLow, "canonical stop below noise wick");

    const input = makeEngineInput(candles, "long");
    const exec = executeRangeRegime(input, ftsJudgment("long", resolved));
    assert.equal(exec.stopPrice, resolved.stopPrice);

    const exit = evaluateV2ExitPolicy({
        symbol: "BTCUSDT",
        v2State: {
            longPosition: {
                symbol: "BTCUSDT",
                side: "long",
                entryPrice: lastPrice,
                sizeUsd: 40,
                entryStage: 0,
                pnlPct: 0.001
            },
            shortPosition: null,
            currentPositions: [],
            crashState: "",
            pumpState: ""
        } as any,
        judgment: ftsJudgment("long", resolved) as any,
        snapshot: { atr: ATR, qualityScore: 82, boxPos: 0.5, boxBreakSide: "none", emaGap: 0, trendWeaknessScore: 0.3, rangeConfidence: 0.7 } as any,
        markPrice: noiseWickLow
    });
    assert.notEqual(exit.action, "FULL_EXIT", `unexpected exit on noise wick: ${exit.reason}`);
    pass("CASE-B long wick survives", { oldStop, canonicalStop: resolved.stopPrice, noiseWickLow });
}

// CASE C — SHORT true structural invalidation
{
    const candles = buildShortSurvivalCandles();
    const lastPrice = candles[candles.length - 1]!.close;
    const closed = getClosedCandlesForStructuralStop(candles);
    const resolved = resolveFastTrendShiftStructuralStop({
        side: "short",
        entryPrice: lastPrice,
        lastPrice,
        atr: ATR,
        closedCandles: closed,
        boxMid: BOX_MID
    });
    const breachPrice = resolved.stopPrice! + 5;
    assert.equal(isV2StopPriceBreached("short", breachPrice, resolved.stopPrice!), true);
    assert.ok(breachPrice > resolved.structuralInvalidationPrice!);
    pass("CASE-C short true invalidation exits", {
        breachPrice,
        stop: resolved.stopPrice,
        structuralInvalidation: resolved.structuralInvalidationPrice
    });
}

// CASE D — LONG true invalidation
{
    const candles = buildLongSurvivalCandles();
    const lastPrice = candles[candles.length - 1]!.close;
    const closed = getClosedCandlesForStructuralStop(candles);
    const resolved = resolveFastTrendShiftStructuralStop({
        side: "long",
        entryPrice: lastPrice,
        lastPrice,
        atr: ATR,
        closedCandles: closed,
        boxMid: BOX_MID
    });
    const breachPrice = resolved.stopPrice! - 5;
    assert.equal(isV2StopPriceBreached("long", breachPrice, resolved.stopPrice!), true);
    assert.ok(breachPrice < resolved.structuralInvalidationPrice!);
    pass("CASE-D long true invalidation exits", {
        breachPrice,
        stop: resolved.stopPrice,
        structuralInvalidation: resolved.structuralInvalidationPrice
    });
}

// CASE E — risk invariance: wider stop => smaller notional, similar risk budget
{
    const tightStop = ENTRY * 1.005;
    const wideStop = ENTRY * 1.015;
    const sizingBase = {
        symbol: "BTCUSDT",
        side: "short" as const,
        orderKind: "ENTRY" as const,
        accountEquityUsdt: EQUITY,
        availableBalanceUsdt: EQUITY,
        entryReferencePrice: ENTRY,
        appliedLeverage: 10,
        entryQualityGrade: "A" as const,
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        policyRequestedNotionalUsdt: 500,
        roundTripFeeRate: 0,
        lastPrice: ENTRY
    };
    const tight = evaluateEquityAdaptiveSizing({
        ...sizingBase,
        effectiveStopPrice: tightStop
    });
    const wide = evaluateEquityAdaptiveSizing({
        ...sizingBase,
        effectiveStopPrice: wideStop
    });
    assert.equal(tight.sizingPassed, true);
    assert.equal(wide.sizingPassed, true);
    assert.ok(wide.riskBasedNotionalUsdt < tight.riskBasedNotionalUsdt);
    assert.equal(tight.riskPct, RISK_PER_TRADE_PCT);
    assert.equal(wide.riskPct, RISK_PER_TRADE_PCT);
    assert.equal(tight.riskBudgetUsdt, wide.riskBudgetUsdt);
    const tightLoss = tight.actualRiskAtStopUsdt ?? tight.riskBudgetUsdt;
    const wideLoss = wide.actualRiskAtStopUsdt ?? wide.riskBudgetUsdt;
    assert.ok(Math.abs(tightLoss - wideLoss) / tightLoss < 0.05, "estimated loss nearly equal");
    pass("CASE-E risk invariance", {
        tightNotional: tight.riskBasedNotionalUsdt,
        wideNotional: wide.riskBasedNotionalUsdt,
        tightLoss,
        wideLoss
    });
}

// CASE F — addon reachability after probe survives favorable move
{
    const candles = buildShortSurvivalCandles();
    const lastPrice = candles[candles.length - 1]!.close;
    const resolved = resolveFastTrendShiftStructuralStop({
        side: "short",
        entryPrice: lastPrice,
        lastPrice,
        atr: ATR,
        closedCandles: getClosedCandlesForStructuralStop(candles),
        boxMid: BOX_MID
    });
    const judgment = ftsJudgment("short", resolved);
    const exec = executeRangeRegime(makeEngineInput(candles, "short"), judgment);
    const addonPolicy = evaluateV2AddOnPolicy({
        symbol: "BTCUSDT",
        side: "short",
        v2State: {
            shortPosition: {
                symbol: "BTCUSDT",
                side: "short",
                entryPrice: lastPrice,
                sizeUsd: 40,
                entryStage: 1,
                pnlPct: 0.012,
                breakevenStopRequired: true,
                breakevenStopConfirmed: true,
                breakevenStopPrice: lastPrice
            },
            longPosition: null,
            currentPositions: [],
            crashState: "",
            pumpState: "",
            accountEquityKrw: 10_000_000
        } as any,
        judgment: {
            regime_final: "RANGE",
            subtype: "FAST_TREND_SHIFT",
            shockPhase: "NONE",
            rangePhase: "LOWER",
            trendPhase: "DOWN",
            transitionPhase: "NONE",
            htf_entry_policy: "BOTH",
            counter_trend_risk: false
        } as any,
        execution: exec as any,
        snapshot: {
            qualityScore: 82,
            reviewing_ticks: 3,
            boxPos: 0.15,
            emaGap: -0.004,
            trendWeaknessScore: 0.25,
            rangeConfidence: 0.72,
            lastPrice: lastPrice - 200,
            atr: ATR,
            latestCandleTs: Date.now()
        },
        accountEquityUsd: EQUITY,
        currentSymbolNotionalUsd: 40,
        currentGlobalNotionalUsd: 40
    });
    assert.notEqual(addonPolicy.action, "ADDON_FORBIDDEN", `addon blocked: ${addonPolicy.reason}`);
    pass("CASE-F addon evaluation reachable", {
        action: addonPolicy.action,
        reason: addonPolicy.reason,
        addonMode: addonPolicy.addonMode
    });
}

// CASE G — losing thesis => ADDON_FORBIDDEN (no averaging down)
{
    const candles = buildShortSurvivalCandles();
    const lastPrice = candles[candles.length - 1]!.close;
    const resolved = resolveFastTrendShiftStructuralStop({
        side: "short",
        entryPrice: lastPrice,
        lastPrice,
        atr: ATR,
        closedCandles: getClosedCandlesForStructuralStop(candles),
        boxMid: BOX_MID
    });
    const policy = evaluateV2AddOnPolicy({
        symbol: "BTCUSDT",
        side: "short",
        v2State: {
            shortPosition: {
                symbol: "BTCUSDT",
                side: "short",
                entryPrice: lastPrice,
                sizeUsd: 40,
                entryStage: 1,
                pnlPct: -0.008,
                breakevenStopRequired: true,
                breakevenStopConfirmed: false
            },
            longPosition: null,
            currentPositions: [],
            crashState: "",
            pumpState: ""
        } as any,
        judgment: ftsJudgment("short", resolved) as any,
        execution: executeRangeRegime(makeEngineInput(candles, "short"), ftsJudgment("short", resolved)) as any,
        snapshot: {
            qualityScore: 82,
            reviewing_ticks: 3,
            boxPos: 0.15,
            emaGap: -0.004,
            trendWeaknessScore: 0.85,
            rangeConfidence: 0.72,
            lastPrice: lastPrice + 100,
            atr: ATR
        },
        accountEquityUsd: EQUITY,
        currentSymbolNotionalUsd: 40,
        currentGlobalNotionalUsd: 40
    });
    assert.equal(policy.action, "ADDON_FORBIDDEN");
    pass("CASE-G losing thesis addon forbidden", { reason: policy.reason });
}

// CASE H — 40 USDT hard cap preserved with wider structural stop
{
    const cap = resolveEffectiveLiveOrderNotionalCap({
        legacyStaticCapUsdt: 40,
        emergencyCapUsdt: 500
    });
    assert.equal(cap.effectiveLiveCapUsdt, 40);
    const wideStop = ENTRY * 1.012;
    const sized = evaluateEquityAdaptiveSizing({
        symbol: "BTCUSDT",
        side: "short",
        orderKind: "ENTRY",
        accountEquityUsdt: EQUITY,
        availableBalanceUsdt: EQUITY,
        entryReferencePrice: ENTRY,
        effectiveStopPrice: wideStop,
        appliedLeverage: 10,
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        policyRequestedNotionalUsdt: 500,
        legacyStaticCapUsdt: 40,
        emergencyAbsoluteCapUsdt: 500,
        lastPrice: ENTRY,
        instrumentSizing: { lotSz: 0.01, minSz: 0.01, ctVal: 0.01, ctValCcy: "BTC" }
    });
    assert.equal(sized.effectiveLiveCapUsdt, 40);
    assert.ok((sized.normalizedNotionalUsdt ?? sized.finalOrderNotionalUsdt) <= 40 + 1e-6);
    pass("CASE-H 40 USDT cap", {
        effective_live_cap_usdt: sized.effectiveLiveCapUsdt,
        normalized_notional_usdt: sized.normalizedNotionalUsdt
    });
}

// CASE I — canonical stop preserved when wider than micro ATR but within 3% safety max
{
    const candles = buildShortSurvivalCandles();
    const lastPrice = candles[candles.length - 1]!.close;
    const resolved = resolveFastTrendShiftStructuralStop({
        side: "short",
        entryPrice: lastPrice,
        lastPrice,
        atr: ATR,
        closedCandles: getClosedCandlesForStructuralStop(candles),
        boxMid: BOX_MID
    });
    const execution: ExecutorOutput = {
        signal: "SHORT_CANDIDATE",
        side: "short",
        reason: "FAST_SHIFT_SHORT",
        baseSizeIntent: 0.32,
        recheckSuggested: true,
        isAddOnEligible: false,
        stopPrice: resolved.stopPrice,
        invalidationPx: resolved.stopPrice,
        metadata: { stop_basis: FTS_STRUCTURAL_STOP_BASIS, fast_trend_shift: true }
    };
    const judgment = ftsJudgment("short", resolved);
    const logs = captureProofLogs(() => {
        const block = ensurePromotedEntryRiskPlan(
            execution,
            "ENTER",
            "short",
            null,
            { symbol: "BTCUSDT", lastPrice, atr: ATR, candles, boxHigh: BOX_HIGH, boxLow: BOX_LOW },
            judgment as any,
            null
        );
        assert.equal(block, null);
    });
    assert.equal(execution.stopPrice, resolved.stopPrice);
    const proof = logs.find((l) => l.event === "V2_PROMOTED_ENTRY_RISK_PLAN_PROOF");
    assert.equal(proof?.selectedStopSource, "existing_valid");
    pass("CASE-I canonical stop preserved within safety max", {
        stop: execution.stopPrice,
        distPct: resolved.stopDistancePct
    });
}

// CASE J — canonical stop beyond safety max => STOP_DISTANCE_TOO_WIDE, no tighter fallback ENTER
{
    const entryPrice = 70_000;
    const tooWideStop = entryPrice * 1.04;
    const execution: ExecutorOutput = {
        signal: "SHORT_CANDIDATE",
        side: "short",
        reason: "FAST_SHIFT_SHORT",
        baseSizeIntent: 0.32,
        recheckSuggested: true,
        isAddOnEligible: false,
        stopPrice: tooWideStop,
        invalidationPx: tooWideStop,
        metadata: { stop_basis: FTS_STRUCTURAL_STOP_BASIS, fast_trend_shift: true }
    };
    const judgment = {
        subtype: "FAST_TREND_SHIFT",
        regime: "RANGE"
    } as any;
    const block = ensurePromotedEntryRiskPlan(
        execution,
        "ENTER",
        "short",
        null,
        { symbol: "BTCUSDT", lastPrice: entryPrice, atr: ATR, candles: [], boxHigh: BOX_HIGH, boxLow: BOX_LOW },
        judgment,
        null
    );
    assert.equal(block, "STOP_DISTANCE_TOO_WIDE");
    assert.equal(execution.stopPrice, null);
    pass("CASE-J too wide canonical stop fail-closed", { block, tooWideStop });
}

// Proof invariant — detector mirror == executor == promoted == adaptive committed
{
    const candles = buildShortSurvivalCandles();
    const input = makeEngineInput(candles, "short");
    const lastPrice = candles[candles.length - 1]!.close;
    const regime = detectMarketRegime(input);
    const fts = regime.diagnostics?.fastTrendShift;
    const judgment = ftsJudgment("short", resolveFastTrendShiftStructuralStop({
        side: "short",
        entryPrice: lastPrice,
        lastPrice,
        atr: ATR,
        closedCandles: getClosedCandlesForStructuralStop(candles),
        boxMid: BOX_MID
    }));
    const exec = executeRangeRegime(input, judgment);
    const executionCopy: ExecutorOutput = { ...exec, metadata: { ...exec.metadata } };
    ensurePromotedEntryRiskPlan(
        executionCopy,
        "ENTER",
        "short",
        null,
        input.snapshot,
        judgment as any,
        null
    );
    const adaptive = computeAdaptiveRangePreEntryProtection({
        side: "short",
        entryPx: lastPrice,
        rawStructuralSl: executionCopy.stopPrice!,
        rawPolicySl: executionCopy.stopPrice!,
        rawPolicyTp: lastPrice - 100,
        atr: ATR,
        boxHigh: BOX_HIGH,
        boxLow: BOX_LOW,
        boxMid: BOX_MID,
        preserveCanonicalStructuralStop: true
    });
    assert.equal(adaptive.ok, true);
    assert.equal(fts?.stop_price, exec.stopPrice);
    assert.equal(executionCopy.stopPrice, exec.stopPrice);
    if (adaptive.ok) {
        assert.ok(adaptive.slPrice >= exec.stopPrice! - 1e-6, "adaptive must not tighten canonical stop");
    }
    pass("PROOF-INVARIANT chain", {
        detector_stop: fts?.stop_price,
        executor_stop: exec.stopPrice,
        promoted_stop: executionCopy.stopPrice,
        adaptive_stop: adaptive.ok ? adaptive.slPrice : null,
        structural_source: fts?.structural_source
    });
}

// Old vs new stop distance + contract count illustration
{
    const candles = buildShortSurvivalCandles();
    const lastPrice = candles[candles.length - 1]!.close;
    const resolved = resolveFastTrendShiftStructuralStop({
        side: "short",
        entryPrice: lastPrice,
        lastPrice,
        atr: ATR,
        closedCandles: getClosedCandlesForStructuralStop(candles),
        boxMid: BOX_MID
    });
    const oldStop = oldMicroProbeStopShort(lastPrice, ATR, candles);
    const oldSized = evaluateEquityAdaptiveSizing({
        symbol: "BTCUSDT",
        side: "short",
        orderKind: "ENTRY",
        accountEquityUsdt: EQUITY,
        availableBalanceUsdt: EQUITY,
        entryReferencePrice: lastPrice,
        effectiveStopPrice: oldStop,
        appliedLeverage: 10,
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        policyRequestedNotionalUsdt: 500,
        lastPrice
    });
    const newSized = evaluateEquityAdaptiveSizing({
        symbol: "BTCUSDT",
        side: "short",
        orderKind: "ENTRY",
        accountEquityUsdt: EQUITY,
        availableBalanceUsdt: EQUITY,
        entryReferencePrice: lastPrice,
        effectiveStopPrice: resolved.stopPrice,
        appliedLeverage: 10,
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        policyRequestedNotionalUsdt: 500,
        lastPrice
    });
    pass("OLD-vs-NEW sizing illustration", {
        oldStop,
        newStop: resolved.stopPrice,
        oldDistPct: (oldStop - lastPrice) / lastPrice,
        newDistPct: resolved.stopDistancePct,
        oldNotional: oldSized.riskBasedNotionalUsdt,
        newNotional: newSized.riskBasedNotionalUsdt,
        riskBudgetUsdt: newSized.riskBudgetUsdt
    });
}

console.log("[FTS-PROBE-SURVIVAL] ALL CASES PASSED");
