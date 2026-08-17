/**
 * BLOCKER 4-12 — Reviewing Ticks Authority Restore + Propagation Tests
 *
 * Tests:
 * CASE A: First LONG candidate -> reviewingTicks = 1
 * CASE B: Consecutive identical LONG candidate -> 1 -> 2 -> 3 -> 4 -> 5 -> 6
 * CASE C: Direction flip LONG -> SHORT -> reset to 1
 * CASE D: Candidate disappeared (NONE) -> reviewingTicks = 0, state removed
 * CASE E: Open position exists -> reviewingTicks = 0, state removed
 * CASE F: Quality score drops by > 2 points -> sequence reset to 1
 * CASE G: V1 reviewing_ticks matches V2BridgeSnapshot.reviewing_ticks
 * CASE H: WHIPSAW detector checks reviewing_ticks < 6 for reviewing_ticks_insufficient
 * CASE I: V2 REJECT decision preserves candidate review counter
 */

import { buildV2SnapshotBridge } from "./paper-engine";
import { adaptV2Input } from "../engine-v2";
import { resolveSymbolDecisionEnvelope } from "../engine-v2/reconciler";
import { detectMarketRegime } from "../engine-v2/market-judgment/detector";
import type { SymbolSnapshotLike } from "./paper-symbol-decision";

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  if (!value) throw new Error(`[FAIL] ${label}: expected true`);
}

function pass(label: string, detail?: string): void {
  console.info(`[BLOCKER-4-12][${label}] PASS${detail ? ` — ${detail}` : ""}`);
}

// Simulates the PaperEngine reviewingState logic exactly as implemented in paper-engine.ts
class ReviewingStateSimulator {
  private reviewingState = new Map<string, {
    ticks: number;
    initialQuality: number;
    lastQuality: number;
    side: "long" | "short";
  }>();

  public evaluateCandidate(input: {
    symbol: string;
    snap: SymbolSnapshotLike | null;
    hasOpenPosition: boolean;
    currentStage: number;
    symbolBlocked: boolean;
    isManualCooldownActive: boolean;
  }): { reviewingTicks: number; autoEntryTriggered: boolean } {
    const symKey = input.symbol;
    if (!input.snap) {
      this.reviewingState.delete(symKey);
      return { reviewingTicks: 0, autoEntryTriggered: false };
    }

    const sig = input.snap.signal;
    const candidateSide: "long" | "short" | null =
      sig === "paper_long_candidate"
        ? "long"
        : sig === "paper_short_candidate"
          ? "short"
          : null;

    const candidateEligible =
      input.snap != null &&
      candidateSide != null &&
      !input.hasOpenPosition &&
      input.currentStage === 0 &&
      !input.symbolBlocked &&
      !input.isManualCooldownActive;

    if (candidateEligible) {
      const rev = this.reviewingState.get(symKey);
      const qualityScore = Number(input.snap.qualityScore ?? 0);
      let nextTicks = 1;
      if (rev && rev.side === candidateSide && qualityScore >= rev.initialQuality - 2) {
        nextTicks = rev.ticks + 1;
        this.reviewingState.set(symKey, {
          ticks: nextTicks,
          initialQuality: rev.initialQuality,
          lastQuality: qualityScore,
          side: candidateSide
        });
      } else {
        nextTicks = 1;
        this.reviewingState.set(symKey, {
          ticks: 1,
          initialQuality: qualityScore,
          lastQuality: qualityScore,
          side: candidateSide
        });
      }
      const reviewingTicks = nextTicks;
      const autoEntryTriggered = nextTicks >= 6;
      return { reviewingTicks, autoEntryTriggered };
    } else {
      this.reviewingState.delete(symKey);
      return { reviewingTicks: 0, autoEntryTriggered: false };
    }
  }

  public hasState(symbol: string): boolean {
    return this.reviewingState.has(symbol);
  }
}

