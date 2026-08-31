/**
 * tickSz bridge propagation regressions (Classification A fix).
 *
 * A. ETH — tickSz supplied only at V2BridgeSnapshot propagates end-to-end
 * B. BTC — symmetric
 * C. Negative — no bridge tickSz => INSTRUMENT_TICK_SZ_UNAVAILABLE (fail-closed)
 * D. Production-like ETH WHIPSAW shock promotion — live-signed path must not tick-block
 */

import assert from "node:assert/strict";
import { adaptV2Input } from "../engine-v2/index";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { resolveSymbolDecisionEnvelope } from "../engine-v2/reconciler";
import { resolveInstrumentTickSzAuthority } from "../engine-v2/execution/instrument-tick-authority";
import { resolveV2PreEntryExecutableTpBundle } from "../engine-v2/execution/pre-entry-tp-provenance";
import { buildV2SnapshotBridge } from "./paper-engine";
import { globalShockStates } from "../engine-v2/state/derive";
import type { Candle } from "../models/types";
import type { LegacySnapshotAdapter, V2BridgeSnapshot } from "../engine-v2/types";

function pass(label: string, detail?: Record<string, unknown>): void {
    const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
    console.log(`[TICKSZ-BRIDGE][${label}] PASS${extra}`);
}

function captureProofLogs(fn: () => void): Record<string, unknown>[] {
    const logs: Record<string, unknown>[] = [];
    const origInfo = console.info;
    const origLog = console.log;
    const capture = (msg: unknown) => {
        try {
            const p = JSON.parse(String(msg));
            if (p && typeof p.event === "string") logs.push(p);
        } catch {
            /* ignore */
        }
    };
    console.info = (msg: unknown) => {
        capture(msg);
        origInfo(msg);
    };
    console.log = (msg: unknown) => {
        capture(msg);
        origLog(msg);
    };
    try {
        fn();
    } finally {
        console.info = origInfo;
        console.log = origLog;
    }
    return logs;
}

/** Mirrors reconciler.ts V2BridgeSnapshot → LegacySnapshotAdapter mapping (production path). */
function bridgeSnapshotToLegacyAdapter(snapshot: V2BridgeSnapshot): LegacySnapshotAdapter {
    return {
        lastPrice: snapshot.lastPrice,
        latestCandleClose: snapshot.latestCandleClose,
        boxHigh: snapshot.boxHigh,
        boxLow: snapshot.boxLow,
        boxPosDiag: snapshot.boxPos,
        rangeConfidenceDiag: snapshot.rangeConfidence,
        ema20: snapshot.ema20,
        emaGapDiag: snapshot.emaGap,
        volatilityProxyDiag: snapshot.atr,
        atr20: snapshot.atr20,
        closedClose: snapshot.closedClose,
        signal: String(snapshot.signal),
        qualityScore: snapshot.qualityScore,
        entryCandidate: snapshot.entryCandidate ?? false,
        signalGateBlockedReason: snapshot.signalGateBlockedReason ?? null,
        rangeSignalDowngraded: snapshot.rangeSignalDowngraded ?? false,
        rangeSignalKeptByRelax: snapshot.rangeSignalKeptByRelax ?? false,
        swingHighSlope: snapshot.swingHighSlope,
        swingLowSlope: snapshot.swingLowSlope,
        rangeCenterSlope: snapshot.rangeCenterSlope,
        boxHighSlope: snapshot.boxHighSlope,
        boxLowSlope: snapshot.boxLowSlope,
        ema20Slope: snapshot.ema20Slope,
        ema60Slope: snapshot.ema60Slope,
        atrExpansion: snapshot.atrExpansion,
        volumeExpansion: snapshot.volumeExpansion,
        boxCohesion01: snapshot.boxCohesion01,
        boxCohesionDiag: snapshot.boxCohesion01,
        trendWeaknessScore: snapshot.trendWeaknessScore,
        trendWeaknessDiag: snapshot.trendWeaknessScore,
        breakoutFailureRate: snapshot.breakoutFailureRate,
        breakoutFailureRateDiag: snapshot.breakoutFailureRate,
        rangeOscillationScore: snapshot.rangeOscillationScore,
        rangeOscillationDiag: snapshot.rangeOscillationScore,
        reviewing_ticks: snapshot.reviewing_ticks,
        candles: snapshot.candles,
        htf_candles: snapshot.htf_candles,
        canonicalRegime: snapshot.canonicalRegime,
        canonicalRegimeSource: snapshot.canonicalRegimeSource,
        canonicalTrendScore: snapshot.canonicalTrendScore,
        canonicalRangeConfidence: snapshot.canonicalRangeConfidence,
        canonicalTrendWeaknessScore: snapshot.canonicalTrendWeaknessScore,
        canonicalRegimeAmbiguous: snapshot.canonicalRegimeAmbiguous,
        tickSz: snapshot.tickSz
    };
}

