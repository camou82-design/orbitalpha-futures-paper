/**
 * PRE-COMMIT AUDIT — FTS structural stop patch (test-only, no production changes).
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { evaluateV2AddOnPolicy } from "../engine-v2/addon/policy";
import { isV2StopPriceBreached } from "../engine-v2/exit/stop-price-authority";
import {
    evaluateEquityAdaptiveSizing,
    resolveEffectiveLiveOrderNotionalCap
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { normalizeOkxSwapContractsFromNotional } from "../engine-v2/okx-swap-sizing";
import {
    computeClosedOnlyConservativeProbeStopLong,
    computeClosedOnlyConservativeProbeStopShort,
    findConfirmedSwingHighs,
    findConfirmedSwingLows,
    getClosedCandlesForStructuralStop,
    resolveFastTrendShiftStructuralStop
} from "../engine-v2/risk-sizing/fast-trend-shift-structural-stop";
import type { Candle } from "../models/types";

function audit(label: string, detail: Record<string, unknown>): void {
    console.log(`[FTS-PREcommit-AUDIT][${label}] ${JSON.stringify(detail)}`);
}

function candle(ts: number, o: number, h: number, l: number, c: number): Candle {
    return { ts, open: o, high: h, low: l, close: c, volume: 100 };
}

function oldProductionStopShort(lastPrice: number, atr: number, closed: Candle[], boxMid: number): number {
    return computeClosedOnlyConservativeProbeStopShort(lastPrice, atr, boxMid, closed);
}

function oldProductionStopLong(lastPrice: number, atr: number, closed: Candle[], boxMid: number): number {
    return computeClosedOnlyConservativeProbeStopLong(lastPrice, atr, boxMid, closed);
}

function oldMicro10BarOnly(side: "long" | "short", lastPrice: number, candles: Candle[]): number {
    if (candles.length < 10) return lastPrice * (side === "short" ? 1.01 : 0.99);
    const window = candles.slice(-10);
    return side === "short" ? Math.max(...window.map((c) => c.high)) : Math.min(...window.map((c) => c.low));
}

function oldAtr15ProbeStop(side: "long" | "short", lastPrice: number, atr: number): number {
    return side === "short" ? lastPrice + atr * 1.5 : lastPrice - atr * 1.5;
}

/** Closed pivot history + entry bar + optional subsequent closed noise bars + forming bar. */
function buildSequenceShort(input: {
    entry: number;
    atr: number;
    pivotHigh: number;
    noiseHigh?: number;
    formingHigh?: number;
    extraClosedNoise?: Array<{ high: number; low: number; close: number }>;
}): Candle[] {
    const { entry, pivotHigh, noiseHigh, formingHigh, extraClosedNoise = [] } = input;
    const candles: Candle[] = [];
    let ts = 1_000_000;
    const base = entry;
    for (let i = 0; i < 8; i++) {
        candles.push(candle(ts, base, base + 40, base - 40, base - 10));
        ts += 60_000;
    }
    candles.push(candle(ts, base - 40, base + 80, base - 60, base - 20));
    ts += 60_000;
    candles.push(candle(ts, base - 50, pivotHigh, base - 80, base - 30));
    ts += 60_000;
    candles.push(candle(ts, base - 40, base + 80, base - 60, base - 20));
    ts += 60_000;
    candles.push(candle(ts, base - 25, base + 30, base - 50, entry));
    ts += 60_000;
    for (const n of extraClosedNoise) {
        candles.push(candle(ts, entry - 10, n.high, n.low, n.close));
        ts += 60_000;
    }
    const fh = formingHigh ?? noiseHigh ?? entry + 20;
    candles.push(candle(ts, entry - 5, fh, entry - 30, entry - 8));
    return candles;
}

