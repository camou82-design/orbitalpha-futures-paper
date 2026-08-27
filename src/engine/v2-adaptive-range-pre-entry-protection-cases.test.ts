/**
 * Adaptive low-volatility RANGE pre-entry SL/TP regressions.
 */

import assert from "node:assert/strict";
import {
  buildV2PreEntryRiskPlanCommitted,
  type V2PreEntryRiskPlanAdaptiveContext
} from "./paper-engine";
import type { EntryExecutionAuthority } from "../engine-v2/types";
import { evaluatePreEntryProtectionPlan } from "../engine-v2/execution/pre-entry-protection-plan";
import { normalizePxToTickSz } from "../engine-v2/execution/entry-order-type";
import {
  computeAdaptiveRangePreEntryProtection,
  shouldApplyAdaptiveRangePreEntryProtection,
  type AdaptiveRangeProtectionDiagnostics
} from "../engine-v2/execution/adaptive-range-pre-entry-protection";
import {
  buildV2NewEntryAttachAlgoOrds,
  isV2RangePartialPlanContext,
  resolvePartialExitRatio
} from "../engine-v2/execution/entry-protection-attach";
import { engineMirrorStopPrice, engineMirrorTpPrice } from "./position-ops-monitor";

function pass(label: string, detail?: Record<string, unknown>): void {
  const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
  console.log(`[ADAPTIVE-RANGE-PROTECTION][${label}] PASS${extra}`);
}

const noopLogger = {
  info: () => {},
  warn: () => {}
};

const ETH_PRODUCTION = {
  entry: 2459.56,
  atr: 1.37994,
  boxHigh: 2460.76,
  boxLow: 2452.6,
  boxMid: 2456.68,
  tickSz: 0.01,
  rawStructuralSl: 2461.4499702540543,
  legacyPolicySl: 2465.954856,
  legacyPolicyTp: 2453.4111000000003
};

function makeRangeAuthority(input: {
  side: "long" | "short";
  invalidationPx: number;
  takeProfit1Px?: number;
  marketSubtype?: string;
  regime?: string;
  routingEngine?: string;
}): EntryExecutionAuthority {
  return {
    decision: "ENTER",
    side: input.side,
    stageMarginKrw: 100000,
    regime: input.regime ?? "RANGE",
    source: "v2",
    invalidationPx: input.invalidationPx,
    stopPrice: input.invalidationPx,
    takeProfit1Px: input.takeProfit1Px,
    marketSubtype: input.marketSubtype ?? "FAST_TREND_SHIFT",
    rangeBoxHighAtEntry: ETH_PRODUCTION.boxHigh,
    rangeBoxLowAtEntry: ETH_PRODUCTION.boxLow,
    rangeBoxMidAtEntry: ETH_PRODUCTION.boxMid
  };
}

function adaptiveContext(overrides: Partial<V2PreEntryRiskPlanAdaptiveContext> = {}): V2PreEntryRiskPlanAdaptiveContext {
  return {
    atr: ETH_PRODUCTION.atr,
    boxHigh: ETH_PRODUCTION.boxHigh,
    boxLow: ETH_PRODUCTION.boxLow,
    boxMid: ETH_PRODUCTION.boxMid,
    marketSubtype: "FAST_TREND_SHIFT",
    routingEngine: "RANGE",
    feeRate: 0.0005,
    ...overrides
  };
}

function atrMultiple(entry: number, px: number, atr: number): number {
  return Math.abs(entry - px) / atr;
}

/** Mirrors `buildV2PreEntryRiskPlanCommitted` RANGE gate: reject only when RR is null or <= 0. */
const RANGE_PRE_ENTRY_RR_MIN_EXCLUSIVE = 0;

function committedRrProof(
  plan: {
    risk_distance: number;
    initial_tp_price: number | null;
    risk_reward_ratio: number | null;
  },
  entryPx: number
): Readonly<{
  risk_distance: number;
  reward_distance: number | null;
  reward_risk_ratio: number | null;
  rr_min_required: number;
  rr_passed: boolean;
}> {
  const reward_distance =
    plan.initial_tp_price != null ? Math.abs(plan.initial_tp_price - entryPx) : null;
  const rr_passed =
    plan.risk_reward_ratio != null && plan.risk_reward_ratio > RANGE_PRE_ENTRY_RR_MIN_EXCLUSIVE;
  return {
    risk_distance: plan.risk_distance,
    reward_distance,
    reward_risk_ratio: plan.risk_reward_ratio,
    rr_min_required: RANGE_PRE_ENTRY_RR_MIN_EXCLUSIVE,
    rr_passed
  };
}

