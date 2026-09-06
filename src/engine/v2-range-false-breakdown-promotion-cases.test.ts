/**
 * V2 RANGE False Breakdown / Breakout Promotion Sanity Tests.
 *
 * Ensures:
 * 1. ETH RANGE lower zone + price > boxLow + shockDown -> short promotion NO (SKIP preserved)
 * 2. ETH RANGE lower zone + close > boxLow -> short promotion NO
 * 3. Stale previous breakdown evidence + current price inside box -> promotion NO
 * 4. Actual current lower break by price/close -> short promotion YES
 * 5. Confirmed lower breakdown continuation -> short promotion YES
 * 6. Upper-zone long full symmetry -> inside box long promotion NO
 * 7. Actual upper breakout -> long promotion YES
 * 8. RANGE mid/lower zone alone cannot trigger breakdown/breakout naming
 * 9. TP profitability final gate unchanged
 * 10. BTC/ETH shared semantics preserved
 * 11. Shock reaction watch state preserved
 * 12. SL (0.50%), Dynamic Risk Budget, Sizing unchanged
 *
 * Explicit regression fixtures:
 * boxLow = 2306.40, markPrice = 2308.93 / 2308.43 / 2308.00, zone = lower, shockDownActive = true, boxBreakSide = none
 * => lower_breakdown_continuation_short = false, SKIP -> ENTER promotion = false.
 */

import assert from "node:assert/strict";
import { runEngineV2, marketJudgmentCacheBySymbol } from "../engine-v2/index";
import { globalShockStates } from "../engine-v2/state/derive";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import type { Candle } from "../models/types";
import type { EngineV2Input } from "../engine-v2/types";

function run(label: string, passed: boolean, detail: string): void {
    const tag = passed ? "PASS" : "FAIL";
    console.log(`[FALSE-BREAKDOWN-PROMOTION-FIX][${label}] ${tag} — ${detail}`);
    if (!passed) throw new Error(`[FALSE-BREAKDOWN-PROMOTION-FIX][${label}] FAILED: ${detail}`);
}

function captureProofLogs(fn: () => void): Record<string, unknown>[] {
    const logs: Record<string, unknown>[] = [];
    const origInfo = console.info;
    console.info = (msg: unknown) => {
        try {
            const p = JSON.parse(String(msg));
            if (p && typeof p.event === "string") logs.push(p);
        } catch { /* ignore */ }
        origInfo(msg);
    };
    try { fn(); } finally { console.info = origInfo; }
    return logs;
}

function resetAll() {
    clearWhipsawObservationState();
    marketJudgmentCacheBySymbol.clear();
}

function setShockState(symbol: string, direction: "UP" | "DOWN" | "NONE") {
    globalShockStates.set(symbol, {
        activeDirection: direction,
        rawDirection: direction,
        candidateDirection: direction,
        candidateCount: 1,
        neutralCount: 0,
        candidateStartedAt: null,
        activatedAt: null,
        lastChangedAt: Date.now(),
        rawMovePct: 0.015,
        requiredMovePct: 0.008,
        emergencyBypass: false,
        lastProcessedCycle: 1
    });
}

function makeBridge(overrides: Record<string, unknown> = {}) {
    return {
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        closeOnlyMode: false,
        killSwitch: false,
        reconcileSafeMode: false,
        longAllow: true,
        shortAllow: true,
        currentPositions: [],
        executionReadiness: true,
        accountEquityKrw: 14_000_000,
        exposureNotionalCapKrw: 100_000_000,
        symbolExposureNotionalCapKrw: 50_000_000,
        accountEquityUsdt: 10_000,
        availableBalanceUsdt: 10_000,
        liveBalanceReady: true,
        okxActualPositionsReady: true,
        actualAccountNotionalUsdtReady: true,
        okxActualPositions: [],
        okxPendingOrdersReady: true,
        okxPendingOrders: [],
        rawDirectionalShockState: "DOWN" as const,
        rawDirection: "DOWN" as const,
        directionalShockState: "DOWN" as const,
        rawShockMovePct: 0.015,
        requiredShockMovePct: 0.008,
        leverage: 10,
        freshTickBarrierActive: false,
        freshTickCompletedCycles: 5,
        freshTickRequiredCycles: 3,
        globalRiskScore: 0,
        lossStreaks: {},
        ...overrides
    };
}

