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

export function isManualTakeoverActiveForSymbol(
  symbol: string,
  side?: "long" | "short" | null,
  activeMap?: ReadonlyMap<string, ManualTakeoverRecord> | Record<string, ManualTakeoverRecord> | null
): boolean {
  if (!activeMap) return false;
  const symKey = String(symbol ?? "").trim().toUpperCase();
  if (activeMap instanceof Map) {
    if (side) {
      const specific = activeMap.get(buildManualTakeoverKey(symKey, side));
      if (specific && specific.manualTakeoverActive === true) return true;
    }
    const general = activeMap.get(symKey);
    return general != null && general.manualTakeoverActive === true;
  }
  if (typeof activeMap === "object") {
    const obj = activeMap as Record<string, ManualTakeoverRecord>;
    if (side) {
      const specific = obj[buildManualTakeoverKey(symKey, side)];
      if (specific && specific.manualTakeoverActive === true) return true;
    }
    const general = obj[symKey];
    return general != null && general.manualTakeoverActive === true;
  }
  return false;
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
