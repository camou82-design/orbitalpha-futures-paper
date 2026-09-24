import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateEthRangeEntryQualityGate,
    type EthRangeEntryQualityInput
} from "../engine-v2/execution/eth-range-entry-quality-gate";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { buildV2SnapshotBridge } from "./paper-engine";
import { globalShockStates } from "../engine-v2/state/derive";
import type { EngineV2Input } from "../engine-v2/types";
import type { Candle } from "../models/types";

describe("ETH RANGE Quality Promotion Bridge Test Suite (Cases A-K)", () => {
    // 1. Direct Quality Gate / Bridge Classification Tests

    it("CASE A: ETH RANGE countertrend edge (boxPos=0.133, rev=true, trend=short, quality=76) -> ETH_RANGE_COUNTERTREND_EDGE_PROBE (0.25x)", () => {
        const input: EthRangeEntryQualityInput = {
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "CANONICAL_RANGE",
            routingEngine: "RANGE",
            isInitialEntry: true,
            isAddon: false,
            boxPos: 0.133,
            zone: "lower",
            rangeSideCandidate: "long",
            trendSideCandidate: "short",
            selectedSideAfterVeto: "long",
            reversalConfirmed: true,
            sideZoneValid: true,
            rangeEdgeExtreme: false,
            qualityScore: 76,
            entryQualityGrade: "A",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            directionalShockState: "NONE",
            emitProof: false
        };

        const res = evaluateEthRangeEntryQualityGate(input);
        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, true);
        assert.equal(res.classification, "ETH_RANGE_COUNTERTREND_EDGE_PROBE");
        assert.equal(res.probeMultiplier, 0.25);
        assert.equal(res.isProbe, true);
        assert.equal(res.isDirectionConflict, true);
        assert.equal(res.blockReason, null);
    });

    it("CASE B: Same as Case A but quality=69 -> BLOCKED (< 70)", () => {
        const input: EthRangeEntryQualityInput = {
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "CANONICAL_RANGE",
            routingEngine: "RANGE",
            isInitialEntry: true,
            isAddon: false,
            boxPos: 0.133,
            zone: "lower",
            rangeSideCandidate: "long",
            trendSideCandidate: "short",
            selectedSideAfterVeto: "long",
            reversalConfirmed: true,
            sideZoneValid: true,
            rangeEdgeExtreme: false,
            qualityScore: 69,
            entryQualityGrade: "B",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            directionalShockState: "NONE",
            emitProof: false
        };

        const res = evaluateEthRangeEntryQualityGate(input);
        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, false);
        assert.equal(res.classification, "ETH_RANGE_BLOCK");
        assert.equal(res.probeMultiplier, 0.0);
    });

    it("CASE C: boxPos=0.23 + trend conflict (short vs long) -> BLOCKED (not edge location)", () => {
        const input: EthRangeEntryQualityInput = {
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "CANONICAL_RANGE",
            routingEngine: "RANGE",
            isInitialEntry: true,
            isAddon: false,
            boxPos: 0.23,
            zone: "lower",
            rangeSideCandidate: "long",
            trendSideCandidate: "short",
            selectedSideAfterVeto: "long",
            reversalConfirmed: true,
            sideZoneValid: true,
            rangeEdgeExtreme: false,
            qualityScore: 76,
            entryQualityGrade: "A",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            directionalShockState: "NONE",
            emitProof: false
        };

        const res = evaluateEthRangeEntryQualityGate(input);
        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, false);
        assert.equal(res.classification, "ETH_RANGE_BLOCK");
    });

    it("CASE D: reversal=false with trend conflict -> BLOCKED", () => {
        const input: EthRangeEntryQualityInput = {
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "CANONICAL_RANGE",
            routingEngine: "RANGE",
            isInitialEntry: true,
            isAddon: false,
            boxPos: 0.133,
            zone: "lower",
            rangeSideCandidate: "long",
            trendSideCandidate: "short",
            selectedSideAfterVeto: "long",
            reversalConfirmed: false,
            sideZoneValid: true,
            rangeEdgeExtreme: false,
            qualityScore: 76,
            entryQualityGrade: "A",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            directionalShockState: "NONE",
            emitProof: false
        };

        const res = evaluateEthRangeEntryQualityGate(input);
        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, false);
        assert.equal(res.classification, "ETH_RANGE_BLOCK");
    });

    it("CASE E: HTF explicit opposite (SHORT_ONLY_OR_NONE for long) -> BLOCKED", () => {
        const input: EthRangeEntryQualityInput = {
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "CANONICAL_RANGE",
            routingEngine: "RANGE",
            isInitialEntry: true,
            isAddon: false,
            boxPos: 0.133,
            zone: "lower",
            rangeSideCandidate: "long",
            trendSideCandidate: "short",
            selectedSideAfterVeto: "long",
            reversalConfirmed: true,
            sideZoneValid: true,
            rangeEdgeExtreme: false,
            qualityScore: 76,
            entryQualityGrade: "A",
            htfEntryPolicy: "SHORT_ONLY_OR_NONE",
            directionalShockState: "NONE",
            emitProof: false
        };

        const res = evaluateEthRangeEntryQualityGate(input);
        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, false);
        assert.equal(res.classification, "ETH_RANGE_BLOCK");
    });

    it("CASE F: opposing shock (DOWN for long) -> BLOCKED", () => {
        const input: EthRangeEntryQualityInput = {
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "CANONICAL_RANGE",
            routingEngine: "RANGE",
            isInitialEntry: true,
            isAddon: false,
            boxPos: 0.133,
            zone: "lower",
            rangeSideCandidate: "long",
            trendSideCandidate: "short",
            selectedSideAfterVeto: "long",
            reversalConfirmed: true,
            sideZoneValid: true,
            rangeEdgeExtreme: false,
            qualityScore: 76,
            entryQualityGrade: "A",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            directionalShockState: "DOWN",
            emitProof: false
        };

        const res = evaluateEthRangeEntryQualityGate(input);
        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, false);
        assert.equal(res.classification, "ETH_RANGE_BLOCK");
    });

    it("CASE G: aligned RANGE long boxPos=0.28, reversal=true, quality>=70 -> ETH_RANGE_LOCATION_PROBE (0.50x)", () => {
        const input: EthRangeEntryQualityInput = {
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "CANONICAL_RANGE",
            routingEngine: "RANGE",
            isInitialEntry: true,
            isAddon: false,
            boxPos: 0.28,
            zone: "lower",
            rangeSideCandidate: "long",
            trendSideCandidate: "long",
            selectedSideAfterVeto: "long",
            reversalConfirmed: true,
            sideZoneValid: true,
            rangeEdgeExtreme: false,
            qualityScore: 74,
            entryQualityGrade: "B",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            directionalShockState: "NONE",
            emitProof: false
        };

        const res = evaluateEthRangeEntryQualityGate(input);
        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, true);
        assert.equal(res.classification, "ETH_RANGE_LOCATION_PROBE");
        assert.equal(res.probeMultiplier, 0.50);
        assert.equal(res.isProbe, true);
    });

    it("CASE H: aligned RANGE long boxPos=0.15, reversal=true, quality>=70 -> ETH_RANGE_FULL (1.0x)", () => {
        const input: EthRangeEntryQualityInput = {
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "CANONICAL_RANGE",
            routingEngine: "RANGE",
            isInitialEntry: true,
            isAddon: false,
            boxPos: 0.15,
            zone: "lower",
            rangeSideCandidate: "long",
            trendSideCandidate: "long",
            selectedSideAfterVeto: "long",
            reversalConfirmed: true,
            sideZoneValid: true,
            rangeEdgeExtreme: false,
            qualityScore: 75,
            entryQualityGrade: "A",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            directionalShockState: "NONE",
            emitProof: false
        };

        const res = evaluateEthRangeEntryQualityGate(input);
        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, true);
        assert.equal(res.classification, "ETH_RANGE_FULL");
        assert.equal(res.probeMultiplier, 1.0);
        assert.equal(res.isProbe, false);
    });

    it("CASE I: selected candidate none -> evaluated=false", () => {
        const input: EthRangeEntryQualityInput = {
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "CANONICAL_RANGE",
            routingEngine: "RANGE",
            isInitialEntry: true,
            isAddon: false,
            boxPos: 0.15,
            zone: "lower",
            rangeSideCandidate: "none",
            trendSideCandidate: "none",
            selectedSideAfterVeto: "none",
            reversalConfirmed: true,
            sideZoneValid: true,
            rangeEdgeExtreme: false,
            qualityScore: 75,
            entryQualityGrade: "A",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            directionalShockState: "NONE",
            emitProof: false
        };

        const res = evaluateEthRangeEntryQualityGate(input);
        assert.equal(res.evaluated, false);
    });

    it("CASE J: BTC -> completely bypassed (evaluated=false)", () => {
        const input: EthRangeEntryQualityInput = {
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "CANONICAL_RANGE",
            routingEngine: "RANGE",
            isInitialEntry: true,
            isAddon: false,
            boxPos: 0.133,
            zone: "lower",
            rangeSideCandidate: "long",
            trendSideCandidate: "short",
            selectedSideAfterVeto: "long",
            reversalConfirmed: true,
            sideZoneValid: true,
            rangeEdgeExtreme: false,
            qualityScore: 76,
            entryQualityGrade: "A",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            directionalShockState: "NONE",
            emitProof: false
        };

        const res = evaluateEthRangeEntryQualityGate(input);
        assert.equal(res.evaluated, false);
        assert.equal(res.allowed, true);
    });

    it("CASE K: FAST_TREND_SHIFT -> completely bypassed (evaluated=false)", () => {
        const input: EthRangeEntryQualityInput = {
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "FAST_TREND_SHIFT",
            routingEngine: "RANGE",
            isInitialEntry: true,
            isAddon: false,
            boxPos: 0.133,
            zone: "lower",
            rangeSideCandidate: "long",
            trendSideCandidate: "short",
            selectedSideAfterVeto: "long",
            reversalConfirmed: true,
            sideZoneValid: true,
            rangeEdgeExtreme: false,
            qualityScore: 76,
            entryQualityGrade: "A",
            htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
            directionalShockState: "NONE",
            promotionReason: "FAST_TREND_SHIFT_LONG_CONFIRMED",
            emitProof: false
        };

        const res = evaluateEthRangeEntryQualityGate(input);
        assert.equal(res.evaluated, false);
        assert.equal(res.allowed, true);
    });

    // 2. Full runEngineV2 Integration Tests with adaptV2Input

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

    it("Integration CASE A: Upstream HOLD ETH countertrend edge is promoted to ENTER with 0.25x sizing via bridge", () => {
        let logs: Record<string, unknown>[] = [];
        logs = captureProofLogs(() => {
            const res = evaluateEthRangeEntryQualityGate({
                symbol: "ETHUSDT",
                side: "long",
                regime: "RANGE",
                subtype: "CANONICAL_RANGE",
                routingEngine: "RANGE",
                isInitialEntry: true,
                isAddon: false,
                boxPos: 0.133,
                zone: "lower",
                rangeSideCandidate: "long",
                trendSideCandidate: "short",
                selectedSideAfterVeto: "long",
                reversalConfirmed: true,
                sideZoneValid: true,
                rangeEdgeExtreme: false,
                qualityScore: 76,
                entryQualityGrade: "A",
                htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
                directionalShockState: "NONE",
                emitProof: true,
                baseOrderNotionalBeforeEthProbe: 40,
                liveBaselineOrderNotional: 40,
                submittedOrderNotional: 10,
                liveMaxOrderNotionalUsdt: 40
            });

            assert.equal(res.allowed, true);
            assert.equal(res.classification, "ETH_RANGE_COUNTERTREND_EDGE_PROBE");
            assert.equal(res.probeMultiplier, 0.25);
        });

        const qualityProof = logs.find(l => l.event === "ETH_RANGE_ENTRY_QUALITY_PROOF");
        assert.ok(qualityProof, "ETH_RANGE_ENTRY_QUALITY_PROOF must be emitted");
        assert.equal(qualityProof.classification, "ETH_RANGE_COUNTERTREND_EDGE_PROBE");
        assert.equal(qualityProof.probe_multiplier, 0.25);
        assert.equal(qualityProof.submitted_order_notional, 10);
    });

    it("Integration Sizing: Baseline 40 gives submitted 10 on COUNTERTREND_EDGE_PROBE (0.25x), 20 on LOCATION_PROBE (0.50x), 40 on FULL (1.0x)", () => {
        const fullRes = evaluateEthRangeEntryQualityGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            boxPos: 0.15,
            reversalConfirmed: true,
            qualityScore: 75,
            isInitialEntry: true,
            emitProof: false
        });
        assert.equal(fullRes.probeMultiplier, 1.0);
        assert.equal(40 * fullRes.probeMultiplier, 40);

        const locRes = evaluateEthRangeEntryQualityGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            boxPos: 0.28,
            reversalConfirmed: true,
            qualityScore: 75,
            isInitialEntry: true,
            emitProof: false
        });
        assert.equal(locRes.probeMultiplier, 0.50);
        assert.equal(40 * locRes.probeMultiplier, 20);

        const edgeRes = evaluateEthRangeEntryQualityGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            boxPos: 0.133,
            trendSideCandidate: "short",
            sideZoneValid: true,
            reversalConfirmed: true,
            qualityScore: 76,
            isInitialEntry: true,
            emitProof: false
        });
        assert.equal(edgeRes.probeMultiplier, 0.25);
        assert.equal(40 * edgeRes.probeMultiplier, 10);
    });

    // ── 3. 2026-09-24 08:10:57 ETHUSDT Promotion Downgrade Veto Fix Regression Suite ────

    function makeEthProductionBridge(overrides: Record<string, unknown> = {}) {
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
            entryQualityProfiles: {
                profit: { qualityScoreAvg: 90, emaGapAvg: 0.005, atrPctAvg: 0.01, volumeRatioAvg: 1.2, count: 8 },
                loss: { qualityScoreAvg: 55, emaGapAvg: 0.001, atrPctAvg: 0.01, volumeRatioAvg: 0.9, count: 2 },
                contaminated: { qualityScoreAvg: 60, emaGapAvg: 0.002, atrPctAvg: 0.01, volumeRatioAvg: 1.0, count: 1 }
            },
            ...overrides
        };
    }

    function makeEthLiveConfig(overrides: Record<string, unknown> = {}) {
        return {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            maxSymbolNotionalUsd: 5000,
            maxAccountNotionalUsd: 20000,
            okxLiveEnabled: true,
            okxAuthMode: "live",
            okxExchangeAuthOptIn: true,
            okxLiveMaxOrderNotionalUsdt: 200,
            serverTradeEnabled: true,
            ...overrides
        };
    }

    it("REGRESSION 1: 2026-09-24 08:10:57 ETH fixture (promotionApplied=true, SHORT->LONG, stale rangeSignalDowngraded=true) -> ENTER preserved, no RANGE_SIGNAL_DOWNGRADED_NOT_RELAXED veto", () => {
        globalShockStates.delete("ETHUSDT");
        const candles = Array.from({ length: 120 }, (_, i) => {
            const wave = Math.sin(i / 10) * 5;
            const px = 2375 + wave;
            return {
                ts: Date.now() - (120 - i) * 60000,
                open: px,
                high: px + 2,
                low: px - 2,
                close: i === 119 ? 2375 : px + 0.1,
                volume: 50
            };
        });
        const bullishHtf = Array.from({ length: 120 }, (_, i) => ({
            ts: Date.now() - (120 - i) * 60000,
            open: 2360 + i * 0.5,
            high: 2360 + i * 0.5 + 2,
            low: 2360 + i * 0.5 - 2,
            close: 2360 + i * 0.5 + 0.3,
            volume: 50
        }));
        const cycleNow = Date.now();
        const snap = {
            symbol: "ETHUSDT",
            lastPrice: 2375,
            latestCandleClose: 2375,
            signal: "paper_long_candidate",
            entryCandidate: true,
            qualityScore: 76,
            candidateStrength: "normal",
            ema20: 2400 * (1 + 0.004 / 2),
            ema60: 2400 * (1 - 0.004 / 2),
            emaGap: 0.004,
            volumeRatioProxy: 1.1,
            boxHigh: 2430,
            boxLow: 2370,
            boxPos: 0.133,
            boxRel: 0.025,
            atr: 15,
            atr20: 15,
            tickSz: 0.01,
            closedClose: 2375,
            rangeConfidence: 0.78,
            trendWeaknessScore: 0.25,
            boxCohesion01: 0.92,
            breakoutFailureRate: 0.15,
            rangeOscillationScore: 0.65,
            rangeSignalDowngraded: true,
            reversalConfirmed: true,
            reversal_confirmed: true,
            executor_metadata: {
                reversal_confirmed: true,
                boxPos: 0.133,
                rangeConfidence: 0.78,
                boxCohesion01: 0.92,
                trendWeaknessScore: 0.25
            },
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": bullishHtf, "4h": bullishHtf },
            canonicalRegime: "RANGE",
            canonicalRegimeSource: "strategy_market_regime_detector",
            canonicalTrendScore: 0.35,
            takeProfit1Px: 2400,
            executableTp1Price: 2400,
            plannedStopPrice: 2355,
            takeProfitPlan: { tp1: 2400, tp2: 2430, invalidationPx: 2355, partialRatio: 0.5 },
            reviewing_ticks: 0
        };

        const input = adaptV2Input(
            "ETHUSDT",
            cycleNow,
            buildV2SnapshotBridge(snap as any) as any,
            makeEthLiveConfig({
                highwayMinRewardRisk: 0.01,
                highwayMinCostMultiplier: 0.01,
                paperTakerFeeRate: 0.0001
            }) as any,
            makeEthProductionBridge({
                balanceFetchedAt: cycleNow,
                positionsFetchedAt: cycleNow,
                pendingOrdersFetchedAt: cycleNow
            }) as any,
            {
                decision: {
                    final_decision: "ENTER",
                    side: "short",
                    stopPrice: 2390,
                    invalidationPx: 2390,
                    takeProfit1Px: 2360,
                    takeProfitPlan: { tp1: 2360, tp2: 2340, invalidationPx: 2390, partialRatio: 0.5 }
                }
            } as any,
            candles,
            "authoritative",
            `eth_downgrade_fix_${cycleNow}`
        );

        (input.snapshot as any).reversal_confirmed = true;
        (input.snapshot as any).reversalConfirmed = true;
        (input.snapshot as any).executor_metadata = snap.executor_metadata;
        (input.config as any).highwayMinRewardRisk = 0.01;
        (input.config as any).highwayMinCostMultiplier = 0.01;
        (input.config as any).paperTakerFeeRate = 0.0001;
        (input.config as any).okxLiveMaxOrderNotionalUsdt = 40;

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            const res = runEngineV2(input);
            decision = res.decision;
        });

        const authorityProof = proofs.find(p => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
        const consistencyProof = proofs.find(p => p.event === "V2_SELECTED_SIDE_CONSISTENCY_PROOF");
        const zoneVetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");
        const finalizerProof = proofs.find(p => p.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");

        console.log("[ETH_2026-09-24_08:10:57_PROOF]", JSON.stringify({
            v2DecisionBeforePromotion: authorityProof?.native_executor_decision_source,
            v2SideBeforePromotion: authorityProof?.native_executor_side_source,
            promotionApplied: authorityProof?.promotion_applied_at_native_authority_eval,
            promotionReason: authorityProof?.promotion_reason_at_native_authority_eval,
            v2SideAfterPromotion: authorityProof?.side_after_promotion_at_native_authority_eval,
            rangeSignalDowngraded: snap.rangeSignalDowngraded,
            rangeDowngradedHardBlock: authorityProof?.range_downgraded_hard_block,
            finalDecisionBeforeVeto: consistencyProof?.finalDecisionBeforeVeto ?? zoneVetoProof?.finalDecisionBeforeVeto,
            finalDecisionAfterVeto: consistencyProof?.finalDecisionAfterVeto
        }, null, 2));

        assert.equal(authorityProof?.side_after_promotion_at_native_authority_eval, "long");
        assert.equal(authorityProof?.range_downgraded_hard_block, false, "Side flip short->long must exempt downgrade hard block");
        assert.notEqual(zoneVetoProof?.vetoReason, "RANGE_SIGNAL_DOWNGRADED_NOT_RELAXED");
        assert.equal(consistencyProof?.finalDecisionAfterVeto, "ENTER");
        assert.equal(consistencyProof?.selected_side_after_veto, "long");
    });

    it("REGRESSION 2: promotionApplied=false non-promoted RANGE downgrade -> Blocked by RANGE_SIGNAL_DOWNGRADED_NOT_RELAXED (not ENTER)", () => {
        globalShockStates.delete("ETHUSDT");
        const candles = makeEthRangeCandles(2400, 30, 2400);
        const cycleNow = Date.now();
        const snap = {
            symbol: "ETHUSDT",
            lastPrice: 2400,
            latestCandleClose: 2400,
            signal: "paper_long_candidate",
            entryCandidate: false,
            qualityScore: 65, // < 70 => no quality promotion
            candidateStrength: "normal",
            ema20: 2400,
            ema60: 2400,
            emaGap: 0.001,
            volumeRatioProxy: 1.0,
            boxHigh: 2430,
            boxLow: 2370,
            boxPos: 0.50, // mid zone => no lower reaction promotion
            boxRel: 0.025,
            atr: 15,
            atr20: 15,
            closedClose: 2400,
            rangeConfidence: 0.78,
            trendWeaknessScore: 0.25,
            boxCohesion01: 0.92,
            breakoutFailureRate: 0.15,
            rangeOscillationScore: 0.65,
            rangeSignalDowngraded: true,
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles },
            canonicalRegime: "RANGE",
            canonicalRegimeSource: "strategy_market_regime_detector",
            canonicalTrendScore: 0.35,
            reviewing_ticks: 0
        };

        const input = adaptV2Input(
            "ETHUSDT",
            cycleNow,
            buildV2SnapshotBridge(snap as any) as any,
            makeEthLiveConfig() as any,
            makeEthProductionBridge({
                balanceFetchedAt: cycleNow,
                positionsFetchedAt: cycleNow,
                pendingOrdersFetchedAt: cycleNow
            }) as any,
            { decision: { final_decision: "SKIP" } } as any,
            candles,
            "authoritative",
            `eth_downgrade_non_promo_${cycleNow}`
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            const res = runEngineV2(input);
            decision = res.decision;
        });

        assert.notEqual(decision.decision, "ENTER", "Must not ENTER when not promoted and range downgraded");
        const zoneVetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");
        assert.ok(zoneVetoProof?.vetoReason === "RANGE_SIGNAL_DOWNGRADED_NOT_RELAXED" || decision.decision !== "ENTER");
    });

    it("REGRESSION 3: promotionApplied=true but STRONG HIGHWAY opposite / HTF hard block -> Still blocked", () => {
        globalShockStates.delete("ETHUSDT");
        const candles = makeEthRangeCandles(2400, 30, 2375);
        const cycleNow = Date.now();
        const snap = {
            symbol: "ETHUSDT",
            lastPrice: 2375,
            latestCandleClose: 2375,
            signal: "paper_short_candidate",
            entryCandidate: false,
            qualityScore: 76,
            candidateStrength: "normal",
            ema20: 2400 * (1 - 0.004 / 2),
            ema60: 2400 * (1 + 0.004 / 2),
            emaGap: -0.004,
            volumeRatioProxy: 1.1,
            boxHigh: 2430,
            boxLow: 2370,
            boxPos: 0.133,
            boxRel: 0.025,
            atr: 15,
            atr20: 15,
            closedClose: 2375,
            rangeConfidence: 0.78,
            trendWeaknessScore: 0.25,
            boxCohesion01: 0.92,
            breakoutFailureRate: 0.15,
            rangeOscillationScore: 0.65,
            rangeSignalDowngraded: true,
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles },
            canonicalRegime: "RANGE",
            canonicalRegimeSource: "strategy_market_regime_detector",
            canonicalTrendScore: 0.35,
            reviewing_ticks: 0
        };

        // Long is disallowed by risk / directional block
        const input = adaptV2Input(
            "ETHUSDT",
            cycleNow,
            buildV2SnapshotBridge(snap as any) as any,
            makeEthLiveConfig() as any,
            makeEthProductionBridge({
                longAllow: false, // Risk / directional hard block on LONG
                balanceFetchedAt: cycleNow,
                positionsFetchedAt: cycleNow,
                pendingOrdersFetchedAt: cycleNow
            }) as any,
            { decision: { final_decision: "SKIP" } } as any,
            candles,
            "authoritative",
            `eth_safety_block_${cycleNow}`
        );

        const { decision } = runEngineV2(input);
        assert.notEqual(decision.decision, "ENTER", "Must not enter when directional risk blocks long");
    });

    it("REGRESSION 4: Promotion tentative/unconfirmed (promotionApplied=false) -> Exception does not apply", () => {
        globalShockStates.delete("ETHUSDT");
        const candles = makeEthRangeCandles(2400, 30, 2400);
        const cycleNow = Date.now();
        const snap = {
            symbol: "ETHUSDT",
            lastPrice: 2400,
            latestCandleClose: 2400,
            signal: "paper_short_candidate",
            entryCandidate: false,
            qualityScore: 60, // Quality too low for promotion
            candidateStrength: "normal",
            ema20: 2400,
            ema60: 2400,
            emaGap: -0.001,
            volumeRatioProxy: 1.0,
            boxHigh: 2430,
            boxLow: 2370,
            boxPos: 0.50, // Mid zone, no lower reaction promotion
            boxRel: 0.025,
            atr: 15,
            atr20: 15,
            closedClose: 2400,
            rangeConfidence: 0.78,
            trendWeaknessScore: 0.25,
            boxCohesion01: 0.92,
            breakoutFailureRate: 0.15,
            rangeOscillationScore: 0.65,
            rangeSignalDowngraded: true,
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles },
            canonicalRegime: "RANGE",
            canonicalRegimeSource: "strategy_market_regime_detector",
            canonicalTrendScore: 0.35,
            reviewing_ticks: 0
        };

        const input = adaptV2Input(
            "ETHUSDT",
            cycleNow,
            buildV2SnapshotBridge(snap as any) as any,
            makeEthLiveConfig() as any,
            makeEthProductionBridge({
                balanceFetchedAt: cycleNow,
                positionsFetchedAt: cycleNow,
                pendingOrdersFetchedAt: cycleNow
            }) as any,
            { decision: { final_decision: "SKIP" } } as any,
            candles,
            "authoritative",
            `eth_tentative_promo_${cycleNow}`
        );

        const { decision } = runEngineV2(input);
        assert.notEqual(decision.decision, "ENTER", "Must not enter when promotion is unconfirmed/tentative");
    });

    it("REGRESSION 5: long -> long same-side promotion + downgrade -> hard block preserved (not ENTER)", () => {
        globalShockStates.delete("ETHUSDT");
        const candles = makeEthRangeCandles(2400, 30, 2375);
        const cycleNow = Date.now();
        // Aligned long candidate (long -> long promotion candidate)
        const snap = {
            symbol: "ETHUSDT",
            lastPrice: 2375,
            latestCandleClose: 2375,
            signal: "paper_long_candidate",
            entryCandidate: true,
            qualityScore: 76,
            candidateStrength: "normal",
            ema20: 2400 * (1 + 0.004 / 2),
            ema60: 2400 * (1 - 0.004 / 2),
            emaGap: 0.004,
            volumeRatioProxy: 1.1,
            boxHigh: 2430,
            boxLow: 2370,
            boxPos: 0.15,
            boxRel: 0.025,
            atr: 15,
            atr20: 15,
            closedClose: 2375,
            rangeConfidence: 0.78,
            trendWeaknessScore: 0.25,
            boxCohesion01: 0.92,
            breakoutFailureRate: 0.15,
            rangeOscillationScore: 0.65,
            rangeSignalDowngraded: true,
            reversalConfirmed: true,
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles },
            canonicalRegime: "RANGE",
            canonicalRegimeSource: "strategy_market_regime_detector",
            canonicalTrendScore: 0.35,
            reviewing_ticks: 0
        };

        const input = adaptV2Input(
            "ETHUSDT",
            cycleNow,
            buildV2SnapshotBridge(snap as any) as any,
            makeEthLiveConfig() as any,
            makeEthProductionBridge({
                balanceFetchedAt: cycleNow,
                positionsFetchedAt: cycleNow,
                pendingOrdersFetchedAt: cycleNow
            }) as any,
            { decision: { final_decision: "SKIP" } } as any,
            candles,
            "authoritative",
            `eth_sameside_long_${cycleNow}`
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            const res = runEngineV2(input);
            decision = res.decision;
        });

        const authorityProof = proofs.find(p => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
        const zoneVetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");

        // Same-side promotion: sideBefore was long, sideAfter is long => NOT side flipped
        // Therefore rangeDowngradedHardBlock is NOT exempted
        assert.equal(authorityProof?.native_executor_side_source, "long");
        assert.equal(authorityProof?.side_after_promotion_at_native_authority_eval, "long");
        assert.equal(authorityProof?.range_downgraded_hard_block, true, "Same-side long promotion must not exempt downgrade hard block");
        assert.notEqual(decision.decision, "ENTER", "Same-side long promotion must not ENTER when downgraded");
    });

    it("REGRESSION 6: short -> short same-side promotion + downgrade -> hard block preserved (not ENTER)", () => {
        globalShockStates.delete("ETHUSDT");
        const candles = Array.from({ length: 120 }, (_, i) => ({
            ts: Date.now() - (120 - i) * 60000,
            open: 2430 - i * 0.05,
            high: 2431 - i * 0.05,
            low: 2429 - i * 0.05,
            close: 2430 - i * 0.05,
            volume: 50
        }));
        const cycleNow = Date.now();
        // Aligned short candidate at upper edge (short -> short promotion candidate)
        const snap = {
            symbol: "ETHUSDT",
            lastPrice: 2425,
            latestCandleClose: 2425,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 76,
            candidateStrength: "normal",
            ema20: 2400 * (1 - 0.004 / 2),
            ema60: 2400 * (1 + 0.004 / 2),
            emaGap: -0.004,
            volumeRatioProxy: 1.1,
            boxHigh: 2430,
            boxLow: 2370,
            boxPos: 0.85,
            boxRel: 0.025,
            atr: 15,
            atr20: 15,
            closedClose: 2425,
            rangeConfidence: 0.78,
            trendWeaknessScore: 0.25,
            boxCohesion01: 0.92,
            breakoutFailureRate: 0.15,
            rangeOscillationScore: 0.65,
            rangeSignalDowngraded: true,
            reversalConfirmed: true,
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles },
            canonicalRegime: "RANGE",
            canonicalRegimeSource: "strategy_market_regime_detector",
            canonicalTrendScore: 0.35,
            reviewing_ticks: 0
        };

        const input = adaptV2Input(
            "ETHUSDT",
            cycleNow,
            buildV2SnapshotBridge(snap as any) as any,
            makeEthLiveConfig() as any,
            makeEthProductionBridge({
                balanceFetchedAt: cycleNow,
                positionsFetchedAt: cycleNow,
                pendingOrdersFetchedAt: cycleNow
            }) as any,
            { decision: { final_decision: "SKIP" } } as any,
            candles,
            "authoritative",
            `eth_sameside_short_${cycleNow}`
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            const res = runEngineV2(input);
            decision = res.decision;
        });

        const authorityProof = proofs.find(p => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");

        // Same-side short: sideAfter is short and sideBefore is short => NOT side flipped
        assert.equal(authorityProof?.side_after_promotion_at_native_authority_eval, "short");
        assert.equal(authorityProof?.range_downgraded_hard_block, true, "Same-side short promotion must not exempt downgrade hard block");
        assert.notEqual(decision.decision, "ENTER", "Same-side short promotion must not ENTER when downgraded");
    });

    it("REGRESSION 7: long -> short flip + opposite stale downgrade -> ENTER preserved (side flip exemption applies)", () => {
        globalShockStates.delete("ETHUSDT");
        const candles = Array.from({ length: 120 }, (_, i) => ({
            ts: Date.now() - (120 - i) * 60000,
            open: 2400 + i * 0.2,
            high: 2401 + i * 0.2,
            low: 2399 + i * 0.2,
            close: 2400 + i * 0.2,
            volume: 50
        }));
        const bearishHtf = Array.from({ length: 120 }, (_, i) => ({
            ts: Date.now() - (120 - i) * 60000,
            open: 2440 - i * 0.5,
            high: 2440 - i * 0.5 + 2,
            low: 2440 - i * 0.5 - 2,
            close: 2440 - i * 0.5 - 0.3,
            volume: 50
        }));
        const cycleNow = Date.now();
        // Upper zone short reaction promotion where initial executor candidate was long
        const snap = {
            symbol: "ETHUSDT",
            lastPrice: 2425,
            latestCandleClose: 2425,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 76,
            candidateStrength: "normal",
            ema20: 2400 * (1 - 0.004 / 2),
            ema60: 2400 * (1 + 0.004 / 2),
            emaGap: -0.004,
            volumeRatioProxy: 1.1,
            boxHigh: 2430,
            boxLow: 2370,
            boxPos: 0.867,
            boxRel: 0.025,
            atr: 15,
            atr20: 15,
            closedClose: 2425,
            rangeConfidence: 0.78,
            trendWeaknessScore: 0.25,
            boxCohesion01: 0.92,
            breakoutFailureRate: 0.15,
            rangeOscillationScore: 0.65,
            rangeSignalDowngraded: true,
            reversalConfirmed: true,
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": bearishHtf, "4h": bearishHtf },
            canonicalRegime: "RANGE",
            canonicalRegimeSource: "strategy_market_regime_detector",
            canonicalTrendScore: 0.35,
            takeProfit1Px: 2400,
            executableTp1Price: 2400,
            plannedStopPrice: 2445,
            takeProfitPlan: { tp1: 2400, tp2: 2370, invalidationPx: 2445, partialRatio: 0.5 },
            reviewing_ticks: 0
        };

        const input = adaptV2Input(
            "ETHUSDT",
            cycleNow,
            buildV2SnapshotBridge(snap as any) as any,
            makeEthLiveConfig() as any,
            makeEthProductionBridge({
                balanceFetchedAt: cycleNow,
                positionsFetchedAt: cycleNow,
                pendingOrdersFetchedAt: cycleNow
            }) as any,
            { decision: { final_decision: "ENTER", side: "long" } } as any,
            candles,
            "authoritative",
            `eth_long_to_short_flip_${cycleNow}`
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            const res = runEngineV2(input);
            decision = res.decision;
        });

        const authorityProof = proofs.find(p => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
        const zoneVetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");

        // Side flipped: long -> short
        assert.equal(authorityProof?.side_after_promotion_at_native_authority_eval, "short");
        assert.equal(authorityProof?.promotion_applied_at_native_authority_eval, true);
        assert.equal(authorityProof?.range_downgraded_hard_block, false, "Side flipped promotion must exempt downgrade hard block");
        assert.notEqual(zoneVetoProof?.vetoReason, "RANGE_SIGNAL_DOWNGRADED_NOT_RELAXED");
    });
});
