/**
 * LIVE TRADING AUTHORITY + ENTRY + SIZING — causal audit regressions (local proof).
 * Cases W–AF: blocking audit final regressions.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createManualTakeoverRecord,
  syncManualTakeoverLifecycleEntries,
  isManualTakeoverActiveForSymbol,
  isAuthoritativeBotOwnedPendingOrder,
  isAuthoritativeBotOwnedAlgoOrder,
  isOperatorManagedOpenPosition,
  evaluateManualTakeoverActionGuard,
  shouldLatchManualProtectiveOnlyIntervention
} from "../engine-v2/position/manual-takeover-authority";
import { evaluateV2ExitExecutionGate } from "../engine-v2/exit/exit-execution-gate";
import {
  evaluateEquityAdaptiveSizing,
  resolveEffectiveLiveOrderNotionalCap,
  resolveUltimateSafetyCapForOrderSizing
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { resolveLiveExposureAuthority } from "../engine-v2/live-account/exposure-authority";
import { normalizeOkxSwapContractsFromNotional } from "../engine-v2/okx-swap-sizing";
import { resolveLiveSubmitStaticSafetyCap } from "./paper-engine";
import type { PaperOpenPositionRecord } from "../models/types";

function audit(label: string, detail: Record<string, unknown>): void {
  console.log(`[LIVE-AUTH-AUDIT][${label}] ${JSON.stringify(detail)}`);
}

function openPos(input: Partial<PaperOpenPositionRecord> & Pick<PaperOpenPositionRecord, "symbol" | "side">): PaperOpenPositionRecord {
  return {
    openedAt: input.openedAt ?? 1_700_000_000_000,
    entryPrice: input.entryPrice ?? 70_000,
    leverage: input.leverage ?? 10,
    sizeUsd: input.sizeUsd ?? 400,
    initialSizeUsd: input.initialSizeUsd ?? input.sizeUsd ?? 400,
    strategyVersion: input.strategyVersion ?? "paper-v2",
    sourceSignal: input.sourceSignal ?? "manual",
    sourceRunPath: input.sourceRunPath ?? "live",
    lifecycleState: input.lifecycleState ?? "OPERATOR_MANAGED",
    status: input.status ?? "open",
    pos: input.pos ?? 0.01,
    okxContracts: input.okxContracts ?? 0.01,
    manualTakeoverActive: input.manualTakeoverActive ?? true,
    ...input
  } as PaperOpenPositionRecord;
}

/** Mirror of index.ts HTF counter-trend RANGE gate (side-specific reversal evidence). */
function isHtfCounterTrendRangeBlocked(input: Readonly<{
  side: "long" | "short";
  zone: string;
  htf_1h_bias: string;
  htf_4h_bias: string;
  htf_1d_bias: string;
  reversalConfirmed?: boolean;
  metadata?: Record<string, unknown>;
  subtype?: string;
  shockReactionPromotionType?: string;
}>): boolean {
  const htfBiases = [input.htf_1h_bias, input.htf_4h_bias, input.htf_1d_bias].map((b) => b.toUpperCase());
  const bullishHtfCount = htfBiases.filter((b) => b === "BULLISH").length;
  const bearishHtfCount = htfBiases.filter((b) => b === "BEARISH").length;
  const meta = input.metadata ?? {};
  const upperFailureShortEvidence =
    input.side === "short" &&
    input.zone === "upper" &&
    (input.reversalConfirmed === true ||
      input.subtype === "BREAKDOWN_RETEST_FAILED" ||
      meta.retestRejected === true ||
      meta.box_upper_breakout_hold === false ||
      meta.upper_failure_short === true ||
      input.shockReactionPromotionType === "upper_failure_short" ||
      input.shockReactionPromotionType === "upper_reversal_confirmed_short");
  const lowerReversalLongEvidence =
    input.side === "long" &&
    input.zone === "lower" &&
    (input.reversalConfirmed === true ||
      meta.reclaimConfirmed === true ||
      meta.reclaim_confirmed === true ||
      meta.box_lower_breakdown_hold === false ||
      meta.lower_reversal_confirmed === true ||
      input.shockReactionPromotionType === "lower_reversal_confirmed_long");
  const hasExplicitReversalEvidence =
    input.side === "short" ? upperFailureShortEvidence : input.side === "long" ? lowerReversalLongEvidence : false;

  if (input.side === "short" && input.zone === "upper" && bullishHtfCount >= 2 && !hasExplicitReversalEvidence) {
    return true;
  }
  if (input.side === "long" && input.zone === "lower" && bearishHtfCount >= 2 && !hasExplicitReversalEvidence) {
    return true;
  }
  return false;
}

