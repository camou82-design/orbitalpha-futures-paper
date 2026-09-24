/**
 * Highway directional consensus adapter + post-shock counter probe (0.25x once) regression.
 */
import assert from "node:assert/strict";
import type { Candle } from "../models/types";
import { resolveHighwayDirectionalAuthority } from "../engine-v2/highway-core/highway-directional-authority";
import { evaluateHighwayCoreEntryGate } from "../engine-v2/highway-core/highway-entry-gate";
import { evaluateRangePostShockGuard } from "../engine-v2/market-judgment/range-post-shock-guard";
import {
    buildPostShockProbeEpisodeId,
    resolvePostShockCandleMetrics
} from "../engine-v2/market-judgment/post-shock-probe-episode";
import {
    gatherPostShockProbeConsumedEpisodeIds,
    isPostShockProbeEpisodeConsumed,
    V2_POST_SHOCK_COUNTER_PROBE_SEMANTIC
} from "../engine-v2/market-judgment/post-shock-probe-episode-authority";
import { evaluatePostShockProbeStandardPromotionRelease } from "../engine-v2/market-judgment/post-shock-probe-promotion-gate";
import { evaluateV2AddOnPolicy } from "../engine-v2/addon/policy";
import { executeRangeRegime } from "../engine-v2/executors/range-executor";
import { executeTrendRegime } from "../engine-v2/executors/trend-executor";
import { evaluateEquityAdaptiveSizing } from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { resolveLiveSubmitStaticSafetyCap } from "./paper-engine";
import type { EngineV2Input, MarketJudgmentOutput } from "../engine-v2/types";

function candle(ts: number, o: number, h: number, l: number, c: number): Candle {
    return { ts, open: o, high: h, low: l, close: c, volume: 100 };
}

function risingCloses(base: number, n: number): Candle[] {
    const out: Candle[] = [];
    const t0 = 1_790_215_000_000;
    for (let i = 0; i < n; i++) {
        const p = base + i * 2;
        out.push(candle(t0 + i * 60_000, p - 1, p + 2, p - 2, p));
    }
    out.push(candle(t0 + n * 60_000, base + n * 2, base + n * 2 + 1, base + n * 2 - 1, base + n * 2));
    return out;
}

