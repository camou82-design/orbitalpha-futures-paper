/**
 * BLOCKER 4-19 — Pending Order Readiness / Exposure Authority Separation Tests
 *
 * Tests:
 * 1. ZERO_PENDING_READY_PASS
 * 2. BTC_PENDING_ENTRY_ETH_READINESS_UNAFFECTED_PASS
 * 3. BTC_PENDING_ENTRY_BTC_DUPLICATE_BLOCK_PASS
 * 4. ACCOUNT_PENDING_NOTIONAL_CAP_PASS
 * 5. SYMBOL_PENDING_NOTIONAL_CAP_PASS
 * 6. REDUCE_ONLY_PENDING_NOT_COUNTED_AS_EXPOSURE_PASS
 * 7. BOT_PROTECTIVE_PENDING_NOT_COUNTED_AS_EXPOSURE_PASS
 * 8. PENDING_FETCH_ERROR_FAIL_CLOSED_PASS
 * 9. UNKNOWN_PENDING_NOTIONAL_FAIL_CLOSED_PASS
 */

import { resolvePendingOrdersExposure } from "./position-ops-monitor";
import { runEngineV2, adaptV2Input } from "../engine-v2";
import type { EngineV2Input } from "../engine-v2/types";

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  if (!value) throw new Error(`[FAIL] ${label}: expected true`);
}

function createBaseInput(symbol: "BTCUSDT" | "ETHUSDT"): EngineV2Input {
  const now = Date.now();
  const lastPrice = symbol === "BTCUSDT" ? 60000 : 3000;
  return {
    symbol,
    now,
    evaluationMode: "authoritative",
    snapshot: {
      lastPrice,
      latestCandleClose: lastPrice,
      boxHigh: lastPrice * 1.02,
      boxLow: lastPrice * 0.98,
      boxPos: 0.5,
      rangeConfidence: 0.75,
      ema20: lastPrice,
      emaGap: 0.001,
      volatilityProxy: lastPrice * 0.01,
      boxCohesion01: 0.7,
      breakoutFailureRate: 0.1,
      trendWeaknessScore: 0.1,
      rangeOscillationScore: 0.4,
      boxBreakSide: "none",
      signal: "paper_long_candidate",
      qualityScore: 85,
      data_ready: true,
      atr: lastPrice * 0.01,
      volumeExpansion: 1.0,
      atrExpansion: 1.0,
      candles: []
    } as any,
    config: {
      okxLiveMaxOrderNotionalUsdt: 100000,
      okxLiveMaxSymbolNotionalUsdt: 200000,
      okxLiveMaxAccountNotionalUsdt: 500000,
      okxLiveMarginReserveRatio: 0.2,
      okxAuthMode: "live",
      okxLiveEnabled: true,
      okxExchangeAuthOptIn: true,
      paperExecutionReady: true,
      signedExecutionReady: true
    } as any,
    state: {
      currentPositions: [],
      lossStreaks: {},
      globalRiskScore: 0.5,
      directionalShockState: "NONE",
      longAllow: true,
      shortAllow: true,
      executionReadiness: true,
      paperExecutionReady: true,
      signedExecutionReady: true,
      okxAuthMode: "live",
      okxAuthReady: true,
      okxLiveEnabled: true,
      okxExchangeAuthOptIn: true,
      okxApiKeyPresent: true,
      okxApiSecretPresent: true,
      okxPassphrasePresent: true,
      liveBalanceReady: true,
      accountEquityUsdt: 100000,
      availableBalanceUsdt: 80000,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true,
      okxActualPositions: [],
      okxPendingOrdersReady: true,
      okxPendingOrdersNotionalUsdt: 0,
      okxPendingSymbolNotionalUsdt: 0,
      balanceFetchedAt: now - 1000,
      positionsFetchedAt: now - 1000,
      pendingOrdersFetchedAt: now - 1000,
      freshTickBarrierActive: false,
      freshTickCompletedCycles: 6,
      freshTickRequiredCycles: 6,
      hasSymbolPendingEntry: false,
      hasUnknownPendingNotional: false
    } as any,
    v1Result: {
      regime: "RANGE",
      decision: "PROCEED",
      side: "long",
      isBlocked: false
    }
  };
}