function assertRrPassed(
  label: string,
  proof: ReturnType<typeof committedRrProof>,
  extra?: Record<string, unknown>
): void {
  assert.equal(proof.rr_passed, true, `${label}: RR must pass pre-entry gate (> ${proof.rr_min_required})`);
  pass(label, { ...proof, ...extra });
}

function legacyMirrorRr(entry: number, side: "long" | "short"): number {
  const sl = engineMirrorStopPrice(entry, side, "RANGE")!;
  const tp = engineMirrorTpPrice(entry, side, "RANGE")!;
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  return reward / risk;
}

function adaptiveProofFields(
  plan: { stop_price: number; initial_tp_price: number | null; risk_reward_ratio: number | null },
  diag: AdaptiveRangeProtectionDiagnostics | null | undefined,
  entry: number,
  atr: number,
  partialCtx: ReturnType<typeof buildPartialAttachProof>
) {
  return {
    structural_stop_price: diag?.structural_stop_price ?? null,
    structural_stop_distance_atr: diag?.structural_stop_distance_atr ?? null,
    atr_min_stop_distance: diag?.atr_min_stop_distance ?? null,
    percentage_floor_distance: diag?.percentage_floor_distance ?? null,
    percentage_floor_applied: diag?.percentage_floor_applied ?? false,
    final_stop_price: plan.stop_price,
    final_stop_distance_atr: atrMultiple(entry, plan.stop_price, atr),
    final_tp_distance_atr:
      plan.initial_tp_price != null ? atrMultiple(entry, plan.initial_tp_price, atr) : null,
    reward_risk_ratio: plan.risk_reward_ratio,
    range_partial_plan: partialCtx.range_partial_plan,
    entry_full_position_tp_attached: partialCtx.entryFullPositionTpAttached,
    lifecycle_partial_tp_authority: partialCtx.lifecyclePartialTpAuthority
  };
}

function buildPartialAttachProof(input: {
  side: "long" | "short";
  stopPrice: number;
  takeProfitPrice: number;
  partialPlan: boolean;
  clOrdId?: string;
  submitSz?: string;
}) {
  const isPartial = input.partialPlan;
  const attach = buildV2NewEntryAttachAlgoOrds({
    clOrdId: input.clOrdId ?? "test-cl-ord",
    submitSzStr: input.submitSz ?? "10",
    stopPrice: input.stopPrice,
    takeProfitPrice: input.takeProfitPrice,
    isV2RangePartialPlan: isPartial
  });
  const first = attach.attachAlgoOrds[0] as Record<string, unknown> | undefined;
  return {
    ...attach,
    range_partial_plan: isPartial,
    hasTpTrigger: first != null && "tpTriggerPx" in first
  };
}