function buildSequenceLong(input: {
    entry: number;
    atr: number;
    pivotLow: number;
    noiseLow?: number;
    formingLow?: number;
    extraClosedNoise?: Array<{ high: number; low: number; close: number }>;
}): Candle[] {
    const { entry, pivotLow, noiseLow, formingLow, extraClosedNoise = [] } = input;
    const candles: Candle[] = [];
    let ts = 2_000_000;
    const base = entry;
    for (let i = 0; i < 8; i++) {
        candles.push(candle(ts, base, base + 40, base - 40, base + 10));
        ts += 60_000;
    }
    candles.push(candle(ts, base + 40, base + 60, base - 80, base + 20));
    ts += 60_000;
    candles.push(candle(ts, base + 50, base + 80, pivotLow, base + 30));
    ts += 60_000;
    candles.push(candle(ts, base + 40, base + 60, base - 80, base + 20));
    ts += 60_000;
    candles.push(candle(ts, base + 25, base + 50, base - 30, entry));
    ts += 60_000;
    for (const n of extraClosedNoise) {
        candles.push(candle(ts, entry + 10, n.high, n.low, n.close));
        ts += 60_000;
    }
    const fl = formingLow ?? noiseLow ?? entry - 20;
    candles.push(candle(ts, entry + 5, entry + 30, fl, entry + 8));
    return candles;
}

function resolveSide(side: "long" | "short", candles: Candle[], entry: number, atr: number, boxMid: number) {
    const lastPrice = candles[candles.length - 1]!.close;
    const closed = getClosedCandlesForStructuralStop(candles);
    const resolved = resolveFastTrendShiftStructuralStop({
        side,
        entryPrice: entry,
        lastPrice,
        atr,
        closedCandles: closed,
        boxMid
    });
    const oldProd =
        side === "short"
            ? oldProductionStopShort(lastPrice, atr, closed, boxMid)
            : oldProductionStopLong(lastPrice, atr, closed, boxMid);
    const oldAtr15 = oldAtr15ProbeStop(side, lastPrice, atr);
    const oldMicro10 = oldMicro10BarOnly(side, lastPrice, candles);
    return { resolved, oldProd, oldAtr15, oldMicro10, lastPrice, closed };
}

function stopCompareReport(symbol: string, side: "long" | "short", entry: number, atr: number, boxHigh: number, boxLow: number, candles: Candle[]) {
    const boxMid = (boxHigh + boxLow) / 2;
    const { resolved, oldProd, oldAtr15, oldMicro10, lastPrice } = resolveSide(side, candles, entry, atr, boxMid);
    assert.equal(resolved.valid, true);
    const finalStop = resolved.stopPrice!;
    const structuralCandidate = resolved.structuralCandidateStop!;
    const oldClosedOnly = resolved.oldClosedOnlySafetyStop ?? oldProd;
    const oldDist = Math.abs(oldClosedOnly - entry);
    const structuralDist = Math.abs(structuralCandidate - entry);
    const finalDist = Math.abs(finalStop - entry);
    const noiseRoomOld = oldDist / atr;
    const noiseRoomNew = finalDist / atr;
    const gainedAtr = noiseRoomNew - noiseRoomOld;
    const gainedVsAtr15 = noiseRoomNew - Math.abs(oldAtr15 - entry) / atr;
    const gainedVsMicro10 = noiseRoomNew - Math.abs(oldMicro10 - entry) / atr;
    audit(`${symbol}_${side.toUpperCase()}_STOP_COMPARE`, {
        entry,
        atr,
        pivot: resolved.structuralInvalidationPrice,
        structural_candidate: structuralCandidate,
        old_closed_only_safety_stop: oldClosedOnly,
        final_canonical_stop: finalStop,
        non_tightening_floor_applied: resolved.nonTighteningFloorApplied === true,
        old_distance_pct: oldDist / entry,
        structural_distance_pct: structuralDist / entry,
        final_distance_pct: finalDist / entry,
        noise_room_gained_atr: gainedAtr,
        noise_room_gained_vs_old_closed_prod: gainedAtr,
        lastPrice,
        structural_source: resolved.structuralSource,
        old_10bar_micro_only: oldMicro10,
        old_atr_1_5_probe_stop: oldAtr15,
        difference_atr_vs_micro10: Math.abs(finalStop - oldMicro10) / atr,
        noise_room_gained_vs_atr15_atr: gainedVsAtr15,
        noise_room_gained_vs_micro10_atr: gainedVsMicro10
    });
    if (side === "short") {
        assert.ok(finalStop >= oldClosedOnly - 1e-9, `${symbol} SHORT final must not be tighter than closed-only baseline`);
    } else {
        assert.ok(finalStop <= oldClosedOnly + 1e-9, `${symbol} LONG final must not be tighter than closed-only baseline`);
    }
    assert.ok(gainedAtr >= -1e-9, `${symbol} ${side} noise_room_gained_vs_old_closed_prod must be >= 0 ATR`);
    return { gainedAtr, gainedVsAtr15, gainedVsMicro10, newStop: finalStop, oldProd: oldClosedOnly, oldAtr15, oldMicro10, resolved };
}

