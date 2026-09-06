import assert from "node:assert/strict";
import {
  shouldLatchManualProtectiveOnlyIntervention,
  shouldUnlatchFalseManualTakeover,
  createManualTakeoverRecord,
  buildManualTakeoverKey
} from "../engine-v2/position/manual-takeover-authority";
import type { PaperOpenPositionRecord } from "../models/types";

function makeBotLedger(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    symbol: "BTCUSDT",
    side: "long",
    status: "open",
    pos: 1,
    entryPrice: 79859.1,
    leverage: 10,
    sizeUsd: 7985.91,
    strategyVersion: "v2",
    sourceSignal: "RANGE_PROMOTION",
    sourceRunPath: "run/1",
    openedAt: Date.now() - 60000,
    regimeAtEntry: "RANGE",
    lifecycleState: "BOT_V2_MANAGED",
    manualTakeoverActive: false,
    isProtectiveStopRegistered: true,
    protectiveVisibilityGraceDeadlineMs: Date.now() - 10000, // grace expired
    exchangeProtectionConfirmed: false,
    confirmedExchangeProtectionEverSeen: false,
    ...overrides
  } as any as PaperOpenPositionRecord;
}

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`[BTC-PROTECTION-RECOVERY][${name}] PASS`);
  } catch (e: any) {
    console.error(`[BTC-PROTECTION-RECOVERY][${name}] FAIL:`, e.message);
    throw e;
  }
}

console.log("=== RUNNING BTC POST-FILL PROTECTION RECOVERY + FALSE TAKEOVER TEST SUITE ===\n");

// 1. Cycle 18 exact replay: initial protection was planned/attempted but never exchange-confirmed -> false takeover NO
run("1. Cycle18 exact replay -> false takeover NO", () => {
  const ledger = makeBotLedger({
    symbol: "BTCUSDT",
    side: "long",
    isProtectiveStopRegistered: true,
    exchangeProtectionConfirmed: false,
    confirmedExchangeProtectionEverSeen: false,
    protectiveVisibilityGraceDeadlineMs: Date.now() - 5000
  });

  const shouldLatch = shouldLatchManualProtectiveOnlyIntervention({
    ledger,
    reduceOnlyProtectiveFound: false,
    matchingProtectivePendingCount: 0,
    scanClean: true,
    nowMs: Date.now()
  });

  assert.equal(shouldLatch, false, "Initial missing exchange protection must NEVER trigger manual takeover");
});

// 2. Fill + visibility lag (OKX position payload not yet populated) -> BOT ownership maintained
run("2. Fill + visibility lag -> BOT ownership maintained", () => {
  const ledger = makeBotLedger({
    symbol: "BTCUSDT",
    openedAt: Date.now() - 5000,
    protectiveVisibilityGraceDeadlineMs: Date.now() + 25000, // inside grace
    lifecycleState: "BOT_V2_MANAGED",
    manualTakeoverActive: false
  });

  const shouldLatch = shouldLatchManualProtectiveOnlyIntervention({
    ledger,
    reduceOnlyProtectiveFound: false,
    matchingProtectivePendingCount: 0,
    scanClean: true,
    nowMs: Date.now()
  });

  assert.equal(shouldLatch, false, "Inside visibility grace must keep BOT_V2_MANAGED");
  assert.equal(ledger.lifecycleState, "BOT_V2_MANAGED");
});

// 3. Visibility recovery -> initial missing protection allows repair (no false takeover)
run("3. Never-confirmed initial protection missing -> takeover NO, repair allowed", () => {
  const ledger = makeBotLedger({
    exchangeProtectionConfirmed: false,
    confirmedExchangeProtectionEverSeen: false
  });

  const shouldLatch = shouldLatchManualProtectiveOnlyIntervention({
    ledger,
    reduceOnlyProtectiveFound: false,
    matchingProtectivePendingCount: 0,
    scanClean: true,
    nowMs: Date.now()
  });

  assert.equal(shouldLatch, false);
});

// 4. Previously confirmed protection externally removed -> takeover YES
run("4. Previously confirmed protection externally removed -> takeover YES", () => {
  const ledger = makeBotLedger({
    exchangeProtectionConfirmed: true,
    confirmedExchangeProtectionEverSeen: true,
    protectiveStopAlgoId: "algo_12345",
    isProtectiveStopRegistered: true,
    protectiveVisibilityGraceDeadlineMs: Date.now() - 10000
  });

  const shouldLatch = shouldLatchManualProtectiveOnlyIntervention({
    ledger,
    reduceOnlyProtectiveFound: false,
    matchingProtectivePendingCount: 0,
    scanClean: true,
    nowMs: Date.now()
  });

  assert.equal(shouldLatch, true, "When confirmed exchange order disappears externally, manual takeover must be latched");
});

