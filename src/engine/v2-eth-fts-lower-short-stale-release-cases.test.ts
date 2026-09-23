import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateEthFtsLowerShortStaleRelease,
    resetEthFtsLowerShortStaleState
} from "../engine-v2/market-judgment/eth-fts-lower-short-stale-release";
import { evaluateEthRangeEntryQualityGate } from "../engine-v2/execution/eth-range-entry-quality-gate";
import { runEngineV2 } from "../engine-v2/index";
import type { EngineV2Input } from "../engine-v2/types";
import type { Candle } from "../models/types";

function makeCandles(boxLow = 1950): Candle[] {
    const flat: Candle[] = Array.from({ length: 110 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60000,
        open: boxLow + 180,
        high: boxLow + 200,
        low: boxLow + 150,
        close: boxLow + 170,
        volume: 80
    }));
    const falling = Array.from({ length: 10 }, (_, i) => {
        const px = boxLow + 120 - i * 15;
        return {
            ts: Date.now() - (10 - i) * 60000,
            open: px,
            high: px + 10,
            low: px - 40,
            close: px - 30,
            volume: 200
        };
    });
    return [...flat, ...falling];
}

function makeRisingCandles(boxLow = 1950): Candle[] {
    const flat: Candle[] = Array.from({ length: 110 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60000,
        open: boxLow + 20,
        high: boxLow + 40,
        low: boxLow + 10,
        close: boxLow + 30,
        volume: 80
    }));
    const rising = Array.from({ length: 10 }, (_, i) => {
        const px = boxLow + 30 + i * 7;
        return {
            ts: Date.now() - (10 - i) * 60000,
            open: px,
            high: px + 15,
            low: px - 5,
            close: px + 10,
            volume: 200
        };
    });
    return [...flat, ...rising];
}

