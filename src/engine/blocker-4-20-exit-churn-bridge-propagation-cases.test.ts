/**
 * BLOCKER 4-20 C8 — Production bridge propagation for defensive reduce episode fields.
 *
 * Starts from PaperOpenPositionRecord (ledger/open), never injects lastReduceReason
 * directly onto EngineV2Position. Full path:
 *   PaperOpenPositionRecord → buildV2StateBridge → adaptV2Input → deriveV2StateAuthority → evaluateV2ExitPolicy
 */

import { buildV2StateBridge } from "./paper-engine";
import { adaptV2Input } from "../engine-v2";
import { deriveV2StateAuthority } from "../engine-v2/state/derive";
import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import type { PaperOpenPositionRecord } from "../models/types";
import type { V2BridgeState } from "../engine-v2/types";

function assertEq<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertTrue(value: boolean, label: string): void {
    if (!value) throw new Error(`[FAIL] ${label}: expected true`);
}

const mockConfig = {
    paperMaxOpenPositions: 3,
    paperReentryCooldownMs: 0,
    baseSizeUsd: 100,
    paperTakerFeeRate: 0.0005,
    paperFundingIntervalHours: 8,
    okxAuthMode: "disabled",
    okxAuthReady: false,
    okxExchangeAuthOptIn: false,
    okxLiveEnabled: false,
    okxLiveMaxOrderNotionalUsdt: 100,
    okxApiKey: "",
    okxApiSecret: "",
    okxPassphrase: "",
    okxDemoApiKey: "",
    okxDemoApiSecret: "",
    okxDemoPassphrase: ""
} as const;

const mockTradeControl = {
    serverTradeEnabled: true,
    closeOnlyMode: false,
    killSwitch: false,
    reconcileSafeMode: false,
    riskMode: null,
    dailyLossGuardTriggered: false
} as const;

function ethOpenAfterDefensiveReduce(
    overrides: Partial<PaperOpenPositionRecord> = {}
): PaperOpenPositionRecord {
    return {
        symbol: "ETHUSDT",
        side: "long",
        status: "open",
        pos: 0.039,
        entryPrice: 1900,
        sizeUsd: 75,
        initialSizeUsd: 100,
        stopPrice: 1891.45,
        leverage: 10,
        unrealizedPnlPct: -0.0018,
        openedAt: Date.now() - 60_000,
        strategyVersion: "paper-v2",
        sourceSignal: "test",
        sourceRunPath: "test",
        executorAtEntry: "TREND",
        regimeAtEntry: "TREND",
        lifecycleState: "BOT_V2_MANAGED",
        lastReduceReason: "PNL_STOP_PROTECT",
        protectivePartialReduceCount: 1,
        slProtectionSatisfied: true,
        protectiveSlAlgoId: "algo_bridge_c8_test",
        ...overrides
    };
}

function buildBridgeFromLedger(open: PaperOpenPositionRecord): V2BridgeState {
    return buildV2StateBridge(
        [open],
        null,
        mockConfig as any,
        true,
        true,
        false,
        false,
        0,
        0,
        { profit: {} as any, loss: {} as any, contaminated: {} as any },
        mockTradeControl as any,
        false
    );
}

type ProductionExitOpts = {
    markPrice: number;
    regime?: "TREND" | "RANGE" | "TRANSITION";
    transitionPhase?: string;
    trendWeaknessScore?: number;
    shockPhase?: "NONE" | "DOWN_SHOCK" | "UP_SHOCK";
    pnlPct?: number;
    stopPrice?: number;
    structureBreached?: boolean;
    invalidationBreachConfirmed?: boolean;
    atr20?: number;
};

function evaluateViaProductionBridge(open: PaperOpenPositionRecord, opts: ProductionExitOpts) {
    const bridge = buildBridgeFromLedger(open);
    const now = Date.now();
    const markPrice = opts.markPrice;
    const snapshot = {
        lastPrice: markPrice,
        latestCandleClose: markPrice,
        boxPos: 0.5,
        boxBreakSide: "none" as const,
        emaGap: 0.001,
        trendWeaknessScore: opts.trendWeaknessScore ?? 0.2,
        rangeConfidence: 0.7,
        qualityScore: 80,
        atr20: opts.atr20 ?? 3.0
    };
    const adapted = adaptV2Input(
        "ETHUSDT",
        now,
        snapshot as any,
        mockConfig as any,
        bridge as any,
        {} as any
    );
    const v2State = deriveV2StateAuthority(adapted);
    const policy = evaluateV2ExitPolicy({
        symbol: "ETHUSDT",
        v2State,
        judgment: {
            regime_final: opts.regime ?? "TREND",
            subtype: "TREND_MOMENTUM_HEALTHY",
            shockPhase: opts.shockPhase ?? "NONE",
            rangePhase: "MID",
            trendPhase: "UP",
            transitionPhase: opts.transitionPhase ?? "NONE",
            confidence: 0.8
        } as any,
        snapshot,
        markPrice,
        invalidationBreachConfirmed: opts.invalidationBreachConfirmed,
        structuralBreakConfirmed: false,
        boxBreakConfirmed: false,
        reversalConfirmed: false
    });
    const bridgePos = bridge.currentPositions.find((p) => p.symbol === "ETHUSDT") ?? null;
    const adaptedPos = adapted.state.currentPositions.find((p) => p.symbol === "ETHUSDT") ?? null;
    const derivedPos = v2State.symbolPositions.find((p) => p.symbol === "ETHUSDT") ?? null;
    return { bridge, adapted, v2State, policy, bridgePos, adaptedPos, derivedPos };
}

