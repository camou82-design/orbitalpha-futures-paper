/**
 * Dedicated test suite for TREND TP Hybrid ATR/Structure Normalization (PHASE TP-DYNAMIC-1).
 */

import assert from "node:assert/strict";
import { computeTrendDynamicTp } from "../src/engine-v2/execution/trend-dynamic-tp-authority";
import { resolveV2PreEntryTp1Authority } from "../src/engine-v2/execution/pre-entry-tp-provenance";
import type { Candle } from "../src/models/types";

function pass(label: string, detail?: Record<string, unknown>): void {
    const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
    console.log(`[TREND-TP-HYBRID-DYNAMIC][${label}] PASS${extra}`);
}

// 1. Profitability Floor Test (극단적 저변동성에서도 minimumTpPct ~0.30% 하한 철저 준수)
{
    const entry = 100_000;
    const result = computeTrendDynamicTp({
        side: "short",
        entryPrice: entry,
        atr5m: 10, // 0.01% (extremely tiny)
        atr15m: 15, // 0.015%
        boxLow: 99_995 // 0.005% away
    });

    assert.equal(result.ok, true);
    assert.ok(result.targetPct >= result.minimumTpPct, "targetPct must not be below minimumTpPct");
    assert.ok(result.minimumTpPct >= 0.0029 && result.minimumTpPct <= 0.0031, "default minimumTpPct is ~0.30%");
    assert.equal(result.rawTp1Price < entry, true, "short TP must be below entry");
    pass("1_PROFITABILITY_FLOOR", {
        targetPct: result.targetPct,
        minimumTpPct: result.minimumTpPct,
        tp: result.rawTp1Price
    });
}

// 2. BTC Cycle 4135 Replay Test
{
    const entry = 76546.4;
    const atr5m = entry * 0.001732; // 0.1732%
    const atr15m = entry * 0.002681; // 0.2681%
    // recent 5m / 15m structure low around 76490.9 (~0.072% which is too close, ignored by economic filter)
    // and swing low further down around 76100 (~0.58% down)
    const structureLow = 76100;

    const result = computeTrendDynamicTp({
        side: "short",
        entryPrice: entry,
        atr5m,
        atr15m,
        boxLow: structureLow
    });

    assert.equal(result.ok, true);
    assert.equal(result.tpSource, "hybrid_atr_structure");
    // atrTarget = max(0.1732% * 2.5, 0.2681% * 1.5) = max(0.433%, 0.402%) = ~0.433%
    assert.ok(Math.abs((result.atrTargetPct ?? 0) - 0.00433) < 0.0001, "atrTarget should be ~0.433%");
    // targetPct should be between 0.43% and 0.693%
    assert.ok(result.targetPct >= 0.0043 && result.targetPct <= 0.0070, "BTC 4135 target should be within 0.43% ~ 0.70%");
    assert.ok(result.rawTp1Price < entry, "short invariant: TP < entry");
    assert.ok(result.targetPct >= result.minimumTpPct, "must exceed economic floor 0.30%");

    pass("2_BTC_CYCLE_4135_REPLAY", {
        entry,
        tp: result.rawTp1Price,
        targetPct: result.targetPct,
        atrTargetPct: result.atrTargetPct,
        tpSource: result.tpSource
    });
}

// 3. Strong Trend Test (스윙이 크고 ATR이 높을 때 기존 1.05% 이상도 정상 도출)
{
    const entry = 50_000;
    const atr5m = 500; // 1.0%
    const atr15m = 750; // 1.5%
    // atrTarget = max(1.0% * 2.5, 1.5% * 1.5) = 2.5%
    // structure target = 48_500 (3.0% drop)
    const result = computeTrendDynamicTp({
        side: "short",
        entryPrice: entry,
        atr5m,
        atr15m,
        boxLow: 48_500
    });

    assert.equal(result.ok, true);
    assert.equal(result.tpSource, "hybrid_atr_structure");
    assert.ok(result.targetPct > 0.0105, "strong trend should expand beyond 1.05%");
    assert.ok(result.rawTp1Price < entry);
    pass("3_STRONG_TREND", {
        targetPct: result.targetPct,
        tp: result.rawTp1Price,
        tpSource: result.tpSource
    });
}

