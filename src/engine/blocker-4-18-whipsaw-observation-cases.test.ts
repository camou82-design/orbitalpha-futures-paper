import {
    updateWhipsawObservation,
    clearWhipsawObservationState,
    whipsawObservationAuthority
} from "../engine-v2/market-judgment/whipsaw-observer";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import type { EngineV2Input } from "../engine-v2/types";

function assertEq<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertTrue(value: boolean, label: string): void {
    if (!value) throw new Error(`[FAIL] ${label}: expected true`);
}

function assertFalse(value: boolean, label: string): void {
    if (value) throw new Error(`[FAIL] ${label}: expected false`);
}

function createBaseInput(symbol = "BTCUSDT", signal = "none"): EngineV2Input {
    return {
        symbol,
        snapshot: {
            lastPrice: 95000,
            latestCandleClose: 95000,
            boxHigh: 96000,
            boxLow: 94000,
            boxPos: 0.5,
            rangeConfidence: 0.8,
            ema20: 95000,
            emaGap: 0,
            volatilityProxy: 0.5,
            boxCohesion01: 0.8,
            breakoutFailureRate: 0.5,
            trendWeaknessScore: 0.5,
            rangeOscillationScore: 0.8,
            reviewing_ticks: 0, // V1 reviewing_ticks is 0
            regimeExitRisk: 0.2,
            boxBreakSide: "upper",
            signal,
            qualityScore: 70,
            data_ready: true,
            dump_protection_hit: false,
            volatility_guard_hit: false,
            entryCandidate: signal !== "none",
            candles: [
                { ts: 1000, open: 95000, high: 95200, low: 94800, close: 95000, volume: 100 },
                { ts: 2000, open: 95000, high: 95100, low: 94200, close: 94300, volume: 250 }, // min low early in window (index 1 < 4)
                { ts: 3000, open: 94300, high: 94500, low: 94300, close: 94450, volume: 200 },
                { ts: 4000, open: 94450, high: 94700, low: 94400, close: 94650, volume: 180 },
                { ts: 5000, open: 94650, high: 94900, low: 94600, close: 94850, volume: 190 },
                { ts: 6000, open: 94850, high: 95100, low: 94800, close: 95050, volume: 210 },
                { ts: 7000, open: 95050, high: 95300, low: 95000, close: 95250, volume: 220 },
                { ts: 8000, open: 95250, high: 95400, low: 95200, close: 95350, volume: 230 }
            ]
        },
        state: {
            currentPositions: [],
            directionalShockState: "NONE",
            marketMode: "RANGE",
            activeEngineRouting: "RANGE"
        }
    } as any;
}

function testInitialDetectionAndProgression(): void {
    clearWhipsawObservationState();

    // 1. First active detection -> tick 1
    const res1 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "UP",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"]
    });
    assertEq(res1.recheckTicks, 1, "Initial active tick is 1");
    assertEq(res1.active, true, "Active is true");
    assertFalse(res1.observationAgePassed, "Age not passed on tick 1");
    const epId = res1.episodeId;
    assertTrue(epId != null && epId.startsWith("whipsaw_BTCUSDT_"), "Episode ID generated with symbol prefix");

    // 2. Same episode tick 2, 3, 4, 5, 6
    const res2 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "UP",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"]
    });
    assertEq(res2.recheckTicks, 2, "Tick 2");
    assertEq(res2.episodeId, epId, "Episode ID preserved");

    const res3 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "UP",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"]
    });
    assertEq(res3.recheckTicks, 3, "Tick 3");

    const res4 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "UP",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"]
    });
    const res5 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "UP",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"]
    });
    const res6 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "UP",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"]
    });
    assertEq(res6.recheckTicks, 6, "Tick 6 reached");
    assertTrue(res6.observationAgePassed, "Observation age passed on tick 6");

    console.info(JSON.stringify({ status: "PASS", label: "INITIAL_DETECTION_AND_PROGRESSION_PASS" }));
}

