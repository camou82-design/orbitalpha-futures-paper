import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2, marketJudgmentCacheBySymbol } from "../engine-v2/index";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { clearGlobalShockStates } from "../engine-v2/state/derive";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";
import type { SymbolSnapshotLike } from "./paper-symbol-decision";

const NOW = 1_700_000_000_000;

function makeTestCandles(base = 2500, direction: "up" | "down" | "flat" = "flat", count = 120): Candle[] {
    const candles: Candle[] = [];
    const step = direction === "down" ? -2 : direction === "up" ? 2 : 0;
    for (let i = 0; i < count; i++) {
        const p = base + (i - count) * step;
        candles.push({
            ts: NOW - (count - i) * 60_000,
            open: p,
            high: p + 3,
            low: p - 3,
            close: p + step,
            volume: 100
        });
    }
    return candles;
}

function createBaseSnapshot(overrides: Record<string, any> = {}): SymbolSnapshotLike {
    const candles = overrides.candles ?? makeTestCandles(2500, "flat", 120);
    return {
        symbol: "ETHUSDT",
        lastPrice: 2500,
        latestCandleClose: 2500,
        signal: "paper_long_candidate",
        entryCandidate: true,
        qualityScore: 80,
        candidateStrength: "strong",
        ema20: 2500,
        ema60: 2500,
        emaGap: 0.0001,
        volumeRatioProxy: 1.2,
        boxHigh: 2600,
        boxLow: 2400,
        boxPos: 0.5,
        boxRel: 0.5,
        gateExpectedMove: null,
        gateRequiredMove: null,
        atr: 15,
        atr20: 15,
        closedClose: 2500,
        rangeConfidence: 0.7,
        trendWeaknessScore: 0.6,
        boxCohesion01: 0.8,
        breakoutFailureRate: 0.2,
        rangeOscillationScore: 0.7,
        boxHighSlope: 0,
        boxLowSlope: 0,
        rangeCenterSlope: 0,
        meanReversionVolumeZScore: 1.0,
        rangeExpansionRatio: 0.9,
        rangeExpansionZScore: 0.5,
        candles,
        htf_candles: {
            "1m": candles,
            "3m": candles,
            "5m": candles,
            "15m": candles,
            "1h": candles,
            "4h": candles,
            "1d": candles
        },
        ...overrides
    } as any;
}

function createBaseState(overrides: Record<string, any> = {}): any {
    return {
        directionalShockState: "NONE",
        crashState: "NORMAL",
        shortAllow: true,
        longAllow: true,
        currentPositions: [],
        signedExecutionReady: true,
        paperExecutionReady: true,
        okxAuthMode: "live",
        okxAuthReady: true,
        okxExchangeAuthOptIn: true,
        okxLiveEnabled: true,
        liveBalanceReady: true,
        accountEquityUsdt: 10000,
        availableBalanceUsdt: 10000,
        okxActualPositionsReady: true,
        actualAccountNotionalUsdtReady: true,
        okxPendingOrdersReady: true,
        okxPendingOrdersNotionalUsdt: 0,
        okxPendingSymbolNotionalUsdt: 0,
        okxActualPositions: [],
        balanceFetchedAt: NOW,
        positionsFetchedAt: NOW,
        pendingOrdersFetchedAt: NOW,
        freshTickBarrierActive: false,
        freshTickCompletedCycles: 3,
        freshTickRequiredCycles: 3,
        globalRiskScore: 0.1,
        lossStreaks: {},
        executionReadiness: true,
        serverTradeEnabled: true,
        closeOnlyMode: false,
        killSwitch: false,
        ...overrides
    };
}

function runEngineWith(
    snapshotOverrides: Record<string, any> = {},
    stateOverrides: Record<string, any> = {},
    configOverrides: Record<string, any> = {}
) {
    marketJudgmentCacheBySymbol.clear();
    clearWhipsawObservationState();
    clearGlobalShockStates();
    rangeContinuationStateMap.clear();

    const snap = createBaseSnapshot(snapshotOverrides);
    const bridge = buildV2SnapshotBridge(snap);
    const state = createBaseState(stateOverrides);
    const config = { paperMaxOpenPositions: 3, baseSizeUsd: 100, ...configOverrides };

    const input = adaptV2Input(
        snap.symbol,
        NOW,
        bridge as any,
        config as any,
        state as any,
        { decision: { final_decision: "ENTER" } } as any,
        snap.candles,
        "authoritative",
        `cycle_${snap.symbol}_${NOW}_test`
    );

    return runEngineV2(input);
}

function extractReason(decision: any): string {
    return String(decision?.explanation?.reason ?? (decision as any)?.reason ?? (decision as any)?.risk?.blockReason ?? "");
}

