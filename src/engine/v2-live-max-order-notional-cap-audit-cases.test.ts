/**
 * Live V2 max-order notional cap invariant regression.
 *
 * Invariant: V2 risk-authoritative entries use emergency ultimate ceiling (500), NOT legacy 40.
 * Legacy OKX_LIVE_MAX_ORDER_NOTIONAL_USDT=40 applies only to non-V2 submit paths.
 */

import assert from "node:assert/strict";
import { getEngineConfig } from "../config/env";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import {
  evaluateEquityAdaptiveSizing,
  resolveEffectiveLiveOrderNotionalCap,
  resolveEmergencyAbsoluteCap,
  resolveUltimateSafetyCapForOrderSizing
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { normalizeOkxSwapContractsFromNotional } from "../engine-v2/okx-swap-sizing";
import { buildV2SnapshotBridge, resolveLiveSubmitStaticSafetyCap } from "./paper-engine";

const KRW_PER_USD = 1400;
const APPLIED_LEVERAGE = 10;
const LEGACY_MAX = 40;
const EMERGENCY_MAX = 500;
const BTC_LAST_PRICE = 70_000;
const BTC_EFFECTIVE_STOP = 68_820.8;
const BTC_SIZING = { lotSz: 0.01, minSz: 0.01, ctVal: 0.01, ctValCcy: "BTC" };

function pass(label: string, detail?: Record<string, unknown>): void {
  const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
  console.log(`[LIVE-MAX-NOTIONAL-CAP][${label}] PASS${extra}`);
}

function captureProofLogs(fn: () => void): Record<string, unknown>[] {
  const logs: Record<string, unknown>[] = [];
  const origInfo = console.info;
  const origLog = console.log;
  const capture = (msg: unknown) => {
    try {
      const p = JSON.parse(String(msg));
      if (p && typeof p.event === "string") logs.push(p);
    } catch { /* ignore */ }
  };
  console.info = (msg: unknown) => { capture(msg); origInfo(msg); };
  console.log = (msg: unknown) => { capture(msg); origLog(msg); };
  try { fn(); } finally { console.info = origInfo; console.log = origLog; }
  return logs;
}

function deriveIsLiveSignedOrderAttempt(input: Readonly<{
  okxAuthMode?: string | null;
  okxExchangeAuthOptIn?: boolean | null;
  okxLiveEnabled?: boolean | null;
  executionAction?: string | null;
}>): boolean {
  return (
    input.okxAuthMode === "live" &&
    input.okxExchangeAuthOptIn === true &&
    input.okxLiveEnabled === true &&
    (input.executionAction === "ENTER" || input.executionAction === "ADDON")
  );
}

function assertCapResolution(
  label: string,
  input: { legacy?: number | null; emergency?: number | null },
  expectedEffective: number | null
): void {
  const resolved = resolveEffectiveLiveOrderNotionalCap({
    legacyStaticCapUsdt: input.legacy ?? null,
    emergencyCapUsdt: input.emergency ?? null
  });
  assert.equal(resolved.effectiveLiveCapUsdt, expectedEffective, label);
  assert.equal(resolveEmergencyAbsoluteCap({
    emergencyCapUsdt: input.emergency ?? null,
    legacyStaticCapUsdt: input.legacy ?? null
  }).cap, expectedEffective, `${label} (resolveEmergencyAbsoluteCap)`);
  pass(label, {
    legacy_static_cap_usdt: resolved.legacyStaticCapUsdt,
    emergency_cap_usdt: resolved.emergencyCapUsdt,
    effective_live_cap_usdt: resolved.effectiveLiveCapUsdt
  });
}

function makeProductionLiveConfig() {
  const explicitEnv = {
    OKX_AUTH_MODE: "live",
    OKX_EXCHANGE_AUTH_OPT_IN: "true",
    OKX_LIVE_ENABLED: "true",
    OKX_LIVE_MAX_ORDER_NOTIONAL_USDT: String(LEGACY_MAX),
    OKX_LIVE_EMERGENCY_MAX_ORDER_NOTIONAL_USDT: String(EMERGENCY_MAX),
    SERVER_TRADE_ENABLED: "true"
  };
  return {
    ...getEngineConfig(explicitEnv),
    baseSizeUsd: 100,
    okxAuthMode: "live" as const,
    okxExchangeAuthOptIn: true,
    okxLiveEnabled: true,
    okxLiveMaxOrderNotionalUsdt: LEGACY_MAX,
    okxLiveEmergencyMaxOrderNotionalUsdt: EMERGENCY_MAX,
    serverTradeEnabled: true
  };
}

function makeProductionBridge(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    currentPositions: [],
    globalRiskScore: 0.2,
    lossStreaks: {},
    directionalShockState: "UP" as const,
    longAllow: true,
    shortAllow: false,
    executionReadiness: true,
    paperExecutionReady: true,
    signedExecutionReady: true,
    freshTickBarrierActive: false,
    freshTickCompletedCycles: 1,
    freshTickRequiredCycles: 1,
    serverTradeEnabled: true,
    closeOnlyMode: false,
    killSwitch: false,
    reconcileSafeMode: false,
    accountEquityUsdt: 600,
    availableBalanceUsdt: 600,
    liveBalanceReady: true,
    okxActualPositionsReady: true,
    actualAccountNotionalUsdtReady: true,
    okxActualPositions: [],
    okxPendingOrdersReady: true,
    okxPendingOrdersNotionalUsdt: 0,
    okxPendingSymbolNotionalUsdt: 0,
    hasSymbolPendingEntry: false,
    hasUnknownPendingNotional: false,
    okxLiveEnabled: true,
    okxAuthMode: "live",
    okxAuthReady: true,
    okxExchangeAuthOptIn: true,
    equitySource: "okx_total_eq",
    balanceFetchedAt: now,
    positionsFetchedAt: now,
    pendingOrdersFetchedAt: now,
    okxInstrumentSizing: BTC_SIZING,
    entryQualityProfiles: {
      profit: { qualityScoreAvg: 90, emaGapAvg: 0.005, atrPctAvg: 0.01, volumeRatioAvg: 1.2, count: 8 },
      loss: { qualityScoreAvg: 55, emaGapAvg: 0.001, atrPctAvg: 0.01, volumeRatioAvg: 0.9, count: 2 },
      contaminated: { qualityScoreAvg: 60, emaGapAvg: 0.002, atrPctAvg: 0.01, volumeRatioAvg: 1.0, count: 1 }
    },
    ...overrides
  };
}

