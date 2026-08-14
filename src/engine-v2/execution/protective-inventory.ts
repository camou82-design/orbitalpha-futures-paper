import {
    evaluateProtectiveAlgoMatch,
    type ProtectiveAlgoRow,
    type ProtectiveReconcileContext
} from "./protective-reconcile-plan";

export const OKX_ALGO_CL_ORD_ID_EXISTS = "51068";
export const OKX_ALGO_ORDER_DOES_NOT_EXIST = "51603";

/**
 * OKX algo clOrdId format contract:
 *   - alphanumeric only (A-Z, a-z, 0-9)
 *   - max 32 characters
 *   - NO underscores, hyphens, colons or other special chars
 *   - "sl" prefix for SL legs, "tp" prefix for TP legs
 *
 * This is the SINGLE canonical producer of protective algo clOrdIds.
 * All producers MUST route through this function.
 */
export function buildOkxAlgoClOrdId(kind: "sl" | "tp", entryClOrdId: string): string {
    // Strip every non-alphanumeric character from the entry clOrdId to guarantee
    // the output satisfies /^[A-Za-z0-9]{1,32}$/.
    const sanitized = String(entryClOrdId).replace(/[^A-Za-z0-9]/g, "");
    // "sl" / "tp" = 2 chars, leaving 30 for the sanitized entry id
    const body = sanitized.slice(0, 30);
    const result = `${kind}${body}`;
    return result;
}

/**
 * Returns true iff the given string satisfies the OKX clOrdId invariant:
 * alphanumeric only, length 1–32.
 */
export function isValidOkxAlgoClOrdId(id: string): boolean {
    return /^[A-Za-z0-9]{1,32}$/.test(id);
}

export type ProtectiveAlgoOrderLookupState = "FOUND" | "ABSENT" | "ERROR";

const CL_ORD_ID_KEYS = [
    "algoClOrdId",
    "attachAlgoClOrdId",
    "attachAlgoOrdId",
    "clOrdId"
] as const;

export function normalizeProtectiveOrderClOrdIds(row: ProtectiveAlgoRow): readonly string[] {
    const ids = new Set<string>();
    for (const key of CL_ORD_ID_KEYS) {
        const val = String(row[key] ?? "").trim();
        if (val) ids.add(val);
    }
    const attach = row.attachAlgoOrds;
    if (Array.isArray(attach)) {
        for (const leg of attach) {
            if (!leg || typeof leg !== "object") continue;
            for (const key of CL_ORD_ID_KEYS) {
                const val = String((leg as Record<string, unknown>)[key] ?? "").trim();
                if (val) ids.add(val);
            }
        }
    }
    return [...ids];
}

function inventoryDedupeKey(row: ProtectiveAlgoRow): string {
    const algoId = String(row.algoId ?? "").trim();
    if (algoId) return `algo:${algoId}`;
    const clIds = normalizeProtectiveOrderClOrdIds(row);
    if (clIds.length > 0) return `cl:${[...clIds].sort().join("|")}`;
    return `anon:${JSON.stringify({
        instId: row.instId,
        ordType: row.ordType,
        sl: row.slTriggerPx,
        tp: row.tpTriggerPx,
        sz: row.sz
    })}`;
}

export function mergeProtectiveInventoryRows(
    ...sources: readonly (readonly ProtectiveAlgoRow[])[]
): ProtectiveAlgoRow[] {
    const merged = new Map<string, ProtectiveAlgoRow>();
    const clOrdIndex = new Map<string, string>();

    const indexClOrdIds = (key: string, row: ProtectiveAlgoRow) => {
        for (const cl of normalizeProtectiveOrderClOrdIds(row)) {
            clOrdIndex.set(cl, key);
        }
    };

    const mergeInto = (key: string, row: ProtectiveAlgoRow) => {
        const prev = merged.get(key);
        const combined: ProtectiveAlgoRow = prev
            ? {
                  ...prev,
                  ...row,
                  attachAlgoOrds: row.attachAlgoOrds ?? prev.attachAlgoOrds
              }
            : row;
        merged.set(key, combined);
        indexClOrdIds(key, combined);
    };

    for (const rows of sources) {
        for (const row of rows) {
            const clIds = normalizeProtectiveOrderClOrdIds(row);
            let key: string | undefined;
            for (const cl of clIds) {
                const existing = clOrdIndex.get(cl);
                if (existing) {
                    key = existing;
                    break;
                }
            }
            if (!key) key = inventoryDedupeKey(row);
            mergeInto(key, row);
        }
    }
    return [...merged.values()];
}

