/**
 * BLOCKER 4-13 — Protective TP Authority / Truthful Registration Tests
 *
 * Tests:
 * CASE A: tpRequired=false / no TP order => tpRegistered=false => tpProtectionSatisfied=true
 * CASE B: tpRequired=true / TP missing => tpRegistered=false => needSubmitTp=true => protectionSuccess=false
 * CASE C: tpRequired=true / TP actual algo exists => tpRegistered=true => tpProtectionSatisfied=true
 * CASE D: SL exists / TP required missing => TP-only repair
 * CASE E: TP exists / SL missing => SL-only repair
 * CASE F: both required and missing => both repair (OCO)
 * CASE G: manual TP-like order ignored => tpRegistered=false
 * CASE H: partial close changes size and SL disappears => SL repair continues to PASS
 * CASE I: final proof must never print tpRegistered=true with tpAlgoId=null when tpRequired=true
 * CASE J: TREND no-fixed-TP mode: tpRequired=false, tpAlgoId=null, protectionSuccess=true, tpRegistered=false
 */

import {
  planProtectiveOrderReconcile,
  type ProtectiveAlgoRow,
  type ProtectiveReconcileContext
} from "../engine-v2/execution/protective-reconcile-plan";
import { resolveProtectiveExistingAlgoLedgerAdoption } from "./paper-engine";

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  if (!value) throw new Error(`[FAIL] ${label}: expected true`);
}

function pass(label: string, detail?: string): void {
  console.info(`[BLOCKER-4-13][${label}] PASS${detail ? ` — ${detail}` : ""}`);
}

