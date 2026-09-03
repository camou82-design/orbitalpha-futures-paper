import assert from "node:assert";
import {
    clearGlobalShockStates,
    evaluateStructuralReclaimEarlyDecay,
    deriveV2StateAuthority,
    globalShockStates
} from "../src/engine-v2/state/derive";
import { detectMarketRegime } from "../src/engine-v2/market-judgment/detector";
import type { EngineV2Input } from "../src/engine-v2/types";
import type { Candle } from "../src/models/types";

function assertEq<T>(actual: T, expected: T, message: string) {
    assert.strictEqual(actual, expected, message);
}

function assertTrue(condition: boolean, message: string) {
    assert.strictEqual(condition, true, message);
}

function assertFalse(condition: boolean, message: string) {
    assert.strictEqual(condition, false, message);
}

function createCandles(closes: number[], baseTs = 1788410000000): Candle[] {
    return closes.map((close, i) => {
        const prev = i > 0 ? closes[i - 1] : close;
        const open = prev;
        const high = Math.max(open, close) + 2;
        const low = Math.min(open, close) - 2;
        return {
            ts: baseTs + i * 60000,
            open,
            high,
            low,
            close,
            volume: 100
        };
    });
}

function buildBaseEngineInput(overrides: Partial<EngineV2Input> = {}): EngineV2Input {
    const defaultCandles = createCandles([77900, 77910, 77920, 77930, 77940, 77950, 77960, 77970, 77980, 77990, 78000, 78010, 78020, 78030, 78040, 78050]);
    return {
        symbol: "BTCUSDT",
        candles: defaultCandles,
        htf_candles: {
            "5m": defaultCandles,
            "15m": defaultCandles,
            "1h": defaultCandles,
            "4h": defaultCandles,
            "1d": defaultCandles
        },
        snapshot: {
            symbol: "BTCUSDT",
            lastPrice: 78050,
            boxHigh: 78100,
            boxLow: 77500,
            boxPos: 0.5,
            ema20: 78000,
            ema60: 77950,
            emaGap: 0.0005,
            trendWeaknessScore: 0.3,
            rangeConfidence: 0.4,
            breakoutFailureRate: 0.2,
            boxCohesion01: 0.8,
            candles: defaultCandles,
            atr: 50,
            data_ready: true,
            serverTradeEnabled: true
        } as any,
        state: {
            directionalShockState: "NONE",
            longAllow: true,
            shortAllow: true,
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            riskMode: "PAPER_TEST"
        } as any,
        config: {
            risk_per_trade_pct: 0.01,
            leverage: 10
        } as any,
        ...overrides
    };
}

