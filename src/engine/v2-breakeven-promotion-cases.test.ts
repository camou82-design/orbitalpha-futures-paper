import assert from "node:assert";
import type { PaperOpenPositionRecord } from "../models/types";
import { updatePositionExcursionTelemetry } from "../engine-v2/execution/reduce-economics";
import { evaluateProbeBreakevenStop, calculateProbeTpPlan } from "../engine-v2/exit/probe-tp-policy";

let passCount = 0;
let failCount = 0;

function report(testName: string, passed: boolean, detail?: Record<string, unknown>) {
    if (passed) {
        passCount++;
        console.log(`[PASS] ${testName}`);
    } else {
        failCount++;
        console.error(`[FAIL] ${testName}`, detail ?? {});
        throw new Error(`Test failed: ${testName}`);
    }
}

/**
 * Simulates V2 breakeven evaluation in paper-engine.ts
 */
function evaluateV2Breakeven(open: PaperOpenPositionRecord): {
    beRequired: boolean;
    bePrice: number;
} {
    const RAW_PRICE_BREAKEVEN_MFE_THRESHOLD = 0.006; // 0.6% raw underlying price excursion
    const rawPriceMfe = typeof open.maxFavorableExcursionPct === "number" && Number.isFinite(open.maxFavorableExcursionPct)
        ? open.maxFavorableExcursionPct
        : 0;
    const beRequired = (open.breakevenStopRequired === true) || (rawPriceMfe >= RAW_PRICE_BREAKEVEN_MFE_THRESHOLD);
    const feeBuffer = 0.0008; // 0.08% buffer for fees and slippage
    const bePrice = open.side === "long"
        ? open.entryPrice * (1 + feeBuffer)
        : open.entryPrice * (1 - feeBuffer);

    return { beRequired, bePrice };
}

/**
 * Simulates active stop selection in ensureProtectiveOrderForOpenPosition
 */
function resolveActiveStop(open: PaperOpenPositionRecord): number {
    let activeStopPrice = open.stopPrice ?? (open as any).ledger_stop_px;
    if (open.breakevenStopRequired === true && open.breakevenStopPrice != null) {
        const isBetter = open.side === "long"
            ? open.breakevenStopPrice > (activeStopPrice ?? -999999)
            : open.breakevenStopPrice < (activeStopPrice ?? 999999);
        if (isBetter) {
            activeStopPrice = open.breakevenStopPrice;
        }
    }
    return activeStopPrice;
}