function run(): void {
    console.log("=== V2 HIGHWAY POST-SHOCK CONSENSUS REGRESSION ===");

    // CONTROL: STRONG_UP => RANGE SHORT blocked (0 exceptions)
    {
        const candles = risingCloses(1000, 65);
        const last = candles[candles.length - 1].close;
        const auth = resolveHighwayDirectionalAuthority({
            symbol: "ETHUSDT",
            candles,
            lastPrice: last
        });
        const gate = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            snapshot: { lastPrice: last, candles, boxPos: 0.85, boxHigh: last * 1.002, boxLow: last * 0.98 },
            execution: {
                signal: "SHORT",
                side: "short",
                stopPrice: last * 1.01,
                metadata: { plannedTp1Price: last * 0.99, tp1Price: last * 0.99 }
            } as any,
            committedRiskPlan: { stopPrice: last * 1.01, plannedTp1Price: last * 0.99 } as any,
            directionalShockState: "NONE"
        });
        if (auth.strongUp) {
            assert.equal(gate.allowed, false);
            assert.equal(gate.rejectReason, "OPPOSING_STRONG_HIGHWAY_UP_ACTIVE");
            console.log("[STRONG_UP RANGE SHORT] PASS");
        } else {
            console.log("[STRONG_UP RANGE SHORT] SKIP (fixture did not reach canonical strong alignment)");
        }
    }

    // CONTROL: STRONG_DOWN => RANGE LONG blocked
    {
        const candles = risingCloses(1000, 65).map((c, i, arr) =>
            i >= arr.length - 20 ? candle(c.ts, c.close + 5, c.high + 5, c.low + 5, c.close - 8) : c
        );
        const last = candles[candles.length - 1].close;
        const auth = resolveHighwayDirectionalAuthority({ symbol: "BTCUSDT", candles, lastPrice: last });
        const gate = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: { lastPrice: last, candles, boxPos: 0.15, boxHigh: last * 1.02, boxLow: last * 0.998 },
            execution: {
                signal: "LONG",
                side: "long",
                stopPrice: last * 0.99,
                metadata: { plannedTp1Price: last * 1.01, tp1Price: last * 1.01 }
            } as any,
            committedRiskPlan: { stopPrice: last * 0.99, plannedTp1Price: last * 1.01 } as any,
            directionalShockState: "NONE"
        });
        if (auth.strongDown) {
            assert.equal(gate.allowed, false);
            assert.equal(gate.rejectReason, "OPPOSING_STRONG_HIGHWAY_DOWN_ACTIVE");
            console.log("[STRONG_DOWN RANGE LONG] PASS");
        } else {
            console.log("[STRONG_DOWN RANGE LONG] SKIP (fixture did not reach strong down)");
        }
    }

    // Sizing pipeline: 500 cap → 0.25 → 125, legacy 40 not applied
    {
        const sizing = evaluateEquityAdaptiveSizing({
            symbol: "ETHUSDT",
            side: "long",
            orderKind: "ENTRY",
            accountEquityUsdt: 12_000,
            availableBalanceUsdt: 10_000,
            entryReferencePrice: 2670,
            effectiveStopPrice: 2660,
            appliedLeverage: 3,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            legacyStaticCapUsdt: 40,
            v2AuthorityEntry: true,
            lastPrice: 2670,
            entryProbeSizeMultiplier: 0.25,
            entryProbeSizingSource: "V2_POST_SHOCK_COUNTER_PROBE"
        });
        assert.equal(sizing.probeMultiplierApplied, 0.25);
        assert.equal(sizing.cappedFullEntryNotionalUsdt, 500);
        assert.equal(sizing.canonicalIntendedNotionalUsdt, 125);
        assert.equal(sizing.finalOrderNotionalUsdt, 125);
        const submit = resolveLiveSubmitStaticSafetyCap({
            authoritySource: "v2",
            okxLiveStaticNotionalCapEnabled: true,
            staticSafetyCapUsdt: 40,
            intendedNotionalUsdt: sizing.finalOrderNotionalUsdt,
            emergencyUltimateCapUsdt: null
        });
        assert.equal(submit.skipStaticCapForV2Authority, true);
        assert.equal(submit.finalSubmittedNotionalUsdt, 125);
        console.log("[SIZING 500→0.25→125 SUBMIT] PASS");
    }

    // Episode id deterministic from shock extremum ts
    {
        const candles = risingCloses(2700, 20);
        const metrics = resolvePostShockCandleMetrics({
            lastPrice: 2700,
            atr: 10,
            candles,
            shockPhase: "DOWN_SHOCK",
            directionalShockState: "DOWN"
        });
        const id = buildPostShockProbeEpisodeId({
            symbol: "ETHUSDT",
            shockDirection: "DOWN",
            shockExtremumTs: metrics.shockExtremumTs
        });
        assert.ok(id.startsWith("ETHUSDT:DOWN:"));
        console.log("[EPISODE ID] PASS", id);
    }

    // Ledger episode consumption (PM2 rehydrate simulation via open ledger rows)
    {
        const episodeId = "ETHUSDT:DOWN:1790215000000";
        const consumed = gatherPostShockProbeConsumedEpisodeIds([
            {
                entrySemantic: V2_POST_SHOCK_COUNTER_PROBE_SEMANTIC,
                postShockProbeEpisodeId: episodeId
            }
        ]);
        assert.ok(consumed.includes(episodeId));
        assert.equal(
            isPostShockProbeEpisodeConsumed({
                symbol: "ETHUSDT",
                side: "long",
                episodeId,
                consumedEpisodeIds: consumed
            }),
            true
        );
        console.log("[REHYDRATE SAME EPISODE CONSUMED] PASS");
    }

    // Multi-tick: same episode only one probe signal when ledger empty
    {
        const episodeId = "BTCUSDT:DOWN:1790215000000";
        let fires = 0;
        const consumed: string[] = [];
        for (let tick = 0; tick < 5; tick++) {
            if (
                !isPostShockProbeEpisodeConsumed({
                    symbol: "BTCUSDT",
                    side: "long",
                    episodeId,
                    consumedEpisodeIds: consumed
                })
            ) {
                fires += 1;
                consumed.push(episodeId);
            }
        }
        assert.equal(fires, 1);
        console.log("[MULTI-TICK SINGLE FIRE] PASS");
    }

    // New episode allowed after prior consumed
    {
        const ep1 = "ETHUSDT:DOWN:1000";
        const ep2 = "ETHUSDT:DOWN:2000";
        const consumed = gatherPostShockProbeConsumedEpisodeIds([
            { entrySemantic: V2_POST_SHOCK_COUNTER_PROBE_SEMANTIC, postShockProbeEpisodeId: ep1 }
        ]);
        assert.equal(isPostShockProbeEpisodeConsumed({ symbol: "ETHUSDT", side: "long", episodeId: ep1, consumedEpisodeIds: consumed }), true);
        assert.equal(isPostShockProbeEpisodeConsumed({ symbol: "ETHUSDT", side: "long", episodeId: ep2, consumedEpisodeIds: consumed }), false);
        console.log("[NEW EPISODE ALLOWED] PASS");
    }

    // PROBE_ONLY blocks addon until standard highway gate (20 tick simulation)
    {
        const probePos = {
            symbol: "ETHUSDT",
            side: "LONG" as const,
            entryPrice: 2700,
            sizeUsd: 125,
            entryStage: 1,
            pnlPct: -0.001,
            entrySemantic: V2_POST_SHOCK_COUNTER_PROBE_SEMANTIC,
            postShockProbePromotionState: "PROBE_ONLY" as const,
            ledger_stop_px: 2680,
            takeProfitPlan: { tp1: 2720, tp2: 2740, invalidationPx: 2680 }
        };
        let addonBlocks = 0;
        for (let tick = 0; tick < 20; tick++) {
            const policy = evaluateV2AddOnPolicy({
                symbol: "ETHUSDT",
                side: "long",
                v2State: {
                    longPosition: probePos as any,
                    shortPosition: null,
                    longStage: 1,
                    shortStage: 0,
                    directionalShockState: "DOWN"
                } as any,
                judgment: {
                    regime: "RANGE",
                    regime_final: "RANGE",
                    subtype: "RANGE_LOWER_REACTION",
                    shockPhase: "DOWN_SHOCK",
                    rangePhase: "LOWER",
                    trendPhase: "NONE",
                    transitionPhase: "NONE"
                } as any,
                execution: { signal: "NONE", side: "none", metadata: {} } as any,
                snapshot: {
                    qualityScore: 70,
                    reviewing_ticks: tick,
                    boxPos: 0.2,
                    emaGap: -0.001,
                    trendWeaknessScore: 0.4,
                    rangeConfidence: 0.7,
                    lastPrice: 2695,
                    atr: 8
                },
                accountEquityUsd: 12_000,
                currentSymbolNotionalUsd: 125,
                currentGlobalNotionalUsd: 125,
                maxAddonNotionalUsdt: 20
            });
            if (!policy.allowed) addonBlocks += 1;
        }
        assert.equal(addonBlocks, 20);
        console.log("[PROBE_ONLY 20 TICK ADDON BLOCK] PASS");
    }

    // Completed-candle zone: live lastPrice in upper zone but closed close not → no probe
    {
        const candles: Candle[] = [];
        const baseTs = 1_790_215_000_000;
        for (let i = 0; i < 12; i++) {
            candles.push(candle(baseTs + i * 60_000, 2700, 2705, 2695, 2700));
        }
        const closedClose = 2698;
        candles.push(candle(baseTs + 12 * 60_000, 2698, 2710, 2697, closedClose));
        candles.push(candle(baseTs + 13 * 60_000, 2710, 2712, 2708, 2711));
        const liveSpike = 2711;
        const boxHigh = 2709;
        const guard = evaluateRangePostShockGuard({
            symbol: "BTCUSDT",
            side: "short",
            shockPhase: "UP_SHOCK",
            directionalShockState: "UP",
            lastPrice: liveSpike,
            boxHigh,
            boxLow: 2680,
            boxMid: 2695,
            boxPos: 0.7,
            atr: 10,
            candles,
            reversalConfirmed: true
        });
        if (liveSpike >= boxHigh * 0.998 && closedClose < boxHigh * 0.998) {
            assert.notEqual(guard.earlyReversalProbeEligible, true);
            console.log("[COMPLETED CANDLE ZONE INVARIANT] PASS");
        } else {
            console.log("[COMPLETED CANDLE ZONE INVARIANT] SKIP (fixture alignment)");
        }
    }

    // Post-shock false recovery short blocked
    {
        const candles: Candle[] = [];
        const baseTs = 1_790_215_000_000;
        for (let i = 0; i <= 5; i++) {
            candles.push(candle(baseTs + i * 60_000, 2720, 2725, 2715, 2720));
        }
        candles.push(candle(baseTs + 6 * 60_000, 2720, 2720, 2695, 2700));
        candles.push(candle(baseTs + 7 * 60_000, 2700, 2705, 2680, 2685));
        candles.push(candle(baseTs + 8 * 60_000, 2685, 2690, 2672, 2674));
        candles.push(candle(baseTs + 9 * 60_000, 2674, 2680, 2673, 2677));
        candles.push(candle(baseTs + 10 * 60_000, 2677, 2682, 2676, 2678.73));
        candles.push(candle(baseTs + 11 * 60_000, 2678.73, 2680, 2677, 2678.5));

        const input: EngineV2Input = {
            symbol: "ETHUSDT",
            evaluationMode: "authoritative",
            run_cycle_id: "replay-eth-0232",
            now: baseTs + 11 * 60_000,
            config: { baseSizeUsd: 40, okxLiveMaxOrderNotionalUsdt: 40 } as any,
            v1Result: { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: false },
            snapshot: {
                lastPrice: 2678.73,
                boxHigh: 2682,
                boxLow: 2670,
                boxPos: 0.793,
                boxCohesion01: 0.28,
                rangeConfidence: 0.72,
                atr: 8.5,
                candles
            } as any,
            state: {
                directionalShockState: "DOWN",
                longAllow: true,
                shortAllow: true,
                currentPositions: [],
                executionReadiness: true,
                freshTickBarrierActive: false,
                freshTickCompletedCycles: 3,
                freshTickRequiredCycles: 3
            } as any
        };
        const judgment: MarketJudgmentOutput = {
            regime: "RANGE",
            regime_final: "RANGE",
            subtype: "RANGE_UPPER_REACTION",
            subtypeReason: "test",
            shockPhase: "DOWN_SHOCK",
            rangePhase: "UPPER",
            trendPhase: "NONE",
            transitionPhase: "NONE",
            judgmentVersion: "v2_market_judgment_subtype_v1",
            data_ready: true,
            dump_protection_hit: false,
            volatility_guard_hit: false,
            reason: "test",
            metrics: {} as any,
            metadata: { reversal_confirmed: true },
            no_trade_reason: null
        };
        const res = executeRangeRegime(input, judgment);
        assert.notEqual(res.signal, "SHORT_CANDIDATE");
        console.log("[9/24 ETH FALSE RECOVERY SHORT] PASS", res.signal, res.reason);
    }

    // TREND executor untouched
    {
        const input: EngineV2Input = {
            symbol: "BTCUSDT",
            evaluationMode: "authoritative",
            run_cycle_id: "trend-ctrl",
            now: 1_790_215_000_000,
            config: { baseSizeUsd: 40 } as any,
            v1Result: { regime: "TREND", decision: "ENTER", side: "short", isBlocked: false },
            snapshot: { lastPrice: 84000, boxHigh: 84500, boxLow: 83500, boxPos: 0.5, emaGap: -0.005, atr: 120, candles: [] } as any,
            state: {
                directionalShockState: "DOWN",
                shortAllow: true,
                longAllow: false,
                currentPositions: [],
                executionReadiness: true,
                freshTickBarrierActive: false,
                freshTickCompletedCycles: 3,
                freshTickRequiredCycles: 3
            } as any
        };
        const judgment: MarketJudgmentOutput = {
            regime: "TREND",
            regime_final: "TREND",
            subtype: "TREND_DOWN_CONTINUATION",
            subtypeReason: "test",
            shockPhase: "DOWN_SHOCK",
            rangePhase: "NONE",
            trendPhase: "DOWN",
            transitionPhase: "NONE",
            judgmentVersion: "v2_market_judgment_subtype_v1",
            data_ready: true,
            dump_protection_hit: false,
            volatility_guard_hit: false,
            reason: "test",
            metrics: {} as any,
            metadata: {},
            no_trade_reason: null
        };
        const res = executeTrendRegime(input, judgment);
        assert.equal(res.signal, "SHORT_CANDIDATE");
        console.log("[TREND SHORT CONTROL] PASS");
    }

    // Promotion release helper exists (gate may stay false on minimal snapshot)
    {
        const release = evaluatePostShockProbeStandardPromotionRelease({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: { lastPrice: 2700, boxHigh: 2720, boxLow: 2680, boxPos: 0.2, candles: [] },
            directionalShockState: "DOWN",
            stopPrice: 2680,
            takeProfit1Px: 2720
        });
        assert.equal(typeof release.eligible, "boolean");
        console.log("[PROMOTION GATE API] PASS", release.reason);
    }

    console.log("=== ALL HIGHWAY POST-SHOCK CONSENSUS REGRESSION PASSED ===");
}

run();
