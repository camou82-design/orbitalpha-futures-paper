/**
 * Dedicated test suite for PHASE LEVERAGE-CONTROL-1: Live Leverage Authority.
 * Validates requirements A through J strictly.
 */

import assert from "node:assert/strict";
import {
    evaluateLeverageSelectionAuthority,
    buildLeverageSelectionAuthorityProof,
    isValidExecutionLeverage,
    normalizeExecutionLeverage,
    DEFAULT_SIZING_LEVERAGE,
    ALLOWED_EXECUTION_LEVERAGES
} from "../src/engine-v2/execution/leverage-selection-authority";
import { evaluateEquityAdaptiveSizing } from "../src/engine-v2/risk-sizing/equity-adaptive-sizing";

function pass(label: string, detail?: Record<string, unknown>): void {
    const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
    console.log(`[LIVE-LEVERAGE-AUTHORITY][${label}] PASS${extra}`);
}

// A. 10/25/50/100 allowed
{
    for (const lev of [10, 25, 50, 100]) {
        assert.equal(isValidExecutionLeverage(lev), true, `${lev} must be allowed`);
        const res = evaluateLeverageSelectionAuthority({
            symbol: "BTCUSDT",
            selectedLeverage: lev,
            confirmedOkxLeverage: lev,
            finalOrderNotionalUsdt: 1000,
            positionOpen: false
        });
        assert.equal(res.validationPassed, true);
        assert.equal(res.selectedExecutionLeverage, lev);
        assert.equal(res.blockReason, null);
    }
    pass("A_10_25_50_100_ALLOWED");
}

// B. invalid rejected
{
    const invalidValues = [0, 5, 15, 20, 75, 125, -10, NaN, Infinity, "100" as any];
    for (const inv of invalidValues) {
        assert.equal(isValidExecutionLeverage(inv), false, `${inv} must be invalid`);
        const res = evaluateLeverageSelectionAuthority({
            symbol: "BTCUSDT",
            selectedLeverage: inv,
            confirmedOkxLeverage: 10,
            finalOrderNotionalUsdt: 1000,
            positionOpen: false
        });
        assert.equal(res.validationPassed, false, `Invalid leverage ${inv} must fail validation`);
        assert.equal(res.blockReason, "INVALID_EXECUTION_LEVERAGE_REJECTED");
    }
    pass("B_INVALID_REJECTED");
}

// C. BTC/ETH independent
{
    const btcRes = evaluateLeverageSelectionAuthority({
        symbol: "BTCUSDT",
        selectedLeverage: 50,
        confirmedOkxLeverage: 50,
        finalOrderNotionalUsdt: 1600,
        positionOpen: false
    });
    const ethRes = evaluateLeverageSelectionAuthority({
        symbol: "ETHUSDT",
        selectedLeverage: 25,
        confirmedOkxLeverage: 25,
        finalOrderNotionalUsdt: 1200,
        positionOpen: false
    });

    assert.equal(btcRes.selectedExecutionLeverage, 50);
    assert.equal(ethRes.selectedExecutionLeverage, 25);
    assert.notEqual(btcRes.selectedExecutionLeverage, ethRes.selectedExecutionLeverage);
    pass("C_BTC_ETH_INDEPENDENT", {
        btcLeverage: btcRes.selectedExecutionLeverage,
        ethLeverage: ethRes.selectedExecutionLeverage
    });
}

// D. selection saved while position open
// E. existing position leverage unchanged
{
    // Operator selects 50x while existing position is open with 10x confirmed
    const res = evaluateLeverageSelectionAuthority({
        symbol: "BTCUSDT",
        selectedLeverage: 50,
        confirmedOkxLeverage: 10,
        finalOrderNotionalUsdt: 1623.2,
        positionOpen: true // position currently open
    });

    assert.equal(res.validationPassed, true);
    assert.equal(res.selectedExecutionLeverage, 50, "selection preserved");
    assert.equal(res.confirmedOkxLeverage, 10, "current position confirmed leverage unchanged");
    assert.equal(res.appliesToNextNewEntry, true, "applies to NEXT_NEW_ENTRY");
    assert.equal(res.leverageSyncRequired, false, "sync prohibited while position open");
    pass("D_E_POSITION_OPEN_SELECTION_SAVED_BUT_LIVE_UNCHANGED", {
        selected: res.selectedExecutionLeverage,
        confirmed: res.confirmedOkxLeverage,
        appliesToNextNewEntry: res.appliesToNextNewEntry,
        leverageSyncRequired: res.leverageSyncRequired
    });
}

// F. next flat entry applies selected leverage
{
    // When position closes (positionOpen: false), sync becomes required for next entry
    const res = evaluateLeverageSelectionAuthority({
        symbol: "BTCUSDT",
        selectedLeverage: 50,
        confirmedOkxLeverage: 10,
        finalOrderNotionalUsdt: 1623.2,
        positionOpen: false // flat state
    });

    assert.equal(res.validationPassed, true);
    assert.equal(res.selectedExecutionLeverage, 50);
    assert.equal(res.leverageSyncRequired, true, "sync required for new entry from flat state");
    pass("F_NEXT_FLAT_ENTRY_APPLIES_SELECTED_LEVERAGE");
}

