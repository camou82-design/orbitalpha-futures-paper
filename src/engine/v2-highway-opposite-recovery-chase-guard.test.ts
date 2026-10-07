import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHighwayCoreEntryGate } from "../engine-v2/highway-core/highway-entry-gate";

test("HIGHWAY CORE: RECOVERY_CONFIRMED_OPPOSITE_CHASE_GUARD (Candidate 2)", async (t) => {
    // 1) 이번 ETH late short 차단 (2026-10-07 02:24:16 UTC exact fixture)
    await t.test("1. ETH late short 차단 (2026-10-07 02:24:16 UTC fixture 재현)", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "TREND",
            subtype: "WHIPSAW_SOFT_WATCH",
            snapshot: {
                lastPrice: 2609.64,
                boxPos: 0.059787,
                boxHigh: 2680.0,
                boxLow: 2605.0,
                atr20: 5.88,
                qualityScore: 82
            },
            execution: {
                signal: "ENTER" as any,
                side: "short",
                reason: "trend_continuation",
                baseSizeIntent: 120,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 2621.52,
                invalidationPx: 2621.52,
                metadata: {
                    plannedStopPrice: 2621.52,
                    takeProfit1Px: 2593.70,
                    reclaimConfirmed: true,
                    trend_continuation: true
                }
            },
            committedRiskPlan: {
                stopPrice: 2621.52,
                tp1Price: 2593.70
            } as any,
            recoveryAuthority: {
                recovery_candidate: true,
                recovery_confirmed: true,
                recovery_direction: "long",
                recovery_evidence: ["HIGHER_LOW", "HIGHER_HIGH", "HTF_LONG_ALIGNED", "RECLAIM_CONFIRMED"]
            },
            phaseAuthority: {
                phase: "CONTINUATION",
                higher_low: true,
                higher_high: true,
                lower_low: false,
                lower_high: false,
                upper_breakout_hold: false,
                lower_breakdown_hold: false,
                structural_box_state: "INSIDE_BOX",
                shockOverlay: "NONE"
            } as any
        });

        assert.equal(result.allowed, false, "ETH late short must be blocked");
        assert.equal(result.finalDecision, "HOLD", "finalDecision must be HOLD");
        assert.equal(result.rejectReason, "OPPOSITE_RECOVERY_CONFIRMED_CHASE_BLOCKED");
        assert.equal(result.proof.opposite_recovery_blocked, true);
        assert.equal(result.proof.recovery_confirmed, true);
        assert.equal(result.proof.recovery_direction, "long");
        assert.equal(result.proof.higher_low, true);
        assert.equal(result.proof.higher_high, true);
        assert.equal(result.proof.reclaim_confirmed, true);
        assert.equal(result.proof.recovery_invalidated, false);
    });

    // 2) LONG 완전 대칭 차단
    await t.test("2. LONG 완전 대칭 차단 (TREND_UP에서 short recovery 확정 시 long chase 차단)", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice: 85500,
                boxPos: 0.94,
                boxHigh: 85600,
                boxLow: 83000,
                atr20: 300,
                qualityScore: 80
            },
            execution: {
                signal: "ENTER" as any,
                side: "long",
                reason: "trend_breakout",
                baseSizeIntent: 120,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 84500,
                invalidationPx: 84500,
                metadata: {
                    plannedStopPrice: 84500,
                    takeProfit1Px: 87000,
                    breakdownConfirmed: true,
                    trend_continuation: true
                }
            },
            committedRiskPlan: {
                stopPrice: 84500,
                tp1Price: 87000
            } as any,
            recoveryAuthority: {
                recovery_candidate: true,
                recovery_confirmed: true,
                recovery_direction: "short",
                recovery_evidence: ["LOWER_LOW", "LOWER_HIGH", "BREAKDOWN_CONFIRMED"]
            },
            phaseAuthority: {
                phase: "CONTINUATION",
                higher_low: false,
                higher_high: false,
                lower_low: true,
                lower_high: true,
                upper_breakout_hold: false,
                lower_breakdown_hold: true,
                structural_box_state: "INSIDE_BOX",
                shockOverlay: "NONE"
            } as any
        });

        assert.equal(result.allowed, false, "LONG late chase must be blocked");
        assert.equal(result.finalDecision, "HOLD");
        assert.equal(result.rejectReason, "OPPOSITE_RECOVERY_CONFIRMED_CHASE_BLOCKED");
        assert.equal(result.proof.opposite_recovery_blocked, true);
        assert.equal(result.proof.recovery_direction, "short");
        assert.equal(result.proof.lower_high, true);
        assert.equal(result.proof.lower_low, true);
    });

    // 3) 정상 TREND_DOWN short 통과 (recovery_confirmed = false)
    await t.test("3. 정상 TREND_DOWN short 통과 (recovery 미확증 시 정상 ENTER)", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "TREND",
            snapshot: {
                lastPrice: 2600,
                boxPos: 0.15,
                boxHigh: 2680,
                boxLow: 2590,
                atr20: 8,
                qualityScore: 85
            },
            execution: {
                signal: "ENTER" as any,
                side: "short",
                reason: "trend_continuation",
                baseSizeIntent: 120,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 2620,
                invalidationPx: 2620,
                metadata: {
                    plannedStopPrice: 2620,
                    takeProfit1Px: 2560,
                    retestConfirmed: true,
                    trend_continuation: true
                }
            },
            committedRiskPlan: {
                stopPrice: 2620,
                tp1Price: 2560
            } as any,
            recoveryAuthority: {
                recovery_candidate: false,
                recovery_confirmed: false,
                recovery_direction: "none",
                recovery_evidence: []
            },
            phaseAuthority: {
                phase: "CONTINUATION",
                higher_low: false,
                higher_high: false,
                lower_low: true,
                lower_high: true,
                upper_breakout_hold: false,
                lower_breakdown_hold: false,
                structural_box_state: "INSIDE_BOX",
                shockOverlay: "NONE"
            } as any
        });

        assert.equal(result.allowed, true);
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.rejectReason, null);
        assert.equal(result.proof.opposite_recovery_blocked, false);
    });

    // 4) 정상 TREND_UP long 통과 (recovery_confirmed = false)
    await t.test("4. 정상 TREND_UP long 통과 (recovery 미확증 시 정상 ENTER)", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice: 85000,
                boxPos: 0.85,
                boxHigh: 85200,
                boxLow: 83000,
                atr20: 250,
                qualityScore: 88
            },
            execution: {
                signal: "ENTER" as any,
                side: "long",
                reason: "trend_continuation",
                baseSizeIntent: 120,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 84200,
                invalidationPx: 84200,
                metadata: {
                    plannedStopPrice: 84200,
                    takeProfit1Px: 86500,
                    retestConfirmed: true,
                    trend_continuation: true
                }
            },
            committedRiskPlan: {
                stopPrice: 84200,
                tp1Price: 86500
            } as any,
            recoveryAuthority: {
                recovery_candidate: false,
                recovery_confirmed: false,
                recovery_direction: "none",
                recovery_evidence: []
            },
            phaseAuthority: {
                phase: "CONTINUATION",
                higher_low: true,
                higher_high: true,
                lower_low: false,
                lower_high: false,
                upper_breakout_hold: false,
                lower_breakdown_hold: false,
                structural_box_state: "INSIDE_BOX",
                shockOverlay: "NONE"
            } as any
        });

        assert.equal(result.allowed, true);
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.rejectReason, null);
        assert.equal(result.proof.opposite_recovery_blocked, false);
    });

    // 5) recovery_candidate only → 차단 안 함 (엄격한 확증 조건 미충족)
    await t.test("5. recovery_candidate only → 차단 안 함 (higher_high 또는 reclaim 부재)", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "TREND",
            snapshot: {
                lastPrice: 2610,
                boxPos: 0.12,
                boxHigh: 2680,
                boxLow: 2600,
                atr20: 7,
                qualityScore: 82
            },
            execution: {
                signal: "ENTER" as any,
                side: "short",
                reason: "trend_continuation",
                baseSizeIntent: 120,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 2630,
                invalidationPx: 2630,
                metadata: {
                    plannedStopPrice: 2630,
                    takeProfit1Px: 2570,
                    retestConfirmed: true,
                    trend_continuation: true,
                    reclaimConfirmed: false
                }
            },
            committedRiskPlan: {
                stopPrice: 2630,
                tp1Price: 2570
            } as any,
            recoveryAuthority: {
                recovery_candidate: true,
                recovery_confirmed: false,
                recovery_direction: "long",
                recovery_evidence: ["HIGHER_LOW"]
            },
            phaseAuthority: {
                phase: "PULLBACK",
                higher_low: true,
                higher_high: false,
                lower_low: false,
                lower_high: true,
                upper_breakout_hold: false,
                lower_breakdown_hold: false,
                structural_box_state: "INSIDE_BOX",
                shockOverlay: "NONE"
            } as any
        });

        assert.equal(result.allowed, true, "candidate-only bounce must not block short");
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.proof.opposite_recovery_blocked, false);
    });

    // 6) recovery_confirmed 후 fresh breakdown → short 재허용 (영구 락 방지)
    await t.test("6. recovery_confirmed 후 fresh breakdown → short 재허용 (영구 락 방지)", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "TREND",
            snapshot: {
                lastPrice: 2585,
                boxPos: 0.15,
                boxHigh: 2680,
                boxLow: 2570,
                atr20: 8,
                qualityScore: 85
            },
            execution: {
                signal: "ENTER" as any,
                side: "short",
                reason: "trend_continuation",
                baseSizeIntent: 120,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 2605,
                invalidationPx: 2605,
                metadata: {
                    plannedStopPrice: 2605,
                    takeProfit1Px: 2530,
                    recovery_low: 2587.61,
                    fresh_breakdown: true,
                    breakdownConfirmed: true,
                    continuationConfirmed: true,
                    trend_continuation: true
                }
            },
            committedRiskPlan: {
                stopPrice: 2605,
                tp1Price: 2530
            } as any,
            recoveryAuthority: {
                recovery_candidate: true,
                recovery_confirmed: true,
                recovery_direction: "long",
                recovery_evidence: ["HIGHER_LOW", "HIGHER_HIGH"]
            },
            phaseAuthority: {
                phase: "CONTINUATION",
                higher_low: true,
                higher_high: true,
                lower_low: true,
                lower_high: false,
                upper_breakout_hold: false,
                lower_breakdown_hold: true,
                structural_box_state: "INSIDE_BOX",
                shockOverlay: "NONE"
            } as any
        });

        assert.equal(result.allowed, true, "fresh breakdown must invalidate long recovery and allow short");
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.proof.recovery_invalidated, true);
        assert.equal(result.proof.fresh_continuation_confirmed, true);
        assert.equal(result.proof.opposite_recovery_blocked, false);
    });

    // 7) recovery_confirmed 후 fresh breakout → long 재허용 대칭
    await t.test("7. recovery_confirmed 후 fresh breakout → long 재허용 대칭", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice: 86200,
                boxPos: 0.85,
                boxHigh: 86500,
                boxLow: 83000,
                atr20: 250,
                qualityScore: 88
            },
            execution: {
                signal: "ENTER" as any,
                side: "long",
                reason: "trend_continuation",
                baseSizeIntent: 120,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 85200,
                invalidationPx: 85200,
                metadata: {
                    plannedStopPrice: 85200,
                    takeProfit1Px: 88500,
                    recovery_high: 86000,
                    fresh_breakout: true,
                    breakoutConfirmed: true,
                    continuationConfirmed: true,
                    trend_continuation: true
                }
            },
            committedRiskPlan: {
                stopPrice: 85200,
                tp1Price: 88500
            } as any,
            recoveryAuthority: {
                recovery_candidate: true,
                recovery_confirmed: true,
                recovery_direction: "short",
                recovery_evidence: ["LOWER_LOW", "LOWER_HIGH"]
            },
            phaseAuthority: {
                phase: "CONTINUATION",
                higher_low: false,
                higher_high: true,
                lower_low: true,
                lower_high: true,
                upper_breakout_hold: true,
                lower_breakdown_hold: false,
                structural_box_state: "INSIDE_BOX",
                shockOverlay: "NONE"
            } as any
        });

        assert.equal(result.allowed, true, "fresh breakout must invalidate short recovery and allow long");
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.proof.recovery_invalidated, true);
        assert.equal(result.proof.fresh_continuation_confirmed, true);
        assert.equal(result.proof.opposite_recovery_blocked, false);
    });

    // 8) FTS 정상 continuation과 충돌 없음
    await t.test("8. FTS 정상 continuation과 충돌 없음 (FTS lineage 정상 허용)", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "TREND",
            subtype: "FAST_TREND_SHIFT",
            snapshot: {
                lastPrice: 2595,
                boxPos: 0.10,
                boxHigh: 2680,
                boxLow: 2590,
                atr20: 7,
                qualityScore: 84
            },
            execution: {
                signal: "ENTER" as any,
                side: "short",
                reason: "fast_trend_shift",
                baseSizeIntent: 120,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 2615,
                invalidationPx: 2615,
                metadata: {
                    plannedStopPrice: 2615,
                    takeProfit1Px: 2550,
                    fast_trend_shift: true,
                    fts_expedited: true,
                    retestConfirmed: true
                }
            },
            committedRiskPlan: {
                stopPrice: 2615,
                tp1Price: 2550
            } as any,
            recoveryAuthority: null,
            phaseAuthority: null
        });

        assert.equal(result.allowed, true);
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.proof.opposite_recovery_blocked, false);
    });

    // 9) RANGE에서는 기존 RANGE veto authority 유지 (RANGE zone authority 우선)
    await t.test("9. RANGE에서는 기존 RANGE veto authority 유지 (box middle chase block 우선)", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "RANGE",
            snapshot: {
                lastPrice: 2640,
                boxPos: 0.50,
                boxHigh: 2680,
                boxLow: 2600,
                atr20: 6,
                qualityScore: 80
            },
            execution: {
                signal: "ENTER" as any,
                side: "short",
                reason: "canonical_range",
                baseSizeIntent: 120,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 2660,
                invalidationPx: 2660,
                metadata: {
                    plannedStopPrice: 2660,
                    takeProfit1Px: 2610
                }
            },
            committedRiskPlan: {
                stopPrice: 2660,
                tp1Price: 2610
            } as any
        });

        assert.equal(result.allowed, false);
        assert.equal(result.finalDecision, "SKIP");
        assert.equal(result.rejectReason, "RANGE_MIDDLE_CHASE_BLOCKED_SHORT");
    });

    // 10) stale recovery metadata만 존재하고 current recovery proof가 무효(recovery_confirmed === false)면 차단 안 함
    await t.test("10. stale recovery metadata만 존재하고 current recovery proof가 무효면 차단 안 함", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "TREND",
            snapshot: {
                lastPrice: 2600,
                boxPos: 0.15,
                boxHigh: 2680,
                boxLow: 2590,
                atr20: 8,
                qualityScore: 85
            },
            execution: {
                signal: "ENTER" as any,
                side: "short",
                reason: "trend_continuation",
                baseSizeIntent: 120,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 2620,
                invalidationPx: 2620,
                metadata: {
                    plannedStopPrice: 2620,
                    takeProfit1Px: 2560,
                    recovery_confirmed: true,
                    recovery_direction: "long",
                    higher_low: true,
                    higher_high: true,
                    reclaimConfirmed: true,
                    retestConfirmed: true,
                    trend_continuation: true
                }
            },
            committedRiskPlan: {
                stopPrice: 2620,
                tp1Price: 2560
            } as any,
            recoveryAuthority: {
                recovery_candidate: false,
                recovery_confirmed: false,
                recovery_direction: "none",
                recovery_evidence: []
            },
            phaseAuthority: {
                phase: "CONTINUATION",
                higher_low: false,
                higher_high: false,
                lower_low: true,
                lower_high: true,
                upper_breakout_hold: false,
                lower_breakdown_hold: false,
                structural_box_state: "INSIDE_BOX",
                shockOverlay: "NONE"
            } as any
        });

        assert.equal(result.allowed, true, "Authoritative recovery_confirmed: false must override stale metadata");
        assert.equal(result.finalDecision, "ENTER");
        assert.equal(result.proof.opposite_recovery_blocked, false);
    });

    // 11) HIGHWAY quality/edge/RR 실패 건은 기존 이유가 그대로 우선
    await t.test("11. HIGHWAY quality/edge/RR 실패 건은 기존 이유가 그대로 우선 (POOR_REWARD_RISK_RATIO)", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "TREND",
            snapshot: {
                lastPrice: 2610,
                boxPos: 0.05,
                boxHigh: 2680,
                boxLow: 2600,
                atr20: 6,
                qualityScore: 80
            },
            execution: {
                signal: "ENTER" as any,
                side: "short",
                reason: "trend_continuation",
                baseSizeIntent: 120,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: 2640,
                invalidationPx: 2640,
                metadata: {
                    plannedStopPrice: 2640,
                    takeProfit1Px: 2595,
                    reclaimConfirmed: true,
                    trend_continuation: true
                }
            },
            committedRiskPlan: {
                stopPrice: 2640,
                tp1Price: 2595
            } as any,
            recoveryAuthority: {
                recovery_candidate: true,
                recovery_confirmed: true,
                recovery_direction: "long",
                recovery_evidence: ["HIGHER_LOW", "HIGHER_HIGH", "RECLAIM_CONFIRMED"]
            },
            phaseAuthority: {
                phase: "CONTINUATION",
                higher_low: true,
                higher_high: true,
                lower_low: false,
                lower_high: false,
                upper_breakout_hold: false,
                lower_breakdown_hold: false,
                structural_box_state: "INSIDE_BOX",
                shockOverlay: "NONE"
            } as any
        });

        assert.equal(result.allowed, false);
        assert.equal(result.finalDecision, "SKIP");
        assert.equal(result.rejectReason, "POOR_REWARD_RISK_RATIO", "RR failure reason must take precedence");
    });

    // 12) PreCheck 단계에서도 가드 정상 작동 확인
    await t.test("12. isPreCheck=true 단계에서도 Guard 정상 작동 (사전 검증 차단)", () => {
        const result = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "short",
            regime: "TREND",
            snapshot: {
                lastPrice: 2609.64,
                boxPos: 0.059787,
                boxHigh: 2680.0,
                boxLow: 2605.0,
                atr20: 5.88,
                qualityScore: 82
            },
            execution: {
                signal: "ENTER" as any,
                side: "short",
                reason: "trend_continuation",
                baseSizeIntent: 120,
                recheckSuggested: false,
                isAddOnEligible: false,
                stopPrice: null,
                invalidationPx: null,
                metadata: {
                    reclaimConfirmed: true,
                    trend_continuation: true
                }
            },
            committedRiskPlan: null,
            isPreCheck: true,
            recoveryAuthority: {
                recovery_candidate: true,
                recovery_confirmed: true,
                recovery_direction: "long",
                recovery_evidence: ["HIGHER_LOW", "HIGHER_HIGH", "RECLAIM_CONFIRMED"]
            },
            phaseAuthority: {
                phase: "CONTINUATION",
                higher_low: true,
                higher_high: true,
                lower_low: false,
                lower_high: false,
                upper_breakout_hold: false,
                lower_breakdown_hold: false,
                structural_box_state: "INSIDE_BOX",
                shockOverlay: "NONE"
            } as any
        });

        assert.equal(result.allowed, false, "preCheck must also be blocked by opposite recovery guard");
        assert.equal(result.finalDecision, "HOLD");
        assert.equal(result.rejectReason, "OPPOSITE_RECOVERY_CONFIRMED_CHASE_BLOCKED");
    });
});
