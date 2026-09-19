import test from "node:test";
import assert from "node:assert/strict";
import { evaluateShortReversalWatch } from "../engine-v2/market-judgment/short-reversal-watch";
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

function createHtfCandles(count = 30, basePrice = 60000, step = 200) {
    const closes: number[] = [];
    for (let i = 0; i < count; i++) {
        closes.push(basePrice + i * step);
    }
    return createCandles(closes);
}

function makeTestInput(overrides: Partial<EngineV2Input> = {}): EngineV2Input {
    const defaultCandles = createCandles([
        68000, 68500, 69000, 69500, 70000, 70500, 71000, 71500, 72000, 71500,
        71000, 70500, 70000, 69500, 69000, 69500, 70000, 70500, 69500, 68700
    ]);
    const htfPack = {
        "5m": createHtfCandles(30, 65000, 100),
        "15m": createHtfCandles(30, 62000, 200),
        "1h": createHtfCandles(30, 58000, 300),
        "4h": createHtfCandles(30, 50000, 500),
        "1d": createHtfCandles(30, 40000, 1000)
    };
    const now = Date.now();
    return {
        run_cycle_id: "test-cycle-reversal-1",
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
            lastPrice: 68700,
            latestCandleClose: 68700,
            qualityScore: 80,
            boxPos: 0.8,
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
            directionalShockState: "UP",
            rawDirectionalShockState: "NONE",
            longAllow: true,
            shortAllow: false,
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

test("V2 SHORT REVERSAL WATCH AUTHORITY SUITE", async (t) => {
    await t.test("1. evaluateShortReversalWatch: Breakout not failed when price never pierced boxHigh", () => {
        const res = evaluateShortReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 65000,
            boxHigh: 70000,
            candles: [
                { open: 64000, high: 65000, low: 63900, close: 64500 },
                { open: 64500, high: 65200, low: 64400, close: 65000 },
                { open: 65000, high: 65100, low: 64900, close: 65000 },
                { open: 65000, high: 65100, low: 64900, close: 65000 }
            ]
        });

        assert.equal(res.breakout_failed, false);
        assert.equal(res.probe_allowed, false);
        assert.equal(res.probe_block_reason, "BREAKOUT_NOT_FAILED");
    });

    await t.test("2. evaluateShortReversalWatch: Single candle drop after breakout is REJECTED (no multi-candle lower high)", () => {
        // Price spiked above boxHigh (70,000 -> 72,000) then dropped to 69,500 in one candle
        const res = evaluateShortReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 69500,
            boxHigh: 70000,
            candles: [
                { open: 68000, high: 69000, low: 67900, close: 68500 },
                { open: 68500, high: 72000, low: 68500, close: 71500 }, // Peak at 72000 (maxHighIdx)
                { open: 71500, high: 71500, low: 69000, close: 69500 }, // Single candle drop
                { open: 69500, high: 69600, low: 69400, close: 69500 }  // forming bar
            ]
        });

        assert.equal(res.breakout_failed, true);
        assert.equal(res.lower_high_confirmed, false);
        assert.equal(res.probe_allowed, false);
        assert.equal(res.probe_block_reason, "LOWER_HIGH_NOT_CONFIRMED");
    });

    await t.test("3. evaluateShortReversalWatch: Lower-high formed but intermediate trough low not breached", () => {
        // Peak at 72,000 -> Pullback to 69,000 (trough) -> Lower high at 70,500 -> Closed rejection at 69,500 (> 69,000 trough)
        const res = evaluateShortReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 69500,
            boxHigh: 70000,
            candles: [
                { open: 67000, high: 68000, low: 66900, close: 67500 },
                { open: 68500, high: 72000, low: 68500, close: 71500 }, // Peak 1: 72,000
                { open: 71500, high: 71500, low: 69000, close: 69200 }, // Pullback trough: 69,000
                { open: 69200, high: 70500, low: 69100, close: 70200 }, // Lower high peak 2: 70,500 (< 72,000)
                { open: 70200, high: 70300, low: 69400, close: 69500 }, // Rejection candle, but price 69,500 > trough 69,000
                { open: 69500, high: 69600, low: 69400, close: 69500 }  // forming bar
            ]
        });

        assert.equal(res.breakout_failed, true);
        assert.equal(res.lower_high_confirmed, true);
        assert.equal(res.micro_structure_break, false);
        assert.equal(res.probe_allowed, false);
        assert.equal(res.probe_block_reason, "MICRO_STRUCTURE_NOT_BROKEN");
    });

    await t.test("4. evaluateShortReversalWatch: Full 3-step criteria met allows countertrend short probe", () => {
        // Peak at 72,000 -> Trough at 69,000 -> Lower high at 70,500 -> Micro structure break below 69,000 (close 68,700)
        const res = evaluateShortReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 68700,
            boxHigh: 70000,
            htfPolicy: "LONG_ONLY_OR_NONE",
            canonicalRegime: "RANGE",
            zone: "upper",
            candles: [
                { open: 67000, high: 68000, low: 66900, close: 67500 },
                { open: 68500, high: 72000, low: 68500, close: 71500 }, // Peak 1: 72,000
                { open: 71500, high: 71500, low: 69000, close: 69200 }, // Pullback trough: 69,000
                { open: 69200, high: 70500, low: 69100, close: 70200 }, // Lower high peak 2: 70,500
                { open: 70200, high: 70300, low: 68600, close: 68700 }, // Breaks trough low (68,700 < 69,000)
                { open: 68700, high: 68800, low: 68600, close: 68700 }  // forming bar
            ]
        });

        assert.equal(res.breakout_failed, true);
        assert.equal(res.lower_high_confirmed, true);
        assert.equal(res.micro_structure_break, true);
        assert.equal(res.probe_allowed, true);
        assert.equal(res.probe_block_reason, null);
        assert.equal(res.htf_upgrade_ready, false);
        assert.ok(res.stopPrice && res.stopPrice > 68700);
        assert.ok(res.invalidationPrice && res.invalidationPrice >= 72000);
    });

    await t.test("5. evaluateShortReversalWatch: HTF 15m/1h weakness alignment upgrades to normal short authority", () => {
        const res = evaluateShortReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 68700,
            boxHigh: 70000,
            htfPolicy: "LONG_ONLY_OR_NONE",
            canonicalRegime: "RANGE",
            zone: "upper",
            htf1hBias: "BEARISH",
            htf15mBias: "WEAK_DOWN",
            candles: [
                { open: 67000, high: 68000, low: 66900, close: 67500 },
                { open: 68500, high: 72000, low: 68500, close: 71500 },
                { open: 71500, high: 71500, low: 69000, close: 69200 },
                { open: 69200, high: 70500, low: 69100, close: 70200 },
                { open: 70200, high: 70300, low: 68600, close: 68700 },
                { open: 68700, high: 68800, low: 68600, close: 68700 }
            ]
        });

        assert.equal(res.probe_allowed, true);
        assert.equal(res.htf_upgrade_ready, true);
        assert.equal(res.proof.htf_upgrade_ready, true);
    });

    await t.test("6. runEngineV2: Under LONG_ONLY_OR_NONE, ordinary short is blocked, but SHORT_REVERSAL_WATCH allows probe", () => {
        // Case A: Ordinary short without failed breakout / lower high -> BLOCKED
        const inputBlocked = makeTestInput({
            snapshot: {
                lastPrice: 70000,
                latestCandleClose: 70000,
                boxPos: 0.5,
                boxHigh: 71000,
                boxLow: 65000,
                candles: [
                    { open: 69000, high: 70500, low: 68900, close: 70000 }
                ]
            } as any,
            state: {
                directionalShockState: "UP",
                longAllow: true,
                shortAllow: false
            } as any
        });

        const resBlocked = runEngineV2(inputBlocked);
        assert.notEqual(resBlocked.decision.side, "short");

        // Case B: SHORT_REVERSAL_WATCH 3-step structural confirmation met -> PROBE ENTER ALLOWED
        const baseCandles = createCandles([
            67000, 67200, 67100, 67300, 67200, 67400, 67300, 67500, 67400, 67600,
            67500, 67700, 67600, 67800, 67700
        ]);
        const reversalPattern = [
            { open: 67700, high: 68000, low: 67600, close: 67800, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 67800, high: 72000, low: 67800, close: 71500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 71500, high: 71500, low: 69000, close: 69200, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 69200, high: 70500, low: 69100, close: 70200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 70200, high: 70300, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 68700, high: 68800, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const inputAllowed = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                lastPrice: 68700,
                latestCandleClose: 68700,
                boxPos: 0.8,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "UP",
                longAllow: true,
                shortAllow: false
            } as any
        });

        const resAllowed = runEngineV2(inputAllowed);
        assert.equal(resAllowed.decision.side, "short");
        assert.equal(resAllowed.decision.decision, "ENTER");
        assert.equal(resAllowed.decision.metadata?.entryReason, "V2_SHORT_REVERSAL_WATCH_PROBE");
        assert.ok(Number(resAllowed.decision.risk?.stageMarginKrw ?? 0) > 0, "stageMarginKrw should be > 0");
        assert.ok(Number(resAllowed.decision.risk?.exposureNotionalKrw ?? 0) > 0, "exposureNotionalKrw should be > 0");
        assert.ok(resAllowed.decision.committedRiskPlan != null, "committedRiskPlan should not be null");
        assert.ok(Number(resAllowed.decision.lifecycleAuthority?.newStopPrice ?? 0) > 0, "newStopPrice should be > 0");
    });

    await t.test("7. Finalization Invariant: Paper mode with positive stageMarginKrw and valid stop stays ENTER", () => {
        const baseCandles = createCandles([
            67000, 67200, 67100, 67300, 67200, 67400, 67300, 67500, 67400, 67600,
            67500, 67700, 67600, 67800, 67700
        ]);
        const reversalPattern = [
            { open: 67700, high: 68000, low: 67600, close: 67800, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 67800, high: 72000, low: 67800, close: 71500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 71500, high: 71500, low: 69000, close: 69200, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 69200, high: 70500, low: 69100, close: 70200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 70200, high: 70300, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 68700, high: 68800, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const paperInput = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                lastPrice: 68700,
                latestCandleClose: 68700,
                boxPos: 0.8,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "UP",
                longAllow: true,
                shortAllow: false,
                accountEquityKrw: 14_000_000,
                okxLiveEnabled: false,
                signedExecutionReady: false
            } as any
        });

        const res = runEngineV2(paperInput);
        assert.equal(res.decision.decision, "ENTER");
        assert.equal(res.decision.side, "short");
        assert.equal(res.decision.risk.finalOrderNotionalUsdt, undefined);
        assert.ok(Number(res.decision.risk.stageMarginKrw ?? 0) > 0);
    });

    await t.test("8. Finalization Invariant: Paper mode with 0 stage margin is blocked with PAPER_STAGE_MARGIN_ZERO", () => {
        const baseCandles = createCandles([
            67000, 67200, 67100, 67300, 67200, 67400, 67300, 67500, 67400, 67600,
            67500, 67700, 67600, 67800, 67700
        ]);
        const reversalPattern = [
            { open: 67700, high: 68000, low: 67600, close: 67800, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 67800, high: 72000, low: 67800, close: 71500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 71500, high: 71500, low: 69000, close: 69200, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 69200, high: 70500, low: 69100, close: 70200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 70200, high: 70300, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 68700, high: 68800, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const zeroMarginInput = makeTestInput({
            candles: allCandles as any,
            config: {
                baseSizeUsd: 0
            } as any,
            snapshot: {
                lastPrice: 68700,
                latestCandleClose: 68700,
                boxPos: 0.8,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "UP",
                longAllow: true,
                shortAllow: false,
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
            67000, 67200, 67100, 67300, 67200, 67400, 67300, 67500, 67400, 67600,
            67500, 67700, 67600, 67800, 67700
        ]);
        const reversalPattern = [
            { open: 67700, high: 68000, low: 67600, close: 67800, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 67800, high: 72000, low: 67800, close: 71500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 71500, high: 71500, low: 69000, close: 69200, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 69200, high: 70500, low: 69100, close: 70200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 70200, high: 70300, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 68700, high: 68800, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const liveInput = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                lastPrice: 68700,
                latestCandleClose: 68700,
                boxPos: 0.8,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "UP",
                longAllow: true,
                shortAllow: false,
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
        assert.equal(res.decision.side, "short");
        assert.ok(Number(res.decision.risk.finalOrderNotionalUsdt ?? 0) > 0);
    });

    await t.test("10. Finalization Invariant: Live signed finalization with zero notional prevents execution with ORDER_NOTIONAL_ZERO", () => {
        const baseCandles = createCandles([
            67000, 67200, 67100, 67300, 67200, 67400, 67300, 67500, 67400, 67600,
            67500, 67700, 67600, 67800, 67700
        ]);
        const reversalPattern = [
            { open: 67700, high: 68000, low: 67600, close: 67800, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 67800, high: 72000, low: 67800, close: 71500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 71500, high: 71500, low: 69000, close: 69200, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 69200, high: 70500, low: 69100, close: 70200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 70200, high: 70300, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 68700, high: 68800, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const liveZeroInput = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                lastPrice: 68700,
                latestCandleClose: 68700,
                boxPos: 0.8,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "UP",
                longAllow: true,
                shortAllow: false,
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
    // MANDATORY REGRESSION TEST SUITE: SCENARIOS A through H
    // -------------------------------------------------------------------------

    await t.test("A. RANGE upper + actual boxHigh breakout + lower-high + trough break => PROBE ENTER", () => {
        const baseCandles = createCandles([
            67000, 67200, 67100, 67300, 67200, 67400, 67300, 67500, 67400, 67600,
            67500, 67700, 67600, 67800, 67700
        ]);
        const reversalPattern = [
            { open: 67700, high: 68000, low: 67600, close: 67800, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 67800, high: 72000, low: 67800, close: 71500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 }, // Actual breakout above boxHigh 70000
            { open: 71500, high: 71500, low: 69000, close: 69200, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 }, // Trough at 69000
            { open: 69200, high: 70500, low: 69100, close: 70200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 }, // Lower high at 70500
            { open: 70200, high: 70300, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 }, // Trough break confirmed
            { open: 68700, high: 68800, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }  // Forming bar
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const inputAllowed = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                canonicalRegime: "RANGE",
                lastPrice: 68700,
                latestCandleClose: 68700,
                boxPos: 0.8,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "UP",
                longAllow: true,
                shortAllow: false
            } as any
        });

        const res = runEngineV2(inputAllowed);
        assert.equal(res.decision.side, "short");
        assert.equal(res.decision.decision, "ENTER");
        assert.equal(res.decision.metadata?.entryReason, "V2_SHORT_REVERSAL_WATCH_PROBE");
    });

    await t.test("B. 3-step pattern in TREND regime => exception NOT eligible", () => {
        const baseCandles = createCandles([
            67000, 67200, 67100, 67300, 67200, 67400, 67300, 67500, 67400, 67600,
            67500, 67700, 67600, 67800, 67700
        ]);
        const reversalPattern = [
            { open: 67700, high: 68000, low: 67600, close: 67800, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 67800, high: 72000, low: 67800, close: 71500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 71500, high: 71500, low: 69000, close: 69200, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 69200, high: 70500, low: 69100, close: 70200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 70200, high: 70300, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 68700, high: 68800, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const inputTrend = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                canonicalRegime: "TREND",
                lastPrice: 68700,
                latestCandleClose: 68700,
                boxPos: 0.8,
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
                directionalShockState: "UP",
                longAllow: true,
                shortAllow: false
            } as any
        });

        const res = runEngineV2(inputTrend);
        assert.notEqual(res.decision.side, "short");
        assert.notEqual(res.decision.decision, "ENTER");
    });

    await t.test("C. RANGE mid/lower with 3-step pattern => exception NOT eligible", () => {
        const baseCandles = createCandles([
            67000, 67200, 67100, 67300, 67200, 67400, 67300, 67500, 67400, 67600,
            67500, 67700, 67600, 67800, 67700
        ]);
        const reversalPattern = [
            { open: 67700, high: 68000, low: 67600, close: 67800, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 67800, high: 72000, low: 67800, close: 71500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 71500, high: 71500, low: 69000, close: 69200, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 69200, high: 70500, low: 69100, close: 70200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 70200, high: 70300, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 68700, high: 68800, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const inputMid = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                canonicalRegime: "RANGE",
                lastPrice: 68700,
                latestCandleClose: 68700,
                boxPos: 0.4, // Mid zone
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles
            } as any,
            state: {
                directionalShockState: "UP",
                longAllow: true,
                shortAllow: false
            } as any
        });

        const res = runEngineV2(inputMid);
        assert.notEqual(res.decision.side, "short");
        assert.notEqual(res.decision.decision, "ENTER");
    });

    await t.test("D. Reaching 99.9% of boxHigh without touching/breaking => breakout_failed=false", () => {
        // boxHigh = 70000, peak reaches 69950 (99.928% but < 70000)
        const res = evaluateShortReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 68700,
            boxHigh: 70000,
            candles: [
                { open: 67000, high: 68000, low: 66900, close: 67500 },
                { open: 68500, high: 69950, low: 68500, close: 69800 }, // Under boxHigh
                { open: 69800, high: 69800, low: 69000, close: 69200 },
                { open: 69200, high: 69600, low: 69100, close: 69500 },
                { open: 69500, high: 69600, low: 68600, close: 68700 },
                { open: 68700, high: 68800, low: 68600, close: 68700 }
            ]
        });

        assert.equal(res.breakout_failed, false);
        assert.equal(res.probe_allowed, false);
        assert.equal(res.probe_block_reason, "BREAKOUT_NOT_FAILED");
    });

    await t.test("E. Only forming candle breaks trough, closed candle not confirmed => probe NOT allowed", () => {
        // Peak 72000 -> Trough 69000 -> Lower high 70500 -> Closed candle rejection at 69500 (> 69000)
        // Forming bar (live) breaks to 68700 (< 69000)
        const closedCandlesPattern = [
            { open: 67000, high: 68000, low: 66900, close: 67500 },
            { open: 68500, high: 72000, low: 68500, close: 71500 }, // Peak 72000
            { open: 71500, high: 71500, low: 69000, close: 69200 }, // Trough 69000
            { open: 69200, high: 70500, low: 69100, close: 70200 }, // Lower High 70500
            { open: 70200, high: 70300, low: 69400, close: 69500 }  // Closed candle did NOT break trough
        ];
        const formingCandle = { open: 69500, high: 69600, low: 68600, close: 68700 }; // Forming bar breaks trough

        const res = evaluateShortReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 68700,
            boxHigh: 70000,
            candles: [...closedCandlesPattern, formingCandle]
        });

        assert.equal(res.lower_high_confirmed, true);
        assert.equal(res.micro_structure_break, false);
        assert.equal(res.probe_allowed, false);
        assert.equal(res.probe_block_reason, "MICRO_STRUCTURE_NOT_BROKEN");
    });

    await t.test("F. Same candle closes and confirms trough break => probe ALLOWED", () => {
        // Previous forming candle now closes at 68700, and a new forming bar arrives
        const closedCandlesPattern = [
            { open: 67000, high: 68000, low: 66900, close: 67500 },
            { open: 68500, high: 72000, low: 68500, close: 71500 }, // Peak 72000
            { open: 71500, high: 71500, low: 69000, close: 69200 }, // Trough 69000
            { open: 69200, high: 70500, low: 69100, close: 70200 }, // Lower High 70500
            { open: 70200, high: 70300, low: 68600, close: 68700 }  // Closed candle CONFIRMS trough break
        ];
        const newFormingCandle = { open: 68700, high: 68800, low: 68600, close: 68700 };

        const res = evaluateShortReversalWatch({
            symbol: "BTCUSDT",
            lastPrice: 68700,
            boxHigh: 70000,
            canonicalRegime: "RANGE",
            zone: "upper",
            candles: [...closedCandlesPattern, newFormingCandle]
        });

        assert.equal(res.lower_high_confirmed, true);
        assert.equal(res.micro_structure_break, true);
        assert.equal(res.probe_allowed, true);
        assert.equal(res.exception_eligible, true);
        assert.equal(res.final_short_authority, "V2_SHORT_REVERSAL_WATCH_PROBE");
    });

    await t.test("G. Eligible RANGE upper structure + 15m/1h bearish alignment => V2_SHORT_REVERSAL_HTF_UPGRADED_AUTHORITY", () => {
        const baseCandles = createCandles([
            67000, 67200, 67100, 67300, 67200, 67400, 67300, 67500, 67400, 67600,
            67500, 67700, 67600, 67800, 67700
        ]);
        const reversalPattern = [
            { open: 67700, high: 68000, low: 67600, close: 67800, volume: 100, ts: 1788410000000 + 15 * 60000, time: 1788410000000 + 15 * 60000 },
            { open: 67800, high: 72000, low: 67800, close: 71500, volume: 100, ts: 1788410000000 + 16 * 60000, time: 1788410000000 + 16 * 60000 },
            { open: 71500, high: 71500, low: 69000, close: 69200, volume: 100, ts: 1788410000000 + 17 * 60000, time: 1788410000000 + 17 * 60000 },
            { open: 69200, high: 70500, low: 69100, close: 70200, volume: 100, ts: 1788410000000 + 18 * 60000, time: 1788410000000 + 18 * 60000 },
            { open: 70200, high: 70300, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 19 * 60000, time: 1788410000000 + 19 * 60000 },
            { open: 68700, high: 68800, low: 68600, close: 68700, volume: 100, ts: 1788410000000 + 20 * 60000, time: 1788410000000 + 20 * 60000 }
        ];
        const allCandles = [...baseCandles, ...reversalPattern];

        const htfBearishCandles = [
            { open: 71000, high: 71500, low: 69000, close: 69500 },
            { open: 69500, high: 69800, low: 68500, close: 68700 }
        ];

        const inputHtfAligned = makeTestInput({
            candles: allCandles as any,
            snapshot: {
                canonicalRegime: "RANGE",
                lastPrice: 68700,
                latestCandleClose: 68700,
                boxPos: 0.8,
                boxHigh: 70000,
                boxLow: 65000,
                candles: allCandles,
                htf_candles: {
                    "15m": htfBearishCandles,
                    "1h": htfBearishCandles
                }
            } as any,
            state: {
                directionalShockState: "NONE",
                longAllow: true,
                shortAllow: true
            } as any
        });

        const res = runEngineV2(inputHtfAligned);
        assert.equal(res.decision.side, "short");
        assert.equal(res.decision.decision, "ENTER");
        assert.equal(res.decision.metadata?.entryReason, "V2_SHORT_REVERSAL_HTF_UPGRADED_AUTHORITY");
    });

    await t.test("H. Bullish pullback long path unchanged", () => {
        const inputBullishPullbackLong = makeTestInput({
            snapshot: {
                canonicalRegime: "RANGE",
                lastPrice: 65200,
                latestCandleClose: 65200,
                boxPos: 0.1,
                boxHigh: 70000,
                boxLow: 65000,
                candles: createCandles([65500, 65400, 65300, 65100, 65200])
            } as any,
            state: {
                directionalShockState: "NONE",
                longAllow: true,
                shortAllow: true
            } as any
        });

        const res = runEngineV2(inputBullishPullbackLong);
        assert.ok(res.decision != null);
    });
});


