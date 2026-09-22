import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateEthRangeEntryQualityGate,
    type EthRangeEntryQualityInput
} from "../engine-v2/execution/eth-range-entry-quality-gate";

describe("V2 ETH RANGE Dedicated Entry Quality Gate Test Suite", () => {
    const baseInput: EthRangeEntryQualityInput = {
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
        qualityScore: 82,
        entryQualityGrade: "A",
        htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
        directionalShockState: "NONE",
        emitProof: false
    };

    // 1. ETH long boxPos=0.15, reversal=true, trendSide=long → FULL
    it("CASE 1: ETH long boxPos=0.15 + reversal=true + trendSide=long → FULL (1.0x)", () => {
        const res = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "long",
            boxPos: 0.15,
            reversalConfirmed: true,
            trendSideCandidate: "long"
        });

        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, true);
        assert.equal(res.classification, "ETH_RANGE_FULL");
        assert.equal(res.probeMultiplier, 1.0);
        assert.equal(res.isProbe, false);
        assert.equal(res.blockReason, null);
    });

    // 2. ETH short boxPos=0.85, reversal=true, trendSide=none/short → FULL
    it("CASE 2: ETH short boxPos=0.85 + reversal=true + trendSide=none/short → FULL (1.0x)", () => {
        const resNone = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "short",
            zone: "upper",
            rangeSideCandidate: "short",
            boxPos: 0.85,
            reversalConfirmed: true,
            trendSideCandidate: "none"
        });

        assert.equal(resNone.evaluated, true);
        assert.equal(resNone.allowed, true);
        assert.equal(resNone.classification, "ETH_RANGE_FULL");
        assert.equal(resNone.probeMultiplier, 1.0);
        assert.equal(resNone.isProbe, false);

        const resShort = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "short",
            zone: "upper",
            rangeSideCandidate: "short",
            boxPos: 0.85,
            reversalConfirmed: true,
            trendSideCandidate: "short"
        });

        assert.equal(resShort.evaluated, true);
        assert.equal(resShort.allowed, true);
        assert.equal(resShort.classification, "ETH_RANGE_FULL");
        assert.equal(resShort.probeMultiplier, 1.0);
        assert.equal(resShort.isProbe, false);
    });

    // 3. ETH long boxPos=0.28, reversal=true, trendSide=long → PROBE (ETH_RANGE_LOCATION_PROBE)
    it("CASE 3: ETH long boxPos=0.28 + reversal=true + trendSide=long → PROBE (ETH_RANGE_LOCATION_PROBE, 0.50x)", () => {
        const res = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "long",
            boxPos: 0.28,
            reversalConfirmed: true,
            trendSideCandidate: "long"
        });

        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, true);
        assert.equal(res.classification, "ETH_RANGE_LOCATION_PROBE");
        assert.equal(res.probeMultiplier, 0.50);
        assert.equal(res.isProbe, true);
        assert.equal(res.blockReason, null);
    });

    // 4. ETH short boxPos=0.72, reversal=true, trendSide=short → PROBE (ETH_RANGE_LOCATION_PROBE)
    it("CASE 4: ETH short boxPos=0.72 + reversal=true + trendSide=short → PROBE (ETH_RANGE_LOCATION_PROBE, 0.50x)", () => {
        const res = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "short",
            zone: "upper",
            rangeSideCandidate: "short",
            boxPos: 0.72,
            reversalConfirmed: true,
            trendSideCandidate: "short"
        });

        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, true);
        assert.equal(res.classification, "ETH_RANGE_LOCATION_PROBE");
        assert.equal(res.probeMultiplier, 0.50);
        assert.equal(res.isProbe, true);
        assert.equal(res.blockReason, null);
    });

    // 5. ETH long boxPos=0.15, reversal=false, trendSide=long → FULL 금지, PROBE (ETH_RANGE_UNCONFIRMED_PROBE)
    it("CASE 5: ETH long boxPos=0.15 + reversal=false + trendSide=long → UNCONFIRMED PROBE (0.50x)", () => {
        const res = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "long",
            boxPos: 0.15,
            reversalConfirmed: false,
            trendSideCandidate: "long"
        });

        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, true);
        assert.equal(res.classification, "ETH_RANGE_UNCONFIRMED_PROBE");
        assert.equal(res.probeMultiplier, 0.50);
        assert.equal(res.isProbe, true);
        assert.equal(res.blockReason, null);
    });

    // 6. ETH short boxPos=0.85, reversal=false, trendSide=short → FULL 금지, PROBE (ETH_RANGE_UNCONFIRMED_PROBE)
    it("CASE 6: ETH short boxPos=0.85 + reversal=false + trendSide=short → UNCONFIRMED PROBE (0.50x)", () => {
        const res = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "short",
            zone: "upper",
            rangeSideCandidate: "short",
            boxPos: 0.85,
            reversalConfirmed: false,
            trendSideCandidate: "short"
        });

        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, true);
        assert.equal(res.classification, "ETH_RANGE_UNCONFIRMED_PROBE");
        assert.equal(res.probeMultiplier, 0.50);
        assert.equal(res.isProbe, true);
        assert.equal(res.blockReason, null);
    });

    // 7. ETH short boxPos=0.85, reversal=true, trendSide=long → BLOCK (countertrend not extreme)
    it("CASE 7: ETH short boxPos=0.85 + reversal=true + trendSide=long → BLOCK (ETH_RANGE_COUNTERTREND_NOT_EXTREME_CONFIRMED)", () => {
        const res = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "short",
            zone: "upper",
            rangeSideCandidate: "short",
            boxPos: 0.85,
            reversalConfirmed: true,
            trendSideCandidate: "long"
        });

        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, false);
        assert.equal(res.classification, "ETH_RANGE_BLOCK");
        assert.equal(res.blockReason, "ETH_RANGE_COUNTERTREND_NOT_EXTREME_CONFIRMED");
        assert.equal(res.probeMultiplier, 0.0);
        assert.equal(res.isProbe, false);
    });

    // 8. ETH short boxPos=0.94, reversal=true, trendSide=long → COUNTERTREND EXTREME PROBE (0.50x)
    it("CASE 8: ETH short boxPos=0.94 + reversal=true + trendSide=long → COUNTERTREND EXTREME PROBE (0.50x)", () => {
        const res = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "short",
            zone: "upper",
            rangeSideCandidate: "short",
            boxPos: 0.94,
            reversalConfirmed: true,
            trendSideCandidate: "long"
        });

        assert.equal(res.evaluated, true);
        assert.equal(res.allowed, true);
        assert.equal(res.classification, "ETH_RANGE_COUNTERTREND_EXTREME_PROBE");
        assert.equal(res.probeMultiplier, 0.50);
        assert.equal(res.isProbe, true);
        assert.equal(res.blockReason, null);
    });

    // 9. ETH long countertrend symmetry cases
    it("CASE 9: ETH long countertrend symmetry (boxPos=0.15 blocked, boxPos=0.06 extreme probe)", () => {
        const resBlocked = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "long",
            boxPos: 0.15,
            reversalConfirmed: true,
            trendSideCandidate: "short"
        });

        assert.equal(resBlocked.evaluated, true);
        assert.equal(resBlocked.allowed, false);
        assert.equal(resBlocked.classification, "ETH_RANGE_BLOCK");
        assert.equal(resBlocked.blockReason, "ETH_RANGE_COUNTERTREND_NOT_EXTREME_CONFIRMED");

        const resExtreme = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "long",
            boxPos: 0.06,
            reversalConfirmed: true,
            trendSideCandidate: "short"
        });

        assert.equal(resExtreme.evaluated, true);
        assert.equal(resExtreme.allowed, true);
        assert.equal(resExtreme.classification, "ETH_RANGE_COUNTERTREND_EXTREME_PROBE");
        assert.equal(resExtreme.probeMultiplier, 0.50);
        assert.equal(resExtreme.isProbe, true);
    });

    // 10. BTC long/short RANGE is 100% bypassed with 0 change
    it("CASE 10: BTCUSDT is completely bypassed with zero behavior change", () => {
        const btcLong = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            symbol: "BTCUSDT",
            side: "long",
            boxPos: 0.30,
            reversalConfirmed: false,
            trendSideCandidate: "short"
        });

        assert.equal(btcLong.evaluated, false);
        assert.equal(btcLong.allowed, true);
        assert.equal(btcLong.classification, "ETH_RANGE_FULL");
        assert.equal(btcLong.probeMultiplier, 1.0);

        const btcShort = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            symbol: "BTCUSDT",
            side: "short",
            boxPos: 0.70,
            reversalConfirmed: false,
            trendSideCandidate: "long"
        });

        assert.equal(btcShort.evaluated, false);
        assert.equal(btcShort.allowed, true);
        assert.equal(btcShort.classification, "ETH_RANGE_FULL");
        assert.equal(btcShort.probeMultiplier, 1.0);
    });

    // 11. FAST_TREND_SHIFT / confirmed FTS 010055d is bypassed
    it("CASE 11: FAST_TREND_SHIFT subtype or promotionReason is completely bypassed", () => {
        const ftsUpperLong = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            subtype: "FAST_TREND_SHIFT",
            promotionReason: "V2_FAST_TREND_SHIFT_UPPER_LONG_CONFIRMED",
            boxPos: 0.85,
            reversalConfirmed: false
        });

        assert.equal(ftsUpperLong.evaluated, false);
        assert.equal(ftsUpperLong.allowed, true);
        assert.equal(ftsUpperLong.classification, "ETH_RANGE_FULL");
        assert.equal(ftsUpperLong.probeMultiplier, 1.0);
    });

    // 12. Ambiguous location with reversalConfirmed=false is blocked
    it("CASE 12: Ambiguous location (0.28 L / 0.72 S) with reversalConfirmed=false is BLOCKED", () => {
        const longAmbiguousUnconfirmed = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "long",
            boxPos: 0.28,
            reversalConfirmed: false,
            trendSideCandidate: "long"
        });

        assert.equal(longAmbiguousUnconfirmed.evaluated, true);
        assert.equal(longAmbiguousUnconfirmed.allowed, false);
        assert.equal(longAmbiguousUnconfirmed.classification, "ETH_RANGE_BLOCK");
        assert.equal(longAmbiguousUnconfirmed.blockReason, "ETH_RANGE_REVERSAL_NOT_CONFIRMED");

        const shortAmbiguousUnconfirmed = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            side: "short",
            zone: "upper",
            rangeSideCandidate: "short",
            boxPos: 0.72,
            reversalConfirmed: false,
            trendSideCandidate: "short"
        });

        assert.equal(shortAmbiguousUnconfirmed.evaluated, true);
        assert.equal(shortAmbiguousUnconfirmed.allowed, false);
        assert.equal(shortAmbiguousUnconfirmed.classification, "ETH_RANGE_BLOCK");
        assert.equal(shortAmbiguousUnconfirmed.blockReason, "ETH_RANGE_REVERSAL_NOT_CONFIRMED");
    });

    // 13. Manual / Operator / Add-on bypass preservation
    it("CASE 13: Manual, operator-managed, and add-on entries are strictly bypassed", () => {
        const operatorRes = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            isOperatorManaged: true,
            boxPos: 0.28,
            reversalConfirmed: false
        });
        assert.equal(operatorRes.evaluated, false);
        assert.equal(operatorRes.allowed, true);

        const manualRes = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            isManualTakeover: true,
            boxPos: 0.28,
            reversalConfirmed: false
        });
        assert.equal(manualRes.evaluated, false);
        assert.equal(manualRes.allowed, true);

        const addonRes = evaluateEthRangeEntryQualityGate({
            ...baseInput,
            isAddon: true,
            boxPos: 0.28,
            reversalConfirmed: false
        });
        assert.equal(addonRes.evaluated, false);
        assert.equal(addonRes.allowed, true);
    });
});
