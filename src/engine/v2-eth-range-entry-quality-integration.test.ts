/**
 * End-to-End Integration Wiring Verification for ETH Dedicated RANGE Entry Quality Gate
 *
 * Tests the complete runtime pipeline through runEngineV2.
 *
 * KEY INVARIANTS VERIFIED:
 * 1. ETH_RANGE_FULL: decision=ENTER, probeMultiplier=1.0, submitted_order_notional = full size
 * 2. ETH_RANGE_LOCATION_PROBE: decision=ENTER, probeMultiplier=0.50, submitted = 50% of full baseline
 * 3. ETH_RANGE_UNCONFIRMED_PROBE: decision=ENTER, probeMultiplier=0.50, submitted = 50% of full baseline
 * 4. ETH_RANGE_COUNTERTREND_EXTREME_PROBE: decision=ENTER, probeMultiplier=0.50
 * 5. ETH_RANGE_BLOCK: HOLD/SKIP, zero submitted notional, no resurrection via pipeline
 * 6. BTC 100% unaffected: ETH quality gate never fires for BTCUSDT
 * 7. Probe multiplier applied exactly ONCE: no double-reduction with isMicroProbe or other multipliers
 * 8. Proof fields: base_order_notional_before_eth_probe, submitted_order_notional, live_max_order_notional_usdt
 *
 * CASE MATRIX:
 * CASE A: FULL (boxPos=0.15, reversal=true) => submitted = full equity-based notional
 * CASE B: LOC_PROBE (boxPos=0.28, reversal=true) => submitted ~50% of same-condition full baseline
 * CASE C: UNCONF_PROBE (boxPos=0.15, reversal=false) => submitted ~50% of same-condition full baseline
 * CASE D: BLOCK (boxPos=0.28, reversal=false) => submitted = 0, decision != ENTER
 * CASE E: BTC, same params => ETH_RANGE_ENTRY_QUALITY_PROOF never emitted
 * CASE F: ETH FULL (non-probe) => probeMultiplierApplied=1 in V2_PROBE_SIZING proof, no reduction
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";

function captureProofLogs(fn: () => void): Record<string, unknown>[] {
    const logs: Record<string, unknown>[] = [];
    const origInfo = console.info;
    console.info = (msg: unknown) => {
        try {
            const p = JSON.parse(String(msg));
            if (p && typeof p.event === "string") logs.push(p);
        } catch { /* ignore non-JSON */ }
        origInfo(msg);
    };
    try { fn(); } finally { console.info = origInfo; }
    return logs;
}

function makeEthRangeCandles(base = 2400, amplitude = 50, lastPrice?: number): Candle[] {
    return Array.from({ length: 120 }, (_, i) => {
        const wave = Math.sin(i / 3) * amplitude;
        const px = base + wave;
        return {
            ts: Date.now() - (120 - i) * 60000,
            open: px,
            high: px + 15,
            low: px - 15,
            close: i === 119 && lastPrice !== undefined ? lastPrice : px - 2,
            volume: 80
        };
    });
}

function makeProductionBridge(overrides: Record<string, unknown> = {}) {
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
        exposureNotionalCapKrw: 100_000_000,
        symbolExposureNotionalCapKrw: 50_000_000,
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
        hasUnknownPendingNotional: false,
        okxLiveEnabled: true,
        okxAuthMode: "live",
        okxAuthReady: true,
        okxExchangeAuthOptIn: true,
        okxApiKeyPresent: true,
        okxApiSecretPresent: true,
        okxPassphrasePresent: true,
        balanceFetchedAt: now,
        positionsFetchedAt: now,
        pendingOrdersFetchedAt: now,
        dailyLossGuardTriggered: false,
        entryQualityProfiles: {
            profit: { qualityScoreAvg: 90, emaGapAvg: 0.001, atrPctAvg: 0.01, volumeRatioAvg: 1.2, count: 8 },
            loss: { qualityScoreAvg: 55, emaGapAvg: 0.001, atrPctAvg: 0.01, volumeRatioAvg: 0.9, count: 2 },
            contaminated: { qualityScoreAvg: 60, emaGapAvg: 0.001, atrPctAvg: 0.01, volumeRatioAvg: 1.0, count: 1 }
        },
        ...overrides
    };
}

