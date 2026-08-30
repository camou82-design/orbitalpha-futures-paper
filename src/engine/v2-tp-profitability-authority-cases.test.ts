import assert from "node:assert";
import {
    evaluateTpProfitabilityAuthority,
    MINIMUM_TP1_NET_PROFIT_PCT,
    DEFAULT_PAPER_SLIPPAGE_ESTIMATE_BPS
} from "../engine-v2/execution/tp-profitability-authority";

function assertClose(actual: number, expected: number, tol = 1e-6, label = "assertClose") {
    const diff = Math.abs(actual - expected);
    if (diff > tol) {
        throw new Error(`${label}: expected ~${expected}, got ${actual} (diff=${diff} > ${tol})`);
    }
}

function assertTrue(condition: boolean, label: string) {
    if (!condition) {
        throw new Error(`${label}: expected true, got false`);
    }
}

function runTpProfitabilityAuthorityTests() {
    console.info("=== RUNNING V2 TP PROFITABILITY AUTHORITY TEST SUITE ===");

    // =========================================================================
    // SCENARIO A: Historical ETH 2503.37 Defect Reproduction -> STRICT BLOCK
    // Entry: 2503.37, historical TP1: 2509.488075 (+0.2444%)
    // FeeRate: 0.0006 (0.12%), Slippage: 8bps (0.08%), MinNet: 0.12% -> Floor: 0.32%
    // =========================================================================
    {
        const rA = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: 2503.37,
            canonicalTp1Price: 2509.488075,
            canonicalTp1Source: "historical_defect_log",
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz: 0.01
        });

        assertClose(rA.structuralTp1DistancePctRaw, (2509.488075 - 2503.37) / 2503.37, 1e-6, "SCENARIO A raw distance ~0.2444%");
        assertClose(rA.executableTp1Price ?? 0, 2509.49, 1e-6, "SCENARIO A tick-normalized TP1 = 2509.49");
        assertClose(rA.minimumProfitableTpPct, 0.0032, 1e-9, "SCENARIO A floor = 0.32%");
        assertTrue(rA.entryAllowed === false, "SCENARIO A entryAllowed MUST BE FALSE");
        assertTrue(rA.blockReason === "V2_TP1_NET_EDGE_INSUFFICIENT", "SCENARIO A blockReason MUST BE V2_TP1_NET_EDGE_INSUFFICIENT");

        console.info(JSON.stringify({
            event: "SCENARIO_A_HISTORICAL_ETH_2503_PROOF",
            entryPrice: rA.entryPrice,
            canonicalTp1Price: rA.rawCanonicalTp1Price,
            executableTp1Price: rA.executableTp1Price,
            executableDistancePct: rA.executableTp1DistancePct,
            minimumProfitableTpPct: rA.minimumProfitableTpPct,
            entryAllowed: rA.entryAllowed,
            blockReason: rA.blockReason
        }));
    }

    // =========================================================================
    // SCENARIO B: RANGE 0.25% Max Ceiling under 0.0006 Fee -> STRICT BLOCK
    // Entry: 2500, TP1: 2506.25 (+0.25%) -> Floor: 0.32%
    // =========================================================================
    {
        const rB = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: 2500,
            canonicalTp1Price: 2506.25, // +0.250%
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz: 0.01
        });
        assertTrue(rB.entryAllowed === false, "SCENARIO B 0.25% < 0.32% -> BLOCK");
        assertTrue(rB.blockReason === "V2_TP1_NET_EDGE_INSUFFICIENT", "SCENARIO B blockReason");
    }

    // =========================================================================
    // SCENARIO C: Executable TP Exactly 0.32% -> ALLOW
    // =========================================================================
    {
        const entry = 2500;
        const tp1Exact = 2500 * (1 + 0.0032); // 2508.00 (exact on 0.01 tick)
        const rC = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: entry,
            canonicalTp1Price: tp1Exact,
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz: 0.01
        });
        assertClose(rC.executableTp1DistancePct, 0.0032, 1e-9, "SCENARIO C distance exactly 0.32%");
        assertTrue(rC.entryAllowed === true, "SCENARIO C exact threshold -> ALLOW");
        assertTrue(rC.blockReason === null, "SCENARIO C blockReason null");
    }

    // =========================================================================
    // SCENARIO D: Tick Rounding Drops Below Floor -> STRICT BLOCK
    // Long: raw TP has 0.3201% distance, but after tickSz=1.0 rounding drops to 0.319% -> BLOCK
    // Short: raw TP has 0.3201% distance, but after tickSz=1.0 rounding drops to 0.319% -> BLOCK
    // =========================================================================
    {
        // Long sub-tick drop
        const entryLong = 2500;
        // raw TP = 2500 + 7.99 = 2507.99 (+0.3196%). Tick=1.0 rounds to 2508.0 (+0.320%) -> ALLOW
        // raw TP = 2500 + 7.40 = 2507.40 (+0.296%). Tick=1.0 rounds to 2507.0 (+0.280%) -> BLOCK
        const rD_Long = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: entryLong,
            canonicalTp1Price: 2507.40,
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz: 1.0
        });
        assertClose(rD_Long.executableTp1Price ?? 0, 2507.0, 1e-6, "SCENARIO D Long executable TP1 rounded to 2507.0");
        assertTrue(rD_Long.entryAllowed === false, "SCENARIO D Long rounded below floor -> BLOCK");

        // Short sub-tick drop
        const entryShort = 2500;
        const rD_Short = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            entryPrice: entryShort,
            canonicalTp1Price: 2492.60, // -0.296%
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz: 1.0
        });
        assertClose(rD_Short.executableTp1Price ?? 0, 2493.0, 1e-6, "SCENARIO D Short executable TP1 rounded to 2493.0");
        assertTrue(rD_Short.entryAllowed === false, "SCENARIO D Short rounded below floor -> BLOCK");
    }

    // =========================================================================
    // SCENARIO E: Super-Threshold 0.60% TP -> ALLOW & Byte Equivalent
    // =========================================================================
    {
        const entry = 2500;
        const tp1 = 2515.00; // +0.60%
        const rE = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: entry,
            canonicalTp1Price: tp1,
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz: 0.01
        });
        assertTrue(rE.entryAllowed === true, "SCENARIO E +0.60% -> ALLOW");
        assertTrue(rE.rawCanonicalTp1Price === tp1, "SCENARIO E raw canonical preserved");
        assertTrue(rE.executableTp1Price === tp1, "SCENARIO E executable preserved");
    }

    // =========================================================================
    // SCENARIO F: Large TREND / FTS 1.50% TP -> ALLOW & Unchanged
    // =========================================================================
    {
        const entry = 2500;
        const tp1Trend = 2537.50; // +1.50%
        const rF = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "TREND",
            entryPrice: entry,
            canonicalTp1Price: tp1Trend,
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz: 0.01
        });
        assertTrue(rF.entryAllowed === true, "SCENARIO F +1.50% -> ALLOW");
        assertTrue(rF.executableTp1Price === tp1Trend, "SCENARIO F executable TP1 unchanged");
        assertClose(rF.executableTp1DistancePct, 0.0150, 1e-9, "SCENARIO F distance = 1.50%");
    }

    // =========================================================================
    // SCENARIO G: Short Symmetric Threshold
    // =========================================================================
    {
        const entry = 2500;
        const tp1ShortExact = 2500 * (1 - 0.0032); // 2492.00
        const rG = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            entryPrice: entry,
            canonicalTp1Price: tp1ShortExact,
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz: 0.01
        });
        assertTrue(rG.entryAllowed === true, "SCENARIO G short exact threshold -> ALLOW");
        assertClose(rG.executableTp1DistancePct, 0.0032, 1e-9, "SCENARIO G distance = 0.32%");
    }

    // =========================================================================
    // SCENARIO H & I: Fail-Closed on Invalid Fee / Slippage Cost Authority
    // =========================================================================
    {
        // H: invalid fee
        const rH = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: 2500,
            canonicalTp1Price: 2600,
            feeRate: 0 // <= 0 invalid
        });
        assertTrue(rH.entryAllowed === false, "SCENARIO H invalid fee -> BLOCK");
        assertTrue(rH.blockReason === "V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID", "SCENARIO H blockReason");

        // I: invalid slippage
        const rI = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: 2500,
            canonicalTp1Price: 2600,
            feeRate: 0.0006,
            paperSlippageEstimateBps: -5 // negative invalid
        });
        assertTrue(rI.entryAllowed === false, "SCENARIO I invalid slippage -> BLOCK");
        assertTrue(rI.blockReason === "V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID", "SCENARIO I blockReason");
    }

    // =========================================================================
    // SCENARIO J: Full Proof Log & Truthfulness Field Audit
    // =========================================================================
    {
        const rJ = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: 2503.37,
            canonicalTp1Price: 2515.00,
            canonicalTp1Source: "execMeta.takeProfitPlan.tp1",
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz: 0.01
        });

        assertTrue(rJ.event === "V2_TP_PROFITABILITY_AUTHORITY_PROOF", "event field");
        assertTrue(rJ.symbol === "ETHUSDT", "symbol field");
        assertTrue(rJ.side === "long", "side field");
        assertTrue(rJ.regime === "RANGE", "regime field");
        assertTrue(rJ.entryPrice === 2503.37, "entryPrice field");
        assertTrue(rJ.rawCanonicalTp1Price === 2515.00, "rawCanonicalTp1Price field");
        assertTrue(rJ.executableTp1Price === 2515.00, "executableTp1Price field");
        assertTrue(rJ.tpTickSize === 0.01, "tpTickSize field");
        assertTrue(rJ.tpNormalizationApplied === false, "tpNormalizationApplied field");
        assertTrue(rJ.canonicalTp1Source === "execMeta.takeProfitPlan.tp1", "canonicalTp1Source field");
        assertTrue(rJ.estimatedEntryFeePct === 0.0006, "estimatedEntryFeePct field");
        assertTrue(rJ.estimatedExitFeePct === 0.0006, "estimatedExitFeePct field");
        assertTrue(rJ.estimatedRoundTripCostPct === 0.0012, "estimatedRoundTripCostPct field");
        assertTrue(rJ.paperSlippageEstimateBps === 8, "paperSlippageEstimateBps field");
        assertTrue(rJ.slippageCostPct === 0.0008, "slippageCostPct field");
        assertTrue(rJ.slippageAuthoritySource === "config.paperSlippageEstimateBps", "slippageAuthoritySource field");
        assertTrue(rJ.minimumNetProfitPct === MINIMUM_TP1_NET_PROFIT_PCT, "minimumNetProfitPct field");
        assertTrue(rJ.minimumNetProfitSource === "MINIMUM_TP1_NET_PROFIT_PCT", "minimumNetProfitSource field");
        assertClose(rJ.minimumProfitableTpPct, 0.0032, 1e-9, "minimumProfitableTpPct field");
        assertTrue(rJ.entryAllowed === true, "entryAllowed field");
        assertTrue(rJ.blockReason === null, "blockReason field");

        console.info(JSON.stringify(rJ));
    }

    console.info(JSON.stringify({
        event: "V2_TP_PROFITABILITY_AUTHORITY_TESTS_PASS",
        scenarios: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]
    }));
}

runTpProfitabilityAuthorityTests();
