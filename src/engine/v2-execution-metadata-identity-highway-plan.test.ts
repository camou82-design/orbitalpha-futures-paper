/**
 * Regression Test: execution.metadata Object Identity Preservation & Highway Plan Integrity
 *
 * Prevents HIGHWAY_PLAN_MISSING caused by execution.metadata reference replacement:
 * 1. RANGE executor produces initial signal=NONE without pre-set TP.
 * 2. FAST_TREND_SHIFT promotion promotes to ENTER.
 * 3. ensurePromotedEntryRiskPlan executes without replacing execution.metadata object identity.
 * 4. Canonical TP authority writes takeProfit1Px / executableTp1Price to execMeta.
 * 5. Final Highway gate reads the same execution.metadata containing valid TP1.
 * 6. tp1DistancePct > 0, rewardRisk > 0, HIGHWAY_PLAN_MISSING is NOT triggered.
 *
 * Covers LONG and SHORT directions, plus direct object identity assertions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
    runEngineV2,
    ensurePromotedEntryRiskPlan
} from "../engine-v2/index";
import { evaluateHighwayCoreEntryGate } from "../engine-v2/highway-core/highway-entry-gate";
import type { ExecutorOutput, EngineV2Input } from "../engine-v2/types";

function buildMinimalCandles(basePrice: number, count: number = 30) {
    const candles: any[] = [];
    const now = Date.now();
    for (let i = count; i >= 1; i--) {
        const ts = now - i * 5 * 60 * 1000;
        candles.push({
            timestamp: ts,
            time: ts,
            open: basePrice - 10,
            high: basePrice + 15,
            low: basePrice - 15,
            close: basePrice,
            volume: 100
        });
    }
    return candles;
}

test("execution.metadata object identity preservation in ensurePromotedEntryRiskPlan", async (t) => {
    await t.test("1. Patch path: ensurePromotedEntryRiskPlan preserves execution.metadata identity when injecting fallback stop", () => {
        const originalMetadata: Record<string, any> = { initialKey: "initialValue" };
        const execution: ExecutorOutput = {
            signal: "LONG_CANDIDATE",
            side: "long",
            reason: "TEST_PROMOTION",
            baseSizeIntent: 0.25,
            recheckSuggested: false,
            isAddOnEligible: false,
            stopPrice: null, // missing stop, needs patch
            invalidationPx: null,
            metadata: originalMetadata
        };

        const judgment = {
            regime: "RANGE",
            subtype: "FAST_TREND_SHIFT",
            diagnostics: {}
        } as any;

        const snapshot = {
            symbol: "BTCUSDT",
            lastPrice: 65000,
            atr: 300,
            boxHigh: 66000,
            boxLow: 64000,
            candles: buildMinimalCandles(65000)
        };

        const blockReason = ensurePromotedEntryRiskPlan(
            execution,
            "ENTER",
            "long",
            null,
            snapshot,
            judgment,
            "FAST_TREND_SHIFT_PROMOTION"
        );

        assert.equal(blockReason, null, "Should pass risk audit");
        assert.strictEqual(execution.metadata, originalMetadata, "execution.metadata object identity MUST be preserved");
        assert.equal(execution.metadata?.promotedRiskPlanInjected, true);
        assert.equal(execution.metadata?.initialKey, "initialValue");
    });

    await t.test("2. FTS canonical path: ensurePromotedEntryRiskPlan preserves execution.metadata identity for FTS canonical stop", () => {
        const originalMetadata: Record<string, any> = { ftsBase: true };
        const candles = buildMinimalCandles(65000);
        const execution: ExecutorOutput = {
            signal: "SHORT_CANDIDATE",
            side: "short",
            reason: "FTS_SHORT",
            baseSizeIntent: 0.32,
            recheckSuggested: false,
            isAddOnEligible: false,
            stopPrice: 65500,
            invalidationPx: 65500,
            metadata: originalMetadata
        };

        const judgment = {
            regime: "RANGE",
            subtype: "FAST_TREND_SHIFT",
            diagnostics: {
                fastTrendShift: {
                    active: true,
                    direction: "short",
                    confirmed: true,
                    structuralStopCandidate: 65500
                }
            }
        } as any;

        const snapshot = {
            symbol: "BTCUSDT",
            lastPrice: 65000,
            atr: 300,
            boxHigh: 66000,
            boxLow: 64000,
            candles
        };

        const blockReason = ensurePromotedEntryRiskPlan(
            execution,
            "ENTER",
            "short",
            null,
            snapshot,
            judgment,
            "FAST_TREND_SHIFT"
        );

        assert.equal(blockReason, null);
        assert.strictEqual(execution.metadata, originalMetadata, "execution.metadata object identity MUST be preserved");
        assert.equal(execution.metadata?.ftsBase, true);
    });
});

test("E2E Highway Gate: Object identity enables valid TP delivery and avoids HIGHWAY_PLAN_MISSING", async (t) => {
    await t.test("1. LONG side: ensurePromotedEntryRiskPlan -> TP authority -> Final Highway Gate reads same metadata", () => {
        const execMetadata: Record<string, any> = {};
        const execution: ExecutorOutput = {
            signal: "LONG_CANDIDATE",
            side: "long",
            reason: "RANGE_PROMOTED_LONG",
            baseSizeIntent: 0.25,
            recheckSuggested: false,
            isAddOnEligible: false,
            stopPrice: null, // initially null
            invalidationPx: null,
            metadata: execMetadata
        };

        const snapshot = {
            symbol: "BTCUSDT",
            lastPrice: 65000,
            atr: 400,
            boxHigh: 66500,
            boxLow: 64500,
            candles: buildMinimalCandles(65000)
        };

        const judgment = {
            regime: "RANGE",
            subtype: "FAST_TREND_SHIFT",
            diagnostics: {}
        } as any;

        // Step 1: ensurePromotedEntryRiskPlan runs and injects stop without changing metadata reference
        const auditBlock = ensurePromotedEntryRiskPlan(
            execution,
            "ENTER",
            "long",
            null,
            snapshot,
            judgment,
            "FAST_TREND_SHIFT_PROMOTION"
        );
        assert.equal(auditBlock, null);
        assert.strictEqual(execution.metadata, execMetadata, "Identity must match before TP write");

        // Step 2: Canonical TP authority writes to execMeta (the captured reference)
        const execMeta = execution.metadata as Record<string, any>;
        const tpPrice = 66200; // +1.84% > cost, RR > 1.2
        execMeta.takeProfit1Px = tpPrice;
        execMeta.executableTp1Price = tpPrice;
        execMeta.rawCanonicalTp1Price = tpPrice;
        execMeta.takeProfitPlan = { tp1: tpPrice, executableTp1: tpPrice };
        execMeta.profitabilityTpApproved = true;

        // Step 3: Final Highway Gate evaluates execution directly
        const highwayResult = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "FAST_TREND_SHIFT",
            snapshot: {
                ...snapshot,
                boxPos: 0.25
            },
            execution,
            committedRiskPlan: null,
            isPreCheck: false
        });

        assert.equal(highwayResult.allowed, true, "Highway gate must allow entry");
        assert.equal(highwayResult.finalDecision, "ENTER");
        assert.notEqual(highwayResult.rejectReason, "HIGHWAY_PLAN_MISSING", "Must NOT be HIGHWAY_PLAN_MISSING");
        assert.ok(highwayResult.tp1DistancePct > 0, `tp1DistancePct must be > 0 (got ${highwayResult.tp1DistancePct})`);
        assert.ok(highwayResult.stopDistancePct > 0, `stopDistancePct must be > 0 (got ${highwayResult.stopDistancePct})`);
        assert.ok(highwayResult.rewardRisk > 0, `rewardRisk must be > 0 (got ${highwayResult.rewardRisk})`);
    });

    await t.test("2. SHORT side: ensurePromotedEntryRiskPlan -> TP authority -> Final Highway Gate reads same metadata", () => {
        const execMetadata: Record<string, any> = {};
        const execution: ExecutorOutput = {
            signal: "SHORT_CANDIDATE",
            side: "short",
            reason: "RANGE_PROMOTED_SHORT",
            baseSizeIntent: 0.25,
            recheckSuggested: false,
            isAddOnEligible: false,
            stopPrice: null, // initially null
            invalidationPx: null,
            metadata: execMetadata
        };

        const snapshot = {
            symbol: "ETHUSDT",
            lastPrice: 2500,
            atr: 60,
            boxHigh: 2550,
            boxLow: 2350,
            candles: buildMinimalCandles(2500)
        };

        const judgment = {
            regime: "RANGE",
            subtype: "FAST_TREND_SHIFT",
            diagnostics: {}
        } as any;

        // Step 1: ensurePromotedEntryRiskPlan runs and injects stop without changing metadata reference
        const auditBlock = ensurePromotedEntryRiskPlan(
            execution,
            "ENTER",
            "short",
            null,
            snapshot,
            judgment,
            "FAST_TREND_SHIFT_PROMOTION"
        );
        assert.equal(auditBlock, null);
        assert.strictEqual(execution.metadata, execMetadata, "Identity must match before TP write");

        // Step 2: Canonical TP authority writes to execMeta
        const execMeta = execution.metadata as Record<string, any>;
        const tpPrice = 2395; // -4.2% (short TP below entry), RR = 105 / 70 = 1.5 >= 1.2
        execMeta.takeProfit1Px = tpPrice;
        execMeta.executableTp1Price = tpPrice;
        execMeta.rawCanonicalTp1Price = tpPrice;
        execMeta.takeProfitPlan = { tp1: tpPrice, executableTp1: tpPrice };
        execMeta.profitabilityTpApproved = true;

        // Step 3: Final Highway Gate evaluates execution directly
        const highwayResult = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            subtype: "FAST_TREND_SHIFT",
            snapshot: {
                ...snapshot,
                boxPos: 0.75
            },
            execution,
            committedRiskPlan: null,
            isPreCheck: false
        });

        assert.equal(highwayResult.allowed, true, "Highway gate must allow entry");
        assert.equal(highwayResult.finalDecision, "ENTER");
        assert.notEqual(highwayResult.rejectReason, "HIGHWAY_PLAN_MISSING", "Must NOT be HIGHWAY_PLAN_MISSING");
        assert.ok(highwayResult.tp1DistancePct > 0, `tp1DistancePct must be > 0 (got ${highwayResult.tp1DistancePct})`);
        assert.ok(highwayResult.stopDistancePct > 0, `stopDistancePct must be > 0 (got ${highwayResult.stopDistancePct})`);
        assert.ok(highwayResult.rewardRisk > 0, `rewardRisk must be > 0 (got ${highwayResult.rewardRisk})`);
    });
});