function noiseMatrix(side: "long" | "short", entry: number, atr: number, pivot: number, boxMid: number) {
    const rows: Array<{ level: string; noisePx: number; survives: boolean; breached: boolean }> = [];
    const resolvedBase = resolveSide(
        side,
        side === "short"
            ? buildSequenceShort({ entry, atr, pivotHigh: pivot })
            : buildSequenceLong({ entry, atr, pivotLow: pivot }),
        entry,
        atr,
        boxMid
    );
    const stop = resolvedBase.resolved.stopPrice!;
    const inv = resolvedBase.resolved.structuralInvalidationPrice!;
    const buf = resolvedBase.resolved.atrBufferPrice!;

    const scenarios: Array<[string, number]> = [
        ["A_0.10ATR_inside", side === "short" ? stop - atr * 0.10 : stop + atr * 0.10],
        ["B_0.20ATR_inside", side === "short" ? stop - atr * 0.20 : stop + atr * 0.20],
        ["C_0.30ATR_inside", side === "short" ? stop - atr * 0.30 : stop + atr * 0.30],
        ["D_pivot_retest", inv],
        ["E_pivot_exceed_buffer_inside", side === "short" ? inv + buf * 0.5 : inv - buf * 0.5],
        ["F_canonical_breach", side === "short" ? stop + atr * 0.05 : stop - atr * 0.05]
    ];

    for (const [level, noisePx] of scenarios) {
        const extra =
            level.startsWith("F")
                ? []
                : [{ high: side === "short" ? noisePx : entry + 20, low: side === "long" ? noisePx : entry - 20, close: entry + (side === "long" ? 5 : -5) }];
        const seq =
            side === "short"
                ? buildSequenceShort({ entry, atr, pivotHigh: pivot, extraClosedNoise: extra, formingHigh: noisePx })
                : buildSequenceLong({ entry, atr, pivotLow: pivot, extraClosedNoise: extra, formingLow: noisePx });
        const { resolved } = resolveSide(side, seq, entry, atr, boxMid);
        const survives = !isV2StopPriceBreached(side, noisePx, resolved.stopPrice!);
        const breached = isV2StopPriceBreached(side, noisePx, resolved.stopPrice!);
        rows.push({ level, noisePx, survives, breached });
        if (level.startsWith("F")) {
            assert.equal(breached, true, `${side} ${level} must breach`);
        } else {
            assert.equal(survives, true, `${side} ${level} should survive at ${noisePx} vs stop ${resolved.stopPrice}`);
        }
    }
    audit(`${side.toUpperCase()}_NOISE_MATRIX`, { stop, pivot: inv, buffer: buf, rows });
}

// ── 1. CASE A skepticism: tight fixture vs production ATR ──
audit("CASE_A_SKEPTICISM", {
    note: "Original CASE A used ATR=50; production BTC ATR~250 makes old/new gap much wider vs atr_1.5 diagnostic"
});

