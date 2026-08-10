import type { PaperClosedPositionRecord, PaperOpenPositionRecord } from "../models/types";
import {
  aggregatePositionCycleClose,
  buildPositionCycleId,
  classifyTradeSource,
  enrichCompletedTradeRecord,
  isAccountStatsRow,
  isChildExecutionClose,
  isPositionCycleFinalRow,
  isPositionCycleFinalizeDuplicate,
  isStrategyStatsRow,
  normalizeFinalCloseReason,
  recordPositionCycleExitFill,
  resolveWeightedExitAvgPx
} from "../engine-v2/lifecycle/completed-trade";
import { buildPaperWindowSummaryFromHistory } from "../storage/paper-summary";
import { finalizePaperClosedRecord, computePaperCloseLegMetrics } from "../engine/paper-close-finalize";
import { applyPositionTerminalCleanup } from "../engine-v2/position/terminal-cleanup";

function run(label: string, passed: boolean, detail: string): boolean {
  console.log(`[${label}] ${passed ? "PASS" : "FAIL"} — ${detail}`);
  return passed;
}

function botOpen(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    symbol: "ETHUSDT",
    side: "long",
    openedAt: 1_000_000,
    entryPrice: 1900,
    avgPx: 1900,
    sizeUsd: 20,
    leverage: 10,
    okxContracts: 0.03,
    isV2Authority: true,
    authoritySourceAtEntry: "v2",
    exchangeClOrdId: "pETHUSDTlabc",
    strategyVersion: "paper-v2",
    ...overrides
  } as PaperOpenPositionRecord;
}

function finalizeRow(open: PaperOpenPositionRecord, closePrice: number, closeReason: string, marginUsd: number) {
  const metrics = computePaperCloseLegMetrics({
    open,
    closePrice,
    closedAt: 2_000_000,
    snapFundingRate: 0,
    marginUsd,
    paperTakerFeeRate: 0.0005,
    paperFundingIntervalHours: 8
  });
  return finalizePaperClosedRecord({
    open,
    symbol: open.symbol,
    closePrice,
    closedAt: 2_000_000,
    closeReason: closeReason as PaperClosedPositionRecord["closeReason"],
    legMarginUsd: marginUsd,
    metrics,
    feeRate: 0.0005,
    fundingIntervalHours: 8,
    strategyVersion: "paper-v2"
  });
}

