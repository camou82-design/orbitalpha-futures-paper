import { evaluateHighwayCoreEntryGate } from "../engine-v2/highway-core/highway-entry-gate";
import { executeTrendRegime } from "../engine-v2/executors/trend-executor";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { SymbolSnapshotLike } from "./paper-symbol-decision";
import type { Candle } from "../models/types";

function assertTrue(v: boolean, label: string): void {
    if (!v) throw new Error(`${label}: expected true`);
}

function assertFalse(v: boolean, label: string): void {
    if (v) throw new Error(`${label}: expected false`);
}

function assertEq<T>(a: T, b: T, label: string): void {
    if (a !== b) throw new Error(`${label}: expected ${String(b)}, got ${String(a)}`);
}

const now = 1_700_000_000_000;

function createMockCandles(count = 60, direction: "up" | "down" = "up"): Candle[] {
    const candles: Candle[] = [];
    const base = direction === "up" ? 65000 : 65000;
    const step = direction === "up" ? 10 : -10;
    for (let i = 0; i < count; i++) {
        const p = base + (i - count) * step;
        candles.push({
            ts: now - (count - i) * 60_000,
            open: p,
            high: p + 15,
            low: p - 15,
            close: p + (direction === "up" ? 5 : -5),
            volume: 100
        });
    }
    return candles;
}

// =========================================================================
// TEST 1: Bullish TREND momentum + WHIPSAW_SOFT_WATCH -> provenance 전달 PASS
// =========================================================================
{
    const candles = createMockCandles(60, "up");
    const snapshot = {
        symbol: "BTCUSDT",
        lastPrice: 65000,
        boxHigh: 65100,
        boxLow: 64000,
        boxPos: 0.95, // Near upper box edge
        emaGap: 0.003, // Qualified bullish momentum
        trendWeaknessScore: 0.15,
        atr20: 300,
        atr: 300,
        candles
    };

    const inputData: any = {
        symbol: "BTCUSDT",
        snapshot,
        candles,
        state: { longAllow: true, shortAllow: true, directionalShockState: "NONE" }
    };

    const judgment: any = {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "WHIPSAW_SOFT_WATCH",
        subtypeReason: "whipsaw_soft_watch_active"
    };

    const execOutput = executeTrendRegime(inputData, judgment);
    assertEq(execOutput.signal, "LONG_CANDIDATE", "Test 1: Trend executor produces LONG_CANDIDATE");
    assertEq(execOutput.side, "long", "Test 1: side is long");
    assertTrue(execOutput.metadata?.trend_continuation === true, "Test 1: metadata has trend_continuation: true");
    assertEq(execOutput.metadata?.trend_provenance, "TREND_EXECUTOR_MOMENTUM", "Test 1: metadata has trend_provenance");

    // Pass to Highway Gate with planned TP/SL
    const gateRes = evaluateHighwayCoreEntryGate({
        symbol: "BTCUSDT",
        side: "long",
        regime: "RANGE",
        subtype: "WHIPSAW_SOFT_WATCH",
        snapshot,
        execution: execOutput,
        committedRiskPlan: {
            stopPrice: 64500, // 500 sl dist
            plannedTp1Price: 65800 // 800 tp1 dist -> RR = 800/500 = 1.6 > 1.2
        } as any,
        config: { highwayMinCostMultiplier: 2.0, highwayMinRewardRisk: 1.2 }
    });

    assertTrue(gateRes.proof.non_range_lineage === true, "Test 1: Highway recognizes non_range_lineage");
    assertFalse(gateRes.rejectReason === "RANGE_MIDDLE_CHASE_BLOCKED_LONG", "Test 1: RANGE_MIDDLE_CHASE_BLOCKED_LONG is NOT triggered");
    assertEq(gateRes.finalDecision, "ENTER", "Test 1: Gate passes to ENTER");
    console.log("PASS: Test 1 - Bullish TREND momentum + WHIPSAW_SOFT_WATCH passes provenance and bypasses range middle chase");
}

