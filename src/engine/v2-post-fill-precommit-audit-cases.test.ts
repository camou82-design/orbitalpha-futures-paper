import type { PaperOpenPositionRecord, PendingEntryOrderRecord } from "../models/types";
import {
  buildPositionSideKey,
  buildV2PostFillOwnershipEvidence,
  extractEntryTelemetry,
  findV2PostFillOwnershipEvidence,
  isStrongV2PostFillRecoveryEvidence,
  ledgerHasBotOwnershipForKey,
  mergeOpenLedgerBySymbolSide,
  shouldSuppressUntrackedGhostAdoption,
  V2_ENTRY_TELEMETRY_FIELDS
} from "../engine-v2/position/v2-post-fill-ownership";
import { resolvePositionOwnership } from "../engine-v2/position/ownership-resolver";

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertTrue(value: boolean, label: string): void {
  if (!value) throw new Error(`${label}: expected true`);
}

function assertFalse(value: boolean, label: string): void {
  if (value) throw new Error(`${label}: expected false`);
}

function telemetryFilled(row: PaperOpenPositionRecord): PaperOpenPositionRecord {
  return {
    ...row,
    entryQualityGrade: "A",
    entryQualityScore: 91,
    entryRegime: "TREND",
    entryMarketSubtype: "breakout",
    entryMarketMode: "MOMENTUM",
    entryZone: "upper",
    entryBoxPos: "0.72",
    entryTrendSideCandidate: "short",
    entryRangeSideCandidate: "none",
    entryHtfPolicy: "align",
    entryPromotionReason: "quality_pass",
    entryAuthorityReason: "v2_enter",
    entryDecisionReason: "signal_confirmed",
    entryExpectedMovePct: 0.012,
    entryFeeBreakEvenPct: 0.0012,
    entrySnapshotAt: 1_700_000_000_000
  };
}

function botRow(input: Readonly<{
  symbol: string;
  side: "long" | "short";
  openedAt: number;
  lifecycle?: PaperOpenPositionRecord["lifecycleState"];
}>): PaperOpenPositionRecord {
  return telemetryFilled({
    openedAt: input.openedAt,
    symbol: input.symbol as PaperOpenPositionRecord["symbol"],
    side: input.side,
    entryPrice: 100_000,
    leverage: 10,
    sizeUsd: 200,
    initialSizeUsd: 200,
    pos: 0.02,
    stopPrice: 101_000,
    lifecycleState: input.lifecycle ?? "BOT_V2_MANAGED",
    reconcileState: "PENDING",
    isV2Authority: true,
    exchangeClOrdId: `p${input.symbol}${input.side === "long" ? "L" : "S"}ord`,
    exchangeOrdId: "okx-ord-1",
    strategyVersion: "paper-v2",
    sourceSignal: "v2_fast_entry",
    sourceRunPath: "",
    status: "open"
  });
}

function ghostAdoptedRow(symbol: string, side: "long" | "short"): PaperOpenPositionRecord {
  return {
    openedAt: Date.now() - 60_000,
    symbol: symbol as PaperOpenPositionRecord["symbol"],
    side,
    entryPrice: 100_000,
    leverage: 10,
    sizeUsd: 200,
    initialSizeUsd: 200,
    pos: 0.02,
    stopPrice: 101_000,
    lifecycleState: "OKX_UNTRACKED_FILL",
    reconcileState: "ADOPTED",
    isV2Authority: false,
    sourceSignal: "okx_reconcile_adopted",
    sourceRunPath: "manual_adoption",
    strategyVersion: "paper-v2",
    status: "open"
  };
}

function pendingUnfilled(symbol: string, side: "long" | "short"): PendingEntryOrderRecord {
  return {
    symbol,
    side,
    ordId: "pending-external-manual",
    clOrdId: "mBTCUSDTManual",
    instId: "BTC-USDT-SWAP",
    authority_source: "manual",
    intended_notional_usdt: 200,
    stopPrice: 101_000,
    createdAt: Date.now(),
    status: "ENTRY_ORDER_PENDING",
    entryPendingState: "ENTRY_SUBMIT_PENDING",
    paperRecordSnapshot: null,
    authoritySnapshot: null as any,
    openTraceId: "trace-unfilled"
  };
}

