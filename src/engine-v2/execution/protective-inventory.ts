import {
    evaluateProtectiveAlgoMatch,
    type ProtectiveAlgoRow,
    type ProtectiveReconcileContext
} from "./protective-reconcile-plan";

export const OKX_ALGO_CL_ORD_ID_EXISTS = "51068";

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
    const attachId = `sl_${entryCl}`;
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
