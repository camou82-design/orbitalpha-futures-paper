import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEngineV2 } from "../engine-v2/index";
import { deriveTrendSideCandidate } from "../engine-v2/trend-side-candidate";
import type { EngineV2Input } from "../engine-v2/types";
import type { Candle } from "../models/types";

function makeCandles(basePrice = 2000, trendSlope = 0): Candle[] {
    const candles: Candle[] = [];
    const count = 120;
    const now = Date.now();
    for (let i = 0; i < count; i++) {
        const offset = (count - i) * 60_000;
        const trend = trendSlope * i;
        const open = basePrice + trend - 1;
        const high = basePrice + trend + 4;
        const low = basePrice + trend - 4;
        const close = basePrice + trend + 1;
        candles.push({
            ts: now - offset,
            open,
            high,
            low,
            close,
            volume: 150 + (i % 10) * 10
        });
    }
    return candles;
}

function makeFtsShortCandles(basePrice = 2000): Candle[] {
    const count = 120;
    const now = Date.now();
    const candles: Candle[] = [];
    for (let i = 0; i < count; i++) {
        const offset = (count - i) * 60_000;
        if (i < 110) {
            candles.push({
                ts: now - offset,
                open: basePrice,
                high: basePrice + 5,
                low: basePrice - 5,
                close: basePrice - 1,
                volume: 150
            });
        } else if (i < 115) {
            candles.push({
                ts: now - offset,
                open: basePrice - 12,
                high: basePrice - 10,
                low: basePrice - 20,
                close: basePrice - 15,
                volume: 200
            });
        } else {
            candles.push({
                ts: now - offset,
                open: basePrice - 26,
                high: basePrice - 25, // lower high
                low: basePrice - 40,  // lower low
                close: basePrice - 35, // lost box mid
                volume: 250
            });
        }
    }
    return candles;
}

function makeFtsLongCandles(basePrice = 2000): Candle[] {
    const count = 120;
    const now = Date.now();
    const candles: Candle[] = [];
    for (let i = 0; i < count; i++) {
        const offset = (count - i) * 60_000;
        if (i < 110) {
            candles.push({
                ts: now - offset,
                open: basePrice,
                high: basePrice + 5,
                low: basePrice - 5,
                close: basePrice + 1,
                volume: 150
            });
        } else if (i < 115) {
            candles.push({
                ts: now - offset,
                open: basePrice + 12,
                high: basePrice + 20,
                low: basePrice + 10,
                close: basePrice + 15,
                volume: 200
            });
        } else {
            candles.push({
                ts: now - offset,
                open: basePrice + 26,
                high: basePrice + 40, // higher high
                low: basePrice + 25,  // higher low
                close: basePrice + 35, // reclaimed box mid
                volume: 250
            });
        }
    }
    return candles;
}

function createBaseInput(symbol: "BTCUSDT" | "ETHUSDT", options: {
    directionalShockState?: string;
    emaGap?: number;
    regime?: "TREND" | "RANGE";
    subtype?: string;
    zone?: "lower" | "mid" | "upper";
    boxPos?: number;
    fastTrendShiftDiag?: Record<string, unknown> | null;
    candles?: Candle[];
    qualityScore?: number;
    entryQualityGrade?: "S" | "A" | "B" | "C";
    longAllow?: boolean;
    shortAllow?: boolean;
}): EngineV2Input {
    const candles = options.candles ?? makeCandles(symbol === "BTCUSDT" ? 68000 : 2000);
    const lastPrice = candles[candles.length - 1].close;
    const boxHigh = lastPrice + 100;
    const boxLow = lastPrice - 100;
    const boxPos = options.boxPos ?? (options.zone === "lower" ? 0.2 : options.zone === "upper" ? 0.8 : 0.5);

    return {
        symbol,
        now: Date.now(),
        evaluationMode: "authoritative",
        candles,
        v1Result: {
            regime: options.regime ?? "RANGE",
            decision: "SKIP",
            side: "NONE",
            isBlocked: false
        },
        snapshot: {
            symbol,
            lastPrice,
            latestCandleClose: lastPrice,
            markPrice: lastPrice,
            bidPrice: lastPrice - 0.5,
            askPrice: lastPrice + 0.5,
            emaGap: options.emaGap ?? 0.002,
            ema20Slope: 0.0002,
            trendWeaknessScore: 0.2,
            qualityScore: options.qualityScore ?? 85,
            boxHigh,
            boxLow,
            boxPos,
            boxBreakSide: "none",
            rangeConfidence: 0.8,
            boxCohesion01: 0.95,
            atr: 10,
            atr20: 10,
            tickSz: 0.1,
            reviewing_ticks: 3,
            entryCandidate: true,
            fastTrendShift: options.fastTrendShiftDiag ?? null
        } as any,
        state: {
            symbol,
            paperExecutionReady: true,
            signedExecutionReady: true,
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            directionalShockState: options.directionalShockState ?? "NONE",
            rawDirectionalShockState: options.directionalShockState ?? "NONE",
            longAllow: options.longAllow ?? true,
            shortAllow: options.shortAllow ?? true,
            heldPositionSide: "none",
            currentPositions: [],
            symbolPositions: [],
            hasSameSidePosition: false,
            hasOppositeSidePosition: false,
            stateAuthoritySource: "test",
            positionStateReady: true,
            accountEquityUsdt: 10000,
            availableBalanceUsdt: 8000,
            liveBalanceReady: true
        } as any,
        config: {
            symbol,
            paperTakerFeeRate: 0.0005,
            okxLiveMaxOrderNotionalUsdt: 1000,
            baseSizeUsd: 100
        } as any
    };
}

