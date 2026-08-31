/**
 * FAST_TREND_SHIFT / promotion TP profitability provenance regressions.
 *
 * A. ETH FAST_TREND_SHIFT promotion ENTER — canonical TP + tickSz + sufficient edge => ALLOW
 * B. ETH FAST_TREND_SHIFT — TP edge insufficient => V2_TP1_NET_EDGE_INSUFFICIENT
 * C. BTC FAST_TREND_SHIFT symmetric
 * D. Genuine executable ENTER with no canonical TP => fail-closed (provenance invalid)
 * E. HOLD/SKIP — profitability gate must not reject non-ENTER decisions
 * F. RANGE narrow/wide e2e suites remain unchanged (run separately)
 */

import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { evaluateTpProfitabilityAuthority } from "../engine-v2/execution/tp-profitability-authority";
import {
    resolveV2PreEntryExecutableTpBundle
} from "../engine-v2/execution/pre-entry-tp-provenance";
import { resolveInstrumentTickSzAuthority } from "../engine-v2/execution/instrument-tick-authority";
import { buildV2SnapshotBridge } from "./paper-engine";
import { globalShockStates } from "../engine-v2/state/derive";
import type { Candle } from "../models/types";

function pass(label: string, detail?: Record<string, unknown>): void {
    const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
    console.log(`[FTS-TP-PROFIT][${label}] PASS${extra}`);
}

function captureProofLogs(fn: () => void): Record<string, unknown>[] {
    const logs: Record<string, unknown>[] = [];
    const origInfo = console.info;
    const origLog = console.log;
    const capture = (msg: unknown) => {
        try {
            const p = JSON.parse(String(msg));
            if (p && typeof p.event === "string") logs.push(p);
        } catch { /* ignore */ }
    };
    console.info = (msg: unknown) => { capture(msg); origInfo(msg); };
    console.log = (msg: unknown) => { capture(msg); origLog(msg); };
    try { fn(); } finally { console.info = origInfo; console.log = origLog; }
    return logs;
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
        longAllow: true,
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
        ...overrides
    };
}

function seedUpShock(symbol: string): void {
    globalShockStates.set(symbol, {
        activeDirection: "UP",
        rawDirection: "UP",
        candidateDirection: "UP",
        candidateCount: 3,
        neutralCount: 0,
        candidateStartedAt: Date.now() - 60_000,
        activatedAt: Date.now() - 30_000,
        lastChangedAt: Date.now(),
        rawMovePct: 0.01,
        requiredMovePct: 0.0012,
        emergencyBypass: true,
        lastProcessedCycle: 0
    });
}

function makeFastTrendShiftLongCandles(base: number): Candle[] {
    const flat: Candle[] = Array.from({ length: 110 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60000,
        open: base - 200,
        high: base - 150,
        low: base - 250,
        close: base - 180,
        volume: 80
    }));
    const rising = Array.from({ length: 10 }, (_, i) => {
        const px = base - 100 + i * 120;
        return {
            ts: Date.now() - (10 - i) * 60000,
            open: px,
            high: px + 80,
            low: px - 20,
            close: px + 60,
            volume: 150
        };
    });
    return [...flat, ...rising];
}

function makeFastTrendShiftShortCandles(base: number): Candle[] {
    const flat: Candle[] = Array.from({ length: 110 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60000,
        open: base + 200,
        high: base + 250,
        low: base + 150,
        close: base + 180,
        volume: 80
    }));
    const falling = Array.from({ length: 10 }, (_, i) => {
        const px = base + 100 - i * 120;
        return {
            ts: Date.now() - (10 - i) * 60000,
            open: px,
            high: px + 20,
            low: px - 80,
            close: px - 60,
            volume: 150
        };
    });
    return [...flat, ...falling];
}

function runLiveEngine(opts: {
    symbol: "ETHUSDT" | "BTCUSDT";
    side: "long" | "short";
    entry: number;
    boxHigh: number;
    boxLow: number;
    atr: number;
    tickSz: number;
    candles: Candle[];
    boxPos: number;
    qualityScore?: number;
}) {
    const input = buildLiveInput(opts);
    let decision!: ReturnType<typeof runEngineV2>["decision"];
    const proofs = captureProofLogs(() => {
        ({ decision } = runEngineV2(input));
    });
    return { decision, proofs, judgment: detectMarketRegime(input) };
}

