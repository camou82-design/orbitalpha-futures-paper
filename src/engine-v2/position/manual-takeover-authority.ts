import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PaperOpenPositionRecord } from "../../models/types";

export type ManualTakeoverReason =
  | "MANUAL_SIZE_CHANGE"
  | "MANUAL_PARTIAL_CLOSE"
  | "MANUAL_ADD"
  | "MANUAL_PROTECTIVE_CHANGE"
  | "MANUAL_FULL_CLOSE"
  | "EXTERNAL_POSITION_MUTATION"
  | "EXTERNAL_MANUAL_POSITION"
  | "OPERATOR_MANUAL_INTERVENTION"
  | "MANUAL_INTERVENTION_DETECTED";

export type ManualTakeoverRecord = Readonly<{
  manualTakeoverActive: boolean;
  manualTakeoverSymbol: string;
  manualTakeoverSide: "long" | "short";
  manualTakeoverDetectedAt: number;
  manualTakeoverReason: ManualTakeoverReason;
  manualTakeoverPositionCycleId?: string;
  manualTakeoverClearedBy?: string;
  manualTakeoverClearedAt?: number;
}>;

export type ManualTakeoverStoreDoc = Readonly<{
  updatedAt: number;
  bySymbol: Record<string, ManualTakeoverRecord>;
}>;

export function buildManualTakeoverKey(symbol: string, side?: string | null): string {
  const sym = String(symbol ?? "").trim().toUpperCase();
  const s = String(side ?? "").trim().toLowerCase();
  return s === "long" || s === "short" ? `${sym}:${s}` : sym;
}

export type ManualTakeoverOpenPositionRef = Readonly<{
  symbol: string;
  side: string;
  status?: string;
  lifecycleState?: string;
  manualTakeoverActive?: boolean;
  okxContracts?: number | null;
  sizeUsd?: number | null;
}>;

function hasPositiveOpenSize(pos: ManualTakeoverOpenPositionRef): boolean {
  const contracts = pos.okxContracts;
  if (typeof contracts === "number" && Number.isFinite(contracts) && Math.abs(contracts) > 0) return true;
  const sizeUsd = pos.sizeUsd;
  return typeof sizeUsd === "number" && Number.isFinite(sizeUsd) && sizeUsd > 0;
}

/** Open ledger row for symbol (optional side filter) with live size. */
export function hasOpenPositionForManualTakeoverSymbol(
  symbol: string,
  side: "long" | "short" | null | undefined,
  openPositions: ReadonlyArray<ManualTakeoverOpenPositionRef>
): boolean {
  const symKey = String(symbol ?? "").trim().toUpperCase();
  return openPositions.some((p) => {
    if (String(p.symbol ?? "").trim().toUpperCase() !== symKey) return false;
    if (p.status && p.status !== "open") return false;
    if (!hasPositiveOpenSize(p)) return false;
    if (side) return String(p.side).toLowerCase() === side;
    return true;
  });
}

export function isOperatorManagedOpenPosition(open: ManualTakeoverOpenPositionRef): boolean {
  return (
    open.manualTakeoverActive === true ||
    open.lifecycleState === "OPERATOR_MANAGED" ||
    open.lifecycleState === "EXTERNAL_MANUAL_POSITION" ||
    open.lifecycleState === "EXTERNAL_MANUAL_MANAGED"
  );
}

/**
 * Position-cycle latch: takeover blocks automation only while a live position exists.
 * Stale symbol keys (position flat) are treated as inactive.
 */
export function isManualTakeoverActiveForSymbol(
  symbol: string,
  side?: "long" | "short" | null,
  activeMap?: ReadonlyMap<string, ManualTakeoverRecord> | Record<string, ManualTakeoverRecord> | null,
  openPositions?: ReadonlyArray<ManualTakeoverOpenPositionRef> | null,
  options?: Readonly<{ engineOwnedOrderCount?: number | null }>
): boolean {
  if (!activeMap) return false;
  const symKey = String(symbol ?? "").trim().toUpperCase();
  let recordActive = false;
  let recordSide: "long" | "short" | null = side ?? null;
  if (activeMap instanceof Map) {
    if (side) {
      const specific = activeMap.get(buildManualTakeoverKey(symKey, side));
      if (specific && specific.manualTakeoverActive === true) {
        recordActive = true;
        recordSide = specific.manualTakeoverSide;
      }
    }
    if (!recordActive) {
      const general = activeMap.get(symKey);
      if (general != null && general.manualTakeoverActive === true) {
        recordActive = true;
        recordSide = general.manualTakeoverSide;
      }
    }
  } else if (typeof activeMap === "object") {
    const obj = activeMap as Record<string, ManualTakeoverRecord>;
    if (side) {
      const specific = obj[buildManualTakeoverKey(symKey, side)];
      if (specific && specific.manualTakeoverActive === true) {
        recordActive = true;
        recordSide = specific.manualTakeoverSide;
      }
    }
    if (!recordActive) {
      const general = obj[symKey];
      if (general != null && general.manualTakeoverActive === true) {
        recordActive = true;
        recordSide = general.manualTakeoverSide;
      }
    }
  }
  if (!recordActive) return false;
  const sideFilter = side ?? recordSide ?? null;
  const positionOpen = hasOpenPositionForManualTakeoverSymbol(symKey, sideFilter, openPositions ?? []);
  if (positionOpen) return true;
  if (openPositions == null) return true;
  const engineOwnedOrderCount = options?.engineOwnedOrderCount;
  if (engineOwnedOrderCount == null) {
    return true;
  }
  if (engineOwnedOrderCount > 0) return true;
  return false;
}

