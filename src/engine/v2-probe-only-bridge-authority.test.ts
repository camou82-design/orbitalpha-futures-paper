import test from "node:test";
import assert from "node:assert/strict";
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

// ── Candle Builders for Multi-Step Reversal Sequences ───────────────────────
// Box: boxLow = 60000, boxHigh = 66000

/**
 * 1-Step Short: breakout_failed only (pierced boxHigh 66000 -> 66600, closed back below 65800, no lower high)
 */
function createShort1StepCandles(baseTs = 1788410000000) {
    const candles: any[] = [];
    for (let i = 0; i < 20; i++) {
        const c = 64500 + i * 50;
        candles.push({ ts: baseTs + i * 60000, time: baseTs + i * 60000, open: c - 20, high: c + 20, low: c - 20, close: c, volume: 100 });
    }
    // Breakout pierce above 66000
    candles.push({ ts: baseTs + 20 * 60000, time: baseTs + 20 * 60000, open: 65500, high: 66600, low: 65400, close: 66400, volume: 200 });
    // Re-enter below 66000 (single drop, no secondary peak / trough structure)
    candles.push({ ts: baseTs + 21 * 60000, time: baseTs + 21 * 60000, open: 66400, high: 66450, low: 65700, close: 65800, volume: 150 });
    // Forming live bar
    candles.push({ ts: baseTs + 22 * 60000, time: baseTs + 22 * 60000, open: 65800, high: 65850, low: 65750, close: 65800, volume: 10 });
    return candles;
}

/**
 * 2-Step Short: breakout_failed + lower-high confirmed, but NO trough break
 * Peak: 66600 -> Trough: 65600 -> Lower High: 66100 -> Close: 65800 (> 65600)
 */
function createShort2StepCandles(baseTs = 1788410000000) {
    const candles: any[] = [];
    for (let i = 0; i < 20; i++) {
        const c = 64500 + i * 50;
        candles.push({ ts: baseTs + i * 60000, time: baseTs + i * 60000, open: c - 20, high: c + 20, low: c - 20, close: c, volume: 100 });
    }
    // Peak piercing 66000
    candles.push({ ts: baseTs + 20 * 60000, time: baseTs + 20 * 60000, open: 65500, high: 66600, low: 65400, close: 66400, volume: 200 });
    // Drop to intermediate trough at 65600
    candles.push({ ts: baseTs + 21 * 60000, time: baseTs + 21 * 60000, open: 66400, high: 66450, low: 65600, close: 65700, volume: 150 });
    // Bounce to lower high at 66100
    candles.push({ ts: baseTs + 22 * 60000, time: baseTs + 22 * 60000, open: 65700, high: 66100, low: 65700, close: 66000, volume: 120 });
    // Pullback but staying ABOVE 65600 trough (e.g. 65800)
    candles.push({ ts: baseTs + 23 * 60000, time: baseTs + 23 * 60000, open: 66000, high: 66050, low: 65750, close: 65800, volume: 100 });
    // Forming live bar
    candles.push({ ts: baseTs + 24 * 60000, time: baseTs + 24 * 60000, open: 65800, high: 65850, low: 65750, close: 65800, volume: 10 });
    return candles;
}

/**
 * Full 3-Step Short: breakout_failed + lower-high + closed-candle trough break (< 65600 -> 65500)
 */
