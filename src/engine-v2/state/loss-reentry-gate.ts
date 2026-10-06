import type { PaperClosedPositionRecord, PaperOpenPositionRecord, MarketSymbol } from "../../models/types";
import { buildClosedRowFromPendingFinalize } from "../lifecycle/pending-finalize";

export interface LastLossReentryState {
    symbol: string;
    lastLossExitAt: number;
    lastLossExitSide: "long" | "short";
    lastLossExitPrice: number;
    lastLossEntryPrice: number;
    lastLossExitReason: string;
    lastLossExitCandleTs?: number;
    lastLossSetupIdentity?: string;
    realizedLossNetUsd: number;
    source?: "finalized_history" | "pending_finalize" | "runtime_close_meta";
}

export interface SameSideLossReentryGateInput {
    symbol: string;
    requestedSide: "long" | "short";
    currentPrice: number;
    now: number;
    lastLossState?: LastLossReentryState | null;
    candles?: ReadonlyArray<{ ts?: number; open?: number; high?: number; low?: number; close?: number }> | null;
    atr?: number | null;
    feeBreakEvenPct?: number | null;
    rangeBoxHigh?: number | null;
    rangeBoxLow?: number | null;
    rangeBoxMid?: number | null;
    regime?: string | null;
    subtype?: string | null;
    zone?: string | null;
    rangeCycleCount?: number | null;
    reversalConfirmed?: boolean | null;
    structuralEvent?: string | null;
    trendOk?: boolean | null;
    qualityScore?: number | null;
    htfEntryPolicy?: string | null;
    macroPolarity?: string | null;
    directionalShockState?: string | null;
}

export interface SameSideLossReentryGateResult {
    allowed: boolean;
    reason: string;
    evidence: string;
    displacementPct?: number;
    requiredDisplacementPct?: number;
    completedCandlesSinceLoss?: number;
}

export interface DeriveLastLossReentryStateOptions {
    history?: ReadonlyArray<PaperClosedPositionRecord | unknown> | null;
    openPositions?: ReadonlyArray<PaperOpenPositionRecord | unknown> | null;
    runtimeCloseMeta?: ReadonlyMap<string, {
        closedAt: number;
        side: "long" | "short";
        entryPrice?: number;
        closePrice?: number;
        pnlUsdNet?: number;
        closeReason?: string;
        regime?: string;
        zone?: string;
    }> | null;
    symbol: string;
    now?: number;
}

export function inferStructuralSetupEvent(input: Readonly<{
    subtype?: string | null;
    reversalConfirmed?: boolean | null;
}>): string {
    if (input.reversalConfirmed === true) return "confirmed_reversal";
    const s = String(input.subtype ?? "").toUpperCase();
    if (s.includes("BREAKOUT")) return "confirmed_breakout";
    if (s.includes("BREAKDOWN")) return "confirmed_breakdown";
    if (s.includes("RETEST")) return "confirmed_retest";
    if (s.includes("REVERSAL")) return "confirmed_reversal";
    if (s.includes("CONTINUATION")) return "confirmed_continuation";
    return "none";
}

export function computeSetupIdentity(input: {
    symbol: string;
    side?: string | null;
    regime?: string | null;
    zone?: string | null;
    boxHigh?: number | null;
    boxLow?: number | null;
}): string {
    const sym = String(input.symbol).toUpperCase();
    const side = String(input.side ?? "none").toLowerCase();
    const regime = String(input.regime ?? "UNKNOWN").toUpperCase();
    const zone = String(input.zone ?? "none").toLowerCase();
    return `${sym}:${side}:${regime}:${zone}`;
}

export function computeStructuralSetupIdentity(input: {
    symbol: string;
    side?: string | null;
    regime?: string | null;
    zone?: string | null;
    subtype?: string | null;
    structuralEvent?: string | null;
}): string {
    const base = computeSetupIdentity(input);
    const subtype = String(input.subtype ?? "none").toLowerCase();
    const event = String(input.structuralEvent ?? "none").toLowerCase();
    return `${base}:${subtype}:${event}`;
}

