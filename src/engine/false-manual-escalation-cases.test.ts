import { buildLedgerOkxPositionSyncSnapshot } from "../exchange/okx-position-sync";
import {
  shouldBlockAutomatedManagementForSyncKey,
  shouldTreatSyncStatusAsManualPartial,
  resolveBtcPositionManagementSuppressor,
  hasBotOwnershipEvidenceOnLedgerRow,
  isLedgerOnlyStaleKey,
  isTrueExternalManualClassification,
  classifyLedgerOpenRowsForDisplay,
  isAuthoritativeOkxPositionSnapshotForDisplay
} from "../lib/position-reconcile-classification";
import { deriveCurrentPositionsForDisplay, deriveLedgerStalePositionsForDisplay } from "../lib/futuresPaperBundleCore";
import { resolvePositionOwnership } from "../engine-v2/position/ownership-resolver";

function assertTrue(v: boolean, label: string): void {
  if (!v) throw new Error(`${label}: expected true`);
}

function assertFalse(v: boolean, label: string): void {
  if (v) throw new Error(`${label}: expected false`);
}

function assertEq<T>(a: T, b: T, label: string): void {
  if (a !== b) throw new Error(`${label}: expected ${String(b)}, got ${String(a)}`);
}

function botBtc(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "BTCUSDT",
    side: "long",
    status: "open",
    entryPrice: 64000,
    sizeUsd: 50,
    baseQty: 0.00017,
    okxContracts: 0.17,
    isV2Authority: true,
    exchangeClOrdId: "pbtc001",
    lifecycleState: "BOT_V2_MANAGED",
    reconcileState: "ADOPTED",
    ...overrides
  };
}

function okxPayload(rows: Array<{ symbol: string; side: "long" | "short"; pos: number; avgPx?: number }>) {
  return rows.map((r) => ({
    instId: r.symbol.replace("USDT", "-USDT-SWAP"),
    posSide: r.side,
    pos: r.pos,
    avgPx: r.avgPx ?? (r.symbol === "BTCUSDT" ? 64000 : 1900),
    notionalUsd: 50
  }));
}

function instMap() {
  return new Map([["BTC-USDT-SWAP", { ctVal: 0.01, ctValCcy: "BTC" }], ["ETH-USDT-SWAP", { ctVal: 0.1, ctValCcy: "ETH" }]]);
}