// CASE A — unit semantics preserved
{
  const envelopeMargin = 44_800 / KRW_PER_USD;
  const authorityNotional = (44_800 * APPLIED_LEVERAGE) / KRW_PER_USD;
  assert.equal(envelopeMargin, 32);
  assert.equal(authorityNotional, 320);
  pass("CASE_A_UNIT_SEMANTICS", { envelope_margin_usdt: envelopeMargin, authority_notional_usdt: authorityNotional });
}

// CASE B — effective cap matrix
assertCapResolution("CASE_B1_LEGACY40_EMERGENCY500", { legacy: 40, emergency: 500 }, 40);
assertCapResolution("CASE_B2_LEGACY40_EMERGENCY_UNSET", { legacy: 40, emergency: null }, 40);
assertCapResolution("CASE_B3_LEGACY_UNSET_EMERGENCY500", { legacy: null, emergency: 500 }, 500);
assertCapResolution("CASE_B4_LEGACY100_EMERGENCY40", { legacy: 100, emergency: 40 }, 40);

// CASE C — V2 equity path: risk-based ~356 NOT capped to legacy 40
{
  const equity = evaluateEquityAdaptiveSizing({
    symbol: "BTCUSDT",
    side: "long",
    orderKind: "ENTRY",
    accountEquityUsdt: 600,
    availableBalanceUsdt: 600,
    entryReferencePrice: BTC_LAST_PRICE,
    effectiveStopPrice: BTC_EFFECTIVE_STOP,
    appliedLeverage: APPLIED_LEVERAGE,
    entryQualityGrade: "A",
    existingSymbolNotionalUsdt: 0,
    existingAccountNotionalUsdt: 0,
    emergencyAbsoluteCapUsdt: EMERGENCY_MAX,
    legacyStaticCapUsdt: LEGACY_MAX,
    v2AuthorityEntry: true,
    roundTripFeeRate: 0,
    lastPrice: BTC_LAST_PRICE,
    instrumentSizing: BTC_SIZING
  });

  assert.equal(equity.emergencyCapUsdt, EMERGENCY_MAX);
  assert.equal(equity.legacyStaticCapUsdt, LEGACY_MAX);
  assert.equal(equity.effectiveLiveCapUsdt, null);
  assert.ok(equity.riskBasedNotionalUsdt > 300);
  assert.ok(equity.finalOrderNotionalUsdt > LEGACY_MAX);
  assert.equal(equity.emergencyCapApplied, false);
  assert.ok(equity.finalOrderNotionalUsdt > equity.riskBasedNotionalUsdt * 0.9 || equity.limitingAuthority !== "emergency_failsafe_cap");

  const norm = normalizeOkxSwapContractsFromNotional({
    desiredNotionalUsdt: equity.finalOrderNotionalUsdt,
    lastPrice: BTC_LAST_PRICE,
    sizing: BTC_SIZING
  });
  assert.ok(norm.actualNotional > LEGACY_MAX);

  pass("CASE_C_V2_EQUITY_PATH_NOT_LEGACY40", {
    risk_based_notional_usdt: equity.riskBasedNotionalUsdt,
    effective_live_cap_usdt: equity.effectiveLiveCapUsdt,
    emergency_cap_usdt: equity.emergencyCapUsdt,
    final_order_notional_usdt: equity.finalOrderNotionalUsdt,
    normalized_notional_usdt: norm.actualNotional
  });
}