export function countAuthoritativeEngineOwnedExchangeOrders(input: Readonly<{
  symbol: string;
  side?: "long" | "short" | null;
  openPositions?: ReadonlyArray<PaperOpenPositionRecord> | null;
  pendingOrders?: ReadonlyArray<Record<string, unknown>> | null;
  algoOrders?: ReadonlyArray<Record<string, unknown>> | null;
}>): number {
  const sym = String(input.symbol ?? "").trim().toUpperCase();
  const side = input.side ?? null;
  let count = 0;
  const opens = input.openPositions ?? [];
  for (const ord of input.pendingOrders ?? []) {
    if (!isAuthoritativeBotOwnedPendingOrder(ord, opens)) continue;
    count += 1;
  }
  for (const algo of input.algoOrders ?? []) {
    if (!isAuthoritativeBotOwnedAlgoOrder(algo, opens)) continue;
    count += 1;
  }
  return count;
}

export function shouldLatchManualProtectiveOnlyIntervention(input: Readonly<{
  ledger: PaperOpenPositionRecord | null;
  reduceOnlyProtectiveFound: boolean;
  matchingProtectivePendingCount: number;
  scanClean: boolean;
  nowMs: number;
}>): boolean {
  const ledger = input.ledger;
  if (ledger == null) return false;
  if (ledger.manualTakeoverActive === true || ledger.lifecycleState === "OPERATOR_MANAGED") return false;
  const botManaged =
    ledger.isV2Authority === true ||
    ledger.lifecycleState === "BOT_V2_MANAGED" ||
    String(ledger.authoritySourceAtEntry ?? ledger.authority ?? "")
      .trim()
      .toLowerCase() === "v2";
  if (!botManaged) return false;
  if (!input.scanClean) return false;
  const graceUntil = ledger.protectiveVisibilityGraceDeadlineMs ?? ledger.entryProtectionUntil ?? 0;
  if (graceUntil > input.nowMs) return false;
  const botExpectedProtection =
    ledger.isProtectiveStopRegistered === true ||
    Boolean(ledger.protectiveSlAlgoId ?? ledger.protectiveStopAlgoId ?? ledger.protectiveTpAlgoId);
  if (!botExpectedProtection) return false;
  if (input.reduceOnlyProtectiveFound || input.matchingProtectivePendingCount > 0) return false;
  return true;
}

/** Clear takeover only when flat AND no authoritative engine-owned exchange orders remain. */
export function syncManualTakeoverLifecycleEntries(
  activeMap: Map<string, ManualTakeoverRecord>,
  openPositions: ReadonlyArray<ManualTakeoverOpenPositionRef>,
  engineOwnedOrderCountByKey: Readonly<Record<string, number>>,
  nowMs = Date.now(),
  clearedBy = "position_cycle_terminal_engine_orders_cleared"
): ReadonlyArray<string> {
  const clearedKeys: string[] = [];
  for (const [key, rec] of activeMap.entries()) {
    if (rec.manualTakeoverActive !== true) continue;
    const sym = rec.manualTakeoverSymbol;
    const side = rec.manualTakeoverSide;
    const keyIsGeneral = key === sym;
    const stillOpen = keyIsGeneral
      ? hasOpenPositionForManualTakeoverSymbol(sym, null, openPositions)
      : hasOpenPositionForManualTakeoverSymbol(sym, side, openPositions);
    if (stillOpen) continue;
    const engineCount = engineOwnedOrderCountByKey[key] ?? engineOwnedOrderCountByKey[sym] ?? 0;
    if (engineCount > 0) continue;
    activeMap.set(
      key,
      createClearedManualTakeoverRecord({
        symbol: sym,
        side,
        clearedBy,
        nowMs
      })
    );
    clearedKeys.push(key);
  }
  return clearedKeys;
}

