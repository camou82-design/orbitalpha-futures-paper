import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    applyEthRangeMinimumStopDistance,
    ETH_RANGE_MIN_STOP_DISTANCE_PCT,
    resolveEthRangeAwareProtectiveStopPrice
} from "../engine-v2/execution/eth-range-minimum-stop-authority";
import { engineMirrorStopPrice, resolveProtectiveStopPrice } from "./position-ops-monitor";
import { buildV2PreEntryRiskPlanCommitted } from "./paper-engine";
import { evaluateEquityAdaptiveSizing } from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { ACCOUNT_TOTAL_OPEN_RISK_HARD_CAP_PCT } from "../engine-v2/risk-sizing/account-open-risk";
import type { EntryExecutionAuthority } from "../engine-v2/types";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function ethRangeAuthority(overrides: Partial<EntryExecutionAuthority> = {}): EntryExecutionAuthority {
    return {
        decision: "ENTER",
        side: "long",
        stageMarginKrw: 100000,
        regime: "RANGE",
        source: "v2",
        invalidationPx: 2496,
        stopPrice: 2496,
        takeProfit1Px: 2510,
        marketSubtype: "RANGE_FLAT",
        rangeBoxHighAtEntry: 2520,
        rangeBoxLowAtEntry: 2494,
        rangeBoxMidAtEntry: 2507,
        ...overrides
    };
}