function runBreakevenRegressionTests() {
    console.log("=== RUNNING V2 BREAKEVEN STOP PROMOTION REGRESSION TESTS ===");

    // Test A: LONG negative excursion -> recovery -> tiny positive => breakevenStopRequired=false
    {
        const open: PaperOpenPositionRecord = {
            symbol: "ETHUSDT",
            side: "long",
            openedAt: Date.now(),
            entryPrice: 2356.54,
            sizeUsd: 100,
            leverage: 10,
            stopPrice: 2331.79633,
            breakevenStopRequired: false
        } as any;

        // 1. Drop into negative excursion
        updatePositionExcursionTelemetry(open, 2335.00); // -0.91% move
        // 2. Recovery to entry
        updatePositionExcursionTelemetry(open, 2356.54);
        // 3. Tiny positive tick (+0.04% move: 2357.50)
        updatePositionExcursionTelemetry(open, 2357.50);

        const result = evaluateV2Breakeven(open);
        report(
            "Test A: LONG negative excursion -> recovery -> tiny positive => breakevenStopRequired=false",
            result.beRequired === false && open.maxFavorableExcursionPct! < 0.006,
            { maxFavorableExcursionPct: open.maxFavorableExcursionPct, beRequired: result.beRequired }
        );
    }

    // Test B: SHORT negative excursion -> recovery -> tiny positive => breakevenStopRequired=false
    {
        const open: PaperOpenPositionRecord = {
            symbol: "ETHUSDT",
            side: "short",
            openedAt: Date.now(),
            entryPrice: 2356.54,
            sizeUsd: 100,
            leverage: 10,
            stopPrice: 2381.28,
            breakevenStopRequired: false
        } as any;

        // 1. Move against short into adverse excursion
        updatePositionExcursionTelemetry(open, 2378.00); // -0.91% adverse move
        // 2. Recovery to entry
        updatePositionExcursionTelemetry(open, 2356.54);
        // 3. Tiny favorable tick for short (+0.04% move: 2355.50)
        updatePositionExcursionTelemetry(open, 2355.50);

        const result = evaluateV2Breakeven(open);
        report(
            "Test B: SHORT negative excursion -> recovery -> tiny positive => breakevenStopRequired=false",
            result.beRequired === false && open.maxFavorableExcursionPct! < 0.006,
            { maxFavorableExcursionPct: open.maxFavorableExcursionPct, beRequired: result.beRequired }
        );
    }

    // Test C: Current PnL threshold만 통과하고 genuine MFE 미달 (예: 레버리지 20배에서 0.25% 움직여 ROE 5%인 경우) => BE promotion false
    {
        const open: PaperOpenPositionRecord = {
            symbol: "ETHUSDT",
            side: "long",
            openedAt: Date.now(),
            entryPrice: 2356.54,
            sizeUsd: 100,
            leverage: 20,
            stopPrice: 2331.79633,
            breakevenStopRequired: false
        } as any;

        // Price moves +0.25% (2362.43) -> Raw MFE is 0.0025 (< 0.006)
        updatePositionExcursionTelemetry(open, 2362.43);

        const result = evaluateV2Breakeven(open);
        report(
            "Test C: Current PnL passes low threshold but genuine MFE < 0.6% => BE promotion false",
            result.beRequired === false,
            { rawPriceMfe: open.maxFavorableExcursionPct, beRequired: result.beRequired }
        );
    }

    // Test D: Genuine favorable MFE threshold 충족 LONG => BE promotion true => BE price = entry * (1 + feeBuffer)
    {
        const open: PaperOpenPositionRecord = {
            symbol: "ETHUSDT",
            side: "long",
            openedAt: Date.now(),
            entryPrice: 2356.54,
            sizeUsd: 100,
            leverage: 10,
            stopPrice: 2331.79633,
            breakevenStopRequired: false
        } as any;

        // Price moves +0.65% (2371.86) -> Raw MFE is 0.0065 (>= 0.006)
        updatePositionExcursionTelemetry(open, 2371.86);

        const result = evaluateV2Breakeven(open);
        const expectedBePrice = 2356.54 * 1.0008; // 2358.425232
        const diff = Math.abs(result.bePrice - expectedBePrice);
        report(
            "Test D: Genuine favorable MFE threshold 충족 LONG => BE promotion true",
            result.beRequired === true && diff < 1e-6,
            { bePrice: result.bePrice, expectedBePrice }
        );
    }

    // Test E: Genuine favorable MFE threshold 충족 SHORT => BE promotion true => BE price = entry * (1 - feeBuffer)
    {
        const open: PaperOpenPositionRecord = {
            symbol: "ETHUSDT",
            side: "short",
            openedAt: Date.now(),
            entryPrice: 2356.54,
            sizeUsd: 100,
            leverage: 10,
            stopPrice: 2381.28,
            breakevenStopRequired: false
        } as any;

        // Price drops -0.65% (2341.22) -> Raw MFE is 0.0065 (>= 0.006)
        updatePositionExcursionTelemetry(open, 2341.22);

        const result = evaluateV2Breakeven(open);
        const expectedBePrice = 2356.54 * (1 - 0.0008); // 2354.654768
        const diff = Math.abs(result.bePrice - expectedBePrice);
        report(
            "Test E: Genuine favorable MFE threshold 충족 SHORT => BE promotion true",
            result.beRequired === true && diff < 1e-6,
            { bePrice: result.bePrice, expectedBePrice }
        );
    }

    // Test F: Existing structural SL remains unchanged before BE qualification
    {
        const initialSl = 2331.79633;
        const open: PaperOpenPositionRecord = {
            symbol: "ETHUSDT",
            side: "long",
            openedAt: Date.now(),
            entryPrice: 2356.54,
            sizeUsd: 100,
            leverage: 10,
            stopPrice: initialSl,
            breakevenStopRequired: false,
            breakevenStopPrice: undefined
        } as any;

        // Minor recovery after adverse move
        updatePositionExcursionTelemetry(open, 2340.00);
        updatePositionExcursionTelemetry(open, 2357.00); // MFE 0.00019 < 0.006

        const { beRequired, bePrice } = evaluateV2Breakeven(open);
        open.breakevenStopRequired = beRequired;
        open.breakevenStopPrice = bePrice;

        const activeStop = resolveActiveStop(open);
        report(
            "Test F: Existing structural SL remains unchanged before BE qualification",
            activeStop === initialSl,
            { activeStop, initialSl }
        );
    }

    // Test G: Once BE promotion is legitimately active, active stop remains monotonic / never loosens
    {
        const initialSl = 2331.79633;
        const open: PaperOpenPositionRecord = {
            symbol: "ETHUSDT",
            side: "long",
            openedAt: Date.now(),
            entryPrice: 2356.54,
            sizeUsd: 100,
            leverage: 10,
            stopPrice: initialSl,
            breakevenStopRequired: false
        } as any;

        // 1. Legitimate excursion (MFE >= 0.6%)
        updatePositionExcursionTelemetry(open, 2372.00);
        const { beRequired, bePrice } = evaluateV2Breakeven(open);
        open.breakevenStopRequired = beRequired;
        open.breakevenStopPrice = bePrice;

        const promotedStop = resolveActiveStop(open);
        const expectedPromotedStop = 2356.54 * 1.0008;

        // 2. Price retraces back towards entry (2359.00)
        updatePositionExcursionTelemetry(open, 2359.00);
        const retraceEval = evaluateV2Breakeven(open);
        open.breakevenStopRequired = retraceEval.beRequired;
        const retraceActiveStop = resolveActiveStop(open);

        report(
            "Test G: Once BE promotion is legitimately active, active stop remains monotonic",
            promotedStop === expectedPromotedStop &&
            retraceEval.beRequired === true &&
            retraceActiveStop === expectedPromotedStop,
            { promotedStop, retraceActiveStop, expectedPromotedStop }
        );
    }

    // Test H: Existing probe TP1 breakeven behavior unchanged
    {
        const plan = calculateProbeTpPlan(
            "ETHUSDT",
            "long",
            "EARLY_REVERSAL_LONG_PROBE",
            2356.54,
            2331.79633
        );
        assert(plan != null, "Probe plan should exist");

        // Before TP1 fill: should NOT move breakeven stop
        const beBeforeFill = evaluateProbeBreakevenStop(
            "ETHUSDT",
            "long",
            plan,
            2331.79633,
            false, // tp1Filled = false
            1.0
        );
        assert(beBeforeFill == null, "Breakeven should not move before TP1 fill");

        // After TP1 fill: should move breakeven stop
        const beAfterFill = evaluateProbeBreakevenStop(
            "ETHUSDT",
            "long",
            plan,
            2331.79633,
            true, // tp1Filled = true
            0.5
        );
        assert(beAfterFill != null && beAfterFill.shouldMove === true, "Breakeven must move after TP1 fill");

        report(
            "Test H: Existing probe TP1 breakeven behavior unchanged",
            beBeforeFill == null && beAfterFill?.shouldMove === true,
            { beBeforeFill, beAfterFill }
        );
    }

    console.log(`=== ALL ${passCount} BREAKEVEN REGRESSION TESTS PASSED ===`);
}

runBreakevenRegressionTests();
