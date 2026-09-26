import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHighwayCoreEntryGate } from "../engine-v2/highway-core/highway-entry-gate";

const gateConfig = {
    paperTakerFeeRate: 0.0005,
    estimatedSlippagePct: 0.0003,
    highwayMinCostMultiplier: 2.0,
    highwayMinRewardRisk: 1.2,
    tickSz: 0.1
};

function goodPlan(side: "long" | "short", lastPrice: number) {
    if (side === "long") {
        return {
            stopPrice: lastPrice * 0.99,
            invalidationPx: lastPrice * 0.99,
            metadata: { tp1Price: lastPrice * 1.015 }
        };
    }
    return {
        stopPrice: lastPrice * 1.01,
        invalidationPx: lastPrice * 1.01,
        metadata: { tp1Price: lastPrice * 0.985 }
    };
}

test("HIGHWAY Step 2 TREND extreme chase: initial breakout exempt vs excessive chase", async (t) => {
    await t.test("R0: RANGE middle long still blocked at 0.35 (proof chase fields default)", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: {
                lastPrice: 3000,
                atr20: 30,
                boxPos: 0.5,
                boxHigh: 3060,
                boxLow: 2940
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "range_chase",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 2970,
                invalidationPx: 2970,
                metadata: { tp1Price: 3045 }
            },
            config: gateConfig
        });

        assert.equal(result.rejectReason, "RANGE_MIDDLE_CHASE_BLOCKED_LONG");
        assert.equal(result.proof.initial_breakout_exempt, false);
        assert.equal(result.proof.chase_risk_reason, null);
    });

    await t.test("R0b: RANGE edge long at boxPos 0.30 still allowed with good plan", () => {
        const lastPrice = 2982;
        const plan = goodPlan("long", lastPrice);
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: {
                lastPrice,
                atr20: 30,
                boxPos: 0.3,
                boxHigh: 3060,
                boxLow: 2940
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "range_lower_long",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                ...plan
            },
            config: gateConfig
        });

        assert.equal(result.allowed, true);
        assert.equal(result.rejectReason, null);
    });

    await t.test("T1: TREND initial breakout exempt (distanceOk + breakAuthority + structure)", () => {
        const boxLow = 990;
        const boxHigh = 1000;
        const lastPrice = 1001;
        const plan = goodPlan("long", lastPrice);
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice,
                closedClose: 1001,
                atr20: 5,
                boxPos: 1.0,
                boxHigh,
                boxLow,
                trendWeaknessScore: 0.4
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "trend_breakout",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                ...plan,
                metadata: { ...plan.metadata, retestConfirmed: true }
            },
            config: gateConfig,
            isPreCheck: true
        });

        assert.equal(result.rejectReason, null);
        assert.equal(result.proof.initial_breakout_exempt, true);
        assert.equal(result.proof.chase_risk_reason, null);
        assert.ok(Number(result.proof.breakout_distance_pct) <= Number(result.proof.chase_cap_pct) + 1e-9);
    });

    await t.test("T2: closed break with breakout distance above chase cap is blocked", () => {
        const boxLow = 990;
        const boxHigh = 1000;
        const lastPrice = 1020;
        const plan = goodPlan("long", lastPrice);
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice,
                closedClose: 1001,
                atr20: 5,
                boxPos: 1.0,
                boxHigh,
                boxLow,
                trendWeaknessScore: 0.2
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "trend_breakout",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                ...plan,
                metadata: { ...plan.metadata, retestConfirmed: true }
            },
            config: gateConfig,
            isPreCheck: true
        });

        assert.equal(result.rejectReason, "TREND_EXTREME_CHASE_BLOCKED_LONG");
        assert.equal(result.proof.initial_breakout_exempt, false);
        assert.equal(result.proof.chase_risk_reason, "BREAKOUT_DISTANCE_ABOVE_CHASE_CAP");
        assert.ok(Number(result.proof.breakout_distance_pct) > Number(result.proof.chase_cap_pct));
    });

    await t.test("T3: extreme boxPos 1.0, high weakness, no exempt → weakness chase block", () => {
        const boxLow = 990;
        const boxHigh = 1000;
        const lastPrice = 1000;
        const plan = goodPlan("long", lastPrice);
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice,
                closedClose: 999,
                atr20: 5,
                boxPos: 1.0,
                boxHigh,
                boxLow,
                trendWeaknessScore: 0.65
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "trend_chase",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                ...plan,
                metadata: { ...plan.metadata }
            },
            config: gateConfig,
            isPreCheck: true
        });

        assert.equal(result.rejectReason, "TREND_EXTREME_CHASE_BLOCKED_LONG");
        assert.equal(result.proof.initial_breakout_exempt, false);
        assert.equal(result.proof.chase_risk_reason, "TREND_WEAKNESS_HIGH_NO_EXEMPT");
    });

    await t.test("S1: SHORT initial breakout exempt (symmetric)", () => {
        const boxLow = 1000;
        const boxHigh = 1010;
        const lastPrice = 999;
        const plan = goodPlan("short", lastPrice);
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "short",
            regime: "TREND",
            snapshot: {
                lastPrice,
                closedClose: 999,
                atr20: 5,
                boxPos: 0.0,
                boxHigh,
                boxLow,
                trendWeaknessScore: 0.35
            },
            execution: {
                signal: "SHORT_CANDIDATE",
                side: "short",
                reason: "trend_breakdown",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                ...plan,
                metadata: { ...plan.metadata, retestConfirmed: true }
            },
            config: gateConfig,
            isPreCheck: true
        });

        assert.equal(result.rejectReason, null);
        assert.equal(result.proof.initial_breakout_exempt, true);
        assert.equal(result.proof.chase_risk_reason, null);
    });

    await t.test("S2: SHORT breakdown distance above chase cap blocked", () => {
        const boxLow = 1000;
        const boxHigh = 1010;
        const lastPrice = 980;
        const plan = goodPlan("short", lastPrice);
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "short",
            regime: "TREND",
            snapshot: {
                lastPrice,
                closedClose: 999,
                atr20: 5,
                boxPos: 0.0,
                boxHigh,
                boxLow,
                trendWeaknessScore: 0.2
            },
            execution: {
                signal: "SHORT_CANDIDATE",
                side: "short",
                reason: "trend_breakdown",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                ...plan,
                metadata: { ...plan.metadata, retestConfirmed: true }
            },
            config: gateConfig,
            isPreCheck: true
        });

        assert.equal(result.rejectReason, "TREND_EXTREME_CHASE_BLOCKED_SHORT");
        assert.equal(result.proof.chase_risk_reason, "BREAKOUT_DISTANCE_ABOVE_CHASE_CAP");
    });

    await t.test("S3: SHORT extreme low boxPos, high weakness, no exempt", () => {
        const boxLow = 1000;
        const boxHigh = 1010;
        const lastPrice = 1000;
        const plan = goodPlan("short", lastPrice);
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "short",
            regime: "TREND",
            snapshot: {
                lastPrice,
                closedClose: 1001,
                atr20: 5,
                boxPos: 0.0,
                boxHigh,
                boxLow,
                trendWeaknessScore: 0.7
            },
            execution: {
                signal: "SHORT_CANDIDATE",
                side: "short",
                reason: "trend_chase",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                ...plan,
                metadata: { ...plan.metadata }
            },
            config: gateConfig,
            isPreCheck: true
        });

        assert.equal(result.rejectReason, "TREND_EXTREME_CHASE_BLOCKED_SHORT");
        assert.equal(result.proof.chase_risk_reason, "TREND_WEAKNESS_HIGH_NO_EXEMPT");
    });

    await t.test("T4: boxPos 1.0, low weakness, capped breakout + structure exempt (not tw chase)", () => {
        const boxLow = 64990;
        const boxHigh = 65100;
        const lastPrice = 65101;
        const plan = goodPlan("long", lastPrice);
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice,
                closedClose: 65101,
                atr20: 300,
                boxPos: 1.0,
                boxHigh,
                boxLow,
                trendWeaknessScore: 0.35
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "trend_breakout",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                ...plan,
                metadata: { ...plan.metadata, pullbackConfirmed: true }
            },
            config: gateConfig,
            isPreCheck: true
        });

        assert.equal(result.rejectReason, null);
        assert.equal(result.proof.initial_breakout_exempt, true);
        assert.ok(Number(result.proof.raw_box_pos) <= 1.05);
        assert.ok(Number(result.proof.breakout_distance_pct) <= Number(result.proof.chase_cap_pct) + 1e-9);
    });

    await t.test("T6: rawBoxPos overextension blocked without exempt", () => {
        const boxLow = 990;
        const boxHigh = 1000;
        const lastPrice = 1000.6;
        const plan = goodPlan("long", lastPrice);
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice,
                closedClose: 999.5,
                atr20: 5,
                boxPos: 1.0,
                boxHigh,
                boxLow,
                trendWeaknessScore: 0.25
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "trend_chase",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                ...plan,
                metadata: { ...plan.metadata }
            },
            config: gateConfig,
            isPreCheck: true
        });

        assert.ok(Number(result.proof.raw_box_pos) > 1.05);
        assert.equal(result.rejectReason, "TREND_EXTREME_CHASE_BLOCKED_LONG");
        assert.equal(result.proof.chase_risk_reason, "RAW_BOX_OVEREXTENSION");
    });

    await t.test("S6: SHORT rawBoxPos overextension (symmetric)", () => {
        const boxLow = 1000;
        const boxHigh = 1010;
        const lastPrice = 999.4;
        const plan = goodPlan("short", lastPrice);
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "short",
            regime: "TREND",
            snapshot: {
                lastPrice,
                closedClose: 1000.5,
                atr20: 5,
                boxPos: 0.0,
                boxHigh,
                boxLow,
                trendWeaknessScore: 0.25
            },
            execution: {
                signal: "SHORT_CANDIDATE",
                side: "short",
                reason: "trend_chase",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                ...plan,
                metadata: { ...plan.metadata }
            },
            config: gateConfig,
            isPreCheck: true
        });

        assert.ok(Number(result.proof.raw_box_pos) < -0.05);
        assert.equal(result.rejectReason, "TREND_EXTREME_CHASE_BLOCKED_SHORT");
        assert.equal(result.proof.chase_risk_reason, "RAW_BOX_OVEREXTENSION");
    });
});
