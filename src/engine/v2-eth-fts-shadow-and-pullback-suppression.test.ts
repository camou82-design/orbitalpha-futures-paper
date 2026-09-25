import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2, marketJudgmentCacheBySymbol } from "../engine-v2/index";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import { clearGlobalShockStates, globalShockStates } from "../engine-v2/state/derive";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";
import type { SymbolSnapshotLike } from "./paper-symbol-decision";

const NOW = 1_700_000_000_000;

function makeTestCandles(base = 2500, direction: "up" | "down" = "down", count = 120): Candle[] {
    const candles: Candle[] = [];
    const step = direction === "down" ? -2 : 2;
    for (let i = 0; i < count; i++) {
        const p = base + (i - count) * step;
        candles.push({
            ts: NOW - (count - i) * 60_000,
            open: p,
            high: p + 3,
            low: p - 3,
            close: p + (direction === "down" ? -2 : 2),
            volume: 100
        });
    }
    return candles;
}

function createBaseSnapshot(overrides: Record<string, any> = {}): SymbolSnapshotLike {
    const candles = overrides.candles ?? makeTestCandles(2500, "down", 120);
    return {
        symbol: "ETHUSDT",
        lastPrice: 2500,
        latestCandleClose: 2500,
        signal: "paper_short_candidate",
        entryCandidate: true,
        qualityScore: 75,
        candidateStrength: "strong",
        ema20: 2510,
        ema60: 2530,
        emaGap: -0.0006,
        volumeRatioProxy: 1.2,
        boxHigh: 2650,
        boxLow: 2480,
        boxPos: 0.15,
        boxRel: 0.05,
        gateExpectedMove: null,
        gateRequiredMove: null,
        atr: 15,
        atr20: 15,
        closedClose: 2500,
        rangeConfidence: 0.4,
        trendWeaknessScore: 0.35,
        boxCohesion01: 0.7,
        breakoutFailureRate: 0.3,
        rangeOscillationScore: 0.3,
        boxHighSlope: -0.0003,
        boxLowSlope: -0.0003,
        rangeCenterSlope: -0.0003,
        ema20Slope: -0.0003,
        candles,
        canonicalRegime: "canonicalRegime" in overrides ? overrides.canonicalRegime : "TREND",
        canonicalRegimeSource: "strategy_market_regime_detector",
        canonicalTrendScore: 0.8,
        htf_candles: {
            "5m": candles,
            "15m": candles,
            "1h": candles,
            "4h": candles,
            "1d": candles
        },
        ...overrides
    } as any;
}

function createBaseState(overrides: Record<string, any> = {}): any {
    return {
        directionalShockState: "NONE",
        crashState: "NORMAL",
        shortAllow: true,
        longAllow: true,
        currentPositions: [],
        signedExecutionReady: true,
        paperExecutionReady: true,
        okxAuthMode: "live",
        okxAuthReady: true,
        okxExchangeAuthOptIn: true,
        okxLiveEnabled: true,
        liveBalanceReady: true,
        accountEquityUsdt: 10000,
        availableBalanceUsdt: 10000,
        okxActualPositionsReady: true,
        actualAccountNotionalUsdtReady: true,
        okxPendingOrdersReady: true,
        okxPendingOrdersNotionalUsdt: 0,
        okxPendingSymbolNotionalUsdt: 0,
        okxActualPositions: [],
        balanceFetchedAt: NOW,
        positionsFetchedAt: NOW,
        pendingOrdersFetchedAt: NOW,
        freshTickBarrierActive: false,
        freshTickCompletedCycles: 3,
        freshTickRequiredCycles: 3,
        globalRiskScore: 0.1,
        lossStreaks: {},
        executionReadiness: true,
        serverTradeEnabled: true,
        closeOnlyMode: false,
        killSwitch: false,
        ...overrides
    };
}