export function countCompletedCandlesSince(
    candles: ReadonlyArray<{ ts?: number; timestamp?: number }> | null | undefined,
    sinceTs: number,
    nowMs: number,
    intervalMs = 60_000
): number {
    if (!candles || candles.length === 0) return 0;
    let count = 0;
    for (const c of candles) {
        const cTs = Number(c?.ts ?? (c as any)?.timestamp ?? 0);
        if (!Number.isFinite(cTs) || cTs <= sinceTs) continue;
        if (cTs + intervalMs > nowMs) continue;
        count += 1;
    }
    return count;
}

function emitSameSideLossReentryProof(
    input: SameSideLossReentryGateInput,
    result: SameSideLossReentryGateResult,
    extra: Record<string, unknown> = {}
): void {
    console.info(JSON.stringify({
        event: "V2_SAME_SIDE_LOSS_REENTRY_PROOF",
        symbol: input.symbol,
        requestedSide: input.requestedSide,
        action: result.allowed ? "ALLOW" : "BLOCK",
        reason: result.reason,
        evidence: result.evidence,
        lastLossExitAt: input.lastLossState?.lastLossExitAt ?? null,
        lastLossExitSide: input.lastLossState?.lastLossExitSide ?? null,
        lastLossEntryPrice: input.lastLossState?.lastLossEntryPrice ?? null,
        lastLossExitPrice: input.lastLossState?.lastLossExitPrice ?? null,
        currentPrice: input.currentPrice,
        directionalDisplacementPct: result.displacementPct ?? null,
        requiredDisplacementPct: result.requiredDisplacementPct ?? null,
        completedCandlesSinceLoss: result.completedCandlesSinceLoss ?? null,
        lastLossSetupIdentity: input.lastLossState?.lastLossSetupIdentity ?? null,
        currentSetupIdentity: extra.currentSetupIdentity ?? null,
        lossSource: input.lastLossState?.source ?? null,
        trendOk: input.trendOk ?? false,
        qualityScore: input.qualityScore ?? 0,
        htfEntryPolicy: input.htfEntryPolicy ?? null,
        macroPolarity: input.macroPolarity ?? null,
        directionalShockState: input.directionalShockState ?? null,
        strongTrendRevalidated: extra.strongTrendRevalidated ?? false,
        ...extra
    }));
}

function computeDirectionalDisplacementPct(
    requestedSide: "long" | "short",
    currentPrice: number,
    entryLossPrice: number,
    exitLossPrice: number
): Readonly<{ pct: number; favorable: boolean }> {
    if (requestedSide === "short") {
        const zoneTop = Math.max(entryLossPrice, exitLossPrice);
        const favorable = currentPrice < zoneTop;
        const pct = favorable ? (zoneTop - currentPrice) / zoneTop : 0;
        return { pct, favorable };
    }
    const zoneBottom = Math.min(entryLossPrice, exitLossPrice);
    const favorable = currentPrice > zoneBottom;
    const pct = favorable ? (currentPrice - zoneBottom) / zoneBottom : 0;
    return { pct, favorable };
}

/**
 * Hydrates the latest net loss position for the given symbol from multiple authoritative sources:
 * 1. Finalized history (history.json / cachedHistory)
 * 2. Pending-completed-trade durable records (positions.json open positions with finalizePending === true)
 * 3. Runtime close meta
 * 
 * Supports both options object or legacy (history, symbol, openPositions, now) signature.
 */
