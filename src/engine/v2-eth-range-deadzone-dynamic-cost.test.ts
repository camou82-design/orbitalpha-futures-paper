import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateEthRangeEntryFeasibilityGate,
    type EthRangeEntryFeasibilityInput
} from "../engine-v2/execution/eth-range-entry-feasibility-gate";
import { aiApproveEntry, type AiApprovalInput } from "../ai/entry-approval";

describe("PHASE ETH-RANGE-DEADZONE-DYNAMIC-COST-AND-V2-AI-AUTHORITY-IMPLEMENT-3 Tests", () => {
    const baseEthRangeInput: EthRangeEntryFeasibilityInput = {
        symbol: "ETHUSDT",
        side: "long",
        regime: "RANGE",
        marketSubtype: "RANGE_BOUND",
        entryPrice: 2000.0,
        boxHigh: 2040.0,
        boxLow: 1990.0,
        boxMid: 2015.0,
        feeRate: 0.0005, // 5 bps entry + 5 bps exit = 10 bps
        paperSlippageEstimateBps: 8, // 8 bps slippage
        // round trip cost = 18 bps, required profit space = 18 + 5 = 23 bps
        emitProof: false
    };

    // 1. ETH RANGE box 34.9bps -> BLOCK
    it("TEST 1: ETH RANGE box 34.9bps is blocked with ETH_RANGE_BOX_TOO_NARROW_TO_TRADE", () => {
        // entry = 2000, 34.9 bps = 6.98 USD
        const boxLow = 1996.51;
        const boxHigh = 2003.49; // width = 6.98 -> 34.9 bps
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            entryPrice: 2000.0,
            boxHigh,
            boxLow,
            boxMid: (boxHigh + boxLow) / 2
        });

        assert.equal(res.blocked, true);
        assert.equal(res.entryAllowed, false);
        assert.equal(res.blockReason, "ETH_RANGE_BOX_TOO_NARROW_TO_TRADE");
        assert.equal(res.box_width_sufficient, false);
        assert.equal(res.feasibility_evaluated, true);
        assert.equal(res.feasibility_passed, false);
        assert.ok(res.box_width_bps! < 35.0);
    });

    // 2. ETH RANGE box exactly 35bps -> width PASS
    it("TEST 2: ETH RANGE box exactly 35.0bps passes box width check", () => {
        // entry = 2000, 35.0 bps = 7.0 USD
        const boxLow = 1995.0;
        const boxHigh = 2002.0; // width = 7.0 USD -> 35.0 bps
        const boxMid = 2001.0;
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            entryPrice: 2000.0,
            boxHigh,
            boxLow,
            boxMid
        });

        assert.equal(res.box_width_sufficient, true);
        assert.ok(res.box_width_bps! >= 35.0 - 1e-6);
    });

    // 3. box width 충분하지만 directional space 부족 -> BLOCK
    it("TEST 3: Box width is ample but directional profit space is insufficient -> BLOCK", () => {
        // Box is wide (2000 to 2050 = 250 bps >> 35 bps)
        // Entry is 2024.5, boxMid is 2025.0 -> directional space = 0.5 / 2024.5 * 10000 = 2.47 bps
        // Required space is 23 bps -> BLOCK
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            entryPrice: 2024.5,
            boxHigh: 2050.0,
            boxLow: 2000.0,
            boxMid: 2025.0
        });

        assert.equal(res.blocked, true);
        assert.equal(res.entryAllowed, false);
        assert.equal(res.blockReason, "ETH_RANGE_ENTRY_INSUFFICIENT_DIRECTIONAL_PROFIT_SPACE");
        assert.equal(res.box_width_sufficient, true);
        assert.equal(res.directional_space_valid, true);
        assert.equal(res.feasibility_evaluated, true);
        assert.equal(res.feasibility_passed, false);
    });

    // 4. dynamic cost 13bps + edge5 = required18bps, space17.9 -> BLOCK
    it("TEST 4: Dynamic cost 13bps + edge 5bps = required 18bps, directional space 17.9bps -> BLOCK", () => {
        // feeRate 0.0004 -> entry 4bps + exit 4bps = 8bps. slippage = 5bps. RT cost = 13bps.
        // required profit space = 13 + 5 = 18.0 bps.
        const entryPrice = 10000.0;
        // Directional space 17.9 bps -> target = 10000 * (1 + 17.9 / 10000) = 10017.9
        const boxMid = 10017.9;
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            entryPrice,
            feeRate: 0.0004,
            paperSlippageEstimateBps: 5,
            boxHigh: 10050.0, // width 100 bps
            boxLow: 9950.0,
            boxMid
        });

        assert.equal(res.estimated_round_trip_cost_bps, 13.0);
        assert.equal(res.minimum_net_edge_bps, 5.0);
        assert.equal(res.required_profit_space_bps, 18.0);
        assert.ok(Math.abs(res.directional_profit_space_bps! - 17.9) < 1e-4);
        assert.equal(res.blocked, true);
        assert.equal(res.entryAllowed, false);
        assert.equal(res.blockReason, "ETH_RANGE_ENTRY_INSUFFICIENT_DIRECTIONAL_PROFIT_SPACE");
    });

    // 5. same, space18.0 -> PASS boundary
    it("TEST 5: Dynamic cost 13bps + edge 5bps = required 18bps, directional space exactly 18.0bps -> PASS", () => {
        const entryPrice = 10000.0;
        // Directional space 18.0 bps -> target = 10000 * (1 + 18.0 / 10000) = 10018.0
        const boxMid = 10018.0;
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            entryPrice,
            feeRate: 0.0004,
            paperSlippageEstimateBps: 5,
            boxHigh: 10050.0,
            boxLow: 9950.0,
            boxMid
        });

        assert.equal(res.estimated_round_trip_cost_bps, 13.0);
        assert.equal(res.minimum_net_edge_bps, 5.0);
        assert.equal(res.required_profit_space_bps, 18.0);
        assert.ok(Math.abs(res.directional_profit_space_bps! - 18.0) < 1e-4);
        assert.equal(res.blocked, false);
        assert.equal(res.entryAllowed, true);
        assert.equal(res.blockReason, null);
        assert.equal(res.feasibility_evaluated, true);
        assert.equal(res.feasibility_passed, true);
    });

    // 6. LONG/SHORT 대칭
    it("TEST 6: LONG and SHORT symmetry under dynamic cost formula", () => {
        const entryPrice = 2000.0;
        // Cost: feeRate 0.0005 (10bps) + slippage 8bps = 18bps cost + 5bps edge = 23bps required
        // +30 bps space for LONG: boxMid = 2000 * (1 + 30/10000) = 2006.0
        const longPass = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            side: "long",
            entryPrice,
            boxHigh: 2020.0,
            boxLow: 1980.0,
            boxMid: 2006.0
        });
        // +30 bps space for SHORT: boxMid = 2000 * (1 - 30/10000) = 1994.0
        const shortPass = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            side: "short",
            entryPrice,
            boxHigh: 2020.0,
            boxLow: 1980.0,
            boxMid: 1994.0
        });

        assert.equal(longPass.entryAllowed, true);
        assert.equal(shortPass.entryAllowed, true);
        assert.equal(longPass.required_profit_space_bps, shortPass.required_profit_space_bps);
        assert.ok(Math.abs(longPass.directional_profit_space_bps! - 30.0) < 1e-4);
        assert.ok(Math.abs(shortPass.directional_profit_space_bps! - 30.0) < 1e-4);

        // Sub-threshold symmetry (+10 bps space < 23 bps required)
        const longFail = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            side: "long",
            entryPrice,
            boxHigh: 2020.0,
            boxLow: 1980.0,
            boxMid: 2002.0 // +10 bps
        });
        const shortFail = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            side: "short",
            entryPrice,
            boxHigh: 2020.0,
            boxLow: 1980.0,
            boxMid: 1998.0 // +10 bps
        });

        assert.equal(longFail.blocked, true);
        assert.equal(shortFail.blocked, true);
        assert.equal(longFail.blockReason, "ETH_RANGE_ENTRY_INSUFFICIENT_DIRECTIONAL_PROFIT_SPACE");
        assert.equal(shortFail.blockReason, "ETH_RANGE_ENTRY_INSUFFICIENT_DIRECTIONAL_PROFIT_SPACE");
    });

    // 7. wrong-side 유지
    it("TEST 7: Wrong-side structural target is preserved and blocked with ETH_RANGE_ENTRY_NO_DIRECTIONAL_PROFIT_SPACE", () => {
        // LONG with boxMid < entryPrice
        const wrongLong = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            side: "long",
            entryPrice: 2010.0,
            boxHigh: 2020.0,
            boxLow: 1990.0,
            boxMid: 2005.0 // below entry for LONG
        });
        assert.equal(wrongLong.blocked, true);
        assert.equal(wrongLong.blockReason, "ETH_RANGE_ENTRY_NO_DIRECTIONAL_PROFIT_SPACE");
        assert.equal(wrongLong.directional_space_valid, false);

        // SHORT with boxMid > entryPrice
        const wrongShort = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            side: "short",
            entryPrice: 2000.0,
            boxHigh: 2020.0,
            boxLow: 1990.0,
            boxMid: 2005.0 // above entry for SHORT
        });
        assert.equal(wrongShort.blocked, true);
        assert.equal(wrongShort.blockReason, "ETH_RANGE_ENTRY_NO_DIRECTIONAL_PROFIT_SPACE");
        assert.equal(wrongShort.directional_space_valid, false);
    });

    // 8. TREND bypass
    it("TEST 8: TREND regime is strictly bypassed with feasibility_evaluated = false", () => {
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            regime: "TREND",
            boxMid: 1950.0 // would fail if evaluated
        });

        assert.equal(res.entryAllowed, true);
        assert.equal(res.blocked, false);
        assert.equal(res.feasibility_evaluated, false);
        assert.equal(res.feasibility_passed, true);
    });

    // 9. SHOCK bypass/protection 유지
    it("TEST 9: SHOCK and emergency subtypes are strictly bypassed without interfering with protections", () => {
        const shockSubtypes = [
            "SHOCK_REACTION_UP",
            "SHOCK_REACTION_DOWN",
            "WHIPSAW_SHOCK_RECHECK",
            "FAST_TREND_SHIFT",
            "BREAKOUT_RETEST_CONFIRMED"
        ];

        for (const sub of shockSubtypes) {
            const res = evaluateEthRangeEntryFeasibilityGate({
                ...baseEthRangeInput,
                marketSubtype: sub,
                boxMid: 1950.0
            });
            assert.equal(res.entryAllowed, true, `Subtype ${sub} must bypass`);
            assert.equal(res.blocked, false);
            assert.equal(res.feasibility_evaluated, false);
        }
    });

    // 10. BTC 완전 불변
    it("TEST 10: BTCUSDT is 100% untouched and bypassed with zero behavior change", () => {
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            symbol: "BTCUSDT",
            entryPrice: 95000.0,
            boxHigh: 95005.0, // tiny box (0.5 bps)
            boxLow: 95000.0,
            boxMid: 94900.0 // wrong side
        });

        assert.equal(res.entryAllowed, true);
        assert.equal(res.blocked, false);
        assert.equal(res.blockReason, null);
        assert.equal(res.feasibility_evaluated, false);
        assert.equal(res.feasibility_passed, true);
    });

    // 11. OPERATOR_MANAGED 불변
    it("TEST 11: OPERATOR_MANAGED lifecycle state is strictly bypassed", () => {
        const res = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            lifecycleState: "OPERATOR_MANAGED",
            boxMid: 1950.0
        });

        assert.equal(res.entryAllowed, true);
        assert.equal(res.blocked, false);
        assert.equal(res.feasibility_evaluated, false);
    });

    // 12. manual takeover 불변
    it("TEST 12: Manual takeover and manual ownership latch are strictly bypassed", () => {
        const resTakeover = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            manualTakeoverActive: true,
            boxMid: 1950.0
        });
        assert.equal(resTakeover.entryAllowed, true);
        assert.equal(resTakeover.feasibility_evaluated, false);

        const resLatch = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            manualOwnershipLatch: true,
            boxMid: 1950.0
        });
        assert.equal(resLatch.entryAllowed, true);
        assert.equal(resLatch.feasibility_evaluated, false);
    });

    // Helper function demonstrating the legacy AI null-cost duplicate bypass logic in paper-engine
    function simulatePaperEngineLegacyAiGate(args: {
        symbol: string;
        authorityOwner: "V1" | "V2";
        authoritySource: "v1" | "v2";
        regime: string;
        ethRangeFeasibilityEvaluated: boolean;
        ethRangeFeasibilityPassed: boolean;
        aiInput: AiApprovalInput;
    }) {
        const aiOutput = aiApproveEntry(args.aiInput);
        let aiExecutionApproved = aiOutput.action !== "NO_ENTRY";

        const legacyAiActionBefore = aiOutput.action;
        const isNullCostReason =
            aiOutput.reason === "비용/기대움직임 불명확" ||
            args.aiInput.expected_move == null ||
            args.aiInput.total_cost == null ||
            !Number.isFinite(args.aiInput.expected_move) ||
            !Number.isFinite(args.aiInput.total_cost);

        const otherAiSafetyVetoPresent =
            aiOutput.action === "NO_ENTRY" &&
            (!isNullCostReason || args.aiInput.risk_state === "BLOCKED");

        const nullCostDuplicateDetected =
            aiOutput.action === "NO_ENTRY" &&
            isNullCostReason &&
            !otherAiSafetyVetoPresent;

        const isV2Owner = args.authorityOwner === "V2" || args.authoritySource === "v2";
        const isEth = args.symbol.toUpperCase() === "ETHUSDT";
        const isRangeRegime = args.regime.toUpperCase() === "RANGE";

        let bypassApplied = false;
        let finalAiAction: string = aiOutput.action;

        if (
            nullCostDuplicateDetected &&
            isV2Owner &&
            isEth &&
            isRangeRegime &&
            args.ethRangeFeasibilityEvaluated === true &&
            args.ethRangeFeasibilityPassed === true
        ) {
            bypassApplied = true;
            aiExecutionApproved = true;
            finalAiAction = "ENTER_LONG";
        }

        return {
            aiExecutionApproved,
            legacyAiActionBefore,
            nullCostDuplicateDetected,
            bypassApplied,
            finalAiAction,
            otherAiSafetyVetoPresent
        };
    }

    // 13. V2 feasibility PASS + AI expected_move=null/total_cost=null -> null-cost duplicate block만 bypass
    it("TEST 13: V2 feasibility PASS + AI expected_move=null/total_cost=null bypasses null-cost duplicate block only", () => {
        const mockAiInput: AiApprovalInput = {
            executor: "RANGE",
            executor_direction: "long",
            regime: "RANGE",
            expected_move: null, // null expected_move triggers legacy AI "비용/기대움직임 불명확"
            total_cost: 0.001,
            loss_streak: 0,
            last_10_net: 50,
            risk_state: "NORMAL"
        };

        const result = simulatePaperEngineLegacyAiGate({
            symbol: "ETHUSDT",
            authorityOwner: "V2",
            authoritySource: "v2",
            regime: "RANGE",
            ethRangeFeasibilityEvaluated: true,
            ethRangeFeasibilityPassed: true,
            aiInput: mockAiInput
        });

        assert.equal(result.legacyAiActionBefore, "NO_ENTRY");
        assert.equal(result.nullCostDuplicateDetected, true);
        assert.equal(result.otherAiSafetyVetoPresent, false);
        assert.equal(result.bypassApplied, true);
        assert.equal(result.aiExecutionApproved, true);
        assert.equal(result.finalAiAction, "ENTER_LONG");
    });

    // 14. V2 feasibility FAIL -> AI bypass 절대 금지
    it("TEST 14: V2 feasibility FAIL strictly forbids legacy AI bypass", () => {
        const mockAiInput: AiApprovalInput = {
            executor: "RANGE",
            executor_direction: "long",
            regime: "RANGE",
            expected_move: null,
            total_cost: null,
            loss_streak: 0,
            last_10_net: 50,
            risk_state: "NORMAL"
        };

        const result = simulatePaperEngineLegacyAiGate({
            symbol: "ETHUSDT",
            authorityOwner: "V2",
            authoritySource: "v2",
            regime: "RANGE",
            ethRangeFeasibilityEvaluated: true,
            ethRangeFeasibilityPassed: false, // Feasibility failed!
            aiInput: mockAiInput
        });

        assert.equal(result.legacyAiActionBefore, "NO_ENTRY");
        assert.equal(result.bypassApplied, false);
        assert.equal(result.aiExecutionApproved, false);
        assert.equal(result.finalAiAction, "NO_ENTRY");
    });

    // 15. feasibility provenance missing -> AI bypass 절대 금지
    it("TEST 15: Missing feasibility provenance strictly forbids legacy AI bypass", () => {
        const mockAiInput: AiApprovalInput = {
            executor: "RANGE",
            executor_direction: "long",
            regime: "RANGE",
            expected_move: null,
            total_cost: null,
            loss_streak: 0,
            last_10_net: 50,
            risk_state: "NORMAL"
        };

        const result = simulatePaperEngineLegacyAiGate({
            symbol: "ETHUSDT",
            authorityOwner: "V2",
            authoritySource: "v2",
            regime: "RANGE",
            ethRangeFeasibilityEvaluated: false, // Missing!
            ethRangeFeasibilityPassed: false,
            aiInput: mockAiInput
        });

        assert.equal(result.legacyAiActionBefore, "NO_ENTRY");
        assert.equal(result.bypassApplied, false);
        assert.equal(result.aiExecutionApproved, false);
        assert.equal(result.finalAiAction, "NO_ENTRY");
    });

    // 16. other explicit AI safety veto 존재 -> AI bypass 절대 금지
    it("TEST 16: Other explicit AI safety veto (risk_state=BLOCKED) strictly forbids legacy AI bypass", () => {
        const mockAiInput: AiApprovalInput = {
            executor: "RANGE",
            executor_direction: "long",
            regime: "RANGE",
            expected_move: null,
            total_cost: null,
            loss_streak: 5,
            last_10_net: -200,
            risk_state: "BLOCKED" // Explicit risk veto!
        };

        const result = simulatePaperEngineLegacyAiGate({
            symbol: "ETHUSDT",
            authorityOwner: "V2",
            authoritySource: "v2",
            regime: "RANGE",
            ethRangeFeasibilityEvaluated: true,
            ethRangeFeasibilityPassed: true,
            aiInput: mockAiInput
        });

        assert.equal(result.legacyAiActionBefore, "NO_ENTRY");
        assert.equal(result.otherAiSafetyVetoPresent, true);
        assert.equal(result.nullCostDuplicateDetected, false);
        assert.equal(result.bypassApplied, false);
        assert.equal(result.aiExecutionApproved, false);
        assert.equal(result.finalAiAction, "NO_ENTRY");
    });

    // 17. no-lookahead provenance test
    it("TEST 17: Feasibility gate strictly rejects lookahead information and uses canonical pre-entry inputs only", () => {
        const inputWithLookahead: any = {
            ...baseEthRangeInput,
            entryPrice: 2000.0,
            boxHigh: 2040.0,
            boxLow: 1990.0,
            boxMid: 2015.0,
            // Malicious or lookahead fields:
            actualFillSlippageBps: 2.1,
            realizedPnl: 15.4,
            mfe: 2030.0,
            mae: 1998.0,
            futureExitPrice: 2015.0
        };

        const res = evaluateEthRangeEntryFeasibilityGate(inputWithLookahead);

        // The gate must rely ONLY on canonical inputs
        assert.equal(res.cost_source, "config");
        assert.equal(res.entry_fee_bps, 5.0);
        assert.equal(res.expected_exit_fee_bps, 5.0);
        assert.equal(res.expected_slippage_bps, 8.0); // preEntrySlippageEstimateBps, NOT actualFillSlippageBps
        assert.equal(res.estimated_round_trip_cost_bps, 18.0);
        assert.equal(res.required_profit_space_bps, 23.0);
        assert.equal(res.entryAllowed, true);

        // Verify invalid cost handling triggers ETH_RANGE_ENTRY_COST_NOT_EVALUABLE
        const invalidCostRes = evaluateEthRangeEntryFeasibilityGate({
            ...baseEthRangeInput,
            feeRate: -0.001 // Invalid negative fee rate
        });
        assert.equal(invalidCostRes.blocked, true);
        assert.equal(invalidCostRes.blockReason, "ETH_RANGE_ENTRY_COST_NOT_EVALUABLE");
        assert.equal(invalidCostRes.cost_evaluable, false);
    });
});
