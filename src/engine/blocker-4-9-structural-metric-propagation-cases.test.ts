/**
 * BLOCKER 4-9 — V2 STRUCTURAL METRIC PROPAGATION FIX
 * Regression & Unit test suite
 */

import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { resolveSymbolDecisionEnvelope } from "../engine-v2/reconciler";
import { executeRangeRegime } from "../engine-v2/executors/range-executor";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";

function run(label: string, passed: boolean, detail: string): boolean {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[BLOCKER-4-9][${label}] ${tag} — ${detail}`);
  return passed;
}

let allOk = true;

const mockCandles = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 60000,
  timestamp: Date.now() - (120 - i) * 60000,
  open: 3000 + i,
  high: 3005 + i,
  low: 2995 + i,
  close: 3002 + i,
  volume: 100
}));

// =========================================================================
// CASE A: Reconciler adapter preserves structural metrics
// snapshot has boxCohesion01=0.83, trendWeaknessScore=0.41,
// breakoutFailureRate=0.27, rangeOscillationScore=0.62.
// =========================================================================
{
  const now = Date.now();
  const snapshot: any = {
    lastPrice: 3000,
    latestCandleClose: 3000,
    boxHigh: 3100,
    boxLow: 2900,
    boxPos: 0.5,
    rangeConfidence: 0.65,
    ema20: 3000,
    emaGap: 0.001,
    atr: 15,
    signal: "none",
    qualityScore: 80,
    entryCandidate: false,
    boxCohesion01: 0.83,
    trendWeaknessScore: 0.41,
    breakoutFailureRate: 0.27,
    rangeOscillationScore: 0.62,
    candles: mockCandles,
    htf_candles: { "5m": mockCandles }
  };

  const config: any = {
    baseSizeUsd: 100,
    maxOpenPositions: 3,
    reentryCooldownMs: 0
  };

  const state: any = {
    currentPositions: [],
    lossStreaks: {},
    globalRiskScore: 0,
    longAllow: true,
    shortAllow: true,
    serverTradeEnabled: true,
    closeOnlyMode: false,
    killSwitch: false,
    reconcileSafeMode: false,
    riskMode: "NORMAL",
    accountEquityKrw: 1000000,
    maxUsableMarginKrw: 900000,
    exposureNotionalCapKrw: 5000000,
    symbolExposureNotionalCapKrw: 3000000
  };

  const legacyBridge: any = {
    regime: "RANGE",
    finalDecision: "SKIP",
    rejectReason: "none",
    requiredCostUsd: 0,
    entryAllowed: false,
    executorLabel: "range",
    intentSide: "none",
    adaptiveOk: true,
    adaptiveDetail: {}
  };

  const proofLogs: any[] = [];
  const origInfo = console.info;
  console.info = (msg: any) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed && typeof parsed.event === "string") {
        proofLogs.push(parsed);
      }
    } catch {}
    origInfo(msg);
  };

  try {
    resolveSymbolDecisionEnvelope({
      symbol: "ETHUSDT" as any,
      fetchedAt: now,
      snapshot,
      config,
      state,
      legacy: legacyBridge,
      v2Mode: "engine_v2",
      evaluationMode: "authoritative",
      runCycleId: "test-cycle"
    });
  } finally {
    console.info = origInfo;
  }

  const propProof = proofLogs.find((l) => l.event === "V2_STRUCTURAL_METRIC_PROPAGATION_PROOF");

  allOk = run(
    "CASE A - boxCohesion01 preserved in reconciler",
    propProof?.adapted_boxCohesion01 === 0.83,
    `adapted_boxCohesion01=${propProof?.adapted_boxCohesion01} (expected 0.83)`
  ) && allOk;

  allOk = run(
    "CASE A - trendWeaknessScore preserved in reconciler",
    propProof?.adapted_trendWeaknessScore === 0.41,
    `adapted_trendWeaknessScore=${propProof?.adapted_trendWeaknessScore} (expected 0.41)`
  ) && allOk;

  allOk = run(
    "CASE A - breakoutFailureRate preserved in reconciler",
    propProof?.adapted_breakoutFailureRate === 0.27,
    `adapted_breakoutFailureRate=${propProof?.adapted_breakoutFailureRate} (expected 0.27)`
  ) && allOk;

  allOk = run(
    "CASE A - rangeOscillationScore preserved in reconciler",
    propProof?.adapted_rangeOscillationScore === 0.62,
    `adapted_rangeOscillationScore=${propProof?.adapted_rangeOscillationScore} (expected 0.62)`
  ) && allOk;
}

// =========================================================================
// CASE B: adaptV2Input preserves boxCohesion01 & trendWeaknessScore (Not 0)
// =========================================================================
{
  const now = Date.now();
  const snapshotAdapter: any = {
    lastPrice: 3000,
    latestCandleClose: 3000,
    boxHigh: 3100,
    boxLow: 2900,
    boxPos: 0.5,
    rangeConfidence: 0.65,
    boxCohesion01: 0.83,
    trendWeaknessScore: 0.41,
    breakoutFailureRate: 0.27,
    rangeOscillationScore: 0.62,
    candles: mockCandles
  };

  const v2Input = adaptV2Input(
    "BTCUSDT" as any,
    now,
    snapshotAdapter,
    { baseSizeUsd: 100 } as any,
    { currentPositions: [] } as any,
    { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: false } as any
  );

  allOk = run(
    "CASE B - adaptV2Input preserves boxCohesion01",
    v2Input.snapshot.boxCohesion01 === 0.83,
    `boxCohesion01=${v2Input.snapshot.boxCohesion01} (expected 0.83)`
  ) && allOk;

  allOk = run(
    "CASE B - adaptV2Input preserves trendWeaknessScore",
    v2Input.snapshot.trendWeaknessScore === 0.41,
    `trendWeaknessScore=${v2Input.snapshot.trendWeaknessScore} (expected 0.41)`
  ) && allOk;
}

// =========================================================================
// CASE C: range executor metadata includes boxCohesion01 & trendWeaknessScore
// =========================================================================
{
  const now = Date.now();
  const input: any = {
    symbol: "BTCUSDT",
    snapshot: {
      lastPrice: 3000,
      latestCandleClose: 3000,
      boxHigh: 3100,
      boxLow: 2900,
      boxPos: 0.5,
      rangeConfidence: 0.65,
      boxCohesion01: 0.83,
      trendWeaknessScore: 0.41,
      breakoutFailureRate: 0.27,
      rangeOscillationScore: 0.62,
      candles: mockCandles
    },
    state: {
      currentPositions: [],
      longAllow: true,
      shortAllow: true
    },
    candles: mockCandles
  };

  const judgment = detectMarketRegime(input);
  const execution = executeRangeRegime(input, judgment);

  allOk = run(
    "CASE C - Range executor metadata contains boxCohesion01",
    execution.metadata?.boxCohesion01 === 0.83,
    `metadata.boxCohesion01=${execution.metadata?.boxCohesion01} (expected 0.83)`
  ) && allOk;

  allOk = run(
    "CASE C - Range executor metadata contains trendWeaknessScore",
    execution.metadata?.trendWeaknessScore === 0.41,
    `metadata.trendWeaknessScore=${execution.metadata?.trendWeaknessScore} (expected 0.41)`
  ) && allOk;
}

// =========================================================================
// CASE D: finalizer proof propagates boxCohesion01=0.83 & trendWeaknessScore=0.41
// =========================================================================
{
  const now = Date.now();
  const snapshotAdapter: any = {
    symbol: "ETHUSDT",
    lastPrice: 3000,
    latestCandleClose: 3000,
    boxHigh: 3100,
    boxLow: 2900,
    boxPos: 0.5,
    rangeConfidence: 0.65,
    boxCohesion01: 0.83,
    trendWeaknessScore: 0.41,
    breakoutFailureRate: 0.27,
    rangeOscillationScore: 0.62,
    qualityScore: 85,
    candles: mockCandles,
    htf_candles: { "5m": mockCandles }
  };

  const v2Input = adaptV2Input(
    "ETHUSDT" as any,
    now,
    snapshotAdapter,
    { baseSizeUsd: 100 } as any,
    { currentPositions: [], longAllow: true, shortAllow: true, serverTradeEnabled: true } as any,
    { decision: { final_decision: "HOLD", regime_state: "RANGE" }, intentSide: "none", adaptiveOk: true, regime: "RANGE", side: "none", isBlocked: false } as any
  );

  const proofLogs: any[] = [];
  const origInfo = console.info;
  console.info = (msg: any) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed && typeof parsed.event === "string") {
        proofLogs.push(parsed);
      }
    } catch {}
    origInfo(msg);
  };

  try {
    runEngineV2(v2Input);
  } finally {
    console.info = origInfo;
  }

  const propProof = proofLogs.find((l) => l.event === "V2_STRUCTURAL_METRIC_PROPAGATION_PROOF");
  const finalProof = proofLogs.find((l) => l.event === "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF");

  allOk = run(
    "CASE D - V2_STRUCTURAL_METRIC_PROPAGATION_PROOF emitted",
    propProof != null,
    propProof ? "Emitted" : "NOT FOUND"
  ) && allOk;

  if (propProof) {
    allOk = run(
      "CASE D - propProof final_boxCohesion01 is 0.83",
      propProof.final_boxCohesion01 === 0.83,
      `final_boxCohesion01=${propProof.final_boxCohesion01}`
    ) && allOk;

    allOk = run(
      "CASE D - propProof final_trendWeaknessScore is 0.41",
      propProof.final_trendWeaknessScore === 0.41,
      `final_trendWeaknessScore=${propProof.final_trendWeaknessScore}`
    ) && allOk;
  }

  if (finalProof) {
    allOk = run(
      "CASE D - finalProof boxCohesion01 is 0.83",
      finalProof.boxCohesion01 === 0.83,
      `boxCohesion01=${finalProof.boxCohesion01}`
    ) && allOk;

    allOk = run(
      "CASE D - finalProof trendWeaknessScore is 0.41",
      finalProof.trendWeaknessScore === 0.41,
      `trendWeaknessScore=${finalProof.trendWeaknessScore}`
    ) && allOk;
  }
}

// =========================================================================
// CASE E: Real upstream 0 value is preserved as 0 (No artificial non-zero coercion)
// =========================================================================
{
  const now = Date.now();
  const snapshotAdapter: any = {
    lastPrice: 3000,
    latestCandleClose: 3000,
    boxHigh: 3100,
    boxLow: 2900,
    boxPos: 0.5,
    rangeConfidence: 0.5,
    boxCohesion01: 0,
    trendWeaknessScore: 0,
    breakoutFailureRate: 0,
    rangeOscillationScore: 0,
    candles: mockCandles
  };

  const v2Input = adaptV2Input(
    "BTCUSDT" as any,
    now,
    snapshotAdapter,
    { baseSizeUsd: 100 } as any,
    { currentPositions: [] } as any,
    { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: false } as any
  );

  allOk = run(
    "CASE E - Real 0 boxCohesion01 preserved as 0",
    v2Input.snapshot.boxCohesion01 === 0,
    `boxCohesion01=${v2Input.snapshot.boxCohesion01} (expected exactly 0)`
  ) && allOk;

  allOk = run(
    "CASE E - Real 0 trendWeaknessScore preserved as 0",
    v2Input.snapshot.trendWeaknessScore === 0,
    `trendWeaknessScore=${v2Input.snapshot.trendWeaknessScore} (expected exactly 0)`
  ) && allOk;
}

// =========================================================================
// CASE F: Missing / undefined input falls back safely without throw
// =========================================================================
{
  const now = Date.now();
  const emptySnapshot: any = {
    lastPrice: 3000,
    latestCandleClose: 3000,
    candles: mockCandles
  };

  const v2Input = adaptV2Input(
    "BTCUSDT" as any,
    now,
    emptySnapshot,
    { baseSizeUsd: 100 } as any,
    { currentPositions: [] } as any,
    { regime: "RANGE", decision: "SKIP", side: "none", isBlocked: false } as any
  );

  allOk = run(
    "CASE F - Missing boxCohesion01 falls back to 0",
    v2Input.snapshot.boxCohesion01 === 0,
    `boxCohesion01=${v2Input.snapshot.boxCohesion01}`
  ) && allOk;

  allOk = run(
    "CASE F - Missing trendWeaknessScore falls back to 0",
    v2Input.snapshot.trendWeaknessScore === 0,
    `trendWeaknessScore=${v2Input.snapshot.trendWeaknessScore}`
  ) && allOk;
}

// =========================================================================
// CASE G: BTC/ETH global rangeConfidence sharing behavior is preserved
// =========================================================================
{
  const now = Date.now();
  const globalRangeConfidence = 0.6019897888335872;

  const btcSnap: any = {
    symbol: "BTCUSDT",
    lastPrice: 90000,
    latestCandleClose: 90000,
    rangeConfidence: globalRangeConfidence,
    boxCohesion01: 0.88,
    trendWeaknessScore: 0.35,
    candles: mockCandles
  };

  const ethSnap: any = {
    symbol: "ETHUSDT",
    lastPrice: 3000,
    latestCandleClose: 3000,
    rangeConfidence: globalRangeConfidence,
    boxCohesion01: 0.88,
    trendWeaknessScore: 0.35,
    candles: mockCandles
  };

  const btcInput = adaptV2Input("BTCUSDT" as any, now, btcSnap, {} as any, { currentPositions: [] } as any, {} as any);
  const ethInput = adaptV2Input("ETHUSDT" as any, now, ethSnap, {} as any, { currentPositions: [] } as any, {} as any);

  allOk = run(
    "CASE G - BTC and ETH both receive global rangeConfidence",
    btcInput.snapshot.rangeConfidence === globalRangeConfidence &&
    ethInput.snapshot.rangeConfidence === globalRangeConfidence,
    `btc=${btcInput.snapshot.rangeConfidence}, eth=${ethInput.snapshot.rangeConfidence}`
  ) && allOk;
}

console.log("\n=== BLOCKER 4-9 SUMMARY ===");
if (allOk) {
  console.log("ALL_RELEVANT_REGRESSION = PASS");
  console.log("READY_TO_COMMIT_BLOCKER_4_9 = YES");
} else {
  console.error("ALL_RELEVANT_REGRESSION = FAIL");
  console.error("READY_TO_COMMIT_BLOCKER_4_9 = NO");
  process.exit(1);
}
