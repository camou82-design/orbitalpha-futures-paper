/**
 * Pre-entry SL/TP tick normalization regressions (ETH tickSz=0.01).
 */

import assert from "node:assert/strict";
import { evaluatePreEntryProtectionPlan } from "../engine-v2/execution/pre-entry-protection-plan";
import { normalizePxToTickSz } from "../engine-v2/execution/entry-order-type";

function pass(label: string, detail?: Record<string, unknown>): void {
  const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
  console.log(`[PRE-ENTRY-TICK][${label}] PASS${extra}`);
}

function isTickCompliant(px: number, tickSz: number): boolean {
  const normalized = normalizePxToTickSz(px, tickSz);
  return Math.abs(px - normalized) <= tickSz * 0.001;
}

function simulateLiveSubmitHandoff(input: {
  rawSl: number;
  rawTp: number | null;
  side: "long" | "short";
  entryReferencePrice: number;
  tickSz: number;
}): {
  plan: ReturnType<typeof evaluatePreEntryProtectionPlan>;
  submitStopPrice: number | null;
  submitTakeProfitPrice: number | null | undefined;
  submitAllowed: boolean;
} {
  const plan = evaluatePreEntryProtectionPlan({
    symbol: "ETHUSDT",
    side: input.side,
    entryReferencePrice: input.entryReferencePrice,
    slPrice: input.rawSl,
    tpPrice: input.rawTp,
    isV2Authority: true,
    regime: "RANGE",
    tickSz: input.tickSz
  });
  const submitStopPrice = plan.slPrice;
  const submitTakeProfitPrice = plan.tpPrice;
  const submitAllowed =
    !plan.entryBlocked &&
    submitStopPrice != null &&
    isTickCompliant(submitStopPrice, input.tickSz) &&
    (submitTakeProfitPrice == null || isTickCompliant(submitTakeProfitPrice, input.tickSz));
  return { plan, submitStopPrice, submitTakeProfitPrice, submitAllowed };
}

// ETH production-like SHORT: raw prices off tick grid
{
  const tickSz = 0.01;
  const entryReferencePrice = 2459.5;
  const rawSl = 2465.954856;
  const rawTp = 2453.4111000000003;
  const { plan, submitStopPrice, submitTakeProfitPrice, submitAllowed } = simulateLiveSubmitHandoff({
    rawSl,
    rawTp,
    side: "short",
    entryReferencePrice,
    tickSz
  });

  assert.equal(plan.entryBlocked, false, "ETH short must pass after normalization");
  assert.equal(plan.blockReason, null);
  assert.equal(plan.tickRounded, true);
  assert.equal(submitStopPrice, 2465.95);
  assert.equal(submitTakeProfitPrice, 2453.41);
  assert.equal(submitAllowed, true);
  assert.ok(submitStopPrice! > entryReferencePrice);
  assert.ok(submitTakeProfitPrice! < entryReferencePrice);
  pass("ETH_SHORT_OFF_TICK_SURVIVES_SUBMIT_HANDOFF", {
    rawSl,
    rawTp,
    submitStopPrice,
    submitTakeProfitPrice
  });
}

// ETH LONG mirror fixture
{
  const tickSz = 0.01;
  const entryReferencePrice = 2459.5;
  const rawSl = 2453.4111000000003;
  const rawTp = 2465.954856;
  const { plan, submitStopPrice, submitTakeProfitPrice, submitAllowed } = simulateLiveSubmitHandoff({
    rawSl,
    rawTp,
    side: "long",
    entryReferencePrice,
    tickSz
  });

  assert.equal(plan.entryBlocked, false);
  assert.equal(plan.tickRounded, true);
  assert.equal(submitStopPrice, 2453.41);
  assert.equal(submitTakeProfitPrice, 2465.95);
  assert.equal(submitAllowed, true);
  assert.ok(submitStopPrice! < entryReferencePrice);
  assert.ok(submitTakeProfitPrice! > entryReferencePrice);
  pass("ETH_LONG_OFF_TICK_SURVIVES_SUBMIT_HANDOFF", {
    rawSl,
    rawTp,
    submitStopPrice,
    submitTakeProfitPrice
  });
}

// Fail-closed: normalization collapses SL onto entry for LONG
{
  const tickSz = 0.01;
  const entryReferencePrice = 2459.5;
  const plan = evaluatePreEntryProtectionPlan({
    symbol: "ETHUSDT",
    side: "long",
    entryReferencePrice,
    slPrice: 2459.5042,
    tpPrice: 2465.954856,
    isV2Authority: true,
    regime: "RANGE",
    tickSz
  });
  assert.equal(plan.slPrice, 2459.5);
  assert.equal(plan.entryBlocked, true);
  assert.equal(plan.blockReason, "PRE_ENTRY_SL_TP_DIRECTION_INVALID");
  pass("ETH_LONG_COLLAPSED_SL_STILL_FAIL_CLOSED", {
    normalizedSl: plan.slPrice,
    entryReferencePrice
  });
}

// Fail-closed: un-normalizable / non-positive remains blocked
{
  const plan = evaluatePreEntryProtectionPlan({
    symbol: "ETHUSDT",
    side: "long",
    entryReferencePrice: 2459.5,
    slPrice: 0,
    tpPrice: 2465.954856,
    isV2Authority: true,
    regime: "RANGE",
    tickSz: 0.01
  });
  assert.equal(plan.entryBlocked, true);
  assert.equal(plan.blockReason, "PRE_ENTRY_SL_PRICE_MISSING");
  pass("ETH_INVALID_SL_STILL_BLOCKED");
}

console.log("v2-pre-entry-sl-tp-tick-normalization-cases: ALL PASS");
