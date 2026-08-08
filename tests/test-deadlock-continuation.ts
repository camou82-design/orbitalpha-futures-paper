import { RangeContinuationPhase, executeRangeRegime, rangeContinuationStateMap } from "../src/engine-v2/executors/range-executor";
import { EngineV2Input, MarketJudgmentOutput } from "../src/engine-v2/types";

let globalTsOffset = 0;
function buildInput(overrides: Partial<EngineV2Input> = {}): EngineV2Input {
    globalTsOffset += 60000;
    return {
        run_cycle_id: "cycle-1",
        symbol: "BTCUSDT",
        evaluationMode: "authoritative",
        now: 1000000,
        v1Result: {} as any,
        snapshot: {
            lastPrice: 50000,
            boxHigh: 51000,
            boxLow: 49000,
            boxPos: 0.1,
            rangeConfidence: 0.8,
            boxCohesion01: 0.8,
            breakoutFailureRate: 0.2,
            rangeOscillationScore: 0.8,
            atr: 500,
            emaGap: 0,
            qualityScore: 1,
            candles: [
                { high: 50500, low: 49500, ts: 1000000 },
                { high: 50500, low: 49500, ts: 1000000 + globalTsOffset }
            ] as any,
            rangeCenterSlope: 0
        } as any,
        config: {} as any,
        state: {
            currentPositions: [],
            longAllow: true,
            shortAllow: true
        } as any,
        ...overrides
    };
}

function buildJudgment(overrides: Partial<MarketJudgmentOutput> = {}): MarketJudgmentOutput {
    return {
        regime: "RANGE",
        subtype: "RANGE_LOWER_REACTION",
        trendPhase: "NO_TREND",
        shockPhase: "NO_SHOCK",
        confidenceLevel: "HIGH",
        reversalConfirmed: false,
        subtypeReason: "Test",
        metadata: {
            bhSlope: 0,
            blSlope: 0,
            rcSlope: 0
        },
        ...overrides
    } as any;
}

function clearState() {
    rangeContinuationStateMap.clear();
}

let passed = 0;
let total = 0;
function assertEqual(actual: any, expected: any, msg: string) {
    total++;
    if (actual === expected) {
        passed++;
    } else {
        console.error(`[FAIL] ${msg}`);
        console.error(`  Expected: ${expected}`);
        console.error(`  Actual:   ${actual}`);
    }
}

// 1. 하단 단순 급락 시 추격 short 차단
function test1() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
        );
    }
    // Now in WATCH state. Plunge the price heavily.
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 48000, atr: 500, emaGap: -10, rangeCenterSlope: -1,
                candles: [
                    { high: 48500, low: 48000, ts: 999999999 }
                ] as any
             }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
    );
    assertEqual(res.reason, "BREAKDOWN_SHORT_SKIPPED_NO_RETEST", "Test 1: Skip short on crash");
}

