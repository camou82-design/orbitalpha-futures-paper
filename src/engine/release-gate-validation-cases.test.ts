/**
 * FINAL RELEASE GATE — validation-only proofs (no deploy).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createManualTakeoverRecord,
  syncManualTakeoverLifecycleEntries,
  isManualTakeoverActiveForSymbol,
  isAuthoritativeBotOwnedAlgoOrder,
  isAuthoritativeBotOwnedPendingOrder,
  evaluateManualTakeoverActionGuard
} from "../engine-v2/position/manual-takeover-authority";
import { evaluateEquityAdaptiveSizing } from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { resolveLiveExposureAuthority } from "../engine-v2/live-account/exposure-authority";
import type { PaperOpenPositionRecord } from "../models/types";

function audit(label: string, detail: Record<string, unknown>): void {
  console.log(`[RELEASE-GATE][${label}] ${JSON.stringify(detail)}`);
}

// B — same-cycle ordering: latch before runEngineV2 / tryPaperPositionClose
{
  const src = readFileSync(join(__dirname, "./paper-engine.ts"), "utf8");
  const barrierIdx = src.indexOf("ensureStartupPositionAuthorityBarrier");
  const reconcileIdx = src.indexOf("await this.runPositionStateReconciliation");
  const latchIdx = src.indexOf("latchManualProtectiveInterventionsFromExchangeScan");
  const v2Idx = src.indexOf("const tV2Decision0 = Date.now()");
  const closeIdx = src.indexOf("await this.tryPaperPositionClose({");
  assert.ok(barrierIdx > 0, "startup barrier exists");
  assert.ok(barrierIdx < reconcileIdx, "startup barrier before position reconcile");
  assert.ok(latchIdx > 0, "latch helper exists");
  assert.ok(latchIdx < v2Idx, "protective latch before runEngineV2 sym loop");
  assert.ok(latchIdx < closeIdx, "protective latch before tryPaperPositionClose");
  assert.ok(src.includes("V2_MANUAL_PROTECTIVE_ONLY_TAKEOVER_PRE_V2_PROOF"));
  assert.ok(src.includes("V2_STARTUP_POSITION_AUTHORITY_BARRIER_PROOF"));
  audit("B_SAME_CYCLE_ORDERING", { barrier_before_reconcile: true, latch_before_v2: true, latch_before_close: true });
}

// AG — flat + stale engine algo after failed cancel => quarantine
{
  const map = new Map<string, ReturnType<typeof createManualTakeoverRecord>>();
  const rec = createManualTakeoverRecord({ symbol: "BTCUSDT", side: "long", reason: "MANUAL_FULL_CLOSE" });
  map.set("BTCUSDT:long", rec);
  syncManualTakeoverLifecycleEntries(map, [], { "BTCUSDT:long": 1, BTCUSDT: 1 });
  assert.equal(isManualTakeoverActiveForSymbol("BTCUSDT", "long", map, [], { engineOwnedOrderCount: 1 }), true);
  const guard = evaluateManualTakeoverActionGuard({
    symbol: "BTCUSDT",
    side: "long",
    action: "ENTER",
    manualTakeoverActive: true
  });
  assert.equal(guard.allowed, false);
  audit("AG_STALE_ALGO_QUARANTINE", { blocked: true, reason: guard.blockReason });
}

// AH — bounded housekeeping: retry path exists in syncManualTakeoverLifecycleFromOpens caller
{
  const src = readFileSync(join(__dirname, "./paper-engine.ts"), "utf8");
  assert.ok(src.includes("cancelEngineOwnedOrdersOnTakeover(sym, side)"));
  assert.ok(src.includes("MANUAL_TAKEOVER_FLAT_PENDING_ENGINE_ORDER_CLEANUP"));
  const operatorOrd = { ordId: "op-1", clOrdId: "manualOperatorSl", reduceOnly: "true" };
  const botOpen: PaperOpenPositionRecord = {
    openedAt: 1_700_000_000_000,
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 70_000,
    leverage: 10,
    sizeUsd: 400,
    initialSizeUsd: 400,
    strategyVersion: "paper-v2",
    sourceSignal: "v2",
    sourceRunPath: "live",
    lifecycleState: "BOT_V2_MANAGED",
    status: "open",
    pos: 0.01,
    okxContracts: 0.01,
    isV2Authority: true,
    protectiveSlAlgoId: "old-cycle-algo"
  };
  assert.equal(isAuthoritativeBotOwnedPendingOrder(operatorOrd, [botOpen]), false);
  assert.equal(isAuthoritativeBotOwnedAlgoOrder({ algoId: "old-cycle-algo" }, [botOpen]), true);
  audit("AH_HOUSEKEEPING_RETRY_PATH", { cancel_on_each_sync: true, operator_untouched: true });
}

// AI — cleanup success => new BTC entry allowed
{
  const map = new Map<string, ReturnType<typeof createManualTakeoverRecord>>();
  const rec = createManualTakeoverRecord({ symbol: "BTCUSDT", side: "long", reason: "MANUAL_FULL_CLOSE" });
  map.set("BTCUSDT:long", rec);
  syncManualTakeoverLifecycleEntries(map, [], { "BTCUSDT:long": 0, BTCUSDT: 0 });
  assert.equal(isManualTakeoverActiveForSymbol("BTCUSDT", "long", map, [], { engineOwnedOrderCount: 0 }), false);
  audit("AI_NEW_BTC_AFTER_CLEANUP", { entry_allowed: true });
}

// AJ — old stale algo is cleanup-eligible but not bound to new position ledger IDs
{
  const newOpen: PaperOpenPositionRecord = {
    openedAt: 1_800_000_000_000,
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 70_000,
    leverage: 10,
    sizeUsd: 400,
    initialSizeUsd: 400,
    strategyVersion: "paper-v2",
    sourceSignal: "v2",
    sourceRunPath: "live",
    lifecycleState: "BOT_V2_MANAGED",
    status: "open",
    pos: 0.01,
    okxContracts: 0.01,
    isV2Authority: true,
    positionCycleId: "new-flow-id",
    protectiveSlAlgoId: "new-algo-222"
  };
  const staleByIdOnly = { algoId: "old-algo-111" };
  const staleByOldClOrd = { algoId: "orphan", algoClOrdId: "oapBTCUlsg7k2j3s" };
  const newCycleClOrd = `oapBTCUl${newOpen.openedAt.toString(36)}s`;
  assert.equal(isAuthoritativeBotOwnedAlgoOrder(staleByIdOnly, [newOpen]), false);
  assert.equal(isAuthoritativeBotOwnedAlgoOrder(staleByOldClOrd, [newOpen]), true);
  assert.equal(isAuthoritativeBotOwnedAlgoOrder({ algoId: "new-algo-222" }, [newOpen]), true);
  assert.notEqual(staleByOldClOrd.algoClOrdId, newCycleClOrd);
  audit("AJ_OLD_ALGO_CANNOT_CLOSE_NEW", {
    stale_id_on_new_ledger: false,
    stale_old_clord_cleanup_eligible: true,
    new_ledger_algo_id: "new-algo-222",
    new_cycle_clord_differs: true
  });
}

// D — Scenario A: equity ~194, manual BTC ~1957 => ETH entry blocked
{
  const equity = 194;
  const manualBtcNotional = 1957;
  const ethInst = { lotSz: 0.01, minSz: 0.01, ctVal: 0.1, ctValCcy: "ETH" };
  const entry = 3500;
  const stop = 3450;
  const exposure = resolveLiveExposureAuthority({
    symbol: "ETHUSDT",
    okxPositions: [{ symbol: "BTCUSDT", side: "long", sizeUsd: manualBtcNotional }],
    paperPositions: [],
    okxActualPositions: [{ symbol: "BTCUSDT", side: "long", notionalUsd: manualBtcNotional }],
    pendingSymbolNotionalUsdt: 0,
    pendingOrdersNotionalUsdt: 0,
    isLiveAuthority: true
  });
  const accountCap = equity * 3.0;
  const remainingAccount = Math.max(0, accountCap - exposure.final_account_notional_usdt);
  const sizing = evaluateEquityAdaptiveSizing({
    symbol: "ETHUSDT",
    side: "long",
    orderKind: "ENTRY",
    accountEquityUsdt: equity,
    availableBalanceUsdt: equity,
    entryReferencePrice: entry,
    effectiveStopPrice: stop,
    appliedLeverage: 10,
    entryQualityGrade: "A",
    existingSymbolNotionalUsdt: 0,
    existingAccountNotionalUsdt: exposure.final_account_notional_usdt,
    emergencyAbsoluteCapUsdt: 500,
    legacyStaticCapUsdt: 40,
    v2AuthorityEntry: true,
    roundTripFeeRate: 0.001,
    lastPrice: entry,
    instrumentSizing: ethInst
  });
  audit("D_SCENARIO_A_MANUAL_BTC_OPEN", {
    equity_usdt: equity,
    manual_btc_notional_usdt: manualBtcNotional,
    final_account_notional_usdt: exposure.final_account_notional_usdt,
    account_cap_usdt: accountCap,
    remaining_account_capacity_usdt: remainingAccount,
    risk_based_notional_usdt: sizing.riskBasedNotionalUsdt,
    symbol_cap_usdt: sizing.symbolCapUsdt,
    pre_lot_notional_usdt: sizing.preLotNotionalUsdt,
    sizing_passed: sizing.sizingPassed,
    block_reason: sizing.blockReason,
    final_order_notional_usdt: sizing.finalOrderNotionalUsdt,
    normalized_contracts: sizing.normalizedContracts
  });
  assert.equal(remainingAccount, 0);
  assert.equal(sizing.sizingPassed, false);
  assert.equal(sizing.blockReason, "MAX_ACCOUNT_NOTIONAL_EXCEEDED");
}

// E — Scenario B: equity ~194, no exposure => V2 ETH not legacy-40 truncated
{
  const equity = 194;
  const ethInst = { lotSz: 0.01, minSz: 0.01, ctVal: 0.1, ctValCcy: "ETH" };
  const entry = 3500;
  const stop = 3450;
  const leverage = 10;
  const sizing = evaluateEquityAdaptiveSizing({
    symbol: "ETHUSDT",
    side: "long",
    orderKind: "ENTRY",
    accountEquityUsdt: equity,
    availableBalanceUsdt: equity,
    entryReferencePrice: entry,
    effectiveStopPrice: stop,
    appliedLeverage: leverage,
    entryQualityGrade: "A",
    existingSymbolNotionalUsdt: 0,
    existingAccountNotionalUsdt: 0,
    emergencyAbsoluteCapUsdt: 500,
    legacyStaticCapUsdt: 40,
    v2AuthorityEntry: true,
    roundTripFeeRate: 0.001,
    lastPrice: entry,
    instrumentSizing: ethInst
  });
  const recomputed = (sizing.normalizedContracts ?? 0) * ethInst.ctVal * entry;
  audit("E_SCENARIO_B_BTC_FLAT", {
    equity_usdt: equity,
    risk_based_notional_usdt: sizing.riskBasedNotionalUsdt,
    equity_initial_cap_usdt: sizing.equityInitialCapUsdt,
    symbol_cap_usdt: sizing.symbolCapUsdt,
    account_cap_usdt: sizing.accountCapUsdt,
    ultimate_safety_cap_usdt: sizing.ultimateSafetyCapUsdt,
    effective_live_cap_usdt: sizing.effectiveLiveCapUsdt,
    pre_lot_notional_usdt: sizing.preLotNotionalUsdt,
    normalized_contracts: sizing.normalizedContracts,
    ctVal: ethInst.ctVal,
    price: entry,
    final_notional_usdt: sizing.finalOrderNotionalUsdt,
    required_margin_usdt: sizing.finalRequiredMarginUsdt,
    usable_available_margin_usdt: sizing.usableAvailableBalanceUsdt,
    recomputed_notional: recomputed,
    legacy_40_truncated: sizing.finalOrderNotionalUsdt <= 40
  });
  assert.equal(sizing.sizingPassed, true);
  assert.ok(sizing.finalOrderNotionalUsdt > 40);
  assert.equal(sizing.effectiveLiveCapUsdt, 500);
}

console.log("[RELEASE-GATE] ALL VALIDATION PROOFS COMPLETED");
