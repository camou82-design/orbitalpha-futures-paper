import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateEthRangeEntryFeasibilityGate,
    type EthRangeEntryFeasibilityInput
} from "../engine-v2/execution/eth-range-entry-feasibility-gate";
import { evaluateEthRangeDynamicTpAuthority } from "../engine-v2/execution/eth-range-dynamic-tp-authority";

describe("V2 ETH RANGE Entry Feasibility Gate Test Suite", () => {
    // Standard test fixtures
    const baseInput: EthRangeEntryFeasibilityInput = {
        symbol: "ETHUSDT",
        side: "long",
        regime: "RANGE",
        marketSubtype: "RANGE_BOUND",
        entryPrice: 2500.0,
        boxHigh: 2520.0,
        boxLow: 2500.0,
        boxMid: 2510.0, // gross edge: (2510 - 2500) / 2500 = +0.40% > 0.195% floor
        atr: 10.0,
        feeRate: 0.0005,
        paperSlippageEstimateBps: 8,
        tickSz: 0.01,
        emitProof: false
    };

    // 1. Positive Control: LONG Feasibility Pass
    it("CASE 1: ETH RANGE LONG with valid directional boxMid passes feasibility gate", () => {
        const res = evaluateEthRangeEntryFeasibilityGate(baseInput);

        assert.equal(res.entryAllowed, true);
        assert.equal(res.blocked, false);
        assert.equal(res.blockReason, null);
        assert.equal(res.directional_space_valid, true);
        assert.equal(res.box_width_sufficient, true);
        assert.equal(res.profitability_passed, true);
        assert.equal(res.structural_target, 2510.0);
        assert.equal(res.gross_structural_edge_pct, 0.004);
        assert.ok(res.profitability_floor_pct > 0.0019);
    });

    // 2. Positive Control: SHORT Feasibility Pass
    it("CASE 2: ETH RANGE SHORT with valid directional boxMid passes feasibility gate", () => {
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            side: "short",
            entryPrice: 2520.0,
            boxHigh: 2520.0,
            boxLow: 2500.0,
            boxMid: 2510.0 // gross edge: (2520 - 2510) / 2520 = 0.397% > 0.195% floor
        });

        assert.equal(res.entryAllowed, true);
        assert.equal(res.blocked, false);
        assert.equal(res.blockReason, null);
        assert.equal(res.directional_space_valid, true);
        assert.equal(res.box_width_sufficient, true);
        assert.equal(res.profitability_passed, true);
        assert.equal(res.structural_target, 2510.0);
    });

    // 3. Wrong-side boxMid: LONG
    it("CASE 3A: ETH RANGE LONG with boxMid <= entryPrice is blocked with ETH_RANGE_ENTRY_NO_DIRECTIONAL_PROFIT_SPACE", () => {
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            side: "long",
            entryPrice: 2515.0,
            boxMid: 2510.0 // boxMid is below entry for LONG (wrong side!)
        });

        assert.equal(res.entryAllowed, false);
        assert.equal(res.blocked, true);
        assert.equal(res.blockReason, "ETH_RANGE_ENTRY_NO_DIRECTIONAL_PROFIT_SPACE");
        assert.equal(res.directional_space_valid, false);
        assert.equal(res.profitability_passed, false);
    });

    // 4. Wrong-side boxMid: SHORT
    it("CASE 3B: ETH RANGE SHORT with boxMid >= entryPrice is blocked with ETH_RANGE_ENTRY_NO_DIRECTIONAL_PROFIT_SPACE", () => {
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            side: "short",
            entryPrice: 2505.0,
            boxMid: 2510.0 // boxMid is above entry for SHORT (wrong side!)
        });

        assert.equal(res.entryAllowed, false);
        assert.equal(res.blocked, true);
        assert.equal(res.blockReason, "ETH_RANGE_ENTRY_NO_DIRECTIONAL_PROFIT_SPACE");
        assert.equal(res.directional_space_valid, false);
        assert.equal(res.profitability_passed, false);
    });

    // 5. Tiny Box: Box too narrow to cover round-trip execution cost + required net edge
    it("CASE 4: ETH RANGE with entire box width < profitability floor is blocked with ETH_RANGE_BOX_TOO_NARROW_TO_TRADE", () => {
        // Floor is 0.195% (19.5 bps). For entryPrice 2500, required width is > 4.875 USD.
        // If boxHigh = 2503, boxLow = 2500 -> total width = 3.0 USD (0.12% < 0.195%)
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            entryPrice: 2500.0,
            boxHigh: 2503.0,
            boxLow: 2500.0,
            boxMid: 2501.5
        });

        assert.equal(res.entryAllowed, false);
        assert.equal(res.blocked, true);
        assert.equal(res.blockReason, "ETH_RANGE_BOX_TOO_NARROW_TO_TRADE");
        assert.equal(res.box_width_sufficient, false);
        assert.equal(res.directional_space_valid, false);
        assert.equal(res.profitability_passed, false);
    });

    // 6. Insufficient Edge: Box is wide enough, but entry is too close to boxMid
    it("CASE 5: ETH RANGE with gross edge to boxMid < floor is blocked with ETH_RANGE_ENTRY_INSUFFICIENT_PROFIT_SPACE", () => {
        // Box is wide (2500 - 2550 = 50 USD = 2.0%), but entry is 2523.5 and boxMid is 2525.0
        // gross edge = 1.5 USD / 2523.5 = 0.059% < 0.195% floor
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            side: "long",
            entryPrice: 2523.5,
            boxHigh: 2550.0,
            boxLow: 2500.0,
            boxMid: 2525.0
        });

        assert.equal(res.entryAllowed, false);
        assert.equal(res.blocked, true);
        assert.equal(res.blockReason, "ETH_RANGE_ENTRY_INSUFFICIENT_PROFIT_SPACE");
        assert.equal(res.directional_space_valid, true);
        assert.equal(res.box_width_sufficient, true);
        assert.equal(res.profitability_passed, false);
    });

    // 7. BTCUSDT Complete Non-applicability
    it("CASE 6: BTCUSDT is strictly bypassed and never blocked by ETH range gate", () => {
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            symbol: "BTCUSDT",
            entryPrice: 95000.0,
            boxHigh: 95002.0, // tiny box
            boxLow: 95000.0,
            boxMid: 94990.0  // wrong side
        });

        assert.equal(res.entryAllowed, true);
        assert.equal(res.blocked, false);
        assert.equal(res.blockReason, null);
    });

    // 8. TREND Regime Unchanged
    it("CASE 7A: TREND regime is strictly bypassed", () => {
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            regime: "TREND",
            boxMid: 2490.0 // wrong side if it were range
        });

        assert.equal(res.entryAllowed, true);
        assert.equal(res.blocked, false);
        assert.equal(res.blockReason, null);
    });

    // 9. BREAKOUT / SHOCK Subtypes Unchanged
    it("CASE 7B: Breakout continuation subtypes are strictly bypassed", () => {
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            marketSubtype: "BREAKOUT_RETEST_CONFIRMED"
        });

        assert.equal(res.entryAllowed, true);
        assert.equal(res.blocked, false);
    });

    it("CASE 7C: FAST_TREND_SHIFT and SHOCK subtypes are strictly bypassed", () => {
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            marketSubtype: "FAST_TREND_SHIFT"
        });

        assert.equal(res.entryAllowed, true);
        assert.equal(res.blocked, false);
    });

    // 10. Operational Immunity: OPERATOR_MANAGED / Manual Bypass
    it("CASE 8: OPERATOR_MANAGED or manual takeover strictly bypasses gate", () => {
        const resOperator = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            lifecycleState: "OPERATOR_MANAGED",
            boxMid: 2490.0 // wrong side
        });
        assert.equal(resOperator.entryAllowed, true);
        assert.equal(resOperator.blocked, false);

        const resManual = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            manualTakeoverActive: true,
            boxMid: 2490.0
        });
        assert.equal(resManual.entryAllowed, true);
        assert.equal(resManual.blocked, false);
    });

    // 11. Add-on Bypass
    it("CASE 9: Add-on candidate is strictly bypassed and never blocked by range gate", () => {
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            isAddon: true,
            boxMid: 2490.0 // wrong side
        });

        assert.equal(res.entryAllowed, true);
        assert.equal(res.blocked, false);
        assert.equal(res.blockReason, null);
    });

    // 12. Proof Log Structure Verification
    it("CASE 10: V2_ETH_RANGE_ENTRY_FEASIBILITY_PROOF contains all required audit fields", () => {
        const logs: any[] = [];
        const originalInfo = console.info;
        console.info = (msg: string) => {
            try {
                const parsed = JSON.parse(msg);
                if (parsed.event === "V2_ETH_RANGE_ENTRY_FEASIBILITY_PROOF") {
                    logs.push(parsed);
                }
            } catch {
                // ignore
            }
        };

        try {
            evaluateEthRangeEntryFeasibilityGate({
                ...baseInput,
                emitProof: true
            });

            assert.equal(logs.length, 1);
            const proof = logs[0];
            const requiredFields = [
                "symbol",
                "side",
                "regime",
                "subtype",
                "entry_price",
                "box_high",
                "box_low",
                "box_mid",
                "box_width_pct",
                "structural_target",
                "structural_target_source",
                "gross_structural_edge_pct",
                "profitability_floor_pct",
                "fee_component_pct",
                "slippage_component_pct",
                "required_net_edge_pct",
                "directional_space_valid",
                "box_width_sufficient",
                "profitability_passed",
                "blocked",
                "block_reason"
            ];

            for (const field of requiredFields) {
                assert.ok(field in proof, `Field '${field}' must be present in proof log`);
            }
            assert.equal(proof.symbol, "ETHUSDT");
            assert.equal(proof.side, "long");
            assert.equal(proof.blocked, false);
            assert.equal(proof.structural_target_source, "box_mid");
        } finally {
            console.info = originalInfo;
        }
    });

    // 13. Dynamic TP Authority Sequence Invariant
    it("CASE 11: Feasibility PASS enables Dynamic TP; Feasibility BLOCK prevents candidate from proceeding", () => {
        // Condition A: Feasible candidate -> Passes Gate -> Dynamic TP executes
        const passGate = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            entryPrice: 2500.0,
            boxMid: 2510.0
        });
        assert.equal(passGate.entryAllowed, true);

        const dynamicTp = evaluateEthRangeDynamicTpAuthority({
            symbol: "ETHUSDT",
            side: "long",
            entryPrice: 2500.0,
            regime: "RANGE",
            boxHigh: 2520.0,
            boxLow: 2500.0,
            boxMid: 2510.0,
            atr: 10.0,
            previousCanonicalTp: 2525.0
        });
        assert.equal(dynamicTp.dynamicTpApplied, true);
        assert.equal(dynamicTp.finalTp, 2510.0);

        // Condition B: Infeasible candidate -> Blocked at Feasibility Gate
        const blockGate = evaluateEthRangeEntryFeasibilityGate({
            ...baseInput,
            entryPrice: 2509.0, // too close to boxMid (2510.0) -> edge 0.039% < 0.195%
            boxMid: 2510.0
        });
        assert.equal(blockGate.entryAllowed, false);
        assert.equal(blockGate.blocked, true);
        assert.equal(blockGate.blockReason, "ETH_RANGE_ENTRY_INSUFFICIENT_PROFIT_SPACE");
    });
});
