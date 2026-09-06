import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  reconstructLifecyclesFromFills,
  type OkxFillsHistoryItem
} from "../lib/okxLifecycleReconstruction";
import {
  canonicalClosedTradeDedupKey,
  normalizePositionsHistoryArray
} from "../lib/paperClosedHistoryNormalize";
import {
  saveOkxAccountClosedTrades,
  readOkxAccountClosedTrades,
  saveOkxAccountTruthCursor,
  readOkxAccountTruthCursor,
  type OkxAccountClosedTradeRecord
} from "../storage/account-truth-store";
import { isStrategyStatsRow, isAccountStatsRow } from "../engine-v2/lifecycle/completed-trade";
import { buildPaperWindowSummaryFromHistory } from "../storage/paper-summary";

test("PHASE 13D: OKX Account Truth Lifecycle Ingestion & Dedup Forensic Suite", async (t) => {
  // 1. manual long open -> manual full close = 1 lifecycle
  await t.test("1. manual long open -> manual full close = 1 lifecycle", () => {
    const fills: OkxFillsHistoryItem[] = [
      {
        instId: "BTC-USDT-SWAP",
        side: "buy",
        fillPx: "80000",
        fillSz: "1.0",
        fillTime: 1788500000000,
        ordId: "ord_m_buy_1",
        clOrdId: ""
      },
      {
        instId: "BTC-USDT-SWAP",
        side: "sell",
        fillPx: "81000",
        fillSz: "1.0",
        fillPnl: "10.0",
        fee: "0.5",
        fillTime: 1788500060000,
        ordId: "ord_m_sell_1",
        clOrdId: ""
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    assert.equal(lifecycles[0].symbol, "BTCUSDT");
    assert.equal(lifecycles[0].side, "long");
    assert.equal(lifecycles[0].entryPrice, 80000);
    assert.equal(lifecycles[0].closePrice, 81000);
    assert.equal(lifecycles[0].entryQty, 1.0);
    assert.equal(lifecycles[0].closedQty, 1.0);
    assert.equal(lifecycles[0].sourceLabel, "수동");
    assert.equal(lifecycles[0].isManualEntry, true);
    assert.equal(lifecycles[0].isManualExit, true);
  });

  // 2. manual short open -> manual full close = 1 lifecycle
  await t.test("2. manual short open -> manual full close = 1 lifecycle", () => {
    const fills: OkxFillsHistoryItem[] = [
      {
        instId: "ETH-USDT-SWAP",
        side: "sell",
        fillPx: "2500",
        fillSz: "5.0",
        fillTime: 1788500100000,
        ordId: "ord_m_sell_2",
        clOrdId: ""
      },
      {
        instId: "ETH-USDT-SWAP",
        side: "buy",
        fillPx: "2450",
        fillSz: "5.0",
        fillPnl: "25.0",
        fee: "1.0",
        fillTime: 1788500200000,
        ordId: "ord_m_buy_2",
        clOrdId: ""
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    assert.equal(lifecycles[0].symbol, "ETHUSDT");
    assert.equal(lifecycles[0].side, "short");
    assert.equal(lifecycles[0].entryPrice, 2500);
    assert.equal(lifecycles[0].closePrice, 2450);
    assert.equal(lifecycles[0].sourceLabel, "수동");
  });

  // 3. bot entry -> manual exit = 자동→수동
  await t.test("3. bot entry -> manual exit = 자동→수동", () => {
    const fills: OkxFillsHistoryItem[] = [
      {
        instId: "BTC-USDT-SWAP",
        side: "buy",
        fillPx: "80000",
        fillSz: "2.0",
        fillTime: 1788500300000,
        ordId: "ord_bot_entry",
        clOrdId: "pBTCUSDTbmt001"
      },
      {
        instId: "BTC-USDT-SWAP",
        side: "sell",
        fillPx: "80500",
        fillSz: "2.0",
        fillTime: 1788500400000,
        ordId: "ord_manual_exit",
        clOrdId: ""
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    assert.equal(lifecycles[0].sourceLabel, "자동→수동");
    assert.equal(lifecycles[0].isBotEntry, true);
    assert.equal(lifecycles[0].isManualExit, true);
  });

  // 4. manual entry -> bot TP = 수동→자동
  await t.test("4. manual entry -> bot TP = 수동→자동", () => {
    const fills: OkxFillsHistoryItem[] = [
      {
        instId: "ETH-USDT-SWAP",
        side: "buy",
        fillPx: "2400",
        fillSz: "10.0",
        fillTime: 1788500500000,
        ordId: "ord_manual_entry",
        clOrdId: ""
      },
      {
        instId: "ETH-USDT-SWAP",
        side: "sell",
        fillPx: "2450",
        fillSz: "10.0",
        fillTime: 1788500600000,
        ordId: "ord_bot_tp",
        clOrdId: "pETHUSDTsmt002"
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    assert.equal(lifecycles[0].sourceLabel, "수동→자동");
    assert.equal(lifecycles[0].isManualEntry, true);
    assert.equal(lifecycles[0].isBotExit, true);
  });

  // 5. entry + TP1 partial + TP2 full = 1 lifecycle
  await t.test("5. entry + TP1 partial + TP2 full = 1 lifecycle", () => {
    const fills: OkxFillsHistoryItem[] = [
      {
        instId: "BTC-USDT-SWAP",
        side: "buy",
        fillPx: "80000",
        fillSz: "1.0",
        fillTime: 1788501000000,
        ordId: "ord_entry",
        clOrdId: "pBTCUSDTbmt003"
      },
      {
        instId: "BTC-USDT-SWAP",
        side: "sell",
        fillPx: "80500",
        fillSz: "0.5",
        fillPnl: "2.5",
        fillTime: 1788501100000,
        ordId: "ord_tp1",
        clOrdId: "pBTCUSDTsmt003_tp1"
      },
      {
        instId: "BTC-USDT-SWAP",
        side: "sell",
        fillPx: "81000",
        fillSz: "0.5",
        fillPnl: "5.0",
        fillTime: 1788501200000,
        ordId: "ord_tp2",
        clOrdId: "pBTCUSDTsmt003_tp2"
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    assert.equal(lifecycles[0].entryQty, 1.0);
    assert.equal(lifecycles[0].closedQty, 1.0);
    assert.equal(lifecycles[0].closePrice, 80750); // weighted (80500*0.5 + 81000*0.5)/1.0
    assert.equal(lifecycles[0].realizedPnl, 7.5);
    assert.equal(lifecycles[0].sourceLabel, "자동");
  });

  // 6. entry + partial manual reduce + final SL = 1 lifecycle
  await t.test("6. entry + partial manual reduce + final SL = 1 lifecycle", () => {
    const fills: OkxFillsHistoryItem[] = [
      {
        instId: "ETH-USDT-SWAP",
        side: "buy",
        fillPx: "2500",
        fillSz: "10.0",
        fillTime: 1788502000000,
        ordId: "ord_entry",
        clOrdId: "pETHUSDTbmt004"
      },
      {
        instId: "ETH-USDT-SWAP",
        side: "sell",
        fillPx: "2490",
        fillSz: "4.0",
        fillPnl: "-4.0",
        fillTime: 1788502100000,
        ordId: "ord_manual_reduce",
        clOrdId: ""
      },
      {
        instId: "ETH-USDT-SWAP",
        side: "sell",
        fillPx: "2480",
        fillSz: "6.0",
        fillPnl: "-12.0",
        fillTime: 1788502200000,
        ordId: "ord_sl_algo",
        clOrdId: "O3896582046373695488"
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    assert.equal(lifecycles[0].entryQty, 10.0);
    assert.equal(lifecycles[0].closedQty, 10.0);
    assert.equal(lifecycles[0].realizedPnl, -16.0);
    assert.equal(lifecycles[0].exitReason, "보호 주문 체결 (TP/SL)");
  });

  // 7. same BTC long full close 후 재진입 = 2 lifecycles
  await t.test("7. same BTC long full close 후 재진입 = 2 lifecycles", () => {
    const fills: OkxFillsHistoryItem[] = [
      // Trade 1
      {
        instId: "BTC-USDT-SWAP",
        side: "buy",
        fillPx: "80000",
        fillSz: "1.0",
        fillTime: 1788503000000,
        ordId: "ord_1_in",
        clOrdId: "pBTCUSDTbmt005"
      },
      {
        instId: "BTC-USDT-SWAP",
        side: "sell",
        fillPx: "80500",
        fillSz: "1.0",
        fillTime: 1788503100000,
        ordId: "ord_1_out",
        clOrdId: "pBTCUSDTsmt005"
      },
      // Trade 2 (10 min later)
      {
        instId: "BTC-USDT-SWAP",
        side: "buy",
        fillPx: "80200",
        fillSz: "1.0",
        fillTime: 1788503700000,
        ordId: "ord_2_in",
        clOrdId: "pBTCUSDTbmt006"
      },
      {
        instId: "BTC-USDT-SWAP",
        side: "sell",
        fillPx: "80800",
        fillSz: "1.0",
        fillTime: 1788503800000,
        ordId: "ord_2_out",
        clOrdId: "pBTCUSDTsmt006"
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 2);
    assert.notEqual(lifecycles[0].openedAt, lifecycles[1].openedAt);
  });

  // 8. BTC/ETH interleaved fills 서로 섞이지 않음
  await t.test("8. BTC/ETH interleaved fills 서로 섞이지 않음", () => {
    const fills: OkxFillsHistoryItem[] = [
      { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "80000", fillSz: "1.0", fillTime: 100, ordId: "b1", clOrdId: "" },
      { instId: "ETH-USDT-SWAP", side: "buy", fillPx: "2500", fillSz: "5.0", fillTime: 110, ordId: "e1", clOrdId: "" },
      { instId: "BTC-USDT-SWAP", side: "sell", fillPx: "81000", fillSz: "1.0", fillTime: 120, ordId: "b2", clOrdId: "" },
      { instId: "ETH-USDT-SWAP", side: "sell", fillPx: "2550", fillSz: "5.0", fillTime: 130, ordId: "e2", clOrdId: "" }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 2);
    const btc = lifecycles.find((l) => l.symbol === "BTCUSDT");
    const eth = lifecycles.find((l) => l.symbol === "ETHUSDT");
    assert.ok(btc);
    assert.ok(eth);
    assert.equal(btc.entryQty, 1.0);
    assert.equal(eth.entryQty, 5.0);
  });

  // 9. bot history + OKX same lifecycle = 1건 dedup
  await t.test("9. bot history + OKX same lifecycle = 1건 dedup", () => {
    const botRow = {
      symbol: "ETHUSDT",
      side: "long",
      openedAt: 1788630406414,
      closedAt: 1788632942837,
      entryPrice: 2477.02,
      closePrice: 2476.43,
      sizeUsd: 636.46,
      realizedPnlUsd: -0.91,
      feeUsd: 0.76,
      strategyVersion: "paper-v2",
      regime: "RANGE",
      flowId: "ETHUSDT:long:1788630406414",
      positionCycleId: "ETHUSDT:long:1788630406414",
      exchangeOrdId: "3896609289912979456",
      exitOrdId: "3896694487434399744",
      sourceLabel: "자동",
      tradeSource: "BOT_V2",
      isPositionCycleFinal: true
    };

    const okxRow: OkxAccountClosedTradeRecord = {
      symbol: "ETHUSDT",
      side: "long",
      openedAt: 1788630406414,
      closedAt: 1788632942837,
      entryPrice: 2477.02,
      closePrice: 2476.43,
      entryQty: 2.57,
      closedQty: 2.57,
      sizeUsd: 636.46,
      realizedPnl: -0.15163,
      realizedPnlPct: -0.000238,
      fee: 0.763,
      pnlNet: -0.914,
      holdingMs: 2536423,
      source: "BOT_V2",
      entrySource: "BOT",
      exitSource: "BOT",
      sourceLabel: "자동",
      exitReason: "전략 자동 종료",
      exitType: "EXIT_V2_AUTHORITY",
      exchangeEntryOrdIds: ["3896609289912979456"],
      exchangeExitOrdIds: ["3896694487434399744"],
      exchangeFillIds: ["fill_1"],
      positionCycleId: "ETHUSDT:long:1788630406414",
      lifecycleId: "okx_life:ETHUSDT:long:1788630406414:1788632942837",
      flowId: "ETHUSDT:long:1788630406414",
      isManualEntry: false,
      isManualExit: false,
      isBotEntry: true,
      isBotExit: true,
      isAdoptedExternal: false,
      isOperatorManaged: false,
      isChildExecution: false,
      isPositionCycleFinal: true,
      accountTruth: true,
      tradeSource: "BOT_V2"
    };

    const merged = normalizePositionsHistoryArray([botRow, okxRow]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].flowId, "ETHUSDT:long:1788630406414");
    assert.equal(merged[0].strategyVersion, "paper-v2");
    assert.equal(merged[0].sourceLabel, "자동");
  });

  // 10. different same-symbol-side lifecycle = 각각 보존
  await t.test("10. different same-symbol-side lifecycle = 각각 보존", () => {
    const tradeA = {
      symbol: "BTCUSDT",
      side: "long",
      openedAt: 1000,
      closedAt: 2000,
      entryPrice: 80000,
      closePrice: 81000,
      sizeUsd: 800,
      exchangeOrdId: "ord_A_in",
      exitOrdId: "ord_A_out",
      isPositionCycleFinal: true
    };

    const tradeB = {
      symbol: "BTCUSDT",
      side: "long",
      openedAt: 5000,
      closedAt: 6000,
      entryPrice: 81000,
      closePrice: 82000,
      sizeUsd: 810,
      exchangeOrdId: "ord_B_in",
      exitOrdId: "ord_B_out",
      isPositionCycleFinal: true
    };

    const result = normalizePositionsHistoryArray([tradeA, tradeB]);
    assert.equal(result.length, 2);
  });

  // 11. manual-only trade appears in account history
  await t.test("11. manual-only trade appears in account history", () => {
    const manualTrade: OkxAccountClosedTradeRecord = {
      symbol: "BTCUSDT",
      side: "short",
      openedAt: 1788650000000,
      closedAt: 1788651000000,
      entryPrice: 80000,
      closePrice: 79500,
      entryQty: 1.0,
      closedQty: 1.0,
      sizeUsd: 800,
      realizedPnl: 5.0,
      realizedPnlPct: 0.00625,
      fee: 0.5,
      pnlNet: 4.5,
      holdingMs: 1000000,
      source: "MANUAL_EXTERNAL",
      entrySource: "MANUAL",
      exitSource: "MANUAL",
      sourceLabel: "수동",
      exitReason: "수동 청산",
      exitType: "EXIT_MANUAL",
      exchangeEntryOrdIds: ["ord_m1"],
      exchangeExitOrdIds: ["ord_m2"],
      exchangeFillIds: ["f1", "f2"],
      lifecycleId: "life_manual_1",
      isManualEntry: true,
      isManualExit: true,
      isBotEntry: false,
      isBotExit: false,
      isAdoptedExternal: false,
      isOperatorManaged: true,
      isChildExecution: false,
      isPositionCycleFinal: true,
      accountTruth: true,
      tradeSource: "MANUAL_EXTERNAL"
    };

    const normalized = normalizePositionsHistoryArray([manualTrade]);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].sourceLabel, "수동");
  });

  // 12. manual-only trade does NOT enter strategyWindows
  await t.test("12. manual-only trade does NOT enter strategyWindows", () => {
    const manualTrade = {
      symbol: "BTCUSDT",
      side: "short",
      openedAt: 1788650000000,
      closedAt: 1788651000000,
      tradeSource: "MANUAL_EXTERNAL",
      sourceLabel: "수동",
      isManualEntry: true,
      isPositionCycleFinal: true
    };

    assert.equal(isStrategyStatsRow(manualTrade), false);
  });

  // 13. manual-only trade DOES enter accountWindows
  await t.test("13. manual-only trade DOES enter accountWindows", () => {
    const manualTrade = {
      symbol: "BTCUSDT",
      side: "short",
      openedAt: 1788650000000,
      closedAt: 1788651000000,
      tradeSource: "MANUAL_EXTERNAL",
      sourceLabel: "수동",
      isManualEntry: true,
      isPositionCycleFinal: true
    };

    assert.equal(isAccountStatsRow(manualTrade), true);

    const botTrade = {
      symbol: "ETHUSDT",
      side: "long",
      openedAt: 1788650000000,
      closedAt: 1788651000000,
      tradeSource: "BOT_V2",
      sourceLabel: "자동",
      isPositionCycleFinal: true,
      pnlUsdNet: 10,
      pnlUsdGross: 11,
      feeUsd: 1
    };

    const summary = buildPaperWindowSummaryFromHistory(
      [
        { ...manualTrade, pnlUsdNet: 5, pnlUsdGross: 6, feeUsd: 1 },
        botTrade
      ],
      1788652000000
    );

    // strategyWindows has 1 trade (bot only)
    assert.equal(summary.strategyWindows.all.totalTrades, 1);
    assert.equal(summary.strategyWindows.all.totalPnlUsdNet, 10);

    // accountWindows has 2 trades (bot + manual)
    assert.equal(summary.accountWindows.all.totalTrades, 2);
    assert.equal(summary.accountWindows.all.totalPnlUsdNet, 15);
  });

  // 14. partial fill legs do not inflate trade count
  await t.test("14. partial fill legs do not inflate trade count", () => {
    const fills: OkxFillsHistoryItem[] = [
      { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "80000", fillSz: "0.25", fillTime: 100, ordId: "o1", clOrdId: "" },
      { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "80000", fillSz: "0.25", fillTime: 101, ordId: "o1", clOrdId: "" },
      { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "80000", fillSz: "0.50", fillTime: 102, ordId: "o1", clOrdId: "" },
      { instId: "BTC-USDT-SWAP", side: "sell", fillPx: "80500", fillSz: "0.50", fillTime: 200, ordId: "o2", clOrdId: "" },
      { instId: "BTC-USDT-SWAP", side: "sell", fillPx: "80500", fillSz: "0.50", fillTime: 201, ordId: "o2", clOrdId: "" }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    assert.equal(lifecycles[0].entryQty, 1.0);
    assert.equal(lifecycles[0].closedQty, 1.0);
  });

  // 15. protective algo trigger exit included
  await t.test("15. protective algo trigger exit included", () => {
    const fills: OkxFillsHistoryItem[] = [
      { instId: "ETH-USDT-SWAP", side: "buy", fillPx: "2500", fillSz: "5.0", fillTime: 100, ordId: "o_in", clOrdId: "pETHUSDTbmt007" },
      { instId: "ETH-USDT-SWAP", side: "sell", fillPx: "2480", fillSz: "5.0", fillTime: 200, ordId: "o_algo", clOrdId: "O3896582046373695488" }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    assert.equal(lifecycles[0].sourceLabel, "자동");
    assert.equal(lifecycles[0].exitReason, "보호 주문 체결 (TP/SL)");
  });

  // 16. zero-position sign reversal splits lifecycles correctly
  await t.test("16. zero-position sign reversal splits lifecycles correctly", () => {
    const fills: OkxFillsHistoryItem[] = [
      // Long 1.0
      { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "80000", fillSz: "1.0", fillTime: 100, ordId: "b1", clOrdId: "" },
      // Reversal: Sell 1.5 -> closes 1.0 Long, opens 0.5 Short
      { instId: "BTC-USDT-SWAP", side: "sell", fillPx: "80500", fillSz: "1.5", fillTime: 200, ordId: "s1", clOrdId: "" },
      // Close Short: Buy 0.5
      { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "80200", fillSz: "0.5", fillTime: 300, ordId: "b2", clOrdId: "" }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 2);

    // Lifecycle 1: Long 1.0
    const longCycle = lifecycles.find((l) => l.side === "long");
    assert.ok(longCycle);
    assert.equal(longCycle.entryQty, 1.0);
    assert.equal(longCycle.closedQty, 1.0);

    // Lifecycle 2: Short 0.5
    const shortCycle = lifecycles.find((l) => l.side === "short");
    assert.ok(shortCycle);
    assert.equal(shortCycle.entryQty, 0.5);
    assert.equal(shortCycle.closedQty, 0.5);
  });

  // 17. restart / repeated ingest idempotent
  await t.test("17. restart / repeated ingest idempotent", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-truth-test-"));
    try {
      const fills: OkxFillsHistoryItem[] = [
        { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "80000", fillSz: "1.0", fillTime: 100, ordId: "b1", clOrdId: "" },
        { instId: "BTC-USDT-SWAP", side: "sell", fillPx: "80500", fillSz: "1.0", fillTime: 200, ordId: "s1", clOrdId: "" }
      ];

      const lifecycles1 = reconstructLifecyclesFromFills(fills);
      await saveOkxAccountClosedTrades(tmpDir, lifecycles1);
      const read1 = await readOkxAccountClosedTrades(tmpDir);
      assert.equal(read1.length, 1);

      // Repeat ingest of exact same fills
      const lifecycles2 = reconstructLifecyclesFromFills(fills);
      const map = new Map<string, OkxAccountClosedTradeRecord>();
      for (const t of [...read1, ...lifecycles2]) {
        map.set(t.lifecycleId, t);
      }
      await saveOkxAccountClosedTrades(tmpDir, Array.from(map.values()));

      const read2 = await readOkxAccountClosedTrades(tmpDir);
      assert.equal(read2.length, 1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 18. 7-day backfill + incremental ingest duplicate 없음
  await t.test("18. 7-day backfill + incremental ingest duplicate 없음", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-truth-test-"));
    try {
      // Step 1: Initial 7-day backfill (trades at t=100..200 and t=300..400)
      const fillsBatch1: OkxFillsHistoryItem[] = [
        { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "80000", fillSz: "1.0", fillTime: 100, ordId: "b1", clOrdId: "" },
        { instId: "BTC-USDT-SWAP", side: "sell", fillPx: "80500", fillSz: "1.0", fillTime: 200, ordId: "s1", clOrdId: "" },
        { instId: "ETH-USDT-SWAP", side: "buy", fillPx: "2500", fillSz: "5.0", fillTime: 300, ordId: "e1", clOrdId: "" },
        { instId: "ETH-USDT-SWAP", side: "sell", fillPx: "2550", fillSz: "5.0", fillTime: 400, ordId: "e2", clOrdId: "" }
      ];

      const initialLifecycles = reconstructLifecyclesFromFills(fillsBatch1);
      await saveOkxAccountClosedTrades(tmpDir, initialLifecycles);
      await saveOkxAccountTruthCursor(tmpDir, { lastFillTime: 400, syncedAt: Date.now() });

      // Step 2: Incremental ingest with overlapping fill at t=400 plus new fill at t=500..600
      const fillsBatch2: OkxFillsHistoryItem[] = [
        { instId: "ETH-USDT-SWAP", side: "sell", fillPx: "2550", fillSz: "5.0", fillTime: 400, ordId: "e2", clOrdId: "" },
        { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "81000", fillSz: "1.0", fillTime: 500, ordId: "b3", clOrdId: "" },
        { instId: "BTC-USDT-SWAP", side: "sell", fillPx: "81500", fillSz: "1.0", fillTime: 600, ordId: "s3", clOrdId: "" }
      ];

      const existing = await readOkxAccountClosedTrades(tmpDir);
      const incrementalLifecycles = reconstructLifecyclesFromFills(fillsBatch2);

      const tradeMap = new Map<string, OkxAccountClosedTradeRecord>();
      for (const t of existing) tradeMap.set(t.lifecycleId, t);
      for (const t of incrementalLifecycles) tradeMap.set(t.lifecycleId, t);

      const merged = Array.from(tradeMap.values());
      await saveOkxAccountClosedTrades(tmpDir, merged);

      const finalSaved = await readOkxAccountClosedTrades(tmpDir);
      assert.equal(finalSaved.length, 3); // exactly 3 lifecycles, no duplicates
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
