import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PENDING_FILLED_NO_POSITION_GRACE_MS,
  PendingEntryReconcileCycleGuard,
  computePendingAgeMs,
  isAuthoritativePositionsSnapshot,
  pendingReconcileRunsBeforeEntryQueueGate,
  resolveFilledPendingNoPositionAction
} from "./paper-engine";

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  if (!value) throw new Error(`${label}: expected true`);
}

function loadProcessPaperSymbolEntriesBody(): string {
  const source = readFileSync(join(__dirname, "paper-engine.ts"), "utf8");
  const fnStart = source.indexOf("private async processPaperSymbolEntries(input: Readonly<{");
  if (fnStart < 0) throw new Error("processPaperSymbolEntries not found");
  return source.slice(fnStart);
}

function runCases(): void {
  const now = Date.now();

  // CASE A — entryQueue=[], filled ghost pending, authoritative empty positions, age > 120s → clear
  assertEq(
    resolveFilledPendingNoPositionAction({
      orderState: "filled",
      hasActualPosition: false,
      positionsSnapshotAuthoritative: true,
      pendingAgeMs: PENDING_FILLED_NO_POSITION_GRACE_MS + 1
    }),
    "clear_stale_filled_pending_no_actual_position",
    "CASE A stale ghost filled pending clears"
  );

  // CASE B — entryQueue=[], filled pending, age < 120s → keep
  assertEq(
    resolveFilledPendingNoPositionAction({
      orderState: "filled",
      hasActualPosition: false,
      positionsSnapshotAuthoritative: true,
      pendingAgeMs: 60_000
    }),
    "keep_pending_during_reconcile_grace",
    "CASE B young filled pending kept"
  );

  // CASE C — entryQueue=[], snapshot non-authoritative → keep
  assertEq(
    resolveFilledPendingNoPositionAction({
      orderState: "filled",
      hasActualPosition: false,
      positionsSnapshotAuthoritative: false,
      pendingAgeMs: PENDING_FILLED_NO_POSITION_GRACE_MS + 60_000
    }),
    "keep_pending_during_reconcile_grace",
    "CASE C non-authoritative snapshot keeps pending"
  );
  assertEq(
    isAuthoritativePositionsSnapshot({
      okxSignedRestReady: false,
      okxPositionsOk: true,
      lastLivePositionsPayload: []
    }),
    false,
    "CASE C snapshot authority false"
  );

  // CASE D — entryQueue empty path still runs reconcile before entry_queue_empty_return
  const entryBody = loadProcessPaperSymbolEntriesBody();
  assertTrue(
    pendingReconcileRunsBeforeEntryQueueGate(entryBody),
    "CASE D reconcile runs before entry queue early returns"
  );
  const reconcileIdx = entryBody.indexOf("await this.reconcilePendingEntryOrders(");
  const emptyReturnIdx = entryBody.indexOf('return_point: "entry_queue_empty_return"');
  assertTrue(reconcileIdx >= 0 && emptyReturnIdx > reconcileIdx, "CASE D reconcile precedes empty return");

  // CASE E — fresh tick barrier return also follows reconcile (barrier does not skip maintenance)
  const freshReturnIdx = entryBody.indexOf('return_point: "fresh_tick_barrier_return"');
  assertTrue(reconcileIdx >= 0 && freshReturnIdx > reconcileIdx, "CASE E reconcile precedes fresh tick return");

  // CASE F — filled + actual position → OPEN reconcile path (no stale clear)
  assertEq(
    resolveFilledPendingNoPositionAction({
      orderState: "filled",
      hasActualPosition: true,
      positionsSnapshotAuthoritative: true,
      pendingAgeMs: PENDING_FILLED_NO_POSITION_GRACE_MS + 999
    }),
    "reconcile_open",
    "CASE F filled with actual position opens ledger"
  );

  // cycle dedup — reconcile helper must not run twice in one runCycleId
  const guard = new PendingEntryReconcileCycleGuard();
  assertTrue(guard.tryBegin(42), "cycle guard first begin");
  assertEq(guard.tryBegin(42), false, "cycle guard duplicate blocked");
  assertTrue(guard.tryBegin(43), "cycle guard new cycle allowed");

  assertEq(
    computePendingAgeMs({ createdAt: now - 130_000 }, now),
    130_000,
    "CASE A age helper"
  );

  assertTrue(
    readFileSync(join(__dirname, "paper-engine.ts"), "utf8").includes("PENDING_ENTRY_RECONCILE_CYCLE_PROOF"),
    "reconcile helper emits cycle proof"
  );

  console.info(JSON.stringify({
    event: "PENDING_ENTRY_RECONCILE_CASES_PASS",
    cases: ["A", "B", "C", "D", "E", "F"],
    grace_ms: PENDING_FILLED_NO_POSITION_GRACE_MS
  }));
}

runCases();
