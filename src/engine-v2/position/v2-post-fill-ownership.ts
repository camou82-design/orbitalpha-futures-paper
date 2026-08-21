import type { PaperOpenPositionRecord, PendingEntryOrderRecord } from "../../models/types";
import { hasBotOwnershipEvidenceOnLedgerRow } from "../../lib/position-reconcile-classification";
import { resolveCanonicalV2SizeUsd } from "../live-account/position-size-authority";

/** Grace while OKX positions payload catches up after authoritative V2 fill. */
export const V2_POST_FILL_OWNERSHIP_GRACE_MS = 120_000;

export type V2PostFillOwnershipEvidence = Readonly<{
    symbol: string;
    side: "long" | "short";
    key: string;
    source: "immediate_fill" | "pending_fill" | "persisted_ledger";
    ordId: string | null;
    clOrdId: string | null;
    openTraceId: string | null;
    flowId: string | null;
    fillConfirmedAt: number;
    expiresAt: number;
    paperRecordSnapshot: PaperOpenPositionRecord | null;
    pendingOrdId: string | null;
}>;

export function buildPositionSideKey(symbol: string, side: string): string {
    return `${String(symbol)}:${String(side).toLowerCase() === "short" ? "short" : "long"}`;
}

export function isV2PostFillOwnershipEvidenceActive(
    evidence: V2PostFillOwnershipEvidence | null | undefined,
    nowMs: number = Date.now()
): boolean {
    if (evidence == null) return false;
    return nowMs <= evidence.expiresAt;
}

export function hasAuthoritativeV2FillEvidenceOnPending(
    pending: PendingEntryOrderRecord | null | undefined
): boolean {
    if (pending == null) return false;
    if (String(pending.authority_source ?? "").trim().toLowerCase() !== "v2") return false;
    const snap = pending.paperRecordSnapshot;
    if (snap == null || typeof snap !== "object") return false;
    return hasBotOwnershipEvidenceOnLedgerRow(snap);
}

export function buildV2PostFillOwnershipEvidence(input: Readonly<{
    record: PaperOpenPositionRecord;
    source: V2PostFillOwnershipEvidence["source"];
    ordId?: string | null;
    clOrdId?: string | null;
    openTraceId?: string | null;
    pendingOrdId?: string | null;
    nowMs?: number;
    graceMs?: number;
}>): V2PostFillOwnershipEvidence {
    const nowMs = input.nowMs ?? Date.now();
    const graceMs = input.graceMs ?? V2_POST_FILL_OWNERSHIP_GRACE_MS;
    const side = input.record.side;
    return {
        symbol: String(input.record.symbol),
        side,
        key: buildPositionSideKey(String(input.record.symbol), side),
        source: input.source,
        ordId: input.ordId ?? input.record.exchangeOrdId ?? null,
        clOrdId: input.clOrdId ?? input.record.exchangeClOrdId ?? null,
        openTraceId: input.openTraceId ?? null,
        flowId: `${input.record.symbol}:${side}:${input.record.openedAt}`,
        fillConfirmedAt: nowMs,
        expiresAt: nowMs + graceMs,
        paperRecordSnapshot: input.record,
        pendingOrdId: input.pendingOrdId ?? null
    };
}

