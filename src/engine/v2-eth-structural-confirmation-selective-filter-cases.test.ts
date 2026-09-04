import assert from "node:assert/strict";
import { evaluateEthStructuralConfirmationSelectiveFilter } from "../engine-v2/market-judgment/eth-selective-probe-gate";

function runTests() {
    console.log("=== RUNNING V2 ETH STRUCTURAL CONFIRMATION SELECTIVE FILTER TESTS ===");

    // Case A: 12 Blocked Historical Cases Fixtures
    const historicalBlockedCases = [
        { id: "ETHUSDT:short:1786463831916", side: "short" as const, emaGap: 0.0045, tw: 0.55 },
        { id: "ETHUSDT:long:1786486344979", side: "long" as const, emaGap: -0.0035, tw: 0.45 },
        { id: "ETHUSDT:short:1786498289323", side: "short" as const, emaGap: 0.0040, tw: 0.50 },
        { id: "ETHUSDT:short:1786517861500", side: "short" as const, emaGap: 0.0050, tw: 0.60 },
        { id: "ETHUSDT:short:1786524779551", side: "short" as const, emaGap: 0.0038, tw: 0.42 },
        { id: "ETHUSDT:short:1786570639685", side: "short" as const, emaGap: 0.0042, tw: 0.48 },
        { id: "ETHUSDT:short:1786596619836", side: "short" as const, emaGap: 0.0055, tw: 0.52 },
        { id: "ETHUSDT:short:1786919901313", side: "short" as const, shock: "UP_SHOCK", emaGap: 0.0060, tw: 0.65 },
        { id: "ETHUSDT:long:1787157134275", side: "long" as const, shock: "DOWN_SHOCK", emaGap: -0.0050, tw: 0.58 },
        { id: "ETHUSDT:long:1787219205057", side: "long" as const, shock: "DOWN_SHOCK", emaGap: -0.0065, tw: 0.70 },
        { id: "ETHUSDT:long:1787298311127", side: "long" as const, shock: "DOWN_SHOCK", emaGap: -0.0048, tw: 0.45 },
        { id: "ETHUSDT:long:1787354660368", side: "long" as const, shock: "DOWN_SHOCK", emaGap: -0.0055, tw: 0.62 }
    ];

    historicalBlockedCases.forEach((c, i) => {
        const result = evaluateEthStructuralConfirmationSelectiveFilter({
            symbol: "ETHUSDT",
            side: c.side,
            probeSemantic: c.side === "long" ? "EARLY_LONG_PROBE" : "EARLY_SHORT_PROBE",
            shockPhase: c.shock ?? "NONE",
            directionalShockState: c.shock === "DOWN_SHOCK" ? "DOWN" : (c.shock === "UP_SHOCK" ? "UP" : "NONE"),
            emaGap: c.emaGap,
            trendWeaknessScore: c.tw,
            reclaimConfirmed: false,
            retestConfirmed: false,
            reversalConfirmed: false
        });

        assert.equal(result.blocked, true, `Case A.${i + 1}: ${c.id} must be BLOCKED`);
        assert.equal(result.blockReason, "ETH_UNCONFIRMED_COUNTER_TREND_PROBE_BLOCKED", `Case A.${i + 1}: blockReason mismatch`);
        assert.equal(result.countertrendAgainstMacro, true, `Case A.${i + 1}: must be countertrend`);
        assert.equal(result.structuralConfirmationCount, 0, `Case A.${i + 1}: structuralConfirmationCount must be 0`);
    });
    console.log("PASS: Case A - All 12 historical bad entries successfully BLOCKED");

    // Case B: Winning ETH trades preserved (aligned or confirmed)
    {
        const result = evaluateEthStructuralConfirmationSelectiveFilter({
            symbol: "ETHUSDT",
            side: "long",
            probeSemantic: "EARLY_LONG_PROBE",
            macroPolarity: "BULLISH",
            htfH1Bias: "BULLISH",
            htfH4Bias: "BULLISH",
            shockPhase: "UP_SHOCK",
            directionalShockState: "UP",
            emaGap: 0.005,
            trendWeaknessScore: 0.20,
            reclaimConfirmed: true,
            retestConfirmed: false,
            reversalConfirmed: true
        });
        assert.equal(result.blocked, false, "Case B: Aligned confirmed ETH winner must NOT be blocked");
        assert.equal(result.blockReason, null);
        console.log("PASS: Case B - Winning ETH trade preserved");
    }

    // Case C: ETH countertrend probe + reclaim true => NOT BLOCKED
    {
        const result = evaluateEthStructuralConfirmationSelectiveFilter({
            symbol: "ETHUSDT",
            side: "long",
            probeSemantic: "EARLY_LONG_PROBE",
            shockPhase: "DOWN_SHOCK",
            directionalShockState: "DOWN",
            emaGap: -0.005,
            trendWeaknessScore: 0.50,
            reclaimConfirmed: true, // Structure confirmed!
            retestConfirmed: false,
            reversalConfirmed: false
        });
        assert.equal(result.blocked, false, "Case C: Reclaim confirmed probe must NOT be blocked");
        assert.equal(result.structuralConfirmationCount, 1);
        console.log("PASS: Case C - Countertrend probe with reclaim confirmed passed");
    }

    // Case D: ETH countertrend probe + retest true => NOT BLOCKED
    {
        const result = evaluateEthStructuralConfirmationSelectiveFilter({
            symbol: "ETHUSDT",
            side: "short",
            probeSemantic: "EARLY_SHORT_PROBE",
            shockPhase: "UP_SHOCK",
            directionalShockState: "UP",
            emaGap: 0.005,
            trendWeaknessScore: 0.50,
            reclaimConfirmed: false,
            retestConfirmed: true, // Retest confirmed!
            reversalConfirmed: false
        });
        assert.equal(result.blocked, false, "Case D: Retest confirmed probe must NOT be blocked");
        assert.equal(result.structuralConfirmationCount, 1);
        console.log("PASS: Case D - Countertrend probe with retest confirmed passed");
    }

    // Case E: ETH countertrend probe + reversal true => NOT BLOCKED
    {
        const result = evaluateEthStructuralConfirmationSelectiveFilter({
            symbol: "ETHUSDT",
            side: "long",
            probeSemantic: "FAST_TREND_SHIFT_PROBE",
            shockPhase: "DOWN_SHOCK",
            directionalShockState: "DOWN",
            emaGap: -0.004,
            trendWeaknessScore: 0.45,
            reclaimConfirmed: false,
            retestConfirmed: false,
            reversalConfirmed: true // Higher low confirmed!
        });
        assert.equal(result.blocked, false, "Case E: Reversal confirmed probe must NOT be blocked");
        assert.equal(result.structuralConfirmationCount, 1);
        console.log("PASS: Case E - Countertrend probe with reversal confirmed passed");
    }

    // Case F: No structural confirmation but NOT countertrend => NOT BLOCKED
    {
        const result = evaluateEthStructuralConfirmationSelectiveFilter({
            symbol: "ETHUSDT",
            side: "long",
            probeSemantic: "EARLY_LONG_PROBE",
            macroPolarity: "BULLISH",
            htfH1Bias: "BULLISH",
            htfH4Bias: "BULLISH",
            shockPhase: "NONE",
            directionalShockState: "NONE",
            emaGap: 0.002, // Aligned with long!
            trendWeaknessScore: 0.45,
            reclaimConfirmed: false,
            retestConfirmed: false,
            reversalConfirmed: false
        });
        assert.equal(result.blocked, false, "Case F: Trend-aligned unconfirmed probe must NOT be blocked");
        assert.equal(result.countertrendAgainstMacro, false);
        console.log("PASS: Case F - Trend-aligned probe passed");
    }

    // Case G: Countertrend but risk evidence below threshold => NOT BLOCKED
    {
        const result = evaluateEthStructuralConfirmationSelectiveFilter({
            symbol: "ETHUSDT",
            side: "short",
            probeSemantic: "EARLY_SHORT_PROBE",
            macroPolarity: "NEUTRAL",
            htfH1Bias: "RANGE",
            htfH4Bias: "RANGE",
            shockPhase: "NONE",
            directionalShockState: "NONE",
            emaGap: 0.001, // Tiny gap, not adverse
            trendWeaknessScore: 0.25, // Low weakness
            reclaimConfirmed: false,
            retestConfirmed: false,
            reversalConfirmed: false
        });
        assert.equal(result.blocked, false, "Case G: Low-risk countertrend probe must NOT be blocked");
        assert.equal(result.riskClausePassed, false);
        console.log("PASS: Case G - Low-risk probe passed");
    }

    // Case H: BTC with identical countertrend conditions => NOT BLOCKED (ETH ONLY!)
    {
        const result = evaluateEthStructuralConfirmationSelectiveFilter({
            symbol: "BTCUSDT", // BTC!
            side: "long",
            probeSemantic: "EARLY_LONG_PROBE",
            shockPhase: "DOWN_SHOCK",
            directionalShockState: "DOWN",
            emaGap: -0.006,
            trendWeaknessScore: 0.60,
            reclaimConfirmed: false,
            retestConfirmed: false,
            reversalConfirmed: false
        });
        assert.equal(result.blocked, false, "Case H: BTC must NEVER be blocked by ETH filter");
        assert.equal(result.blockReason, null);
        console.log("PASS: Case H - BTC completely unaffected");
    }

    // Case I: Non-probe ETH entry (Full Position / Normal Range) => NOT BLOCKED
    {
        const result = evaluateEthStructuralConfirmationSelectiveFilter({
            symbol: "ETHUSDT",
            side: "long",
            probeSemantic: "FULL_POSITION_ENTRY", // Non-probe
            shockPhase: "DOWN_SHOCK",
            directionalShockState: "DOWN",
            emaGap: -0.006,
            trendWeaknessScore: 0.60,
            reclaimConfirmed: false,
            retestConfirmed: false,
            reversalConfirmed: false
        });
        assert.equal(result.blocked, false, "Case I: Non-probe entry must NOT be blocked");
        console.log("PASS: Case I - Non-probe ETH entry passed");
    }

    console.log("\nALL ETH STRUCTURAL CONFIRMATION SELECTIVE FILTER TESTS PASSED!");
}

runTests();
