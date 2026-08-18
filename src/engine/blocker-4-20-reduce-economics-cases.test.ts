import {
    evaluatePartialReduceLimit,
    isFeeEconomicsBypassReason,
    isProtectivePartialReason,
    MAX_PROTECTIVE_PARTIAL_REDUCE_COUNT,
    MAX_ROUTINE_DEFENSIVE_REDUCE_COUNT
} from "../engine-v2/execution/reduce-economics";
import type { PaperOpenPositionRecord } from "../models/types";

function assertEq<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function fakeOpen(): PaperOpenPositionRecord {
    return {
        symbol: "ETHUSDT",
        side: "long",
        openedAt: Date.now(),
        entryPrice: 1900,
        sizeUsd: 100,
        leverage: 10,
        sourceSignal: "blocker_4_20_test",
        sourceRunPath: "blocker_4_20_test",
        regimeAtEntry: "RANGE",
        strategyVersion: "paper-v2"
    } as any;
}

function runAll(): void {
    console.info("=== RUNNING BLOCKER 4-20 REDUCE ECONOMICS REGRESSIONS ===");

    assertEq(MAX_ROUTINE_DEFENSIVE_REDUCE_COUNT, 1, "routine PNL/transition defensive trim cap");
    assertEq(MAX_PROTECTIVE_PARTIAL_REDUCE_COUNT, 2, "genuine shock defensive cap preserved");

    assertEq(isProtectivePartialReason("PNL_STOP_PROTECT"), true, "PNL stop reduce is counted as protective");
    assertEq(isProtectivePartialReason("TRANSITION_REDUCE_ON_CONFLICT"), true, "transition reduce is counted as protective");
    assertEq(isProtectivePartialReason("RANGE_PARTIAL_AT_OPPOSITE_EDGE"), false, "range profit partial is not defensive");
    assertEq(isFeeEconomicsBypassReason("PNL_STOP_PROTECT"), false, "PNL stop cannot bypass fee economics");

    const repeatPnl = evaluatePartialReduceLimit({
        open: fakeOpen(),
        reason: "PNL_STOP_PROTECT",
        protectivePartialCount: 1,
        urgency: "high",
        invalidationImminent: false
    });
    assertEq(repeatPnl.submitAllowed, false, "second PNL defensive reduce blocked");
    assertEq(repeatPnl.fallbackAction, "HOLD", "high urgency alone cannot escalate blocked PNL trim to full exit");

    const confirmedInvalidation = evaluatePartialReduceLimit({
        open: fakeOpen(),
        reason: "PNL_STOP_PROTECT",
        protectivePartialCount: 1,
        urgency: "high",
        invalidationImminent: true
    });
    assertEq(confirmedInvalidation.submitAllowed, false, "repeat trim still blocked on confirmed invalidation");
    assertEq(confirmedInvalidation.fallbackAction, "FULL_EXIT", "confirmed imminent invalidation may full exit");

    const shockSecond = evaluatePartialReduceLimit({
        open: fakeOpen(),
        reason: "SHOCK_PROTECTIVE_REDUCE",
        protectivePartialCount: 1,
        urgency: "high",
        invalidationImminent: false
    });
    assertEq(shockSecond.submitAllowed, true, "second genuine shock defensive trim remains available");

    console.info("=== ALL BLOCKER 4-20 REDUCE ECONOMICS REGRESSIONS PASSED ===");
}

runAll();
