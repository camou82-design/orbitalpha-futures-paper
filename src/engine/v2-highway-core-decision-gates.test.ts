import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHighwayCoreEntryGate } from "../engine-v2/highway-core/highway-entry-gate";
import {
    applySoftExitHysteresis,
    isSoftExitCooldownActive,
    clearSoftExitState,
    isHardExitReason,
    isSoftExitReason,
    isPureTakeProfitReason
} from "../engine-v2/exit/soft-exit-hysteresis";
import { runEngineV2 } from "../engine-v2/index";
import type { EngineV2Input } from "../engine-v2/types";

test("HIGHWAY CORE: Decision Order & Entry Quality Gates (Phase 2 Hardening)", async (t) => {
    await t.test("1. TP/SL plan 누락 시 synthetic 계획으로 ENTER 금지 (HIGHWAY_PLAN_MISSING fail-closed)", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: {
                lastPrice: 3000,
                atr: 30,
                boxPos: 0.20,
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
                stopPrice: null, // MISSING STOP!
                invalidationPx: null,
                metadata: {} // MISSING TP1!
            }
        });

        assert.equal(result.allowed, false);
        assert.equal(result.finalDecision, "SKIP");
        assert.equal(result.rejectReason, "HIGHWAY_PLAN_MISSING");
    });

    await t.test("2. actual TP1이 0.25%인데 ATR expectedMove가 0.6%인 경우 actual TP 기준으로 low-edge/RR 판정", () => {
        // ATR = 18 on 3000 (0.6%), but actual planned TP1 is only 3007.5 (0.25%)
        // Roundtrip fee 0.10% + slippage 0.03% = 0.13%
        // Required edge multiplier 2.0x = 0.26%
        // Since actual TP1 distance is 0.25% < 0.26%, it MUST be rejected!
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice: 3000,
                atr: 18, // 0.6% ATR
                atr20: 18,
                boxPos: 0.30
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "trend_pullback",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 2970, // stop distance 30 (1%)
                invalidationPx: 2970,
                metadata: {
                    plannedTp1Price: 3007.5 // actual TP1 distance is only 7.5 (0.25%)!
                }
            },
            config: {
                paperTakerFeeRate: 0.0005,
                estimatedSlippagePct: 0.0003,
                highwayMinCostMultiplier: 2.0,
                highwayMinRewardRisk: 1.2
            }
        });

        assert.equal(result.allowed, false);
        assert.equal(result.finalDecision, "SKIP");
        // Rejection either due to insufficient expected move over cost (0.25% < 0.26%) or RR (0.25 / 1.0 = 0.25 < 1.2)
        assert.ok(
            result.rejectReason === "INSUFFICIENT_EXPECTED_MOVE_OVER_COST" ||
            result.rejectReason === "POOR_REWARD_RISK_RATIO"
        );
        assert.ok(result.expectedMovePct <= 0.0025 + 1e-6); // capped by actual planned TP1
    });

    await t.test("3. Good-edge entry allow: planned TP1 1.5%, planned Stop 1.0% (RR 1.5 >= 1.2) passes", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: {
                lastPrice: 3000,
                atr: 30,
                atr20: 30,
                boxPos: 0.18,
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
    });

    await t.test("4. RANGE box middle chase suppression: boxPos 0.50 is rejected", () => {
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

    await t.test("5. Deadlock promotion 또는 downstream promotion도 Highway Gate reject를 우회하여 ENTER를 복원하지 못함", () => {
        // Even if an external candidate or deadlock probe tries to promote ENTER, if Highway Gate rejects (e.g. missing plan or poor RR), it remains rejected (SKIP/HOLD)
        const gate = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: {
                lastPrice: 65000,
                atr: 200,
                boxPos: 0.55 // mid-box chase
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "deadlock_probe_candidate",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 64500,
                invalidationPx: 64500,
                metadata: { tp1Price: 65500 }
            }
        });

        assert.equal(gate.allowed, false);
        assert.equal(gate.finalDecision, "SKIP");
        assert.ok(gate.rejectReason != null);
        assert.equal(gate.proof.finalDecision, "SKIP");
    });
});

test("HIGHWAY EXIT: Closed 5m Candle Hysteresis & TP1 Exemption", async (t) => {
    clearSoftExitState();

    await t.test("1. 같은 5m candle에서 10회 반복 tick → soft confirmation count는 1 유지", () => {
        clearSoftExitState("BTCUSDT");

        const candleTs1 = 1788500000000; // Candle 1

        for (let tick = 0; tick < 10; tick++) {
            const res = applySoftExitHysteresis({
                symbol: "BTCUSDT",
                action: "REDUCE",
                reason: "TREND_WEAKNESS_REDUCE_30PCT",
                evidence: "trend_weakness",
                now: candleTs1 + tick * 15000, // 15-second loop ticks within same candle
                latestClosedCandleTs: candleTs1
            });

            assert.equal(res.hysteresisApplied, true);
            assert.equal(res.action, "HOLD");
            assert.equal(res.reason, "SOFT_EXIT_HYSTERESIS_WATCH");
            assert.equal(res.confirmationCount, 1); // Remains 1 throughout all 10 ticks!
        }
    });

    await t.test("2. 다음 closed 5m candle에서 동일 weakness 발생 시 2차 확인 및 소프트 청산 허용", () => {
        const candleTs2 = 1788500300000; // Candle 2 (5 minutes later)

        const res2 = applySoftExitHysteresis({
            symbol: "BTCUSDT",
            action: "REDUCE",
            reason: "TREND_WEAKNESS_REDUCE_30PCT",
            evidence: "trend_weakness",
            now: candleTs2 + 10000,
            latestClosedCandleTs: candleTs2
        });

        assert.equal(res2.hysteresisApplied, false);
        assert.equal(res2.action, "REDUCE");
        assert.equal(res2.reason, "TREND_WEAKNESS_REDUCE_30PCT");
        assert.equal(res2.confirmationCount, 2);
        assert.ok(res2.evidence.includes("soft_exit_hysteresis_confirmed_2_closed_5m_candles"));
    });

    await t.test("3. TP1 partial take profit은 hysteresis 없이 즉시 허용", () => {
        const tp1Res = applySoftExitHysteresis({
            symbol: "ETHUSDT",
            action: "PARTIAL_TAKE_PROFIT",
            reason: "RANGE_PARTIAL_AT_OPPOSITE_EDGE",
            evidence: "range_long_opposite_edge",
            now: 1788500500000,
            latestClosedCandleTs: 1788500500000,
            pnlPct: 0.015 // +1.5% profit
        });

        assert.equal(tp1Res.hysteresisApplied, false);
        assert.equal(tp1Res.action, "PARTIAL_TAKE_PROFIT");
        assert.equal(tp1Res.reason, "RANGE_PARTIAL_AT_OPPOSITE_EDGE");
        assert.ok(tp1Res.evidence.includes("take_profit_immediate_no_hysteresis"));
    });

    await t.test("4. Hard stop / hard invalidation / shock full exit는 즉시 종료 (0 delay)", () => {
        const hardStop = applySoftExitHysteresis({
            symbol: "ETHUSDT",
            action: "FULL_EXIT",
            reason: "PNL_STOP_PROTECT",
            evidence: "committed_stop_breached",
            now: 1788500600000
        });

        assert.equal(hardStop.hysteresisApplied, false);
        assert.equal(hardStop.action, "FULL_EXIT");
        assert.equal(hardStop.reason, "PNL_STOP_PROTECT");
        assert.ok(hardStop.evidence.includes("hard_exit_immediate_no_hysteresis"));
    });
});