// 4. Weak Trend / Low Volatility Test (과도하게 먼 1.05% 대신 0.35%~0.50% 수준으로 수렴)
{
    const entry = 100_000;
    const atr5m = 120; // 0.12%
    const atr15m = 180; // 0.18%
    // atrTarget = max(0.12% * 2.5, 0.18% * 1.5) = 0.30%
    const result = computeTrendDynamicTp({
        side: "short",
        entryPrice: entry,
        atr5m,
        atr15m
    });

    assert.equal(result.ok, true);
    assert.equal(result.tpSource, "atr_only_fallback");
    assert.ok(result.targetPct < 0.008, "weak trend should not force 1.05%");
    assert.ok(result.targetPct >= result.minimumTpPct, "must satisfy floor");
    pass("4_WEAK_TREND_LOW_VOLATILITY", {
        targetPct: result.targetPct,
        tp: result.rawTp1Price
    });
}

// 5. Structure Missing Fallback Test (ATR만 있는 경우 atr_only_fallback)
{
    const entry = 100_000;
    const result = computeTrendDynamicTp({
        side: "long",
        entryPrice: entry,
        atr5m: 200,
        atr15m: 300
    });

    assert.equal(result.ok, true);
    assert.equal(result.tpSource, "atr_only_fallback");
    assert.ok(result.rawTp1Price > entry, "long TP must be above entry");
    pass("5_STRUCTURE_MISSING_FALLBACK", {
        tpSource: result.tpSource,
        tp: result.rawTp1Price
    });
}

// 6. ATR Missing Fallback Test (Structure만 있는 경우 structure_only_fallback)
{
    const entry = 100_000;
    const result = computeTrendDynamicTp({
        side: "short",
        entryPrice: entry,
        boxLow: 99_400 // 0.6% drop
    });

    assert.equal(result.ok, true);
    assert.equal(result.tpSource, "structure_only_fallback");
    assert.ok(Math.abs(result.targetPct - 0.006) < 1e-9);
    assert.equal(result.rawTp1Price, 99_400);
    pass("6_ATR_MISSING_STRUCTURE_ONLY", {
        tpSource: result.tpSource,
        tp: result.rawTp1Price
    });
}

// 7. Total Missing Fallback Test (둘 다 없는 경우 engine_calculated_fallback)
{
    const entry = 100_000;
    const result = computeTrendDynamicTp({
        side: "long",
        entryPrice: entry
    });

    assert.equal(result.ok, true);
    assert.equal(result.tpSource, "engine_calculated_fallback");
    assert.ok(Math.abs(result.targetPct - 0.0105) < 1e-9);
    assert.equal(result.rawTp1Price, 101_050);
    pass("7_TOTAL_MISSING_ENGINE_FALLBACK", {
        tpSource: result.tpSource,
        tp: result.rawTp1Price
    });
}

// 8. Long / Short Symmetry Test
{
    const entry = 100_000;
    const atr5m = 200; // 0.20%
    const atr15m = 300; // 0.30%
    const dist = 500; // 0.50%

    const longRes = computeTrendDynamicTp({
        side: "long",
        entryPrice: entry,
        atr5m,
        atr15m,
        boxHigh: entry + dist
    });

    const shortRes = computeTrendDynamicTp({
        side: "short",
        entryPrice: entry,
        atr5m,
        atr15m,
        boxLow: entry - dist
    });

    assert.equal(longRes.ok, true);
    assert.equal(shortRes.ok, true);
    assert.equal(longRes.tpSource, shortRes.tpSource);
    assert.ok(Math.abs(longRes.targetPct - shortRes.targetPct) < 1e-9, "targetPct must be symmetric");
    assert.ok(Math.abs((longRes.rawTp1Price - entry) - (entry - shortRes.rawTp1Price)) < 1e-9, "price distance must be symmetric");

    pass("8_LONG_SHORT_SYMMETRY", {
        longTp: longRes.rawTp1Price,
        shortTp: shortRes.rawTp1Price,
        targetPct: longRes.targetPct
    });
}

// 9. Integration via resolveV2PreEntryTp1Authority Test
{
    const entry = 76546.4;
    const authRes = resolveV2PreEntryTp1Authority({
        side: "short",
        regime: "TREND",
        entryPrice: entry,
        rawStructuralSl: 77000,
        rawPolicySlPrice: 77000,
        atr5m: entry * 0.001732,
        atr15m: entry * 0.002681,
        boxLow: 76100
    });

    assert.equal(authRes.ok, true);
    if (!authRes.ok) throw new Error("expected ok");
    assert.equal(authRes.tpSource, "hybrid_atr_structure");
    assert.ok(authRes.rawTp1Price < entry, "TP < entry");

    pass("9_INTEGRATION_VIA_RESOLVE_AUTHORITY", {
        tp: authRes.rawTp1Price,
        tpSource: authRes.tpSource
    });
}

console.log("[TREND-TP-HYBRID-DYNAMIC] ALL PASS");
