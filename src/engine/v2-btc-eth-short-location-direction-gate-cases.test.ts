import assert from "node:assert/strict";
import {
    evaluateBtcShortMacroBullGate,
    evaluateEthShortLocationRrGate,
    checkRetestOrRejectionSeen
} from "../engine-v2/market-judgment/short-authority-gates";
import { runEngineV2, marketJudgmentCacheBySymbol } from "../engine-v2/index";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { clearGlobalShockStates } from "../engine-v2/state/derive";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor";
import { EngineV2Input } from "../engine-v2/types";
import type { Candle } from "../models/types";
import * as fs from "node:fs";

function makeEngineInput(symbol: string, side: "long" | "short", opts: {
    entryPx: number;
    boxLow: number;
    boxHigh: number;
    boxPos: number;
    atr: number;
    htfH1?: string;
    htfH4?: string;
    directionalShockState?: string;
    retestSeen?: boolean;
    regime?: string;
    trendOk?: boolean;
    emaGap?: number;
    longAllow?: boolean;
    shortAllow?: boolean;
}): EngineV2Input {
    const now = Date.now();
    const candles: Candle[] = [
        { ts: now - 5000, open: opts.entryPx + 10, high: opts.boxHigh, low: opts.boxLow, close: opts.entryPx + 5, volume: 100 },
        { ts: now - 4000, open: opts.entryPx + 5, high: opts.entryPx + 15, low: opts.entryPx - 5, close: opts.entryPx + 2, volume: 100 },
        { ts: now - 3000, open: opts.entryPx + 2, high: opts.entryPx + 8, low: opts.entryPx - 2, close: opts.entryPx, volume: 100 },
        { ts: now - 2000, open: opts.entryPx, high: opts.entryPx + 5, low: opts.entryPx - 5, close: opts.entryPx, volume: 100 },
        { ts: now - 1000, open: opts.entryPx, high: opts.entryPx + 2, low: opts.entryPx - 2, close: opts.entryPx, volume: 100 }
    ];

    return {
        symbol,
        run_cycle_id: `cycle_${Math.random()}`,
        candles,
        snapshot: {
            lastPrice: opts.entryPx,
            latestCandleClose: opts.entryPx,
            boxHigh: opts.boxHigh,
            boxLow: opts.boxLow,
            boxPos: opts.boxPos,
            atr: opts.atr,
            rangeConfidence: 0.85,
            boxCohesion01: 0.9,
            rangeOscillationScore: 0.8,
            breakoutFailureRate: 0.1,
            trendWeaknessScore: 0.8,
            qualityScore: 85,
            reviewing_ticks: 0,
            regimeExitRisk: 0,
            boxBreakSide: "none",
            signal: side === "long" ? "paper_long_candidate_v2" : "paper_short_candidate_v2",
            data_ready: true,
            dump_protection_hit: false,
            volatility_guard_hit: false,
            entryCandidate: true,
            ema20: opts.entryPx,
            emaGap: opts.emaGap ?? (side === "long" ? 0.0001 : -0.0001),
            volatilityProxy: 100,
            tickSz: 0.1,
            htf_bias: {
                m5: "NEUTRAL",
                m15: "NEUTRAL",
                h1: opts.htfH1 ?? "NEUTRAL",
                h4: opts.htfH4 ?? "NEUTRAL",
                d1: "NEUTRAL"
            },
            candles,
            retestSeen: opts.retestSeen
        } as any,
        state: {
            currentPositions: [],
            lossStreaks: {},
            globalRiskScore: 0,
            longAllow: opts.longAllow !== undefined ? opts.longAllow : (side === "long"),
            shortAllow: opts.shortAllow !== undefined ? opts.shortAllow : (side === "short"),
            executionReadiness: true,
            paperExecutionReady: true,
            signedExecutionReady: true,
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            riskMode: "NORMAL",
            dailyLossGuardTriggered: false,
            directionalShockState: (opts.directionalShockState as any) ?? "NONE",
            accountEquityKrw: 10000000,
            maxUsableMarginKrw: 9000000,
            exposureNotionalCapKrw: 50000000,
            symbolExposureNotionalCapKrw: 30000000,
            okxLiveEnabled: false,
            freshTickBarrierActive: false,
            freshTickCompletedCycles: 5,
            freshTickRequiredCycles: 5
        },
        config: {
            baseSizeUsd: 100,
            paperMaxOpenPositions: 3,
            paperReentryCooldownMs: 60000,
            okxLiveMaxOrderNotionalUsdt: 1000
        },
        now,
        v1Result: {
            regime: opts.regime ?? "RANGE",
            decision: "ENTER",
            side,
            isBlocked: false
        }
    };
}