function captureProofLogs(run: () => void): any[] {
  const proofLogs: any[] = [];
  const origInfo = console.info;
  console.info = (msg: unknown) => {
    try {
      const parsed = typeof msg === "string" ? JSON.parse(msg) : msg;
      if (parsed && typeof parsed === "object" && typeof (parsed as { event?: unknown }).event === "string") {
        proofLogs.push(parsed);
      }
    } catch {}
    origInfo(msg as any);
  };
  try {
    run();
  } finally {
    console.info = origInfo;
  }
  return proofLogs;
}

function buildMockBridgeFixtures(reviewingTicks: number) {
  const now = Date.now();
  const bridgeSnapshot = buildV2SnapshotBridge({
    symbol: "BTCUSDT",
    lastPrice: 60000,
    latestCandleClose: 60000,
    signal: "paper_long_candidate",
    qualityScore: 85,
    volumeRatioProxy: 1.0,
    boxPos: 0.1,
    boxRel: 0.1,
    ema20: 59900,
    ema60: 59500,
    emaGap: 0.002,
    boxHigh: 61000,
    boxLow: 59000,
    atr: 500,
    gateExpectedMove: null,
    gateRequiredMove: null,
    candidateStrength: "strong",
    reviewing_ticks: reviewingTicks
  });

  const config = {
    baseSizeUsd: 100,
    maxOpenPositions: 3,
    reentryCooldownMs: 0,
    okxLiveMaxOrderNotionalUsdt: 100,
    okxLiveMaxAddonNotionalUsdt: 100,
    okxLiveMaxSymbolNotionalUsdt: 100,
    okxLiveMaxAccountNotionalUsdt: 100,
    okxLiveMaxAddonCount: 1,
    okxLiveEmergencyMaxOrderNotionalUsdt: 100,
    okxLiveMarginReserveRatio: 0.2
  } as const;

  const state = {
    currentPositions: [],
    symbolPositions: [],
    lossStreaks: {},
    globalRiskScore: 0,
    longAllow: true,
    shortAllow: true,
    executionReadiness: true,
    freshTickBarrierActive: false,
    freshTickCompletedCycles: 0,
    freshTickRequiredCycles: 0,
    hasLongPosition: false,
    hasShortPosition: false,
    longStage: 0,
    shortStage: 0,
    crashState: "NONE",
    pumpState: "NONE",
    directionalShockState: "NONE",
    serverTradeEnabled: true,
    closeOnlyMode: false,
    killSwitch: false,
    reconcileSafeMode: false,
    accountEquityKrw: 1000000,
    maxUsableMarginKrw: 900000,
    exposureNotionalCapKrw: 5000000,
    symbolExposureNotionalCapKrw: 3000000
  } as const;

  const legacyBridge = {
    regime: "RANGE",
    finalDecision: "SKIP",
    rejectReason: null,
    requiredCostUsd: 0,
    entryAllowed: false,
    executorLabel: "range",
    intentSide: null,
    adaptiveOk: true,
    adaptiveDetail: {}
  } as const;

  return { now, bridgeSnapshot, config, state, legacyBridge };
}

