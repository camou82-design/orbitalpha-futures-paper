
import { evaluatePaperSymbolEntry } from './src/engine/paper-symbol-decision';
import { SymbolSnapshot } from './src/models/types';

// Mock Config
const config: any = {
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

// Mock Risk (Allowing everything initially)
const risk: any = {
    longAllow: true,
    shortAllow: true,
    engineBlocked: false,
    crashState: 'NONE',
    blockedRegimes: {}
};

// Scenario 1: WEAK RANGE Short Candidate (Upper Zone)
// In the OLD code, this would be a "Candidate" and then maybe a "Soft Pass" or "Blocked by Low Confidence".
// In the NEW code, it should be filtered early to WAIT_RECHECK.
const weakSn: any = {
    symbol: 'BTCUSDT',
    lastPrice: 60000,
    signal: 'paper_short_candidate',
    candidateStrength: 'weak',
    boxPos: 0.75, // Upper zone
    rangeConfidence: 0.4, // Relatively low
    boxCohesion01: 0.3,
    breakoutFailureRate: 0.3,
    rangeOscillationScore: 0.3,
    trendWeaknessScore: 0.4,
    regimeStateDiag: 'RANGE',
    gateExpectedMove: 0.005,
    gateRequiredMove: 0.002,
    dataReady: true,
    snapshot: true
};

console.log("--- TEST 1: WEAK RANGE CANDIDATE ---");
const res1 = evaluatePaperSymbolEntry({
    config,
    snapshot: weakSn,
    dataReady: true,
    regime: 'RANGE',
    risk
} as any);

console.log("Result for Weak Candidate:");
console.log(`- signal_state: ${res1.decision.signal_state}`);
console.log(`- final_decision: ${res1.decision.final_decision}`);
console.log(`- reject_reason: ${res1.decision.reject_reason}`);
console.log(`- stage1_result_code: ${res1.decision.stage1_result_code}`);


// Scenario 2: RISK BLOCKED (but Risk Layer says Allow)
// This simulates the conflict where allow_new_entry=true but engine blocks.
const riskBlockedSn: any = {
    ...weakSn,
    rangeConfidence: 0.8, // High confidence, so it would be a candidate
    boxCohesion01: 0.8,
};

const conflictedRisk: any = {
    ...risk,
    engineBlocked: true, // Risk layer says BLOCKED
    longAllow: false,
    shortAllow: false
};

console.log("\n--- TEST 2: RISK CONFLICT (Engine must block in Phase 1) ---");
const res2 = evaluatePaperSymbolEntry({
    config,
    snapshot: riskBlockedSn,
    dataReady: true,
    regime: 'RANGE',
    risk: conflictedRisk
} as any);

console.log("Result for Risk Conflict:");
console.log(`- final_decision: ${res2.decision.final_decision}`);
console.log(`- reject_reason: ${res2.decision.reject_reason}`);
// It should return RANGE_GATE_BLOCK_WAIT_RECHECK (from Phase 1 downgrade) 
// instead of RANGE_GATE_BLOCK_RISK_ENGINE in Phase 2.
console.log(`- gateReason (internal check): ${res2.decision.final_fail_reason || 'N/A'}`);


// Scenario 3: STRONG RANGE Candidate
const strongSn: any = {
    ...weakSn,
    rangeConfidence: 0.9,
    boxCohesion01: 0.9,
    breakoutFailureRate: 0.9,
    rangeOscillationScore: 0.9,
    trendWeaknessScore: 0.9,
    signal_strength: 'strong',
    trendOk: true
};

console.log("\n--- TEST 3: STRONG RANGE CANDIDATE ---");
const res3 = evaluatePaperSymbolEntry({
    config,
    snapshot: strongSn,
    dataReady: true,
    regime: 'RANGE',
    risk
} as any);

console.log("Result for Strong Candidate:");
console.log(`- final_decision: ${res3.decision.final_decision}`);
console.log(`- stage1_result_code: ${res3.decision.stage1_result_code}`);
