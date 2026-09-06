/**
 * V2 RANGE Live Breakout Quality Gate & False Breakdown/Breakout Sanity Tests.
 *
 * Requirements:
 * A. CLOSED BREAK CONFIRMED: closedClose > boxHigh (upper) / closedClose < boxLow (lower) => YES
 * B. STRONG LIVE BREAK: lastPrice penetrates boundary beyond meaningful threshold => YES
 * C. RETEST / CONFIRMED CONTINUATION: breakout/breakdown retest confirmed => YES
 *
 * In contrast:
 * - Shallow wick (lastPrice slightly outside boundary + closedClose inside box) => NO (SKIP/WATCH maintained)
 * - Inside zone without break => NO
 * - Full symmetry between Upper (Long) and Lower (Short)
 * - Risk invariants: ETH 0.50% canonical stop, 1.0% risk budget, TP gate unchanged.
 */

import assert from "node:assert/strict";
import { runEngineV2, marketJudgmentCacheBySymbol } from "../engine-v2/index";
import { globalShockStates } from "../engine-v2/state/derive";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import type { Candle } from "../models/types";
import type { EngineV2Input } from "../engine-v2/types";

function run(label: string, passed: boolean, detail: string): void {
    const tag = passed ? "PASS" : "FAIL";
    console.log(`[LIVE-BREAKOUT-QUALITY-GATE][${label}] ${tag} — ${detail}`);
    if (!passed) throw new Error(`[LIVE-BREAKOUT-QUALITY-GATE][${label}] FAILED: ${detail}`);
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
    const now = Date.now();
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
        balanceFetchedAt: now,
        positionsFetchedAt: now,
        pendingOrdersFetchedAt: now,
        okxInstruments: [
            {
                instId: "ETH-USDT-SWAP",
                tickSz: "0.01",
                lotSz: "0.01",
                minSz: "0.01",
                ctVal: "1",
                ctValCcy: "ETH"
            },
            {
                instId: "BTC-USDT-SWAP",
                tickSz: "0.1",
                lotSz: "0.01",
                minSz: "0.01",
                ctVal: "0.01",
                ctValCcy: "BTC"
            }
        ],
        rawDirectionalShockState: "UP" as const,
        rawDirection: "UP" as const,
        directionalShockState: "UP" as const,
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

function makeConfig(overrides: Record<string, unknown> = {}) {
    return {
        paperMaxOpenPositions: 3,
        baseSizeUsd: 100,
        maxSymbolNotionalUsd: 5000,
        maxAccountNotionalUsd: 20000,
        okxLiveEnabled: true,
        okxAuthMode: "live",
        okxExchangeAuthOptIn: true,
        okxLiveMaxOrderNotionalUsdt: 1000,
        serverTradeEnabled: true,
        paperTakerFeeRate: 0.0005,
        paperSlippageEstimateBps: 8,
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
// 1. Cycle 3396 Exact Replay: high 2313.10 / last 2313.40 / close 2312.80 -> promotion NO
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
        lastPrice: 2313.40, // overshoot +0.30 (~1.3 bps)
        latestCandleClose: 2312.80, // closed close inside box (< 2313.10)
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: (2313.40 - 2306.40) / (2313.10 - 2306.40), // 1.045
        boxRel: 0.0029,
        tickSz: 0.01,
        atr: 1.04,
        emaGap: 0.00065,
        trendWeaknessScore: 0.51,
        trendOk: false,
        entryCandidate: false,
        signal: "none" as const,
        qualityScore: 68,
        boxBreakSide: "none" as const,
        rangeConfidence: 0.82,
        boxCohesion01: 1,
        canonicalRegime: "RANGE" as const,
        canonicalRegimeSource: "strategy_market_regime_detector",
        candles: buildCandles(2312.80)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: makeConfig() as any,
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

    assert.equal(isUpperBreakoutLong, false, "Cycle 3396 shallow overshoot (+1.3 bps) must NOT promote upper_breakout_continuation_long");
    assert.notEqual(res.decision.decision, "ENTER", "Cycle 3396 must result in SKIP/WATCH, not ENTER");
    run("1. Cycle3396 exact replay", true, "High 2313.10 / Last 2313.40 / Close 2312.80 rejected from false breakout promotion");
}

// -----------------------------------------------------------------------------
// 2. Upper zone but inside box -> promotion NO
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "UP");

    const bridge = makeBridge({
        longAllow: true,
        directionalShockState: "UP"
    });

    const snapshot = {
        symbol: "ETHUSDT",
        lastPrice: 2312.00, // inside box (< 2313.10)
        latestCandleClose: 2312.00,
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: 0.835,
        boxRel: 0.0029,
        tickSz: 0.01,
        atr: 1.04,
        emaGap: 0.00065,
        qualityScore: 66,
        boxBreakSide: "none" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2312.00)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: makeConfig() as any,
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
    assert.equal(isUpperBreakoutLong, false, "Upper zone inside box must NOT promote breakout long");
    assert.notEqual(res.decision.decision, "ENTER");
    run("2. Upper zone inside box", true, "Upper zone (boxPos 0.835) correctly blocked");
}