function createShort3StepCandles(baseTs = 1788410000000) {
    const candles: any[] = [];
    for (let i = 0; i < 20; i++) {
        const c = 64500 + i * 50;
        candles.push({ ts: baseTs + i * 60000, time: baseTs + i * 60000, open: c - 20, high: c + 20, low: c - 20, close: c, volume: 100 });
    }
    // Peak piercing 66000
    candles.push({ ts: baseTs + 20 * 60000, time: baseTs + 20 * 60000, open: 65500, high: 66600, low: 65400, close: 66400, volume: 200 });
    // Drop to intermediate trough at 65600
    candles.push({ ts: baseTs + 21 * 60000, time: baseTs + 21 * 60000, open: 66400, high: 66450, low: 65600, close: 65700, volume: 150 });
    // Bounce to lower high at 66100
    candles.push({ ts: baseTs + 22 * 60000, time: baseTs + 22 * 60000, open: 65700, high: 66100, low: 65700, close: 66000, volume: 120 });
    // Pullback
    candles.push({ ts: baseTs + 23 * 60000, time: baseTs + 23 * 60000, open: 66000, high: 66050, low: 65750, close: 65800, volume: 100 });
    // Closed candle breaking below 65600 trough -> 65500
    candles.push({ ts: baseTs + 24 * 60000, time: baseTs + 24 * 60000, open: 65800, high: 65850, low: 65450, close: 65500, volume: 250 });
    // Forming live bar
    candles.push({ ts: baseTs + 25 * 60000, time: baseTs + 25 * 60000, open: 65500, high: 65550, low: 65450, close: 65500, volume: 10 });
    return candles;
}

/**
 * 1-Step Long: breakdown_failed only (pierced boxLow 60000 -> 59400, closed back above 60200, no higher low)
 */
function createLong1StepCandles(baseTs = 1788410000000) {
    const candles: any[] = [];
    for (let i = 0; i < 20; i++) {
        const c = 61500 - i * 50;
        candles.push({ ts: baseTs + i * 60000, time: baseTs + i * 60000, open: c + 20, high: c + 20, low: c - 20, close: c, volume: 100 });
    }
    // Breakdown pierce below 60000
    candles.push({ ts: baseTs + 20 * 60000, time: baseTs + 20 * 60000, open: 60500, high: 60600, low: 59400, close: 59600, volume: 200 });
    // Re-enter above 60000 (single bounce, no higher-low structure)
    candles.push({ ts: baseTs + 21 * 60000, time: baseTs + 21 * 60000, open: 59600, high: 60300, low: 59550, close: 60200, volume: 150 });
    // Forming live bar
    candles.push({ ts: baseTs + 22 * 60000, time: baseTs + 22 * 60000, open: 60200, high: 60250, low: 60150, close: 60200, volume: 10 });
    return candles;
}

/**
 * 2-Step Long: breakdown_failed + higher-low confirmed, but NO peak break
 * Trough: 59400 -> Peak: 60400 -> Higher Low: 59900 -> Close: 60200 (< 60400)
 */
function createLong2StepCandles(baseTs = 1788410000000) {
    const candles: any[] = [];
    for (let i = 0; i < 20; i++) {
        const c = 61500 - i * 50;
        candles.push({ ts: baseTs + i * 60000, time: baseTs + i * 60000, open: c + 20, high: c + 20, low: c - 20, close: c, volume: 100 });
    }
    // Trough piercing 60000
    candles.push({ ts: baseTs + 20 * 60000, time: baseTs + 20 * 60000, open: 60500, high: 60600, low: 59400, close: 59600, volume: 200 });
    // Bounce to intermediate peak at 60400
    candles.push({ ts: baseTs + 21 * 60000, time: baseTs + 21 * 60000, open: 59600, high: 60400, low: 59550, close: 60300, volume: 150 });
    // Pullback to higher low at 59900
    candles.push({ ts: baseTs + 22 * 60000, time: baseTs + 22 * 60000, open: 60300, high: 60350, low: 59900, close: 60000, volume: 120 });
    // Push up but staying BELOW 60400 peak (e.g. 60200)
    candles.push({ ts: baseTs + 23 * 60000, time: baseTs + 23 * 60000, open: 60000, high: 60250, low: 59950, close: 60200, volume: 100 });
    // Forming live bar
    candles.push({ ts: baseTs + 24 * 60000, time: baseTs + 24 * 60000, open: 60200, high: 60250, low: 60150, close: 60200, volume: 10 });
    return candles;
}

