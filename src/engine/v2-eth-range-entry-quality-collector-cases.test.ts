import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../models/types";
import type { PaperClosedPositionRecord } from "../models/types";
import {
    buildEthRangeEntryQualityOpportunityRecord,
    buildEthRangeEntryQualityOpportunityId,
    buildSetupFingerprint,
    captureEthRangeEntryQualityOpportunity,
    closedCandlesOnly,
    getEthRangeEntryQualityPendingFlowLinkForTests,
    getEthRangeEntryQualitySeenOpportunityCountForTests,
    maybeRegisterEthRangeEntryQualityFill,
    resetEthRangeEntryQualityCollectorStateForTests,
    resolveEthRangeEntryQualityCandidateSide,
    setEthRangeEntryQualityStoreForTests
} from "../engine-v2/audit/eth-range-entry-quality-collector";
import {
    buildEthRangeEntryQualityOutcomeRecord,
    recordEthRangeEntryQualityOutcome
} from "../engine-v2/audit/eth-range-entry-quality-outcome-linker";
import { resetRangeDriftHysteresis } from "../engine-v2/market-judgment/range-drift-entry-timing-gate";
import { runEngineV2 } from "../engine-v2/index";

function mkCandles(closed: Array<Omit<Candle, "volume"> & { volume?: number }>, forming?: Partial<Candle>): Candle[] {
    const base = closed.map((c) => ({
        ts: c.ts,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume ?? 100
    }));
    const form: Candle = {
        ts: forming?.ts ?? (base[base.length - 1]?.ts ?? 0) + 60_000,
        open: forming?.open ?? 2501,
        high: forming?.high ?? 2502,
        low: forming?.low ?? 2499,
        close: forming?.close ?? 2501.5,
        volume: forming?.volume ?? 50
    };
    return [...base, form];
}

function baseCtx(overrides: Record<string, unknown> = {}) {
    const candles = mkCandles(
        [
            { ts: 1_000_000, open: 2498, high: 2500, low: 2497, close: 2499 },
            { ts: 1_060_000, open: 2499, high: 2501, low: 2498, close: 2500 },
            { ts: 1_120_000, open: 2500, high: 2502, low: 2499, close: 2501 }
        ],
        { ts: 1_180_000, open: 2501, high: 2503, low: 2500, close: 2502 }
    );
    return {
        runCycleId: 42,
        symbol: "ETHUSDT",
        evaluatedAt: 1_130_000,
        canonicalRegime: "RANGE",
        candidateSide: "long" as const,
        judgment: {
            regime: "RANGE",
            subtype: "RANGE_BOUND",
            rangePhase: "FLAT",
            shockPhase: "NONE",
            htf_bias: { m5: "RANGE", m15: "BEARISH", h1: "BEARISH", h4: "CONFLICT", d1: "BULLISH" },
            reversalConfirmed: false
        },
        snapshot: {
            lastPrice: 2501,
            latestCandleClose: 2501,
            boxHigh: 2520,
            boxLow: 2480,
            boxPos: 0.525,
            rangeCenterSlope: -0.00001,
            ema20Slope: 0.00002,
            atr: 12,
            volumeRatio: 0.95
        },
        candles,
        feasibility: null,
        drift: null,
        finalDecision: "SKIP",
        finalSide: "none",
        finalRejectReason: "RANGE_DRIFT_TIMING_WAIT",
        ...overrides
    };
}