// CASE A — low-vol RANGE upper-zone SHORT (ETH production-like)
{
  const authority = makeRangeAuthority({
    side: "short",
    invalidationPx: ETH_PRODUCTION.rawStructuralSl,
    takeProfit1Px: ETH_PRODUCTION.legacyPolicyTp
  });
  const rp = buildV2PreEntryRiskPlanCommitted(
    authority,
    {},
    "short",
    ETH_PRODUCTION.entry,
    noopLogger,
    "ETHUSDT",
    adaptiveContext()
  );
  assert.equal(rp.ok, true);
  if (!rp.ok) throw new Error("expected ok plan");

  const plan = rp.plan;
  const preEntry = evaluatePreEntryProtectionPlan({
    symbol: "ETHUSDT",
    side: "short",
    entryReferencePrice: ETH_PRODUCTION.entry,
    slPrice: plan.stop_price,
    tpPrice: plan.initial_tp_price,
    isV2Authority: true,
    regime: "RANGE",
    tickSz: ETH_PRODUCTION.tickSz
  });

  const legacyTpAtr = atrMultiple(ETH_PRODUCTION.entry, ETH_PRODUCTION.legacyPolicyTp, ETH_PRODUCTION.atr);
  const adaptiveTpAtr = atrMultiple(ETH_PRODUCTION.entry, plan.initial_tp_price!, ETH_PRODUCTION.atr);
  const adaptiveSlAtr = atrMultiple(ETH_PRODUCTION.entry, plan.stop_price, ETH_PRODUCTION.atr);
  const legacyRr = legacyMirrorRr(ETH_PRODUCTION.entry, "short");

  assert.equal(preEntry.protectionPlanReady, true);
  assert.equal(preEntry.entryBlocked, false);
  assert.equal(rp.adaptiveDiagnostics?.adaptive_range_protection_applied, true);
  assert.equal(rp.adaptiveDiagnostics?.percentage_floor_applied, false);
  assert.ok(adaptiveTpAtr < legacyTpAtr - 1.0, "TP must be materially closer than legacy ~4.4 ATR");
  assert.ok(adaptiveTpAtr <= 2.05, "TP should be capped near ~2.0 ATR");
  assert.equal(plan.stop_price, ETH_PRODUCTION.legacyPolicySl, "SL must preserve canonical policy stop (non-tightening invariant)");
  assert.equal(plan.stop_source, "policy_clamped");
  assert.ok(preEntry.slPrice! > ETH_PRODUCTION.entry);
  assert.ok(preEntry.tpPrice! < ETH_PRODUCTION.entry);
  assert.equal(preEntry.tickRounded, true);

  const rr = committedRrProof(plan, ETH_PRODUCTION.entry);
  assert.ok(rr.reward_risk_ratio != null && rr.reward_risk_ratio > RANGE_PRE_ENTRY_RR_MIN_EXCLUSIVE, "RR must be positive");
  assert.equal(rr.risk_distance, Math.abs(ETH_PRODUCTION.entry - plan.stop_price));
  assert.equal(rr.reward_distance, Math.abs(ETH_PRODUCTION.entry - plan.initial_tp_price!));

  const partialAttach = buildPartialAttachProof({
    side: "short",
    stopPrice: preEntry.slPrice!,
    takeProfitPrice: preEntry.tpPrice!,
    partialPlan: false
  });

  assertRrPassed("CASE_A_ETH_SHORT_UPPER_ZONE", rr, {
    legacyRr,
    legacyTpAtr,
    adaptiveTpAtr,
    adaptiveSl: plan.stop_price,
    tickSl: preEntry.slPrice,
    tickTp: preEntry.tpPrice,
    slSource: plan.stop_source,
    tpSource: plan.take_profit_source,
    ...adaptiveProofFields(plan, rp.adaptiveDiagnostics, ETH_PRODUCTION.entry, ETH_PRODUCTION.atr, partialAttach)
  });
}

// CASE B — low-vol RANGE lower-zone LONG mirror
{
  const entry = 2453.2;
  const boxLow = 2452.6;
  const boxHigh = 2460.76;
  const boxMid = (boxHigh + boxLow) / 2;
  const atr = ETH_PRODUCTION.atr;
  const rawStructuralSl = boxLow - 0.5;
  const legacyTp = engineMirrorTpPrice(entry, "long", "RANGE")!;
  const authority: EntryExecutionAuthority = {
    ...makeRangeAuthority({
      side: "long",
      invalidationPx: rawStructuralSl,
      takeProfit1Px: legacyTp,
      marketSubtype: "RANGE_LOWER_REACTION"
    }),
    rangeBoxHighAtEntry: boxHigh,
    rangeBoxLowAtEntry: boxLow,
    rangeBoxMidAtEntry: boxMid
  };

  const rp = buildV2PreEntryRiskPlanCommitted(
    authority,
    {},
    "long",
    entry,
    noopLogger,
    "ETHUSDT",
    adaptiveContext({ atr, boxHigh, boxLow, boxMid, marketSubtype: "RANGE_LOWER_REACTION" })
  );
  assert.equal(rp.ok, true);
  if (!rp.ok) throw new Error("expected ok plan");

  const preEntry = evaluatePreEntryProtectionPlan({
    symbol: "ETHUSDT",
    side: "long",
    entryReferencePrice: entry,
    slPrice: rp.plan.stop_price,
    tpPrice: rp.plan.initial_tp_price,
    isV2Authority: true,
    regime: "RANGE",
    tickSz: ETH_PRODUCTION.tickSz
  });

  const legacyTpAtr = atrMultiple(entry, legacyTp, atr);
  const adaptiveTpAtr = atrMultiple(entry, rp.plan.initial_tp_price!, atr);

  assert.equal(rp.adaptiveDiagnostics?.adaptive_range_protection_applied, true);
  assert.ok(adaptiveTpAtr < legacyTpAtr);
  assert.ok(preEntry.slPrice! < entry);
  assert.ok(preEntry.tpPrice! > entry);
  assert.equal(preEntry.protectionPlanReady, true);

  const rr = committedRrProof(rp.plan, entry);
  assertRrPassed("CASE_B_ETH_LONG_LOWER_ZONE_MIRROR", rr, {
    legacyTpAtr,
    adaptiveTpAtr,
    tickSl: preEntry.slPrice,
    tickTp: preEntry.tpPrice
  });
}