// -------------------------------------------------------------------------
// 1. ZERO_PENDING_READY_PASS
// -------------------------------------------------------------------------
function testZeroPendingReady(): void {
  const analysis = resolvePendingOrdersExposure({
    pending: [],
    algos: [],
    opens: [],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  assertTrue(analysis.pendingFetchReady, "pendingFetchReady is true");
  assertTrue(analysis.pendingPayloadEmpty, "pendingPayloadEmpty is true");
  assertEq(analysis.accountPendingNotionalUsdt, 0, "accountPendingNotionalUsdt is 0");
  assertEq(analysis.blockingPendingCount, 0, "blockingPendingCount is 0");
  assertEq(analysis.blockingAlgosCount, 0, "blockingAlgosCount is 0");

  const input = createBaseInput("ETHUSDT");
  const res = runEngineV2(input);
  assertTrue(res.decision.decision !== "DISABLED", "EngineV2 decision enabled");

  console.info(JSON.stringify({ status: "PASS", label: "ZERO_PENDING_READY_PASS" }));
}

// -------------------------------------------------------------------------
// 2. BTC_PENDING_ENTRY_ETH_READINESS_UNAFFECTED_PASS
// -------------------------------------------------------------------------
function testBtcPendingEntryEthReadinessUnaffected(): void {
  // BTC has 1 limit entry order
  const btcOrder = {
    instId: "BTC-USDT-SWAP",
    ordId: "ord_btc_1",
    clOrdId: "cl_btc_1",
    side: "buy",
    posSide: "net",
    reduceOnly: "false",
    ordType: "limit",
    state: "live",
    sz: "10", // 10 contracts * 0.01 BTC = 0.1 BTC
    px: "60000" // 0.1 BTC * 60000 = 6000 USDT notional
  };

  const analysis = resolvePendingOrdersExposure({
    pending: [btcOrder],
    algos: [],
    opens: [],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  assertTrue(analysis.pendingFetchReady, "pendingFetchReady is true despite pending order");
  assertTrue(!analysis.pendingPayloadEmpty, "pendingPayloadEmpty is false");
  assertEq(analysis.accountPendingNotionalUsdt, 6000, "accountPendingNotionalUsdt is 6000");
  assertEq(analysis.symbolPendingNotionalUsdt["BTCUSDT"], 6000, "BTC symbol pending notional is 6000");
  assertEq(analysis.symbolPendingNotionalUsdt["ETHUSDT"] ?? 0, 0, "ETH symbol pending notional is 0");
  assertTrue(analysis.symbolHasBlockingPending["BTCUSDT"], "BTC has blocking pending");
  assertTrue(!analysis.symbolHasBlockingPending["ETHUSDT"], "ETH has NO blocking pending");

  // Run EngineV2 for ETH
  const ethInput = createBaseInput("ETHUSDT");
  ethInput.state.okxPendingOrdersReady = analysis.pendingFetchReady;
  ethInput.state.okxPendingOrdersNotionalUsdt = analysis.accountPendingNotionalUsdt;
  ethInput.state.okxPendingSymbolNotionalUsdt = analysis.symbolPendingNotionalUsdt["ETHUSDT"] ?? 0;
  (ethInput.state as any).hasSymbolPendingEntry = analysis.symbolHasBlockingPending["ETHUSDT"] === true;

  const ethRes = runEngineV2(ethInput);
  assertTrue(ethRes.internal.riskSizing.blockReason !== "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "ETH not blocked by LIVE_ACCOUNT_AUTHORITY_NOT_READY");
  assertTrue(ethRes.internal.riskSizing.blockReason !== "PENDING_ORDER_EXISTS", "ETH not blocked by PENDING_ORDER_EXISTS");

  console.info(JSON.stringify({ status: "PASS", label: "BTC_PENDING_ENTRY_ETH_READINESS_UNAFFECTED_PASS" }));
}

// -------------------------------------------------------------------------
// 3. BTC_PENDING_ENTRY_BTC_DUPLICATE_BLOCK_PASS
// -------------------------------------------------------------------------
function testBtcPendingEntryBtcDuplicateBlock(): void {
  const btcOrder = {
    instId: "BTC-USDT-SWAP",
    ordId: "ord_btc_1",
    clOrdId: "cl_btc_1",
    side: "buy",
    posSide: "net",
    reduceOnly: "false",
    ordType: "limit",
    state: "live",
    sz: "10",
    px: "60000"
  };

  const analysis = resolvePendingOrdersExposure({
    pending: [btcOrder],
    algos: [],
    opens: [],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  // Run EngineV2 for BTC
  const btcInput = createBaseInput("BTCUSDT");
  btcInput.state.okxPendingOrdersReady = analysis.pendingFetchReady;
  btcInput.state.okxPendingOrdersNotionalUsdt = analysis.accountPendingNotionalUsdt;
  btcInput.state.okxPendingSymbolNotionalUsdt = analysis.symbolPendingNotionalUsdt["BTCUSDT"];
  (btcInput.state as any).hasSymbolPendingEntry = analysis.symbolHasBlockingPending["BTCUSDT"] === true;

  const btcRes = runEngineV2(btcInput);
  assertEq(btcRes.internal.riskSizing.blockReason, "PENDING_ORDER_EXISTS", "BTC is blocked specifically by PENDING_ORDER_EXISTS");

  console.info(JSON.stringify({ status: "PASS", label: "BTC_PENDING_ENTRY_BTC_DUPLICATE_BLOCK_PASS" }));
}

// -------------------------------------------------------------------------
// 4. ACCOUNT_PENDING_NOTIONAL_CAP_PASS
// -------------------------------------------------------------------------
function testAccountPendingNotionalCap(): void {
  // Massive BTC order consuming account cap
  const btcOrder = {
    instId: "BTC-USDT-SWAP",
    ordId: "ord_btc_huge",
    side: "buy",
    reduceOnly: "false",
    ordType: "limit",
    sz: "900", // 9 BTC * 60,000 = 540,000 USDT (exceeds 500,000 account cap)
    px: "60000"
  };

  const analysis = resolvePendingOrdersExposure({
    pending: [btcOrder],
    algos: [],
    opens: [],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  assertEq(analysis.accountPendingNotionalUsdt, 540000, "Account pending notional is 540000");

  const ethInput = createBaseInput("ETHUSDT");
  ethInput.config.okxLiveMaxAccountNotionalUsdt = 500000;
  ethInput.state.okxPendingOrdersReady = analysis.pendingFetchReady;
  ethInput.state.okxPendingOrdersNotionalUsdt = analysis.accountPendingNotionalUsdt;
  ethInput.state.okxPendingSymbolNotionalUsdt = 0;
  (ethInput.state as any).hasSymbolPendingEntry = false;

  const ethRes = runEngineV2(ethInput);
  assertEq(ethRes.internal.riskSizing.blockReason, "MAX_ACCOUNT_NOTIONAL_EXCEEDED", "ETH blocked by MAX_ACCOUNT_NOTIONAL_EXCEEDED");

  console.info(JSON.stringify({ status: "PASS", label: "ACCOUNT_PENDING_NOTIONAL_CAP_PASS" }));
}

// -------------------------------------------------------------------------
// 5. SYMBOL_PENDING_NOTIONAL_CAP_PASS
// -------------------------------------------------------------------------
function testSymbolPendingNotionalCap(): void {
  // ETH order consuming symbol cap
  const ethOrder = {
    instId: "ETH-USDT-SWAP",
    ordId: "ord_eth_large",
    side: "buy",
    reduceOnly: "false",
    ordType: "limit",
    sz: "7000", // 700 ETH * 3000 = 2,100,000 USDT (exceeds 200,000 symbol cap)
    px: "3000"
  };

  const analysis = resolvePendingOrdersExposure({
    pending: [ethOrder],
    algos: [],
    opens: [],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  assertEq(analysis.symbolPendingNotionalUsdt["ETHUSDT"], 2100000, "ETH pending notional is 2,100,000");

  const ethInput = createBaseInput("ETHUSDT");
  ethInput.config.okxLiveMaxSymbolNotionalUsdt = 200000;
  ethInput.config.okxLiveMaxAccountNotionalUsdt = 5000000; // Account cap generous
  ethInput.state.okxPendingOrdersReady = analysis.pendingFetchReady;
  ethInput.state.okxPendingOrdersNotionalUsdt = analysis.accountPendingNotionalUsdt;
  ethInput.state.okxPendingSymbolNotionalUsdt = analysis.symbolPendingNotionalUsdt["ETHUSDT"];
  (ethInput.state as any).hasSymbolPendingEntry = false; // Bypass duplicate check to test sizing cap directly

  const ethRes = runEngineV2(ethInput);
  assertEq(ethRes.internal.riskSizing.blockReason, "MAX_SYMBOL_NOTIONAL_EXCEEDED", "ETH blocked by MAX_SYMBOL_NOTIONAL_EXCEEDED");

  console.info(JSON.stringify({ status: "PASS", label: "SYMBOL_PENDING_NOTIONAL_CAP_PASS" }));
}

// -------------------------------------------------------------------------
// 6. REDUCE_ONLY_PENDING_NOT_COUNTED_AS_EXPOSURE_PASS
// -------------------------------------------------------------------------
function testReduceOnlyPendingNotCountedAsExposure(): void {
  const reduceOrder = {
    instId: "BTC-USDT-SWAP",
    ordId: "ord_reduce_1",
    side: "sell",
    posSide: "long",
    reduceOnly: "true",
    ordType: "limit",
    state: "live",
    sz: "50",
    px: "65000"
  };

  const analysis = resolvePendingOrdersExposure({
    pending: [reduceOrder],
    algos: [],
    opens: [],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  assertTrue(analysis.pendingFetchReady, "Fetch ready is true");
  assertEq(analysis.accountPendingNotionalUsdt, 0, "Reduce only pending notional is 0");
  assertEq(analysis.symbolPendingNotionalUsdt["BTCUSDT"] ?? 0, 0, "Symbol pending notional is 0");
  assertTrue(!analysis.symbolHasBlockingPending["BTCUSDT"], "Reduce only does not create blocking pending");

  console.info(JSON.stringify({ status: "PASS", label: "REDUCE_ONLY_PENDING_NOT_COUNTED_AS_EXPOSURE_PASS" }));
}

// -------------------------------------------------------------------------
// 7. BOT_PROTECTIVE_PENDING_NOT_COUNTED_AS_EXPOSURE_PASS
// -------------------------------------------------------------------------
function testBotProtectivePendingNotCountedAsExposure(): void {
  const opens: any = [{
    symbol: "BTCUSDT",
    side: "LONG",
    protectiveSlAlgoId: "algo_sl_123"
  }];

  const slAlgo = {
    instId: "BTC-USDT-SWAP",
    algoId: "algo_sl_123",
    side: "sell",
    posSide: "long",
    reduceOnly: "true",
    algoType: "conditional",
    state: "live",
    sz: "10",
    slTriggerPx: "59000"
  };

  const analysis = resolvePendingOrdersExposure({
    pending: [],
    algos: [slAlgo],
    opens,
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  assertEq(analysis.botManagedProtectiveCount, 1, "Detected as bot managed protection");
  assertEq(analysis.blockingAlgosCount, 0, "Not a blocking algo");
  assertEq(analysis.accountPendingNotionalUsdt, 0, "Protective algo pending notional is 0");

  console.info(JSON.stringify({ status: "PASS", label: "BOT_PROTECTIVE_PENDING_NOT_COUNTED_AS_EXPOSURE_PASS" }));
}

// -------------------------------------------------------------------------
// 8. PENDING_FETCH_ERROR_FAIL_CLOSED_PASS
// -------------------------------------------------------------------------
function testPendingFetchErrorFailClosed(): void {
  const analysis = resolvePendingOrdersExposure({
    pending: [],
    algos: [],
    opens: [],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 1, // Error during fetch
    cachedOpsPendingIsArray: false,
    cachedOpsAlgosIsArray: false
  });

  assertTrue(!analysis.pendingFetchReady, "pendingFetchReady is false on fetch error");

  const input = createBaseInput("BTCUSDT");
  input.state.okxPendingOrdersReady = analysis.pendingFetchReady;

  const res = runEngineV2(input);
  assertEq(res.internal.riskSizing.blockReason, "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Fail closed with LIVE_ACCOUNT_AUTHORITY_NOT_READY");

  console.info(JSON.stringify({ status: "PASS", label: "PENDING_FETCH_ERROR_FAIL_CLOSED_PASS" }));
}

// -------------------------------------------------------------------------
// 9. UNKNOWN_PENDING_NOTIONAL_FAIL_CLOSED_PASS
// -------------------------------------------------------------------------
function testUnknownPendingNotionalFailClosed(): void {
  // Order with missing/invalid price and 0 sz
  const badOrder = {
    instId: "BTC-USDT-SWAP",
    ordId: "bad_ord_1",
    side: "buy",
    reduceOnly: "false",
    ordType: "market",
    sz: "0", // Invalid size
    px: "" // Missing price
  };

  const analysis = resolvePendingOrdersExposure({
    pending: [badOrder],
    algos: [],
    opens: [],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  assertTrue(analysis.hasUnknownNotional, "hasUnknownNotional is true for unresolvable order");

  const input = createBaseInput("BTCUSDT");
  input.state.okxPendingOrdersReady = analysis.pendingFetchReady;
  (input.state as any).hasUnknownPendingNotional = analysis.hasUnknownNotional;

  const res = runEngineV2(input);
  assertEq(res.internal.riskSizing.blockReason, "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Fail closed on unknown pending notional");

  console.info(JSON.stringify({ status: "PASS", label: "UNKNOWN_PENDING_NOTIONAL_FAIL_CLOSED_PASS" }));
}

// -------------------------------------------------------------------------
// 10. ORDINARY_ENTRY_WITH_BOTLIKE_ID_COUNTS_AS_EXPOSURE_PASS
// -------------------------------------------------------------------------
function testOrdinaryEntryWithBotlikeIdCountsAsExposure(): void {
  // An entry order that has bot-like id but reduceOnly: false
  const botlikeEntryOrder = {
    instId: "BTC-USDT-SWAP",
    ordId: "ord_botlike_1",
    clOrdId: "oap_bot_entry_999", // Bot-like clOrdId
    side: "buy",
    posSide: "net",
    reduceOnly: "false",
    ordType: "limit",
    state: "live",
    sz: "10", // 0.1 BTC
    px: "60000" // 6000 USDT
  };

  const analysis = resolvePendingOrdersExposure({
    pending: [botlikeEntryOrder],
    algos: [],
    opens: [],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  assertTrue(analysis.ordersDetail[0].exposureIncreasing, "Must be exposure increasing despite bot-like ID");
  assertEq(analysis.ordersDetail[0].purpose, "entry-purpose", "Must be entry-purpose, not protective");
  assertEq(analysis.accountPendingNotionalUsdt, 6000, "Must count 6000 USDT towards account pending notional");

  console.info(JSON.stringify({ status: "PASS", label: "ORDINARY_ENTRY_WITH_BOTLIKE_ID_COUNTS_AS_EXPOSURE_PASS" }));
}

// -------------------------------------------------------------------------
// 11. PROTECTIVE_REDUCE_ONLY_ZERO_EXPOSURE_PASS
// -------------------------------------------------------------------------
function testProtectiveReduceOnlyZeroExposure(): void {
  const opens: any = [{
    symbol: "BTCUSDT",
    side: "LONG",
    protectiveSlAlgoId: "algo_sl_777"
  }];

  const slAlgo = {
    instId: "BTC-USDT-SWAP",
    algoId: "algo_sl_777",
    side: "sell",
    posSide: "long",
    reduceOnly: "true",
    algoType: "conditional",
    state: "live",
    sz: "10",
    slTriggerPx: "59000"
  };

  const analysis = resolvePendingOrdersExposure({
    pending: [],
    algos: [slAlgo],
    opens,
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  assertTrue(!analysis.ordersDetail[0].exposureIncreasing, "Protective order must not increase exposure");
  assertEq(analysis.ordersDetail[0].resolvedNotionalUsdt, 0, "Protective order resolved notional is 0");
  assertEq(analysis.accountPendingNotionalUsdt, 0, "Account pending notional is 0");

  console.info(JSON.stringify({ status: "PASS", label: "PROTECTIVE_REDUCE_ONLY_ZERO_EXPOSURE_PASS" }));
}

// -------------------------------------------------------------------------
// 12. PROTECTIVE_CLASSIFICATION_REQUIRES_AUTHORITATIVE_EVIDENCE_PASS
// -------------------------------------------------------------------------
function testProtectiveClassificationRequiresAuthoritativeEvidence(): void {
  // An order claiming to be SL by name/clOrdId but without reduceOnly
  const fakeProtectiveOrder = {
    instId: "BTC-USDT-SWAP",
    algoId: "fake_sl_1",
    algoClOrdId: "oap_sl_fake",
    side: "sell",
    posSide: "long",
    reduceOnly: "false", // FALSE!
    algoType: "conditional",
    state: "live",
    sz: "10",
    slTriggerPx: "59000"
  };

  const analysis = resolvePendingOrdersExposure({
    pending: [],
    algos: [fakeProtectiveOrder],
    opens: [],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  // Since reduceOnly is false, it CANNOT be recognized as bot managed protection
  assertTrue(analysis.ordersDetail[0].exposureIncreasing, "Order without reduceOnly must be treated as exposure-increasing");
  assertEq(analysis.blockingAlgosCount, 1, "Counted as blocking algo, not bot protective");
  assertEq(analysis.botManagedProtectiveCount, 0, "Not recognized as bot managed protection");

  console.info(JSON.stringify({ status: "PASS", label: "PROTECTIVE_CLASSIFICATION_REQUIRES_AUTHORITATIVE_EVIDENCE_PASS" }));
}

// -------------------------------------------------------------------------
// 13. UNKNOWN_PURPOSE_FAIL_CLOSED_PASS
// -------------------------------------------------------------------------
function testUnknownPurposeFailClosed(): void {
  // Corrupted unclassifiable order without price or size
  const unknownOrder = {
    instId: "BTC-USDT-SWAP",
    ordId: "corrupt_1",
    reduceOnly: "false",
    sz: "0",
    px: ""
  };

  const analysis = resolvePendingOrdersExposure({
    pending: [unknownOrder],
    algos: [],
    opens: [],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true
  });

  assertTrue(analysis.hasUnknownNotional, "Must flag hasUnknownNotional = true");

  const input = createBaseInput("BTCUSDT");
  input.state.okxPendingOrdersReady = analysis.pendingFetchReady;
  (input.state as any).hasUnknownPendingNotional = analysis.hasUnknownNotional;

  const res = runEngineV2(input);
  assertEq(res.internal.riskSizing.blockReason, "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "Must fail closed with LIVE_ACCOUNT_AUTHORITY_NOT_READY");

  console.info(JSON.stringify({ status: "PASS", label: "UNKNOWN_PURPOSE_FAIL_CLOSED_PASS" }));
}

// -------------------------------------------------------------------------
// 14. PRODUCTION_LIKE_BTC_PENDING_ETH_UNAFFECTED_PASS
// -------------------------------------------------------------------------
function testProductionLikeBtcPendingEthUnaffected(): void {
  // Production scenario:
  // BTC: no position, 1 pending limit BUY (10 contracts * 0.01 BTC * 60,000 = 6,000 USDT)
  // ETH: no position, 0 pending orders
  const btcPendingOrder = {
    instId: "BTC-USDT-SWAP",
    ordId: "okx_ord_btc_prod_1",
    clOrdId: "oap_e_btc_123",
    side: "buy",
    posSide: "net",
    reduceOnly: "false",
    ordType: "limit",
    state: "live",
    sz: "10",
    px: "60000"
  };

  const analysis = resolvePendingOrdersExposure({
    pending: [btcPendingOrder],
    algos: [],
    opens: [],
    pendingFetchPerformed: true,
    pendingFetchErrorsCount: 0,
    cachedOpsPendingIsArray: true,
    cachedOpsAlgosIsArray: true,
    snapshotPrices: { "BTCUSDT": 60000, "ETHUSDT": 3000 }
  });

  // Proof assertions:
  assertTrue(analysis.pendingFetchReady, "Pending data readiness is true");
  assertEq(analysis.accountPendingNotionalUsdt, 6000, "Account pending notional includes BTC order (6000 USDT)");
  assertEq(analysis.symbolPendingNotionalUsdt["BTCUSDT"], 6000, "BTC pendingSymbolNotional > 0");
  assertEq(analysis.symbolPendingNotionalUsdt["ETHUSDT"] ?? 0, 0, "ETH pendingSymbolNotional = 0");

  // 1. Evaluate BTC
  const btcInput = createBaseInput("BTCUSDT");
  btcInput.state.okxPendingOrdersReady = analysis.pendingFetchReady;
  btcInput.state.okxPendingOrdersNotionalUsdt = analysis.accountPendingNotionalUsdt;
  btcInput.state.okxPendingSymbolNotionalUsdt = analysis.symbolPendingNotionalUsdt["BTCUSDT"];
  (btcInput.state as any).hasSymbolPendingEntry = analysis.symbolHasBlockingPending["BTCUSDT"] === true;

  const btcRes = runEngineV2(btcInput);
  assertEq(btcRes.internal.riskSizing.blockReason, "PENDING_ORDER_EXISTS", "BTC is blocked by PENDING_ORDER_EXISTS");

  // 2. Evaluate ETH
  const ethInput = createBaseInput("ETHUSDT");
  ethInput.state.okxPendingOrdersReady = analysis.pendingFetchReady;
  ethInput.state.okxPendingOrdersNotionalUsdt = analysis.accountPendingNotionalUsdt;
  ethInput.state.okxPendingSymbolNotionalUsdt = analysis.symbolPendingNotionalUsdt["ETHUSDT"] ?? 0;
  (ethInput.state as any).hasSymbolPendingEntry = analysis.symbolHasBlockingPending["ETHUSDT"] === true;

  const ethRes = runEngineV2(ethInput);
  assertTrue(ethRes.internal.riskSizing.blockReason !== "LIVE_ACCOUNT_AUTHORITY_NOT_READY", "ETH does NOT encounter LIVE_ACCOUNT_AUTHORITY_NOT_READY");
  assertTrue(ethRes.internal.riskSizing.blockReason !== "PENDING_ORDER_EXISTS", "ETH does NOT encounter PENDING_ORDER_EXISTS");

  console.info(JSON.stringify({ status: "PASS", label: "PRODUCTION_LIKE_BTC_PENDING_ETH_UNAFFECTED_PASS" }));
}

function runAllTests(): void {
  console.info("=== RUNNING BLOCKER 4-19 PENDING READINESS & EXPOSURE REGRESSION TESTS ===");
  testZeroPendingReady();
  testBtcPendingEntryEthReadinessUnaffected();
  testBtcPendingEntryBtcDuplicateBlock();
  testAccountPendingNotionalCap();
  testSymbolPendingNotionalCap();
  testReduceOnlyPendingNotCountedAsExposure();
  testBotProtectivePendingNotCountedAsExposure();
  testPendingFetchErrorFailClosed();
  testUnknownPendingNotionalFailClosed();
  testOrdinaryEntryWithBotlikeIdCountsAsExposure();
  testProtectiveReduceOnlyZeroExposure();
  testProtectiveClassificationRequiresAuthoritativeEvidence();
  testUnknownPurposeFailClosed();
  testProductionLikeBtcPendingEthUnaffected();
  console.info("=== ALL BLOCKER 4-19 REGRESSION TESTS PASSED ===");
}

runAllTests();