// 2. 하단 이탈 후 retest 실패 시 short ENTER
function test2() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
        );
    }
    // Retest Touch
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 48995, atr: 500, emaGap: -10, rangeCenterSlope: -1,
                candles: [{ high: 48995, low: 48900, ts: 999999999 }] as any
             }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
    );
    // Retest Confirmed (Drop)
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-5`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 48700, atr: 500, emaGap: -10, rangeCenterSlope: -1,
                candles: [{ high: 48995, low: 48800, ts: 999999999 }] as any
             }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
    );
    assertEqual(res.reason, "BREAKDOWN_RETEST_SHORT_CONFIRMED", "Test 2: Short ENTER on retest fail");
    assertEqual(res.side, "short", "Test 2: Side is short");
}

// 3. 하단 상승 반전 확인 시 기존 long 유지
function test3() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
        );
    }
    // Reversal Confirmed overrides Deadlock
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 49500, atr: 500, emaGap: -10, rangeCenterSlope: -1,
                candles: [{ high: 49500, low: 48950, ts: 999999999 }] as any
             }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0, reversal_confirmed: true } as any })
    );
    assertEqual(res.reason, "Lower edge reversal identified by price reaction", "Test 3: Long entry preserved on reversal");
}

// 4. 상단 단순 급등 시 추격 long 차단
function test4() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 51100, atr: 500, emaGap: 10, rangeCenterSlope: 1 }
            }),
            buildJudgment({ trendPhase: "UP", metadata: { blSlope: 0, rcSlope: 1, bhSlope: 1 } as any })
        );
    }
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 52000, atr: 500, emaGap: 10, rangeCenterSlope: 1,
                candles: [{ high: 52000, low: 51500, ts: 999999999 }] as any
             }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { blSlope: 0, rcSlope: 1, bhSlope: 1 } as any })
    );
    assertEqual(res.reason, "BREAKOUT_LONG_SKIPPED_NO_RETEST", "Test 4: Skip long on pump");
}

// 5. 상단 돌파 후 retest 지지 시 long ENTER
function test5() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 51100, atr: 500, emaGap: 10, rangeCenterSlope: 1 }
            }),
            buildJudgment({ trendPhase: "UP", metadata: { blSlope: 0, rcSlope: 1, bhSlope: 1 } as any })
        );
    }
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 51005, atr: 500, emaGap: 10, rangeCenterSlope: 1,
                candles: [{ high: 51100, low: 51005, ts: 999999999 }] as any
             }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { blSlope: 0, rcSlope: 1, bhSlope: 1 } as any })
    );
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-5`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 51300, atr: 500, emaGap: 10, rangeCenterSlope: 1,
                candles: [{ high: 51200, low: 51005, ts: 999999999 }] as any
             }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { blSlope: 0, rcSlope: 1, bhSlope: 1 } as any })
    );
    assertEqual(res.reason, "BREAKOUT_RETEST_LONG_CONFIRMED", "Test 5: Long ENTER on retest pass");
}

// 6. 상단 하락 반전 확인 시 기존 short 유지
function test6() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51100, atr: 500, emaGap: 10, rangeCenterSlope: 1 }
            }),
            buildJudgment({ trendPhase: "UP", metadata: { blSlope: 0, rcSlope: 1, bhSlope: 1 } as any })
        );
    }
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 50500, atr: 500, emaGap: 10, rangeCenterSlope: 1,
                candles: [{ high: 51050, low: 50500, ts: 999999999 }] as any
             }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { blSlope: 0, rcSlope: 1, bhSlope: 1, reversal_confirmed: true } as any })
    );
    assertEqual(res.reason, "Upper edge reversal identified by price reaction", "Test 6: Short entry preserved on reversal");
}

// 7. 지속 하락 시 long 대기 교착 해소 및 Continuation Watch 상태 진입
function test7() {
    clearState();
    let res: any;
    for (let i = 1; i <= 2; i++) {
        res = executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.05, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
        );
        assertEqual(res.reason, "V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND", `Test 7: Cycle ${i} is WAITING`);
    }
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-3`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.05, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
    );
    assertEqual(res.reason, "RANGE_BREAKDOWN_CONTINUATION_WATCH", "Test 7: Switches to WATCH on cycle 3");
}

// 8. 지속 상승 시 short 대기 교착 해소 및 Continuation Watch 상태 진입
function test8() {
    clearState();
    let res: any;
    for (let i = 1; i <= 2; i++) {
        res = executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.95, lastPrice: 51100, atr: 500, emaGap: 10, rangeCenterSlope: 1 }
            }),
            buildJudgment({ trendPhase: "UP", metadata: { blSlope: 0, rcSlope: 1, bhSlope: 1 } as any })
        );
        assertEqual(res.reason, "V2_RANGE_UPPER_SHORT_WAITING_DUE_TO_UP_TREND", `Test 8: Cycle ${i} is WAITING`);
    }
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-3`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.95, lastPrice: 51100, atr: 500, emaGap: 10, rangeCenterSlope: 1 }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { blSlope: 0, rcSlope: 1, bhSlope: 1 } as any })
    );
    assertEqual(res.reason, "RANGE_BREAKOUT_CONTINUATION_WATCH", "Test 8: Switches to WATCH on cycle 3");
}