export function deriveLastLossReentryState(
    historyOrOptions: ReadonlyArray<PaperClosedPositionRecord | unknown> | DeriveLastLossReentryStateOptions | null | undefined,
    symbolOrOpens?: string | ReadonlyArray<PaperOpenPositionRecord | unknown> | null,
    openPositionsArg?: ReadonlyArray<PaperOpenPositionRecord | unknown> | null,
    nowArg?: number
): LastLossReentryState | null {
    let history: ReadonlyArray<unknown> = [];
    let openPositions: ReadonlyArray<unknown> = [];
    let runtimeCloseMeta: DeriveLastLossReentryStateOptions["runtimeCloseMeta"] = null;
    let symbol = "";
    let now = Date.now();

    if (historyOrOptions && typeof historyOrOptions === "object" && !Array.isArray(historyOrOptions) && "symbol" in historyOrOptions) {
        const opts = historyOrOptions as DeriveLastLossReentryStateOptions;
        history = Array.isArray(opts.history) ? opts.history : [];
        openPositions = Array.isArray(opts.openPositions) ? opts.openPositions : [];
        runtimeCloseMeta = opts.runtimeCloseMeta ?? null;
        symbol = String(opts.symbol);
        now = typeof opts.now === "number" ? opts.now : Date.now();
    } else {
        history = Array.isArray(historyOrOptions) ? historyOrOptions : [];
        if (typeof symbolOrOpens === "string") {
            symbol = symbolOrOpens;
            openPositions = Array.isArray(openPositionsArg) ? openPositionsArg : [];
            now = typeof nowArg === "number" ? nowArg : Date.now();
        }
    }

    if (!symbol) return null;
    const symUpper = symbol.toUpperCase();

    interface UnifiedCandidate {
        symbol: string;
        side: "long" | "short";
        openedAt: number;
        closedAt: number;
        entryPrice: number;
        exitPrice: number;
        pnlNet: number;
        pnlGross: number;
        closeReason: string;
        setupId?: string;
        exitCandleTs?: number;
        source: "finalized_history" | "pending_finalize" | "runtime_close_meta";
        dedupeKey: string;
    }

    const candidateMap = new Map<string, UnifiedCandidate>();

    // 1. Ingest finalized history
    for (const row of history) {
        if (!row || typeof row !== "object") continue;
        const r = row as any;
        if (String(r.symbol).toUpperCase() !== symUpper) continue;
        const closedAt = Number(r.closedAt ?? 0);
        const openedAt = Number(r.openedAt ?? 0);
        const side = r.side === "long" || r.side === "LONG" ? "long" : r.side === "short" || r.side === "SHORT" ? "short" : null;
        if (!side || !Number.isFinite(closedAt) || closedAt <= 0) continue;

        const pnlNet = typeof r.pnlUsdNet === "number" ? r.pnlUsdNet : (typeof r.pnlUsd === "number" ? r.pnlUsd : (typeof r.realizedPnlUsd === "number" ? r.realizedPnlUsd : 0));
        const pnlGross = typeof r.pnlUsdGross === "number" ? r.pnlUsdGross : pnlNet;
        const entryPrice = Number(r.entryAvgPx ?? r.entryPrice ?? 0);
        const exitPrice = Number(r.exitAvgPx ?? r.closePrice ?? 0);
        const closeReason = String(r.exitPolicyReason ?? r.finalCloseReason ?? r.closeReason ?? "unknown");
        const setupId = computeStructuralSetupIdentity({
            symbol: symUpper,
            side,
            regime: r.regimeAtEntry ?? r.entryRegime,
            zone: r.entryZone ?? r.rangeEntryZone,
            subtype: r.marketSubtype ?? r.subtype,
            structuralEvent: inferStructuralSetupEvent({ subtype: r.marketSubtype ?? r.subtype })
        });

        const dedupeKey = r.flowId ? String(r.flowId) : `${symUpper}:${side}:${openedAt}:${closedAt}`;
        candidateMap.set(dedupeKey, {
            symbol: symUpper,
            side,
            openedAt,
            closedAt,
            entryPrice,
            exitPrice,
            pnlNet,
            pnlGross,
            closeReason,
            setupId,
            exitCandleTs: typeof r.exitCandleTs === "number" ? r.exitCandleTs : (closedAt > 0 ? Math.floor(closedAt / 60000) * 60000 : undefined),
            source: "finalized_history",
            dedupeKey
        });
    }

    // 2. Ingest pending-completed-trade durable records (open positions with finalizePending === true)
    for (const open of openPositions) {
        if (!open || typeof open !== "object") continue;
        const o = open as PaperOpenPositionRecord;
        if (String(o.symbol).toUpperCase() !== symUpper) continue;
        if (o.finalizePending !== true) continue;

        const closedRow = buildClosedRowFromPendingFinalize(o, now);
        if (!closedRow) continue;

        const closedAt = Number(closedRow.closedAt ?? now);
        const openedAt = Number(closedRow.openedAt ?? o.openedAt ?? 0);
        const side = closedRow.side === "long" ? "long" : closedRow.side === "short" ? "short" : null;
        if (!side) continue;

        const pnlNet = Number(closedRow.pnlUsdNet ?? 0);
        const pnlGross = Number(closedRow.pnlUsdGross ?? pnlNet);
        const entryPrice = Number(closedRow.entryPrice ?? 0);
        const exitPrice = Number(closedRow.closePrice ?? 0);
        const closeReason = String(closedRow.closeReason ?? closedRow.exitReason ?? "pending_finalize");
        const setupId = computeStructuralSetupIdentity({
            symbol: symUpper,
            side,
            regime: (o as any).regimeAtEntry ?? (o as any).entryRegime,
            zone: (o as any).entryZone ?? (o as any).rangeEntryZone,
            subtype: (o as any).marketSubtype ?? (o as any).subtype,
            structuralEvent: inferStructuralSetupEvent({ subtype: (o as any).marketSubtype ?? (o as any).subtype })
        });

        const dedupeKey = o.pendingFinalizeFlowId ? String(o.pendingFinalizeFlowId) : `${symUpper}:${side}:${openedAt}:${closedAt}`;
        // If not already in map or if this pending row is newer/same, prioritize
        if (!candidateMap.has(dedupeKey)) {
            candidateMap.set(dedupeKey, {
                symbol: symUpper,
                side,
                openedAt,
                closedAt,
                entryPrice,
                exitPrice,
                pnlNet,
                pnlGross,
                closeReason,
                setupId,
                exitCandleTs: Math.floor(closedAt / 60000) * 60000,
                source: "pending_finalize",
                dedupeKey
            });
        }
    }

    // 3. Ingest runtime close meta
    if (runtimeCloseMeta && runtimeCloseMeta.has(symUpper)) {
        const meta = runtimeCloseMeta.get(symUpper)!;
        const closedAt = Number(meta.closedAt ?? 0);
        const side = meta.side === "long" ? "long" : meta.side === "short" ? "short" : null;
        if (side && closedAt > 0 && meta.entryPrice && meta.closePrice) {
            const dedupeKey = `${symUpper}:${side}:runtime:${closedAt}`;
            if (!candidateMap.has(dedupeKey)) {
                const pnlNet = meta.pnlUsdNet ?? (side === "long" ? meta.closePrice - meta.entryPrice : meta.entryPrice - meta.closePrice);
                candidateMap.set(dedupeKey, {
                    symbol: symUpper,
                    side,
                    openedAt: 0,
                    closedAt,
                    entryPrice: meta.entryPrice,
                    exitPrice: meta.closePrice,
                    pnlNet,
                    pnlGross: pnlNet,
                    closeReason: meta.closeReason ?? "runtime_close",
                    setupId: computeStructuralSetupIdentity({ symbol: symUpper, side, regime: meta.regime, zone: meta.zone }),
                    exitCandleTs: Math.floor(closedAt / 60000) * 60000,
                    source: "runtime_close_meta",
                    dedupeKey
                });
            }
        }
    }

    if (candidateMap.size === 0) {
        return null;
    }

    // Sort candidates by closedAt descending to find the latest closed trade
    const sorted = Array.from(candidateMap.values()).sort((a, b) => b.closedAt - a.closedAt);
    const latest = sorted[0];

    const isLoss = latest.pnlNet < -0.0001 ||
        latest.pnlGross < -0.0001 ||
        latest.closeReason.includes("stop") ||
        latest.closeReason.includes("box_break") ||
        latest.closeReason.includes("loss");

    if (isLoss && latest.entryPrice > 0 && latest.exitPrice > 0) {
        return {
            symbol: symUpper,
            lastLossExitAt: latest.closedAt,
            lastLossExitSide: latest.side,
            lastLossExitPrice: latest.exitPrice,
            lastLossEntryPrice: latest.entryPrice,
            lastLossExitReason: latest.closeReason,
            lastLossExitCandleTs: latest.exitCandleTs,
            lastLossSetupIdentity: latest.setupId,
            realizedLossNetUsd: latest.pnlNet,
            source: latest.source
        };
    }

    // The latest closed position for this symbol was a profit/flat trade -> no active loss state
    return null;
}

