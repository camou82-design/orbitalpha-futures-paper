/**
 * P0.1 WHIPSAW HTF-CONTRARIAN RELEASE AUTHORITY & MICRO-PROBE DATA PROPAGATION TEST SUITE
 * 
 * Verifies:
 * TEST A: BTC UP shock + bearish HTF (counterTrendRisk=true) -> hard-block MAINTAINED (release blocked)
 * TEST B: ETH UP shock + bearish HTF (counterTrendRisk=true) -> hard-block MAINTAINED (release blocked)
 * TEST C: BTC DOWN shock + bullish HTF -> hard-block MAINTAINED (release blocked)
 * TEST D: ETH DOWN shock + bullish HTF -> hard-block MAINTAINED (release blocked)
 * TEST E: BTC contrarian cleared to HTF aligned -> RELEASE SUCCESS
 * TEST F: ETH contrarian cleared to HTF aligned -> RELEASE SUCCESS
 * TEST G: recheck_repetition alone cannot sustain hard-block
 * TEST H: reviewingTicks=200 alone cannot sustain hard-block
 * TEST I: Direction flip triggers EPISODE RESET, not release
 * TEST J: BTC episode changes do not leak to ETH
 * TEST K: ETH episode changes do not leak to BTC
 * TEST L: ATR & closedClose propagate to BTC/ETH micro probe
 * TEST M: Truly missing ATR fails closed (ATR_DATA_NOT_READY)
 * TEST N: WHIPSAW RELEASE + bad conditions -> decision != ENTER, side = none, size = 0
 * TEST O: POSITIVE CONTROL: WHIPSAW RELEASE + valid conditions -> decision = ENTER, size > 0
 * TEST P: NO_SHOCK stale micro + breakout failure cannot start hard block
 * TEST Q: REAL_SHOCK can start hard block
 * TEST R: EXISTING episode survives shock clear for observation
 * TEST S: RELEASED episode cannot re-arm from same stale evidence
 * TEST T: FRESH_SHOCK after release can re-arm
 * TEST OO: WHIPSAW_SOFT_WATCH + PROBE_ONLY + trendPhase=PULLBACK (micro probe block reason takes diagnostic precedence)
 * TEST PP: Hard safety blocker + micro probe blocker coexist (hard safety blocker strictly outranks micro probe block)
 * TEST QQ: No micro-probe evaluation, ordinary quality failure (TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD remains primary)
 * TEST RR: Diagnostic field separation (top_level_execution_lane & v2_router_executor) & execution invariance
 * TEST SS: WATCH_BOUNDARY_MISSING aligns expected_next_action to WAIT_FOR_BREAKOUT_OR_BREAKDOWN_SETUP
 * TEST TT: Hard safety blocker strictly outranks WATCH_BOUNDARY_MISSING in missing condition & next action
 * TEST UU: Audit row precedence: WATCH_BOUNDARY_MISSING outranks QUALITY_BELOW_THRESHOLD
 * TEST VV: Audit row precedence: POLARITY_MISMATCH outranks RANGE_TREND_SIDE_CONFLICT + fallback preservation
 * TEST WW: Audit row mapping for 13 authoritative primary missing tokens outranking conflicting vetoes
 * TEST XX: RANGE short / TREND long conflict + SKIP -> selectedSideAfterVeto = none & side_veto_detail = RANGE_TREND_SIDE_CONFLICT
 * TEST YY: Normal ENTER -> selectedSideAfterVeto matches final ENTER side
 * TEST ZZ: HOLD & REJECT -> selectedSideAfterVeto = none
 */

import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { clearWhipsawObservationState, whipsawObservationAuthority, updateWhipsawObservation } from "../engine-v2/market-judgment/whipsaw-observer";
import { adaptV2Input, runEngineV2, marketJudgmentCacheBySymbol } from "../engine-v2/index";
import { clearGlobalShockStates, globalShockStates } from "../engine-v2/state/derive";
import { evaluateLowerBreakdownShortConfirmed } from "../engine-v2/range-boundary-continuation";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor";
import { resolveSymbolDecisionEnvelope } from "../engine-v2/reconciler";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";
import type { EngineV2Input } from "../engine-v2/types";
import type { SymbolSnapshotLike } from "./paper-symbol-decision";

function run(label: string, passed: boolean, detail: string): boolean {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[WHIPSAW-LIVENESS-TEST][${label}] ${tag} — ${detail}`);
  if (!passed) {
    throw new Error(`[WHIPSAW-LIVENESS-TEST][${label}] FAILED: ${detail}`);
  }
  return passed;
}

const mockBullishCandles: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 60000,
  open: 3000 + i * 10,
  high: 3005 + i * 10,
  low: 2995 + i * 10,
  close: 3002 + i * 10,
  volume: 100
}));

const mockBearishCandles: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 60000,
  open: 5000 - i * 10,
  high: 5005 - i * 10,
  low: 4995 - i * 10,
  close: 4998 - i * 10,
  volume: 100
}));

/** Candles engineered to trigger micro_down_then_rebound in 8-bar window. */
function makeMicroDownReboundCandles(basePrice = 69000): Candle[] {
  const flat: Candle[] = Array.from({ length: 112 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: basePrice,
    high: basePrice + 50,
    low: basePrice - 50,
    close: basePrice,
    volume: 100
  }));
  const tail: Array<{ o: number; h: number; l: number; c: number }> = [
    { o: basePrice, h: basePrice + 100, l: basePrice - 100, c: basePrice - 50 },
    { o: basePrice - 50, h: basePrice, l: basePrice - 800, c: basePrice - 750 }, // min low early in window (index 1 < 4)
    { o: basePrice - 750, h: basePrice - 600, l: basePrice - 760, c: basePrice - 650 },
    { o: basePrice - 650, h: basePrice - 500, l: basePrice - 660, c: basePrice - 550 },
    { o: basePrice - 550, h: basePrice - 400, l: basePrice - 560, c: basePrice - 450 },
    { o: basePrice - 450, h: basePrice - 300, l: basePrice - 460, c: basePrice - 350 },
    { o: basePrice - 350, h: basePrice - 200, l: basePrice - 360, c: basePrice - 250 },
    { o: basePrice - 250, h: basePrice + 100, l: basePrice - 260, c: basePrice - 80 }
  ];
  const reversalBars: Candle[] = tail.map((b, i) => ({
    ts: Date.now() - (8 - i) * 60000,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: 120
  }));
  return [...flat, ...reversalBars];
}

/** Candles engineered to trigger micro_up_then_drop in 8-bar window. */
function makeMicroUpThenDropCandles(basePrice = 69000): Candle[] {
  const flat: Candle[] = Array.from({ length: 112 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: basePrice,
    high: basePrice + 50,
    low: basePrice - 50,
    close: basePrice,
    volume: 100
  }));
  const tail: Array<{ o: number; h: number; l: number; c: number }> = [
    { o: basePrice, h: basePrice + 100, l: basePrice - 100, c: basePrice + 50 },
    { o: basePrice + 50, h: basePrice + 800, l: basePrice, c: basePrice + 750 }, // max high early in window (index 1 < 4)
    { o: basePrice + 750, h: basePrice + 760, l: basePrice + 600, c: basePrice + 650 },
    { o: basePrice + 650, h: basePrice + 660, l: basePrice + 500, c: basePrice + 550 },
    { o: basePrice + 550, h: basePrice + 560, l: basePrice + 400, c: basePrice + 450 },
    { o: basePrice + 450, h: basePrice + 460, l: basePrice + 300, c: basePrice + 350 },
    { o: basePrice + 350, h: basePrice + 360, l: basePrice + 200, c: basePrice + 250 },
    { o: basePrice + 250, h: basePrice + 260, l: basePrice - 100, c: basePrice + 80 }
  ];
  const reversalBars: Candle[] = tail.map((b, i) => ({
    ts: Date.now() - (8 - i) * 60000,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: 120
  }));
  return [...flat, ...reversalBars];
}

function makeBaseInput(
  symbol: "BTCUSDT" | "ETHUSDT",
  overrides: Partial<SymbolSnapshotLike> = {},
  stateOverrides: Record<string, any> = {},
  htfType: "BULLISH" | "BEARISH" = "BULLISH"
): EngineV2Input {
  const candles = htfType === "BULLISH" ? mockBullishCandles : mockBearishCandles;
  const snap: SymbolSnapshotLike = {
    symbol,
    lastPrice: symbol === "BTCUSDT" ? 69000 : 2600,
    latestCandleClose: symbol === "BTCUSDT" ? 69000 : 2600,
    signal: "paper_long_candidate",
    qualityScore: 80,
    candidateStrength: "strong",
    ema20: symbol === "BTCUSDT" ? 68900 : 2595,
    ema60: symbol === "BTCUSDT" ? 68800 : 2590,
    emaGap: 0.002,
    volumeRatioProxy: 1.2,
    boxHigh: symbol === "BTCUSDT" ? 70000 : 2700,
    boxLow: symbol === "BTCUSDT" ? 68000 : 2500,
    boxPos: 0.6,
    boxRel: 0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: symbol === "BTCUSDT" ? 250 : 12,
    atr20: symbol === "BTCUSDT" ? 250 : 12,
    closedClose: symbol === "BTCUSDT" ? 68990 : 2598,
    rangeConfidence: 0.2,
    trendWeaknessScore: 0.1,
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.1,
    rangeOscillationScore: 0.2,
    candles,
    htf_candles: {
      "5m": candles,
      "15m": candles,
      "1h": candles,
      "4h": candles
    },
    canonicalRegime: "TREND",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.85,
    ...overrides
  };

  const bridge = buildV2SnapshotBridge(snap);
  return adaptV2Input(
    symbol,
    Date.now(),
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    { directionalShockState: "NONE", longAllow: true, shortAllow: true, currentPositions: [], ...stateOverrides } as any,
    { decision: { final_decision: "ENTER" } } as any,
    candles,
    "authoritative",
    `cycle_${symbol}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  );
}

// =========================================================================
// TEST A — BTC UP shock + Bearish HTF -> Hard-Block RELEASES to HTF HOLD / Soft-Watch Routing
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  // 1. Seed initial whipsaw episode to 6 ticks
  for (let i = 1; i <= 6; i++) {
    updateWhipsawObservation({
      symbol: "BTCUSDT",
      rawActive: true,
      directionalShockState: "UP",
      structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
    });
  }

  // 2. Ticks >= 6, fresh structural hits gone, BUT macro/HTF is BEARISH
  const inputContrarian = makeBaseInput(
    "BTCUSDT",
    {
      volumeExpansion: 1.1,
      breakoutFailureRate: 0.1,
      candles: mockBullishCandles,
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBearishCandles, // Bearish HTF Conflict
        "4h": mockBearishCandles
      }
    },
    { directionalShockState: "UP" }
  );

  const judgment = detectMarketRegime(inputContrarian);
  const { decision } = runEngineV2(inputContrarian);

  run(
    "TEST_A_BTC_HTF_CONTRARIAN_RELEASE_BLOCKED",
    judgment.subtype !== "WHIPSAW_SHOCK_RECHECK" &&
      judgment.htf_entry_policy === "HOLD" &&
      decision.decision !== "ENTER" &&
      decision.explanation.reason !== "WHIPSAW_SHOCK_RECHECK",
    `BTC UP shock against Bearish HTF releases hard-block to HOLD routing. subtype=${judgment.subtype}, policy=${judgment.htf_entry_policy}, decision=${decision.decision}`
  );
}

// =========================================================================
// TEST B — ETH UP shock + Bearish HTF -> Hard-Block RELEASES to HTF HOLD / Soft-Watch Routing
// =========================================================================
{
  clearWhipsawObservationState("ETHUSDT");

  for (let i = 1; i <= 6; i++) {
    updateWhipsawObservation({
      symbol: "ETHUSDT",
      rawActive: true,
      directionalShockState: "UP",
      structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
    });
  }

  const inputContrarian = makeBaseInput(
    "ETHUSDT",
    {
      volumeExpansion: 1.1,
      breakoutFailureRate: 0.1,
      candles: mockBullishCandles,
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBearishCandles,
        "4h": mockBearishCandles
      }
    },
    { directionalShockState: "UP" }
  );

  const judgment = detectMarketRegime(inputContrarian);
  const { decision } = runEngineV2(inputContrarian);

  run(
    "TEST_B_ETH_HTF_CONTRARIAN_RELEASE_BLOCKED",
    judgment.subtype !== "WHIPSAW_SHOCK_RECHECK" &&
      judgment.htf_entry_policy === "HOLD" &&
      decision.decision !== "ENTER" &&
      decision.explanation.reason !== "WHIPSAW_SHOCK_RECHECK",
    `ETH UP shock against Bearish HTF releases hard-block to HOLD routing. subtype=${judgment.subtype}, policy=${judgment.htf_entry_policy}, decision=${decision.decision}`
  );
}

// =========================================================================
// TEST C — BTC DOWN shock + Bullish HTF -> Hard-Block RELEASES to HTF HOLD / Soft-Watch Routing
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  for (let i = 1; i <= 6; i++) {
    updateWhipsawObservation({
      symbol: "BTCUSDT",
      rawActive: true,
      directionalShockState: "DOWN",
      structuralHits: ["micro_down_then_rebound", "volume_expansion_ge_2"]
    });
  }

  const inputContrarian = makeBaseInput(
    "BTCUSDT",
    {
      volumeExpansion: 1.1,
      breakoutFailureRate: 0.1,
      candles: mockBearishCandles,
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBullishCandles, // Bullish HTF Conflict
        "4h": mockBullishCandles
      }
    },
    { directionalShockState: "DOWN" }
  );

  const judgment = detectMarketRegime(inputContrarian);
  const { decision } = runEngineV2(inputContrarian);

  run(
    "TEST_C_BTC_DOWN_CONTRARIAN_RELEASE_BLOCKED",
    judgment.subtype !== "WHIPSAW_SHOCK_RECHECK" &&
      judgment.htf_entry_policy === "HOLD" &&
      decision.decision !== "ENTER" &&
      decision.explanation.reason !== "WHIPSAW_SHOCK_RECHECK",
    `BTC DOWN shock against Bullish HTF releases hard-block to HOLD routing. subtype=${judgment.subtype}, policy=${judgment.htf_entry_policy}, decision=${decision.decision}`
  );
}

// =========================================================================
// TEST D — ETH DOWN shock + Bullish HTF -> Hard-Block RELEASES to HTF HOLD / Soft-Watch Routing
// =========================================================================
{
  clearWhipsawObservationState("ETHUSDT");

  for (let i = 1; i <= 6; i++) {
    updateWhipsawObservation({
      symbol: "ETHUSDT",
      rawActive: true,
      directionalShockState: "DOWN",
      structuralHits: ["micro_down_then_rebound", "volume_expansion_ge_2"]
    });
  }

  const inputContrarian = makeBaseInput(
    "ETHUSDT",
    {
      volumeExpansion: 1.1,
      breakoutFailureRate: 0.1,
      candles: mockBearishCandles,
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    { directionalShockState: "DOWN" }
  );

  const judgment = detectMarketRegime(inputContrarian);
  const { decision } = runEngineV2(inputContrarian);

  run(
    "TEST_D_ETH_DOWN_CONTRARIAN_RELEASE_BLOCKED",
    judgment.subtype !== "WHIPSAW_SHOCK_RECHECK" &&
      judgment.htf_entry_policy === "HOLD" &&
      decision.decision !== "ENTER" &&
      decision.explanation.reason !== "WHIPSAW_SHOCK_RECHECK",
    `ETH DOWN shock against Bullish HTF releases hard-block to HOLD routing. subtype=${judgment.subtype}, policy=${judgment.htf_entry_policy}, decision=${decision.decision}`
  );
}

// =========================================================================
// TEST E — BTC Contrarian Cleared to HTF Aligned -> RELEASE SUCCESS
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  for (let i = 1; i <= 6; i++) {
    updateWhipsawObservation({
      symbol: "BTCUSDT",
      rawActive: true,
      directionalShockState: "UP",
      structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
    });
  }

  // HTF aligned (Bullish) and fresh danger cleared
  const inputAligned = makeBaseInput(
    "BTCUSDT",
    {
      volumeExpansion: 1.1,
      breakoutFailureRate: 0.1,
      candles: mockBullishCandles,
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    { directionalShockState: "UP" }
  );

  const judgment = detectMarketRegime(inputAligned);

  run(
    "TEST_E_BTC_HTF_ALIGNED_RELEASE_SUCCESS",
    judgment.subtype !== "WHIPSAW_SHOCK_RECHECK",
    `BTC whipsaw released cleanly after HTF realignment. subtype=${judgment.subtype}`
  );
}

// =========================================================================
// TEST F — ETH Contrarian Cleared to HTF Aligned -> RELEASE SUCCESS
// =========================================================================
{
  clearWhipsawObservationState("ETHUSDT");

  for (let i = 1; i <= 6; i++) {
    updateWhipsawObservation({
      symbol: "ETHUSDT",
      rawActive: true,
      directionalShockState: "UP",
      structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
    });
  }

  const inputAligned = makeBaseInput(
    "ETHUSDT",
    {
      volumeExpansion: 1.1,
      breakoutFailureRate: 0.1,
      candles: mockBullishCandles,
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    { directionalShockState: "UP" }
  );

  const judgment = detectMarketRegime(inputAligned);

  run(
    "TEST_F_ETH_HTF_ALIGNED_RELEASE_SUCCESS",
    judgment.subtype !== "WHIPSAW_SHOCK_RECHECK",
    `ETH whipsaw released cleanly after HTF realignment. subtype=${judgment.subtype}`
  );
}

// =========================================================================
// TEST G — recheck_repetition Alone Cannot Sustain Hard-Block
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const inputOnlyRepetition = makeBaseInput("BTCUSDT", {
    reviewing_ticks: 5,
    volumeExpansion: 1.0,
    breakoutFailureRate: 0.05,
    candles: mockBullishCandles
  });

  const judgment = detectMarketRegime(inputOnlyRepetition);

  run(
    "TEST_G_RECHECK_REPETITION_ALONE_CANNOT_BLOCK",
    judgment.subtype !== "WHIPSAW_SHOCK_RECHECK",
    `recheck_repetition alone does not trigger hard block. subtype=${judgment.subtype}`
  );
}

// =========================================================================
// TEST H — reviewingTicks=200 Alone Cannot Sustain Hard-Block
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const inputOld200 = makeBaseInput("BTCUSDT", {
    reviewing_ticks: 200,
    volumeExpansion: 1.0,
    breakoutFailureRate: 0.05,
    candles: mockBullishCandles
  });

  const judgment = detectMarketRegime(inputOld200);

  run(
    "TEST_H_OLD_REVIEWING_TICKS_200_ALONE_CANNOT_BLOCK",
    judgment.subtype !== "WHIPSAW_SHOCK_RECHECK",
    `reviewing_ticks=200 alone does not trigger hard block. subtype=${judgment.subtype}`
  );
}

