import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateEthRangeDynamicTpAuthority,
    resolveEthInFlightRegimeTransitionTp,
    ETH_RANGE_MIN_NET_EDGE_PCT,
    ETH_RANGE_MIN_PROFIT_ATR_MULT,
    ETH_RANGE_MAX_TP_ATR_MULT
} from "../engine-v2/execution/eth-range-dynamic-tp-authority";
import {
    resolveV2PreEntryTp1Authority,
    resolveV2PreEntryExecutableTpBundle,
    evaluatePreEntryTpParity
} from "../engine-v2/execution/pre-entry-tp-provenance";
import { deriveTradeLifecycleAuthority } from "../engine-v2/lifecycle/trade-lifecycle-authority";

describe("V2 ETH RANGE Regime-Aware Dynamic TP Authority Test Suite", () => {
    // 1. ETH RANGE LONG Dynamic TP
    it("CASE 1: ETH RANGE LONG dynamic TP targets boxMid above entry and passes profitability floor", () => {
        const entry = 2500.0;
        const boxMid = 2510.0; // +10 USD = +0.40% > fee floor (0.195%)
        const boxHigh = 2520.0;
        const boxLow = 2500.0;
        const atr = 10.0;
        const canonicalTp = 2525.0; // 1.0%

        const res = evaluateEthRangeDynamicTpAuthority({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: entry,
            regime: "RANGE",
            boxHigh,
            boxLow,
            boxMid,
            atr,
            previousCanonicalTp: canonicalTp,
            feeRate: 0.0005,
            paperSlippageEstimateBps: 8,
            tickSz: 0.01
        });

        assert.equal(res.dynamicTpApplied, true, "Dynamic TP must be applied for ETH RANGE LONG");
        assert.equal(res.finalTp, 2510.0, "Target must be boxMid");
        assert.equal(res.rejectionReason, null);
        assert.equal(res.profitabilityPassed, true);
        assert.equal(res.ownershipOrLifecycleAuthority, "BOT_V2_MANAGED");
    });

    // 2. ETH RANGE SHORT Dynamic TP
    it("CASE 2: ETH RANGE SHORT dynamic TP targets boxMid below entry and passes profitability floor", () => {
        const entry = 2520.0;
        const boxMid = 2510.0; // -10 USD = -0.397% > fee floor
        const boxHigh = 2520.0;
        const boxLow = 2500.0;
        const atr = 10.0;
        const canonicalTp = 2495.0;

        const res = evaluateEthRangeDynamicTpAuthority({
            symbol: "ETHUSDT",
            side: "short",
            entryPrice: entry,
            regime: "RANGE",
            boxHigh,
            boxLow,
            boxMid,
            atr,
            previousCanonicalTp: canonicalTp,
            feeRate: 0.0005,
            paperSlippageEstimateBps: 8,
            tickSz: 0.01
        });

        assert.equal(res.dynamicTpApplied, true, "Dynamic TP must be applied for ETH RANGE SHORT");
        assert.equal(res.finalTp, 2510.0, "Target must be boxMid");
        assert.equal(res.rejectionReason, null);
        assert.equal(res.profitabilityPassed, true);
    });

    // 3. Wrong-side boxMid rejection (NO synthetic target fabrication!)
    it("CASE 3A: LONG with boxMid <= entryPrice is rejected without fabricating synthetic target", () => {
        const entry = 2515.0;
        const boxMid = 2510.0; // boxMid is below entry for a LONG (wrong side!)
        const canonicalTp = 2530.0;

        const res = evaluateEthRangeDynamicTpAuthority({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: entry,
            regime: "RANGE",
            boxHigh: 2520.0,
            boxLow: 2500.0,
            boxMid,
            atr: 10.0,
            previousCanonicalTp: canonicalTp
        });

        assert.equal(res.dynamicTpApplied, false, "Wrong-side boxMid must NOT be applied");
        assert.equal(res.rejectionReason, "WRONG_SIDE_BOX_MID_REJECTED");
        assert.equal(res.finalTp, canonicalTp, "Canonical TP must be strictly preserved");
    });

    it("CASE 3B: SHORT with boxMid >= entryPrice is rejected without fabricating synthetic target", () => {
        const entry = 2505.0;
        const boxMid = 2510.0; // boxMid is above entry for a SHORT (wrong side!)
        const canonicalTp = 2490.0;

        const res = evaluateEthRangeDynamicTpAuthority({
            symbol: "ETHUSDT",
            side: "short",
            entryPrice: entry,
            regime: "RANGE",
            boxHigh: 2520.0,
            boxLow: 2500.0,
            boxMid,
            atr: 10.0,
            previousCanonicalTp: canonicalTp
        });

        assert.equal(res.dynamicTpApplied, false, "Wrong-side boxMid must NOT be applied");
        assert.equal(res.rejectionReason, "WRONG_SIDE_BOX_MID_REJECTED");
        assert.equal(res.finalTp, canonicalTp, "Canonical TP must be strictly preserved");
    });

    // 4. Profitability floor rejection
    it("CASE 4: Target distance below profitability floor is rejected and keeps canonical TP", () => {
        const entry = 2500.0;
        // Distance 1.0 USD = 0.04%, which is far below round trip fee + slippage (0.195% = 4.875 USD)
        const boxMid = 2501.0;
        const canonicalTp = 2525.0;

        const res = evaluateEthRangeDynamicTpAuthority({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: entry,
            regime: "RANGE",
            boxHigh: 2505.0,
            boxLow: 2495.0,
            boxMid,
            atr: 2.0,
            previousCanonicalTp: canonicalTp
        });

        assert.equal(res.dynamicTpApplied, false, "Sub-profitability target must be rejected");
        assert.equal(res.rejectionReason, "BELOW_PROFITABILITY_FLOOR");
        assert.equal(res.finalTp, canonicalTp, "Canonical TP must be preserved on floor failure");
    });

    // 5. TREND regime unchanged
    it("CASE 5: In TREND regime, existing TP authority is strictly preserved", () => {
        const canonicalTp = 2550.0;
        const res = evaluateEthRangeDynamicTpAuthority({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2500.0,
            regime: "TREND",
            boxHigh: 2520.0,
            boxLow: 2500.0,
            boxMid: 2510.0,
            atr: 10.0,
            previousCanonicalTp: canonicalTp
        });

        assert.equal(res.dynamicTpApplied, false);
        assert.equal(res.rejectionReason, "TREND_REGIME_UNCHANGED");
        assert.equal(res.finalTp, canonicalTp);
    });

    // 6. In-flight Regime Transition & Hysteresis
    it("CASE 6A: Same-candle multi-tick evaluation (< 1 candle advance) does NOT confirm transition", () => {
        const transRes = resolveEthInFlightRegimeTransitionTp({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2500.0,
            currentPrice: 2505.0,
            currentRegime: "RANGE",
            previousRegime: "TREND",
            regimeConsecutiveEvaluations: 5, // multiple loop iterations
            regimeCandleAdvanceCount: 0,     // but same candle!
            currentTp: 2560.0,
            trendTp: 2560.0,
            boxHigh: 2520.0,
            boxLow: 2500.0,
            boxMid: 2510.0,
            atr: 10.0
        });

        assert.equal(transRes.updated, false, "Same candle repeated loop must NOT trigger regime transition");
        assert.equal(transRes.reason, "REGIME_HYSTERESIS_UNCONFIRMED");
        assert.equal(transRes.newTp, 2560.0);
    });

    it("CASE 6B: Confirmed TREND -> RANGE (>= 2 evals AND >= 1 candle advance) reduces far TP to Dynamic TP", () => {
        const transRes = resolveEthInFlightRegimeTransitionTp({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2500.0,
            currentPrice: 2505.0,
            currentRegime: "RANGE",
            previousRegime: "TREND",
            regimeConsecutiveEvaluations: 2,
            regimeCandleAdvanceCount: 1,
            currentTp: 2560.0,
            trendTp: 2560.0,
            boxHigh: 2520.0,
            boxLow: 2500.0,
            boxMid: 2510.0,
            atr: 10.0
        });

        assert.equal(transRes.updated, true);
        assert.equal(transRes.reason, "TREND_TO_RANGE_TP_REDUCED");
        assert.equal(transRes.newTp, 2510.0, "TP must be reduced to achievable boxMid target");
    });

    it("CASE 6C: Confirmed RANGE -> TREND (>= 2 evals AND >= 1 candle advance) restores Trend TP", () => {
        const transRes = resolveEthInFlightRegimeTransitionTp({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2500.0,
            currentPrice: 2512.0,
            currentRegime: "TREND",
            previousRegime: "RANGE",
            regimeConsecutiveEvaluations: 2,
            regimeCandleAdvanceCount: 1,
            currentTp: 2510.0, // close range TP
            trendTp: 2560.0,   // trend target
            boxHigh: 2520.0,
            boxLow: 2500.0,
            boxMid: 2510.0,
            atr: 10.0
        });

        assert.equal(transRes.updated, true);
        assert.equal(transRes.reason, "RANGE_TO_TREND_TP_RESTORED");
        assert.equal(transRes.newTp, 2560.0, "TP must be restored to trend target");
    });

    // 7. OPERATOR_MANAGED and manual takeover complete immunity
    it("CASE 7A: OPERATOR_MANAGED position is strictly bypassed and never modified", () => {
        const canonicalTp = 2540.0;
        const res = evaluateEthRangeDynamicTpAuthority({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2500.0,
            regime: "RANGE",
            boxHigh: 2520.0,
            boxLow: 2500.0,
            boxMid: 2510.0,
            atr: 10.0,
            previousCanonicalTp: canonicalTp,
            lifecycleState: "OPERATOR_MANAGED"
        });

        assert.equal(res.dynamicTpApplied, false);
        assert.equal(res.rejectionReason, "OPERATOR_OR_MANUAL_MANAGED_BYPASS");
        assert.equal(res.finalTp, canonicalTp);
        assert.equal(res.ownershipOrLifecycleAuthority, "OPERATOR_MANAGED");
    });

    it("CASE 7B: manualTakeoverActive flag strictly bypasses Dynamic TP recalculation", () => {
        const canonicalTp = 2540.0;
        const res = evaluateEthRangeDynamicTpAuthority({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2500.0,
            regime: "RANGE",
            boxHigh: 2520.0,
            boxLow: 2500.0,
            boxMid: 2510.0,
            atr: 10.0,
            previousCanonicalTp: canonicalTp,
            manualTakeoverActive: true
        });

        assert.equal(res.dynamicTpApplied, false);
        assert.equal(res.rejectionReason, "OPERATOR_OR_MANUAL_MANAGED_BYPASS");
        assert.equal(res.finalTp, canonicalTp);
        assert.equal(res.ownershipOrLifecycleAuthority, "OPERATOR_MANAGED");
    });

    it("CASE 7C: In-flight regime transition strictly bypasses OPERATOR_MANAGED", () => {
        const transRes = resolveEthInFlightRegimeTransitionTp({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2500.0,
            currentPrice: 2505.0,
            currentRegime: "RANGE",
            previousRegime: "TREND",
            regimeConsecutiveEvaluations: 3,
            regimeCandleAdvanceCount: 2,
            currentTp: 2540.0,
            trendTp: 2560.0,
            lifecycleState: "OPERATOR_MANAGED"
        });

        assert.equal(transRes.updated, false);
        assert.equal(transRes.reason, "OPERATOR_OR_MANUAL_MANAGED_BYPASS");
        assert.equal(transRes.newTp, 2540.0);
    });

    // 8. BTCUSDT complete non-applicability
    it("CASE 8: BTCUSDT is strictly bypassed and keeps existing TP unchanged", () => {
        const canonicalTp = 95000.0;
        const res = evaluateEthRangeDynamicTpAuthority({
            symbol: "BTCUSDT",
            side: "long",
            entryPrice: 94000.0,
            regime: "RANGE",
            boxHigh: 94500.0,
            boxLow: 93500.0,
            boxMid: 94000.0,
            atr: 500.0,
            previousCanonicalTp: canonicalTp
        });

        assert.equal(res.dynamicTpApplied, false);
        assert.equal(res.rejectionReason, "SYMBOL_NOT_ETHUSDT");
        assert.equal(res.finalTp, canonicalTp);
    });

    // 9. Pre-entry TP Provenance Wiring Integration
    it("CASE 9: resolveV2PreEntryTp1Authority routes ETHUSDT RANGE to eth_range_dynamic_tp", () => {
        const bundleRes = resolveV2PreEntryExecutableTpBundle({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: 2500.0,
            rawStructuralSl: 2480.0,
            rawPolicySlPrice: 2480.0,
            rangeBoxHighAtEntry: 2515.0,
            rangeBoxLowAtEntry: 2495.0,
            rangeBoxMidAtEntry: 2505.0, // closer than 2506.25, and clears 0.195% floor (5.0 USD = 0.20%)
            atr: 10.0,
            instrumentTickSz: 0.01,
            feeRate: 0.0005,
            paperSlippageEstimateBps: 8
        });

        assert.equal(bundleRes.ok, true);
        if (bundleRes.ok) {
            assert.equal(bundleRes.tpSource, "eth_range_dynamic_tp");
            assert.equal(bundleRes.executableTp1Price, 2505.0);
        }
    });

    // 10. Range Partial TP Separation Invariant & Parity Proof
    it("CASE 10: Range partial TP maintains TP1 dynamic lifecycle parity and TP2 attached backstop parity", () => {
        const parityResult = evaluatePreEntryTpParity({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            marketSubtype: "RANGE_BOUND",
            isV2RangePartialPlan: true,
            tickSz: 0.01,
            canonicalTp2Executable: 2520.0, // canonical backstop TP2
            profitabilityTpExecutable: 2505.0,
            committedTpRaw: 2505.0,
            committedTpExecutable: 2505.0,
            attachedTp: 2520.0,             // attached to exchange as TP2 backstop
            entryReferencePrice: 2500.0,
            committedTpSource: "eth_range_dynamic_tp",
            profitabilityCanonicalTpSource: "takeProfitPlan.tp1",
            profitabilityTpSource: "eth_range_dynamic_tp"
        });

        // Strict invariant checks:
        assert.equal(parityResult.tp_parity_semantic, "RANGE_PARTIAL_TP1_LIFECYCLE_TP2_BACKSTOP");
        assert.equal(parityResult.tp1_parity_passed, true, "TP1 lifecycle parity must pass");
        assert.equal(parityResult.tp2_backstop_parity_passed, true, "TP2 attached backstop parity must pass");
        assert.equal(parityResult.directional_alignment_passed, true, "entry (2500) < TP1 (2505) < TP2 (2520) must hold");
        assert.equal(parityResult.semantic_parity_passed, true, "Combined semantic parity must pass");
        // price_match literal semantic preserved (historically false when TP1 !== TP2)
        assert.equal(parityResult.price_match, false, "price_match literal equality must remain false when TP1 !== TP2");
        assert.equal(parityResult.entry_allowed, true, "Entry must be allowed");
    });

    // 11. Lifecycle Authority Integration
    it("CASE 11: deriveTradeLifecycleAuthority triggers TP1 on dynamic TP price while preserving TP2 backstop", () => {
        const lifecycleResult = deriveTradeLifecycleAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            marketMode: "RANGE",
            directionalShockState: "NONE",
            v2Decision: "HOLD",
            v2Side: "long",
            authoritySource: "v2",
            adoptedEngine: "V2",
            position: {
                symbol: "ETHUSDT",
                side: "LONG",
                entryPrice: 2500.0,
                sizeUsd: 100.0,
                entryStage: 1,
                pnlPct: 0.004,
                takeProfitPlan: {
                    tp1: 2510.0, // dynamic TP1
                    tp2: 2530.0, // backstop TP2
                    invalidationPx: 2480.0
                }
            },
            unrealizedPnl: 0.40,
            unrealizedPnlPct: 0.004,
            holdMs: 60000,
            entryPrice: 2500.0,
            markPrice: 2510.5, // Mark price crossed TP1 (2510.0) but below TP2 (2530.0)
            riskState: "NORMAL",
            cooldownState: { reason: null, remainingMs: null, reentryBlocked: false },
            microExecution: null,
            reversalQuality: 0.8,
            rawMetricsSummary: {
                qualityScore: 0.8,
                rangeConfidence: 0.8,
                trendWeaknessScore: 0.2,
                boxPos: 0.55,
                boxHigh: 2520.0,
                boxLow: 2500.0
            },
            atr: 10.0,
            takeProfitPlan: {
                tp1: 2510.0,
                tp2: 2530.0,
                invalidationPx: 2480.0
            }
        });

        assert.equal(lifecycleResult.tp1Triggered, true, "TP1 must be triggered at 2510.0");
        assert.equal(lifecycleResult.tp2Triggered, undefined, "TP2 must NOT be triggered");
        assert.equal(lifecycleResult.partialAction, "reduce", "Partial reduce action must be set");
        assert.equal(lifecycleResult.reduceRatio, 0.5, "50% reduce ratio must be set");
        assert.equal(lifecycleResult.takeProfit2Px, 2530.0, "TP2 backstop must remain 2530.0");
    });
});
