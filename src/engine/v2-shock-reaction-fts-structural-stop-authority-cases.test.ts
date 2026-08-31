/**
 * SHOCK_REACTION + WHIPSAW promoted entry — FTS canonical structural stop authority alignment.
 * Cases A–G per STOP_DISTANCE_TOO_WIDE provenance audit (base 9f16fae).
 */

import assert from "node:assert/strict";
import { ensurePromotedEntryRiskPlan } from "../engine-v2/index";
import {
    FTS_STRUCTURAL_STOP_BASIS,
    FTS_ABSOLUTE_SAFETY_MAX_STOP_PCT,
    getClosedCandlesForStructuralStop,
    resolveFastTrendShiftStructuralStop,
    resolveVerifiedFtsCanonicalStructuralStopAuthority
} from "../engine-v2/risk-sizing/fast-trend-shift-structural-stop";
import type { Candle } from "../models/types";
import type { ExecutorOutput, MarketJudgmentOutput } from "../engine-v2/types";

const PRODUCTION_ENTRY = 2445.68;
const PRODUCTION_ATR_FLOOR = 4;
const PRODUCTION_ATR_WIDE = 23.1;
const PRODUCTION_BOX_HIGH = 2462;
const PRODUCTION_BOX_LOW = 2430;
const PRODUCTION_BOX_MID = (PRODUCTION_BOX_HIGH + PRODUCTION_BOX_LOW) / 2;
/** pivot high + 0.35×ATR ≈ 2458.09 at production ATR floor */
const PRODUCTION_PIVOT_HIGH = 2456.69;
const PRODUCTION_FTS_STOP = PRODUCTION_PIVOT_HIGH + PRODUCTION_ATR_FLOOR * 0.35;

function pass(label: string, detail?: Record<string, unknown>): void {
    const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
    console.log(`[SHOCK-FTS-STOP-AUTH][${label}] PASS${extra}`);
}

function whipsawJudgmentWithFts(
    fts: NonNullable<MarketJudgmentOutput["diagnostics"]>["fastTrendShift"]
): MarketJudgmentOutput {
    return {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "WHIPSAW_SOFT_WATCH",
        subtypeReason: "WHIPSAW_SOFT_WATCH",
        shockPhase: "DOWN_SHOCK",
        trendPhase: "DOWN",
        rangePhase: "FLAT",
        counter_trend_risk: false,
        diagnostics: { fastTrendShift: fts }
    } as MarketJudgmentOutput;
}

function buildProductionReplayCandles(pivotHigh: number): Candle[] {
    const candles: Candle[] = [];
    let ts = 1_700_000_000_000;
    const entry = PRODUCTION_ENTRY;
    for (let i = 0; i < 14; i++) {
        if (i === 8) {
            candles.push({
                ts,
                open: entry - 4,
                high: pivotHigh,
                low: entry - 8,
                close: entry - 3,
                volume: 120
            });
        } else if (i === 7 || i === 9) {
            candles.push({
                ts,
                open: entry - 3,
                high: entry + 6,
                low: entry - 7,
                close: entry - 2,
                volume: 100
            });
        } else {
            candles.push({
                ts,
                open: entry,
                high: entry + 2,
                low: entry - 2,
                close: entry - 1,
                volume: 90
            });
        }
        ts += 60_000;
    }
    candles.push({
        ts,
        open: entry - 1,
        high: entry + 1,
        low: entry - 4,
        close: entry,
        volume: 100
    });
    return candles;
}

function makeFtsDiagFromResolved(
    resolved: ReturnType<typeof resolveFastTrendShiftStructuralStop>
): NonNullable<MarketJudgmentOutput["diagnostics"]>["fastTrendShift"] {
    return {
        active: true,
        direction: "short",
        candidate: true,
        allowed: true,
        side: "short",
        reason: "ema_down|lower_hold|vol_down",
        block_reason: "",
        higher_low_detected: false,
        higher_high_detected: false,
        lower_high_detected: true,
        lower_low_detected: true,
        box_mid_reclaimed: false,
        box_mid_lost: true,
        box_upper_breakout_hold: false,
        box_lower_breakdown_hold: true,
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
    };
}

function snapshotFrom(candles: Candle[], entry: number, atr: number) {
    return {
        symbol: "ETHUSDT",
        lastPrice: entry,
        atr,
        candles,
        boxHigh: PRODUCTION_BOX_HIGH,
        boxLow: PRODUCTION_BOX_LOW
    };
}

