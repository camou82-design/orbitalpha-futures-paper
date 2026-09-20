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

test("HIGHWAY CORE: 2차 안전 보완 패치 검증 테스트", async (t) => {
    await t.test("pre-gate 시 committedRiskPlan 미생성 → 정상 candidate가 영구 reject latch 되지 않음", () => {
        // In Tier 5.6 pre-gate, committedRiskPlan is null because plan is not formed yet.
        // With isPreCheck: true, it should validate regime/location/shock/cooldown but NOT reject for missing plan.
        const preGateResult = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            isPreCheck: true,
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
                stopPrice: null,
                invalidationPx: null,
                metadata: {}
            },
            committedRiskPlan: null
        });

        assert.equal(preGateResult.allowed, true);
        assert.equal(preGateResult.finalDecision, "ENTER");
        assert.equal(preGateResult.rejectReason, null);
    });

    await t.test("final gate에서 committed TP1/SL 존재 → 정상 ENTER 가능", () => {
        // At final execution gate (isPreCheck: false), committedRiskPlan exists with valid TP1 and SL
        const finalGateResult = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            isPreCheck: false,
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
                stopPrice: 2970,
                invalidationPx: 2970,
                metadata: {
                    tp1Price: 3045
                }
            },
            committedRiskPlan: {
                symbol: "ETHUSDT",
                side: "long",
                action: "ENTER",
                finalOrderNotionalUsdt: 100,
                appliedLeverage: 10,
                stopPrice: 2970, // 1%
                invalidationPx: 2970,
                ts: Date.now()
            },
            config: {
                paperTakerFeeRate: 0.0005,
                estimatedSlippagePct: 0.0003,
                highwayMinCostMultiplier: 2.0,
                highwayMinRewardRisk: 1.2
            }
        });

        assert.equal(finalGateResult.allowed, true);
        assert.equal(finalGateResult.finalDecision, "ENTER");
        assert.equal(finalGateResult.rejectReason, null);
        assert.ok(finalGateResult.rewardRisk >= 1.2);
    });

    await t.test("final gate에서 TP1/SL 없음 → HIGHWAY_PLAN_MISSING", () => {
        // At final execution gate (isPreCheck: false), missing plan fails closed
        const finalGateMissingPlan = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            isPreCheck: false,
            snapshot: {
                lastPrice: 3000,
                atr: 30,
                boxPos: 0.20
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "range_lower_long",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: null,
                invalidationPx: null,
                metadata: {}
            },
            committedRiskPlan: null
        });

        assert.equal(finalGateMissingPlan.allowed, false);
        assert.equal(finalGateMissingPlan.finalDecision, "SKIP");
        assert.equal(finalGateMissingPlan.rejectReason, "HIGHWAY_PLAN_MISSING");
    });

    await t.test("closed candle timestamp 없음 + 10분 경과 → confirmation count 증가하지 않음", () => {
        clearSoftExitState("BTCUSDT");

        // 1st tick with no closed candle ts
        const res1 = applySoftExitHysteresis({
            symbol: "BTCUSDT",
            action: "REDUCE",
            reason: "TREND_WEAKNESS_REDUCE_30PCT",
            evidence: "trend_weakness",
            now: 1788500000000,
            latestClosedCandleTs: null
        });

        assert.equal(res1.hysteresisApplied, true);
        assert.equal(res1.action, "HOLD");
        assert.equal(res1.reason, "SOFT_EXIT_WAITING_CLOSED_CANDLE_AUTHORITY");
        assert.equal(res1.confirmationCount, 0);

        // 10 minutes later (600,000 ms), still no authoritative closed candle ts
        const res2 = applySoftExitHysteresis({
            symbol: "BTCUSDT",
            action: "REDUCE",
            reason: "TREND_WEAKNESS_REDUCE_30PCT",
            evidence: "trend_weakness",
            now: 1788500000000 + 600000,
            latestClosedCandleTs: null
        });

        assert.equal(res2.hysteresisApplied, true);
        assert.equal(res2.action, "HOLD");
        assert.equal(res2.reason, "SOFT_EXIT_WAITING_CLOSED_CANDLE_AUTHORITY");
        assert.equal(res2.confirmationCount, 0); // Count did not increase
    });

    await t.test("실제 다음 closed 5m candle timestamp 도착 → count 증가", () => {
        clearSoftExitState("BTCUSDT");

        const candle1 = 1788500000000;
        const res1 = applySoftExitHysteresis({
            symbol: "BTCUSDT",
            action: "REDUCE",
            reason: "TREND_WEAKNESS_REDUCE_30PCT",
            evidence: "trend_weakness",
            now: candle1 + 15000,
            latestClosedCandleTs: candle1
        });

        assert.equal(res1.confirmationCount, 1);
        assert.equal(res1.action, "HOLD");
        assert.equal(res1.reason, "SOFT_EXIT_HYSTERESIS_WATCH");

        // Now next closed 5m candle arrives
        const candle2 = candle1 + 300000;
        const res2 = applySoftExitHysteresis({
            symbol: "BTCUSDT",
            action: "REDUCE",
            reason: "TREND_WEAKNESS_REDUCE_30PCT",
            evidence: "trend_weakness",
            now: candle2 + 15000,
            latestClosedCandleTs: candle2
        });

        assert.equal(res2.confirmationCount, 2);
        assert.equal(res2.hysteresisApplied, false);
        assert.equal(res2.action, "REDUCE");
        assert.equal(res2.reason, "TREND_WEAKNESS_REDUCE_30PCT");
    });
});

