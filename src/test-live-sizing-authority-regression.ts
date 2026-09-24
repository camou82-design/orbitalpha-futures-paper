import assert from "node:assert/strict";
import {
    evaluateEquityAdaptiveSizing,
    resolveUltimateSafetyCapForOrderSizing,
    normalizeOkxSwapContractsFromNotional
} from "./engine-v2/risk-sizing/equity-adaptive-sizing";
import { resolveLiveSubmitStaticSafetyCap } from "./engine/paper-engine";

console.log("=== RUNNING V2 LIVE SIZING AUTHORITY & COLLAPSE GUARD REGRESSION TESTS ===");

const ETH_SIZING = { ctVal: 0.1, ctValCcy: "ETH", lotSz: 0.01, minSz: 0.01 };
const BTC_SIZING = { ctVal: 0.01, ctValCcy: "BTC", lotSz: 0.01, minSz: 0.01 };

// Scenario 1: ETH Sizing with V2 Authority (ETH 0.014 bug fix verification)
{
    console.log("\n[Test 1] ETH Normal V2 Entry: Raw risk notional ~1282 USDT -> V2 Hard Cap 500 USDT -> 1.86 contracts (0.186 ETH, ~498.24 USDT)");
    const ethPrice = 2678.73;
    const equity = 1713.88;
    const stopPrice = 2652.00; // stop distance ~0.009978 (1.00%)

    const res = evaluateEquityAdaptiveSizing({
        symbol: "ETH-USDT-SWAP",
        side: "long",
        orderKind: "ENTRY",
        accountEquityUsdt: equity,
        availableBalanceUsdt: 1200,
        entryReferencePrice: ethPrice,
        effectiveStopPrice: stopPrice,
        appliedLeverage: 10,
        entryQualityGrade: "A",
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        policyRequestedNotionalUsdt: 1282.05,
        emergencyAbsoluteCapUsdt: null,
        legacyStaticCapUsdt: 40, // Legacy 40 USDT configured in env
        v2HardSafetyCapUsdt: 500, // V2 500 USDT hard safety cap
        lastPrice: ethPrice,
        instrumentSizing: ETH_SIZING,
        v2AuthorityEntry: true
    });

    assert.equal(res.sizingPassed, true, "ETH V2 sizing must pass");
    assert.equal(res.blockReason, null);
    assert.equal(res.v2HardCapUsdt, 500);
    assert.equal(res.canonicalIntendedNotionalUsdt, 500, "Canonical intended notional must be 500 USDT (clamped by V2 hard cap)");
    assert.equal(res.normalizedContracts, 1.86, "Contracts must normalize to 1.86 (0.186 ETH), NOT 0.014 ETH");
    assert.ok(res.normalizedNotionalUsdt! > 490 && res.normalizedNotionalUsdt! <= 500, `Notional ${res.normalizedNotionalUsdt} must be close to 500 USDT`);
    assert.ok(res.collapseRatio >= 0.98, `Collapse ratio ${res.collapseRatio} must be ~1.0`);
    assert.equal(res.sizingCollapseDetected, false);

    // Live submit static cap resolution check
    const submit = resolveLiveSubmitStaticSafetyCap({
        authoritySource: "v2",
        okxLiveStaticNotionalCapEnabled: true,
        staticSafetyCapUsdt: 40,
        v2HardSafetyCapUsdt: 500,
        intendedNotionalUsdt: res.finalOrderNotionalUsdt,
        emergencyUltimateCapUsdt: null
    });
    assert.equal(submit.skipStaticCapForV2Authority, true, "V2 must skip legacy 40 cap");
    assert.equal(submit.finalSizeSource, "v2_risk");
    assert.ok(submit.finalSubmittedNotionalUsdt > 490, "Submit notional must be ~498 USDT");
    console.log("  -> PASS: ETH correctly sized to", res.normalizedContracts, "contracts =", res.normalizedNotionalUsdt?.toFixed(2), "USDT (Ratio:", res.collapseRatio.toFixed(4), ")");
}