// 1-3 manual BTC operator position -> bot mutation blocked
{
  const btc = openPos({ symbol: "BTCUSDT", side: "long", lifecycleState: "OPERATOR_MANAGED" });
  assert.equal(isOperatorManagedOpenPosition(btc), true);
  const exitGate = evaluateV2ExitExecutionGate({ manualTakeoverActive: true, requestedAction: "close" } as any);
  assert.equal(exitGate.allowed, false);
  assert.equal(exitGate.blockReason, "MANUAL_TAKEOVER_ACTIVE");
  audit("MANUAL_BTC_BOT_MUTATION_ZERO", { exit_gate: exitGate.blockReason });
}

// 2 bot-owned pending preserved vs operator — predicate isolation
{
  const botOpen = openPos({
    symbol: "ETHUSDT",
    side: "long",
    lifecycleState: "BOT_V2_MANAGED",
    manualTakeoverActive: false,
    closePendingClOrdId: "pETHUSlsg7k2j3"
  });
  const operatorOrd = { ordId: "999", clOrdId: "manualOperator123", reduceOnly: "false" };
  const botOrd = { ordId: "111", clOrdId: "pETHUSlsg7k2j3", reduceOnly: "false" };
  assert.equal(isAuthoritativeBotOwnedPendingOrder(operatorOrd, [botOpen]), false);
  assert.equal(isAuthoritativeBotOwnedPendingOrder(botOrd, [botOpen]), true);
  audit("OPERATOR_PENDING_PRESERVED", { operator_is_bot_owned: false, bot_is_bot_owned: true });
}

// 4-6 position cycle expiry -> new BTC entry path unblocked (requires engine order cleanup)
{
  const map = new Map<string, ReturnType<typeof createManualTakeoverRecord>>();
  const rec = createManualTakeoverRecord({ symbol: "BTCUSDT", side: "long", reason: "MANUAL_ADD" });
  map.set("BTCUSDT:long", rec);
  map.set("BTCUSDT", rec);
  assert.equal(isManualTakeoverActiveForSymbol("BTCUSDT", "long", map, [openPos({ symbol: "BTCUSDT", side: "long" })]), true);
  const cleared = syncManualTakeoverLifecycleEntries(map, [], { "BTCUSDT:long": 0, BTCUSDT: 0 });
  assert.ok(cleared.length >= 1);
  assert.equal(isManualTakeoverActiveForSymbol("BTCUSDT", "long", map, [], { engineOwnedOrderCount: 0 }), false);
  const entryGuard = evaluateManualTakeoverActionGuard({
    symbol: "BTCUSDT",
    side: "long",
    action: "ENTER",
    manualTakeoverActive: isManualTakeoverActiveForSymbol("BTCUSDT", "long", map, [], { engineOwnedOrderCount: 0 })
  });
  assert.equal(entryGuard.allowed, true);
  audit("BTC_NEW_CYCLE_AFTER_FLAT", { cleared_keys: cleared, entry_allowed: entryGuard.allowed });
}

