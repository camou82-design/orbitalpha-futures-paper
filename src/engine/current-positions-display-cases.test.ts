import {
  deriveCurrentPositionsForDisplay,
  deriveLedgerStalePositionsForDisplay,
  isAuthoritativeOkxPositionSnapshotForDisplay
} from "../lib/futuresPaperBundleCore";
import {
  hasBotOwnershipEvidenceOnLedgerRow,
  isLedgerOnlyStaleKey,
  isOkxOnlyKey,
  isTrueExternalManualClassification,
  resolveAuthoritativePaperOpenForSymbol,
  shouldBlockAutomatedManagementForSyncKey
} from "../lib/position-reconcile-classification";
import { buildLedgerOkxPositionSyncSnapshot } from "../exchange/okx-position-sync";
import { resolvePositionOwnership } from "../engine-v2/position/ownership-resolver";

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

function botLedger(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "BTCUSDT",
    side: "long",
    status: "open",
    entryPrice: 64000,
    sizeUsd: 50,
    openedAt: Date.now() - 3600_000,
    isV2Authority: true,
    exchangeClOrdId: "pabc123",
    lifecycleState: "BOT_V2_MANAGED",
    reconcileState: "MATCHED",
    ...overrides
  };
}

const authoritativeEngineBase = {
  position_source: "okx_actual",
  okx_signed_rest_ready: true,
  okx_positions_ok: true,
  okx_total_position_notional_usdt: 50,
  okx_position_parse_source: "m:imr|n:notionalUsd"
};

function syncFromPreviews(
  okx: ReadonlyArray<{ symbol: string; side: "long" | "short"; pos?: number }>,
  paper: ReadonlyArray<{ symbol: string; side: "long" | "short" }>
) {
  const okxPayload = okx.map((r) => ({
    instId: r.symbol.replace("USDT", "-USDT-SWAP"),
    posSide: r.side,
    pos: r.pos ?? 0.01,
    avgPx: r.symbol === "BTCUSDT" ? 64000 : 1900,
    notionalUsd: 50
  }));
  const paperOpens = paper.map((r) => ({
    symbol: r.symbol,
    side: r.side,
    status: "open" as const,
    entryPrice: r.symbol === "BTCUSDT" ? 64000 : 1900,
    sizeUsd: 50,
    isV2Authority: r.symbol === "BTCUSDT" && r.side === "long",
    exchangeClOrdId: r.symbol === "BTCUSDT" && r.side === "long" ? "pabc123" : undefined,
    lifecycleState: r.symbol === "BTCUSDT" && r.side === "long" ? "BOT_V2_MANAGED" : "OPEN"
  }));
  return buildLedgerOkxPositionSyncSnapshot(paperOpens, okxPayload);
}