function runCases(): void {
  // CASE A — OKX 0.19ct vs ledger 0.17ct bot-owned → size reconcile pending, manual=false
  {
    const ledger = botBtc({ okxContracts: 0.17, baseQty: 0.00017 });
    const sync = buildLedgerOkxPositionSyncSnapshot(
      [ledger],
      okxPayload([{ symbol: "BTCUSDT", side: "long", pos: 0.19 }]),
      instMap()
    );
    assertEq(sync.sync_status, "BOT_POSITION_SIZE_RECONCILE_PENDING", "CASE A sync status");
    assertFalse(
      shouldBlockAutomatedManagementForSyncKey({
        key: "BTCUSDT:long",
        sync,
        paperOpens: [ledger]
      }),
      "CASE A manual block false"
    );
    assertFalse(
      shouldTreatSyncStatusAsManualPartial({
        syncStatus: sync.sync_status,
        key: "BTCUSDT:long",
        sync,
        paperRow: ledger
      }),
      "CASE A not manual partial"
    );
    const ownership = resolvePositionOwnership({
      symbol: "BTCUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.19,
      ledger: ledger as any,
      ledgerPaperContracts: 0.17,
      ledgerEntryPrice: 64000,
      okxAvgPx: 64000,
      symbolExternalManualBlocked: false,
      syncStatus: sync.sync_status
    });
    assertFalse(ownership.automatedOrderMutationBlocked, "CASE A automated management allowed");
  }

  // CASE B — BTC aligned sides → suppressor false
  {
    const suppressor = resolveBtcPositionManagementSuppressor({
      okxActualSide: "long",
      paperSide: "long",
      v2InferredSide: "long",
      reconcileState: "ADOPTED",
      externalManualBlockedForSide: true,
      botOwnershipEvidence: true,
      positiveExternalManualEvidence: false,
      closeOnlyMode: false,
      killSwitch: false
    });
    assertTrue(suppressor.sides_aligned, "CASE B sides aligned");
    assertTrue(suppressor.false_manual_block_ignored, "CASE B false manual ignored");
    assertFalse(suppressor.existing_position_management_blocked, "CASE B suppressor false");
    assertTrue(suppressor.protective_ensure_allowed, "CASE B protective allowed");
  }

  // CASE C — ETH ledger-only → ENGINE_LEDGER_STALE, manual=false
  {
    const ethLedger = {
      symbol: "ETHUSDT",
      side: "long",
      status: "open",
      entryPrice: 1900,
      sizeUsd: 40,
      reconcileState: "ADOPTED",
      lifecycleState: "EXTERNAL_MANUAL_POSITION"
    };
    const sync = buildLedgerOkxPositionSyncSnapshot(
      [ethLedger, botBtc()],
      okxPayload([{ symbol: "BTCUSDT", side: "long", pos: 0.19 }]),
      instMap()
    );
    assertTrue(isLedgerOnlyStaleKey("ETHUSDT:long", sync), "CASE C eth stale key");
    assertFalse(
      shouldBlockAutomatedManagementForSyncKey({
        key: "ETHUSDT:long",
        sync,
        paperOpens: [ethLedger, botBtc()]
      }),
      "CASE C eth manual block false"
    );
    assertFalse(
      shouldTreatSyncStatusAsManualPartial({
        syncStatus: "ADOPTED_POSITION_MANUAL_PARTIAL_DETECTED",
        key: "ETHUSDT:long",
        sync,
        paperRow: ethLedger
      }),
      "CASE C eth not manual partial without actual"
    );
    const engineState = {
      position_source: "okx_actual",
      okx_signed_rest_ready: true,
      okx_positions_ok: true,
      ledger_okx_position_sync: sync
    };
    const active = deriveCurrentPositionsForDisplay(engineState, [ethLedger, botBtc()]);
    assertFalse(active.some((r) => (r as any).symbol === "ETHUSDT"), "CASE C eth excluded from active");
    assertEq(deriveLedgerStalePositionsForDisplay(engineState, [ethLedger, botBtc()]).length, 1, "CASE C stale row");
  }

  // CASE D — bot partial reduce pending, OKX < ledger contracts
  {
    const ledger = botBtc({
      okxContracts: 0.17,
      baseQty: 0.00017,
      partialPendingClOrdId: "preduce001",
      lifecycleState: "PARTIAL_PENDING"
    });
    const sync = buildLedgerOkxPositionSyncSnapshot(
      [ledger],
      okxPayload([{ symbol: "BTCUSDT", side: "long", pos: 0.12 }]),
      instMap()
    );
    assertFalse(
      shouldBlockAutomatedManagementForSyncKey({ key: "BTCUSDT:long", sync, paperOpens: [ledger] }),
      "CASE D manual false"
    );
    assertTrue(hasBotOwnershipEvidenceOnLedgerRow(ledger), "CASE D bot evidence");
  }

  // CASE E — true external OKX-only without bot evidence
  {
    const sync = buildLedgerOkxPositionSyncSnapshot([], okxPayload([{ symbol: "BTCUSDT", side: "long", pos: 0.2 }]));
    assertTrue(
      isTrueExternalManualClassification({ key: "BTCUSDT:long", sync, paperOpens: [] }),
      "CASE E true external manual"
    );
    assertTrue(
      shouldBlockAutomatedManagementForSyncKey({ key: "BTCUSDT:long", sync, paperOpens: [] }),
      "CASE E block allowed"
    );
  }

  // CASE F — prior false manual block ignored when aligned + bot evidence
  {
    const ledger = botBtc({ lifecycleState: "EXTERNAL_MANUAL_POSITION" });
    assertTrue(hasBotOwnershipEvidenceOnLedgerRow(ledger), "CASE F bot evidence despite external lifecycle");
    const suppressor = resolveBtcPositionManagementSuppressor({
      okxActualSide: "long",
      paperSide: "long",
      v2InferredSide: "long",
      reconcileState: "ADOPTED",
      externalManualBlockedForSide: true,
      botOwnershipEvidence: true,
      positiveExternalManualEvidence: false,
      closeOnlyMode: false,
      killSwitch: false
    });
    assertFalse(suppressor.effective_external_manual_blocked, "CASE F latch/block cleared logically");
    assertTrue(suppressor.protective_ensure_allowed, "CASE F protective allowed");
  }

  // CASE G — authoritative unavailable → no stale/manual escalation
  {
    const unavailable = {
      position_source: "okx_actual",
      okx_signed_rest_ready: true,
      okx_positions_ok: false
    };
    assertFalse(isAuthoritativeOkxPositionSnapshotForDisplay(unavailable), "CASE G unavailable");
    const rows = classifyLedgerOpenRowsForDisplay(unavailable, [botBtc()]);
    assertEq(rows.stale.length, 0, "CASE G no stale");
    assertEq(rows.active.length, 1, "CASE G active preserved");
  }

  console.info(JSON.stringify({
    event: "FALSE_MANUAL_ESCALATION_CASES_PASS",
    cases: ["A", "B", "C", "D", "E", "F", "G"]
  }));
}

runCases();
