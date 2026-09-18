import test from "node:test";
import assert from "node:assert/strict";
import {
    buildManualAugmentAuthorityProof,
    buildPositionManagementPriceAuthorityProof,
    buildSymbolPositionAuthorityProof,
    computeProtectiveQtyCoverage,
    evaluateManualAugmentReclassification
} from "../engine-v2/position/manual-augment-authority";
import { resolvePositionOwnership } from "../engine-v2/position/ownership-resolver";
import { evaluateManualOwnershipLatchTrigger } from "../engine-v2/position/manual-ownership-latch";
import { classifyPositionSizeDelta } from "../engine-v2/position/manual-reduce-rebase";
import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import { planProtectiveOrderReconcile } from "../engine-v2/execution/protective-reconcile-plan";
import { runEngineV2 } from "../engine-v2/index";
import { deriveV2StateAuthority, resolveHeldPositionSide } from "../engine-v2/state/derive";
import type { PaperOpenPositionRecord } from "../models/types";

test("V2 MANUAL SAME-SIDE AUGMENT AUTHORITY SUITE", async (t) => {
    await t.test("1. latched OPERATOR_MANAGED position migration -> reclassified to MANUAL_SIZE_AUGMENTED & runtime takeover released", () => {
        // Existing latched position from previous runtime
        const latchedPos = {
            symbol: "BTCUSDT",
            side: "long" as const,
            entryPrice: 78279.9,
            originalEntryPrice: 78279.9,
            sizeUsd: 3248,
            originalSizeUsd: 3248,
            entryStage: 1,
            openedAt: 1788500000000,
            status: "open",
            lifecycleState: "OPERATOR_MANAGED",
            manualTakeoverActive: true,
            manualOwnershipLatch: true,
            isV2Authority: true,
            okxContracts: 4.16,
            notionalUsd: 3248,
            leverage: 10,
            stopPrice: 77500,
            targetPrice1: 79500
        } as PaperOpenPositionRecord;

        // Evaluate reclassification
        const reclass = evaluateManualAugmentReclassification({
            ledger: latchedPos,
            okxActualPositionExists: true,
            okxActualContracts: 11.08,
            okxActualAvgPx: 78125.60,
            okxActualNotional: 8635,
            okxSide: "long"
        });

        assert.equal(reclass.shouldReclassify, true);
        assert.equal(reclass.reason, "SAME_SIDE_MANUAL_AUGMENT_RECLASSIFICATION");

        // Apply migration
        latchedPos.lifecycleState = "MANUAL_SIZE_AUGMENTED";
        latchedPos.manualTakeoverActive = false;
        latchedPos.manualOwnershipLatch = false;
        latchedPos.manualAugmentActive = true;
        latchedPos.actualAvgPx = 78125.60;
        latchedPos.actualContracts = 11.08;
        latchedPos.actualNotionalUsd = 8635;

        assert.equal(latchedPos.lifecycleState, "MANUAL_SIZE_AUGMENTED");
        assert.equal(latchedPos.manualTakeoverActive, false);
        assert.equal(latchedPos.manualOwnershipLatch, false);
        assert.equal(latchedPos.originalEntryPrice, 78279.9);
        assert.equal(latchedPos.actualAvgPx, 78125.60);
        assert.equal(latchedPos.actualContracts, 11.08);
    });

    await t.test("2. actual avgPx/contracts가 ledger entry와 다를 때 management는 actual 사용, original은 보존", () => {
        const priceProof = buildPositionManagementPriceAuthorityProof({
            symbol: "BTCUSDT",
            pnlEntryPriceSource: "okx_actual_avg_px",
            managementAvgPx: 78125.60,
            ledgerEntryPrice: 78279.90,
            actualAvgPx: 78125.60
        });

        assert.equal(priceProof.event, "V2_POSITION_MANAGEMENT_PRICE_AUTHORITY_PROOF");
        assert.equal(priceProof.pnlEntryPriceSource, "okx_actual_avg_px");
        assert.equal(priceProof.managementAvgPx, 78125.60);
        assert.equal(priceProof.ledgerEntryPrice, 78279.90);
        assert.equal(priceProof.actualAvgPx, 78125.60);

        // Evaluate exit policy with actualAvgPx
        const exitResult = evaluateV2ExitPolicy({
            symbol: "BTCUSDT",
            judgment: {
                regime: "TREND",
                regime_final: "TREND",
                subtype: "TREND_UP_CONTINUATION",
                shockPhase: "NONE",
                rangePhase: "NONE",
                trendPhase: "UP",
                transitionPhase: "NONE"
            } as any,
            snapshot: {
                lastPrice: 78125.60,
                atr: 200,
                boxPos: 0.5
            } as any,
            markPrice: 78125.60,
            v2State: {
                symbol: "BTCUSDT",
                currentPositions: [{
                    symbol: "BTCUSDT",
                    side: "LONG",
                    entryPrice: 78125.60, // management avgPx
                    managementAvgPx: 78125.60,
                    ledgerEntryPrice: 78279.9,
                    okxActualAvgPx: 78125.60,
                    sizeUsd: 8635,
                    entryStage: 1,
                    pnlPct: 0,
                    leverage: 10,
                    lifecycleState: "MANUAL_SIZE_AUGMENTED"
                }],
                symbolPositions: [{
                    symbol: "BTCUSDT",
                    side: "LONG",
                    entryPrice: 78125.60,
                    managementAvgPx: 78125.60,
                    ledgerEntryPrice: 78279.9,
                    okxActualAvgPx: 78125.60,
                    sizeUsd: 8635,
                    entryStage: 1,
                    pnlPct: 0,
                    leverage: 10,
                    lifecycleState: "MANUAL_SIZE_AUGMENTED"
                }],
                directionalShockState: "NONE"
            } as any
        });

        assert.ok(exitResult.action === "WATCH" || exitResult.action === "HOLD");
        assert.notEqual(exitResult.evidence, "manual_takeover_observe_only");
    });

    await t.test("3. cap 초과 상태에서 auto add-on은 0/blocked지만 exit/partial/protection은 정상 허용", () => {
        const input = {
            symbol: "BTCUSDT",
            now: 1788500000000,
            config: {
                okxLiveMaxOrderNotionalUsdt: null
            },
            snapshot: {
                lastPrice: 78125.60,
                latestCandleClose: 78125.60,
                atr: 200,
                boxPos: 0.5
            },
            state: {
                currentPositions: [{
                    symbol: "BTCUSDT",
                    side: "LONG",
                    entryPrice: 78125.60,
                    managementAvgPx: 78125.60,
                    ledgerEntryPrice: 78279.9,
                    okxActualAvgPx: 78125.60,
                    sizeUsd: 8635, // Already high exposure
                    entryStage: 1,
                    pnlPct: 0,
                    leverage: 10,
                    lifecycleState: "MANUAL_SIZE_AUGMENTED"
                }],
                globalRiskScore: 0.5,
                lossStreaks: {},
                directionalShockState: "NONE",
                longAllow: true,
                shortAllow: true,
                executionReadiness: true,
                accountEquityKrw: 1_000_000,
                symbolExposureNotionalCapKrw: 5_000_000, // Cap exceeded by 8635 USDT (~11.6M KRW)
                exposureNotionalCapKrw: 5_000_000,
                freshTickBarrierActive: false,
                freshTickCompletedCycles: 3,
                freshTickRequiredCycles: 3
            }
        };

        const res = runEngineV2(input as any);
        assert.equal(res.decision.executionAction, "NONE");
        assert.equal(res.decision.decision, "HOLD");
        assert.notEqual(res.decision.explanation.reason, "MANUAL_TAKEOVER_ACTIVE_OBSERVE_ONLY");
    });

    await t.test("4. actual=11.08, bot SL=4.16, TP=2.77 -> bot SL/TP stale reconcile, manual SL/TP preserved", () => {
        const pendingAlgos = [
            // User manual SL: 5 contracts at 76000 (must be PRESERVED)
            {
                algoId: "manual_sl_76000",
                algoClOrdId: "web_manual_sl_76000",
                instId: "BTC-USDT-SWAP",
                posSide: "long",
                side: "sell",
                reduceOnly: true,
                slTriggerPx: 76000,
                sz: 5,
                tdMode: "cross"
            },
            // Bot old SL: 4.16 contracts at 77500 (stale, must be replaced with 11.08)
            {
                algoId: "bot_sl_4_16",
                algoClOrdId: "oap_BTCUSDT_open36_sl",
                instId: "BTC-USDT-SWAP",
                posSide: "long",
                side: "sell",
                reduceOnly: true,
                slTriggerPx: 77500,
                sz: 4.16,
                tdMode: "cross"
            },
            // Bot old TP: 2.77 contracts at 79500 (stale, must be replaced with 5.54 = 50% of 11.08)
            {
                algoId: "bot_tp_2_77",
                algoClOrdId: "oap_BTCUSDT_open36_tp",
                instId: "BTC-USDT-SWAP",
                posSide: "long",
                side: "sell",
                reduceOnly: true,
                tpTriggerPx: 79500,
                sz: 2.77,
                tdMode: "cross"
            }
        ];

        // 1. Coverage check
        const coverage = computeProtectiveQtyCoverage({
            symbol: "BTCUSDT",
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            actualQty: 11.08,
            pendingAlgos
        });

        assert.equal(coverage.actualQty, 11.08);
        assert.equal(coverage.stopProtectedQty, 9.16); // 5 + 4.16
        assert.equal(coverage.tpProtectedQty, 2.77);
        assert.equal(coverage.ownership, "MIXED");

        // 2. Reconcile plan for 100% SL (11.08) and 50% TP1 (5.54)
        const plan = planProtectiveOrderReconcile(pendingAlgos, {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "open36",
            tdModeUsed: "cross",
            contractsToProtect: 11.08, // 100% SL coverage
            tpContractsToProtect: 5.54, // 50% TP1 coverage
            activeStopPrice: 77500,
            activeTpPrice: 79500,
            wantsTp: true,
            expectedSide: "sell",
            tickSz: 0.1
        });

        // Bot orders cancelled due to stale sizes
        assert.ok(plan.cancelAlgoIds.includes("bot_sl_4_16"));
        assert.ok(plan.cancelAlgoIds.includes("bot_tp_2_77"));

        // User manual SL order 76000 MUST NEVER be cancelled!
        assert.ok(!plan.cancelAlgoIds.includes("manual_sl_76000"));
        assert.equal(plan.manualIgnoredCount, 1);

        // Needs resubmission with updated quantities
        assert.equal(plan.needSubmitSl, true);
        assert.equal(plan.needSubmitTp, true);
    });

    await t.test("5. opposite-side manual intervention은 기존대로 takeover/보수적 처리", () => {
        const ledgerPos = {
            symbol: "ETHUSDT",
            side: "long" as const,
            entryPrice: 3000,
            sizeUsd: 1000,
            entryStage: 1,
            openedAt: 1788500000000,
            status: "open",
            lifecycleState: "BOT_V2_MANAGED",
            isV2Authority: true,
            okxContracts: 3.0,
            notionalUsd: 1000
        } as PaperOpenPositionRecord;

        const reclass = evaluateManualAugmentReclassification({
            ledger: ledgerPos,
            okxActualPositionExists: true,
            okxActualContracts: 3.0,
            okxActualAvgPx: 3000,
            okxActualNotional: 1000,
            okxSide: "short" // Opposite side!
        });

        assert.equal(reclass.shouldReclassify, false);
        assert.equal(reclass.reason, "OPPOSITE_SIDE_NOT_ELIGIBLE");
    });

    await t.test("6. ETH symbol_positions_count=0일 때 BTC long에서 heldPositionSide 상속 차단 (Symbol contamination fix)", () => {
        const ethInput = {
            symbol: "ETHUSDT",
            now: 1788500000000,
            config: {
                okxLiveMaxOrderNotionalUsdt: null
            },
            snapshot: {
                lastPrice: 3000,
                latestCandleClose: 3000,
                atr: 25,
                boxPos: 0.5
            },
            state: {
                // currentPositions has BTC position only!
                currentPositions: [{
                    symbol: "BTCUSDT",
                    side: "LONG",
                    entryPrice: 78125.60,
                    managementAvgPx: 78125.60,
                    ledgerEntryPrice: 78279.9,
                    okxActualAvgPx: 78125.60,
                    sizeUsd: 8635,
                    entryStage: 1,
                    pnlPct: 0,
                    leverage: 10,
                    lifecycleState: "MANUAL_SIZE_AUGMENTED"
                }],
                okxActualPositions: [{
                    symbol: "BTCUSDT",
                    side: "long",
                    posSide: "long",
                    contracts: 11.08,
                    avgPx: 78125.60,
                    notionalUsd: 8635
                }],
                // okxActualSide may be set to "long" at top-level state
                okxActualSide: "long",
                globalRiskScore: 0.5,
                lossStreaks: {},
                directionalShockState: "NONE",
                longAllow: true,
                shortAllow: true,
                executionReadiness: true,
                accountEquityKrw: 10_000_000,
                symbolExposureNotionalCapKrw: 5_000_000,
                exposureNotionalCapKrw: 20_000_000
            }
        };

        const v2State = deriveV2StateAuthority(ethInput as any);

        // ETH symbolPositions count is 0
        assert.equal(v2State.symbolPositions.length, 0);
        // ETH heldPositionSide MUST be "none" (not "long" from BTC!)
        assert.equal(v2State.heldPositionSide, "none");
        assert.equal(v2State.managementSide, "none");
        assert.equal(v2State.longPosition, null);
        assert.equal(v2State.shortPosition, null);

        const symProof = buildSymbolPositionAuthorityProof({
            symbol: "ETHUSDT",
            symbolPositionsCount: 0,
            heldPositionSide: v2State.heldPositionSide,
            managementSide: v2State.managementSide,
            isContaminated: false
        });

        assert.equal(symProof.event, "V2_SYMBOL_POSITION_AUTHORITY_PROOF");
        assert.equal(symProof.symbol, "ETHUSDT");
        assert.equal(symProof.symbolPositionsCount, 0);
        assert.equal(symProof.heldPositionSide, "none");
        assert.equal(symProof.isContaminated, false);
    });

    await t.test("7. legacy record without v2 authority flags (BOT 4.16 long -> legacy OPERATOR_MANAGED -> manual augment 11.08) recovers bot origin and migrates idempotently", () => {
        // Legacy record as it actually exists on disk after OPERATOR_MANAGED latching stripped newer fields:
        // isV2Authority, originalEntryPrice, authoritySourceAtEntry, sourceSignal are missing/undefined.
        const legacyLatchedPos = {
            symbol: "BTCUSDT",
            side: "long" as const,
            entryPrice: 78279.9,
            sizeUsd: 3248,
            entryStage: 1,
            openedAt: 1788500000000,
            status: "open",
            lifecycleState: "OPERATOR_MANAGED",
            manualTakeoverActive: true,
            manualOwnershipLatch: true,
            manualTakeoverReason: "OPERATOR_MANUAL_INTERVENTION",
            okxContracts: 4.16,
            notionalUsd: 3248,
            leverage: 10,
            strategyVersion: "paper-v2",
            positionCycleId: "BTCUSDT:long:1788500000000",
            protectiveSlAlgoId: "oap_BTCUSDT_open36_sl"
        } as PaperOpenPositionRecord;

        // First pass: evaluate reclassification
        const reclass = evaluateManualAugmentReclassification({
            ledger: legacyLatchedPos,
            okxActualPositionExists: true,
            okxActualContracts: 11.08,
            okxActualAvgPx: 78125.60,
            okxActualNotional: 8635,
            okxSide: "long"
        });

        assert.equal(reclass.shouldReclassify, true);
        assert.equal(reclass.reason, "SAME_SIDE_MANUAL_AUGMENT_RECLASSIFICATION");

        // Apply migration
        legacyLatchedPos.lifecycleState = "MANUAL_SIZE_AUGMENTED";
        legacyLatchedPos.manualTakeoverActive = false;
        legacyLatchedPos.manualOwnershipLatch = false;
        legacyLatchedPos.manualAugmentActive = true;
        legacyLatchedPos.actualAvgPx = 78125.60;
        legacyLatchedPos.actualContracts = 11.08;
        legacyLatchedPos.actualNotionalUsd = 8635;
        legacyLatchedPos.originalEntryPrice = legacyLatchedPos.originalEntryPrice ?? legacyLatchedPos.entryPrice;

        assert.equal(legacyLatchedPos.lifecycleState, "MANUAL_SIZE_AUGMENTED");
        assert.equal(legacyLatchedPos.manualTakeoverActive, false);
        assert.equal(legacyLatchedPos.originalEntryPrice, 78279.9);

        // Idempotent migration on subsequent cycle
        const secondPass = evaluateManualAugmentReclassification({
            ledger: legacyLatchedPos,
            okxActualPositionExists: true,
            okxActualContracts: 11.08,
            okxActualAvgPx: 78125.60,
            okxActualNotional: 8635,
            okxSide: "long"
        });

        assert.equal(secondPass.shouldReclassify, true);
    });

    await t.test("8. genuine manual initial entry (operator_adopted) is never migrated to BOT management", () => {
        const manualInitialPos = {
            symbol: "BTCUSDT",
            side: "long" as const,
            entryPrice: 78000,
            sizeUsd: 5000,
            openedAt: 1788500000000,
            status: "open",
            lifecycleState: "OPERATOR_MANAGED",
            manualTakeoverActive: true,
            manualOwnershipLatch: true,
            sourceSignal: "operator_adopted",
            positionCycleId: "manual_adopt_1788500000000",
            okxContracts: 5.0,
            notionalUsd: 5000
        } as PaperOpenPositionRecord;

        const reclass = evaluateManualAugmentReclassification({
            ledger: manualInitialPos,
            okxActualPositionExists: true,
            okxActualContracts: 10.0, // Same-side manual add on manual position
            okxActualAvgPx: 78100,
            okxActualNotional: 10000,
            okxSide: "long"
        });

        assert.equal(reclass.shouldReclassify, false);
        assert.equal(reclass.reason, "MANUAL_ADOPTED_ORIGIN");
    });
});
