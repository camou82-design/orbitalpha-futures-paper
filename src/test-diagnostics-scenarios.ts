import { evaluatePaperSymbolEntry, EvaluatePaperSymbolEntryInput, SymbolSnapshotLike } from "./engine/paper-symbol-decision";
import { MarketSymbol } from "./models/types";
import { RiskControlDecision } from "./engine/risk-control-layer";

// 기본 config 모킹
const mockConfig = {
  symbols: ["BTCUSDT", "ETHUSDT"],
  leverage: 10,
  longOnly: false,
  fees: { maker: 0.0002, taker: 0.0005 },
  paperTakerFeeRate: 0.0005,
  paperFundingIntervalHours: 8,
  dataDir: "./data",
  logLevel: "error" as const,
  paperEntryRelaxed: false,
  paperGateMinMoveMultiplier: 1.0,
  paperRequireHigherTfAlign: false,
  paperQualityMinScore: 35,
  paperQualityMinScoreWeak: 35,
  paperMaxOpenPositions: 3,
  paperStrongEmaGapThreshold: 0.0035,
  paperSidewaysEmaGapThreshold: 0.0035,
  paperReentryCooldownMs: 60000,
  rangeRebalanceMinHoldMs: 10000,
  paperBaseSizeUsd: 100,
  paperAccountEquityUsd: null,
  paperEntryNotionalTargetFrac: 1.0,
  rangeRebalanceBoxBreakConfirmTicks: 2,
  rangeRebalanceProfitArmPnlPct: 0.01,
  rangeRebalanceSecuredMinPnlPct: 0,
  rangeRebalanceTrailPullbackSpanFrac: 0.1,
  rangeRebalanceTrailPullbackMinPriceFrac: 0.001,
  rangeRebalanceTrailAtrMult: 2.0,
  rangeRebalanceTrailMaxArmedNoLockMs: 30000,
  paperSlippageBps: 10,
  paperDailyLossLimitUsd: 1000,
  paperLast10NetDegradeThresholdUsd: 100,
  paperDegradeSizeMultiplier: 0.5,
  paperModeLossStreakSuspendCount: 5,
  paperModeLossStreakSoftCount: 3,
  paperModeSuspendMs: 3600000,
  paperModeHardSuspendMs: 1800000,
  aiBlockGoodThresholdPct: -0.25,
  aiBlockMissedThresholdPct: 0.35,
  aiBlockEvaluationHorizonPriorityMins: [30, 15, 5] as any,
  paperEngineMode: "PAPER_TEST" as const,
  paperMinEdgeRr: 1.0,
  paperMinEdgeVolatilityMove: 0.00003,
  paperFeeDragWeakShortfallPctMin: 0.05,
  paperFeeDragWeakEmRatioMax: 0.5,
  paperFeeDragTailSizeMult: 1.0,
  paperFeeDragBlockEmRatioMax: 0.2,
  paperFeeDragBlockShortfallUsdMin: 10,
  paperFeeDragBlockShortfallPctMin: 0.05,
  paperFixedTotalCostUsd: null,
  okxDemoEnvRequested: true,
  okxExchangeAuthOptIn: true,
  okxDemoEnabled: true,
  okxLiveEnabled: false,
  okxAuthMode: "demo" as const,
  okxAuthReady: true,
  okxSimulatedTradingHeaderEnabled: false,
  okxLiveMaxOrderNotionalUsdt: null,
  okxLiveMaxAddonNotionalUsdt: null,
  okxLiveMaxSymbolNotionalUsdt: null,
  okxLiveMaxAccountNotionalUsdt: null,
  okxLiveMaxAddonCount: null,
  okxLiveEmergencyMaxOrderNotionalUsdt: null,
  okxLiveMarginReserveRatio: 0.2,
  okxLiveStaticNotionalCapEnabled: true,
  okxLiveUsableBalanceRatio: 0.95,
  okxMomentumIocSlippagePct: 0.0003,
  okxPassiveEntryTtlMs: 15_000,
  okxDemoBaseUrl: "https://www.okx.com",
  okxBaseUrl: "https://www.okx.com",
  okxApiKey: "",
  okxApiSecret: "",
  okxPassphrase: "",
  okxDemoApiKey: "demo_key",
  okxDemoApiSecret: "demo_secret",
  okxDemoPassphrase: "demo_passphrase",
  externalMarketContextEnabled: false,
  externalMarketContextShadowMode: true,
  externalMarketContextFetchEnabled: false,
  externalMarketContextWeight: 0.22,
  externalMarketMinSizeMultiplier: 0.8,
  externalMarketMaxSizeMultiplier: 1.1,
  externalMarketContextMaxAgeMs: 900_000,
  externalMarketEmergencyEventEnabled: false,
  externalMarketContextFetchIntervalMs: 120_000,
  externalMarketContextFetchTimeoutMs: 4_000,
  externalMarketContextNewsMaxAgeHours: 6,
  externalMarketContextNewsHalfLifeHours: 2,
  externalMarketContextNewsMaxWeight: 0.15,
  externalMarketContextNewsApiKey: null
};