/**
 * Evaluates whether a new same-side entry should be blocked due to re-entry hysteresis on same price zone,
 * or allowed due to legitimate price displacement / fresh setup regeneration / opposite reversal.
 */
export function evaluateSameSideLossReentryGate(
    input: SameSideLossReentryGateInput
): SameSideLossReentryGateResult {
    const { symbol, requestedSide, currentPrice, now, lastLossState, candles, atr, feeBreakEvenPct } = input;

    // 1. If no previous loss state exists for symbol -> ALLOW
    if (!lastLossState) {
        const result: SameSideLossReentryGateResult = {
            allowed: true,
            reason: "NO_PRIOR_LOSS_ACTIVE",
            evidence: "no_prior_loss_for_symbol"
        };
        emitSameSideLossReentryProof(input, result);
        return result;
    }

    // 2. If requested side is OPPOSITE to the last loss side -> ALLOW
    if (requestedSide !== lastLossState.lastLossExitSide) {
        const result: SameSideLossReentryGateResult = {
            allowed: true,
            reason: "OPPOSITE_SIDE_REVERSAL_ALLOWED",
            evidence: `opposite_side_reversal|lossSide=${lastLossState.lastLossExitSide}|reqSide=${requestedSide}`
        };
        emitSameSideLossReentryProof(input, result);
        return result;
    }

    const entryLossPrice = lastLossState.lastLossEntryPrice;
    const exitLossPrice = lastLossState.lastLossExitPrice;
    if (entryLossPrice <= 0 || currentPrice <= 0) {
        const result: SameSideLossReentryGateResult = {
            allowed: true,
            reason: "INVALID_PRICE_DATA_PASSTHROUGH",
            evidence: "invalid_price_data"
        };
        emitSameSideLossReentryProof(input, result);
        return result;
    }

    const atrPct = typeof atr === "number" && atr > 0 ? (atr / currentPrice) : 0.003;
    const feeBufferPct = typeof feeBreakEvenPct === "number" && feeBreakEvenPct > 0 ? feeBreakEvenPct * 1.5 : 0.0035;
    const boxWidthPct = typeof input.rangeBoxHigh === "number" && typeof input.rangeBoxLow === "number" && input.rangeBoxHigh > input.rangeBoxLow
        ? (input.rangeBoxHigh - input.rangeBoxLow) / currentPrice
        : 0;
    const boxRelativePct = boxWidthPct > 0 ? boxWidthPct * 0.35 : 0.0035;
    const requiredDisplacementPct = Math.max(0.0035, Math.min(0.015, Math.max(atrPct * 0.75, feeBufferPct, boxRelativePct)));

    const directional = computeDirectionalDisplacementPct(requestedSide, currentPrice, entryLossPrice, exitLossPrice);
    const hasMeaningfulDisplacement = directional.favorable && directional.pct >= requiredDisplacementPct;

    const lossTs = lastLossState.lastLossExitCandleTs ?? lastLossState.lastLossExitAt;
    const completedCandlesSinceLoss = countCompletedCandlesSince(candles ?? null, lossTs, now);

    const structuralEvent =
        input.structuralEvent ??
        inferStructuralSetupEvent({ subtype: input.subtype, reversalConfirmed: input.reversalConfirmed });
    const currentSetupIdentity = computeStructuralSetupIdentity({
        symbol,
        side: requestedSide,
        regime: input.regime,
        zone: input.zone,
        subtype: input.subtype,
        structuralEvent
    });

    const hasEnoughCandles = completedCandlesSinceLoss >= 5;
    const setupIdentityChanged =
        lastLossState.lastLossSetupIdentity != null &&
        currentSetupIdentity !== lastLossState.lastLossSetupIdentity;
    const hasStructuralEvent = structuralEvent !== "none";
    const isFreshSetupRegenerated =
        hasEnoughCandles &&
        hasStructuralEvent &&
        (setupIdentityChanged || input.reversalConfirmed === true);

    // Strong Trend Revalidation Conditions (authoritative TREND strongly confirmed after loss)
    const trendOk = input.trendOk === true;
    const qualityScore = typeof input.qualityScore === "number" ? input.qualityScore : 0;
    const htfEntryPolicy = typeof input.htfEntryPolicy === "string" ? input.htfEntryPolicy.trim().toUpperCase() : null;
    const macroPolarity = typeof input.macroPolarity === "string" ? input.macroPolarity.trim().toUpperCase() : null;
    const directionalShockState = typeof input.directionalShockState === "string" ? input.directionalShockState.trim().toUpperCase() : null;
    const regime = String(input.regime ?? "").toUpperCase();

    const isTrendRegime = regime === "TREND";
    const hasQualityScore = qualityScore >= 70;

    const isHtfAligned = requestedSide === "long"
        ? (htfEntryPolicy === "ALLOW" || htfEntryPolicy === "LONG_ONLY_OR_NONE")
        : (htfEntryPolicy === "ALLOW" || htfEntryPolicy === "SHORT_ONLY_OR_NONE");

    const isMacroAligned = requestedSide === "long"
        ? (macroPolarity === "BULLISH" || macroPolarity === "NEUTRAL")
        : (macroPolarity === "BEARISH" || macroPolarity === "NEUTRAL");

    const isShockAligned = requestedSide === "long"
        ? (directionalShockState === "NONE" || directionalShockState === "UP")
        : (directionalShockState === "NONE" || directionalShockState === "DOWN");

    const isStrongTrendRevalidated =
        isTrendRegime &&
        trendOk &&
        hasQualityScore &&
        isHtfAligned &&
        isMacroAligned &&
        isShockAligned &&
        hasEnoughCandles;

    if (hasMeaningfulDisplacement) {
        const result: SameSideLossReentryGateResult = {
            allowed: true,
            reason: "MEANINGFUL_DIRECTIONAL_DISPLACEMENT_ALLOWED",
            evidence: `dirDispPct=${(directional.pct * 100).toFixed(3)}%|req=${(requiredDisplacementPct * 100).toFixed(3)}%|candles=${completedCandlesSinceLoss}`,
            displacementPct: directional.pct,
            requiredDisplacementPct,
            completedCandlesSinceLoss
        };
        emitSameSideLossReentryProof(input, result, { currentSetupIdentity, structuralEvent });
        return result;
    }

    if (isFreshSetupRegenerated) {
        const result: SameSideLossReentryGateResult = {
            allowed: true,
            reason: "FRESH_STRUCTURAL_SETUP_CONFIRMED",
            evidence: `candlesSinceLoss=${completedCandlesSinceLoss}|setupChanged=${setupIdentityChanged}|structuralEvent=${structuralEvent}`,
            displacementPct: directional.pct,
            requiredDisplacementPct,
            completedCandlesSinceLoss
        };
        emitSameSideLossReentryProof(input, result, { currentSetupIdentity, structuralEvent });
        return result;
    }

    if (isStrongTrendRevalidated) {
        const result: SameSideLossReentryGateResult = {
            allowed: true,
            reason: "STRONG_TREND_REVALIDATED_AFTER_LOSS",
            evidence: `candlesSinceLoss=${completedCandlesSinceLoss}|trendOk=${trendOk}|qualityScore=${qualityScore}|htfPolicy=${htfEntryPolicy}|macro=${macroPolarity}|shock=${directionalShockState}`,
            displacementPct: directional.pct,
            requiredDisplacementPct,
            completedCandlesSinceLoss
        };
        emitSameSideLossReentryProof(input, result, { currentSetupIdentity, structuralEvent, strongTrendRevalidated: true });
        return result;
    }

    const blockResult: SameSideLossReentryGateResult = {
        allowed: false,
        reason: "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED",
        evidence: `same_zone_loss_churn_blocked|dirDispPct=${(directional.pct * 100).toFixed(3)}%<${(requiredDisplacementPct * 100).toFixed(3)}%|favorable=${directional.favorable}|candlesSinceLoss=${completedCandlesSinceLoss}|structuralEvent=${structuralEvent}|lossReason=${lastLossState.lastLossExitReason}`,
        displacementPct: directional.pct,
        requiredDisplacementPct,
        completedCandlesSinceLoss
    };
    emitSameSideLossReentryProof(input, blockResult, { currentSetupIdentity, structuralEvent, strongTrendRevalidated: false });
    return blockResult;
}

