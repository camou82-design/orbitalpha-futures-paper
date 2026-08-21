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
    entryPrice?: number | null;
}>;

export type ProtectiveReconcilePlan = Readonly<{
    canonicalSl: ProtectiveAlgoRow | null;
    canonicalTp: ProtectiveAlgoRow | null;
    cancelAlgoIds: string[];
    needSubmitSl: boolean;
    needSubmitTp: boolean;
    submitOco: boolean;
    slOnlyOcoRebuild: boolean;
    duplicateSlCount: number;
    duplicateTpCount: number;
    staleCount: number;
    manualIgnoredCount: number;
    uniqueProtectiveAlgoCount: number;
    matchingProtectivePendingCount: number;
    canonicalSlAlgoId: string | null;
    canonicalTpAlgoId: string | null;
    duplicateSlAlgoIds: string[];
    duplicateTpAlgoIds: string[];
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
    // New canonical form: "sl"/"tp" + alphanumeric body (no underscore)
    // Legacy form: "sl_"/"tp_" + entry clOrdId (kept for backward compat)
    return (
        algoClOrdId.startsWith("sl") ||
        algoClOrdId.startsWith("tp")
    ) && !algoClOrdId.startsWith("oap"); // must not collide with engine-owned prefix
}

function routingMatch(algo: ProtectiveAlgoRow, ctx: ProtectiveReconcileContext): boolean {
    if (String(algo.instId ?? "") !== ctx.instId) return false;
    if (!isReduceOnly(algo)) return false;
    if (!posSideOk(algo, ctx.positionSide)) return false;
    if (String(algo.side ?? "") !== ctx.expectedSide) return false;
    return String(algo.tdMode ?? "").toLowerCase() === ctx.tdModeUsed;
}

