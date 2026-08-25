/**
 * WHIPSAW detector semantics — continuation vs whipsaw, structural invalidation strictness,
 * micro evidence freshness, and HARD re-arm behavior.
 *
 * Separate from aged hard→soft liveness (whipsaw-aged-soft-downgrade.ts).
 */

import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import {
    clearWhipsawObservationState,
    updateWhipsawObservation,
    whipsawObservationAuthority
} from "../engine-v2/market-judgment/whipsaw-observer";
import { adaptV2Input } from "../engine-v2/index";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";
import type { EngineV2Input } from "../engine-v2/types";
import type { SymbolSnapshotLike } from "./paper-symbol-decision";

function run(label: string, passed: boolean, detail: string): boolean {
    const tag = passed ? "PASS" : "FAIL";
    console.log(`[WHIPSAW-SEMANTICS][${label}] ${tag} — ${detail}`);
    if (!passed) {
        throw new Error(`[WHIPSAW-SEMANTICS][${label}] FAILED: ${detail}`);
    }
    return passed;
}

const mockBearishCandles: Candle[] = Array.from({ length: 120 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: 5000 - i * 10,
    high: 5005 - i * 10,
    low: 4995 - i * 10,
    close: 4998 - i * 10,
    volume: 100
}));

const mockBullishCandles: Candle[] = Array.from({ length: 120 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: 3000 + i * 10,
    high: 3005 + i * 10,
    low: 2995 + i * 10,
    close: 3002 + i * 10,
    volume: 100
}));

function makeMicroDownReboundCandles(basePrice = 69000): Candle[] {
    const flat: Candle[] = Array.from({ length: 112 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60000,
        open: basePrice,
        high: basePrice + 50,
        low: basePrice - 50,
        close: basePrice,
        volume: 100
    }));
    const tail: Array<{ o: number; h: number; l: number; c: number }> = [
        { o: basePrice, h: basePrice + 100, l: basePrice - 100, c: basePrice - 50 },
        { o: basePrice - 50, h: basePrice, l: basePrice - 800, c: basePrice - 750 },
        { o: basePrice - 750, h: basePrice - 600, l: basePrice - 760, c: basePrice - 650 },
        { o: basePrice - 650, h: basePrice - 500, l: basePrice - 660, c: basePrice - 550 },
        { o: basePrice - 550, h: basePrice - 400, l: basePrice - 560, c: basePrice - 450 },
        { o: basePrice - 450, h: basePrice - 300, l: basePrice - 460, c: basePrice - 350 },
        { o: basePrice - 350, h: basePrice - 200, l: basePrice - 360, c: basePrice - 250 },
        { o: basePrice - 250, h: basePrice + 100, l: basePrice - 260, c: basePrice - 80 }
    ];
    return [
        ...flat,
        ...tail.map((b, i) => ({
            ts: Date.now() - (8 - i) * 60000,
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            volume: 120
        }))
    ];
}

function makeMicroUpThenDropCandles(basePrice = 69000): Candle[] {
    const flat: Candle[] = Array.from({ length: 112 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60000,
        open: basePrice,
        high: basePrice + 50,
        low: basePrice - 50,
        close: basePrice,
        volume: 100
    }));
    const tail: Array<{ o: number; h: number; l: number; c: number }> = [
        { o: basePrice, h: basePrice + 100, l: basePrice - 100, c: basePrice + 50 },
        { o: basePrice + 50, h: basePrice + 800, l: basePrice, c: basePrice + 750 },
        { o: basePrice + 750, h: basePrice + 760, l: basePrice + 600, c: basePrice + 650 },
        { o: basePrice + 650, h: basePrice + 660, l: basePrice + 500, c: basePrice + 550 },
        { o: basePrice + 550, h: basePrice + 560, l: basePrice + 400, c: basePrice + 450 },
        { o: basePrice + 450, h: basePrice + 460, l: basePrice + 300, c: basePrice + 350 },
        { o: basePrice + 350, h: basePrice + 360, l: basePrice + 200, c: basePrice + 250 },
        { o: basePrice + 250, h: basePrice + 260, l: basePrice - 100, c: basePrice + 80 }
    ];
    return [
        ...flat,
        ...tail.map((b, i) => ({
            ts: Date.now() - (8 - i) * 60000,
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            volume: 120
        }))
    ];
}

