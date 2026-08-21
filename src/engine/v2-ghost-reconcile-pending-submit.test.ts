import {
  shouldSuppressUntrackedGhostAdoption,
  materializeV2ManagedOpenFromPostFillEvidence,
  isPendingEligibleForV2PostFillEvidence,
  buildPositionSideKey
} from "../engine-v2/position/v2-post-fill-ownership";
import type { PaperOpenPositionRecord, PendingEntryOrderRecord } from "../models/types";

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  if (!value) throw new Error(`${label}: expected true`);
}

function assertFalse(value: boolean, label: string): void {
  if (value) throw new Error(`${label}: expected false`);
}

function makeValidBotSnapshot(symbol: string, side: "long" | "short"): PaperOpenPositionRecord {
  return {
    openedAt: Date.now() - 5_000,
    symbol,
    side,
    entryPrice: 2500,
    leverage: 10,
    sizeUsd: 335,
    initialSizeUsd: 335,
    isV2Authority: true,
    pos: 0.134,
    baseQty: 0.134,
    okxContracts: 1.34,
    notionalUsd: 335,
    avgPx: 2500,
    notional: 335,
    lifecycleState: "BOT_V2_MANAGED",
    reconcileState: "PENDING",
    isProtectiveStopRegistered: true,
    isTakeProfitRegistered: false,
    isProtectionFailed: false,
    exchangeOrdId: "ord-eth-short-1",
    exchangeClOrdId: "pETHUSDTShort1",
    stopPrice: 2600,
    strategyVersion: "paper-v2",
    sourceSignal: "v2_trend_breakout",
    sourceRunPath: "runs/paper-v2",
    status: "open"
  };
}

