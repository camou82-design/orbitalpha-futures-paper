import type { LedgerOkxPositionSyncSnapshot } from "../exchange/okx-position-sync";

export type PositionSide = "long" | "short";

export type LedgerReconcileDisplayState =
  | "ledger_stale_reconcile"
  | "engine_ledger_stale"
  | "engine_reconcile_pending"
  | "true_external_manual";

export const BOT_SIZE_RECONCILE_PENDING_SYNC_STATUSES = new Set<string>([
  "ENGINE_PARTIAL_FILL_IN_FLIGHT",
  "ENGINE_PARTIAL_FILL_RECONCILING",
  "BOT_POSITION_SIZE_RECONCILE_PENDING",
  "ADOPTED_POSITION_SIZE_MISMATCH",
  "NOTIONAL_MISMATCH"
]);

export const FALSE_MANUAL_ESCALATION_SYNC_STATUSES = new Set<string>([
  "KEY_MISMATCH",
  "MANUAL_PARTIAL_DETECTED",
  "ADOPTED_POSITION_MANUAL_PARTIAL_DETECTED",
  "ADOPTED_POSITION_SIZE_MISMATCH",
  "NOTIONAL_MISMATCH",
  "AVG_PRICE_MISMATCH",
  "SIZE_MISMATCH",
  "ENGINE_PARTIAL_FILL_IN_FLIGHT",
  "ENGINE_PARTIAL_FILL_RECONCILING",
  "BOT_POSITION_SIZE_RECONCILE_PENDING"
]);

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
  const clOrdId = String(r.exchangeClOrdId ?? "");
  if (clOrdId.startsWith("p")) return true;
  const ordId = String(r.exchangeOrdId ?? "").trim();
  if (ordId.length > 0 && clOrdId.startsWith("p")) return true;
  if (String(r.reconcileState ?? "") === "ADOPTED") return true;
  const ls = String(r.lifecycleState ?? "");
  if (ls === "BOT_V2_MANAGED") return true;
  if (
    ls === "OPEN" ||
    ls === "ADDON_ACTIVE" ||
    ls === "PARTIAL_ACTIVE" ||
    ls === "PARTIAL_PENDING" ||
    ls === "CLOSE_PENDING"
  ) {
    return authSrc === "v2" || r.isV2Authority === true || clOrdId.startsWith("p") || ordId.length > 0;
  }
  if (
    (typeof r.partialPendingOrdId === "string" && r.partialPendingOrdId.length > 0) ||
    (typeof r.partialPendingClOrdId === "string" && r.partialPendingClOrdId.length > 0) ||
    (typeof r.closePendingOrdId === "string" && r.closePendingOrdId.length > 0) ||
    (typeof r.closePendingClOrdId === "string" && r.closePendingClOrdId.length > 0)
  ) {
    return true;
  }
  return false;
}

export function hasBotPartialReconcileEvidence(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  const ls = String(r.lifecycleState ?? "");
  return (
    ls === "PARTIAL_PENDING" ||
    ls === "CLOSE_PENDING" ||
    ls === "ADDON_ACTIVE" ||
    (typeof r.partialPendingOrdId === "string" && r.partialPendingOrdId.length > 0) ||
    (typeof r.partialPendingClOrdId === "string" && r.partialPendingClOrdId.length > 0) ||
    (typeof r.closePendingOrdId === "string" && r.closePendingOrdId.length > 0) ||
    (typeof r.closePendingClOrdId === "string" && r.closePendingClOrdId.length > 0) ||
    r.shockReduceState === "REQUESTED" ||
    r.shockReduceState === "SUBMITTED" ||
    r.shockReduceState === "PARTIALLY_FILLED"
  );
}

export function isPositiveExternalManualLifecycleRow(row: unknown): boolean {
  if (!isIndependentExternalManualLifecycleRow(row)) return false;
  return !hasBotOwnershipEvidenceOnLedgerRow(row);
}

export function actualPositionExistsForLedgerKey(
  key: string,
  sync: Pick<LedgerOkxPositionSyncSnapshot, "okx_positions_preview">
): boolean {
  return sync.okx_positions_preview.some((r) => `${r.symbol}:${r.side}` === key);
}

export function isBotSizeReconcilePendingSyncStatus(syncStatus: string | null | undefined): boolean {
  return BOT_SIZE_RECONCILE_PENDING_SYNC_STATUSES.has(String(syncStatus ?? "").trim());
}