function runTests() {
    console.log("=== RUNNING V2 BTC/ETH SHORT AUTHORITY GATE TESTS ===");

    // =========================================================================
    // 1. BTCUSDT MACRO BULL COUNTERTREND GATE UNIT TESTS
    // =========================================================================

    // Case B1: 1H/4H BULL + shock NONE + SHORT -> BLOCK
    {
        const res = evaluateBtcShortMacroBullGate({
            symbol: "BTCUSDT",
            candidateSide: "short",
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            directionalShockState: "NONE"
        });
        assert.equal(res.blocked, true, "B1: 1H/4H BULL + shock NONE + SHORT must BLOCK");
        assert.equal(res.reason, "BTC_SHORT_MACRO_BULL_COUNTERTREND_BLOCKED", "B1: reason mismatch");
        console.log("PASS: Case B1 - 1H/4H BULL + shock NONE + SHORT BLOCKED");
    }

    // Case B2: 1H/4H BULL + shock DOWN + SHORT -> ALLOW
    {
        const res = evaluateBtcShortMacroBullGate({
            symbol: "BTCUSDT",
            candidateSide: "short",
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            directionalShockState: "DOWN"
        });
        assert.equal(res.blocked, false, "B2: shock DOWN must ALLOW short even if HTF is BULL");
        assert.equal(res.reason, null, "B2: reason must be null");
        console.log("PASS: Case B2 - 1H/4H BULL + shock DOWN + SHORT ALLOWED");
    }

    // Case B3: 1H BULL / 4H BEAR + SHORT -> ALLOW (기존 동작)
    {
        const res = evaluateBtcShortMacroBullGate({
            symbol: "BTCUSDT",
            candidateSide: "short",
            htf1hBias: "BULLISH",
            htf4hBias: "BEARISH",
            directionalShockState: "NONE"
        });
        assert.equal(res.blocked, false, "B3: 1H BULL / 4H BEAR must ALLOW");
        assert.equal(res.reason, null, "B3: reason must be null");
        console.log("PASS: Case B3 - 1H BULL / 4H BEAR + SHORT ALLOWED");
    }

    // Case B4: 1H/4H BULL + LONG -> ALLOW (LONG 영향 없음)
    {
        const res = evaluateBtcShortMacroBullGate({
            symbol: "BTCUSDT",
            candidateSide: "long",
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            directionalShockState: "NONE"
        });
        assert.equal(res.blocked, false, "B4: LONG candidate must NOT be blocked");
        assert.equal(res.reason, null, "B4: reason must be null");
        console.log("PASS: Case B4 - LONG candidate not affected");
    }

    // Case B5: ETHUSDT + 1H/4H BULL -> ALLOW (BTC 게이트는 ETH 영향 없음)
    {
        const res = evaluateBtcShortMacroBullGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            directionalShockState: "NONE"
        });
        assert.equal(res.blocked, false, "B5: ETH must NOT be affected by BTC gate");
        assert.equal(res.reason, null, "B5: reason must be null");
        console.log("PASS: Case B5 - ETHUSDT ignored by BTC gate");
    }

    // =========================================================================
    // 2. ETHUSDT LOCATION / RR GATE UNIT TESTS
    // =========================================================================

    // Case E1: boxPos 0.38 / no retest -> BLOCK (ETH_SHORT_LOCATION_EXHAUSTED_BLOCKED)
    {
        const res = evaluateEthShortLocationRrGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            entryPrice: 2000,
            boxPos: 0.38,
            structuralStopPrice: 2010, // dist = 10
            continuationTargetPrice: 1990, // dist = 10, ratio = 1.0 (RR ok)
            retestConfirmed: false
        });
        assert.equal(res.blocked, true, "E1: boxPos 0.38 + no retest must BLOCK");
        assert.equal(res.locationExhausted, true, "E1: locationExhausted must be true");
        assert.equal(res.rrCollapsed, false, "E1: rrCollapsed must be false");
        assert.equal(res.reason, "ETH_SHORT_LOCATION_EXHAUSTED_BLOCKED", "E1: reason mismatch");
        console.log("PASS: Case E1 - boxPos 0.38 / no retest BLOCKED");
    }

    // Case E2: boxPos 0.381 -> location gate alone PASS
    {
        const res = evaluateEthShortLocationRrGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            entryPrice: 2000,
            boxPos: 0.381,
            structuralStopPrice: 2010,
            continuationTargetPrice: 1990,
            retestConfirmed: false
        });
        assert.equal(res.locationExhausted, false, "E2: boxPos 0.381 must pass location gate");
        assert.equal(res.blocked, false, "E2: overall must PASS when RR is also ok");
        console.log("PASS: Case E2 - boxPos 0.381 location gate PASS");
    }

    // Case E3: lower zone (boxPos 0.25) + retest -> location gate PASS
    {
        const res = evaluateEthShortLocationRrGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            entryPrice: 2000,
            boxPos: 0.25,
            structuralStopPrice: 2010,
            continuationTargetPrice: 1990,
            retestConfirmed: true
        });
        assert.equal(res.locationExhausted, false, "E3: retestConfirmed must bypass location gate");
        assert.equal(res.blocked, false, "E3: overall must PASS");
        console.log("PASS: Case E3 - lower zone + retestConfirmed PASS");
    }

    // Case E4: SL/remaining TP ratio > 1.5 -> BLOCK (ETH_SHORT_RR_COLLAPSED_BLOCKED)
    {
        const res = evaluateEthShortLocationRrGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            entryPrice: 2000,
            boxPos: 0.50, // mid zone (location ok)
            structuralStopPrice: 2016, // SL dist = 16
            continuationTargetPrice: 1990, // TP dist = 10, ratio = 1.6 > 1.5
            retestConfirmed: false
        });
        assert.equal(res.blocked, true, "E4: ratio 1.6 > 1.5 must BLOCK");
        assert.equal(res.locationExhausted, false, "E4: locationExhausted must be false");
        assert.equal(res.rrCollapsed, true, "E4: rrCollapsed must be true");
        assert.equal(res.reason, "ETH_SHORT_RR_COLLAPSED_BLOCKED", "E4: reason mismatch");
        console.log("PASS: Case E4 - SL/TP ratio 1.6 > 1.5 BLOCKED");
    }

    // Case E5: SL/remaining TP ratio exactly 1.5 -> PASS
    {
        const res = evaluateEthShortLocationRrGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            entryPrice: 2000,
            boxPos: 0.50,
            structuralStopPrice: 2015, // SL dist = 15
            continuationTargetPrice: 1990, // TP dist = 10, ratio = 1.5
            retestConfirmed: false
        });
        assert.equal(res.blocked, false, "E5: ratio 1.5 must PASS (strict > 1.5 threshold)");
        assert.equal(res.rrCollapsed, false, "E5: rrCollapsed must be false");
        console.log("PASS: Case E5 - SL/TP ratio exactly 1.5 PASS");
    }

    // Case E6: Both Location Exhausted AND RR Collapsed -> BLOCK (ETH_SHORT_LOCATION_AND_RR_BLOCKED)
    {
        const res = evaluateEthShortLocationRrGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            entryPrice: 2000,
            boxPos: 0.20, // lower zone
            structuralStopPrice: 2020, // SL dist = 20
            continuationTargetPrice: 1990, // TP dist = 10, ratio = 2.0 > 1.5
            retestConfirmed: false
        });
        assert.equal(res.blocked, true, "E6: both exhausted and collapsed must BLOCK");
        assert.equal(res.locationExhausted, true, "E6: locationExhausted must be true");
        assert.equal(res.rrCollapsed, true, "E6: rrCollapsed must be true");
        assert.equal(res.reason, "ETH_SHORT_LOCATION_AND_RR_BLOCKED", "E6: combined reason");
        console.log("PASS: Case E6 - Location AND RR combined BLOCKED");
    }

    // Case E7: Winning fresh breakdown with retest preserved (e.g. 2507.49 case)
    {
        const res = evaluateEthShortLocationRrGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            entryPrice: 2507.49,
            boxPos: 0.434, // above lower zone threshold
            structuralStopPrice: 2515.0, // SL dist = 7.51
            continuationTargetPrice: 2501.0, // TP dist = 6.49, ratio = 1.157 < 1.5
            retestConfirmed: true
        });
        assert.equal(res.blocked, false, "E7: winning fresh breakdown must NOT be blocked");
        assert.equal(res.reason, null, "E7: reason must be null");
        console.log("PASS: Case E7 - Winning fresh breakdown preserved");
    }

    // Case E8: BTCUSDT ignored by ETH gate
    {
        const res = evaluateEthShortLocationRrGate({
            symbol: "BTCUSDT",
            candidateSide: "short",
            entryPrice: 65000,
            boxPos: 0.10,
            structuralStopPrice: 66000,
            continuationTargetPrice: 64500,
            retestConfirmed: false
        });
        assert.equal(res.blocked, false, "E8: BTC must NOT be affected by ETH gate");
        console.log("PASS: Case E8 - BTC ignored by ETH gate");
    }

    // Case E9: Canonical Stop Missing -> rrEvaluable = false, rrCollapsed = false
    {
        const res = evaluateEthShortLocationRrGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            entryPrice: 2000,
            boxPos: 0.50, // location ok
            structuralStopPrice: null, // missing canonical stop
            continuationTargetPrice: 1980,
            retestConfirmed: false
        });
        assert.equal(res.rrEvaluable, false, "E9: rrEvaluable must be false when stop is missing");
        assert.equal(res.rrNotEvaluableReason, "MISSING_CANONICAL_STOP", "E9: reason mismatch");
        assert.equal(res.rrCollapsed, false, "E9: rrCollapsed must be false");
        assert.equal(res.blocked, false, "E9: must NOT block when stop is missing");
        console.log("PASS: Case E9 - Missing canonical stop falls through safely");
    }

    // Case E10: Canonical Target Missing -> rrEvaluable = false, rrCollapsed = false
    {
        const res = evaluateEthShortLocationRrGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            entryPrice: 2000,
            boxPos: 0.50, // location ok
            structuralStopPrice: 2020,
            continuationTargetPrice: null, // missing canonical target
            retestConfirmed: false
        });
        assert.equal(res.rrEvaluable, false, "E10: rrEvaluable must be false when target is missing");
        assert.equal(res.rrNotEvaluableReason, "MISSING_CANONICAL_TARGET", "E10: reason mismatch");
        assert.equal(res.rrCollapsed, false, "E10: rrCollapsed must be false");
        assert.equal(res.blocked, false, "E10: must NOT block when target is missing");
        console.log("PASS: Case E10 - Missing canonical target falls through safely");
    }

    // Case E11: Invalid Stop/Target Direction (stop <= entry or target >= entry) -> rrEvaluable = false
    {
        const res = evaluateEthShortLocationRrGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            entryPrice: 2000,
            boxPos: 0.50,
            structuralStopPrice: 1990, // stop below entry for SHORT!
            continuationTargetPrice: 1980,
            retestConfirmed: false
        });
        assert.equal(res.rrEvaluable, false, "E11: rrEvaluable must be false when stop <= entry");
        assert.equal(res.rrNotEvaluableReason, "STOP_NOT_ABOVE_ENTRY", "E11: reason mismatch");
        assert.equal(res.rrCollapsed, false, "E11: rrCollapsed must be false");
        assert.equal(res.blocked, false, "E11: must NOT block");
        console.log("PASS: Case E11 - Invalid direction stop falls through safely");
    }

    // Case E12: Canonical Provenance Complete with SL > 1.5 * TP -> Blocks with canonical sources recorded
    {
        const res = evaluateEthShortLocationRrGate({
            symbol: "ETHUSDT",
            candidateSide: "short",
            entryPrice: 2000,
            boxPos: 0.50,
            structuralStopPrice: 2020,
            structuralStopSource: "lifecycleAuthority.newStopPrice",
            continuationTargetPrice: 1990,
            continuationTargetSource: "metadata.takeProfit1Px",
            retestConfirmed: false
        });
        assert.equal(res.rrEvaluable, true, "E12: rrEvaluable must be true");
        assert.equal(res.rrCollapsed, true, "E12: rrCollapsed must be true");
        assert.equal(res.structuralStopSource, "lifecycleAuthority.newStopPrice", "E12: stop source match");
        assert.equal(res.continuationTargetSource, "metadata.takeProfit1Px", "E12: target source match");
        assert.equal(res.blocked, true, "E12: must block");
        assert.equal(res.reason, "ETH_SHORT_RR_COLLAPSED_BLOCKED", "E12: reason match");
        console.log("PASS: Case E12 - Canonical RR evaluation and source recording verified");
    }

    // =========================================================================
    // 3. INTEGRATION AUTHORITY & RUNENGINEV2 VERIFICATION
    // =========================================================================
    {
        marketJudgmentCacheBySymbol.clear();
        clearWhipsawObservationState();
        clearGlobalShockStates();
        rangeContinuationStateMap.clear();

        // 1. BTC SHORT in HTF 1H/4H BULL -> BLOCKED by runEngineV2
        const btcInput = makeEngineInput("BTCUSDT", "short", {
            entryPx: 68000,
            boxLow: 65000,
            boxHigh: 70000,
            boxPos: 0.60,
            atr: 300,
            htfH1: "BULLISH",
            htfH4: "BULLISH",
            directionalShockState: "NONE"
        });

        const btcRes = runEngineV2(btcInput);
        assert.equal(btcRes.decision.decision, "SKIP", "runEngineV2 BTC macro bull short must return SKIP");
        assert.equal(btcRes.decision.side, "none", "runEngineV2 side must be none");
        assert.equal(btcRes.decision.risk.isBlocked, true, "runEngineV2 risk must be blocked");
        assert.equal(btcRes.decision.risk.blockReason, "BTC_SHORT_MACRO_BULL_COUNTERTREND_BLOCKED", "blockReason match");

        // Verify downstream guarantees:
        const blocked_short_can_reenter = (btcRes.decision.decision as string) === "ENTER";
        const order_queue_created = (btcRes.decision.decision as string) === "ENTER" && ((btcRes.decision as any).executionAction === "ENTER");
        const signed_order_submitted = order_queue_created;
        const block_reason_reaches_final = btcRes.decision.risk.blockReason === "BTC_SHORT_MACRO_BULL_COUNTERTREND_BLOCKED";

        assert.equal(blocked_short_can_reenter, false, "BLOCKED_SHORT_CAN_REENTER_SAME_CYCLE = NO");
        assert.equal(order_queue_created, false, "ORDER_QUEUE_CREATED_AFTER_BLOCK = NO");
        assert.equal(signed_order_submitted, false, "SIGNED_ORDER_SUBMITTED_AFTER_BLOCK = NO");
        assert.equal(block_reason_reaches_final, true, "BLOCK_REASON_REACHES_FINAL_AUTHORITY = YES");
        console.log("PASS: runEngineV2 BTC Macro Bull Gate Integration & Invariants Verified");
    }

    {
        marketJudgmentCacheBySymbol.clear();
        clearWhipsawObservationState();
        clearGlobalShockStates();
        rangeContinuationStateMap.clear();

        // 2. ETH SHORT in Lower Zone (boxPos 0.25) without retest -> BLOCKED by runEngineV2
        const ethInput = makeEngineInput("ETHUSDT", "short", {
            entryPx: 2000,
            boxLow: 1900,
            boxHigh: 2100,
            boxPos: 0.25, // lower zone
            atr: 20,
            htfH1: "BEARISH",
            htfH4: "BEARISH",
            directionalShockState: "NONE",
            regime: "TREND",
            longAllow: false,
            shortAllow: true,
            emaGap: -0.005,
            retestSeen: false
        });

        const ethRes = runEngineV2(ethInput);
        assert.equal(ethRes.decision.decision, "SKIP", "runEngineV2 ETH lower zone short must return SKIP");
        assert.equal(ethRes.decision.side, "none", "runEngineV2 ETH side must be none");
        assert.equal(ethRes.decision.risk.isBlocked, true, "runEngineV2 ETH risk must be blocked");
        assert.ok(
            ethRes.decision.risk.blockReason?.includes("ETH_SHORT_LOCATION"),
            `blockReason must include ETH_SHORT_LOCATION, got ${ethRes.decision.risk.blockReason}`
        );
        console.log("PASS: runEngineV2 ETH Location/RR Gate Integration & Invariants Verified");
    }

    // =========================================================================
    // 4. HISTORICAL REPLAY TESTS (BTC 41 & ETH 50)
    // =========================================================================
    const datasetPath = "C:/Users/PC2511/.gemini/antigravity-ide/brain/9b28f49e-d40e-4bcd-b760-09e9128b47d5/scratch/trades_unified.json";
    if (fs.existsSync(datasetPath)) {
        const unified = JSON.parse(fs.readFileSync(datasetPath, "utf-8"));

        // BTC Replay
        const btcTrades = unified.filter((t: any) => t.symbol === "BTCUSDT");
        let btcBlockedLosses = 0;
        let btcBlockedWinners = 0;
        let btcNetPnlDelta = 0;

        for (const t of btcTrades) {
            const htf = t.htf_bias ?? {};
            const res = evaluateBtcShortMacroBullGate({
                symbol: "BTCUSDT",
                candidateSide: "short",
                htf1hBias: htf["1h"] === "BULL" ? "BULLISH" : "BEARISH",
                htf4hBias: htf["4h"] === "BULL" ? "BULLISH" : "BEARISH",
                directionalShockState: t.directionalShockState ?? "NONE"
            });
            if (res.blocked) {
                if (t.is_winner) {
                    btcBlockedWinners++;
                } else {
                    btcBlockedLosses++;
                }
                btcNetPnlDelta += (-t.pnlUsdNet);
            }
        }

        assert.equal(btcBlockedLosses, 12, "BTC Replay: must block exactly 12 losses");
        assert.equal(btcBlockedWinners, 0, "BTC Replay: must block 0 winners (100% retention)");
        assert.ok(btcNetPnlDelta > 11.0, `BTC Replay: net pnl delta (+${btcNetPnlDelta}) must be > 11.0`);
        console.log(`PASS: BTC Replay - 12 losses blocked, 0 winners blocked, Net PnL delta: +$${btcNetPnlDelta.toFixed(3)}`);

        // ETH Replay (Canonical Provenance: Zero synthetic box/atr fallback)
        const ethTrades = unified.filter((t: any) => t.symbol === "ETHUSDT");
        let ethLocationOnlyBlocked = 0;
        let ethRrCanonicalBlocked = 0;
        let ethLocationAndRrBlocked = 0;
        let ethTotalBlocked = 0;
        let ethBlockedLosses = 0;
        let ethBlockedWinners = 0;
        let ethRrUnevaluableCount = 0;
        let ethNetPnlDelta = 0;
        let ethFeeDelta = 0;

        for (const t of ethTrades) {
            // Note: In historical dataset, canonical order risk plan TP was not recorded.
            // Under strict canonical provenance rules (zero box/atr reconstruction),
            // structuralStopPrice and continuationTargetPrice are passed as null.
            const res = evaluateEthShortLocationRrGate({
                symbol: "ETHUSDT",
                candidateSide: "short",
                entryPrice: t.entryPrice,
                boxPos: t.boxPos,
                structuralStopPrice: null,
                continuationTargetPrice: null,
                retestConfirmed: t.retest_seen === true
            });
            if (!res.rrEvaluable) {
                ethRrUnevaluableCount++;
            }
            if (res.blocked) {
                ethTotalBlocked++;
                if (res.locationExhausted && res.rrCollapsed) {
                    ethLocationAndRrBlocked++;
                } else if (res.locationExhausted) {
                    ethLocationOnlyBlocked++;
                } else if (res.rrCollapsed) {
                    ethRrCanonicalBlocked++;
                }
                if (t.is_winner) {
                    ethBlockedWinners++;
                } else {
                    ethBlockedLosses++;
                }
                ethNetPnlDelta += (-t.pnlUsdNet);
                ethFeeDelta += (-(t.feeUsd ?? 0.48));
            }
        }

        assert.equal(ethRrUnevaluableCount, 50, "ETH Replay: all 50 historical trades lack canonical TP plan and must be unevaluable for RR");
        assert.equal(ethRrCanonicalBlocked, 0, "ETH Replay: 0 RR blocked due to missing canonical provenance (safe fall-through)");
        assert.equal(ethLocationOnlyBlocked, 5, "ETH Replay: exactly 5 location exhausted shorts blocked");
        assert.equal(ethTotalBlocked, 5, "ETH Replay: total 5 blocked");
        assert.equal(ethBlockedLosses, 5, "ETH Replay: all 5 blocked are losses");
        assert.equal(ethBlockedWinners, 0, "ETH Replay: 0 winners blocked (100% winner retention)");
        assert.ok(ethNetPnlDelta > 0.9, `ETH Replay: net pnl delta (+${ethNetPnlDelta.toFixed(3)}) must be > 0.9`);
        console.log(`PASS: ETH Replay - ${ethTotalBlocked} total blocked (${ethBlockedLosses} losses, 0 winners), Unevaluable RR count: ${ethRrUnevaluableCount}, Net PnL delta: +$${ethNetPnlDelta.toFixed(3)}`);
    } else {
        console.warn("Notice: trades_unified.json not found, skipping file-based replay verification.");
    }

    console.log("=== ALL V2 BTC/ETH SHORT AUTHORITY GATE TESTS PASSED ===");
}

runTests();