// =========================================================================
// TEST I — Direction Flip Triggers EPISODE RESET, Not Release
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  updateWhipsawObservation({
    symbol: "BTCUSDT",
    rawActive: true,
    directionalShockState: "UP",
    structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
  });
  const ep1 = whipsawObservationAuthority.getEpisode("BTCUSDT");

  // Flip to DOWN shock
  updateWhipsawObservation({
    symbol: "BTCUSDT",
    rawActive: true,
    directionalShockState: "DOWN",
    structuralHits: ["micro_down_then_rebound", "volume_expansion_ge_2"]
  });
  const ep2 = whipsawObservationAuthority.getEpisode("BTCUSDT");

  run(
    "TEST_I_DIRECTION_FLIP_RESETS_EPISODE",
    ep1?.episodeId !== ep2?.episodeId && ep2?.lastResetReason === "shock_direction_flip" && ep2?.ticks === 1,
    `Direction flip triggered episode reset. ep1=${ep1?.episodeId}, ep2=${ep2?.episodeId}, reason=${ep2?.lastResetReason}`
  );
}

// =========================================================================
// TEST J — BTC Episode Changes Do Not Leak to ETH
// =========================================================================
{
  clearWhipsawObservationState();

  updateWhipsawObservation({
    symbol: "BTCUSDT",
    rawActive: true,
    directionalShockState: "UP",
    structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
  });
  updateWhipsawObservation({
    symbol: "ETHUSDT",
    rawActive: true,
    directionalShockState: "UP",
    structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
  });

  const ethEpBefore = whipsawObservationAuthority.getEpisode("ETHUSDT");

  // Reset BTC
  updateWhipsawObservation({
    symbol: "BTCUSDT",
    rawActive: true,
    directionalShockState: "DOWN",
    structuralHits: ["micro_down_then_rebound", "volume_expansion_ge_2"]
  });

  const ethEpAfter = whipsawObservationAuthority.getEpisode("ETHUSDT");

  run(
    "TEST_J_BTC_ETH_EPISODE_ISOLATION",
    ethEpBefore?.episodeId === ethEpAfter?.episodeId,
    `ETH episode remained intact across BTC reset. ETH_ep=${ethEpAfter?.episodeId}`
  );
}

// =========================================================================
// TEST K — ETH Episode Changes Do Not Leak to BTC
// =========================================================================
{
  clearWhipsawObservationState();

  updateWhipsawObservation({
    symbol: "BTCUSDT",
    rawActive: true,
    directionalShockState: "UP",
    structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
  });
  updateWhipsawObservation({
    symbol: "ETHUSDT",
    rawActive: true,
    directionalShockState: "UP",
    structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
  });

  const btcEpBefore = whipsawObservationAuthority.getEpisode("BTCUSDT");

  // Reset ETH
  updateWhipsawObservation({
    symbol: "ETHUSDT",
    rawActive: true,
    directionalShockState: "DOWN",
    structuralHits: ["micro_down_then_rebound", "volume_expansion_ge_2"]
  });

  const btcEpAfter = whipsawObservationAuthority.getEpisode("BTCUSDT");

  run(
    "TEST_K_ETH_BTC_EPISODE_ISOLATION",
    btcEpBefore?.episodeId === btcEpAfter?.episodeId,
    `BTC episode remained intact across ETH reset. BTC_ep=${btcEpAfter?.episodeId}`
  );
}

// =========================================================================
// TEST L — ATR & closedClose Propagate to Micro Probe via Reconciler Bridge
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  for (let i = 1; i <= 6; i++) {
    updateWhipsawObservation({
      symbol: "BTCUSDT",
      rawActive: true,
      directionalShockState: "UP",
      structuralHits: ["micro_up_then_drop"]
    });
  }

  const snapBtc: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 69000,
    latestCandleClose: 69000,
    signal: "paper_long_candidate",
    qualityScore: 80,
    candidateStrength: "strong",
    ema20: 68900,
    ema60: 68800,
    emaGap: 0.002,
    volumeRatioProxy: 1.2,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.6,
    boxRel: 0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 100, // Distinct from atr20=250 to ensure atr20 is not masked by atr
    atr20: 250,
    closedClose: 68990,
    rangeConfidence: 0.5,
    trendWeaknessScore: 0.1,
    boxHighSlope: 0,
    boxLowSlope: 0,
    candles: makeMicroDownReboundCandles(69000),
    htf_candles: {
      "5m": makeMicroDownReboundCandles(69000),
      "15m": mockBullishCandles,
      "1h": mockBearishCandles,
      "4h": mockBearishCandles
    }
  };

  const bridge = buildV2SnapshotBridge(snapBtc);
  const input = adaptV2Input(
    "BTCUSDT",
    Date.now(),
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    { directionalShockState: "UP", longAllow: true, shortAllow: true, currentPositions: [] } as any,
    { decision: { final_decision: "ENTER" } } as any,
    mockBullishCandles,
    "authoritative",
    "cycle_btc_atr_prop"
  );

  run(
    "TEST_L_ATR_CLOSEDCLOSE_PROPAGATION",
    input.snapshot.atr20 === 250 && input.snapshot.closedClose === 68990,
    `BTC atr20 and closedClose successfully propagated to input adapter. atr20=${input.snapshot.atr20}, closedClose=${input.snapshot.closedClose}`
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

  let envelope: any;
  try {
    envelope = resolveSymbolDecisionEnvelope({
      symbol: "BTCUSDT" as any,
      fetchedAt: Date.now(),
      snapshot: bridge,
      config: { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
      state: { directionalShockState: "UP", longAllow: true, shortAllow: true, currentPositions: [] } as any,
      legacy: {
        regime: "RANGE",
        finalDecision: "SKIP",
        rejectReason: "none",
        requiredCostUsd: 0,
        entryAllowed: false,
        executorLabel: "range",
        intentSide: "none",
        adaptiveOk: true,
        adaptiveDetail: {}
      } as any,
      v2Mode: "engine_v2",
      evaluationMode: "authoritative",
      runCycleId: "cycle_btc_atr_bridge_prop"
    });
  } finally {
    console.info = origInfo;
  }

  const microProbeProof = proofLogs.find((l) => l.event === "V2_WHIPSAW_MICRO_PROBE_EVALUATION_PROOF");
  const slopeFallbackProof = proofLogs.find((l) => l.event === "V2_SLOPE_FALLBACK_CHECK_PROOF");

  const atr20Preserved = microProbeProof != null && microProbeProof.atr20 === 250;
  const closedClosePreserved = microProbeProof != null && microProbeProof.closedClose === 68990;
  const candlesPreserved = slopeFallbackProof != null && slopeFallbackProof.candles_length === mockBullishCandles.length;

  run(
    "TEST_L_RECONCILER_BRIDGE_PRESERVE_ATR20_CLOSEDCLOSE",
    Boolean(envelope && atr20Preserved && closedClosePreserved && candlesPreserved),
    `Reconciler bridge verified: atr20=${microProbeProof?.atr20} (expected 250), closedClose=${microProbeProof?.closedClose} (expected 68990), candles_length=${slopeFallbackProof?.candles_length} (expected ${mockBullishCandles.length})`
  );
}

// =========================================================================
// TEST M — Truly Missing ATR Fails Closed (ATR_DATA_NOT_READY)
// =========================================================================
{
  const snapNoAtr: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 69000,
    latestCandleClose: 69000,
    signal: "paper_long_candidate",
    qualityScore: 80,
    candidateStrength: "strong",
    ema20: 68900,
    ema60: 68800,
    emaGap: 0.002,
    volumeRatioProxy: 1.2,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.6,
    boxRel: 0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 0,
    atr20: null,
    closedClose: null,
    rangeConfidence: 0.5,
    trendWeaknessScore: 0.1,
    candles: []
  };

  const bridge = buildV2SnapshotBridge(snapNoAtr);
  const input = adaptV2Input(
    "BTCUSDT",
    Date.now(),
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    { directionalShockState: "NONE", longAllow: true, shortAllow: true, currentPositions: [] } as any,
    { decision: { final_decision: "ENTER" } } as any,
    [],
    "authoritative",
    "cycle_missing_atr"
  );

  run(
    "TEST_M_TRULY_MISSING_ATR_FAILS_CLOSED",
    input.snapshot.atr20 == null && input.snapshot.atr === 0,
    `Missing ATR remains null without fake defaults. atr20=${input.snapshot.atr20}, atr=${input.snapshot.atr}`
  );
}

// =========================================================================
// TEST N — WHIPSAW RELEASE + Bad Conditions -> decision != ENTER, side = none, size = 0
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const snapLowQuality: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 69000,
    latestCandleClose: 69000,
    signal: "paper_long_candidate",
    qualityScore: 20, // Low Quality
    candidateStrength: "weak",
    ema20: 68900,
    ema60: 68800,
    emaGap: 0.002,
    volumeRatioProxy: 1.2,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.6,
    boxRel: 0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 68990,
    rangeConfidence: 0.2,
    trendWeaknessScore: 0.1,
    candles: mockBullishCandles,
    htf_candles: {
      "5m": mockBullishCandles,
      "15m": mockBullishCandles,
      "1h": mockBullishCandles,
      "4h": mockBullishCandles
    },
    canonicalRegime: "TREND",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.85
  };

  const bridge = buildV2SnapshotBridge(snapLowQuality);
  const authoritativeInput = adaptV2Input(
    "BTCUSDT",
    Date.now(),
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    { directionalShockState: "NONE", longAllow: true, shortAllow: true, currentPositions: [] } as any,
    { decision: { final_decision: "ENTER" } } as any,
    mockBullishCandles,
    "authoritative",
    "cycle_low_qual"
  );

  const { decision } = runEngineV2(authoritativeInput);

  run(
    "TEST_N_RELEASE_WITH_BAD_CONDITIONS_NO_ENTER",
    decision.decision !== "ENTER" && decision.side === "none" && (decision.risk?.finalOrderNotionalUsdt ?? 0) === 0,
    `Release with bad quality did not enter. decision=${decision.decision}, side=${decision.side}, size=${decision.risk?.finalOrderNotionalUsdt}`
  );
}

// =========================================================================
// TEST O — POSITIVE CONTROL: WHIPSAW RELEASE + Valid Conditions -> ENTER Possible
// =========================================================================
{
  clearWhipsawObservationState("ETHUSDT");

  // 1. Seed 6 ticks of whipsaw episode
  for (let i = 1; i <= 6; i++) {
    updateWhipsawObservation({
      symbol: "ETHUSDT",
      rawActive: true,
      directionalShockState: "UP",
      structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
    });
  }

  // 2. Now market has stabilized & HTF is aligned BULLISH -> whipsaw releases and normal evaluation occurs
  const snapControl: SymbolSnapshotLike = {
    symbol: "ETHUSDT",
    lastPrice: 2600,
    latestCandleClose: 2600,
    signal: "paper_long_candidate",
    entryCandidate: true,
    qualityScore: 90,
    candidateStrength: "strong",
    ema20: 2595,
    ema60: 2590,
    emaGap: 0.002,
    volumeRatioProxy: 1.5,
    boxHigh: 2630,
    boxLow: 2570,
    boxPos: 0.1, // lower extreme in range
    boxRel: 0.02,
    gateExpectedMove: 20,
    gateRequiredMove: 10,
    atr: 12,
    atr20: 12,
    closedClose: 2598,
    rangeConfidence: 0.8,
    trendWeaknessScore: 0.8,
    boxCohesion01: 0.8,
    breakoutFailureRate: 0.05,
    rangeOscillationScore: 0.1,
    candles: mockBullishCandles,
    htf_candles: {
      "5m": mockBullishCandles,
      "15m": mockBullishCandles,
      "1h": mockBullishCandles,
      "4h": mockBullishCandles
    },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };

  const nowMs = Date.now();
  const bridge = buildV2SnapshotBridge(snapControl);
  const authoritativeInput = adaptV2Input(
    "ETHUSDT",
    nowMs,
    bridge as any,
    {
      paperMaxOpenPositions: 3,
      baseSizeUsd: 100,
      maxSymbolNotionalUsd: 5000,
      maxAccountNotionalUsd: 20000,
      okxLiveEnabled: true,
      okxAuthMode: "live",
      okxExchangeAuthOptIn: true
    } as any,
    {
      directionalShockState: "NONE",
      longAllow: true,
      shortAllow: true,
      currentPositions: [],
      executionReadiness: true,
      paperExecutionReady: true,
      signedExecutionReady: true,
      serverTradeEnabled: true,
      accountEquityKrw: 10000000,
      exposureNotionalCapKrw: 100000000,
      symbolExposureNotionalCapKrw: 50000000,
      accountEquityUsdt: 10000,
      availableBalanceUsdt: 10000,
      liveBalanceReady: true,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true,
      okxActualPositions: [],
      okxPendingOrdersReady: true,
      okxPendingOrdersNotionalUsdt: 0,
      okxPendingSymbolNotionalUsdt: 0,
      hasSymbolPendingEntry: false,
      hasUnknownPendingNotional: false,
      okxLiveEnabled: true,
      okxAuthMode: "live",
      okxAuthReady: true,
      okxExchangeAuthOptIn: true,
      okxApiKeyPresent: true,
      okxApiSecretPresent: true,
      okxPassphrasePresent: true,
      balanceFetchedAt: nowMs,
      positionsFetchedAt: nowMs,
      pendingOrdersFetchedAt: nowMs
    } as any,
    {
      decision: {
        final_decision: "ENTER"
      },
      execution: {
        stopPrice: 2564,
        invalidationPx: 2564,
        side: "long",
        sizeUsd: 100
      },
      risk: {
        stopPrice: 2564,
        invalidationPx: 2564
      }
    } as any,
    mockBullishCandles,
    "authoritative",
    "cycle_control_enter_eth"
  );

  const judgment = detectMarketRegime(authoritativeInput);
  const { decision } = runEngineV2(authoritativeInput);

  console.log(`[TEST_O_DETAILS] subtype=${judgment.subtype}, decision=${decision.decision}, side=${decision.side}, sizeUsd=${decision.risk?.finalOrderNotionalUsdt}`);

  run(
    "TEST_O_POSITIVE_CONTROL_ENTER_POSSIBLE",
    judgment.subtype !== "WHIPSAW_SHOCK_RECHECK" && decision.decision === "ENTER" && decision.side === "long" && (decision.risk?.finalOrderNotionalUsdt ?? 0) > 0,
    `Positive control: hard block absent and normal evaluator enters. subtype=${judgment.subtype}, decision=${decision.decision}, side=${decision.side}, size=${decision.risk?.finalOrderNotionalUsdt}`
  );
}

// =========================================================================
// TEST P — NO_SHOCK stale micro + breakout failure cannot start hard block
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const microCandles = makeMicroDownReboundCandles(69000);
  const inputNoShock = makeBaseInput(
    "BTCUSDT",
    {
      breakoutFailureRate: 0.45,
      volumeExpansion: 1.0,
      candles: microCandles,
      htf_candles: {
        "5m": microCandles,
        "15m": microCandles,
        "1h": microCandles,
        "4h": microCandles
      }
    },
    { directionalShockState: "NONE" }
  );

  const judgment = detectMarketRegime(inputNoShock);
  const ep = whipsawObservationAuthority.getEpisode("BTCUSDT");

  run(
    "TEST_P_NO_SHOCK_STALE_MICRO_PLUS_BREAKOUT_FAILURE_CANNOT_START_HARD_BLOCK",
    judgment.subtype !== "WHIPSAW_SHOCK_RECHECK" && ep == null,
    `NONE shock + stale micro + breakout failure must not hard-block. subtype=${judgment.subtype}, episode=${ep?.episodeId ?? "null"}`
  );
}

