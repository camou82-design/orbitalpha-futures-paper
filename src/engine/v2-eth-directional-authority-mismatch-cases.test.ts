import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateEthDirectionalAuthorityMismatch,
    type EthDirectionalAuthorityMismatchInput
} from "../engine-v2/market-judgment/eth-directional-authority-reconciler";
import { runEngineV2 } from "../engine-v2/index";
import type { EngineV2Input } from "../engine-v2/types";
import type { Candle } from "../models/types";

function makeFallingCandles(basePrice = 2000): Candle[] {
    const candles: Candle[] = [];
    const count = 120;
    const now = Date.now();
    for (let i = 0; i < count; i++) {
        const offset = (count - i) * 60_000;
        const trend = -0.5 * i;
        const open = basePrice + trend + 2;
        const high = basePrice + trend + 5;
        const low = basePrice + trend - 5;
        const close = basePrice + trend - 1;
        candles.push({
            ts: now - offset,
            open,
            high,
            low,
            close,
            volume: 150 + (i % 10) * 10
        });
    }
    return candles;
}

function makeRisingCandles(basePrice = 2000): Candle[] {
    const candles: Candle[] = [];
    const count = 120;
    const now = Date.now();
    for (let i = 0; i < count; i++) {
        const offset = (count - i) * 60_000;
        const trend = 0.5 * i;
        const open = basePrice + trend - 2;
        const high = basePrice + trend + 5;
        const low = basePrice + trend - 5;
        const close = basePrice + trend + 1;
        candles.push({
            ts: now - offset,
            open,
            high,
            low,
            close,
            volume: 150 + (i % 10) * 10
        });
    }
    return candles;
}

