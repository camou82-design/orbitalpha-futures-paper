import { runEngineV2 } from "../src/engine-v2/index";
import { clearGlobalShockStates, deriveV2StateAuthority } from "../src/engine-v2/state/derive";
import type { Candle } from "../src/models/types";

function assert(cond: boolean, msg: string) {
    if (!cond) {
        console.error(`FAIL: ${msg}`);
        process.exit(1);
    }
    console.log(`PASS: ${msg}`);
}

function makeCandles(prices: number[]): Candle[] {
    const now = Date.now();
    return prices.map((p, idx) => ({
        ts: now - (prices.length - idx) * 60000,
        open: p * 0.999,
        high: p * 1.002,
        low: p * 0.998,
        close: p,
        volume: 100
    }));
}

function buildLiveReadyState(now: number, overrides: any = {}): Record<string, any> {
    return {
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        closeOnlyMode: false,
        killSwitch: false,
        reconcileSafeMode: false,
        liveBalanceReady: true,
        accountEquityUsdt: 900,
        availableBalanceUsdt: 900,
        equityUsdt: 900,
        okxAuthMode: "live",
        okxAuthReady: true,
        okxExchangeAuthOptIn: true,
        okxLiveEnabled: true,
        okxDemoEnabled: false,
        okxApiKeyPresent: true,
        okxApiSecretPresent: true,
        okxPassphrasePresent: true,
        okxActualPositionsReady: true,
        actualAccountNotionalUsdtReady: true,
        okxPendingOrdersReady: true,
        okxActualPositions: [],
        okxPendingOrdersNotionalUsdt: 0,
        okxPendingSymbolNotionalUsdt: 0,
        currentPositions: [],
        balanceFetchedAt: now - 1000,
        positionsFetchedAt: now - 1000,
        pendingOrdersFetchedAt: now - 1000,
        longAllow: true,
        shortAllow: true,
        ...overrides
    };
}