function makeBaseInput(
    symbol: "BTCUSDT" | "ETHUSDT",
    overrides: Partial<SymbolSnapshotLike> = {},
    stateOverrides: Record<string, unknown> = {},
    htfType: "BULLISH" | "BEARISH" = "BULLISH"
): EngineV2Input {
    const candles = htfType === "BULLISH" ? mockBullishCandles : mockBearishCandles;
    const snap: SymbolSnapshotLike = {
        symbol,
        lastPrice: symbol === "BTCUSDT" ? 69000 : 2600,
        latestCandleClose: symbol === "BTCUSDT" ? 69000 : 2600,
        signal: "paper_long_candidate",
        qualityScore: 80,
        candidateStrength: "strong",
        ema20: symbol === "BTCUSDT" ? 68900 : 2595,
        ema60: symbol === "BTCUSDT" ? 68800 : 2590,
        emaGap: 0.002,
        volumeRatioProxy: 1.2,
        boxHigh: symbol === "BTCUSDT" ? 70000 : 2700,
        boxLow: symbol === "BTCUSDT" ? 68000 : 2500,
        boxPos: 0.6,
        boxRel: 0.02,
        gateExpectedMove: null,
        gateRequiredMove: null,
        atr: symbol === "BTCUSDT" ? 250 : 12,
        atr20: symbol === "BTCUSDT" ? 250 : 12,
        closedClose: symbol === "BTCUSDT" ? 68990 : 2598,
        rangeConfidence: 0.2,
        trendWeaknessScore: 0.1,
        boxCohesion01: 0.7,
        breakoutFailureRate: 0.1,
        rangeOscillationScore: 0.2,
        candles,
        htf_candles: {
            "5m": candles,
            "15m": candles,
            "1h": candles,
            "4h": candles
        },
        canonicalRegime: "TREND",
        canonicalRegimeSource: "strategy_market_regime_detector",
        canonicalTrendScore: 0.85,
        ...overrides
    };

    const bridge = buildV2SnapshotBridge(snap) as unknown as Record<string, unknown>;
    if (snap.boxBreakSide != null) {
        bridge.boxBreakSide = snap.boxBreakSide;
    }
    return adaptV2Input(
        symbol,
        Date.now(),
        bridge as any,
        { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
        {
            directionalShockState: "NONE",
            longAllow: true,
            shortAllow: true,
            currentPositions: [],
            ...stateOverrides
        } as any,
        { decision: { final_decision: "ENTER" } } as any,
        candles,
        "authoritative",
        `cycle_${symbol}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    );
}

// =========================================================================
// A — DOWN + short + negative EMA + up-then-drop + no reclaim => NOT HARD WHIPSAW
// =========================================================================
{
    clearWhipsawObservationState("BTCUSDT");

    const microCandles = makeMicroUpThenDropCandles(69000);
    const input = makeBaseInput(
        "BTCUSDT",
        {
            signal: "paper_short_candidate",
            emaGap: -0.0045,
            volumeExpansion: 2.5,
            boxBreakSide: "none",
            breakoutFailureRate: 0.1,
            candles: microCandles,
            htf_candles: {
                "5m": microCandles,
                "15m": microCandles,
                "1h": microCandles,
                "4h": microCandles
            }
        },
        { directionalShockState: "DOWN" },
        "BEARISH"
    );

    const judgment = detectMarketRegime(input);
    const freshStructural = judgment.diagnostics?.fresh_structural_hits ?? [];

    run(
        "A_DOWN_SHORT_CONTINUATION_UP_THEN_DROP_NOT_HARD",
        judgment.subtype !== "WHIPSAW_SHOCK_RECHECK" &&
            !freshStructural.includes("volume_expansion_ge_2"),
        `subtype=${judgment.subtype}, freshStructural=${freshStructural.join("|")}`
    );
}

// =========================================================================
// B — UP + long + positive EMA + down-then-rebound + no reclaim => NOT HARD WHIPSAW
// =========================================================================
{
    clearWhipsawObservationState("BTCUSDT");

    const microCandles = makeMicroDownReboundCandles(69000);
    const input = makeBaseInput(
        "BTCUSDT",
        {
            signal: "paper_long_candidate",
            emaGap: 0.0045,
            volumeExpansion: 2.5,
            boxBreakSide: "none",
            breakoutFailureRate: 0.1,
            candles: microCandles,
            htf_candles: {
                "5m": microCandles,
                "15m": microCandles,
                "1h": microCandles,
                "4h": microCandles
            }
        },
        { directionalShockState: "UP" },
        "BULLISH"
    );

    const judgment = detectMarketRegime(input);

    run(
        "B_UP_LONG_CONTINUATION_DOWN_REBOUND_NOT_HARD",
        judgment.subtype !== "WHIPSAW_SHOCK_RECHECK",
        `subtype=${judgment.subtype}, hits=${(judgment.diagnostics?.structural_hits ?? []).join("|")}`
    );
}

// =========================================================================
// C — Failed breakdown + reclaim + opposite displacement => HARD WHIPSAW
// =========================================================================
{
    clearWhipsawObservationState("BTCUSDT");

    const microCandles = makeMicroDownReboundCandles(69000);
    const input = makeBaseInput(
        "BTCUSDT",
        {
            signal: "paper_short_candidate",
            emaGap: -0.0045,
            boxBreakSide: "lower",
            reviewing_ticks: 2,
            breakoutFailureRate: 0.45,
            volumeExpansion: 1.2,
            candles: microCandles,
            htf_candles: {
                "5m": microCandles,
                "15m": microCandles,
                "1h": microCandles,
                "4h": microCandles
            }
        },
        { directionalShockState: "DOWN", crashState: "ALERT" },
        "BEARISH"
    );

    const judgment = detectMarketRegime(input);
    const freshStructural = judgment.diagnostics?.fresh_structural_hits ?? [];
    const ep = whipsawObservationAuthority.getEpisode("BTCUSDT");

    run(
        "C_FAILED_BREAKDOWN_RECLAIM_OPPOSITE_HARD",
        judgment.subtype === "WHIPSAW_SHOCK_RECHECK" &&
            ep != null &&
            (freshStructural.includes("failed_breakdown_reclaim_opposite_displacement") ||
                freshStructural.includes("box_break_unconfirmed")),
        `subtype=${judgment.subtype}, freshStructural=${freshStructural.join("|")}, ep=${ep?.episodeId ?? "null"}`
    );
}

// =========================================================================
// D — Same historical micro across repeated ticks => no fresh re-arm
// =========================================================================
{
    clearWhipsawObservationState("BTCUSDT");

    const microCandles = makeMicroUpThenDropCandles(69000);
    const snapOverrides = {
        signal: "paper_long_candidate" as const,
        emaGap: 0.0045,
        boxBreakSide: "upper" as const,
        reviewing_ticks: 2,
        breakoutFailureRate: 0.45,
        volumeExpansion: 1.2,
        candles: microCandles,
        htf_candles: {
            "5m": microCandles,
            "15m": microCandles,
            "1h": microCandles,
            "4h": microCandles
        }
    };

    const first = detectMarketRegime(
        makeBaseInput("BTCUSDT", snapOverrides, { directionalShockState: "UP" }, "BULLISH")
    );
    const ep1 = whipsawObservationAuthority.getEpisode("BTCUSDT");

    updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: false,
        directionalShockState: "NONE",
        structuralHits: []
    });

    const second = detectMarketRegime(
        makeBaseInput("BTCUSDT", snapOverrides, { directionalShockState: "UP" }, "BULLISH")
    );
    const ep2 = whipsawObservationAuthority.getEpisode("BTCUSDT");

    run(
        "D_SAME_MICRO_NO_FRESH_REARM",
        first.subtype === "WHIPSAW_SHOCK_RECHECK" &&
            ep1 != null &&
            second.subtype !== "WHIPSAW_SHOCK_RECHECK" &&
            ep2 == null,
        `first=${first.subtype}, second=${second.subtype}, ep1=${ep1?.episodeId ?? "null"}, ep2=${ep2?.episodeId ?? "null"}`
    );
}

// =========================================================================
// E — Genuine new structural invalidation => HARD re-arm
// =========================================================================
{
    clearWhipsawObservationState("BTCUSDT");

    const microCandles = makeMicroUpThenDropCandles(69000);
    const baseSnap = {
        signal: "paper_long_candidate" as const,
        emaGap: 0.0045,
        reviewing_ticks: 2,
        breakoutFailureRate: 0.45,
        volumeExpansion: 1.2,
        candles: microCandles,
        htf_candles: {
            "5m": microCandles,
            "15m": microCandles,
            "1h": microCandles,
            "4h": microCandles
        }
    };

    detectMarketRegime(
        makeBaseInput(
            "BTCUSDT",
            { ...baseSnap, boxBreakSide: "upper" },
            { directionalShockState: "UP" },
            "BULLISH"
        )
    );

    updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: false,
        directionalShockState: "NONE",
        structuralHits: []
    });

    const rearm = detectMarketRegime(
        makeBaseInput(
            "BTCUSDT",
            { ...baseSnap, boxBreakSide: "lower", breakoutFailureRate: 0.55 },
            { directionalShockState: "DOWN", crashState: "ALERT" },
            "BEARISH"
        )
    );
    const ep = whipsawObservationAuthority.getEpisode("BTCUSDT");

    run(
        "E_FRESH_STRUCTURAL_INVALIDATION_HARD_REARM",
        rearm.subtype === "WHIPSAW_SHOCK_RECHECK" &&
            ep != null &&
            ep.ticks === 1 &&
            (ep.lastResetReason === "fresh_structural_invalidation" ||
                ep.lastResetReason === "shock_direction_flip" ||
                ep.lastResetReason == null),
        `subtype=${rearm.subtype}, ep=${ep?.episodeId ?? "null"}, reset=${ep?.lastResetReason ?? "null"}`
    );
}

console.log("\nALL WHIPSAW DETECTOR SEMANTICS REGRESSION TESTS PASSED (A–E)!");
