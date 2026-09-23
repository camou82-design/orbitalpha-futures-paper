import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePositionsHistoryArray,
  normalizeClosedHistoryRow,
  resolveDisplayTradeSourceLabel
} from "../lib/paperClosedHistoryNormalize";
import {
  buildLedgerPerformanceFromHistory,
  startOfKstDayMs
} from "../lib/futuresPaperLedgerStats";
import {
  buildPaperDailySummaryFromHistory,
  kstDayKeyFromMs,
  utcDayKeyFromMs
} from "../storage/paper-summary";
import { isStrategyStatsRow, isAccountStatsRow } from "../engine-v2/lifecycle/completed-trade";

test("V2 KST Today & OKX Account Truth Reconcile Suite", async (t) => {
  // 1. Deduplication Proof: Bot ledger row + OKX truth fill row are deduplicated into exactly 1 trade
  await t.test("1. Dedup proof: Auto V2 trade present in both history.json and okx-closed-trades.json is counted as 1", () => {
    const botLedgerRow = {
      symbol: "BTCUSDT",
      side: "long",
      source: "v2",
      tradeSource: "BOT_V2",
      authority: "ENGINE",
      flowId: "flow-btc-001",
      positionCycleId: "BTCUSDT:long:1788500000000",
      entryPrice: 65000,
      closePrice: 66000,
      openedAt: 1788500000000,
      closedAt: 1788500060000,
      pnlUsdNet: 100,
      feeUsd: 5,
      isPositionCycleFinal: true,
      exchangeEntryOrdIds: ["ord_entry_101"],
      exchangeExitOrdIds: ["ord_exit_101"],
      exchangeFillIds: ["fill_entry_101", "fill_exit_101"]
    };

    const okxTruthRow = {
      symbol: "BTCUSDT",
      side: "long",
      source: "BOT_V2",
      tradeSource: "BOT_V2",
      entryPrice: 65000,
      closePrice: 66000,
      openedAt: 1788500000000,
      closedAt: 1788500060000,
      realizedPnl: 105,
      pnlNet: 100,
      fee: 5,
      accountTruth: true,
      lifecycleId: "okx_life:BTCUSDT:long:1788500000000:1788500060000",
      positionCycleId: "BTCUSDT:long:1788500000000",
      isPositionCycleFinal: true,
      exchangeEntryOrdIds: ["ord_entry_101"],
      exchangeExitOrdIds: ["ord_exit_101"],
      exchangeFillIds: ["fill_entry_101", "fill_exit_101"]
    };

    const unified = normalizePositionsHistoryArray([botLedgerRow, okxTruthRow]);
    assert.equal(unified.length, 1, "Must deduplicate to exactly 1 trade record");
    assert.equal(unified[0].sourceLabel, "자동");
    assert.equal(unified[0].pnlUsdNet, 100);

    const perf = buildLedgerPerformanceFromHistory(unified);
    assert.equal(perf.all.totalTrades, 1, "Account total trades must be 1");
    assert.equal(perf.strategy.all.totalTrades, 1, "Strategy total trades must be 1");
  });

  // 2. Strategy vs Account PnL separation: Manual trades must NOT mix into strategy PnL
  await t.test("2. Strategy vs Account separation: Manual/Operator trades never pollute strategy metrics", () => {
    const botTrade = {
      symbol: "BTCUSDT",
      side: "long",
      tradeSource: "BOT_V2",
      source: "v2",
      isV2Authority: true,
      openedAt: 1788500000000,
      closedAt: 1788500060000,
      pnlUsdNet: 150,
      pnlUsdGross: 155,
      feeUsd: 5,
      isPositionCycleFinal: true
    };

    const manualTrade = {
      symbol: "ETHUSDT",
      side: "short",
      tradeSource: "MANUAL_EXTERNAL",
      source: "manual",
      isManualEntry: true,
      isManualExit: true,
      openedAt: 1788500010000,
      closedAt: 1788500070000,
      pnlUsdNet: -50,
      pnlUsdGross: -45,
      feeUsd: 5,
      isPositionCycleFinal: true
    };

    const operatorTakeoverTrade = {
      symbol: "ETHUSDT",
      side: "long",
      tradeSource: "OPERATOR_MANAGED",
      source: "OPERATOR_MANAGED",
      isManualExit: true,
      openedAt: 1788500020000,
      closedAt: 1788500080000,
      pnlUsdNet: 80,
      pnlUsdGross: 85,
      feeUsd: 5,
      isPositionCycleFinal: true
    };

    assert.equal(isStrategyStatsRow(botTrade), true, "Bot trade is strategy");
    assert.equal(isStrategyStatsRow(manualTrade), false, "Manual trade is NOT strategy");
    assert.equal(isStrategyStatsRow(operatorTakeoverTrade), false, "Operator takeover is NOT strategy");

    assert.equal(isAccountStatsRow(botTrade), true);
    assert.equal(isAccountStatsRow(manualTrade), true);
    assert.equal(isAccountStatsRow(operatorTakeoverTrade), true);

    const history = [botTrade, manualTrade, operatorTakeoverTrade];
    const perf = buildLedgerPerformanceFromHistory(history);

    // Account total includes all 3 trades
    assert.equal(perf.all.totalTrades, 3);
    assert.equal(perf.all.totalPnlUsdNet, 180); // 150 - 50 + 80

    // Strategy total includes ONLY the 1 bot trade
    assert.equal(perf.strategy.all.totalTrades, 1);
    assert.equal(perf.strategy.all.totalPnlUsdNet, 150); // only 150!
  });

  // 3. KST Today aggregation based strictly on closedAt (not openedAt)
  await t.test("3. KST Today aggregation uses closedAt timestamp, not openedAt", () => {
    // Reference time: 2026-09-24 01:00:00 KST (= 2026-09-23 16:00:00 UTC)
    const refNowMs = Date.UTC(2026, 8, 23, 16, 0, 0, 0); // 2026-09-24 01:00 KST
    const kstTodayStart = startOfKstDayMs(refNowMs);
    // KST today start is 2026-09-24 00:00:00 KST = 2026-09-23 15:00:00 UTC
    assert.equal(kstTodayStart, Date.UTC(2026, 8, 23, 15, 0, 0, 0));

    // Trade A: Opened yesterday (2026-09-23 10:00 KST), Closed TODAY (2026-09-24 00:30 KST) -> MUST be counted in Today!
    const tradeA = {
      symbol: "BTCUSDT",
      side: "long",
      tradeSource: "BOT_V2",
      openedAt: Date.UTC(2026, 8, 23, 1, 0, 0, 0), // Sep 23 10:00 KST (opened yesterday)
      closedAt: Date.UTC(2026, 8, 23, 15, 30, 0, 0), // Sep 24 00:30 KST (closed today!)
      pnlUsdNet: 70,
      feeUsd: 2,
      isPositionCycleFinal: true
    };

    // Trade B: Opened and closed yesterday (2026-09-23 18:00 KST) -> Must NOT be in Today!
    const tradeB = {
      symbol: "ETHUSDT",
      side: "short",
      tradeSource: "MANUAL_EXTERNAL",
      openedAt: Date.UTC(2026, 8, 23, 8, 0, 0, 0), // Sep 23 17:00 KST
      closedAt: Date.UTC(2026, 8, 23, 9, 0, 0, 0), // Sep 23 18:00 KST
      pnlUsdNet: 30,
      feeUsd: 1,
      isPositionCycleFinal: true
    };

    // Trade C: Opened today (2026-09-24 00:10 KST), still open (not closed) -> omitted from closed trades
    // (Only closed trades with closedAt are counted)

    const perf = buildLedgerPerformanceFromHistory([tradeA, tradeB], refNowMs);
    assert.equal(perf.today.totalTrades, 1, "Only Trade A was closed today KST");
    assert.equal(perf.today.totalPnlUsdNet, 70);
    assert.equal(perf.strategy.today.totalTrades, 1);
    assert.equal(perf.all.totalTrades, 2);
  });

  // 4. Exact 2026-09-23 KST and 2026-09-24 KST Day Bucket Verification
  await t.test("4. Exact Day Bucket Verification for 2026-09-23 KST and 2026-09-24 KST", () => {
    // 3 trades occurred on 2026-09-23 KST:
    // Trade 1: closed at 2026-09-23 10:00 KST (01:00 UTC)
    // Trade 2: closed at 2026-09-23 14:00 KST (05:00 UTC)
    // Trade 3: closed at 2026-09-23 23:30 KST (14:30 UTC)
    // Trade 4: closed at 2026-09-24 00:30 KST (15:30 UTC of Sep 23)

    const t1 = {
      symbol: "BTCUSDT",
      side: "long",
      tradeSource: "BOT_V2",
      closedAt: Date.UTC(2026, 8, 23, 1, 0, 0),
      pnlUsdNet: 50,
      isPositionCycleFinal: true
    };
    const t2 = {
      symbol: "ETHUSDT",
      side: "short",
      tradeSource: "BOT_V2",
      closedAt: Date.UTC(2026, 8, 23, 5, 0, 0),
      pnlUsdNet: 30,
      isPositionCycleFinal: true
    };
    const t3 = {
      symbol: "ETHUSDT",
      side: "long",
      tradeSource: "MANUAL_EXTERNAL",
      closedAt: Date.UTC(2026, 8, 23, 14, 30, 0),
      pnlUsdNet: -10,
      isPositionCycleFinal: true
    };
    const t4 = {
      symbol: "BTCUSDT",
      side: "short",
      tradeSource: "BOT_V2",
      closedAt: Date.UTC(2026, 8, 23, 15, 30, 0), // 2026-09-24 00:30 KST
      pnlUsdNet: 40,
      isPositionCycleFinal: true
    };

    assert.equal(kstDayKeyFromMs(t1.closedAt), "2026-09-23");
    assert.equal(kstDayKeyFromMs(t2.closedAt), "2026-09-23");
    assert.equal(kstDayKeyFromMs(t3.closedAt), "2026-09-23");
    assert.equal(kstDayKeyFromMs(t4.closedAt), "2026-09-24");

    const dailySummary = buildPaperDailySummaryFromHistory([t1, t2, t3, t4]);
    assert(dailySummary.daysKst);
    assert.equal(dailySummary.daysKst["2026-09-23"].totalTrades, 3, "2026-09-23 KST has 3 trades");
    assert.equal(dailySummary.daysKst["2026-09-23"].totalPnlUsdNet, 70); // 50 + 30 - 10
    assert.equal(dailySummary.daysKst["2026-09-24"].totalTrades, 1, "2026-09-24 KST has 1 trade");
    assert.equal(dailySummary.daysKst["2026-09-24"].totalPnlUsdNet, 40);
  });
});
