import assert from "node:assert";
import { resolveLiveExposureAuthority } from "../engine-v2/live-account/exposure-authority";
import { evaluateEquityAdaptiveSizing } from "../engine-v2/risk-sizing/equity-adaptive-sizing";

const CYCLE18_ACCOUNT_EQUITY_USDT = 1078.713133428912;
const CYCLE18_AVAILABLE_BALANCE_USDT = 604.8092575749649;
const CYCLE18_MANUAL_ETH_PENDING_NOTIONAL = 2828.63556;
const CYCLE18_ACCOUNT_CAP_USDT = CYCLE18_ACCOUNT_EQUITY_USDT * 3;
const CYCLE18_REMAINING_ACCOUNT_CAPACITY_IF_BOT_PENDING =
  CYCLE18_ACCOUNT_CAP_USDT - CYCLE18_MANUAL_ETH_PENDING_NOTIONAL;
const CYCLE18_BTC_ENTRY_PRICE = 79859.1;
const CYCLE18_BTC_STOP_PRICE = 79859.1 * (1 - 0.005);

const manualEthOperatorPosition = {
  symbol: "ETHUSDT",
  instId: "ETH-USDT-SWAP",
  sizeUsd: 23346.9024,
  notionalUsd: 23346.9024,
  side: "LONG",
  isV2Authority: false,
  lifecycleState: "OPERATOR_MANAGED",
  manualTakeoverActive: true,
  status: "open"
};

const cycle18ManualEthPending = {
  ordId: "3898267956756353024",
  instId: "ETH-USDT-SWAP",
  side: "buy",
  posSide: "long",
  ordType: "limit",
  reduceOnly: false,
  sz: 11.38,
  px: 2485.62,
  state: "live"
};

const cycle18BotEthPending = {
  ...cycle18ManualEthPending,
  clOrdId: "pETHUlsg7k2j3"
};

