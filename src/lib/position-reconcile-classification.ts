import type { LedgerOkxPositionSyncSnapshot } from "../exchange/okx-position-sync";

export type PositionSide = "long" | "short";

export type LedgerReconcileDisplayState =
  | "ledger_stale_reconcile"
  | "engine_ledger_stale"
  | "engine_reconcile_pending"
  | "true_external_manual";

export function normalizePositionSide(raw: unknown): PositionSide {
  return String(raw ?? "").toLowerCase() === "short" ? "short" : "long";
}

export function ledgerPositionKey(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const sym = String(r.symbol ?? "").trim();
  if (!sym) return null;
  return `${sym}:${normalizePositionSide(r.side)}`;
}

export function isAuthoritativeOkxPositionSnapshotForDisplay(engineState: unknown): boolean {
  if (!engineState || typeof engineState !== "object") return false;
  const es = engineState as Record<string, unknown>;
  return (
    es.position_source === "okx_actual" &&
    es.okx_signed_rest_ready === true &&
    es.okx_positions_ok === true
  );
}

export function buildOkxActualKeySetFromSync(
  sync: LedgerOkxPositionSyncSnapshot | null | undefined
): Set<string> {
  const keys = new Set<string>();
  if (!sync || !Array.isArray(sync.okx_positions_preview)) return keys;
  for (const row of sync.okx_positions_preview) {
    const sym = String(row.symbol ?? "").trim();
    if (!sym) continue;
    keys.add(`${sym}:${normalizePositionSide(row.side)}`);
  }
  return keys;
}

export function buildOkxActualKeySetFromEngineState(engineState: unknown): Set<string> | null {
  if (!isAuthoritativeOkxPositionSnapshotForDisplay(engineState)) return null;
  if (!engineState || typeof engineState !== "object") return null;
  const sync = (engineState as Record<string, unknown>).ledger_okx_position_sync;
  if (!sync || typeof sync !== "object") return new Set<string>();
  return buildOkxActualKeySetFromSync(sync as LedgerOkxPositionSyncSnapshot);
}

export function hasBotOwnershipEvidenceOnLedgerRow(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  if (r.isV2Authority === true) return true;
  const authSrc = String(r.authoritySourceAtEntry ?? r.authority ?? "").trim().toLowerCase();
  if (authSrc === "v2") return true;
  if (String(r.exchangeClOrdId ?? "").startsWith("p")) return true;
  if (String(r.exchangeOrdId ?? "").trim().length > 0 && String(r.exchangeClOrdId ?? "").startsWith("p")) {
    return true;
  }
  const ls = String(r.lifecycleState ?? "");
  if (ls === "BOT_V2_MANAGED" || ls === "OPEN" || ls === "ADDON_ACTIVE" || ls === "PARTIAL_ACTIVE") {
    return authSrc === "v2" || r.isV2Authority === true || String(r.exchangeClOrdId ?? "").startsWith("p");
  }
  return false;
}

export function isIndependentExternalManualLifecycleRow(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const ls = String((row as Record<string, unknown>).lifecycleState ?? "");
  return ls === "EXTERNAL_MANUAL_POSITION" || ls === "OPERATOR_MANAGED";
}

export function isLedgerOnlyStaleKey(
  key: string,
  sync: Pick<LedgerOkxPositionSyncSnapshot, "okx_positions_preview" | "paper_positions_preview">
): boolean {
  const okxHas = sync.okx_positions_preview.some((r) => `${r.symbol}:${r.side}` === key);
  const paperHas = sync.paper_positions_preview.some((r) => `${r.symbol}:${r.side}` === key);
  return paperHas && !okxHas;
}

export function isOkxOnlyKey(
  key: string,
  sync: Pick<LedgerOkxPositionSyncSnapshot, "okx_positions_preview" | "paper_positions_preview">
): boolean {
  const okxHas = sync.okx_positions_preview.some((r) => `${r.symbol}:${r.side}` === key);
  const paperHas = sync.paper_positions_preview.some((r) => `${r.symbol}:${r.side}` === key);
  return okxHas && !paperHas;
}

export function findLedgerOpenRow<T extends { symbol: string; side: string; status?: string }>(
  paperOpens: ReadonlyArray<T>,
  key: string
): T | undefined {
  return paperOpens.find((p) => (p.status ?? "open") === "open" && `${p.symbol}:${normalizePositionSide(p.side)}` === key);
}

