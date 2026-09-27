import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deriveV2StateAuthority, clearGlobalShockStates, globalShockStates } from "../engine-v2/state/derive";
import { runEngineV2, marketJudgmentCacheBySymbol } from "../engine-v2/index";
import type { EngineV2Input } from "../engine-v2/types";
import type { Candle } from "../models/types";

function risingCandles(base = 80000, steps = 24): Candle[] {
    const baseTs = 1788410000000;
    return Array.from({ length: steps }, (_, i) => {
        const close = base + i * 40;
        return {
            ts: baseTs + i * 60_000,
            open: close - 20,
            high: close + 30,
            low: close - 25,
            close,
            volume: 120
        };
    });
}

function makeInput(overrides: Partial<EngineV2Input> = {}): EngineV2Input {
    const candles = risingCandles();
    const boxHigh = 80100;
    const now = Date.now();
    return {
        run_cycle_id: "release-test",
        symbol: "BTCUSDT",
        now,
        candles,
        config: { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as EngineV2Input["config"],
        evaluationMode: "authoritative",
        v1Result: { regime: "RANGE", decision: "HOLD", side: "NONE", isBlocked: false },
        snapshot: {
            symbol: "BTCUSDT",
            lastPrice: candles[candles.length - 1].close,
            latestCandleClose: candles[candles.length - 1].close,
            qualityScore: 85,
            boxPos: 0.82,
            boxLow: 79000,
            boxHigh,
            atr: 250,
            rangeConfidence: 0.72,
            boxCohesion01: 0.9,
            trendWeaknessScore: 0.22,
            emaGap: 0.0008,
            ema20: candles[candles.length - 1].close - 50,
            ema60: candles[candles.length - 1].close - 120,
            canonicalTrendScore: 0.757,
            canonicalTrendWeaknessScore: 0.22,
            canonicalRegime: "RANGE",
            retestConfirmed: true,
            candles,
            tickSz: 0.1,
            lotSz: 0.01,
            htfEntryPolicy: "ALLOW",
            ...(overrides.snapshot ?? {})
        } as EngineV2Input["snapshot"],
        state: {
            currentPositions: [],
            directionalShockState: "DOWN",
            rawDirectionalShockState: "NONE",
            longAllow: false,
            shortAllow: true,
            crashState: "CRASH_LOCK",
            pumpState: "NONE",
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
            okxActualPositions: [],
            okxPendingOrdersReady: true,
            okxPendingOrdersNotionalUsdt: 0,
            okxPendingSymbolNotionalUsdt: 0,
            hasSymbolPendingEntry: false,
            hasUnknownPendingNotional: false,
            okxLiveEnabled: true,
            okxAuthMode: "live",
            okxAuthReady: true,
            okxExchangeAuthOptIn: true,
            okxApiKeyPresent: true,
            okxApiSecretPresent: true,
            okxPassphrasePresent: true,
            ...(overrides.state ?? {})
        } as EngineV2Input["state"],
        ...overrides
    };
}

describe("V2 stale DOWN_SHOCK / CRASH_LOCK release authority", () => {
    beforeEach(() => {
        clearGlobalShockStates();
        marketJudgmentCacheBySymbol.clear();
    });

    afterEach(() => {
        clearGlobalShockStates();
        marketJudgmentCacheBySymbol.clear();
    });

    it("releases stale DOWN shock and CRASH_LOCK when trend recovery persistence is satisfied", () => {
        const activatedAt = Date.now() - 60_000;
        clearGlobalShockStates("BTCUSDT");
        globalShockStates.set("BTCUSDT", {
            activeDirection: "DOWN",
            rawDirection: "NONE",
            candidateDirection: "NONE",
            candidateCount: 0,
            neutralCount: 2,
            candidateStartedAt: null,
            activatedAt,
            lastChangedAt: activatedAt,
            rawMovePct: 0.0004,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastProcessedCycle: 0
        });

        const input = makeInput();
        const v2State = deriveV2StateAuthority(input);
        assert.equal(v2State.directionalShockState, "NONE");
        assert.equal(v2State.crashState, "NONE");
        assert.equal(v2State.longAllow, true);
        assert.equal(v2State.shockReleaseAuthorityProof?.release_eligible, true);
    });

    it("promotes regime_final to TREND and routes TREND executor after release", () => {
        const activatedAt = Date.now() - 60_000;
        globalShockStates.set("BTCUSDT", {
            activeDirection: "DOWN",
            rawDirection: "NONE",
            candidateDirection: "NONE",
            candidateCount: 0,
            neutralCount: 2,
            candidateStartedAt: null,
            activatedAt,
            lastChangedAt: activatedAt,
            rawMovePct: 0.0004,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastProcessedCycle: 0
        });

        const { internal } = runEngineV2(makeInput());
        const judgment = internal.judgment;
        assert.equal(judgment.regime_final, "TREND");
        assert.notEqual(judgment.diagnostics?.fastTrendShift?.block_reason, "LONG_NOT_ALLOWED");
    });

    it("does not release when live crash re-fires (hard re-arm)", () => {
        const crashCandles: Candle[] = risingCandles(80000, 24);
        const last = crashCandles[crashCandles.length - 1];
        crashCandles[crashCandles.length - 6] = { ...crashCandles[crashCandles.length - 6], close: last.close * 1.02 };

        const activatedAt = Date.now() - 60_000;
        globalShockStates.set("BTCUSDT", {
            activeDirection: "DOWN",
            rawDirection: "NONE",
            candidateDirection: "NONE",
            candidateCount: 0,
            neutralCount: 2,
            candidateStartedAt: null,
            activatedAt,
            lastChangedAt: activatedAt,
            rawMovePct: 0.0004,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastProcessedCycle: 0
        });

        const v2State = deriveV2StateAuthority(
            makeInput({
                candles: crashCandles,
                snapshot: { candles: crashCandles, lastPrice: last.close, latestCandleClose: last.close } as EngineV2Input["snapshot"]
            })
        );
        assert.notEqual(v2State.shockReleaseAuthorityProof?.release_eligible, true);
    });
});