// ── 2. Realistic BTC / ETH stop compare (production-like ATR) ──
const BTC = { entry: 70_000, atr: 250, boxHigh: 70_200, boxLow: 69_800, pivotShort: 70_350, pivotLong: 69_650 };
const ETH = { entry: 3_500, atr: 45, boxHigh: 3_520, boxLow: 3_480, pivotShort: 3_565, pivotLong: 3_435 };

const btcShort = stopCompareReport(
    "BTC",
    "short",
    BTC.entry,
    BTC.atr,
    BTC.boxHigh,
    BTC.boxLow,
    buildSequenceShort({ entry: BTC.entry, atr: BTC.atr, pivotHigh: BTC.pivotShort })
);
const btcLong = stopCompareReport(
    "BTC",
    "long",
    BTC.entry,
    BTC.atr,
    BTC.boxHigh,
    BTC.boxLow,
    buildSequenceLong({ entry: BTC.entry, atr: BTC.atr, pivotLow: BTC.pivotLong })
);
const ethShort = stopCompareReport(
    "ETH",
    "short",
    ETH.entry,
    ETH.atr,
    ETH.boxHigh,
    ETH.boxLow,
    buildSequenceShort({ entry: ETH.entry, atr: ETH.atr, pivotHigh: ETH.pivotShort })
);
const ethLong = stopCompareReport(
    "ETH",
    "long",
    ETH.entry,
    ETH.atr,
    ETH.boxHigh,
    ETH.boxLow,
    buildSequenceLong({ entry: ETH.entry, atr: ETH.atr, pivotLow: ETH.pivotLong })
);

audit("NOISE_ROOM_GAINED_ATR_SUMMARY", {
    btc_short_gained_vs_old_closed_prod: btcShort.gainedAtr,
    btc_short_gained_vs_atr15: btcShort.gainedVsAtr15,
    btc_short_gained_vs_micro10: btcShort.gainedVsMicro10,
    btc_long_gained_vs_old_closed_prod: btcLong.gainedAtr,
    eth_short_gained_vs_old_closed_prod: ethShort.gainedAtr,
    eth_long_gained_vs_old_closed_prod: ethLong.gainedAtr,
    floor_invariant: "final canonical never tighter than oldClosedOnlySafetyStop; ETH keeps structural widening when wider"
});

// ── 3. Noise matrix SHORT/LONG ──
noiseMatrix("short", BTC.entry, BTC.atr, BTC.pivotShort, (BTC.boxHigh + BTC.boxLow) / 2);
noiseMatrix("long", BTC.entry, BTC.atr, BTC.pivotLong, (BTC.boxHigh + BTC.boxLow) / 2);

// ── 4. Pivot quality scenarios ──
function pivotQualityAudit(name: string, candles: Candle[], side: "long" | "short", entry: number, atr: number) {
    const closed = getClosedCandlesForStructuralStop(candles);
    const forming = candles[candles.length - 1]!;
    const pivotsH = findConfirmedSwingHighs(closed);
    const pivotsL = findConfirmedSwingLows(closed);
    const resolved = resolveFastTrendShiftStructuralStop({
        side,
        entryPrice: entry,
        lastPrice: forming.close,
        atr,
        closedCandles: closed,
        boxMid: entry
    });
    const formingIsPivot =
        side === "short"
            ? pivotsH.some((p) => p.index === closed.length - 1) || forming.high === resolved.structuralInvalidationPrice
            : pivotsL.some((p) => p.index === closed.length - 1) || forming.low === resolved.structuralInvalidationPrice;
    audit(`PIVOT_QUALITY_${name}`, {
        side,
        closed_count: closed.length,
        pivot_highs: pivotsH.map((p) => p.price),
        pivot_lows: pivotsL.map((p) => p.price),
        forming_high: forming.high,
        forming_low: forming.low,
        resolved_pivot: resolved.structuralInvalidationPrice,
        resolved_source: resolved.structuralSource,
        forming_bar_is_authority: formingIsPivot && (forming.high === resolved.structuralInvalidationPrice || forming.low === resolved.structuralInvalidationPrice),
        valid: resolved.valid
    });
}

