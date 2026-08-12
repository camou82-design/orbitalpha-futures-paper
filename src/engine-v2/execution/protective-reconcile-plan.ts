import {
    protectiveContractSizesMatch,
    protectiveStopPricesMatch
} from "./protective-match";

export type ProtectiveAlgoRow = Readonly<Record<string, unknown>>;

export type ProtectiveReconcileContext = Readonly<{
    instId: string;
    positionSide: "long" | "short";
    openedAt36: string;
    tdModeUsed: string;
    contractsToProtect: number;
    activeStopPrice: number;
    activeTpPrice: number | null;
    wantsTp: boolean;
    expectedSide: "buy" | "sell";
    tickSz: number;
}>;

export type ProtectiveReconcilePlan = Readonly<{
    canonicalSl: ProtectiveAlgoRow | null;
    canonicalTp: ProtectiveAlgoRow | null;
    cancelAlgoIds: string[];
    needSubmitSl: boolean;
    needSubmitTp: boolean;
    submitOco: boolean;
    duplicateSlCount: number;
    duplicateTpCount: number;
    staleCount: number;
    manualIgnoredCount: number;
}>;

function algoIdOf(algo: ProtectiveAlgoRow): string {
    return String(algo.algoId ?? "");
}

function extractPx(algo: ProtectiveAlgoRow, key: "slTriggerPx" | "tpTriggerPx"): number | null {
    const val = algo[key];
    const n = typeof val === "number" ? val : typeof val === "string" ? Number(val) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
}

function isReduceOnly(algo: ProtectiveAlgoRow): boolean {
    return algo.reduceOnly === true || String(algo.reduceOnly ?? "").toLowerCase() === "true";
}

function posSideOk(algo: ProtectiveAlgoRow, positionSide: "long" | "short"): boolean {
    const ps = String(algo.posSide ?? "net").trim().toLowerCase();
    return ps === "net" || ps === positionSide;
}

function isEngineOwnedAlgo(algoClOrdId: string, openedAt36: string): boolean {
    return algoClOrdId.startsWith("oap") && algoClOrdId.includes(openedAt36);
}

function isAttachAlgoClOrdId(algoClOrdId: string): boolean {
    return algoClOrdId.startsWith("sl_") || algoClOrdId.startsWith("tp_");
}

function routingMatch(algo: ProtectiveAlgoRow, ctx: ProtectiveReconcileContext): boolean {
    if (String(algo.instId ?? "") !== ctx.instId) return false;
    if (!isReduceOnly(algo)) return false;
    if (!posSideOk(algo, ctx.positionSide)) return false;
    if (String(algo.side ?? "") !== ctx.expectedSide) return false;
    return String(algo.tdMode ?? "").toLowerCase() === ctx.tdModeUsed;
}

function rankScore(ev: ReturnType<typeof evaluateProtectiveAlgoMatch>): number {
    return (
        (ev.ocoBothValid ? 100 : 0) +
        (ev.slLegValid && ev.tpLegValid ? 50 : 0) +
        (ev.engineOwned ? 20 : 0) +
        (ev.attachAlgo ? 10 : 0) +
        (ev.adoptable ? 5 : 0)
    );
}

export function evaluateProtectiveAlgoMatch(
    algo: ProtectiveAlgoRow,
    ctx: ProtectiveReconcileContext
): Readonly<{
    adoptable: boolean;
    stale: boolean;
    slLegValid: boolean;
    tpLegValid: boolean;
    ocoBothValid: boolean;
    isOco: boolean;
    engineOwned: boolean;
    attachAlgo: boolean;
}> {
    const zero = {
        adoptable: false,
        stale: false,
        slLegValid: false,
        tpLegValid: false,
        ocoBothValid: false,
        isOco: false,
        engineOwned: false,
        attachAlgo: false
    };
    if (String(algo.instId ?? "") !== ctx.instId) return zero;
    if (!isReduceOnly(algo)) return zero;
    if (!posSideOk(algo, ctx.positionSide)) return zero;
    if (String(algo.side ?? "") !== ctx.expectedSide) return zero;

    const tdMode = String(algo.tdMode ?? "").toLowerCase();
    if (tdMode !== ctx.tdModeUsed) {
        return { ...zero, stale: routingMatch(algo, ctx) || true };
    }

    const algoSz = Number(algo.sz);
    const sizeMatch = protectiveContractSizesMatch(ctx.contractsToProtect, algoSz);
    const slPx = extractPx(algo, "slTriggerPx");
    const tpPx = extractPx(algo, "tpTriggerPx");
    const isOco = String(algo.ordType ?? "").toLowerCase() === "oco";

    const slPriceOk =
        slPx != null && protectiveStopPricesMatch(ctx.activeStopPrice, slPx, ctx.tickSz);
    const tpPriceOk =
        ctx.wantsTp &&
        ctx.activeTpPrice != null &&
        tpPx != null &&
        protectiveStopPricesMatch(ctx.activeTpPrice, tpPx, ctx.tickSz);

    const slLegValid = slPriceOk && sizeMatch;
    const tpLegValid = tpPriceOk && sizeMatch;
    const ocoBothValid = isOco && slLegValid && (!ctx.wantsTp || tpLegValid);
    const adoptable = slLegValid || tpLegValid || ocoBothValid;

    const algoClOrdId = String(algo.algoClOrdId ?? "");
    const engineOwned = isEngineOwnedAlgo(algoClOrdId, ctx.openedAt36);
    const attachAlgo = isAttachAlgoClOrdId(algoClOrdId);

    const stale = routingMatch(algo, ctx) && !sizeMatch;

    return {
        adoptable,
        stale,
        slLegValid: slLegValid || ocoBothValid,
        tpLegValid: ctx.wantsTp ? tpLegValid || ocoBothValid : false,
        ocoBothValid,
        isOco,
        engineOwned,
        attachAlgo
    };
}

