import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalClosedTradeDedupKey,
  deduplicateClosedHistoryRows,
  normalizePositionsHistoryArray,
  type NormalizedPaperClosedRow
} from "../lib/paperClosedHistoryNormalize";
import { buildLedgerPerformanceFromHistory } from "../lib/futuresPaperLedgerStats";

test("PHASE 13A: Closed Trade Dedup Identity Suite", async (t) => {
  // Case 1: 서로 다른 시각의 동일 symbol/side 거래 (ETH short A, B)
  await t.test("1. Same symbol and side at different times are preserved as separate trades (COUNT = 2)", () => {
    const tradeA = {
      symbol: "ETHUSDT",
      side: "short",
      openedAt: 1700000000000, // 10:00
      closedAt: 1700000600000, // 10:10
      entryPrice: 3000,
      closePrice: 2950,
      pnlUsdNet: 50,
      feeUsd: 1,
      tradeSource: "BOT_V2"
    };

    const tradeB = {
      symbol: "ETHUSDT",
      side: "short",
      openedAt: 1700003600000, // 11:00
      closedAt: 1700004200000, // 11:10
      entryPrice: 2980,
      closePrice: 2930,
      pnlUsdNet: 50,
      feeUsd: 1,
      tradeSource: "BOT_V2"
    };

    const keyA = canonicalClosedTradeDedupKey(tradeA);
    const keyB = canonicalClosedTradeDedupKey(tradeB);

    assert.notEqual(keyA, keyB, "Different openedAt/closedAt must yield different dedup keys");

    const normalized = normalizePositionsHistoryArray([tradeA, tradeB]);
    assert.equal(normalized.length, 2, "DISPLAY COUNT must be 2, not merged");
    assert.equal(normalized[0].openedAt, 1700000000000);
    assert.equal(normalized[1].openedAt, 1700003600000);

    const perf = buildLedgerPerformanceFromHistory([tradeA, tradeB]);
    assert.equal(perf.all.totalTrades, 2, "Both trades must be counted in summary");
    assert.equal(perf.all.totalPnlUsdNet, 100);
  });

  // Case 2: 동일 lifecycle이 bot history + exchange history에 동시 존재
  await t.test("2. Exact same lifecycle appearing in bot history and exchange history is merged (COUNT = 1)", () => {
    const openedAt = 1700000000000;
    const closedAt = 1700000600000;

    // Bot record with strategy metadata
    const botRecord = {
      symbol: "BTCUSDT",
      side: "long",
      openedAt,
      closedAt,
      entryPrice: 65000,
      closePrice: 66000,
      pnlUsdNet: 100,
      feeUsd: 2,
      flowId: "btc-flow-001",
      positionCycleId: "BTCUSDT:long:1700000000000",
      strategy: "RANGE",
      source: "v2"
    };

    // Exchange-derived record of the same trade without flowId
    const exchangeRecord = {
      symbol: "BTCUSDT",
      side: "long",
      openedAt,
      closedAt,
      entryPrice: 65000,
      closePrice: 66000,
      pnlUsdNet: 100,
      feeUsd: 2,
      positionCycleId: "BTCUSDT:long:1700000000000",
      source: "exchange"
    };

    const keyBot = canonicalClosedTradeDedupKey(botRecord);
    const keyEx = canonicalClosedTradeDedupKey(exchangeRecord);
    assert.equal(keyBot, keyEx, "Same positionCycleId must yield identical dedup key");

    const normalized = normalizePositionsHistoryArray([botRecord, exchangeRecord]);
    assert.equal(normalized.length, 1, "DISPLAY COUNT must be 1 (merged)");
    assert.equal(normalized[0].strategy, "RANGE", "Strategy metadata preserved from richer record");
  });

  // Case 3: 동일 parent lifecycle의 TP1 + TP2 child execution
  await t.test("3. Child executions of same parent lifecycle: 1 lifecycle count, legs distinguished", () => {
    const openedAt = 1700000000000;
    const cycleId = "ETHUSDT:short:1700000000000";

    const leg1 = {
      symbol: "ETHUSDT",
      side: "short",
      openedAt,
      closedAt: 1700000300000,
      entryPrice: 3000,
      closePrice: 2950,
      pnlUsdNet: 25,
      feeUsd: 0.5,
      positionCycleId: cycleId,
      isChildExecution: true,
      closeReason: "partial_exit_1"
    };

    const leg2Final = {
      symbol: "ETHUSDT",
      side: "short",
      openedAt,
      closedAt: 1700000600000,
      entryPrice: 3000,
      closePrice: 2900,
      pnlUsdNet: 50,
      feeUsd: 1.0,
      positionCycleId: cycleId,
      isPositionCycleFinal: true,
      closeReason: "take_profit"
    };

    // Summary test: child execution leg1 is not double-counted as separate trade
    const perf = buildLedgerPerformanceFromHistory([leg1, leg2Final]);
    assert.equal(perf.all.totalTrades, 1, "Child execution must not increase trade count");
    assert.equal(perf.all.totalPnlUsdNet, 50, "Only final cycle row pnl counted in summary");

    // Display dedup test
    const key1 = canonicalClosedTradeDedupKey(leg1);
    const key2 = canonicalClosedTradeDedupKey(leg2Final);
    assert.equal(key1, key2, "Child legs sharing positionCycleId map to same cycle identity");
  });

  // Case 4: 완전 종료 후 동일 방향 재진입 (Re-entry after full close)
  await t.test("4. Re-entry after full close of same symbol/side is preserved as 2 lifecycles", () => {
    const cycle1 = {
      symbol: "ETHUSDT",
      side: "short",
      openedAt: 1700000000000,
      closedAt: 1700000600000,
      entryPrice: 3000,
      closePrice: 2950,
      pnlUsdNet: 50,
      feeUsd: 1,
      positionCycleId: "ETHUSDT:short:1700000000000",
      isPositionCycleFinal: true
    };

    const cycle2 = {
      symbol: "ETHUSDT",
      side: "short",
      openedAt: 1700003600000,
      closedAt: 1700004200000,
      entryPrice: 2980,
      closePrice: 2920,
      pnlUsdNet: 60,
      feeUsd: 1,
      positionCycleId: "ETHUSDT:short:1700003600000",
      isPositionCycleFinal: true
    };

    const normalized = normalizePositionsHistoryArray([cycle1, cycle2]);
    assert.equal(normalized.length, 2, "Must preserve both lifecycles after full close and re-entry");

    const perf = buildLedgerPerformanceFromHistory([cycle1, cycle2]);
    assert.equal(perf.all.totalTrades, 2, "Summary must record 2 completed cycles");
    assert.equal(perf.all.totalPnlUsdNet, 110);
  });

  // Case 5: flowId 없는 manual 거래 2건 (시간이 다름)
  await t.test("5. Manual trades without flowId with different times are both displayed (COUNT = 2)", () => {
    const manual1 = {
      symbol: "BTCUSDT",
      side: "long",
      source: "manual",
      authority: "MANUAL",
      openedAt: 1700010000000,
      closedAt: 1700010600000,
      entryPrice: 65000,
      closePrice: 65500,
      pnlUsdNet: 50,
      feeUsd: 2
    };

    const manual2 = {
      symbol: "BTCUSDT",
      side: "long",
      source: "manual",
      authority: "MANUAL",
      openedAt: 1700020000000,
      closedAt: 1700020600000,
      entryPrice: 65600,
      closePrice: 66200,
      pnlUsdNet: 60,
      feeUsd: 2
    };

    const key1 = canonicalClosedTradeDedupKey(manual1);
    const key2 = canonicalClosedTradeDedupKey(manual2);
    assert.notEqual(key1, key2, "Fallback composite key must distinguish trades by time and price");

    const normalized = normalizePositionsHistoryArray([manual1, manual2]);
    assert.equal(normalized.length, 2, "Both manual trades must be displayed");

    const perf = buildLedgerPerformanceFromHistory([manual1, manual2]);
    assert.equal(perf.all.totalTrades, 2, "Both manual trades included in account summary");
    assert.equal(perf.all.totalPnlUsdNet, 110);
  });

  // Case 6: Same symbol, opposite side
  await t.test("6. Same symbol with opposite sides are displayed separately", () => {
    const longTrade = {
      symbol: "BTCUSDT",
      side: "long",
      openedAt: 1700000000000,
      closedAt: 1700000600000,
      entryPrice: 65000,
      closePrice: 65500,
      pnlUsdNet: 50,
      feeUsd: 2
    };

    const shortTrade = {
      symbol: "BTCUSDT",
      side: "short",
      openedAt: 1700000000000,
      closedAt: 1700000600000,
      entryPrice: 65500,
      closePrice: 65000,
      pnlUsdNet: 50,
      feeUsd: 2
    };

    const keyLong = canonicalClosedTradeDedupKey(longTrade);
    const keyShort = canonicalClosedTradeDedupKey(shortTrade);
    assert.notEqual(keyLong, keyShort, "Opposite sides must yield different dedup keys");

    const normalized = normalizePositionsHistoryArray([longTrade, shortTrade]);
    assert.equal(normalized.length, 2, "Both long and short trades must be displayed");
  });
});
