
const { evaluatePaperSymbolEntry } = require('../dist/engine/paper-symbol-decision');

const config = {
    paperEngineMode: 'LIVE',
    paperSlippageBps: 10,
    paperFixedTotalCostUsd: 0,
    paperBaseSizeUsd: 100,
    paperEntryRelaxed: false,
    paperQualityMinScore: 0.1,
    paperQualityMinScoreWeak: 0.05,
    paperTakerFeeRate: 0.0006,
    paperGateMinMoveMultiplier: 1.0,
    paperRequireHigherTfAlign: false
};

const risk = {
    longAllow: true,
    shortAllow: true,
    engineBlocked: false,
    crashState: 'NONE',
    blockedRegimes: {}
};

const authority = {
    decision: 'HOLD',
    source: 'v2',
    side: 'none',
    sizeUsd: 0
};

const baseSn = {
    symbol: 'BTCUSDT',
    lastPrice: 60000,
    latestCandleClose: 60000,
    signal: 'none',
    candidateStrength: 'none',
    boxPos: 0.5,
    rangeConfidence: 0.8,
    boxCohesion01: 0.8,
    breakoutFailureRate: 0.8,
    rangeOscillationScore: 0.8,
    trendWeaknessScore: 0.8,
    regimeStateDiag: 'RANGE',
    gateExpectedMove: 0.005,
    gateRequiredMove: 0.002,
    now: Date.now(),
    candles: [],
    dataReady: true,
    snapshot: true
};

function runTest(label, sn, r = risk) {
    console.log(`\n--- ${label} ---`);
    try {
        const res = evaluatePaperSymbolEntry({
            config,
            snapshot: sn,
            dataReady: true,
            regime: 'RANGE',
            risk: r,
            authority,
            now: Date.now(),
            currentStage: 0,
            hasOpenPosition: false,
            openPositionsTotal: 0,
            lastCloseMetaBySymbol: new Map()
        });
        console.log(`- Signal: ${sn.signal} (${sn.candidateStrength})`);
        console.log(`- Final Decision: ${res.decision.final_decision}`);
        console.log(`- Signal State: ${res.decision.signal_state}`);
        console.log(`- Reject Reason: ${res.decision.reject_reason || 'null'}`);
        console.log(`- Result Code: ${res.decision.stage1_result_code}`);
    } catch (e) {
        console.log(`- Error: ${e.message}`);
    }
}

// 1. Weak Range Candidate (Observation only)
runTest("TEST 1: WEAK CANDIDATE", {
    ...baseSn,
    signal: 'paper_short_candidate',
    candidateStrength: 'weak',
    boxPos: 0.8,
    rangeConfidence: 0.4,
    boxCohesion01: 0.3
});

// 2. Risk Blocked (Consistent Auth)
runTest("TEST 2: RISK BLOCKED", {
    ...baseSn,
    signal: 'paper_short_candidate',
    candidateStrength: 'strong',
    boxPos: 0.82,
    rangeConfidence: 0.9,
    boxCohesion01: 0.9,
    signal_strength: 'strong',
    trendOk: true
}, {
    ...risk,
    engineBlocked: true,
    shortAllow: false
});

// 3. Strong Candidate (Success)
runTest("TEST 3: STRONG CANDIDATE", {
    ...baseSn,
    signal: 'paper_short_candidate',
    candidateStrength: 'strong',
    boxPos: 0.82,
    rangeConfidence: 0.9,
    boxCohesion01: 0.9,
    signal_strength: 'strong',
    trendOk: true
});