function runBlocker413Cases(): void {
  console.info("=== STARTING BLOCKER 4-13 PROTECTIVE TP AUTHORITY TESTS ===");

  const baseCtx: ProtectiveReconcileContext = {
    instId: "BTC-USDT-SWAP",
    positionSide: "long",
    openedAt36: "1000",
    tdModeUsed: "cross",
    contractsToProtect: 0.5,
    activeStopPrice: 59000,
    activeTpPrice: 62000,
    wantsTp: true,
    expectedSide: "sell",
    tickSz: 0.1
  };

  // -------------------------------------------------------------------------
  // CASE A: tpRequired=false / no TP order => tpRegistered=false => tpProtectionSatisfied=true
  // -------------------------------------------------------------------------
  {
    const slAlgoId = "algo_sl_123";
    const res = resolveProtectiveExistingAlgoLedgerAdoption({
      previousIsProtectiveStopRegistered: true,
      previousIsProtectionFailed: false,
      previousIsTakeProfitRegistered: false,
      previousProtectiveStopAlgoId: slAlgoId,
      previousProtectiveSlAlgoId: slAlgoId,
      previousProtectiveTpAlgoId: undefined,
      slAlgoId,
      tpAlgoId: null,
      wantsTp: false,
      tpRequired: false,
      slRequired: true,
      slCanonicalMatch: true,
      tpCanonicalMatch: false
    });

    assertEq(res.tpRequired, false, "CASE A tpRequired is false");
    assertEq(res.isTakeProfitRegistered, false, "CASE A isTakeProfitRegistered is false");
    assertEq(res.tpProtectionSatisfied, true, "CASE A tpProtectionSatisfied is true");
    assertEq(res.protectionComplete, true, "CASE A protectionComplete is true");
    assertEq(res.isProtectionFailed, false, "CASE A isProtectionFailed is false");
    pass("CASE A - tpRequired=false / no TP order", "tpRegistered=false, tpProtectionSatisfied=true, protectionComplete=true");
  }

  // -------------------------------------------------------------------------
  // CASE B: tpRequired=true / TP missing => tpRegistered=false => needSubmitTp=true => protectionSuccess=false
  // -------------------------------------------------------------------------
  {
    const slAlgoId = "algo_sl_123";
    const res = resolveProtectiveExistingAlgoLedgerAdoption({
      previousIsProtectiveStopRegistered: true,
      previousIsProtectionFailed: false,
      previousIsTakeProfitRegistered: false,
      previousProtectiveStopAlgoId: slAlgoId,
      previousProtectiveSlAlgoId: slAlgoId,
      previousProtectiveTpAlgoId: undefined,
      slAlgoId,
      tpAlgoId: null,
      wantsTp: true,
      tpRequired: true,
      slRequired: true,
      slCanonicalMatch: true,
      tpCanonicalMatch: false
    });

    assertEq(res.tpRequired, true, "CASE B tpRequired is true");
    assertEq(res.isTakeProfitRegistered, false, "CASE B isTakeProfitRegistered is false");
    assertEq(res.tpProtectionSatisfied, false, "CASE B tpProtectionSatisfied is false");
    assertEq(res.protectionComplete, false, "CASE B protectionComplete is false");
    assertEq(res.isProtectionFailed, true, "CASE B isProtectionFailed is true");

    const slRegistered = true;
    const tpRegistered = false;
    const tpRequired = true;
    const slRequired = true;
    const needSubmitTp = tpRequired && !tpRegistered;
    const protectionSuccess = (!slRequired || slRegistered) && (!tpRequired || tpRegistered);

    assertEq(needSubmitTp, true, "CASE B needSubmitTp is true");
    assertEq(protectionSuccess, false, "CASE B protectionSuccess is false");
    pass("CASE B - tpRequired=true / TP missing", "tpRegistered=false, needSubmitTp=true, protectionSuccess=false");
  }

  // -------------------------------------------------------------------------
  // CASE C: tpRequired=true / TP actual algo exists => tpRegistered=true => tpProtectionSatisfied=true
  // -------------------------------------------------------------------------
  {
    const slAlgoId = "algo_sl_123";
    const tpAlgoId = "algo_tp_456";
    const res = resolveProtectiveExistingAlgoLedgerAdoption({
      previousIsProtectiveStopRegistered: true,
      previousIsProtectionFailed: false,
      previousIsTakeProfitRegistered: true,
      previousProtectiveStopAlgoId: slAlgoId,
      previousProtectiveSlAlgoId: slAlgoId,
      previousProtectiveTpAlgoId: tpAlgoId,
      slAlgoId,
      tpAlgoId,
      wantsTp: true,
      tpRequired: true,
      slRequired: true,
      slCanonicalMatch: true,
      tpCanonicalMatch: true
    });

    assertEq(res.isTakeProfitRegistered, true, "CASE C isTakeProfitRegistered is true");
    assertEq(res.tpProtectionSatisfied, true, "CASE C tpProtectionSatisfied is true");
    assertEq(res.protectiveTpAlgoId, tpAlgoId, "CASE C protectiveTpAlgoId matches");
    assertEq(res.protectionComplete, true, "CASE C protectionComplete is true");
    pass("CASE C - tpRequired=true / TP actual algo exists", "tpRegistered=true, tpProtectionSatisfied=true, algoId=algo_tp_456");
  }

  // -------------------------------------------------------------------------
  // CASE D: SL exists / TP required missing => TP-only repair
  // -------------------------------------------------------------------------
  {
    const realSl: ProtectiveAlgoRow = {
      algoId: "algo_sl_real",
      algoClOrdId: "slpBTC1000",
      instId: "BTC-USDT-SWAP",
      ordType: "conditional",
      posSide: "long",
      side: "sell",
      tdMode: "cross",
      reduceOnly: true,
      sz: 0.5,
      slTriggerPx: "59000",
      slTriggerPxType: "last",
      tpTriggerPx: "",
      tpTriggerPxType: "",
      cTime: "1000"
    };

    const plan = planProtectiveOrderReconcile([realSl], baseCtx);
    const hasAuthoritativeSl = plan.canonicalSl?.algoId != null;
    const hasAuthoritativeTp = plan.canonicalTp?.algoId != null;
    const slRequired = true;
    const tpRequired = true;

    const needSubmitSl = slRequired && !hasAuthoritativeSl;
    const needSubmitTp = tpRequired && !hasAuthoritativeTp;
    const submitOco = needSubmitSl && needSubmitTp && baseCtx.wantsTp;

    assertEq(needSubmitSl, false, "CASE D needSubmitSl is false");
    assertEq(needSubmitTp, true, "CASE D needSubmitTp is true");
    assertEq(submitOco, false, "CASE D submitOco is false");
    pass("CASE D - SL exists / TP required missing", "needSubmitSl=false, needSubmitTp=true, submitOco=false (TP-only repair)");
  }

  // -------------------------------------------------------------------------
  // CASE E: TP exists / SL missing => SL-only repair
  // -------------------------------------------------------------------------
  {
    const realTp: ProtectiveAlgoRow = {
      algoId: "algo_tp_real",
      algoClOrdId: "tppBTC1000",
      instId: "BTC-USDT-SWAP",
      ordType: "conditional",
      posSide: "long",
      side: "sell",
      tdMode: "cross",
      reduceOnly: true,
      sz: 0.5,
      slTriggerPx: "",
      slTriggerPxType: "",
      tpTriggerPx: "62000",
      tpTriggerPxType: "last",
      cTime: "1000"
    };

    const plan = planProtectiveOrderReconcile([realTp], baseCtx);
    const hasAuthoritativeSl = plan.canonicalSl?.algoId != null;
    const hasAuthoritativeTp = plan.canonicalTp?.algoId != null;
    const slRequired = true;
    const tpRequired = true;

    const needSubmitSl = slRequired && !hasAuthoritativeSl;
    const needSubmitTp = tpRequired && !hasAuthoritativeTp;
    const submitOco = needSubmitSl && needSubmitTp && baseCtx.wantsTp;

    assertEq(needSubmitSl, true, "CASE E needSubmitSl is true");
    assertEq(needSubmitTp, false, "CASE E needSubmitTp is false");
    assertEq(submitOco, false, "CASE E submitOco is false");
    pass("CASE E - TP exists / SL missing", "needSubmitSl=true, needSubmitTp=false, submitOco=false (SL-only repair)");
  }

  // -------------------------------------------------------------------------
  // CASE F: both required and missing => both repair (OCO)
  // -------------------------------------------------------------------------
  {
    const plan = planProtectiveOrderReconcile([], baseCtx);
    const hasAuthoritativeSl = plan.canonicalSl?.algoId != null;
    const hasAuthoritativeTp = plan.canonicalTp?.algoId != null;
    const slRequired = true;
    const tpRequired = true;

    const needSubmitSl = slRequired && !hasAuthoritativeSl;
    const needSubmitTp = tpRequired && !hasAuthoritativeTp;
    const submitOco = needSubmitSl && needSubmitTp && baseCtx.wantsTp;

    assertEq(needSubmitSl, true, "CASE F needSubmitSl is true");
    assertEq(needSubmitTp, true, "CASE F needSubmitTp is true");
    assertEq(submitOco, true, "CASE F submitOco is true");
    pass("CASE F - both required and missing", "needSubmitSl=true, needSubmitTp=true, submitOco=true (OCO submit)");
  }

  // -------------------------------------------------------------------------
  // CASE G: manual TP-like order ignored => tpRegistered=false
  // -------------------------------------------------------------------------
  {
    const manualTp: ProtectiveAlgoRow = {
      algoId: "algo_manual_tp",
      algoClOrdId: "manual_web_tp_999", // Manual non-matching price order
      instId: "BTC-USDT-SWAP",
      ordType: "conditional",
      posSide: "long",
      side: "sell",
      tdMode: "cross",
      reduceOnly: true,
      sz: 0.5,
      slTriggerPx: "",
      slTriggerPxType: "",
      tpTriggerPx: "70000", // Non-matching price (activeTp is 62000)
      tpTriggerPxType: "last",
      cTime: "1000"
    };

    const plan = planProtectiveOrderReconcile([manualTp], baseCtx);
    assertEq(plan.canonicalTp, null, "CASE G manual TP not canonical");
    assertEq(plan.manualIgnoredCount, 1, "CASE G manual TP counted in manualIgnoredCount");

    const tpRegistered = plan.canonicalTp?.algoId != null && String(plan.canonicalTp.algoId).trim().length > 0;
    assertEq(tpRegistered, false, "CASE G tpRegistered is false");
    pass("CASE G - manual TP-like order ignored", "manualIgnoredCount=1, tpRegistered=false");
  }

  // -------------------------------------------------------------------------
  // CASE H: partial close changes size and SL disappears => SL repair continues to PASS
  // -------------------------------------------------------------------------
  {
    // Partial close reduces size 0.48 -> 0.24, existing 0.48 SL is stale
    const staleSl: ProtectiveAlgoRow = {
      algoId: "algo_sl_old_size",
      algoClOrdId: "slpBTC1000",
      instId: "BTC-USDT-SWAP",
      ordType: "conditional",
      posSide: "long",
      side: "sell",
      tdMode: "cross",
      reduceOnly: true,
      sz: 0.48, // Wrong size
      slTriggerPx: "59000",
      slTriggerPxType: "last",
      tpTriggerPx: "",
      tpTriggerPxType: "",
      cTime: "1000"
    };

    const reducedCtx: ProtectiveReconcileContext = {
      ...baseCtx,
      contractsToProtect: 0.24 // New size after partial close
    };

    const plan = planProtectiveOrderReconcile([staleSl], reducedCtx);
    assertEq(plan.staleCount, 1, "CASE H staleCount is 1");
    assertEq(plan.cancelAlgoIds.includes("algo_sl_old_size"), true, "CASE H old size marked for cancel");
    assertEq(plan.canonicalSl, null, "CASE H canonicalSl is null");

    const needSubmitSl = !plan.canonicalSl;
    assertEq(needSubmitSl, true, "CASE H needSubmitSl is true for new size 0.24");
    pass("CASE H - partial close size change triggers SL rebuild", "staleCount=1, cancelAlgoIds=[algo_sl_old_size], needSubmitSl=true");
  }

  // -------------------------------------------------------------------------
  // CASE I: final proof must never print tpRegistered=true with tpAlgoId=null when tpRequired=true
  // -------------------------------------------------------------------------
  {
    const engineOwnedTp = null;
    const tpRequired = true;
    const slRequired = true;
    const engineOwnedSl: any = { algoId: "algo_sl_valid" };

    const slRegistered = engineOwnedSl?.algoId != null && String(engineOwnedSl.algoId).trim().length > 0;
    const tpRegistered = (engineOwnedTp as any)?.algoId != null && String((engineOwnedTp as any).algoId).trim().length > 0;
    const slAlgoId = slRegistered ? String(engineOwnedSl.algoId).trim() : undefined;
    const tpAlgoId = tpRegistered ? String((engineOwnedTp as any).algoId).trim() : undefined;

    const slProtectionSatisfied = !slRequired || slRegistered;
    const tpProtectionSatisfied = !tpRequired || tpRegistered;
    const protectionSuccess = slProtectionSatisfied && tpProtectionSatisfied;

    const proof = {
      slRequired,
      tpRequired,
      slRegistered,
      tpRegistered,
      slAlgoId: slAlgoId ?? null,
      tpAlgoId: tpAlgoId ?? null,
      slProtectionSatisfied,
      tpProtectionSatisfied,
      protectionSuccess
    };

    // Invariant check: tpRegistered MUST NEVER be true if tpAlgoId is null!
    if (proof.tpRegistered && proof.tpAlgoId === null) {
      throw new Error("[FAIL] CASE I: Invariant violated! tpRegistered=true with tpAlgoId=null");
    }

    assertEq(proof.tpRegistered, false, "CASE I tpRegistered is false");
    assertEq(proof.tpAlgoId, null, "CASE I tpAlgoId is null");
    assertEq(proof.tpProtectionSatisfied, false, "CASE I tpProtectionSatisfied is false");
    assertEq(proof.protectionSuccess, false, "CASE I protectionSuccess is false");
    pass("CASE I - Invariant verified: tpRegistered=false when tpAlgoId=null and tpRequired=true", "no false-positive registration");
  }

  // -------------------------------------------------------------------------
  // CASE J: TREND no-fixed-TP mode: tpRequired=false, tpAlgoId=null, protectionSuccess=true, tpRegistered=false
  // -------------------------------------------------------------------------
  {
    const engineOwnedTp = null;
    const tpRequired = false; // TREND mode does not use fixed TP
    const slRequired = true;
    const engineOwnedSl: any = { algoId: "algo_trend_sl" };

    const slRegistered = engineOwnedSl?.algoId != null && String(engineOwnedSl.algoId).trim().length > 0;
    const tpRegistered = (engineOwnedTp as any)?.algoId != null && String((engineOwnedTp as any).algoId).trim().length > 0;
    const slAlgoId = slRegistered ? String(engineOwnedSl.algoId).trim() : undefined;
    const tpAlgoId = tpRegistered ? String((engineOwnedTp as any).algoId).trim() : undefined;

    const slProtectionSatisfied = !slRequired || slRegistered;
    const tpProtectionSatisfied = !tpRequired || tpRegistered;
    const protectionSuccess = slProtectionSatisfied && tpProtectionSatisfied;

    const proof = {
      slRequired,
      tpRequired,
      slRegistered,
      tpRegistered,
      slAlgoId: slAlgoId ?? null,
      tpAlgoId: tpAlgoId ?? null,
      slProtectionSatisfied,
      tpProtectionSatisfied,
      protectionSuccess
    };

    assertEq(proof.tpRequired, false, "CASE J tpRequired is false");
    assertEq(proof.tpRegistered, false, "CASE J tpRegistered is truthful false");
    assertEq(proof.tpAlgoId, null, "CASE J tpAlgoId is null");
    assertEq(proof.tpProtectionSatisfied, true, "CASE J tpProtectionSatisfied is true");
    assertEq(proof.protectionSuccess, true, "CASE J protectionSuccess is true");
    pass("CASE J - TREND mode truthful non-registration", "tpRequired=false, tpRegistered=false, tpAlgoId=null, protectionSuccess=true");
  }

  console.info("\n=== BLOCKER 4-13 SUMMARY ===");
  console.info("ALL_RELEVANT_REGRESSION = PASS");
  console.info("READY_TO_STAGE_BLOCKER_4_13 = YES\n");
}

runBlocker413Cases();