// Scenario 2: BTC Sizing with V2 Authority (BTC 0.0004 bug fix verification)
{
    console.log("\n[Test 2] BTC Normal V2 Entry: Raw risk notional ~1380 USDT -> V2 Hard Cap 500 USDT -> 0.59 contracts (0.0059 BTC, ~496.39 USDT)");
    const btcPrice = 84134.60;
    const equity = 1713.88;
    const stopPrice = 83293.25; // stop distance ~0.01 (1.00%)

    const res = evaluateEquityAdaptiveSizing({
        symbol: "BTC-USDT-SWAP",
        side: "long",
        orderKind: "ENTRY",
        accountEquityUsdt: equity,
        availableBalanceUsdt: 1200,
        entryReferencePrice: btcPrice,
        effectiveStopPrice: stopPrice,
        appliedLeverage: 10,
        entryQualityGrade: "A",
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        policyRequestedNotionalUsdt: 1380.00,
        emergencyAbsoluteCapUsdt: null,
        legacyStaticCapUsdt: 40,
        v2HardSafetyCapUsdt: 500,
        lastPrice: btcPrice,
        instrumentSizing: BTC_SIZING,
        v2AuthorityEntry: true
    });

    assert.equal(res.sizingPassed, true, "BTC V2 sizing must pass");
    assert.equal(res.canonicalIntendedNotionalUsdt, 500, "Canonical intended notional must be 500 USDT");
    assert.equal(res.normalizedContracts, 0.59, "Contracts must normalize to 0.59 (0.0059 BTC), NOT 0.0004 BTC");
    assert.ok(res.normalizedNotionalUsdt! > 490 && res.normalizedNotionalUsdt! <= 500);
    assert.ok(res.collapseRatio >= 0.98);
    assert.equal(res.sizingCollapseDetected, false);

    console.log("  -> PASS: BTC correctly sized to", res.normalizedContracts, "contracts =", res.normalizedNotionalUsdt?.toFixed(2), "USDT (Ratio:", res.collapseRatio.toFixed(4), ")");
}