function makeEthFtsInput(overrides: {
    symbol?: string;
    subtype?: string;
    ftsDirection?: string;
    boxPos?: number;
    zone?: string;
    reversalConfirmed?: boolean;
    qualityScore?: number;
    trendOk?: boolean;
    directionalShockState?: "NONE" | "UP" | "DOWN";
    htf1h?: string;
    htf4h?: string;
    htf1d?: string;
    htfPolicy?: string;
    boxLowerBreakdownHold?: boolean;
    closedCandleBreakdown?: boolean;
    retestConfirmed?: boolean;
    consecutiveCyclesOverride?: number | null;
    now?: number;
} = {}): EngineV2Input {
    const symbol = overrides.symbol ?? "ETHUSDT";
    const now = overrides.now ?? Date.now();
    const boxLow = 1950;
    const boxHigh = 2050;
    const boxPos = overrides.boxPos ?? 0.073;
    const lastPrice = boxLow + (boxHigh - boxLow) * boxPos;
    const subtype = overrides.subtype ?? "FAST_TREND_SHIFT";
    const ftsDirection = overrides.ftsDirection ?? "short";
    const qualityScore = overrides.qualityScore ?? 73;
    const reversalConfirmed = overrides.reversalConfirmed ?? false;
    const directionalShockState = overrides.directionalShockState ?? "NONE";
    const htf1h = overrides.htf1h ?? "BULLISH";
    const htf4h = overrides.htf4h ?? "BULLISH";
    const htf1d = overrides.htf1d ?? "BULLISH";
    const htfPolicy = overrides.htfPolicy ?? "NEUTRAL_HTF_DATA_WAIT";

    const candles = overrides.ftsDirection === "long" ? makeRisingCandles(boxLow) : makeCandles(boxLow);

    return {
        run_cycle_id: "test-cycle-1",
        symbol,
        now,
        candles,
        evaluationMode: "authoritative",
        v1Result: {
            regime: overrides.symbol?.startsWith("BTC") && overrides.subtype === "CANONICAL_RANGE" ? "RANGE" : "TREND",
            decision: "SKIP",
            side: "NONE",
            isBlocked: false
        },
        snapshot: {
            lastPrice,
            latestCandleClose: lastPrice,
            boxHigh,
            boxLow,
            boxPos,
            atr: 20,
            emaGap: -0.001,
            trendWeaknessScore: 0.2,
            qualityScore,
            reviewing_ticks: 0,
            canonicalRegime: overrides.symbol?.startsWith("BTC") && overrides.subtype === "CANONICAL_RANGE" ? "RANGE" : "TREND",
            candles,
            tickSz: 0.01,
            lotSz: 0.001,
            reversal_confirmed: reversalConfirmed,
            box_lower_breakdown_hold: overrides.boxLowerBreakdownHold ?? false,
            closed_candle_breakdown: overrides.closedCandleBreakdown ?? false,
            retestConfirmed: overrides.retestConfirmed ?? false,
            htf_entry_policy: htfPolicy,
            htf_1h_bias: htf1h,
            htf_4h_bias: htf4h,
            htf_1d_bias: htf1d,
            ethFtsLowerShortStaleCyclesOverride: overrides.consecutiveCyclesOverride ?? null,
            fastTrendShift: {
                active: true,
                direction: ftsDirection,
                lower_high_detected: true,
                lower_low_detected: true,
                box_mid_lost: true,
                box_lower_breakdown_hold: overrides.boxLowerBreakdownHold ?? false,
                stop_price: lastPrice * 1.015
            }
        } as any,
        state: {
            heldPositionSide: "none",
            currentPositions: [],
            directionalShockState,
            rawDirectionalShockState: "NONE",
            longAllow: true,
            shortAllow: true,
            paperExecutionReady: true,
            signedExecutionReady: true,
            executionReadiness: true,
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            dailyLossGuardTriggered: false,
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
            okxSimulatedTradingHeaderEnabled: true,
            balanceFetchedAt: now,
            positionsFetchedAt: now,
            pendingOrdersFetchedAt: now,
            entryQualityProfiles: {
                profit: { count: 0 },
                loss: { count: 0 },
                contaminated: { count: 0 }
            },
            globalRiskScore: 0.1,
            lossStreaks: { ETHUSDT: 0 }
        } as any,
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            okxLiveMaxOrderNotionalUsdt: 200,
            serverTradeEnabled: true
        } as any
    };
}