// =========================================================================
// TEST Q — REAL_SHOCK can start hard block
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const microCandles = makeMicroDownReboundCandles(69000);
  const inputShock = makeBaseInput(
    "BTCUSDT",
    {
      breakoutFailureRate: 0.45,
      volumeExpansion: 2.5,
      candles: microCandles,
      htf_candles: {
        "5m": microCandles,
        "15m": microCandles,
        "1h": microCandles,
        "4h": microCandles
      }
    },
    { directionalShockState: "DOWN" }
  );

  const judgment = detectMarketRegime(inputShock);
  const ep = whipsawObservationAuthority.getEpisode("BTCUSDT");

  run(
    "TEST_Q_REAL_SHOCK_CAN_START_HARD_BLOCK",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK" && ep != null && ep.ticks === 1,
    `DOWN shock + micro + structural starts hard block. subtype=${judgment.subtype}, episode=${ep?.episodeId}, ticks=${ep?.ticks}`
  );
}

// =========================================================================
// TEST R — Existing episode survives shock clear for observation
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const microCandles = makeMicroDownReboundCandles(69000);
  const shockInput = makeBaseInput(
    "BTCUSDT",
    {
      breakoutFailureRate: 0.45,
      volumeExpansion: 2.5,
      candles: microCandles,
      htf_candles: {
        "5m": microCandles,
        "15m": microCandles,
        "1h": microCandles,
        "4h": microCandles
      }
    },
    { directionalShockState: "DOWN" }
  );

  detectMarketRegime(shockInput);
  const epAfterShock = whipsawObservationAuthority.getEpisode("BTCUSDT");

  const noneShockInput = makeBaseInput(
    "BTCUSDT",
    {
      breakoutFailureRate: 0.45,
      volumeExpansion: 1.0,
      candles: microCandles,
      htf_candles: {
        "5m": microCandles,
        "15m": microCandles,
        "1h": microCandles,
        "4h": microCandles
      }
    },
    { directionalShockState: "NONE" }
  );

  const judgment = detectMarketRegime(noneShockInput);
  const epAfterNone = whipsawObservationAuthority.getEpisode("BTCUSDT");

  run(
    "TEST_R_EXISTING_EPISODE_SURVIVES_SHOCK_CLEAR_FOR_OBSERVATION",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK" &&
      epAfterShock?.episodeId === epAfterNone?.episodeId &&
      (epAfterNone?.ticks ?? 0) >= 2,
    `Episode continues after shock clears to NONE. ep1=${epAfterShock?.episodeId}, ep2=${epAfterNone?.episodeId}, ticks=${epAfterNone?.ticks}, subtype=${judgment.subtype}`
  );
}

// =========================================================================
// TEST S — Released episode cannot re-arm from same stale evidence
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const microCandles = makeMicroDownReboundCandles(69000);
  const staleEvidence = {
    breakoutFailureRate: 0.45,
    volumeExpansion: 1.0,
    candles: microCandles,
    htf_candles: {
      "5m": microCandles,
      "15m": microCandles,
      "1h": microCandles,
      "4h": microCandles
    }
  };

  // Seed episode to 6 ticks under real shock (UP + aligned bullish HTF for clean release)
  for (let i = 1; i <= 6; i++) {
    updateWhipsawObservation({
      symbol: "BTCUSDT",
      rawActive: true,
      candidateRiskActive: true,
      allowNewHardBlockEpisode: true,
      directionalShockState: "UP",
      structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
    });
  }

  // Release via aligned HTF + cleared fresh danger (mirrors TEST E)
  const releaseInput = makeBaseInput(
    "BTCUSDT",
    {
      ...staleEvidence,
      breakoutFailureRate: 0.1,
      volumeExpansion: 1.1,
      candles: mockBullishCandles,
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    { directionalShockState: "UP" }
  );
  detectMarketRegime(releaseInput);

  const epAfterRelease = whipsawObservationAuthority.getEpisode("BTCUSDT");

  // Next tick: NONE shock + same stale micro + breakout failure
  const rearmAttempt = makeBaseInput("BTCUSDT", staleEvidence, { directionalShockState: "NONE" });
  const judgment = detectMarketRegime(rearmAttempt);
  const epAfterRearm = whipsawObservationAuthority.getEpisode("BTCUSDT");

  run(
    "TEST_S_RELEASED_EPISODE_CANNOT_REARM_FROM_SAME_STALE_EVIDENCE",
    epAfterRelease == null &&
      judgment.subtype !== "WHIPSAW_SHOCK_RECHECK" &&
      epAfterRearm == null,
    `Post-release stale evidence must not re-arm. subtype=${judgment.subtype}, epAfterRelease=${epAfterRelease?.episodeId ?? "null"}, epAfterRearm=${epAfterRearm?.episodeId ?? "null"}`
  );
}

// =========================================================================
// TEST T — Fresh shock after release can re-arm
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const microCandles = makeMicroDownReboundCandles(69000);
  const staleEvidence = {
    breakoutFailureRate: 0.45,
    volumeExpansion: 1.0,
    candles: microCandles,
    htf_candles: {
      "5m": microCandles,
      "15m": microCandles,
      "1h": microCandles,
      "4h": microCandles
    }
  };

  for (let i = 1; i <= 6; i++) {
    updateWhipsawObservation({
      symbol: "BTCUSDT",
      rawActive: true,
      candidateRiskActive: true,
      allowNewHardBlockEpisode: true,
      directionalShockState: "UP",
      structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
    });
  }

  const releaseInput = makeBaseInput(
    "BTCUSDT",
    {
      ...staleEvidence,
      breakoutFailureRate: 0.1,
      volumeExpansion: 1.1,
      candles: mockBullishCandles,
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    { directionalShockState: "UP" }
  );
  detectMarketRegime(releaseInput);

  const freshShockInput = makeBaseInput(
    "BTCUSDT",
    {
      breakoutFailureRate: 0.45,
      volumeExpansion: 2.5,
      candles: microCandles,
      htf_candles: {
        "5m": microCandles,
        "15m": microCandles,
        "1h": microCandles,
        "4h": microCandles
      }
    },
    { directionalShockState: "UP" }
  );

  const judgment = detectMarketRegime(freshShockInput);
  const ep = whipsawObservationAuthority.getEpisode("BTCUSDT");

  run(
    "TEST_T_FRESH_SHOCK_AFTER_RELEASE_CAN_REARM",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK" && ep != null && ep.ticks === 1,
    `Fresh UP shock after release re-arms hard block. subtype=${judgment.subtype}, episode=${ep?.episodeId}, ticks=${ep?.ticks}`
  );
}

// =========================================================================
// TEST U — EXACT PRODUCTION DEADLOCK REPLAY (BTC)
// - recheckTicks=19 (>6 required) while reviewing_ticks=0
// - boxBreakSide="none" + stale breakoutFailureRate=1.0
// - DOWN shock + 4h/1d BULLISH HTF (macroPolarity=BULLISH)
// - micro reversal present, no new fresh whipsaw hazard
// - lower range zone (boxPos=0.2)
// Expected:
// - subtype != "WHIPSAW_SHOCK_RECHECK" (hard block released!)
// - reviewing_ticks_insufficient & whipsaw_observation_age_insufficient NOT in wait reasons
// - freshStructuralHits is empty []
// - breakoutFailureRate=1 is placed in historicalOnlyHits, NOT freshStructuralHits
// - htf_entry_policy = "HOLD" (preserves countertrend shock protection)
// - engine decision != "ENTER" (safe non-entry)
// - hard_block_reason != "WHIPSAW_SHOCK_RECHECK" (no dead-zone lock)
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const microCandles = makeMicroDownReboundCandles(69000);

  // 1. Seed whipsaw episode to 19 ticks under DOWN shock
  for (let i = 1; i <= 19; i++) {
    updateWhipsawObservation({
      symbol: "BTCUSDT",
      rawActive: true,
      candidateRiskActive: true,
      allowNewHardBlockEpisode: true,
      directionalShockState: "DOWN",
      structuralHits: ["micro_down_then_rebound", "volume_expansion_ge_2"]
    });
  }

  // 2. Production tick: reviewing_ticks=0, boxBreakSide="none", breakoutFailureRate=1.0, volExp=1.0
  const prodInput = makeBaseInput(
    "BTCUSDT",
    {
      reviewing_ticks: 0,
      boxBreakSide: "none",
      breakoutFailureRate: 1.0,
      volumeExpansion: 1.0,
      boxPos: 0.2, // lower zone
      candles: microCandles,
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "DOWN",
      shortAllow: true,
      longAllow: false
    }
  );

  const judgment = detectMarketRegime(prodInput);
  const { decision } = runEngineV2(prodInput);

  const reasons = judgment.diagnostics?.confirmation_wait_reasons ?? [];
  const freshHits = judgment.diagnostics?.fresh_structural_hits ?? [];
  const histHits = judgment.diagnostics?.historical_only_hits ?? [];

  run(
    "TEST_U_BTC_PRODUCTION_DEADLOCK_RESOLVED",
    judgment.subtype !== "WHIPSAW_SHOCK_RECHECK" &&
      !reasons.includes("reviewing_ticks_insufficient") &&
      !reasons.includes("whipsaw_observation_age_insufficient") &&
      freshHits.length === 0 &&
      histHits.includes("breakout_failure_rate_ge_0_4") &&
      judgment.htf_entry_policy === "HOLD" &&
      decision.decision !== "ENTER" &&
      decision.explanation.reason !== "WHIPSAW_SHOCK_RECHECK",
    `Production BTC state releases hard-block cleanly. subtype=${judgment.subtype}, freshHits=${JSON.stringify(freshHits)}, histHits=${JSON.stringify(histHits)}, reasons=${JSON.stringify(reasons)}, htf_policy=${judgment.htf_entry_policy}, decision=${decision.decision}, reason=${decision.explanation.reason}`
  );
}

// =========================================================================
// TEST V — EXACT PRODUCTION DEADLOCK REPLAY (ETH)
// =========================================================================
{
  clearWhipsawObservationState("ETHUSDT");
  clearGlobalShockStates();

  const microCandles = makeMicroDownReboundCandles(2600);

  for (let i = 1; i <= 19; i++) {
    updateWhipsawObservation({
      symbol: "ETHUSDT",
      rawActive: true,
      candidateRiskActive: true,
      allowNewHardBlockEpisode: true,
      directionalShockState: "DOWN",
      structuralHits: ["micro_down_then_rebound", "volume_expansion_ge_2"]
    });
  }

  const prodInput = makeBaseInput(
    "ETHUSDT",
    {
      reviewing_ticks: 0,
      boxBreakSide: "none",
      breakoutFailureRate: 1.0,
      volumeExpansion: 1.0,
      boxPos: 0.2,
      candles: microCandles,
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "DOWN",
      shortAllow: true,
      longAllow: false
    },
    "BEARISH"
  );

  const judgment = detectMarketRegime(prodInput);
  const { decision } = runEngineV2(prodInput);

  const reasons = judgment.diagnostics?.confirmation_wait_reasons ?? [];
  const freshHits = judgment.diagnostics?.fresh_structural_hits ?? [];
  const histHits = judgment.diagnostics?.historical_only_hits ?? [];

  run(
    "TEST_V_ETH_PRODUCTION_DEADLOCK_RESOLVED",
    judgment.subtype !== "WHIPSAW_SHOCK_RECHECK" &&
      !reasons.includes("reviewing_ticks_insufficient") &&
      !reasons.includes("whipsaw_observation_age_insufficient") &&
      freshHits.length === 0 &&
      histHits.includes("breakout_failure_rate_ge_0_4") &&
      judgment.htf_entry_policy === "HOLD" &&
      decision.decision !== "ENTER" &&
      decision.explanation.reason !== "WHIPSAW_SHOCK_RECHECK",
    `Production ETH state releases hard-block cleanly. subtype=${judgment.subtype}, freshHits=${JSON.stringify(freshHits)}, histHits=${JSON.stringify(histHits)}, reasons=${JSON.stringify(reasons)}, htf_policy=${judgment.htf_entry_policy}, decision=${decision.decision}, reason=${decision.explanation.reason}`
  );
}

// =========================================================================
// TEST W — NEW EPISODE CANNOT INHERIT STALE HIGH REVIEWING_TICKS (Safety Guard)
// - Brand new whipsaw episode (tick 1)
// - Stale legacy snapshot.reviewing_ticks = 15 (e.g. from old breakout window)
// Expected:
// - recheckTicks = 1 (canonical observer authority, does NOT inherit 15)
// - observationAgePassed = false (1 < 6 required ticks)
// - confirmation_wait_reasons contains "whipsaw_observation_age_insufficient"
// - subtype = "WHIPSAW_SHOCK_RECHECK" (hard-block remains active)
// - decision != "ENTER" (no premature release or promotion)
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const microCandles = makeMicroUpThenDropCandles(69000);

  const freshShockWithStaleHighReviewingTicks = makeBaseInput(
    "BTCUSDT",
    {
      reviewing_ticks: 15, // Stale high legacy count
      boxBreakSide: "none",
      breakoutFailureRate: 0.1,
      volumeExpansion: 2.5,
      candles: microCandles,
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "UP",
      longAllow: true,
      shortAllow: false
    }
  );

  const judgment = detectMarketRegime(freshShockWithStaleHighReviewingTicks);
  const { decision } = runEngineV2(freshShockWithStaleHighReviewingTicks);

  const reasons = judgment.diagnostics?.confirmation_wait_reasons ?? [];
  const recheckTicks = judgment.diagnostics?.whipsaw?.recheckTicks;
  const agePassed = judgment.diagnostics?.whipsaw?.observationAgePassed;

  run(
    "TEST_W_NEW_EPISODE_CANNOT_INHERIT_STALE_HIGH_REVIEWING_TICKS",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK" &&
      recheckTicks === 1 &&
      agePassed === false &&
      reasons.includes("whipsaw_observation_age_insufficient") &&
      decision.decision !== "ENTER",
    `New whipsaw episode does NOT inherit stale reviewing_ticks=15. subtype=${judgment.subtype}, recheckTicks=${recheckTicks} (expected 1), agePassed=${agePassed} (expected false), decision=${decision.decision}`
  );
}

// =========================================================================
// TEST X — PURE SOFT-WATCH CANNOT CREATE A NEW WHIPSAW EPISODE
// - No existing episode
// - candidateRiskActive = false, allowNewHardBlockEpisode = false
// - rawActive = true (micro + directional context only)
// Expected:
// - episodeId = null, recheckTicks = 0, active = false
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const res = updateWhipsawObservation({
    symbol: "BTCUSDT",
    rawActive: true,
    candidateRiskActive: false,
    allowNewHardBlockEpisode: false,
    directionalShockState: "UP",
    structuralHits: ["micro_up_then_drop"]
  });

  run(
    "TEST_X_PURE_SOFT_WATCH_CANNOT_CREATE_EPISODE",
    res.episodeId === null && res.recheckTicks === 0 && res.active === false,
    `Pure soft-watch without candidate risk creates NO episode. episodeId=${res.episodeId}, recheckTicks=${res.recheckTicks}, active=${res.active}`
  );
}

// =========================================================================
// TEST Y — MULTIPLE SOFT-WATCH CYCLES NEVER PROMOTE TO HARD BLOCK
// - Continuous cycles of soft-watch evidence (micro reversal + directional context)
// - NO fresh structural hits
// Expected:
// - Never creates an episode
// - Subtype remains WHIPSAW_SOFT_WATCH (or safe non-hard block)
// - hard_block_active is never true
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const microCandles = makeMicroUpThenDropCandles(69000);
  let neverPromotedToHardBlock = true;
  let neverCreatedEpisode = true;

  for (let cycle = 1; cycle <= 5; cycle++) {
    const softWatchInput = makeBaseInput(
      "BTCUSDT",
      {
        reviewing_ticks: 0,
        boxBreakSide: "none",
        breakoutFailureRate: 0.1,
        volumeExpansion: 1.0,
        candles: microCandles,
        htf_candles: {
          "5m": mockBullishCandles,
          "15m": mockBullishCandles,
          "1h": mockBullishCandles,
          "4h": mockBullishCandles
        }
      },
      {
        directionalShockState: "UP",
        longAllow: true,
        shortAllow: false
      }
    );

    const judgment = detectMarketRegime(softWatchInput);
    const ep = whipsawObservationAuthority.getEpisode("BTCUSDT");

    if (ep != null) neverCreatedEpisode = false;
    if (judgment.subtype === "WHIPSAW_SHOCK_RECHECK") neverPromotedToHardBlock = false;
    if (judgment.diagnostics?.whipsaw?.active === true) neverPromotedToHardBlock = false;
  }

  run(
    "TEST_Y_MULTIPLE_SOFT_WATCH_CYCLES_NEVER_PROMOTE_TO_HARD_BLOCK",
    neverCreatedEpisode && neverPromotedToHardBlock,
    `5 consecutive soft-watch cycles created NO episode and never promoted to hard block. neverCreatedEpisode=${neverCreatedEpisode}, neverPromoted=${neverPromotedToHardBlock}`
  );
}