// CASE A — production replay: WHIPSAW + DOWN_SHOCK shock reaction inherits FTS structural stop (>0.5%, <3%)
{
    const candles = buildProductionReplayCandles(PRODUCTION_PIVOT_HIGH);
    const closed = getClosedCandlesForStructuralStop(candles);
    const resolved = resolveFastTrendShiftStructuralStop({
        side: "short",
        entryPrice: PRODUCTION_ENTRY,
        lastPrice: PRODUCTION_ENTRY,
        atr: PRODUCTION_ATR_FLOOR,
        closedCandles: closed,
        boxMid: PRODUCTION_BOX_MID,
        previousConfirmedBoxHigh: PRODUCTION_BOX_HIGH,
        previousConfirmedBoxLow: PRODUCTION_BOX_LOW
    });
    assert.equal(resolved.valid, true, "fixture must yield valid FTS structural stop");
    assert.ok(Math.abs(resolved.stopPrice! - PRODUCTION_FTS_STOP) < 0.02, "production-like FTS stop");
    const distPct = (resolved.stopPrice! - PRODUCTION_ENTRY) / PRODUCTION_ENTRY;
    assert.ok(distPct > 0.005, `FTS stop must exceed generic 0.5% floor (got ${distPct})`);
    assert.ok(distPct <= FTS_ABSOLUTE_SAFETY_MAX_STOP_PCT, "FTS stop within 3% safety cap");

    const ftsDiag = makeFtsDiagFromResolved(resolved);
    const judgment = whipsawJudgmentWithFts(ftsDiag);
    const execution: ExecutorOutput = {
        signal: "SHORT_CANDIDATE",
        side: "short",
        reason: "SHOCK_REACTION_lower_breakdown_continuation_short",
        baseSizeIntent: 0.32,
        recheckSuggested: true,
        isAddOnEligible: false,
        stopPrice: resolved.stopPrice,
        invalidationPx: resolved.stopPrice,
        metadata: {
            stop_basis: FTS_STRUCTURAL_STOP_BASIS,
            structural_invalidation_price: resolved.structuralInvalidationPrice,
            structural_source: resolved.structuralSource,
            atr_buffer_multiple: resolved.atrBufferMultiple,
            atr_buffer_price: resolved.atrBufferPrice
        }
    };

    const block = ensurePromotedEntryRiskPlan(
        execution,
        "ENTER",
        "short",
        null,
        snapshotFrom(candles, PRODUCTION_ENTRY, PRODUCTION_ATR_FLOOR),
        judgment as any,
        "SHOCK_REACTION_lower_breakdown_continuation_short"
    );
    assert.equal(block, null, "canonical FTS structural authority must not fail generic 0.5% gate");
    assert.equal(execution.stopPrice, resolved.stopPrice);
    pass("CASE-A production replay WHIPSAW shock FTS inherit", {
        entry: PRODUCTION_ENTRY,
        stop: execution.stopPrice,
        stopDistPct: distPct
    });
}

// CASE B — same prices, no FTS structural authority → generic 0.5% gate blocks
{
    const candles = buildProductionReplayCandles(PRODUCTION_PIVOT_HIGH);
    const wideStop = PRODUCTION_FTS_STOP;
    const distPct = (wideStop - PRODUCTION_ENTRY) / PRODUCTION_ENTRY;
    assert.ok(distPct > 0.005, "fixture stop must exceed 0.5% generic floor");
    const judgment = {
        regime: "RANGE",
        subtype: "WHIPSAW_SOFT_WATCH",
        shockPhase: "DOWN_SHOCK",
        diagnostics: {}
    } as MarketJudgmentOutput;
    const execution: ExecutorOutput = {
        signal: "SHORT_CANDIDATE",
        side: "short",
        reason: "SHOCK_REACTION_lower_breakdown_continuation_short",
        baseSizeIntent: 0.32,
        recheckSuggested: true,
        isAddOnEligible: false,
        stopPrice: wideStop,
        invalidationPx: wideStop,
        metadata: { stop_basis: "swingHigh" }
    };
    const block = ensurePromotedEntryRiskPlan(
        execution,
        "ENTER",
        "short",
        null,
        snapshotFrom(candles, PRODUCTION_ENTRY, PRODUCTION_ATR_FLOOR),
        judgment as any,
        "SHOCK_REACTION_lower_breakdown_continuation_short"
    );
    assert.equal(block, "STOP_DISTANCE_TOO_WIDE");
    assert.equal(execution.stopPrice, null);
    pass("CASE-B no FTS provenance generic gate", { wideStop, block, distPct });
}

