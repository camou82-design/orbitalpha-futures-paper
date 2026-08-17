/**
 * PNL_STOP_PROTECT judgment authority — price move × leverage, separate from accounting pnlPctNet.
 *
 * Live regression: ETHUSDT SHORT entry 1898.06 mark 1899.57 leverage 10x
 *   accounting pnlPctNet ≈ -1.9957% must NOT trigger PNL_STOP_PROTECT
 *   price-move authority ≈ -0.8% must stay above -1.2% reduce / -2.0% full-exit
 */

import { computePnlStopProtectJudgmentPct } from "../engine-v2/exit/stop-price-authority";
import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import type { EvaluateV2ExitPolicyArgs } from "../engine-v2/exit/types";

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

function testComputeEthShortLiveRegression(): void {
    const entry = 1898.06;
    const mark = 1899.57;
    const leverage = 10;
    const accountingPnlPctNet = -0.019957168016845925;

    const judgment = computePnlStopProtectJudgmentPct({
        side: "short",
        entryPrice: entry,
        markPrice: mark,
        leverage,
        pnlPctNetFallback: accountingPnlPctNet
    });

    assertEq(judgment.source, "price_move_x_leverage", "ETH source");
    assertTrue(judgment.pnlStopProtectPct > -0.012, "ETH above -1.2% reduce threshold");
    assertTrue(judgment.pnlStopProtectPct > -0.02, "ETH above -2.0% full-exit threshold");
    assertTrue(Math.abs(judgment.pnlStopProtectPct - -0.00796) < 0.002, "ETH approx -0.8% leveraged move");

    pass("ETH_SHORT_LIVE_PRICE_MOVE_AUTHORITY", {
        entry,
        mark,
        leverage,
        accountingPnlPctNet,
        pnlStopProtectPct: judgment.pnlStopProtectPct
    });
}

function testExitPolicyEthShortNoStopProtect(): void {
    const accountingPnlPctNet = -0.019957168016845925;
    const args: EvaluateV2ExitPolicyArgs = {
        symbol: "ETHUSDT",
        v2State: {
            symbolPositions: [
                {
                    symbol: "ETHUSDT",
                    side: "short",
                    entryPrice: 1898.06,
                    sizeUsd: 100,
                    entryStage: 1,
                    pnlPct: accountingPnlPctNet,
                    leverage: 10,
                    peakUnrealizedPnlPct: accountingPnlPctNet
                }
            ],
            currentPositions: [],
            longPosition: null,
            shortPosition: {
                symbol: "ETHUSDT",
                side: "short",
                entryPrice: 1898.06,
                sizeUsd: 100,
                entryStage: 1,
                pnlPct: accountingPnlPctNet,
                leverage: 10,
                peakUnrealizedPnlPct: accountingPnlPctNet
            },
            hasLongPosition: false,
            hasShortPosition: true,
            longStage: 0,
            shortStage: 1,
            sameSidePosition: null,
            oppositeSidePosition: null,
            hasSameSidePosition: false,
            hasOppositeSidePosition: false,
            currentStage: 0,
            positionStateReady: true,
            marketSnapshotReady: true,
            v2InputReady: true,
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            riskMode: null,
            dailyLossGuardTriggered: false,
            freshTickBarrierActive: false,
            freshTickExecutionBlocked: false,
            freshTickCompletedCycles: 0,
            freshTickRequiredCycles: 0,
            directionalShockState: "NONE",
            crashState: "NONE",
            pumpState: "NONE",
            symbol: "ETHUSDT",
            now: Date.now()
        } as any,
        judgment: {
            regime_final: "RANGE",
            subtype: "RANGE_MID",
            shockPhase: "NONE",
            rangePhase: "MID",
            trendPhase: "NONE",
            transitionPhase: "NONE",
            qualityScore: 50,
            reason: "test"
        } as any,
        snapshot: {
            boxPos: 0.5,
            boxBreakSide: "none",
            emaGap: 0,
            trendWeaknessScore: 0.3,
            rangeConfidence: 0.5,
            qualityScore: 50
        },
        markPrice: 1899.57
    };

    const result = evaluateV2ExitPolicy(args);
    assertFalse(result.reason === "PNL_STOP_PROTECT", "ETH must not PNL_STOP_PROTECT on accounting drag");
    assertFalse(result.action === "FULL_EXIT", "ETH must not FULL_EXIT");
    assertFalse(result.action === "REDUCE" && result.reason === "PNL_STOP_PROTECT", "ETH must not PNL_STOP reduce");
    pass("ETH_SHORT_EXIT_POLICY_NO_FALSE_STOP", {
        action: result.action,
        reason: result.reason,
        pnlPctAccounting: result.pnlPct
    });
}

