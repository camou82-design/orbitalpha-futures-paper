/**
 * BLOCKER 3-2.1 — Ops-watch protective visibility grace leakage fix
 *
 * P1 rejected submit                  → HARD_BLOCK
 * P2 accepted + 5 sec inventory miss  → DEFER
 * P3 accepted + 20 sec inventory miss → DEFER
 * P4 accepted + visible at 25 sec     → PASS
 * P5 accepted + missing after 30 sec  → HARD_BLOCK
 * P6 PENDING ownership + no submit evidence → no defer (masking forbidden)
 * P7 process restart inside grace     → DEFER
 * P8 BTC/ETH symmetry                 → PASS
 */

import type { PaperOpenPositionRecord } from "../models/types";
import {
    PROTECTIVE_VISIBILITY_GRACE_MS,
    evaluateOpsWatchProtectiveScanVerdict,
    hasAcceptedProtectiveSubmitEvidence,
} from "../engine-v2/execution/protective-order-state";

function assertEq<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertTrue(value: boolean, label: string): void {
    if (!value) throw new Error(`[FAIL] ${label}: expected true`);
}

function assertFalse(value: boolean, label: string): void {
    if (value) throw new Error(`[FAIL] ${label}: expected false`);
}

function pass(label: string, detail?: unknown): void {
    console.info(JSON.stringify({ status: "PASS", label, ...(detail !== undefined ? { detail } : {}) }));
}

const SUBMIT_AT = 1_786_713_504_513;
const SL_ALGO = "eth_sl_algo_live_001";
const TP_ALGO = "eth_tp_algo_live_002";

function makeLedger(input: Partial<PaperOpenPositionRecord>): PaperOpenPositionRecord {
    return {
        openedAt: SUBMIT_AT,
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 3000,
        leverage: 5,
        sizeUsd: 100,
        stopPrice: 2900,
        targetPrice1: 3200,
        reconcileState: "PENDING",
        entryProtectionUntil: SUBMIT_AT + 120_000,
        protectiveVisibilityGraceDeadlineMs: SUBMIT_AT + PROTECTIVE_VISIBILITY_GRACE_MS,
        protectiveSlAlgoId: SL_ALGO,
        protectiveStopAlgoId: SL_ALGO,
        protectiveTpAlgoId: TP_ALGO,
        isProtectiveStopRegistered: true,
        isTakeProfitRegistered: true,
        isProtectionFailed: false,
        ...input,
    } as PaperOpenPositionRecord;
}

function evalAt(ageMs: number, ledger: PaperOpenPositionRecord | null, inventoryVisible = false) {
    return evaluateOpsWatchProtectiveScanVerdict({
        nowMs: SUBMIT_AT + ageMs,
        ledger,
        reduceOnlyProtectiveFound: inventoryVisible,
        matchingProtectivePendingCount: inventoryVisible ? 1 : 0,
        scanClean: true,
        tpRequired: true,
    });
}

function testP1(): void {
    const r = evalAt(
        5_000,
        makeLedger({
            isProtectionFailed: true,
            protectiveSlAlgoId: undefined,
            protectiveStopAlgoId: undefined,
            protectiveTpAlgoId: undefined,
            protectiveVisibilityGraceDeadlineMs: undefined,
            isProtectiveStopRegistered: false,
            isTakeProfitRegistered: false,
        })
    );
    assertEq(r.verdict, "HARD_BLOCK", "P1 verdict");
    assertTrue(r.shouldBlockSymbol, "P1 should block");
    assertFalse(r.opsWatchVisibilityGraceApplied, "P1 no grace");
    pass("P1_REJECTED_SUBMIT_HARD_BLOCK");
}

function testP2(): void {
    const r = evalAt(5_000, makeLedger({}));
    assertEq(r.verdict, "DEFER", "P2 verdict");
    assertTrue(r.opsWatchVisibilityGraceApplied, "P2 grace applied");
    assertFalse(r.shouldEmitPendingZeroFault, "P2 no pending-zero fault");
    pass("P2_ACCEPTED_5S_MISS_DEFER");
}

function testP3(): void {
    const r = evalAt(20_000, makeLedger({}));
    assertEq(r.verdict, "DEFER", "P3 verdict");
    assertTrue(r.opsWatchVisibilityGraceApplied, "P3 grace applied");
    pass("P3_ACCEPTED_20S_MISS_DEFER");
}

function testP4(): void {
    const r = evalAt(25_000, makeLedger({}), true);
    assertEq(r.verdict, "PASS", "P4 verdict");
    assertFalse(r.shouldBlockSymbol, "P4 no block");
    pass("P4_VISIBLE_AT_25S_PASS");
}

function testP5(): void {
    const r = evalAt(30_001, makeLedger({}));
    assertEq(r.verdict, "HARD_BLOCK", "P5 verdict");
    assertTrue(r.shouldEmitOrderFault, "P5 order fault");
    assertTrue(r.shouldEmitHardBlockDetected, "P5 hard block detected");
    assertFalse(r.opsWatchVisibilityGraceApplied, "P5 grace expired");
    pass("P5_MISSING_AFTER_30S_HARD_BLOCK");
}

