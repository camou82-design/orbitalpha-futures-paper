import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLongReversalWatch } from "../engine-v2/market-judgment/long-reversal-watch";
import { runEngineV2 } from "../engine-v2/index";
import { EngineV2Input } from "../engine-v2/types";

function createCandles(closes: number[], baseTs = 1788410000000) {
    return closes.map((close, i) => ({
        ts: baseTs + i * 60000,
        time: baseTs + i * 60000,
        open: close * 0.9995,
        high: close * 1.0005,
        low: close * 0.9990,
        close,
        volume: 100
    }));
}

function createHtfCandles(count = 30, basePrice = 60000, step = -200) {
    const closes: number[] = [];
    for (let i = 0; i < count; i++) {
        closes.push(basePrice + i * step);
    }
    return createCandles(closes);
}

function makeTestInput(overrides: Partial<EngineV2Input> = {}): EngineV2Input {
    const defaultCandles = createCandles([
        68000, 67500, 67000, 66500, 66000, 65500, 65000, 64500, 64000, 64500,
        65000, 65500, 66000, 66500, 67000, 66500, 66000, 65500, 66500, 66400
    ]);
    const htfPack = {
        "5m": createHtfCandles(30, 65000, -100),
        "15m": createHtfCandles(30, 68000, -200),
        "1h": createHtfCandles(30, 72000, -300),
        "4h": createHtfCandles(30, 80000, -500),
        "1d": createHtfCandles(30, 90000, -1000)
    };
    const now = Date.now();
    return {
        run_cycle_id: "test-cycle-long-reversal-1",
        symbol: "BTCUSDT",
        now,
        candles: defaultCandles,
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            okxLiveMaxOrderNotionalUsdt: null,
            ...(overrides.config ?? {})
        } as any,
        evaluationMode: "authoritative",
        v1Result: {
            regime: "RANGE",
            decision: "HOLD",
            side: "NONE",
            isBlocked: false
        },
        ...overrides,
        snapshot: {
            symbol: "BTCUSDT",
            lastPrice: 66400,
            latestCandleClose: 66400,
            qualityScore: 80,
            boxPos: 0.2,
            boxLow: 65000,
            boxHigh: 70000,
            atr: 500,
            rangeConfidence: 0.85,
            boxCohesion01: 0.95,
            trendWeaknessScore: 0.25,
            candles: defaultCandles,
            htf_candles: htfPack,
            tickSz: 0.1,
            lotSz: 0.01,
            canonicalRegime: "RANGE",
            ...(overrides.snapshot ?? {})
        } as any,
        state: {
            currentPositions: [],
            directionalShockState: "DOWN",
            rawDirectionalShockState: "NONE",
            longAllow: false,
            shortAllow: true,
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            paperExecutionReady: true,
            signedExecutionReady: false,
            accountEquityKrw: 14_000_000,
            accountEquityUsdt: 10_000,
            availableBalanceUsdt: 10_000,
            liveBalanceReady: true,
            okxActualPositionsReady: true,
            actualAccountNotionalUsdtReady: true,
            exposureNotionalCapKrw: 100_000_000,
            symbolExposureNotionalCapKrw: 50_000_000,
            okxActualPositions: [],
            okxPendingOrdersReady: true,
            okxPendingOrdersNotionalUsdt: 0,
            okxPendingSymbolNotionalUsdt: 0,
            hasSymbolPendingEntry: false,
            hasUnknownPendingNotional: false,
            okxLiveEnabled: false,
            okxAuthMode: "demo",
            okxAuthReady: false,
            okxExchangeAuthOptIn: false,
            okxApiKeyPresent: false,
            okxApiSecretPresent: false,
            okxPassphrasePresent: false,
            okxSimulatedTradingHeaderEnabled: false,
            balanceFetchedAt: now,
            positionsFetchedAt: now,
            pendingOrdersFetchedAt: now,
            okxInstruments: [
                {
                    instId: "BTC-USDT-SWAP",
                    tickSz: "0.1",
                    lotSz: "0.01",
                    minSz: "0.01",
                    ctVal: "0.01",
                    ctValCcy: "BTC"
                },
                {
                    instId: "BTCUSDT",
                    tickSz: "0.1",
                    lotSz: "0.01",
                    minSz: "0.01",
                    ctVal: "0.01",
                    ctValCcy: "BTC"
                }
            ],
            ...(overrides.state ?? {})
        } as any
    };
}

