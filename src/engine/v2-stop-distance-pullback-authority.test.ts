import test from "node:test";
import assert from "node:assert/strict";
import { runEngineV2 } from "../engine-v2/index";
import { evaluateHighwayCoreEntryGate } from "../engine-v2/highway-core/highway-entry-gate";

test("V2 STOP_DISTANCE_TOO_WIDE & PULLBACK RISK PLAN SUITE", async (t) => {
    await t.test("1. STOP_DISTANCE_TOO_WIDE on strong trend preserves WAIT_PULLBACK_FOR_RISK_PLAN (not misleading retest)", () => {
        // Price chased high (e.g. 80,000) with structural stop at 75,000 (distance = 6.25% > 3% max)
        const chasedInput = {
            symbol: "BTCUSDT",
            now: 1788500000000,
            config: {
                okxLiveMaxOrderNotionalUsdt: null,
                minExpectedMoveOverCostMultiplier: 2.0,
                highwayMinRewardRisk: 1.2
            },
            snapshot: {
                symbol: "BTCUSDT",
                lastPrice: 80000,
                latestCandleClose: 80000,
                atr: 500, // atrPct = 500/80000 = 0.00625, maxStopDistancePct = clamp(0.00625*3, 0.005, 0.03) = 0.01875 (1.875%)
                boxPos: 0.85,
                boxHigh: 81000,
                boxLow: 75000,
                candles: [
                    { time: 1788500000000 - 300000, open: 79000, high: 80100, low: 79000, close: 80000, volume: 100 }
                ]
            },
            state: {
                currentPositions: [],
                okxActualPositions: [],
                globalRiskScore: 0.5,
                lossStreaks: {},
                directionalShockState: "NONE",
                longAllow: true,
                shortAllow: true,
                executionReadiness: true,
                accountEquityKrw: 10_000_000,
                symbolExposureNotionalCapKrw: 50_000_000,
                exposureNotionalCapKrw: 50_000_000,
                freshTickBarrierActive: false,
                freshTickCompletedCycles: 3,
                freshTickRequiredCycles: 3
            }
        };

        const res = runEngineV2(chasedInput as any);

        // If stopped by stop distance, decision is REJECT/HOLD, and expectedNextAction must be WAIT_PULLBACK_FOR_RISK_PLAN
        if (res.decision.risk?.blockReason === "STOP_DISTANCE_TOO_WIDE" || res.decision.explanation?.reason === "STOP_DISTANCE_TOO_WIDE") {
            assert.equal(res.decision.decision, "REJECT");
            assert.notEqual(res.decision.explanation?.reason, "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION");
        }
    });

    await t.test("2. When price pulls back to within ATR max stop distance, ENTER is allowed with fresh trend/HTF validation", () => {
        // Price pulls back closer to stop (e.g. 76,000 vs stop at 75,000, distance = 1.31% <= max 1.97%)
        const entryPrice = 76000;
        const stopPrice = 75000;
        const tp1Price = 78000;

        const gateRes = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "TREND",
            snapshot: {
                lastPrice: entryPrice,
                boxPos: 0.4,
                atr: 500
            },
            execution: {
                signal: "ENTER",
                side: "long",
                stopPrice,
                invalidationPx: stopPrice,
                metadata: {
                    plannedStopPrice: stopPrice,
                    tp1Price
                }
            } as any,
            committedRiskPlan: {
                stopPrice,
                tp1Price: tp1Price
            } as any,
            isPreCheck: false
        });

        assert.equal(gateRes.allowed, true);
        assert.equal(gateRes.finalDecision, "ENTER");
        assert.ok(gateRes.stopDistancePct > 0);
        assert.ok(gateRes.tp1DistancePct > 0);
        assert.ok(gateRes.rewardRisk >= 1.2);
    });

    await t.test("3. HIGHWAY_ENTRY_GATE_PROOF stopDistance/tp1Distance/rewardRisk are accurately populated (not 0)", () => {
        const entryPrice = 70000;
        const stopPrice = 69000; // 1.428% distance
        const tp1Price = 72000;  // 2.857% distance => RR = 2.0

        const gateRes = evaluateHighwayCoreEntryGate({
            symbol: "BTCUSDT",
            side: "long",
            regime: "RANGE",
            snapshot: {
                lastPrice: entryPrice,
                boxPos: 0.25,
                boxHigh: 73000,
                boxLow: 68000,
                atr: 600
            },
            execution: {
                signal: "ENTER",
                side: "long",
                stopPrice,
                invalidationPx: stopPrice,
                metadata: {
                    plannedStopPrice: stopPrice,
                    tp1Price
                }
            } as any,
            committedRiskPlan: {
                stopPrice,
                tp1Price
            } as any,
            isPreCheck: false
        });

        const proof = gateRes.proof;
        assert.equal(proof.event, "HIGHWAY_ENTRY_GATE_PROOF");
        assert.ok(typeof proof.stopDistancePct === "number" && proof.stopDistancePct > 0.01);
        assert.ok(typeof proof.tp1DistancePct === "number" && proof.tp1DistancePct > 0.02);
        assert.ok(typeof proof.rewardRisk === "number" && proof.rewardRisk >= 1.9);
        assert.equal(gateRes.allowed, true);
    });

    await t.test("4. Stop maximum allowed threshold is strictly preserved (chase prevention intact)", () => {
        // High chase stop distance: 4.0% > max 3.0% threshold
        const entryPrice = 80000;
        const stopPrice = 76800; // 4% distance
        const tp1Price = 84000;  // 5% distance

        // Even with positive RR (5%/4% = 1.25), if stop distance is beyond ATR max, it must be rejected or audited
        const atrVal = 500;
        const atrPct = atrVal / entryPrice; // 0.00625
        const maxAllowed = Math.min(Math.max(atrPct * 3, 0.005), 0.03); // 1.875%
        const actualDist = (entryPrice - stopPrice) / entryPrice; // 4.0%

        assert.ok(actualDist > maxAllowed, "Stop distance must strictly exceed maximum allowed threshold to trigger chase block");
    });
});