export function planProtectiveOrderReconcile(
    pendingAlgos: readonly ProtectiveAlgoRow[],
    ctx: ProtectiveReconcileContext
): ProtectiveReconcilePlan {
    let canonicalSl: ProtectiveAlgoRow | null = null;
    let canonicalTp: ProtectiveAlgoRow | null = null;
    const cancelAlgoIds: string[] = [];
    let duplicateSlCount = 0;
    let duplicateTpCount = 0;
    let staleCount = 0;
    let manualIgnoredCount = 0;

    const pushCancel = (id: string) => {
        if (id && !cancelAlgoIds.includes(id)) cancelAlgoIds.push(id);
    };

    const evaluated = pendingAlgos.map((algo) => ({
        algo,
        id: algoIdOf(algo),
        ev: evaluateProtectiveAlgoMatch(algo, ctx)
    }));

    for (const { id, ev } of evaluated) {
        if (ev.stale) {
            staleCount += 1;
            pushCancel(id);
        }
    }

    const adoptableRanked = evaluated
        .filter(({ ev }) => !ev.stale && ev.adoptable)
        .sort((a, b) => rankScore(b.ev) - rankScore(a.ev));

    for (const { algo, id, ev } of adoptableRanked) {
        const coversSl = ev.slLegValid;
        const coversTp = ctx.wantsTp && ev.tpLegValid;

        let duplicate = false;
        if (coversSl && canonicalSl && algoIdOf(canonicalSl) !== id) {
            duplicateSlCount += 1;
            duplicate = true;
        }
        if (coversTp && canonicalTp && algoIdOf(canonicalTp) !== id) {
            duplicateTpCount += 1;
            duplicate = true;
        }
        if (duplicate) {
            pushCancel(id);
            continue;
        }

        if (coversSl && !canonicalSl) canonicalSl = algo;
        if (coversTp && !canonicalTp) canonicalTp = algo;

        if (ev.ocoBothValid && ev.isOco) {
            if (!canonicalSl) canonicalSl = algo;
            if (ctx.wantsTp && !canonicalTp) canonicalTp = algo;
        }
    }

    for (const { algo, ev } of evaluated) {
        if (ev.stale || ev.adoptable) continue;
        if (!routingMatch(algo, ctx)) continue;
        const cl = String(algo.algoClOrdId ?? "");
        if (cl !== "") manualIgnoredCount += 1;
    }

    const needSubmitSl = !canonicalSl;
    const needSubmitTp = ctx.wantsTp && !canonicalTp;
    const submitOco = needSubmitSl && needSubmitTp && ctx.wantsTp;

    return {
        canonicalSl,
        canonicalTp,
        cancelAlgoIds,
        needSubmitSl: submitOco ? false : needSubmitSl,
        needSubmitTp: submitOco ? false : needSubmitTp,
        submitOco,
        duplicateSlCount,
        duplicateTpCount,
        staleCount,
        manualIgnoredCount
    };
}

export type ProtectiveSubmitInflightLock = Readonly<{
    key: string;
    acquired: boolean;
    joinedExisting: boolean;
}>;

const inflightByKey = new Map<string, Promise<unknown>>();

export function acquireProtectiveSubmitInflightLock<T>(
    key: string,
    run: () => Promise<T>
): Readonly<{ lock: ProtectiveSubmitInflightLock; promise: Promise<T> }> {
    const existing = inflightByKey.get(key);
    if (existing) {
        return {
            lock: { key, acquired: false, joinedExisting: true },
            promise: existing as Promise<T>
        };
    }
    const promise = run().finally(() => {
        if (inflightByKey.get(key) === promise) {
            inflightByKey.delete(key);
        }
    });
    inflightByKey.set(key, promise);
    return {
        lock: { key, acquired: true, joinedExisting: false },
        promise
    };
}

/** Test-only reset */
export function resetProtectiveSubmitInflightLocksForTests(): void {
    inflightByKey.clear();
}