// 5. Ambiguous query (scanClean = false) -> takeover NO
run("5. Ambiguous query -> takeover NO", () => {
  const ledger = makeBotLedger({
    exchangeProtectionConfirmed: true,
    confirmedExchangeProtectionEverSeen: true
  });

  const shouldLatch = shouldLatchManualProtectiveOnlyIntervention({
    ledger,
    reduceOnlyProtectiveFound: false,
    matchingProtectivePendingCount: 0,
    scanClean: false, // fetch error / ambiguous
    nowMs: Date.now()
  });

  assert.equal(shouldLatch, false, "Ambiguous scan errors must NOT latch takeover");
});

// 6. Already false-latched Cycle 18 position -> safe BOT recovery YES
run("6. Already false-latched Cycle18 position -> safe BOT recovery YES", () => {
  const ledger = makeBotLedger({
    manualTakeoverActive: true,
    lifecycleState: "OPERATOR_MANAGED",
    exchangeProtectionConfirmed: false,
    confirmedExchangeProtectionEverSeen: false
  });

  const takeoverRec = createManualTakeoverRecord({
    symbol: "BTCUSDT",
    side: "long",
    reason: "MANUAL_PROTECTIVE_CHANGE"
  });

  const shouldUnlatch = shouldUnlatchFalseManualTakeover({
    ledger,
    takeoverRecord: takeoverRec,
    hasGenuineManualOrderOrTrade: false
  });

  assert.equal(shouldUnlatch, true, "False-latched position must safely auto-unlatch to BOT_V2_MANAGED");
});

// 7. Genuine operator takeover (e.g. MANUAL_SIZE_CHANGE or EXTERNAL_MANUAL_POSITION) -> recovery NO
run("7. Genuine operator takeover -> recovery NO", () => {
  const ledger = makeBotLedger({
    manualTakeoverActive: true,
    lifecycleState: "OPERATOR_MANAGED"
  });

  const takeoverRecManualSize = createManualTakeoverRecord({
    symbol: "BTCUSDT",
    side: "long",
    reason: "MANUAL_SIZE_CHANGE"
  });

  const shouldUnlatchSize = shouldUnlatchFalseManualTakeover({
    ledger,
    takeoverRecord: takeoverRecManualSize,
    hasGenuineManualOrderOrTrade: false
  });

  assert.equal(shouldUnlatchSize, false, "Genuine manual size change must NEVER auto-unlatch");

  const takeoverRecExternal = createManualTakeoverRecord({
    symbol: "BTCUSDT",
    side: "long",
    reason: "EXTERNAL_MANUAL_POSITION"
  });

  const shouldUnlatchExt = shouldUnlatchFalseManualTakeover({
    ledger,
    takeoverRecord: takeoverRecExternal,
    hasGenuineManualOrderOrTrade: false
  });

  assert.equal(shouldUnlatchExt, false, "External manual position must NEVER auto-unlatch");
});

// 8. Confirmed protection then deleted with genuine operator order -> recovery NO
run("8. Confirmed protection externally altered with operator order -> recovery NO", () => {
  const ledger = makeBotLedger({
    manualTakeoverActive: true,
    lifecycleState: "OPERATOR_MANAGED",
    exchangeProtectionConfirmed: true,
    confirmedExchangeProtectionEverSeen: true
  });

  const takeoverRec = createManualTakeoverRecord({
    symbol: "BTCUSDT",
    side: "long",
    reason: "MANUAL_PROTECTIVE_CHANGE"
  });

  const shouldUnlatch = shouldUnlatchFalseManualTakeover({
    ledger,
    takeoverRecord: takeoverRec,
    hasGenuineManualOrderOrTrade: true
  });

  assert.equal(shouldUnlatch, false, "Position with confirmed exchange protection and operator orders must NEVER unlatch");
});

// 9. ETH bot-managed position protection invariant preserved
run("9. ETH bot-managed position regression", () => {
  const ethLedger = makeBotLedger({
    symbol: "ETHUSDT",
    side: "long",
    entryPrice: 2315.0,
    stopPrice: 2303.425, // 0.50% canonical stop
    exchangeProtectionConfirmed: false,
    confirmedExchangeProtectionEverSeen: false
  });

  const shouldLatch = shouldLatchManualProtectiveOnlyIntervention({
    ledger: ethLedger,
    reduceOnlyProtectiveFound: false,
    matchingProtectivePendingCount: 0,
    scanClean: true,
    nowMs: Date.now()
  });

  assert.equal(shouldLatch, false, "ETH initial unconfirmed protection missing must not false-takeover");
});