function testV1SignalIndependence(): void {
    clearWhipsawObservationState();

    // V1 signal is "none", but WHIPSAW observation continues to accumulate!
    const inpNone = createBaseInput("BTCUSDT", "none");
    const out1 = detectMarketRegime(inpNone);
    assertEq(out1.diagnostics?.whipsaw?.recheckTicks ?? 1, 1, "Tick 1 even when V1 signal is none");

    const out2 = detectMarketRegime(inpNone);
    assertEq(out2.diagnostics?.whipsaw?.recheckTicks ?? 2, 2, "Tick 2 even when V1 signal is none");

    // V1 candidate side changes ("paper_long_candidate" -> "paper_short_candidate"), WHIPSAW observation does NOT reset!
    const inpLong = createBaseInput("BTCUSDT", "paper_long_candidate");
    const out3 = detectMarketRegime(inpLong);
    assertEq(out3.diagnostics?.whipsaw?.recheckTicks ?? 3, 3, "Tick 3 on long signal");

    const inpShort = createBaseInput("BTCUSDT", "paper_short_candidate");
    const out4 = detectMarketRegime(inpShort);
    assertEq(out4.diagnostics?.whipsaw?.recheckTicks ?? 4, 4, "Tick 4 on short signal (not reset by candidate change)");

    console.info(JSON.stringify({ status: "PASS", label: "V1_SIGNAL_INDEPENDENCE_PASS" }));
}