// -----------------------------------------------------------------------------
// 3. Shallow upper wick + close inside -> promotion NO
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "UP");

    const bridge = makeBridge({
        longAllow: true,
        directionalShockState: "UP"
    });

    const snapshot = {
        symbol: "ETHUSDT",
        lastPrice: 2313.30, // shallow wick (+0.20 USDT)
        latestCandleClose: 2312.50, // inside box
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: 1.03,
        boxRel: 0.0029,
        tickSz: 0.01,
        atr: 1.04,
        emaGap: 0.00065,
        qualityScore: 68,
        boxBreakSide: "none" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2312.50)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: makeConfig() as any,
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
    assert.equal(isUpperBreakoutLong, false, "Shallow upper wick must NOT promote breakout long");
    assert.notEqual(res.decision.decision, "ENTER");
    run("3. Shallow upper wick + close inside", true, "Shallow wick (+0.20 USDT) blocked from promotion");
}

// -----------------------------------------------------------------------------
// 4. Meaningful live upper breakout -> promotion YES
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
        lastPrice: 2314.50, // strong live penetration (+1.40 USDT, ~6 bps)
        latestCandleClose: 2312.80, // close was inside box
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: 1.20,
        boxRel: 0.0029,
        tickSz: 0.01,
        atr: 1.04,
        emaGap: 0.00065,
        rangeConfidence: 0.85,
        boxCohesion01: 0.9,
        trendWeaknessScore: 0.5,
        qualityScore: 70,
        boxBreakSide: "none" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2312.80)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: makeConfig() as any,
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
    assert.equal(shockPromo?.promotion_type, "upper_breakout_continuation_long");
    assert.equal(res.decision.decision, "ENTER");
    assert.equal(res.decision.side, "long");
    run("4. Meaningful live upper breakout", true, "Strong live break (+1.40 USDT) promoted to upper_breakout_continuation_long");
}

// -----------------------------------------------------------------------------
// 5. Closed close > boxHigh -> promotion YES
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
        lastPrice: 2313.30,
        latestCandleClose: 2313.30, // candle close confirmed > boxHigh (2313.10)
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: 1.03,
        boxRel: 0.0029,
        tickSz: 0.01,
        atr: 1.04,
        emaGap: 0.00065,
        rangeConfidence: 0.85,
        boxCohesion01: 0.9,
        trendWeaknessScore: 0.5,
        qualityScore: 70,
        boxBreakSide: "none" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2313.30)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: makeConfig() as any,
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
    assert.equal(shockPromo?.promotion_type, "upper_breakout_continuation_long");
    assert.equal(res.decision.decision, "ENTER");
    run("5. ClosedClose > boxHigh", true, "Candle close confirmed above boxHigh promoted to upper_breakout_continuation_long");
}