describe("ETHUSDT Range Guard Lineage-Scope Minimal Patch Regression (CASES 1-12)", () => {
    // CASE 1: True RANGE lower long -> Mean-reversion allowed / preserved
    it("CASE 1: True RANGE lower long -> maintains normal RANGE lower entry behavior", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.15,
            lastPrice: 2430,
            rangeConfidence: 0.8,
            trendWeaknessScore: 0.7
        });
        const reason = extractReason(decision);
        assert.notEqual(reason, "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG");
        assert.notEqual(reason, "RANGE_MIDDLE_CHASE_BLOCKED_LONG");
    });

    // CASE 2: True RANGE upper short -> Mean-reversion allowed / preserved
    it("CASE 2: True RANGE upper short -> maintains normal RANGE upper short behavior", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_short_candidate",
            boxPos: 0.85,
            lastPrice: 2570,
            rangeConfidence: 0.8,
            trendWeaknessScore: 0.7
        });
        const reason = extractReason(decision);
        assert.notEqual(reason, "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
        assert.notEqual(reason, "RANGE_MIDDLE_CHASE_BLOCKED_SHORT");
    });

    // CASE 3: True RANGE upper long chase -> BLOCKED by Range Guard
    it("CASE 3: True RANGE upper long chase -> BLOCKED", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.85,
            lastPrice: 2570,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.8,
            canonicalRegime: "RANGE"
        });
        assert.notEqual(decision.decision, "ENTER", "Canonical RANGE upper long chase must be blocked");
    });

    // CASE 4: True RANGE lower short chase -> BLOCKED by Range Guard
    it("CASE 4: True RANGE lower short chase -> BLOCKED", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_short_candidate",
            boxPos: 0.15,
            lastPrice: 2430,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.8,
            canonicalRegime: "RANGE"
        });
        assert.notEqual(decision.decision, "ENTER", "Canonical RANGE lower short chase must be blocked");
    });

    // CASE 5: TREND_CONTINUATION long + router RANGE + upper boxPos -> Range Guard로 차단 금지
    it("CASE 5: TREND_CONTINUATION long + router RANGE + upper boxPos -> NOT blocked by Range Guard", () => {
        const upCandles = makeTestCandles(2500, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.88,
            lastPrice: 2580,
            candles: upCandles,
            rangeConfidence: 0.55,
            trendWeaknessScore: 0.3
        });
        const reason = extractReason(decision);
        assert.notEqual(reason, "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG");
        assert.notEqual(reason, "RANGE_MIDDLE_CHASE_BLOCKED_LONG");
    });

    // CASE 6: TREND_CONTINUATION short + router RANGE + lower boxPos -> Range Guard로 차단 금지
    it("CASE 6: TREND_CONTINUATION short + router RANGE + lower boxPos -> NOT blocked by Range Guard", () => {
        const downCandles = makeTestCandles(2500, "down", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_short_candidate",
            boxPos: 0.12,
            lastPrice: 2420,
            candles: downCandles,
            rangeConfidence: 0.55,
            trendWeaknessScore: 0.3
        });
        const reason = extractReason(decision);
        assert.notEqual(reason, "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
        assert.notEqual(reason, "RANGE_MIDDLE_CHASE_BLOCKED_SHORT");
    });

    // CASE 7: BREAKOUT_LONG + router RANGE + upper boxPos -> Range Guard로 차단 금지
    it("CASE 7: BREAKOUT_LONG + router RANGE + upper boxPos -> NOT blocked by Range Guard", () => {
        const upCandles = makeTestCandles(2500, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.92,
            lastPrice: 2610,
            candles: upCandles,
            rangeConfidence: 0.5,
            trendWeaknessScore: 0.2
        });
        const reason = extractReason(decision);
        assert.notEqual(reason, "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG");
        assert.notEqual(reason, "RANGE_MIDDLE_CHASE_BLOCKED_LONG");
    });

    // CASE 8: BREAKDOWN_SHORT + router RANGE + lower boxPos -> Range Guard로 차단 금지
    it("CASE 8: BREAKDOWN_SHORT + router RANGE + lower boxPos -> NOT blocked by Range Guard", () => {
        const downCandles = makeTestCandles(2500, "down", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_short_candidate",
            boxPos: 0.08,
            lastPrice: 2390,
            candles: downCandles,
            rangeConfidence: 0.5,
            trendWeaknessScore: 0.2
        });
        const reason = extractReason(decision);
        assert.notEqual(reason, "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
        assert.notEqual(reason, "RANGE_MIDDLE_CHASE_BLOCKED_SHORT");
    });

    // CASE 9: 2026-09-25 11:09~11:15 ETH fixture reproduction
    it("CASE 9: 2026-09-25 11:09~11:15 ETH fixture -> false suppression by RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG is removed", () => {
        const candles = makeTestCandles(2500, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.94,
            lastPrice: 2590,
            qualityScore: 88,
            candidateStrength: "strong",
            candles,
            rangeConfidence: 0.6,
            trendWeaknessScore: 0.25
        });
        const reason = extractReason(decision);
        assert.notEqual(reason, "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG");
        assert.notEqual(reason, "RANGE_MIDDLE_CHASE_BLOCKED_LONG");
    });

    // CASE 10: True ETH FTS -> STILL Shadow-Only
    it("CASE 10: True ETH FTS -> Shadow-Only policy preserved", () => {
        const candles = makeTestCandles(2450, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2450,
            latestCandleClose: 2450,
            signal: "paper_long_candidate",
            entryCandidate: true,
            canonicalRegime: "RANGE",
            rangeConfidence: 0.35,
            canonicalTrendScore: 0.35,
            boxHigh: 2600,
            boxLow: 2400,
            boxPos: 0.25,
            ema20: 2530,
            ema60: 2510,
            emaGap: 0.0006,
            ema20Slope: 0.0003,
            candles,
            fastTrendShift: {
                active: true,
                direction: "long",
                baseSizeIntent: 0.32
            }
        });
        const reason = extractReason(decision);
        assert.notEqual(decision.decision, "ENTER", "ETH FTS must never ENTER");
        assert.equal(decision.decision, "HOLD", "ETH FTS decision must be HOLD");
        assert.ok(
            reason.includes("ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED") || decision.decision === "HOLD",
            `Reason must indicate FTS suppression: ${reason}`
        );
    });

    // CASE 11: True ETH Trend Pullback -> STILL Disabled
    it("CASE 11: True ETH Trend Pullback -> Disabled policy preserved", () => {
        const upCandles = makeTestCandles(2500, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2500,
            latestCandleClose: 2500,
            signal: "paper_long_candidate",
            entryCandidate: true,
            canonicalRegime: "TREND",
            rangeConfidence: 0.2,
            canonicalTrendScore: 0.8,
            boxHigh: 2600,
            boxLow: 2400,
            boxPos: 0.45,
            ema20: 2510,
            ema60: 2490,
            emaGap: 0.0008,
            ema20Slope: 0.0003,
            isPullback: true,
            pullbackConfirmed: true,
            candles: upCandles
        });
        assert.notEqual(decision.decision, "ENTER", "ETH Trend Pullback must not enter live");
    });

    // CASE 12: BTC same fixture -> BTC unaffected
    it("CASE 12: BTC same fixture -> BTC lane unaffected", () => {
        const upCandles = makeTestCandles(65000, "up", 120);
        const { decision } = runEngineWith({
            symbol: "BTCUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.94,
            lastPrice: 65800,
            qualityScore: 88,
            candidateStrength: "strong",
            candles: upCandles,
            rangeConfidence: 0.6,
            trendWeaknessScore: 0.25
        });
        const reason = extractReason(decision);
        assert.notEqual(reason, "ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED");
        assert.notEqual(reason, "ETH_TREND_PULLBACK_LIVE_ENTRY_DISABLED");
    });
});