describe("ETH FTS Lower Short Stale-Authority Release Test Suite (Cases A-G)", () => {
    beforeEach(() => {
        resetEthFtsLowerShortStaleState();
    });

    // ── CASE A: 현재 실제 케이스와 동일 ──────────────────────────────────────────
    // boxPos 0.073 / FTS short / no breakdown / shock none / HTF bullish 3개
    // -> 1~2 cycle HOLD (or SKIP)
    // -> 3 cycle stale release
    // -> short neutralized
    // -> 직접 long ENTER 없음
    it("CASE A: ETHUSDT boxPos 0.073 FTS short without breakdown -> 1-2 ticks HOLD/SKIP, tick 3 stale release -> short neutralized, no direct long ENTER", () => {
        const input1 = makeEthFtsInput({ consecutiveCyclesOverride: 1 });
        const res1 = runEngineV2(input1);
        assert.notEqual(res1.decision.decision, "ENTER", "Cycle 1 must not ENTER");
        assert.equal(res1.decision.side, "none", "Cycle 1 side must be none");

        const input2 = makeEthFtsInput({ consecutiveCyclesOverride: 2 });
        const res2 = runEngineV2(input2);
        assert.notEqual(res2.decision.decision, "ENTER", "Cycle 2 must not ENTER");
        assert.equal(res2.decision.side, "none", "Cycle 2 side must be none");

        const input3 = makeEthFtsInput({ consecutiveCyclesOverride: 3 });
        const res3 = runEngineV2(input3);
        assert.notEqual(res3.decision.decision, "ENTER", "Cycle 3 must not generate long ENTER without reversal evidence");
        assert.equal(res3.decision.side, "none", "Cycle 3 side must be none (short neutralized)");

        // Direct unit check on stale release gate
        const directEval = evaluateEthFtsLowerShortStaleRelease({
            symbol: "ETHUSDT",
            isInitialEntry: true,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            subtype: "FAST_TREND_SHIFT",
            ftsDirection: "short",
            trendSideCandidate: "short",
            zone: "lower",
            boxPos: 0.073,
            actualLowerBreakEvidence: false,
            closedBreakConfirmed: false,
            retestConfirmed: false,
            directionalShockState: "NONE",
            hardBlockPresent: false,
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            htf1dBias: "BULLISH",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            now: Date.now(),
            consecutiveCyclesOverride: 3
        });
        assert.equal(directEval.staleReleaseActive, true);
        assert.equal(directEval.effectiveTrendSideCandidate, "none");
        assert.equal(directEval.proof.event, "ETH_FTS_LOWER_SHORT_STALE_RELEASE_PROOF");
        assert.equal(directEval.proof.stale_release_active, true);
        assert.equal(directEval.proof.effective_side_after_release, "none");
    });

    // ── CASE B: 2번째 cycle에 lower breakdown confirmed ──────────────────────────
    // -> counter reset -> stale release 없음 -> 기존 short authority 유지
    it("CASE B: Breakdown confirmed on cycle 2 -> counter reset -> no stale release -> short authority preserved", () => {
        // Cycle 1: No breakdown
        const direct1 = evaluateEthFtsLowerShortStaleRelease({
            symbol: "ETHUSDT",
            isInitialEntry: true,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            subtype: "FAST_TREND_SHIFT",
            ftsDirection: "short",
            trendSideCandidate: "short",
            zone: "lower",
            boxPos: 0.073,
            actualLowerBreakEvidence: false,
            closedBreakConfirmed: false,
            retestConfirmed: false,
            directionalShockState: "NONE",
            hardBlockPresent: false,
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            htf1dBias: "BULLISH",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            now: Date.now()
        });
        assert.equal(direct1.consecutiveCycles, 1);
        assert.equal(direct1.staleReleaseActive, false);

        // Cycle 2: Breakdown confirmed!
        const direct2 = evaluateEthFtsLowerShortStaleRelease({
            symbol: "ETHUSDT",
            isInitialEntry: true,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            subtype: "FAST_TREND_SHIFT",
            ftsDirection: "short",
            trendSideCandidate: "short",
            zone: "lower",
            boxPos: 0.073,
            actualLowerBreakEvidence: true,
            closedBreakConfirmed: true,
            retestConfirmed: false,
            directionalShockState: "NONE",
            hardBlockPresent: false,
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            htf1dBias: "BULLISH",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            now: Date.now()
        });
        assert.equal(direct2.consecutiveCycles, 0, "Counter must reset to 0 on breakdown");
        assert.equal(direct2.staleReleaseActive, false);
        assert.equal(direct2.resetReason, "LOWER_BREAKDOWN_OR_RETEST_CONFIRMED");
        assert.equal(direct2.effectiveTrendSideCandidate, "short", "Short authority preserved");
    });

    // ── CASE C: HTF 1h/4h/1d bearish -> stale release 금지 ────────────────────────
    it("CASE C: HTF 1h/4h/1d all BEARISH -> stale release strictly forbidden", () => {
        const direct = evaluateEthFtsLowerShortStaleRelease({
            symbol: "ETHUSDT",
            isInitialEntry: true,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            subtype: "FAST_TREND_SHIFT",
            ftsDirection: "short",
            trendSideCandidate: "short",
            zone: "lower",
            boxPos: 0.073,
            actualLowerBreakEvidence: false,
            closedBreakConfirmed: false,
            retestConfirmed: false,
            directionalShockState: "NONE",
            hardBlockPresent: false,
            htf1hBias: "BEARISH",
            htf4hBias: "BEARISH",
            htf1dBias: "BEARISH",
            htfEntryPolicy: "SHORT_ONLY",
            now: Date.now(),
            consecutiveCyclesOverride: 3
        });
        assert.equal(direct.staleReleaseActive, false);
        assert.equal(direct.resetReason, "HTF_BEARISH_ALIGNMENT_FORBIDS_RELEASE");
        assert.equal(direct.effectiveTrendSideCandidate, "short", "Must keep short authority when HTF is bearish");
    });

    // ── CASE D: DOWN shock -> stale release 금지 ─────────────────────────────────
    it("CASE D: DOWN directional shock -> stale release strictly forbidden", () => {
        const direct = evaluateEthFtsLowerShortStaleRelease({
            symbol: "ETHUSDT",
            isInitialEntry: true,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            subtype: "FAST_TREND_SHIFT",
            ftsDirection: "short",
            trendSideCandidate: "short",
            zone: "lower",
            boxPos: 0.073,
            actualLowerBreakEvidence: false,
            closedBreakConfirmed: false,
            retestConfirmed: false,
            directionalShockState: "DOWN",
            hardBlockPresent: false,
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            htf1dBias: "BULLISH",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            now: Date.now(),
            consecutiveCyclesOverride: 3
        });
        assert.equal(direct.staleReleaseActive, false);
        assert.equal(direct.resetReason, "DOWN_SHOCK_TRIGGERED");
        assert.equal(direct.effectiveTrendSideCandidate, "short");
    });

    // ── CASE E: Stale release 이후 fresh RANGE long + reversal 발생 ──────────────
    // -> 기존 ETH RANGE promotion bridge가 정상 평가 가능 -> Highway 통과 필요
    it("CASE E: After stale release, fresh reversal + RANGE long qualifies for ETH Range Promotion Bridge", () => {
        const now = Date.now();
        // Step 1: Trigger stale release
        const staleEval = evaluateEthFtsLowerShortStaleRelease({
            symbol: "ETHUSDT",
            isInitialEntry: true,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            subtype: "FAST_TREND_SHIFT",
            ftsDirection: "short",
            trendSideCandidate: "short",
            zone: "lower",
            boxPos: 0.073,
            actualLowerBreakEvidence: false,
            closedBreakConfirmed: false,
            retestConfirmed: false,
            directionalShockState: "NONE",
            hardBlockPresent: false,
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            htf1dBias: "BULLISH",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            now,
            consecutiveCyclesOverride: 3
        });
        assert.equal(staleEval.staleReleaseActive, true);
        assert.equal(staleEval.effectiveTrendSideCandidate, "none");

        // Step 2: Fresh tick with reversal confirmed + quality 76 + lower edge
        const gateRes = evaluateEthRangeEntryQualityGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "CANONICAL_RANGE",
            routingEngine: "RANGE",
            isInitialEntry: true,
            isAddon: false,
            boxPos: 0.073,
            zone: "lower",
            rangeSideCandidate: "long",
            trendSideCandidate: staleEval.effectiveTrendSideCandidate,
            selectedSideAfterVeto: "long",
            reversalConfirmed: true,
            sideZoneValid: true,
            rangeEdgeExtreme: true,
            qualityScore: 76,
            entryQualityGrade: "A",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            directionalShockState: "NONE",
            emitProof: false
        });

        assert.equal(gateRes.allowed, true, "Qualified reversal probe should be allowed by ETH Range Promotion Bridge");
        assert.equal(gateRes.classification, "ETH_RANGE_FULL", "boxPos 0.073 + reversal confirmed qualifies for ETH_RANGE_FULL");
        assert.equal(gateRes.probeMultiplier, 1.0);
    });

    // ── CASE F: Stale release 이후 실제 breakdown 발생 ──────────────────────────
    // -> suppression 즉시 해제 -> lower-short authority 복원
    it("CASE F: While suppression is active, actual breakdown occurs -> suppression immediately revoked, short authority restored", () => {
        const now = Date.now();
        // Activate stale suppression
        const direct1 = evaluateEthFtsLowerShortStaleRelease({
            symbol: "ETHUSDT",
            isInitialEntry: true,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            subtype: "FAST_TREND_SHIFT",
            ftsDirection: "short",
            trendSideCandidate: "short",
            zone: "lower",
            boxPos: 0.073,
            actualLowerBreakEvidence: false,
            closedBreakConfirmed: false,
            retestConfirmed: false,
            directionalShockState: "NONE",
            hardBlockPresent: false,
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            htf1dBias: "BULLISH",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            now,
            consecutiveCyclesOverride: 3
        });
        assert.equal(direct1.staleReleaseActive, true);
        assert.ok(direct1.suppressionUntil > now);

        // Next evaluation with breakdown confirmed:
        const direct2 = evaluateEthFtsLowerShortStaleRelease({
            symbol: "ETHUSDT",
            isInitialEntry: true,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            subtype: "FAST_TREND_SHIFT",
            ftsDirection: "short",
            trendSideCandidate: "short",
            zone: "lower",
            boxPos: 0.073,
            actualLowerBreakEvidence: true,
            closedBreakConfirmed: true,
            retestConfirmed: false,
            directionalShockState: "NONE",
            hardBlockPresent: false,
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            htf1dBias: "BULLISH",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            now: now + 5000
        });
        assert.equal(direct2.staleReleaseActive, false, "Suppression must be revoked immediately");
        assert.equal(direct2.suppressionUntil, 0, "Suppression window must be reset");
        assert.equal(direct2.consecutiveCycles, 0, "Cycles must reset to 0");
        assert.equal(direct2.effectiveTrendSideCandidate, "short", "Short authority restored");
    });

    // ── CASE G: BTC 영향 0, FTS upper-long 영향 0, ETH RANGE FULL/PROBE 영향 0 ──
    it("CASE G1: BTCUSDT has 0 impact (never triggers stale release)", () => {
        const directBtc = evaluateEthFtsLowerShortStaleRelease({
            symbol: "BTCUSDT",
            isInitialEntry: true,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            subtype: "FAST_TREND_SHIFT",
            ftsDirection: "short",
            trendSideCandidate: "short",
            zone: "lower",
            boxPos: 0.073,
            actualLowerBreakEvidence: false,
            closedBreakConfirmed: false,
            retestConfirmed: false,
            directionalShockState: "NONE",
            hardBlockPresent: false,
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            htf1dBias: "BULLISH",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            now: Date.now(),
            consecutiveCyclesOverride: 3
        });
        assert.equal(directBtc.staleReleaseActive, false);
        assert.equal(directBtc.resetReason, "SYMBOL_NOT_ETH");
        assert.equal(directBtc.effectiveTrendSideCandidate, "short");
    });

    it("CASE G2: ETHUSDT FTS upper-long has 0 impact (never triggers stale release)", () => {
        const directUpper = evaluateEthFtsLowerShortStaleRelease({
            symbol: "ETHUSDT",
            isInitialEntry: true,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            subtype: "FAST_TREND_SHIFT",
            ftsDirection: "long",
            trendSideCandidate: "long",
            zone: "upper",
            boxPos: 0.92,
            actualLowerBreakEvidence: false,
            closedBreakConfirmed: false,
            retestConfirmed: false,
            directionalShockState: "NONE",
            hardBlockPresent: false,
            htf1hBias: "BULLISH",
            htf4hBias: "BULLISH",
            htf1dBias: "BULLISH",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            now: Date.now(),
            consecutiveCyclesOverride: 3
        });
        assert.equal(directUpper.staleReleaseActive, false);
        assert.equal(directUpper.resetReason, "FTS_SHORT_INACTIVE");
        assert.equal(directUpper.effectiveTrendSideCandidate, "long");
    });

    // ── CASE H: Multi-Tick Production Pipeline Regression (Cycles 1-6) ───────────
    it("CASE H: Multi-tick production pipeline -> Cycles 1-2 HOLD, Cycle 3 stale release, Cycle 4-6 natural rangeSideCandidate -> fresh long ENTER", () => {
        resetEthFtsLowerShortStaleState();

        // Cycle 1: FTS short in lower zone, no breakdown -> HOLD
        const input1 = makeEthFtsInput();
        const res1 = runEngineV2(input1);
        assert.notEqual(res1.decision.decision, "ENTER", "Cycle 1 must not ENTER");

        // Cycle 2: Still FTS short in lower zone -> HOLD
        const input2 = makeEthFtsInput();
        const res2 = runEngineV2(input2);
        assert.notEqual(res2.decision.decision, "ENTER", "Cycle 2 must not ENTER");

        // Cycle 3: Reaches 3 cycles -> stale release active -> short neutralized
        const input3 = makeEthFtsInput();
        const res3 = runEngineV2(input3);
        assert.notEqual(res3.decision.decision, "ENTER", "Cycle 3 must not ENTER without reversal");
        assert.equal(res3.decision.side, "none", "Cycle 3 side must be none");

        // Cycle 4: Still in suppression window, no reversal -> HOLD
        const input4 = makeEthFtsInput({ reversalConfirmed: false });
        const res4 = runEngineV2(input4);
        assert.notEqual(res4.decision.decision, "ENTER", "Cycle 4 must not ENTER without reversal");

        // Cycle 5: Reversal confirmed + quality 75 -> Bridge evaluates stale REJECT -> fresh LONG promoted -> ENTER!
        const input5 = makeEthFtsInput({ reversalConfirmed: true, qualityScore: 75 });
        const res5 = runEngineV2(input5);
        assert.equal(res5.decision.decision, "ENTER", "Cycle 5 with reversal confirmed must ENTER via Bridge");
        assert.equal(res5.decision.side, "long", "Cycle 5 side must be fresh long");
        assert.ok(Number(res5.decision.risk?.stopPrice) < 2000, "Fresh long stopPrice must be below entry price");
        assert.ok(Number(res5.decision.risk?.invalidationPx) < 2000, "Fresh long invalidationPx must be below entry price");
    });

    // ── CASE I: Stale REJECT -> Fresh Long Risk-Plan Isolation ──────────────────
    it("CASE I: Stale short structural stop failure is isolated from fresh long risk plan", () => {
        resetEthFtsLowerShortStaleState();

        // Make input where cycle 1-3 accumulates stale short
        const inputStale = makeEthFtsInput({ consecutiveCyclesOverride: 3, reversalConfirmed: true, qualityScore: 75 });
        const res = runEngineV2(inputStale);

        assert.equal(res.decision.decision, "ENTER");
        assert.equal(res.decision.side, "long");
        assert.ok(typeof res.decision.risk?.stopPrice === "number" && res.decision.risk.stopPrice > 0);
        assert.ok(res.decision.risk.stopPrice < 2000, "Long stop price must be below lastPrice (2000)");
        assert.ok(Number(res.decision.risk?.invalidationPx) < 2000, "Long invalidationPx must be below lastPrice (2000)");

        // Verify that decision.explanation.reason or metadata is fresh long promotion, not old short reject reason
        assert.ok(
            String(res.decision.explanation.reason).includes("ETH_RANGE_QUALITY_PROMOTION_BRIDGE") ||
            String(res.decision.explanation.reason).includes("ENTER") ||
            String(res.decision.metadata?.promotionReason).includes("ETH_RANGE_QUALITY_PROMOTION_BRIDGE")
        );
    });

    // ── CASE J: Genuine Hard REJECT Safety (Never Bypassed by Bridge) ────────────
    it("CASE J1: killSwitch === true -> Bridge strictly blocked", () => {
        const input = makeEthFtsInput({ consecutiveCyclesOverride: 3, reversalConfirmed: true, qualityScore: 75 });
        input.state.killSwitch = true;
        const res = runEngineV2(input);
        assert.notEqual(res.decision.decision, "ENTER");
    });

    it("CASE J2: closeOnlyMode === true -> Bridge strictly blocked", () => {
        const input = makeEthFtsInput({ consecutiveCyclesOverride: 3, reversalConfirmed: true, qualityScore: 75 });
        input.state.closeOnlyMode = true;
        const res = runEngineV2(input);
        assert.notEqual(res.decision.decision, "ENTER");
    });

    it("CASE J3: reconcileSafeMode === true -> Bridge strictly blocked", () => {
        const input = makeEthFtsInput({ consecutiveCyclesOverride: 3, reversalConfirmed: true, qualityScore: 75 });
        input.state.reconcileSafeMode = true;
        const res = runEngineV2(input);
        assert.notEqual(res.decision.decision, "ENTER");
    });

    it("CASE J4: dailyLossGuardTriggered === true -> Bridge strictly blocked", () => {
        const input = makeEthFtsInput({ consecutiveCyclesOverride: 3, reversalConfirmed: true, qualityScore: 75 });
        input.state.dailyLossGuardTriggered = true;
        const res = runEngineV2(input);
        assert.notEqual(res.decision.decision, "ENTER");
    });

    it("CASE J5: DOWN shock active -> Bridge strictly blocked", () => {
        const input = makeEthFtsInput({ consecutiveCyclesOverride: 3, reversalConfirmed: true, qualityScore: 75, directionalShockState: "DOWN" });
        const res = runEngineV2(input);
        assert.notEqual(res.decision.decision, "ENTER");
    });

    it("CASE J6: Actual lower breakdown confirmed -> Bridge strictly blocked", () => {
        const input = makeEthFtsInput({
            consecutiveCyclesOverride: 3,
            reversalConfirmed: true,
            qualityScore: 75,
            boxLowerBreakdownHold: true,
            closedCandleBreakdown: true
        });
        const res = runEngineV2(input);
        assert.notEqual(res.decision.decision, "ENTER");
    });

    // ── CASE K: selectedSideFinal Invariance Regression ──────────────────────────
    it("CASE K1: BTC RANGE selectedSideFinal invariance", () => {
        const input = makeEthFtsInput({
            symbol: "BTCUSDT",
            subtype: "CANONICAL_RANGE",
            ftsDirection: "none",
            boxPos: 0.05,
            qualityScore: 75
        });
        (input.snapshot as any).canonicalRegime = "RANGE";
        const res = runEngineV2(input);
        assert.equal(res.decision.metadata?.rangeSideCandidate, "long", "BTC lower zone should identify range long");
    });

    it("CASE K2: BTC TREND selectedSideFinal invariance", () => {
        const input = makeEthFtsInput({
            symbol: "BTCUSDT",
            subtype: "TRENDING_DOWN",
            ftsDirection: "short",
            boxPos: 0.5,
            qualityScore: 75,
            directionalShockState: "DOWN"
        });
        const res = runEngineV2(input);
        // Trend down with shock DOWN should have short candidate or none if blocked
        assert.ok(res.decision.side === "short" || res.decision.side === "none");
    });

    it("CASE K3: ETH FTS upper-long selectedSideFinal invariance", () => {
        const input = makeEthFtsInput({
            symbol: "ETHUSDT",
            subtype: "FAST_TREND_SHIFT",
            ftsDirection: "long",
            boxPos: 0.92,
            qualityScore: 75
        });
        (input.snapshot as any).emaGap = 0.002;
        const res = runEngineV2(input);
        assert.ok(res.decision.metadata?.trendSideCandidate === "long" || res.decision.side === "long" || res.decision.side === "none");
    });
});