// 기본 리스크 컨트롤 모킹
const mockRisk: RiskControlDecision = {
  engineBlocked: false,
  engineBlockReasons: [],
  blockedRegimes: {},
  recentLossStreakByMode: {},
  sizeMultiplier: 1.0,
  riskStatus: "NORMAL",
  dailyLossGuardTriggered: false,
  crashState: "NONE",
  crashReason: null,
  crashLockUntil: 0,
  pumpState: "NONE",
  pumpReason: null,
  pumpLockUntil: 0,
  directionalShockState: "NONE",
  isLatePursuit: false,
  isLateChase: false,
  longAllow: true,
  shortAllow: true,
  longSizeMult: 1.0,
  shortSizeMult: 1.0,
  detail: {}
};

function runTestScenario(name: string, overrides: Partial<EvaluatePaperSymbolEntryInput>) {
  console.log(`\n======================================================`);
  console.log(`[TEST SCENARIO] ${name}`);
  console.log(`======================================================`);

  const mergedInput: EvaluatePaperSymbolEntryInput = {
    config: mockConfig,
    snapshot: null,
    dataReady: true,
    regime: "RANGE",
    regimeUnknown: false,
    isAmbiguous: false,
    risk: mockRisk,
    adaptiveMode: "sideways",
    adaptiveDetail: { bias: "flat" },
    now: Date.now(),
    rangeCooldownUntilByKey: new Map(),
    trendCooldownUntilBySymbol: new Map(),
    lastCloseMetaBySymbol: new Map(),
    reentryCooldownMs: 60000,
    sameDirCooldownMult: 1.5,
    hasOpenPosition: false,
    openPositionsTotal: 0,
    currentStage: 0,
    maxPositionsReached: false,
    routingActiveEngine: "RANGE", // FORCE STAGE0
    authority: {
      decision: "SKIP",
      side: "none",

      stageMarginKrw: 300_000, // 300,000 KRW (enough size for threshold)
      regime: "RANGE",
      source: "v1",
      leverageProfile: "BASE",
      appliedLeverage: 10,
      leverageReason: "mock",
      exposureNotionalKrw: 3000000,
      equityMultiple: 1.0,
      entryQualityGrade: "B",
      addOnAllowed: false,
      invalidationPx: null,
      stopPrice: null
    },
    ...overrides
  };



  // snapshot에 누락된 구조 지표들 보강 (sideways 필터 조건 충족)
  if (mergedInput.snapshot) {
    const sn = mergedInput.snapshot as any;
    if (sn.ema20 === undefined) sn.ema20 = sn.lastPrice * 0.995;
    if (sn.ema60 === undefined) sn.ema60 = sn.lastPrice * 0.990;
    if (sn.volumeRatioProxy === undefined) sn.volumeRatioProxy = 1.05;
    if (sn.qualityScore === undefined) sn.qualityScore = 55;
    if (sn.emaGap === undefined) sn.emaGap = Math.abs(sn.ema20 - sn.ema60) / sn.ema60;
  }




  const res = evaluatePaperSymbolEntry(mergedInput);

  console.log(`>> Final Decision: ${res.decision.final_decision}`);
  console.log(`>> Reject Reason: ${res.decision.reject_reason}`);
  console.log(`>> Result Code: ${res.decision.stage1_result_code}`);
  console.log(`>> Final Block Layer: ${res.decision.diag_final_block_layer}`);
  console.log(`>> Final Block Reason: ${res.decision.diag_final_block_reason}`);
  console.log(`>> Long Candidate Created: ${res.decision.diag_long_candidate_created}`);
  console.log(`>> Short Candidate Created: ${res.decision.diag_short_candidate_created}`);
  console.log(`>> Long Rejected Reasons:`, res.decision.diag_long_rejected_reasons);
  console.log(`>> Short Rejected Reasons:`, res.decision.diag_short_rejected_reasons);
  console.log(`>> BTC Bias: ${res.decision.diag_btc_bias}`);
}