// 9. 같은 runCycleId 중복 호출 시 cycle count 증가 금지
function test9() {
    clearState();
    let res: any;
    for (let i = 1; i <= 4; i++) {
        res = executeRangeRegime(
            buildInput({
                run_cycle_id: `c-1`, // All same ID
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.05, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
        );
    }
    assertEqual(res.reason, "V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND", "Test 9: Stay in WAITING due to deduplication");
}

// 10. diagnostic/authoritative 이중 평가 시 1회만 증가
function test10() {
    clearState();
    let res: any;
    for (let i = 1; i <= 2; i++) {
        // Diagnostic
        executeRangeRegime(
            buildInput({
                evaluationMode: "diagnostic",
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.05, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
        );
        // Authoritative
        res = executeRangeRegime(
            buildInput({
                evaluationMode: "authoritative",
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.05, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
        );
    }
    assertEqual(res.reason, "V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND", "Test 10: Cycle 2 is still WAITING");
    // 3rd authoritative
    res = executeRangeRegime(
        buildInput({
            evaluationMode: "authoritative",
            run_cycle_id: `c-3`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.05, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
    );
    assertEqual(res.reason, "RANGE_BREAKDOWN_CONTINUATION_WATCH", "Test 10: Cycle 3 flips to WATCH");
}

// 11. Watch 이후 boxLow/boxHigh가 이동해도 고정 경계 유지
function test11() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
        );
    }
    // Now in WATCH. Move boxLow drastically.
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 48800, boxHigh: 50800, boxPos: 0.1, lastPrice: 48995, atr: 500, emaGap: -10, rangeCenterSlope: -1,
                candles: [{ high: 48995, low: 48900, ts: 999999999 }] as any
             }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
    );
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-5`,
            snapshot: { ...buildInput().snapshot, boxLow: 48800, boxHigh: 50800, boxPos: 0.1, lastPrice: 48700, atr: 500, emaGap: -10, rangeCenterSlope: -1,
                candles: [{ high: 48995, low: 48700, ts: 999999999 }] as any
             }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
    );
    assertEqual(res.reason, "BREAKDOWN_RETEST_SHORT_CONFIRMED", "Test 11: Maintained old 49000 boundary for retest");
}

// 12. Watch 만료 후 상태 초기화 (10 cycle / 10분 등)
function test12() {
    clearState();
    for (let i = 1; i <= 3; i++) {
        executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
        );
    }
    let res: any;
    for (let i = 4; i <= 14; i++) {
        res = executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1, candles: [{high:48950, low:48800, ts: i}] as any }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
        );
    }
    // Cycle 14 means 11th cycle since watch started. Should reset and be back at DEADLOCK_COUNTING cycle 1, meaning WAITING.
    assertEqual(res.reason, "V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND", "Test 12: Expiration resets state to WAITING");
}

// 13. 반대 방향 전환 시 상태 초기화
function test13() {
    clearState();
    for (let i = 1; i <= 3; i++) {
        executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
        );
    }
    let res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48900, atr: 500, emaGap: 10, rangeCenterSlope: 1 }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { blSlope: 1, rcSlope: 1, bhSlope: 1 } as any })
    );
    // State reset, returns to initial WAITING based on conditions, but trend is UP, lower edge. Wait! UP trend at lower edge = valid long.
    assertEqual(res.reason, "Lower edge reached; awaiting touch and reaction", "Test 13: Reset on opposite trend");
}

// 14. Retest ENTER 시 stopPrice/invalidationPx 정상 생성
function test14() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        executeRangeRegime(
            buildInput({
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 48900, atr: 500, emaGap: -10, rangeCenterSlope: -1 }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
        );
    }
    executeRangeRegime(
        buildInput({
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 48995, atr: 500, emaGap: -10, rangeCenterSlope: -1, candles: [{ high: 48995, low: 48900, ts: 999999999 }] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
    );
    res = executeRangeRegime(
        buildInput({
            run_cycle_id: `c-5`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, lastPrice: 48700, atr: 500, emaGap: -10, rangeCenterSlope: -1, candles: [{ high: 48995, low: 48800, ts: 999999999 }] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: 0 } as any })
    );
    assertEqual(res.stopPrice, 49000 * 1.002, "Test 14: stopPrice is watchBoundary * 1.002");
    assertEqual(res.invalidationPx, 49000 * 1.002, "Test 14: invalidationPx is watchBoundary * 1.002");
}

// 15. UP trend deadlock watch triggers
function test15() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                symbol: "ETHUSDT" as any,
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 1800, boxHigh: 2000, boxPos: 0.9, lastPrice: 2010, atr: 50, emaGap: 0.00025, rangeCenterSlope: 1, candles: [{high:2010, low:1900, ts: i}] as any }
            }),
            buildJudgment({ trendPhase: "UP", metadata: { blSlope: 1, rcSlope: 1, bhSlope: 1 } as any })
        );
    }
    assertEqual(res.reason, "RANGE_BREAKOUT_CONTINUATION_WATCH", "Test 15: Up deadlock triggers continuation watch");
}

// 16. DOWN trend deadlock watch triggers
function test16() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                symbol: "BTCUSDT" as any,
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48600, atr: 500, emaGap: -0.00025, rangeCenterSlope: -1, candles: [{high:49000, low:48600, ts: i}] as any }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1, bhSlope: -1 } as any })
        );
    }
    assertEqual(res.reason, "RANGE_BREAKDOWN_CONTINUATION_WATCH", "Test 16: Down deadlock triggers continuation watch");
}

// 17. UP trend negative (bhSlope = 0)
function test17() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                symbol: "ETHUSDT" as any,
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 1800, boxHigh: 2000, boxPos: 0.9, lastPrice: 2050, atr: 50, emaGap: 0.00025, rangeCenterSlope: 1, candles: [{high:2050, low:1900, ts: i}] as any }
            }),
            buildJudgment({ trendPhase: "UP", metadata: { blSlope: 1, rcSlope: 1, bhSlope: 0 } as any })
        );
    }
    assertEqual(res.reason, "BREAKOUT_LONG_SKIPPED_NO_RETEST", "Test 17: Up deadlock enters watch due to rcSlope>0 (relaxed)");
}

// 18. DOWN trend negative (rcSlope = 0)
function test18() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                symbol: "BTCUSDT" as any,
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, rangeCenterSlope: 0, candles: [{high:49000, low:48500, ts: i}] as any }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: 0, bhSlope: -1 } as any })
        );
    }
    assertEqual(res.reason, "BREAKDOWN_SHORT_SKIPPED_NO_RETEST", "Test 18: Down deadlock enters watch due to blSlope<0 (relaxed)");
}

// 18.5 Both opposite
function test18_5() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                symbol: "BTCUSDT" as any,
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, rangeCenterSlope: 1, candles: [{high:49000, low:48500, ts: i}] as any }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: 1, rcSlope: 1, bhSlope: 1 } as any })
        );
    }
    assertEqual(res.reason, "V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND", "Test 18.5: Down deadlock blocked because both slopes opposite");
}

function test19() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                symbol: "BTCUSDT" as any,
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, boxHighSlope: 1, rangeCenterSlope: 1, candles: [{high:51500, low:51000, ts: i}] as any }
            }),
            buildJudgment({ trendPhase: "UP", metadata: {} as any })
        );
    }
    assertEqual(res.reason, "RANGE_BREAKOUT_CONTINUATION_WATCH", "Test 19: Up deadlock entered via snapshot fallback");
}

function test20() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                symbol: "BTCUSDT" as any,
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, boxLowSlope: -1, rangeCenterSlope: -1, candles: [{high:49000, low:48500, ts: i}] as any }
            }),
            buildJudgment({ trendPhase: "DOWN", metadata: {} as any })
        );
    }
    assertEqual(res.reason, "BREAKDOWN_SHORT_SKIPPED_NO_RETEST", "Test 20: Down deadlock entered via snapshot fallback");
}

function test21() {
    clearState();
    let res: any;
    for (let i = 1; i <= 3; i++) {
        res = executeRangeRegime(
            buildInput({
                symbol: "BTCUSDT" as any,
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, ts: i}] as any }
            }),
            buildJudgment({ trendPhase: "UP", metadata: {} as any })
        );
    }
    assertEqual(res.reason, "V2_RANGE_UPPER_SHORT_WAITING_DUE_TO_UP_TREND", "Test 21: Up deadlock skipped due to missing slopes on both sides");
}

function test22() {
    clearState();
    const origWarn = console.warn;
    let proofCount = 0;
    console.warn = (msg) => {
        if (typeof msg === 'string' && msg.includes("V2_RANGE_DEADLOCK_CONDITION_BREAKDOWN_PROOF")) proofCount++;
    };

    // Same cycle ID called 2 times
    for (let i = 1; i <= 2; i++) {
        executeRangeRegime(
            buildInput({
                symbol: "BTCUSDT" as any,
                run_cycle_id: `c-1`,
                evaluationMode: "authoritative",
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, ts: i}] as any }
            }),
            buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
        );
    }
    assertEqual(proofCount, 1, "Test 22: Dedupe proof count should be exactly 1 for same cycle ID");

    // Next cycle ID called 1 time
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-2`,
            evaluationMode: "authoritative",
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, ts: 3}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    assertEqual(proofCount, 2, "Test 22: Dedupe proof count should be 2 for next cycle ID");
    
    // diagnostic evaluation
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-3`,
            evaluationMode: "diagnostic",
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, ts: 4}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    assertEqual(proofCount, 2, "Test 22: Dedupe proof count should remain 2 for diagnostic evaluation");

    console.warn = origWarn;
}

// 23. Verify Up deadlock fixed boundary & internal states
function test23() {
    clearState();
    let res: any;
    
    // Cycle 1: DEADLOCK_COUNTING initially starts. 
    // countBoundaryPrice should be locked to 51000 (prevHigh / current fallback)
    res = executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-1`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    let state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "DEADLOCK_COUNTING", "Test 23: Phase should be DEADLOCK_COUNTING");
    assertEqual(state?.countBoundaryPrice, 51000, "Test 23: countBoundaryPrice should be 51000");

    // Cycle 2: Dynamic boxHigh increases to 51200. Still breaking 51000.
    res = executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-2`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51200, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}, {high:51500, low:51000, close:51500, ts: 2}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "DEADLOCK_COUNTING", "Test 23: Phase should remain DEADLOCK_COUNTING");
    assertEqual(state?.countBoundaryPrice, 51000, "Test 23: countBoundaryPrice should remain 51000 despite dynamic boxHigh");

    // Cycle 3: Dynamic boxHigh increases to 51400. Still breaking 51000. Price is 51300 (which is < 51400 but > 51000)
    res = executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-3`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51400, boxPos: 0.9, lastPrice: 51300, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}, {high:51500, low:51000, close:51500, ts: 2}, {high:51300, low:51000, close:51300, ts: 3}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "CONTINUATION_WATCH", "Test 23: Should enter CONTINUATION_WATCH since price 51300 > countBoundaryPrice 51000");
    assertEqual(state?.watchBoundaryPrice, 51000, "Test 23: watchBoundaryPrice should be set to 51000 directly from countBoundaryPrice");
    
    // Cycle 4: Retest - price drops to 50000. Deadlock conditions fail, but Watch should hold.
    res = executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51400, boxPos: 0.5, lastPrice: 50000, atr: 500, emaGap: -0.00025, candles: [{high:51500, low:51000, close:51500, ts: 2}, {high:51300, low:51000, close:51300, ts: 3}, {high:51000, low:49000, close:50000, ts: 4}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: -1, rcSlope: -1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "CONTINUATION_WATCH", "Test 23: Watch should be maintained even if deadlock conditions dynamically fail during retest");
}