function runTests(): void {
  const now = Date.now();
  const ethKey = buildPositionSideKey("ETHUSDT", "short");

  // CASE 1: V2 + valid snapshot + ENTRY_SUBMIT_PENDING (Limit Entry Submitted)
  const submitPendingOrder: PendingEntryOrderRecord = {
    symbol: "ETHUSDT",
    side: "short",
    ordId: "ord-eth-short-1",
    clOrdId: "pETHUSDTShort1",
    instId: "ETH-USDT-SWAP",
    authority_source: "v2",
    intended_notional_usdt: 335,
    stopPrice: 2600,
    createdAt: now - 3_000,
    status: "ENTRY_ORDER_PENDING",
    entryPendingState: "ENTRY_SUBMIT_PENDING",
    paperRecordSnapshot: makeValidBotSnapshot("ETHUSDT", "short"),
    authoritySnapshot: { source: "v2", side: "short", decision: "ENTER" },
    openTraceId: "trace-eth-submit"
  };

  assertTrue(
    isPendingEligibleForV2PostFillEvidence(submitPendingOrder),
    "CASE 1: isPendingEligibleForV2PostFillEvidence allows ENTRY_SUBMIT_PENDING"
  );

  const suppressResult1 = shouldSuppressUntrackedGhostAdoption({
    key: ethKey,
    pendingOrders: [submitPendingOrder],
    persistedOpens: [],
    recentFillRegistry: new Map(),
    nowMs: now
  });

  assertTrue(suppressResult1.suppress, "CASE 1: shouldSuppressUntrackedGhostAdoption.suppress === true");
  assertTrue(suppressResult1.evidence != null, "CASE 1: evidence is present");
  assertEq(suppressResult1.evidence?.source, "pending_fill", "CASE 1: evidence source is pending_fill");

  const remoteEthShort = {
    avgPx: 2500,
    contracts: 1.34,
    baseQty: 0.134,
    notionalUsd: 335,
    marginUsd: 33.5,
    leverage: 10,
    instId: "ETH-USDT-SWAP"
  };

  const materialized = materializeV2ManagedOpenFromPostFillEvidence(
    suppressResult1.evidence!,
    remoteEthShort,
    now
  );

  assertTrue(materialized != null, "CASE 1: materialized record is not null");
  assertEq(materialized?.lifecycleState, "BOT_V2_MANAGED", "CASE 1: lifecycle is BOT_V2_MANAGED");
  assertEq(materialized?.reconcileState, "MATCHED", "CASE 1: reconcileState is MATCHED");
  assertEq(materialized?.symbol, "ETHUSDT", "CASE 1: symbol is ETHUSDT");
  assertEq(materialized?.side, "short", "CASE 1: side is short");
  assertEq(materialized?.okxContracts, 1.34, "CASE 1: okxContracts is 1.34");
  assertEq(materialized?.baseQty, 0.134, "CASE 1: baseQty is 0.134");

  // CASE 2: V2 + valid snapshot + ENTRY_FILL_RECONCILING (existing path)
  const fillReconcilingPendingOrder: PendingEntryOrderRecord = {
    ...submitPendingOrder,
    entryPendingState: "ENTRY_FILL_RECONCILING",
    openTraceId: "trace-eth-reconciling"
  };

  assertTrue(
    isPendingEligibleForV2PostFillEvidence(fillReconcilingPendingOrder),
    "CASE 2: isPendingEligibleForV2PostFillEvidence allows ENTRY_FILL_RECONCILING"
  );

  const suppressResult2 = shouldSuppressUntrackedGhostAdoption({
    key: ethKey,
    pendingOrders: [fillReconcilingPendingOrder],
    persistedOpens: [],
    recentFillRegistry: new Map(),
    nowMs: now
  });

  assertTrue(suppressResult2.suppress, "CASE 2: ENTRY_FILL_RECONCILING suppress === true");

  // CASE 3: external / non-V2 pending (must NOT suppress)
  const externalPendingOrder: PendingEntryOrderRecord = {
    ...submitPendingOrder,
    authority_source: "manual",
    clOrdId: "mETHUSDTManual",
    authoritySnapshot: null as any,
    openTraceId: "trace-manual"
  };

  assertFalse(
    isPendingEligibleForV2PostFillEvidence(externalPendingOrder),
    "CASE 3: external pending is NOT eligible"
  );

  const suppressResult3 = shouldSuppressUntrackedGhostAdoption({
    key: ethKey,
    pendingOrders: [externalPendingOrder],
    persistedOpens: [],
    recentFillRegistry: new Map(),
    nowMs: now
  });

  assertFalse(suppressResult3.suppress, "CASE 3: external pending suppress === false");

  // CASE 4: snapshot null (fail-closed in this patch)
  const nullSnapshotPendingOrder: PendingEntryOrderRecord = {
    ...submitPendingOrder,
    paperRecordSnapshot: null
  };

  assertFalse(
    isPendingEligibleForV2PostFillEvidence(nullSnapshotPendingOrder),
    "CASE 4: null snapshot pending is NOT eligible (fail-closed)"
  );

  const suppressResult4 = shouldSuppressUntrackedGhostAdoption({
    key: ethKey,
    pendingOrders: [nullSnapshotPendingOrder],
    persistedOpens: [],
    recentFillRegistry: new Map(),
    nowMs: now
  });

  assertFalse(suppressResult4.suppress, "CASE 4: null snapshot suppress === false");

  // CASE 5: invalid / null entryPendingState (fail-closed)
  const invalidStatePendingOrder: PendingEntryOrderRecord = {
    ...submitPendingOrder,
    entryPendingState: undefined
  };

  assertFalse(
    isPendingEligibleForV2PostFillEvidence(invalidStatePendingOrder),
    "CASE 5: null/undefined entryPendingState is NOT eligible"
  );

  console.info(JSON.stringify({
    event: "V2_GHOST_RECONCILE_PENDING_SUBMIT_PASS",
    cases: [
      "ENTRY_SUBMIT_PENDING_SUPPRESS_TRUE",
      "MATERIALIZE_BOT_V2_MANAGED",
      "ENTRY_FILL_RECONCILING_STILL_PASS",
      "EXTERNAL_NON_V2_SUPPRESS_FALSE",
      "SNAPSHOT_NULL_FAIL_CLOSED",
      "NULL_STATE_FAIL_CLOSED"
    ]
  }));
}

runTests();