function runCases(): void {
  // CASE A — OKX BTC long + ledger BTC long + ledger ETH long → BTC active, ETH stale
  {
    const sync = syncFromPreviews(
      [{ symbol: "BTCUSDT", side: "long" }],
      [
        { symbol: "BTCUSDT", side: "long" },
        { symbol: "ETHUSDT", side: "long" }
      ]
    );
    const engineState = {
      ...authoritativeEngineBase,
      ledger_okx_position_sync: sync
    };
    const ledgerOpen = [
      botLedger(),
      {
        symbol: "ETHUSDT",
        side: "long",
        status: "open",
        entryPrice: 1900,
        sizeUsd: 40,
        openedAt: Date.now() - 7200_000
      }
    ];
    assertTrue(isAuthoritativeOkxPositionSnapshotForDisplay(engineState), "CASE A authoritative");
    const active = deriveCurrentPositionsForDisplay(engineState, ledgerOpen);
    const stale = deriveLedgerStalePositionsForDisplay(engineState, ledgerOpen);
    assertEq(active.length, 1, "CASE A active count");
    assertEq((active[0] as any).symbol, "BTCUSDT", "CASE A active symbol");
    assertEq(stale.length, 1, "CASE A stale count");
    assertEq((stale[0] as any).symbol, "ETHUSDT", "CASE A stale symbol");
    assertFalse(active.some((r) => (r as any).symbol === "ETHUSDT"), "CASE A ETH excluded from active");
  }

  // CASE B — OKX BTC long + ledger BTC old short + ledger BTC current long
  {
    const sync = syncFromPreviews(
      [{ symbol: "BTCUSDT", side: "long" }],
      [
        { symbol: "BTCUSDT", side: "long" },
        { symbol: "BTCUSDT", side: "short" }
      ]
    );
    const engineState = { ...authoritativeEngineBase, ledger_okx_position_sync: sync };
    const ledgerOpen = [
      botLedger(),
      {
        symbol: "BTCUSDT",
        side: "short",
        status: "open",
        entryPrice: 65000,
        sizeUsd: 30,
        openedAt: Date.now() - 86400_000
      }
    ];
    const active = deriveCurrentPositionsForDisplay(engineState, ledgerOpen);
    const stale = deriveLedgerStalePositionsForDisplay(engineState, ledgerOpen);
    assertEq(active.length, 1, "CASE B active count");
    assertEq((active[0] as any).side, "long", "CASE B current long active");
    assertEq(stale.length, 1, "CASE B stale count");
    assertEq((stale[0] as any).side, "short", "CASE B old short stale");
    assertFalse(
      shouldBlockAutomatedManagementForSyncKey({
        key: "BTCUSDT:long",
        sync,
        paperOpens: ledgerOpen as any
      }),
      "CASE B long not manual block"
    );
    assertFalse(
      shouldBlockAutomatedManagementForSyncKey({
        key: "BTCUSDT:short",
        sync,
        paperOpens: ledgerOpen as any
      }),
      "CASE B stale short not manual block"
    );
  }

  // CASE C — bot reverse evidence on stale short, reconcile pending, automated management allowed
  {
    const sync = syncFromPreviews([{ symbol: "BTCUSDT", side: "long" }], [
      { symbol: "BTCUSDT", side: "long" },
      { symbol: "BTCUSDT", side: "short" }
    ]);
    const ledger = botLedger({
      okxContracts: 0.05,
      partialPendingClOrdId: "preduce123",
      lifecycleState: "ADDON_ACTIVE"
    });
    const staleShort = {
      symbol: "BTCUSDT",
      side: "short",
      status: "open",
      entryPrice: 65000,
      sizeUsd: 20,
      exchangeClOrdId: "poldshort",
      isV2Authority: true,
      lifecycleState: "BOT_V2_MANAGED"
    };
    const ownership = resolvePositionOwnership({
      symbol: "BTCUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.05,
      ledger: ledger as any,
      ledgerPaperContracts: 0.05,
      ledgerEntryPrice: 64000,
      okxAvgPx: 64000,
      symbolExternalManualBlocked: false,
      syncStatus: "KEY_MISMATCH"
    });
    assertFalse(ownership.automatedOrderMutationBlocked, "CASE C automated management allowed");
    assertEq(ownership.ownershipClass, "BOT_V2_MANAGED", "CASE C bot managed");
    assertTrue(isLedgerOnlyStaleKey("BTCUSDT:short", sync), "CASE C stale short classified");
    assertFalse(
      shouldBlockAutomatedManagementForSyncKey({
        key: "BTCUSDT:short",
        sync,
        paperOpens: [ledger, staleShort] as any
      }),
      "CASE C stale short not block"
    );
  }

  // CASE D — OKX position without bot ownership evidence → true external manual
  {
    const sync = syncFromPreviews([{ symbol: "BTCUSDT", side: "long" }], []);
    assertTrue(isOkxOnlyKey("BTCUSDT:long", sync), "CASE D okx only");
    assertTrue(
      isTrueExternalManualClassification({
        key: "BTCUSDT:long",
        sync,
        paperOpens: []
      }),
      "CASE D true external manual"
    );
    assertTrue(
      shouldBlockAutomatedManagementForSyncKey({
        key: "BTCUSDT:long",
        sync,
        paperOpens: []
      }),
      "CASE D block automated management"
    );
  }

  // CASE E — authoritative unavailable → do not mark ledger stale
  {
    const unavailableEngine = {
      position_source: "okx_actual",
      okx_signed_rest_ready: true,
      okx_positions_ok: false
    };
    const ledgerOpen = [botLedger()];
    assertFalse(isAuthoritativeOkxPositionSnapshotForDisplay(unavailableEngine), "CASE E not authoritative");
    const active = deriveCurrentPositionsForDisplay(unavailableEngine, ledgerOpen);
    const stale = deriveLedgerStalePositionsForDisplay(unavailableEngine, ledgerOpen);
    assertEq(active.length, 1, "CASE E ledger remains active display");
    assertEq(stale.length, 0, "CASE E no stale classification");
  }

  // Legacy — account-global empty still marks all ledger stale
  {
    const sync = buildLedgerOkxPositionSyncSnapshot(
      [{ symbol: "BTCUSDT", side: "short", status: "open", entryPrice: 64000, sizeUsd: 50 }],
      []
    );
    const engineState = {
      ...authoritativeEngineBase,
      okx_total_position_notional_usdt: 0,
      okx_position_parse_source: "no_open_positions",
      ledger_okx_position_sync: sync
    };
    const ledgerOpen = [{ symbol: "BTCUSDT", side: "short", status: "open", entryPrice: 64000, sizeUsd: 50 }];
    assertEq(deriveCurrentPositionsForDisplay(engineState, ledgerOpen).length, 0, "legacy empty active");
    assertEq(deriveLedgerStalePositionsForDisplay(engineState, ledgerOpen).length, 1, "legacy empty stale");
  }

  // resolveAuthoritativePaperOpenForSymbol prefers OKX side
  {
    const rows = [
      botLedger({ reconcileState: "MATCHED" }),
      { symbol: "BTCUSDT", side: "short", status: "open", reconcileState: "RECONCILE_MISMATCH" }
    ];
    const picked = resolveAuthoritativePaperOpenForSymbol(rows as any, "BTCUSDT", "long");
    assertEq(picked?.side, "long", "authoritative paper row side");
  }

  assertTrue(hasBotOwnershipEvidenceOnLedgerRow(botLedger()), "bot evidence helper");

  console.info(JSON.stringify({
    event: "CURRENT_POSITIONS_DISPLAY_CASES_PASS",
    cases: ["A", "B", "C", "D", "E", "legacy_global_empty", "authoritative_paper_row"]
  }));
}

runCases();
