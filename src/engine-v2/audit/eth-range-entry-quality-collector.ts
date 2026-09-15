import type { Candle } from "../../models/types";
import {
    evaluateEthRangeEntryFeasibilityGate,
    type EthRangeEntryFeasibilityResult
} from "../execution/eth-range-entry-feasibility-gate";
import type { RangeDriftEntryTimingGateResult } from "../market-judgment/range-drift-entry-timing-gate";
import {
    createEthRangeEntryQualityStore,
    type EthRangeEntryQualityStoreWriter
} from "./eth-range-entry-quality-store";

export type EthRangeEntryQualityCandidateSide = "long" | "short";

export type EthRangeEntryQualityOpportunityRecord = Readonly<{
    opportunityId: string;
    runCycleId: string | number | null;
    symbol: "ETHUSDT";
    candidateSide: EthRangeEntryQualityCandidateSide;
    evaluatedAt: number;
    closedCandleTs: number | null;
    eventualFlowId: string | null;

    canonicalRegime: string;
    marketSubtype: string | null;
    rangePhase: string | null;
    transitionPhase: string | null;
    shockPhase: string | null;
    boxHigh: number | null;
    boxLow: number | null;
    boxMid: number | null;
    boxPos: number | null;
    boxWidthBps: number | null;

    lastPrice: number | null;
    distanceToBoxMidBps: number | null;
    directionalProfitSpaceBps: number | null;
    requiredProfitSpaceBps: number | null;
    profitSpaceSurplusBps: number | null;

    rangeCenterSlopeNow: number | null;
    rangeCenterSlope1mAgo: number | null;
    rangeCenterSlope2mAgo: number | null;
    ema20SlopeNow: number | null;
    ema20Slope1mAgo: number | null;
    ema20Slope2mAgo: number | null;
    boxHighSlope: number | null;
    boxLowSlope: number | null;
    boxPosNow: number | null;
    boxPos1mAgo: number | null;
    boxPos2mAgo: number | null;
    boxPos3mAgo: number | null;
    boxPosVelocity1m: number | null;
    boxPosVelocity2m: number | null;
    boxPosAcceleration: number | null;
    rangeCenterSlopeAcceleration: number | null;
    ema20SlopeChange1m: number | null;
    ema20SlopeChange2m: number | null;

    atr: number | null;
    atrPct: number | null;
    atrChange1m: number | null;
    atrChange3m: number | null;
    atrToBoxWidth: number | null;
    volumeRatio: number | null;
    volumeChange1m: number | null;
    volumeChange3m: number | null;
    boxWidthChange1m: number | null;
    boxWidthChange3m: number | null;

    last3ClosedCandleOhlc: Array<{ open: number; high: number; low: number; close: number; ts: number | null }> | null;
    last3BodyBps: number[] | null;
    last3WickRatio: number[] | null;
    higherLowDetected: boolean | null;
    lowerHighDetected: boolean | null;
    reclaimConfirmed: boolean | null;
    rejectionConfirmed: boolean | null;
    reversalConfirmed: boolean | null;

    htf5mBias: string | null;
    htf15mBias: string | null;
    htf1hBias: string | null;
    htf4hBias: string | null;
    htf1dBias: string | null;
    candidateSideAligned5m: boolean | null;
    candidateSideAligned15m: boolean | null;
    candidateSideAligned1h: boolean | null;
    candidateSideAligned4h: boolean | null;
    candidateSideAligned1d: boolean | null;

    feasibilityEvaluated: boolean | null;
    feasibilityPassed: boolean | null;
    feasibilityBlockReason: string | null;
    estimatedRoundTripCostBps: number | null;
    driftEvaluated: boolean | null;
    driftConfirmed: boolean | null;
    driftDirection: string | null;
    driftReactionConfirmed: boolean | null;
    driftBlockReason: string | null;
    finalAuthorityDecision: string | null;
    finalAuthoritySide: string | null;
    finalRejectReason: string | null;

    setupFingerprint: string;
}>;

