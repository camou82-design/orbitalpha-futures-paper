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