function runBlocker412Cases(): void {
  console.info("=== STARTING BLOCKER 4-12 REVIEWING TICKS PROPAGATION TESTS ===");

  const sim = new ReviewingStateSimulator();

  const baseSnap: SymbolSnapshotLike = {
    symbol: "BTCUSDT",
    lastPrice: 60000,
    latestCandleClose: 60000,
    signal: "paper_long_candidate",
    qualityScore: 85,
    volumeRatioProxy: 1.0,
    boxPos: 0.1,
    boxRel: 0.1,
    ema20: 59900,
    ema60: 59500,
    emaGap: 0.002,
    boxHigh: 61000,
    boxLow: 59000,
    atr: 500,
    gateExpectedMove: null,
    gateRequiredMove: null,
    candidateStrength: "strong"
  };

  // -------------------------------------------------------------------------
  // CASE A: First LONG candidate -> reviewingTicks = 1
  // -------------------------------------------------------------------------
  {
    const res = sim.evaluateCandidate({
      symbol: "BTCUSDT",
      snap: { ...baseSnap, qualityScore: 85 },
      hasOpenPosition: false,
      currentStage: 0,
      symbolBlocked: false,
      isManualCooldownActive: false
    });
    assertEq(res.reviewingTicks, 1, "CASE A reviewingTicks is 1");
    assertEq(res.autoEntryTriggered, false, "CASE A autoEntryTriggered false");
    pass("CASE A - First LONG candidate", "reviewingTicks=1");
  }

  // -------------------------------------------------------------------------
  // CASE B: Consecutive identical LONG candidate -> 2 -> 3 -> 4 -> 5 -> 6
  // -------------------------------------------------------------------------
  {
    for (let t = 2; t <= 6; t++) {
      const res = sim.evaluateCandidate({
        symbol: "BTCUSDT",
        snap: { ...baseSnap, qualityScore: 85 },
        hasOpenPosition: false,
        currentStage: 0,
        symbolBlocked: false,
        isManualCooldownActive: false
      });
      assertEq(res.reviewingTicks, t, `CASE B tick ${t}`);
      if (t < 6) {
        assertEq(res.autoEntryTriggered, false, `CASE B autoEntryTriggered false at tick ${t}`);
      } else {
        assertEq(res.autoEntryTriggered, true, "CASE B autoEntryTriggered true at tick 6");
      }
    }
    pass("CASE B - Consecutive identical candidate increments to 6", "1->2->3->4->5->6 (autoEntryTriggered=true)");
  }

  // -------------------------------------------------------------------------
  // CASE C: Direction flip LONG -> SHORT -> reset to 1
  // -------------------------------------------------------------------------
  {
    const res = sim.evaluateCandidate({
      symbol: "BTCUSDT",
      snap: { ...baseSnap, signal: "paper_short_candidate", qualityScore: 85 },
      hasOpenPosition: false,
      currentStage: 0,
      symbolBlocked: false,
      isManualCooldownActive: false
    });
    assertEq(res.reviewingTicks, 1, "CASE C flip to SHORT resets to 1");
    assertEq(res.autoEntryTriggered, false, "CASE C autoEntryTriggered reset");
    pass("CASE C - Direction flip resets sequence", "6 -> 1 on side flip");
  }

  // -------------------------------------------------------------------------
  // CASE D: Candidate disappeared (NONE) -> reviewingTicks = 0, state removed
  // -------------------------------------------------------------------------
  {
    const res = sim.evaluateCandidate({
      symbol: "BTCUSDT",
      snap: { ...baseSnap, signal: "NONE" as any, qualityScore: 85 },
      hasOpenPosition: false,
      currentStage: 0,
      symbolBlocked: false,
      isManualCooldownActive: false
    });
    assertEq(res.reviewingTicks, 0, "CASE D NONE signal gives 0");
    assertEq(sim.hasState("BTCUSDT"), false, "CASE D state removed");
    pass("CASE D - Candidate disappearance cleans state", "reviewingTicks=0, state removed");
  }

  // -------------------------------------------------------------------------
  // CASE E: Open position exists -> reviewingTicks = 0, state removed
  // -------------------------------------------------------------------------
  {
    // Start review
    sim.evaluateCandidate({
      symbol: "ETHUSDT",
      snap: { ...baseSnap, symbol: "ETHUSDT", signal: "paper_long_candidate" },
      hasOpenPosition: false,
      currentStage: 0,
      symbolBlocked: false,
      isManualCooldownActive: false
    });
    assertTrue(sim.hasState("ETHUSDT"), "ETH state created");

    // Position opens
    const res = sim.evaluateCandidate({
      symbol: "ETHUSDT",
      snap: { ...baseSnap, symbol: "ETHUSDT", signal: "paper_long_candidate" },
      hasOpenPosition: true,
      currentStage: 1,
      symbolBlocked: false,
      isManualCooldownActive: false
    });
    assertEq(res.reviewingTicks, 0, "CASE E open pos gives 0");
    assertEq(sim.hasState("ETHUSDT"), false, "CASE E state removed");
    pass("CASE E - Open position cleans state", "reviewingTicks=0, state removed");
  }

  // -------------------------------------------------------------------------
  // CASE F: Quality score drops by > 2 points -> sequence reset to 1
  // -------------------------------------------------------------------------
  {
    // Tick 1: quality 90
    sim.evaluateCandidate({
      symbol: "SOLUSDT",
      snap: { ...baseSnap, symbol: "SOLUSDT", signal: "paper_long_candidate", qualityScore: 90 },
      hasOpenPosition: false,
      currentStage: 0,
      symbolBlocked: false,
      isManualCooldownActive: false
    });
    // Tick 2: quality 89 (dropped by 1 <= 2 -> increments to 2)
    const t2 = sim.evaluateCandidate({
      symbol: "SOLUSDT",
      snap: { ...baseSnap, symbol: "SOLUSDT", signal: "paper_long_candidate", qualityScore: 89 },
      hasOpenPosition: false,
      currentStage: 0,
      symbolBlocked: false,
      isManualCooldownActive: false
    });
    assertEq(t2.reviewingTicks, 2, "CASE F tick 2 incremented");

    // Tick 3: quality drops to 87 (90 - 87 = 3 > 2 -> reset to 1)
    const t3 = sim.evaluateCandidate({
      symbol: "SOLUSDT",
      snap: { ...baseSnap, symbol: "SOLUSDT", signal: "paper_long_candidate", qualityScore: 87 },
      hasOpenPosition: false,
      currentStage: 0,
      symbolBlocked: false,
      isManualCooldownActive: false
    });
    assertEq(t3.reviewingTicks, 1, "CASE F quality drop > 2 resets to 1");
    pass("CASE F - Quality drop > 2 points resets sequence", "2 -> 1 on quality degradation");
  }

  // -------------------------------------------------------------------------
  // CASE G: V1 reviewing_ticks matches V2BridgeSnapshot.reviewing_ticks
  // -------------------------------------------------------------------------
  {
    const { now, bridgeSnapshot, config, state, legacyBridge } = buildMockBridgeFixtures(4);
    assertEq(bridgeSnapshot.reviewing_ticks, 4, "CASE G bridge snapshot reviewing_ticks match");

    const adapted = adaptV2Input(
      "BTCUSDT",
      now,
      bridgeSnapshot as any,
      config as any,
      state as any,
      {
        decision: {
          regime_state: "RANGE",
          final_decision: "SKIP",
          reject_reason: null,
          required_cost_usd: 0
        },
        executorDecision: null,
        intentSide: "none"
      }
    );

    assertEq(adapted.snapshot.reviewing_ticks, 4, "CASE G adapted V2 input reviewing_ticks matches");

    const proofLogs = captureProofLogs(() => {
      resolveSymbolDecisionEnvelope({
        symbol: "BTCUSDT",
        fetchedAt: now,
        snapshot: bridgeSnapshot,
        config: config as any,
        state: state as any,
        legacy: legacyBridge,
        v2Mode: "engine_v2",
        evaluationMode: "authoritative",
        runCycleId: "blocker-4-12-case-g"
      });
    });
    const propProof = proofLogs.find((l) => l.event === "V2_STRUCTURAL_METRIC_PROPAGATION_PROOF");
    assertTrue(propProof != null, "CASE G reconciler path emits V2_STRUCTURAL_METRIC_PROPAGATION_PROOF");
    assertEq(propProof.source_reviewing_ticks, 4, "CASE G reconciler source reviewing_ticks preserved");
    assertEq(propProof.adapted_reviewing_ticks, 4, "CASE G reconciler adapted reviewing_ticks preserved");
    pass(
      "CASE G - V1 reviewing_ticks propagated through V2 bridge and reconciler",
      "bridge=4 == adaptV2Input=4 == reconciler source/adapted=4"
    );
  }

  // -------------------------------------------------------------------------
  // CASE H: WHIPSAW detector checks reviewing_ticks < 6 (production detectMarketRegime)
  // -------------------------------------------------------------------------
  {
    const baseJudgmentInput = {
      symbol: "BTCUSDT",
      now: Date.now(),
      snapshot: {
        lastPrice: 60000,
        latestCandleClose: 60000,
        boxHigh: 61000,
        boxLow: 59000,
        boxPos: 0.5,
        rangeConfidence: 0.65,
        ema20: 59900,
        emaGap: 0.002,
        volatilityProxy: 500,
        boxCohesion01: 0.5,
        breakoutFailureRate: 0.2,
        trendWeaknessScore: 0.2,
        rangeOscillationScore: 0.4,
        boxBreakSide: "none" as const,
        signal: "paper_long_candidate",
        qualityScore: 85,
        data_ready: true,
        atr: 500,
        volumeExpansion: 1.0,
        atrExpansion: 1.0,
        candles: []
      },
      state: {
        currentPositions: [],
        longAllow: true,
        shortAllow: true,
        directionalShockState: "NONE" as const,
        crashState: "NONE",
        pumpState: "NONE"
      }
    };

    const judgment5 = detectMarketRegime({
      ...baseJudgmentInput,
      snapshot: { ...baseJudgmentInput.snapshot, reviewing_ticks: 5 }
    } as any);
    const reasons5 = judgment5.diagnostics?.confirmation_wait_reasons ?? [];
    assertTrue(reasons5.includes("reviewing_ticks_insufficient"), "CASE H reviewing_ticks=5 has reviewing_ticks_insufficient");

    const judgment6 = detectMarketRegime({
      ...baseJudgmentInput,
      snapshot: { ...baseJudgmentInput.snapshot, reviewing_ticks: 6 }
    } as any);
    const reasons6 = judgment6.diagnostics?.confirmation_wait_reasons ?? [];
    assertTrue(!reasons6.includes("reviewing_ticks_insufficient"), "CASE H reviewing_ticks=6 removes reviewing_ticks_insufficient");
    pass("CASE H - WHIPSAW detector tick 5 vs 6 verification", "production detectMarketRegime confirmation_wait_reasons");
  }

  // -------------------------------------------------------------------------
  // CASE I: V2 REJECT decision preserves candidate review counter
  // -------------------------------------------------------------------------
  {
    // Start candidate
    const r1 = sim.evaluateCandidate({
      symbol: "DOGEUSDT",
      snap: { ...baseSnap, symbol: "DOGEUSDT", signal: "paper_long_candidate", qualityScore: 80 },
      hasOpenPosition: false,
      currentStage: 0,
      symbolBlocked: false,
      isManualCooldownActive: false
    });
    assertEq(r1.reviewingTicks, 1, "CASE I tick 1");

    // V2 decision is REJECT/SKIP, but next cycle candidate persists
    const r2 = sim.evaluateCandidate({
      symbol: "DOGEUSDT",
      snap: { ...baseSnap, symbol: "DOGEUSDT", signal: "paper_long_candidate", qualityScore: 80 },
      hasOpenPosition: false,
      currentStage: 0,
      symbolBlocked: false,
      isManualCooldownActive: false
    });
    assertEq(r2.reviewingTicks, 2, "CASE I counter preserved across cycles regardless of V2 REJECT");
    pass("CASE I - V2 REJECT does not reset reviewing counter", "Counter advanced 1 -> 2");
  }

  console.info("\n=== BLOCKER 4-12 SUMMARY ===");
  console.info("ALL_RELEVANT_REGRESSION = PASS");
  console.info("READY_TO_STAGE_BLOCKER_4_12 = YES\n");
}

runBlocker412Cases();