// 24. Verify Down deadlock fixed boundary & internal states
function test24() {
    clearState();
    let res: any;
    
    // Cycle 1: DEADLOCK_COUNTING initially starts. 
    // countBoundaryPrice should be locked to 49000
    res = executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-1`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, candles: [{high:49000, low:48500, close:48500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1 } as any })
    );
    let state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "DEADLOCK_COUNTING", "Test 24: Phase should be DEADLOCK_COUNTING");
    assertEqual(state?.countBoundaryPrice, 49000, "Test 24: countBoundaryPrice should be 49000");

    // Cycle 2: Dynamic boxLow decreases to 48800
    res = executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-2`,
            snapshot: { ...buildInput().snapshot, boxLow: 48800, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, candles: [{high:49000, low:48500, close:48500, ts: 1}, {high:49000, low:48500, close:48500, ts: 2}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.countBoundaryPrice, 49000, "Test 24: countBoundaryPrice should remain 49000");

    // Cycle 3: Dynamic boxLow decreases to 48600. Price is 48700 (which is > 48600 but < 49000)
    res = executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-3`,
            snapshot: { ...buildInput().snapshot, boxLow: 48600, boxHigh: 51000, boxPos: 0.1, lastPrice: 48700, atr: 500, emaGap: -0.00025, candles: [{high:49000, low:48500, close:48500, ts: 1}, {high:49000, low:48500, close:48500, ts: 2}, {high:49000, low:48700, close:48700, ts: 3}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "CONTINUATION_WATCH", "Test 24: Should enter CONTINUATION_WATCH since price 48700 < countBoundaryPrice 49000");
    assertEqual(state?.watchBoundaryPrice, 49000, "Test 24: watchBoundaryPrice should be set to 49000 directly from countBoundaryPrice");
}

// 25. Same candle timestamp boxHigh 51000 -> 51200 -> 51400 and next candle promotion
function test25() {
    clearState();
    let res: any;
    
    // Cycle 1: ts=1, boxHigh=51000
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-1`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    let state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.lastObservedBoxHigh, 51000, "Test 25: lastObservedBoxHigh should be 51000");

    // Cycle 2: ts=1 (same), boxHigh=51200
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-2`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51200, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.lastObservedBoxHigh, 51200, "Test 25: lastObservedBoxHigh should update to 51200");

    // Cycle 3: ts=1 (same), boxHigh=51400
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-3`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51400, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.lastObservedBoxHigh, 51400, "Test 25: lastObservedBoxHigh should update to 51400");
    assertEqual(state?.previousConfirmedBoxHigh, null, "Test 25: previousConfirmedBoxHigh should still be null (ts not changed)");

    // Cycle 4: ts=2 (new candle), boxHigh=51500
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51500, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}, {high:51500, low:51000, close:51500, ts: 2}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.previousConfirmedBoxHigh, 51400, "Test 25: previousConfirmedBoxHigh should be promoted to 51400 (the final value of ts=1)");
}