function makeLiveBridge(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        closeOnlyMode: false,
        killSwitch: false,
        reconcileSafeMode: false,
        longAllow: false,
        shortAllow: true,
        currentPositions: [],
        executionReadiness: true,
        accountEquityKrw: 10_000_000,
        accountEquityUsdt: 10_000,
        availableBalanceUsdt: 10_000,
        liveBalanceReady: true,
        okxActualPositionsReady: true,
        actualAccountNotionalUsdtReady: true,
        okxActualPositions: [],
        okxPendingOrdersReady: true,
        okxPendingOrdersNotionalUsdt: 0,
        okxPendingSymbolNotionalUsdt: 0,
        hasSymbolPendingEntry: false,
        okxLiveEnabled: true,
        okxAuthMode: "live",
        okxAuthReady: true,
        okxExchangeAuthOptIn: true,
        balanceFetchedAt: now,
        positionsFetchedAt: now,
        pendingOrdersFetchedAt: now,
        freshTickBarrierActive: false,
        freshTickExecutionBlocked: false,
        freshTickCompletedCycles: 1,
        freshTickRequiredCycles: 1,
        globalRiskScore: 0,
        lossStreaks: {},
        directionalShockState: "DOWN",
        ...overrides
    };
}

function makeLiveConfig() {
    return {
        baseSizeUsd: 100,
        okxLiveEnabled: true,
        okxAuthMode: "live",
        okxExchangeAuthOptIn: true,
        okxLiveMaxOrderNotionalUsdt: 500,
        okxLiveEmergencyMaxOrderNotionalUsdt: 500,
        paperTakerFeeRate: 0.0005,
        paperSlippageEstimateBps: 8,
        paperMaxOpenPositions: 3,
        paperReentryCooldownMs: 0,
        maxOpenPositions: 3,
        reentryCooldownMs: 0,
        okxLiveMarginReserveRatio: 0.2
    };
}

function seedDownShock(symbol: string): void {
    globalShockStates.set(symbol, {
        activeDirection: "DOWN",
        rawDirection: "DOWN",
        candidateDirection: "DOWN",
        candidateCount: 3,
        neutralCount: 0,
        candidateStartedAt: Date.now() - 60_000,
        activatedAt: Date.now() - 30_000,
        lastChangedAt: Date.now(),
        rawMovePct: 0.012,
        requiredMovePct: 0.0012,
        emergencyBypass: true,
        lastProcessedCycle: 0
    });
}

function makeEthWhipsawCandles(base: number): Candle[] {
    const flat: Candle[] = Array.from({ length: 110 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60_000,
        open: base + 8,
        high: base + 12,
        low: base + 4,
        close: base + 6,
        volume: 80
    }));
    const microUpThenDrop: Candle[] = Array.from({ length: 10 }, (_, i) => {
        const rebound = i < 3 ? base + 10 + i * 2 : base + 16 - (i - 3) * 5;
        return {
            ts: Date.now() - (10 - i) * 60_000,
            open: rebound,
            high: rebound + 4,
            low: rebound - 6,
            close: rebound - (i >= 3 ? 3 : 0),
            volume: i >= 3 ? 180 : 90
        };
    });
    return [...flat, ...microUpThenDrop];
}