// =========================================================================
// TEST 2: Bearish TREND momentum + WHIPSAW_SOFT_WATCH -> provenance 전달 PASS
// =========================================================================
{
    const candles = createMockCandles(60, "down");
    const snapshot = {
        symbol: "BTCUSDT",
        lastPrice: 65000,
        boxHigh: 66000,
        boxLow: 64900,
        boxPos: 0.05, // Near lower box edge
        emaGap: -0.003, // Qualified bearish momentum
        trendWeaknessScore: 0.15,
        atr20: 300,
        atr: 300,
        candles
    };

    const inputData: any = {
        symbol: "BTCUSDT",
        snapshot,
        candles,
        state: { longAllow: true, shortAllow: true, directionalShockState: "NONE" }
    };

    const judgment: any = {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "WHIPSAW_SOFT_WATCH",
        subtypeReason: "whipsaw_soft_watch_active"
    };

    const execOutput = executeTrendRegime(inputData, judgment);
    assertEq(execOutput.signal, "SHORT_CANDIDATE", "Test 2: Trend executor produces SHORT_CANDIDATE");
    assertEq(execOutput.side, "short", "Test 2: side is short");
    assertTrue(execOutput.metadata?.trend_continuation === true, "Test 2: metadata has trend_continuation: true");
    assertEq(execOutput.metadata?.trend_provenance, "TREND_EXECUTOR_MOMENTUM", "Test 2: metadata has trend_provenance");

    // Pass to Highway Gate with planned TP/SL
    const gateRes = evaluateHighwayCoreEntryGate({
        symbol: "BTCUSDT",
        side: "short",
        regime: "RANGE",
        subtype: "WHIPSAW_SOFT_WATCH",
        snapshot,
        execution: execOutput,
        committedRiskPlan: {
            stopPrice: 65500, // 500 sl dist
            plannedTp1Price: 64200 // 800 tp1 dist -> RR = 800/500 = 1.6 > 1.2
        } as any,
        config: { highwayMinCostMultiplier: 2.0, highwayMinRewardRisk: 1.2 }
    });

    assertTrue(gateRes.proof.non_range_lineage === true, "Test 2: Highway recognizes non_range_lineage");
    assertFalse(gateRes.rejectReason === "RANGE_MIDDLE_CHASE_BLOCKED_SHORT", "Test 2: RANGE_MIDDLE_CHASE_BLOCKED_SHORT is NOT triggered");
    assertEq(gateRes.finalDecision, "ENTER", "Test 2: Gate passes to ENTER");
    console.log("PASS: Test 2 - Bearish TREND momentum + WHIPSAW_SOFT_WATCH passes provenance and bypasses range middle chase");
}

// =========================================================================
// TEST 3: Pure RANGE upper long chase -> BLOCK 유지 (RANGE_MIDDLE_CHASE_BLOCKED_LONG)
// =========================================================================
{
    const snapshot = {
        symbol: "BTCUSDT",
        lastPrice: 65000,
        boxHigh: 65500,
        boxLow: 64500,
        boxPos: 0.85, // Upper zone
        atr20: 300,
        atr: 300
    };

    const execOutput: any = {
        signal: "LONG_CANDIDATE",
        side: "long",
        reason: "range_reversion",
        metadata: { range_reversion: true } // No trend_continuation
    };

    const gateRes = evaluateHighwayCoreEntryGate({
        symbol: "BTCUSDT",
        side: "long",
        regime: "RANGE",
        subtype: "RANGE_STABLE",
        snapshot,
        execution: execOutput,
        committedRiskPlan: {
            stopPrice: 64500,
            plannedTp1Price: 65800
        } as any,
        config: {}
    });

    assertFalse(gateRes.proof.non_range_lineage as boolean, "Test 3: Pure range is not non_range_lineage");
    assertEq(gateRes.finalDecision, "SKIP", "Test 3: Pure range upper long is SKIP");
    assertEq(gateRes.rejectReason, "RANGE_MIDDLE_CHASE_BLOCKED_LONG", "Test 3: rejectReason is RANGE_MIDDLE_CHASE_BLOCKED_LONG");
    console.log("PASS: Test 3 - Pure RANGE upper long chase is blocked as RANGE_MIDDLE_CHASE_BLOCKED_LONG");
}

// =========================================================================
// TEST 4: Pure RANGE lower short chase -> BLOCK 유지 (RANGE_MIDDLE_CHASE_BLOCKED_SHORT)
// =========================================================================
{
    const snapshot = {
        symbol: "BTCUSDT",
        lastPrice: 65000,
        boxHigh: 65500,
        boxLow: 64500,
        boxPos: 0.15, // Lower zone
        atr20: 300,
        atr: 300
    };

    const execOutput: any = {
        signal: "SHORT_CANDIDATE",
        side: "short",
        reason: "range_reversion",
        metadata: { range_reversion: true } // No trend_continuation
    };

    const gateRes = evaluateHighwayCoreEntryGate({
        symbol: "BTCUSDT",
        side: "short",
        regime: "RANGE",
        subtype: "RANGE_STABLE",
        snapshot,
        execution: execOutput,
        committedRiskPlan: {
            stopPrice: 65500,
            plannedTp1Price: 64200
        } as any,
        config: {}
    });

    assertFalse(gateRes.proof.non_range_lineage as boolean, "Test 4: Pure range is not non_range_lineage");
    assertEq(gateRes.finalDecision, "SKIP", "Test 4: Pure range lower short is SKIP");
    assertEq(gateRes.rejectReason, "RANGE_MIDDLE_CHASE_BLOCKED_SHORT", "Test 4: rejectReason is RANGE_MIDDLE_CHASE_BLOCKED_SHORT");
    console.log("PASS: Test 4 - Pure RANGE lower short chase is blocked as RANGE_MIDDLE_CHASE_BLOCKED_SHORT");
}