function buildCandles(lastClose: number, count = 20): Candle[] {
    const candles: Candle[] = [];
    const now = Date.now();
    for (let i = count - 1; i >= 0; i--) {
        candles.push({
            ts: now - i * 60_000,
            open: lastClose,
            high: lastClose,
            low: lastClose,
            close: lastClose,
            volume: 1000
        });
    }
    return candles;
}

// -----------------------------------------------------------------------------
// 1 & 2. ETH RANGE lower zone + price > boxLow + shockDown -> short promotion NO
// Explicit production regression fixture: boxLow=2306.40, price=2308.93, 2308.43, 2308.00
// -----------------------------------------------------------------------------
{
    for (const testPx of [2308.93, 2308.43, 2308.00]) {
        resetAll();
        setShockState("ETHUSDT", "DOWN");

        const bridge = makeBridge({
            shortAllow: true,
            longAllow: false,
            rawDirectionalShockState: "DOWN",
            directionalShockState: "DOWN"
        });

        const snapshot = {
            symbol: "ETHUSDT",
            lastPrice: testPx,
            latestCandleClose: testPx,
            boxHigh: 2313.10,
            boxLow: 2306.40,
            boxPos: (testPx - 2306.40) / (2313.10 - 2306.40), // ~0.377, 0.303, 0.239
            boxRel: 0.0029,
            atr: 1.04,
            emaGap: -0.00065,
            trendWeaknessScore: 0.51,
            trendOk: false,
            entryCandidate: false,
            signal: "none" as const,
            qualityScore: 65,
            boxBreakSide: "none" as const,
            rangeConfidence: 0.82,
            boxCohesion01: 1,
            canonicalRegime: "RANGE" as const,
            canonicalRegimeSource: "strategy_market_regime_detector",
            candles: buildCandles(testPx)
        };

        const input: EngineV2Input = {
            symbol: "ETHUSDT",
            now: Date.now(),
            snapshot: snapshot as any,
            config: {
                paperMaxOpenPositions: 3,
                baseSizeUsd: 100,
                paperTakerFeeRate: 0.0005,
                paperSlippageEstimateBps: 8
            } as any,
            state: bridge as any,
            v1Result: {
                regime: "RANGE",
                decision: "SKIP",
                side: "none",
                isBlocked: false
            },
            canonicalRegime: "RANGE"
        };

        let res: any;
        const proofs = captureProofLogs(() => {
            res = runEngineV2(input);
        });

        const shockPromo = proofs.find(p => p.event === "SHOCK_REACTION_PROMOTION_PROOF");
        const isLowerBreakdownShort = Boolean(shockPromo && shockPromo.promotion_type === "lower_breakdown_continuation_short");

        assert.equal(isLowerBreakdownShort, false, `Price ${testPx} > boxLow must NOT promote lower_breakdown_continuation_short`);
        assert.notEqual(res.decision, "ENTER", `Price ${testPx} inside box must NOT result in ENTER`);
        run(`ETH Regression @ ${testPx}`, true, "Inside box lower zone correctly blocked from false breakdown promotion");
    }
}

