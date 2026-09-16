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
  normalizePositionsHistoryArray,
  normalizeClosedHistoryRow
} from "../lib/paperClosedHistoryNormalize";
import {
  saveOkxAccountClosedTrades,
  readOkxAccountClosedTrades,
  saveOkxAccountTruthCursor,
  readOkxAccountTruthCursor,
  readOkxRawFills,
  type OkxAccountClosedTradeRecord
} from "../storage/account-truth-store";
import {
  syncOkxAccountTruthTrades,
  backfillOkxAccountTruthTrades
} from "../lib/okxAccountTruthIngest";
import type { OkxDemoClient } from "../exchange/okx-demo";
import { isStrategyStatsRow, isAccountStatsRow } from "../engine-v2/lifecycle/completed-trade";
import { buildPaperWindowSummaryFromHistory } from "../storage/paper-summary";

function createMockClient(fillsBatches: OkxFillsHistoryItem[][]): OkxDemoClient {
  let callIndex = 0;
  return {
    getFillsHistory: async () => {
      const fills = fillsBatches[callIndex] ?? [];
      callIndex++;
      return {
        ok: true,
        value: fills,
        diagnostics: { httpStatus: 200, requestUrl: "/api/v5/trade/fills-history" }
      };
    }
  } as unknown as OkxDemoClient;
}

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

  // 19. Account Truth row pnlNet/fee dashboard normalization value preservation
  await t.test("19. Account Truth row pnlNet/fee dashboard normalization value preservation", () => {
    const truthRow: OkxAccountClosedTradeRecord = {
      symbol: "ETHUSDT",
      side: "short",
      openedAt: 1788500000000,
      closedAt: 1788501000000,
      entryPrice: 2500,
      closePrice: 2480,
      entryQty: 5.0,
      closedQty: 5.0,
      sizeUsd: 1250,
      realizedPnl: 10.0,
      realizedPnlPct: 0.008,
      fee: 1.5,
      pnlNet: 8.5,
      holdingMs: 1000000,
      source: "BOT_V2",
      entrySource: "BOT",
      exitSource: "BOT",
      sourceLabel: "자동",
      exitReason: "보호 주문 체결 (TP/SL)",
      exitType: "EXIT_EXCHANGE_ALGO",
      exchangeEntryOrdIds: ["ord_in_1"],
      exchangeExitOrdIds: ["ord_out_1"],
      exchangeFillIds: ["f1", "f2"],
      lifecycleId: "okx_life:ETHUSDT:short:1788500000000:1788501000000",
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

    const normalized = normalizeClosedHistoryRow(truthRow);
    assert.equal(normalized.pnlUsdNet, 8.5);
    assert.equal(normalized.pnlUsd, 8.5);
    assert.equal(normalized.realizedPnlUsd, 8.5);
    assert.equal(normalized.feeUsd, 1.5);
    assert.equal(normalized.pnlUsdGross, 10.0);
    assert.equal(normalized.sourceLabel, "자동");
  });

  // 20. 10분 이상 보유 거래가 서로 다른 sync batch에 분할 인입되어도 1건으로 정상 복원
  await t.test("20. 10분 이상 보유 거래가 서로 다른 sync batch에 분할 인입되어도 1건으로 정상 복원", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-batch-test-20-"));
    try {
      // Batch 1 (T=100,000): Entry fill only (Position is open)
      const batch1: OkxFillsHistoryItem[] = [
        {
          instId: "BTC-USDT-SWAP",
          side: "buy",
          fillPx: "80000",
          fillSz: "1.0",
          fillTime: 100_000,
          ordId: "ord_batch_in",
          tradeId: "t_batch_1",
          clOrdId: "pBTCUSDTbmt101"
        }
      ];

      // Batch 2 (T=800,000, >11분 후): Exit fill only
      const batch2: OkxFillsHistoryItem[] = [
        {
          instId: "BTC-USDT-SWAP",
          side: "sell",
          fillPx: "81000",
          fillSz: "1.0",
          fillPnl: "10.0",
          fee: "0.5",
          fillTime: 800_000,
          ordId: "ord_batch_out",
          tradeId: "t_batch_2",
          clOrdId: "pBTCUSDTsmt101"
        }
      ];

      const client = createMockClient([batch1, batch2]);

      // Sync 1
      const res1 = await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      assert.equal(res1.ok, true);
      assert.equal(res1.rawFillsFetched, 1);
      assert.equal(res1.totalRawFillsCount, 1);
      assert.equal(res1.totalSavedTrades, 0); // Position still open

      // Sync 2 (11 min later)
      const res2 = await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      assert.equal(res2.ok, true);
      assert.equal(res2.rawFillsFetched, 1);
      assert.equal(res2.totalRawFillsCount, 2); // 2 fills deduplicated and accumulated
      assert.equal(res2.totalSavedTrades, 1); // Exactly 1 closed trade reconstructed!

      const saved = await readOkxAccountClosedTrades(tmpDir);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].symbol, "BTCUSDT");
      assert.equal(saved[0].entryPrice, 80000);
      assert.equal(saved[0].closePrice, 81000);
      assert.equal(saved[0].holdingMs, 700_000);
      assert.equal(saved[0].sourceLabel, "자동");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 21. 수동 거래가 서로 다른 sync batch에 걸쳐도 수동 라벨로 정상 복원
  await t.test("21. 수동 거래가 서로 다른 sync batch에 걸쳐도 수동 라벨로 정상 복원", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-batch-test-21-"));
    try {
      const batch1: OkxFillsHistoryItem[] = [
        {
          instId: "ETH-USDT-SWAP",
          side: "sell",
          fillPx: "2500",
          fillSz: "5.0",
          fillTime: 100_000,
          ordId: "m_ord_in",
          tradeId: "m_t_1",
          clOrdId: ""
        }
      ];

      const batch2: OkxFillsHistoryItem[] = [
        {
          instId: "ETH-USDT-SWAP",
          side: "buy",
          fillPx: "2450",
          fillSz: "5.0",
          fillPnl: "25.0",
          fee: "1.0",
          fillTime: 900_000,
          ordId: "m_ord_out",
          tradeId: "m_t_2",
          clOrdId: ""
        }
      ];

      const client = createMockClient([batch1, batch2]);

      await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      const res2 = await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      assert.equal(res2.totalSavedTrades, 1);

      const saved = await readOkxAccountClosedTrades(tmpDir);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].symbol, "ETHUSDT");
      assert.equal(saved[0].side, "short");
      assert.equal(saved[0].sourceLabel, "수동");
      assert.equal(saved[0].isManualEntry, true);
      assert.equal(saved[0].isManualExit, true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 22. 하이브리드 거래 (BOT->MANUAL, MANUAL->BOT) 배치 분할 인입 검증
  await t.test("22. 하이브리드 거래 (BOT->MANUAL, MANUAL->BOT) 배치 분할 인입 검증", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-batch-test-22-"));
    try {
      // Trade A: Bot entry -> Manual exit
      // Trade B: Manual entry -> Bot TP exit
      const batch1: OkxFillsHistoryItem[] = [
        { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "80000", fillSz: "1.0", fillTime: 100_000, ordId: "b_in_1", tradeId: "t_a1", clOrdId: "pBTCUSDTbmt201" },
        { instId: "ETH-USDT-SWAP", side: "buy", fillPx: "2500", fillSz: "4.0", fillTime: 150_000, ordId: "m_in_1", tradeId: "t_b1", clOrdId: "" }
      ];

      const batch2: OkxFillsHistoryItem[] = [
        { instId: "BTC-USDT-SWAP", side: "sell", fillPx: "80500", fillSz: "1.0", fillTime: 700_000, ordId: "m_out_1", tradeId: "t_a2", clOrdId: "" },
        { instId: "ETH-USDT-SWAP", side: "sell", fillPx: "2550", fillSz: "4.0", fillTime: 750_000, ordId: "b_out_1", tradeId: "t_b2", clOrdId: "pETHUSDTsmt201" }
      ];

      const client = createMockClient([batch1, batch2]);

      await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      const res2 = await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      assert.equal(res2.totalSavedTrades, 2);

      const saved = await readOkxAccountClosedTrades(tmpDir);
      const btc = saved.find((s) => s.symbol === "BTCUSDT");
      const eth = saved.find((s) => s.symbol === "ETHUSDT");

      assert.ok(btc);
      assert.ok(eth);
      assert.equal(btc.sourceLabel, "자동→수동");
      assert.equal(btc.tradeSource, "ADOPTED_EXTERNAL");
      assert.equal(eth.sourceLabel, "수동→자동");
      assert.equal(eth.tradeSource, "BOT_V2");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 23. Partial reduce 분할 인입 시 동일 lifecycle에 누적되어 1건으로 최종 확정
  await t.test("23. Partial reduce 분할 인입 시 동일 lifecycle에 누적되어 1건으로 최종 확정", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-batch-test-23-"));
    try {
      // Batch 1: Open 10
      const batch1: OkxFillsHistoryItem[] = [
        { instId: "ETH-USDT-SWAP", side: "buy", fillPx: "2500", fillSz: "10.0", fillTime: 100_000, ordId: "o_in", tradeId: "t_p1", clOrdId: "pETHUSDTbmt301" }
      ];
      // Batch 2: Partial Reduce 4
      const batch2: OkxFillsHistoryItem[] = [
        { instId: "ETH-USDT-SWAP", side: "sell", fillPx: "2520", fillSz: "4.0", fillPnl: "8.0", fee: "0.4", fillTime: 400_000, ordId: "o_red", tradeId: "t_p2", clOrdId: "pETHUSDTsmt301_p1" }
      ];
      // Batch 3: Final Close 6
      const batch3: OkxFillsHistoryItem[] = [
        { instId: "ETH-USDT-SWAP", side: "sell", fillPx: "2550", fillSz: "6.0", fillPnl: "30.0", fee: "0.6", fillTime: 800_000, ordId: "o_fin", tradeId: "t_p3", clOrdId: "pETHUSDTsmt301_p2" }
      ];

      const client = createMockClient([batch1, batch2, batch3]);

      const res1 = await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      assert.equal(res1.totalSavedTrades, 0);

      const res2 = await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      assert.equal(res2.totalSavedTrades, 0); // Position still partially open (remaining 6)

      const res3 = await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      assert.equal(res3.totalSavedTrades, 1); // Exactly 1 closed trade on full close!

      const saved = await readOkxAccountClosedTrades(tmpDir);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].entryQty, 10.0);
      assert.equal(saved[0].closedQty, 10.0);
      assert.equal(saved[0].closePrice, 2538); // (2520*4 + 2550*6)/10 = 2538
      assert.equal(saved[0].realizedPnl, 38.0);
      assert.equal(saved[0].fee, 1.0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 24. 동일 심볼 full close 후 재진입이 배치 경계를 넘어도 2건으로 분리 보존
  await t.test("24. 동일 심볼 full close 후 재진입이 배치 경계를 넘어도 2건으로 분리 보존", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-batch-test-24-"));
    try {
      // Batch 1: Trade 1 complete
      const batch1: OkxFillsHistoryItem[] = [
        { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "80000", fillSz: "1.0", fillTime: 100_000, ordId: "b1_in", tradeId: "t1_1", clOrdId: "pBTCUSDTbmt401" },
        { instId: "BTC-USDT-SWAP", side: "sell", fillPx: "80500", fillSz: "1.0", fillTime: 200_000, ordId: "b1_out", tradeId: "t1_2", clOrdId: "pBTCUSDTsmt401" }
      ];
      // Batch 2: Trade 2 Entry (Open)
      const batch2: OkxFillsHistoryItem[] = [
        { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "81000", fillSz: "1.0", fillTime: 500_000, ordId: "b2_in", tradeId: "t2_1", clOrdId: "pBTCUSDTbmt402" }
      ];
      // Batch 3: Trade 2 Exit (Close)
      const batch3: OkxFillsHistoryItem[] = [
        { instId: "BTC-USDT-SWAP", side: "sell", fillPx: "81500", fillSz: "1.0", fillTime: 800_000, ordId: "b2_out", tradeId: "t2_2", clOrdId: "pBTCUSDTsmt402" }
      ];

      const client = createMockClient([batch1, batch2, batch3]);

      await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      const res3 = await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });

      assert.equal(res3.totalSavedTrades, 2);
      const saved = await readOkxAccountClosedTrades(tmpDir);
      assert.equal(saved.length, 2);
      assert.notEqual(saved[0].openedAt, saved[1].openedAt);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 25. BTC/ETH interleaved 체결이 여러 배치에 걸쳐도 상호 오염 없이 독립 복원
  await t.test("25. BTC/ETH interleaved 체결이 여러 배치에 걸쳐도 상호 오염 없이 독립 복원", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-batch-test-25-"));
    try {
      const batch1: OkxFillsHistoryItem[] = [
        { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "80000", fillSz: "1.0", fillTime: 100_000, ordId: "btc_in", tradeId: "t_btc1", clOrdId: "" },
        { instId: "ETH-USDT-SWAP", side: "sell", fillPx: "2500", fillSz: "5.0", fillTime: 120_000, ordId: "eth_in", tradeId: "t_eth1", clOrdId: "" }
      ];
      const batch2: OkxFillsHistoryItem[] = [
        { instId: "BTC-USDT-SWAP", side: "sell", fillPx: "81000", fillSz: "1.0", fillTime: 600_000, ordId: "btc_out", tradeId: "t_btc2", clOrdId: "" },
        { instId: "ETH-USDT-SWAP", side: "buy", fillPx: "2450", fillSz: "5.0", fillTime: 620_000, ordId: "eth_out", tradeId: "t_eth2", clOrdId: "" }
      ];

      const client = createMockClient([batch1, batch2]);

      await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      const res2 = await syncOkxAccountTruthTrades({ dataDir: tmpDir, client });
      assert.equal(res2.totalSavedTrades, 2);

      const saved = await readOkxAccountClosedTrades(tmpDir);
      const btc = saved.find((s) => s.symbol === "BTCUSDT");
      const eth = saved.find((s) => s.symbol === "ETHUSDT");
      assert.ok(btc && eth);
      assert.equal(btc.entryQty, 1.0);
      assert.equal(eth.entryQty, 5.0);
      assert.equal(btc.side, "long");
      assert.equal(eth.side, "short");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 26. One-time Historical Backfill 경로로 과거 누락 거래 100% 복구 및 proof 대조
  await t.test("26. One-time Historical Backfill 경로로 과거 누락 거래 100% 복구 및 proof 대조", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-batch-test-26-"));
    try {
      const historicalFills: OkxFillsHistoryItem[] = [
        { instId: "BTC-USDT-SWAP", side: "buy", fillPx: "79000", fillSz: "2.0", fillTime: 10_000, ordId: "h_b1", tradeId: "h_t1", clOrdId: "" },
        { instId: "BTC-USDT-SWAP", side: "sell", fillPx: "80000", fillSz: "2.0", fillTime: 20_000, ordId: "h_s1", tradeId: "h_t2", clOrdId: "" },
        { instId: "ETH-USDT-SWAP", side: "buy", fillPx: "2400", fillSz: "10.0", fillTime: 30_000, ordId: "h_e1", tradeId: "h_t3", clOrdId: "" },
        { instId: "ETH-USDT-SWAP", side: "sell", fillPx: "2450", fillSz: "10.0", fillTime: 40_000, ordId: "h_e2", tradeId: "h_t4", clOrdId: "" }
      ];

      const client = createMockClient([historicalFills]);

      const backfillRes = await backfillOkxAccountTruthTrades({
        dataDir: tmpDir,
        client,
        bootstrapDays: 30,
        maxPages: 50
      });

      assert.equal(backfillRes.ok, true);
      assert.equal(backfillRes.totalRawFillsCount, 4);
      assert.equal(backfillRes.totalLifecyclesCount, 2);
      assert.equal(backfillRes.totalSavedTrades, 2);
      assert.equal(backfillRes.dashboardPositionsCount, 2);

      const rawFillsOnDisk = await readOkxRawFills(tmpDir);
      assert.equal(rawFillsOnDisk.length, 4);

      const tradesOnDisk = await readOkxAccountClosedTrades(tmpDir);
      assert.equal(tradesOnDisk.length, 2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 27. [A] BOT entry + MANUAL exit normalize 결과 sourceLabel === "자동→수동"
  await t.test("27. [A] BOT entry + MANUAL exit normalize 결과 sourceLabel === '자동→수동'", () => {
    const rawBotManual = {
      symbol: "BTCUSDT",
      side: "long",
      openedAt: 1788500000000,
      closedAt: 1788501000000,
      entryPrice: 80000,
      closePrice: 80500,
      entrySource: "BOT",
      exitSource: "MANUAL",
      exitType: "EXIT_MANUAL",
      exitReason: "수동 청산 (봇 진입)",
      isBotEntry: true,
      isManualExit: true
    };

    const normalized = normalizeClosedHistoryRow(rawBotManual);
    assert.equal(normalized.sourceLabel, "자동→수동");
  });

  // 28. [B] MANUAL entry + BOT exit normalize 결과 sourceLabel === "수동→자동"
  await t.test("28. [B] MANUAL entry + BOT exit normalize 결과 sourceLabel === '수동→자동'", () => {
    const rawManualBot = {
      symbol: "ETHUSDT",
      side: "short",
      openedAt: 1788500000000,
      closedAt: 1788501000000,
      entryPrice: 2500,
      closePrice: 2450,
      entrySource: "MANUAL",
      exitSource: "BOT",
      exitType: "EXIT_EXCHANGE_ALGO",
      exitReason: "보호 주문 체결 (TP/SL)",
      isManualEntry: true,
      isBotExit: true
    };

    const normalized = normalizeClosedHistoryRow(rawManualBot);
    assert.equal(normalized.sourceLabel, "수동→자동");
  });

  // 29. [C] pnl 필드 없이 entry/close price만 있는 BTC long의 computed PnL%가 0으로 사라지지 않음
  await t.test("29. [C] pnl 필드 없이 entry/close price만 있는 BTC long의 computed PnL%가 0으로 사라지지 않음", () => {
    const rawNoPnlFields = {
      symbol: "BTCUSDT",
      side: "long",
      entryPrice: 80000,
      closePrice: 80800, // +1.0%
      sizeUsd: 800,
      leverage: 1
    };

    const normalized = normalizeClosedHistoryRow(rawNoPnlFields);
    assert.equal(normalized.realizedPnlPct, 0.01);
  });

  // 30. [D] explicit pnlNet=0인 실제 본전 거래는 0 유지
  await t.test("30. [D] explicit pnlNet=0인 실제 본전 거래는 0 유지", () => {
    const rawBreakEven = {
      symbol: "BTCUSDT",
      side: "long",
      entryPrice: 80000,
      closePrice: 80000,
      pnlNet: 0,
      fee: 0.5,
      sizeUsd: 800
    };

    const normalized = normalizeClosedHistoryRow(rawBreakEven);
    assert.equal(normalized.pnlUsdNet, 0);
    assert.equal(normalized.pnlUsd, 0);
    assert.equal(normalized.realizedPnlUsd, 0);
    assert.equal(normalized.realizedPnlPct, 0);
    assert.equal(normalized.feeUsd, 0.5);
  });

  // 31. 유효한 기존 sourceLabel은 내부 entry/exit 증거가 모순되어도 그대로 보존
  await t.test("31. 유효한 기존 sourceLabel은 내부 entry/exit 증거가 모순되어도 그대로 보존", () => {
    const rawWithAuthoritativeLabel = {
      symbol: "BTCUSDT",
      side: "long",
      sourceLabel: "외부포지션 인계",
      entrySource: "BOT",
      exitSource: "BOT",
      isBotEntry: true,
      isBotExit: true
    };

    const normalized = normalizeClosedHistoryRow(rawWithAuthoritativeLabel);
    assert.equal(normalized.sourceLabel, "외부포지션 인계");
  });

  // 32. 순수 BOT normalize → 자동
  await t.test("32. 순수 BOT normalize → 자동", () => {
    const rawPureBot = {
      symbol: "BTCUSDT",
      side: "long",
      entrySource: "BOT",
      exitSource: "BOT",
      isBotEntry: true,
      isBotExit: true,
      flowId: "pBTCUSDTbmt001",
      exitType: "EXIT_V2_AUTHORITY"
    };

    const normalized = normalizeClosedHistoryRow(rawPureBot);
    assert.equal(normalized.sourceLabel, "자동");
  });

  // 33. 순수 MANUAL normalize → 수동
  await t.test("33. 순수 MANUAL normalize → 수동", () => {
    const rawPureManual = {
      symbol: "ETHUSDT",
      side: "short",
      entrySource: "MANUAL",
      exitSource: "MANUAL",
      isManualEntry: true,
      isManualExit: true,
      exitType: "EXIT_MANUAL"
    };

    const normalized = normalizeClosedHistoryRow(rawPureManual);
    assert.equal(normalized.sourceLabel, "수동");
  });

  // 34. entrySource=MANUAL, exitSource 없음, exitType=EXIT_EXCHANGE_ALGO → 수동→자동
  await t.test("34. entrySource=MANUAL, exitSource 없음, exitType=EXIT_EXCHANGE_ALGO → 수동→자동", () => {
    const rawManualAlgo = {
      symbol: "ETHUSDT",
      side: "long",
      entrySource: "MANUAL",
      isManualEntry: true,
      exitType: "EXIT_EXCHANGE_ALGO"
    };

    const normalized = normalizeClosedHistoryRow(rawManualAlgo);
    assert.equal(normalized.sourceLabel, "수동→자동");
  });

  // 35. Pagination 100건 초과: billId를 cursor로 2페이지 연계 조회 및 100건 초과 수집 검증
  await t.test("35. Pagination 100건 초과: billId를 cursor로 2페이지 연계 조회 및 100건 초과 수집 검증", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-pag-test-"));
    try {
      const page1: OkxFillsHistoryItem[] = [];
      for (let i = 0; i < 100; i++) {
        page1.push({
          instId: "BTC-USDT-SWAP",
          side: "buy",
          fillPx: "80000",
          fillSz: "0.1",
          fillTime: 1788500000000 + i * 1000,
          tradeId: `t_p1_${i}`,
          ordId: `o_p1_${i}`,
          billId: `bill_p1_${i}`
        });
      }
      const page2: OkxFillsHistoryItem[] = [];
      for (let i = 0; i < 50; i++) {
        page2.push({
          instId: "BTC-USDT-SWAP",
          side: "sell",
          fillPx: "81000",
          fillSz: "0.1",
          fillTime: 1788500000000 + 100000 + i * 1000,
          tradeId: `t_p2_${i}`,
          ordId: `o_p2_${i}`,
          billId: `bill_p2_${i}`
        });
      }

      let capturedAfter: string | undefined = undefined;
      let requestCount = 0;
      const mockClient: OkxDemoClient = {
        getFillsHistory: async (params?: Record<string, string>) => {
          requestCount++;
          if (requestCount === 1) {
            return { ok: true, value: page1, diagnostics: { httpStatus: 200, requestUrl: "" } };
          }
          if (requestCount === 2) {
            capturedAfter = params?.after;
            return { ok: true, value: page2, diagnostics: { httpStatus: 200, requestUrl: "" } };
          }
          return { ok: true, value: [], diagnostics: { httpStatus: 200, requestUrl: "" } };
        }
      } as unknown as OkxDemoClient;

      const res = await syncOkxAccountTruthTrades({
        dataDir: tempDir,
        client: mockClient,
        bootstrapDays: 7,
        maxPages: 5
      });

      assert.equal(res.ok, true);
      assert.equal(res.rawFillsFetched, 150);
      assert.equal(res.totalRawFillsCount, 150);
      assert.equal(capturedAfter, "bill_p1_99");
      assert.equal(res.isTruncated, false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // 36. billId 없는 페이지: tradeId fallback 금지 및 안전 중단 / truncated 확인
  await t.test("36. billId 없는 페이지: tradeId fallback 금지 및 안전 중단 / truncated 확인", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-nobill-test-"));
    try {
      const page1: OkxFillsHistoryItem[] = [];
      for (let i = 0; i < 100; i++) {
        page1.push({
          instId: "BTC-USDT-SWAP",
          side: "buy",
          fillPx: "80000",
          fillSz: "0.1",
          fillTime: 1788500000000 + i * 1000,
          tradeId: `t_nobill_${i}`,
          ordId: `o_nobill_${i}`
          // billId intentionally omitted
        });
      }

      let requestCount = 0;
      const mockClient: OkxDemoClient = {
        getFillsHistory: async () => {
          requestCount++;
          return { ok: true, value: page1, diagnostics: { httpStatus: 200, requestUrl: "" } };
        }
      } as unknown as OkxDemoClient;

      const res = await syncOkxAccountTruthTrades({
        dataDir: tempDir,
        client: mockClient,
        bootstrapDays: 7,
        maxPages: 5
      });

      assert.equal(res.ok, true);
      assert.equal(requestCount, 1); // halted after page 1
      assert.equal(res.rawFillsFetched, 100);
      assert.equal(res.isTruncated, true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // 37. 동일 billId 반복: 무한 루프 방지 및 안전 중단 / truncated 확인
  await t.test("37. 동일 billId 반복: 무한 루프 방지 및 안전 중단 / truncated 확인", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-dupbill-test-"));
    try {
      const page1: OkxFillsHistoryItem[] = [];
      for (let i = 0; i < 100; i++) {
        page1.push({
          instId: "BTC-USDT-SWAP",
          side: "buy",
          fillPx: "80000",
          fillSz: "0.1",
          fillTime: 1788500000000 + i * 1000,
          tradeId: `t_dup1_${i}`,
          billId: `same_bill_cursor`
        });
      }
      const page2: OkxFillsHistoryItem[] = [];
      for (let i = 0; i < 100; i++) {
        page2.push({
          instId: "BTC-USDT-SWAP",
          side: "buy",
          fillPx: "80000",
          fillSz: "0.1",
          fillTime: 1788500000000 + 100000 + i * 1000,
          tradeId: `t_dup2_${i}`,
          billId: `same_bill_cursor`
        });
      }

      let requestCount = 0;
      const mockClient: OkxDemoClient = {
        getFillsHistory: async () => {
          requestCount++;
          if (requestCount === 1) {
            return { ok: true, value: page1, diagnostics: { httpStatus: 200, requestUrl: "" } };
          }
          return { ok: true, value: page2, diagnostics: { httpStatus: 200, requestUrl: "" } };
        }
      } as unknown as OkxDemoClient;

      const res = await syncOkxAccountTruthTrades({
        dataDir: tempDir,
        client: mockClient,
        bootstrapDays: 7,
        maxPages: 5
      });

      assert.equal(res.ok, true);
      assert.equal(requestCount, 2); // halted on duplicate cursor detection
      assert.equal(res.isTruncated, true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // 38. Decimal partial/full close 수량 비교 & 2개 독립 lifecycle 분리 및 fillPnl 정확 귀속 검증
  await t.test("38. Decimal partial/full close 수량 비교 & 2개 독립 lifecycle 분리 및 fillPnl 정확 귀속 검증", () => {
    const fills: OkxFillsHistoryItem[] = [
      // Lifecycle 1: Short 11.37 -> Buy 4.54 -> Buy 6.83 -> Flat (0)
      {
        instId: "SOL-USDT-SWAP",
        side: "sell",
        fillPx: "150.0",
        fillSz: "11.37",
        fillTime: 1788500010000,
        tradeId: "s1",
        ordId: "ord_s1",
        fee: "0.05"
      },
      {
        instId: "SOL-USDT-SWAP",
        side: "buy",
        fillPx: "145.0",
        fillSz: "4.54",
        fillPnl: "1.46642",
        fillTime: 1788500020000,
        tradeId: "b1",
        ordId: "ord_b1",
        fee: "0.02"
      },
      {
        instId: "SOL-USDT-SWAP",
        side: "buy",
        fillPx: "140.0",
        fillSz: "6.83",
        fillPnl: "9.56883",
        fillTime: 1788500030000,
        tradeId: "b2",
        ordId: "ord_b2",
        fee: "0.03"
      },
      // Lifecycle 2: Short 11.47 -> Buy 11.47 -> Flat
      {
        instId: "SOL-USDT-SWAP",
        side: "sell",
        fillPx: "152.0",
        fillSz: "11.47",
        fillTime: 1788500040000,
        tradeId: "s2",
        ordId: "ord_s2",
        fee: "0.05"
      },
      {
        instId: "SOL-USDT-SWAP",
        side: "buy",
        fillPx: "151.0",
        fillSz: "11.47",
        fillPnl: "0.16058",
        fillTime: 1788500050000,
        tradeId: "b3",
        ordId: "ord_b3",
        fee: "0.05"
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    // sorted descending by closedAt: lifecycle 2 first, then lifecycle 1
    assert.equal(lifecycles.length, 2);

    const life2 = lifecycles.find((l) => l.openedAt === 1788500040000)!;
    const life1 = lifecycles.find((l) => l.openedAt === 1788500010000)!;

    assert.ok(life1, "Lifecycle 1 must exist");
    assert.ok(life2, "Lifecycle 2 must exist");

    // Lifecycle 1 checks
    assert.equal(life1.symbol, "SOLUSDT");
    assert.equal(life1.side, "short");
    assert.equal(life1.entryQty, 11.37);
    assert.equal(life1.closedQty, 11.37);
    assert.equal(Math.abs(life1.realizedPnl - (1.46642 + 9.56883)) < 1e-9, true);
    assert.equal(life1.closedAt, 1788500030000);

    // Lifecycle 2 checks
    assert.equal(life2.symbol, "SOLUSDT");
    assert.equal(life2.side, "short");
    assert.equal(life2.entryQty, 11.47);
    assert.equal(life2.closedQty, 11.47);
    assert.equal(Math.abs(life2.realizedPnl - 0.16058) < 1e-9, true);
    assert.equal(life2.closedAt, 1788500050000);
  });

  // 39. Explicit fillPnl=0 본전 청산 유지 및 가격 공식 임의 덮어쓰기 방지
  await t.test("39. Explicit fillPnl=0 본전 청산 유지 및 가격 공식 임의 덮어쓰기 방지", () => {
    const fills: OkxFillsHistoryItem[] = [
      {
        instId: "BTC-USDT-SWAP",
        side: "buy",
        fillPx: "80000",
        fillSz: "1.0",
        fillTime: 1788500000000,
        tradeId: "t_be_1",
        ordId: "o_be_1"
      },
      {
        instId: "BTC-USDT-SWAP",
        side: "sell",
        fillPx: "80500", // price is higher, but fillPnl is explicitly 0 (break-even / contract fee settlement)
        fillSz: "1.0",
        fillPnl: "0",
        fee: "0.2",
        fillTime: 1788500060000,
        tradeId: "t_be_2",
        ordId: "o_be_2"
      }
    ];

    const lifecycles = reconstructLifecyclesFromFills(fills);
    assert.equal(lifecycles.length, 1);
    assert.equal(lifecycles[0].realizedPnl, 0);
    assert.equal(lifecycles[0].fee, 0.2);
    assert.equal(lifecycles[0].pnlNet, -0.2);
  });
});



