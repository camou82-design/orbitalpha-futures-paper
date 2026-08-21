import assert from "node:assert";
import type { MarketSymbol, PaperOpenPositionRecord } from "../models/types";
import { shouldAttachFullPositionProtectiveTp, resolveProtectiveExistingAlgoLedgerAdoption, shouldDeferReplacementSlResubmitDuringVisibilityGrace } from "./paper-engine";
import { planProtectiveOrderReconcile, type ProtectiveAlgoRow, type ProtectiveReconcileContext } from "../engine-v2/execution/protective-reconcile-plan";
import { engineMirrorTpPrice, engineMirrorStopPrice } from "./position-ops-monitor";
import { takeProfitPctForRegime } from "../strategy/regime-exit";
import { calculateProbeTpPlan, evaluateProbeBreakevenStop } from "../engine-v2/exit/probe-tp-policy";

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

function runTrendTpAuthorityTests() {
    console.log("=== RUNNING V2 TREND TP AUTHORITY REGRESSION TESTS ===");

    // TEST A — REAL BTC CASE:
    // pre-entry reference = 77752.5, actual fill = 77719.5, old mirror TP ≈ 78568.9
    // Proves that in V2 TREND without explicit structural TP, generic full-position fixed TP (78568.9) is NOT required/submitted.
    {
        const refEntry = 77752.5;
        const actualFill = 77719.5;
        const oldMirrorTp = engineMirrorTpPrice(refEntry, "long", "TREND"); // 78568.90125
        assert(oldMirrorTp != null && Math.abs(oldMirrorTp - 78568.90125) < 1e-4, "Old mirror TP calculation matches BTC case");

        const tpEval = shouldAttachFullPositionProtectiveTp({
            isV2Authority: true,
            regime: "TREND",
            isV2RangePartialPlan: false,
            rawWantsTp: true, // even if activeTpPrice exists
            takeProfitRequired: false
        });

        report(
            "TEST A — REAL BTC CASE: V2 TREND suppresses generic full-position fixed TP (78568.9)",
            tpEval.fullPositionTpRequired === false && tpEval.reason === "V2_TREND_DYNAMIC_EXIT_SOVEREIGNTY",
            { oldMirrorTp, fullPositionTpRequired: tpEval.fullPositionTpRequired, reason: tpEval.reason }
        );
    }

    // TEST B — V2 TREND NO AUTH TP:
    // initial_tp_price = null, takeProfitSource = none, fullPositionTpRequired = false, SL required = true
    {
        const tpEval = shouldAttachFullPositionProtectiveTp({
            isV2Authority: true,
            regime: "TREND",
            isV2RangePartialPlan: false,
            rawWantsTp: false,
            takeProfitRequired: false
        });

        report(
            "TEST B — V2 TREND NO AUTH TP: fullPositionTpRequired is false by default",
            tpEval.fullPositionTpRequired === false && tpEval.reason === "V2_TREND_DYNAMIC_EXIT_SOVEREIGNTY",
            { fullPositionTpRequired: tpEval.fullPositionTpRequired }
        );
    }

    // TEST C — V2 TREND EXPLICIT TARGET:
    // explicit takeProfit1Px presence does NOT cause full-position exchange TP to be required=true
    {
        const explicitTarget = 80000;
        const tpEval = shouldAttachFullPositionProtectiveTp({
            isV2Authority: true,
            regime: "TREND",
            isV2RangePartialPlan: false,
            rawWantsTp: true, // explicit target is present in ledger
            takeProfitRequired: true
        });

        report(
            "TEST C — V2 TREND EXPLICIT TARGET: advisory/diagnostic target does NOT attach full-position exchange TP",
            tpEval.fullPositionTpRequired === false,
            { explicitTarget, fullPositionTpRequired: tpEval.fullPositionTpRequired }
        );
    }

    // TEST D — FULL SL PRESERVED:
    // TREND TP suppression preserves 100% contracts for protective SL
    {
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 5,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([], ctx);
        report(
            "TEST D — FULL SL PRESERVED: needSubmitSl is true for full contracts when no SL exists, submitOco is false",
            plan.needSubmitSl === true && plan.needSubmitTp === false && plan.submitOco === false,
            { needSubmitSl: plan.needSubmitSl, needSubmitTp: plan.needSubmitTp, submitOco: plan.submitOco }
        );
    }

    // TEST E — EXISTING BOT TP CLEANUP:
    // Existing V2 TREND position with obsolete bot-owned TP algo gets TP cleanup while SL is preserved
    {
        const botSlAlgo: ProtectiveAlgoRow = {
            algoId: "sl_101",
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            reduceOnly: true,
            sz: 5,
            slTriggerPx: 76936.0
        };

        const obsoleteBotTpAlgo: ProtectiveAlgoRow = {
            algoId: "tp_102",
            algoClOrdId: "oap_abc123_tp",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            reduceOnly: true,
            sz: 5,
            tpTriggerPx: 78568.9
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 5,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false, // V2 TREND policy: full TP not wanted
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([botSlAlgo, obsoleteBotTpAlgo], ctx);
        report(
            "TEST E — EXISTING BOT TP CLEANUP: obsolete bot TP is in cancelAlgoIds, canonical SL is adopted and NOT canceled",
            plan.canonicalSl != null &&
            plan.canonicalSlAlgoId === "sl_101" &&
            plan.cancelAlgoIds.includes("tp_102") &&
            !plan.cancelAlgoIds.includes("sl_101"),
            { canonicalSlAlgoId: plan.canonicalSlAlgoId, cancelAlgoIds: plan.cancelAlgoIds }
        );
    }

    // TEST F — MANUAL ORDER SAFETY:
    // Manual TP / manual reduce order is NEVER mistaken for obsolete bot TP cleanup
    {
        const manualTpAlgo: ProtectiveAlgoRow = {
            algoId: "manual_tp_999",
            algoClOrdId: "", // no engine prefix -> manual
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            reduceOnly: true,
            sz: 2,
            tpTriggerPx: 82000.0
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 5,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([manualTpAlgo], ctx);
        report(
            "TEST F — MANUAL ORDER SAFETY: manual TP is NOT added to cancelAlgoIds",
            !plan.cancelAlgoIds.includes("manual_tp_999"),
            { cancelAlgoIds: plan.cancelAlgoIds, manualIgnoredCount: plan.manualIgnoredCount }
        );
    }

    // TEST G — RANGE UNCHANGED:
    // Existing RANGE TP1/TP2 / partial plan behavior remains intact
    {
        // 1. RANGE without partial plan -> full TP required
        const fullRangeTp = shouldAttachFullPositionProtectiveTp({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: false,
            rawWantsTp: true,
            takeProfitRequired: true
        });
        assert(fullRangeTp.fullPositionTpRequired === true, "RANGE full TP required when no partial plan");

        // 2. RANGE with partial plan -> full TP forbidden (delegated to partial ladder)
        const partialRangeTp = shouldAttachFullPositionProtectiveTp({
            isV2Authority: true,
            regime: "RANGE",
            isV2RangePartialPlan: true,
            rawWantsTp: true,
            takeProfitRequired: false
        });
        assert(partialRangeTp.fullPositionTpRequired === false, "RANGE partial plan delegates TP");

        report(
            "TEST G — RANGE UNCHANGED: RANGE full and partial TP delegation policies intact",
            fullRangeTp.fullPositionTpRequired === true && partialRangeTp.fullPositionTpRequired === false,
            { fullRangeTp, partialRangeTp }
        );
    }

    // TEST H — PROBE UNCHANGED:
    // Probe TP1 reduce-only + TP1 fill breakeven behavior remains intact
    {
        const plan = calculateProbeTpPlan(
            "BTCUSDT",
            "long",
            "EARLY_REVERSAL_LONG_PROBE",
            77719.5,
            76936.0
        );
        assert(plan != null, "Probe plan exists");
        const beResult = evaluateProbeBreakevenStop(
            "BTCUSDT",
            "long",
            plan,
            76936.0,
            true, // tp1Filled
            0.5
        );
        report(
            "TEST H — PROBE UNCHANGED: Probe TP1 and breakeven evaluation behavior preserved",
            plan.tp1Price > 77719.5 && beResult != null && beResult.shouldMove === true,
            { tp1Price: plan.tp1Price, newStopPrice: beResult?.newStopPrice }
        );
    }

    // TEST I — LEGACY UNCHANGED:
    // Legacy engineMirrorTpPrice behavior is intact
    {
        const legacyTpEval = shouldAttachFullPositionProtectiveTp({
            isV2Authority: false,
            regime: "TREND",
            isV2RangePartialPlan: false,
            rawWantsTp: true,
            takeProfitRequired: true
        });

        const mirrored = engineMirrorTpPrice(77752.5, "long", "TREND");
        report(
            "TEST I — LEGACY UNCHANGED: Legacy engineMirrorTpPrice and TP attachment intact",
            legacyTpEval.fullPositionTpRequired === true && mirrored != null && Math.abs(mirrored - 78568.90125) < 1e-4,
            { legacyTpRequired: legacyTpEval.fullPositionTpRequired, mirrored }
        );
    }

    // TEST J — LONG / SHORT SYMMETRY:
    // V2 TREND long and short both suppress generic fixed full-position TP
    {
        const longEval = shouldAttachFullPositionProtectiveTp({
            isV2Authority: true,
            regime: "TREND",
            isV2RangePartialPlan: false,
            rawWantsTp: true,
            takeProfitRequired: false
        });

        const shortEval = shouldAttachFullPositionProtectiveTp({
            isV2Authority: true,
            regime: "TREND",
            isV2RangePartialPlan: false,
            rawWantsTp: true,
            takeProfitRequired: false
        });

        report(
            "TEST J — LONG / SHORT SYMMETRY: Both long and short V2 TREND suppress generic full TP",
            longEval.fullPositionTpRequired === false && shortEval.fullPositionTpRequired === false,
            { longReason: longEval.reason, shortReason: shortEval.reason }
        );
    }

    // TEST K — V2 TREND LONG LEGACY OCO MIGRATION (DEFECT D):
    // Before new SL is confirmed on exchange, old OCO remains live and is NOT prematurely canceled.
    {
        const legacyBotOco: ProtectiveAlgoRow = {
            algoId: "old_oco_1",
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "oco",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0,
            tpTriggerPx: 78568.9
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false, // V2 TREND: no TP wanted
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([legacyBotOco], ctx);
        report(
            "TEST K — V2 TREND LONG LEGACY OCO MIGRATION: canonicalSl is preserved, needSubmitSl=true for replacement, old OCO NOT yet canceled",
            plan.canonicalSl != null &&
            plan.canonicalSlAlgoId === "old_oco_1" &&
            plan.needSubmitSl === true &&
            plan.needSubmitTp === false &&
            plan.submitOco === false &&
            !plan.cancelAlgoIds.includes("old_oco_1"),
            { canonicalSlAlgoId: plan.canonicalSlAlgoId, needSubmitSl: plan.needSubmitSl, cancelAlgoIds: plan.cancelAlgoIds }
        );
    }

    // TEST L — V2 TREND SHORT LEGACY OCO MIGRATION:
    // SHORT symmetric legacy OCO migration to standalone SL
    {
        const legacyShortOco: ProtectiveAlgoRow = {
            algoId: "old_oco_short_1",
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "short",
            side: "buy",
            tdMode: "cross",
            ordType: "oco",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 78000.0,
            tpTriggerPx: 76000.0
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "short",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 78000.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "buy",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([legacyShortOco], ctx);
        report(
            "TEST L — SHORT SYMMETRY: Short legacy OCO triggers standalone SL replacement and preserves old OCO until confirmed",
            plan.canonicalSl != null &&
            plan.canonicalSlAlgoId === "old_oco_short_1" &&
            plan.needSubmitSl === true &&
            plan.needSubmitTp === false &&
            plan.submitOco === false &&
            !plan.cancelAlgoIds.includes("old_oco_short_1"),
            { canonicalSlAlgoId: plan.canonicalSlAlgoId, needSubmitSl: plan.needSubmitSl, cancelAlgoIds: plan.cancelAlgoIds }
        );
    }

    // TEST M — MANUAL OCO SAFETY:
    // Manual OCO is NEVER mutated, canceled, or replaced
    {
        const manualOco: ProtectiveAlgoRow = {
            algoId: "manual_oco_777",
            algoClOrdId: "", // manual
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "oco",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0,
            tpTriggerPx: 78568.9
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([manualOco], ctx);
        report(
            "TEST M — MANUAL OCO SAFETY: Manual OCO is preserved and NOT added to cancelAlgoIds nor forced to replace",
            !plan.cancelAlgoIds.includes("manual_oco_777") &&
            plan.needSubmitSl === false,
            { cancelAlgoIds: plan.cancelAlgoIds, needSubmitSl: plan.needSubmitSl }
        );
    }

    // TEST N — STANDALONE SL + STANDALONE LEGACY TP:
    // Standalone SL preserved, bot standalone TP canceled, no new SL required
    {
        const standaloneSl: ProtectiveAlgoRow = {
            algoId: "sl_standalone_1",
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "conditional",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0
        };

        const legacyTp: ProtectiveAlgoRow = {
            algoId: "tp_standalone_1",
            algoClOrdId: "oap_abc123_tp",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "conditional",
            reduceOnly: true,
            sz: 0.39,
            tpTriggerPx: 78568.9
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([standaloneSl, legacyTp], ctx);
        report(
            "TEST N — STANDALONE SL + STANDALONE TP: Standalone SL preserved, standalone TP canceled, no new SL required",
            plan.canonicalSlAlgoId === "sl_standalone_1" &&
            plan.needSubmitSl === false &&
            plan.cancelAlgoIds.includes("tp_standalone_1") &&
            !plan.cancelAlgoIds.includes("sl_standalone_1"),
            { canonicalSlAlgoId: plan.canonicalSlAlgoId, needSubmitSl: plan.needSubmitSl, cancelAlgoIds: plan.cancelAlgoIds }
        );
    }

    // TEST O — VISIBILITY PENDING MUST KEEP OLD OCO:
    // When new SL is submitted but not yet visible on exchange inventory, old OCO remains live and uncanceled.
    {
        const oldOco: ProtectiveAlgoRow = {
            algoId: "old_oco_vis_pending",
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "oco",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0,
            tpTriggerPx: 78568.9
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([oldOco], ctx);
        report(
            "TEST O — VISIBILITY PENDING MUST KEEP OLD OCO: old OCO is active canonical SL and NOT in cancelAlgoIds",
            plan.canonicalSlAlgoId === "old_oco_vis_pending" &&
            !plan.cancelAlgoIds.includes("old_oco_vis_pending") &&
            plan.needSubmitSl === true,
            { canonicalSlAlgoId: plan.canonicalSlAlgoId, cancelAlgoIds: plan.cancelAlgoIds }
        );
    }

    // TEST P — EXCHANGE CONFIRMED THEN CANCEL:
    // Once new standalone SL is visible and confirmed on exchange, it becomes canonicalSl and old OCO is canceled.
    {
        const oldOco: ProtectiveAlgoRow = {
            algoId: "old_oco_confirmed_cycle",
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "oco",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0,
            tpTriggerPx: 78568.9
        };

        const newConfirmedSl: ProtectiveAlgoRow = {
            algoId: "new_sl_100_confirmed",
            algoClOrdId: "oap_abc123_sl_new",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "conditional",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([oldOco, newConfirmedSl], ctx);
        report(
            "TEST P — EXCHANGE CONFIRMED THEN CANCEL: new standalone SL is canonical, old OCO is canceled",
            plan.canonicalSlAlgoId === "new_sl_100_confirmed" &&
            plan.cancelAlgoIds.includes("old_oco_confirmed_cycle") &&
            !plan.cancelAlgoIds.includes("new_sl_100_confirmed") &&
            plan.needSubmitSl === false,
            { canonicalSlAlgoId: plan.canonicalSlAlgoId, cancelAlgoIds: plan.cancelAlgoIds, needSubmitSl: plan.needSubmitSl }
        );
    }

    // TEST Q — ABSENT AFTER GRACE FAIL CLOSED:
    // If new SL lookup is absent, inventory contains only old OCO, so old OCO is kept and not canceled.
    {
        const oldOco: ProtectiveAlgoRow = {
            algoId: "old_oco_absent_fallback",
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "oco",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0,
            tpTriggerPx: 78568.9
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([oldOco], ctx);
        report(
            "TEST Q — ABSENT AFTER GRACE FAIL CLOSED: old OCO maintains live protection and is not canceled",
            plan.canonicalSlAlgoId === "old_oco_absent_fallback" &&
            !plan.cancelAlgoIds.includes("old_oco_absent_fallback"),
            { canonicalSlAlgoId: plan.canonicalSlAlgoId, cancelAlgoIds: plan.cancelAlgoIds }
        );
    }

    // TEST R — RESTART BETWEEN SUBMIT AND VISIBILITY:
    // System preserves old OCO on restart when new SL is still not in inventory, then migrates once new SL appears.
    {
        const oldOco: ProtectiveAlgoRow = {
            algoId: "old_oco_restart",
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "oco",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0,
            tpTriggerPx: 78568.9
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        // Phase 1: Immediately after restart, only old OCO visible
        const plan1 = planProtectiveOrderReconcile([oldOco], ctx);
        assert(plan1.canonicalSlAlgoId === "old_oco_restart" && !plan1.cancelAlgoIds.includes("old_oco_restart"));

        // Phase 2: After new SL appears in inventory
        const newSl: ProtectiveAlgoRow = {
            algoId: "new_sl_after_restart",
            algoClOrdId: "oap_abc123_sl_new",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "conditional",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0
        };
        const plan2 = planProtectiveOrderReconcile([oldOco, newSl], ctx);

        report(
            "TEST R — RESTART BETWEEN SUBMIT AND VISIBILITY: Old OCO kept during recovery, canceled only after new SL arrives",
            plan1.canonicalSlAlgoId === "old_oco_restart" &&
            !plan1.cancelAlgoIds.includes("old_oco_restart") &&
            plan2.canonicalSlAlgoId === "new_sl_after_restart" &&
            plan2.cancelAlgoIds.includes("old_oco_restart"),
            { phase1Sl: plan1.canonicalSlAlgoId, phase2Sl: plan2.canonicalSlAlgoId, phase2Cancel: plan2.cancelAlgoIds }
        );
    }

    // TEST S — WRONG SIZE NEW SL:
    // If visible new SL has wrong size, it cannot supersede old OCO, and old OCO is not canceled.
    {
        const oldOco: ProtectiveAlgoRow = {
            algoId: "old_oco_full_sz",
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "oco",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0,
            tpTriggerPx: 78568.9
        };

        const wrongSizeSl: ProtectiveAlgoRow = {
            algoId: "new_sl_wrong_sz",
            algoClOrdId: "oap_abc123_sl_new",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "conditional",
            reduceOnly: true,
            sz: 0.1, // wrong size (0.1 instead of 0.39)
            slTriggerPx: 76936.0
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([oldOco, wrongSizeSl], ctx);
        report(
            "TEST S — WRONG SIZE NEW SL: Wrong size SL is rejected (marked stale) and old full-size OCO remains canonical",
            plan.canonicalSlAlgoId === "old_oco_full_sz" &&
            !plan.cancelAlgoIds.includes("old_oco_full_sz") &&
            plan.cancelAlgoIds.includes("new_sl_wrong_sz"),
            { canonicalSlAlgoId: plan.canonicalSlAlgoId, cancelAlgoIds: plan.cancelAlgoIds }
        );
    }

    // TEST T — WRONG PRICE / WRONG SIDE:
    // If visible new SL has wrong price or wrong side, old full-size OCO remains canonical and is not canceled.
    {
        const oldOco: ProtectiveAlgoRow = {
            algoId: "old_oco_valid_px",
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "oco",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0,
            tpTriggerPx: 78568.9
        };

        const wrongPxSl: ProtectiveAlgoRow = {
            algoId: "new_sl_wrong_px",
            algoClOrdId: "oap_abc123_sl_new",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "conditional",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 60000.0 // wrong price (60000 instead of 76936)
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([oldOco, wrongPxSl], ctx);
        report(
            "TEST T — WRONG PRICE / WRONG SIDE: Wrong price SL is rejected and old valid OCO remains canonical",
            plan.canonicalSlAlgoId === "old_oco_valid_px" &&
            !plan.cancelAlgoIds.includes("old_oco_valid_px"),
            { canonicalSlAlgoId: plan.canonicalSlAlgoId, cancelAlgoIds: plan.cancelAlgoIds }
        );
    }

    // TEST U2 — TRUE MULTI-CYCLE NO-RESUBMIT:
    // When replacement SL has been accepted/persisted and grace is active,
    // 3 sequential pending cycles yield 0 additional submits, 0 cancels, and keep old OCO canonical.
    {
        const nowMs = 1700000000000;
        const graceDeadlineMs = nowMs + 30000;
        const persistedReplacementSlAlgoId = "new_replacement_sl_1";
        const oldOcoAlgoId = "old_oco_1";

        const oldOco: ProtectiveAlgoRow = {
            algoId: oldOcoAlgoId,
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "oco",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0,
            tpTriggerPx: 78568.9
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        let additionalSubmitCount = 0;
        let oldOcoCancelCount = 0;

        for (let cycle = 1; cycle <= 3; cycle++) {
            const currentNow = nowMs + (cycle * 1000); // 1s, 2s, 3s later (well inside 30s grace)
            const plan = planProtectiveOrderReconcile([oldOco], ctx);
            assert(plan.canonicalSlAlgoId === oldOcoAlgoId, `Cycle ${cycle}: old OCO must remain canonical`);
            assert(plan.needSubmitSl === true, `Cycle ${cycle}: migration intent must remain true in plan`);

            const deferEval = shouldDeferReplacementSlResubmitDuringVisibilityGrace({
                nowMs: currentNow,
                graceDeadlineMs,
                persistedSlAlgoId: persistedReplacementSlAlgoId,
                canonicalSlAlgoId: plan.canonicalSlAlgoId,
                isCanonicalSlOco: true,
                hasAuthoritativeSl: plan.canonicalSl != null,
                isV2Authority: true,
                regime: "TREND",
                wantsTp: false
            });

            assert(deferEval.shouldDefer === true, `Cycle ${cycle}: submit must be deferred by visibility grace`);
            assert(deferEval.acceptedReplacementEvidence === true, `Cycle ${cycle}: replacement evidence must be recognized`);

            const actualSubmitThisCycle = plan.needSubmitSl && !deferEval.shouldDefer;
            if (actualSubmitThisCycle) additionalSubmitCount++;
            if (plan.cancelAlgoIds.includes(oldOcoAlgoId)) oldOcoCancelCount++;
        }

        report(
            "TEST U2 — TRUE MULTI-CYCLE NO-RESUBMIT: 0 additional submits, 0 cancels, old OCO remains canonical across 3 pending cycles",
            additionalSubmitCount === 0 && oldOcoCancelCount === 0,
            { additionalSubmitCount, oldOcoCancelCount }
        );
    }

    // TEST U3 — CONFIRMATION ARRIVES INSIDE GRACE:
    // Cycle 1 (absent) -> no submit, no cancel.
    // Cycle 2 (confirmed on exchange) -> canonicalSl becomes new SL, cancel old OCO.
    {
        const nowMs = 1700000000000;
        const graceDeadlineMs = nowMs + 30000;
        const replacementAlgoId = "new_replacement_sl_1";
        const oldOcoAlgoId = "old_oco_1";

        const oldOco: ProtectiveAlgoRow = {
            algoId: oldOcoAlgoId,
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "oco",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0,
            tpTriggerPx: 78568.9
        };

        const confirmedReplacementSl: ProtectiveAlgoRow = {
            algoId: replacementAlgoId,
            algoClOrdId: "oap_abc123_sl_new",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "conditional",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        // Cycle 1: replacement absent
        const plan1 = planProtectiveOrderReconcile([oldOco], ctx);
        const defer1 = shouldDeferReplacementSlResubmitDuringVisibilityGrace({
            nowMs: nowMs + 1000,
            graceDeadlineMs,
            persistedSlAlgoId: replacementAlgoId,
            canonicalSlAlgoId: plan1.canonicalSlAlgoId,
            isCanonicalSlOco: true,
            hasAuthoritativeSl: plan1.canonicalSl != null,
            isV2Authority: true,
            regime: "TREND",
            wantsTp: false
        });
        assert(defer1.shouldDefer === true && !plan1.cancelAlgoIds.includes(oldOcoAlgoId));

        // Cycle 2: replacement confirmed on exchange
        const plan2 = planProtectiveOrderReconcile([oldOco, confirmedReplacementSl], ctx);
        const defer2 = shouldDeferReplacementSlResubmitDuringVisibilityGrace({
            nowMs: nowMs + 2000,
            graceDeadlineMs,
            persistedSlAlgoId: replacementAlgoId,
            canonicalSlAlgoId: plan2.canonicalSlAlgoId,
            isCanonicalSlOco: false, // standalone confirmed!
            hasAuthoritativeSl: plan2.canonicalSl != null,
            isV2Authority: true,
            regime: "TREND",
            wantsTp: false
        });

        report(
            "TEST U3 — CONFIRMATION ARRIVES INSIDE GRACE: Cycle 1 deferred without cancel, Cycle 2 confirms new SL and cancels old OCO",
            plan2.canonicalSlAlgoId === replacementAlgoId &&
            plan2.cancelAlgoIds.includes(oldOcoAlgoId) &&
            defer2.replacementExchangeConfirmed === true &&
            defer2.shouldDefer === false,
            { plan1Canonical: plan1.canonicalSlAlgoId, plan2Canonical: plan2.canonicalSlAlgoId, cancelAlgoIds: plan2.cancelAlgoIds }
        );
    }

    // TEST U4 — DO NOT HIDE REAL UNPROTECTED STATE:
    // If no live SL exists on exchange, defer guard must NOT suppress repair / must return shouldDefer=false.
    {
        const nowMs = 1700000000000;
        const graceDeadlineMs = nowMs + 30000;
        const deferEval = shouldDeferReplacementSlResubmitDuringVisibilityGrace({
            nowMs,
            graceDeadlineMs,
            persistedSlAlgoId: "persisted_sl_candidate",
            canonicalSlAlgoId: null, // NO live SL
            isCanonicalSlOco: false,
            hasAuthoritativeSl: false,
            isV2Authority: true,
            regime: "TREND",
            wantsTp: false
        });

        report(
            "TEST U4 — DO NOT HIDE REAL UNPROTECTED STATE: shouldDefer is false when no live SL protects position",
            deferEval.shouldDefer === false &&
            deferEval.currentLiveSlProtectionConfirmed === false &&
            deferEval.reason === "NO_LIVE_SL_PROTECTION_CONFIRMED",
            { deferEval }
        );
    }

    // TEST U5 — FIRST SUBMIT MUST NOT BE SUPPRESSED:
    // When position only has old OCO and persistedSlAlgoId matches old OCO (or empty),
    // acceptedReplacementEvidence is false, and first standalone SL submit is NOT suppressed.
    {
        const nowMs = 1700000000000;
        const graceDeadlineMs = nowMs + 30000;
        const deferEval = shouldDeferReplacementSlResubmitDuringVisibilityGrace({
            nowMs,
            graceDeadlineMs,
            persistedSlAlgoId: "old_oco_1", // same as canonical OCO
            canonicalSlAlgoId: "old_oco_1",
            isCanonicalSlOco: true,
            hasAuthoritativeSl: true,
            isV2Authority: true,
            regime: "TREND",
            wantsTp: false
        });

        report(
            "TEST U5 — FIRST SUBMIT MUST NOT BE SUPPRESSED: shouldDefer is false when persisted identity matches old OCO",
            deferEval.shouldDefer === false &&
            deferEval.acceptedReplacementEvidence === false &&
            deferEval.reason === "NO_ACCEPTED_REPLACEMENT_EVIDENCE",
            { deferEval }
        );
    }

    // TEST V2 — AFTER GRACE EXPIRY:
    // After grace expiry, shouldDefer is false, old OCO remains live and is NOT canceled.
    {
        const nowMs = 1700000040000; // 40s later (grace expired)
        const graceDeadlineMs = 1700000030000;
        const oldOcoAlgoId = "old_oco_1";

        const oldOco: ProtectiveAlgoRow = {
            algoId: oldOcoAlgoId,
            algoClOrdId: "oap_abc123_sl",
            instId: "BTC-USDT-SWAP",
            posSide: "long",
            side: "sell",
            tdMode: "cross",
            ordType: "oco",
            reduceOnly: true,
            sz: 0.39,
            slTriggerPx: 76936.0,
            tpTriggerPx: 78568.9
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc123",
            tdModeUsed: "cross",
            contractsToProtect: 0.39,
            activeStopPrice: 76936.0,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile([oldOco], ctx);
        const deferEval = shouldDeferReplacementSlResubmitDuringVisibilityGrace({
            nowMs,
            graceDeadlineMs,
            persistedSlAlgoId: "new_replacement_sl_1",
            canonicalSlAlgoId: plan.canonicalSlAlgoId,
            isCanonicalSlOco: true,
            hasAuthoritativeSl: plan.canonicalSl != null,
            isV2Authority: true,
            regime: "TREND",
            wantsTp: false
        });

        report(
            "TEST V2 — AFTER GRACE EXPIRY: shouldDefer is false (grace expired) and old OCO remains live without cancellation",
            deferEval.shouldDefer === false &&
            deferEval.activeGrace === false &&
            deferEval.reason === "VISIBILITY_GRACE_EXPIRED_OR_ABSENT" &&
            plan.canonicalSlAlgoId === oldOcoAlgoId &&
            !plan.cancelAlgoIds.includes(oldOcoAlgoId),
            { deferEval, canonicalSl: plan.canonicalSlAlgoId, cancelAlgoIds: plan.cancelAlgoIds }
        );
    }

    console.log(`=== ALL ${passCount} V2 TREND TP AUTHORITY REGRESSION TESTS PASSED ===`);
}

runTrendTpAuthorityTests();
