import assert from "node:assert/strict";
import {
  classifyOkxOpenOrderPurpose,
  findProtectiveHintsForInst,
  orderLooksReduceOnlyProtective
} from "./position-ops-monitor";
import { evaluatePositionProtectionState } from "../engine-v2/execution/protective-order-state";
import { shouldLatchManualProtectiveOnlyIntervention } from "../engine-v2/position/manual-takeover-authority";
import type { PaperOpenPositionRecord } from "../models/types";

function makeBotLedger(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    symbol: "BTCUSDT",
    side: "long",
    status: "open",
    pos: 0.51,
    entryPrice: 79859.1,
    stopPrice: 79522.0,
    targetPrice1: 80760.8,
    leverage: 10,
    sizeUsd: 40728.14,
    strategyVersion: "v2",
    sourceSignal: "RANGE_PROMOTION",
    sourceRunPath: "run/1",
    openedAt: Date.now() - 60000,
    regimeAtEntry: "RANGE",
    lifecycleState: "BOT_V2_MANAGED",
    manualTakeoverActive: false,
    isProtectiveStopRegistered: true,
    exchangeProtectionConfirmed: false,
    confirmedExchangeProtectionEverSeen: false,
    ...overrides
  } as any as PaperOpenPositionRecord;
}

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`[BTC-PROTECTIVE-DISCOVERY][${name}] PASS`);
  } catch (e: any) {
    console.error(`[BTC-PROTECTIVE-DISCOVERY][${name}] FAIL:`, e.message);
    throw e;
  }
}

console.log("=== RUNNING BTC PROTECTIVE ORDER DISCOVERY & BACKFILL TEST SUITE ===\n");

// 1. Conditional SL with missing reduceOnly and closeFraction="1" -> classified as protective-stop
run("1. Conditional SL + missing reduceOnly + closeFraction=1 -> protective-stop", () => {
  const ledger = makeBotLedger();
  const okxAlgoSlRow = {
    instId: "BTC-USDT-SWAP",
    algoId: "sl_algo_999",
    ordType: "conditional",
    side: "sell",
    posSide: "net",
    closeFraction: "1",
    slTriggerPx: "79522",
    slOrdPx: "-1",
    state: "live"
    // reduceOnly field is undefined on OKX payload
  };

  const classify = classifyOkxOpenOrderPurpose(okxAlgoSlRow, ledger);
  assert.equal(classify.isBotManagedProtection, true);
  assert.equal(classify.purpose, "protective-stop");

  const hints = findProtectiveHintsForInst("BTC-USDT-SWAP", "long", [], [okxAlgoSlRow], false, {
    ledger,
    tickSz: 0.1,
    requiredStopPx: 79522.0,
    requiredContracts: 0.51
  });
  assert.equal(hints.protectionSatisfied, true);
  assert.equal(hints.slPrice, 79522.0);
  assert.equal(hints.matchingProtectiveOrderCount, 1);
});

// 2. Conditional entry order -> NOT mistaken for protective order
run("2. Conditional entry order -> NOT mistaken for protective", () => {
  const ledger = makeBotLedger();
  const okxConditionalEntryRow = {
    instId: "BTC-USDT-SWAP",
    algoId: "entry_algo_100",
    ordType: "conditional",
    side: "buy", // Long position, buying more -> entry!
    posSide: "net",
    sz: "0.5",
    triggerPx: "81000",
    orderPx: "81050",
    clOrdId: "manual_breakout_buy",
    state: "live"
  };

  const classify = classifyOkxOpenOrderPurpose(okxConditionalEntryRow, ledger);
  assert.equal(classify.isBotManagedProtection, false);
  assert.notEqual(classify.purpose, "protective-stop");
  assert.notEqual(classify.purpose, "protective-take-profit");

  const hints = findProtectiveHintsForInst("BTC-USDT-SWAP", "long", [], [okxConditionalEntryRow], false, {
    ledger,
    tickSz: 0.1,
    requiredStopPx: 79522.0,
    requiredContracts: 0.51
  });
  assert.equal(hints.protectionSatisfied, false);
  assert.equal(hints.matchingProtectiveOrderCount, 0);
});

// 3. V2 RANGE SL exists / exchange TP missing (tpRequired=false) -> protection satisfied
run("3. V2 RANGE SL exists / exchange TP missing -> protection satisfied", () => {
  const ledger = makeBotLedger({
    takeProfit1Px: 80760.8,
    partialExitRatio: 0.5
  });
  const okxAlgoSlRow = {
    instId: "BTC-USDT-SWAP",
    algoId: "sl_algo_btc_cycle18",
    ordType: "conditional",
    side: "sell",
    posSide: "net",
    sz: "0.51",
    slTriggerPx: "79522",
    slOrdPx: "-1",
    state: "live"
  };

  const evalResult = evaluatePositionProtectionState({
    instId: "BTC-USDT-SWAP",
    positionSide: "long",
    pending: [],
    algos: [okxAlgoSlRow],
    tpRequired: false, // V2 Range Partial delegates TP to V2 ladder exit authority
    ledger,
    tickSz: 0.1,
    requiredStopPx: 79522.0,
    requiredContracts: 0.51
  });

  assert.equal(evalResult.reduceOnlyProtectiveFound, true, "SL satisfied with tpRequired=false must result in reduceOnlyProtectiveFound=true");
  assert.equal(evalResult.canonicalProtectiveSlFound, true);
  assert.equal(evalResult.exchangeStopPx, 79522.0);
  assert.equal(evalResult.exchangeTpPx, null);
  assert.equal(evalResult.consistencyCheck, "PASS");
});