// -----------------------------------------------------------------------------
// [시나리오 A] RANGE upper + 직전 고점 이하 + 하락 종가 (숏 허용)
// -----------------------------------------------------------------------------
const mockSnapshotA: Partial<SymbolSnapshotLike> = {
  symbol: "BTCUSDT",
  lastPrice: 95000,
  latestCandleClose: 95000,
  boxHigh: 96000,
  boxLow: 90000,
  boxPos: 0.85, // upper zone
  rangeConfidence: 0.5,
  boxCohesion01: 0.6,
  rangeOscillationScore: 0.5,
  breakoutFailureRate: 0.5,
  regimeStateDiag: "RANGE",
  signal: "paper_long_candidate",
  candles: [
    { ts: Date.now() - 60000, open: 95100, high: 95300, low: 95000, close: 95100, volume: 100 },
    { ts: Date.now(), open: 95100, high: 95200, low: 94800, close: 94900, volume: 100 } // 하락 종가 + 낮아진 고점
  ]
};
runTestScenario("A. RANGE upper + 직전 고점 이하 + 하락 종가 (숏 허용)", {
  snapshot: mockSnapshotA as any,
  regime: "RANGE",
  adaptiveMode: "sideways",
  adaptiveDetail: { bias: "flat" }
});

// -----------------------------------------------------------------------------
// [시나리오 B] RANGE upper + 직전 고점 소폭 돌파 + 긴 윗꼬리 + 하락 종가 (축소 숏 허용 가능)
// -----------------------------------------------------------------------------
const mockSnapshotB: Partial<SymbolSnapshotLike> = {
  symbol: "BTCUSDT",
  lastPrice: 95000,
  latestCandleClose: 95000,
  boxHigh: 96000,
  boxLow: 90000,
  boxPos: 0.85, // upper zone
  rangeConfidence: 0.40, // watch tier 유도 (reversal score가 45 ~ 74가 되도록 낮춤)
  boxCohesion01: 0.35,
  rangeOscillationScore: 0.35,
  breakoutFailureRate: 0.5,
  regimeStateDiag: "RANGE",
  signal: "paper_long_candidate",
  candles: [
    { ts: Date.now() - 60000, open: 95100, high: 95200, low: 95000, close: 95100, volume: 100 },
    { ts: Date.now(), open: 95100, high: 95300, low: 94800, close: 94900, volume: 100 } // 하락 종가 + 고점 돌파 + 긴 윗꼬리 (high 95300 > 95200, close 94900 < 95100)
  ]
};
runTestScenario("B. RANGE upper + 직전 고점 소폭 돌파 + 긴 윗꼬리 + 하락 종가 (축소 숏 허용 가능)", {
  snapshot: mockSnapshotB as any,
  regime: "RANGE",
  adaptiveMode: "sideways",
  adaptiveDetail: { bias: "flat" }
});

// -----------------------------------------------------------------------------
// [시나리오 C] RANGE upper + 고점 돌파 + 강한 양봉 마감 (숏 차단)
// -----------------------------------------------------------------------------
const mockSnapshotC: Partial<SymbolSnapshotLike> = {
  symbol: "BTCUSDT",
  lastPrice: 95500,
  latestCandleClose: 95500,
  boxHigh: 96000,
  boxLow: 90000,
  boxPos: 0.85,
  rangeConfidence: 0.5,
  boxCohesion01: 0.6,
  rangeOscillationScore: 0.5,
  breakoutFailureRate: 0.5,
  regimeStateDiag: "RANGE",
  signal: "paper_long_candidate",
  candles: [
    { ts: Date.now() - 60000, open: 95000, high: 95100, low: 94900, close: 95000, volume: 100 },
    { ts: Date.now(), open: 95000, high: 95600, low: 95000, close: 95500, volume: 100 } // 상승 종가 + 강한 양봉
  ]
};
runTestScenario("C. RANGE upper + 고점 돌파 + 강한 양봉 마감 (숏 차단)", {
  snapshot: mockSnapshotC as any,
  regime: "RANGE",
  adaptiveMode: "sideways",
  adaptiveDetail: { bias: "flat" }
});