export function findV2PostFillOwnershipEvidence(input: Readonly<{
    key: string;
    pendingOrders: readonly PendingEntryOrderRecord[];
    persistedOpens: readonly PaperOpenPositionRecord[];
    recentFillRegistry: ReadonlyMap<string, V2PostFillOwnershipEvidence>;
    nowMs?: number;
    requireStrongOrderEvidence?: boolean;
}>): V2PostFillOwnershipEvidence | null {
    const nowMs = input.nowMs ?? Date.now();
    const [symbol, sideRaw] = input.key.split(":");
    const side = sideRaw === "short" ? "short" : "long";
    const requireStrong = input.requireStrongOrderEvidence === true;

    for (const open of input.persistedOpens) {
        if (buildPositionSideKey(String(open.symbol), open.side) !== input.key) continue;
        if (!hasBotOwnershipEvidenceOnLedgerRow(open)) continue;
        const evidence = buildV2PostFillOwnershipEvidence({
            record: open,
            source: "persisted_ledger",
            ordId: open.exchangeOrdId ?? null,
            clOrdId: open.exchangeClOrdId ?? null,
            nowMs,
            graceMs: Math.max(0, V2_POST_FILL_OWNERSHIP_GRACE_MS - (nowMs - (open.openedAt ?? nowMs)))
        });
        if (!requireStrong || isStrongV2PostFillRecoveryEvidence(evidence)) return evidence;
    }

    const registryHit = input.recentFillRegistry.get(input.key);
    if (isV2PostFillOwnershipEvidenceActive(registryHit, nowMs)) {
        if (!requireStrong || isStrongV2PostFillRecoveryEvidence(registryHit)) {
            return registryHit!;
        }
    }

    for (const pending of input.pendingOrders) {
        if (String(pending.symbol) !== symbol || pending.side !== side) continue;
        if (!isPendingEligibleForV2PostFillEvidence(pending)) continue;
        const snap = pending.paperRecordSnapshot as PaperOpenPositionRecord;
        const evidence = buildV2PostFillOwnershipEvidence({
            record: snap,
            source: "pending_fill",
            ordId: pending.ordId,
            clOrdId: pending.clOrdId,
            openTraceId: pending.openTraceId,
            pendingOrdId: pending.ordId,
            nowMs
        });
        if (!requireStrong || isStrongV2PostFillRecoveryEvidence(evidence)) return evidence;
    }

    return null;
}

export function shouldSuppressUntrackedGhostAdoption(input: Readonly<{
    key: string;
    pendingOrders: readonly PendingEntryOrderRecord[];
    persistedOpens: readonly PaperOpenPositionRecord[];
    recentFillRegistry: ReadonlyMap<string, V2PostFillOwnershipEvidence>;
    nowMs?: number;
}>): Readonly<{ suppress: boolean; evidence: V2PostFillOwnershipEvidence | null; reason: string | null }> {
    const evidence = findV2PostFillOwnershipEvidence(input);
    if (evidence == null) {
        return { suppress: false, evidence: null, reason: null };
    }
    return {
        suppress: true,
        evidence,
        reason: `v2_post_fill_ownership_${evidence.source}`
    };
}

export function hydrateOpenFromRemoteForPostFill(
    record: PaperOpenPositionRecord,
    remote: Readonly<{
        avgPx: number;
        contracts: number;
        baseQty: number;
        notionalUsd: number;
        marginUsd: number;
        leverage: number;
        instId: string;
    }>
): PaperOpenPositionRecord {
    const avgPx = remote.avgPx > 0 ? remote.avgPx : record.entryPrice;
    const notional = remote.notionalUsd > 0 ? remote.notionalUsd : record.notionalUsd ?? record.sizeUsd;
    const marginUsd =
        remote.marginUsd > 0
            ? remote.marginUsd
            : notional / Math.max(1, remote.leverage > 0 ? remote.leverage : record.leverage ?? 10);

    // [V2_CANONICAL_WRITE] V2/BOT_V2_MANAGED rows store sizeUsd = NOTIONAL.
    // resolveCanonicalV2SizeUsd() enforces priority: OKX notional → derived → fail-closed.
    const canonicalNotional = resolveCanonicalV2SizeUsd({
        notionalUsd: remote.notionalUsd,
        marginUsd: remote.marginUsd,
        leverage: remote.leverage > 0 ? remote.leverage : record.leverage,
    });
    // Canonical sizeUsd = notional (invariant: V2 sizeUsd is NOTIONAL).
    // If resolveCanonicalV2SizeUsd returns null (edge case: all inputs 0/invalid),
    // fall back to computed notional to avoid storing 0. This path should not occur in prod.
    const canonicalSizeUsd = canonicalNotional ?? notional;

    return {
        ...record,
        entryPrice: avgPx,
        avgPx,
        okxContracts: remote.contracts,
        baseQty: remote.baseQty,
        pos: record.side === "short" ? -Math.abs(remote.baseQty) : Math.abs(remote.baseQty),
        notionalUsd: notional,
        actualNotionalUsd: notional,
        sizeUsd: canonicalSizeUsd,      // V2 canonical: NOTIONAL
        actualMarginUsd: marginUsd,     // margin stored separately for bookkeeping
        leverage: remote.leverage > 0 ? remote.leverage : record.leverage,
        instId: remote.instId,
        reconcileState: "MATCHED",
        lifecycleState: "BOT_V2_MANAGED",
        isV2Authority: true,
        status: "open"
    };
}