describe("ETH RANGE Canonical 0.50% Stop Authority", () => {
    it("1. ETH RANGE long tight structural -> exactly >= 0.50%", () => {
        const entry = 2500;
        const result = applyEthRangeMinimumStopDistance({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "long",
            entryReferencePrice: entry,
            candidateStopPrice: 2496
        });
        assert.equal(result.floorApplied, true);
        assert.ok(result.canonicalStopPrice <= entry * 0.995 + 1e-9);
        assert.ok(Math.abs(result.canonicalStopPrice - 2487.5) < 0.01);
        const distPct = (entry - result.canonicalStopPrice) / entry;
        assert.ok(distPct >= 0.005 - 1e-9);
    });

    it("2. ETH RANGE short tight structural -> exactly >= 0.50%", () => {
        const entry = 2500;
        const result = applyEthRangeMinimumStopDistance({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "short",
            entryReferencePrice: entry,
            candidateStopPrice: 2504
        });
        assert.equal(result.floorApplied, true);
        assert.ok(result.canonicalStopPrice >= entry * 1.005 - 1e-9);
        assert.ok(Math.abs(result.canonicalStopPrice - 2512.5) < 0.01);
    });

    it("3. ETH RANGE long structural 0.80% -> preserved", () => {
        const entry = 2500;
        const structural = 2480;
        const result = applyEthRangeMinimumStopDistance({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "long",
            entryReferencePrice: entry,
            candidateStopPrice: structural
        });
        assert.equal(result.floorApplied, false);
        assert.equal(result.canonicalStopPrice, structural);
    });

    it("4. ETH RANGE short structural 0.80% -> preserved", () => {
        const entry = 2500;
        const structural = 2520;
        const result = applyEthRangeMinimumStopDistance({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "short",
            entryReferencePrice: entry,
            candidateStopPrice: structural
        });
        assert.equal(result.floorApplied, false);
        assert.equal(result.canonicalStopPrice, structural);
    });

    it("5. sizing receives same canonical 0.50% stop as committed plan", () => {
        const entry = 2500;
        const canonicalStop = applyEthRangeMinimumStopDistance({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "long",
            entryReferencePrice: entry,
            candidateStopPrice: 2496
        }).canonicalStopPrice;

        const authority = ethRangeAuthority({ invalidationPx: 2496, stopPrice: 2496, side: "long" });
        const rp = buildV2PreEntryRiskPlanCommitted(
            authority,
            {},
            "long",
            entry,
            noopLogger,
            "ETHUSDT",
            { atr: 3.5, boxHigh: 2520, boxLow: 2494, boxMid: 2507, marketSubtype: "RANGE_FLAT", routingEngine: "RANGE", feeRate: 0.0005 }
        );
        assert.equal(rp.ok, true);
        if (!rp.ok) throw new Error("expected ok");

        const sizing = evaluateEquityAdaptiveSizing({
            symbol: "ETHUSDT",
            side: "long",
            orderKind: "ENTRY",
            accountEquityUsdt: 4000,
            availableBalanceUsdt: 4000,
            entryReferencePrice: entry,
            effectiveStopPrice: canonicalStop,
            appliedLeverage: 10,
            entryQualityGrade: "B",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            lastPrice: entry,
            v2AuthorityEntry: true
        });

        assert.ok(sizing.sizingPassed);
        assert.ok(Math.abs(rp.plan.stop_price - canonicalStop) < 0.01);
        assert.ok(Math.abs(sizing.stopDistancePct - (entry - canonicalStop) / entry) < 1e-6);
    });

    it("6. widening 0.26% -> 0.50% reduces notional for same risk budget", () => {
        const entry = 2500;
        const stop026 = entry * (1 - 0.0026);
        const stop050 = applyEthRangeMinimumStopDistance({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "long",
            entryReferencePrice: entry,
            candidateStopPrice: stop026
        }).canonicalStopPrice;

        const baseInput = {
            symbol: "ETHUSDT" as const,
            side: "long" as const,
            orderKind: "ENTRY" as const,
            accountEquityUsdt: 4000,
            availableBalanceUsdt: 4000,
            entryReferencePrice: entry,
            appliedLeverage: 10,
            entryQualityGrade: "B" as const,
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            lastPrice: entry,
            v2AuthorityEntry: true
        };

        const sizing026 = evaluateEquityAdaptiveSizing({ ...baseInput, effectiveStopPrice: stop026 });
        const sizing050 = evaluateEquityAdaptiveSizing({ ...baseInput, effectiveStopPrice: stop050 });
        assert.ok(sizing026.sizingPassed && sizing050.sizingPassed);
        assert.ok(sizing050.finalOrderNotionalUsdt < sizing026.finalOrderNotionalUsdt);
    });

    it("7. account open-risk cap remains <= 2.5%", () => {
        assert.equal(ACCOUNT_TOTAL_OPEN_RISK_HARD_CAP_PCT, 0.025);
        const entry = 2500;
        const stop = applyEthRangeMinimumStopDistance({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "long",
            entryReferencePrice: entry,
            candidateStopPrice: 2496
        }).canonicalStopPrice;
        const sizing = evaluateEquityAdaptiveSizing({
            symbol: "ETHUSDT",
            side: "long",
            orderKind: "ENTRY",
            accountEquityUsdt: 4000,
            availableBalanceUsdt: 4000,
            entryReferencePrice: entry,
            effectiveStopPrice: stop,
            appliedLeverage: 10,
            entryQualityGrade: "B",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            existingAccountOpenRiskUsdt: 0,
            lastPrice: entry,
            v2AuthorityEntry: true
        });
        assert.ok(sizing.sizingPassed);
        assert.ok((sizing.actualRiskPct ?? 0) <= 0.025 + 1e-6);
    });

    it("8. final committed stop cannot be inward-clamped to 0.26%", () => {
        const entry = 2499.15;
        const authority = ethRangeAuthority({
            side: "long",
            invalidationPx: 2493,
            stopPrice: 2493
        });
        const rp = buildV2PreEntryRiskPlanCommitted(
            authority,
            {},
            "long",
            entry,
            noopLogger,
            "ETHUSDT",
            { atr: 3.5, boxHigh: 2520, boxLow: 2494, boxMid: 2507, marketSubtype: "RANGE_FLAT", routingEngine: "RANGE", feeRate: 0.0005 }
        );
        assert.equal(rp.ok, true);
        if (!rp.ok) throw new Error("expected ok");
        const policy026 = entry * (1 - 0.0026);
        assert.ok(rp.plan.stop_price <= entry * 0.995 + 1e-6);
        assert.ok(rp.plan.stop_price < policy026 - 1e-6);
        assert.notEqual(rp.plan.stop_source, "policy_clamped");
    });

    it("9. OKX submit path uses canonical stop (via committed plan stop_price)", () => {
        const entry = 2500;
        const canonical = applyEthRangeMinimumStopDistance({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "long",
            entryReferencePrice: entry,
            candidateStopPrice: 2496
        }).canonicalStopPrice;
        const rp = buildV2PreEntryRiskPlanCommitted(
            ethRangeAuthority({ invalidationPx: 2496, stopPrice: 2496 }),
            {},
            "long",
            entry,
            noopLogger,
            "ETHUSDT",
            { atr: 3.5, boxHigh: 2520, boxLow: 2494, boxMid: 2507, marketSubtype: "RANGE_FLAT", routingEngine: "RANGE", feeRate: 0.0005 }
        );
        assert.equal(rp.ok, true);
        if (!rp.ok) throw new Error("expected ok");
        assert.ok(Math.abs(rp.plan.stop_price - canonical) < 0.01);
    });

    it("10. protective repair/rebase uses >= 0.50%", () => {
        const entry = 2499.15;
        const mirror026 = engineMirrorStopPrice(entry, "long", "RANGE")!;
        const repair = resolveProtectiveStopPrice("ETHUSDT", entry, "long", "RANGE", null);
        assert.ok(repair != null);
        assert.ok(repair <= entry * 0.995 + 1e-6);
        assert.ok(repair < mirror026 - 1e-6);
        const repairWithLedger = resolveProtectiveStopPrice("ETHUSDT", entry, "long", "RANGE", 2480);
        assert.equal(repairWithLedger, 2480);
    });

    it("11. BTC RANGE remains existing 0.26% policy behavior", () => {
        const entry = 2500;
        const result = applyEthRangeMinimumStopDistance({
            symbol: "BTCUSDT",
            regime: "RANGE",
            side: "long",
            entryReferencePrice: entry,
            candidateStopPrice: 2496
        });
        assert.equal(result.floorApplied, false);
        assert.equal(result.canonicalStopPrice, 2496);
        const policy = engineMirrorStopPrice(entry, "long", "RANGE")!;
        assert.ok(Math.abs(policy - entry * 0.9974) < 0.01);
    });

    it("12. ETH TREND unchanged (pass-through)", () => {
        const entry = 3500;
        const candidate = 3400;
        const result = applyEthRangeMinimumStopDistance({
            symbol: "ETHUSDT",
            regime: "TREND",
            side: "long",
            entryReferencePrice: entry,
            candidateStopPrice: candidate
        });
        assert.equal(result.canonicalStopPrice, candidate);
        assert.equal(result.floorApplied, false);
    });

    it("13. LONG/SHORT symmetry", () => {
        const entry = 2500;
        const longR = applyEthRangeMinimumStopDistance({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "long",
            entryReferencePrice: entry,
            candidateStopPrice: 2496
        });
        const shortR = applyEthRangeMinimumStopDistance({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "short",
            entryReferencePrice: entry,
            candidateStopPrice: 2504
        });
        const longDist = (entry - longR.canonicalStopPrice) / entry;
        const shortDist = (shortR.canonicalStopPrice - entry) / entry;
        assert.ok(Math.abs(longDist - ETH_RANGE_MIN_STOP_DISTANCE_PCT) < 1e-6);
        assert.ok(Math.abs(shortDist - ETH_RANGE_MIN_STOP_DISTANCE_PCT) < 1e-6);
        assert.ok(Math.abs(longDist - shortDist) < 1e-9);
    });

    it("incident replay: entry 2499.15 floor 2486.65425 beats old 0.26% stop", () => {
        const entry = 2499.15;
        const oldStop = 2492.65221;
        const requiredFloor = entry * 0.995;

        const sizingStop = applyEthRangeMinimumStopDistance({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "long",
            entryReferencePrice: entry,
            candidateStopPrice: 2493
        }).canonicalStopPrice;

        const rp = buildV2PreEntryRiskPlanCommitted(
            ethRangeAuthority({ side: "long", invalidationPx: 2493, stopPrice: 2493 }),
            {},
            "long",
            entry,
            noopLogger,
            "ETHUSDT",
            { atr: 3.5, boxHigh: 2520, boxLow: 2494, boxMid: 2507, marketSubtype: "RANGE_FLAT", routingEngine: "RANGE", feeRate: 0.0005 }
        );
        assert.equal(rp.ok, true);
        if (!rp.ok) throw new Error("expected ok");

        const repairStop = resolveEthRangeAwareProtectiveStopPrice({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "long",
            entryReferencePrice: entry,
            ledgerStopPrice: null,
            mirrorStopPrice: oldStop
        });

        assert.ok(Math.abs(requiredFloor - 2486.65425) < 0.01);
        assert.ok(sizingStop <= requiredFloor + 1e-6);
        assert.ok(rp.plan.stop_price <= requiredFloor + 1e-6);
        assert.ok(repairStop != null && repairStop <= requiredFloor + 1e-6);
        assert.ok(rp.plan.stop_price < oldStop - 1e-6);
    });

    it("15. fresh ETH long missing stop -> 0.50% fallback", () => {
        const entry = 2500;
        const repaired = resolveEthRangeAwareProtectiveStopPrice({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "long",
            entryReferencePrice: entry,
            ledgerStopPrice: null,
            mirrorStopPrice: engineMirrorStopPrice(entry, "long", "RANGE")
        });
        assert.ok(repaired != null);
        assert.ok(Math.abs(repaired! - 2487.5) < 0.01);
    });

    it("16. fresh ETH short missing stop -> 0.50% fallback", () => {
        const entry = 2500;
        const repaired = resolveEthRangeAwareProtectiveStopPrice({
            symbol: "ETHUSDT",
            regime: "RANGE",
            side: "short",
            entryReferencePrice: entry,
            ledgerStopPrice: null,
            mirrorStopPrice: engineMirrorStopPrice(entry, "short", "RANGE")
        });
        assert.ok(repaired != null);
        assert.ok(Math.abs(repaired! - 2512.5) < 0.01);
    });

    it("17. LONG ledger 2495 tightened -> 2495 preserved", () => {
        const entry = 2500;
        const existing = 2495;
        const repaired = resolveProtectiveStopPrice("ETHUSDT", entry, "long", "RANGE", existing);
        assert.equal(repaired, existing);
    });

    it("18. LONG breakeven 2500 -> preserved", () => {
        const entry = 2500;
        const existing = 2500;
        const repaired = resolveProtectiveStopPrice("ETHUSDT", entry, "long", "RANGE", existing);
        assert.equal(repaired, existing);
    });

    it("19. LONG profit-lock 2505 -> preserved", () => {
        const entry = 2500;
        const existing = 2505;
        const repaired = resolveProtectiveStopPrice("ETHUSDT", entry, "long", "RANGE", existing);
        assert.equal(repaired, existing);
    });

    it("20. SHORT tightened symmetry -> 2505 preserved", () => {
        const entry = 2500;
        const existing = 2505;
        const repaired = resolveProtectiveStopPrice("ETHUSDT", entry, "short", "RANGE", existing);
        assert.equal(repaired, existing);
    });

    it("21. SHORT breakeven/profit-lock symmetry", () => {
        const entry = 2500;
        assert.equal(resolveProtectiveStopPrice("ETHUSDT", entry, "short", "RANGE", 2500), 2500);
        assert.equal(resolveProtectiveStopPrice("ETHUSDT", entry, "short", "RANGE", 2495), 2495);
    });

    it("22. TP1 confirmed tightened stop -> preserved", () => {
        const entry = 2500;
        const tp1TightenedStop = 2496;
        const repaired = resolveProtectiveStopPrice("ETHUSDT", entry, "long", "RANGE", tp1TightenedStop);
        assert.equal(repaired, tp1TightenedStop);
    });

    it("23. generic/non-TP partial current stop -> preserved", () => {
        const entry = 2500;
        const partialStageStop = 2492;
        const repaired = resolveProtectiveStopPrice("ETHUSDT", entry, "long", "RANGE", partialStageStop);
        assert.equal(repaired, partialStageStop);
    });

    it("24. wider initial structural ledger stop -> preserved", () => {
        const entry = 2500;
        const widerStructural = 2480;
        const repaired = resolveProtectiveStopPrice("ETHUSDT", entry, "long", "RANGE", widerStructural);
        assert.equal(repaired, widerStructural);
    });

    it("25. operator-owned stop untouched (ledger truth preserved)", () => {
        const entry = 2500;
        const operatorStop = 2490;
        const repaired = resolveProtectiveStopPrice("ETHUSDT", entry, "long", "RANGE", operatorStop);
        assert.equal(repaired, operatorStop);
    });

    it("26. pending reconcile rebase cannot loosen stop", () => {
        const entry = 2500;
        const existingStop = 2495;
        const rebaseStop = resolveProtectiveStopPrice("ETHUSDT", entry, "long", "RANGE", existingStop);
        assert.equal(rebaseStop, existingStop);
        const openStopPrice = rebaseStop;
        assert.equal(openStopPrice, 2495);
    });

    it("27. no ledger/stop truth -> 0.50% initial fallback", () => {
        const entry = 2500;
        const fallback = resolveProtectiveStopPrice("ETHUSDT", entry, "long", "RANGE", null);
        assert.ok(fallback != null);
        assert.ok(Math.abs(fallback! - 2487.5) < 0.01);
        const shortFallback = resolveProtectiveStopPrice("ETHUSDT", entry, "short", "RANGE", undefined);
        assert.ok(shortFallback != null);
        assert.ok(Math.abs(shortFallback! - 2512.5) < 0.01);
    });
});
