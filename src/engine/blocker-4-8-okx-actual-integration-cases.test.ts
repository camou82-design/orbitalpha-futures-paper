/**
 * BLOCKER 4-8 — LIVE EXPOSURE OKX ACTUAL INTEGRATION GAP
 * Regression & Integration test suite
 */

import {
  resolveLiveExposureAuthority,
  analyzePaperExposure
} from "../engine-v2/live-account/exposure-authority";
import { runEngineV2, adaptV2Input } from "../engine-v2/index";
import { buildV2StateBridge } from "./paper-engine";

function run(label: string, passed: boolean, detail: string): boolean {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[BLOCKER-4-8][${label}] ${tag} — ${detail}`);
  return passed;
}

let allOk = true;

// =========================================================================
// CASE A: Manual BTC UNKNOWN paper unit + OKX actual BTC 258 + no BOT V2
// → strategy_account_notional_usdt = 0
// → manual_external_notional_usdt = 258
// → EXPOSURE_CALCULATION_FAILED_NAN = false
// =========================================================================
{
  const manualBtcPaper: any = {
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: undefined,
    strategyVersion: "v2_manual"
  };
  const okxActualList = [
    { symbol: "BTCUSDT", sizeUsd: 258, side: "LONG" }
  ];

  const exposure = resolveLiveExposureAuthority({
    symbol: "ETHUSDT",
    okxPositions: okxActualList,
    paperPositions: [manualBtcPaper],
    okxActualPositions: okxActualList,
    pendingSymbolNotionalUsdt: 0,
    pendingOrdersNotionalUsdt: 0,
    isLiveAuthority: true
  });

  const isNanStrategyAccount = !Number.isFinite(exposure.strategy_account_notional_usdt);
  const isNanStrategySymbol = !Number.isFinite(exposure.strategy_symbol_notional_usdt);

  allOk = run(
    "CASE A - Strategy Account Exposure is 0",
    exposure.strategy_account_notional_usdt === 0,
    `strategy_account_notional_usdt=${exposure.strategy_account_notional_usdt}`
  ) && allOk;

  allOk = run(
    "CASE A - Manual External Exposure is 258",
    exposure.manual_external_notional_usdt === 258,
    `manual_external_notional_usdt=${exposure.manual_external_notional_usdt}`
  ) && allOk;

  allOk = run(
    "CASE A - Excluded Manual Position Count is 1",
    exposure.excluded_manual_position_count === 1,
    `excluded_manual_position_count=${exposure.excluded_manual_position_count}`
  ) && allOk;

  allOk = run(
    "CASE A - No NaN in Exposure Calculation",
    !isNanStrategyAccount && !isNanStrategySymbol,
    `strategyAccountFinite=${!isNanStrategyAccount}, strategySymbolFinite=${!isNanStrategySymbol}`
  ) && allOk;
}

// =========================================================================
// CASE B: Manual BTC 258 + BOT_V2 ETH 100
// → strategy_account_notional_usdt = 100
// → ETH strategy_symbol_notional_usdt = 100
// → manual_external_notional_usdt = 258
// → actual account exposure includes 358 where appropriate
// =========================================================================
{
  const manualBtcPaper: any = {
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: undefined,
    strategyVersion: "v2_manual"
  };
  const botEthPaper: any = {
    symbol: "ETHUSDT",
    side: "long",
    sizeUsd: 100,
    notionalUsd: 100,
    lifecycleState: "BOT_V2_MANAGED"
  };
  const okxActualList = [
    { symbol: "BTCUSDT", sizeUsd: 258, side: "LONG" },
    { symbol: "ETHUSDT", sizeUsd: 100, side: "LONG" }
  ];

  const exposure = resolveLiveExposureAuthority({
    symbol: "ETHUSDT",
    okxPositions: okxActualList,
    paperPositions: [manualBtcPaper, botEthPaper],
    okxActualPositions: okxActualList,
    pendingSymbolNotionalUsdt: 0,
    pendingOrdersNotionalUsdt: 0,
    isLiveAuthority: true
  });

  allOk = run(
    "CASE B - Strategy Account Exposure is 100",
    exposure.strategy_account_notional_usdt === 100,
    `strategy_account_notional_usdt=${exposure.strategy_account_notional_usdt}`
  ) && allOk;

  allOk = run(
    "CASE B - ETH Strategy Symbol Exposure is 100",
    exposure.strategy_symbol_notional_usdt === 100,
    `strategy_symbol_notional_usdt=${exposure.strategy_symbol_notional_usdt}`
  ) && allOk;

  allOk = run(
    "CASE B - Manual External Exposure is 258",
    exposure.manual_external_notional_usdt === 258,
    `manual_external_notional_usdt=${exposure.manual_external_notional_usdt}`
  ) && allOk;

  allOk = run(
    "CASE B - OKX Actual Account Exposure is 358",
    exposure.okx_account_notional_usdt === 358,
    `okx_account_notional_usdt=${exposure.okx_account_notional_usdt}`
  ) && allOk;
}

// =========================================================================
// CASE C: Manual BTC 258 + ETH new entry candidate
// → manual BTC alone must NOT cause MAX_ACCOUNT_NOTIONAL_EXCEEDED
// → manual BTC alone must NOT cause EXPOSURE_CALCULATION_FAILED_NAN
// =========================================================================
{
  const manualBtcPaper: any = {
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: undefined,
    strategyVersion: "v2_manual"
  };
  const okxActualList = [
    { symbol: "BTCUSDT", sizeUsd: 258, side: "LONG" }
  ];

  const exposure = resolveLiveExposureAuthority({
    symbol: "ETHUSDT",
    okxPositions: okxActualList,
    paperPositions: [manualBtcPaper],
    okxActualPositions: okxActualList,
    pendingSymbolNotionalUsdt: 0,
    pendingOrdersNotionalUsdt: 0,
    isLiveAuthority: true
  });

  allOk = run(
    "CASE C - Strategy Account Notional for ETH candidate is 0",
    exposure.strategy_account_notional_usdt === 0,
    `strategy_account_notional_usdt=${exposure.strategy_account_notional_usdt} (Manual BTC excluded from V2 strategy cap)`
  ) && allOk;

  allOk = run(
    "CASE C - No EXPOSURE_CALCULATION_FAILED_NAN for ETH candidate",
    Number.isFinite(exposure.strategy_account_notional_usdt) && Number.isFinite(exposure.strategy_symbol_notional_usdt),
    `account=${exposure.strategy_account_notional_usdt}, symbol=${exposure.strategy_symbol_notional_usdt}`
  ) && allOk;
}

// =========================================================================
// CASE D: Corrupted BOT_V2 + no OKX actual
// → fail closed preserved (strategy_account_notional_usdt = NaN)
// =========================================================================
{
  const corruptedV2Paper: any = {
    symbol: "ETHUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: undefined,
    isV2Authority: true
  };

  const exposure = resolveLiveExposureAuthority({
    symbol: "ETHUSDT",
    okxPositions: [],
    paperPositions: [corruptedV2Paper],
    okxActualPositions: null, // no OKX actual
    pendingSymbolNotionalUsdt: 0,
    pendingOrdersNotionalUsdt: 0,
    isLiveAuthority: true
  });

  allOk = run(
    "CASE D - Corrupted BOT_V2 Fail Closed (NaN)",
    !Number.isFinite(exposure.strategy_account_notional_usdt),
    `strategy_account_notional_usdt=${exposure.strategy_account_notional_usdt}`
  ) && allOk;
}

// =========================================================================
// CASE E: OKX snapshot unavailable
// → fail closed preserved for unknown-unit paper positions
// =========================================================================
{
  const manualBtcPaper: any = {
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: undefined,
    strategyVersion: "v2_manual"
  };

  const exposure = resolveLiveExposureAuthority({
    symbol: "ETHUSDT",
    okxPositions: [],
    paperPositions: [manualBtcPaper],
    okxActualPositions: null, // unavailable snapshot
    pendingSymbolNotionalUsdt: 0,
    pendingOrdersNotionalUsdt: 0,
    isLiveAuthority: true
  });

  allOk = run(
    "CASE E - OKX Snapshot Unavailable Fail Closed (NaN)",
    !Number.isFinite(exposure.strategy_account_notional_usdt),
    `strategy_account_notional_usdt=${exposure.strategy_account_notional_usdt}`
  ) && allOk;
}

// =========================================================================
// CASE F: Runtime integration test via adaptV2Input & runEngineV2
// Verifies live order path threads okxActualPositions into resolveLiveExposureAuthority,
// produces V2_STRATEGY_EXPOSURE_PROOF log with finite values and manual exclusion.
// =========================================================================
{
  const now = Date.now();
  const mockCandlesArray = Array.from({ length: 120 }, (_, i) => {
    const base = 2000 + i * 10;
    return {
      ts: now - (120 - i) * 60000,
      timestamp: now - (120 - i) * 60000,
      open: base,
      high: base + 5,
      low: base - 5,
      close: base + 2,
      volume: 100
    };
  });

  const snapshotAdapter = {
    symbol: "ETHUSDT",
    lastPrice: 3000,
    latestCandleClose: 3000,
    qualityScore: 95,
    volatilityProxy: 10,
    volatilityProxyDiag: 10,
    emaGap: 50,
    emaGapDiag: 50,
    rangeConfidence: 0.1,
    rangeConfidenceDiag: 0.1,
    boxHigh: 3200,
    boxLow: 2800,
    boxPos: 0.5,
    boxPosDiag: 0.5,
    ema20: 3000,
    boxCohesion01: 0.9,
    breakoutFailureRate: 0.05,
    candles: mockCandlesArray,
    htf_candles: {
      "5m": mockCandlesArray,
      "15m": mockCandlesArray,
      "1h": mockCandlesArray,
      "4h": mockCandlesArray,
      "1d": mockCandlesArray
    }
  } as any;

  const config = {
    symbol: "ETHUSDT",
    leverage: 10,
    okxLiveEnabled: true,
    okxAuthMode: "live" as const,
    okxLiveAuthMode: "live",
    okxExchangeAuthOptIn: true,
    okxLiveExchangeAuthOptIn: true,
    okxAuthReady: true,
    okxApiKey: "test_key",
    okxApiSecret: "test_secret",
    okxPassphrase: "test_passphrase",
    okxDemoApiKey: "test_key",
    okxDemoApiSecret: "test_secret",
    okxDemoPassphrase: "test_passphrase",
    serverTradeEnabled: true,
    okxLiveMaxOrderNotionalUsdt: 200,
    okxLiveMaxSymbolNotionalUsdt: 300,
    okxLiveMaxAccountNotionalUsdt: 500,
    okxLiveMarginReserveRatio: 0.2,
    okxLiveInstrumentSizing: { lotSz: 0.1, minSz: 0.1, ctVal: 0.1, ctValCcy: "ETH" },
    okxAccountConfigOk: true,
    okxBalanceOk: true
  };

  const defaultQualityProfiles = {
    profit: { qualityScoreAvg: 90, emaGapAvg: 10, atrPctAvg: 0.01, volumeRatioAvg: 1, count: 5 },
    loss: { qualityScoreAvg: 50, emaGapAvg: 5, atrPctAvg: 0.01, volumeRatioAvg: 1, count: 1 },
    contaminated: { qualityScoreAvg: 0, emaGapAvg: 0, atrPctAvg: 0, volumeRatioAvg: 0, count: 0 }
  };

  // Manual BTC paper record (unknown unit)
  const manualBtcPaper = {
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: undefined,
    strategyVersion: "v2_manual",
    status: "open"
  };

  // OKX actual position snapshot (Manual BTC 258 USDT in OKX raw REST row format)
  const okxActualPositionsPayload = [
    { instId: "BTC-USDT-SWAP", pos: "1", posSide: "long", notionalUsd: 258, avgPx: 90000 }
  ];

  const bridgeState = buildV2StateBridge(
    [manualBtcPaper] as any,
    null,
    config as any,
    true, // paperExecutionReady
    true, // signedExecutionReady
    false,
    false,
    1,
    1,
    defaultQualityProfiles,
    { server_trade_enabled: true, close_only_mode: false, kill_switch_active: false, authority_source: "server_state" as const, updated_at: now, reason: null },
    false,
    okxActualPositionsPayload,
    true,  // liveBalanceReady
    500,   // okxWalletBalanceUsdt
    450,   // okxAvailableBalanceUsdt
    true,  // okxPositionsOk
    true,  // okxPendingOrdersReady
    0,     // pendingOrdersNotionalUsdt
    0,     // pendingSymbolNotionalUsdt
    now,   // balanceFetchedAt
    now,   // positionsFetchedAt
    now    // pendingOrdersFetchedAt
  );

  const v1Result = {
    decision: { final_decision: "ENTER", regime_state: "TREND" },
    intentSide: "long",
    adaptiveOk: true,
    regime: "TREND",
    side: "long",
    isBlocked: false
  } as any;

  const v2Input = adaptV2Input(
    "ETHUSDT" as any,
    now,
    snapshotAdapter,
    config as any,
    bridgeState as any,
    v1Result
  );

  // Capture proof logs
  const proofLogs: any[] = [];
  const origInfo = console.info;
  console.info = (msg: any) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed && typeof parsed.event === "string") {
        proofLogs.push(parsed);
      }
    } catch {}
    origInfo(msg);
  };

  let v2Outcome: any;
  try {
    v2Outcome = runEngineV2(v2Input);
  } finally {
    console.info = origInfo;
  }

  const strategyExposureProof = proofLogs.find((l) => l.event === "V2_STRATEGY_EXPOSURE_PROOF");

  allOk = run(
    "CASE F - V2_STRATEGY_EXPOSURE_PROOF log emitted",
    strategyExposureProof != null,
    strategyExposureProof ? `Found proof for ${strategyExposureProof.symbol}` : "NOT FOUND"
  ) && allOk;

  if (strategyExposureProof) {
    allOk = run(
      "CASE F - Proof strategy_account_notional_usdt is finite & 0",
      strategyExposureProof.strategy_account_notional_usdt === 0,
      `strategy_account_notional_usdt=${strategyExposureProof.strategy_account_notional_usdt}`
    ) && allOk;

    allOk = run(
      "CASE F - Proof strategy_symbol_notional_usdt is finite & 0",
      strategyExposureProof.strategy_symbol_notional_usdt === 0,
      `strategy_symbol_notional_usdt=${strategyExposureProof.strategy_symbol_notional_usdt}`
    ) && allOk;

    allOk = run(
      "CASE F - Proof okx_actual_account_notional_usdt is finite & 258",
      strategyExposureProof.okx_actual_account_notional_usdt === 258,
      `okx_actual_account_notional_usdt=${strategyExposureProof.okx_actual_account_notional_usdt}`
    ) && allOk;

    allOk = run(
      "CASE F - Proof manual_external_notional_usdt is finite & 258",
      strategyExposureProof.manual_external_notional_usdt === 258,
      `manual_external_notional_usdt=${strategyExposureProof.manual_external_notional_usdt}`
    ) && allOk;

    allOk = run(
      "CASE F - Proof excluded_manual_position_count is 1",
      strategyExposureProof.excluded_manual_position_count === 1,
      `excluded_manual_position_count=${strategyExposureProof.excluded_manual_position_count}`
    ) && allOk;
  }

  const finalDecision = v2Outcome.decision.executionAction;
  allOk = run(
    "CASE F - Execution Action is ENTER (Not REJECT by NaN)",
    finalDecision === "ENTER",
    `executionAction=${finalDecision}, rejectReason=${v2Outcome.internal?.min_order_block_reason ?? "none"}`
  ) && allOk;
}

console.log("\n=== BLOCKER 4-8 SUMMARY ===");
if (allOk) {
  console.log("ALL_RELEVANT_REGRESSION = PASS");
  console.log("READY_TO_COMMIT_BLOCKER_4_8 = YES");
} else {
  console.error("ALL_RELEVANT_REGRESSION = FAIL");
  console.error("READY_TO_COMMIT_BLOCKER_4_8 = NO");
  process.exit(1);
}