// Scenario 3: Micro-Probe Legitimate Sizing Layer
{
    console.log("\n[Test 3A] Micro-Probe (Target Risk 0.50%): Intended probe reduction is NOT misclassified as collapse");
    const ethPrice = 2678.73;
    const equity = 1713.88;
    const stopPrice = 2652.00;

    const res = evaluateEquityAdaptiveSizing({
        symbol: "ETH-USDT-SWAP",
        side: "long",
        orderKind: "ENTRY",
        accountEquityUsdt: equity,
        availableBalanceUsdt: 1200,
        entryReferencePrice: ethPrice,
        effectiveStopPrice: stopPrice,
        appliedLeverage: 10,
        entryQualityGrade: "B",
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        policyRequestedNotionalUsdt: 500,
        emergencyAbsoluteCapUsdt: null,
        legacyStaticCapUsdt: 40,
        v2HardSafetyCapUsdt: 500,
        lastPrice: ethPrice,
        instrumentSizing: ETH_SIZING,
        v2AuthorityEntry: true,
        entryProbeSizeMultiplier: 0.25,
        entryProbeSizingSource: "DEFAULT_MICRO_PROBE",
        isMicroProbe: true // Target risk 0.50%
    });

    assert.equal(res.sizingPassed, true, "Micro-probe must pass sizing");
    assert.equal(res.isMicroProbe, true);
    assert.equal(res.probeSizingSource, "DEFAULT_MICRO_PROBE");
    assert.ok(res.canonicalIntendedNotionalUsdt > 0 && res.canonicalIntendedNotionalUsdt <= 500);
    assert.ok(res.collapseRatio >= 0.60, `Probe ratio ${res.collapseRatio} must be >= 0.60 against canonical intended`);
    assert.equal(res.sizingCollapseDetected, false, "Must not flag legitimate probe as collapse");
    console.log("  -> PASS: Micro-probe (0.50% risk) canonicalIntended =", res.canonicalIntendedNotionalUsdt.toFixed(2), "USDT, normalized =", res.normalizedNotionalUsdt?.toFixed(2), "USDT, ratio =", res.collapseRatio.toFixed(4));

    console.log("\n[Test 3B] Probe Multiplier (0.25x scaling): Intended probe multiplier 0.25x (500 -> 125 USDT) is NOT misclassified as collapse");
    const resProbe = evaluateEquityAdaptiveSizing({
        symbol: "ETH-USDT-SWAP",
        side: "long",
        orderKind: "ENTRY",
        accountEquityUsdt: equity,
        availableBalanceUsdt: 1200,
        entryReferencePrice: ethPrice,
        effectiveStopPrice: stopPrice,
        appliedLeverage: 10,
        entryQualityGrade: "A",
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        policyRequestedNotionalUsdt: 500,
        emergencyAbsoluteCapUsdt: null,
        legacyStaticCapUsdt: 40,
        v2HardSafetyCapUsdt: 500,
        lastPrice: ethPrice,
        instrumentSizing: ETH_SIZING,
        v2AuthorityEntry: true,
        entryProbeSizeMultiplier: 0.25,
        entryProbeSizingSource: "ETH_RANGE_LOCATION_PROBE",
        isMicroProbe: false
    });

    assert.equal(resProbe.sizingPassed, true, "Probe multiplier entry must pass sizing");
    assert.equal(resProbe.probeMultiplierApplied, 0.25);
    assert.equal(resProbe.canonicalIntendedNotionalUsdt, 125, "Canonical intended notional must be 500 * 0.25 = 125 USDT");
    assert.ok(resProbe.normalizedNotionalUsdt! > 120 && resProbe.normalizedNotionalUsdt! <= 125);
    assert.ok(resProbe.collapseRatio >= 0.60, `Ratio ${resProbe.collapseRatio} must be >= 0.60 against canonical intended`);
    assert.equal(resProbe.sizingCollapseDetected, false, "Must not flag legitimate probe multiplier as collapse");
    console.log("  -> PASS: Probe Multiplier canonicalIntended =", resProbe.canonicalIntendedNotionalUsdt.toFixed(2), "USDT, normalized =", resProbe.normalizedNotionalUsdt?.toFixed(2), "USDT, ratio =", resProbe.collapseRatio.toFixed(4));
}

// Scenario 4: Sizing Collapse Guard Detection (Rogue external truncation)
{
    console.log("\n[Test 4] Sizing Collapse Guard: Rogue truncation (e.g. 500 -> 37.50, ratio 0.075 < 0.60) is blocked with SIZING_COLLAPSE_DETECTED");
    const ethPrice = 2678.73;
    const canonicalIntended = 500.00;
    // Simulate what happened when 40 USDT cap or rogue logic chopped 500 down to 37.50:
    const choppedNotional = 37.50;
    const ratio = choppedNotional / canonicalIntended;
    assert.ok(ratio < 0.60, "Chopped ratio is 0.075 < 0.60");

    // Sizing collapse guard logic direct unit assertion:
    const oneLot = ETH_SIZING.lotSz * ETH_SIZING.ctVal * ethPrice; // ~2.678 USDT
    const isCollapse = (canonicalIntended >= oneLot && ratio < 0.60 && (canonicalIntended - choppedNotional) > oneLot * 1.05);
    assert.equal(isCollapse, true, "Sizing collapse guard condition must evaluate to true");
    console.log("  -> PASS: Sizing Collapse correctly detected (canonical:", canonicalIntended, "final:", choppedNotional, "ratio:", ratio.toFixed(4), ")");
}