export function runCompletedTradeCaseTests(): boolean {
  let ok = true;

  // CASE A: entry → final close = 1 completed trade with exit + reason
  {
    const open = botOpen();
    const row = enrichCompletedTradeRecord({
      open,
      closedRow: finalizeRow(open, 1920, "stop_loss", 20),
      isFinalClose: true,
      actualFillPx: 1920,
      actualFillContracts: 0.03,
      isStop: true
    });
    ok =
      run(
        "CASE A",
        row.isPositionCycleFinal === true &&
          (row.exitAvgPx ?? 0) > 0 &&
          row.finalCloseReason === "STOP_LOSS" &&
          isStrategyStatsRow(row),
        JSON.stringify({
          final: row.isPositionCycleFinal,
          exit: row.exitAvgPx,
          reason: row.finalCloseReason
        })
      ) && ok;
  }

  // CASE B: entry → shock reduce → final close = 1 trade, partial_reduce_count=1
  {
    const open = botOpen();
    recordPositionCycleExitFill(open, {
      px: 1910,
      contracts: 0.01,
      pnlUsdNet: 0.5,
      feeUsd: 0.01,
      at: 1_500_000,
      reason: "SHOCK_PROTECTIVE_REDUCE"
    });
    const finalLeg = finalizeRow(open, 1905, "stop_loss", 13);
    const row = enrichCompletedTradeRecord({
      open,
      closedRow: finalLeg,
      isFinalClose: true,
      actualFillPx: 1905,
      actualFillContracts: 0.02,
      isStop: true
    });
    ok =
      run(
        "CASE B",
        row.isPositionCycleFinal === true &&
          (row.partialReduceCount ?? 0) === 1 &&
          isPositionCycleFinalRow(row),
        JSON.stringify({ partialReduceCount: row.partialReduceCount, pnl: row.pnlUsdNet })
      ) && ok;
  }

  // CASE C: entry → addon → partial → final with weighted exit
  {
    const open = botOpen({ okxContracts: 0.02, avgPx: 1905 });
    recordPositionCycleExitFill(open, {
      px: 1915,
      contracts: 0.005,
      pnlUsdNet: 0.2,
      feeUsd: 0.01,
      at: 1_600_000,
      reason: "partial"
    });
    const row = enrichCompletedTradeRecord({
      open,
      closedRow: finalizeRow(open, 1925, "take_profit_2", 15),
      isFinalClose: true,
      actualFillPx: 1925,
      actualFillContracts: 0.02,
      isTakeProfit: true
    });
    const expectedExit = resolveWeightedExitAvgPx(open.positionCycleExitFills ?? [], {
      px: 1925,
      contracts: 0.02,
      pnlUsdNet: row.pnlUsdNet,
      feeUsd: row.feeUsd,
      at: 2_000_000
    });
    ok =
      run(
        "CASE C",
        row.isPositionCycleFinal === true &&
          Math.abs((row.exitAvgPx ?? 0) - (expectedExit ?? 0)) < 1e-6,
        `exit=${row.exitAvgPx}, expected=${expectedExit}`
      ) && ok;
  }

  // CASE D: BTC external manual → account yes, strategy no
  {
    const open = botOpen({
      symbol: "BTCUSDT",
      manualOwnershipLatch: true,
      lifecycleState: "EXTERNAL_MANUAL_MANAGED",
      isV2Authority: false,
      authoritySourceAtEntry: undefined,
      exchangeClOrdId: undefined
    });
    const row = enrichCompletedTradeRecord({
      open,
      closedRow: finalizeRow(open, 95000, "manual_full_close_reconciled", 20),
      isFinalClose: true,
      actualFillPx: 95000,
      actualFillContracts: 0.01
    });
    ok =
      run(
        "CASE D",
        row.tradeSource === "MANUAL_EXTERNAL" &&
          isAccountStatsRow(row) &&
          !isStrategyStatsRow(row),
        row.tradeSource ?? "null"
      ) && ok;
  }

  // CASE E: partial only (child) → not final / not strategy count
  {
    const open = botOpen();
    const row = enrichCompletedTradeRecord({
      open,
      closedRow: finalizeRow(open, 1910, "take_profit_1", 5),
      isFinalClose: false,
      actualFillPx: 1910,
      actualFillContracts: 0.01,
      isTakeProfit: true
    });
    ok =
      run(
        "CASE E",
        row.isChildExecution === true &&
          row.isPositionCycleFinal === false &&
          !isStrategyStatsRow(row),
        JSON.stringify(row)
      ) && ok;
  }

  // CASE F/G: finalize context survives terminal cleanup fields on open ledger object
  {
    const open = botOpen({ shockReduceState: "SUBMITTED", manualOwnershipLatch: true });
    const row = enrichCompletedTradeRecord({
      open,
      closedRow: finalizeRow(open, 1918, "stop_loss", 20),
      isFinalClose: true,
      actualFillPx: 1918,
      actualFillContracts: 0.03,
      isStop: true
    });
    applyPositionTerminalCleanup(open);
    ok =
      run(
        "CASE F/G",
        (row.exitAvgPx ?? 0) > 0 &&
          row.finalCloseReason === "STOP_LOSS" &&
          row.pnlUsdNet != null,
        JSON.stringify({
          exit: row.exitAvgPx,
          reason: row.finalCloseReason,
          pnl: row.pnlUsdNet
        })
      ) && ok;
  }

  // CASE H/I: child / non-final rows excluded from strategy denominator
  {
    const child = {
      tradeSource: "BOT_V2",
      isChildExecution: true,
      isPositionCycleFinal: false,
      pnlUsdNet: 1,
      closeReason: "take_profit_1",
      exitType: "EXIT_TP_1"
    };
    ok =
      run(
        "CASE H/I",
        !isStrategyStatsRow(child) && isChildExecutionClose("take_profit_1", "EXIT_TP_1"),
        "child excluded"
      ) && ok;
  }

  // CASE J/K: SL/TP canonical reasons (no unknown)
  {
    const sl = normalizeFinalCloseReason({ closeReason: "stop_loss", exitType: "EXIT_SL", isStop: true });
    const tp = normalizeFinalCloseReason({
      closeReason: "take_profit_2",
      exitType: "EXIT_TP",
      isTakeProfit: true,
      isExchangeAlgo: true
    });
    ok = run("CASE J", sl === "STOP_LOSS", sl) && ok;
    ok = run("CASE K", tp === "EXCHANGE_TP_TRIGGER", tp) && ok;
  }

  // CASE L: rehydrated BOT_V2 cycle id stable → one cycle key
  {
    const open = botOpen({ lifecycleState: "BOT_V2_MANAGED", reconcileState: "MATCHED" });
    const id1 = buildPositionCycleId(open.symbol, open.side, open.openedAt);
    const row = enrichCompletedTradeRecord({
      open,
      closedRow: finalizeRow(open, 1912, "v2_exit_authority", 20),
      isFinalClose: true,
      actualFillPx: 1912,
      actualFillContracts: 0.03
    });
    ok =
      run(
        "CASE L",
        row.positionCycleId === id1 &&
          row.isPositionCycleFinal === true &&
          classifyTradeSource(open) === "BOT_V2",
        row.positionCycleId ?? "null"
      ) && ok;
  }

  // CASE M: duplicate finalize on same position_cycle_id → blocked (final count 1)
  {
    const open = botOpen();
    const finalRow = enrichCompletedTradeRecord({
      open,
      closedRow: finalizeRow(open, 1915, "stop_loss", 20),
      isFinalClose: true,
      actualFillPx: 1915,
      actualFillContracts: 0.03,
      isStop: true
    });
    const duplicateAttempt = enrichCompletedTradeRecord({
      open,
      closedRow: finalizeRow(open, 1914, "manual_full_close_reconciled", 20),
      isFinalClose: true,
      actualFillPx: 1914,
      actualFillContracts: 0.03
    });
    const history = [finalRow];
    ok =
      run(
        "CASE M",
        isPositionCycleFinalizeDuplicate(duplicateAttempt, history) === true &&
          isPositionCycleFinalizeDuplicate(finalRow, []) === false,
        `cycle=${finalRow.positionCycleId}`
      ) && ok;
  }

  // CASE N: partial + partial + final → aggregate pnl/fee includes all legs
  {
    const open = botOpen();
    recordPositionCycleExitFill(open, {
      px: 1910,
      contracts: 0.01,
      pnlUsdNet: 0.4,
      feeUsd: 0.02,
      at: 1_400_000,
      reason: "SHOCK_PROTECTIVE_REDUCE"
    });
    recordPositionCycleExitFill(open, {
      px: 1912,
      contracts: 0.005,
      pnlUsdNet: 0.15,
      feeUsd: 0.01,
      at: 1_600_000,
      reason: "take_profit_1"
    });
    const finalLeg = finalizeRow(open, 1918, "stop_loss", 10);
    const row = enrichCompletedTradeRecord({
      open,
      closedRow: finalLeg,
      isFinalClose: true,
      actualFillPx: 1918,
      actualFillContracts: 0.015,
      isStop: true
    });
    const expectedNet = 0.4 + 0.15 + finalLeg.pnlUsdNet;
    const expectedFee = 0.02 + 0.01 + finalLeg.feeUsd;
    ok =
      run(
        "CASE N",
        Math.abs(row.pnlUsdNet - expectedNet) < 1e-9 &&
          Math.abs(row.feeUsd - expectedFee) < 1e-9 &&
          row.pnlUsdNet !== finalLeg.pnlUsdNet,
        JSON.stringify({ aggregate: row.pnlUsdNet, finalOnly: finalLeg.pnlUsdNet, fee: row.feeUsd })
      ) && ok;
  }

  // CASE O: legacy child rows without isPositionCycleFinal → excluded from strategy stats
  {
    const legacyHistory = [
      { symbol: "ETHUSDT", side: "long", openedAt: 900_000, closedAt: 950_000, pnlUsdNet: 0.5, closeReason: "take_profit_1", exitType: "EXIT_TP_1", isV2Authority: true },
      { symbol: "ETHUSDT", side: "long", openedAt: 900_000, closedAt: 960_000, pnlUsdNet: 0.3, closeReason: "partial_exit_1", exitType: "EXIT_PARTIAL_SPLIT_1", isV2Authority: true },
      { symbol: "ETHUSDT", side: "long", openedAt: 900_000, closedAt: 980_000, pnlUsdNet: 2.0, closeReason: "stop_loss", exitType: "EXIT_SL", isV2Authority: true }
    ];
    const strategyCount = legacyHistory.filter(isStrategyStatsRow).length;
    const window = buildPaperWindowSummaryFromHistory(legacyHistory, 1_000_000);
    ok =
      run(
        "CASE O",
        strategyCount === 1 &&
          window.strategyWindows.all.totalTrades === 1 &&
          !isStrategyStatsRow(legacyHistory[0]) &&
          !isStrategyStatsRow(legacyHistory[1]),
        `strategyCount=${strategyCount}, window=${window.strategyWindows.all.totalTrades}`
      ) && ok;
  }

  return ok;
}

if (require.main === module) {
  process.exit(runCompletedTradeCaseTests() ? 0 : 1);
}