// CASE C — missing stop authority → STOP_PRICE_MISSING
{
    const judgment = whipsawJudgmentWithFts(undefined as any);
    const execution: ExecutorOutput = {
        signal: "SHORT_CANDIDATE",
        side: "short",
        reason: "SHOCK_REACTION_lower_breakdown_continuation_short",
        baseSizeIntent: 0.32,
        recheckSuggested: true,
        isAddOnEligible: false,
        stopPrice: null,
        invalidationPx: null,
        metadata: {}
    };
    const block = ensurePromotedEntryRiskPlan(
        execution,
        "ENTER",
        "short",
        null,
        { symbol: "ETHUSDT", lastPrice: PRODUCTION_ENTRY, atr: 4, candles: [], boxHigh: 0, boxLow: 0 },
        { ...judgment, diagnostics: {} } as any,
        "SHOCK_REACTION_lower_breakdown_continuation_short"
    );
    assert.equal(block, "STOP_PRICE_MISSING");
    pass("CASE-C missing stop", { block });
}

// CASE D — spoofed string-only basis cannot bypass generic gate
{
    const spoofStop = PRODUCTION_ENTRY * 1.006;
    const authority = resolveVerifiedFtsCanonicalStructuralStopAuthority({
        side: "short",
        entryPrice: PRODUCTION_ENTRY,
        stopPrice: spoofStop,
        execMeta: { stop_basis: FTS_STRUCTURAL_STOP_BASIS },
        fastTrendShiftDiag: null,
        resolverCrossCheck: null
    });
    assert.equal(authority, null);
    pass("CASE-D spoofed basis rejected", { spoofStop });
}

// CASE F — ordinary WHIPSAW shock generic stop <0.5% allowed
{
    const entry = PRODUCTION_ENTRY;
    const atr = 4;
    const narrowStop = entry * 1.004;
    const execution: ExecutorOutput = {
        signal: "SHORT_CANDIDATE",
        side: "short",
        reason: "SHOCK_REACTION_lower_breakdown_continuation_short",
        baseSizeIntent: 0.32,
        recheckSuggested: true,
        isAddOnEligible: false,
        stopPrice: narrowStop,
        invalidationPx: narrowStop,
        metadata: { stop_basis: "atrBuffer" }
    };
    const block = ensurePromotedEntryRiskPlan(
        execution,
        "ENTER",
        "short",
        null,
        { symbol: "ETHUSDT", lastPrice: entry, atr, candles: [], boxHigh: 2460, boxLow: 2430 },
        { subtype: "WHIPSAW_SOFT_WATCH", diagnostics: {} } as any,
        "SHOCK_REACTION_lower_breakdown_continuation_short"
    );
    assert.equal(block, null);
    assert.equal(execution.stopPrice, narrowStop);
    pass("CASE-F ordinary shock narrow generic stop allowed", {
        stopDistPct: (narrowStop - entry) / entry
    });
}

// CASE G — ordinary WHIPSAW shock generic stop >0.5% blocked
{
    const entry = PRODUCTION_ENTRY;
    const atr = 4;
    const wideStop = entry * 1.006;
    const execution: ExecutorOutput = {
        signal: "SHORT_CANDIDATE",
        side: "short",
        reason: "SHOCK_REACTION_lower_breakdown_continuation_short",
        baseSizeIntent: 0.32,
        recheckSuggested: true,
        isAddOnEligible: false,
        stopPrice: wideStop,
        invalidationPx: wideStop,
        metadata: { stop_basis: "swingHigh" }
    };
    const block = ensurePromotedEntryRiskPlan(
        execution,
        "ENTER",
        "short",
        null,
        { symbol: "ETHUSDT", lastPrice: entry, atr, candles: [], boxHigh: 2460, boxLow: 2430 },
        { subtype: "WHIPSAW_SOFT_WATCH", diagnostics: {} } as any,
        "SHOCK_REACTION_lower_breakdown_continuation_short"
    );
    assert.equal(block, "STOP_DISTANCE_TOO_WIDE");
    pass("CASE-G ordinary shock wide generic stop blocked", {
        stopDistPct: (wideStop - entry) / entry,
        block
    });
}

console.log("[SHOCK-FTS-STOP-AUTH] all cases passed");
