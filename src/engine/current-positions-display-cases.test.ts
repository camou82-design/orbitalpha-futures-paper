import {
  deriveCurrentPositionsForDisplay,
  deriveLedgerStalePositionsForDisplay,
  isAuthoritativeOkxPositionSnapshotForDisplay,
  okxActualPositionsEmptyForDisplay
} from "../lib/futuresPaperBundleCore";

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

const staleEngineState = {
  position_source: "okx_actual",
  okx_signed_rest_ready: true,
  okx_positions_ok: true,
  okx_total_position_notional_usdt: 0,
  okx_position_parse_source: "no_open_positions",
  ledger_okx_position_sync: {
    sync_status: "LEDGER_ONLY",
    okx_positions_preview: [],
    paper_positions_preview: [{ symbol: "BTCUSDT", side: "short" }]
  }
};

const ledgerOpen = [
  {
    symbol: "BTCUSDT",
    side: "short",
    status: "open",
    entryPrice: 64000,
    sizeUsd: 50,
    openedAt: Date.now() - 3600_000
  }
];

function runCases(): void {
  assertTrue(isAuthoritativeOkxPositionSnapshotForDisplay(staleEngineState), "authoritative snapshot");
  assertTrue(okxActualPositionsEmptyForDisplay(staleEngineState), "okx empty");

  const active = deriveCurrentPositionsForDisplay(staleEngineState, ledgerOpen);
  assertEq(active.length, 0, "CASE stale ledger not active");

  const stale = deriveLedgerStalePositionsForDisplay(staleEngineState, ledgerOpen);
  assertEq(stale.length, 1, "CASE stale ledger surfaced");
  assertEq((stale[0] as any).status, "ledger_stale_reconcile", "CASE stale status");
  assertEq((stale[0] as any).displaySource, "paper_ledger_stale", "CASE stale displaySource");
  assertFalse((stale[0] as any).isActivePosition, "CASE not active position");

  const alignedEngineState = {
    ...staleEngineState,
    okx_total_position_notional_usdt: 50,
    okx_position_parse_source: "m:imr|n:notionalUsd",
    ledger_okx_position_sync: {
      sync_status: "ALIGNED",
      okx_positions_preview: [{ symbol: "BTCUSDT", side: "short", pos: 0.06 }],
      paper_positions_preview: [{ symbol: "BTCUSDT", side: "short" }]
    }
  };
  const alignedActive = deriveCurrentPositionsForDisplay(alignedEngineState, ledgerOpen);
  assertEq(alignedActive.length, 1, "CASE aligned ledger remains active display");

  console.info(JSON.stringify({
    event: "CURRENT_POSITIONS_DISPLAY_CASES_PASS",
    cases: ["stale_ledger_hidden", "stale_reconcile_row", "aligned_ledger_active"]
  }));
}

runCases();