function makeLiveConfig(overrides: Record<string, unknown> = {}) {
    return {
        paperMaxOpenPositions: 3,
        baseSizeUsd: 100,
        maxSymbolNotionalUsd: 5000,
        maxAccountNotionalUsd: 20000,
        okxLiveEnabled: true,
        okxAuthMode: "live",
        okxExchangeAuthOptIn: true,
        live_max_order_notional_usdt: 40,
        okxLiveMaxOrderNotionalUsdt: 40,
        highwayMinCostMultiplier: 0.01,
        highwayMinRewardRisk: 0.01,
        paperTakerFeeRate: 0.0001,
        paperSlippageEstimateBps: 1,
        serverTradeEnabled: true,
        ...overrides
    };
}

describe("ETH Dedicated RANGE Quality Gate E2E Integration Suite", () => {
    const boxHigh = 2500;
    const boxLow = 2300;

    // Helper to build adaptV2Input
    function buildInput(symbol: string, lastPrice: number, boxPos: number, overrides: Record<string, unknown> = {}) {
        const cycleNow = Date.now();
        const candles = makeEthRangeCandles(2400, 40, lastPrice);
        const isLong = (overrides.side ?? (boxPos <= 0.5 ? "long" : "short")) === "long";
        const stopPrice = isLong ? 2280 : 2520;
        const tp1Price = isLong ? 2440 : 2360;

        const snap = {
            symbol,
            lastPrice,
            latestCandleClose: lastPrice,
            signal: overrides.signal ?? (isLong ? "paper_long_candidate" : "paper_short_candidate"),
            entryCandidate: true,
            qualityScore: 85,
            candidateStrength: "strong",
            ema20: 2400,
            ema60: 2400,
            emaGap: 0.0001,
            volumeRatioProxy: 1.1,
            volumeExpansion: 1.2,
            ema20Slope: 0.00001,
            boxHigh,
            boxLow,
            boxPos,
            boxRel: 0.02,
            atr: 15,
            atr20: 15,
            tickSz: 0.01,
            closedClose: lastPrice,
            rangeConfidence: 0.88,
            trendWeaknessScore: 0.20,
            boxCohesion01: 0.95,
            breakoutFailureRate: 0.10,
            rangeOscillationScore: 0.75,
            rangeSignalDowngraded: false,
            rangeSignalKeptByRelax: false,
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles },
            canonicalRegime: "RANGE",
            canonicalRegimeSource: "strategy_market_regime_detector",
            canonicalTrendScore: 0.20,
            reviewing_ticks: 0,
            reversalConfirmed: overrides.reversalConfirmed ?? true,
            reversal_confirmed: overrides.reversalConfirmed ?? true,
            stopPrice,
            invalidationPx: stopPrice,
            takeProfit1Px: tp1Price,
            takeProfitPlan: { tp1: tp1Price, tp2: isLong ? 2480 : 2320 },
            executor_metadata: {
                boxCohesion01: 0.95,
                trendWeaknessScore: 0.20,
                rangeConfidence: 0.88,
                boxPos,
                reversal_confirmed: overrides.reversalConfirmed ?? true,
                takeProfit1Px: tp1Price,
                takeProfitPlan: { tp1: tp1Price, tp2: isLong ? 2480 : 2320 }
            },
            ...overrides
        };

        const adapted = adaptV2Input(
            symbol,
            cycleNow,
            buildV2SnapshotBridge(snap as any) as any,
            makeLiveConfig() as any,
            makeProductionBridge({
                balanceFetchedAt: cycleNow,
                positionsFetchedAt: cycleNow,
                pendingOrdersFetchedAt: cycleNow
            }) as any,
            {
                decision: {
                    final_decision: "ENTER",
                    side: isLong ? "long" : "short",
                    stopPrice,
                    invalidationPx: stopPrice,
                    takeProfit1Px: tp1Price,
                    takeProfitPlan: { tp1: tp1Price, tp2: isLong ? 2480 : 2320 }
                }
            } as any,
            candles,
            "authoritative",
            `eth_quality_test_${cycleNow}`
        );

        (adapted.snapshot as any).reversal_confirmed = overrides.reversalConfirmed ?? true;
        (adapted.snapshot as any).reversalConfirmed = overrides.reversalConfirmed ?? true;
        (adapted.config as any).highwayMinRewardRisk = 0.01;
        (adapted.config as any).highwayMinCostMultiplier = 0.01;
        (adapted.config as any).paperTakerFeeRate = 0.0001;
        (adapted.config as any).okxLiveMaxOrderNotionalUsdt = 40;
        if (overrides.trendSideCandidate) {
            (adapted.snapshot as any).trendSideCandidate = overrides.trendSideCandidate;
        }
        if (overrides.rangeSideCandidate) {
            (adapted.snapshot as any).rangeSideCandidate = overrides.rangeSideCandidate;
        }

        return adapted;
    }

    function findQualityProof(proofs: Record<string, unknown>[]) {
        const matches = proofs.filter(p => p.event === "ETH_RANGE_ENTRY_QUALITY_PROOF");
        return matches.length > 0 ? matches[matches.length - 1] : undefined;
    }

    // CASE A: ETH_RANGE_FULL
    it("CASE A: ETH_RANGE_FULL - decision=ENTER, probe_multiplier=1.0, submitted_order_notional=full baseline", () => {
        const lastPrice = 2330;
        const input = buildInput("ETHUSDT", lastPrice, 0.15, { reversalConfirmed: true });

        let decisionResult: any;
        const proofs = captureProofLogs(() => {
            decisionResult = runEngineV2(input);
        });

        const qualityProof = findQualityProof(proofs);
        assert.ok(qualityProof, "ETH_RANGE_ENTRY_QUALITY_PROOF must be emitted");
        assert.equal(qualityProof.classification, "ETH_RANGE_FULL");
        assert.equal(qualityProof.probe_multiplier, 1.0);
        assert.equal(qualityProof.final_allowed, true);

        assert.ok(qualityProof.base_order_notional_before_eth_probe != null, "base_order_notional_before_eth_probe must be set");
        assert.ok(qualityProof.submitted_order_notional != null, "submitted_order_notional must be set");
        const base = Number(qualityProof.base_order_notional_before_eth_probe);
        const submitted = Number(qualityProof.submitted_order_notional);
        assert.ok(base > 0 && submitted > 0, "base and submitted > 0");
        assert.ok(Math.abs(submitted - base) / base < 0.02,
            `FULL submitted (${submitted}) must be ~= base (${base})`);

        assert.equal(decisionResult.decision.decision, "ENTER");
        assert.equal(decisionResult.decision.side, "long");
        assert.equal(decisionResult.decision.executionAction, "ENTER");
        assert.ok(Number(decisionResult.decision.risk?.finalOrderNotionalUsdt) > 0);

        const probeSizProof = proofs.find(p => p.event === "V2_PROBE_SIZING_AUTHORITY_PROOF");
        if (probeSizProof) {
            assert.equal(Number(probeSizProof.probeMultiplierApplied), 1, "FULL: probeMultiplierApplied must be 1");
        }
    });

    // CASE B: ETH_RANGE_LOCATION_PROBE
    it("CASE B: ETH_RANGE_LOCATION_PROBE - decision=ENTER, probe_multiplier=0.50, submitted=50% of full baseline", () => {
        const lastPrice = 2356;
        const inputProbe = buildInput("ETHUSDT", lastPrice, 0.28, { reversalConfirmed: true });

        let probeResult: any;
        const proofsProbe = captureProofLogs(() => {
            probeResult = runEngineV2(inputProbe);
        });

        const qualityProof = findQualityProof(proofsProbe);
        assert.ok(qualityProof, "ETH_RANGE_ENTRY_QUALITY_PROOF must be emitted");
        assert.equal(qualityProof.classification, "ETH_RANGE_LOCATION_PROBE");
        assert.equal(qualityProof.probe_multiplier, 0.50);
        assert.equal(qualityProof.final_allowed, true);

        const base = Number(qualityProof.base_order_notional_before_eth_probe);
        const submitted = Number(qualityProof.submitted_order_notional);
        assert.ok(base > 0 && submitted > 0, "base and submitted > 0");
        const ratio = submitted / base;
        assert.ok(ratio >= 0.45 && ratio <= 0.55,
            `LOC_PROBE submitted/base ratio must be ~0.50, got ${ratio.toFixed(4)} (base=${base}, submitted=${submitted})`);
        assert.ok(submitted < base, `PROBE submitted (${submitted}) < base (${base})`);

        assert.equal(probeResult.decision.decision, "ENTER");
        assert.equal(probeResult.decision.side, "long");
        assert.equal(probeResult.decision.executionAction, "ENTER");

        const probeSizProof = proofsProbe.find(p => p.event === "V2_PROBE_SIZING_AUTHORITY_PROOF");
        if (probeSizProof) {
            assert.ok(
                Math.abs(Number(probeSizProof.probeMultiplierApplied) - 0.50) < 0.01,
                `probeMultiplierApplied must be ~0.50, got ${probeSizProof.probeMultiplierApplied}`
            );
        }
    });

    // CASE C: ETH_RANGE_UNCONFIRMED_PROBE
    it("CASE C: ETH_RANGE_UNCONFIRMED_PROBE - decision=ENTER, probe_multiplier=0.50, submitted=50% vs FULL", () => {
        const lastPrice = 2330;
        const inputProbe = buildInput("ETHUSDT", lastPrice, 0.15, { reversalConfirmed: false });

        let probeResult: any;
        const proofsProbe = captureProofLogs(() => {
            probeResult = runEngineV2(inputProbe);
        });

        const qualityProof = findQualityProof(proofsProbe);
        assert.ok(qualityProof, "ETH_RANGE_ENTRY_QUALITY_PROOF must be emitted");
        assert.equal(qualityProof.classification, "ETH_RANGE_UNCONFIRMED_PROBE");
        assert.equal(qualityProof.probe_multiplier, 0.50);
        assert.equal(qualityProof.final_allowed, true);

        const base = Number(qualityProof.base_order_notional_before_eth_probe);
        const submitted = Number(qualityProof.submitted_order_notional);
        assert.ok(base > 0 && submitted > 0, "base and submitted > 0");

        const inputFull = buildInput("ETHUSDT", lastPrice, 0.15, { reversalConfirmed: true });
        let fullResult: any;
        captureProofLogs(() => { fullResult = runEngineV2(inputFull); });
        const fullNotional = Number(fullResult.decision.risk?.finalOrderNotionalUsdt ?? 0);

        assert.ok(fullNotional > 0, "FULL finalOrderNotionalUsdt > 0");
        const ratio = submitted / fullNotional;
        assert.ok(ratio >= 0.45 && ratio <= 0.55,
            `UNCONF_PROBE/FULL ratio must be ~0.50, got ${ratio.toFixed(4)} (probe=${submitted}, full=${fullNotional})`);

        assert.equal(probeResult.decision.decision, "ENTER");
        assert.equal(probeResult.decision.side, "long");
        assert.equal(probeResult.decision.executionAction, "ENTER");
    });

    // CASE D: ETH_RANGE_BLOCK
    it("CASE D: ETH_RANGE_BLOCK - decision!=ENTER, finalOrderNotionalUsdt=0, no resurrection", () => {
        const lastPrice = 2356;
        const input = buildInput("ETHUSDT", lastPrice, 0.28, { reversalConfirmed: false });

        let decisionResult: any;
        const proofs = captureProofLogs(() => {
            decisionResult = runEngineV2(input);
        });

        const qualityProof = findQualityProof(proofs);
        assert.ok(qualityProof, "ETH_RANGE_ENTRY_QUALITY_PROOF must be emitted");
        assert.equal(qualityProof.classification, "ETH_RANGE_BLOCK");
        assert.equal(qualityProof.final_allowed, false);
        assert.equal(qualityProof.block_reason, "ETH_RANGE_REVERSAL_NOT_CONFIRMED");

        assert.notEqual(decisionResult.decision.decision, "ENTER");
        assert.equal(decisionResult.decision.side, "none");
        assert.equal(decisionResult.decision.executionAction, "NONE");
        assert.equal(Number(decisionResult.decision.risk?.finalOrderNotionalUsdt ?? 0), 0,
            "BLOCK: finalOrderNotionalUsdt must be 0");
    });

    // CASE E: BTC 100% unaffected
    it("CASE E: BTC - ETH_RANGE_ENTRY_QUALITY_PROOF never emitted", () => {
        const btcInput = buildInput("BTCUSDT", 60000, 0.28, { reversalConfirmed: false });

        const proofsBtc = captureProofLogs(() => {
            runEngineV2(btcInput);
        });

        const qualityProofBtc = findQualityProof(proofsBtc);
        assert.equal(qualityProofBtc, undefined, "ETH_RANGE_ENTRY_QUALITY_PROOF must NOT be emitted for BTC");
    });

    // CASE F: No double-reduction
    it("CASE F: ETH FULL - probeMultiplierApplied=1, submitted ~= base, no double-reduction", () => {
        const lastPrice = 2330;
        const input = buildInput("ETHUSDT", lastPrice, 0.15, { reversalConfirmed: true });

        let decisionResult: any;
        const proofs = captureProofLogs(() => {
            decisionResult = runEngineV2(input);
        });

        const probeSizProof = proofs.find(p => p.event === "V2_PROBE_SIZING_AUTHORITY_PROOF");
        const qualityProof = findQualityProof(proofs);

        assert.equal(qualityProof?.classification, "ETH_RANGE_FULL");
        assert.equal(qualityProof?.probe_multiplier, 1.0);

        if (probeSizProof) {
            assert.equal(Number(probeSizProof.probeMultiplierApplied), 1,
                "FULL: probeMultiplierApplied must be 1");
        }

        const baseProbe = Number(qualityProof?.base_order_notional_before_eth_probe ?? 0);
        const submittedProbe = Number(qualityProof?.submitted_order_notional ?? 0);
        assert.ok(baseProbe > 0 && submittedProbe > 0, "base and submitted > 0");
        assert.ok(Math.abs(submittedProbe - baseProbe) / baseProbe < 0.02,
            `FULL: submitted (${submittedProbe}) ~= base (${baseProbe}), no reduction`);

        assert.equal(decisionResult.decision.decision, "ENTER");
        assert.equal(decisionResult.decision.executionAction, "ENTER");
    });

    // Countertrend extreme probe regression
    it("Countertrend: extreme (boxPos=0.05) -> PROBE, non-extreme (boxPos=0.15) -> BLOCK", () => {
        const inputBlocked = buildInput("ETHUSDT", 2330, 0.15, {
            side: "long",
            signal: "paper_long_candidate",
            emaGap: -0.0006,
            trendSideCandidate: "short",
            rangeSideCandidate: "long",
            reversalConfirmed: true
        });

        let resBlocked: any;
        const proofsBlocked = captureProofLogs(() => {
            resBlocked = runEngineV2(inputBlocked);
        });

        const qualityProofBlocked = findQualityProof(proofsBlocked);
        assert.ok(qualityProofBlocked, "proof must be emitted for blocked countertrend");
        assert.equal(qualityProofBlocked.classification, "ETH_RANGE_BLOCK");
        assert.equal(qualityProofBlocked.block_reason, "ETH_RANGE_COUNTERTREND_NOT_EXTREME_CONFIRMED");
        assert.equal(qualityProofBlocked.final_allowed, false);
        assert.notEqual(resBlocked.decision.decision, "ENTER");
        assert.equal(resBlocked.decision.executionAction, "NONE");

        const inputExtreme = buildInput("ETHUSDT", 2310, 0.05, {
            side: "long",
            signal: "paper_long_candidate",
            emaGap: -0.0006,
            trendSideCandidate: "short",
            rangeSideCandidate: "long",
            reversalConfirmed: true
        });

        let resExtreme: any;
        const proofsExtreme = captureProofLogs(() => {
            resExtreme = runEngineV2(inputExtreme);
        });

        const qualityProofExtreme = findQualityProof(proofsExtreme);
        assert.ok(qualityProofExtreme, "proof must be emitted for extreme countertrend probe");
        assert.equal(qualityProofExtreme.classification, "ETH_RANGE_COUNTERTREND_EXTREME_PROBE");
        assert.equal(qualityProofExtreme.probe_multiplier, 0.50);
        assert.equal(qualityProofExtreme.final_allowed, true);
        assert.equal(resExtreme.decision.decision, "ENTER");
        assert.equal(resExtreme.decision.side, "long");
        assert.equal(resExtreme.decision.executionAction, "ENTER");

        const baseExt = Number(qualityProofExtreme.base_order_notional_before_eth_probe);
        const submittedExt = Number(qualityProofExtreme.submitted_order_notional);
        if (baseExt > 0 && submittedExt > 0) {
            const ratioExt = submittedExt / baseExt;
            assert.ok(ratioExt >= 0.40 && ratioExt <= 0.60,
                `COUNTERTREND_EXTREME_PROBE submitted/base ratio must be ~0.50, got ${ratioExt.toFixed(4)}`);
        }
    });
});