export type EthRangeEntryQualityCollectContext = Readonly<{
    runCycleId?: string | number | null;
    symbol: string;
    evaluatedAt: number;
    canonicalRegime: string;
    candidateSide: EthRangeEntryQualityCandidateSide | null;
    judgment: Readonly<{
        regime?: string;
        subtype?: string | null;
        rangePhase?: string | null;
        shockPhase?: string | null;
        trendPhase?: string | null;
        transitionPhase?: string | null;
        htf_bias?: Partial<Record<"m5" | "m15" | "h1" | "h4" | "d1", string>> | null;
        reversalConfirmed?: boolean | null;
    }>;
    snapshot: Readonly<{
        lastPrice?: number | null;
        latestCandleClose?: number | null;
        boxHigh?: number | null;
        boxLow?: number | null;
        boxPos?: number | null;
        rangeCenterSlope?: number | null;
        ema20Slope?: number | null;
        boxHighSlope?: number | null;
        boxLowSlope?: number | null;
        atr?: number | null;
        atr20?: number | null;
        volumeRatio?: number | null;
        volume_ratio?: number | null;
    }> | null;
    candles: readonly Candle[] | null | undefined;
    feasibility: EthRangeEntryFeasibilityResult | null;
    drift: RangeDriftEntryTimingGateResult | null;
    finalDecision: string;
    finalSide: string;
    finalRejectReason: string | null;
    reclaimConfirmed?: boolean | null;
    rejectionConfirmed?: boolean | null;
    reversalConfirmed?: boolean | null;
    dataDir?: string | null;
}>;

let defaultStore: EthRangeEntryQualityStoreWriter | null = null;
let customStore: EthRangeEntryQualityStoreWriter | null = null;
const seenOpportunityIds = new Set<string>();
const pendingFlowLinks = new Map<string, { opportunityId: string; evaluatedAt: number }>();

function storeWriter(dataDir?: string | null): EthRangeEntryQualityStoreWriter {
    if (customStore) return customStore;
    if (!defaultStore) {
        defaultStore = createEthRangeEntryQualityStore(dataDir);
    }
    return defaultStore;
}

export function setEthRangeEntryQualityStoreForTests(store: EthRangeEntryQualityStoreWriter | null): void {
    customStore = store;
}

export function resetEthRangeEntryQualityCollectorStateForTests(): void {
    seenOpportunityIds.clear();
    pendingFlowLinks.clear();
    customStore = null;
    defaultStore = null;
}

export function getEthRangeEntryQualitySeenOpportunityCountForTests(): number {
    return seenOpportunityIds.size;
}

export function getEthRangeEntryQualityPendingFlowLinkForTests(key: string): { opportunityId: string; evaluatedAt: number } | undefined {
    return pendingFlowLinks.get(key);
}

function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function closedCandlesOnly(candles: readonly Candle[] | null | undefined): Candle[] {
    if (!candles || candles.length < 2) return [];
    return candles.slice(0, -1) as Candle[];
}

function candleAt(closed: readonly Candle[], offsetFromLast: number): Candle | null {
    const idx = closed.length - 1 + offsetFromLast;
    if (idx < 0 || idx >= closed.length) return null;
    return closed[idx] ?? null;
}

function boxPosFromClose(close: number | null, boxHigh: number | null, boxLow: number | null): number | null {
    if (close == null || boxHigh == null || boxLow == null || boxHigh <= boxLow) return null;
    return (close - boxLow) / (boxHigh - boxLow);
}

function bodyBps(c: Candle): number {
    if (!c.open) return 0;
    return ((c.close - c.open) / c.open) * 10000;
}

function wickRatio(c: Candle): number {
    const rng = Math.max(c.high - c.low, 1e-9);
    return (rng - Math.abs(c.close - c.open)) / rng;
}

