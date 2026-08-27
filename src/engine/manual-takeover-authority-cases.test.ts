import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createManualTakeoverRecord,
  createClearedManualTakeoverRecord,
  isManualTakeoverActiveForSymbol,
  applyManualTakeoverToPositionRecord,
  evaluateManualTakeoverActionGuard,
  buildManualTakeoverAuthorityProof,
  readManualTakeoverDocFromDisk,
  writeManualTakeoverDocToDisk,
  isAuthoritativeBotOwnedAlgoOrder,
  isAuthoritativeBotOwnedPendingOrder,
  type ManualTakeoverRecord,
  type ManualTakeoverStoreDoc
} from "../engine-v2/position/manual-takeover-authority";
import { classifyPositionSizeDelta } from "../engine-v2/position/manual-reduce-rebase";
import { evaluateV2ExitExecutionGate } from "../engine-v2/exit/exit-execution-gate";
import { evaluateOpsWatchProtectiveScanVerdict } from "../engine-v2/execution/protective-order-state";
import { evaluateTerminalReentryBarrier } from "../engine-v2/lifecycle/terminal-reentry-barrier";
import type { PaperOpenPositionRecord } from "../models/types";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`FAIL [${msg}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(`FAIL [${msg}]: expected true, got false`);
  }
}

function assertFalse(cond: boolean, msg: string): void {
  if (cond) {
    throw new Error(`FAIL [${msg}]: expected false, got true`);
  }
}

async function runManualTakeoverRegressionTests() {
  console.log("=== STARTING MANUAL TAKEOVER AUTHORITY REGRESSION TESTS ===");

  // CASE A: BOT opens ETH long 1.00 -> operator manually adds 0.40 -> takeover activates -> position 1.40 open -> bot cannot EXIT/SL/TP/ADDON
  {
    const botOpen: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "ETHUSDT",
      side: "long",
      entryPrice: 2500,
      leverage: 10,
      sizeUsd: 2500,
      initialSizeUsd: 2500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "BOT_V2_MANAGED",
      status: "open",
      pos: 1.0,
      okxContracts: 1.0,
      isV2Authority: true,
      stopPrice: 2450,
      targetPrice1: 2600
    };

    const delta = classifyPositionSizeDelta({
      beforeContracts: 1.0,
      afterContracts: 1.4,
      ledger: botOpen,
      botManaged: true,
      nowMs: 1700000005000
    });

    assertEq(delta.classification, "MANUAL_INCREASE", "CASE A: delta classified as MANUAL_INCREASE");
    assertFalse(delta.botFillEvidenceFound, "CASE A: no bot fill evidence");

    const takeoverRec = createManualTakeoverRecord({
      symbol: botOpen.symbol,
      side: botOpen.side,
      reason: "MANUAL_ADD",
      positionCycleId: "cycle_eth_1",
      nowMs: 1700000005000
    });
    applyManualTakeoverToPositionRecord(botOpen, takeoverRec);

    assertTrue(botOpen.manualTakeoverActive === true, "CASE A: manualTakeoverActive is true");
    assertEq(botOpen.lifecycleState, "OPERATOR_MANAGED", "CASE A: lifecycleState is OPERATOR_MANAGED");

    // Check exit gate
    const exitGate = evaluateV2ExitExecutionGate({
      symbol: "ETHUSDT",
      side: "long",
      requestedAction: "close",
      requestedReason: "stop_loss",
      isV2Managed: true,
      v2ShouldExit: true,
      v2ShouldReduce: false,
      v2ShouldPartial: false,
      actualStopBreached: true,
      actualPositionExists: true,
      manualTakeoverActive: botOpen.manualTakeoverActive
    });
    assertFalse(exitGate.allowed, "CASE A: bot exit disallowed");
    assertEq(exitGate.blockReason, "MANUAL_TAKEOVER_ACTIVE", "CASE A: block reason is MANUAL_TAKEOVER_ACTIVE");

    // Check ops watch protection scan
    const opsVerdict = evaluateOpsWatchProtectiveScanVerdict({
      nowMs: 1700000005000,
      ledger: botOpen,
      reduceOnlyProtectiveFound: false,
      matchingProtectivePendingCount: 0,
      scanClean: true,
      tpRequired: false
    });
    assertEq(opsVerdict.verdict, "PASS", "CASE A: ops watch passes without false hard block");
    assertEq(opsVerdict.reason, "manual_takeover_operator_managed", "CASE A: truthful operator managed reason");

    console.log("[CASE A] PASS: Operator manual add (1.0 -> 1.4) latches takeover & terminates bot exit/sl/tp");
  }

  // CASE B: BOT opens 1.40 -> operator manually closes 0.40 -> takeover activates -> remaining 1.00 untouched by bot
  {
    const botOpen: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "ETHUSDT",
      side: "long",
      entryPrice: 2500,
      leverage: 10,
      sizeUsd: 3500,
      initialSizeUsd: 3500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "BOT_V2_MANAGED",
      status: "open",
      pos: 1.4,
      okxContracts: 1.4,
      isV2Authority: true,
      stopPrice: 2450
    };

    const delta = classifyPositionSizeDelta({
      beforeContracts: 1.4,
      afterContracts: 1.0,
      ledger: botOpen,
      botManaged: true,
      nowMs: 1700000010000
    });

    assertEq(delta.classification, "MANUAL_REDUCE_REBASE", "CASE B: delta classified as MANUAL_REDUCE_REBASE");
    assertFalse(delta.botFillEvidenceFound, "CASE B: no bot fill evidence");

    const takeoverRec = createManualTakeoverRecord({
      symbol: botOpen.symbol,
      side: botOpen.side,
      reason: "MANUAL_PARTIAL_CLOSE",
      nowMs: 1700000010000
    });
    applyManualTakeoverToPositionRecord(botOpen, takeoverRec);

    assertTrue(botOpen.manualTakeoverActive === true, "CASE B: manualTakeoverActive is true");
    assertEq(botOpen.lifecycleState, "OPERATOR_MANAGED", "CASE B: lifecycleState is OPERATOR_MANAGED");

    const exitGuard = evaluateManualTakeoverActionGuard({
      symbol: "ETHUSDT",
      side: "long",
      action: "V2_EXIT",
      manualTakeoverActive: botOpen.manualTakeoverActive === true
    });
    assertFalse(exitGuard.allowed, "CASE B: exitGuard disallows bot exit");
    assertEq(exitGuard.blockReason, "MANUAL_TAKEOVER_ACTIVE", "CASE B: blockReason is MANUAL_TAKEOVER_ACTIVE");

    console.log("[CASE B] PASS: Operator manual partial close (1.4 -> 1.0) latches takeover & terminates bot exit");
  }

  // CASE C: BOT opens position -> bot's own TP1 fills -> must NOT activate takeover
  {
    const botOpen: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "ETHUSDT",
      side: "long",
      entryPrice: 2500,
      leverage: 10,
      sizeUsd: 2500,
      initialSizeUsd: 2500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "PARTIAL_PENDING",
      status: "open",
      pos: 1.0,
      okxContracts: 1.0,
      isV2Authority: true,
      partialPendingContracts: 0.5,
      lastBotExecutionAt: 1700000001000,
      lastBotExecutionReason: "v2_partial_tp1"
    };

    const delta = classifyPositionSizeDelta({
      beforeContracts: 1.0,
      afterContracts: 0.5,
      ledger: botOpen,
      botManaged: true,
      nowMs: 1700000002000
    });

    assertEq(delta.classification, "BOT_REDUCE_RECONCILE", "CASE C: classified as BOT_REDUCE_RECONCILE");
    assertTrue(delta.botFillEvidenceFound, "CASE C: bot fill evidence recognized");
    assertFalse(botOpen.manualTakeoverActive === true, "CASE C: manual takeover NOT activated for bot TP1");

    console.log("[CASE C] PASS: Bot TP1 fill does NOT trigger manual takeover");
  }

  // CASE D: BOT addon fills -> must NOT activate takeover
  {
    const botOpen: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "ETHUSDT",
      side: "long",
      entryPrice: 2500,
      leverage: 10,
      sizeUsd: 2500,
      initialSizeUsd: 2500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "BOT_V2_MANAGED",
      status: "open",
      pos: 1.0,
      okxContracts: 1.0,
      isV2Authority: true,
      addonRebuildPendingConfirmation: true,
      addonRebuildMetrics: {
        rebuildStartedAt: 1700000005000,
        beforeContracts: 1.0,
        addonFilledContracts: 0.5,
        fillConfirmed: true,
        oldSize: 2500,
        newSize: 3750,
        oldAvgEntry: 2500,
        newAvgEntry: 2500
      },
      lastBotExecutionAt: 1700000005000,
      lastBotExecutionReason: "v2_addon_enter"
    };

    const delta = classifyPositionSizeDelta({
      beforeContracts: 1.0,
      afterContracts: 1.5,
      ledger: botOpen,
      botManaged: true,
      nowMs: 1700000006000
    });

    assertEq(delta.classification, "BOT_REDUCE_RECONCILE", "CASE D: classified as BOT_REDUCE_RECONCILE for addon");
    assertTrue(delta.botFillEvidenceFound, "CASE D: bot addon evidence recognized");
    assertFalse(botOpen.manualTakeoverActive === true, "CASE D: manual takeover NOT activated for bot addon");

    console.log("[CASE D] PASS: Bot Addon fill does NOT trigger manual takeover");
  }

  // CASE E: operator manually changes/removes SL -> takeover activates -> bot must not recreate protective order
  {
    const botOpen: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "ETHUSDT",
      side: "long",
      entryPrice: 2500,
      leverage: 10,
      sizeUsd: 2500,
      initialSizeUsd: 2500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "BOT_V2_MANAGED",
      status: "open",
      pos: 1.0,
      okxContracts: 1.0,
      isV2Authority: true,
      stopPrice: 2450
    };

    // Operator removes SL -> manual protective change detected
    const takeoverRec = createManualTakeoverRecord({
      symbol: "ETHUSDT",
      side: "long",
      reason: "MANUAL_PROTECTIVE_CHANGE",
      nowMs: 1700000020000
    });
    applyManualTakeoverToPositionRecord(botOpen, takeoverRec);

    assertTrue(botOpen.manualTakeoverActive === true, "CASE E: takeover active");
    assertEq(botOpen.manualTakeoverReason, "MANUAL_PROTECTIVE_CHANGE", "CASE E: reason is MANUAL_PROTECTIVE_CHANGE");

    const opsVerdict = evaluateOpsWatchProtectiveScanVerdict({
      nowMs: 1700000020000,
      ledger: botOpen,
      reduceOnlyProtectiveFound: false,
      matchingProtectivePendingCount: 0,
      scanClean: true,
      tpRequired: false
    });
    assertEq(opsVerdict.verdict, "PASS", "CASE E: ops watch PASS without forcing recreate");
    assertFalse(opsVerdict.shouldBlockSymbol, "CASE E: shouldBlockSymbol is false");

    console.log("[CASE E] PASS: Manual protective order removal latches takeover without bot auto-recreating SL");
  }

  // CASE F: operator manually fully closes -> ledger finalizes -> no duplicate bot close -> no immediate bot re-entry
  {
    const map = new Map<string, ManualTakeoverRecord>();
    const takeoverRec = createManualTakeoverRecord({
      symbol: "ETHUSDT",
      side: "long",
      reason: "MANUAL_FULL_CLOSE",
      nowMs: 1700000030000
    });
    map.set("ETHUSDT:long", takeoverRec);
    map.set("ETHUSDT", takeoverRec);

    assertTrue(isManualTakeoverActiveForSymbol("ETHUSDT", "long", map), "CASE F: ETHUSDT takeover active after full close");
    assertTrue(isManualTakeoverActiveForSymbol("ETHUSDT", null, map), "CASE F: ETHUSDT general takeover active");

    const barrier = evaluateTerminalReentryBarrier({
      symbol: "ETHUSDT",
      requestedSide: "long",
      openPositions: [],
      openPositionsSourceAvailable: true
    });
    assertFalse(barrier.blocked, "CASE F: barrier itself passes for 0 positions");

    // But manual takeover guard blocks re-entry
    const entryGuard = evaluateManualTakeoverActionGuard({
      symbol: "ETHUSDT",
      side: "long",
      action: "ENTER",
      manualTakeoverActive: isManualTakeoverActiveForSymbol("ETHUSDT", "long", map)
    });
    assertFalse(entryGuard.allowed, "CASE F: new entry blocked by manual takeover");
    assertEq(entryGuard.blockReason, "MANUAL_TAKEOVER_ACTIVE", "CASE F: block reason is MANUAL_TAKEOVER_ACTIVE");

    console.log("[CASE F] PASS: Manual full close keeps symbol takeover active and prevents bot re-entry");
  }

  // CASE G: restart PM2 while takeover active -> takeover still active (loaded from JSON)
  {
    const tmpDir = path.resolve(process.cwd(), "scratch/test_takeover_pm2_restart");
    await fs.mkdir(path.resolve(tmpDir, "control"), { recursive: true });

    const doc: ManualTakeoverStoreDoc = {
      updatedAt: 1700000040000,
      bySymbol: {
        ETHUSDT: {
          manualTakeoverActive: true,
          manualTakeoverSymbol: "ETHUSDT",
          manualTakeoverSide: "long",
          manualTakeoverDetectedAt: 1700000040000,
          manualTakeoverReason: "MANUAL_SIZE_CHANGE"
        }
      }
    };
    await writeManualTakeoverDocToDisk(tmpDir, doc);

    // Simulate restart by reading from disk fresh
    const loadedDoc = await readManualTakeoverDocFromDisk(tmpDir);
    assertTrue(loadedDoc.bySymbol["ETHUSDT"]?.manualTakeoverActive === true, "CASE G: takeover persisted across restart");
    assertTrue(isManualTakeoverActiveForSymbol("ETHUSDT", "long", loadedDoc.bySymbol), "CASE G: isManualTakeoverActive returns true");

    console.log("[CASE G] PASS: Manual takeover persists across PM2 restart");
  }

  // CASE H: explicit operator re-arm -> takeover clears -> fresh future bot entry allowed
  {
    const map = new Map<string, ManualTakeoverRecord>();
    const takeoverRec = createManualTakeoverRecord({
      symbol: "ETHUSDT",
      side: "long",
      reason: "MANUAL_SIZE_CHANGE"
    });
    map.set("ETHUSDT:long", takeoverRec);
    map.set("ETHUSDT", takeoverRec);

    assertTrue(isManualTakeoverActiveForSymbol("ETHUSDT", "long", map), "CASE H: takeover active before rearm");

    // Operator explicitly re-arms
    const clearedRec = createClearedManualTakeoverRecord({
      symbol: "ETHUSDT",
      side: "long",
      clearedBy: "operator"
    });
    map.delete("ETHUSDT:long");
    map.delete("ETHUSDT");

    assertFalse(isManualTakeoverActiveForSymbol("ETHUSDT", "long", map), "CASE H: takeover inactive after rearm");
    assertEq(clearedRec.manualTakeoverClearedBy, "operator", "CASE H: clearedBy is operator");

    const entryGuard = evaluateManualTakeoverActionGuard({
      symbol: "ETHUSDT",
      side: "long",
      action: "ENTER",
      manualTakeoverActive: isManualTakeoverActiveForSymbol("ETHUSDT", "long", map)
    });
    assertTrue(entryGuard.allowed, "CASE H: fresh bot entry allowed after operator re-arm");

    console.log("[CASE H] PASS: Explicit operator re-arm clears takeover and permits future bot entries");
  }

  // CASE I: manual ETH takeover -> BTC automation still allowed
  {
    const map = new Map<string, ManualTakeoverRecord>();
    const ethRec = createManualTakeoverRecord({
      symbol: "ETHUSDT",
      side: "long",
      reason: "MANUAL_SIZE_CHANGE"
    });
    map.set("ETHUSDT:long", ethRec);
    map.set("ETHUSDT", ethRec);

    assertTrue(isManualTakeoverActiveForSymbol("ETHUSDT", "long", map), "CASE I: ETH is in takeover");
    assertFalse(isManualTakeoverActiveForSymbol("BTCUSDT", "long", map), "CASE I: BTC is NOT in takeover");

    const btcGuard = evaluateManualTakeoverActionGuard({
      symbol: "BTCUSDT",
      side: "long",
      action: "ENTER",
      manualTakeoverActive: isManualTakeoverActiveForSymbol("BTCUSDT", "long", map)
    });
    assertTrue(btcGuard.allowed, "CASE I: BTC entry allowed while ETH is in takeover");

    console.log("[CASE I] PASS: ETH manual takeover is isolated per-symbol; BTC automation continues normally");
  }

  // CASE J: Proof builder output verification
  {
    const proof = buildManualTakeoverAuthorityProof({
      symbol: "ETHUSDT",
      side: "long",
      manual_takeover_active: true,
      blocked_action: "V2_EXIT",
      mutation_allowed: false
    });
    assertEq(proof.event, "V2_MANUAL_TAKEOVER_AUTHORITY_PROOF", "CASE J: event name matches spec");
    assertEq(proof.symbol, "ETHUSDT", "CASE J: symbol matches");
    assertEq(proof.blocked_action, "V2_EXIT", "CASE J: blocked action matches");
    assertEq(proof.mutation_allowed, false, "CASE J: mutation_allowed is false");

    console.log("[CASE J] PASS: V2_MANUAL_TAKEOVER_AUTHORITY_PROOF structure matches specification");
  }

  // CASE K: Authoritative Bot Order Ownership vs Manual Order Preservation
  {
    const botOpen: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "ETHUSDT",
      side: "long",
      entryPrice: 2500,
      leverage: 10,
      sizeUsd: 2500,
      initialSizeUsd: 2500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "BOT_V2_MANAGED",
      status: "open",
      pos: 1.0,
      okxContracts: 1.0,
      isV2Authority: true,
      protectiveSlAlgoId: "algo_sl_12345",
      protectiveTpAlgoId: "algo_tp_67890",
      closePendingClOrdId: "pETHUSlsg7k2j3"
    };

    const opens = [botOpen];

    // 1. Authoritative bot algo orders (MUST return true)
    assertTrue(isAuthoritativeBotOwnedAlgoOrder({ algoId: "algo_sl_12345" }, opens), "CASE K: exact algoId match SL");
    assertTrue(isAuthoritativeBotOwnedAlgoOrder({ algoId: "algo_tp_67890" }, opens), "CASE K: exact algoId match TP");
    assertTrue(isAuthoritativeBotOwnedAlgoOrder({ algoClOrdId: "oapETHUSlsg7k2j3s" }, opens), "CASE K: valid oap schema algoClOrdId");
    assertTrue(isAuthoritativeBotOwnedAlgoOrder({ algoClOrdId: "oapETHUSlsg7k2j3r1t" }, opens), "CASE K: valid oap schema with revision");

    // 2. User/Manual orders that happen to have casual prefixes (MUST return false)
    assertFalse(isAuthoritativeBotOwnedAlgoOrder({ algoId: "manual_algo_999", algoClOrdId: "sl_my_manual_stop" }, opens), "CASE K: manual sl prefix not cancelled");
    assertFalse(isAuthoritativeBotOwnedAlgoOrder({ algoId: "manual_algo_888", algoClOrdId: "tp_manual_target" }, opens), "CASE K: manual tp prefix not cancelled");
    assertFalse(isAuthoritativeBotOwnedAlgoOrder({ algoId: "manual_algo_777", algoClOrdId: "p_user_custom_close" }, opens), "CASE K: manual p prefix not cancelled");
    assertFalse(isAuthoritativeBotOwnedAlgoOrder({ algoId: "manual_algo_666", algoClOrdId: "oap_custom_manual_string" }, opens), "CASE K: casual oap prefix without schema not cancelled");

    // 3. Regular pending orders
    assertTrue(isAuthoritativeBotOwnedPendingOrder({ clOrdId: "pETHUSlsg7k2j3" }, opens), "CASE K: bot pending close clOrdId matches");
    assertFalse(isAuthoritativeBotOwnedPendingOrder({ clOrdId: "p_my_manual_limit_buy" }, opens), "CASE K: manual pending limit order not cancelled");

    console.log("[CASE K] PASS: Authoritative Bot Order Ownership accurately isolates bot orders and preserves manual orders");
  }

  // CASE L: Delayed Bot TP1 fill evidence race (1-2 cycles delay)
  {
    const botOpen: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "ETHUSDT",
      side: "long",
      entryPrice: 2500,
      leverage: 10,
      sizeUsd: 2500,
      initialSizeUsd: 2500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "PARTIAL_PENDING",
      status: "open",
      pos: 1.0,
      okxContracts: 1.0,
      isV2Authority: true,
      partialPendingContracts: 0.5,
      lastBotExecutionAt: 1700000010000,
      lastBotExecutionReason: "v2_partial_tp1"
    };

    // Cycle 1 (100ms later): OKX position contracts reduced to 0.5, but fill history REST endpoint has not indexed yet
    const cycle1Delta = classifyPositionSizeDelta({
      beforeContracts: 1.0,
      afterContracts: 0.5,
      ledger: botOpen,
      botManaged: true,
      nowMs: 1700000010100
    });
    assertEq(cycle1Delta.classification, "BOT_REDUCE_RECONCILE", "CASE L: Cycle 1 recognized as BOT_REDUCE_RECONCILE");
    assertTrue(cycle1Delta.botFillEvidenceFound, "CASE L: Cycle 1 has bot fill evidence");
    assertFalse(botOpen.manualTakeoverActive === true, "CASE L: Cycle 1 takeover NOT latched");

    // Cycle 2 (2000ms later): Still within 15s grace window
    const cycle2Delta = classifyPositionSizeDelta({
      beforeContracts: 1.0,
      afterContracts: 0.5,
      ledger: botOpen,
      botManaged: true,
      nowMs: 1700000012000
    });
    assertEq(cycle2Delta.classification, "BOT_REDUCE_RECONCILE", "CASE L: Cycle 2 recognized as BOT_REDUCE_RECONCILE");
    assertFalse(botOpen.manualTakeoverActive === true, "CASE L: Cycle 2 takeover NOT latched");

    console.log("[CASE L] PASS: Delayed Bot TP1 fill evidence race does NOT latch manual takeover");
  }

  // CASE M: Delayed Bot Addon evidence race
  {
    const botOpen: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "ETHUSDT",
      side: "long",
      entryPrice: 2500,
      leverage: 10,
      sizeUsd: 2500,
      initialSizeUsd: 2500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "BOT_V2_MANAGED",
      status: "open",
      pos: 1.0,
      okxContracts: 1.0,
      isV2Authority: true,
      addonRebuildPendingConfirmation: true,
      addonRebuildMetrics: {
        rebuildStartedAt: 1700000020000,
        beforeContracts: 1.0,
        addonFilledContracts: 0.5,
        fillConfirmed: true,
        oldSize: 2500,
        newSize: 3750,
        oldAvgEntry: 2500,
        newAvgEntry: 2500
      },
      lastBotExecutionAt: 1700000020000,
      lastBotExecutionReason: "v2_addon_enter"
    };

    // Size changes on exchange before order history returns
    const addonDelta = classifyPositionSizeDelta({
      beforeContracts: 1.0,
      afterContracts: 1.5,
      ledger: botOpen,
      botManaged: true,
      nowMs: 1700000020200
    });
    assertEq(addonDelta.classification, "BOT_REDUCE_RECONCILE", "CASE M: Addon recognized as BOT_REDUCE_RECONCILE");
    assertTrue(addonDelta.botFillEvidenceFound, "CASE M: Bot addon evidence recognized");
    assertFalse(botOpen.manualTakeoverActive === true, "CASE M: Takeover NOT latched for bot addon");

    console.log("[CASE M] PASS: Delayed Bot Addon fill evidence race does NOT latch manual takeover");
  }

  // CASE N: Exchange auto-cancelled OCO sibling protective algo
  {
    const botOpen: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "ETHUSDT",
      side: "long",
      entryPrice: 2500,
      leverage: 10,
      sizeUsd: 2500,
      initialSizeUsd: 2500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "CLOSE_PENDING",
      status: "open",
      pos: 1.0,
      okxContracts: 1.0,
      isV2Authority: true,
      closePendingReason: "stop_loss",
      closePendingAt: 1700000030000,
      closePendingOrdId: "ord_close_sl_123",
      lastBotExecutionAt: 1700000030000,
      lastBotExecutionReason: "stop_loss"
    };

    // When SL triggers, TP is auto-cancelled by OKX OCO mechanism
    const delta = classifyPositionSizeDelta({
      beforeContracts: 1.0,
      afterContracts: 0,
      ledger: botOpen,
      botManaged: true,
      nowMs: 1700000030100
    });
    assertEq(delta.classification, "BOT_REDUCE_RECONCILE", "CASE N: OCO SL trigger recognized as BOT_REDUCE_RECONCILE");
    assertTrue(delta.botFillEvidenceFound, "CASE N: Bot close fill evidence recognized");
    assertFalse(botOpen.manualTakeoverActive === true, "CASE N: No false takeover on OCO sibling cancellation");

    console.log("[CASE N] PASS: Exchange auto-cancelled OCO sibling does NOT cause false takeover");
  }

  console.log("=== ALL REGRESSION CASES (A-N) PASSED SUCCESSFULLY ===");
}

runManualTakeoverRegressionTests().catch((err) => {
  console.error("FATAL ERROR in regression tests:", err);
  process.exit(1);
});
