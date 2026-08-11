import {
  resolveV2CloseContractAuthority,
  resolveV2ReduceContracts
} from "../engine-v2/execution/close-contract-authority";

function assertTrue(v: boolean, label: string): void {
  if (!v) throw new Error(`${label}: expected true`);
}

function assertFalse(v: boolean, label: string): void {
  if (v) throw new Error(`${label}: expected false`);
}

function assertNear(a: number, b: number, tol: number, label: string): void {
  if (Math.abs(a - b) > tol) throw new Error(`${label}: expected ~${b}, got ${a}`);
}

function assertEqSource(a: string, b: string, label: string): void {
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

// CASE C — ledger 0.21 / actual 0.19 → full close 0.19
{
  const auth = resolveV2CloseContractAuthority({
    symbol: "BTCUSDT",
    side: "long",
    closeKind: "full",
    okxActualContracts: 0.19,
    okxActualAvailable: true,
    ledgerContracts: 0.21,
    sizeUsd: 13.475,
    isV2Authority: true,
    fullClose: true
  });
  assertNear(auth.selectedContracts, 0.19, 1e-8, "CASE C selected contracts");
  assertEqSource(auth.contractAuthoritySource, "okx_actual_contracts", "CASE C source");
}

// CASE D — sizeUsd margin must never produce 0.02 close for V2
{
  const auth = resolveV2CloseContractAuthority({
    symbol: "BTCUSDT",
    side: "long",
    closeKind: "full",
    okxActualContracts: null,
    okxActualAvailable: false,
    ledgerContracts: null,
    sizeUsd: 13.475,
    isV2Authority: true,
    fullClose: true
  });
  assertFalse(auth.submitAllowed, "CASE D blocked without actual");
  assertNear(auth.selectedContracts, 0, 1e-8, "CASE D zero contracts");
}

// CASE J — explicit full exit uses actual contracts
{
  const auth = resolveV2CloseContractAuthority({
    symbol: "BTCUSDT",
    side: "long",
    closeKind: "full",
    okxActualContracts: 0.19,
    okxActualAvailable: true,
    ledgerContracts: 0.21,
    isV2Authority: true,
    fullClose: true
  });
  assertNear(auth.selectedContracts, 0.19, 1e-8, "CASE J full exit actual");
}

// CASE K — partial 25% of actual 0.20 → 0.05
{
  const partial = resolveV2ReduceContracts({
    symbol: "BTCUSDT",
    side: "long",
    reduceRatio: 0.25,
    okxActualContracts: 0.2,
    okxActualAvailable: true,
    ledgerContracts: 0.21,
    isV2Authority: true
  });
  assertNear(partial.targetContracts, 0.05, 1e-8, "CASE K partial target");
}

// CASE L — actual zero blocks submit
{
  const auth = resolveV2CloseContractAuthority({
    symbol: "ETHUSDT",
    side: "long",
    closeKind: "full",
    okxActualContracts: 0,
    okxActualAvailable: true,
    ledgerContracts: 0.19,
    isV2Authority: true,
    fullClose: true
  });
  assertFalse(auth.submitAllowed, "CASE L no position");
}

console.log("v2-close-contract-authority-cases: ALL PASS");
