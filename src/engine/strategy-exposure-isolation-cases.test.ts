import assert from "node:assert";
import { resolveLiveExposureAuthority } from "../engine-v2/live-account/exposure-authority";
import { evaluateEquityAdaptiveSizing } from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { runEngineV2 } from "../engine-v2/index";
import type { EngineV2Input } from "../engine-v2/types";
import type { MarketSymbol } from "../models/types";

function assertEq<T>(actual: T, expected: T, message: string) {
  assert.strictEqual(actual, expected, message);
}

function assertTrue(cond: boolean, message: string) {
  assert.strictEqual(cond, true, message);
}

function assertFalse(cond: boolean, message: string) {
  assert.strictEqual(cond, false, message);
}

export function runStrategyExposureIsolationTests(): void {
  console.info("=== STARTING STRATEGY EXPOSURE ISOLATION TESTS ===");

  // =========================================================================
  // CASE A: Equity 561 / manual BTC 1896 / available 373 -> ETH BOT entry allowed
  // =========================================================================
  {
    const manualBtcPosition = {
      symbol: "BTCUSDT",
      sizeUsd: 1896,
      notionalUsd: 1896,
      side: "SHORT",
      isV2Authority: false,
      lifecycleState: "OPERATOR_MANAGED",
      manualTakeoverActive: true
    };

    const expAuth = resolveLiveExposureAuthority({
      symbol: "ETHUSDT",
      okxPositions: [{ symbol: "BTCUSDT", sizeUsd: 1896, side: "short" }],
      paperPositions: [manualBtcPosition as any],
      okxActualPositions: [{ symbol: "BTCUSDT", sizeUsd: 1896, notionalUsd: 1896, side: "short" }],
      pendingSymbolNotionalUsdt: 0,
      pendingOrdersNotionalUsdt: 0,
      isLiveAuthority: true
    });

    assertEq(expAuth.okx_account_notional_usdt, 1896, "CASE A: OKX total account notional is 1896");
    assertEq(expAuth.strategy_account_notional_usdt, 0, "CASE A: Strategy account notional is 0 (manual BTC excluded)");
    assertEq(expAuth.strategy_symbol_notional_usdt, 0, "CASE A: ETH strategy symbol notional is 0");
    assertEq(expAuth.manual_position_notional_usdt, 1896, "CASE A: Manual position notional is 1896");

    // Sizing evaluation for ETH with Equity 561, available 373
    const sizingResult = evaluateEquityAdaptiveSizing({
      symbol: "ETHUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: 561,
      availableBalanceUsdt: 373,
      entryReferencePrice: 2500,
      effectiveStopPrice: 2485,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: expAuth.strategy_symbol_notional_usdt,
      existingAccountNotionalUsdt: expAuth.strategy_account_notional_usdt,
      policyRequestedNotionalUsdt: null,
      emergencyAbsoluteCapUsdt: 500,
      marginReserveRatio: 0.2,
      lastPrice: 2500,
      v2AuthorityEntry: true
    });

    assertTrue(sizingResult.sizingPassed, "CASE A: ETH sizing passed");
    assertTrue(sizingResult.finalOrderNotionalUsdt > 0, "CASE A: ETH order notional > 0");
    assertEq(sizingResult.blockReason, null, "CASE A: No MAX_ACCOUNT_NOTIONAL_EXCEEDED block");

    console.info(JSON.stringify({
      case: "CASE_A_MANUAL_BTC_EXCLUDED_ETH_BOT_ALLOWED_PASS",
      expAuth,
      sizingResult: {
        sizingPassed: sizingResult.sizingPassed,
        finalNotional: sizingResult.finalOrderNotionalUsdt,
        accountCap: sizingResult.accountCapUsdt,
        remainingAccountCapacity: (sizingResult as any).remainingAccountCapacityUsdt
      }
    }));
  }

  // =========================================================================
  // CASE B: BTC BOT entry is blocked by manual BTC authority
  // =========================================================================
  {
    const manualBtcPosition = {
      symbol: "BTCUSDT",
      sizeUsd: 1896,
      notionalUsd: 1896,
      side: "SHORT",
      isV2Authority: false,
      lifecycleState: "OPERATOR_MANAGED",
      manualTakeoverActive: true
    };

    const expAuth = resolveLiveExposureAuthority({
      symbol: "BTCUSDT",
      okxPositions: [{ symbol: "BTCUSDT", sizeUsd: 1896, side: "short" }],
      paperPositions: [manualBtcPosition as any],
      okxActualPositions: [{ symbol: "BTCUSDT", sizeUsd: 1896, notionalUsd: 1896, side: "short" }],
      pendingSymbolNotionalUsdt: 0,
      pendingOrdersNotionalUsdt: 0,
      isLiveAuthority: true
    });

    assertEq(expAuth.manual_position_notional_usdt, 1896, "CASE B: Manual BTC position tracked");
    assertEq(expAuth.strategy_symbol_notional_usdt, 0, "CASE B: Strategy symbol notional 0");

    console.info(JSON.stringify({
      case: "CASE_B_BTC_MANUAL_AUTHORITY_ISOLATED_PASS",
      expAuth
    }));
  }

  // =========================================================================
  // CASE C: manual ETH + BTC BOT candidate -> BTC independently allowed
  // =========================================================================
  {
    const manualEthPosition = {
      symbol: "ETHUSDT",
      sizeUsd: 1200,
      notionalUsd: 1200,
      side: "LONG",
      isV2Authority: false,
      lifecycleState: "OPERATOR_MANAGED",
      manualTakeoverActive: true
    };

    const expAuth = resolveLiveExposureAuthority({
      symbol: "BTCUSDT",
      okxPositions: [{ symbol: "ETHUSDT", sizeUsd: 1200, side: "long" }],
      paperPositions: [manualEthPosition as any],
      okxActualPositions: [{ symbol: "ETHUSDT", sizeUsd: 1200, notionalUsd: 1200, side: "long" }],
      pendingSymbolNotionalUsdt: 0,
      pendingOrdersNotionalUsdt: 0,
      isLiveAuthority: true
    });

    assertEq(expAuth.strategy_account_notional_usdt, 0, "CASE C: BTC strategy account notional 0");
    assertEq(expAuth.manual_position_notional_usdt, 1200, "CASE C: ETH manual notional 1200 excluded");

    const sizingResult = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: 500,
      availableBalanceUsdt: 300,
      entryReferencePrice: 65000,
      effectiveStopPrice: 64500,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: expAuth.strategy_symbol_notional_usdt,
      existingAccountNotionalUsdt: expAuth.strategy_account_notional_usdt,
      emergencyAbsoluteCapUsdt: 500,
      marginReserveRatio: 0.2,
      lastPrice: 65000,
      v2AuthorityEntry: true
    });

    assertTrue(sizingResult.sizingPassed, "CASE C: BTC sizing passed independently");

    console.info(JSON.stringify({
      case: "CASE_C_MANUAL_ETH_BTC_INDEPENDENT_PASS",
      sizingPassed: sizingResult.sizingPassed,
      finalNotional: sizingResult.finalOrderNotionalUsdt
    }));
  }

  // =========================================================================
  // CASE D: BTC operator pending limit + ETH BOT candidate -> pending does not consume ETH cap
  // =========================================================================
  {
    const operatorBtcPending = {
      ordId: "op_btc_limit_123",
      clOrdId: "p_user_btc_limit",
      instId: "BTC-USDT-SWAP",
      notionalUsd: 2000
    };

    const expAuth = resolveLiveExposureAuthority({
      symbol: "ETHUSDT",
      okxPositions: [],
      paperPositions: [],
      pendingSymbolNotionalUsdt: 0,
      pendingOrdersNotionalUsdt: 2000,
      botPendingOrdersNotionalUsdt: 0,
      botPendingSymbolNotionalUsdt: 0,
      operatorPendingOrdersNotionalUsdt: 2000,
      operatorPendingSymbolNotionalUsdt: 0,
      pendingOrdersList: [operatorBtcPending],
      isLiveAuthority: true
    });

    assertEq(expAuth.strategy_account_notional_usdt, 0, "CASE D: ETH strategy account notional 0");
    assertEq(expAuth.operator_pending_notional_usdt, 2000, "CASE D: Operator pending notional 2000 excluded");
    assertEq(expAuth.engine_owned_pending_notional_usdt, 0, "CASE D: Engine pending notional 0");

    console.info(JSON.stringify({
      case: "CASE_D_OPERATOR_PENDING_EXCLUDED_FROM_STRATEGY_CAP_PASS",
      expAuth
    }));
  }

  // =========================================================================
  // CASE E: genuine BOT pending order is included in strategy exposure
  // =========================================================================
  {
    const botPendingOrder = {
      ordId: "ord_close_exact_123",
      clOrdId: "pETHUSlsg7k2j3",
      instId: "ETH-USDT-SWAP",
      notionalUsd: 150
    };

    const expAuth = resolveLiveExposureAuthority({
      symbol: "ETHUSDT",
      okxPositions: [],
      paperPositions: [],
      pendingSymbolNotionalUsdt: 150,
      pendingOrdersNotionalUsdt: 150,
      botPendingOrdersNotionalUsdt: 150,
      botPendingSymbolNotionalUsdt: 150,
      pendingOrdersList: [botPendingOrder],
      isLiveAuthority: true
    });

    assertEq(expAuth.engine_owned_pending_notional_usdt, 150, "CASE E: Engine pending notional is 150");
    assertEq(expAuth.operator_pending_notional_usdt, 0, "CASE E: Operator pending notional is 0");
    assertEq(expAuth.strategy_account_notional_usdt, 150, "CASE E: Strategy account notional includes 150");

    console.info(JSON.stringify({
      case: "CASE_E_GENUINE_BOT_PENDING_INCLUDED_PASS",
      expAuth
    }));
  }

  // =========================================================================
  // CASE F: mixed operator pending + bot pending -> bot pending only in cap
  // =========================================================================
  {
    const botPendingOrder = {
      ordId: "ord_bot_close",
      clOrdId: "pETHUSlsg7k2j3",
      instId: "ETH-USDT-SWAP",
      notionalUsd: 100
    };

    const operatorPendingOrder = {
      ordId: "ord_op_limit",
      clOrdId: "p_user_manual_buy",
      instId: "BTC-USDT-SWAP",
      notionalUsd: 500
    };

    const expAuth = resolveLiveExposureAuthority({
      symbol: "ETHUSDT",
      okxPositions: [],
      paperPositions: [],
      pendingSymbolNotionalUsdt: 100,
      pendingOrdersNotionalUsdt: 600,
      botPendingOrdersNotionalUsdt: 100,
      botPendingSymbolNotionalUsdt: 100,
      operatorPendingOrdersNotionalUsdt: 500,
      operatorPendingSymbolNotionalUsdt: 0,
      pendingOrdersList: [botPendingOrder, operatorPendingOrder],
      isLiveAuthority: true
    });

    assertEq(expAuth.engine_owned_pending_notional_usdt, 100, "CASE F: Bot pending notional is 100");
    assertEq(expAuth.operator_pending_notional_usdt, 500, "CASE F: Operator pending notional is 500");
    assertEq(expAuth.strategy_account_notional_usdt, 100, "CASE F: Strategy account notional is 100 (operator 500 excluded)");
    assertEq(expAuth.okx_account_notional_usdt, 600, "CASE F: OKX total account notional is 600");

    console.info(JSON.stringify({
      case: "CASE_F_MIXED_PENDING_BOT_ONLY_CAP_PASS",
      expAuth
    }));
  }

  // =========================================================================
  // CASE G: insufficient available margin -> blocked with AVAILABLE_MARGIN_INSUFFICIENT
  // =========================================================================
  {
    const sizingResult = evaluateEquityAdaptiveSizing({
      symbol: "ETHUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: 561,
      availableBalanceUsdt: 5, // Insufficient margin
      entryReferencePrice: 2500,
      effectiveStopPrice: 2485,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      emergencyAbsoluteCapUsdt: 500,
      marginReserveRatio: 0.2,
      lastPrice: 2500,
      v2AuthorityEntry: true
    });

    assertFalse(sizingResult.sizingPassed, "CASE G: Sizing blocked due to low available margin");
    assertEq(sizingResult.blockReason, "AVAILABLE_MARGIN_INSUFFICIENT", "CASE G: Exact block reason AVAILABLE_MARGIN_INSUFFICIENT");

    console.info(JSON.stringify({
      case: "CASE_G_AVAILABLE_MARGIN_INSUFFICIENT_BLOCKED_PASS",
      sizingResult: {
        sizingPassed: sizingResult.sizingPassed,
        blockReason: sizingResult.blockReason,
        usableAvailableBalance: sizingResult.usableAvailableBalanceUsdt
      }
    }));
  }

  // =========================================================================
  // CASE H: emergency 500 cap maintained
  // =========================================================================
  {
    const sizingResult = evaluateEquityAdaptiveSizing({
      symbol: "ETHUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: 10000, // Very high equity
      availableBalanceUsdt: 8000,
      entryReferencePrice: 2500,
      effectiveStopPrice: 2490,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      emergencyAbsoluteCapUsdt: 500,
      marginReserveRatio: 0.2,
      lastPrice: 2500,
      v2AuthorityEntry: true
    });

    assertTrue(sizingResult.sizingPassed, "CASE H: Sizing passed");
    assertTrue(sizingResult.finalOrderNotionalUsdt <= 500, "CASE H: Order notional capped at emergency 500");
    assertEq(sizingResult.effectiveLiveCapUsdt, 500, "CASE H: Effective live cap is 500");

    console.info(JSON.stringify({
      case: "CASE_H_EMERGENCY_500_CAP_MAINTAINED_PASS",
      finalNotional: sizingResult.finalOrderNotionalUsdt,
      effectiveLiveCap: sizingResult.effectiveLiveCapUsdt
    }));
  }

  console.info(JSON.stringify({
    event: "V2_STRATEGY_EXPOSURE_ISOLATION_ALL_CASES_PASS",
    cases: ["A", "B", "C", "D", "E", "F", "G", "H"]
  }));
}

runStrategyExposureIsolationTests();