function rankScore(ev: ReturnType<typeof evaluateProtectiveAlgoMatch>, ctx?: ProtectiveReconcileContext): number {
    // When TP is not wanted (e.g. V2 TREND), a valid standalone SL order is preferred over an obsolete OCO containing a legacy TP.
    const ocoScore = ctx && !ctx.wantsTp
        ? (ev.slLegValid && !ev.isOco ? 100 : ev.ocoBothValid ? 80 : 0)
        : (ev.ocoBothValid ? 100 : ev.slLegValid && ev.tpLegValid ? 50 : 0);

    return (
        ocoScore +
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

    const isCloseFraction =
        algo.closeFraction === "1" ||
        String(algo.closeFraction ?? "") === "1";

    const algoSz = Number(algo.sz);
    const sizeMatch = isCloseFraction || protectiveContractSizesMatch(ctx.contractsToProtect, algoSz);
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

    const algoId = String(algo.algoId ?? "").trim();
    const hasExchangeIdentity = algoId.length > 0;

    const algoClOrdId = String(algo.algoClOrdId ?? "");
    const engineOwned = isEngineOwnedAlgo(algoClOrdId, ctx.openedAt36);
    const attachAlgo = isAttachAlgoClOrdId(algoClOrdId);

    const isBotOwnedCandidate = engineOwned || attachAlgo;
    const hasSlTrigger = extractPx(algo, "slTriggerPx") != null || isOco;
    const hasTpTrigger = extractPx(algo, "tpTriggerPx") != null;
    const isStandaloneTp = hasTpTrigger && !hasSlTrigger;
    const staleEligible = !isStandaloneTp || isBotOwnedCandidate;
    const stale = hasExchangeIdentity && staleEligible && routingMatch(algo, ctx) && !sizeMatch;

    // [BLOCKER 4-10] Authoritative Exchange Identity Requirement:
    // Synthetic candidates or structural fallback rows without real OKX algoId
    // can NEVER be adopted as canonical exchange protection.
    const adoptable = hasExchangeIdentity && (slLegValid || tpLegValid || ocoBothValid);

    return {
        adoptable,
        stale,
        slLegValid: hasExchangeIdentity ? (slLegValid || ocoBothValid) : false,
        tpLegValid: hasExchangeIdentity ? (ctx.wantsTp ? tpLegValid || ocoBothValid : false) : false,
        ocoBothValid: hasExchangeIdentity ? ocoBothValid : false,
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
    const duplicateSlAlgoIds: string[] = [];
    const duplicateTpAlgoIds: string[] = [];
    let duplicateSlCount = 0;
    let duplicateTpCount = 0;
    let staleCount = 0;
    let manualIgnoredCount = 0;

    const pushCancel = (id: string) => {
        if (id && !cancelAlgoIds.includes(id)) cancelAlgoIds.push(id);
    };

    // Dedupe evaluated list by algoId
    const seenAlgoIds = new Set<string>();
    const uniqueAlgos: ProtectiveAlgoRow[] = [];
    for (const algo of pendingAlgos) {
        const id = algoIdOf(algo);
        if (id.length > 0) {
            if (seenAlgoIds.has(id)) continue;
            seenAlgoIds.add(id);
        }
        uniqueAlgos.push(algo);
    }

    const evaluated = uniqueAlgos.map((algo) => ({
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
        .sort((a, b) => rankScore(b.ev, ctx) - rankScore(a.ev, ctx));

    for (const { algo, id, ev } of adoptableRanked) {
        const coversSl = ev.slLegValid;
        const coversTp = ctx.wantsTp && ev.tpLegValid;

        let duplicate = false;
        if (coversSl && canonicalSl && algoIdOf(canonicalSl) !== id) {
            duplicateSlCount += 1;
            if (id && !duplicateSlAlgoIds.includes(id)) duplicateSlAlgoIds.push(id);
            duplicate = true;
        }
        if (coversTp && canonicalTp && algoIdOf(canonicalTp) !== id) {
            duplicateTpCount += 1;
            if (id && !duplicateTpAlgoIds.includes(id)) duplicateTpAlgoIds.push(id);
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
        const isBotOwned = ev.engineOwned || ev.attachAlgo;
        if (!isBotOwned) manualIgnoredCount += 1;
    }

    // [V2_TREND_BOT_TP_CLEANUP] If TP is not wanted (wantsTp=false), any engine-owned / attach bot TP
    // order must be canceled as obsolete, while manual TP orders MUST remain completely untouched.
    if (!ctx.wantsTp) {
        for (const { algo, id, ev } of evaluated) {
            if (ev.engineOwned || ev.attachAlgo) {
                const hasTp = extractPx(algo, "tpTriggerPx") != null;
                const hasSl = extractPx(algo, "slTriggerPx") != null;
                if (hasTp && !hasSl && !ev.isOco) {
                    pushCancel(id);
                }
            }
        }
    }

    // [V2_TREND_LEGACY_OCO_TO_SL_ONLY_MIGRATION]
    // If TP is not wanted (wantsTp=false), and canonical SL is an obsolete bot-owned OCO containing a TP leg,
    // we must replace it with a standalone SL.
    // CRITICAL SAFETY: We do NOT add old OCO to cancelAlgoIds while it is the only live protection.
    // Old OCO remains live on exchange until a valid standalone SL is submitted, confirmed on exchange,
    // and supersedes it as canonicalSl (which automatically marks the old OCO as a duplicate for cancellation).
    let legacyOcoMigrationNeeded = false;
    if (!ctx.wantsTp && canonicalSl != null) {
        const isOco = String(canonicalSl.ordType ?? "").toLowerCase() === "oco";
        const hasTpLeg = extractPx(canonicalSl, "tpTriggerPx") != null;
        const clOrdId = String(canonicalSl.algoClOrdId ?? "");
        const isBotOwned = isEngineOwnedAlgo(clOrdId, ctx.openedAt36) || isAttachAlgoClOrdId(clOrdId);
        if (isOco && hasTpLeg && isBotOwned) {
            legacyOcoMigrationNeeded = true;
        }
    }

    const needSubmitSl = !canonicalSl || legacyOcoMigrationNeeded;
    const needSubmitTp = ctx.wantsTp && !canonicalTp;
    const slOnlyTpMissing = canonicalSl != null && ctx.wantsTp && !canonicalTp;
    const submitOco = (needSubmitSl && needSubmitTp && ctx.wantsTp) || slOnlyTpMissing;

    const slOnlyOcoRebuild = slOnlyTpMissing;

    const uniqueProtectiveAlgoCount = uniqueAlgos.length;
    const matchingProtectivePendingCount = adoptableRanked.length;

    return {
        canonicalSl,
        canonicalTp,
        cancelAlgoIds,
        needSubmitSl: submitOco ? false : needSubmitSl,
        needSubmitTp: submitOco ? false : needSubmitTp,
        submitOco,
        slOnlyOcoRebuild,
        duplicateSlCount,
        duplicateTpCount,
        staleCount,
        manualIgnoredCount,
        uniqueProtectiveAlgoCount,
        matchingProtectivePendingCount,
        canonicalSlAlgoId: canonicalSl ? algoIdOf(canonicalSl) || null : null,
        canonicalTpAlgoId: canonicalTp ? algoIdOf(canonicalTp) || null : null,
        duplicateSlAlgoIds,
        duplicateTpAlgoIds
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