function biasAligned(side: EthRangeEntryQualityCandidateSide, bias: string | null | undefined): boolean | null {
    if (!bias) return null;
    const b = String(bias).toUpperCase();
    if (b === "CONFLICT" || b === "DATA_NOT_READY" || b === "UNKNOWN") return false;
    if (side === "long") return b === "BULLISH" || b === "UP" || b === "LONG" || b === "RANGE";
    return b === "BEARISH" || b === "DOWN" || b === "SHORT" || b === "RANGE";
}

function slopeSeries(_closed: readonly Candle[], _field: "center"): number[] {
    return [];
}

export function buildSetupFingerprint(input: {
    candidateSide: EthRangeEntryQualityCandidateSide;
    rangePhase: string | null;
    marketSubtype: string | null;
    boxPos: number | null;
}): string {
    const bp =
        input.boxPos == null ? "na" : String(Math.round(input.boxPos * 100) / 100);
    return [
        input.candidateSide,
        input.rangePhase ?? "na",
        input.marketSubtype ?? "na",
        bp
    ].join("|");
}

export function buildEthRangeEntryQualityOpportunityId(input: {
    symbol: string;
    closedCandleTs: number | null;
    candidateSide: EthRangeEntryQualityCandidateSide;
    setupFingerprint: string;
}): string {
    return `${input.symbol}:${input.closedCandleTs ?? "na"}:${input.candidateSide}:${input.setupFingerprint}`;
}

export function resolveEthRangeEntryQualityCandidateSide(
    ...candidates: Array<string | null | undefined>
): EthRangeEntryQualityCandidateSide | null {
    for (const raw of candidates) {
        if (raw === "long" || raw === "short") return raw;
    }
    return null;
}

function supplementFeasibilityForAudit(
    ctx: EthRangeEntryQualityCollectContext
): EthRangeEntryFeasibilityResult | null {
    if (ctx.feasibility) return ctx.feasibility;
    if (String(ctx.symbol).toUpperCase() !== "ETHUSDT") return null;
    if (String(ctx.canonicalRegime).toUpperCase() !== "RANGE") return null;
    if (!ctx.candidateSide) return null;
    const snap = ctx.snapshot ?? {};
    const entryPrice = num(snap.lastPrice) ?? num(snap.latestCandleClose);
    if (entryPrice == null || entryPrice <= 0) return null;
    const boxHigh = num(snap.boxHigh);
    const boxLow = num(snap.boxLow);
    const boxMid = boxHigh != null && boxLow != null ? (boxHigh + boxLow) / 2 : null;
    try {
        return evaluateEthRangeEntryFeasibilityGate({
            symbol: "ETHUSDT",
            side: ctx.candidateSide,
            regime: "RANGE",
            marketSubtype: ctx.judgment.subtype ?? null,
            entryPrice,
            boxHigh,
            boxLow,
            boxMid,
            atr: num(snap.atr) ?? num(snap.atr20),
            emitProof: false
        });
    } catch {
        return null;
    }
}