export interface OppositeSideLossReentryGateInput extends SameSideLossReentryGateInput {}

export interface OppositeSideLossReentryGateResult {
    allowed: boolean;
    reason: string;
    evidence: string;
    elapsedMs?: number;
    requiredCooldownMs?: number;
    completedCandlesSinceLoss?: number;
}

export function emitOppositeSideLossReentryProof(
    input: OppositeSideLossReentryGateInput,
    result: OppositeSideLossReentryGateResult,
    extra: Record<string, unknown> = {}
): void {
    console.info(JSON.stringify({
        event: "V2_OPPOSITE_SIDE_LOSS_REENTRY_PROOF",
        symbol: input.symbol,
        requestedSide: input.requestedSide,
        action: result.allowed ? "ALLOW" : "BLOCK",
        reason: result.reason,
        evidence: result.evidence,
        lastLossExitAt: input.lastLossState?.lastLossExitAt ?? null,
        lastLossExitSide: input.lastLossState?.lastLossExitSide ?? null,
        lastLossExitPrice: input.lastLossState?.lastLossExitPrice ?? null,
        currentPrice: input.currentPrice,
        elapsedMs: result.elapsedMs ?? null,
        requiredCooldownMs: result.requiredCooldownMs ?? 300_000,
        completedCandlesSinceLoss: result.completedCandlesSinceLoss ?? null,
        reversalConfirmed: input.reversalConfirmed ?? false,
        structuralEvent: input.structuralEvent ?? null,
        ...extra
    }));
}