describe("V2 ETH RANGE Entry Quality Collector", () => {
    beforeEach(() => {
        resetEthRangeEntryQualityCollectorStateForTests();
        resetRangeDriftHysteresis();
        setEthRangeEntryQualityStoreForTests({
            appendOpportunityLine: () => {},
            appendOutcomeLine: () => {}
        });
    });

    it("captures ETH RANGE opportunity with closed-candle-only features", () => {
        const record = buildEthRangeEntryQualityOpportunityRecord(baseCtx());
        assert.ok(record);
        assert.equal(record?.symbol, "ETHUSDT");
        assert.equal(record?.canonicalRegime, "RANGE");
        assert.equal(record?.closedCandleTs, 1_120_000);
        assert.equal(record?.last3ClosedCandleOhlc?.length, 3);
        assert.equal(record?.boxPosNow, record?.boxPos);
    });

    it("bypasses non-RANGE regime", () => {
        const record = buildEthRangeEntryQualityOpportunityRecord(
            baseCtx({ canonicalRegime: "TREND", judgment: { regime: "TREND" } })
        );
        assert.equal(record, null);
    });

    it("bypasses BTC symbol", () => {
        const record = buildEthRangeEntryQualityOpportunityRecord(
            baseCtx({ symbol: "BTCUSDT" })
        );
        assert.equal(record, null);
    });

    it("uses closed candles only (forming candle excluded from last3)", () => {
        const candles = mkCandles(
            [{ ts: 100, open: 1, high: 2, low: 1, close: 1.5 }],
            { ts: 999_999, open: 9, high: 9, low: 9, close: 9 }
        );
        const closed = closedCandlesOnly(candles);
        assert.equal(closed.length, 1);
        assert.equal(closed[0]?.ts, 100);
        const record = buildEthRangeEntryQualityOpportunityRecord(baseCtx({ candles }));
        assert.equal(record?.closedCandleTs, 100);
        assert.notEqual(record?.last3ClosedCandleOhlc?.[0]?.close, 9);
    });

    it("deduplicates same candle opportunity across repeated loops", () => {
        const ctx = baseCtx();
        assert.equal(captureEthRangeEntryQualityOpportunity(ctx), true);
        assert.equal(captureEthRangeEntryQualityOpportunity(ctx), false);
        assert.equal(getEthRangeEntryQualitySeenOpportunityCountForTests(), 1);
    });

    it("creates new opportunity when closed candle advances", () => {
        const ctx1 = baseCtx();
        assert.equal(captureEthRangeEntryQualityOpportunity(ctx1), true);
        const candles2 = mkCandles(
            [
                { ts: 1_060_000, open: 2499, high: 2501, low: 2498, close: 2500 },
                { ts: 1_120_000, open: 2500, high: 2502, low: 2499, close: 2501 },
                { ts: 1_180_000, open: 2501, high: 2503, low: 2500, close: 2502 }
            ],
            { ts: 1_240_000, open: 2502, high: 2504, low: 2501, close: 2503 }
        );
        const ctx2 = baseCtx({ candles: candles2, evaluatedAt: 1_190_000 });
        assert.equal(captureEthRangeEntryQualityOpportunity(ctx2), true);
        assert.equal(getEthRangeEntryQualitySeenOpportunityCountForTests(), 2);
    });

    it("separates long and short candidate sides", () => {
        const fpLong = buildSetupFingerprint({
            candidateSide: "long",
            rangePhase: "FLAT",
            marketSubtype: "RANGE_BOUND",
            boxPos: 0.52
        });
        const fpShort = buildSetupFingerprint({
            candidateSide: "short",
            rangePhase: "FLAT",
            marketSubtype: "RANGE_BOUND",
            boxPos: 0.52
        });
        const idLong = buildEthRangeEntryQualityOpportunityId({
            symbol: "ETHUSDT",
            closedCandleTs: 1_120_000,
            candidateSide: "long",
            setupFingerprint: fpLong
        });
        const idShort = buildEthRangeEntryQualityOpportunityId({
            symbol: "ETHUSDT",
            closedCandleTs: 1_120_000,
            candidateSide: "short",
            setupFingerprint: fpShort
        });
        assert.notEqual(idLong, idShort);
    });

    it("null-safe when features are missing", () => {
        const record = buildEthRangeEntryQualityOpportunityRecord(
            baseCtx({
                snapshot: { lastPrice: 2500, boxHigh: 2520, boxLow: 2480 },
                candles: null,
                judgment: { regime: "RANGE" }
            })
        );
        assert.ok(record);
        assert.equal(record?.ema20Slope1mAgo, null);
        assert.equal(record?.last3ClosedCandleOhlc, null);
    });

    it("fail-open when store write throws", () => {
        setEthRangeEntryQualityStoreForTests({
            appendOpportunityLine: () => {
                throw new Error("disk full");
            },
            appendOutcomeLine: () => {}
        });
        assert.equal(captureEthRangeEntryQualityOpportunity(baseCtx()), false);
    });

    it("does not mutate decision object when capturing", () => {
        const decision = {
            decision: "SKIP" as const,
            side: "none" as const,
            risk: { blockReason: "TEST" }
        };
        const before = JSON.stringify(decision);
        captureEthRangeEntryQualityOpportunity(
            baseCtx({
                finalDecision: decision.decision,
                finalSide: decision.side,
                finalRejectReason: decision.risk.blockReason
            })
        );
        assert.equal(JSON.stringify(decision), before);
    });

    it("registers flowId linkage after capture + fill", () => {
        captureEthRangeEntryQualityOpportunity(baseCtx({ runCycleId: 99 }));
        maybeRegisterEthRangeEntryQualityFill({
            symbol: "ETHUSDT",
            side: "long",
            openedAt: 1_130_000,
            regimeAtEntry: "RANGE",
            runCycleId: 99
        });
        const link = getEthRangeEntryQualityPendingFlowLinkForTests("99:long:1120000");
        assert.ok(link?.opportunityId);
    });

    it("resolves candidate side from metadata fallbacks", () => {
        assert.equal(
            resolveEthRangeEntryQualityCandidateSide("none", undefined, "short"),
            "short"
        );
    });

    it("records outcome without TYPE labels", () => {
        const closed: PaperClosedPositionRecord = {
            openedAt: 1,
            closedAt: 2,
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2500,
            closePrice: 2510,
            leverage: 10,
            sizeUsd: 100,
            pnlUsd: 1,
            pnlUsdGross: 1.2,
            pnlUsdNet: 1,
            feeRate: 0.0006,
            feeUsd: 0.1,
            fundingModel: "avg_open_close_rate_v3",
            fundingIntervalHours: 8,
            holdingMs: 600_000,
            fundingPeriods: 0,
            fundingRateAppliedOpen: 0,
            fundingRateAppliedClose: 0,
            fundingRateAverage: 0,
            fundingUsd: 0,
            strategyVersion: "paper-v2",
            sourceSignal: "paper_long_candidate_v2",
            sourceRunPath: "",
            closeReason: "take_profit",
            exitType: "EXIT_TP_1",
            closeReasonLabel: "tp",
            regimeAtEntry: "RANGE",
            flowId: "ETHUSDT:long:1"
        };
        const out = buildEthRangeEntryQualityOutcomeRecord(closed);
        assert.ok(out);
        assert.equal(out?.outcomeClass, "TP1");
        assert.ok(out?.netPnlBps != null);
        assert.equal((out as { typeLabel?: string }).typeLabel, undefined);
    });

    it("outcome linker bypasses non-ETH", () => {
        let called = false;
        setEthRangeEntryQualityStoreForTests({
            appendOpportunityLine: () => {},
            appendOutcomeLine: () => {
                called = true;
            }
        });
        recordEthRangeEntryQualityOutcome({
            openedAt: 1,
            closedAt: 2,
            symbol: "BTCUSDT",
            side: "long",
            entryPrice: 1,
            closePrice: 1,
            leverage: 1,
            sizeUsd: 1,
            pnlUsd: 0,
            pnlUsdGross: 0,
            pnlUsdNet: 0,
            feeRate: 0,
            feeUsd: 0,
            fundingModel: "avg_open_close_rate_v3",
            fundingIntervalHours: 8,
            holdingMs: 1,
            fundingPeriods: 0,
            fundingRateAppliedOpen: 0,
            fundingRateAppliedClose: 0,
            fundingRateAverage: 0,
            fundingUsd: 0,
            strategyVersion: "paper-v2",
            sourceSignal: "x",
            sourceRunPath: "",
            closeReason: "regime_exit",
            exitType: "EXIT_REGIME",
            closeReasonLabel: "x",
            regimeAtEntry: "RANGE"
        } as PaperClosedPositionRecord);
        assert.equal(called, false);
    });

    it("runEngineV2 capture hook does not change returned decision shape for BTC", () => {
        const input = {
            symbol: "BTCUSDT" as const,
            now: Date.now(),
            candles: [],
            snapshot: {
                lastPrice: 65000,
                latestCandleClose: 65000,
                boxHigh: 66000,
                boxLow: 64000,
                boxPos: 0.5,
                rangeConfidence: 0.8,
                ema20: 65000,
                emaGap: 0,
                volatilityProxy: 100,
                signal: "NONE" as const,
                qualityScore: 50
            },
            config: { paperTakerFeeRate: 0.0005 },
            state: {
                currentPositions: [],
                globalRiskScore: 0,
                lossStreaks: {},
                directionalShockState: "NONE" as const,
                longAllow: true,
                shortAllow: true,
                executionReadiness: true
            },
            v1Result: {
                decision: { final_decision: "SKIP", regime_state: "RANGE" },
                intentSide: "none",
                adaptiveOk: true,
                adaptiveDetail: ""
            }
        };
        const res = runEngineV2(input as any);
        assert.ok(res.decision);
    });
});