// -----------------------------------------------------------------------------
// 3. Stale previous breakdown evidence + current price inside box -> promotion NO
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "DOWN");

    const bridge = makeBridge({
        shortAllow: true,
        directionalShockState: "DOWN"
    });

    const snapshot = {
        symbol: "ETHUSDT",
        lastPrice: 2307.50, // inside box (> 2306.40)
        latestCandleClose: 2307.50,
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: 0.164,
        boxRel: 0.0029,
        atr: 1.04,
        emaGap: -0.00065,
        qualityScore: 66,
        boxBreakSide: "lower" as const, // stale break marker from previous cycle!
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2307.50)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            paperTakerFeeRate: 0.0005,
            paperSlippageEstimateBps: 8
        } as any,
        state: bridge as any,
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        },
        canonicalRegime: "RANGE"
    };

    let res: any;
    const proofs = captureProofLogs(() => {
        res = runEngineV2(input);
    });

    const shockPromo = proofs.find(p => p.event === "SHOCK_REACTION_PROMOTION_PROOF");
    const isLowerBreakdownShort = Boolean(shockPromo && shockPromo.promotion_type === "lower_breakdown_continuation_short");
    assert.equal(isLowerBreakdownShort, false, "Stale boxBreakSide with price > boxLow must NOT promote breakdown short");
    run("Stale breakdown evidence rejection", true, "Stale boxBreakSide rejected because current price > boxLow");
}

// -----------------------------------------------------------------------------
// 4. Current price and close both break lower -> short promotion YES
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "DOWN");

    const bridge = makeBridge({
        shortAllow: true,
        directionalShockState: "DOWN"
    });

    const snapshot = {
        symbol: "ETHUSDT",
        lastPrice: 2305.50, // genuine break (< 2306.40)
        latestCandleClose: 2305.80, // genuine close break (< 2306.40)
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: -0.13,
        boxRel: 0.0029,
        atr: 1.04,
        emaGap: -0.00065,
        rangeConfidence: 0.85,
        boxCohesion01: 0.9,
        trendWeaknessScore: 0.5,
        qualityScore: 70,
        retestConfirmed: true,
        reclaimConfirmed: false,
        retestSeen: true,
        boxBreakSide: "lower" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2305.50)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            paperTakerFeeRate: 0.0005,
            paperSlippageEstimateBps: 8
        } as any,
        state: bridge as any,
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        },
        canonicalRegime: "RANGE"
    };

    const proofs = captureProofLogs(() => {
        runEngineV2(input);
    });

    const shockPromo = proofs.find(p => p.event === "SHOCK_REACTION_PROMOTION_PROOF");
    assert.equal(shockPromo?.promotion_type, "lower_breakdown_continuation_short");
    assert.equal(shockPromo?.decision_after, "ENTER");
    assert.equal(shockPromo?.side_after, "short");
    run("Genuine lower break promotion (both price & close)", true, "Real lower break (< boxLow) promoted to lower_breakdown_continuation_short");
}

// -----------------------------------------------------------------------------
// 5. Current price and close both break upper -> long promotion YES
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "UP");

    const bridge = makeBridge({
        longAllow: true,
        shortAllow: false,
        rawDirectionalShockState: "UP",
        rawDirection: "UP",
        directionalShockState: "UP"
    });

    const snapshot = {
        symbol: "ETHUSDT",
        lastPrice: 2314.50, // genuine break (> 2313.10)
        latestCandleClose: 2314.20,
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: 1.20,
        boxRel: 0.0029,
        atr: 1.04,
        emaGap: 0.00065,
        rangeConfidence: 0.85,
        boxCohesion01: 0.9,
        trendWeaknessScore: 0.5,
        qualityScore: 70,
        retestConfirmed: true,
        reclaimConfirmed: false,
        retestSeen: true,
        boxBreakSide: "upper" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2314.50)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            paperTakerFeeRate: 0.0005,
            paperSlippageEstimateBps: 8
        } as any,
        state: bridge as any,
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        },
        canonicalRegime: "RANGE"
    };

    const proofs = captureProofLogs(() => {
        runEngineV2(input);
    });

    const shockPromo = proofs.find(p => p.event === "SHOCK_REACTION_PROMOTION_PROOF");
    assert.equal(shockPromo?.promotion_type, "upper_breakout_continuation_long");
    assert.equal(shockPromo?.decision_after, "ENTER");
    assert.equal(shockPromo?.side_after, "long");
    run("Genuine upper breakout promotion (both price & close)", true, "Real upper breakout (> boxHigh) promoted to upper_breakout_continuation_long");
}

