/**
 * WHIPSAW high-quality liveness release — aged aligned soft downgrade regression suite.
 */

import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import { WHIPSAW_AGED_SOFT_DOWNGRADE_REASON, WHIPSAW_AGED_SOFT_DOWNGRADE_MIN_QUALITY, evaluateWhipsawAgedSoftDowngradeEligible, isHtfPolicyCompatibleWithCandidateSide } from "../engine-v2/market-judgment/whipsaw-aged-soft-downgrade";
import { clearWhipsawObservationState, updateWhipsawObservation, whipsawObservationAuthority } from "../engine-v2/market-judgment/whipsaw-observer";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { buildV2SnapshotBridge } from "./paper-engine";
import { deriveTrendSideCandidate } from "../engine-v2/trend-side-candidate";
import type { Candle } from "../models/types";
import type { EngineV2Input } from "../engine-v2/types";
import type { SymbolSnapshotLike } from "./paper-symbol-decision";

function run(label: string, passed: boolean, detail: string): boolean {
  console.log(`[WHIPSAW-HQ-RELEASE][${label}] ${passed ? "PASS" : "FAIL"} — ${detail}`);
  if (!passed) throw new Error(`[WHIPSAW-HQ-RELEASE][${label}] FAILED: ${detail}`);
  return passed;
}

/** Legacy inline index.ts formula — regression anchor for shared helper parity. */
function indexInlineTrendSideCandidate(
  shock: string | null | undefined,
  emaGap: number
): "long" | "short" | "none" {
  const s = shock ?? "NONE";
  return s === "DOWN" ? "short" : s === "UP" ? "long" : emaGap < 0 ? "short" : emaGap > 0 ? "long" : "none";
}

const mockBullishCandles: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  ts: Date.now() - (120 - i) * 60000,
  open: 69000 + i * 5,
  high: 69050 + i * 5,
  low: 68950 + i * 5,
  close: 69020 + i * 5,
  volume: 100
}));

function makeMicroUpThenDropCandles(basePrice = 69000): Candle[] {
  const flat: Candle[] = Array.from({ length: 112 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: basePrice,
    high: basePrice + 50,
    low: basePrice - 50,
    close: basePrice,
    volume: 100
  }));
  const tail = [
    { o: basePrice, h: basePrice + 100, l: basePrice - 100, c: basePrice + 50 },
    { o: basePrice + 50, h: basePrice + 800, l: basePrice, c: basePrice + 750 },
    { o: basePrice + 750, h: basePrice + 760, l: basePrice + 600, c: basePrice + 650 },
    { o: basePrice + 650, h: basePrice + 660, l: basePrice + 500, c: basePrice + 550 },
    { o: basePrice + 550, h: basePrice + 560, l: basePrice + 400, c: basePrice + 450 },
    { o: basePrice + 450, h: basePrice + 460, l: basePrice + 300, c: basePrice + 350 },
    { o: basePrice + 350, h: basePrice + 360, l: basePrice + 200, c: basePrice + 250 },
    { o: basePrice + 250, h: basePrice + 260, l: basePrice - 100, c: basePrice + 80 }
  ];
  return [
    ...flat,
    ...tail.map((b, i) => ({
      ts: Date.now() - (8 - i) * 60000,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: 120
    }))
  ];
}