/** @deprecated Use syncManualTakeoverLifecycleEntries with engine order scan. */
export function expireStaleManualTakeoverEntries(
  activeMap: Map<string, ManualTakeoverRecord>,
  openPositions: ReadonlyArray<ManualTakeoverOpenPositionRef>,
  nowMs = Date.now(),
  clearedBy = "position_cycle_terminal"
): ReadonlyArray<string> {
  return syncManualTakeoverLifecycleEntries(activeMap, openPositions, {}, nowMs, clearedBy);
}

export function createManualTakeoverRecord(input: Readonly<{
  symbol: string;
  side: "long" | "short";
  reason: ManualTakeoverReason;
  positionCycleId?: string;
  nowMs?: number;
}>): ManualTakeoverRecord {
  return {
    manualTakeoverActive: true,
    manualTakeoverSymbol: String(input.symbol).trim().toUpperCase(),
    manualTakeoverSide: input.side,
    manualTakeoverDetectedAt: input.nowMs ?? Date.now(),
    manualTakeoverReason: input.reason,
    manualTakeoverPositionCycleId: input.positionCycleId
  };
}

export function createClearedManualTakeoverRecord(input: Readonly<{
  symbol: string;
  side: "long" | "short";
  clearedBy?: string;
  nowMs?: number;
}>): ManualTakeoverRecord {
  return {
    manualTakeoverActive: false,
    manualTakeoverSymbol: String(input.symbol).trim().toUpperCase(),
    manualTakeoverSide: input.side,
    manualTakeoverDetectedAt: 0,
    manualTakeoverReason: "EXTERNAL_POSITION_MUTATION",
    manualTakeoverClearedBy: input.clearedBy ?? "operator",
    manualTakeoverClearedAt: input.nowMs ?? Date.now()
  };
}

export function applyManualTakeoverToPositionRecord(
  open: PaperOpenPositionRecord,
  record: ManualTakeoverRecord
): void {
  open.manualTakeoverActive = record.manualTakeoverActive;
  open.manualTakeoverSymbol = record.manualTakeoverSymbol;
  open.manualTakeoverSide = record.manualTakeoverSide;
  open.manualTakeoverDetectedAt = record.manualTakeoverDetectedAt;
  open.manualTakeoverReason = record.manualTakeoverReason;
  open.manualTakeoverPositionCycleId = record.manualTakeoverPositionCycleId;
  open.lifecycleState = "OPERATOR_MANAGED";
  open.manualOwnershipLatch = true;
  open.manualOwnershipLatchReason = record.manualTakeoverReason;
  open.manualOwnershipLatchAt = record.manualTakeoverDetectedAt;
  open.manualOwnershipLatchStrength = "STRONG";
}

export function buildManualTakeoverAuthorityProof(input: Readonly<{
  symbol: string;
  side: "long" | "short";
  manual_takeover_active: boolean;
  blocked_action: string;
  mutation_allowed: boolean;
  reason?: string;
}>): Record<string, unknown> {
  return {
    event: "V2_MANUAL_TAKEOVER_AUTHORITY_PROOF",
    symbol: input.symbol,
    side: input.side,
    manual_takeover_active: input.manual_takeover_active,
    blocked_action: input.blocked_action,
    mutation_allowed: input.mutation_allowed,
    reason: input.reason ?? "OPERATOR_MANUAL_TAKEOVER_ACTIVE"
  };
}

export type PositionMutationAuthority = Readonly<{
  effectiveAuthorityOwner: "OPERATOR" | "BOT";
  manualTakeoverActive: boolean;
  startupAuthorityResolved: boolean;
  positionMutationAllowed: boolean;
  protectiveReconcileAllowed: boolean;
  exitCalculationAllowed: boolean;
  blockReason: string | null;
}>;

