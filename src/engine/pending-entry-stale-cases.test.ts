import {
  PENDING_FILLED_NO_POSITION_GRACE_MS,
  computePendingAgeMs,
  isAuthoritativePositionsSnapshot,
  resolveFilledPendingNoPositionAction,
  resolveStaleEntryCancelPrecheckAction
} from "./paper-engine";

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function runCases(): void {
  // CASE A — filled + actual position → ledger OPEN path (not stale clear)
  assertEq(
    resolveFilledPendingNoPositionAction({
      orderState: "filled",
      hasActualPosition: true,
      positionsSnapshotAuthoritative: true,
      pendingAgeMs: 999_999
    }),
    "reconcile_open",
    "CASE A"
  );

  // CASE B — filled + no position + age < grace → keep
  assertEq(
    resolveFilledPendingNoPositionAction({
      orderState: "filled",
      hasActualPosition: false,
      positionsSnapshotAuthoritative: true,
      pendingAgeMs: 60_000
    }),
    "keep_pending_during_reconcile_grace",
    "CASE B"
  );

  // CASE C — filled + no position + age >= grace + authoritative → clear
  assertEq(
    resolveFilledPendingNoPositionAction({
      orderState: "filled",
      hasActualPosition: false,
      positionsSnapshotAuthoritative: true,
      pendingAgeMs: PENDING_FILLED_NO_POSITION_GRACE_MS
    }),
    "clear_stale_filled_pending_no_actual_position",
    "CASE C"
  );

  // CASE D — filled + no position + age >= grace + non-authoritative → keep
  assertEq(
    resolveFilledPendingNoPositionAction({
      orderState: "filled",
      hasActualPosition: false,
      positionsSnapshotAuthoritative: false,
      pendingAgeMs: PENDING_FILLED_NO_POSITION_GRACE_MS + 1
    }),
    "keep_pending_during_reconcile_grace",
    "CASE D"
  );

  // CASE E — filled terminal order → defer reconcile, no cancel
  assertEq(
    resolveStaleEntryCancelPrecheckAction("filled"),
    "defer_filled_reconcile",
    "CASE E"
  );

  // CASE F — open/live order → attempt cancel
  assertEq(
    resolveStaleEntryCancelPrecheckAction("live"),
    "attempt_cancel",
    "CASE F live"
  );
  assertEq(
    resolveStaleEntryCancelPrecheckAction("partially_filled"),
    "attempt_cancel",
    "CASE F partially_filled"
  );

  // terminal canceled clears without cancel API
  assertEq(
    resolveStaleEntryCancelPrecheckAction("canceled"),
    "clear_terminal",
    "terminal canceled"
  );

  assertEq(
    isAuthoritativePositionsSnapshot({
      okxSignedRestReady: true,
      okxPositionsOk: true,
      lastLivePositionsPayload: []
    }),
    true,
    "authoritative snapshot"
  );
  assertEq(
    isAuthoritativePositionsSnapshot({
      okxSignedRestReady: false,
      okxPositionsOk: true,
      lastLivePositionsPayload: []
    }),
    false,
    "non-authoritative snapshot"
  );

  const now = Date.now();
  assertEq(
    computePendingAgeMs({ createdAt: now - 90_000, submittedAt: now - 30_000 }, now),
    30_000,
    "pending age prefers submittedAt"
  );
  assertEq(
    computePendingAgeMs({ createdAt: now - 90_000 }, now),
    90_000,
    "pending age falls back to createdAt"
  );

  console.info(JSON.stringify({
    event: "PENDING_ENTRY_STALE_CASES_PASS",
    cases: ["A", "B", "C", "D", "E", "F"],
    grace_ms: PENDING_FILLED_NO_POSITION_GRACE_MS
  }));
}

runCases();