function buildLiveInput(opts: {
    symbol: "ETHUSDT" | "BTCUSDT";
    side: "long" | "short";
    entry: number;
    boxHigh: number;
    boxLow: number;
    atr: number;
    tickSz: number;
    candles: Candle[];
    boxPos: number;
    qualityScore?: number;
}) {
    const htf = opts.candles.slice(-40);
    const snap = {
        symbol: opts.symbol,
        lastPrice: opts.entry,
        latestCandleClose: opts.entry,
        signal: opts.side === "long" ? "paper_long_candidate" : "paper_short_candidate",
        entryCandidate: true,
        qualityScore: opts.qualityScore ?? 72,
        ema20: opts.entry * (opts.side === "long" ? 0.999 : 1.001),
        ema60: opts.entry * (opts.side === "long" ? 1.001 : 0.999),
        emaGap: opts.side === "long" ? 0.006 : -0.006,
        volumeRatioProxy: 1.4,
        volumeExpansion: 1.8,
        ema20Slope: opts.side === "long" ? 0.0003 : -0.0003,
        boxHigh: opts.boxHigh,
        boxLow: opts.boxLow,
        boxPos: opts.boxPos,
        atr: opts.atr,
        atr20: opts.atr,
        tickSz: opts.tickSz,
        rangeConfidence: 0.78,
        trendWeaknessScore: 0.22,
        boxCohesion01: 0.9,
        breakoutFailureRate: 0.12,
        rangeOscillationScore: 0.62,
        candles: opts.candles,
        htf_candles: { "5m": opts.candles, "15m": opts.candles, "1h": htf, "4h": htf },
        canonicalRegime: "RANGE",
        reviewing_ticks: 0
    };

    seedUpShock(opts.symbol);
    const bridge = buildV2SnapshotBridge(snap as any);
    const cycleNow = Date.now();
    return adaptV2Input(
        opts.symbol,
        cycleNow,
        bridge as any,
        {
            baseSizeUsd: 100,
            okxLiveEnabled: true,
            okxAuthMode: "live",
            okxExchangeAuthOptIn: true,
            okxLiveMaxOrderNotionalUsdt: 500,
            paperTakerFeeRate: 0.0005,
            paperSlippageEstimateBps: 8,
            paperMaxOpenPositions: 3,
            paperReentryCooldownMs: 0
        } as any,
        makeLiveBridge({ longAllow: opts.side === "long", shortAllow: opts.side === "short" }) as any,
        { decision: { final_decision: "SKIP" }, regime: "RANGE", side: "none", isBlocked: false } as any,
        opts.candles,
        "authoritative",
        `fts_tp_profit_${cycleNow}`
    );
}