export function buildProtectiveClOrdIdCandidates(input: Readonly<{
    slAlgoClOrdId: string;
    tpAlgoClOrdId: string;
    engineOwnedPrefix: string;
    entryClOrdId?: string | null;
}>): readonly string[] {
    const ids = new Set<string>();
    for (const id of [input.slAlgoClOrdId, input.tpAlgoClOrdId, input.engineOwnedPrefix]) {
        const v = String(id ?? "").trim();
        if (v) ids.add(v);
    }
    const entryCl = String(input.entryClOrdId ?? "").trim();
    if (entryCl) {
        // Use buildOkxAlgoClOrdId to guarantee alphanumeric-only output.
        // Also add legacy sl_/tp_ variants as fallback for orders already on exchange.
        ids.add(buildOkxAlgoClOrdId("sl", entryCl));
        ids.add(buildOkxAlgoClOrdId("tp", entryCl));
        // Legacy fallback: orders submitted before this fix used sl_/tp_ prefix
        ids.add(`sl_${entryCl}`);
        ids.add(`tp_${entryCl}`);
    }
    return [...ids];
}

export function buildEntryAttachProtectiveCandidates(input: Readonly<{
    instId: string;
    positionSide: "long" | "short";
    tdModeUsed: string;
    expectedSide: "buy" | "sell";
    contracts: number;
    activeStopPrice: number;
    activeTpPrice: number | null;
    wantsTp: boolean;
    entryClOrdId?: string | null;
}>): ProtectiveAlgoRow[] {
    const entryCl = String(input.entryClOrdId ?? "").trim();
    if (!entryCl) return [];
    // New canonical attach ID: alphanumeric only via buildOkxAlgoClOrdId
    const attachId = buildOkxAlgoClOrdId("sl", entryCl);
    // Legacy attach ID (sl_ prefix): orders already on exchange may use this form.
    // Stored in clOrdId (which is in CL_ORD_ID_KEYS) so normalizeProtectiveOrderClOrdIds
    // includes it, enabling inventory merge dedup against legacy pending orders.
    const legacyAttachId = `sl_${entryCl}`;
    const ordType = input.wantsTp ? "oco" : "conditional";
    return [
        {
            instId: input.instId,
            posSide: input.positionSide,
            side: input.expectedSide,
            reduceOnly: true,
            tdMode: input.tdModeUsed,
            ordType,
            sz: input.contracts,
            slTriggerPx: String(input.activeStopPrice),
            ...(input.wantsTp && input.activeTpPrice != null
                ? { tpTriggerPx: String(input.activeTpPrice) }
                : {}),
            algoClOrdId: attachId,
            attachAlgoClOrdId: attachId,
            attachAlgoOrdId: attachId,
            // clOrdId carries the legacy form so CL_ORD_ID_KEYS dedup still works
            // for orders already on exchange that were submitted with sl_ prefix.
            clOrdId: legacyAttachId,
            _protectiveInventorySource: "entry_attach_candidate"
        }
    ];
}

export function isOkxAlgoClOrdIdExistsError(input: Readonly<{
    sCode?: string | null;
    sMsg?: string | null;
}>): boolean {
    if (String(input.sCode ?? "") === OKX_ALGO_CL_ORD_ID_EXISTS) return true;
    const msg = String(input.sMsg ?? "").toLowerCase();
    return msg.includes("already exists") && msg.includes("algoclordid");
}

export function isOkxAlgoOrderDoesNotExistError(input: Readonly<{
    retCode?: string | null;
    sCode?: string | null;
}>): boolean {
    const code = String(input.retCode ?? input.sCode ?? "");
    return code === OKX_ALGO_ORDER_DOES_NOT_EXIST;
}

export function classifyProtectiveAlgoOrderLookupTry(lookupTry: Readonly<{
    ok: boolean;
    value?: readonly unknown[];
    diagnostics?: Readonly<{ retCode?: string; retMsg?: string; okxData?: unknown }>;
}>): ProtectiveAlgoOrderLookupState {
    if (lookupTry.ok) {
        return (lookupTry.value?.length ?? 0) > 0 ? "FOUND" : "ABSENT";
    }
    if (
        isOkxAlgoOrderDoesNotExistError({
            retCode: lookupTry.diagnostics?.retCode
        })
    ) {
        return "ABSENT";
    }
    return "ERROR";
}

