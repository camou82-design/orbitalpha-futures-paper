import assert from "node:assert/strict";
import { evaluatePreEntryTpParity } from "../engine-v2/execution/pre-entry-tp-provenance";

function runTests() {
    console.log("=== RUNNING V2 RANGE PARTIAL TP PARITY TESTS ===");

    // Case 1: Cycle 4730 exact BTCUSDT LONG SHOCK_REACTION_UP
    // entry = 79828.9, profitability TP1 = 80068.4, attached TP2 backstop = 81331.6
    {
        const result = evaluatePreEntryTpParity({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            marketSubtype: "SHOCK_REACTION_UP",
            tickSz: 0.1,
            entryReferencePrice: 79828.9,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 81331.6,
            canonicalTp2Executable: 81331.6,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "execMeta.takeProfitPlan.tp1",
            profitabilityTpSource: "authority_tp_price",
            profitabilityTpRaw: 80068.3867,
            profitabilityTpExecutable: 80068.4,
            committedTpRaw: 80068.4,
            committedTpExecutable: 81331.6,
            committedTpSource: "authority_tp_price",
            attachedTp: 81331.6
        });

        assert.equal(result.entry_allowed, true, "Case 1: Cycle 4730 must allow entry");
        assert.equal(result.block_reason, null, "Case 1: block_reason must be null");
        assert.equal(result.price_match, false, "Case 1: literal price_match must be false when TP1 !== TP2");
        assert.equal(result.tp_parity_semantic, "RANGE_PARTIAL_TP1_LIFECYCLE_TP2_BACKSTOP", "Case 1: semantic must be RANGE_PARTIAL");
        assert.equal(result.profitability_tp1_executable, 80068.4, "Case 1: profitability_tp1_executable must be 80068.4");
        assert.equal(result.lifecycle_tp1_executable, 80068.4, "Case 1: lifecycle_tp1_executable must be 80068.4");
        assert.equal(result.attached_tp_executable, 81331.6, "Case 1: attached_tp_executable must be 81331.6");
        assert.equal(result.canonical_tp2_backstop_executable, 81331.6, "Case 1: canonical_tp2_backstop_executable must be 81331.6");
        assert.equal(result.tp1_parity_passed, true, "Case 1: tp1_parity_passed must be true");
        assert.equal(result.tp2_backstop_parity_passed, true, "Case 1: tp2_backstop_parity_passed must be true");
        assert.equal(result.directional_alignment_passed, true, "Case 1: directional_alignment_passed must be true");
        assert.equal(result.semantic_parity_passed, true, "Case 1: semantic_parity_passed must be true");
        console.log("PASS: Case 1 - Cycle 4730 BTC LONG range partial TP parity passed");
    }

    // Case 2: True TP1 mismatch in Range partial plan -> BLOCK
    {
        const result = evaluatePreEntryTpParity({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            marketSubtype: "SHOCK_REACTION_UP",
            tickSz: 0.1,
            entryReferencePrice: 79828.9,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 81331.6,
            canonicalTp2Executable: 81331.6,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "execMeta.takeProfitPlan.tp1",
            profitabilityTpSource: "authority_tp_price",
            profitabilityTpRaw: 80068.3867,
            profitabilityTpExecutable: 80068.4,
            committedTpRaw: 80200.0, // Mismatched committed TP1
            committedTpExecutable: 81331.6,
            committedTpSource: "authority_tp_price",
            attachedTp: 81331.6
        });

        assert.equal(result.entry_allowed, false, "Case 2: Must block on TP1 mismatch");
        assert.equal(result.block_reason, "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE", "Case 2: Must emit DIVERGENCE");
        assert.equal(result.tp1_parity_passed, false, "Case 2: tp1_parity_passed must be false");
        console.log("PASS: Case 2 - True TP1 mismatch blocked");
    }

    // Case 3: True TP2 backstop mismatch in Range partial plan -> BLOCK
    {
        const result = evaluatePreEntryTpParity({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            marketSubtype: "SHOCK_REACTION_UP",
            tickSz: 0.1,
            entryReferencePrice: 79828.9,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 81331.6,
            canonicalTp2Executable: 81331.6,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "execMeta.takeProfitPlan.tp1",
            profitabilityTpSource: "authority_tp_price",
            profitabilityTpRaw: 80068.3867,
            profitabilityTpExecutable: 80068.4,
            committedTpRaw: 80068.4,
            committedTpExecutable: 81500.0,
            committedTpSource: "authority_tp_price",
            attachedTp: 81500.0 // Mismatched attached TP2
        });

        assert.equal(result.entry_allowed, false, "Case 3: Must block on TP2 mismatch");
        assert.equal(result.block_reason, "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE", "Case 3: Must emit DIVERGENCE");
        assert.equal(result.tp2_backstop_parity_passed, false, "Case 3: tp2_backstop_parity_passed must be false");
        console.log("PASS: Case 3 - True TP2 backstop mismatch blocked");
    }

    // Case 4: Invalid directional ordering for LONG (TP1 > TP2) -> BLOCK
    {
        const result = evaluatePreEntryTpParity({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            marketSubtype: "SHOCK_REACTION_UP",
            tickSz: 0.1,
            entryReferencePrice: 79828.9,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 80000.0,
            canonicalTp2Executable: 80000.0,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "execMeta.takeProfitPlan.tp1",
            profitabilityTpSource: "authority_tp_price",
            profitabilityTpRaw: 80068.4,
            profitabilityTpExecutable: 80068.4,
            committedTpRaw: 80068.4,
            committedTpExecutable: 80000.0,
            committedTpSource: "authority_tp_price",
            attachedTp: 80000.0 // TP2 (80000) < TP1 (80068.4) -> Invalid ordering!
        });

        assert.equal(result.entry_allowed, false, "Case 4: Must block on invalid LONG TP ordering");
        assert.equal(result.block_reason, "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE");
        console.log("PASS: Case 4 - Invalid LONG TP ordering blocked");
    }

    // Case 5: Symmetric SHORT Range partial plan -> PASS
    {
        const result = evaluatePreEntryTpParity({
            symbol: "BTCUSDT",
            side: "short",
            regime: "RANGE",
            marketSubtype: "SHOCK_REACTION_DOWN",
            tickSz: 0.1,
            entryReferencePrice: 80000.0,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 79000.0,
            canonicalTp2Executable: 79000.0,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "execMeta.takeProfitPlan.tp1",
            profitabilityTpSource: "authority_tp_price",
            profitabilityTpRaw: 79800.0,
            profitabilityTpExecutable: 79800.0,
            committedTpRaw: 79800.0,
            committedTpExecutable: 79000.0,
            committedTpSource: "authority_tp_price",
            attachedTp: 79000.0
        });

        assert.equal(result.entry_allowed, true, "Case 5: SHORT Range partial plan must pass");
        assert.equal(result.block_reason, null);
        assert.equal(result.price_match, false, "Case 5: literal price_match must be false");
        assert.equal(result.tp1_parity_passed, true);
        assert.equal(result.tp2_backstop_parity_passed, true);
        assert.equal(result.directional_alignment_passed, true);
        assert.equal(result.semantic_parity_passed, true);
        console.log("PASS: Case 5 - Symmetric SHORT Range partial plan passed");
    }

    // Case 6: Invalid directional ordering for SHORT (TP2 > TP1) -> BLOCK
    {
        const result = evaluatePreEntryTpParity({
            symbol: "BTCUSDT",
            side: "short",
            regime: "RANGE",
            marketSubtype: "SHOCK_REACTION_DOWN",
            tickSz: 0.1,
            entryReferencePrice: 80000.0,
            isV2RangePartialPlan: true,
            canonicalTp2Price: 79900.0,
            canonicalTp2Executable: 79900.0,
            profitabilityTpApproved: true,
            profitabilityCanonicalTpSource: "execMeta.takeProfitPlan.tp1",
            profitabilityTpSource: "authority_tp_price",
            profitabilityTpRaw: 79800.0,
            profitabilityTpExecutable: 79800.0,
            committedTpRaw: 79800.0,
            committedTpExecutable: 79900.0,
            committedTpSource: "authority_tp_price",
            attachedTp: 79900.0 // TP2 (79900) > TP1 (79800) -> Invalid for short!
        });

        assert.equal(result.entry_allowed, false, "Case 6: Must block on invalid SHORT TP ordering");
        assert.equal(result.block_reason, "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE");
        console.log("PASS: Case 6 - Invalid SHORT TP ordering blocked");
    }

    // Case 7: Non-partial plan (Full Position TP) with matching TP -> PASS
    {
        const result = evaluatePreEntryTpParity({
            symbol: "BTCUSDT",
            side: "long",
            regime: "TREND",
            marketSubtype: "TREND_EXPANSION",
            tickSz: 0.1,
            entryReferencePrice: 80000.0,
            isV2RangePartialPlan: false,
            profitabilityTpApproved: false,
            profitabilityCanonicalTpSource: "decision.takeProfit",
            profitabilityTpSource: "authority_tp_price",
            profitabilityTpRaw: 81000.0,
            profitabilityTpExecutable: 81000.0,
            committedTpRaw: 81000.0,
            committedTpExecutable: 81000.0,
            committedTpSource: "authority_tp_price",
            attachedTp: 81000.0
        });

        assert.equal(result.entry_allowed, true, "Case 7: Non-partial matching TP must pass");
        assert.equal(result.tp_parity_semantic, "FULL_POSITION_TP");
        assert.equal(result.price_match, true);
        console.log("PASS: Case 7 - Non-partial plan full position TP passed");
    }

    // Case 8: Non-partial plan with TP mismatch -> BLOCK
    {
        const result = evaluatePreEntryTpParity({
            symbol: "BTCUSDT",
            side: "long",
            regime: "TREND",
            marketSubtype: "TREND_EXPANSION",
            tickSz: 0.1,
            entryReferencePrice: 80000.0,
            isV2RangePartialPlan: false,
            profitabilityTpApproved: false,
            profitabilityCanonicalTpSource: "decision.takeProfit",
            profitabilityTpSource: "authority_tp_price",
            profitabilityTpRaw: 81000.0,
            profitabilityTpExecutable: 81000.0,
            committedTpRaw: 81000.0,
            committedTpExecutable: 81500.0, // Mismatched
            committedTpSource: "authority_tp_price",
            attachedTp: 81500.0
        });

        assert.equal(result.entry_allowed, false, "Case 8: Non-partial TP mismatch must block");
        assert.equal(result.block_reason, "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE");
        console.log("PASS: Case 8 - Non-partial plan mismatch blocked");
    }

    console.log("\nALL 8 V2 RANGE PARTIAL TP PARITY CASES PASSED SUCCESSFULLY!");
}

runTests();
