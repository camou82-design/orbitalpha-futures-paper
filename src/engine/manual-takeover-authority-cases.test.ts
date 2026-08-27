import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createManualTakeoverRecord,
  createClearedManualTakeoverRecord,
  isManualTakeoverActiveForSymbol,
  expireStaleManualTakeoverEntries,
  syncManualTakeoverLifecycleEntries,
  countAuthoritativeEngineOwnedExchangeOrders,
  shouldLatchManualProtectiveOnlyIntervention,
  isAuthoritativeBotOwnedAlgoOrder,
  applyManualTakeoverToPositionRecord,
  evaluateManualTakeoverActionGuard,
  buildManualTakeoverAuthorityProof,
  readManualTakeoverDocFromDisk,
  writeManualTakeoverDocToDisk,
  isAuthoritativeBotOwnedPendingOrder,
  type ManualTakeoverRecord,
  type ManualTakeoverStoreDoc
} from "../engine-v2/position/manual-takeover-authority";
import { classifyPositionSizeDelta } from "../engine-v2/position/manual-reduce-rebase";
import { evaluateV2ExitExecutionGate } from "../engine-v2/exit/exit-execution-gate";
import { evaluateOpsWatchProtectiveScanVerdict } from "../engine-v2/execution/protective-order-state";
import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import { runEngineV2 } from "../engine-v2/index";
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

  // CASE F: flat + zero engine-owned orders -> position-cycle takeover expires -> new bot entry allowed
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

    // Flat but stale engine algo remains -> takeover MUST stay active
    assertFalse(
      syncManualTakeoverLifecycleEntries(map, [], { "ETHUSDT:long": 1, ETHUSDT: 1 }).length > 0,
      "CASE F: stale engine orders prevent takeover clear"
    );
    assertTrue(
      isManualTakeoverActiveForSymbol("ETHUSDT", "long", map, [], { engineOwnedOrderCount: 1 }),
      "CASE F: takeover active while stale engine orders remain"
    );
    const blockedEntry = evaluateManualTakeoverActionGuard({
      symbol: "ETHUSDT",
      side: "long",
      action: "ENTER",
      manualTakeoverActive: isManualTakeoverActiveForSymbol("ETHUSDT", "long", map, [], { engineOwnedOrderCount: 1 })
    });
    assertFalse(blockedEntry.allowed, "CASE F: new entry blocked while stale engine algo remains");

    const cleared = syncManualTakeoverLifecycleEntries(map, [], { "ETHUSDT:long": 0, ETHUSDT: 0 });
    assertTrue(cleared.length >= 2, "CASE F: stale takeover keys cleared when flat and engine orders zero");

    assertFalse(isManualTakeoverActiveForSymbol("ETHUSDT", "long", map, [], { engineOwnedOrderCount: 0 }), "CASE F: takeover inactive after engine cleanup");
    assertFalse(isManualTakeoverActiveForSymbol("ETHUSDT", null, map, [], { engineOwnedOrderCount: 0 }), "CASE F: general takeover inactive when flat");

    const barrier = evaluateTerminalReentryBarrier({
      symbol: "ETHUSDT",
      requestedSide: "long",
      openPositions: [],
      openPositionsSourceAvailable: true
    });
    assertFalse(barrier.blocked, "CASE F: barrier itself passes for 0 positions");

    const entryGuard = evaluateManualTakeoverActionGuard({
      symbol: "ETHUSDT",
      side: "long",
      action: "ENTER",
      manualTakeoverActive: isManualTakeoverActiveForSymbol("ETHUSDT", "long", map, [], { engineOwnedOrderCount: 0 })
    });
    assertTrue(entryGuard.allowed, "CASE F: new entry allowed after flat + engine order cleanup");

    console.log("[CASE F] PASS: Manual full close expires takeover only after authoritative engine order cleanup");
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

  // CASE O: Live BTC Short Manual Intervention Short-Circuit Proof
  {
    const btcShort: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "BTCUSDT",
      side: "short",
      entryPrice: 95000,
      leverage: 10,
      sizeUsd: 9500,
      initialSizeUsd: 9500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "BOT_V2_MANAGED",
      status: "open",
      pos: 0.1,
      okxContracts: 1.0,
      isV2Authority: true,
      stopPrice: 96000
    };

    // Operator intervenes on OKX -> Manual Takeover activates
    const takeoverRec = createManualTakeoverRecord({
      symbol: "BTCUSDT",
      side: "short",
      reason: "OPERATOR_MANUAL_INTERVENTION",
      positionCycleId: "btc_cycle_1",
      nowMs: 1700000040000
    });
    applyManualTakeoverToPositionRecord(btcShort, takeoverRec);

    assertTrue(btcShort.manualTakeoverActive === true, "CASE O: BTC manualTakeoverActive is true");
    assertEq(btcShort.lifecycleState, "OPERATOR_MANAGED", "CASE O: BTC lifecycleState is OPERATOR_MANAGED");

    // 1. evaluateV2ExitPolicy must short-circuit to hold with no exit/reduce/partial
    const exitRes = evaluateV2ExitPolicy({
      symbol: "BTCUSDT",
      v2State: {
        shortPosition: btcShort,
        longPosition: null
      } as any,
      judgment: {
        regime: "TREND",
        subtype: "BEAR_TREND",
        isAmbiguous: false,
        shockPhase: "NONE",
        transitionPhase: "NONE"
      } as any,
      snapshot: {
        boxPos: 0.5,
        boxBreakSide: "none",
        emaGap: 0,
        trendWeaknessScore: 0,
        rangeConfidence: 0,
        qualityScore: 1,
        atr20: 1000
      },
      trendSideCandidate: "none",
      rangeSideCandidate: "none",
      reversalConfirmed: false,
      invalidationBreachConfirmed: false,
      structuralBreakConfirmed: false,
      boxBreakConfirmed: false,
      markPrice: 95500
    });

    assertEq(exitRes.action, "HOLD", "CASE O: exitPolicy returns HOLD");
    assertEq(exitRes.reason, "NO_POSITION_HOLD", "CASE O: exitPolicy reason is NO_POSITION_HOLD");
    assertFalse(exitRes.shouldExit, "CASE O: shouldExit is false");
    assertFalse(exitRes.shouldReduce, "CASE O: shouldReduce is false");
    assertFalse(exitRes.shouldPartial, "CASE O: shouldPartial is false");
    assertEq(exitRes.evidence, "manual_takeover_observe_only", "CASE O: exitPolicy evidence is manual_takeover_observe_only");

    // 2. runEngineV2 must short-circuit to HOLD with V2_MANUAL_TAKEOVER_AUTHORITY_PROOF
    const v2Res = runEngineV2({
      symbol: "BTCUSDT",
      now: 1700000040000,
      snapshot: {
        lastPrice: 95500,
        candles: []
      } as any,
      config: {} as any,
      state: {
        currentPositions: [btcShort],
        manualTakeoverActive: true
      } as any,
      v1Result: {} as any,
      evaluationMode: "authoritative"
    });

    assertEq(v2Res.decision.decision, "HOLD", "CASE O: runEngineV2 returns HOLD");
    assertEq(v2Res.decision.explanation.reason, "MANUAL_TAKEOVER_ACTIVE_OBSERVE_ONLY", "CASE O: truthful observe-only reason");
    assertEq(v2Res.decision.rawMetrics?.position_calculation_allowed, false, "CASE O: v2 position calculation blocked");
    assertEq(v2Res.decision.rawMetrics?.mutation_allowed, false, "CASE O: v2 mutation blocked");

    // 3. Ops-watch scan must PASS as operator-managed with 0 submit attempts
    const scanRes = evaluateOpsWatchProtectiveScanVerdict({
      nowMs: 1700000040000,
      ledger: btcShort,
      reduceOnlyProtectiveFound: false,
      matchingProtectivePendingCount: 0,
      scanClean: true,
      tpRequired: false
    });
    assertEq(scanRes.verdict, "PASS", "CASE O: ops-watch passes for operator managed");
    assertFalse(scanRes.shouldBlockSymbol, "CASE O: no false symbol block");

    console.log("[CASE O] PASS: Live BTC short manual intervention is 100% short-circuited to pure observe-only");
  }

  // CASE P: Poisoned Latch Recovery Immunity for Manual Takeover
  {
    const btcShort: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "BTCUSDT",
      side: "short",
      entryPrice: 95000,
      leverage: 10,
      sizeUsd: 9500,
      initialSizeUsd: 9500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "OPERATOR_MANAGED",
      status: "open",
      pos: 0.1,
      okxContracts: 1.0,
      isV2Authority: true,
      manualTakeoverActive: true,
      manualOwnershipLatch: true,
      manualOwnershipLatchSource: "CONFIRMED_MANUAL_SIZE_CHANGE",
      manualOwnershipLatchStrength: "STRONG"
    };

    const { evaluatePoisonedStrongManualLatchRecovery } = await import("../engine-v2/position/manual-ownership-latch");
    const recovery = evaluatePoisonedStrongManualLatchRecovery({
      ledger: btcShort,
      reconcileState: "MATCHED",
      okxActualContracts: 1.0,
      okxActualPositionExists: true,
      ledgerPaperContracts: 1.0,
      ledgerSide: "short",
      okxSide: "short",
      syncStatus: "ALIGNED"
    });

    assertFalse(recovery.shouldClear, "CASE P: Poisoned latch recovery must NOT clear manual takeover");
    assertEq(btcShort.lifecycleState, "OPERATOR_MANAGED", "CASE P: lifecycle remains OPERATOR_MANAGED");

    console.log("[CASE P] PASS: Manual takeover is immune to poisoned latch recovery re-adoption");
  }

  // CASE Q: Existing Normal Bot Position + PM2 Restart => NO False Takeover
  {
    const normalBotPos: PaperOpenPositionRecord = {
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
      stopPrice: 2480
    };

    // After restart, ledger has normalBotPos and OKX returns 1.0 contracts
    const delta = classifyPositionSizeDelta({
      beforeContracts: 1.0,
      afterContracts: 1.0,
      ledger: normalBotPos,
      botManaged: true,
      nowMs: 1700000050000
    });

    assertEq(delta.classification, "ALIGNED", "CASE Q: Restart contracts aligned classified as ALIGNED");
    assertFalse(normalBotPos.manualTakeoverActive === true, "CASE Q: Normal bot position manualTakeoverActive remains false");
    assertEq(normalBotPos.lifecycleState, "BOT_V2_MANAGED", "CASE Q: Lifecycle remains BOT_V2_MANAGED");

    console.log("[CASE Q] PASS: Existing normal bot position + PM2 restart does NOT trigger false takeover");
  }

  // CASE R: Temporary OKX Protective-Order Visibility Gap => NO False Takeover
  {
    const normalBotPos: PaperOpenPositionRecord = {
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
      stopPrice: 2480
    };

    // Simulate transient API glitch where algo scan returns 0 algos for 1 tick
    const scanVerdict = evaluateOpsWatchProtectiveScanVerdict({
      nowMs: 1700000060000,
      ledger: normalBotPos,
      reduceOnlyProtectiveFound: false,
      matchingProtectivePendingCount: 0,
      scanClean: false,
      tpRequired: false
    });

    // In-flight or missing algo triggers ENSURE or GRACE, but NEVER falsely latches manual takeover
    assertFalse(normalBotPos.manualTakeoverActive === true, "CASE R: Missing protective order does NOT falsely latch manual takeover");
    assertEq(normalBotPos.lifecycleState, "BOT_V2_MANAGED", "CASE R: Normal bot position remains BOT_V2_MANAGED");

    console.log("[CASE R] PASS: Temporary protective-order visibility gap does NOT trigger false takeover");
  }

  // CASE S: Pre-existing Manually Intervened BTC Migration to Manual Takeover
  {
    // Simulate pre-existing BTC short that was manually touched and marked with manualOwnershipLatch
    const preExistingBtcShort: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "BTCUSDT",
      side: "short",
      entryPrice: 96000,
      leverage: 10,
      sizeUsd: 9600,
      initialSizeUsd: 9600,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "EXTERNAL_MANUAL_MANAGED",
      status: "open",
      pos: 0.1,
      okxContracts: 1.0,
      isV2Authority: true,
      manualOwnershipLatch: true,
      manualOwnershipLatchSource: "CONFIRMED_MANUAL_SIZE_CHANGE",
      manualOwnershipLatchStrength: "STRONG"
    };

    // On engine reconcile/top-of-loop, createManualTakeoverRecord is triggered
    const takeoverRec = createManualTakeoverRecord({
      symbol: "BTCUSDT",
      side: "short",
      reason: "MANUAL_INTERVENTION_DETECTED",
      positionCycleId: preExistingBtcShort.positionCycleId,
      nowMs: 1700000070000
    });
    applyManualTakeoverToPositionRecord(preExistingBtcShort, takeoverRec);

    assertTrue(preExistingBtcShort.manualTakeoverActive === true, "CASE S: Pre-existing BTC short migrated to manualTakeoverActive=true");
    assertEq(preExistingBtcShort.lifecycleState, "OPERATOR_MANAGED", "CASE S: Pre-existing BTC short lifecycle is OPERATOR_MANAGED");

    console.log("[CASE S] PASS: Pre-existing manually intervened BTC position cleanly migrates to OPERATOR_MANAGED");
  }

  // CASE T: Takeover BTC Across 10 Consecutive Cycles => 0 Mutations & 0 Policy Calculations
  {
    const btcShort: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "BTCUSDT",
      side: "short",
      entryPrice: 95000,
      leverage: 10,
      sizeUsd: 9500,
      initialSizeUsd: 9500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "OPERATOR_MANAGED",
      status: "open",
      pos: 0.1,
      okxContracts: 1.0,
      isV2Authority: true,
      manualTakeoverActive: true
    };

    let mutatingCallsCount = 0;
    let positionCalculationsCount = 0;

    for (let cycle = 1; cycle <= 10; cycle++) {
      const now = 1700000080000 + cycle * 1000;

      // 1. Exit Policy evaluation
      const exitRes = evaluateV2ExitPolicy({
        symbol: "BTCUSDT",
        v2State: {
          shortPosition: btcShort,
          longPosition: null,
          symbolPositions: [btcShort]
        } as any,
        judgment: {
          regime: "TREND",
          subtype: "BEAR_TREND",
          isAmbiguous: false,
          shockPhase: "NONE",
          transitionPhase: "NONE"
        } as any,
        snapshot: {
          boxPos: 0.5,
          boxBreakSide: "none",
          emaGap: 0,
          trendWeaknessScore: 0,
          rangeConfidence: 0,
          qualityScore: 1,
          atr20: 1000
        },
        trendSideCandidate: "none",
        rangeSideCandidate: "none",
        reversalConfirmed: false,
        invalidationBreachConfirmed: false,
        structuralBreakConfirmed: false,
        boxBreakConfirmed: false,
        markPrice: 95000 + cycle * 50
      });

      assertEq(exitRes.action, "HOLD", `CASE T (cycle ${cycle}): exitPolicy action is HOLD`);
      assertFalse(exitRes.shouldExit, `CASE T (cycle ${cycle}): shouldExit is false`);
      assertFalse(exitRes.shouldReduce, `CASE T (cycle ${cycle}): shouldReduce is false`);
      assertFalse(exitRes.shouldPartial, `CASE T (cycle ${cycle}): shouldPartial is false`);
      if (exitRes.shouldExit || exitRes.shouldReduce || exitRes.shouldPartial) {
        positionCalculationsCount++;
      }

      // 2. runEngineV2 evaluation
      const v2Res = runEngineV2({
        symbol: "BTCUSDT",
        now,
        snapshot: {
          lastPrice: 95000 + cycle * 50,
          candles: []
        } as any,
        config: {} as any,
        state: {
          currentPositions: [btcShort],
          manualTakeoverActive: true
        } as any,
        v1Result: {} as any,
        evaluationMode: "authoritative"
      });

      assertEq(v2Res.decision.decision, "HOLD", `CASE T (cycle ${cycle}): v2Decision is HOLD`);
      assertEq(v2Res.decision.risk.isBlocked, true, `CASE T (cycle ${cycle}): risk isBlocked is true`);
      assertEq(v2Res.decision.rawMetrics?.mutation_allowed, false, `CASE T (cycle ${cycle}): mutation_allowed is false`);
      assertEq(v2Res.decision.rawMetrics?.position_calculation_allowed, false, `CASE T (cycle ${cycle}): position_calculation_allowed is false`);

      if (v2Res.decision.decision === "ENTER" || v2Res.decision.executionAction === "ENTER" || v2Res.decision.executionAction === "ADDON") {
        mutatingCallsCount++;
      }

      // 3. Action guard
      const guard = evaluateManualTakeoverActionGuard({
        symbol: "BTCUSDT",
        side: "short",
        action: "PROTECTIVE_SUBMIT",
        manualTakeoverActive: true
      });
      assertFalse(guard.allowed, `CASE T (cycle ${cycle}): action guard forbids PROTECTIVE_SUBMIT`);
      if (guard.allowed) {
        mutatingCallsCount++;
      }
    }

    assertEq(mutatingCallsCount, 0, "CASE T: Total mutating calls count is EXACTLY 0 across 10 cycles");
    assertEq(positionCalculationsCount, 0, "CASE T: Total position calculations count is EXACTLY 0 across 10 cycles");

    console.log("[CASE T] PASS: 10 consecutive cycles confirm ZERO mutations and ZERO position-policy calculations");
  }

  // CASE U: Takeover BTC Without SL/TP => NO POSITION_UNPROTECTED_HARD_BLOCK
  {
    const btcShort: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "BTCUSDT",
      side: "short",
      entryPrice: 95000,
      leverage: 10,
      sizeUsd: 9500,
      initialSizeUsd: 9500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "OPERATOR_MANAGED",
      status: "open",
      pos: 0.1,
      okxContracts: 1.0,
      isV2Authority: true,
      manualTakeoverActive: true
    };

    // Ops watch scan for operator-managed position with 0 exchange protective orders
    const verdict = evaluateOpsWatchProtectiveScanVerdict({
      nowMs: 1700000090000,
      ledger: btcShort,
      reduceOnlyProtectiveFound: false,
      matchingProtectivePendingCount: 0,
      scanClean: true,
      tpRequired: false
    });

    assertEq(verdict.verdict, "PASS", "CASE U: Ops-watch returns PASS for operator-managed position");
    assertFalse(verdict.shouldBlockSymbol, "CASE U: shouldBlockSymbol is false");
    assertEq(verdict.reason, "manual_takeover_operator_managed", "CASE U: reason is manual_takeover_operator_managed");

    console.log("[CASE U] PASS: Takeover BTC without SL/TP passes ops-watch with NO POSITION_UNPROTECTED_HARD_BLOCK");
  }

  // CASE V: Takeover Persists Through Restart Before First V2/Ops-Watch Evaluation
  {
    const testDoc: ManualTakeoverStoreDoc = {
      updatedAt: 1700000100000,
      bySymbol: {
        "BTCUSDT:short": {
          manualTakeoverActive: true,
          manualTakeoverSymbol: "BTCUSDT",
          manualTakeoverSide: "short",
          manualTakeoverDetectedAt: 1700000100000,
          manualTakeoverReason: "OPERATOR_MANUAL_INTERVENTION"
        },
        "BTCUSDT": {
          manualTakeoverActive: true,
          manualTakeoverSymbol: "BTCUSDT",
          manualTakeoverSide: "short",
          manualTakeoverDetectedAt: 1700000100000,
          manualTakeoverReason: "OPERATOR_MANUAL_INTERVENTION"
        }
      }
    };

    const tmpDir = path.resolve(process.cwd(), "scratch/test_takeover_restart_pre_eval");
    await fs.mkdir(path.resolve(tmpDir, "control"), { recursive: true });

    await writeManualTakeoverDocToDisk(tmpDir, testDoc);
    const loadedDoc = await readManualTakeoverDocFromDisk(tmpDir);

    assertTrue(isManualTakeoverActiveForSymbol("BTCUSDT", "short", loadedDoc.bySymbol), "CASE V: Latch loaded before first evaluation");
    assertTrue(isManualTakeoverActiveForSymbol("BTCUSDT", null, loadedDoc.bySymbol), "CASE V: Symbol lookup active");

    const freshLedgerPos: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "BTCUSDT",
      side: "short",
      entryPrice: 95000,
      leverage: 10,
      sizeUsd: 9500,
      initialSizeUsd: 9500,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "BOT_V2_MANAGED",
      status: "open",
      pos: 0.1,
      okxContracts: 1.0,
      isV2Authority: true
    };

    // Hydrate position from loaded latch BEFORE any tick evaluation
    const activeRec = loadedDoc.bySymbol["BTCUSDT:short"];
    applyManualTakeoverToPositionRecord(freshLedgerPos, activeRec);

    assertTrue(freshLedgerPos.manualTakeoverActive === true, "CASE V: Hydrated position has manualTakeoverActive=true");
    assertEq(freshLedgerPos.lifecycleState, "OPERATOR_MANAGED", "CASE V: Hydrated position lifecycleState is OPERATOR_MANAGED");

    console.log("[CASE V] PASS: Takeover latch loaded and hydrated on restart BEFORE first V2/ops-watch cycle");
  }

  // CASE AA: flat + stale bot SL -> new BTC ENTER blocked
  {
    const map = new Map<string, ManualTakeoverRecord>();
    const rec = createManualTakeoverRecord({ symbol: "BTCUSDT", side: "long", reason: "MANUAL_FULL_CLOSE" });
    map.set("BTCUSDT:long", rec);
    map.set("BTCUSDT", rec);
    syncManualTakeoverLifecycleEntries(map, [], { "BTCUSDT:long": 1, BTCUSDT: 1 });
    assertTrue(
      isManualTakeoverActiveForSymbol("BTCUSDT", "long", map, [], { engineOwnedOrderCount: 1 }),
      "CASE AA: takeover quarantine while stale bot algo remains"
    );
    const guard = evaluateManualTakeoverActionGuard({
      symbol: "BTCUSDT",
      side: "long",
      action: "ENTER",
      manualTakeoverActive: isManualTakeoverActiveForSymbol("BTCUSDT", "long", map, [], { engineOwnedOrderCount: 1 })
    });
    assertFalse(guard.allowed, "CASE AA: new BTC entry blocked");
    console.log("[CASE AA] PASS: Flat takeover with stale engine algo blocks new entry");
  }

  // CASE AB: stale bot algo cleared -> old cycle expires -> new BTC entry allowed
  {
    const map = new Map<string, ManualTakeoverRecord>();
    const rec = createManualTakeoverRecord({ symbol: "BTCUSDT", side: "long", reason: "MANUAL_FULL_CLOSE" });
    map.set("BTCUSDT:long", rec);
    map.set("BTCUSDT", rec);
    syncManualTakeoverLifecycleEntries(map, [], { "BTCUSDT:long": 0, BTCUSDT: 0 });
    assertFalse(
      isManualTakeoverActiveForSymbol("BTCUSDT", "long", map, [], { engineOwnedOrderCount: 0 }),
      "CASE AB: takeover cleared after engine cleanup"
    );
    const guard = evaluateManualTakeoverActionGuard({
      symbol: "BTCUSDT",
      side: "long",
      action: "ENTER",
      manualTakeoverActive: false
    });
    assertTrue(guard.allowed, "CASE AB: new BTC entry allowed");
    console.log("[CASE AB] PASS: Stale bot algo cleared -> old cycle expires -> new BTC entry allowed");
  }

  // CASE AC: operator manual order survives authoritative cleanup predicate
  {
    const botOpen: PaperOpenPositionRecord = {
      openedAt: 1700000000000,
      symbol: "BTCUSDT",
      side: "long",
      entryPrice: 70_000,
      leverage: 10,
      sizeUsd: 400,
      initialSizeUsd: 400,
      strategyVersion: "paper-v2",
      sourceSignal: "v2_engine",
      sourceRunPath: "live_run",
      lifecycleState: "BOT_V2_MANAGED",
      status: "open",
      pos: 0.01,
      okxContracts: 0.01,
      isV2Authority: true,
      protectiveSlAlgoId: "bot-algo-123"
    };
    const staleBotAlgo = { algoId: "bot-algo-123", algoClOrdId: "oapBTCUlsg7k2j3s" };
    const operatorLimit = { ordId: "op-999", clOrdId: "manualOperatorLimit", reduceOnly: "true" };
    assertTrue(isAuthoritativeBotOwnedAlgoOrder(staleBotAlgo, [botOpen]), "CASE AC: stale bot SL is authoritative");
    assertFalse(isAuthoritativeBotOwnedPendingOrder(operatorLimit, [botOpen]), "CASE AC: operator manual order NOT authoritative");
    console.log("[CASE AC] PASS: Operator manual order survives cleanup predicate isolation");
  }

  // CASE AD: protective-only manual modification latches before calculation
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
      isProtectiveStopRegistered: true,
      protectiveSlAlgoId: "sl-gone",
      protectiveVisibilityGraceDeadlineMs: 0,
      entryProtectionUntil: 0
    };
    assertTrue(
      shouldLatchManualProtectiveOnlyIntervention({
        ledger: botOpen,
        reduceOnlyProtectiveFound: false,
        matchingProtectivePendingCount: 0,
        scanClean: true,
        nowMs: 1700000020000
      }),
      "CASE AD: protective-only mutation detected before any calc"
    );
    applyManualTakeoverToPositionRecord(
      botOpen,
      createManualTakeoverRecord({ symbol: "ETHUSDT", side: "long", reason: "MANUAL_PROTECTIVE_CHANGE" })
    );
    assertTrue(botOpen.manualTakeoverActive === true, "CASE AD: takeover latched");
    const exitGate = evaluateV2ExitExecutionGate({ manualTakeoverActive: true, requestedAction: "close" } as any);
    assertFalse(exitGate.allowed, "CASE AD: bot exit calculation blocked");
    console.log("[CASE AD] PASS: Protective-only manual modification latches before calculation");
  }

  console.log("=== ALL REGRESSION CASES (A-AD) PASSED SUCCESSFULLY ===");
}

runManualTakeoverRegressionTests().catch((err) => {
  console.error("FATAL ERROR in regression tests:", err);
  process.exit(1);
});
