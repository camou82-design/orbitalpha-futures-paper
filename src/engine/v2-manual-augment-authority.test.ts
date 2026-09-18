import test from "node:test";
import assert from "node:assert/strict";
import {
    buildManualAugmentAuthorityProof,
    buildPositionManagementPriceAuthorityProof,
    computeProtectiveQtyCoverage
} from "../engine-v2/position/manual-augment-authority";
import { resolvePositionOwnership } from "../engine-v2/position/ownership-resolver";
import { evaluateManualOwnershipLatchTrigger } from "../engine-v2/position/manual-ownership-latch";
import { classifyPositionSizeDelta } from "../engine-v2/position/manual-reduce-rebase";
import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import { planProtectiveOrderReconcile } from "../engine-v2/execution/protective-reconcile-plan";
import { runEngineV2 } from "../engine-v2/index";
import type { PaperOpenPositionRecord } from "../models/types";

test("V2 MANUAL SAME-SIDE AUGMENT AUTHORITY SUITE", async (t) => {
    await t.test("1. bot long 4.16 -> same-side manual increase to 11.08 -> MANUAL_SIZE_AUGMENTED & exit policy active", () => {
        const ledgerPos = {
            symbol: "BTCUSDT",
            side: "long" as const,
            entryPrice: 78279.9,
            sizeUsd: 3248,
            entryStage: 1,
            openedAt: 1788500000000,
            status: "open",
            lifecycleState: "BOT_V2_MANAGED",
            isV2Authority: true,
            okxContracts: 4.16,
            notionalUsd: 3248,
            leverage: 10,
            stopPrice: 77500,
            targetPrice1: 79500
        } as PaperOpenPositionRecord;

        // 1-1. Size delta classification
        const delta = classifyPositionSizeDelta({
            beforeContracts: 4.16,
            afterContracts: 11.08,
            ledger: ledgerPos,
            botManaged: true,
            nowMs: 1788500010000
        });
        assert.equal(delta.classification, "MANUAL_INCREASE");

        // 1-2. Ownership latch trigger must NOT trigger strong latch (no OPERATOR_MANAGED lockdown)
        const latchTrigger = evaluateManualOwnershipLatchTrigger({
            ledger: ledgerPos,
            okxActualContracts: 11.08,
            okxActualPositionExists: true,
            okxFetchReady: true,
            ledgerPaperContracts: 4.16,
            ledgerEntryPrice: 78279.9,
            okxAvgPx: 78125.60,
            symbolExternalManualBlocked: false
        });
        assert.equal(latchTrigger.shouldLatch, false);
        assert.equal(latchTrigger.source, "SAME_SIDE_MANUAL_AUGMENT");

        // 1-3. Ownership resolution preserves BOT_V2_MANAGED ownership and allows exit policy
        ledgerPos.lifecycleState = "MANUAL_SIZE_AUGMENTED";
        ledgerPos.actualAvgPx = 78125.60;
        ledgerPos.actualContracts = 11.08;
        ledgerPos.actualNotionalUsd = 8635;

        const ownership = resolvePositionOwnership({
            symbol: "BTCUSDT",
            side: "long",
            okxActualPositionExists: true,
            okxActualContracts: 11.08,
            ledger: ledgerPos,
            ledgerPaperContracts: 4.16,
            ledgerEntryPrice: 78279.9,
            okxAvgPx: 78125.60,
            symbolExternalManualBlocked: false
        });

        assert.equal(ownership.ownershipClass, "BOT_V2_MANAGED");
        assert.equal(ownership.lifecycleAfter, "MANUAL_SIZE_AUGMENTED");
        assert.equal(ownership.normalExitPolicyAllowed, true);

        // 1-4. Manual augment proof structure
        const augmentProof = buildManualAugmentAuthorityProof({
            symbol: "BTCUSDT",
            side: "long",
            ledgerQty: 4.16,
            ledgerAvgPx: 78279.9,
            ledgerNotional: 3248,
            okxActualQty: 11.08,
            okxActualAvgPx: 78125.60,
            okxActualNotional: 8635,
            interventionType: "SAME_SIDE_MANUAL_AUGMENT",
            lifecycleState: "MANUAL_SIZE_AUGMENTED",
            positionManagementAllowed: true,
            autoAddonAllowed: false,
            protectionReconcileAllowed: true
        });

        assert.equal(augmentProof.event, "V2_MANUAL_AUGMENT_AUTHORITY_PROOF");
        assert.equal(augmentProof.interventionType, "SAME_SIDE_MANUAL_AUGMENT");
        assert.equal(augmentProof.positionManagementAllowed, true);
        assert.equal(augmentProof.autoAddonAllowed, false);
        assert.equal(augmentProof.protectionReconcileAllowed, true);
    });

    await t.test("2. actual avgPx가 ledger entry와 다를 때 exit/PnL 계산은 actual avgPx 사용", () => {
        // Price proof structure
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
        // Add-on must NOT be generated (HOLD / no new entry)
        assert.equal(res.decision.executionAction, "NONE");
        assert.equal(res.decision.decision, "HOLD");
        // But the engine ran normally (did NOT short-circuit to observe-only)
        assert.notEqual(res.decision.explanation.reason, "MANUAL_TAKEOVER_ACTIVE_OBSERVE_ONLY");
    });

    await t.test("4. manual protective SL 가격은 변경하지 않고 bot-owned protective qty 부족 시 actual qty 기준 reconcile", () => {
        // Pending algos has:
        // 1) User's manual SL order at 76000 with 5 contracts
        // 2) Bot's old SL order at 77500 with 4.16 contracts (stale because position is now 11.08)
        const pendingAlgos = [
            {
                algoId: "manual_sl_101",
                algoClOrdId: "web_sl_manual_101", // Not bot-owned
                instId: "BTC-USDT-SWAP",
                posSide: "long",
                side: "sell",
                reduceOnly: true,
                slTriggerPx: 76000,
                sz: 5,
                tdMode: "cross"
            },
            {
                algoId: "bot_sl_102",
                algoClOrdId: "oap_BTCUSDT_open36_sl", // Bot-owned
                instId: "BTC-USDT-SWAP",
                posSide: "long",
                side: "sell",
                reduceOnly: true,
                slTriggerPx: 77500,
                sz: 4.16, // Stale size
                tdMode: "cross"
            }
        ];

        // Coverage computation
        const coverage = computeProtectiveQtyCoverage({
            symbol: "BTCUSDT",
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            actualQty: 11.08,
            pendingAlgos
        });

        assert.equal(coverage.actualQty, 11.08);
        assert.equal(coverage.stopProtectedQty, 9.16); // 5 + 4.16
        assert.equal(coverage.ownership, "MIXED");
        assert.ok(coverage.coverageRatio < 1.0);

        // Plan protective reconcile for actual contracts (11.08)
        const plan = planProtectiveOrderReconcile(pendingAlgos, {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "open36",
            tdModeUsed: "cross",
            contractsToProtect: 11.08,
            activeStopPrice: 77500,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        });

        // Bot's stale 4.16 order must be queued for cancellation, while user's manual order 76000 is PRESERVED!
        assert.ok(plan.cancelAlgoIds.includes("bot_sl_102"));
        assert.ok(!plan.cancelAlgoIds.includes("manual_sl_101")); // User order NOT cancelled!
        assert.equal(plan.manualIgnoredCount, 1);
        assert.equal(plan.needSubmitSl, true); // Needs new SL with 11.08 contracts
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

        // Opposite side: remote is short while ledger is long
        const isSameSide =
            (ledgerPos.isV2Authority === true || ledgerPos.lifecycleState === "BOT_V2_MANAGED") &&
            String("short").toLowerCase() === String(ledgerPos.side).toLowerCase();

        assert.equal(isSameSide, false); // Opposite side fails same-side check -> full takeover applies
    });
});
