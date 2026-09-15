/**
 * V2 live sizing authority restoration regression.
 *
 * Normal V2 risk-authoritative entries use equity-adaptive caps as sizing authority.
 * OKX_LIVE_EMERGENCY_MAX_ORDER_NOTIONAL_USDT binds only under explicit failsafe.
 */

import assert from "node:assert/strict";
import {
  evaluateEquityAdaptiveSizing,
  resolveUltimateSafetyCapForOrderSizing
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { normalizeOkxSwapContractsFromNotional } from "../engine-v2/okx-swap-sizing";
import { resolveLiveSubmitStaticSafetyCap } from "./paper-engine";

const EMERGENCY_MAX = 500;
const LEGACY_MAX = 40;
const EQUITY = 970;
const LEVERAGE = 10;
const ETH_PRICE = 3_500;
const ETH_STOP = 3_489; // ~0.31% stop → risk-based notional > equity initial cap at equity 970
const ETH_SIZING = { lotSz: 0.01, minSz: 0.01, ctVal: 0.1, ctValCcy: "ETH" };
const BTC_SIZING = { lotSz: 0.01, minSz: 0.01, ctVal: 0.01, ctValCcy: "BTC" };

function assertClose(actual: number, expected: number, tol = 1): void {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`expected ~${expected}, got ${actual}`);
  }
}

function pass(label: string, detail?: Record<string, unknown>): void {
  const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
  console.log(`[V2-SIZING-AUTHORITY][${label}] PASS${extra}`);
}

function baseV2Entry(overrides: Record<string, unknown> = {}) {
  return evaluateEquityAdaptiveSizing({
    symbol: "ETHUSDT",
    side: "long",
    orderKind: "ENTRY",
    accountEquityUsdt: EQUITY,
    availableBalanceUsdt: EQUITY,
    entryReferencePrice: ETH_PRICE,
    effectiveStopPrice: ETH_STOP,
    appliedLeverage: LEVERAGE,
    entryQualityGrade: "A",
    existingSymbolNotionalUsdt: 0,
    existingAccountNotionalUsdt: 0,
    emergencyAbsoluteCapUsdt: EMERGENCY_MAX,
    legacyStaticCapUsdt: LEGACY_MAX,
    v2AuthorityEntry: true,
    roundTripFeeRate: 0,
    lastPrice: ETH_PRICE,
    instrumentSizing: ETH_SIZING,
    ...overrides
  });
}

// CASE A — normal V2 full entry at equity 970
{
  const sizing = baseV2Entry();
  assert.equal(sizing.sizingPassed, true);
  assert.ok(sizing.riskBasedNotionalUsdt > 1_900, `riskBased=${sizing.riskBasedNotionalUsdt}`);
  assert.ok(sizing.finalOrderNotionalUsdt > EMERGENCY_MAX, `final=${sizing.finalOrderNotionalUsdt}`);
  assertClose(sizing.equityInitialCapUsdt, EQUITY * 2, 0.01);
  assert.equal(sizing.limitingAuthority, "equity_initial_cap");
  assert.equal(sizing.emergencyCapApplied, false);
  assert.equal(sizing.effectiveLiveCapUsdt, null);
  assert.equal(sizing.emergencyCapUsdt, EMERGENCY_MAX);
  pass("CASE_A_NORMAL_V2_FULL_ENTRY", {
    riskBasedNotionalUsdt: sizing.riskBasedNotionalUsdt,
    equityInitialCapUsdt: sizing.equityInitialCapUsdt,
    finalOrderNotionalUsdt: sizing.finalOrderNotionalUsdt,
    limitingAuthority: sizing.limitingAuthority
  });
}

// CASE B — risk-based below adaptive cap must not inflate
{
  const sizing = evaluateEquityAdaptiveSizing({
    symbol: "ETHUSDT",
    side: "long",
    orderKind: "ENTRY",
    accountEquityUsdt: 200,
    availableBalanceUsdt: 200,
    entryReferencePrice: ETH_PRICE,
    effectiveStopPrice: 3_465,
    appliedLeverage: LEVERAGE,
    entryQualityGrade: "A",
    existingSymbolNotionalUsdt: 0,
    existingAccountNotionalUsdt: 0,
    emergencyAbsoluteCapUsdt: EMERGENCY_MAX,
    legacyStaticCapUsdt: LEGACY_MAX,
    v2AuthorityEntry: true,
    roundTripFeeRate: 0,
    lastPrice: ETH_PRICE,
    instrumentSizing: ETH_SIZING
  });
  assert.equal(sizing.sizingPassed, true);
  assert.ok(sizing.riskBasedNotionalUsdt < 800, `riskBased=${sizing.riskBasedNotionalUsdt}`);
  assert.ok(sizing.finalOrderNotionalUsdt <= sizing.riskBasedNotionalUsdt + 1);
  assert.ok(sizing.finalOrderNotionalUsdt < sizing.equityInitialCapUsdt);
  pass("CASE_B_RISK_BELOW_ADAPTIVE_NO_INFLATION", {
    riskBasedNotionalUsdt: sizing.riskBasedNotionalUsdt,
    finalOrderNotionalUsdt: sizing.finalOrderNotionalUsdt
  });
}

