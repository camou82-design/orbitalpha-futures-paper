/**
 * BLOCKER 4-6 — MANUAL POSITION OKX NOTIONAL AUTHORITY / ACCOUNT-WIDE FALSE BLOCK FIX
 * Regression test suite
 *
 * Validates that:
 * CASE A: Manual BTC (UNKNOWN unit) + OKX actual notional 37.77 → authoritative=true, source=OKX_ACTUAL
 * CASE B: Manual BTC + OKX actual → ETH new entry NOT account-wide blocked solely due to BTC unknown unit
 * CASE C: Manual BTC (UNKNOWN) + OKX actual MISSING → Fail-Closed preserved (authoritative=false)
 * CASE D: Corrupted V2 (V2_UNIT_UNVERIFIED) + OKX missing → still blocked (BLOCKER 4-1R invariant)
 * CASE E: Corrupted/Unverified V2 + OKX actual exists → OKX_ACTUAL authority accepted
 * CASE F: Canonical V2 (notionalUsd present) → PERSISTED_NOTIONAL remains priority
 * CASE G: Proven Legacy (sizeUsd margin + leverage) → LEGACY_MARGIN_CONVERTED preserved
 * CASE H: Manual OKX exposure 37.77 → included in account/symbol cap calculation
 */

import {
  resolveOpenNotionalAuthority,
  resolveOpenPositionSizeUnit
} from "../engine-v2/live-account/position-size-authority";
import {
  sumPaperExposureNotional,
  resolveLiveExposureAuthority
} from "../engine-v2/live-account/exposure-authority";
import { marginsForSymbol } from "./range-engine";

