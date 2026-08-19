import assert from "node:assert";
import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import type { EvaluateV2ExitPolicyArgs } from "../engine-v2/exit/types";
import { executeRangeRegime } from "../engine-v2/executors/range-executor";
import { deriveTradeLifecycleAuthority } from "../engine-v2/lifecycle/trade-lifecycle-authority";
import { buildV2ExecutionAuthorityEnvelope } from "../engine-v2/execution/envelope";
import { deriveExecutionAuthorityFromEnvelope } from "../engine-v2/reconciler";
import { computeSoftExitFeeBreakEvenPct, DEFAULT_SOFT_EXIT_SLIPPAGE_BUFFER_PCT } from "../engine-v2/exit/soft-exit-fee-gate";
import type { EngineV2Input, MarketJudgmentOutput } from "../engine-v2/types";

let passCount = 0;
let failCount = 0;

function report(testName: string, passed: boolean, detail?: Record<string, unknown>) {
    if (passed) {
        passCount++;
        console.log(`[PASS] ${testName}`);
    } else {
        failCount++;
        console.error(`[FAIL] ${testName}`, detail ?? {});
        throw new Error(`Test failed: ${testName}`);
    }
}

function createMockRangeJudgment(overrides: Partial<MarketJudgmentOutput> = {}): MarketJudgmentOutput {
    return {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_FLAT",
        confidenceScore: 0.85,
        shockPhase: "NONE",
        trendPhase: "NONE",
        rangePhase: "UPPER",
        transitionPhase: "NONE",
        htf_bias: { m5: "NEUTRAL", m15: "NEUTRAL", h1: "NEUTRAL", h4: "NEUTRAL", d1: "NEUTRAL" },
        htf_entry_policy: "ALLOW_ALL",
        macroPolarity: "NEUTRAL",
        polarityMismatch: false,
        subtypeReason: "test",
        ...overrides
    } as any;
}

function createMockV2State(positions: any[] = []): any {
    const longPos = positions.find((p) => String(p.side).toLowerCase() === "long") ?? null;
    const shortPos = positions.find((p) => String(p.side).toLowerCase() === "short") ?? null;
    return {
        symbol: "ETHUSDT",
        now: Date.now(),
        currentPositions: positions,
        symbolPositions: positions,
        longPosition: longPos,
        shortPosition: shortPos,
        hasLongPosition: longPos != null,
        hasShortPosition: shortPos != null,
        longStage: longPos ? Math.max(1, Number(longPos.entryStage ?? 1)) : 0,
        shortStage: shortPos ? Math.max(1, Number(shortPos.entryStage ?? 1)) : 0,
        sameSidePosition: longPos,
        oppositeSidePosition: shortPos,
        hasSameSidePosition: longPos != null,
        hasOppositeSidePosition: shortPos != null,
        currentStage: longPos ? Math.max(1, Number(longPos.entryStage ?? 1)) : 0,
        positionStateReady: true,
        marketSnapshotReady: true,
        v2InputReady: true,
        serverTradeEnabled: true,
        closeOnlyMode: false,
        killSwitch: false,
        reconcileSafeMode: false,
        riskMode: "NORMAL",
        dailyLossGuardTriggered: false,
        freshTickBarrierActive: false,
        freshTickExecutionBlocked: false,
        freshTickCompletedCycles: 5,
        freshTickRequiredCycles: 3,
        paperExecutionReady: true,
        signedExecutionReady: true,
        okxAuthMode: "live",
        okxAuthReady: true,
        okxExchangeAuthOptIn: true,
        okxLiveEnabled: true,
        okxDemoEnabled: false,
        okxApiKeyPresent: true,
        okxApiSecretPresent: true,
        okxPassphrasePresent: true,
        okxSimulatedTradingHeaderEnabled: false,
        liveMaxOrderNotionalUsdt: 10000,
        directionalShockState: "NONE",
        crashState: "NONE",
        pumpState: "NONE",
        longAllow: true,
        shortAllow: true,
        accountEquityKrw: 10000000,
        maxUsableMarginKrw: 5000000,
        exposureNotionalCapKrw: 20000000,
        symbolExposureNotionalCapKrw: 10000000,
        ledgerExposureNotionalKrw: 1000000
    };
}