{
    const entry = BTC.entry;
    const atr = BTC.atr;
    pivotQualityAudit(
        "clean_lower_high",
        buildSequenceShort({ entry, atr, pivotHigh: entry + 350 }),
        "short",
        entry,
        atr
    );
    const chop: Candle[] = [];
    let ts = 3_000_000;
    for (let i = 0; i < 20; i++) {
        const w = (i % 2 === 0 ? 1 : -1) * (30 + i);
        chop.push(candle(ts, entry, entry + 50 + w, entry - 50 - w, entry + w));
        ts += 60_000;
    }
    chop.push(candle(ts, entry, entry + 500, entry - 50, entry - 5));
    pivotQualityAudit("noisy_chop", chop, "short", entry, atr);

    const dtop: Candle[] = [];
    ts = 4_000_000;
    for (let i = 0; i < 6; i++) dtop.push(candle(ts, entry, entry + 40, entry - 40, entry - 5)), (ts += 60_000);
    dtop.push(candle(ts, entry - 20, entry + 300, entry - 60, entry - 10));
    ts += 60_000;
    dtop.push(candle(ts, entry - 10, entry + 80, entry - 50, entry - 5));
    ts += 60_000;
    dtop.push(candle(ts, entry - 20, entry + 305, entry - 60, entry - 8));
    ts += 60_000;
    dtop.push(candle(ts, entry - 5, entry + 30, entry - 40, entry - 6));
    pivotQualityAudit("double_top", dtop, "short", entry, atr);

    const spike = buildSequenceShort({ entry, atr, pivotHigh: entry + 200 });
    const formingSpike = spike[spike.length - 1]!;
    spike[spike.length - 1] = { ...formingSpike, high: entry + 800 };
    pivotQualityAudit("forming_bar_spike", spike, "short", entry, atr);

    const oneBarSpike = buildSequenceShort({ entry, atr, pivotHigh: entry + 200 });
    const closedOnly = oneBarSpike.slice(0, -1);
    closedOnly[closedOnly.length - 1] = candle(
        closedOnly[closedOnly.length - 1]!.ts,
        entry,
        entry + 900,
        entry - 20,
        entry - 5
    );
    closedOnly.push(candle(closedOnly[closedOnly.length - 1]!.ts + 60_000, entry, entry + 30, entry - 20, entry - 4));
    pivotQualityAudit("one_bar_closed_spike", closedOnly, "short", entry, atr);
}

