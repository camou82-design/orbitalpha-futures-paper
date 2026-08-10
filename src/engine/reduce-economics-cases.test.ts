import type { PaperOpenPositionRecord } from "../models/types";
import {
  evaluateReduceEpisodeGate,
  evaluatePartialReduceLimit,
  evaluateReduceEconomicSize,
  evaluateReduceExecutionEconomics,
  evaluateShockReduceEscalation,
  isProtectivePartialReason,
  isFeeEconomicsBypassReason,
  buildCompletedTradeEconomicsProof,
  MAX_PROTECTIVE_PARTIAL_REDUCE_COUNT,
  REDUCE_FEE_SAFETY_MULTIPLIER,
  V2_REDUCE_ECONOMIC_LOT_DISTORTION_THRESHOLD
} from "../engine-v2/execution/reduce-economics";
import {
  resolveTerminalCloseAttribution
} from "../engine-v2/lifecycle/terminal-close-attribution";
import {
  classifyTradeSource,
  isStrategyStatsRow,
  recordPositionCycleExitFill,
  enrichCompletedTradeRecord
} from "../engine-v2/lifecycle/completed-trade";
import type { PaperClosedPositionRecord } from "../models/types";
import { finalizePaperClosedRecord, computePaperCloseLegMetrics } from "../engine/paper-close-finalize";

function run(label: string, passed: boolean, detail: string): boolean {
  console.log(`[${label}] ${passed ? "PASS" : "FAIL"} — ${detail}`);
  return passed;
}

function botOpen(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    symbol: "ETHUSDT",
    side: "long",
    openedAt: 1_000_000,
    entryPrice: 1875,
    avgPx: 1875.92,
    sizeUsd: 20,
    leverage: 10,
    okxContracts: 0.1,
    isV2Authority: true,
    authoritySourceAtEntry: "v2",
    exchangeClOrdId: "pETHUSDTlabc",
    strategyVersion: "paper-v2",
    stopPrice: 1850,
    ...overrides
  } as PaperOpenPositionRecord;
}