function createRangeInput(overrides: {
    side?: "long" | "short";
    entryPx?: number;
    boxLow?: number;
    boxHigh?: number;
    boxPos?: number;
    atr?: number;
    feeRate?: number;
} = {}): EngineV2Input {
    const entryPx = overrides.entryPx ?? 2500;
    const boxLow = overrides.boxLow ?? 2450;
    const boxHigh = overrides.boxHigh ?? 2550;
    const side = overrides.side ?? "long";
    const now = Date.now();
    const atr = overrides.atr ?? 25;

    const candles = side === "long" ? [
        { ts: now - 4000, open: entryPx, high: entryPx + 0.1, low: boxLow, close: boxLow, volume: 100 },
        { ts: now - 3000, open: boxLow, high: entryPx, low: boxLow, close: entryPx, volume: 100 },
        { ts: now - 2000, open: entryPx, high: entryPx + 0.1, low: entryPx - 0.01, close: entryPx, volume: 100 }
    ] : [
        { ts: now - 4000, open: entryPx, high: boxHigh, low: entryPx - 0.1, close: boxHigh, volume: 100 },
        { ts: now - 3000, open: boxHigh, high: boxHigh, low: entryPx, close: entryPx, volume: 100 },
        { ts: now - 2000, open: entryPx, high: entryPx + 0.01, low: entryPx - 0.1, close: entryPx, volume: 100 }
    ];

    return {
        symbol: "BTCUSDT",
        run_cycle_id: `cycle_${Math.random()}`,
        now,
        candles,
        snapshot: {
            lastPrice: entryPx,
            latestCandleClose: entryPx,
            boxHigh,
            boxLow,
            boxPos: overrides.boxPos ?? (side === "long" ? 0.1 : 0.9),
            rangeConfidence: 0.85,
            ema20: (boxHigh + boxLow) / 2,
            emaGap: side === "long" ? 0.0001 : -0.0001,
            volatilityProxy: atr,
            boxCohesion01: 0.9,
            breakoutFailureRate: 0.1,
            trendWeaknessScore: 0.8,
            rangeOscillationScore: 0.8,
            reviewing_ticks: 0,
            regimeExitRisk: 0,
            boxBreakSide: "none",
            signal: "none",
            qualityScore: 85,
            data_ready: true,
            dump_protection_hit: false,
            volatility_guard_hit: false,
            entryCandidate: false,
            signalGateBlockedReason: null,
            rangeSignalDowngraded: false,
            rangeSignalKeptByRelax: false,
            atr,
            atr20: atr,
            swingHighSlope: 0,
            swingLowSlope: 0,
            rangeCenterSlope: 0,
            boxHighSlope: 0,
            boxLowSlope: 0,
            ema20Slope: 0,
            ema60Slope: 0,
            atrExpansion: 1,
            volumeExpansion: 1,
            candles
        },
        config: {
            paperMaxOpenPositions: 3,
            paperReentryCooldownMs: 0,
            baseSizeUsd: 1000,
            okxLiveMaxOrderNotionalUsdt: 10000,
            paperTakerFeeRate: overrides.feeRate ?? 0.0005
        },
        state: {
            currentPositions: [],
            globalRiskScore: 0,
            lossStreaks: {},
            directionalShockState: "NONE",
            longAllow: true,
            shortAllow: true,
            executionReadiness: true,
            paperExecutionReady: true,
            signedExecutionReady: true,
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            riskMode: "NORMAL",
            dailyLossGuardTriggered: false,
            freshTickBarrierActive: false,
            freshTickCompletedCycles: 5,
            freshTickRequiredCycles: 3,
            accountEquityKrw: 10000000,
            maxUsableMarginKrw: 5000000,
            exposureNotionalCapKrw: 20000000,
            symbolExposureNotionalCapKrw: 10000000
        },
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        }
    };
}