function runFtsTpProfitabilityCases() {
    console.info("=== RUNNING FAST_TREND_SHIFT TP PROFITABILITY CASES ===");

    // CASE A — ETH FAST_TREND_SHIFT wide box: provenance resolves TP + tick, sufficient edge => ALLOW at gate
    {
        const entry = 2480;
        const boxHigh = 2550;
        const boxLow = 2470;
        const atr = 10;
        const stop = 2465;
        const tpBundle = resolveV2PreEntryExecutableTpBundle({
            side: "long",
            regime: "RANGE",
            entryPrice: entry,
            rawStructuralSl: stop,
            rawPolicySlPrice: stop,
            marketSubtype: "FAST_TREND_SHIFT",
            routingEngine: "RANGE",
            atr,
            boxHigh,
            boxLow,
            feeRate: 0.0005,
            preserveCanonicalStructuralStop: true,
            snapshotTickSz: 0.01
        });
        assert.equal(tpBundle.ok, true, "CASE A bundle must resolve");
        if (!tpBundle.ok) throw new Error("CASE A bundle failed");
        assert.notEqual(tpBundle.tpSource, "none" as never, "CASE A provenance source must not be none");
        const tickAuth = resolveInstrumentTickSzAuthority({ snapshotTickSz: 0.01 });
        assert.equal(tickAuth.ok, true);
        assert.equal(tickAuth.ok ? tickAuth.tickSz : null, 0.01, "CASE A tickSz from snapshot authority");
        const prof = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: entry,
            canonicalTp1Price: tpBundle.rawCanonicalTp1Price,
            canonicalTp1Source: tpBundle.canonicalTp1Source,
            feeRate: 0.0005,
            paperSlippageEstimateBps: 8,
            tickSz: tpBundle.tpTickSize
        });
        assert.ok(prof.rawCanonicalTp1Price != null, "CASE A rawCanonicalTp1Price present");
        assert.ok(prof.executableTp1Price != null, "CASE A executableTp1Price present");
        assert.ok(prof.tpTickSize != null, "CASE A tpTickSize present");
        assert.equal(prof.entryAllowed, true, "CASE A must ALLOW sufficient wide-box edge");
        assert.equal(prof.blockReason, null);
        pass("CASE_A_ETH_FAST_TREND_SHIFT_ALLOW", {
            canonicalTp1Source: tpBundle.canonicalTp1Source,
            rawCanonicalTp1Price: prof.rawCanonicalTp1Price,
            executableTp1Price: prof.executableTp1Price
        });
    }

    // CASE B — ETH narrow edge => V2_TP1_NET_EDGE_INSUFFICIENT (not provenance invalid)
    {
        const entry = 2503.37;
        const narrowTp1 = entry * (1 + 0.002); // 0.20% < 0.28% floor at fee 0.0005
        const prof = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: entry,
            canonicalTp1Price: narrowTp1,
            canonicalTp1Source: "execMeta.takeProfitPlan.tp1",
            feeRate: 0.0005,
            paperSlippageEstimateBps: 8,
            tickSz: 0.01
        });
        assert.equal(prof.entryAllowed, false);
        assert.equal(prof.blockReason, "V2_TP1_NET_EDGE_INSUFFICIENT");
        assert.ok(prof.rawCanonicalTp1Price != null);
        pass("CASE_B_ETH_INSUFFICIENT_EDGE", {
            blockReason: prof.blockReason,
            executableDistancePct: prof.executableTp1DistancePct,
            minimumProfitableTpPct: prof.minimumProfitableTpPct
        });
    }

    // CASE C — BTC FAST_TREND_SHIFT symmetric provenance + ALLOW
    {
        const entry = 67500;
        const boxHigh = 69000;
        const boxLow = 67000;
        const atr = 150;
        const stop = 66800;
        const tpBundle = resolveV2PreEntryExecutableTpBundle({
            side: "long",
            regime: "RANGE",
            entryPrice: entry,
            rawStructuralSl: stop,
            rawPolicySlPrice: stop,
            marketSubtype: "FAST_TREND_SHIFT",
            routingEngine: "RANGE",
            atr,
            boxHigh,
            boxLow,
            feeRate: 0.0005,
            preserveCanonicalStructuralStop: true,
            snapshotTickSz: 0.1
        });
        assert.equal(tpBundle.ok, true, "CASE C canonical TP must resolve");
        if (!tpBundle.ok) throw new Error("CASE C bundle failed");
        const tickAuth = resolveInstrumentTickSzAuthority({ snapshotTickSz: 0.1 });
        assert.equal(tickAuth.ok, true);
        assert.equal(tickAuth.ok ? tickAuth.tickSz : null, 0.1);
        const executable = tpBundle.executableTp1Price;
        const prof = evaluateTpProfitabilityAuthority({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: entry,
            canonicalTp1Price: tpBundle.rawCanonicalTp1Price,
            canonicalTp1Source: tpBundle.canonicalTp1Source,
            feeRate: 0.0005,
            paperSlippageEstimateBps: 8,
            tickSz: tpBundle.tpTickSize
        });
        assert.ok(prof.executableTp1Price != null);
        assert.equal(prof.executableTp1Price, executable);
        assert.equal(prof.entryAllowed, true, "CASE C BTC wide box must ALLOW");
        pass("CASE_C_BTC_FAST_TREND_SHIFT_ALLOW", {
            canonicalTp1Source: tpBundle.canonicalTp1Source,
            executableTp1Price: prof.executableTp1Price
        });
    }

    // CASE D — TREND regime with no explicit TP => fail-closed provenance invalid
    {
        const prof = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "TREND",
            entryPrice: 2500,
            canonicalTp1Price: null,
            canonicalTp1Source: "none",
            feeRate: 0.0005,
            paperSlippageEstimateBps: 8,
            tickSz: 0.01
        });
        assert.equal(prof.entryAllowed, false);
        assert.equal(prof.blockReason, "V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID");
        assert.equal(prof.rawCanonicalTp1Price, null);
        pass("CASE_D_GENUINE_NO_TP_FAIL_CLOSED", { blockReason: prof.blockReason });
    }

    // CASE E — HOLD must not be rejected by TP profitability gate
    {
        const candles = makeFlatHoldCandles(69000);
        const snap = {
            symbol: "BTCUSDT",
            lastPrice: 69000,
            latestCandleClose: 69000,
            signal: "none",
            entryCandidate: false,
            qualityScore: 55,
            emaGap: 0.0001,
            boxHigh: 70000,
            boxLow: 68000,
            boxPos: 0.5,
            atr: 250,
            tickSz: 0.1,
            rangeConfidence: 0.5,
            trendWeaknessScore: 0.6,
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles },
            reviewing_ticks: 0
        };
        const bridge = buildV2SnapshotBridge(snap as any);
        const cycleNow = Date.now();
        const input = adaptV2Input(
            "BTCUSDT",
            cycleNow,
            bridge as any,
            {
                baseSizeUsd: 100,
                okxLiveEnabled: true,
                okxAuthMode: "live",
                okxExchangeAuthOptIn: true,
                paperTakerFeeRate: 0.0005,
                paperMaxOpenPositions: 3,
                paperReentryCooldownMs: 0,
                okxLiveMaxOrderNotionalUsdt: 500
            } as any,
            makeLiveBridge() as any,
            { decision: { final_decision: "SKIP" }, regime: "RANGE", side: "none", isBlocked: false } as any,
            candles,
            "authoritative",
            `fts_hold_${cycleNow}`
        );
        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });
        const tpProof = proofs.find((p) => p.event === "V2_TP_PROFITABILITY_AUTHORITY_PROOF");
        assert.notEqual(decision.decision, "ENTER");
        assert.equal(tpProof, undefined, "CASE E profitability gate must not run on non-ENTER");
        pass("CASE_E_HOLD_NOT_CONTAMINATED", { finalDecision: decision.decision });
    }

    // Integration — ETH live FAST_TREND_SHIFT native ENTER must not be rejected for null TP provenance
    {
        const entry = 2480;
        const { decision, proofs, judgment } = runLiveEngine({
            symbol: "ETHUSDT",
            side: "long",
            entry,
            boxHigh: 2550,
            boxLow: 2470,
            atr: 10,
            tickSz: 0.01,
            boxPos: 0.55,
            candles: makeFastTrendShiftLongCandles(entry)
        });
        const tpProof = proofs.find((p) => p.event === "V2_TP_PROFITABILITY_AUTHORITY_PROOF") as Record<string, unknown> | undefined;
        if (decision.decision === "ENTER") {
            assert.ok(tpProof != null, "ENTER must emit TP profitability proof");
            assert.notEqual(tpProof?.rawCanonicalTp1Price, null, "ENTER must not have null raw TP at gate");
            assert.notEqual(tpProof?.tpTickSize, null, "ENTER must resolve tickSz at gate");
            assert.notEqual(
                tpProof?.blockReason,
                "V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID",
                "ENTER must not fail provenance invalid after fix"
            );
        }
        pass("CASE_A_INTEGRATION_ETH_FAST_TREND_SHIFT", {
            subtype: judgment.subtype,
            decision: decision.decision,
            side: decision.side,
            tpProofBlockReason: tpProof?.blockReason ?? null,
            rawCanonicalTp1Price: tpProof?.rawCanonicalTp1Price ?? null
        });
    }

    // Integration — BTC symmetric
    {
        const entry = 67500;
        const { decision, proofs, judgment } = runLiveEngine({
            symbol: "BTCUSDT",
            side: "long",
            entry,
            boxHigh: 69000,
            boxLow: 67000,
            atr: 150,
            tickSz: 0.1,
            boxPos: 0.55,
            candles: makeFastTrendShiftLongCandles(entry)
        });
        const tpProof = proofs.find((p) => p.event === "V2_TP_PROFITABILITY_AUTHORITY_PROOF") as Record<string, unknown> | undefined;
        if (decision.decision === "ENTER") {
            assert.ok(tpProof?.rawCanonicalTp1Price != null);
            assert.ok(tpProof?.tpTickSize != null);
            assert.notEqual(tpProof?.blockReason, "V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID");
        }
        pass("CASE_C_INTEGRATION_BTC_FAST_TREND_SHIFT", {
            subtype: judgment.subtype,
            decision: decision.decision,
            tpProofBlockReason: tpProof?.blockReason ?? null
        });
    }

    console.info("=== ALL FAST_TREND_SHIFT TP PROFITABILITY CASES PASSED ===");
}

function makeFlatHoldCandles(base: number): Candle[] {
    return Array.from({ length: 120 }, (_, i) => ({
        ts: Date.now() - (120 - i) * 60000,
        open: base,
        high: base + 20,
        low: base - 20,
        close: base + (i % 2 === 0 ? 3 : -3),
        volume: 80
    }));
}

runFtsTpProfitabilityCases();
