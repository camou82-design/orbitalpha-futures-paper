/**
 * POST-ENTRY SAFETY AUTHORITY REGRESSION SUITE
 *
 * Defect A: canonical SL truth cannot be contradicted downstream
 * Defect B: 51068 role preservation SL/TP/OCO
 * Defect C: same-contract mark-price notional drift + margin unit correctness
 */

import type { PaperOpenPositionRecord } from "../models/types";
import {
  evaluatePositionProtectionState,
  evaluateOpsWatchProtectiveScanVerdict,
  resolveLedgerCanonicalProtectiveTruth,
  PROTECTIVE_VISIBILITY_GRACE_MS
} from "../engine-v2/execution/protective-order-state";
import { findProtectiveHintsForInst } from "./position-ops-monitor";
import {
  planProtectiveOrderReconcile,
  type ProtectiveReconcileContext,
  type ProtectiveAlgoRow
} from "../engine-v2/execution/protective-reconcile-plan";
import {
  resolve51068ProtectiveLookup,
  inferProtective51068RequestedRole
} from "../engine-v2/execution/protective-inventory";
import {
  evaluateV2NotionalReconcile,
  detectV2MarginComparedAsNotionalBug,
  resolveLedgerMarginUsd
} from "../engine-v2/live-account/reconcile-margin-authority";