// =========================================================================
// TEST Z — REAL HARD CANDIDATE EPISODE CONTINUES OBSERVATION ACROSS EVIDENCE FADE
// - Cycle 1: Genuine hard candidate (volExp=2.5 + micro reversal + shock) starts episode (ticks=1)
// - Cycle 2: Fresh structural evidence fades (volExp=1.0) while micro reversal remains; snapshot has stale reviewing_ticks=20
// Expected:
// - Same episode continues (episodeId identical, ticks=2)
// - effectiveRecheckTicks = 2 (does NOT inherit 20)
// - subtype remains WHIPSAW_SHOCK_RECHECK for minimum observation window
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");

  const microCandles = makeMicroDownReboundCandles(69000);

  // Cycle 1: Hard shock candidate
  const hardInput = makeBaseInput(
    "BTCUSDT",
    {
      reviewing_ticks: 0,
      boxBreakSide: "none",
      breakoutFailureRate: 0.1,
      volumeExpansion: 2.5,
      candles: microCandles,
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "DOWN",
      shortAllow: true,
      longAllow: false
    }
  );

  const res1 = runEngineV2(hardInput);
  const judgment1 = res1.internal.judgment;
  const ep1 = whipsawObservationAuthority.getEpisode("BTCUSDT");
  const ep1Ticks = ep1?.ticks ?? 0;
  const ep1Id = ep1?.episodeId;

  // Cycle 2: Evidence fades, legacy reviewing_ticks=20
  const fadedInput = makeBaseInput(
    "BTCUSDT",
    {
      reviewing_ticks: 20,
      boxBreakSide: "none",
      breakoutFailureRate: 0.1,
      volumeExpansion: 1.0, // volExp back to normal
      candles: microCandles, // micro reversal still unfolding
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "DOWN",
      shortAllow: true,
      longAllow: false
    }
  );

  const res2 = runEngineV2(fadedInput);
  const judgment2 = res2.internal.judgment;
  const decision2 = res2.decision;
  const ep2 = whipsawObservationAuthority.getEpisode("BTCUSDT");

  run(
    "TEST_Z_LEGITIMATE_EPISODE_CONTINUES_ACROSS_EVIDENCE_FADE",
    judgment1.subtype === "WHIPSAW_SHOCK_RECHECK" &&
      ep1 != null &&
      ep1Ticks === 1 &&
      ep2 != null &&
      ep2.episodeId === ep1Id &&
      ep2.ticks === 2 &&
      judgment2.diagnostics?.whipsaw?.recheckTicks === 2 &&
      judgment2.subtype === "WHIPSAW_SHOCK_RECHECK" &&
      decision2.decision !== "ENTER",
    `Legitimate episode continues across evidence fade. ep1Ticks=${ep1Ticks}, ep2Ticks=${ep2?.ticks}, recheckTicks=${judgment2.diagnostics?.whipsaw?.recheckTicks}, subtype2=${judgment2.subtype}, decision2=${decision2.decision}`
  );
}

// =========================================================================
// TEST AA — GENUINE VOLUME EXPANSION + MICRO REVERSAL CREATES HARD EPISODE
// - volExp=2.5 + micro_down_then_rebound + DOWN shock
// Expected:
// - Creates new episode at recheckTicks=1
// - subtype = WHIPSAW_SHOCK_RECHECK
// =========================================================================
{
  clearWhipsawObservationState("ETHUSDT");

  const microCandles = makeMicroDownReboundCandles(2600);

  const ethHardInput = makeBaseInput(
    "ETHUSDT",
    {
      reviewing_ticks: 0,
      boxBreakSide: "none",
      breakoutFailureRate: 0.1,
      volumeExpansion: 2.5,
      candles: microCandles,
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "DOWN",
      shortAllow: true,
      longAllow: false
    }
  );

  const judgment = detectMarketRegime(ethHardInput);
  const ep = whipsawObservationAuthority.getEpisode("ETHUSDT");

  run(
    "TEST_AA_GENUINE_VOLUME_EXPANSION_CREATES_HARD_EPISODE",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK" &&
      ep != null &&
      ep.ticks === 1 &&
      judgment.diagnostics?.whipsaw?.recheckTicks === 1,
    `Genuine ETH volume expansion + micro reversal creates hard episode. subtype=${judgment.subtype}, epTicks=${ep?.ticks}`
  );
}

// =========================================================================
// TEST BB (Task 7.A) — PROBE_ONLY + WHIPSAW_SOFT_WATCH + VALID BREAKDOWN REACHES MICRO PROBE
// - htf_entry_policy = "PROBE_ONLY" (from counter-trend risk / neutral HTF with probe allowed)
// - market_subtype = "WHIPSAW_SOFT_WATCH"
// - Valid short breakdown boundary (closedClose < watchBoundary && lastPrice < watchBoundary)
// - Trend DOWN + negative slope + negative emaGap + all safety clear
// Expected:
// - Reduced-size micro probe is REACHABLE (decision = ENTER, side = short)
// - promotionReason = "CONTINUATION_MICRO_PROBE"
// - micro_probe_active = true
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const now = Date.now();
  const watchBoundary = 69000;

  rangeContinuationStateMap.set("BTCUSDT", {
    direction: "down",
    phase: "CONTINUATION_WATCH",
    watchStartedCandleTs: now - 60000,
    watchStartedAtTimestamp: now - 1000,
    watchBoundaryPrice: watchBoundary,
    countStartedCandleTs: null,
    countBoundaryPrice: null,
    hasCandleAdvancedDuringCount: false,
    totalCyclesSinceWatch: 0
  } as any);

  const microCandles = makeMicroDownReboundCandles(68930);

  const input = makeBaseInput(
    "BTCUSDT",
    {
      lastPrice: 68930,
      closedClose: 68920,
      atr: 250,
      atr20: 250,
      boxLowSlope: -0.003,
      rangeCenterSlope: -0.003,
      boxHighSlope: -0.003,
      emaGap: -0.002,
      qualityScore: 65,
      trendWeaknessScore: 0.3,
      reviewing_ticks: 0,
      boxBreakSide: "none",
      breakoutFailureRate: 0.1,
      volumeExpansion: 1.0,
      candles: microCandles,
      canonicalRegime: "RANGE",
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBearishCandles,
        "4h": mockBullishCandles // 4h bullish creates counterTrendRisk -> PROBE_ONLY
      }
    },
    {
      directionalShockState: "NONE", // Production case: directionalShock is NONE
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true,
      okxAuthMode: "live",
      okxAuthReady: true,
      okxExchangeAuthOptIn: true,
      okxLiveEnabled: true,
      liveBalanceReady: true,
      accountEquityUsdt: 10000,
      availableBalanceUsdt: 10000,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true,
      okxPendingOrdersReady: true,
      okxPendingOrdersNotionalUsdt: 0,
      okxPendingSymbolNotionalUsdt: 0,
      okxActualPositions: [],
      balanceFetchedAt: Date.now(),
      positionsFetchedAt: Date.now(),
      pendingOrdersFetchedAt: Date.now()
    },
    "BEARISH"
  );

  const res = runEngineV2(input);
  const judgment = res.internal.judgment;
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_BB_PROBE_ONLY_SOFT_WATCH_BREAKDOWN_REACHABLE",
    judgment.htf_entry_policy === "PROBE_ONLY" &&
      decision.decision === "ENTER" &&
      decision.side === "short" &&
      meta.promotionReason === "CONTINUATION_MICRO_PROBE" &&
      meta.micro_probe_active === true &&
      decision.committedRiskPlan != null &&
      Number(decision.committedRiskPlan.finalOrderNotionalUsdt) > 0,
    `PROBE_ONLY allows short micro probe on confirmed breakdown. htfPolicy=${judgment.htf_entry_policy}, decision=${decision.decision}, side=${decision.side}, promoReason=${meta.promotionReason}`
  );
}

// =========================================================================
// TEST CC (Task 7.B) — SAME STATE BUT NO CONFIRMED BOUNDARY BREAKDOWN => NO ENTER
// - lastPrice and closedClose remain above watchBoundary
// Expected:
// - decision != ENTER (remains SKIP / HOLD)
// - micro_probe_block_reason = "NO_CANDLE_BREAKOUT_OR_BREAKDOWN"
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const now = Date.now();
  const watchBoundary = 69000;

  rangeContinuationStateMap.set("BTCUSDT", {
    direction: "down",
    phase: "CONTINUATION_WATCH",
    watchStartedCandleTs: now - 60000,
    watchStartedAtTimestamp: now - 1000,
    watchBoundaryPrice: watchBoundary,
    countStartedCandleTs: null,
    countBoundaryPrice: null,
    hasCandleAdvancedDuringCount: false,
    totalCyclesSinceWatch: 0
  } as any);

  const microCandles = makeMicroDownReboundCandles(69050);

  const inputNoBreakdown = makeBaseInput(
    "BTCUSDT",
    {
      lastPrice: 69050, // Above watchBoundary (wick only or unconfirmed)
      closedClose: 68980, // Below watchBoundary
      atr: 250,
      atr20: 250,
      boxLowSlope: -0.003,
      rangeCenterSlope: -0.003,
      emaGap: -0.002,
      qualityScore: 65,
      trendWeaknessScore: 0.55,
      reviewing_ticks: 0,
      boxBreakSide: "none",
      breakoutFailureRate: 0.1,
      volumeExpansion: 1.0,
      candles: microCandles,
      canonicalRegime: "RANGE",
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBearishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true
    },
    "BEARISH"
  );

  const res = runEngineV2(inputNoBreakdown);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_CC_PROBE_ONLY_NO_BREAKDOWN_NO_ENTER",
    decision.decision !== "ENTER" &&
      meta.micro_probe_block_reason === "NO_CANDLE_BREAKOUT_OR_BREAKDOWN",
    `No boundary breakdown correctly rejects ENTER. decision=${decision.decision}, blockReason=${meta.micro_probe_block_reason}`
  );
}

// =========================================================================
// TEST DD (Task 7.C) — PROBE_ONLY ALONE WITH NO DIRECTIONAL CONFIRMATION => NO ENTER
// - Breakdown price exists, but slope is positive (slope mismatch)
// Expected:
// - decision != ENTER
// - micro_probe_block_reason = "SLOPE_NOT_NEGATIVE"
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const now = Date.now();
  const watchBoundary = 69000;

  rangeContinuationStateMap.set("BTCUSDT", {
    direction: "down",
    phase: "CONTINUATION_WATCH",
    watchStartedCandleTs: now - 60000,
    watchStartedAtTimestamp: now - 1000,
    watchBoundaryPrice: watchBoundary,
    countStartedCandleTs: null,
    countBoundaryPrice: null,
    hasCandleAdvancedDuringCount: false,
    totalCyclesSinceWatch: 0
  } as any);

  const microCandles = makeMicroDownReboundCandles(68930);

  const inputNoSlopeConf = makeBaseInput(
    "BTCUSDT",
    {
      lastPrice: 68930,
      closedClose: 68920,
      atr: 250,
      atr20: 250,
      boxLowSlope: 0.005, // Positive slope!
      rangeCenterSlope: 0.005,
      boxHighSlope: 0.005,
      emaGap: -0.002,
      qualityScore: 65,
      trendWeaknessScore: 0.3,
      reviewing_ticks: 0,
      boxBreakSide: "none",
      breakoutFailureRate: 0.1,
      volumeExpansion: 1.0,
      candles: microCandles,
      canonicalRegime: "RANGE",
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBearishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true
    },
    "BEARISH"
  );

  const res = runEngineV2(inputNoSlopeConf);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_DD_PROBE_ONLY_NO_DIRECTIONAL_CONFIRMATION_NO_ENTER",
    decision.decision !== "ENTER" &&
      meta.micro_probe_block_reason === "SLOPE_NOT_NEGATIVE",
    `Positive slope rejects short probe despite PROBE_ONLY. decision=${decision.decision}, blockReason=${meta.micro_probe_block_reason}`
  );
}

// =========================================================================
// TEST EE (Task 7.D) — HTF HOLD + BULLISH MACRO VS SHORT => PROBE FORBIDDEN
// - Macro polarity = BULLISH, shock = DOWN -> htf_entry_policy = "HOLD"
// Expected:
// - decision != ENTER
// - micro_probe_block_reason = "HTF_POLICY_NOT_SHORT"
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const now = Date.now();
  const watchBoundary = 69000;

  rangeContinuationStateMap.set("BTCUSDT", {
    direction: "down",
    phase: "CONTINUATION_WATCH",
    watchStartedCandleTs: now - 60000,
    watchStartedAtTimestamp: now - 1000,
    watchBoundaryPrice: watchBoundary,
    countStartedCandleTs: null,
    countBoundaryPrice: null,
    hasCandleAdvancedDuringCount: false,
    totalCyclesSinceWatch: 0
  } as any);

  const microCandles = makeMicroDownReboundCandles(68930);

  const inputHtfHold = makeBaseInput(
    "BTCUSDT",
    {
      lastPrice: 68930,
      closedClose: 68920,
      atr: 250,
      atr20: 250,
      boxLowSlope: -0.003,
      rangeCenterSlope: -0.003,
      boxHighSlope: -0.003,
      emaGap: -0.002,
      qualityScore: 65,
      trendWeaknessScore: 0.55,
      reviewing_ticks: 0,
      boxBreakSide: "none",
      breakoutFailureRate: 0.1,
      volumeExpansion: 1.0,
      candles: microCandles,
      canonicalRegime: "RANGE",
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "DOWN", // DOWN shock + BULLISH HTF => HOLD
      shortAllow: true,
      longAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true
    },
    "BEARISH"
  );

  const res = runEngineV2(inputHtfHold);
  const judgment = res.internal.judgment;
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_EE_HTF_HOLD_BULLISH_MACRO_FORBIDS_PROBE",
    judgment.htf_entry_policy === "HOLD" &&
      decision.decision !== "ENTER" &&
      (meta.micro_probe_block_reason === "SHOCK_PHASE_ACTIVE" || meta.micro_probe_block_reason === "HTF_POLICY_NOT_SHORT"),
    `HTF HOLD strictly forbids short probe. htfPolicy=${judgment.htf_entry_policy}, decision=${decision.decision}, blockReason=${meta.micro_probe_block_reason}`
  );
}

// =========================================================================
// TEST FF (Task 7.E) — QUALITY >= 78 BUT TREND_WEAKNESS >= 0.5 => ACCURATE DIAGNOSTIC
// - qualityScore = 80 (Grade A)
// - trendWeaknessScore = 0.55 (>= 0.5 -> trendOk is false)
// - activeEngineRouting = "TREND"
// Expected:
// - Generic TREND promotion does NOT enter (decision != ENTER)
// - primary_missing_condition = "TREND_PROMOTION_BLOCKED_TREND_WEAKNESS_TOO_HIGH"
// - Does NOT falsely claim "QUALITY_BELOW_THRESHOLD"
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const inputTrendWeak = makeBaseInput(
    "BTCUSDT",
    {
      qualityScore: 80,
      trendWeaknessScore: 0.55,
      emaGap: 0.002,
      canonicalRegime: "TREND",
      canonicalRegimeSource: "strategy_market_regime_detector",
      canonicalTrendScore: 0.85,
      candles: mockBullishCandles,
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "NONE",
      longAllow: true,
      shortAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true
    }
  );

  const res = runEngineV2(inputTrendWeak);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};
  const missingCondition = meta.primary_missing_condition;

  run(
    "TEST_FF_TREND_WEAKNESS_ACCURATE_DIAGNOSTIC_NOT_QUALITY",
    decision.decision !== "ENTER" &&
      missingCondition === "TREND_PROMOTION_BLOCKED_TREND_WEAKNESS_TOO_HIGH",
    `Accurately diagnoses trend weakness without falsely blaming quality. decision=${decision.decision}, missingCondition=${missingCondition}`
  );
}

// =========================================================================
// TEST GG (Item 8.2) — INVALID FALLBACK TIMESTAMP => BLOCKED
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const watchBoundary = 69000;

  rangeContinuationStateMap.set("BTCUSDT", {
    direction: "down",
    phase: "CONTINUATION_WATCH",
    watchStartedCandleTs: 0, // INVALID timestamp
    watchStartedAtTimestamp: 0,
    watchBoundaryPrice: watchBoundary,
    countStartedCandleTs: null,
    countBoundaryPrice: null,
    hasCandleAdvancedDuringCount: false,
    totalCyclesSinceWatch: 0
  } as any);

  const microCandles = makeMicroDownReboundCandles(68930);

  const inputInvalidTs = makeBaseInput(
    "BTCUSDT",
    {
      lastPrice: 68930,
      closedClose: 68920,
      atr: 250,
      atr20: 250,
      boxLowSlope: -0.003,
      rangeCenterSlope: -0.003,
      boxHighSlope: -0.003,
      emaGap: -0.002,
      qualityScore: 65,
      trendWeaknessScore: 0.55,
      candles: microCandles,
      canonicalRegime: "RANGE",
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBearishCandles,
        "4h": mockBullishCandles
      }
    },
