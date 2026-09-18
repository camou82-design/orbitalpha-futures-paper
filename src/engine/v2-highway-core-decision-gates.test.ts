import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHighwayCoreEntryGate } from "../engine-v2/highway-core/highway-entry-gate";
import {
    applySoftExitHysteresis,
    isSoftExitCooldownActive,
    clearSoftExitState,
    isHardExitReason,
    isSoftExitReason
} from "../engine-v2/exit/soft-exit-hysteresis";
import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import type { EvaluateV2ExitPolicyArgs } from "../engine-v2/exit/types";
import type { V2StateAuthority } from "../engine-v2/state/types";
import type { MarketJudgmentOutput } from "../engine-v2/types";

test("HIGHWAY CORE: Decision Order & Entry Quality Gates", async (t) => {
    await t.test("1. Low-edge entry reject: expectedMove < 2.0x cost is rejected", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: {
                lastPrice: 65000,
                atr: 20, // 20 / 65000 = ~0.03% (extremely low ATR / low edge)
                atr20: 20,
                boxPos: 0.20,
                boxHigh: 65030,
                boxLow: 64970
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "range_long",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 64900,
                invalidationPx: 64900,
                metadata: { tp1Price: 65030 }
            },
            config: {
                paperTakerFeeRate: 0.0005, // 0.10% roundtrip
                estimatedSlippagePct: 0.0003, // total cost 0.13%
                highwayMinCostMultiplier: 2.0 // required edge >= 0.26%
            }
        });

        assert.equal(result.allowed, false);
        assert.equal(result.finalDecision, "SKIP");
        assert.equal(result.rejectReason, "INSUFFICIENT_EXPECTED_MOVE_OVER_COST");
        assert.ok(result.expectedMovePct < result.estimatedCostPct * 2.0);
        assert.ok(result.proof.event === "HIGHWAY_ENTRY_GATE_PROOF");
        assert.equal(result.proof.symbol, "BTCUSDT");
    });

    await t.test("2. Good-edge entry allow: edge >= 2.0x cost, edge location, and RR >= 1.2 passes", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: {
                lastPrice: 3000,
                atr: 30, // 1% ATR
                atr20: 30,
                boxPos: 0.18, // edge location
                boxHigh: 3060,
                boxLow: 2980
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "range_lower_long",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 2970, // 1% stop
                invalidationPx: 2970,
                metadata: { tp1Price: 3045 } // 1.5% TP1 -> RR = 1.5
            },
            config: {
                paperTakerFeeRate: 0.0005,
                estimatedSlippagePct: 0.0003,
                highwayMinCostMultiplier: 2.0,
                highwayMinRewardRisk: 1.2
            }
        });

        assert.equal(result.allowed, true);
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.rejectReason, null);
        assert.ok(result.rewardRisk >= 1.2);
        assert.ok(result.netEdgePct > 0);
    });

    await t.test("3. RANGE box middle chase suppression: boxPos 0.50 is rejected", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: {
                lastPrice: 3000,
                atr: 30,
                atr20: 30,
                boxPos: 0.50, // MID ZONE
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
            }
        });

        assert.equal(result.allowed, false);
        assert.equal(result.finalDecision, "SKIP");
        assert.equal(result.rejectReason, "RANGE_MIDDLE_CHASE_BLOCKED_LONG");
    });

    await t.test("4. Poor reward/risk rejection: TP1/SL RR < 1.2 is rejected", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice: 60000,
                atr: 600,
                atr20: 600,
                boxPos: 0.70
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "trend_pullback",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 59000, // stop distance: 1000 (1.67%)
                invalidationPx: 59000,
                metadata: { tp1Price: 60500 } // TP1 distance: 500 (0.83%) -> RR = 0.5 < 1.2
            },
            config: {
                highwayMinRewardRisk: 1.2
            }
        });

        assert.equal(result.allowed, false);
        assert.equal(result.finalDecision, "SKIP");
        assert.equal(result.rejectReason, "POOR_REWARD_RISK_RATIO");
        assert.ok(result.rewardRisk < 1.2);
    });
});