// CASE C — HTF 0.5 multiplier
{
  const full = baseV2Entry();
  const htf = baseV2Entry({ htfSizeMultiplier: 0.5 });
  assert.equal(htf.sizingPassed, true);
  assertClose(htf.finalOrderNotionalUsdt, full.finalOrderNotionalUsdt * 0.5, full.finalOrderNotionalUsdt * 0.05);
  assert.equal(htf.htfSizeMultiplierApplied, 0.5);
  pass("CASE_C_HTF_HALF_MULTIPLIER", {
    full: full.finalOrderNotionalUsdt,
    htf: htf.finalOrderNotionalUsdt
  });
}

// CASE D — micro probe multiplier applied once
{
  const full = baseV2Entry();
  const probe = baseV2Entry({
    entryProbeSizeMultiplier: 0.25,
    entryProbeSizingSource: "DEFAULT_MICRO_PROBE"
  });
  assert.equal(probe.probeMultiplierApplied, 0.25);
  assertClose(probe.cappedFullEntryNotionalUsdt, full.cappedFullEntryNotionalUsdt, 1);
  assertClose(probe.finalOrderNotionalUsdt, full.finalOrderNotionalUsdt * 0.25, full.finalOrderNotionalUsdt * 0.05);
  pass("CASE_D_MICRO_PROBE_ONCE", {
    full: full.finalOrderNotionalUsdt,
    probe: probe.finalOrderNotionalUsdt,
    probeMultiplierApplied: probe.probeMultiplierApplied
  });
}

// CASE E — symbol/account cap as limiting authority
{
  const sizing = baseV2Entry({
    accountEquityUsdt: 500,
    availableBalanceUsdt: 500,
    existingSymbolNotionalUsdt: 1_250,
    existingAccountNotionalUsdt: 1_250
  });
  assert.equal(sizing.sizingPassed, false);
  assert.equal(sizing.blockReason, "MAX_SYMBOL_NOTIONAL_EXCEEDED");
  pass("CASE_E_SYMBOL_CAP_LIMITING", { blockReason: sizing.blockReason });
}

// CASE F — available balance capacity blocks when margin insufficient
{
  const sizing = baseV2Entry({
    availableBalanceUsdt: 10
  });
  assert.equal(sizing.sizingPassed, false);
  assert.equal(sizing.blockReason, "AVAILABLE_MARGIN_INSUFFICIENT");
  assert.equal(sizing.finalSizingAuthority, "available_balance_capacity");
  pass("CASE_F_AVAILABLE_BALANCE_CAPACITY", {
    blockReason: sizing.blockReason,
    availableBalanceCapUsdt: sizing.availableBalanceCapUsdt
  });
}

// CASE G — non-V2 legacy path still uses legacy 40 cap
{
  const legacy = evaluateEquityAdaptiveSizing({
    symbol: "BTCUSDT",
    side: "long",
    orderKind: "ENTRY",
    accountEquityUsdt: 600,
    availableBalanceUsdt: 600,
    entryReferencePrice: 100_000,
    effectiveStopPrice: 99_500,
    appliedLeverage: LEVERAGE,
    entryQualityGrade: "A",
    existingSymbolNotionalUsdt: 0,
    existingAccountNotionalUsdt: 0,
    emergencyAbsoluteCapUsdt: EMERGENCY_MAX,
    legacyStaticCapUsdt: LEGACY_MAX,
    roundTripFeeRate: 0,
    lastPrice: 100_000,
    instrumentSizing: BTC_SIZING
  });
  assert.ok(legacy.finalOrderNotionalUsdt <= LEGACY_MAX + 1e-9);
  assert.equal(legacy.effectiveLiveCapUsdt, LEGACY_MAX);
  pass("CASE_G_NON_V2_LEGACY_40", { finalOrderNotionalUsdt: legacy.finalOrderNotionalUsdt });
}

// CASE H — signed submit parity: V2 1900+ not re-cut to 500/40
{
  const sizing = baseV2Entry();
  const submit = resolveLiveSubmitStaticSafetyCap({
    authoritySource: "v2",
    okxLiveStaticNotionalCapEnabled: true,
    staticSafetyCapUsdt: LEGACY_MAX,
    intendedNotionalUsdt: sizing.finalOrderNotionalUsdt,
    emergencyUltimateCapUsdt: EMERGENCY_MAX,
    emergencyFailsafeActive: false
  });
  assert.equal(submit.skipStaticCapForV2Authority, true);
  assert.equal(submit.finalSubmittedNotionalUsdt, sizing.finalOrderNotionalUsdt);
  assert.equal(submit.finalSizeSource, "v2_risk");
  assert.equal(submit.emergencyCapApplied, false);
  pass("CASE_H_SIGNED_SUBMIT_PARITY", {
    engineFinal: sizing.finalOrderNotionalUsdt,
    submitFinal: submit.finalSubmittedNotionalUsdt
  });
}

