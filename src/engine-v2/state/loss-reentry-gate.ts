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
    const bHigh = typeof input.boxHigh === "number" && input.boxHigh > 0 ? (Math.round(input.boxHigh * 10) / 10).toFixed(1) : "0";
    const bLow = typeof input.boxLow === "number" && input.boxLow > 0 ? (Math.round(input.boxLow * 10) / 10).toFixed(1) : "0";
    return `${sym}:${side}:${regime}:${zone}:H${bHigh}:L${bLow}`;
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
        const setupId = r.setupIdentity ?? computeSetupIdentity({
            symbol: symUpper,
            side,
            regime: r.regimeAtEntry ?? r.entryRegime,
            zone: r.entryZone ?? r.rangeEntryZone,
            boxHigh: r.boxHighAtEntry,
            boxLow: r.boxLowAtEntry
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
        const setupId = computeSetupIdentity({
            symbol: symUpper,
            side,
            regime: (o as any).regimeAtEntry ?? (o as any).entryRegime,
            zone: (o as any).entryZone ?? (o as any).rangeEntryZone,
            boxHigh: (o as any).boxHighAtEntry,
            boxLow: (o as any).boxLowAtEntry
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
                    setupId: computeSetupIdentity({ symbol: symUpper, side, regime: meta.regime, zone: meta.zone }),
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
        return {
            allowed: true,
            reason: "NO_PRIOR_LOSS_ACTIVE",
            evidence: "no_prior_loss_for_symbol"
        };
    }

    // 2. If requested side is OPPOSITE to the last loss side -> ALLOW
    // (e.g. SHORT loss -> valid LONG reversal setup)
    if (requestedSide !== lastLossState.lastLossExitSide) {
        const result: SameSideLossReentryGateResult = {
            allowed: true,
            reason: "OPPOSITE_SIDE_REVERSAL_ALLOWED",
            evidence: `opposite_side_reversal|lossSide=${lastLossState.lastLossExitSide}|reqSide=${requestedSide}`
        };
        console.info(JSON.stringify({
            event: "V2_SAME_SIDE_LOSS_REENTRY_PROOF",
            symbol,
            requestedSide,
            action: "ALLOW",
            reason: result.reason,
            evidence: result.evidence,
            lastLossExitSide: lastLossState.lastLossExitSide,
            lastLossExitPrice: lastLossState.lastLossExitPrice,
            lastLossEntryPrice: lastLossState.lastLossEntryPrice,
            currentPrice
        }));
        return result;
    }

    // --- SAME SIDE EVALUATION ---
    const entryLossPrice = lastLossState.lastLossEntryPrice;
    const exitLossPrice = lastLossState.lastLossExitPrice;
    if (entryLossPrice <= 0 || currentPrice <= 0) {
        return {
            allowed: true,
            reason: "INVALID_PRICE_DATA_PASSTHROUGH",
            evidence: "invalid_price_data"
        };
    }

    // 3. Measure price displacement relative to the loss zone
    // Distance from both the prior entry and prior exit
    const distFromEntryPct = Math.abs(currentPrice - entryLossPrice) / entryLossPrice;
    const distFromExitPct = exitLossPrice > 0 ? Math.abs(currentPrice - exitLossPrice) / exitLossPrice : distFromEntryPct;
    const zoneDistPct = Math.min(distFromEntryPct, distFromExitPct);

    // Baseline required displacement threshold:
    // Uses ATR, fee break-even, and box width if available, minimum 0.35% (35 bps)
    const atrPct = typeof atr === "number" && atr > 0 ? (atr / currentPrice) : 0.003;
    const feeBufferPct = typeof feeBreakEvenPct === "number" && feeBreakEvenPct > 0 ? feeBreakEvenPct * 1.5 : 0.0035;
    const boxWidthPct = typeof input.rangeBoxHigh === "number" && typeof input.rangeBoxLow === "number" && input.rangeBoxHigh > input.rangeBoxLow
        ? (input.rangeBoxHigh - input.rangeBoxLow) / currentPrice
        : 0;
    const boxRelativePct = boxWidthPct > 0 ? boxWidthPct * 0.35 : 0.0035;

    const requiredDisplacementPct = Math.max(0.0035, Math.min(0.015, Math.max(atrPct * 0.75, feeBufferPct, boxRelativePct)));

    const hasMeaningfulDisplacement = zoneDistPct >= requiredDisplacementPct;

    // 4. Measure completed candle count since loss exit
    let completedCandlesSinceLoss = 0;
    if (candles && Array.isArray(candles) && candles.length > 0) {
        const lossTs = lastLossState.lastLossExitCandleTs ?? lastLossState.lastLossExitAt;
        for (let i = candles.length - 1; i >= 0; i--) {
            const c = candles[i];
            const cTs = Number(c?.ts ?? 0);
            if (cTs > lossTs) {
                completedCandlesSinceLoss++;
            } else {
                break;
            }
        }
    } else if (lastLossState.lastLossExitAt > 0 && now > lastLossState.lastLossExitAt) {
        // Fallback approximation from elapsed time (1m bars)
        completedCandlesSinceLoss = Math.floor((now - lastLossState.lastLossExitAt) / 60000);
    }

    // Fresh setup criteria (STRICT):
    // A. At least 5 completed 1m candles since the loss exit AND
    // B. Setup identity MUST have genuinely changed OR reversalConfirmed
    // NOTE: rangeCycleCount increment alone is explicitly INSUFFICIENT.
    const hasEnoughCandles = completedCandlesSinceLoss >= 5;
    const currentSetupIdentity = computeSetupIdentity({
        symbol,
        side: requestedSide,
        regime: input.regime,
        zone: input.zone,
        boxHigh: input.rangeBoxHigh,
        boxLow: input.rangeBoxLow
    });

    const setupIdentityChanged = lastLossState.lastLossSetupIdentity != null &&
        currentSetupIdentity !== lastLossState.lastLossSetupIdentity;

    const isFreshSetupRegenerated = hasEnoughCandles && (setupIdentityChanged || input.reversalConfirmed === true);

    // 5. Decision:
    if (hasMeaningfulDisplacement) {
        const result: SameSideLossReentryGateResult = {
            allowed: true,
            reason: "MEANINGFUL_PRICE_DISPLACEMENT_ALLOWED",
            evidence: `zoneDistPct=${(zoneDistPct * 100).toFixed(3)}%|req=${(requiredDisplacementPct * 100).toFixed(3)}%|candles=${completedCandlesSinceLoss}`,
            displacementPct: zoneDistPct,
            requiredDisplacementPct,
            completedCandlesSinceLoss
        };
        console.info(JSON.stringify({
            event: "V2_SAME_SIDE_LOSS_REENTRY_PROOF",
            symbol,
            requestedSide,
            action: "ALLOW",
            reason: result.reason,
            evidence: result.evidence,
            zoneDistPct,
            requiredDisplacementPct,
            completedCandlesSinceLoss,
            currentPrice,
            lastLossEntryPrice: entryLossPrice,
            lastLossExitPrice: exitLossPrice
        }));
        return result;
    }

    if (isFreshSetupRegenerated) {
        const result: SameSideLossReentryGateResult = {
            allowed: true,
            reason: "FRESH_CANDLE_SETUP_CONFIRMED",
            evidence: `candlesSinceLoss=${completedCandlesSinceLoss}|setupChanged=${setupIdentityChanged}|reversalConfirmed=${input.reversalConfirmed === true}`,
            displacementPct: zoneDistPct,
            requiredDisplacementPct,
            completedCandlesSinceLoss
        };
        console.info(JSON.stringify({
            event: "V2_SAME_SIDE_LOSS_REENTRY_PROOF",
            symbol,
            requestedSide,
            action: "ALLOW",
            reason: result.reason,
            evidence: result.evidence,
            zoneDistPct,
            requiredDisplacementPct,
            completedCandlesSinceLoss,
            currentPrice,
            lastLossEntryPrice: entryLossPrice,
            lastLossExitPrice: exitLossPrice
        }));
        return result;
    }

    // Block same-side re-entry in same price zone without fresh setup
    const blockResult: SameSideLossReentryGateResult = {
        allowed: false,
        reason: "SAME_SIDE_LOSS_REENTRY_HYSTERESIS_BLOCKED",
        evidence: `same_zone_loss_churn_blocked|zoneDistPct=${(zoneDistPct * 100).toFixed(3)}%<${(requiredDisplacementPct * 100).toFixed(3)}%|candlesSinceLoss=${completedCandlesSinceLoss}|setupChanged=${setupIdentityChanged}|lossReason=${lastLossState.lastLossExitReason}`,
        displacementPct: zoneDistPct,
        requiredDisplacementPct,
        completedCandlesSinceLoss
    };

    console.info(JSON.stringify({
        event: "V2_SAME_SIDE_LOSS_REENTRY_PROOF",
        symbol,
        requestedSide,
        action: "BLOCK",
        reason: blockResult.reason,
        evidence: blockResult.evidence,
        zoneDistPct,
        requiredDisplacementPct,
        completedCandlesSinceLoss,
        currentPrice,
        lastLossEntryPrice: entryLossPrice,
        lastLossExitPrice: exitLossPrice,
        lastLossExitReason: lastLossState.lastLossExitReason,
        lastLossExitAt: lastLossState.lastLossExitAt,
        lossSource: lastLossState.source
    }));

    return blockResult;
}