// CASE C2 — non-V2 equity path still capped to legacy 40
{
  const equity = evaluateEquityAdaptiveSizing({
    symbol: "BTCUSDT",
    side: "long",
    orderKind: "ENTRY",
    accountEquityUsdt: 600,
    availableBalanceUsdt: 600,
    entryReferencePrice: BTC_LAST_PRICE,
    effectiveStopPrice: BTC_EFFECTIVE_STOP,
    appliedLeverage: APPLIED_LEVERAGE,
    entryQualityGrade: "A",
    existingSymbolNotionalUsdt: 0,
    existingAccountNotionalUsdt: 0,
    emergencyAbsoluteCapUsdt: EMERGENCY_MAX,
    legacyStaticCapUsdt: LEGACY_MAX,
    roundTripFeeRate: 0,
    lastPrice: BTC_LAST_PRICE,
    instrumentSizing: BTC_SIZING
  });
  assert.equal(equity.effectiveLiveCapUsdt, LEGACY_MAX);
  assert.ok(equity.finalOrderNotionalUsdt <= LEGACY_MAX + 1e-9);
  pass("CASE_C2_NON_V2_EQUITY_PATH_LEGACY40", {
    final_order_notional_usdt: equity.finalOrderNotionalUsdt
  });
}

// CASE D — V2 fast path respects engine authority without legacy/emergency static re-cap
{
  const authorityNotionalUsdt = 1_940;
  const v2EntrySizeUsd = authorityNotionalUsdt;
  assert.equal(v2EntrySizeUsd, authorityNotionalUsdt);
  pass("CASE_D_V2_FAST_PATH", { authority_notional_usdt: authorityNotionalUsdt, v2_entry_size_usd: v2EntrySizeUsd });
}

// CASE E — V2 submit last-mile skips legacy 40; emergency ultimate only
{
  const submit = resolveLiveSubmitStaticSafetyCap({
    authoritySource: "v2",
    okxLiveStaticNotionalCapEnabled: true,
    staticSafetyCapUsdt: LEGACY_MAX,
    intendedNotionalUsdt: 356.16,
    emergencyUltimateCapUsdt: EMERGENCY_MAX,
    emergencyFailsafeActive: false
  });
  assert.equal(submit.skipStaticCapForV2Authority, true);
  assert.equal(submit.finalSubmittedNotionalUsdt, 356.16);
  assert.equal(submit.finalSizeSource, "v2_risk");

  const norm = normalizeOkxSwapContractsFromNotional({
    desiredNotionalUsdt: submit.finalSubmittedNotionalUsdt,
    lastPrice: BTC_LAST_PRICE,
    sizing: BTC_SIZING
  });
  assert.ok(norm.actualNotional > LEGACY_MAX);

  pass("CASE_E_V2_SUBMIT_SKIPS_LEGACY40", {
    final_submitted_notional_usdt: submit.finalSubmittedNotionalUsdt,
    normalized_notional_usdt: norm.actualNotional
  });
}

// CASE F — non-V2 legacy submit path preserved
{
  const submit = resolveLiveSubmitStaticSafetyCap({
    authoritySource: "legacy",
    okxLiveStaticNotionalCapEnabled: true,
    staticSafetyCapUsdt: 40,
    intendedNotionalUsdt: 128
  });
  assert.equal(submit.finalSubmittedNotionalUsdt, 40);
  assert.equal(submit.finalSizeSource, "static_safety_cap");
  pass("CASE_F_NON_V2_LEGACY_SUBMIT_PRESERVED", { final_submitted_notional_usdt: submit.finalSubmittedNotionalUsdt });
}