// CASE C — confirmed breakout LONG preserves wider breakout target
{
  const entry = 100;
  const breakoutTp = 103.5;
  const inv = 99.2;
  const authority: EntryExecutionAuthority = {
    ...makeRangeAuthority({
      side: "long",
      invalidationPx: inv,
      takeProfit1Px: breakoutTp,
      marketSubtype: "BREAKOUT_RETEST_CONFIRMED",
      regime: "RANGE"
    }),
    rangeBoxHighAtEntry: 102,
    rangeBoxLowAtEntry: 98,
    rangeBoxMidAtEntry: 100
  };

  const rp = buildV2PreEntryRiskPlanCommitted(
    authority,
    {},
    "long",
    entry,
    noopLogger,
    "BTCUSDT",
    adaptiveContext({
      atr: 0.5,
      boxHigh: 102,
      boxLow: 98,
      boxMid: 100,
      marketSubtype: "BREAKOUT_RETEST_CONFIRMED",
      confirmedBreakout: true
    })
  );

  assert.equal(rp.ok, true);
  if (!rp.ok) throw new Error("expected ok plan");
  assert.equal(rp.adaptiveDiagnostics, null);
  assert.equal(rp.plan.initial_tp_price, breakoutTp);
  assert.equal(shouldApplyAdaptiveRangePreEntryProtection({
    regime: "RANGE",
    marketSubtype: "BREAKOUT_RETEST_CONFIRMED"
  }), false);

  const rr = committedRrProof(rp.plan, entry);
  assertRrPassed("CASE_C_CONFIRMED_BREAKOUT_LONG_PRESERVED", rr, {
    tp: rp.plan.initial_tp_price,
    adaptive_applied: false
  });
}

// CASE D — true TREND entry preserves existing TP/SL semantics
{
  const entry = 100;
  const trendTp = 105;
  const trendSl = 98.5;
  const authority = makeRangeAuthority({
    side: "long",
    invalidationPx: trendSl,
    takeProfit1Px: trendTp,
    regime: "TREND"
  });

  const rp = buildV2PreEntryRiskPlanCommitted(
    authority,
    {},
    "long",
    entry,
    noopLogger,
    "BTCUSDT",
    adaptiveContext({ routingEngine: "TREND" })
  );

  assert.equal(rp.ok, true);
  if (!rp.ok) throw new Error("expected ok plan");
  assert.equal(rp.adaptiveDiagnostics, null);
  assert.equal(rp.plan.initial_tp_price, trendTp);
  assert.equal(rp.plan.stop_price, trendSl);

  const rr = committedRrProof(rp.plan, entry);
  assert.equal(rr.rr_passed, true, "TREND plan has no RANGE RR gate (regime !== RANGE at validation)");
  pass("CASE_D_TREND_PRESERVED", {
    ...rr,
    sl: rp.plan.stop_price,
    tp: rp.plan.initial_tp_price,
    note: "buildV2PreEntryRiskPlanCommitted RANGE RR gate skipped for TREND regime"
  });
}