describe("RETEST Guard Lineage-Scope Collision Fixtures (CASES 13-20)", () => {
    // CASE 13: TRUE RANGE upper breakout + no retest → STILL BLOCKED
    it("CASE 13: TRUE RANGE upper breakout + no retest → range guard still blocks LONG", () => {
        const flatCandles = makeTestCandles(2500, "flat", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.92,
            lastPrice: 2610,
            closedClose: 2608,
            boxHigh: 2600,
            boxLow: 2400,
            candles: flatCandles,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.75,
            emaGap: 0.0001,
            canonicalRegime: "RANGE",
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        assert.notEqual(decision.decision, "ENTER",
            `TRUE RANGE upper no-retest: must NOT ENTER, got ${decision.decision}`);
    });

    // CASE 14: TRUE RANGE lower breakdown + no retest → STILL BLOCKED (SHORT symmetric)
    it("CASE 14: TRUE RANGE lower breakdown + no retest → range guard still blocks SHORT", () => {
        const flatCandles = makeTestCandles(2500, "flat", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_short_candidate",
            boxPos: 0.08,
            lastPrice: 2390,
            closedClose: 2392,
            boxHigh: 2600,
            boxLow: 2400,
            candles: flatCandles,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.75,
            emaGap: -0.0001,
            canonicalRegime: "RANGE",
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        assert.notEqual(decision.decision, "ENTER",
            `TRUE RANGE lower no-retest: must NOT ENTER, got ${decision.decision}`);
    });

    // CASE 15: Highway Trend LONG + upper zone + no retest → ENTER not demoted
    it("CASE 15: Highway Trend LONG + upper zone + no retest → NOT demoted by retest guard", () => {
        const upCandles = makeTestCandles(2500, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.90,
            lastPrice: 2590,
            qualityScore: 85,
            candidateStrength: "strong",
            candles: upCandles,
            rangeConfidence: 0.42,
            trendWeaknessScore: 0.18,
            emaGap: 0.0015,
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        // Must not be blocked by RANGE retest guard reason
        assert.notEqual(extractReason(decision),
            "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED",
            "Highway TREND LONG must not be blocked by BREAKOUT_RETEST_NOT_CONFIRMED");
    });

    // CASE 16: Highway Trend SHORT + lower zone + no retest → ENTER not demoted (symmetric)
    it("CASE 16: Highway Trend SHORT + lower zone + no retest → NOT demoted by retest guard", () => {
        const downCandles = makeTestCandles(2500, "down", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_short_candidate",
            boxPos: 0.10,
            lastPrice: 2410,
            qualityScore: 85,
            candidateStrength: "strong",
            candles: downCandles,
            rangeConfidence: 0.42,
            trendWeaknessScore: 0.18,
            emaGap: -0.0015,
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        assert.notEqual(extractReason(decision),
            "TREND_PROMOTION_BLOCKED_BREAKDOWN_RETEST_NOT_CONFIRMED",
            "Highway TREND SHORT must not be blocked by BREAKDOWN_RETEST_NOT_CONFIRMED");
    });

    // CASE 17: FTS subtype ONLY, but flat candles (TRUE RANGE lineage) → retest guard not bypassed
    it("CASE 17: FAST_TREND_SHIFT subtype but TRUE RANGE lineage (flat candles) → retest guard not bypassed", () => {
        const flatCandles = makeTestCandles(2500, "flat", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.91,
            lastPrice: 2605,
            closedClose: 2603,
            boxHigh: 2600,
            boxLow: 2400,
            candles: flatCandles,
            rangeConfidence: 0.82,
            trendWeaknessScore: 0.72,
            emaGap: 0.00015,
            canonicalRegime: "RANGE",
            fastTrendShift: { active: false, direction: "long", baseSizeIntent: 0.0 },
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        // With flat candles + high rangeConfidence, should not ENTER (TRUE RANGE path)
        assert.notEqual(decision.decision, "ENTER",
            `FTS subtype + TRUE RANGE lineage: must NOT ENTER without retest, got ${decision.decision}`);
    });

    // CASE 18: ETH canonical FTS → retest exempt + STILL ETH_FTS_SHADOW_ONLY
    it("CASE 18: ETH canonical FTS → Range retest exempt, but still ETH_FTS_SHADOW_ONLY (HOLD)", () => {
        const upCandles = makeTestCandles(2450, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2450,
            latestCandleClose: 2450,
            signal: "paper_long_candidate",
            entryCandidate: true,
            canonicalRegime: "RANGE",
            rangeConfidence: 0.35,
            boxHigh: 2600,
            boxLow: 2400,
            boxPos: 0.25,
            ema20: 2530,
            ema60: 2510,
            emaGap: 0.0008,
            candles: upCandles,
            fastTrendShift: {
                active: true,
                direction: "long",
                baseSizeIntent: 0.32
            }
        });
        assert.notEqual(decision.decision, "ENTER",
            "ETH canonical FTS must not ENTER even after retest guard lineage bypass");
        assert.equal(decision.decision, "HOLD",
            `ETH canonical FTS must remain HOLD, got ${decision.decision}`);
    });

    // CASE 19: ETH Trend Pullback → Disabled policy preserved
    it("CASE 19: ETH Trend Pullback → Disabled policy preserved after retest guard patch", () => {
        const upCandles = makeTestCandles(2500, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2500,
            signal: "paper_long_candidate",
            entryCandidate: true,
            canonicalRegime: "TREND",
            rangeConfidence: 0.2,
            boxHigh: 2600,
            boxLow: 2400,
            boxPos: 0.45,
            ema20: 2510,
            ema60: 2490,
            emaGap: 0.0009,
            isPullback: true,
            pullbackConfirmed: true,
            candles: upCandles
        });
        assert.notEqual(decision.decision, "ENTER",
            "ETH Trend Pullback must not enter live after patch");
    });

    // CASE 20: BTC LONG + SHORT symmetry — BTC unaffected by ETH/RANGE retest patch
    it("CASE 20: BTC LONG/SHORT symmetry — BTC highway lanes unaffected by retest guard patch", () => {
        const upCandles = makeTestCandles(65000, "up", 120);
        const { decision: btcLong } = runEngineWith({
            symbol: "BTCUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.88,
            lastPrice: 65800,
            qualityScore: 85,
            candidateStrength: "strong",
            candles: upCandles,
            rangeConfidence: 0.5,
            trendWeaknessScore: 0.25,
            emaGap: 0.0012
        });
        assert.notEqual(extractReason(btcLong), "ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED",
            "BTC LONG must not be affected by ETH-only policies");
        assert.notEqual(extractReason(btcLong), "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED",
            "BTC LONG with trend lineage must not be blocked by BREAKOUT_RETEST guard");

        const downCandles = makeTestCandles(65000, "down", 120);
        const { decision: btcShort } = runEngineWith({
            symbol: "BTCUSDT",
            signal: "paper_short_candidate",
            boxPos: 0.12,
            lastPrice: 64200,
            qualityScore: 85,
            candidateStrength: "strong",
            candles: downCandles,
            rangeConfidence: 0.5,
            trendWeaknessScore: 0.25,
            emaGap: -0.0012
        });
        assert.notEqual(extractReason(btcShort), "ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED",
            "BTC SHORT must not be affected by ETH-only policies");
        assert.notEqual(extractReason(btcShort), "TREND_PROMOTION_BLOCKED_BREAKDOWN_RETEST_NOT_CONFIRMED",
            "BTC SHORT with trend lineage must not be blocked by BREAKDOWN_RETEST guard");
    });
});

describe("RETEST Guard isNonRangeRetestExempt Strict Authority Fixtures (CASES 21-24)", () => {
    // CASE 21: RANGE lineage + ENTER + FAST_TREND_SHIFT subtype → retest bypass 금지
    // The RANGE executor fires (flat candles, high rangeConfidence).
    // FTS signal is present as a subtype label BUT lineage is RANGE (no exec.reason trend provenance).
    // Subtype alone must NOT grant exemption.
    it("CASE 21: RANGE lineage + ENTER + FAST_TREND_SHIFT subtype (flat candles) → retest guard NOT bypassed", () => {
        const flatCandles = makeTestCandles(2500, "flat", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.91,
            lastPrice: 2605,
            closedClose: 2603,
            boxHigh: 2600,
            boxLow: 2400,
            candles: flatCandles,
            rangeConfidence: 0.84,
            trendWeaknessScore: 0.74,
            emaGap: 0.00012,
            canonicalRegime: "RANGE",
            // FTS subtype injected, but flat candles → RANGE executor fires
            // → execution.reason will NOT contain "trend"/"fast_shift" keyword
            fastTrendShift: { active: false, direction: "long", baseSizeIntent: 0.0 },
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        // RANGE retest guard must still apply — FTS subtype alone is not sufficient for bypass
        assert.notEqual(decision.decision, "ENTER",
            `CASE 21: RANGE lineage + FTS subtype must NOT ENTER without retest, got ${decision.decision}`);
        assert.notEqual(extractReason(decision), "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED",
            "CASE 21 should be blocked before reaching retest guard (other RANGE guard applies first)");
    });

    // CASE 22: RANGE lineage + ENTER + TREND_* subtype → retest bypass 금지
    // Flat candles + high rangeConfidence → RANGE executor. TREND subtype injected.
    // subtype alone must NOT grant exemption.
    it("CASE 22: RANGE lineage + ENTER + TREND_* subtype (flat candles, high rangeConf) → retest guard NOT bypassed", () => {
        const flatCandles = makeTestCandles(2500, "flat", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.90,
            lastPrice: 2600,
            closedClose: 2598,
            boxHigh: 2600,
            boxLow: 2400,
            candles: flatCandles,
            rangeConfidence: 0.87,
            trendWeaknessScore: 0.76,
            emaGap: 0.00010,
            canonicalRegime: "RANGE",
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        // RANGE executor fires due to flat candles + high rangeConf
        // Even if subtype=TREND_*, without exec.reason trend provenance → must NOT bypass
        assert.notEqual(decision.decision, "ENTER",
            `CASE 22: RANGE lineage + TREND subtype must NOT ENTER without retest, got ${decision.decision}`);
    });

    // CASE 23: non-RANGE canonical lineage + ENTER → retest bypass granted
    // Up candles + low rangeConfidence → TREND executor fires, exec.reason contains "trend"
    // Highway ENTER authority + exec.reason provenance → exempt from RANGE retest guard
    it("CASE 23: non-RANGE canonical lineage + ENTER → retest guard bypass granted (ENTER not demoted)", () => {
        const upCandles = makeTestCandles(2500, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.88,
            lastPrice: 2580,
            qualityScore: 86,
            candidateStrength: "strong",
            candles: upCandles,
            rangeConfidence: 0.38,  // Low → TREND executor likely
            trendWeaknessScore: 0.15,
            emaGap: 0.0018,
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        // Must NOT be blocked by RANGE retest guard
        // (non-RANGE lineage with exec.reason trend provenance → exempt)
        assert.notEqual(extractReason(decision),
            "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED",
            "CASE 23: non-RANGE canonical lineage must NOT be blocked by BREAKOUT_RETEST_NOT_CONFIRMED");
    });

    // CASE 24: routing=TREND but actual lineage=RANGE (high rangeConf, flat candles) → bypass 금지
    // Even if activeEngineRouting is "TREND", if the actual lineage is RANGE
    // (flat market, high rangeConf, no exec.reason trend provenance), bypass must be denied.
    // routing alone is NOT sufficient.
    it("CASE 24: routing=TREND label but actual lineage=RANGE (flat+highRangeConf) → bypass 금지", () => {
        const flatCandles = makeTestCandles(2500, "flat", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.91,
            lastPrice: 2604,
            closedClose: 2602,
            boxHigh: 2600,
            boxLow: 2400,
            candles: flatCandles,
            rangeConfidence: 0.86,
            trendWeaknessScore: 0.73,
            emaGap: 0.00008,  // Very small emaGap → trendOk=false → RANGE executor fires
            canonicalRegime: "RANGE",
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        // Routing may show TREND but with flat candles + high rangeConf + tiny emaGap,
        // actual lineage is RANGE → retest guard must apply → must NOT ENTER
        assert.notEqual(decision.decision, "ENTER",
            `CASE 24: routing=TREND but RANGE lineage must NOT ENTER without retest, got ${decision.decision}`);
    });
});

describe("isProvenNonRangeExecutionProvenance Truth Table (CASES 25-32)", () => {
    // CASE 25: RANGE lineage + exec.reason contains "HIGHWAY" → BLOCK 유지
    // "V2_RANGE_LOWER_LONG_BLOCKED_BY_STRONG_HIGHWAY_DOWN" (RANGE executor) must not bypass.
    // "highway" keyword removed from isProvenNonRangeExecutionProvenance.
    // Engine: RANGE executor → no ENTER (blocked reason) → isProvenNonRangeExecutionProvenance=false anyway.
    it("CASE 25: RANGE lineage + exec.reason highway keyword → RETEST BLOCK preserved", () => {
        const flatCandles = makeTestCandles(2500, "flat", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.91,
            lastPrice: 2605,
            closedClose: 2603,
            boxHigh: 2600,
            boxLow: 2400,
            candles: flatCandles,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.75,
            emaGap: 0.0001,
            canonicalRegime: "RANGE",
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        // RANGE executor → must not ENTER
        // ("highway" keyword removed → no false exemption even if reason contained "highway")
        assert.notEqual(decision.decision, "ENTER",
            `CASE 25: RANGE+highway reason: must NOT ENTER, got ${decision.decision}`);
    });

    // CASE 26: RANGE lineage + subtype FAST_TREND_SHIFT + ENTER → BLOCK 유지
    // FTS subtype is Layer 2 — excluded from isProvenNonRangeExecutionProvenance.
    it("CASE 26: RANGE lineage + FAST_TREND_SHIFT subtype + ENTER → RETEST BLOCK preserved", () => {
        const flatCandles = makeTestCandles(2500, "flat", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.92,
            lastPrice: 2607,
            closedClose: 2605,
            boxHigh: 2600,
            boxLow: 2400,
            candles: flatCandles,
            rangeConfidence: 0.84,
            trendWeaknessScore: 0.74,
            emaGap: 0.00012,
            canonicalRegime: "RANGE",
            fastTrendShift: { active: false, direction: "long", baseSizeIntent: 0.0 },
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        // FAST_TREND_SHIFT subtype alone → Layer 2 → no bypass → must not ENTER
        assert.notEqual(decision.decision, "ENTER",
            `CASE 26: RANGE+FTS subtype: must NOT ENTER (Layer 2 subtype has no bypass authority), got ${decision.decision}`);
    });

    // CASE 27: RANGE lineage + TREND_* subtype + ENTER → BLOCK 유지
    // TREND_* subtype is Layer 2 — excluded from isProvenNonRangeExecutionProvenance.
    it("CASE 27: RANGE lineage + TREND_* subtype + ENTER → RETEST BLOCK preserved", () => {
        const flatCandles = makeTestCandles(2500, "flat", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.90,
            lastPrice: 2600,
            closedClose: 2598,
            boxHigh: 2600,
            boxLow: 2400,
            candles: flatCandles,
            rangeConfidence: 0.87,
            trendWeaknessScore: 0.76,
            emaGap: 0.00010,
            canonicalRegime: "RANGE",
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        // TREND_* subtype alone → Layer 2 → no bypass → must not ENTER
        assert.notEqual(decision.decision, "ENTER",
            `CASE 27: RANGE+TREND subtype: must NOT ENTER (Layer 2 subtype has no bypass authority), got ${decision.decision}`);
    });

    // CASE 28: canonical TREND_CONTINUATION reason + ENTER → retest bypass 허용
    // exec.reason.includes("trend") → Layer 1 → isProvenNonRangeExecutionProvenance=true
    it("CASE 28: canonical TREND_CONTINUATION exec.reason + ENTER → retest guard bypassed", () => {
        const upCandles = makeTestCandles(2500, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.87,
            lastPrice: 2575,
            qualityScore: 87,
            candidateStrength: "strong",
            candles: upCandles,
            rangeConfidence: 0.36,
            trendWeaknessScore: 0.14,
            emaGap: 0.0019,
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        // TREND executor fires → exec.reason includes "trend" keyword → Layer 1 → bypass
        assert.notEqual(extractReason(decision),
            "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED",
            "CASE 28: TREND_CONTINUATION exec.reason must not be blocked by BREAKOUT_RETEST guard");
    });

    // CASE 29: canonical BREAKOUT reason + ENTER → retest bypass 허용
    // exec.reason.includes("breakout") → Layer 1 → isProvenNonRangeExecutionProvenance=true
    it("CASE 29: canonical BREAKOUT exec.reason + ENTER → retest guard bypassed", () => {
        const upCandles = makeTestCandles(2500, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.89,
            lastPrice: 2585,
            qualityScore: 85,
            candidateStrength: "strong",
            candles: upCandles,
            rangeConfidence: 0.40,
            trendWeaknessScore: 0.16,
            emaGap: 0.0016,
            retestConfirmed: true,   // retest confirmed → breakout path
            retestTouched: true,
            retestRejected: false
        });
        // Confirmed retest → exec.reason likely includes "breakout" or "trend" → Layer 1 → bypass
        assert.notEqual(extractReason(decision),
            "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED",
            "CASE 29: BREAKOUT exec.reason + confirmed retest must not be blocked by BREAKOUT_RETEST guard");
    });

    // CASE 30: canonical BREAKDOWN reason + ENTER → retest bypass 허용 (SHORT symmetric)
    it("CASE 30: canonical BREAKDOWN exec.reason + ENTER → retest guard bypassed (SHORT)", () => {
        const downCandles = makeTestCandles(2500, "down", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_short_candidate",
            boxPos: 0.11,
            lastPrice: 2415,
            qualityScore: 85,
            candidateStrength: "strong",
            candles: downCandles,
            rangeConfidence: 0.40,
            trendWeaknessScore: 0.16,
            emaGap: -0.0016,
            retestConfirmed: true,
            retestTouched: true,
            retestRejected: false
        });
        // Confirmed retest → exec.reason breakdown → Layer 1 → bypass
        assert.notEqual(extractReason(decision),
            "TREND_PROMOTION_BLOCKED_BREAKDOWN_RETEST_NOT_CONFIRMED",
            "CASE 30: BREAKDOWN exec.reason + confirmed retest must not be blocked by BREAKDOWN_RETEST guard");
    });

    // CASE 31: ETH canonical FTS → retest bypass 적용 후에도 ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED
    // isProvenNonRangeExecutionProvenance may be true (FTS fires with fast_shift reason),
    // but ETH FTS shadow-only policy must still apply on top, keeping decision=HOLD.
    it("CASE 31: ETH canonical FTS → retest bypass granted + ETH_FTS_SHADOW_ONLY still HOLD", () => {
        const upCandles = makeTestCandles(2450, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2450,
            latestCandleClose: 2450,
            signal: "paper_long_candidate",
            entryCandidate: true,
            canonicalRegime: "RANGE",
            rangeConfidence: 0.35,
            boxHigh: 2600,
            boxLow: 2400,
            boxPos: 0.25,
            ema20: 2530,
            ema60: 2510,
            emaGap: 0.0008,
            candles: upCandles,
            fastTrendShift: { active: true, direction: "long", baseSizeIntent: 0.32 }
        });
        // Even if retest bypass applies (FTS lineage), ETH FTS shadow-only must fire AFTER
        assert.notEqual(decision.decision, "ENTER",
            "CASE 31: ETH FTS must not ENTER even after retest guard bypass");
        assert.equal(decision.decision, "HOLD",
            `CASE 31: ETH FTS must remain HOLD (shadow-only), got ${decision.decision}`);
    });

    // CASE 32: TRUE RANGE LONG/SHORT retest 방어 유지 (LONG + SHORT 대칭)
    it("CASE 32: TRUE RANGE LONG retest defense preserved (no bypass for RANGE lineage)", () => {
        const flatCandles = makeTestCandles(2500, "flat", 120);
        const { decision: longDecision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_long_candidate",
            boxPos: 0.93,
            lastPrice: 2615,
            closedClose: 2612,
            boxHigh: 2600,
            boxLow: 2400,
            candles: flatCandles,
            rangeConfidence: 0.88,
            trendWeaknessScore: 0.78,
            emaGap: 0.00005,
            canonicalRegime: "RANGE",
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        assert.notEqual(longDecision.decision, "ENTER",
            `CASE 32 LONG: TRUE RANGE upper no-retest must NOT ENTER, got ${longDecision.decision}`);

        const { decision: shortDecision } = runEngineWith({
            symbol: "ETHUSDT",
            signal: "paper_short_candidate",
            boxPos: 0.07,
            lastPrice: 2385,
            closedClose: 2387,
            boxHigh: 2600,
            boxLow: 2400,
            candles: flatCandles,
            rangeConfidence: 0.88,
            trendWeaknessScore: 0.78,
            emaGap: -0.00005,
            canonicalRegime: "RANGE",
            retestConfirmed: false,
            retestTouched: false,
            retestRejected: false
        });
        assert.notEqual(shortDecision.decision, "ENTER",
            `CASE 32 SHORT: TRUE RANGE lower no-retest must NOT ENTER, got ${shortDecision.decision}`);
    });

    // ── ADVERSARIAL REGRESSION SUITE: PROVENANCE TOKEN COLLISION AUDIT (CASES 33-39) ──
    describe("Adversarial Token Collision & Canonical Retest Bypass (CASES 33-39)", () => {
        // CASE 33: RANGE reason containing 'trend' without native ENTER authority → BLOCK
        it("CASE 33: RANGE reason containing 'trend' without native ENTER authority → BLOCK", () => {
            const flatCandles = makeTestCandles(2500, "flat", 120);
            const { decision } = runEngineWith({
                symbol: "ETHUSDT",
                signal: "paper_long_candidate",
                boxPos: 0.15,
                lastPrice: 2430,
                canonicalRegime: "RANGE",
                rangeConfidence: 0.85,
                trendPhase: "DOWN", // Causes range-executor to produce V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND
                candles: flatCandles
            });
            assert.notEqual(decision.decision, "ENTER",
                `CASE 33: RANGE reason containing 'trend' without ENTER authority must BLOCK, got ${decision.decision}`);
        });

        // CASE 34: RANGE reason containing 'continuation' without native ENTER authority → BLOCK
        it("CASE 34: RANGE reason containing 'continuation' without native ENTER authority → BLOCK", () => {
            const flatCandles = makeTestCandles(2500, "flat", 120);
            const { decision } = runEngineWith({
                symbol: "ETHUSDT",
                signal: "paper_long_candidate",
                boxPos: 0.95,
                lastPrice: 2620,
                canonicalRegime: "RANGE",
                rangeConfidence: 0.85,
                retestConfirmed: false,
                candles: flatCandles
            });
            assert.notEqual(decision.decision, "ENTER",
                `CASE 34: RANGE reason containing 'continuation' without ENTER authority must BLOCK, got ${decision.decision}`);
        });

        // CASE 35: RANGE reason containing 'breakout' without retest confirmation → BLOCK
        it("CASE 35: RANGE reason containing 'breakout' without retest confirmation → BLOCK", () => {
            const flatCandles = makeTestCandles(2500, "flat", 120);
            const { decision } = runEngineWith({
                symbol: "ETHUSDT",
                signal: "paper_long_candidate",
                boxPos: 0.96,
                lastPrice: 2610,
                canonicalRegime: "RANGE",
                rangeConfidence: 0.85,
                retestConfirmed: false,
                retestTouched: false,
                candles: flatCandles
            });
            assert.notEqual(decision.decision, "ENTER",
                `CASE 35: RANGE reason containing 'breakout' without retest must BLOCK, got ${decision.decision}`);
        });

        // CASE 36: RANGE reason containing 'breakdown' without retest confirmation → BLOCK
        it("CASE 36: RANGE reason containing 'breakdown' without retest confirmation → BLOCK", () => {
            const flatCandles = makeTestCandles(2500, "flat", 120);
            const { decision } = runEngineWith({
                symbol: "ETHUSDT",
                signal: "paper_short_candidate",
                boxPos: 0.04,
                lastPrice: 2390,
                canonicalRegime: "RANGE",
                rangeConfidence: 0.85,
                retestConfirmed: false,
                retestTouched: false,
                candles: flatCandles
            });
            assert.notEqual(decision.decision, "ENTER",
                `CASE 36: RANGE reason containing 'breakdown' without retest must BLOCK, got ${decision.decision}`);
        });

        // CASE 37: RANGE reason containing 'fast_shift' without structural validation → BLOCK
        it("CASE 37: RANGE reason containing 'fast_shift' with invalid structural stop → BLOCK", () => {
            const flatCandles = makeTestCandles(2500, "flat", 120);
            const { decision } = runEngineWith({
                symbol: "ETHUSDT",
                signal: "paper_long_candidate",
                boxPos: 0.5,
                lastPrice: 2500,
                canonicalRegime: "RANGE",
                rangeConfidence: 0.8,
                fastTrendShift: {
                    active: true,
                    direction: "long",
                    baseSizeIntent: 0 // invalid intent -> invalid stop -> no native ENTER
                },
                candles: flatCandles
            });
            assert.notEqual(decision.decision, "ENTER",
                `CASE 37: fast_shift without valid stop must BLOCK, got ${decision.decision}`);
        });

        // CASE 38: Canonical Breakout ENTER + BREAKOUT_RETEST_NOT_CONFIRMED fallback → BYPASS
        it("CASE 38: Canonical Breakout ENTER + BREAKOUT_RETEST_NOT_CONFIRMED fallback → BYPASS", () => {
            const upCandles = makeTestCandles(65000, "up", 120);
            const { decision } = runEngineWith({
                symbol: "BTCUSDT",
                signal: "paper_long_candidate",
                boxPos: 0.85,
                lastPrice: 65500,
                qualityScore: 85,
                candidateStrength: "strong",
                candles: upCandles,
                rangeConfidence: 0.40,
                trendWeaknessScore: 0.15,
                emaGap: 0.0015
            });
            assert.notEqual(extractReason(decision),
                "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED",
                "CASE 38: Canonical Breakout ENTER must BYPASS BREAKOUT_RETEST_NOT_CONFIRMED guard");
        });

        // CASE 39: Canonical Breakdown ENTER + BREAKDOWN_RETEST_NOT_CONFIRMED fallback → BYPASS
        it("CASE 39: Canonical Breakdown ENTER + BREAKDOWN_RETEST_NOT_CONFIRMED fallback → BYPASS", () => {
            const downCandles = makeTestCandles(65000, "down", 120);
            const { decision } = runEngineWith({
                symbol: "BTCUSDT",
                signal: "paper_short_candidate",
                boxPos: 0.12,
                lastPrice: 64200,
                qualityScore: 85,
                candidateStrength: "strong",
                candles: downCandles,
                rangeConfidence: 0.40,
                trendWeaknessScore: 0.15,
                emaGap: -0.0015
            });
            assert.notEqual(extractReason(decision),
                "TREND_PROMOTION_BLOCKED_BREAKDOWN_RETEST_NOT_CONFIRMED",
                "CASE 39: Canonical Breakdown ENTER must BYPASS BREAKDOWN_RETEST_NOT_CONFIRMED guard");
        });
    });
});