export function materializeV2ManagedOpenFromPostFillEvidence(
    evidence: V2PostFillOwnershipEvidence,
    remote?: Readonly<{
        avgPx: number;
        contracts: number;
        baseQty: number;
        notionalUsd: number;
        marginUsd: number;
        leverage: number;
        instId: string;
    }> | null,
    nowMs: number = Date.now()
): PaperOpenPositionRecord | null {
    const base = evidence.paperRecordSnapshot;
    if (base == null) return null;
    const openedAt = base.openedAt > 0 ? base.openedAt : nowMs;
    let record: PaperOpenPositionRecord = {
        ...base,
        openedAt,
        lifecycleState: "BOT_V2_MANAGED",
        reconcileState: remote != null ? "MATCHED" : base.reconcileState ?? "PENDING",
        isV2Authority: true,
        status: "open",
        exchangeOrdId: evidence.ordId ?? base.exchangeOrdId,
        exchangeClOrdId: evidence.clOrdId ?? base.exchangeClOrdId,
        lastCheckedAt: nowMs
    };
    if (remote != null) {
        record = hydrateOpenFromRemoteForPostFill(record, remote);
    }
    return record;
}

export function pruneExpiredV2PostFillOwnershipRegistry(
    registry: Map<string, V2PostFillOwnershipEvidence>,
    nowMs: number = Date.now()
): void {
    for (const [key, evidence] of registry.entries()) {
        if (!isV2PostFillOwnershipEvidenceActive(evidence, nowMs)) {
            registry.delete(key);
        }
    }
}

export function hasStrongV2OrderEvidence(input: Readonly<{
    ordId?: string | null;
    clOrdId?: string | null;
    record?: PaperOpenPositionRecord | null;
}>): boolean {
    const clOrdId = String(input.clOrdId ?? input.record?.exchangeClOrdId ?? "").trim();
    const ordId = String(input.ordId ?? input.record?.exchangeOrdId ?? "").trim();
    return clOrdId.startsWith("p") || ordId.length > 0;
}

/** Recovery / ghost-suppress requires real order linkage — not symbol/side/time alone. */
export function isStrongV2PostFillRecoveryEvidence(
    evidence: V2PostFillOwnershipEvidence | null | undefined
): boolean {
    if (evidence == null) return false;
    if (!hasStrongV2OrderEvidence({
        ordId: evidence.ordId,
        clOrdId: evidence.clOrdId,
        record: evidence.paperRecordSnapshot
    })) {
        return false;
    }
    if (evidence.source === "persisted_ledger") {
        return hasBotOwnershipEvidenceOnLedgerRow(evidence.paperRecordSnapshot);
    }
    return evidence.paperRecordSnapshot != null;
}

export function isPendingEligibleForV2PostFillEvidence(
    pending: PendingEntryOrderRecord
): boolean {
    if (!hasAuthoritativeV2FillEvidenceOnPending(pending)) return false;
    return (
        pending.entryPendingState === "ENTRY_FILL_RECONCILING" ||
        pending.entryPendingState === "ENTRY_SUBMIT_PENDING"
    );
}