test("HIGHWAY CORE: metadata.takeProfit1Px Range Executor Runtime Deadlock Regression Suite", async (t) => {
    await t.test("1. LONG RANGE executor: execution.metadata.takeProfit1Px만 존재 + valid stop → Highway final gate 정상 ENTER", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: {
                lastPrice: 3000,
                atr: 30,
                atr20: 30,
                boxPos: 0.20,
                boxHigh: 3080,
                boxLow: 2980
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "range_lower_long",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 2970, // stop distance 30 (1%)
                invalidationPx: 2970,
                metadata: {
                    takeProfit1Px: 3045, // TP1 distance 45 (1.5% > 0.26% cost, RR 1.5 >= 1.2)
                    rangeBoxHighAtEntry: 3080,
                    rangeBoxLowAtEntry: 2980
                }
            },
            committedRiskPlan: null,
            isPreCheck: false
        });

        assert.equal(result.allowed, true);
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.rejectReason, null);
        assert.ok(result.tp1DistancePct > 0.014 && result.tp1DistancePct < 0.016);
        assert.ok(result.stopDistancePct > 0.009 && result.stopDistancePct < 0.011);
        assert.ok(result.rewardRisk >= 1.2);
    });

    await t.test("2. SHORT RANGE executor: execution.metadata.takeProfit1Px만 존재 + valid stop → Highway final gate 정상 ENTER", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            snapshot: {
                lastPrice: 3000,
                atr: 30,
                atr20: 30,
                boxPos: 0.80,
                boxHigh: 3020,
                boxLow: 2920
            },
            execution: {
                signal: "SHORT_CANDIDATE",
                side: "short",
                reason: "range_upper_short",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 3030, // stop distance 30 (1%)
                invalidationPx: 3030,
                metadata: {
                    takeProfit1Px: 2955, // TP1 distance 45 (1.5% > 0.26% cost, RR 1.5 >= 1.2, short TP < entry)
                    rangeBoxHighAtEntry: 3020,
                    rangeBoxLowAtEntry: 2920
                }
            },
            committedRiskPlan: null,
            isPreCheck: false
        });

        assert.equal(result.allowed, true);
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.rejectReason, null);
        assert.ok(result.tp1DistancePct > 0.014 && result.tp1DistancePct < 0.016);
        assert.ok(result.stopDistancePct > 0.009 && result.stopDistancePct < 0.011);
        assert.ok(result.rewardRisk >= 1.2);
    });

    await t.test("3. Production runtime 재현: original_decision=ENTER, valid stop, metadata.takeProfit1Px → HIGHWAY_PLAN_MISSING 탈출", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: {
                lastPrice: 65000,
                atr: 650,
                atr20: 650,
                boxPos: 0.25,
                boxHigh: 66500,
                boxLow: 64500
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "range_lower_bounce",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 64350, // 1% stop
                invalidationPx: 64350,
                metadata: {
                    takeProfit1Px: 65975, // 1.5% TP1
                    executableTp1Price: 65975,
                    takeProfitPlan: {
                        executableTp1: 65975,
                        tp1: 65975
                    }
                } as any
            },
            committedRiskPlan: null,
            isPreCheck: false
        });

        assert.equal(result.allowed, true);
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.rejectReason, null);
    });

    await t.test("4. Fail-closed: Wrong-direction TP는 반드시 HIGHWAY_PLAN_MISSING 유지", () => {
        // LONG with TP < entry
        const wrongLong = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: { lastPrice: 3000, atr: 30, boxPos: 0.20 },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "range_lower_long",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 2970,
                invalidationPx: 2970,
                metadata: {
                    takeProfit1Px: 2950 // INVALID: LONG TP below entry!
                }
            },
            isPreCheck: false
        });
        assert.equal(wrongLong.allowed, false);
        assert.equal(wrongLong.finalDecision, "SKIP");
        assert.equal(wrongLong.rejectReason, "HIGHWAY_PLAN_MISSING");

        // SHORT with TP > entry
        const wrongShort = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            snapshot: { lastPrice: 3000, atr: 30, boxPos: 0.80 },
            execution: {
                signal: "SHORT_CANDIDATE",
                side: "short",
                reason: "range_upper_short",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 3030,
                invalidationPx: 3030,
                metadata: {
                    takeProfit1Px: 3050 // INVALID: SHORT TP above entry!
                }
            },
            isPreCheck: false
        });
        assert.equal(wrongShort.allowed, false);
        assert.equal(wrongShort.finalDecision, "SKIP");
        assert.equal(wrongShort.rejectReason, "HIGHWAY_PLAN_MISSING");
    });

    await t.test("5. Fail-closed: Missing / 0 / null TP는 반드시 HIGHWAY_PLAN_MISSING 유지", () => {
        const zeroTp = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: { lastPrice: 3000, atr: 30, boxPos: 0.20 },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "range_lower_long",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 2970,
                invalidationPx: 2970,
                metadata: {
                    takeProfit1Px: 0
                }
            },
            isPreCheck: false
        });
        assert.equal(zeroTp.allowed, false);
        assert.equal(zeroTp.finalDecision, "SKIP");
        assert.equal(zeroTp.rejectReason, "HIGHWAY_PLAN_MISSING");
    });
});