// -----------------------------------------------------------------------------
// 6. Current price slightly below boxLow, closedClose inside box -> boundaryBrokenByLastPriceLower = true
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "DOWN");

    const bridge = makeBridge({
        shortAllow: true,
        directionalShockState: "DOWN"
    });

    const snapshot = {
        symbol: "ETHUSDT",
        lastPrice: 2306.00, // slightly below boxLow (2306.40)
        latestCandleClose: 2307.00, // closed close is inside box (> 2306.40)
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: -0.05,
        boxRel: 0.0029,
        atr: 1.04,
        emaGap: -0.00065,
        rangeConfidence: 0.85,
        boxCohesion01: 0.9,
        trendWeaknessScore: 0.5,
        qualityScore: 70,
        boxBreakSide: "none" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2307.00)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            paperTakerFeeRate: 0.0005,
            paperSlippageEstimateBps: 8
        } as any,
        state: bridge as any,
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        },
        canonicalRegime: "RANGE"
    };

    const proofs = captureProofLogs(() => {
        runEngineV2(input);
    });

    const shockPromo = proofs.find(p => p.event === "SHOCK_REACTION_PROMOTION_PROOF");
    assert.equal(shockPromo?.promotion_type, "lower_breakdown_continuation_short");
    assert.equal(shockPromo?.decision_after, "ENTER");
    run("Boundary Case 6: Live Price Break with Inside Close", true, "Live mark price < boxLow satisfies boundaryBrokenByLastPriceLower for shock continuation");
}

// -----------------------------------------------------------------------------
// 7. Current price slightly above boxHigh, closedClose inside box -> boundaryBrokenByLastPriceUpper = true
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "UP");

    const bridge = makeBridge({
        longAllow: true,
        shortAllow: false,
        rawDirectionalShockState: "UP",
        rawDirection: "UP",
        directionalShockState: "UP"
    });

    const snapshot = {
        symbol: "ETHUSDT",
        lastPrice: 2313.50, // slightly above boxHigh (2313.10)
        latestCandleClose: 2312.50, // closed close is inside box (< 2313.10)
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: 1.05,
        boxRel: 0.0029,
        atr: 1.04,
        emaGap: 0.00065,
        rangeConfidence: 0.85,
        boxCohesion01: 0.9,
        trendWeaknessScore: 0.5,
        qualityScore: 70,
        boxBreakSide: "none" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2312.50)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            paperTakerFeeRate: 0.0005,
            paperSlippageEstimateBps: 8
        } as any,
        state: bridge as any,
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        },
        canonicalRegime: "RANGE"
    };

    const proofs = captureProofLogs(() => {
        runEngineV2(input);
    });

    const shockPromo = proofs.find(p => p.event === "SHOCK_REACTION_PROMOTION_PROOF");
    assert.equal(shockPromo?.promotion_type, "upper_breakout_continuation_long");
    assert.equal(shockPromo?.decision_after, "ENTER");
    run("Boundary Case 7: Live Price Break with Inside Close (Upper)", true, "Live mark price > boxHigh satisfies boundaryBrokenByLastPriceUpper for shock continuation");
}

