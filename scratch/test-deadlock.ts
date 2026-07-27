import * as fs from "fs";
import * as path from "path";
import { runEngineV2 } from "../src/engine-v2";
import { EngineV2Input } from "../src/engine-v2/types";

// 1. 임시 history.json mock 생성 (11시간 전 진입 기록)
const dataDir = path.join(__dirname, "../data/positions");
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
const historyPath = path.join(dataDir, "history.json");
const elevenHoursAgo = Date.now() - 11 * 3600 * 1000;
const mockHistory = [
    {
        openedAt: elevenHoursAgo,
        closedAt: elevenHoursAgo + 30 * 60 * 1000,
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 2000,
        closePrice: 2010
    }
];
fs.writeFileSync(historyPath, JSON.stringify(mockHistory, null, 2));
console.log("Mock history.json created at:", historyPath);

// 2. Env 설정 조작
process.env.V2_DEADLOCK_RESOLVER_AUDIT_ENABLED = "true";
process.env.V2_DEADLOCK_PROBE_PROMOTION_ENABLED = "true"; // Promotion 활성화
process.env.OKX_LIVE_MAX_ORDER_NOTIONAL_USDT = "500"; // Config 누락 방지

const mockInput: EngineV2Input = {
    symbol: "ETHUSDT" as any,
    now: Date.now(),
    snapshot: {
        lastPrice: 2100,
        latestCandleClose: 2100,
        boxHigh: 2200,
        boxLow: 2000,
        boxPos: 0.1, // lower zone -> long promotion eligible
        rangeConfidence: 0.8,
        ema20: 2100,
        emaGap: -0.001,
        volatilityProxy: 10,
        boxCohesion01: 0.95,
        breakoutFailureRate: 0.1,
        trendWeaknessScore: 0.2,
        rangeOscillationScore: 0.5,
        reviewing_ticks: 5,
        regimeExitRisk: 0.1,
        boxBreakSide: "none",
        signal: "paper_long_candidate" as any,
        qualityScore: 75,
        data_ready: true,
        dump_protection_hit: false,
        volatility_guard_hit: false,
        entryCandidate: true,
        signalGateBlockedReason: null,
        rangeSignalDowngraded: false,
        rangeSignalKeptByRelax: false,
        atr: 20,
        swingHighSlope: 0,
        swingLowSlope: 0,
        rangeCenterSlope: 0,
        boxHighSlope: 0,
        boxLowSlope: 0,
        ema20Slope: 0,
        ema60Slope: 0,
        atrExpansion: 0,
        volumeExpansion: 0
    },
    config: {
        paperMaxOpenPositions: 3,
        paperReentryCooldownMs: 60000,
        baseSizeUsd: 100,
        okxLiveMaxOrderNotionalUsdt: 500
    },
    state: {
        currentPositions: [], // 포지션 없음
        lossStreaks: {},
        globalRiskScore: 0,
        directionalShockState: "NONE",
        longAllow: true,
        shortAllow: true,
        executionReadiness: true,
        paperExecutionReady: true,
        signedExecutionReady: true,
        freshTickBarrierActive: false,
        freshTickExecutionBlocked: false,
        freshTickCompletedCycles: 5,
        freshTickRequiredCycles: 2,
        serverTradeEnabled: true,
        closeOnlyMode: false,
        killSwitch: false,
        reconcileSafeMode: false,
        accountEquityKrw: 1400000,
        maxUsableMarginKrw: 1400000,
        exposureNotionalCapKrw: 14000000,
        symbolExposureNotionalCapKrw: 7000000
    },
    v1Result: {
        regime: "RANGE",
        decision: "SKIP",
        side: "none",
        isBlocked: false
    }
};

// 3. 엔진 다회 루프 평가
console.log("\nStarting V2 Engine Loop Evaluation...");
for (let i = 1; i <= 15; i++) {
    const input = {
        ...mockInput,
        now: Date.now() + i * 1000 // 시간 흐름 모사
    };
    
    // 강제로 SKIP/REJECT 상황을 모사하기 위해, audit risk plan 등에서 finalDecision이 SKIP이 되도록 input을 유지
    // V2 일반 로직에서는 lower zone long이 skip/reject 되는 상황을 모방하기 위해 veto가 걸리도록 함
    
    const result = runEngineV2(input);
    console.log(`[Cycle ${i}] Decision: ${result.decision.decision}, Side: ${result.decision.side}, Margin: ${result.decision.risk.stageMarginKrw}, Metadata:`, JSON.stringify(result.decision.metadata));
}
