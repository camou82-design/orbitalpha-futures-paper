import assert from "node:assert/strict";
import {
    evaluateEquityAdaptiveSizing
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import {
    evaluatePreEntryTpParity
} from "../engine-v2/execution/pre-entry-tp-provenance";
import { resolveLiveSubmitStaticSafetyCap } from "./paper-engine";

function runTests() {
    console.log("=== RUNNING V2 LIVE CAP & TP PARITY VERIFICATION TESTS ===");

    // =========================================================================
    // PART 1: SIZING & SUBMIT NOTIONAL TESTS (Cases A - F)
    // =========================================================================

    // Case A: FULL 3659 raw risk calculation -> final sizing 40 -> submitted <= 40
    {
        const sizing = evaluateEquityAdaptiveSizing({
            symbol: "ETHUSDT",
            side: "short",
            orderKind: "ENTRY",
            accountEquityUsdt: 12000,
            availableBalanceUsdt: 10000,
            entryReferencePrice: 2730.0,
            effectiveStopPrice: 2740.0, // tight SL -> risk based notional would be huge (~3600+)
            appliedLeverage: 3,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            legacyStaticCapUsdt: 40,
            v2AuthorityEntry: true,
            lastPrice: 2730.0,
            entryProbeSizeMultiplier: 1.0,
            entryProbeSizingSource: "FULL_POSITION"
        });

        assert.equal(sizing.sizingPassed, true, "Case A: Sizing must pass");
        assert.ok(sizing.riskBasedNotionalUsdt > 1000, "Case A: Raw risk based notional is large (>1000)");
        assert.equal(sizing.cappedFullEntryNotionalUsdt, 500, "Case A: V2 authority hard cap is 500 (not legacy 40)");
        assert.equal(sizing.finalOrderNotionalUsdt, 500, "Case A: Final order notional follows V2 hard cap");
        assert.equal(sizing.probeMultiplierApplied, 1.0, "Case A: Probe multiplier is 1.0");

        const submitCap = resolveLiveSubmitStaticSafetyCap({
            authoritySource: "v2",
            okxLiveStaticNotionalCapEnabled: true,
            staticSafetyCapUsdt: 40,
            intendedNotionalUsdt: sizing.finalOrderNotionalUsdt,
            emergencyUltimateCapUsdt: null
        });
        assert.equal(submitCap.skipStaticCapForV2Authority, true, "Case A: V2 authority skips legacy static 40 cap");
        assert.equal(submitCap.finalSubmittedNotionalUsdt, 500, "Case A: Submitted notional follows V2 sizing");
        console.log("PASS: Case A - V2 authority 500 cap, legacy 40 static cap skipped on submit");
    }

    // Case B: 0.50 probe -> final/submitted 20
    {
        const sizing = evaluateEquityAdaptiveSizing({
            symbol: "ETHUSDT",
            side: "short",
            orderKind: "ENTRY",
            accountEquityUsdt: 12000,
            availableBalanceUsdt: 10000,
            entryReferencePrice: 2730.0,
            effectiveStopPrice: 2740.0,
            appliedLeverage: 3,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            legacyStaticCapUsdt: 40,
            v2AuthorityEntry: true,
            lastPrice: 2730.0,
            entryProbeSizeMultiplier: 0.50,
            entryProbeSizingSource: "LOCATION_PROBE"
        });

        assert.equal(sizing.sizingPassed, true, "Case B: Sizing must pass");
        assert.equal(sizing.cappedFullEntryNotionalUsdt, 500, "Case B: V2 pre-probe cap is 500");
        assert.equal(sizing.probeMultiplierApplied, 0.50, "Case B: Probe multiplier must be 0.50");
        assert.equal(sizing.finalOrderNotionalUsdt, 250, "Case B: Final order notional 500 x 0.50");

        const submitCap = resolveLiveSubmitStaticSafetyCap({
            authoritySource: "v2",
            okxLiveStaticNotionalCapEnabled: true,
            staticSafetyCapUsdt: 40,
            intendedNotionalUsdt: sizing.finalOrderNotionalUsdt,
            emergencyUltimateCapUsdt: null
        });
        assert.equal(submitCap.finalSubmittedNotionalUsdt, 250, "Case B: Submitted notional must be 250");
        console.log("PASS: Case B - V2 0.50 probe -> final/submitted 250");
    }

    // Case C: 0.25 edge probe -> final/submitted 10
    {
        const sizing = evaluateEquityAdaptiveSizing({
            symbol: "ETHUSDT",
            side: "short",
            orderKind: "ENTRY",
            accountEquityUsdt: 12000,
            availableBalanceUsdt: 10000,
            entryReferencePrice: 2730.0,
            effectiveStopPrice: 2740.0,
            appliedLeverage: 3,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            legacyStaticCapUsdt: 40,
            v2AuthorityEntry: true,
            lastPrice: 2730.0,
            entryProbeSizeMultiplier: 0.25,
            entryProbeSizingSource: "COUNTERTREND_EDGE_PROBE"
        });

        assert.equal(sizing.sizingPassed, true, "Case C: Sizing must pass");
        assert.equal(sizing.cappedFullEntryNotionalUsdt, 500, "Case C: V2 pre-probe cap is 500");
        assert.equal(sizing.probeMultiplierApplied, 0.25, "Case C: Probe multiplier must be 0.25");
        assert.equal(sizing.finalOrderNotionalUsdt, 125, "Case C: Final order notional 500 x 0.25");

        const submitCap = resolveLiveSubmitStaticSafetyCap({
            authoritySource: "v2",
            okxLiveStaticNotionalCapEnabled: true,
            staticSafetyCapUsdt: 40,
            intendedNotionalUsdt: sizing.finalOrderNotionalUsdt,
            emergencyUltimateCapUsdt: null
        });
        assert.equal(submitCap.finalSubmittedNotionalUsdt, 125, "Case C: Submitted notional must be 125");
        console.log("PASS: Case C - V2 0.25 edge probe -> final/submitted 125");
    }

    // Case D: Emergency cap = 30 and active -> FULL <= 30
    {
        const sizing = evaluateEquityAdaptiveSizing({
            symbol: "ETHUSDT",
            side: "short",
            orderKind: "ENTRY",
            accountEquityUsdt: 12000,
            availableBalanceUsdt: 10000,
            entryReferencePrice: 2730.0,
            effectiveStopPrice: 2740.0,
            appliedLeverage: 3,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            legacyStaticCapUsdt: 40,
            emergencyAbsoluteCapUsdt: 30,
            emergencyFailsafeActive: true,
            v2AuthorityEntry: true,
            lastPrice: 2730.0,
            entryProbeSizeMultiplier: 1.0,
            entryProbeSizingSource: "FULL_POSITION"
        });

        assert.equal(sizing.sizingPassed, true, "Case D: Sizing must pass");
        assert.equal(sizing.cappedFullEntryNotionalUsdt, 30, "Case D: Active emergency cap (30) overrides 40");
        assert.equal(sizing.finalOrderNotionalUsdt, 30, "Case D: Final order notional must be 30");

        const submitCap = resolveLiveSubmitStaticSafetyCap({
            authoritySource: "v2",
            okxLiveStaticNotionalCapEnabled: true,
            staticSafetyCapUsdt: 40,
            intendedNotionalUsdt: sizing.finalOrderNotionalUsdt,
            emergencyUltimateCapUsdt: 30,
            emergencyFailsafeActive: true
        });
        assert.equal(submitCap.finalSubmittedNotionalUsdt, 30, "Case D: Submitted notional must be <= 30");
        console.log("PASS: Case D - Emergency cap 30 active -> FULL <= 30");
    }

    // Case E: Account/symbol/margin cap < 40 -> smaller value used
    {
        const sizing = evaluateEquityAdaptiveSizing({
            symbol: "ETHUSDT",
            side: "short",
            orderKind: "ENTRY",
            accountEquityUsdt: 10, // Very small equity -> max initial notional cap = 10 * 2.3 = 23 USDT
            availableBalanceUsdt: 10,
            entryReferencePrice: 2730.0,
            effectiveStopPrice: 2740.0,
            appliedLeverage: 3,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            legacyStaticCapUsdt: 40,
            v2AuthorityEntry: true,
            lastPrice: 2730.0,
            entryProbeSizeMultiplier: 1.0,
            entryProbeSizingSource: "FULL_POSITION"
        });

        assert.equal(sizing.sizingPassed, true, "Case E: Sizing must pass");
        assert.ok(sizing.finalOrderNotionalUsdt <= 23, "Case E: Small equity cap (23) strictly constrains notional below 40");
        console.log("PASS: Case E - Account/symbol cap < 40 -> smaller value used");
    }

    // Case F: BTC V2 uses same 500 hard cap (legacy 40 not applied on authority path)
    {
        const sizing = evaluateEquityAdaptiveSizing({
            symbol: "BTCUSDT",
            side: "long",
            orderKind: "ENTRY",
            accountEquityUsdt: 20000,
            availableBalanceUsdt: 15000,
            entryReferencePrice: 80000.0,
            effectiveStopPrice: 79800.0,
            appliedLeverage: 3,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            legacyStaticCapUsdt: 40,
            v2AuthorityEntry: true,
            lastPrice: 80000.0,
            entryProbeSizeMultiplier: 1.0,
            entryProbeSizingSource: "FULL_POSITION"
        });

        assert.equal(sizing.sizingPassed, true, "Case F: BTC Sizing must pass");
        assert.equal(sizing.finalOrderNotionalUsdt, 500, "Case F: BTC V2 final notional capped at 500");

        const submitCap = resolveLiveSubmitStaticSafetyCap({
            authoritySource: "v2",
            okxLiveStaticNotionalCapEnabled: true,
            staticSafetyCapUsdt: 40,
            intendedNotionalUsdt: sizing.finalOrderNotionalUsdt,
            emergencyUltimateCapUsdt: null
        });
        assert.equal(submitCap.finalSubmittedNotionalUsdt, 500, "Case F: BTC V2 submit notional 500");
        console.log("PASS: Case F - BTC V2 500 cap, legacy 40 skipped on submit");
    }

    // =========================================================================
    // PART 2: TP PARITY TESTS (Cases G - M)
    // =========================================================================

    // Case G: SHORT TP1=TP2<Entry -> COLLAPSED_SINGLE_TP PASS (Cycle 1072 real condition)
    {
        const result = evaluatePreEntryTpParity({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            marketSubtype: "FAST_TREND_SHIFT",
            tickSz: 0.01,
            entryReferencePrice: 2728.37,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 2724.62,
            canonicalTp2Executable: 2724.62,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "adaptive_range_box_target",
            profitabilityTpSource: "adaptive_range_box_target",
            profitabilityTpRaw: 2724.62,
            profitabilityTpExecutable: 2724.62,
            committedTpRaw: 2724.62,
            committedTpExecutable: 2724.62,
            committedTpSource: "adaptive_range_box_target",
            attachedTp: 2724.62
        });

        assert.equal(result.entry_allowed, true, "Case G: Collapsed SHORT TP must allow entry");
        assert.equal(result.block_reason, null, "Case G: block_reason must be null");
        assert.equal(result.tp_parity_semantic, "COLLAPSED_SINGLE_TP", "Case G: Semantic must be COLLAPSED_SINGLE_TP");
        assert.equal(result.tp1_parity_passed, true, "Case G: tp1_parity_passed must be true");
        assert.equal(result.tp2_backstop_parity_passed, true, "Case G: tp2_backstop_parity_passed must be true");
        assert.equal(result.directional_alignment_passed, true, "Case G: directional_alignment_passed must be true");
        assert.equal(result.semantic_parity_passed, true, "Case G: semantic_parity_passed must be true");
        assert.equal(result.price_match, true, "Case G: price_match must be true");
        console.log("PASS: Case G - SHORT TP1=TP2<Entry -> COLLAPSED_SINGLE_TP PASS");
    }

    // Case H: LONG Entry<TP1=TP2 -> COLLAPSED_SINGLE_TP PASS
    {
        const result = evaluatePreEntryTpParity({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            marketSubtype: "FAST_TREND_SHIFT",
            tickSz: 0.01,
            entryReferencePrice: 2720.00,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 2735.50,
            canonicalTp2Executable: 2735.50,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "adaptive_range_box_target",
            profitabilityTpSource: "adaptive_range_box_target",
            profitabilityTpRaw: 2735.50,
            profitabilityTpExecutable: 2735.50,
            committedTpRaw: 2735.50,
            committedTpExecutable: 2735.50,
            committedTpSource: "adaptive_range_box_target",
            attachedTp: 2735.50
        });

        assert.equal(result.entry_allowed, true, "Case H: Collapsed LONG TP must allow entry");
        assert.equal(result.block_reason, null);
        assert.equal(result.tp_parity_semantic, "COLLAPSED_SINGLE_TP");
        assert.equal(result.directional_alignment_passed, true);
        assert.equal(result.semantic_parity_passed, true);
        console.log("PASS: Case H - LONG Entry<TP1=TP2 -> COLLAPSED_SINGLE_TP PASS");
    }

    // Case I: SHORT genuine TP2<TP1<Entry -> 기존 partial PASS
    {
        const result = evaluatePreEntryTpParity({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            marketSubtype: "FAST_TREND_SHIFT",
            tickSz: 0.01,
            entryReferencePrice: 2730.00,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 2710.00,
            canonicalTp2Executable: 2710.00,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "adaptive_range_box_target",
            profitabilityTpSource: "adaptive_range_box_target",
            profitabilityTpRaw: 2720.00,
            profitabilityTpExecutable: 2720.00,
            committedTpRaw: 2720.00,
            committedTpExecutable: 2710.00,
            committedTpSource: "adaptive_range_box_target",
            attachedTp: 2710.00
        });

        assert.equal(result.entry_allowed, true, "Case I: Genuine SHORT partial plan must pass");
        assert.equal(result.tp_parity_semantic, "RANGE_PARTIAL_TP1_LIFECYCLE_TP2_BACKSTOP");
        assert.equal(result.tp1_parity_passed, true);
        assert.equal(result.tp2_backstop_parity_passed, true);
        assert.equal(result.directional_alignment_passed, true);
        assert.equal(result.semantic_parity_passed, true);
        console.log("PASS: Case I - SHORT genuine TP2<TP1<Entry -> 기존 partial PASS");
    }

    // Case J: LONG Entry<TP1<TP2 -> 기존 partial PASS
    {
        const result = evaluatePreEntryTpParity({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            marketSubtype: "FAST_TREND_SHIFT",
            tickSz: 0.01,
            entryReferencePrice: 2720.00,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 2740.00,
            canonicalTp2Executable: 2740.00,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "adaptive_range_box_target",
            profitabilityTpSource: "adaptive_range_box_target",
            profitabilityTpRaw: 2730.00,
            profitabilityTpExecutable: 2730.00,
            committedTpRaw: 2730.00,
            committedTpExecutable: 2740.00,
            committedTpSource: "adaptive_range_box_target",
            attachedTp: 2740.00
        });

        assert.equal(result.entry_allowed, true, "Case J: Genuine LONG partial plan must pass");
        assert.equal(result.tp_parity_semantic, "RANGE_PARTIAL_TP1_LIFECYCLE_TP2_BACKSTOP");
        assert.equal(result.directional_alignment_passed, true);
        assert.equal(result.semantic_parity_passed, true);
        console.log("PASS: Case J - LONG Entry<TP1<TP2 -> 기존 partial PASS");
    }

    // Case K: SHORT TP2>TP1 or TP>=Entry -> BLOCK
    {
        // Subcase K1: TP2 > TP1
        const result1 = evaluatePreEntryTpParity({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            tickSz: 0.01,
            entryReferencePrice: 2730.00,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 2725.00,
            canonicalTp2Executable: 2725.00,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "adaptive_range_box_target",
            profitabilityTpSource: "adaptive_range_box_target",
            profitabilityTpRaw: 2720.00,
            profitabilityTpExecutable: 2720.00,
            committedTpRaw: 2720.00,
            committedTpExecutable: 2725.00,
            committedTpSource: "adaptive_range_box_target",
            attachedTp: 2725.00 // TP2 (2725) > TP1 (2720) for SHORT
        });
        assert.equal(result1.entry_allowed, false, "Case K1: Must block invalid SHORT ordering");
        assert.equal(result1.block_reason, "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE");

        // Subcase K2: Collapsed SHORT TP >= Entry
        const result2 = evaluatePreEntryTpParity({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            tickSz: 0.01,
            entryReferencePrice: 2720.00,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 2725.00,
            canonicalTp2Executable: 2725.00,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "adaptive_range_box_target",
            profitabilityTpSource: "adaptive_range_box_target",
            profitabilityTpRaw: 2725.00,
            profitabilityTpExecutable: 2725.00,
            committedTpRaw: 2725.00,
            committedTpExecutable: 2725.00,
            committedTpSource: "adaptive_range_box_target",
            attachedTp: 2725.00 // TP (2725) > Entry (2720) for SHORT
        });
        assert.equal(result2.entry_allowed, false, "Case K2: Must block SHORT TP > Entry");
        assert.equal(result2.block_reason, "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE");
        console.log("PASS: Case K - SHORT TP2>TP1 or TP>=Entry -> BLOCK");
    }

    // Case L: LONG TP2<TP1 or TP<=Entry -> BLOCK
    {
        // Subcase L1: TP2 < TP1 for LONG
        const result1 = evaluatePreEntryTpParity({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            tickSz: 0.01,
            entryReferencePrice: 2720.00,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 2725.00,
            canonicalTp2Executable: 2725.00,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "adaptive_range_box_target",
            profitabilityTpSource: "adaptive_range_box_target",
            profitabilityTpRaw: 2730.00,
            profitabilityTpExecutable: 2730.00,
            committedTpRaw: 2730.00,
            committedTpExecutable: 2725.00,
            committedTpSource: "adaptive_range_box_target",
            attachedTp: 2725.00 // TP2 (2725) < TP1 (2730) for LONG
        });
        assert.equal(result1.entry_allowed, false, "Case L1: Must block invalid LONG ordering");
        assert.equal(result1.block_reason, "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE");

        // Subcase L2: Collapsed LONG TP <= Entry
        const result2 = evaluatePreEntryTpParity({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            tickSz: 0.01,
            entryReferencePrice: 2730.00,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 2725.00,
            canonicalTp2Executable: 2725.00,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "adaptive_range_box_target",
            profitabilityTpSource: "adaptive_range_box_target",
            profitabilityTpRaw: 2725.00,
            profitabilityTpExecutable: 2725.00,
            committedTpRaw: 2725.00,
            committedTpExecutable: 2725.00,
            committedTpSource: "adaptive_range_box_target",
            attachedTp: 2725.00 // TP (2725) < Entry (2730) for LONG
        });
        assert.equal(result2.entry_allowed, false, "Case L2: Must block LONG TP < Entry");
        assert.equal(result2.block_reason, "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE");
        console.log("PASS: Case L - LONG TP2<TP1 or TP<=Entry -> BLOCK");
    }

    // Case M: profitability/committed/attached TP mismatch -> DIVERGENCE BLOCK
    {
        const result = evaluatePreEntryTpParity({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            tickSz: 0.01,
            entryReferencePrice: 2728.37,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 2724.62,
            canonicalTp2Executable: 2724.62,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "adaptive_range_box_target",
            profitabilityTpSource: "adaptive_range_box_target",
            profitabilityTpRaw: 2724.62,
            profitabilityTpExecutable: 2724.62,
            committedTpRaw: 2720.00, // Mismatched committed TP
            committedTpExecutable: 2724.62,
            committedTpSource: "adaptive_range_box_target",
            attachedTp: 2724.62
        });

        assert.equal(result.entry_allowed, false, "Case M: Must block on parity mismatch");
        assert.equal(result.block_reason, "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE");
        console.log("PASS: Case M - TP source/price mismatch -> DIVERGENCE BLOCK");
    }

    // =========================================================================
    // PART 3: End-to-End Pipeline Reproduction (Run Cycle 1072 format)
    // =========================================================================
    {
        console.log("\n--- SIMULATING CYCLE 1072 PIPELINE ---");
        // 1. Sizing stage:
        const sizing = evaluateEquityAdaptiveSizing({
            symbol: "ETHUSDT",
            side: "short",
            orderKind: "ENTRY",
            accountEquityUsdt: 12198.8,
            availableBalanceUsdt: 10452.1,
            entryReferencePrice: 2728.37,
            effectiveStopPrice: 2737.52, // stopDistance = 9.15
            appliedLeverage: 3,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            legacyStaticCapUsdt: 40,
            v2AuthorityEntry: true,
            lastPrice: 2728.37,
            entryProbeSizeMultiplier: 1.0,
            entryProbeSizingSource: "FULL_POSITION"
        });

        assert.equal(sizing.sizingPassed, true);
        assert.equal(sizing.cappedFullEntryNotionalUsdt, 500);
        assert.equal(sizing.finalOrderNotionalUsdt, 500);

        // 2. Pre-entry TP parity check stage (Cycle 1072 exact values: entry=2728.37, TP1=2724.62, TP2=2724.62, attached=2724.62)
        const parityResult = evaluatePreEntryTpParity({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            marketSubtype: "FAST_TREND_SHIFT",
            tickSz: 0.01,
            entryReferencePrice: 2728.37,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 2724.62,
            canonicalTp2Executable: 2724.62,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "adaptive_range_box_target",
            profitabilityTpSource: "adaptive_range_box_target",
            profitabilityTpRaw: 2724.62,
            profitabilityTpExecutable: 2724.62,
            committedTpRaw: 2724.62,
            committedTpExecutable: 2724.62,
            committedTpSource: "adaptive_range_box_target",
            attachedTp: 2724.62
        });

        assert.equal(parityResult.entry_allowed, true, "Cycle 1072: Parity check must allow entry");
        assert.equal(parityResult.tp_parity_semantic, "COLLAPSED_SINGLE_TP", "Cycle 1072: Must be classified as COLLAPSED_SINGLE_TP");

        // 3. Submit pre-flight clamp stage:
        const submitCap = resolveLiveSubmitStaticSafetyCap({
            authoritySource: "v2",
            okxLiveStaticNotionalCapEnabled: true,
            staticSafetyCapUsdt: 40,
            intendedNotionalUsdt: sizing.finalOrderNotionalUsdt,
            emergencyUltimateCapUsdt: null
        });

        assert.equal(submitCap.skipStaticCapForV2Authority, true);
        assert.equal(submitCap.finalSubmittedNotionalUsdt, 500, "Cycle 1072: V2 authority submits sized notional (500)");

        console.log("PASS: Cycle 1072 pipeline end-to-end simulation passed (TP parity PASS, V2 submit 500 USDT)");
    }

    console.log("\nALL V2 LIVE CAP & TP PARITY VERIFICATION TESTS PASSED SUCCESSFULLY!");
}

runTests();