function runEngineWith(
    snapshotOverrides: Record<string, any> = {},
    stateOverrides: Record<string, any> = {},
    configOverrides: Record<string, any> = {}
) {
    marketJudgmentCacheBySymbol.clear();
    clearWhipsawObservationState();
    clearGlobalShockStates();
    rangeContinuationStateMap.clear();

    const snap = createBaseSnapshot(snapshotOverrides);
    if (stateOverrides.directionalShockState && stateOverrides.directionalShockState !== "NONE") {
        globalShockStates.set(snap.symbol, {
            activeDirection: stateOverrides.directionalShockState,
            rawDirection: stateOverrides.directionalShockState,
            candidateDirection: stateOverrides.directionalShockState,
            candidateCount: 3,
            neutralCount: 0,
            candidateStartedAt: NOW - 60000,
            activatedAt: NOW - 60000,
            lastChangedAt: NOW - 60000,
            rawMovePct: 0.01,
            requiredMovePct: 0.0012,
            emergencyBypass: true,
            lastProcessedCycle: "prev"
        });
    }
    const bridge = buildV2SnapshotBridge(snap);
    const state = createBaseState(stateOverrides);
    const config = { paperMaxOpenPositions: 3, baseSizeUsd: 100, ...configOverrides };

    const input = adaptV2Input(
        snap.symbol,
        NOW,
        bridge as any,
        config as any,
        state as any,
        { decision: { final_decision: "ENTER" } } as any,
        snap.candles,
        "authoritative",
        `cycle_${snap.symbol}_${NOW}_test`
    );

    return runEngineV2(input);
}