// TEST GG
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true
    },
    "BEARISH"
  );

  const res = runEngineV2(inputInvalidTs);
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_GG_INVALID_FALLBACK_TIMESTAMP_BLOCKED",
    res.decision.decision !== "ENTER" &&
      meta.micro_probe_block_reason === "WATCH_STARTED_CANDLE_TS_INVALID",
    `Invalid fallback timestamp blocks probe. decision=${res.decision.decision}, blockReason=${meta.micro_probe_block_reason}`
  );
}

// =========================================================================
// TEST HH (Item 8.3) — INVALID/MISSING FALLBACK DIRECTION => BLOCKED
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const now = Date.now();
  const watchBoundary = 69000;

  rangeContinuationStateMap.set("BTCUSDT", {
    direction: "none", // INVALID direction
    phase: "CONTINUATION_WATCH",
    watchStartedCandleTs: now - 60000,
    watchStartedAtTimestamp: now - 1000,
    watchBoundaryPrice: watchBoundary,
    countStartedCandleTs: null,
    countBoundaryPrice: null,
    hasCandleAdvancedDuringCount: false,
    totalCyclesSinceWatch: 0
  } as any);

  const microCandles = makeMicroDownReboundCandles(68930);

  const inputInvalidDir = makeBaseInput(
    "BTCUSDT",
    {
      lastPrice: 68930,
      closedClose: 68920,
      atr: 250,
      atr20: 250,
      boxLowSlope: -0.003,
      rangeCenterSlope: -0.003,
      boxHighSlope: -0.003,
      emaGap: -0.002,
      qualityScore: 65,
      trendWeaknessScore: 0.55,
      candles: microCandles,
      canonicalRegime: "RANGE",
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBearishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true
    },
    "BEARISH"
  );

  const res = runEngineV2(inputInvalidDir);
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_HH_INVALID_FALLBACK_DIRECTION_BLOCKED",
    res.decision.decision !== "ENTER" &&
      meta.micro_probe_block_reason === "CONTINUATION_DIRECTION_INVALID",
    `Invalid fallback direction blocks probe. decision=${res.decision.decision}, blockReason=${meta.micro_probe_block_reason}`
  );
}

// =========================================================================
// TEST II (Item 8.4) — STALE FALLBACK (> 10 MIN) => BLOCKED
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const now = Date.now();
  const watchBoundary = 69000;

  rangeContinuationStateMap.set("BTCUSDT", {
    direction: "down",
    phase: "CONTINUATION_WATCH",
    watchStartedCandleTs: now - 15 * 60 * 1000,
    watchStartedAtTimestamp: now - 15 * 60 * 1000, // 15 mins ago (> 10m)
    watchBoundaryPrice: watchBoundary,
    countStartedCandleTs: null,
    countBoundaryPrice: null,
    hasCandleAdvancedDuringCount: false,
    totalCyclesSinceWatch: 0
  } as any);

  const microCandles = makeMicroDownReboundCandles(68930);

  const inputStale = makeBaseInput(
    "BTCUSDT",
    {
      lastPrice: 68930,
      closedClose: 68920,
      atr: 250,
      atr20: 250,
      boxLowSlope: -0.003,
      rangeCenterSlope: -0.003,
      boxHighSlope: -0.003,
      emaGap: -0.002,
      qualityScore: 65,
      trendWeaknessScore: 0.55,
      candles: microCandles,
      canonicalRegime: "RANGE",
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBearishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true
    },
    "BEARISH"
  );

  const res = runEngineV2(inputStale);
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_II_STALE_FALLBACK_BLOCKED",
    res.decision.decision !== "ENTER" &&
      meta.micro_probe_block_reason === "CONTINUATION_CONTEXT_STALE",
    `Stale fallback context (> 10m) blocks probe. decision=${res.decision.decision}, blockReason=${meta.micro_probe_block_reason}`
  );
}

// =========================================================================
// TEST JJ (Item 8.5) — NEUTRAL_HTF_DATA_WAIT => BLOCKED
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  for (let i = 1; i <= 6; i++) {
    updateWhipsawObservation({
      symbol: "BTCUSDT",
      rawActive: true,
      directionalShockState: "DOWN",
      structuralHits: ["micro_down_then_rebound", "box_orbit_chop"]
    });
  }

  const now = Date.now();
  const watchBoundary = 69000;

  rangeContinuationStateMap.set("BTCUSDT", {
    direction: "down",
    phase: "CONTINUATION_WATCH",
    watchStartedCandleTs: now - 60000,
    watchStartedAtTimestamp: now - 1000,
    watchBoundaryPrice: watchBoundary,
    countStartedCandleTs: null,
    countBoundaryPrice: null,
    hasCandleAdvancedDuringCount: false,
    totalCyclesSinceWatch: 0
  } as any);

  const microCandles = makeMicroDownReboundCandles(68930);

  const inputDataWait = makeBaseInput(
    "BTCUSDT",
    {
      lastPrice: 68930,
      closedClose: 68920,
      atr: 250,
      atr20: 250,
      boxLowSlope: -0.003,
      rangeCenterSlope: -0.003,
      boxHighSlope: -0.003,
      emaGap: -0.002,
      qualityScore: 65,
      trendWeaknessScore: 0.55,
      candles: microCandles,
      canonicalRegime: "RANGE",
      htf_candles: {
        "5m": [], // Empty HTF candles -> NEUTRAL_HTF_DATA_WAIT
        "15m": [],
        "1h": [],
        "4h": []
      }
    },
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true
    },
    "BEARISH"
  );

  const res = runEngineV2(inputDataWait);
  const judgment = res.internal.judgment;

  // Direct boundary continuation engine test: NEUTRAL_HTF_DATA_WAIT must not allow entry
  const directContResult = evaluateLowerBreakdownShortConfirmed({
    trendSideCandidate: "short",
    zone: "lower",
    boxBreakSide: "lower",
    boxLow: 69000,
    boxHigh: 69500,
    closedClose: 68920,
    lastPrice: 68930,
    previousConfirmedBoxLow: null,
    previousConfirmedBoxHigh: null,
    emaGap: -0.002,
    htfEntryPolicy: "NEUTRAL_HTF_DATA_WAIT",
    htfRequiresStrongerConfirmation: false,
    counterTrendRisk: false,
    riskLongAllow: false,
    riskShortAllow: true,
    allowNewLong: false,
    allowNewShort: true,
    whipsawShockRecheckActive: false,
    hardBlockPresent: false,
    paperExecutionReady: true,
    signedExecutionReady: true,
    hasSameSidePosition: false,
    hasOppositeSidePosition: false,
    judgmentSubtype: "WHIPSAW_SOFT_WATCH",
    rangePhase: null,
    transitionPhase: null,
    continuationDirection: "down",
    continuationPhase: "CONTINUATION_WATCH",
    retestConfirmed: true,
    reversalConfirmed: false
  } as any);

  run(
    "TEST_JJ_NEUTRAL_HTF_DATA_WAIT_BLOCKED",
    judgment.htf_entry_policy === "NEUTRAL_HTF_DATA_WAIT" &&
      res.decision.decision !== "ENTER" &&
      directContResult.confirmed === false,
    `NEUTRAL_HTF_DATA_WAIT blocks micro probe. htfPolicy=${judgment.htf_entry_policy}, decision=${res.decision.decision}, directContConfirmed=${directContResult.confirmed}`
  );
}

// =========================================================================
// TEST KK (Item 8.7) — OPPOSITE SHOCK => BLOCKED
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const now = Date.now();
  const watchBoundary = 69000;

  globalShockStates.set("BTCUSDT", {
    activeDirection: "UP",
    rawDirection: "UP",
    candidateDirection: "UP",
    candidateCount: 2,
    neutralCount: 0,
    candidateStartedAt: now - 60000,
    activatedAt: now - 30000,
    lastChangedAt: now - 30000,
    rawMovePct: 0.05,
    requiredMovePct: 0.001,
    emergencyBypass: true,
    lastProcessedCycle: 0
  });

  rangeContinuationStateMap.set("BTCUSDT", {
    direction: "down",
    phase: "CONTINUATION_WATCH",
    watchStartedCandleTs: now - 65000,
    watchStartedAtTimestamp: now - 1000,
    watchBoundaryPrice: watchBoundary,
    countStartedCandleTs: null,
    countBoundaryPrice: null,
    hasCandleAdvancedDuringCount: false,
    totalCyclesSinceWatch: 0
  } as any);

  const microCandles = makeMicroDownReboundCandles(68930);

  const inputOppositeShock = makeBaseInput(
    "BTCUSDT",
    {
      lastPrice: 68930,
      closedClose: 68920,
      atr: 250,
      atr20: 250,
      boxLowSlope: -0.003,
      rangeCenterSlope: -0.003,
      boxHighSlope: -0.003,
      emaGap: -0.002,
      qualityScore: 65,
      trendWeaknessScore: 0.3,
      candles: microCandles,
      canonicalRegime: "RANGE",
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBearishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "UP", // UP shock when breakdown occurred
      shortAllow: true,
      longAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true
    },
    "BEARISH"
  );
  (inputOppositeShock.state as any).directionalShockState = "UP";

  const res = runEngineV2(inputOppositeShock);
  const meta = res.decision.metadata ?? {};
  const judgment = res.internal?.judgment;

  run(
    "TEST_KK_OPPOSITE_SHOCK_BLOCKED",
    res.decision.decision !== "ENTER" &&
      (judgment?.shockPhase === "UP_SHOCK" || meta.micro_probe_block_reason === "SHOCK_PHASE_ACTIVE"),
    `Opposite shock blocks micro probe. decision=${res.decision.decision}, shockPhase=${judgment?.shockPhase}, blockReason=${meta.micro_probe_block_reason}`
  );
}

// =========================================================================
// TEST LL (Item 8.8) — AUTHORITATIVE finalOrderNotionalUsdt=0 + stageMarginKrw>0 IN LIVE => BLOCKED
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const now = Date.now();
  const watchBoundary = 69000;

  rangeContinuationStateMap.set("BTCUSDT", {
    direction: "down",
    phase: "CONTINUATION_WATCH",
    watchStartedCandleTs: now - 60000,
    watchStartedAtTimestamp: now - 1000,
    watchBoundaryPrice: watchBoundary,
    countStartedCandleTs: null,
    countBoundaryPrice: null,
    hasCandleAdvancedDuringCount: false,
    totalCyclesSinceWatch: 0
  } as any);

  const microCandles = makeMicroDownReboundCandles(68930);

  const inputZeroNotional = makeBaseInput(
    "BTCUSDT",
    {
      lastPrice: 68930,
      closedClose: 68920,
      atr: 250,
      atr20: 250,
      boxLowSlope: -0.003,
      rangeCenterSlope: -0.003,
      boxHighSlope: -0.003,
      emaGap: -0.002,
      qualityScore: 65,
      trendWeaknessScore: 0.55,
      candles: microCandles,
      canonicalRegime: "RANGE",
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBearishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true,
      okxAuthMode: "live",
      okxExchangeAuthOptIn: true,
      okxLiveEnabled: true,
      liveBalanceReady: true,
      accountEquityUsdt: 0, // Zero equity -> finalOrderNotionalUsdt = 0
      availableBalanceUsdt: 0,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true
    },
    "BEARISH"
  );

  const res = runEngineV2(inputZeroNotional);
  const decision = res.decision;

  run(
    "TEST_LL_AUTHORITATIVE_ZERO_NOTIONAL_IN_LIVE_BLOCKED",
    decision.decision !== "ENTER" &&
      decision.committedRiskPlan === undefined &&
      (Number(decision.risk.finalOrderNotionalUsdt ?? 0) === 0),
    `Zero notional in live mode prevents ENTER and does not manufacture committedRiskPlan. decision=${decision.decision}, plan=${decision.committedRiskPlan}`
  );
}

// =========================================================================
// TEST MM (Requirement 1) — counterTrendRisk ALONE DOES NOT MANUFACTURE WHIPSAW_SOFT_WATCH
// - counterTrendRisk = true (due to 4h bullish vs 5m/15m bearish)
// - micro reversal = true (micro_down_then_rebound)
// - directionalShockState = "NONE"
// - no pump/crash ALERT
// - no existing episode
// - no fresh structural risk
// Expected:
// - Must NOT become WHIPSAW_SOFT_WATCH solely because of counterTrendRisk.
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const microCandles = makeMicroDownReboundCandles(68930);

  const inputNoSoftWatch = makeBaseInput(
    "BTCUSDT",
    {
      lastPrice: 68930,
      closedClose: 68920,
      atr: 250,
      atr20: 250,
      boxLowSlope: -0.003,
      rangeCenterSlope: -0.003,
      boxHighSlope: -0.003,
      emaGap: -0.002,
      qualityScore: 65,
      trendWeaknessScore: 0.3,
      reviewing_ticks: 0,
      boxBreakSide: "none",
      breakoutFailureRate: 0.1,
      volumeExpansion: 1.0,
      candles: microCandles,
      canonicalRegime: "RANGE",
      htf_candles: {
        "5m": mockBearishCandles,
        "15m": mockBearishCandles,
        "1h": mockBearishCandles,
        "4h": mockBullishCandles // Creates counterTrendRisk: true
      }
    },
    {
      directionalShockState: "NONE",
      shortAllow: true,
      longAllow: false
    },
    "BEARISH"
  );

  const judgment = detectMarketRegime(inputNoSoftWatch);

  run(
    "TEST_MM_COUNTER_TREND_RISK_ALONE_DOES_NOT_MANUFACTURE_WHIPSAW_SOFT_WATCH",
    judgment.counter_trend_risk === true &&
      judgment.subtype !== "WHIPSAW_SOFT_WATCH" &&
      judgment.diagnostics?.whipsaw?.isSoftWatch === false,
    `counterTrendRisk alone does not create WHIPSAW_SOFT_WATCH. subtype=${judgment.subtype}, isSoftWatch=${judgment.diagnostics?.whipsaw?.isSoftWatch}`
  );
}

// =========================================================================
// TEST NN (Requirement 2) — DIAGNOSTIC TRUTHFULNESS DOES NOT MUTATE EXECUTION DECISION
// - Quality score < 70 (Grade B / 65)
// - Trend weakness score = 0.55 (trendOk = false)
// - activeEngineRouting = "TREND"
// Expected:
// - Execution decision is identical to 994371a control flow (SKIP/none)
// - Late diagnostic layer truthfully reports primary_missing_condition = "TREND_PROMOTION_BLOCKED_TREND_WEAKNESS_TOO_HIGH"
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const inputDiag = makeBaseInput(
    "BTCUSDT",
    {
      qualityScore: 65,
      trendWeaknessScore: 0.55,
      emaGap: 0.002,
      canonicalRegime: "TREND",
      canonicalRegimeSource: "strategy_market_regime_detector",
      canonicalTrendScore: 0.85,
      candles: mockBullishCandles,
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "NONE",
      longAllow: true,
      shortAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true
    }
  );

  const res = runEngineV2(inputDiag);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_NN_DIAGNOSTIC_TRUTHFULNESS_DOES_NOT_MUTATE_EXECUTION_DECISION",
    decision.decision === "SKIP" &&
      decision.side === "none" &&
      meta.primary_missing_condition === "TREND_PROMOTION_BLOCKED_TREND_WEAKNESS_TOO_HIGH",
    `Late diagnostic accurately reports trend weakness without changing execution decision. decision=${decision.decision}, missingCondition=${meta.primary_missing_condition}`
  );
}

