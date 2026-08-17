/**
 * BLOCKER 4-10 — V2 Protective Order Exchange-Authority / Phantom Protection Fix Tests
 *
 * Tests:
 * CASE A: Structural fallback SL/TP only, actual OKX pending = []
 *         -> canonicalSl = null, canonicalTp = null, submitOco = true
 * CASE B: Real OKX SL + TP exist with valid algoId, matching price & size
 *         -> canonicalSl != null, canonicalTp != null, submitOco = false, action = KEEP
 * CASE C: Real SL exists, TP required but missing
 *         -> canonicalSl != null, canonicalTp = null, needSubmitTp = true, submitOco = false
 * CASE D: algoId=null synthetic candidate only
 *         -> NEVER promoted to canonical protection
 * CASE E: Wrong size / wrong side / wrong price real orders
 *         -> NOT recognized as canonical protection
 * CASE F: Submit success immediate visibility grace
 *         -> PROTECTION_PENDING_VISIBILITY, no duplicate submission, NOT false PROTECTION_PRESENT
 * CASE G: Authoritative empty exchange protection inventory
 *         -> reduceOnlyProtectiveFound = false, consistencyCheck = FAIL, protection MISSING (requires repair)
 * CASE H: BTC RANGE position (entry=62830.1, SL=62666.74174, TP=63068.85438, contracts=0.17, actual pending=[])
 *         -> repair plan requires SL/TP submission (submitOco = true)
 */

import {
  planProtectiveOrderReconcile,
  evaluateProtectiveAlgoMatch,
  type ProtectiveReconcileContext,
  type ProtectiveAlgoRow
} from "../engine-v2/execution/protective-reconcile-plan";
import {
  buildEntryAttachProtectiveCandidates,
  mergeProtectiveInventoryRows
} from "../engine-v2/execution/protective-inventory";
import {
  evaluateOpsWatchProtectiveScanVerdict,
  evaluatePositionProtectionState
} from "../engine-v2/execution/protective-order-state";
import type { PaperOpenPositionRecord } from "../models/types";

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  if (!value) throw new Error(`[FAIL] ${label}: expected true`);
}

function assertFalse(value: boolean, label: string): void {
  if (value) throw new Error(`[FAIL] ${label}: expected false`);
}

function pass(label: string, detail?: string): void {
  console.info(`[BLOCKER-4-10][${label}] PASS${detail ? ` — ${detail}` : ""}`);
}

function createCtx(opts: {
  instId: string;
  positionSide: "long" | "short";
  contracts: number;
  slPx: number;
  tpPx: number | null;
  wantsTp: boolean;
}): ProtectiveReconcileContext {
  return {
    instId: opts.instId,
    positionSide: opts.positionSide,
    openedAt36: "msplnw3gs",
    tdModeUsed: "cross",
    contractsToProtect: opts.contracts,
    activeStopPrice: opts.slPx,
    activeTpPrice: opts.tpPx,
    wantsTp: opts.wantsTp,
    expectedSide: opts.positionSide === "long" ? "sell" : "buy",
    tickSz: 0.1
  };
}