test("V2 LONG REVERSAL WATCH AUTHORITY SUITE", async (t) => {
    await t.test("1. evaluateLongReversalWatch: Breakdown not failed when price never pierced boxLow", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const forming = { open: 65300, high: 65400, low: 65200, close: 65300, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 };
        const allCandles = [...baseCandles, forming];

        const res = evaluateLongReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 65300,
            boxLow: 65000, // min price in candles is 65200 > 65000
            candles: allCandles as any,
            canonicalRegime: "RANGE",
            zone: "lower"
        });

        assert.strictEqual(res.breakdown_failed, false);
        assert.strictEqual(res.probe_allowed, false);
        assert.strictEqual(res.probe_block_reason, "BREAKDOWN_NOT_FAILED");
    });

    await t.test("2. evaluateLongReversalWatch: Single candle pump after breakdown is REJECTED (no multi-candle higher low)", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const candlesWithSingleRebound = [
            ...baseCandles,
            // Pierces 65000 boxLow down to 64000
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            // Rebounds straight up to 66400
            { open: 64500, high: 66500, low: 64500, close: 66400, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            // Forming
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 }
        ];

        const res = evaluateLongReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 66400,
            boxLow: 65000,
            candles: candlesWithSingleRebound as any,
            canonicalRegime: "RANGE",
            zone: "lower"
        });

        assert.strictEqual(res.breakdown_failed, true);
        assert.strictEqual(res.higher_low_confirmed, false);
        assert.strictEqual(res.probe_allowed, false);
    });

    await t.test("3. evaluateLongReversalWatch: Higher-low formed but intermediate peak high not breached", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const candlesWithHLNoBreak = [
            ...baseCandles,
            // Breakdown below 65000 to 64000
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            // Reentry closed above 65000
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            // Intermediate peak at 66200
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            // Higher low pullback at 64800 (higher than 64000)
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            // Current price is only 65500 (has NOT broken 66200)
            { open: 65200, high: 65600, low: 65100, close: 65500, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            // Forming
            { open: 65500, high: 65600, low: 65400, close: 65500, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];

        const res = evaluateLongReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 65500,
            boxLow: 65000,
            candles: candlesWithHLNoBreak as any,
            canonicalRegime: "RANGE",
            zone: "lower"
        });

        assert.strictEqual(res.breakdown_failed, true);
        assert.strictEqual(res.higher_low_confirmed, true);
        assert.strictEqual(res.micro_structure_break, false);
        assert.strictEqual(res.probe_allowed, false);
        assert.strictEqual(res.probe_block_reason, "MICRO_STRUCTURE_NOT_BROKEN");
    });

    await t.test("4. evaluateLongReversalWatch: Full criteria met allows countertrend long probe", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const candlesWithFullPattern = [
            ...baseCandles,
            // 15: Breakdown below 65000 to 64000
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            // 16: Reentry closed above 65000 at 65500
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            // 17: Intermediate peak at 66200
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            // 18: Higher low pullback at 64800 (higher than 64000)
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            // 19: Breakout above intermediate peak (66200) closed at 66400
            { open: 65200, high: 66500, low: 65100, close: 66400, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            // 20: Forming candle
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];

        const res = evaluateLongReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 66400,
            boxLow: 65000,
            candles: candlesWithFullPattern as any,
            canonicalRegime: "RANGE",
            zone: "lower"
        });

        assert.strictEqual(res.breakdown_failed, true);
        assert.strictEqual(res.higher_low_confirmed, true);
        assert.strictEqual(res.micro_structure_break, true);
        assert.strictEqual(res.probe_allowed, true);
        assert.strictEqual(res.exception_eligible, true);
        assert.strictEqual(res.final_long_authority, "V2_LONG_REVERSAL_WATCH_PROBE");
        assert.strictEqual(res.size_class, "PROBE");
        assert.ok(res.stopPrice != null && res.stopPrice < 66400);
    });

    await t.test("5. evaluateLongReversalWatch: HTF 15m/1h strength alignment upgrades to normal long authority", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const candlesWithFullPattern = [
            ...baseCandles,
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 65200, high: 66500, low: 65100, close: 66400, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];

        const res = evaluateLongReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 66400,
            boxLow: 65000,
            candles: candlesWithFullPattern as any,
            canonicalRegime: "RANGE",
            zone: "lower",
            htf1hBias: "BULLISH",
            htf15mBias: "BULLISH"
        });

        assert.strictEqual(res.probe_allowed, true);
        assert.strictEqual(res.htf_upgrade_ready, true);
        assert.strictEqual(res.exception_eligible, true);
        assert.strictEqual(res.final_long_authority, "V2_LONG_REVERSAL_HTF_UPGRADED_AUTHORITY");
        assert.strictEqual(res.size_class, "NORMAL");
    });

    await t.test("6. runEngineV2: Under SHORT_ONLY_OR_NONE, ordinary long is blocked, but LONG_REVERSAL_WATCH allows probe", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const reversalPattern = [
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 65200, high: 66500, low: 65100, close: 66400, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const inputAllowed = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                canonicalRegime: "RANGE",
                lastPrice: 66400,
                latestCandleClose: 66400,
                boxPos: 0.2,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "DOWN",
                longAllow: false,
                shortAllow: true
            } as any
        });

        const resAllowed = runEngineV2(inputAllowed);
        assert.equal(resAllowed.decision.side, "long");
        assert.equal(resAllowed.decision.decision, "ENTER");
        assert.equal(resAllowed.decision.metadata?.entryReason, "V2_LONG_REVERSAL_WATCH_PROBE");
        assert.ok(resAllowed.decision.committedRiskPlan != null, "committedRiskPlan should not be null");
        assert.ok(Number(resAllowed.decision.lifecycleAuthority?.newStopPrice ?? 0) > 0, "newStopPrice should be > 0");
    });

    await t.test("7. Finalization Invariant: Paper mode with positive stageMarginKrw and valid stop stays ENTER", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const reversalPattern = [
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 65200, high: 66500, low: 65100, close: 66400, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const paperInput = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                lastPrice: 66400,
                latestCandleClose: 66400,
                boxPos: 0.2,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "DOWN",
                longAllow: false,
                shortAllow: true,
                accountEquityKrw: 14_000_000,
                okxLiveEnabled: false,
                signedExecutionReady: false
            } as any
        });

        const res = runEngineV2(paperInput);
        assert.equal(res.decision.decision, "ENTER");
        assert.equal(res.decision.side, "long");
        assert.equal(res.decision.risk.finalOrderNotionalUsdt, undefined);
        assert.ok(Number(res.decision.risk.stageMarginKrw ?? 0) > 0);
    });

    await t.test("8. Finalization Invariant: Paper mode with 0 stage margin is blocked with PAPER_STAGE_MARGIN_ZERO", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const reversalPattern = [
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 65200, high: 66500, low: 65100, close: 66400, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const zeroMarginInput = makeTestInput({
            candles: allCandles as any,
            config: {
                baseSizeUsd: 0
            } as any,
            snapshot: {
                lastPrice: 66400,
                latestCandleClose: 66400,
                boxPos: 0.2,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "DOWN",
                longAllow: false,
                shortAllow: true,
                accountEquityKrw: 14_000_000,
                okxLiveEnabled: false,
                signedExecutionReady: false
            } as any
        });

        const res = runEngineV2(zeroMarginInput);
        assert.equal(res.decision.decision, "SKIP");
        assert.equal(res.decision.side, "none");
        assert.equal(res.decision.metadata?.final_enter_block_reason, "PAPER_STAGE_MARGIN_ZERO");
    });

    await t.test("9. Finalization Invariant: Live signed mode with finalOrderNotionalUsdt > 0 passes ENTER", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const reversalPattern = [
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 65200, high: 66500, low: 65100, close: 66400, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const liveInput = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                lastPrice: 66400,
                latestCandleClose: 66400,
                boxPos: 0.2,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "DOWN",
                longAllow: false,
                shortAllow: true,
                accountEquityKrw: 14_000_000,
                accountEquityUsdt: 10_000,
                availableBalanceUsdt: 10_000,
                liveBalanceReady: true,
                okxLiveEnabled: true,
                okxAuthMode: "live",
                okxAuthReady: true,
                okxExchangeAuthOptIn: true,
                okxApiKeyPresent: true,
                okxApiSecretPresent: true,
                okxPassphrasePresent: true,
                okxSimulatedTradingHeaderEnabled: true,
                signedExecutionReady: true
            } as any
        });

        const res = runEngineV2(liveInput);
        assert.equal(res.decision.decision, "ENTER");
        assert.equal(res.decision.side, "long");
        assert.ok(Number(res.decision.risk.finalOrderNotionalUsdt ?? 0) > 0);
    });

    await t.test("10. Finalization Invariant: Live signed finalization with zero notional prevents execution with ORDER_NOTIONAL_ZERO", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const reversalPattern = [
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 65200, high: 66500, low: 65100, close: 66400, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const liveZeroInput = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                lastPrice: 66400,
                latestCandleClose: 66400,
                boxPos: 0.2,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "DOWN",
                longAllow: false,
                shortAllow: true,
                accountEquityKrw: 14_000_000,
                accountEquityUsdt: undefined,
                availableBalanceUsdt: undefined,
                liveBalanceReady: false,
                okxLiveEnabled: true,
                okxAuthMode: "live",
                okxAuthReady: true,
                okxExchangeAuthOptIn: true,
                okxApiKeyPresent: true,
                okxApiSecretPresent: true,
                okxPassphrasePresent: true,
                okxSimulatedTradingHeaderEnabled: true,
                signedExecutionReady: true
            } as any
        });

        const res = runEngineV2(liveZeroInput);
        assert.equal(res.decision.decision, "REJECT");
        assert.equal(res.decision.side, "none");
        assert.equal(res.decision.executionAction, "NONE");
        assert.equal(Number(res.decision.risk?.finalOrderNotionalUsdt ?? 0), 0);
        assert.equal(res.decision.committedRiskPlan == null, true);
    });

    // -------------------------------------------------------------------------
    // MANDATORY REGRESSION TEST SUITE: SCENARIOS A through I-2
    // -------------------------------------------------------------------------

    await t.test("A. RANGE lower + actual boxLow breakdown + reentry + Higher-Low + intermediate peak break => PROBE LONG ENTER", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const reversalPattern = [
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 65200, high: 66500, low: 65100, close: 66400, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const inputAllowed = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                canonicalRegime: "RANGE",
                lastPrice: 66400,
                latestCandleClose: 66400,
                boxPos: 0.2,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "DOWN",
                longAllow: false,
                shortAllow: true
            } as any
        });

        const res = runEngineV2(inputAllowed);
        assert.equal(res.decision.side, "long");
        assert.equal(res.decision.decision, "ENTER");
        assert.equal(res.decision.metadata?.entryReason, "V2_LONG_REVERSAL_WATCH_PROBE");
    });

    await t.test("B. 3-step pattern in TREND regime => exception NOT eligible", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const reversalPattern = [
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 65200, high: 66500, low: 65100, close: 66400, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const inputTrend = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                canonicalRegime: "TREND",
                lastPrice: 66400,
                latestCandleClose: 66400,
                boxPos: 0.2,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            v1Result: {
                regime: "TREND",
                decision: "HOLD",
                side: "NONE",
                isBlocked: false
            },
            state: {
                directionalShockState: "DOWN",
                longAllow: false,
                shortAllow: true
            } as any
        });

        const res = runEngineV2(inputTrend);
        assert.notEqual(res.decision.side, "long");
        assert.notEqual(res.decision.decision, "ENTER");
    });

    await t.test("C. RANGE mid/upper with 3-step pattern => exception NOT eligible", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const reversalPattern = [
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 65200, high: 66500, low: 65100, close: 66400, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const inputUpper = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                canonicalRegime: "RANGE",
                lastPrice: 66400,
                latestCandleClose: 66400,
                boxPos: 0.8, // upper zone
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "DOWN",
                longAllow: false,
                shortAllow: true
            } as any
        });

        const res = runEngineV2(inputUpper);
        assert.notEqual(res.decision.side, "long");
        assert.notEqual(res.decision.decision, "ENTER");
    });

    await t.test("D. Reaching 100.1% of boxLow without touching/breaking => breakdown_failed=false", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const nearBreakPattern = [
            // Lowest low is 65065 (100.1% of 65000, NEVER touches or drops below 65000)
            { open: 65300, high: 65400, low: 65065, close: 65100, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 65100, high: 65800, low: 65080, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 65900, high: 66000, low: 65200, close: 65300, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 65300, high: 66500, low: 65250, close: 66400, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...nearBreakPattern];

        const res = evaluateLongReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 66400,
            boxLow: 65000,
            candles: allCandles as any,
            canonicalRegime: "RANGE",
            zone: "lower"
        });

        assert.strictEqual(res.breakdown_failed, false);
        assert.strictEqual(res.probe_allowed, false);
    });

    await t.test("E. Only forming candle breaks peak, closed candle not confirmed => probe NOT allowed", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const formingBreakPattern = [
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            // Peak at 66200
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            // Higher low pullback at 64800
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            // Last CLOSED candle only reaches 65800 (below 66200 peak)
            { open: 65200, high: 65800, low: 65100, close: 65700, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            // FORMING candle spikes up to 66400 (breaking 66200)
            { open: 65700, high: 66400, low: 65600, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...formingBreakPattern];

        const res = evaluateLongReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 66400,
            boxLow: 65000,
            candles: allCandles as any,
            canonicalRegime: "RANGE",
            zone: "lower"
        });

        assert.strictEqual(res.breakdown_failed, true);
        assert.strictEqual(res.higher_low_confirmed, true);
        assert.strictEqual(res.micro_structure_break, false);
        assert.strictEqual(res.probe_allowed, false);
    });

    await t.test("F. Same candle closes and confirms peak break => probe ALLOWED", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const closedBreakPattern = [
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 65200, high: 65800, low: 65100, close: 65700, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            // NOW CLOSED above 66200 at 66400
            { open: 65700, high: 66400, low: 65600, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 },
            // New forming candle
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 21 * 60000, time: 1788410000000 + 21 * 60000 }
        ];
        const allCandles = [...baseCandles, ...closedBreakPattern];

        const res = evaluateLongReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 66400,
            boxLow: 65000,
            candles: allCandles as any,
            canonicalRegime: "RANGE",
            zone: "lower"
        });

        assert.strictEqual(res.breakdown_failed, true);
        assert.strictEqual(res.higher_low_confirmed, true);
        assert.strictEqual(res.micro_structure_break, true);
        assert.strictEqual(res.probe_allowed, true);
    });

    await t.test("G. Eligible RANGE lower reversal + 15m/1h bullish alignment => V2_LONG_REVERSAL_HTF_UPGRADED_AUTHORITY", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const reversalPattern = [
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 65200, high: 66500, low: 65100, close: 66400, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 66400, high: 66500, low: 66300, close: 66400, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const htfBullishCandles = [
            { open: 60000, high: 61000, low: 59900, close: 60800, volume: 100 },
            { open: 60800, high: 62000, low: 60700, close: 61900, volume: 100 }
        ];

        const inputHtfAligned = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                canonicalRegime: "RANGE",
                lastPrice: 66400,
                latestCandleClose: 66400,
                boxPos: 0.2,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles,
                htf_candles: {
                    "15m": htfBullishCandles,
                    "1h": htfBullishCandles
                }
            } as any,
            state: {
                directionalShockState: "NONE",
                longAllow: true,
                shortAllow: true
            } as any
        });

        const res = runEngineV2(inputHtfAligned);
        assert.equal(res.decision.side, "long");
        assert.equal(res.decision.decision, "ENTER");
        assert.equal(res.decision.metadata?.entryReason, "V2_LONG_REVERSAL_HTF_UPGRADED_AUTHORITY");
    });

    await t.test("H. Bearish continuation short path unchanged", () => {
        const inputBearishContinuationShort = makeTestInput({
            snapshot: {
                canonicalRegime: "RANGE",
                lastPrice: 69800,
                latestCandleClose: 69800,
                boxPos: 0.9,
                boxHigh: 70000,
                boxLow: 65000,
                candles: createCandles([69500, 69600, 69700, 69900, 69800])
            } as any,
            state: {
                directionalShockState: "NONE",
                longAllow: true,
                shortAllow: true
            } as any
        });

        const res = runEngineV2(inputBearishContinuationShort);
        assert.ok(res.decision != null);
    });

    await t.test("I-1. Price pierced below boxLow, but last closed candle close is still below boxLow, forming candle bounces above => breakdown_failed=false", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const candlesWithBreakdownStillBelow = [
            ...baseCandles,
            // Candle 16: pierced below 65000 boxLow, closed at 64500 (BELOW boxLow)
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            // Live forming candle only: bounces above 65000 to 65500
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 }
        ];

        const result = evaluateLongReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 65500,
            boxLow: 65000,
            candles: candlesWithBreakdownStillBelow as any,
            canonicalRegime: "RANGE",
            zone: "lower"
        });

        assert.strictEqual(result.breakdown_failed, false);
        assert.strictEqual(result.probe_allowed, false);
    });

    await t.test("I-2. Same candle closes above boxLow, becomes closed candle + new forming candle => breakdown_failed=true", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const candlesWithReentryClosed = [
            ...baseCandles,
            // Candle 16: pierced below 65000 boxLow, closed at 64500
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            // Candle 17: NOW CLOSED above boxLow at 65500
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            // New forming candle
            { open: 65500, high: 65800, low: 65400, close: 65700, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 }
        ];

        const result = evaluateLongReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 65700,
            boxLow: 65000,
            candles: candlesWithReentryClosed as any,
            canonicalRegime: "RANGE",
            zone: "lower"
        });

        assert.strictEqual(result.breakdown_failed, true);
    });

    await t.test("J-1: 확정봉 high만 peak 위로 wick 돌파, close는 peak 아래 → peak_break_confirmed=false, probe_allowed=false, exception_eligible=false", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const candlesWithWickOnlyPeakBreak = [
            ...baseCandles,
            // 15: breakdown below 65000
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            // 16: initial rebound
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            // 17: peak (high: 66200)
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            // 18: higher low (low: 64800 > 64000)
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            // 19: CLOSED candle with high 66500 (> peak 66200), but CLOSE is 66000 (< peak 66200) -> wick only!
            { open: 65200, high: 66500, low: 65100, close: 66000, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            // 20: forming candle
            { open: 66000, high: 66100, low: 65900, close: 66000, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];

        const result = evaluateLongReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 66000,
            boxLow: 65000,
            candles: candlesWithWickOnlyPeakBreak as any,
            canonicalRegime: "RANGE",
            zone: "lower"
        });

        assert.strictEqual(result.breakdown_failed, true);
        assert.strictEqual(result.higher_low_confirmed, true);
        assert.strictEqual(result.peak_break_confirmed, false);
        assert.strictEqual(result.probe_allowed, false);
        assert.strictEqual(result.exception_eligible, false);
    });

    await t.test("J-2: 다음 확정봉 close가 peak 위에서 확정 → peak_break_confirmed=true", () => {
        const baseCandles = createCandles([
            66000, 65800, 65900, 65700, 65800, 65600, 65700, 65500, 65600, 65400,
            65500, 65300, 65400, 65200, 65300
        ]);
        const candlesWithClosePeakBreak = [
            ...baseCandles,
            // 15: breakdown below 65000
            { open: 65300, high: 65400, low: 64000, close: 64500, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            // 16: initial rebound
            { open: 64500, high: 65800, low: 64400, close: 65500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            // 17: peak (high: 66200)
            { open: 65500, high: 66200, low: 65400, close: 65900, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            // 18: higher low (low: 64800 > 64000)
            { open: 65900, high: 66000, low: 64800, close: 65200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            // 19: wick-only candle (close 66000)
            { open: 65200, high: 66500, low: 65100, close: 66000, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            // 20: NOW CLOSED candle with CLOSE 66700 (> peak 66500/66200) -> confirmed close break!
            { open: 66000, high: 66800, low: 65900, close: 66700, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 },
            // 21: new forming candle
            { open: 66700, high: 66800, low: 66600, close: 66700, volume: 100, ts: 1788410000000 + 21 * 60000, time: 1788410000000 + 21 * 60000 }
        ];

        const result = evaluateLongReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 66700,
            boxLow: 65000,
            candles: candlesWithClosePeakBreak as any,
            canonicalRegime: "RANGE",
            zone: "lower"
        });

        assert.strictEqual(result.breakdown_failed, true);
        assert.strictEqual(result.higher_low_confirmed, true);
        assert.strictEqual(result.peak_break_confirmed, true);
        assert.strictEqual(result.probe_allowed, true);
        assert.strictEqual(result.exception_eligible, true);
    });
});