function testBridgePreservesReduceEpisodeFields(): void {
    const open = ethOpenAfterDefensiveReduce();
    const { bridgePos, adaptedPos, derivedPos } = evaluateViaProductionBridge(open, { markPrice: 1896.5 });

    assertEq(bridgePos?.lastReduceReason, "PNL_STOP_PROTECT", "bridge lastReduceReason");
    assertEq(bridgePos?.protectivePartialReduceCount, 1, "bridge protectivePartialReduceCount");
    assertEq(bridgePos?.ledger_stop_px, 1891.45, "bridge ledger_stop_px from stopPrice");

    assertEq(adaptedPos?.lastReduceReason, "PNL_STOP_PROTECT", "adapted lastReduceReason");
    assertEq(adaptedPos?.protectivePartialReduceCount, 1, "adapted protectivePartialReduceCount");
    assertEq(adaptedPos?.ledger_stop_px, 1891.45, "adapted ledger_stop_px");
    assertEq(adaptedPos?.leverage, 10, "adapted leverage");

    assertEq(derivedPos?.lastReduceReason, "PNL_STOP_PROTECT", "derived lastReduceReason");
    assertEq(derivedPos?.protectivePartialReduceCount, 1, "derived protectivePartialReduceCount");
}

function testProductionPathBlocksRepeatPnlReduce(): void {
    const open = ethOpenAfterDefensiveReduce();
    const { policy } = evaluateViaProductionBridge(open, {
        markPrice: 1896.58,
        atr20: 3.0
    });
    assertEq(policy.action, "HOLD", "repeat PNL defensive reduce via production bridge must HOLD");
    assertTrue(
        policy.evidence.includes("repeat_defensive_reduce_suppressed"),
        "repeat defensive reduce proof via production bridge"
    );
}

function testProductionPathBlocksTransitionRepeatReduce(): void {
    const open = ethOpenAfterDefensiveReduce({ stopPrice: 1880 });
    const { policy } = evaluateViaProductionBridge(open, {
        markPrice: 1900,
        regime: "TRANSITION",
        transitionPhase: "CONFLICT",
        atr20: 5
    });
    assertEq(policy.action, "WATCH", "transition repeat reduce via production bridge must WATCH");
    assertEq(policy.reason, "TRANSITION_PROTECTIVE_WATCH", "transition protective watch reason");
}

function testProductionPathBlocksTrendWeaknessStack(): void {
    const open = ethOpenAfterDefensiveReduce({ unrealizedPnlPct: -0.005, stopPrice: 1880 });
    const { policy } = evaluateViaProductionBridge(open, {
        markPrice: 1899.0,
        regime: "TREND",
        trendWeaknessScore: 0.56
    });
    assertEq(policy.action, "WATCH", "trend weakness stack via production bridge must WATCH");
    assertTrue(!policy.shouldPartial && !policy.shouldReduce, "trend weakness cannot stack trim");
    assertTrue(
        policy.evidence.includes("trend_reduce_after_defensive_trim_suppressed"),
        "trend stack suppression via production bridge"
    );
}

function testProductionPathCommittedSlStillFullExit(): void {
    const open = ethOpenAfterDefensiveReduce({
        entryPrice: 1900,
        stopPrice: 1890
    });
    const { policy, derivedPos } = evaluateViaProductionBridge(open, {
        markPrice: 1889.9,
        atr20: 3.0
    });
    assertEq(derivedPos?.ledger_stop_px, 1890, "derived stop for SL breach test");
    assertEq(policy.action, "FULL_EXIT", "committed SL breach via production bridge must FULL_EXIT");
    assertEq(policy.reason, "PNL_STOP_PROTECT", "committed SL authority reason preserved");
}

function runAll(): void {
    console.info("=== RUNNING BLOCKER 4-20 C8 BRIDGE PROPAGATION REGRESSIONS ===");
    testBridgePreservesReduceEpisodeFields();
    testProductionPathBlocksRepeatPnlReduce();
    testProductionPathBlocksTransitionRepeatReduce();
    testProductionPathBlocksTrendWeaknessStack();
    testProductionPathCommittedSlStillFullExit();
    console.info("=== ALL BLOCKER 4-20 C8 BRIDGE PROPAGATION REGRESSIONS PASSED ===");
}

runAll();