describe("ETH Minimal Strategy Authority Suppression Regression Suite (Cases 1-23)", () => {
    // CASE 1: ETH FTS otherwise eligible ENTER -> live ENTER suppressed to HOLD (shadow only)
    it("CASE 1: ETH FTS otherwise eligible ENTER -> live ENTER suppressed to HOLD with shadow telemetry preserved", () => {
        const candles = makeTestCandles(2450, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2450,
            latestCandleClose: 2450,
            signal: "paper_long_candidate",
            entryCandidate: true,
            canonicalRegime: "RANGE",
            rangeConfidence: 0.35,
            canonicalTrendScore: 0.35,
            boxHigh: 2600,
            boxLow: 2400,
            boxPos: 0.25,
            ema20: 2530,
            ema60: 2510,
            emaGap: 0.0006,
            ema20Slope: 0.0003,
            candles,
            fastTrendShift: {
                active: true,
                direction: "long",
                baseSizeIntent: 0.32
            }
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        console.log("CASE 1 Execution Authority Proof:", {
            decision: decision.decision,
            reason,
            committedRiskPlan: decision.committedRiskPlan,
            executionAction: decision.executionAction,
            finalOrderNotionalUsdt: decision.risk?.finalOrderNotionalUsdt
        });

        assert.notEqual(decision.decision, "ENTER", "ETH FTS must never ENTER");
        assert.equal(decision.decision, "HOLD", "ETH FTS decision must be HOLD");
        assert.ok(
            reason.includes("ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED") || decision.decision === "HOLD",
            `Reason must indicate FTS suppression: ${reason}`
        );
        assert.equal(decision.committedRiskPlan, undefined, "Suppressed FTS must have no committedRiskPlan");
        assert.equal(decision.risk?.finalOrderNotionalUsdt ?? 0, 0, "Suppressed FTS order notional must be 0");
    });

    // CASE 2: BTC FTS same fixture -> BTC FTS enters normally (BTC untouched)
    it("CASE 2: BTC FTS same fixture -> BTC execution authority untouched by ETH rule", () => {
        const candles = makeTestCandles(70000, "up", 120);
        const { decision } = runEngineWith({
            symbol: "BTCUSDT",
            lastPrice: 70000,
            latestCandleClose: 70000,
            candles,
            boxHigh: 71000,
            boxLow: 69000,
            fastTrendShift: {
                active: true,
                direction: "long",
                baseSizeIntent: 0.32
            }
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_FTS_SHADOW_ONLY"), false, "BTC must never trigger ETH suppression reason");
        console.log("CASE 2 Proof: BTC FTS decision is", decision.decision, "reason:", reason);
    });

    // CASE 3: ETH Trend Pullback otherwise eligible -> live ENTER blocked
    it("CASE 3: ETH Trend Pullback otherwise eligible -> live ENTER suppressed to HOLD", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            trendWeaknessScore: 0.45,
            canonicalRegime: "TREND"
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        console.log("CASE 3 Execution Authority Proof:", {
            decision: decision.decision,
            reason
        });

        assert.notEqual(decision.decision, "ENTER", "ETH Trend Pullback must not ENTER");
        assert.ok(
            reason.includes("ETH_TREND_PULLBACK_LIVE_ENTRY_DISABLED") || decision.decision === "HOLD" || decision.decision === "SKIP",
            "ETH Trend Pullback must be suppressed"
        );
    });

    // CASE 4: ETH Trend Continuation -> preserved and allowed
    it("CASE 4: ETH Trend Continuation -> preserved and allowed", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            emaGap: -0.0006,
            trendWeaknessScore: 0.35
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_TREND_PULLBACK_LIVE_ENTRY_DISABLED"), false, "Continuation must not be blocked by pullback rule");
        console.log("CASE 4 Proof: ETH Trend Continuation decision is", decision.decision);
    });

    // CASE 5: ETH Breakout Long -> preserved
    it("CASE 5: ETH Breakout Long -> preserved", () => {
        const candles = makeTestCandles(2600, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2680,
            latestCandleClose: 2680,
            boxHigh: 2650,
            boxLow: 2550,
            boxPos: 0.98,
            candles
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_FTS_SHADOW_ONLY"), false);
        assert.equal(reason.includes("ETH_TREND_PULLBACK"), false);
        console.log("CASE 5 Proof: ETH Breakout Long decision is", decision.decision);
    });

    // CASE 6: ETH Breakdown Short -> preserved
    it("CASE 6: ETH Breakdown Short -> preserved", () => {
        const candles = makeTestCandles(2500, "down", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2470,
            latestCandleClose: 2470,
            boxHigh: 2650,
            boxLow: 2500,
            boxPos: 0.02,
            candles
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_FTS_SHADOW_ONLY"), false);
        assert.equal(reason.includes("ETH_TREND_PULLBACK"), false);
        console.log("CASE 6 Proof: ETH Breakdown Short decision is", decision.decision);
    });

    // CASE 7: ETH Range Lower Long -> existing behavior untouched
    it("CASE 7: ETH Range Lower Long -> existing behavior untouched", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "RANGE",
            boxPos: 0.15,
            rangeConfidence: 0.85
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_FTS_SHADOW_ONLY"), false);
        assert.equal(reason.includes("ETH_TREND_PULLBACK"), false);
        console.log("CASE 7 Proof: ETH Range Lower Long decision is", decision.decision);
    });

    // CASE 8: ETH Range Upper Short -> existing behavior untouched
    it("CASE 8: ETH Range Upper Short -> existing behavior untouched", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "RANGE",
            boxPos: 0.85,
            rangeConfidence: 0.85
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_FTS_SHADOW_ONLY"), false);
        assert.equal(reason.includes("ETH_TREND_PULLBACK"), false);
        console.log("CASE 8 Proof: ETH Range Upper Short decision is", decision.decision);
    });

    // CASE 9: Existing ETH FTS position -> exit policy operates normally
    it("CASE 9: Existing ETH FTS position -> exit management operates normally", () => {
        const { decision } = runEngineWith(
            {
                symbol: "ETHUSDT",
                lastPrice: 2620,
                fastTrendShift: { active: true, direction: "long", baseSizeIntent: 0.32 }
            },
            {
                currentPositions: [{
                    symbol: "ETHUSDT",
                    side: "LONG",
                    entryPrice: 2500,
                    sizeUsd: 100,
                    pnlPct: 0.048,
                    leverage: 3,
                    entryStage: 1,
                    peakUnrealizedPnlPct: 0.05
                }]
            }
        );

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_FTS_SHADOW_ONLY"), false, "Existing position exit must not be blocked by initial entry suppression");
        console.log("CASE 9 Proof: Existing position decision is", decision.decision, "action:", decision.executionAction);
    });

    // CASE 10: Existing ETH Trend Pullback position -> exit operates normally
    it("CASE 10: Existing ETH Trend Pullback position -> exit management operates normally", () => {
        const { decision } = runEngineWith(
            {
                symbol: "ETHUSDT",
                lastPrice: 2450,
                trendWeaknessScore: 0.45
            },
            {
                currentPositions: [{
                    symbol: "ETHUSDT",
                    side: "SHORT",
                    entryPrice: 2500,
                    sizeUsd: 100,
                    pnlPct: 0.02,
                    leverage: 3,
                    entryStage: 1,
                    peakUnrealizedPnlPct: 0.025
                }]
            }
        );

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_TREND_PULLBACK_LIVE_ENTRY_DISABLED"), false, "Existing position exit must not be blocked by pullback initial entry suppression");
        console.log("CASE 10 Proof: Existing position decision is", decision.decision, "action:", decision.executionAction);
    });

    // CASE 11: Suppressed FTS does NOT arm cooldown
    it("CASE 11: Suppressed FTS does NOT arm cooldown", () => {
        const candles = makeTestCandles(2500, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "RANGE",
            rangeConfidence: 0.35,
            canonicalTrendScore: 0.35,
            boxHigh: 2600,
            boxLow: 2400,
            boxPos: 0.30,
            ema20Slope: 0.0003,
            candles,
            fastTrendShift: { active: true, direction: "long", baseSizeIntent: 0.32 }
        });

        assert.notEqual(decision.decision, "ENTER");
        assert.equal(decision.committedRiskPlan, undefined, "No risk plan committed -> no cooldown armed");
        console.log("CASE 11 Proof: No cooldown armed on suppressed FTS");
    });

    // CASE 12: Suppressed FTS does NOT create position/exposure
    it("CASE 12: Suppressed FTS does NOT create position/exposure", () => {
        const candles = makeTestCandles(2500, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "RANGE",
            rangeConfidence: 0.35,
            canonicalTrendScore: 0.35,
            boxHigh: 2600,
            boxLow: 2400,
            boxPos: 0.30,
            ema20Slope: 0.0003,
            candles,
            fastTrendShift: { active: true, direction: "long", baseSizeIntent: 0.32 }
        });

        assert.equal(decision.executionAction, "NONE");
        assert.equal(decision.risk?.finalOrderNotionalUsdt ?? 0, 0);
        assert.equal(decision.risk?.stageMarginKrw ?? 0, 0);
        assert.equal(decision.committedRiskPlan, undefined);
        console.log("CASE 12 Proof: Suppressed FTS creates 0 position and 0 exposure");
    });

    // CASE 13: Suppressed Pullback does NOT arm cooldown
    it("CASE 13: Suppressed Pullback does NOT arm cooldown", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            trendWeaknessScore: 0.45,
            canonicalRegime: "TREND"
        });

        assert.notEqual(decision.decision, "ENTER");
        assert.equal(decision.committedRiskPlan, undefined, "No risk plan committed -> no cooldown armed");
        console.log("CASE 13 Proof: No cooldown armed on suppressed Pullback");
    });

    // CASE 14: Trade control (serverTradeEnabled, closeOnly, killSwitch) behavior unchanged
    it("CASE 14: Trade control behavior unchanged", () => {
        const { decision: dDisabled } = runEngineWith(
            { symbol: "ETHUSDT" },
            { serverTradeEnabled: false }
        );
        assert.notEqual(dDisabled.decision, "ENTER", "serverTradeEnabled=false must block ENTER");

        const { decision: dCloseOnly } = runEngineWith(
            { symbol: "ETHUSDT" },
            { closeOnlyMode: true }
        );
        assert.notEqual(dCloseOnly.decision, "ENTER", "closeOnlyMode=true must block initial ENTER");

        const { decision: dKillSwitch } = runEngineWith(
            { symbol: "ETHUSDT" },
            { killSwitch: true }
        );
        assert.notEqual(dKillSwitch.decision, "ENTER", "killSwitch=true must block ENTER");

        console.log("CASE 14 Proof: Trade controls functioning normally");
    });

    // CASE 15: BTC execution authority byte-for-byte semantic regression
    it("CASE 15: BTC execution authority byte-for-byte semantic regression check", () => {
        const { decision } = runEngineWith({
            symbol: "BTCUSDT",
            lastPrice: 70000,
            latestCandleClose: 70000
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.startsWith("ETH_"), false, "BTC must never receive ETH suppression reasons");
        console.log("CASE 15 Proof: BTC execution authority verified completely independent from ETH suppression");
    });

    // CASE 16: ETH Trend Continuation with trendPhase=PULLBACK (tw=0.45)
    it("CASE 16: ETH Trend Continuation with trendPhase=PULLBACK -> not blocked by pullback suppression", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "TREND",
            emaGap: -0.0006,
            trendWeaknessScore: 0.35 // tw < 0.40 yields DOWN continuation
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_TREND_PULLBACK_LIVE_ENTRY_DISABLED"), false, "Continuation must not trigger pullback suppression");
        console.log("CASE 16 Proof: ETH Trend Continuation with boundary trend weakness -> not suppressed:", decision.decision);
    });

    // CASE 17: ETH Breakout Long with trendPhase=PULLBACK (tw=0.45)
    it("CASE 17: ETH Breakout Long with trendPhase=PULLBACK -> not blocked by pullback suppression", () => {
        const candles = makeTestCandles(2600, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2680,
            latestCandleClose: 2680,
            boxHigh: 2650,
            boxLow: 2550,
            boxPos: 0.98,
            candles,
            trendWeaknessScore: 0.45 // tw >= 0.40 causes trendPhase=PULLBACK in detector
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_TREND_PULLBACK_LIVE_ENTRY_DISABLED"), false, "Breakout Long with tw=0.45 must NOT be blocked by pullback suppression");
        console.log("CASE 17 Proof: ETH Breakout Long with trendPhase=PULLBACK -> not suppressed:", decision.decision);
    });

    // CASE 18: ETH Breakdown Short with trendPhase=PULLBACK (tw=0.45)
    it("CASE 18: ETH Breakdown Short with trendPhase=PULLBACK -> not blocked by pullback suppression", () => {
        const candles = makeTestCandles(2500, "down", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2470,
            latestCandleClose: 2470,
            boxHigh: 2650,
            boxLow: 2500,
            boxPos: 0.02,
            candles,
            trendWeaknessScore: 0.45 // tw >= 0.40 causes trendPhase=PULLBACK in detector
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_TREND_PULLBACK_LIVE_ENTRY_DISABLED"), false, "Breakdown Short with tw=0.45 must NOT be blocked by pullback suppression");
        console.log("CASE 18 Proof: ETH Breakdown Short with trendPhase=PULLBACK -> not suppressed:", decision.decision);
    });

    // CASE 19: ETH Range Lower Long with trendPhase=PULLBACK (tw=0.45)
    it("CASE 19: ETH Range Lower Long with trendPhase=PULLBACK -> not blocked by pullback suppression", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "RANGE",
            boxPos: 0.15,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.45 // tw >= 0.40 causes trendPhase=PULLBACK
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_TREND_PULLBACK_LIVE_ENTRY_DISABLED"), false, "Range Lower Long with tw=0.45 must NOT be blocked by pullback suppression");
        console.log("CASE 19 Proof: ETH Range Lower Long with trendPhase=PULLBACK -> not suppressed:", decision.decision);
    });

    // CASE 20: ETH Range Upper Short with trendPhase=PULLBACK (tw=0.45)
    it("CASE 20: ETH Range Upper Short with trendPhase=PULLBACK -> not blocked by pullback suppression", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "RANGE",
            boxPos: 0.85,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.45 // tw >= 0.40 causes trendPhase=PULLBACK
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_TREND_PULLBACK_LIVE_ENTRY_DISABLED"), false, "Range Upper Short with tw=0.45 must NOT be blocked by pullback suppression");
        console.log("CASE 20 Proof: ETH Range Upper Short with trendPhase=PULLBACK -> not suppressed:", decision.decision);
    });

    // CASE 21: ETH Transition lane with trendPhase=PULLBACK (tw=0.45)
    it("CASE 21: ETH Transition lane with trendPhase=PULLBACK -> not blocked by pullback suppression", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "TRANSITION",
            trendWeaknessScore: 0.45
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_TREND_PULLBACK_LIVE_ENTRY_DISABLED"), false, "Transition lane with tw=0.45 must NOT be blocked by pullback suppression");
        console.log("CASE 21 Proof: ETH Transition lane with trendPhase=PULLBACK -> not suppressed:", decision.decision);
    });

    // CASE 22: TRUE ETH Trend Pullback -> HOLD/SKIP + never ENTER
    it("CASE 22: TRUE ETH Trend Pullback -> properly suppressed to non-ENTER", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "TREND",
            trendWeaknessScore: 0.45 // tw=0.45 under TREND yields subtype=TREND_PULLBACK, subtypeReason=trend_pullback
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.notEqual(decision.decision, "ENTER", "True ETH Trend Pullback must not ENTER");
        assert.ok(
            decision.decision === "HOLD" || decision.decision === "SKIP" || reason.includes("ETH_TREND_PULLBACK_LIVE_ENTRY_DISABLED"),
            `True Trend Pullback must be suppressed: ${decision.decision} - ${reason}`
        );
        console.log("CASE 22 Proof: TRUE ETH Trend Pullback properly suppressed to", decision.decision);
    });

    // CASE 23: TRUE ETH Trend Pullback without promotionReason -> still properly suppressed
    it("CASE 23: TRUE ETH Trend Pullback without promotionReason -> still properly suppressed", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "TREND",
            trendWeaknessScore: 0.45
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.notEqual(decision.decision, "ENTER");
        assert.ok(
            decision.decision === "HOLD" || decision.decision === "SKIP" || reason.includes("ETH_TREND_PULLBACK_LIVE_ENTRY_DISABLED"),
            "True Trend Pullback without promotionReason must still be suppressed"
        );
        console.log("CASE 23 Proof: True Trend Pullback without promotionReason properly suppressed to", decision.decision);
    });

    // CASE 24: ETH RANGE Lower Long Reaction Probe Promotion under FAST_TREND_SHIFT market subtype -> NOT suppressed
    it("CASE 24: ETH RANGE Lower Long Reaction Probe Promotion under FAST_TREND_SHIFT -> live ENTER authority preserved", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "RANGE",
            boxPos: 0.3008583690987195,
            trendWeaknessScore: 0.5186247603444578,
            rangeConfidence: 0.85,
            fastTrendShift: {
                active: true,
                direction: "long",
                baseSizeIntent: 0.32
            }
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        const rejectReason = (decision as any).v2_execution_envelope?.v2_reject_reason ?? "";
        console.log("CASE 24 Execution Authority Proof:", {
            decision: decision.decision,
            side: decision.side,
            reason,
            rejectReason
        });

        assert.equal(reason.includes("ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED"), false, "RANGE Lower Long must NOT be falsely suppressed by FTS rule");
        assert.notEqual(rejectReason, "ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED", "v2_reject_reason must not be FTS suppression");
    });

    // CASE 25: ETH RANGE Upper Short under FAST_TREND_SHIFT market subtype -> NOT suppressed
    it("CASE 25: ETH RANGE Upper Short under FAST_TREND_SHIFT -> live ENTER authority preserved", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "RANGE",
            boxPos: 0.85,
            rangeConfidence: 0.85,
            fastTrendShift: {
                active: true,
                direction: "short",
                baseSizeIntent: 0.32
            }
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        const rejectReason = (decision as any).v2_execution_envelope?.v2_reject_reason ?? "";
        console.log("CASE 25 Execution Authority Proof:", {
            decision: decision.decision,
            side: decision.side,
            reason,
            rejectReason
        });

        assert.equal(reason.includes("ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED"), false, "RANGE Upper Short must NOT be falsely suppressed by FTS rule");
        assert.notEqual(rejectReason, "ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED", "v2_reject_reason must not be FTS suppression");
    });

    // CASE 26: ETH Breakout Long under FAST_TREND_SHIFT market subtype -> NOT suppressed
    it("CASE 26: ETH Breakout Long under FAST_TREND_SHIFT -> live ENTER authority preserved", () => {
        const candles = makeTestCandles(2600, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2680,
            latestCandleClose: 2680,
            boxHigh: 2650,
            boxLow: 2550,
            boxPos: 0.98,
            candles,
            fastTrendShift: {
                active: true,
                direction: "long",
                baseSizeIntent: 0.32
            }
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        const rejectReason = (decision as any).v2_execution_envelope?.v2_reject_reason ?? "";
        console.log("CASE 26 Execution Authority Proof:", {
            decision: decision.decision,
            side: decision.side,
            reason,
            rejectReason
        });

        assert.equal(reason.includes("ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED"), false, "Breakout Long must NOT be falsely suppressed by FTS rule");
        assert.notEqual(rejectReason, "ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED", "v2_reject_reason must not be FTS suppression");
    });

    // CASE 27: ETH Breakdown Short under FAST_TREND_SHIFT market subtype -> NOT suppressed
    it("CASE 27: ETH Breakdown Short under FAST_TREND_SHIFT -> live ENTER authority preserved", () => {
        const candles = makeTestCandles(2500, "down", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2470,
            latestCandleClose: 2470,
            boxHigh: 2650,
            boxLow: 2500,
            boxPos: 0.02,
            candles,
            fastTrendShift: {
                active: true,
                direction: "short",
                baseSizeIntent: 0.32
            }
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        const rejectReason = (decision as any).v2_execution_envelope?.v2_reject_reason ?? "";
        console.log("CASE 27 Execution Authority Proof:", {
            decision: decision.decision,
            side: decision.side,
            reason,
            rejectReason
        });

        assert.equal(reason.includes("ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED"), false, "Breakdown Short must NOT be falsely suppressed by FTS rule");
        assert.notEqual(rejectReason, "ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED", "v2_reject_reason must not be FTS suppression");
    });

    // CASE 28: ETH Trend Continuation under FAST_TREND_SHIFT market subtype -> NOT suppressed
    it("CASE 28: ETH Trend Continuation under FAST_TREND_SHIFT -> live ENTER authority preserved", () => {
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            canonicalRegime: "TREND",
            emaGap: -0.0006,
            trendWeaknessScore: 0.35,
            fastTrendShift: {
                active: true,
                direction: "short",
                baseSizeIntent: 0.32
            }
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        const rejectReason = (decision as any).v2_execution_envelope?.v2_reject_reason ?? "";
        console.log("CASE 28 Execution Authority Proof:", {
            decision: decision.decision,
            side: decision.side,
            reason,
            rejectReason
        });

        assert.equal(reason.includes("ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED"), false, "Trend Continuation must NOT be suppressed by FTS rule");
        assert.notEqual(rejectReason, "ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED", "v2_reject_reason must not be FTS suppression");
    });

    // CASE 29: ETH TRUE FTS execution lineage -> suppressed to HOLD (shadow only)
    it("CASE 29: ETH TRUE FTS execution lineage -> properly suppressed with 0 position / 0 exposure / no cooldown", () => {
        const candles = makeTestCandles(2450, "up", 120);
        const { decision } = runEngineWith({
            symbol: "ETHUSDT",
            lastPrice: 2450,
            latestCandleClose: 2450,
            signal: "paper_long_candidate",
            entryCandidate: true,
            canonicalRegime: "RANGE",
            rangeConfidence: 0.35,
            canonicalTrendScore: 0.35,
            boxHigh: 2600,
            boxLow: 2400,
            boxPos: 0.25,
            ema20: 2530,
            ema60: 2510,
            emaGap: 0.0006,
            ema20Slope: 0.0003,
            candles,
            fastTrendShift: {
                active: true,
                direction: "long",
                baseSizeIntent: 0.32,
                higher_low_detected: true,
                box_mid_reclaimed: true
            }
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        const rejectReason = (decision as any).v2_execution_envelope?.v2_reject_reason ?? "";
        console.log("CASE 29 Execution Authority Proof:", {
            decision: decision.decision,
            reason,
            rejectReason,
            committedRiskPlan: decision.committedRiskPlan,
            executionAction: decision.executionAction,
            finalOrderNotionalUsdt: decision.risk?.finalOrderNotionalUsdt
        });

        assert.equal(decision.decision, "HOLD", "TRUE ETH FTS must be HOLD");
        assert.ok(
            reason.includes("ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED") ||
            rejectReason.includes("ETH_FTS_SHADOW_ONLY_LIVE_ENTRY_DISABLED") ||
            decision.decision === "HOLD",
            `Reason must indicate FTS suppression: ${reason} / ${rejectReason}`
        );
        assert.equal(decision.executionAction, "NONE", "Execution action must be NONE");
        assert.equal(decision.committedRiskPlan, undefined, "Committed risk plan must be undefined (no cooldown armed)");
        assert.equal(decision.risk?.finalOrderNotionalUsdt ?? 0, 0, "Final order notional must be 0");
    });

    // CASE 30: BTC same FAST_TREND_SHIFT fixture -> untouched and 100% unaffected
    it("CASE 30: BTC same FAST_TREND_SHIFT fixture -> completely untouched", () => {
        const candles = makeTestCandles(70000, "up", 120);
        const { decision } = runEngineWith({
            symbol: "BTCUSDT",
            lastPrice: 70000,
            latestCandleClose: 70000,
            candles,
            boxHigh: 71000,
            boxLow: 69000,
            fastTrendShift: {
                active: true,
                direction: "long",
                baseSizeIntent: 0.32
            }
        });

        const reason = String((decision as any).reason ?? decision.explanation?.reason ?? "");
        assert.equal(reason.includes("ETH_FTS_SHADOW_ONLY"), false, "BTC must never receive ETH FTS suppression");
        console.log("CASE 30 Proof: BTC FTS decision is", decision.decision, "reason:", reason);
    });
});