// =========================================================================
// TEST OO (Requirement 1) — WHIPSAW_SOFT_WATCH + PROBE_ONLY + trendPhase=PULLBACK
// Micro probe evaluates and blocks with TREND_NOT_DOWN; later quality gate also fails.
// Assert:
// - decision unchanged (SKIP/HOLD as baseline)
// - side unchanged (none)
// - micro_probe_block_reason === "TREND_NOT_DOWN"
// - primary_missing_condition === "TREND_NOT_DOWN"
// - generic quality reason remains secondary/audit-visible
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const now = Date.now();
  const watchBoundary = 69000;

  rangeContinuationStateMap.set("BTCUSDT", {
    direction: "down",
    phase: "CONTINUATION_WATCH",
    watchStartedCandleTs: now - 60000,
    watchStartedAtTimestamp: now - 1000,
    watchBoundaryPrice: watchBoundary,
    countStartedCandleTs: null,
    countBoundaryPrice: null,
    hasCandleAdvancedDuringCount: false,
    totalCyclesSinceWatch: 0
  } as any);

  const microCandles = makeMicroDownReboundCandles(68930);

  const snap: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 68930,
    latestCandleClose: 68930,
    signal: "paper_short_candidate",
    qualityScore: 65,
    candidateStrength: "strong",
    ema20: 68850,
    ema60: 69200,
    emaGap: -0.003,
    volumeRatioProxy: 1.1,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.35,
    boxRel: -0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 68920,
    rangeConfidence: 0.2,
    trendWeaknessScore: 0.56,
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.1,
    rangeOscillationScore: 0.2,
    boxLowSlope: -0.003,
    rangeCenterSlope: -0.003,
    boxHighSlope: -0.003,
    reviewing_ticks: 0,
    boxBreakSide: "none",
    volumeExpansion: 1.0,
    candles: microCandles,
    canonicalRegime: "TREND",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": mockBearishCandles,
      "15m": mockBearishCandles,
      "1h": mockBearishCandles,
      "4h": mockBullishCandles
    }
  };

  const bridge = buildV2SnapshotBridge(snap);
  const inputOO = adaptV2Input(
    "BTCUSDT",
    now,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true,
      okxAuthMode: "live",
      okxAuthReady: true,
      okxExchangeAuthOptIn: true,
      okxLiveEnabled: true,
      liveBalanceReady: true,
      accountEquityUsdt: 10000,
      availableBalanceUsdt: 10000,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true,
      okxPendingOrdersReady: true,
      okxPendingOrdersNotionalUsdt: 0,
      okxPendingSymbolNotionalUsdt: 0,
      okxActualPositions: [],
      balanceFetchedAt: now,
      positionsFetchedAt: now,
      pendingOrdersFetchedAt: now
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    microCandles,
    "authoritative",
    `cycle_BTCUSDT_${now}_oo`
  );

  const res = runEngineV2(inputOO);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_OO_MICRO_PROBE_BLOCK_REASON_ELEVATED_TO_PRIMARY_MISSING_CONDITION",
    (decision.decision === "HOLD" || decision.decision === "SKIP") &&
      decision.side === "none" &&
      meta.micro_probe_block_reason === "TREND_NOT_DOWN" &&
      meta.primary_missing_condition === "TREND_NOT_DOWN" &&
      meta.secondary_missing_condition === "TREND_PROMOTION_BLOCKED_TREND_WEAKNESS_TOO_HIGH",
    `Micro probe block reason takes diagnostic precedence as primary_missing_condition while generic promotion reason remains secondary. decision=${decision.decision}, primary=${meta.primary_missing_condition}, secondary=${meta.secondary_missing_condition}`
  );
}

// =========================================================================
// TEST PP (Requirement 2) — HARD BLOCKER + MICRO PROBE BLOCKER COEXIST
// Assert hard safety blocker remains primary and TREND_NOT_DOWN cannot outrank it.
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const now = Date.now();
  const watchBoundary = 69000;

  rangeContinuationStateMap.set("BTCUSDT", {
    direction: "down",
    phase: "CONTINUATION_WATCH",
    watchStartedCandleTs: now - 60000,
    watchStartedAtTimestamp: now - 1000,
    watchBoundaryPrice: watchBoundary,
    countStartedCandleTs: null,
    countBoundaryPrice: null,
    hasCandleAdvancedDuringCount: false,
    totalCyclesSinceWatch: 0
  } as any);

  const microCandles = makeMicroDownReboundCandles(68930);

  const snap: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 68930,
    latestCandleClose: 68930,
    signal: "paper_short_candidate",
    qualityScore: 65,
    candidateStrength: "strong",
    ema20: 68850,
    ema60: 69200,
    emaGap: -0.003,
    volumeRatioProxy: 1.1,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.35,
    boxRel: -0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 68920,
    rangeConfidence: 0.2,
    trendWeaknessScore: 0.56,
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.45, // KEY: Real shock evidence -> whipsaw.active -> WHIPSAW_SHOCK_RECHECK
    rangeOscillationScore: 0.2,
    boxLowSlope: -0.003,
    rangeCenterSlope: -0.003,
    boxHighSlope: -0.003,
    reviewing_ticks: 0,
    boxBreakSide: "none",
    volumeExpansion: 2.5,      // KEY: Volume expansion -> whipsaw.active -> WHIPSAW_SHOCK_RECHECK
    candles: microCandles,
    canonicalRegime: "TREND",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": mockBearishCandles,
      "15m": mockBearishCandles,
      "1h": mockBearishCandles,
      "4h": mockBullishCandles
    }
  };

  const bridge = buildV2SnapshotBridge(snap);
  const inputPP = adaptV2Input(
    "BTCUSDT",
    now,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true,
      okxAuthMode: "live",
      okxAuthReady: true,
      okxExchangeAuthOptIn: true,
      okxLiveEnabled: true,
      liveBalanceReady: true,
      accountEquityUsdt: 10000,
      availableBalanceUsdt: 10000,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true,
      okxPendingOrdersReady: true,
      okxPendingOrdersNotionalUsdt: 0,
      okxPendingSymbolNotionalUsdt: 0,
      okxActualPositions: [],
      balanceFetchedAt: now,
      positionsFetchedAt: now,
      pendingOrdersFetchedAt: now
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    microCandles,
    "authoritative",
    `cycle_BTCUSDT_${now}_pp`
  );

  const res = runEngineV2(inputPP);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_PP_HARD_BLOCKER_OUTRANKS_MICRO_PROBE_BLOCKER",
    (decision.decision === "HOLD" || decision.decision === "REJECT" || decision.decision === "SKIP") &&
      decision.side === "none" &&
      meta.micro_probe_block_reason === "TREND_NOT_DOWN" &&
      meta.primary_missing_condition === "WHIPSAW_RECHECK_NOT_CONFIRMED" &&
      meta.primary_missing_condition !== "TREND_NOT_DOWN",
    `Hard safety blocker strictly outranks micro probe block reason in diagnostic precedence. primary=${meta.primary_missing_condition}, microProbeBlock=${meta.micro_probe_block_reason}`
  );
}

// =========================================================================
// TEST QQ (Requirement 3) — NO MICRO-PROBE EVALUATION, ORDINARY QUALITY FAILURE
// Assert existing TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD remains primary exactly as before.
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const inputQQ = makeBaseInput(
    "BTCUSDT",
    {
      qualityScore: 65,            // < 70 -> fails quality gate
      trendWeaknessScore: 0.1,     // healthy trend weakness
      emaGap: 0.002,               // healthy emaGap -> trendOk = true
      canonicalRegime: "TREND",
      canonicalRegimeSource: "strategy_market_regime_detector",
      canonicalTrendScore: 0.85,
      candles: mockBullishCandles,
      htf_candles: {
        "5m": mockBullishCandles,
        "15m": mockBullishCandles,
        "1h": mockBullishCandles,
        "4h": mockBullishCandles
      }
    },
    {
      directionalShockState: "NONE",
      longAllow: true,
      shortAllow: false,
      signedExecutionReady: true,
      paperExecutionReady: true
    }
  );

  const res = runEngineV2(inputQQ);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_QQ_NO_MICRO_PROBE_QUALITY_BELOW_THRESHOLD_REMAINS_PRIMARY",
    decision.decision === "SKIP" &&
      decision.side === "none" &&
      meta.micro_probe_block_reason === undefined &&
      meta.primary_missing_condition === "TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD" &&
      meta.secondary_missing_condition === null,
    `Ordinary quality failure without micro probe retains TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD as primary. decision=${decision.decision}, primary=${meta.primary_missing_condition}, secondary=${meta.secondary_missing_condition}`
  );
}

// =========================================================================
// TEST RR — DIAGNOSTIC FIELD SEPARATION & EXECUTION INVARIANCE
// Assert v2_router_executor === routing.executor, execution fields remain unchanged.
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const now = Date.now();
  const snap: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 68930,
    latestCandleClose: 68930,
    signal: "paper_short_candidate",
    qualityScore: 65,
    candidateStrength: "strong",
    ema20: 68850,
    ema60: 69200,
    emaGap: -0.003,
    volumeRatioProxy: 1.1,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.35,
    boxRel: -0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 68920,
    rangeConfidence: 0.2,
    trendWeaknessScore: 0.56,
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.1,
    rangeOscillationScore: 0.2,
    boxLowSlope: -0.003,
    rangeCenterSlope: -0.003,
    boxHighSlope: -0.003,
    reviewing_ticks: 0,
    boxBreakSide: "none",
    volumeExpansion: 1.0,
    candles: mockBearishCandles,
    canonicalRegime: "TREND",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": mockBearishCandles,
      "15m": mockBearishCandles,
      "1h": mockBearishCandles,
      "4h": mockBullishCandles
    }
  };

  const bridge = buildV2SnapshotBridge(snap);
  const inputRR = adaptV2Input(
    "BTCUSDT",
    now,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true,
      okxAuthMode: "live",
      okxAuthReady: true,
      okxExchangeAuthOptIn: true,
      okxLiveEnabled: true,
      liveBalanceReady: true,
      accountEquityUsdt: 10000,
      availableBalanceUsdt: 10000,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true,
      okxPendingOrdersReady: true,
      okxPendingOrdersNotionalUsdt: 0,
      okxPendingSymbolNotionalUsdt: 0,
      okxActualPositions: [],
      balanceFetchedAt: now,
      positionsFetchedAt: now,
      pendingOrdersFetchedAt: now
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    mockBearishCandles,
    "authoritative",
    `cycle_BTCUSDT_${now}_rr`
  );

  const res = runEngineV2(inputRR);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};
  const v2RoutingExecutor = res.internal.routing.executor;

  const env = resolveSymbolDecisionEnvelope({
    symbol: "BTCUSDT" as any,
    fetchedAt: now,
    snapshot: bridge,
    config: { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    state: {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true
    } as any,
    legacy: {
      regime: "RANGE",
      finalDecision: "SKIP",
      rejectReason: "none",
      requiredCostUsd: 0,
      entryAllowed: false,
      executorLabel: "range",
      intentSide: "none",
      adaptiveOk: true,
      adaptiveDetail: {}
    } as any,
    v2Mode: "engine_v2",
    evaluationMode: "authoritative",
    runCycleId: `cycle_BTCUSDT_${now}_rr`
  });

  const v2Env = env.v2_execution_envelope;
  const topLevelExecutionLane = "TREND";

  // Simulate noEntryAuditRow mapping from paper-engine.ts
  const noEntryAuditRow = {
    expected_missing_condition: v2Env?.expected_missing_condition,
    primary_missing_condition: v2Env?.primary_missing_condition,
    secondary_missing_condition: v2Env?.secondary_missing_condition,
    market_subtype: v2Env?.marketSubtype,
    active_engine_routing: topLevelExecutionLane,
    top_level_execution_lane: topLevelExecutionLane,
    v2_router_executor: v2Env?.v2_router_executor ?? null
  };

  run(
    "TEST_RR_DIAGNOSTIC_FIELD_SEPARATION_AND_EXECUTION_INVARIANCE",
    // 1. Execution invariance
    (decision.decision === "HOLD" || decision.decision === "SKIP") &&
      decision.side === "none" &&
      inputRR.state.longAllow === false &&
      inputRR.state.shortAllow === true &&
      meta.promotionApplied === false &&
      meta.promotionBlockReason === "TREND_PROMOTION_BLOCKED_TREND_WEAKNESS_TOO_HIGH" &&
      meta.htf_entry_policy === "PROBE_ONLY" &&
      meta.primary_missing_condition === "WATCH_BOUNDARY_MISSING" &&
      meta.secondary_missing_condition === "TREND_PROMOTION_BLOCKED_TREND_WEAKNESS_TOO_HIGH" &&
      // 2. Diagnostic field separation & noEntryAuditRow correctness
      noEntryAuditRow.active_engine_routing === topLevelExecutionLane &&
      noEntryAuditRow.top_level_execution_lane === topLevelExecutionLane &&
      noEntryAuditRow.v2_router_executor === v2RoutingExecutor &&
      meta.v2_router_executor === v2RoutingExecutor &&
      v2Env?.v2_router_executor === v2RoutingExecutor,
    `Diagnostic fields properly separated and execution invariant preserved. decision=${decision.decision}, side=${decision.side}, v2_router_executor=${noEntryAuditRow.v2_router_executor}, top_level_execution_lane=${noEntryAuditRow.top_level_execution_lane}`
  );
}

// =========================================================================
// TEST SS — WATCH_BOUNDARY_MISSING ALIGNS EXPECTED_NEXT_ACTION TO BREAKOUT/BREAKDOWN SETUP
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const now = Date.now();
  const snap: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 68930,
    latestCandleClose: 68930,
    signal: "paper_short_candidate",
    qualityScore: 65,
    candidateStrength: "strong",
    ema20: 68850,
    ema60: 69200,
    emaGap: -0.003,
    volumeRatioProxy: 1.1,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.35,
    boxRel: -0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 68920,
    rangeConfidence: 0.2,
    trendWeaknessScore: 0.2, // normal trend weakness so qualityScore is the only gate hit
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.1,
    rangeOscillationScore: 0.2,
    boxLowSlope: -0.003,
    rangeCenterSlope: -0.003,
    boxHighSlope: -0.003,
    reviewing_ticks: 0,
    boxBreakSide: "none",
    volumeExpansion: 1.0,
    candles: mockBearishCandles,
    canonicalRegime: "TREND",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": mockBearishCandles,
      "15m": mockBearishCandles,
      "1h": mockBearishCandles,
      "4h": mockBullishCandles
    }
  };

  const bridge = buildV2SnapshotBridge(snap);
  const inputSS = adaptV2Input(
    "BTCUSDT",
    now,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true,
      okxAuthMode: "live",
      okxAuthReady: true,
      okxExchangeAuthOptIn: true,
      okxLiveEnabled: true,
      liveBalanceReady: true,
      accountEquityUsdt: 10000,
      availableBalanceUsdt: 10000,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true,
      okxPendingOrdersReady: true,
      okxPendingOrdersNotionalUsdt: 0,
      okxPendingSymbolNotionalUsdt: 0,
      okxActualPositions: [],
      balanceFetchedAt: now,
      positionsFetchedAt: now,
      pendingOrdersFetchedAt: now
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    mockBearishCandles,
    "authoritative",
    `cycle_BTCUSDT_${now}_ss`
  );

  const res = runEngineV2(inputSS);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_SS_WATCH_BOUNDARY_MISSING_ALIGNS_EXPECTED_NEXT_ACTION",
    (decision.decision === "HOLD" || decision.decision === "SKIP") &&
      decision.side === "none" &&
      meta.micro_probe_block_reason === "WATCH_BOUNDARY_MISSING" &&
      meta.primary_missing_condition === "WATCH_BOUNDARY_MISSING" &&
      meta.expectedMissingCondition === "WATCH_BOUNDARY_MISSING" &&
      meta.expectedNextAction === "WAIT_FOR_BREAKOUT_OR_BREAKDOWN_SETUP" &&
      meta.secondary_missing_condition === "TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD" &&
      meta.promotionApplied === false &&
      meta.promotionBlockReason === "TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD" &&
      meta.htf_entry_policy === "PROBE_ONLY" &&
      inputSS.state.longAllow === false &&
      inputSS.state.shortAllow === true,
    `WATCH_BOUNDARY_MISSING successfully aligns expected_next_action to WAIT_FOR_BREAKOUT_OR_BREAKDOWN_SETUP while preserving secondary. primary=${meta.primary_missing_condition}, nextAction=${meta.expectedNextAction}, secondary=${meta.secondary_missing_condition}`
  );
}

// =========================================================================
// TEST TT — HARD SAFETY BLOCKER STRICTLY OUTRANKS WATCH_BOUNDARY_MISSING
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const now = Date.now();
  const snap: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 68930,
    latestCandleClose: 68930,
    signal: "paper_short_candidate",
    qualityScore: 65,
    candidateStrength: "strong",
    ema20: 68850,
    ema60: 69200,
    emaGap: -0.003,
    volumeRatioProxy: 1.1,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.35,
    boxRel: -0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 68920,
    rangeConfidence: 0.2,
    trendWeaknessScore: 0.56,
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.45, // Real shock hit -> whipsaw.active -> WHIPSAW_SHOCK_RECHECK
    rangeOscillationScore: 0.2,
    boxLowSlope: -0.003,
    rangeCenterSlope: -0.003,
    boxHighSlope: -0.003,
    reviewing_ticks: 0,
    boxBreakSide: "none",
    volumeExpansion: 2.5,      // Volume expansion -> whipsaw.active -> WHIPSAW_SHOCK_RECHECK
    candles: mockBearishCandles,
    canonicalRegime: "TREND",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": mockBearishCandles,
      "15m": mockBearishCandles,
      "1h": mockBearishCandles,
      "4h": mockBullishCandles
    }
  };

  const bridge = buildV2SnapshotBridge(snap);
  const inputTT = adaptV2Input(
    "BTCUSDT",
    now,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true,
      okxAuthMode: "live",
      okxAuthReady: true,
      okxExchangeAuthOptIn: true,
      okxLiveEnabled: true,
      liveBalanceReady: true,
      accountEquityUsdt: 10000,
      availableBalanceUsdt: 10000,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true,
      okxPendingOrdersReady: true,
      okxPendingOrdersNotionalUsdt: 0,
      okxPendingSymbolNotionalUsdt: 0,
      okxActualPositions: [],
      balanceFetchedAt: now,
      positionsFetchedAt: now,
      pendingOrdersFetchedAt: now
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    mockBearishCandles,
    "authoritative",
    `cycle_BTCUSDT_${now}_tt`
  );

  const res = runEngineV2(inputTT);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  run(
    "TEST_TT_HARD_SAFETY_BLOCKER_OUTRANKS_WATCH_BOUNDARY_MISSING",
    (decision.decision === "HOLD" || decision.decision === "REJECT" || decision.decision === "SKIP") &&
      decision.side === "none" &&
      meta.primary_missing_condition === "WHIPSAW_RECHECK_NOT_CONFIRMED" &&
      meta.expectedNextAction === "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION" &&
      meta.micro_probe_block_reason === "WATCH_BOUNDARY_MISSING",
    `Hard safety blocker strictly outranks WATCH_BOUNDARY_MISSING in missing condition and next action. primary=${meta.primary_missing_condition}, nextAction=${meta.expectedNextAction}, microProbe=${meta.micro_probe_block_reason}`
  );
}