/** Ledger key absent on OKX authoritative snapshot — not external manual. */
export function shouldBlockAutomatedManagementForSyncKey(input: Readonly<{
  key: string;
  sync: LedgerOkxPositionSyncSnapshot;
  paperOpens: ReadonlyArray<{ symbol: string; side: string; status?: string; lifecycleState?: string }>;
}>): boolean {
  if (isLedgerOnlyStaleKey(input.key, input.sync)) return false;

  if (isOkxOnlyKey(input.key, input.sync)) {
    const paperRow = findLedgerOpenRow(input.paperOpens, input.key);
    if (paperRow == null) return true;
    if (isIndependentExternalManualLifecycleRow(paperRow)) return true;
    return !hasBotOwnershipEvidenceOnLedgerRow(paperRow);
  }

  const paperRow = findLedgerOpenRow(input.paperOpens, input.key);
  if (paperRow == null) return false;
  if (isIndependentExternalManualLifecycleRow(paperRow)) return true;
  if (hasBotOwnershipEvidenceOnLedgerRow(paperRow)) return false;
  return false;
}

export function isTrueExternalManualClassification(input: Readonly<{
  key: string;
  sync: LedgerOkxPositionSyncSnapshot | null | undefined;
  paperOpens: ReadonlyArray<{ symbol: string; side: string; status?: string; lifecycleState?: string }>;
  manualOwnershipLatchActive?: boolean;
  manualLatchStrength?: string | null;
  independentManualEvidence?: boolean;
}>): boolean {
  if (input.independentManualEvidence === true) return true;
  if (input.manualOwnershipLatchActive === true && input.manualLatchStrength === "STRONG") return true;
  if (!input.sync) return false;
  if (!isOkxOnlyKey(input.key, input.sync)) return false;
  const paperRow = findLedgerOpenRow(input.paperOpens, input.key);
  if (paperRow != null && hasBotOwnershipEvidenceOnLedgerRow(paperRow)) return false;
  return true;
}

export function mapLedgerRowsToStaleReconcile(
  ledgerOpen: unknown[],
  displayState: LedgerReconcileDisplayState = "ledger_stale_reconcile"
): unknown[] {
  return ledgerOpen.map((row) => {
    const base = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    return {
      ...base,
      status: displayState,
      displayReconciliationState: displayState,
      displaySource: "paper_ledger_stale",
      isActivePosition: false
    };
  });
}

export function classifyLedgerOpenRowsForDisplay(
  engineState: unknown,
  openPositions: unknown[]
): Readonly<{ active: unknown[]; stale: unknown[] }> {
  const ledgerOpen = Array.isArray(openPositions)
    ? openPositions.filter((x) => {
        if (!x || typeof x !== "object") return false;
        const st = (x as Record<string, unknown>).status;
        return st === undefined || st === "open";
      })
    : [];

  if (ledgerOpen.length === 0) return { active: [], stale: [] };

  const okxKeys = buildOkxActualKeySetFromEngineState(engineState);
  if (okxKeys === null) {
    return { active: ledgerOpen, stale: [] };
  }

  const active: unknown[] = [];
  const staleRows: unknown[] = [];
  for (const row of ledgerOpen) {
    const key = ledgerPositionKey(row);
    if (key != null && !okxKeys.has(key)) staleRows.push(row);
    else active.push(row);
  }

  return {
    active,
    stale: mapLedgerRowsToStaleReconcile(staleRows)
  };
}

export function resolveAuthoritativePaperOpenForSymbol<T extends { symbol: string; side: string; reconcileState?: string; lifecycleState?: string }>(
  paperOpens: ReadonlyArray<T>,
  symbol: string,
  okxSide: PositionSide | null | undefined
): T | undefined {
  const rows = paperOpens.filter((p) => String(p.symbol) === symbol);
  if (rows.length === 0) return undefined;
  if (okxSide != null) {
    const aligned = rows.find((p) => normalizePositionSide(p.side) === okxSide);
    if (aligned) return aligned;
  }
  return (
    rows.find((p) => p.reconcileState === "MATCHED") ??
    rows.find((p) => p.lifecycleState === "BOT_V2_MANAGED") ??
    rows.find((p) => hasBotOwnershipEvidenceOnLedgerRow(p)) ??
    rows[0]
  );
}