test("HIGHWAY EXIT: Soft Exit Hysteresis & Hard Exit Immediacy", async (t) => {
    clearSoftExitState();

    await t.test("1. Soft Exit Hysteresis: 1st weak signal triggers watch, 2nd consecutive confirms exit", () => {
        clearSoftExitState("BTCUSDT");

        // First occurrence of soft weakness
        const first = applySoftExitHysteresis({
            symbol: "BTCUSDT",
            action: "REDUCE",
            reason: "TREND_WEAKNESS_REDUCE_30PCT",
            evidence: "trend_weakness",
            now: 1000
        });

        assert.equal(first.hysteresisApplied, true);
        assert.equal(first.action, "HOLD");
        assert.equal(first.reason, "SOFT_EXIT_HYSTERESIS_WATCH");
        assert.equal(first.confirmationCount, 1);

        // Second consecutive occurrence
        const second = applySoftExitHysteresis({
            symbol: "BTCUSDT",
            action: "REDUCE",
            reason: "TREND_WEAKNESS_REDUCE_30PCT",
            evidence: "trend_weakness",
            now: 2000
        });

        assert.equal(second.hysteresisApplied, false);
        assert.equal(second.action, "REDUCE");
        assert.equal(second.reason, "TREND_WEAKNESS_REDUCE_30PCT");
        assert.equal(second.confirmationCount, 2);
    });

    await t.test("2. Hard Exit Immediacy: committed stop breach or hard invalidation exits immediately with 0 delay", () => {
        clearSoftExitState("ETHUSDT");

        const hardStop = applySoftExitHysteresis({
            symbol: "ETHUSDT",
            action: "FULL_EXIT",
            reason: "PNL_STOP_PROTECT",
            evidence: "committed_stop_breached",
            now: 3000
        });

        assert.equal(hardStop.hysteresisApplied, false);
        assert.equal(hardStop.action, "FULL_EXIT");
        assert.equal(hardStop.reason, "PNL_STOP_PROTECT");
        assert.ok(hardStop.evidence.includes("hard_exit_immediate_no_hysteresis"));

        const hardInvalid = applySoftExitHysteresis({
            symbol: "ETHUSDT",
            action: "FULL_EXIT",
            reason: "V2_EXIT_INVALIDATION",
            evidence: "hard_invalidation_confirmed_with_absolute_move",
            now: 4000
        });

        assert.equal(hardInvalid.hysteresisApplied, false);
        assert.equal(hardInvalid.action, "FULL_EXIT");
        assert.equal(hardInvalid.reason, "V2_EXIT_INVALIDATION");
    });

    await t.test("3. Soft Exit Cooldown: blocks immediate re-entry ping-pong after soft exit", () => {
        clearSoftExitState("SOLUSDT");

        // Trigger 2 consecutive soft exits to confirm
        applySoftExitHysteresis({
            symbol: "SOLUSDT",
            action: "REDUCE",
            reason: "TRANSITION_REDUCE_ON_CONFLICT",
            evidence: "conflict",
            now: 10000
        });
        applySoftExitHysteresis({
            symbol: "SOLUSDT",
            action: "REDUCE",
            reason: "TRANSITION_REDUCE_ON_CONFLICT",
            evidence: "conflict",
            now: 15000
        });

        // Check cooldown active at 1 minute later
        const inCooldown = isSoftExitCooldownActive("SOLUSDT", 75000);
        assert.equal(inCooldown, true);

        // Highway Gate should reject new entry during cooldown
        const gateRes = evaluateHighwayCoreEntryGate({
            symbol: "SOLUSDT",
            side: "long",
            regime: "TREND",
            snapshot: { lastPrice: 150, atr: 3, boxPos: 0.3 },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "reentry",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 147,
                invalidationPx: 147,
                metadata: { tp1Price: 155 }
            },
            softExitCooldownActive: inCooldown
        });

        assert.equal(gateRes.allowed, false);
        assert.equal(gateRes.finalDecision, "HOLD");
        assert.equal(gateRes.rejectReason, "SOFT_EXIT_COOLDOWN_ACTIVE");

        // Check cooldown expired after 6 minutes (360_000 ms)
        const expiredCooldown = isSoftExitCooldownActive("SOLUSDT", 400000);
        assert.equal(expiredCooldown, false);
    });

    await t.test("4. Proof structure contains all mandatory fields truthfully", () => {
        const res = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "short",
            regime: "RANGE",
            snapshot: {
                lastPrice: 65000,
                atr: 650,
                atr20: 650,
                boxPos: 0.80,
                boxHigh: 66000,
                boxLow: 64000
            },
            execution: {
                signal: "SHORT_CANDIDATE",
                side: "short",
                reason: "range_upper_short",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 65650,
                invalidationPx: 65650,
                metadata: { tp1Price: 64000 }
            }
        });

        const proof = res.proof;
        assert.equal(proof.symbol, "BTCUSDT");
        assert.equal(proof.side, "short");
        assert.equal(proof.regime, "RANGE");
        assert.equal(proof.boxPos, 0.80);
        assert.ok(typeof proof.expectedMovePct === "number");
        assert.ok(typeof proof.estimatedCostPct === "number");
        assert.ok(typeof proof.netEdgePct === "number");
        assert.ok(typeof proof.tp1DistancePct === "number");
        assert.ok(typeof proof.stopDistancePct === "number");
        assert.ok(typeof proof.rewardRisk === "number");
        assert.equal(proof.finalDecision, "ENTER");
        assert.equal(proof.rejectReason, null);
    });
});