// -----------------------------------------------------------------------------
// [시나리오 D] RANGE lower + 직전 저점 소폭 이탈 + 긴 아래꼬리 + 상승 종가 (축소 롱 허용 가능)
// -----------------------------------------------------------------------------
const mockSnapshotD: Partial<SymbolSnapshotLike> = {
  symbol: "BTCUSDT",
  lastPrice: 91000,
  latestCandleClose: 91000,
  boxHigh: 96000,
  boxLow: 90000,
  boxPos: 0.15, // lower zone
  rangeConfidence: 0.40, // watch tier 유도
  boxCohesion01: 0.35,
  rangeOscillationScore: 0.35,
  breakoutFailureRate: 0.5,
  regimeStateDiag: "RANGE",
  signal: "paper_short_candidate",
  candles: [
    { ts: Date.now() - 60000, open: 91100, high: 91200, low: 91000, close: 91100, volume: 100 },
    { ts: Date.now(), open: 91100, high: 91200, low: 90700, close: 91150, volume: 100 } // 상승 종가 + 저점 돌파 + 긴 아래꼬리 (low 90700 < 91000, close 91150 > 91100)
  ]
};
runTestScenario("D. RANGE lower + 직전 저점 소폭 이탈 + 긴 아래꼬리 + 상승 종가 (축소 롱 허용 가능)", {
  snapshot: mockSnapshotD as any,
  regime: "RANGE",
  adaptiveMode: "sideways",
  adaptiveDetail: { bias: "flat" },
  authority: {
    decision: "SKIP",
    side: "none",
    stageMarginKrw: 300_000,
    regime: "RANGE",
    source: "v1",
    leverageProfile: "BASE",
    appliedLeverage: 10,
    leverageReason: "mock",
    exposureNotionalKrw: 3000000,
    equityMultiple: 1.0,
    entryQualityGrade: "B",
    addOnAllowed: false,
    invalidationPx: null,
    stopPrice: null
  }
});



// -----------------------------------------------------------------------------
// [시나리오 E] RANGE middle (관망)
// -----------------------------------------------------------------------------
const mockSnapshotE: Partial<SymbolSnapshotLike> = {
  symbol: "BTCUSDT",
  lastPrice: 93000,
  latestCandleClose: 93000,
  boxHigh: 96000,
  boxLow: 90000,
  boxPos: 0.5, // mid zone
  rangeConfidence: 0.5,
  boxCohesion01: 0.6,
  rangeOscillationScore: 0.5,
  breakoutFailureRate: 0.5,
  regimeStateDiag: "RANGE",
  signal: "paper_long_candidate",
  candles: []
};
runTestScenario("E. RANGE middle (관망)", {
  snapshot: mockSnapshotE as any,
  regime: "RANGE",
  adaptiveMode: "sideways",
  adaptiveDetail: { bias: "flat" }
});

// -----------------------------------------------------------------------------
// [시나리오 F] directionalShockState UP 또는 DOWN (기존 하드 차단 유지)
// -----------------------------------------------------------------------------
const mockSnapshotF: Partial<SymbolSnapshotLike> = {
  symbol: "BTCUSDT",
  lastPrice: 95000,
  latestCandleClose: 95000,
  boxHigh: 96000,
  boxLow: 90000,
  boxPos: 0.85,
  rangeConfidence: 0.5,
  boxCohesion01: 0.6,
  rangeOscillationScore: 0.5,
  breakoutFailureRate: 0.5,
  regimeStateDiag: "RANGE",
  signal: "paper_long_candidate",
  candles: []
};
runTestScenario("F. directionalShockState UP 또는 DOWN (기존 하드 차단 유지)", {
  snapshot: mockSnapshotF as any,
  regime: "RANGE",
  adaptiveMode: "sideways",
  adaptiveDetail: { bias: "flat" },
  risk: {
    ...mockRisk,
    directionalShockState: "UP" // UP shock
  }
});