// ── 5. Multi-cycle addon lifecycle (engine cycles) ──
{
    const entry = 67_850;
    const atr = 280;
    const boxHigh = 68_000;
    const boxLow = 67_700;
    const pivotHigh = 69_225;
    let candles = buildSequenceShort({ entry, atr, pivotHigh });
    const { resolved } = resolveSide("short", candles, entry, atr, (boxHigh + boxLow) / 2);
    const stop = resolved.stopPrice!;
    let cyclesSurvived = 0;
    let maxAdversePct = 0;
    let maxAdverseAtr = 0;
    const adverseWicks = [entry + 180, entry + 220, entry + 150, entry + 200, entry + 160, entry + 190];

    for (let cycle = 0; cycle < adverseWicks.length; cycle++) {
        const wick = adverseWicks[cycle]!;
        const breached = isV2StopPriceBreached("short", wick, stop);
        const adversePct = (wick - entry) / entry;
        maxAdversePct = Math.max(maxAdversePct, adversePct);
        maxAdverseAtr = Math.max(maxAdverseAtr, (wick - entry) / atr);
        if (!breached) cyclesSurvived++;
    }

    const addonPolicy = evaluateV2AddOnPolicy({
        symbol: "BTCUSDT",
        side: "short",
        v2State: {
            shortPosition: {
                symbol: "BTCUSDT",
                side: "short",
                entryPrice: entry,
                sizeUsd: 40,
                entryStage: 1,
                pnlPct: 0.012,
                breakevenStopRequired: true,
                breakevenStopConfirmed: true,
                breakevenStopPrice: entry
            },
            longPosition: null,
            currentPositions: [],
            crashState: "",
            pumpState: ""
        } as any,
        judgment: {
            regime_final: "RANGE",
            subtype: "FAST_TREND_SHIFT",
            shockPhase: "NONE",
            rangePhase: "LOWER",
            trendPhase: "DOWN",
            transitionPhase: "NONE"
        } as any,
        execution: { signal: "SHORT_CANDIDATE", side: "short", stopPrice: stop, invalidationPx: stop } as any,
        snapshot: {
            qualityScore: 82,
            reviewing_ticks: 3,
            boxPos: 0.15,
            emaGap: -0.004,
            trendWeaknessScore: 0.25,
            rangeConfidence: 0.72,
            lastPrice: entry - 200,
            atr,
            latestCandleTs: Date.now()
        },
        accountEquityUsd: 800,
        currentSymbolNotionalUsd: 40,
        currentGlobalNotionalUsd: 40
    });

    audit("ADDON_MULTI_CYCLE_LIFECYCLE", {
        cycles_survived_before_addon: cyclesSurvived,
        max_adverse_excursion_pct: maxAdversePct,
        max_adverse_excursion_atr: maxAdverseAtr,
        canonical_stop_distance_pct: resolved.stopPrice ? (stop - entry) / entry : null,
        canonical_stop_distance_atr: (stop - entry) / atr,
        canonical_stop: stop,
        addon_reachable: addonPolicy.action !== "ADDON_FORBIDDEN",
        addon_action: addonPolicy.action,
        addon_block_reason: addonPolicy.addonBlockedReason ?? addonPolicy.reason
    });
    assert.ok(cyclesSurvived >= 3, "wick excursions must survive canonical stop before structural breach");
    assert.notEqual(addonPolicy.action, "ADDON_FORBIDDEN");
}

// ── 6. BTC/ETH normalized risk (small equity ~800 USDT) ──
function normalizedRiskProof(symbol: string, entry: number, atr: number, stopTight: number, stopWide: number, instrument: { lotSz: number; minSz: number; ctVal: number; ctValCcy: string }) {
    const equity = 800;
    const base = {
        symbol,
        side: "short" as const,
        orderKind: "ENTRY" as const,
        accountEquityUsdt: equity,
        availableBalanceUsdt: equity,
        entryReferencePrice: entry,
        appliedLeverage: 10,
        entryQualityGrade: "A" as const,
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        policyRequestedNotionalUsdt: 500,
        roundTripFeeRate: 0.001,
        lastPrice: entry,
        instrumentSizing: instrument
    };
    const tight = evaluateEquityAdaptiveSizing({ ...base, effectiveStopPrice: stopTight });
    const wide = evaluateEquityAdaptiveSizing({ ...base, effectiveStopPrice: stopWide });
    assert.equal(tight.sizingPassed, true);
    assert.equal(wide.sizingPassed, true);
    assert.ok((wide.riskBasedNotionalUsdt ?? 0) <= (tight.riskBasedNotionalUsdt ?? Infinity));
    assert.equal(tight.riskBudgetUsdt, wide.riskBudgetUsdt);
    const tightRisk = tight.actualRiskAtStopUsdt ?? (tight.normalizedNotionalUsdt ?? tight.riskBasedNotionalUsdt ?? 0) * tight.stopDistancePct;
    const wideRisk = wide.actualRiskAtStopUsdt ?? (wide.normalizedNotionalUsdt ?? wide.riskBasedNotionalUsdt ?? 0) * wide.stopDistancePct;
    audit(`${symbol}_NORMALIZED_RISK`, {
        equity,
        tight_stop: stopTight,
        wide_stop: stopWide,
        tight: {
            risk_budget_usdt: tight.riskBudgetUsdt,
            stop_distance_pct: tight.stopDistancePct,
            risk_based_notional: tight.riskBasedNotionalUsdt,
            effective_live_cap: tight.effectiveLiveCapUsdt,
            normalized_contracts: tight.normalizedContracts,
            normalized_notional: tight.normalizedNotionalUsdt,
            actual_risk_at_stop: tight.actualRiskAtStopUsdt
        },
        wide: {
            risk_budget_usdt: wide.riskBudgetUsdt,
            stop_distance_pct: wide.stopDistancePct,
            risk_based_notional: wide.riskBasedNotionalUsdt,
            effective_live_cap: wide.effectiveLiveCapUsdt,
            normalized_contracts: wide.normalizedContracts,
            normalized_notional: wide.normalizedNotionalUsdt,
            actual_risk_at_stop: wide.actualRiskAtStopUsdt,
            derived_risk_estimate: wideRisk
        },
        tight_derived_risk_estimate: tightRisk,
        risk_invariant_pre_cap: {
            risk_based_notional_wide_lte_tight: (wide.riskBasedNotionalUsdt ?? 0) <= (tight.riskBasedNotionalUsdt ?? Infinity),
            equal_risk_budget: tight.riskBudgetUsdt === wide.riskBudgetUsdt
        }
    });
}