function run(label: string, passed: boolean, detail: string): boolean {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[BLOCKER-4-6][${label}] ${tag} — ${detail}`);
  return passed;
}

let allOk = true;

// ── CASE A: Manual BTC UNKNOWN unit + OKX actual notional = 37.77 ─────────
// Expected: authoritative=true, source=OKX_ACTUAL, valueUsd=37.77
{
  const manualBtc: any = {
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: undefined,        // no ledger size
    notionalUsd: undefined,    // no persisted notional
    isV2Authority: undefined,
    leverage: undefined,
    strategyVersion: "v2_manual"  // UNKNOWN unit
  };
  const unit = resolveOpenPositionSizeUnit(manualBtc);
  const auth = resolveOpenNotionalAuthority(manualBtc, 37.77);
  allOk =
    run(
      "CASE A - unit",
      unit === "UNKNOWN",
      `unit=${unit} (manual BTC must be UNKNOWN)`
    ) && allOk;
  allOk =
    run(
      "CASE A - authoritative",
      auth.authoritative === true,
      `authoritative=${auth.authoritative}`
    ) && allOk;
  allOk =
    run(
      "CASE A - source",
      auth.source === "OKX_ACTUAL",
      `source=${auth.source}`
    ) && allOk;
  allOk =
    run(
      "CASE A - valueUsd",
      auth.valueUsd === 37.77,
      `valueUsd=${auth.valueUsd}`
    ) && allOk;
}

// ── CASE B: Manual BTC + OKX → account sumPaperExposureNotional resolves ──
// ETH has no paper position → sum should NOT be null (no false block for ETH)
{
  const manualBtc: any = {
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: undefined,
    isV2Authority: undefined,
    leverage: undefined,
    strategyVersion: "v2_manual"
  };
  const okxActualPositions = [
    { symbol: "BTCUSDT", side: "long", notionalUsd: 37.77 }
  ];
  // Account-wide sum: BTC (UNKNOWN) + OKX actual → must NOT be null
  const accountSum = sumPaperExposureNotional([manualBtc], undefined, okxActualPositions);
  allOk =
    run(
      "CASE B - account sum not null",
      accountSum !== null,
      `accountSum=${accountSum} (BTC with OKX actual → not blocked)`
    ) && allOk;
  allOk =
    run(
      "CASE B - account sum correct",
      accountSum === 37.77,
      `accountSum=${accountSum} (must equal 37.77)`
    ) && allOk;

  // ETH has no positions → separate calculation, not blocked
  const ethOnlySum = sumPaperExposureNotional([], "ETHUSDT", okxActualPositions);
  allOk =
    run(
      "CASE B - ETH sum not blocked",
      ethOnlySum === 0,
      `ethSum=${ethOnlySum} (ETH empty positions → 0, not blocked)`
    ) && allOk;
}

// ── CASE C: Manual BTC UNKNOWN + OKX actual MISSING → Fail-Closed ─────────
// Expected: authoritative=false, valueUsd=null, UNKNOWN_UNIT_SAFETY_BLOCK
{
  const manualBtc: any = {
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: undefined,
    isV2Authority: undefined,
    leverage: undefined,
    strategyVersion: "v2_manual"
  };
  const auth = resolveOpenNotionalAuthority(manualBtc); // no okxActualNotionalUsd
  allOk =
    run(
      "CASE C - authoritative false",
      auth.authoritative === false,
      `authoritative=${auth.authoritative} (Fail-Closed: no OKX actual)`
    ) && allOk;
  allOk =
    run(
      "CASE C - valueUsd null",
      auth.valueUsd === null,
      `valueUsd=${auth.valueUsd}`
    ) && allOk;
  allOk =
    run(
      "CASE C - source UNKNOWN_FALLBACK",
      auth.source === "UNKNOWN_FALLBACK",
      `source=${auth.source}`
    ) && allOk;

  // sumPaperExposureNotional must return null (Fail-Closed)
  const sum = sumPaperExposureNotional([manualBtc], undefined, undefined);
  allOk =
    run(
      "CASE C - sumPaper null",
      sum === null,
      `sumPaper=${sum} (Fail-Closed preserved)`
    ) && allOk;
}

// ── CASE D: Corrupted V2 (V2_UNIT_UNVERIFIED) + OKX missing → blocked ─────
// BLOCKER 4-1R invariant: V2_UNIT_UNVERIFIED without OKX must remain blocked
{
  const corruptedV2: any = {
    symbol: "ETHUSDT",
    side: "long",
    sizeUsd: 10.698,
    notionalUsd: undefined,
    isV2Authority: true,
    leverage: 10
  };
  const unit = resolveOpenPositionSizeUnit(corruptedV2);
  const auth = resolveOpenNotionalAuthority(corruptedV2); // no OKX
  allOk =
    run(
      "CASE D - unit V2_UNIT_UNVERIFIED",
      unit === "V2_UNIT_UNVERIFIED",
      `unit=${unit}`
    ) && allOk;
  allOk =
    run(
      "CASE D - authoritative false",
      auth.authoritative === false,
      `authoritative=${auth.authoritative} (BLOCKER 4-1R: still blocked)`
    ) && allOk;
  allOk =
    run(
      "CASE D - valueUsd null",
      auth.valueUsd === null,
      `valueUsd=${auth.valueUsd}`
    ) && allOk;
}

// ── CASE E: Corrupted V2 + OKX actual exists → OKX_ACTUAL authority ──────
{
  const corruptedV2: any = {
    symbol: "ETHUSDT",
    side: "long",
    sizeUsd: 10.698,
    notionalUsd: undefined,
    isV2Authority: true,
    leverage: 10
  };
  const auth = resolveOpenNotionalAuthority(corruptedV2, 106.98);
  allOk =
    run(
      "CASE E - authoritative true",
      auth.authoritative === true,
      `authoritative=${auth.authoritative} (OKX actual rescues corrupted V2)`
    ) && allOk;
  allOk =
    run(
      "CASE E - source OKX_ACTUAL",
      auth.source === "OKX_ACTUAL",
      `source=${auth.source}`
    ) && allOk;
  allOk =
    run(
      "CASE E - valueUsd",
      auth.valueUsd === 106.98,
      `valueUsd=${auth.valueUsd}`
    ) && allOk;
}

// ── CASE F: Canonical V2 (notionalUsd present) → PERSISTED_NOTIONAL ───────
{
  const canonicalV2: any = {
    symbol: "ETHUSDT",
    side: "short",
    sizeUsd: 106.98,
    notionalUsd: 106.98,
    isV2Authority: true,
    leverage: 10
  };
  // Even if OKX differs, persisted notional wins
  const auth = resolveOpenNotionalAuthority(canonicalV2, 999);
  allOk =
    run(
      "CASE F - source PERSISTED_NOTIONAL",
      auth.source === "PERSISTED_NOTIONAL",
      `source=${auth.source} (canonical V2 must not be overridden by OKX)`
    ) && allOk;
  allOk =
    run(
      "CASE F - valueUsd persisted",
      auth.valueUsd === 106.98,
      `valueUsd=${auth.valueUsd}`
    ) && allOk;
}

// ── CASE G: Proven Legacy → LEGACY_MARGIN_CONVERTED preserved ─────────────
{
  const legacyPos: any = {
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: 10.698,
    notionalUsd: undefined,
    isV2Authority: undefined,
    leverage: 10,
    strategyVersion: "1.0.0"   // LEGACY_MARGIN
  };
  const auth = resolveOpenNotionalAuthority(legacyPos);
  allOk =
    run(
      "CASE G - source LEGACY_MARGIN_CONVERTED",
      auth.source === "LEGACY_MARGIN_CONVERTED",
      `source=${auth.source}`
    ) && allOk;
  allOk =
    run(
      "CASE G - authoritative true",
      auth.authoritative === true,
      `authoritative=${auth.authoritative}`
    ) && allOk;
  allOk =
    run(
      "CASE G - valueUsd = sizeUsd * leverage",
      Math.abs((auth.valueUsd ?? 0) - 106.98) < 0.001,
      `valueUsd=${auth.valueUsd} (expected 106.98)`
    ) && allOk;
}

// ── CASE H: Manual OKX exposure 37.77 included in caps ────────────────────
{
  const manualBtc: any = {
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: undefined,
    isV2Authority: undefined,
    leverage: undefined,
    strategyVersion: "v2_manual",
    status: "open"
  };
  const okxActualPositions = [
    { symbol: "BTCUSDT", side: "long", notionalUsd: 37.77 }
  ];

  // Test via marginsForSymbol
  const margins = marginsForSymbol([manualBtc], "BTCUSDT", okxActualPositions);
  allOk =
    run(
      "CASE H - marginsForSymbol authoritative",
      margins.authoritative === true,
      `authoritative=${margins.authoritative}`
    ) && allOk;
  allOk =
    run(
      "CASE H - longUsd = 37.77",
      Math.abs(margins.longUsd - 37.77) < 0.001,
      `longUsd=${margins.longUsd} (must include BTC actual notional in cap)`
    ) && allOk;

  // Test via resolveLiveExposureAuthority (paper ledger path)
  const exposure = resolveLiveExposureAuthority({
    symbol: "BTCUSDT",
    okxPositions: [],
    paperPositions: [manualBtc],
    okxActualPositions,
    pendingSymbolNotionalUsdt: 0,
    pendingOrdersNotionalUsdt: 0,
    isLiveAuthority: false  // paper ledger path
  });
  allOk =
    run(
      "CASE H - paper_symbol_notional includes BTC",
      Math.abs(exposure.paper_symbol_notional_usdt - 37.77) < 0.001,
      `paper_symbol_notional_usdt=${exposure.paper_symbol_notional_usdt}`
    ) && allOk;
  allOk =
    run(
      "CASE H - paper_account_notional includes BTC",
      Math.abs(exposure.paper_account_notional_usdt - 37.77) < 0.001,
      `paper_account_notional_usdt=${exposure.paper_account_notional_usdt}`
    ) && allOk;
}

console.log(
  `\n[BLOCKER-4-6] Regression suite complete. Overall: ${allOk ? "ALL PASS" : "SOME FAIL"}`
);
if (!allOk) process.exit(1);