// Z manual BTC exposure counted once for account risk
{
  const manualBtc = openPos({
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: 800,
    okxContracts: 0.01,
    lifecycleState: "OPERATOR_MANAGED",
    isV2Authority: false
  });
  const botEth = openPos({
    symbol: "ETHUSDT",
    side: "long",
    sizeUsd: 40,
    okxContracts: 0.01,
    lifecycleState: "BOT_V2_MANAGED",
    manualTakeoverActive: false,
    isV2Authority: true
  });
  const exposure = resolveLiveExposureAuthority({
    symbol: "ETHUSDT",
    okxPositions: [
      { symbol: "BTCUSDT", side: "long", sizeUsd: 800 },
      { symbol: "ETHUSDT", side: "long", sizeUsd: 40 }
    ],
    paperPositions: [manualBtc, botEth],
    okxActualPositions: [
      { symbol: "BTCUSDT", side: "long", notionalUsd: 800 },
      { symbol: "ETHUSDT", side: "long", notionalUsd: 40 }
    ],
    pendingSymbolNotionalUsdt: 0,
    pendingOrdersNotionalUsdt: 0,
    isLiveAuthority: true
  });
  assert.equal(exposure.final_account_notional_usdt, 840);
  assert.equal(exposure.strategy_account_notional_usdt, 40);
  assert.equal(exposure.manual_external_notional_usdt, 800);
  audit("Z_MANUAL_BTC_ACCOUNT_EXPOSURE_ONCE", {
    final_account: exposure.final_account_notional_usdt,
    strategy_only: exposure.strategy_account_notional_usdt,
    manual_external: exposure.manual_external_notional_usdt
  });
}

// W + D — V2 grade-A ETH sizing before/after legacy 40 cap removal
{
  const ethInst = { lotSz: 0.01, minSz: 0.01, ctVal: 0.1, ctValCcy: "ETH" };
  const entry = 3_500;
  const stop = 3_450;
  const equity = 800;
  const leverage = 10;
  const emergency = 500;
  const legacy = 40;

  const beforeLegacyCap = resolveEffectiveLiveOrderNotionalCap({
    emergencyCapUsdt: emergency,
    legacyStaticCapUsdt: legacy
  }).effectiveLiveCapUsdt!;
  const riskBased = (equity * 0.01) / Math.abs(entry - stop) / entry;
  const riskCap = riskBased * entry;
  const symbolCap = equity * 2.5;
  const accountCap = equity * 3.0 - 800;
  const marginCap = equity * 0.8 * leverage;
  const beforeFinal = Math.min(riskCap, equity * 2, symbolCap, accountCap, beforeLegacyCap);
  const beforeNorm = normalizeOkxSwapContractsFromNotional({
    desiredNotionalUsdt: beforeFinal,
    lastPrice: entry,
    sizing: ethInst
  });

  const after = evaluateEquityAdaptiveSizing({
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
    existingAccountNotionalUsdt: 800,
    emergencyAbsoluteCapUsdt: emergency,
    legacyStaticCapUsdt: legacy,
    v2AuthorityEntry: true,
    roundTripFeeRate: 0.001,
    lastPrice: entry,
    instrumentSizing: ethInst
  });

  assert.equal(after.sizingPassed, true);
  assert.ok(after.finalOrderNotionalUsdt > beforeNorm.actualNotional + 1, "AFTER exceeds BEFORE legacy-truncated size");
  assert.equal(after.effectiveLiveCapUsdt, null);
  assert.equal(after.ultimateSafetyCapUsdt, null);
  assert.equal(after.emergencyCapUsdt, emergency);

  const submit = resolveLiveSubmitStaticSafetyCap({
    authoritySource: "v2",
    okxLiveStaticNotionalCapEnabled: true,
    staticSafetyCapUsdt: null,
    intendedNotionalUsdt: after.finalOrderNotionalUsdt,
    emergencyUltimateCapUsdt: emergency,
    emergencyFailsafeActive: false
  });
  assert.equal(submit.skipStaticCapForV2Authority, true);
  assert.equal(submit.finalSubmittedNotionalUsdt, after.finalOrderNotionalUsdt);

  const recomputed = (after.normalizedContracts ?? 0) * ethInst.ctVal * entry;
  assert.ok(Math.abs(recomputed - (after.normalizedNotionalUsdt ?? 0)) < 0.01);

  audit("W_D_ETH_BEFORE_AFTER", {
    before_legacy_cap_usdt: beforeLegacyCap,
    before_final_notional_usdt: beforeNorm.actualNotional,
    before_contracts: beforeNorm.normalized_contracts,
    after_risk_cap: after.riskBasedNotionalUsdt,
    after_symbol_cap: after.symbolCapUsdt,
    after_account_cap_remaining: after.accountCapUsdt - 800,
    after_ultimate_safety_cap: after.ultimateSafetyCapUsdt,
    after_margin_cap_usable: after.usableAvailableBalanceUsdt * leverage,
    after_final_notional_usdt: after.finalOrderNotionalUsdt,
    after_contracts: after.normalizedContracts,
    after_ctVal_price_margin: {
      contracts: after.normalizedContracts,
      ctVal: ethInst.ctVal,
      price: entry,
      notional: recomputed,
      margin: after.finalRequiredMarginUsdt
    },
    submit_final: submit.finalSubmittedNotionalUsdt
  });
}

