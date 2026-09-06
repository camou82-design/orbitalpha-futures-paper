import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluatePositionProtectionState,
    resolveLedgerCanonicalProtectiveTruth
} from "../engine-v2/execution/protective-order-state";
import {
    resolveProtectiveTpPlan
} from "../engine-v2/execution/protective-tp-authority";
import {
    planProtectiveOrderReconcile,
    evaluateProtectiveAlgoMatch,
    type ProtectiveAlgoRow,
    type ProtectiveReconcileContext
} from "../engine-v2/execution/protective-reconcile-plan";
import {
    buildEntryAttachProtectiveCandidates
} from "../engine-v2/execution/protective-inventory";
import {
    resolveBtcPositionManagementSuppressor
} from "../lib/position-reconcile-classification";
import type { PaperOpenPositionRecord } from "../models/types";

describe("PHASE — SYNTHETIC ENTRY-ATTACH CANDIDATE MUST NOT MASK MISSING LIVE TP", () => {
    const openedAt = 1788660224226;
    const openedAt36 = openedAt.toString(36);
    const enginePrefixEth = `oapETHUSl${openedAt36}`;
    const slClOrdIdEth = `${enginePrefixEth}s`;
    const tpClOrdIdEth = `${enginePrefixEth}t`;

    const enginePrefixBtc = `oapBTCUSl${openedAt36}`;
    const slClOrdIdBtc = `${enginePrefixBtc}s`;
    const tpClOrdIdBtc = `${enginePrefixBtc}t`;

    const ethLiveSlOrder: ProtectiveAlgoRow = {
        instId: "ETH-USDT-SWAP",
        algoId: "3897611153120808960",
        algoClOrdId: slClOrdIdEth,
        ordType: "conditional",
        side: "sell",
        posSide: "net",
        tdMode: "isolated",
        reduceOnly: true,
        slTriggerPx: "2497.68",
        sz: "10.24"
    };

    const ethLiveTpOrder: ProtectiveAlgoRow = {
        instId: "ETH-USDT-SWAP",
        algoId: "3897611153120808999",
        algoClOrdId: tpClOrdIdEth,
        ordType: "conditional",
        side: "sell",
        posSide: "net",
        tdMode: "isolated",
        reduceOnly: true,
        tpTriggerPx: "2511.85",
        sz: "10.24"
    };

    const ethSyntheticAttachCandidate: ProtectiveAlgoRow = {
        instId: "ETH-USDT-SWAP",
        posSide: "long",
        side: "sell",
        reduceOnly: true,
        tdMode: "isolated",
        ordType: "oco",
        sz: 10.24,
        slTriggerPx: "2497.68",
        tpTriggerPx: "2511.85",
        algoClOrdId: "slpETHUSDTbmtp64579a0b411eb",
        attachAlgoClOrdId: "slpETHUSDTbmtp64579a0b411eb",
        attachAlgoOrdId: "slpETHUSDTbmtp64579a0b411eb",
        clOrdId: "sl_pETHUSDTbmtp64579a0b411eb",
        _protectiveInventorySource: "entry_attach_candidate"
    };

    const btcLiveSlOrder: ProtectiveAlgoRow = {
        instId: "BTC-USDT-SWAP",
        algoId: "3896456287484760064",
        algoClOrdId: slClOrdIdBtc,
        ordType: "conditional",
        side: "sell",
        posSide: "net",
        tdMode: "cross",
        reduceOnly: true,
        slTriggerPx: "79453",
        sz: "0.8"
    };

    const btcSyntheticAttachCandidate: ProtectiveAlgoRow = {
        instId: "BTC-USDT-SWAP",
        posSide: "long",
        side: "sell",
        reduceOnly: true,
        tdMode: "cross",
        ordType: "oco",
        sz: 0.8,
        slTriggerPx: "79453",
        tpTriggerPx: "79899.1",
        algoClOrdId: "slpBTCUSDTbmtp64579a0b411eb",
        attachAlgoClOrdId: "slpBTCUSDTbmtp64579a0b411eb",
        attachAlgoOrdId: "slpBTCUSDTbmtp64579a0b411eb",
        clOrdId: "sl_pBTCUSDTbmtp64579a0b411eb",
        _protectiveInventorySource: "entry_attach_candidate"
    };

    const operatorSlOrder: ProtectiveAlgoRow = {
        instId: "ETH-USDT-SWAP",
        algoId: "3896065696179539968",
        algoClOrdId: "",
        ordType: "conditional",
        side: "sell",
        posSide: "net",
        tdMode: "isolated",
        reduceOnly: true,
        slTriggerPx: "2497.68",
        sz: "10.24"
    };

    const operatorTpOrder: ProtectiveAlgoRow = {
        instId: "ETH-USDT-SWAP",
        algoId: "3896065696179539999",
        algoClOrdId: "",
        ordType: "conditional",
        side: "sell",
        posSide: "net",
        tdMode: "isolated",
        reduceOnly: true,
        tpTriggerPx: "2511.85",
        sz: "10.24"
    };

    // 1. real SL + no real TP + synthetic TP -> repair requested (partial TP: needSubmitTp=true, full TP: submitOco=true)
    it("1. real SL + no real TP + synthetic TP candidate present -> repair triggered (partial TP or OCO rebuild)", () => {
        // 1A. Partial TP plan (e.g. 50% TP1)
        const ctxPartial: ProtectiveReconcileContext = {
            instId: "ETH-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "isolated",
            contractsToProtect: 10.24,
            tpContractsToProtect: 5.12,
            activeStopPrice: 2497.68,
            activeTpPrice: 2511.85,
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const planPartial = planProtectiveOrderReconcile(
            [ethLiveSlOrder, ethSyntheticAttachCandidate],
            ctxPartial
        );

        assert.equal(planPartial.canonicalSlAlgoId, "3897611153120808960", "Real SL must be matched as canonicalSl");
        assert.equal(planPartial.canonicalTp, null, "Synthetic candidate must NOT become canonicalTp");
        assert.equal(planPartial.canonicalTpAlgoId, null, "canonicalTpAlgoId must be null");
        assert.equal(planPartial.needSubmitSl, false, "Real SL is present, no SL resubmit");
        assert.equal(planPartial.needSubmitTp, true, "Missing live TP must trigger repair needSubmitTp=true for partial plan");
        assert.equal(planPartial.submitOco, false, "Partial plan does not use full OCO submit");

        // 1B. Full position TP plan
        const ctxFull: ProtectiveReconcileContext = {
            instId: "ETH-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "isolated",
            contractsToProtect: 10.24,
            tpContractsToProtect: 10.24,
            activeStopPrice: 2497.68,
            activeTpPrice: 2511.85,
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const planFull = planProtectiveOrderReconcile(
            [ethLiveSlOrder, ethSyntheticAttachCandidate],
            ctxFull
        );

        assert.equal(planFull.canonicalSlAlgoId, "3897611153120808960");
        assert.equal(planFull.canonicalTp, null);
        assert.equal(planFull.canonicalTpAlgoId, null);
        assert.equal(planFull.submitOco, true, "Full position SL-only triggers OCO rebuild submitOco=true");
        assert.equal(planFull.slOnlyOcoRebuild, true);
    });

    // 2. synthetic TP cannot become canonicalTp
    it("2. synthetic TP candidate cannot become canonicalTp or adoptable", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "ETH-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "isolated",
            contractsToProtect: 10.24,
            tpContractsToProtect: 5.12,
            activeStopPrice: 2497.68,
            activeTpPrice: 2511.85,
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const match = evaluateProtectiveAlgoMatch(ethSyntheticAttachCandidate, ctx);
        assert.equal(match.adoptable, false, "Synthetic candidate must NEVER be adoptable");
        assert.equal(match.tpLegValid, false, "Synthetic candidate tpLegValid must be false");
        assert.equal(match.slLegValid, false, "Synthetic candidate slLegValid must be false");
        assert.equal(match.ocoBothValid, false, "Synthetic candidate ocoBothValid must be false");
        assert.equal(match.stale, false, "Synthetic candidate must NOT be flagged as stale");

        const plan = planProtectiveOrderReconcile([ethSyntheticAttachCandidate], ctx);
        assert.equal(plan.canonicalSl, null);
        assert.equal(plan.canonicalTp, null);
        assert.equal(plan.needSubmitSl, true);
        assert.equal(plan.needSubmitTp, true);
    });

    // 3. real TP exists + synthetic TP also exists -> real TP canonical, needSubmitTp=false
    it("3. real TP exists + synthetic TP also exists -> real TP canonical and needSubmitTp=false", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "ETH-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "isolated",
            contractsToProtect: 10.24,
            tpContractsToProtect: 10.24,
            activeStopPrice: 2497.68,
            activeTpPrice: 2511.85,
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const plan = planProtectiveOrderReconcile(
            [ethLiveSlOrder, ethLiveTpOrder, ethSyntheticAttachCandidate],
            ctx
        );

        assert.equal(plan.canonicalSlAlgoId, "3897611153120808960");
        assert.equal(plan.canonicalTpAlgoId, "3897611153120808999", "Real TP must be canonical");
        assert.equal(plan.needSubmitSl, false);
        assert.equal(plan.needSubmitTp, false, "Both SL and TP present -> submit false (NO-OP)");
        assert.equal(plan.submitOco, false);
        assert.equal(plan.cancelAlgoIds.length, 0);
    });

    // 4. synthetic candidate never enters cancelAlgoIds
    it("4. synthetic candidate never enters cancelAlgoIds", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "ETH-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "isolated",
            contractsToProtect: 10.24,
            tpContractsToProtect: 10.24,
            activeStopPrice: 2497.68,
            activeTpPrice: 2511.85,
            wantsTp: false, // Even when wantsTp is false, synthetic candidate must not be cancelled
            expectedSide: "sell",
            tickSz: 0.01
        };

        const plan = planProtectiveOrderReconcile(
            [ethLiveSlOrder, ethSyntheticAttachCandidate],
            ctx
        );

        assert.equal(plan.cancelAlgoIds.length, 0, "cancelAlgoIds must NOT include synthetic candidate");
    });

    // 5. operator/manual algo remains untouched
    it("5. operator/manual algo remains untouched and preserved", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "ETH-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "isolated",
            contractsToProtect: 10.24,
            tpContractsToProtect: 10.24,
            activeStopPrice: 2497.68,
            activeTpPrice: 2511.85,
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const plan = planProtectiveOrderReconcile(
            [ethLiveSlOrder, operatorSlOrder, operatorTpOrder, ethSyntheticAttachCandidate],
            ctx
        );

        assert.equal(plan.cancelAlgoIds.includes("3896065696179539968"), false, "Operator SL never cancelled");
        assert.equal(plan.cancelAlgoIds.includes("3896065696179539999"), false, "Operator TP never cancelled");
        assert.equal(plan.cancelAlgoIds.length, 0);
    });

    // 6. ETH TP1_PENDING -> TP1 repair requested
    it("6. ETH TP1_PENDING -> TP1 repair requested with exact expected TP price", () => {
        const tpPlan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2511.85, tp2: 2530.00 },
            takeProfit1Px: 2511.85,
            takeProfit2Px: 2530.00,
            tp1Filled: false,
            partialExitStage: 0
        });

        assert.equal(tpPlan.phase, "TP1_PENDING");
        assert.equal(tpPlan.exchangeTpRequired, true);
        assert.equal(tpPlan.exchangeTpPrice, 2511.85);

        const ctx: ProtectiveReconcileContext = {
            instId: "ETH-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "isolated",
            contractsToProtect: 10.24,
            tpContractsToProtect: 5.12, // Partial TP1
            activeStopPrice: 2497.68,
            activeTpPrice: tpPlan.exchangeTpPrice,
            wantsTp: tpPlan.exchangeTpRequired,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const plan = planProtectiveOrderReconcile([ethLiveSlOrder, ethSyntheticAttachCandidate], ctx);
        assert.equal(plan.needSubmitTp, true, "TP1 repair must be requested");
        assert.equal(plan.submitOco, false);
    });

    // 7. ETH TP2_PENDING -> TP2 repair requested
    it("7. ETH TP2_PENDING -> TP2 repair requested with exact expected TP2 price", () => {
        const tpPlan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2511.85, tp2: 2530.00 },
            takeProfit1Px: 2511.85,
            takeProfit2Px: 2530.00,
            tp1Filled: true,
            partialExitStage: 1
        });

        assert.equal(tpPlan.phase, "TP2_PENDING");
        assert.equal(tpPlan.exchangeTpRequired, true);
        assert.equal(tpPlan.exchangeTpPrice, 2530.00);

        const ctx: ProtectiveReconcileContext = {
            instId: "ETH-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "isolated",
            contractsToProtect: 5.12,
            tpContractsToProtect: 5.12, // Post-fill remaining full position TP2
            activeStopPrice: 2504.01,
            activeTpPrice: tpPlan.exchangeTpPrice,
            wantsTp: tpPlan.exchangeTpRequired,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const ethRemainingSlOrder: ProtectiveAlgoRow = {
            ...ethLiveSlOrder,
            sz: "5.12",
            slTriggerPx: "2504.01"
        };

        const plan = planProtectiveOrderReconcile([ethRemainingSlOrder, ethSyntheticAttachCandidate], ctx);
        assert.equal(plan.canonicalSlAlgoId, "3897611153120808960");
        assert.equal(plan.canonicalTp, null);
        assert.equal(plan.submitOco, true, "TP2 full-remaining repair requested via OCO rebuild");
        assert.equal(plan.slOnlyOcoRebuild, true);
    });

    // 8. BTC same missing-TP case behaves identically
    it("8. BTC same missing-TP case behaves identically (shared contract)", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "cross",
            contractsToProtect: 0.8,
            tpContractsToProtect: 0.4, // Partial TP
            activeStopPrice: 79453,
            activeTpPrice: 79899.1,
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile(
            [btcLiveSlOrder, btcSyntheticAttachCandidate],
            ctx
        );

        assert.equal(plan.canonicalSlAlgoId, "3896456287484760064");
        assert.equal(plan.canonicalTp, null);
        assert.equal(plan.needSubmitSl, false);
        assert.equal(plan.needSubmitTp, true, "BTC missing live TP must also trigger repair");
    });

    // 9. actual matching live TP -> NO-OP/idempotent
    it("9. actual matching live TP -> NO-OP / idempotent", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "ETH-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "isolated",
            contractsToProtect: 10.24,
            tpContractsToProtect: 10.24,
            activeStopPrice: 2497.68,
            activeTpPrice: 2511.85,
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const plan = planProtectiveOrderReconcile([ethLiveSlOrder, ethLiveTpOrder], ctx);
        assert.equal(plan.needSubmitSl, false);
        assert.equal(plan.needSubmitTp, false);
        assert.equal(plan.submitOco, false);
        assert.equal(plan.cancelAlgoIds.length, 0);
    });

    // 10. SL logic remains unchanged
    it("10. SL logic remains unchanged", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "ETH-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "isolated",
            contractsToProtect: 10.24,
            tpContractsToProtect: 10.24,
            activeStopPrice: 2497.68,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const plan = planProtectiveOrderReconcile([ethLiveSlOrder], ctx);
        assert.equal(plan.canonicalSlAlgoId, "3897611153120808960");
        assert.equal(plan.needSubmitSl, false);
        assert.equal(plan.needSubmitTp, false);
        assert.equal(plan.submitOco, false);
    });

    // 11. no TP1+TP2 simultaneous submit
    it("11. no TP1+TP2 simultaneous submit resolved in any phase", () => {
        const initial = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2511.85, tp2: 2530.00 },
            takeProfit1Px: 2511.85,
            takeProfit2Px: 2530.00,
            tp1Filled: false
        });
        assert.equal(initial.exchangeTpPrice, 2511.85);

        const postFill = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 2511.85, tp2: 2530.00 },
            takeProfit1Px: 2511.85,
            takeProfit2Px: 2530.00,
            tp1Filled: true
        });
        assert.equal(postFill.exchangeTpPrice, 2530.00);
    });

    // 12. no trading entry/addon/reverse behavior changed
    it("12. position suppressor and trading safety gates remain intact", () => {
        const suppressor = resolveBtcPositionManagementSuppressor({
            okxActualSide: "long",
            paperSide: "long",
            v2InferredSide: "long",
            reconcileState: "MATCHED",
            externalManualBlockedForSide: false,
            botOwnershipEvidence: true,
            positiveExternalManualEvidence: false,
            closeOnlyMode: false,
            killSwitch: false
        });
        assert.equal(suppressor.sides_aligned, true);
        assert.equal(suppressor.suppressor_active, false);
    });
});