/**
 * Full 3-Step Long: breakdown_failed + higher-low + closed-candle peak break (> 60400 -> 60500)
 */
function createLong3StepCandles(baseTs = 1788410000000) {
    const candles: any[] = [];
    for (let i = 0; i < 20; i++) {
        const c = 61500 - i * 50;
        candles.push({ ts: baseTs + i * 60000, time: baseTs + i * 60000, open: c + 20, high: c + 20, low: c - 20, close: c, volume: 100 });
    }
    // Trough piercing 60000
    candles.push({ ts: baseTs + 20 * 60000, time: baseTs + 20 * 60000, open: 60500, high: 60600, low: 59400, close: 59600, volume: 200 });
    // Bounce to intermediate peak at 60400
    candles.push({ ts: baseTs + 21 * 60000, time: baseTs + 21 * 60000, open: 59600, high: 60400, low: 59550, close: 60300, volume: 150 });
    // Pullback to higher low at 59900
    candles.push({ ts: baseTs + 22 * 60000, time: baseTs + 22 * 60000, open: 60300, high: 60350, low: 59900, close: 60000, volume: 120 });
    // Push up
    candles.push({ ts: baseTs + 23 * 60000, time: baseTs + 23 * 60000, open: 60000, high: 60250, low: 59950, close: 60200, volume: 100 });
    // Closed candle breaking above 60400 peak -> 60500
    candles.push({ ts: baseTs + 24 * 60000, time: baseTs + 24 * 60000, open: 60200, high: 60550, low: 60150, close: 60500, volume: 250 });
    // Forming live bar
    candles.push({ ts: baseTs + 25 * 60000, time: baseTs + 25 * 60000, open: 60500, high: 60550, low: 60450, close: 60500, volume: 10 });
    return candles;
}

let testCycleCounter = 1;
function getNextCycleId() {
    return `test-probe-bridge-cycle-${Date.now()}-${testCycleCounter++}`;
}

function createTestEngineInput(overrides: Record<string, any> = {}): EngineV2Input {
    const defaultCloses = Array.from({ length: 60 }, (_, i) => 63000 + (i % 5) * 50);
    const defaultCandles = createCandles(defaultCloses);
    const htfPack = {
        "5m": defaultCandles,
        "15m": createHtfCandles(30, 63000, 100),
        "1h": createHtfCandles(30, 62000, 150),
        "4h": createHtfCandles(30, 61000, 200),
        "1d": createHtfCandles(30, 60000, 300)
    };

    return {
        symbol: "BTCUSDT",
        run_cycle_id: overrides.run_cycle_id ?? getNextCycleId(),
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            maxSymbolNotionalUsd: 5000,
            maxAccountNotionalUsd: 20000,
            okxLiveEnabled: true,
            okxAuthMode: "live",
            okxExchangeAuthOptIn: true,
            okxLiveMaxOrderNotionalUsdt: 200,
            serverTradeEnabled: true
        } as any,
        evaluationMode: "authoritative",
        ...overrides,
        snapshot: {
            symbol: "BTCUSDT",
            lastPrice: 65500,
            latestCandleClose: 65500,
            qualityScore: 85,
            boxPos: 0.85,
            boxLow: 60000,
            boxHigh: 66000,
            atr: 300,
            rangeConfidence: 0.85,
            boxCohesion01: 0.95,
            trendWeaknessScore: 0.25,
            candles: defaultCandles,
            htf_candles: htfPack,
            tickSz: 0.1,
            lotSz: 0.01,
            canonicalRegime: "RANGE",
            signal: "paper_short_candidate",
            entryCandidate: true,
            reversalConfirmed: true,
            ...(overrides.snapshot ?? {})
        } as any,
        state: {
            currentPositions: [],
            directionalShockState: "NONE",
            rawDirectionalShockState: "NONE",
            longAllow: false, // risk disallows long
            shortAllow: false, // risk disallows short
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            paperExecutionReady: true,
            signedExecutionReady: true,
            accountEquityKrw: 14_000_000,
            accountEquityUsdt: 10_000,
            availableBalanceUsdt: 10_000,
            liveBalanceReady: true,
            okxActualPositionsReady: true,
            actualAccountNotionalUsdtReady: true,
            exposureNotionalCapKrw: 100_000_000,
            symbolExposureNotionalCapKrw: 50_000_000,
            ledgerExposureNotionalKrw: 0,
            symbolLedgerExposureNotionalKrw: 0,
            okxActualPositions: [],
            okxPendingOrdersReady: true,
            okxPendingOrdersNotionalUsdt: 0,
            dailyLossGuardTriggered: false,
            lossStreaks: {},
            globalRiskScore: 0,
            executionReadiness: true,
            ...(overrides.state ?? {})
        } as any
    } as any;
}