export function shouldTreatSyncStatusAsManualPartial(input: Readonly<{
  syncStatus: string | null | undefined;
  key: string;
  sync: LedgerOkxPositionSyncSnapshot;
  paperRow: unknown;
}>): boolean {
  const status = String(input.syncStatus ?? "").trim();
  if (status !== "MANUAL_PARTIAL_DETECTED" && status !== "ADOPTED_POSITION_MANUAL_PARTIAL_DETECTED") {
    return false;
  }
  if (!actualPositionExistsForLedgerKey(input.key, input.sync)) return false;
  if (isLedgerOnlyStaleKey(input.key, input.sync)) return false;
  if (hasBotOwnershipEvidenceOnLedgerRow(input.paperRow)) return false;
  if (hasBotPartialReconcileEvidence(input.paperRow)) return false;
  return true;
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
  if (!actualPositionExistsForLedgerKey(input.key, input.sync)) return false;

  const paperRow = findLedgerOpenRow(input.paperOpens, input.key);
  if (paperRow != null) {
    if (hasBotOwnershipEvidenceOnLedgerRow(paperRow)) return false;
    if (hasBotPartialReconcileEvidence(paperRow)) return false;
    if (!isPositiveExternalManualLifecycleRow(paperRow)) return false;
    return true;
  }

  if (isOkxOnlyKey(input.key, input.sync)) {
    return true;
  }

  return false;
}

export function resolveBtcPositionManagementSuppressor(input: Readonly<{
  okxActualSide: string;
  paperSide: string;
  v2InferredSide: string;
  reconcileState: string;
  externalManualBlockedForSide: boolean;
  botOwnershipEvidence: boolean;
  positiveExternalManualEvidence: boolean;
  closeOnlyMode: boolean;
  killSwitch: boolean;
}>): Readonly<{
  sides_aligned: boolean;
  side_mismatch: boolean;
  false_manual_block_ignored: boolean;
  effective_external_manual_blocked: boolean;
  existing_position_management_blocked: boolean;
  protective_ensure_allowed: boolean;
  close_allowed: boolean;
  partial_reduce_allowed: boolean;
  suppressor_active: boolean;
  suppressor_reason: string | null;
}> {
  const okxActualSide = input.okxActualSide;
  const paperSide = input.paperSide;
  const v2InferredSide = input.v2InferredSide;
  const sidesAligned =
    okxActualSide !== "none" &&
    paperSide !== "none" &&
    okxActualSide === paperSide &&
    okxActualSide === v2InferredSide;
  const sideMismatch =
    okxActualSide !== "none" && paperSide !== "none" && okxActualSide !== paperSide;
  const falseManualBlockIgnored =
    sidesAligned && input.botOwnershipEvidence && !input.positiveExternalManualEvidence;
  const effectiveExternalManualBlocked =
    input.externalManualBlockedForSide && !falseManualBlockIgnored;
  const hardReconcileBlock =
    input.reconcileState === "RECONCILE_MISMATCH" && !sidesAligned;
  const existing_position_management_blocked =
    effectiveExternalManualBlocked ||
    sideMismatch ||
    hardReconcileBlock ||
    input.closeOnlyMode ||
    input.killSwitch;
  const managementBlockReasons: string[] = [];
  if (effectiveExternalManualBlocked) managementBlockReasons.push("external_manual_block");
  if (sideMismatch) managementBlockReasons.push("side_mismatch");
  if (hardReconcileBlock) managementBlockReasons.push("reconcile_mismatch");
  if (input.closeOnlyMode) managementBlockReasons.push("close_only_mode");
  if (input.killSwitch) managementBlockReasons.push("kill_switch");
  return {
    sides_aligned: sidesAligned,
    side_mismatch: sideMismatch,
    false_manual_block_ignored: falseManualBlockIgnored,
    effective_external_manual_blocked: effectiveExternalManualBlocked,
    existing_position_management_blocked,
    protective_ensure_allowed: !existing_position_management_blocked,
    close_allowed: !existing_position_management_blocked,
    partial_reduce_allowed: !existing_position_management_blocked,
    suppressor_active: existing_position_management_blocked,
    suppressor_reason: existing_position_management_blocked ? managementBlockReasons.join("|") : null
  };
}

export function buildFalseManualBlockClearedProof(input: Record<string, unknown>): Record<string, unknown> {
  return { event: "FALSE_MANUAL_BLOCK_CLEARED_PROOF", ...input };
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
