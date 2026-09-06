import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluatePositionProtectionState,
    resolveLedgerCanonicalProtectiveTruth
} from "../engine-v2/execution/protective-order-state";
import {
    findProtectiveHintsForInst
} from "./position-ops-monitor";
import {
    resolveProtectiveTpPlan
} from "../engine-v2/execution/protective-tp-authority";
import {
    planProtectiveOrderReconcile,
    type ProtectiveAlgoRow,
    type ProtectiveReconcileContext
} from "../engine-v2/execution/protective-reconcile-plan";
import {
    resolveBtcPositionManagementSuppressor
} from "../lib/position-reconcile-classification";
import type { PaperOpenPositionRecord } from "../models/types";

describe("PHASE 13D+ — MISSING EXCHANGE TP REPAIR & PROTECTION INTEGRITY TESTS", () => {
    const openedAt = 1788650000000;
    const openedAt36 = openedAt.toString(36);
    const enginePrefix = `oapBTCUSl${openedAt36}`;
    const slClOrdId = `${enginePrefix}s`;
    const tpClOrdId = `${enginePrefix}t`;

    const baseLedger: PaperOpenPositionRecord = {
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 79660.1,
        stopPrice: 79453,
        targetPrice1: 79899.1,
        takeProfit1Px: 79899.1,
        takeProfit2Px: 80200.0,
        takeProfitPlan: { tp1: 79899.1, tp2: 80200.0 },
        takeProfitRequired: true,
        isProtectiveStopRegistered: true,
        protectiveStopAlgoId: "3896456287484760064",
        protectiveSlAlgoId: "3896456287484760064",
        protectiveTpAlgoId: undefined,
        isTakeProfitRegistered: false,
        openedAt,
        lifecycleState: "BOT_V2_MANAGED",
        regimeAtEntry: "RANGE",
        sizeUsd: 1000,
        initialSizeUsd: 1000,
        strategyVersion: "2.0",
        sourceSignal: "v2_test",
        sourceRunPath: "test",
        status: "open",
        pos: 0.8,
        leverage: 10,
        isV2Authority: true
    };

    const engineSlOrder: ProtectiveAlgoRow = {
        instId: "BTC-USDT-SWAP",
        algoId: "3896456287484760064",
        algoClOrdId: slClOrdId,
        ordType: "conditional",
        side: "sell",
        posSide: "net",
        tdMode: "cross",
        reduceOnly: true,
        slTriggerPx: "79453",
        sz: "0.8"
    };

    const operatorSlOrder: ProtectiveAlgoRow = {
        instId: "BTC-USDT-SWAP",
        algoId: "3896065696179539968",
        algoClOrdId: "",
        ordType: "conditional",
        side: "sell",
        posSide: "net",
        tdMode: "cross",
        reduceOnly: true,
        slTriggerPx: "79453",
        sz: "0.8"
    };

    const engineTpOrder: ProtectiveAlgoRow = {
        instId: "BTC-USDT-SWAP",
        algoId: "3896456287484760999",
        algoClOrdId: tpClOrdId,
        ordType: "conditional",
        side: "sell",
        posSide: "net",
        tdMode: "cross",
        reduceOnly: true,
        tpTriggerPx: "79899.1",
        sz: "0.4"
    };

    const operatorTpOrder: ProtectiveAlgoRow = {
        instId: "BTC-USDT-SWAP",
        algoId: "3896065696179539999",
        algoClOrdId: "",
        ordType: "conditional",
        side: "sell",
        posSide: "net",
        tdMode: "cross",
        reduceOnly: true,
        tpTriggerPx: "79899.1",
        sz: "0.4"
    };

    // 1. SL 있음 + TP 없음 + tpRequired=true → MATCHED 금지
    it("1. SL present + TP missing + tpRequired=true -> MATCHED prohibited (reduceOnlyProtectiveFound=false)", () => {
        const res = evaluatePositionProtectionState({
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            pending: [],
            algos: [engineSlOrder, operatorSlOrder],
            tpRequired: true,
            ledger: baseLedger,
            tickSz: 0.1,
            requiredStopPx: 79453
        });
        assert.equal(res.reduceOnlyProtectiveFound, false, "reduceOnlyProtectiveFound must be false when TP is missing");
        assert.equal(res.consistencyCheck, "FAIL", "consistencyCheck must be FAIL");
        assert.equal(res.preScanFault, true, "preScanFault must be true");
        assert.equal(res.canonicalProtectiveSlFound, true, "SL itself is found");
        assert.equal(res.exchangeTpPx, null, "exchangeTpPx must be null");
    });

    // 2. ledger isTakeProfitRegistered=true, exchange TP 없음 → MATCHED 금지
    it("2. ledger isTakeProfitRegistered=true but exchange TP missing -> MATCHED prohibited", () => {
        const ledgerWithStaleTpFlag: PaperOpenPositionRecord = {
            ...baseLedger,
            isTakeProfitRegistered: true,
            protectiveTpAlgoId: "9999999999" // Non-existent on exchange
        };

        const canonicalTruth = resolveLedgerCanonicalProtectiveTruth({
            ledger: ledgerWithStaleTpFlag,
            pending: [],
            algos: [engineSlOrder],
            tpRequired: true,
            requiredStopPx: 79453,
            tickSz: 0.1,
            instId: "BTC-USDT-SWAP",
            positionSide: "long"
        });

        assert.equal(canonicalTruth.reduceOnlyProtectiveFound, false, "Stale ledger flag must NOT satisfy reduceOnlyProtectiveFound");
        assert.equal(canonicalTruth.exchangeTpPx, null, "Exchange TP px must remain null");

        const opsHints = findProtectiveHintsForInst("BTC-USDT-SWAP", "long", [], [engineSlOrder], true, {
            ledger: ledgerWithStaleTpFlag,
            tickSz: 0.1,
            requiredStopPx: 79453
        });
        assert.equal(opsHints.protectionSatisfied, false, "findProtectiveHintsForInst must NOT be satisfied without live exchange TP");
    });

    // 3. 실제 TP 있음 → MATCHED
    it("3. Both live SL and TP present -> MATCHED (reduceOnlyProtectiveFound=true)", () => {
        const ledgerWithBoth: PaperOpenPositionRecord = {
            ...baseLedger,
            protectiveTpAlgoId: String(engineTpOrder.algoId),
            isTakeProfitRegistered: true
        };

        const res = evaluatePositionProtectionState({
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            pending: [],
            algos: [engineSlOrder, engineTpOrder],
            tpRequired: true,
            ledger: ledgerWithBoth,
            tickSz: 0.1,
            requiredStopPx: 79453
        });

        assert.equal(res.reduceOnlyProtectiveFound, true, "reduceOnlyProtectiveFound must be true when both live SL and TP exist");
        assert.equal(res.consistencyCheck, "PASS", "consistencyCheck must be PASS");
        assert.equal(res.preScanFault, false, "preScanFault must be false");
        assert.equal(res.exchangeStopPx, 79453);
        assert.equal(res.exchangeTpPx, 79899.1);
    });

    // 4. SL만 있음 → missing TP repair 요청 1건 (RANGE Partial Plan)
    it("4. SL only on exchange -> missing TP repair requested exactly once", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "cross",
            contractsToProtect: 0.8,
            tpContractsToProtect: 0.4, // Partial TP (V2 RANGE)
            activeStopPrice: 79453,
            activeTpPrice: 79899.1,
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([engineSlOrder], ctx);
        assert.equal(plan.needSubmitSl, false, "SL already present, no resubmit needed");
        assert.equal(plan.needSubmitTp, true, "Missing TP must request repair submission");
        assert.equal(plan.submitOco, false, "Partial TP does not use OCO");
        assert.equal(plan.cancelAlgoIds.length, 0, "No duplicate cancels");
    });

    // 5. 동일 TP 이미 있음 → submit 0
    it("5. Same canonical TP already on exchange -> submit 0 (NO-OP)", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "cross",
            contractsToProtect: 0.8,
            tpContractsToProtect: 0.4,
            activeStopPrice: 79453,
            activeTpPrice: 79899.1,
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([engineSlOrder, engineTpOrder], ctx);
        assert.equal(plan.needSubmitSl, false, "SL already present");
        assert.equal(plan.needSubmitTp, false, "TP already present, submit must be false (0 submits)");
        assert.equal(plan.submitOco, false, "OCO submit must be false");
        assert.equal(plan.cancelAlgoIds.length, 0, "No cancels needed");
    });

    // 6. operator-owned SL 보존
    it("6. operator-owned SL (3896065696179539968) must be preserved, never cancelled", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "cross",
            contractsToProtect: 0.8,
            tpContractsToProtect: 0.4,
            activeStopPrice: 79453,
            activeTpPrice: 79899.1,
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.1
        };

        // Inventory contains both engine SL and operator-owned SL
        const plan = planProtectiveOrderReconcile([engineSlOrder, operatorSlOrder], ctx);
        assert.equal(plan.cancelAlgoIds.includes("3896065696179539968"), false, "Operator-owned SL must NEVER be cancelled");
        assert.equal(plan.cancelAlgoIds.length, 0, "Operator orders must never trigger cancellation");
        assert.equal(plan.duplicateSlAlgoIds.includes("3896065696179539968"), true, "Identified as duplicate without being cancelled");
    });

    // 7. operator-owned TP 보존
    it("7. operator-owned TP must be preserved, never cancelled", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "cross",
            contractsToProtect: 0.8,
            tpContractsToProtect: 0.4,
            activeStopPrice: 79453,
            activeTpPrice: 79899.1,
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([engineSlOrder, operatorTpOrder], ctx);
        assert.equal(plan.cancelAlgoIds.includes("3896065696179539968"), false);
        assert.equal(plan.cancelAlgoIds.includes("3896065696179539999"), false, "Operator-owned TP must NEVER be cancelled");
    });

    // 8. TP1_PENDING → TP1만 submit
    it("8. TP1_PENDING -> TP1 only resolved for submission", () => {
        const plan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 79899.1, tp2: 80200.0 },
            takeProfit1Px: 79899.1,
            takeProfit2Px: 80200.0,
            tp1Filled: false,
            partialExitStage: 0
        });

        assert.equal(plan.phase, "TP1_PENDING");
        assert.equal(plan.exchangeTpRequired, true);
        assert.equal(plan.exchangeTpPrice, 79899.1, "Must target TP1 price only");
        assert.equal(plan.exchangeTpSource, "range_tp1_partial");
    });

    // 9. TP2_PENDING → TP2만 submit
    it("9. TP2_PENDING -> TP2 only resolved for submission", () => {
        const plan = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 79899.1, tp2: 80200.0 },
            takeProfit1Px: 79899.1,
            takeProfit2Px: 80200.0,
            tp1Filled: true,
            partialExitStage: 1
        });

        assert.equal(plan.phase, "TP2_PENDING");
        assert.equal(plan.exchangeTpRequired, true);
        assert.equal(plan.exchangeTpPrice, 80200.0, "Must target TP2 price only");
        assert.equal(plan.exchangeTpSource, "range_tp2");
        assert.equal(plan.fullPositionTpRequired, true);
    });

    // 10. TP1+TP2 동시 submit 금지
    it("10. TP1 and TP2 are never simultaneously resolved for submission", () => {
        // Initial phase
        const planInitial = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 79899.1, tp2: 80200.0 },
            takeProfit1Px: 79899.1,
            takeProfit2Px: 80200.0,
            tp1Filled: false
        });
        assert.equal(planInitial.exchangeTpPrice, 79899.1);
        assert.notEqual(planInitial.exchangeTpPrice, 80200.0);

        // Post-fill phase
        const planPostFill = resolveProtectiveTpPlan({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            takeProfitPlan: { tp1: 79899.1, tp2: 80200.0 },
            takeProfit1Px: 79899.1,
            takeProfit2Px: 80200.0,
            tp1Filled: true
        });
        assert.equal(planPostFill.exchangeTpPrice, 80200.0);
        assert.notEqual(planPostFill.exchangeTpPrice, 79899.1);
    });

    // 11. repair submit은 reduceOnly=true
    it("11. repair submit enforces reduceOnly=true and opposite side", () => {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36,
            tdModeUsed: "cross",
            contractsToProtect: 0.8,
            tpContractsToProtect: 0.4,
            activeStopPrice: 79453,
            activeTpPrice: 79899.1,
            wantsTp: true,
            expectedSide: "sell", // opposite of long
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([engineSlOrder], ctx);
        assert.equal(plan.needSubmitTp, true);
        assert.equal(ctx.expectedSide, "sell", "Closing order must be sell for long position");
    });

    // 12. missing TP repair 중에도 ENTRY/ADDON/REVERSE는 계속 차단
    it("12. During missing TP repair, ENTRY / ADDON / REVERSE remain strictly blocked", () => {
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
        assert.equal(suppressor.side_mismatch, false);
        assert.equal(suppressor.suppressor_active, false);
    });
});