function buildBridgeOnlyTickSnap(opts: {
    symbol: "ETHUSDT" | "BTCUSDT";
    entry: number;
    boxHigh: number;
    boxLow: number;
    atr: number;
    tickSz?: number;
    boxPos: number;
    candles: Candle[];
}) {
    const htf = opts.candles.slice(-40);
    return buildV2SnapshotBridge({
        lastPrice: opts.entry,
        latestCandleClose: opts.entry,
        signal: "none",
        entryCandidate: false,
        qualityScore: 68,
        ema20: opts.entry * 0.9998,
        emaGap: -0.00029,
        boxHigh: opts.boxHigh,
        boxLow: opts.boxLow,
        boxPos: opts.boxPos,
        atr: opts.atr,
        atr20: opts.atr,
        ...(opts.tickSz != null ? { tickSz: opts.tickSz } : {}),
        rangeConfidence: 0.59,
        trendWeaknessScore: 0.62,
        boxCohesion01: 0,
        breakoutFailureRate: 0.5,
        rangeOscillationScore: 0.17,
        candles: opts.candles,
        htf_candles: { "5m": opts.candles, "15m": opts.candles, "1h": htf, "4h": htf },
        canonicalRegime: "RANGE",
        reviewing_ticks: 0,
        swingHighSlope: -0.0001,
        swingLowSlope: -0.0002,
        rangeCenterSlope: -0.0001,
        boxHighSlope: 0,
        boxLowSlope: 0,
        ema20Slope: -0.00005,
        ema60Slope: -0.00003,
        atrExpansion: 1.1,
        volumeExpansion: 1.4
    } as any);
}

function assertBridgeTickEndToEnd(
    label: string,
    symbol: "ETHUSDT" | "BTCUSDT",
    tickSz: number,
    entry: number,
    boxHigh: number,
    boxLow: number,
    atr: number
): void {
    const candles =
        symbol === "ETHUSDT"
            ? makeEthWhipsawCandles(entry)
            : makeEthWhipsawCandles(entry).map((c) => ({
                  ...c,
                  open: c.open * 28,
                  high: c.high * 28,
                  low: c.low * 28,
                  close: c.close * 28
              }));

    const bridge = buildBridgeOnlyTickSnap({
        symbol,
        entry,
        boxHigh,
        boxLow,
        atr,
        tickSz,
        boxPos: 0.24,
        candles
    });
    assert.equal(bridge.tickSz, tickSz, `${label} bridge must preserve tickSz`);

    const legacyAdapter = bridgeSnapshotToLegacyAdapter(bridge);
    assert.equal(legacyAdapter.tickSz, tickSz, `${label} reconciler adapter must preserve tickSz`);

    const v2Input = adaptV2Input(
        symbol,
        Date.now(),
        legacyAdapter,
        makeLiveConfig() as any,
        makeLiveBridge() as any,
        { decision: { final_decision: "SKIP" }, regime: "RANGE", side: "none", isBlocked: false } as any,
        candles,
        "authoritative",
        `ticksz_bridge_${label}`
    );

    assert.equal(v2Input.snapshot.tickSz, tickSz, `${label} adaptV2Input must propagate tickSz`);
    assert.equal((v2Input.state as { instrumentTickSz?: number }).instrumentTickSz, undefined, `${label} no state shortcut`);

    const tickAuth = resolveInstrumentTickSzAuthority({ snapshotTickSz: v2Input.snapshot.tickSz });
    assert.equal(tickAuth.ok, true, `${label} resolver must accept bridge tick`);
    if (!tickAuth.ok) throw new Error(`${label} tick auth failed`);
    assert.equal(tickAuth.tickSz, tickSz);
    assert.equal(tickAuth.source, "snapshot.tickSz");

    const bundle = resolveV2PreEntryExecutableTpBundle({
        side: "short",
        regime: "RANGE",
        entryPrice: entry,
        rawStructuralSl: boxHigh + atr,
        rawPolicySlPrice: boxHigh + atr,
        marketSubtype: "WHIPSAW_SOFT_WATCH",
        routingEngine: "RANGE",
        atr,
        boxHigh,
        boxLow,
        feeRate: 0.0005,
        preserveCanonicalStructuralStop: true,
        snapshotTickSz: v2Input.snapshot.tickSz
    });
    assert.equal(bundle.ok, true, `${label} pre-entry bundle must resolve with bridge tick only`);
    if (!bundle.ok) throw new Error(`${label} bundle failed`);
    assert.equal(bundle.tpTickSize, tickSz);

    pass(label, { symbol, tickSz, source: tickAuth.source, tpTickSize: bundle.tpTickSize });
}