// CASE E — tick normalization collapse fail-closed after adaptive-sized plan
{
  const entry = 2459.5;
  const preEntry = evaluatePreEntryProtectionPlan({
    symbol: "ETHUSDT",
    side: "long",
    entryReferencePrice: entry,
    slPrice: 2459.5042,
    tpPrice: 2464.44934,
    isV2Authority: true,
    regime: "RANGE",
    tickSz: 0.01
  });

  assert.equal(preEntry.slPrice, 2459.5);
  assert.equal(preEntry.entryBlocked, true);
  assert.equal(preEntry.blockReason, "PRE_ENTRY_SL_TP_DIRECTION_INVALID");

  pass("CASE_E_TICK_COLLAPSE_FAIL_CLOSED", {
    rr_audit_applicable: false,
    blockReason: preEntry.blockReason,
    note: "no committed risk plan — tick collapse blocks at evaluatePreEntryProtectionPlan"
  });
}

// CASE F — min-profit / ATR cap infeasible: ultra-close TP must not be manufactured
{
  const entry = 100;
  const result = computeAdaptiveRangePreEntryProtection({
    side: "long",
    entryPx: entry,
    rawStructuralSl: 99.5,
    rawPolicySl: 99.5,
    rawPolicyTp: 100.25,
    atr: 0.001,
    boxHigh: 100.05,
    boxLow: 99.95,
    boxMid: 100.0001
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fail-closed");
  assert.equal(result.blockReason, "ADAPTIVE_RANGE_TP_PLAN_INFEASIBLE");

  pass("CASE_F_MIN_PROFIT_INFEASIBLE_FAIL_CLOSED", {
    rr_audit_applicable: false,
    blockReason: result.blockReason,
    rr_passed: false,
    note: "adaptive plan fail-closed before committed RR is computed"
  });
}

// Submit handoff: proof committed values match tick-normalized submit prices
{
  const authority = makeRangeAuthority({
    side: "short",
    invalidationPx: ETH_PRODUCTION.rawStructuralSl,
    takeProfit1Px: ETH_PRODUCTION.legacyPolicyTp
  });
  const rp = buildV2PreEntryRiskPlanCommitted(
    authority,
    {},
    "short",
    ETH_PRODUCTION.entry,
    noopLogger,
    "ETHUSDT",
    adaptiveContext()
  );
  assert.equal(rp.ok, true);
  if (!rp.ok) throw new Error("expected ok plan");

  const preEntry = evaluatePreEntryProtectionPlan({
    symbol: "ETHUSDT",
    side: "short",
    entryReferencePrice: ETH_PRODUCTION.entry,
    slPrice: rp.plan.stop_price,
    tpPrice: rp.plan.initial_tp_price,
    isV2Authority: true,
    regime: "RANGE",
    tickSz: ETH_PRODUCTION.tickSz
  });

  const submitStop = preEntry.slPrice;
  const submitTp = preEntry.tpPrice;
  assert.equal(submitStop, normalizePxToTickSz(rp.plan.stop_price, ETH_PRODUCTION.tickSz));
  assert.equal(submitTp, normalizePxToTickSz(rp.plan.initial_tp_price!, ETH_PRODUCTION.tickSz));
  assert.equal(rp.adaptiveDiagnostics?.final_committed_sl_price, rp.plan.stop_price);
  assert.equal(rp.adaptiveDiagnostics?.final_committed_tp_price, rp.plan.initial_tp_price);

  const rr = committedRrProof(rp.plan, ETH_PRODUCTION.entry);
  assertRrPassed("SUBMIT_HANDOFF_MATCHES_PROOF", rr, {
    submitStop,
    submitTp,
    rawPolicySl: ETH_PRODUCTION.legacyPolicySl,
    rawPolicyTp: ETH_PRODUCTION.legacyPolicyTp,
    adaptiveSl: rp.plan.stop_price,
    adaptiveTp: rp.plan.initial_tp_price
  });
}

// CASE G — V2 RANGE partial plan: entry attach is SL-only (no full-position TP race window)
{
  const tp1 = 2456.8;
  const authority: EntryExecutionAuthority = {
    ...makeRangeAuthority({
      side: "short",
      invalidationPx: ETH_PRODUCTION.rawStructuralSl,
      takeProfit1Px: tp1
    }),
    takeProfitPlan: { partialRatio: 0.5, tp1, tp2: ETH_PRODUCTION.boxMid },
    partialExitRatio: 0.5
  };
  const isPartial = isV2RangePartialPlanContext({
    isV2Authority: true,
    regime: "RANGE",
    takeProfitPlan: authority.takeProfitPlan,
    takeProfit1Px: authority.takeProfit1Px,
    partialExitRatio: authority.partialExitRatio
  });
  assert.equal(isPartial, true);
  assert.equal(resolvePartialExitRatio(authority), 0.5);

  const rp = buildV2PreEntryRiskPlanCommitted(
    authority,
    {},
    "short",
    ETH_PRODUCTION.entry,
    noopLogger,
    "ETHUSDT",
    adaptiveContext()
  );
  assert.equal(rp.ok, true);
  if (!rp.ok) throw new Error("expected ok plan");

  const preEntry = evaluatePreEntryProtectionPlan({
    symbol: "ETHUSDT",
    side: "short",
    entryReferencePrice: ETH_PRODUCTION.entry,
    slPrice: rp.plan.stop_price,
    tpPrice: rp.plan.initial_tp_price,
    isV2Authority: true,
    regime: "RANGE",
    isV2RangePartialPlan: true,
    tickSz: ETH_PRODUCTION.tickSz
  });
  assert.equal(preEntry.tpRequired, false);
  assert.equal(preEntry.protectionPlanReady, true);

  const attach = buildPartialAttachProof({
    side: "short",
    stopPrice: preEntry.slPrice!,
    takeProfitPrice: preEntry.tpPrice!,
    partialPlan: true
  });
  assert.equal(attach.attachOrdType, "conditional");
  assert.equal(attach.entryFullPositionTpAttached, false);
  assert.equal(attach.lifecyclePartialTpAuthority, true);
  assert.equal(attach.hasTpTrigger, false);
  assert.equal(attach.attachAlgoOrds.length, 1);

  pass("CASE_G_PARTIAL_TP_ENTRY_ATTACH_SL_ONLY", {
    range_partial_plan: true,
    entry_full_position_tp_attached: false,
    lifecycle_partial_tp_authority: true,
    lifecycle_tp1_ratio: 0.5,
    attach_ord_type: attach.attachOrdType,
    note: "no full-position TP from fill through post-fill reconcile"
  });
}

// CASE H — non-partial RANGE preserves full-position OCO TP at entry attach
{
  const attach = buildPartialAttachProof({
    side: "short",
    stopPrice: 2464.45,
    takeProfitPrice: 2456.8,
    partialPlan: false
  });
  assert.equal(attach.attachOrdType, "oco");
  assert.equal(attach.entryFullPositionTpAttached, true);
  assert.equal(attach.lifecyclePartialTpAuthority, false);
  assert.equal(attach.hasTpTrigger, true);

  pass("CASE_H_NON_PARTIAL_RANGE_FULL_TP_PRESERVED", {
    range_partial_plan: false,
    entry_full_position_tp_attached: true,
    attach_ord_type: attach.attachOrdType
  });
}

// CASE I — lifecycle partial TP authority: TP1 uses 50% contract ratio semantics
{
  const ratio = resolvePartialExitRatio({
    isV2Authority: true,
    regime: "RANGE",
    takeProfitPlan: { partialRatio: 0.5 },
    takeProfit1Px: 2456.8,
    partialExitRatio: 0.5
  });
  assert.equal(ratio, 0.5);
  const okxContracts = 20;
  const tp1DeltaContracts = okxContracts * ratio!;
  assert.equal(tp1DeltaContracts, 10);

  pass("CASE_I_LIFECYCLE_TP1_50_PERCENT", {
    lifecycle_partial_tp_authority: true,
    partial_exit_ratio: ratio,
    okx_contracts: okxContracts,
    tp1_delta_contracts: tp1DeltaContracts
  });
}

console.log("v2-adaptive-range-pre-entry-protection-cases: ALL PASS");