describe("ETH Directional Authority Mismatch Reconciler Test Suite", () => {
    // ── Direct Reconciler Unit Tests ──────────────────────────────────────────

    it("CASE 1: ETH flat initial entry, agreed SHORT + stale LONG reject -> Reconciles to short (decision=HOLD, reject=null)", () => {
        const input: EthDirectionalAuthorityMismatchInput = {
            symbol: "ETHUSDT",
            isInitialEntry: true,
            hasPosition: false,
            currentPositionsCount: 0,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            hardControlClear: true,
            hardBlockPresent: false,
            trendSideCandidate: "short",
            rangeSideCandidate: "short",
            riskLongAllow: false,
            riskShortAllow: true,
            allowNewLong: false,
            allowNewShort: true,
            v2DecisionBeforePromotion: "REJECT",
            v2SideBeforePromotion: "long",
            v2RejectReasonBeforePromotion: "SIDE_NOT_ALLOWED_LONG",
            v2DecisionAfterPromotion: "REJECT",
            v2SideAfterPromotion: "long",
            v2RejectReasonAfterPromotion: "SIDE_NOT_ALLOWED_LONG"
        };

        const res = evaluateEthDirectionalAuthorityMismatch(input);
        assert.equal(res.reconciled, true);
        assert.equal(res.agreedCandidateSide, "short");
        assert.equal(res.reconciledSide, "short");
        assert.equal(res.reconciledDecision, "HOLD");
        assert.equal(res.reconciledRejectReason, null);
        assert.equal(res.reason, "ETH_AGREED_SHORT_RECONCILED_FROM_STALE_LONG");
        assert.ok(res.proof != null);
        assert.equal(res.proof?.event, "ETH_DIRECTIONAL_AUTHORITY_MISMATCH_RECONCILED_PROOF");
        assert.equal(res.proof?.agreed_candidate_side, "short");
        assert.equal(res.proof?.stale_side_before, "long");
        assert.equal(res.proof?.stale_reject_reason_before, "SIDE_NOT_ALLOWED_LONG");
    });

    it("CASE 2: ETH flat initial entry, agreed LONG + stale SHORT reject -> Reconciles to long (decision=HOLD, reject=null)", () => {
        const input: EthDirectionalAuthorityMismatchInput = {
            symbol: "ETHUSDT",
            isInitialEntry: true,
            hasPosition: false,
            currentPositionsCount: 0,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            hardControlClear: true,
            hardBlockPresent: false,
            trendSideCandidate: "long",
            rangeSideCandidate: "long",
            riskLongAllow: true,
            riskShortAllow: false,
            allowNewLong: true,
            allowNewShort: false,
            v2DecisionBeforePromotion: "REJECT",
            v2SideBeforePromotion: "short",
            v2RejectReasonBeforePromotion: "SIDE_NOT_ALLOWED_SHORT",
            v2DecisionAfterPromotion: "REJECT",
            v2SideAfterPromotion: "short",
            v2RejectReasonAfterPromotion: "SIDE_NOT_ALLOWED_SHORT"
        };

        const res = evaluateEthDirectionalAuthorityMismatch(input);
        assert.equal(res.reconciled, true);
        assert.equal(res.agreedCandidateSide, "long");
        assert.equal(res.reconciledSide, "long");
        assert.equal(res.reconciledDecision, "HOLD");
        assert.equal(res.reconciledRejectReason, null);
        assert.equal(res.reason, "ETH_AGREED_LONG_RECONCILED_FROM_STALE_SHORT");
        assert.ok(res.proof != null);
        assert.equal(res.proof?.event, "ETH_DIRECTIONAL_AUTHORITY_MISMATCH_RECONCILED_PROOF");
        assert.equal(res.proof?.agreed_candidate_side, "long");
        assert.equal(res.proof?.stale_side_before, "short");
        assert.equal(res.proof?.stale_reject_reason_before, "SIDE_NOT_ALLOWED_SHORT");
    });

    it("CASE 3: Genuine SIDE_NOT_ALLOWED SHORT (riskShortAllow=false) -> strictly BLOCKED (reconciled=false)", () => {
        const input: EthDirectionalAuthorityMismatchInput = {
            symbol: "ETHUSDT",
            isInitialEntry: true,
            hasPosition: false,
            currentPositionsCount: 0,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            hardControlClear: true,
            hardBlockPresent: false,
            trendSideCandidate: "short",
            rangeSideCandidate: "short",
            riskLongAllow: false,
            riskShortAllow: false, // Disallowed!
            allowNewLong: false,
            allowNewShort: false,
            v2DecisionBeforePromotion: "REJECT",
            v2SideBeforePromotion: "short",
            v2RejectReasonBeforePromotion: "SIDE_NOT_ALLOWED_SHORT",
            v2DecisionAfterPromotion: "REJECT",
            v2SideAfterPromotion: "short",
            v2RejectReasonAfterPromotion: "SIDE_NOT_ALLOWED_SHORT"
        };

        const res = evaluateEthDirectionalAuthorityMismatch(input);
        assert.equal(res.reconciled, false);
        assert.equal(res.agreedCandidateSide, "none");
        assert.equal(res.reconciledDecision, "REJECT");
        assert.equal(res.reconciledRejectReason, "SIDE_NOT_ALLOWED_SHORT");
    });

    it("CASE 4: Genuine SIDE_NOT_ALLOWED LONG (riskLongAllow=false) -> strictly BLOCKED (reconciled=false)", () => {
        const input: EthDirectionalAuthorityMismatchInput = {
            symbol: "ETHUSDT",
            isInitialEntry: true,
            hasPosition: false,
            currentPositionsCount: 0,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            hardControlClear: true,
            hardBlockPresent: false,
            trendSideCandidate: "long",
            rangeSideCandidate: "long",
            riskLongAllow: false, // Disallowed!
            riskShortAllow: false,
            allowNewLong: false,
            allowNewShort: false,
            v2DecisionBeforePromotion: "REJECT",
            v2SideBeforePromotion: "long",
            v2RejectReasonBeforePromotion: "SIDE_NOT_ALLOWED_LONG",
            v2DecisionAfterPromotion: "REJECT",
            v2SideAfterPromotion: "long",
            v2RejectReasonAfterPromotion: "SIDE_NOT_ALLOWED_LONG"
        };

        const res = evaluateEthDirectionalAuthorityMismatch(input);
        assert.equal(res.reconciled, false);
        assert.equal(res.agreedCandidateSide, "none");
        assert.equal(res.reconciledDecision, "REJECT");
        assert.equal(res.reconciledRejectReason, "SIDE_NOT_ALLOWED_LONG");
    });

    it("CASE 5: BTCUSDT with same conditions -> completely UNAFFECTED (reconciled=false)", () => {
        const input: EthDirectionalAuthorityMismatchInput = {
            symbol: "BTCUSDT",
            isInitialEntry: true,
            hasPosition: false,
            currentPositionsCount: 0,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            hardControlClear: true,
            hardBlockPresent: false,
            trendSideCandidate: "short",
            rangeSideCandidate: "short",
            riskLongAllow: false,
            riskShortAllow: true,
            allowNewLong: false,
            allowNewShort: true,
            v2DecisionBeforePromotion: "REJECT",
            v2SideBeforePromotion: "long",
            v2RejectReasonBeforePromotion: "SIDE_NOT_ALLOWED_LONG",
            v2DecisionAfterPromotion: "REJECT",
            v2SideAfterPromotion: "long",
            v2RejectReasonAfterPromotion: "SIDE_NOT_ALLOWED_LONG"
        };

        const res = evaluateEthDirectionalAuthorityMismatch(input);
        assert.equal(res.reconciled, false);
        assert.equal(res.reason, "SYMBOL_NOT_ETH");
        assert.equal(res.reconciledDecision, "REJECT");
        assert.equal(res.reconciledRejectReason, "SIDE_NOT_ALLOWED_LONG");
    });

    it("CASE 6: Active position present -> NOT reconciled (reconciled=false)", () => {
        const input: EthDirectionalAuthorityMismatchInput = {
            symbol: "ETHUSDT",
            isInitialEntry: true,
            hasPosition: true, // Active position
            currentPositionsCount: 1,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            hardControlClear: true,
            hardBlockPresent: false,
            trendSideCandidate: "short",
            rangeSideCandidate: "short",
            riskLongAllow: false,
            riskShortAllow: true,
            allowNewLong: false,
            allowNewShort: true,
            v2DecisionBeforePromotion: "REJECT",
            v2SideBeforePromotion: "long",
            v2RejectReasonBeforePromotion: "SIDE_NOT_ALLOWED_LONG",
            v2DecisionAfterPromotion: "REJECT",
            v2SideAfterPromotion: "long",
            v2RejectReasonAfterPromotion: "SIDE_NOT_ALLOWED_LONG"
        };

        const res = evaluateEthDirectionalAuthorityMismatch(input);
        assert.equal(res.reconciled, false);
        assert.equal(res.reason, "NOT_FLAT_INITIAL_ENTRY");
    });

    it("CASE 7: Manual takeover active -> NOT reconciled (reconciled=false)", () => {
        const input: EthDirectionalAuthorityMismatchInput = {
            symbol: "ETHUSDT",
            isInitialEntry: true,
            hasPosition: false,
            currentPositionsCount: 0,
            isOperatorManaged: false,
            isManualTakeover: true, // Manual takeover
            isAdoptedExternal: false,
            hardControlClear: true,
            hardBlockPresent: false,
            trendSideCandidate: "short",
            rangeSideCandidate: "short",
            riskLongAllow: false,
            riskShortAllow: true,
            allowNewLong: false,
            allowNewShort: true,
            v2DecisionBeforePromotion: "REJECT",
            v2SideBeforePromotion: "long",
            v2RejectReasonBeforePromotion: "SIDE_NOT_ALLOWED_LONG",
            v2DecisionAfterPromotion: "REJECT",
            v2SideAfterPromotion: "long",
            v2RejectReasonAfterPromotion: "SIDE_NOT_ALLOWED_LONG"
        };

        const res = evaluateEthDirectionalAuthorityMismatch(input);
        assert.equal(res.reconciled, false);
        assert.equal(res.reason, "MANUAL_OR_EXTERNAL_CONTROL_PRESENT");
    });

    it("CASE 8: Hard block active -> NOT reconciled (reconciled=false)", () => {
        const input: EthDirectionalAuthorityMismatchInput = {
            symbol: "ETHUSDT",
            isInitialEntry: true,
            hasPosition: false,
            currentPositionsCount: 0,
            isOperatorManaged: false,
            isManualTakeover: false,
            isAdoptedExternal: false,
            hardControlClear: false, // Hard control not clear
            hardBlockPresent: true,
            trendSideCandidate: "short",
            rangeSideCandidate: "short",
            riskLongAllow: false,
            riskShortAllow: true,
            allowNewLong: false,
            allowNewShort: true,
            v2DecisionBeforePromotion: "REJECT",
            v2SideBeforePromotion: "long",
            v2RejectReasonBeforePromotion: "SIDE_NOT_ALLOWED_LONG",
            v2DecisionAfterPromotion: "REJECT",
            v2SideAfterPromotion: "long",
            v2RejectReasonAfterPromotion: "SIDE_NOT_ALLOWED_LONG"
        };

        const res = evaluateEthDirectionalAuthorityMismatch(input);
        assert.equal(res.reconciled, false);
        assert.equal(res.reason, "HARD_BLOCK_PRESENT_OR_CONTROL_NOT_CLEAR");
    });

    // ── End-to-End runEngineV2 Integration Tests ──────────────────────────────

    function makeEthMismatchV2Input(overrides: {
        symbol?: string;
        side?: "long" | "short";
        boxPos?: number;
        emaGap?: number;
        longAllow?: boolean;
        shortAllow?: boolean;
        qualityScore?: number;
        now?: number;
    } = {}): EngineV2Input {
        const symbol = overrides.symbol ?? "ETHUSDT";
        const now = overrides.now ?? Date.now();
        const boxLow = 1950;
        const boxHigh = 2050;
        const boxPos = overrides.boxPos ?? (overrides.side === "short" ? 0.95 : 0.05);
        const lastPrice = boxLow + (boxHigh - boxLow) * boxPos;
        const qualityScore = overrides.qualityScore ?? 85;
        const candles = overrides.side === "long" ? makeRisingCandles(boxLow) : makeFallingCandles(boxLow);

        return {
            run_cycle_id: `test-${symbol}-${overrides.side ?? "short"}-cycle`,
            symbol,
            now,
            candles,
            evaluationMode: "authoritative",
            v1Result: {
                regime: "RANGE",
                decision: "SKIP",
                side: "NONE",
                isBlocked: false
            },
            snapshot: {
                symbol,
                lastPrice,
                latestCandleClose: lastPrice,
                boxHigh,
                boxLow,
                boxPos,
                boxBreakSide: "none",
                boxCohesion01: 0.95,
                rangeConfidence: 0.85,
                trendWeaknessScore: 0.2,
                qualityScore,
                reviewing_ticks: 0,
                canonicalRegime: "RANGE",
                candles,
                tickSz: 0.01,
                lotSz: 0.001,
                reversal_confirmed: true,
                emaGap: overrides.emaGap ?? (overrides.side === "long" ? 0.002 : -0.002),
                atr: 15,
                htf_entry_policy: "NEUTRAL_HTF_DATA_WAIT"
            } as any,
            state: {
                symbol,
                now,
                heldPositionSide: "none",
                currentPositions: [],
                symbolPositions: [],
                longPosition: null,
                shortPosition: null,
                hasLongPosition: false,
                hasShortPosition: false,
                directionalShockState: "NONE",
                rawDirectionalShockState: "NONE",
                longAllow: overrides.longAllow ?? (overrides.side === "long" ? true : false),
                shortAllow: overrides.shortAllow ?? (overrides.side === "short" ? true : false),
                paperExecutionReady: true,
                signedExecutionReady: true,
                executionReadiness: true,
                serverTradeEnabled: true,
                closeOnlyMode: false,
                killSwitch: false,
                reconcileSafeMode: false,
                dailyLossGuardTriggered: false,
                accountEquityKrw: 140_000_000,
                accountEquityUsdt: 100_000,
                availableBalanceUsdt: 50_000,
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
                lossStreaks: { [symbol]: 0 }
            } as any,
            config: {
                paperMaxOpenPositions: 3,
                baseSizeUsd: 100,
                maxLeverage: 10,
                defaultLeverage: 10,
                maxSingleOrderNotionalUsdt: 40,
                okxLiveMaxOrderNotionalUsdt: 40,
                serverTradeEnabled: true,
                externalMarketContextEnabled: false,
                externalMarketEmergencyEventEnabled: false
            } as any
        };
    }

    it("CASE 9: Full ETH SHORT runtime flow: agreed SHORT candidate with stale LONG executor is reconciled and evaluates downstream gates", () => {
        const v2Input = makeEthMismatchV2Input({
            symbol: "ETHUSDT",
            side: "short",
            boxPos: 0.95,
            emaGap: -0.002,
            longAllow: false,
            shortAllow: true
        });

        const result = runEngineV2(v2Input);

        // Reconciler converts stale long mismatch to short without false SIDE_NOT_ALLOWED_LONG rejection
        assert.notEqual(result.decision.risk?.blockReason, "SIDE_NOT_ALLOWED_LONG");
        assert.notEqual(result.decision.decision, "REJECT");
    });

    it("CASE 10: Full ETH LONG runtime flow: agreed LONG candidate with stale SHORT executor is reconciled and evaluates downstream gates", () => {
        const v2Input = makeEthMismatchV2Input({
            symbol: "ETHUSDT",
            side: "long",
            boxPos: 0.05,
            emaGap: 0.002,
            longAllow: true,
            shortAllow: false
        });

        const result = runEngineV2(v2Input);

        // Reconciler converts stale short mismatch to long without false SIDE_NOT_ALLOWED_SHORT rejection
        assert.notEqual(result.decision.risk?.blockReason, "SIDE_NOT_ALLOWED_SHORT");
        assert.notEqual(result.decision.decision, "REJECT");
    });

    it("CASE 11: Genuine side-not-allowed regression: shortAllow=false blocks SHORT entry", () => {
        const v2Input = makeEthMismatchV2Input({
            symbol: "ETHUSDT",
            side: "short",
            boxPos: 0.95,
            emaGap: -0.002,
            longAllow: false,
            shortAllow: false // Strictly disallowed
        });

        const result = runEngineV2(v2Input);

        assert.notEqual(result.decision.decision, "ENTER");
    });

    it("CASE 12: BTC preservation regression: BTCUSDT does not trigger ETH directional reconciler", () => {
        const v2Input = makeEthMismatchV2Input({
            symbol: "BTCUSDT",
            side: "short",
            boxPos: 0.95,
            emaGap: -0.002,
            longAllow: false,
            shortAllow: false
        });

        const result = runEngineV2(v2Input);

        assert.notEqual(result.decision.decision, "ENTER");
    });
});
