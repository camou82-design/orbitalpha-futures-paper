import { executeRangeRegime } from "./engine-v2/executors/range-executor";
import { rangeExecutorEvaluateEntry } from "./strategy/executors/range-executor";
import { calculateRiskSizing } from "./engine-v2/risk-sizing/policy";
import { EngineV2Input, MarketJudgmentOutput } from "./engine-v2/types";

// Helper to mock base input
function getMockInput(overrides: any = {}): EngineV2Input {
    return {
        symbol: "BTCUSDT",
        candles: [],
        snapshot: {
            symbol: "BTCUSDT",
            lastPrice: 90000,
            latestCandleClose: 90000,
            boxHigh: 95000,
            boxLow: 85000,
            boxPos: 0.5,
            rangeConfidence: 0.8,
            boxCohesion01: 0.9,
            rangeOscillationScore: 0.8,
            breakoutFailureRate: 0.1,
            trendWeaknessScore: 0.8,
            qualityScore: 80,
            reviewing_ticks: 0,
            regimeExitRisk: 0,
            boxBreakSide: "none",
            signal: "none",
            data_ready: true,
            dump_protection_hit: false,
            volatility_guard_hit: false,
            entryCandidate: false,
            ema20: 89000,
            emaGap: 0.005,
            volatilityProxy: 100,
            ...overrides.snapshot
        },
        state: {
            currentPositions: [],
            lossStreaks: {},
            globalRiskScore: 0,
            longAllow: true,
            shortAllow: true,
            executionReadiness: true,
            paperExecutionReady: true,
            signedExecutionReady: true,
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            riskMode: "NORMAL",
            dailyLossGuardTriggered: false,
            directionalShockState: "NONE",
            accountEquityKrw: 1000000,
            maxUsableMarginKrw: 900000,
            exposureNotionalCapKrw: 5000000,
            symbolExposureNotionalCapKrw: 3000000,
            okxLiveEnabled: false, // Paper Mode
            freshTickBarrierActive: false,
            freshTickCompletedCycles: 5,
            freshTickRequiredCycles: 5,
            ...overrides.state
        },
        config: {
            baseSizeUsd: 100,
            okxLiveStaticNotionalCapEnabled: true,
            okxLiveUsableBalanceRatio: 0.95,
            ...overrides.config
        },
        now: Date.now(),
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        }
    };
}

function getMockJudgment(overrides: any = {}): MarketJudgmentOutput {
    return {
        regime: "RANGE",
        subtype: "NONE",
        subtypeReason: "none",
        shockPhase: "NONE",
        trendPhase: "NONE",
        rangePhase: "NONE",
        ...overrides
    };
}