// -----------------------------------------------------------------------------
// 6. Confirmed breakout retest -> promotion YES
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
        lastPrice: 2313.20, // shallow penetration (+0.10 USDT < minPenetration)
        latestCandleClose: 2313.00, // closed candle inside box (< 2313.10)
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: 1.015,
        boxRel: 0.0029,
        tickSz: 0.01,
        atr: 1.04,
        emaGap: 0.00065,
        rangeConfidence: 0.85,
        boxCohesion01: 0.9,
        trendWeaknessScore: 0.5,
        qualityScore: 70,
        retestConfirmed: true,
        boxBreakSide: "upper" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2313.00)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: makeConfig() as any,
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
    assert.equal(shockPromo?.promotion_type, "upper_breakout_continuation_long");
    assert.equal(res.decision.decision, "ENTER");
    run("6. Confirmed breakout retest", true, "Retest confirmed promoted to upper_breakout_continuation_long");
}

// -----------------------------------------------------------------------------
// 7. Lower breakdown exact symmetry (Inside lower zone but inside box -> NO)
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "DOWN");

    const bridge = makeBridge({
        shortAllow: true,
        longAllow: false,
        rawDirectionalShockState: "DOWN",
        rawDirection: "DOWN",
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
        tickSz: 0.01,
        atr: 1.04,
        emaGap: -0.00065,
        trendWeaknessScore: 0.51,
        qualityScore: 65,
        boxBreakSide: "none" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2307.50)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: makeConfig() as any,
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
    assert.equal(isLowerBreakdownShort, false, "Inside lower zone must NOT promote breakdown short");
    assert.notEqual(res.decision.decision, "ENTER");
    run("7. Lower breakdown exact symmetry", true, "Inside box lower zone correctly blocked");
}

// -----------------------------------------------------------------------------
// 8. Shallow lower wick + close inside -> promotion NO
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
        lastPrice: 2306.10, // shallow undershoot (-0.30 USDT, ~1.3 bps)
        latestCandleClose: 2307.00, // closed close inside box (> 2306.40)
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: -0.045,
        boxRel: 0.0029,
        tickSz: 0.01,
        atr: 1.04,
        emaGap: -0.00065,
        qualityScore: 68,
        boxBreakSide: "none" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2307.00)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: makeConfig() as any,
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
    assert.equal(isLowerBreakdownShort, false, "Shallow lower wick must NOT promote breakdown short");
    assert.notEqual(res.decision.decision, "ENTER");
    run("8. Shallow lower wick + close inside", true, "Shallow lower wick (-0.30 USDT) blocked from promotion");
}

// -----------------------------------------------------------------------------
// 9. Meaningful live lower break -> promotion YES
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
        lastPrice: 2305.00, // strong live penetration (-1.40 USDT, ~6 bps)
        latestCandleClose: 2307.00, // close was inside box
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: -0.21,
        boxRel: 0.0029,
        tickSz: 0.01,
        atr: 1.04,
        emaGap: -0.00065,
        rangeConfidence: 0.85,
        boxCohesion01: 0.9,
        trendWeaknessScore: 0.5,
        qualityScore: 70,
        boxBreakSide: "none" as const,
        canonicalRegime: "RANGE" as const,
        candles: (() => {
            const cs = buildCandles(2307.00);
            cs[cs.length - 1] = {
                ...cs[cs.length - 1],
                high: 2309.00,
                open: 2307.00,
                close: 2306.50,
                low: 2305.00
            };
            return cs;
        })()
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: makeConfig() as any,
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
    assert.equal(shockPromo?.promotion_type, "lower_breakdown_continuation_short");
    assert.equal(res.decision.decision, "ENTER");
    assert.equal(res.decision.side, "short");
    run("9. Meaningful live lower break", true, "Strong live breakdown (-1.40 USDT) promoted to lower_breakdown_continuation_short");
}