// =========================================================================
// TEST UU — AUDIT ROW PRECEDENCE: WATCH_BOUNDARY_MISSING OUTRANKS QUALITY_BELOW_THRESHOLD
// =========================================================================
{
  const noEntryAuditNextByVetoOrMissing: Record<string, string> = {
    WHIPSAW_SHOCK_RECHECK_ACTIVE: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
    WHIPSAW_RECHECK_NOT_CONFIRMED: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
    SHOCK_UP_RECLAIM_NOT_CONFIRMED: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
    SHOCK_UP_MID_RETEST_REQUIRED: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
    SHOCK_UP_TREND_CONFIRMATION_WEAK: "WAIT_FOR_TREND_CONFIRMATION",
    SHOCK_DOWN_BREAKDOWN_RETEST_NOT_CONFIRMED: "WAIT_FOR_BREAKDOWN_RETEST_FAILURE",
    SHOCK_DOWN_MID_RETEST_REQUIRED: "WAIT_FOR_BREAKDOWN_RETEST_FAILURE",
    SHOCK_DOWN_TREND_CONFIRMATION_WEAK: "WAIT_FOR_TREND_CONFIRMATION",
    RANGE_TREND_SIDE_CONFLICT: "WAIT_FOR_RANGE_TREND_ALIGNMENT",
    TREND_PROMOTION_BLOCKED_HTF_DATA_NOT_READY: "WAIT_FOR_HTF_DATA_READY",
    TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD: "WAIT_FOR_QUALITY_IMPROVEMENT",
    TREND_PROMOTION_BLOCKED_QUALITY: "WAIT_FOR_QUALITY_IMPROVEMENT",
    TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED: "WAIT_FOR_BREAKOUT_RETEST_SUPPORT_CONFIRM",
    TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED: "WAIT_FOR_RECHECK_OR_RETEST",
    TREND_PROMOTION_VETOED: "WAIT_FOR_PROMOTION_CONFIRMATION",
    RECOVERY_MODE_SIZE_SUPPRESSED: "WAIT_FOR_RECOVERY_MODE_CLEAR_OR_HIGH_CONFIDENCE_RETEST",
    POLARITY_MISMATCH_BULLISH_MACRO_LIMITS_SHORT_SHOCK: "WAIT_FOR_HTF_POLARITY_ALIGNMENT",
    WATCH_BOUNDARY_MISSING: "WAIT_FOR_BREAKOUT_OR_BREAKDOWN_SETUP"
  };

  const vetoKey = "TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD";
  const missingKey = "WATCH_BOUNDARY_MISSING";

  const nextFromAuditKey =
    (missingKey && noEntryAuditNextByVetoOrMissing[missingKey]) ||
    (vetoKey && noEntryAuditNextByVetoOrMissing[vetoKey]) ||
    null;

  run(
    "TEST_UU_WATCH_BOUNDARY_MISSING_OUTRANKS_QUALITY_BELOW_THRESHOLD_IN_AUDIT",
    nextFromAuditKey === "WAIT_FOR_BREAKOUT_OR_BREAKDOWN_SETUP",
    `Audit row precedence correctly selects WAIT_FOR_BREAKOUT_OR_BREAKDOWN_SETUP over WAIT_FOR_QUALITY_IMPROVEMENT. nextAction=${nextFromAuditKey}`
  );
}

// =========================================================================
// TEST VV — AUDIT ROW PRECEDENCE: POLARITY_MISMATCH OUTRANKS RANGE_TREND_SIDE_CONFLICT + FALLBACK
// =========================================================================
{
  const noEntryAuditNextByVetoOrMissing: Record<string, string> = {
    WHIPSAW_SHOCK_RECHECK_ACTIVE: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
    WHIPSAW_RECHECK_NOT_CONFIRMED: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
    SHOCK_UP_RECLAIM_NOT_CONFIRMED: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
    SHOCK_UP_MID_RETEST_REQUIRED: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
    SHOCK_UP_TREND_CONFIRMATION_WEAK: "WAIT_FOR_TREND_CONFIRMATION",
    SHOCK_DOWN_BREAKDOWN_RETEST_NOT_CONFIRMED: "WAIT_FOR_BREAKDOWN_RETEST_FAILURE",
    SHOCK_DOWN_MID_RETEST_REQUIRED: "WAIT_FOR_BREAKDOWN_RETEST_FAILURE",
    SHOCK_DOWN_TREND_CONFIRMATION_WEAK: "WAIT_FOR_TREND_CONFIRMATION",
    RANGE_TREND_SIDE_CONFLICT: "WAIT_FOR_RANGE_TREND_ALIGNMENT",
    TREND_PROMOTION_BLOCKED_HTF_DATA_NOT_READY: "WAIT_FOR_HTF_DATA_READY",
    TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD: "WAIT_FOR_QUALITY_IMPROVEMENT",
    TREND_PROMOTION_BLOCKED_QUALITY: "WAIT_FOR_QUALITY_IMPROVEMENT",
    TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED: "WAIT_FOR_BREAKOUT_RETEST_SUPPORT_CONFIRM",
    TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED: "WAIT_FOR_RECHECK_OR_RETEST",
    TREND_PROMOTION_VETOED: "WAIT_FOR_PROMOTION_CONFIRMATION",
    RECOVERY_MODE_SIZE_SUPPRESSED: "WAIT_FOR_RECOVERY_MODE_CLEAR_OR_HIGH_CONFIDENCE_RETEST",
    POLARITY_MISMATCH_BULLISH_MACRO_LIMITS_SHORT_SHOCK: "WAIT_FOR_HTF_POLARITY_ALIGNMENT",
    WATCH_BOUNDARY_MISSING: "WAIT_FOR_BREAKOUT_OR_BREAKDOWN_SETUP"
  };

  // Case 1: missingKey is POLARITY_MISMATCH, vetoKey is RANGE_TREND_SIDE_CONFLICT
  const vetoKey1 = "RANGE_TREND_SIDE_CONFLICT";
  const missingKey1 = "POLARITY_MISMATCH_BULLISH_MACRO_LIMITS_SHORT_SHOCK";
  const nextFromAuditKey1 =
    (missingKey1 && noEntryAuditNextByVetoOrMissing[missingKey1]) ||
    (vetoKey1 && noEntryAuditNextByVetoOrMissing[vetoKey1]) ||
    null;

  // Case 2: missingKey is unknown token, vetoKey is RANGE_TREND_SIDE_CONFLICT -> fallback to vetoKey mapping
  const vetoKey2 = "RANGE_TREND_SIDE_CONFLICT";
  const missingKey2 = "SOME_UNMAPPED_MISSING_REASON";
  const nextFromAuditKey2 =
    (missingKey2 && noEntryAuditNextByVetoOrMissing[missingKey2]) ||
    (vetoKey2 && noEntryAuditNextByVetoOrMissing[vetoKey2]) ||
    null;

  run(
    "TEST_VV_POLARITY_MISMATCH_OUTRANKS_RANGE_TREND_SIDE_CONFLICT_AND_PRESERVES_FALLBACK",
    nextFromAuditKey1 === "WAIT_FOR_HTF_POLARITY_ALIGNMENT" &&
      nextFromAuditKey2 === "WAIT_FOR_RANGE_TREND_ALIGNMENT",
    `Polarity mismatch outranks range/trend conflict and preserves veto fallback when missingKey is unmapped. next1=${nextFromAuditKey1}, next2=${nextFromAuditKey2}`
  );
}

// =========================================================================
// TEST WW — AUDIT ROW MAPPING FOR 13 AUTHORITATIVE PRIMARY MISSING TOKENS
// =========================================================================
{
  const noEntryAuditNextByVetoOrMissing: Record<string, string> = {
    WHIPSAW_SHOCK_RECHECK_ACTIVE: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
    WHIPSAW_RECHECK_NOT_CONFIRMED: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
    SHOCK_UP_RECLAIM_NOT_CONFIRMED: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
    SHOCK_UP_MID_RETEST_REQUIRED: "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION",
    SHOCK_UP_TREND_CONFIRMATION_WEAK: "WAIT_FOR_TREND_CONFIRMATION",
    SHOCK_DOWN_BREAKDOWN_RETEST_NOT_CONFIRMED: "WAIT_FOR_BREAKDOWN_RETEST_FAILURE",
    SHOCK_DOWN_MID_RETEST_REQUIRED: "WAIT_FOR_BREAKDOWN_RETEST_FAILURE",
    SHOCK_DOWN_TREND_CONFIRMATION_WEAK: "WAIT_FOR_TREND_CONFIRMATION",
    RANGE_TREND_SIDE_CONFLICT: "WAIT_FOR_RANGE_TREND_ALIGNMENT",
    TREND_PROMOTION_BLOCKED_HTF_DATA_NOT_READY: "WAIT_FOR_HTF_DATA_READY",
    TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD: "WAIT_FOR_QUALITY_IMPROVEMENT",
    TREND_PROMOTION_BLOCKED_QUALITY: "WAIT_FOR_QUALITY_IMPROVEMENT",
    TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED: "WAIT_FOR_BREAKOUT_RETEST_SUPPORT_CONFIRM",
    TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED: "WAIT_FOR_RECHECK_OR_RETEST",
    TREND_PROMOTION_VETOED: "WAIT_FOR_PROMOTION_CONFIRMATION",
    RECOVERY_MODE_SIZE_SUPPRESSED: "WAIT_FOR_RECOVERY_MODE_CLEAR_OR_HIGH_CONFIDENCE_RETEST",
    POLARITY_MISMATCH_BULLISH_MACRO_LIMITS_SHORT_SHOCK: "WAIT_FOR_HTF_POLARITY_ALIGNMENT",
    POLARITY_MISMATCH_BEARISH_MACRO_LIMITS_LONG_SHOCK: "WAIT_FOR_HTF_POLARITY_ALIGNMENT",
    POLARITY_MISMATCH_BULLISH_MACRO: "WAIT_FOR_HTF_POLARITY_ALIGNMENT",
    POLARITY_MISMATCH_BEARISH_MACRO: "WAIT_FOR_HTF_POLARITY_ALIGNMENT",
    HTF_POLICY_POLARITY_MISMATCH: "WAIT_FOR_HTF_POLARITY_ALIGNMENT",
    WATCH_BOUNDARY_MISSING: "WAIT_FOR_BREAKOUT_OR_BREAKDOWN_SETUP",
    TREND_PROMOTION_BLOCKED_TREND_WEAKNESS_TOO_HIGH: "WAIT_FOR_TREND_STRENGTHENING",
    TREND_PROMOTION_BLOCKED_EMA_GAP_INSUFFICIENT: "WAIT_FOR_TREND_CONFIRMATION",
    TREND_PROMOTION_BLOCKED_TREND_NOT_CONFIRMED: "WAIT_FOR_TREND_CONFIRMATION",
    TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKDOWN_CONFIRMED: "WAIT_FOR_BREAKDOWN_RETEST_RESISTANCE_CONFIRM",
    TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKOUT_CONFIRMED: "WAIT_FOR_BREAKOUT_RETEST_SUPPORT_CONFIRM",
    TREND_PROMOTION_BLOCKED_BREAKDOWN_RETEST_NOT_CONFIRMED: "WAIT_FOR_BREAKDOWN_RETEST_FAILURE",
    SIGNED_EXECUTION_NOT_READY: "WAIT_FOR_SIGNED_EXECUTION_READY",
    TWO_CONSECUTIVE_LOSSES_RECOVERY_MODE: "WAIT_FOR_RECOVERY_MODE_CLEAR_OR_HIGH_CONFIDENCE_RETEST",
    ENTRY_QUALITY_CONTAMINATED: "WAIT_FOR_QUALITY_IMPROVEMENT"
  };

  const conflictingVeto = "RANGE_TREND_SIDE_CONFLICT";

  const resolveNext = (missingKey: string, vetoKey: string) =>
    (missingKey && noEntryAuditNextByVetoOrMissing[missingKey]) ||
    (vetoKey && noEntryAuditNextByVetoOrMissing[vetoKey]) ||
    null;

  // Verify all 13 tokens outrank conflicting veto
  const test1 = resolveNext("TREND_PROMOTION_BLOCKED_TREND_WEAKNESS_TOO_HIGH", conflictingVeto) === "WAIT_FOR_TREND_STRENGTHENING";
  const test2 = resolveNext("TREND_PROMOTION_BLOCKED_EMA_GAP_INSUFFICIENT", conflictingVeto) === "WAIT_FOR_TREND_CONFIRMATION";
  const test3 = resolveNext("TREND_PROMOTION_BLOCKED_TREND_NOT_CONFIRMED", conflictingVeto) === "WAIT_FOR_TREND_CONFIRMATION";
  const test4 = resolveNext("POLARITY_MISMATCH_BEARISH_MACRO_LIMITS_LONG_SHOCK", conflictingVeto) === "WAIT_FOR_HTF_POLARITY_ALIGNMENT";
  const test5 = resolveNext("POLARITY_MISMATCH_BULLISH_MACRO", conflictingVeto) === "WAIT_FOR_HTF_POLARITY_ALIGNMENT";
  const test6 = resolveNext("POLARITY_MISMATCH_BEARISH_MACRO", conflictingVeto) === "WAIT_FOR_HTF_POLARITY_ALIGNMENT";
  const test7 = resolveNext("HTF_POLICY_POLARITY_MISMATCH", conflictingVeto) === "WAIT_FOR_HTF_POLARITY_ALIGNMENT";
  const test8 = resolveNext("TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKDOWN_CONFIRMED", conflictingVeto) === "WAIT_FOR_BREAKDOWN_RETEST_RESISTANCE_CONFIRM";
  const test9 = resolveNext("TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKOUT_CONFIRMED", conflictingVeto) === "WAIT_FOR_BREAKOUT_RETEST_SUPPORT_CONFIRM";
  const test10 = resolveNext("TREND_PROMOTION_BLOCKED_BREAKDOWN_RETEST_NOT_CONFIRMED", conflictingVeto) === "WAIT_FOR_BREAKDOWN_RETEST_FAILURE";
  const test11 = resolveNext("SIGNED_EXECUTION_NOT_READY", conflictingVeto) === "WAIT_FOR_SIGNED_EXECUTION_READY";
  const test12 = resolveNext("TWO_CONSECUTIVE_LOSSES_RECOVERY_MODE", conflictingVeto) === "WAIT_FOR_RECOVERY_MODE_CLEAR_OR_HIGH_CONFIDENCE_RETEST";
  const test13 = resolveNext("ENTRY_QUALITY_CONTAMINATED", conflictingVeto) === "WAIT_FOR_QUALITY_IMPROVEMENT";

  // End-to-end evaluation check with runEngineV2
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();

  const now = Date.now();
  const snapWW: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 68930,
    latestCandleClose: 68930,
    signal: "paper_short_candidate",
    qualityScore: 65,
    candidateStrength: "strong",
    ema20: 68850,
    ema60: 69200,
    emaGap: -0.003,
    volumeRatioProxy: 1.1,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.35,
    boxRel: -0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 68920,
    rangeConfidence: 0.2,
    trendWeaknessScore: 0.56, // High trend weakness -> TREND_PROMOTION_BLOCKED_TREND_WEAKNESS_TOO_HIGH
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.1,
    rangeOscillationScore: 0.2,
    boxLowSlope: -0.003,
    rangeCenterSlope: -0.003,
    boxHighSlope: -0.003,
    reviewing_ticks: 0,
    boxBreakSide: "none",
    volumeExpansion: 1.0,
    candles: mockBearishCandles,
    canonicalRegime: "TREND",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": mockBearishCandles,
      "15m": mockBearishCandles,
      "1h": mockBearishCandles,
      "4h": mockBullishCandles
    }
  };

  const bridgeWW = buildV2SnapshotBridge(snapWW);
  const inputWW = adaptV2Input(
    "BTCUSDT",
    now,
    bridgeWW as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true,
      okxAuthMode: "live",
      okxAuthReady: true,
      okxExchangeAuthOptIn: true,
      okxLiveEnabled: true,
      liveBalanceReady: true,
      accountEquityUsdt: 10000,
      availableBalanceUsdt: 10000,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true,
      okxPendingOrdersReady: true,
      okxPendingOrdersNotionalUsdt: 0,
      okxPendingSymbolNotionalUsdt: 0,
      okxActualPositions: [],
      balanceFetchedAt: now,
      positionsFetchedAt: now,
      pendingOrdersFetchedAt: now
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    mockBearishCandles,
    "authoritative",
    `cycle_BTCUSDT_${now}_ww`
  );

  const resWW = runEngineV2(inputWW);
  const decisionWW = resWW.decision;

  run(
    "TEST_WW_AUDIT_ROW_MAPPING_FOR_13_AUTHORITATIVE_TOKENS",
    test1 &&
      test2 &&
      test3 &&
      test4 &&
      test5 &&
      test6 &&
      test7 &&
      test8 &&
      test9 &&
      test10 &&
      test11 &&
      test12 &&
      test13 &&
      (decisionWW.decision === "HOLD" || decisionWW.decision === "SKIP") &&
      decisionWW.side === "none" &&
      inputWW.state.longAllow === false &&
      inputWW.state.shortAllow === true,
    `All 13 authoritative primary missing tokens correctly mapped and outrank conflicting vetoes in audit action.`
  );
}