export function mergeProtectiveInventoryAfterClOrdIdLookups(input: Readonly<{
    pendingRows: readonly ProtectiveAlgoRow[];
    attachRows: readonly ProtectiveAlgoRow[];
    clOrdCandidates: readonly string[];
    lookupRowsByClOrdId: Readonly<Record<string, ProtectiveAlgoOrderLookupState | ProtectiveAlgoRow>>;
}>): Readonly<{ inventory: ProtectiveAlgoRow[] | null; lookupAbsentCount: number }> {
    const pendingClSet = new Set<string>();
    for (const row of input.pendingRows) {
        for (const cl of normalizeProtectiveOrderClOrdIds(row)) pendingClSet.add(cl);
    }
    const lookupRows: ProtectiveAlgoRow[] = [];
    let lookupAbsentCount = 0;
    for (const clOrdId of input.clOrdCandidates) {
        if (pendingClSet.has(clOrdId)) continue;
        const outcome = input.lookupRowsByClOrdId[clOrdId];
        if (outcome === "ERROR") {
            return { inventory: null, lookupAbsentCount };
        }
        if (outcome === "ABSENT") {
            lookupAbsentCount += 1;
            continue;
        }
        if (outcome && typeof outcome === "object") {
            lookupRows.push(outcome);
        }
    }
    return {
        inventory: mergeProtectiveInventoryRows(input.pendingRows, input.attachRows, lookupRows),
        lookupAbsentCount
    };
}

export function isLiveOkxProtectiveAlgoState(stateRaw: unknown): boolean {
    const state = String(stateRaw ?? "").trim().toLowerCase();
    if (!state) return true;
    return state === "live" || state === "effective" || state === "partially_filled";
}

export type Protective51068Resolution =
    | Readonly<{ action: "adopt"; row: ProtectiveAlgoRow }>
    | Readonly<{ action: "stale_replace"; row: ProtectiveAlgoRow; cancelAlgoId: string }>
    | Readonly<{ action: "blocked_existing_unresolved"; clOrdId: string }>
    | Readonly<{ action: "not_found" }>;

export function resolve51068ProtectiveLookup(
    row: ProtectiveAlgoRow | null,
    ctx: ProtectiveReconcileContext,
    clOrdId: string
): Protective51068Resolution {
    if (!row) return { action: "not_found" };
    const state = row.state;
    if (state != null && !isLiveOkxProtectiveAlgoState(state)) {
        return { action: "not_found" };
    }
    const ev = evaluateProtectiveAlgoMatch(row, ctx);
    if (ev.adoptable) return { action: "adopt", row };
    if (ev.stale) {
        const cancelAlgoId = String(row.algoId ?? "").trim();
        if (cancelAlgoId) return { action: "stale_replace", row, cancelAlgoId };
    }
    return { action: "blocked_existing_unresolved", clOrdId };
}

export function protectiveClOrdIdBlockKey(symbol: string, side: string, clOrdId: string): string {
    return `${symbol}:${side}:${clOrdId}`;
}

const clOrdIdSubmitBlocked = new Set<string>();

export function isProtectiveClOrdIdSubmitBlocked(
    symbol: string,
    side: string,
    clOrdId: string
): boolean {
    return clOrdIdSubmitBlocked.has(protectiveClOrdIdBlockKey(symbol, side, clOrdId));
}

export function markProtectiveClOrdIdSubmitBlocked(
    symbol: string,
    side: string,
    clOrdId: string
): void {
    clOrdIdSubmitBlocked.add(protectiveClOrdIdBlockKey(symbol, side, clOrdId));
}

export function clearProtectiveClOrdIdSubmitBlocked(
    symbol: string,
    side: string,
    clOrdId: string
): void {
    clOrdIdSubmitBlocked.delete(protectiveClOrdIdBlockKey(symbol, side, clOrdId));
}

/** Clear all 51068 submit blocks for a symbol+side (position cycle end / authoritative flat). */
export function clearProtectiveClOrdIdBlocksForSymbolSide(symbol: string, side: string): void {
    const prefix = `${symbol}:${side}:`;
    for (const key of [...clOrdIdSubmitBlocked]) {
        if (key.startsWith(prefix)) clOrdIdSubmitBlocked.delete(key);
    }
}

export function resetProtectiveClOrdIdBlocksForTests(): void {
    clOrdIdSubmitBlocked.clear();
}

export function inventoryRowsMatchingClOrdId(
    inventory: readonly ProtectiveAlgoRow[],
    clOrdId: string
): ProtectiveAlgoRow[] {
    const target = String(clOrdId).trim();
    if (!target) return [];
    return inventory.filter((row) => normalizeProtectiveOrderClOrdIds(row).includes(target));
}