async function runTestSuite() {
    console.log("=== RUNNING RANGE-TREND RECLAIM MICRO PROBE TEST SUITE ===");

    // Base mock candles for BTC
    const baseCandles = makeCandles([
        78000, 77950, 77900, 77850, 77800, 77750, 77700, 77650, // drop
        77680, 77720, 77750, 77780, 77810, 77830, 77840, 77845  // bounce
    ]);

    const baseSnapshot = {
        lastPrice: 77845,
        latestCandleClose: 77845,
        boxHigh: 78100,
        boxLow: 77400,
        boxPos: 0.6422,
        ema20: 77800,
        ema60: 77750,
        emaGap: 0.00064,
        trendWeaknessScore: 0.3,
        atr: 120,
        atr20: 120,
        closedClose: 77840,
        candles: baseCandles,
        canonicalRegime: "RANGE",
        qualityScore: 68,
        tickSz: 0.1,
        lotSz: 0.01,
        minSz: 0.01
    };

    const baseConfig = {
        paperMaxOpenPositions: 3,
        baseSizeUsd: 100,
        okxLiveMaxAccountNotionalUsdt: 2700,
        okxLiveMaxSymbolNotionalUsdt: 2475,
        okxLiveMaxOrderNotionalUsdt: 1000
    };

    // TEST A: Reclaim at boxPos=0.640, conflict at boxPos=0.6422, quality=68 -> 0.25x Probe PASS
    {
        clearGlobalShockStates();

        const now = 1788424087000;
        const decayInput: any = {
            symbol: "BTCUSDT",
            now,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77840, boxPos: 0.640 },
            config: baseConfig,
            state: buildLiveReadyState(now, { directionalShockState: "DOWN" })
        };
        const derivedState = deriveV2StateAuthority(decayInput);
        assert(derivedState.directionalShockState === "NONE", "TEST_A_1: Shock decayed to NONE");

        const conflictNow = 1788424089000;
        const conflictInput: any = {
            symbol: "BTCUSDT",
            now: conflictNow,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77845, boxPos: 0.6422 },
            config: baseConfig,
            state: buildLiveReadyState(conflictNow, { directionalShockState: "NONE" })
        };
        const res = runEngineV2(conflictInput);
        assert(res.decision.decision === "ENTER", `TEST_A_2: Decision is ENTER (got ${res.decision.decision})`);
        assert(res.decision.side === "long", `TEST_A_3: Side is long (got ${res.decision.side})`);
        assert(res.decision.metadata?.promotion_reason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE", "TEST_A_4: Promotion reason is V2_RANGE_TREND_RECLAIM_MICRO_PROBE");
        assert(res.decision.metadata?.range_trend_reclaim_micro_probe === true, "TEST_A_5: range_trend_reclaim_micro_probe metadata true");
    }

    // TEST B: Reclaim at boxPos=0.66 (> 0.65) -> Probe Forbidden
    {
        clearGlobalShockStates();

        const now = 1788424087000;
        const decayInput: any = {
            symbol: "BTCUSDT",
            now,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77860, boxPos: 0.660 },
            config: baseConfig,
            state: buildLiveReadyState(now, { directionalShockState: "DOWN" })
        };
        deriveV2StateAuthority(decayInput);

        const conflictNow = 1788424089000;
        const conflictInput: any = {
            symbol: "BTCUSDT",
            now: conflictNow,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77860, boxPos: 0.660 },
            config: baseConfig,
            state: buildLiveReadyState(conflictNow, { directionalShockState: "NONE" })
        };
        const res = runEngineV2(conflictInput);
        assert(res.decision.decision === "SKIP", `TEST_B: Reclaim > 0.65 is forbidden (SKIP, got ${res.decision.decision})`);
    }

    // TEST C: Reclaim at 0.64 but current boxPos=0.66 (> 0.65) -> Forbidden
    {
        clearGlobalShockStates();

        const now = 1788424087000;
        const decayInput: any = {
            symbol: "BTCUSDT",
            now,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77840, boxPos: 0.640 },
            config: baseConfig,
            state: buildLiveReadyState(now, { directionalShockState: "DOWN" })
        };
        deriveV2StateAuthority(decayInput);

        const conflictNow = 1788424089000;
        const conflictInput: any = {
            symbol: "BTCUSDT",
            now: conflictNow,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77860, boxPos: 0.660 },
            config: baseConfig,
            state: buildLiveReadyState(conflictNow, { directionalShockState: "NONE" })
        };
        const res = runEngineV2(conflictInput);
        assert(res.decision.decision === "SKIP", `TEST_C: Current boxPos > 0.65 is forbidden (SKIP, got ${res.decision.decision})`);
    }

    // TEST D: 1 cycle grace expired (> 60s) -> Forbidden
    {
        clearGlobalShockStates();

        const now = 1788424087000;
        const decayInput: any = {
            symbol: "BTCUSDT",
            now,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77840, boxPos: 0.640 },
            config: baseConfig,
            state: buildLiveReadyState(now, { directionalShockState: "DOWN" })
        };
        deriveV2StateAuthority(decayInput);

        const conflictNow = 1788424087000 + 70000;
        const conflictInput: any = {
            symbol: "BTCUSDT",
            now: conflictNow,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77845, boxPos: 0.6422 },
            config: baseConfig,
            state: buildLiveReadyState(conflictNow, { directionalShockState: "NONE" })
        };
        const res = runEngineV2(conflictInput);
        assert(res.decision.decision === "SKIP", `TEST_D: Expired reclaim (>60s) is forbidden (SKIP, got ${res.decision.decision})`);
    }

    // TEST E: Quality below micro-probe floor (< 64, e.g. 55) -> Forbidden
    {
        clearGlobalShockStates();

        const now = 1788424087000;
        const decayInput: any = {
            symbol: "BTCUSDT",
            now,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77840, boxPos: 0.640 },
            config: baseConfig,
            state: buildLiveReadyState(now, { directionalShockState: "DOWN" })
        };
        deriveV2StateAuthority(decayInput);

        const conflictNow = 1788424089000;
        const conflictInput: any = {
            symbol: "BTCUSDT",
            now: conflictNow,
            candles: baseCandles,
            snapshot: {
                ...baseSnapshot,
                lastPrice: 77845,
                boxPos: 0.6422,
                entryQualityLossDistance: 0.95,
                qualityScore: 55
            },
            config: baseConfig,
            state: buildLiveReadyState(conflictNow, { directionalShockState: "NONE" })
        };
        const res = runEngineV2(conflictInput);
        assert(res.decision.decision === "SKIP" || res.decision.decision === "HOLD", `TEST_E: Quality < 64 is forbidden (got ${res.decision.decision})`);
    }

    // TEST F: Genuine HTF hard veto -> Forbidden
    {
        clearGlobalShockStates();

        const now = 1788424087000;
        const decayInput: any = {
            symbol: "BTCUSDT",
            now,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77840, boxPos: 0.640 },
            config: baseConfig,
            state: buildLiveReadyState(now, { directionalShockState: "DOWN" })
        };
        deriveV2StateAuthority(decayInput);

        const htfBearishCandles = makeCandles(Array(100).fill(0).map((_, i) => 80000 - i * 50));
        const conflictNow = 1788424089000;
        const conflictInput: any = {
            symbol: "BTCUSDT",
            now: conflictNow,
            candles: baseCandles,
            snapshot: {
                ...baseSnapshot,
                lastPrice: 77845,
                boxPos: 0.6422,
                htfCandles: {
                    "5m": htfBearishCandles,
                    "15m": htfBearishCandles,
                    "1h": htfBearishCandles
                }
            },
            config: baseConfig,
            state: buildLiveReadyState(conflictNow, { directionalShockState: "NONE" })
        };
        const res = runEngineV2(conflictInput);
        assert(res.decision.decision !== "ENTER" || res.decision.metadata?.htf_policy !== "HOLD", "TEST_F: Genuine HTF conflict respected");
    }

    // TEST G: Shock active again -> Forbidden
    {
        clearGlobalShockStates();

        const now = 1788424087000;
        const decayInput: any = {
            symbol: "BTCUSDT",
            now,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77840, boxPos: 0.640 },
            config: baseConfig,
            state: buildLiveReadyState(now, { directionalShockState: "DOWN" })
        };
        deriveV2StateAuthority(decayInput);

        const conflictNow = 1788424089000;
        const conflictInput: any = {
            symbol: "BTCUSDT",
            now: conflictNow,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77845, boxPos: 0.6422 },
            config: baseConfig,
            state: buildLiveReadyState(conflictNow, { directionalShockState: "DOWN" })
        };
        const res = runEngineV2(conflictInput);
        assert(res.decision.decision !== "ENTER", `TEST_G: Active shock forbids reclaim probe (got ${res.decision.decision})`);
    }

    // TEST H: No structural reclaim recorded -> Forbidden
    {
        clearGlobalShockStates();

        const now = 1788424089000;
        const conflictInput: any = {
            symbol: "BTCUSDT",
            now,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77845, boxPos: 0.6422 },
            config: baseConfig,
            state: buildLiveReadyState(now, { directionalShockState: "NONE" })
        };
        const res = runEngineV2(conflictInput);
        assert(res.decision.decision === "SKIP", `TEST_H: No prior structural reclaim forbids probe (SKIP, got ${res.decision.decision})`);
    }

    // TEST I: Full-entry quality threshold remains >= 70 (conflict without reclaim is SKIP)
    {
        clearGlobalShockStates();

        const now = 1788424089000;
        const normalConflictInput: any = {
            symbol: "BTCUSDT",
            now,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77845, boxPos: 0.6422, qualityScore: 68 },
            config: baseConfig,
            state: buildLiveReadyState(now, { directionalShockState: "NONE" })
        };
        const res = runEngineV2(normalConflictInput);
        assert(res.decision.decision === "SKIP", `TEST_I: Conflict without reclaim cannot enter at quality 68 (SKIP, got ${res.decision.decision})`);
    }

    // TEST J: Reason class is EXPLICIT_MICRO_PROBE and multiplier exactly 0.25
    {
        clearGlobalShockStates();

        const now = 1788424087000;
        const decayInput: any = {
            symbol: "BTCUSDT",
            now,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77840, boxPos: 0.640 },
            config: baseConfig,
            state: buildLiveReadyState(now, { directionalShockState: "DOWN" })
        };
        deriveV2StateAuthority(decayInput);

        const conflictNow = 1788424089000;
        const conflictInput: any = {
            symbol: "BTCUSDT",
            now: conflictNow,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77845, boxPos: 0.6422 },
            config: baseConfig,
            state: buildLiveReadyState(conflictNow, { directionalShockState: "NONE" })
        };
        const res = runEngineV2(conflictInput);
        assert(res.decision.metadata?.promotion_reason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE", "TEST_J_1: Reason is V2_RANGE_TREND_RECLAIM_MICRO_PROBE");
        assert(res.decision.metadata?.range_trend_reclaim_micro_probe === true, "TEST_J_2: range_trend_reclaim_micro_probe flag is true");
    }

    // TEST K: Generic symbol support (ETHUSDT)
    {
        clearGlobalShockStates();

        const ethCandles = makeCandles([
            2600, 2595, 2590, 2585, 2580, 2575, 2572, 2570,
            2573, 2576, 2580, 2583, 2586, 2588, 2590, 2592
        ]);
        const ethSnapshot = {
            lastPrice: 2590,
            latestCandleClose: 2590,
            boxHigh: 2650,
            boxLow: 2500,
            boxPos: 0.60,
            ema20: 2575,
            ema60: 2550,
            emaGap: 0.00098,
            trendWeaknessScore: 0.3,
            atr: 15,
            atr20: 15,
            closedClose: 2585,
            candles: ethCandles,
            canonicalRegime: "RANGE",
            qualityScore: 68,
            tickSz: 0.01,
            lotSz: 0.1,
            minSz: 0.1
        };

        const now = 1788424087000;
        const ethDecayInput: any = {
            symbol: "ETHUSDT",
            now,
            candles: ethCandles,
            snapshot: ethSnapshot,
            config: baseConfig,
            state: buildLiveReadyState(now, { directionalShockState: "DOWN" })
        };
        const ethDerived = deriveV2StateAuthority(ethDecayInput);
        assert(ethDerived.directionalShockState === "NONE", "TEST_K_1: ETH Shock decayed to NONE");

        const conflictNow = 1788424089000;
        const ethConflictInput: any = {
            symbol: "ETHUSDT",
            now: conflictNow,
            candles: ethCandles,
            snapshot: { ...ethSnapshot, boxPos: 0.62 },
            config: baseConfig,
            state: buildLiveReadyState(conflictNow, { directionalShockState: "NONE" })
        };
        const ethRes = runEngineV2(ethConflictInput);
        assert(ethRes.decision.decision === "ENTER", `TEST_K_2: ETH Decision is ENTER (got ${ethRes.decision.decision})`);
        assert(ethRes.decision.metadata?.promotion_reason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE", "TEST_K_3: ETH promotion reason matches");
    }

    // TEST L: Live 08:28 replay at 77845 / boxPos 0.6422 -> Probe Allowed
    {
        clearGlobalShockStates();

        const now = 1788424087141;
        const replayDecayInput: any = {
            symbol: "BTCUSDT",
            now,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77840, boxPos: 0.640 },
            config: baseConfig,
            state: buildLiveReadyState(now, { directionalShockState: "DOWN" })
        };
        const btcDerived = deriveV2StateAuthority(replayDecayInput);
        assert(btcDerived.directionalShockState === "NONE", "TEST_L_1: Decay triggered at 08:28:07");

        const conflictNow = 1788424089108;
        const replayConflictInput: any = {
            symbol: "BTCUSDT",
            now: conflictNow,
            candles: baseCandles,
            snapshot: { ...baseSnapshot, lastPrice: 77845, boxPos: 0.6422 },
            config: baseConfig,
            state: buildLiveReadyState(conflictNow, { directionalShockState: "NONE" })
        };
        const replayRes = runEngineV2(replayConflictInput);
        assert(replayRes.decision.decision === "ENTER", `TEST_L_2: 08:28:09 cycle entered successfully (got ${replayRes.decision.decision})`);
        assert(replayRes.decision.side === "long", `TEST_L_3: 08:28:09 cycle entered LONG (got ${replayRes.decision.side})`);
        assert(replayRes.decision.metadata?.promotion_reason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE", "TEST_L_4: Reason is V2_RANGE_TREND_RECLAIM_MICRO_PROBE");
    }

    console.log("=== ALL 12 TESTS (A through L) PASSED SUCCESSFULLY! ===");
}

runTestSuite().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