function makeMicroDownReboundCandles(basePrice = 2600): Candle[] {
  const flat: Candle[] = Array.from({ length: 112 }, (_, i) => ({
    ts: Date.now() - (120 - i) * 60000,
    open: basePrice,
    high: basePrice + 5,
    low: basePrice - 5,
    close: basePrice,
    volume: 100
  }));
  const tail = [
    { o: basePrice, h: basePrice + 10, l: basePrice - 10, c: basePrice - 5 },
    { o: basePrice - 5, h: basePrice, l: basePrice - 80, c: basePrice - 75 },
    { o: basePrice - 75, h: basePrice - 60, l: basePrice - 76, c: basePrice - 65 },
    { o: basePrice - 65, h: basePrice - 50, l: basePrice - 66, c: basePrice - 55 },
    { o: basePrice - 55, h: basePrice - 40, l: basePrice - 56, c: basePrice - 45 },
    { o: basePrice - 45, h: basePrice - 30, l: basePrice - 46, c: basePrice - 35 },
    { o: basePrice - 35, h: basePrice - 20, l: basePrice - 36, c: basePrice - 25 },
    { o: basePrice - 25, h: basePrice + 10, l: basePrice - 26, c: basePrice - 8 }
  ];
  return [
    ...flat,
    ...tail.map((b, i) => ({
      ts: Date.now() - (8 - i) * 60000,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: 120
    }))
  ];
}

function makeTrendCandles(base: number, dir: "up" | "down", n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: Date.now() - (n - i) * 60000,
    open: base + (dir === "up" ? i * 5 : -i * 5),
    high: base + (dir === "up" ? i * 5 + 10 : -i * 5 + 10),
    low: base + (dir === "up" ? i * 5 - 10 : -i * 5 - 10),
    close: base + (dir === "up" ? i * 5 + 5 : -i * 5 - 5),
    volume: 100
  }));
}