function runBlocker410Cases(): void {
  console.info("=== STARTING BLOCKER 4-10 PROTECTIVE EXCHANGE AUTHORITY TESTS ===");

  // -------------------------------------------------------------------------
  // CASE A: Structural fallback SL/TP only (no algoId), actual OKX pending = []
  // -------------------------------------------------------------------------
  {
    const instId = "BTC-USDT-SWAP";
    const ctx = createCtx({
      instId,
      positionSide: "long",
      contracts: 0.17,
      slPx: 62666.7,
      tpPx: 63068.8,
      wantsTp: true
    });

    const attachCandidate = buildEntryAttachProtectiveCandidates({
      instId,
      positionSide: "long",
      tdModeUsed: "cross",
      expectedSide: "sell",
      contracts: 0.17,
      activeStopPrice: 62666.7,
      activeTpPrice: 63068.8,
      wantsTp: true,
      entryClOrdId: "pBTCentry001"
    });

    const inventory = mergeProtectiveInventoryRows([], attachCandidate);
    const plan = planProtectiveOrderReconcile(inventory, ctx);

    assertEq(plan.canonicalSl, null, "CASE A canonicalSl must be null");
    assertEq(plan.canonicalTp, null, "CASE A canonicalTp must be null");
    assertTrue(plan.submitOco, "CASE A submitOco must be true");
    pass("CASE A - Structural fallback without algoId requires submit", "submitOco=true, canonicalSl=null");
  }

  // -------------------------------------------------------------------------
  // CASE B: Real OKX SL + TP exist with valid algoId, matching price & size
  // -------------------------------------------------------------------------
  {
    const instId = "BTC-USDT-SWAP";
    const ctx = createCtx({
      instId,
      positionSide: "long",
      contracts: 0.17,
      slPx: 62666.7,
      tpPx: 63068.8,
      wantsTp: true
    });

    const realOcoOrder: ProtectiveAlgoRow = {
      instId,
      posSide: "long",
      side: "sell",
      reduceOnly: true,
      tdMode: "cross",
      ordType: "oco",
      sz: 0.17,
      slTriggerPx: "62666.7",
      tpTriggerPx: "63068.8",
      algoId: "okx_algo_oco_9988",
      algoClOrdId: "slpBTCentry001",
      state: "live"
    };

    const plan = planProtectiveOrderReconcile([realOcoOrder], ctx);
    assertTrue(plan.canonicalSl !== null, "CASE B canonicalSl must exist");
    assertTrue(plan.canonicalTp !== null, "CASE B canonicalTp must exist");
    assertFalse(plan.submitOco, "CASE B submitOco must be false");
    assertFalse(plan.needSubmitSl, "CASE B needSubmitSl must be false");
    assertFalse(plan.needSubmitTp, "CASE B needSubmitTp must be false");
    assertEq(plan.cancelAlgoIds.length, 0, "CASE B cancelAlgoIds must be empty");
    pass("CASE B - Real OKX SL+TP with algoId confirmed", "canonicalSl & canonicalTp present, submitOco=false");
  }

  // -------------------------------------------------------------------------
  // CASE C: Real SL exists, TP required but missing
  // -------------------------------------------------------------------------
  {
    const instId = "ETH-USDT-SWAP";
    const ctx = createCtx({
      instId,
      positionSide: "short",
      contracts: 2.5,
      slPx: 3100,
      tpPx: 2900,
      wantsTp: true
    });

    const realSlOnly: ProtectiveAlgoRow = {
      instId,
      posSide: "short",
      side: "buy",
      reduceOnly: true,
      tdMode: "cross",
      ordType: "conditional",
      sz: 2.5,
      slTriggerPx: "3100",
      algoId: "okx_algo_sl_7711",
      algoClOrdId: "slpETHentry001",
      state: "live"
    };

    const plan = planProtectiveOrderReconcile([realSlOnly], ctx);
    assertTrue(plan.canonicalSl !== null, "CASE C canonicalSl must exist");
    assertEq(plan.canonicalTp, null, "CASE C canonicalTp must be null");
    assertFalse(plan.submitOco, "CASE C submitOco must be false");
    assertFalse(plan.needSubmitSl, "CASE C needSubmitSl must be false");
    assertTrue(plan.needSubmitTp, "CASE C needSubmitTp must be true for missing TP");
    pass("CASE C - Real SL exists, missing TP repair required", "needSubmitTp=true, needSubmitSl=false");
  }

  // -------------------------------------------------------------------------
  // CASE D: algoId=null synthetic candidate only -> canonical promotion blocked
  // -------------------------------------------------------------------------
  {
    const instId = "BTC-USDT-SWAP";
    const ctx = createCtx({
      instId,
      positionSide: "long",
      contracts: 1.0,
      slPx: 60000,
      tpPx: null,
      wantsTp: false
    });

    const syntheticRow: ProtectiveAlgoRow = {
      instId,
      posSide: "long",
      side: "sell",
      reduceOnly: true,
      tdMode: "cross",
      ordType: "conditional",
      sz: 1.0,
      slTriggerPx: "60000",
      algoId: undefined, // NO ALGO ID
      _protectiveInventorySource: "entry_attach_candidate"
    };

    const matchEv = evaluateProtectiveAlgoMatch(syntheticRow, ctx);
    assertFalse(matchEv.adoptable, "CASE D synthetic row adoptable must be false");
    assertFalse(matchEv.slLegValid, "CASE D synthetic row slLegValid must be false");

    const plan = planProtectiveOrderReconcile([syntheticRow], ctx);
    assertEq(plan.canonicalSl, null, "CASE D canonicalSl must be null");
    assertTrue(plan.needSubmitSl, "CASE D needSubmitSl must be true");
    pass("CASE D - algoId=null synthetic candidate not promoted", "adoptable=false, needSubmitSl=true");
  }

  // -------------------------------------------------------------------------
  // CASE E: Wrong size / wrong side / wrong price real orders
  // -------------------------------------------------------------------------
  {
    const instId = "BTC-USDT-SWAP";
    const ctx = createCtx({
      instId,
      positionSide: "long",
      contracts: 1.0,
      slPx: 60000,
      tpPx: null,
      wantsTp: false
    });

    // Wrong size (0.5 instead of 1.0)
    const wrongSize: ProtectiveAlgoRow = {
      instId,
      posSide: "long",
      side: "sell",
      reduceOnly: true,
      tdMode: "cross",
      ordType: "conditional",
      sz: 0.5,
      slTriggerPx: "60000",
      algoId: "okx_wrong_sz_1",
      state: "live"
    };

    // Wrong side (buy instead of sell for closing long)
    const wrongSide: ProtectiveAlgoRow = {
      instId,
      posSide: "long",
      side: "buy",
      reduceOnly: true,
      tdMode: "cross",
      ordType: "conditional",
      sz: 1.0,
      slTriggerPx: "60000",
      algoId: "okx_wrong_side_2",
      state: "live"
    };

    // Wrong price (55000 instead of 60000)
    const wrongPrice: ProtectiveAlgoRow = {
      instId,
      posSide: "long",
      side: "sell",
      reduceOnly: true,
      tdMode: "cross",
      ordType: "conditional",
      sz: 1.0,
      slTriggerPx: "55000",
      algoId: "okx_wrong_px_3",
      state: "live"
    };

    const plan = planProtectiveOrderReconcile([wrongSize, wrongSide, wrongPrice], ctx);
    assertEq(plan.canonicalSl, null, "CASE E canonicalSl must be null");
    assertTrue(plan.needSubmitSl, "CASE E needSubmitSl must be true");
    // Stale wrong size order must be marked for cancel
    assertTrue(plan.cancelAlgoIds.includes("okx_wrong_sz_1"), "CASE E stale wrong size must be canceled");
    pass("CASE E - Wrong size/side/price rejected as canonical", "canonicalSl=null, wrongSize canceled");
  }

  // -------------------------------------------------------------------------
  // CASE F: Submit success immediate visibility grace
  // -------------------------------------------------------------------------
  {
    const nowMs = 1770000000000;
    const graceDeadlineMs = nowMs + 30000;

    const ledgerInGrace: PaperOpenPositionRecord = {
      symbol: "BTCUSDT",
      side: "long",
      status: "open",
      pos: 0.17,
      entryPrice: 62830.1,
      sizeUsd: 106.8,
      initialSizeUsd: 106.8,
      openedAt: nowMs - 5000,
      leverage: 2,
      strategyVersion: "paper-v2",
      sourceSignal: "test",
      sourceRunPath: "test",
      executorAtEntry: "RANGE",
      regimeAtEntry: "RANGE",
      protectiveSlAlgoId: "okx_submitted_sl_999",
      isProtectiveStopRegistered: true,
      protectiveVisibilityGraceDeadlineMs: graceDeadlineMs,
      lifecycleState: "BOT_V2_MANAGED"
    };

    const opsVerdict = evaluateOpsWatchProtectiveScanVerdict({
      nowMs,
      ledger: ledgerInGrace,
      reduceOnlyProtectiveFound: false, // Not yet visible on OKX pending scan
      matchingProtectivePendingCount: 0,
      scanClean: true,
      tpRequired: false
    });

    assertEq(opsVerdict.verdict, "DEFER", "CASE F verdict must be DEFER during grace");
    assertTrue(opsVerdict.opsWatchVisibilityGraceApplied, "CASE F visibility grace applied");
    assertFalse(opsVerdict.shouldBlockSymbol, "CASE F symbol must not be blocked during grace");
    pass("CASE F - Submit success within grace yields DEFER", "verdict=DEFER, no false hard-block");
  }

  // -------------------------------------------------------------------------
  // CASE G: Authoritative empty exchange protection inventory
  // -> reduceOnlyProtectiveFound = false
  // -> matchingProtectivePendingCount = 0
  // -> consistencyCheck = FAIL
  // -> canonicalProtectiveSlFound = false
  // -> protection is MISSING and requires repair by the reconcile layer.
  // -------------------------------------------------------------------------
  {
    const posProtectionState = evaluatePositionProtectionState({
      instId: "BTC-USDT-SWAP",
      positionSide: "long",
      pending: [],
      algos: [],
      tpRequired: true,
      requiredStopPx: 62666.7,
      requiredContracts: 0.17
    });

    assertFalse(posProtectionState.reduceOnlyProtectiveFound, "CASE G reduceOnlyProtectiveFound false");
    assertEq(posProtectionState.matchingProtectivePendingCount, 0, "CASE G matching count 0");
    assertEq(posProtectionState.consistencyCheck, "FAIL", "CASE G consistencyCheck FAIL");
    assertFalse(posProtectionState.canonicalProtectiveSlFound, "CASE G canonicalProtectiveSlFound false");
    assertTrue(posProtectionState.preScanFault, "CASE G preScanFault true (protection is MISSING)");
    pass(
      "CASE G - Authoritative empty exchange protection inventory",
      "reduceOnlyProtectiveFound=false, consistencyCheck=FAIL, protection MISSING (requires repair)"
    );
  }

  // -------------------------------------------------------------------------
  // CASE H: BTC RANGE position real parameters integration
  // (entry=62830.1, SL=62666.74174, TP=63068.85438, contracts=0.17, pending=[])
  // -------------------------------------------------------------------------
  {
    const instId = "BTC-USDT-SWAP";
    const ctx = createCtx({
      instId,
      positionSide: "long",
      contracts: 0.17,
      slPx: 62666.74174,
      tpPx: 63068.85438,
      wantsTp: true
    });

    // Actual exchange pending is empty
    const actualExchangePending: ProtectiveAlgoRow[] = [];

    // Structural candidate generated from position
    const attachCandidate = buildEntryAttachProtectiveCandidates({
      instId,
      positionSide: "long",
      tdModeUsed: "cross",
      expectedSide: "sell",
      contracts: 0.17,
      activeStopPrice: 62666.74174,
      activeTpPrice: 63068.85438,
      wantsTp: true,
      entryClOrdId: "pBTC62830Entry"
    });

    const mergedInventory = mergeProtectiveInventoryRows(actualExchangePending, attachCandidate);
    const plan = planProtectiveOrderReconcile(mergedInventory, ctx);

    // Reconcile plan must detect missing protection and trigger submit
    assertTrue(plan.submitOco, "CASE H submitOco must be true");
    assertEq(plan.canonicalSl, null, "CASE H canonicalSl must be null without exchange algoId");
    assertEq(plan.canonicalTp, null, "CASE H canonicalTp must be null without exchange algoId");

    pass(
      "CASE H - BTC RANGE position (0.17 contracts) triggers repair submitOco",
      "entry=62830.1, SL=62666.74, TP=63068.85 -> submitOco=true"
    );
  }

  console.info("\n=== BLOCKER 4-10 SUMMARY ===");
  console.info("ALL_RELEVANT_REGRESSION = PASS");
  console.info("READY_TO_COMMIT_BLOCKER_4_10 = YES\n");
}

runBlocker410Cases();