/**
 * Evaluates whether a new opposite-side entry after a loss / stop-loss termination should be:
 * - BLOCKED due to premature reversal churn / whipsaw noise (minimum 300s + at least one 5m completed candle)
 * - BLOCKED due to lack of structural reversal confirmation (reversalConfirmed / breakout / retest)
 * - ALLOWED when minimum time elapsed, 5m structural confirmation established, and structural reversal confirmed.
 */
export function evaluateOppositeSideLossReentryGate(
    input: OppositeSideLossReentryGateInput
): OppositeSideLossReentryGateResult {
    const { symbol, requestedSide, currentPrice, now, lastLossState, candles } = input;

    // 1. 이전 손절 이력 없으면 즉시 허용
    if (!lastLossState) {
        const result: OppositeSideLossReentryGateResult = {
            allowed: true,
            reason: "NO_PRIOR_LOSS_ACTIVE",
            evidence: "no_prior_loss_for_symbol"
        };
        emitOppositeSideLossReentryProof(input, result);
        return result;
    }

    // 2. 동일 방향 요청인 경우 opposite 게이트 대상 아님 (pass-through)
    if (requestedSide === lastLossState.lastLossExitSide) {
        const result: OppositeSideLossReentryGateResult = {
            allowed: true,
            reason: "SAME_SIDE_NOT_APPLICABLE_TO_OPPOSITE_GATE",
            evidence: `same_side|lossSide=${lastLossState.lastLossExitSide}|reqSide=${requestedSide}`
        };
        return result;
    }

    // 3. 반대방향 진입 시도 평가
    const lossExitAt = lastLossState.lastLossExitAt;
    const elapsedMs = Math.max(0, now - lossExitAt);
    const requiredCooldownMs = 300_000; // 최소 300초 (5분)

    // Gate A: 최소 시간 확인 (300초 미만은 무조건 휩쏘 방지로 차단)
    if (elapsedMs < requiredCooldownMs) {
        const result: OppositeSideLossReentryGateResult = {
            allowed: false,
            reason: "OPPOSITE_SIDE_LOSS_COOLDOWN_ACTIVE",
            evidence: `opposite_side_cooldown_active|elapsedSec=${Math.floor(elapsedMs / 1000)}s<300s|lossSide=${lastLossState.lastLossExitSide}|reqSide=${requestedSide}`,
            elapsedMs,
            requiredCooldownMs
        };
        emitOppositeSideLossReentryProof(input, result);
        return result;
    }

    // Gate B: 손절 이후 완성된 봉 카운트 (최소 5분봉 1개 상당 = 1분봉 5개 이상)
    const lossTs = lastLossState.lastLossExitCandleTs ?? lastLossState.lastLossExitAt;
    const completedCandlesSinceLoss = countCompletedCandlesSince(candles ?? null, lossTs, now);
    // 만약 캔들이 제공되었으나 완성된 캔들이 5개 미만(5분 미만 봉)인 경우 차단
    if (candles && candles.length > 0 && completedCandlesSinceLoss < 5) {
        const result: OppositeSideLossReentryGateResult = {
            allowed: false,
            reason: "OPPOSITE_SIDE_INSUFFICIENT_COMPLETED_CANDLES",
            evidence: `insufficient_candles|completed=${completedCandlesSinceLoss}<5|lossSide=${lastLossState.lastLossExitSide}|reqSide=${requestedSide}`,
            elapsedMs,
            requiredCooldownMs,
            completedCandlesSinceLoss
        };
        emitOppositeSideLossReentryProof(input, result);
        return result;
    }

    // Gate C: 반대방향 구조 확인 (reversalConfirmed, breakout/retest, reclaim/rejection 등)
    const structuralEvent = input.structuralEvent ?? inferStructuralSetupEvent({
        subtype: input.subtype,
        reversalConfirmed: input.reversalConfirmed
    });
    const reversalConfirmed = input.reversalConfirmed === true;
    const subtypeUpper = String(input.subtype ?? "").toUpperCase();
    const hasStructuralReversal =
        reversalConfirmed ||
        structuralEvent === "confirmed_reversal" ||
        structuralEvent === "confirmed_breakout" ||
        structuralEvent === "confirmed_breakdown" ||
        structuralEvent === "confirmed_retest" ||
        subtypeUpper.includes("REVERSAL") ||
        subtypeUpper.includes("BREAKOUT") ||
        subtypeUpper.includes("BREAKDOWN") ||
        subtypeUpper.includes("RETEST") ||
        subtypeUpper.includes("RECLAIM") ||
        subtypeUpper.includes("REJECTION");

    if (!hasStructuralReversal) {
        const result: OppositeSideLossReentryGateResult = {
            allowed: false,
            reason: "OPPOSITE_SIDE_STRUCTURAL_CONFIRMATION_REQUIRED",
            evidence: `no_structural_reversal_confirmation|reversalConfirmed=false|structuralEvent=${structuralEvent}|subtype=${input.subtype}`,
            elapsedMs,
            requiredCooldownMs,
            completedCandlesSinceLoss
        };
        emitOppositeSideLossReentryProof(input, result);
        return result;
    }

    // 모든 조건 통과 -> 반대방향 구조적 반전 진입 허용!
    const allowResult: OppositeSideLossReentryGateResult = {
        allowed: true,
        reason: "OPPOSITE_SIDE_STRUCTURAL_REVERSAL_ALLOWED",
        evidence: `opposite_reversal_confirmed|elapsedSec=${Math.floor(elapsedMs / 1000)}s|candles=${completedCandlesSinceLoss}|structuralEvent=${structuralEvent}`,
        elapsedMs,
        requiredCooldownMs,
        completedCandlesSinceLoss
    };
    emitOppositeSideLossReentryProof(input, allowResult);
    return allowResult;
}