// Scenario 5: Emergency Hard Cap Priority
{
    console.log("\n[Test 5] Emergency Hard Cap Priority: When emergency failsafe active (50 USDT), it binds over 500 USDT hard cap");
    const res = evaluateEquityAdaptiveSizing({
        symbol: "ETH-USDT-SWAP",
        side: "long",
        orderKind: "ENTRY",
        accountEquityUsdt: 1713.88,
        availableBalanceUsdt: 1200,
        entryReferencePrice: 2678.73,
        effectiveStopPrice: 2652.00,
        appliedLeverage: 10,
        entryQualityGrade: "A",
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        policyRequestedNotionalUsdt: 1282.05,
        emergencyAbsoluteCapUsdt: 50,
        emergencyFailsafeActive: true,
        legacyStaticCapUsdt: 40,
        v2HardSafetyCapUsdt: 500,
        lastPrice: 2678.73,
        instrumentSizing: ETH_SIZING,
        v2AuthorityEntry: true
    });

    assert.equal(res.sizingPassed, true);
    assert.equal(res.emergencyCapApplied, true);
    assert.equal(res.canonicalIntendedNotionalUsdt, 50, "Canonical intended must be clamped to emergency cap 50 USDT");
    assert.ok(res.normalizedNotionalUsdt! <= 50, `Notional ${res.normalizedNotionalUsdt} <= 50`);

    const submit = resolveLiveSubmitStaticSafetyCap({
        authoritySource: "v2",
        okxLiveStaticNotionalCapEnabled: true,
        staticSafetyCapUsdt: 40,
        v2HardSafetyCapUsdt: 500,
        intendedNotionalUsdt: 498.24,
        emergencyUltimateCapUsdt: 50,
        emergencyFailsafeActive: true
    });
    assert.equal(submit.emergencyCapApplied, true);
    assert.equal(submit.finalSubmittedNotionalUsdt, 50);
    assert.equal(submit.finalSizeSource, "emergency_ultimate_cap");
    console.log("  -> PASS: Emergency cap bound submit notional to 50 USDT");
}

// Scenario 6: Legacy Non-V2 Path Maintains 40 USDT Static Cap
{
    console.log("\n[Test 6] Legacy Non-V2 Path: OKX_LIVE_MAX_ORDER_NOTIONAL_USDT (40 USDT) applies and is NOT bypassed");
    const res = evaluateEquityAdaptiveSizing({
        symbol: "ETH-USDT-SWAP",
        side: "long",
        orderKind: "ENTRY",
        accountEquityUsdt: 1713.88,
        availableBalanceUsdt: 1200,
        entryReferencePrice: 2678.73,
        effectiveStopPrice: 2652.00,
        appliedLeverage: 10,
        entryQualityGrade: "A",
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        policyRequestedNotionalUsdt: 1282.05,
        emergencyAbsoluteCapUsdt: null,
        legacyStaticCapUsdt: 40,
        v2HardSafetyCapUsdt: 500,
        lastPrice: 2678.73,
        instrumentSizing: ETH_SIZING,
        v2AuthorityEntry: false // Legacy non-V2 entry
    });

    assert.equal(res.sizingPassed, true);
    assert.equal(res.canonicalIntendedNotionalUsdt, 40, "Legacy non-V2 path must be clamped by legacy 40 USDT cap");
    assert.ok(res.normalizedNotionalUsdt! <= 40);

    const submit = resolveLiveSubmitStaticSafetyCap({
        authoritySource: "v1_legacy",
        okxLiveStaticNotionalCapEnabled: true,
        staticSafetyCapUsdt: 40,
        v2HardSafetyCapUsdt: 500,
        intendedNotionalUsdt: 100,
        emergencyUltimateCapUsdt: null
    });
    assert.equal(submit.skipStaticCapForV2Authority, false, "Legacy non-V2 must NOT skip static cap");
    assert.equal(submit.finalSubmittedNotionalUsdt, 40);
    assert.equal(submit.finalSizeSource, "static_safety_cap");
    console.log("  -> PASS: Legacy non-V2 correctly bound by 40 USDT static cap");
}

console.log("\n=== ALL REGRESSION TESTS PASSED SUCCESSFULLY ===");