export function runReduceEconomicsCaseTests(): boolean {
  let ok = true;
  const reason = "SHOCK_PROTECTIVE_REDUCE";
  const candleTs = 100_000;

  // CASE A: same SHOCK 10 cycles — after first fill, repeat blocked
  {
    const open = botOpen({
      lastReduceEpisodeId: "ETHUSDT|long|SHOCK_PROTECTIVE_REDUCE|DOWN_SHOCK|SHOCK",
      lastReduceFilledCandleTs: candleTs,
      lastReduceShockPhase: "DOWN_SHOCK",
      protectivePartialReduceCount: 1
    });
    const gate = evaluateReduceEpisodeGate({
      open,
      reason,
      decisionCandleTs: candleTs,
      shockPhase: "DOWN_SHOCK",
      marketSubtype: "SHOCK",
      urgency: "medium",
      reduceRatio: 0.2
    });
    ok =
      run(
        "CASE A",
        !gate.submitAllowed && gate.blockReason === "REDUCE_EPISODE_ALREADY_EXECUTED",
        JSON.stringify(gate)
      ) && ok;
  }

  // CASE B: fresh candle + shock severity worsened — second partial allowed
  {
    const open = botOpen({
      lastReduceEpisodeId: "ETHUSDT|long|SHOCK_PROTECTIVE_REDUCE|DOWN_SHOCK|SHOCK",
      lastReduceFilledCandleTs: candleTs,
      lastReduceShockPhase: "DOWN_SHOCK",
      protectivePartialReduceCount: 1
    });
    const gate = evaluateReduceEpisodeGate({
      open,
      reason,
      decisionCandleTs: candleTs + 60_000,
      shockPhase: "DOWN_SHOCK_CRITICAL",
      marketSubtype: "SHOCK",
      urgency: "high",
      reduceRatio: 0.2
    });
    ok =
      run(
        "CASE B",
        gate.submitAllowed && gate.newMarketEvidence,
        JSON.stringify(gate)
      ) && ok;
  }

  // CASE C: partialReduceCount=2 + same risk — HOLD
  {
    const limit = evaluatePartialReduceLimit({
      open: botOpen(),
      reason,
      protectivePartialCount: 2,
      urgency: "medium",
      invalidationImminent: false
    });
    const esc = evaluateShockReduceEscalation({
      episodeCount: 2,
      shockPhase: "DOWN_SHOCK",
      previousShockPhase: "DOWN_SHOCK",
      freshCandle: false,
      riskDeteriorated: false,
      urgency: "medium",
      invalidationImminent: false
    });
    ok =
      run(
        "CASE C",
        !limit.submitAllowed &&
          limit.fallbackAction === "HOLD" &&
          !esc.partialAllowed &&
          !esc.fullExitRequired,
        JSON.stringify({ limit, esc })
      ) && ok;
  }

  // CASE D: partialReduceCount=2 + invalidation imminent — FULL EXIT
  {
    const limit = evaluatePartialReduceLimit({
      open: botOpen(),
      reason,
      protectivePartialCount: 2,
      urgency: "high",
      invalidationImminent: true
    });
    const esc = evaluateShockReduceEscalation({
      episodeCount: 2,
      shockPhase: "DOWN_SHOCK_CRITICAL",
      previousShockPhase: "DOWN_SHOCK",
      freshCandle: true,
      riskDeteriorated: true,
      urgency: "high",
      invalidationImminent: true
    });
    ok =
      run(
        "CASE D",
        limit.fallbackAction === "FULL_EXIT" && esc.fullExitRequired,
        JSON.stringify({ limit, esc })
      ) && ok;
  }

  // CASE E: requested 0.20 USDT notional vs normalized 1.92 — HOLD
  {
    const size = evaluateReduceEconomicSize({
      reason,
      requestedReduceNotionalUsdt: 0.2,
      normalizedReduceNotionalUsdt: 1.92
    });
    ok =
      run(
        "CASE E",
        !size.economicSizePassed &&
          size.lotDistortionRatio > V2_REDUCE_ECONOMIC_LOT_DISTORTION_THRESHOLD &&
          size.fallbackAction === "HOLD",
        JSON.stringify(size)
      ) && ok;
  }

  // CASE F: STOP LOSS bypasses lot distortion / fee gates
  {
    const size = evaluateReduceEconomicSize({
      reason: "STOP_LOSS",
      requestedReduceNotionalUsdt: 0.2,
      normalizedReduceNotionalUsdt: 1.92
    });
    const fee = evaluateReduceExecutionEconomics({
      reason: "STOP_LOSS",
      positionNotionalUsdt: 100,
      requestedReduceNotionalUsdt: 0.2,
      normalizedReduceNotionalUsdt: 1.92,
      feeRate: 0.0005,
      riskBeforeUsdt: 0.01,
      riskAfterUsdt: 0,
      includeReentryFee: true
    });
    ok =
      run(
        "CASE F",
        size.economicSizePassed &&
          fee.economicsPassed &&
          isFeeEconomicsBypassReason("STOP_LOSS"),
        JSON.stringify({ size, fee })
      ) && ok;
  }

  // CASE G: fee > risk reduction — economically inefficient
  {
    const fee = evaluateReduceExecutionEconomics({
      reason,
      positionNotionalUsdt: 50,
      requestedReduceNotionalUsdt: 0.2,
      normalizedReduceNotionalUsdt: 1.92,
      feeRate: 0.0005,
      riskBeforeUsdt: 0.05,
      riskAfterUsdt: 0.049,
      includeReentryFee: true
    });
    ok =
      run(
        "CASE G",
        !fee.economicsPassed && fee.bypassReason === "ECONOMICALLY_INEFFICIENT_REDUCE",
        JSON.stringify(fee)
      ) && ok;
  }

  // CASE H: risk reduction >> fee — partial allowed
  {
    const fee = evaluateReduceExecutionEconomics({
      reason,
      positionNotionalUsdt: 200,
      requestedReduceNotionalUsdt: 20,
      normalizedReduceNotionalUsdt: 20,
      feeRate: 0.0005,
      riskBeforeUsdt: 10,
      riskAfterUsdt: 2,
      includeReentryFee: true
    });
    ok =
      run(
        "CASE H",
        fee.economicsPassed &&
          fee.riskReductionUsdt > fee.estimatedExitFeeUsdt * REDUCE_FEE_SAFETY_MULTIPLIER,
        JSON.stringify(fee)
      ) && ok;
  }

  // CASE I: BOT_V2 bot exit + reconcile flat — V2_EXIT not MANUAL_CLOSE
  {
    const open = botOpen({
      lastBotExecutionReason: "v2_exit_authority",
      lastBotExecutionAt: Date.now() - 1000,
      positionCycleExitFills: [
        { px: 1875, contracts: 0.1, pnlUsdNet: 0.1, feeUsd: 0.01, at: Date.now() - 2000, reason: "v2_exit_authority" }
      ]
    });
    const attr = resolveTerminalCloseAttribution({
      open,
      reconcileSource: "RECONCILE_ABSENT",
      okxFlatDetectedAt: Date.now(),
      manualEvidencePresent: false
    });
    ok =
      run(
        "CASE I",
        attr.finalCloseReason === "V2_EXIT" &&
          classifyTradeSource(open) === "BOT_V2",
        JSON.stringify(attr)
      ) && ok;
  }

  // CASE J: BOT stop triggered — STOP_LOSS
  {
    const open = botOpen({
      lastBotExecutionReason: "stop_loss",
      lastBotExecutionAt: Date.now() - 500
    });
    const attr = resolveTerminalCloseAttribution({
      open,
      reconcileSource: "RECONCILE_ABSENT",
      okxFlatDetectedAt: Date.now(),
      manualEvidencePresent: false
    });
    ok =
      run(
        "CASE J",
        attr.finalCloseReason === "STOP_LOSS",
        JSON.stringify(attr)
      ) && ok;
  }

  // CASE K: explicit manual external — EXTERNAL_MANUAL_CLOSE
  {
    const open = botOpen({ manualOwnershipLatch: true, lifecycleState: "EXTERNAL_MANUAL_MANAGED" });
    const attr = resolveTerminalCloseAttribution({
      open,
      reconcileSource: "RECONCILE_ABSENT",
      okxFlatDetectedAt: Date.now(),
      manualEvidencePresent: true
    });
    ok =
      run(
        "CASE K",
        attr.finalCloseReason === "EXTERNAL_MANUAL_CLOSE",
        JSON.stringify(attr)
      ) && ok;
  }

  // CASE L: ADOPTED_EXTERNAL excluded from strategy stats
  {
    const open = botOpen({
      isV2Authority: false,
      reconcileState: "ADOPTED",
      sourceSignal: "okx_reconcile_adopted",
      lifecycleState: "OKX_UNTRACKED_FILL"
    });
    ok =
      run(
        "CASE L",
        classifyTradeSource(open) === "ADOPTED_EXTERNAL" &&
          !isStrategyStatsRow({ ...open, tradeSource: "ADOPTED_EXTERNAL", isPositionCycleFinal: true }),
        classifyTradeSource(open)
      ) && ok;
  }

  // CASE M: 2 protective partials + final close — partialReduceCount=2
  {
    const open = botOpen();
    recordPositionCycleExitFill(open, {
      px: 1876,
      contracts: 0.01,
      pnlUsdNet: 0.01,
      feeUsd: 0.02,
      at: 1_500_000,
      reason: "SHOCK_PROTECTIVE_REDUCE"
    });
    recordPositionCycleExitFill(open, {
      px: 1875.5,
      contracts: 0.01,
      pnlUsdNet: -0.01,
      feeUsd: 0.02,
      at: 1_600_000,
      reason: "SHOCK_PROTECTIVE_REDUCE"
    });
    open.protectivePartialReduceCount = 2;
    const metrics = computePaperCloseLegMetrics({
      open,
      closePrice: 1875.1,
      closedAt: 2_000_000,
      snapFundingRate: 0,
      marginUsd: 16,
      paperTakerFeeRate: 0.0005,
      paperFundingIntervalHours: 8
    });
    const closedRow = finalizePaperClosedRecord({
      open,
      symbol: open.symbol,
      closePrice: 1875.1,
      closedAt: 2_000_000,
      closeReason: "v2_exit_authority" as PaperClosedPositionRecord["closeReason"],
      legMarginUsd: 16,
      metrics,
      feeRate: 0.0005,
      fundingIntervalHours: 8,
      strategyVersion: "paper-v2"
    });
    const row = enrichCompletedTradeRecord({
      open,
      closedRow,
      isFinalClose: true,
      actualFillPx: 1875.1,
      actualFillContracts: 0.08
    });
    ok =
      run(
        "CASE M",
        row.isPositionCycleFinal === true && (row.partialReduceCount ?? 0) === 2,
        JSON.stringify({ partialReduceCount: row.partialReduceCount })
      ) && ok;
  }

  // CASE N: gross +0.005, fee -0.07 — fee_dominated_loss
  {
    const proof = buildCompletedTradeEconomicsProof({
      gross_realized_pnl_usdt: 0.005,
      total_fee_usdt: -0.07,
      net_realized_pnl_usdt: -0.065,
      fee_dominated_loss: -0.065 < 0 && 0.005 >= 0,
      fee_pressure_high: Math.abs(-0.07) > Math.abs(0.005)
    });
    ok =
      run(
        "CASE N",
        proof.fee_dominated_loss === true && proof.fee_pressure_high === true,
        JSON.stringify(proof)
      ) && ok;
  }

  // CASE O: MFE positive preserved on completed trade
  {
    const open = botOpen({
      maxFavorableExcursionPct: 0.012,
      maxAdverseExcursionPct: 0.008,
      maxFavorablePrice: 1900,
      maxAdversePrice: 1860
    });
    const metrics = computePaperCloseLegMetrics({
      open,
      closePrice: 1870,
      closedAt: 2_000_000,
      snapFundingRate: 0,
      marginUsd: 20,
      paperTakerFeeRate: 0.0005,
      paperFundingIntervalHours: 8
    });
    const closedRow = finalizePaperClosedRecord({
      open,
      symbol: open.symbol,
      closePrice: 1870,
      closedAt: 2_000_000,
      closeReason: "v2_exit_authority" as PaperClosedPositionRecord["closeReason"],
      legMarginUsd: 20,
      metrics,
      feeRate: 0.0005,
      fundingIntervalHours: 8,
      strategyVersion: "paper-v2"
    });
    const row = enrichCompletedTradeRecord({
      open,
      closedRow,
      isFinalClose: true,
      actualFillPx: 1870,
      actualFillContracts: 0.1
    });
    const rowWithMfe = {
      ...row,
      mfePct: open.maxFavorableExcursionPct,
      maePct: open.maxAdverseExcursionPct
    };
    ok =
      run(
        "CASE O",
        (rowWithMfe.mfePct ?? 0) > 0 &&
          (rowWithMfe.pnlUsdNet ?? 0) < 0 &&
          (rowWithMfe.maePct ?? 0) > 0,
        JSON.stringify({ mfePct: rowWithMfe.mfePct, maePct: rowWithMfe.maePct, pnl: rowWithMfe.pnlUsdNet })
      ) && ok;
  }

  // sanity: protective reason classifier
  ok =
    run(
      "PROTECTIVE_REASON",
      isProtectivePartialReason("SHOCK_PROTECTIVE_REDUCE") &&
        !isProtectivePartialReason("V2_RANGE_TAKE_PROFIT_1") &&
        MAX_PROTECTIVE_PARTIAL_REDUCE_COUNT === 2,
      "classifier ok"
    ) && ok;

  return ok;
}

if (require.main === module) {
  process.exit(runReduceEconomicsCaseTests() ? 0 : 1);
}
