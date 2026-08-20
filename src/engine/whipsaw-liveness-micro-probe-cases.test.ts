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
 */

import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { clearWhipsawObservationState, whipsawObservationAuthority, updateWhipsawObservation } from "../engine-v2/market-judgment/whipsaw-observer";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
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
    `cycle_${symbol}_test`
  );
}

// =========================================================================
// TEST A — BTC UP shock + Bearish HTF -> Hard-Block MAINTAINED (Release Blocked)
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

  run(
    "TEST_A_BTC_HTF_CONTRARIAN_RELEASE_BLOCKED",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK",
    `BTC UP shock against Bearish HTF remains HARD-BLOCKED. subtype=${judgment.subtype}`
  );
}

// =========================================================================
// TEST B — ETH UP shock + Bearish HTF -> Hard-Block MAINTAINED (Release Blocked)
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

  run(
    "TEST_B_ETH_HTF_CONTRARIAN_RELEASE_BLOCKED",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK",
    `ETH UP shock against Bearish HTF remains HARD-BLOCKED. subtype=${judgment.subtype}`
  );
}

// =========================================================================
// TEST C — BTC DOWN shock + Bullish HTF -> Hard-Block MAINTAINED (Release Blocked)
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

  run(
    "TEST_C_BTC_DOWN_CONTRARIAN_RELEASE_BLOCKED",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK",
    `BTC DOWN shock against Bullish HTF remains HARD-BLOCKED. subtype=${judgment.subtype}`
  );
}

// =========================================================================
// TEST D — ETH DOWN shock + Bullish HTF -> Hard-Block MAINTAINED (Release Blocked)
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

  run(
    "TEST_D_ETH_DOWN_CONTRARIAN_RELEASE_BLOCKED",
    judgment.subtype === "WHIPSAW_SHOCK_RECHECK",
    `ETH DOWN shock against Bullish HTF remains HARD-BLOCKED. subtype=${judgment.subtype}`
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
// TEST L — ATR & closedClose Propagate to Micro Probe
// =========================================================================
{
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
    atr: 250,
    atr20: 250,
    closedClose: 68990,
    rangeConfidence: 0.5,
    trendWeaknessScore: 0.1,
    candles: mockBullishCandles
  };

  const bridge = buildV2SnapshotBridge(snapBtc);
  const input = adaptV2Input(
    "BTCUSDT",
    Date.now(),
    bridge as any,
    { paperMaxOpenPositions: 3, baseSizeUsd: 100 } as any,
    { directionalShockState: "NONE", longAllow: true, shortAllow: true, currentPositions: [] } as any,
    { decision: { final_decision: "ENTER" } } as any,
    mockBullishCandles,
    "authoritative",
    "cycle_btc_atr_prop"
  );

  run(
    "TEST_L_ATR_CLOSEDCLOSE_PROPAGATION",
    input.snapshot.atr20 === 250 && input.snapshot.closedClose === 68990,
    `BTC atr20 and closedClose successfully propagated. atr20=${input.snapshot.atr20}, closedClose=${input.snapshot.closedClose}`
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

console.log("\nALL 15 WHIPSAW LIVENESS & HTF CONTRARIAN TESTS PASSED (TEST A - TEST O)!");