function makeBaseInput(
  symbol: "BTCUSDT" | "ETHUSDT",
  overrides: Partial<SymbolSnapshotLike> = {},
  stateOverrides: Record<string, unknown> = {}
): EngineV2Input {
  const candles = (overrides.candles as Candle[] | undefined) ?? mockBullishCandles;
  const snap: SymbolSnapshotLike = {
    symbol,
    lastPrice: symbol === "BTCUSDT" ? 69000 : 2600,
    latestCandleClose: symbol === "BTCUSDT" ? 69000 : 2600,
    signal: "paper_long_candidate",
    qualityScore: 80,
    candidateStrength: "strong",
    ema20: symbol === "BTCUSDT" ? 68900 : 2595,
    ema60: symbol === "BTCUSDT" ? 68800 : 2590,
    emaGap: 0.0042,
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
    boxBreakSide: "none",
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
    {
      directionalShockState: "NONE",
      longAllow: true,
      shortAllow: true,
      currentPositions: [],
      paperExecutionReady: true,
      signedExecutionReady: true,
      serverTradeEnabled: true,
      closeOnlyMode: false,
      killSwitch: false,
      executionReadiness: true,
      ...stateOverrides
    } as any,
    { decision: { final_decision: "ENTER" } } as any,
    candles,
    "authoritative",
    `cycle_${symbol}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  );
}

function seedHardEpisode(symbol: "BTCUSDT" | "ETHUSDT", ticks: number, directional: "UP" | "DOWN") {
  clearWhipsawObservationState(symbol);
  for (let i = 0; i < ticks; i++) {
    updateWhipsawObservation({
      symbol,
      rawActive: true,
      candidateRiskActive: true,
      allowNewHardBlockEpisode: true,
      directionalShockState: directional,
      structuralHits: ["micro_up_then_drop", "volume_expansion_ge_2"]
    });
  }
}

function alignedLongAgedInput(symbol: "BTCUSDT" | "ETHUSDT", qualityScore: number, emaGap: number) {
  const microCandles = symbol === "BTCUSDT" ? makeMicroUpThenDropCandles(69000) : makeMicroUpThenDropCandles(2600);
  return makeBaseInput(
    symbol,
    {
      qualityScore,
      emaGap,
      trendWeaknessScore: 0.1,
      boxBreakSide: "none",
      breakoutFailureRate: 0.1,
      volumeExpansion: 1.1,
      atrExpansion: 1.0,
      candles: microCandles
    },
    {
      directionalShockState: "UP",
      longAllow: true,
      shortAllow: false
    }
  );
}

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail: string) {
  try {
    run(label, ok, detail);
    passed++;
  } catch {
    failed++;
  }
}

// --- Single-source trendSideCandidate equivalence (shared helper vs index inline) ---
{
  const fixtures: Array<{ shock: string | null | undefined; emaGap: number; label: string }> = [
    { shock: "UP", emaGap: 0.0042, label: "UP" },
    { shock: "DOWN", emaGap: -0.0042, label: "DOWN" },
    { shock: "NONE", emaGap: 0.0042, label: "NONE_POS" },
    { shock: "NONE", emaGap: -0.0042, label: "NONE_NEG" },
    { shock: "NONE", emaGap: 0, label: "NONE_ZERO" },
    { shock: "UNKNOWN", emaGap: 0.0042, label: "UNKNOWN_POS" },
    { shock: null, emaGap: -0.003, label: "NULL_NEG" },
    { shock: undefined, emaGap: 0.002, label: "UNDEF_POS" }
  ];
  for (const f of fixtures) {
    const shared = deriveTrendSideCandidate(f.shock, f.emaGap);
    const inline = indexInlineTrendSideCandidate(f.shock, f.emaGap);
    check(
      `EQUIV_TREND_SIDE_${f.label}`,
      shared === inline,
      `shock=${String(f.shock)} emaGap=${f.emaGap} shared=${shared} inline=${inline}`
    );
  }
}

// Integration: detector WHIPSAW proof candidate_side matches shared helper
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  const j = detectMarketRegime(input);
  const expected = deriveTrendSideCandidate(input.state.directionalShockState, Number(input.snapshot.emaGap ?? 0));
  check(
    "EQUIV_DETECTOR_CANDIDATE_SIDE",
    j.diagnostics?.whipsaw?.candidateSide === expected,
    `detector=${j.diagnostics?.whipsaw?.candidateSide} shared=${expected}`
  );
}

// A — tick 1-5: hard REJECT maintained
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 3, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  const j = detectMarketRegime(input);
  const { decision } = runEngineV2(input);
  check(
    "A_TICK3_HARD_MAINTAINED",
    j.subtype === "WHIPSAW_SHOCK_RECHECK" && (j.diagnostics?.whipsaw?.recheckTicks ?? 0) <= 5 && decision.decision !== "ENTER",
    `subtype=${j.subtype} ticks=${j.diagnostics?.whipsaw?.recheckTicks} decision=${decision.decision}`
  );
}

// B — tick>=6 + fresh structural > 0 => REJECT
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = makeBaseInput(
    "BTCUSDT",
    {
      qualityScore: 100,
      emaGap: 0.0042,
      trendWeaknessScore: 0.1,
      boxBreakSide: "upper",
      volumeExpansion: 2.5,
      breakoutFailureRate: 0.1,
      candles: makeMicroUpThenDropCandles(69000)
    },
    { directionalShockState: "UP", longAllow: true, shortAllow: false }
  );
  const j = detectMarketRegime(input);
  check(
    "B_TICK6_FRESH_STRUCTURAL_REJECT",
    j.subtype === "WHIPSAW_SHOCK_RECHECK" && (j.diagnostics?.fresh_structural_hits?.length ?? 0) > 0,
    `subtype=${j.subtype} fresh=${JSON.stringify(j.diagnostics?.fresh_structural_hits)}`
  );
}

// C/J — production-shaped BTC Q100 aged soft downgrade
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.004244865855578648);
  const j = detectMarketRegime(input);
  const { decision } = runEngineV2(input);
  check(
    "C_BTC_Q100_SOFT_DOWNGRADE",
    j.subtype === "WHIPSAW_SOFT_WATCH" &&
      j.diagnostics?.whipsaw?.hardToSoftDowngrade === true &&
      j.diagnostics?.whipsaw?.downgradeReason === WHIPSAW_AGED_SOFT_DOWNGRADE_REASON &&
      decision.explanation.reason !== "WHIPSAW_SHOCK_RECHECK",
    `subtype=${j.subtype} downgrade=${j.diagnostics?.whipsaw?.hardToSoftDowngrade} reason=${j.diagnostics?.whipsaw?.downgradeReason} decision=${decision.decision} block=${decision.risk?.blockReason ?? "none"}`
  );
}

// D/K — ETH Q99 symmetric
{
  clearWhipsawObservationState("ETHUSDT");
  seedHardEpisode("ETHUSDT", 6, "UP");
  const input = alignedLongAgedInput("ETHUSDT", 99, 0.004221103934399031);
  const j = detectMarketRegime(input);
  check(
    "D_ETH_Q99_SOFT_DOWNGRADE",
    j.subtype === "WHIPSAW_SOFT_WATCH" && j.diagnostics?.whipsaw?.hardToSoftDowngrade === true,
    `subtype=${j.subtype} downgrade=${j.diagnostics?.whipsaw?.downgradeReason}`
  );
}

// E — long + shock DOWN opposing => hard maintained
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "DOWN");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  const j = detectMarketRegime({ ...input, state: { ...input.state, directionalShockState: "DOWN" } });
  check(
    "E_LONG_OPPOSED_SHOCK_DOWN",
    j.subtype === "WHIPSAW_SHOCK_RECHECK" && j.diagnostics?.whipsaw?.hardToSoftDowngrade !== true,
    `subtype=${j.subtype} downgrade=${j.diagnostics?.whipsaw?.hardToSoftDowngrade}`
  );
}

// F — short symmetric opposing shock UP
{
  clearWhipsawObservationState("ETHUSDT");
  seedHardEpisode("ETHUSDT", 6, "DOWN");
  const input = makeBaseInput(
    "ETHUSDT",
    {
      qualityScore: 95,
      emaGap: -0.0042,
      trendWeaknessScore: 0.1,
      boxBreakSide: "none",
      volumeExpansion: 1.1,
      signal: "paper_short_candidate",
      candles: makeMicroDownReboundCandles(2600)
    },
    { directionalShockState: "DOWN", longAllow: false, shortAllow: true }
  );
  const j = detectMarketRegime({ ...input, state: { ...input.state, directionalShockState: "UP" } });
  check(
    "F_SHORT_OPPOSED_SHOCK_UP",
    j.subtype === "WHIPSAW_SHOCK_RECHECK" && j.diagnostics?.whipsaw?.hardToSoftDowngrade !== true,
    `subtype=${j.subtype}`
  );
}

// G — polarity mismatch => no soft downgrade
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const candlesUp = makeTrendCandles(69000, "up", 120);
  const candlesDown = makeTrendCandles(69000, "down", 120);
  const input = makeBaseInput(
    "BTCUSDT",
    {
      qualityScore: 100,
      emaGap: 0.0042,
      trendWeaknessScore: 0.1,
      boxBreakSide: "none",
      volumeExpansion: 1.1,
      candles: makeMicroUpThenDropCandles(69000),
      htf_candles: {
        "5m": candlesUp,
        "15m": candlesUp,
        "1h": candlesDown,
        "4h": candlesDown,
        "1d": candlesDown
      }
    },
    { directionalShockState: "UP", longAllow: true, shortAllow: false }
  );
  const j = detectMarketRegime(input);
  check(
    "G_POLARITY_OR_HTF_BLOCK",
    j.polarityMismatch === true &&
      j.diagnostics?.whipsaw?.hardToSoftDowngrade !== true &&
      j.htf_entry_policy === "HOLD",
    `downgrade=${j.diagnostics?.whipsaw?.hardToSoftDowngrade} htf=${j.htf_entry_policy} polarity=${j.polarityMismatch}`
  );
}

// H — trendOk false
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0001);
  const j = detectMarketRegime(input);
  check(
    "H_TREND_NOT_OK",
    j.subtype === "WHIPSAW_SHOCK_RECHECK" || j.diagnostics?.whipsaw?.hardToSoftDowngrade !== true,
    `subtype=${j.subtype} trendWeak=${input.snapshot.trendWeaknessScore} emaGap=${input.snapshot.emaGap}`
  );
}

// I — observationAgePassed false
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 2, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  const j = detectMarketRegime(input);
  check(
    "I_OBS_AGE_NOT_PASSED",
    j.subtype === "WHIPSAW_SHOCK_RECHECK" && j.diagnostics?.whipsaw?.observationAgePassed === false,
    `subtype=${j.subtype} agePassed=${j.diagnostics?.whipsaw?.observationAgePassed}`
  );
}

// L — killSwitch resurrection forbidden
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  input.state.killSwitch = true;
  const j = detectMarketRegime(input);
  check(
    "L_KILL_SWITCH",
    j.diagnostics?.whipsaw?.hardToSoftDowngrade !== true,
    `downgrade=${j.diagnostics?.whipsaw?.hardToSoftDowngrade}`
  );
}

// M — closeOnlyMode
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  input.state.closeOnlyMode = true;
  const j = detectMarketRegime(input);
  check(
    "M_CLOSE_ONLY",
    j.diagnostics?.whipsaw?.hardToSoftDowngrade !== true,
    `downgrade=${j.diagnostics?.whipsaw?.hardToSoftDowngrade}`
  );
}

// O — readiness false
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  input.state.paperExecutionReady = false;
  const j = detectMarketRegime(input);
  check(
    "O_READINESS_FALSE",
    j.diagnostics?.whipsaw?.hardToSoftDowngrade !== true,
    `downgrade=${j.diagnostics?.whipsaw?.hardToSoftDowngrade}`
  );
}

// R — quality 100 but fresh structural => REJECT
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = makeBaseInput(
    "BTCUSDT",
    {
      qualityScore: 100,
      emaGap: 0.0042,
      boxBreakSide: "upper",
      volumeExpansion: 2.2,
      breakoutFailureRate: 0.5,
      candles: makeMicroUpThenDropCandles(69000)
    },
    { directionalShockState: "UP", longAllow: true, shortAllow: false }
  );
  const j = detectMarketRegime(input);
  check(
    "R_FRESH_STRUCTURAL_Q100_REJECT",
    j.subtype === "WHIPSAW_SHOCK_RECHECK",
    `subtype=${j.subtype} fresh=${JSON.stringify(j.diagnostics?.fresh_structural_hits)}`
  );
}

// S — quality 80 boundary
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 80, 0.0042);
  const j = detectMarketRegime(input);
  check(
    "S_Q80_BOUNDARY_SOFT",
    j.subtype === "WHIPSAW_SOFT_WATCH" && j.diagnostics?.whipsaw?.hardToSoftDowngrade === true,
    `subtype=${j.subtype}`
  );
}

// J — stale micro_up_then_drop alone cannot sustain hard REJECT after age
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 7, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  const j = detectMarketRegime(input);
  check(
    "J_STALE_MICRO_UP_THEN_DROP_NO_HARD",
    j.subtype === "WHIPSAW_SOFT_WATCH" &&
      j.diagnostics?.whipsaw?.hardToSoftDowngrade === true &&
      (j.diagnostics?.fresh_structural_hits?.length ?? 0) === 0,
    `subtype=${j.subtype} fresh=${JSON.stringify(j.diagnostics?.fresh_structural_hits)}`
  );
}

// K — stale micro_down_then_rebound SHORT symmetric
{
  clearWhipsawObservationState("ETHUSDT");
  seedHardEpisode("ETHUSDT", 7, "DOWN");
  const input = makeBaseInput(
    "ETHUSDT",
    {
      qualityScore: 95,
      emaGap: -0.0042,
      trendWeaknessScore: 0.1,
      boxBreakSide: "none",
      volumeExpansion: 1.1,
      signal: "paper_short_candidate",
      candles: makeMicroDownReboundCandles(2600)
    },
    { directionalShockState: "DOWN", longAllow: false, shortAllow: true }
  );
  const j = detectMarketRegime(input);
  check(
    "K_STALE_MICRO_DOWN_REBOUND_SHORT",
    j.subtype === "WHIPSAW_SOFT_WATCH" && j.diagnostics?.whipsaw?.hardToSoftDowngrade === true,
    `subtype=${j.subtype}`
  );
}

// N — pending order blocker => no resurrection
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  input.state.hasSymbolPendingEntry = true;
  const j = detectMarketRegime(input);
  check(
    "N_PENDING_ORDER",
    j.diagnostics?.whipsaw?.hardToSoftDowngrade !== true,
    `downgrade=${j.diagnostics?.whipsaw?.hardToSoftDowngrade}`
  );
}

// P — SOFT downgrade: downstream native authority stays non-ENTER (no WHIPSAW promotion)
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  const j = detectMarketRegime(input);
  const { decision } = runEngineV2(input);
  check(
    "P_DOWNSTREAM_HOLD_NO_ENTER",
    j.subtype === "WHIPSAW_SOFT_WATCH" &&
      j.diagnostics?.whipsaw?.hardToSoftDowngrade === true &&
      decision.decision !== "ENTER" &&
      !decision.metadata?.promotion_reason,
    `subtype=${j.subtype} decision=${decision.decision} promo=${decision.metadata?.promotion_reason ?? "none"}`
  );
}

// Q — SOFT downgrade + native ENTER: no WHIPSAW release promotionReason
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  const j = detectMarketRegime(input);
  const { decision } = runEngineV2(input);
  const promo = String(decision.metadata?.promotion_reason ?? "");
  check(
    "Q_NO_WHIPSAW_RELEASE_PROMOTION",
    j.subtype === "WHIPSAW_SOFT_WATCH" &&
      !promo.includes("WHIPSAW") &&
      !promo.includes("AGED") &&
      !promo.includes("SOFT_DOWNGRADE"),
    `decision=${decision.decision} promo=${promo || "none"}`
  );
}

// --- Authority correction tests (quality / candidate / shock / HTF / lifecycle) ---

// Q79 → hard maintained despite otherwise eligible conditions
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 79, 0.0042);
  const j = detectMarketRegime(input);
  check(
    "AUTH_Q79_HARD_MAINTAINED",
    j.subtype === "WHIPSAW_SHOCK_RECHECK" && j.diagnostics?.whipsaw?.hardToSoftDowngrade !== true,
    `subtype=${j.subtype} q=${input.snapshot.qualityScore} min=${WHIPSAW_AGED_SOFT_DOWNGRADE_MIN_QUALITY}`
  );
}

// UNKNOWN shock + positive emaGap → candidate none path blocks release
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  const j = detectMarketRegime({
    ...input,
    state: { ...input.state, directionalShockState: "UNKNOWN" as any }
  });
  check(
    "AUTH_SHOCK_UNKNOWN_BLOCKS",
    j.diagnostics?.whipsaw?.hardToSoftDowngrade !== true,
    `subtype=${j.subtype} shock=UNKNOWN downgrade=${j.diagnostics?.whipsaw?.hardToSoftDowngrade}`
  );
}

// null shock blocks
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  const pred = evaluateWhipsawAgedSoftDowngradeEligible({
    input: { ...input, state: { ...input.state, directionalShockState: null as any } },
    observationAgePassed: true,
    hasWhipsawEpisode: true,
    freshStructuralHitCount: 0,
    htfEntryPolicy: "LONG_ONLY_OR_NONE",
    polarityMismatch: false,
    directionalShockState: null
  });
  check(
    "AUTH_SHOCK_NULL_BLOCKS",
    pred.eligible === false,
    `eligible=${pred.eligible} candidate=${pred.candidateSide}`
  );
}

// DOWN shock + positive emaGap → authoritative short vs ema long contradiction
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "DOWN");
  const input = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  const j = detectMarketRegime({ ...input, state: { ...input.state, directionalShockState: "DOWN" } });
  check(
    "AUTH_CANDIDATE_EMA_CONTRADICTION",
    j.diagnostics?.whipsaw?.hardToSoftDowngrade !== true,
    `subtype=${j.subtype} candidate=${j.diagnostics?.whipsaw?.candidateSide}`
  );
}

// PROBE_ONLY is micro-probe lane — not normal directional permission for aged release
{
  check(
    "AUTH_PROBE_ONLY_NOT_COMPATIBLE",
    isHtfPolicyCompatibleWithCandidateSide("PROBE_ONLY", "long") === false &&
      isHtfPolicyCompatibleWithCandidateSide("PROBE_ONLY", "short") === false,
    `PROBE_ONLY must not authorize aged hard→soft release`
  );
}

// HTF null/UNKNOWN blocks
{
  check(
    "AUTH_HTF_NULL_UNKNOWN_BLOCKS",
    isHtfPolicyCompatibleWithCandidateSide(null, "long") === false &&
      isHtfPolicyCompatibleWithCandidateSide("UNKNOWN", "long") === false,
    `null/UNKNOWN HTF blocked`
  );
}

// Lifecycle: stale micro after soft downgrade → no hard re-arm
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  const softInput = alignedLongAgedInput("BTCUSDT", 100, 0.0042);
  detectMarketRegime(softInput);
  const staleInput = makeBaseInput(
    "BTCUSDT",
    {
      qualityScore: 100,
      emaGap: 0.0042,
      trendWeaknessScore: 0.1,
      boxBreakSide: "none",
      volumeExpansion: 1.0,
      breakoutFailureRate: 0.45,
      candles: makeMicroUpThenDropCandles(69000)
    },
    { directionalShockState: "NONE", longAllow: true, shortAllow: false }
  );
  const j = detectMarketRegime(staleInput);
  check(
    "LIFE_STALE_MICRO_NO_HARD_REARM",
    j.subtype !== "WHIPSAW_SHOCK_RECHECK",
    `subtype=${j.subtype}`
  );
}

// Lifecycle: fresh structural after soft downgrade → hard re-arm allowed
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  detectMarketRegime(alignedLongAgedInput("BTCUSDT", 100, 0.0042));
  const freshInput = makeBaseInput(
    "BTCUSDT",
    {
      qualityScore: 100,
      emaGap: 0.0042,
      trendWeaknessScore: 0.1,
      boxBreakSide: "upper",
      volumeExpansion: 2.5,
      breakoutFailureRate: 0.1,
      candles: makeMicroUpThenDropCandles(69000)
    },
    { directionalShockState: "UP", longAllow: true, shortAllow: false }
  );
  const j = detectMarketRegime(freshInput);
  check(
    "LIFE_FRESH_STRUCTURAL_HARD_REARM",
    j.subtype === "WHIPSAW_SHOCK_RECHECK" && (j.diagnostics?.fresh_structural_hits?.length ?? 0) > 0,
    `subtype=${j.subtype} fresh=${JSON.stringify(j.diagnostics?.fresh_structural_hits)}`
  );
}

// Lifecycle: stabilization cleans episode
{
  clearWhipsawObservationState("BTCUSDT");
  seedHardEpisode("BTCUSDT", 6, "UP");
  detectMarketRegime(alignedLongAgedInput("BTCUSDT", 100, 0.0042));
  const stableInput = makeBaseInput(
    "BTCUSDT",
    {
      qualityScore: 100,
      emaGap: 0.0042,
      trendWeaknessScore: 0.1,
      boxBreakSide: "none",
      volumeExpansion: 1.1,
      candles: mockBullishCandles
    },
    { directionalShockState: "NONE", longAllow: true, shortAllow: false }
  );
  const j = detectMarketRegime(stableInput);
  const ep = whipsawObservationAuthority.getEpisode("BTCUSDT");
  check(
    "LIFE_STABILIZATION_CLEANUP",
    ep == null &&
      j.subtype !== "WHIPSAW_SHOCK_RECHECK" &&
      j.subtype !== "WHIPSAW_SOFT_WATCH",
    `subtype=${j.subtype} ep=${ep?.episodeId ?? "null"}`
  );
}

console.log(`\n[WHIPSAW-HQ-RELEASE] SUMMARY passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