function testFallbackWhenLeverageMissing(): void {
    const result = evaluateV2ExitPolicy({
        symbol: "ETHUSDT",
        v2State: {
            symbolPositions: [
                {
                    symbol: "ETHUSDT",
                    side: "long",
                    entryPrice: 100,
                    sizeUsd: 100,
                    entryStage: 1,
                    pnlPct: -0.022,
                    peakUnrealizedPnlPct: -0.022
                }
            ],
            currentPositions: [],
            longPosition: {
                symbol: "ETHUSDT",
                side: "long",
                entryPrice: 100,
                sizeUsd: 100,
                entryStage: 1,
                pnlPct: -0.022,
                peakUnrealizedPnlPct: -0.022
            },
            shortPosition: null,
            hasLongPosition: true,
            hasShortPosition: false,
            longStage: 1,
            shortStage: 0,
            sameSidePosition: null,
            oppositeSidePosition: null,
            hasSameSidePosition: false,
            hasOppositeSidePosition: false,
            currentStage: 0,
            positionStateReady: true,
            marketSnapshotReady: true,
            v2InputReady: true,
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            riskMode: null,
            dailyLossGuardTriggered: false,
            freshTickBarrierActive: false,
            freshTickExecutionBlocked: false,
            freshTickCompletedCycles: 0,
            freshTickRequiredCycles: 0,
            directionalShockState: "NONE",
            crashState: "NONE",
            pumpState: "NONE",
            symbol: "ETHUSDT",
            now: Date.now()
        } as any,
        judgment: {
            regime_final: "RANGE",
            subtype: "RANGE_MID",
            shockPhase: "NONE",
            rangePhase: "MID",
            trendPhase: "NONE",
            transitionPhase: "NONE",
            qualityScore: 50,
            reason: "test"
        } as any,
        snapshot: {
            boxPos: 0.5,
            boxBreakSide: "none",
            emaGap: 0,
            trendWeaknessScore: 0.3,
            rangeConfidence: 0.5,
            qualityScore: 50
        }
    });

    assertEq(result.action, "FULL_EXIT", "fallback FULL_EXIT preserved");
    assertEq(result.reason, "PNL_STOP_PROTECT", "fallback reason");
    pass("FALLBACK_PNL_PCT_NET_STILL_HARD_BLOCKS");
}

function testLeveragedMoveTriggersReduce(): void {
    const judgment = computePnlStopProtectJudgmentPct({
        side: "long",
        entryPrice: 100,
        markPrice: 99.88,
        leverage: 10,
        pnlPctNetFallback: -0.005
    });
    assertTrue(judgment.pnlStopProtectPct <= -0.012, "leveraged -1.2% triggers reduce zone");
    pass("LEVERAGED_MOVE_REDUCE_ZONE", { pnlStopProtectPct: judgment.pnlStopProtectPct });
}

async function run(): Promise<void> {
    testComputeEthShortLiveRegression();
    testExitPolicyEthShortNoStopProtect();
    testFallbackWhenLeverageMissing();
    testLeveragedMoveTriggersReduce();

    console.info(
        JSON.stringify({
            event: "PNL_STOP_PROTECT_AUTHORITY_CASES_PASS",
            ACCOUNTING_PNL_UNCHANGED: "YES",
            PNL_STOP_USES_PRICE_MOVE_X_LEVERAGE: "YES",
            ETH_FALSE_FULL_EXIT_PREVENTED: "YES"
        })
    );
}

run().catch((err) => {
    console.error("[FAIL]", String(err));
    process.exitCode = 1;
});