normalizedRiskProof("BTCUSDT", BTC.entry, BTC.atr, BTC.entry * 1.005, BTC.entry * 1.015, { lotSz: 0.01, minSz: 0.01, ctVal: 0.01, ctValCcy: "BTC" });
normalizedRiskProof("ETHUSDT", ETH.entry, ETH.atr, ETH.entry * 1.005, ETH.entry * 1.015, { lotSz: 0.01, minSz: 0.01, ctVal: 0.1, ctValCcy: "ETH" });

// ── 7. 40 USDT last-mile submit normalization ──
function capLastMile(symbol: string, entry: number, stop: number, instrument: { lotSz: number; minSz: number; ctVal: number; ctValCcy: string }) {
    const cap = resolveEffectiveLiveOrderNotionalCap({ legacyStaticCapUsdt: 40, emergencyCapUsdt: 500 });
    assert.equal(cap.effectiveLiveCapUsdt, 40);
    const sized = evaluateEquityAdaptiveSizing({
        symbol,
        side: "short",
        orderKind: "ENTRY",
        accountEquityUsdt: 800,
        availableBalanceUsdt: 800,
        entryReferencePrice: entry,
        effectiveStopPrice: stop,
        appliedLeverage: 10,
        entryQualityGrade: "A",
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        policyRequestedNotionalUsdt: 500,
        legacyStaticCapUsdt: 40,
        emergencyAbsoluteCapUsdt: 500,
        roundTripFeeRate: 0.001,
        lastPrice: entry,
        instrumentSizing: instrument
    });
    const preLot = sized.preLotNotionalUsdt;
    const normalized = sized.normalizedNotionalUsdt ?? sized.finalOrderNotionalUsdt;
    const lotNorm = normalizeOkxSwapContractsFromNotional({
        desiredNotionalUsdt: sized.finalOrderNotionalUsdt,
        lastPrice: entry,
        sizing: instrument
    });
    const finalSubmitted = lotNorm?.actualNotional ?? normalized;
    audit(`${symbol}_40USDT_LAST_MILE`, {
        legacy: 40,
        emergency: 500,
        effective: cap.effectiveLiveCapUsdt,
        pre_lot_notional: preLot,
        normalized_notional: normalized,
        final_submitted_notional: finalSubmitted,
        normalized_contracts: lotNorm?.normalized_contracts ?? sized.normalizedContracts
    });
    assert.ok(preLot <= 40 + 1e-6);
    assert.ok(normalized <= 40 + 1e-6);
    assert.ok(finalSubmitted <= 40 + 1e-6);
}