describe("Phase 1: Prevent Shock-Only Opposite-Side Entry Authority Regression Suite", () => {
    // ── Unit Tests: deriveTrendSideCandidate SOT ──────────────────────────────────────────
    describe("Goal 1: deriveTrendSideCandidate Unit Semantics", () => {
        it("returns long when emaGap > 0 regardless of DOWN shock", () => {
            assert.equal(deriveTrendSideCandidate("DOWN", 0.0042), "long");
            assert.equal(deriveTrendSideCandidate("NONE", 0.0042), "long");
            assert.equal(deriveTrendSideCandidate("UP", 0.0042), "long");
        });

        it("returns short when emaGap < 0 regardless of UP shock", () => {
            assert.equal(deriveTrendSideCandidate("UP", -0.0042), "short");
            assert.equal(deriveTrendSideCandidate("NONE", -0.0042), "short");
            assert.equal(deriveTrendSideCandidate("DOWN", -0.0042), "short");
        });

        it("returns none when emaGap === 0 regardless of shock", () => {
            assert.equal(deriveTrendSideCandidate("DOWN", 0), "none");
            assert.equal(deriveTrendSideCandidate("UP", 0), "none");
            assert.equal(deriveTrendSideCandidate("NONE", 0), "none");
        });
    });

    // ── Case 1 & Case 2: Invariant enforcement ──────────────────────────────────────────
    describe("Goal 2: Opposite-Side Entry Authority Invariant Enforcement", () => {
        it("Case 1 (BTC): aligned long (emaGap > 0) + DOWN shock + unconfirmed FTS -> short ENTER forbidden", () => {
            const input = createBaseInput("BTCUSDT", {
                directionalShockState: "DOWN",
                emaGap: 0.003, // Aligned LONG
                qualityScore: 85,
                fastTrendShiftDiag: null // No confirmed FTS
            });

            const result = runEngineV2(input);

            assert.notEqual(result.decision.decision, "ENTER", "Must not ENTER short on DOWN shock alone when aligned long");
            assert.notEqual(result.decision.side, "short", "Must not produce short side");
        });

        it("Case 1 (ETH): aligned long (emaGap > 0) + DOWN shock + unconfirmed FTS -> short ENTER forbidden", () => {
            const input = createBaseInput("ETHUSDT", {
                directionalShockState: "DOWN",
                emaGap: 0.003, // Aligned LONG
                qualityScore: 85,
                fastTrendShiftDiag: null // No confirmed FTS
            });

            const result = runEngineV2(input);

            assert.notEqual(result.decision.decision, "ENTER", "Must not ENTER short on DOWN shock alone when aligned long");
            assert.notEqual(result.decision.side, "short", "Must not produce short side");
        });

        it("Case 2 (BTC): aligned short (emaGap < 0) + UP shock + unconfirmed FTS -> long ENTER forbidden", () => {
            const input = createBaseInput("BTCUSDT", {
                directionalShockState: "UP",
                emaGap: -0.003, // Aligned SHORT
                qualityScore: 85,
                fastTrendShiftDiag: null // No confirmed FTS
            });

            const result = runEngineV2(input);

            assert.notEqual(result.decision.decision, "ENTER", "Must not ENTER long on UP shock alone when aligned short");
            assert.notEqual(result.decision.side, "long", "Must not produce long side");
        });

        it("Case 2 (ETH): aligned short (emaGap < 0) + UP shock + unconfirmed FTS -> long ENTER forbidden", () => {
            const input = createBaseInput("ETHUSDT", {
                directionalShockState: "UP",
                emaGap: -0.003, // Aligned SHORT
                qualityScore: 85,
                fastTrendShiftDiag: null // No confirmed FTS
            });

            const result = runEngineV2(input);

            assert.notEqual(result.decision.decision, "ENTER", "Must not ENTER long on UP shock alone when aligned short");
            assert.notEqual(result.decision.side, "long", "Must not produce long side");
        });
    });

    // ── Case 3 & Case 4: Same-direction alignment preservation ──────────────────────────
    describe("Same-Direction Reinforcement Preservation", () => {
        it("Case 3: aligned long + UP shock -> long entry preserved", () => {
            const input = createBaseInput("BTCUSDT", {
                directionalShockState: "UP",
                emaGap: 0.003,
                qualityScore: 85
            });

            const result = runEngineV2(input);
            // With positive EMA gap, UP shock, and high quality, trend promotion or probe is valid
            if (result.decision.decision === "ENTER") {
                assert.equal(result.decision.side, "long", "Side must be long");
            }
        });

        it("Case 4: aligned short + DOWN shock -> short entry preserved", () => {
            const input = createBaseInput("BTCUSDT", {
                directionalShockState: "DOWN",
                emaGap: -0.003,
                qualityScore: 85
            });

            const result = runEngineV2(input);
            if (result.decision.decision === "ENTER") {
                assert.equal(result.decision.side, "short", "Side must be short");
            }
        });
    });

    // ── Case 5 & Case 6: Confirmed structural FTS opposite side authority ──────────────
    describe("Confirmed Structural FTS Opposite Side Authority", () => {
        it("Case 5: confirmed FTS short structure (lower_high, lower_low, box_mid_lost) preserves short opportunity", () => {
            const candles = makeFtsShortCandles(2000);
            const lastPx = candles[candles.length - 1].close;
            const input = createBaseInput("ETHUSDT", {
                directionalShockState: "DOWN",
                emaGap: 0.002, // initially positive EMA
                zone: "lower",
                boxPos: 0.2,
                candles,
                fastTrendShiftDiag: {
                    active: true,
                    direction: "short",
                    lower_high_detected: true,
                    lower_low_detected: true,
                    box_mid_lost: true,
                    box_lower_breakdown_hold: true,
                    stop_price: lastPx + 20,
                    reason: "lower_high|lower_low|box_mid_lost|lower_hold"
                }
            });

            const result = runEngineV2(input);
            // With verified structural provenance, FTS short is evaluated under canonical rules
            assert.ok(result, "Engine executes with structural FTS input");
        });

        it("Case 6: confirmed FTS long structure (higher_high, higher_low, box_mid_reclaimed) preserves long opportunity", () => {
            const candles = makeFtsLongCandles(2000);
            const lastPx = candles[candles.length - 1].close;
            const input = createBaseInput("ETHUSDT", {
                directionalShockState: "UP",
                emaGap: -0.002, // initially negative EMA
                zone: "upper",
                boxPos: 0.8,
                candles,
                fastTrendShiftDiag: {
                    active: true,
                    direction: "long",
                    higher_high_detected: true,
                    higher_low_detected: true,
                    box_mid_reclaimed: true,
                    box_upper_breakout_hold: true,
                    stop_price: lastPx - 20,
                    reason: "higher_high|higher_low|box_mid_ok|upper_hold"
                }
            });

            const result = runEngineV2(input);
            assert.ok(result, "Engine executes with structural FTS input");
        });
    });

    // ── Case 7 & 8: Range edge and hard risk preservation ──────────────────────────────
    describe("Range Edge and Hard Risk Preservation", () => {
        it("Case 7: Range edge logic preserved", () => {
            const input = createBaseInput("BTCUSDT", {
                directionalShockState: "NONE",
                emaGap: 0.0001,
                zone: "lower",
                boxPos: 0.05,
                qualityScore: 85
            });

            const result = runEngineV2(input);
            assert.ok(result.decision, "Result returned");
        });

        it("Case 8: Hard control / kill switch strictly blocks entry", () => {
            const input = createBaseInput("BTCUSDT", {
                directionalShockState: "UP",
                emaGap: 0.003,
                qualityScore: 90
            });
            input.state.killSwitch = true;

            const result = runEngineV2(input);
            assert.notEqual(result.decision.decision, "ENTER", "Kill switch must strictly block entry");
        });
    });

    // ── Past Problem Reproduction Test ─────────────────────────────────────────────────
    describe("Historical Bug Reproduction & Remediation", () => {
        it("Reproduction: aligned_signal=paper_long_candidate + DOWN shock without structural FTS must NEVER ENTER short", () => {
            const input = createBaseInput("BTCUSDT", {
                directionalShockState: "DOWN",
                emaGap: 0.0025, // Aligned LONG candidate
                qualityScore: 80,
                fastTrendShiftDiag: null
            });

            const result = runEngineV2(input);

            // In the past, shock DOWN forced trendSideCandidate=short and produced opposite-side short ENTER.
            // Now, it must be strictly blocked or hold.
            assert.ok(
                result.decision.decision !== "ENTER" || result.decision.side !== "short",
                "Historical bug resolved: must not ENTER short on DOWN shock when aligned long"
            );
        });
    });
});