function run(label: string, passed: boolean, detail: string): void {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[POST-ENTRY-SAFETY][${label}] ${tag} — ${detail}`);
  if (!passed) throw new Error(`[POST-ENTRY-SAFETY][${label}] FAILED: ${detail}`);
}

function baseLedger(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    openedAt: Date.now(),
    symbol: "ETHUSDT",
    side: "long",
    entryPrice: 2350,
    leverage: 10,
    sizeUsd: 304,
    notionalUsd: 304,
    okxContracts: 1.29,
    stopPrice: 2332.25,
    targetPrice1: 2400,
    lifecycleState: "BOT_V2_MANAGED",
    reconcileState: "MATCHED",
    isV2Authority: true,
    isProtectiveStopRegistered: true,
    isTakeProfitRegistered: false,
    isProtectionFailed: false,
    protectiveSlAlgoId: "3851186061411471361",
    protectiveStopAlgoId: "3851186061411471361",
    ...overrides
  } as PaperOpenPositionRecord;
}

const reconcileCtx: ProtectiveReconcileContext = {
  instId: "ETH-USDT-SWAP",
  positionSide: "long",
  openedAt36: "abc123",
  tdModeUsed: "cross",
  contractsToProtect: 1.29,
  activeStopPrice: 2332.25,
  activeTpPrice: null,
  wantsTp: false,
  expectedSide: "sell",
  tickSz: 0.01
};

const NOW = Date.now();

function canonicalExchangeSlAlgo(): Record<string, unknown> {
  return {
    algoId: "3851186061411471361",
    instId: "ETH-USDT-SWAP",
    posSide: "long",
    side: "sell",
    reduceOnly: true,
    ordType: "conditional",
    sz: "1.29",
    slTriggerPx: "2332.25",
    state: "live"
  };
}

// =========================================================================
// DEFECT A — exchange truth authority hierarchy
// =========================================================================
{
  const ledger = baseLedger();
  const canonicalAlgo = canonicalExchangeSlAlgo();

  // A7: current authoritative inventory repairs weak pre-scan miss
  const truthA7 = resolveLedgerCanonicalProtectiveTruth({
    ledger,
    pending: [],
    algos: [canonicalAlgo],
    tpRequired: false,
    requiredStopPx: 2332.25,
    tickSz: 0.01,
    instId: "ETH-USDT-SWAP",
    positionSide: "long"
  });
  run(
    "TEST_A7_CURRENT_EXCHANGE_INVENTORY_REPAIRS_WEAK_PRESCAN",
    truthA7.source === "exchange_confirmed" &&
      truthA7.authoritative === true &&
      truthA7.canonicalProtectiveSlFound === true &&
      truthA7.exchangeStopPx === 2332.25,
    `source=${truthA7.source}, authoritative=${truthA7.authoritative}, stop=${truthA7.exchangeStopPx}`
  );

  const hintsA7 = findProtectiveHintsForInst("ETH-USDT-SWAP", "long", [], [canonicalAlgo], false, {
    ledger,
    requiredStopPx: 2332.25,
    tickSz: 0.01
  });
  run(
    "TEST_A7_HINTS_PROTECTED_FROM_CURRENT_EXCHANGE_ROW",
    hintsA7.protectionSatisfied === true && hintsA7.slPrice === 2332.25,
    `satisfied=${hintsA7.protectionSatisfied}, sl=${hintsA7.slPrice}`
  );

  // A4: grace expired + inventory absent => NOT authoritative
  const ledgerStale = baseLedger({
    protectiveVisibilityGraceDeadlineMs: NOW - 1000
  });
  const truthA4 = resolveLedgerCanonicalProtectiveTruth({
    ledger: ledgerStale,
    pending: [],
    algos: [],
    tpRequired: false,
    requiredStopPx: 2332.25,
    tickSz: 0.01,
    instId: "ETH-USDT-SWAP",
    positionSide: "long",
    nowMs: NOW
  });
  const protectionA4 = evaluatePositionProtectionState({
    instId: "ETH-USDT-SWAP",
    positionSide: "long",
    pending: [],
    algos: [],
    tpRequired: false,
    ledger: ledgerStale,
    tickSz: 0.01,
    requiredStopPx: 2332.25
  });
  const opsA4 = evaluateOpsWatchProtectiveScanVerdict({
    nowMs: NOW,
    ledger: ledgerStale,
    reduceOnlyProtectiveFound: false,
    matchingProtectivePendingCount: 0,
    scanClean: true,
    tpRequired: false
  });
  run(
    "TEST_A4_GRACE_EXPIRED_ABSENT_NOT_AUTHORITATIVE",
    truthA4.source === "not_confirmed" &&
      !truthA4.authoritative &&
      !truthA4.canonicalProtectiveSlFound &&
      !protectionA4.reduceOnlyProtectiveFound &&
      opsA4.verdict === "HARD_BLOCK",
    `source=${truthA4.source}, canonical=${truthA4.canonicalProtectiveSlFound}, ops=${opsA4.verdict}`
  );

  // A5: explicit exchange ABSENT overrides stale ledger
  const truthA5 = resolveLedgerCanonicalProtectiveTruth({
    ledger: ledgerStale,
    pending: [],
    algos: [],
    tpRequired: false,
    requiredStopPx: 2332.25,
    tickSz: 0.01,
    instId: "ETH-USDT-SWAP",
    positionSide: "long",
    nowMs: NOW,
    exchangeAbsentConfirmed: true
  });
  run(
    "TEST_A5_EXCHANGE_ABSENT_OVERRIDES_STALE_LEDGER",
    truthA5.source === "not_confirmed" &&
      !truthA5.authoritative &&
      truthA5.exchangeStopPx == null,
    `source=${truthA5.source}, stop=${truthA5.exchangeStopPx}`
  );

  // A6: inside visibility grace => pending, not exchange-confirmed, ops DEFER
  const graceDeadline = NOW + PROTECTIVE_VISIBILITY_GRACE_MS / 2;
  const ledgerGrace = baseLedger({
    protectiveVisibilityGraceDeadlineMs: graceDeadline
  });
  const truthA6 = resolveLedgerCanonicalProtectiveTruth({
    ledger: ledgerGrace,
    pending: [],
    algos: [],
    tpRequired: false,
    nowMs: NOW
  });
  const hintsA6 = findProtectiveHintsForInst("ETH-USDT-SWAP", "long", [], [], false, {
    ledger: ledgerGrace,
    requiredStopPx: 2332.25,
    tickSz: 0.01
  });
  const opsA6 = evaluateOpsWatchProtectiveScanVerdict({
    nowMs: NOW,
    ledger: ledgerGrace,
    reduceOnlyProtectiveFound: hintsA6.protectionSatisfied,
    matchingProtectivePendingCount: 0,
    scanClean: true,
    tpRequired: false
  });
  run(
    "TEST_A6_INSIDE_VISIBILITY_GRACE_DEFER_NOT_EXCHANGE_CONFIRMED",
    truthA6.source === "visibility_grace_pending" &&
      !truthA6.authoritative &&
      !truthA6.canonicalProtectiveSlFound &&
      hintsA6.protectionSatisfied === false &&
      opsA6.verdict === "DEFER" &&
      opsA6.opsWatchVisibilityGraceApplied === true,
    `source=${truthA6.source}, hints=${hintsA6.protectionSatisfied}, ops=${opsA6.verdict}, grace=${opsA6.opsWatchVisibilityGraceApplied}`
  );
}

// =========================================================================
// DEFECT B — 51068 role preservation
// =========================================================================
{
  const slOnlyRow: ProtectiveAlgoRow = {
    algoId: "sl_only_1",
    algoClOrdId: "slETHentry001",
    instId: "ETH-USDT-SWAP",
    posSide: "long",
    side: "sell",
    tdMode: "cross",
    reduceOnly: true,
    ordType: "conditional",
    sz: "1.29",
    slTriggerPx: "2332.25",
    state: "live"
  };
  const slResolution = resolve51068ProtectiveLookup(slOnlyRow, reconcileCtx, "slETHentry001", "sl");
  run(
    "TEST_B1_51068_SL_ONLY_ADOPTS_SL_ROLE",
    slResolution.action === "adopt" &&
      slResolution.action === "adopt" &&
      slResolution.slLegValid === true &&
      slResolution.tpLegValid === false,
    `SL-only adopt slLegValid=${slResolution.action === "adopt" ? slResolution.slLegValid : false}`
  );
  const slAsTp = resolve51068ProtectiveLookup(slOnlyRow, reconcileCtx, "tpETHentry001", "tp");
  run(
    "TEST_B2_51068_SL_ONLY_CANNOT_SATISFY_TP",
    slAsTp.action === "blocked_existing_unresolved",
    `SL-only row blocked for TP role. action=${slAsTp.action}`
  );

  const tpOnlyRow: ProtectiveAlgoRow = {
    algoId: "tp_only_1",
    algoClOrdId: "tpETHentry001",
    instId: "ETH-USDT-SWAP",
    posSide: "long",
    side: "sell",
    tdMode: "cross",
    reduceOnly: true,
    ordType: "conditional",
    sz: "1.29",
    tpTriggerPx: "2400",
    state: "live"
  };
  const tpCtx: ProtectiveReconcileContext = { ...reconcileCtx, wantsTp: true, activeTpPrice: 2400 };
  const tpResolution = resolve51068ProtectiveLookup(tpOnlyRow, tpCtx, "tpETHentry001", "tp");
  run(
    "TEST_B3_51068_TP_ONLY_ADOPTS_TP_ROLE",
    tpResolution.action === "adopt" && tpResolution.tpLegValid === true && tpResolution.slLegValid === false,
    `TP-only adopt tpLegValid=${tpResolution.action === "adopt" ? tpResolution.tpLegValid : false}`
  );
  const tpAsSl = resolve51068ProtectiveLookup(tpOnlyRow, tpCtx, "slETHentry001", "sl");
  run(
    "TEST_B4_51068_TP_ONLY_CANNOT_SATISFY_SL",
    tpAsSl.action === "blocked_existing_unresolved",
    `TP-only row blocked for SL role. action=${tpAsSl.action}`
  );

  const ocoRow: ProtectiveAlgoRow = {
    algoId: "oco_both_1",
    algoClOrdId: "slETHentry002",
    instId: "ETH-USDT-SWAP",
    posSide: "long",
    side: "sell",
    tdMode: "cross",
    reduceOnly: true,
    ordType: "oco",
    sz: "1.29",
    slTriggerPx: "2332.25",
    tpTriggerPx: "2400",
    state: "live"
  };
  const ocoCtx: ProtectiveReconcileContext = { ...reconcileCtx, wantsTp: true, activeTpPrice: 2400 };
  const ocoResolution = resolve51068ProtectiveLookup(ocoRow, ocoCtx, "slETHentry002", "sl");
  run(
    "TEST_B5_51068_OCO_ADOPTS_BOTH_LEGS",
    ocoResolution.action === "adopt" &&
      ocoResolution.ocoBothValid === true &&
      ocoResolution.slLegValid === true &&
      ocoResolution.tpLegValid === true,
    `OCO both legs valid. ocoBoth=${ocoResolution.action === "adopt" ? ocoResolution.ocoBothValid : false}`
  );

  const planSl = planProtectiveOrderReconcile([slOnlyRow], reconcileCtx);
  run(
    "TEST_B6_PLAN_SL_ONLY_COVERS_SL_NOT_TP",
    planSl.canonicalSl != null && planSl.canonicalTp == null,
    `plan canonicalSl=${planSl.canonicalSl?.algoId}, canonicalTp=${planSl.canonicalTp?.algoId ?? "null"}`
  );

  run(
    "TEST_B7_INFER_ROLE_FROM_CLORDID",
    inferProtective51068RequestedRole("slETHentry001") === "sl" &&
      inferProtective51068RequestedRole("tpETHentry001") === "tp",
    "clOrdId role inference"
  );

  const tpOnlyLegacyCl = "sl_pETHUSDTlegacy99";
  const tpOnlyMisleading = resolve51068ProtectiveLookup(
    tpOnlyRow,
    tpCtx,
    tpOnlyLegacyCl,
    inferProtective51068RequestedRole(tpOnlyLegacyCl)
  );
  run(
    "TEST_B8_SL_LOOKING_LEGACY_CLORDID_TP_ONLY_ROW_NO_SL_ADOPTION",
    tpOnlyMisleading.action === "blocked_existing_unresolved",
    `misleading SL clOrdId on TP-only row blocked. action=${tpOnlyMisleading.action}`
  );

  const slOnlyLegacyCl = "tp_pETHUSDTlegacy99";
  const slOnlyMisleading = resolve51068ProtectiveLookup(
    slOnlyRow,
    reconcileCtx,
    slOnlyLegacyCl,
    inferProtective51068RequestedRole(slOnlyLegacyCl)
  );
  run(
    "TEST_B9_TP_LOOKING_LEGACY_CLORDID_SL_ONLY_ROW_NO_TP_ADOPTION",
    slOnlyMisleading.action === "blocked_existing_unresolved",
    `misleading TP clOrdId on SL-only row blocked. action=${slOnlyMisleading.action}`
  );
}

// =========================================================================
// DEFECT C — margin / notional reconcile
// =========================================================================
{
  const open = baseLedger({ sizeUsd: 304, notionalUsd: 304, okxContracts: 1.29, leverage: 10 });
  const remote = {
    contracts: 1.29,
    notionalUsd: 306,
    marginUsd: 30.6,
    leverage: 10,
    avgPx: 2372
  };

  const v2 = evaluateV2NotionalReconcile({ open, remote });
  run(
    "TEST_C1_SAME_CONTRACTS_NOTIONAL_DRIFT_ALIGNED",
    v2.contractsAligned === true &&
      v2.marginAligned === true &&
      v2.notionalDriftOnly === true &&
      v2.mismatchType === "MATCHED",
    `contracts=${v2.contractsAligned}, margin=${v2.marginAligned}, drift=${v2.notionalDriftOnly}, type=${v2.mismatchType}`
  );

  const ledgerMargin = resolveLedgerMarginUsd(open);
  run(
    "TEST_C2_LEDGER_MARGIN_DERIVED_FROM_NOTIONAL",
    Math.abs(ledgerMargin - 30.4) < 0.2,
    `ledger margin=${ledgerMargin} (expected ~30.4)`
  );

  run(
    "TEST_C3_MARGIN_TOLERANCE_ALIGNED",
    Math.abs(ledgerMargin - remote.marginUsd) <= 0.65,
    `margin delta=${Math.abs(ledgerMargin - remote.marginUsd)}`
  );

  run(
    "TEST_C4_V2_MARGIN_NOTIONAL_BUG_DETECTED",
    detectV2MarginComparedAsNotionalBug(open, remote) === true,
    "sizeUsd-as-margin comparison bug exposed when comparing 304 vs 30.6 margin"
  );

  const contractMismatch = evaluateV2NotionalReconcile({
    open: { ...open, okxContracts: 1.0 },
    remote: { ...remote, contracts: 1.29 }
  });
  run(
    "TEST_C5_GENUINE_CONTRACT_MISMATCH_FAIL_CLOSED",
    contractMismatch.mismatchType === "CONTRACT_MISMATCH",
    `contract mismatch type=${contractMismatch.mismatchType}`
  );
}

console.log("\nALL POST-ENTRY SAFETY AUTHORITY TESTS PASSED");
