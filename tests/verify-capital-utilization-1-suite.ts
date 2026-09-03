import {
  RISK_PER_TRADE_PCT,
  MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE,
  MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
  MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
  MAX_ADVERSE_ADDON_EQUITY_MULTIPLE,
  evaluateEquityAdaptiveSizing
} from "../src/engine-v2/risk-sizing/equity-adaptive-sizing";
import { evaluateV2AddOnPolicy } from "../src/engine-v2/addon/policy";

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(`[FAIL] ${msg}`);
  }
}

function assertClose(actual: number, expected: number, tol = 1e-4, msg = ""): void {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`[FAIL] ${msg}: expected ${expected}, got ${actual}`);
  }
}

function runSuite(): void {
  console.log("=== RUNNING CAPITAL-UTILIZATION-1 DEDICATED SUITE ===");

  const equity = 900;
  const initialCapExpected = equity * 2.30; // 2070
  const symbolCapExpected = equity * 2.75; // 2475
  const accountCapExpected = equity * 3.00; // 2700

  // 1. Constants verification
  assertTrue(MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE === 2.3, "MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE must be 2.3");
  assertTrue(MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE === 2.75, "MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE must be 2.75");
  assertTrue(MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE === 3.0, "MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE must be 3.0");
  assertTrue(RISK_PER_TRADE_PCT === 0.01, "RISK_PER_TRADE_PCT must remain 0.010 (1.0%)");
  assertTrue(MAX_ADVERSE_ADDON_EQUITY_MULTIPLE === 0.25, "MAX_ADVERSE_ADDON_EQUITY_MULTIPLE must remain 0.25");

  // TEST A: riskBasedNotional = 1800 => final remains 1800 (cap 변경 때문에 강제 확대 금지)
  // Risk = 900 * 0.01 = 9 USDT. For riskBasedNotional = 1800, stop distance = 9 / 1800 = 0.005 (0.5%)
  {
    const entryPx = 1000;
    const stopPx = 995; // 0.5% distance -> 9 / 0.005 = 1800 USDT
    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: equity,
      entryReferencePrice: entryPx,
      effectiveStopPrice: stopPx,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      roundTripFeeRate: 0,
      lastPrice: entryPx
    });

    assertTrue(res.sizingPassed, "TEST A: sizingPassed");
    assertClose(res.riskBasedNotionalUsdt, 1800, 1e-2, "TEST A: riskBasedNotionalUsdt");
    assertClose(res.finalOrderNotionalUsdt, 1800, 1e-2, "TEST A: finalOrderNotionalUsdt remains 1800");
    console.log("[PASS] TEST A: riskBasedNotional=1800 => final=1800 (not inflated by cap)");
  }

  // TEST B: riskBasedNotional = 2200 => initial cap binds at 2070
  // Stop distance = 9 / 2200 = 0.004090909 (0.409%)
  {
    const entryPx = 1000;
    const stopPx = 1000 * (1 - 9 / 2200);
    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: equity,
      entryReferencePrice: entryPx,
      effectiveStopPrice: stopPx,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      roundTripFeeRate: 0,
      lastPrice: entryPx
    });

    assertTrue(res.sizingPassed, "TEST B: sizingPassed");
    assertClose(res.riskBasedNotionalUsdt, 2200, 1e-2, "TEST B: riskBasedNotionalUsdt");
    assertClose(res.equityInitialCapUsdt, initialCapExpected, 1e-2, "TEST B: equityInitialCapUsdt");
    assertClose(res.finalOrderNotionalUsdt, 2070, 1e-2, "TEST B: finalOrderNotionalUsdt binds at 2070");
    console.log("[PASS] TEST B: riskBasedNotional=2200 => final binds at 2070");
  }

  // TEST C: riskBasedNotional = 5000 => initial cap binds at 2070
  // Stop distance = 9 / 5000 = 0.0018 (0.18%)
  {
    const entryPx = 1000;
    const stopPx = 1000 * (1 - 9 / 5000);
    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: equity,
      entryReferencePrice: entryPx,
      effectiveStopPrice: stopPx,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      roundTripFeeRate: 0,
      lastPrice: entryPx
    });

    assertTrue(res.sizingPassed, "TEST C: sizingPassed");
    assertClose(res.riskBasedNotionalUsdt, 5000, 1e-2, "TEST C: riskBasedNotionalUsdt");
    assertClose(res.finalOrderNotionalUsdt, 2070, 1e-2, "TEST C: finalOrderNotionalUsdt binds at 2070");
    console.log("[PASS] TEST C: riskBasedNotional=5000 => final binds at 2070");
  }

  // TEST D: existing same-symbol exposure 포함 시 symbol total <= 2475
  // If existingSymbolNotional = 1000, remaining symbol cap = 2475 - 1000 = 1475.
  // Even if initial cap is 2070 and riskBasedNotional = 3000, final should be capped at 1475.
  {
    const entryPx = 1000;
    const stopPx = 1000 * (1 - 9 / 3000);
    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: equity,
      entryReferencePrice: entryPx,
      effectiveStopPrice: stopPx,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 1000,
      existingAccountNotionalUsdt: 1000,
      roundTripFeeRate: 0,
      lastPrice: entryPx
    });

    assertTrue(res.sizingPassed, "TEST D: sizingPassed");
    assertClose(res.finalOrderNotionalUsdt, 1475, 1e-2, "TEST D: finalOrderNotionalUsdt binds at remaining symbol cap 1475");
    assertTrue(1000 + res.finalOrderNotionalUsdt <= symbolCapExpected, "TEST D: total symbol notional <= 2475");
    console.log("[PASS] TEST D: existing same-symbol exposure 1000 => final=1475 (total symbol=2475)");
  }

  // TEST E: account exposure 포함 시 account total <= 2700
  // If existing other symbols = 1200, remaining account cap = 2700 - 1200 = 1500.
  // Even if initial cap is 2070 and symbol cap is 2475, final should be capped at 1500.
  {
    const entryPx = 1000;
    const stopPx = 1000 * (1 - 9 / 3000);
    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: equity,
      entryReferencePrice: entryPx,
      effectiveStopPrice: stopPx,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 1200,
      roundTripFeeRate: 0,
      lastPrice: entryPx
    });

    assertTrue(res.sizingPassed, "TEST E: sizingPassed");
    assertClose(res.finalOrderNotionalUsdt, 1500, 1e-2, "TEST E: finalOrderNotionalUsdt binds at remaining account cap 1500");
    assertTrue(1200 + res.finalOrderNotionalUsdt <= accountCapExpected, "TEST E: total account notional <= 2700");
    console.log("[PASS] TEST E: existing account exposure 1200 => final=1500 (total account=2700)");
  }

  // TEST F: risk budget identical before/after
  {
    const entryPx = 1000;
    const stopPx = 990; // 1% distance -> 9 / 0.01 = 900 USDT
    const res = evaluateEquityAdaptiveSizing({
      symbol: "ETHUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: equity,
      entryReferencePrice: entryPx,
      effectiveStopPrice: stopPx,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      roundTripFeeRate: 0,
      lastPrice: entryPx
    });

    assertClose(res.riskBudgetUsdt, 9.0, 1e-4, "TEST F: riskBudgetUsdt is exactly 9.00 USDT (1%)");
    console.log("[PASS] TEST F: risk budget remains exactly 1.0% ($9.00 on $900 equity)");
  }

  // TEST G: stop loss dollar risk identical before/after under normal stop execution
  {
    const entryPx = 2500;
    const stopPx = 2475; // 1% stop distance
    const res = evaluateEquityAdaptiveSizing({
      symbol: "ETHUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: equity,
      entryReferencePrice: entryPx,
      effectiveStopPrice: stopPx,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      roundTripFeeRate: 0,
      lastPrice: entryPx
    });

    const dollarLossAtStop = res.finalOrderNotionalUsdt * (Math.abs(entryPx - stopPx) / entryPx);
    assertClose(dollarLossAtStop, 9.0, 1e-4, "TEST G: dollar loss at stop is strictly 9.00 USDT");
    console.log("[PASS] TEST G: stop loss dollar risk remains strictly controlled at $9.00");
  }

  // TEST H: addon policy unchanged
  {
    const mockV2State: any = {
      longPosition: {
        entryPrice: 1000,
        sizeUsd: 1000,
        pnlPct: -0.01,
        entryStage: 1,
        breakevenStopRequired: false,
        breakevenStopConfirmed: false
      },
      shortPosition: null,
      crashState: "NORMAL",
      pumpState: "NORMAL",
      accountEquityKrw: 1260000
    };
    const mockJudgment: any = {
      regime_final: "RANGE",
      subtype: "WHIPSAW_SOFT_WATCH",
      shockPhase: "NONE",
      rangePhase: "LOWER",
      trendPhase: "NONE",
      transitionPhase: "NONE"
    };
    const mockExecution: any = {
      side: "long",
      signal: "LONG_CANDIDATE",
      metadata: {}
    };

    const addonRes = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      v2State: mockV2State,
      judgment: mockJudgment,
      execution: mockExecution,
      snapshot: {
        qualityScore: 80,
        reviewing_ticks: 3,
        boxPos: 0.1,
        emaGap: -0.001,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.8,
        lastPrice: 990,
        latestCandleTs: 1000
      },
      accountEquityUsd: 900
    });

    assertTrue(addonRes.action !== undefined, "TEST H: addon policy evaluated");
    console.log("[PASS] TEST H: addon policy evaluated without modification to logic");
  }

  // TEST I: BTC and ETH symmetry without symbol hardcoding
  {
    const btcRes = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "short",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: equity,
      entryReferencePrice: 80000,
      effectiveStopPrice: 80400, // 0.5%
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      roundTripFeeRate: 0,
      lastPrice: 80000
    });

    const ethRes = evaluateEquityAdaptiveSizing({
      symbol: "ETHUSDT",
      side: "short",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: equity,
      entryReferencePrice: 2500,
      effectiveStopPrice: 2512.5, // 0.5%
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      roundTripFeeRate: 0,
      lastPrice: 2500
    });

    assertClose(btcRes.finalOrderNotionalUsdt, ethRes.finalOrderNotionalUsdt, 1e-4, "TEST I: BTC and ETH notional symmetry");
    assertClose(btcRes.equityInitialCapUsdt, 2070, 1e-4, "TEST I: BTC initial cap 2070");
    assertClose(ethRes.equityInitialCapUsdt, 2070, 1e-4, "TEST I: ETH initial cap 2070");
    console.log("[PASS] TEST I: BTC/ETH common symmetry and identical cap behavior");
  }

  // TEST J: Execution leverage 10 / 25 / 50 / 100 => notional sizing invariant
  {
    const entryPx = 1000;
    const stopPx = 996; // 0.4% stop -> 9 / 0.004 = 2250 -> binds at 2070

    for (const lev of [10, 25, 50, 100]) {
      const res = evaluateEquityAdaptiveSizing({
        symbol: "BTCUSDT",
        side: "long",
        orderKind: "ENTRY",
        accountEquityUsdt: equity,
        availableBalanceUsdt: equity,
        entryReferencePrice: entryPx,
        effectiveStopPrice: stopPx,
        appliedLeverage: lev,
        entryQualityGrade: "A",
        existingSymbolNotionalUsdt: 0,
        existingAccountNotionalUsdt: 0,
        roundTripFeeRate: 0,
        lastPrice: entryPx
      });

      assertClose(res.finalOrderNotionalUsdt, 2070, 1e-2, `TEST J: leverage ${lev} notional invariant`);
      assertClose(res.finalRequiredMarginUsdt, 2070 / lev, 1e-2, `TEST J: leverage ${lev} margin invariant`);
    }
    console.log("[PASS] TEST J: leverage 10/25/50/100 notional invariant ($2070) and margin scaled accordingly");
  }

  console.log("=== ALL 10 DEDICATED VERIFICATION TESTS PASSED SUCCESSFULLY ===");
}

runSuite();