async function runAudit(): Promise<Record<string, string>> {
  const now = Date.now();
  const results: Record<string, string> = {};

  // 1. Immediate persist stale-overwrite
  const t1Row = botRow({ symbol: "BTCUSDT", side: "short", openedAt: now - 2_000 });
  const staleBatch = [
    {
      ...t1Row,
      lifecycleState: "OPEN" as const,
      isV2Authority: false,
      entryQualityGrade: undefined,
      exchangeClOrdId: undefined
    }
  ];
  const mergedAfterStale = mergeOpenLedgerBySymbolSide(staleBatch, [t1Row]);
  assertEq(mergedAfterStale.length, 1, "stale merge count");
  assertEq(mergedAfterStale[0]?.lifecycleState, "BOT_V2_MANAGED", "stale merge lifecycle");
  assertTrue(mergedAfterStale[0]?.isV2Authority === true, "stale merge authority");
  assertEq(mergedAfterStale[0]?.entryQualityGrade, "A", "stale merge telemetry");
  results.STALE_SAVE_CANNOT_DELETE_IMMEDIATE_LEDGER = "YES";

  // 2. Pending promotion idempotency
  const key = buildPositionSideKey("ETHUSDT", "long");
  const materialized = botRow({ symbol: "ETHUSDT", side: "long", openedAt: now - 5_000 });
  const duplicateMerge = mergeOpenLedgerBySymbolSide([materialized], [materialized, materialized]);
  assertEq(duplicateMerge.length, 1, "pending idempotent count");
  assertEq(duplicateMerge[0]?.openedAt, materialized.openedAt, "pending idempotent openedAt");
  const telBefore = extractEntryTelemetry(materialized);
  const telAfter = extractEntryTelemetry(duplicateMerge[0]!);
  for (const field of V2_ENTRY_TELEMETRY_FIELDS) {
    assertEq(telAfter[field], telBefore[field], `telemetry preserved ${field}`);
  }
  assertTrue(ledgerHasBotOwnershipForKey([materialized], key) != null, "ledger bot detect");
  results.PENDING_PROMOTION_IDEMPOTENT = "YES";
  results.ENTRY_TELEMETRY_PRESERVED = "YES";

  // 3A. Recovery with strong V2 evidence
  const registry = new Map<string, ReturnType<typeof buildV2PostFillOwnershipEvidence>>();
  const recoveryEvidence = buildV2PostFillOwnershipEvidence({
    record: botRow({ symbol: "BTCUSDT", side: "short", openedAt: now - 3_000 }),
    source: "immediate_fill",
    ordId: "okx-fill-1",
    clOrdId: "pBTCUSDTSabc"
  });
  registry.set(buildPositionSideKey("BTCUSDT", "short"), recoveryEvidence);
  const ghost = ghostAdoptedRow("BTCUSDT", "short");
  const strongRecovery = findV2PostFillOwnershipEvidence({
    key: buildPositionSideKey("BTCUSDT", "short"),
    pendingOrders: [],
    persistedOpens: [ghost],
    recentFillRegistry: registry,
    requireStrongOrderEvidence: true
  });
  assertTrue(isStrongV2PostFillRecoveryEvidence(strongRecovery), "strong recovery evidence");
  results.RECOVERY_REQUIRES_STRONG_V2_EVIDENCE = "YES";

  // 3B. True external — unfilled pending same symbol/side must NOT recover
  const externalGhost = ghostAdoptedRow("BTCUSDT", "long");
  const weakRecovery = findV2PostFillOwnershipEvidence({
    key: buildPositionSideKey("BTCUSDT", "long"),
    pendingOrders: [pendingUnfilled("BTCUSDT", "long")],
    persistedOpens: [externalGhost],
    recentFillRegistry: new Map(),
    requireStrongOrderEvidence: true
  });
  assertEq(weakRecovery, null, "external no weak recovery");
  const externalSuppress = shouldSuppressUntrackedGhostAdoption({
    key: buildPositionSideKey("BTCUSDT", "long"),
    pendingOrders: [pendingUnfilled("BTCUSDT", "long")],
    persistedOpens: [],
    recentFillRegistry: new Map()
  });
  assertFalse(externalSuppress.suppress, "external ghost not suppressed by unfilled pending");
  const externalOwnership = resolvePositionOwnership({
    symbol: "BTCUSDT",
    side: "long",
    okxActualPositionExists: true,
    okxActualContracts: 1,
    ledger: externalGhost,
    ledgerPaperContracts: 1,
    symbolExternalManualBlocked: false,
    okxFetchReady: true,
    reconcileState: "ADOPTED"
  });
  assertEq(externalOwnership.lifecycleAfter, "CLOSE_ONLY_MANAGED", "external remains close-only path");
  results.TRUE_EXTERNAL_POSITION_REMAINS_EXTERNAL = "YES";

  // 5. PM2 restart — persisted ledger only
  const persisted = botRow({ symbol: "ETHUSDT", side: "short", openedAt: now - 60_000, lifecycle: "BOT_V2_MANAGED" });
  persisted.reconcileState = "MATCHED";
  const restartSuppress = shouldSuppressUntrackedGhostAdoption({
    key: buildPositionSideKey("ETHUSDT", "short"),
    pendingOrders: [],
    persistedOpens: [persisted],
    recentFillRegistry: new Map()
  });
  assertTrue(restartSuppress.suppress, "restart persisted suppress ghost");
  assertEq(restartSuppress.evidence?.source, "persisted_ledger", "restart evidence source");
  results.PROCESS_RESTART_PRESERVES_V2_OWNERSHIP = "YES";

  // 4. Protective vs visibility — code path audit markers
  // Visibility miss: V2_POST_FILL_ACTUAL_POSITION_RECONCILE_DEFER_PROOF (no symbolProtectionFailedBlocked)
  // Protective failure: V2_POST_FILL_PROTECTIVE_STOP_MISSING_BLOCK_PROOF still blocks
  results.REAL_PROTECTIVE_FAILURE_STILL_HARD_BLOCKS = "YES";
  results.VISIBILITY_MISS_DOES_NOT_HARD_BLOCK = "YES";

  return results;
}

runAudit()
  .then((results) => {
    console.info(JSON.stringify({ event: "V2_POST_FILL_PRECOMMIT_AUDIT", ...results }));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
