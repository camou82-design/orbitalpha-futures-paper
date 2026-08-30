import assert from "node:assert";
import { executeRangeRegime } from "../engine-v2/executors/range-executor";
import { evaluateTpProfitabilityAuthority } from "../engine-v2/execution/tp-profitability-authority";
import { normalizePxToTickSz } from "../engine-v2/execution/entry-order-type";
import type { EngineV2Input, MarketJudgmentOutput } from "../engine-v2/types";

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

function makeMockEngineInput(params: {
    symbol: string;
    lastPrice: number;
    boxLow: number;
    boxHigh: number;
    boxPos: number;
    atr: number;
    feeRate: number;
    tickSz: number;
}): EngineV2Input {
    const candles = [
        { ts: 1000, open: params.lastPrice, high: params.lastPrice + 1, low: params.lastPrice - 1, close: params.lastPrice, volume: 100 },
        { ts: 2000, open: params.lastPrice, high: params.lastPrice + 1, low: params.lastPrice - 1, close: params.lastPrice, volume: 100 },
        { ts: 3000, open: params.lastPrice, high: params.lastPrice + 1, low: params.lastPrice - 1, close: params.lastPrice, volume: 100 },
        { ts: 4000, open: params.lastPrice, high: params.lastPrice + 1, low: params.lastPrice - 1, close: params.lastPrice, volume: 100 },
        { ts: 5000, open: params.lastPrice, high: params.lastPrice + 1, low: params.lastPrice - 1, close: params.lastPrice, volume: 100 }
    ];

    return {
        symbol: params.symbol,
        evaluationMode: "diagnostic",
        run_cycle_id: "test-cycle-1",
        state: {
            currentPositions: [],
            directionalShockState: "NONE",
            lastOrderTimestamp: 0,
            longAllow: true,
            shortAllow: true
        } as any,
        snapshot: {
            symbol: params.symbol,
            lastPrice: params.lastPrice,
            boxLow: params.boxLow,
            boxHigh: params.boxHigh,
            boxPos: params.boxPos,
            atr: params.atr,
            qualityScore: 85,
            boxBreakSide: "none",
            rangeConfidence: 0.85,
            boxCohesion01: 0.8,
            trendWeaknessScore: 0.8,
            breakoutFailureRate: 0.8,
            rangeOscillationScore: 0.8,
            candles,
            tickSz: params.tickSz
        } as any,
        config: {
            paperTakerFeeRate: params.feeRate,
            paperSlippageEstimateBps: 8
        } as any
    } as unknown as EngineV2Input;
}

function makeMockJudgment(subtype: any, shockPhase: any = "NONE", trendPhase: any = "NEUTRAL"): MarketJudgmentOutput {
    return {
        regime: "RANGE",
        subtype,
        shockPhase,
        trendPhase,
        subtypeReason: "test_reason",
        metadata: {
            reversal_confirmed: true
        } as any,
        metrics: {} as any,
        diagnostics: {} as any
    } as unknown as MarketJudgmentOutput;
}