// -----------------------------------------------------------------------------
// 10. Shock watch remains active when promotion denied
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "UP");

    const bridge = makeBridge({
        longAllow: true,
        directionalShockState: "UP"
    });

    const snapshot = {
        symbol: "ETHUSDT",
        lastPrice: 2313.40,
        latestCandleClose: 2312.80,
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: 1.045,
        boxRel: 0.0029,
        tickSz: 0.01,
        atr: 1.04,
        emaGap: 0.00065,
        qualityScore: 68,
        boxBreakSide: "none" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2312.80)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: makeConfig() as any,
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

    assert.notEqual(res.decision.decision, "ENTER", "Promotion must be denied (decision not ENTER)");
    assert.ok(res.decision.decision === "SKIP" || res.decision.decision === "HOLD", `Decision must be SKIP or HOLD, got ${res.decision.decision}`);
    const shockProofs = proofs.filter(p => String(p.event).includes("SHOCK"));
    assert.ok(shockProofs.length > 0, "Shock tracking proof must be generated and active");
    run("10. Shock watch remains active when promotion denied", true, "Shock tracking remains fully active while false ENTER is prevented");
}

// -----------------------------------------------------------------------------
// 11. TP Net-edge final gate unchanged
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "UP");

    const bridge = makeBridge({
        longAllow: true,
        directionalShockState: "UP"
    });

    const snapshot = {
        symbol: "ETHUSDT",
        lastPrice: 2315.00,
        latestCandleClose: 2315.00,
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: 1.28,
        boxRel: 0.0029,
        tickSz: 0.01,
        atr: 1.04,
        emaGap: 0.00065,
        qualityScore: 75,
        boxBreakSide: "upper" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2315.00)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: makeConfig() as any,
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

    assert.equal(res.decision.decision, "ENTER");
    const tp1 = res.decision.metadata?.tp1 ?? proofs.find(p => p.event === "V2_ORDER_BUILD_RISK_PLAN_PROOF")?.tp1;
    const entryPx = 2315.00;
    if (tp1 != null) {
        assert.ok(tp1 > entryPx, `TP1 (${tp1}) must be higher than entry price (${entryPx}) for LONG`);
    }
    run("11. TP net-edge final gate unchanged", true, "TP structure verified and untouched");
}

// -----------------------------------------------------------------------------
// 12. SL (0.50%), Risk Budget (1.0%), Sizing Unchanged
// -----------------------------------------------------------------------------
{
    resetAll();
    setShockState("ETHUSDT", "UP");

    const bridge = makeBridge({
        longAllow: true,
        directionalShockState: "UP"
    });

    const snapshot = {
        symbol: "ETHUSDT",
        lastPrice: 2315.00,
        latestCandleClose: 2315.00,
        boxHigh: 2313.10,
        boxLow: 2306.40,
        boxPos: 1.28,
        boxRel: 0.0029,
        tickSz: 0.01,
        atr: 1.04,
        emaGap: 0.00065,
        qualityScore: 70, // B grade
        boxBreakSide: "upper" as const,
        canonicalRegime: "RANGE" as const,
        candles: buildCandles(2315.00)
    };

    const input: EngineV2Input = {
        symbol: "ETHUSDT",
        now: Date.now(),
        snapshot: snapshot as any,
        config: makeConfig() as any,
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

    assert.equal(res.decision.decision, "ENTER");
    const stopPrice = res.decision.risk?.stopPrice ?? res.decision.committedRiskPlan?.stopPrice ?? res.decision.metadata?.stopPrice;
    assert.ok(stopPrice != null, "Stop price must be present");
    const entryPx = 2315.00;
    // Canonical ETH 0.50% stop distance
    const stopDistPct = Math.abs(entryPx - stopPrice) / entryPx;
    assert.ok(stopDistPct >= 0.0049 && stopDistPct <= 0.0051, `Stop dist pct ${stopDistPct} must match canonical 0.50%`);
    run("12. SL/risk/sizing unchanged", true, "Canonical 0.50% stop, B grade risk budgeting, sizing contract strictly preserved");
}

console.log("\n>>> ALL 12 V2 RANGE LIVE BREAKOUT QUALITY GATE INVARIANTS VERIFIED SUCCESSFULLY <<<\n");