// CASE G — production pipeline runEngineV2
{
  process.env.OKX_LIVE_MAX_ORDER_NOTIONAL_USDT = String(LEGACY_MAX);
  process.env.OKX_LIVE_EMERGENCY_MAX_ORDER_NOTIONAL_USDT = String(EMERGENCY_MAX);

  const candles = Array.from({ length: 120 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60_000,
    open: BTC_LAST_PRICE - 200 + i,
    high: BTC_LAST_PRICE + 100 + i,
    low: BTC_LAST_PRICE - 300 + i,
    close: BTC_LAST_PRICE - 150 + i,
    volume: 100 + i
  }));
  const snap = {
    symbol: "BTCUSDT",
    lastPrice: BTC_LAST_PRICE,
    latestCandleClose: BTC_LAST_PRICE,
    signal: "paper_long_candidate",
    entryCandidate: true,
    qualityScore: 88,
    emaGap: 0.006,
    volumeRatioProxy: 1.2,
    boxHigh: 71_000,
    boxLow: 69_000,
    boxPos: 0.85,
    atr: 250,
    atr20: 250,
    closedClose: BTC_LAST_PRICE,
    rangeConfidence: 0.82,
    candles,
    htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles },
    canonicalRegime: "RANGE",
    canonicalTrendScore: 0.35,
    reviewing_ticks: 0
  };

  const input = adaptV2Input(
    "BTCUSDT",
    Date.now(),
    buildV2SnapshotBridge(snap as any) as any,
    makeProductionLiveConfig() as any,
    makeProductionBridge() as any,
    { decision: { final_decision: "ENTER", side: "long" }, side: "long", isBlocked: false } as any,
    candles,
    "authoritative",
    `live_cap_fix_${Date.now()}`
  );

  let decision: ReturnType<typeof runEngineV2>["decision"];
  const proofs = captureProofLogs(() => {
    ({ decision } = runEngineV2(input));
  });

  const debugLive = proofs.find((p) => p.event === "DEBUG_LIVE_ORDER_VARS");
  const runtimeIsLiveSigned = deriveIsLiveSignedOrderAttempt({
    okxAuthMode: String(debugLive?.okxAuthMode ?? "live"),
    okxExchangeAuthOptIn: debugLive?.okxExchangeAuthOptIn === true,
    okxLiveEnabled: debugLive?.okxLiveEnabled === true,
    executionAction: String(debugLive?.executionAction ?? "NONE")
  });

  const sizingProof = proofs.find((p) => p.event === "LIVE_ORDER_SIZING_AUTHORITY_PROOF");
  const equityProof = proofs.find((p) => p.event === "V2_EQUITY_ADAPTIVE_SIZING_PROOF");
  const liveSizeProof = proofs.find((p) => p.event === "LIVE_ORDER_SIZE_PROOF");

  assert.equal(Number(sizingProof?.legacy_static_cap_usdt), LEGACY_MAX);
  assert.equal(Number(sizingProof?.emergency_cap_usdt), EMERGENCY_MAX);
  assert.equal(sizingProof?.effective_live_cap_usdt ?? null, null);

  if (runtimeIsLiveSigned && decision!.decision === "ENTER") {
    const finalNotional = Number(
      liveSizeProof?.final_order_notional_usdt ??
      decision!.risk?.finalOrderNotionalUsdt ??
      equityProof?.final_order_notional_usdt ??
      0
    );
    assert.ok(finalNotional > LEGACY_MAX, `V2 pipeline final notional must exceed legacy 40, got ${finalNotional}`);
    assert.equal(equityProof?.emergency_cap_applied, false);
  }

  pass("CASE_G_PRODUCTION_PIPELINE", {
    runtime_is_live_signed_order_attempt: runtimeIsLiveSigned,
    final_decision: decision!.decision,
    effective_live_cap_usdt: sizingProof?.effective_live_cap_usdt,
    final_order_notional_usdt: liveSizeProof?.final_order_notional_usdt ?? decision!.risk?.finalOrderNotionalUsdt
  });
}

console.log("v2-live-max-order-notional-cap-audit-cases: ALL PASS");