function runTickSzBridgePropagationCases(): void {
    console.info("=== RUNNING TICKSZ BRIDGE PROPAGATION CASES ===");

    // CASE A — ETH bridge-only tickSz
    assertBridgeTickEndToEnd("CASE_A_ETH_BRIDGE_TICK", "ETHUSDT", 0.01, 2450, 2464, 2443, 3.3);

    // CASE B — BTC bridge-only tickSz
    assertBridgeTickEndToEnd("CASE_B_BTC_BRIDGE_TICK", "BTCUSDT", 0.1, 77800, 78500, 77200, 95);

    // CASE C — negative fail-closed (no bridge tick, no state tick)
    {
        const bridge = buildBridgeOnlyTickSnap({
            symbol: "ETHUSDT",
            entry: 2450,
            boxHigh: 2464,
            boxLow: 2443,
            atr: 3.3,
            boxPos: 0.24,
            candles: makeEthWhipsawCandles(2450)
        });

        const legacyAdapter = bridgeSnapshotToLegacyAdapter(bridge);
        const v2Input = adaptV2Input(
            "ETHUSDT",
            Date.now(),
            legacyAdapter,
            makeLiveConfig() as any,
            makeLiveBridge() as any,
            { decision: { final_decision: "SKIP" }, regime: "RANGE", side: "none", isBlocked: false } as any,
            makeEthWhipsawCandles(2450),
            "authoritative",
            "ticksz_bridge_negative"
        );

        assert.equal(v2Input.snapshot.tickSz, undefined);
        const tickAuth = resolveInstrumentTickSzAuthority({ snapshotTickSz: v2Input.snapshot.tickSz });
        assert.equal(tickAuth.ok, false);
        if (tickAuth.ok) throw new Error("CASE C should fail closed");
        assert.equal(tickAuth.blockReason, "INSTRUMENT_TICK_SZ_UNAVAILABLE");

        const bundle = resolveV2PreEntryExecutableTpBundle({
            side: "short",
            regime: "RANGE",
            entryPrice: 2450,
            rawStructuralSl: 2470,
            rawPolicySlPrice: 2470,
            marketSubtype: "WHIPSAW_SOFT_WATCH",
            routingEngine: "RANGE",
            atr: 3.3,
            boxHigh: 2464,
            boxLow: 2443,
            feeRate: 0.0005,
            preserveCanonicalStructuralStop: true,
            snapshotTickSz: v2Input.snapshot.tickSz
        });
        assert.equal(bundle.ok, false);
        if (bundle.ok) throw new Error("CASE C bundle should fail");
        assert.equal(bundle.blockReason, "INSTRUMENT_TICK_SZ_UNAVAILABLE");
        pass("CASE_C_FAIL_CLOSED_NO_BRIDGE_TICK", { blockReason: bundle.blockReason });
    }

    // CASE D — production-like ETH WHIPSAW shock promotion via reconciler envelope
    {
        seedDownShock("ETHUSDT");
        const entry = 2450;
        const boxHigh = 2464;
        const boxLow = 2443;
        const atr = 3.3;
        const candles = makeEthWhipsawCandles(entry);
        const bridge = buildBridgeOnlyTickSnap({
            symbol: "ETHUSDT",
            entry,
            boxHigh,
            boxLow,
            atr,
            tickSz: 0.01,
            boxPos: 0.24,
            candles
        });

        let envelope: ReturnType<typeof resolveSymbolDecisionEnvelope> | undefined;
        const proofs = captureProofLogs(() => {
            envelope = resolveSymbolDecisionEnvelope({
                symbol: "ETHUSDT" as any,
                fetchedAt: Date.now(),
                snapshot: bridge,
                config: makeLiveConfig() as any,
                state: makeLiveBridge({ directionalShockState: "DOWN", shortAllow: true, longAllow: false }) as any,
                legacy: {
                    regime: "RANGE",
                    finalDecision: "SKIP",
                    rejectReason: "SIGNAL_NONE",
                    requiredCostUsd: 0,
                    entryAllowed: false,
                    executorLabel: "range",
                    intentSide: "none",
                    adaptiveOk: true,
                    adaptiveDetail: {}
                } as any,
                v2Mode: "engine_v2",
                evaluationMode: "authoritative",
                runCycleId: "ticksz_whipsaw_eth_cycle"
            });
        });

        assert.ok(envelope, "CASE D envelope must resolve");
        const promotionCommit = proofs.find((p) => p.event === "V2_PROMOTION_STATE_COMMIT_PROOF");
        const sizingProof = proofs.find((p) => p.event === "LIVE_ORDER_SIZING_AUTHORITY_PROOF");
        const finalizer = proofs.find((p) => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");
        const judgment = detectMarketRegime(
            adaptV2Input(
                "ETHUSDT",
                Date.now(),
                bridgeSnapshotToLegacyAdapter(bridge),
                makeLiveConfig() as any,
                makeLiveBridge({ directionalShockState: "DOWN" }) as any,
                { decision: { final_decision: "SKIP" } } as any,
                candles,
                "authoritative"
            )
        );

        const tickBlockReasons = [
            envelope!.authority.hardBlockReason,
            promotionCommit?.block_reason,
            promotionCommit?.min_order_block_reason,
            finalizer?.reject_reason_after,
            sizingProof?.blockReason
        ].filter((r) => r === "INSTRUMENT_TICK_SZ_UNAVAILABLE");

        assert.equal(tickBlockReasons.length, 0, `CASE D must not tick-block: ${JSON.stringify(tickBlockReasons)}`);

        const promotionApplied =
            finalizer?.promotion_applied === true ||
            (typeof promotionCommit?.promotion_reason === "string" &&
                String(promotionCommit.promotion_reason).includes("SHOCK_REACTION"));
        const sizingPassed =
            sizingProof?.sizing_passed === true ||
            (typeof sizingProof?.finalOrderNotionalUsdt === "number" && sizingProof.finalOrderNotionalUsdt > 0) ||
            promotionCommit?.final_order_notional_usdt != null;

        assert.equal(
            promotionApplied || sizingPassed || envelope!.authority.decision === "REJECT" || envelope!.authority.decision === "ENTER",
            true,
            "CASE D must reach promotion/sizing/live-signed evaluation path"
        );

        pass("CASE_D_ETH_WHIPSAW_SHOCK_PROMOTION_NO_TICK_BLOCK", {
            subtype: judgment.subtype,
            authority: envelope!.authority.decision,
            hardBlock: envelope!.authority.hardBlockReason ?? null,
            promotionApplied,
            sizingPassed,
            sizingBlock: sizingProof?.blockReason ?? null,
            rejectAfter: finalizer?.reject_reason_after ?? null
        });
    }

    // CASE E — reconciler envelope propagates tick for BTC (integration)
    {
        const bridge = buildBridgeOnlyTickSnap({
            symbol: "BTCUSDT",
            entry: 77800,
            boxHigh: 78500,
            boxLow: 77200,
            atr: 95,
            tickSz: 0.1,
            boxPos: 0.21,
            candles: makeEthWhipsawCandles(77800).map((c) => ({
                ...c,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close
            }))
        });

        const proofs = captureProofLogs(() => {
            resolveSymbolDecisionEnvelope({
                symbol: "BTCUSDT" as any,
                fetchedAt: Date.now(),
                snapshot: bridge,
                config: makeLiveConfig() as any,
                state: makeLiveBridge({ longAllow: true, shortAllow: true, directionalShockState: "DOWN" }) as any,
                legacy: {
                    regime: "RANGE",
                    finalDecision: "SKIP",
                    rejectReason: "none",
                    requiredCostUsd: 0,
                    entryAllowed: false,
                    executorLabel: "range",
                    intentSide: "none",
                    adaptiveOk: true,
                    adaptiveDetail: {}
                } as any,
                v2Mode: "engine_v2",
                evaluationMode: "authoritative",
                runCycleId: "ticksz_btc_reconciler"
            });
        });

        const tickBlocks = proofs.filter(
            (p) =>
                p.min_order_block_reason === "INSTRUMENT_TICK_SZ_UNAVAILABLE" ||
                p.block_reason === "INSTRUMENT_TICK_SZ_UNAVAILABLE" ||
                p.blockReason === "INSTRUMENT_TICK_SZ_UNAVAILABLE" ||
                p.hard_block_reason === "INSTRUMENT_TICK_SZ_UNAVAILABLE"
        );
        assert.equal(tickBlocks.length, 0, "BTC reconciler path must not emit tick block when bridge tick present");
        pass("CASE_E_BTC_RECONCILER_NO_TICK_BLOCK", { bridgeTickSz: bridge.tickSz });
    }
}

runTickSzBridgePropagationCases();