// CASE I — emergency failsafe active vs normal V2 entry
{
  const normal = baseV2Entry();
  assert.equal(normal.emergencyCapApplied, false);

  const failsafe = baseV2Entry({
    accountEquityUsdt: 10_000,
    availableBalanceUsdt: 10_000,
    entryReferencePrice: 100_000,
    effectiveStopPrice: 99_900,
    lastPrice: 100_000,
    symbol: "BTCUSDT",
    instrumentSizing: BTC_SIZING,
    emergencyFailsafeActive: true
  });
  assert.equal(failsafe.sizingPassed, true);
  assert.ok(failsafe.finalOrderNotionalUsdt <= EMERGENCY_MAX + 1e-9);
  assert.equal(failsafe.emergencyCapApplied, true);
  assert.equal(failsafe.limitingAuthority, "emergency_failsafe_cap");

  const failsafeSubmit = resolveLiveSubmitStaticSafetyCap({
    authoritySource: "v2",
    okxLiveStaticNotionalCapEnabled: true,
    staticSafetyCapUsdt: null,
    intendedNotionalUsdt: 2_000,
    emergencyUltimateCapUsdt: EMERGENCY_MAX,
    emergencyFailsafeActive: true
  });
  assert.equal(failsafeSubmit.finalSubmittedNotionalUsdt, EMERGENCY_MAX);
  assert.equal(failsafeSubmit.finalSizeSource, "emergency_ultimate_cap");
  assert.equal(failsafeSubmit.emergencyCapApplied, true);
  pass("CASE_I_EMERGENCY_FAILSAFE_ONLY", {
    normalFinal: normal.finalOrderNotionalUsdt,
    failsafeFinal: failsafe.finalOrderNotionalUsdt,
    failsafeSubmit: failsafeSubmit.finalSubmittedNotionalUsdt
  });
}

// CASE J — BTC/ETH contract lot normalization parity
{
  const eth = baseV2Entry();
  const ethNorm = normalizeOkxSwapContractsFromNotional({
    desiredNotionalUsdt: eth.preLotNotionalUsdt,
    lastPrice: ETH_PRICE,
    sizing: ETH_SIZING
  });
  assertClose(eth.normalizedNotionalUsdt ?? 0, ethNorm.actualNotional, 0.01);
  assert.equal(eth.normalizedContracts, ethNorm.normalized_contracts);

  const btc = evaluateEquityAdaptiveSizing({
    symbol: "BTCUSDT",
    side: "long",
    orderKind: "ENTRY",
    accountEquityUsdt: EQUITY,
    availableBalanceUsdt: EQUITY,
    entryReferencePrice: 70_000,
    effectiveStopPrice: 69_500,
    appliedLeverage: LEVERAGE,
    entryQualityGrade: "A",
    existingSymbolNotionalUsdt: 0,
    existingAccountNotionalUsdt: 0,
    emergencyAbsoluteCapUsdt: EMERGENCY_MAX,
    legacyStaticCapUsdt: LEGACY_MAX,
    v2AuthorityEntry: true,
    roundTripFeeRate: 0,
    lastPrice: 70_000,
    instrumentSizing: BTC_SIZING
  });
  const btcNorm = normalizeOkxSwapContractsFromNotional({
    desiredNotionalUsdt: btc.preLotNotionalUsdt,
    lastPrice: 70_000,
    sizing: BTC_SIZING
  });
  assertClose(btc.normalizedNotionalUsdt ?? 0, btcNorm.actualNotional, 0.01);
  pass("CASE_J_LOT_NORMALIZATION_PARITY", {
    ethContracts: eth.normalizedContracts,
    ethNotional: eth.normalizedNotionalUsdt,
    btcContracts: btc.normalizedContracts,
    btcNotional: btc.normalizedNotionalUsdt
  });
}

// Resolver semantics — V2 normal has no binding effectiveLiveCap
{
  const cap = resolveUltimateSafetyCapForOrderSizing({
    v2AuthorityEntry: true,
    emergencyCapUsdt: EMERGENCY_MAX,
    legacyStaticCapUsdt: LEGACY_MAX
  });
  assert.equal(cap.effectiveLiveCapUsdt, null);
  assert.equal(cap.emergencyCapUsdt, EMERGENCY_MAX);
  pass("RESOLVER_V2_NO_DAILY_EMERGENCY_CEILING");
}

console.log("v2-live-sizing-authority-cases: ALL PASS");