function openLedgerRowScore(row: PaperOpenPositionRecord): number {
    let score = 0;
    if (row.isV2Authority === true) score += 1_000;
    if (row.lifecycleState === "BOT_V2_MANAGED") score += 500;
    if (row.reconcileState === "MATCHED") score += 100;
    if (hasBotOwnershipEvidenceOnLedgerRow(row)) score += 50;
    score += Math.min(120, (row.openedAt ?? 0) / 1_000_000_000_000);
    return score;
}

function mergeOpenLedgerRowPreferPreserved(
    kept: PaperOpenPositionRecord,
    other: PaperOpenPositionRecord
): PaperOpenPositionRecord {
    const merged: PaperOpenPositionRecord = { ...other, ...kept };
    for (const [key, value] of Object.entries(kept)) {
        if (value !== undefined && value !== null) {
            (merged as Record<string, unknown>)[key] = value;
        }
    }
    for (const [key, value] of Object.entries(other)) {
        if ((merged as Record<string, unknown>)[key] == null && value != null) {
            (merged as Record<string, unknown>)[key] = value;
        }
    }
    if (openLedgerRowScore(kept) >= openLedgerRowScore(other)) {
        merged.openedAt = kept.openedAt;
        merged.lifecycleState = kept.lifecycleState ?? other.lifecycleState;
        merged.reconcileState = kept.reconcileState ?? other.reconcileState;
        merged.isV2Authority = kept.isV2Authority === true ? true : other.isV2Authority;
    }
    return merged;
}

/** Upsert open ledger rows by symbol:side, never dropping higher-authority V2 rows. */
export function mergeOpenLedgerBySymbolSide(
    ...sources: readonly (readonly PaperOpenPositionRecord[])[]
): PaperOpenPositionRecord[] {
    const merged = new Map<string, PaperOpenPositionRecord>();
    for (const rows of sources) {
        for (const row of rows) {
            const key = buildPositionSideKey(String(row.symbol), row.side);
            const prev = merged.get(key);
            if (prev == null) {
                merged.set(key, row);
                continue;
            }
            const keep =
                openLedgerRowScore(row) >= openLedgerRowScore(prev)
                    ? mergeOpenLedgerRowPreferPreserved(row, prev)
                    : mergeOpenLedgerRowPreferPreserved(prev, row);
            merged.set(key, keep);
        }
    }
    return [...merged.values()];
}

export function upsertOpenLedgerRowInMemory(
    rows: PaperOpenPositionRecord[],
    record: PaperOpenPositionRecord
): PaperOpenPositionRecord[] {
    return mergeOpenLedgerBySymbolSide(rows, [record]);
}

export function ledgerHasBotOwnershipForKey(
    opens: readonly PaperOpenPositionRecord[],
    key: string
): PaperOpenPositionRecord | null {
    for (const row of opens) {
        if (buildPositionSideKey(String(row.symbol), row.side) !== key) continue;
        if (hasBotOwnershipEvidenceOnLedgerRow(row)) return row;
    }
    return null;
}

export const V2_ENTRY_TELEMETRY_FIELDS = [
    "entryQualityGrade",
    "entryQualityScore",
    "entryRegime",
    "entryMarketSubtype",
    "entryMarketMode",
    "entryZone",
    "entryBoxPos",
    "entryTrendSideCandidate",
    "entryRangeSideCandidate",
    "entryHtfPolicy",
    "entryPromotionReason",
    "entryAuthorityReason",
    "entryDecisionReason",
    "entryExpectedMovePct",
    "entryFeeBreakEvenPct",
    "entrySnapshotAt"
] as const;

export function extractEntryTelemetry(row: PaperOpenPositionRecord): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of V2_ENTRY_TELEMETRY_FIELDS) {
        out[field] = (row as Record<string, unknown>)[field] ?? null;
    }
    return out;
}
