import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveFinalRegimeExecutionAuthority } from "../engine-v2/execution/entry-final-regime-authority";

describe("V2 entry final regime execution authority", () => {
    it("keeps RANGE→TREND promotion applicable when canonical and final are RANGE", () => {
        const auth = resolveFinalRegimeExecutionAuthority({
            canonicalRegime: "RANGE",
            regimeFinal: "RANGE",
            regime: "RANGE",
            routerExecutor: "RANGE"
        });
        assert.equal(auth.range_to_trend_promotion_applicable, true);
        assert.equal(auth.promotion_gate_applicable, true);
        assert.equal(auth.promotion_gate_bypass_reason, null);
        assert.equal(auth.market_mode, "RANGE");
    });

    it("bypasses RANGE→TREND promotion when regime_final and router are TREND", () => {
        const auth = resolveFinalRegimeExecutionAuthority({
            canonicalRegime: "RANGE",
            regimeFinal: "TREND",
            regime: "RANGE",
            routerExecutor: "TREND"
        });
        assert.equal(auth.has_final_trend_execution_authority, true);
        assert.equal(auth.range_to_trend_promotion_applicable, false);
        assert.equal(auth.promotion_gate_applicable, false);
        assert.equal(auth.promotion_gate_bypass_reason, "FINAL_TREND_ROUTING_AUTHORITY");
        assert.equal(auth.market_mode, "TREND");
    });

    it("does not bypass when router is TREND but regime_final remains RANGE", () => {
        const auth = resolveFinalRegimeExecutionAuthority({
            canonicalRegime: "RANGE",
            regimeFinal: "RANGE",
            regime: "RANGE",
            routerExecutor: "TREND"
        });
        assert.equal(auth.has_final_trend_execution_authority, false);
        assert.equal(auth.range_to_trend_promotion_applicable, true);
    });
});