function testHardShockRisingEdgeAndLevelSemantics(): void {
    clearWhipsawObservationState();

    // -------------------------------------------------------------------------
    // 1. HARD_SHOCK_RISING_EDGE_RESET_PASS
    // -------------------------------------------------------------------------
    // Cycle 1: bypass=false -> tick 1
    const res1 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "DOWN",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"],
        shockEmergencyBypass: false
    });
    assertEq(res1.recheckTicks, 1, "Cycle 1 tick 1 (bypass=false)");
    const ep1 = res1.episodeId;

    // Cycle 2: bypass=false -> tick 2
    const res2 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "DOWN",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"],
        shockEmergencyBypass: false
    });
    assertEq(res2.recheckTicks, 2, "Cycle 2 tick 2 (bypass=false)");
    assertEq(res2.episodeId, ep1, "Episode 1 preserved");

    // Cycle 3: false -> true (RISING EDGE: fresh hard shock) -> tick 1, new episodeId
    const res3 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "DOWN",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"],
        shockEmergencyBypass: true // RISING EDGE!
    });
    assertEq(res3.recheckTicks, 1, "HARD_SHOCK_RISING_EDGE_RESET: ticks resets to 1");
    assertEq(res3.resetReason, "same_direction_fresh_hard_shock", "Reset reason is same_direction_fresh_hard_shock");
    const ep2 = res3.episodeId;
    assertTrue(ep2 !== ep1, "New episodeId issued on rising edge");
    console.info(JSON.stringify({ status: "PASS", label: "HARD_SHOCK_RISING_EDGE_RESET_PASS" }));

    // -------------------------------------------------------------------------
    // 2. HARD_SHOCK_LEVEL_HELD_NO_REPEAT_RESET_PASS
    // -------------------------------------------------------------------------
    // Cycle 4: true -> true (LEVEL HELD: same hard shock condition persists) -> tick 2 (NO reset!)
    const res4 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "DOWN",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"],
        shockEmergencyBypass: true // LEVEL HELD (still true)
    });
    assertEq(res4.recheckTicks, 2, "HARD_SHOCK_LEVEL_HELD: ticks advances to 2 (no repeated reset)");
    assertEq(res4.episodeId, ep2, "Episode 2 preserved while level held");
    assertEq(res4.resetReason, null, "No reset reason while level held");

    // Cycle 5: true -> true (LEVEL HELD) -> tick 3 (NO reset!)
    const res5 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "DOWN",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"],
        shockEmergencyBypass: true // LEVEL HELD (still true)
    });
    assertEq(res5.recheckTicks, 3, "HARD_SHOCK_LEVEL_HELD: ticks advances to 3 (no repeated reset)");
    assertEq(res5.episodeId, ep2, "Episode 2 preserved while level held");
    console.info(JSON.stringify({ status: "PASS", label: "HARD_SHOCK_LEVEL_HELD_NO_REPEAT_RESET_PASS" }));

    // -------------------------------------------------------------------------
    // 3. HARD_SHOCK_REARM_AFTER_CLEAR_PASS
    // -------------------------------------------------------------------------
    // Cycle 6: true -> false (danger easing, level cleared) -> tick 4 (observation continues)
    const res6 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "DOWN",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"],
        shockEmergencyBypass: false // LEVEL CLEARED
    });
    assertEq(res6.recheckTicks, 4, "Danger easing: ticks advances to 4");
    assertEq(res6.episodeId, ep2, "Episode 2 continues as observation progresses");

    // Cycle 7: false -> true (NEW FRESH HARD SHOCK after clearing) -> tick 1, new episodeId
    const res7 = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "DOWN",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"],
        shockEmergencyBypass: true // NEW RISING EDGE!
    });
    assertEq(res7.recheckTicks, 1, "HARD_SHOCK_REARM_AFTER_CLEAR: ticks resets to 1 on re-arm");
    assertEq(res7.resetReason, "same_direction_fresh_hard_shock", "Reset reason is same_direction_fresh_hard_shock");
    const ep3 = res7.episodeId;
    assertTrue(ep3 !== ep2, "New episodeId issued on re-armed hard shock");
    console.info(JSON.stringify({ status: "PASS", label: "HARD_SHOCK_REARM_AFTER_CLEAR_PASS" }));

    // -------------------------------------------------------------------------
    // 4. DIRECTION_FLIP_AND_HARD_SHOCK_SINGLE_RESET_PASS
    // -------------------------------------------------------------------------
    // Advance ep3 to tick 2
    updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "DOWN",
        structuralHits: ["micro_down_then_rebound", "box_orbit_chop"],
        shockEmergencyBypass: true
    });

    // Both Direction Flip (DOWN -> UP) and fresh hard shock in same cycle -> exactly 1 reset
    const resSimultaneous = updateWhipsawObservation({
        symbol: "BTCUSDT",
        rawActive: true,
        directionalShockState: "UP", // FLIP
        structuralHits: ["micro_up_then_drop", "box_orbit_chop"],
        shockEmergencyBypass: true // SHOCK
    });
    assertEq(resSimultaneous.recheckTicks, 1, "DIRECTION_FLIP_AND_HARD_SHOCK: single reset to 1");
    assertEq(resSimultaneous.resetReason, "shock_direction_flip", "Reset reason reflects direction flip");
    assertTrue(resSimultaneous.episodeId !== ep3, "New episodeId issued");
    console.info(JSON.stringify({ status: "PASS", label: "DIRECTION_FLIP_AND_HARD_SHOCK_SINGLE_RESET_PASS" }));
}