test("HTF PROBE_ONLY Comprehensive Authoritative Bridge Test Suite", async (t) => {
    // ── SHORT 측 다단계 structural authority 감사 검증 ─────────────────────────────

    await t.test("1. breakout_failed=true만 있고 lower-high/trough-break 없음 (1-step) → SHORT bridge BLOCK", () => {
        const candles = createShort1StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 65800,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 85
            },
            state: {
                shortAllow: false,
                longAllow: false,
                directionalShockState: "NONE"
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER", "1-step breakout_failed alone MUST NOT trigger ENTER");
        const execMeta = ((result.internal as any)?.execution?.metadata ?? {}) as Record<string, unknown>;
        assert.strictEqual(execMeta.probe_only_bridge_activated ?? false, false);
    });

    await t.test("2. breakout_failed + lower-high만 있고 trough break 없음 (2-step) → SHORT bridge BLOCK", () => {
        const candles = createShort2StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 65800,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 85
            },
            state: {
                shortAllow: false,
                longAllow: false,
                directionalShockState: "NONE"
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER", "2-step without trough break MUST NOT trigger ENTER");
        const execMeta = ((result.internal as any)?.execution?.metadata ?? {}) as Record<string, unknown>;
        assert.strictEqual(execMeta.probe_only_bridge_activated ?? false, false);
    });

    await t.test("3. full 3-step closed-candle short reversal → PROBE_ONLY bridge ALLOW (size <= 0.5x)", () => {
        const candles = createShort3StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 65500,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 85
            },
            state: {
                shortAllow: false,
                longAllow: false,
                directionalShockState: "NONE"
            }
        });

        const result = runEngineV2(input);
        const decision = result.decision;
        const execMeta = ((result.internal as any)?.execution?.metadata ?? {}) as Record<string, unknown>;

        assert.notStrictEqual(decision.explanation?.reason, "SHORT_NOT_ALLOWED");
        assert.strictEqual(decision.decision, "ENTER");
        assert.strictEqual(decision.side, "short");
        assert.strictEqual(execMeta.probe_only_bridge_activated, true);
        assert.strictEqual(execMeta.isCountertrendProbe, true);
        assert.ok(Number(execMeta.htf_size_multiplier ?? 1) <= 0.5);
    });

    await t.test("4. box_upper_breakout_hold === false 단독 flag → SHORT bridge BLOCK", () => {
        const candles = createShort1StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 65800,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                box_upper_breakout_hold: false, // 단독 flag
                qualityScore: 85
            },
            state: {
                shortAllow: false,
                longAllow: false,
                directionalShockState: "NONE"
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER", "box_upper_breakout_hold === false alone MUST NOT trigger ENTER");
    });

    // ── LONG 측 완전 대칭 structural authority 감사 검증 ─────────────────────────

    await t.test("5. breakdown_failed=true만 있고 higher-low/peak-break 없음 (1-step) → LONG bridge BLOCK", () => {
        const candles = createLong1StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 60200,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 85
            },
            state: {
                shortAllow: false,
                longAllow: false,
                directionalShockState: "NONE"
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER", "1-step breakdown_failed alone MUST NOT trigger ENTER");
        const execMeta = ((result.internal as any)?.execution?.metadata ?? {}) as Record<string, unknown>;
        assert.strictEqual(execMeta.probe_only_bridge_activated ?? false, false);
    });

    await t.test("6. breakdown_failed + higher-low만 있고 peak break 없음 (2-step) → LONG bridge BLOCK", () => {
        const candles = createLong2StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 60200,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 85
            },
            state: {
                shortAllow: false,
                longAllow: false,
                directionalShockState: "NONE"
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER", "2-step without peak break MUST NOT trigger ENTER");
        const execMeta = ((result.internal as any)?.execution?.metadata ?? {}) as Record<string, unknown>;
        assert.strictEqual(execMeta.probe_only_bridge_activated ?? false, false);
    });

    await t.test("7. full 3-step closed-candle long reversal → PROBE_ONLY bridge ALLOW (size <= 0.5x)", () => {
        const candles = createLong3StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 60500,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 85
            },
            state: {
                shortAllow: false,
                longAllow: false,
                directionalShockState: "NONE"
            }
        });

        const result = runEngineV2(input);
        const decision = result.decision;
        const execMeta = ((result.internal as any)?.execution?.metadata ?? {}) as Record<string, unknown>;

        assert.notStrictEqual(decision.explanation?.reason, "LONG_NOT_ALLOWED");
        assert.strictEqual(decision.decision, "ENTER");
        assert.strictEqual(decision.side, "long");
        assert.strictEqual(execMeta.probe_only_bridge_activated, true);
        assert.strictEqual(execMeta.isCountertrendProbe, true);
        assert.ok(Number(execMeta.htf_size_multiplier ?? 1) <= 0.5);
    });

    await t.test("8. box_lower_breakdown_hold === false 단독 flag → LONG bridge BLOCK", () => {
        const candles = createLong1StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 60200,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                box_lower_breakdown_hold: false, // 단독 flag
                qualityScore: 85
            },
            state: {
                shortAllow: false,
                longAllow: false,
                directionalShockState: "NONE"
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER", "box_lower_breakdown_hold === false alone MUST NOT trigger ENTER");
    });

    // ── Forming Candle vs Closed Candle Confirmation 검증 ────────────────────────

    await t.test("9. forming candle만 final structure break (closed candle 미확정) → BLOCK", () => {
        // 2-step candles where the last candle is still closed above trough
        const closedCandles = createShort2StepCandles();
        // The last closed candle has close 65800 (> 65600 trough)
        // Even if lastPrice is 65500 (forming tick/candle), closed candles do not confirm
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 65500, // forming price
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles: closedCandles,
                qualityScore: 85
            },
            state: {
                shortAllow: false,
                longAllow: false,
                directionalShockState: "NONE"
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER", "Forming candle only MUST NOT trigger ENTER");
    });

    await t.test("10. close 확정 후 full structure → ALLOW", () => {
        const closedCandles = createShort3StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 65500,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles: closedCandles,
                qualityScore: 85
            },
            state: {
                shortAllow: false,
                longAllow: false,
                directionalShockState: "NONE"
            }
        });

        const result = runEngineV2(input);
        const decision = result.decision;
        assert.strictEqual(decision.decision, "ENTER");
        assert.strictEqual(decision.side, "short");
    });

    // ── Safety & Hard Guard 회귀 검증 ─────────────────────────────────────────────

    await t.test("11. qualityScore < 60 → BLOCK", () => {
        const candles = createShort3StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 65500,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 50 // quality 미달
            },
            state: {
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("12. lower-zone short chase → BLOCK", () => {
        const candles = createShort3StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15, // lower zone -> chase!
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 60800,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 85
            },
            state: {
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("13. upper-zone long chase → BLOCK", () => {
        const candles = createLong3StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85, // upper zone -> chase!
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 65200,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 85
            },
            state: {
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("14. killSwitch=true → BLOCK", () => {
        const candles = createShort3StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 65500,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 85
            },
            state: {
                killSwitch: true,
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("15. closeOnlyMode=true → BLOCK", () => {
        const candles = createShort3StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 65500,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 85
            },
            state: {
                closeOnlyMode: true,
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("16. dailyLossGuardTriggered=true → BLOCK", () => {
        const candles = createShort3StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 65500,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 85
            },
            state: {
                dailyLossGuardTriggered: true,
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("17. exposure cap 초과 → BLOCK", () => {
        const candles = createShort3StepCandles();
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                boxHigh: 66000,
                boxLow: 60000,
                lastPrice: 65500,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                canonicalRegime: "RANGE",
                candles,
                qualityScore: 85
            },
            state: {
                exposureNotionalCapKrw: 10_000_000,
                ledgerExposureNotionalKrw: 10_000_000,
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    // ── V2_PROBE_ONLY_AUTHORITY_BRIDGE_PROOF structural_confirmation 검증 ─────────

    await t.test("18. V2_PROBE_ONLY_AUTHORITY_BRIDGE_PROOF.structural_confirmation이 단순 failure flag가 아닌 full structure 결과임을 증명", () => {
        const originalLog = console.info;
        const capturedLogs: any[] = [];
        console.info = (msg: string) => {
            try {
                const parsed = JSON.parse(msg);
                if (parsed.event === "V2_PROBE_ONLY_AUTHORITY_BRIDGE_PROOF") {
                    capturedLogs.push(parsed);
                }
            } catch {}
            originalLog(msg);
        };

        try {
            // Case A: 1-step (breakout_failed only) -> structural_confirmation MUST be false
            capturedLogs.length = 0;
            const input1Step = createTestEngineInput({
                run_cycle_id: getNextCycleId(),
                snapshot: {
                    boxPos: 0.85,
                    boxHigh: 66000,
                    boxLow: 60000,
                    lastPrice: 65800,
                    signal: "paper_short_candidate",
                    htf_entry_policy: "PROBE_ONLY",
                    canonicalRegime: "RANGE",
                    candles: createShort1StepCandles(),
                    qualityScore: 85
                },
                state: {
                    shortAllow: false,
                    longAllow: false,
                    directionalShockState: "NONE"
                }
            });
            runEngineV2(input1Step);
            assert.ok(capturedLogs.length > 0, "Proof log must be emitted for 1-step");
            assert.strictEqual(capturedLogs[capturedLogs.length - 1].structural_confirmation, false, "1-step must have structural_confirmation=false");
            assert.strictEqual(capturedLogs[capturedLogs.length - 1].probeOnlyShortExceptionAllowed, false);

            // Case B: Full 3-step -> structural_confirmation MUST be true
            capturedLogs.length = 0;
            const input3Step = createTestEngineInput({
                run_cycle_id: getNextCycleId(),
                snapshot: {
                    boxPos: 0.85,
                    boxHigh: 66000,
                    boxLow: 60000,
                    lastPrice: 65500,
                    signal: "paper_short_candidate",
                    htf_entry_policy: "PROBE_ONLY",
                    canonicalRegime: "RANGE",
                    candles: createShort3StepCandles(),
                    qualityScore: 85
                },
                state: {
                    shortAllow: false,
                    longAllow: false,
                    directionalShockState: "NONE"
                }
            });
            runEngineV2(input3Step);
            assert.ok(capturedLogs.length > 0, "Proof log must be emitted for 3-step");
            assert.strictEqual(capturedLogs[capturedLogs.length - 1].structural_confirmation, true, "3-step must have structural_confirmation=true");
            assert.strictEqual(capturedLogs[capturedLogs.length - 1].probeOnlyShortExceptionAllowed, true);
        } finally {
            console.info = originalLog;
        }
    });
});
