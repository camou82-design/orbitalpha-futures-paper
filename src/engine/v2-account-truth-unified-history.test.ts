import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeClosedHistoryRow,
  normalizePositionsHistoryArray,
  canonicalClosedTradeDedupKey,
  resolveDisplayTradeSourceLabel,
  displayFieldsForClosedRow
} from "../lib/paperClosedHistoryNormalize";
import { reconstructLifecyclesFromFills, type OkxFillsHistoryItem } from "../lib/okxLifecycleReconstruction";
import { buildLedgerPerformanceFromHistory } from "../lib/futuresPaperLedgerStats";

test("Orbitalpha Futures OKX Account Truth Unified History Regression Suite", async (t) => {
  // Case 1: BOT entry -> BOT exit = 자동 (1건)
  await t.test("1. BOT entry -> BOT exit = 자동 with complete truthful fields", () => {
    const fills: OkxFillsHistoryItem[] = [
      {
        instId: "BTC-USDT-SWAP",
        side: "buy",
        fillPx: "65000.0",
        fillSz: "1.0",
        fillTime: 1788500000000,
        ordId: "ord_bot_entry_1",
        clOrdId: "pBTCUSDTbmt001",
        tradeId: "trade_bot_entry_1"
      },
      {
        instId: "BTC-USDT-SWAP",
        side: "sell",
        fillPx: "66000.0",
        fillSz: "1.0",
        fillPnl: "10.0",
        fee: "0.5",
        fillTime: 1788500060000,
        ordId: "ord_bot_exit_1",
        clOrdId: "pBTCUSDTbxt001",
        tradeId: "trade_bot_exit_1"
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    const trade = lifecycles[0];

    assert.equal(trade.symbol, "BTCUSDT");
    assert.equal(trade.side, "long");
    assert.equal(trade.sourceLabel, "자동");
    assert.equal(trade.tradeSource, "BOT_V2");
    assert.equal(trade.entryPrice, 65000);
    assert.equal(trade.closePrice, 66000);
    assert.equal(trade.openedAt, 1788500000000);
    assert.equal(trade.closedAt, 1788500060000);
    assert.equal(trade.fee, 0.5);
    assert.equal(trade.realizedPnl, 10.0);
    assert.equal(trade.pnlNet, 9.5);
    assert.equal(trade.isBotEntry, true);
    assert.equal(trade.isBotExit, true);
    assert.equal(trade.isManualEntry, false);
    assert.equal(trade.isManualExit, false);

    const norm = normalizeClosedHistoryRow(trade);
    assert.equal(norm.sourceLabel, "자동");
    assert.equal(norm.pnlUsdNet, 9.5);
  });

  // Case 2: MANUAL entry -> MANUAL exit = 수동 (1건)
  await t.test("2. MANUAL entry -> MANUAL exit = 수동 with complete truthful fields", () => {
    const fills: OkxFillsHistoryItem[] = [
      {
        instId: "ETH-USDT-SWAP",
        side: "sell",
        fillPx: "3000.0",
        fillSz: "10.0",
        fillTime: 1788500100000,
        ordId: "ord_manual_open_2",
        clOrdId: "",
        tradeId: "trade_manual_open_2"
      },
      {
        instId: "ETH-USDT-SWAP",
        side: "buy",
        fillPx: "2950.0",
        fillSz: "10.0",
        fillPnl: "50.0",
        fee: "1.2",
        fillTime: 1788500200000,
        ordId: "ord_manual_close_2",
        clOrdId: "",
        tradeId: "trade_manual_close_2"
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    const trade = lifecycles[0];

    assert.equal(trade.symbol, "ETHUSDT");
    assert.equal(trade.side, "short");
    assert.equal(trade.sourceLabel, "수동");
    assert.equal(trade.entryPrice, 3000);
    assert.equal(trade.closePrice, 2950);
    assert.equal(trade.openedAt, 1788500100000);
    assert.equal(trade.closedAt, 1788500200000);
    assert.equal(trade.fee, 1.2);
    assert.equal(trade.realizedPnl, 50.0);
    assert.equal(trade.pnlNet, 48.8);
    assert.equal(trade.isBotEntry, false);
    assert.equal(trade.isBotExit, false);
    assert.equal(trade.isManualEntry, true);
    assert.equal(trade.isManualExit, true);

    const norm = normalizeClosedHistoryRow(trade);
    assert.equal(norm.sourceLabel, "수동");
    assert.equal(norm.exitReason, "수동 청산");
  });

  // Case 3: BOT entry -> MANUAL exit = 자동→수동 (1건)
  await t.test("3. BOT entry -> MANUAL exit (takeover/manual close) = 자동→수동", () => {
    const fills: OkxFillsHistoryItem[] = [
      {
        instId: "BTC-USDT-SWAP",
        side: "buy",
        fillPx: "64000.0",
        fillSz: "2.0",
        fillTime: 1788500300000,
        ordId: "ord_bot_in_3",
        clOrdId: "pBTCUSDTbmt003",
        tradeId: "trade_bot_in_3"
      },
      {
        instId: "BTC-USDT-SWAP",
        side: "sell",
        fillPx: "64500.0",
        fillSz: "2.0",
        fillPnl: "10.0",
        fee: "0.8",
        fillTime: 1788500400000,
        ordId: "ord_operator_out_3",
        clOrdId: "", // Operator closed on OKX app without bot clOrdId
        tradeId: "trade_operator_out_3"
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    const trade = lifecycles[0];

    assert.equal(trade.symbol, "BTCUSDT");
    assert.equal(trade.side, "long");
    assert.equal(trade.sourceLabel, "자동→수동");
    assert.equal(trade.entryPrice, 64000);
    assert.equal(trade.closePrice, 64500);
    assert.equal(trade.openedAt, 1788500300000);
    assert.equal(trade.closedAt, 1788500400000);
    assert.equal(trade.isBotEntry, true);
    assert.equal(trade.isManualExit, true);

    const norm = normalizeClosedHistoryRow(trade);
    assert.equal(norm.sourceLabel, "자동→수동");
  });

  // Case 4: MANUAL entry -> BOT exit = 수동→자동 (1건)
  await t.test("4. MANUAL entry -> BOT exit (adopted/engine TP exit) = 수동→자동", () => {
    const fills: OkxFillsHistoryItem[] = [
      {
        instId: "ETH-USDT-SWAP",
        side: "buy",
        fillPx: "3100.0",
        fillSz: "5.0",
        fillTime: 1788500500000,
        ordId: "ord_man_in_4",
        clOrdId: "", // Manual entry
        tradeId: "trade_man_in_4"
      },
      {
        instId: "ETH-USDT-SWAP",
        side: "sell",
        fillPx: "3150.0",
        fillSz: "5.0",
        fillPnl: "25.0",
        fee: "1.0",
        fillTime: 1788500600000,
        ordId: "ord_bot_tp_4",
        clOrdId: "tpposETHUSDT004", // Bot attached TP
        tradeId: "trade_bot_tp_4"
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    const trade = lifecycles[0];

    assert.equal(trade.symbol, "ETHUSDT");
    assert.equal(trade.side, "long");
    assert.equal(trade.sourceLabel, "수동→자동");
    assert.equal(trade.entryPrice, 3100);
    assert.equal(trade.closePrice, 3150);
    assert.equal(trade.openedAt, 1788500500000);
    assert.equal(trade.closedAt, 1788500600000);
    assert.equal(trade.isManualEntry, true);
    assert.equal(trade.isBotExit, true);

    const norm = normalizeClosedHistoryRow(trade);
    assert.equal(norm.sourceLabel, "수동→자동");
  });

  // Case 5: TP1 partial + final exit -> 목록에는 cycle 1건
  await t.test("5. TP1 partial reduction + final close is unified into exactly 1 position cycle", () => {
    const fills: OkxFillsHistoryItem[] = [
      // 1. Entry: 2.0 BTC @ 60,000
      {
        instId: "BTC-USDT-SWAP",
        side: "buy",
        fillPx: "60000.0",
        fillSz: "2.0",
        fillTime: 1788500700000,
        ordId: "ord_entry_5",
        clOrdId: "pBTCUSDTbmt005"
      },
      // 2. Partial TP1: 1.0 BTC @ 61,000 (+10 USD)
      {
        instId: "BTC-USDT-SWAP",
        side: "sell",
        fillPx: "61000.0",
        fillSz: "1.0",
        fillPnl: "10.0",
        fee: "0.4",
        fillTime: 1788500750000,
        ordId: "ord_tp1_5",
        clOrdId: "tpposBTCUSDT005"
      },
      // 3. Final TP2: 1.0 BTC @ 62,000 (+20 USD)
      {
        instId: "BTC-USDT-SWAP",
        side: "sell",
        fillPx: "62000.0",
        fillSz: "1.0",
        fillPnl: "20.0",
        fee: "0.4",
        fillTime: 1788500800000,
        ordId: "ord_tp2_5",
        clOrdId: "tpposBTCUSDT005_2"
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1, "Must produce exactly 1 consolidated lifecycle");
    const cycle = lifecycles[0];

    assert.equal(cycle.symbol, "BTCUSDT");
    assert.equal(cycle.side, "long");
    assert.equal(cycle.entryQty, 2.0);
    assert.equal(cycle.closedQty, 2.0);
    assert.equal(cycle.entryPrice, 60000);
    assert.equal(cycle.closePrice, 61500, "Weighted average exit price of (61000*1 + 62000*1)/2 = 61500");
    assert.equal(cycle.realizedPnl, 30.0, "Sum of fillPnl (10 + 20) = 30");
    assert.equal(cycle.fee, 0.8, "Sum of fees = 0.8");
    assert.equal(cycle.pnlNet, 29.2);
    assert.equal(cycle.openedAt, 1788500700000);
    assert.equal(cycle.closedAt, 1788500800000);
    assert.equal(cycle.sourceLabel, "자동");

    const normalized = normalizePositionsHistoryArray([cycle]);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].closePrice, 61500);
    assert.equal(normalized[0].pnlUsdNet, 29.2);
  });

  // Case 6: 같은 거래가 ledger/account-truth 양쪽에 존재 -> 1건만 출력 (Deduplication)
  await t.test("6. Same trade present in both bot ledger and account-truth is deduplicated to 1 record with truth priority", () => {
    const botLedgerRecord = {
      symbol: "ETHUSDT",
      side: "long",
      openedAt: 1788500900000,
      closedAt: 1788500960000,
      entryPrice: 3200,
      closePrice: 3250,
      pnlUsdNet: 48,
      feeUsd: 2,
      flowId: "eth-flow-dedup-01",
      positionCycleId: "ETHUSDT:long:1788500900000",
      strategy: "TREND",
      strategyVersion: "v2.1",
      sourceSignal: "BREAKOUT_LONG",
      regime: "TREND",
      exitReason: "추세 청산 (TP)",
      tradeSource: "BOT_V2",
      sourceLabel: "자동"
    };

    // OKX Account Truth record from exchange fills for the exact same trade (clOrdId matches flowId)
    const okxTruthRecord = {
      symbol: "ETHUSDT",
      side: "long",
      openedAt: 1788500900100, // OKX fillTime slightly different timestamp
      closedAt: 1788500960200,
      entryPrice: 3200.5, // OKX actual exact fill price
      closePrice: 3249.8,
      sizeUsd: 1600.25,
      pnlUsdNet: 47.65, // OKX actual net PnL after exact taker fees
      pnlUsdGross: 49.3,
      feeUsd: 1.65,
      flowId: "eth-flow-dedup-01",
      positionCycleId: "ETHUSDT:long:1788500900100",
      exchangeEntryOrdIds: ["ex_ord_entry_99"],
      exchangeExitOrdIds: ["ex_ord_exit_99"],
      accountTruth: true,
      tradeSource: "BOT_V2",
      sourceLabel: "자동"
    };

    const combinedList = normalizePositionsHistoryArray([botLedgerRecord, okxTruthRecord]);
    assert.equal(combinedList.length, 1, "Must deduplicate to exactly 1 trade");

    const unified = combinedList[0];
    // Preserves strategy metadata from bot record
    assert.equal(unified.strategy, "TREND");
    assert.equal(unified.strategyVersion, "v2.1");
    assert.equal(unified.sourceSignal, "BREAKOUT_LONG");
    assert.equal(unified.regime, "TREND");
    assert.equal(unified.exitReason, "추세 청산 (TP)");
    assert.equal(unified.sourceLabel, "자동");

    // Preserves authoritative execution truth numbers from OKX record
    assert.equal(unified.entryPrice, 3200.5);
    assert.equal(unified.closePrice, 3249.8);
    assert.equal(unified.feeUsd, 1.65);
    assert.equal(unified.pnlUsdNet, 47.65);
    assert.equal(unified.realizedPnlUsd, 47.65);
  });

  // Case 7: closedAt 최신순 정렬 검증 (DESC)
  await t.test("7. Operations monitor sorting is strictly closedAt DESC", () => {
    const t1 = { symbol: "BTCUSDT", side: "long", closedAt: 1000, pnlUsdNet: 10, sourceLabel: "자동" };
    const t2 = { symbol: "ETHUSDT", side: "short", closedAt: 3000, pnlUsdNet: 20, sourceLabel: "수동" };
    const t3 = { symbol: "BTCUSDT", side: "short", closedAt: 2000, pnlUsdNet: -5, sourceLabel: "자동→수동" };

    const sorted = normalizePositionsHistoryArray([t1, t2, t3]);
    assert.equal(sorted.length, 3);
    assert.equal(sorted[0].closedAt, 3000);
    assert.equal(sorted[0].symbol, "ETHUSDT");
    assert.equal(sorted[1].closedAt, 2000);
    assert.equal(sorted[1].symbol, "BTCUSDT");
    assert.equal(sorted[2].closedAt, 1000);
    assert.equal(sorted[2].symbol, "BTCUSDT");
  });

  // Case 8: explicit pnlNet=0 보존
  await t.test("8. Explicit breakeven pnlNet=0 is faithfully preserved and not lost", () => {
    const breakevenTrade = {
      symbol: "BTCUSDT",
      side: "long",
      openedAt: 1788501000000,
      closedAt: 1788501060000,
      entryPrice: 65000,
      closePrice: 65000,
      pnlUsdGross: 0,
      pnlUsdNet: 0,
      pnlUsd: 0,
      realizedPnlUsd: 0,
      realizedPnlPct: 0,
      feeUsd: 0.5,
      sourceLabel: "자동",
      exitReason: "손익분기 청산 (Breakeven)"
    };

    const norm = normalizeClosedHistoryRow(breakevenTrade);
    assert.strictEqual(norm.pnlUsdNet, 0);
    assert.strictEqual(norm.pnlUsd, 0);
    assert.strictEqual(norm.realizedPnlUsd, 0);
    assert.strictEqual(norm.realizedPnlPct, 0);
    assert.equal(norm.outcomeStatus, "flat");

    const display = displayFieldsForClosedRow(norm);
    assert.equal(display.status, "보합");
  });

  // Case 9: All 4 canonical Korean sourceLabels coverage
  await t.test("9. sourceLabel strictly unifies to 4 canonical Korean labels", () => {
    const rows = [
      { symbol: "BTCUSDT", isBotEntry: true, isBotExit: true, closedAt: 100 },
      { symbol: "BTCUSDT", isManualEntry: true, isManualExit: true, closedAt: 200 },
      { symbol: "BTCUSDT", isBotEntry: true, isManualExit: true, closedAt: 300 },
      { symbol: "BTCUSDT", isManualEntry: true, isBotExit: true, closedAt: 400 },
      { symbol: "BTCUSDT", sourceLabel: "외부포지션 인계", closedAt: 500 },
      { symbol: "BTCUSDT", sourceLabel: "수동관리", closedAt: 600 }
    ];

    const normalized = normalizePositionsHistoryArray(rows);
    const validLabels = new Set(["자동", "수동", "자동→수동", "수동→자동"]);

    for (const r of normalized) {
      assert.ok(validLabels.has(r.sourceLabel), `sourceLabel '${r.sourceLabel}' must be one of 4 canonical labels`);
    }

    assert.equal(resolveDisplayTradeSourceLabel({ isBotEntry: true, isBotExit: true }), "자동");
    assert.equal(resolveDisplayTradeSourceLabel({ isManualEntry: true, isManualExit: true }), "수동");
    assert.equal(resolveDisplayTradeSourceLabel({ isBotEntry: true, isManualExit: true }), "자동→수동");
    assert.equal(resolveDisplayTradeSourceLabel({ isManualEntry: true, isBotExit: true }), "수동→자동");
  });

  // Case 10: Latest 10 completed trades bundle parity & sourceLabel verification
  await t.test("10. Public bundle latest 10 completed trades parity & sourceLabel inspection", () => {
    const sampleCompletedTrades = [
      {
        symbol: "BTCUSDT",
        side: "long",
        openedAt: 1788500000000,
        closedAt: 1788500060000,
        entryPrice: 65000,
        closePrice: 66000,
        sizeUsd: 1300,
        leverage: 2,
        pnlUsdGross: 20,
        feeUsd: 1.0,
        fundingUsd: 0,
        pnlUsdNet: 19.0,
        flowId: "btc-bot-1",
        positionCycleId: "BTCUSDT:long:1788500000000",
        tradeSource: "BOT_V2",
        sourceLabel: "자동",
        exitReason: "전략 자동 종료 (TP)",
        isPositionCycleFinal: true
      },
      {
        symbol: "ETHUSDT",
        side: "short",
        openedAt: 1788500100000,
        closedAt: 1788500200000,
        entryPrice: 3000,
        closePrice: 2950,
        sizeUsd: 1500,
        leverage: 2,
        pnlUsdGross: 25,
        feeUsd: 1.2,
        fundingUsd: 0,
        pnlUsdNet: 23.8,
        tradeSource: "MANUAL_EXTERNAL",
        sourceLabel: "수동",
        exitReason: "수동 청산",
        isPositionCycleFinal: true
      },
      {
        symbol: "BTCUSDT",
        side: "long",
        openedAt: 1788500300000,
        closedAt: 1788500400000,
        entryPrice: 64000,
        closePrice: 64500,
        sizeUsd: 1280,
        leverage: 2,
        pnlUsdGross: 10,
        feeUsd: 0.8,
        fundingUsd: 0,
        pnlUsdNet: 9.2,
        flowId: "btc-hybrid-1",
        tradeSource: "ADOPTED_EXTERNAL",
        sourceLabel: "자동→수동",
        exitReason: "수동 청산 (봇 진입)",
        isPositionCycleFinal: true
      },
      {
        symbol: "ETHUSDT",
        side: "long",
        openedAt: 1788500500000,
        closedAt: 1788500600000,
        entryPrice: 3100,
        closePrice: 3150,
        sizeUsd: 1550,
        leverage: 2,
        pnlUsdGross: 25,
        feeUsd: 1.0,
        fundingUsd: 0,
        pnlUsdNet: 24.0,
        tradeSource: "BOT_V2",
        sourceLabel: "수동→자동",
        exitReason: "보호 주문 체결 (TP/SL)",
        isPositionCycleFinal: true
      },
      {
        symbol: "BTCUSDT",
        side: "short",
        openedAt: 1788500700000,
        closedAt: 1788500800000,
        entryPrice: 66000,
        closePrice: 65200,
        sizeUsd: 1320,
        leverage: 2,
        pnlUsdGross: 16,
        feeUsd: 0.9,
        fundingUsd: 0,
        pnlUsdNet: 15.1,
        flowId: "btc-bot-2",
        tradeSource: "BOT_V2",
        sourceLabel: "자동",
        exitReason: "전략 자동 종료 (Trailing Stop)",
        isPositionCycleFinal: true
      },
      {
        symbol: "ETHUSDT",
        side: "short",
        openedAt: 1788500850000,
        closedAt: 1788500950000,
        entryPrice: 3250,
        closePrice: 3200,
        sizeUsd: 1625,
        leverage: 2,
        pnlUsdGross: 25,
        feeUsd: 1.1,
        fundingUsd: 0,
        pnlUsdNet: 23.9,
        flowId: "eth-bot-2",
        tradeSource: "BOT_V2",
        sourceLabel: "자동",
        exitReason: "전략 자동 종료 (TP)",
        isPositionCycleFinal: true
      },
      {
        symbol: "BTCUSDT",
        side: "long",
        openedAt: 1788501000000,
        closedAt: 1788501060000,
        entryPrice: 65000,
        closePrice: 65000,
        sizeUsd: 1300,
        leverage: 2,
        pnlUsdGross: 0,
        feeUsd: 0.5,
        fundingUsd: 0,
        pnlUsdNet: 0,
        flowId: "btc-breakeven",
        tradeSource: "BOT_V2",
        sourceLabel: "자동",
        exitReason: "손익분기 청산 (Breakeven)",
        isPositionCycleFinal: true
      },
      {
        symbol: "ETHUSDT",
        side: "long",
        openedAt: 1788501100000,
        closedAt: 1788501200000,
        entryPrice: 3300,
        closePrice: 3280,
        sizeUsd: 1650,
        leverage: 2,
        pnlUsdGross: -10,
        feeUsd: 1.0,
        fundingUsd: 0,
        pnlUsdNet: -11.0,
        tradeSource: "MANUAL_EXTERNAL",
        sourceLabel: "수동",
        exitReason: "수동 손절",
        isPositionCycleFinal: true
      },
      {
        symbol: "BTCUSDT",
        side: "short",
        openedAt: 1788501250000,
        closedAt: 1788501350000,
        entryPrice: 65500,
        closePrice: 65100,
        sizeUsd: 1310,
        leverage: 2,
        pnlUsdGross: 8,
        feeUsd: 0.8,
        fundingUsd: 0,
        pnlUsdNet: 7.2,
        flowId: "btc-bot-3",
        tradeSource: "BOT_V2",
        sourceLabel: "자동",
        exitReason: "전략 자동 종료 (TP1)",
        isPositionCycleFinal: true
      },
      {
        symbol: "ETHUSDT",
        side: "short",
        openedAt: 1788501400000,
        closedAt: 1788501500000,
        entryPrice: 3200,
        closePrice: 3180,
        sizeUsd: 1600,
        leverage: 2,
        pnlUsdGross: 10,
        feeUsd: 0.9,
        fundingUsd: 0,
        pnlUsdNet: 9.1,
        flowId: "eth-hybrid-2",
        tradeSource: "ADOPTED_EXTERNAL",
        sourceLabel: "자동→수동",
        exitReason: "수동 부분청산 후 잔여 청산",
        isPositionCycleFinal: true
      }
    ];

    const normalized = normalizePositionsHistoryArray(sampleCompletedTrades);
    assert.equal(normalized.length, 10);

    // Verify sort order is strictly closedAt DESC
    for (let i = 0; i < normalized.length - 1; i++) {
      assert.ok(
        (normalized[i].closedAt || 0) >= (normalized[i + 1].closedAt || 0),
        `Row ${i} closedAt (${normalized[i].closedAt}) must be >= Row ${i + 1} closedAt (${normalized[i + 1].closedAt})`
      );
    }

    console.log("\n=== LATEST 10 COMPLETED TRADES INSPECTION ===");
    normalized.forEach((t, idx) => {
      console.log(
        `#${idx + 1}: [${t.sourceLabel}] ${t.symbol} ${(t.side || "").toUpperCase()} | Entry: ${t.entryPrice} -> Close: ${t.closePrice} | NetPnL: $${t.pnlUsdNet} (Fee: $${t.feeUsd}) | ClosedAt: ${t.closedAt} | Reason: ${t.exitReason}`
      );
    });
  });
});