export function buildEthRangeEntryQualityOpportunityRecord(
    ctx: EthRangeEntryQualityCollectContext
): EthRangeEntryQualityOpportunityRecord | null {
    if (String(ctx.symbol).toUpperCase() !== "ETHUSDT") return null;
    if (String(ctx.canonicalRegime).toUpperCase() !== "RANGE") return null;
    if (!ctx.candidateSide) return null;

    const feasibility = supplementFeasibilityForAudit(ctx);
    const side = ctx.candidateSide;
    const snap = ctx.snapshot ?? {};
    const closed = closedCandlesOnly(ctx.candles ?? null);
    const lastClosed = candleAt(closed, 0);
    const closedCandleTs = lastClosed?.ts ?? null;

    const boxHigh = num(snap.boxHigh);
    const boxLow = num(snap.boxLow);
    const boxMid =
        boxHigh != null && boxLow != null ? (boxHigh + boxLow) / 2 : null;
    const lastPrice = num(snap.lastPrice) ?? num(snap.latestCandleClose);

    const boxPosNow =
        num(snap.boxPos) ??
        boxPosFromClose(lastClosed?.close ?? null, boxHigh, boxLow);
    const boxPos1 = boxPosFromClose(candleAt(closed, -1)?.close ?? null, boxHigh, boxLow);
    const boxPos2 = boxPosFromClose(candleAt(closed, -2)?.close ?? null, boxHigh, boxLow);
    const boxPos3 = boxPosFromClose(candleAt(closed, -3)?.close ?? null, boxHigh, boxLow);

    const boxWidthBps =
        boxHigh != null && boxLow != null && lastPrice != null && lastPrice > 0
            ? ((boxHigh - boxLow) / lastPrice) * 10000
            : num(feasibility?.box_width_bps ?? null);

    const distanceToBoxMidBps =
        boxMid != null && lastPrice != null && lastPrice > 0
            ? (Math.abs(lastPrice - boxMid) / lastPrice) * 10000
            : null;

    const directionalProfitSpaceBps = num(feasibility?.directional_profit_space_bps ?? null);
    const requiredProfitSpaceBps = num(feasibility?.required_profit_space_bps ?? null);
    const profitSpaceSurplusBps =
        directionalProfitSpaceBps != null && requiredProfitSpaceBps != null
            ? directionalProfitSpaceBps - requiredProfitSpaceBps
            : null;

    const rcNow = num(snap.rangeCenterSlope);
    const emaNow = num(snap.ema20Slope);
    const rcSeries = slopeSeries(closed, "center");
    const rc1 = rcSeries.length >= 2 ? rcSeries[rcSeries.length - 2] : null;
    const rc2 = rcSeries.length >= 3 ? rcSeries[rcSeries.length - 3] : null;

    const boxPosVelocity1m =
        boxPosNow != null && boxPos1 != null ? boxPosNow - boxPos1 : null;
    const boxPosVelocity2m =
        boxPosNow != null && boxPos2 != null ? boxPosNow - boxPos2 : null;
    const boxPosAcceleration =
        boxPosVelocity1m != null && boxPos1 != null && boxPos2 != null
            ? boxPosVelocity1m - (boxPos1 - boxPos2)
            : null;

    const atr = num(snap.atr) ?? num(snap.atr20);
    const atrPct = atr != null && lastPrice != null && lastPrice > 0 ? atr / lastPrice : null;
    const atrToBoxWidth =
        atr != null && boxWidthBps != null && boxWidthBps > 0
            ? atr / (boxWidthBps / 10000)
            : null;

    const last3 = closed.slice(-3);
    const last3Body = last3.length ? last3.map(bodyBps) : null;
    const last3Wick = last3.length ? last3.map(wickRatio) : null;
    const last3Ohlc = last3.length
        ? last3.map((c) => ({
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              ts: c.ts ?? null
          }))
        : null;

    const cPrev = candleAt(closed, -1);
    const cPrev2 = candleAt(closed, -2);
    const higherLowDetected =
        lastClosed && cPrev ? lastClosed.low > cPrev.low : null;
    const lowerHighDetected =
        lastClosed && cPrev ? lastClosed.high < cPrev.high : null;

    const htf = ctx.judgment.htf_bias ?? {};
    const htf5 = htf.m5 ?? null;
    const htf15 = htf.m15 ?? null;
    const htf1 = htf.h1 ?? null;
    const htf4 = htf.h4 ?? null;
    const htf1d = htf.d1 ?? null;

    const marketSubtype = ctx.judgment.subtype ?? null;
    const rangePhase = ctx.judgment.rangePhase ?? null;
    const setupFingerprint = buildSetupFingerprint({
        candidateSide: side,
        rangePhase,
        marketSubtype,
        boxPos: boxPosNow
    });

    const opportunityId = buildEthRangeEntryQualityOpportunityId({
        symbol: "ETHUSDT",
        closedCandleTs,
        candidateSide: side,
        setupFingerprint
    });

    const volNow = lastClosed?.volume ?? null;
    const vol1 = cPrev?.volume ?? null;
    const vol3 = candleAt(closed, -3)?.volume ?? null;
    const volumeChange1m =
        volNow != null && vol1 != null && vol1 > 0 ? volNow / vol1 - 1 : null;
    const volumeChange3m =
        volNow != null && vol3 != null && vol3 > 0 ? volNow / vol3 - 1 : null;

    const widthNow = boxWidthBps;
    const width1 =
        boxHigh != null && boxLow != null && cPrev?.close != null && cPrev.close > 0
            ? ((boxHigh - boxLow) / cPrev.close) * 10000
            : null;
    const width3 =
        boxHigh != null && boxLow != null && cPrev2?.close != null && cPrev2.close > 0
            ? ((boxHigh - boxLow) / cPrev2.close) * 10000
            : null;

    return {
        opportunityId,
        runCycleId: ctx.runCycleId ?? null,
        symbol: "ETHUSDT",
        candidateSide: side,
        evaluatedAt: ctx.evaluatedAt,
        closedCandleTs,
        eventualFlowId: null,

        canonicalRegime: "RANGE",
        marketSubtype,
        rangePhase,
        transitionPhase: ctx.judgment.transitionPhase ?? ctx.judgment.trendPhase ?? null,
        shockPhase: ctx.judgment.shockPhase ?? null,
        boxHigh,
        boxLow,
        boxMid,
        boxPos: boxPosNow,
        boxWidthBps: widthNow,

        lastPrice,
        distanceToBoxMidBps,
        directionalProfitSpaceBps,
        requiredProfitSpaceBps,
        profitSpaceSurplusBps,

        rangeCenterSlopeNow: rcNow,
        rangeCenterSlope1mAgo: rc1,
        rangeCenterSlope2mAgo: rc2,
        ema20SlopeNow: emaNow,
        ema20Slope1mAgo: null,
        ema20Slope2mAgo: null,
        boxHighSlope: num(snap.boxHighSlope),
        boxLowSlope: num(snap.boxLowSlope),
        boxPosNow,
        boxPos1mAgo: boxPos1,
        boxPos2mAgo: boxPos2,
        boxPos3mAgo: boxPos3,
        boxPosVelocity1m,
        boxPosVelocity2m,
        boxPosAcceleration,
        rangeCenterSlopeAcceleration:
            rcNow != null && rc1 != null ? rcNow - rc1 : null,
        ema20SlopeChange1m: null,
        ema20SlopeChange2m: null,

        atr,
        atrPct,
        atrChange1m: null,
        atrChange3m: null,
        atrToBoxWidth,
        volumeRatio: num(snap.volumeRatio) ?? num(snap.volume_ratio),
        volumeChange1m,
        volumeChange3m,
        boxWidthChange1m:
            widthNow != null && width1 != null ? widthNow - width1 : null,
        boxWidthChange3m:
            widthNow != null && width3 != null ? widthNow - width3 : null,

        last3ClosedCandleOhlc: last3Ohlc,
        last3BodyBps: last3Body,
        last3WickRatio: last3Wick,
        higherLowDetected,
        lowerHighDetected,
        reclaimConfirmed: ctx.reclaimConfirmed ?? ctx.drift?.reclaimConfirmed ?? null,
        rejectionConfirmed: ctx.rejectionConfirmed ?? ctx.drift?.rejectionConfirmed ?? null,
        reversalConfirmed:
            ctx.reversalConfirmed ??
            ctx.judgment.reversalConfirmed ??
            ctx.drift?.reversalConfirmed ??
            null,

        htf5mBias: htf5,
        htf15mBias: htf15,
        htf1hBias: htf1,
        htf4hBias: htf4,
        htf1dBias: htf1d,
        candidateSideAligned5m: biasAligned(side, htf5),
        candidateSideAligned15m: biasAligned(side, htf15),
        candidateSideAligned1h: biasAligned(side, htf1),
        candidateSideAligned4h: biasAligned(side, htf4),
        candidateSideAligned1d: biasAligned(side, htf1d),

        feasibilityEvaluated: feasibility?.feasibility_evaluated ?? null,
        feasibilityPassed: feasibility?.feasibility_passed ?? null,
        feasibilityBlockReason: feasibility?.blockReason ?? null,
        estimatedRoundTripCostBps: num(feasibility?.estimated_round_trip_cost_bps ?? null),
        driftEvaluated: ctx.drift != null,
        driftConfirmed: ctx.drift?.driftConfirmed ?? null,
        driftDirection: ctx.drift?.driftDirection ?? null,
        driftReactionConfirmed: ctx.drift?.reactionConfirmed ?? null,
        driftBlockReason: ctx.drift?.blockedOrWaited ? ctx.drift.reason : null,
        finalAuthorityDecision: ctx.finalDecision,
        finalAuthoritySide: ctx.finalSide,
        finalRejectReason: ctx.finalRejectReason,

        setupFingerprint
    };
}