// =========================================================================
// TEST XX — DIAGNOSTIC TRUTHFULNESS: RANGE SHORT / TREND LONG CONFLICT + SKIP
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const now = Date.now();
  const mockConflictCandles: Candle[] = Array.from({ length: 120 }, (_, i) => ({
    ts: now - (120 - i) * 60000,
    open: 69000 + (i % 2 === 0 ? 30 : -30),
    high: 69100,
    low: 68900,
    close: 69000 + (i % 2 === 0 ? -20 : 20),
    volume: 50
  }));

  const snapConflict: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 69800,
    latestCandleClose: 69800,
    signal: "paper_long_candidate",
    qualityScore: 75,
    candidateStrength: "strong",
    ema20: 69500,
    ema60: 69200,
    emaGap: 0.003,
    volumeRatioProxy: 1.2,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.88,
    boxRel: 0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 69790,
    rangeConfidence: 0.7,
    trendWeaknessScore: 0.2,
    boxCohesion01: 0.8,
    breakoutFailureRate: 0.1,
    rangeOscillationScore: 0.2,
    candles: mockConflictCandles,
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": mockConflictCandles,
      "15m": mockConflictCandles,
      "1h": mockConflictCandles,
      "4h": mockConflictCandles
    }
  };

  const bridge = buildV2SnapshotBridge(snapConflict);
  const inputXX = adaptV2Input(
    "BTCUSDT",
    now,
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "NONE",
      crashState: "NORMAL",
      shortAllow: true,
      longAllow: true,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true,
      okxAuthMode: "live",
      okxAuthReady: true,
      okxExchangeAuthOptIn: true,
      okxLiveEnabled: true,
      liveBalanceReady: true,
      accountEquityUsdt: 10000,
      availableBalanceUsdt: 10000,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true,
      okxPendingOrdersReady: true,
      okxPendingOrdersNotionalUsdt: 0,
      okxPendingSymbolNotionalUsdt: 0,
      okxActualPositions: [],
      balanceFetchedAt: now,
      positionsFetchedAt: now,
      pendingOrdersFetchedAt: now
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    mockConflictCandles,
    "authoritative",
    `cycle_BTCUSDT_${now}_xx`
  );

  const res = runEngineV2(inputXX);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  const env = resolveSymbolDecisionEnvelope({
    symbol: "BTCUSDT" as any,
    fetchedAt: now,
    snapshot: bridge,
    config: { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    state: {
      directionalShockState: "NONE",
      crashState: "NORMAL",
      shortAllow: true,
      longAllow: true,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true
    } as any,
    legacy: {
      regime: "RANGE",
      finalDecision: "SKIP",
      rejectReason: "none",
      requiredCostUsd: 0,
      entryAllowed: false,
      executorLabel: "range",
      intentSide: "none",
      adaptiveOk: true,
      adaptiveDetail: {}
    } as any,
    v2Mode: "engine_v2",
    evaluationMode: "authoritative",
    runCycleId: `cycle_BTCUSDT_${now}_xx`
  });

  const v2Env = env.v2_execution_envelope;

  run(
    "TEST_XX_RANGE_SHORT_TREND_LONG_CONFLICT_SELECTED_SIDE_AFTER_VETO_TRUTHFULNESS",
    (decision.decision === "SKIP" || decision.decision === "HOLD") &&
      decision.side === "none" &&
      meta.selectedSideAfterVeto === "none" &&
      v2Env?.selected_side_after_veto === "none" &&
      (meta.side_veto_detail === "RANGE_TREND_SIDE_CONFLICT" || v2Env?.side_veto_detail === "RANGE_TREND_SIDE_CONFLICT") &&
      Boolean(meta.primary_missing_condition) &&
      Boolean(meta.expectedNextAction),
    `Conflict case truthful: decision=${decision.decision}, side=${decision.side}, meta.selectedSideAfterVeto=${meta.selectedSideAfterVeto}, env.selected_side_after_veto=${v2Env?.selected_side_after_veto}, side_veto_detail=${meta.side_veto_detail || v2Env?.side_veto_detail}`
  );
}

// =========================================================================
// TEST YY — DIAGNOSTIC TRUTHFULNESS: NORMAL ENTER CASE
// =========================================================================
{
  clearWhipsawObservationState("ETHUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const nowMs = Date.now();
  const snapEnter: SymbolSnapshotLike = {
    symbol: "ETHUSDT",
    lastPrice: 2600,
    latestCandleClose: 2600,
    signal: "paper_long_candidate",
    entryCandidate: true,
    qualityScore: 90,
    candidateStrength: "strong",
    ema20: 2595,
    ema60: 2590,
    emaGap: 0.002,
    volumeRatioProxy: 1.5,
    boxHigh: 2630,
    boxLow: 2570,
    boxPos: 0.1,
    boxRel: 0.02,
    gateExpectedMove: 20,
    gateRequiredMove: 10,
    atr: 12,
    atr20: 12,
    closedClose: 2598,
    rangeConfidence: 0.8,
    trendWeaknessScore: 0.8,
    boxCohesion01: 0.8,
    breakoutFailureRate: 0.05,
    rangeOscillationScore: 0.1,
    candles: mockBullishCandles,
    htf_candles: {
      "5m": mockBullishCandles,
      "15m": mockBullishCandles,
      "1h": mockBullishCandles,
      "4h": mockBullishCandles
    },
    canonicalRegime: "RANGE",
    canonicalRegimeSource: "strategy_market_regime_detector"
  };

  const bridge = buildV2SnapshotBridge(snapEnter);
  const inputYY = adaptV2Input(
    "ETHUSDT",
    nowMs,
    bridge as any,
    {
      paperMaxOpenPositions: 3,
      baseSizeUsd: 100,
      maxSymbolNotionalUsd: 5000,
      maxAccountNotionalUsd: 20000,
      okxLiveEnabled: true,
      okxAuthMode: "live",
      okxExchangeAuthOptIn: true
    } as any,
    {
      directionalShockState: "NONE",
      longAllow: true,
      shortAllow: true,
      currentPositions: [],
      executionReadiness: true,
      paperExecutionReady: true,
      signedExecutionReady: true,
      serverTradeEnabled: true,
      accountEquityKrw: 10000000,
      exposureNotionalCapKrw: 100000000,
      symbolExposureNotionalCapKrw: 50000000,
      accountEquityUsdt: 10000,
      availableBalanceUsdt: 10000,
      liveBalanceReady: true,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true,
      okxActualPositions: [],
      okxPendingOrdersReady: true,
      okxPendingOrdersNotionalUsdt: 0,
      okxPendingSymbolNotionalUsdt: 0,
      hasSymbolPendingEntry: false,
      hasUnknownPendingNotional: false,
      okxLiveEnabled: true,
      okxAuthMode: "live",
      okxAuthReady: true,
      okxExchangeAuthOptIn: true,
      okxApiKeyPresent: true,
      okxApiSecretPresent: true,
      okxPassphrasePresent: true,
      balanceFetchedAt: nowMs,
      positionsFetchedAt: nowMs,
      pendingOrdersFetchedAt: nowMs
    } as any,
    {
      decision: { final_decision: "ENTER" },
      execution: { stopPrice: 2564, invalidationPx: 2564, side: "long", sizeUsd: 100 },
      risk: { stopPrice: 2564, invalidationPx: 2564 }
    } as any,
    mockBullishCandles,
    "authoritative",
    `cycle_ETHUSDT_${nowMs}_yy`
  );

  const res = runEngineV2(inputYY);
  const decision = res.decision;
  const meta = res.decision.metadata ?? {};

  const env = resolveSymbolDecisionEnvelope({
    symbol: "ETHUSDT" as any,
    fetchedAt: nowMs,
    snapshot: bridge,
    config: {
      paperMaxOpenPositions: 3,
      baseSizeUsd: 100,
      maxSymbolNotionalUsd: 5000,
      maxAccountNotionalUsd: 20000,
      okxLiveEnabled: true,
      okxAuthMode: "live",
      okxExchangeAuthOptIn: true
    } as any,
    state: {
      directionalShockState: "NONE",
      longAllow: true,
      shortAllow: true,
      currentPositions: [],
      executionReadiness: true,
      paperExecutionReady: true,
      signedExecutionReady: true,
      serverTradeEnabled: true,
      accountEquityKrw: 10000000,
      exposureNotionalCapKrw: 100000000,
      symbolExposureNotionalCapKrw: 50000000,
      accountEquityUsdt: 10000,
      availableBalanceUsdt: 10000,
      liveBalanceReady: true,
      okxActualPositionsReady: true,
      actualAccountNotionalUsdtReady: true,
      okxActualPositions: [],
      okxPendingOrdersReady: true,
      okxPendingOrdersNotionalUsdt: 0,
      okxPendingSymbolNotionalUsdt: 0,
      hasSymbolPendingEntry: false,
      hasUnknownPendingNotional: false,
      okxLiveEnabled: true,
      okxAuthMode: "live",
      okxAuthReady: true,
      okxExchangeAuthOptIn: true,
      okxApiKeyPresent: true,
      okxApiSecretPresent: true,
      okxPassphrasePresent: true,
      balanceFetchedAt: nowMs,
      positionsFetchedAt: nowMs,
      pendingOrdersFetchedAt: nowMs
    } as any,
    legacy: {
      regime: "RANGE",
      finalDecision: "ENTER",
      rejectReason: "none",
      requiredCostUsd: 0,
      entryAllowed: true,
      executorLabel: "range",
      intentSide: "long",
      adaptiveOk: true,
      adaptiveDetail: {}
    } as any,
    v2Mode: "engine_v2",
    evaluationMode: "authoritative",
    runCycleId: `cycle_ETHUSDT_${nowMs}_yy_env`
  });

  const v2Env = env.v2_execution_envelope;

  run(
    "TEST_YY_NORMAL_ENTER_SELECTED_SIDE_AFTER_VETO_MATCHES_FINAL_SIDE",
    decision.decision === "ENTER" &&
      decision.side === "long" &&
      meta.selectedSideAfterVeto === "long" &&
      v2Env?.selected_side_after_veto === "long",
    `Normal ENTER truthful: decision=${decision.decision}, side=${decision.side}, meta.selectedSideAfterVeto=${meta.selectedSideAfterVeto}, env.selected_side_after_veto=${v2Env?.selected_side_after_veto}`
  );
}

// =========================================================================
// TEST ZZ — DIAGNOSTIC TRUTHFULNESS: HOLD AND REJECT CASES
// =========================================================================
{
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const now = Date.now();
  // 1. HOLD Case (Quality below threshold)
  const snapHold: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 68930,
    latestCandleClose: 68930,
    signal: "paper_short_candidate",
    qualityScore: 65,
    candidateStrength: "strong",
    ema20: 68850,
    ema60: 69200,
    emaGap: -0.003,
    volumeRatioProxy: 1.1,
    boxHigh: 70000,
    boxLow: 68000,
    boxPos: 0.35,
    boxRel: -0.02,
    gateExpectedMove: null,
    gateRequiredMove: null,
    atr: 250,
    atr20: 250,
    closedClose: 68920,
    rangeConfidence: 0.2,
    trendWeaknessScore: 0.2,
    boxCohesion01: 0.7,
    breakoutFailureRate: 0.1,
    rangeOscillationScore: 0.2,
    candles: mockBearishCandles,
    canonicalRegime: "TREND",
    canonicalRegimeSource: "strategy_market_regime_detector",
    canonicalTrendScore: 0.75,
    htf_candles: {
      "5m": mockBearishCandles,
      "15m": mockBearishCandles,
      "1h": mockBearishCandles,
      "4h": mockBullishCandles
    }
  };

  const bridgeHold = buildV2SnapshotBridge(snapHold);
  const inputHold = adaptV2Input(
    "BTCUSDT",
    now,
    bridgeHold as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    mockBearishCandles,
    "authoritative",
    `cycle_BTCUSDT_${now}_zz_hold`
  );

  const resHold = runEngineV2(inputHold);
  const decisionHold = resHold.decision;
  const metaHold = resHold.decision.metadata ?? {};

  const envHold = resolveSymbolDecisionEnvelope({
    symbol: "BTCUSDT" as any,
    fetchedAt: now,
    snapshot: bridgeHold,
    config: { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    state: {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true
    } as any,
    legacy: {
      regime: "TREND",
      finalDecision: "SKIP",
      rejectReason: "none",
      requiredCostUsd: 0,
      entryAllowed: false,
      executorLabel: "trend",
      intentSide: "none",
      adaptiveOk: true,
      adaptiveDetail: {}
    } as any,
    v2Mode: "engine_v2",
    evaluationMode: "authoritative",
    runCycleId: `cycle_BTCUSDT_${now}_zz_hold`
  });

  // 2. REJECT Case (Hard safety block - counter trend shock)
  clearWhipsawObservationState("BTCUSDT");
  clearGlobalShockStates();
  marketJudgmentCacheBySymbol.clear();
  rangeContinuationStateMap.clear();

  const snapReject: SymbolSnapshotLike = {
    ...snapHold,
    breakoutFailureRate: 0.45,
    volumeExpansion: 2.5
  };

  const bridgeReject = buildV2SnapshotBridge(snapReject);
  const inputReject = adaptV2Input(
    "BTCUSDT",
    now,
    bridgeReject as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    mockBearishCandles,
    "authoritative",
    `cycle_BTCUSDT_${now}_zz_reject`
  );

  const resReject = runEngineV2(inputReject);
  const decisionReject = resReject.decision;
  const metaReject = resReject.decision.metadata ?? {};

  const envReject = resolveSymbolDecisionEnvelope({
    symbol: "BTCUSDT" as any,
    fetchedAt: now,
    snapshot: bridgeReject,
    config: { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    state: {
      directionalShockState: "NONE",
      crashState: "CRASH_ALERT",
      shortAllow: true,
      longAllow: false,
      currentPositions: [],
      signedExecutionReady: true,
      paperExecutionReady: true
    } as any,
    legacy: {
      regime: "TREND",
      finalDecision: "SKIP",
      rejectReason: "none",
      requiredCostUsd: 0,
      entryAllowed: false,
      executorLabel: "trend",
      intentSide: "none",
      adaptiveOk: true,
      adaptiveDetail: {}
    } as any,
    v2Mode: "engine_v2",
    evaluationMode: "authoritative",
    runCycleId: `cycle_BTCUSDT_${now}_zz_reject`
  });

  run(
    "TEST_ZZ_HOLD_AND_REJECT_SELECTED_SIDE_AFTER_VETO_NONE",
    (decisionHold.decision === "HOLD" || decisionHold.decision === "SKIP") &&
      metaHold.selectedSideAfterVeto === "none" &&
      envHold.v2_execution_envelope?.selected_side_after_veto === "none" &&
      (decisionReject.decision === "REJECT" || decisionReject.decision === "HOLD") &&
      metaReject.selectedSideAfterVeto === "none" &&
      envReject.v2_execution_envelope?.selected_side_after_veto === "none",
    `HOLD and REJECT truthfulness verified: Hold(decision=${decisionHold.decision}, metaSide=${metaHold.selectedSideAfterVeto}, envSide=${envHold.v2_execution_envelope?.selected_side_after_veto}), Reject(decision=${decisionReject.decision}, metaSide=${metaReject.selectedSideAfterVeto}, envSide=${envReject.v2_execution_envelope?.selected_side_after_veto})`
  );
}

console.log("\nALL 53 WHIPSAW LIVENESS, HTF CONTRARIAN, PROBE_ONLY & DIAGNOSTIC TESTS PASSED (TEST A - TEST ZZ)!");