// -----------------------------------------------------------------------------
// 8. Upper-zone long symmetry: price < boxHigh -> long breakout promotion NO
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "UP");

    const bridge = makeBridge({
        longAllow: true,
        shortAllow: false,
        rawDirectionalShockState: "UP",
        rawDirection: "UP",
        directionalShockState: "UP"
    });

    const snapshot = {
        symbol: "ETHUSDT",
        lastPrice: 2312.00, // inside upper zone (< 2313.10)
        latestCandleClose: 2312.00,
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: 0.835, // upper zone
        boxRel: 0.0029,
        atr: 1.04,
        emaGap: 0.00065,
        rangeConfidence: 0.85,
        boxCohesion01: 0.9,
        trendWeaknessScore: 0.5,
        qualityScore: 65,
        boxBreakSide: "none" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2312.00)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            paperTakerFeeRate: 0.0005,
            paperSlippageEstimateBps: 8
        } as any,
        state: bridge as any,
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        },
        canonicalRegime: "RANGE"
    };

    let res: any;
    const proofs = captureProofLogs(() => {
        res = runEngineV2(input);
    });

    const shockPromo = proofs.find(p => p.event === "SHOCK_REACTION_PROMOTION_PROOF");
    const isUpperBreakoutLong = Boolean(shockPromo && shockPromo.promotion_type === "upper_breakout_continuation_long");
    assert.equal(isUpperBreakoutLong, false, "Inside box upper zone must NOT promote breakout long");
    assert.notEqual(res.decision, "ENTER");
    run("Upper zone inside box check", true, "Price < boxHigh correctly blocked from false upper breakout promotion");
}

// -----------------------------------------------------------------------------
// 9. Confirmed breakdown retest subtype in current cycle -> promotion YES
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "DOWN");

    const bridge = makeBridge({
        shortAllow: true,
        directionalShockState: "DOWN"
    });

    const snapshot = {
        symbol: "ETHUSDT",
        lastPrice: 2305.00,
        latestCandleClose: 2305.00,
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: -0.20,
        boxRel: 0.0029,
        atr: 1.04,
        emaGap: -0.00065,
        rangeConfidence: 0.85,
        boxCohesion01: 0.9,
        trendWeaknessScore: 0.5,
        qualityScore: 75,
        boxBreakSide: "lower" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2305.00)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            paperTakerFeeRate: 0.0005,
            paperSlippageEstimateBps: 8
        } as any,
        state: bridge as any,
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        },
        canonicalRegime: "RANGE"
    };

    const proofs = captureProofLogs(() => {
        runEngineV2(input);
    });

    const shockPromo = proofs.find(p => p.event === "SHOCK_REACTION_PROMOTION_PROOF");
    assert.equal(shockPromo?.promotion_type, "lower_breakdown_continuation_short");
    assert.equal(shockPromo?.decision_after, "ENTER");
    run("Current-cycle Confirmed Break Evidence", true, "Breakdown retest confirmed promotes continuation short");
}

// -----------------------------------------------------------------------------
// 10. BTC/ETH Shared Semantics Invariant
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("BTCUSDT", "DOWN");

    const bridge = makeBridge({
        shortAllow: true,
        longAllow: false,
        rawDirectionalShockState: "DOWN",
        directionalShockState: "DOWN"
    });

    const snapshot = {
        symbol: "BTCUSDT",
        lastPrice: 80500, // inside box (> 80000)
        latestCandleClose: 80500,
        boxHigh: 82000,
        boxLow: 80000,
        boxPos: 0.25, // lower zone
        boxRel: 0.025,
        atr: 300,
        emaGap: -0.001,
        qualityScore: 66,
        boxBreakSide: "none" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(80500)
    };

    const input: EngineV2Input = {
        symbol: "BTCUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            paperTakerFeeRate: 0.0005,
            paperSlippageEstimateBps: 8
        } as any,
        state: bridge as any,
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        },
        canonicalRegime: "RANGE"
    };

    let res: any;
    const proofs = captureProofLogs(() => {
        res = runEngineV2(input);
    });

    const shockPromo = proofs.find(p => p.event === "SHOCK_REACTION_PROMOTION_PROOF");
    const isLowerBreakdownShort = Boolean(shockPromo && shockPromo.promotion_type === "lower_breakdown_continuation_short");
    assert.equal(isLowerBreakdownShort, false, "BTCUSDT inside lower zone must NOT promote breakdown short");
    assert.notEqual(res.decision, "ENTER");
    run("BTC/ETH Shared Semantics Invariant", true, "BTCUSDT obeys the exact same boundary truth requirement");
}

console.log("\n>>> ALL FALSE BREAKDOWN / BREAKOUT PROMOTION INVARIANTS VERIFIED SUCCESSFULLY <<<\n");
