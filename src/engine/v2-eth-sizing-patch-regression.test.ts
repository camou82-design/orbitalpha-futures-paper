import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateEquityAdaptiveSizing } from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { getEngineConfig } from "../config/env";
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
        accountEquityUsdt: 2300,
        availableBalanceUsdt: 2300,
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

describe("ETHUSDT Sizing Patch Regression Suite", () => {
    // 1. Direct evaluateEquityAdaptiveSizing Unit Tests
    describe("Unit: evaluateEquityAdaptiveSizing cap behavior", () => {
        const baseEquity = 2300;
        const baseBalance = 2300;
        const entryPrice = 2500;

        it("CASE 1: ETH initial risk_based 2300 → capped at final 1200 USDT", () => {
            // stop distance = 1.5% -> targetRisk (1.5% of 2300 = $34.50) / 0.015 = 2300 USDT
            const stopPrice = 2500 * (1 - 0.015);
            const res = evaluateEquityAdaptiveSizing({
                symbol: "ETHUSDT",
                side: "long",
                orderKind: "ENTRY",
                accountEquityUsdt: baseEquity,
                availableBalanceUsdt: baseBalance,
                entryReferencePrice: entryPrice,
                effectiveStopPrice: stopPrice,
                appliedLeverage: 10,
                entryQualityGrade: "A",
                existingSymbolNotionalUsdt: 0,
                existingAccountNotionalUsdt: 0,
                policyRequestedNotionalUsdt: 1200,
                v2HardSafetyCapUsdt: 1200,
                maxSymbolNotionalCapUsdt: 2000,
                roundTripFeeRate: 0,
                lastPrice: entryPrice,
                v2AuthorityEntry: true
            });
            assert.equal(res.sizingPassed, true);
            assert.equal(Math.round(res.riskBasedNotionalUsdt), 2300);
            assert.equal(Math.round(res.preLotNotionalUsdt), 1200);
            assert.equal(Math.round(res.finalOrderNotionalUsdt), 1200);
        });

        it("CASE 2: ETH initial risk_based 900 → preserves conservative 900 USDT (not expanded to 1200)", () => {
            // stop distance = 3.833% -> targetRisk ($34.50) / 0.03833 = ~900 USDT
            const stopDist = 34.50 / 900; // ~0.038333
            const stopPrice = 2500 * (1 - stopDist);
            const res = evaluateEquityAdaptiveSizing({
                symbol: "ETHUSDT",
                side: "long",
                orderKind: "ENTRY",
                accountEquityUsdt: baseEquity,
                availableBalanceUsdt: baseBalance,
                entryReferencePrice: entryPrice,
                effectiveStopPrice: stopPrice,
                appliedLeverage: 10,
                entryQualityGrade: "A",
                existingSymbolNotionalUsdt: 0,
                existingAccountNotionalUsdt: 0,
                policyRequestedNotionalUsdt: 1200,
                v2HardSafetyCapUsdt: 1200,
                maxSymbolNotionalCapUsdt: 2000,
                roundTripFeeRate: 0,
                lastPrice: entryPrice,
                v2AuthorityEntry: true
            });
            assert.equal(res.sizingPassed, true);
            assert.equal(Math.round(res.riskBasedNotionalUsdt), 900);
            assert.equal(Math.round(res.finalOrderNotionalUsdt), 900);
            assert.ok(res.finalOrderNotionalUsdt <= 900.01);
        });

        it("CASE 3: ETH addon requested 800 → final <= 800 USDT", () => {
            const stopPrice = 2500 * (1 - 0.015);
            const res = evaluateEquityAdaptiveSizing({
                symbol: "ETHUSDT",
                side: "long",
                orderKind: "ADVERSE_ADDON",
                accountEquityUsdt: baseEquity,
                availableBalanceUsdt: baseBalance,
                entryReferencePrice: entryPrice,
                effectiveStopPrice: stopPrice,
                appliedLeverage: 10,
                existingSymbolNotionalUsdt: 1000,
                existingAccountNotionalUsdt: 1000,
                policyRequestedNotionalUsdt: 800,
                maxAdverseAddonCapUsdt: 800,
                maxSymbolNotionalCapUsdt: 2000,
                v2HardSafetyCapUsdt: 1200,
                adverseRiskBudgetAllowedNotional: 800,
                lastPrice: entryPrice,
                v2AuthorityEntry: true
            });
            assert.equal(res.sizingPassed, true);
            assert.ok(res.finalOrderNotionalUsdt <= 800);
        });

        it("CASE 4: ETH existing 1200 + addon → total symbol exposure <= 2000 USDT", () => {
            const stopPrice = 2500 * (1 - 0.015);
            const res = evaluateEquityAdaptiveSizing({
                symbol: "ETHUSDT",
                side: "long",
                orderKind: "ADVERSE_ADDON",
                accountEquityUsdt: baseEquity,
                availableBalanceUsdt: baseBalance,
                entryReferencePrice: entryPrice,
                effectiveStopPrice: stopPrice,
                appliedLeverage: 10,
                existingSymbolNotionalUsdt: 1200,
                existingAccountNotionalUsdt: 1200,
                policyRequestedNotionalUsdt: 800,
                maxAdverseAddonCapUsdt: 800,
                maxSymbolNotionalCapUsdt: 2000,
                v2HardSafetyCapUsdt: 1200,
                adverseRiskBudgetAllowedNotional: 800,
                lastPrice: entryPrice,
                v2AuthorityEntry: true
            });
            assert.equal(res.sizingPassed, true);
            assert.ok(res.finalOrderNotionalUsdt <= 800);
            assert.ok(1200 + res.finalOrderNotionalUsdt <= 2000);
        });

        it("CASE 5: ETH existing 1700 → addon bounded to <= 300 USDT", () => {
            const stopPrice = 2500 * (1 - 0.015);
            const res = evaluateEquityAdaptiveSizing({
                symbol: "ETHUSDT",
                side: "long",
                orderKind: "ADVERSE_ADDON",
                accountEquityUsdt: baseEquity,
                availableBalanceUsdt: baseBalance,
                entryReferencePrice: entryPrice,
                effectiveStopPrice: stopPrice,
                appliedLeverage: 10,
                existingSymbolNotionalUsdt: 1700,
                existingAccountNotionalUsdt: 1700,
                policyRequestedNotionalUsdt: 800,
                maxAdverseAddonCapUsdt: 800,
                maxSymbolNotionalCapUsdt: 2000,
                v2HardSafetyCapUsdt: 1200,
                adverseRiskBudgetAllowedNotional: 800,
                lastPrice: entryPrice,
                v2AuthorityEntry: true
            });
            assert.equal(res.sizingPassed, true);
            assert.equal(Math.round(res.finalOrderNotionalUsdt), 300);
            assert.ok(1700 + res.finalOrderNotionalUsdt <= 2000);
        });

        it("CASE 6: BTC same fixture → 100% untouched by ETH rules (v2HardSafetyCap remains 500 default)", () => {
            const stopPrice = 65000 * (1 - 0.015);
            const res = evaluateEquityAdaptiveSizing({
                symbol: "BTCUSDT",
                side: "long",
                orderKind: "ENTRY",
                accountEquityUsdt: baseEquity,
                availableBalanceUsdt: baseBalance,
                entryReferencePrice: 65000,
                effectiveStopPrice: stopPrice,
                appliedLeverage: 10,
                entryQualityGrade: "A",
                existingSymbolNotionalUsdt: 0,
                existingAccountNotionalUsdt: 0,
                v2HardSafetyCapUsdt: 500, // BTC retains 500
                lastPrice: 65000,
                v2AuthorityEntry: true
            });
            assert.equal(res.sizingPassed, true);
            assert.equal(Math.round(res.finalOrderNotionalUsdt), 500); // Bounded by BTC default 500 hard safety cap
        });

        it("CASE 6B: Config Loader parses OKX_LIVE_V2_ETH_MAX_ORDER_NOTIONAL_USDT (default 1200, custom override, preserves BTC 500)", () => {
            const defaultConfig = getEngineConfig({});
            assert.equal(defaultConfig.okxLiveV2MaxOrderNotionalUsdt, 500);
            assert.equal(defaultConfig.okxLiveV2EthMaxOrderNotionalUsdt, 1200);

            const customConfig = getEngineConfig({
                OKX_LIVE_V2_MAX_ORDER_NOTIONAL_USDT: "600",
                OKX_LIVE_V2_ETH_MAX_ORDER_NOTIONAL_USDT: "1500"
            });
            assert.equal(customConfig.okxLiveV2MaxOrderNotionalUsdt, 600);
            assert.equal(customConfig.okxLiveV2EthMaxOrderNotionalUsdt, 1500);
        });
    });

    // 2. Integration / Engine V2 Tests
    describe("Integration: runEngineV2 Sizing and Safety Invariants", () => {
        function resetStates() {
            marketJudgmentCacheBySymbol.clear();
            clearWhipsawObservationState();
            clearGlobalShockStates();
            rangeContinuationStateMap.clear();
        }

        it("CASE 7: ETH FTS Live Escape = 0 (Shadow only with 0 notional order)", () => {
            resetStates();
            const downCandles = makeTestCandles(2450, "down", 120);
            const snap = createBaseSnapshot({
                symbol: "ETHUSDT",
                lastPrice: 2450,
                latestCandleClose: 2450,
                signal: "paper_short_candidate",
                entryCandidate: true,
                canonicalRegime: "RANGE",
                boxPos: 0.25,
                candles: downCandles,
                fastTrendShift: {
                    active: true,
                    direction: "short",
                    baseSizeIntent: 0.32
                }
            });
            const state = createBaseState({ okxActualPositions: [] });
            const bridge = buildV2SnapshotBridge(snap);
            const input = adaptV2Input(
                snap.symbol,
                NOW,
                bridge as any,
                { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
                state as any,
                { decision: { final_decision: "ENTER" } } as any,
                snap.candles,
                "authoritative",
                `cycle_test_fts`
            );
            const { decision } = runEngineV2(input);
            assert.notEqual(decision.decision, "ENTER");
            assert.equal(decision.risk?.finalOrderNotionalUsdt ?? 0, 0, "FTS order notional must be 0");
        });

        it("CASE 8: ETH Trend Pullback Live Escape = 0 (Disabled with 0 notional order)", () => {
            resetStates();
            const upCandles = makeTestCandles(2500, "up", 120);
            const snap = createBaseSnapshot({
                symbol: "ETHUSDT",
                lastPrice: 2500,
                latestCandleClose: 2500,
                signal: "paper_long_candidate",
                entryCandidate: true,
                canonicalRegime: "TREND",
                canonicalTrendScore: 0.8,
                boxPos: 0.45,
                isPullback: true,
                pullbackConfirmed: true,
                candles: upCandles
            });
            const state = createBaseState({ okxActualPositions: [] });
            const bridge = buildV2SnapshotBridge(snap);
            const input = adaptV2Input(
                snap.symbol,
                NOW,
                bridge as any,
                { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
                state as any,
                { decision: { final_decision: "ENTER" } } as any,
                snap.candles,
                "authoritative",
                `cycle_test_pullback`
            );
            const { decision } = runEngineV2(input);
            assert.notEqual(decision.decision, "ENTER");
            assert.equal(decision.risk?.finalOrderNotionalUsdt ?? 0, 0, "Pullback order notional must be 0");
        });
    });
});