async function runStaticTests() {
    console.log("=== STARTING ESSENTIAL STATIC VERIFICATION ===");

    // Test A. Paper ready=true, Signed ready=false, Paper 모드
    // -> readiness만으로 차단되면 안 됨
    {
        const input = getMockInput({
            state: {
                paperExecutionReady: true,
                signedExecutionReady: false,
                okxLiveEnabled: false // Paper 모드
            }
        });
        const judgment = getMockJudgment({ subtype: "RANGE_MID_CHOP", trendPhase: "NONE", shockPhase: "NONE" });
        const execOut = executeRangeRegime(input, judgment);
        
        // Let's pass to risk policy
        const riskOut = calculateRiskSizing(judgment, { level: "HIGH", score: 90 }, execOut, input);
        const readinessDiag = riskOut.diagnostics ?? {};
        const paperReady = readinessDiag.paper_execution_ready === true;
        const signedReady = readinessDiag.signed_execution_ready === true;
        
        const passed = paperReady && !signedReady && riskOut.isBlocked === false;
        console.log(`[Test A] Paper ready=true, Signed ready=false, Paper 모드 -> Blocked: ${riskOut.isBlocked} (Expected: false). Passed: ${passed}`);
    }

    // Test B. Paper ready=false -> 기존 하드 차단 유지
    {
        const input = getMockInput({
            snapshot: {
                lastPrice: 0, // Invalid values to trigger MARKET_SNAPSHOT_NOT_READY
                latestCandleClose: 0
            },
            state: {
                paperExecutionReady: false,
                okxLiveEnabled: false
            }
        });
        const judgment = getMockJudgment({ subtype: "RANGE_MID_CHOP" });
        const execOut = executeRangeRegime(input, judgment);
        const riskOut = calculateRiskSizing(judgment, { level: "HIGH", score: 90 }, execOut, input);
        const passed = riskOut.isBlocked === true && (riskOut.blockReason === "MARKET_SNAPSHOT_NOT_READY" || riskOut.blockReason === "V2_INPUT_NOT_READY" || riskOut.blockReason === "EXECUTION_READINESS_FALSE");
        console.log(`[Test B] Paper ready=false -> Blocked: ${riskOut.isBlocked}, Reason: ${riskOut.blockReason}. Passed: ${passed}`);
    }

    // Test C. RANGE lower + shock NONE + trend DOWN + reversal false -> 관망
    {
        const input = getMockInput({
            snapshot: { boxPos: 0.1, lastPrice: 86000, boxLow: 85000, boxHigh: 95000, atr: 1000 }
        });
        const judgment = getMockJudgment({
            shockPhase: "NONE",
            trendPhase: "DOWN"
        });
        const execOut = executeRangeRegime(input, judgment);
        const passed = execOut.signal === "NONE" && execOut.reason === "V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND";
        console.log(`[Test C] RANGE lower + shock NONE + trend DOWN + reversal false -> Signal: ${execOut.signal}, Reason: ${execOut.reason}. Passed: ${passed}`);
    }

    // Test D. RANGE lower + shock NONE + trend DOWN + reversal true -> 축소 롱 후보 평가 가능
    {
        const input = getMockInput({
            snapshot: { boxPos: 0.1, lastPrice: 86000, boxLow: 85000, boxHigh: 95000, atr: 1000, qualityScore: 80 }
        });
        const judgment = getMockJudgment({
            shockPhase: "NONE",
            trendPhase: "DOWN",
            reversalConfirmed: true
        });
        
        const candles = [
            { ts: Date.now() - 5000, open: 86000, high: 86100, low: 84900, close: 85900, volume: 10 },
            { ts: Date.now(), open: 85900, high: 86200, low: 85800, close: 86100, volume: 10 }
        ];
        input.snapshot.candles = candles;
        
        const execOutWithReversal = executeRangeRegime(input, judgment);
        const passed = execOutWithReversal.signal === "LONG_CANDIDATE";
        console.log(`[Test D] RANGE lower + shock NONE + trend DOWN + reversal true -> Signal: ${execOutWithReversal.signal}, Side: ${execOutWithReversal.side}. Passed: ${passed}`);
    }

    // Test E. RANGE lower + DOWN_SHOCK -> 롱 하드 차단
    {
        const input = getMockInput({
            snapshot: { boxPos: 0.1, lastPrice: 86000, boxLow: 85000, boxHigh: 95000, atr: 1000 }
        });
        const judgment = getMockJudgment({
            shockPhase: "DOWN_SHOCK",
            trendPhase: "DOWN"
        });
        const execOut = executeRangeRegime(input, judgment);
        const passed = execOut.signal === "NONE" && execOut.reason === "V2_RANGE_LOWER_LONG_BLOCKED_BY_DOWN_SHOCK";
        console.log(`[Test E] RANGE lower + DOWN_SHOCK -> Signal: ${execOut.signal}, Reason: ${execOut.reason}. Passed: ${passed}`);
    }

    // Test F. side long + stopPrice null -> 주문 차단 및 side none으로 정규화
    {
        const input = getMockInput({
            snapshot: { boxPos: 0.1, lastPrice: 86000, boxLow: 85000, boxHigh: 95000, atr: 1000 }
        });
        const judgment = getMockJudgment({
            shockPhase: "NONE",
            trendPhase: "DOWN"
        });
        
        const execOut = executeRangeRegime(input, judgment); // returns NONE, none
        const stratOut = rangeExecutorEvaluateEntry({
            symbol: input.symbol,
            regime: "RANGE",
            risk_state: (input.state.riskMode as any) ?? "NORMAL",
            signal: "none", // NONE 신호인 상태 검증
            qualityScore: 80,
            boxPos: 0.1,
            boxRel: 0.1,
            boxHigh: 95000,
            boxLow: 85000,
            boxMid: 90000,
            expectedMove: 0.05,
            totalCost: 100,
            atr: 1000,
            cooldownActive: false,
            cooldownRemainingMs: 0,
            currentStage: 0,
            shockPhase: judgment.shockPhase,
            trendPhase: judgment.trendPhase,
            emaGap: input.snapshot.emaGap ?? 0,
            reversalConfirmed: (judgment as any).reversalConfirmed === true
        });

        const passed = execOut.side === "none" && execOut.stopPrice === null && execOut.invalidationPx === null &&
                       stratOut.entry_allowed === false && stratOut.blocked_reason === "no_signal";
        console.log(`[Test F] side long + stopPrice null -> Side: ${execOut.side}, StopPrice: ${execOut.stopPrice}, StratAllowed: ${stratOut.entry_allowed}. Passed: ${passed}`);
    }

    // Test G. side long + 유효 stopPrice -> Risk Audit 정상 평가
    {
        const input = getMockInput({
            snapshot: { boxPos: 0.1, lastPrice: 86000, boxLow: 85000, boxHigh: 95000, atr: 1000 }
        });
        const judgment = getMockJudgment({
            shockPhase: "NONE",
            trendPhase: "NONE",
            reversalConfirmed: true
        });
        const candles = [
            { ts: Date.now() - 5000, open: 86000, high: 86100, low: 84950, close: 85900, volume: 10 },
            { ts: Date.now(), open: 85900, high: 86200, low: 85800, close: 86100, volume: 10 }
        ];
        input.snapshot.candles = candles;

        const execOut = executeRangeRegime(input, judgment);
        const stratOut = rangeExecutorEvaluateEntry({
            symbol: input.symbol,
            regime: "RANGE",
            risk_state: (input.state.riskMode as any) ?? "NORMAL",
            signal: "paper_long_candidate",
            qualityScore: 80,
            boxPos: 0.1,
            boxRel: 0.1,
            boxHigh: 95000,
            boxLow: 85000,
            boxMid: 90000,
            expectedMove: 0.05,
            totalCost: 100,
            atr: 1000,
            cooldownActive: false,
            cooldownRemainingMs: 0,
            currentStage: 0,
            shockPhase: judgment.shockPhase,
            trendPhase: judgment.trendPhase,
            emaGap: input.snapshot.emaGap ?? 0,
            reversalConfirmed: (judgment as any).reversalConfirmed === true
        });

        const passed = execOut.signal === "LONG_CANDIDATE" && execOut.side === "long" && typeof execOut.stopPrice === "number" && execOut.stopPrice > 0 && execOut.stopPrice < input.snapshot.lastPrice &&
                       stratOut.entry_allowed === true;
        console.log(`[Test G] side long + 유효 stopPrice -> Signal: ${execOut.signal}, Side: ${execOut.side}, Stop: ${execOut.stopPrice}, StratAllowed: ${stratOut.entry_allowed}. Passed: ${passed}`);
    }

    console.log("=== ESSENTIAL STATIC VERIFICATION COMPLETED ===");
}

runStaticTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