test("HIGHWAY CORE: Expected Move Canonical Authority & Low-Volatility ATR Hard Cap Removal Suite (LONG/SHORT Symmetric)", async (t) => {
    const baseConfig = {
        paperTakerFeeRate: 0.0005,
        estimatedSlippagePct: 0.0003,
        highwayMinCostMultiplier: 2.0, // minRequiredMovePct = (0.0010 + 0.0003) * 2.0 = 0.0026 (0.26%)
        highwayMinRewardRisk: 1.2
    };

    await t.test("1. LONG: Low-volatility regime (ATR 0.03%) - candidateExpectedMove (1.2%) serves as canonical authority without ATR*2 (0.06%) deadlock", () => {
        // lastPrice = 3000, atr = 1.0 (atrPct = 0.033%), planned TP1 = 3036 (1.2%), planned Stop = 2976 (0.8%)
        // If ATR*2 cap existed, expectedMove would be capped at ~0.067% < 0.26% cost hurdle -> deadlock!
        // With ATR*2 cap removed, candidateExpectedMove (1.2%) > 0.26% hurdle and RR = 1.5 >= 1.2 -> ALLOWED
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice: 3000,
                atr: 1.0, // extremely low volatility
                atr20: 1.0,
                boxPos: 0.30
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "trend_pullback",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 2976, // 0.8% stop
                invalidationPx: 2976,
                metadata: {
                    plannedTp1Price: 3036 // 1.2% TP1
                }
            },
            config: baseConfig,
            isPreCheck: false
        });

        assert.equal(result.allowed, true);
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.rejectReason, null);
        assert.ok(Math.abs(result.expectedMovePct - 0.012) < 1e-6);
        assert.ok(Math.abs(result.tp1DistancePct - 0.012) < 1e-6);
        assert.ok(Math.abs(result.stopDistancePct - 0.008) < 1e-6);
        assert.ok(result.rewardRisk >= 1.2);
        assert.equal(typeof (result.proof as any).atrPct, "number");
        assert.ok((result.proof as any).atrPct > 0);
    });

    await t.test("2. SHORT: Low-volatility regime (ATR 0.03%) - candidateExpectedMove (1.2%) serves as canonical authority without ATR*2 (0.06%) deadlock", () => {
        // lastPrice = 3000, atr = 1.0 (atrPct = 0.033%), planned TP1 = 2964 (1.2%), planned Stop = 3024 (0.8%)
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "TREND",
            snapshot: {
                lastPrice: 3000,
                atr: 1.0, // extremely low volatility
                atr20: 1.0,
                boxPos: 0.70
            },
            execution: {
                signal: "SHORT_CANDIDATE",
                side: "short",
                reason: "trend_pullback_short",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 3024, // 0.8% stop
                invalidationPx: 3024,
                metadata: {
                    plannedTp1Price: 2964 // 1.2% TP1
                }
            },
            config: baseConfig,
            isPreCheck: false
        });

        assert.equal(result.allowed, true);
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.rejectReason, null);
        assert.ok(Math.abs(result.expectedMovePct - 0.012) < 1e-6);
        assert.ok(Math.abs(result.tp1DistancePct - 0.012) < 1e-6);
        assert.ok(Math.abs(result.stopDistancePct - 0.008) < 1e-6);
        assert.ok(result.rewardRisk >= 1.2);
        assert.equal(typeof (result.proof as any).atrPct, "number");
        assert.ok((result.proof as any).atrPct > 0);
    });

    await t.test("3. LONG RANGE: structureRoom hard bound is preserved when structureRoom < tp1DistancePct", () => {
        // lastPrice = 3000, boxHigh = 3024 (structureRoom = 0.8%), planned TP1 = 3045 (1.5%), planned Stop = 2970 (1.0%)
        // candidateExpectedMove = min(1.5%, 0.8%) = 0.8%
        // Cost hurdle = 0.26% -> 0.8% > 0.26% passes cost hurdle
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: {
                lastPrice: 3000,
                atr: 1.0,
                atr20: 1.0,
                boxPos: 0.20,
                boxHigh: 3024, // 0.8% room
                boxLow: 2970
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "range_lower_long",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 2970, // 1.0% stop
                invalidationPx: 2970,
                metadata: {
                    plannedTp1Price: 3045 // 1.5% TP1
                }
            },
            config: baseConfig,
            isPreCheck: false
        });

        assert.equal(result.allowed, true);
        assert.equal(result.finalDecision, "ENTER");
        assert.ok(Math.abs(result.expectedMovePct - 0.008) < 1e-6); // strictly bound to structureRoom 0.8%
        assert.ok(Math.abs(result.tp1DistancePct - 0.015) < 1e-6);
    });

    await t.test("4. SHORT RANGE: structureRoom hard bound is preserved when structureRoom < tp1DistancePct", () => {
        // lastPrice = 3000, boxLow = 2976 (structureRoom = 0.8%), planned TP1 = 2955 (1.5%), planned Stop = 3030 (1.0%)
        // candidateExpectedMove = min(1.5%, 0.8%) = 0.8%
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            snapshot: {
                lastPrice: 3000,
                atr: 1.0,
                atr20: 1.0,
                boxPos: 0.80,
                boxHigh: 3030,
                boxLow: 2976 // 0.8% room to bottom
            },
            execution: {
                signal: "SHORT_CANDIDATE",
                side: "short",
                reason: "range_upper_short",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 3030, // 1.0% stop
                invalidationPx: 3030,
                metadata: {
                    plannedTp1Price: 2955 // 1.5% TP1
                }
            },
            config: baseConfig,
            isPreCheck: false
        });

        assert.equal(result.allowed, true);
        assert.equal(result.finalDecision, "ENTER");
        assert.ok(Math.abs(result.expectedMovePct - 0.008) < 1e-6); // strictly bound to structureRoom 0.8%
        assert.ok(Math.abs(result.tp1DistancePct - 0.015) < 1e-6);
    });

    await t.test("5. LONG: Hard safety preserved - expectedMovePct < minRequiredMovePct rejects with INSUFFICIENT_EXPECTED_MOVE_OVER_COST", () => {
        // planned TP1 = 3004.5 (0.15% < 0.26% minRequiredMovePct)
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice: 3000,
                atr: 20,
                atr20: 20,
                boxPos: 0.30
            },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "trend_pullback",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 2997, // 0.1% stop (RR = 1.5 >= 1.2, but move < 0.26% cost)
                invalidationPx: 2997,
                metadata: {
                    plannedTp1Price: 3004.5 // 0.15% TP1
                }
            },
            config: baseConfig,
            isPreCheck: false
        });

        assert.equal(result.allowed, false);
        assert.equal(result.finalDecision, "SKIP");
        assert.equal(result.rejectReason, "INSUFFICIENT_EXPECTED_MOVE_OVER_COST");
    });

    await t.test("6. SHORT: Hard safety preserved - expectedMovePct < minRequiredMovePct rejects with INSUFFICIENT_EXPECTED_MOVE_OVER_COST", () => {
        // planned TP1 = 2995.5 (0.15% < 0.26% minRequiredMovePct)
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "TREND",
            snapshot: {
                lastPrice: 3000,
                atr: 20,
                atr20: 20,
                boxPos: 0.70
            },
            execution: {
                signal: "SHORT_CANDIDATE",
                side: "short",
                reason: "trend_pullback_short",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 3003, // 0.1% stop
                invalidationPx: 3003,
                metadata: {
                    plannedTp1Price: 2995.5 // 0.15% TP1
                }
            },
            config: baseConfig,
            isPreCheck: false
        });

        assert.equal(result.allowed, false);
        assert.equal(result.finalDecision, "SKIP");
        assert.equal(result.rejectReason, "INSUFFICIENT_EXPECTED_MOVE_OVER_COST");
    });

    await t.test("7. LONG/SHORT: Hard safety preserved - RR < 1.2 rejects with POOR_REWARD_RISK_RATIO", () => {
        const poorLong = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "TREND",
            snapshot: { lastPrice: 3000, atr: 20, boxPos: 0.30 },
            execution: {
                signal: "LONG_CANDIDATE",
                side: "long",
                reason: "trend_pullback",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 2940, // 2.0% stop
                invalidationPx: 2940,
                metadata: {
                    plannedTp1Price: 3030 // 1.0% TP1 -> RR = 0.5 < 1.2
                }
            },
            config: baseConfig,
            isPreCheck: false
        });

        assert.equal(poorLong.allowed, false);
        assert.equal(poorLong.finalDecision, "SKIP");
        assert.equal(poorLong.rejectReason, "POOR_REWARD_RISK_RATIO");

        const poorShort = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "TREND",
            snapshot: { lastPrice: 3000, atr: 20, boxPos: 0.70 },
            execution: {
                signal: "SHORT_CANDIDATE",
                side: "short",
                reason: "trend_pullback_short",
                baseSizeIntent: 1,
                recheckSuggested: false,
                isAddOnEligible: true,
                stopPrice: 3060, // 2.0% stop
                invalidationPx: 3060,
                metadata: {
                    plannedTp1Price: 2970 // 1.0% TP1 -> RR = 0.5 < 1.2
                }
            },
            config: baseConfig,
            isPreCheck: false
        });

        assert.equal(poorShort.allowed, false);
        assert.equal(poorShort.finalDecision, "SKIP");
        assert.equal(poorShort.rejectReason, "POOR_REWARD_RISK_RATIO");
    });
});


