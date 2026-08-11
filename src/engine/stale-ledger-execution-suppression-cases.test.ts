import { evaluateStaleLedgerExecutionSuppression } from "../engine-v2/position/stale-ledger-execution-guard";

function assertTrue(v: boolean, label: string): void {
  if (!v) throw new Error(`${label}: expected true`);
}

function assertFalse(v: boolean, label: string): void {
  if (v) throw new Error(`${label}: expected false`);
}

function assertEq<T>(a: T, b: T, label: string): void {
  if (a !== b) throw new Error(`${label}: expected ${String(b)}, got ${String(a)}`);
}

// CASE G — ETH ledger open, OKX actual missing → suppress all execution
{
  const guard = evaluateStaleLedgerExecutionSuppression({
    symbol: "ETHUSDT",
    side: "long",
    authoritativePositionsReady: true,
    actualKeyExists: false,
    ledgerKeyExists: true
  });
  assertTrue(guard.suppressed, "CASE G suppressed");
  assertEq(guard.reconcileState, "ENGINE_LEDGER_STALE", "CASE G stale state");
  assertTrue(guard.suppressedActions.includes("take_profit_close"), "CASE G tp suppressed");
  assertTrue(guard.suppressedActions.includes("signed_order_submit"), "CASE G submit suppressed");
}

// active key not suppressed
{
  const guard = evaluateStaleLedgerExecutionSuppression({
    symbol: "BTCUSDT",
    side: "long",
    authoritativePositionsReady: true,
    actualKeyExists: true,
    ledgerKeyExists: true
  });
  assertFalse(guard.suppressed, "active not suppressed");
}

console.log("stale-ledger-execution-suppression-cases: ALL PASS");