function testP6(): void {
    const r = evalAt(
        18_659,
        makeLedger({
            reconcileState: "PENDING",
            entryProtectionUntil: SUBMIT_AT + 120_000,
            isProtectiveStopRegistered: true,
            isTakeProfitRegistered: true,
            protectiveSlAlgoId: undefined,
            protectiveStopAlgoId: undefined,
            protectiveTpAlgoId: undefined,
            protectiveVisibilityGraceDeadlineMs: undefined,
        })
    );
    assertEq(r.verdict, "HARD_BLOCK", "P6 verdict");
    assertFalse(r.opsWatchVisibilityGraceApplied, "P6 must not defer on PENDING alone");
    assertFalse(
        hasAcceptedProtectiveSubmitEvidence(
            makeLedger({
                isProtectiveStopRegistered: true,
                protectiveSlAlgoId: undefined,
                protectiveStopAlgoId: undefined,
                protectiveTpAlgoId: undefined,
            }),
            true
        ),
        "P6 registered flags without algoId not accepted evidence"
    );
    pass("P6_PENDING_NO_SUBMIT_EVIDENCE_NO_DEFER");
}

function testP7(): void {
    const r = evalAt(
        15_000,
        makeLedger({
            protectiveVisibilityGraceDeadlineMs: SUBMIT_AT + PROTECTIVE_VISIBILITY_GRACE_MS,
        })
    );
    assertEq(r.verdict, "DEFER", "P7 verdict");
    assertTrue(r.opsWatchVisibilityGraceApplied, "P7 restart grace");
    pass("P7_RESTART_INSIDE_GRACE_DEFER");
}

function testSymmetry(symbol: string): void {
    const ledger = makeLedger({
        symbol,
        protectiveSlAlgoId: `${symbol}_sl`,
        protectiveStopAlgoId: `${symbol}_sl`,
        protectiveTpAlgoId: `${symbol}_tp`,
    });
    const defer = evalAt(10_000, ledger);
    const passVisible = evalAt(10_000, ledger, true);
    assertEq(defer.verdict, "DEFER", `${symbol} defer`);
    assertEq(passVisible.verdict, "PASS", `${symbol} pass`);
    pass(`P8_${symbol}_SYMMETRY`);
}

function testLiveIncidentReplay(): void {
    const openedAt = 1_786_713_504_513;
    const entryProtectionUntil = 1_786_713_624_513;
    const ageAtHardBlock = 18_659;
    const rOldBehaviorWouldBlock = evaluateOpsWatchProtectiveScanVerdict({
        nowMs: openedAt + ageAtHardBlock,
        ledger: makeLedger({
            openedAt,
            entryProtectionUntil,
            reconcileState: "PENDING",
            isProtectiveStopRegistered: true,
            isTakeProfitRegistered: true,
            isProtectionFailed: false,
            protectiveSlAlgoId: SL_ALGO,
            protectiveTpAlgoId: TP_ALGO,
            protectiveVisibilityGraceDeadlineMs: openedAt + PROTECTIVE_VISIBILITY_GRACE_MS,
        }),
        reduceOnlyProtectiveFound: false,
        matchingProtectivePendingCount: 0,
        scanClean: true,
        tpRequired: true,
    });
    assertEq(rOldBehaviorWouldBlock.verdict, "DEFER", "live incident replay should defer not hard block");
    assertFalse(rOldBehaviorWouldBlock.shouldEmitPendingZeroFault, "live incident no pending-zero fault");
    pass("LIVE_INCIDENT_18659MS_DEFER_NOT_HARD_BLOCK", { ageAtHardBlock, entryProtectionUntil });
}

async function run(): Promise<void> {
    testP1();
    testP2();
    testP3();
    testP4();
    testP5();
    testP6();
    testP7();
    testSymmetry("ETHUSDT");
    testSymmetry("BTCUSDT");
    testLiveIncidentReplay();

    console.info(
        JSON.stringify({
            event: "BLOCKER_3_2_1_OPS_WATCH_GRACE_CASES_PASS",
            cases: ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8_ETH", "P8_BTC", "LIVE_INCIDENT"],
            OPS_WATCH_VISIBILITY_GRACE_APPLIED: "YES",
            SUBMIT_REJECT_STILL_HARD_BLOCKS: "YES",
            ACCEPTED_WITHIN_30S_ZERO_INVENTORY_DEFERS: "YES",
            ACCEPTED_AFTER_30S_ZERO_INVENTORY_HARD_BLOCKS: "YES",
            REGISTERED_FLAG_REQUIRES_ACCEPTED_EVIDENCE: "YES",
            GRACE_DURATION_MS: PROTECTIVE_VISIBILITY_GRACE_MS,
            ENTRY_PROTECTION_UNTIL_NOT_SUBSTITUTED: "YES",
        })
    );
}

run().catch((err) => {
    console.error("[FAIL]", String(err));
    process.exitCode = 1;
});
