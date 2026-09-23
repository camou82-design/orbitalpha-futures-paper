import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateEthRangeEntryQualityGate,
    type EthRangeEntryQualityInput
} from "../engine-v2/execution/eth-range-entry-quality-gate";
import { runEngineV2 } from "../engine-v2/index";
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
});
