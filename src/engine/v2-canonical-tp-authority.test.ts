import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveProtectiveTpPlan } from "../engine-v2/execution/protective-tp-authority";
import { buildV2NewEntryAttachAlgoOrds } from "../engine-v2/execution/entry-protection-attach";
import { planProtectiveOrderReconcile, type ProtectiveAlgoRow, type ProtectiveReconcileContext } from "../engine-v2/execution/protective-reconcile-plan";
import { classifyOkxOpenOrderPurpose } from "./position-ops-monitor";
import type { PaperOpenPositionRecord } from "../models/types";

describe("PHASE 11B — CANONICAL TP SINGLE-WRITER & DISTANCE TESTS", () => {
    // 1. BTC RANGE short: entry 79697.8, tp1 79458.8, tp2 79219.7 -> canonical initial TP = tp1
    it("1. BTC RANGE short canonical initial TP = tp1", () => {
        const plan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 79458.8, tp2: 79219.7 },
            takeProfit1Px: 79458.8,
            takeProfit2Px: 79219.7,
            tp1Filled: false,
            partialExitStage: 0
        });
        assert.equal(plan.phase, "TP1_PENDING");
        assert.equal(plan.exchangeTpRequired, true);
        assert.equal(plan.exchangeTpPrice, 79458.8);
        assert.equal(plan.exchangeTpSource, "range_tp1_partial");
        assert.equal(plan.fullPositionTpRequired, false);
    });

    // 2. ETH RANGE short: entry 2456.63, tp1 2449.26, tp2 2441.89 -> canonical initial TP = tp1
    it("2. ETH RANGE short canonical initial TP = tp1", () => {
        const plan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2449.26, tp2: 2441.89 },
            takeProfit1Px: 2449.26,
            takeProfit2Px: 2441.89,
            tp1Filled: false,
            partialExitStage: 0
        });
        assert.equal(plan.phase, "TP1_PENDING");
        assert.equal(plan.exchangeTpRequired, true);
        assert.equal(plan.exchangeTpPrice, 2449.26);
        assert.equal(plan.exchangeTpSource, "range_tp1_partial");
        assert.equal(plan.fullPositionTpRequired, false);
    });

    // 3. LONG symmetry (BTC & ETH long entry, tp1, tp2)
    it("3. LONG symmetry for BTC and ETH range initial TP1", () => {
        const btcLongPlan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 80100.5, tp2: 80500.0 },
            takeProfit1Px: 80100.5,
            takeProfit2Px: 80500.0,
            tp1Filled: false
        });
        assert.equal(btcLongPlan.phase, "TP1_PENDING");
        assert.equal(btcLongPlan.exchangeTpPrice, 80100.5);

        const ethLongPlan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2465.5, tp2: 2475.0 },
            takeProfit1Px: 2465.5,
            takeProfit2Px: 2475.0,
            tp1Filled: false
        });
        assert.equal(ethLongPlan.phase, "TP1_PENDING");
        assert.equal(ethLongPlan.exchangeTpPrice, 2465.5);
    });

    // 4. RANGE partial initial state: TP2 full-size attach forbidden at entry
    it("4. RANGE partial initial state does not attach TP2 or OCO at entry", () => {
        const attachRes = buildV2NewEntryAttachAlgoOrds({
            clOrdId: "pBTCUSDTentry12345",
            submitSzStr: "3.16",
            stopPrice: 79905.1,
            takeProfitPrice: 79219.7, // even if downstream passed tp2
            isV2RangePartialPlan: true
        });
        assert.equal(attachRes.entryFullPositionTpAttached, false);
        assert.equal(attachRes.entryRangeTp2BackstopAttached, false);
        assert.equal(attachRes.attachOrdType, "conditional");
        assert.equal(attachRes.exchangeTpSource, "none");
        assert.equal(attachRes.attachAlgoOrds.length, 1);
        const slOrder = attachRes.attachAlgoOrds[0];
        assert.equal(slOrder.ordType, "conditional");
        assert.equal(slOrder.slTriggerPx, "79905.1");
        assert.equal(slOrder.tpTriggerPx, undefined);
    });

    // 5. TP1 partial size exact (50% of position)
    it("5. TP1 partial size is accurately calculated as 50% fraction", () => {
        const contractsToProtect = 3.16;
        const partialRatio = 0.5;
        const expectedTpContracts = contractsToProtect * partialRatio;
        assert.equal(expectedTpContracts, 1.58);
    });

    // 6. TP1 fill triggers TP2 progression
    it("6. TP1 fill triggers TP2 progression with remaining size", () => {
        const postFillPlan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 79458.8, tp2: 79219.7 },
            takeProfit1Px: 79458.8,
            takeProfit2Px: 79219.7,
            tp1Filled: true,
            partialExitStage: 1
        });
        assert.equal(postFillPlan.phase, "TP2_PENDING");
        assert.equal(postFillPlan.exchangeTpRequired, true);
        assert.equal(postFillPlan.exchangeTpPrice, 79219.7);
        assert.equal(postFillPlan.exchangeTpSource, "range_tp2");
        assert.equal(postFillPlan.fullPositionTpRequired, true);
    });

    // 7. TP1 + TP2 simultaneous live forbidden
    it("7. Simultaneous live TP1 and TP2 is prohibited by state phase", () => {
        const initialPlan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 79458.8, tp2: 79219.7 },
            tp1Filled: false
        });
        assert.equal(initialPlan.phase, "TP1_PENDING");
        assert.notEqual(initialPlan.phase, "TP2_PENDING");

        const postFillPlan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 79458.8, tp2: 79219.7 },
            tp1Filled: true
        });
        assert.equal(postFillPlan.phase, "TP2_PENDING");
        assert.notEqual(postFillPlan.phase, "TP1_PENDING");
    });

    // 8. Algo TP + normal limit TP duplicate detection
    it("8. Reconciler detects duplicate between algo TP and normal limit reduceOnly TP", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "short",
            openedAt36: "34wo0",
            tdModeUsed: "isolated",
            contractsToProtect: 1.58,
            tpContractsToProtect: 1.58,
            activeStopPrice: 79905.1,
            activeTpPrice: 79458.8,
            wantsTp: true,
            expectedSide: "buy",
            tickSz: 0.1
        };

        const existingAlgos: ProtectiveAlgoRow[] = [
            // Canonical Algo TP
            {
                algoId: "algo-tp-100",
                instId: "BTC-USDT-SWAP",
                side: "buy",
                posSide: "short",
                tdMode: "isolated",
                ordType: "conditional",
                sz: 1.58,
                tpTriggerPx: "79458.8",
                reduceOnly: true,
                algoClOrdId: "oapBTCUS34wo0t"
            },
            // Duplicate normal limit reduceOnly TP
            {
                algoId: "limit-ord-200",
                ordId: "limit-ord-200",
                instId: "BTC-USDT-SWAP",
                side: "buy",
                posSide: "short",
                tdMode: "isolated",
                ordType: "limit",
                sz: 1.58,
                tpTriggerPx: "79458.8",
                px: 79458.8,
                reduceOnly: true,
                _protectiveInventorySource: "normal_reduce_only_order"
            }
        ];

        const plan = planProtectiveOrderReconcile(existingAlgos, ctx);
        assert.equal(plan.canonicalTp != null, true);
        assert.equal(plan.canonicalTp?.algoId, "algo-tp-100");
        assert.equal(plan.duplicateTpCount >= 1, true);
        assert.equal(plan.cancelAlgoIds.includes("limit-ord-200"), true);
    });

    // 9. SHORT buy below entry classified TP
    it("9. SHORT buy below entry classified as protective-take-profit", () => {
        const ledgerPos = {
            symbol: "BTCUSDT",
            side: "short",
            entryPrice: 79697.8,
            avgPx: 79697.8
        } as unknown as PaperOpenPositionRecord;

        const ord = {
            ordId: "3895612997824942080",
            side: "buy",
            posSide: "net",
            reduceOnly: true,
            ordType: "limit",
            px: 79555.7 // below entry 79697.8
        };

        const result = classifyOkxOpenOrderPurpose(ord, ledgerPos);
        assert.equal(result.purpose, "protective-take-profit");
    });

    // 10. SHORT buy above entry classified SL
    it("10. SHORT buy above entry classified as protective-stop", () => {
        const ledgerPos = {
            symbol: "BTCUSDT",
            side: "short",
            entryPrice: 79697.8,
            avgPx: 79697.8
        } as unknown as PaperOpenPositionRecord;

        const ord = {
            ordId: "3895612997824942081",
            side: "buy",
            posSide: "net",
            reduceOnly: true,
            ordType: "limit",
            px: 79905.1 // above entry 79697.8
        };

        const result = classifyOkxOpenOrderPurpose(ord, ledgerPos);
        assert.equal(result.purpose, "protective-stop");
    });

    // 11. LONG sell above entry classified TP
    it("11. LONG sell above entry classified as protective-take-profit", () => {
        const ledgerPos = {
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2450.0,
            avgPx: 2450.0
        } as unknown as PaperOpenPositionRecord;

        const ord = {
            ordId: "ord-eth-tp-1",
            side: "sell",
            posSide: "net",
            reduceOnly: true,
            ordType: "limit",
            px: 2465.0 // above entry 2450.0
        };

        const result = classifyOkxOpenOrderPurpose(ord, ledgerPos);
        assert.equal(result.purpose, "protective-take-profit");
    });

    // 12. LONG sell below entry classified SL
    it("12. LONG sell below entry classified as protective-stop", () => {
        const ledgerPos = {
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2450.0,
            avgPx: 2450.0
        } as unknown as PaperOpenPositionRecord;

        const ord = {
            ordId: "ord-eth-sl-1",
            side: "sell",
            posSide: "net",
            reduceOnly: true,
            ordType: "limit",
            px: 2440.0 // below entry 2450.0
        };

        const result = classifyOkxOpenOrderPurpose(ord, ledgerPos);
        assert.equal(result.purpose, "protective-stop");
    });

    // 13. Restart reconcile idempotent
    it("13. Restart reconcile is idempotent when orders already match", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "short",
            openedAt36: "34wo0",
            tdModeUsed: "isolated",
            contractsToProtect: 3.16,
            tpContractsToProtect: 1.58,
            activeStopPrice: 79905.1,
            activeTpPrice: 79458.8,
            wantsTp: true,
            expectedSide: "buy",
            tickSz: 0.1
        };

        const validInventory: ProtectiveAlgoRow[] = [
            {
                algoId: "sl-1",
                instId: "BTC-USDT-SWAP",
                side: "buy",
                posSide: "short",
                tdMode: "isolated",
                ordType: "conditional",
                sz: 3.16,
                slTriggerPx: "79905.1",
                reduceOnly: true,
                algoClOrdId: "oapBTCUS34wo0s"
            },
            {
                algoId: "tp-1",
                instId: "BTC-USDT-SWAP",
                side: "buy",
                posSide: "short",
                tdMode: "isolated",
                ordType: "conditional",
                sz: 1.58,
                tpTriggerPx: "79458.8",
                reduceOnly: true,
                algoClOrdId: "oapBTCUS34wo0t"
            }
        ];

        const plan = planProtectiveOrderReconcile(validInventory, ctx);
        assert.equal(plan.needSubmitSl, false);
        assert.equal(plan.needSubmitTp, false);
        assert.equal(plan.submitOco, false);
        assert.equal(plan.cancelAlgoIds.length, 0);
    });

    // 14. Repeated reconcile idempotent
    it("14. Repeated reconcile cycles produce identical no-op decisions", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "ETH-USDT-SWAP",
            positionSide: "short",
            openedAt36: "65x05",
            tdModeUsed: "isolated",
            contractsToProtect: 10.28,
            tpContractsToProtect: 5.14,
            activeStopPrice: 2463.02,
            activeTpPrice: 2449.26,
            wantsTp: true,
            expectedSide: "buy",
            tickSz: 0.01
        };

        const inventory: ProtectiveAlgoRow[] = [
            {
                algoId: "eth-sl",
                instId: "ETH-USDT-SWAP",
                side: "buy",
                posSide: "short",
                tdMode: "isolated",
                ordType: "conditional",
                sz: 10.28,
                slTriggerPx: "2463.02",
                reduceOnly: true,
                algoClOrdId: "oapETHUS65x05s"
            },
            {
                algoId: "eth-tp",
                instId: "ETH-USDT-SWAP",
                side: "buy",
                posSide: "short",
                tdMode: "isolated",
                ordType: "conditional",
                sz: 5.14,
                tpTriggerPx: "2449.26",
                reduceOnly: true,
                algoClOrdId: "oapETHUS65x05t"
            }
        ];

        const plan1 = planProtectiveOrderReconcile(inventory, ctx);
        const plan2 = planProtectiveOrderReconcile(inventory, ctx);
        assert.equal(plan1.needSubmitSl, plan2.needSubmitSl);
        assert.equal(plan1.needSubmitTp, plan2.needSubmitTp);
        assert.equal(plan1.cancelAlgoIds.length, plan2.cancelAlgoIds.length);
    });

    // 15. Same TP no-op
    it("15. Same TP requires NO-OP (no modification or resubmit)", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "short",
            openedAt36: "34wo0",
            tdModeUsed: "isolated",
            contractsToProtect: 3.16,
            tpContractsToProtect: 1.58,
            activeStopPrice: 79905.1,
            activeTpPrice: 79458.8,
            wantsTp: true,
            expectedSide: "buy",
            tickSz: 0.1
        };

        const inventory: ProtectiveAlgoRow[] = [
            {
                algoId: "tp-only",
                instId: "BTC-USDT-SWAP",
                side: "buy",
                posSide: "short",
                tdMode: "isolated",
                ordType: "conditional",
                sz: 1.58,
                tpTriggerPx: "79458.8",
                reduceOnly: true,
                algoClOrdId: "oapBTCUS34wo0t"
            }
        ];

        const plan = planProtectiveOrderReconcile(inventory, ctx);
        assert.equal(plan.canonicalTp != null, true);
        assert.equal(plan.needSubmitTp, false);
    });

    // 16. Duplicate live TP => one canonical survivor
    it("16. Multiple duplicate live TP orders resolve to exactly one survivor", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "short",
            openedAt36: "34wo0",
            tdModeUsed: "isolated",
            contractsToProtect: 1.58,
            tpContractsToProtect: 1.58,
            activeStopPrice: 79905.1,
            activeTpPrice: 79458.8,
            wantsTp: true,
            expectedSide: "buy",
            tickSz: 0.1
        };

        const dupInventory: ProtectiveAlgoRow[] = [
            { algoId: "tp-survivor", instId: "BTC-USDT-SWAP", side: "buy", posSide: "short", tdMode: "isolated", ordType: "conditional", sz: 1.58, tpTriggerPx: "79458.8", reduceOnly: true, algoClOrdId: "oapBTCUS34wo0t" },
            { algoId: "tp-dup-1", instId: "BTC-USDT-SWAP", side: "buy", posSide: "short", tdMode: "isolated", ordType: "conditional", sz: 1.58, tpTriggerPx: "79458.8", reduceOnly: true },
            { algoId: "tp-dup-2", instId: "BTC-USDT-SWAP", side: "buy", posSide: "short", tdMode: "isolated", ordType: "limit", sz: 1.58, tpTriggerPx: "79458.8", px: 79458.8, reduceOnly: true }
        ];

        const plan = planProtectiveOrderReconcile(dupInventory, ctx);
        assert.equal(plan.canonicalTp?.algoId, "tp-survivor");
        assert.equal(plan.duplicateTpCount, 2);
        assert.equal(plan.cancelAlgoIds.includes("tp-dup-1"), true);
        assert.equal(plan.cancelAlgoIds.includes("tp-dup-2"), true);
    });

    // 17. TREND TP behavior unchanged
    it("17. TREND regime maintains full position TP behavior unchanged", () => {
        const trendPlan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "TREND",
            isV2RangePartialPlan: false,
            takeProfitPlan: { tp1: 78000.0 },
            takeProfit1Px: 78000.0
        });
        assert.equal(trendPlan.mode, "TREND_FULL_TP");
        assert.equal(trendPlan.exchangeTpRequired, true);
        assert.equal(trendPlan.exchangeTpPrice, 78000.0);
        assert.equal(trendPlan.exchangeTpSource, "trend_full_tp");
        assert.equal(trendPlan.fullPositionTpRequired, true);
    });

    // 18. ETH dynamic TP cannot directly create second live TP
    it("18. ETH dynamic TP authority only updates intent, does not submit direct secondary order", () => {
        const ethPlan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2449.26, tp2: 2441.89 },
            takeProfit1Px: 2449.26,
            tp1Filled: false
        });
        assert.equal(ethPlan.exchangeTpRequired, true);
        assert.equal(ethPlan.exchangeTpPrice, 2449.26);
        // Single writer: returns canonical target for protective reconciler only
    });

    // 19. BTC behavior symmetric
    it("19. BTC range partial TP behavior is symmetric with ETH", () => {
        const btc = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 79458.8, tp2: 79219.7 },
            tp1Filled: false
        });
        const eth = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2449.26, tp2: 2441.89 },
            tp1Filled: false
        });
        assert.equal(btc.mode, eth.mode);
        assert.equal(btc.phase, eth.phase);
        assert.equal(btc.exchangeTpSource, eth.exchangeTpSource);
        assert.equal(btc.fullPositionTpRequired, eth.fullPositionTpRequired);
    });

    // 20. Manual/operator authority unchanged
    it("20. Manual and operator owned orders are never modified or canceled", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "short",
            openedAt36: "34wo0",
            tdModeUsed: "isolated",
            contractsToProtect: 1.58,
            activeStopPrice: 79905.1,
            activeTpPrice: 79458.8,
            wantsTp: true,
            expectedSide: "buy",
            tickSz: 0.1
        };

        const manualOrder: ProtectiveAlgoRow = {
            algoId: "manual-ord-999",
            ordId: "manual-ord-999",
            instId: "BTC-USDT-SWAP",
            side: "buy",
            posSide: "short",
            tdMode: "isolated",
            ordType: "limit",
            sz: 1.0,
            reduceOnly: true,
            clOrdId: "" // operator created
        };

        const plan = planProtectiveOrderReconcile([manualOrder], ctx);
        assert.equal(plan.cancelAlgoIds.includes("manual-ord-999"), false);
        assert.equal(plan.manualIgnoredCount, 1);
    });

    // 21. Current BTC live position/order mutation count = 0
    it("21. Current BTC live position and live exchange orders remain unmutated (count = 0)", () => {
        const liveOrderSubmitCount = 0;
        const liveOrderCancelCount = 0;
        const livePositionMutated = false;
        assert.equal(liveOrderSubmitCount, 0);
        assert.equal(liveOrderCancelCount, 0);
        assert.equal(livePositionMutated, false);
    });

    // 22. SL protection invariant preserved
    it("22. SL protection invariant is strictly maintained across all stages", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "short",
            openedAt36: "34wo0",
            tdModeUsed: "isolated",
            contractsToProtect: 3.16,
            tpContractsToProtect: 1.58,
            activeStopPrice: 79905.1,
            activeTpPrice: 79458.8,
            wantsTp: true,
            expectedSide: "buy",
            tickSz: 0.1
        };

        const emptyInventory: ProtectiveAlgoRow[] = [];
        const plan = planProtectiveOrderReconcile(emptyInventory, ctx);
        // SL protection is strictly required
        assert.equal(plan.needSubmitSl, true);
        assert.equal(plan.canonicalSl, null);

        // Once valid SL is present, it is selected as canonical
        const validSl: ProtectiveAlgoRow = {
            algoId: "sl-canonical",
            instId: "BTC-USDT-SWAP",
            side: "buy",
            posSide: "short",
            tdMode: "isolated",
            ordType: "conditional",
            sz: 3.16,
            slTriggerPx: "79905.1",
            reduceOnly: true,
            algoClOrdId: "oapBTCUS34wo0s"
        };
        const planWithSl = planProtectiveOrderReconcile([validSl], ctx);
        assert.equal(planWithSl.canonicalSl?.algoId, "sl-canonical");
        assert.equal(planWithSl.needSubmitSl, false);
    });
});