// 26. Same candle timestamp boxLow 49000 -> 48800 -> 48600 and next candle promotion
function test26() {
    clearState();
    let res: any;
    
    // Cycle 1: ts=1, boxLow=49000
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-1`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, candles: [{high:49000, low:48500, close:48500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1 } as any })
    );
    let state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.lastObservedBoxLow, 49000, "Test 26: lastObservedBoxLow should be 49000");

    // Cycle 2: ts=1 (same), boxLow=48800
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-2`,
            snapshot: { ...buildInput().snapshot, boxLow: 48800, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, candles: [{high:49000, low:48500, close:48500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.lastObservedBoxLow, 48800, "Test 26: lastObservedBoxLow should update to 48800");

    // Cycle 3: ts=1 (same), boxLow=48600
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-3`,
            snapshot: { ...buildInput().snapshot, boxLow: 48600, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, candles: [{high:49000, low:48500, close:48500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.lastObservedBoxLow, 48600, "Test 26: lastObservedBoxLow should update to 48600");
    assertEqual(state?.previousConfirmedBoxLow, null, "Test 26: previousConfirmedBoxLow should still be null");

    // Cycle 4: ts=2 (new candle), boxLow=48500
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 48500, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, candles: [{high:49000, low:48500, close:48500, ts: 1}, {high:49000, low:48500, close:48500, ts: 2}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.previousConfirmedBoxLow, 48600, "Test 26: previousConfirmedBoxLow should be promoted to 48600");
}

// 27. Direction Switch (Down -> Up) during counting
function test27() {
    clearState();
    let res: any;
    
    // Cycle 1: DOWN counting starts
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-1`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, candles: [{high:49000, low:48500, close:48500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1 } as any })
    );
    let state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "DEADLOCK_COUNTING", "Test 27: Down count started");
    assertEqual(state?.direction, "down", "Test 27: Direction is down");
    assertEqual(state?.countBoundaryPrice, 49000, "Test 27: countBoundaryPrice 49000");

    // Cycle 2: Sudden trendPhase UP, price breaks 51000 (which is current boxHigh)
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-2`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:49000, low:48500, close:48500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    // State should reset to IDLE, then in the same cycle detect Up Deadlock, switching to DEADLOCK_COUNTING with UP.
    assertEqual(state?.phase, "DEADLOCK_COUNTING", "Test 27: Should flip and count UP");
    assertEqual(state?.direction, "up", "Test 27: Direction flipped to up");
    assertEqual(state?.countBoundaryPrice, 51000, "Test 27: countBoundaryPrice should be for UP (51000), not old DOWN boundary");
}

// 28. Direction Switch (Up -> Down) during counting
function test28() {
    clearState();
    let res: any;
    
    // Cycle 1: UP counting starts
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-1`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    let state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.direction, "up", "Test 28: Direction is up");

    // Cycle 2: Sudden trendPhase DOWN, price breaks 49000
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-2`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.direction, "down", "Test 28: Direction flipped to down");
    assertEqual(state?.countBoundaryPrice, 49000, "Test 28: countBoundaryPrice should be for DOWN (49000)");
}

// 29. currentStage > 0 prevents starting DEADLOCK_COUNTING
function test29() {
    clearState();
    let res: any;
    
    // Cycle 1: Position is open (currentStage=1), deadlock condition met
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-1`,
            state: { currentPositions: [{ symbol: "BTCUSDT", entryStage: 1 }] } as any,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    let state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "IDLE", "Test 29: Should stay IDLE while position is open");
    
    // Cycle 2: Position closed (currentStage=0), deadlock condition still met
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-2`,
            state: { currentPositions: [] } as any, // Position closed
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "DEADLOCK_COUNTING", "Test 29: Should start DEADLOCK_COUNTING once position is closed");
}



// 30. Slope independent DEADLOCK_COUNTING
function test30() {
    clearState();
    
    // Test A - UP breakout, slope initially opposite
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-1`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: -1, rcSlope: -1 } as any })
    );
    let state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "DEADLOCK_COUNTING", "Test 30A: Should start DEADLOCK_COUNTING despite negative slope");
    assertEqual(state?.consecutiveCycles, 1, "Test 30A: consecutiveCycles = 1");

    // Test B - A 이후 slope 정렬
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-2`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 2}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: -1, rcSlope: -1 } as any })
    );
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-3`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 3}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: -1, rcSlope: -1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "DEADLOCK_COUNTING", "Test 30B (pre): Still counting because slope is not aligned");
    
    // Now align slope
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 4}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "CONTINUATION_WATCH", "Test 30B: Promoted to WATCH because slope is now aligned");
    assertEqual(state?.watchBoundaryPrice, 51000, "Test 30B: watchBoundaryPrice correctly captured");

    // Test C - DOWN 대칭
    clearState();
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-1`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, candles: [{high:48500, low:48000, close:48500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: 1, rcSlope: 1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "DEADLOCK_COUNTING", "Test 30C (pre): DOWN DEADLOCK_COUNTING started despite positive slope");
    
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-2`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, candles: [{high:48500, low:48000, close:48500, ts: 2}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: 1, rcSlope: 1 } as any })
    );
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-3`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, candles: [{high:48500, low:48000, close:48500, ts: 3}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: 1, rcSlope: 1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "DEADLOCK_COUNTING", "Test 30C (mid): Still counting");
    
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-4`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.1, lastPrice: 48500, atr: 500, emaGap: -0.00025, candles: [{high:48500, low:48000, close:48500, ts: 4}] as any }
        }),
        buildJudgment({ trendPhase: "DOWN", metadata: { blSlope: -1, rcSlope: -1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "CONTINUATION_WATCH", "Test 30C (end): Promoted to WATCH");

    // Test D - slope 끝까지 반대
    clearState();
    let promotedToWatch = false;
    for (let i = 1; i <= 11; i++) {
        executeRangeRegime(
            buildInput({
                symbol: "BTCUSDT" as any,
                run_cycle_id: `c-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: i}] as any }
            }),
            buildJudgment({ trendPhase: "UP", metadata: { bhSlope: -1, rcSlope: -1 } as any })
        );
        state = rangeContinuationStateMap.get("BTCUSDT");
        if (state?.phase === "CONTINUATION_WATCH") promotedToWatch = true;
        if (i <= 10) {
            assertEqual(state?.phase, "DEADLOCK_COUNTING", `Test 30D (cycle ${i}): Should be DEADLOCK_COUNTING`);
        }
    }
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(promotedToWatch, false, "Test 30D: Never promotes to WATCH if slope is never aligned");
    assertEqual(state?.phase, "IDLE", "Test 30D: Expiry resets to IDLE after MAX cycles");
    assertEqual(state?.countBoundaryPrice, null, "Test 30D: Expiry resets countBoundaryPrice");
    assertEqual(state?.countBoundarySource, null, "Test 30D: Expiry resets countBoundarySource");
    assertEqual(state?.consecutiveCycles, 0, "Test 30D: Expiry resets consecutiveCycles");

    // Test D2 - expiry 직전 마지막 허용 cycle에서 slope 정상 정렬
    clearState();
    promotedToWatch = false;
    for (let i = 1; i <= 10; i++) {
        const isLastCycle = (i === 10);
        executeRangeRegime(
            buildInput({
                symbol: "BTCUSDT" as any,
                run_cycle_id: `c-d2-${i}`,
                snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: i}] as any }
            }),
            buildJudgment({ trendPhase: "UP", metadata: { bhSlope: isLastCycle ? 1 : -1, rcSlope: isLastCycle ? 1 : -1 } as any })
        );
        state = rangeContinuationStateMap.get("BTCUSDT");
        if (state?.phase === "CONTINUATION_WATCH") promotedToWatch = true;
    }
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(promotedToWatch, true, "Test 30D2: Promotes to WATCH successfully on the 10th cycle");
    assertEqual(state?.phase, "CONTINUATION_WATCH", "Test 30D2: Final state is WATCH");
    assertEqual(state?.watchBoundaryPrice, 51000, "Test 30D2: Watch boundary is correct");

    // Test E - no breakout
    clearState();
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-1`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 50000, atr: 500, emaGap: 0.00025, candles: [{high:50000, low:49000, close:50000, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: 1, rcSlope: 1 } as any })
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "IDLE", "Test 30E: No breakout means IDLE");

    // Test F - reversal confirmed
    clearState();
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-1`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 1}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: -1, rcSlope: -1 } as any })
    );
    executeRangeRegime(
        buildInput({
            symbol: "BTCUSDT" as any,
            run_cycle_id: `c-2`,
            snapshot: { ...buildInput().snapshot, boxLow: 49000, boxHigh: 51000, boxPos: 0.9, lastPrice: 51500, atr: 500, emaGap: 0.00025, candles: [{high:51500, low:51000, close:51500, ts: 2}] as any }
        }),
        buildJudgment({ trendPhase: "UP", metadata: { bhSlope: -1, rcSlope: -1 } as any, reversalConfirmed: true } as any)
    );
    state = rangeContinuationStateMap.get("BTCUSDT");
    assertEqual(state?.phase, "IDLE", "Test 30F: reversalConfirmed resets to IDLE");
}

test1();
test2();
test3();
test4();
test5();
test6();
test7();
test8();
test9();
test10();
test11();
test12();
test13();
test14();
test15();
test16();
test17();
test18();
test18_5();
test19();
test20();
test21();
test22();
test23();
test24();
test25();
test26();
test27();
test28();
test29();
test30();

console.log(`Passed ${passed} out of ${total} tests.`);
if (passed !== total) process.exit(1);