export function captureEthRangeEntryQualityOpportunity(ctx: EthRangeEntryQualityCollectContext): boolean {
    try {
        if (String(ctx.symbol).toUpperCase() !== "ETHUSDT") return false;
        const record = buildEthRangeEntryQualityOpportunityRecord(ctx);
        if (!record) return false;
        if (seenOpportunityIds.has(record.opportunityId)) return false;
        seenOpportunityIds.add(record.opportunityId);

        const linkKey = `${ctx.runCycleId ?? "na"}:${record.candidateSide}:${record.closedCandleTs ?? "na"}`;
        pendingFlowLinks.set(linkKey, {
            opportunityId: record.opportunityId,
            evaluatedAt: record.evaluatedAt
        });

        storeWriter(ctx.dataDir).appendOpportunityLine(JSON.stringify(record));
        return true;
    } catch {
        return false;
    }
}

export function maybeRegisterEthRangeEntryQualityFill(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    openedAt: number;
    regimeAtEntry?: string | null;
    runCycleId?: string | number | null;
    dataDir?: string | null;
}>): void {
    if (String(input.symbol).toUpperCase() !== "ETHUSDT") return;
    if (String(input.regimeAtEntry ?? "RANGE").toUpperCase() !== "RANGE") return;
    registerEthRangeEntryQualityFlowLink({
        symbol: input.symbol,
        side: input.side,
        openedAt: input.openedAt,
        flowId: `${input.symbol}:${input.side}:${input.openedAt}`,
        runCycleId: input.runCycleId ?? null,
        dataDir: input.dataDir ?? null
    });
}