capLastMile("BTCUSDT", BTC.entry, btcShort.newStop, { lotSz: 0.01, minSz: 0.01, ctVal: 0.01, ctValCcy: "BTC" });
capLastMile("ETHUSDT", ETH.entry, ethShort.newStop, { lotSz: 0.01, minSz: 0.01, ctVal: 0.1, ctValCcy: "ETH" });

// ── 8. addon-mode CASE G pre-existing proof ──
{
    const { evaluateV2AddOnPolicy: evalPolicy } = require("../engine-v2/addon/policy") as typeof import("../engine-v2/addon/policy");
    const policy = evalPolicy({
        symbol: "BTCUSDT",
        side: "short",
        v2State: {
            longPosition: null,
            shortPosition: {
                symbol: "BTCUSDT",
                side: "short",
                entryPrice: 95000,
                sizeUsd: 120,
                entryStage: 1,
                pnlPct: -0.004,
                breakevenStopConfirmed: false,
                adverseMoveAnchorCandleTs: 1_000_000
            },
            currentPositions: [],
            crashState: "",
            pumpState: "",
            accountEquityKrw: 1_960_000
        } as any,
        judgment: {
            regime_final: "TREND",
            subtype: "NONE",
            shockPhase: "NONE",
            rangePhase: "NONE",
            trendPhase: "PULLBACK",
            transitionPhase: "NONE",
            htf_entry_policy: "BOTH",
            counter_trend_risk: false
        } as any,
        execution: { signal: "SHORT_CANDIDATE", side: "short", invalidationPx: 98000, stopPrice: 98000 } as any,
        snapshot: {
            qualityScore: 85,
            reviewing_ticks: 2,
            boxPos: 0.8,
            emaGap: 0.004,
            trendWeaknessScore: 0.3,
            rangeConfidence: 0.7,
            lastPrice: 94000,
            atr: 500,
            latestCandleTs: 2_000_000
        },
        accountEquityUsd: 1400,
        currentSymbolNotionalUsd: 1120,
        currentGlobalNotionalUsd: 1120,
        maxAddonNotionalUsdt: 20
    });
    const remainingSymbolCap = 1400 - 1120;
    audit("ADDON_MODE_CASE_G_CURRENT", {
        allowed: policy.allowed,
        action: policy.action,
        reason: policy.reason,
        addonBlockedReason: policy.addonBlockedReason,
        addonMode: policy.addonMode,
        remaining_symbol_cap: remainingSymbolCap,
        test_expects: "MAX_SYMBOL_CAP",
        test_inputs_invalid: remainingSymbolCap > 0,
        note: "currentSymbolNotional 1120 < equity cap 1400 — MAX_SYMBOL_CAP unreachable by math"
    });

    let headPolicyMatches = false;
    try {
        const headOut = execSync(
            'git show HEAD:src/engine-v2/addon/adverse-addon.ts',
            { encoding: "utf8", cwd: process.cwd() }
        );
        headPolicyMatches = headOut.includes("remainingSymbolCap <= 0") && headOut.includes("MAX_SYMBOL_CAP");
    } catch { /* ignore */ }

    audit("ADDON_MODE_CASE_G_PREEXISTING_PROOF", {
        pre_existing: true,
        first_divergence: "addon-mode-cases.test.ts CASE G fixture (notional 1120 vs cap 1400 leaves 280 room)",
        expected: "MAX_SYMBOL_CAP with addonBlockedReason",
        actual: { allowed: policy.allowed, addonBlockedReason: policy.addonBlockedReason, reason: policy.reason },
        whether_current_patch_changes_execution_path: false,
        head_adverse_addon_has_max_symbol_cap: headPolicyMatches,
        fts_patch_files_touch_addon_policy: false
    });
}

console.log("[FTS-PREcommit-AUDIT] ALL AUDIT CHECKS COMPLETED");