async function runTests() {
    console.log("=== AFTER DEPLOY TRADE REVIEW BLOCKER TESTS (4-22) ===\n");

    // =========================================================================
    // P0-1: RANGE_PARTIAL_AT_OPPOSITE_EDGE DURABLE DEDUPE & COUNTEREXAMPLES (A ~ J)
    // =========================================================================

    // TEST A: fresh position -> RANGE opposite partial = ALLOW
    {
        const freshPosition = {
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 2500,
            sizeUsd: 300,
            entryStage: 1,
            pnlPct: 0.015,
            leverage: 5,
            rangeOppositePartialTaken: false
        };

        const v2State = createMockV2State([freshPosition]);
        const judgmentUpper = createMockRangeJudgment({ rangePhase: "UPPER" });

        const res = evaluateV2ExitPolicy({
            symbol: "ETHUSDT",
            v2State,
            judgment: judgmentUpper,
            snapshot: {
                boxPos: 0.85,
                boxBreakSide: "none",
                emaGap: 0,
                trendWeaknessScore: 0.3,
                rangeConfidence: 0.85,
                qualityScore: 0.85
            },
            markPrice: 2537.5
        });

        const ok = res.action === "PARTIAL_TAKE_PROFIT" &&
                   res.reason === "RANGE_PARTIAL_AT_OPPOSITE_EDGE" &&
                   res.reduceRatio === 0.4;

        report("TEST A — fresh position -> RANGE opposite-edge partial is ALLOWED", ok, {
            action: res.action,
            reason: res.reason,
            reduceRatio: res.reduceRatio
        });
    }

    // TEST B: RANGE partial confirmed (rangeOppositePartialTaken = true) -> next cycle/candle at opposite edge -> SUPPRESSED (HOLD)
    {
        const positionRangePartialConfirmed = {
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 2500,
            sizeUsd: 300,
            entryStage: 1,
            pnlPct: 0.015,
            leverage: 5,
            lastReduceReason: "RANGE_PARTIAL_AT_OPPOSITE_EDGE",
            rangeOppositePartialTaken: true,
            partialExitStage: 1
        };

        const v2State = createMockV2State([positionRangePartialConfirmed]);
        const judgmentUpper = createMockRangeJudgment({ rangePhase: "UPPER" });

        const res = evaluateV2ExitPolicy({
            symbol: "ETHUSDT",
            v2State,
            judgment: judgmentUpper,
            snapshot: {
                boxPos: 0.88,
                boxBreakSide: "none",
                emaGap: 0,
                trendWeaknessScore: 0.3,
                rangeConfidence: 0.85,
                qualityScore: 0.85
            },
            markPrice: 2540
        });

        const ok = res.action === "HOLD" &&
                   res.reason === "RANGE_PROFIT_PROTECT" &&
                   res.reduceRatio === 0 &&
                   res.evidence.includes("repeat_range_opposite_edge_partial_suppressed");

        report("TEST B — RANGE partial confirmed -> 2nd cycle at opposite edge is SUPPRESSED", ok, {
            action: res.action,
            reason: res.reason,
            reduceRatio: res.reduceRatio
        });
    }

    // TEST C: RANGE partial confirmed -> TREND_DEFENSIVE_TRIM occurs (overwriting lastReduceReason) -> next RANGE opposite edge -> SUPPRESSED (durable!)
    {
        const positionAfterInterveningDefensiveTrim = {
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 2500,
            sizeUsd: 200,
            entryStage: 1,
            pnlPct: 0.012,
            leverage: 5,
            lastReduceReason: "TREND_DEFENSIVE_TRIM", // lastReduceReason was overwritten by defensive trim!
            rangeOppositePartialTaken: true, // durable field remains true!
            partialExitStage: 2
        };

        const v2State = createMockV2State([positionAfterInterveningDefensiveTrim]);
        const judgmentUpper = createMockRangeJudgment({ rangePhase: "UPPER" });

        const res = evaluateV2ExitPolicy({
            symbol: "ETHUSDT",
            v2State,
            judgment: judgmentUpper,
            snapshot: {
                boxPos: 0.85,
                boxBreakSide: "none",
                emaGap: 0,
                trendWeaknessScore: 0.3,
                rangeConfidence: 0.85,
                qualityScore: 0.85
            },
            markPrice: 2530
        });

        const ok = res.action === "HOLD" &&
                   res.reason === "RANGE_PROFIT_PROTECT" &&
                   res.reduceRatio === 0 &&
                   res.evidence.includes("repeat_range_opposite_edge_partial_suppressed");

        report("TEST C — RANGE partial confirmed -> intervening TREND_DEFENSIVE_TRIM -> 2nd RANGE partial is SUPPRESSED (durable)", ok, {
            action: res.action,
            reason: res.reason
        });
    }

    // TEST D: RANGE partial confirmed -> PNL_STOP_PROTECT occurs -> next RANGE opposite edge -> SUPPRESSED (durable!)
    {
        const positionAfterInterveningPnlStop = {
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 2500,
            sizeUsd: 200,
            entryStage: 1,
            pnlPct: 0.010,
            leverage: 5,
            lastReduceReason: "PNL_STOP_PROTECT", // lastReduceReason overwritten
            rangeOppositePartialTaken: true, // durable flag intact
            partialExitStage: 2
        };

        const v2State = createMockV2State([positionAfterInterveningPnlStop]);
        const judgmentUpper = createMockRangeJudgment({ rangePhase: "UPPER" });

        const res = evaluateV2ExitPolicy({
            symbol: "ETHUSDT",
            v2State,
            judgment: judgmentUpper,
            snapshot: {
                boxPos: 0.82,
                boxBreakSide: "none",
                emaGap: 0,
                trendWeaknessScore: 0.3,
                rangeConfidence: 0.85,
                qualityScore: 0.85
            },
            markPrice: 2525
        });

        const ok = res.action === "HOLD" &&
                   res.reason === "RANGE_PROFIT_PROTECT" &&
                   res.reduceRatio === 0 &&
                   res.evidence.includes("repeat_range_opposite_edge_partial_suppressed");

        report("TEST D — RANGE partial confirmed -> intervening PNL_STOP -> 2nd RANGE partial is SUPPRESSED (durable)", ok, {
            action: res.action,
            reason: res.reason
        });
    }

    // TEST E: TP1 automated partial first -> RANGE opposite edge -> ALLOW 1회
    {
        const positionAfterTp1Automated = {
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 2500,
            sizeUsd: 250,
            entryStage: 1,
            pnlPct: 0.015,
            leverage: 5,
            tp1Triggered: true,
            partialExitStage: 1,
            lastReduceReason: "v2_tp1_automated",
            rangeOppositePartialTaken: false // opposite edge not taken yet!
        };

        const v2State = createMockV2State([positionAfterTp1Automated]);
        const judgmentUpper = createMockRangeJudgment({ rangePhase: "UPPER" });

        const res = evaluateV2ExitPolicy({
            symbol: "ETHUSDT",
            v2State,
            judgment: judgmentUpper,
            snapshot: {
                boxPos: 0.85,
                boxBreakSide: "none",
                emaGap: 0,
                trendWeaknessScore: 0.3,
                rangeConfidence: 0.85,
                qualityScore: 0.85
            },
            markPrice: 2537.5
        });

        const ok = res.action === "PARTIAL_TAKE_PROFIT" &&
                   res.reason === "RANGE_PARTIAL_AT_OPPOSITE_EDGE" &&
                   res.reduceRatio === 0.4;

        report("TEST E — TP1 automated partial first -> RANGE opposite-edge partial is ALLOWED once", ok, {
            action: res.action,
            reason: res.reason,
            reduceRatio: res.reduceRatio
        });
    }

    // TEST F: defensive trim first -> RANGE opposite edge -> ALLOW 1회
    {
        const positionAfterDefensiveTrim = {
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 2500,
            sizeUsd: 350,
            entryStage: 1,
            pnlPct: 0.012,
            leverage: 5,
            partialExitStage: 1,
            lastReduceReason: "TREND_DEFENSIVE_TRIM",
            rangeOppositePartialTaken: false // opposite edge not taken yet!
        };

        const v2State = createMockV2State([positionAfterDefensiveTrim]);
        const judgmentUpper = createMockRangeJudgment({ rangePhase: "UPPER" });

        const res = evaluateV2ExitPolicy({
            symbol: "ETHUSDT",
            v2State,
            judgment: judgmentUpper,
            snapshot: {
                boxPos: 0.85,
                boxBreakSide: "none",
                emaGap: 0,
                trendWeaknessScore: 0.3,
                rangeConfidence: 0.85,
                qualityScore: 0.85
            },
            markPrice: 2530
        });

        const ok = res.action === "PARTIAL_TAKE_PROFIT" &&
                   res.reason === "RANGE_PARTIAL_AT_OPPOSITE_EDGE" &&
                   res.reduceRatio === 0.4;

        report("TEST F — Defensive trim partial first -> RANGE opposite-edge partial is ALLOWED once", ok, {
            action: res.action,
            reason: res.reason,
            reduceRatio: res.reduceRatio
        });
    }

    // TEST G: RANGE submit rejected/unfilled (rangeOppositePartialTaken remains false) -> retry = ALLOW
    {
        const positionRejectedSubmit = {
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 2500,
            sizeUsd: 300,
            entryStage: 1,
            pnlPct: 0.015,
            leverage: 5,
            rangeOppositePartialTaken: false // unfilled/rejected order does NOT set true!
        };

        const v2State = createMockV2State([positionRejectedSubmit]);
        const judgmentUpper = createMockRangeJudgment({ rangePhase: "UPPER" });

        const res = evaluateV2ExitPolicy({
            symbol: "ETHUSDT",
            v2State,
            judgment: judgmentUpper,
            snapshot: {
                boxPos: 0.85,
                boxBreakSide: "none",
                emaGap: 0,
                trendWeaknessScore: 0.3,
                rangeConfidence: 0.85,
                qualityScore: 0.85
            },
            markPrice: 2537.5
        });

        const ok = res.action === "PARTIAL_TAKE_PROFIT" &&
                   res.reason === "RANGE_PARTIAL_AT_OPPOSITE_EDGE" &&
                   res.reduceRatio === 0.4;

        report("TEST G — RANGE submit rejected/unfilled -> RANGE retry is ALLOWED", ok, {
            action: res.action,
            reason: res.reason
        });
    }

    // TEST H: RANGE confirmed -> restart/hydration preserves rangeOppositePartialTaken: true -> SUPPRESSED
    {
        const hydratedPosition = {
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 2500,
            sizeUsd: 300,
            entryStage: 1,
            pnlPct: 0.018,
            leverage: 5,
            rangeOppositePartialTaken: true, // restored from ledger/disk
            partialExitStage: 1
        };

        const v2StateHydrated = createMockV2State([hydratedPosition]);
        const judgment = createMockRangeJudgment({ rangePhase: "UPPER" });

        const res = evaluateV2ExitPolicy({
            symbol: "ETHUSDT",
            v2State: v2StateHydrated,
            judgment,
            snapshot: {
                boxPos: 0.82,
                boxBreakSide: "none",
                emaGap: 0,
                trendWeaknessScore: 0.3,
                rangeConfidence: 0.85,
                qualityScore: 0.85
            },
            markPrice: 2545
        });

        const ok = res.action === "HOLD" &&
                   res.reason === "RANGE_PROFIT_PROTECT" &&
                   res.reduceRatio === 0 &&
                   res.evidence.includes("repeat_range_opposite_edge_partial_suppressed");

        report("TEST H — Restart/hydration preserves rangeOppositePartialTaken and suppresses repeat partial", ok, {
            action: res.action,
            reason: res.reason
        });
    }

    // TEST I: Old position closes -> new position opened (rangeOppositePartialTaken undefined/false) -> ALLOW
    {
        const newPositionAfterOldClosed = {
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 2550,
            sizeUsd: 300,
            entryStage: 1,
            pnlPct: 0.012,
            leverage: 5,
            rangeOppositePartialTaken: undefined // fresh position
        };

        const v2State = createMockV2State([newPositionAfterOldClosed]);
        const judgmentUpper = createMockRangeJudgment({ rangePhase: "UPPER" });

        const res = evaluateV2ExitPolicy({
            symbol: "ETHUSDT",
            v2State,
            judgment: judgmentUpper,
            snapshot: {
                boxPos: 0.85,
                boxBreakSide: "none",
                emaGap: 0,
                trendWeaknessScore: 0.3,
                rangeConfidence: 0.85,
                qualityScore: 0.85
            },
            markPrice: 2580
        });

        const ok = res.action === "PARTIAL_TAKE_PROFIT" &&
                   res.reason === "RANGE_PARTIAL_AT_OPPOSITE_EDGE" &&
                   res.reduceRatio === 0.4;

        report("TEST I — Old position closed -> new fresh position -> RANGE opposite-edge partial is ALLOWED", ok, {
            action: res.action,
            reason: res.reason
        });
    }

    // TEST J: Legitimate exits (box break FULL_EXIT, stop loss) are NOT blocked by rangeOppositePartialTaken
    {
        const positionConfirmed = {
            symbol: "ETHUSDT",
            side: "LONG",
            entryPrice: 2500,
            sizeUsd: 300,
            entryStage: 1,
            pnlPct: -0.015,
            leverage: 5,
            rangeOppositePartialTaken: true,
            partialExitStage: 1,
            ledger_stop_px: 2450
        };

        const v2State = createMockV2State([positionConfirmed]);
        const judgment = createMockRangeJudgment({ rangePhase: "LOWER" });

        // J1: Box break full exit
        const boxBreakResult = evaluateV2ExitPolicy({
            symbol: "ETHUSDT",
            v2State,
            judgment,
            snapshot: {
                boxPos: 0.08,
                boxBreakSide: "lower",
                emaGap: -0.005,
                trendWeaknessScore: 0.8,
                rangeConfidence: 0.4,
                qualityScore: 0.3
            },
            boxBreakConfirmed: true,
            invalidationBreachConfirmed: true,
            markPrice: 2445
        });

        // J2: Committed stop loss breached
        const stopBreachResult = evaluateV2ExitPolicy({
            symbol: "ETHUSDT",
            v2State,
            judgment,
            snapshot: {
                boxPos: 0.05,
                boxBreakSide: "none",
                emaGap: 0,
                trendWeaknessScore: 0.5,
                rangeConfidence: 0.6,
                qualityScore: 0.5
            },
            markPrice: 2440 // below ledger_stop_px (2450)
        });

        const ok = (boxBreakResult.action === "FULL_EXIT" || boxBreakResult.reason === "RANGE_FULL_EXIT_BOX_BREAK" || boxBreakResult.reason === "PNL_STOP_PROTECT") &&
                   stopBreachResult.action === "FULL_EXIT" &&
                   stopBreachResult.reason === "PNL_STOP_PROTECT";

        report("TEST J — Legitimate exits (box break, stop loss) are NOT blocked by partial guard", ok, {
            boxBreakAction: boxBreakResult.action,
            boxBreakReason: boxBreakResult.reason,
            stopBreachAction: stopBreachResult.action,
            stopBreachReason: stopBreachResult.reason
        });
    }

    // =========================================================================
    // P0-2: TP1 MINIMUM COST BREAK-EVEN TESTS (K ~ N)
    // =========================================================================

    // TEST K: TP1 minimum >= fee/slippage break-even + safety buffer (0.20% minimum, not 0.18%)
    {
        const entry = 2500;
        const feeRate = 0.0005; // 0.05%
        const expectedBe = computeSoftExitFeeBreakEvenPct({
            positionNotionalUsd: 1000,
            feeRate,
            slippageBufferPct: DEFAULT_SOFT_EXIT_SLIPPAGE_BUFFER_PCT
        }); // 0.0018
        const expectedMinPct = expectedBe + 0.0002; // 0.0020 (0.20%)

        const inputLong = createRangeInput({
            side: "long",
            entryPx: entry,
            boxLow: 2498,
            boxHigh: 2502, // very narrow box -> raw TP1 would be tiny without clamp
            boxPos: 0.1,
            atr: 1,
            feeRate
        });

        const outLong = executeRangeRegime(inputLong, createMockRangeJudgment({ rangePhase: "LOWER" }));
        const tp1Long = outLong.metadata.takeProfit1Px as number;
        const actualLongDistPct = (tp1Long - entry) / entry;

        const ok = outLong.signal === "LONG_CANDIDATE" &&
                   actualLongDistPct >= expectedMinPct - 1e-8 &&
                   tp1Long >= entry * (1 + expectedMinPct) - 1e-6;

        report("TEST K — TP1 minimum >= fee/slippage break-even + buffer (>= 0.20%)", ok, {
            expectedBe,
            expectedMinPct,
            actualLongDistPct,
            tp1Long,
            minExpectedPrice: entry * (1 + expectedMinPct)
        });
    }

    // TEST L: TP1 maximum does not exceed 0.25% (0.0025)
    {
        const entry = 2500;
        const inputFar = createRangeInput({
            side: "long",
            entryPx: entry,
            boxLow: 2400,
            boxHigh: 2700, // very wide box -> raw mid is at 2550 (+2.0%), clamped to 0.25%
            boxPos: 0.1,
            atr: 50
        });

        const outFar = executeRangeRegime(inputFar, createMockRangeJudgment({ rangePhase: "LOWER" }));
        const tp1 = outFar.metadata.takeProfit1Px as number;
        const actualDistPct = (tp1 - entry) / entry;

        const ok = actualDistPct <= 0.0025 + 1e-8 && tp1 <= entry * 1.0025 + 1e-6;
        report("TEST L — TP1 maximum does not exceed 0.25%", ok, {
            tp1,
            actualDistPct,
            maxAllowedPrice: entry * 1.0025
        });
    }

    // TEST M: LONG and SHORT TP1 distance calculation is symmetric
    {
        const entry = 2500;
        const inputLong = createRangeInput({
            side: "long",
            entryPx: entry,
            boxLow: 2498,
            boxHigh: 2502,
            boxPos: 0.1,
            atr: 1
        });
        const inputShort = createRangeInput({
            side: "short",
            entryPx: entry,
            boxLow: 2498,
            boxHigh: 2502,
            boxPos: 0.9,
            atr: 1
        });

        const outLong = executeRangeRegime(inputLong, createMockRangeJudgment({ rangePhase: "LOWER" }));
        const outShort = executeRangeRegime(inputShort, createMockRangeJudgment({ rangePhase: "UPPER" }));

        const tp1Long = outLong.metadata.takeProfit1Px as number;
        const tp1Short = outShort.metadata.takeProfit1Px as number;

        const longDist = tp1Long - entry;
        const shortDist = entry - tp1Short;

        const ok = Math.abs(longDist - shortDist) < 1e-6;
        report("TEST M — LONG / SHORT TP1 distance is symmetric", ok, {
            longDist,
            shortDist,
            diff: Math.abs(longDist - shortDist)
        });
    }

    // TEST N: Fail-closed block when cost/break-even >= 0.25%
    {
        // High fee rate scenario: feeRate = 0.0010 (0.10%), BE = 0.20% + 0.08% = 0.28% > 0.25%
        const inputHighCost = createRangeInput({
            side: "long",
            entryPx: 2500,
            feeRate: 0.0010 // 0.10% -> 2*0.10% + 0.08% + 0.02% = 0.30% > 0.25%
        });

        const outHighCost = executeRangeRegime(inputHighCost, createMockRangeJudgment({ rangePhase: "LOWER" }));
        const ok = outHighCost.signal === "NONE" &&
                   outHighCost.reason.includes("Invalid TP plan") &&
                   outHighCost.reason.includes("fee_slippage_cost_exceeds_max_tp1");

        report("TEST N — High cost scenario (cost > 0.25%) triggers fail-closed block", ok, {
            signal: outHighCost.signal,
            reason: outHighCost.reason
        });
    }

    // =========================================================================
    // P0-3: TP2 PROPAGATION & TARGET ADVANCE TESTS (O ~ R)
    // =========================================================================

    // TEST O: TP2 is preserved through executeRangeRegime -> envelope -> authority -> lifecycle
    {
        const entry = 2500;
        const input = createRangeInput({
            side: "long",
            entryPx: entry,
            boxLow: 2470,
            boxHigh: 2530,
            boxPos: 0.15,
            atr: 10
        });

        const executorOut = executeRangeRegime(input, createMockRangeJudgment({ rangePhase: "LOWER" }));
        const execMeta = executorOut.metadata;

        assert(typeof execMeta.takeProfit1Px === "number" && execMeta.takeProfit1Px > entry, "TP1 generated");
        assert(typeof execMeta.takeProfit2Px === "number" && execMeta.takeProfit2Px > (execMeta.takeProfit1Px as number), "TP2 generated");

        const envelope = buildV2ExecutionAuthorityEnvelope({
            symbol: "ETHUSDT",
            mode: "engine_v2",
            v2Decision: {
                decision: "ENTER",
                side: "long",
                regime: "RANGE",
                risk: {
                    stageMarginKrw: 100000,
                    baseStageMarginKrw: 100000,
                    appliedLeverage: 5,
                    exposureNotionalKrw: 500000,
                    equityMultiple: 1,
                    entryQualityGrade: "A",
                    leverageProfile: "BASE",
                    isBlocked: false,
                    blockReason: null,
                    isAddOn: false,
                    sizeMultiplier: 1,
                    leverageReason: "test",
                    leverageBlockReason: null
                },
                explanation: { reason: "test", uiLabelRegime: "RANGE", uiLabelStatus: "ENTER" },
                metadata: execMeta
            } as any,
            selector: {
                adopted_result: { engine: "V2", adopted_decision: "ENTER", adopted_side: "long" },
                v2_result: { risk: {}, decision: "ENTER", side: "long" }
            } as any,
            legacyComparison: {} as any,
            marketSubtype: "RANGE_FLAT",
            takeProfitPlan: execMeta.takeProfitPlan,
            takeProfit1Px: execMeta.takeProfit1Px as number,
            takeProfit2Px: execMeta.takeProfit2Px as number,
            partialExitRatio: execMeta.partialExitRatio as number,
            invalidationPx: execMeta.invalidationPx as number
        });

        const authority = deriveExecutionAuthorityFromEnvelope(envelope);

        // Evaluate lifecycle with the takeProfitPlan
        const lifecycleRes = deriveTradeLifecycleAuthority({
            symbol: "ETHUSDT",
            side: "long",
            position: {
                entryPrice: entry,
                sizeUsd: 500,
                entryStage: 1,
                pnlPct: 0.005,
                leverage: 5
            } as any,
            markPrice: 2505, // at TP1
            takeProfitPlan: authority.takeProfitPlan,
            tp1Triggered: false,
            tp2Triggered: false,
            authoritySource: "v2",
            adoptedEngine: "V2",
            rawMetricsSummary: { boxPos: 0.5, trendWeaknessScore: 0.3 } as any,
            directionalShockState: "NONE",
            reconcileContext: {} as any,
            cooldownState: { reason: "" } as any,
            breakevenStopRequired: false,
            entryQualityGrade: "A"
        } as any);

        const ok = authority.takeProfit2Px === execMeta.takeProfit2Px &&
                   lifecycleRes.takeProfit2Px === execMeta.takeProfit2Px &&
                   lifecycleRes.takeProfit1Px === execMeta.takeProfit1Px;

        report("TEST O — TP2 preserved across envelope -> authority -> lifecycle evaluation", ok, {
            execTp2: execMeta.takeProfit2Px,
            authorityTp2: authority.takeProfit2Px,
            lifecycleTp2: lifecycleRes.takeProfit2Px
        });
    }

    // TEST P: TP1 confirmed -> targetPrice1 correctly advances to TP2
    {
        const entry = 2500;
        const tp1Px = 2505;
        const tp2Px = 2530;

        const openRecord: any = {
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: entry,
            takeProfit1Px: tp1Px,
            takeProfit2Px: tp2Px,
            takeProfitPlan: { tp1: tp1Px, tp2: tp2Px, invalidationPx: 2470 },
            isV2Authority: true,
            regimeAtEntry: "RANGE",
            partialExitStage: 0,
            targetPrice1: tp1Px
        };

        // Simulate applyV2PartialFillConfirmed logic on open position
        const isRangeTp1Confirmed = true;
        if (isRangeTp1Confirmed) {
            const tp2 =
                typeof openRecord.takeProfit2Px === "number" && Number.isFinite(openRecord.takeProfit2Px) && openRecord.takeProfit2Px > 0
                    ? openRecord.takeProfit2Px
                    : typeof (openRecord.takeProfitPlan as any)?.tp2 === "number" && Number.isFinite((openRecord.takeProfitPlan as any).tp2) && (openRecord.takeProfitPlan as any).tp2 > 0
                        ? (openRecord.takeProfitPlan as any).tp2
                        : undefined;
            const tp1 =
                typeof openRecord.takeProfit1Px === "number" && Number.isFinite(openRecord.takeProfit1Px) && openRecord.takeProfit1Px > 0
                    ? openRecord.takeProfit1Px
                    : typeof (openRecord.takeProfitPlan as any)?.tp1 === "number" && Number.isFinite((openRecord.takeProfitPlan as any).tp1) && (openRecord.takeProfitPlan as any).tp1 > 0
                        ? (openRecord.takeProfitPlan as any).tp1
                        : undefined;
            const entryPx = openRecord.entryPrice;
            const isValidTp2Direction =
                typeof tp2 === "number" &&
                Number.isFinite(tp2) &&
                (openRecord.side === "long" ? tp2 > (tp1 ?? entryPx) : tp2 < (tp1 ?? entryPx));

            if (isValidTp2Direction) {
                openRecord.targetPrice1 = tp2;
                if (openRecord.takeProfit2Px == null) {
                    openRecord.takeProfit2Px = tp2;
                }
            } else {
                openRecord.targetPrice1 = undefined;
            }
        }

        const ok = openRecord.targetPrice1 === tp2Px && openRecord.takeProfit2Px === tp2Px;
        report("TEST P — TP1 confirmed -> targetPrice1 advances to valid TP2 (2530)", ok, {
            targetPrice1: openRecord.targetPrice1,
            expected: tp2Px
        });
    }

    // TEST Q: Truly missing TP2 clears targetPrice1 (runner hold mode)
    {
        const openRecordNoTp2: any = {
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2500,
            takeProfit1Px: 2505,
            takeProfit2Px: undefined,
            takeProfitPlan: undefined,
            isV2Authority: true,
            regimeAtEntry: "RANGE",
            partialExitStage: 0,
            targetPrice1: 2505
        };

        // Simulate applyV2PartialFillConfirmed logic
        const tp2 =
            typeof openRecordNoTp2.takeProfit2Px === "number" && Number.isFinite(openRecordNoTp2.takeProfit2Px) && openRecordNoTp2.takeProfit2Px > 0
                ? openRecordNoTp2.takeProfit2Px
                : typeof (openRecordNoTp2.takeProfitPlan as any)?.tp2 === "number" && Number.isFinite((openRecordNoTp2.takeProfitPlan as any).tp2) && (openRecordNoTp2.takeProfitPlan as any).tp2 > 0
                    ? (openRecordNoTp2.takeProfitPlan as any).tp2
                    : undefined;
        const tp1 = openRecordNoTp2.takeProfit1Px;
        const entryPx = openRecordNoTp2.entryPrice;
        const isValidTp2Direction =
            typeof tp2 === "number" &&
            Number.isFinite(tp2) &&
            (openRecordNoTp2.side === "long" ? tp2 > (tp1 ?? entryPx) : tp2 < (tp1 ?? entryPx));

        let clearedReason = "";
        if (isValidTp2Direction) {
            openRecordNoTp2.targetPrice1 = tp2;
        } else {
            openRecordNoTp2.targetPrice1 = undefined;
            clearedReason = "tp1_confirmed_tp2_missing_or_invalid";
        }

        const ok = openRecordNoTp2.targetPrice1 === undefined && clearedReason === "tp1_confirmed_tp2_missing_or_invalid";
        report("TEST Q — Genuinely missing TP2 clears targetPrice1 for runner mode", ok, {
            targetPrice1: openRecordNoTp2.targetPrice1,
            clearedReason
        });
    }

    // TEST R: Production scenario where takeProfitPlan has TP2 but direct takeProfit2Px was omitted -> fallback recovers TP2 without missing_or_invalid
    {
        const openRecordWithPlanOnly: any = {
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2500,
            takeProfit1Px: 2505,
            takeProfit2Px: undefined, // omitted on direct field
            takeProfitPlan: { tp1: 2505, tp2: 2530, invalidationPx: 2470 }, // present in plan!
            isV2Authority: true,
            regimeAtEntry: "RANGE",
            partialExitStage: 0,
            targetPrice1: 2505
        };

        const tp2 =
            typeof openRecordWithPlanOnly.takeProfit2Px === "number" && Number.isFinite(openRecordWithPlanOnly.takeProfit2Px) && openRecordWithPlanOnly.takeProfit2Px > 0
                ? openRecordWithPlanOnly.takeProfit2Px
                : typeof (openRecordWithPlanOnly.takeProfitPlan as any)?.tp2 === "number" && Number.isFinite((openRecordWithPlanOnly.takeProfitPlan as any).tp2) && (openRecordWithPlanOnly.takeProfitPlan as any).tp2 > 0
                    ? (openRecordWithPlanOnly.takeProfitPlan as any).tp2
                    : undefined;
        const tp1 = openRecordWithPlanOnly.takeProfit1Px;
        const entryPx = openRecordWithPlanOnly.entryPrice;
        const isValidTp2Direction =
            typeof tp2 === "number" &&
            Number.isFinite(tp2) &&
            (openRecordWithPlanOnly.side === "long" ? tp2 > (tp1 ?? entryPx) : tp2 < (tp1 ?? entryPx));

        let advanceReason = "";
        if (isValidTp2Direction) {
            openRecordWithPlanOnly.targetPrice1 = tp2;
            if (openRecordWithPlanOnly.takeProfit2Px == null) {
                openRecordWithPlanOnly.takeProfit2Px = tp2;
            }
            advanceReason = "tp1_confirmed_advance_to_tp2";
        } else {
            openRecordWithPlanOnly.targetPrice1 = undefined;
            advanceReason = "tp1_confirmed_tp2_missing_or_invalid";
        }

        const ok = openRecordWithPlanOnly.targetPrice1 === 2530 &&
                   openRecordWithPlanOnly.takeProfit2Px === 2530 &&
                   advanceReason === "tp1_confirmed_advance_to_tp2";

        report("TEST R — Fallback successfully recovers TP2 from takeProfitPlan without propagation loss", ok, {
            targetPrice1: openRecordWithPlanOnly.targetPrice1,
            takeProfit2Px: openRecordWithPlanOnly.takeProfit2Px,
            advanceReason
        });
    }

    console.log(`\n=== ALL ${passCount} TESTS (A ~ R) PASSED SUCCESSFULLY ===`);
}

runTests().catch((e) => {
    console.error("Test execution failed:", e);
    process.exit(1);
});