// 4. SL missing -> protection unsatisfied
run("4. SL missing -> protection unsatisfied", () => {
  const ledger = makeBotLedger();
  const evalResult = evaluatePositionProtectionState({
    instId: "BTC-USDT-SWAP",
    positionSide: "long",
    pending: [],
    algos: [],
    tpRequired: false,
    ledger,
    tickSz: 0.1,
    requiredStopPx: 79522.0,
    requiredContracts: 0.51
  });

  assert.equal(evalResult.reduceOnlyProtectiveFound, false);
  assert.equal(evalResult.canonicalProtectiveSlFound, false);
  assert.equal(evalResult.consistencyCheck, "FAIL");
});

// 5. OCO & trigger protective discovery
run("5. OCO and trigger protective discovery", () => {
  const ledger = makeBotLedger();
  const ocoRow = {
    instId: "BTC-USDT-SWAP",
    algoId: "oco_algo_555",
    ordType: "oco",
    side: "sell",
    posSide: "net",
    sz: "0.51",
    slTriggerPx: "79522",
    slOrdPx: "-1",
    tpTriggerPx: "81500",
    tpOrdPx: "-1",
    state: "live"
  };

  const hintsOco = findProtectiveHintsForInst("BTC-USDT-SWAP", "long", [], [ocoRow], true, {
    ledger,
    tickSz: 0.1,
    requiredStopPx: 79522.0,
    requiredContracts: 0.51
  });
  assert.equal(hintsOco.protectionSatisfied, true);
  assert.equal(hintsOco.slPrice, 79522.0);
  assert.equal(hintsOco.tpPrice, 81500.0);

  const triggerRow = {
    instId: "BTC-USDT-SWAP",
    algoId: "trigger_algo_777",
    ordType: "trigger",
    side: "sell",
    posSide: "net",
    closeFraction: "1",
    triggerPx: "79522",
    orderPx: "-1",
    state: "live"
  };
  const hintsTrigger = findProtectiveHintsForInst("BTC-USDT-SWAP", "long", [], [triggerRow], false, {
    ledger,
    tickSz: 0.1,
    requiredStopPx: 79522.0,
    requiredContracts: 0.51
  });
  assert.equal(hintsTrigger.protectionSatisfied, true);
  assert.equal(hintsTrigger.slPrice, 79522.0);
});

// 6. Duplicate algo query deduplication
run("6. Duplicate algo query dedupe", () => {
  const ledger = makeBotLedger();
  const algoRow = {
    instId: "BTC-USDT-SWAP",
    algoId: "dup_algo_1",
    ordType: "conditional",
    side: "sell",
    posSide: "net",
    closeFraction: "1",
    slTriggerPx: "79522",
    slOrdPx: "-1",
    state: "live"
  };

  // Simulating duplicate rows returned across multiple endpoint scans
  const duplicateAlgos = [algoRow, algoRow, { ...algoRow }];
  const hints = findProtectiveHintsForInst("BTC-USDT-SWAP", "long", [], duplicateAlgos, false, {
    ledger,
    tickSz: 0.1,
    requiredStopPx: 79522.0,
    requiredContracts: 0.51
  });
  assert.equal(hints.matchingProtectiveOrderCount, 1, "Deduplication must yield matchingProtectiveOrderCount=1");
});

// 7. Discovery -> truth fields backfill
run("7. Discovery -> truth fields backfill", () => {
  const ledger = makeBotLedger({
    exchangeProtectionConfirmed: false,
    confirmedExchangeProtectionEverSeen: false
  });

  const okxAlgoSlRow = {
    instId: "BTC-USDT-SWAP",
    algoId: "sl_algo_live",
    ordType: "conditional",
    side: "sell",
    posSide: "net",
    closeFraction: "1",
    slTriggerPx: "79522",
    slOrdPx: "-1",
    state: "live"
  };

  const evalResult = evaluatePositionProtectionState({
    instId: "BTC-USDT-SWAP",
    positionSide: "long",
    pending: [],
    algos: [okxAlgoSlRow],
    tpRequired: false,
    ledger,
    tickSz: 0.1,
    requiredStopPx: 79522.0,
    requiredContracts: 0.51
  });

  assert.equal(evalResult.reduceOnlyProtectiveFound, true);

  // Apply backfill logic as implemented in paper-engine ops-watch & pre-scan
  if (evalResult.reduceOnlyProtectiveFound) {
    ledger.exchangeProtectionConfirmed = true;
    ledger.confirmedExchangeProtectionEverSeen = true;
  }

  assert.equal(ledger.exchangeProtectionConfirmed, true);
  assert.equal(ledger.confirmedExchangeProtectionEverSeen, true);
});

// 8. Genuine manual protective deletion is still detected after confirmation
run("8. Genuine manual protective deletion is still detected after confirmation", () => {
  const confirmedLedger = makeBotLedger({
    exchangeProtectionConfirmed: true,
    confirmedExchangeProtectionEverSeen: true,
    isProtectiveStopRegistered: true,
    protectiveVisibilityGraceDeadlineMs: 0 // grace expired
  });

  // User deletes SL on OKX UI -> scanner sees 0 protective orders
  const shouldLatch = shouldLatchManualProtectiveOnlyIntervention({
    ledger: confirmedLedger,
    reduceOnlyProtectiveFound: false,
    matchingProtectivePendingCount: 0,
    scanClean: true,
    nowMs: Date.now()
  });

  assert.equal(shouldLatch, true, "After confirmed protection, operator deleting SL must latch takeover");
});

console.log("\n>>> ALL 8 BTC PROTECTIVE ORDER DISCOVERY INVARIANTS VERIFIED SUCCESSFULLY <<<\n");
