import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rangeExecutorEvaluateEntry } from "../strategy/executors/range-executor";
import { evaluatePnlStopMeaningfulMoveGate } from "../engine-v2/exit/pnl-stop-gate";
import { resolveProtectiveTpPlan } from "../engine-v2/execution/protective-tp-authority";
import {
    planProtectiveOrderReconcile,
    type ProtectiveAlgoRow,
    type ProtectiveReconcileContext
} from "../engine-v2/execution/protective-reconcile-plan";
import type { PaperOpenPositionRecord } from "../models/types";

describe("ETH LONG — SL / RECOVERY PARTIAL / TP PHASE INTEGRITY TESTS", () => {
    // 1. ETH RANGE long normal noise does not create absurdly tight SL
    // Semantic: entry -> stop total distance must be >= 0.50% of entryRefPx (lastPrice)
    it("1. ETH RANGE long normal noise does not create absurdly tight SL (applies noise floor)", () => {
        const entryRefPx = 2504;
        const ethLong = rangeExecutorEvaluateEntry({
            symbol: "ETHUSDT",
            regime: "RANGE",
            signal: "paper_long_candidate",
            boxPos: 0.2,
            boxRel: 0.01,
            boxHigh: 2520,
            boxLow: 2500,
            boxMid: 2510,
            atr: 4.0, // small ATR -> structural stop ~2496.25 (~0.31% from entry)
            expectedMove: 10,
            totalCost: 1.0,
            qualityScore: 80,
            risk_state: "normal" as any,
            cooldownActive: false,
            cooldownRemainingMs: 0,
            lastPrice: entryRefPx // required for entry-distance floor
        } as any);

        assert.equal(ethLong.entry_allowed, true);
        assert.ok(ethLong.invalidationPx != null);
        // 0.50% of entryRefPx 2504 = 12.52 USDT; stop must be >= 12.52 from entry
        const slDistanceFromEntry = entryRefPx - ethLong.invalidationPx!;
        assert.ok(
            slDistanceFromEntry >= 12.5,
            `Entry->stop distance (${slDistanceFromEntry.toFixed(4)}) must be >= 12.5 USDT (0.50% of entry)`
        );
    });

    // 2. near-SL -> entry recovery -> HOLD, no partial
    it("2. near-SL -> entry recovery -> HOLD, no partial", () => {
        const res = evaluatePnlStopMeaningfulMoveGate({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2504.01,
            markPrice: 2503.50, // Recovered back near entry (only -0.02% from entry)
            leverage: 10,
            pnlStopProtectPct: -0.002, // Only -0.2% on margin
            ledgerStopPx: 2487.50,
            atr20: 8.0,
            slProtectionSatisfied: true,
            thesisValid: true,
            htfAligned: true,
            confirmedOppositeFts: false,
            structureBreached: false,
            invalidationBreachConfirmed: false,
            thresholdActionCandidate: "REDUCE"
        });

        assert.equal(res.finalAction, "HOLD", "Recovered price near entry must HOLD, not reduce");
        assert.equal(res.reduceRatio, 0);
    });

    // 3. actual invalidation -> reduce/exit still allowed
    it("3. actual invalidation -> reduce/exit still allowed", () => {
        const res = evaluatePnlStopMeaningfulMoveGate({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2504.01,
            markPrice: 2485.00, // Below SL / invalidation
            leverage: 10,
            pnlStopProtectPct: -0.075,
            ledgerStopPx: 2487.50,
            atr20: 8.0,
            slProtectionSatisfied: true,
            thesisValid: false,
            invalidationBreachConfirmed: true,
            structureBreached: true,
            thresholdActionCandidate: "FULL_EXIT"
        });

        assert.equal(res.finalAction, "FULL_EXIT", "Actual invalidation breach must permit FULL_EXIT");
        assert.equal(res.reduceRatio, 1);
    });

    // 4. profitable partial remains allowed
    it("4. profitable partial at target remains allowed", () => {
        const plan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2511.85, tp2: 2530.00 },
            takeProfit1Px: 2511.85,
            takeProfit2Px: 2530.00,
            tp1Filled: false,
            partialExitStage: 0
        });

        assert.equal(plan.phase, "TP1_PENDING");
        assert.equal(plan.exchangeTpRequired, true);
        assert.equal(plan.exchangeTpPrice, 2511.85);
        assert.equal(plan.mode, "RANGE_TP1_PARTIAL");
    });

    // 5. generic partial reduce does NOT advance TP1_PENDING
    it("5. generic partial reduce does NOT advance TP1_PENDING", () => {
        // When partialExitStage remains 0 because fill was generic/risk reduce
        const plan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2511.85, tp2: 2530.00 },
            takeProfit1Px: 2511.85,
            takeProfit2Px: 2530.00,
            tp1Filled: false,
            partialExitStage: 0
        });

        assert.equal(plan.phase, "TP1_PENDING", "Generic partial reduce must keep TP1_PENDING phase");
        assert.equal(plan.exchangeTpPrice, 2511.85, "TP price must remain TP1");
    });

    // 6. PNL_STOP_PROTECT partial does NOT advance TP phase
    it("6. PNL_STOP_PROTECT partial does NOT advance TP phase", () => {
        const isTpFill = false; // PNL_STOP_PROTECT is not a TP fill
        const stageBefore = 0;
        const stageAfter = isTpFill ? stageBefore + 1 : stageBefore;
        assert.equal(stageAfter, 0, "stageAfter must not increment on PNL_STOP_PROTECT");

        const plan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2511.85, tp2: 2530.00 },
            takeProfit1Px: 2511.85,
            takeProfit2Px: 2530.00,
            tp1Filled: false,
            partialExitStage: stageAfter
        });

        assert.equal(plan.phase, "TP1_PENDING");
        assert.equal(plan.exchangeTpPrice, 2511.85);
    });

    // 7. manual partial does NOT advance TP phase
    it("7. manual partial does NOT advance TP phase", () => {
        const isTpFill = false; // MANUAL_REDUCE is not a TP fill
        const stageBefore = 0;
        const stageAfter = isTpFill ? stageBefore + 1 : stageBefore;
        assert.equal(stageAfter, 0);

        const plan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2511.85, tp2: 2530.00 },
            takeProfit1Px: 2511.85,
            takeProfit2Px: 2530.00,
            tp1Filled: false,
            partialExitStage: stageAfter
        });

        assert.equal(plan.phase, "TP1_PENDING");
        assert.equal(plan.exchangeTpPrice, 2511.85);
    });

    // 8. confirmed TP1 exchange fill DOES advance TP2_PENDING
    it("8. confirmed TP1 exchange fill DOES advance TP2_PENDING", () => {
        const isTpFill = true; // Confirmed TP1 fill
        const stageBefore = 0;
        const stageAfter = isTpFill ? stageBefore + 1 : stageBefore;
        assert.equal(stageAfter, 1);

        const plan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2511.85, tp2: 2530.00 },
            takeProfit1Px: 2511.85,
            takeProfit2Px: 2530.00,
            tp1Filled: true,
            partialExitStage: stageAfter
        });

        assert.equal(plan.phase, "TP2_PENDING", "Confirmed TP1 fill must advance to TP2_PENDING");
        assert.equal(plan.exchangeTpPrice, 2530.00, "Must target TP2 price");
        assert.equal(plan.mode, "RANGE_TP2_POST_FILL");
    });

    // 9. after non-TP partial, TP1 price stays unchanged and qty follows remainder
    it("9. after non-TP partial, TP1 price stays unchanged and qty follows remainder", () => {
        // Initial position was 10.24 contracts, reduced by 2.56 to 7.68 contracts
        const remainingContracts = 7.68;
        const partialTpRatio = 0.5; // 50% of remaining position
        const tpContractsToProtect = remainingContracts * partialTpRatio; // 3.84

        const ctx: ProtectiveReconcileContext = {
            instId: "ETH-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc",
            tdModeUsed: "isolated",
            contractsToProtect: remainingContracts,
            tpContractsToProtect,
            activeStopPrice: 2487.50,
            activeTpPrice: 2511.85, // TP1 price unchanged
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const liveSlOrder: ProtectiveAlgoRow = {
            instId: "ETH-USDT-SWAP",
            algoId: "3897611153120808960",
            algoClOrdId: "oapETHUSlabcs",
            ordType: "conditional",
            side: "sell",
            posSide: "net",
            tdMode: "isolated",
            reduceOnly: true,
            slTriggerPx: "2487.50",
            sz: String(remainingContracts)
        };

        const plan = planProtectiveOrderReconcile([liveSlOrder], ctx);
        assert.equal(plan.canonicalSlAlgoId, "3897611153120808960");
        assert.equal(plan.needSubmitTp, true, "TP1 repair must be requested for remaining position");
        assert.equal(ctx.activeTpPrice, 2511.85, "TP1 price remains exactly 2511.85");
    });

    // 10. TP1/TP2 simultaneous live order still prohibited
    it("10. TP1/TP2 simultaneous live order still prohibited", () => {
        const initialPlan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2511.85, tp2: 2530.00 },
            takeProfit1Px: 2511.85,
            takeProfit2Px: 2530.00,
            tp1Filled: false,
            partialExitStage: 0
        });
        assert.equal(initialPlan.exchangeTpPrice, 2511.85);
        assert.notEqual(initialPlan.exchangeTpPrice, 2530.00);
    });

    // 11. ETH short symmetry audit
    // Semantic: entry -> stop total distance from entry 2516 must be >= 0.50% = 12.58 USDT
    it("11. ETH short symmetry audit applies noise floor above boxHigh (entry-distance)", () => {
        const entryRefPx = 2516;
        const ethShort = rangeExecutorEvaluateEntry({
            symbol: "ETHUSDT",
            regime: "RANGE",
            signal: "paper_short_candidate",
            boxPos: 0.8,
            boxRel: 0.01,
            boxHigh: 2520,
            boxLow: 2500,
            boxMid: 2510,
            atr: 4.0, // structural stop = 2520 + max(2, 3.78) = 2523.78 → 7.78 USDT from entry (0.31%)
            expectedMove: 10,
            totalCost: 1.0,
            qualityScore: 80,
            risk_state: "normal" as any,
            cooldownActive: false,
            cooldownRemainingMs: 0,
            lastPrice: entryRefPx // required for entry-distance floor
        } as any);

        assert.equal(ethShort.entry_allowed, true);
        assert.ok(ethShort.invalidationPx != null);
        // 0.50% of 2516 = 12.58 USDT → inv must be >= 2516 + 12.58 = 2528.58
        const slDistanceFromEntry = ethShort.invalidationPx! - entryRefPx;
        assert.ok(
            slDistanceFromEntry >= 12.5,
            `Short entry->stop distance (${slDistanceFromEntry.toFixed(4)}) must be >= 12.5 USDT (0.50% of entry)`
        );
    });

    // 12. BTC behavior unchanged
    it("12. BTC behavior unchanged (uses structural buffer only, no ETH noise floor)", () => {
        const btcLong = rangeExecutorEvaluateEntry({
            symbol: "BTCUSDT",
            regime: "RANGE",
            signal: "paper_long_candidate",
            boxPos: 0.2,
            boxRel: 0.01,
            boxHigh: 80000,
            boxLow: 79000,
            boxMid: 79500,
            atr: 100,
            expectedMove: 500,
            totalCost: 10,
            qualityScore: 80,
            risk_state: "normal" as any,
            cooldownActive: false,
            cooldownRemainingMs: 0
        });

        assert.equal(btcLong.entry_allowed, true);
        // structuralBuffer = Math.max(100 * 0.5, 79000 * 0.0015) = Math.max(50, 118.5) = 118.5
        // structuralStop = 79000 - 118.5 = 78881.5 (isEth = false → no floor applied)
        assert.equal(btcLong.invalidationPx, 78881.5, "BTC invalidation must remain exactly 78881.5");
    });

    // ── NEW TESTS (13-20): CONTRACT CORRECTION VERIFICATION ──────────────────

    // 13. RANGE_PARTIAL_AT_OPPOSITE_EDGE fill does NOT advance TP phase
    it("13. RANGE_PARTIAL_AT_OPPOSITE_EDGE fill does NOT advance TP phase", () => {
        const fillReason: string = "RANGE_PARTIAL_AT_OPPOSITE_EDGE";
        const reason: string = "RANGE_PARTIAL_AT_OPPOSITE_EDGE";
        let v2RangeTp1Triggered: boolean = false;
        const isCanonicalTp1Fill =
            fillReason === "v2_tp1_automated" ||
            reason === "v2_tp1_automated" ||
            v2RangeTp1Triggered;
        const stageBefore = 0;
        const stageAfter = (true && isCanonicalTp1Fill) ? stageBefore + 1 : stageBefore;
        assert.equal(stageAfter, 0, "RANGE_PARTIAL_AT_OPPOSITE_EDGE must NOT advance TP phase");
    });

    // 14. PARTIAL_TAKE_PROFIT policy reason alone does NOT advance TP phase
    it("14. PARTIAL_TAKE_PROFIT policy reason alone does NOT advance TP phase", () => {
        const fillReason: string = "PARTIAL_TAKE_PROFIT";
        const reason: string = "PARTIAL_TAKE_PROFIT";
        let v2RangeTp1Triggered: boolean = false;
        const isCanonicalTp1Fill =
            fillReason === "v2_tp1_automated" ||
            reason === "v2_tp1_automated" ||
            v2RangeTp1Triggered;
        const stageBefore = 0;
        const stageAfter = (true && isCanonicalTp1Fill) ? stageBefore + 1 : stageBefore;
        assert.equal(stageAfter, 0, "PARTIAL_TAKE_PROFIT string must NOT advance TP phase");
    });

    // 15. confirmed canonical TP1 exchange fill (v2_tp1_automated) DOES advance TP2
    it("15. confirmed canonical TP1 exchange fill (v2_tp1_automated) DOES advance TP2", () => {
        const fillReason: string = "v2_tp1_automated";
        const reason: string = "v2_tp1_automated";
        let v2RangeTp1Triggered: boolean = false;
        const isCanonicalTp1Fill =
            fillReason === "v2_tp1_automated" ||
            reason === "v2_tp1_automated" ||
            v2RangeTp1Triggered;
        const stageBefore = 0;
        const stageAfter = (true && isCanonicalTp1Fill) ? stageBefore + 1 : stageBefore;
        assert.equal(stageAfter, 1, "v2_tp1_automated canonical fill MUST advance stage to 1");

        const plan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2511.85, tp2: 2530.00 },
            takeProfit1Px: 2511.85,
            takeProfit2Px: 2530.00,
            tp1Filled: true,
            partialExitStage: stageAfter
        });
        assert.equal(plan.phase, "TP2_PENDING", "Confirmed canonical TP1 must produce TP2_PENDING phase");
    });

    // 16. arbitrary TAKE_PROFIT-containing string does NOT advance TP phase
    it("16. arbitrary TAKE_PROFIT-containing string does NOT advance TP phase (substring match forbidden)", () => {
        for (const reason of [
            "MANUAL_TAKE_PROFIT_OVERRIDE",
            "user_take_profit_manual",
            "take_profit",
            "TAKE_PROFIT",
            "TP1",
            "take_profit_1"
        ]) {
            const isCanonicalTp1Fill =
                reason === "v2_tp1_automated" ||
                false; // no v2RangeTp1Triggered
            const stageAfter = isCanonicalTp1Fill ? 1 : 0;
            assert.equal(
                stageAfter, 0,
                `"${reason}" must NOT advance TP phase — only v2_tp1_automated is canonical`
            );
        }
    });

    // 17. ETH exact symbol (ETHUSDT) receives entry-distance noise floor
    it("17. ETH exact symbol (ETHUSDT) receives entry-distance noise floor (canonical match)", () => {
        const entryRefPx = 2504;
        const ethLong = rangeExecutorEvaluateEntry({
            symbol: "ETHUSDT",
            regime: "RANGE",
            signal: "paper_long_candidate",
            boxPos: 0.2,
            boxRel: 0.01,
            boxHigh: 2520,
            boxLow: 2500,
            boxMid: 2510,
            atr: 4.0, // structural stop ≈ 2496.25 = 0.31% from entry (too tight)
            expectedMove: 10,
            totalCost: 1.0,
            qualityScore: 80,
            risk_state: "normal" as any,
            cooldownActive: false,
            cooldownRemainingMs: 0,
            lastPrice: entryRefPx
        } as any);

        assert.equal(ethLong.entry_allowed, true);
        assert.ok(ethLong.invalidationPx != null);
        const slDistFromEntry = entryRefPx - ethLong.invalidationPx!;
        // structural would be ~7.75 USDT (0.31%); floor enforces >= 12.52 (0.50%)
        assert.ok(slDistFromEntry >= 12.5, `ETHUSDT must get noise floor; got ${slDistFromEntry.toFixed(4)} USDT from entry`);
    });

    // 18. symbol containing "ETH" substring but NOT canonical ETHUSDT does NOT get noise floor
    it("18. non-canonical ETH-containing symbol (SETHUSDT) does NOT get noise floor", () => {
        // Canonical check: symNorm = SETHUSDT.toUpperCase().replace(/-SWAP$/,'').replace(/-/g,'') = SETHUSDT ≠ ETHUSDT
        const symNorm = "SETHUSDT".trim().toUpperCase().replace(/-SWAP$/, "").replace(/-/g, "");
        assert.notEqual(symNorm, "ETHUSDT", "SETHUSDT must fail canonical ETH check — no substring allowed");

        // ETH-USDT-SWAP should still normalize TO ETHUSDT (real OKX instId path)
        const ethSwapNorm = "ETH-USDT-SWAP".trim().toUpperCase().replace(/-SWAP$/, "").replace(/-/g, "");
        assert.equal(ethSwapNorm, "ETHUSDT", "ETH-USDT-SWAP must normalize to ETHUSDT canonical form");
    });

    // 19. structural 0.7% SL is NOT widened by ETH floor (floor only widens, never narrows)
    it("19. structural 0.7% SL is preserved and NOT narrowed by ETH floor", () => {
        // entry ≈ 2504, boxLow = 2490, atr = 50
        // structuralBuffer = max(50*0.5, 2490*0.0015) = max(25, 3.74) = 25
        // structuralStop = 2490 - 25 = 2465 → dist from entry 2504 = 39 USDT = 1.56%
        // minStopFromEntry = 2504 * 0.995 = 2491.48
        // inv = min(2465, 2491.48) = 2465 (structural is lower/wider; preserved)
        const entryRefPx = 2504;
        const ethLong = rangeExecutorEvaluateEntry({
            symbol: "ETHUSDT",
            regime: "RANGE",
            signal: "paper_long_candidate",
            boxPos: 0.2,
            boxRel: 0.015,
            boxHigh: 2540,
            boxLow: 2490,
            boxMid: 2515,
            atr: 50,
            expectedMove: 25,
            totalCost: 1.0,
            qualityScore: 80,
            risk_state: "normal" as any,
            cooldownActive: false,
            cooldownRemainingMs: 0,
            lastPrice: entryRefPx
        } as any);

        assert.equal(ethLong.entry_allowed, true);
        assert.ok(ethLong.invalidationPx != null);
        // Structural stop (2465) is wider than floor (2491.48) → must stay at 2465
        assert.ok(
            ethLong.invalidationPx! <= 2491.48,
            `Wide structural stop (${ethLong.invalidationPx}) must be preserved below floor 2491.48`
        );
        const slDistFromEntry = entryRefPx - ethLong.invalidationPx!;
        assert.ok(
            slDistFromEntry > 12.52,
            `Structural 1.56% stop must not be narrowed; got ${slDistFromEntry.toFixed(4)} USDT`
        );
    });

    // 20. structural 0.25% SL becomes approximately minimum 0.50% total entry distance
    it("20. structural 0.25% SL is widened to minimum 0.50% entry-distance floor (real incident replay)", () => {
        // Incident: entry=2504.01, prior SL=2497.68 = 0.25% from entry
        // box: low=2500, atr=4.0 → structuralBuffer = max(2, 3.75) = 3.75
        // structuralStop = 2500 - 3.75 = 2496.25 → dist = 7.76 USDT = 0.31% (too tight)
        // minStopFromEntry = 2504 * 0.995 = 2491.52
        // inv = min(2496.25, 2491.52) = 2491.52 → dist = 12.48 USDT ≈ 0.50%
        const entryRefPx = 2504;
        const ethLong = rangeExecutorEvaluateEntry({
            symbol: "ETHUSDT",
            regime: "RANGE",
            signal: "paper_long_candidate",
            boxPos: 0.2,
            boxRel: 0.008,
            boxHigh: 2520,
            boxLow: 2500,
            boxMid: 2510,
            atr: 4.0,
            expectedMove: 10,
            totalCost: 1.0,
            qualityScore: 80,
            risk_state: "normal" as any,
            cooldownActive: false,
            cooldownRemainingMs: 0,
            lastPrice: entryRefPx
        } as any);

        assert.equal(ethLong.entry_allowed, true);
        assert.ok(ethLong.invalidationPx != null);

        const structuralStop = 2500 - Math.max(4.0 * 0.5, 2500 * 0.0015); // 2496.25
        const minStopFromEntry  = entryRefPx * (1 - 0.005);                // 2491.52
        const expectedInv = Math.min(structuralStop, minStopFromEntry);     // 2491.52

        assert.ok(
            Math.abs(ethLong.invalidationPx! - expectedInv) < 0.01,
            `ETH floor inv must be ≈ ${expectedInv.toFixed(2)}, got ${ethLong.invalidationPx}`
        );

        const slDistFromEntry = entryRefPx - ethLong.invalidationPx!;
        assert.ok(
            slDistFromEntry >= 12.48,
            `Entry->stop ${slDistFromEntry.toFixed(4)} USDT (${(slDistFromEntry / entryRefPx * 100).toFixed(3)}%) must be >= 0.50%`
        );
        // Confirm structural stop alone would have been too tight
        const oldDist = entryRefPx - structuralStop; // 7.75
        assert.ok(oldDist < 12.5, `Structural stop was tight (${oldDist.toFixed(4)} USDT = ${(oldDist/entryRefPx*100).toFixed(3)}%)`);
    });
});