function assertClose(actual: number, expected: number, tol: number, label: string): void {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label}: expected ~${expected}, got ${actual}`);
  }
}

function runCycle18BtcSizing(existingAccountNotionalUsdt: number) {
  return evaluateEquityAdaptiveSizing({
    symbol: "BTCUSDT",
    side: "long",
    orderKind: "ENTRY",
    accountEquityUsdt: CYCLE18_ACCOUNT_EQUITY_USDT,
    availableBalanceUsdt: CYCLE18_AVAILABLE_BALANCE_USDT,
    entryReferencePrice: CYCLE18_BTC_ENTRY_PRICE,
    effectiveStopPrice: CYCLE18_BTC_STOP_PRICE,
    appliedLeverage: 10,
    entryQualityGrade: "B",
    existingSymbolNotionalUsdt: 0,
    existingAccountNotionalUsdt,
    policyRequestedNotionalUsdt: null,
    emergencyAbsoluteCapUsdt: 500,
    marginReserveRatio: 0.2,
    lastPrice: CYCLE18_BTC_ENTRY_PRICE,
    v2AuthorityEntry: true
  });
}

function resolveEntryBlockReason(
  expAuth: ReturnType<typeof resolveLiveExposureAuthority>
): string | null {
  if (expAuth.pending_order_ownership_unavailable) {
    return "PENDING_ORDER_OWNERSHIP_UNAVAILABLE";
  }
  if (!Number.isFinite(expAuth.strategy_account_notional_usdt)) {
    return "EXPOSURE_CALCULATION_FAILED_NAN";
  }
  return null;
}

function assertTrue(cond: boolean, message: string): void {
  assert.strictEqual(cond, true, message);
}

export function runManualPendingStrategyCapTests(): void {
  console.info("=== STARTING MANUAL PENDING STRATEGY CAP TESTS ===");

  // CASE A: Cycle 18 replay — manual ETH pending excluded from strategy account cap
  {
    const expAuth = resolveLiveExposureAuthority({
      symbol: "BTCUSDT",
      okxPositions: [{ symbol: "ETHUSDT", sizeUsd: 2002.5337216800006, side: "long" }],
      paperPositions: [manualEthOperatorPosition as any],
      okxActualPositions: [
        { symbol: "ETHUSDT", sizeUsd: 2002.5337216800006, notionalUsd: 2002.5337216800006, side: "long" }
      ],
      pendingSymbolNotionalUsdt: CYCLE18_MANUAL_ETH_PENDING_NOTIONAL,
      pendingOrdersNotionalUsdt: CYCLE18_MANUAL_ETH_PENDING_NOTIONAL,
      pendingOrdersList: [cycle18ManualEthPending],
      algoOrdersList: [],
      pendingOrdersListAvailable: true,
      isLiveAuthority: true
    });

    assertClose(
      expAuth.operator_pending_notional_usdt,
      CYCLE18_MANUAL_ETH_PENDING_NOTIONAL,
      0.0001,
      "CASE A operator pending"
    );
    assert.strictEqual(expAuth.engine_owned_pending_notional_usdt, 0, "CASE A engine pending 0");
    assert.strictEqual(expAuth.strategy_account_notional_usdt, 0, "CASE A strategy account 0");

    const sizing = runCycle18BtcSizing(expAuth.strategy_account_notional_usdt);
    assert.notStrictEqual(
      sizing.limitingAuthority,
      "account_capacity",
      "CASE A BTC sizing no longer account_capacity bound"
    );
    assert.strictEqual(sizing.limitingAuthority, "risk_based_notional", "CASE A limitingAuthority risk_based_notional");

    console.info(
      JSON.stringify({
        case: "CASE_A_CYCLE18_MANUAL_ETH_PENDING_OPERATOR_ONLY_PASS",
        operator_pending_notional_usdt: expAuth.operator_pending_notional_usdt,
        engine_owned_pending_notional_usdt: expAuth.engine_owned_pending_notional_usdt,
        strategy_account_notional_usdt: expAuth.strategy_account_notional_usdt,
        limitingAuthority: sizing.limitingAuthority
      })
    );
  }

  // CASE B: Same notional BOT pending still consumes account_capacity (~407.50)
  {
    const expAuth = resolveLiveExposureAuthority({
      symbol: "BTCUSDT",
      okxPositions: [],
      paperPositions: [],
      pendingSymbolNotionalUsdt: 0,
      pendingOrdersNotionalUsdt: CYCLE18_MANUAL_ETH_PENDING_NOTIONAL,
      pendingOrdersList: [cycle18BotEthPending],
      algoOrdersList: [],
      pendingOrdersListAvailable: true,
      isLiveAuthority: true
    });

    assertClose(
      expAuth.engine_owned_pending_notional_usdt,
      CYCLE18_MANUAL_ETH_PENDING_NOTIONAL,
      0.0001,
      "CASE B engine pending"
    );
    assert.strictEqual(expAuth.operator_pending_notional_usdt, 0, "CASE B operator pending 0");

    const sizing = runCycle18BtcSizing(expAuth.strategy_account_notional_usdt);
    assert.strictEqual(
      sizing.limitingAuthority,
      "account_capacity",
      "CASE B BTC sizing still account_capacity bound"
    );

    console.info(
      JSON.stringify({
        case: "CASE_B_CYCLE18_BOT_PENDING_STILL_CAPS_ACCOUNT_CAPACITY_PASS",
        engine_owned_pending_notional_usdt: expAuth.engine_owned_pending_notional_usdt,
        strategy_account_notional_usdt: expAuth.strategy_account_notional_usdt,
        limitingAuthority: sizing.limitingAuthority,
        preLotNotionalUsdt: sizing.preLotNotionalUsdt
      })
    );
  }

  // CASE C: fetched successfully + empty per-order list → 0 strategy pending exposure, entry allowed
  {
    const expAuth = resolveLiveExposureAuthority({
      symbol: "BTCUSDT",
      okxPositions: [],
      paperPositions: [],
      pendingSymbolNotionalUsdt: 0,
      pendingOrdersNotionalUsdt: 0,
      pendingOrdersList: [],
      algoOrdersList: [],
      pendingOrdersListAvailable: true,
      isLiveAuthority: true
    });

    assert.strictEqual(expAuth.pending_order_ownership_unavailable, false, "CASE C ownership available");
    assert.strictEqual(expAuth.engine_owned_pending_notional_usdt, 0, "CASE C engine pending 0");
    assert.strictEqual(expAuth.strategy_account_notional_usdt, 0, "CASE C strategy account 0");
    assert.strictEqual(resolveEntryBlockReason(expAuth), null, "CASE C no entry block");

    const sizing = runCycle18BtcSizing(expAuth.strategy_account_notional_usdt);
    assertTrue(sizing.sizingPassed, "CASE C BTC entry sizing allowed");

    console.info(
      JSON.stringify({
        case: "CASE_C_SUCCESSFUL_EMPTY_PENDING_LIST_ZERO_EXPOSURE_PASS",
        strategy_account_notional_usdt: expAuth.strategy_account_notional_usdt,
        sizingPassed: sizing.sizingPassed
      })
    );
  }

  // CASE D: list unavailable + aggregate pending exists → fail-closed
  {
    const expAuth = resolveLiveExposureAuthority({
      symbol: "BTCUSDT",
      okxPositions: [{ symbol: "ETHUSDT", sizeUsd: 2002.5337216800006, side: "long" }],
      paperPositions: [manualEthOperatorPosition as any],
      pendingSymbolNotionalUsdt: CYCLE18_MANUAL_ETH_PENDING_NOTIONAL,
      pendingOrdersNotionalUsdt: CYCLE18_MANUAL_ETH_PENDING_NOTIONAL,
      pendingOrdersListAvailable: false,
      isLiveAuthority: true
    });

    assert.strictEqual(expAuth.pending_order_ownership_unavailable, true, "CASE D ownership unavailable");
    assert.strictEqual(
      resolveEntryBlockReason(expAuth),
      "PENDING_ORDER_OWNERSHIP_UNAVAILABLE",
      "CASE D entry blocked"
    );

    console.info(
      JSON.stringify({
        case: "CASE_D_UNAVAILABLE_PENDING_LIST_FAIL_CLOSED_PASS",
        pending_order_ownership_unavailable: expAuth.pending_order_ownership_unavailable,
        blockReason: resolveEntryBlockReason(expAuth)
      })
    );
  }

  console.info(
    JSON.stringify({
      event: "V2_MANUAL_PENDING_STRATEGY_CAP_ALL_CASES_PASS",
      cases: ["A", "B", "C", "D"]
    })
  );
}

runManualPendingStrategyCapTests();