export function registerEthRangeEntryQualityFlowLink(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    openedAt: number;
    flowId: string;
    runCycleId?: string | number | null;
    dataDir?: string | null;
}>): void {
    try {
        if (String(input.symbol).toUpperCase() !== "ETHUSDT") return;
        const keys = [
            `${input.runCycleId ?? "na"}:${input.side}:${input.openedAt}`,
            `${input.runCycleId ?? "na"}:${input.side}:na`
        ];
        let opportunityId: string | null = null;
        for (const k of keys) {
            const hit = pendingFlowLinks.get(k);
            if (hit) {
                opportunityId = hit.opportunityId;
                break;
            }
        }
        if (!opportunityId) {
            for (const [k, v] of pendingFlowLinks.entries()) {
                if (k.endsWith(`:${input.side}:na`) || k.includes(`:${input.side}:`)) {
                    if (Math.abs(v.evaluatedAt - input.openedAt) <= 300_000) {
                        opportunityId = v.opportunityId;
                        break;
                    }
                }
            }
        }
        const row = {
            event: "ETH_RANGE_ENTRY_QUALITY_FLOW_LINK",
            flowId: input.flowId,
            opportunityId,
            symbol: "ETHUSDT",
            side: input.side,
            openedAt: input.openedAt,
            runCycleId: input.runCycleId ?? null,
            linkedAt: Date.now()
        };
        storeWriter(input.dataDir).appendOutcomeLine(JSON.stringify(row));
    } catch {
        /* fail-open */
    }
}