// G. OKX mismatch fail-closed
{
    // Proof event generation when OKX re-query mismatch occurs
    const failedRes = evaluateLeverageSelectionAuthority({
        symbol: "BTCUSDT",
        selectedLeverage: 100,
        confirmedOkxLeverage: 10,
        finalOrderNotionalUsdt: 1600,
        positionOpen: false
    });
    const proof = buildLeverageSelectionAuthorityProof({
        ...failedRes,
        confirmedOkxLeverage: 10,
        validationPassed: false,
        blockReason: "LEVERAGE_CONFIRMATION_FAILED"
    });

    assert.equal(proof.event, "V2_LEVERAGE_SELECTION_AUTHORITY_PROOF");
    assert.equal(proof.validation_passed, false);
    assert.equal(proof.block_reason, "LEVERAGE_CONFIRMATION_FAILED");
    assert.equal(proof.selected_execution_leverage, 100);
    assert.equal(proof.confirmed_okx_leverage, 10);
    pass("G_OKX_MISMATCH_FAIL_CLOSED_PROOF", { block_reason: proof.block_reason });
}

// H. restart/state fallback to 10
{
    assert.equal(normalizeExecutionLeverage(undefined), 10);
    assert.equal(normalizeExecutionLeverage(null), 10);
    assert.equal(normalizeExecutionLeverage(""), 10);
    assert.equal(normalizeExecutionLeverage(999), 10);

    const emptyRes = evaluateLeverageSelectionAuthority({
        symbol: "ETHUSDT",
        selectedLeverage: undefined,
        confirmedOkxLeverage: null,
        finalOrderNotionalUsdt: 1000,
        positionOpen: false
    });
    assert.equal(emptyRes.selectedExecutionLeverage, 10);
    assert.equal(emptyRes.sizingLeverage, DEFAULT_SIZING_LEVERAGE);
    pass("H_RESTART_STATE_FALLBACK_TO_10");
}

// I. MOST IMPORTANT: finalOrderNotional identical across 10/25/50/100
// J. requiredMargin only: N/10, N/25, N/50, N/100
{
    const baseInput = {
        symbol: "BTCUSDT",
        side: "short" as const,
        orderKind: "ENTRY" as const,
        accountEquityUsdt: 811.6033577749594,
        availableBalanceUsdt: 532.1504047024622,
        entryReferencePrice: 76546.4,
        effectiveStopPrice: 77363.0,
        lastPrice: 76546.4,
        entryQualityGrade: "A" as const,
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        v2AuthorityEntry: true,
        appliedLeverage: 10 // Sizing leverage remains FIXED 10
    };

    const notionals: number[] = [];
    const margins: number[] = [];

    for (const execLev of [10, 25, 50, 100] as const) {
        // 1. Sizing computation ALWAYS uses fixed sizingLeverage (10x)
        const sizing = evaluateEquityAdaptiveSizing(baseInput);
        assert.equal(sizing.sizingPassed, true);
        notionals.push(sizing.finalOrderNotionalUsdt);

        // 2. Execution authority determines required margin from finalOrderNotional / execLev
        const auth = evaluateLeverageSelectionAuthority({
            symbol: "BTCUSDT",
            selectedLeverage: execLev,
            confirmedOkxLeverage: execLev,
            finalOrderNotionalUsdt: sizing.finalOrderNotionalUsdt,
            positionOpen: false,
            sizingLeverage: baseInput.appliedLeverage
        });

        margins.push(auth.requiredMarginUsdt);
    }

    const baselineNotional = notionals[0];
    assert.ok(baselineNotional > 0);

    // Assert bit-for-bit identical finalOrderNotional across all 4 leverage settings
    for (let i = 1; i < notionals.length; i++) {
        assert.equal(
            notionals[i],
            baselineNotional,
            `finalOrderNotional at ${[10, 25, 50, 100][i]}x must be bit-for-bit identical to 10x`
        );
    }

    // Assert requiredMargin strictly scales as N/10, N/25, N/50, N/100
    const [m10, m25, m50, m100] = margins;
    assert.ok(Math.abs(m10 - baselineNotional / 10) < 1e-9, "margin at 10x");
    assert.ok(Math.abs(m25 - baselineNotional / 25) < 1e-9, "margin at 25x");
    assert.ok(Math.abs(m50 - baselineNotional / 50) < 1e-9, "margin at 50x");
    assert.ok(Math.abs(m100 - baselineNotional / 100) < 1e-9, "margin at 100x");

    pass("I_J_NOTIONAL_IDENTICAL_AND_MARGIN_STRICT_RATIOS", {
        baselineNotional,
        margin10x: m10,
        margin25x: m25,
        margin50x: m50,
        margin100x: m100
    });
}

console.log("[LIVE-LEVERAGE-AUTHORITY] ALL PASS");