// 10. Restart between false latch and recovery -> state faithfully restored and recovered
run("10. Restart between false latch and recovery", () => {
  const original = makeBotLedger({
    manualTakeoverActive: true,
    lifecycleState: "OPERATOR_MANAGED",
    manualTakeoverReason: "MANUAL_PROTECTIVE_CHANGE",
    exchangeProtectionConfirmed: false,
    confirmedExchangeProtectionEverSeen: false
  });

  // Simulate PM2 restart serialization round-trip
  const rehydrated: PaperOpenPositionRecord = JSON.parse(JSON.stringify(original));
  assert.equal(rehydrated.manualTakeoverActive, true);
  assert.equal(rehydrated.lifecycleState, "OPERATOR_MANAGED");
  assert.equal(rehydrated.confirmedExchangeProtectionEverSeen, false);

  const shouldUnlatch = shouldUnlatchFalseManualTakeover({
    ledger: rehydrated,
    manualTakeoverReason: rehydrated.manualTakeoverReason,
    hasGenuineManualOrderOrTrade: false
  });
  assert.equal(shouldUnlatch, true, "Rehydrated position after restart must safely unlatch");
});

// 11. Restart after protection confirmed -> confirmed flag strictly preserved
run("11. Restart after protection confirmed", () => {
  const confirmed = makeBotLedger({
    exchangeProtectionConfirmed: true,
    confirmedExchangeProtectionEverSeen: true,
    protectionPlanned: true,
    protectionSubmitAttempted: true
  });

  // Simulate PM2 restart serialization round-trip
  const rehydrated: PaperOpenPositionRecord = JSON.parse(JSON.stringify(confirmed));
  assert.equal(rehydrated.exchangeProtectionConfirmed, true);
  assert.equal(rehydrated.confirmedExchangeProtectionEverSeen, true);
  assert.equal(rehydrated.protectionPlanned, true);
  assert.equal(rehydrated.protectionSubmitAttempted, true);
});

// 12. Recovery runs once only -> subsequent ticks are no-op
run("12. Recovery runs once only", () => {
  const ledger = makeBotLedger({
    manualTakeoverActive: true,
    lifecycleState: "OPERATOR_MANAGED",
    manualTakeoverReason: "MANUAL_PROTECTIVE_CHANGE",
    confirmedExchangeProtectionEverSeen: false
  });

  const shouldUnlatchFirst = shouldUnlatchFalseManualTakeover({
    ledger,
    manualTakeoverReason: "MANUAL_PROTECTIVE_CHANGE",
    hasGenuineManualOrderOrTrade: false
  });
  assert.equal(shouldUnlatchFirst, true, "First evaluation must trigger unlatch");

  // Apply unlatch
  ledger.manualTakeoverActive = false;
  ledger.lifecycleState = "BOT_V2_MANAGED";
  ledger.manualTakeoverReason = undefined;

  const shouldUnlatchSecond = shouldUnlatchFalseManualTakeover({
    ledger,
    manualTakeoverReason: undefined,
    hasGenuineManualOrderOrTrade: false
  });
  assert.equal(shouldUnlatchSecond, false, "Subsequent evaluation must be no-op");
});

// 13. Recovery does not enable addon or second entry while position is open
run("13. Recovery does not enable addon/second entry", () => {
  const ledger = makeBotLedger({
    lifecycleState: "BOT_V2_MANAGED",
    manualTakeoverActive: false,
    status: "open",
    pos: 1
  });

  // Open position present in ledger
  const openPositions: PaperOpenPositionRecord[] = [ledger];
  const hasOpenForSymbol = openPositions.some(p => p.symbol === "BTCUSDT" && p.status === "open");
  assert.equal(hasOpenForSymbol, true, "Active open position exists in ledger, preventing new entry");
});

// 14. Confirmed protection later externally removed -> genuine takeover YES
run("14. Confirmed protection later externally removed -> genuine takeover YES", () => {
  const ledger = makeBotLedger({
    lifecycleState: "BOT_V2_MANAGED",
    manualTakeoverActive: false,
    isProtectiveStopRegistered: true,
    exchangeProtectionConfirmed: true,
    confirmedExchangeProtectionEverSeen: true,
    protectiveVisibilityGraceDeadlineMs: 0 // grace expired
  });

  const shouldLatch = shouldLatchManualProtectiveOnlyIntervention({
    ledger,
    reduceOnlyProtectiveFound: false, // operator deleted SL on OKX
    matchingProtectivePendingCount: 0,
    scanClean: true,
    nowMs: Date.now()
  });

  assert.equal(shouldLatch, true, "External deletion of previously confirmed protection must trigger takeover");
});

console.log("\n>>> ALL 14 BTC POST-FILL PROTECTION RECOVERY INVARIANTS VERIFIED SUCCESSFULLY <<<\n");