// X — non-V2 still respects legacy 40
{
  const legacy = evaluateEquityAdaptiveSizing({
    symbol: "BTCUSDT",
    side: "long",
    orderKind: "ENTRY",
    accountEquityUsdt: 600,
    availableBalanceUsdt: 600,
    entryReferencePrice: 70_000,
    effectiveStopPrice: 68_820,
    appliedLeverage: 10,
    entryQualityGrade: "A",
    existingSymbolNotionalUsdt: 0,
    existingAccountNotionalUsdt: 0,
    emergencyAbsoluteCapUsdt: 500,
    legacyStaticCapUsdt: 40,
    roundTripFeeRate: 0,
    lastPrice: 70_000
  });
  assert.ok(legacy.finalOrderNotionalUsdt <= 40);
  audit("X_NON_V2_LEGACY40", { final: legacy.finalOrderNotionalUsdt });
}

// Y — low available margin safely blocks V2
{
  const ethInst = { lotSz: 0.01, minSz: 0.01, ctVal: 0.1, ctValCcy: "ETH" };
  const lowBal = evaluateEquityAdaptiveSizing({
    symbol: "ETHUSDT",
    side: "long",
    orderKind: "ENTRY",
    accountEquityUsdt: 800,
    availableBalanceUsdt: 2,
    entryReferencePrice: 3_500,
    effectiveStopPrice: 3_450,
    appliedLeverage: 10,
    entryQualityGrade: "A",
    existingSymbolNotionalUsdt: 0,
    existingAccountNotionalUsdt: 800,
    emergencyAbsoluteCapUsdt: 500,
    legacyStaticCapUsdt: 40,
    v2AuthorityEntry: true,
    roundTripFeeRate: 0.001,
    lastPrice: 3_500,
    instrumentSizing: ethInst
  });
  assert.equal(lowBal.sizingPassed, false);
  assert.equal(lowBal.blockReason, "AVAILABLE_MARGIN_INSUFFICIENT");
  audit("Y_LOW_MARGIN_BLOCK", { block_reason: lowBal.blockReason });
}

// AA flat + stale bot algo blocks new entry
{
  const map = new Map<string, ReturnType<typeof createManualTakeoverRecord>>();
  const rec = createManualTakeoverRecord({ symbol: "BTCUSDT", side: "long", reason: "MANUAL_FULL_CLOSE" });
  map.set("BTCUSDT:long", rec);
  syncManualTakeoverLifecycleEntries(map, [], { "BTCUSDT:long": 1 });
  assert.equal(
    isManualTakeoverActiveForSymbol("BTCUSDT", "long", map, [], { engineOwnedOrderCount: 1 }),
    true
  );
  audit("AA_STALE_ALGO_BLOCKS_ENTRY", { active: true });
}

// AB stale cleared -> new BTC entry
{
  const map = new Map<string, ReturnType<typeof createManualTakeoverRecord>>();
  const rec = createManualTakeoverRecord({ symbol: "BTCUSDT", side: "long", reason: "MANUAL_FULL_CLOSE" });
  map.set("BTCUSDT:long", rec);
  syncManualTakeoverLifecycleEntries(map, [], { "BTCUSDT:long": 0 });
  assert.equal(
    isManualTakeoverActiveForSymbol("BTCUSDT", "long", map, [], { engineOwnedOrderCount: 0 }),
    false
  );
  audit("AB_CLEAN_CYCLE_BTC_ENTRY", { takeover_active: false });
}