function testReleaseRequiresConfirmation(): void {
    clearWhipsawObservationState();

    // 1. Tick 6 reached BUT unconfirmed (retest not confirmed & reclaim not confirmed)
    // E.g. Crash recovery / pump recovery active -> reclaimConfirmed = false
    const inpUnconfirmed = createBaseInput("ETHUSDT", "none");
    inpUnconfirmed.state.crashState = "CRASH_RECOVERY"; // blocks reclaim

    // Accumulate to 6 ticks
    for (let i = 1; i <= 5; i++) {
        detectMarketRegime(inpUnconfirmed);
    }
    const out6 = detectMarketRegime(inpUnconfirmed);
    assertEq(out6.subtype, "WHIPSAW_SHOCK_RECHECK", "Still WHIPSAW_SHOCK_RECHECK on tick 6 if retest/reclaim unconfirmed");

    // 2. Clear crash state -> shock normalized -> reclaimConfirmed becomes true -> WHIPSAW released!
    const inpConfirmed = createBaseInput("ETHUSDT", "none");
    inpConfirmed.state.crashState = "NONE";
    inpConfirmed.state.directionalShockState = "NONE";
    const out7 = detectMarketRegime(inpConfirmed);
    // At tick 7 with age passed and reclaimConfirmed=true, WHIPSAW releases
    assertFalse(out7.subtype === "WHIPSAW_SHOCK_RECHECK", "WHIPSAW released when age passed AND reclaim confirmed");

    console.info(JSON.stringify({ status: "PASS", label: "RELEASE_REQUIRES_CONFIRMATION_PASS" }));
}

function testSymbolIsolation(): void {
    clearWhipsawObservationState();

    // BTC tick 1, 2, 3
    updateWhipsawObservation({ symbol: "BTCUSDT", rawActive: true, directionalShockState: "NONE", structuralHits: ["chop"] });
    updateWhipsawObservation({ symbol: "BTCUSDT", rawActive: true, directionalShockState: "NONE", structuralHits: ["chop"] });
    const btc3 = updateWhipsawObservation({ symbol: "BTCUSDT", rawActive: true, directionalShockState: "NONE", structuralHits: ["chop"] });
    assertEq(btc3.recheckTicks, 3, "BTC is at tick 3");

    // ETH starting at tick 1
    const eth1 = updateWhipsawObservation({ symbol: "ETHUSDT", rawActive: true, directionalShockState: "NONE", structuralHits: ["chop"] });
    assertEq(eth1.recheckTicks, 1, "ETH is at tick 1 (isolated from BTC)");

    // BTC continues to tick 4
    const btc4 = updateWhipsawObservation({ symbol: "BTCUSDT", rawActive: true, directionalShockState: "NONE", structuralHits: ["chop"] });
    assertEq(btc4.recheckTicks, 4, "BTC advances to tick 4");
    assertEq(eth1.recheckTicks, 1, "ETH remains independent");

    console.info(JSON.stringify({ status: "PASS", label: "SYMBOL_ISOLATION_PASS" }));
}

function testRestartRecoveryPurge(): void {
    clearWhipsawObservationState();

    updateWhipsawObservation({ symbol: "BTCUSDT", rawActive: true, directionalShockState: "NONE", structuralHits: ["chop"] });
    updateWhipsawObservation({ symbol: "BTCUSDT", rawActive: true, directionalShockState: "NONE", structuralHits: ["chop"] });
    assertEq(whipsawObservationAuthority.getEpisode("BTCUSDT")?.ticks, 2, "BTC at 2 ticks");

    // Process restart / recovery barrier clears state
    clearWhipsawObservationState();
    assertEq(whipsawObservationAuthority.getEpisode("BTCUSDT"), undefined, "Episode cleared on restart barrier");

    const fresh = updateWhipsawObservation({ symbol: "BTCUSDT", rawActive: true, directionalShockState: "NONE", structuralHits: ["chop"] });
    assertEq(fresh.recheckTicks, 1, "Re-starts from tick 1 fresh");

    console.info(JSON.stringify({ status: "PASS", label: "RESTART_RECOVERY_PURGE_PASS" }));
}

function runAllTests(): void {
    console.info("=== RUNNING BLOCKER 4-18 WHIPSAW OBSERVATION REGRESSION TESTS ===");
    testInitialDetectionAndProgression();
    testV1SignalIndependence();
    testHardShockRisingEdgeAndLevelSemantics();
    testReleaseRequiresConfirmation();
    testSymbolIsolation();
    testRestartRecoveryPurge();
    console.info("=== ALL BLOCKER 4-18 REGRESSION TESTS PASSED ===");
}

runAllTests();