// =========================================================================
// TEST 5: Weak whipsaw without qualified trend momentum -> BLOCK 유지
// =========================================================================
{
    const snapshot = {
        symbol: "BTCUSDT",
        lastPrice: 65000,
        boxHigh: 65500,
        boxLow: 64500,
        boxPos: 0.85,
        emaGap: 0.0002, // Weak momentum (< 0.001)
        trendWeaknessScore: 0.45,
        atr20: 300,
        atr: 300
    };

    const inputData: any = {
        symbol: "BTCUSDT",
        snapshot,
        state: { longAllow: true, shortAllow: true, directionalShockState: "NONE" }
    };

    const judgment: any = {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "WHIPSAW_SOFT_WATCH",
        subtypeReason: "whipsaw_soft_watch_active"
    };

    const execOutput = executeTrendRegime(inputData, judgment);
    assertEq(execOutput.signal, "WAIT_RECHECK", "Test 5: Weak momentum produces WAIT_RECHECK");
    assertEq(execOutput.side, "none", "Test 5: side is none");
    assertFalse(execOutput.metadata?.trend_continuation === true, "Test 5: no trend_continuation metadata");

    const gateRes = evaluateHighwayCoreEntryGate({
        symbol: "BTCUSDT",
        side: "none",
        regime: "RANGE",
        subtype: "WHIPSAW_SOFT_WATCH",
        snapshot,
        execution: execOutput,
        config: {}
    });

    assertFalse(gateRes.allowed, "Test 5: Highway gate rejects no directional side");
    assertEq(gateRes.rejectReason, "NO_DIRECTIONAL_SIDE", "Test 5: rejectReason is NO_DIRECTIONAL_SIDE");
    console.log("PASS: Test 5 - Weak whipsaw without qualified trend momentum produces WAIT_RECHECK and is blocked");
}

// =========================================================================
// TEST 6: Provenance present but RR insufficient -> final SKIP 유지
// =========================================================================
{
    const candles = createMockCandles(60, "up");
    const snapshot = {
        symbol: "BTCUSDT",
        lastPrice: 65000,
        boxHigh: 65100,
        boxLow: 64000,
        boxPos: 0.95,
        emaGap: 0.003,
        trendWeaknessScore: 0.15,
        atr20: 300,
        atr: 300,
        candles
    };

    const inputData: any = {
        symbol: "BTCUSDT",
        snapshot,
        candles,
        state: { longAllow: true, shortAllow: true, directionalShockState: "NONE" }
    };

    const judgment: any = {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "WHIPSAW_SOFT_WATCH",
        subtypeReason: "whipsaw_soft_watch_active"
    };

    const execOutput = executeTrendRegime(inputData, judgment);

    // Pass to Highway Gate with poor RR plan (tp distance 200 vs sl distance 600 -> RR = 0.33 < 1.2)
    const gateRes = evaluateHighwayCoreEntryGate({
        symbol: "BTCUSDT",
        side: "long",
        regime: "RANGE",
        subtype: "WHIPSAW_SOFT_WATCH",
        snapshot,
        execution: execOutput,
        committedRiskPlan: {
            stopPrice: 64400, // 600 sl dist
            plannedTp1Price: 65200 // 200 tp1 dist -> RR = 200/600 = 0.33
        } as any,
        config: { highwayMinCostMultiplier: 2.0, highwayMinRewardRisk: 1.2 }
    });

    assertTrue(gateRes.proof.non_range_lineage === true, "Test 6: Non range lineage recognized");
    assertEq(gateRes.finalDecision, "SKIP", "Test 6: Highway rejects on poor RR");
    assertEq(gateRes.rejectReason, "POOR_REWARD_RISK_RATIO", "Test 6: rejectReason is POOR_REWARD_RISK_RATIO");
    console.log("PASS: Test 6 - Trend provenance present but RR insufficient is properly guarded by Highway to SKIP");
}

console.log("\nv2-trend-momentum-provenance-cases: ALL 6 MANDATORY TESTS PASSED PERFECTLY!");