export function runShockDecayTests(): void {
    console.info("=== STARTING PHASE SHOCK-DECAY-1 VERIFICATION SUITE ===");

    // =========================================================================
    // 1. UNIT TEST: evaluateStructuralReclaimEarlyDecay
    // =========================================================================
    {
        console.info("Testing evaluateStructuralReclaimEarlyDecay unit scenarios...");

        // Case A: Active DOWN shock, 2 bullish candles + price reclaimed above boxLow
        const bullishCandles = createCandles([77450, 77480, 77520]); // c1: 77480, c2: 77520 (both green)
        const snapBullish = { lastPrice: 77520, boxLow: 77500, boxHigh: 78000, ema20: 77490 };
        const resA = evaluateStructuralReclaimEarlyDecay({
            activeDirection: "DOWN",
            candles: bullishCandles,
            snapshot: snapBullish
        });
        assertTrue(resA.eligible, "UNIT A: Bullish 2 green candles + boxLow reclaim should be eligible");
        assertEq(resA.closed1mCount, 2, "UNIT A: closed1mCount should be 2");
        assertTrue(resA.structuralReclaimed, "UNIT A: structuralReclaimed should be true");

        // Case B: Active UP shock, 2 bearish candles + price fell below boxHigh
        const bearishCandles = createCandles([78150, 78100, 78040]); // c1: 78100, c2: 78040 (both red)
        const snapBearish = { lastPrice: 78040, boxLow: 77500, boxHigh: 78080, ema20: 78090 };
        const resB = evaluateStructuralReclaimEarlyDecay({
            activeDirection: "UP",
            candles: bearishCandles,
            snapshot: snapBearish
        });
        assertTrue(resB.eligible, "UNIT B: Bearish 2 red candles + boxHigh reclaim should be eligible");
        assertEq(resB.closed1mCount, 2, "UNIT B: closed1mCount should be 2");
        assertTrue(resB.structuralReclaimed, "UNIT B: structuralReclaimed should be true");

        // Case C: Active DOWN shock, but only 1 candle green -> NOT eligible
        const oneGreenCandle = createCandles([77450, 77420, 77520]); // c1: red (77450->77420), c2: green (77420->77520)
        const resC = evaluateStructuralReclaimEarlyDecay({
            activeDirection: "DOWN",
            candles: oneGreenCandle,
            snapshot: snapBullish
        });
        assertFalse(resC.eligible, "UNIT C: Only 1 green candle should NOT be eligible");

        // Case D: Active DOWN shock, 2 green candles, but NO structural reclaim (still deep below boxLow and below ema20)
        const deepCandles = createCandles([77200, 77250, 77300]); // green, but lastPrice 77300 < boxLow 77500 and < ema20 77400
        const resD = evaluateStructuralReclaimEarlyDecay({
            activeDirection: "DOWN",
            candles: deepCandles,
            snapshot: { lastPrice: 77300, boxLow: 77500, boxHigh: 78000, ema20: 77400 }
        });
        assertFalse(resD.eligible, "UNIT D: 2 green candles without structural reclaim should NOT be eligible");
    }

    // =========================================================================
    // 2. REPLAY 4 AUDIT CASES
    // =========================================================================
    
    // REPLAY CASE 1: 07:05 Peak (UP -> DOWN)
    {
        console.info("Testing REPLAY CASE 1: 07:05 Peak (UP -> DOWN)...");
        clearGlobalShockStates("BTCUSDT");

        // Force an active UP shock in state
        const state = (globalShockStates.get("BTCUSDT") || {
            activeDirection: "UP",
            rawDirection: "UP",
            candidateDirection: "UP",
            candidateCount: 2,
            neutralCount: 0,
            candidateStartedAt: 1000,
            activatedAt: 1000,
            lastChangedAt: 1000,
            rawMovePct: 0.003,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastProcessedCycle: 1
        });
        globalShockStates.set("BTCUSDT", state as any);

        // Feed bearish turnaround candles (2 red candles breaking below boxHigh 78100 and ema20 78120)
        const bearishCandles = createCandles([78150, 78120, 78050]);
        const input = buildBaseEngineInput({
            candles: bearishCandles,
            snapshot: {
                symbol: "BTCUSDT",
                lastPrice: 78050,
                boxHigh: 78100,
                boxLow: 77500,
                boxPos: 0.75,
                ema20: 78120,
                candles: bearishCandles
            } as any,
            now: 2000
        });

        const derived = deriveV2StateAuthority(input);
        assertEq(derived.directionalShockState, "NONE", "REPLAY CASE 1: Active UP shock should decay early to NONE upon bearish reclaim");
        assertFalse(derived.directionalShockState === "DOWN", "REPLAY CASE 1: Must NOT directly flip to DOWN shock");
    }

    // REPLAY CASE 2: 07:21 Low (DOWN -> UP)
    {
        console.info("Testing REPLAY CASE 2: 07:21 Low (DOWN -> UP)...");
        clearGlobalShockStates("BTCUSDT");

        // Force an active DOWN shock
        globalShockStates.set("BTCUSDT", {
            activeDirection: "DOWN",
            rawDirection: "DOWN",
            candidateDirection: "DOWN",
            candidateCount: 2,
            neutralCount: 0,
            candidateStartedAt: 1000,
            activatedAt: 1000,
            lastChangedAt: 1000,
            rawMovePct: 0.003,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastProcessedCycle: 1
        } as any);

        // Feed bullish reversal candles (2 green candles reclaiming above boxLow 77500 and ema20 77520)
        const bullishCandles = createCandles([77450, 77500, 77580]);
        const input = buildBaseEngineInput({
            candles: bullishCandles,
            snapshot: {
                symbol: "BTCUSDT",
                lastPrice: 77580,
                boxHigh: 78100,
                boxLow: 77500,
                boxPos: 0.15,
                ema20: 77520,
                candles: bullishCandles
            } as any,
            now: 2000
        });

        const derived = deriveV2StateAuthority(input);
        assertEq(derived.directionalShockState, "NONE", "REPLAY CASE 2: Active DOWN shock should decay early to NONE upon bullish reclaim");
        assertFalse(derived.directionalShockState === "UP", "REPLAY CASE 2: Must NOT directly flip to UP shock");
    }

    // REPLAY CASE 3: Continuation DOWN (DOWN shock maintained)
    {
        console.info("Testing REPLAY CASE 3: Continuation DOWN...");
        clearGlobalShockStates("BTCUSDT");

        globalShockStates.set("BTCUSDT", {
            activeDirection: "DOWN",
            rawDirection: "DOWN",
            candidateDirection: "DOWN",
            candidateCount: 2,
            neutralCount: 0,
            candidateStartedAt: 1000,
            activatedAt: 1000,
            lastChangedAt: 1000,
            rawMovePct: 0.003,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastProcessedCycle: 1
        } as any);

        // Feed continuing red candles
        const continuationCandles = createCandles([77600, 77550, 77480]);
        const input = buildBaseEngineInput({
            candles: continuationCandles,
            snapshot: {
                symbol: "BTCUSDT",
                lastPrice: 77480,
                boxHigh: 78100,
                boxLow: 77500,
                boxPos: 0.0,
                ema20: 77580,
                candles: continuationCandles
            } as any,
            now: 2000
        });

        const derived = deriveV2StateAuthority(input);
        assertEq(derived.directionalShockState, "DOWN", "REPLAY CASE 3: Continuation down candles must keep DOWN shock active");
    }

    // REPLAY CASE 4: 07:57 V-Rebound (Bullish reclaim -> early decay to NONE, no direct flip)
    {
        console.info("Testing REPLAY CASE 4: 07:57 V-Rebound...");
        clearGlobalShockStates("BTCUSDT");

        globalShockStates.set("BTCUSDT", {
            activeDirection: "DOWN",
            rawDirection: "DOWN",
            candidateDirection: "DOWN",
            candidateCount: 2,
            neutralCount: 0,
            candidateStartedAt: 1000,
            activatedAt: 1000,
            lastChangedAt: 1000,
            rawMovePct: 0.004,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastProcessedCycle: 1
        } as any);

        // Sudden sharp V-reversal from 77560 to 77650
        const vReversalCandles = createCandles([77560, 77600, 77680]);
        const input = buildBaseEngineInput({
            candles: vReversalCandles,
            snapshot: {
                symbol: "BTCUSDT",
                lastPrice: 77680,
                boxHigh: 78100,
                boxLow: 77590,
                boxPos: 0.18,
                ema20: 77620,
                candles: vReversalCandles
            } as any,
            now: 2000
        });

        const derived = deriveV2StateAuthority(input);
        assertEq(derived.directionalShockState, "NONE", "REPLAY CASE 4: V-Rebound should decay DOWN shock to NONE");
        assertFalse(derived.directionalShockState === "UP", "REPLAY CASE 4: No direct flip to UP shock");
    }

    // =========================================================================
    // 3. INTEGRATION SAFETY AUDITS (A ~ G)
    // =========================================================================

    // SAFETY A: 2 opposite 1m candles but NO structural reclaim -> decay prohibited
    {
        console.info("Testing SAFETY A: 2 opposite 1m but no structural reclaim...");
        clearGlobalShockStates("BTCUSDT");
        globalShockStates.set("BTCUSDT", {
            activeDirection: "DOWN",
            rawDirection: "DOWN",
            candidateDirection: "DOWN",
            candidateCount: 2,
            neutralCount: 0,
            candidateStartedAt: 1000,
            activatedAt: 1000,
            lastChangedAt: 1000,
            rawMovePct: 0.003,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastProcessedCycle: 1
        } as any);

        const weakGreenCandles = createCandles([77200, 77230, 77260]);
        const input = buildBaseEngineInput({
            candles: weakGreenCandles,
            snapshot: {
                symbol: "BTCUSDT",
                lastPrice: 77260,
                boxHigh: 78100,
                boxLow: 77590,
                boxPos: 0.0,
                ema20: 77400,
                candles: weakGreenCandles
            } as any,
            now: 2000
        });
        const derived = deriveV2StateAuthority(input);
        assertEq(derived.directionalShockState, "DOWN", "SAFETY A: Weak green candles below structural levels must NOT decay DOWN shock");
    }

    // SAFETY B: Structural reclaim present but closed 1m count < 2 -> decay prohibited
    {
        console.info("Testing SAFETY B: Structural reclaim but closed 1m count < 2...");
        clearGlobalShockStates("BTCUSDT");
        globalShockStates.set("BTCUSDT", {
            activeDirection: "DOWN",
            rawDirection: "DOWN",
            candidateDirection: "DOWN",
            candidateCount: 2,
            neutralCount: 0,
            candidateStartedAt: 1000,
            activatedAt: 1000,
            lastChangedAt: 1000,
            rawMovePct: 0.003,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastProcessedCycle: 1
        } as any);

        const mixedCandles = createCandles([77550, 77480, 77620]); // c1 red (77550->77480), c2 green (77480->77620)
        const input = buildBaseEngineInput({
            candles: mixedCandles,
            snapshot: {
                symbol: "BTCUSDT",
                lastPrice: 77620,
                boxHigh: 78100,
                boxLow: 77590,
                boxPos: 0.1,
                ema20: 77550,
                candles: mixedCandles
            } as any,
            now: 2000
        });
        const derived = deriveV2StateAuthority(input);
        assertEq(derived.directionalShockState, "DOWN", "SAFETY B: Only 1 closed green candle must NOT decay DOWN shock");
    }

    // SAFETY C: Real HTF HOLD exists -> shock decay happens, but real HTF HOLD is preserved
    {
        console.info("Testing SAFETY C: Real HTF HOLD preserved after shock decay...");
        clearGlobalShockStates("BTCUSDT");
        globalShockStates.set("BTCUSDT", {
            activeDirection: "DOWN",
            rawDirection: "DOWN",
            candidateDirection: "DOWN",
            candidateCount: 2,
            neutralCount: 0,
            candidateStartedAt: 1000,
            activatedAt: 1000,
            lastChangedAt: 1000,
            rawMovePct: 0.003,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastProcessedCycle: 1
        } as any);

        const bullishCandles = createCandles([77500, 77550, 77620]);
        // Construct real HTF conflict: 5M BEARISH (falling closes) + 15M/1H BULLISH (rising closes)
        const bearish5mCloses: number[] = [];
        for (let i = 0; i < 65; i++) bearish5mCloses.push(79000 - i * 30);
        const bearish5m = createCandles(bearish5mCloses);

        const bullish15mCloses: number[] = [];
        for (let i = 0; i < 65; i++) bullish15mCloses.push(75000 + i * 40);
        const bullish15m = createCandles(bullish15mCloses);

        const input = buildBaseEngineInput({
            candles: bullishCandles,
            htf_candles: {
                "5m": bearish5m,
                "15m": bullish15m,
                "1h": bullish15m,
                "4h": bullish15m,
                "1d": bullish15m
            },
            snapshot: {
                symbol: "BTCUSDT",
                lastPrice: 77620,
                boxHigh: 78100,
                boxLow: 77590,
                boxPos: 0.15,
                ema20: 77580,
                candles: bullishCandles,
                canonicalRegime: "RANGE",
                rangeConfidence: 0.7,
                data_ready: true
            } as any,
            now: 2000
        });

        const derived = deriveV2StateAuthority(input);
        input.state.directionalShockState = derived.directionalShockState;
        const judgment = detectMarketRegime(input);
        // Shock decayed from DOWN to NONE
        assertEq(judgment.shockPhase, "NONE", "SAFETY C: shockPhase should be NONE");
        // Real HTF conflict policy should remain HOLD or PROBE_ONLY as dictated by genuine HTF
        assertTrue(judgment.htf_entry_policy === "HOLD" || judgment.htf_entry_policy === "PROBE_ONLY", "SAFETY C: Genuine HTF conflict preserved");
    }

    // SAFETY D: Stale shock-derived polarity HOLD is released when shock decays
    {
        console.info("Testing SAFETY D: Stale shock-derived polarity HOLD released...");
        clearGlobalShockStates("BTCUSDT");
        globalShockStates.set("BTCUSDT", {
            activeDirection: "DOWN",
            rawDirection: "DOWN",
            candidateDirection: "DOWN",
            candidateCount: 2,
            neutralCount: 0,
            candidateStartedAt: 1000,
            activatedAt: 1000,
            lastChangedAt: 1000,
            rawMovePct: 0.003,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastProcessedCycle: 1
        } as any);

        const bullishCandles = createCandles([77500, 77550, 77650]);
        // All macro timeframes are cleanly BULLISH
        const bullishHtfCloses: number[] = [];
        for (let i = 0; i < 65; i++) bullishHtfCloses.push(75000 + i * 40);
        const bullishHtf = createCandles(bullishHtfCloses);

        const input = buildBaseEngineInput({
            candles: bullishCandles,
            htf_candles: {
                "5m": bullishHtf,
                "15m": bullishHtf,
                "1h": bullishHtf,
                "4h": bullishHtf,
                "1d": bullishHtf
            },
            snapshot: {
                symbol: "BTCUSDT",
                lastPrice: 77650,
                boxHigh: 78100,
                boxLow: 77590,
                boxPos: 0.18,
                ema20: 77580,
                candles: bullishCandles,
                canonicalRegime: "RANGE",
                rangeConfidence: 0.7,
                data_ready: true
            } as any,
            now: 2000
        });

        const derived = deriveV2StateAuthority(input);
        input.state.directionalShockState = derived.directionalShockState;
        const judgment = detectMarketRegime(input);
        assertEq(judgment.shockPhase, "NONE", "SAFETY D: shockPhase is NONE");
        // Stale polarity mismatch HOLD is released, HTF entry policy returns to ALLOW
        assertEq(judgment.htf_entry_policy, "ALLOW", "SAFETY D: HTF entry policy returns to ALLOW when shock decays");
    }

    console.info(JSON.stringify({
        event: "V2_SHOCK_DECAY_SUITE_PASS",
        tests_passed: [
            "UNIT_EVALUATE_STRUCTURAL_RECLAIM_DECAY",
            "REPLAY_CASE_1_PEAK_EARLY_DECAY",
            "REPLAY_CASE_2_LOW_EARLY_DECAY",
            "REPLAY_CASE_3_CONTINUATION_PRESERVED",
            "REPLAY_CASE_4_V_REBOUND_EARLY_DECAY",
            "SAFETY_A_NO_RECLAIM_PRESERVES_SHOCK",
            "SAFETY_B_INSUFFICIENT_1M_PRESERVES_SHOCK",
            "SAFETY_C_REAL_HTF_HOLD_PRESERVED",
            "SAFETY_D_STALE_POLARITY_HOLD_RELEASED"
        ]
    }));
}

runShockDecayTests();