// AC operator manual algo survives cleanup predicate
{
  const botOpen = openPos({
    symbol: "BTCUSDT",
    side: "long",
    lifecycleState: "BOT_V2_MANAGED",
    manualTakeoverActive: false,
    protectiveSlAlgoId: "bot-1"
  });
  assert.equal(isAuthoritativeBotOwnedAlgoOrder({ algoId: "bot-1" }, [botOpen]), true);
  assert.equal(isAuthoritativeBotOwnedAlgoOrder({ algoId: "op-manual", algoClOrdId: "manualSl123" }, [botOpen]), false);
  audit("AC_OPERATOR_ORDER_SURVIVES", { bot_owned: true, operator_owned: false });
}

// AD protective-only latch before calc
{
  const botOpen: PaperOpenPositionRecord = {
    ...openPos({
      symbol: "ETHUSDT",
      side: "long",
      lifecycleState: "BOT_V2_MANAGED",
      manualTakeoverActive: false,
      isV2Authority: true
    }),
    isProtectiveStopRegistered: true,
    protectiveSlAlgoId: "gone",
    protectiveVisibilityGraceDeadlineMs: 0
  };
  assert.equal(
    shouldLatchManualProtectiveOnlyIntervention({
      ledger: botOpen,
      reduceOnlyProtectiveFound: false,
      matchingProtectivePendingCount: 0,
      scanClean: true,
      nowMs: Date.now()
    }),
    true
  );
  audit("AD_PROTECTIVE_ONLY_LATCH", { latch: true });
}

// AE generic breakoutFailureRate alone cannot authorize HTF counter-trend
{
  const indexTs = readFileSync(join(__dirname, "../engine-v2/index.ts"), "utf8");
  const gateSlice = indexTs.slice(indexTs.indexOf("Strong HTF stack counter-trend"), indexTs.indexOf("Tier 5.5: Side-Zone Mismatch"));
  assert.ok(!gateSlice.includes("breakoutFailureRate"), "HTF gate must not use generic breakoutFailureRate");
  assert.ok(isHtfCounterTrendRangeBlocked({
    side: "short",
    zone: "upper",
    htf_1h_bias: "BULLISH",
    htf_4h_bias: "BULLISH",
    htf_1d_bias: "NEUTRAL",
    metadata: { breakoutFailureRate: 0.8 }
  }), "AE: high breakoutFailureRate alone blocks SHORT");
  audit("AE_GENERIC_BREAKOUT_FAIL_BLOCKS", { blocked: true });
}

// AF genuine directional reversal can authorize counter-trend
{
  assert.equal(isHtfCounterTrendRangeBlocked({
    side: "short",
    zone: "upper",
    htf_1h_bias: "BULLISH",
    htf_4h_bias: "BULLISH",
    htf_1d_bias: "NEUTRAL",
    reversalConfirmed: true
  }), false);
  assert.equal(isHtfCounterTrendRangeBlocked({
    side: "long",
    zone: "lower",
    htf_1h_bias: "BEARISH",
    htf_4h_bias: "BEARISH",
    htf_1d_bias: "NEUTRAL",
    metadata: { reclaim_confirmed: true }
  }), false);
  audit("AF_GENUINE_REVERSAL_ALLOWS", { short_with_reversal: false, long_with_reclaim: false });
}

// Ops-watch wiring proof for protective latch
{
  const paperEngine = readFileSync(join(__dirname, "./paper-engine.ts"), "utf8");
  assert.ok(paperEngine.includes("shouldLatchManualProtectiveOnlyIntervention"));
  assert.ok(paperEngine.includes("MANUAL_PROTECTIVE_CHANGE"));
  assert.ok(paperEngine.includes("resolveUltimateSafetyCapForOrderSizing"));
  audit("OPS_WATCH_AND_SUBMIT_WIRING", { protective_latch: true, v2_cap: true });
}

console.log("[LIVE-AUTH-AUDIT] ALL LOCAL PROOF CASES (W-AF) COMPLETED");