/** Canonical predicate: operator/manual takeover => zero bot position mutation. */
export function resolvePositionMutationAuthority(input: Readonly<{
  open: ManualTakeoverOpenPositionRef & Pick<PaperOpenPositionRecord, "symbol" | "side">;
  manualTakeoverActiveExternal?: boolean;
}>): PositionMutationAuthority {
  const manualActive =
    input.open.manualTakeoverActive === true ||
    input.manualTakeoverActiveExternal === true ||
    isOperatorManagedOpenPosition(input.open);
  if (manualActive) {
    return {
      effectiveAuthorityOwner: "OPERATOR",
      manualTakeoverActive: true,
      startupAuthorityResolved: true,
      positionMutationAllowed: false,
      protectiveReconcileAllowed: false,
      exitCalculationAllowed: false,
      blockReason: "MANUAL_TAKEOVER_OPERATOR_MANAGED"
    };
  }
  return {
    effectiveAuthorityOwner: "BOT",
    manualTakeoverActive: false,
    startupAuthorityResolved: true,
    positionMutationAllowed: true,
    protectiveReconcileAllowed: true,
    exitCalculationAllowed: true,
    blockReason: null
  };
}

export function buildStartupPositionAuthorityBarrierProof(input: Readonly<{
  symbol: string;
  side: "long" | "short";
  runCycleId: number;
  positionExists: boolean;
  manualTakeoverLoaded: boolean;
  ledgerLifecycleState: string | null | undefined;
  authority: PositionMutationAuthority;
}>): Record<string, unknown> {
  return {
    event: "V2_STARTUP_POSITION_AUTHORITY_BARRIER_PROOF",
    symbol: input.symbol,
    side: input.side,
    run_cycle_id: input.runCycleId,
    position_exists: input.positionExists,
    manual_takeover_loaded: input.manualTakeoverLoaded,
    ledger_lifecycle_state: input.ledgerLifecycleState ?? null,
    manual_takeover_active: input.authority.manualTakeoverActive,
    effective_authority_owner: input.authority.effectiveAuthorityOwner,
    startup_authority_resolved: input.authority.startupAuthorityResolved,
    position_mutation_allowed: input.authority.positionMutationAllowed,
    protective_reconcile_allowed: input.authority.protectiveReconcileAllowed,
    exit_calculation_allowed: input.authority.exitCalculationAllowed,
    startup_authority_resolved_before_position_mutation: input.authority.startupAuthorityResolved
  };
}

/** Apply persisted manual-takeover.json onto open ledger rows before any mutation path. */
export function hydrateManualTakeoverOntoOpenPositions(
  activeMap: ReadonlyMap<string, ManualTakeoverRecord> | Record<string, ManualTakeoverRecord>,
  openPositions: PaperOpenPositionRecord[]
): boolean {
  let modified = false;
  for (const open of openPositions) {
    const sym = String(open.symbol ?? "").trim().toUpperCase();
    const side = String(open.side).toLowerCase() as "long" | "short";
    const active = isManualTakeoverActiveForSymbol(sym, side, activeMap, openPositions);
    if (!active) continue;
    if (open.manualTakeoverActive === true && open.lifecycleState === "OPERATOR_MANAGED") continue;
    let rec: ManualTakeoverRecord | undefined;
    if (activeMap instanceof Map) {
      rec =
        activeMap.get(buildManualTakeoverKey(sym, side)) ??
        activeMap.get(sym);
    } else {
      const obj = activeMap as Record<string, ManualTakeoverRecord>;
      rec = obj[buildManualTakeoverKey(sym, side)] ?? obj[sym];
    }
    if (rec?.manualTakeoverActive === true) {
      applyManualTakeoverToPositionRecord(open, rec);
      modified = true;
    }
  }
  return modified;
}

export function evaluateManualTakeoverActionGuard(input: Readonly<{
  symbol: string;
  side: "long" | "short";
  action: string;
  manualTakeoverActive: boolean;
}>): Readonly<{
  allowed: boolean;
  blockReason: string | null;
  proof: Record<string, unknown>;
}> {
  if (input.manualTakeoverActive === true) {
    const proof = buildManualTakeoverAuthorityProof({
      symbol: input.symbol,
      side: input.side,
      manual_takeover_active: true,
      blocked_action: input.action,
      mutation_allowed: false,
      reason: "MANUAL_TAKEOVER_ACTIVE"
    });
    return {
      allowed: false,
      blockReason: "MANUAL_TAKEOVER_ACTIVE",
      proof
    };
  }
  return {
    allowed: true,
    blockReason: null,
    proof: buildManualTakeoverAuthorityProof({
      symbol: input.symbol,
      side: input.side,
      manual_takeover_active: false,
      blocked_action: "none",
      mutation_allowed: true,
      reason: "AUTOMATION_ALLOWED"
    })
  };
}