function runRangeTpProfitabilityE2ETests() {
    console.info("=== RUNNING V2 RANGE TP PROFITABILITY E2E TEST SUITE ===");

    // =========================================================================
    // SCENARIO 1: Historical ETH 2503.37 Narrow Range (Natural boxMid = 2509.805)
    // Box: low=2501.05, mid=2509.805, high=2518.56, entry=2503.37, tickSz=0.01
    // Full Provenance Chain Verification:
    // rawNaturalTp1: 2509.805
    // execMeta.takeProfitPlan.tp1: 2509.805
    // execMeta.takeProfit1Px: 2509.805
    // profitability rawCanonicalTp1Price: 2509.805
    // profitability executableTp1Price: normalizePxToTickSz(2509.805, 0.01) = 2509.81
    // preEntryProtectionTp: 2509.81
    // okxActualTpTriggerPx: 2509.81
    // Distance: |2509.81 - 2503.37| / 2503.37 = 0.25725...% < 0.3200% floor -> BLOCK
    // =========================================================================
    {
        const entryPx = 2503.37;
        const boxLow = 2501.05;
        const boxHigh = 2518.56;
        const boxMid = (boxLow + boxHigh) / 2; // 2509.805
        const tickSz = 0.01;

        const mockInput = makeMockEngineInput({
            symbol: "ETHUSDT",
            lastPrice: entryPx,
            boxLow,
            boxHigh,
            boxPos: 0.13,
            atr: 12.0,
            feeRate: 0.0006,
            tickSz
        });
        const mockJudgment = makeMockJudgment("RANGE_LOWER_REACTION");

        const rangeResult = executeRangeRegime(mockInput, mockJudgment);

        const rawNaturalTp1 = (rangeResult.metadata as any)?.takeProfitPlan?.tp1;
        const rawNaturalTp2 = (rangeResult.metadata as any)?.takeProfitPlan?.tp2;
        const execMetaTp1 = (rangeResult.metadata as any)?.takeProfit1Px;
        assertClose(rawNaturalTp1, boxMid, 1e-4, "SCENARIO 1 rawNaturalTp1 === boxMid = 2509.805");
        assertClose(execMetaTp1, boxMid, 1e-4, "SCENARIO 1 execMeta.takeProfit1Px === 2509.805");
        assertClose(rawNaturalTp2, boxHigh, 1e-4, "SCENARIO 1 rawNaturalTp2 === boxHigh = 2518.56");

        const profResult = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: entryPx,
            canonicalTp1Price: rawNaturalTp1,
            canonicalTp1Source: "execMeta.takeProfitPlan.tp1",
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz
        });

        const expectedExecutableTp1 = normalizePxToTickSz(rawNaturalTp1, tickSz); // 2509.81
        assertClose(profResult.executableTp1Price ?? 0, 2509.81, 1e-4, "SCENARIO 1 executableTp1 === 2509.81");
        assertClose(profResult.executableTp1Price ?? 0, expectedExecutableTp1, 1e-9, "SCENARIO 1 executableTp1 matches downstream normalizePxToTickSz");

        assertTrue(profResult.entryAllowed === false, "SCENARIO 1 Narrow Range MUST BE BLOCKED");
        assertTrue(profResult.blockReason === "V2_TP1_NET_EDGE_INSUFFICIENT", "SCENARIO 1 blockReason");

        console.info(JSON.stringify({
            event: "E2E_SCENARIO_1_ETH_NARROW_RANGE_PROVENANCE_PROOF",
            symbol: "ETHUSDT",
            entryPrice: entryPx,
            boxMid,
            rawNaturalTp1,
            execMetaTp1,
            rawCanonicalTp1Price: profResult.rawCanonicalTp1Price,
            executableTp1Price: profResult.executableTp1Price,
            expectedDownstreamTp: expectedExecutableTp1,
            executableDistancePct: profResult.executableTp1DistancePct,
            floorPct: profResult.minimumProfitableTpPct,
            entryAllowed: profResult.entryAllowed,
            blockReason: profResult.blockReason
        }));
    }

    // =========================================================================
    // SCENARIO 2: ETH Wide Range Long (Natural boxMid = 2512.50, +0.40% >= 0.32% floor)
    // Box: low=2500, mid=2512.50, high=2525, entry=2502.50, tickSz=0.01
    // =========================================================================
    {
        const entryPx = 2502.50;
        const boxLow = 2500.00;
        const boxHigh = 2525.00;
        const boxMid = (boxLow + boxHigh) / 2; // 2512.50
        const tickSz = 0.01;

        const mockInput = makeMockEngineInput({
            symbol: "ETHUSDT",
            lastPrice: entryPx,
            boxLow,
            boxHigh,
            boxPos: 0.10,
            atr: 10.0,
            feeRate: 0.0006,
            tickSz
        });
        const mockJudgment = makeMockJudgment("RANGE_LOWER_REACTION");

        const rangeResult = executeRangeRegime(mockInput, mockJudgment);

        const naturalTp1 = (rangeResult.metadata as any)?.takeProfitPlan?.tp1;
        assertClose(naturalTp1, 2512.50, 1e-4, "SCENARIO 2 natural TP1 preserved at 2512.50");

        const profResult = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: entryPx,
            canonicalTp1Price: naturalTp1,
            canonicalTp1Source: "execMeta.takeProfitPlan.tp1",
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz
        });

        assertTrue(profResult.entryAllowed === true, "SCENARIO 2 ETH Wide Range MUST BE ALLOWED");
        assertTrue(profResult.blockReason === null, "SCENARIO 2 blockReason is null");
        assertClose(profResult.executableTp1Price ?? 0, 2512.50, 1e-6, "SCENARIO 2 executable TP1 === 2512.50");

        console.info(JSON.stringify({
            event: "E2E_SCENARIO_2_ETH_WIDE_RANGE_PROVENANCE_PROOF",
            symbol: "ETHUSDT",
            entryPrice: entryPx,
            rawNaturalTp1: naturalTp1,
            executableTp1Price: profResult.executableTp1Price,
            executableDistancePct: profResult.executableTp1DistancePct,
            floorPct: profResult.minimumProfitableTpPct,
            entryAllowed: profResult.entryAllowed,
            blockReason: profResult.blockReason
        }));
    }

    // =========================================================================
    // SCENARIO 3: BTCUSDT Narrow Range (tickSz = 0.1, Natural Distance 0.100% < 0.32% floor)
    // Box: low=67900, mid=68050, high=68200, entry=68000, tickSz=0.1
    // minProfitDistance = max(100*0.35, 68000*0.001) = 68.0 -> tp1 = 68068.0 (0.10%)
    // Expected: BLOCK (V2_TP1_NET_EDGE_INSUFFICIENT)
    // =========================================================================
    {
        const entryPx = 68000.0;
        const boxLow = 67900.0;
        const boxHigh = 68200.0;
        const boxMid = (boxLow + boxHigh) / 2; // 68050.0
        const tickSz = 0.1;

        const mockInput = makeMockEngineInput({
            symbol: "BTCUSDT",
            lastPrice: entryPx,
            boxLow,
            boxHigh,
            boxPos: 0.33,
            atr: 100.0,
            feeRate: 0.0006,
            tickSz
        });
        const mockJudgment = makeMockJudgment("RANGE_LOWER_REACTION");

        const rangeResult = executeRangeRegime(mockInput, mockJudgment);
        const naturalTp1 = (rangeResult.metadata as any)?.takeProfitPlan?.tp1;
        assertClose(naturalTp1, 68068.0, 1e-2, "SCENARIO 3 BTC natural TP1 = 68068.0");

        const profResult = evaluateTpProfitabilityAuthority({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: entryPx,
            canonicalTp1Price: naturalTp1,
            canonicalTp1Source: "execMeta.takeProfitPlan.tp1",
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz
        });

        assertClose(profResult.executableTp1Price ?? 0, 68068.0, 1e-2, "SCENARIO 3 BTC executable TP1 = 68068.0");
        assertTrue(profResult.entryAllowed === false, "SCENARIO 3 BTC Narrow Range MUST BE BLOCKED");
        assertTrue(profResult.blockReason === "V2_TP1_NET_EDGE_INSUFFICIENT", "SCENARIO 3 blockReason");

        console.info(JSON.stringify({
            event: "E2E_SCENARIO_3_BTC_NARROW_RANGE_PROVENANCE_PROOF",
            symbol: "BTCUSDT",
            entryPrice: entryPx,
            rawNaturalTp1: naturalTp1,
            executableTp1Price: profResult.executableTp1Price,
            executableDistancePct: profResult.executableTp1DistancePct,
            floorPct: profResult.minimumProfitableTpPct,
            entryAllowed: profResult.entryAllowed,
            blockReason: profResult.blockReason
        }));
    }

    // =========================================================================
    // SCENARIO 4: BTCUSDT Wide Range (tickSz = 0.1, Natural Distance 0.7407% >= 0.32% floor)
    // Box: low=67000, mid=68000, high=69000, entry=67500, tickSz=0.1
    // Expected: ALLOW (executableTp1 === 68000.0)
    // =========================================================================
    {
        const entryPx = 67500.0;
        const boxLow = 67000.0;
        const boxHigh = 69000.0;
        const boxMid = (boxLow + boxHigh) / 2; // 68000.0
        const tickSz = 0.1;

        const mockInput = makeMockEngineInput({
            symbol: "BTCUSDT",
            lastPrice: entryPx,
            boxLow,
            boxHigh,
            boxPos: 0.25,
            atr: 150.0,
            feeRate: 0.0006,
            tickSz
        });
        const mockJudgment = makeMockJudgment("RANGE_LOWER_REACTION");

        const rangeResult = executeRangeRegime(mockInput, mockJudgment);
        const naturalTp1 = (rangeResult.metadata as any)?.takeProfitPlan?.tp1;
        assertClose(naturalTp1, boxMid, 1e-2, "SCENARIO 4 BTC wide natural TP1 = 68000.0");

        const profResult = evaluateTpProfitabilityAuthority({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: entryPx,
            canonicalTp1Price: naturalTp1,
            canonicalTp1Source: "execMeta.takeProfitPlan.tp1",
            feeRate: 0.0006,
            paperSlippageEstimateBps: 8,
            tickSz
        });

        assertClose(profResult.executableTp1Price ?? 0, 68000.0, 1e-2, "SCENARIO 4 BTC wide executable TP1 = 68000.0");
        assertTrue(profResult.entryAllowed === true, "SCENARIO 4 BTC Wide Range MUST BE ALLOWED");
        assertTrue(profResult.blockReason === null, "SCENARIO 4 blockReason is null");
        assertClose(profResult.executableTp1DistancePct, (68000 - 67500) / 67500, 1e-6, "SCENARIO 4 distance = 0.7407%");

        console.info(JSON.stringify({
            event: "E2E_SCENARIO_4_BTC_WIDE_RANGE_PROVENANCE_PROOF",
            symbol: "BTCUSDT",
            entryPrice: entryPx,
            rawNaturalTp1: naturalTp1,
            executableTp1Price: profResult.executableTp1Price,
            executableDistancePct: profResult.executableTp1DistancePct,
            floorPct: profResult.minimumProfitableTpPct,
            entryAllowed: profResult.entryAllowed,
            blockReason: profResult.blockReason
        }));
    }

    console.info(JSON.stringify({
        event: "V2_RANGE_TP_PROFITABILITY_E2E_ALL_PASS",
        scenarios: ["SCENARIO_1_ETH_NARROW_BLOCK", "SCENARIO_2_ETH_WIDE_ALLOW", "SCENARIO_3_BTC_NARROW_BLOCK", "SCENARIO_4_BTC_WIDE_ALLOW"]
    }));
}

runRangeTpProfitabilityE2ETests();