export async function readManualTakeoverDocFromDisk(baseDir: string): Promise<ManualTakeoverStoreDoc> {
  const fullPath = path.resolve(baseDir, "control/manual-takeover.json");
  try {
    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const bySymbol: Record<string, ManualTakeoverRecord> = {};
    if (parsed.bySymbol && typeof parsed.bySymbol === "object") {
      for (const [k, v] of Object.entries(parsed.bySymbol as Record<string, unknown>)) {
        if (v && typeof v === "object") {
          const rec = v as Record<string, unknown>;
          bySymbol[k] = {
            manualTakeoverActive: rec.manualTakeoverActive === true,
            manualTakeoverSymbol: String(rec.manualTakeoverSymbol ?? k),
            manualTakeoverSide: rec.manualTakeoverSide === "short" ? "short" : "long",
            manualTakeoverDetectedAt: Number(rec.manualTakeoverDetectedAt ?? 0),
            manualTakeoverReason: (rec.manualTakeoverReason as ManualTakeoverReason) ?? "EXTERNAL_POSITION_MUTATION",
            manualTakeoverPositionCycleId: rec.manualTakeoverPositionCycleId ? String(rec.manualTakeoverPositionCycleId) : undefined,
            manualTakeoverClearedBy: rec.manualTakeoverClearedBy ? String(rec.manualTakeoverClearedBy) : undefined,
            manualTakeoverClearedAt: rec.manualTakeoverClearedAt ? Number(rec.manualTakeoverClearedAt) : undefined
          };
        }
      }
    }
    return {
      updatedAt: Number(parsed.updatedAt ?? Date.now()),
      bySymbol
    };
  } catch {
    return {
      updatedAt: Date.now(),
      bySymbol: {}
    };
  }
}

export async function writeManualTakeoverDocToDisk(
  baseDir: string,
  doc: ManualTakeoverStoreDoc
): Promise<string> {
  const fullPath = path.resolve(baseDir, "control/manual-takeover.json");
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, JSON.stringify(doc, null, 2), "utf8");
  return fullPath;
}

/**
 * Authoritative predicate to determine whether an OKX algo order is owned by the bot engine.
 * Never cancels an operator/manual order based on casual prefix alone.
 */
export function isAuthoritativeBotOwnedAlgoOrder(
  algo: Record<string, unknown>,
  openPositions?: ReadonlyArray<PaperOpenPositionRecord> | null
): boolean {
  const algoId = String(algo.algoId ?? algo.ordId ?? "").trim();
  const algoClOrdId = String(algo.algoClOrdId ?? algo.clOrdId ?? "").trim();

  // 1. Exact match against open ledger algo IDs (SL / TP / Stop / BE)
  if (algoId.length > 0 && openPositions && openPositions.length > 0) {
    for (const open of openPositions) {
      if (open.protectiveSlAlgoId && algoId === String(open.protectiveSlAlgoId).trim()) return true;
      if (open.protectiveTpAlgoId && algoId === String(open.protectiveTpAlgoId).trim()) return true;
      if (open.protectiveStopAlgoId && algoId === String(open.protectiveStopAlgoId).trim()) return true;
      if (open.breakevenStopAlgoId && algoId === String(open.breakevenStopAlgoId).trim()) return true;
    }
  }

  // 2. Strict match for engine-generated protective algo client order ID schema:
  // Format: oap{shortSymbol}{sideChar}{openedAtBase36}{revisionSuffix}[s|t]
  // e.g. oapETHUSlsg7k2j3s or oapETHUSlsg7k2j3r1t
  if (/^oap[A-Za-z0-9]{3,6}[ls][0-9a-z]+(?:r\d+)?[st]?$/i.test(algoClOrdId)) {
    return true;
  }

  return false;
}

/**
 * Authoritative predicate to determine whether an OKX regular pending order is owned by the bot engine.
 */
export function isAuthoritativeBotOwnedPendingOrder(
  ord: Record<string, unknown>,
  openPositions?: ReadonlyArray<PaperOpenPositionRecord> | null
): boolean {
  const ordId = String(ord.ordId ?? "").trim();
  const clOrdId = String(ord.clOrdId ?? "").trim();

  // 1. Exact match against open ledger close pending IDs
  if (openPositions && openPositions.length > 0) {
    for (const open of openPositions) {
      if (open.closePendingClOrdId && clOrdId === String(open.closePendingClOrdId).trim()) return true;
      if (open.closePendingOrdId && ordId === String(open.closePendingOrdId).trim()) return true;
    }
  }

  // 2. Strict match for engine-generated entry/close clOrdId schema:
  // Format: p{shortSymbol}{sideChar}{timestampBase36}
  // e.g. pETHUSlsg7k2j3
  if (/^p[A-Za-z0-9]{3,6}[ls][0-9a-z]+$/i.test(clOrdId)) {
    return true;
  }

  return false;
}
